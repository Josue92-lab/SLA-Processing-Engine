/**
 * HTTP router for the import-assisted settings sync.
 *
 * Current scope: Merges 1-4 of the staged rollout defined in
 * .kiro/steering/import-based-settings-v1-blueprint.md §12. All four
 * endpoints are fully implemented:
 *
 *   - POST /api/settings/:type/import/preview    read-only plan builder
 *   - POST /api/settings/:type/import/apply      atomic apply under the
 *                                                importLockManager, with
 *                                                pre-import-apply snapshot
 *                                                and sidecar update
 *   - POST /api/settings/:type/import/rollback   restore a snapshot under
 *                                                the importLockManager;
 *                                                sidecar is NOT restored
 *                                                (see blueprint §8)
 *   - GET  /api/settings/:type/import/snapshots  newest-first list
 *
 * Historical note: Merge 2 shipped with apply/rollback/snapshots returning
 * 501 NOT_IMPLEMENTED. Merge 3 (settingsImport.apply.test.js) replaced
 * those stubs with the real handlers. Neither the 501 path nor a
 * "preview-only" runtime mode still exists.
 *
 * Preview is strictly read-only:
 *   - reads projectSettings_<type>.json (via settingsService.getSettings)
 *   - reads the last-import sidecar (via snapshotManager.readLastImport)
 *   - parses and normalizes two uploaded .xlsx files
 *   - caches the plan in-memory (15-minute TTL) and returns a summary
 *
 * Preview NEVER:
 *   - writes to config/projectSettings_*.json
 *   - creates snapshots
 *   - writes the sidecar
 *   - persists the uploaded files beyond the multipart lifecycle
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import crypto from 'crypto';

import express from 'express';
import multer from 'multer';

import { parseWorkbook } from '../services/imports/excelImportParser.js';
import { normalizeAll } from '../services/imports/userNormalizer.js';
import { validateCrossFile, deduplicateByEmail } from '../services/imports/importValidator.js';
import { build as buildPlan } from '../services/imports/importPlanner.js';
import {
    readLastImport,
    writeLastImport,
    createSnapshot,
    listSnapshots,
    readSnapshot,
    pruneSnapshots
} from '../services/imports/snapshotManager.js';
import { apply as applierApply } from '../services/imports/importApplier.js';
import { runLocked } from '../services/imports/importLockManager.js';
import { ImportError, ERR } from '../services/imports/errors.js';
import { getSettings, updateSettings, invalidateCache } from '../services/settingsService.js';
import { defaultPlanCache } from '../services/imports/planCache.js';

const VALID_TYPES = new Set(['external', 'internal']);

const SNAPSHOT_RETENTION = 10;

// ---------------------------------------------------------------------------
// Multer instance (local to this router by design)
// ---------------------------------------------------------------------------
//
// The existing `routes/multerConfig.js` accepts a single file under the field
// name `file` with a 15MB limit and xlsx/xls/csv filter. That is correct for
// the existing "process an SLA export" flow and MUST stay untouched.
//
// The import preview needs two named files (analystFile + vipFile) and must
// reject CSV explicitly (the import schema is binary Excel only). Keeping
// the multer configuration local avoids coupling the two flows.

const UPLOAD_DIR = path.resolve('./uploads');
// Sync mkdir at module load to match the convention in routes/multerConfig.js
// and surface permission issues at boot rather than at request time.
if (!fsSync.existsSync(UPLOAD_DIR)) {
    fsSync.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const XLSX_MIME_TYPES = new Set([
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    // Some browsers send generic fallbacks; we still require .xlsx extension.
    'application/octet-stream',
    'application/zip'
]);

const importUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, UPLOAD_DIR),
        filename: (req, file, cb) => {
            const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
            const ext = path.extname(file.originalname).toLowerCase();
            cb(null, `import-${file.fieldname}-${unique}${ext}`);
        }
    }),
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (ext !== '.xlsx') {
            return cb(new ImportError(
                ERR.FILE_READ_FAILED,
                `Only .xlsx files are accepted for import. Got "${file.originalname}".`,
                { field: file.fieldname, originalname: file.originalname }
            ));
        }
        if (!XLSX_MIME_TYPES.has(file.mimetype)) {
            return cb(new ImportError(
                ERR.FILE_READ_FAILED,
                `Unexpected content-type "${file.mimetype}" for ${file.originalname}.`,
                { field: file.fieldname, mimetype: file.mimetype }
            ));
        }
        cb(null, true);
    },
    limits: {
        fileSize: 15 * 1024 * 1024,
        files: 2
    }
});

// .fields() returns an object keyed by fieldname: { analystFile: [file], vipFile: [file] }
const uploadFields = importUpload.fields([
    { name: 'analystFile', maxCount: 1 },
    { name: 'vipFile',     maxCount: 1 }
]);

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------
//
// Exported as a factory so tests can inject a disposable plan cache.
// The default export wires the singleton cache.

export const createImportRouter = ({ planCache = defaultPlanCache, snapshotBaseDir } = {}) => {
    const router = express.Router();

    // Optional override for tests: redirects snapshot + sidecar I/O to a
    // disposable directory. In production this is undefined; snapshotManager
    // falls back to the real `config/imports/` path.
    const snapOpts = snapshotBaseDir ? { baseDir: snapshotBaseDir } : undefined;

    router.param('type', (req, res, next, type) => {
        if (!VALID_TYPES.has(type)) {
            return res.status(400).json({
                error: {
                    code: 'INVALID_TYPE',
                    message: `Unknown settings type "${type}". Expected "external" or "internal".`
                }
            });
        }
        next();
    });

    router.post('/api/settings/:type/import/preview', (req, res, next) => {
        uploadFields(req, res, (uploadErr) => {
            if (uploadErr) return handleUploadError(uploadErr, res);
            return handlePreview(req, res, planCache, snapOpts)
                .catch((err) => respondUnexpected(res, err, 'preview'));
        });
    });

    router.post(
        '/api/settings/:type/import/apply',
        express.json(),
        (req, res) => handleApply(req, res, planCache, snapOpts)
            .catch((err) => respondUnexpected(res, err, 'apply'))
    );

    router.get(
        '/api/settings/:type/import/snapshots',
        (req, res) => handleListSnapshots(req, res, snapOpts)
            .catch((err) => respondUnexpected(res, err, 'snapshots'))
    );

    router.post(
        '/api/settings/:type/import/rollback',
        express.json(),
        (req, res) => handleRollback(req, res, snapOpts)
            .catch((err) => respondUnexpected(res, err, 'rollback'))
    );

    return router;
};

/**
 * Stabilization pass (v1): unified 500 responder.
 *
 * Before this wrapper existed, unexpected errors (disk-full, EACCES on the
 * snapshots dir, plain-Error surfaces from pure modules) escaped via
 * next(err) into middleware/errorHandler.js, which responds with the
 * legacy shape `{error: true, message: ...}`. That shape does NOT match the
 * import layer's documented contract `{error: {code, message, details?}}`
 * and the UI's formatError() could not extract the message -- operator saw
 * "Unknown error" instead of the real cause.
 *
 * We intercept every import-route promise rejection here, log the stack
 * ONCE with a stable prefix (so operators can grep), and emit the structured
 * shape that the UI already knows how to render. Express's default 500 is
 * preserved implicitly (we don't override the global handler).
 *
 * ImportError instances should have been handled already by the specific
 * handler-level responders; if one reaches here, we still render it in the
 * consistent shape rather than letting it double-respond.
 */
const respondUnexpected = (res, err, op) => {
    if (res.headersSent) {
        // Response already committed somewhere upstream. Nothing safe to do
        // other than end the response.
        try { res.end(); } catch { /* no-op */ }
        return;
    }
    if (err instanceof ImportError) {
        // Defensive: an ImportError bubbled past the specific responder.
        // Map its code like apply's error mapper would.
        console.warn(`[settingsImport] unhandled ImportError in ${op}: code=${err.code} ${err.message}`);
        const status = err.code === ERR.PLAN_STALE ? 409
                     : err.code === ERR.SNAPSHOT_NOT_FOUND ? 404
                     : err.code === ERR.SNAPSHOT_CORRUPT ? 500
                     : 400;
        return res.status(status).json({
            error: { code: err.code, message: err.message, details: err.details }
        });
    }
    console.error(`[settingsImport] unexpected error in ${op}: ${err && err.message}`);
    if (err && err.stack) console.error(err.stack);
    return res.status(500).json({
        error: {
            code: 'INTERNAL_ERROR',
            message: 'An unexpected server error occurred. See server logs for details.',
            details: { op }
        }
    });
};

// ---------------------------------------------------------------------------
// Upload-layer error handling
// ---------------------------------------------------------------------------

const handleUploadError = (err, res) => {
    // Our own ImportError thrown by fileFilter.
    if (err instanceof ImportError) {
        console.warn(`[settingsImport] upload rejected: ${err.code} - ${err.message}`);
        return res.status(400).json({
            error: { code: err.code, message: err.message, details: err.details }
        });
    }
    if (err instanceof multer.MulterError) {
        console.warn(`[settingsImport] multer error: ${err.code} - ${err.message}`);
        return res.status(400).json({
            error: { code: `MULTER_${err.code}`, message: err.message, details: { field: err.field } }
        });
    }
    // Unknown: surface generically but still NOT 500, since upload-layer
    // errors are caused by the client's request shape.
    console.warn(`[settingsImport] upload error: ${err.message}`);
    return res.status(400).json({
        error: { code: 'UPLOAD_FAILED', message: err.message }
    });
};

// ---------------------------------------------------------------------------
// Preview pipeline
// ---------------------------------------------------------------------------

const handlePreview = async (req, res, planCache, snapOpts) => {
    const type = req.params.type;
    const started = Date.now();
    console.log(`[settingsImport] preview started type=${type}`);

    const analystFile = req.files?.analystFile?.[0];
    const vipFile     = req.files?.vipFile?.[0];

    // The temp paths to clean up at the end, regardless of outcome.
    const tempPaths = [analystFile?.path, vipFile?.path].filter(Boolean);

    try {
        if (!analystFile || !vipFile) {
            return respondError(res, 400, {
                code: 'MISSING_FILES',
                message: 'Both "analystFile" and "vipFile" multipart fields are required.',
                details: {
                    receivedFields: Object.keys(req.files || {})
                }
            });
        }

        // --- Parse (tier 1 structural validation inside) ---
        let analystRaw, vipRaw;
        try {
            analystRaw = await parseWorkbook(analystFile.path);
        } catch (err) {
            return respondImportError(res, err, { source: 'analyst' });
        }
        try {
            vipRaw = await parseWorkbook(vipFile.path);
        } catch (err) {
            return respondImportError(res, err, { source: 'vip' });
        }

        // --- Normalize (tier 2 silent filter + tier 3 warnings) ---
        const analystNorm = normalizeAll(analystRaw, 'analyst');
        const vipNorm     = normalizeAll(vipRaw,     'vip');

        // Intra-file dedup (first-write-wins on email).
        const { unique: analystUnique, warnings: analystDupWarns } = deduplicateByEmail(analystNorm.records, 'analyst');
        const { unique: vipUnique,     warnings: vipDupWarns     } = deduplicateByEmail(vipNorm.records,     'vip');

        // --- Cross-file validation (tier 1 hard errors + tier 3 warnings) ---
        const cross = validateCrossFile(analystUnique, vipUnique);
        if (cross.errors.length > 0) {
            console.warn(`[settingsImport] preview rejected type=${type} cross-file errors=${cross.errors.length}`);
            return respondError(res, 400, {
                code: 'VALIDATION_FAILED',
                message: 'Import rejected by cross-file validation.',
                details: {
                    errors: cross.errors.map(e => ({ code: e.code, message: e.message, details: e.details }))
                }
            });
        }

        // --- Build counts for the plan ---
        const counts = {
            analyst: {
                parsed:  analystRaw.length,
                kept:    analystUnique.length,
                dropped: analystNorm.dropped
            },
            vip: {
                parsed:  vipRaw.length,
                kept:    vipUnique.length,
                dropped: vipNorm.dropped
            }
        };

        // --- Read current settings + sidecar (both READ-ONLY) ---
        const currentSettings = await getSettings(type);
        const lastImport = await readLastImport(type, snapOpts);

        const currentSettingsHash = hashSettings(currentSettings);

        // --- Build the ImportPlan (pure function) ---
        const warnings = [
            ...analystNorm.warnings,
            ...vipNorm.warnings,
            ...analystDupWarns,
            ...vipDupWarns,
            ...cross.warnings
        ];

        const plan = buildPlan({
            currentSettings,
            lastImport,
            analyst: analystUnique,
            vip: vipUnique,
            mode: type,
            counts,
            warnings
        });

        // --- Cache the plan for the apply step ---
        const planId = planCache.put({
            type,
            plan,
            analystRecords: analystUnique,
            vipRecords: vipUnique,
            currentSettingsHash
        });

        const responseBody = summarizePlanForResponse(plan, {
            planId,
            type,
            currentSettingsHash
        });

        const ms = Date.now() - started;
        console.log(
            `[settingsImport] preview generated type=${type} planId=${planId} ` +
            `analyst=${counts.analyst.parsed}/${counts.analyst.kept} ` +
            `vip=${counts.vip.parsed}/${counts.vip.kept} ` +
            `warnings=${warnings.length} took=${ms}ms`
        );

        return res.status(200).json(responseBody);
    } finally {
        await Promise.all(tempPaths.map(async (p) => {
            try { await fs.unlink(p); }
            catch (err) {
                if (err.code !== 'ENOENT') {
                    console.warn(`[settingsImport] temp cleanup failed for ${p}: ${err.message}`);
                }
            }
        }));
    }
};

const respondError = (res, status, payload) => {
    return res.status(status).json({ error: payload });
};

const respondImportError = (res, err, extra = {}) => {
    if (err instanceof ImportError) {
        console.warn(`[settingsImport] validation failure code=${err.code} ${extra.source ? `source=${extra.source}` : ''} ${err.message}`);
        return respondError(res, 400, {
            code: err.code,
            message: err.message,
            details: { ...err.details, ...extra }
        });
    }
    // Re-throw non-ImportError so the outer try/finally runs and the
    // global error handler gets it (will produce a 500).
    throw err;
};

/**
 * sha256 of the settings object. Used as the currentSettingsHash for the
 * apply-path staleness guard.
 *
 * Canonical form = JSON.stringify with sorted keys at every level. This is
 * NOT a general-purpose deep sort; it is enough for our settings schema,
 * which contains only primitive values, arrays, and plain objects.
 */
const hashSettings = (obj) => {
    const canonical = canonicalJson(obj);
    return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
};

const canonicalJson = (v) => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
    const keys = Object.keys(v).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
};

/**
 * Shape the plan for the preview response. This is the UI-facing contract.
 * The apply path consumes the full cached plan internally and does not need
 * this shaped version.
 */
const summarizePlanForResponse = (plan, { planId, type, currentSettingsHash }) => ({
    planId,
    type,
    generatedAt:         plan.generatedAt,
    currentSettingsHash,
    counts:              plan.counts,
    diff:                plan.diff,
    warnings:            plan.warnings,
    sanityFlags:         plan.sanityFlags,
    // `imported` is included too so the UI can render previews without
    // having to reconstruct it from `diff`.
    imported:            plan.imported
});

// ---------------------------------------------------------------------------
// Apply pipeline
// ---------------------------------------------------------------------------
//
// Contract:
//   - Body: { planId: string }
//   - 200: { applied: true, snapshotId, diffSummary, warnings? }
//   - 400: malformed body (missing planId)
//   - 409: planId expired / unknown           (PLAN_STALE)
//   - 409: settings drifted and rebuilt plan would change the outcome
//   - 500: write failure (settings untouched)
//
// Order of operations inside the importLockManager:
//   1. load cached plan (throws PLAN_STALE on miss/expiry)
//   2. re-read current settings; compare hash with cached hash
//        if equal  -> keep the cached plan as-is
//        if differs -> rebuild plan from cached records + fresh settings
//                      if material outcome is identical -> use rebuilt plan
//                      if material outcome differs      -> 409 (PLAN_STALE)
//   3. snapshotManager.createSnapshot(type, 'pre-import-apply')
//   4. settingsService.updateSettings(type, mutator)
//        mutator replaces only the 4 importable fields; allowedCountries
//        and any unknown top-level keys are preserved (see importApplier).
//   5. snapshotManager.writeLastImport(type, nextLastImport)
//        best-effort; a failure here is recoverable and logged but does
//        NOT roll the settings write back (settings already on disk).
//   6. snapshotManager.pruneSnapshots(type, 10)
//        best-effort; failures are logged.
//   7. planCache.delete(planId)                - eager removal after success

const handleApply = async (req, res, planCache, snapOpts) => {
    const type = req.params.type;
    const started = Date.now();
    console.log(`[settingsImport] apply started type=${type}`);

    const planId = req.body?.planId;
    if (typeof planId !== 'string' || planId === '') {
        return respondError(res, 400, {
            code: 'MISSING_PLAN_ID',
            message: 'Request body must be JSON with a "planId" string.'
        });
    }

    try {
        const result = await runLocked(type, async () => {
            // 1. Retrieve cached plan (throws PLAN_STALE if missing/expired).
            const cached = planCache.getOrThrow(planId);

            if (cached.type !== type) {
                throw new ImportError(
                    ERR.PLAN_STALE,
                    `Plan ${planId} was generated for type=${cached.type}, not ${type}.`,
                    { planId, expectedType: cached.type, actualType: type }
                );
            }

            // 2. Staleness check + silent rebuild.
            const currentSettings = await getSettings(type);
            const currentHash = hashSettings(currentSettings);

            let planToApply = cached.plan;
            let rebuilt = false;
            if (currentHash !== cached.currentSettingsHash) {
                console.warn(
                    `[settingsImport] settings hash changed between preview and apply ` +
                    `(planId=${planId}, cached=${cached.currentSettingsHash.slice(0, 8)}, ` +
                    `current=${currentHash.slice(0, 8)}). Attempting silent rebuild.`
                );
                const lastImport = await readLastImport(type, snapOpts);
                const rebuiltPlan = buildPlan({
                    currentSettings,
                    lastImport,
                    analyst: cached.analystRecords,
                    vip:     cached.vipRecords,
                    mode:    type,
                    counts:  cached.plan.counts,
                    warnings: cached.plan.warnings
                });

                if (!materiallyEquivalent(cached.plan, rebuiltPlan)) {
                    throw new ImportError(
                        ERR.PLAN_STALE,
                        'Settings changed between preview and apply and the rebuilt plan ' +
                        'differs materially. Please re-run preview.',
                        { planId }
                    );
                }
                planToApply = rebuiltPlan;
                rebuilt = true;
            }

            // 3. Snapshot BEFORE any write.
            const snapshotId = await createSnapshot(type, 'pre-import-apply', snapOpts);

            // 4. Apply via settingsService (atomic, queued, cache-refreshed).
            const prevLastImport = await readLastImport(type, snapOpts);
            let nextLastImport = null;
            await updateSettings(type, (settings) => {
                const { nextSettings, nextLastImport: sidecarNext } = applierApply(
                    settings,
                    planToApply.imported,
                    prevLastImport,
                    { mode: type }
                );
                // Mutate the settings object in place so updateSettings'
                // atomic write persists the new content. We must clear keys
                // that might have been removed (unknown today but forward-safe).
                for (const k of Object.keys(settings)) {
                    if (!(k in nextSettings)) delete settings[k];
                }
                Object.assign(settings, nextSettings);
                nextLastImport = sidecarNext;
            });

            // 5. Sidecar write (best-effort; recoverable on failure).
            let sidecarWarning = null;
            try {
                await writeLastImport(type, nextLastImport, snapOpts);
            } catch (err) {
                console.error(
                    `[settingsImport] sidecar write FAILED after successful apply ` +
                    `(type=${type}, snapshotId=${snapshotId}): ${err.message}. ` +
                    `Settings are correct; next preview may re-propose imported entries as new.`
                );
                sidecarWarning = 'sidecar-out-of-sync';
            }

            // 6. Retention pruning (best-effort).
            try {
                await pruneSnapshots(type, SNAPSHOT_RETENTION, snapOpts);
            } catch (err) {
                console.warn(`[settingsImport] snapshot prune failed: ${err.message}`);
            }

            return { snapshotId, rebuilt, sidecarWarning, plan: planToApply };
        });

        // 7. Eager cache removal AFTER successful apply (outside the lock).
        planCache.delete(planId);

        const diffSummary = buildDiffSummary(result.plan);
        const ms = Date.now() - started;
        console.log(
            `[settingsImport] apply generated type=${type} planId=${planId} ` +
            `snapshotId=${result.snapshotId} rebuilt=${result.rebuilt} took=${ms}ms`
        );

        const body = {
            applied: true,
            snapshotId: result.snapshotId,
            diffSummary
        };
        if (result.rebuilt) body.rebuilt = true;
        if (result.sidecarWarning) body.warnings = [result.sidecarWarning];
        return res.status(200).json(body);
    } catch (err) {
        if (err instanceof ImportError) {
            return respondImportErrorFromApply(res, err);
        }
        throw err;
    }
};

/**
 * Determine whether two plans produce the same on-disk outcome. We compare
 * the canonical-JSON of the `imported` section only: that is what the
 * applier writes; counts / warnings / generatedAt can differ without
 * affecting the settings result.
 */
const materiallyEquivalent = (planA, planB) => {
    return canonicalJson(planA.imported) === canonicalJson(planB.imported);
};

/**
 * Extract a small, UI-friendly summary from the plan's diff. Used in both
 * apply responses (where the full plan is not returned) and in logs.
 */
const buildDiffSummary = (plan) => {
    const d = plan.diff || {};
    return {
        excludedEmails: {
            add:       (d.excludedEmails?.add || []).length,
            remove:    (d.excludedEmails?.remove || []).length,
            unchanged:  d.excludedEmails?.unchanged ?? 0
        },
        vipUsers: {
            add:       (d.vipUsers?.add || []).length,
            remove:    (d.vipUsers?.remove || []).length,
            changed:   (d.vipUsers?.changed || []).length,
            unchanged:  d.vipUsers?.unchanged ?? 0
        },
        emailTimeZoneMappings: {
            add:       Object.keys(d.emailTimeZoneMappings?.add || {}).length,
            changed:   Object.keys(d.emailTimeZoneMappings?.changed || {}).length,
            remove:    (d.emailTimeZoneMappings?.remove || []).length,
            unchanged:  d.emailTimeZoneMappings?.unchanged ?? 0
        },
        emailCountries: {
            add:       (d.emailCountries?.add || []).length,
            remove:    (d.emailCountries?.remove || []).length,
            changed:   (d.emailCountries?.changed || []).length,
            unchanged:  d.emailCountries?.unchanged ?? 0
        }
    };
};

const respondImportErrorFromApply = (res, err) => {
    // PLAN_STALE -> 409; everything else -> 400 with code
    const status = err.code === ERR.PLAN_STALE ? 409 : 400;
    console.warn(`[settingsImport] apply rejected code=${err.code} status=${status} ${err.message}`);
    return res.status(status).json({
        error: { code: err.code, message: err.message, details: err.details }
    });
};

// ---------------------------------------------------------------------------
// Snapshots list
// ---------------------------------------------------------------------------

const handleListSnapshots = async (req, res, snapOpts) => {
    const type = req.params.type;
    const snaps = await listSnapshots(type, snapOpts);
    return res.status(200).json({
        snapshots: snaps.map(s => ({
            id: s.id,
            createdAt: s.createdAt,
            reason: s.reason,
            size: s.size
        }))
    });
};

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------
//
// Contract:
//   - Body: { snapshotId: string }
//   - 200: { restored: true, newSnapshotId }
//   - 400: malformed body
//   - 404: snapshot not found / invalid id for this type
//   - 500: snapshot corrupt / write failure
//
// Order of operations inside the importLockManager:
//   1. resolve + parse snapshot (throws on not-found / corrupt)
//   2. snapshotManager.createSnapshot(type, 'pre-rollback')
//   3. settingsService.updateSettings(type, mutator) that rewrites settings
//      to the snapshotted content (wipe unknown keys, then Object.assign).
//   4. settingsService.invalidateCache(type)  - defensive refresh
//   5. snapshotManager.pruneSnapshots(type, 10)
//
// Explicitly: the lastImport sidecar is NOT restored. Per the blueprint,
// rolling back settings only leaves the sidecar "ahead" of settings; the
// next preview will correctly propose re-adding imported-but-now-absent
// entries. This matches operator intent: "roll back, then decide whether
// to re-import."

const handleRollback = async (req, res, snapOpts) => {
    const type = req.params.type;
    const started = Date.now();
    console.log(`[settingsImport] rollback started type=${type}`);

    const snapshotId = req.body?.snapshotId;
    if (typeof snapshotId !== 'string' || snapshotId === '') {
        return respondError(res, 400, {
            code: 'MISSING_SNAPSHOT_ID',
            message: 'Request body must be JSON with a "snapshotId" string.'
        });
    }

    try {
        const result = await runLocked(type, async () => {
            // 1. Resolve + parse the snapshot (tier 1 errors thrown as ImportError).
            const restored = await readSnapshot(type, snapshotId, snapOpts);

            // 2. Snapshot the CURRENT state before overwriting.
            const newSnapshotId = await createSnapshot(type, 'pre-rollback', snapOpts);

            // 3. Restore via updateSettings (atomic + queued + cache-refreshed).
            await updateSettings(type, (settings) => {
                for (const k of Object.keys(settings)) delete settings[k];
                Object.assign(settings, restored);
            });

            // 4. Defensive cache invalidation - updateSettings already refreshes
            //    its own cache, but if the rollback payload came from disk
            //    (e.g. an operator edited the snapshot file), this guarantees
            //    the next read goes through disk.
            invalidateCache(type);

            // 5. Retention pruning (best-effort).
            try {
                await pruneSnapshots(type, SNAPSHOT_RETENTION, snapOpts);
            } catch (err) {
                console.warn(`[settingsImport] snapshot prune failed: ${err.message}`);
            }

            return { newSnapshotId };
        });

        const ms = Date.now() - started;
        console.log(
            `[settingsImport] rollback applied type=${type} snapshotId=${snapshotId} ` +
            `newSnapshotId=${result.newSnapshotId} took=${ms}ms`
        );
        return res.status(200).json({
            restored: true,
            newSnapshotId: result.newSnapshotId
        });
    } catch (err) {
        if (err instanceof ImportError) {
            return respondImportErrorFromRollback(res, err);
        }
        throw err;
    }
};

const respondImportErrorFromRollback = (res, err) => {
    let status = 400;
    if (err.code === ERR.SNAPSHOT_NOT_FOUND) status = 404;
    if (err.code === ERR.SNAPSHOT_CORRUPT)   status = 500;
    console.warn(`[settingsImport] rollback rejected code=${err.code} status=${status} ${err.message}`);
    return res.status(status).json({
        error: { code: err.code, message: err.message, details: err.details }
    });
};

// ---------------------------------------------------------------------------
// Default export - used by app.js
// ---------------------------------------------------------------------------

export default createImportRouter();

// Exposed for integration tests that want direct access to the upload
// middleware (e.g. to simulate a failed MIME check).
export const _internal = { hashSettings, canonicalJson, VALID_TYPES };
