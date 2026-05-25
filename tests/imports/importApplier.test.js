/**
 * importApplier.test.js
 *
 * Test suite aligned with the Source-of-Truth Sync semantics.
 *
 * Business rules under test:
 *   1. The four managed arrays (excludedEmails, vipUsers, emailTimeZoneMappings,
 *      emailCountries) in nextSettings are ALWAYS an exact mirror of newImp.
 *      There is no concept of "manual preservation" — if an entry is absent
 *      from the incoming import, it is gone from settings.
 *   2. allowedCountries is NEVER touched by any import.
 *   3. Unknown top-level fields in currentSettings are forwarded verbatim
 *      (forward-compatibility).
 *   4. nextLastImport is a deep clone of newImp — mutating newImp afterwards
 *      must not corrupt the sidecar.
 *   5. nextLastImport records the correct mode and timestamp.
 *   6. previousImp is accepted as a parameter but plays NO role in the
 *      output arrays (it is retained in the signature for API stability).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { apply } from '../../services/imports/importApplier.js';
import { emptyLastImport } from '../../services/imports/snapshotManager.js';

const fixedNow = () => '2026-05-12T18:00:00.000Z';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const baseCurrent = () => ({
    excludedEmails: [],
    vipUsers: [],
    emailTimeZoneMappings: {},
    emailCountries: [],
    allowedCountries: ['BR', 'AR']
});

// ---------------------------------------------------------------------------
// Core source-of-truth: output == newImp, regardless of what was in current
// ---------------------------------------------------------------------------

test('first-ever import: newImp is written in full to nextSettings', () => {
    const current = baseCurrent();
    const newImp = {
        excludedEmails:        ['a@x.com'],
        vipUsers:              [{ name: 'Alice (SHS)' }],
        emailTimeZoneMappings: { 'a@x.com': 'US/Central' },
        emailCountries:        [{ Email: 'a@x.com', Country: 'BR' }]
    };
    const { nextSettings, nextLastImport } = apply(current, newImp, emptyLastImport(), { mode: 'external', now: fixedNow });

    assert.deepEqual(nextSettings.excludedEmails,        ['a@x.com']);
    assert.deepEqual(nextSettings.vipUsers,              [{ name: 'Alice (SHS)' }]);
    assert.deepEqual(nextSettings.emailTimeZoneMappings, { 'a@x.com': 'US/Central' });
    assert.deepEqual(nextSettings.emailCountries,        [{ Email: 'a@x.com', Country: 'BR' }]);
    assert.deepEqual(nextSettings.allowedCountries,      ['BR', 'AR']); // untouched
    assert.equal(nextLastImport.importedAt, '2026-05-12T18:00:00.000Z');
    assert.equal(nextLastImport.mode, 'external');
});

test('source-of-truth: entries present in current but absent from newImp are REMOVED', () => {
    // "Manual" or previously-imported entries that no longer appear in the
    // ServiceNow dump must be completely purged — no preservation.
    const current = {
        ...baseCurrent(),
        excludedEmails:        ['stale@x.com', 'also-stale@x.com'],
        vipUsers:              [{ name: 'Stale VIP' }],
        emailTimeZoneMappings: { 'stale@x.com': 'Europe/Berlin' },
        emailCountries:        [{ Email: 'stale@x.com', Country: 'MX' }]
    };
    const newImp = {
        excludedEmails:        [],
        vipUsers:              [],
        emailTimeZoneMappings: {},
        emailCountries:        []
    };
    const { nextSettings } = apply(current, newImp, emptyLastImport(), { mode: 'external', now: fixedNow });

    assert.deepEqual(nextSettings.excludedEmails,        []);
    assert.deepEqual(nextSettings.vipUsers,              []);
    assert.deepEqual(nextSettings.emailTimeZoneMappings, {});
    assert.deepEqual(nextSettings.emailCountries,        []);
});

test('source-of-truth: a partial refresh replaces the full array, not merges into it', () => {
    // Current has entries A and B; newImp only produces A with a new TZ.
    // Result must be exactly [A-updated], not [A-updated, B-preserved].
    const current = {
        ...baseCurrent(),
        excludedEmails:        ['a@x.com', 'b@x.com'],
        vipUsers:              [{ name: 'Alpha' }, { name: 'Beta' }],
        emailTimeZoneMappings: { 'a@x.com': 'US/Central', 'b@x.com': 'Europe/London' },
        emailCountries:        [
            { Email: 'a@x.com', Country: 'MX' },
            { Email: 'b@x.com', Country: 'BR' }
        ]
    };
    const newImp = {
        excludedEmails:        ['a@x.com'],
        vipUsers:              [{ name: 'Alpha' }],
        emailTimeZoneMappings: { 'a@x.com': 'America/New_York' }, // TZ updated
        emailCountries:        [{ Email: 'a@x.com', Country: 'CL' }] // Country updated
    };
    const { nextSettings } = apply(current, newImp, emptyLastImport(), { mode: 'external', now: fixedNow });

    assert.deepEqual(nextSettings.excludedEmails,        ['a@x.com']);
    assert.deepEqual(nextSettings.vipUsers,              [{ name: 'Alpha' }]);
    assert.equal(nextSettings.emailTimeZoneMappings['a@x.com'], 'America/New_York');
    assert.equal(Object.keys(nextSettings.emailTimeZoneMappings).length, 1,
        'b@x.com mapping must be gone — it is absent from newImp');
    assert.equal(nextSettings.emailCountries.length, 1);
    assert.deepEqual(nextSettings.emailCountries[0], { Email: 'a@x.com', Country: 'CL' });
});

test('source-of-truth: previousImp has no effect on the output arrays', () => {
    // Even if previousImp contains entries that are not in newImp,
    // the result must still equal newImp exactly.
    const current = {
        ...baseCurrent(),
        excludedEmails: ['prev@x.com', 'new@x.com']
    };
    const previousImp = {
        excludedEmails:        ['prev@x.com'],
        vipUsers:              [],
        emailTimeZoneMappings: {},
        emailCountries:        []
    };
    const newImp = {
        excludedEmails:        ['new@x.com'],
        vipUsers:              [],
        emailTimeZoneMappings: {},
        emailCountries:        []
    };
    const { nextSettings } = apply(current, newImp, previousImp, { mode: 'external', now: fixedNow });

    // Only 'new@x.com' must survive — 'prev@x.com' is absent from newImp.
    assert.deepEqual(nextSettings.excludedEmails, ['new@x.com']);
});

test('source-of-truth: re-import with identical data yields identical output', () => {
    const newImp = {
        excludedEmails:        ['a@x.com', 'b@x.com'],
        vipUsers:              [{ name: 'VIP A' }],
        emailTimeZoneMappings: { 'a@x.com': 'US/Central' },
        emailCountries:        [{ Email: 'a@x.com', Country: 'MX' }]
    };
    // Simulate settings already containing these entries after a prior apply.
    const current = { ...baseCurrent(), ...newImp };
    const { nextSettings } = apply(current, newImp, emptyLastImport(), { mode: 'external', now: fixedNow });

    assert.deepEqual(nextSettings.excludedEmails,        newImp.excludedEmails);
    assert.deepEqual(nextSettings.vipUsers,              newImp.vipUsers);
    assert.deepEqual(nextSettings.emailTimeZoneMappings, newImp.emailTimeZoneMappings);
    assert.deepEqual(nextSettings.emailCountries,        newImp.emailCountries);
});

// ---------------------------------------------------------------------------
// allowedCountries is always pinned
// ---------------------------------------------------------------------------

test('allowedCountries is never modified regardless of what newImp contains', () => {
    const current = { ...baseCurrent(), allowedCountries: ['BR', 'AR', 'CL'] };
    const newImp  = {
        excludedEmails:        ['x@x.com'],
        vipUsers:              [],
        emailTimeZoneMappings: {},
        emailCountries:        []
    };
    const { nextSettings } = apply(current, newImp, emptyLastImport(), { mode: 'external', now: fixedNow });
    assert.deepEqual(nextSettings.allowedCountries, ['BR', 'AR', 'CL']);
});

test('allowedCountries defaults to [] when absent from currentSettings', () => {
    const current = { excludedEmails: [], vipUsers: [], emailTimeZoneMappings: {}, emailCountries: [] };
    const newImp  = {
        excludedEmails: [], vipUsers: [], emailTimeZoneMappings: {}, emailCountries: []
    };
    const { nextSettings } = apply(current, newImp, emptyLastImport(), { mode: 'external', now: fixedNow });
    assert.deepEqual(nextSettings.allowedCountries, []);
});

// ---------------------------------------------------------------------------
// Forward-compatibility: unknown fields in currentSettings are preserved
// ---------------------------------------------------------------------------

test('unknown top-level fields in currentSettings are forwarded verbatim', () => {
    const current = { ...baseCurrent(), futureField: { hello: 'world' }, legacyFlag: true };
    const newImp  = {
        excludedEmails: [], vipUsers: [], emailTimeZoneMappings: {}, emailCountries: []
    };
    const { nextSettings } = apply(current, newImp, emptyLastImport(), { mode: 'external', now: fixedNow });
    assert.deepEqual(nextSettings.futureField, { hello: 'world' });
    assert.equal(nextSettings.legacyFlag, true);
});

// ---------------------------------------------------------------------------
// nextLastImport integrity
// ---------------------------------------------------------------------------

test('nextLastImport is a deep clone of newImp — mutating newImp does not corrupt it', () => {
    const newImp = {
        excludedEmails:        ['a@x.com'],
        vipUsers:              [{ name: 'V' }],
        emailTimeZoneMappings: { 'a@x.com': 'US/Central' },
        emailCountries:        [{ Email: 'a@x.com', Country: 'BR' }]
    };
    const { nextLastImport } = apply(baseCurrent(), newImp, emptyLastImport(), { mode: 'external', now: fixedNow });

    // Poison newImp after the call.
    newImp.excludedEmails.push('mutated@x.com');
    newImp.vipUsers[0].name = 'MUTATED';
    newImp.emailTimeZoneMappings['a@x.com'] = 'POISONED';
    newImp.emailCountries[0].Country = 'ZZ';

    assert.deepEqual(nextLastImport.excludedEmails,        ['a@x.com']);
    assert.equal(nextLastImport.vipUsers[0].name,          'V');
    assert.equal(nextLastImport.emailTimeZoneMappings['a@x.com'], 'US/Central');
    assert.equal(nextLastImport.emailCountries[0].Country, 'BR');
});

test('nextLastImport records mode and timestamp from opts', () => {
    const { nextLastImport } = apply(
        baseCurrent(),
        { excludedEmails: [], vipUsers: [], emailTimeZoneMappings: {}, emailCountries: [] },
        emptyLastImport(),
        { mode: 'internal', now: fixedNow }
    );
    assert.equal(nextLastImport.mode,       'internal');
    assert.equal(nextLastImport.importedAt, '2026-05-12T18:00:00.000Z');
});

test('nextLastImport mode defaults to null when opts.mode is omitted', () => {
    const { nextLastImport } = apply(
        baseCurrent(),
        { excludedEmails: [], vipUsers: [], emailTimeZoneMappings: {}, emailCountries: [] },
        emptyLastImport(),
        { now: fixedNow }
    );
    assert.equal(nextLastImport.mode, null);
});

// ---------------------------------------------------------------------------
// nextSettings deep-clone guarantee: mutating it must not corrupt nextLastImport
// ---------------------------------------------------------------------------

test('nextSettings arrays are independent copies — mutating them does not affect nextLastImport', () => {
    const newImp = {
        excludedEmails:        ['a@x.com'],
        vipUsers:              [{ name: 'V' }],
        emailTimeZoneMappings: { 'a@x.com': 'US/Central' },
        emailCountries:        [{ Email: 'a@x.com', Country: 'BR' }]
    };
    const { nextSettings, nextLastImport } = apply(baseCurrent(), newImp, emptyLastImport(), { mode: 'external', now: fixedNow });

    nextSettings.excludedEmails.push('poison@x.com');
    nextSettings.vipUsers[0].name = 'POISON';

    assert.deepEqual(nextLastImport.excludedEmails, ['a@x.com']);
    assert.equal(nextLastImport.vipUsers[0].name,   'V');
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test('apply with completely empty newImp produces all-empty arrays in nextSettings', () => {
    const current = {
        ...baseCurrent(),
        excludedEmails:        ['a@x.com', 'b@x.com'],
        vipUsers:              [{ name: 'Someone' }],
        emailTimeZoneMappings: { 'a@x.com': 'US/Central' },
        emailCountries:        [{ Email: 'a@x.com', Country: 'BR' }]
    };
    const newImp = {
        excludedEmails: [], vipUsers: [], emailTimeZoneMappings: {}, emailCountries: []
    };
    const { nextSettings } = apply(current, newImp, emptyLastImport(), { mode: 'external', now: fixedNow });
    assert.deepEqual(nextSettings.excludedEmails,        []);
    assert.deepEqual(nextSettings.vipUsers,              []);
    assert.deepEqual(nextSettings.emailTimeZoneMappings, {});
    assert.deepEqual(nextSettings.emailCountries,        []);
});

test('apply handles missing fields in newImp gracefully (defaults to empty)', () => {
    // If the caller omits one of the managed fields, it must default to empty.
    const { nextSettings } = apply(baseCurrent(), {}, emptyLastImport(), { mode: 'external', now: fixedNow });
    assert.deepEqual(nextSettings.excludedEmails,        []);
    assert.deepEqual(nextSettings.vipUsers,              []);
    assert.deepEqual(nextSettings.emailTimeZoneMappings, {});
    assert.deepEqual(nextSettings.emailCountries,        []);
});

test('apply handles multiple VIP entries with deduplicated names correctly', () => {
    const newImp = {
        excludedEmails:        [],
        vipUsers:              [{ name: 'Alice' }, { name: 'Bob' }, { name: 'Alice' }], // duplicate
        emailTimeZoneMappings: {},
        emailCountries:        []
    };
    // The applier writes exactly what it receives — deduplication is the
    // planner's responsibility, not the applier's.
    const { nextSettings } = apply(baseCurrent(), newImp, emptyLastImport(), { mode: 'external', now: fixedNow });
    assert.deepEqual(nextSettings.vipUsers, [{ name: 'Alice' }, { name: 'Bob' }, { name: 'Alice' }]);
});
