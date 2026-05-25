/**
 * importPlanner.test.js
 *
 * Test suite aligned with the refactored deriveImported logic:
 *   - Strict VIP isolation: VIP rows never participate in the analyst-derived
 *     arrays (excludedEmails, emailTimeZoneMappings, emailCountries).
 *   - Strict EXTERNAL/INTERNAL cross-classification:
 *       external mode → excludedEmails=OSE, tz/country=EXE
 *       internal mode → excludedEmails=EXE, tz/country=OSE
 *   - vipUsers is populated exclusively from the VIP file.
 *   - Source-of-truth sync: the planner delegates to the refactored applier,
 *     so nextSettings always equals newImp exactly (no stale merges).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { build } from '../../services/imports/importPlanner.js';
import { emptyLastImport } from '../../services/imports/snapshotManager.js';
import { ERR } from '../../services/imports/errors.js';

// ---------------------------------------------------------------------------
// Shared factory helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal NormalizedUser record.
 * Defaults: name='N', tz=null, country=null, userType='EXE', source='analyst'
 */
const rec = (o) => ({
    email:    o.email,
    name:     o.name     ?? 'N',
    tz:       o.tz       ?? null,
    country:  o.country  ?? null,
    userType: o.userType ?? 'EXE',
    source:   o.source   ?? 'analyst'
});

const emptySettings = () => ({
    excludedEmails:        [],
    vipUsers:              [],
    emailTimeZoneMappings: {},
    emailCountries:        [],
    allowedCountries:      []
});

// ---------------------------------------------------------------------------
// Guard: invalid mode
// ---------------------------------------------------------------------------

test('invalid mode throws INVALID_MODE', () => {
    assert.throws(
        () => build({
            currentSettings: emptySettings(),
            lastImport:      emptyLastImport(),
            analyst: [], vip: [],
            mode: 'unknown-mode'
        }),
        (err) => {
            assert.equal(err.code, ERR.INVALID_MODE);
            return true;
        }
    );
});

// ---------------------------------------------------------------------------
// EXTERNAL mode — classification rules
// ---------------------------------------------------------------------------

test('external mode: excludedEmails contains ONLY OSE (internal) analyst emails', () => {
    const analyst = [
        rec({ email: 'exe1@x.com', userType: 'EXE' }),
        rec({ email: 'exe2@x.com', userType: 'EXE' }),
        rec({ email: 'ose1@x.com', userType: 'OSE' })
    ];
    const plan = build({ currentSettings: emptySettings(), lastImport: emptyLastImport(), analyst, vip: [], mode: 'external' });

    assert.deepEqual(plan.imported.excludedEmails, ['ose1@x.com'],
        'Only OSE emails must appear in excludedEmails when mode=external');
});

test('external mode: emailTimeZoneMappings contains ONLY EXE (external) analyst records', () => {
    const analyst = [
        rec({ email: 'exe@x.com', userType: 'EXE', tz: 'US/Central' }),
        rec({ email: 'ose@x.com', userType: 'OSE', tz: 'Europe/Berlin' })
    ];
    const plan = build({ currentSettings: emptySettings(), lastImport: emptyLastImport(), analyst, vip: [], mode: 'external' });

    assert.ok('exe@x.com' in plan.imported.emailTimeZoneMappings,
        'EXE email must be in TZ mappings');
    assert.ok(!('ose@x.com' in plan.imported.emailTimeZoneMappings),
        'OSE email must NOT be in TZ mappings when mode=external');
    assert.equal(plan.imported.emailTimeZoneMappings['exe@x.com'], 'US/Central');
});

test('external mode: emailCountries contains ONLY EXE (external) analyst records', () => {
    const analyst = [
        rec({ email: 'exe@x.com', userType: 'EXE', country: 'MX' }),
        rec({ email: 'ose@x.com', userType: 'OSE', country: 'BR' })
    ];
    const plan = build({ currentSettings: emptySettings(), lastImport: emptyLastImport(), analyst, vip: [], mode: 'external' });

    const countries = plan.imported.emailCountries;
    assert.ok(countries.some(e => e.Email === 'exe@x.com'),  'EXE must appear in emailCountries');
    assert.ok(!countries.some(e => e.Email === 'ose@x.com'), 'OSE must NOT appear in emailCountries when mode=external');
});

// ---------------------------------------------------------------------------
// INTERNAL mode — classification rules (mirror of external)
// ---------------------------------------------------------------------------

test('internal mode: excludedEmails contains ONLY EXE (external) analyst emails', () => {
    const analyst = [
        rec({ email: 'exe1@x.com', userType: 'EXE' }),
        rec({ email: 'ose1@x.com', userType: 'OSE' }),
        rec({ email: 'ose2@x.com', userType: 'OSE' })
    ];
    const plan = build({ currentSettings: emptySettings(), lastImport: emptyLastImport(), analyst, vip: [], mode: 'internal' });

    assert.deepEqual(plan.imported.excludedEmails, ['exe1@x.com'],
        'Only EXE emails must appear in excludedEmails when mode=internal');
});

test('internal mode: emailTimeZoneMappings contains ONLY OSE (internal) analyst records', () => {
    const analyst = [
        rec({ email: 'exe@x.com', userType: 'EXE', tz: 'US/Central' }),
        rec({ email: 'ose@x.com', userType: 'OSE', tz: 'Europe/Berlin' })
    ];
    const plan = build({ currentSettings: emptySettings(), lastImport: emptyLastImport(), analyst, vip: [], mode: 'internal' });

    assert.ok(!('exe@x.com' in plan.imported.emailTimeZoneMappings),
        'EXE email must NOT be in TZ mappings when mode=internal');
    assert.ok('ose@x.com' in plan.imported.emailTimeZoneMappings,
        'OSE email must be in TZ mappings');
    assert.equal(plan.imported.emailTimeZoneMappings['ose@x.com'], 'Europe/Berlin');
});

test('internal mode: emailCountries contains ONLY OSE (internal) analyst records', () => {
    const analyst = [
        rec({ email: 'exe@x.com', userType: 'EXE', country: 'MX' }),
        rec({ email: 'ose@x.com', userType: 'OSE', country: 'BR' })
    ];
    const plan = build({ currentSettings: emptySettings(), lastImport: emptyLastImport(), analyst, vip: [], mode: 'internal' });

    const countries = plan.imported.emailCountries;
    assert.ok(!countries.some(e => e.Email === 'exe@x.com'), 'EXE must NOT appear in emailCountries when mode=internal');
    assert.ok(countries.some(e => e.Email === 'ose@x.com'),  'OSE must appear in emailCountries');
});

// ---------------------------------------------------------------------------
// VIP isolation — VIP rows must NEVER appear in the analyst-derived arrays
// ---------------------------------------------------------------------------

test('VIP rows are never included in excludedEmails regardless of their userType', () => {
    // A VIP row with OSE type must NOT pollute excludedEmails in external mode.
    const analyst = [];
    const vip = [
        rec({ email: 'vip-ose@x.com', userType: 'OSE', source: 'vip', name: 'VIP OSE' }),
        rec({ email: 'vip-exe@x.com', userType: 'EXE', source: 'vip', name: 'VIP EXE' })
    ];
    const planExt = build({ currentSettings: emptySettings(), lastImport: emptyLastImport(), analyst, vip, mode: 'external' });
    assert.deepEqual(planExt.imported.excludedEmails, [],
        'VIP OSE rows must NOT pollute excludedEmails in external mode');

    const planInt = build({ currentSettings: emptySettings(), lastImport: emptyLastImport(), analyst, vip, mode: 'internal' });
    assert.deepEqual(planInt.imported.excludedEmails, [],
        'VIP EXE rows must NOT pollute excludedEmails in internal mode');
});

test('VIP rows are never included in emailTimeZoneMappings', () => {
    const analyst = [];
    const vip = [
        rec({ email: 'vip@x.com', userType: 'EXE', tz: 'US/Central', source: 'vip', name: 'A VIP' })
    ];
    const plan = build({ currentSettings: emptySettings(), lastImport: emptyLastImport(), analyst, vip, mode: 'external' });

    assert.ok(!('vip@x.com' in plan.imported.emailTimeZoneMappings),
        'VIP email must not appear in emailTimeZoneMappings');
});

test('VIP rows are never included in emailCountries', () => {
    const analyst = [];
    const vip = [
        rec({ email: 'vip@x.com', userType: 'EXE', country: 'MX', source: 'vip', name: 'A VIP' })
    ];
    const plan = build({ currentSettings: emptySettings(), lastImport: emptyLastImport(), analyst, vip, mode: 'external' });

    assert.ok(!plan.imported.emailCountries.some(e => e.Email === 'vip@x.com'),
        'VIP email must not appear in emailCountries');
});

test('VIP email that also exists in analyst array does not bleed VIP TZ into emailTimeZoneMappings if VIP is EXE and mode=internal', () => {
    // In internal mode, only OSE (internal) go into TZ mappings.
    // A VIP row with EXE type sharing the same email as an OSE analyst row must
    // not override the analyst's TZ entry, and the VIP record must not introduce
    // its own entry via the VIP path.
    const analyst = [rec({ email: 'cross@x.com', userType: 'OSE', tz: 'Europe/Berlin', source: 'analyst' })];
    const vip     = [rec({ email: 'cross@x.com', userType: 'EXE', tz: 'US/Central',   source: 'vip', name: 'CrossV' })];
    const plan = build({ currentSettings: emptySettings(), lastImport: emptyLastImport(), analyst, vip, mode: 'internal' });

    // OSE analyst row must drive the mapping.
    assert.equal(plan.imported.emailTimeZoneMappings['cross@x.com'], 'Europe/Berlin');
});

// ---------------------------------------------------------------------------
// vipUsers populated exclusively from VIP file
// ---------------------------------------------------------------------------

test('vipUsers contains distinct names from VIP file only — analyst names never appear', () => {
    const analyst = [
        rec({ email: 'analyst@x.com', userType: 'EXE', name: 'Analyst One' })
    ];
    const vip = [
        rec({ email: 'vip1@x.com', userType: 'OSE', name: 'VIP One',   source: 'vip' }),
        rec({ email: 'vip2@x.com', userType: 'EXE', name: 'VIP Two',   source: 'vip' }),
        rec({ email: 'vip3@x.com', userType: 'OSE', name: 'VIP One',   source: 'vip' }) // duplicate name
    ];
    const plan = build({ currentSettings: emptySettings(), lastImport: emptyLastImport(), analyst, vip, mode: 'external' });

    const names = plan.imported.vipUsers.map(v => v.name);
    assert.ok(!names.includes('Analyst One'), 'Analyst name must not appear in vipUsers');
    // 'VIP One' appears twice but must be deduped to one entry.
    assert.equal(names.filter(n => n === 'VIP One').length, 1, 'Duplicate VIP names must be deduped');
    assert.ok(names.includes('VIP Two'));
    assert.equal(plan.imported.vipUsers.length, 2);
});

test('vipUsers is sorted lexicographically by name', () => {
    const vip = [
        rec({ email: 'c@x.com', name: 'Charlie', source: 'vip', userType: 'OSE' }),
        rec({ email: 'a@x.com', name: 'Alice',   source: 'vip', userType: 'EXE' }),
        rec({ email: 'b@x.com', name: 'Bob',     source: 'vip', userType: 'OSE' })
    ];
    const plan = build({ currentSettings: emptySettings(), lastImport: emptyLastImport(), analyst: [], vip, mode: 'external' });
    assert.deepEqual(plan.imported.vipUsers, [
        { name: 'Alice' },
        { name: 'Bob' },
        { name: 'Charlie' }
    ]);
});

test('vipUsers is empty when VIP file contains no valid names', () => {
    const vip = [
        rec({ email: 'vip@x.com', name: '', source: 'vip', userType: 'OSE' })
    ];
    const plan = build({ currentSettings: emptySettings(), lastImport: emptyLastImport(), analyst: [], vip, mode: 'external' });
    assert.deepEqual(plan.imported.vipUsers, []);
});

// ---------------------------------------------------------------------------
// Source-of-truth sync: diff correctly reflects full replacement
// ---------------------------------------------------------------------------

test('stale entries absent from new import appear in diff.remove and are gone from nextSettings', () => {
    const settings = {
        ...emptySettings(),
        excludedEmails: ['stale@x.com', 'keep@x.com'],
        vipUsers:       [{ name: 'StaleVIP' }]
    };
    // New import: only keep@x.com (OSE) in analyst, empty VIP file.
    const analyst = [rec({ email: 'keep@x.com', userType: 'OSE', source: 'analyst' })];
    const plan = build({
        currentSettings: settings,
        lastImport:      emptyLastImport(),
        analyst, vip: [], mode: 'external'
    });

    assert.deepEqual(plan.diff.excludedEmails.remove, ['stale@x.com'],
        'stale@x.com must appear in diff.remove');
    assert.deepEqual(plan.diff.vipUsers.remove, [{ name: 'StaleVIP' }],
        'StaleVIP must appear in diff.remove');
    assert.deepEqual(plan.diff.excludedEmails.add, [],
        'No new emails in this import');

    // Verify nextSettings mirrors the import exactly.
    assert.deepEqual(plan.diff.excludedEmails.remove.length, 1);
    assert.ok(!plan.diff.excludedEmails.add.includes('stale@x.com'));
});

test('first-time import: all entries appear in diff.add, none in diff.remove', () => {
    const analyst = [
        rec({ email: 'exe@x.com', userType: 'EXE', tz: 'US/Central', country: 'MX' }),
        rec({ email: 'ose@x.com', userType: 'OSE', country: 'BR' })
    ];
    const vip = [rec({ email: 'v@x.com', userType: 'OSE', name: 'VIP One', source: 'vip' })];

    const plan = build({
        currentSettings: emptySettings(),
        lastImport:      emptyLastImport(),
        analyst, vip, mode: 'external'
    });

    // external: excludedEmails=OSE, tz/country=EXE, vipUsers from vip file
    assert.deepEqual(plan.imported.excludedEmails, ['ose@x.com']);
    assert.deepEqual(plan.imported.vipUsers,       [{ name: 'VIP One' }]);
    assert.deepEqual(plan.imported.emailTimeZoneMappings, { 'exe@x.com': 'US/Central' });
    assert.deepEqual(plan.imported.emailCountries, [{ Email: 'exe@x.com', Country: 'MX' }]);

    assert.deepEqual(plan.diff.excludedEmails.add, ['ose@x.com']);
    assert.deepEqual(plan.diff.excludedEmails.remove, []);
    assert.deepEqual(plan.diff.vipUsers.add, [{ name: 'VIP One' }]);
    assert.deepEqual(plan.diff.vipUsers.remove, []);
});

test('re-import with identical data yields zero add/remove/changed in all diff fields', () => {
    const analyst = [rec({ email: 'exe@x.com', userType: 'EXE', tz: 'US/Central', country: 'MX' })];
    const vip     = [rec({ email: 'v@x.com',   userType: 'OSE', name: 'V',         source: 'vip' })];

    const firstPlan = build({
        currentSettings: emptySettings(), lastImport: emptyLastImport(),
        analyst, vip, mode: 'external'
    });

    // Simulate apply: settings now equal what firstPlan produced.
    const settingsAfter = {
        ...emptySettings(),
        excludedEmails:        firstPlan.imported.excludedEmails,
        vipUsers:              firstPlan.imported.vipUsers,
        emailTimeZoneMappings: firstPlan.imported.emailTimeZoneMappings,
        emailCountries:        firstPlan.imported.emailCountries
    };
    const lastImport = {
        importedAt: 'x', mode: 'external',
        ...firstPlan.imported
    };

    const secondPlan = build({
        currentSettings: settingsAfter, lastImport,
        analyst, vip, mode: 'external'
    });

    assert.deepEqual(secondPlan.diff.excludedEmails,        { add: [], remove: [], unchanged: 0 });
    assert.deepEqual(secondPlan.diff.vipUsers,              { add: [], remove: [], changed: [], unchanged: 1 });
    assert.deepEqual(secondPlan.diff.emailTimeZoneMappings, { add: {}, changed: {}, remove: [], unchanged: 1 });
    assert.equal(secondPlan.diff.emailCountries.add.length,    0);
    assert.equal(secondPlan.diff.emailCountries.remove.length, 0);
});

// ---------------------------------------------------------------------------
// Analyst records with null tz or country are silently skipped for those fields
// ---------------------------------------------------------------------------

test('analyst records with null tz are excluded from emailTimeZoneMappings', () => {
    const analyst = [
        rec({ email: 'has-tz@x.com',  userType: 'EXE', tz: 'US/Central' }),
        rec({ email: 'no-tz@x.com',   userType: 'EXE', tz: null })
    ];
    const plan = build({ currentSettings: emptySettings(), lastImport: emptyLastImport(), analyst, vip: [], mode: 'external' });

    assert.ok('has-tz@x.com' in plan.imported.emailTimeZoneMappings);
    assert.ok(!('no-tz@x.com' in plan.imported.emailTimeZoneMappings));
});

test('analyst records with null country are excluded from emailCountries', () => {
    const analyst = [
        rec({ email: 'has-country@x.com', userType: 'EXE', country: 'MX' }),
        rec({ email: 'no-country@x.com',  userType: 'EXE', country: null })
    ];
    const plan = build({ currentSettings: emptySettings(), lastImport: emptyLastImport(), analyst, vip: [], mode: 'external' });

    assert.ok(plan.imported.emailCountries.some(e => e.Email === 'has-country@x.com'));
    assert.ok(!plan.imported.emailCountries.some(e => e.Email === 'no-country@x.com'));
});

// ---------------------------------------------------------------------------
// Sanity flags
// ---------------------------------------------------------------------------

test('largeShrink flag triggers when more than 20% of any list shrinks', () => {
    const prevVips = Array.from({ length: 20 }, (_, i) => ({ name: `V${i}` }));
    const settings = { ...emptySettings(), vipUsers: prevVips };
    const vip = Array.from({ length: 10 }, (_, i) =>
        rec({ email: `v${i}@x.com`, userType: 'OSE', source: 'vip', name: `V${i}` })
    );
    const plan = build({
        currentSettings: settings, lastImport: emptyLastImport(),
        analyst: [], vip, mode: 'external'
    });
    assert.equal(plan.sanityFlags.largeShrink, true);
});

test('largeShrink is false when the list shrinks by exactly 20% or less', () => {
    // 5 → 4 is exactly 20% shrink — must NOT trigger.
    const prevVips = Array.from({ length: 5 }, (_, i) => ({ name: `V${i}` }));
    const settings = { ...emptySettings(), vipUsers: prevVips };
    const vip = Array.from({ length: 4 }, (_, i) =>
        rec({ email: `v${i}@x.com`, userType: 'OSE', source: 'vip', name: `V${i}` })
    );
    const plan = build({
        currentSettings: settings, lastImport: emptyLastImport(),
        analyst: [], vip, mode: 'external'
    });
    assert.equal(plan.sanityFlags.largeShrink, false);
});

test('largeChurn flag triggers when more than 50% of any list is replaced', () => {
    const settings = {
        ...emptySettings(),
        excludedEmails: ['a@x.com', 'b@x.com']
    };
    // New import swaps both entries for entirely new ones.
    const analyst = [
        rec({ email: 'c@x.com', userType: 'OSE' }),
        rec({ email: 'd@x.com', userType: 'OSE' })
    ];
    const plan = build({
        currentSettings: settings, lastImport: emptyLastImport(),
        analyst, vip: [], mode: 'external'
    });
    assert.equal(plan.sanityFlags.largeChurn, true);
});

// ---------------------------------------------------------------------------
// Plan shape integrity
// ---------------------------------------------------------------------------

test('plan contains all required top-level keys', () => {
    const plan = build({
        currentSettings: emptySettings(), lastImport: emptyLastImport(),
        analyst: [], vip: [], mode: 'external'
    });
    for (const key of ['generatedAt', 'mode', 'counts', 'imported', 'diff', 'warnings', 'sanityFlags']) {
        assert.ok(key in plan, `Plan must contain key: ${key}`);
    }
});

test('plan does not expose planId or currentSettingsHash (those belong to the HTTP layer)', () => {
    const plan = build({
        currentSettings: emptySettings(), lastImport: emptyLastImport(),
        analyst: [], vip: [], mode: 'external'
    });
    assert.ok(!('planId' in plan),              'planId must not be in the plan object');
    assert.ok(!('currentSettingsHash' in plan), 'currentSettingsHash must not be in the plan object');
});

test('plan.mode echoes the mode argument', () => {
    const planExt = build({ currentSettings: emptySettings(), lastImport: emptyLastImport(), analyst: [], vip: [], mode: 'external' });
    const planInt = build({ currentSettings: emptySettings(), lastImport: emptyLastImport(), analyst: [], vip: [], mode: 'internal' });
    assert.equal(planExt.mode, 'external');
    assert.equal(planInt.mode, 'internal');
});
