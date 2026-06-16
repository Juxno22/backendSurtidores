import { pool } from '../config/db.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { registrarAuditoria } from '../utils/auditoria.js';
import { parseReporteChecadoresExcel } from '../utils/excelChecadores.js';
import { getFechaOperativaMexico } from '../utils/mexicoTime.js';
import { getJornadaLaboral } from '../utils/jornadaLaboral.js';

function normalizeCodigo(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function toPositiveId(value, fieldName, required = true) {
  if ((value === undefined || value === null || value === '') && !required) return null;

  const id = Number(value);

  if (!Number.isInteger(id) || id <= 0) {
    const error = new Error(`${fieldName} inválido`);
    error.status = 400;
    throw error;
  }

  return id;
}

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
  const hoy = getFechaOperativaMexico();
  const desde = query.desde || query.fecha || hoy;
  const hasta = query.hasta || query.fecha || desde;

  return {
    desde: validarFecha(desde, 'desde'),
    hasta: validarFecha(hasta, 'hasta')
  };
}

function round(value, decimals = 2) {
  return Number(Number(value || 0).toFixed(decimals));
}

function sumHorasJornada(fechas = []) {
  return fechas.reduce((acc, fecha) => {
    const jornada = getJornadaLaboral(fecha);
    return acc + Number(jornada.horas_netas || 0);
  }, 0);
}

function parseFechaList(value) {
  if (!value) return [];

  return String(value)
    .split(',')
    .map((item) => item.trim().slice(0, 10))
    .filter(Boolean);
}

async function getChecadorMap(connection, codigos) {
  if (!codigos.length) return new Map();

  const [checadores] = await connection.query(
    `
    SELECT id, codigo_reporte
    FROM checadores
    WHERE codigo_reporte IN (?)
    `,
    [codigos]
  );

  return new Map(checadores.map((row) => [row.codigo_reporte, row.id]));
}

export const listarChecadores = asyncHandler(async (req, res) => {
  const activo = req.query.activo;
  const search = String(req.query.search || '').trim();

  const where = [];
  const params = [];

  if (activo !== undefined && activo !== '') {
    where.push('c.activo = ?');
    params.push(Number(activo) ? 1 : 0);
  }

  if (search) {
    where.push('(c.codigo_reporte LIKE ? OR c.nombre_reporte LIKE ? OR u.nombre LIKE ? OR u.usuario LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }

  const [rows] = await pool.query(
    `
    SELECT
      c.id,
      c.usuario_id,
      u.nombre AS usuario_nombre,
      u.usuario AS usuario,
      c.codigo_reporte,
      c.nombre_reporte,
      COALESCE(u.nombre, c.nombre_reporte) AS nombre_visible,
      c.activo,
      DATE_FORMAT(c.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
      DATE_FORMAT(c.updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at
    FROM checadores c
    LEFT JOIN usuarios u ON u.id = c.usuario_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY c.activo DESC, nombre_visible ASC
    `,
    params
  );

  res.json({
    ok: true,
    checadores: rows
  });
});

export const crearChecador = asyncHandler(async (req, res) => {
  const codigoReporte = normalizeCodigo(req.body.codigo_reporte);
  const nombreReporte = String(req.body.nombre_reporte || '').trim();
  const usuarioId = toPositiveId(req.body.usuario_id, 'usuario_id', false);

  if (!codigoReporte) {
    return res.status(400).json({ ok: false, message: 'El código de reporte es obligatorio' });
  }

  if (!nombreReporte) {
    return res.status(400).json({ ok: false, message: 'El nombre de reporte es obligatorio' });
  }

  const [result] = await pool.query(
    `
    INSERT INTO checadores (usuario_id, codigo_reporte, nombre_reporte, activo)
    VALUES (?, ?, ?, 1)
    `,
    [usuarioId, codigoReporte, nombreReporte]
  );

  const [rows] = await pool.query(
    `
    SELECT *
    FROM checadores
    WHERE id = ?
    LIMIT 1
    `,
    [result.insertId]
  );

  res.status(201).json({
    ok: true,
    message: 'Checador creado correctamente',
    checador: rows[0]
  });
});

export const actualizarChecador = asyncHandler(async (req, res) => {
  const id = toPositiveId(req.params.id, 'id');

  const [actualRows] = await pool.query(
    'SELECT * FROM checadores WHERE id = ? LIMIT 1',
    [id]
  );

  if (!actualRows.length) {
    return res.status(404).json({ ok: false, message: 'Checador no encontrado' });
  }

  const actual = actualRows[0];

  const codigoReporte = req.body.codigo_reporte !== undefined
    ? normalizeCodigo(req.body.codigo_reporte)
    : actual.codigo_reporte;

  const nombreReporte = req.body.nombre_reporte !== undefined
    ? String(req.body.nombre_reporte || '').trim()
    : actual.nombre_reporte;

  const usuarioId = req.body.usuario_id !== undefined
    ? toPositiveId(req.body.usuario_id, 'usuario_id', false)
    : actual.usuario_id;

  const activo = req.body.activo !== undefined
    ? (Number(req.body.activo) ? 1 : 0)
    : actual.activo;

  if (!codigoReporte) {
    return res.status(400).json({ ok: false, message: 'El código de reporte es obligatorio' });
  }

  if (!nombreReporte) {
    return res.status(400).json({ ok: false, message: 'El nombre de reporte es obligatorio' });
  }

  await pool.query(
    `
    UPDATE checadores
    SET
      usuario_id = ?,
      codigo_reporte = ?,
      nombre_reporte = ?,
      activo = ?
    WHERE id = ?
    `,
    [usuarioId, codigoReporte, nombreReporte, activo, id]
  );

  const [rows] = await pool.query(
    `
    SELECT
      c.id,
      c.usuario_id,
      u.nombre AS usuario_nombre,
      u.usuario AS usuario,
      c.codigo_reporte,
      c.nombre_reporte,
      COALESCE(u.nombre, c.nombre_reporte) AS nombre_visible,
      c.activo
    FROM checadores c
    LEFT JOIN usuarios u ON u.id = c.usuario_id
    WHERE c.id = ?
    LIMIT 1
    `,
    [id]
  );

  res.json({
    ok: true,
    message: 'Checador actualizado correctamente',
    checador: rows[0]
  });
});

export const importarReporteChecadoresExcel = asyncHandler(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      ok: false,
      message: 'Debes subir un archivo Excel'
    });
  }

  const parsed = parseReporteChecadoresExcel(req.file.buffer);
  const dryRun = String(req.query.dry_run || '') === '1';

  if (dryRun) {
    return res.json({
      ok: true,
      message: 'Archivo validado correctamente',
      resumen: parsed.resumen,
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

    const codigos = Array.from(new Set(parsed.filas.map((row) => row.checador_codigo)));

    for (const codigo of codigos) {
      const fila = parsed.filas.find((row) => row.checador_codigo === codigo);

      await connection.query(
        `
        INSERT INTO checadores (codigo_reporte, nombre_reporte, activo)
        VALUES (?, ?, 1)
        ON DUPLICATE KEY UPDATE
          nombre_reporte = VALUES(nombre_reporte),
          activo = 1
        `,
        [codigo, fila.checador_nombre]
      );
    }

    const checadorMap = await getChecadorMap(connection, codigos);

    let insertados = 0;
    let actualizados = 0;

    for (const fila of parsed.filas) {
      const checadorId = checadorMap.get(fila.checador_codigo);

      const [result] = await connection.query(
        `
        INSERT INTO checadores_reportes (
          fecha,
          checador_id,
          codigo_reporte,
          checador_nombre_reporte,
          num_salida,
          est,
          num_requisicion,
          observaciones,
          tp,
          total,
          fuente,
          archivo_nombre,
          cargado_por
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'EXCEL', ?, ?)
        ON DUPLICATE KEY UPDATE
          fecha = VALUES(fecha),
          checador_id = VALUES(checador_id),
          codigo_reporte = VALUES(codigo_reporte),
          checador_nombre_reporte = VALUES(checador_nombre_reporte),
          est = VALUES(est),
          num_requisicion = VALUES(num_requisicion),
          observaciones = VALUES(observaciones),
          tp = VALUES(tp),
          total = VALUES(total),
          fuente = 'EXCEL',
          archivo_nombre = VALUES(archivo_nombre),
          cargado_por = VALUES(cargado_por),
          updated_at = CURRENT_TIMESTAMP
        `,
        [
          fila.fecha,
          checadorId,
          fila.checador_codigo,
          fila.checador_nombre,
          fila.num_salida,
          fila.est,
          fila.num_requisicion,
          fila.observaciones,
          fila.tp,
          fila.total,
          req.file.originalname,
          req.user.id
        ]
      );

      if (result.affectedRows === 1) insertados += 1;
      if (result.affectedRows === 2) actualizados += 1;
    }

    const [importResult] = await connection.query(
      `
      INSERT INTO checadores_importaciones (
        archivo_nombre,
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
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        req.file.originalname,
        parsed.resumen.filas_leidas,
        parsed.filas.length,
        insertados,
        actualizados,
        Math.max(0, parsed.resumen.filas_leidas - parsed.filas.length),
        parsed.resumen.fecha_min,
        parsed.resumen.fecha_max,
        JSON.stringify(parsed.warnings.slice(0, 250)),
        req.user.id
      ]
    );

    await registrarAuditoria(connection, {
      req,
      modulo: 'CHECADORES',
      accion: 'IMPORTAR_REPORTE_CHECADORES',
      entidad: 'checadores_importaciones',
      entidadId: importResult.insertId,
      datosAntes: null,
      datosDespues: {
        archivo: req.file.originalname,
        resumen: parsed.resumen,
        insertados,
        actualizados
      }
    });

    await connection.commit();

    res.status(201).json({
      ok: true,
      message: 'Reporte de checadores importado correctamente',
      importacion_id: importResult.insertId,
      resumen: {
        ...parsed.resumen,
        insertados,
        actualizados
      },
      hojas: parsed.hojas,
      warnings: parsed.warnings.slice(0, 150)
    });
  } catch (error) {
    try {
      await connection.rollback();
    } catch (rollbackError) {
      console.warn('Rollback falló en importarReporteChecadoresExcel:', {
        code: rollbackError.code,
        message: rollbackError.message
      });
    }

    throw error;
  } finally {
    connection.release();
  }
});

export const dashboardChecadores = asyncHandler(async (req, res) => {
  const { desde, hasta } = defaultRange(req.query);
  const checadorId = toPositiveId(req.query.checador_id, 'checador_id', false);

  const params = [desde, hasta];
  const checadorWhere = [];

  if (checadorId) {
    checadorWhere.push('cr.checador_id = ?');
    params.push(checadorId);
  }

  const whereExtra = checadorWhere.length ? `AND ${checadorWhere.join(' AND ')}` : '';

  const [rankingRows] = await pool.query(
    `
    SELECT
      c.id AS checador_id,
      c.codigo_reporte,
      COALESCE(u.nombre, c.nombre_reporte, cr.checador_nombre_reporte) AS checador_nombre,
      COUNT(*) AS salidas,
      COALESCE(SUM(cr.tp), 0) AS tp,
      COALESCE(SUM(cr.total), 0) AS total_importe,
      COUNT(DISTINCT cr.fecha) AS dias_con_reporte,
      GROUP_CONCAT(DISTINCT DATE_FORMAT(cr.fecha, '%Y-%m-%d') ORDER BY cr.fecha SEPARATOR ',') AS fechas
    FROM checadores_reportes cr
    INNER JOIN checadores c ON c.id = cr.checador_id
    LEFT JOIN usuarios u ON u.id = c.usuario_id
    WHERE cr.fecha BETWEEN ? AND ?
      ${whereExtra}
    GROUP BY c.id, c.codigo_reporte, checador_nombre
    ORDER BY tp DESC, salidas DESC
    `,
    params
  );

  const [fechaRows] = await pool.query(
    `
    SELECT
      DATE_FORMAT(cr.fecha, '%Y-%m-%d') AS fecha,
      COUNT(*) AS salidas,
      COALESCE(SUM(cr.tp), 0) AS tp,
      COALESCE(SUM(cr.total), 0) AS total_importe,
      COUNT(DISTINCT cr.checador_id) AS checadores_activos
    FROM checadores_reportes cr
    WHERE cr.fecha BETWEEN ? AND ?
      ${whereExtra}
    GROUP BY cr.fecha
    ORDER BY cr.fecha ASC
    `,
    params
  );

  const [estadoRows] = await pool.query(
    `
    SELECT
      COALESCE(NULLIF(cr.est, ''), 'SIN_EST') AS est,
      COUNT(*) AS salidas,
      COALESCE(SUM(cr.tp), 0) AS tp
    FROM checadores_reportes cr
    WHERE cr.fecha BETWEEN ? AND ?
      ${whereExtra}
    GROUP BY COALESCE(NULLIF(cr.est, ''), 'SIN_EST')
    ORDER BY salidas DESC
    `,
    params
  );

  const totalTpEquipo = rankingRows.reduce((acc, row) => acc + Number(row.tp || 0), 0);
  const totalSalidasEquipo = rankingRows.reduce((acc, row) => acc + Number(row.salidas || 0), 0);
  const totalImporteEquipo = rankingRows.reduce((acc, row) => acc + Number(row.total_importe || 0), 0);

  const ranking = rankingRows.map((row) => {
    const fechas = parseFechaList(row.fechas);
    const horasLaborales = sumHorasJornada(fechas);
    const tp = Number(row.tp || 0);
    const salidas = Number(row.salidas || 0);

    return {
      checador_id: row.checador_id,
      codigo_reporte: row.codigo_reporte,
      checador_nombre: row.checador_nombre,
      salidas,
      tp,
      total_importe: round(row.total_importe),
      dias_con_reporte: Number(row.dias_con_reporte || 0),
      horas_laborales: round(horasLaborales),
      tp_por_hora_laboral: horasLaborales ? round(tp / horasLaborales) : 0,
      salidas_por_hora_laboral: horasLaborales ? round(salidas / horasLaborales) : 0,
      participacion_tp_pct: totalTpEquipo ? round((tp / totalTpEquipo) * 100) : 0,
      participacion_salidas_pct: totalSalidasEquipo ? round((salidas / totalSalidasEquipo) * 100) : 0
    };
  });

  const horasEquipo = ranking.reduce((acc, row) => acc + Number(row.horas_laborales || 0), 0);

  const porFecha = fechaRows.map((row) => {
    const jornada = getJornadaLaboral(row.fecha);
    const horasEquipoDia = Number(jornada.horas_netas || 0) * Number(row.checadores_activos || 0);
    const tp = Number(row.tp || 0);
    const salidas = Number(row.salidas || 0);

    return {
      fecha: row.fecha,
      salidas,
      tp,
      total_importe: round(row.total_importe),
      checadores_activos: Number(row.checadores_activos || 0),
      horas_equipo: round(horasEquipoDia),
      tp_por_hora_equipo: horasEquipoDia ? round(tp / horasEquipoDia) : 0,
      salidas_por_hora_equipo: horasEquipoDia ? round(salidas / horasEquipoDia) : 0
    };
  });

  res.json({
    ok: true,
    filtros: {
      desde,
      hasta,
      checador_id: checadorId
    },
    resumen: {
      total_salidas: totalSalidasEquipo,
      total_tp: totalTpEquipo,
      total_importe: round(totalImporteEquipo),
      checadores_activos: ranking.length,
      horas_laborales_equipo: round(horasEquipo),
      tp_por_hora_laboral_equipo: horasEquipo ? round(totalTpEquipo / horasEquipo) : 0,
      salidas_por_hora_laboral_equipo: horasEquipo ? round(totalSalidasEquipo / horasEquipo) : 0
    },
    ranking,
    por_fecha: porFecha,
    por_estado: estadoRows.map((row) => ({
      est: row.est,
      salidas: Number(row.salidas || 0),
      tp: Number(row.tp || 0)
    }))
  });
});

export const listarReportesChecadores = asyncHandler(async (req, res) => {
  const { desde, hasta } = defaultRange(req.query);
  const checadorId = toPositiveId(req.query.checador_id, 'checador_id', false);
  const limit = Math.min(Number(req.query.limit || 300), 1000);

  const params = [desde, hasta];
  const where = ['cr.fecha BETWEEN ? AND ?'];

  if (checadorId) {
    where.push('cr.checador_id = ?');
    params.push(checadorId);
  }

  params.push(limit);

  const [rows] = await pool.query(
    `
    SELECT
      cr.id,
      DATE_FORMAT(cr.fecha, '%Y-%m-%d') AS fecha,
      cr.checador_id,
      c.codigo_reporte,
      COALESCE(u.nombre, c.nombre_reporte, cr.checador_nombre_reporte) AS checador_nombre,
      cr.num_salida,
      cr.est,
      cr.num_requisicion,
      cr.observaciones,
      cr.tp,
      cr.total,
      cr.archivo_nombre,
      DATE_FORMAT(cr.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
      DATE_FORMAT(cr.updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at
    FROM checadores_reportes cr
    INNER JOIN checadores c ON c.id = cr.checador_id
    LEFT JOIN usuarios u ON u.id = c.usuario_id
    WHERE ${where.join(' AND ')}
    ORDER BY cr.fecha DESC, cr.id DESC
    LIMIT ?
    `,
    params
  );

  res.json({
    ok: true,
    reportes: rows,
    filtros: {
      desde,
      hasta,
      checador_id: checadorId,
      limit
    }
  });
});
