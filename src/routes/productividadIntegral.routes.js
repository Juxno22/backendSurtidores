import { Router } from 'express';
import { productividadIntegralUsuarios } from '../controllers/productividadIntegral.controller.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';
import { requireRoles } from '../middlewares/roles.middleware.js';

const router = Router();

router.use(authMiddleware);
router.use(requireRoles('ADMIN', 'SUPERVISOR'));

router.get('/usuarios', productividadIntegralUsuarios);

export default router;
