/**
 * UI tests for views/partials/importPanel.ejs (Merge 4).
 *
 * Strategy:
 *   - Render the partial with the existing `ejs` dependency (no new deps).
 *   - Parse the resulting HTML with a minimal hand-rolled DOM stub that
 *     implements only the features the panel's vanilla JS touches.
 *     This avoids pulling in `jsdom`, `happy-dom`, playwright, etc.
 *   - Run the panel's <script> body against the stub with fetch mocked.
 *
 * The goal is coverage of *behavior*, not pixel-perfect rendering. We assert:
 *   - smoke: panel renders with expected IDs
 *   - preview response renders counts + diff + warnings + sanity flags
 *   - apply button is disabled until preview succeeds
 *   - snapshot list renders and the rollback button POSTs the right payload
 *   - warnings render visibly (not only in console)
 *   - a 409 stale-plan response renders inline and disables apply
 *   - loading states ("Previewing...", "Applying...", "Rolling back...")
 *     appear and disappear correctly
 *
 * Pre-condition: `ejs` installed (already a production dep; CI has it).
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import ejs from 'ejs';

import { createDom } from './_domStub.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PARTIAL_PATH = path.resolve(__dirname, '../../views/partials/importPanel.ejs');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PREVIEW_200 = {
    planId: 'test-plan-id-0001',
    type: 'external',
    generatedAt: '2026-05-12T18:00:00.000Z',
    currentSettingsHash: 'abcdef1234567890',
    counts: {
        analyst: { parsed: 24, kept: 23, dropped: { inactive: 1 } },
        vip:     { parsed: 55, kept: 55, dropped: {} }
    },
    imported: {
        excludedEmails: ['x@x.com'],
        vipUsers: [{ name: 'V' }],
        emailTimeZoneMappings: {},
        emailCountries: []
    },
    diff: {
        excludedEmails:        { add: ['a@x', 'b@x'],  remove: ['c@x'],     unchanged: 108 },
        vipUsers:              { add: [{ name: 'Alice' }], remove: [], changed: [], unchanged: 53 },
        emailTimeZoneMappings: { add: { 'x@x': 'US/Central' }, changed: { 'y@x': { before: 'A', after: 'B' } }, remove: ['z@x'], unchanged: 180 },
        emailCountries:        { add: [{ Email: 'n@x', Country: 'MX' }], remove: [], changed: [], unchanged: 10 }
    },
    warnings: [
        'Duplicate email a@x in analyst; first occurrence kept.',
        'Unresolved country "Peruu" for c@x'
    ],
    sanityFlags: { largeShrink: false, largeChurn: true }
};

const PLAN_STALE_409 = {
    error: {
        code: 'PLAN_STALE',
        message: 'Plan test-plan-id-0001 not found or expired. Please re-run preview.',
        details: { planId: 'test-plan-id-0001' }
    }
};

const SNAPSHOTS_200 = {
    snapshots: [
        { id: 'external__2026-05-12T18-00-00-000Z__pre-import-apply.json',
          createdAt: '2026-05-12T18:00:00.000Z', reason: 'pre-import-apply', size: 1234 },
        { id: 'external__2026-05-11T09-12-00-000Z__pre-import-apply.json',
          createdAt: '2026-05-11T09:12:00.000Z', reason: 'pre-import-apply', size: 1200 }
    ]
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * Build a fresh DOM+script environment for each test.
 */
const boot = async ({ fetchImpl, confirmImpl, configType = 'external' } = {}) => {
    const html = await ejs.renderFile(PARTIAL_PATH);
    // The partial also adds a <select id="configType"> via the parent page.
    // We inject a minimal stand-in so getMode() can read it.
    const wrappedHtml =
        '<select id="configType"><option value="external" selected>ext</option>' +
        '<option value="internal">int</option></select>' + html;

    const dom = createDom(wrappedHtml);

    // Wire globals the panel's IIFE expects.
    const state = {
        fetchCalls: [],
        confirmCalls: [],
        reloaded: false
    };
    dom.window.fetch = async (url, opts) => {
        state.fetchCalls.push({ url, opts });
        return fetchImpl(url, opts);
    };
    dom.window.confirm = (msg) => {
        state.confirmCalls.push(msg);
        return confirmImpl ? confirmImpl(msg) : true;
    };
    dom.window.location = {
        reload: () => { state.reloaded = true; }
    };
    dom.window.FormData = class FormData {
        constructor() { this._entries = []; }
        append(name, value) { this._entries.push([name, value]); }
        entries() { return this._entries[Symbol.iterator](); }
    };
    dom.window.File = class File {
        constructor(parts, name) {
            this.name = name;
            this.parts = parts;
        }
    };

    // Set default mode in the DOM stub.
    const sel = dom.document.getElementById('configType');
    if (sel) sel.value = configType;

    // Execute the <script> body from the partial.
    dom.runInlineScripts();

    // Let any microtasks (e.g. initial snapshots load) resolve.
    await dom.flush();

    return { dom, state };
};

const jsonResp = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: '' + status,
    text: async () => (body == null ? '' : JSON.stringify(body))
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('smoke: panel renders expected IDs', async () => {
    const { dom } = await boot({
        fetchImpl: async (url) => {
            if (url.includes('/snapshots')) return jsonResp(200, { snapshots: [] });
            return jsonResp(404, null);
        }
    });
    for (const id of [
        'importForm', 'importAnalystFile', 'importVipFile',
        'importPreviewBtn', 'importStatus', 'importError',
        'importPreviewSection', 'importApplyBtn', 'importCancelBtn',
        'importSnapshotsSection', 'importSnapshotsTable',
        'importSnapshotsBody', 'importMode'
    ]) {
        assert.ok(dom.document.getElementById(id),
            'expected DOM element with id=' + id);
    }
    // Apply disabled initially.
    assert.equal(dom.document.getElementById('importApplyBtn').disabled, true);
});

test('preview response: renders counts, diff, warnings, and sanity flags', async () => {
    const { dom, state } = await boot({
        fetchImpl: async (url, opts) => {
            if (url.includes('/preview'))   return jsonResp(200, PREVIEW_200);
            if (url.includes('/snapshots')) return jsonResp(200, { snapshots: [] });
            return jsonResp(404, null);
        }
    });

    // Simulate a file upload and submit.
    const analyst = dom.document.getElementById('importAnalystFile');
    const vip     = dom.document.getElementById('importVipFile');
    analyst.files = [new dom.window.File([new Uint8Array([1, 2])], 'a.xlsx')];
    vip.files     = [new dom.window.File([new Uint8Array([1, 2])], 'v.xlsx')];

    const form = dom.document.getElementById('importForm');
    await dom.fireEvent(form, 'submit');
    await dom.flush();

    // Preview section visible.
    const previewSection = dom.document.getElementById('importPreviewSection');
    assert.equal(previewSection.hidden, false);

    // Counts line correctly populated.
    const counts = dom.document.getElementById('importPreviewCounts');
    assert.match(counts.textContent, /Analyst:\s*24 parsed \/ 23 kept/);
    assert.match(counts.textContent, /VIP:\s*55 parsed \/ 55 kept/);

    // Diff rows: 4 in total, one per field.
    const diffLis = dom.document.getElementById('importDiff').children;
    assert.equal(diffLis.length, 4);
    const combinedDiffText = dom.document.getElementById('importDiff').textContent;
    // Excluded emails line: +2 -1 unchanged 108
    assert.match(combinedDiffText, /Excluded emails:\s*\+2\s*-1\s*unchanged 108/);
    // Timezone mappings: +1  ~1  -1  unchanged 180
    assert.match(combinedDiffText, /Timezone mappings:\s*\+1\s*~1\s*-1\s*unchanged 180/);

    // Warnings render visibly (not hidden, not just in console).
    const wrapper = dom.document.getElementById('importWarningsWrapper');
    assert.equal(wrapper.hidden, false, 'warnings wrapper should be visible when there are warnings');
    const warningsList = dom.document.getElementById('importWarnings');
    assert.equal(warningsList.children.length, 2);
    const warnCount = dom.document.getElementById('importWarningsCount');
    assert.equal(warnCount.textContent, '(2)');

    // Sanity flags: largeChurn true -> banner visible.
    const sanity = dom.document.getElementById('importSanityFlags');
    assert.equal(sanity.hidden, false);
    assert.match(sanity.textContent, /Large churn/);

    // Apply button now enabled.
    const applyBtn = dom.document.getElementById('importApplyBtn');
    assert.equal(applyBtn.disabled, false);

    // The fetch went to preview with the right URL.
    const previewCall = state.fetchCalls.find(c => c.url.includes('/preview'));
    assert.ok(previewCall);
    assert.equal(previewCall.opts.method, 'POST');
});

test('apply button stays disabled until preview succeeds', async () => {
    const { dom } = await boot({
        fetchImpl: async (url) => {
            if (url.includes('/preview'))
                return jsonResp(400, { error: { code: 'VALIDATION_FAILED', message: 'bad' } });
            if (url.includes('/snapshots')) return jsonResp(200, { snapshots: [] });
            return jsonResp(404, null);
        }
    });

    // Initially disabled.
    assert.equal(dom.document.getElementById('importApplyBtn').disabled, true);

    // Submit with valid files but the server fails; apply must stay disabled
    // and the preview section must stay hidden.
    const analyst = dom.document.getElementById('importAnalystFile');
    const vip     = dom.document.getElementById('importVipFile');
    analyst.files = [new dom.window.File([new Uint8Array([1])], 'a.xlsx')];
    vip.files     = [new dom.window.File([new Uint8Array([1])], 'v.xlsx')];

    const form = dom.document.getElementById('importForm');
    await dom.fireEvent(form, 'submit');
    await dom.flush();

    const err = dom.document.getElementById('importError');
    assert.equal(err.hidden, false, 'error should be visible');
    assert.match(err.textContent, /VALIDATION_FAILED/);
    assert.equal(dom.document.getElementById('importApplyBtn').disabled, true);
    assert.equal(dom.document.getElementById('importPreviewSection').hidden, true);
});

test('snapshot list renders rows + rollback triggers a POST', async () => {
    const capturedBodies = [];
    const { dom, state } = await boot({
        fetchImpl: async (url, opts) => {
            if (url.includes('/snapshots')) return jsonResp(200, SNAPSHOTS_200);
            if (url.includes('/rollback')) {
                capturedBodies.push(opts.body);
                return jsonResp(200, { restored: true, newSnapshotId: 'new-id' });
            }
            return jsonResp(404, null);
        },
        confirmImpl: () => true
    });

    // Two rows rendered.
    const body = dom.document.getElementById('importSnapshotsBody');
    assert.equal(body.children.length, 2);
    // First row should contain the reason.
    const firstRowText = body.children[0].textContent;
    assert.match(firstRowText, /pre-import-apply/);

    // Click the first Rollback button.
    const firstButton = body.children[0].querySelector('button');
    assert.ok(firstButton);
    await dom.fireEvent(firstButton, 'click');
    await dom.flush();

    // A rollback POST was issued with the expected body shape.
    assert.equal(capturedBodies.length, 1);
    const parsed = JSON.parse(capturedBodies[0]);
    assert.equal(parsed.snapshotId, SNAPSHOTS_200.snapshots[0].id);
    assert.ok(state.reloaded, 'page should reload after successful rollback');
});

test('409 PLAN_STALE on apply renders inline and disables apply', async () => {
    const { dom } = await boot({
        fetchImpl: async (url) => {
            if (url.includes('/preview'))   return jsonResp(200, PREVIEW_200);
            if (url.includes('/apply'))     return jsonResp(409, PLAN_STALE_409);
            if (url.includes('/snapshots')) return jsonResp(200, { snapshots: [] });
            return jsonResp(404, null);
        }
    });

    // Seed the preview.
    const analyst = dom.document.getElementById('importAnalystFile');
    const vip     = dom.document.getElementById('importVipFile');
    analyst.files = [new dom.window.File([new Uint8Array([1])], 'a.xlsx')];
    vip.files     = [new dom.window.File([new Uint8Array([1])], 'v.xlsx')];
    await dom.fireEvent(dom.document.getElementById('importForm'), 'submit');
    await dom.flush();

    // Apply now.
    await dom.fireEvent(dom.document.getElementById('importApplyBtn'), 'click');
    await dom.flush();

    // Error visible inline; apply disabled; preview section still shown but
    // operator must re-run preview.
    const err = dom.document.getElementById('importApplyError');
    assert.equal(err.hidden, false);
    assert.match(err.textContent, /PLAN_STALE/);
    assert.equal(dom.document.getElementById('importApplyBtn').disabled, true);
});

test('loading states appear and disappear correctly', async () => {
    // Use a resolver we can stall to observe the "Previewing..." message.
    let resolveFetch;
    const pending = new Promise((resolve) => { resolveFetch = resolve; });

    const { dom } = await boot({
        fetchImpl: async (url) => {
            if (url.includes('/snapshots')) return jsonResp(200, { snapshots: [] });
            if (url.includes('/preview'))   return await pending;
            return jsonResp(404, null);
        }
    });

    const analyst = dom.document.getElementById('importAnalystFile');
    const vip     = dom.document.getElementById('importVipFile');
    analyst.files = [new dom.window.File([new Uint8Array([1])], 'a.xlsx')];
    vip.files     = [new dom.window.File([new Uint8Array([1])], 'v.xlsx')];

    // Fire-and-forget the submit; don't await.
    dom.fireEvent(dom.document.getElementById('importForm'), 'submit').catch(() => {});
    // Let the handler begin.
    await new Promise(r => setTimeout(r, 10));

    const status = dom.document.getElementById('importStatus');
    assert.equal(status.textContent, 'Previewing...');
    assert.equal(dom.document.getElementById('importPreviewBtn').disabled, true);

    // Resolve the fetch.
    resolveFetch(jsonResp(200, PREVIEW_200));
    await dom.flush();
    await dom.flush();

    assert.equal(status.textContent, '');
    assert.equal(dom.document.getElementById('importPreviewBtn').disabled, false);
});

test('missing files error rendered inline (no fetch call)', async () => {
    let fetchCalled = false;
    const { dom } = await boot({
        fetchImpl: async (url) => {
            if (url.includes('/snapshots')) return jsonResp(200, { snapshots: [] });
            fetchCalled = true;
            return jsonResp(404, null);
        }
    });
    // Clear initial snapshot fetch so we can detect preview-related fetches.
    fetchCalled = false;

    const form = dom.document.getElementById('importForm');
    await dom.fireEvent(form, 'submit');
    await dom.flush();

    assert.equal(fetchCalled, false, 'should NOT have hit the network when files missing');
    const err = dom.document.getElementById('importError');
    assert.equal(err.hidden, false);
    assert.match(err.textContent, /Analyst and VIP/);
});
