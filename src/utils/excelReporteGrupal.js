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

function convertirFecha(value) {
  if (!value) return null;

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }

  if (typeof value === 'number') {
    return excelSerialDateToYYYYMMDD(value);
  }

  const raw = String(value).trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw;
  }

  const matchDMY = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);

  if (matchDMY) {
    const dia = matchDMY[1].padStart(2, '0');
    const mes = matchDMY[2].padStart(2, '0');
    let anio = matchDMY[3];

    if (anio.length === 2) {
      anio = `20${anio}`;
    }

    return `${anio}-${mes}-${dia}`;
  }

  const parsed = new Date(raw);

  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
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
    'TOTAL_SURTIDO'
  ],
  partidas: [
    'PARTIDAS',
    'PARTIDA',
    'TOTAL_PARTIDAS'
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
    'NO_SURTIDO_NEGADOS',
    'NO_SURTIDO_Y_NEGADOS'
  ],
  porcentaje_surtido: [
    'PORCENTAJE_DE_SURTIDO',
    'PORCENTAJE_SURTIDO',
    'PORCENTAJE_S_DE_SURTIDO',
    'SURTIDO_PORCENTAJE',
    'PORCENTAJE'
  ]
};

function obtenerValorPorAlias(rowNormalizado, aliases) {
  for (const alias of aliases) {
    const key = normalizarTexto(alias);

    if (Object.prototype.hasOwnProperty.call(rowNormalizado, key)) {
      return rowNormalizado[key];
    }
  }

  return undefined;
}

function normalizarRow(row) {
  const normalizado = {};

  for (const [key, value] of Object.entries(row)) {
    normalizado[normalizarTexto(key)] = value;
  }

  return normalizado;
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
      rows: []
    };
  }

  const nombreHoja = sheetName && workbook.Sheets[sheetName]
    ? sheetName
    : workbook.SheetNames[0];

  const sheet = workbook.Sheets[nombreHoja];

  const rawRows = xlsx.utils.sheet_to_json(sheet, {
    defval: null,
    raw: false
  });

  const errores = [];
  const rows = [];

  rawRows.forEach((row, index) => {
    const filaExcel = index + 2;
    const normalizado = normalizarRow(row);

    const sucursalRaw = obtenerValorPorAlias(normalizado, ALIAS_COLUMNAS.sucursal);
    const sucursalNombre = String(sucursalRaw ?? '').trim();

    const fechaRaw = obtenerValorPorAlias(normalizado, ALIAS_COLUMNAS.fecha);
    const fecha = convertirFecha(fechaRaw) || convertirFecha(fechaDefault);

    const surtido = convertirEntero(
      obtenerValorPorAlias(normalizado, ALIAS_COLUMNAS.surtido),
      0
    );

    const partidas = convertirEntero(
      obtenerValorPorAlias(normalizado, ALIAS_COLUMNAS.partidas),
      0
    );

    const ceros = convertirEntero(
      obtenerValorPorAlias(normalizado, ALIAS_COLUMNAS.ceros),
      0
    );

    const noSurtido = convertirEntero(
      obtenerValorPorAlias(normalizado, ALIAS_COLUMNAS.no_surtido),
      0
    );

    const porcentajeSurtido = convertirPorcentaje(
      obtenerValorPorAlias(normalizado, ALIAS_COLUMNAS.porcentaje_surtido)
    );

    const filaVacia =
      !sucursalNombre &&
      !fecha &&
      surtido === 0 &&
      partidas === 0 &&
      ceros === 0 &&
      noSurtido === 0 &&
      porcentajeSurtido === null;

    if (filaVacia) {
      return;
    }

    if (!fecha) {
      errores.push({
        fila: filaExcel,
        campo: 'fecha',
        message: 'Fecha inválida o faltante'
      });
    }

    if (!sucursalNombre) {
      errores.push({
        fila: filaExcel,
        campo: 'sucursal',
        message: 'Sucursal faltante'
      });
    }

    rows.push({
      fila_excel: filaExcel,
      fecha,
      sucursal_nombre: sucursalNombre,
      sucursal_key: normalizarSucursal(sucursalNombre),
      surtido,
      partidas,
      ceros,
      no_surtido: noSurtido,
      porcentaje_surtido: porcentajeSurtido,
      fuente: 'EXCEL'
    });
  });

  return {
    ok: errores.length === 0,
    hoja: nombreHoja,
    total_filas_excel: rawRows.length,
    total_rows_validas: rows.length,
    errores,
    rows
  };
}

export function normalizarSucursalKey(value) {
  return normalizarSucursal(value);
}