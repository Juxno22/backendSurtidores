import { Router } from 'express';
import {
  exportarConcentradoSurtidores,
  exportarConcentradoSucursales,
  exportarComparativo,
  exportarSesiones,
  exportarDashboardDia,
  exportarMetricasJornada,
  exportarReporteGrupal,
  exportarChecadores
} from '../controllers/exportaciones.controller.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';
import { requireRoles } from '../middlewares/roles.middleware.js';

const router = Router();

router.use(authMiddleware);
router.use(requireRoles('ADMIN', 'SUPERVISOR'));

router.get('/concentrado-surtidores', exportarConcentradoSurtidores);
router.get('/concentrado-sucursales', exportarConcentradoSucursales);
router.get('/comparativo', exportarComparativo);
router.get('/sesiones', exportarSesiones);
router.get('/dashboard-dia', exportarDashboardDia);
router.get('/metricas-jornada', exportarMetricasJornada);
router.get('/reporte-grupal', exportarReporteGrupal);
router.get('/checadores', exportarChecadores);

export default router;
