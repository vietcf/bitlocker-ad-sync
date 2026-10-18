import express, { Router } from 'express';
import { AppError } from '../http/errors.js';
import { requireJsonBody, verifyCsrf } from '../http/csrf.js';
import { rejectNul } from '../http/validate.js';
import { loadUser, requireCapability, requireUser } from '../modules/auth/auth.middleware.js';
import { authApi, meApi } from '../modules/auth/auth.api.js';
import { computersApi } from '../modules/computers/computers.api.js';
import { keysApi } from '../modules/keys/keys.api.js';
import { auditApi } from '../modules/audit/audit.api.js';
import { reportsApi } from '../modules/reports/reports.api.js';
import { adminApi } from '../modules/admin/admin.api.js';
import { dashboardApi } from '../modules/dashboard/dashboard.api.js';
import { apiDocs } from '../http/api-docs.js';

/**
 * The JSON API under /api, for the page's own scripts and other internal clients.
 * Same session cookie as the web pages; state-changing calls need JSON + X-CSRF-Token.
 */
export function createApiRouter({ services, config, sessions }) {
  const api = Router();
  api.use(sessions, express.json({ limit: '100kb' }), requireJsonBody, rejectNul);
  api.use(loadUser({ auth: services.auth, config, settings: services.settings }));
  // Sign-in has no token yet; JSON-only bodies already block cross-site form posts.
  api.use((req, res, next) => (req.path === '/auth/login' ? next() : verifyCsrf(req, res, next)));

  const signedIn = requireUser({ allowWhilePasswordChange: ['/api/me', '/api/auth/change-password'] });

  api.use('/auth', authApi(services, { requireUser: signedIn }));
  api.use(signedIn);
  // Swagger UI of this API (server/openapi/app.openapi.yaml), for signed-in users.
  api.use('/docs', apiDocs('app', 'BitLocker Key Management API'));
  api.use('/me', meApi());
  api.use('/dashboard', dashboardApi(services));
  // Mounted at the root (it serves /computers and /keys/search), so no capability gate here:
  // a gate on '/' would also block every route below. The service checks the capability.
  // The capability is checked before any input is read, so a role without it always gets 403.
  api.use(['/computers', '/keys/search'], requireCapability('keys'));
  api.use('/', computersApi(services));
  api.use('/keys', requireCapability('keys'), keysApi(services));
  api.use('/audit', requireCapability('logs'), auditApi(services));
  api.use('/reports', requireCapability('reports'), reportsApi(services));
  api.use('/admin', requireCapability('admin'), adminApi(services));

  api.use((req, res) => res.status(404).json({ error: 'not_found' }));
  api.use(apiErrorHandler);
  return api;
}

/** AppError -> { error, message, ...details }; anything else -> 500 with a request id only. */
// eslint-disable-next-line no-unused-vars
export function apiErrorHandler(err, req, res, next) {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'too_large' });
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: err.code, message: err.message, ...(err.details ?? {}) });
  }
  req.log.error({ err }, 'unhandled API error');
  res.status(500).json({ error: 'internal', requestId: req.id });
}
