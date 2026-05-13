/**
 * Snapshot + sidecar file management.
 *
 * Layout under `baseDir` (default: <repo>/config/imports/):
 *
 *   <baseDir>/
 *     <type>.lastImport.json                sidecar - one per type
 *     snapshots/
 *       <type>__<isoSafeTs>__<reason>.json  settings-file snapshot
 *
 * Responsibilities:
 *   - createSnapshot(type, reason)         copy settings file -> snapshots dir
 *   - listSnapshots(type)                  stable chronological list, newest first
 *   - readSnapshot(type, id)               parse and return object
 *   - pruneSnapshots(type, keep)           delete all but the `keep` newest
 *   - readLastImport(type) / writeLastImport(type, obj)
 *
 * All writes use write-temp-then-rename. The engine never reads any of this.
 *
 * The module takes dependencies via parameters (`baseDir`, `settingsPath`)
 * so tests can point everything at a tmp directory.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

import { ImportError, ERR } from './errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_BASE_DIR = path.resolve(__dirname, '../../config/imports');
const DEFAULT_SETTINGS_DIR = path.resolve(__dirname, '../../config');

// Safe for filenames on every FS we care about. Replace `:` and `.` in ISO
// timestamps so the id round-trips unchanged through Windows paths too.
const isoSafeTs = (date) => date.toISOString().replace(/[:.]/g, '-');

const snapshotBaseFile = (type, ts, reason) => `${type}__${ts}__${reason}.json`;
const SNAPSHOT_ID_RE = /^(external|internal)__([^_]+(?:-[^_]+)*)__([a-z0-9-]+)\.json$/i;

const sidecarFile = (type) => `${type}.lastImport.json`;

// ---------------------------------------------------------------------------
// Empty shapes
// ---------------------------------------------------------------------------

const EMPTY_LAST_IMPORT = Object.freeze({
    importedAt: null,
    mode: null,
    excludedEmails: [],
    vipUsers: [],
    emailTimeZoneMappings: {},
    emailCountries: []
});

/**
 * Make an empty last-import object callers can safely mutate.
 */
export const emptyLastImport = () => ({
    importedAt: null,
    mode: null,
    excludedEmails: [],
    vipUsers: [],
    emailTimeZoneMappings: {},
    emailCountries: []
});

// ---------------------------------------------------------------------------
// Resolution helpers
// ---------------------------------------------------------------------------

const resolveBaseDir = (opts) => opts?.baseDir || DEFAULT_BASE_DIR;
const resolveSnapshotsDir = (opts) => path.join(resolveBaseDir(opts), 'snapshots');
const resolveSettingsPath = (type, opts) => {
    if (opts?.settingsPath) return opts.settingsPath;
    return path.join(DEFAULT_SETTINGS_DIR, `projectSettings_${type}.json`);
};

const ensureDir = async (dir) => {
    await fs.mkdir(dir, { recursive: true });
};

const atomicWriteJson = async (filePath, data) => {
    const tmp = `${filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await fs.rename(tmp, filePath);
};

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

/**
 * Copy the current settings file into the snapshots directory.
 *
 * @param {'external'|'internal'} type
 * @param {string} reason - short kebab-case tag (e.g. 'pre-import-apply', 'pre-rollback')
 * @param {object} [opts]
 * @param {string} [opts.baseDir]
 * @param {string} [opts.settingsPath]
 * @param {() => Date} [opts.now]
 * @returns {Promise<string>} snapshotId
 */
export const createSnapshot = async (type, reason, opts = {}) => {
    const now = opts.now || (() => new Date());
    const dir = resolveSnapshotsDir(opts);
    await ensureDir(dir);

    const settingsPath = resolveSettingsPath(type, opts);
    // Read AND parse: we verify the settings file is intact before snapping,
    // and the parse also acts as a structural check.
    let raw;
    try {
        raw = await fs.readFile(settingsPath, 'utf8');
    } catch (err) {
        // No settings file yet? Snapshot an empty-shape placeholder rather
        // than failing: this lets the FIRST-EVER apply snapshot "nothing"
        // and still have a valid rollback target.
        raw = '{}';
    }
    // Validate JSON early; we don't want to persist a corrupt snapshot.
    JSON.parse(raw);

    const ts = isoSafeTs(now());
    const fileName = snapshotBaseFile(type, ts, sanitizeReason(reason));
    const outPath = path.join(dir, fileName);
    await atomicWriteJson(outPath, JSON.parse(raw));

    return fileName;
};

const sanitizeReason = (reason) => {
    const cleaned = String(reason || '').toLowerCase().replace(/[^a-z0-9-]/g, '-');
    return cleaned || 'manual';
};

/**
 * List snapshots for `type`, newest first.
 *
 * @returns {Promise<Array<{id:string, type:string, createdAt:string, reason:string, size:number}>>}
 */
export const listSnapshots = async (type, opts = {}) => {
    const dir = resolveSnapshotsDir(opts);
    let entries;
    try {
        entries = await fs.readdir(dir);
    } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
    }

    const out = [];
    for (const name of entries) {
        const m = name.match(SNAPSHOT_ID_RE);
        if (!m) continue;
        const [, snapType, tsSafe, reason] = m;
        if (snapType !== type) continue;
        const stat = await fs.stat(path.join(dir, name)).catch(() => null);
        if (!stat) continue;
        out.push({
            id: name,
            type: snapType,
            createdAt: parseSafeTs(tsSafe),
            reason,
            size: stat.size
        });
    }

    // Newest first - sort by filename (filename encodes timestamp lexicographically).
    out.sort((a, b) => (b.id < a.id ? -1 : b.id > a.id ? 1 : 0));
    return out;
};

const parseSafeTs = (tsSafe) => {
    // Reverse: "-" back to ":" and "." at positions matching a real ISO ts.
    // "2026-05-12T18-40-23-000Z" -> "2026-05-12T18:40:23.000Z"
    const m = tsSafe.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/);
    if (!m) return tsSafe;
    return `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`;
};

/**
 * Read a snapshot file by id.
 *
 * @returns {Promise<object>}
 */
export const readSnapshot = async (type, snapshotId, opts = {}) => {
    const dir = resolveSnapshotsDir(opts);
    const snapPath = path.join(dir, snapshotId);

    // Defend against path-traversal: the resolved path must stay inside `dir`.
    const rel = path.relative(dir, snapPath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new ImportError(ERR.SNAPSHOT_NOT_FOUND, 'Invalid snapshotId.');
    }

    // Additionally the id must belong to this type (prevents rolling external
    // forward from an internal snapshot by accident).
    const m = snapshotId.match(SNAPSHOT_ID_RE);
    if (!m || m[1] !== type) {
        throw new ImportError(ERR.SNAPSHOT_NOT_FOUND, `Snapshot id does not belong to type=${type}.`);
    }

    let raw;
    try {
        raw = await fs.readFile(snapPath, 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT') {
            throw new ImportError(ERR.SNAPSHOT_NOT_FOUND, `Snapshot not found: ${snapshotId}`);
        }
        throw err;
    }
    try {
        return JSON.parse(raw);
    } catch (err) {
        throw new ImportError(
            ERR.SNAPSHOT_CORRUPT,
            `Snapshot is not valid JSON: ${snapshotId}`,
            { cause: err.message }
        );
    }
};

/**
 * Keep the `keep` newest snapshots for `type`; delete older.
 *
 * @returns {Promise<number>} number of snapshots deleted
 */
export const pruneSnapshots = async (type, keep, opts = {}) => {
    if (typeof keep !== 'number' || keep < 0) throw new Error('keep must be a non-negative number');
    const snapshots = await listSnapshots(type, opts);
    if (snapshots.length <= keep) return 0;
    const toDelete = snapshots.slice(keep);
    const dir = resolveSnapshotsDir(opts);
    let deleted = 0;
    for (const s of toDelete) {
        try {
            await fs.unlink(path.join(dir, s.id));
            deleted++;
        } catch (err) {
            // Best-effort pruning. Log and continue; retention is opportunistic.
            console.warn(`[snapshotManager] could not delete ${s.id}: ${err.message}`);
        }
    }
    return deleted;
};

// ---------------------------------------------------------------------------
// Sidecar (lastImport)
// ---------------------------------------------------------------------------

/**
 * Read the last-import sidecar. Missing file -> empty-shape object.
 * Corrupt file -> empty-shape object + a console warning (the import flow
 * will still succeed; worst case the next preview proposes re-adding items
 * that look like manual but were actually imported).
 */
export const readLastImport = async (type, opts = {}) => {
    const baseDir = resolveBaseDir(opts);
    const filePath = path.join(baseDir, sidecarFile(type));
    let raw;
    try {
        raw = await fs.readFile(filePath, 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT' || err.code === 'ENOTDIR' || err.code === 'EISDIR') {
            if (err.code !== 'ENOENT') {
                console.warn(`[snapshotManager] cannot read sidecar ${filePath}: ${err.code}. Treating as empty.`);
            }
            return emptyLastImport();
        }
        throw err;
    }
    try {
        const parsed = JSON.parse(raw);
        // Merge with empty shape so missing fields are defensively filled.
        return { ...emptyLastImport(), ...parsed };
    } catch (err) {
        console.warn(`[snapshotManager] corrupt sidecar ${filePath}: ${err.message}. Treating as empty.`);
        return emptyLastImport();
    }
};

/**
 * Write the last-import sidecar atomically.
 */
export const writeLastImport = async (type, data, opts = {}) => {
    const baseDir = resolveBaseDir(opts);
    await ensureDir(baseDir);
    const filePath = path.join(baseDir, sidecarFile(type));
    await atomicWriteJson(filePath, data);
};

// ---------------------------------------------------------------------------
// Exposed for integration tests
// ---------------------------------------------------------------------------

export const _internal = {
    DEFAULT_BASE_DIR,
    DEFAULT_SETTINGS_DIR,
    SNAPSHOT_ID_RE,
    EMPTY_LAST_IMPORT
};
