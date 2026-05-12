/**
 * Import applier - the pure merge function at the core of v1.
 *
 * Input:
 *   currentSettings  - the live settings object (as returned by settingsService.getSettings)
 *   newImp           - the `imported` section of an ImportPlan (what THIS import contributes)
 *   previousImp      - the last-import sidecar (what the PREVIOUS import contributed;
 *                      empty-shape on first-ever import)
 *
 * Output:
 *   nextSettings     - the new settings object to persist
 *   nextLastImport   - the new sidecar content
 *
 * Merge semantics (identical for every field, implemented with key-specific helpers):
 *
 *   manual = current entries whose KEY is NOT in keys(previousImp)
 *   next   = manual ∪ newImp           // import wins on shared key
 *
 * Rationale: entries the operator added manually since the last import are
 * preserved; entries the last import wrote are candidates for refresh;
 * entries with no detectable key (the historical `{}` sentinel in
 * `emailCountries`) are always kept as manual.
 *
 * `allowedCountries` is never touched.
 *
 * Pure module. No I/O, no wall-clock reads (the caller passes `now`).
 */

const EMPTY_IMPORT = Object.freeze({
    excludedEmails: [],
    vipUsers: [],
    emailTimeZoneMappings: {},
    emailCountries: []
});

/**
 * @param {object} currentSettings
 * @param {object} newImp
 * @param {object} previousImp
 * @param {object} [opts]
 * @param {string} [opts.mode] - 'external' | 'internal' (recorded in sidecar)
 * @param {() => string} [opts.now] - ISO-string factory, for deterministic tests
 * @returns {{ nextSettings: object, nextLastImport: object }}
 */
export const apply = (currentSettings, newImp, previousImp = EMPTY_IMPORT, opts = {}) => {
    const mode = opts.mode || null;
    const now = opts.now || (() => new Date().toISOString());

    const prev = withDefaults(previousImp);
    const next = withDefaults(newImp);

    const nextSettings = {
        // Preserve any extra top-level fields we don't know about (forward-compat).
        ...currentSettings,
        excludedEmails:        mergeStringList(currentSettings.excludedEmails || [],   prev.excludedEmails, next.excludedEmails),
        vipUsers:              mergeObjectList(currentSettings.vipUsers || [],         prev.vipUsers,       next.vipUsers,       'name'),
        emailTimeZoneMappings: mergeMap(currentSettings.emailTimeZoneMappings || {},   prev.emailTimeZoneMappings, next.emailTimeZoneMappings),
        emailCountries:        mergeObjectList(currentSettings.emailCountries || [],   prev.emailCountries, next.emailCountries, 'Email'),
        // explicitly pinned: never touched by imports
        allowedCountries:      currentSettings.allowedCountries || []
    };

    const nextLastImport = {
        importedAt:            now(),
        mode,
        excludedEmails:        next.excludedEmails.slice(),
        vipUsers:              next.vipUsers.map(v => ({ ...v })),
        emailTimeZoneMappings: { ...next.emailTimeZoneMappings },
        emailCountries:        next.emailCountries.map(v => ({ ...v }))
    };

    return { nextSettings, nextLastImport };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const withDefaults = (imp) => ({
    excludedEmails:        imp.excludedEmails        || [],
    vipUsers:              imp.vipUsers              || [],
    emailTimeZoneMappings: imp.emailTimeZoneMappings || {},
    emailCountries:        imp.emailCountries        || []
});

/**
 * Merge a string[] field with the "manual preserved, import wins" rule.
 */
const mergeStringList = (current, previousImp, newImp) => {
    const previousSet = new Set(previousImp);
    const newSet = new Set(newImp);

    const out = [];
    const seen = new Set();
    // Keep only manual entries from current (dedupe preserved).
    for (const s of current) {
        if (typeof s !== 'string') continue;
        if (previousSet.has(s)) continue;   // previously imported; let the new import decide
        if (newSet.has(s)) continue;        // will be added below; avoid duplication
        if (seen.has(s)) continue;
        seen.add(s);
        out.push(s);
    }
    // Append new imports.
    for (const s of newImp) {
        if (typeof s !== 'string') continue;
        if (seen.has(s)) continue;
        seen.add(s);
        out.push(s);
    }
    return out;
};

/**
 * Merge an array of objects keyed by `keyField`. Entries with missing or
 * non-string key are treated as "always manual" and preserved verbatim.
 */
const mergeObjectList = (current, previousImp, newImp, keyField) => {
    const previousKeys = new Set();
    for (const e of previousImp) {
        const k = keyOf(e, keyField);
        if (k !== undefined) previousKeys.add(k);
    }
    const newByKey = new Map();
    for (const e of newImp) {
        const k = keyOf(e, keyField);
        if (k === undefined) continue;
        if (!newByKey.has(k)) newByKey.set(k, e);
    }

    const out = [];
    const claimedKeys = new Set();

    // Manual entries first (order preserved).
    for (const e of current) {
        const k = keyOf(e, keyField);
        if (k === undefined) {
            // No detectable key (e.g. the historical `{}` in emailCountries).
            // Always manual. Preserve verbatim.
            out.push(e);
            continue;
        }
        if (previousKeys.has(k)) continue;   // previously imported; drop, new import decides
        if (newByKey.has(k)) continue;        // import wins on collision with manual
        if (claimedKeys.has(k)) continue;     // dedupe within current
        claimedKeys.add(k);
        out.push(e);
    }

    // Then the new import (stable order = newImp order).
    for (const e of newImp) {
        const k = keyOf(e, keyField);
        if (k === undefined) continue;
        if (claimedKeys.has(k)) continue;
        claimedKeys.add(k);
        out.push(e);
    }

    return out;
};

/**
 * Merge an object-shaped map {key: value} (used by emailTimeZoneMappings).
 */
const mergeMap = (current, previousImp, newImp) => {
    const previousKeys = new Set(Object.keys(previousImp));

    const out = {};
    for (const [k, v] of Object.entries(current)) {
        if (previousKeys.has(k)) continue; // previously imported; new import decides
        out[k] = v;
    }
    // Import wins on collision.
    for (const [k, v] of Object.entries(newImp)) {
        out[k] = v;
    }
    return out;
};

const keyOf = (obj, field) => {
    if (obj === null || obj === undefined || typeof obj !== 'object') return undefined;
    const v = obj[field];
    if (v === undefined || v === null) return undefined;
    const s = String(v);
    return s === '' ? undefined : s;
};
