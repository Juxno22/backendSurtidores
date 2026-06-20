import { pool } from '../config/db.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { registrarAuditoria } from '../utils/auditoria.js';
import { getFechaOperativaMexico, getNowMexicoDateTime } from '../utils/mexicoTime.js';

const ESTADOS_REVISION = new Set([
  'PENDIENTE_REVISION',
  'VALIDADO_NO_PENALIZA',
  'RECHAZADO_PENALIZA',
  'CANCELADO_DUPLICADO'
]);

const ESTADOS_REVISION_SUPERVISOR = new Set([
  'VALIDADO_NO_PENALIZA',
  'RECHAZADO_PENALIZA',
  'CANCELADO_DUPLICADO'
]);

function cleanText(value) {
  return String(value ?? '').trim();
}

function upperText(value) {
  return cleanText(value).toUpperCase();
}

function validarFecha(value, fieldName = 'fecha') {
  const fecha = cleanText(value);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    const error = new Error(`${fieldName} debe tener formato YYYY-MM-DD`);
    error.status = 400;
    throw error;
  }

  return fecha;
}

function toPositiveId(value, fieldName, required = true) {
  if ((value === undefined || value === null || value === '') && !required) {
    return null;
  }

  const id = Number(value);

  if (!Number.isInteger(id) || id <= 0) {
    const error = new Error(`${fieldName} inválido`);
    error.status = 400;
    throw error;
  }

  return id;
}

function getDateFilters(query = {}) {
  const hoy = getFechaOperativaMexico();
  const fecha = cleanText(query.fecha);

  return {
    desde: validarFecha(query.desde || fecha || hoy, 'desde'),
    hasta: validarFecha(query.hasta || fecha || query.desde || hoy, 'hasta')
  };
}

function normalizeEstadoRevision(value, required = false) {
  const estado = upperText(value);

  if (!estado && !required) return '';

  if (!ESTADOS_REVISION.has(estado)) {
    const error = new Error('estado_revision inválido');
    error.status = 400;
    throw error;
  }

  return estado;
}

function normalizeTipoOperacion(value) {
  const tipo = upperText(value);

  if (!tipo) return '';

  if (!['SUCURSAL', 'MAYOREO'].includes(tipo)) {
    const error = new Error('tipo_operacion inválido');
    error.status = 400;
    throw error;
  }

  return tipo;
}

function buildNegadosWhere(req) {
  const { desde, hasta } = getDateFilters(req.query);
  const where = ['n.fecha_operativa BETWEEN ? AND ?'];
  const params = [desde, hasta];

  if (req.user.rol === 'SURTIDOR') {
    where.push('n.usuario_id = ?');
    params.push(req.user.id);
  }

  const estado = normalizeEstadoRevision(req.query.estado_revision);
  if (estado) {
    where.push('n.estado_revision = ?');
    params.push(estado);
  }

  const tipoOperacion = normalizeTipoOperacion(req.query.tipo_operacion);
  if (tipoOperacion) {
    where.push('n.tipo_operacion = ?');
    params.push(tipoOperacion);
  }

  const surtidorId = toPositiveId(req.query.surtidor_id, 'surtidor_id', false);
  if (surtidorId && req.user.rol !== 'SURTIDOR') {
    where.push('n.surtidor_id = ?');
    params.push(surtidorId);
  }

  const codigoProducto = cleanText(req.query.codigo_producto);
  if (codigoProducto) {
    where.push('n.codigo_producto LIKE ?');
    params.push(`%${codigoProducto}%`);
  }

  return {
    whereSql: where.join(' AND '),
    params,
    filtros: {
      desde,
      hasta,
      estado_revision: estado,
      tipo_operacion: tipoOperacion,
      surtidor_id: surtidorId || '',
      codigo_producto: codigoProducto
    }
  };
}

export const listarMotivosNegados = asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    `
    SELECT
      id,
      codigo,
      nombre,
      descripcion,
      activo,
      orden
    FROM productividad_negados_motivos
    WHERE activo = 1
    ORDER BY orden ASC, nombre ASC
    `
  );

  res.json({
    ok: true,
    motivos: rows
  });
});

export const listarNegados = asyncHandler(async (req, res) => {
  const { whereSql, params, filtros } = buildNegadosWhere(req);
  const limit = Math.min(Math.max(Number(req.query.limit || 500), 1), 2000);

  const [rows] = await pool.query(
    `
    SELECT
      n.id,
      n.sesion_id,
      n.origen,
      n.mayoreo_negado_reporte_id,
      n.surtidor_id,
      n.usuario_id,
      u.nombre AS surtidor_nombre,
      u.usuario AS surtidor_usuario,
      su.codigo AS surtidor_codigo,
      su.codigo_reporte AS surtidor_codigo_reporte,

      DATE_FORMAT(n.fecha_operativa, '%Y-%m-%d') AS fecha_operativa,
      n.tipo_operacion,
      ps.sucursal_id,
      COALESCE(sc.nombre, CASE WHEN n.tipo_operacion = 'MAYOREO' THEN 'Mayoreo' ELSE NULL END) AS sucursal_nombre,

      n.codigo_producto,
      n.producto,
      n.razon_codigo,
      n.razon_texto,
      n.linea,
      n.cantidad_negada,
      n.comentario_surtidor,

      n.estado_revision,
      n.penaliza,
      n.comentario_supervisor,
      n.revisado_por,
      ur.nombre AS revisado_por_nombre,
      DATE_FORMAT(n.revisado_at, '%Y-%m-%d %H:%i:%s') AS revisado_at,

      DATE_FORMAT(ps.hora_inicio, '%Y-%m-%d %H:%i:%s') AS hora_inicio,
      DATE_FORMAT(ps.hora_fin, '%Y-%m-%d %H:%i:%s') AS hora_fin,
      DATE_FORMAT(n.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
      DATE_FORMAT(n.updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at
    FROM productividad_sesion_negados n
    LEFT JOIN productividad_sesiones ps ON ps.id = n.sesion_id
    INNER JOIN surtidores su ON su.id = n.surtidor_id
    INNER JOIN usuarios u ON u.id = n.usuario_id
    LEFT JOIN sucursales sc ON sc.id = ps.sucursal_id
    LEFT JOIN usuarios ur ON ur.id = n.revisado_por
    WHERE ${whereSql}
    ORDER BY n.fecha_operativa DESC, n.created_at DESC, n.id DESC
    LIMIT ${limit}
    `,
    params
  );

  const [resumenRows] = await pool.query(
    `
    SELECT
      n.estado_revision,
      COUNT(*) AS registros,
      COALESCE(SUM(n.cantidad_negada), 0) AS cantidad
    FROM productividad_sesion_negados n
    LEFT JOIN productividad_sesiones ps ON ps.id = n.sesion_id
    INNER JOIN surtidores su ON su.id = n.surtidor_id
    INNER JOIN usuarios u ON u.id = n.usuario_id
    WHERE ${whereSql}
    GROUP BY n.estado_revision
    `,
    params
  );

  res.json({
    ok: true,
    filtros,
    resumen: resumenRows.map((row) => ({
      estado_revision: row.estado_revision,
      registros: Number(row.registros || 0),
      cantidad: Number(row.cantidad || 0)
    })),
    negados: rows.map((row) => ({
      ...row,
      cantidad_negada: Number(row.cantidad_negada || 0),
      penaliza: Boolean(row.penaliza)
    }))
  });
});

export const revisarNegado = asyncHandler(async (req, res) => {
  const id = toPositiveId(req.params.id, 'id');
  const estadoRevision = normalizeEstadoRevision(req.body.estado_revision, true);

  if (!ESTADOS_REVISION_SUPERVISOR.has(estadoRevision)) {
    return res.status(400).json({
      ok: false,
      message: 'El estado debe ser VALIDADO_NO_PENALIZA, RECHAZADO_PENALIZA o CANCELADO_DUPLICADO'
    });
  }

  const comentarioSupervisor = cleanText(req.body.comentario_supervisor || req.body.comentario);

  if (estadoRevision === 'RECHAZADO_PENALIZA' && comentarioSupervisor.length < 3) {
    return res.status(400).json({
      ok: false,
      message: 'Para rechazar y penalizar debes escribir un comentario del supervisor'
    });
  }

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [actualRows] = await connection.query(
      `
      SELECT *
      FROM productividad_sesion_negados
      WHERE id = ?
      LIMIT 1
      `,
      [id]
    );

    if (!actualRows.length) {
      await connection.rollback();

      return res.status(404).json({
        ok: false,
        message: 'Negado no encontrado'
      });
    }

    const actual = actualRows[0];
    const now = getNowMexicoDateTime();
    const penaliza = estadoRevision === 'RECHAZADO_PENALIZA' ? 1 : 0;

    await connection.query(
      `
      UPDATE productividad_sesion_negados
      SET
        estado_revision = ?,
        penaliza = ?,
        comentario_supervisor = ?,
        revisado_por = ?,
        revisado_at = ?,
        updated_at = ?
      WHERE id = ?
      `,
      [
        estadoRevision,
        penaliza,
        comentarioSupervisor || null,
        req.user.id,
        now,
        now,
        id
      ]
    );

    await registrarAuditoria(connection, {
      req,
      modulo: 'NEGADOS',
      accion: 'REVISAR_NEGADO',
      entidad: 'productividad_sesion_negados',
      entidadId: id,
      datosAntes: actual,
      datosDespues: {
        estado_revision: estadoRevision,
        penaliza,
        comentario_supervisor: comentarioSupervisor || null,
        revisado_por: req.user.id,
        revisado_at: now
      }
    });

    await connection.commit();

    const [rows] = await pool.query(
      `
      SELECT
        n.id,
        n.estado_revision,
        n.penaliza,
        n.comentario_supervisor,
        n.revisado_por,
        ur.nombre AS revisado_por_nombre,
        DATE_FORMAT(n.revisado_at, '%Y-%m-%d %H:%i:%s') AS revisado_at,
        DATE_FORMAT(n.updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at
      FROM productividad_sesion_negados n
      LEFT JOIN usuarios ur ON ur.id = n.revisado_por
      WHERE n.id = ?
      LIMIT 1
      `,
      [id]
    );

    res.json({
      ok: true,
      message: 'Negado revisado correctamente',
      negado: {
        ...rows[0],
        penaliza: Boolean(rows[0]?.penaliza)
      }
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
