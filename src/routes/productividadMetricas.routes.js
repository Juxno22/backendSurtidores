import { Router } from 'express';
import { productividadJornada } from '../controllers/productividadMetricas.controller.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';
import { requireRoles } from '../middlewares/roles.middleware.js';

const router = Router();

router.use(authMiddleware);
router.use(requireRoles('ADMIN', 'SUPERVISOR'));

router.get('/jornada', productividadJornada);

export default router;
