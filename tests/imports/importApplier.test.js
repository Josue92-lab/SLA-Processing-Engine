/**
 * importApplier.test.js
 *
 */
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
        emailTimeZoneMappings: { 'a@x.com': 'America/New_York' },
        emailCountries:        [{ Email: 'a@x.com', Country: 'CL' }]
    };
    const { nextSettings } = apply(current, newImp, emptyLastImport(), { mode: 'external', now: fixedNow });
    assert.deepEqual(nextSettings.excludedEmails,        ['a@x.com']);
    assert.deepEqual(nextSettings.vipUsers,              [{ name: 'Alpha' }]);
    assert.equal(nextSettings.emailTimeZoneMappings['a@x.com'], 'America/New_York');
    assert.equal(Object.keys(nextSettings.emailTimeZoneMappings).length, 1);
    assert.equal(nextSettings.emailCountries.length, 1);
    assert.deepEqual(nextSettings.emailCountries[0], { Email: 'a@x.com', Country: 'CL' });
});

test('source-of-truth: previousImp has no effect on the output arrays', () => {
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
    assert.deepEqual(nextSettings.excludedEmails, ['new@x.com']);
});

test('source-of-truth: re-import with identical data yields identical output', () => {
    const newImp = {
        excludedEmails:        ['a@x.com', 'b@x.com'],
        vipUsers:              [{ name: 'VIP A' }],
        emailTimeZoneMappings: { 'a@x.com': 'US/Central' },
        emailCountries:        [{ Email: 'a@x.com', Country: 'MX' }]
    };
    const current = { ...baseCurrent(), ...newImp };
    const { nextSettings } = apply(current, newImp, emptyLastImport(), { mode: 'external', now: fixedNow });
    assert.deepEqual(nextSettings.excludedEmails,        newImp.excludedEmails);
    assert.deepEqual(nextSettings.vipUsers,              newImp.vipUsers);
    assert.deepEqual(nextSettings.emailTimeZoneMappings, newImp.emailTimeZoneMappings);
    assert.deepEqual(nextSettings.emailCountries,        newImp.emailCountries);
});

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

test('unknown top-level fields in currentSettings are forwarded verbatim', () => {
    const current = { ...baseCurrent(), futureField: { hello: 'world' }, legacyFlag: true };
    const newImp  = {
        excludedEmails: [], vipUsers: [], emailTimeZoneMappings: {}, emailCountries: []
    };
    const { nextSettings } = apply(current, newImp, emptyLastImport(), { mode: 'external', now: fixedNow });
    assert.deepEqual(nextSettings.futureField, { hello: 'world' });
    assert.equal(nextSettings.legacyFlag, true);
});

test('nextLastImport is a deep clone of newImp — mutating newImp does not corrupt it', () => {
    const newImp = {
        excludedEmails:        ['a@x.com'],
        vipUsers:              [{ name: 'V' }],
        emailTimeZoneMappings: { 'a@x.com': 'US/Central' },
        emailCountries:        [{ Email: 'a@x.com', Country: 'BR' }]
    };
    const { nextLastImport } = apply(baseCurrent(), newImp, emptyLastImport(), { mode: 'external', now: fixedNow });
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
    const { nextSettings } = apply(baseCurrent(), {}, emptyLastImport(), { mode: 'external', now: fixedNow });
    assert.deepEqual(nextSettings.excludedEmails,        []);
    assert.deepEqual(nextSettings.vipUsers,              []);
    assert.deepEqual(nextSettings.emailTimeZoneMappings, {});
    assert.deepEqual(nextSettings.emailCountries,        []);
});

test('apply handles multiple VIP entries with deduplicated names correctly', () => {
    const newImp = {
        excludedEmails:        [],
        vipUsers:              [{ name: 'Alice' }, { name: 'Bob' }, { name: 'Alice' }],
        emailTimeZoneMappings: {},
        emailCountries:        []
    };
    const { nextSettings } = apply(baseCurrent(), newImp, emptyLastImport(), { mode: 'external', now: fixedNow });
    assert.deepEqual(nextSettings.vipUsers, [{ name: 'Alice' }, { name: 'Bob' }, { name: 'Alice' }]);
});