import bcrypt from 'bcryptjs';
import { pool } from '../config/db.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const listarSurtidores = asyncHandler(async (req, res) => {
  const { activo, search } = req.query;

  const where = ['u.rol = ?'];
  const params = ['SURTIDOR'];

  if (activo !== undefined && activo !== '') {
    where.push('su.activo = ?');
    params.push(Number(activo) === 1 ? 1 : 0);
  }

  if (search && search.trim()) {
    where.push('(u.nombre LIKE ? OR u.usuario LIKE ? OR su.codigo LIKE ?)');
    params.push(
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
      u.ultimo_login,

      su.created_at,
      su.updated_at
    FROM surtidores su
    INNER JOIN usuarios u ON u.id = su.usuario_id
    WHERE ${where.join(' AND ')}
    ORDER BY su.activo DESC, u.nombre ASC
    `,
    params
  );

  res.json({
    ok: true,
    surtidores
  });
});

export const crearSurtidor = asyncHandler(async (req, res) => {
  const nombre = String(req.body.nombre || '').trim();
  const usuario = String(req.body.usuario || '').trim();
  const password = String(req.body.password || '');
  const codigo = req.body.codigo !== undefined && req.body.codigo !== null
    ? String(req.body.codigo).trim()
    : null;

  if (!nombre) {
    return res.status(400).json({
      ok: false,
      message: 'El nombre del surtidor es obligatorio'
    });
  }

  if (!usuario) {
    return res.status(400).json({
      ok: false,
      message: 'El usuario del surtidor es obligatorio'
    });
  }

  if (!password || password.length < 6) {
    return res.status(400).json({
      ok: false,
      message: 'La contraseña debe tener al menos 6 caracteres'
    });
  }

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [usuarioExistente] = await connection.query(
      'SELECT id FROM usuarios WHERE usuario = ? LIMIT 1',
      [usuario]
    );

    if (usuarioExistente.length > 0) {
      await connection.rollback();

      return res.status(409).json({
        ok: false,
        message: 'Ya existe un usuario con ese nombre de acceso'
      });
    }

    if (codigo) {
      const [codigoExistente] = await connection.query(
        'SELECT id FROM surtidores WHERE codigo = ? LIMIT 1',
        [codigo]
      );

      if (codigoExistente.length > 0) {
        await connection.rollback();

        return res.status(409).json({
          ok: false,
          message: 'Ya existe un surtidor con ese código'
        });
      }
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const [usuarioResult] = await connection.query(
      `
      INSERT INTO usuarios (
        nombre,
        usuario,
        password_hash,
        rol,
        sucursal_id,
        activo
      )
      VALUES (?, ?, ?, 'SURTIDOR', NULL, 1)
      `,
      [nombre, usuario, passwordHash]
    );

    const usuarioId = usuarioResult.insertId;

    const [surtidorResult] = await connection.query(
      `
      INSERT INTO surtidores (
        usuario_id,
        codigo,
        activo
      )
      VALUES (?, ?, 1)
      `,
      [usuarioId, codigo || null]
    );

    await connection.commit();

    const [nuevo] = await pool.query(
      `
      SELECT
        su.id,
        su.usuario_id,
        su.codigo,
        su.activo,

        u.nombre,
        u.usuario,
        u.rol,
        u.ultimo_login,

        su.created_at,
        su.updated_at
      FROM surtidores su
      INNER JOIN usuarios u ON u.id = su.usuario_id
      WHERE su.id = ?
      LIMIT 1
      `,
      [surtidorResult.insertId]
    );

    res.status(201).json({
      ok: true,
      message: 'Surtidor creado correctamente',
      surtidor: nuevo[0]
    });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
});

export const actualizarSurtidor = asyncHandler(async (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({
      ok: false,
      message: 'ID de surtidor inválido'
    });
  }

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [actualRows] = await connection.query(
      `
      SELECT
        su.id,
        su.usuario_id,
        su.codigo,
        su.activo,

        u.nombre,
        u.usuario,
        u.rol
      FROM surtidores su
      INNER JOIN usuarios u ON u.id = su.usuario_id
      WHERE su.id = ?
        AND u.rol = 'SURTIDOR'
      LIMIT 1
      `,
      [id]
    );

    if (actualRows.length === 0) {
      await connection.rollback();

      return res.status(404).json({
        ok: false,
        message: 'Surtidor no encontrado'
      });
    }

    const actual = actualRows[0];

    const nombre = req.body.nombre !== undefined
      ? String(req.body.nombre || '').trim()
      : actual.nombre;

    const usuario = req.body.usuario !== undefined
      ? String(req.body.usuario || '').trim()
      : actual.usuario;

    const codigo = req.body.codigo !== undefined
      ? String(req.body.codigo || '').trim()
      : actual.codigo;

    const activo = req.body.activo !== undefined
      ? (Number(req.body.activo) === 1 ? 1 : 0)
      : actual.activo;

    const password = req.body.password !== undefined
      ? String(req.body.password || '')
      : null;

    if (!nombre) {
      await connection.rollback();

      return res.status(400).json({
        ok: false,
        message: 'El nombre del surtidor no puede ir vacío'
      });
    }

    if (!usuario) {
      await connection.rollback();

      return res.status(400).json({
        ok: false,
        message: 'El usuario del surtidor no puede ir vacío'
      });
    }

    if (password !== null && password.length > 0 && password.length < 6) {
      await connection.rollback();

      return res.status(400).json({
        ok: false,
        message: 'La nueva contraseña debe tener al menos 6 caracteres'
      });
    }

    if (usuario !== actual.usuario) {
      const [usuarioDuplicado] = await connection.query(
        'SELECT id FROM usuarios WHERE usuario = ? AND id <> ? LIMIT 1',
        [usuario, actual.usuario_id]
      );

      if (usuarioDuplicado.length > 0) {
        await connection.rollback();

        return res.status(409).json({
          ok: false,
          message: 'Ya existe otro usuario con ese nombre de acceso'
        });
      }
    }

    if (codigo) {
      const [codigoDuplicado] = await connection.query(
        'SELECT id FROM surtidores WHERE codigo = ? AND id <> ? LIMIT 1',
        [codigo, id]
      );

      if (codigoDuplicado.length > 0) {
        await connection.rollback();

        return res.status(409).json({
          ok: false,
          message: 'Ya existe otro surtidor con ese código'
        });
      }
    }

    if (password && password.length >= 6) {
      const passwordHash = await bcrypt.hash(password, 10);

      await connection.query(
        `
        UPDATE usuarios
        SET
          nombre = ?,
          usuario = ?,
          password_hash = ?,
          sucursal_id = NULL,
          activo = ?
        WHERE id = ?
        `,
        [nombre, usuario, passwordHash, activo, actual.usuario_id]
      );
    } else {
      await connection.query(
        `
        UPDATE usuarios
        SET
          nombre = ?,
          usuario = ?,
          sucursal_id = NULL,
          activo = ?
        WHERE id = ?
        `,
        [nombre, usuario, activo, actual.usuario_id]
      );
    }

    await connection.query(
      `
      UPDATE surtidores
      SET
        codigo = ?,
        activo = ?
      WHERE id = ?
      `,
      [codigo || null, activo, id]
    );

    await connection.commit();

    const [actualizado] = await pool.query(
      `
      SELECT
        su.id,
        su.usuario_id,
        su.codigo,
        su.activo,

        u.nombre,
        u.usuario,
        u.rol,
        u.ultimo_login,

        su.created_at,
        su.updated_at
      FROM surtidores su
      INNER JOIN usuarios u ON u.id = su.usuario_id
      WHERE su.id = ?
      LIMIT 1
      `,
      [id]
    );

    res.json({
      ok: true,
      message: 'Surtidor actualizado correctamente',
      surtidor: actualizado[0]
    });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
});