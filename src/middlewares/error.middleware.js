import multer from 'multer';
import { isProduction } from '../config/env.js';

function mapMySqlError(error) {
  if (!error || !error.code) return null;

  if (error.code === 'ER_DUP_ENTRY') {
    return {
      status: 409,
      message: 'Registro duplicado. Ya existe información con esos datos.'
    };
  }

  if (error.code === 'ER_NO_REFERENCED_ROW_2') {
    return {
      status: 400,
      message: 'No se puede guardar porque una referencia no existe.'
    };
  }

  if (error.code === 'ER_ROW_IS_REFERENCED_2') {
    return {
      status: 409,
      message: 'No se puede eliminar porque el registro tiene información relacionada.'
    };
  }

  if (
    error.code === 'ECONNRESET' ||
    error.code === 'PROTOCOL_CONNECTION_LOST' ||
    error.code === 'ETIMEDOUT'
  ) {
    return {
      status: 503,
      message: 'Error temporal de conexión con la base de datos.'
    };
  }

  return null;
}

function mapMulterError(error) {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return {
        status: 400,
        message: 'El archivo excede el tamaño máximo permitido.'
      };
    }

    return {
      status: 400,
      message: `Error al procesar archivo: ${error.message}`
    };
  }

  if (error?.message?.includes('Solo se permiten archivos Excel')) {
    return {
      status: 400,
      message: error.message
    };
  }

  return null;
}

export function notFoundMiddleware(req, res) {
  return res.status(404).json({
    ok: false,
    message: 'Ruta no encontrada',
    path: req.originalUrl
  });
}

export function errorMiddleware(error, req, res, next) {
  console.error('Error global:', {
    message: error.message,
    status: error.status,
    code: error.code,
    stack: error.stack
  });

  const multerError = mapMulterError(error);

  if (multerError) {
    return res.status(multerError.status).json({
      ok: false,
      message: multerError.message
    });
  }

  const mysqlError = mapMySqlError(error);

  if (mysqlError) {
    return res.status(mysqlError.status).json({
      ok: false,
      message: mysqlError.message
    });
  }

  const status = error.status || 500;

  return res.status(status).json({
    ok: false,
    message: error.message || 'Error interno del servidor',
    ...(isProduction()
      ? {}
      : {
          debug: {
            status,
            code: error.code || null,
            stack: error.stack || null
          }
        })
  });
}