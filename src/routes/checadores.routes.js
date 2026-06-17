import { Router } from 'express';
import {
  listarChecadores,
  crearChecador,
  actualizarChecador,
  vincularChecadoresUsuarios,
  importarReporteChecadoresExcel,
  dashboardChecadores,
  listarReportesChecadores
} from '../controllers/checadores.controller.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';
import { requireRoles } from '../middlewares/roles.middleware.js';
import { uploadExcel } from '../middlewares/uploadExcel.middleware.js';
import {
  listarDetalleChecadores,
  obtenerDetalleChecador
} from '../controllers/checadoresDetalle.controller.js';

const router = Router();

router.use(authMiddleware);
router.use(requireRoles('ADMIN', 'SUPERVISOR'));

router.get('/', listarChecadores);
router.post('/', requireRoles('ADMIN'), crearChecador);
router.post('/vincular-usuarios', requireRoles('ADMIN'), vincularChecadoresUsuarios);
router.get('/detalle', listarDetalleChecadores);
router.get('/detalle/:id', obtenerDetalleChecador);
router.patch('/:id', requireRoles('ADMIN'), actualizarChecador);

router.post('/importar-excel', uploadExcel.single('archivo'), importarReporteChecadoresExcel);
router.get('/dashboard', dashboardChecadores);
router.get('/reportes', listarReportesChecadores);

export default router;
