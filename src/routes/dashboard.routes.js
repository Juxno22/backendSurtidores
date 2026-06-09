import { Router } from 'express';
import {
  resumenDia,
  surtidoresRanking,
  sucursalesRanking,
  pendientesDashboard,
  tendenciaDashboard
} from '../controllers/dashboard.controller.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';
import { requireRoles } from '../middlewares/roles.middleware.js';

const router = Router();

router.use(authMiddleware);
router.use(requireRoles('ADMIN', 'SUPERVISOR'));

router.get('/resumen-dia', resumenDia);
router.get('/surtidores-ranking', surtidoresRanking);
router.get('/sucursales-ranking', sucursalesRanking);
router.get('/pendientes', pendientesDashboard);
router.get('/tendencia', tendenciaDashboard);

export default router;