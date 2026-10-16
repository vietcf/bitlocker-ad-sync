import { randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError } from './errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Returns the session's CSRF token, creating one if needed (also for signed-out visitors). */
export function csrfToken(req) {
  req.session.csrfToken ??= randomBytes(32).toString('base64url');
  return req.session.csrfToken;
}

export function rotateCsrfToken(req) {
  req.session.csrfToken = randomBytes(32).toString('base64url');
  return req.session.csrfToken;
}

function same(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Synchronizer-token CSRF check for state-changing requests. The token comes from the
 * X-CSRF-Token header (API, fetch) or the `_csrf` form field (HTML forms).
 * The session cookie is also SameSite=Strict, so this is a second layer.
 */
export function verifyCsrf(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  const given = req.get('x-csrf-token') ?? req.body?._csrf;
  if (!same(req.session?.csrfToken, given)) {
    return next(new AppError(403, 'csrf_failed', 'Invalid or missing CSRF token. Reload the page and try again.'));
  }
  next();
}

/** API only: state-changing requests must carry JSON (blocks cross-site HTML form posts). */
export function requireJsonBody(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  const hasBody = req.headers['content-length'] && req.headers['content-length'] !== '0';
  if (hasBody && !req.is('application/json')) {
    return next(new AppError(415, 'json_required', 'The request body must be JSON.'));
  }
  next();
}
