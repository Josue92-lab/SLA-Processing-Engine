import { test } from 'node:test';
import assert from 'node:assert/strict';

import { apply } from '../../services/imports/importApplier.js';
import { emptyLastImport } from '../../services/imports/snapshotManager.js';

const fixedNow = () => '2026-05-12T18:00:00.000Z';

const baseCurrent = () => ({
    excludedEmails: [],
    vipUsers: [],
    emailTimeZoneMappings: {},
    emailCountries: [],
    allowedCountries: ['BR', 'AR']
});

test('first-ever import: newImp written in full, manual preserved where none', () => {
    const current = baseCurrent();
    const newImp = {
        excludedEmails: ['a@x.com'],
        vipUsers: [{ name: 'Alice (SHS)' }],
        emailTimeZoneMappings: { 'a@x.com': 'US/Central' },
        emailCountries: [{ Email: 'a@x.com', Country: 'BR' }]
    };
    const { nextSettings, nextLastImport } = apply(current, newImp, emptyLastImport(), { mode: 'external', now: fixedNow });
    assert.deepEqual(nextSettings.excludedEmails, ['a@x.com']);
    assert.deepEqual(nextSettings.vipUsers, [{ name: 'Alice (SHS)' }]);
    assert.deepEqual(nextSettings.emailTimeZoneMappings, { 'a@x.com': 'US/Central' });
    assert.deepEqual(nextSettings.emailCountries, [{ Email: 'a@x.com', Country: 'BR' }]);
    assert.deepEqual(nextSettings.allowedCountries, ['BR', 'AR']); // untouched
    assert.equal(nextLastImport.importedAt, '2026-05-12T18:00:00.000Z');
    assert.equal(nextLastImport.mode, 'external');
});

test('manual entries survive re-import when not in previousImp', () => {
    const current = {
        ...baseCurrent(),
        excludedEmails: ['manual@x.com', 'imported@x.com'],
        vipUsers: [{ name: 'Manual VIP' }, { name: 'Previously Imported' }],
        emailTimeZoneMappings: { 'manual@x.com': 'US/Central', 'imported@x.com': 'Europe/Berlin' },
        emailCountries: [{ Email: 'manual@x.com', Country: 'MX' }, { Email: 'imported@x.com', Country: 'BR' }]
    };
    const previousImp = {
        excludedEmails: ['imported@x.com'],
        vipUsers: [{ name: 'Previously Imported' }],
        emailTimeZoneMappings: { 'imported@x.com': 'Europe/Berlin' },
        emailCountries: [{ Email: 'imported@x.com', Country: 'BR' }]
    };
    // New import no longer carries "imported@x.com"; should disappear from settings.
    const newImp = {
        excludedEmails: [],
        vipUsers: [],
        emailTimeZoneMappings: {},
        emailCountries: []
    };
    const { nextSettings } = apply(current, newImp, previousImp, { mode: 'external', now: fixedNow });
    assert.deepEqual(nextSettings.excludedEmails, ['manual@x.com']);
    assert.deepEqual(nextSettings.vipUsers, [{ name: 'Manual VIP' }]);
    assert.deepEqual(nextSettings.emailTimeZoneMappings, { 'manual@x.com': 'US/Central' });
    assert.deepEqual(nextSettings.emailCountries, [{ Email: 'manual@x.com', Country: 'MX' }]);
});

test('import wins on key collision with manual', () => {
    const current = {
        ...baseCurrent(),
        vipUsers: [{ name: 'Ambiguous' }], // manually added with same name as an import
        emailTimeZoneMappings: { 'dup@x.com': 'Europe/Berlin' }
    };
    const newImp = {
        excludedEmails: [],
        vipUsers: [{ name: 'Ambiguous' }], // same name; import's representation wins
        emailTimeZoneMappings: { 'dup@x.com': 'US/Central' },
        emailCountries: []
    };
    const { nextSettings } = apply(current, newImp, emptyLastImport(), { mode: 'external', now: fixedNow });
    assert.deepEqual(nextSettings.vipUsers, [{ name: 'Ambiguous' }]);
    assert.equal(nextSettings.emailTimeZoneMappings['dup@x.com'], 'US/Central');
});

test('keyless entries (like historical `{}`) are preserved as manual', () => {
    const current = {
        ...baseCurrent(),
        emailCountries: [{ Email: 'k@x.com', Country: 'BR' }, {}]
    };
    const previousImp = {
        excludedEmails: [], vipUsers: [],
        emailTimeZoneMappings: {},
        emailCountries: [{ Email: 'k@x.com', Country: 'BR' }]
    };
    const newImp = {
        excludedEmails: [], vipUsers: [],
        emailTimeZoneMappings: {},
        emailCountries: [{ Email: 'k@x.com', Country: 'MX' }]
    };
    const { nextSettings } = apply(current, newImp, previousImp, { mode: 'external', now: fixedNow });
    // keyless `{}` preserved, imported entry updated
    assert.deepEqual(nextSettings.emailCountries.find(e => Object.keys(e).length === 0), {});
    assert.deepEqual(nextSettings.emailCountries.find(e => e.Email === 'k@x.com'), { Email: 'k@x.com', Country: 'MX' });
});

test('removing an entry from the import makes it disappear from settings (no tombstones in v1)', () => {
    const current = {
        ...baseCurrent(),
        excludedEmails: ['keep@x.com', 'drop@x.com']
    };
    const previousImp = {
        ...emptyLastImport(),
        excludedEmails: ['keep@x.com', 'drop@x.com']
    };
    const newImp = { ...emptyLastImport(), excludedEmails: ['keep@x.com'] };
    const { nextSettings } = apply(current, newImp, previousImp, { mode: 'external', now: fixedNow });
    assert.deepEqual(nextSettings.excludedEmails, ['keep@x.com']);
});

test('allowedCountries is never touched', () => {
    const current = { ...baseCurrent(), allowedCountries: ['BR', 'AR', 'CL'] };
    const newImp = { excludedEmails: [], vipUsers: [], emailTimeZoneMappings: {}, emailCountries: [] };
    const { nextSettings } = apply(current, newImp, emptyLastImport(), { mode: 'external', now: fixedNow });
    assert.deepEqual(nextSettings.allowedCountries, ['BR', 'AR', 'CL']);
});

test('unknown extra top-level fields in currentSettings are preserved', () => {
    const current = { ...baseCurrent(), futureField: { hello: 'world' } };
    const newImp = { excludedEmails: [], vipUsers: [], emailTimeZoneMappings: {}, emailCountries: [] };
    const { nextSettings } = apply(current, newImp, emptyLastImport(), { mode: 'external', now: fixedNow });
    assert.deepEqual(nextSettings.futureField, { hello: 'world' });
});

test('nextLastImport clones newImp (no aliasing)', () => {
    const newImp = {
        excludedEmails: ['a@x.com'],
        vipUsers: [{ name: 'V' }],
        emailTimeZoneMappings: { 'a@x.com': 'US/Central' },
        emailCountries: [{ Email: 'a@x.com', Country: 'BR' }]
    };
    const { nextLastImport } = apply(baseCurrent(), newImp, emptyLastImport(), { mode: 'external', now: fixedNow });
    // Mutate newImp; nextLastImport must not change.
    newImp.excludedEmails.push('mutated');
    newImp.vipUsers[0].name = 'MUTATED';
    newImp.emailTimeZoneMappings['a@x.com'] = 'X';
    newImp.emailCountries[0].Country = 'YY';
    assert.deepEqual(nextLastImport.excludedEmails, ['a@x.com']);
    assert.equal(nextLastImport.vipUsers[0].name, 'V');
    assert.equal(nextLastImport.emailTimeZoneMappings['a@x.com'], 'US/Central');
    assert.equal(nextLastImport.emailCountries[0].Country, 'BR');
});
