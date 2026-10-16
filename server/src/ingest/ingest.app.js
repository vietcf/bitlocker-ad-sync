import express, { Router } from 'express';
import { pinoHttp } from 'pino-http';
import { timingSafeEqual } from 'node:crypto';
import { AppError } from '../http/errors.js';
import { apiErrorHandler } from '../api/index.js';
import { apiDocs, loadSpec } from '../http/api-docs.js';

/** The OpenAPI document of this API (server/openapi/ingest.openapi.yaml). */
export const loadIngestSpec = () => loadSpec('ingest');

/**
 * Ingest API for the sync worker, on its own listener (INGEST_PORT).
 * Separate from the user API: no sessions, no endpoint that returns a key.
 * Over HTTPS: here (INGEST_TLS_CERT / KEY), or at the reverse proxy in front (INGEST_TRUST_PROXY).
 * The worker is checked by:
 *   - IP allowlist: INGEST_ALLOWED_IPS (the worker's address; behind the proxy, the address the
 *     proxy puts in X-Forwarded-For);
 *   - API key: "Authorization: Bearer <INGEST_API_KEY>".
 * Swagger UI is at /docs, the spec at /docs/openapi.yaml.
 */
export function createIngestApp({ config, logger, services }) {
  const app = express();
  app.disable('x-powered-by');
  if (config.INGEST_TRUST_PROXY) app.set('trust proxy', trustValue(config.INGEST_TRUST_PROXY));
  app.use(pinoHttp({ logger: logger.child({ listener: 'ingest' }) }));
  app.use(authenticateWorker(config));
  app.use(express.json({ limit: '2mb' }));

  // API documentation, behind the same worker authentication as the API itself, so "Try it out"
  // works from the same origin. The raw spec is what a worker client can be generated from.
  app.use('/docs', apiDocs('ingest', 'BitLocker Ingest API'));

  const { ingest } = services;
  const r = Router();
  r.get('/sync-runs/last', async (req, res) => res.json((await ingest.lastRun()) ?? {}));
  r.post('/sync-runs', async (req, res) => res.status(201).json(await ingest.openRun(req.body)));
  r.post('/computers', async (req, res) => res.json(await ingest.ingestComputers(req.body)));
  r.post('/keys', async (req, res) => res.json(await ingest.ingestKeys(req.body)));
  r.post('/sync-runs/:id/complete', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new AppError(400, 'invalid_request', 'Bad run id');
    res.json(await ingest.completeRun(id, req.body));
  });
  r.post('/heartbeat', async (req, res) => res.json(await ingest.heartbeat(req.body)));

  app.use('/api/ingest', r);
  app.use((req, res) => res.status(404).json({ error: 'not_found' }));
  app.use(apiErrorHandler);
  return app;
}

/** "1" (number of proxy hops) -> 1; anything else (IPs, subnets, "loopback"...) as given. */
export function trustValue(v) {
  return /^\d+$/.test(String(v).trim()) ? Number(v) : v;
}

function normalizeIp(ip) {
  return (ip ?? '').replace(/^::ffff:/, '');
}

function authenticateWorker(config) {
  const allowed = new Set(config.INGEST_ALLOWED_IPS.map(normalizeIp));
  const apiKey = config.INGEST_API_KEY ? Buffer.from(config.INGEST_API_KEY) : null;
  return (req, res, next) => {
    // Behind the trusted proxy req.ip is the worker's address (X-Forwarded-For); otherwise the peer's.
    const ip = normalizeIp(config.INGEST_TRUST_PROXY ? req.ip : req.socket.remoteAddress);
    if (allowed.size && !allowed.has(ip)) {
      req.log.warn({ ip }, 'ingest: address not allowed');
      return next(new AppError(403, 'forbidden', 'Address not allowed'));
    }
    if (apiKey) {
      const given = Buffer.from((req.get('authorization') ?? '').replace(/^Bearer\s+/i, ''));
      if (given.length !== apiKey.length || !timingSafeEqual(given, apiKey)) {
        return next(new AppError(401, 'bad_api_key', 'Invalid API key'));
      }
    }
    next();
  };
}
