import { Router } from 'express';
import {
  listarSucursales,
  crearSucursal,
  actualizarSucursal
} from '../controllers/sucursales.controller.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';
import { requireRoles } from '../middlewares/roles.middleware.js';

const router = Router();

router.get('/', authMiddleware, listarSucursales);

router.post('/', authMiddleware, requireRoles('ADMIN'), crearSucursal);

router.patch('/:id', authMiddleware, requireRoles('ADMIN'), actualizarSucursal);

export default router;