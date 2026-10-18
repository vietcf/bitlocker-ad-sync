import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { loadConfig, ldapIsPlain } from './config.js';
import { createLogger } from './logger.js';
import { APP_VERSION } from './version.js';
import { createPool } from './db/pool.js';
import { createServices } from './services.js';
import { createUserApp } from './app.js';
import { createIngestApp } from './ingest/ingest.app.js';
import { DEFAULT_ADMIN, ensureDefaultAdmin } from './modules/auth/users.repo.js';
import { Scheduler } from './jobs/scheduler.js';
import { JOB_SCHEDULE, jobMinutes, jobTime } from './jobs/job-schedule.js';
import { runChainCheck, runSyncWatchdog } from './jobs/watchdog.js';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const pool = createPool(config);
const hmacKey = Buffer.from(config.LOG_HMAC_KEY, 'hex');
const services = createServices({ config, pool, logger, hmacKey });

// After a reboot the database may still be starting: wait for it (up to 2 minutes) instead of exiting.
for (let attempt = 1; ; attempt++) {
  try {
    await pool.query('SELECT 1');
    break;
  } catch (err) {
    if (attempt >= 60) throw err;
    logger.warn({ attempt, code: err.code, message: err.message }, 'database not ready, retrying in 2 s');
    await new Promise((r) => setTimeout(r, 2000));
  }
}

if (await ensureDefaultAdmin(pool)) {
  logger.warn({ username: DEFAULT_ADMIN.username }, 'No users existed: created the default admin account. Its password must be changed at first sign-in.');
}

if (ldapIsPlain(config)) {
  logger.warn({ servers: config.LDAP_SERVERS }, 'LDAP sign-in without TLS: AD passwords travel unencrypted. Set LDAP_PROTOCOL=ldaps or starttls when the DCs have a certificate.');
}

// User-facing pages + API (plain HTTP behind the TLS-terminating reverse proxy).
const userServer = createUserApp({ config, pool, logger, services }).listen(config.USER_PORT, config.USER_HOST, () => {
  logger.info(
    { version: APP_VERSION, host: config.USER_HOST, port: config.USER_PORT, ldap: config.LDAP_SERVERS.length ? { servers: config.LDAP_SERVERS, protocol: config.LDAP_PROTOCOL } : 'off', localLogin: config.LOCAL_LOGIN_ENABLED },
    'user app listening',
  );
});

// Ingest API for the worker: HTTPS here (INGEST_TLS_CERT / KEY), or plain HTTP behind an HTTPS
// reverse proxy (INGEST_TRUST_PROXY, e.g. the nginx container).
const ingestApp = createIngestApp({ config, logger, services });
const tls = config.INGEST_TLS_CERT && config.INGEST_TLS_KEY;
const ingestServer = tls
  ? https.createServer(
      {
        cert: readFileSync(config.INGEST_TLS_CERT),
        key: readFileSync(config.INGEST_TLS_KEY),
        minVersion: 'TLSv1.2',
      },
      ingestApp,
    )
  : http.createServer(ingestApp);
ingestServer.listen(config.INGEST_PORT, config.INGEST_HOST, () => {
  logger.info(
    { host: config.INGEST_HOST, port: config.INGEST_PORT, tls: !!tls, behindProxy: !!config.INGEST_TRUST_PROXY },
    'ingest API listening',
  );
  if (!tls && !config.INGEST_TRUST_PROXY) logger.warn('ingest API is plain HTTP and not behind an HTTPS proxy: development only');
});

// Background jobs.
const scheduler = new Scheduler({ pool, logger, tz: config.APP_TZ });
if (config.JOBS_ENABLED) {
  const { settings } = services;
  scheduler.every('sync-watchdog', () => jobMinutes(settings, JOB_SCHEDULE.watchdogIntervalMinutes),
    () => runSyncWatchdog({ pool, alerts: services.alerts, settings }));
  scheduler.daily('audit-chain-check', () => jobTime(settings, JOB_SCHEDULE.chainCheckTime), () => runChainCheck(services));
  // Mail outbox: send what is due every minute.
  scheduler.every('mail-outbox', () => jobMinutes(settings, JOB_SCHEDULE.mailIntervalMinutes), () => services.mail.processOutbox(), 10_000);
  // Daily report for Admin HQ: checks every minute, sends once a day at the configured time.
  scheduler.every('daily-report', 1, () => services.dailyReport.tick(), 20_000);
  // Backups (Quan tri > Sao luu): checks every minute, runs once a day at the configured time.
  scheduler.every('backup', 1, () => services.backup.tick(), 25_000);
  // Delete old mail, sync history and (if configured) access log rows (Quan tri > Luu tru).
  scheduler.daily('data-retention', () => jobTime(settings, JOB_SCHEDULE.retentionTime), () => services.retention.run());
}

function shutdown(signal) {
  logger.info({ signal }, 'shutting down');
  scheduler.stop();
  let open = 2;
  const done = () => --open === 0 && pool.end().finally(() => process.exit(0));
  userServer.close(done);
  ingestServer.close(done);
  // Do not hang forever on open keep-alive connections.
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
