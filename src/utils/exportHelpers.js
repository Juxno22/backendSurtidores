import xlsx from 'xlsx';

export function validarFormatoExportacion(value) {
  const formato = String(value || 'xlsx').trim().toLowerCase();

  if (!['xlsx', 'csv'].includes(formato)) {
    const error = new Error('El formato debe ser xlsx o csv');
    error.status = 400;
    throw error;
  }

  return formato;
}

export function formatDate(value) {
  if (!value) return '';

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }

  return String(value).slice(0, 10);
}

export function formatDateTime(value) {
  if (!value) return '';

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().replace('T', ' ').slice(0, 19);
  }

  return String(value).replace('T', ' ').replace('.000Z', '').slice(0, 19);
}

export function round2(value) {
  const number = Number(value || 0);
  return Number(number.toFixed(2));
}

export function segundosAHoras(value) {
  return round2(Number(value || 0) / 3600);
}

export function segundosAMinutos(value) {
  return round2(Number(value || 0) / 60);
}

export function safeDivide(numerator, denominator, decimals = 2) {
  const n = Number(numerator || 0);
  const d = Number(denominator || 0);

  if (!d) return 0;

  return Number((n / d).toFixed(decimals));
}

export function safePct(value, total, decimals = 2) {
  const t = Number(total || 0);

  if (!t) return 0;

  return round2((Number(value || 0) / t) * 100, decimals);
}

export function calcularMetricas(row) {
  const duracionSegundos = Number(row.duracion_segundos || 0);
  const duracionLaboralSegundos = Number(row.duracion_laboral_segundos || row.duracion_segundos || 0);
  const duracionHoras = duracionSegundos / 3600;
  const duracionLaboralHoras = duracionLaboralSegundos / 3600;

  const surtidoTotal = Number(row.surtido_total ?? row.tickets ?? 0);
  const partidasSurtidas = Number(row.partidas_surtidas ?? row.partidas ?? 0);
  const ceros = Number(row.ceros || 0);
  const negados = Number(row.negados ?? row.no_surtido ?? 0);

  return {
    surtido_total: surtidoTotal,
    partidas_surtidas: partidasSurtidas,
    ceros,
    negados,

    duracion_minutos: segundosAMinutos(duracionSegundos),
    duracion_horas: segundosAHoras(duracionSegundos),
    duracion_laboral_minutos: segundosAMinutos(duracionLaboralSegundos),
    duracion_laboral_horas: segundosAHoras(duracionLaboralSegundos),

    surtido_por_hora_real: duracionHoras > 0 ? round2(surtidoTotal / duracionHoras) : 0,
    partidas_por_hora_real: duracionHoras > 0 ? round2(partidasSurtidas / duracionHoras) : 0,

    surtido_por_hora_laboral: duracionLaboralHoras > 0 ? round2(surtidoTotal / duracionLaboralHoras) : 0,
    partidas_por_hora_laboral: duracionLaboralHoras > 0 ? round2(partidasSurtidas / duracionLaboralHoras) : 0,

    minutos_por_surtido: surtidoTotal > 0 ? round2((duracionLaboralSegundos / 60) / surtidoTotal) : 0,
    minutos_por_partida: partidasSurtidas > 0 ? round2((duracionLaboralSegundos / 60) / partidasSurtidas) : 0
  };
}

function escapeCsvValue(value) {
  if (value === null || value === undefined) return '';

  const str = String(value);

  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }

  return str;
}

export function rowsToCsv(rows) {
  if (!rows || rows.length === 0) return '';

  const headers = Object.keys(rows[0]);

  const lines = [
    headers.map(escapeCsvValue).join(','),
    ...rows.map((row) => headers.map((header) => escapeCsvValue(row[header])).join(','))
  ];

  return `\uFEFF${lines.join('\n')}`;
}

export function sendCsv(res, rows, filename) {
  const csv = rowsToCsv(rows);

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);

  return res.send(csv);
}

function autosizeWorksheet(worksheet, rows) {
  if (!rows?.length) return;

  const headers = Object.keys(rows[0]);

  worksheet['!cols'] = headers.map((header) => {
    const maxLength = rows.reduce((max, row) => {
      const value = row[header];
      return Math.max(max, String(value ?? '').length);
    }, String(header).length);

    return { wch: Math.min(Math.max(maxLength + 2, 10), 42) };
  });
}

export function sendXlsx(res, sheets, filename) {
  const workbook = xlsx.utils.book_new();

  for (const sheet of sheets) {
    const rows = sheet.rows || [];
    const safeSheetName = String(sheet.name || 'Hoja1').slice(0, 31);

    const worksheet = xlsx.utils.json_to_sheet(rows);
    autosizeWorksheet(worksheet, rows);
    xlsx.utils.book_append_sheet(workbook, worksheet, safeSheetName);
  }

  const buffer = xlsx.write(workbook, {
    type: 'buffer',
    bookType: 'xlsx'
  });

  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);

  return res.send(buffer);
}

export function sendExport(res, {
  formato,
  filename,
  rows,
  sheets = null
}) {
  if (formato === 'csv') {
    return sendCsv(res, rows, filename);
  }

  return sendXlsx(res, sheets || [{ name: 'Datos', rows }], filename);
}
