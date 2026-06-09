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

function validarFecha(fecha) {
  if (fecha === undefined || fecha === null || fecha === '') {
    return null;
  }

  const value = String(fecha).trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const error = new Error('La fecha debe tener formato YYYY-MM-DD');
    error.status = 400;
    throw error;
  }

  return value;
}

async function validarSucursalActiva(connection, sucursalId) {
  const [rows] = await connection.query(
    `
    SELECT id, nombre, activo
    FROM sucursales
    WHERE id = ?
    LIMIT 1
    `,
    [sucursalId]
  );

  if (rows.length === 0) {
    const error = new Error('Sucursal no encontrada');
    error.status = 404;
    throw error;
  }

  if (!rows[0].activo) {
    const error = new Error('No puedes asignar una sesión a una sucursal inactiva');
    error.status = 400;
    throw error;
  }

  return rows[0];
}

async function obtenerSesionCompleta(connection, id) {
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
    WHERE ps.id = ?
    LIMIT 1
    `,
    [id]
  );

  return rows[0] || null;
}

async function registrarEventoSesion(connection, {
  sesionId,
  usuarioId,
  datosAntes,
  datosDespues,
  motivo
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
    VALUES (?, ?, 'AJUSTE_ADMIN', ?, ?, ?)
    `,
    [
      sesionId,
      usuarioId,
      JSON.stringify(datosAntes),
      JSON.stringify(datosDespues),
      motivo
    ]
  );
}

export const ajustarSesionFinalizada = asyncHandler(async (req, res) => {
  const id = toPositiveId(req.params.id, 'ID de sesión');
  const motivo = String(req.body.motivo || '').trim();

  if (motivo.length < 5) {
    return res.status(400).json({
      ok: false,
      message: 'El motivo del ajuste es obligatorio y debe tener al menos 5 caracteres'
    });
  }

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const sesionActual = await obtenerSesionCompleta(connection, id);

    if (!sesionActual) {
      await connection.rollback();

      return res.status(404).json({
        ok: false,
        message: 'Sesión no encontrada'
      });
    }

    if (sesionActual.estado !== 'FINALIZADO') {
      await connection.rollback();

      return res.status(400).json({
        ok: false,
        message: 'Solo se pueden ajustar sesiones FINALIZADAS'
      });
    }

    const nuevaSucursalId = req.body.sucursal_id !== undefined
      ? toPositiveId(req.body.sucursal_id, 'sucursal_id')
      : sesionActual.sucursal_id;

    if (Number(nuevaSucursalId) !== Number(sesionActual.sucursal_id)) {
      await validarSucursalActiva(connection, nuevaSucursalId);
    }

    const nuevaFechaOperativa = req.body.fecha_operativa !== undefined
      ? validarFecha(req.body.fecha_operativa)
      : sesionActual.fecha_operativa;

    const datosNuevos = {
      fecha_operativa: nuevaFechaOperativa,
      sucursal_id: nuevaSucursalId,
      tickets: toNonNegativeInt(req.body.tickets, 'tickets', sesionActual.tickets),
      partidas: toNonNegativeInt(req.body.partidas, 'partidas', sesionActual.partidas),
      monto: toNonNegativeDecimal(req.body.monto, 'monto', sesionActual.monto),
      ceros: toNonNegativeInt(req.body.ceros, 'ceros', sesionActual.ceros),
      no_surtido: toNonNegativeInt(req.body.no_surtido, 'no_surtido', sesionActual.no_surtido),
      observaciones: req.body.observaciones !== undefined
        ? String(req.body.observaciones || '').trim() || null
        : sesionActual.observaciones
    };

    const datosAntes = {
      fecha_operativa: sesionActual.fecha_operativa,
      sucursal_id: sesionActual.sucursal_id,
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
        fecha_operativa = ?,
        sucursal_id = ?,
        tickets = ?,
        partidas = ?,
        monto = ?,
        ceros = ?,
        no_surtido = ?,
        observaciones = ?
      WHERE id = ?
      `,
      [
        datosNuevos.fecha_operativa,
        datosNuevos.sucursal_id,
        datosNuevos.tickets,
        datosNuevos.partidas,
        datosNuevos.monto,
        datosNuevos.ceros,
        datosNuevos.no_surtido,
        datosNuevos.observaciones,
        id
      ]
    );

    await registrarEventoSesion(connection, {
      sesionId: id,
      usuarioId: req.user.id,
      datosAntes,
      datosDespues: datosNuevos,
      motivo
    });

    await registrarAuditoria(connection, {
      req,
      modulo: 'PRODUCTIVIDAD',
      accion: 'AJUSTAR_SESION_FINALIZADA',
      entidad: 'productividad_sesiones',
      entidadId: id,
      datosAntes,
      datosDespues: {
        ...datosNuevos,
        motivo
      }
    });

    await connection.commit();

    const sesion = await obtenerSesionCompleta(pool, id);

    res.json({
      ok: true,
      message: 'Sesión ajustada correctamente',
      sesion
    });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
});

export const listarEventosSesion = asyncHandler(async (req, res) => {
  const id = toPositiveId(req.params.id, 'ID de sesión');

  const [sesionRows] = await pool.query(
    `
    SELECT id
    FROM productividad_sesiones
    WHERE id = ?
    LIMIT 1
    `,
    [id]
  );

  if (sesionRows.length === 0) {
    return res.status(404).json({
      ok: false,
      message: 'Sesión no encontrada'
    });
  }

  const [eventos] = await pool.query(
    `
    SELECT
      ev.id,
      ev.sesion_id,
      ev.usuario_id,
      u.nombre AS usuario_nombre,
      u.usuario,
      u.rol,

      ev.tipo_evento,
      ev.datos_antes,
      ev.datos_despues,
      ev.motivo,
      ev.created_at
    FROM productividad_sesion_eventos ev
    INNER JOIN usuarios u ON u.id = ev.usuario_id
    WHERE ev.sesion_id = ?
    ORDER BY ev.created_at ASC, ev.id ASC
    `,
    [id]
  );

  res.json({
    ok: true,
    sesion_id: id,
    eventos: eventos.map((evento) => ({
      ...evento,
      datos_antes: evento.datos_antes ? JSON.parse(evento.datos_antes) : null,
      datos_despues: evento.datos_despues ? JSON.parse(evento.datos_despues) : null
    }))
  });
});