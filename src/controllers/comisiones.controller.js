import { pool } from '../config/db.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { registrarAuditoria } from '../utils/auditoria.js';
import { getNowMexicoDateTime } from '../utils/mexicoTime.js';
import { getJornadaDisponibleSegundosPorFechas } from '../utils/productividadDetalle.js';

const BASE_COMISION = 2000;

const PESOS = {
  SURTIDOR_SUCURSAL: {
    efectividad: 800,
    no_surtido: 300,
    asistencia: 600,
    orden: 200,
    puntualidad: 100
  },
  CHECADOR_SUCURSAL: {
    productividad: 1000,
    mal_empaque: 300,
    faltante_sobrante: 200,
    asistencia: 400,
    orden: 100
  },
  SURTIDOR_MAYOREO: {
    partidas_netas: 800,
    partidas_hora: 400,
    tickets: 200,
    neto: 100,
    negados: 300,
    asistencia: 200
  },
  ENCARGADO: {
    mayoria_equipo: 2000
  }
};

function validarFecha(value, fieldName = 'fecha') {
  const fecha = String(value || '').trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    const error = new Error(`${fieldName} debe tener formato YYYY-MM-DD`);
    error.status = 400;
    throw error;
  }

  return fecha;
}

function getDateFilters(payload = {}) {
  const now = new Date();
  const hoy = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const fecha = payload.fecha || '';
  const desde = validarFecha(payload.desde || fecha || hoy, 'desde');
  const hasta = validarFecha(payload.hasta || fecha || desde, 'hasta');

  if (hasta < desde) {
    const error = new Error('hasta no puede ser menor que desde');
    error.status = 400;
    throw error;
  }

  return { desde, hasta };
}

function toNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function round2(value) {
  return Number(toNumber(value).toFixed(2));
}

function percent(value, total) {
  const totalNumber = toNumber(total);
  if (!totalNumber) return 0;
  return round2((toNumber(value) / totalNumber) * 100);
}

function clamp01(value) {
  const number = toNumber(value);
  if (number < 0) return 0;
  if (number > 1) return 1;
  return number;
}

function uniqueDatesFromCsv(csv) {
  return String(csv || '')
    .split(',')
    .map((item) => item.trim().slice(0, 10))
    .filter(Boolean);
}

function normalizeEnum(value) {
  return String(value || '').trim().toUpperCase();
}

function periodoCodigo(desde, hasta) {
  return `${desde}_${hasta}`.replaceAll('-', '');
}

function mapIncidencias(rows = []) {
  const map = new Map();

  for (const row of rows) {
    const key = `${row.usuario_id}:${row.tipo_operacion}`;

    if (!map.has(key)) {
      map.set(key, {
        total: 0,
        bloqueantes: 0,
        por_tipo: {},
        items: []
      });
    }

    const item = map.get(key);
    const tipo = normalizeEnum(row.tipo_incidencia);

    item.total += 1;
    item.bloqueantes += Number(row.bloquea || 0) ? 1 : 0;
    item.por_tipo[tipo] = (item.por_tipo[tipo] || 0) + 1;
    item.items.push(row);
  }

  return map;
}

function getIncidenciasFor(map, usuarioId, tipoOperacion) {
  return map.get(`${usuarioId}:${tipoOperacion}`) || {
    total: 0,
    bloqueantes: 0,
    por_tipo: {},
    items: []
  };
}

function hasIncidencia(incidencias, tipo) {
  return Number(incidencias.por_tipo?.[tipo] || 0) > 0;
}

function buildBloqueos({ negadosPendientes = 0, incidencias = null, extra = [] }) {
  const bloqueos = [];

  if (toNumber(negadosPendientes) > 0) {
    bloqueos.push({
      codigo: 'NEGADOS_PENDIENTES',
      message: 'Hay negados pendientes de revisión',
      cantidad: toNumber(negadosPendientes)
    });
  }

  if (incidencias?.bloqueantes) {
    bloqueos.push({
      codigo: 'INCIDENCIAS_BLOQUEANTES',
      message: 'Hay incidencias operativas bloqueantes',
      cantidad: toNumber(incidencias.bloqueantes)
    });
  }

  return [...bloqueos, ...extra];
}

function buildComision({ usuario, surtidorId = null, checadorId = null, tipoComision, metricas, desglose, bloqueos }) {
  const montoAcumulado = Object.values(desglose || {}).reduce((acc, row) => acc + toNumber(row.monto), 0);
  const bloqueado = bloqueos.length > 0;
  const montoFinal = bloqueado ? 0 : montoAcumulado;

  return {
    usuario_id: usuario.usuario_id,
    usuario_nombre: usuario.usuario_nombre || usuario.nombre,
    usuario: usuario.usuario,
    surtidor_id: surtidorId,
    checador_id: checadorId,
    tipo_comision: tipoComision,
    metricas,
    desglose,
    bloqueos,
    monto_acumulado: round2(montoAcumulado),
    monto_final: round2(montoFinal),
    comisiona: !bloqueado && montoFinal > 0,
    bloqueado
  };
}

async function getIncidenciasActivas(desde, hasta) {
  const [rows] = await pool.query(
    `
    SELECT
      io.id,
      io.usuario_id,
      u.nombre AS usuario_nombre,
      u.usuario,
      io.surtidor_id,
      io.checador_id,
      io.tipo_operacion,
      io.tipo_incidencia,
      DATE_FORMAT(io.fecha, '%Y-%m-%d') AS fecha,
      io.descripcion,
      io.monto_bloqueado,
      io.bloquea,
      io.activa,
      io.creada_por,
      DATE_FORMAT(io.created_at, '%Y-%m-%d %H:%i:%s') AS created_at
    FROM incidencias_operativas io
    INNER JOIN usuarios u ON u.id = io.usuario_id
    WHERE io.fecha BETWEEN ? AND ?
      AND io.activa = 1
    ORDER BY io.fecha DESC, io.id DESC
    `,
    [desde, hasta]
  );

  return rows;
}

async function calcularSurtidoresSucursal(desde, hasta, incidenciasMap) {
  const [rows] = await pool.query(
    `
    SELECT
      u.id AS usuario_id,
      u.nombre AS usuario_nombre,
      u.usuario,
      s.id AS surtidor_id,
      s.codigo AS surtidor_codigo,
      s.codigo_reporte,
      COUNT(*) AS sesiones,
      COALESCE(SUM(ps.partidas), 0) AS partidas_surtidas,
      COALESCE(SUM(ps.ceros), 0) AS ceros,
      COALESCE(SUM(ps.no_surtido), 0) AS negados_capturados,
      COALESCE(SUM(ps.partidas + ps.ceros + ps.no_surtido), 0) AS surtido_total,
      COALESCE(SUM(ps.duracion_laboral_segundos), 0) AS tiempo_activo_segundos,
      GROUP_CONCAT(DISTINCT DATE_FORMAT(ps.fecha_operativa, '%Y-%m-%d') ORDER BY ps.fecha_operativa SEPARATOR ',') AS fechas
    FROM productividad_sesiones ps
    INNER JOIN surtidores s ON s.id = ps.surtidor_id
    INNER JOIN usuarios u ON u.id = s.usuario_id
    WHERE ps.estado = 'FINALIZADO'
      AND ps.tipo_operacion = 'SUCURSAL'
      AND ps.fecha_operativa BETWEEN ? AND ?
      AND s.tipo_operacion = 'SUCURSAL'
      AND s.activo = 1
      AND u.activo = 1
    GROUP BY u.id, u.nombre, u.usuario, s.id, s.codigo, s.codigo_reporte
    `,
    [desde, hasta]
  );

  const [negadosRows] = await pool.query(
    `
    SELECT
      usuario_id,
      COALESCE(SUM(CASE WHEN estado_revision = 'PENDIENTE_REVISION' THEN cantidad_negada ELSE 0 END), 0) AS negados_pendientes,
      COALESCE(SUM(CASE WHEN estado_revision = 'RECHAZADO_PENALIZA' THEN cantidad_negada ELSE 0 END), 0) AS negados_penalizables,
      COALESCE(SUM(CASE WHEN estado_revision = 'VALIDADO_NO_PENALIZA' THEN cantidad_negada ELSE 0 END), 0) AS negados_no_penalizan
    FROM productividad_sesion_negados
    WHERE tipo_operacion = 'SUCURSAL'
      AND fecha_operativa BETWEEN ? AND ?
    GROUP BY usuario_id
    `,
    [desde, hasta]
  );

  const negadosMap = new Map(negadosRows.map((row) => [Number(row.usuario_id), row]));

  return rows.map((row) => {
    const negados = negadosMap.get(Number(row.usuario_id)) || {};
    const incidencias = getIncidenciasFor(incidenciasMap, row.usuario_id, 'SURTIDOR_SUCURSAL');
    const surtidoTotal = toNumber(row.surtido_total);
    const partidas = toNumber(row.partidas_surtidas);
    const efectividadPct = percent(partidas, surtidoTotal);
    const negadosPenalizables = toNumber(negados.negados_penalizables);
    const fechas = uniqueDatesFromCsv(row.fechas);
    const jornadaSegundos = getJornadaDisponibleSegundosPorFechas(fechas, 'SUCURSAL');

    const desglose = {
      efectividad: {
        label: 'Efectividad individual',
        peso: PESOS.SURTIDOR_SUCURSAL.efectividad,
        valor: efectividadPct,
        monto: round2(PESOS.SURTIDOR_SUCURSAL.efectividad * clamp01(efectividadPct / 100))
      },
      no_surtido: {
        label: 'No surtido / negados penalizables',
        peso: PESOS.SURTIDOR_SUCURSAL.no_surtido,
        valor: negadosPenalizables,
        monto: negadosPenalizables > 0 ? 0 : PESOS.SURTIDOR_SUCURSAL.no_surtido
      },
      asistencia: {
        label: 'Asistencia',
        peso: PESOS.SURTIDOR_SUCURSAL.asistencia,
        valor: hasIncidencia(incidencias, 'ASISTENCIA') ? 0 : 1,
        monto: hasIncidencia(incidencias, 'ASISTENCIA') ? 0 : PESOS.SURTIDOR_SUCURSAL.asistencia
      },
      orden: {
        label: 'Orden / limpieza',
        peso: PESOS.SURTIDOR_SUCURSAL.orden,
        valor: hasIncidencia(incidencias, 'ORDEN') ? 0 : 1,
        monto: hasIncidencia(incidencias, 'ORDEN') ? 0 : PESOS.SURTIDOR_SUCURSAL.orden
      },
      puntualidad: {
        label: 'Puntualidad',
        peso: PESOS.SURTIDOR_SUCURSAL.puntualidad,
        valor: hasIncidencia(incidencias, 'PUNTUALIDAD') ? 0 : 1,
        monto: hasIncidencia(incidencias, 'PUNTUALIDAD') ? 0 : PESOS.SURTIDOR_SUCURSAL.puntualidad
      }
    };

    return buildComision({
      usuario: row,
      surtidorId: row.surtidor_id,
      tipoComision: 'SURTIDOR_SUCURSAL',
      metricas: {
        sesiones: toNumber(row.sesiones),
        fechas,
        partidas_surtidas: partidas,
        ceros: toNumber(row.ceros),
        negados_capturados: toNumber(row.negados_capturados),
        surtido_total: surtidoTotal,
        efectividad_pct: efectividadPct,
        tiempo_activo_segundos: toNumber(row.tiempo_activo_segundos),
        jornada_disponible_segundos: jornadaSegundos,
        partidas_por_hora_jornada: jornadaSegundos ? round2(partidas / (jornadaSegundos / 3600)) : 0,
        negados_pendientes: toNumber(negados.negados_pendientes),
        negados_penalizables: negadosPenalizables,
        negados_no_penalizan: toNumber(negados.negados_no_penalizan),
        incidencias
      },
      desglose,
      bloqueos: buildBloqueos({
        negadosPendientes: negados.negados_pendientes,
        incidencias
      })
    });
  });
}

async function calcularChecadoresSucursal(desde, hasta, incidenciasMap) {
  const [partidasRows] = await pool.query(
    `
    SELECT COALESCE(SUM(ps.partidas), 0) AS partidas_surtidores_sucursal
    FROM productividad_sesiones ps
    INNER JOIN surtidores s ON s.id = ps.surtidor_id
    INNER JOIN usuarios u ON u.id = s.usuario_id
    WHERE ps.estado = 'FINALIZADO'
      AND ps.tipo_operacion = 'SUCURSAL'
      AND ps.fecha_operativa BETWEEN ? AND ?
      AND s.activo = 1
      AND u.activo = 1
    `,
    [desde, hasta]
  );

  const totalPartidasSucursal = toNumber(partidasRows[0]?.partidas_surtidores_sucursal);

  const [rows] = await pool.query(
    `
    SELECT
      u.id AS usuario_id,
      u.nombre AS usuario_nombre,
      u.usuario,
      c.id AS checador_id,
      c.codigo_reporte,
      COUNT(*) AS salidas,
      COALESCE(SUM(cr.tp), 0) AS tp,
      COALESCE(SUM(cr.total), 0) AS total_importe,
      GROUP_CONCAT(DISTINCT DATE_FORMAT(cr.fecha, '%Y-%m-%d') ORDER BY cr.fecha SEPARATOR ',') AS fechas
    FROM checadores_reportes cr
    INNER JOIN checadores c ON c.id = cr.checador_id
    INNER JOIN usuarios u ON u.id = c.usuario_id
    WHERE cr.fecha BETWEEN ? AND ?
      AND c.usuario_id IS NOT NULL
      AND c.activo = 1
      AND u.activo = 1
    GROUP BY u.id, u.nombre, u.usuario, c.id, c.codigo_reporte
    `,
    [desde, hasta]
  );

  const horasEquipo = rows.reduce((acc, row) => {
    const fechas = uniqueDatesFromCsv(row.fechas);
    return acc + (getJornadaDisponibleSegundosPorFechas(fechas, 'SUCURSAL') / 3600);
  }, 0);

  const metaTpPorHora = horasEquipo ? totalPartidasSucursal / horasEquipo : 0;

  return rows.map((row) => {
    const fechas = uniqueDatesFromCsv(row.fechas);
    const jornadaSegundos = getJornadaDisponibleSegundosPorFechas(fechas, 'SUCURSAL');
    const horas = jornadaSegundos / 3600;
    const metaIndividual = horas * metaTpPorHora;
    const tp = toNumber(row.tp);
    const productividadRatio = metaIndividual ? clamp01(tp / metaIndividual) : 0;
    const incidencias = getIncidenciasFor(incidenciasMap, row.usuario_id, 'CHECADOR_SUCURSAL');
    const tieneMalEmpaque = hasIncidencia(incidencias, 'MAL_EMPAQUE');
    const tieneFaltante = hasIncidencia(incidencias, 'FALTANTE_SOBRANTE');

    const desglose = {
      productividad: {
        label: 'TP contra meta automática',
        peso: PESOS.CHECADOR_SUCURSAL.productividad,
        valor: round2(productividadRatio * 100),
        monto: round2(PESOS.CHECADOR_SUCURSAL.productividad * productividadRatio)
      },
      mal_empaque: {
        label: 'Mal empaque',
        peso: PESOS.CHECADOR_SUCURSAL.mal_empaque,
        valor: tieneMalEmpaque ? 0 : 1,
        monto: tieneMalEmpaque ? 0 : PESOS.CHECADOR_SUCURSAL.mal_empaque
      },
      faltante_sobrante: {
        label: 'Faltante / sobrante',
        peso: PESOS.CHECADOR_SUCURSAL.faltante_sobrante,
        valor: tieneFaltante ? 0 : 1,
        monto: tieneFaltante ? 0 : PESOS.CHECADOR_SUCURSAL.faltante_sobrante
      },
      asistencia: {
        label: 'Asistencia',
        peso: PESOS.CHECADOR_SUCURSAL.asistencia,
        valor: hasIncidencia(incidencias, 'ASISTENCIA') ? 0 : 1,
        monto: hasIncidencia(incidencias, 'ASISTENCIA') ? 0 : PESOS.CHECADOR_SUCURSAL.asistencia
      },
      orden: {
        label: 'Orden',
        peso: PESOS.CHECADOR_SUCURSAL.orden,
        valor: hasIncidencia(incidencias, 'ORDEN') ? 0 : 1,
        monto: hasIncidencia(incidencias, 'ORDEN') ? 0 : PESOS.CHECADOR_SUCURSAL.orden
      }
    };

    return buildComision({
      usuario: row,
      checadorId: row.checador_id,
      tipoComision: 'CHECADOR_SUCURSAL',
      metricas: {
        fechas,
        salidas: toNumber(row.salidas),
        tp,
        total_importe: round2(row.total_importe),
        jornada_disponible_segundos: jornadaSegundos,
        horas_jornada: round2(horas),
        total_partidas_surtidores_sucursal: totalPartidasSucursal,
        horas_equipo_checadores: round2(horasEquipo),
        meta_tp_por_hora: round2(metaTpPorHora),
        meta_individual: round2(metaIndividual),
        cumplimiento_meta_pct: round2(productividadRatio * 100),
        incidencias
      },
      desglose,
      bloqueos: buildBloqueos({ incidencias })
    });
  });
}

async function calcularSurtidoresMayoreo(desde, hasta, incidenciasMap) {
  const [produccionRows] = await pool.query(
    `
    SELECT
      u.id AS usuario_id,
      u.nombre AS usuario_nombre,
      u.usuario,
      s.id AS surtidor_id,
      s.codigo AS surtidor_codigo,
      s.codigo_reporte,
      COUNT(*) AS movimientos,
      COUNT(DISTINCT mrs.ticket) AS tickets,
      COALESCE(SUM(mrs.tp), 0) AS partidas_oficiales,
      COALESCE(SUM(mrs.neto), 0) AS neto
    FROM mayoreo_reportes_surtidores mrs
    INNER JOIN surtidores s ON s.id = mrs.surtidor_id
    INNER JOIN usuarios u ON u.id = mrs.usuario_id
    WHERE mrs.reportable = 1
      AND mrs.fecha BETWEEN ? AND ?
      AND s.tipo_operacion = 'MAYOREO'
      AND s.activo = 1
      AND u.activo = 1
    GROUP BY u.id, u.nombre, u.usuario, s.id, s.codigo, s.codigo_reporte
    `,
    [desde, hasta]
  );

  const [sesionesRows] = await pool.query(
    `
    SELECT
      ps.usuario_id,
      COUNT(*) AS sesiones,
      COALESCE(SUM(ps.duracion_laboral_segundos), 0) AS tiempo_activo_segundos,
      GROUP_CONCAT(DISTINCT DATE_FORMAT(ps.fecha_operativa, '%Y-%m-%d') ORDER BY ps.fecha_operativa SEPARATOR ',') AS fechas
    FROM productividad_sesiones ps
    INNER JOIN surtidores s ON s.id = ps.surtidor_id
    INNER JOIN usuarios u ON u.id = ps.usuario_id
    WHERE ps.estado = 'FINALIZADO'
      AND ps.tipo_operacion = 'MAYOREO'
      AND ps.fecha_operativa BETWEEN ? AND ?
      AND s.tipo_operacion = 'MAYOREO'
      AND s.activo = 1
      AND u.activo = 1
    GROUP BY ps.usuario_id
    `,
    [desde, hasta]
  );

  const [negadosRows] = await pool.query(
    `
    SELECT
      usuario_id,
      COALESCE(SUM(CASE WHEN estado_revision = 'PENDIENTE_REVISION' THEN cantidad_negada ELSE 0 END), 0) AS negados_pendientes,
      COALESCE(SUM(CASE WHEN estado_revision = 'VALIDADO_NO_PENALIZA' THEN cantidad_negada ELSE 0 END), 0) AS negados_no_penalizan,
      COALESCE(SUM(CASE WHEN estado_revision = 'RECHAZADO_PENALIZA' THEN cantidad_negada ELSE 0 END), 0) AS negados_penalizables
    FROM productividad_sesion_negados
    WHERE tipo_operacion = 'MAYOREO'
      AND fecha_operativa BETWEEN ? AND ?
    GROUP BY usuario_id
    `,
    [desde, hasta]
  );

  const sesionesMap = new Map(sesionesRows.map((row) => [Number(row.usuario_id), row]));
  const negadosMap = new Map(negadosRows.map((row) => [Number(row.usuario_id), row]));

  const baseRows = produccionRows.map((row) => {
    const sesiones = sesionesMap.get(Number(row.usuario_id)) || {};
    const negados = negadosMap.get(Number(row.usuario_id)) || {};
    const partidasNetas = Math.max(0, toNumber(row.partidas_oficiales) - toNumber(negados.negados_penalizables));
    const tiempoActivo = toNumber(sesiones.tiempo_activo_segundos);
    const horasActivas = tiempoActivo / 3600;

    return {
      ...row,
      sesiones: toNumber(sesiones.sesiones),
      fechas: uniqueDatesFromCsv(sesiones.fechas),
      tiempo_activo_segundos: tiempoActivo,
      horas_activas: horasActivas,
      negados_pendientes: toNumber(negados.negados_pendientes),
      negados_no_penalizan: toNumber(negados.negados_no_penalizan),
      negados_penalizables: toNumber(negados.negados_penalizables),
      partidas_netas: partidasNetas,
      partidas_netas_por_hora_activa: horasActivas ? partidasNetas / horasActivas : 0
    };
  });

  const maxPartidasNetas = Math.max(...baseRows.map((row) => row.partidas_netas), 0);
  const maxPartidasHora = Math.max(...baseRows.map((row) => row.partidas_netas_por_hora_activa), 0);
  const maxTickets = Math.max(...baseRows.map((row) => toNumber(row.tickets)), 0);
  const maxNeto = Math.max(...baseRows.map((row) => toNumber(row.neto)), 0);

  return baseRows.map((row) => {
    const incidencias = getIncidenciasFor(incidenciasMap, row.usuario_id, 'SURTIDOR_MAYOREO');

    const desglose = {
      partidas_netas: {
        label: 'Partidas netas',
        peso: PESOS.SURTIDOR_MAYOREO.partidas_netas,
        valor: row.partidas_netas,
        monto: maxPartidasNetas ? round2(PESOS.SURTIDOR_MAYOREO.partidas_netas * clamp01(row.partidas_netas / maxPartidasNetas)) : 0
      },
      partidas_hora: {
        label: 'Partidas netas / hora activa',
        peso: PESOS.SURTIDOR_MAYOREO.partidas_hora,
        valor: round2(row.partidas_netas_por_hora_activa),
        monto: maxPartidasHora ? round2(PESOS.SURTIDOR_MAYOREO.partidas_hora * clamp01(row.partidas_netas_por_hora_activa / maxPartidasHora)) : 0
      },
      tickets: {
        label: 'Tickets',
        peso: PESOS.SURTIDOR_MAYOREO.tickets,
        valor: toNumber(row.tickets),
        monto: maxTickets ? round2(PESOS.SURTIDOR_MAYOREO.tickets * clamp01(toNumber(row.tickets) / maxTickets)) : 0
      },
      neto: {
        label: 'Neto',
        peso: PESOS.SURTIDOR_MAYOREO.neto,
        valor: round2(row.neto),
        monto: maxNeto ? round2(PESOS.SURTIDOR_MAYOREO.neto * clamp01(toNumber(row.neto) / maxNeto)) : 0
      },
      negados: {
        label: 'Negados penalizables',
        peso: PESOS.SURTIDOR_MAYOREO.negados,
        valor: row.negados_penalizables,
        monto: row.negados_penalizables > 0 ? 0 : PESOS.SURTIDOR_MAYOREO.negados
      },
      asistencia: {
        label: 'Asistencia',
        peso: PESOS.SURTIDOR_MAYOREO.asistencia,
        valor: hasIncidencia(incidencias, 'ASISTENCIA') ? 0 : 1,
        monto: hasIncidencia(incidencias, 'ASISTENCIA') ? 0 : PESOS.SURTIDOR_MAYOREO.asistencia
      }
    };

    return buildComision({
      usuario: row,
      surtidorId: row.surtidor_id,
      tipoComision: 'SURTIDOR_MAYOREO',
      metricas: {
        movimientos: toNumber(row.movimientos),
        tickets: toNumber(row.tickets),
        partidas_oficiales: toNumber(row.partidas_oficiales),
        negados_penalizables: row.negados_penalizables,
        negados_no_penalizan: row.negados_no_penalizan,
        negados_pendientes: row.negados_pendientes,
        partidas_netas: row.partidas_netas,
        neto: round2(row.neto),
        sesiones: row.sesiones,
        tiempo_activo_segundos: row.tiempo_activo_segundos,
        partidas_netas_por_hora_activa: round2(row.partidas_netas_por_hora_activa),
        referencias_equipo: {
          max_partidas_netas: maxPartidasNetas,
          max_partidas_hora: round2(maxPartidasHora),
          max_tickets: maxTickets,
          max_neto: round2(maxNeto)
        },
        incidencias
      },
      desglose,
      bloqueos: buildBloqueos({
        negadosPendientes: row.negados_pendientes,
        incidencias
      })
    });
  });
}

async function calcularEncargados(incidenciasMap, comisionesBase) {
  const [encargados] = await pool.query(
    `
    SELECT
      id AS usuario_id,
      nombre AS usuario_nombre,
      usuario,
      encargado_surtidores_sucursal,
      encargado_checadores_sucursal,
      encargado_surtidores_mayoreo
    FROM usuarios
    WHERE activo = 1
      AND es_encargado = 1
    ORDER BY nombre ASC
    `
  );

  return encargados.map((row) => {
    const tiposEquipo = [];

    if (Number(row.encargado_surtidores_sucursal)) tiposEquipo.push('SURTIDOR_SUCURSAL');
    if (Number(row.encargado_checadores_sucursal)) tiposEquipo.push('CHECADOR_SUCURSAL');
    if (Number(row.encargado_surtidores_mayoreo)) tiposEquipo.push('SURTIDOR_MAYOREO');

    const equipo = comisionesBase.filter((item) => {
      return tiposEquipo.includes(item.tipo_comision) && item.usuario_id !== row.usuario_id;
    });

    const totalEquipo = equipo.length;
    const equipoComisiona = equipo.filter((item) => item.comisiona).length;
    const porcentajeEquipo = totalEquipo ? percent(equipoComisiona, totalEquipo) : 0;
    const mayoria = totalEquipo > 0 && equipoComisiona > (totalEquipo / 2);
    const incidencias = getIncidenciasFor(incidenciasMap, row.usuario_id, 'ENCARGADO');

    const bloqueos = buildBloqueos({
      incidencias,
      extra: totalEquipo === 0 ? [{ codigo: 'SIN_EQUIPO', message: 'No hay equipo asignado con datos para evaluar', cantidad: 0 }] : []
    });

    const desglose = {
      mayoria_equipo: {
        label: 'Mayoría de equipo combinado comisiona',
        peso: PESOS.ENCARGADO.mayoria_equipo,
        valor: porcentajeEquipo,
        monto: mayoria ? PESOS.ENCARGADO.mayoria_equipo : 0
      }
    };

    return buildComision({
      usuario: row,
      tipoComision: 'ENCARGADO',
      metricas: {
        tipos_equipo: tiposEquipo,
        integrantes_equipo: totalEquipo,
        integrantes_comisionan: equipoComisiona,
        porcentaje_equipo_comisiona: porcentajeEquipo,
        mayoria,
        incidencias
      },
      desglose,
      bloqueos
    });
  });
}

function buildResumen(comisiones) {
  return comisiones.reduce((acc, item) => {
    acc.total_registros += 1;
    acc.total_monto_acumulado += toNumber(item.monto_acumulado);
    acc.total_monto_final += toNumber(item.monto_final);
    acc.comisionan += item.comisiona ? 1 : 0;
    acc.bloqueados += item.bloqueado ? 1 : 0;

    if (!acc.por_tipo[item.tipo_comision]) {
      acc.por_tipo[item.tipo_comision] = {
        registros: 0,
        comisionan: 0,
        bloqueados: 0,
        monto_final: 0
      };
    }

    acc.por_tipo[item.tipo_comision].registros += 1;
    acc.por_tipo[item.tipo_comision].comisionan += item.comisiona ? 1 : 0;
    acc.por_tipo[item.tipo_comision].bloqueados += item.bloqueado ? 1 : 0;
    acc.por_tipo[item.tipo_comision].monto_final += toNumber(item.monto_final);

    return acc;
  }, {
    total_registros: 0,
    comisionan: 0,
    bloqueados: 0,
    total_monto_acumulado: 0,
    total_monto_final: 0,
    por_tipo: {}
  });
}

function normalizeResumen(resumen) {
  resumen.total_monto_acumulado = round2(resumen.total_monto_acumulado);
  resumen.total_monto_final = round2(resumen.total_monto_final);

  for (const tipo of Object.keys(resumen.por_tipo)) {
    resumen.por_tipo[tipo].monto_final = round2(resumen.por_tipo[tipo].monto_final);
  }

  return resumen;
}

async function guardarCalculo(connection, req, { desde, hasta, motivo, resumen, comisiones }) {
  const codigo = periodoCodigo(desde, hasta);
  const now = getNowMexicoDateTime();

  const [periodoResult] = await connection.query(
    `
    INSERT INTO comisiones_periodos (
      codigo,
      desde,
      hasta,
      estado,
      motivo,
      resumen_json,
      calculado_por,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, 'BORRADOR', ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      estado = 'BORRADOR',
      motivo = VALUES(motivo),
      resumen_json = VALUES(resumen_json),
      calculado_por = VALUES(calculado_por),
      updated_at = VALUES(updated_at)
    `,
    [
      codigo,
      desde,
      hasta,
      motivo || null,
      JSON.stringify(resumen),
      req.user.id,
      now,
      now
    ]
  );

  let periodoId = periodoResult.insertId;

  if (!periodoId) {
    const [periodos] = await connection.query(
      'SELECT id FROM comisiones_periodos WHERE codigo = ? LIMIT 1',
      [codigo]
    );

    periodoId = periodos[0]?.id;
  }

  await connection.query(
  `DELETE FROM comisiones_individuales WHERE periodo_id = ? AND estado = 'BORRADOR'`,
    [periodoId]
  );

  for (const item of comisiones) {
    await connection.query(
      `
      INSERT INTO comisiones_individuales (
        periodo_id,
        usuario_id,
        surtidor_id,
        checador_id,
        tipo_comision,
        metricas_json,
        desglose_json,
        bloqueos_json,
        monto_acumulado,
        monto_final,
        comisiona,
        bloqueado,
        estado
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'BORRADOR')
      ON DUPLICATE KEY UPDATE
        surtidor_id = VALUES(surtidor_id),
        checador_id = VALUES(checador_id),
        metricas_json = VALUES(metricas_json),
        desglose_json = VALUES(desglose_json),
        bloqueos_json = VALUES(bloqueos_json),
        monto_acumulado = VALUES(monto_acumulado),
        monto_final = VALUES(monto_final),
        comisiona = VALUES(comisiona),
        bloqueado = VALUES(bloqueado),
        estado = 'BORRADOR',
        updated_at = CURRENT_TIMESTAMP
      `,
      [
        periodoId,
        item.usuario_id,
        item.surtidor_id || null,
        item.checador_id || null,
        item.tipo_comision,
        JSON.stringify(item.metricas || {}),
        JSON.stringify(item.desglose || {}),
        JSON.stringify(item.bloqueos || []),
        item.monto_acumulado,
        item.monto_final,
        item.comisiona ? 1 : 0,
        item.bloqueado ? 1 : 0
      ]
    );
  }

  await registrarAuditoria(connection, {
    req,
    modulo: 'COMISIONES',
    accion: 'CALCULAR_COMISIONES_INDIVIDUALES',
    entidad: 'comisiones_periodos',
    entidadId: periodoId,
    datosAntes: null,
    datosDespues: {
      codigo,
      desde,
      hasta,
      resumen
    }
  });

  return periodoId;
}

export const calcularComisiones = asyncHandler(async (req, res) => {
  const payload = {
    ...req.query,
    ...req.body
  };

  const { desde, hasta } = getDateFilters(payload);
  const dryRun = payload.dry_run === false || payload.dry_run === 'false' ? false : true;
  const motivo = String(payload.motivo || '').trim();

  const incidencias = await getIncidenciasActivas(desde, hasta);
  const incidenciasMap = mapIncidencias(incidencias);

  const surtidoresSucursal = await calcularSurtidoresSucursal(desde, hasta, incidenciasMap);
  const checadoresSucursal = await calcularChecadoresSucursal(desde, hasta, incidenciasMap);
  const surtidoresMayoreo = await calcularSurtidoresMayoreo(desde, hasta, incidenciasMap);

  const base = [
    ...surtidoresSucursal,
    ...checadoresSucursal,
    ...surtidoresMayoreo
  ];

  const encargados = await calcularEncargados(incidenciasMap, base);
  const comisiones = [...base, ...encargados];
  const resumen = normalizeResumen(buildResumen(comisiones));

  let periodoId = null;

  if (!dryRun) {
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();
      periodoId = await guardarCalculo(connection, req, {
        desde,
        hasta,
        motivo,
        resumen,
        comisiones
      });
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
    periodo_id: periodoId,
    filtros: { desde, hasta },
    reglas: {
      base_comision: BASE_COMISION,
      pesos: PESOS,
      checadores_meta: 'total_partidas_surtidores_sucursales / total_horas_jornada_checadores_activos',
      mayoreo_partidas_netas: 'partidas_oficiales - negados_penalizables',
      encargado: 'comisiona si más del 50% del equipo combinado comisiona'
    },
    resumen,
    comisiones
  });
});

export const listarPeriodos = asyncHandler(async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 20), 100);

  const [rows] = await pool.query(
    `
    SELECT
      id,
      codigo,
      DATE_FORMAT(desde, '%Y-%m-%d') AS desde,
      DATE_FORMAT(hasta, '%Y-%m-%d') AS hasta,
      estado,
      motivo,
      resumen_json,
      calculado_por,
      DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
      DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at
    FROM comisiones_periodos
    ORDER BY id DESC
    LIMIT ?
    `,
    [limit]
  );

  res.json({
    ok: true,
    periodos: rows.map((row) => ({
      ...row,
      resumen: typeof row.resumen_json === 'string'
        ? JSON.parse(row.resumen_json || '{}')
        : row.resumen_json
    }))
  });
});

export const detallePeriodo = asyncHandler(async (req, res) => {
  const periodoId = Number(req.params.id);

  if (!Number.isInteger(periodoId) || periodoId <= 0) {
    return res.status(400).json({ ok: false, message: 'periodo_id inválido' });
  }

  const [periodos] = await pool.query(
    `
    SELECT
      id,
      codigo,
      DATE_FORMAT(desde, '%Y-%m-%d') AS desde,
      DATE_FORMAT(hasta, '%Y-%m-%d') AS hasta,
      estado,
      motivo,
      resumen_json
    FROM comisiones_periodos
    WHERE id = ?
    LIMIT 1
    `,
    [periodoId]
  );

  if (!periodos.length) {
    return res.status(404).json({ ok: false, message: 'Periodo no encontrado' });
  }

  const [rows] = await pool.query(
    `
    SELECT
      ci.id,
      ci.periodo_id,
      ci.usuario_id,
      u.nombre AS usuario_nombre,
      u.usuario,
      ci.surtidor_id,
      ci.checador_id,
      ci.tipo_comision,
      ci.metricas_json,
      ci.desglose_json,
      ci.bloqueos_json,
      ci.monto_acumulado,
      ci.monto_final,
      ci.comisiona,
      ci.bloqueado,
      ci.estado
    FROM comisiones_individuales ci
    INNER JOIN usuarios u ON u.id = ci.usuario_id
    WHERE ci.periodo_id = ?
    ORDER BY ci.tipo_comision ASC, u.nombre ASC
    `,
    [periodoId]
  );

  res.json({
    ok: true,
    periodo: {
      ...periodos[0],
      resumen: typeof periodos[0].resumen_json === 'string'
        ? JSON.parse(periodos[0].resumen_json || '{}')
        : periodos[0].resumen_json
    },
    comisiones: rows.map((row) => ({
      ...row,
      metricas: typeof row.metricas_json === 'string' ? JSON.parse(row.metricas_json || '{}') : row.metricas_json,
      desglose: typeof row.desglose_json === 'string' ? JSON.parse(row.desglose_json || '{}') : row.desglose_json,
      bloqueos: typeof row.bloqueos_json === 'string' ? JSON.parse(row.bloqueos_json || '[]') : row.bloqueos_json
    }))
  });
});

export const listarIncidencias = asyncHandler(async (req, res) => {
  const { desde, hasta } = getDateFilters(req.query);

  const [rows] = await pool.query(
    `
    SELECT
      io.id,
      io.usuario_id,
      u.nombre AS usuario_nombre,
      u.usuario,
      io.surtidor_id,
      io.checador_id,
      io.tipo_operacion,
      io.tipo_incidencia,
      DATE_FORMAT(io.fecha, '%Y-%m-%d') AS fecha,
      io.descripcion,
      io.monto_bloqueado,
      io.bloquea,
      io.activa,
      io.creada_por,
      DATE_FORMAT(io.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
      DATE_FORMAT(io.resuelta_at, '%Y-%m-%d %H:%i:%s') AS resuelta_at,
      io.comentario_resolucion
    FROM incidencias_operativas io
    INNER JOIN usuarios u ON u.id = io.usuario_id
    WHERE io.fecha BETWEEN ? AND ?
    ORDER BY io.activa DESC, io.fecha DESC, io.id DESC
    `,
    [desde, hasta]
  );

  res.json({ ok: true, filtros: { desde, hasta }, incidencias: rows });
});

export const crearIncidencia = asyncHandler(async (req, res) => {
  const usuarioId = Number(req.body.usuario_id);
  const fecha = validarFecha(req.body.fecha, 'fecha');
  const tipoOperacion = normalizeEnum(req.body.tipo_operacion);
  const tipoIncidencia = normalizeEnum(req.body.tipo_incidencia);
  const descripcion = String(req.body.descripcion || '').trim();
  const bloquea = req.body.bloquea === false || req.body.bloquea === 'false' ? 0 : 1;

  const tiposOperacionValidos = ['SURTIDOR_SUCURSAL', 'CHECADOR_SUCURSAL', 'SURTIDOR_MAYOREO', 'ENCARGADO'];
  const tiposIncidenciaValidos = ['MAL_EMPAQUE', 'FALTANTE_SOBRANTE', 'ASISTENCIA', 'ORDEN', 'PUNTUALIDAD', 'OTRO'];

  if (!Number.isInteger(usuarioId) || usuarioId <= 0) {
    return res.status(400).json({ ok: false, message: 'usuario_id inválido' });
  }

  if (!tiposOperacionValidos.includes(tipoOperacion)) {
    return res.status(400).json({ ok: false, message: 'tipo_operacion inválido' });
  }

  if (!tiposIncidenciaValidos.includes(tipoIncidencia)) {
    return res.status(400).json({ ok: false, message: 'tipo_incidencia inválido' });
  }

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [usuarios] = await connection.query(
      'SELECT id, nombre, usuario FROM usuarios WHERE id = ? AND activo = 1 LIMIT 1',
      [usuarioId]
    );

    if (!usuarios.length) {
      const error = new Error('Usuario no encontrado o inactivo');
      error.status = 404;
      throw error;
    }

    const [result] = await connection.query(
      `
      INSERT INTO incidencias_operativas (
        usuario_id,
        tipo_operacion,
        tipo_incidencia,
        fecha,
        descripcion,
        bloquea,
        activa,
        creada_por
      )
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)
      `,
      [usuarioId, tipoOperacion, tipoIncidencia, fecha, descripcion || null, bloquea, req.user.id]
    );

    await registrarAuditoria(connection, {
      req,
      modulo: 'COMISIONES',
      accion: 'CREAR_INCIDENCIA_OPERATIVA',
      entidad: 'incidencias_operativas',
      entidadId: result.insertId,
      datosAntes: null,
      datosDespues: {
        usuario_id: usuarioId,
        tipo_operacion: tipoOperacion,
        tipo_incidencia: tipoIncidencia,
        fecha,
        descripcion,
        bloquea
      }
    });

    await connection.commit();

    res.status(201).json({ ok: true, message: 'Incidencia creada correctamente', incidencia_id: result.insertId });
  } catch (error) {
    try { await connection.rollback(); } catch {}
    throw error;
  } finally {
    connection.release();
  }
});

export const resolverIncidencia = asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const activa = req.body.activa === false || req.body.activa === 'false' ? 0 : 1;
  const comentario = String(req.body.comentario_resolucion || '').trim();

  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ ok: false, message: 'id inválido' });
  }

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [actualRows] = await connection.query(
      'SELECT * FROM incidencias_operativas WHERE id = ? LIMIT 1',
      [id]
    );

    if (!actualRows.length) {
      const error = new Error('Incidencia no encontrada');
      error.status = 404;
      throw error;
    }

    await connection.query(
      `
      UPDATE incidencias_operativas
      SET
        activa = ?,
        resuelta_por = ?,
        resuelta_at = ?,
        comentario_resolucion = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
      `,
      [activa, req.user.id, getNowMexicoDateTime(), comentario || null, id]
    );

    await registrarAuditoria(connection, {
      req,
      modulo: 'COMISIONES',
      accion: 'RESOLVER_INCIDENCIA_OPERATIVA',
      entidad: 'incidencias_operativas',
      entidadId: id,
      datosAntes: actualRows[0],
      datosDespues: { activa, comentario_resolucion: comentario }
    });

    await connection.commit();

    res.json({ ok: true, message: activa ? 'Incidencia reactivada' : 'Incidencia desactivada/resuelta' });
  } catch (error) {
    try { await connection.rollback(); } catch {}
    throw error;
  } finally {
    connection.release();
  }
});
