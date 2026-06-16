import { env } from '../config/env.js';
import { normalizeDbDateTime } from './mexicoTime.js';

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

function parseLocalDateTime(value) {
  const normalized = normalizeDbDateTime(value);

  if (!normalized) return null;

  const [datePart, timePart = '00:00:00'] = normalized.split(' ');
  const [hour, minute, second = '0'] = timePart.split(':').map(Number);

  return {
    date: datePart,
    minutes: (hour * 60) + minute,
    seconds: Number(second || 0)
  };
}

function overlapMinutes(startA, endA, startB, endB) {
  const start = Math.max(startA, startB);
  const end = Math.min(endA, endB);

  return Math.max(0, end - start);
}

export function getJornadaLaboral(fecha) {
  const day = getDayOfWeek(fecha);

  if (day === 0) {
    return {
      fecha,
      es_laboral: false,
      dia_semana: day,
      inicio: null,
      fin: null,
      comida_inicio: null,
      comida_fin: null,
      minutos_brutos: 0,
      minutos_comida: 0,
      minutos_netos: 0,
      horas_netas: 0
    };
  }

  const isSaturday = day === 6;

  const inicio = isSaturday ? env.JORNADA_SABADO_INICIO : env.JORNADA_LV_INICIO;
  const fin = isSaturday ? env.JORNADA_SABADO_FIN : env.JORNADA_LV_FIN;
  const comidaInicio = isSaturday ? env.JORNADA_SABADO_COMIDA_INICIO : env.JORNADA_LV_COMIDA_INICIO;
  const comidaFin = isSaturday ? env.JORNADA_SABADO_COMIDA_FIN : env.JORNADA_LV_COMIDA_FIN;

  const inicioMin = timeToMinutes(inicio);
  const finMin = timeToMinutes(fin);
  const comidaInicioMin = timeToMinutes(comidaInicio);
  const comidaFinMin = timeToMinutes(comidaFin);

  const minutosBrutos = Math.max(0, finMin - inicioMin);
  const minutosComida = overlapMinutes(inicioMin, finMin, comidaInicioMin, comidaFinMin);
  const minutosNetos = Math.max(0, minutosBrutos - minutosComida);

  return {
    fecha,
    es_laboral: true,
    dia_semana: day,
    inicio,
    fin,
    comida_inicio: comidaInicio,
    comida_fin: comidaFin,
    minutos_brutos: minutosBrutos,
    minutos_comida: minutosComida,
    minutos_netos: minutosNetos,
    horas_netas: minutesToHours(minutosNetos)
  };
}

export function getSegundosLaboralesEntre(inicioDateTime, finDateTime) {
  const inicioParsed = parseLocalDateTime(inicioDateTime);
  const finParsed = parseLocalDateTime(finDateTime);

  if (!inicioParsed || !finParsed) return 0;

  let fechaActual = inicioParsed.date;
  let totalMinutos = 0;

  while (fechaActual <= finParsed.date) {
    const jornada = getJornadaLaboral(fechaActual);

    if (jornada.es_laboral) {
      const jornadaInicio = timeToMinutes(jornada.inicio);
      const jornadaFin = timeToMinutes(jornada.fin);
      const comidaInicio = timeToMinutes(jornada.comida_inicio);
      const comidaFin = timeToMinutes(jornada.comida_fin);

      const rangoInicio = fechaActual === inicioParsed.date
        ? inicioParsed.minutes
        : jornadaInicio;

      const rangoFin = fechaActual === finParsed.date
        ? finParsed.minutes
        : jornadaFin;

      const minutosDentroJornada = overlapMinutes(
        rangoInicio,
        rangoFin,
        jornadaInicio,
        jornadaFin
      );

      const minutosComidaDentroRango = overlapMinutes(
        rangoInicio,
        rangoFin,
        comidaInicio,
        comidaFin
      );

      totalMinutos += Math.max(0, minutosDentroJornada - minutosComidaDentroRango);
    }

    if (fechaActual === finParsed.date) break;

    fechaActual = addDays(fechaActual, 1);
  }

  return Math.max(0, totalMinutos * 60);
}

export function getJornadaTranscurridaSegundos(fecha, nowDateTime) {
  const jornada = getJornadaLaboral(fecha);

  if (!jornada.es_laboral) return 0;

  const parsed = parseLocalDateTime(nowDateTime);

  if (!parsed || parsed.date < fecha) return 0;

  const inicio = `${fecha} ${jornada.inicio}:00`;
  const fin = parsed.date > fecha
    ? `${fecha} ${jornada.fin}:00`
    : nowDateTime;

  return getSegundosLaboralesEntre(inicio, fin);
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