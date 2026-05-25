import { test } from 'node:test';
import assert from 'node:assert/strict';

import { build } from '../../services/imports/importPlanner.js';
import { emptyLastImport } from '../../services/imports/snapshotManager.js';
import { ERR } from '../../services/imports/errors.js';

const rec = (o) => ({
    email: o.email, name: o.name ?? 'N', tz: o.tz ?? null,
    country: o.country ?? null, userType: o.userType ?? 'EXE', source: o.source ?? 'analyst'
});

const emptySettings = () => ({
    excludedEmails: [],
    vipUsers: [],
    emailTimeZoneMappings: {},
    emailCountries: [],
    allowedCountries: []
});

test('invalid mode throws INVALID_MODE', () => {
    assert.throws(() => build({
        currentSettings: emptySettings(),
        lastImport: emptyLastImport(),
        analyst: [], vip: [],
        mode: 'unknown-mode'
    }), (err) => {
        assert.equal(err.code, ERR.INVALID_MODE);
        return true;
    });
});

test('first-time import: analyst feeds emails+TZ+country, VIP feeds vipUsers only', () => {
    // Source ownership:
    //   analyst -> excludedEmails, emailTimeZoneMappings, emailCountries
    //   vip     -> vipUsers ONLY
    const analyst = [
        rec({ email: 'ext1@x.com', userType: 'EXE', tz: 'US/Central',           country: 'MX', source: 'analyst' }),
        rec({ email: 'int1@x.com', userType: 'OSE', tz: 'America/Buenos_Aires', country: 'BR', source: 'analyst' })
    ];
    const vip = [
        rec({ email: 'vip1@x.com', userType: 'OSE', source: 'vip', name: 'VIP One' })
    ];

    const plan = build({
        currentSettings: emptySettings(),
        lastImport: emptyLastImport(),
        analyst, vip, mode: 'external'
    });

    // external mode: excludedEmails = OSE emails FROM ANALYST (vip does not contribute).
    assert.deepEqual(plan.imported.excludedEmails, ['int1@x.com']);

    // vipUsers: from VIP file only.
    assert.deepEqual(plan.imported.vipUsers, [{ name: 'VIP One' }]);

    // TZ + country: from analyst ONLY; vip1@x.com must NOT appear.
    assert.deepEqual(plan.imported.emailTimeZoneMappings, {
        'ext1@x.com': 'US/Central',
        'int1@x.com': 'America/Buenos_Aires'
    });
    assert.deepEqual(
        plan.imported.emailCountries.sort((a, b) => a.Email.localeCompare(b.Email)),
        [
            { Email: 'ext1@x.com', Country: 'MX' },
            { Email: 'int1@x.com', Country: 'BR' }
        ]
    );

    assert.deepEqual(plan.diff.excludedEmails.add, ['int1@x.com']);
    assert.deepEqual(plan.diff.vipUsers.add, [{ name: 'VIP One' }]);
    assert.deepEqual(plan.diff.excludedEmails.remove, []);
});

test('VIP rows do NOT contribute to TZ / country / excludedEmails (source ownership)', () => {
    // Same email present in BOTH files with different attributes. Per source
    // ownership, only the analyst row is allowed to influence TZ / country /
    // excludedEmails. The VIP row contributes ONLY its name to vipUsers.
    const analyst = [
        rec({ email: 'cross@x.com', userType: 'OSE',
              tz: 'US/Central', country: 'MX', source: 'analyst' })
    ];
    const vip = [
        rec({ email: 'cross@x.com', userType: 'OSE',
              tz: 'Europe/Berlin', country: 'BR', source: 'vip', name: 'CrossVIP' }),
        // VIP-only row that does NOT exist in the analyst population.
        rec({ email: 'vipsolo@x.com', userType: 'OSE',
              tz: 'America/Mexico_City', country: 'MX', source: 'vip', name: 'Solo VIP' })
    ];

    const plan = build({
        currentSettings: emptySettings(), lastImport: emptyLastImport(),
        analyst, vip, mode: 'external'
    });

    // TZ + country: analyst-only — VIP did not override and VIP-only emails
    // did not leak in.
    assert.equal(plan.imported.emailTimeZoneMappings['cross@x.com'], 'US/Central');
    assert.equal(plan.imported.emailTimeZoneMappings['vipsolo@x.com'], undefined);

    const crossCountry = plan.imported.emailCountries.find(c => c.Email === 'cross@x.com');
    assert.equal(crossCountry.Country, 'MX');
    assert.equal(plan.imported.emailCountries.find(c => c.Email === 'vipsolo@x.com'), undefined);

    // excludedEmails: analyst-only — VIP's vipsolo@x.com is OSE but does not
    // join excludedEmails because it is not in the analyst file.
    assert.deepEqual(plan.imported.excludedEmails, ['cross@x.com']);

    // vipUsers: contains BOTH VIP names (analyst rows do not appear here).
    assert.deepEqual(
        plan.imported.vipUsers.map(v => v.name).sort(),
        ['CrossVIP', 'Solo VIP']
    );
});

test('internal mode flips the excludedEmails population to EXE', () => {
    const analyst = [rec({ email: 'ext1@x.com', userType: 'EXE', source: 'analyst' })];
    const vip     = [rec({ email: 'int1@x.com', userType: 'OSE', source: 'vip', name: 'VIP One' })];
    const plan = build({
        currentSettings: emptySettings(), lastImport: emptyLastImport(),
        analyst, vip, mode: 'internal'
    });
    // Internal mode: excludedEmails = EXE emails from analyst.
    assert.deepEqual(plan.imported.excludedEmails, ['ext1@x.com']);
});

test('re-import with identical data yields zero add/remove/changed', () => {
    const analyst = [
        rec({ email: 'ext@x.com', userType: 'EXE', tz: 'US/Central',    country: 'MX', source: 'analyst' }),
        rec({ email: 'int@x.com', userType: 'OSE', tz: 'Europe/Berlin', country: 'BR', source: 'analyst' })
    ];
    const vip = [rec({ email: 'vip@x.com', userType: 'OSE', source: 'vip', name: 'V' })];

    const firstPlan = build({
        currentSettings: emptySettings(), lastImport: emptyLastImport(),
        analyst, vip, mode: 'external'
    });

    // Simulate having applied `firstPlan`:
    const settingsAfter = {
        ...emptySettings(),
        excludedEmails: firstPlan.imported.excludedEmails,
        vipUsers: firstPlan.imported.vipUsers,
        emailTimeZoneMappings: firstPlan.imported.emailTimeZoneMappings,
        emailCountries: firstPlan.imported.emailCountries
    };
    const lastImport = {
        importedAt: 'x', mode: 'external',
        excludedEmails: firstPlan.imported.excludedEmails,
        vipUsers: firstPlan.imported.vipUsers,
        emailTimeZoneMappings: firstPlan.imported.emailTimeZoneMappings,
        emailCountries: firstPlan.imported.emailCountries
    };

    // Second preview with same inputs: no change.
    const secondPlan = build({
        currentSettings: settingsAfter, lastImport,
        analyst, vip, mode: 'external'
    });
    // excludedEmails unchanged: 1 (int@x.com — OSE from analyst)
    // tz unchanged: 2 (ext@x.com, int@x.com — analyst only)
    // vipUsers unchanged: 1 (V — vip only)
    assert.deepEqual(secondPlan.diff.excludedEmails, { add: [], remove: [], unchanged: 1 });
    assert.deepEqual(secondPlan.diff.vipUsers,       { add: [], remove: [], changed: [], unchanged: 1 });
    assert.deepEqual(secondPlan.diff.emailTimeZoneMappings, { add: {}, changed: {}, remove: [], unchanged: 2 });
    assert.equal(secondPlan.diff.emailCountries.add.length, 0);
    assert.equal(secondPlan.diff.emailCountries.remove.length, 0);
});

test('manual entry preserved across re-import and reported as unchanged', () => {
    const settings = {
        ...emptySettings(),
        excludedEmails: ['manual@x.com', 'imported@x.com'],
        vipUsers: [{ name: 'Manual' }, { name: 'ImportedV' }]
    };
    const previousImp = {
        ...emptyLastImport(),
        excludedEmails: ['imported@x.com'],
        vipUsers: [{ name: 'ImportedV' }]
    };
    // Analyst brings imported@x.com back as OSE (so external excludedEmails
    // contains it). VIP brings the matching VIP name back.
    const analyst = [rec({ email: 'imported@x.com', userType: 'OSE', source: 'analyst' })];
    const vip = [rec({ email: 'vipemail@x.com', userType: 'OSE', source: 'vip', name: 'ImportedV' })];
    const plan = build({
        currentSettings: settings, lastImport: previousImp,
        analyst, vip, mode: 'external'
    });
    // Manual entries should NOT appear in add/remove.
    assert.deepEqual(plan.diff.excludedEmails.add, []);
    assert.deepEqual(plan.diff.excludedEmails.remove, []);
    assert.equal(plan.diff.excludedEmails.unchanged, 2);
});

test('entry removed from export appears in diff.remove and is no longer in next', () => {
    const settings = {
        ...emptySettings(),
        excludedEmails: ['stale@x.com', 'keep@x.com'],
        vipUsers: [{ name: 'StaleV' }]
    };
    const previousImp = {
        ...emptyLastImport(),
        excludedEmails: ['stale@x.com', 'keep@x.com'],
        vipUsers: [{ name: 'StaleV' }]
    };
    const vip = []; // VIP file is now empty
    const analyst = [rec({ email: 'keep@x.com', userType: 'OSE', source: 'analyst' })];
    const plan = build({
        currentSettings: settings, lastImport: previousImp,
        analyst, vip, mode: 'external'
    });
    assert.deepEqual(plan.diff.excludedEmails.remove, ['stale@x.com']);
    assert.deepEqual(plan.diff.vipUsers.remove, [{ name: 'StaleV' }]);
});

test('largeShrink flag triggers when >20% of any list shrinks', () => {
    // Current has 20 imported VIPs, re-import brings only 10.
    const prevVips = Array.from({ length: 20 }, (_, i) => ({ name: `V${i}` }));
    const settings = { ...emptySettings(), vipUsers: prevVips };
    const previousImp = { ...emptyLastImport(), vipUsers: prevVips };
    const vip = Array.from({ length: 10 }, (_, i) => rec({
        email: `v${i}@x.com`, userType: 'OSE', source: 'vip', name: `V${i}`
    }));
    const plan = build({
        currentSettings: settings, lastImport: previousImp,
        analyst: [], vip, mode: 'external'
    });
    assert.equal(plan.sanityFlags.largeShrink, true);
});
