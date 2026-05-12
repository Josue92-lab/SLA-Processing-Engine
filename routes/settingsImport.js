/**
 * HTTP router for the import-assisted settings sync.
 *
 * Merge 2 scope (see .kiro/steering/import-based-settings-v1-blueprint.md):
 *   - POST /api/settings/:type/import/preview   FULL IMPLEMENTATION
 *   - POST /api/settings/:type/import/apply     501 NOT IMPLEMENTED
 *   - POST /api/settings/:type/import/rollback  501 NOT IMPLEMENTED
 *   - GET  /api/settings/:type/import/snapshots 501 NOT IMPLEMENTED
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
import { readLastImport } from '../services/imports/snapshotManager.js';
import { ImportError, ERR } from '../services/imports/errors.js';
import { getSettings } from '../services/settingsService.js';
import { defaultPlanCache } from '../services/imports/planCache.js';

const VALID_TYPES = new Set(['external', 'internal']);

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

export const createImportRouter = ({ planCache = defaultPlanCache } = {}) => {
    const router = express.Router();

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
            return handlePreview(req, res, planCache).catch(next);
        });
    });

    // Intentional 501s for endpoints that land in Merge 3.
    router.post('/api/settings/:type/import/apply', notImplemented('apply'));
    router.post('/api/settings/:type/import/rollback', notImplemented('rollback'));
    router.get('/api/settings/:type/import/snapshots', notImplemented('snapshots'));

    return router;
};

const notImplemented = (op) => (req, res) => {
    res.status(501).json({
        error: {
            code: 'NOT_IMPLEMENTED',
            message: `Import ${op} is not implemented yet (Merge 3).`
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

const handlePreview = async (req, res, planCache) => {
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
        const lastImport = await readLastImport(type);

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

        // --- Cache for Merge 3 (apply) ---
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
 * staleness guard in Merge 3.
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
 * Merge 3 will consume the full cached plan internally and does not need
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
// Default export - used by app.js
// ---------------------------------------------------------------------------

export default createImportRouter();

// Exposed for integration tests that want direct access to the upload
// middleware (e.g. to simulate a failed MIME check).
export const _internal = { hashSettings, canonicalJson, VALID_TYPES };
