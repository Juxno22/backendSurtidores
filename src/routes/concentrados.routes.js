import { Router } from 'express';
import {
  concentradoPorSurtidores,
  concentradoPorSucursales
} from '../controllers/concentrados.controller.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';
import { requireRoles } from '../middlewares/roles.middleware.js';

const router = Router();

router.use(authMiddleware);

router.get('/surtidores', requireRoles('ADMIN', 'SUPERVISOR', 'SURTIDOR'), concentradoPorSurtidores);

router.get('/sucursales', requireRoles('ADMIN', 'SUPERVISOR'), concentradoPorSucursales);

export default router;