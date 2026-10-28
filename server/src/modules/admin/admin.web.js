import { Router } from 'express';
import { id, parse } from '../../http/validate.js';
import { clientInfo, noStore } from '../../http/security.js';
import { flash, formAction } from '../../web/middleware.js';
import { ROLES } from './admin.service.js';

/** Form fields -> service input (checkbox groups arrive as a string or an array). */
const branchBody = (b) => ({ code: b.code, name: b.name, isActive: b.isActive, ous: b.ous ?? '' });
const userBody = (b) => ({
  username: b.username, displayName: b.displayName, email: b.email, authSource: b.authSource, isActive: b.isActive, grants: b.grants,
  totpRequired: b.totpRequired ?? 'off', mustChangePassword: b.mustChangePassword ?? 'off',
});

/** /admin/branches, /admin/users */
export function adminWeb({ admin }) {
  const r = Router();

  // ---- branches -----------------------------------------------------------------------------

  r.get('/branches', async (req, res) => {
    const { branches, unmapped } = await admin.listBranches(req.scope);
    res.render('admin/branches', { title: req.t('Chi nhánh'), branches, unmapped });
  });

  const renderBranchForm = async (req, res, error, preview = null) => {
    const branchId = req.params.id ? parse(id, req.params.id) : null;
    const branch = req.method === 'GET' && branchId ? await admin.getBranch(req.scope, branchId) : null;
    const form = branch
      ? { code: branch.code, name: branch.name, isActive: branch.is_active, ous: branch.ous.join('\n') }
      : { isActive: true, ous: '', ...req.body, isActive: req.method === 'GET' ? true : req.body.isActive === 'on' };
    res.render('admin/branch-form', { title: branchId ? req.t('Sửa chi nhánh') : req.t('Thêm chi nhánh'), branchId, form, error, preview });
  };

  r.get('/branches/new', (req, res) => renderBranchForm(req, res, null));
  r.get('/branches/:id/edit', (req, res) => renderBranchForm(req, res, null));

  const saveBranch = formAction(async (req, res) => {
    const branchId = req.params.id ? parse(id, req.params.id) : null;
    if (req.body.intent === 'preview') {
      return renderBranchForm(req, res, null, await admin.previewOus(req.scope, req.body.ous ?? ''));
    }
    const saved = await admin.saveBranch(req.scope, branchId, branchBody(req.body), clientInfo(req));
    flash(req, 'success', branchId
      ? req.t('Đã lưu chi nhánh. Đã quét lại theo OU: {moved} máy đổi chi nhánh, chi nhánh hiện có {computers} máy.', { moved: saved.moved, computers: saved.computers })
      : req.t('Đã thêm chi nhánh và quét máy theo OU: gán {computers} máy vào chi nhánh này.', { computers: saved.computers }));
    res.redirect('/admin/branches');
  }, renderBranchForm);
  r.post('/branches', saveBranch);
  r.post('/branches/:id', saveBranch);

  const renderBranchDelete = async (req, res, error) => {
    const branchId = parse(id, req.params.id);
    const { branch, impact } = await admin.branchDeletePreview(req.scope, branchId);
    res.render('admin/branch-delete', { title: req.t('Xóa chi nhánh {code}', { code: branch.code }), branch, impact, error });
  };
  r.get('/branches/:id/delete', (req, res) => renderBranchDelete(req, res, null));
  r.post('/branches/:id/delete', formAction(async (req, res) => {
    const done = await admin.deleteBranch(req.scope, parse(id, req.params.id), { confirmCode: req.body.confirmCode }, clientInfo(req));
    flash(req, 'success', req.t('Đã xóa chi nhánh {code}: {toNa} máy chuyển về N/A{other}; gỡ {grants} quyền người dùng.', { code: done.code, toNa: done.toNa, other: done.toOther ? req.t(', {n} máy thuộc OU của chi nhánh khác nên chuyển sang chi nhánh đó', { n: done.toOther }) : '', grants: done.grants }));
    res.redirect('/admin/branches');
  }, renderBranchDelete));


  // ---- local users ----------------------------------------------------------------------------

  r.get('/users', async (req, res) => {
    res.render('admin/users', { title: req.t('Người dùng'), users: await admin.listUsers(req.scope) });
  });

  const renderUserForm = async (req, res, error) => {
    const userId = req.params.id ? parse(id, req.params.id) : null;
    const { branches } = await admin.listBranches(req.scope);
    let form;
    if (req.method === 'GET' && userId) {
      const u = await admin.getUser(req.scope, userId);
      form = {
        username: u.username,
        displayName: u.display_name,
        email: u.email,
        authSource: u.auth_source,
        adObjectGuid: u.ad_object_guid,
        adLinkedAt: u.ad_linked_at,
        isActive: u.is_active,
        isLocked: u.is_locked,
        totpRequired: u.totp_required,
        totpEnrolledAt: u.totp_enrolled_at,
        mustChangePassword: u.must_change_password,
        isRoot: u.is_root,
        grants: u.grants.map((g) => `${g.role}:${g.branchId ?? 'all'}`),
      };
    } else {
      const grants = req.body?.grants ?? [];
      form = {
        authSource: 'ldap',
        ...req.body,
        isActive: req.method === 'GET' ? true : req.body.isActive === 'on',
        totpRequired: req.method === 'GET' ? false : req.body.totpRequired === 'on',
        mustChangePassword: req.method === 'GET' ? true : req.body.mustChangePassword === 'on',
        grants: Array.isArray(grants) ? grants : [grants],
      };
    }
    res.render('admin/user-form', { title: userId ? req.t('Sửa người dùng') : req.t('Thêm người dùng'), userId, form, branches, roles: ROLES, error });
  };

  r.get('/users/new', (req, res) => renderUserForm(req, res, null));
  r.get('/users/:id/edit', (req, res) => renderUserForm(req, res, null));

  r.post(
    '/users',
    noStore,
    formAction(async (req, res) => {
      const { oneTimePassword } = await admin.createUser(req.scope, userBody(req.body), clientInfo(req));
      if (!oneTimePassword) {
        flash(req, 'success', req.t('Đã tạo {username}. Người dùng đăng nhập bằng tài khoản Windows (AD) của mình.', { username: req.body.username }));
        return res.redirect('/admin/users');
      }
      // Rendered directly (not via flash) so the password is never stored in the session table.
      res.render('admin/password-shown', { title: req.t('Mật khẩu một lần'), username: req.body.username, password: oneTimePassword, created: true });
    }, renderUserForm),
  );

  r.post(
    '/users/:id',
    noStore,
    formAction(async (req, res) => {
      const userId = parse(id, req.params.id);
      const { oneTimePassword } = await admin.updateUser(req.scope, userId, userBody(req.body), clientInfo(req));
      if (oneTimePassword) {
        // Switched to a local password: show it once.
        const u = await admin.getUser(req.scope, userId);
        return res.render('admin/password-shown', { title: req.t('Mật khẩu một lần'), username: u.username, password: oneTimePassword, created: false });
      }
      flash(req, 'success', req.t('Đã lưu người dùng.'));
      res.redirect('/admin/users');
    }, renderUserForm),
  );

  r.post('/users/:id/delete', async (req, res) => {
    const userId = parse(id, req.params.id);
    const u = await admin.getUser(req.scope, userId);
    await admin.deleteUser(req.scope, userId, clientInfo(req));
    flash(req, 'success', req.t('Đã xóa người dùng {username}.', { username: u.username }));
    res.redirect('/admin/users');
  });

  r.post('/users/:id/unlink-ad', async (req, res) => {
    await admin.unlinkAd(req.scope, parse(id, req.params.id), clientInfo(req));
    flash(req, 'success', req.t('Đã gỡ liên kết tài khoản AD. Lần đăng nhập tới sẽ liên kết lại.'));
    res.redirect(`/admin/users/${req.params.id}/edit`);
  });

  r.post('/users/:id/reset-password', noStore, async (req, res) => {
    const userId = parse(id, req.params.id);
    const u = await admin.getUser(req.scope, userId);
    const { oneTimePassword } = await admin.resetPassword(req.scope, userId, clientInfo(req));
    res.render('admin/password-shown', { title: req.t('Mật khẩu một lần'), username: u.username, password: oneTimePassword, created: false });
  });

  r.post('/users/:id/reset-2fa', async (req, res) => {
    await admin.resetTwoFactor(req.scope, parse(id, req.params.id), clientInfo(req));
    flash(req, 'success', req.t('Đã đặt lại xác thực 2 bước. Lần đăng nhập tới, người dùng quét mã QR mới.'));
    res.redirect(`/admin/users/${req.params.id}/edit`);
  });

  r.post('/users/:id/unlock', async (req, res) => {
    await admin.unlockUser(req.scope, parse(id, req.params.id), clientInfo(req));
    flash(req, 'success', req.t('Đã mở khóa tài khoản.'));
    res.redirect(`/admin/users/${req.params.id}/edit`);
  });

  return r;
}
