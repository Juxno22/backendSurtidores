import jwt from 'jsonwebtoken';
import { pool } from '../config/db.js';

export async function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';

    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        ok: false,
        message: 'Token no proporcionado'
      });
    }

    const token = authHeader.replace('Bearer ', '').trim();

    if (!token) {
      return res.status(401).json({
        ok: false,
        message: 'Token inválido'
      });
    }

    const payload = jwt.verify(token, process.env.JWT_SECRET);

    const [usuarios] = await pool.query(
      `
      SELECT
        u.id,
        u.nombre,
        u.usuario,
        u.rol,
        u.sucursal_id,
        s.nombre AS sucursal_nombre,
        u.activo
      FROM usuarios u
      LEFT JOIN sucursales s ON s.id = u.sucursal_id
      WHERE u.id = ?
      LIMIT 1
      `,
      [payload.id]
    );

    if (usuarios.length === 0) {
      return res.status(401).json({
        ok: false,
        message: 'Usuario no encontrado'
      });
    }

    const usuario = usuarios[0];

    if (!usuario.activo) {
      return res.status(403).json({
        ok: false,
        message: 'Usuario inactivo'
      });
    }

    req.user = {
      id: usuario.id,
      nombre: usuario.nombre,
      usuario: usuario.usuario,
      rol: usuario.rol,
      sucursal_id: usuario.sucursal_id,
      sucursal_nombre: usuario.sucursal_nombre
    };

    next();
  } catch (error) {
    console.error('Error authMiddleware:', error);

    return res.status(401).json({
      ok: false,
      message: 'Sesión inválida o expirada'
    });
  }
}

export function requireRoles(...rolesPermitidos) {
  return function requireRolesMiddleware(req, res, next) {
    if (!req.user) {
      return res.status(401).json({
        ok: false,
        message: 'Sesión requerida'
      });
    }

    const rolUsuario = String(req.user.rol || '').toUpperCase();

    const rolesNormalizados = rolesPermitidos.map((rol) =>
      String(rol || '').toUpperCase()
    );

    if (!rolesNormalizados.includes(rolUsuario)) {
      return res.status(403).json({
        ok: false,
        message: 'No tienes permisos para realizar esta acción'
      });
    }

    next();
  };
}