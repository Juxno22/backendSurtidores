import xlsx from 'xlsx';

function normalizarTexto(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase()
    .replace(/[%]/g, ' PORCENTAJE ')
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function normalizarSucursal(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function convertirNumero(value, defaultValue = 0) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : defaultValue;
  }

  const limpio = String(value)
    .replace(/\$/g, '')
    .replace(/,/g, '')
    .replace(/%/g, '')
    .trim();

  if (!limpio) return defaultValue;

  const number = Number(limpio);

  if (Number.isNaN(number)) {
    return defaultValue;
  }

  return number;
}

function convertirEntero(value, defaultValue = 0) {
  const number = convertirNumero(value, defaultValue);

  if (!Number.isFinite(number)) return defaultValue;

  return Math.max(0, Math.round(number));
}

function convertirPorcentaje(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  let number = convertirNumero(value, null);

  if (number === null || Number.isNaN(number)) {
    return null;
  }

  /*
    Excel a veces guarda 98.5% como 0.985.
    Si viene <= 1, lo convertimos a porcentaje real.
  */
  if (number > 0 && number <= 1) {
    number = number * 100;
  }

  if (number < 0) number = 0;
  if (number > 100) number = 100;

  return Number(number.toFixed(2));
}

function excelSerialDateToYYYYMMDD(serial) {
  const utcDays = Math.floor(serial - 25569);
  const utcValue = utcDays * 86400;
  const date = new Date(utcValue * 1000);

  return date.toISOString().slice(0, 10);
}

function isValidDateParts(anio, mes, dia) {
  const y = Number(anio);
  const m = Number(mes);
  const d = Number(dia);

  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (y < 2000 || y > 2100) return false;
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > 31) return false;

  const date = new Date(Date.UTC(y, m - 1, d));

  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

function buildYYYYMMDD(anio, mes, dia, { allowSwap = true } = {}) {
  const y = String(anio).padStart(4, '0');
  const m = String(mes).padStart(2, '0');
  const d = String(dia).padStart(2, '0');

  if (isValidDateParts(y, m, d)) {
    return `${y}-${m}-${d}`;
  }

  /*
    Algunos reportes llegan con mes/día invertidos después de parsear Excel:
    2026-13-06 realmente corresponde a 2026-06-13.
    Lo corregimos solo cuando el mes es imposible y el día puede ser mes.
  */
  if (
    allowSwap &&
    Number(m) > 12 &&
    Number(d) >= 1 &&
    Number(d) <= 12 &&
    isValidDateParts(y, d, m)
  ) {
    return `${y}-${d}-${m}`;
  }

  return null;
}

function convertirFecha(value) {
  if (!value) return null;

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return buildYYYYMMDD(
      value.getFullYear(),
      value.getMonth() + 1,
      value.getDate()
    );
  }

  if (typeof value === 'number') {
    return excelSerialDateToYYYYMMDD(value);
  }

  const raw = String(value).trim();

  const exactYMD = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);

  if (exactYMD) {
    return buildYYYYMMDD(exactYMD[1], exactYMD[2], exactYMD[3]);
  }

  const matchDMY = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);

  if (matchDMY) {
    const dia = matchDMY[1].padStart(2, '0');
    const mes = matchDMY[2].padStart(2, '0');
    let anio = matchDMY[3];

    if (anio.length === 2) {
      anio = `20${anio}`;
    }

    return buildYYYYMMDD(anio, mes, dia);
  }

  const matchYMD = raw.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);

  if (matchYMD) {
    return buildYYYYMMDD(matchYMD[1], matchYMD[2], matchYMD[3]);
  }

  const matchTextDMY = raw.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);

  if (matchTextDMY) {
    const dia = matchTextDMY[1].padStart(2, '0');
    const mes = matchTextDMY[2].padStart(2, '0');
    let anio = matchTextDMY[3];

    if (anio.length === 2) {
      anio = `20${anio}`;
    }

    return buildYYYYMMDD(anio, mes, dia);
  }

  /*
    Evitamos que nombres de hoja como "1", "2" o "10" se interpreten
    como fechas raras por el parser nativo de JS. Esos casos se resuelven
    con fechaDesdeNombreHoja usando el mes/año de fechaDefault.
  */
  if (/^\d{1,2}$/.test(raw)) {
    return null;
  }

  const parsed = new Date(raw);

  if (!Number.isNaN(parsed.getTime())) {
    return buildYYYYMMDD(
      parsed.getFullYear(),
      parsed.getMonth() + 1,
      parsed.getDate()
    );
  }

  return null;
}

const ALIAS_COLUMNAS = {
  fecha: [
    'FECHA'
  ],
  sucursal: [
    'SUCURSAL',
    'SUCURSAL_DESTINO',
    'TIENDA',
    'PLAZA'
  ],
  surtido: [
    'SURTIDO',
    'TICKETS',
    'TICKETS_SURTIDOS',
    'TOTAL_SURTIDO',
    'SURTIDO_TOTAL'
  ],
  partidas: [
    'PARTIDAS',
    'PARTIDA',
    'TOTAL_PARTIDAS',
    'PARTIDAS_SURTIDAS',
    'PARTIDA_SURTIDA'
  ],
  ceros: [
    'CEROS',
    'CERO',
    'PARTIDAS_CERO',
    'PARTIDAS_EN_CERO'
  ],
  no_surtido: [
    'NO_SURTIDO',
    'NO_SURTIDOS',
    'NEGADOS',
    'NEGADO',
    'NO_SURTIDO_NEGADOS',
    'NO_SURTIDO_Y_NEGADOS'
  ],
  porcentaje_surtido: [
    'PORCENTAJE_DE_SURTIDO',
    'PORCENTAJE_SURTIDO',
    'PORCENTAJE_S_DE_SURTIDO',
    'SURTIDO_PORCENTAJE',
    'PORCENTAJE',
    'DE_SURTIDO'
  ]
};

const HOJAS_A_IGNORAR = [
  'DESCANSO',
  'DESCANSOS',
  'VACIO',
  'VACIA'
];

const FILAS_RESUMEN = new Set([
  'TOTAL',
  'TOTALES',
  'SUMA',
  'SUMAS',
  'GRAN_TOTAL',
  'TOTAL_GENERAL',
  'GENERAL'
]);

function findColumnIndex(headers, aliases) {
  return headers.findIndex((header) => aliases.some((alias) => header === normalizarTexto(alias)));
}

function detectarHeaderIndex(matrix) {
  const maxRows = Math.min(matrix.length, 25);

  for (let rowIndex = 0; rowIndex < maxRows; rowIndex += 1) {
    const headers = (matrix[rowIndex] || []).map(normalizarTexto);

    const tieneSucursal = findColumnIndex(headers, ALIAS_COLUMNAS.sucursal) >= 0;

    const metricas = [
      ALIAS_COLUMNAS.surtido,
      ALIAS_COLUMNAS.partidas,
      ALIAS_COLUMNAS.ceros,
      ALIAS_COLUMNAS.no_surtido,
      ALIAS_COLUMNAS.porcentaje_surtido
    ].filter((aliases) => findColumnIndex(headers, aliases) >= 0).length;

    if (tieneSucursal && metricas >= 2) {
      return rowIndex;
    }
  }

  return -1;
}

function detectarFechaHoja(matrix) {
  const maxRows = Math.min(matrix.length, 12);

  for (let rowIndex = 0; rowIndex < maxRows; rowIndex += 1) {
    const row = matrix[rowIndex] || [];
    const maxCols = Math.min(row.length, 10);

    for (let colIndex = 0; colIndex < maxCols; colIndex += 1) {
      const value = row[colIndex];
      const normalizado = normalizarTexto(value);

      if (!normalizado.includes('FECHA')) {
        continue;
      }

      const fechaEnCelda = convertirFecha(value);

      if (fechaEnCelda) {
        return fechaEnCelda;
      }

      for (let offset = 1; offset <= 4; offset += 1) {
        const fechaMismaFila = convertirFecha(row[colIndex + offset]);

        if (fechaMismaFila) {
          return fechaMismaFila;
        }
      }

      for (let offset = 1; offset <= 3; offset += 1) {
        const fechaAbajo = convertirFecha(matrix[rowIndex + offset]?.[colIndex]);

        if (fechaAbajo) {
          return fechaAbajo;
        }
      }
    }
  }

  return null;
}

function fechaDesdeNombreHoja(sheetName, fechaDefault = null) {
  const defaultFecha = convertirFecha(fechaDefault);
  const raw = String(sheetName || '').trim();

  if (!raw) return null;

  const fechaDirecta = convertirFecha(raw);

  if (fechaDirecta) {
    return fechaDirecta;
  }

  if (!defaultFecha) return null;

  const [anio, mes] = defaultFecha.split('-');
  const diaMatch = raw.match(/^(\d{1,2})$/);

  if (!diaMatch) return null;

  const dia = Number(diaMatch[1]);

  if (dia < 1 || dia > 31) return null;

  return buildYYYYMMDD(anio, mes, dia);
}

function elegirFechaHoja({ sheetName, matrix, fechaDefault }) {
  const fechaPorNombre = fechaDesdeNombreHoja(sheetName, fechaDefault);
  const fechaEnCeldas = detectarFechaHoja(matrix);

  /*
    En reportes acumulativos, las hojas suelen llamarse 5, 6, 13, etc.
    Si el usuario manda una fecha opcional para el mes, la hoja numérica
    manda sobre la fecha escrita en la celda, porque algunos archivos traen
    fechas capturadas con año incorrecto o mes/día invertidos.
  */
  if (/^\d{1,2}$/.test(String(sheetName || '').trim()) && fechaPorNombre) {
    return fechaPorNombre;
  }

  return fechaEnCeldas || fechaPorNombre || convertirFecha(fechaDefault);
}

function debeIgnorarHojaPorNombre(sheetName) {
  const normalizado = normalizarTexto(sheetName);

  return HOJAS_A_IGNORAR.some((keyword) => normalizado.includes(keyword));
}

function debeIgnorarSucursal(value) {
  const normalizado = normalizarSucursal(value);

  return FILAS_RESUMEN.has(normalizado);
}

function getCell(row, index) {
  if (index < 0) return undefined;

  return row[index];
}

function procesarHoja({ sheetName, sheet, fechaDefault }) {
  const matrix = xlsx.utils.sheet_to_json(sheet, {
    header: 1,
    defval: null,
    raw: false,
    blankrows: false
  });

  const errores = [];
  const warnings = [];
  const rows = [];

  if (!matrix.length) {
    return {
      ignorada: true,
      motivo: 'Hoja vacía',
      errores,
      warnings,
      rows,
      total_filas_excel: 0
    };
  }

  if (debeIgnorarHojaPorNombre(sheetName)) {
    return {
      ignorada: true,
      motivo: 'Hoja marcada como descanso/vacía',
      errores,
      warnings,
      rows,
      total_filas_excel: matrix.length
    };
  }

  const headerIndex = detectarHeaderIndex(matrix);

  if (headerIndex < 0) {
    return {
      ignorada: true,
      motivo: 'No se encontró encabezado de reporte grupal',
      errores,
      warnings,
      rows,
      total_filas_excel: matrix.length
    };
  }

  const headers = (matrix[headerIndex] || []).map(normalizarTexto);

  const col = {
    fecha: findColumnIndex(headers, ALIAS_COLUMNAS.fecha),
    sucursal: findColumnIndex(headers, ALIAS_COLUMNAS.sucursal),
    surtido: findColumnIndex(headers, ALIAS_COLUMNAS.surtido),
    partidas: findColumnIndex(headers, ALIAS_COLUMNAS.partidas),
    ceros: findColumnIndex(headers, ALIAS_COLUMNAS.ceros),
    no_surtido: findColumnIndex(headers, ALIAS_COLUMNAS.no_surtido),
    porcentaje_surtido: findColumnIndex(headers, ALIAS_COLUMNAS.porcentaje_surtido)
  };

  if (col.sucursal < 0) {
    errores.push({
      hoja: sheetName,
      fila: headerIndex + 1,
      campo: 'sucursal',
      message: 'No se encontró columna SUCURSAL'
    });
  }

  if (col.partidas < 0 || col.ceros < 0 || col.no_surtido < 0) {
    errores.push({
      hoja: sheetName,
      fila: headerIndex + 1,
      campo: 'columnas',
      message: 'El Excel debe traer PARTIDAS, CEROS y NO SURTIDO/NEGADOS'
    });
  }

  const fechaHoja = elegirFechaHoja({
    sheetName,
    matrix,
    fechaDefault
  });

  for (let rowIndex = headerIndex + 1; rowIndex < matrix.length; rowIndex += 1) {
    const row = matrix[rowIndex] || [];
    const filaExcel = rowIndex + 1;

    const sucursalRaw = getCell(row, col.sucursal);
    const sucursalNombre = String(sucursalRaw ?? '').trim();

    if (debeIgnorarSucursal(sucursalNombre)) {
      continue;
    }

    const fecha = convertirFecha(getCell(row, col.fecha)) || fechaHoja;

    const surtidoExcel = convertirEntero(getCell(row, col.surtido), 0);
    const partidas = convertirEntero(getCell(row, col.partidas), 0);
    const ceros = convertirEntero(getCell(row, col.ceros), 0);
    const noSurtido = convertirEntero(getCell(row, col.no_surtido), 0);
    const surtidoCalculado = partidas + ceros + noSurtido;

    const porcentajeSurtido = convertirPorcentaje(getCell(row, col.porcentaje_surtido));

    const filaVacia =
      !sucursalNombre &&
      !fecha &&
      surtidoExcel === 0 &&
      partidas === 0 &&
      ceros === 0 &&
      noSurtido === 0 &&
      porcentajeSurtido === null;

    if (filaVacia) {
      continue;
    }

    if (!fecha) {
      errores.push({
        hoja: sheetName,
        fila: filaExcel,
        campo: 'fecha',
        message: 'Fecha inválida o faltante'
      });
    }

    if (!sucursalNombre) {
      errores.push({
        hoja: sheetName,
        fila: filaExcel,
        campo: 'sucursal',
        message: 'Sucursal faltante'
      });
    }

    if (surtidoExcel > 0 && surtidoExcel !== surtidoCalculado) {
      warnings.push({
        hoja: sheetName,
        fila: filaExcel,
        campo: 'surtido',
        message: `El surtido del Excel (${surtidoExcel}) no coincide con partidas+ceros+negados (${surtidoCalculado}). Se usará el calculado.`
      });
    }

    rows.push({
      hoja: sheetName,
      fila_excel: filaExcel,
      fecha,
      sucursal_nombre: sucursalNombre,
      sucursal_key: normalizarSucursal(sucursalNombre),
      surtido: surtidoCalculado,
      surtido_excel: surtidoExcel,
      partidas,
      ceros,
      no_surtido: noSurtido,
      porcentaje_surtido: porcentajeSurtido,
      fuente: 'EXCEL'
    });
  }

  return {
    ignorada: false,
    motivo: null,
    errores,
    warnings,
    rows,
    header_fila: headerIndex + 1,
    fecha_detectada: fechaHoja,
    total_filas_excel: matrix.length
  };
}

function agruparRows(rows) {
  const map = new Map();

  for (const row of rows) {
    const key = `${row.fecha}::${row.sucursal_key}`;

    if (!map.has(key)) {
      map.set(key, {
        ...row,
        filas_origen: [`${row.hoja}:${row.fila_excel}`],
        registros_agrupados: 1
      });

      continue;
    }

    const actual = map.get(key);

    actual.surtido += row.surtido;
    actual.surtido_excel += row.surtido_excel;
    actual.partidas += row.partidas;
    actual.ceros += row.ceros;
    actual.no_surtido += row.no_surtido;
    actual.registros_agrupados += 1;
    actual.filas_origen.push(`${row.hoja}:${row.fila_excel}`);

    if (row.porcentaje_surtido !== null && row.porcentaje_surtido !== undefined) {
      actual.porcentaje_surtido = row.porcentaje_surtido;
    }
  }

  return [...map.values()].map((row) => ({
    ...row,
    origen: row.filas_origen.join(', ')
  }));
}

export function parseReporteGrupalExcel(buffer, options = {}) {
  const {
    fechaDefault = null,
    sheetName = null
  } = options;

  const workbook = xlsx.read(buffer, {
    type: 'buffer',
    cellDates: true
  });

  if (!workbook.SheetNames.length) {
    return {
      ok: false,
      errores: ['El archivo no contiene hojas'],
      warnings: [],
      rows: []
    };
  }

  const hojasSolicitadas = sheetName
    ? workbook.SheetNames.filter((nombre) => nombre === sheetName)
    : workbook.SheetNames;

  if (sheetName && hojasSolicitadas.length === 0) {
    return {
      ok: false,
      errores: [{
        hoja: sheetName,
        fila: null,
        campo: 'sheet',
        message: `No existe la hoja "${sheetName}" en el archivo`
      }],
      warnings: [],
      rows: []
    };
  }

  const errores = [];
  const warnings = [];
  const rowsDetalle = [];
  const hojasProcesadas = [];
  const hojasIgnoradas = [];

  for (const nombreHoja of hojasSolicitadas) {
    const resultadoHoja = procesarHoja({
      sheetName: nombreHoja,
      sheet: workbook.Sheets[nombreHoja],
      fechaDefault
    });

    errores.push(...resultadoHoja.errores);
    warnings.push(...resultadoHoja.warnings);

    if (resultadoHoja.ignorada) {
      hojasIgnoradas.push({
        hoja: nombreHoja,
        motivo: resultadoHoja.motivo,
        total_filas_excel: resultadoHoja.total_filas_excel
      });

      continue;
    }

    rowsDetalle.push(...resultadoHoja.rows);

    hojasProcesadas.push({
      hoja: nombreHoja,
      header_fila: resultadoHoja.header_fila,
      fecha_detectada: resultadoHoja.fecha_detectada,
      total_filas_excel: resultadoHoja.total_filas_excel,
      total_rows: resultadoHoja.rows.length
    });
  }

  const rows = agruparRows(rowsDetalle);
  const fechas = rows.map((row) => row.fecha).filter(Boolean).sort();

  return {
    ok: errores.length === 0,
    hoja: sheetName || null,
    hojas_procesadas: hojasProcesadas,
    hojas_ignoradas: hojasIgnoradas,
    total_hojas: workbook.SheetNames.length,
    total_hojas_procesadas: hojasProcesadas.length,
    total_hojas_ignoradas: hojasIgnoradas.length,
    total_filas_excel: rowsDetalle.length,
    total_rows_validas: rows.length,
    total_rows_detalle: rowsDetalle.length,
    fecha_min: fechas[0] || null,
    fecha_max: fechas[fechas.length - 1] || null,
    errores,
    warnings,
    rows,
    rows_detalle: rowsDetalle
  };
}

export function normalizarSucursalKey(value) {
  return normalizarSucursal(value);
}
