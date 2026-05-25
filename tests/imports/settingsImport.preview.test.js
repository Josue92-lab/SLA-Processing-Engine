/**
 * Integration tests for the preview endpoint.
 *
 * These tests boot a real Express app using `createImportRouter` with a
 * disposable in-memory plan cache and make HTTP calls against it over a
 * short-lived `http.Server`. They do NOT share state with other tests.
 *
 * The SLA engine is not exercised; the existing CRUD routes are not
 * exercised. Only the import router.
 *
 * Pre-conditions for these tests to run:
 *   - `exceljs`, `express`, `multer`, `moment-timezone` installed
 *     (same deps the existing regression harness needs).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import path from 'path';
import fs from 'fs/promises';

import express from 'express';

import { createImportRouter } from '../../routes/settingsImport.js';
import { createPlanCache } from '../../services/imports/planCache.js';
import { tmpDir, row } from './_helpers.js';
import { writeXlsx, writeXlsxTwoSheets, REQUIRED_HEADERS } from './_xlsxHelpers.js';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

/**
 * Boot an ephemeral server on a random port. Returns { baseUrl, close, cache }.
 */
const bootServer = async (cacheOpts = {}) => {
    const cache = createPlanCache(cacheOpts);
    const app = express();
    app.use(express.json());
    app.use('/', createImportRouter({ planCache: cache }));
    // Final error handler so thrown errors produce 500 JSON in tests.
    app.use((err, req, res, next) => {
        res.status(500).json({ error: { code: 'UNEXPECTED', message: err.message } });
    });
    return await new Promise((resolve, reject) => {
        const server = app.listen(0, '127.0.0.1', (err) => {
            if (err) return reject(err);
            const { port } = server.address();
            resolve({
                baseUrl: `http://127.0.0.1:${port}`,
                close: () => new Promise((r) => server.close(r)),
                cache
            });
        });
    });
};

/**
 * Minimal multipart POST. Avoids pulling in an HTTP client library. Sends
 * two files under arbitrary field names.
 */
const postMultipart = async (url, files) => {
    const boundary = '----sla-test-boundary-' + Math.random().toString(16).slice(2);
    const parts = [];
    for (const f of files) {
        parts.push(Buffer.from(
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="${f.fieldname}"; filename="${f.filename}"\r\n` +
            `Content-Type: ${f.contentType}\r\n\r\n`
        ));
        parts.push(f.content);
        parts.push(Buffer.from('\r\n'));
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    const body = Buffer.concat(parts);

    return await new Promise((resolve, reject) => {
        const u = new URL(url);
        const req = http.request({
            hostname: u.hostname, port: u.port, path: u.pathname + u.search,
            method: 'POST',
            headers: {
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                'Content-Length': body.length
            }
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                let parsed;
                try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
};

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const readFile = (p) => fs.readFile(p);

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let server;
let fixtureDir;
let fixtureCleanup;
let analystPath;
let vipPath;

before(async () => {
    server = await bootServer();

    const { dir, cleanup } = await tmpDir();
    fixtureDir = dir;
    fixtureCleanup = cleanup;

    // Realistic fixtures: analyst = all EXE, vip = all OSE.
    analystPath = path.join(fixtureDir, 'analyst.xlsx');
    vipPath     = path.join(fixtureDir, 'vip.xlsx');

    await writeXlsx(analystPath, REQUIRED_HEADERS, [
        row({ Email: 'ext1@x.com', Name: 'EXT One (SHS IT AM)',    'User type': 'EXE', 'Country code': 'CL', 'Time zone': 'Europe/Berlin' }),
        row({ Email: 'ext2@x.com', Name: 'EXT Two (SHS IT AM)',    'User type': 'EXE', 'Country code': 'PE', 'Time zone': 'Europe/Berlin' }),
        row({ Email: 'inactive@x.com', Name: 'Inactive',            'User type': 'EXE', Active: '0' })   // kept (no active filter)
    ]);
    await writeXlsx(vipPath, REQUIRED_HEADERS, [
        row({ Email: 'vip1@x.com', Name: 'VIP One (SHS AM LAM)',   'User type': 'OSE', 'Country code': 'Brazil', 'Time zone': 'America/Buenos_Aires' }),
        row({ Email: 'vip2@x.com', Name: 'VIP Two (SHS AM LAM)',   'User type': 'OSE', 'Country code': 'MX',     'Time zone': 'America/Mexico_City' })
    ]);
});

after(async () => {
    if (fixtureCleanup) await fixtureCleanup();
    if (server) await server.close();
    if (server?.cache?._stopSweep) server.cache._stopSweep();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('preview: happy path returns planId + plan shape', async () => {
    const res = await postMultipart(`${server.baseUrl}/api/settings/external/import/preview`, [
        { fieldname: 'analystFile', filename: 'analyst.xlsx', contentType: XLSX_MIME, content: await readFile(analystPath) },
        { fieldname: 'vipFile',     filename: 'vip.xlsx',     contentType: XLSX_MIME, content: await readFile(vipPath) }
    ]);

    assert.equal(res.status, 200, `unexpected body: ${JSON.stringify(res.body)}`);
    assert.ok(res.body.planId,  'planId missing');
    assert.equal(res.body.type, 'external');
    assert.ok(res.body.currentSettingsHash, 'hash missing');
    assert.ok(res.body.counts, 'counts missing');
    assert.equal(res.body.counts.analyst.parsed, 3);
    assert.equal(res.body.counts.analyst.kept, 3);   // no active filtering
    assert.equal(res.body.counts.vip.parsed, 2);
    assert.equal(res.body.counts.vip.kept, 2);
    assert.ok(res.body.diff, 'diff missing');
    assert.ok(Array.isArray(res.body.warnings), 'warnings missing');
    assert.ok(res.body.sanityFlags, 'sanityFlags missing');
    assert.ok(res.body.imported, 'imported missing');

    // -----------------------------------------------------------------------
    // external mode classification with this specific fixture:
    //   analyst file — 3 rows, all EXE (ext1, ext2, inactive)
    //   VIP file     — 2 rows, all OSE  (vip1, vip2)
    //
    //   excludedEmails        ← OSE rows from the ANALYST file only.
    //                           The analyst file has NO OSE rows, so this
    //                           must be empty.
    //   emailTimeZoneMappings ← EXE rows from analyst.
    //   emailCountries        ← EXE rows from analyst.
    //   vipUsers              ← all rows from the VIP file (type-agnostic).
    //
    // VIP isolation: VIP-file rows are strictly isolated and must NEVER
    // appear in excludedEmails, emailTimeZoneMappings, or emailCountries.
    // -----------------------------------------------------------------------

    // excludedEmails must be empty — analyst is 100% EXE; VIP rows are isolated.
    assert.deepEqual(
        res.body.imported.excludedEmails,
        [],
        'excludedEmails must be [] — analyst has no OSE rows and VIP rows are VIP-isolated'
    );

    // All VIP file rows must appear in vipUsers (regardless of their userType).
    assert.equal(
        res.body.imported.vipUsers.length,
        2,
        'both VIP file rows must appear in vipUsers'
    );

    // Analyst EXE rows must NOT leak into vipUsers.
    assert.ok(
        !res.body.imported.vipUsers.some(v => v.email === 'ext1@x.com'),
        'analyst EXE rows must not appear in vipUsers'
    );

    // VIP isolation boundary: vip emails must not appear in excludedEmails.
    assert.ok(
        !res.body.imported.excludedEmails.includes('vip1@x.com'),
        'vip1@x.com must not appear in excludedEmails — VIP-file rows are isolated'
    );
    assert.ok(
        !res.body.imported.excludedEmails.includes('vip2@x.com'),
        'vip2@x.com must not appear in excludedEmails — VIP-file rows are isolated'
    );
});

test('preview: invalid :type returns 400 INVALID_TYPE', async () => {
    const res = await postMultipart(`${server.baseUrl}/api/settings/nonsense/import/preview`, [
        { fieldname: 'analystFile', filename: 'a.xlsx', contentType: XLSX_MIME, content: await readFile(analystPath) },
        { fieldname: 'vipFile',     filename: 'v.xlsx', contentType: XLSX_MIME, content: await readFile(vipPath) }
    ]);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'INVALID_TYPE');
});

test('preview: missing vipFile returns 400 MISSING_FILES', async () => {
    const res = await postMultipart(`${server.baseUrl}/api/settings/external/import/preview`, [
        { fieldname: 'analystFile', filename: 'a.xlsx', contentType: XLSX_MIME, content: await readFile(analystPath) }
    ]);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'MISSING_FILES');
});

test('preview: non-xlsx file is rejected by the fileFilter', async () => {
    const res = await postMultipart(`${server.baseUrl}/api/settings/external/import/preview`, [
        { fieldname: 'analystFile', filename: 'notxlsx.csv', contentType: 'text/csv', content: Buffer.from('a,b,c\n1,2,3') },
        { fieldname: 'vipFile',     filename: 'v.xlsx',      contentType: XLSX_MIME,  content: await readFile(vipPath) }
    ]);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'FILE_READ_FAILED');
});

test('preview: malformed xlsx bytes produce FILE_READ_FAILED', async () => {
    const res = await postMultipart(`${server.baseUrl}/api/settings/external/import/preview`, [
        { fieldname: 'analystFile', filename: 'corrupt.xlsx', contentType: XLSX_MIME, content: Buffer.from('not-a-real-xlsx') },
        { fieldname: 'vipFile',     filename: 'v.xlsx',       contentType: XLSX_MIME, content: await readFile(vipPath) }
    ]);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'FILE_READ_FAILED');
});

test('preview: missing required headers produces MISSING_HEADERS', async () => {
    const { dir, cleanup } = await tmpDir();
    try {
        const bad = path.join(dir, 'bad.xlsx');
        await writeXlsx(bad, REQUIRED_HEADERS.filter(h => h !== 'Time zone'), [row()]);
        const res = await postMultipart(`${server.baseUrl}/api/settings/external/import/preview`, [
            { fieldname: 'analystFile', filename: 'bad.xlsx', contentType: XLSX_MIME, content: await readFile(bad) },
            { fieldname: 'vipFile',     filename: 'v.xlsx',    contentType: XLSX_MIME, content: await readFile(vipPath) }
        ]);
        assert.equal(res.status, 400);
        assert.equal(res.body.error.code, 'MISSING_HEADERS');
        assert.ok(res.body.error.details.missing.includes('Time zone'));
    } finally {
        await cleanup();
    }
});

test('preview: multi-sheet workbook produces MULTIPLE_WORKSHEETS', async () => {
    const { dir, cleanup } = await tmpDir();
    try {
        const bad = path.join(dir, 'two.xlsx');
        await writeXlsxTwoSheets(bad, REQUIRED_HEADERS, [row()]);
        const res = await postMultipart(`${server.baseUrl}/api/settings/external/import/preview`, [
            { fieldname: 'analystFile', filename: 'a.xlsx', contentType: XLSX_MIME, content: await readFile(bad) },
            { fieldname: 'vipFile',     filename: 'v.xlsx', contentType: XLSX_MIME, content: await readFile(vipPath) }
        ]);
        assert.equal(res.status, 400);
        assert.equal(res.body.error.code, 'MULTIPLE_WORKSHEETS');
    } finally {
        await cleanup();
    }
});

test('preview: empty dataset (header-only) produces EMPTY_FILE', async () => {
    const { dir, cleanup } = await tmpDir();
    try {
        const empty = path.join(dir, 'empty.xlsx');
        await writeXlsx(empty, REQUIRED_HEADERS, []);
        const res = await postMultipart(`${server.baseUrl}/api/settings/external/import/preview`, [
            { fieldname: 'analystFile', filename: 'a.xlsx', contentType: XLSX_MIME, content: await readFile(empty) },
            { fieldname: 'vipFile',     filename: 'v.xlsx', contentType: XLSX_MIME, content: await readFile(vipPath) }
        ]);
        assert.equal(res.status, 400);
        assert.equal(res.body.error.code, 'EMPTY_FILE');
    } finally {
        await cleanup();
    }
});

test('preview: file-swap heuristic rejects analyst file that is 100% OSE', async () => {
    const { dir, cleanup } = await tmpDir();
    try {
        const swapped = path.join(dir, 'swapped.xlsx');
        await writeXlsx(swapped, REQUIRED_HEADERS, [
            row({ Email: 'swap1@x.com', 'User type': 'OSE' }),
            row({ Email: 'swap2@x.com', 'User type': 'OSE' })
        ]);
        const res = await postMultipart(`${server.baseUrl}/api/settings/external/import/preview`, [
            { fieldname: 'analystFile', filename: 'a.xlsx', contentType: XLSX_MIME, content: await readFile(swapped) },
            { fieldname: 'vipFile',     filename: 'v.xlsx', contentType: XLSX_MIME, content: await readFile(vipPath) }
        ]);
        assert.equal(res.status, 400);
        assert.equal(res.body.error.code, 'VALIDATION_FAILED');
        const codes = res.body.error.details.errors.map(e => e.code);
        assert.ok(codes.includes('FILE_SWAP_DETECTED'), `expected FILE_SWAP_DETECTED, got ${codes.join(', ')}`);
    } finally {
        await cleanup();
    }
});

test('preview: same email with EXE and OSE across files produces CROSS_FILE_USERTYPE_CONFLICT', async () => {
    const { dir, cleanup } = await tmpDir();
    try {
        const a = path.join(dir, 'a.xlsx');
        const v = path.join(dir, 'v.xlsx');
        await writeXlsx(a, REQUIRED_HEADERS, [
            row({ Email: 'same@x.com', 'User type': 'EXE' }),
            row({ Email: 'other@x.com', 'User type': 'EXE' })
        ]);
        await writeXlsx(v, REQUIRED_HEADERS, [
            row({ Email: 'same@x.com', 'User type': 'OSE' })
        ]);
        const res = await postMultipart(`${server.baseUrl}/api/settings/external/import/preview`, [
            { fieldname: 'analystFile', filename: 'a.xlsx', contentType: XLSX_MIME, content: await readFile(a) },
            { fieldname: 'vipFile',     filename: 'v.xlsx', contentType: XLSX_MIME, content: await readFile(v) }
        ]);
        assert.equal(res.status, 400);
        assert.equal(res.body.error.code, 'VALIDATION_FAILED');
        const codes = res.body.error.details.errors.map(e => e.code);
        assert.ok(codes.includes('CROSS_FILE_USERTYPE_CONFLICT'));
    } finally {
        await cleanup();
    }
});

// NOTE: A former test in this file asserted that apply/rollback/snapshots
// returned 501 NOT_IMPLEMENTED. That reflected Merge 2 of the staged rollout
// in .kiro/steering/import-based-settings-v1-blueprint.md §12, where only
// /preview was live. Merge 3 implemented those three endpoints fully, and
// their behavior is now exhaustively validated in settingsImport.apply.test.js
// (happy paths, 400 shape errors, 409 PLAN_STALE, 404 SNAPSHOT_NOT_FOUND,
// retention, concurrency, etc.). This file stays focused on preview-specific
// contracts to keep each suite single-responsibility.

test('preview: cached plan is retrievable by id until it expires', async () => {
    // Fresh server with a tiny TTL so we can observe expiration deterministically.
    const { baseUrl, close, cache } = await bootServer({ ttlMs: 100, sweepIntervalMs: 0 });
    try {
        const res = await postMultipart(`${baseUrl}/api/settings/external/import/preview`, [
            { fieldname: 'analystFile', filename: 'a.xlsx', contentType: XLSX_MIME, content: await readFile(analystPath) },
            { fieldname: 'vipFile',     filename: 'v.xlsx', contentType: XLSX_MIME, content: await readFile(vipPath) }
        ]);
        assert.equal(res.status, 200);
        const planId = res.body.planId;
        // Immediately: cache has the entry.
        assert.ok(planId, 'planId must be present in response');
        // After TTL elapses the entry must be gone from the cache.
        await new Promise(r => setTimeout(r, 150));
        assert.equal(cache.get(planId), undefined, 'plan must have expired from cache');
    } finally {
        await close();
        if (cache._stopSweep) cache._stopSweep();
    }
});
