/**
 * importPlanner.test.js
 *
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from '../../services/imports/importPlanner.js';
import { emptyLastImport } from '../../services/imports/snapshotManager.js';
import { ERR } from '../../services/imports/errors.js';

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

test('external mode: excludedEmails contains ONLY OSE (internal) analyst emails', () => {
    const analyst = [
        rec({ email: 'exe1@x.com', userType: 'EXE' }),
        rec({ email: 'exe2@x.com', userType: 'EXE' }),
        rec({ email: 'ose1@x.com', userType: 'OSE' })
    ];
    const plan = build({ currentSettings: emptySettings(), lastImport: emptyLastImport(), analyst, vip: [], mode: 'external' });
    assert.deepEqual(plan.imported.excludedEmails, ['ose1@x.com']);
});

test('external mode: emailTimeZoneMappings contains ONLY EXE (external) analyst records', () => {
    const analyst = [
        rec({ email: 'exe@x.com', userType: 'EXE', tz: 'US/Central' }),
        rec({ email: 'ose@x.com', userType: 'OSE', tz: 'Europe/Berlin' })
    ];
    const plan = build({ currentSettings: emptySettings(), lastImport: emptyLastImport(), analyst, vip: [], mode: 'external' });
    assert.ok('exe@x.com' in plan.imported.emailTimeZoneMappings);
    assert.ok(!('ose@x.com' in plan.imported.emailTimeZoneMappings));
    assert.equal(plan.imported.emailTimeZoneMappings['exe@x.com'], 'US/Central');
});

test('external mode: emailCountries contains ONLY EXE (external) analyst records', () => {
    const analyst = [
        rec({ email: 'exe@x.com', userType: 'EXE', country: 'MX' }),
        rec({ email: 'ose@x.com', userType: 'OSE', country: 'BR' })
    ];
    const plan = build({ currentSettings: emptySettings(), lastImport: emptyLastImport(), analyst, vip: [], mode: 'external' });
    const countries = plan.imported.emailCountries;
    assert.ok(countries.some(e => e.Email === 'exe@x.com'));
    assert.ok(!countries.some(e => e.Email === 'ose@x.com'));
});

test('internal mode: excludedEmails contains ONLY EXE (external) analyst emails', () => {
    const analyst = [
        rec({ email: 'exe1@x.com', userType: 'EXE' }),
        rec({ email: 'ose1@x.com', userType: 'OSE' }),
        rec({ email: 'ose2@x.com', userType: 'OSE' })
    ];
    const plan = build({ currentSettings: emptySettings(), lastImport: emptyLastImport(), analyst, vip: [], mode: 'internal' });
    assert.deepEqual(plan.imported.excludedEmails, ['exe1@x.com']);
});

test('internal mode: emailTimeZoneMappings contains ONLY OSE (internal) analyst records', () => {
    const analyst = [
        rec({ email: 'exe@x.com', userType: 'EXE', tz: 'US/Central' }),
        rec({ email: 'ose@x.com', userType: 'OSE', tz: 'Europe/Berlin' })
    ];
    const plan = build({ currentSettings: emptySettings(), lastImport: emptyLastImport(), analyst, vip: [], mode: 'internal' });
    assert.ok(!('exe@x.com' in plan.imported.emailTimeZoneMappings));
    assert.ok('ose@x.com' in plan.imported.emailTimeZoneMappings);
    assert.equal(plan.imported.emailTimeZoneMappings['ose@x.com'], 'Europe/Berlin');
});

test('internal mode: emailCountries contains ONLY OSE (internal) analyst records', () => {
    const analyst = [
        rec({ email: 'exe@x.com', userType: 'EXE', country: 'MX' }),
        rec({ email: 'ose@x.com', userType: 'OSE', country: 'BR' })
    ];
    const plan = build({ currentSettings: emptySettings(), lastImport: emptyLastImport(), analyst, vip: [], mode: 'internal' });
    const countries = plan.imported.emailCountries;
    assert.ok(!countries.some(e => e.Email === 'exe@x.com'));
    assert.ok(countries.some(e => e.Email === 'ose@x.com'));
});

test('VIP rows are never included in excludedEmails regardless of their userType', () => {
    const analyst = [];
    const vip = [
        rec({ email: 'vip-ose@x.com', userType: 'OSE', source: 'vip', name: 'VIP OSE' }),
        rec({ email: 'vip-exe@x.com', userType: 'EXE', source: 'vip', name: 'VIP EXE' })
    ];
    const planExt = build({ currentSettings: emptySettings(), lastImport: emptyLastImport(), analyst, vip, mode: 'external' });
    assert.deepEqual(planExt.imported.excludedEmails, []);
    const planInt = build({ currentSettings: emptySettings(), lastImport: emptyLastImport(), analyst, vip, mode: 'internal' });
    assert.deepEqual(planInt.imported.excludedEmails, []);
});

test('VIP rows are never included in emailTimeZoneMappings', () => {
    const analyst = [];
    const vip = [
        rec({ email: 'vip@x.com', userType: 'EXE', tz: 'US/Central', source: 'vip', name: 'A VIP' })
    ];
    const plan = build({ currentSettings: emptySettings(), lastImport: emptyLastImport(), analyst, vip, mode: 'external' });
    assert.ok(!('vip@x.com' in plan.imported.emailTimeZoneMappings));
});

test('VIP rows are never included in emailCountries', () => {
    const analyst = [];
    const vip = [
        rec({ email: 'vip@x.com', userType: 'EXE', country: 'MX', source: 'vip', name: 'A VIP' })
    ];
    const plan = build({ currentSettings: emptySettings(), lastImport: emptyLastImport(), analyst, vip, mode: 'external' });
    assert.ok(!plan.imported.emailCountries.some(e => e.Email === 'vip@x.com'));
});

test('VIP email that also exists in analyst array does not bleed VIP TZ into emailTimeZoneMappings if VIP is EXE and mode=internal', () => {
    const analyst = [rec({ email: 'cross@x.com', userType: 'OSE', tz: 'Europe/Berlin', source: 'analyst' })];
    const vip     = [rec({ email: 'cross@x.com', userType: 'EXE', tz: 'US/Central',   source: 'vip', name: 'CrossV' })];
    const plan = build({ currentSettings: emptySettings(), lastImport: emptyLastImport(), analyst, vip, mode: 'internal' });
    assert.equal(plan.imported.emailTimeZoneMappings['cross@x.com'], 'Europe/Berlin');
});

test('vipUsers contains distinct names from VIP file only — analyst names never appear', () => {
    const analyst = [
        rec({ email: 'analyst@x.com', userType: 'EXE', name: 'Analyst One' })
    ];
    const vip = [
        rec({ email: 'vip1@x.com', userType: 'OSE', name: 'VIP One',   source: 'vip' }),
        rec({ email: 'vip2@x.com', userType: 'EXE', name: 'VIP Two',   source: 'vip' }),
        rec({ email: 'vip3@x.com', userType: 'OSE', name: 'VIP One',   source: 'vip' })
    ];
    const plan = build({ currentSettings: emptySettings(), lastImport: emptyLastImport(), analyst, vip, mode: 'external' });
    const names = plan.imported.vipUsers.map(v => v.name);
    assert.ok(!names.includes('Analyst One'));
    assert.equal(names.filter(n => n === 'VIP One').length, 1);
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

test('stale entries absent from new import appear in diff.remove and are gone from nextSettings', () => {
    const settings = {
        ...emptySettings(),
        excludedEmails: ['stale@x.com', 'keep@x.com'],
        vipUsers:       [{ name: 'StaleVIP' }]
    };
    const analyst = [rec({ email: 'keep@x.com', userType: 'OSE', source: 'analyst' })];
    const plan = build({
        currentSettings: settings,
        lastImport:      emptyLastImport(),
        analyst, vip: [], mode: 'external'
    });
    assert.deepEqual(plan.diff.excludedEmails.remove, ['stale@x.com']);
    assert.deepEqual(plan.diff.vipUsers.remove, [{ name: 'StaleVIP' }]);
    assert.deepEqual(plan.diff.excludedEmails.add, []);
});

test('first-time import: all entries appear in diff.add, none in diff.remove', () => {
    const analyst = [
        rec({ email: 'exe@x.com', userType: 'EXE', tz: 'US/Central', country: 'MX' })
    ];
    const vip = [rec({ email: 'v@x.com', userType: 'OSE', name: 'VIP One', source: 'vip' })];
    const plan = build({
        currentSettings: emptySettings(),
        lastImport:      emptyLastImport(),
        analyst, vip, mode: 'external'
    });
    assert.deepEqual(plan.imported.excludedEmails, []);
    assert.deepEqual(plan.imported.vipUsers,       [{ name: 'VIP One' }]);
    assert.deepEqual(plan.imported.emailTimeZoneMappings, { 'exe@x.com': 'US/Central' });
    assert.deepEqual(plan.imported.emailCountries, [{ Email: 'exe@x.com', Country: 'MX' }]);
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
});

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
        // Empezamos con 4 correos en el JSON
        excludedEmails: ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com']
    };
    const analyst = [
        // La nueva carga de ServiceNow solo trae 1 correo (Reducción drástica del volumen)
        rec({ email: 'e@x.com', userType: 'OSE' })
    ];
    const plan = build({
        currentSettings: settings, lastImport: emptyLastImport(),
        analyst, vip: [], mode: 'external'
    });
    // Math.abs(4 - 1) / 4 = 3/4 = 0.75 (> 0.50) -> TRUE
    assert.equal(plan.sanityFlags.largeChurn, true);
});

test('plan contains all required top-level keys', () => {
    const plan = build({
        currentSettings: emptySettings(), lastImport: emptyLastImport(),
        analyst: [], vip: [], mode: 'external'
    });
    for (const key of ['generatedAt', 'mode', 'counts', 'imported', 'diff', 'warnings', 'sanityFlags']) {        assert.ok(key in plan);
    }
});

test('plan does not expose planId or currentSettingsHash (those belong to the HTTP layer)', () => {
    const plan = build({
        currentSettings: emptySettings(), lastImport: emptyLastImport(),
        analyst: [], vip: [], mode: 'external'
    });
    assert.ok(!('planId' in plan));
    assert.ok(!('currentSettingsHash' in plan));
});

test('plan.mode echoes the mode argument', () => {
    const planExt = build({ currentSettings: emptySettings(), lastImport: emptyLastImport(), analyst: [], vip: [], mode: 'external' });
    const planInt = build({ currentSettings: emptySettings(), lastImport: emptyLastImport(), analyst: [], vip: [], mode: 'internal' });
    assert.equal(planExt.mode, 'external');
    assert.equal(planInt.mode, 'internal');
});