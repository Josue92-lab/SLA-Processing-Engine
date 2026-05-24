import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    normalizeRow,
    normalizeAll,
    defaultIsValidTz
} from '../../services/imports/userNormalizer.js';
import { row } from './_helpers.js';

test('keeps a fully-valid active row', () => {
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

test('tier-2 filter: Active != 1 is dropped with audit warning', () => {
    const out = normalizeRow(row({ Active: '0' }), 'analyst');
    assert.equal(out.skipped, 'inactive');
    assert.equal(out.record, null);
    // Audit-trail contract: tier-2 drop is no longer silent. The warning
    // must identify the row and which gate value triggered the drop.
    assert.equal(out.warnings.length, 1);
    assert.match(out.warnings[0], /Row dropped \(inactive\)/);
    assert.match(out.warnings[0], /email=test\.user@example\.com/);
    assert.match(out.warnings[0], /source=analyst/);
    assert.match(out.warnings[0], /Active="0"/);
});

test('tier-2 filter: Status != ENABLED is silently dropped', () => {
    const out = normalizeRow(row({ Status: 'DISABLED' }), 'analyst');
    assert.equal(out.skipped, 'inactive');
});

test('tier-2 filter: Gama User Status != Enabled is silently dropped', () => {
    const out = normalizeRow(row({ 'Gama User Status': 'Disabled' }), 'analyst');
    assert.equal(out.skipped, 'inactive');
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
        row({ Email: 'b@x.com', Active: '0' }),
        row({ Email: '' }),
        row({ Email: 'd@x.com', 'User type': 'BAD' }),
        row({ Email: 'e@x.com', 'Time zone': 'Narnia/Here' })
    ];
    const { records, dropped, warnings } = normalizeAll(rows, 'analyst');
    assert.equal(records.length, 2);                 // a@x.com + e@x.com
    assert.equal(dropped.inactive, 1);
    assert.equal(dropped.missingEmail, 1);
    assert.equal(dropped.invalidUserType, 1);
    assert.ok(warnings.some(w => /Invalid timezone/.test(w)));
    assert.ok(warnings.some(w => /missing Email/.test(w)));
});
