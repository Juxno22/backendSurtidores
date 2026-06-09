import { pool } from '../config/db.js';
import { asyncHandler } from '../utils/asyncHandler.js';

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

function calcularMetricas(row) {
  const duracionHoras = Number(row.duracion_segundos || 0) / 3600;
  const tickets = Number(row.tickets || 0);
  const partidas = Number(row.partidas || 0);
  const monto = Number(row.monto || 0);

  return {
    ...row,
    duracion_minutos: round2(Number(row.duracion_segundos || 0) / 60),
    duracion_horas: round2(duracionHoras),

    tickets_por_hora: duracionHoras > 0 ? round2(tickets / duracionHoras) : 0,
    partidas_por_hora: duracionHoras > 0 ? round2(partidas / duracionHoras) : 0,
    monto_por_hora: duracionHoras > 0 ? round2(monto / duracionHoras) : 0,

    minutos_por_ticket: tickets > 0
      ? round2((Number(row.duracion_segundos || 0) / 60) / tickets)
      : 0,

    minutos_por_partida: partidas > 0
      ? round2((Number(row.duracion_segundos || 0) / 60) / partidas)
      : 0
  };
}

export const concentradoPorSurtidores = asyncHandler(async (req, res) => {
  const fecha = validarFecha(req.query.fecha);
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

  if (req.user.rol === 'SURTIDOR') {
    where.push('ps.usuario_id = ?');
    params.push(req.user.id);
  }

  const [rows] = await pool.query(
    `
    SELECT
      ps.fecha_operativa AS fecha,

      ps.surtidor_id,
      u.nombre AS surtidor_nombre,
      u.usuario AS surtidor_usuario,
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
      u.usuario,
      su.codigo,
      ps.sucursal_id,
      s.nombre
    ORDER BY s.nombre ASC, u.nombre ASC
    `,
    params
  );

  const totalGeneral = rows.reduce((acc, row) => {
    acc.tickets += Number(row.tickets || 0);
    acc.partidas += Number(row.partidas || 0);
    acc.monto += Number(row.monto || 0);
    acc.ceros += Number(row.ceros || 0);
    acc.no_surtido += Number(row.no_surtido || 0);
    acc.duracion_segundos += Number(row.duracion_segundos || 0);
    acc.sesiones_finalizadas += Number(row.sesiones_finalizadas || 0);
    return acc;
  }, {
    tickets: 0,
    partidas: 0,
    monto: 0,
    ceros: 0,
    no_surtido: 0,
    duracion_segundos: 0,
    sesiones_finalizadas: 0
  });

  const concentrado = rows.map((row) => {
    const base = calcularMetricas(row);

    return {
      ...base,
      participacion_tickets_pct: totalGeneral.tickets > 0
        ? round2((Number(row.tickets || 0) / totalGeneral.tickets) * 100)
        : 0,
      participacion_partidas_pct: totalGeneral.partidas > 0
        ? round2((Number(row.partidas || 0) / totalGeneral.partidas) * 100)
        : 0,
      participacion_monto_pct: totalGeneral.monto > 0
        ? round2((Number(row.monto || 0) / totalGeneral.monto) * 100)
        : 0
    };
  });

  res.json({
    ok: true,
    fecha,
    filtros: {
      sucursal_id: sucursalId,
      surtidor_id: surtidorId
    },
    total_general: calcularMetricas(totalGeneral),
    concentrado
  });
});

export const concentradoPorSucursales = asyncHandler(async (req, res) => {
  const fecha = validarFecha(req.query.fecha);
  const sucursalId = toPositiveIdOptional(req.query.sucursal_id, 'sucursal_id');

  const whereFinalizadas = [
    `ps.fecha_operativa = ?`,
    `ps.estado = 'FINALIZADO'`
  ];

  const paramsFinalizadas = [fecha];

  const wherePendientes = [
    `ps.fecha_operativa = ?`,
    `ps.estado = 'EN_PROCESO'`
  ];

  const paramsPendientes = [fecha];

  if (sucursalId) {
    whereFinalizadas.push('ps.sucursal_id = ?');
    paramsFinalizadas.push(sucursalId);

    wherePendientes.push('ps.sucursal_id = ?');
    paramsPendientes.push(sucursalId);
  }

  const [finalizadas] = await pool.query(
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
    WHERE ${whereFinalizadas.join(' AND ')}
    GROUP BY
      ps.fecha_operativa,
      ps.sucursal_id,
      s.nombre
    ORDER BY s.nombre ASC
    `,
    paramsFinalizadas
  );

  const [pendientes] = await pool.query(
    `
    SELECT
      ps.sucursal_id,
      COUNT(*) AS sesiones_en_proceso,
      COUNT(DISTINCT ps.surtidor_id) AS surtidores_en_proceso
    FROM productividad_sesiones ps
    WHERE ${wherePendientes.join(' AND ')}
    GROUP BY ps.sucursal_id
    `,
    paramsPendientes
  );

  const pendientesMap = new Map(
    pendientes.map((row) => [
      Number(row.sucursal_id),
      {
        sesiones_en_proceso: Number(row.sesiones_en_proceso || 0),
        surtidores_en_proceso: Number(row.surtidores_en_proceso || 0)
      }
    ])
  );

  const concentrado = finalizadas.map((row) => {
    const pendientesSucursal = pendientesMap.get(Number(row.sucursal_id)) || {
      sesiones_en_proceso: 0,
      surtidores_en_proceso: 0
    };

    return {
      ...calcularMetricas(row),
      ...pendientesSucursal
    };
  });

  const totalGeneral = concentrado.reduce((acc, row) => {
    acc.sesiones_finalizadas += Number(row.sesiones_finalizadas || 0);
    acc.sesiones_en_proceso += Number(row.sesiones_en_proceso || 0);
    acc.tickets += Number(row.tickets || 0);
    acc.partidas += Number(row.partidas || 0);
    acc.monto += Number(row.monto || 0);
    acc.ceros += Number(row.ceros || 0);
    acc.no_surtido += Number(row.no_surtido || 0);
    acc.duracion_segundos += Number(row.duracion_segundos || 0);
    return acc;
  }, {
    sesiones_finalizadas: 0,
    sesiones_en_proceso: 0,
    tickets: 0,
    partidas: 0,
    monto: 0,
    ceros: 0,
    no_surtido: 0,
    duracion_segundos: 0
  });

  res.json({
    ok: true,
    fecha,
    filtros: {
      sucursal_id: sucursalId
    },
    total_general: calcularMetricas(totalGeneral),
    concentrado
  });
});