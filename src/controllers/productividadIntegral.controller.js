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
      surtidor_tipo_operacion: data.surtidor_tipo_operacion || null,
      checador_id: data.checador_id || null,
      checador_codigo: data.checador_codigo || null,
      fechas_sucursal_set: new Set(),
      fechas_checador_set: new Set(),
      fechas_mayoreo_set: new Set(),
      surtidor: {
        sesiones: 0,
        surtido_total: 0,
        partidas_surtidas: 0,
        ceros: 0,
        negados: 0,
        tiempo_activo_segundos: 0
      },
      checador: {
        registros: 0,
        salidas: 0,
        tp: 0,
        total: 0
      },
      mayoreo: {
        movimientos: 0,
        tickets: 0,
        partidas_oficiales: 0,
        negados_penalizables: 0,
        partidas_netas: 0,
        neto: 0,
        sesiones: 0,
        tiempo_activo_segundos: 0
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
  item.surtidor_tipo_operacion = item.surtidor_tipo_operacion || data.surtidor_tipo_operacion || null;
  item.checador_id = item.checador_id || data.checador_id || null;
  item.checador_codigo = item.checador_codigo || data.checador_codigo || null;

  return item;
}

export const productividadIntegralUsuarios = asyncHandler(async (req, res) => {
  const { desde, hasta } = getDateFilters(req.query);

  const [surtidorSucursalRows] = await pool.query(
    `
    SELECT
      u.id AS usuario_id,
      u.nombre AS usuario_nombre,
      u.usuario,
      u.rol,
      st.id AS surtidor_id,
      st.codigo AS surtidor_codigo,
      st.tipo_operacion AS surtidor_tipo_operacion,
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
      AND ps.tipo_operacion = 'SUCURSAL'
      AND st.activo = 1
      AND u.activo = 1
      AND ps.fecha_operativa BETWEEN ? AND ?
    GROUP BY u.id, u.nombre, u.usuario, u.rol, st.id, st.codigo, st.tipo_operacion, ps.fecha_operativa
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

  const [mayoreoRows] = await pool.query(
    `
    SELECT
      u.id AS usuario_id,
      u.nombre AS usuario_nombre,
      u.usuario,
      u.rol,
      st.id AS surtidor_id,
      st.codigo AS surtidor_codigo,
      st.tipo_operacion AS surtidor_tipo_operacion,
      DATE_FORMAT(mrs.fecha, '%Y-%m-%d') AS fecha,
      COUNT(*) AS movimientos,
      COUNT(DISTINCT mrs.ticket) AS tickets,
      COALESCE(SUM(mrs.tp), 0) AS partidas_oficiales,
      COALESCE(SUM(mrs.neto), 0) AS neto
    FROM mayoreo_reportes_surtidores mrs
    INNER JOIN surtidores st ON st.id = mrs.surtidor_id
    INNER JOIN usuarios u ON u.id = mrs.usuario_id
    WHERE mrs.reportable = 1
      AND mrs.fecha BETWEEN ? AND ?
      AND st.activo = 1
      AND u.activo = 1
    GROUP BY u.id, u.nombre, u.usuario, u.rol, st.id, st.codigo, st.tipo_operacion, mrs.fecha
    `,
    [desde, hasta]
  );

  const [mayoreoSesionesRows] = await pool.query(
    `
    SELECT
      u.id AS usuario_id,
      DATE_FORMAT(ps.fecha_operativa, '%Y-%m-%d') AS fecha_operativa,
      COUNT(*) AS sesiones,
      COALESCE(SUM(ps.duracion_laboral_segundos), 0) AS tiempo_activo_segundos
    FROM productividad_sesiones ps
    INNER JOIN surtidores st ON st.id = ps.surtidor_id
    INNER JOIN usuarios u ON u.id = st.usuario_id
    WHERE ps.estado = 'FINALIZADO'
      AND ps.tipo_operacion = 'MAYOREO'
      AND ps.fecha_operativa BETWEEN ? AND ?
      AND st.activo = 1
      AND u.activo = 1
    GROUP BY u.id, ps.fecha_operativa
    `,
    [desde, hasta]
  );

  const [mayoreoNegadosRows] = await pool.query(
    `
    SELECT
      usuario_id,
      COALESCE(SUM(cantidad_negada), 0) AS negados_penalizables
    FROM productividad_sesion_negados
    WHERE tipo_operacion = 'MAYOREO'
      AND estado_revision = 'RECHAZADO_PENALIZA'
      AND fecha_operativa BETWEEN ? AND ?
    GROUP BY usuario_id
    `,
    [desde, hasta]
  );

  const map = new Map();

  for (const row of surtidorSucursalRows) {
    const key = `U:${row.usuario_id}`;
    const item = addBaseUser(map, key, {
      usuario_id: row.usuario_id,
      nombre: row.usuario_nombre,
      usuario: row.usuario,
      rol: row.rol,
      surtidor_id: row.surtidor_id,
      surtidor_codigo: row.surtidor_codigo,
      surtidor_tipo_operacion: row.surtidor_tipo_operacion
    });

    item.fechas_sucursal_set.add(row.fecha_operativa);
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

    item.fechas_checador_set.add(row.fecha);
    item.checador.registros += toNumber(row.registros);
    item.checador.salidas += toNumber(row.salidas);
    item.checador.tp += toNumber(row.tp);
    item.checador.total += toNumber(row.total);
  }

  for (const row of mayoreoRows) {
    const key = `U:${row.usuario_id}`;
    const item = addBaseUser(map, key, {
      usuario_id: row.usuario_id,
      nombre: row.usuario_nombre,
      usuario: row.usuario,
      rol: row.rol,
      surtidor_id: row.surtidor_id,
      surtidor_codigo: row.surtidor_codigo,
      surtidor_tipo_operacion: row.surtidor_tipo_operacion
    });

    item.fechas_mayoreo_set.add(row.fecha);
    item.mayoreo.movimientos += toNumber(row.movimientos);
    item.mayoreo.tickets += toNumber(row.tickets);
    item.mayoreo.partidas_oficiales += toNumber(row.partidas_oficiales);
    item.mayoreo.neto += toNumber(row.neto);
  }

  for (const row of mayoreoSesionesRows) {
    const key = `U:${row.usuario_id}`;
    const item = addBaseUser(map, key, {
      usuario_id: row.usuario_id
    });

    item.fechas_mayoreo_set.add(row.fecha_operativa);
    item.mayoreo.sesiones += toNumber(row.sesiones);
    item.mayoreo.tiempo_activo_segundos += toNumber(row.tiempo_activo_segundos);
  }

  for (const row of mayoreoNegadosRows) {
    const key = `U:${row.usuario_id}`;
    const item = addBaseUser(map, key, {
      usuario_id: row.usuario_id
    });

    item.mayoreo.negados_penalizables += toNumber(row.negados_penalizables);
  }

  const usuarios = [...map.values()].map((item) => {
    const fechasSucursal = [...item.fechas_sucursal_set];
    const fechasChecador = [...item.fechas_checador_set];
    const fechasMayoreo = [...item.fechas_mayoreo_set];

    const jornadaSucursalSegundos = getJornadaDisponibleSegundosPorFechas(fechasSucursal, 'SUCURSAL');
    const jornadaChecadorSegundos = getJornadaDisponibleSegundosPorFechas(fechasChecador, 'SUCURSAL');
    const jornadaMayoreoSegundos = getJornadaDisponibleSegundosPorFechas(fechasMayoreo, 'MAYOREO');

    const jornadaSucursalHoras = jornadaSucursalSegundos / 3600;
    const jornadaChecadorHoras = jornadaChecadorSegundos / 3600;
    const mayoreoHorasActivas = item.mayoreo.tiempo_activo_segundos / 3600;

    item.mayoreo.partidas_netas = Math.max(0, item.mayoreo.partidas_oficiales - item.mayoreo.negados_penalizables);

    return {
      key: item.key,
      usuario_id: item.usuario_id,
      nombre: item.nombre,
      usuario: item.usuario,
      rol: item.rol,
      surtidor_id: item.surtidor_id,
      surtidor_codigo: item.surtidor_codigo,
      surtidor_tipo_operacion: item.surtidor_tipo_operacion,
      checador_id: item.checador_id,
      checador_codigo: item.checador_codigo,

      es_surtidor_sucursal: Boolean(item.surtidor.sesiones),
      es_surtidor_mayoreo: Boolean(item.mayoreo.movimientos || item.mayoreo.sesiones),
      es_checador: Boolean(item.checador_id || item.checador.registros),
      es_mixto: Boolean(
        (item.surtidor.sesiones || item.mayoreo.movimientos || item.mayoreo.sesiones) &&
        (item.checador_id || item.checador.registros)
      ),

      fechas_sucursal: fechasSucursal,
      fechas_checador: fechasChecador,
      fechas_mayoreo: fechasMayoreo,

      jornada_sucursal_segundos: jornadaSucursalSegundos,
      jornada_checador_segundos: jornadaChecadorSegundos,
      jornada_mayoreo_segundos: jornadaMayoreoSegundos,

      surtidor: {
        ...item.surtidor,
        tiempo_activo_horas: secondsToHours(item.surtidor.tiempo_activo_segundos),
        partidas_por_hora_jornada: jornadaSucursalHoras ? round2(item.surtidor.partidas_surtidas / jornadaSucursalHoras) : 0
      },

      checador: {
        ...item.checador,
        tp: round2(item.checador.tp),
        total: round2(item.checador.total),
        salidas_por_hora_jornada: jornadaChecadorHoras ? round2(item.checador.salidas / jornadaChecadorHoras) : 0,
        tp_por_hora_jornada: jornadaChecadorHoras ? round2(item.checador.tp / jornadaChecadorHoras) : 0
      },

      mayoreo: {
        ...item.mayoreo,
        neto: round2(item.mayoreo.neto),
        tiempo_activo_horas: secondsToHours(item.mayoreo.tiempo_activo_segundos),
        jornada_disponible_horas: secondsToHours(jornadaMayoreoSegundos),
        partidas_netas_por_hora_activa: mayoreoHorasActivas ? round2(item.mayoreo.partidas_netas / mayoreoHorasActivas) : 0,
        partidas_netas_por_hora_jornada: jornadaMayoreoSegundos ? round2(item.mayoreo.partidas_netas / (jornadaMayoreoSegundos / 3600)) : 0
      }
    };
  }).sort((a, b) => {
    if (a.es_mixto !== b.es_mixto) return a.es_mixto ? -1 : 1;

    return b.mayoreo.partidas_netas - a.mayoreo.partidas_netas ||
      b.surtidor.partidas_surtidas - a.surtidor.partidas_surtidas ||
      b.checador.salidas - a.checador.salidas;
  });

  const resumen = usuarios.reduce((acc, item) => {
    acc.usuarios += 1;
    acc.mixtos += item.es_mixto ? 1 : 0;
    acc.surtidores_sucursal += item.es_surtidor_sucursal ? 1 : 0;
    acc.surtidores_mayoreo += item.es_surtidor_mayoreo ? 1 : 0;
    acc.checadores += item.es_checador ? 1 : 0;

    acc.partidas_surtidas += item.surtidor.partidas_surtidas;
    acc.surtido_total += item.surtidor.surtido_total;
    acc.salidas += item.checador.salidas;
    acc.tp += item.checador.tp;
    acc.total += item.checador.total;
    acc.mayoreo_partidas_oficiales += item.mayoreo.partidas_oficiales;
    acc.mayoreo_partidas_netas += item.mayoreo.partidas_netas;
    acc.mayoreo_tickets += item.mayoreo.tickets;
    acc.mayoreo_neto += item.mayoreo.neto;
    acc.mayoreo_tiempo_activo_segundos += item.mayoreo.tiempo_activo_segundos;

    return acc;
  }, {
    usuarios: 0,
    mixtos: 0,
    surtidores_sucursal: 0,
    surtidores_mayoreo: 0,
    checadores: 0,
    partidas_surtidas: 0,
    surtido_total: 0,
    salidas: 0,
    tp: 0,
    total: 0,
    mayoreo_partidas_oficiales: 0,
    mayoreo_partidas_netas: 0,
    mayoreo_tickets: 0,
    mayoreo_neto: 0,
    mayoreo_tiempo_activo_segundos: 0
  });

  resumen.tp = round2(resumen.tp);
  resumen.total = round2(resumen.total);
  resumen.mayoreo_neto = round2(resumen.mayoreo_neto);
  resumen.mayoreo_tiempo_activo_horas = secondsToHours(resumen.mayoreo_tiempo_activo_segundos);
  resumen.mayoreo_partidas_netas_por_hora_activa = resumen.mayoreo_tiempo_activo_segundos
    ? round2(resumen.mayoreo_partidas_netas / (resumen.mayoreo_tiempo_activo_segundos / 3600))
    : 0;

  res.json({ ok: true, filtros: { desde, hasta }, resumen, usuarios });
});
