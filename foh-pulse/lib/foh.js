// foh.js — the "FOH only" filters for FOH Pulse. Pure functions, no network,
// so they can be tested on their own.
//
// FOH/BOH is NOT decided here. It comes from the owner's own mapping in the
// main Dashboard's Settings ("Front of house / Back of house mapping"),
// stored in the shared KV under settings.departmentMapping:
//   squareCategories: { "Coffee": "foh", "Kitchen Food": "boh", ... }
//   rosterLocations:  { "Front House": "foh", "Kitchen": "boh", ... }
// Values are "foh" | "boh" | "neither". This app only ever READS that
// mapping; it never edits it.
//
// Rule for anything the owner hasn't mapped yet: it is NOT counted as FOH,
// and it is reported back so the owner can see exactly what was left out
// (never silently dropped, never silently counted).

export function hasFohMapped(mappingGroup) {
  return Object.values(mappingGroup || {}).includes("foh");
}

/**
 * centsByCategory: Map<categoryName, cents> (already net of discounts and
 * ex-GST). Returns the FOH total plus what was left out because the
 * category isn't mapped at all.
 */
export function fohSalesFromCategories(centsByCategory, categoryMapping) {
  const mapping = categoryMapping || {};
  let fohCents = 0;
  let unmappedCents = 0;
  const unmappedCategories = [];
  for (const [name, cents] of centsByCategory) {
    const bucket = mapping[name];
    if (bucket === "foh") fohCents += cents;
    else if (bucket === "boh" || bucket === "neither") continue;
    else {
      unmappedCents += cents;
      if (cents !== 0) unmappedCategories.push({ name, cents });
    }
  }
  unmappedCategories.sort((a, b) => b.cents - a.cents);
  return { fohCents, unmappedCents, unmappedCategories, hasFohCategory: hasFohMapped(mapping) };
}

/**
 * Keeps only shifts whose roster location the owner mapped to FOH.
 * Reports locations that aren't mapped at all, and shifts with no location
 * (can't be placed anywhere, so they're not counted as FOH).
 */
export function filterFohShifts(shifts, rosterLocationMapping) {
  const mapping = rosterLocationMapping || {};
  const foh = [];
  const unmapped = new Set();
  let shiftsWithoutLocation = 0;
  for (const shift of shifts || []) {
    const loc = (shift.location_name || "").trim();
    if (!loc) {
      shiftsWithoutLocation++;
      continue;
    }
    const bucket = mapping[loc] ?? mapping[shift.location_name];
    if (bucket === "foh") foh.push(shift);
    else if (bucket === "boh" || bucket === "neither") continue;
    else unmapped.add(loc);
  }
  return {
    shifts: foh,
    unmappedLocations: [...unmapped].sort(),
    shiftsWithoutLocation,
    hasFohLocation: hasFohMapped(mapping),
  };
}
