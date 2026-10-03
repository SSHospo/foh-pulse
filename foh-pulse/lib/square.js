// square.js — minimal Square adapter for FOH Pulse. Shares the SAME Square
// production personal access token as the main Dashboard (the owner copies
// that secret's value across — this is the same Square app, not a new one;
// see worker.js's header comment for the full credential-sharing picture).
//
// Deliberately NOT a copy of the Dashboard's lib/square.js: this app only
// ever needs one number — today's total gross sales so far — not the
// category/hourly breakdowns the Dashboard's FOH/BOH panel needs, so this
// is a smaller, independent file rather than importing across repos.

const PRODUCTION_HOST = "https://connect.squareup.com";

export async function listLocations(accessToken) {
  const res = await fetch(`${PRODUCTION_HOST}/v2/locations`, {
    headers: { Authorization: `Bearer ${accessToken}`, "Square-Version": "2026-06-18" },
  });
  if (!res.ok) throw new Error(`square locations failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  return body.locations || [];
}

/**
 * Total gross line-item sales, in cents, for [startISO, endISO) across the
 * given locations.
 *
 * IMPORTANT — this is NOT the Dashboard's locked, ex-GST, Xero-sourced
 * Revenue (kpi-spec.md rule 1). gross_sales_money INCLUDES GST (Australian
 * inclusive pricing) and comes straight from the POS, not the books. It's
 * the fastest real number available for "how much have we sold so far
 * today" — exactly the same tradeoff the Dashboard's existing FOH/BOH panel
 * already makes, and the same labelling discipline applies: always "Square
 * sales", never "Revenue".
 *
 * Same Orders Search filter (created_at, COMPLETED) as the Dashboard's
 * countTransactions/fetchLineItemSalesByCategory, for the same reason —
 * created_at rather than closed_at, because a delivery-platform order (this
 * venue takes Uber Eats through Square) can sit un-COMPLETED for a while
 * after the sale actually happened, so closed_at drifts late.
 */
export async function fetchTotalGrossSalesCents(accessToken, locationIds, startISO, endISO) {
  let cents = 0;
  let cursor;
  do {
    const res = await fetch(`${PRODUCTION_HOST}/v2/orders/search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "Square-Version": "2026-06-18",
      },
      body: JSON.stringify({
        location_ids: locationIds,
        cursor,
        query: {
          filter: {
            date_time_filter: { created_at: { start_at: startISO, end_at: endISO } },
            state_filter: { states: ["COMPLETED"] },
          },
          sort: { sort_field: "CREATED_AT", sort_order: "ASC" },
        },
        limit: 500,
      }),
    });
    if (!res.ok) throw new Error(`square orders search failed: ${res.status} ${await res.text()}`);
    const body = await res.json();
    for (const order of body.orders || []) {
      for (const li of order.line_items || []) {
        cents += Number(li.gross_sales_money?.amount || 0);
      }
    }
    cursor = body.cursor;
  } while (cursor);
  return cents;
}
