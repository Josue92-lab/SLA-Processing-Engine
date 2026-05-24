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
    assert.equal(out.inactiveRecord, null);
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

// ---------------------------------------------------------------------------
// Identity-participation contract (D-B option A)
//
// Inactive rows do NOT produce a kept record (eligibility) but DO produce
// an inactiveRecord when their identity is structurally extractable
// (participation). The route layer decides whether to merge participation
// into the downstream pipeline via SLA_INCLUDE_INACTIVE_IDENTITIES.
// ---------------------------------------------------------------------------

test('inactive row with extractable identity yields populated inactiveRecord', () => {
    const out = normalizeRow(row({ Active: '0' }), 'analyst');
    assert.equal(out.skipped, 'inactive');
    assert.equal(out.record, null);
    // Identity participation: same shape as `record` would have for an
    // active row; preserves email, name, tz, country, userType, source.
    assert.deepEqual(out.inactiveRecord, {
        email: 'test.user@example.com',
        name:  'Test User (SHS AM LAM)',
        tz:    'America/Buenos_Aires',
        country: 'BR',
        userType: 'EXE',
        source: 'analyst'
    });
});

test('inactive row uppercases userType in inactiveRecord', () => {
    const out = normalizeRow(row({ Active: '0', 'User type': 'ose' }), 'vip');
    assert.equal(out.skipped, 'inactive');
    assert.equal(out.inactiveRecord.userType, 'OSE');
    assert.equal(out.inactiveRecord.source, 'vip');
});

test('inactive row with missing email yields null inactiveRecord (unrecoverable)', () => {
    const out = normalizeRow(row({ Active: '0', Email: '' }), 'analyst');
    assert.equal(out.skipped, 'inactive');
    assert.equal(out.record, null);
    assert.equal(out.inactiveRecord, null);
});

test('inactive row with invalid email yields null inactiveRecord', () => {
    const out = normalizeRow(row({ Active: '0', Email: 'not-an-email' }), 'analyst');
    assert.equal(out.skipped, 'inactive');
    assert.equal(out.inactiveRecord, null);
});

test('inactive row with invalid userType yields null inactiveRecord', () => {
    const out = normalizeRow(row({ Active: '0', 'User type': 'XYZ' }), 'analyst');
    assert.equal(out.skipped, 'inactive');
    assert.equal(out.inactiveRecord, null);
});

test('inactive row with invalid tz null-outs tz field, identity still recoverable', () => {
    const out = normalizeRow(row({ Active: '0', 'Time zone': 'Narnia/Cair_Paravel' }), 'analyst');
    assert.equal(out.skipped, 'inactive');
    assert.equal(out.inactiveRecord.tz, null);
    assert.equal(out.inactiveRecord.email, 'test.user@example.com');
    // Tier-3 warnings are NOT stacked for inactive rows: only the audit
    // warning. The bad-tz fact is recoverable (tz=null) without noise.
    assert.equal(out.warnings.length, 1);
    assert.match(out.warnings[0], /Row dropped \(inactive\)/);
});

test('inactive row with unresolvable country null-outs country, identity still recoverable', () => {
    const out = normalizeRow(row({ Active: '0', 'Country code': 'Peruu' }), 'analyst');
    assert.equal(out.skipped, 'inactive');
    assert.equal(out.inactiveRecord.country, null);
    assert.equal(out.inactiveRecord.email, 'test.user@example.com');
});

test('active row has inactiveRecord = null', () => {
    const out = normalizeRow(row(), 'analyst');
    assert.equal(out.skipped, null);
    assert.ok(out.record);
    assert.equal(out.inactiveRecord, null);
});

test('normalizeAll splits records and inactiveRecords on the active boundary', () => {
    const rows = [
        row({ Email: 'a@x.com' }),                              // active -> records
        row({ Email: 'b@x.com', Active: '0' }),                 // inactive + recoverable -> inactiveRecords
        row({ Email: 'c@x.com', Status: 'DISABLED' }),          // inactive + recoverable -> inactiveRecords
        row({ Email: '',         Active: '0' }),                // inactive + unrecoverable -> neither
        row({ Email: 'd@x.com', 'User type': 'BAD' }),          // tier-3 drop -> neither
        row({ Email: 'e@x.com' })                               // active -> records
    ];
    const { records, inactiveRecords, dropped } = normalizeAll(rows, 'analyst');
    assert.equal(records.length, 2);
    assert.deepEqual(records.map(r => r.email).sort(), ['a@x.com', 'e@x.com']);
    assert.equal(inactiveRecords.length, 2);
    assert.deepEqual(inactiveRecords.map(r => r.email).sort(), ['b@x.com', 'c@x.com']);
    // counts.dropped is unchanged: inactive rows are still counted as
    // dropped regardless of whether their identity was recoverable.
    assert.equal(dropped.inactive, 3);
    assert.equal(dropped.invalidUserType, 1);
});
