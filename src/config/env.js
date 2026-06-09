import dotenv from 'dotenv';

dotenv.config();

function required(name, defaultValue = null) {
  const value = process.env[name] ?? defaultValue;

  if (value === null || value === undefined || value === '') {
    throw new Error(`Variable de entorno obligatoria faltante: ${name}`);
  }

  return value;
}

function optional(name, defaultValue = '') {
  return process.env[name] ?? defaultValue;
}

function numberEnv(name, defaultValue) {
  const raw = process.env[name];

  if (raw === undefined || raw === null || raw === '') {
    return defaultValue;
  }

  const number = Number(raw);

  if (!Number.isFinite(number)) {
    throw new Error(`Variable de entorno inválida: ${name} debe ser numérica`);
  }

  return number;
}

export const env = {
  NODE_ENV: optional('NODE_ENV', 'development'),
  PORT: numberEnv('PORT', 4000),

  DB_HOST: required('DB_HOST', 'localhost'),
  DB_PORT: numberEnv('DB_PORT', 3306),
  DB_USER: required('DB_USER', 'root'),
  DB_PASSWORD: optional('DB_PASSWORD', ''),
  DB_NAME: required('DB_NAME', 'db_productividad_surtidores'),

  JWT_SECRET: required('JWT_SECRET'),
  JWT_EXPIRES_IN: optional('JWT_EXPIRES_IN', '8h'),

  CORS_ORIGIN: optional('CORS_ORIGIN', 'http://localhost:3000'),

  RATE_LIMIT_WINDOW_MS: numberEnv('RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000),
  RATE_LIMIT_MAX: numberEnv('RATE_LIMIT_MAX', 300),

  BODY_LIMIT: optional('BODY_LIMIT', '5mb')
};

export function getAllowedOrigins() {
  return env.CORS_ORIGIN
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function isProduction() {
  return env.NODE_ENV === 'production';
}