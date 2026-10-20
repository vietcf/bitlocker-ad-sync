import { Router } from 'express';
import { clientInfo } from '../../http/security.js';
import { flash, formAction } from '../../web/middleware.js';
import { PAGE_SIZES, PAGE_SIZE_LIMITS } from './page-size.js';

/**
 * Quan tri pages for settings: /admin/settings/mail-server, /notifications, /features,
 * and the mail log /admin/mail. (Branches, users and sync have their own routers.)
 */
export function settingsWeb({ settingsAdmin }) {
  const r = Router();

  // ---- mail server --------------------------------------------------------------------
  const renderSmtp = async (req, res, error) => {
    const saved = await settingsAdmin.smtp(req.scope);
    const form = req.method === 'POST' && error ? { ...saved, ...req.body, enabled: req.body.enabled === 'on', rejectUnauthorized: req.body.rejectUnauthorized === 'on' } : saved;
    res.render('admin/settings-mail-server', { title: 'Mail server', form, passwordSet: saved.passwordSet, error });
  };
  r.get('/settings/mail-server', (req, res) => renderSmtp(req, res, null));
  r.post('/settings/mail-server', formAction(async (req, res) => {
    await settingsAdmin.saveSmtp(req.scope, { ...req.body, rejectUnauthorized: req.body.rejectUnauthorized ?? 'off' }, clientInfo(req));
    flash(req, 'success', 'Đã lưu cấu hình mail server.');
    res.redirect('/admin/settings/mail-server');
  }, renderSmtp));
  r.post('/settings/mail-server/test', formAction(async (req, res) => {
    const result = await settingsAdmin.testSmtp(req.scope, req.body, clientInfo(req));
    flash(req, result.ok ? 'success' : 'error',
      result.ok ? `Đã gửi email thử tới ${req.body.to}. Kiểm tra hộp thư.` : `Gửi thử thất bại: ${result.error}`);
    res.redirect('/admin/settings/mail-server');
  }, renderSmtp));

  // ---- notifications ------------------------------------------------------------------
  const renderNotify = async (req, res, error) => {
    const n = await settingsAdmin.notifications(req.scope);
    res.render('admin/settings-notifications', { title: 'Thông báo', n, error });
  };
  r.get('/settings/notifications', (req, res) => renderNotify(req, res, null));
  r.post('/settings/notifications', formAction(async (req, res) => {
    await settingsAdmin.saveNotifications(req.scope, req.body, clientInfo(req));
    flash(req, 'success', 'Đã lưu cấu hình thông báo.');
    res.redirect('/admin/settings/notifications');
  }, renderNotify));

  // ---- features -----------------------------------------------------------------------
  const renderFeatures = async (req, res, error) => {
    res.render('admin/settings-features', { title: 'Tính năng', pageSizes: PAGE_SIZES, pageSizeLimits: PAGE_SIZE_LIMITS, values: await settingsAdmin.features(req.scope), error });
  };
  r.get('/settings/features', (req, res) => renderFeatures(req, res, null));
  r.post('/settings/features', formAction(async (req, res) => {
    await settingsAdmin.saveFeatures(req.scope, req.body, clientInfo(req));
    flash(req, 'success', 'Đã lưu. Thay đổi có hiệu lực trong vòng 30 giây.');
    res.redirect('/admin/settings/features');
  }, renderFeatures));

  // ---- thresholds ---------------------------------------------------------------------
  const renderThresholds = async (req, res, error) => {
    const list = await settingsAdmin.thresholds(req.scope);
    const values = error ? { ...Object.fromEntries(list.map((t) => [t.key, t.value])), ...req.body } : Object.fromEntries(list.map((t) => [t.key, t.value]));
    const alerts = await settingsAdmin.alertSwitches(req.scope);
    res.render('admin/settings-thresholds', { title: 'Cảnh báo sync', list, alerts, values, error });
  };
  r.get('/settings/thresholds', (req, res) => renderThresholds(req, res, null));
  r.post('/settings/thresholds', formAction(async (req, res) => {
    await settingsAdmin.saveThresholds(req.scope, req.body, clientInfo(req));
    flash(req, 'success', 'Đã lưu cấu hình cảnh báo sync. Thay đổi có hiệu lực trong vòng 30 giây (lượt sync / lần watchdog kế tiếp).');
    res.redirect('/admin/settings/thresholds');
  }, renderThresholds));

  // ---- security (session limits) --------------------------------------------------------
  const renderSecurity = async (req, res, error) => {
    const saved = await settingsAdmin.security(req.scope);
    const b = req.body ?? {};
    const form = error
      ? { ...saved, ...b, lockout: { enabled: b.lockEnabled === 'on', maxAttempts: b.lockAttempts, lockMinutes: b.lockMinutes, applyToAdmin: b.lockAdmin === 'on' }, password: { minLength: b.pwMinLength, upper: b.pwUpper === 'on', lower: b.pwLower === 'on', digit: b.pwDigit === 'on', special: b.pwSpecial === 'on' } }
      : saved;
    res.render('admin/settings-security', { title: 'Bảo mật', form, error });
  };
  r.get('/settings/security', (req, res) => renderSecurity(req, res, null));
  r.post('/settings/security', formAction(async (req, res) => {
    await settingsAdmin.saveSecurity(req.scope, req.body, clientInfo(req));
    flash(req, 'success', 'Đã lưu. Áp dụng cho mọi phiên đăng nhập trong vòng 30 giây.');
    res.redirect('/admin/settings/security');
  }, renderSecurity));

  // ---- retention ----------------------------------------------------------------------
  const renderRetention = async (req, res, error) => {
    const saved = await settingsAdmin.retentionSettings(req.scope);
    const form = error
      ? { ...saved, ...req.body, keepAccessLog: req.body.keepAccessLog === 'on' }
      : { ...saved, keepAccessLog: saved.accessLogDays === null };
    res.render('admin/settings-retention', { title: 'Lưu trữ', form, lastPurge: saved.lastPurge, error });
  };
  r.get('/settings/retention', (req, res) => renderRetention(req, res, null));
  r.post('/settings/retention', formAction(async (req, res) => {
    await settingsAdmin.saveRetention(req.scope, req.body, clientInfo(req));
    flash(req, 'success', 'Đã lưu thời gian lưu trữ. Job dọn dẹp chạy lúc 03:00 hằng ngày.');
    res.redirect('/admin/settings/retention');
  }, renderRetention));
  r.post('/settings/retention/run', async (req, res) => {
    const done = await settingsAdmin.runRetention(req.scope, clientInfo(req));
    flash(req, 'success', `Đã dọn dẹp: ${done.mail} email, ${done.syncRuns} lượt sync, ${done.alerts} cảnh báo đã đóng, ${done.accessLog} dòng nhật ký.`);
    res.redirect('/admin/settings/retention');
  });

  r.post('/settings/notifications/daily-report/send', async (req, res) => {
    const r2 = await settingsAdmin.sendDailyReportNow(req.scope, clientInfo(req));
    flash(req, r2.queued ? 'success' : 'error', r2.queued
      ? `Đã đưa báo cáo hằng ngày vào hàng đợi gửi (${r2.recipients} người nhận). Xem ở Log email.`
      : 'Không có người nhận: chưa Admin HQ nào có email và chưa nhập địa chỉ thêm. Báo cáo vẫn được lưu ở Log email.');
    res.redirect(`/admin/mail/${r2.id}`);
  });

  // ---- mail log -----------------------------------------------------------------------
  const renderMailLog = async (req, res, error) => {
    const log = await settingsAdmin.mailLog(req.scope, req.query);
    res.render('admin/mail-log', { title: 'Log email', log, query: req.query, error });
  };
  r.get('/mail', (req, res) => renderMailLog(req, res, null));
  r.get('/mail/:id', async (req, res) => {
    res.render('admin/mail-show', { title: 'Chi tiết email', m: await settingsAdmin.mailDetail(req.scope, req.params.id) });
  });
  // HTML version of a mail (daily report), shown sandboxed: no script, no same-origin access.
  r.get('/mail/:id/html', async (req, res) => {
    const m = await settingsAdmin.mailDetail(req.scope, req.params.id);
    if (!m.html) return res.status(404).send('This mail has no HTML version.');
    res.set('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    res.set('Cache-Control', 'no-store');
    res.type('html').send(m.html);
  });
  r.post('/mail/:id/retry', async (req, res) => {
    await settingsAdmin.retryMail(req.scope, req.params.id, clientInfo(req));
    flash(req, 'success', 'Đã đưa mail vào hàng đợi gửi lại.');
    res.redirect(`/admin/mail/${req.params.id}`);
  });

  return r;
}
