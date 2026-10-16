import { Router } from 'express';
import { z } from 'zod';
import { badRequest } from '../../http/errors.js';
import { parse } from '../../http/validate.js';
import { clientInfo, noStore } from '../../http/security.js';
import { flash, formAction } from '../../web/middleware.js';
import { describePasswordPolicy } from './password.js';
import { endUserSession, pendingSecondFactor, refreshUserSession, startPendingSecondFactor, startUserSession } from './session.js';

const loginForm = z.object({
  username: z.string().trim().min(1, 'Nhập tên đăng nhập').max(256),
  password: z.string().min(1, 'Nhập mật khẩu').max(256),
  next: z.string().max(512).optional(),
});
const codeForm = z.object({ code: z.string().trim().max(16) });
const changeForm = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().max(256),
  confirm: z.string().max(256),
});

/** Only same-site relative paths are followed after sign-in (no open redirect). */
const safeNext = (n) => (typeof n === 'string' && /^\/(?!\/)[^\\]*$/.test(n) ? n : '/');

/** /login, /logout, /change-password */
export function authWeb({ auth }, { requireUser }) {
  const r = Router();

  const renderLogin = (req, res, error) =>
    res.render('auth/login', {
      title: 'Đăng nhập',
      error,
      username: req.body?.username ?? '',
      next: req.body?.next ?? req.query.next ?? '',
      ldapEnabled: auth.ldapEnabled,
      expired: req.query.expired === '1' || req.sessionExpired === true,
    });

  r.get('/login', noStore, (req, res) => (req.scope ? res.redirect('/') : renderLogin(req, res, null)));

  r.post(
    '/login',
    noStore,
    formAction(async (req, res) => {
      const form = parse(loginForm, req.body);
      const user = await auth.login(form.username, form.password, clientInfo(req));
      if (user.secondFactor) {
        await startPendingSecondFactor(req, user, safeNext(form.next));
        return res.redirect('/login/2fa');
      }
      await startUserSession(req, user, 'password');
      res.redirect(user.mustChangePassword ? '/change-password' : safeNext(form.next));
    }, renderLogin, [400, 401, 403, 423, 503]), // wrong password, locked, AD down: back to the form
  );

  // ---- two-step sign-in: the code, or the first setup of the authenticator app ----
  const renderSecondFactor = async (req, res, error) => {
    const p = pendingSecondFactor(req);
    if (!p) return res.redirect('/login?expired=1');
    const setup = p.mode === 'setup' ? await auth.beginTotpSetup(p.userId) : null;
    res.render('auth/two-factor', {
      title: setup ? 'Thiết lập xác thực 2 bước' : 'Xác thực 2 bước',
      error,
      username: p.username,
      setup: setup ? { qrSvg: setup.qrSvg, secret: setup.secret.match(/.{1,4}/g).join(' ') } : null,
    });
  };
  r.get('/login/2fa', noStore, (req, res) => renderSecondFactor(req, res, null));
  r.post(
    '/login/2fa',
    noStore,
    formAction(async (req, res) => {
      const p = pendingSecondFactor(req);
      if (!p) return res.redirect('/login?expired=1');
      const { code } = parse(codeForm, req.body);
      try {
        const user = await auth.completeSecondFactor(p.userId, code, clientInfo(req), p.method);
        await startUserSession(req, user, 'password+totp');
        if (p.mode === 'setup') flash(req, 'success', 'Đã thiết lập xác thực 2 bước. Từ nay mỗi lần đăng nhập cần mã trong app Authenticator.');
        res.redirect(user.mustChangePassword ? '/change-password' : p.next);
      } catch (err) {
        // Locked after too many wrong codes: back to the password form.
        if (err.status === 423) {
          await endUserSession(req, res);
          return renderLogin(req, res, err);
        }
        throw err;
      }
    }, renderSecondFactor, [400, 401, 403]),
  );

  r.post('/logout', async (req, res) => {
    await endUserSession(req, res);
    res.redirect('/login');
  });

  const renderChange = async (req, res, error) => {
    const policy = await auth.passwordPolicy();
    res.render('auth/change-password', { title: 'Đổi mật khẩu', error, policy, policyText: describePasswordPolicy(policy) });
  };

  r.get('/change-password', requireUser, noStore, async (req, res) => {
    if (req.scope.authSource !== 'local') {
      flash(req, 'info', 'Tài khoản AD đổi mật khẩu trên Windows (Ctrl+Alt+Del → Change a password).');
      return res.redirect('/');
    }
    await renderChange(req, res, null);
  });

  r.post(
    '/change-password',
    requireUser,
    noStore,
    formAction(async (req, res) => {
      const form = parse(changeForm, req.body);
      if (form.newPassword !== form.confirm) throw badRequest('mismatch', 'Hai lần nhập mật khẩu mới không khớp.');
      await auth.changePassword(req.scope, form.currentPassword, form.newPassword, clientInfo(req));
      await refreshUserSession(req);
      flash(req, 'success', 'Đã đổi mật khẩu.');
      res.redirect('/');
    }, renderChange),
  );

  return r;
}
