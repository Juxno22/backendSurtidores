import { pool } from '../config/db.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { registrarAuditoria } from '../utils/auditoria.js';
import {
  construirDetalleSurtidores,
  getJornadaDisponibleSegundosPorFechas
} from '../utils/productividadDetalle.js';
import {
  normalizeCodigo,
  parseNegadosMayoreoExcel,
  parseReporteSurtidoresMayoreoExcel
} from '../utils/excelMayoreo.js';

function validarFecha(value, fieldName = 'fecha') {
  const fecha = String(value || '').trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    const error = new Error(`${fieldName} debe tener formato YYYY-MM-DD`);
    error.status = 400;
    throw error;
  }

  return fecha;
}

function defaultRange(query = {}) {
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  const hoy = `${yyyy}-${mm}-${dd}`;

  const desde = validarFecha(query.desde || query.fecha || hoy, 'desde');
  const hasta = validarFecha(query.hasta || query.fecha || desde, 'hasta');

  return { desde, hasta };
}

function toPositiveId(value, fieldName, required = false) {
  if ((value === undefined || value === null || value === '') && !required) return null;

  const id = Number(value);

  if (!Number.isInteger(id) || id <= 0) {
    const error = new Error(`${fieldName} inválido`);
    error.status = 400;
    throw error;
  }

  return id;
}

function round2(value) {
  return Number(Number(value || 0).toFixed(2));
}

function uniqueSorted(values = []) {
  return [...new Set(values.filter(Boolean))].sort();
}


function uniqueDatesFromCsv(csv) {
  return String(csv || '')
    .split(',')
    .map((item) => item.trim().slice(0, 10))
    .filter(Boolean)
    .filter((value, index, arr) => arr.indexOf(value) === index)
    .sort();
}

async function buscarSurtidoresMayoreoPorCodigos(connection, codigos = []) {
  const cleanCodes = uniqueSorted(codigos.map((codigo) => normalizeCodigo(codigo)));

  if (!cleanCodes.length) return new Map();

  const [rows] = await connection.query(
    `
    SELECT
      s.id AS surtidor_id,
      s.usuario_id,
      s.codigo,
      s.codigo_reporte,
      s.tipo_operacion,
      s.activo AS surtidor_activo,
      u.nombre AS usuario_nombre,
      u.usuario,
      u.activo AS usuario_activo
    FROM surtidores s
    INNER JOIN usuarios u ON u.id = s.usuario_id
    WHERE s.tipo_operacion = 'MAYOREO'
      AND s.codigo_reporte IN (?)
    `,
    [cleanCodes]
  );

  const map = new Map();

  for (const row of rows) {
    map.set(normalizeCodigo(row.codigo_reporte), {
      surtidor_id: row.surtidor_id,
      usuario_id: row.usuario_id,
      usuario_nombre: row.usuario_nombre,
      usuario: row.usuario,
      reportable: Number(row.surtidor_activo) === 1 && Number(row.usuario_activo) === 1
    });
  }

  return map;
}

function resumenCodigos(parsed, surtidorMap) {
  const codigos = parsed.resumen.surtidores_detectados || [];
  const vinculados = codigos.filter((codigo) => surtidorMap.has(normalizeCodigo(codigo)));
  const reportables = codigos.filter((codigo) => surtidorMap.get(normalizeCodigo(codigo))?.reportable);
  const sinVincular = codigos.filter((codigo) => !surtidorMap.has(normalizeCodigo(codigo)));
  const noReportables = codigos.filter((codigo) => {
    const found = surtidorMap.get(normalizeCodigo(codigo));
    return found && !found.reportable;
  });

  return {
    codigos_vinculados: vinculados,
    codigos_reportables: reportables,
    codigos_sin_vincular: sinVincular,
    codigos_no_reportables: noReportables
  };
}


async function crearOActualizarNegadoSupervisorDesdeReporte(connection, fila, vinculo, mayoreoNegadoReporteId) {
  const cantidadNegada = Math.max(0, Number(fila.cantidad_a_deber || 0));

  if (!vinculo?.reportable || !vinculo?.surtidor_id || !vinculo?.usuario_id || cantidadNegada <= 0) {
    return false;
  }

  await connection.query(
    `
    INSERT INTO productividad_sesion_negados (
      sesion_id,
      surtidor_id,
      usuario_id,
      fecha_operativa,
      tipo_operacion,
      codigo_producto,
      producto,
      razon_codigo,
      razon_texto,
      linea,
      cantidad_negada,
      comentario_surtidor,
      origen,
      mayoreo_negado_reporte_id,
      estado_revision,
      penaliza
    )
    VALUES (
      NULL,
      ?,
      ?,
      ?,
      'MAYOREO',
      ?,
      ?,
      'REPORTE_MAYOREO',
      'Negado cargado desde reporte de mayoreo',
      'REPORTE_MAYOREO',
      ?,
      ?,
      'REPORTE_MAYOREO',
      ?,
      'PENDIENTE_REVISION',
      0
    )
    ON DUPLICATE KEY UPDATE
      surtidor_id = VALUES(surtidor_id),
      usuario_id = VALUES(usuario_id),
      fecha_operativa = VALUES(fecha_operativa),
      codigo_producto = VALUES(codigo_producto),
      producto = VALUES(producto),
      cantidad_negada = VALUES(cantidad_negada),
      comentario_surtidor = VALUES(comentario_surtidor),
      updated_at = CURRENT_TIMESTAMP
    `,
    [
      vinculo.surtidor_id,
      vinculo.usuario_id,
      fila.fecha_operativa,
      fila.codigo_producto,
      fila.producto || null,
      cantidadNegada,
      `Reporte mayoreo. A surtir: ${fila.cantidad_a_surtir || 0}; surtido: ${fila.cantidad_surtida || 0}; inventario anterior: ${fila.inventario_anterior || 0}; inventario después ticket: ${fila.inventario_despues_ticket || 0}.`,
      mayoreoNegadoReporteId
    ]
  );

  return true;
}


async function crearImportacion(connection, req, {
  archivoNombre,
  tipoImportacion,
  parsed,
  insertados = 0,
  actualizados = 0
}) {
  const filasLeidas = Number(parsed.resumen.filas_leidas || 0);
  const filasValidas = Number(parsed.filas.length || 0);
  const filasOmitidas = Math.max(0, filasLeidas - filasValidas);

  const [result] = await connection.query(
    `
    INSERT INTO mayoreo_reportes_importaciones (
      archivo_nombre,
      tipo_importacion,
      filas_leidas,
      filas_validas,
      filas_insertadas,
      filas_actualizadas,
      filas_omitidas,
      fecha_min,
      fecha_max,
      warnings_json,
      cargado_por
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      archivoNombre,
      tipoImportacion,
      filasLeidas,
      filasValidas,
      insertados,
      actualizados,
      filasOmitidas,
      parsed.resumen.fecha_min || null,
      parsed.resumen.fecha_max || null,
      JSON.stringify((parsed.warnings || []).slice(0, 250)),
      req.user.id
    ]
  );

  return result.insertId;
}

export const importarReporteSurtidoresMayoreo = asyncHandler(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      ok: false,
      message: 'Debes subir un archivo Excel'
    });
  }

  const parsed = parseReporteSurtidoresMayoreoExcel(req.file.buffer);
  const codigos = parsed.resumen.surtidores_detectados || [];
  const surtidorMap = await buscarSurtidoresMayoreoPorCodigos(pool, codigos);
  const codigosResumen = resumenCodigos(parsed, surtidorMap);
  const dryRun = String(req.query.dry_run || '') === '1';

  if (dryRun) {
    return res.json({
      ok: true,
      message: 'Archivo de reporte mayoreo validado correctamente',
      dry_run: true,
      resumen: {
        ...parsed.resumen,
        ...codigosResumen
      },
      hojas: parsed.hojas,
      warnings: parsed.warnings.slice(0, 150)
    });
  }

  if (!parsed.filas.length) {
    return res.status(400).json({
      ok: false,
      message: 'No se encontraron filas válidas para importar',
      resumen: parsed.resumen,
      hojas: parsed.hojas,
      warnings: parsed.warnings.slice(0, 150)
    });
  }

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const importacionId = await crearImportacion(connection, req, {
      archivoNombre: req.file.originalname,
      tipoImportacion: 'REPORTE_SURTIDO',
      parsed
    });

    let insertados = 0;
    let actualizados = 0;

    for (const fila of parsed.filas) {
      const vinculo = surtidorMap.get(normalizeCodigo(fila.codigo_surtidor_reporte));
      const reportable = vinculo?.reportable ? 1 : 0;

      const [result] = await connection.query(
        `
        INSERT INTO mayoreo_reportes_surtidores (
          importacion_id,
          fecha,
          hora_reporte,
          codigo_surtidor_reporte,
          surtidor_id,
          usuario_id,
          reportable,
          no_cotiz,
          indicador_i,
          no_ref,
          estatus_movimiento,
          cliente,
          ticket,
          ticket_estado,
          tp,
          tur_fp,
          ruta,
          rack,
          subtotal,
          descuento,
          neto,
          iva,
          total,
          archivo_nombre,
          fuente
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'EXCEL')
        ON DUPLICATE KEY UPDATE
          importacion_id = VALUES(importacion_id),
          fecha = VALUES(fecha),
          hora_reporte = VALUES(hora_reporte),
          codigo_surtidor_reporte = VALUES(codigo_surtidor_reporte),
          surtidor_id = VALUES(surtidor_id),
          usuario_id = VALUES(usuario_id),
          reportable = VALUES(reportable),
          indicador_i = VALUES(indicador_i),
          no_ref = VALUES(no_ref),
          estatus_movimiento = VALUES(estatus_movimiento),
          cliente = VALUES(cliente),
          ticket = VALUES(ticket),
          ticket_estado = VALUES(ticket_estado),
          tp = VALUES(tp),
          tur_fp = VALUES(tur_fp),
          ruta = VALUES(ruta),
          rack = VALUES(rack),
          subtotal = VALUES(subtotal),
          descuento = VALUES(descuento),
          neto = VALUES(neto),
          iva = VALUES(iva),
          total = VALUES(total),
          archivo_nombre = VALUES(archivo_nombre),
          fuente = 'EXCEL',
          updated_at = CURRENT_TIMESTAMP
        `,
        [
          importacionId,
          fila.fecha,
          fila.hora_reporte || null,
          fila.codigo_surtidor_reporte || null,
          vinculo?.surtidor_id || null,
          vinculo?.usuario_id || null,
          reportable,
          fila.no_cotiz,
          fila.indicador_i || null,
          fila.no_ref || null,
          fila.estatus_movimiento || null,
          fila.cliente || null,
          fila.ticket || null,
          fila.ticket_estado || null,
          fila.tp,
          fila.tur_fp || null,
          fila.ruta || null,
          fila.rack || null,
          fila.subtotal,
          fila.descuento,
          fila.neto,
          fila.iva,
          fila.total,
          req.file.originalname
        ]
      );

      if (result.affectedRows === 1) insertados += 1;
      if (result.affectedRows === 2) actualizados += 1;
    }

    await connection.query(
      `
      UPDATE mayoreo_reportes_importaciones
      SET filas_insertadas = ?, filas_actualizadas = ?
      WHERE id = ?
      `,
      [insertados, actualizados, importacionId]
    );

    await registrarAuditoria(connection, {
      req,
      modulo: 'MAYOREO',
      accion: 'IMPORTAR_REPORTE_SURTIDO_MAYOREO',
      entidad: 'mayoreo_reportes_importaciones',
      entidadId: importacionId,
      datosAntes: null,
      datosDespues: {
        archivo: req.file.originalname,
        resumen: parsed.resumen,
        insertados,
        actualizados,
        ...codigosResumen
      }
    });

    await connection.commit();

    res.status(201).json({
      ok: true,
      message: 'Reporte de surtidores mayoreo importado correctamente',
      importacion_id: importacionId,
      resumen: {
        ...parsed.resumen,
        insertados,
        actualizados,
        ...codigosResumen
      },
      hojas: parsed.hojas,
      warnings: parsed.warnings.slice(0, 150)
    });
  } catch (error) {
    try {
      await connection.rollback();
    } catch {}

    throw error;
  } finally {
    connection.release();
  }
});

export const importarNegadosMayoreo = asyncHandler(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      ok: false,
      message: 'Debes subir un archivo Excel'
    });
  }

  const parsed = parseNegadosMayoreoExcel(req.file.buffer);
  const codigos = parsed.resumen.surtidores_detectados || [];
  const surtidorMap = await buscarSurtidoresMayoreoPorCodigos(pool, codigos);
  const codigosResumen = resumenCodigos(parsed, surtidorMap);
  const dryRun = String(req.query.dry_run || '') === '1';

  if (dryRun) {
    return res.json({
      ok: true,
      message: 'Archivo de negados mayoreo validado correctamente',
      dry_run: true,
      resumen: {
        ...parsed.resumen,
        ...codigosResumen
      },
      hojas: parsed.hojas,
      warnings: parsed.warnings.slice(0, 150)
    });
  }

  if (!parsed.filas.length) {
    return res.status(400).json({
      ok: false,
      message: 'No se encontraron filas válidas para importar',
      resumen: parsed.resumen,
      hojas: parsed.hojas,
      warnings: parsed.warnings.slice(0, 150)
    });
  }

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const importacionId = await crearImportacion(connection, req, {
      archivoNombre: req.file.originalname,
      tipoImportacion: 'NEGADOS',
      parsed
    });

    let insertados = 0;
    let actualizados = 0;
    let enviadosSupervisor = 0;

    for (const fila of parsed.filas) {
      const vinculo = surtidorMap.get(normalizeCodigo(fila.codigo_surtidor_reporte));
      const reportable = vinculo?.reportable ? 1 : 0;

      const [result] = await connection.query(
        `
        INSERT INTO mayoreo_negados_reporte (
          importacion_id,
          fecha_operativa,
          fecha_hora_reporte,
          hora_reporte,
          codigo_surtidor_reporte,
          surtidor_id,
          usuario_id,
          reportable,
          codigo_producto,
          producto,
          cantidad_a_surtir,
          cantidad_surtida,
          cantidad_a_deber,
          inventario_anterior,
          inventario_despues_ticket,
          valor_no_surtido_1,
          valor_no_surtido_2,
          hash_dedupe,
          archivo_nombre,
          fuente
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'EXCEL')
        ON DUPLICATE KEY UPDATE
          importacion_id = VALUES(importacion_id),
          fecha_operativa = VALUES(fecha_operativa),
          fecha_hora_reporte = VALUES(fecha_hora_reporte),
          hora_reporte = VALUES(hora_reporte),
          codigo_surtidor_reporte = VALUES(codigo_surtidor_reporte),
          surtidor_id = VALUES(surtidor_id),
          usuario_id = VALUES(usuario_id),
          reportable = VALUES(reportable),
          codigo_producto = VALUES(codigo_producto),
          producto = VALUES(producto),
          cantidad_a_surtir = VALUES(cantidad_a_surtir),
          cantidad_surtida = VALUES(cantidad_surtida),
          cantidad_a_deber = VALUES(cantidad_a_deber),
          inventario_anterior = VALUES(inventario_anterior),
          inventario_despues_ticket = VALUES(inventario_despues_ticket),
          valor_no_surtido_1 = VALUES(valor_no_surtido_1),
          valor_no_surtido_2 = VALUES(valor_no_surtido_2),
          archivo_nombre = VALUES(archivo_nombre),
          fuente = 'EXCEL',
          updated_at = CURRENT_TIMESTAMP
        `,
        [
          importacionId,
          fila.fecha_operativa,
          fila.fecha_hora_reporte,
          fila.hora_reporte || null,
          fila.codigo_surtidor_reporte || null,
          vinculo?.surtidor_id || null,
          vinculo?.usuario_id || null,
          reportable,
          fila.codigo_producto,
          fila.producto || null,
          fila.cantidad_a_surtir,
          fila.cantidad_surtida,
          fila.cantidad_a_deber,
          fila.inventario_anterior,
          fila.inventario_despues_ticket,
          fila.valor_no_surtido_1,
          fila.valor_no_surtido_2,
          fila.hash_dedupe,
          req.file.originalname
        ]
      );

      if (result.affectedRows === 1) insertados += 1;
      if (result.affectedRows === 2) actualizados += 1;

      const [negadoReporteRows] = await connection.query(
        `
        SELECT id
        FROM mayoreo_negados_reporte
        WHERE hash_dedupe = ?
        LIMIT 1
        `,
        [fila.hash_dedupe]
      );

      const enviado = await crearOActualizarNegadoSupervisorDesdeReporte(
        connection,
        fila,
        vinculo,
        negadoReporteRows[0]?.id || null
      );

      if (enviado) enviadosSupervisor += 1;
    }

    await connection.query(
      `
      UPDATE mayoreo_reportes_importaciones
      SET filas_insertadas = ?, filas_actualizadas = ?
      WHERE id = ?
      `,
      [insertados, actualizados, importacionId]
    );

    await registrarAuditoria(connection, {
      req,
      modulo: 'MAYOREO',
      accion: 'IMPORTAR_NEGADOS_MAYOREO',
      entidad: 'mayoreo_reportes_importaciones',
      entidadId: importacionId,
      datosAntes: null,
      datosDespues: {
        archivo: req.file.originalname,
        resumen: parsed.resumen,
        insertados,
        actualizados,
        enviados_supervisor: enviadosSupervisor,
        ...codigosResumen
      }
    });

    await connection.commit();

    res.status(201).json({
      ok: true,
      message: 'Reporte de negados mayoreo importado correctamente',
      importacion_id: importacionId,
      resumen: {
        ...parsed.resumen,
        insertados,
        actualizados,
        enviados_supervisor: enviadosSupervisor,
        ...codigosResumen
      },
      hojas: parsed.hojas,
      warnings: parsed.warnings.slice(0, 150)
    });
  } catch (error) {
    try {
      await connection.rollback();
    } catch {}

    throw error;
  } finally {
    connection.release();
  }
});

export const resumenMayoreo = asyncHandler(async (req, res) => {
  const { desde, hasta } = defaultRange(req.query);

  const [produccionRows] = await pool.query(
    `
    SELECT
      mrs.surtidor_id,
      mrs.usuario_id,
      s.codigo AS surtidor_codigo,
      s.codigo_reporte,
      u.nombre AS surtidor_nombre,
      u.usuario,
      COUNT(DISTINCT mrs.ticket) AS tickets,
      COALESCE(SUM(mrs.tp), 0) AS partidas_oficiales,
      COALESCE(SUM(mrs.neto), 0) AS neto,
      COUNT(*) AS movimientos,
      GROUP_CONCAT(DISTINCT DATE_FORMAT(mrs.fecha, '%Y-%m-%d') ORDER BY mrs.fecha SEPARATOR ',') AS fechas_reporte
    FROM mayoreo_reportes_surtidores mrs
    INNER JOIN surtidores s ON s.id = mrs.surtidor_id
    INNER JOIN usuarios u ON u.id = mrs.usuario_id
    WHERE mrs.reportable = 1
      AND mrs.fecha BETWEEN ? AND ?
    GROUP BY
      mrs.surtidor_id,
      mrs.usuario_id,
      s.codigo,
      s.codigo_reporte,
      u.nombre,
      u.usuario
    ORDER BY partidas_oficiales DESC, tickets DESC
    `,
    [desde, hasta]
  );

  const [negadosExcelRows] = await pool.query(
    `
    SELECT
      surtidor_id,
      COALESCE(SUM(cantidad_a_deber), 0) AS negados_excel
    FROM mayoreo_negados_reporte
    WHERE reportable = 1
      AND fecha_operativa BETWEEN ? AND ?
    GROUP BY surtidor_id
    `,
    [desde, hasta]
  );

  const [negadosDeclaradosRows] = await pool.query(
    `
    SELECT
      surtidor_id,
      COALESCE(SUM(CASE WHEN estado_revision = 'PENDIENTE_REVISION' THEN cantidad_negada ELSE 0 END), 0) AS negados_pendientes,
      COALESCE(SUM(CASE WHEN estado_revision = 'VALIDADO_NO_PENALIZA' THEN cantidad_negada ELSE 0 END), 0) AS negados_no_penalizan,
      COALESCE(SUM(CASE WHEN estado_revision = 'RECHAZADO_PENALIZA' THEN cantidad_negada ELSE 0 END), 0) AS negados_penalizables
    FROM productividad_sesion_negados
    WHERE tipo_operacion = 'MAYOREO'
      AND fecha_operativa BETWEEN ? AND ?
    GROUP BY surtidor_id
    `,
    [desde, hasta]
  );

  const excelMap = new Map(negadosExcelRows.map((row) => [row.surtidor_id, Number(row.negados_excel || 0)]));
  const declaradosMap = new Map(negadosDeclaradosRows.map((row) => [row.surtidor_id, row]));

  const ranking = produccionRows.map((row) => {
    const declarados = declaradosMap.get(row.surtidor_id) || {};
    const partidasOficiales = Number(row.partidas_oficiales || 0);
    const negadosPenalizables = Number(declarados.negados_penalizables || 0);

    return {
      surtidor_id: row.surtidor_id,
      usuario_id: row.usuario_id,
      surtidor_codigo: row.surtidor_codigo,
      codigo_reporte: row.codigo_reporte,
      surtidor_nombre: row.surtidor_nombre,
      usuario: row.usuario,
      movimientos: Number(row.movimientos || 0),
      tickets: Number(row.tickets || 0),
      partidas_oficiales: partidasOficiales,
      negados_excel: Number(excelMap.get(row.surtidor_id) || 0),
      negados_pendientes: Number(declarados.negados_pendientes || 0),
      negados_no_penalizan: Number(declarados.negados_no_penalizan || 0),
      negados_penalizables: negadosPenalizables,
      partidas_netas: Math.max(0, partidasOficiales - negadosPenalizables),
      neto: round2(row.neto)
    };
  });

  const resumen = ranking.reduce((acc, row) => {
    acc.surtidores += 1;
    acc.movimientos += row.movimientos;
    acc.tickets += row.tickets;
    acc.partidas_oficiales += row.partidas_oficiales;
    acc.partidas_netas += row.partidas_netas;
    acc.negados_excel += row.negados_excel;
    acc.negados_pendientes += row.negados_pendientes;
    acc.negados_penalizables += row.negados_penalizables;
    acc.neto += row.neto;
    return acc;
  }, {
    surtidores: 0,
    movimientos: 0,
    tickets: 0,
    partidas_oficiales: 0,
    partidas_netas: 0,
    negados_excel: 0,
    negados_pendientes: 0,
    negados_penalizables: 0,
    neto: 0
  });

  resumen.neto = round2(resumen.neto);

  res.json({
    ok: true,
    filtros: { desde, hasta },
    resumen,
    ranking
  });
});



export const productividadMayoreo = asyncHandler(async (req, res) => {
  const { desde, hasta } = defaultRange(req.query);
  const surtidorId = toPositiveId(req.query.surtidor_id, 'surtidor_id', false);

  const produccionWhere = [
    'mrs.reportable = 1',
    'mrs.fecha BETWEEN ? AND ?'
  ];
  const produccionParams = [desde, hasta];

  if (surtidorId) {
    produccionWhere.push('mrs.surtidor_id = ?');
    produccionParams.push(surtidorId);
  }

  const [produccionRows] = await pool.query(
    `
    SELECT
      mrs.surtidor_id,
      mrs.usuario_id,
      s.codigo AS surtidor_codigo,
      s.codigo_reporte,
      u.nombre AS surtidor_nombre,
      u.usuario,
      COUNT(*) AS movimientos,
      COUNT(DISTINCT mrs.ticket) AS tickets,
      COALESCE(SUM(mrs.tp), 0) AS partidas_oficiales,
      COALESCE(SUM(mrs.neto), 0) AS neto,
      MIN(mrs.fecha) AS fecha_min,
      MAX(mrs.fecha) AS fecha_max,
      GROUP_CONCAT(DISTINCT DATE_FORMAT(mrs.fecha, '%Y-%m-%d') ORDER BY mrs.fecha SEPARATOR ',') AS fechas_reporte
    FROM mayoreo_reportes_surtidores mrs
    INNER JOIN surtidores s ON s.id = mrs.surtidor_id
    INNER JOIN usuarios u ON u.id = mrs.usuario_id
    WHERE ${produccionWhere.join(' AND ')}
    GROUP BY
      mrs.surtidor_id,
      mrs.usuario_id,
      s.codigo,
      s.codigo_reporte,
      u.nombre,
      u.usuario
    `,
    produccionParams
  );

  const sesionesWhere = [
    'ps.estado = "FINALIZADO"',
    "ps.tipo_operacion = 'MAYOREO'",
    'ps.fecha_operativa BETWEEN ? AND ?',
    's.activo = 1',
    'u.activo = 1'
  ];
  const sesionesParams = [desde, hasta];

  if (surtidorId) {
    sesionesWhere.push('ps.surtidor_id = ?');
    sesionesParams.push(surtidorId);
  }

  const [sesionesRows] = await pool.query(
    `
    SELECT
      ps.id,
      ps.surtidor_id,
      ps.usuario_id,
      u.nombre AS surtidor_nombre,
      u.usuario AS surtidor_usuario,
      s.codigo AS surtidor_codigo,
      s.codigo_reporte AS surtidor_codigo_reporte,
      s.tipo_operacion AS surtidor_tipo_operacion,
      ps.tipo_operacion,
      ps.sucursal_id,
      NULL AS sucursal_nombre,
      DATE_FORMAT(ps.fecha_operativa, '%Y-%m-%d') AS fecha_operativa,
      DATE_FORMAT(ps.hora_inicio, '%Y-%m-%d %H:%i:%s') AS hora_inicio,
      DATE_FORMAT(ps.hora_fin, '%Y-%m-%d %H:%i:%s') AS hora_fin,
      ps.tickets AS surtido_total_guardado,
      ps.partidas AS partidas_surtidas,
      ps.ceros,
      ps.no_surtido AS negados,
      ps.duracion_segundos,
      ps.duracion_laboral_segundos,
      ps.observaciones,
      DATE_FORMAT(ps.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
      DATE_FORMAT(ps.updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at
    FROM productividad_sesiones ps
    INNER JOIN surtidores s ON s.id = ps.surtidor_id
    INNER JOIN usuarios u ON u.id = s.usuario_id
    WHERE ${sesionesWhere.join(' AND ')}
    ORDER BY ps.fecha_operativa ASC, ps.surtidor_id ASC, ps.hora_inicio ASC
    `,
    sesionesParams
  );

  const detalleSesiones = construirDetalleSurtidores(sesionesRows);
  const sesionesMap = new Map(
    detalleSesiones.ranking.map((row) => [Number(row.surtidor_id), row])
  );

  const negadosWhere = [
    "psn.tipo_operacion = 'MAYOREO'",
    'psn.fecha_operativa BETWEEN ? AND ?'
  ];
  const negadosParams = [desde, hasta];

  if (surtidorId) {
    negadosWhere.push('psn.surtidor_id = ?');
    negadosParams.push(surtidorId);
  }

  const [negadosDeclaradosRows] = await pool.query(
    `
    SELECT
      psn.surtidor_id,
      COALESCE(SUM(CASE WHEN psn.estado_revision = 'PENDIENTE_REVISION' THEN psn.cantidad_negada ELSE 0 END), 0) AS negados_pendientes,
      COALESCE(SUM(CASE WHEN psn.estado_revision = 'VALIDADO_NO_PENALIZA' THEN psn.cantidad_negada ELSE 0 END), 0) AS negados_no_penalizan,
      COALESCE(SUM(CASE WHEN psn.estado_revision = 'RECHAZADO_PENALIZA' THEN psn.cantidad_negada ELSE 0 END), 0) AS negados_penalizables,
      COUNT(*) AS negados_declaraciones
    FROM productividad_sesion_negados psn
    WHERE ${negadosWhere.join(' AND ')}
    GROUP BY psn.surtidor_id
    `,
    negadosParams
  );

  const [negadosExcelRows] = await pool.query(
    `
    SELECT
      mnr.surtidor_id,
      COALESCE(SUM(mnr.cantidad_a_deber), 0) AS negados_excel
    FROM mayoreo_negados_reporte mnr
    WHERE mnr.reportable = 1
      AND mnr.fecha_operativa BETWEEN ? AND ?
      ${surtidorId ? 'AND mnr.surtidor_id = ?' : ''}
    GROUP BY mnr.surtidor_id
    `,
    surtidorId ? [desde, hasta, surtidorId] : [desde, hasta]
  );

  const negadosDeclaradosMap = new Map(
    negadosDeclaradosRows.map((row) => [Number(row.surtidor_id), row])
  );
  const negadosExcelMap = new Map(
    negadosExcelRows.map((row) => [Number(row.surtidor_id), Number(row.negados_excel || 0)])
  );

  const map = new Map();

  function ensureSurtidor(key, base = {}) {
    const normalizedKey = Number(key);

    if (!map.has(normalizedKey)) {
      map.set(normalizedKey, {
        surtidor_id: normalizedKey,
        usuario_id: base.usuario_id || null,
        surtidor_codigo: base.surtidor_codigo || null,
        codigo_reporte: base.codigo_reporte || base.surtidor_codigo_reporte || null,
        surtidor_nombre: base.surtidor_nombre || 'Sin producción oficial',
        usuario: base.usuario || base.surtidor_usuario || null,

        movimientos: 0,
        tickets: 0,
        partidas_oficiales: 0,
        neto: 0,
        fechas_reporte_set: new Set(),
        jornada_reporte_segundos: 0,

        sesiones: 0,
        surtido_capturado: 0,
        partidas_capturadas: 0,
        tiempo_activo_segundos: 0,
        tiempo_muerto_segundos: 0,
        jornada_disponible_segundos: 0,

        negados_excel: 0,
        negados_pendientes: 0,
        negados_no_penalizan: 0,
        negados_penalizables: 0,
        negados_declaraciones: 0
      });
    }

    const item = map.get(normalizedKey);
    item.usuario_id = item.usuario_id || base.usuario_id || null;
    item.surtidor_codigo = item.surtidor_codigo || base.surtidor_codigo || null;
    item.codigo_reporte = item.codigo_reporte || base.codigo_reporte || base.surtidor_codigo_reporte || null;
    item.surtidor_nombre = item.surtidor_nombre === 'Sin producción oficial'
      ? (base.surtidor_nombre || item.surtidor_nombre)
      : item.surtidor_nombre;
    item.usuario = item.usuario || base.usuario || base.surtidor_usuario || null;

    return item;
  }

  for (const row of produccionRows) {
    const item = ensureSurtidor(row.surtidor_id, row);
    item.movimientos += Number(row.movimientos || 0);
    item.tickets += Number(row.tickets || 0);
    item.partidas_oficiales += Number(row.partidas_oficiales || 0);
    item.neto += Number(row.neto || 0);
    uniqueDatesFromCsv(row.fechas_reporte).forEach((fecha) => item.fechas_reporte_set.add(fecha));
  }

  for (const row of detalleSesiones.ranking) {
    const item = ensureSurtidor(row.surtidor_id, row);
    item.sesiones += Number(row.sesiones || 0);
    item.surtido_capturado += Number(row.surtido_total || 0);
    item.partidas_capturadas += Number(row.partidas_surtidas || 0);
    item.tiempo_activo_segundos += Number(row.tiempo_activo_segundos || 0);
    item.tiempo_muerto_segundos += Number(row.tiempo_muerto_segundos || 0);
    item.jornada_disponible_segundos += Number(row.jornada_disponible_segundos || 0);
  }

  for (const [surtidorKey, item] of map.entries()) {
    const declarados = negadosDeclaradosMap.get(Number(surtidorKey)) || {};

    item.negados_excel = Number(negadosExcelMap.get(Number(surtidorKey)) || 0);
    item.negados_pendientes = Number(declarados.negados_pendientes || 0);
    item.negados_no_penalizan = Number(declarados.negados_no_penalizan || 0);
    item.negados_penalizables = Number(declarados.negados_penalizables || 0);
    item.negados_declaraciones = Number(declarados.negados_declaraciones || 0);
  }

  const ranking = [...map.values()].map((item) => {
    const partidasNetas = Math.max(0, Number(item.partidas_oficiales || 0) - Number(item.negados_penalizables || 0));
    const fechasReporte = [...(item.fechas_reporte_set || new Set())].sort();
    const jornadaReporteSegundos = getJornadaDisponibleSegundosPorFechas(fechasReporte, 'MAYOREO');
    const horasActivas = Number(item.tiempo_activo_segundos || 0) / 3600;
    const horasJornadaApp = Number(item.jornada_disponible_segundos || 0) / 3600;
    const horasReporte = jornadaReporteSegundos / 3600;
    const modoProductividad = Number(item.tiempo_activo_segundos || 0) > 0
      ? 'APP_TIEMPO_REAL'
      : 'REPORTE_JORNADA';

    const partidasPorHoraApp = horasActivas ? round2(partidasNetas / horasActivas) : 0;
    const partidasPorHoraReporte = horasReporte ? round2(partidasNetas / horasReporte) : 0;

    return {
      ...item,
      fechas_reporte: fechasReporte,
      neto: round2(item.neto),
      partidas_netas: partidasNetas,
      jornada_reporte_segundos: jornadaReporteSegundos,
      jornada_reporte_horas: round2(horasReporte),
      tiempo_activo_horas: round2(horasActivas),
      tiempo_muerto_horas: round2(Number(item.tiempo_muerto_segundos || 0) / 3600),
      jornada_disponible_horas: round2(horasJornadaApp),
      partidas_netas_por_hora_activa: partidasPorHoraApp,
      partidas_netas_por_hora_reporte: partidasPorHoraReporte,
      partidas_netas_por_hora_jornada: horasJornadaApp ? round2(partidasNetas / horasJornadaApp) : 0,
      partidas_netas_por_hora_calculo: modoProductividad === 'APP_TIEMPO_REAL' ? partidasPorHoraApp : partidasPorHoraReporte,
      modo_productividad: modoProductividad,
      productividad_conciliada: Boolean(Number(item.partidas_oficiales || 0) && Number(item.tiempo_activo_segundos || 0)),
      bloqueado_por_negados_pendientes: Number(item.negados_pendientes || 0) > 0
    };
  }).sort((a, b) => {
    return b.partidas_netas_por_hora_calculo - a.partidas_netas_por_hora_calculo ||
      b.partidas_netas - a.partidas_netas ||
      b.tickets - a.tickets;
  });

  const resumen = ranking.reduce((acc, row) => {
    acc.surtidores += 1;
    acc.surtidores_con_produccion += row.partidas_oficiales > 0 ? 1 : 0;
    acc.surtidores_con_sesiones += row.sesiones > 0 ? 1 : 0;
    acc.movimientos += row.movimientos;
    acc.tickets += row.tickets;
    acc.partidas_oficiales += row.partidas_oficiales;
    acc.partidas_netas += row.partidas_netas;
    acc.neto += row.neto;
    acc.sesiones += row.sesiones;
    acc.surtido_capturado += row.surtido_capturado;
    acc.partidas_capturadas += row.partidas_capturadas;
    acc.tiempo_activo_segundos += row.tiempo_activo_segundos;
    acc.tiempo_muerto_segundos += row.tiempo_muerto_segundos;
    acc.jornada_disponible_segundos += row.jornada_disponible_segundos;
    acc.jornada_reporte_segundos += row.jornada_reporte_segundos;
    acc.negados_excel += row.negados_excel;
    acc.negados_pendientes += row.negados_pendientes;
    acc.negados_no_penalizan += row.negados_no_penalizan;
    acc.negados_penalizables += row.negados_penalizables;
    return acc;
  }, {
    surtidores: 0,
    surtidores_con_produccion: 0,
    surtidores_con_sesiones: 0,
    movimientos: 0,
    tickets: 0,
    partidas_oficiales: 0,
    partidas_netas: 0,
    neto: 0,
    sesiones: 0,
    surtido_capturado: 0,
    partidas_capturadas: 0,
    tiempo_activo_segundos: 0,
    tiempo_muerto_segundos: 0,
    jornada_disponible_segundos: 0,
    jornada_reporte_segundos: 0,
    negados_excel: 0,
    negados_pendientes: 0,
    negados_no_penalizan: 0,
    negados_penalizables: 0
  });

  resumen.neto = round2(resumen.neto);
  resumen.tiempo_activo_horas = round2(resumen.tiempo_activo_segundos / 3600);
  resumen.tiempo_muerto_horas = round2(resumen.tiempo_muerto_segundos / 3600);
  resumen.jornada_disponible_horas = round2(resumen.jornada_disponible_segundos / 3600);
  resumen.jornada_reporte_horas = round2(resumen.jornada_reporte_segundos / 3600);
  resumen.partidas_netas_por_hora_activa = resumen.tiempo_activo_segundos
    ? round2(resumen.partidas_netas / (resumen.tiempo_activo_segundos / 3600))
    : 0;
  resumen.partidas_netas_por_hora_jornada = resumen.jornada_disponible_segundos
    ? round2(resumen.partidas_netas / (resumen.jornada_disponible_segundos / 3600))
    : 0;
  resumen.partidas_netas_por_hora_reporte = resumen.jornada_reporte_segundos
    ? round2(resumen.partidas_netas / (resumen.jornada_reporte_segundos / 3600))
    : 0;

  res.json({
    ok: true,
    filtros: { desde, hasta, surtidor_id: surtidorId },
    resumen,
    ranking,
    sesiones: detalleSesiones.sesiones
  });
});

export const listarReportesSurtidoresMayoreo = asyncHandler(async (req, res) => {
  const { desde, hasta } = defaultRange(req.query);
  const surtidorId = toPositiveId(req.query.surtidor_id, 'surtidor_id', false);
  const soloNoVinculados = String(req.query.no_vinculados || '') === '1';
  const limit = Math.min(Number(req.query.limit || 300), 1000);

  const where = ['mrs.fecha BETWEEN ? AND ?'];
  const params = [desde, hasta];

  if (surtidorId) {
    where.push('mrs.surtidor_id = ?');
    params.push(surtidorId);
  }

  if (soloNoVinculados) {
    where.push('(mrs.surtidor_id IS NULL OR mrs.reportable = 0)');
  }

  params.push(limit);

  const [rows] = await pool.query(
    `
    SELECT
      mrs.id,
      DATE_FORMAT(mrs.fecha, '%Y-%m-%d') AS fecha,
      mrs.hora_reporte,
      mrs.codigo_surtidor_reporte,
      mrs.surtidor_id,
      mrs.usuario_id,
      COALESCE(u.nombre, 'No vinculado') AS surtidor_nombre,
      u.usuario,
      mrs.reportable,
      mrs.no_cotiz,
      mrs.cliente,
      mrs.ticket,
      mrs.tp,
      mrs.neto,
      mrs.total,
      mrs.archivo_nombre
    FROM mayoreo_reportes_surtidores mrs
    LEFT JOIN surtidores s ON s.id = mrs.surtidor_id
    LEFT JOIN usuarios u ON u.id = mrs.usuario_id
    WHERE ${where.join(' AND ')}
    ORDER BY mrs.fecha DESC, mrs.id DESC
    LIMIT ?
    `,
    params
  );

  res.json({
    ok: true,
    filtros: { desde, hasta, surtidor_id: surtidorId, no_vinculados: soloNoVinculados },
    reportes: rows
  });
});

export const listarNegadosMayoreo = asyncHandler(async (req, res) => {
  const { desde, hasta } = defaultRange(req.query);
  const surtidorId = toPositiveId(req.query.surtidor_id, 'surtidor_id', false);
  const soloNoVinculados = String(req.query.no_vinculados || '') === '1';
  const limit = Math.min(Number(req.query.limit || 300), 1000);

  const where = ['mnr.fecha_operativa BETWEEN ? AND ?'];
  const params = [desde, hasta];

  if (surtidorId) {
    where.push('mnr.surtidor_id = ?');
    params.push(surtidorId);
  }

  if (soloNoVinculados) {
    where.push('(mnr.surtidor_id IS NULL OR mnr.reportable = 0)');
  }

  params.push(limit);

  const [rows] = await pool.query(
    `
    SELECT
      mnr.id,
      DATE_FORMAT(mnr.fecha_operativa, '%Y-%m-%d') AS fecha_operativa,
      DATE_FORMAT(mnr.fecha_hora_reporte, '%Y-%m-%d %H:%i:%s') AS fecha_hora_reporte,
      mnr.hora_reporte,
      mnr.codigo_surtidor_reporte,
      mnr.surtidor_id,
      mnr.usuario_id,
      COALESCE(u.nombre, 'No vinculado') AS surtidor_nombre,
      u.usuario,
      mnr.reportable,
      mnr.codigo_producto,
      mnr.producto,
      mnr.cantidad_a_surtir,
      mnr.cantidad_surtida,
      mnr.cantidad_a_deber,
      mnr.inventario_anterior,
      mnr.inventario_despues_ticket,
      mnr.archivo_nombre,
      COALESCE(psn.declarados, 0) AS negados_declarados_mismo_dia_producto,
      COALESCE(psn.pendientes, 0) AS declarados_pendientes,
      COALESCE(psn.penalizables, 0) AS declarados_penalizables
    FROM mayoreo_negados_reporte mnr
    LEFT JOIN surtidores s ON s.id = mnr.surtidor_id
    LEFT JOIN usuarios u ON u.id = mnr.usuario_id
    LEFT JOIN (
      SELECT
        surtidor_id,
        fecha_operativa,
        codigo_producto,
        SUM(cantidad_negada) AS declarados,
        SUM(CASE WHEN estado_revision = 'PENDIENTE_REVISION' THEN cantidad_negada ELSE 0 END) AS pendientes,
        SUM(CASE WHEN estado_revision = 'RECHAZADO_PENALIZA' THEN cantidad_negada ELSE 0 END) AS penalizables
      FROM productividad_sesion_negados
      WHERE tipo_operacion = 'MAYOREO'
      GROUP BY surtidor_id, fecha_operativa, codigo_producto
    ) psn ON psn.surtidor_id = mnr.surtidor_id
      AND psn.fecha_operativa = mnr.fecha_operativa
      AND psn.codigo_producto = mnr.codigo_producto
    WHERE ${where.join(' AND ')}
    ORDER BY mnr.fecha_operativa DESC, mnr.id DESC
    LIMIT ?
    `,
    params
  );

  res.json({
    ok: true,
    filtros: { desde, hasta, surtidor_id: surtidorId, no_vinculados: soloNoVinculados },
    negados: rows
  });
});

export const listarPendientesVincularMayoreo = asyncHandler(async (req, res) => {
  const { desde, hasta } = defaultRange(req.query);

  const [reportesRows] = await pool.query(
    `
    SELECT
      codigo_surtidor_reporte,
      COUNT(*) AS movimientos,
      COALESCE(SUM(tp), 0) AS partidas,
      COALESCE(SUM(neto), 0) AS neto,
      MIN(fecha) AS fecha_min,
      MAX(fecha) AS fecha_max
    FROM mayoreo_reportes_surtidores
    WHERE fecha BETWEEN ? AND ?
      AND (surtidor_id IS NULL OR reportable = 0)
      AND codigo_surtidor_reporte IS NOT NULL
      AND codigo_surtidor_reporte <> ''
    GROUP BY codigo_surtidor_reporte
    ORDER BY movimientos DESC
    `,
    [desde, hasta]
  );

  const [negadosRows] = await pool.query(
    `
    SELECT
      codigo_surtidor_reporte,
      COUNT(*) AS filas_negados,
      COALESCE(SUM(cantidad_a_deber), 0) AS cantidad_a_deber,
      MIN(fecha_operativa) AS fecha_min,
      MAX(fecha_operativa) AS fecha_max
    FROM mayoreo_negados_reporte
    WHERE fecha_operativa BETWEEN ? AND ?
      AND (surtidor_id IS NULL OR reportable = 0)
      AND codigo_surtidor_reporte IS NOT NULL
      AND codigo_surtidor_reporte <> ''
    GROUP BY codigo_surtidor_reporte
    ORDER BY filas_negados DESC
    `,
    [desde, hasta]
  );

  res.json({
    ok: true,
    filtros: { desde, hasta },
    reportes: reportesRows,
    negados: negadosRows
  });
});
