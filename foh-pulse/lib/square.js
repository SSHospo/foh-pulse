// square.js — minimal Square adapter for FOH Pulse. Shares the SAME Square
// production personal access token as the main Dashboard (same Square app,
// not a new one; see worker.js's header comment).
//
// Deliberately NOT a copy of the Dashboard's lib/square.js: this app needs
// one thing — today's sales per catalog category, as NET sales EXCLUDING
// GST — so it's a smaller, independent file rather than importing across
// repos. The catalog-category lookup below is the same logic the Dashboard
// uses for its own FOH/BOH panel, so both apps put an item in the same
// category.

const PRODUCTION_HOST = "https://connect.squareup.com";
const SQUARE_VERSION = "2026-06-18";

export async function listLocations(accessToken) {
  const res = await fetch(`${PRODUCTION_HOST}/v2/locations`, {
    headers: { Authorization: `Bearer ${accessToken}`, "Square-Version": SQUARE_VERSION },
  });
  if (!res.ok) throw new Error(`square locations failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  return body.locations || [];
}

/**
 * Lookup from ITEM_VARIATION id (what an order line item's catalog_object_id
 * references) to the owning item's first category name. Same approach as the
 * Dashboard's fetchCatalogCategoryMap: an item with several categories lands
 * wholly under its first one.
 */
export async function fetchCatalogCategoryMap(accessToken) {
  const categoryNameById = new Map();
  const rawItems = [];
  let cursor;
  do {
    const url = new URL(`${PRODUCTION_HOST}/v2/catalog/list`);
    url.searchParams.set("types", "ITEM,CATEGORY");
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}`, "Square-Version": SQUARE_VERSION },
    });
    if (!res.ok) throw new Error(`square catalog list failed: ${res.status} ${await res.text()}`);
    const body = await res.json();
    for (const obj of body.objects || []) {
      if (obj.type === "CATEGORY") categoryNameById.set(obj.id, obj.category_data?.name || "Uncategorised");
      else if (obj.type === "ITEM") rawItems.push(obj);
    }
    cursor = body.cursor;
  } while (cursor);

  const categoryNameByVariationId = new Map();
  for (const item of rawItems) {
    const categoryId = item.item_data?.categories?.[0]?.id;
    const categoryName = categoryId ? categoryNameById.get(categoryId) || "Uncategorised" : "Uncategorised";
    for (const variation of item.item_data?.variations || []) {
      categoryNameByVariationId.set(variation.id, categoryName);
    }
  }
  return { categoryNameByVariationId };
}

function cents(money) {
  return Number(money?.amount || 0);
}

/**
 * Net sales EXCLUDING GST, in cents, per catalog category, for
 * [startISO, endISO) across the given locations.
 *
 * Per line item:  net ex-GST = gross_sales_money
 *                              - total_discount_money
 *                              - the INCLUSIVE tax sitting inside that amount
 *
 * Why subtract tax at all: Square's own docs say that in Australia inclusive
 * tax REMAINS part of gross_sales_money (it is only stripped out in the US,
 * Canada and Japan). So gross_sales_money includes GST here, and GST has to
 * be taken back out to get an ex-GST figure. Only taxes whose type is
 * INCLUSIVE (looked up on the order's taxes[] via the line's
 * applied_taxes[].tax_uid) are subtracted — an ADDITIVE tax isn't inside
 * gross_sales_money to begin with.
 *
 * NOT deducted: refunds/returns (counted and reported instead, see
 * ordersWithReturns), tips and service charges (never part of gross sales).
 *
 * Same Orders Search filter (created_at, COMPLETED) as the Dashboard's
 * reconciled Square functions — created_at rather than closed_at because a
 * delivery-platform order can sit un-COMPLETED for a while after the sale.
 *
 * Returns:
 *   centsByCategory  Map<categoryName, netExGstCents>
 *   gstRemovedCents  total inclusive GST taken back out (sanity-check figure)
 *   grossCents       gross sales before discounts/GST (sanity-check figure)
 *   ordersWithReturns        orders that carried refunds (not deducted)
 *   taxUnknownLineItems      lines that showed tax but whose type couldn't
 *                            be determined (left un-adjusted, so a nonzero
 *                            count means ex-GST may be slightly overstated)
 */
export async function fetchNetSalesExGstByCategory(accessToken, locationIds, startISO, endISO, categoryNameByVariationId) {
  const centsByCategory = new Map();
  let gstRemovedCents = 0;
  let grossCents = 0;
  let ordersWithReturns = 0;
  let taxUnknownLineItems = 0;
  let cursor;
  do {
    const res = await fetch(`${PRODUCTION_HOST}/v2/orders/search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "Square-Version": SQUARE_VERSION,
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
      if ((order.returns || []).length) ordersWithReturns++;
      const taxTypeByUid = new Map((order.taxes || []).map((t) => [t.uid, t.type]));
      const allOrderTaxesInclusive =
        (order.taxes || []).length > 0 && (order.taxes || []).every((t) => t.type === "INCLUSIVE");

      for (const li of order.line_items || []) {
        const gross = cents(li.gross_sales_money);
        const discount = cents(li.total_discount_money);

        let inclusiveTax = 0;
        const applied = li.applied_taxes || [];
        if (applied.length) {
          for (const at of applied) {
            if (taxTypeByUid.get(at.tax_uid) === "INCLUSIVE") inclusiveTax += cents(at.applied_money);
          }
        } else if (cents(li.total_tax_money) > 0) {
          // Tax shown on the line but no per-tax breakdown. Only trust it as
          // inclusive if every tax on the order is inclusive; otherwise
          // leave it alone and count it so the owner can see.
          if (allOrderTaxesInclusive) inclusiveTax = cents(li.total_tax_money);
          else taxUnknownLineItems++;
        }

        const net = gross - discount - inclusiveTax;
        const categoryName = categoryNameByVariationId.get(li.catalog_object_id) || "Uncategorised";
        centsByCategory.set(categoryName, (centsByCategory.get(categoryName) || 0) + net);
        gstRemovedCents += inclusiveTax;
        grossCents += gross;
      }
    }
    cursor = body.cursor;
  } while (cursor);
  return { centsByCategory, gstRemovedCents, grossCents, ordersWithReturns, taxUnknownLineItems };
}
