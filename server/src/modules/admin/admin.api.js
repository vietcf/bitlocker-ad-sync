import { Router } from 'express';
import { id, parse } from '../../http/validate.js';
import { clientInfo } from '../../http/security.js';

/** /api/admin/* — Admin HQ only (each service method checks the capability too). */
export function adminApi({ admin, syncAdmin, settingsAdmin }) {
  const r = Router();

  // Branches and root OUs
  r.get('/branches', async (req, res) => res.json(await admin.listBranches(req.scope)));
  r.get('/branches/:id', async (req, res) => res.json(await admin.getBranch(req.scope, parse(id, req.params.id))));
  r.post('/branches', async (req, res) => res.status(201).json(await admin.saveBranch(req.scope, null, req.body, clientInfo(req))));
  r.put('/branches/:id', async (req, res) =>
    res.json(await admin.saveBranch(req.scope, parse(id, req.params.id), req.body, clientInfo(req))),
  );
  r.get('/branches/:id/delete-preview', async (req, res) => res.json(await admin.branchDeletePreview(req.scope, parse(id, req.params.id))));
  r.delete('/branches/:id', async (req, res) => res.json(await admin.deleteBranch(req.scope, parse(id, req.params.id), req.body, clientInfo(req))));
  r.post('/branches/preview', async (req, res) => res.json({ matches: await admin.previewOus(req.scope, req.body?.ous) }));

  // Users (sign in with their AD password or a local password; roles always set here)
  r.get('/users', async (req, res) => res.json({ items: await admin.listUsers(req.scope) }));
  r.get('/users/:id', async (req, res) => res.json(await admin.getUser(req.scope, parse(id, req.params.id))));
  r.post('/users', async (req, res) => res.status(201).json(await admin.createUser(req.scope, req.body, clientInfo(req))));
  // Returns { oneTimePassword } when the user was switched to a local password, else {}.
  r.put('/users/:id', async (req, res) => res.json(await admin.updateUser(req.scope, parse(id, req.params.id), req.body, clientInfo(req))));
  r.post('/users/:id/reset-password', async (req, res) =>
    res.json(await admin.resetPassword(req.scope, parse(id, req.params.id), clientInfo(req))),
  );
  r.delete('/users/:id', async (req, res) => {
    await admin.deleteUser(req.scope, parse(id, req.params.id), clientInfo(req));
    res.status(204).end();
  });
  r.post('/users/:id/unlink-ad', async (req, res) => {
    await admin.unlinkAd(req.scope, parse(id, req.params.id), clientInfo(req));
    res.status(204).end();
  });
  r.post('/users/:id/reset-2fa', async (req, res) => {
    await admin.resetTwoFactor(req.scope, parse(id, req.params.id), clientInfo(req));
    res.status(204).end();
  });
  r.post('/users/:id/unlock', async (req, res) => {
    await admin.unlockUser(req.scope, parse(id, req.params.id), clientInfo(req));
    res.status(204).end();
  });

  // Sync
  r.get('/sync', async (req, res) => res.json(await syncAdmin.status(req.scope)));
  r.get('/sync-runs', async (req, res) => res.json({ items: (await syncAdmin.status(req.scope)).runs }));
  r.post('/sync-runs', async (req, res) => res.status(202).json(await syncAdmin.requestSync(req.scope, req.body, clientInfo(req))));
  r.get('/sync-runs/:id', async (req, res) => res.json(await syncAdmin.runPreview(req.scope, parse(id, req.params.id))));
  r.post('/sync-runs/:id/ack', async (req, res) =>
    res.json(await syncAdmin.ack(req.scope, parse(id, req.params.id), req.body, clientInfo(req))),
  );

  // Settings: mail server (the password is write-only), notifications, features, mail log
  r.get('/settings', async (req, res) =>
    res.json({
      mailServer: await settingsAdmin.smtp(req.scope),
      notifications: await settingsAdmin.notifications(req.scope),
      features: await settingsAdmin.features(req.scope),
    }),
  );
  r.put('/settings/mail-server', async (req, res) => {
    await settingsAdmin.saveSmtp(req.scope, req.body, clientInfo(req));
    res.json(await settingsAdmin.smtp(req.scope));
  });
  r.post('/settings/mail-server/test', async (req, res) => res.json(await settingsAdmin.testSmtp(req.scope, req.body, clientInfo(req))));
  r.put('/settings/notifications', async (req, res) => {
    await settingsAdmin.saveNotifications(req.scope, req.body, clientInfo(req));
    res.json(await settingsAdmin.notifications(req.scope));
  });
  r.put('/settings/features', async (req, res) => {
    await settingsAdmin.saveFeatures(req.scope, req.body, clientInfo(req));
    res.json(await settingsAdmin.features(req.scope));
  });
  r.get('/settings/thresholds', async (req, res) => res.json({ items: await settingsAdmin.thresholds(req.scope), alerts: await settingsAdmin.alertSwitches(req.scope), checks: await settingsAdmin.checkSwitches(req.scope) }));
  r.put('/settings/thresholds', async (req, res) => {
    await settingsAdmin.saveThresholds(req.scope, req.body, clientInfo(req));
    res.json({ items: await settingsAdmin.thresholds(req.scope), alerts: await settingsAdmin.alertSwitches(req.scope), checks: await settingsAdmin.checkSwitches(req.scope) });
  });
  r.get('/settings/retention', async (req, res) => res.json(await settingsAdmin.retentionSettings(req.scope)));
  r.put('/settings/retention', async (req, res) => {
    await settingsAdmin.saveRetention(req.scope, req.body, clientInfo(req));
    res.json(await settingsAdmin.retentionSettings(req.scope));
  });
  r.post('/settings/retention/run', async (req, res) => res.json(await settingsAdmin.runRetention(req.scope, clientInfo(req))));
  r.get('/mail', async (req, res) => res.json(await settingsAdmin.mailLog(req.scope, req.query)));
  r.get('/mail/:id', async (req, res) => res.json(await settingsAdmin.mailDetail(req.scope, req.params.id)));
  r.post('/mail/:id/retry', async (req, res) => {
    await settingsAdmin.retryMail(req.scope, req.params.id, clientInfo(req));
    res.status(204).end();
  });

  return r;
}
