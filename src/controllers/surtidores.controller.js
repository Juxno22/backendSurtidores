import { pool } from '../config/db.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { registrarAuditoria } from '../utils/auditoria.js';

const TIPOS_OPERACION = ['SUCURSAL', 'MAYOREO'];
const ROLES_PERMITIDOS_SURTIDOR = ['SURTIDOR'];

function toPositiveId(value, fieldName) {
  const id = Number(value);

  if (!Number.isInteger(id) || id <= 0) {
    const error = new Error(`${fieldName} inválido`);
    error.status = 400;
    throw error;
  }

  return id;
}

function normalizarCodigo(value) {
  const text = String(value ?? '').trim().toUpperCase();
  return text || null;
}

function normalizarCodigoReporte(value) {
  const text = String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '');

  return text || null;
}

function normalizarTipoOperacion(value, defaultValue = 'SUCURSAL') {
  const tipo = String(value || defaultValue).trim().toUpperCase();

  if (!TIPOS_OPERACION.includes(tipo)) {
    const error = new Error('El tipo de operación debe ser SUCURSAL o MAYOREO');
    error.status = 400;
    throw error;
  }

  return tipo;
}

function normalizarActivo(value, defaultValue = 1) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return Number(value) === 1 ? 1 : 0;
}

async function obtenerSurtidorPorId(connection, id) {
  const [rows] = await connection.query(
    `
    SELECT
      su.id,
      su.usuario_id,
      su.codigo,
      su.codigo_reporte,
      su.tipo_operacion,
      CASE WHEN su.tipo_operacion = 'MAYOREO' THEN 1 ELSE 0 END AS es_mayoreo,
      CASE WHEN su.tipo_operacion = 'SUCURSAL' THEN 1 ELSE 0 END AS es_sucursal,
      su.activo,
      u.nombre,
      u.usuario,
      u.rol,
      u.activo AS usuario_activo,
      u.ultimo_login,
      DATE_FORMAT(su.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
      DATE_FORMAT(su.updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at
    FROM surtidores su
    INNER JOIN usuarios u ON u.id = su.usuario_id
    WHERE su.id = ?
    LIMIT 1
    `,
    [id]
  );

  return rows[0] || null;
}

async function validarCodigoInternoDisponible(connection, codigo, surtidorId = null) {
  if (!codigo) return;

  const params = [codigo];
  let extra = '';

  if (surtidorId) {
    extra = 'AND id <> ?';
    params.push(surtidorId);
  }

  const [rows] = await connection.query(
    `SELECT id FROM surtidores WHERE codigo = ? ${extra} LIMIT 1`,
    params
  );

  if (rows.length > 0) {
    const error = new Error('Ya existe un surtidor con ese código interno.');
    error.status = 409;
    throw error;
  }
}

async function validarCodigoReporteDisponible(connection, codigoReporte, surtidorId = null) {
  if (!codigoReporte) return;

  const params = [codigoReporte];
  let extra = '';

  if (surtidorId) {
    extra = 'AND id <> ?';
    params.push(surtidorId);
  }

  const [rows] = await connection.query(
    `SELECT id FROM surtidores WHERE codigo_reporte = ? ${extra} LIMIT 1`,
    params
  );

  if (rows.length > 0) {
    const error = new Error('Ya existe un surtidor con ese código de reporte.');
    error.status = 409;
    throw error;
  }
}

async function validarCambioTipoOperacion(connection, surtidorId, tipoActual, tipoNuevo) {
  if (tipoActual === tipoNuevo) return;

  const [rows] = await connection.query(
    `
    SELECT COUNT(*) AS total
    FROM productividad_sesiones
    WHERE surtidor_id = ?
    `,
    [surtidorId]
  );

  if (Number(rows[0]?.total || 0) > 0) {
    const error = new Error('No puedes cambiar el tipo de operación de un surtidor que ya tiene sesiones registradas.');
    error.status = 400;
    throw error;
  }
}

export const listarSurtidores = asyncHandler(async (req, res) => {
  const { activo, search, tipo_operacion } = req.query;

  const where = [];
  const params = [];

  if (activo !== undefined && activo !== '') {
    where.push('su.activo = ?');
    params.push(Number(activo) === 1 ? 1 : 0);
  }

  if (tipo_operacion) {
    where.push('su.tipo_operacion = ?');
    params.push(normalizarTipoOperacion(tipo_operacion));
  }

  if (search && search.trim()) {
    where.push(`(
      u.nombre LIKE ?
      OR u.usuario LIKE ?
      OR u.rol LIKE ?
      OR su.codigo LIKE ?
      OR su.codigo_reporte LIKE ?
      OR su.tipo_operacion LIKE ?
    )`);

    const like = `%${search.trim()}%`;
    params.push(like, like, like, like, like, like);
  }

  const [surtidores] = await pool.query(
    `
    SELECT
      su.id,
      su.usuario_id,
      su.codigo,
      su.codigo_reporte,
      su.tipo_operacion,
      CASE WHEN su.tipo_operacion = 'MAYOREO' THEN 1 ELSE 0 END AS es_mayoreo,
      CASE WHEN su.tipo_operacion = 'SUCURSAL' THEN 1 ELSE 0 END AS es_sucursal,
      su.activo,
      u.nombre,
      u.usuario,
      u.rol,
      u.activo AS usuario_activo,
      u.ultimo_login,
      DATE_FORMAT(su.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
      DATE_FORMAT(su.updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at
    FROM surtidores su
    INNER JOIN usuarios u ON u.id = su.usuario_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY su.activo DESC, FIELD(su.tipo_operacion, 'SUCURSAL', 'MAYOREO'), u.nombre ASC
    `,
    params
  );

  res.json({ ok: true, surtidores });
});

export const crearSurtidor = asyncHandler(async (req, res) => {
  const usuarioId = toPositiveId(req.body.usuario_id, 'usuario_id');
  const codigo = normalizarCodigo(req.body.codigo);
  const tipoOperacion = normalizarTipoOperacion(req.body.tipo_operacion || 'SUCURSAL');
  const activo = normalizarActivo(req.body.activo, 1);

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [usuarioRows] = await connection.query(
      `
      SELECT id, nombre, usuario, rol, activo
      FROM usuarios
      WHERE id = ?
      LIMIT 1
      `,
      [usuarioId]
    );

    if (!usuarioRows.length) {
      await connection.rollback();
      return res.status(404).json({ ok: false, message: 'Usuario no encontrado. Primero créalo desde Usuarios.' });
    }

    const usuario = usuarioRows[0];

    if (Number(usuario.activo) !== 1) {
      await connection.rollback();
      return res.status(400).json({ ok: false, message: 'No puedes vincular un usuario inactivo como surtidor.' });
    }

    if (!ROLES_PERMITIDOS_SURTIDOR.includes(usuario.rol)) {
      await connection.rollback();
      return res.status(400).json({ ok: false, message: 'Para vincularlo como surtidor, primero asigna el rol SURTIDOR desde Usuarios.' });
    }

    const [yaSurtidor] = await connection.query(
      `SELECT id FROM surtidores WHERE usuario_id = ? LIMIT 1`,
      [usuarioId]
    );

    if (yaSurtidor.length > 0) {
      await connection.rollback();
      return res.status(409).json({ ok: false, message: 'Ese usuario ya está vinculado como surtidor.' });
    }

    const codigoReporte = normalizarCodigoReporte(req.body.codigo_reporte) || normalizarCodigoReporte(usuario.usuario);

    await validarCodigoInternoDisponible(connection, codigo);
    await validarCodigoReporteDisponible(connection, codigoReporte);

    const [result] = await connection.query(
      `
      INSERT INTO surtidores (
        usuario_id,
        codigo,
        codigo_reporte,
        tipo_operacion,
        activo
      )
      VALUES (?, ?, ?, ?, ?)
      `,
      [usuarioId, codigo, codigoReporte, tipoOperacion, activo]
    );

    const nuevo = await obtenerSurtidorPorId(connection, result.insertId);

    await registrarAuditoria(connection, {
      req,
      modulo: 'SURTIDORES',
      accion: 'VINCULAR_USUARIO_SURTIDOR',
      entidad: 'surtidores',
      entidadId: result.insertId,
      datosAntes: null,
      datosDespues: nuevo
    });

    await connection.commit();

    res.status(201).json({ ok: true, message: 'Usuario vinculado como surtidor correctamente', surtidor: nuevo });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
});

export const actualizarSurtidor = asyncHandler(async (req, res) => {
  const id = toPositiveId(req.params.id, 'ID de surtidor');
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const actual = await obtenerSurtidorPorId(connection, id);

    if (!actual) {
      await connection.rollback();
      return res.status(404).json({ ok: false, message: 'Surtidor no encontrado' });
    }

    const codigo = req.body.codigo !== undefined ? normalizarCodigo(req.body.codigo) : actual.codigo;
    const codigoReporte = req.body.codigo_reporte !== undefined
      ? normalizarCodigoReporte(req.body.codigo_reporte)
      : actual.codigo_reporte;
    const tipoOperacion = req.body.tipo_operacion !== undefined
      ? normalizarTipoOperacion(req.body.tipo_operacion)
      : actual.tipo_operacion;
    const activo = req.body.activo !== undefined ? normalizarActivo(req.body.activo, actual.activo) : actual.activo;

    await validarCambioTipoOperacion(connection, id, actual.tipo_operacion, tipoOperacion);
    await validarCodigoInternoDisponible(connection, codigo, id);
    await validarCodigoReporteDisponible(connection, codigoReporte, id);

    await connection.query(
      `
      UPDATE surtidores
      SET
        codigo = ?,
        codigo_reporte = ?,
        tipo_operacion = ?,
        activo = ?
      WHERE id = ?
      `,
      [codigo, codigoReporte, tipoOperacion, activo, id]
    );

    const actualizado = await obtenerSurtidorPorId(connection, id);

    await registrarAuditoria(connection, {
      req,
      modulo: 'SURTIDORES',
      accion: 'ACTUALIZAR_SURTIDOR',
      entidad: 'surtidores',
      entidadId: id,
      datosAntes: actual,
      datosDespues: actualizado
    });

    await connection.commit();

    res.json({ ok: true, message: 'Surtidor actualizado correctamente', surtidor: actualizado });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
});
