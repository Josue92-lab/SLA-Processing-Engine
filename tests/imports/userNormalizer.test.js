import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    normalizeRow,
    normalizeAll,
    defaultIsValidTz
} from '../../services/imports/userNormalizer.js';
import { row } from './_helpers.js';

test('keeps a fully-valid row', () => {
    const r = row();
    const out = normalizeRow(r, 'analyst');
    assert.equal(out.skipped, null);
    assert.deepEqual(out.record, {
        email: 'test.user@example.com',
        name:  'Test User (SHS AM LAM)',
        tz:    'America/Buenos_Aires',
        country: 'BR',
        userType: 'EXE',
        source: 'analyst'
    });
    assert.equal(out.warnings.length, 0);
});

test('rows with Active=0 are still kept (no active filtering)', () => {
    const out = normalizeRow(row({ Active: '0' }), 'analyst');
    assert.equal(out.skipped, null);
    assert.ok(out.record);
    assert.equal(out.record.email, 'test.user@example.com');
});

test('rows with Status=DISABLED are still kept (no active filtering)', () => {
    const out = normalizeRow(row({ Status: 'DISABLED' }), 'analyst');
    assert.equal(out.skipped, null);
    assert.ok(out.record);
});

test('rows with Gama User Status=Disabled are still kept (no active filtering)', () => {
    const out = normalizeRow(row({ 'Gama User Status': 'Disabled' }), 'analyst');
    assert.equal(out.skipped, null);
    assert.ok(out.record);
});

test('tier-3 drop: missing email', () => {
    const out = normalizeRow(row({ Email: '' }), 'vip');
    assert.equal(out.skipped, 'missingEmail');
    assert.equal(out.record, null);
    assert.equal(out.warnings.length, 1);
});

test('tier-3 drop: invalid email shape', () => {
    const out = normalizeRow(row({ Email: 'not-an-email' }), 'vip');
    assert.equal(out.skipped, 'invalidEmail');
});

test('tier-3 drop: invalid userType', () => {
    const out = normalizeRow(row({ 'User type': 'XYZ' }), 'analyst');
    assert.equal(out.skipped, 'invalidUserType');
});

test('userType is uppercased', () => {
    const out = normalizeRow(row({ 'User type': 'exe' }), 'analyst');
    assert.equal(out.skipped, null);
    assert.equal(out.record.userType, 'EXE');
});

test('invalid timezone null-outs tz and warns, row still kept', () => {
    const out = normalizeRow(row({ 'Time zone': 'Narnia/Cair_Paravel' }), 'analyst');
    assert.equal(out.skipped, null);
    assert.equal(out.record.tz, null);
    assert.equal(out.warnings.length, 1);
    assert.match(out.warnings[0], /Invalid timezone/);
});

test('unresolved country null-outs country and warns, row still kept', () => {
    const out = normalizeRow(row({ 'Country code': 'Peruu' }), 'analyst');
    assert.equal(out.skipped, null);
    assert.equal(out.record.country, null);
    assert.equal(out.warnings.length, 1);
    assert.match(out.warnings[0], /Unresolved country/);
});

test('country name resolved via the injected resolver', () => {
    const out = normalizeRow(row({ 'Country code': 'Brazil' }), 'vip');
    assert.equal(out.record.country, 'BR');
});

test('email is trimmed', () => {
    const out = normalizeRow(row({ Email: '  a@x.com  ' }), 'analyst');
    assert.equal(out.record.email, 'a@x.com');
});

test('defaultIsValidTz accepts IANA zones and legacy aliases', () => {
    assert.equal(defaultIsValidTz('America/Buenos_Aires'), true);
    assert.equal(defaultIsValidTz('US/Central'), true);
    assert.equal(defaultIsValidTz('Narnia/Nowhere'), false);
});

test('normalizeAll aggregates counters and warnings', () => {
    const rows = [
        row({ Email: 'a@x.com' }),
        row({ Email: 'b@x.com', Active: '0' }),     // kept (no active filter)
        row({ Email: '' }),                          // dropped: missingEmail
        row({ Email: 'd@x.com', 'User type': 'BAD' }), // dropped: invalidUserType
        row({ Email: 'e@x.com', 'Time zone': 'Narnia/Here' }) // kept with tz warning
    ];
    const { records, dropped, warnings } = normalizeAll(rows, 'analyst');
    assert.equal(records.length, 3);                 // a, b, e
    assert.equal(dropped.missingEmail, 1);
    assert.equal(dropped.invalidUserType, 1);
    assert.ok(warnings.some(w => /Invalid timezone/.test(w)));
    assert.ok(warnings.some(w => /missing Email/.test(w)));
});
