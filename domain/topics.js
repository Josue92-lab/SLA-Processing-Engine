/**
 * Topics — keyword counting for the "Top 10 Topics" sheet.
 *
 * Three concerns, all tied to the same keyword taxonomy (KEYWORDS in
 * domain/slaPolicy.js, ordered deliberately — changing the order changes
 * the Top 10 Topics layout):
 *
 *   normalizeKeywords(keywords)                       -> lowercased list
 *   initCountryTopicCounts(store, country, keywords)  -> ensure zero buckets
 *   countTopics(ticket, country, store, keywords)     -> increment per row
 *
 * Behaviour preserved byte-for-byte from the inline blocks in
 * routes/excelProcessor.js. The non-obvious bits:
 *
 *   1. Short-desc-wins rule. For each keyword:
 *        - If the keyword appears in Short description (lowercased), that
 *          country's bucket is incremented.
 *        - Otherwise, if NO keyword appeared in Short description AND the
 *          keyword appears in Description, that country's bucket is
 *          incremented.
 *      This is a deliberate gate: `hasAnyWordInShort` is evaluated ONCE
 *      per row. If ANY keyword was found in the short description, the
 *      full Description is ignored entirely for that row, even for other
 *      keywords that were not in the short description. This prevents
 *      tickets with rich descriptions from swamping the topic distribution
 *      with signal that the short description already captured.
 *
 *   2. A single ticket can contribute to multiple keyword buckets IF all
 *      those keywords appear in the Short description (first branch). The
 *      short-description branch does not short-circuit across keywords,
 *      only the fallback-to-Description branch does.
 *
 *   3. Lowercase normalization. Keywords, shortDesc, and desc are all
 *      lowercased for matching. Substring match via String#includes. The
 *      bucket keys in the store are the LOWERCASED keywords — downstream
 *      code (the Top 10 Topics sheet generator) reads them as-is, so the
 *      lowercase contract is visible and must be preserved.
 *
 *   4. initCountryTopicCounts is idempotent per country key presence: the
 *      caller is expected to guard with `if (!store[country])` before
 *      invoking, mirroring the original single-initialization pattern.
 *      Passing a country that already has buckets will overwrite them
 *      back to zero, so don't.
 *
 * Risk profile: zero behaviour change. Pure string counting, no dates,
 * no thresholds, no verdicts. Golden output catches any drift on the
 * very first regression run.
 */

/**
 * Lowercase a list of keywords once, for reuse across every row. The
 * lowercased list doubles as the set of bucket keys in the per-country
 * topic store (see module header, point 3).
 *
 * @param {string[]} keywords
 * @returns {string[]}
 */
export function normalizeKeywords(keywords) {
    return keywords.map(w => w.toLowerCase());
}

/**
 * Initialize the topic buckets for a country to zero, using the provided
 * lowercased keyword list as the key set.
 *
 * Caller must guard with `if (!store[country])` — see module header
 * point 4.
 *
 * @param {{ [country: string]: { [keyword: string]: number } }} store
 * @param {string} country
 * @param {string[]} lowercasedKeywords
 */
export function initCountryTopicCounts(store, country, lowercasedKeywords) {
    store[country] = {};
    lowercasedKeywords.forEach(w => { store[country][w] = 0; });
}

/**
 * Increment the country's topic buckets for every keyword that matches
 * the ticket under the short-desc-wins rule.
 *
 * See module header point 1 for the precise rule. This function MUTATES
 * `store[country]` — the same in-place increment the original inline
 * code performed.
 *
 * @param {Object} ticket                 Must provide "Short description" and "Description".
 * @param {string} country                Key into `store`. Assumed already initialized.
 * @param {{ [country: string]: { [keyword: string]: number } }} store
 * @param {string[]} lowercasedKeywords
 */
export function countTopics(ticket, country, store, lowercasedKeywords) {
    const shortDesc = (ticket["Short description"] || "").toLowerCase();
    const desc = (ticket.Description || "").toLowerCase();

    // Solo evalúa los "includes" una vez para ver si hay que revisar la descripción general
    const hasAnyWordInShort = lowercasedKeywords.some(w => shortDesc.includes(w));

    lowercasedKeywords.forEach(wordLower => {
        if (shortDesc.includes(wordLower)) {
            store[country][wordLower]++;
        } else if (!hasAnyWordInShort && desc.includes(wordLower)) {
            store[country][wordLower]++;
        }
    });
}
