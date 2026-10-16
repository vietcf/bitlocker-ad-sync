import { can } from '../../domain/scope.js';
import { AppError, forbidden, unauthorized } from '../../http/errors.js';
import { endUserSession } from './session.js';

/**
 * Session limits: Quan tri > Bao mat (settings session.idle_minutes / session.max_hours), else the
 * SESSION_IDLE_MINUTES / SESSION_MAX_HOURS defaults from .env.
 */
export async function sessionLimits(settings, config) {
  const get = async (key, fallback) => Number((settings ? await settings.get(key, fallback) : fallback) ?? fallback);
  return {
    idleMinutes: await get('session.idle_minutes', config.SESSION_IDLE_MINUTES),
    maxHours: await get('session.max_hours', config.SESSION_MAX_HOURS),
  };
}

/**
 * Loads the signed-in user (if any) onto req.scope and res.locals.me. Never fails the request
 * by itself: a stale or expired session is just ended. Grants are loaded fresh every request,
 * so disabling a user or changing their roles applies immediately.
 * A session ends after idleMinutes without any request (checked here, on the server, and by the
 * cookie expiry) or maxHours after sign-in, whatever happens.
 */
export function loadUser({ auth, config, settings = null }) {
  return async (req, res, next) => {
    req.scope = null;
    const s = req.session;
    const { idleMinutes, maxHours } = await sessionLimits(settings, config);
    res.locals.sessionIdleMinutes = idleMinutes;
    if (s?.userId) {
      const now = Date.now();
      const idle = s.lastSeenAt && now - s.lastSeenAt > idleMinutes * 60_000;
      if (!s.loginAt || now - s.loginAt > maxHours * 3_600_000 || idle) {
        await endUserSession(req, res);
        req.sessionExpired = true;
      } else {
        s.lastSeenAt = now;
        s.cookie.maxAge = idleMinutes * 60_000;
        req.scope = await auth.loadScope(s.userId, s.authMethod);
        if (!req.scope) await endUserSession(req, res);
      }
    }
    res.locals.me = req.scope;
    next();
  };
}

/**
 * Requires a signed-in user. Until a forced password change is done, only the paths in
 * `allowWhilePasswordChange` work.
 */
export function requireUser({ allowWhilePasswordChange = [] } = {}) {
  return (req, res, next) => {
    if (!req.scope) {
      return next(req.sessionExpired ? unauthorized('session_expired', 'Your session has expired.') : unauthorized());
    }
    if (req.scope.mustChangePassword && !allowWhilePasswordChange.includes(req.baseUrl + req.path)) {
      return next(new AppError(403, 'password_change_required', 'You must change your password before continuing.'));
    }
    next();
  };
}

/** 403 unless the user has the capability on at least one branch. */
export function requireCapability(capability) {
  return (req, res, next) => (can(req.scope, capability) ? next() : next(forbidden()));
}
