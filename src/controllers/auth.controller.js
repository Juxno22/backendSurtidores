import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from '../config/db.js';
import { asyncHandler } from '../utils/asyncHandler.js';

function generarToken(usuario) {
  return jwt.sign(
    {
      id: usuario.id,
      rol: usuario.rol
    },
    process.env.JWT_SECRET,
    {
      expiresIn: process.env.JWT_EXPIRES_IN || '8h'
    }
  );
}

export const login = asyncHandler(async (req, res) => {
  const { usuario, password } = req.body;

  if (!usuario || !password) {
    return res.status(400).json({
      ok: false,
      message: 'Usuario y contraseña son obligatorios'
    });
  }

  const [usuarios] = await pool.query(
    `
    SELECT
      u.id,
      u.nombre,
      u.usuario,
      u.password_hash,
      u.rol,
      u.sucursal_id,
      s.nombre AS sucursal_nombre,
      u.activo
    FROM usuarios u
    LEFT JOIN sucursales s ON s.id = u.sucursal_id
    WHERE u.usuario = ?
    LIMIT 1
    `,
    [usuario.trim()]
  );

  if (usuarios.length === 0) {
    return res.status(401).json({
      ok: false,
      message: 'Usuario o contraseña incorrectos'
    });
  }

  const user = usuarios[0];

  if (!user.activo) {
    return res.status(403).json({
      ok: false,
      message: 'Usuario inactivo'
    });
  }

  const passwordCorrecta = await bcrypt.compare(password, user.password_hash);

  if (!passwordCorrecta) {
    return res.status(401).json({
      ok: false,
      message: 'Usuario o contraseña incorrectos'
    });
  }

  await pool.query(
    'UPDATE usuarios SET ultimo_login = NOW() WHERE id = ?',
    [user.id]
  );

  const token = generarToken(user);

  return res.json({
    ok: true,
    message: 'Login correcto',
    token,
    user: {
      id: user.id,
      nombre: user.nombre,
      usuario: user.usuario,
      rol: user.rol,
      sucursal_id: user.sucursal_id,
      sucursal_nombre: user.sucursal_nombre
    }
  });
});

export const me = asyncHandler(async (req, res) => {
  return res.json({
    ok: true,
    user: req.user
  });
});