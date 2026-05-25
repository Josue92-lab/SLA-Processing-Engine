import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const paths = {
    external: path.resolve(__dirname, '../config/projectSettings_external.json'),
    internal: path.resolve(__dirname, '../config/projectSettings_internal.json')
};

const defaultSettings = {
    excludedEmails:        [],
    vipUsers:              [],
    emailTimeZoneMappings: {},
    emailCountries:        [],
    allowedCountries:      []
};

const cache = {
    external: null,
    internal: null
};

let writeQueue = Promise.resolve();

export const getSettings = async (type) => {
    if (cache[type]) return cache[type];

    try {
        const rawData = await fs.readFile(paths[type], 'utf8');
        cache[type] = JSON.parse(rawData);
    } catch (error) {
        console.warn(`[Warning] No se pudo leer ${paths[type]}, inicializando por defecto. Razón: ${error.message}`);
        cache[type] = { ...defaultSettings };
        await saveSettingsToDisk(type, cache[type]);
    }

    return cache[type];
};

/**
 * Saves configuration atomically using a write-tmp-then-rename strategy.
 *
 * On Windows, a reader (e.g. a getSettings() call whose cache was just
 * invalidated) may still hold an open handle on the target file at the
 * moment fs.rename() fires.  Windows does not release handles as
 * aggressively as POSIX, so rename() throws EPERM or EACCES.
 *
 * Strategy:
 *   1. Write payload to <path>.tmp.
 *   2. Attempt fs.rename(tmp → final) up to MAX_RENAME_RETRIES times.
 *      Between attempts wait RENAME_RETRY_BASE_MS * 2^attempt ms
 *      (20 → 40 → 80 → 160 → 320 ms) so the OS handle is released.
 *   3. If all retries are exhausted, unlink the target to forcibly free
 *      the lock, then do one final rename.
 *   4. Absolute last resort: direct fs.writeFile (non-atomic, data-safe).
 */
const MAX_RENAME_RETRIES  = 5;
const RENAME_RETRY_BASE_MS = 20;

const saveSettingsToDisk = async (type, data) => {
    const finalPath = paths[type];
    const tmpPath   = `${finalPath}.tmp`;
    const payload   = JSON.stringify(data, null, 2);

    await fs.writeFile(tmpPath, payload, 'utf8');

    let lastErr;
    for (let attempt = 0; attempt <= MAX_RENAME_RETRIES; attempt++) {
        try {
            await fs.rename(tmpPath, finalPath);
            return; // success
        } catch (err) {
            if ((err.code === 'EPERM' || err.code === 'EACCES') && attempt < MAX_RENAME_RETRIES) {
                lastErr = err;
                await new Promise(r => setTimeout(r, RENAME_RETRY_BASE_MS * (2 ** attempt)));
            } else if (err.code === 'EPERM' || err.code === 'EACCES') {
                lastErr = err;
                break; // fall through to unlink+rename
            } else {
                throw err; // non-lock error — propagate immediately
            }
        }
    }

    // All retries exhausted — unlink target to release the OS handle, then rename.
    try {
        await fs.unlink(finalPath);
        await fs.rename(tmpPath, finalPath);
        return;
    } catch (unlinkOrRenameErr) {
        // Absolute last resort: direct overwrite.  Non-atomic but data-safe.
        console.warn(
            `[Warning] Atomic rename failed for ${finalPath} after ${MAX_RENAME_RETRIES} retries ` +
            `(${lastErr?.code}). Falling back to direct writeFile. Error: ${unlinkOrRenameErr.message}`
        );
        await fs.writeFile(finalPath, payload, 'utf8');
        await fs.unlink(tmpPath).catch(() => {}); // clean up orphaned .tmp
    }
};

export const getSettingsFilePath = (type) => {
    if (!(type in paths)) {
        throw new Error(`Unknown settings type: ${type}`);
    }
    return paths[type];
};

export const invalidateCache = (type) => {
    if (type in cache) {
        cache[type] = null;
    }
};

export const updateSettings = async (type, mutateFunction) => {
    writeQueue = writeQueue.then(async () => {
        const data = await getSettings(type);
        mutateFunction(data);
        await saveSettingsToDisk(type, data);
        cache[type] = data;
    }).catch(err => {
        console.error(`[Error Crítico] Fallo al escribir configuración ${type}:`, err);
        throw err;
    });

    await writeQueue;
};
