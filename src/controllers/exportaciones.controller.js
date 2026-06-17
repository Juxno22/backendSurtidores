import { pool } from '../config/db.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getFechaOperativaMexico, getNowMexicoDateTime } from '../utils/mexicoTime.js';
import {
  getJornadaLaboral,
  getJornadaTranscurridaSegundos
} from '../utils/jornadaLaboral.js';
import {
  validarFormatoExportacion,
  sendExport,
  sendXlsx,
  formatDate,
  formatDateTime,
  round2,
  calcularMetricas,
  segundosAHoras,
  segundosAMinutos,
  safeDivide,
  safePct
} from '../utils/exportHelpers.js';

function validarFecha(fecha, fieldName = 'fecha') {
  const value = String(fecha || '').trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const error = new Error(`${fieldName} debe tener formato YYYY-MM-DD`);
    error.status = 400;
    throw error;
  }

  return value;
}

function validarFechaOpcional(fecha, fieldName = 'fecha') {
  if (!fecha) return null;
  return validarFecha(fecha, fieldName);
}

function obtenerRango(query = {}) {
  const fecha = validarFechaOpcional(query.fecha);

  if (fecha) {
    return { fecha, desde: fecha, hasta: fecha };
  }

  const hoy = getFechaOperativaMexico();
  const desde = validarFecha(query.desde || hoy, 'desde');
  const hasta = validarFecha(query.hasta || desde, 'hasta');

  return { fecha: null, desde, hasta };
}

function toPositiveIdOptional(value, fieldName) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const id = Number(value);

  if (!Number.isInteger(id) || id <= 0) {
    const error = new Error(`${fieldName} inválido`);
    error.status = 400;
    throw error;
  }

  return id;
}

function safeLimit(value, defaultValue = 5000, maxValue = 20000) {
  const limit = Number(value || defaultValue);
  return Math.min(Math.max(Number.isFinite(limit) ? limit : defaultValue, 1), maxValue);
}

function parseFechaList(value) {
  if (!value) return [];

  return String(value)
    .split(',')
    .map((item) => item.trim().slice(0, 10))
    .filter(Boolean);
}

function sumHorasJornada(fechas = []) {
  return fechas.reduce((acc, fecha) => {
    const jornada = getJornadaLaboral(fecha);
    return acc + Number(jornada.horas_netas || 0);
  }, 0);
}

function estadoComparativo(app, reporte) {
  if (!reporte) return 'SIN_REPORTE';

  const tieneCaptura =
    Number(app?.surtido_total || app?.tickets || 0) > 0 ||
    Number(app?.partidas_surtidas || app?.partidas || 0) > 0 ||
    Number(app?.ceros || 0) > 0 ||
    Number(app?.negados || app?.no_surtido || 0) > 0;

  if (!tieneCaptura) return 'SIN_CAPTURA';

  const difSurtido = Number(app.surtido_total || app.tickets || 0) - Number(reporte.surtido || 0);
  const difPartidas = Number(app.partidas_surtidas || app.partidas || 0) - Number(reporte.partidas || 0);
  const difCeros = Number(app.ceros || 0) - Number(reporte.ceros || 0);
  const difNegados = Number(app.negados || app.no_surtido || 0) - Number(reporte.no_surtido || 0);

  if (difSurtido === 0 && difPartidas === 0 && difCeros === 0 && difNegados === 0) {
    return 'CUADRADO';
  }

  return 'CON_DIFERENCIAS';
}

async function obtenerComparativoRows({ fecha, sucursalId = null }) {
  const paramsApp = [fecha];
  const whereApp = [
    `ps.fecha_operativa = ?`,
    `ps.estado = 'FINALIZADO'`
  ];

  if (sucursalId) {
    whereApp.push('ps.sucursal_id = ?');
    paramsApp.push(sucursalId);
  }

  const [appRows] = await pool.query(
    `
    SELECT
      DATE_FORMAT(ps.fecha_operativa, '%Y-%m-%d') AS fecha,
      ps.sucursal_id,
      s.nombre AS sucursal_nombre,
      COUNT(*) AS sesiones_finalizadas,
      COUNT(DISTINCT ps.surtidor_id) AS surtidores_con_captura,
      COALESCE(SUM(ps.tickets), 0) AS surtido_total,
      COALESCE(SUM(ps.partidas), 0) AS partidas_surtidas,
      COALESCE(SUM(ps.ceros), 0) AS ceros,
      COALESCE(SUM(ps.no_surtido), 0) AS negados,
      COALESCE(SUM(ps.duracion_segundos), 0) AS duracion_segundos,
      COALESCE(SUM(ps.duracion_laboral_segundos), 0) AS duracion_laboral_segundos
    FROM productividad_sesiones ps
    INNER JOIN sucursales s ON s.id = ps.sucursal_id
    WHERE ${whereApp.join(' AND ')}
    GROUP BY ps.fecha_operativa, ps.sucursal_id, s.nombre
    `,
    paramsApp
  );

  const paramsReporte = [fecha];
  const whereReporte = [`rg.fecha = ?`];

  if (sucursalId) {
    whereReporte.push('rg.sucursal_id = ?');
    paramsReporte.push(sucursalId);
  }

  const [reporteRows] = await pool.query(
    `
    SELECT
      rg.id,
      DATE_FORMAT(rg.fecha, '%Y-%m-%d') AS fecha,
      rg.sucursal_id,
      s.nombre AS sucursal_nombre,
      rg.surtido,
      rg.partidas,
      rg.ceros,
      rg.no_surtido,
      rg.porcentaje_surtido,
      rg.estado,
      rg.fuente
    FROM reporte_grupal_surtido rg
    INNER JOIN sucursales s ON s.id = rg.sucursal_id
    WHERE ${whereReporte.join(' AND ')}
    `,
    paramsReporte
  );

  const map = new Map();

  for (const row of appRows) {
    const key = Number(row.sucursal_id);
    map.set(key, {
      sucursal_id: key,
      sucursal_nombre: row.sucursal_nombre,
      app: row,
      reporte: null
    });
  }

  for (const row of reporteRows) {
    const key = Number(row.sucursal_id);

    if (!map.has(key)) {
      map.set(key, {
        sucursal_id: key,
        sucursal_nombre: row.sucursal_nombre,
        app: null,
        reporte: row
      });
    } else {
      map.get(key).reporte = row;
    }
  }

  return Array.from(map.values())
    .map((item) => {
      const app = item.app || {
        sesiones_finalizadas: 0,
        surtidores_con_captura: 0,
        surtido_total: 0,
        partidas_surtidas: 0,
        ceros: 0,
        negados: 0,
        duracion_segundos: 0,
        duracion_laboral_segundos: 0
      };

      const metricas = calcularMetricas(app);
      const reporte = item.reporte;

      const surtidoApp = Number(app.surtido_total || 0);
      const partidasApp = Number(app.partidas_surtidas || 0);
      const cerosApp = Number(app.ceros || 0);
      const negadosApp = Number(app.negados || 0);

      const surtidoReporte = Number(reporte?.surtido || 0);
      const partidasReporte = Number(reporte?.partidas || 0);
      const cerosReporte = Number(reporte?.ceros || 0);
      const negadosReporte = Number(reporte?.no_surtido || 0);

      return {
        Fecha: fecha,
        Sucursal: item.sucursal_nombre,
        'Sesiones finalizadas': Number(app.sesiones_finalizadas || 0),
        'Surtidores con captura': Number(app.surtidores_con_captura || 0),
        'Surtido total app': surtidoApp,
        'Surtido total reporte': surtidoReporte,
        'Diferencia surtido total': surtidoApp - surtidoReporte,
        'Partidas surtidas app': partidasApp,
        'Partidas surtidas reporte': partidasReporte,
        'Diferencia partidas': partidasApp - partidasReporte,
        'Ceros app': cerosApp,
        'Ceros reporte': cerosReporte,
        'Diferencia ceros': cerosApp - cerosReporte,
        'Negados app': negadosApp,
        'Negados reporte': negadosReporte,
        'Diferencia negados': negadosApp - negadosReporte,
        'Horas reales': metricas.duracion_horas,
        'Horas laborales': metricas.duracion_laboral_horas,
        'Partidas/h laboral': metricas.partidas_por_hora_laboral,
        '% surtido reporte': reporte?.porcentaje_surtido ?? '',
        'Fuente reporte': reporte?.fuente ?? '',
        'Estado reporte': reporte?.estado ?? '',
        'Estado comparativo': estadoComparativo(app, reporte)
      };
    })
    .sort((a, b) => String(a.Sucursal).localeCompare(String(b.Sucursal)));
}

export const exportarConcentradoSurtidores = asyncHandler(async (req, res) => {
  const fecha = validarFecha(req.query.fecha);
  const formato = validarFormatoExportacion(req.query.formato);
  const sucursalId = toPositiveIdOptional(req.query.sucursal_id, 'sucursal_id');
  const surtidorId = toPositiveIdOptional(req.query.surtidor_id, 'surtidor_id');

  const where = [`ps.fecha_operativa = ?`, `ps.estado = 'FINALIZADO'`];
  const params = [fecha];

  if (sucursalId) {
    where.push('ps.sucursal_id = ?');
    params.push(sucursalId);
  }

  if (surtidorId) {
    where.push('ps.surtidor_id = ?');
    params.push(surtidorId);
  }

  const [rows] = await pool.query(
    `
    SELECT
      DATE_FORMAT(ps.fecha_operativa, '%Y-%m-%d') AS fecha,
      ps.surtidor_id,
      u.nombre AS surtidor_nombre,
      su.codigo AS surtidor_codigo,
      ps.sucursal_id,
      s.nombre AS sucursal_nombre,
      COUNT(*) AS sesiones_finalizadas,
      COALESCE(SUM(ps.tickets), 0) AS surtido_total,
      COALESCE(SUM(ps.partidas), 0) AS partidas_surtidas,
      COALESCE(SUM(ps.ceros), 0) AS ceros,
      COALESCE(SUM(ps.no_surtido), 0) AS negados,
      COALESCE(SUM(ps.duracion_segundos), 0) AS duracion_segundos,
      COALESCE(SUM(ps.duracion_laboral_segundos), 0) AS duracion_laboral_segundos,
      DATE_FORMAT(MIN(ps.hora_inicio), '%Y-%m-%d %H:%i:%s') AS primer_inicio,
      DATE_FORMAT(MAX(ps.hora_fin), '%Y-%m-%d %H:%i:%s') AS ultimo_fin
    FROM productividad_sesiones ps
    INNER JOIN surtidores su ON su.id = ps.surtidor_id
    INNER JOIN usuarios u ON u.id = ps.usuario_id
    INNER JOIN sucursales s ON s.id = ps.sucursal_id
    WHERE ${where.join(' AND ')}
    GROUP BY ps.fecha_operativa, ps.surtidor_id, u.nombre, su.codigo, ps.sucursal_id, s.nombre
    ORDER BY s.nombre ASC, u.nombre ASC
    `,
    params
  );

  const exportRows = rows.map((row) => {
    const metricas = calcularMetricas(row);

    return {
      Fecha: row.fecha,
      Surtidor: row.surtidor_nombre,
      Código: row.surtidor_codigo || '',
      'Sucursal surtida': row.sucursal_nombre,
      'Sesiones finalizadas': Number(row.sesiones_finalizadas || 0),
      'Surtido total': Number(row.surtido_total || 0),
      'Partidas surtidas': Number(row.partidas_surtidas || 0),
      Ceros: Number(row.ceros || 0),
      Negados: Number(row.negados || 0),
      'Duración real minutos': metricas.duracion_minutos,
      'Duración real horas': metricas.duracion_horas,
      'Tiempo laboral minutos': metricas.duracion_laboral_minutos,
      'Tiempo laboral horas': metricas.duracion_laboral_horas,
      'Surtido/h laboral': metricas.surtido_por_hora_laboral,
      'Partidas/h laboral': metricas.partidas_por_hora_laboral,
      'Surtido/h real': metricas.surtido_por_hora_real,
      'Partidas/h real': metricas.partidas_por_hora_real,
      'Minutos por surtido': metricas.minutos_por_surtido,
      'Minutos por partida': metricas.minutos_por_partida,
      'Primer inicio': formatDateTime(row.primer_inicio),
      'Último fin': formatDateTime(row.ultimo_fin)
    };
  });

  return sendExport(res, {
    formato,
    filename: `concentrado_surtidores_${fecha}`,
    rows: exportRows,
    sheets: [{ name: 'Surtidores', rows: exportRows }]
  });
});

export const exportarConcentradoSucursales = asyncHandler(async (req, res) => {
  const fecha = validarFecha(req.query.fecha);
  const formato = validarFormatoExportacion(req.query.formato);
  const sucursalId = toPositiveIdOptional(req.query.sucursal_id, 'sucursal_id');

  const where = [`ps.fecha_operativa = ?`, `ps.estado = 'FINALIZADO'`];
  const params = [fecha];

  if (sucursalId) {
    where.push('ps.sucursal_id = ?');
    params.push(sucursalId);
  }

  const [rows] = await pool.query(
    `
    SELECT
      DATE_FORMAT(ps.fecha_operativa, '%Y-%m-%d') AS fecha,
      ps.sucursal_id,
      s.nombre AS sucursal_nombre,
      COUNT(*) AS sesiones_finalizadas,
      COUNT(DISTINCT ps.surtidor_id) AS surtidores_con_captura,
      COALESCE(SUM(ps.tickets), 0) AS surtido_total,
      COALESCE(SUM(ps.partidas), 0) AS partidas_surtidas,
      COALESCE(SUM(ps.ceros), 0) AS ceros,
      COALESCE(SUM(ps.no_surtido), 0) AS negados,
      COALESCE(SUM(ps.duracion_segundos), 0) AS duracion_segundos,
      COALESCE(SUM(ps.duracion_laboral_segundos), 0) AS duracion_laboral_segundos,
      DATE_FORMAT(MIN(ps.hora_inicio), '%Y-%m-%d %H:%i:%s') AS primer_inicio,
      DATE_FORMAT(MAX(ps.hora_fin), '%Y-%m-%d %H:%i:%s') AS ultimo_fin
    FROM productividad_sesiones ps
    INNER JOIN sucursales s ON s.id = ps.sucursal_id
    WHERE ${where.join(' AND ')}
    GROUP BY ps.fecha_operativa, ps.sucursal_id, s.nombre
    ORDER BY s.nombre ASC
    `,
    params
  );

  const exportRows = rows.map((row) => {
    const metricas = calcularMetricas(row);

    return {
      Fecha: row.fecha,
      Sucursal: row.sucursal_nombre,
      'Surtidores con captura': Number(row.surtidores_con_captura || 0),
      'Sesiones finalizadas': Number(row.sesiones_finalizadas || 0),
      'Surtido total': Number(row.surtido_total || 0),
      'Partidas surtidas': Number(row.partidas_surtidas || 0),
      Ceros: Number(row.ceros || 0),
      Negados: Number(row.negados || 0),
      'Duración real horas': metricas.duracion_horas,
      'Tiempo laboral horas': metricas.duracion_laboral_horas,
      'Surtido/h laboral': metricas.surtido_por_hora_laboral,
      'Partidas/h laboral': metricas.partidas_por_hora_laboral,
      'Primer inicio': formatDateTime(row.primer_inicio),
      'Último fin': formatDateTime(row.ultimo_fin)
    };
  });

  return sendExport(res, {
    formato,
    filename: `concentrado_sucursales_${fecha}`,
    rows: exportRows,
    sheets: [{ name: 'Sucursales', rows: exportRows }]
  });
});

export const exportarComparativo = asyncHandler(async (req, res) => {
  const fecha = validarFecha(req.query.fecha);
  const formato = validarFormatoExportacion(req.query.formato);
  const sucursalId = toPositiveIdOptional(req.query.sucursal_id, 'sucursal_id');

  const rows = await obtenerComparativoRows({ fecha, sucursalId });

  return sendExport(res, {
    formato,
    filename: `comparativo_productividad_${fecha}`,
    rows,
    sheets: [{ name: 'Comparativo', rows }]
  });
});

export const exportarSesiones = asyncHandler(async (req, res) => {
  const formato = validarFormatoExportacion(req.query.formato);
  const fecha = validarFechaOpcional(req.query.fecha);
  const desde = validarFechaOpcional(req.query.desde, 'desde');
  const hasta = validarFechaOpcional(req.query.hasta, 'hasta');

  if (!fecha && (!desde || !hasta)) {
    return res.status(400).json({ ok: false, message: 'Debes enviar fecha o rango desde/hasta' });
  }

  const sucursalId = toPositiveIdOptional(req.query.sucursal_id, 'sucursal_id');
  const surtidorId = toPositiveIdOptional(req.query.surtidor_id, 'surtidor_id');
  const estado = req.query.estado ? String(req.query.estado).trim().toUpperCase() : null;
  const limit = safeLimit(req.query.limit, 5000, 20000);

  const where = [];
  const params = [];

  if (fecha) {
    where.push('ps.fecha_operativa = ?');
    params.push(fecha);
  } else {
    where.push('ps.fecha_operativa >= ?');
    where.push('ps.fecha_operativa <= ?');
    params.push(desde, hasta);
  }

  if (sucursalId) {
    where.push('ps.sucursal_id = ?');
    params.push(sucursalId);
  }

  if (surtidorId) {
    where.push('ps.surtidor_id = ?');
    params.push(surtidorId);
  }

  if (estado) {
    where.push('ps.estado = ?');
    params.push(estado);
  }

  const [rows] = await pool.query(
    `
    SELECT
      ps.id,
      DATE_FORMAT(ps.fecha_operativa, '%Y-%m-%d') AS fecha_operativa,
      ps.surtidor_id,
      u.nombre AS surtidor_nombre,
      su.codigo AS surtidor_codigo,
      ps.sucursal_id,
      s.nombre AS sucursal_nombre,
      DATE_FORMAT(ps.hora_inicio, '%Y-%m-%d %H:%i:%s') AS hora_inicio,
      DATE_FORMAT(ps.hora_fin, '%Y-%m-%d %H:%i:%s') AS hora_fin,
      ps.duracion_segundos,
      ps.duracion_laboral_segundos,
      ps.tickets AS surtido_total,
      ps.partidas AS partidas_surtidas,
      ps.ceros,
      ps.no_surtido AS negados,
      ps.estado,
      ps.observaciones,
      ps.cancelado_motivo,
      DATE_FORMAT(ps.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
      DATE_FORMAT(ps.updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at
    FROM productividad_sesiones ps
    INNER JOIN surtidores su ON su.id = ps.surtidor_id
    INNER JOIN usuarios u ON u.id = ps.usuario_id
    INNER JOIN sucursales s ON s.id = ps.sucursal_id
    WHERE ${where.join(' AND ')}
    ORDER BY ps.fecha_operativa DESC, ps.hora_inicio DESC
    LIMIT ${limit}
    `,
    params
  );

  const exportRows = rows.map((row) => {
    const metricas = calcularMetricas(row);

    return {
      ID: row.id,
      Fecha: row.fecha_operativa,
      Surtidor: row.surtidor_nombre,
      Código: row.surtidor_codigo || '',
      'Sucursal surtida': row.sucursal_nombre,
      'Hora inicio': row.hora_inicio,
      'Hora fin': row.hora_fin || '',
      'Duración real minutos': metricas.duracion_minutos,
      'Duración real horas': metricas.duracion_horas,
      'Tiempo laboral minutos': metricas.duracion_laboral_minutos,
      'Tiempo laboral horas': metricas.duracion_laboral_horas,
      'Surtido total': Number(row.surtido_total || 0),
      'Partidas surtidas': Number(row.partidas_surtidas || 0),
      Ceros: Number(row.ceros || 0),
      Negados: Number(row.negados || 0),
      'Surtido/h laboral': metricas.surtido_por_hora_laboral,
      'Partidas/h laboral': metricas.partidas_por_hora_laboral,
      Estado: row.estado,
      Observaciones: row.observaciones || '',
      'Motivo cancelación': row.cancelado_motivo || '',
      'Creado en': row.created_at,
      'Actualizado en': row.updated_at
    };
  });

  const suffix = fecha || `${desde}_a_${hasta}`;

  return sendExport(res, {
    formato,
    filename: `sesiones_productividad_${suffix}`,
    rows: exportRows,
    sheets: [{ name: 'Sesiones', rows: exportRows }]
  });
});

export const exportarReporteGrupal = asyncHandler(async (req, res) => {
  const formato = validarFormatoExportacion(req.query.formato);
  const { fecha, desde, hasta } = obtenerRango(req.query);
  const sucursalId = toPositiveIdOptional(req.query.sucursal_id, 'sucursal_id');
  const limit = safeLimit(req.query.limit, 10000, 30000);

  const where = ['rg.fecha BETWEEN ? AND ?'];
  const params = [desde, hasta];

  if (sucursalId) {
    where.push('rg.sucursal_id = ?');
    params.push(sucursalId);
  }

  params.push(limit);

  const [rows] = await pool.query(
    `
    SELECT
      DATE_FORMAT(rg.fecha, '%Y-%m-%d') AS fecha,
      s.nombre AS sucursal,
      rg.surtido,
      rg.partidas,
      rg.ceros,
      rg.no_surtido,
      rg.porcentaje_surtido,
      rg.fuente,
      rg.estado,
      DATE_FORMAT(rg.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
      DATE_FORMAT(rg.updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at
    FROM reporte_grupal_surtido rg
    INNER JOIN sucursales s ON s.id = rg.sucursal_id
    WHERE ${where.join(' AND ')}
    ORDER BY rg.fecha ASC, s.nombre ASC
    LIMIT ?
    `,
    params
  );

  const exportRows = rows.map((row) => ({
    Fecha: row.fecha,
    Sucursal: row.sucursal,
    'Surtido total': Number(row.surtido || 0),
    'Partidas surtidas': Number(row.partidas || 0),
    Ceros: Number(row.ceros || 0),
    Negados: Number(row.no_surtido || 0),
    '% surtido': row.porcentaje_surtido ?? '',
    Fuente: row.fuente,
    Estado: row.estado,
    'Creado en': row.created_at,
    'Actualizado en': row.updated_at
  }));

  const suffix = fecha || `${desde}_a_${hasta}`;

  return sendExport(res, {
    formato,
    filename: `reporte_grupal_${suffix}`,
    rows: exportRows,
    sheets: [{ name: 'Reporte grupal', rows: exportRows }]
  });
});

export const exportarMetricasJornada = asyncHandler(async (req, res) => {
  const fecha = validarFecha(req.query.fecha);
  const formato = validarFormatoExportacion(req.query.formato);
  const sucursalId = toPositiveIdOptional(req.query.sucursal_id, 'sucursal_id');

  const jornada = getJornadaLaboral(fecha);
  const nowMexico = getNowMexicoDateTime();
  const jornadaTranscurridaSegundos = getJornadaTranscurridaSegundos(fecha, nowMexico);

  const where = ['ps.fecha_operativa = ?'];
  const params = [fecha];

  if (sucursalId) {
    where.push('ps.sucursal_id = ?');
    params.push(sucursalId);
  }

  const [sesionesRows] = await pool.query(
    `
    SELECT
      COUNT(CASE WHEN ps.estado = 'FINALIZADO' THEN 1 END) AS sesiones_finalizadas,
      COUNT(CASE WHEN ps.estado = 'EN_PROCESO' THEN 1 END) AS sesiones_en_proceso,
      COUNT(DISTINCT ps.surtidor_id) AS surtidores_activos,
      COALESCE(SUM(CASE WHEN ps.estado = 'FINALIZADO' THEN ps.tickets ELSE 0 END), 0) AS surtido_total,
      COALESCE(SUM(CASE WHEN ps.estado = 'FINALIZADO' THEN ps.partidas ELSE 0 END), 0) AS partidas_surtidas,
      COALESCE(SUM(CASE WHEN ps.estado = 'FINALIZADO' THEN ps.ceros ELSE 0 END), 0) AS ceros,
      COALESCE(SUM(CASE WHEN ps.estado = 'FINALIZADO' THEN ps.no_surtido ELSE 0 END), 0) AS negados,
      COALESCE(SUM(CASE WHEN ps.estado = 'FINALIZADO' THEN ps.duracion_segundos ELSE 0 END), 0) AS duracion_segundos,
      COALESCE(SUM(CASE WHEN ps.estado = 'FINALIZADO' THEN ps.duracion_laboral_segundos ELSE 0 END), 0) AS duracion_laboral_segundos
    FROM productividad_sesiones ps
    WHERE ${where.join(' AND ')}
    `,
    params
  );

  const resumenBase = sesionesRows[0] || {};
  const surtidoresActivos = Number(resumenBase.surtidores_activos || 0);
  const jornadaDisponibleEquipoSegundos = jornadaTranscurridaSegundos * surtidoresActivos;
  const tiempoActivoLaboral = Number(resumenBase.duracion_laboral_segundos || 0);
  const tiempoMuerto = Math.max(0, jornadaDisponibleEquipoSegundos - tiempoActivoLaboral);

  const [reporteRows] = await pool.query(
    `
    SELECT
      COALESCE(SUM(rg.surtido), 0) AS surtido_total,
      COALESCE(SUM(rg.partidas), 0) AS partidas_surtidas,
      COALESCE(SUM(rg.ceros), 0) AS ceros,
      COALESCE(SUM(rg.no_surtido), 0) AS negados
    FROM reporte_grupal_surtido rg
    WHERE rg.fecha = ?
      ${sucursalId ? 'AND rg.sucursal_id = ?' : ''}
    `,
    sucursalId ? [fecha, sucursalId] : [fecha]
  );

  const reporte = reporteRows[0] || {};

  const resumen = [{
    Fecha: fecha,
    'Hora corte México': nowMexico,
    'Jornada laboral': jornada.es_laboral ? 'SÍ' : 'NO',
    'Inicio jornada': jornada.inicio || '',
    'Fin jornada': jornada.fin || '',
    'Comida inicio': jornada.comida_inicio || '',
    'Comida fin': jornada.comida_fin || '',
    'Horas jornada neta': Number(jornada.horas_netas || 0),
    'Horas transcurridas': segundosAHoras(jornadaTranscurridaSegundos),
    'Surtidores activos': surtidoresActivos,
    'Horas disponibles equipo': segundosAHoras(jornadaDisponibleEquipoSegundos),
    'Tiempo activo laboral horas': segundosAHoras(tiempoActivoLaboral),
    'Tiempo muerto laboral horas': segundosAHoras(tiempoMuerto),
    'Aprovechamiento turno %': safePct(tiempoActivoLaboral, jornadaDisponibleEquipoSegundos),
    'Sesiones finalizadas': Number(resumenBase.sesiones_finalizadas || 0),
    'Sesiones en proceso': Number(resumenBase.sesiones_en_proceso || 0),
    'Surtido total app': Number(resumenBase.surtido_total || 0),
    'Partidas surtidas app': Number(resumenBase.partidas_surtidas || 0),
    'Ceros app': Number(resumenBase.ceros || 0),
    'Negados app': Number(resumenBase.negados || 0),
    'Partidas/h laboral equipo': safeDivide(resumenBase.partidas_surtidas, jornadaDisponibleEquipoSegundos / 3600),
    'Partidas/h activa equipo': safeDivide(resumenBase.partidas_surtidas, tiempoActivoLaboral / 3600),
    'Surtido total reporte grupal': Number(reporte.surtido_total || 0),
    'Partidas reporte grupal': Number(reporte.partidas_surtidas || 0),
    'Promedio esperado partidas por surtidor': surtidoresActivos ? round2(Number(reporte.partidas_surtidas || 0) / surtidoresActivos) : 0
  }];

  const [rankingRows] = await pool.query(
    `
    SELECT
      u.nombre AS surtidor,
      su.codigo,
      COUNT(CASE WHEN ps.estado = 'FINALIZADO' THEN 1 END) AS sesiones_finalizadas,
      COALESCE(SUM(CASE WHEN ps.estado = 'FINALIZADO' THEN ps.tickets ELSE 0 END), 0) AS surtido_total,
      COALESCE(SUM(CASE WHEN ps.estado = 'FINALIZADO' THEN ps.partidas ELSE 0 END), 0) AS partidas_surtidas,
      COALESCE(SUM(CASE WHEN ps.estado = 'FINALIZADO' THEN ps.ceros ELSE 0 END), 0) AS ceros,
      COALESCE(SUM(CASE WHEN ps.estado = 'FINALIZADO' THEN ps.no_surtido ELSE 0 END), 0) AS negados,
      COALESCE(SUM(CASE WHEN ps.estado = 'FINALIZADO' THEN ps.duracion_laboral_segundos ELSE 0 END), 0) AS duracion_laboral_segundos
    FROM productividad_sesiones ps
    INNER JOIN surtidores su ON su.id = ps.surtidor_id
    INNER JOIN usuarios u ON u.id = ps.usuario_id
    WHERE ${where.join(' AND ')}
    GROUP BY ps.surtidor_id, u.nombre, su.codigo
    ORDER BY partidas_surtidas DESC, surtido_total DESC
    `,
    params
  );

  const promedioEsperadoPartidas = surtidoresActivos
    ? Number(reporte.partidas_surtidas || 0) / surtidoresActivos
    : 0;

  const ranking = rankingRows.map((row, index) => ({
    Posición: index + 1,
    Surtidor: row.surtidor,
    Código: row.codigo || '',
    'Sesiones finalizadas': Number(row.sesiones_finalizadas || 0),
    'Surtido total': Number(row.surtido_total || 0),
    'Partidas surtidas': Number(row.partidas_surtidas || 0),
    Ceros: Number(row.ceros || 0),
    Negados: Number(row.negados || 0),
    'Tiempo laboral horas': segundosAHoras(row.duracion_laboral_segundos),
    'Partidas/h activa': safeDivide(row.partidas_surtidas, Number(row.duracion_laboral_segundos || 0) / 3600),
    'Promedio esperado partidas': round2(promedioEsperadoPartidas),
    'Diferencia vs esperado': round2(Number(row.partidas_surtidas || 0) - promedioEsperadoPartidas),
    'Cumplimiento vs esperado %': safePct(row.partidas_surtidas, promedioEsperadoPartidas)
  }));

  const [horasRows] = await pool.query(
    `
    SELECT
      DATE_FORMAT(ps.hora_fin, '%H:00') AS hora,
      COUNT(*) AS sesiones,
      COALESCE(SUM(ps.tickets), 0) AS surtido_total,
      COALESCE(SUM(ps.partidas), 0) AS partidas_surtidas,
      COALESCE(SUM(ps.ceros), 0) AS ceros,
      COALESCE(SUM(ps.no_surtido), 0) AS negados,
      COALESCE(SUM(ps.duracion_laboral_segundos), 0) AS duracion_laboral_segundos
    FROM productividad_sesiones ps
    WHERE ${where.join(' AND ')}
      AND ps.estado = 'FINALIZADO'
      AND ps.hora_fin IS NOT NULL
    GROUP BY DATE_FORMAT(ps.hora_fin, '%H:00')
    ORDER BY hora ASC
    `,
    params
  );

  const porHora = horasRows.map((row) => ({
    Hora: row.hora || 'SIN HORA',
    Sesiones: Number(row.sesiones || 0),
    'Surtido total': Number(row.surtido_total || 0),
    'Partidas surtidas': Number(row.partidas_surtidas || 0),
    Ceros: Number(row.ceros || 0),
    Negados: Number(row.negados || 0),
    'Tiempo laboral minutos': segundosAMinutos(row.duracion_laboral_segundos),
    'Partidas/h activa': safeDivide(row.partidas_surtidas, Number(row.duracion_laboral_segundos || 0) / 3600)
  }));

  if (formato === 'csv') {
    return sendExport(res, {
      formato,
      filename: `metricas_jornada_${fecha}`,
      rows: resumen
    });
  }

  return sendXlsx(res, [
    { name: 'Resumen jornada', rows: resumen },
    { name: 'Ranking surtidores', rows: ranking },
    { name: 'Por hora', rows: porHora }
  ], `metricas_jornada_${fecha}`);
});

export const exportarChecadores = asyncHandler(async (req, res) => {
  const formato = validarFormatoExportacion(req.query.formato);
  const { fecha, desde, hasta } = obtenerRango(req.query);
  const checadorId = toPositiveIdOptional(req.query.checador_id, 'checador_id');
  const limit = safeLimit(req.query.limit, 10000, 50000);

  const where = [
    'cr.fecha BETWEEN ? AND ?',
    'c.usuario_id IS NOT NULL',
    'c.activo = 1',
    'u.activo = 1'
  ];
  const params = [desde, hasta];

  if (checadorId) {
    where.push('cr.checador_id = ?');
    params.push(checadorId);
  }

  const whereSql = where.join(' AND ');

  const [rankingRows] = await pool.query(
    `
    SELECT
      c.id AS checador_id,
      c.codigo_reporte,
      COALESCE(u.nombre, c.nombre_reporte, cr.checador_nombre_reporte) AS checador_nombre,
      COUNT(*) AS salidas,
      COALESCE(SUM(cr.tp), 0) AS tp,
      COALESCE(SUM(cr.total), 0) AS total_importe,
      COUNT(DISTINCT cr.fecha) AS dias_con_reporte,
      GROUP_CONCAT(DISTINCT DATE_FORMAT(cr.fecha, '%Y-%m-%d') ORDER BY cr.fecha SEPARATOR ',') AS fechas
    FROM checadores_reportes cr
    INNER JOIN checadores c ON c.id = cr.checador_id
    INNER JOIN usuarios u ON u.id = c.usuario_id
    WHERE ${whereSql}
    GROUP BY c.id, c.codigo_reporte, checador_nombre
    ORDER BY tp DESC, salidas DESC
    `,
    params
  );

  const totalTpEquipo = rankingRows.reduce((acc, row) => acc + Number(row.tp || 0), 0);
  const totalSalidasEquipo = rankingRows.reduce((acc, row) => acc + Number(row.salidas || 0), 0);

  const ranking = rankingRows.map((row, index) => {
    const fechas = parseFechaList(row.fechas);
    const horasLaborales = sumHorasJornada(fechas);
    const tp = Number(row.tp || 0);
    const salidas = Number(row.salidas || 0);

    return {
      Posición: index + 1,
      Checador: row.checador_nombre,
      Código: row.codigo_reporte,
      Salidas: salidas,
      TP: tp,
      Total: round2(row.total_importe),
      'Días con reporte': Number(row.dias_con_reporte || 0),
      'Horas laborales': round2(horasLaborales),
      'TP/h laboral': horasLaborales ? round2(tp / horasLaborales) : 0,
      'Salidas/h laboral': horasLaborales ? round2(salidas / horasLaborales) : 0,
      'Participación TP %': safePct(tp, totalTpEquipo),
      'Participación salidas %': safePct(salidas, totalSalidasEquipo)
    };
  });

  const [porFechaRows] = await pool.query(
    `
    SELECT
      DATE_FORMAT(cr.fecha, '%Y-%m-%d') AS fecha,
      COUNT(*) AS salidas,
      COALESCE(SUM(cr.tp), 0) AS tp,
      COALESCE(SUM(cr.total), 0) AS total_importe,
      COUNT(DISTINCT cr.checador_id) AS checadores_activos
    FROM checadores_reportes cr
    INNER JOIN checadores c ON c.id = cr.checador_id
    INNER JOIN usuarios u ON u.id = c.usuario_id
    WHERE ${whereSql}
    GROUP BY cr.fecha
    ORDER BY cr.fecha ASC
    `,
    params
  );

  const porFecha = porFechaRows.map((row) => {
    const jornada = getJornadaLaboral(row.fecha);
    const horasEquipo = Number(jornada.horas_netas || 0) * Number(row.checadores_activos || 0);

    return {
      Fecha: row.fecha,
      'Checadores activos': Number(row.checadores_activos || 0),
      Salidas: Number(row.salidas || 0),
      TP: Number(row.tp || 0),
      Total: round2(row.total_importe),
      'Horas equipo': round2(horasEquipo),
      'TP/h equipo': horasEquipo ? round2(Number(row.tp || 0) / horasEquipo) : 0,
      'Salidas/h equipo': horasEquipo ? round2(Number(row.salidas || 0) / horasEquipo) : 0
    };
  });

  const detalleParams = [...params, limit];
  const [detalleRows] = await pool.query(
    `
    SELECT
      DATE_FORMAT(cr.fecha, '%Y-%m-%d') AS fecha,
      COALESCE(u.nombre, c.nombre_reporte, cr.checador_nombre_reporte) AS checador_nombre,
      c.codigo_reporte,
      cr.num_salida,
      cr.est,
      cr.num_requisicion,
      cr.observaciones,
      cr.tp,
      cr.total,
      cr.archivo_nombre,
      DATE_FORMAT(cr.created_at, '%Y-%m-%d %H:%i:%s') AS created_at
    FROM checadores_reportes cr
    INNER JOIN checadores c ON c.id = cr.checador_id
    INNER JOIN usuarios u ON u.id = c.usuario_id
    WHERE ${whereSql}
    ORDER BY cr.fecha DESC, cr.id DESC
    LIMIT ?
    `,
    detalleParams
  );

  const detalle = detalleRows.map((row) => ({
    Fecha: row.fecha,
    Checador: row.checador_nombre,
    Código: row.codigo_reporte,
    'Núm salida': row.num_salida,
    Est: row.est || '',
    'Núm requisición': row.num_requisicion || '',
    Observaciones: row.observaciones || '',
    TP: Number(row.tp || 0),
    Total: round2(row.total),
    Archivo: row.archivo_nombre || '',
    'Importado en': row.created_at
  }));

  const resumen = [{
    Desde: desde,
    Hasta: hasta,
    'Checadores activos': ranking.length,
    Salidas: totalSalidasEquipo,
    TP: totalTpEquipo,
    Total: round2(rankingRows.reduce((acc, row) => acc + Number(row.total_importe || 0), 0)),
    'TP/h laboral equipo': safeDivide(totalTpEquipo, ranking.reduce((acc, row) => acc + Number(row['Horas laborales'] || 0), 0)),
    'Salidas/h laboral equipo': safeDivide(totalSalidasEquipo, ranking.reduce((acc, row) => acc + Number(row['Horas laborales'] || 0), 0))
  }];

  const suffix = fecha || `${desde}_a_${hasta}`;

  if (formato === 'csv') {
    return sendExport(res, {
      formato,
      filename: `checadores_${suffix}`,
      rows: detalle
    });
  }

  return sendXlsx(res, [
    { name: 'Resumen', rows: resumen },
    { name: 'Ranking', rows: ranking },
    { name: 'Por fecha', rows: porFecha },
    { name: 'Detalle', rows: detalle }
  ], `checadores_${suffix}`);
});

export const exportarDashboardDia = asyncHandler(async (req, res) => {
  const fecha = validarFecha(req.query.fecha);
  const formato = validarFormatoExportacion(req.query.formato);
  const sucursalId = toPositiveIdOptional(req.query.sucursal_id, 'sucursal_id');

  const paramsResumen = [fecha];
  const whereResumen = ['fecha_operativa = ?'];

  if (sucursalId) {
    whereResumen.push('sucursal_id = ?');
    paramsResumen.push(sucursalId);
  }

  const [resumenRows] = await pool.query(
    `
    SELECT
      COUNT(CASE WHEN estado = 'FINALIZADO' THEN 1 END) AS sesiones_finalizadas,
      COUNT(CASE WHEN estado = 'EN_PROCESO' THEN 1 END) AS sesiones_en_proceso,
      COUNT(CASE WHEN estado = 'CANCELADO' THEN 1 END) AS sesiones_canceladas,
      COUNT(DISTINCT CASE WHEN estado = 'FINALIZADO' THEN surtidor_id END) AS surtidores_con_captura,
      COUNT(DISTINCT CASE WHEN estado = 'EN_PROCESO' THEN surtidor_id END) AS surtidores_en_proceso,
      COALESCE(SUM(CASE WHEN estado = 'FINALIZADO' THEN tickets ELSE 0 END), 0) AS surtido_total,
      COALESCE(SUM(CASE WHEN estado = 'FINALIZADO' THEN partidas ELSE 0 END), 0) AS partidas_surtidas,
      COALESCE(SUM(CASE WHEN estado = 'FINALIZADO' THEN ceros ELSE 0 END), 0) AS ceros,
      COALESCE(SUM(CASE WHEN estado = 'FINALIZADO' THEN no_surtido ELSE 0 END), 0) AS negados,
      COALESCE(SUM(CASE WHEN estado = 'FINALIZADO' THEN duracion_segundos ELSE 0 END), 0) AS duracion_segundos,
      COALESCE(SUM(CASE WHEN estado = 'FINALIZADO' THEN duracion_laboral_segundos ELSE 0 END), 0) AS duracion_laboral_segundos
    FROM productividad_sesiones
    WHERE ${whereResumen.join(' AND ')}
    `,
    paramsResumen
  );

  const resumenBase = resumenRows[0] || {};
  const metricas = calcularMetricas(resumenBase);

  const resumen = [{
    Fecha: fecha,
    'Sesiones finalizadas': Number(resumenBase.sesiones_finalizadas || 0),
    'Sesiones en proceso': Number(resumenBase.sesiones_en_proceso || 0),
    'Sesiones canceladas': Number(resumenBase.sesiones_canceladas || 0),
    'Surtidores con captura': Number(resumenBase.surtidores_con_captura || 0),
    'Surtidores en proceso': Number(resumenBase.surtidores_en_proceso || 0),
    'Surtido total': Number(resumenBase.surtido_total || 0),
    'Partidas surtidas': Number(resumenBase.partidas_surtidas || 0),
    Ceros: Number(resumenBase.ceros || 0),
    Negados: Number(resumenBase.negados || 0),
    'Duración real horas': metricas.duracion_horas,
    'Tiempo laboral horas': metricas.duracion_laboral_horas,
    'Surtido/h laboral': metricas.surtido_por_hora_laboral,
    'Partidas/h laboral': metricas.partidas_por_hora_laboral
  }];

  const comparativo = await obtenerComparativoRows({ fecha, sucursalId });

  const whereRanking = [`ps.fecha_operativa = ?`, `ps.estado = 'FINALIZADO'`];
  const paramsRanking = [fecha];

  if (sucursalId) {
    whereRanking.push('ps.sucursal_id = ?');
    paramsRanking.push(sucursalId);
  }

  const [rankingRows] = await pool.query(
    `
    SELECT
      u.nombre AS surtidor_nombre,
      su.codigo AS surtidor_codigo,
      COUNT(*) AS sesiones_finalizadas,
      COUNT(DISTINCT ps.sucursal_id) AS sucursales_surtidas,
      COALESCE(SUM(ps.tickets), 0) AS surtido_total,
      COALESCE(SUM(ps.partidas), 0) AS partidas_surtidas,
      COALESCE(SUM(ps.ceros), 0) AS ceros,
      COALESCE(SUM(ps.no_surtido), 0) AS negados,
      COALESCE(SUM(ps.duracion_laboral_segundos), 0) AS duracion_laboral_segundos
    FROM productividad_sesiones ps
    INNER JOIN surtidores su ON su.id = ps.surtidor_id
    INNER JOIN usuarios u ON u.id = ps.usuario_id
    WHERE ${whereRanking.join(' AND ')}
    GROUP BY u.nombre, su.codigo
    ORDER BY SUM(ps.partidas) DESC, u.nombre ASC
    `,
    paramsRanking
  );

  const ranking = rankingRows.map((row, index) => {
    const m = calcularMetricas(row);

    return {
      Posición: index + 1,
      Surtidor: row.surtidor_nombre,
      Código: row.surtidor_codigo || '',
      'Sesiones finalizadas': Number(row.sesiones_finalizadas || 0),
      'Sucursales surtidas': Number(row.sucursales_surtidas || 0),
      'Surtido total': Number(row.surtido_total || 0),
      'Partidas surtidas': Number(row.partidas_surtidas || 0),
      Ceros: Number(row.ceros || 0),
      Negados: Number(row.negados || 0),
      'Tiempo laboral horas': m.duracion_laboral_horas,
      'Surtido/h laboral': m.surtido_por_hora_laboral,
      'Partidas/h laboral': m.partidas_por_hora_laboral,
      'Minutos por surtido': m.minutos_por_surtido,
      'Minutos por partida': m.minutos_por_partida
    };
  });

  if (formato === 'csv') {
    return sendExport(res, {
      formato,
      filename: `dashboard_dia_${fecha}`,
      rows: resumen
    });
  }

  return sendXlsx(res, [
    { name: 'Resumen', rows: resumen },
    { name: 'Comparativo', rows: comparativo },
    { name: 'Ranking surtidores', rows: ranking }
  ], `dashboard_dia_${fecha}`);
});
