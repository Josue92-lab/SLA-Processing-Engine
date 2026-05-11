/**
 * VIP — caller elevation and VIP-scoped verdicts.
 *
 * Two concerns, one module — they share the same operational definition of
 * "who counts as a VIP" and keeping them together keeps that definition
 * findable:
 *
 *   isVipCaller(callerName, vipUsers)      -> boolean
 *   classifyVip({ isVip, analystUpdateDate, differenceFromUpdated, differenceFromCreated })
 *     -> { responseVip, resolvedVip }
 *
 * Behaviour preserved byte-for-byte from the inline block in
 * routes/excelProcessor.js. The non-obvious bits:
 *
 *   1. Substring match, not equality. VIP detection is
 *      `callerName.includes(vip.name)`, iterating the VIP list in insertion
 *      order and short-circuiting on the first hit. This tolerates analysts
 *      entering "Dr. Smith (External)" when the VIP list has "Dr. Smith",
 *      but it also means "Smith" in the VIP list would match "Blacksmith".
 *      That latitude is intentional and is the rule the operational team has
 *      been calibrating against for years — do not switch to exact match
 *      without product sign-off and a golden update.
 *
 *   2. Priority-independent VIP windows. VIP tickets compare against
 *      THRESHOLDS.response.vip / THRESHOLDS.resolution.vip regardless of
 *      the ticket's P3/P4 label. See slaPolicy.js for the rationale; keeping
 *      the logic here means P3/P4 thresholds and VIP thresholds never share
 *      a code path.
 *
 *   3. Three output states for responseVip:
 *        - ""                  non-VIP row (no cell contents)
 *        - "Revisar manualmente" VIP row with no analyst response inferred
 *        - "fulfilled"/"unfulfilled" VIP row with analyst response inferred
 *      resolvedVip has only two states:
 *        - ""                  non-VIP row, OR VIP with no analyst response
 *        - "fulfilled"/"unfulfilled" VIP row with analyst response inferred
 *      The resolvedVip gate on `analystUpdateDate` is deliberate and matches
 *      the original engine: we do not report a VIP resolution verdict unless
 *      we also inferred a VIP response path. This keeps the VIP aggregate
 *      counters symmetric.
 *
 *   4. Gate is `analystUpdateDate` (not `date2`). slaRules.js uses `date2`
 *      as its response gate for symmetry with the original SLA block;
 *      here we use `analystUpdateDate` because that is what the original
 *      VIP block used. The two gates are always consistent in practice
 *      (analystUpdateDate is truthy iff date2 is non-empty; see
 *      domain/lifecycle.js), but we preserve each callsite exactly.
 *
 * Risk profile: zero behaviour change. No threshold, verdict string,
 * matching semantics, or control-flow branch has been altered relative to
 * the inline implementation.
 */

import { VERDICT, THRESHOLDS } from './slaPolicy.js';

/**
 * @typedef {{ name: string }} VipUser
 * Minimal shape consumed by this module. Additional fields in the settings
 * file (email, country, etc.) are ignored here.
 */

/**
 * @typedef {Object} VipClassification
 * @property {string} responseVip  "" | VERDICT.MANUAL_REVIEW | VERDICT.FULFILLED | VERDICT.UNFULFILLED
 * @property {string} resolvedVip  "" | VERDICT.FULFILLED | VERDICT.UNFULFILLED
 */

/**
 * Decide whether the given caller name matches any VIP in the configured list.
 *
 * Substring match, insertion-order iteration, first-hit short-circuits.
 * See the module header for why this tolerance is operationally meaningful
 * and why it must not be tightened without product sign-off.
 *
 * @param {string} callerName
 * @param {VipUser[]} vipUsers
 * @returns {boolean}
 */
export function isVipCaller(callerName, vipUsers) {
    const name = callerName || "";
    // Optimización: Set lookup is faster than Array.some if exact match, but since it's "includes", we keep iteration.
    for (let vip of vipUsers) {
        if (name.includes(vip.name)) {
            return true;
        }
    }
    return false;
}

/**
 * Derive the two VIP verdict cells for a single ticket row.
 *
 * Takes the minute deltas already computed by classifySla() rather than
 * recomputing from moment objects — keeps this module purely arithmetic
 * and avoids coupling it to the timeline shape.
 *
 * @param {Object} args
 * @param {boolean}                       args.isVip                  Result of isVipCaller().
 * @param {import('moment').Moment|null}  args.analystUpdateDate      Gate: truthy => real response inferred.
 * @param {number|null}                   args.differenceFromUpdated  Minutes (see slaRules.js).
 * @param {number}                        args.differenceFromCreated  Minutes (see slaRules.js).
 * @returns {VipClassification}
 */
export function classifyVip({
    isVip,
    analystUpdateDate,
    differenceFromUpdated,
    differenceFromCreated
}) {
    let responseVip = isVip ? VERDICT.MANUAL_REVIEW : "";
    let resolvedVip = "";

    if (isVip && analystUpdateDate) {
        responseVip = differenceFromUpdated <= THRESHOLDS.response.vip ? VERDICT.FULFILLED : VERDICT.UNFULFILLED;
        resolvedVip = differenceFromCreated <= THRESHOLDS.resolution.vip ? VERDICT.FULFILLED : VERDICT.UNFULFILLED;
    }

    return { responseVip, resolvedVip };
}
