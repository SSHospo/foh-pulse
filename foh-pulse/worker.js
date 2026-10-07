// worker.js — FOH Pulse: a lightweight, phone-friendly companion to the
// main Cranky Cafe Dashboard. Shows ONE thing: how today's wage % is
// tracking RIGHT NOW, so whoever's running the floor can act on it
// mid-shift instead of finding out at close. Built 3 Oct 2026, deliberately
// kept as its own repo and its own Cloudflare Worker, separate from the
// main Dashboard — see build-notes.md in the Dashboard project for the full
// decision trail.
//
// SHARES THE MAIN DASHBOARD'S DATA, NOT ITS OWN CONNECTIONS. This Worker
// binds the SAME Cloudflare KV namespace as the Dashboard (see
// wrangler.toml — same namespace id) and reads the Employment Hero tokens,
// the dashboard password hash, and Settings (Staff pay setup, public
// holidays, timezone) the owner already configured there. It never starts
// its own OAuth flow and never writes Settings — purely a second,
// read-mostly window onto data the Dashboard already owns. (The one write
// this app DOES make is refreshing the Employment Hero access token in
// place when it's expired — see getValidEmploymentHeroAccessToken below —
// the same thing the Dashboard itself does; whichever app happens to make
// the next request after expiry refreshes it, and the other just reads
// whatever's current.)
//
// Secrets this Worker needs in Cloudflare's Settings -> Variables and
// Secrets — COPY THE SAME VALUES already set on the Dashboard Worker; this
// is the same Square account and the same Employment Hero app, not new
// ones:
//   SQUARE_ACCESS_TOKEN, SQUARE_LOCATION_IDS (optional, comma-separated)
//   EMPLOYMENT_HERO_CLIENT_ID, EMPLOYMENT_HERO_CLIENT_SECRET
//
// No Xero secrets are needed here, and that's deliberate, not an oversight:
// kpi-spec.md's rule 1 locks every dollar figure on the real Dashboard to
// Xero, because POS totals include GST and aren't accounting truth. But
// Xero's P&L isn't live — it lags, sometimes by days — so it has nothing to
// say about "sales so far today". This app uses Square's live order data
// instead, and is equally careful to label it "FOH net sales (ex-GST, from
// Square)", never "Revenue" — a different, faster, less precise number by
// design, used for an in-the-moment floor decision, never for the books.
//
// FOH ONLY (owner's call, 4 Oct 2026): both sides of the wage % are
// restricted to front of house, using the owner's own mapping in the main
// Dashboard's Settings (settings.departmentMapping, read-only here):
//   - SALES  = Square line items in categories mapped to "foh", net of
//              discounts, with the GST taken back out.
//   - WAGES  = rostered shifts at Employment Hero locations mapped to "foh".
// Anything unmapped is left out AND reported, never silently counted.
//
// Hours-worked caveat, told to the owner before this was built and worth
// repeating here: Employment Hero only gives this app the ROSTERED
// (planned) shift times, not actual clock-in/out. "Hours worked so far"
// below is really "hours rostered so far" — it assumes everyone is working
// their published shift exactly as planned, and won't catch a no-show or an
// early finish until the roster itself is updated in Employment Hero.

import { hashPassword, verifyPassword, createSessionCookie, verifySessionCookie, CLEAR_SESSION_COOKIE } from "./lib/auth.js";
import { resolvePeriod, toDateInputValue, employmentHeroShiftTimeToUtcMs, localDateAndWeekday } from "./lib/periods.js";
import * as squareAdapter from "./lib/square.js";
import * as ehAdapter from "./lib/employmenthero.js";
import { classifyDayType, hourlyRateFor } from "./lib/awardRates.js";
import { fohSalesFromCategories, filterFohShifts } from "./lib/foh.js";

const DEFAULT_SETTINGS = {
  timezone: "Australia/Sydney",
  weekStartDay: 1,
  tradingDayRolloverHour: 4,
  staffPay: [],
  publicHolidays: [],
  departmentMapping: { squareCategories: {}, rosterLocations: {} },
};

// Fixed traffic-light bands, points above the owner's own spec (3 Oct
// 2026): "≤35% green / 35-40% yellow / 40-45% orange / >45% red".
// Deliberately NOT tied to the Settings Target Wage % the main Dashboard
// uses — the owner chose fixed numbers specifically so they don't silently
// move if that target is ever changed without this app being revisited too.
const BANDS = [
  { max: 0.35, status: "green", label: "On track" },
  { max: 0.40, status: "yellow", label: "Watch" },
  { max: 0.45, status: "orange", label: "High" },
  { max: Infinity, status: "red", label: "Critical" },
];

function bandFor(wagePct) {
  if (wagePct === null || wagePct === undefined) return null;
  return BANDS.find((b) => wagePct <= b.max) || BANDS[BANDS.length - 1];
}

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

async function getSettings(kv) {
  const raw = await kv.get("settings");
  return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS;
}

async function requireSession(request, kv) {
  return verifySessionCookie(kv, request.headers.get("Cookie"));
}

// Identical pattern to the main Dashboard's getValidEmploymentHeroAccessToken
// — reads the SAME eh:tokens KV entry the Dashboard writes, refreshing (and
// persisting the rotated refresh token back to that same entry) if the
// access token's 15-minute life has lapsed. Needs this Worker's OWN copy of
// the EMPLOYMENT_HERO_CLIENT_ID/SECRET secrets (same app, same values) to
// sign the refresh request — Cloudflare Workers don't share secrets across
// Workers even when two Workers share a KV namespace.
async function getValidEmploymentHeroAccessToken(env, kv) {
  const stored = await kv.get("eh:tokens", "json");
  if (!stored) return null;
  if (stored.accessTokenExpiry > Date.now() + 60_000) {
    return { accessToken: stored.accessToken, organisationId: stored.organisationId };
  }
  const refreshed = await ehAdapter.refreshTokens(env, stored.refreshToken);
  const updated = {
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token,
    accessTokenExpiry: Date.now() + refreshed.expires_in * 1000,
    organisationId: stored.organisationId,
    organisationName: stored.organisationName,
  };
  await kv.put("eh:tokens", JSON.stringify(updated));
  return { accessToken: updated.accessToken, organisationId: updated.organisationId };
}

async function resolveSquareLocationIds(env) {
  if (!env.SQUARE_ACCESS_TOKEN) return null;
  if (env.SQUARE_LOCATION_IDS) return env.SQUARE_LOCATION_IDS.split(",").map((s) => s.trim());
  const locs = await squareAdapter.listLocations(env.SQUARE_ACCESS_TOKEN);
  return locs.map((l) => l.id);
}

/**
 * Splits today's rostered shifts into "so far" (shift start to now) and
 * "remaining" (now to shift end), costing each portion at the award rate
 * for today's day-type. Also tracks the earliest shift start and latest
 * shift end seen — used as "today's trading window" for the end-of-day
 * projection below, since this app has no separate "opening hours" setting
 * of its own and deliberately doesn't invent one.
 *
 * Same name-matching + award-rate approach as the Dashboard's own
 * computeProjectedRosterCost (worker.js there) — not imported directly
 * (that function lives in a separate repo/deploy), but built from the same
 * shared library pieces (employmentHeroShiftTimeToUtcMs, classifyDayType,
 * hourlyRateFor), so the cost math agrees with the Dashboard's for any
 * portion of the day both would compute.
 */
function splitShiftsNowCost(shifts, staffPay, publicHolidays, timezone, nowMs) {
  const byName = new Map();
  for (const p of staffPay || []) {
    if (p && p.name) byName.set(p.name.trim().toLowerCase(), p);
  }

  let hoursSoFar = 0, costSoFar = 0;
  let hoursRemaining = 0, costRemaining = 0;
  const unmatchedNames = new Set();
  let windowStart = null, windowEnd = null;

  for (const shift of shifts) {
    const name = (shift.member_full_name || "").trim();
    const startMs = shift.start_time ? employmentHeroShiftTimeToUtcMs(shift.start_time, timezone) : NaN;
    const endMs = shift.end_time ? employmentHeroShiftTimeToUtcMs(shift.end_time, timezone) : NaN;
    if (!name || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;

    windowStart = windowStart === null ? startMs : Math.min(windowStart, startMs);
    windowEnd = windowEnd === null ? endMs : Math.max(windowEnd, endMs);

    const profile = byName.get(name.toLowerCase());
    if (!profile) {
      unmatchedNames.add(name);
      continue;
    }

    const { dateStr, weekday } = localDateAndWeekday(startMs, timezone);
    const dayType = classifyDayType(dateStr, weekday, publicHolidays);
    const rate = hourlyRateFor({
      level: profile.level,
      employmentType: profile.employmentType,
      age: profile.age ?? null,
      dayType,
    });

    const elapsedEnd = Math.min(endMs, nowMs);
    if (elapsedEnd > startMs) {
      const h = (elapsedEnd - startMs) / (60 * 60 * 1000);
      hoursSoFar += h;
      costSoFar += h * rate;
    }

    const remainingStart = Math.max(startMs, nowMs);
    if (endMs > remainingStart) {
      const h = (endMs - remainingStart) / (60 * 60 * 1000);
      hoursRemaining += h;
      costRemaining += h * rate;
    }
  }

  return {
    hoursSoFar, costSoFar, hoursRemaining, costRemaining,
    totalDayCost: costSoFar + costRemaining,
    unmatchedNames: [...unmatchedNames],
    windowStart, windowEnd,
  };
}

async function handleApi(request, env, ctx, url) {
  const kv = env.TOKENS;
  const path = url.pathname;

  // Same password as the main Dashboard — this app never sets a password
  // of its own, it only ever verifies against the auth:password KV entry
  // the Dashboard already wrote (shared KV namespace).
  if (path === "/api/session" && request.method === "GET") {
    const hasPassword = !!(await kv.get("auth:password"));
    const loggedIn = await requireSession(request, kv);
    return json({ hasPassword, loggedIn });
  }

  if (path === "/api/login" && request.method === "POST") {
    const stored = await kv.get("auth:password");
    if (!stored) {
      return json({ error: "no password set yet — set one up in the main Dashboard first" }, { status: 409 });
    }
    const { password } = await request.json();
    const ok = await verifyPassword(password || "", stored);
    if (!ok) return json({ error: "wrong password" }, { status: 401 });
    const cookie = await createSessionCookie(kv);
    return json({ ok: true }, { headers: { "Set-Cookie": cookie } });
  }

  if (path === "/api/logout" && request.method === "POST") {
    return json({ ok: true }, { headers: { "Set-Cookie": CLEAR_SESSION_COOKIE } });
  }

  // Everything below requires a session.
  if (!(await requireSession(request, kv))) {
    return json({ error: "not logged in" }, { status: 401 });
  }

  if (path === "/api/today" && request.method === "GET") {
    const settings = await getSettings(kv);
    const nowMs = Date.now();
    const todayStr = toDateInputValue(nowMs, settings.timezone);
    // Reuses the Dashboard's own period-boundary logic (same trading-day
    // rollover, same timezone) via resolvePeriod's "custom" path with
    // start=end=today, rather than re-deriving day boundaries a second way.
    const today = resolvePeriod("custom", settings, nowMs, { start: todayStr, end: todayStr });

    const mapping = settings.departmentMapping || { squareCategories: {}, rosterLocations: {} };

    // Each outside-world call below is caught on its own, so ONE bad
    // connection (e.g. a wrong or expired key) shows up as a plain-language
    // error on the phone instead of taking down the whole page.
    let locationIds = null, squareError = null;
    try {
      locationIds = await resolveSquareLocationIds(env);
    } catch (e) {
      squareError = String((e && e.message) || e);
    }
    const squareConnected = !!env.SQUARE_ACCESS_TOKEN && !!locationIds;
    let fohSales = null;
    let salesDetail = null;
    if (squareConnected) {
      try {
        const salesEndISO = new Date(Math.min(nowMs, today.endUTC)).toISOString();
        const catalog = await squareAdapter.fetchCatalogCategoryMap(env.SQUARE_ACCESS_TOKEN);
        const raw = await squareAdapter.fetchNetSalesExGstByCategory(
          env.SQUARE_ACCESS_TOKEN,
          locationIds,
          new Date(today.startUTC).toISOString(),
          salesEndISO,
          catalog.categoryNameByVariationId
        );
        fohSales = fohSalesFromCategories(raw.centsByCategory, mapping.squareCategories);
        salesDetail = raw;
      } catch (e) {
        squareError = String((e && e.message) || e);
      }
    }
    // Only a real number when at least one Square category is mapped to FOH;
    // otherwise "not set up" (never a misleading $0 FOH sales).
    const fohSalesSetUp = !!(fohSales && fohSales.hasFohCategory);
    const salesSoFar = fohSalesSetUp ? round2(fohSales.fohCents / 100) : null;

    let ehAuth = null, ehError = null;
    try {
      ehAuth = await getValidEmploymentHeroAccessToken(env, kv);
    } catch (e) {
      // Most likely cause: this Worker's own copy of the Employment Hero
      // client id/secret doesn't match the real app, so the token refresh
      // is refused.
      ehError = String((e && e.message) || e);
    }
    let shiftsResult = null;
    let fohRoster = null;
    if (ehAuth) {
      try {
        const shifts = await ehAdapter.fetchRosteredShifts(
          ehAuth.accessToken,
          ehAuth.organisationId,
          new Date(today.startUTC).toISOString(),
          new Date(today.endUTC).toISOString()
        );
        // FOH roster only: shifts at locations the owner mapped to FOH.
        fohRoster = filterFohShifts(shifts, mapping.rosterLocations);
        if (fohRoster.hasFohLocation) {
          shiftsResult = splitShiftsNowCost(fohRoster.shifts, settings.staffPay, settings.publicHolidays, settings.timezone, nowMs);
        }
      } catch (e) {
        ehError = String((e && e.message) || e);
      }
    }

    const staffPayConfigured = (settings.staffPay || []).length > 0;
    const wageCostSoFar = shiftsResult ? round2(shiftsResult.costSoFar) : null;
    const hoursWorkedSoFar = shiftsResult ? round2(shiftsResult.hoursSoFar) : null;
    const hoursRemaining = shiftsResult ? round2(shiftsResult.hoursRemaining) : null;
    const totalDayWageCost = shiftsResult ? round2(shiftsResult.totalDayCost) : null;

    const wagePctSoFar =
      wageCostSoFar !== null && salesSoFar !== null && salesSoFar > 0 ? wageCostSoFar / salesSoFar : null;

    // Projection: scale sales-so-far up by how much of today's rostered
    // trading window has elapsed (earliest shift start to latest shift end
    // — derived from today's own roster, since this app has no separate
    // "opening hours" setting and deliberately doesn't invent one).
    // Deliberately a straight-line scale-up, not a historical hourly sales
    // curve — simple enough to explain at a glance on a phone, and clearly
    // a rough estimate rather than a second source of truth. Only shown
    // once at least 15 minutes of the window have elapsed, so the first
    // few minutes of trade don't produce a wildly noisy number.
    let projectedSalesEndOfDay = null;
    let projectedWagePctEndOfDay = null;
    const windowStart = shiftsResult ? shiftsResult.windowStart : null;
    const windowEnd = shiftsResult ? shiftsResult.windowEnd : null;
    if (windowStart !== null && windowEnd !== null && salesSoFar !== null) {
      const elapsedMs = Math.min(nowMs, windowEnd) - windowStart;
      const totalMs = windowEnd - windowStart;
      if (elapsedMs > 15 * 60 * 1000 && totalMs > 0) {
        const fraction = Math.min(elapsedMs / totalMs, 1);
        projectedSalesEndOfDay = round2(salesSoFar / fraction);
        if (totalDayWageCost !== null && projectedSalesEndOfDay > 0) {
          projectedWagePctEndOfDay = totalDayWageCost / projectedSalesEndOfDay;
        }
      }
    }

    const band = bandFor(wagePctSoFar);

    return json({
      asOf: new Date(nowMs).toISOString(),
      configured: {
        square: squareConnected,
        employmentHero: !!ehAuth,
        staffPay: staffPayConfigured,
      },
      errors: { square: squareError, employmentHero: ehError },
      // "Is the FOH split set up?" — drives the plain-language setup message
      // on the phone instead of showing $0 or a made-up wage %.
      fohSetup: {
        salesCategories: fohSales ? fohSales.hasFohCategory : null,
        rosterLocations: fohRoster ? fohRoster.hasFohLocation : null,
      },
      // What was left OUT of the FOH figures because it isn't mapped yet.
      excluded: {
        unmappedCategories: fohSales
          ? fohSales.unmappedCategories.map((c) => ({ name: c.name, netSalesExGst: round2(c.cents / 100) }))
          : [],
        unmappedLocations: fohRoster ? fohRoster.unmappedLocations : [],
        shiftsWithoutLocation: fohRoster ? fohRoster.shiftsWithoutLocation : 0,
      },
      // Numbers for the owner to sanity-check against Square's own reports.
      salesChecks: salesDetail
        ? {
            gstRemoved: round2(salesDetail.gstRemovedCents / 100),
            grossIncGstAllCategories: round2(salesDetail.grossCents / 100),
            ordersWithRefundsNotDeducted: salesDetail.ordersWithReturns,
            lineItemsTaxUnknown: salesDetail.taxUnknownLineItems,
          }
        : null,
      noOneRosteredToday: shiftsResult ? shiftsResult.windowStart === null : null,
      salesSoFar,
      hoursWorkedSoFar,
      hoursRemaining,
      wageCostSoFar,
      wagePctSoFar,
      targetBandsPct: { green: 0.35, yellow: 0.4, orange: 0.45 },
      status: band ? band.status : null,
      statusLabel: band ? band.label : null,
      projectedSalesEndOfDay,
      projectedWagePctEndOfDay,
      unmatchedStaffNames: shiftsResult ? shiftsResult.unmatchedNames : [],
    });
  }

  return json({ error: "not found" }, { status: 404 });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, ctx, url);
      } catch (err) {
        console.error(err);
        return json({ error: "server error", detail: String((err && err.message) || err) }, { status: 500 });
      }
    }
    return env.ASSETS.fetch(request);
  },
};
