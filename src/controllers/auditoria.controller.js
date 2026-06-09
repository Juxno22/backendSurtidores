import { pool } from '../config/db.js';
import { asyncHandler } from '../utils/asyncHandler.js';

function toPositiveId(value, fieldName) {
  const id = Number(value);

  if (!Number.isInteger(id) || id <= 0) {
    const error = new Error(`${fieldName} inválido`);
    error.status = 400;
    throw error;
  }

  return id;
}

function toPositiveIdOptional(value, fieldName) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  return toPositiveId(value, fieldName);
}

function validarFechaOptional(value, fieldName) {
  if (!value) return null;

  const fecha = String(value).trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    const error = new Error(`${fieldName} debe tener formato YYYY-MM-DD`);
    error.status = 400;
    throw error;
  }

  return fecha;
}

function parseJsonSafe(value) {
  if (!value) return null;

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export const listarAuditoria = asyncHandler(async (req, res) => {
  const {
    modulo,
    accion,
    entidad,
    entidad_id,
    usuario_id,
    desde,
    hasta,
    limit = 200
  } = req.query;

  const where = [];
  const params = [];

  if (modulo) {
    where.push('a.modulo = ?');
    params.push(String(modulo).trim().toUpperCase());
  }

  if (accion) {
    where.push('a.accion = ?');
    params.push(String(accion).trim().toUpperCase());
  }

  if (entidad) {
    where.push('a.entidad = ?');
    params.push(String(entidad).trim());
  }

  if (entidad_id) {
    where.push('a.entidad_id = ?');
    params.push(String(entidad_id).trim());
  }

  const usuarioId = toPositiveIdOptional(usuario_id, 'usuario_id');

  if (usuarioId) {
    where.push('a.usuario_id = ?');
    params.push(usuarioId);
  }

  const desdeFecha = validarFechaOptional(desde, 'desde');
  const hastaFecha = validarFechaOptional(hasta, 'hasta');

  if (desdeFecha) {
    where.push('DATE(a.created_at) >= ?');
    params.push(desdeFecha);
  }

  if (hastaFecha) {
    where.push('DATE(a.created_at) <= ?');
    params.push(hastaFecha);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 1000);

  const [rows] = await pool.query(
    `
    SELECT
      a.id,
      a.usuario_id,
      u.nombre AS usuario_nombre,
      u.usuario,
      u.rol,

      a.modulo,
      a.accion,
      a.entidad,
      a.entidad_id,

      a.datos_antes,
      a.datos_despues,

      a.ip,
      a.user_agent,
      a.created_at
    FROM auditoria_acciones a
    LEFT JOIN usuarios u ON u.id = a.usuario_id
    ${whereSql}
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT ${safeLimit}
    `,
    params
  );

  res.json({
    ok: true,
    auditoria: rows.map((row) => ({
      ...row,
      datos_antes: parseJsonSafe(row.datos_antes),
      datos_despues: parseJsonSafe(row.datos_despues)
    }))
  });
});

export const obtenerAuditoria = asyncHandler(async (req, res) => {
  const id = toPositiveId(req.params.id, 'ID de auditoría');

  const [rows] = await pool.query(
    `
    SELECT
      a.id,
      a.usuario_id,
      u.nombre AS usuario_nombre,
      u.usuario,
      u.rol,

      a.modulo,
      a.accion,
      a.entidad,
      a.entidad_id,

      a.datos_antes,
      a.datos_despues,

      a.ip,
      a.user_agent,
      a.created_at
    FROM auditoria_acciones a
    LEFT JOIN usuarios u ON u.id = a.usuario_id
    WHERE a.id = ?
    LIMIT 1
    `,
    [id]
  );

  if (rows.length === 0) {
    return res.status(404).json({
      ok: false,
      message: 'Registro de auditoría no encontrado'
    });
  }

  const auditoria = rows[0];

  res.json({
    ok: true,
    auditoria: {
      ...auditoria,
      datos_antes: parseJsonSafe(auditoria.datos_antes),
      datos_despues: parseJsonSafe(auditoria.datos_despues)
    }
  });
});