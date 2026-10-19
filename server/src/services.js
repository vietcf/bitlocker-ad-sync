import { AuditService } from './modules/audit/audit.service.js';
import { AuthService } from './modules/auth/auth.service.js';
import { LdapAuthenticator } from './modules/auth/ldap.client.js';
import { ldapEnabled } from './config.js';
import { ComputersService } from './modules/computers/computers.service.js';
import { KeysService } from './modules/keys/keys.service.js';
import { ReportsService } from './modules/reports/reports.service.js';
import { DailyReportService } from './modules/reports/daily-report.js';
import { BackupService } from './modules/backup/backup.service.js';
import { AdminService } from './modules/admin/admin.service.js';
import { SettingsService } from './modules/settings/settings.service.js';
import { Notifier } from './modules/alerts/notifier.js';
import { EventLog } from './modules/audit/event-log.js';
import { AlertsService } from './modules/alerts/alerts.service.js';
import { IngestService } from './modules/sync/ingest.service.js';
import { SyncAdminService } from './modules/sync/sync-admin.service.js';
import { DashboardService } from './modules/dashboard/dashboard.service.js';
import { MailService } from './modules/mail/mail.service.js';
import { adminEmails, adminsWithoutEmail } from './modules/mail/mail.repo.js';
import { NewObjectsNotifier } from './modules/mail/new-objects.js';
import { secretKey as deriveSecretKey } from './modules/mail/secret.js';
import { DEFAULT_TEMPLATES_FILE, MailTemplates } from './modules/mail/templates.js';
import { SettingsAdminService } from './modules/settings/settings-admin.service.js';
import { RetentionService } from './modules/settings/retention.service.js';

/**
 * Builds every service once. Web routes, API routes, the ingest app, jobs and the CLI all
 * use these same instances: the business rules live here and nowhere else.
 */
export function createServices({ config, pool, logger, secret, notifier, ldap, mailTransport, eventWrite = null }) {
  // Event lines on stdout (audit, mail, sync_run, alert), in the background. Not in tests (they would flood the output).
  const eventLog = new EventLog({ write: eventWrite, enabled: config.NODE_ENV !== 'test' });
  const settings = new SettingsService(pool);
  const audit = new AuditService({ pool, settings, eventLog, tz: config.APP_TZ });
  const secretKey = deriveSecretKey(secret);
  // Text of every mail: templates/mail-templates.yaml (or MAIL_TEMPLATES_FILE). Throws if it is broken.
  const templates = new MailTemplates({ file: config.MAIL_TEMPLATES_FILE ?? DEFAULT_TEMPLATES_FILE, logger });
  // Every e-mail goes through the outbox (mail_outbox); the mail-outbox job sends it.
  const mail = new MailService({ pool, settings, config, logger, secretKey, templates, createTransport: mailTransport, eventLog });
  const retention = new RetentionService({ pool, settings, mail, audit });
  notifier ??= new Notifier({ config, logger, mail, settings, adminEmails: () => adminEmails(pool), adminsWithoutEmail: () => adminsWithoutEmail(pool) });
  const alerts = new AlertsService({ pool, notifier, templates, eventLog });
  // Tests pass their own directory stand-in; otherwise a real LDAP client when LDAP_SERVERS is set.
  ldap ??= ldapEnabled(config)
    ? new LdapAuthenticator({
        servers: config.LDAP_SERVERS,
        protocol: config.LDAP_PROTOCOL,
        domain: config.LDAP_DOMAIN,
        baseDn: config.LDAP_BASE_DN,
        caFile: config.LDAP_CA_FILE,
        timeoutMs: config.LDAP_TIMEOUT_MS,
      })
    : null;
  const dailyReport = new DailyReportService({ pool, settings, mail, templates, tz: config.APP_TZ });
  const backup = new BackupService({ pool, settings, audit, alerts, config, secretKey, tz: config.APP_TZ, logger });
  return {
    eventLog,
    backup,
    templates,
    settings,
    audit,
    mail,
    notifier,
    alerts,
    auth: new AuthService({
      pool,
      logger,
      audit,
      ldap,
      secretKey,
      settings,
      options: { domain: config.LDAP_DOMAIN ?? null, localLoginEnabled: config.LOCAL_LOGIN_ENABLED },
    }),
    computers: new ComputersService({ pool, audit, settings }),
    keys: new KeysService({ pool, audit, settings, notifier, templates }),
    reports: new ReportsService({ pool, audit, settings, tz: config.APP_TZ }),
    dailyReport,
    admin: new AdminService({ pool, audit, settings }),
    ingest: new IngestService({ pool, audit, alerts, settings, logger, eventLog, newObjects: new NewObjectsNotifier({ pool, settings, mail, templates }) }),
    syncAdmin: new SyncAdminService({ pool, audit, alerts, settings, logger, eventLog }),
    retention,
    settingsAdmin: new SettingsAdminService({
      pool, settings, audit, mail, secretKey, retention, dailyReport,
      sessionDefaults: { idleMinutes: config.SESSION_IDLE_MINUTES, maxHours: config.SESSION_MAX_HOURS },
    }),
    dashboard: new DashboardService({ pool, alerts, settings, tz: config.APP_TZ }),
  };
}
