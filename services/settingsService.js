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
 * On Windows, concurrent test loops can hold an open file handle that causes
 * fs.rename() to throw EPERM or EACCES. When that happens we fall back to:
 *   1. Unlinking the target to clear the OS lock.
 *   2. Renaming the .tmp file onto the now-free path.
 * If the unlink+rename also fails we fall back to a direct writeFile, which
 * is non-atomic but guarantees the data is never silently lost.
 */
const saveSettingsToDisk = async (type, data) => {
    const finalPath = paths[type];
    const tmpPath   = `${finalPath}.tmp`;
    const payload   = JSON.stringify(data, null, 2);

    await fs.writeFile(tmpPath, payload, 'utf8');

    try {
        await fs.rename(tmpPath, finalPath);
    } catch (renameErr) {
        if (renameErr.code === 'EPERM' || renameErr.code === 'EACCES') {
            // Windows file-handle lock: unlink the target to free it, then retry rename.
            try {
                await fs.unlink(finalPath);
                await fs.rename(tmpPath, finalPath);
            } catch (retryErr) {
                // Last resort: direct overwrite. Non-atomic but data-safe.
                console.warn(
                    `[Warning] Atomic rename failed for ${finalPath} (${retryErr.code}). ` +
                    `Falling back to direct writeFile.`
                );
                await fs.writeFile(finalPath, payload, 'utf8');
                // Clean up the orphaned .tmp if it still exists.
                await fs.unlink(tmpPath).catch(() => {});
            }
        } else {
            throw renameErr;
        }
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