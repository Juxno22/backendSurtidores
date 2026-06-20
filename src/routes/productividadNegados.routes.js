import { Router } from 'express';
import {
  listarMotivosNegados,
  listarNegados,
  revisarNegado
} from '../controllers/productividadNegados.controller.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';
import { requireRoles } from '../middlewares/roles.middleware.js';

const router = Router();

router.use(authMiddleware);

router.get('/motivos', requireRoles('ADMIN', 'SUPERVISOR', 'SURTIDOR'), listarMotivosNegados);
router.get('/', requireRoles('ADMIN', 'SUPERVISOR', 'SURTIDOR'), listarNegados);
router.patch('/:id/revision', requireRoles('ADMIN', 'SUPERVISOR'), revisarNegado);

export default router;
