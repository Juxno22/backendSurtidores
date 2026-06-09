import { Router } from 'express';
import {
  listarUsuarios,
  obtenerUsuario,
  crearUsuario,
  actualizarUsuario,
  cambiarPasswordUsuario,
  cambiarMiPassword
} from '../controllers/usuarios.controller.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';
import { requireRoles } from '../middlewares/roles.middleware.js';

const router = Router();

router.use(authMiddleware);

router.patch('/me/password', cambiarMiPassword);

router.get('/', requireRoles('ADMIN', 'SUPERVISOR'), listarUsuarios);

router.get('/:id', requireRoles('ADMIN', 'SUPERVISOR'), obtenerUsuario);

router.post('/', requireRoles('ADMIN'), crearUsuario);

router.patch('/:id', requireRoles('ADMIN'), actualizarUsuario);

router.patch('/:id/password', requireRoles('ADMIN'), cambiarPasswordUsuario);

export default router;