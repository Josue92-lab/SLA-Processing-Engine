/**
 * SLA Rules — verdict classification.
 *
 * Turns a reconstructed ticket timeline (see domain/lifecycle.js) into the
 * three verdicts the output workbook records for every row:
 *
 *   responseSLA       "fulfilled" | "unfulfilled" | "Revisar manualmente"
 *   resolutionSLA     "fulfilled" | "unfulfilled"
 *   warrantySLAStatus "fulfilled" | "unfulfilled" | ""   (empty when N/A)
 *
 * Plus the minute-delta scalars that feed the RawSLAData columns and are
 * reused downstream by the VIP classifier:
 *
 *   differenceFromUpdated   analystUpdateDate  - ticketMovedDate   (null if absent)
 *   differenceFromCreated   resolutionDate     - ticketMovedDate   (always computed)
 *   warrantyDifference      warrantyClaimDate  - ticketMovedDate   (null if absent)
 *
 * All thresholds, verdict strings, and priority labels come from
 * domain/slaPolicy.js. This file contains no literals — change a threshold
 * or label there, not here.
 *
 * Behaviour preserved byte-for-byte from the inline block in
 * routes/excelProcessor.js (the "Clasificación SLA" section). In particular:
 *
 *   1. Non-P3/P4 response. `responseSLA` is seeded with MANUAL_REVIEW and is
 *      ONLY overwritten inside the P3/P4 branches. A ticket with an unknown
 *      priority (e.g. "1 - Critical") that has a real analyst response therefore
 *      still reports "Revisar manualmente" — intentional, matches the
 *      operational intent (priorities outside P3/P4 are not in the contract).
 *
 *   2. Non-P3/P4 resolution. `resolutionSLA` is seeded with UNFULFILLED and
 *      ONLY overwritten inside the P3/P4 branches. A non-P3/P4 ticket is
 *      therefore counted as UNFULFILLED in the resolution aggregate. This is
 *      the historical behaviour; kept exactly to preserve golden numbers.
 *
 *   3. Response gate. `differenceFromUpdated` is only computed when `date2`
 *      (the "En proceso" marker) is present. It is intentionally NOT derived
 *      from `analystUpdateDate` alone — `date2` is the authoritative gate in
 *      the original code, even though `analystUpdateDate` is non-null iff
 *      `date2` is non-empty (see lifecycle.js). Keeping the same gate avoids
 *      any chance of divergence if lifecycle semantics evolve.
 *
 *   4. Warranty independence. The warranty verdict is compared against
 *      THRESHOLDS.warranty and is priority-independent. Same as 2021.
 *
 * Risk profile: zero behaviour change. No threshold, priority label, verdict
 * string, or control-flow branch has been altered relative to the inline
 * implementation.
 */

import { PRIORITY, VERDICT, THRESHOLDS } from './slaPolicy.js';

/**
 * @typedef {Object} SlaClassification
 * @property {string}      responseSLA            One of VERDICT.* (may be MANUAL_REVIEW).
 * @property {string}      resolutionSLA          VERDICT.FULFILLED or VERDICT.UNFULFILLED.
 * @property {string}      warrantySLAStatus      VERDICT.FULFILLED, VERDICT.UNFULFILLED, or "".
 * @property {number|null} differenceFromUpdated  Minutes, or null when no analyst response inferred.
 * @property {number}      differenceFromCreated  Minutes. Always present.
 * @property {number|null} warrantyDifference     Minutes, or null when no warranty event inferred.
 */

/**
 * Classify a single ticket's SLA verdicts and minute deltas.
 *
 * The inputs mirror the fields the caller already has on hand from
 * buildTimeline(); we don't re-derive them here so the caller controls the
 * ticket contract and this module stays a pure policy evaluator.
 *
 * @param {Object} args
 * @param {string}      args.priority           Ticket priority label (e.g. PRIORITY.P3).
 * @param {string}      args.date2              Raw captured "En proceso" string; "" means absent.
 * @param {import('moment').Moment}      args.ticketMovedDate     Reference moment for all diffs.
 * @param {import('moment').Moment|null} args.analystUpdateDate   First-response moment, or null.
 * @param {import('moment').Moment}      args.resolutionDate      Resolution moment.
 * @param {import('moment').Moment|null} args.warrantyClaimDate   Warranty moment, or null.
 * @returns {SlaClassification}
 */
export function classifySla({
    priority,
    date2,
    ticketMovedDate,
    analystUpdateDate,
    resolutionDate,
    warrantyClaimDate
}) {
    let responseSLA = VERDICT.MANUAL_REVIEW;
    let differenceFromUpdated = null;

    if (date2) {
        differenceFromUpdated = analystUpdateDate.diff(ticketMovedDate, 'minutes');

        if (priority === PRIORITY.P3) {
            responseSLA = differenceFromUpdated <= THRESHOLDS.response.p3 ? VERDICT.FULFILLED : VERDICT.UNFULFILLED;
        } else if (priority === PRIORITY.P4) {
            responseSLA = differenceFromUpdated <= THRESHOLDS.response.p4 ? VERDICT.FULFILLED : VERDICT.UNFULFILLED;
        }
    }

    const differenceFromCreated = resolutionDate.diff(ticketMovedDate, 'minutes');

    let warrantyDifference = null;
    let warrantySLAStatus = "";
    if (warrantyClaimDate) {
        warrantyDifference = warrantyClaimDate.diff(ticketMovedDate, 'minutes');
        warrantySLAStatus = warrantyDifference <= THRESHOLDS.warranty ? VERDICT.FULFILLED : VERDICT.UNFULFILLED;
    }

    let resolutionSLA = VERDICT.UNFULFILLED;
    if (priority === PRIORITY.P3) {
        resolutionSLA = differenceFromCreated <= THRESHOLDS.resolution.p3 ? VERDICT.FULFILLED : VERDICT.UNFULFILLED;
    } else if (priority === PRIORITY.P4) {
        resolutionSLA = differenceFromCreated <= THRESHOLDS.resolution.p4 ? VERDICT.FULFILLED : VERDICT.UNFULFILLED;
    }

    return {
        responseSLA,
        resolutionSLA,
        warrantySLAStatus,
        differenceFromUpdated,
        differenceFromCreated,
        warrantyDifference
    };
}
