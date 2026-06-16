import XLSX from 'xlsx';

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase();
}

function normalizeHeader(value) {
  return normalizeText(value)
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function cleanString(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function toNumber(value, defaultValue = 0) {
  if (value === undefined || value === null || value === '') return defaultValue;

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : defaultValue;
  }

  const normalized = String(value)
    .replace(/\$/g, '')
    .replace(/,/g, '')
    .trim();

  const number = Number(normalized);

  return Number.isFinite(number) ? number : defaultValue;
}

function parseExcelSerialDate(value) {
  const parsed = XLSX.SSF.parse_date_code(value);

  if (!parsed) return null;

  const year = String(parsed.y).padStart(4, '0');
  const month = String(parsed.m).padStart(2, '0');
  const day = String(parsed.d).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

function parseFecha(value) {
  if (value === undefined || value === null || value === '') return null;

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');

    return `${year}-${month}-${day}`;
  }

  if (typeof value === 'number') {
    return parseExcelSerialDate(value);
  }

  const text = String(value).trim();

  if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
    return text.slice(0, 10);
  }

  const ddmmyy = text.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2}|\d{4})$/);

  if (ddmmyy) {
    const day = String(ddmmyy[1]).padStart(2, '0');
    const month = String(ddmmyy[2]).padStart(2, '0');
    let year = String(ddmmyy[3]);

    if (year.length === 2) {
      year = Number(year) >= 70 ? `19${year}` : `20${year}`;
    }

    return `${year}-${month}-${day}`;
  }

  const parsed = new Date(text);

  if (!Number.isNaN(parsed.getTime())) {
    const year = parsed.getFullYear();
    const month = String(parsed.getMonth() + 1).padStart(2, '0');
    const day = String(parsed.getDate()).padStart(2, '0');

    return `${year}-${month}-${day}`;
  }

  return null;
}

function splitChecador(value) {
  const raw = cleanString(value);

  if (!raw) {
    return {
      codigo: null,
      nombre: null,
      raw: null
    };
  }

  const [codigoParte, ...nombrePartes] = raw.split('*');
  const codigo = normalizeText(codigoParte || raw).replace(/[^A-Z0-9]/g, '') || null;
  const nombre = cleanString(nombrePartes.join('*')) || raw;

  return {
    codigo,
    nombre,
    raw
  };
}

function detectHeaderRow(rows) {
  const maxRows = Math.min(rows.length, 35);

  for (let rowIndex = 0; rowIndex < maxRows; rowIndex += 1) {
    const normalized = rows[rowIndex].map(normalizeHeader);
    const hasSalida = normalized.some((h) => ['NUM_DE_SALIDA', 'NUM_SALIDA', 'SALIDA'].includes(h));
    const hasFecha = normalized.includes('FECHA');
    const hasChecador = normalized.includes('CHECADOR');
    const hasTp = normalized.includes('TP');

    if (hasSalida && hasFecha && hasChecador && hasTp) {
      return rowIndex;
    }
  }

  return -1;
}

function buildColumnMap(headerRow) {
  const map = {};

  headerRow.forEach((header, index) => {
    const key = normalizeHeader(header);

    if (['NUM_DE_SALIDA', 'NUM_SALIDA', 'SALIDA', 'NO_SALIDA', 'NUMERO_DE_SALIDA'].includes(key)) {
      map.num_salida = index;
      return;
    }

    if (key === 'EST' || key === 'ESTADO') {
      map.est = index;
      return;
    }

    if (key === 'FECHA') {
      map.fecha = index;
      return;
    }

    if (key === 'CHECADOR') {
      map.checador = index;
      return;
    }

    if (['NUM_REQUISICION', 'NUM_DE_REQUISICION', 'REQUISICION', 'NO_REQUISICION', 'NUMERO_REQUISICION'].includes(key)) {
      map.num_requisicion = index;
      return;
    }

    if (['OBSERVACIONES', 'OBSERVACION', 'OBS', 'SUCURSAL', 'DESTINO', 'DESCRIPCION'].includes(key)) {
      map.observaciones = index;
      return;
    }

    if (key === 'TP') {
      map.tp = index;
      return;
    }

    if (['TOTAL', 'IMPORTE', 'MONTO'].includes(key)) {
      map.total = index;
    }
  });

  if (map.observaciones === undefined && map.num_requisicion !== undefined) {
    const candidateIndex = map.num_requisicion + 1;

    if (candidateIndex < headerRow.length && !normalizeHeader(headerRow[candidateIndex])) {
      map.observaciones = candidateIndex;
    }
  }

  return map;
}

function parseRowsFromSheet(sheetName, rows) {
  const warnings = [];
  const headerIndex = detectHeaderRow(rows);

  if (headerIndex < 0) {
    return {
      sheetName,
      procesada: false,
      filas: [],
      warnings: [`Hoja ${sheetName}: no se detectaron encabezados de checadores.`]
    };
  }

  const headerRow = rows[headerIndex];
  const col = buildColumnMap(headerRow);

  const required = ['num_salida', 'fecha', 'checador', 'tp'];
  const missing = required.filter((key) => col[key] === undefined);

  if (missing.length > 0) {
    return {
      sheetName,
      procesada: false,
      filas: [],
      warnings: [`Hoja ${sheetName}: faltan columnas obligatorias: ${missing.join(', ')}.`]
    };
  }

  const filas = [];

  for (let index = headerIndex + 1; index < rows.length; index += 1) {
    const row = rows[index] || [];

    const numSalida = cleanString(row[col.num_salida]);
    const fecha = parseFecha(row[col.fecha]);
    const checadorInfo = splitChecador(row[col.checador]);
    const tp = Math.round(toNumber(row[col.tp], 0));

    const isEmpty = row.every((cell) => cell === null || cell === undefined || String(cell).trim() === '');

    if (isEmpty) continue;

    if (!numSalida && !fecha && !checadorInfo.raw) continue;

    if (!numSalida || !fecha || !checadorInfo.codigo) {
      warnings.push(`Hoja ${sheetName}, fila ${index + 1}: se omitió por faltar salida, fecha o checador.`);
      continue;
    }

    filas.push({
      hoja: sheetName,
      fila_excel: index + 1,
      num_salida: numSalida,
      est: cleanString(row[col.est]),
      fecha,
      checador_codigo: checadorInfo.codigo,
      checador_nombre: checadorInfo.nombre,
      checador_raw: checadorInfo.raw,
      num_requisicion: cleanString(row[col.num_requisicion]),
      observaciones: cleanString(row[col.observaciones]),
      tp: Math.max(0, tp),
      total: Number(toNumber(row[col.total], 0).toFixed(2))
    });
  }

  return {
    sheetName,
    procesada: true,
    filas,
    warnings
  };
}

function getFechaMinMax(filas) {
  if (!filas.length) {
    return {
      fecha_min: null,
      fecha_max: null
    };
  }

  const fechas = filas.map((row) => row.fecha).sort();

  return {
    fecha_min: fechas[0],
    fecha_max: fechas[fechas.length - 1]
  };
}

export function parseReporteChecadoresExcel(buffer) {
  const workbook = XLSX.read(buffer, {
    type: 'buffer',
    cellDates: true,
    raw: false
  });

  const hojas = [];
  const warnings = [];
  const filas = [];

  for (const sheetName of workbook.SheetNames) {
    const normalizedSheet = normalizeText(sheetName);

    if (['REMANENTES', 'ORIGINAL'].includes(normalizedSheet)) {
      hojas.push({ hoja: sheetName, procesada: false, filas: 0, motivo: 'Hoja auxiliar ignorada' });
      continue;
    }

    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: null,
      raw: false
    });

    const parsed = parseRowsFromSheet(sheetName, rows);

    warnings.push(...parsed.warnings);

    if (!parsed.procesada) {
      hojas.push({ hoja: sheetName, procesada: false, filas: 0, motivo: 'Sin encabezados válidos' });
      continue;
    }

    filas.push(...parsed.filas);
    hojas.push({ hoja: sheetName, procesada: true, filas: parsed.filas.length });
  }

  const { fecha_min, fecha_max } = getFechaMinMax(filas);

  const checadores = new Map();
  for (const fila of filas) {
    if (!checadores.has(fila.checador_codigo)) {
      checadores.set(fila.checador_codigo, {
        codigo: fila.checador_codigo,
        nombre: fila.checador_nombre,
        raw: fila.checador_raw,
        filas: 0,
        tp: 0
      });
    }

    const item = checadores.get(fila.checador_codigo);
    item.filas += 1;
    item.tp += fila.tp;
  }

  return {
    filas,
    hojas,
    warnings,
    resumen: {
      filas_leidas: filas.length,
      checadores_detectados: Array.from(checadores.values()),
      fecha_min,
      fecha_max,
      total_tp: filas.reduce((acc, row) => acc + row.tp, 0),
      total_salidas: filas.length,
      total_importe: Number(filas.reduce((acc, row) => acc + row.total, 0).toFixed(2))
    }
  };
}
