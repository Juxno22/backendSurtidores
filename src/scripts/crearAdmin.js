import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import { pool } from '../config/db.js';

dotenv.config();

async function crearAdmin() {
  const nombre = process.env.ADMIN_NOMBRE || 'Administrador';
  const usuario = process.env.ADMIN_USUARIO || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'Admin123*';

  const passwordHash = await bcrypt.hash(password, 10);

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [existente] = await connection.query(
      'SELECT id FROM usuarios WHERE usuario = ? LIMIT 1',
      [usuario]
    );

    if (existente.length > 0) {
      await connection.query(
        `
        UPDATE usuarios
        SET nombre = ?, password_hash = ?, rol = 'ADMIN', activo = 1
        WHERE usuario = ?
        `,
        [nombre, passwordHash, usuario]
      );

      await connection.commit();

      console.log('Usuario ADMIN actualizado correctamente.');
      console.log(`Usuario: ${usuario}`);
      console.log(`Password: ${password}`);
      return;
    }

    await connection.query(
      `
      INSERT INTO usuarios (nombre, usuario, password_hash, rol, activo)
      VALUES (?, ?, ?, 'ADMIN', 1)
      `,
      [nombre, usuario, passwordHash]
    );

    await connection.commit();

    console.log('Usuario ADMIN creado correctamente.');
    console.log(`Usuario: ${usuario}`);
    console.log(`Password: ${password}`);
  } catch (error) {
    await connection.rollback();
    console.error('Error creando ADMIN:', error);
    process.exitCode = 1;
  } finally {
    connection.release();
    await pool.end();
  }
}

crearAdmin();