/**
 * SLA Policy — business constants.
 *
 * This module collects every hard-coded business rule from the 2021-era
 * single-pass pipeline into one place. The contents are intentionally
 * preserved byte-for-byte from excelProcessor.js:
 *   - Same threshold values (minutes).
 *   - Same priority label strings ("3 - Moderate", "4 - Low").
 *   - Same keyword taxonomy, in the same order (affects Top 10 Topics layout).
 *   - Same dashboard timezone.
 *   - Same regex literals (including the load-bearing punctuation class).
 *
 * Why centralize but not change anything yet:
 *   - The immediate goal is to make business rules *findable* so later phases
 *     can evolve them safely (externalize to JSON, policy versioning, audit
 *     trails). Changing values here would break the regression contract.
 *   - Keeping the priority LABELS alongside the THRESHOLDS makes the policy
 *     self-documenting without forcing a lookup into rules.js.
 *
 * Consumers (downstream modules may import any of these):
 *   - lifecycle.js  -> REGEX.*, TIMEZONE.dashboard, KEYWORDS
 *   - slaRules.js   -> THRESHOLDS, PRIORITY, VERDICT
 *   - aggregates.js -> KEYWORDS (for per-country frequency map)
 *
 * Risk profile: zero. No value has been altered.
 */

/**
 * Priority string literals as they appear in ServiceNow/SHARP exports.
 * String equality is the only check performed; anything else short-circuits
 * past P3/P4 counters. Do NOT normalize casing or spacing here.
 */
export const PRIORITY = Object.freeze({
    P3: '3 - Moderate',
    P4: '4 - Low'
});

/**
 * Verdict labels emitted into the output workbook and counted in aggregates.
 * These strings are part of the operational report surface — analysts and
 * downstream dashboards parse them literally, including the Spanish phrase
 * "Revisar manualmente".
 */
export const VERDICT = Object.freeze({
    FULFILLED: 'fulfilled',
    UNFULFILLED: 'unfulfilled',
    MANUAL_REVIEW: 'Revisar manualmente'
});

/**
 * SLA time windows in minutes, measured from `ticketMovedDate`
 * (team-assignment if present, otherwise ticket creation).
 *
 * Keep the VIP windows priority-independent — that matches the 2021 behaviour.
 * When/if product confirms VIP should honour priority, change the callsite,
 * not this file, and update the golden.
 */
export const THRESHOLDS = Object.freeze({
    response: { p3: 120, p4: 180, vip: 30 },
    resolution: { p3: 480, p4: 960, vip: 480 },
    warranty: 120
});

/**
 * Single dashboard timezone: every inferred timestamp is normalized here
 * before SLA deltas are computed. Analyst timestamps are first parsed in the
 * analyst's local TZ (from emailTimeZoneMappings), then converted to this TZ.
 */
export const TIMEZONE = Object.freeze({
    dashboard: 'US/Central'
});

/**
 * Keyword taxonomy for the "Top 10 Topics" sheet. Order matters — the report
 * iterates `.slice(0, 10)` against this list to fill dashboard rows. Adding
 * or removing words changes the sheet layout and the per-country frequency
 * ranking. Do not reorder without also updating the golden.
 */
export const KEYWORDS = Object.freeze([
    'windows', 'zscaler', 'vpn', 'internet', 'impresora',
    'outlook', 'sharepoint', 'teams', 'office', 'sap',
    'pki', 'excel', 'word', 'certificados', 'onedrive',
    'equipo', 'red', 'celular', 'móvil'
]);

/**
 * Regex patterns — the load-bearing part of the inference engine.
 *
 * The separator character class `[-?\\¡¿*+;:_{}[\]]` encodes accumulated
 * analyst-typo tolerance from years of operational use. It MUST match the
 * original engine exactly until we have evidence (and product approval) to
 * change it. Any edit here will shift SLA numbers.
 *
 * dateHtmlPattern     -> first <p>DD-MM-YYYY HH:mm:ss</p> in ticket history
 *                        (interpreted as the team-assignment moment).
 * dateProcessPattern  -> analyst "... - En proceso" marker (first response).
 * dateWarrantyPattern -> analyst "... - A garantia/Garantia" marker.
 */
export const REGEX = Object.freeze({
    dateHtml:     /<p>(\d{2}-\d{2}-\d{4} \d{2}:\d{2}:\d{2})<\/p>/,
    dateProcess:  /(\d{2}-\d{2}-\d{4} \d{2}:\d{2}:\d{2})\s*[-?\\¡¿*+;:_{}[\]]\s*En proceso/i,
    dateWarranty: /(\d{2}-\d{2}-\d{4} \d{2}:\d{2}:\d{2})\s*[-?\\¡¿*+;:_{}[\]]\s*(A garantia|Garantia)/i
});

/**
 * Canonical datetime formats used by moment / moment-timezone.
 * `source` is what appears inside the raw Excel cells for Created/Resolved.
 * `inferred` is what our regexes capture from free-text history/comments.
 * `output` is what we write back to the RawSLAData sheet.
 */
export const DATE_FORMAT = Object.freeze({
    source:   'YYYY-MM-DD HH:mm:ss',
    inferred: 'DD-MM-YYYY HH:mm:ss',
    output:   'DD-MM-YYYY HH:mm:ss'
});
