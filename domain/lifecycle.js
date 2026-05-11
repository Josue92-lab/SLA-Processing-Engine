/**
 * Lifecycle — ticket timeline reconstruction.
 *
 * This module is the heart of the inference engine. Given a raw Ticket
 * (produced by domain/ticket.js), it reconstructs the operational timeline:
 *
 *   Created ──► TeamAssignmentDate? ──► AnalystResponseDate? ──► WarrantyDate?
 *   (structured)   (from <p>…</p>)       (from "En proceso")     (from "A garantia")
 *   ...............................................................─► Resolved
 *
 * Three of those events live in free-text fields and must be inferred via
 * regex. The regex separator class tolerates accumulated analyst typos and
 * is intentionally preserved byte-for-byte from the 2021 engine (see
 * domain/slaPolicy.js for the patterns and the justification for not
 * touching them yet).
 *
 * Two-step API:
 *   extractInferredDates(ticket) -> { date1, date2, date3 }
 *       Pure string-level regex extraction. No moment, no TZ.
 *   buildTimeline(ticket, emailTimeZoneMappings, email) -> Timeline
 *       Includes the extracted dates AND their moment equivalents, parsed
 *       in the analyst's local TZ and normalized to the dashboard TZ.
 *
 * Both are exported so Phase 2 unit tests can drive them with synthetic
 * tickets without spinning up an Excel workbook.
 *
 * Two semantic invariants inherited from the original engine — DO NOT
 * "fix" either without a deliberate business decision plus a golden update:
 *
 *   1. First-match semantics. The regexes extract the FIRST matching
 *      occurrence in each free-text field. Real ticket histories are
 *      sometimes exported newest-first, sometimes oldest-first. This
 *      module neither knows nor asserts the ordering; it does whatever the
 *      export happens to present. Under "En proceso" specifically, first
 *      match is typically the correct "first response" event — but this
 *      is not verified.
 *
 *   2. TZ fallback on unmapped email. If `emailTimeZoneMappings[email]`
 *      is undefined (analyst not in the mapping file), `moment.tz(...,
 *      undefined)` falls back to the server's local timezone. SLA deltas
 *      for affected tickets can be off by several hours depending on where
 *      the server runs. The fallback itself is preserved intentionally
 *      — Phase 1b stabilization only ADDED observability; it did not
 *      change the computation. See `warnOnceForUnmappedEmail` below.
 *
 * Risk profile: zero SLA-math change vs. the inline logic previously
 * embedded in routes/excelProcessor.js. Regexes, TZ handling, and moment
 * object identity (ticketMovedDate === creationDate when no team-assignment
 * was inferred) are all preserved. The only observable-behaviour change is
 * first-occurrence stderr warnings for unmapped-email TZ fallback; cell
 * values in the output workbook are unaffected.
 */

import moment from 'moment-timezone';

import { REGEX, DATE_FORMAT, TIMEZONE } from './slaPolicy.js';

// ---------------------------------------------------------------------------
// TZ-fallback observability
// ---------------------------------------------------------------------------

/**
 * Process-wide dedupe set of analyst emails that have already triggered a
 * "missing timezone mapping" warning. We warn exactly once per unique email
 * per Node process so a 10k-row export with 50 unmapped analysts produces
 * 50 log lines, not one per ticket.
 *
 * Trade-off (preserved intentionally during Phase 1b stabilization):
 *   In a long-lived server process, this set persists across pipeline
 *   invocations. Report #2 will not re-warn for emails that were already
 *   warned during report #1. That is the right granularity for a CLI tool
 *   or a short-lived worker. If production deployment topology needs
 *   per-run warnings (e.g. the operator runs multiple reports back-to-back
 *   and wants each run's warnings to be self-contained), the right fix is
 *   to thread an explicit observer object through `buildTimeline` —
 *   deferred as a Phase 2/3 orchestration concern, not a Phase 1b change.
 */
const loggedUnmappedEmails = new Set();

/**
 * Emit a first-occurrence stderr warning for a ticket whose analyst email
 * has no entry in the timezone mapping. Called only from the narrow path
 * in `buildTimeline` where the missing mapping actually affects SLA math
 * — i.e. when at least one inferred date is present and would be parsed
 * with `moment.tz(..., undefined)`. Tickets with no inferred dates do not
 * exercise the fallback and do not warn.
 *
 * This function never throws and never mutates the ticket. It only writes
 * to stderr via `console.warn`.
 *
 * @param {string} email - Analyst email, pre-trimmed by the caller. May be "".
 * @param {string} ticketNumber - Passed through into the message for
 *                                traceability when an operator wants to
 *                                grep the export for the offending row.
 */
function warnOnceForUnmappedEmail(email, ticketNumber) {
    // Key the dedupe set on a non-empty sentinel for the empty-email case
    // so we do not collide with any legitimate email equal to "<empty>".
    const key = email || "<empty-email>";
    if (loggedUnmappedEmails.has(key)) return;
    loggedUnmappedEmails.add(key);

    if (email) {
        console.warn(
            `[lifecycle] No timezone mapping for analyst email "${email}" ` +
            `(first seen on ticket ${ticketNumber || "<unknown>"}); ` +
            `falling back to server local time for inferred dates. ` +
            `This may skew SLA deltas by hours. Fix: add the email to ` +
            `emailTimeZoneMappings in the settings file.`
        );
    } else {
        console.warn(
            `[lifecycle] Ticket ${ticketNumber || "<unknown>"} has an empty ` +
            `Email field; timezone lookup falling back to server local time ` +
            `for inferred dates. Fix: either add "" to excludedEmails if ` +
            `this is intentional, or populate the ticket's Email column.`
        );
    }
}

/**
 * Reset the process-wide unmapped-email dedupe set. Intended for test
 * harnesses that invoke `buildTimeline` multiple times in the same
 * process and need each invocation's warnings to be independent. Not
 * used by the production pipeline.
 *
 * @returns {void}
 */
export function resetUnmappedEmailWarningsForTesting() {
    loggedUnmappedEmails.clear();
}

/**
 * @typedef {Object} InferredDates
 * @property {string} date1 - Team-assignment timestamp captured from "Additional content",
 *                            or "" if no <p>DD-MM-YYYY HH:mm:ss</p> marker is present.
 * @property {string} date2 - Analyst first-response timestamp captured from "Additional comments",
 *                            or "" if no "En proceso" marker is present.
 * @property {string} date3 - Warranty-claim timestamp captured from "Additional comments",
 *                            or "" if no "A garantia"/"Garantia" marker is present.
 */

/**
 * @typedef {Object} Timeline
 * @property {string} date1 - Raw captured string (see InferredDates.date1).
 * @property {string} date2 - Raw captured string (see InferredDates.date2).
 * @property {string} date3 - Raw captured string (see InferredDates.date3).
 * @property {import('moment').Moment} creationDate       - Parsed from ticket.Created (no TZ conversion).
 * @property {import('moment').Moment} resolutionDate     - Parsed from ticket.Resolved (no TZ conversion).
 * @property {import('moment').Moment} ticketMovedDate    - Team-assignment moment, normalized to
 *                                                          dashboard TZ. Falls back to creationDate
 *                                                          (SAME reference) when date1 is empty.
 * @property {import('moment').Moment|null} analystUpdateDate  - First-response moment in dashboard TZ,
 *                                                              or null if date2 is empty.
 * @property {import('moment').Moment|null} warrantyClaimDate  - Warranty-claim moment in dashboard TZ,
 *                                                              or null if date3 is empty.
 */

/**
 * Run the three inference regexes against a ticket's free-text fields.
 *
 * No moment usage, no TZ handling — this is intentionally a pure string
 * transformer so it can be tested in isolation and so the regex layer
 * stays independent from the time-math layer.
 *
 * @param {Object} ticket
 * @returns {InferredDates}
 */
export function extractInferredDates(ticket) {
    const additionalContent  = ticket["Additional content"]  || "";
    const additionalComments = ticket["Additional comments"] || "";

    const matchContent  = additionalContent.match(REGEX.dateHtml);
    const matchProcess  = additionalComments.match(REGEX.dateProcess);
    const matchWarranty = additionalComments.match(REGEX.dateWarranty);

    return {
        date1: matchContent  ? matchContent[1]  : "",
        date2: matchProcess  ? matchProcess[1]  : "",
        date3: matchWarranty ? matchWarranty[1] : ""
    };
}

/**
 * Reconstruct the operational timeline for a single ticket.
 *
 * Behaviour mirrors the original single-pass engine exactly:
 *   - creationDate   / resolutionDate are parsed naive (no TZ conversion);
 *     the downstream .diff() calls operate on absolute UTC offsets so this
 *     is consistent.
 *   - ticketMovedDate is creationDate (same reference) when no <p>…</p>
 *     team-assignment marker is present.
 *   - analystUpdateDate / warrantyClaimDate are null when their respective
 *     markers are absent — callers check with a truthy guard.
 *   - If emailTimeZoneMappings[email] is undefined, moment-timezone uses
 *     the server's local zone. The FALLBACK is preserved, but a first-
 *     occurrence stderr warning is emitted (see warnOnceForUnmappedEmail).
 *     Module header rule #2 has the full rationale.
 *
 * @param {Object} ticket
 * @param {Object<string,string>} emailTimeZoneMappings - email -> TZ name (e.g. "America/Buenos_Aires")
 * @param {string} email - analyst email, pre-trimmed by the caller
 * @returns {Timeline}
 */
export function buildTimeline(ticket, emailTimeZoneMappings, email) {
    const { date1, date2, date3 } = extractInferredDates(ticket);

    const ticketUpdaterTimeZone = emailTimeZoneMappings[email];
    const dashboardTimeZone     = TIMEZONE.dashboard;

    // Observability: warn (once per unique email per process) when we are
    // about to exercise the TZ fallback for a ticket with inferred dates.
    //
    // Gate: at least one of date1/date2/date3 is present. Without any
    // inferred dates, the three ternaries below never call moment.tz with
    // the undefined `ticketUpdaterTimeZone`, so the fallback does not
    // actually fire and a warning would be a false positive.
    //
    // This does not change which path executes — the existing moment.tz
    // calls still proceed exactly as before. It only surfaces the
    // condition to the operator.
    if (!ticketUpdaterTimeZone && (date1 || date2 || date3)) {
        warnOnceForUnmappedEmail(email, ticket.Number);
    }

    const creationDate   = moment(ticket.Created,  DATE_FORMAT.source);
    const resolutionDate = moment(ticket.Resolved, DATE_FORMAT.source);

    const ticketMovedDate = date1
        ? moment.tz(date1, DATE_FORMAT.inferred, ticketUpdaterTimeZone).tz(dashboardTimeZone)
        : creationDate;

    const analystUpdateDate = date2
        ? moment.tz(date2, DATE_FORMAT.inferred, ticketUpdaterTimeZone).tz(dashboardTimeZone)
        : null;

    const warrantyClaimDate = date3
        ? moment.tz(date3, DATE_FORMAT.inferred, ticketUpdaterTimeZone).tz(dashboardTimeZone)
        : null;

    return {
        date1, date2, date3,
        creationDate,
        resolutionDate,
        ticketMovedDate,
        analystUpdateDate,
        warrantyClaimDate
    };
}
