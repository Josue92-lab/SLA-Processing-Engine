import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Rutas a tus archivos de configuración
const paths = {
    external: path.resolve(__dirname, '../routes/projectSettings_external.json'),
    internal: path.resolve(__dirname, '../routes/projectSettings_internal.json')
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
 * Guarda el objeto de configuración en el disco duro.
 * @param {string} type - 'external' o 'internal'
 * @param {Object} data - Objeto de configuración a guardar
 */
const saveSettingsToDisk = async (type, data) => {
    await fs.writeFile(paths[type], JSON.stringify(data, null, 2), 'utf8');
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