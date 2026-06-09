import { pool } from '../config/db.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  validarFormatoExportacion,
  sendExport,
  sendXlsx,
  formatDate,
  formatDateTime,
  round2,
  calcularMetricas
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

function estadoComparativo(app, reporte) {
  if (!reporte) return 'SIN_REPORTE';

  const tieneCaptura =
    Number(app?.tickets || 0) > 0 ||
    Number(app?.partidas || 0) > 0 ||
    Number(app?.ceros || 0) > 0 ||
    Number(app?.no_surtido || 0) > 0;

  if (!tieneCaptura) return 'SIN_CAPTURA';

  const difTickets = Number(app.tickets || 0) - Number(reporte.surtido || 0);
  const difPartidas = Number(app.partidas || 0) - Number(reporte.partidas || 0);
  const difCeros = Number(app.ceros || 0) - Number(reporte.ceros || 0);
  const difNoSurtido = Number(app.no_surtido || 0) - Number(reporte.no_surtido || 0);

  if (
    difTickets === 0 &&
    difPartidas === 0 &&
    difCeros === 0 &&
    difNoSurtido === 0
  ) {
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
      ps.fecha_operativa AS fecha,
      ps.sucursal_id,
      s.nombre AS sucursal_nombre,

      COUNT(*) AS sesiones_finalizadas,
      COUNT(DISTINCT ps.surtidor_id) AS surtidores_con_captura,

      SUM(ps.tickets) AS tickets,
      SUM(ps.partidas) AS partidas,
      SUM(ps.monto) AS monto,
      SUM(ps.ceros) AS ceros,
      SUM(ps.no_surtido) AS no_surtido,
      SUM(ps.duracion_segundos) AS duracion_segundos
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
      rg.fecha,
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
        tickets: 0,
        partidas: 0,
        monto: 0,
        ceros: 0,
        no_surtido: 0,
        duracion_segundos: 0
      };

      const metricas = calcularMetricas(app);
      const reporte = item.reporte;

      const ticketsApp = Number(app.tickets || 0);
      const partidasApp = Number(app.partidas || 0);
      const cerosApp = Number(app.ceros || 0);
      const noSurtidoApp = Number(app.no_surtido || 0);

      const ticketsReporte = Number(reporte?.surtido || 0);
      const partidasReporte = Number(reporte?.partidas || 0);
      const cerosReporte = Number(reporte?.ceros || 0);
      const noSurtidoReporte = Number(reporte?.no_surtido || 0);

      return {
        Fecha: fecha,
        Sucursal: item.sucursal_nombre,

        'Sesiones finalizadas': Number(app.sesiones_finalizadas || 0),
        'Surtidores con captura': Number(app.surtidores_con_captura || 0),

        'Tickets app': ticketsApp,
        'Tickets reporte': ticketsReporte,
        'Diferencia tickets': ticketsApp - ticketsReporte,

        'Partidas app': partidasApp,
        'Partidas reporte': partidasReporte,
        'Diferencia partidas': partidasApp - partidasReporte,

        'Ceros app': cerosApp,
        'Ceros reporte': cerosReporte,
        'Diferencia ceros': cerosApp - cerosReporte,

        'No surtido / Negados app': noSurtidoApp,
        'No surtido / Negados reporte': noSurtidoReporte,
        'Diferencia no surtido': noSurtidoApp - noSurtidoReporte,

        'Monto app': round2(app.monto),
        'Horas trabajadas': metricas.duracion_horas,
        'Tickets por hora': metricas.tickets_por_hora,
        'Partidas por hora': metricas.partidas_por_hora,
        'Monto por hora': metricas.monto_por_hora,

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

  const where = [
    `ps.fecha_operativa = ?`,
    `ps.estado = 'FINALIZADO'`
  ];

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
      ps.fecha_operativa AS fecha,
      ps.surtidor_id,
      u.nombre AS surtidor_nombre,
      su.codigo AS surtidor_codigo,
      ps.sucursal_id,
      s.nombre AS sucursal_nombre,

      COUNT(*) AS sesiones_finalizadas,
      SUM(ps.tickets) AS tickets,
      SUM(ps.partidas) AS partidas,
      SUM(ps.monto) AS monto,
      SUM(ps.ceros) AS ceros,
      SUM(ps.no_surtido) AS no_surtido,
      SUM(ps.duracion_segundos) AS duracion_segundos,

      MIN(ps.hora_inicio) AS primer_inicio,
      MAX(ps.hora_fin) AS ultimo_fin
    FROM productividad_sesiones ps
    INNER JOIN surtidores su ON su.id = ps.surtidor_id
    INNER JOIN usuarios u ON u.id = ps.usuario_id
    INNER JOIN sucursales s ON s.id = ps.sucursal_id
    WHERE ${where.join(' AND ')}
    GROUP BY
      ps.fecha_operativa,
      ps.surtidor_id,
      u.nombre,
      su.codigo,
      ps.sucursal_id,
      s.nombre
    ORDER BY s.nombre ASC, u.nombre ASC
    `,
    params
  );

  const exportRows = rows.map((row) => {
    const metricas = calcularMetricas(row);

    return {
      Fecha: formatDate(row.fecha),
      Surtidor: row.surtidor_nombre,
      Código: row.surtidor_codigo || '',
      'Sucursal surtida': row.sucursal_nombre,
      'Sesiones finalizadas': Number(row.sesiones_finalizadas || 0),
      Tickets: Number(row.tickets || 0),
      Partidas: Number(row.partidas || 0),
      Monto: round2(row.monto),
      Ceros: Number(row.ceros || 0),
      'No surtido / Negados': Number(row.no_surtido || 0),
      'Duración minutos': metricas.duracion_minutos,
      'Duración horas': metricas.duracion_horas,
      'Tickets por hora': metricas.tickets_por_hora,
      'Partidas por hora': metricas.partidas_por_hora,
      'Monto por hora': metricas.monto_por_hora,
      'Minutos por ticket': metricas.minutos_por_ticket,
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

  const where = [
    `ps.fecha_operativa = ?`,
    `ps.estado = 'FINALIZADO'`
  ];

  const params = [fecha];

  if (sucursalId) {
    where.push('ps.sucursal_id = ?');
    params.push(sucursalId);
  }

  const [rows] = await pool.query(
    `
    SELECT
      ps.fecha_operativa AS fecha,
      ps.sucursal_id,
      s.nombre AS sucursal_nombre,

      COUNT(*) AS sesiones_finalizadas,
      COUNT(DISTINCT ps.surtidor_id) AS surtidores_con_captura,

      SUM(ps.tickets) AS tickets,
      SUM(ps.partidas) AS partidas,
      SUM(ps.monto) AS monto,
      SUM(ps.ceros) AS ceros,
      SUM(ps.no_surtido) AS no_surtido,
      SUM(ps.duracion_segundos) AS duracion_segundos,

      MIN(ps.hora_inicio) AS primer_inicio,
      MAX(ps.hora_fin) AS ultimo_fin
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
      Fecha: formatDate(row.fecha),
      Sucursal: row.sucursal_nombre,
      'Surtidores con captura': Number(row.surtidores_con_captura || 0),
      'Sesiones finalizadas': Number(row.sesiones_finalizadas || 0),
      Tickets: Number(row.tickets || 0),
      Partidas: Number(row.partidas || 0),
      Monto: round2(row.monto),
      Ceros: Number(row.ceros || 0),
      'No surtido / Negados': Number(row.no_surtido || 0),
      'Duración minutos': metricas.duracion_minutos,
      'Duración horas': metricas.duracion_horas,
      'Tickets por hora': metricas.tickets_por_hora,
      'Partidas por hora': metricas.partidas_por_hora,
      'Monto por hora': metricas.monto_por_hora,
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
    return res.status(400).json({
      ok: false,
      message: 'Debes enviar fecha o rango desde/hasta'
    });
  }

  const sucursalId = toPositiveIdOptional(req.query.sucursal_id, 'sucursal_id');
  const surtidorId = toPositiveIdOptional(req.query.surtidor_id, 'surtidor_id');
  const estado = req.query.estado
    ? String(req.query.estado).trim().toUpperCase()
    : null;
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
      ps.fecha_operativa,
      ps.surtidor_id,
      u.nombre AS surtidor_nombre,
      su.codigo AS surtidor_codigo,

      ps.sucursal_id,
      s.nombre AS sucursal_nombre,

      ps.hora_inicio,
      ps.hora_fin,
      ps.duracion_segundos,

      ps.tickets,
      ps.partidas,
      ps.monto,
      ps.ceros,
      ps.no_surtido,
      ps.estado,
      ps.observaciones,
      ps.cancelado_motivo,

      ps.created_at,
      ps.updated_at
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
      Fecha: formatDate(row.fecha_operativa),
      Surtidor: row.surtidor_nombre,
      Código: row.surtidor_codigo || '',
      'Sucursal surtida': row.sucursal_nombre,
      'Hora inicio': formatDateTime(row.hora_inicio),
      'Hora fin': formatDateTime(row.hora_fin),
      'Duración minutos': metricas.duracion_minutos,
      'Duración horas': metricas.duracion_horas,
      Tickets: Number(row.tickets || 0),
      Partidas: Number(row.partidas || 0),
      Monto: round2(row.monto),
      Ceros: Number(row.ceros || 0),
      'No surtido / Negados': Number(row.no_surtido || 0),
      'Tickets por hora': metricas.tickets_por_hora,
      'Partidas por hora': metricas.partidas_por_hora,
      Estado: row.estado,
      Observaciones: row.observaciones || '',
      'Motivo cancelación': row.cancelado_motivo || '',
      'Creado en': formatDateTime(row.created_at),
      'Actualizado en': formatDateTime(row.updated_at)
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

      COALESCE(SUM(CASE WHEN estado = 'FINALIZADO' THEN tickets ELSE 0 END), 0) AS tickets,
      COALESCE(SUM(CASE WHEN estado = 'FINALIZADO' THEN partidas ELSE 0 END), 0) AS partidas,
      COALESCE(SUM(CASE WHEN estado = 'FINALIZADO' THEN monto ELSE 0 END), 0) AS monto,
      COALESCE(SUM(CASE WHEN estado = 'FINALIZADO' THEN ceros ELSE 0 END), 0) AS ceros,
      COALESCE(SUM(CASE WHEN estado = 'FINALIZADO' THEN no_surtido ELSE 0 END), 0) AS no_surtido,
      COALESCE(SUM(CASE WHEN estado = 'FINALIZADO' THEN duracion_segundos ELSE 0 END), 0) AS duracion_segundos
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
    Tickets: Number(resumenBase.tickets || 0),
    Partidas: Number(resumenBase.partidas || 0),
    Monto: round2(resumenBase.monto),
    Ceros: Number(resumenBase.ceros || 0),
    'No surtido / Negados': Number(resumenBase.no_surtido || 0),
    'Duración minutos': metricas.duracion_minutos,
    'Duración horas': metricas.duracion_horas,
    'Tickets por hora': metricas.tickets_por_hora,
    'Partidas por hora': metricas.partidas_por_hora,
    'Monto por hora': metricas.monto_por_hora
  }];

  const comparativo = await obtenerComparativoRows({ fecha, sucursalId });

  const fakeReqSurtidores = {
    query: {
      fecha,
      sucursal_id: sucursalId || ''
    }
  };

  const whereRanking = [
    `ps.fecha_operativa = ?`,
    `ps.estado = 'FINALIZADO'`
  ];
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

      SUM(ps.tickets) AS tickets,
      SUM(ps.partidas) AS partidas,
      SUM(ps.monto) AS monto,
      SUM(ps.ceros) AS ceros,
      SUM(ps.no_surtido) AS no_surtido,
      SUM(ps.duracion_segundos) AS duracion_segundos
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
      Tickets: Number(row.tickets || 0),
      Partidas: Number(row.partidas || 0),
      Monto: round2(row.monto),
      Ceros: Number(row.ceros || 0),
      'No surtido / Negados': Number(row.no_surtido || 0),
      'Duración horas': m.duracion_horas,
      'Tickets por hora': m.tickets_por_hora,
      'Partidas por hora': m.partidas_por_hora,
      'Monto por hora': m.monto_por_hora,
      'Minutos por ticket': m.minutos_por_ticket,
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