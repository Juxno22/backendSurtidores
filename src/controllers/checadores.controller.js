import { pool } from '../config/db.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { registrarAuditoria } from '../utils/auditoria.js';
import { parseReporteChecadoresExcel } from '../utils/excelChecadores.js';
import { getFechaOperativaMexico, getNowMexicoDateTime } from '../utils/mexicoTime.js';
import { getJornadaLaboral } from '../utils/jornadaLaboral.js';

function normalizeCodigo(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function cleanText(value) {
  return String(value ?? '').trim();
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

async function buscarUsuarioPorCodigoReporte(connection, codigoReporte) {
  const codigo = normalizeCodigo(codigoReporte);

  if (!codigo) return null;

  const [rows] = await connection.query(
    `
    SELECT id, nombre, usuario, activo
    FROM usuarios
    WHERE UPPER(TRIM(usuario)) = UPPER(TRIM(?))
    LIMIT 1
    `,
    [codigo]
  );

  return rows[0] || null;
}

async function obtenerUsuarioPorId(connection, usuarioId) {
  if (!usuarioId) return null;

  const [rows] = await connection.query(
    `
    SELECT id, nombre, usuario, activo
    FROM usuarios
    WHERE id = ?
    LIMIT 1
    `,
    [usuarioId]
  );

  return rows[0] || null;
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

async function obtenerChecadorPorId(connection, id) {
  const [rows] = await connection.query(
    `
    SELECT
      c.id,
      c.nombre,
      c.usuario_id,
      u.nombre AS usuario_nombre,
      u.usuario AS usuario,
      u.activo AS usuario_activo,
      c.codigo_reporte,
      c.nombre_reporte,
      COALESCE(u.nombre, c.nombre, c.nombre_reporte) AS nombre_visible,
      CASE WHEN c.usuario_id IS NOT NULL AND c.activo = 1 AND u.activo = 1 THEN 1 ELSE 0 END AS reportable,
      CASE WHEN c.usuario_id IS NULL THEN 1 ELSE 0 END AS pendiente_vincular,
      st.id AS surtidor_id,
      st.codigo AS surtidor_codigo,
      CASE WHEN st.id IS NOT NULL THEN 1 ELSE 0 END AS tambien_surtidor,
      c.activo,
      DATE_FORMAT(c.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
      DATE_FORMAT(c.updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at
    FROM checadores c
    LEFT JOIN usuarios u ON u.id = c.usuario_id
    LEFT JOIN surtidores st ON st.usuario_id = u.id
    WHERE c.id = ?
    LIMIT 1
    `,
    [id]
  );

  return rows[0] || null;
}

export const listarChecadores = asyncHandler(async (req, res) => {
  const activo = req.query.activo;
  const search = cleanText(req.query.search);
  const vinculacion = cleanText(req.query.vinculacion).toUpperCase();

  const where = [];
  const params = [];

  if (activo !== undefined && activo !== '') {
    where.push('c.activo = ?');
    params.push(Number(activo) ? 1 : 0);
  }

  if (vinculacion === 'PENDIENTE') {
    where.push('c.usuario_id IS NULL');
  } else if (vinculacion === 'VINCULADO') {
    where.push('c.usuario_id IS NOT NULL');
  } else if (vinculacion === 'REPORTABLE') {
    where.push('c.usuario_id IS NOT NULL');
    where.push('c.activo = 1');
    where.push('u.activo = 1');
  }

  if (search) {
    where.push(`
      (
        c.codigo_reporte LIKE ?
        OR c.nombre_reporte LIKE ?
        OR c.nombre LIKE ?
        OR u.nombre LIKE ?
        OR u.usuario LIKE ?
      )
    `);
    const like = `%${search}%`;
    params.push(like, like, like, like, like);
  }

  const [rows] = await pool.query(
    `
    SELECT
      c.id,
      c.nombre,
      c.usuario_id,
      u.nombre AS usuario_nombre,
      u.usuario AS usuario,
      u.activo AS usuario_activo,
      c.codigo_reporte,
      c.nombre_reporte,
      COALESCE(u.nombre, c.nombre, c.nombre_reporte) AS nombre_visible,
      CASE WHEN c.usuario_id IS NOT NULL AND c.activo = 1 AND u.activo = 1 THEN 1 ELSE 0 END AS reportable,
      CASE WHEN c.usuario_id IS NULL THEN 1 ELSE 0 END AS pendiente_vincular,
      st.id AS surtidor_id,
      st.codigo AS surtidor_codigo,
      CASE WHEN st.id IS NOT NULL THEN 1 ELSE 0 END AS tambien_surtidor,
      c.activo,
      DATE_FORMAT(c.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
      DATE_FORMAT(c.updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at
    FROM checadores c
    LEFT JOIN usuarios u ON u.id = c.usuario_id
    LEFT JOIN surtidores st ON st.usuario_id = u.id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY pending_vincular DESC, c.activo DESC, nombre_visible ASC
    `.replace('pending_vincular', 'pendiente_vincular'),
    params
  );

  res.json({ ok: true, checadores: rows });
});

export const crearChecador = asyncHandler(async (req, res) => {
  const codigoReporte = normalizeCodigo(req.body.codigo_reporte);
  const nombreReporte = cleanText(req.body.nombre_reporte);
  const nombre = cleanText(req.body.nombre || nombreReporte);
  let usuarioId = toPositiveId(req.body.usuario_id, 'usuario_id', false);

  if (!codigoReporte) {
    return res.status(400).json({ ok: false, message: 'El código de reporte es obligatorio' });
  }

  if (!nombreReporte) {
    return res.status(400).json({ ok: false, message: 'El nombre de reporte es obligatorio' });
  }

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    if (!usuarioId) {
      const usuario = await buscarUsuarioPorCodigoReporte(connection, codigoReporte);
      usuarioId = usuario?.id || null;
    } else {
      const usuario = await obtenerUsuarioPorId(connection, usuarioId);
      if (!usuario) {
        await connection.rollback();
        return res.status(404).json({ ok: false, message: 'Usuario no encontrado. Primero créalo desde Usuarios.' });
      }
    }

    const now = getNowMexicoDateTime();

    const [result] = await connection.query(
      `
      INSERT INTO checadores (nombre, usuario_id, codigo_reporte, nombre_reporte, activo, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?)
      `,
      [nombre || nombreReporte, usuarioId, codigoReporte, nombreReporte, now, now]
    );

    const checador = await obtenerChecadorPorId(connection, result.insertId);

    await registrarAuditoria(connection, {
      req,
      modulo: 'CHECADORES',
      accion: 'CREAR_CHECADOR',
      entidad: 'checadores',
      entidadId: result.insertId,
      datosAntes: null,
      datosDespues: checador
    });

    await connection.commit();

    res.status(201).json({ ok: true, message: 'Checador creado correctamente', checador });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
});

export const actualizarChecador = asyncHandler(async (req, res) => {
  const id = toPositiveId(req.params.id, 'id');
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const actual = await obtenerChecadorPorId(connection, id);

    if (!actual) {
      await connection.rollback();
      return res.status(404).json({ ok: false, message: 'Checador no encontrado' });
    }

    const codigoReporte = req.body.codigo_reporte !== undefined ? normalizeCodigo(req.body.codigo_reporte) : actual.codigo_reporte;
    const nombreReporte = req.body.nombre_reporte !== undefined ? cleanText(req.body.nombre_reporte) : actual.nombre_reporte;
    const nombre = req.body.nombre !== undefined ? cleanText(req.body.nombre) : actual.nombre;
    let usuarioId = req.body.usuario_id !== undefined ? toPositiveId(req.body.usuario_id, 'usuario_id', false) : actual.usuario_id;
    const activo = req.body.activo !== undefined ? (Number(req.body.activo) ? 1 : 0) : actual.activo;

    if (!codigoReporte) {
      await connection.rollback();
      return res.status(400).json({ ok: false, message: 'El código de reporte es obligatorio' });
    }

    if (!nombreReporte) {
      await connection.rollback();
      return res.status(400).json({ ok: false, message: 'El nombre de reporte es obligatorio' });
    }

    if (!usuarioId) {
      const usuario = await buscarUsuarioPorCodigoReporte(connection, codigoReporte);
      usuarioId = usuario?.id || null;
    } else {
      const usuario = await obtenerUsuarioPorId(connection, usuarioId);
      if (!usuario) {
        await connection.rollback();
        return res.status(404).json({ ok: false, message: 'Usuario no encontrado. Primero créalo desde Usuarios.' });
      }
    }

    const now = getNowMexicoDateTime();

    await connection.query(
      `
      UPDATE checadores
      SET nombre = ?, usuario_id = ?, codigo_reporte = ?, nombre_reporte = ?, activo = ?, updated_at = ?
      WHERE id = ?
      `,
      [nombre || nombreReporte, usuarioId, codigoReporte, nombreReporte, activo, now, id]
    );

    const actualizado = await obtenerChecadorPorId(connection, id);

    await registrarAuditoria(connection, {
      req,
      modulo: 'CHECADORES',
      accion: 'ACTUALIZAR_CHECADOR',
      entidad: 'checadores',
      entidadId: id,
      datosAntes: actual,
      datosDespues: actualizado
    });

    await connection.commit();

    res.json({ ok: true, message: 'Checador actualizado correctamente', checador: actualizado });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
});

export const vincularChecadoresUsuarios = asyncHandler(async (req, res) => {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [pendientes] = await connection.query(
      `
      SELECT
        c.id,
        c.codigo_reporte,
        c.nombre_reporte,
        c.usuario_id,
        u.id AS usuario_encontrado_id,
        u.nombre AS usuario_nombre,
        u.usuario
      FROM checadores c
      LEFT JOIN usuarios u ON UPPER(TRIM(u.usuario)) = UPPER(TRIM(c.codigo_reporte))
      WHERE c.usuario_id IS NULL
      ORDER BY c.codigo_reporte ASC
      `
    );

    let vinculados = 0;
    const sinCoincidencia = [];
    const now = getNowMexicoDateTime();

    for (const row of pendientes) {
      if (row.usuario_encontrado_id) {
        await connection.query(
          `UPDATE checadores SET usuario_id = ?, updated_at = ? WHERE id = ?`,
          [row.usuario_encontrado_id, now, row.id]
        );
        vinculados += 1;
      } else {
        sinCoincidencia.push({
          checador_id: row.id,
          codigo_reporte: row.codigo_reporte,
          nombre_reporte: row.nombre_reporte
        });
      }
    }

    await registrarAuditoria(connection, {
      req,
      modulo: 'CHECADORES',
      accion: 'VINCULAR_CHECADORES_USUARIOS',
      entidad: 'checadores',
      entidadId: null,
      datosAntes: null,
      datosDespues: { revisados: pendientes.length, vinculados, sin_coincidencia: sinCoincidencia }
    });

    await connection.commit();

    res.json({
      ok: true,
      message: 'Vinculación automática ejecutada correctamente',
      resumen: { revisados: pendientes.length, vinculados, sin_coincidencia: sinCoincidencia.length },
      sin_coincidencia: sinCoincidencia
    });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
});

export const importarReporteChecadoresExcel = asyncHandler(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ ok: false, message: 'Debes subir un archivo Excel' });
  }

  const parsed = parseReporteChecadoresExcel(req.file.buffer);
  const dryRun = String(req.query.dry_run || '') === '1';
  const codigos = Array.from(new Set(parsed.filas.map((row) => row.checador_codigo).filter(Boolean)));

  if (dryRun) {
    const [usuariosCoincidentes] = codigos.length
      ? await pool.query(
          `SELECT id, nombre, usuario FROM usuarios WHERE UPPER(TRIM(usuario)) IN (?)`,
          [codigos]
        )
      : [[]];

    const usuariosMap = new Map(usuariosCoincidentes.map((u) => [String(u.usuario).toUpperCase(), u]));

    return res.json({
      ok: true,
      message: 'Archivo validado correctamente',
      resumen: {
        ...parsed.resumen,
        codigos_reporte_detectados: codigos,
        codigos_vinculados_a_usuarios: codigos.filter((codigo) => usuariosMap.has(codigo)),
        codigos_sin_usuario: codigos.filter((codigo) => !usuariosMap.has(codigo)),
        nota: 'Los códigos sin usuario se guardan para auditoría, pero no aparecen en reportes de productividad hasta vincularse.'
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

    const vinculadosAuto = [];
    const sinUsuario = [];
    const now = getNowMexicoDateTime();

    for (const codigo of codigos) {
      const fila = parsed.filas.find((row) => row.checador_codigo === codigo);
      const usuario = await buscarUsuarioPorCodigoReporte(connection, codigo);

      if (usuario?.id) vinculadosAuto.push(codigo);
      else sinUsuario.push(codigo);

      await connection.query(
        `
        INSERT INTO checadores (nombre, usuario_id, codigo_reporte, nombre_reporte, activo, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, ?, ?)
        ON DUPLICATE KEY UPDATE
          nombre = VALUES(nombre),
          usuario_id = COALESCE(checadores.usuario_id, VALUES(usuario_id)),
          nombre_reporte = VALUES(nombre_reporte),
          activo = 1,
          updated_at = VALUES(updated_at)
        `,
        [fila.checador_nombre, usuario?.id || null, codigo, fila.checador_nombre, now, now]
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
      datosDespues: { archivo: req.file.originalname, resumen: parsed.resumen, insertados, actualizados, vinculadosAuto, sinUsuario }
    });

    await connection.commit();

    res.status(201).json({
      ok: true,
      message: 'Reporte de checadores importado correctamente',
      importacion_id: importResult.insertId,
      resumen: { ...parsed.resumen, insertados, actualizados, vinculados_auto: vinculadosAuto, pendientes_vincular: sinUsuario },
      hojas: parsed.hojas,
      warnings: parsed.warnings.slice(0, 150)
    });
  } catch (error) {
    try {
      await connection.rollback();
    } catch (rollbackError) {
      console.warn('Rollback falló en importarReporteChecadoresExcel:', { code: rollbackError.code, message: rollbackError.message });
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
  const checadorWhere = [
    'c.usuario_id IS NOT NULL',
    'c.activo = 1',
    'u.activo = 1'
  ];

  if (checadorId) {
    checadorWhere.push('cr.checador_id = ?');
    params.push(checadorId);
  }

  const whereExtra = `AND ${checadorWhere.join(' AND ')}`;

  const [rankingRows] = await pool.query(
    `
    SELECT
      c.id AS checador_id,
      c.usuario_id,
      u.nombre AS usuario_nombre,
      u.usuario,
      c.codigo_reporte,
      COALESCE(u.nombre, c.nombre, c.nombre_reporte, cr.checador_nombre_reporte) AS checador_nombre,
      st.id AS surtidor_id,
      st.codigo AS surtidor_codigo,
      COUNT(*) AS salidas,
      COALESCE(SUM(cr.tp), 0) AS tp,
      COALESCE(SUM(cr.total), 0) AS total_importe,
      COUNT(DISTINCT cr.fecha) AS dias_con_reporte,
      GROUP_CONCAT(DISTINCT DATE_FORMAT(cr.fecha, '%Y-%m-%d') ORDER BY cr.fecha SEPARATOR ',') AS fechas
    FROM checadores_reportes cr
    INNER JOIN checadores c ON c.id = cr.checador_id
    INNER JOIN usuarios u ON u.id = c.usuario_id
    LEFT JOIN surtidores st ON st.usuario_id = u.id
    WHERE cr.fecha BETWEEN ? AND ?
      ${whereExtra}
    GROUP BY c.id, c.usuario_id, u.nombre, u.usuario, c.codigo_reporte, checador_nombre, st.id, st.codigo
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
    INNER JOIN checadores c ON c.id = cr.checador_id
    INNER JOIN usuarios u ON u.id = c.usuario_id
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
    INNER JOIN checadores c ON c.id = cr.checador_id
    INNER JOIN usuarios u ON u.id = c.usuario_id
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
      usuario_id: row.usuario_id,
      usuario: row.usuario,
      codigo_reporte: row.codigo_reporte,
      checador_nombre: row.checador_nombre,
      surtidor_id: row.surtidor_id,
      surtidor_codigo: row.surtidor_codigo,
      tambien_surtidor: Boolean(row.surtidor_id),
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
    filtros: { desde, hasta, checador_id: checadorId },
    resumen: {
      total_salidas: totalSalidasEquipo,
      total_tp: totalTpEquipo,
      total_importe: round(totalImporteEquipo),
      checadores_activos: ranking.length,
      checadores_vinculados: ranking.filter((row) => row.usuario_id).length,
      checadores_mixtos: ranking.filter((row) => row.tambien_surtidor).length,
      horas_laborales_equipo: round(horasEquipo),
      tp_por_hora_laboral_equipo: horasEquipo ? round(totalTpEquipo / horasEquipo) : 0,
      salidas_por_hora_laboral_equipo: horasEquipo ? round(totalSalidasEquipo / horasEquipo) : 0
    },
    ranking,
    por_fecha: porFecha,
    por_estado: estadoRows.map((row) => ({ est: row.est, salidas: Number(row.salidas || 0), tp: Number(row.tp || 0) }))
  });
});

export const listarReportesChecadores = asyncHandler(async (req, res) => {
  const { desde, hasta } = defaultRange(req.query);
  const checadorId = toPositiveId(req.query.checador_id, 'checador_id', false);
  const limit = Math.min(Number(req.query.limit || 300), 1000);

  const params = [desde, hasta];
  const where = [
    'cr.fecha BETWEEN ? AND ?',
    'c.usuario_id IS NOT NULL',
    'c.activo = 1',
    'u.activo = 1'
  ];

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
      c.usuario_id,
      c.codigo_reporte,
      COALESCE(u.nombre, c.nombre, c.nombre_reporte, cr.checador_nombre_reporte) AS checador_nombre,
      u.usuario,
      st.id AS surtidor_id,
      st.codigo AS surtidor_codigo,
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
    INNER JOIN usuarios u ON u.id = c.usuario_id
    LEFT JOIN surtidores st ON st.usuario_id = u.id
    WHERE ${where.join(' AND ')}
    ORDER BY cr.fecha DESC, cr.id DESC
    LIMIT ?
    `,
    params
  );

  res.json({ ok: true, reportes: rows, filtros: { desde, hasta, checador_id: checadorId, limit } });
});
