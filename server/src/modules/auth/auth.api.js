import { Router } from 'express';
import { z } from 'zod';
import { branchesFor, can, rolesOf } from '../../domain/scope.js';
import { parse } from '../../http/validate.js';
import { clientInfo, noStore } from '../../http/security.js';
import { endUserSession, pendingSecondFactor, refreshUserSession, startPendingSecondFactor, startUserSession } from './session.js';
import { unauthorized } from '../../http/errors.js';

const loginBody = z.object({ username: z.string().trim().min(1).max(128), password: z.string().min(1).max(256) });
const codeBody = z.object({ code: z.string().trim().max(16) });
const changeBody = z.object({ currentPassword: z.string().min(1).max(256), newPassword: z.string().max(256) });

/** JSON form of the signed-in user's identity and permissions (used by /api/me). */
export function describeMe(scope, csrfToken) {
  return {
    user: { username: scope.upn, displayName: scope.displayName, authMethod: scope.authMethod },
    mustChangePassword: scope.mustChangePassword,
    roles: rolesOf(scope),
    branches: { keys: branchesFor(scope, 'keys'), logs: branchesFor(scope, 'logs'), reports: branchesFor(scope, 'reports') },
    can: { keys: can(scope, 'keys'), logs: can(scope, 'logs'), reports: can(scope, 'reports'), admin: can(scope, 'admin') },
    csrfToken,
  };
}

/** /api/auth/* (no sign-in needed for login) */
export function authApi({ auth }, { requireUser }) {
  const r = Router();

  r.post('/login', async (req, res) => {
    const { username, password } = parse(loginBody, req.body);
    const user = await auth.login(username, password, clientInfo(req), { localOnly: true });
    if (user.secondFactor) {
      // Not signed in yet: POST /api/auth/2fa with the code (after GET /api/auth/2fa/setup for 'setup').
      await startPendingSecondFactor(req, user);
      return res.json({ secondFactor: user.secondFactor, csrfToken: req.session.csrfToken });
    }
    await startUserSession(req, user, 'password');
    res.json({ user: { username: user.username, displayName: user.displayName }, mustChangePassword: user.mustChangePassword, csrfToken: req.session.csrfToken });
  });

  const pending = (req) => {
    const p = pendingSecondFactor(req);
    if (!p) throw unauthorized('second_factor_expired', 'Sign in again with the password first.');
    return p;
  };

  r.get('/2fa/setup', noStore, async (req, res) => {
    const p = pending(req);
    const { secret, uri } = await auth.beginTotpSetup(p.userId);
    res.json({ secret, otpauthUri: uri });
  });

  r.post('/2fa', noStore, async (req, res) => {
    const p = pending(req);
    const { code } = parse(codeBody, req.body);
    const user = await auth.completeSecondFactor(p.userId, code, clientInfo(req), p.method);
    await startUserSession(req, user, 'password+totp');
    res.json({ user: { username: user.username, displayName: user.displayName }, mustChangePassword: user.mustChangePassword, csrfToken: req.session.csrfToken });
  });

  r.post('/logout', async (req, res) => {
    await endUserSession(req, res);
    res.status(204).end();
  });

  r.post('/change-password', requireUser, async (req, res) => {
    const { currentPassword, newPassword } = parse(changeBody, req.body);
    await auth.changePassword(req.scope, currentPassword, newPassword, clientInfo(req));
    await refreshUserSession(req);
    res.json({ csrfToken: req.session.csrfToken });
  });

  return r;
}

/** /api/me */
export function meApi() {
  const r = Router();
  r.get('/', noStore, (req, res) => res.json(describeMe(req.scope, req.session.csrfToken)));
  return r;
}
