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

  return String(value).replace('T', ' ').slice(0, 19);
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

export function calcularMetricas(row) {
  const duracionSegundos = Number(row.duracion_segundos || 0);
  const duracionHoras = duracionSegundos / 3600;
  const tickets = Number(row.tickets || 0);
  const partidas = Number(row.partidas || 0);
  const monto = Number(row.monto || 0);

  return {
    duracion_minutos: segundosAMinutos(duracionSegundos),
    duracion_horas: segundosAHoras(duracionSegundos),
    tickets_por_hora: duracionHoras > 0 ? round2(tickets / duracionHoras) : 0,
    partidas_por_hora: duracionHoras > 0 ? round2(partidas / duracionHoras) : 0,
    monto_por_hora: duracionHoras > 0 ? round2(monto / duracionHoras) : 0,
    minutos_por_ticket: tickets > 0 ? round2((duracionSegundos / 60) / tickets) : 0,
    minutos_por_partida: partidas > 0 ? round2((duracionSegundos / 60) / partidas) : 0
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

export function sendXlsx(res, sheets, filename) {
  const workbook = xlsx.utils.book_new();

  for (const sheet of sheets) {
    const rows = sheet.rows || [];
    const safeSheetName = String(sheet.name || 'Hoja1').slice(0, 31);

    const worksheet = xlsx.utils.json_to_sheet(rows);
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