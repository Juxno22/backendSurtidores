import { Router } from 'express';
import {
    iniciarSesion,
    obtenerSesionActiva,
    listarSesiones,
    obtenerSesion,
    guardarAvance,
    finalizarSesion,
    cancelarSesion
} from '../controllers/productividadSesiones.controller.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';
import { requireRoles } from '../middlewares/roles.middleware.js';
import {
  ajustarSesionFinalizada,
  listarEventosSesion
} from '../controllers/ajustesSesiones.controller.js';

const router = Router();

router.use(authMiddleware);

router.post('/iniciar', requireRoles('ADMIN', 'SUPERVISOR', 'SURTIDOR'), iniciarSesion);

router.get('/activa', requireRoles('ADMIN', 'SUPERVISOR', 'SURTIDOR'), obtenerSesionActiva);

router.get('/', requireRoles('ADMIN', 'SUPERVISOR', 'SURTIDOR'), listarSesiones);

router.get('/:id', requireRoles('ADMIN', 'SUPERVISOR', 'SURTIDOR'), obtenerSesion);

router.patch('/:id/avance', requireRoles('ADMIN', 'SUPERVISOR', 'SURTIDOR'), guardarAvance);

router.post('/:id/finalizar', requireRoles('ADMIN', 'SUPERVISOR', 'SURTIDOR'), finalizarSesion);

router.post('/:id/cancelar', requireRoles('ADMIN', 'SUPERVISOR', 'SURTIDOR'), cancelarSesion);

router.get('/:id/eventos', requireRoles('ADMIN', 'SUPERVISOR'), listarEventosSesion);

router.patch('/:id/ajuste-admin', requireRoles('ADMIN', 'SUPERVISOR'), ajustarSesionFinalizada);

export default router;