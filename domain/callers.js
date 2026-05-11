/**
 * Callers — per-caller ticket count accumulator for the Top 10 Callers sheet.
 *
 * Two concerns:
 *
 *   createCallerCount()                            -> initial empty store
 *   recordCaller(store, callerName, country)       -> void, mutates in place
 *
 * Behaviour preserved byte-for-byte from step 8 of the single-pass
 * pipeline in routes/excelProcessor.js. Small surface area, but three
 * non-obvious semantics that are load-bearing and must be preserved:
 *
 * 1. Falsy-caller fallback to "Unknown".
 *    `callerName || "Unknown"` — a missing, null, undefined, or empty
 *    caller field is aggregated under the literal key "Unknown". This
 *    shows up as its own row in the Top 10 Callers sheet when the volume
 *    is high enough. Do not switch to null-skipping without product
 *    sign-off.
 *
 * 2. First-country pinning.
 *    The country field on the caller record is set on FIRST sighting of
 *    that caller and never updated. If the same caller later appears with
 *    a different resolved country (e.g. because countryResolver's fallback
 *    landed on '#' the first time and on a real country the second time),
 *    the stored country stays the first one. This is the historical
 *    behaviour; the Top 10 Callers report is therefore a "first-seen"
 *    country attribution, not a "most-recent" one. Preserve exactly.
 *
 * 3. Raw key — no normalization.
 *    The key is the caller name as-is from the ticket. No trim, no
 *    casefold, no unicode normalization. Two callers that differ only in
 *    trailing whitespace, casing, or invisible characters will be counted
 *    as separate rows. This is consistent with the original engine and
 *    with VIP detection's substring-match semantics (which also does not
 *    normalize). Preserve exactly.
 *
 * Risk profile: zero behaviour change.
 */

/**
 * @typedef {{ [callerName: string]: { count: number, country: string } }} CallerCount
 */

/**
 * Fresh empty caller store.
 *
 * @returns {CallerCount}
 */
export function createCallerCount() {
    return {};
}

/**
 * Increment the caller's ticket count; initialise its record (with
 * first-seen country) if this is the first sighting.
 *
 * Mutates `store` in place — matches the original inline pattern.
 *
 * @param {CallerCount} store
 * @param {string} callerName  Raw caller from the ticket; falsy => "Unknown".
 * @param {string} country     Resolved country for THIS row; only stored on first sighting.
 */
export function recordCaller(store, callerName, country) {
    const key = callerName || "Unknown";
    if (!store[key]) {
        store[key] = { count: 0, country };
    }
    store[key].count++;
}
