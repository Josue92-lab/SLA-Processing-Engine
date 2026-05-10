import multer from 'multer';
import path from 'path';
import fs from 'fs';

// Aseguramos que el directorio temporal exista antes de guardar nada
const uploadDir = path.resolve('./uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Configuración de almacenamiento local
const storage = multer.diskStorage({
    destination: function(req, file, cb) {
        cb(null, uploadDir);
    },
    filename: function(req, file, cb) {
        // Sanitización: Evitamos usar el nombre original directamente para prevenir Path Traversal
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, file.fieldname + '-' + uniqueSuffix + ext);
    }
});

// Filtro estricto de archivos
const fileFilter = (req, file, cb) => {
    // Expresión regular para extensiones permitidas
    const allowedExtensions = /xlsx|xls|csv/;
    const hasValidExtension = allowedExtensions.test(path.extname(file.originalname).toLowerCase());
    
    // Verificación de MIME types comunes para Excel y CSV
    const validMimeTypes = [
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
        'application/vnd.ms-excel', // .xls
        'text/csv' // .csv
    ];
    const hasValidMimeType = validMimeTypes.includes(file.mimetype);

    if (hasValidExtension && hasValidMimeType) {
        return cb(null, true);
    } else {
        // Rechazamos el archivo si no es Excel/CSV
        cb(new Error('Formato de archivo inválido. Solo se permiten archivos Excel (.xlsx, .xls) o CSV.'), false);
    }
};

// Instancia final de multer
const upload = multer({ 
    storage: storage,
    fileFilter: fileFilter,
    limits: {
        fileSize: 15 * 1024 * 1024, // Límite de 15 MB para evitar saturación de RAM/Disco
        files: 1 // Solo permitimos 1 archivo por petición
    }
});

export default upload;