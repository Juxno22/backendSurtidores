import { Router } from 'express';
import {
  guardarReporteGrupal,
  guardarReporteGrupalBulk,
  listarReportesGrupales,
  obtenerReporteGrupal,
  actualizarReporteGrupal,
  eliminarReporteGrupal,
  importarReporteGrupalExcel
} from '../controllers/reporteGrupal.controller.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';
import { requireRoles } from '../middlewares/roles.middleware.js';
import { uploadExcel } from '../middlewares/uploadExcel.middleware.js';

const router = Router();

router.use(authMiddleware);

router.get('/', requireRoles('ADMIN', 'SUPERVISOR'), listarReportesGrupales);

router.post('/', requireRoles('ADMIN', 'SUPERVISOR'), guardarReporteGrupal);

router.post('/bulk', requireRoles('ADMIN', 'SUPERVISOR'), guardarReporteGrupalBulk);

router.post('/importar-excel', requireRoles('ADMIN', 'SUPERVISOR'), uploadExcel.single('archivo'), importarReporteGrupalExcel
);

router.get('/:id', requireRoles('ADMIN', 'SUPERVISOR'), obtenerReporteGrupal);

router.patch('/:id', requireRoles('ADMIN', 'SUPERVISOR'), actualizarReporteGrupal);

router.delete('/:id', requireRoles('ADMIN'), eliminarReporteGrupal);

export default router;