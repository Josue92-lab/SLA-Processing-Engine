import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Rutas a tus archivos de configuración.
// Los JSON viven en /config/ (separados de /routes/ que contiene lógica HTTP).
const paths = {
    external: path.resolve(__dirname, '../config/projectSettings_external.json'),
    internal: path.resolve(__dirname, '../config/projectSettings_internal.json')
};

// Estructura por defecto si el archivo no existe o está corrupto
const defaultSettings = {
    excludedEmails: [],
    vipUsers: [],
    emailTimeZoneMappings: {},
    emailCountries: [],
    allowedCountries: []
};

// Caché en memoria para evitar lecturas constantes a disco
const cache = {
    external: null,
    internal: null
};

// Cola de promesas para evitar Race Conditions durante escrituras concurrentes
let writeQueue = Promise.resolve();

/**
 * Obtiene la configuración desde la caché (o la lee del disco si no está cacheada)
 * @param {string} type - 'external' o 'internal'
 * @returns {Promise<Object>} El objeto de configuración
 */
export const getSettings = async (type) => {
    // Retorno rápido desde caché
    if (cache[type]) return cache[type];

    try {
        const rawData = await fs.readFile(paths[type], 'utf8');
        cache[type] = JSON.parse(rawData);
    } catch (error) {
        // Si el archivo no existe (ENOENT) o el JSON es inválido, inicializar por defecto
        console.warn(`[Warning] No se pudo leer ${paths[type]}, inicializando por defecto. Razón: ${error.message}`);
        cache[type] = { ...defaultSettings };
        await saveSettingsToDisk(type, cache[type]);
    }

    return cache[type];
};

/**
 * Guarda el objeto de configuración en el disco duro de forma ATÓMICA.
 *
 * Estrategia write-temp-then-rename:
 *  1. Serializamos el JSON a un archivo temporal hermano (<path>.tmp).
 *  2. Hacemos rename() sobre el archivo final.
 *
 * rename() es atómico en el mismo sistema de archivos (POSIX y Windows
 * modernos), por lo que nunca quedamos con un JSON truncado / corrupto.
 * Antes de este cambio, un crash a mitad de writeFile dejaba el archivo
 * parcial → al siguiente arranque se tomaba el fallback `defaultSettings`
 * y se perdían silenciosamente las listas de VIPs y excluidos.
 *
 * @param {string} type - 'external' o 'internal'
 * @param {Object} data - Objeto de configuración a guardar
 */
const saveSettingsToDisk = async (type, data) => {
    const finalPath = paths[type];
    const tmpPath = `${finalPath}.tmp`;
    const payload = JSON.stringify(data, null, 2);

    await fs.writeFile(tmpPath, payload, 'utf8');
    await fs.rename(tmpPath, finalPath);
};

/**
 * Actualiza la configuración de forma segura (Atómica).
 * Garantiza que múltiples peticiones simultáneas no corrompan el archivo.
 * * @param {string} type - 'external' o 'internal'
 * @param {Function} mutateFunction - Función síncrona que modifica el objeto de settings
 */
export const updateSettings = async (type, mutateFunction) => {
    // Añadimos la operación al final de la cola
    writeQueue = writeQueue.then(async () => {
        // 1. Obtener la última versión de la configuración
        const data = await getSettings(type);
        
        // 2. Aplicar la mutación solicitada por la ruta
        mutateFunction(data);
        
        // 3. Persistir en disco
        await saveSettingsToDisk(type, data);
        
        // 4. Actualizar caché
        cache[type] = data;
    }).catch(err => {
        // Capturamos el error para no detener la cola, pero lo relanzamos
        console.error(`[Error Crítico] Fallo al escribir configuración ${type}:`, err);
        throw err;
    });

    // Esperar a que esta operación específica termine
    await writeQueue;
};