import mysql from 'mysql2/promise';
import { env } from './env.js';

const RETRYABLE_DB_ERRORS = new Set([
  'ECONNRESET',
  'PROTOCOL_CONNECTION_LOST',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EPIPE'
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isRetryableDbError(error) {
  return RETRYABLE_DB_ERRORS.has(error?.code);
}

const rawPool = mysql.createPool({
  host: env.DB_HOST,
  port: env.DB_PORT,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,

  waitForConnections: true,
  connectionLimit: env.DB_CONNECTION_LIMIT || 10,
  queueLimit: 0,

  enableKeepAlive: true,
  keepAliveInitialDelay: 0,

  decimalNumbers: true,
  timezone: 'Z',

  connectTimeout: env.DB_CONNECT_TIMEOUT || 10000,

  /*
    Importante:
    mantenemos menos conexiones idle para evitar que el pool guarde
    muchas conexiones viejas que MySQL ya cerró por inactividad.
  */
  maxIdle: env.DB_MAX_IDLE || 5,
  idleTimeout: env.DB_IDLE_TIMEOUT || 60000
});

async function withDbRetry(operation, label = 'db-operation') {
  const maxRetries = env.DB_RETRY_ATTEMPTS || 3;
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (!isRetryableDbError(error) || attempt >= maxRetries) {
        throw error;
      }

      console.warn(`MySQL ${label} falló. Reintentando...`, {
        attempt,
        maxRetries,
        code: error.code,
        message: error.message
      });

      await sleep(150 * attempt);
    }
  }

  throw lastError;
}

async function getHealthyConnection() {
  const maxRetries = env.DB_RETRY_ATTEMPTS || 3;
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    let connection;

    try {
      connection = await rawPool.getConnection();

      /*
        ping detecta conexiones muertas antes de usarlas en una transacción.
        Si MySQL cerró la conexión por inactividad, aquí cae y pedimos otra.
      */
      await connection.ping();

      return connection;
    } catch (error) {
      lastError = error;

      try {
        connection?.destroy?.();
      } catch {}

      try {
        connection?.release?.();
      } catch {}

      if (!isRetryableDbError(error) || attempt >= maxRetries) {
        throw error;
      }

      console.warn('MySQL getConnection/ping falló. Reintentando...', {
        attempt,
        maxRetries,
        code: error.code,
        message: error.message
      });

      await sleep(150 * attempt);
    }
  }

  throw lastError;
}

export const pool = {
  query(sql, params) {
    return withDbRetry(
      () => rawPool.query(sql, params),
      'query'
    );
  },

  execute(sql, params) {
    return withDbRetry(
      () => rawPool.execute(sql, params),
      'execute'
    );
  },

  getConnection() {
    return getHealthyConnection();
  },

  end() {
    return rawPool.end();
  }
};

export async function testConnection() {
  const connection = await pool.getConnection();

  try {
    await connection.ping();
    return true;
  } finally {
    connection.release();
  }
}

export async function dbHealth() {
  return withDbRetry(async () => {
    const [rows] = await rawPool.query(`
      SELECT
        DATABASE() AS database_name,
        NOW() AS server_time,
        VERSION() AS mysql_version
    `);

    return rows[0];
  }, 'health');
}

let heartbeatTimer = null;

export function startDbHeartbeat() {
  const enabled = Number(env.DB_HEARTBEAT_ENABLED ?? 1) === 1;
  const intervalMs = env.DB_HEARTBEAT_INTERVAL_MS || 240000;

  if (!enabled || heartbeatTimer) return;

  heartbeatTimer = setInterval(async () => {
    try {
      await rawPool.query('SELECT 1');
    } catch (error) {
      console.warn('MySQL heartbeat falló:', {
        code: error.code,
        message: error.message
      });
    }
  }, intervalMs);

  heartbeatTimer.unref?.();

  console.log(`MySQL heartbeat activo cada ${intervalMs}ms`);
}

export function stopDbHeartbeat() {
  if (!heartbeatTimer) return;

  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}