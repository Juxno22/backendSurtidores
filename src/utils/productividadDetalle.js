import {
  getJornadaLaboral,
  getJornadaTranscurridaSegundos,
  getSegundosLaboralesEntre
} from './jornadaLaboral.js';

import {
  getFechaOperativaMexico,
  getNowMexicoDateTime
} from './mexicoTime.js';

function toNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function round2(value) {
  return Number(toNumber(value).toFixed(2));
}

export function secondsToHours(seconds) {
  return round2(toNumber(seconds) / 3600);
}

export function percent(value, total) {
  const totalNumber = toNumber(total);

  if (!totalNumber) return 0;

  return round2((toNumber(value) / totalNumber) * 100);
}

export function eachDate(desde, hasta) {
  const dates = [];

  const start = new Date(`${desde}T12:00:00Z`);
  const end = new Date(`${hasta}T12:00:00Z`);

  while (start <= end) {
    dates.push(start.toISOString().slice(0, 10));
    start.setUTCDate(start.getUTCDate() + 1);
  }

  return dates;
}

export function getJornadaDisponibleSegundosPorFecha(fecha) {
  const hoy = getFechaOperativaMexico();

  if (fecha > hoy) return 0;

  if (fecha === hoy) {
    return getJornadaTranscurridaSegundos(fecha, getNowMexicoDateTime());
  }

  const jornada = getJornadaLaboral(fecha);

  if (!jornada.es_laboral) return 0;

  return jornada.minutos_netos * 60;
}

export function getJornadaDisponibleSegundosPorFechas(fechas = []) {
  const uniqueDates = [...new Set(fechas.filter(Boolean))];

  return uniqueDates.reduce((total, fecha) => {
    return total + getJornadaDisponibleSegundosPorFecha(fecha);
  }, 0);
}

export function getSurtidoTotal(row) {
  const partidas = toNumber(row.partidas_surtidas ?? row.partidas);
  const ceros = toNumber(row.ceros);
  const negados = toNumber(row.negados ?? row.no_surtido);

  return partidas + ceros + negados;
}

export function calcularMetricasSesion(row, tiempoMuertoAnteriorSegundos = 0) {
  const partidasSurtidas = toNumber(row.partidas_surtidas ?? row.partidas);
  const ceros = toNumber(row.ceros);
  const negados = toNumber(row.negados ?? row.no_surtido);
  const surtidoTotal = partidasSurtidas + ceros + negados;

  let duracionLaboralSegundos = toNumber(row.duracion_laboral_segundos);

  if (!duracionLaboralSegundos && row.hora_inicio && row.hora_fin) {
    duracionLaboralSegundos = getSegundosLaboralesEntre(
      row.hora_inicio,
      row.hora_fin
    );
  }

  const duracionSegundos = toNumber(row.duracion_segundos);

  return {
    ...row,

    surtido_total: surtidoTotal,
    partidas_surtidas: partidasSurtidas,
    ceros,
    negados,

    duracion_segundos: duracionSegundos,
    duracion_horas: secondsToHours(duracionSegundos),

    duracion_laboral_segundos: duracionLaboralSegundos,
    duracion_laboral_horas: secondsToHours(duracionLaboralSegundos),

    tiempo_muerto_anterior_segundos: tiempoMuertoAnteriorSegundos,
    tiempo_muerto_anterior_horas: secondsToHours(tiempoMuertoAnteriorSegundos),

    partidas_por_hora_activa: duracionLaboralSegundos
      ? round2(partidasSurtidas / (duracionLaboralSegundos / 3600))
      : 0
  };
}

export function construirDetalleSurtidores(rows = []) {
  const sortedRows = [...rows].sort((a, b) => {
    const surtidorCompare = String(a.surtidor_id).localeCompare(String(b.surtidor_id));

    if (surtidorCompare !== 0) return surtidorCompare;

    return String(a.hora_inicio || '').localeCompare(String(b.hora_inicio || ''));
  });

  const previousBySurtidor = new Map();
  const summaryBySurtidor = new Map();

  const sesiones = sortedRows.map((row) => {
    const previous = previousBySurtidor.get(row.surtidor_id);

    let tiempoMuertoAnteriorSegundos = 0;

    if (
      previous &&
      previous.hora_fin &&
      row.hora_inicio &&
      previous.fecha_operativa === row.fecha_operativa
    ) {
      tiempoMuertoAnteriorSegundos = getSegundosLaboralesEntre(
        previous.hora_fin,
        row.hora_inicio
      );
    }

    const sesion = calcularMetricasSesion(row, tiempoMuertoAnteriorSegundos);

    previousBySurtidor.set(row.surtidor_id, sesion);

    if (!summaryBySurtidor.has(row.surtidor_id)) {
      summaryBySurtidor.set(row.surtidor_id, {
        surtidor_id: row.surtidor_id,
        surtidor_nombre: row.surtidor_nombre,
        surtidor_codigo: row.surtidor_codigo,
        surtidor_usuario: row.surtidor_usuario,

        fechas_set: new Set(),
        sucursales_set: new Set(),

        sesiones: 0,
        surtido_total: 0,
        partidas_surtidas: 0,
        ceros: 0,
        negados: 0,

        tiempo_activo_segundos: 0,
        tiempo_muerto_segundos: 0
      });
    }

    const summary = summaryBySurtidor.get(row.surtidor_id);

    summary.fechas_set.add(row.fecha_operativa);

    if (row.sucursal_nombre) {
      summary.sucursales_set.add(row.sucursal_nombre);
    }

    summary.sesiones += 1;
    summary.surtido_total += sesion.surtido_total;
    summary.partidas_surtidas += sesion.partidas_surtidas;
    summary.ceros += sesion.ceros;
    summary.negados += sesion.negados;
    summary.tiempo_activo_segundos += sesion.duracion_laboral_segundos;
    summary.tiempo_muerto_segundos += sesion.tiempo_muerto_anterior_segundos;

    return sesion;
  });

  const ranking = [...summaryBySurtidor.values()]
    .map((item) => {
      const fechas = [...item.fechas_set];
      const jornadaDisponibleSegundos = getJornadaDisponibleSegundosPorFechas(fechas);

      const tiempoOperativoSegundos =
        item.tiempo_activo_segundos + item.tiempo_muerto_segundos;

      return {
        surtidor_id: item.surtidor_id,
        surtidor_nombre: item.surtidor_nombre,
        surtidor_codigo: item.surtidor_codigo,
        surtidor_usuario: item.surtidor_usuario,

        fechas,
        sucursales: [...item.sucursales_set],

        sesiones: item.sesiones,
        surtido_total: item.surtido_total,
        partidas_surtidas: item.partidas_surtidas,
        ceros: item.ceros,
        negados: item.negados,

        jornada_disponible_segundos: jornadaDisponibleSegundos,
        jornada_disponible_horas: secondsToHours(jornadaDisponibleSegundos),

        tiempo_activo_segundos: item.tiempo_activo_segundos,
        tiempo_activo_horas: secondsToHours(item.tiempo_activo_segundos),

        tiempo_muerto_segundos: item.tiempo_muerto_segundos,
        tiempo_muerto_horas: secondsToHours(item.tiempo_muerto_segundos),

        aprovechamiento_operativo_pct: percent(
          item.tiempo_activo_segundos,
          tiempoOperativoSegundos
        ),

        aprovechamiento_jornada_pct: percent(
          item.tiempo_activo_segundos,
          jornadaDisponibleSegundos
        ),

        partidas_por_hora_jornada: jornadaDisponibleSegundos
          ? round2(item.partidas_surtidas / (jornadaDisponibleSegundos / 3600))
          : 0,

        partidas_por_hora_activa: item.tiempo_activo_segundos
          ? round2(item.partidas_surtidas / (item.tiempo_activo_segundos / 3600))
          : 0
      };
    })
    .sort((a, b) => b.partidas_por_hora_jornada - a.partidas_por_hora_jornada);

  const resumen = ranking.reduce((acc, item) => {
    acc.surtidores += 1;
    acc.sesiones += item.sesiones;
    acc.surtido_total += item.surtido_total;
    acc.partidas_surtidas += item.partidas_surtidas;
    acc.ceros += item.ceros;
    acc.negados += item.negados;
    acc.jornada_disponible_segundos += item.jornada_disponible_segundos;
    acc.tiempo_activo_segundos += item.tiempo_activo_segundos;
    acc.tiempo_muerto_segundos += item.tiempo_muerto_segundos;

    return acc;
  }, {
    surtidores: 0,
    sesiones: 0,
    surtido_total: 0,
    partidas_surtidas: 0,
    ceros: 0,
    negados: 0,
    jornada_disponible_segundos: 0,
    tiempo_activo_segundos: 0,
    tiempo_muerto_segundos: 0
  });

  resumen.jornada_disponible_horas = secondsToHours(resumen.jornada_disponible_segundos);
  resumen.tiempo_activo_horas = secondsToHours(resumen.tiempo_activo_segundos);
  resumen.tiempo_muerto_horas = secondsToHours(resumen.tiempo_muerto_segundos);

  resumen.aprovechamiento_operativo_pct = percent(
    resumen.tiempo_activo_segundos,
    resumen.tiempo_activo_segundos + resumen.tiempo_muerto_segundos
  );

  resumen.aprovechamiento_jornada_pct = percent(
    resumen.tiempo_activo_segundos,
    resumen.jornada_disponible_segundos
  );

  resumen.partidas_por_hora_jornada = resumen.jornada_disponible_segundos
    ? round2(resumen.partidas_surtidas / (resumen.jornada_disponible_segundos / 3600))
    : 0;

  resumen.partidas_por_hora_activa = resumen.tiempo_activo_segundos
    ? round2(resumen.partidas_surtidas / (resumen.tiempo_activo_segundos / 3600))
    : 0;

  return {
    resumen,
    ranking,
    sesiones
  };
}

export function construirDetalleChecadores(rows = []) {
  const summaryByChecador = new Map();

  for (const row of rows) {
    const checadorId = row.checador_id;

    if (!summaryByChecador.has(checadorId)) {
      summaryByChecador.set(checadorId, {
        checador_id: checadorId,
        checador_nombre: row.checador_nombre,
        checador_codigo: row.checador_codigo,

        fechas_set: new Set(),

        registros: 0,
        salidas: 0,
        tp: 0,
        total: 0
      });
    }

    const item = summaryByChecador.get(checadorId);

    item.fechas_set.add(row.fecha);

    item.registros += 1;
    item.salidas += 1;
    item.tp += toNumber(row.tp);
    item.total += toNumber(row.total);
  }

  const ranking = [...summaryByChecador.values()]
    .map((item) => {
      const fechas = [...item.fechas_set];
      const jornadaDisponibleSegundos = getJornadaDisponibleSegundosPorFechas(fechas);

      return {
        checador_id: item.checador_id,
        checador_nombre: item.checador_nombre,
        checador_codigo: item.checador_codigo,

        fechas,

        registros: item.registros,
        salidas: item.salidas,
        tp: round2(item.tp),
        total: round2(item.total),

        jornada_disponible_segundos: jornadaDisponibleSegundos,
        jornada_disponible_horas: secondsToHours(jornadaDisponibleSegundos),

        salidas_por_hora_jornada: jornadaDisponibleSegundos
          ? round2(item.salidas / (jornadaDisponibleSegundos / 3600))
          : 0,

        tp_por_hora_jornada: jornadaDisponibleSegundos
          ? round2(item.tp / (jornadaDisponibleSegundos / 3600))
          : 0,

        total_por_hora_jornada: jornadaDisponibleSegundos
          ? round2(item.total / (jornadaDisponibleSegundos / 3600))
          : 0
      };
    })
    .sort((a, b) => b.salidas_por_hora_jornada - a.salidas_por_hora_jornada);

  const resumen = ranking.reduce((acc, item) => {
    acc.checadores += 1;
    acc.registros += item.registros;
    acc.salidas += item.salidas;
    acc.tp += item.tp;
    acc.total += item.total;
    acc.jornada_disponible_segundos += item.jornada_disponible_segundos;

    return acc;
  }, {
    checadores: 0,
    registros: 0,
    salidas: 0,
    tp: 0,
    total: 0,
    jornada_disponible_segundos: 0
  });

  resumen.tp = round2(resumen.tp);
  resumen.total = round2(resumen.total);
  resumen.jornada_disponible_horas = secondsToHours(resumen.jornada_disponible_segundos);

  resumen.salidas_por_hora_jornada = resumen.jornada_disponible_segundos
    ? round2(resumen.salidas / (resumen.jornada_disponible_segundos / 3600))
    : 0;

  resumen.tp_por_hora_jornada = resumen.jornada_disponible_segundos
    ? round2(resumen.tp / (resumen.jornada_disponible_segundos / 3600))
    : 0;

  resumen.total_por_hora_jornada = resumen.jornada_disponible_segundos
    ? round2(resumen.total / (resumen.jornada_disponible_segundos / 3600))
    : 0;

  return {
    resumen,
    ranking,
    registros: rows
  };
}