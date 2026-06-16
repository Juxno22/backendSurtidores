import { Router } from 'express';

import {
  recalcularSesiones
} from '../controllers/productividadMantenimiento.controller.js';

import {
  authMiddleware,
  requireRoles
} from '../middlewares/auth.middleware.js';

const router = Router();

router.use(authMiddleware);
router.use(requireRoles('ADMIN'));

router.post('/recalcular-sesiones', recalcularSesiones);

export default router;