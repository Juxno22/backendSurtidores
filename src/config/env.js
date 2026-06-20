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

  APP_TIMEZONE: optional('APP_TIMEZONE', 'America/Mexico_City'),

  DB_HOST: required('DB_HOST', 'localhost'),
  DB_PORT: numberEnv('DB_PORT', 3306),
  DB_USER: required('DB_USER', 'root'),
  DB_PASSWORD: optional('DB_PASSWORD', ''),
  DB_NAME: required('DB_NAME', 'db_productividad_surtidores'),

  JORNADA_LV_INICIO: optional('JORNADA_LV_INICIO', '10:00'),
  JORNADA_LV_FIN: optional('JORNADA_LV_FIN', '19:00'),
  JORNADA_LV_COMIDA_INICIO: optional('JORNADA_LV_COMIDA_INICIO', '14:00'),
  JORNADA_LV_COMIDA_FIN: optional('JORNADA_LV_COMIDA_FIN', '15:00'),

  JORNADA_SABADO_INICIO: optional('JORNADA_SABADO_INICIO', '09:00'),
  JORNADA_SABADO_FIN: optional('JORNADA_SABADO_FIN', '18:00'),
  JORNADA_SABADO_COMIDA_INICIO: optional('JORNADA_SABADO_COMIDA_INICIO', '14:30'),
  JORNADA_SABADO_COMIDA_FIN: optional('JORNADA_SABADO_COMIDA_FIN', '15:30'),

  JORNADA_MAYOREO_INICIO: optional('JORNADA_MAYOREO_INICIO', '17:00'),
  JORNADA_MAYOREO_FIN: optional('JORNADA_MAYOREO_FIN', '02:00'),
  JORNADA_MAYOREO_COMIDA_INICIO: optional('JORNADA_MAYOREO_COMIDA_INICIO', '22:00'),
  JORNADA_MAYOREO_COMIDA_FIN: optional('JORNADA_MAYOREO_COMIDA_FIN', '23:00'),

  DB_CONNECTION_LIMIT: numberEnv('DB_CONNECTION_LIMIT', 10),
  DB_MAX_IDLE: numberEnv('DB_MAX_IDLE', 5),
  DB_IDLE_TIMEOUT: numberEnv('DB_IDLE_TIMEOUT', 60000),
  DB_CONNECT_TIMEOUT: numberEnv('DB_CONNECT_TIMEOUT', 10000),

  DB_RETRY_ATTEMPTS: numberEnv('DB_RETRY_ATTEMPTS', 3),

  DB_HEARTBEAT_ENABLED: numberEnv('DB_HEARTBEAT_ENABLED', 1),
  DB_HEARTBEAT_INTERVAL_MS: numberEnv('DB_HEARTBEAT_INTERVAL_MS', 240000),

  JWT_SECRET: required('JWT_SECRET'),
  JWT_EXPIRES_IN: optional('JWT_EXPIRES_IN', '8h'),

  CORS_ORIGIN: optional('CORS_ORIGIN', 'https://productividad.diagsa.cloud'),

  TRUST_PROXY: numberEnv('TRUST_PROXY', 1),

  RATE_LIMIT_GENERAL_WINDOW_MS: numberEnv('RATE_LIMIT_GENERAL_WINDOW_MS', 15 * 60 * 1000),
  RATE_LIMIT_GENERAL_MAX: numberEnv('RATE_LIMIT_GENERAL_MAX', 10000),

  RATE_LIMIT_AUTH_WINDOW_MS: numberEnv('RATE_LIMIT_AUTH_WINDOW_MS', 15 * 60 * 1000),
  RATE_LIMIT_AUTH_MAX: numberEnv('RATE_LIMIT_AUTH_MAX', 120),

  RATE_LIMIT_UPLOAD_WINDOW_MS: numberEnv('RATE_LIMIT_UPLOAD_WINDOW_MS', 15 * 60 * 1000),
  RATE_LIMIT_UPLOAD_MAX: numberEnv('RATE_LIMIT_UPLOAD_MAX', 300),

  RATE_LIMIT_EXPORT_WINDOW_MS: numberEnv('RATE_LIMIT_EXPORT_WINDOW_MS', 15 * 60 * 1000),
  RATE_LIMIT_EXPORT_MAX: numberEnv('RATE_LIMIT_EXPORT_MAX', 500),

  BODY_LIMIT: optional('BODY_LIMIT', '5mb'),
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