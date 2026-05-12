/**
 * Cross-file import validator.
 *
 * Runs AFTER individual files have been parsed and normalized. Operates on
 * the two NormalizedUser[] arrays (analyst + vip). Produces:
 *
 *   - hard errors (tier 1): any non-empty `errors` array causes the import
 *     to be rejected with a 400. No write occurs.
 *   - soft warnings (tier 3): added to the import plan so the operator sees
 *     them before clicking Apply.
 *
 * Checks performed here are the ones that can only be decided by looking
 * at both files together:
 *   - same email present as both EXE and OSE across the two files
 *   - file-swap heuristic (analyst file 100% OSE or vip file 100% EXE)
 *
 * Intra-file duplicate-detection also happens here so the warning surface
 * is unified at the caller (planner).
 *
 * Pure module.
 */

import { ImportError, ERR } from './errors.js';

/**
 * @param {NormalizedUser[]} analyst
 * @param {NormalizedUser[]} vip
 * @returns {{ errors: ImportError[], warnings: string[] }}
 */
export const validateCrossFile = (analyst, vip) => {
    const errors = [];
    const warnings = [];

    // --- File swap heuristic ---
    // Both files must have at least one row for the heuristic to mean
    // anything. Empty files are handled as tier-1 by the parser already.
    if (analyst.length > 0 && analyst.every(r => r.userType === 'OSE')) {
        errors.push(new ImportError(
            ERR.FILE_SWAP_DETECTED,
            'Analyst export appears to contain only OSE (internal) users. ' +
            'It looks like the Analyst and VIP files may have been swapped.',
            { analystRows: analyst.length, analystExeCount: 0 }
        ));
    }
    if (vip.length > 0 && vip.every(r => r.userType === 'EXE')) {
        errors.push(new ImportError(
            ERR.FILE_SWAP_DETECTED,
            'VIP export appears to contain only EXE (external) users. ' +
            'It looks like the Analyst and VIP files may have been swapped.',
            { vipRows: vip.length, vipOseCount: 0 }
        ));
    }

    // --- Cross-file EXE+OSE conflict ---
    // Build a map of email -> set of userTypes seen across both files.
    const typeByEmail = new Map();
    const track = (r) => {
        if (!typeByEmail.has(r.email)) typeByEmail.set(r.email, new Set());
        typeByEmail.get(r.email).add(r.userType);
    };
    analyst.forEach(track);
    vip.forEach(track);

    const conflicts = [];
    for (const [email, types] of typeByEmail) {
        if (types.has('EXE') && types.has('OSE')) conflicts.push(email);
    }
    if (conflicts.length > 0) {
        errors.push(new ImportError(
            ERR.CROSS_FILE_USERTYPE_CONFLICT,
            `${conflicts.length} email(s) appear as both EXE and OSE across the two files. ` +
            `This is a source-system inconsistency and must be fixed upstream before import.`,
            { emails: conflicts.slice(0, 50) } // cap payload
        ));
    }

    // --- Cross-file soft warnings: same email, different TZ / country ---
    // Precedence (decision #2): VIP wins. We emit a warning per collision.
    const byEmail = new Map();
    const register = (r) => {
        const existing = byEmail.get(r.email);
        if (!existing) {
            byEmail.set(r.email, r);
            return;
        }
        // Cross-file only: same email but different source.
        if (existing.source !== r.source) {
            if ((existing.tz || null) !== (r.tz || null) && existing.tz && r.tz) {
                warnings.push(
                    `Email ${r.email} has different Time zone in analyst (${existing.tz}) ` +
                    `and VIP (${r.tz}) files; VIP value kept.`
                );
            }
            if ((existing.country || null) !== (r.country || null) && existing.country && r.country) {
                warnings.push(
                    `Email ${r.email} has different Country in analyst (${existing.country}) ` +
                    `and VIP (${r.country}) files; VIP value kept.`
                );
            }
            // Canonicalize: keep whichever is vip.
            if (r.source === 'vip') byEmail.set(r.email, r);
        }
    };
    analyst.forEach(register);
    vip.forEach(register);

    return { errors, warnings };
};

/**
 * Intra-file duplicate detection. First-write-wins on email.
 *
 * @param {NormalizedUser[]} records
 * @param {'analyst'|'vip'} source
 * @returns {{ unique: NormalizedUser[], warnings: string[] }}
 */
export const deduplicateByEmail = (records, source) => {
    const seen = new Map();
    const warnings = [];
    for (const r of records) {
        const prior = seen.get(r.email);
        if (!prior) {
            seen.set(r.email, r);
            continue;
        }
        // Already have this email in this file.
        if ((prior.tz || null) !== (r.tz || null) ||
            (prior.country || null) !== (r.country || null) ||
            prior.userType !== r.userType ||
            prior.name !== r.name) {
            warnings.push(
                `Duplicate email ${r.email} in ${source} file with differing values; first occurrence kept.`
            );
        }
    }
    return { unique: Array.from(seen.values()), warnings };
};
