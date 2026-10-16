import { Router } from 'express';
import { clientInfo, noStore } from '../../http/security.js';
import { flash, formAction } from '../../web/middleware.js';

/** /admin/backup: options, password, run now, list and download the files (Admin HQ). */
export function backupWeb({ backup }) {
  const r = Router();

  const render = async (req, res, error) => {
    const s = await backup.status(req.scope);
    const form = error && req.body?.time
      ? { ...s.options, ...req.body, enabled: req.body.enabled === 'on', keys: req.body.keys === 'on', database: req.body.database === 'on', encrypt: req.body.encrypt === 'on' }
      : s.options;
    res.render('admin/backup', { title: 'Sao lưu', s, form, error });
  };

  r.get('/', noStore, (req, res) => render(req, res, null));

  r.post('/options', formAction(async (req, res) => {
    await backup.saveOptions(req.scope, req.body, clientInfo(req));
    flash(req, 'success', 'Đã lưu cấu hình sao lưu.');
    res.redirect('/admin/backup');
  }, render));

  r.post('/password', noStore, formAction(async (req, res) => {
    await backup.setPassword(req.scope, req.body, clientInfo(req));
    flash(req, 'success', 'Đã lưu mật khẩu sao lưu. Lưu mật khẩu này ở kho mật khẩu: mất mật khẩu thì không mở được file sao lưu.');
    res.redirect('/admin/backup');
  }, render));

  r.post('/run', async (req, res) => {
    const result = await backup.runNow(req.scope, clientInfo(req));
    flash(req, result.ok ? 'success' : 'error', result.ok
      ? `Đã sao lưu: ${result.files.map((f) => f.name).join(', ')}.`
      : `Sao lưu lỗi: ${result.errors.map((e) => e.error).join(' ')}`);
    res.redirect('/admin/backup');
  });

  r.get('/files/:name', noStore, async (req, res) => {
    const file = await backup.fileForDownload(req.scope, req.params.name, clientInfo(req));
    res.download(file, req.params.name);
  });

  return r;
}
