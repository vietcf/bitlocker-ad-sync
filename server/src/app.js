import { fileURLToPath } from 'node:url';
import express from 'express';
import { pinoHttp } from 'pino-http';
import { securityHeaders } from './http/security.js';
import { createSessionMiddleware } from './modules/auth/session.js';
import { createApiRouter } from './api/index.js';
import { createWebRouter } from './web/index.js';
import { trustValue } from './ingest/ingest.app.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const VIEWS_DIR = fileURLToPath(new URL('./views/', import.meta.url));

/**
 * The user-facing app (behind the reverse proxy): server-rendered pages + the JSON API under /api.
 * deps: { config, pool, logger, services }
 */
export function createUserApp({ config, pool, logger, services }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', trustValue(config.TRUST_PROXY));
  app.set('view engine', 'ejs');
  app.set('views', VIEWS_DIR);

  app.use(securityHeaders());
  // Logs method, URL, status and timing only; bodies are never logged.
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/healthz' || req.url.startsWith('/static/') } }));

  // For the load balancer and external monitoring. No login; reveals no counts.
  app.get('/healthz', async (req, res) => {
    let dbOk = false;
    let syncAgeMinutes = null;
    try {
      const { rows } = await pool.query(
        `SELECT extract(epoch FROM now() - max(finished_at)) / 60 AS age FROM sync_run WHERE status = 'success'`,
      );
      dbOk = true;
      syncAgeMinutes = rows[0].age === null ? null : Math.round(Number(rows[0].age));
    } catch (err) {
      req.log.warn({ err }, 'healthz: database check failed');
    }
    const degraded = !dbOk || syncAgeMinutes === null || syncAgeMinutes > 60;
    res.status(dbOk ? 200 : 503).set('Cache-Control', 'no-store').json({ dbOk, syncAgeMinutes, degraded });
  });

  app.use('/static', express.static(PUBLIC_DIR, { maxAge: config.NODE_ENV === 'production' ? '1h' : 0, index: false }));

  const sessions = createSessionMiddleware({ config, pool });
  app.use('/api', createApiRouter({ services, config, sessions }));
  app.use('/', createWebRouter({ services, config, sessions }));

  return app;
}
