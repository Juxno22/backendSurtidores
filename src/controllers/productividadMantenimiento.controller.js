import { pool } from '../config/db.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  diffSecondsLocal,
  getNowMexicoDateTime
} from '../utils/mexicoTime.js';

import {
  getSegundosLaboralesEntre
} from '../utils/jornadaLaboral.js';

function validarFecha(value, fieldName) {
  const fecha = String(value || '').trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    const error = new Error(`${fieldName} debe tener formato YYYY-MM-DD`);
    error.status = 400;
    throw error;
  }

  return fecha;
}

function toNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function normalizeDateTime(value) {
  if (!value) return null;

  return String(value)
    .replace('T', ' ')
    .replace('.000Z', '')
    .slice(0, 19);
}

function buildCambios(row) {
  const horaInicio = normalizeDateTime(row.hora_inicio);
  const horaFin = normalizeDateTime(row.hora_fin);

  const partidas = toNumber(row.partidas);
  const ceros = toNumber(row.ceros);
  const negados = toNumber(row.no_surtido);

  const surtidoTotalCalculado = partidas + ceros + negados;

  const duracionSegundosCalculada = horaInicio && horaFin
    ? diffSecondsLocal(horaInicio, horaFin)
    : 0;

  const duracionLaboralSegundosCalculada = horaInicio && horaFin
    ? getSegundosLaboralesEntre(horaInicio, horaFin)
    : 0;

  const actual = {
    tickets: toNumber(row.tickets),
    monto: toNumber(row.monto),
    duracion_segundos: toNumber(row.duracion_segundos),
    duracion_laboral_segundos: toNumber(row.duracion_laboral_segundos)
  };

  const nuevo = {
    tickets: surtidoTotalCalculado,
    monto: 0,
    duracion_segundos: duracionSegundosCalculada,
    duracion_laboral_segundos: duracionLaboralSegundosCalculada
  };

  const requiereCambio =
    actual.tickets !== nuevo.tickets ||
    actual.monto !== nuevo.monto ||
    actual.duracion_segundos !== nuevo.duracion_segundos ||
    actual.duracion_laboral_segundos !== nuevo.duracion_laboral_segundos;

  return {
    requiere_cambio: requiereCambio,
    actual,
    nuevo,
    calculos: {
      hora_inicio: horaInicio,
      hora_fin: horaFin,
      partidas,
      ceros,
      negados,
      surtido_total_calculado: surtidoTotalCalculado
    }
  };
}

export const recalcularSesiones = asyncHandler(async (req, res) => {
  const desde = validarFecha(req.body.desde, 'desde');
  const hasta = validarFecha(req.body.hasta, 'hasta');

  const dryRun = req.body.dry_run !== false;
  const motivo = String(req.body.motivo || '').trim();

  if (!dryRun && !motivo) {
    const error = new Error('El motivo es obligatorio cuando dry_run es false.');
    error.status = 400;
    throw error;
  }

  const [rows] = await pool.query(
    `
    SELECT
      ps.id,
      DATE_FORMAT(ps.fecha_operativa, '%Y-%m-%d') AS fecha_operativa,
      DATE_FORMAT(ps.hora_inicio, '%Y-%m-%d %H:%i:%s') AS hora_inicio,
      DATE_FORMAT(ps.hora_fin, '%Y-%m-%d %H:%i:%s') AS hora_fin,

      ps.estado,
      ps.surtidor_id,
      ps.usuario_id,
      ps.sucursal_id,

      ps.tickets,
      ps.partidas,
      ps.ceros,
      ps.no_surtido,
      ps.monto,

      ps.duracion_segundos,
      ps.duracion_laboral_segundos,

      u.nombre AS surtidor_nombre,
      s.nombre AS sucursal_nombre
    FROM productividad_sesiones ps
    INNER JOIN surtidores st ON st.id = ps.surtidor_id
    INNER JOIN usuarios u ON u.id = st.usuario_id
    INNER JOIN sucursales s ON s.id = ps.sucursal_id
    WHERE ps.fecha_operativa BETWEEN ? AND ?
      AND ps.estado = 'FINALIZADO'
    ORDER BY ps.fecha_operativa ASC, ps.id ASC
    `,
    [desde, hasta]
  );

  const revisadas = [];
  const cambios = [];

  for (const row of rows) {
    const cambio = buildCambios(row);

    const detalle = {
      id: row.id,
      fecha_operativa: row.fecha_operativa,
      surtidor_id: row.surtidor_id,
      surtidor_nombre: row.surtidor_nombre,
      sucursal_id: row.sucursal_id,
      sucursal_nombre: row.sucursal_nombre,
      estado: row.estado,
      ...cambio
    };

    revisadas.push(detalle);

    if (cambio.requiere_cambio) {
      cambios.push(detalle);
    }
  }

  if (!dryRun && cambios.length > 0) {
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      const now = getNowMexicoDateTime();

      for (const item of cambios) {
        await connection.query(
          `
          UPDATE productividad_sesiones
          SET
            tickets = ?,
            monto = 0,
            duracion_segundos = ?,
            duracion_laboral_segundos = ?,
            updated_at = ?
          WHERE id = ?
          `,
          [
            item.nuevo.tickets,
            item.nuevo.duracion_segundos,
            item.nuevo.duracion_laboral_segundos,
            now,
            item.id
          ]
        );

        await connection.query(
          `
          INSERT INTO productividad_sesion_eventos (
            sesion_id,
            usuario_id,
            tipo_evento,
            datos_antes,
            datos_despues,
            motivo,
            created_at
          )
          VALUES (?, ?, 'AJUSTE_ADMIN', ?, ?, ?, ?)
          `,
          [
            item.id,
            req.user.id,
            JSON.stringify(item.actual),
            JSON.stringify(item.nuevo),
            motivo,
            now
          ]
        );
      }

      await connection.query(
        `
        INSERT INTO auditoria_acciones (
          usuario_id,
          modulo,
          accion,
          entidad,
          entidad_id,
          datos_antes,
          datos_despues,
          ip,
          user_agent,
          created_at
        )
        VALUES (?, 'PRODUCTIVIDAD', 'RECALCULO_HISTORICO_SESIONES', 'productividad_sesiones', NULL, ?, ?, ?, ?, ?)
        `,
        [
          req.user.id,
          JSON.stringify({
            desde,
            hasta,
            total_revisadas: revisadas.length
          }),
          JSON.stringify({
            total_actualizadas: cambios.length,
            sesiones_actualizadas: cambios.map((item) => item.id)
          }),
          req.ip,
          req.get('user-agent') || null,
          now
        ]
      );

      await connection.commit();
    } catch (error) {
      try {
        await connection.rollback();
      } catch {}

      throw error;
    } finally {
      connection.release();
    }
  }

  res.json({
    ok: true,
    dry_run: dryRun,
    filtros: {
      desde,
      hasta
    },
    resumen: {
      sesiones_revisadas: revisadas.length,
      sesiones_con_cambios: cambios.length,
      sesiones_actualizadas: dryRun ? 0 : cambios.length
    },
    cambios
  });
});