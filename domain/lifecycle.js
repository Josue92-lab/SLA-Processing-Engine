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
 *   2. Silent TZ fallback. If `emailTimeZoneMappings[email]` is undefined
 *      (analyst not in the mapping file), `moment.tz(..., undefined)`
 *      silently falls back to the server's local timezone. That means SLA
 *      deltas can be off by several hours depending on where the server
 *      runs. Preserved intentionally — see Phase 2 roadmap.
 *
 * Risk profile: zero behaviour change vs. the inline logic previously
 * embedded in routes/excelProcessor.js. Regexes, TZ handling, and moment
 * object identity (ticketMovedDate === creationDate when no team-assignment
 * was inferred) are all preserved.
 */

import moment from 'moment-timezone';

import { REGEX, DATE_FORMAT, TIMEZONE } from './slaPolicy.js';

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
 *   - If emailTimeZoneMappings[email] is undefined, moment-timezone silently
 *     uses the server's local zone. Preserved as-is (see module header).
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
