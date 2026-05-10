// Importaciones de módulos nativos de Node.js
import fs from 'fs/promises';

// Importaciones de paquetes de terceros
import express from 'express';

// Importaciones locales
import upload from './multerConfig.js';
import processExcelFile from './excelProcessor.js';
import { getSettings, updateSettings } from '../services/settingsService.js';

// Inicialización del router de Express
const router = express.Router();

/* ==========================================================
 * RUTAS DE VISTAS (FRONTEND)
 * ========================================================== */

// Ruta principal para mostrar la página de carga de archivos
router.get('/', (req, res) => {
    res.render('index', { title: 'Generador Base Datos SLA' });
});

// Ruta principal para mostrar la página de configuraciones
router.get('/settings', (req, res) => {
    res.render('settings');
});

/* ==========================================================
 * RUTA DE PROCESAMIENTO DE EXCEL (CARGA)
 * ========================================================== */

router.post('/', upload.single('file'), async (req, res, next) => {
    // Si Multer rechaza el archivo (tamaño o extensión), req.file será undefined
    if (!req.file) {
        return res.status(400).render('error', {
            message: 'Error de carga',
            error: { status: 400, stack: 'No se subió ningún archivo, superó el límite de tamaño, o el formato es inválido.' }
        });
    }

    const uploadedFilePath = req.file.path;
    let processedFilePath = null;

    try {
        // 1. Cargar las configuraciones usando el Servicio Cacheado
        const type = req.body.configType || 'external';
        const settingsData = await getSettings(type);

        // 2. Procesar el Excel
        processedFilePath = await processExcelFile(
            uploadedFilePath, 
            settingsData.vipUsers, 
            settingsData.emailTimeZoneMappings,
            settingsData.excludedEmails,
            settingsData.emailCountries,
            settingsData.allowedCountries
        );

        // 3. Enviar el resultado al cliente
        res.download(processedFilePath, async (err) => {
            if (err) {
                console.error('Error al enviar el archivo al cliente:', err);
            }
            
            // FASE DE LIMPIEZA POST-DESCARGA
            try {
                await fs.unlink(uploadedFilePath).catch(() => {});
                if (processedFilePath) {
                    await fs.unlink(processedFilePath).catch(() => {});
                }
            } catch (cleanupErr) {
                console.error('Error limpiando archivos temporales:', cleanupErr);
            }
        });

    } catch (error) {
        console.error('Error durante el procesamiento del Excel:', error);
        
        // LIMPIEZA EN CASO DE ERROR
        if (uploadedFilePath) await fs.unlink(uploadedFilePath).catch(() => {});
        if (processedFilePath) await fs.unlink(processedFilePath).catch(() => {});

        res.status(500).render('error', { 
            message: 'Error procesando el archivo Excel. Asegúrate de que las columnas coincidan.', 
            error: req.app.get('env') === 'development' ? error : {} 
        });
    }
});

/* ==========================================================
 * RUTAS DE LA API DE CONFIGURACIONES (SETTINGS REST API)
 * ========================================================== */

// Obtener todas las configuraciones
router.get('/api/settings/:type', async (req, res) => {
    try {
        const settings = await getSettings(req.params.type);
        res.json(settings);
    } catch (error) {
        console.error('Error leyendo configuraciones:', error);
        res.status(500).json({ error: 'Error interno leyendo configuraciones' });
    }
});

// --- Excluded Emails ---

router.post('/api/settings/:type/excludedEmails', async (req, res) => {
    try {
        const emailToAdd = req.body.email;
        await updateSettings(req.params.type, (settings) => {
            if (!settings.excludedEmails.includes(emailToAdd)) {
                settings.excludedEmails.push(emailToAdd);
            }
        });
        res.json({ message: 'Excluded Email added successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Error guardando Excluded Email' });
    }
});

router.delete('/api/settings/:type/excludedEmails', async (req, res) => {
    try {
        const emailToRemove = req.body.email;
        await updateSettings(req.params.type, (settings) => {
            settings.excludedEmails = settings.excludedEmails.filter(e => e !== emailToRemove);
        });
        res.json({ message: 'Excluded Email removed successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Error eliminando Excluded Email' });
    }
});

// --- VIP Users ---

router.post('/api/settings/:type/vipUsers', async (req, res) => {
    try {
        const newUser = { name: req.body.name };
        await updateSettings(req.params.type, (settings) => {
            const exists = settings.vipUsers.some(user => user.name === newUser.name);
            if (!exists) {
                settings.vipUsers.push(newUser);
            }
        });
        res.json({ message: 'VIP User added successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Error guardando VIP User' });
    }
});

router.delete('/api/settings/:type/vipUsers', async (req, res) => {
    try {
        const userToRemove = req.body.name;
        await updateSettings(req.params.type, (settings) => {
            settings.vipUsers = settings.vipUsers.filter(user => user.name !== userToRemove);
        });
        res.json({ message: 'VIP User removed successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Error eliminando VIP User' });
    }
});

// --- Email Time Zone Mappings ---

router.post('/api/settings/:type/emailTimeZoneMappings', async (req, res) => {
    try {
        const { email, timezone } = req.body;
        await updateSettings(req.params.type, (settings) => {
            settings.emailTimeZoneMappings[email] = timezone;
        });
        res.json({ message: 'Email Time Zone Mapping added/updated successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Error guardando Time Zone Mapping' });
    }
});

router.delete('/api/settings/:type/emailTimeZoneMappings', async (req, res) => {
    try {
        const emailToRemove = req.body.email;
        await updateSettings(req.params.type, (settings) => {
            delete settings.emailTimeZoneMappings[emailToRemove];
        });
        res.json({ message: 'Email Time Zone Mapping removed successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Error eliminando Time Zone Mapping' });
    }
});

// --- Email Countries ---

router.post('/api/settings/:type/emailCountries', async (req, res) => {
    try {
        const newMapping = { Email: req.body.email, Country: req.body.country };
        await updateSettings(req.params.type, (settings) => {
            // Eliminar si ya existe el correo para actualizarlo
            settings.emailCountries = settings.emailCountries.filter(c => c.Email !== newMapping.Email);
            settings.emailCountries.push(newMapping);
        });
        res.json({ message: 'Email Country Mapping added/updated successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Error guardando Email Country Mapping' });
    }
});

router.delete('/api/settings/:type/emailCountries', async (req, res) => {
    try {
        const emailToRemove = req.body.email;
        await updateSettings(req.params.type, (settings) => {
            settings.emailCountries = settings.emailCountries.filter(c => c.Email !== emailToRemove);
        });
        res.json({ message: 'Email Country Mapping removed successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Error eliminando Email Country Mapping' });
    }
});

// --- Allowed Countries ---

router.post('/api/settings/:type/allowedCountries', async (req, res) => {
    try {
        const newCountry = req.body.country;
        await updateSettings(req.params.type, (settings) => {
            if (!settings.allowedCountries.includes(newCountry)) {
                settings.allowedCountries.push(newCountry);
            }
        });
        res.json({ message: 'Allowed Country added successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Error guardando Allowed Country' });
    }
});

router.delete('/api/settings/:type/allowedCountries', async (req, res) => {
    try {
        const countryToRemove = req.body.country;
        await updateSettings(req.params.type, (settings) => {
            settings.allowedCountries = settings.allowedCountries.filter(country => country !== countryToRemove);
        });
        res.json({ message: 'Allowed Country removed successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Error eliminando Allowed Country' });
    }
});

export default router;