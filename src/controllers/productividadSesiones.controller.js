import { pool } from '../config/db.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  getFechaOperativaMexico,
  getNowMexicoDateTime,
  diffSecondsLocal
} from '../utils/mexicoTime.js';
import {
  getSegundosLaboralesEntre
} from '../utils/jornadaLaboral.js';

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

function json(value) {
  return JSON.stringify(value ?? null);
}

async function safeRollback(connection) {
  try {
    await connection.rollback();
  } catch (rollbackError) {
    console.warn('Rollback falló después del error principal:', {
      code: rollbackError?.code,
      message: rollbackError?.message
    });
  }
}

function formatRuntimeFields(row, nowMexico = getNowMexicoDateTime()) {
  if (!row) return row;

  const isActive = row.estado === 'EN_PROCESO';
  const runtimeSeconds = isActive
    ? diffSecondsLocal(row.hora_inicio, nowMexico)
    : Number(row.duracion_segundos || 0);

  const runtimeLaboralSeconds = isActive
    ? getSegundosLaboralesEntre(row.hora_inicio, nowMexico)
    : Number(row.duracion_laboral_segundos || 0);

  return {
    ...row,

    surtido_total: Number(row.tickets || 0),
    partidas_surtidas: Number(row.partidas || 0),
    negados: Number(row.no_surtido || 0),

    duracion_segundos: Number(row.duracion_segundos || 0),
    duracion_laboral_segundos: Number(row.duracion_laboral_segundos || 0),

    segundos_transcurridos: runtimeSeconds,
    minutos_transcurridos: Number((runtimeSeconds / 60).toFixed(2)),
    horas_transcurridas: Number((runtimeSeconds / 3600).toFixed(2)),

    segundos_laborales_transcurridos: runtimeLaboralSeconds,
    minutos_laborales_transcurridos: Number((runtimeLaboralSeconds / 60).toFixed(2)),
    horas_laborales_transcurridas: Number((runtimeLaboralSeconds / 3600).toFixed(2))
  };
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

      DATE_FORMAT(ps.fecha_operativa, '%Y-%m-%d') AS fecha_operativa,
      DATE_FORMAT(ps.hora_inicio, '%Y-%m-%d %H:%i:%s') AS hora_inicio,
      DATE_FORMAT(ps.hora_fin, '%Y-%m-%d %H:%i:%s') AS hora_fin,

      ps.duracion_segundos,
      ps.duracion_laboral_segundos,

      ROUND(ps.duracion_segundos / 60, 2) AS duracion_minutos,
      ROUND(ps.duracion_segundos / 3600, 2) AS duracion_horas,
      ROUND(ps.duracion_laboral_segundos / 60, 2) AS duracion_laboral_minutos,
      ROUND(ps.duracion_laboral_segundos / 3600, 2) AS duracion_laboral_horas,

      ps.tickets,
      ps.tickets AS surtido_total,
      ps.partidas,
      ps.partidas AS partidas_surtidas,
      ps.monto,
      ps.ceros,
      ps.no_surtido,
      ps.no_surtido AS negados,

      ps.observaciones,
      ps.estado,

      ps.cancelado_motivo,
      ps.cancelado_por,
      DATE_FORMAT(ps.cancelado_at, '%Y-%m-%d %H:%i:%s') AS cancelado_at,

      ps.finalizado_por,
      DATE_FORMAT(ps.finalizado_at, '%Y-%m-%d %H:%i:%s') AS finalizado_at,

      DATE_FORMAT(ps.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
      DATE_FORMAT(ps.updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at
    FROM productividad_sesiones ps
    INNER JOIN surtidores su ON su.id = ps.surtidor_id
    INNER JOIN usuarios u ON u.id = ps.usuario_id
    INNER JOIN sucursales s ON s.id = ps.sucursal_id
    WHERE ps.id = ?
    LIMIT 1
    `,
    [id]
  );

  return formatRuntimeFields(rows[0] || null);
}

function construirPayloadDatos(body, actual = {}) {
  const partidasSurtidas = toNonNegativeInt(
    body.partidas_surtidas ?? body.partidas,
    'partidas_surtidas',
    actual.partidas ?? 0
  );

  const ceros = toNonNegativeInt(
    body.ceros,
    'ceros',
    actual.ceros ?? 0
  );

  const negados = toNonNegativeInt(
    body.negados ?? body.no_surtido,
    'negados',
    actual.no_surtido ?? 0
  );

  const surtidoTotal = partidasSurtidas + ceros + negados;

  return {
    tickets: surtidoTotal,
    surtido_total: surtidoTotal,
    partidas: partidasSurtidas,
    partidas_surtidas: partidasSurtidas,
    monto: 0,
    ceros,
    no_surtido: negados,
    negados,
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

    await validarSucursalActiva(connection, sucursalId);

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

    const fechaOperativa = getFechaOperativaMexico();
    const horaInicio = getNowMexicoDateTime();

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
      VALUES (?, ?, ?, ?, ?, 'EN_PROCESO')
      `,
      [
        surtidor.id,
        req.user.id,
        sucursalId,
        fechaOperativa,
        horaInicio
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
        hora_inicio: horaInicio,
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
    await safeRollback(connection);
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

        DATE_FORMAT(ps.fecha_operativa, '%Y-%m-%d') AS fecha_operativa,
        DATE_FORMAT(ps.hora_inicio, '%Y-%m-%d %H:%i:%s') AS hora_inicio,
        DATE_FORMAT(ps.hora_fin, '%Y-%m-%d %H:%i:%s') AS hora_fin,

        ps.duracion_segundos,
        ps.duracion_laboral_segundos,

        ps.tickets,
        ps.tickets AS surtido_total,
        ps.partidas,
        ps.partidas AS partidas_surtidas,
        ps.monto,
        ps.ceros,
        ps.no_surtido,
        ps.no_surtido AS negados,

        ps.observaciones,
        ps.estado,
        DATE_FORMAT(ps.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
        DATE_FORMAT(ps.updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at
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

    const nowMexico = getNowMexicoDateTime();
    const sesiones = rows.map((row) => formatRuntimeFields(row, nowMexico));

    if (req.user.rol === 'SURTIDOR' || req.query.surtidor_id) {
      return res.json({
        ok: true,
        sesion: sesiones[0] || null
      });
    }

    return res.json({
      ok: true,
      sesiones
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

  const [rows] = await pool.query(
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

      DATE_FORMAT(ps.fecha_operativa, '%Y-%m-%d') AS fecha_operativa,
      DATE_FORMAT(ps.hora_inicio, '%Y-%m-%d %H:%i:%s') AS hora_inicio,
      DATE_FORMAT(ps.hora_fin, '%Y-%m-%d %H:%i:%s') AS hora_fin,

      ps.duracion_segundos,
      ps.duracion_laboral_segundos,

      ROUND(ps.duracion_segundos / 60, 2) AS duracion_minutos,
      ROUND(ps.duracion_segundos / 3600, 2) AS duracion_horas,
      ROUND(ps.duracion_laboral_segundos / 60, 2) AS duracion_laboral_minutos,
      ROUND(ps.duracion_laboral_segundos / 3600, 2) AS duracion_laboral_horas,

      ps.tickets,
      ps.tickets AS surtido_total,
      ps.partidas,
      ps.partidas AS partidas_surtidas,
      ps.monto,
      ps.ceros,
      ps.no_surtido,
      ps.no_surtido AS negados,

      CASE
        WHEN ps.duracion_segundos > 0 THEN ROUND(ps.tickets / (ps.duracion_segundos / 3600), 2)
        ELSE 0
      END AS surtido_por_hora_real,

      CASE
        WHEN ps.duracion_laboral_segundos > 0 THEN ROUND(ps.tickets / (ps.duracion_laboral_segundos / 3600), 2)
        ELSE 0
      END AS surtido_por_hora_laboral,

      CASE
        WHEN ps.duracion_laboral_segundos > 0 THEN ROUND(ps.partidas / (ps.duracion_laboral_segundos / 3600), 2)
        ELSE 0
      END AS partidas_por_hora_laboral,

      ps.observaciones,
      ps.estado,
      DATE_FORMAT(ps.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
      DATE_FORMAT(ps.updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at
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

  const nowMexico = getNowMexicoDateTime();
  const sesiones = rows.map((row) => formatRuntimeFields(row, nowMexico));

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
    const nowMexico = getNowMexicoDateTime();

    const datosAntes = {
      surtido_total: sesionActual.tickets,
      partidas_surtidas: sesionActual.partidas,
      ceros: sesionActual.ceros,
      negados: sesionActual.no_surtido,
      monto: sesionActual.monto,
      observaciones: sesionActual.observaciones
    };

    await connection.query(
      `
      UPDATE productividad_sesiones
      SET
        tickets = ?,
        partidas = ?,
        monto = 0,
        ceros = ?,
        no_surtido = ?,
        observaciones = ?,
        updated_at = ?
      WHERE id = ?
      `,
      [
        datos.surtido_total,
        datos.partidas_surtidas,
        datos.ceros,
        datos.negados,
        datos.observaciones,
        nowMexico,
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
    await safeRollback(connection);
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
    const horaFin = getNowMexicoDateTime();

    const duracionSegundos = diffSecondsLocal(
      sesionActual.hora_inicio,
      horaFin
    );

    const duracionLaboralSegundos = getSegundosLaboralesEntre(
      sesionActual.hora_inicio,
      horaFin
    );

    const datosAntes = {
      surtido_total: sesionActual.tickets,
      partidas_surtidas: sesionActual.partidas,
      ceros: sesionActual.ceros,
      negados: sesionActual.no_surtido,
      monto: sesionActual.monto,
      observaciones: sesionActual.observaciones,
      estado: sesionActual.estado
    };

    await connection.query(
      `
      UPDATE productividad_sesiones
      SET
        tickets = ?,
        partidas = ?,
        monto = 0,
        ceros = ?,
        no_surtido = ?,
        observaciones = ?,
        hora_fin = ?,
        duracion_segundos = ?,
        duracion_laboral_segundos = ?,
        estado = 'FINALIZADO',
        finalizado_por = ?,
        finalizado_at = ?,
        updated_at = ?
      WHERE id = ?
      `,
      [
        datos.surtido_total,
        datos.partidas_surtidas,
        datos.ceros,
        datos.negados,
        datos.observaciones,
        horaFin,
        duracionSegundos,
        duracionLaboralSegundos,
        req.user.id,
        horaFin,
        horaFin,
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
        hora_fin: horaFin,
        duracion_segundos: duracionSegundos,
        duracion_laboral_segundos: duracionLaboralSegundos,
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
    await safeRollback(connection);
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

    const horaFin = getNowMexicoDateTime();

    const duracionSegundos = diffSecondsLocal(
      sesionActual.hora_inicio,
      horaFin
    );

    const duracionLaboralSegundos = getSegundosLaboralesEntre(
      sesionActual.hora_inicio,
      horaFin
    );

    await connection.query(
      `
      UPDATE productividad_sesiones
      SET
        hora_fin = ?,
        duracion_segundos = ?,
        duracion_laboral_segundos = ?,
        estado = 'CANCELADO',
        cancelado_motivo = ?,
        cancelado_por = ?,
        cancelado_at = ?,
        updated_at = ?
      WHERE id = ?
      `,
      [
        horaFin,
        duracionSegundos,
        duracionLaboralSegundos,
        motivo,
        req.user.id,
        horaFin,
        horaFin,
        id
      ]
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
        motivo,
        hora_fin: horaFin,
        duracion_segundos: duracionSegundos,
        duracion_laboral_segundos: duracionLaboralSegundos
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
    await safeRollback(connection);
    throw error;
  } finally {
    connection.release();
  }
});
