import { Router } from 'express';

import {
  importarNegadosMayoreo,
  importarReporteSurtidoresMayoreo,
  listarNegadosMayoreo,
  listarPendientesVincularMayoreo,
  listarReportesSurtidoresMayoreo,
  productividadMayoreo,
  resumenMayoreo
} from '../controllers/mayoreo.controller.js';

import { authMiddleware } from '../middlewares/auth.middleware.js';
import { requireRoles } from '../middlewares/roles.middleware.js';
import { uploadExcel } from '../middlewares/uploadExcel.middleware.js';

const router = Router();

router.use(authMiddleware);
router.use(requireRoles('ADMIN', 'SUPERVISOR'));

router.get('/resumen', resumenMayoreo);
router.get('/productividad', productividadMayoreo);
router.get('/reportes-surtidores', listarReportesSurtidoresMayoreo);
router.get('/negados', listarNegadosMayoreo);
router.get('/pendientes-vincular', listarPendientesVincularMayoreo);

router.post('/reportes-surtidores/importar-excel', uploadExcel.single('archivo'), importarReporteSurtidoresMayoreo);
router.post('/negados/importar-excel', uploadExcel.single('archivo'), importarNegadosMayoreo);

export default router;
