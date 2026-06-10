import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';

function buildLimiter({
  windowMs,
  max,
  message,
  skipSuccessfulRequests = false
}) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests,
    message: {
      ok: false,
      message
    }
  });
}

export const generalLimiter = buildLimiter({
  windowMs: env.RATE_LIMIT_GENERAL_WINDOW_MS,
  max: env.RATE_LIMIT_GENERAL_MAX,
  message: 'Demasiadas solicitudes. Intenta más tarde.'
});

export const authLimiter = buildLimiter({
  windowMs: env.RATE_LIMIT_AUTH_WINDOW_MS,
  max: env.RATE_LIMIT_AUTH_MAX,
  message: 'Demasiados intentos de acceso. Intenta más tarde.',
  skipSuccessfulRequests: true
});

export const uploadLimiter = buildLimiter({
  windowMs: env.RATE_LIMIT_UPLOAD_WINDOW_MS,
  max: env.RATE_LIMIT_UPLOAD_MAX,
  message: 'Demasiadas cargas de archivo. Intenta más tarde.'
});

export const exportLimiter = buildLimiter({
  windowMs: env.RATE_LIMIT_EXPORT_WINDOW_MS,
  max: env.RATE_LIMIT_EXPORT_MAX,
  message: 'Demasiadas exportaciones. Intenta más tarde.'
});