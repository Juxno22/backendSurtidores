import { pool } from '../config/db.js';
import { asyncHandler } from '../utils/asyncHandler.js';

function generarClaveSucursal(nombre) {
  return String(nombre || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export const listarSucursales = asyncHandler(async (req, res) => {
  const { activo, search } = req.query;

  const where = [];
  const params = [];

  if (activo !== undefined && activo !== '') {
    where.push('activo = ?');
    params.push(Number(activo) === 1 ? 1 : 0);
  }

  if (search && search.trim()) {
    where.push('(nombre LIKE ? OR clave LIKE ?)');
    params.push(`%${search.trim()}%`, `%${search.trim()}%`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [sucursales] = await pool.query(
    `
    SELECT
      id,
      nombre,
      clave,
      activo,
      created_at,
      updated_at
    FROM sucursales
    ${whereSql}
    ORDER BY activo DESC, nombre ASC
    `,
    params
  );

  res.json({
    ok: true,
    sucursales
  });
});

export const crearSucursal = asyncHandler(async (req, res) => {
  const nombre = String(req.body.nombre || '').trim();
  const claveBody = String(req.body.clave || '').trim();

  if (!nombre) {
    return res.status(400).json({
      ok: false,
      message: 'El nombre de la sucursal es obligatorio'
    });
  }

  const clave = claveBody ? generarClaveSucursal(claveBody) : generarClaveSucursal(nombre);

  const [existente] = await pool.query(
    'SELECT id FROM sucursales WHERE nombre = ? LIMIT 1',
    [nombre]
  );

  if (existente.length > 0) {
    return res.status(409).json({
      ok: false,
      message: 'Ya existe una sucursal con ese nombre'
    });
  }

  const [result] = await pool.query(
    `
    INSERT INTO sucursales (nombre, clave, activo)
    VALUES (?, ?, 1)
    `,
    [nombre, clave || null]
  );

  const [nuevaSucursal] = await pool.query(
    `
    SELECT
      id,
      nombre,
      clave,
      activo,
      created_at,
      updated_at
    FROM sucursales
    WHERE id = ?
    LIMIT 1
    `,
    [result.insertId]
  );

  res.status(201).json({
    ok: true,
    message: 'Sucursal creada correctamente',
    sucursal: nuevaSucursal[0]
  });
});

export const actualizarSucursal = asyncHandler(async (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({
      ok: false,
      message: 'ID de sucursal inválido'
    });
  }

  const [actualRows] = await pool.query(
    'SELECT * FROM sucursales WHERE id = ? LIMIT 1',
    [id]
  );

  if (actualRows.length === 0) {
    return res.status(404).json({
      ok: false,
      message: 'Sucursal no encontrada'
    });
  }

  const actual = actualRows[0];

  const nombre = req.body.nombre !== undefined
    ? String(req.body.nombre || '').trim()
    : actual.nombre;

  const clave = req.body.clave !== undefined
    ? generarClaveSucursal(req.body.clave)
    : actual.clave;

  const activo = req.body.activo !== undefined
    ? (Number(req.body.activo) === 1 ? 1 : 0)
    : actual.activo;

  if (!nombre) {
    return res.status(400).json({
      ok: false,
      message: 'El nombre de la sucursal no puede ir vacío'
    });
  }

  if (nombre !== actual.nombre) {
    const [duplicado] = await pool.query(
      'SELECT id FROM sucursales WHERE nombre = ? AND id <> ? LIMIT 1',
      [nombre, id]
    );

    if (duplicado.length > 0) {
      return res.status(409).json({
        ok: false,
        message: 'Ya existe otra sucursal con ese nombre'
      });
    }
  }

  await pool.query(
    `
    UPDATE sucursales
    SET nombre = ?, clave = ?, activo = ?
    WHERE id = ?
    `,
    [nombre, clave || null, activo, id]
  );

  const [sucursalActualizada] = await pool.query(
    `
    SELECT
      id,
      nombre,
      clave,
      activo,
      created_at,
      updated_at
    FROM sucursales
    WHERE id = ?
    LIMIT 1
    `,
    [id]
  );

  res.json({
    ok: true,
    message: 'Sucursal actualizada correctamente',
    sucursal: sucursalActualizada[0]
  });
});