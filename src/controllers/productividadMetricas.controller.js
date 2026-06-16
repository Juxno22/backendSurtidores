import { pool } from '../config/db.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { diffSecondsLocal, getNowMexicoDateTime } from '../utils/mexicoTime.js';
import {
  calcularAprovechamientoTurno,
  calcularPartidasPorHoraLaboral,
  getJornadaLaboral,
  getJornadaTranscurridaSegundos,
  getSegundosLaboralesEntre
} from '../utils/jornadaLaboral.js';

function validarFecha(fecha, fieldName = 'fecha') {
  const value = String(fecha || '').trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const error = new Error(`${fieldName} debe tener formato YYYY-MM-DD`);
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

function toNumber(value) {
  return Number(value || 0);
}

function secondsToHours(seconds) {
  return round2(toNumber(seconds) / 3600);
}

function secondsToMinutes(seconds) {
  return round2(toNumber(seconds) / 60);
}

function safePct(value, total) {
  const n = toNumber(value);
  const t = toNumber(total);

  if (!t) return 0;

  return round2((n / t) * 100);
}

function normalizeDateTime(value) {
  if (!value) return null;

  return String(value)
    .replace('T', ' ')
    .replace('.000Z', '')
    .slice(0, 19);
}

function getHourLabel(dateTime) {
  const normalized = normalizeDateTime(dateTime);

  if (!normalized || normalized.length < 13) return 'SIN HORA';

  return `${normalized.slice(11, 13)}:00`;
}

function buildEmptyBucket(hora) {
  return {
    hora,
    sesiones: 0,
    surtido_total: 0,
    partidas_surtidas: 0,
    ceros: 0,
    negados: 0,
    tiempo_activo_laboral_segundos: 0,
    tiempo_activo_laboral_minutos: 0,
    tiempo_muerto_laboral_segundos: 0,
    tiempo_muerto_laboral_minutos: 0,
    partidas_por_hora_laboral: 0
  };
}

function addToMap(map, key, patch) {
  if (!map.has(key)) {
    map.set(key, buildEmptyBucket(key));
  }

  const target = map.get(key);

  for (const [field, value] of Object.entries(patch)) {
    target[field] = toNumber(target[field]) + toNumber(value);
  }
}

function buildSessionMetrics(row, nowMexico) {
  const estado = String(row.estado || '');
  const horaInicio = normalizeDateTime(row.hora_inicio);
  const horaFin = estado === 'FINALIZADO'
    ? normalizeDateTime(row.hora_fin)
    : nowMexico;

  const duracionRealSegundos = estado === 'FINALIZADO'
    ? toNumber(row.duracion_segundos)
    : diffSecondsLocal(horaInicio, horaFin);

  const duracionLaboralSegundos = estado === 'FINALIZADO'
    ? toNumber(row.duracion_laboral_segundos)
    : getSegundosLaboralesEntre(horaInicio, horaFin);

  const partidasSurtidas = toNumber(row.partidas);
  const ceros = toNumber(row.ceros);
  const negados = toNumber(row.no_surtido);
  const surtidoTotal = partidasSurtidas + ceros + negados;

  return {
    ...row,
    hora_inicio: horaInicio,
    hora_fin: normalizeDateTime(row.hora_fin),
    updated_at: normalizeDateTime(row.updated_at),
    partidas_surtidas: partidasSurtidas,
    negados,
    surtido_total: surtidoTotal,
    tickets: surtidoTotal,
    duracion_segundos_calculada: duracionRealSegundos,
    duracion_laboral_segundos_calculada: duracionLaboralSegundos
  };
}

function buildResumenFromTotals({
  fecha,
  jornada,
  nowMexico,
  sesiones,
  reporteTotal
}) {
  const surtidoresActivos = new Set(sesiones.map((s) => Number(s.surtidor_id))).size;
  const sesionesFinalizadas = sesiones.filter((s) => s.estado === 'FINALIZADO').length;
  const sesionesEnProceso = sesiones.filter((s) => s.estado === 'EN_PROCESO').length;

  const jornadaTranscurridaSegundos = getJornadaTranscurridaSegundos(fecha, nowMexico);
  const jornadaTotalSegundos = toNumber(jornada.minutos_netos) * 60;
  const jornadaDisponibleEquipoSegundos = jornadaTranscurridaSegundos * surtidoresActivos;

  const total = sesiones.reduce((acc, sesion) => {
    acc.surtido_total += sesion.surtido_total;
    acc.partidas_surtidas += sesion.partidas_surtidas;
    acc.ceros += toNumber(sesion.ceros);
    acc.negados += sesion.negados;
    acc.duracion_real_segundos += sesion.duracion_segundos_calculada;
    acc.tiempo_activo_laboral_segundos += sesion.duracion_laboral_segundos_calculada;

    return acc;
  }, {
    surtido_total: 0,
    partidas_surtidas: 0,
    ceros: 0,
    negados: 0,
    duracion_real_segundos: 0,
    tiempo_activo_laboral_segundos: 0
  });

  const tiempoMuertoEquipoSegundos = Math.max(
    0,
    jornadaDisponibleEquipoSegundos - total.tiempo_activo_laboral_segundos
  );

  const esperadoEquipo = surtidoresActivos > 0
    ? {
        surtido_total_por_surtidor: round2(toNumber(reporteTotal.surtido_total) / surtidoresActivos),
        partidas_surtidas_por_surtidor: round2(toNumber(reporteTotal.partidas_surtidas) / surtidoresActivos),
        ceros_por_surtidor: round2(toNumber(reporteTotal.ceros) / surtidoresActivos),
        negados_por_surtidor: round2(toNumber(reporteTotal.negados) / surtidoresActivos)
      }
    : {
        surtido_total_por_surtidor: 0,
        partidas_surtidas_por_surtidor: 0,
        ceros_por_surtidor: 0,
        negados_por_surtidor: 0
      };

  return {
    fecha,
    now_mexico: nowMexico,
    jornada: {
      ...jornada,
      jornada_total_segundos: jornadaTotalSegundos,
      jornada_total_horas: secondsToHours(jornadaTotalSegundos),
      jornada_transcurrida_segundos: jornadaTranscurridaSegundos,
      jornada_transcurrida_horas: secondsToHours(jornadaTranscurridaSegundos),
      jornada_disponible_equipo_segundos: jornadaDisponibleEquipoSegundos,
      jornada_disponible_equipo_horas: secondsToHours(jornadaDisponibleEquipoSegundos)
    },
    sesiones_finalizadas: sesionesFinalizadas,
    sesiones_en_proceso: sesionesEnProceso,
    surtidores_activos: surtidoresActivos,

    surtido_total: total.surtido_total,
    partidas_surtidas: total.partidas_surtidas,
    ceros: total.ceros,
    negados: total.negados,

    duracion_real_segundos: total.duracion_real_segundos,
    duracion_real_minutos: secondsToMinutes(total.duracion_real_segundos),
    duracion_real_horas: secondsToHours(total.duracion_real_segundos),

    tiempo_activo_laboral_segundos: total.tiempo_activo_laboral_segundos,
    tiempo_activo_laboral_minutos: secondsToMinutes(total.tiempo_activo_laboral_segundos),
    tiempo_activo_laboral_horas: secondsToHours(total.tiempo_activo_laboral_segundos),

    tiempo_muerto_laboral_segundos: tiempoMuertoEquipoSegundos,
    tiempo_muerto_laboral_minutos: secondsToMinutes(tiempoMuertoEquipoSegundos),
    tiempo_muerto_laboral_horas: secondsToHours(tiempoMuertoEquipoSegundos),

    aprovechamiento_turno_pct: calcularAprovechamientoTurno({
      tiempoActivoSegundos: total.tiempo_activo_laboral_segundos,
      jornadaTranscurridaSegundos: jornadaDisponibleEquipoSegundos
    }),

    partidas_por_hora_laboral: calcularPartidasPorHoraLaboral({
      partidasSurtidas: total.partidas_surtidas,
      segundosLaborales: jornadaDisponibleEquipoSegundos
    }),

    partidas_por_hora_activa: calcularPartidasPorHoraLaboral({
      partidasSurtidas: total.partidas_surtidas,
      segundosLaborales: total.tiempo_activo_laboral_segundos
    }),

    reporte_grupal: reporteTotal,
    esperado_equipo: esperadoEquipo
  };
}

function buildSurtidores({ sesiones, resumen }) {
  const map = new Map();
  const jornadaTranscurridaSegundos = resumen.jornada.jornada_transcurrida_segundos;
  const esperadoPartidas = resumen.esperado_equipo.partidas_surtidas_por_surtidor;
  const esperadoSurtido = resumen.esperado_equipo.surtido_total_por_surtidor;

  for (const sesion of sesiones) {
    const key = Number(sesion.surtidor_id);

    if (!map.has(key)) {
      map.set(key, {
        surtidor_id: key,
        surtidor_nombre: sesion.surtidor_nombre,
        surtidor_usuario: sesion.surtidor_usuario,
        surtidor_codigo: sesion.surtidor_codigo,
        sesiones: 0,
        sesiones_finalizadas: 0,
        sesiones_en_proceso: 0,
        sucursales_surtidas: new Set(),
        surtido_total: 0,
        partidas_surtidas: 0,
        ceros: 0,
        negados: 0,
        duracion_real_segundos: 0,
        tiempo_activo_laboral_segundos: 0
      });
    }

    const item = map.get(key);

    item.sesiones += 1;
    item.sesiones_finalizadas += sesion.estado === 'FINALIZADO' ? 1 : 0;
    item.sesiones_en_proceso += sesion.estado === 'EN_PROCESO' ? 1 : 0;
    item.sucursales_surtidas.add(Number(sesion.sucursal_id));
    item.surtido_total += sesion.surtido_total;
    item.partidas_surtidas += sesion.partidas_surtidas;
    item.ceros += toNumber(sesion.ceros);
    item.negados += sesion.negados;
    item.duracion_real_segundos += sesion.duracion_segundos_calculada;
    item.tiempo_activo_laboral_segundos += sesion.duracion_laboral_segundos_calculada;
  }

  return Array.from(map.values())
    .map((item) => {
      const tiempoMuerto = Math.max(0, jornadaTranscurridaSegundos - item.tiempo_activo_laboral_segundos);

      return {
        ...item,
        sucursales_surtidas: item.sucursales_surtidas.size,
        duracion_real_minutos: secondsToMinutes(item.duracion_real_segundos),
        duracion_real_horas: secondsToHours(item.duracion_real_segundos),
        tiempo_activo_laboral_minutos: secondsToMinutes(item.tiempo_activo_laboral_segundos),
        tiempo_activo_laboral_horas: secondsToHours(item.tiempo_activo_laboral_segundos),
        tiempo_muerto_laboral_segundos: tiempoMuerto,
        tiempo_muerto_laboral_minutos: secondsToMinutes(tiempoMuerto),
        tiempo_muerto_laboral_horas: secondsToHours(tiempoMuerto),
        aprovechamiento_turno_pct: calcularAprovechamientoTurno({
          tiempoActivoSegundos: item.tiempo_activo_laboral_segundos,
          jornadaTranscurridaSegundos
        }),
        partidas_por_hora_laboral: calcularPartidasPorHoraLaboral({
          partidasSurtidas: item.partidas_surtidas,
          segundosLaborales: jornadaTranscurridaSegundos
        }),
        partidas_por_hora_activa: calcularPartidasPorHoraLaboral({
          partidasSurtidas: item.partidas_surtidas,
          segundosLaborales: item.tiempo_activo_laboral_segundos
        }),
        participacion_partidas_pct: safePct(item.partidas_surtidas, resumen.partidas_surtidas),
        participacion_surtido_pct: safePct(item.surtido_total, resumen.surtido_total),
        esperado_partidas_surtidas: esperadoPartidas,
        esperado_surtido_total: esperadoSurtido,
        diferencia_partidas_vs_esperado: round2(item.partidas_surtidas - esperadoPartidas),
        diferencia_surtido_vs_esperado: round2(item.surtido_total - esperadoSurtido),
        cumplimiento_partidas_vs_esperado_pct: safePct(item.partidas_surtidas, esperadoPartidas),
        cumplimiento_surtido_vs_esperado_pct: safePct(item.surtido_total, esperadoSurtido)
      };
    })
    .sort((a, b) => b.partidas_por_hora_laboral - a.partidas_por_hora_laboral || b.partidas_surtidas - a.partidas_surtidas);
}

function buildHorasPico({ sesiones }) {
  const surtidoMap = new Map();
  const muertoMap = new Map();
  const sesionesBySurtidor = new Map();

  for (const sesion of sesiones) {
    const hourKey = getHourLabel(sesion.hora_fin || sesion.updated_at || sesion.hora_inicio);

    addToMap(surtidoMap, hourKey, {
      sesiones: 1,
      surtido_total: sesion.surtido_total,
      partidas_surtidas: sesion.partidas_surtidas,
      ceros: sesion.ceros,
      negados: sesion.negados,
      tiempo_activo_laboral_segundos: sesion.duracion_laboral_segundos_calculada
    });

    const surtidorId = Number(sesion.surtidor_id);

    if (!sesionesBySurtidor.has(surtidorId)) {
      sesionesBySurtidor.set(surtidorId, []);
    }

    sesionesBySurtidor.get(surtidorId).push(sesion);
  }

  for (const rows of sesionesBySurtidor.values()) {
    const sorted = [...rows].sort((a, b) => String(a.hora_inicio).localeCompare(String(b.hora_inicio)));

    for (let i = 1; i < sorted.length; i += 1) {
      const previous = sorted[i - 1];
      const current = sorted[i];

      if (!previous.hora_fin || !current.hora_inicio) continue;

      const gapSeconds = getSegundosLaboralesEntre(previous.hora_fin, current.hora_inicio);

      if (gapSeconds <= 0) continue;

      const hourKey = getHourLabel(current.hora_inicio);

      addToMap(muertoMap, hourKey, {
        sesiones: 1,
        tiempo_muerto_laboral_segundos: gapSeconds
      });
    }
  }

  const horas_surtido = Array.from(surtidoMap.values())
    .map((row) => ({
      ...row,
      tiempo_activo_laboral_minutos: secondsToMinutes(row.tiempo_activo_laboral_segundos),
      partidas_por_hora_laboral: calcularPartidasPorHoraLaboral({
        partidasSurtidas: row.partidas_surtidas,
        segundosLaborales: row.tiempo_activo_laboral_segundos
      })
    }))
    .sort((a, b) => a.hora.localeCompare(b.hora));

  const horas_tiempo_muerto = Array.from(muertoMap.values())
    .map((row) => ({
      ...row,
      tiempo_muerto_laboral_minutos: secondsToMinutes(row.tiempo_muerto_laboral_segundos)
    }))
    .sort((a, b) => a.hora.localeCompare(b.hora));

  const pico_surtido = [...horas_surtido].sort((a, b) => b.partidas_surtidas - a.partidas_surtidas)[0] || null;
  const pico_tiempo_muerto = [...horas_tiempo_muerto].sort((a, b) => b.tiempo_muerto_laboral_segundos - a.tiempo_muerto_laboral_segundos)[0] || null;

  return {
    horas_surtido,
    horas_tiempo_muerto,
    pico_surtido,
    pico_tiempo_muerto,
    nota_tiempo_muerto: 'El tiempo muerto por hora se calcula con los espacios laborales entre una sesión finalizada y la siguiente sesión del mismo surtidor. El tiempo muerto total del equipo se calcula contra la jornada laboral transcurrida.'
  };
}

export const productividadJornada = asyncHandler(async (req, res) => {
  const fecha = validarFecha(req.query.fecha);
  const sucursalId = toPositiveIdOptional(req.query.sucursal_id, 'sucursal_id');
  const nowMexico = getNowMexicoDateTime();
  const jornada = getJornadaLaboral(fecha);

  const params = [fecha];
  const where = [
    'ps.fecha_operativa = ?',
    "ps.estado IN ('FINALIZADO', 'EN_PROCESO')"
  ];

  if (sucursalId) {
    where.push('ps.sucursal_id = ?');
    params.push(sucursalId);
  }

  const [sesionesRows] = await pool.query(
    `
    SELECT
      ps.id,
      ps.fecha_operativa,
      ps.surtidor_id,
      u.nombre AS surtidor_nombre,
      u.usuario AS surtidor_usuario,
      su.codigo AS surtidor_codigo,
      ps.sucursal_id,
      s.nombre AS sucursal_nombre,
      ps.estado,
      DATE_FORMAT(ps.hora_inicio, '%Y-%m-%d %H:%i:%s') AS hora_inicio,
      DATE_FORMAT(ps.hora_fin, '%Y-%m-%d %H:%i:%s') AS hora_fin,
      DATE_FORMAT(ps.updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at,
      ps.tickets,
      ps.partidas,
      ps.ceros,
      ps.no_surtido,
      ps.duracion_segundos,
      ps.duracion_laboral_segundos
    FROM productividad_sesiones ps
    INNER JOIN surtidores su ON su.id = ps.surtidor_id
    INNER JOIN usuarios u ON u.id = ps.usuario_id
    INNER JOIN sucursales s ON s.id = ps.sucursal_id
    WHERE ${where.join(' AND ')}
    ORDER BY ps.surtidor_id ASC, ps.hora_inicio ASC
    `,
    params
  );

  const paramsReporte = [fecha];
  const whereReporte = ['rg.fecha = ?'];

  if (sucursalId) {
    whereReporte.push('rg.sucursal_id = ?');
    paramsReporte.push(sucursalId);
  }

  const [reporteRows] = await pool.query(
    `
    SELECT
      COALESCE(SUM(rg.surtido), 0) AS surtido_total,
      COALESCE(SUM(rg.partidas), 0) AS partidas_surtidas,
      COALESCE(SUM(rg.ceros), 0) AS ceros,
      COALESCE(SUM(rg.no_surtido), 0) AS negados
    FROM reporte_grupal_surtido rg
    WHERE ${whereReporte.join(' AND ')}
    `,
    paramsReporte
  );

  const sesiones = sesionesRows.map((row) => buildSessionMetrics(row, nowMexico));
  const reporteTotal = {
    surtido_total: toNumber(reporteRows[0]?.surtido_total),
    partidas_surtidas: toNumber(reporteRows[0]?.partidas_surtidas),
    ceros: toNumber(reporteRows[0]?.ceros),
    negados: toNumber(reporteRows[0]?.negados)
  };

  const resumen = buildResumenFromTotals({
    fecha,
    jornada,
    nowMexico,
    sesiones,
    reporteTotal
  });

  const surtidores = buildSurtidores({ sesiones, resumen });
  const horasPico = buildHorasPico({ sesiones });

  res.json({
    ok: true,
    fecha,
    filtros: {
      sucursal_id: sucursalId
    },
    resumen,
    surtidores,
    horas_pico: horasPico
  });
});
