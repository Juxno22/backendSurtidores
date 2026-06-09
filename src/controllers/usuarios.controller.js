import bcrypt from 'bcryptjs';
import { pool } from '../config/db.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { registrarAuditoria } from '../utils/auditoria.js';

const ROLES_ADMINISTRATIVOS = ['ADMIN', 'SUPERVISOR'];

function toPositiveId(value, fieldName) {
  const id = Number(value);

  if (!Number.isInteger(id) || id <= 0) {
    const error = new Error(`${fieldName} inválido`);
    error.status = 400;
    throw error;
  }

  return id;
}

function normalizarRol(rol) {
  const value = String(rol || '').trim().toUpperCase();

  if (!ROLES_ADMINISTRATIVOS.includes(value)) {
    const error = new Error('El rol debe ser ADMIN o SUPERVISOR');
    error.status = 400;
    throw error;
  }

  return value;
}

function normalizarActivo(value, defaultValue = 1) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  return Number(value) === 1 ? 1 : 0;
}

async function validarSucursalOpcional(connection, sucursalId) {
  if (sucursalId === undefined || sucursalId === null || sucursalId === '') {
    return null;
  }

  const id = toPositiveId(sucursalId, 'sucursal_id');

  const [rows] = await connection.query(
    `
    SELECT id, nombre, activo
    FROM sucursales
    WHERE id = ?
    LIMIT 1
    `,
    [id]
  );

  if (rows.length === 0) {
    const error = new Error('Sucursal no encontrada');
    error.status = 404;
    throw error;
  }

  if (!rows[0].activo) {
    const error = new Error('No puedes asignar un usuario a una sucursal inactiva');
    error.status = 400;
    throw error;
  }

  return id;
}

async function contarAdminsActivos(connection) {
  const [rows] = await connection.query(
    `
    SELECT COUNT(*) AS total
    FROM usuarios
    WHERE rol = 'ADMIN'
      AND activo = 1
    `
  );

  return Number(rows[0]?.total || 0);
}

async function obtenerUsuarioPorId(connection, id) {
  const [rows] = await connection.query(
    `
    SELECT
      u.id,
      u.nombre,
      u.usuario,
      u.rol,
      u.sucursal_id,
      s.nombre AS sucursal_nombre,
      u.activo,
      u.ultimo_login,
      u.created_at,
      u.updated_at
    FROM usuarios u
    LEFT JOIN sucursales s ON s.id = u.sucursal_id
    WHERE u.id = ?
    LIMIT 1
    `,
    [id]
  );

  return rows[0] || null;
}

export const listarUsuarios = asyncHandler(async (req, res) => {
  const { rol, activo, search } = req.query;

  const where = [];
  const params = [];

  if (rol) {
    const rolNormalizado = normalizarRol(rol);
    where.push('u.rol = ?');
    params.push(rolNormalizado);
  } else {
    where.push(`u.rol IN ('ADMIN', 'SUPERVISOR')`);
  }

  if (activo !== undefined && activo !== '') {
    where.push('u.activo = ?');
    params.push(Number(activo) === 1 ? 1 : 0);
  }

  if (search && search.trim()) {
    where.push('(u.nombre LIKE ? OR u.usuario LIKE ? OR s.nombre LIKE ?)');
    params.push(
      `%${search.trim()}%`,
      `%${search.trim()}%`,
      `%${search.trim()}%`
    );
  }

  const [usuarios] = await pool.query(
    `
    SELECT
      u.id,
      u.nombre,
      u.usuario,
      u.rol,
      u.sucursal_id,
      s.nombre AS sucursal_nombre,
      u.activo,
      u.ultimo_login,
      u.created_at,
      u.updated_at
    FROM usuarios u
    LEFT JOIN sucursales s ON s.id = u.sucursal_id
    WHERE ${where.join(' AND ')}
    ORDER BY u.activo DESC, u.rol ASC, u.nombre ASC
    `,
    params
  );

  res.json({
    ok: true,
    usuarios
  });
});

export const obtenerUsuario = asyncHandler(async (req, res) => {
  const id = toPositiveId(req.params.id, 'ID de usuario');

  const usuario = await obtenerUsuarioPorId(pool, id);

  if (!usuario || !ROLES_ADMINISTRATIVOS.includes(usuario.rol)) {
    return res.status(404).json({
      ok: false,
      message: 'Usuario administrativo no encontrado'
    });
  }

  res.json({
    ok: true,
    usuario
  });
});

export const crearUsuario = asyncHandler(async (req, res) => {
  const nombre = String(req.body.nombre || '').trim();
  const usuario = String(req.body.usuario || '').trim();
  const password = String(req.body.password || '');
  const rol = normalizarRol(req.body.rol);
  const activo = normalizarActivo(req.body.activo, 1);

  if (!nombre) {
    return res.status(400).json({
      ok: false,
      message: 'El nombre es obligatorio'
    });
  }

  if (!usuario) {
    return res.status(400).json({
      ok: false,
      message: 'El usuario es obligatorio'
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

    const sucursalId = await validarSucursalOpcional(connection, req.body.sucursal_id);

    const [existente] = await connection.query(
      `
      SELECT id
      FROM usuarios
      WHERE usuario = ?
      LIMIT 1
      `,
      [usuario]
    );

    if (existente.length > 0) {
      await connection.rollback();

      return res.status(409).json({
        ok: false,
        message: 'Ya existe un usuario con ese nombre de acceso'
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const [result] = await connection.query(
      `
      INSERT INTO usuarios (
        nombre,
        usuario,
        password_hash,
        rol,
        sucursal_id,
        activo
      )
      VALUES (?, ?, ?, ?, ?, ?)
      `,
      [nombre, usuario, passwordHash, rol, sucursalId, activo]
    );

    const nuevoId = result.insertId;

    const nuevoUsuario = await obtenerUsuarioPorId(connection, nuevoId);

    await registrarAuditoria(connection, {
      req,
      modulo: 'USUARIOS',
      accion: 'CREAR_USUARIO_ADMINISTRATIVO',
      entidad: 'usuarios',
      entidadId: nuevoId,
      datosDespues: {
        id: nuevoId,
        nombre,
        usuario,
        rol,
        sucursal_id: sucursalId,
        activo
      }
    });

    await connection.commit();

    res.status(201).json({
      ok: true,
      message: 'Usuario creado correctamente',
      usuario: nuevoUsuario
    });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
});

export const actualizarUsuario = asyncHandler(async (req, res) => {
  const id = toPositiveId(req.params.id, 'ID de usuario');

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [actualRows] = await connection.query(
      `
      SELECT
        id,
        nombre,
        usuario,
        rol,
        sucursal_id,
        activo
      FROM usuarios
      WHERE id = ?
      LIMIT 1
      `,
      [id]
    );

    if (actualRows.length === 0 || !ROLES_ADMINISTRATIVOS.includes(actualRows[0].rol)) {
      await connection.rollback();

      return res.status(404).json({
        ok: false,
        message: 'Usuario administrativo no encontrado'
      });
    }

    const actual = actualRows[0];

    const nombre = req.body.nombre !== undefined
      ? String(req.body.nombre || '').trim()
      : actual.nombre;

    const usuario = req.body.usuario !== undefined
      ? String(req.body.usuario || '').trim()
      : actual.usuario;

    const rol = req.body.rol !== undefined
      ? normalizarRol(req.body.rol)
      : actual.rol;

    const activo = req.body.activo !== undefined
      ? normalizarActivo(req.body.activo, actual.activo)
      : actual.activo;

    const sucursalId = req.body.sucursal_id !== undefined
      ? await validarSucursalOpcional(connection, req.body.sucursal_id)
      : actual.sucursal_id;

    if (!nombre) {
      await connection.rollback();

      return res.status(400).json({
        ok: false,
        message: 'El nombre no puede ir vacío'
      });
    }

    if (!usuario) {
      await connection.rollback();

      return res.status(400).json({
        ok: false,
        message: 'El usuario no puede ir vacío'
      });
    }

    if (usuario !== actual.usuario) {
      const [duplicado] = await connection.query(
        `
        SELECT id
        FROM usuarios
        WHERE usuario = ?
          AND id <> ?
        LIMIT 1
        `,
        [usuario, id]
      );

      if (duplicado.length > 0) {
        await connection.rollback();

        return res.status(409).json({
          ok: false,
          message: 'Ya existe otro usuario con ese nombre de acceso'
        });
      }
    }

    if (Number(id) === Number(req.user.id)) {
      if (rol !== 'ADMIN') {
        await connection.rollback();

        return res.status(400).json({
          ok: false,
          message: 'No puedes quitarte tu propio rol ADMIN'
        });
      }

      if (activo !== 1) {
        await connection.rollback();

        return res.status(400).json({
          ok: false,
          message: 'No puedes desactivar tu propio usuario'
        });
      }
    }

    if (actual.rol === 'ADMIN' && (rol !== 'ADMIN' || activo !== 1)) {
      const adminsActivos = await contarAdminsActivos(connection);

      if (adminsActivos <= 1) {
        await connection.rollback();

        return res.status(400).json({
          ok: false,
          message: 'No puedes desactivar o cambiar de rol al último ADMIN activo'
        });
      }
    }

    const datosAntes = {
      nombre: actual.nombre,
      usuario: actual.usuario,
      rol: actual.rol,
      sucursal_id: actual.sucursal_id,
      activo: actual.activo
    };

    const datosDespues = {
      nombre,
      usuario,
      rol,
      sucursal_id: sucursalId,
      activo
    };

    await connection.query(
      `
      UPDATE usuarios
      SET
        nombre = ?,
        usuario = ?,
        rol = ?,
        sucursal_id = ?,
        activo = ?
      WHERE id = ?
      `,
      [nombre, usuario, rol, sucursalId, activo, id]
    );

    await registrarAuditoria(connection, {
      req,
      modulo: 'USUARIOS',
      accion: 'ACTUALIZAR_USUARIO_ADMINISTRATIVO',
      entidad: 'usuarios',
      entidadId: id,
      datosAntes,
      datosDespues
    });

    await connection.commit();

    const usuarioActualizado = await obtenerUsuarioPorId(pool, id);

    res.json({
      ok: true,
      message: 'Usuario actualizado correctamente',
      usuario: usuarioActualizado
    });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
});

export const cambiarPasswordUsuario = asyncHandler(async (req, res) => {
  const id = toPositiveId(req.params.id, 'ID de usuario');
  const password = String(req.body.password || '');

  if (!password || password.length < 6) {
    return res.status(400).json({
      ok: false,
      message: 'La nueva contraseña debe tener al menos 6 caracteres'
    });
  }

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [actualRows] = await connection.query(
      `
      SELECT id, nombre, usuario, rol
      FROM usuarios
      WHERE id = ?
      LIMIT 1
      `,
      [id]
    );

    if (actualRows.length === 0 || !ROLES_ADMINISTRATIVOS.includes(actualRows[0].rol)) {
      await connection.rollback();

      return res.status(404).json({
        ok: false,
        message: 'Usuario administrativo no encontrado'
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    await connection.query(
      `
      UPDATE usuarios
      SET password_hash = ?
      WHERE id = ?
      `,
      [passwordHash, id]
    );

    await registrarAuditoria(connection, {
      req,
      modulo: 'USUARIOS',
      accion: 'CAMBIAR_PASSWORD_USUARIO',
      entidad: 'usuarios',
      entidadId: id,
      datosDespues: {
        usuario_id: id,
        usuario: actualRows[0].usuario,
        rol: actualRows[0].rol
      }
    });

    await connection.commit();

    res.json({
      ok: true,
      message: 'Contraseña actualizada correctamente'
    });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
});

export const cambiarMiPassword = asyncHandler(async (req, res) => {
  const passwordActual = String(req.body.password_actual || '');
  const passwordNueva = String(req.body.password_nueva || '');

  if (!passwordActual) {
    return res.status(400).json({
      ok: false,
      message: 'La contraseña actual es obligatoria'
    });
  }

  if (!passwordNueva || passwordNueva.length < 6) {
    return res.status(400).json({
      ok: false,
      message: 'La nueva contraseña debe tener al menos 6 caracteres'
    });
  }

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [rows] = await connection.query(
      `
      SELECT id, usuario, password_hash, rol
      FROM usuarios
      WHERE id = ?
      LIMIT 1
      `,
      [req.user.id]
    );

    if (rows.length === 0) {
      await connection.rollback();

      return res.status(404).json({
        ok: false,
        message: 'Usuario no encontrado'
      });
    }

    const user = rows[0];

    const passwordCorrecta = await bcrypt.compare(passwordActual, user.password_hash);

    if (!passwordCorrecta) {
      await connection.rollback();

      return res.status(401).json({
        ok: false,
        message: 'La contraseña actual es incorrecta'
      });
    }

    const passwordHash = await bcrypt.hash(passwordNueva, 10);

    await connection.query(
      `
      UPDATE usuarios
      SET password_hash = ?
      WHERE id = ?
      `,
      [passwordHash, req.user.id]
    );

    await registrarAuditoria(connection, {
      req,
      modulo: 'USUARIOS',
      accion: 'CAMBIAR_MI_PASSWORD',
      entidad: 'usuarios',
      entidadId: req.user.id,
      datosDespues: {
        usuario_id: req.user.id,
        usuario: user.usuario,
        rol: user.rol
      }
    });

    await connection.commit();

    res.json({
      ok: true,
      message: 'Tu contraseña fue actualizada correctamente'
    });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
});