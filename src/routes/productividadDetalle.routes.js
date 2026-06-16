import { Router } from 'express';

import {
  listarDetalleSurtidores,
  obtenerDetalleSurtidor
} from '../controllers/productividadDetalle.controller.js';

import { authMiddleware, requireRoles } from '../middlewares/auth.middleware.js';

const router = Router();

router.use(authMiddleware);
router.use(requireRoles('ADMIN', 'SUPERVISOR'));

router.get('/surtidores', listarDetalleSurtidores);
router.get('/surtidores/:id', obtenerDetalleSurtidor);

export default router;