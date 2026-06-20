import crypto from 'crypto';
import XLSX from 'xlsx';

function cleanText(value) {
  if (value === undefined || value === null) return '';

  return String(value).trim();
}

function normalizeHeader(value) {
  return cleanText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '');
}

export function normalizeCodigo(value) {
  return cleanText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function toNumber(value) {
  if (value === undefined || value === null || value === '') return 0;

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }

  const text = cleanText(value)
    .replace(/,/g, '')
    .replace(/\$/g, '')
    .replace(/\s+/g, '');

  const parsed = Number(text);

  return Number.isFinite(parsed) ? parsed : 0;
}

function toInteger(value) {
  return Math.max(0, Math.round(toNumber(value)));
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function parseFecha(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const year = value.getFullYear();
    const month = pad2(value.getMonth() + 1);
    const day = pad2(value.getDate());

    return `${year}-${month}-${day}`;
  }

  const text = cleanText(value);
  const match = text.match(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/);

  if (!match) return '';

  const day = Number(match[1]);
  const month = Number(match[2]);
  let year = Number(match[3]);

  if (year < 100) year += 2000;

  if (!day || !month || !year) return '';

  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function parseHora(value) {
  const text = cleanText(value);
  const match = text.match(/(\d{1,2}):(\d{2})/);

  if (!match) return '';

  return `${pad2(Number(match[1]))}:${match[2]}`;
}

function parseFechaHoraReporte(value) {
  const text = cleanText(value);
  const fecha = parseFecha(text);
  const hora = parseHora(text);

  return {
    fecha,
    hora,
    fecha_hora: fecha && hora ? `${fecha} ${hora}:00` : null
  };
}

function getSheetRows(buffer, preferredSheetName = 'Convertido') {
  const workbook = XLSX.read(buffer, {
    type: 'buffer',
    cellDates: true,
    raw: false,
    defval: null
  });

  const sheetName = workbook.SheetNames.find((name) => {
    return normalizeHeader(name) === normalizeHeader(preferredSheetName);
  }) || workbook.SheetNames[0];

  if (!sheetName) {
    return {
      sheetName: null,
      rows: []
    };
  }

  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: null,
    raw: false
  });

  return {
    sheetName,
    rows
  };
}

function buildHeaderMap(headerRow = []) {
  const map = new Map();

  headerRow.forEach((header, index) => {
    const normalized = normalizeHeader(header);

    if (!normalized) return;

    if (!map.has(normalized)) {
      map.set(normalized, index);
    }
  });

  return map;
}

function findHeaderIndex(rows, requiredHeaders) {
  for (let index = 0; index < Math.min(rows.length, 25); index += 1) {
    const headerMap = buildHeaderMap(rows[index] || []);
    const found = requiredHeaders.every((header) => headerMap.has(normalizeHeader(header)));

    if (found) {
      return {
        index,
        headerMap
      };
    }
  }

  return {
    index: -1,
    headerMap: new Map()
  };
}

function getValue(row, headerMap, aliases = []) {
  for (const alias of aliases) {
    const key = normalizeHeader(alias);

    if (headerMap.has(key)) {
      return row[headerMap.get(key)];
    }
  }

  return null;
}

function firstNumberFromTrailingColumns(row = [], startIndex = 0) {
  for (let index = startIndex; index < row.length; index += 1) {
    const value = row[index];

    if (value !== null && value !== undefined && cleanText(value) !== '') {
      return toNumber(value);
    }
  }

  return 0;
}

function secondNumberFromTrailingColumns(row = [], startIndex = 0) {
  let hits = 0;

  for (let index = startIndex; index < row.length; index += 1) {
    const value = row[index];

    if (value !== null && value !== undefined && cleanText(value) !== '') {
      hits += 1;

      if (hits === 2) return toNumber(value);
    }
  }

  return 0;
}

function buildHash(parts = []) {
  return crypto
    .createHash('sha256')
    .update(parts.map((part) => cleanText(part)).join('|'))
    .digest('hex');
}

function getFechaMinMax(filas, fieldName) {
  const fechas = filas
    .map((row) => row[fieldName])
    .filter(Boolean)
    .sort();

  return {
    fecha_min: fechas[0] || null,
    fecha_max: fechas[fechas.length - 1] || null
  };
}

export function parseReporteSurtidoresMayoreoExcel(buffer) {
  const { sheetName, rows } = getSheetRows(buffer, 'Convertido');
  const warnings = [];
  const hojas = [];

  if (!sheetName) {
    return {
      filas: [],
      warnings: ['El archivo no contiene hojas.'],
      hojas: [],
      resumen: {
        filas_leidas: 0,
        filas_validas: 0,
        surtidores_detectados: [],
        fecha_min: null,
        fecha_max: null,
        total_tp: 0,
        total_tickets: 0,
        total_neto: 0
      }
    };
  }

  const required = ['NoCotiz', 'Fecha', 'HrReg', 'Surt', 'Ticket', 'TP', 'Neto'];
  const headerInfo = findHeaderIndex(rows, required);

  if (headerInfo.index < 0) {
    return {
      filas: [],
      warnings: [`Hoja ${sheetName}: no se detectaron encabezados válidos de reporte mayoreo.`],
      hojas: [{ hoja: sheetName, procesada: false, filas: 0, motivo: 'Sin encabezados válidos' }],
      resumen: {
        filas_leidas: 0,
        filas_validas: 0,
        surtidores_detectados: [],
        fecha_min: null,
        fecha_max: null,
        total_tp: 0,
        total_tickets: 0,
        total_neto: 0
      }
    };
  }

  const filas = [];
  const dataRows = rows.slice(headerInfo.index + 1);
  let filasLeidas = 0;

  dataRows.forEach((row, rowOffset) => {
    if (!row || row.every((cell) => cleanText(cell) === '')) return;

    filasLeidas += 1;

    const noCotiz = cleanText(getValue(row, headerInfo.headerMap, ['NoCotiz']));
    const fecha = parseFecha(getValue(row, headerInfo.headerMap, ['Fecha']));
    const horaReporte = parseHora(getValue(row, headerInfo.headerMap, ['HrReg']));
    const codigoSurtidorReporte = normalizeCodigo(getValue(row, headerInfo.headerMap, ['Surt', 'Surtidor']));
    const ticket = cleanText(getValue(row, headerInfo.headerMap, ['Ticket']));
    const tp = toInteger(getValue(row, headerInfo.headerMap, ['TP']));
    const neto = toNumber(getValue(row, headerInfo.headerMap, ['Neto']));

    if (!noCotiz || !fecha) {
      warnings.push(`Hoja ${sheetName}, fila ${headerInfo.index + rowOffset + 2}: fila omitida por no tener NoCotiz o Fecha.`);
      return;
    }

    filas.push({
      no_cotiz: noCotiz,
      indicador_i: cleanText(getValue(row, headerInfo.headerMap, ['I'])),
      no_ref: cleanText(getValue(row, headerInfo.headerMap, ['NoRef'])),
      fecha,
      estatus_movimiento: cleanText(getValue(row, headerInfo.headerMap, ['E'])),
      hora_reporte: horaReporte,
      codigo_surtidor_reporte: codigoSurtidorReporte,
      cliente: cleanText(getValue(row, headerInfo.headerMap, ['Cliente'])),
      ticket,
      ticket_estado: cleanText(getValue(row, headerInfo.headerMap, ['E_1', 'Ticket Estado'])),
      tp,
      tur_fp: cleanText(getValue(row, headerInfo.headerMap, ['Tur FP', 'TurFP'])),
      ruta: cleanText(getValue(row, headerInfo.headerMap, ['Ruta'])),
      rack: cleanText(getValue(row, headerInfo.headerMap, ['Rack'])),
      subtotal: toNumber(getValue(row, headerInfo.headerMap, ['Sub Total', 'Subtotal'])),
      descuento: toNumber(getValue(row, headerInfo.headerMap, ['Desc', 'Descuento'])),
      neto,
      iva: toNumber(getValue(row, headerInfo.headerMap, ['IVA'])),
      total: toNumber(getValue(row, headerInfo.headerMap, ['Total']))
    });
  });

  const fechas = getFechaMinMax(filas, 'fecha');
  const surtidoresDetectados = [...new Set(filas.map((row) => row.codigo_surtidor_reporte).filter(Boolean))].sort();
  const tickets = new Set(filas.map((row) => row.ticket).filter(Boolean));

  hojas.push({
    hoja: sheetName,
    procesada: true,
    filas: filas.length,
    encabezado_fila: headerInfo.index + 1
  });

  return {
    filas,
    warnings,
    hojas,
    resumen: {
      filas_leidas: filasLeidas,
      filas_validas: filas.length,
      surtidores_detectados: surtidoresDetectados,
      ...fechas,
      total_tp: filas.reduce((acc, row) => acc + row.tp, 0),
      total_tickets: tickets.size,
      total_neto: Number(filas.reduce((acc, row) => acc + row.neto, 0).toFixed(2))
    }
  };
}

export function parseNegadosMayoreoExcel(buffer) {
  const { sheetName, rows } = getSheetRows(buffer, 'Convertido');
  const warnings = [];
  const hojas = [];

  if (!sheetName) {
    return {
      filas: [],
      warnings: ['El archivo no contiene hojas.'],
      hojas: [],
      resumen: {
        filas_leidas: 0,
        filas_validas: 0,
        surtidores_detectados: [],
        fecha_min: null,
        fecha_max: null,
        total_a_deber: 0
      }
    };
  }

  const required = ['Id_Producto', 'Producto', 'Surtidor', 'Fecha', 'A surtir', 'Surtido', 'A deber'];
  const headerInfo = findHeaderIndex(rows, required);

  if (headerInfo.index < 0) {
    return {
      filas: [],
      warnings: [`Hoja ${sheetName}: no se detectaron encabezados válidos de negados mayoreo.`],
      hojas: [{ hoja: sheetName, procesada: false, filas: 0, motivo: 'Sin encabezados válidos' }],
      resumen: {
        filas_leidas: 0,
        filas_validas: 0,
        surtidores_detectados: [],
        fecha_min: null,
        fecha_max: null,
        total_a_deber: 0
      }
    };
  }

  const filas = [];
  const dataRows = rows.slice(headerInfo.index + 1);
  let filasLeidas = 0;

  dataRows.forEach((row, rowOffset) => {
    if (!row || row.every((cell) => cleanText(cell) === '')) return;

    filasLeidas += 1;

    const codigoProducto = normalizeCodigo(getValue(row, headerInfo.headerMap, ['Id_Producto', 'Id Producto', 'Producto Codigo']));
    const producto = cleanText(getValue(row, headerInfo.headerMap, ['Producto']));
    const codigoSurtidorReporte = normalizeCodigo(getValue(row, headerInfo.headerMap, ['Surtidor', 'Surt']));
    const fechaRaw = getValue(row, headerInfo.headerMap, ['Fecha']);
    const parsedFechaHora = parseFechaHoraReporte(fechaRaw);
    const cantidadADeber = toInteger(getValue(row, headerInfo.headerMap, ['A deber', 'Negado']));

    if (!codigoProducto || !parsedFechaHora.fecha || cantidadADeber <= 0) {
      warnings.push(`Hoja ${sheetName}, fila ${headerInfo.index + rowOffset + 2}: fila omitida por no tener producto, fecha o cantidad a deber.`);
      return;
    }

    const invDespuesIndex = headerInfo.headerMap.get(normalizeHeader('Iinventario despues de Ticket'))
      ?? headerInfo.headerMap.get(normalizeHeader('Inventario despues de Ticket'));

    const valor1 = firstNumberFromTrailingColumns(row, invDespuesIndex !== undefined ? invDespuesIndex + 1 : 9);
    const valor2 = secondNumberFromTrailingColumns(row, invDespuesIndex !== undefined ? invDespuesIndex + 1 : 9);

    const hash = buildHash([
      parsedFechaHora.fecha_hora || parsedFechaHora.fecha,
      codigoSurtidorReporte,
      codigoProducto,
      producto,
      cantidadADeber,
      getValue(row, headerInfo.headerMap, ['A surtir']),
      getValue(row, headerInfo.headerMap, ['Surtido'])
    ]);

    filas.push({
      fecha_operativa: parsedFechaHora.fecha,
      fecha_hora_reporte: parsedFechaHora.fecha_hora,
      hora_reporte: parsedFechaHora.hora,
      codigo_surtidor_reporte: codigoSurtidorReporte,
      codigo_producto: codigoProducto,
      producto,
      cantidad_a_surtir: toInteger(getValue(row, headerInfo.headerMap, ['A surtir', 'Solic'])),
      cantidad_surtida: toInteger(getValue(row, headerInfo.headerMap, ['Surtido'])),
      cantidad_a_deber: cantidadADeber,
      inventario_anterior: toInteger(getValue(row, headerInfo.headerMap, ['Inventario anterior', 'Ex Hoy'])),
      inventario_despues_ticket: toInteger(getValue(row, headerInfo.headerMap, ['Iinventario despues de Ticket', 'Inventario despues de Ticket', 'ExSurt'])),
      valor_no_surtido_1: valor1,
      valor_no_surtido_2: valor2,
      hash_dedupe: hash
    });
  });

  const fechas = getFechaMinMax(filas, 'fecha_operativa');
  const surtidoresDetectados = [...new Set(filas.map((row) => row.codigo_surtidor_reporte).filter(Boolean))].sort();

  hojas.push({
    hoja: sheetName,
    procesada: true,
    filas: filas.length,
    encabezado_fila: headerInfo.index + 1
  });

  return {
    filas,
    warnings,
    hojas,
    resumen: {
      filas_leidas: filasLeidas,
      filas_validas: filas.length,
      surtidores_detectados: surtidoresDetectados,
      ...fechas,
      total_a_deber: filas.reduce((acc, row) => acc + row.cantidad_a_deber, 0)
    }
  };
}
