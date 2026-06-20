import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import {
  generalLimiter,
  authLimiter,
  uploadLimiter,
  exportLimiter
} from './middlewares/rateLimit.middleware.js';

import { env, getAllowedOrigins, isProduction } from './config/env.js';
import {
  testConnection,
  dbHealth,
  pool,
  startDbHeartbeat,
  stopDbHeartbeat
} from './config/db.js';
import { notFoundMiddleware, errorMiddleware } from './middlewares/error.middleware.js';
import authRoutes from './routes/auth.routes.js';
import usuariosRoutes from './routes/usuarios.routes.js';
import sucursalesRoutes from './routes/sucursales.routes.js';
import surtidoresRoutes from './routes/surtidores.routes.js';
import productividadSesionesRoutes from './routes/productividadSesiones.routes.js';
import reporteGrupalRoutes from './routes/reporteGrupal.routes.js';
import concentradosRoutes from './routes/concentrados.routes.js';
import comparativoRoutes from './routes/comparativo.routes.js';
import dashboardRoutes from './routes/dashboard.routes.js';
import productividadMetricasRoutes from './routes/productividadMetricas.routes.js';
import exportacionesRoutes from './routes/exportaciones.routes.js';
import auditoriaRoutes from './routes/auditoria.routes.js';
import checadoresRoutes from './routes/checadores.routes.js';
import productividadDetalleRoutes from './routes/productividadDetalle.routes.js';
import productividadMantenimientoRoutes from './routes/productividadMantenimiento.routes.js';
import productividadIntegralRoutes from './routes/productividadIntegral.routes.js';
import productividadNegadosRoutes from './routes/productividadNegados.routes.js';
import mayoreoRoutes from './routes/mayoreo.routes.js';
import comisionesRoutes from './routes/comisiones.routes.js';

const app = express();

app.set('trust proxy', env.TRUST_PROXY);

const allowedOrigins = getAllowedOrigins();

app.disable('x-powered-by');

app.use(helmet({
  crossOriginResourcePolicy: false
}));

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error(`Origen no permitido por CORS: ${origin}`));
  },
  credentials: true
}));

app.use(express.json({ limit: env.BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: env.BODY_LIMIT }));

app.use(morgan(isProduction() ? 'combined' : 'dev'));

app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

app.use('/api/auth/login', authLimiter);
app.use('/api/productividad/reporte-grupal/importar-excel', uploadLimiter);
app.use('/api/productividad/exportar', exportLimiter);
app.use('/api', generalLimiter);

app.get('/', (req, res) => {
  res.json({
    ok: true,
    message: 'API Productividad Surtidores funcionando correctamente',
    environment: env.NODE_ENV
  });
});

app.get('/api/health', async (req, res, next) => {
  try {
    await testConnection();

    res.json({
      ok: true,
      message: 'Servidor y base de datos funcionando correctamente'
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/health/detalle', async (req, res, next) => {
  try {
    const db = await dbHealth();

    res.json({
      ok: true,
      api: {
        status: 'UP',
        environment: env.NODE_ENV,
        uptime_seconds: Math.round(process.uptime())
      },
      database: {
        status: 'UP',
        name: db.database_name,
        server_time: db.server_time,
        version: db.mysql_version
      }
    });
  } catch (error) {
    next(error);
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/usuarios', usuariosRoutes);
app.use('/api/sucursales', sucursalesRoutes);
app.use('/api/surtidores', surtidoresRoutes);
app.use('/api/productividad/sesiones', productividadSesionesRoutes);
app.use('/api/productividad/reporte-grupal', reporteGrupalRoutes);
app.use('/api/productividad/concentrados', concentradosRoutes);
app.use('/api/productividad/comparativo', comparativoRoutes);
app.use('/api/productividad/dashboard', dashboardRoutes);
app.use('/api/productividad/metricas', productividadMetricasRoutes);
app.use('/api/productividad/exportar', exportacionesRoutes);
app.use('/api/checadores', checadoresRoutes);
app.use('/api/auditoria', auditoriaRoutes);
app.use('/api/productividad/detalle', productividadDetalleRoutes);
app.use('/api/productividad/integral', productividadIntegralRoutes);
app.use('/api/productividad/mantenimiento', productividadMantenimientoRoutes);
app.use('/api/productividad/negados', productividadNegadosRoutes);
app.use('/api/mayoreo', mayoreoRoutes);
app.use('/api/comisiones', comisionesRoutes);

app.use(notFoundMiddleware);
app.use(errorMiddleware);

let server;

async function startServer() {
  try {
    await testConnection();
    startDbHeartbeat();

    server = app.listen(env.PORT, '0.0.0.0', () => {
      console.log(`API Productividad Surtidores en http://localhost:${env.PORT}`);
      console.log(`Entorno: ${env.NODE_ENV}`);
      console.log(`CORS permitido: ${allowedOrigins.join(', ')}`);
    });
  } catch (error) {
    console.error('No se pudo iniciar el servidor:', error);
    process.exit(1);
  }
}

async function shutdown(signal) {
  console.log(`Recibido ${signal}. Cerrando servidor...`);

  try {
    if (server) {
      server.close(() => {
        console.log('Servidor HTTP cerrado.');
      });
    }

    stopDbHeartbeat();

    await pool.end();
    console.log('Pool MySQL cerrado.');

    process.exit(0);
  } catch (error) {
    console.error('Error durante apagado:', error);
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

startServer();