/**
 * Import planner - composes parsed+normalized records into an ImportPlan.
 *
 * Pipeline position:
 *
 *   parseWorkbook  -> normalizeAll  -> validateCrossFile
 *                                                        \
 *                                                         -> importPlanner.build
 *                                                        /
 *                   currentSettings + lastImport sidecar
 *
 * Responsibilities:
 *   1. Derive `imported.*` from the normalized records, using mode + rule #4
 *      (EXE/OSE -> excludedEmails) and cross-file VIP precedence.
 *   2. Simulate the applier to compute `nextSettings` for hashing and diff.
 *   3. Build a human-readable diff per field: add / remove / changed / unchanged.
 *   4. Roll up row counts and warnings.
 *   5. Compute sanity flags for the UI (largeShrink / largeChurn).
 *
 * NO I/O, NO randomness, NO wall-clock reads unless the caller injects them.
 * The `planId` is produced by the HTTP layer, not here.
 */

import { ImportError, ERR } from './errors.js';
import { apply as applierApply } from './importApplier.js';

/**
 * @typedef {'external'|'internal'} Mode
 */

const VALID_MODES = new Set(['external', 'internal']);

/**
 * @param {object} args
 * @param {object} args.currentSettings - the live settings object
 * @param {object} args.lastImport - the last-import sidecar (or empty shape)
 * @param {NormalizedUser[]} args.analyst - normalized analyst records
 * @param {NormalizedUser[]} args.vip - normalized VIP records
 * @param {Mode}   args.mode
 * @param {object} [args.counts] - { analyst: {parsed, kept, dropped}, vip: {...} }
 * @param {string[]} [args.warnings] - extra warnings from earlier stages
 * @returns {object} ImportPlan
 */
export const build = ({
    currentSettings,
    lastImport,
    analyst,
    vip,
    mode,
    counts = { analyst: { parsed: 0, kept: 0, dropped: {} }, vip: { parsed: 0, kept: 0, dropped: {} } },
    warnings = []
}) => {
    if (!VALID_MODES.has(mode)) {
        throw new ImportError(ERR.INVALID_MODE, `Unknown mode: ${mode}`);
    }

    const imported = deriveImported(analyst, vip, mode);

    // Simulate the applier to compute the "next" shape deterministically.
    // We pass a fixed `now` so the planner stays pure — the real apply at
    // write time will record the real timestamp.
    const { nextSettings } = applierApply(currentSettings, imported, lastImport, {
        mode,
        now: () => '1970-01-01T00:00:00.000Z'
    });

    const diff = buildDiff(currentSettings, nextSettings, lastImport, imported);
    const sanityFlags = computeSanityFlags(currentSettings, nextSettings);

    return {
        generatedAt: new Date().toISOString(),
        mode,
        counts,
        imported,
        diff,
        warnings,
        sanityFlags,
        // not included: planId (HTTP layer), currentSettingsHash (HTTP layer)
    };
};

// ---------------------------------------------------------------------------
// Deriving the `imported` section
// ---------------------------------------------------------------------------
//
// Source ownership (strict — do NOT mix sources):
//   - Analyst file  -> excludedEmails, emailTimeZoneMappings, emailCountries
//   - VIP file      -> vipUsers ONLY
//
// VIP rows MUST NOT participate in TZ / country / excludedEmails derivation.
// The VIP file is purely a name overlay used to flag tickets for VIP SLA
// thresholds at runtime. The analyst file is the canonical population for
// role routing (EXE/OSE) and identity attributes (TZ, country).

const deriveImported = (analyst, vip, mode) => {
    // excludedEmails: derived from the ANALYST file only, partitioned by
    // userType. external mode excludes OSE emails (internal users), internal
    // mode excludes EXE emails (external users). VIP file does not contribute.
    const exeEmails = unique(analyst.filter(r => r.userType === 'EXE').map(r => r.email));
    const oseEmails = unique(analyst.filter(r => r.userType === 'OSE').map(r => r.email));
    const excludedEmails = mode === 'external' ? oseEmails : exeEmails;

    // emailTimeZoneMappings + emailCountries: derived from the ANALYST file
    // only. VIP rows do not contribute identity attributes - the VIP file
    // is overlay-only (vipUsers).
    const emailTimeZoneMappings = {};
    const emailCountries = [];
    for (const r of analyst) {
        if (r.tz)      emailTimeZoneMappings[r.email] = r.tz;
        if (r.country) emailCountries.push({ Email: r.email, Country: r.country });
    }

    // vipUsers: distinct names from the VIP file ONLY.
    const vipNames = unique(vip.map(r => r.name).filter(n => n && n.length > 0));
    const vipUsers = vipNames.map(name => ({ name }));

    return {
        excludedEmails: excludedEmails.sort(),
        vipUsers:       vipUsers.sort((a, b) => a.name.localeCompare(b.name)),
        emailTimeZoneMappings,
        emailCountries: emailCountries.sort((a, b) => a.Email.localeCompare(b.Email))
    };
};

// ---------------------------------------------------------------------------
// Diff computation
// ---------------------------------------------------------------------------

/**
 * Per-field diff. `add`/`remove`/`changed` are the USER-VISIBLE deltas between
 * the current settings and what WILL be on disk after apply.
 *
 * We do NOT derive the diff from previousImp/newImp directly. We derive it
 * from current vs next, which is what the operator actually sees change.
 * This correctly handles manual entries that happen to coincide with newImp
 * (they count as "unchanged", not "changed").
 */
const buildDiff = (current, next, previousImp, newImp) => {
    return {
        excludedEmails:        diffStringList(current.excludedEmails || [], next.excludedEmails || []),
        vipUsers:              diffObjectList(current.vipUsers || [],       next.vipUsers || [],       'name',  ['name']),
        emailTimeZoneMappings: diffMap(current.emailTimeZoneMappings || {}, next.emailTimeZoneMappings || {}),
        emailCountries:        diffObjectList(current.emailCountries || [], next.emailCountries || [], 'Email', ['Country'])
    };
};

const diffStringList = (current, next) => {
    const curSet = new Set(current.filter(s => typeof s === 'string'));
    const nxtSet = new Set(next.filter(s => typeof s === 'string'));
    const add = [];
    const remove = [];
    for (const s of nxtSet) if (!curSet.has(s)) add.push(s);
    for (const s of curSet) if (!nxtSet.has(s)) remove.push(s);
    const unchanged = [...curSet].filter(s => nxtSet.has(s)).length;
    return { add: add.sort(), remove: remove.sort(), unchanged };
};

const diffObjectList = (current, next, keyField, compareFields) => {
    const curByKey = new Map();
    let curKeyless = 0;
    for (const e of current) {
        const k = keyString(e, keyField);
        if (k === undefined) { curKeyless++; continue; }
        curByKey.set(k, e);
    }
    const nxtByKey = new Map();
    for (const e of next) {
        const k = keyString(e, keyField);
        if (k === undefined) continue;
        nxtByKey.set(k, e);
    }

    const add = [];
    const remove = [];
    const changed = [];
    let unchanged = curKeyless; // keyless entries are, by definition, unchanged

    for (const [k, nxtE] of nxtByKey) {
        const curE = curByKey.get(k);
        if (!curE) { add.push(nxtE); continue; }
        const differs = compareFields.some(f => String(curE[f] ?? '') !== String(nxtE[f] ?? ''));
        if (differs) {
            changed.push({ before: curE, after: nxtE });
        } else {
            unchanged++;
        }
    }
    for (const [k, curE] of curByKey) {
        if (!nxtByKey.has(k)) remove.push(curE);
    }

    // Stable ordering for UI review.
    const cmp = (a, b) => String(a[keyField]).localeCompare(String(b[keyField]));
    add.sort(cmp);
    remove.sort(cmp);
    changed.sort((a, b) => cmp(a.after, b.after));

    return { add, remove, changed, unchanged };
};

const diffMap = (current, next) => {
    const add = {};
    const remove = [];
    const changed = {};
    let unchanged = 0;
    for (const [k, v] of Object.entries(next)) {
        if (!(k in current)) { add[k] = v; continue; }
        if (current[k] !== v) { changed[k] = { before: current[k], after: v }; }
        else unchanged++;
    }
    for (const k of Object.keys(current)) {
        if (!(k in next)) remove.push(k);
    }
    return { add, changed, remove: remove.sort(), unchanged };
};

// ---------------------------------------------------------------------------
// Sanity flags
// ---------------------------------------------------------------------------

const computeSanityFlags = (current, next) => {
    const sizeCurr = {
        excludedEmails: (current.excludedEmails || []).length,
        vipUsers:       (current.vipUsers || []).length,
        tz:             Object.keys(current.emailTimeZoneMappings || {}).length,
        countries:      (current.emailCountries || []).length
    };
    const sizeNext = {
        excludedEmails: (next.excludedEmails || []).length,
        vipUsers:       (next.vipUsers || []).length,
        tz:             Object.keys(next.emailTimeZoneMappings || {}).length,
        countries:      (next.emailCountries || []).length
    };

    const shrinkRatio = (before, after) => {
        if (before === 0) return 0;
        return Math.max(0, (before - after) / before);
    };
    const churnRatio = (before, after) => {
        const max = Math.max(before, after);
        if (max === 0) return 0;
        return Math.abs(before - after) / max;
    };

    const largeShrink =
        shrinkRatio(sizeCurr.excludedEmails, sizeNext.excludedEmails) > 0.20 ||
        shrinkRatio(sizeCurr.vipUsers,       sizeNext.vipUsers)       > 0.20 ||
        shrinkRatio(sizeCurr.tz,             sizeNext.tz)             > 0.20 ||
        shrinkRatio(sizeCurr.countries,      sizeNext.countries)      > 0.20;

    const largeChurn =
        churnRatio(sizeCurr.excludedEmails, sizeNext.excludedEmails) > 0.50 ||
        churnRatio(sizeCurr.vipUsers,       sizeNext.vipUsers)       > 0.50 ||
        churnRatio(sizeCurr.tz,             sizeNext.tz)             > 0.50 ||
        churnRatio(sizeCurr.countries,      sizeNext.countries)      > 0.50;

    return { largeShrink, largeChurn };
};

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

const unique = (xs) => Array.from(new Set(xs));

const keyString = (obj, field) => {
    if (obj === null || obj === undefined || typeof obj !== 'object') return undefined;
    const v = obj[field];
    if (v === undefined || v === null) return undefined;
    const s = String(v);
    return s === '' ? undefined : s;
};
