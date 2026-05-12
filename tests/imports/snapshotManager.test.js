import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';

import {
    createSnapshot,
    listSnapshots,
    readSnapshot,
    pruneSnapshots,
    readLastImport,
    writeLastImport,
    emptyLastImport
} from '../../services/imports/snapshotManager.js';
import { ERR } from '../../services/imports/errors.js';
import { tmpDir } from './_helpers.js';

const isoNow = (s) => () => new Date(s);

const writeSettings = async (dir, type, obj) => {
    const p = path.join(dir, `projectSettings_${type}.json`);
    await fs.writeFile(p, JSON.stringify(obj, null, 2), 'utf8');
    return p;
};

test('createSnapshot + readSnapshot round-trip', async (t) => {
    const { dir: sandboxDir, cleanup: cSandbox } = await tmpDir();
    const { dir: baseDir, cleanup: cBase } = await tmpDir();
    t.after(cSandbox); t.after(cBase);

    const settings = { excludedEmails: ['a@x.com'], vipUsers: [] };
    const settingsPath = await writeSettings(sandboxDir, 'external', settings);

    const id = await createSnapshot('external', 'pre-import-apply', {
        baseDir, settingsPath, now: isoNow('2026-05-12T18:00:00.000Z')
    });
    assert.match(id, /^external__2026-05-12T18-00-00-000Z__pre-import-apply\.json$/);

    const read = await readSnapshot('external', id, { baseDir });
    assert.deepEqual(read, settings);
});

test('createSnapshot with missing settings file still writes a placeholder', async (t) => {
    const { dir: baseDir, cleanup } = await tmpDir();
    t.after(cleanup);
    const id = await createSnapshot('external', 'pre-import-apply', {
        baseDir,
        settingsPath: path.join(baseDir, 'does-not-exist.json'),
        now: isoNow('2026-05-12T18:00:00.000Z')
    });
    const read = await readSnapshot('external', id, { baseDir });
    assert.deepEqual(read, {});
});

test('listSnapshots returns newest first and filters by type', async (t) => {
    const { dir: sandboxDir, cleanup: cSandbox } = await tmpDir();
    const { dir: baseDir, cleanup: cBase } = await tmpDir();
    t.after(cSandbox); t.after(cBase);

    const sp = await writeSettings(sandboxDir, 'external', { a: 1 });
    await createSnapshot('external', 'one', { baseDir, settingsPath: sp, now: isoNow('2026-05-11T00:00:00.000Z') });
    await createSnapshot('external', 'two', { baseDir, settingsPath: sp, now: isoNow('2026-05-12T00:00:00.000Z') });
    await createSnapshot('internal', 'x',   { baseDir, settingsPath: sp, now: isoNow('2026-05-10T00:00:00.000Z') });

    const ext = await listSnapshots('external', { baseDir });
    assert.equal(ext.length, 2);
    assert.ok(ext[0].id.includes('2026-05-12'), `expected newest first: ${ext.map(s => s.id).join(', ')}`);

    const int = await listSnapshots('internal', { baseDir });
    assert.equal(int.length, 1);
});

test('pruneSnapshots keeps newest N and deletes the rest', async (t) => {
    const { dir: sandboxDir, cleanup: cSandbox } = await tmpDir();
    const { dir: baseDir, cleanup: cBase } = await tmpDir();
    t.after(cSandbox); t.after(cBase);

    const sp = await writeSettings(sandboxDir, 'external', { a: 1 });
    for (let i = 1; i <= 12; i++) {
        const mm = String(i).padStart(2, '0');
        await createSnapshot('external', `m${i}`, {
            baseDir, settingsPath: sp, now: isoNow(`2026-05-${mm}T00:00:00.000Z`)
        });
    }
    const before = await listSnapshots('external', { baseDir });
    assert.equal(before.length, 12);

    const deleted = await pruneSnapshots('external', 10, { baseDir });
    assert.equal(deleted, 2);

    const after = await listSnapshots('external', { baseDir });
    assert.equal(after.length, 10);
    // Newest must survive.
    assert.ok(after[0].id.includes('2026-05-12'));
    // Oldest two must be gone.
    assert.ok(!after.some(s => s.id.includes('2026-05-01')));
    assert.ok(!after.some(s => s.id.includes('2026-05-02')));
});

test('readSnapshot rejects cross-type ids with SNAPSHOT_NOT_FOUND', async (t) => {
    const { dir: baseDir, cleanup } = await tmpDir();
    t.after(cleanup);
    await assert.rejects(
        () => readSnapshot('external', 'internal__2026-05-12T00-00-00-000Z__x.json', { baseDir }),
        (err) => { assert.equal(err.code, ERR.SNAPSHOT_NOT_FOUND); return true; }
    );
});

test('readSnapshot rejects path-traversal attempts', async (t) => {
    const { dir: baseDir, cleanup } = await tmpDir();
    t.after(cleanup);
    await assert.rejects(
        () => readSnapshot('external', '../evil.json', { baseDir }),
        (err) => { assert.equal(err.code, ERR.SNAPSHOT_NOT_FOUND); return true; }
    );
});

test('readLastImport returns empty shape when sidecar missing', async (t) => {
    const { dir: baseDir, cleanup } = await tmpDir();
    t.after(cleanup);
    const data = await readLastImport('external', { baseDir });
    assert.deepEqual(data, emptyLastImport());
});

test('readLastImport returns empty shape on corrupt file (best-effort)', async (t) => {
    const { dir: baseDir, cleanup } = await tmpDir();
    t.after(cleanup);
    await fs.writeFile(path.join(baseDir, 'external.lastImport.json'), '{not valid', 'utf8');
    const data = await readLastImport('external', { baseDir });
    assert.deepEqual(data, emptyLastImport());
});

test('writeLastImport + readLastImport round-trip (atomic)', async (t) => {
    const { dir: baseDir, cleanup } = await tmpDir();
    t.after(cleanup);
    const payload = { ...emptyLastImport(), excludedEmails: ['x@y.com'], mode: 'external', importedAt: 'ts' };
    await writeLastImport('external', payload, { baseDir });
    const read = await readLastImport('external', { baseDir });
    assert.deepEqual(read, payload);
});
