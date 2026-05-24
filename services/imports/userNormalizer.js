/**
 * User-row normalizer.
 *
 * Single responsibility: take a raw row object (as produced by
 * `excelImportParser.parseWorkbook`) and decide whether it should be kept.
 *
 * Two orthogonal concepts are tracked per row:
 *   - RECORD ELIGIBILITY: "is this user active per HR snapshot, and
 *     should they appear in the operator-facing kept-records set?"
 *     Captured by the `record` field of the return value and the
 *     `records[]` array of normalizeAll. Active rows produce a record;
 *     inactive rows do not.
 *   - IDENTITY PARTICIPATION: "did this user generate tickets that the
 *     SLA report needs to classify? Should their email/tz/country/role
 *     enter the imported settings?" Captured by the `inactiveRecord`
 *     field and the `inactiveRecords[]` array. An inactive row that
 *     has a valid email and userType produces an `inactiveRecord` with
 *     the same shape as `record` would have. Routes that opt into
 *     identity participation (see SLA_INCLUDE_INACTIVE_IDENTITIES in
 *     routes/settingsImport.js) merge inactiveRecords into the
 *     downstream pipeline so the planner derives excludedEmails / TZ /
 *     country / vipUsers from active + inactive identities together.
 *
 * Three outcomes per row:
 *   1. TIER 2 filter: inactive users do NOT produce a kept record. The
 *      aggregate `dropped.inactive` counter increments and a per-row
 *      audit warning is emitted so operators can see which identities
 *      were filtered and why. If the row has extractable identity
 *      (valid email + userType), it ALSO produces an inactiveRecord
 *      so callers that opt in can let identity participate downstream.
 *   2. TIER 3 drop: malformed rows (empty email, invalid userType) are
 *      dropped with a warning attached.
 *   3. KEPT: a typed NormalizedUser record is returned. Sub-issues like
 *      an invalid timezone or unresolvable country do NOT drop the row;
 *      they null-out the specific field and emit a warning.
 *
 * The normalizer is pure: no I/O, no module-level state. The country
 * resolver is injected so tests can substitute a fake.
 */

import moment from 'moment-timezone';

import { normalizeCountry as defaultNormalizeCountry } from './countryNameResolver.js';

const VALID_USER_TYPES = new Set(['EXE', 'OSE']);

// Minimal email sanity check. We intentionally do NOT use a regex that tries
// to be RFC-compliant: we only need to reject obvious nonsense from the
// export, not validate addresses.
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * @typedef {object} NormalizedUser
 * @property {string} email
 * @property {string} name
 * @property {string|null} tz
 * @property {string|null} country     ISO-2, or null if unresolvable
 * @property {'EXE'|'OSE'} userType
 * @property {'analyst'|'vip'} source
 */

/**
 * Normalize a single row.
 *
 * @param {object} rawRow - one entry from `parseWorkbook` output
 * @param {'analyst'|'vip'} source - which file this row came from
 * @param {object} [deps]
 * @param {(value: string) => string|null} [deps.resolveCountry]
 * @param {(tz: string) => boolean} [deps.isValidTz]
 * @returns {{
 *   record: NormalizedUser|null,
 *   inactiveRecord: NormalizedUser|null,
 *   skipped: null|'inactive'|'missingEmail'|'invalidEmail'|'invalidUserType',
 *   warnings: string[]
 * }}
 */
export const normalizeRow = (rawRow, source, deps = {}) => {
    const resolveCountry = deps.resolveCountry || defaultNormalizeCountry;
    const isValidTz = deps.isValidTz || defaultIsValidTz;

    const warnings = [];

    // --- Tier 2: active filter (record-eligibility gate) ---
    const activeRaw     = String(rawRow['Active']            ?? '').trim();
    const statusRaw     = String(rawRow['Status']            ?? '').trim();
    const gamaStatusRaw = String(rawRow['Gama User Status']  ?? '').trim();

    const isActive =
        activeRaw === '1' &&
        statusRaw.toUpperCase() === 'ENABLED' &&
        gamaStatusRaw.toUpperCase() === 'ENABLED';

    if (!isActive) {
        // Tier-2 still drops the row from the kept-records set (no record
        // returned, skipped='inactive'). PR #23 added the per-row audit
        // warning. This commit additionally extracts identity for the
        // dropped row when it is structurally extractable, exposing it
        // via `inactiveRecord` so opt-in callers (see
        // SLA_INCLUDE_INACTIVE_IDENTITIES in routes/settingsImport.js)
        // can let inactive identities participate in the downstream
        // pipeline. When the flag is OFF, callers ignore inactiveRecord
        // and behavior is bit-for-bit identical to PR #23. When ON,
        // inactive identities propagate to all four imported settings
        // fields via the existing planner derivation - no planner change.
        const emailHint = String(rawRow['Email'] ?? '').trim() || '(missing)';
        const nameHint  = String(rawRow['Name']  ?? '').trim() || '(missing)';
        const auditWarning =
            `Row dropped (inactive): email=${emailHint}, name="${nameHint}", source=${source} ` +
            `[Active="${activeRaw}", Status="${statusRaw}", Gama User Status="${gamaStatusRaw}"]`;

        // Try to extract identity for participation. Tier-3 sanity checks
        // are applied silently here (no extra warnings on top of the
        // audit warning, since the row is already accounted for as
        // dropped.inactive). If the row fails sanity, inactiveRecord
        // stays null and the row is fully unrecoverable - same as today.
        const inactiveRecord = extractIdentityIfValid(rawRow, source, { resolveCountry, isValidTz });

        return {
            record: null,
            inactiveRecord,
            skipped: 'inactive',
            warnings: [auditWarning]
        };
    }

    // --- Tier 3: drop-with-warning filters ---
    const email = String(rawRow['Email'] ?? '').trim();
    if (email === '') {
        return {
            record: null,
            inactiveRecord: null,
            skipped: 'missingEmail',
            warnings: [`Row dropped: missing Email (source=${source})`]
        };
    }
    if (!LOOKS_LIKE_EMAIL.test(email)) {
        return {
            record: null,
            inactiveRecord: null,
            skipped: 'invalidEmail',
            warnings: [`Row dropped: email "${email}" does not look like an address (source=${source})`]
        };
    }

    const userType = String(rawRow['User type'] ?? '').trim().toUpperCase();
    if (!VALID_USER_TYPES.has(userType)) {
        return {
            record: null,
            inactiveRecord: null,
            skipped: 'invalidUserType',
            warnings: [`Row dropped: User type "${userType}" not in {EXE, OSE} (email=${email}, source=${source})`]
        };
    }

    // --- Kept row: per-field soft normalization ---
    const name = String(rawRow['Name'] ?? '').trim();

    const tzRaw = String(rawRow['Time zone'] ?? '').trim();
    let tz = null;
    if (tzRaw !== '') {
        if (isValidTz(tzRaw)) {
            tz = tzRaw;
        } else {
            warnings.push(`Invalid timezone "${tzRaw}" for ${email}; TZ mapping skipped (source=${source})`);
        }
    }

    const countryRaw = String(rawRow['Country code'] ?? '').trim();
    let country = null;
    if (countryRaw !== '') {
        const resolved = resolveCountry(countryRaw);
        if (resolved) {
            country = resolved;
        } else {
            warnings.push(`Unresolved country "${countryRaw}" for ${email}; country mapping skipped (source=${source})`);
        }
    }

    return {
        record: { email, name, tz, country, userType, source },
        inactiveRecord: null,
        skipped: null,
        warnings
    };
};

/**
 * Internal helper: try to build a NormalizedUser-shaped record for an
 * inactive row. Returns null if the row fails the same identity sanity
 * checks tier-3 applies to active rows (valid email, valid userType).
 *
 * Soft fields (tz, country) follow the same rules as active rows: invalid
 * tz / unresolvable country null-out the field rather than discarding the
 * record. Warnings produced here are intentionally swallowed; the caller
 * already emitted a tier-2 audit warning for the row, and stacking
 * additional warnings would just noise up the report.
 */
const extractIdentityIfValid = (rawRow, source, { resolveCountry, isValidTz }) => {
    const email = String(rawRow['Email'] ?? '').trim();
    if (email === '' || !LOOKS_LIKE_EMAIL.test(email)) return null;

    const userType = String(rawRow['User type'] ?? '').trim().toUpperCase();
    if (!VALID_USER_TYPES.has(userType)) return null;

    const name = String(rawRow['Name'] ?? '').trim();

    const tzRaw = String(rawRow['Time zone'] ?? '').trim();
    let tz = null;
    if (tzRaw !== '' && isValidTz(tzRaw)) tz = tzRaw;

    const countryRaw = String(rawRow['Country code'] ?? '').trim();
    let country = null;
    if (countryRaw !== '') {
        const resolved = resolveCountry(countryRaw);
        if (resolved) country = resolved;
    }

    return { email, name, tz, country, userType, source };
};

/**
 * Batch helper: normalize all rows from one file.
 *
 * @param {Array<object>} rawRows
 * @param {'analyst'|'vip'} source
 * @param {object} [deps] - forwarded to normalizeRow
 * @returns {{
 *   records: NormalizedUser[],
 *   inactiveRecords: NormalizedUser[],
 *   dropped: { inactive: number, missingEmail: number, invalidEmail: number, invalidUserType: number },
 *   warnings: string[]
 * }}
 */
export const normalizeAll = (rawRows, source, deps = {}) => {
    const records = [];
    const inactiveRecords = [];
    const warnings = [];
    const dropped = { inactive: 0, missingEmail: 0, invalidEmail: 0, invalidUserType: 0 };

    for (const row of rawRows) {
        const out = normalizeRow(row, source, deps);
        if (out.skipped) {
            dropped[out.skipped] = (dropped[out.skipped] || 0) + 1;
            // Inactive rows with extractable identity ride alongside the
            // kept records on a parallel track. Callers decide whether
            // to merge them into the downstream pipeline (see
            // SLA_INCLUDE_INACTIVE_IDENTITIES). Tier-3 drops never produce
            // an inactiveRecord (they are structurally invalid).
            if (out.inactiveRecord) inactiveRecords.push(out.inactiveRecord);
        } else if (out.record) {
            records.push(out.record);
        }
        if (out.warnings.length) warnings.push(...out.warnings);
    }

    return { records, inactiveRecords, dropped, warnings };
};

/**
 * Default timezone validator: uses moment-timezone's zone registry.
 * Exported for test substitution.
 */
export const defaultIsValidTz = (tz) => {
    return moment.tz.zone(tz) !== null;
};
