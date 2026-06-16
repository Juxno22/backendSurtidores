import { pool } from '../config/db.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getFechaOperativaMexico } from '../utils/mexicoTime.js';

import {
  construirDetalleChecadores
} from '../utils/productividadDetalle.js';

function getDateFilters(query) {
  const today = getFechaOperativaMexico();

  const fecha = query.fecha || '';
  const desde = query.desde || fecha || today;
  const hasta = query.hasta || fecha || desde;

  return {
    fecha,
    desde,
    hasta
  };
}

function buildWhere(query) {
  const { desde, hasta } = getDateFilters(query);

  const where = [
    'cr.fecha BETWEEN ? AND ?'
  ];

  const params = [desde, hasta];

  if (query.checador_id) {
    where.push('cr.checador_id = ?');
    params.push(query.checador_id);
  }

  return {
    whereSql: where.join(' AND '),
    params,
    filtros: {
      desde,
      hasta,
      checador_id: query.checador_id || ''
    }
  };
}

async function getRegistrosChecadores(query) {
  const { whereSql, params, filtros } = buildWhere(query);

  const [rows] = await pool.query(
    `
    SELECT
      cr.id,
      cr.checador_id,

      c.nombre AS checador_nombre,
      c.id AS checador_codigo,

      DATE_FORMAT(cr.fecha, '%Y-%m-%d') AS fecha,

      cr.num_salida,
      cr.est,
      cr.num_requisicion,
      cr.observaciones,
      cr.tp,
      cr.total,

      DATE_FORMAT(cr.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
      DATE_FORMAT(cr.updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at
    FROM checadores_reportes cr
    INNER JOIN checadores c ON c.id = cr.checador_id
    WHERE ${whereSql}
    ORDER BY cr.fecha ASC, c.nombre ASC, cr.num_salida ASC
    `,
    params
  );

  return {
    filtros,
    rows
  };
}

export const listarDetalleChecadores = asyncHandler(async (req, res) => {
  const { filtros, rows } = await getRegistrosChecadores(req.query);

  const detalle = construirDetalleChecadores(rows);

  res.json({
    ok: true,
    filtros,
    resumen: detalle.resumen,
    ranking: detalle.ranking,
    registros: detalle.registros
  });
});

export const obtenerDetalleChecador = asyncHandler(async (req, res) => {
  const query = {
    ...req.query,
    checador_id: req.params.id
  };

  const { filtros, rows } = await getRegistrosChecadores(query);

  const detalle = construirDetalleChecadores(rows);
  const checador = detalle.ranking[0] || null;

  res.json({
    ok: true,
    filtros,
    checador,
    resumen: detalle.resumen,
    registros: detalle.registros
  });
});