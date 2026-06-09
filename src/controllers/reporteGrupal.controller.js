import { pool } from '../config/db.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { registrarAuditoria } from '../utils/auditoria.js';
import {
  parseReporteGrupalExcel,
  normalizarSucursalKey
} from '../utils/excelReporteGrupal.js';

function toPositiveId(value, fieldName) {
  const id = Number(value);

  if (!Number.isInteger(id) || id <= 0) {
    const error = new Error(`${fieldName} inválido`);
    error.status = 400;
    throw error;
  }

  return id;
}

function toNonNegativeInt(value, fieldName, defaultValue = 0) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  const number = Number(value);

  if (!Number.isInteger(number) || number < 0) {
    const error = new Error(`${fieldName} debe ser un número entero mayor o igual a 0`);
    error.status = 400;
    throw error;
  }

  return number;
}

function toNullablePercentage(value, fieldName = 'porcentaje_surtido') {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const number = Number(value);

  if (Number.isNaN(number) || number < 0 || number > 100) {
    const error = new Error(`${fieldName} debe ser un porcentaje entre 0 y 100`);
    error.status = 400;
    throw error;
  }

  return Number(number.toFixed(2));
}

function validarFecha(fecha) {
  const value = String(fecha || '').trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const error = new Error('La fecha debe tener formato YYYY-MM-DD');
    error.status = 400;
    throw error;
  }

  return value;
}

function construirDatosReporte(body, actual = {}) {
  return {
    fecha: body.fecha !== undefined ? validarFecha(body.fecha) : actual.fecha,
    sucursal_id: body.sucursal_id !== undefined
      ? toPositiveId(body.sucursal_id, 'sucursal_id')
      : actual.sucursal_id,

    surtido: toNonNegativeInt(body.surtido, 'surtido', actual.surtido ?? 0),
    partidas: toNonNegativeInt(body.partidas, 'partidas', actual.partidas ?? 0),
    ceros: toNonNegativeInt(body.ceros, 'ceros', actual.ceros ?? 0),
    no_surtido: toNonNegativeInt(body.no_surtido, 'no_surtido', actual.no_surtido ?? 0),
    porcentaje_surtido: body.porcentaje_surtido !== undefined
      ? toNullablePercentage(body.porcentaje_surtido)
      : actual.porcentaje_surtido ?? null,
    fuente: body.fuente ? String(body.fuente).trim().toUpperCase() : actual.fuente ?? 'MANUAL'
  };
}

async function validarSucursal(connection, sucursalId) {
  const [rows] = await connection.query(
    `
    SELECT id, nombre, activo
    FROM sucursales
    WHERE id = ?
    LIMIT 1
    `,
    [sucursalId]
  );

  if (rows.length === 0) {
    const error = new Error('Sucursal no encontrada');
    error.status = 404;
    throw error;
  }

  if (!rows[0].activo) {
    const error = new Error('No puedes cargar reporte a una sucursal inactiva');
    error.status = 400;
    throw error;
  }

  return rows[0];
}

async function obtenerReportePorId(connection, id) {
  const [rows] = await connection.query(
    `
    SELECT
      rg.id,
      rg.fecha,
      rg.sucursal_id,
      s.nombre AS sucursal_nombre,

      rg.surtido,
      rg.partidas,
      rg.ceros,
      rg.no_surtido,
      rg.porcentaje_surtido,

      rg.fuente,
      rg.estado,

      rg.cargado_por,
      u.nombre AS cargado_por_nombre,

      rg.created_at,
      rg.updated_at
    FROM reporte_grupal_surtido rg
    INNER JOIN sucursales s ON s.id = rg.sucursal_id
    LEFT JOIN usuarios u ON u.id = rg.cargado_por
    WHERE rg.id = ?
    LIMIT 1
    `,
    [id]
  );

  return rows[0] || null;
}

export const guardarReporteGrupal = asyncHandler(async (req, res) => {
  const datos = construirDatosReporte(req.body);

  if (!datos.fecha) {
    return res.status(400).json({
      ok: false,
      message: 'La fecha es obligatoria'
    });
  }

  if (!datos.sucursal_id) {
    return res.status(400).json({
      ok: false,
      message: 'La sucursal es obligatoria'
    });
  }

  if (!['MANUAL', 'EXCEL'].includes(datos.fuente)) {
    return res.status(400).json({
      ok: false,
      message: 'La fuente debe ser MANUAL o EXCEL'
    });
  }

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    await validarSucursal(connection, datos.sucursal_id);

    const [existenteRows] = await connection.query(
      `
      SELECT *
      FROM reporte_grupal_surtido
      WHERE fecha = ?
        AND sucursal_id = ?
      LIMIT 1
      `,
      [datos.fecha, datos.sucursal_id]
    );

    let reporteId;
    let accion;

    if (existenteRows.length > 0) {
      const existente = existenteRows[0];
      reporteId = existente.id;
      accion = 'ACTUALIZAR_REPORTE_GRUPAL';

      await connection.query(
        `
        UPDATE reporte_grupal_surtido
        SET
          surtido = ?,
          partidas = ?,
          ceros = ?,
          no_surtido = ?,
          porcentaje_surtido = ?,
          fuente = ?,
          estado = 'CARGADO',
          cargado_por = ?
        WHERE id = ?
        `,
        [
          datos.surtido,
          datos.partidas,
          datos.ceros,
          datos.no_surtido,
          datos.porcentaje_surtido,
          datos.fuente,
          req.user.id,
          reporteId
        ]
      );

      await registrarAuditoria(connection, {
        req,
        modulo: 'PRODUCTIVIDAD',
        accion,
        entidad: 'reporte_grupal_surtido',
        entidadId: reporteId,
        datosAntes: existente,
        datosDespues: datos
      });
    } else {
      accion = 'CREAR_REPORTE_GRUPAL';

      const [result] = await connection.query(
        `
        INSERT INTO reporte_grupal_surtido (
          fecha,
          sucursal_id,
          surtido,
          partidas,
          ceros,
          no_surtido,
          porcentaje_surtido,
          fuente,
          estado,
          cargado_por
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'CARGADO', ?)
        `,
        [
          datos.fecha,
          datos.sucursal_id,
          datos.surtido,
          datos.partidas,
          datos.ceros,
          datos.no_surtido,
          datos.porcentaje_surtido,
          datos.fuente,
          req.user.id
        ]
      );

      reporteId = result.insertId;

      await registrarAuditoria(connection, {
        req,
        modulo: 'PRODUCTIVIDAD',
        accion,
        entidad: 'reporte_grupal_surtido',
        entidadId: reporteId,
        datosDespues: datos
      });
    }

    await connection.commit();

    const reporte = await obtenerReportePorId(pool, reporteId);

    res.status(existenteRows.length > 0 ? 200 : 201).json({
      ok: true,
      message: existenteRows.length > 0
        ? 'Reporte grupal actualizado correctamente'
        : 'Reporte grupal creado correctamente',
      reporte
    });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
});

export const guardarReporteGrupalBulk = asyncHandler(async (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : null;

  if (!items || items.length === 0) {
    return res.status(400).json({
      ok: false,
      message: 'Debes enviar un arreglo items con al menos un reporte'
    });
  }

  if (items.length > 100) {
    return res.status(400).json({
      ok: false,
      message: 'Máximo 100 reportes por carga'
    });
  }

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const resultados = [];

    for (const item of items) {
      const datos = construirDatosReporte(item);

      if (!datos.fecha || !datos.sucursal_id) {
        const error = new Error('Cada item debe incluir fecha y sucursal_id');
        error.status = 400;
        throw error;
      }

      if (!['MANUAL', 'EXCEL'].includes(datos.fuente)) {
        const error = new Error('La fuente debe ser MANUAL o EXCEL');
        error.status = 400;
        throw error;
      }

      await validarSucursal(connection, datos.sucursal_id);

      const [existenteRows] = await connection.query(
        `
        SELECT *
        FROM reporte_grupal_surtido
        WHERE fecha = ?
          AND sucursal_id = ?
        LIMIT 1
        `,
        [datos.fecha, datos.sucursal_id]
      );

      let reporteId;
      let operacion;

      if (existenteRows.length > 0) {
        const existente = existenteRows[0];
        reporteId = existente.id;
        operacion = 'actualizado';

        await connection.query(
          `
          UPDATE reporte_grupal_surtido
          SET
            surtido = ?,
            partidas = ?,
            ceros = ?,
            no_surtido = ?,
            porcentaje_surtido = ?,
            fuente = ?,
            estado = 'CARGADO',
            cargado_por = ?
          WHERE id = ?
          `,
          [
            datos.surtido,
            datos.partidas,
            datos.ceros,
            datos.no_surtido,
            datos.porcentaje_surtido,
            datos.fuente,
            req.user.id,
            reporteId
          ]
        );

        await registrarAuditoria(connection, {
          req,
          modulo: 'PRODUCTIVIDAD',
          accion: 'ACTUALIZAR_REPORTE_GRUPAL_BULK',
          entidad: 'reporte_grupal_surtido',
          entidadId: reporteId,
          datosAntes: existente,
          datosDespues: datos
        });
      } else {
        operacion = 'creado';

        const [result] = await connection.query(
          `
          INSERT INTO reporte_grupal_surtido (
            fecha,
            sucursal_id,
            surtido,
            partidas,
            ceros,
            no_surtido,
            porcentaje_surtido,
            fuente,
            estado,
            cargado_por
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'CARGADO', ?)
          `,
          [
            datos.fecha,
            datos.sucursal_id,
            datos.surtido,
            datos.partidas,
            datos.ceros,
            datos.no_surtido,
            datos.porcentaje_surtido,
            datos.fuente,
            req.user.id
          ]
        );

        reporteId = result.insertId;

        await registrarAuditoria(connection, {
          req,
          modulo: 'PRODUCTIVIDAD',
          accion: 'CREAR_REPORTE_GRUPAL_BULK',
          entidad: 'reporte_grupal_surtido',
          entidadId: reporteId,
          datosDespues: datos
        });
      }

      resultados.push({
        id: reporteId,
        fecha: datos.fecha,
        sucursal_id: datos.sucursal_id,
        operacion
      });
    }

    await connection.commit();

    res.status(201).json({
      ok: true,
      message: 'Carga grupal procesada correctamente',
      total: resultados.length,
      resultados
    });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
});

export const listarReportesGrupales = asyncHandler(async (req, res) => {
  const { fecha, desde, hasta, sucursal_id, estado } = req.query;

  const where = [];
  const params = [];

  if (fecha) {
    where.push('rg.fecha = ?');
    params.push(validarFecha(fecha));
  }

  if (desde) {
    where.push('rg.fecha >= ?');
    params.push(validarFecha(desde));
  }

  if (hasta) {
    where.push('rg.fecha <= ?');
    params.push(validarFecha(hasta));
  }

  if (sucursal_id) {
    where.push('rg.sucursal_id = ?');
    params.push(toPositiveId(sucursal_id, 'sucursal_id'));
  }

  if (estado) {
    where.push('rg.estado = ?');
    params.push(String(estado).trim().toUpperCase());
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [reportes] = await pool.query(
    `
    SELECT
      rg.id,
      rg.fecha,
      rg.sucursal_id,
      s.nombre AS sucursal_nombre,

      rg.surtido,
      rg.partidas,
      rg.ceros,
      rg.no_surtido,
      rg.porcentaje_surtido,

      rg.fuente,
      rg.estado,

      rg.cargado_por,
      u.nombre AS cargado_por_nombre,

      rg.created_at,
      rg.updated_at
    FROM reporte_grupal_surtido rg
    INNER JOIN sucursales s ON s.id = rg.sucursal_id
    LEFT JOIN usuarios u ON u.id = rg.cargado_por
    ${whereSql}
    ORDER BY rg.fecha DESC, s.nombre ASC
    `,
    params
  );

  res.json({
    ok: true,
    reportes
  });
});

export const obtenerReporteGrupal = asyncHandler(async (req, res) => {
  const id = toPositiveId(req.params.id, 'ID de reporte');

  const reporte = await obtenerReportePorId(pool, id);

  if (!reporte) {
    return res.status(404).json({
      ok: false,
      message: 'Reporte grupal no encontrado'
    });
  }

  res.json({
    ok: true,
    reporte
  });
});

export const actualizarReporteGrupal = asyncHandler(async (req, res) => {
  const id = toPositiveId(req.params.id, 'ID de reporte');

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [actualRows] = await connection.query(
      `
      SELECT *
      FROM reporte_grupal_surtido
      WHERE id = ?
      LIMIT 1
      `,
      [id]
    );

    if (actualRows.length === 0) {
      await connection.rollback();

      return res.status(404).json({
        ok: false,
        message: 'Reporte grupal no encontrado'
      });
    }

    const actual = actualRows[0];
    const datos = construirDatosReporte(req.body, actual);

    await validarSucursal(connection, datos.sucursal_id);

    await connection.query(
      `
      UPDATE reporte_grupal_surtido
      SET
        fecha = ?,
        sucursal_id = ?,
        surtido = ?,
        partidas = ?,
        ceros = ?,
        no_surtido = ?,
        porcentaje_surtido = ?,
        fuente = ?,
        estado = 'CARGADO',
        cargado_por = ?
      WHERE id = ?
      `,
      [
        datos.fecha,
        datos.sucursal_id,
        datos.surtido,
        datos.partidas,
        datos.ceros,
        datos.no_surtido,
        datos.porcentaje_surtido,
        datos.fuente,
        req.user.id,
        id
      ]
    );

    await registrarAuditoria(connection, {
      req,
      modulo: 'PRODUCTIVIDAD',
      accion: 'ACTUALIZAR_REPORTE_GRUPAL',
      entidad: 'reporte_grupal_surtido',
      entidadId: id,
      datosAntes: actual,
      datosDespues: datos
    });

    await connection.commit();

    const reporte = await obtenerReportePorId(pool, id);

    res.json({
      ok: true,
      message: 'Reporte grupal actualizado correctamente',
      reporte
    });
  } catch (error) {
    await connection.rollback();

    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        ok: false,
        message: 'Ya existe un reporte para esa fecha y sucursal'
      });
    }

    throw error;
  } finally {
    connection.release();
  }
});

export const eliminarReporteGrupal = asyncHandler(async (req, res) => {
  const id = toPositiveId(req.params.id, 'ID de reporte');

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [actualRows] = await connection.query(
      `
      SELECT *
      FROM reporte_grupal_surtido
      WHERE id = ?
      LIMIT 1
      `,
      [id]
    );

    if (actualRows.length === 0) {
      await connection.rollback();

      return res.status(404).json({
        ok: false,
        message: 'Reporte grupal no encontrado'
      });
    }

    await connection.query(
      'DELETE FROM reporte_grupal_surtido WHERE id = ?',
      [id]
    );

    await registrarAuditoria(connection, {
      req,
      modulo: 'PRODUCTIVIDAD',
      accion: 'ELIMINAR_REPORTE_GRUPAL',
      entidad: 'reporte_grupal_surtido',
      entidadId: id,
      datosAntes: actualRows[0]
    });

    await connection.commit();

    res.json({
      ok: true,
      message: 'Reporte grupal eliminado correctamente'
    });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
});
export const importarReporteGrupalExcel = asyncHandler(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      ok: false,
      message: 'Debes subir un archivo Excel en el campo archivo'
    });
  }

  const dryRun = String(req.query.dry_run || req.body.dry_run || '0') === '1';
  const fechaDefault = req.body.fecha || req.query.fecha || null;
  const sheetName = req.body.sheet || req.query.sheet || null;

  const parseResult = parseReporteGrupalExcel(req.file.buffer, {
    fechaDefault,
    sheetName
  });

  if (parseResult.rows.length === 0) {
    return res.status(400).json({
      ok: false,
      message: 'El Excel no contiene filas válidas para importar',
      errores: parseResult.errores
    });
  }

  const connection = await pool.getConnection();

  try {
    const [sucursales] = await connection.query(
      `
      SELECT id, nombre, clave, activo
      FROM sucursales
      WHERE activo = 1
      `
    );

    const sucursalMap = new Map();

    for (const sucursal of sucursales) {
      sucursalMap.set(normalizarSucursalKey(sucursal.nombre), sucursal);

      if (sucursal.clave) {
        sucursalMap.set(normalizarSucursalKey(sucursal.clave), sucursal);
      }
    }

    const errores = [...parseResult.errores];
    const rowsPreparadas = [];

    for (const row of parseResult.rows) {
      const sucursal = sucursalMap.get(row.sucursal_key);

      if (!sucursal) {
        errores.push({
          fila: row.fila_excel,
          campo: 'sucursal',
          message: `No existe una sucursal activa con el nombre "${row.sucursal_nombre}"`
        });

        continue;
      }

      rowsPreparadas.push({
        ...row,
        sucursal_id: sucursal.id,
        sucursal_nombre_bd: sucursal.nombre
      });
    }

    if (errores.length > 0) {
      return res.status(400).json({
        ok: false,
        message: 'El Excel tiene errores. Corrige las filas antes de importar.',
        hoja: parseResult.hoja,
        total_filas_excel: parseResult.total_filas_excel,
        total_rows_validas: parseResult.total_rows_validas,
        total_preparadas: rowsPreparadas.length,
        errores,
        preview: rowsPreparadas.slice(0, 20)
      });
    }

    if (dryRun) {
      return res.json({
        ok: true,
        message: 'Validación correcta. No se guardó información porque dry_run=1.',
        hoja: parseResult.hoja,
        total_filas_excel: parseResult.total_filas_excel,
        total_preparadas: rowsPreparadas.length,
        preview: rowsPreparadas.slice(0, 50)
      });
    }

    await connection.beginTransaction();

    const resultados = [];

    for (const row of rowsPreparadas) {
      const [existenteRows] = await connection.query(
        `
        SELECT *
        FROM reporte_grupal_surtido
        WHERE fecha = ?
          AND sucursal_id = ?
        LIMIT 1
        `,
        [row.fecha, row.sucursal_id]
      );

      let reporteId;
      let operacion;

      if (existenteRows.length > 0) {
        const existente = existenteRows[0];

        reporteId = existente.id;
        operacion = 'actualizado';

        await connection.query(
          `
          UPDATE reporte_grupal_surtido
          SET
            surtido = ?,
            partidas = ?,
            ceros = ?,
            no_surtido = ?,
            porcentaje_surtido = ?,
            fuente = 'EXCEL',
            estado = 'CARGADO',
            cargado_por = ?
          WHERE id = ?
          `,
          [
            row.surtido,
            row.partidas,
            row.ceros,
            row.no_surtido,
            row.porcentaje_surtido,
            req.user.id,
            reporteId
          ]
        );

        await registrarAuditoria(connection, {
          req,
          modulo: 'PRODUCTIVIDAD',
          accion: 'ACTUALIZAR_REPORTE_GRUPAL_EXCEL',
          entidad: 'reporte_grupal_surtido',
          entidadId: reporteId,
          datosAntes: existente,
          datosDespues: row
        });
      } else {
        operacion = 'creado';

        const [result] = await connection.query(
          `
          INSERT INTO reporte_grupal_surtido (
            fecha,
            sucursal_id,
            surtido,
            partidas,
            ceros,
            no_surtido,
            porcentaje_surtido,
            fuente,
            estado,
            cargado_por
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, 'EXCEL', 'CARGADO', ?)
          `,
          [
            row.fecha,
            row.sucursal_id,
            row.surtido,
            row.partidas,
            row.ceros,
            row.no_surtido,
            row.porcentaje_surtido,
            req.user.id
          ]
        );

        reporteId = result.insertId;

        await registrarAuditoria(connection, {
          req,
          modulo: 'PRODUCTIVIDAD',
          accion: 'CREAR_REPORTE_GRUPAL_EXCEL',
          entidad: 'reporte_grupal_surtido',
          entidadId: reporteId,
          datosDespues: row
        });
      }

      resultados.push({
        id: reporteId,
        fila_excel: row.fila_excel,
        fecha: row.fecha,
        sucursal_id: row.sucursal_id,
        sucursal_nombre: row.sucursal_nombre_bd,
        operacion
      });
    }

    await registrarAuditoria(connection, {
      req,
      modulo: 'PRODUCTIVIDAD',
      accion: 'IMPORTAR_EXCEL_REPORTE_GRUPAL',
      entidad: 'reporte_grupal_surtido',
      entidadId: null,
      datosDespues: {
        archivo: req.file.originalname,
        hoja: parseResult.hoja,
        total_importados: resultados.length
      }
    });

    await connection.commit();

    res.status(201).json({
      ok: true,
      message: 'Excel importado correctamente',
      archivo: req.file.originalname,
      hoja: parseResult.hoja,
      total_importados: resultados.length,
      creados: resultados.filter((r) => r.operacion === 'creado').length,
      actualizados: resultados.filter((r) => r.operacion === 'actualizado').length,
      resultados
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