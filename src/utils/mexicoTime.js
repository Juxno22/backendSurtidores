import { env } from '../config/env.js';

function getMexicoParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: env.APP_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(date);

  const map = {};

  for (const part of parts) {
    if (part.type !== 'literal') {
      map[part.type] = part.value;
    }
  }

  return map;
}

export function getFechaOperativaMexico(date = new Date()) {
  const parts = getMexicoParts(date);

  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function getNowMexicoDateTime(date = new Date()) {
  const parts = getMexicoParts(date);

  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

export function normalizeDbDateTime(value) {
  if (!value) return null;

  if (typeof value === 'string') {
    return value.replace('T', ' ').replace('.000Z', '').slice(0, 19);
  }

  if (value instanceof Date) {
    return getNowMexicoDateTime(value);
  }

  return String(value).replace('T', ' ').replace('.000Z', '').slice(0, 19);
}

export function normalizeDbDate(value) {
  if (!value) return null;

  if (typeof value === 'string') {
    return value.slice(0, 10);
  }

  if (value instanceof Date) {
    return getFechaOperativaMexico(value);
  }

  return String(value).slice(0, 10);
}

export function diffSecondsLocal(startDateTime, endDateTime) {
  const start = normalizeDbDateTime(startDateTime);
  const end = normalizeDbDateTime(endDateTime);

  if (!start || !end) return 0;

  const startDate = new Date(start.replace(' ', 'T'));
  const endDate = new Date(end.replace(' ', 'T'));

  const diff = Math.floor((endDate.getTime() - startDate.getTime()) / 1000);

  return Math.max(0, diff);
}