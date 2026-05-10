/**
 * Middleware para capturar rutas no encontradas (404)
 */
export const notFoundHandler = (req, res, next) => {
    const error = new Error(`Ruta no encontrada - ${req.originalUrl}`);
    error.status = 404;
    next(error); // Pasa el error al manejador global
};

/**
 * Manejador Global de Errores
 * Captura cualquier error que ocurra en la aplicación y responde de manera segura.
 */
export const globalErrorHandler = (err, req, res, next) => {
    // 1. Log del error en el servidor (Aquí podrías conectar Winston o Datadog en el futuro)
    console.error(`[Error Global] ${err.status || 500} - ${err.message}`);
    if (err.stack) {
        console.error(err.stack);
    }

    // 2. Determinar el estado HTTP
    const status = err.status || 500;
    res.status(status);

    // 3. Responder al cliente
    // Si es una petición a la API (JSON), respondemos con JSON
    if (req.originalUrl.startsWith('/api/')) {
        return res.json({
            error: true,
            message: status === 500 ? 'Error interno del servidor' : err.message,
            // Solo enviar el stack trace si estamos en desarrollo
            ...(req.app.get('env') === 'development' && { trace: err.stack })
        });
    }

    // Si es una petición web normal, renderizamos la vista error.ejs
    res.render('error', {
        message: status === 500 ? 'Ha ocurrido un error inesperado.' : err.message,
        error: req.app.get('env') === 'development' ? err : {}
    });
};