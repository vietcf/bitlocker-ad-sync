import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { rotateCsrfToken } from '../../http/csrf.js';

export const SESSION_COOKIE = 'blk.sid';

/**
 * Server-side sessions in PostgreSQL (table `session`). The browser only holds a random id
 * in an HttpOnly, SameSite=Strict cookie. `rolling` pushes the expiry forward on every
 * request, which gives the idle timeout; the absolute limit is checked in loadUser.
 */
export function createSessionMiddleware({ config, pool }) {
  const PgStore = connectPgSimple(session);
  return session({
    store: new PgStore({ pool, tableName: 'session', createTableIfMissing: false, pruneSessionInterval: 15 * 60 }),
    name: SESSION_COOKIE,
    secret: config.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    proxy: true,
    cookie: {
      httpOnly: true,
      sameSite: 'strict',
      secure: config.COOKIE_SECURE ?? config.NODE_ENV === 'production',
      maxAge: config.SESSION_IDLE_MINUTES * 60 * 1000,
    },
  });
}

const promisify = (req, method) =>
  new Promise((resolve, reject) => req.session[method]((err) => (err ? reject(err) : resolve())));

/** After a successful sign-in: new session id (no fixation), new CSRF token. */
export async function startUserSession(req, user, authMethod = 'local') {
  await promisify(req, 'regenerate');
  req.session.userId = user.id;
  req.session.authMethod = authMethod;
  req.session.loginAt = Date.now();
  req.session.lastSeenAt = Date.now();
  rotateCsrfToken(req);
  await promisify(req, 'save');
}

/** How long the code / setup page of a two-step sign-in stays valid. */
export const PENDING_MINUTES = 5;

/**
 * Password accepted, second step to come: a new session that is NOT signed in (no userId), only
 * remembers who is signing in. The app's pages stay closed until completeSecondFactor().
 */
export async function startPendingSecondFactor(req, user, next = '/') {
  await promisify(req, 'regenerate');
  req.session.pending2fa = { userId: user.id, username: user.username, method: user.method ?? 'password', mode: user.secondFactor, next, at: Date.now() };
  rotateCsrfToken(req);
  await promisify(req, 'save');
}

/** The pending two-step sign-in of this session, or null when there is none or it is too old. */
export function pendingSecondFactor(req) {
  const p = req.session?.pending2fa;
  if (!p || Date.now() - p.at > PENDING_MINUTES * 60_000) return null;
  return p;
}

/** After a credential change: keep the user signed in, but under a fresh id and token. */
export async function refreshUserSession(req) {
  const { userId, authMethod, loginAt, lastSeenAt } = req.session;
  await promisify(req, 'regenerate');
  Object.assign(req.session, { userId, authMethod, loginAt, lastSeenAt });
  rotateCsrfToken(req);
  await promisify(req, 'save');
}

export async function endUserSession(req, res) {
  if (req.session) await promisify(req, 'destroy');
  res.clearCookie(SESSION_COOKIE);
}
