import { pool } from '../config/db.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getFechaOperativa } from '../utils/fechaOperativa.js';

function toPositiveId(value, fieldName) {
  const id = Number(value);

  if (!Number.isInteger(id) || id <= 0) {
    const error = new Error(`${fieldName} inválido`);
    error.status = 400;
    throw error;
  }

  return id;
}

function toNonNegativeInt(value, fieldName, defaultValue = 0) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  const number = Number(value);

  if (!Number.isInteger(number) || number < 0) {
    const error = new Error(`${fieldName} debe ser un número entero mayor o igual a 0`);
    error.status = 400;
    throw error;
  }

  return number;
}

function toNonNegativeDecimal(value, fieldName, defaultValue = 0) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  const number = Number(value);

  if (Number.isNaN(number) || number < 0) {
    const error = new Error(`${fieldName} debe ser un número mayor o igual a 0`);
    error.status = 400;
    throw error;
  }

  return Number(number.toFixed(2));
}

function json(value) {
  return JSON.stringify(value ?? null);
}

async function registrarEvento(connection, {
  sesionId,
  usuarioId,
  tipoEvento,
  datosAntes = null,
  datosDespues = null,
  motivo = null
}) {
  await connection.query(
    `
    INSERT INTO productividad_sesion_eventos (
      sesion_id,
      usuario_id,
      tipo_evento,
      datos_antes,
      datos_despues,
      motivo
    )
    VALUES (?, ?, ?, ?, ?, ?)
    `,
    [
      sesionId,
      usuarioId,
      tipoEvento,
      datosAntes ? json(datosAntes) : null,
      datosDespues ? json(datosDespues) : null,
      motivo
    ]
  );
}

async function validarSucursalActiva(connection, sucursalId) {
  const [sucursales] = await connection.query(
    `
    SELECT id, nombre, activo
    FROM sucursales
    WHERE id = ?
    LIMIT 1
    `,
    [sucursalId]
  );

  if (sucursales.length === 0) {
    const error = new Error('Sucursal no encontrada');
    error.status = 404;
    throw error;
  }

  if (!sucursales[0].activo) {
    const error = new Error('No puedes iniciar una sesión con una sucursal inactiva');
    error.status = 400;
    throw error;
  }

  return sucursales[0];
}

async function obtenerSurtidorOperacion(connection, req, surtidorIdBody = null) {
  if (req.user.rol === 'SURTIDOR') {
    const [rows] = await connection.query(
      `
      SELECT
        su.id,
        su.usuario_id,
        su.codigo,
        su.activo,
        u.nombre,
        u.usuario
      FROM surtidores su
      INNER JOIN usuarios u ON u.id = su.usuario_id
      WHERE su.usuario_id = ?
      LIMIT 1
      `,
      [req.user.id]
    );

    if (rows.length === 0) {
      const error = new Error('Tu usuario no está registrado como surtidor');
      error.status = 403;
      throw error;
    }

    if (!rows[0].activo) {
      const error = new Error('Surtidor inactivo');
      error.status = 403;
      throw error;
    }

    return rows[0];
  }

  const surtidorId = toPositiveId(surtidorIdBody, 'surtidor_id');

  const [rows] = await connection.query(
    `
    SELECT
      su.id,
      su.usuario_id,
      su.codigo,
      su.activo,
      u.nombre,
      u.usuario
    FROM surtidores su
    INNER JOIN usuarios u ON u.id = su.usuario_id
    WHERE su.id = ?
    LIMIT 1
    `,
    [surtidorId]
  );

  if (rows.length === 0) {
    const error = new Error('Surtidor no encontrado');
    error.status = 404;
    throw error;
  }

  if (!rows[0].activo) {
    const error = new Error('No puedes operar con un surtidor inactivo');
    error.status = 400;
    throw error;
  }

  return rows[0];
}

function validarPermisoSesion(req, sesion) {
  if (req.user.rol === 'SURTIDOR' && Number(sesion.usuario_id) !== Number(req.user.id)) {
    const error = new Error('No tienes permiso para acceder a esta sesión');
    error.status = 403;
    throw error;
  }
}

async function obtenerSesionPorId(connection, id) {
  const [rows] = await connection.query(
    `
    SELECT
      ps.id,
      ps.surtidor_id,
      ps.usuario_id,
      u.nombre AS surtidor_nombre,
      u.usuario AS surtidor_usuario,
      su.codigo AS surtidor_codigo,

      ps.sucursal_id,
      s.nombre AS sucursal_nombre,

      ps.fecha_operativa,
      ps.hora_inicio,
      ps.hora_fin,
      ps.duracion_segundos,

      ROUND(ps.duracion_segundos / 60, 2) AS duracion_minutos,
      ROUND(ps.duracion_segundos / 3600, 2) AS duracion_horas,

      ps.tickets,
      ps.partidas,
      ps.monto,
      ps.ceros,
      ps.no_surtido,

      ps.observaciones,
      ps.estado,

      ps.cancelado_motivo,
      ps.cancelado_por,
      ps.cancelado_at,

      ps.finalizado_por,
      ps.finalizado_at,

      ps.created_at,
      ps.updated_at
    FROM productividad_sesiones ps
    INNER JOIN surtidores su ON su.id = ps.surtidor_id
    INNER JOIN usuarios u ON u.id = ps.usuario_id
    INNER JOIN sucursales s ON s.id = ps.sucursal_id
    WHERE ps.id = ?
    LIMIT 1
    `,
    [id]
  );

  return rows[0] || null;
}

function construirPayloadDatos(body, actual = {}) {
  return {
    tickets: toNonNegativeInt(body.tickets, 'tickets', actual.tickets ?? 0),
    partidas: toNonNegativeInt(body.partidas, 'partidas', actual.partidas ?? 0),
    monto: toNonNegativeDecimal(body.monto, 'monto', actual.monto ?? 0),
    ceros: toNonNegativeInt(body.ceros, 'ceros', actual.ceros ?? 0),
    no_surtido: toNonNegativeInt(body.no_surtido, 'no_surtido', actual.no_surtido ?? 0),
    observaciones: body.observaciones !== undefined
      ? String(body.observaciones || '').trim() || null
      : actual.observaciones ?? null
  };
}

export const iniciarSesion = asyncHandler(async (req, res) => {
  const sucursalId = toPositiveId(req.body.sucursal_id, 'sucursal_id');

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const surtidor = await obtenerSurtidorOperacion(
      connection,
      req,
      req.body.surtidor_id
    );

    const sucursal = await validarSucursalActiva(connection, sucursalId);

    const [abierta] = await connection.query(
      `
      SELECT id
      FROM productividad_sesiones
      WHERE surtidor_id = ?
        AND estado = 'EN_PROCESO'
      LIMIT 1
      `,
      [surtidor.id]
    );

    if (abierta.length > 0) {
      await connection.rollback();

      return res.status(409).json({
        ok: false,
        message: 'Este surtidor ya tiene una sesión en proceso',
        sesion_id: abierta[0].id
      });
    }

    const fechaOperativa = getFechaOperativa();

    const [result] = await connection.query(
      `
      INSERT INTO productividad_sesiones (
        surtidor_id,
        usuario_id,
        sucursal_id,
        fecha_operativa,
        hora_inicio,
        estado
      )
      VALUES (?, ?, ?, ?, NOW(), 'EN_PROCESO')
      `,
      [
        surtidor.id,
        req.user.id,
        sucursalId,
        fechaOperativa
      ]
    );

    const sesionId = result.insertId;

    await registrarEvento(connection, {
      sesionId,
      usuarioId: req.user.id,
      tipoEvento: 'INICIO',
      datosDespues: {
        sesion_id: sesionId,
        surtidor_id: surtidor.id,
        usuario_id: req.user.id,
        sucursal_id: sucursalId,
        fecha_operativa: fechaOperativa,
        estado: 'EN_PROCESO'
      }
    });

    await connection.commit();

    const sesion = await obtenerSesionPorId(pool, sesionId);

    return res.status(201).json({
      ok: true,
      message: 'Sesión iniciada correctamente',
      sesion
    });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
});

export const obtenerSesionActiva = asyncHandler(async (req, res) => {
  const connection = await pool.getConnection();

  try {
    let surtidor = null;

    if (req.user.rol === 'SURTIDOR') {
      surtidor = await obtenerSurtidorOperacion(connection, req);
    } else if (req.query.surtidor_id) {
      surtidor = await obtenerSurtidorOperacion(connection, req, req.query.surtidor_id);
    }

    const params = [];
    const where = [`ps.estado = 'EN_PROCESO'`];

    if (surtidor) {
      where.push('ps.surtidor_id = ?');
      params.push(surtidor.id);
    } else if (req.user.rol !== 'ADMIN' && req.user.rol !== 'SUPERVISOR') {
      return res.status(403).json({
        ok: false,
        message: 'No tienes permisos para consultar sesiones activas'
      });
    }

    const [rows] = await connection.query(
      `
      SELECT
        ps.id,
        ps.surtidor_id,
        ps.usuario_id,
        u.nombre AS surtidor_nombre,
        u.usuario AS surtidor_usuario,
        su.codigo AS surtidor_codigo,

        ps.sucursal_id,
        s.nombre AS sucursal_nombre,

        ps.fecha_operativa,
        ps.hora_inicio,
        ps.hora_fin,
        ps.duracion_segundos,

        TIMESTAMPDIFF(SECOND, ps.hora_inicio, NOW()) AS segundos_transcurridos,
        ROUND(TIMESTAMPDIFF(SECOND, ps.hora_inicio, NOW()) / 60, 2) AS minutos_transcurridos,

        ps.tickets,
        ps.partidas,
        ps.monto,
        ps.ceros,
        ps.no_surtido,

        ps.observaciones,
        ps.estado,
        ps.created_at,
        ps.updated_at
      FROM productividad_sesiones ps
      INNER JOIN surtidores su ON su.id = ps.surtidor_id
      INNER JOIN usuarios u ON u.id = ps.usuario_id
      INNER JOIN sucursales s ON s.id = ps.sucursal_id
      WHERE ${where.join(' AND ')}
      ORDER BY ps.hora_inicio DESC
      LIMIT 20
      `,
      params
    );

    if (req.user.rol === 'SURTIDOR' || req.query.surtidor_id) {
      return res.json({
        ok: true,
        sesion: rows[0] || null
      });
    }

    return res.json({
      ok: true,
      sesiones: rows
    });
  } finally {
    connection.release();
  }
});

export const listarSesiones = asyncHandler(async (req, res) => {
  const {
    fecha,
    estado,
    sucursal_id,
    surtidor_id,
    limit = 100
  } = req.query;

  const where = [];
  const params = [];

  if (req.user.rol === 'SURTIDOR') {
    where.push('ps.usuario_id = ?');
    params.push(req.user.id);
  }

  if (fecha) {
    where.push('ps.fecha_operativa = ?');
    params.push(fecha);
  }

  if (estado) {
    where.push('ps.estado = ?');
    params.push(String(estado).trim().toUpperCase());
  }

  if (sucursal_id) {
    where.push('ps.sucursal_id = ?');
    params.push(Number(sucursal_id));
  }

  if (surtidor_id && req.user.rol !== 'SURTIDOR') {
    where.push('ps.surtidor_id = ?');
    params.push(Number(surtidor_id));
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);

  const [sesiones] = await pool.query(
    `
    SELECT
      ps.id,
      ps.surtidor_id,
      ps.usuario_id,
      u.nombre AS surtidor_nombre,
      u.usuario AS surtidor_usuario,
      su.codigo AS surtidor_codigo,

      ps.sucursal_id,
      s.nombre AS sucursal_nombre,

      ps.fecha_operativa,
      ps.hora_inicio,
      ps.hora_fin,
      ps.duracion_segundos,

      ROUND(ps.duracion_segundos / 60, 2) AS duracion_minutos,
      ROUND(ps.duracion_segundos / 3600, 2) AS duracion_horas,

      ps.tickets,
      ps.partidas,
      ps.monto,
      ps.ceros,
      ps.no_surtido,

      CASE
        WHEN ps.duracion_segundos > 0 THEN ROUND(ps.tickets / (ps.duracion_segundos / 3600), 2)
        ELSE 0
      END AS tickets_por_hora,

      CASE
        WHEN ps.duracion_segundos > 0 THEN ROUND(ps.partidas / (ps.duracion_segundos / 3600), 2)
        ELSE 0
      END AS partidas_por_hora,

      ps.observaciones,
      ps.estado,
      ps.created_at,
      ps.updated_at
    FROM productividad_sesiones ps
    INNER JOIN surtidores su ON su.id = ps.surtidor_id
    INNER JOIN usuarios u ON u.id = ps.usuario_id
    INNER JOIN sucursales s ON s.id = ps.sucursal_id
    ${whereSql}
    ORDER BY ps.fecha_operativa DESC, ps.hora_inicio DESC
    LIMIT ${safeLimit}
    `,
    params
  );

  res.json({
    ok: true,
    sesiones
  });
});

export const obtenerSesion = asyncHandler(async (req, res) => {
  const id = toPositiveId(req.params.id, 'ID de sesión');

  const sesion = await obtenerSesionPorId(pool, id);

  if (!sesion) {
    return res.status(404).json({
      ok: false,
      message: 'Sesión no encontrada'
    });
  }

  validarPermisoSesion(req, sesion);

  res.json({
    ok: true,
    sesion
  });
});

export const guardarAvance = asyncHandler(async (req, res) => {
  const id = toPositiveId(req.params.id, 'ID de sesión');

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const sesionActual = await obtenerSesionPorId(connection, id);

    if (!sesionActual) {
      await connection.rollback();

      return res.status(404).json({
        ok: false,
        message: 'Sesión no encontrada'
      });
    }

    validarPermisoSesion(req, sesionActual);

    if (sesionActual.estado !== 'EN_PROCESO') {
      await connection.rollback();

      return res.status(400).json({
        ok: false,
        message: 'Solo se puede guardar avance en una sesión EN_PROCESO'
      });
    }

    const datos = construirPayloadDatos(req.body, sesionActual);

    const datosAntes = {
      tickets: sesionActual.tickets,
      partidas: sesionActual.partidas,
      monto: sesionActual.monto,
      ceros: sesionActual.ceros,
      no_surtido: sesionActual.no_surtido,
      observaciones: sesionActual.observaciones
    };

    await connection.query(
      `
      UPDATE productividad_sesiones
      SET
        tickets = ?,
        partidas = ?,
        monto = ?,
        ceros = ?,
        no_surtido = ?,
        observaciones = ?
      WHERE id = ?
      `,
      [
        datos.tickets,
        datos.partidas,
        datos.monto,
        datos.ceros,
        datos.no_surtido,
        datos.observaciones,
        id
      ]
    );

    await registrarEvento(connection, {
      sesionId: id,
      usuarioId: req.user.id,
      tipoEvento: 'GUARDADO_AVANCE',
      datosAntes,
      datosDespues: datos
    });

    await connection.commit();

    const sesion = await obtenerSesionPorId(pool, id);

    res.json({
      ok: true,
      message: 'Avance guardado correctamente',
      sesion
    });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
});

export const finalizarSesion = asyncHandler(async (req, res) => {
  const id = toPositiveId(req.params.id, 'ID de sesión');

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const sesionActual = await obtenerSesionPorId(connection, id);

    if (!sesionActual) {
      await connection.rollback();

      return res.status(404).json({
        ok: false,
        message: 'Sesión no encontrada'
      });
    }

    validarPermisoSesion(req, sesionActual);

    if (sesionActual.estado !== 'EN_PROCESO') {
      await connection.rollback();

      return res.status(400).json({
        ok: false,
        message: 'Solo se puede finalizar una sesión EN_PROCESO'
      });
    }

    const datos = construirPayloadDatos(req.body, sesionActual);

    const datosAntes = {
      tickets: sesionActual.tickets,
      partidas: sesionActual.partidas,
      monto: sesionActual.monto,
      ceros: sesionActual.ceros,
      no_surtido: sesionActual.no_surtido,
      observaciones: sesionActual.observaciones,
      estado: sesionActual.estado
    };

    await connection.query(
      `
      UPDATE productividad_sesiones
      SET
        tickets = ?,
        partidas = ?,
        monto = ?,
        ceros = ?,
        no_surtido = ?,
        observaciones = ?,
        hora_fin = NOW(),
        duracion_segundos = TIMESTAMPDIFF(SECOND, hora_inicio, NOW()),
        estado = 'FINALIZADO',
        finalizado_por = ?,
        finalizado_at = NOW()
      WHERE id = ?
      `,
      [
        datos.tickets,
        datos.partidas,
        datos.monto,
        datos.ceros,
        datos.no_surtido,
        datos.observaciones,
        req.user.id,
        id
      ]
    );

    await registrarEvento(connection, {
      sesionId: id,
      usuarioId: req.user.id,
      tipoEvento: 'FINALIZACION',
      datosAntes,
      datosDespues: {
        ...datos,
        estado: 'FINALIZADO'
      }
    });

    await connection.commit();

    const sesion = await obtenerSesionPorId(pool, id);

    res.json({
      ok: true,
      message: 'Sesión finalizada correctamente',
      sesion
    });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
});

export const cancelarSesion = asyncHandler(async (req, res) => {
  const id = toPositiveId(req.params.id, 'ID de sesión');
  const motivo = String(req.body.motivo || '').trim();

  if (motivo.length < 3) {
    return res.status(400).json({
      ok: false,
      message: 'El motivo de cancelación es obligatorio'
    });
  }

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const sesionActual = await obtenerSesionPorId(connection, id);

    if (!sesionActual) {
      await connection.rollback();

      return res.status(404).json({
        ok: false,
        message: 'Sesión no encontrada'
      });
    }

    validarPermisoSesion(req, sesionActual);

    if (sesionActual.estado !== 'EN_PROCESO') {
      await connection.rollback();

      return res.status(400).json({
        ok: false,
        message: 'Solo se puede cancelar una sesión EN_PROCESO'
      });
    }

    await connection.query(
      `
      UPDATE productividad_sesiones
      SET
        hora_fin = NOW(),
        duracion_segundos = TIMESTAMPDIFF(SECOND, hora_inicio, NOW()),
        estado = 'CANCELADO',
        cancelado_motivo = ?,
        cancelado_por = ?,
        cancelado_at = NOW()
      WHERE id = ?
      `,
      [motivo, req.user.id, id]
    );

    await registrarEvento(connection, {
      sesionId: id,
      usuarioId: req.user.id,
      tipoEvento: 'CANCELACION',
      datosAntes: {
        estado: sesionActual.estado
      },
      datosDespues: {
        estado: 'CANCELADO',
        motivo
      },
      motivo
    });

    await connection.commit();

    const sesion = await obtenerSesionPorId(pool, id);

    res.json({
      ok: true,
      message: 'Sesión cancelada correctamente',
      sesion
    });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
});