import { Router } from 'express';
import { login, me } from '../controllers/auth.controller.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';

const router = Router();

router.post('/login', login);
router.get('/me', authMiddleware, me);

export default router;