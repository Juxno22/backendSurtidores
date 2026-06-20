import { env } from '../config/env.js';
import { normalizeDbDateTime } from './mexicoTime.js';

const TIPO_SUCURSAL = 'SUCURSAL';
const TIPO_MAYOREO = 'MAYOREO';

function normalizarTipoOperacion(tipoOperacion = TIPO_SUCURSAL) {
  const tipo = String(tipoOperacion || TIPO_SUCURSAL).trim().toUpperCase();

  return tipo === TIPO_MAYOREO ? TIPO_MAYOREO : TIPO_SUCURSAL;
}

function timeToMinutes(time) {
  const [hours, minutes] = String(time).split(':').map(Number);

  return (hours * 60) + minutes;
}

function minutesToHours(minutes) {
  return Number((minutes / 60).toFixed(2));
}

function getDayOfWeek(fecha) {
  const date = new Date(`${fecha}T12:00:00Z`);

  return date.getUTCDay();
}

function addDays(fecha, days) {
  const date = new Date(`${fecha}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);

  return date.toISOString().slice(0, 10);
}

function dateIndex(fecha) {
  return Math.floor(new Date(`${fecha}T00:00:00Z`).getTime() / 86400000);
}

function parseLocalDateTime(value) {
  const normalized = normalizeDbDateTime(value);

  if (!normalized) return null;

  const [datePart, timePart = '00:00:00'] = normalized.split(' ');
  const [hour, minute, second = '0'] = timePart.split(':').map(Number);

  return {
    date: datePart,
    minutes: (hour * 60) + minute,
    seconds: Number(second || 0),
    absoluteMinute: (dateIndex(datePart) * 1440) + (hour * 60) + minute,
    absoluteSecond: (dateIndex(datePart) * 86400) + (hour * 3600) + (minute * 60) + Number(second || 0)
  };
}

function overlapMinutes(startA, endA, startB, endB) {
  const start = Math.max(startA, startB);
  const end = Math.min(endA, endB);

  return Math.max(0, end - start);
}

function getConfigJornada(fecha, tipoOperacion = TIPO_SUCURSAL) {
  const tipo = normalizarTipoOperacion(tipoOperacion);
  const day = getDayOfWeek(fecha);

  if (day === 0) {
    return {
      fecha,
      tipo_operacion: tipo,
      es_laboral: false,
      dia_semana: day,
      inicio: null,
      fin: null,
      comida_inicio: null,
      comida_fin: null
    };
  }

  if (tipo === TIPO_MAYOREO) {
    return {
      fecha,
      tipo_operacion: tipo,
      es_laboral: true,
      dia_semana: day,
      inicio: env.JORNADA_MAYOREO_INICIO || '17:00',
      fin: env.JORNADA_MAYOREO_FIN || '02:00',
      comida_inicio: env.JORNADA_MAYOREO_COMIDA_INICIO || '22:00',
      comida_fin: env.JORNADA_MAYOREO_COMIDA_FIN || '23:00'
    };
  }

  const isSaturday = day === 6;

  return {
    fecha,
    tipo_operacion: tipo,
    es_laboral: true,
    dia_semana: day,
    inicio: isSaturday ? env.JORNADA_SABADO_INICIO : env.JORNADA_LV_INICIO,
    fin: isSaturday ? env.JORNADA_SABADO_FIN : env.JORNADA_LV_FIN,
    comida_inicio: isSaturday ? env.JORNADA_SABADO_COMIDA_INICIO : env.JORNADA_LV_COMIDA_INICIO,
    comida_fin: isSaturday ? env.JORNADA_SABADO_COMIDA_FIN : env.JORNADA_LV_COMIDA_FIN
  };
}

function buildJornadaInterval(fecha, tipoOperacion = TIPO_SUCURSAL) {
  const config = getConfigJornada(fecha, tipoOperacion);

  if (!config.es_laboral) {
    return {
      ...config,
      startMinute: 0,
      endMinute: 0,
      comidaStartMinute: 0,
      comidaEndMinute: 0,
      minutos_brutos: 0,
      minutos_comida: 0,
      minutos_netos: 0,
      horas_netas: 0,
      cruza_medianoche: false,
      fecha_fin: fecha
    };
  }

  const dayBase = dateIndex(fecha) * 1440;

  const inicioMin = timeToMinutes(config.inicio);
  const finMinOriginal = timeToMinutes(config.fin);
  const comidaInicioMinOriginal = timeToMinutes(config.comida_inicio);
  const comidaFinMinOriginal = timeToMinutes(config.comida_fin);

  const cruzaMedianoche = finMinOriginal <= inicioMin;
  const finMin = cruzaMedianoche ? finMinOriginal + 1440 : finMinOriginal;

  const comidaInicioMin =
    cruzaMedianoche && comidaInicioMinOriginal < inicioMin
      ? comidaInicioMinOriginal + 1440
      : comidaInicioMinOriginal;

  const comidaFinMin =
    cruzaMedianoche && comidaFinMinOriginal <= comidaInicioMinOriginal
      ? comidaFinMinOriginal + 1440
      : cruzaMedianoche && comidaFinMinOriginal < inicioMin
        ? comidaFinMinOriginal + 1440
        : comidaFinMinOriginal;

  const startMinute = dayBase + inicioMin;
  const endMinute = dayBase + finMin;
  const comidaStartMinute = dayBase + comidaInicioMin;
  const comidaEndMinute = dayBase + comidaFinMin;

  const minutosBrutos = Math.max(0, endMinute - startMinute);
  const minutosComida = overlapMinutes(startMinute, endMinute, comidaStartMinute, comidaEndMinute);
  const minutosNetos = Math.max(0, minutosBrutos - minutosComida);

  return {
    ...config,
    startMinute,
    endMinute,
    comidaStartMinute,
    comidaEndMinute,
    minutos_brutos: minutosBrutos,
    minutos_comida: minutosComida,
    minutos_netos: minutosNetos,
    horas_netas: minutesToHours(minutosNetos),
    cruza_medianoche: cruzaMedianoche,
    fecha_fin: cruzaMedianoche ? addDays(fecha, 1) : fecha
  };
}

export function getFechaOperativaPorTipo(tipoOperacion = TIPO_SUCURSAL, dateTimeValue = new Date()) {
  const tipo = normalizarTipoOperacion(tipoOperacion);
  const parsed = parseLocalDateTime(dateTimeValue);

  if (!parsed) return null;

  if (tipo !== TIPO_MAYOREO) return parsed.date;

  const finMayoreo = timeToMinutes(env.JORNADA_MAYOREO_FIN || '02:00');

  if (parsed.minutes < finMayoreo) {
    return addDays(parsed.date, -1);
  }

  return parsed.date;
}

export function getJornadaLaboral(fecha, tipoOperacion = TIPO_SUCURSAL) {
  const interval = buildJornadaInterval(fecha, tipoOperacion);

  return {
    fecha: interval.fecha,
    tipo_operacion: interval.tipo_operacion,
    es_laboral: interval.es_laboral,
    dia_semana: interval.dia_semana,
    inicio: interval.inicio,
    fin: interval.fin,
    comida_inicio: interval.comida_inicio,
    comida_fin: interval.comida_fin,
    fecha_fin: interval.fecha_fin,
    cruza_medianoche: interval.cruza_medianoche,
    minutos_brutos: interval.minutos_brutos,
    minutos_comida: interval.minutos_comida,
    minutos_netos: interval.minutos_netos,
    horas_netas: interval.horas_netas
  };
}

export function getSegundosLaboralesEntre(
  inicioDateTime,
  finDateTime,
  tipoOperacion = TIPO_SUCURSAL,
  fechaOperativa = null
) {
  const inicioParsed = parseLocalDateTime(inicioDateTime);
  const finParsed = parseLocalDateTime(finDateTime);

  if (!inicioParsed || !finParsed) return 0;
  if (finParsed.absoluteSecond <= inicioParsed.absoluteSecond) return 0;

  const tipo = normalizarTipoOperacion(tipoOperacion);
  const fechaInicial = fechaOperativa || getFechaOperativaPorTipo(tipo, inicioDateTime);

  if (!fechaInicial) return 0;

  let fechaActual = fechaInicial;
  let totalMinutos = 0;
  let safety = 0;

  while (safety < 20) {
    const jornada = buildJornadaInterval(fechaActual, tipo);

    if (jornada.es_laboral) {
      const minutosDentroJornada = overlapMinutes(
        inicioParsed.absoluteMinute,
        finParsed.absoluteMinute,
        jornada.startMinute,
        jornada.endMinute
      );

      const minutosComidaDentroRango = overlapMinutes(
        inicioParsed.absoluteMinute,
        finParsed.absoluteMinute,
        jornada.comidaStartMinute,
        jornada.comidaEndMinute
      );

      totalMinutos += Math.max(0, minutosDentroJornada - minutosComidaDentroRango);
    }

    if (jornada.endMinute >= finParsed.absoluteMinute) break;

    fechaActual = addDays(fechaActual, 1);
    safety += 1;
  }

  return Math.max(0, totalMinutos * 60);
}

export function getJornadaTranscurridaSegundos(
  fecha,
  nowDateTime,
  tipoOperacion = TIPO_SUCURSAL
) {
  const jornada = getJornadaLaboral(fecha, tipoOperacion);

  if (!jornada.es_laboral) return 0;

  const inicio = `${fecha} ${jornada.inicio}:00`;
  const fin = jornada.cruza_medianoche
    ? `${jornada.fecha_fin} ${jornada.fin}:00`
    : `${fecha} ${jornada.fin}:00`;

  const nowParsed = parseLocalDateTime(nowDateTime);
  const finParsed = parseLocalDateTime(fin);

  if (!nowParsed || !finParsed) return 0;

  const end = nowParsed.absoluteSecond > finParsed.absoluteSecond ? fin : nowDateTime;

  return getSegundosLaboralesEntre(inicio, end, tipoOperacion, fecha);
}

export function calcularAprovechamientoTurno({
  tiempoActivoSegundos = 0,
  jornadaTranscurridaSegundos = 0
}) {
  if (!jornadaTranscurridaSegundos) return 0;

  return Number(((tiempoActivoSegundos / jornadaTranscurridaSegundos) * 100).toFixed(2));
}

export function calcularPartidasPorHoraLaboral({
  partidasSurtidas = 0,
  segundosLaborales = 0
}) {
  const horas = segundosLaborales / 3600;

  if (!horas) return 0;

  return Number((Number(partidasSurtidas || 0) / horas).toFixed(2));
}
