import { Router } from 'express';
import {
  obtenerComparativo,
  generarComparativo
} from '../controllers/comparativo.controller.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';
import { requireRoles } from '../middlewares/roles.middleware.js';

const router = Router();

router.use(authMiddleware);

router.get('/', requireRoles('ADMIN', 'SUPERVISOR'), obtenerComparativo);

router.post('/generar', requireRoles('ADMIN', 'SUPERVISOR'), generarComparativo);

export default router;