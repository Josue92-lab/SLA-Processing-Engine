import express from 'express'; // Importación de Express para manejar rutas
const router = express.Router(); // Inicialización del enrutador

/* GET users listing. */
router.get('/', function(req, res, next) {
  res.send('respond with a resource');
});

export default router;
