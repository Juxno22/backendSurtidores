import { pool } from '../config/db.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getFechaOperativaMexico } from '../utils/mexicoTime.js';

import {
  construirDetalleSurtidores
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

function buildSessionWhere(query) {
  const { desde, hasta } = getDateFilters(query);

  const where = [
    'ps.estado = "FINALIZADO"',
    'ps.fecha_operativa BETWEEN ? AND ?'
  ];

  const params = [desde, hasta];

  if (query.sucursal_id) {
    where.push('ps.sucursal_id = ?');
    params.push(query.sucursal_id);
  }

  if (query.surtidor_id) {
    where.push('ps.surtidor_id = ?');
    params.push(query.surtidor_id);
  }

  if (query.tipo_operacion) {
    where.push('ps.tipo_operacion = ?');
    params.push(String(query.tipo_operacion).trim().toUpperCase());
  }

  return {
    whereSql: where.join(' AND '),
    params,
    filtros: {
      desde,
      hasta,
      sucursal_id: query.sucursal_id || '',
      surtidor_id: query.surtidor_id || '',
      tipo_operacion: query.tipo_operacion || ''
    }
  };
}

async function getSesionesSurtidores(query) {
  const { whereSql, params, filtros } = buildSessionWhere(query);

  const [rows] = await pool.query(
    `
    SELECT
      ps.id,
      ps.surtidor_id,
      ps.usuario_id,

      u.nombre AS surtidor_nombre,
      u.usuario AS surtidor_usuario,
      st.codigo AS surtidor_codigo,
      st.codigo_reporte AS surtidor_codigo_reporte,
      st.tipo_operacion AS surtidor_tipo_operacion,
      ps.tipo_operacion,

      ps.sucursal_id,
      sc.nombre AS sucursal_nombre,

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
    INNER JOIN surtidores st ON st.id = ps.surtidor_id
    INNER JOIN usuarios u ON u.id = st.usuario_id
    LEFT JOIN sucursales sc ON sc.id = ps.sucursal_id
    WHERE ${whereSql}
    ORDER BY ps.fecha_operativa ASC, ps.surtidor_id ASC, ps.hora_inicio ASC
    `,
    params
  );

  return {
    filtros,
    rows
  };
}

export const listarDetalleSurtidores = asyncHandler(async (req, res) => {
  const { filtros, rows } = await getSesionesSurtidores(req.query);

  const detalle = construirDetalleSurtidores(rows);

  res.json({
    ok: true,
    filtros,
    resumen: detalle.resumen,
    ranking: detalle.ranking,
    sesiones: detalle.sesiones
  });
});

export const obtenerDetalleSurtidor = asyncHandler(async (req, res) => {
  const query = {
    ...req.query,
    surtidor_id: req.params.id
  };

  const { filtros, rows } = await getSesionesSurtidores(query);

  const detalle = construirDetalleSurtidores(rows);
  const surtidor = detalle.ranking[0] || null;

  res.json({
    ok: true,
    filtros,
    surtidor,
    resumen: detalle.resumen,
    sesiones: detalle.sesiones
  });
});