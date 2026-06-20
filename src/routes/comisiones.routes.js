import { Router } from 'express';

import {
  calcularComisiones,
  crearIncidencia,
  detallePeriodo,
  listarIncidencias,
  listarPeriodos,
  resolverIncidencia
} from '../controllers/comisiones.controller.js';

import { authMiddleware, requireRoles } from '../middlewares/auth.middleware.js';

const router = Router();

router.use(authMiddleware);
router.use(requireRoles('ADMIN', 'SUPERVISOR'));

router.post('/calcular', calcularComisiones);
router.get('/periodos', listarPeriodos);
router.get('/periodos/:id', detallePeriodo);

router.get('/incidencias', listarIncidencias);
router.post('/incidencias', crearIncidencia);
router.patch('/incidencias/:id/resolver', resolverIncidencia);

export default router;
