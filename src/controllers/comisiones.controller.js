import { pool } from '../config/db.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { registrarAuditoria } from '../utils/auditoria.js';
import { getNowMexicoDateTime } from '../utils/mexicoTime.js';
import { getJornadaDisponibleSegundosPorFechas } from '../utils/productividadDetalle.js';
import XLSX from 'xlsx';

const BASE_COMISION = 2000;
const EFECTIVIDAD_MINIMA_PCT = 90;
const LIMITE_NEGADOS_PENALIZABLES_RATIO = 0.01;
const SEGUNDOS_JORNADA_COMPLETA = 8 * 3600;

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

function cumpleEfectividadMinima(efectividadPct) {
  return toNumber(efectividadPct) > EFECTIVIDAD_MINIMA_PCT;
}

function excedeLimiteNegadosPenalizables(negadosPenalizables, surtidoBase) {
  const base = toNumber(surtidoBase);

  if (base <= 0) return false;

  return toNumber(negadosPenalizables) > (base * LIMITE_NEGADOS_PENALIZABLES_RATIO);
}

function uniqueDatesFromCsv(csv) {
  return String(csv || '')
    .split(',')
    .map((item) => item.trim().slice(0, 10))
    .filter(Boolean);
}


function addDays(fecha, days = 1) {
  const date = new Date(`${fecha}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dateRange(desde, hasta) {
  const dates = [];
  let current = desde;
  let safety = 0;

  while (current <= hasta && safety < 370) {
    dates.push(current);
    current = addDays(current, 1);
    safety += 1;
  }

  return dates;
}

function mapBy(rows = [], keyBuilder) {
  const map = new Map();
  for (const row of rows) {
    map.set(keyBuilder(row), row);
  }
  return map;
}

function montoPorCumplimiento(peso, cumplimientoRatio) {
  return round2(toNumber(peso) * clamp01(cumplimientoRatio));
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

  if (incidencias && hasIncidencia(incidencias, 'ASISTENCIA')) {
    bloqueos.push({
      codigo: 'INASISTENCIA_INJUSTIFICADA',
      message: 'Bono bloqueado por inasistencia injustificada',
      cantidad: Number(incidencias.por_tipo?.ASISTENCIA || 0)
    });
  }

  if (incidencias && hasIncidencia(incidencias, 'MAL_EMPAQUE')) {
    bloqueos.push({
      codigo: 'MAL_EMPAQUE',
      message: 'Bono bloqueado por incidencia de mal empaque',
      cantidad: Number(incidencias.por_tipo?.MAL_EMPAQUE || 0)
    });
  }

  return [...bloqueos, ...extra];
}

function buildComision({
  usuario,
  surtidorId = null,
  checadorId = null,
  tipoComision,
  metricas,
  desglose,
  bloqueos,
  forceMontoAcumulado = null
}) {
  const montoAcumulado = forceMontoAcumulado ?? Object.values(desglose || {}).reduce((acc, row) => acc + toNumber(row.monto), 0);
  const bloqueado = bloqueos.length > 0;

  /*
    Regla operativa:
    Ningún usuario puede cobrar más de $2,000 en el periodo, aunque tenga
    funciones combinadas como surtidor + checador.
  */
  const montoFinal = bloqueado ? 0 : Math.min(BASE_COMISION, montoAcumulado);

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

function uniqueBloqueos(bloqueos = []) {
  const map = new Map();

  for (const bloqueo of bloqueos) {
    const key = `${bloqueo.codigo || 'BLOQUEO'}:${bloqueo.message || ''}`;

    if (!map.has(key)) {
      map.set(key, {
        ...bloqueo,
        cantidad: toNumber(bloqueo.cantidad)
      });
      continue;
    }

    const actual = map.get(key);
    actual.cantidad += toNumber(bloqueo.cantidad);
  }

  return [...map.values()];
}

function fusionarComisionesOperativas(comisionesBase = []) {
  const byUsuario = new Map();

  for (const item of comisionesBase) {
    if (!byUsuario.has(item.usuario_id)) {
      byUsuario.set(item.usuario_id, []);
    }

    byUsuario.get(item.usuario_id).push(item);
  }

  const fusionadas = [];

  for (const items of byUsuario.values()) {
    if (items.length === 1) {
      const item = items[0];

      fusionadas.push({
        ...item,
        monto_final: item.bloqueado ? 0 : round2(Math.min(BASE_COMISION, item.monto_acumulado)),
        comisiona: !item.bloqueado && Math.min(BASE_COMISION, item.monto_acumulado) > 0
      });

      continue;
    }

    const usuarioBase = items[0];
    const tipos = items.map((item) => item.tipo_comision);
    const bloqueos = uniqueBloqueos(items.flatMap((item) => item.bloqueos || []));
    const bloqueado = bloqueos.length > 0;
    const pesoPorRubro = BASE_COMISION / items.length;

    const desglose = {};
    let montoProceso = 0;

    for (const item of items) {
      const montoBaseIndividual = Math.min(BASE_COMISION, toNumber(item.monto_acumulado));
      const cumplimiento = clamp01(montoBaseIndividual / BASE_COMISION);
      const montoEscalado = bloqueado ? 0 : round2(pesoPorRubro * cumplimiento);

      montoProceso += montoEscalado;

      desglose[item.tipo_comision] = {
        label: item.tipo_comision,
        peso: round2(pesoPorRubro),
        valor: round2(cumplimiento * 100),
        monto: montoEscalado,
        cumplimiento_pct: round2(cumplimiento * 100),
        bloqueado: item.bloqueado,
        comisiona: item.comisiona,
        desglose_original: item.desglose || {},
        metricas_originales: item.metricas || {}
      };
    }

    const montoFinal = bloqueado ? 0 : Math.min(BASE_COMISION, montoProceso);

    fusionadas.push({
      usuario_id: usuarioBase.usuario_id,
      usuario_nombre: usuarioBase.usuario_nombre,
      usuario: usuarioBase.usuario,
      surtidor_id: items.find((item) => item.surtidor_id)?.surtidor_id || null,
      checador_id: items.find((item) => item.checador_id)?.checador_id || null,
      tipo_comision: 'OPERATIVO_FUSIONADO',
      metricas: {
        regla: 'Usuario con más de una función operativa; se fusiona en un solo bono de $2,000. Cada rubro aporta una parte proporcional en escala.',
        tipos_comision: tipos,
        peso_por_rubro: round2(pesoPorRubro),
        componentes: items.map((item) => ({
          tipo_comision: item.tipo_comision,
          cumplimiento_pct: desglose[item.tipo_comision]?.cumplimiento_pct || 0,
          aportacion_bono: desglose[item.tipo_comision]?.monto || 0,
          comisiona: item.comisiona,
          bloqueado: item.bloqueado,
          metricas: item.metricas || {}
        })),
        tope_usuario: BASE_COMISION
      },
      desglose,
      bloqueos,
      monto_acumulado: round2(montoFinal),
      monto_final: round2(montoFinal),
      comisiona: !bloqueado && montoFinal > 0,
      bloqueado
    });
  }

  return fusionadas;
}

function comisionAplicaAEquipo(item, tiposEquipo = []) {
  const tiposItem = item.tipo_comision === 'OPERATIVO_FUSIONADO'
    ? item.metricas?.tipos_comision || []
    : [item.tipo_comision];

  return tiposItem.some((tipo) => tiposEquipo.includes(tipo));
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
  const [dailyRows] = await pool.query(
    `
    SELECT
      u.id AS usuario_id,
      u.nombre AS usuario_nombre,
      u.usuario,
      s.id AS surtidor_id,
      s.codigo AS surtidor_codigo,
      s.codigo_reporte,
      DATE_FORMAT(ps.fecha_operativa, '%Y-%m-%d') AS fecha,
      COUNT(*) AS sesiones,
      COALESCE(SUM(ps.partidas), 0) AS partidas_surtidas,
      COALESCE(SUM(ps.ceros), 0) AS ceros,
      COALESCE(SUM(ps.no_surtido), 0) AS negados_capturados,
      COALESCE(SUM(ps.partidas + ps.ceros + ps.no_surtido), 0) AS surtido_total,
      COALESCE(SUM(ps.duracion_laboral_segundos), 0) AS tiempo_activo_segundos
    FROM productividad_sesiones ps
    INNER JOIN surtidores s ON s.id = ps.surtidor_id
    INNER JOIN usuarios u ON u.id = s.usuario_id
    WHERE ps.estado = 'FINALIZADO'
      AND ps.tipo_operacion = 'SUCURSAL'
      AND ps.fecha_operativa BETWEEN ? AND ?
      AND s.tipo_operacion = 'SUCURSAL'
      AND s.activo = 1
      AND u.activo = 1
    GROUP BY u.id, u.nombre, u.usuario, s.id, s.codigo, s.codigo_reporte, ps.fecha_operativa
    ORDER BY u.nombre ASC, ps.fecha_operativa ASC
    `,
    [desde, hasta]
  );

  const [negadosDailyRows] = await pool.query(
    `
    SELECT
      usuario_id,
      DATE_FORMAT(fecha_operativa, '%Y-%m-%d') AS fecha,
      COALESCE(SUM(CASE WHEN estado_revision = 'PENDIENTE_REVISION' THEN cantidad_negada ELSE 0 END), 0) AS negados_pendientes,
      COALESCE(SUM(CASE WHEN estado_revision = 'RECHAZADO_PENALIZA' THEN cantidad_negada ELSE 0 END), 0) AS negados_penalizables,
      COALESCE(SUM(CASE WHEN estado_revision = 'VALIDADO_NO_PENALIZA' THEN cantidad_negada ELSE 0 END), 0) AS negados_no_penalizan
    FROM productividad_sesion_negados
    WHERE tipo_operacion = 'SUCURSAL'
      AND fecha_operativa BETWEEN ? AND ?
    GROUP BY usuario_id, fecha_operativa
    `,
    [desde, hasta]
  );

  const negadosDailyMap = mapBy(
    negadosDailyRows,
    (row) => `${Number(row.usuario_id)}:${row.fecha}`
  );

  const byUser = new Map();

  for (const row of dailyRows) {
    const usuarioId = Number(row.usuario_id);

    if (!byUser.has(usuarioId)) {
      byUser.set(usuarioId, {
        usuario_id: usuarioId,
        usuario_nombre: row.usuario_nombre,
        usuario: row.usuario,
        surtidor_id: row.surtidor_id,
        surtidor_codigo: row.surtidor_codigo,
        codigo_reporte: row.codigo_reporte,
        sesiones: 0,
        partidas_surtidas: 0,
        ceros: 0,
        negados_capturados: 0,
        surtido_total: 0,
        tiempo_activo_segundos: 0,
        negados_pendientes: 0,
        negados_penalizables: 0,
        negados_no_penalizan: 0,
        fechas: [],
        dias: []
      });
    }

    const item = byUser.get(usuarioId);
    const fecha = row.fecha;
    const negados = negadosDailyMap.get(`${usuarioId}:${fecha}`) || {};
    const partidasDia = toNumber(row.partidas_surtidas);
    const negadosPenalizablesDia = toNumber(negados.negados_penalizables);
    const totalSurtidoRolDia = toNumber(row.surtido_total);
    const baseEfectividadDia = totalSurtidoRolDia;
    const efectividadDiaPct = baseEfectividadDia ? percent(partidasDia, baseEfectividadDia) : 0;
    const cumpleDia = cumpleEfectividadMinima(efectividadDiaPct);

    item.sesiones += toNumber(row.sesiones);
    item.partidas_surtidas += partidasDia;
    item.ceros += toNumber(row.ceros);
    item.negados_capturados += toNumber(row.negados_capturados);
    item.surtido_total += toNumber(row.surtido_total);
    item.tiempo_activo_segundos += toNumber(row.tiempo_activo_segundos);
    item.negados_pendientes += toNumber(negados.negados_pendientes);
    item.negados_penalizables += negadosPenalizablesDia;
    item.negados_no_penalizan += toNumber(negados.negados_no_penalizan);
    item.fechas.push(fecha);
    item.dias.push({
      fecha,
      partidas_surtidas: partidasDia,
      negados_penalizables: negadosPenalizablesDia,
      surtido_total: totalSurtidoRolDia,
      total_surtido_rol: totalSurtidoRolDia,
      efectividad_pct: efectividadDiaPct,
      cumple_efectividad: cumpleDia
    });
  }

  return [...byUser.values()].map((row) => {
    const incidencias = getIncidenciasFor(incidenciasMap, row.usuario_id, 'SURTIDOR_SUCURSAL');
    const fechas = [...new Set(row.fechas)];
    const diasEvaluados = row.dias.length;
    const diasCumplenEfectividad = row.dias.filter((dia) => dia.cumple_efectividad).length;
    const cumplimientoEfectividadRatio = diasEvaluados ? diasCumplenEfectividad / diasEvaluados : 0;
    const partidas = toNumber(row.partidas_surtidas);
    const negadosPenalizables = toNumber(row.negados_penalizables);
    const baseEfectividad = toNumber(row.surtido_total);
    const efectividadPct = baseEfectividad ? percent(partidas, baseEfectividad) : 0;
    const jornadaSegundos = getJornadaDisponibleSegundosPorFechas(fechas, 'SUCURSAL');
    const negadosExcedenLimite = excedeLimiteNegadosPenalizables(negadosPenalizables, Math.max(row.surtido_total, baseEfectividad));

    const desglose = {
      efectividad: {
        label: 'Efectividad individual diaria > 90%',
        peso: PESOS.SURTIDOR_SUCURSAL.efectividad,
        valor: round2(cumplimientoEfectividadRatio * 100),
        monto: montoPorCumplimiento(PESOS.SURTIDOR_SUCURSAL.efectividad, cumplimientoEfectividadRatio)
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
        dias_efectividad: row.dias,
        dias_evaluados: diasEvaluados,
        dias_cumplen_efectividad: diasCumplenEfectividad,
        cumplimiento_efectividad_dias_pct: round2(cumplimientoEfectividadRatio * 100),
        partidas_surtidas: partidas,
        ceros: toNumber(row.ceros),
        negados_capturados: toNumber(row.negados_capturados),
        surtido_total: toNumber(row.surtido_total),
        efectividad_pct: efectividadPct,
        efectividad_minima_requerida: `>${EFECTIVIDAD_MINIMA_PCT}% por día contra el total surtido de su rol`,
        tiempo_activo_segundos: toNumber(row.tiempo_activo_segundos),
        jornada_disponible_segundos: jornadaSegundos,
        partidas_por_hora_jornada: jornadaSegundos ? round2(partidas / (jornadaSegundos / 3600)) : 0,
        negados_pendientes: toNumber(row.negados_pendientes),
        negados_penalizables: negadosPenalizables,
        negados_no_penalizan: toNumber(row.negados_no_penalizan),
        negados_limite_excedido: negadosExcedenLimite,
        incidencias
      },
      desglose,
      bloqueos: buildBloqueos({
        negadosPendientes: row.negados_pendientes,
        incidencias,
        extra: negadosExcedenLimite ? [{
          codigo: 'NEGADOS_LIMITE_EXCEDIDO',
          message: 'Bono bloqueado por negados penalizables excedidos',
          cantidad: negadosPenalizables
        }] : []
      })
    });
  });
}

async function calcularChecadoresSucursal(desde, hasta, incidenciasMap) {
  const [partidasDiaRows] = await pool.query(
    `
    SELECT
      DATE_FORMAT(ps.fecha_operativa, '%Y-%m-%d') AS fecha,
      COALESCE(SUM(ps.partidas + ps.ceros + ps.no_surtido), 0) AS partidas_surtidores_sucursal
    FROM productividad_sesiones ps
    INNER JOIN surtidores s ON s.id = ps.surtidor_id
    INNER JOIN usuarios u ON u.id = s.usuario_id
    WHERE ps.estado = 'FINALIZADO'
      AND ps.tipo_operacion = 'SUCURSAL'
      AND ps.fecha_operativa BETWEEN ? AND ?
      AND s.activo = 1
      AND u.activo = 1
    GROUP BY ps.fecha_operativa
    `,
    [desde, hasta]
  );

  const partidasDiaMap = new Map(
    partidasDiaRows.map((row) => [row.fecha, toNumber(row.partidas_surtidores_sucursal)])
  );

  const [dailyRows] = await pool.query(
    `
    SELECT
      u.id AS usuario_id,
      u.nombre AS usuario_nombre,
      u.usuario,
      c.id AS checador_id,
      c.codigo_reporte,
      DATE_FORMAT(cr.fecha, '%Y-%m-%d') AS fecha,
      COUNT(*) AS salidas,
      COALESCE(SUM(cr.tp), 0) AS tp,
      COALESCE(SUM(cr.total), 0) AS total_importe
    FROM checadores_reportes cr
    INNER JOIN checadores c ON c.id = cr.checador_id
    INNER JOIN usuarios u ON u.id = c.usuario_id
    WHERE cr.fecha BETWEEN ? AND ?
      AND c.usuario_id IS NOT NULL
      AND c.activo = 1
      AND u.activo = 1
    GROUP BY u.id, u.nombre, u.usuario, c.id, c.codigo_reporte, cr.fecha
    ORDER BY u.nombre ASC, cr.fecha ASC
    `,
    [desde, hasta]
  );

  const checadoresPorDia = new Map();

  for (const row of dailyRows) {
    const fecha = row.fecha;
    if (!checadoresPorDia.has(fecha)) checadoresPorDia.set(fecha, new Set());
    checadoresPorDia.get(fecha).add(Number(row.checador_id));
  }

  const byUser = new Map();

  for (const row of dailyRows) {
    const usuarioId = Number(row.usuario_id);
    const fecha = row.fecha;
    const checadoresActivosDia = checadoresPorDia.get(fecha)?.size || 0;
    const partidasSucursalDia = partidasDiaMap.get(fecha) || 0;
    const metaDia = checadoresActivosDia ? partidasSucursalDia / checadoresActivosDia : 0;

    if (!byUser.has(usuarioId)) {
      byUser.set(usuarioId, {
        usuario_id: usuarioId,
        usuario_nombre: row.usuario_nombre,
        usuario: row.usuario,
        checador_id: row.checador_id,
        codigo_reporte: row.codigo_reporte,
        salidas: 0,
        tp: 0,
        total_importe: 0,
        meta_individual: 0,
        fechas: [],
        dias: []
      });
    }

    const item = byUser.get(usuarioId);

    item.salidas += toNumber(row.salidas);
    item.tp += toNumber(row.tp);
    item.total_importe += toNumber(row.total_importe);
    item.meta_individual += metaDia;
    item.fechas.push(fecha);
    item.dias.push({
      fecha,
      tp: toNumber(row.tp),
      salidas: toNumber(row.salidas),
      partidas_surtidores_sucursal_dia: round2(partidasSucursalDia),
      checadores_activos_dia: checadoresActivosDia,
      meta_dia: round2(metaDia),
      cumplimiento_dia_pct: metaDia ? percent(row.tp, metaDia) : 0
    });
  }

  const totalPartidasSucursal = [...partidasDiaMap.values()].reduce((acc, value) => acc + value, 0);

  return [...byUser.values()].map((row) => {
    const fechas = [...new Set(row.fechas)];
    const tp = toNumber(row.tp);
    const metaIndividual = toNumber(row.meta_individual);
    const productividadRatio = metaIndividual ? clamp01(tp / metaIndividual) : 0;
    const incidencias = getIncidenciasFor(incidenciasMap, row.usuario_id, 'CHECADOR_SUCURSAL');
    const tieneMalEmpaque = hasIncidencia(incidencias, 'MAL_EMPAQUE');
    const tieneFaltante = hasIncidencia(incidencias, 'FALTANTE_SOBRANTE');

    const desglose = {
      productividad: {
        label: 'TP contra meta diaria equitativa',
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
        dias: row.dias,
        salidas: toNumber(row.salidas),
        tp,
        total_importe: round2(row.total_importe),
        total_surtido_sucursales: round2(totalPartidasSucursal),
        total_partidas_surtidores_sucursal: round2(totalPartidasSucursal),
        meta_individual: round2(metaIndividual),
        cumplimiento_meta_pct: round2(productividadRatio * 100),
        regla_meta: 'Por cada día: total surtido por sucursales / checadores activos del día; la meta individual es la suma diaria.',
        incidencias
      },
      desglose,
      bloqueos: buildBloqueos({ incidencias })
    });
  });
}

async function calcularSurtidoresMayoreo(desde, hasta, incidenciasMap) {
  const [dailyRows] = await pool.query(
    `
    SELECT
      u.id AS usuario_id,
      u.nombre AS usuario_nombre,
      u.usuario,
      s.id AS surtidor_id,
      s.codigo AS surtidor_codigo,
      s.codigo_reporte,
      DATE_FORMAT(mrs.fecha, '%Y-%m-%d') AS fecha,
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
    GROUP BY u.id, u.nombre, u.usuario, s.id, s.codigo, s.codigo_reporte, mrs.fecha
    ORDER BY u.nombre ASC, mrs.fecha ASC
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

  const [negadosDailyRows] = await pool.query(
    `
    SELECT
      usuario_id,
      DATE_FORMAT(fecha_operativa, '%Y-%m-%d') AS fecha,
      COALESCE(SUM(CASE WHEN estado_revision = 'PENDIENTE_REVISION' THEN cantidad_negada ELSE 0 END), 0) AS negados_pendientes,
      COALESCE(SUM(CASE WHEN estado_revision = 'VALIDADO_NO_PENALIZA' THEN cantidad_negada ELSE 0 END), 0) AS negados_no_penalizan,
      COALESCE(SUM(CASE WHEN estado_revision = 'RECHAZADO_PENALIZA' THEN cantidad_negada ELSE 0 END), 0) AS negados_penalizables
    FROM productividad_sesion_negados
    WHERE tipo_operacion = 'MAYOREO'
      AND fecha_operativa BETWEEN ? AND ?
    GROUP BY usuario_id, fecha_operativa
    `,
    [desde, hasta]
  );

  const sesionesMap = new Map(sesionesRows.map((row) => [Number(row.usuario_id), row]));
  const negadosDailyMap = mapBy(
    negadosDailyRows,
    (row) => `${Number(row.usuario_id)}:${row.fecha}`
  );

  const byUser = new Map();

  for (const row of dailyRows) {
    const usuarioId = Number(row.usuario_id);
    const fecha = row.fecha;
    const negados = negadosDailyMap.get(`${usuarioId}:${fecha}`) || {};
    const partidasOficialesDia = toNumber(row.partidas_oficiales);
    const negadosPenalizablesDia = toNumber(negados.negados_penalizables);
    const partidasNetasDia = Math.max(0, partidasOficialesDia - negadosPenalizablesDia);
    const efectividadDiaPct = partidasOficialesDia ? percent(partidasNetasDia, partidasOficialesDia) : 0;
    const cumpleDia = cumpleEfectividadMinima(efectividadDiaPct);

    if (!byUser.has(usuarioId)) {
      const sesiones = sesionesMap.get(usuarioId) || {};

      byUser.set(usuarioId, {
        usuario_id: usuarioId,
        usuario_nombre: row.usuario_nombre,
        usuario: row.usuario,
        surtidor_id: row.surtidor_id,
        surtidor_codigo: row.surtidor_codigo,
        codigo_reporte: row.codigo_reporte,
        movimientos: 0,
        tickets: 0,
        partidas_oficiales: 0,
        partidas_netas: 0,
        neto: 0,
        negados_pendientes: 0,
        negados_no_penalizan: 0,
        negados_penalizables: 0,
        sesiones: toNumber(sesiones.sesiones),
        fechas_app: uniqueDatesFromCsv(sesiones.fechas),
        tiempo_activo_segundos: toNumber(sesiones.tiempo_activo_segundos),
        fechas_reporte: [],
        dias: []
      });
    }

    const item = byUser.get(usuarioId);

    item.movimientos += toNumber(row.movimientos);
    item.tickets += toNumber(row.tickets);
    item.partidas_oficiales += partidasOficialesDia;
    item.partidas_netas += partidasNetasDia;
    item.neto += toNumber(row.neto);
    item.negados_pendientes += toNumber(negados.negados_pendientes);
    item.negados_no_penalizan += toNumber(negados.negados_no_penalizan);
    item.negados_penalizables += negadosPenalizablesDia;
    item.fechas_reporte.push(fecha);
    item.dias.push({
      fecha,
      movimientos: toNumber(row.movimientos),
      tickets: toNumber(row.tickets),
      partidas_oficiales: partidasOficialesDia,
      partidas_netas: partidasNetasDia,
      negados_penalizables: negadosPenalizablesDia,
      neto: round2(row.neto),
      efectividad_pct: efectividadDiaPct,
      cumple_efectividad: cumpleDia
    });
  }

  const baseRows = [...byUser.values()].map((row) => {
    const fechasReporte = [...new Set(row.fechas_reporte)];
    const tiempoActivo = toNumber(row.tiempo_activo_segundos);
    const horasActivas = tiempoActivo / 3600;
    const jornadaReporteSegundos = fechasReporte.length * SEGUNDOS_JORNADA_COMPLETA;
    const horasReporte = jornadaReporteSegundos / 3600;
    const modoProductividad = tiempoActivo > 0 ? 'APP_TIEMPO_REAL' : 'REPORTE_JORNADA';
    const partidasHoraActiva = horasActivas ? row.partidas_netas / horasActivas : 0;
    const partidasHoraReporte = horasReporte ? row.partidas_netas / horasReporte : 0;
    const diasEvaluados = row.dias.length;
    const diasCumplenEfectividad = row.dias.filter((dia) => dia.cumple_efectividad).length;
    const cumplimientoEfectividadRatio = diasEvaluados ? diasCumplenEfectividad / diasEvaluados : 0;
    const efectividadPct = row.partidas_oficiales ? percent(row.partidas_netas, row.partidas_oficiales) : 0;

    return {
      ...row,
      fechas_reporte: fechasReporte,
      jornada_reporte_segundos: jornadaReporteSegundos,
      horas_activas: horasActivas,
      horas_reporte: horasReporte,
      modo_productividad: modoProductividad,
      efectividad_pct: efectividadPct,
      dias_evaluados: diasEvaluados,
      dias_cumplen_efectividad: diasCumplenEfectividad,
      cumplimiento_efectividad_ratio: cumplimientoEfectividadRatio,
      cumplimiento_efectividad_dias_pct: round2(cumplimientoEfectividadRatio * 100),
      negados_limite_excedido: excedeLimiteNegadosPenalizables(row.negados_penalizables, row.partidas_oficiales),
      partidas_netas_por_hora_activa: partidasHoraActiva,
      partidas_netas_por_hora_reporte: partidasHoraReporte,
      partidas_netas_por_hora_calculo: modoProductividad === 'APP_TIEMPO_REAL' ? partidasHoraActiva : partidasHoraReporte
    };
  });

  const maxPartidasNetas = Math.max(...baseRows.map((row) => row.partidas_netas), 0);
  const maxPartidasHora = Math.max(...baseRows.map((row) => row.partidas_netas_por_hora_calculo), 0);
  const maxTickets = Math.max(...baseRows.map((row) => toNumber(row.tickets)), 0);
  const maxNeto = Math.max(...baseRows.map((row) => toNumber(row.neto)), 0);

  return baseRows.map((row) => {
    const incidencias = getIncidenciasFor(incidenciasMap, row.usuario_id, 'SURTIDOR_MAYOREO');
    const efectividadRatio = clamp01(row.cumplimiento_efectividad_ratio);

    const desglose = {
      partidas_netas: {
        label: 'Partidas netas con efectividad diaria > 90%',
        peso: PESOS.SURTIDOR_MAYOREO.partidas_netas,
        valor: row.partidas_netas,
        monto: maxPartidasNetas ? round2(PESOS.SURTIDOR_MAYOREO.partidas_netas * clamp01(row.partidas_netas / maxPartidasNetas) * efectividadRatio) : 0
      },
      partidas_hora: {
        label: row.modo_productividad === 'APP_TIEMPO_REAL' ? 'Partidas netas / hora activa' : 'Partidas netas / jornada reporte',
        peso: PESOS.SURTIDOR_MAYOREO.partidas_hora,
        valor: round2(row.partidas_netas_por_hora_calculo),
        monto: maxPartidasHora ? round2(PESOS.SURTIDOR_MAYOREO.partidas_hora * clamp01(row.partidas_netas_por_hora_calculo / maxPartidasHora) * efectividadRatio) : 0
      },
      tickets: {
        label: 'Tickets con efectividad diaria > 90%',
        peso: PESOS.SURTIDOR_MAYOREO.tickets,
        valor: toNumber(row.tickets),
        monto: maxTickets ? round2(PESOS.SURTIDOR_MAYOREO.tickets * clamp01(toNumber(row.tickets) / maxTickets) * efectividadRatio) : 0
      },
      neto: {
        label: 'Neto con efectividad diaria > 90%',
        peso: PESOS.SURTIDOR_MAYOREO.neto,
        valor: round2(row.neto),
        monto: maxNeto ? round2(PESOS.SURTIDOR_MAYOREO.neto * clamp01(toNumber(row.neto) / maxNeto) * efectividadRatio) : 0
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
        efectividad_pct: row.efectividad_pct,
        efectividad_minima_requerida: `>${EFECTIVIDAD_MINIMA_PCT}% por día`,
        dias_efectividad: row.dias,
        dias_evaluados: row.dias_evaluados,
        dias_cumplen_efectividad: row.dias_cumplen_efectividad,
        cumplimiento_efectividad_dias_pct: row.cumplimiento_efectividad_dias_pct,
        negados_penalizables: row.negados_penalizables,
        negados_no_penalizan: row.negados_no_penalizan,
        negados_pendientes: row.negados_pendientes,
        negados_limite_excedido: row.negados_limite_excedido,
        partidas_netas: row.partidas_netas,
        neto: round2(row.neto),
        sesiones: row.sesiones,
        tiempo_activo_segundos: row.tiempo_activo_segundos,
        jornada_reporte_segundos: row.jornada_reporte_segundos,
        modo_productividad: row.modo_productividad,
        partidas_netas_por_hora_activa: round2(row.partidas_netas_por_hora_activa),
        partidas_netas_por_hora_reporte: round2(row.partidas_netas_por_hora_reporte),
        partidas_netas_por_hora_calculo: round2(row.partidas_netas_por_hora_calculo),
        referencias_equipo: {
          max_partidas_netas: maxPartidasNetas,
          max_partidas_hora_calculo: round2(maxPartidasHora),
          max_tickets: maxTickets,
          max_neto: round2(maxNeto)
        },
        incidencias
      },
      desglose,
      bloqueos: buildBloqueos({
        negadosPendientes: row.negados_pendientes,
        incidencias,
        extra: row.negados_limite_excedido ? [{
          codigo: 'NEGADOS_LIMITE_EXCEDIDO',
          message: 'Bono bloqueado por negados penalizables excedidos',
          cantidad: row.negados_penalizables
        }] : []
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
      return item.usuario_id !== row.usuario_id && comisionAplicaAEquipo(item, tiposEquipo);
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
    "DELETE FROM comisiones_individuales WHERE periodo_id = ? AND estado = 'BORRADOR'",
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

async function calcularComisionesData(desde, hasta) {
  const incidencias = await getIncidenciasActivas(desde, hasta);
  const incidenciasMap = mapIncidencias(incidencias);

  const surtidoresSucursal = await calcularSurtidoresSucursal(desde, hasta, incidenciasMap);
  const checadoresSucursal = await calcularChecadoresSucursal(desde, hasta, incidenciasMap);
  const surtidoresMayoreo = await calcularSurtidoresMayoreo(desde, hasta, incidenciasMap);

  const componentesOperativos = [
    ...surtidoresSucursal,
    ...checadoresSucursal,
    ...surtidoresMayoreo
  ];

  /*
    La comisión de encargado se evalúa contra el equipo ya fusionado para contar
    personas y no roles duplicados. Después se vuelve a fusionar con los rubros
    propios del usuario encargado para respetar el tope único de $2,000.
  */
  const baseEquipo = fusionarComisionesOperativas(componentesOperativos);
  const encargados = await calcularEncargados(incidenciasMap, baseEquipo);
  const comisiones = fusionarComisionesOperativas([
    ...componentesOperativos,
    ...encargados
  ]);

  const resumen = normalizeResumen(buildResumen(comisiones));

  return {
    resumen,
    comisiones
  };
}

export const calcularComisiones = asyncHandler(async (req, res) => {
  const payload = {
    ...req.query,
    ...req.body
  };

  const { desde, hasta } = getDateFilters(payload);
  const dryRun = payload.dry_run === false || payload.dry_run === 'false' ? false : true;
  const motivo = String(payload.motivo || '').trim();

  const { resumen, comisiones } = await calcularComisionesData(desde, hasta);

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
      checadores_meta: 'por día: total_surtido_sucursales_día / checadores_activos_día; la meta individual es la suma diaria',
      mayoreo_partidas_netas: 'partidas_oficiales - negados_penalizables',
      usuario_mixto: 'todas las funciones del mismo usuario se fusionan en una sola comisión con tope de $2,000; si tiene encargado se fusiona con su rol operativo',
      efectividad_minima: `surtidores sucursal y mayoreo requieren más de ${EFECTIVIDAD_MINIMA_PCT}% de efectividad individual por día para ganar la parte de productividad/efectividad`,
      bloqueos_automaticos: 'inasistencia injustificada, mal empaque o negados penalizables excedidos dejan el bono en $0',
      encargado: 'comisiona si más del 50% del equipo combinado comisiona'
    },
    resumen,
    comisiones
  });
});



function getBloqueosTexto(bloqueos = []) {
  if (!Array.isArray(bloqueos) || !bloqueos.length) return '';

  return bloqueos
    .map((bloqueo) => bloqueo.message || bloqueo.codigo)
    .filter(Boolean)
    .join(' | ');
}

function isFusionada(item) {
  return item?.tipo_comision === 'OPERATIVO_FUSIONADO';
}

function getFusionComponents(item) {
  return Array.isArray(item?.metricas?.componentes) ? item.metricas.componentes : [];
}

function getComponentByTipo(item, tipoComision) {
  return getFusionComponents(item).find((component) => component.tipo_comision === tipoComision) || null;
}

function getMetricValue(item, key, fallback = 0) {
  return toNumber(item?.metricas?.[key] ?? fallback);
}

function getComponentMetric(item, tipoComision, key, fallback = 0) {
  const component = getComponentByTipo(item, tipoComision);
  return toNumber(component?.metricas?.[key] ?? fallback);
}

function getComponentMonto(item, tipoComision) {
  const component = getComponentByTipo(item, tipoComision);
  return toNumber(component?.aportacion_bono ?? 0);
}

function getDirectDesgloseMonto(item, key) {
  return toNumber(item?.desglose?.[key]?.monto);
}

function getDesgloseMonto(item, key, tipoComision = null) {
  if (!isFusionada(item)) return getDirectDesgloseMonto(item, key);

  const component = getComponentByTipo(item, tipoComision);
  return toNumber(component?.desglose_original?.[key]?.monto);
}

function getMontoComponente(item, tipos = []) {
  if (!isFusionada(item)) return 0;

  return getFusionComponents(item).reduce((acc, component) => {
    return tipos.includes(component.tipo_comision)
      ? acc + toNumber(component.aportacion_bono)
      : acc;
  }, 0);
}

function buildReglasExportRows() {
  return [
    { Tipo: 'SURTIDOR_MAYOREO', Rubro: 'Partidas netas', Peso: 800, Regla: '40% del bono. Usa partidas_netas = partidas_oficiales - negados_penalizables. El día debe superar 90% de efectividad individual para aportar a productividad.' },
    { Tipo: 'SURTIDOR_MAYOREO', Rubro: 'Partidas/hora', Peso: 400, Regla: '20% del bono. Si viene desde reporte, se acumula por día y se divide entre 8 horas. No usa HrReg.' },
    { Tipo: 'SURTIDOR_MAYOREO', Rubro: 'Tickets', Peso: 200, Regla: '10% del bono. Se toma del reporte oficial de mayoreo.' },
    { Tipo: 'SURTIDOR_MAYOREO', Rubro: 'Neto', Peso: 100, Regla: '5% del bono. Se toma del reporte oficial de mayoreo.' },
    { Tipo: 'SURTIDOR_MAYOREO', Rubro: 'Negados', Peso: 300, Regla: '15% del bono. Si hay negados penalizables excedidos, el bono completo queda en $0. El porcentaje no se muestra visualmente.' },
    { Tipo: 'SURTIDOR_MAYOREO', Rubro: 'Asistencia', Peso: 200, Regla: '10% del bono. Cumple por defecto salvo incidencia de asistencia/inasistencia injustificada.' },

    { Tipo: 'SURTIDOR_SUCURSAL', Rubro: 'Efectividad', Peso: 800, Regla: '40% del bono. Efectividad individual diaria contra el total surtido de su rol. Debe ser mayor a 90%.' },
    { Tipo: 'SURTIDOR_SUCURSAL', Rubro: 'No surtido', Peso: 300, Regla: '15% del bono. Si tiene negados penalizables, pierde el rubro; si exceden el límite operativo, el bono completo queda en $0.' },
    { Tipo: 'SURTIDOR_SUCURSAL', Rubro: 'Asistencia', Peso: 600, Regla: '30% del bono. Cumple por defecto salvo incidencia.' },
    { Tipo: 'SURTIDOR_SUCURSAL', Rubro: 'Orden / limpieza', Peso: 200, Regla: '10% del bono. Cumple por defecto salvo incidencia.' },
    { Tipo: 'SURTIDOR_SUCURSAL', Rubro: 'Puntualidad', Peso: 100, Regla: '5% del bono. Cumple por defecto salvo incidencia.' },

    { Tipo: 'CHECADOR_SUCURSAL', Rubro: 'Partidas / TP', Peso: 1000, Regla: '50% del bono. La meta diaria es el total surtido por sucursales dividido equitativamente entre checadores activos del día.' },
    { Tipo: 'CHECADOR_SUCURSAL', Rubro: 'Mal empaque', Peso: 300, Regla: '15% del bono. Cumple por defecto; si hay incidencia de mal empaque, el bono completo queda en $0.' },
    { Tipo: 'CHECADOR_SUCURSAL', Rubro: 'Faltante / sobrante', Peso: 200, Regla: '10% del bono. Cumple por defecto salvo incidencia.' },
    { Tipo: 'CHECADOR_SUCURSAL', Rubro: 'Asistencia', Peso: 400, Regla: '20% del bono. Cumple por defecto salvo incidencia.' },
    { Tipo: 'CHECADOR_SUCURSAL', Rubro: 'Orden', Peso: 100, Regla: '5% del bono. Cumple por defecto salvo incidencia.' },

    { Tipo: 'OPERATIVO_FUSIONADO', Rubro: 'Bono fusionado', Peso: 2000, Regla: 'No cobra doble. El bono se reparte en escala entre las funciones del mismo usuario y respeta tope único de $2,000.' },
    { Tipo: 'ENCARGADO', Rubro: 'Mayoría de equipo combinado', Peso: 2000, Regla: 'Comisiona si más del 50% de su equipo combinado comisiona. Si el encargado tiene otro rol, se fusiona con ese rol y respeta tope único.' }
  ];
}

function buildComisionesExportRows(comisiones = []) {
  return comisiones.map((item) => {
    const esFusionado = isFusionada(item);
    const bloqueos = getBloqueosTexto(item.bloqueos);

    return {
      Usuario: item.usuario_nombre || '',
      Código: item.usuario || '',
      Tipo: item.tipo_comision || '',
      Estado: item.bloqueado ? 'BLOQUEADO' : item.comisiona ? 'COMISIONA' : 'NO_COMISIONA',
      'Bono máximo': BASE_COMISION,
      'Proceso bono': toNumber(item.monto_acumulado),
      'Monto final': toNumber(item.monto_final),
      'Bloqueos': bloqueos,

      'Aporte surtidor sucursal': esFusionado ? getComponentMonto(item, 'SURTIDOR_SUCURSAL') : item.tipo_comision === 'SURTIDOR_SUCURSAL' ? toNumber(item.monto_acumulado) : 0,
      'Aporte checador sucursal': esFusionado ? getComponentMonto(item, 'CHECADOR_SUCURSAL') : item.tipo_comision === 'CHECADOR_SUCURSAL' ? toNumber(item.monto_acumulado) : 0,
      'Aporte surtidor mayoreo': esFusionado ? getComponentMonto(item, 'SURTIDOR_MAYOREO') : item.tipo_comision === 'SURTIDOR_MAYOREO' ? toNumber(item.monto_acumulado) : 0,
      'Aporte encargado': esFusionado ? getComponentMonto(item, 'ENCARGADO') : item.tipo_comision === 'ENCARGADO' ? toNumber(item.monto_acumulado) : 0,

      'Sucursal partidas': esFusionado ? getComponentMetric(item, 'SURTIDOR_SUCURSAL', 'partidas_surtidas') : getMetricValue(item, 'partidas_surtidas'),
      'Sucursal surtido total rol': esFusionado ? getComponentMetric(item, 'SURTIDOR_SUCURSAL', 'surtido_total') : getMetricValue(item, 'surtido_total'),
      'Sucursal días cumplen': esFusionado ? getComponentMetric(item, 'SURTIDOR_SUCURSAL', 'dias_cumplen_efectividad') : getMetricValue(item, 'dias_cumplen_efectividad'),
      'Sucursal días evaluados': esFusionado ? getComponentMetric(item, 'SURTIDOR_SUCURSAL', 'dias_evaluados') : getMetricValue(item, 'dias_evaluados'),

      'Mayoreo partidas oficiales': esFusionado ? getComponentMetric(item, 'SURTIDOR_MAYOREO', 'partidas_oficiales') : getMetricValue(item, 'partidas_oficiales'),
      'Mayoreo partidas netas': esFusionado ? getComponentMetric(item, 'SURTIDOR_MAYOREO', 'partidas_netas') : getMetricValue(item, 'partidas_netas'),
      'Mayoreo partidas/h cálculo': esFusionado ? getComponentMetric(item, 'SURTIDOR_MAYOREO', 'partidas_netas_por_hora_calculo') : getMetricValue(item, 'partidas_netas_por_hora_calculo'),
      'Mayoreo tickets': esFusionado ? getComponentMetric(item, 'SURTIDOR_MAYOREO', 'tickets') : getMetricValue(item, 'tickets'),
      'Mayoreo neto': esFusionado ? getComponentMetric(item, 'SURTIDOR_MAYOREO', 'neto') : getMetricValue(item, 'neto'),

      'Checador TP': esFusionado ? getComponentMetric(item, 'CHECADOR_SUCURSAL', 'tp') : getMetricValue(item, 'tp'),
      'Checador meta': esFusionado ? getComponentMetric(item, 'CHECADOR_SUCURSAL', 'meta_individual') : getMetricValue(item, 'meta_individual'),
      'Checador cumplimiento %': esFusionado ? getComponentMetric(item, 'CHECADOR_SUCURSAL', 'cumplimiento_meta_pct') : getMetricValue(item, 'cumplimiento_meta_pct'),

      'Negados penalizables': esFusionado
        ? getFusionComponents(item).reduce((acc, component) => acc + toNumber(component.metricas?.negados_penalizables), 0)
        : getMetricValue(item, 'negados_penalizables'),
      'Negados pendientes': esFusionado
        ? getFusionComponents(item).reduce((acc, component) => acc + toNumber(component.metricas?.negados_pendientes), 0)
        : getMetricValue(item, 'negados_pendientes')
    };
  });
}

function buildDesgloseExportRows(comisiones = []) {
  const rows = [];

  for (const item of comisiones) {
    if (isFusionada(item)) {
      for (const component of getFusionComponents(item)) {
        rows.push({
          Usuario: item.usuario_nombre || '',
          Código: item.usuario || '',
          Tipo: item.tipo_comision || '',
          Componente: component.tipo_comision,
          Rubro: 'Aporte escalado del componente',
          Peso: toNumber(component.peso ?? item.metricas?.peso_por_rubro),
          Valor: toNumber(component.cumplimiento_pct),
          Monto: toNumber(component.aportacion_bono),
          Bloqueado: component.bloqueado ? 'SI' : 'NO',
          Nota: 'Este monto es la aportación escalada dentro del bono fusionado, no un bono adicional.'
        });

        for (const [clave, rubro] of Object.entries(component.desglose_original || {})) {
          rows.push({
            Usuario: item.usuario_nombre || '',
            Código: item.usuario || '',
            Tipo: item.tipo_comision || '',
            Componente: component.tipo_comision,
            Rubro: rubro.label || clave,
            Peso: toNumber(rubro.peso),
            Valor: toNumber(rubro.valor),
            Monto: toNumber(rubro.monto),
            Bloqueado: rubro.bloqueado ? 'SI' : 'NO',
            Nota: 'Desglose original del componente antes de escalar al bono fusionado.'
          });
        }
      }

      continue;
    }

    for (const [clave, rubro] of Object.entries(item.desglose || {})) {
      rows.push({
        Usuario: item.usuario_nombre || '',
        Código: item.usuario || '',
        Tipo: item.tipo_comision || '',
        Componente: item.tipo_comision || '',
        Rubro: rubro.label || clave,
        Peso: toNumber(rubro.peso),
        Valor: toNumber(rubro.valor),
        Monto: toNumber(rubro.monto),
        Bloqueado: rubro.bloqueado ? 'SI' : 'NO',
        Nota: ''
      });
    }
  }

  return rows;
}

function pushDiasRows(rows, item, tipo, dias = []) {
  for (const dia of dias) {
    rows.push({
      Usuario: item.usuario_nombre || '',
      Código: item.usuario || '',
      Tipo: item.tipo_comision || '',
      Componente: tipo || item.tipo_comision || '',
      Fecha: dia.fecha || '',
      'Surtido total rol': toNumber(dia.total_surtido_rol ?? dia.surtido_total ?? 0),
      'Partidas / TP': toNumber(dia.partidas_surtidas ?? dia.partidas_oficiales ?? dia.tp ?? 0),
      'Partidas netas': toNumber(dia.partidas_netas ?? 0),
      'Negados penalizables': toNumber(dia.negados_penalizables ?? 0),
      'Meta día': toNumber(dia.meta_dia ?? 0),
      'Surtido sucursales día': toNumber(dia.surtido_sucursales_dia ?? dia.partidas_surtidores_sucursal_dia ?? 0),
      'Checadores activos día': toNumber(dia.checadores_activos_dia ?? 0),
      'Cumple efectividad': dia.cumple_efectividad === undefined ? '' : dia.cumple_efectividad ? 'SI' : 'NO',
      'Cumplimiento día %': toNumber(dia.cumplimiento_dia_pct ?? dia.efectividad_pct ?? 0),
      'Tickets día': toNumber(dia.tickets ?? 0),
      'Neto día': toNumber(dia.neto ?? 0)
    });
  }
}

function buildDiasExportRows(comisiones = []) {
  const rows = [];

  for (const item of comisiones) {
    if (isFusionada(item)) {
      for (const component of getFusionComponents(item)) {
        const dias = component.metricas?.dias_efectividad || component.metricas?.dias || [];
        pushDiasRows(rows, item, component.tipo_comision, dias);
      }

      continue;
    }

    const dias = item.metricas?.dias_efectividad || item.metricas?.dias || [];
    pushDiasRows(rows, item, item.tipo_comision, dias);
  }

  return rows;
}

function appendSheet(workbook, name, rows) {
  const safeRows = rows.length ? rows : [{ Información: 'Sin datos' }];
  const sheet = XLSX.utils.json_to_sheet(safeRows);
  XLSX.utils.book_append_sheet(workbook, sheet, name.slice(0, 31));
}

export const exportarComisionesExcel = asyncHandler(async (req, res) => {
  const { desde, hasta } = getDateFilters(req.query);
  const { resumen, comisiones } = await calcularComisionesData(desde, hasta);

  const workbook = XLSX.utils.book_new();

  appendSheet(workbook, 'Resumen', [{
    Desde: desde,
    Hasta: hasta,
    Registros: resumen.total_registros,
    Comisionan: resumen.comisionan,
    Bloqueados: resumen.bloqueados,
    'Monto final': resumen.total_monto_final,
    Nota: 'El monto final ya respeta bloqueos y tope único de $2,000 por usuario.'
  }]);

  appendSheet(workbook, 'Reglas', buildReglasExportRows());
  appendSheet(workbook, 'Comisiones', buildComisionesExportRows(comisiones));
  appendSheet(workbook, 'Desglose', buildDesgloseExportRows(comisiones));
  appendSheet(workbook, 'Diario', buildDiasExportRows(comisiones));

  const buffer = XLSX.write(workbook, {
    type: 'buffer',
    bookType: 'xlsx'
  });

  const filename = `comisiones_${desde}_${hasta}.xlsx`;

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
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
