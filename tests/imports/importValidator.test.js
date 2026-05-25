import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateCrossFile, deduplicateByEmail } from '../../services/imports/importValidator.js';
import { ERR } from '../../services/imports/errors.js';

const rec = (overrides) => ({
    email: overrides.email,
    name:  overrides.name  ?? 'N',
    tz:    overrides.tz    ?? null,
    country: overrides.country ?? null,
    userType: overrides.userType ?? 'EXE',
    source:   overrides.source   ?? 'analyst'
});

test('clean analyst+vip pass with no errors', () => {
    const analyst = [rec({ email: 'a@x.com', userType: 'EXE', source: 'analyst' })];
    const vip     = [rec({ email: 'b@x.com', userType: 'OSE', source: 'vip' })];
    const { errors, warnings } = validateCrossFile(analyst, vip);
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, []);
});

test('all-OSE analyst file triggers FILE_SWAP_DETECTED', () => {
    const analyst = [rec({ email: 'a@x.com', userType: 'OSE', source: 'analyst' })];
    const vip     = [rec({ email: 'b@x.com', userType: 'OSE', source: 'vip' })];
    const { errors } = validateCrossFile(analyst, vip);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, ERR.FILE_SWAP_DETECTED);
});

test('all-EXE vip file triggers FILE_SWAP_DETECTED', () => {
    const analyst = [rec({ email: 'a@x.com', userType: 'EXE', source: 'analyst' })];
    const vip     = [rec({ email: 'b@x.com', userType: 'EXE', source: 'vip' })];
    const { errors } = validateCrossFile(analyst, vip);
    assert.ok(errors.find(e => e.code === ERR.FILE_SWAP_DETECTED));
});

test('empty files do NOT trigger file-swap heuristic', () => {
    const { errors } = validateCrossFile([], []);
    assert.deepEqual(errors, []);
});

test('same email EXE+OSE across files triggers CROSS_FILE_USERTYPE_CONFLICT', () => {
    const analyst = [rec({ email: 'same@x.com', userType: 'EXE', source: 'analyst' })];
    const vip     = [rec({ email: 'same@x.com', userType: 'OSE', source: 'vip' })];
    const { errors } = validateCrossFile(analyst, vip);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, ERR.CROSS_FILE_USERTYPE_CONFLICT);
    assert.deepEqual(errors[0].details.emails, ['same@x.com']);
});

test('cross-file TZ divergence does NOT emit a warning (source ownership: analyst owns TZ)', () => {
    // VIP TZ is unused, so a mismatch is irrelevant noise.
    const analyst = [
        rec({ email: 'c@x.com', userType: 'OSE', source: 'analyst', tz: 'Europe/Berlin' }),
        rec({ email: 'a2@x.com', userType: 'EXE', source: 'analyst' })  // keeps analyst file mixed
    ];
    const vip = [rec({ email: 'c@x.com', userType: 'OSE', source: 'vip', tz: 'America/Buenos_Aires' })];
    const { errors, warnings } = validateCrossFile(analyst, vip);
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, []);
});

test('cross-file country divergence does NOT emit a warning (source ownership: analyst owns country)', () => {
    const analyst = [
        rec({ email: 'd@x.com', userType: 'OSE', source: 'analyst', country: 'BR' }),
        rec({ email: 'd2@x.com', userType: 'EXE', source: 'analyst' })  // keeps analyst file mixed
    ];
    const vip     = [rec({ email: 'd@x.com', userType: 'OSE', source: 'vip',     country: 'AR' })];
    const { errors, warnings } = validateCrossFile(analyst, vip);
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, []);
});

test('deduplicateByEmail returns first occurrence, warns on diff', () => {
    const list = [
        rec({ email: 'x@y.com', tz: 'Europe/Berlin', source: 'analyst' }),
        rec({ email: 'x@y.com', tz: 'US/Central',    source: 'analyst' }),
        rec({ email: 'z@y.com', source: 'analyst' })
    ];
    const { unique, warnings } = deduplicateByEmail(list, 'analyst');
    assert.equal(unique.length, 2);
    assert.equal(unique[0].tz, 'Europe/Berlin');
    assert.equal(warnings.length, 1);
});

test('deduplicateByEmail does not warn on identical duplicates', () => {
    const a = rec({ email: 'x@y.com', tz: 'Europe/Berlin', source: 'analyst' });
    const { unique, warnings } = deduplicateByEmail([a, a], 'analyst');
    assert.equal(unique.length, 1);
    assert.deepEqual(warnings, []);
});
