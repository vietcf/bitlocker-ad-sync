import express, { Router } from 'express';
import { verifyCsrf } from '../http/csrf.js';
import { rejectNul } from '../http/validate.js';
import { loadUser, requireCapability, requireUser } from '../modules/auth/auth.middleware.js';
import { authWeb } from '../modules/auth/auth.web.js';
import { backupWeb } from '../modules/backup/backup.web.js';
import { computersWeb } from '../modules/computers/computers.web.js';
import { auditWeb } from '../modules/audit/audit.web.js';
import { reportsWeb } from '../modules/reports/reports.web.js';
import { adminWeb } from '../modules/admin/admin.web.js';
import { syncWeb } from '../modules/sync/sync.web.js';
import { dashboardWeb } from '../modules/dashboard/dashboard.web.js';
import { settingsWeb } from '../modules/settings/settings.web.js';
import { templateLocals, webErrorHandler } from './middleware.js';

/** Server-rendered pages (EJS). Same services as the API; forms carry a CSRF token. */
export function createWebRouter({ services, config, sessions }) {
  const web = Router();
  web.use(sessions, express.urlencoded({ extended: false, limit: '100kb' }), rejectNul);
  web.use(loadUser({ auth: services.auth, config, settings: services.settings }));
  web.use(templateLocals);
  // Feature switches (Quan tri > Tinh nang) for templates: show or hide buttons.
  web.use(async (req, res, next) => {
    res.locals.features = await services.settings.features();
    next();
  });
  web.use(verifyCsrf);

  const signedIn = requireUser({ allowWhilePasswordChange: ['/change-password', '/logout'] });

  web.use('/', authWeb(services, { requireUser: signedIn }));
  web.use(signedIn);
  web.use('/dashboard', dashboardWeb(services));
  web.use('/audit', requireCapability('logs'), auditWeb(services));
  web.use('/reports', requireCapability('reports'), reportsWeb(services));
  web.use('/admin/sync', requireCapability('admin'), syncWeb(services));
  web.get('/admin', requireCapability('admin'), (req, res) => res.redirect('/admin/branches'));
  web.use('/admin', requireCapability('admin'), settingsWeb(services));
  web.use('/admin/backup', requireCapability('admin'), backupWeb(services));
  web.use('/admin', requireCapability('admin'), adminWeb(services));
  // Home is the search page for IT; other roles land on what they can use.
  web.get('/', (req, res, next) => {
    if (res.locals.can('keys')) return next();
    return res.redirect('/dashboard');
  });
  web.use('/computers', requireCapability('keys'));
  web.use('/', computersWeb(services));

  web.use((req, res) => res.status(404).render('error', { title: 'Không tìm thấy', status: 404, message: 'Không tìm thấy trang.', requestId: null }));
  web.use(webErrorHandler);
  return web;
}
