import { pool } from '../config/db.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { registrarAuditoria } from '../utils/auditoria.js';

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

async function obtenerSurtidorPorId(connection, id) {
  const [rows] = await connection.query(
    `
    SELECT
      su.id,
      su.usuario_id,
      su.codigo,
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

export const listarSurtidores = asyncHandler(async (req, res) => {
  const { activo, search } = req.query;

  const where = [];
  const params = [];

  if (activo !== undefined && activo !== '') {
    where.push('su.activo = ?');
    params.push(Number(activo) === 1 ? 1 : 0);
  }

  if (search && search.trim()) {
    where.push('(u.nombre LIKE ? OR u.usuario LIKE ? OR u.rol LIKE ? OR su.codigo LIKE ?)');
    params.push(
      `%${search.trim()}%`,
      `%${search.trim()}%`,
      `%${search.trim()}%`,
      `%${search.trim()}%`
    );
  }

  const [surtidores] = await pool.query(
    `
    SELECT
      su.id,
      su.usuario_id,
      su.codigo,
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
    ORDER BY su.activo DESC, u.nombre ASC
    `,
    params
  );

  res.json({ ok: true, surtidores });
});

export const crearSurtidor = asyncHandler(async (req, res) => {
  const usuarioId = toPositiveId(req.body.usuario_id, 'usuario_id');
  const codigo = normalizarCodigo(req.body.codigo);
  const activo = req.body.activo !== undefined ? (Number(req.body.activo) === 1 ? 1 : 0) : 1;

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

    const [yaSurtidor] = await connection.query(
      `SELECT id FROM surtidores WHERE usuario_id = ? LIMIT 1`,
      [usuarioId]
    );

    if (yaSurtidor.length > 0) {
      await connection.rollback();
      return res.status(409).json({ ok: false, message: 'Ese usuario ya está vinculado como surtidor.' });
    }

    if (codigo) {
      const [codigoExistente] = await connection.query(
        `SELECT id FROM surtidores WHERE codigo = ? LIMIT 1`,
        [codigo]
      );

      if (codigoExistente.length > 0) {
        await connection.rollback();
        return res.status(409).json({ ok: false, message: 'Ya existe un surtidor con ese código.' });
      }
    }

    const [result] = await connection.query(
      `
      INSERT INTO surtidores (usuario_id, codigo, activo)
      VALUES (?, ?, ?)
      `,
      [usuarioId, codigo, activo]
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
    const activo = req.body.activo !== undefined ? (Number(req.body.activo) === 1 ? 1 : 0) : actual.activo;

    if (codigo) {
      const [codigoDuplicado] = await connection.query(
        `SELECT id FROM surtidores WHERE codigo = ? AND id <> ? LIMIT 1`,
        [codigo, id]
      );

      if (codigoDuplicado.length > 0) {
        await connection.rollback();
        return res.status(409).json({ ok: false, message: 'Ya existe otro surtidor con ese código.' });
      }
    }

    await connection.query(
      `
      UPDATE surtidores
      SET codigo = ?, activo = ?
      WHERE id = ?
      `,
      [codigo, activo, id]
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
