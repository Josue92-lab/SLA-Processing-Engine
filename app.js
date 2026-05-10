import express from 'express';
import path from 'path';
import cookieParser from 'cookie-parser';
import logger from 'morgan';
import helmet from 'helmet';
import { fileURLToPath } from 'url';

// Importación de rutas
import indexRouter from './routes/index.js';

// Importación de middlewares personalizados
import { notFoundHandler, globalErrorHandler } from './middleware/errorHandler.js';

// Configuración para __dirname en ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// --- CONFIGURACIÓN DEL MOTOR DE VISTAS (EJS) ---
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

// --- MIDDLEWARES GLOBALES DE SEGURIDAD Y RENDIMIENTO ---
// Helmet protege la aplicación configurando cabeceras HTTP de seguridad
app.use(helmet({
    contentSecurityPolicy: false, // Desactivado temporalmente si tus vistas EJS usan scripts inline (CDN de Bootstrap/jQuery)
}));

app.use(logger('dev'));

// Parseo de cuerpos de peticiones (Aumentamos el límite para JSON si fuera necesario en el futuro)
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(cookieParser());

// Servir archivos estáticos (CSS, JS del cliente, imágenes)
app.use(express.static(path.join(__dirname, 'public')));

// --- ENRUTAMIENTO ---
app.use('/', indexRouter);

// --- MANEJO DE ERRORES ---
// 1. Capturar 404 y reenviar al manejador de errores
app.use(notFoundHandler);

// 2. Manejador de errores global
app.use(globalErrorHandler);

export default app;