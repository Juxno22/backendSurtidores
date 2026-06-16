import { pool } from '../config/db.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { diffSecondsLocal, getNowMexicoDateTime } from '../utils/mexicoTime.js';

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

function safeLimit(value, defaultValue = 20, maxValue = 200) {
  const limit = Number(value || defaultValue);
  return Math.min(Math.max(Number.isFinite(limit) ? limit : defaultValue, 1), maxValue);
}

function round2(value) {
  const number = Number(value || 0);
  return Number(number.toFixed(2));
}

function calcularMetricas(base) {
  const duracionSegundos = Number(base?.duracion_segundos || 0);
  const duracionLaboralSegundos = Number(base?.duracion_laboral_segundos || 0);

  const partidas = Number(base?.partidas || base?.partidas_surtidas || 0);
  const ceros = Number(base?.ceros || 0);
  const noSurtido = Number(base?.no_surtido || base?.negados || 0);

  const surtidoTotal = partidas + ceros + noSurtido;

  const monto = Number(base?.monto || 0);
  const duracionHoras = duracionSegundos / 3600;
  const duracionLaboralHoras = duracionLaboralSegundos / 3600;

  return {
    ...base,

    tickets: surtidoTotal,
    surtido_total: surtidoTotal,

    partidas,
    partidas_surtidas: partidas,

    monto: round2(monto),
    ceros,
    no_surtido: noSurtido,
    negados: noSurtido,

    duracion_segundos: duracionSegundos,
    duracion_minutos: round2(duracionSegundos / 60),
    duracion_horas: round2(duracionHoras),

    duracion_laboral_segundos: duracionLaboralSegundos,
    duracion_laboral_minutos: round2(duracionLaboralSegundos / 60),
    duracion_laboral_horas: round2(duracionLaboralHoras),

    tickets_por_hora: duracionHoras > 0 ? round2(surtidoTotal / duracionHoras) : 0,
    partidas_por_hora: duracionHoras > 0 ? round2(partidas / duracionHoras) : 0,

    surtido_por_hora_laboral: duracionLaboralHoras > 0 ? round2(surtidoTotal / duracionLaboralHoras) : 0,
    partidas_por_hora_laboral: duracionLaboralHoras > 0 ? round2(partidas / duracionLaboralHoras) : 0,

    monto_por_hora: duracionHoras > 0 ? round2(monto / duracionHoras) : 0,

    minutos_por_surtido: surtidoTotal > 0 ? round2((duracionSegundos / 60) / surtidoTotal) : 0,
    minutos_por_partida: partidas > 0 ? round2((duracionSegundos / 60) / partidas) : 0
  };
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

async function obtenerComparativoPorSucursal({ fecha, sucursalId = null }) {
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
    GROUP BY ps.sucursal_id, s.nombre
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

  return Array.from(map.values()).map((item) => {
    const app = calcularMetricas(item.app || {
      sesiones_finalizadas: 0,
      surtidores_con_captura: 0,
      tickets: 0,
      partidas: 0,
      monto: 0,
      ceros: 0,
      no_surtido: 0,
      duracion_segundos: 0
    });

    const reporte = item.reporte;

    const diferencias = {
      tickets: app.tickets - Number(reporte?.surtido || 0),
      partidas: app.partidas - Number(reporte?.partidas || 0),
      ceros: app.ceros - Number(reporte?.ceros || 0),
      no_surtido: app.no_surtido - Number(reporte?.no_surtido || 0)
    };

    return {
      sucursal_id: item.sucursal_id,
      sucursal_nombre: item.sucursal_nombre,

      app: {
        sesiones_finalizadas: Number(app.sesiones_finalizadas || 0),
        surtidores_con_captura: Number(app.surtidores_con_captura || 0),
        tickets: app.tickets,
        partidas: app.partidas,
        monto: app.monto,
        ceros: app.ceros,
        no_surtido: app.no_surtido,
        duracion_segundos: app.duracion_segundos,
        duracion_minutos: app.duracion_minutos,
        duracion_horas: app.duracion_horas,
        tickets_por_hora: app.tickets_por_hora,
        partidas_por_hora: app.partidas_por_hora,
        monto_por_hora: app.monto_por_hora
      },

      reporte: reporte
        ? {
            id: reporte.id,
            surtido: Number(reporte.surtido || 0),
            partidas: Number(reporte.partidas || 0),
            ceros: Number(reporte.ceros || 0),
            no_surtido: Number(reporte.no_surtido || 0),
            porcentaje_surtido: reporte.porcentaje_surtido,
            estado: reporte.estado,
            fuente: reporte.fuente
          }
        : null,

      diferencias,
      estado_comparativo: estadoComparativo(app, reporte)
    };
  }).sort((a, b) => a.sucursal_nombre.localeCompare(b.sucursal_nombre));
}

export const resumenDia = asyncHandler(async (req, res) => {
  const fecha = validarFecha(req.query.fecha);
  const sucursalId = toPositiveIdOptional(req.query.sucursal_id, 'sucursal_id');

  const params = [fecha];
  const where = [`fecha_operativa = ?`];

  if (sucursalId) {
    where.push('sucursal_id = ?');
    params.push(sucursalId);
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
    WHERE ${where.join(' AND ')}
    `,
    params
  );

  const resumenApp = calcularMetricas(resumenRows[0] || {});

  const comparativo = await obtenerComparativoPorSucursal({ fecha, sucursalId });

  const resumenComparativo = comparativo.reduce((acc, item) => {
    acc.total_sucursales += 1;

    if (item.reporte) {
      acc.reporte.surtido += item.reporte.surtido;
      acc.reporte.partidas += item.reporte.partidas;
      acc.reporte.ceros += item.reporte.ceros;
      acc.reporte.no_surtido += item.reporte.no_surtido;
    }

    acc.diferencias.tickets += item.diferencias.tickets;
    acc.diferencias.partidas += item.diferencias.partidas;
    acc.diferencias.ceros += item.diferencias.ceros;
    acc.diferencias.no_surtido += item.diferencias.no_surtido;

    acc.estados[item.estado_comparativo] =
      (acc.estados[item.estado_comparativo] || 0) + 1;

    return acc;
  }, {
    total_sucursales: 0,
    reporte: {
      surtido: 0,
      partidas: 0,
      ceros: 0,
      no_surtido: 0
    },
    diferencias: {
      tickets: 0,
      partidas: 0,
      ceros: 0,
      no_surtido: 0
    },
    estados: {
      CUADRADO: 0,
      CON_DIFERENCIAS: 0,
      SIN_REPORTE: 0,
      SIN_CAPTURA: 0
    }
  });

  res.json({
    ok: true,
    fecha,
    filtros: {
      sucursal_id: sucursalId
    },
    kpis: {
      sesiones_finalizadas: Number(resumenApp.sesiones_finalizadas || 0),
      sesiones_en_proceso: Number(resumenApp.sesiones_en_proceso || 0),
      sesiones_canceladas: Number(resumenApp.sesiones_canceladas || 0),

      surtidores_con_captura: Number(resumenApp.surtidores_con_captura || 0),
      surtidores_en_proceso: Number(resumenApp.surtidores_en_proceso || 0),

      tickets: resumenApp.tickets,
      partidas: resumenApp.partidas,
      monto: resumenApp.monto,
      ceros: resumenApp.ceros,
      no_surtido: resumenApp.no_surtido,

      duracion_segundos: resumenApp.duracion_segundos,
      duracion_minutos: resumenApp.duracion_minutos,
      duracion_horas: resumenApp.duracion_horas,

      tickets_por_hora: resumenApp.tickets_por_hora,
      partidas_por_hora: resumenApp.partidas_por_hora,
      monto_por_hora: resumenApp.monto_por_hora
    },
    comparativo: resumenComparativo
  });
});

export const surtidoresRanking = asyncHandler(async (req, res) => {
  const fecha = validarFecha(req.query.fecha);
  const sucursalId = toPositiveIdOptional(req.query.sucursal_id, 'sucursal_id');
  const limit = safeLimit(req.query.limit, 50, 500);

  const orden = String(req.query.orden || 'partidas_por_hora').trim();

  const orderMap = {
    partidas_por_hora: 'partidas_por_hora',
    tickets_por_hora: 'tickets_por_hora',
    monto_por_hora: 'monto_por_hora',
    partidas: 'partidas',
    tickets: 'tickets',
    monto: 'monto',
    duracion_horas: 'duracion_segundos'
  };

  const orderBy = orderMap[orden] || 'partidas_por_hora';

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
      ps.surtidor_id,
      u.nombre AS surtidor_nombre,
      u.usuario AS surtidor_usuario,
      su.codigo AS surtidor_codigo,

      COUNT(*) AS sesiones_finalizadas,
      COUNT(DISTINCT ps.sucursal_id) AS sucursales_surtidas,

      SUM(ps.tickets) AS tickets,
      SUM(ps.partidas) AS partidas,
      SUM(ps.monto) AS monto,
      SUM(ps.ceros) AS ceros,
      SUM(ps.no_surtido) AS no_surtido,
      SUM(ps.duracion_segundos) AS duracion_segundos,

      CASE
        WHEN SUM(ps.duracion_segundos) > 0
          THEN ROUND(SUM(ps.tickets) / (SUM(ps.duracion_segundos) / 3600), 2)
        ELSE 0
      END AS tickets_por_hora,

      CASE
        WHEN SUM(ps.duracion_segundos) > 0
          THEN ROUND(SUM(ps.partidas) / (SUM(ps.duracion_segundos) / 3600), 2)
        ELSE 0
      END AS partidas_por_hora,

      CASE
        WHEN SUM(ps.duracion_segundos) > 0
          THEN ROUND(SUM(ps.monto) / (SUM(ps.duracion_segundos) / 3600), 2)
        ELSE 0
      END AS monto_por_hora

    FROM productividad_sesiones ps
    INNER JOIN surtidores su ON su.id = ps.surtidor_id
    INNER JOIN usuarios u ON u.id = ps.usuario_id
    WHERE ${where.join(' AND ')}
    GROUP BY
      ps.surtidor_id,
      u.nombre,
      u.usuario,
      su.codigo
    ORDER BY ${orderBy} DESC, u.nombre ASC
    LIMIT ${limit}
    `,
    params
  );

  res.json({
    ok: true,
    fecha,
    filtros: {
      sucursal_id: sucursalId,
      orden,
      limit
    },
    ranking: rows.map((row, index) => ({
      posicion: index + 1,
      ...calcularMetricas(row),
      sesiones_finalizadas: Number(row.sesiones_finalizadas || 0),
      sucursales_surtidas: Number(row.sucursales_surtidas || 0)
    }))
  });
});

export const sucursalesRanking = asyncHandler(async (req, res) => {
  const fecha = validarFecha(req.query.fecha);
  const sucursalId = toPositiveIdOptional(req.query.sucursal_id, 'sucursal_id');

  const orden = String(req.query.orden || 'partidas').trim();

  const orderMap = {
    partidas: (a, b) => b.app.partidas - a.app.partidas,
    tickets: (a, b) => b.app.tickets - a.app.tickets,
    monto: (a, b) => b.app.monto - a.app.monto,
    partidas_por_hora: (a, b) => b.app.partidas_por_hora - a.app.partidas_por_hora,
    diferencias: (a, b) =>
      Math.abs(b.diferencias.partidas) - Math.abs(a.diferencias.partidas)
  };

  const comparativo = await obtenerComparativoPorSucursal({ fecha, sucursalId });
  const sorter = orderMap[orden] || orderMap.partidas;

  res.json({
    ok: true,
    fecha,
    filtros: {
      sucursal_id: sucursalId,
      orden
    },
    ranking: comparativo.sort(sorter).map((item, index) => ({
      posicion: index + 1,
      ...item
    }))
  });
});

export const pendientesDashboard = asyncHandler(async (req, res) => {
  const fecha = validarFecha(req.query.fecha);
  const sucursalId = toPositiveIdOptional(req.query.sucursal_id, 'sucursal_id');

  const where = [
    `ps.fecha_operativa = ?`,
    `ps.estado = 'EN_PROCESO'`
  ];

  const params = [fecha];

  if (sucursalId) {
    where.push('ps.sucursal_id = ?');
    params.push(sucursalId);
  }

  const [sesionesEnProceso] = await pool.query(
    `
    SELECT
      ps.id,
      ps.surtidor_id,
      u.nombre AS surtidor_nombre,
      u.usuario AS surtidor_usuario,
      su.codigo AS surtidor_codigo,

      ps.sucursal_id,
      s.nombre AS sucursal_nombre,

      ps.fecha_operativa,
      ps.hora_inicio,
      TIMESTAMPDIFF(SECOND, ps.hora_inicio, NOW()) AS segundos_transcurridos,
      ROUND(TIMESTAMPDIFF(SECOND, ps.hora_inicio, NOW()) / 60, 2) AS minutos_transcurridos,
      ROUND(TIMESTAMPDIFF(SECOND, ps.hora_inicio, NOW()) / 3600, 2) AS horas_transcurridas,

      ps.tickets,
      ps.partidas,
      ps.monto,
      ps.ceros,
      ps.no_surtido,
      ps.observaciones,

      CASE
        WHEN TIMESTAMPDIFF(SECOND, ps.hora_inicio, NOW()) >= 14400 THEN 1
        ELSE 0
      END AS alerta_mas_4_horas,

      CASE
        WHEN ps.tickets = 0
          AND ps.partidas = 0
          AND ps.monto = 0
          AND ps.ceros = 0
          AND ps.no_surtido = 0 THEN 1
        ELSE 0
      END AS alerta_sin_avance

    FROM productividad_sesiones ps
    INNER JOIN surtidores su ON su.id = ps.surtidor_id
    INNER JOIN usuarios u ON u.id = ps.usuario_id
    INNER JOIN sucursales s ON s.id = ps.sucursal_id
    WHERE ${where.join(' AND ')}
    ORDER BY ps.hora_inicio ASC
    `,
    params
  );

  const comparativo = await obtenerComparativoPorSucursal({ fecha, sucursalId });

  const sinReporte = comparativo.filter((item) => item.estado_comparativo === 'SIN_REPORTE');
  const sinCaptura = comparativo.filter((item) => item.estado_comparativo === 'SIN_CAPTURA');
  const conDiferencias = comparativo.filter((item) => item.estado_comparativo === 'CON_DIFERENCIAS');

  res.json({
    ok: true,
    fecha,
    filtros: {
      sucursal_id: sucursalId
    },
    resumen: {
      sesiones_en_proceso: sesionesEnProceso.length,
      sesiones_mas_4_horas: sesionesEnProceso.filter((s) => Number(s.alerta_mas_4_horas) === 1).length,
      sesiones_sin_avance: sesionesEnProceso.filter((s) => Number(s.alerta_sin_avance) === 1).length,
      sucursales_sin_reporte: sinReporte.length,
      sucursales_sin_captura: sinCaptura.length,
      sucursales_con_diferencias: conDiferencias.length
    },
    sesiones_en_proceso: sesionesEnProceso,
    sucursales_sin_reporte: sinReporte,
    sucursales_sin_captura: sinCaptura,
    sucursales_con_diferencias: conDiferencias
  });
});

export const tendenciaDashboard = asyncHandler(async (req, res) => {
  const desde = validarFecha(req.query.desde, 'desde');
  const hasta = validarFecha(req.query.hasta, 'hasta');
  const sucursalId = toPositiveIdOptional(req.query.sucursal_id, 'sucursal_id');

  const paramsApp = [desde, hasta];
  const whereApp = [
    `ps.fecha_operativa >= ?`,
    `ps.fecha_operativa <= ?`,
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
      COUNT(*) AS sesiones_finalizadas,
      COUNT(DISTINCT ps.surtidor_id) AS surtidores_con_captura,

      SUM(ps.tickets) AS tickets,
      SUM(ps.partidas) AS partidas,
      SUM(ps.monto) AS monto,
      SUM(ps.ceros) AS ceros,
      SUM(ps.no_surtido) AS no_surtido,
      SUM(ps.duracion_segundos) AS duracion_segundos
    FROM productividad_sesiones ps
    WHERE ${whereApp.join(' AND ')}
    GROUP BY ps.fecha_operativa
    ORDER BY ps.fecha_operativa ASC
    `,
    paramsApp
  );

  const paramsReporte = [desde, hasta];
  const whereReporte = [
    `rg.fecha >= ?`,
    `rg.fecha <= ?`
  ];

  if (sucursalId) {
    whereReporte.push('rg.sucursal_id = ?');
    paramsReporte.push(sucursalId);
  }

  const [reporteRows] = await pool.query(
    `
    SELECT
      rg.fecha,
      SUM(rg.surtido) AS surtido,
      SUM(rg.partidas) AS partidas,
      SUM(rg.ceros) AS ceros,
      SUM(rg.no_surtido) AS no_surtido
    FROM reporte_grupal_surtido rg
    WHERE ${whereReporte.join(' AND ')}
    GROUP BY rg.fecha
    ORDER BY rg.fecha ASC
    `,
    paramsReporte
  );

  const map = new Map();

  for (const row of appRows) {
    const fechaKey = String(row.fecha).slice(0, 10);
    map.set(fechaKey, {
      fecha: fechaKey,
      app: row,
      reporte: null
    });
  }

  for (const row of reporteRows) {
    const fechaKey = String(row.fecha).slice(0, 10);

    if (!map.has(fechaKey)) {
      map.set(fechaKey, {
        fecha: fechaKey,
        app: null,
        reporte: row
      });
    } else {
      map.get(fechaKey).reporte = row;
    }
  }

  const tendencia = Array.from(map.values())
    .sort((a, b) => a.fecha.localeCompare(b.fecha))
    .map((item) => {
      const app = calcularMetricas(item.app || {
        sesiones_finalizadas: 0,
        surtidores_con_captura: 0,
        tickets: 0,
        partidas: 0,
        monto: 0,
        ceros: 0,
        no_surtido: 0,
        duracion_segundos: 0
      });

      const reporte = item.reporte || {
        surtido: 0,
        partidas: 0,
        ceros: 0,
        no_surtido: 0
      };

      return {
        fecha: item.fecha,

        app: {
          sesiones_finalizadas: Number(app.sesiones_finalizadas || 0),
          surtidores_con_captura: Number(app.surtidores_con_captura || 0),
          tickets: app.tickets,
          partidas: app.partidas,
          monto: app.monto,
          ceros: app.ceros,
          no_surtido: app.no_surtido,
          duracion_segundos: app.duracion_segundos,
          duracion_minutos: app.duracion_minutos,
          duracion_horas: app.duracion_horas,
          tickets_por_hora: app.tickets_por_hora,
          partidas_por_hora: app.partidas_por_hora,
          monto_por_hora: app.monto_por_hora
        },

        reporte: {
          surtido: Number(reporte.surtido || 0),
          partidas: Number(reporte.partidas || 0),
          ceros: Number(reporte.ceros || 0),
          no_surtido: Number(reporte.no_surtido || 0)
        },

        diferencias: {
          tickets: app.tickets - Number(reporte.surtido || 0),
          partidas: app.partidas - Number(reporte.partidas || 0),
          ceros: app.ceros - Number(reporte.ceros || 0),
          no_surtido: app.no_surtido - Number(reporte.no_surtido || 0)
        }
      };
    });

  res.json({
    ok: true,
    filtros: {
      desde,
      hasta,
      sucursal_id: sucursalId
    },
    tendencia
  });
});