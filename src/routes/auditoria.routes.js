import { Router } from 'express';
import {
  listarAuditoria,
  obtenerAuditoria
} from '../controllers/auditoria.controller.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';
import { requireRoles } from '../middlewares/roles.middleware.js';

const router = Router();

router.use(authMiddleware);

router.get('/', requireRoles('ADMIN', 'SUPERVISOR'), listarAuditoria);

router.get('/:id', requireRoles('ADMIN', 'SUPERVISOR'), obtenerAuditoria);

export default router;