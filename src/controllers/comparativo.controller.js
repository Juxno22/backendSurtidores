import { pool } from '../config/db.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { registrarAuditoria } from '../utils/auditoria.js';

function validarFecha(fecha) {
  const value = String(fecha || '').trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const error = new Error('La fecha debe tener formato YYYY-MM-DD');
    error.status = 400;
    throw error;
  }

  return value;
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

function round2(value) {
  const number = Number(value || 0);
  return Number(number.toFixed(2));
}

function calcularEstadoComparativo({ app, reporte }) {
  if (!reporte) {
    return 'SIN_REPORTE';
  }

  const appTieneCaptura =
    Number(app?.tickets || 0) > 0 ||
    Number(app?.partidas || 0) > 0 ||
    Number(app?.ceros || 0) > 0 ||
    Number(app?.no_surtido || 0) > 0;

  if (!appTieneCaptura) {
    return 'SIN_CAPTURA';
  }

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

function construirComparativoItem({ fecha, sucursal, app, reporte }) {
  const appData = app || {
    tickets: 0,
    partidas: 0,
    monto: 0,
    ceros: 0,
    no_surtido: 0,
    duracion_segundos: 0,
    sesiones_finalizadas: 0,
    surtidores_con_captura: 0
  };

  const reporteData = reporte || null;

  const diferenciaTickets = Number(appData.tickets || 0) - Number(reporteData?.surtido || 0);
  const diferenciaPartidas = Number(appData.partidas || 0) - Number(reporteData?.partidas || 0);
  const diferenciaCeros = Number(appData.ceros || 0) - Number(reporteData?.ceros || 0);
  const diferenciaNoSurtido = Number(appData.no_surtido || 0) - Number(reporteData?.no_surtido || 0);

  const duracionHoras = Number(appData.duracion_segundos || 0) / 3600;

  const estadoComparativo = calcularEstadoComparativo({
    app: appData,
    reporte: reporteData
  });

  return {
    fecha,
    sucursal_id: sucursal.id,
    sucursal_nombre: sucursal.nombre,

    app: {
      sesiones_finalizadas: Number(appData.sesiones_finalizadas || 0),
      surtidores_con_captura: Number(appData.surtidores_con_captura || 0),

      tickets: Number(appData.tickets || 0),
      partidas: Number(appData.partidas || 0),
      monto: round2(appData.monto || 0),
      ceros: Number(appData.ceros || 0),
      no_surtido: Number(appData.no_surtido || 0),

      duracion_segundos: Number(appData.duracion_segundos || 0),
      duracion_minutos: round2(Number(appData.duracion_segundos || 0) / 60),
      duracion_horas: round2(duracionHoras),

      tickets_por_hora: duracionHoras > 0
        ? round2(Number(appData.tickets || 0) / duracionHoras)
        : 0,

      partidas_por_hora: duracionHoras > 0
        ? round2(Number(appData.partidas || 0) / duracionHoras)
        : 0,

      monto_por_hora: duracionHoras > 0
        ? round2(Number(appData.monto || 0) / duracionHoras)
        : 0
    },

    reporte: reporteData
      ? {
          id: reporteData.id,
          surtido: Number(reporteData.surtido || 0),
          partidas: Number(reporteData.partidas || 0),
          ceros: Number(reporteData.ceros || 0),
          no_surtido: Number(reporteData.no_surtido || 0),
          porcentaje_surtido: reporteData.porcentaje_surtido,
          fuente: reporteData.fuente,
          estado: reporteData.estado
        }
      : null,

    diferencias: {
      tickets: diferenciaTickets,
      partidas: diferenciaPartidas,
      ceros: diferenciaCeros,
      no_surtido: diferenciaNoSurtido
    },

    estado_comparativo: estadoComparativo
  };
}

async function obtenerDatosComparativo({ fecha, sucursalId = null }) {
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
    GROUP BY
      ps.fecha_operativa,
      ps.sucursal_id,
      s.nombre
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
      rg.fuente,
      rg.estado
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
      fecha,
      sucursal: {
        id: key,
        nombre: row.sucursal_nombre
      },
      app: row,
      reporte: null
    });
  }

  for (const row of reporteRows) {
    const key = Number(row.sucursal_id);

    if (!map.has(key)) {
      map.set(key, {
        fecha,
        sucursal: {
          id: key,
          nombre: row.sucursal_nombre
        },
        app: null,
        reporte: row
      });
    } else {
      map.get(key).reporte = row;
    }
  }

  const items = Array.from(map.values())
    .map(construirComparativoItem)
    .sort((a, b) => a.sucursal_nombre.localeCompare(b.sucursal_nombre));

  const resumen = items.reduce((acc, item) => {
    acc.total_sucursales += 1;

    acc.app.tickets += item.app.tickets;
    acc.app.partidas += item.app.partidas;
    acc.app.monto += item.app.monto;
    acc.app.ceros += item.app.ceros;
    acc.app.no_surtido += item.app.no_surtido;
    acc.app.duracion_segundos += item.app.duracion_segundos;
    acc.app.sesiones_finalizadas += item.app.sesiones_finalizadas;

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
    app: {
      sesiones_finalizadas: 0,
      tickets: 0,
      partidas: 0,
      monto: 0,
      ceros: 0,
      no_surtido: 0,
      duracion_segundos: 0
    },
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

  const duracionHoras = resumen.app.duracion_segundos / 3600;

  resumen.app.monto = round2(resumen.app.monto);
  resumen.app.duracion_minutos = round2(resumen.app.duracion_segundos / 60);
  resumen.app.duracion_horas = round2(duracionHoras);
  resumen.app.tickets_por_hora = duracionHoras > 0
    ? round2(resumen.app.tickets / duracionHoras)
    : 0;
  resumen.app.partidas_por_hora = duracionHoras > 0
    ? round2(resumen.app.partidas / duracionHoras)
    : 0;
  resumen.app.monto_por_hora = duracionHoras > 0
    ? round2(resumen.app.monto / duracionHoras)
    : 0;

  return {
    fecha,
    sucursal_id: sucursalId,
    resumen,
    comparativo: items
  };
}

export const obtenerComparativo = asyncHandler(async (req, res) => {
  const fecha = validarFecha(req.query.fecha);
  const sucursalId = toPositiveIdOptional(req.query.sucursal_id, 'sucursal_id');

  const data = await obtenerDatosComparativo({
    fecha,
    sucursalId
  });

  res.json({
    ok: true,
    ...data
  });
});

export const generarComparativo = asyncHandler(async (req, res) => {
  const fecha = validarFecha(req.body.fecha || req.query.fecha);
  const sucursalId = toPositiveIdOptional(
    req.body.sucursal_id || req.query.sucursal_id,
    'sucursal_id'
  );

  const connection = await pool.getConnection();

  try {
    const data = await obtenerDatosComparativo({
      fecha,
      sucursalId
    });

    await connection.beginTransaction();

    for (const item of data.comparativo) {
      if (!item.reporte?.id) continue;

      const nuevoEstado = item.estado_comparativo === 'CUADRADO'
        ? 'COMPARADO'
        : 'CON_DIFERENCIAS';

      await connection.query(
        `
        UPDATE reporte_grupal_surtido
        SET estado = ?
        WHERE id = ?
        `,
        [nuevoEstado, item.reporte.id]
      );
    }

    await registrarAuditoria(connection, {
      req,
      modulo: 'PRODUCTIVIDAD',
      accion: 'GENERAR_COMPARATIVO_DIARIO',
      entidad: 'comparativo_productividad',
      entidadId: fecha,
      datosDespues: {
        fecha,
        sucursal_id: sucursalId,
        resumen: data.resumen
      }
    });

    await connection.commit();

    const dataActualizada = await obtenerDatosComparativo({
      fecha,
      sucursalId
    });

    res.json({
      ok: true,
      message: 'Comparativo generado correctamente',
      ...dataActualizada
    });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
});