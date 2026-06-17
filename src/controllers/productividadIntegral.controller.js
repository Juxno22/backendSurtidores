import { pool } from '../config/db.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getFechaOperativaMexico } from '../utils/mexicoTime.js';
import {
  getJornadaDisponibleSegundosPorFechas,
  secondsToHours
} from '../utils/productividadDetalle.js';

function validarFecha(fecha, fieldName) {
  const value = String(fecha || '').trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const error = new Error(`${fieldName} debe tener formato YYYY-MM-DD`);
    error.status = 400;
    throw error;
  }

  return value;
}

function getDateFilters(query) {
  const today = getFechaOperativaMexico();
  const fecha = query.fecha || '';
  const desde = validarFecha(query.desde || fecha || today, 'desde');
  const hasta = validarFecha(query.hasta || fecha || desde, 'hasta');

  return { desde, hasta };
}

function toNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function round2(value) {
  return Number(toNumber(value).toFixed(2));
}

function addBaseUser(map, key, data) {
  if (!map.has(key)) {
    map.set(key, {
      key,
      usuario_id: data.usuario_id || null,
      nombre: data.nombre || data.usuario_nombre || data.checador_nombre || 'Sin usuario',
      usuario: data.usuario || null,
      rol: data.rol || null,
      surtidor_id: data.surtidor_id || null,
      surtidor_codigo: data.surtidor_codigo || null,
      checador_id: data.checador_id || null,
      checador_codigo: data.checador_codigo || null,
      fechas_set: new Set(),
      surtidor: {
        sesiones: 0,
        surtido_total: 0,
        partidas_surtidas: 0,
        ceros: 0,
        negados: 0,
        tiempo_activo_segundos: 0,
        tiempo_muerto_segundos: 0
      },
      checador: {
        registros: 0,
        salidas: 0,
        tp: 0,
        total: 0
      }
    });
  }

  const item = map.get(key);

  item.usuario_id = item.usuario_id || data.usuario_id || null;
  item.nombre = item.nombre || data.nombre || data.usuario_nombre || data.checador_nombre;
  item.usuario = item.usuario || data.usuario || null;
  item.rol = item.rol || data.rol || null;
  item.surtidor_id = item.surtidor_id || data.surtidor_id || null;
  item.surtidor_codigo = item.surtidor_codigo || data.surtidor_codigo || null;
  item.checador_id = item.checador_id || data.checador_id || null;
  item.checador_codigo = item.checador_codigo || data.checador_codigo || null;

  return item;
}

export const productividadIntegralUsuarios = asyncHandler(async (req, res) => {
  const { desde, hasta } = getDateFilters(req.query);

  const [surtidorRows] = await pool.query(
    `
    SELECT
      u.id AS usuario_id,
      u.nombre AS usuario_nombre,
      u.usuario,
      u.rol,
      st.id AS surtidor_id,
      st.codigo AS surtidor_codigo,
      DATE_FORMAT(ps.fecha_operativa, '%Y-%m-%d') AS fecha_operativa,
      COUNT(*) AS sesiones,
      COALESCE(SUM(ps.partidas + ps.ceros + ps.no_surtido), 0) AS surtido_total,
      COALESCE(SUM(ps.partidas), 0) AS partidas_surtidas,
      COALESCE(SUM(ps.ceros), 0) AS ceros,
      COALESCE(SUM(ps.no_surtido), 0) AS negados,
      COALESCE(SUM(ps.duracion_laboral_segundos), 0) AS tiempo_activo_segundos
    FROM productividad_sesiones ps
    INNER JOIN surtidores st ON st.id = ps.surtidor_id
    INNER JOIN usuarios u ON u.id = st.usuario_id
    WHERE ps.estado = 'FINALIZADO'
      AND st.activo = 1
      AND u.activo = 1
      AND ps.fecha_operativa BETWEEN ? AND ?
    GROUP BY u.id, u.nombre, u.usuario, u.rol, st.id, st.codigo, ps.fecha_operativa
    `,
    [desde, hasta]
  );

  const [checadorRows] = await pool.query(
    `
    SELECT
      c.usuario_id,
      u.nombre AS usuario_nombre,
      u.usuario,
      u.rol,
      c.id AS checador_id,
      c.codigo_reporte AS checador_codigo,
      COALESCE(u.nombre, c.nombre, c.nombre_reporte) AS checador_nombre,
      DATE_FORMAT(cr.fecha, '%Y-%m-%d') AS fecha,
      COUNT(*) AS registros,
      COUNT(*) AS salidas,
      COALESCE(SUM(cr.tp), 0) AS tp,
      COALESCE(SUM(cr.total), 0) AS total
    FROM checadores_reportes cr
    INNER JOIN checadores c ON c.id = cr.checador_id
    INNER JOIN usuarios u ON u.id = c.usuario_id
    WHERE cr.fecha BETWEEN ? AND ?
      AND c.usuario_id IS NOT NULL
      AND c.activo = 1
      AND u.activo = 1
    GROUP BY c.usuario_id, u.nombre, u.usuario, u.rol, c.id, c.codigo_reporte, checador_nombre, cr.fecha
    `,
    [desde, hasta]
  );

  const map = new Map();

  for (const row of surtidorRows) {
    const key = `U:${row.usuario_id}`;
    const item = addBaseUser(map, key, {
      usuario_id: row.usuario_id,
      nombre: row.usuario_nombre,
      usuario: row.usuario,
      rol: row.rol,
      surtidor_id: row.surtidor_id,
      surtidor_codigo: row.surtidor_codigo
    });

    item.fechas_set.add(row.fecha_operativa);
    item.surtidor.sesiones += toNumber(row.sesiones);
    item.surtidor.surtido_total += toNumber(row.surtido_total);
    item.surtidor.partidas_surtidas += toNumber(row.partidas_surtidas);
    item.surtidor.ceros += toNumber(row.ceros);
    item.surtidor.negados += toNumber(row.negados);
    item.surtidor.tiempo_activo_segundos += toNumber(row.tiempo_activo_segundos);
  }

  for (const row of checadorRows) {
    const key = `U:${row.usuario_id}`;
    const item = addBaseUser(map, key, {
      usuario_id: row.usuario_id,
      nombre: row.usuario_nombre || row.checador_nombre,
      usuario: row.usuario,
      rol: row.rol,
      checador_id: row.checador_id,
      checador_codigo: row.checador_codigo,
      checador_nombre: row.checador_nombre
    });

    item.fechas_set.add(row.fecha);
    item.checador.registros += toNumber(row.registros);
    item.checador.salidas += toNumber(row.salidas);
    item.checador.tp += toNumber(row.tp);
    item.checador.total += toNumber(row.total);
  }

  const usuarios = [...map.values()].map((item) => {
    const fechas = [...item.fechas_set];
    const jornadaSegundos = getJornadaDisponibleSegundosPorFechas(fechas);
    const jornadaHoras = jornadaSegundos / 3600;

    return {
      key: item.key,
      usuario_id: item.usuario_id,
      nombre: item.nombre,
      usuario: item.usuario,
      rol: item.rol,
      surtidor_id: item.surtidor_id,
      surtidor_codigo: item.surtidor_codigo,
      checador_id: item.checador_id,
      checador_codigo: item.checador_codigo,
      es_surtidor: Boolean(item.surtidor_id || item.surtidor.sesiones),
      es_checador: Boolean(item.checador_id || item.checador.registros),
      es_mixto: Boolean((item.surtidor_id || item.surtidor.sesiones) && (item.checador_id || item.checador.registros)),
      fechas,
      jornada_disponible_segundos: jornadaSegundos,
      jornada_disponible_horas: secondsToHours(jornadaSegundos),
      surtidor: {
        ...item.surtidor,
        tiempo_activo_horas: secondsToHours(item.surtidor.tiempo_activo_segundos),
        partidas_por_hora_jornada: jornadaHoras ? round2(item.surtidor.partidas_surtidas / jornadaHoras) : 0
      },
      checador: {
        ...item.checador,
        tp: round2(item.checador.tp),
        total: round2(item.checador.total),
        salidas_por_hora_jornada: jornadaHoras ? round2(item.checador.salidas / jornadaHoras) : 0,
        tp_por_hora_jornada: jornadaHoras ? round2(item.checador.tp / jornadaHoras) : 0
      }
    };
  }).sort((a, b) => {
    if (a.es_mixto !== b.es_mixto) return a.es_mixto ? -1 : 1;
    return b.surtidor.partidas_surtidas - a.surtidor.partidas_surtidas || b.checador.salidas - a.checador.salidas;
  });

  const resumen = usuarios.reduce((acc, item) => {
    acc.usuarios += 1;
    acc.mixtos += item.es_mixto ? 1 : 0;
    acc.solo_surtidores += item.es_surtidor && !item.es_checador ? 1 : 0;
    acc.solo_checadores += item.es_checador && !item.es_surtidor ? 1 : 0;
    acc.partidas_surtidas += item.surtidor.partidas_surtidas;
    acc.surtido_total += item.surtidor.surtido_total;
    acc.salidas += item.checador.salidas;
    acc.tp += item.checador.tp;
    acc.total += item.checador.total;
    return acc;
  }, {
    usuarios: 0,
    mixtos: 0,
    solo_surtidores: 0,
    solo_checadores: 0,
    partidas_surtidas: 0,
    surtido_total: 0,
    salidas: 0,
    tp: 0,
    total: 0
  });

  resumen.tp = round2(resumen.tp);
  resumen.total = round2(resumen.total);

  res.json({ ok: true, filtros: { desde, hasta }, resumen, usuarios });
});
