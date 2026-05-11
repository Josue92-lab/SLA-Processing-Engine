/**
 * Country resolution — normalize a ticket's reported country against the
 * configured allow-list, falling back to the caller's email-derived country.
 *
 * Extracted verbatim from the "Normalización de País" step of the
 * single-pass pipeline in routes/excelProcessor.js. Two concerns:
 *
 *   buildEmailToCountryMap(emailCountries) -> { [email]: Country }
 *   resolveCountry(ticket, email, emailToCountryMap, allowedCountries) -> string
 *
 * Behaviour preserved byte-for-byte:
 *
 *   1. resolveCountry MUTATES ticket.Country as a side effect when the
 *      ticket's reported country is not in the allow-list. This mutation is
 *      intentional and is the contract the downstream code in step 5 of the
 *      pipeline relies on (the RawSLAData row uses `currentCountry`, but the
 *      ticket object flows through later pipelines too). Do NOT switch to a
 *      non-mutating return-only contract during Phase 1b — immutability is
 *      deferred until aggregates and orchestration are isolated.
 *
 *   2. The fallback literal `'#'` is preserved exactly. This sentinel flows
 *      into the Top 10 Topics and DashboardSLAData sheets as a real country
 *      key, and has operational meaning ("country unknown") that downstream
 *      analysts rely on. Do not switch to `null`, `undefined`, or
 *      `'Unknown'` without product sign-off and a golden update.
 *
 *   3. The fallback chain is strictly: emailToCountryMap[email] ?? '#'.
 *      `callerCountry` falsy (undefined, "", null) -> '#'. Same as the
 *      original `callerCountry || '#'` shortcircuit.
 *
 *   4. The dictionary is built once up-front via forEach over the
 *      emailCountries array. Order of insertion is preserved; later entries
 *      for the same Email silently win (last-write-wins). Same as original.
 *
 * Downstream note for future phases: country resolution indirectly affects
 * timezone interpretation (via domain/lifecycle.js's email-keyed timezone
 * map) and SLA reporting segmentation (per-country aggregates). Exact
 * current semantics must be preserved through any future refactor.
 *
 * Risk profile: zero behaviour change. No thresholds, no verdicts, no
 * dates. The mutation contract is explicit and load-bearing; everything
 * else is string lookup.
 */

/**
 * @typedef {{ Email: string, Country: string }} EmailCountryEntry
 * Shape of each row in the emailCountries settings list. Other fields are
 * ignored here.
 */

/**
 * Build an O(1) lookup from caller email to country, preserving the
 * original insertion-order / last-write-wins semantics.
 *
 * @param {EmailCountryEntry[]} emailCountries
 * @returns {{ [email: string]: string }}
 */
export function buildEmailToCountryMap(emailCountries) {
    const emailToCountryMap = {};
    emailCountries.forEach(({ Email, Country }) => {
        emailToCountryMap[Email] = Country;
    });
    return emailToCountryMap;
}

/**
 * Resolve the operational country for a ticket and (if needed) normalize
 * the ticket object in place.
 *
 * Rule (byte-for-byte from the original pipeline):
 *   - If the ticket's reported country is in allowedCountries, keep it.
 *   - Otherwise override with the caller's email-derived country, or '#'
 *     if the email is not mapped. Also writes the override back onto
 *     ticket.Country (see module header, point 1).
 *
 * @param {Object} ticket                  Mutated in place when override fires.
 * @param {string} email                   Caller email, already trimmed by caller.
 * @param {{ [email: string]: string }} emailToCountryMap
 * @param {string[]} allowedCountries
 * @returns {string} The resolved country — what the pipeline should use going forward.
 */
export function resolveCountry(ticket, email, emailToCountryMap, allowedCountries) {
    const callerCountry = emailToCountryMap[email];
    let currentCountry = ticket.Country;
    if (!allowedCountries.includes(currentCountry)) {
        currentCountry = callerCountry || '#';
        ticket.Country = currentCountry;
    }
    return currentCountry;
}
