import { Router } from 'express';
import {
  listarSurtidores,
  crearSurtidor,
  actualizarSurtidor
} from '../controllers/surtidores.controller.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';
import { requireRoles } from '../middlewares/roles.middleware.js';

const router = Router();

router.get('/', authMiddleware, requireRoles('ADMIN', 'SUPERVISOR'), listarSurtidores);

router.post('/',  authMiddleware, requireRoles('ADMIN', 'SUPERVISOR'), crearSurtidor);

router.patch('/:id', authMiddleware, requireRoles('ADMIN', 'SUPERVISOR'),
actualizarSurtidor);

export default router;