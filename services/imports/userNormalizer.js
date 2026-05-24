/**
 * User-row normalizer.
 *
 * Single responsibility: take a raw row object (as produced by
 * `excelImportParser.parseWorkbook`) and decide whether it should be kept.
 *
 * Three outcomes per row:
 *   1. TIER 2 filter: inactive users are dropped from settings. Both
 *      the aggregate counter and a per-row audit warning are emitted
 *      so operators can see which identities were filtered and why
 *      (mitigates the silent-drop defect class without changing what
 *      ends up in settings).
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
 *   skipped: null|'inactive'|'missingEmail'|'invalidEmail'|'invalidUserType',
 *   warnings: string[]
 * }}
 */
export const normalizeRow = (rawRow, source, deps = {}) => {
    const resolveCountry = deps.resolveCountry || defaultNormalizeCountry;
    const isValidTz = deps.isValidTz || defaultIsValidTz;

    const warnings = [];

    // --- Tier 2: silent filter (only aggregate counters care) ---
    const activeRaw     = String(rawRow['Active']            ?? '').trim();
    const statusRaw     = String(rawRow['Status']            ?? '').trim();
    const gamaStatusRaw = String(rawRow['Gama User Status']  ?? '').trim();

    const isActive =
        activeRaw === '1' &&
        statusRaw.toUpperCase() === 'ENABLED' &&
        gamaStatusRaw.toUpperCase() === 'ENABLED';

    if (!isActive) {
        // Tier-2 still drops the row from the kept-records set (no record
        // returned, skipped='inactive'). The drop is no longer silent: a
        // per-row audit warning is emitted so operators can identify
        // exactly which rows were filtered and which gate value(s)
        // triggered it. Behavior of all four imported settings fields
        // (excludedEmails, vipUsers, emailTimeZoneMappings, emailCountries)
        // is unchanged - this is purely additive observability.
        const emailHint = String(rawRow['Email'] ?? '').trim() || '(missing)';
        const nameHint  = String(rawRow['Name']  ?? '').trim() || '(missing)';
        return {
            record: null,
            skipped: 'inactive',
            warnings: [
                `Row dropped (inactive): email=${emailHint}, name="${nameHint}", source=${source} ` +
                `[Active="${activeRaw}", Status="${statusRaw}", Gama User Status="${gamaStatusRaw}"]`
            ]
        };
    }

    // --- Tier 3: drop-with-warning filters ---
    const email = String(rawRow['Email'] ?? '').trim();
    if (email === '') {
        return {
            record: null,
            skipped: 'missingEmail',
            warnings: [`Row dropped: missing Email (source=${source})`]
        };
    }
    if (!LOOKS_LIKE_EMAIL.test(email)) {
        return {
            record: null,
            skipped: 'invalidEmail',
            warnings: [`Row dropped: email "${email}" does not look like an address (source=${source})`]
        };
    }

    const userType = String(rawRow['User type'] ?? '').trim().toUpperCase();
    if (!VALID_USER_TYPES.has(userType)) {
        return {
            record: null,
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
        skipped: null,
        warnings
    };
};

/**
 * Batch helper: normalize all rows from one file.
 *
 * @param {Array<object>} rawRows
 * @param {'analyst'|'vip'} source
 * @param {object} [deps] - forwarded to normalizeRow
 * @returns {{
 *   records: NormalizedUser[],
 *   dropped: { inactive: number, missingEmail: number, invalidEmail: number, invalidUserType: number },
 *   warnings: string[]
 * }}
 */
export const normalizeAll = (rawRows, source, deps = {}) => {
    const records = [];
    const warnings = [];
    const dropped = { inactive: 0, missingEmail: 0, invalidEmail: 0, invalidUserType: 0 };

    for (const row of rawRows) {
        const out = normalizeRow(row, source, deps);
        if (out.skipped) {
            dropped[out.skipped] = (dropped[out.skipped] || 0) + 1;
        } else if (out.record) {
            records.push(out.record);
        }
        if (out.warnings.length) warnings.push(...out.warnings);
    }

    return { records, dropped, warnings };
};

/**
 * Default timezone validator: uses moment-timezone's zone registry.
 * Exported for test substitution.
 */
export const defaultIsValidTz = (tz) => {
    return moment.tz.zone(tz) !== null;
};
