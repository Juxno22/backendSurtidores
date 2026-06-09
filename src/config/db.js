import mysql from 'mysql2/promise';
import { env } from './env.js';

export const pool = mysql.createPool({
  host: env.DB_HOST,
  port: env.DB_PORT,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
  decimalNumbers: true,
  timezone: 'Z'
});

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
  const connection = await pool.getConnection();

  try {
    const [rows] = await connection.query(`
      SELECT
        DATABASE() AS database_name,
        NOW() AS server_time,
        VERSION() AS mysql_version
    `);

    return rows[0];
  } finally {
    connection.release();
  }
}