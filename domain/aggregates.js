/**
 * Aggregates — global and per-country SLA counters.
 *
 * Owns the shape AND the update rule for the counter stores that feed the
 * DashboardSLAData sheet. Three concerns:
 *
 *   createAggregates()                                    -> initial container
 *   hasCountryBuckets(aggregates, country)                -> boolean
 *   ensureCountryBuckets(aggregates, country)             -> void, idempotent
 *   recordTicketAggregates(aggregates, classification)    -> void, mutates in place
 *
 * The `classification` input is the merge of what classifySla() / classifyVip()
 * already return plus the resolved country — no extra derivation needed.
 *
 *   { priority, responseSLA, resolutionSLA, warrantySLAStatus, isVip, country }
 *
 * Behaviour preserved byte-for-byte from steps 6 and 7 of the single-pass
 * pipeline in routes/excelProcessor.js. Several intentional asymmetries are
 * preserved exactly — they are NOT bugs, they are reporting-semantic
 * decisions calibrated against the golden output and the operational
 * dashboards built on top of it. Do not "normalize" any of these without
 * explicit product sign-off and a golden update.
 *
 * ============================================================
 * PRESERVED ASYMMETRIES — do not collapse during Phase 1b
 * ============================================================
 *
 * 1. Global vs per-country manualReview shape.
 *    - totals.Response.manualReview is a SINGLE scalar, not priority-bucketed.
 *    - byCountry.manualReview[country].Response is priority-bucketed
 *      ({ p3, p4, vip }).
 *    They answer different product questions and are rendered differently
 *    on the dashboard. Do not unify.
 *
 * 2. manualReview exists ONLY for Response.
 *    - byCountry.manualReview[country] has a Response sub-object only.
 *    - There is no byCountry.manualReview[country].Resolution and no
 *      byCountry.manualReview[country].Warranty. That is because Resolution
 *      and Warranty verdicts are always binary (fulfilled / unfulfilled) in
 *      classifySla — Response is the only verdict that carries a third
 *      "Revisar manualmente" state.
 *    Preserve until reporting semantics are intentionally redesigned.
 *
 * 3. Resolution uses `else`, NOT `else if (=== unfulfilled)`.
 *    Anything that is not literally the string "fulfilled" counts as
 *    unfulfilled for Resolution. In practice classifySla only emits
 *    "fulfilled" / "unfulfilled" for Resolution, but the historical engine
 *    uses the broader `else` and we preserve that exact operator.
 *
 * 4. Warranty has no VIP counter.
 *    totals.Warranty and byCountry.*.Warranty do not track VIP separately,
 *    even when isVip is true. Response and Resolution both do. This is
 *    historical and matches the DashboardSLAData column layout.
 *
 * 5. VIP counters are priority-independent.
 *    totals.Response.vipFulfilled (and the per-country equivalents) are
 *    incremented by `if (isVip) ...` as an INDEPENDENT statement, not an
 *    else-branch of the priority check. A P3 VIP ticket that fulfils
 *    Response therefore increments BOTH p3Fulfilled AND vipFulfilled — the
 *    VIP counter is a separate slice of the same data, not a fifth
 *    priority bucket.
 *
 * 6. Non-P3/P4 priority behaviour.
 *    A ticket with priority "1 - Critical" (or similar) increments NO
 *    priority bucket (neither p3 nor p4), but still increments the VIP
 *    bucket if isVip, and still contributes to the warranty counters if
 *    the warranty verdict is set. This is consistent with the classifySla
 *    seeds (non-P3/P4 => responseSLA=MANUAL_REVIEW, resolutionSLA=UNFULFILLED)
 *    and is load-bearing.
 *
 * 7. Priority string literals are intentionally duplicated with slaPolicy.
 *    The original inline code checks `priority === '3 - Moderate'` /
 *    `'4 - Low'` using raw string literals rather than PRIORITY.P3/P4.
 *    We preserve the exact same literals here to avoid any risk of
 *    divergence under a future slaPolicy.js rename; the equality check
 *    is byte-identical to the pre-extraction code. Changing this to
 *    PRIORITY.* imports would be a trivial follow-up PR with no
 *    behavioural change — explicitly deferred.
 *
 * Risk profile: zero behaviour change. Every branch, operator, and side
 * effect from steps 6 and 7 is preserved.
 */

/**
 * @typedef {Object} SlaTotals
 * @property {{ p3Fulfilled: number, p3Unfulfilled: number, p4Fulfilled: number, p4Unfulfilled: number, vipFulfilled: number, vipUnfulfilled: number, manualReview: number }} Response
 * @property {{ p3Fulfilled: number, p3Unfulfilled: number, p4Fulfilled: number, p4Unfulfilled: number, vipFulfilled: number, vipUnfulfilled: number }} Resolution
 * @property {{ fulfilled: number, unfulfilled: number }} Warranty
 */

/**
 * @typedef {Object} Aggregates
 * @property {SlaTotals} totals
 * @property {{
 *   fulfilled:    { [country: string]: { Response: {p3:number,p4:number,vip:number}, Resolution: {p3:number,p4:number,vip:number}, Warranty: {fulfilled:number} } },
 *   unfulfilled:  { [country: string]: { Response: {p3:number,p4:number,vip:number}, Resolution: {p3:number,p4:number,vip:number}, Warranty: {unfulfilled:number} } },
 *   manualReview: { [country: string]: { Response: {p3:number,p4:number,vip:number} } }
 * }} byCountry
 */

/**
 * @typedef {Object} TicketClassification
 * @property {string}  priority           Raw priority label from the ticket.
 * @property {string}  responseSLA        "fulfilled" | "unfulfilled" | "Revisar manualmente"
 * @property {string}  resolutionSLA      "fulfilled" | "unfulfilled"
 * @property {string}  warrantySLAStatus  "fulfilled" | "unfulfilled" | ""
 * @property {boolean} isVip
 * @property {string}  country            Resolved country (post countryResolver).
 */

/**
 * Fresh aggregates container with all counters zeroed.
 *
 * @returns {Aggregates}
 */
export function createAggregates() {
    return {
        totals: {
            Response: { p3Fulfilled: 0, p3Unfulfilled: 0, p4Fulfilled: 0, p4Unfulfilled: 0, vipFulfilled: 0, vipUnfulfilled: 0, manualReview: 0 },
            Resolution: { p3Fulfilled: 0, p3Unfulfilled: 0, p4Fulfilled: 0, p4Unfulfilled: 0, vipFulfilled: 0, vipUnfulfilled: 0 },
            Warranty: { fulfilled: 0, unfulfilled: 0 }
        },
        byCountry: {
            fulfilled: {},
            unfulfilled: {},
            manualReview: {}
        }
    };
}

/**
 * Has this country already been initialised? O(1) presence check against
 * the fulfilled store (all three country stores are gated together).
 *
 * @param {Aggregates} aggregates
 * @param {string} country
 * @returns {boolean}
 */
export function hasCountryBuckets(aggregates, country) {
    return country in aggregates.byCountry.fulfilled;
}

/**
 * Initialise the three per-country stores for a newly-seen country.
 * Idempotent: if the country is already present, this is a no-op.
 *
 * The caller is expected to gate sibling per-country initialisations
 * (e.g. topic buckets) on hasCountryBuckets() — NOT on this function —
 * so that this module does not need to know about topics.
 *
 * @param {Aggregates} aggregates
 * @param {string} country
 */
export function ensureCountryBuckets(aggregates, country) {
    if (hasCountryBuckets(aggregates, country)) return;
    aggregates.byCountry.fulfilled[country]    = { Response: { p3: 0, p4: 0, vip: 0 }, Resolution: { p3: 0, p4: 0, vip: 0 }, Warranty: { fulfilled: 0 } };
    aggregates.byCountry.unfulfilled[country]  = { Response: { p3: 0, p4: 0, vip: 0 }, Resolution: { p3: 0, p4: 0, vip: 0 }, Warranty: { unfulfilled: 0 } };
    aggregates.byCountry.manualReview[country] = { Response: { p3: 0, p4: 0, vip: 0 } };
}

/**
 * Apply a single ticket's classification to the global totals and the
 * per-country counters, preserving every branch and operator from the
 * pre-extraction inline code.
 *
 * Caller contract: must have called ensureCountryBuckets(aggregates,
 * classification.country) for this row before invoking this function.
 * This function does NOT guard the presence check — the caller owns it
 * because it is also responsible for gating the sibling topics
 * initialisation (see module header).
 *
 * @param {Aggregates} aggregates
 * @param {TicketClassification} classification
 */
export function recordTicketAggregates(aggregates, classification) {
    const { priority, responseSLA, resolutionSLA, warrantySLAStatus, isVip, country } = classification;
    const { totals } = aggregates;
    const fulfilled    = aggregates.byCountry.fulfilled[country];
    const unfulfilled  = aggregates.byCountry.unfulfilled[country];
    const manualReview = aggregates.byCountry.manualReview[country];

    // -------- Global totals (step 6 in the original pipeline) --------

    if (responseSLA === "fulfilled") {
        if (priority === '3 - Moderate') totals.Response.p3Fulfilled++;
        else if (priority === '4 - Low') totals.Response.p4Fulfilled++;
        if (isVip) totals.Response.vipFulfilled++;
    } else if (responseSLA === "unfulfilled") {
        if (priority === '3 - Moderate') totals.Response.p3Unfulfilled++;
        else if (priority === '4 - Low') totals.Response.p4Unfulfilled++;
        if (isVip) totals.Response.vipUnfulfilled++;
    } else if (responseSLA === "Revisar manualmente") {
        totals.Response.manualReview++;
        // NOTE: global manualReview is a single scalar, NOT priority-bucketed.
        // Per-country manualReview IS priority-bucketed — see asymmetry 1.
    }

    if (resolutionSLA === "fulfilled") {
        if (priority === '3 - Moderate') totals.Resolution.p3Fulfilled++;
        else if (priority === '4 - Low') totals.Resolution.p4Fulfilled++;
        if (isVip) totals.Resolution.vipFulfilled++;
    } else {
        // Intentional `else` (not `else if === "unfulfilled"`) — see asymmetry 3.
        if (priority === '3 - Moderate') totals.Resolution.p3Unfulfilled++;
        else if (priority === '4 - Low') totals.Resolution.p4Unfulfilled++;
        if (isVip) totals.Resolution.vipUnfulfilled++;
    }

    if (warrantySLAStatus === "fulfilled") totals.Warranty.fulfilled++;
    else if (warrantySLAStatus === "unfulfilled") totals.Warranty.unfulfilled++;
    // NOTE: no VIP slice for Warranty — see asymmetry 4.

    // -------- Per-country counters (step 7 in the original pipeline) --------

    if (responseSLA === "fulfilled") {
        if (priority === '3 - Moderate') fulfilled.Response.p3++;
        else if (priority === '4 - Low') fulfilled.Response.p4++;
        if (isVip) fulfilled.Response.vip++;
    } else if (responseSLA === "unfulfilled") {
        if (priority === '3 - Moderate') unfulfilled.Response.p3++;
        else if (priority === '4 - Low') unfulfilled.Response.p4++;
        if (isVip) unfulfilled.Response.vip++;
    } else if (responseSLA === "Revisar manualmente") {
        if (priority === '3 - Moderate') manualReview.Response.p3++;
        else if (priority === '4 - Low') manualReview.Response.p4++;
        if (isVip) manualReview.Response.vip++;
    }

    if (resolutionSLA === "fulfilled") {
        if (priority === '3 - Moderate') fulfilled.Resolution.p3++;
        else if (priority === '4 - Low') fulfilled.Resolution.p4++;
        if (isVip) fulfilled.Resolution.vip++;
    } else {
        // Same `else` (not `else if`) as the global branch — see asymmetry 3.
        if (priority === '3 - Moderate') unfulfilled.Resolution.p3++;
        else if (priority === '4 - Low') unfulfilled.Resolution.p4++;
        if (isVip) unfulfilled.Resolution.vip++;
    }

    if (warrantySLAStatus === "fulfilled") fulfilled.Warranty.fulfilled++;
    else if (warrantySLAStatus === "unfulfilled") unfulfilled.Warranty.unfulfilled++;
    // NOTE: no VIP slice for Warranty here either — see asymmetry 4.
}
