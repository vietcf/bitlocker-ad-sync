import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const csv = z
  .string()
  .default('')
  .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean));

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    // User-facing listener. Plain HTTP: the reverse proxy terminates TLS (design: "Reverse proxy / LB").
    USER_PORT: z.coerce.number().int().default(3000),
    USER_HOST: z.string().default('127.0.0.1'),
    TRUST_PROXY: z.string().default('loopback'),

    // Ingest listener for the sync worker. HTTPS either here (INGEST_TLS_CERT / KEY) or at a reverse
    // proxy in front (nginx); the worker is checked by its IP address and the API key.
    INGEST_PORT: z.coerce.number().int().default(8443),
    INGEST_HOST: z.string().default('0.0.0.0'),
    INGEST_TLS_CERT: z.string().optional(),
    INGEST_TLS_KEY: z.string().optional(),
    INGEST_ALLOWED_IPS: csv,
    // Set when a reverse proxy terminates TLS for the ingest API: which hop is trusted to forward the
    // worker's address (X-Forwarded-For, checked against INGEST_ALLOWED_IPS). "1" = the proxy right in
    // front (recommended: the proxy overwrites the header, so a client cannot fake its address).
    INGEST_TRUST_PROXY: z.string().optional(),
    // Shared secret of the worker (Authorization: Bearer ...). 32+ characters.
    INGEST_API_KEY: z.string().min(32).optional(),

    DATABASE_URL: z.string().min(1),
    MIGRATION_DATABASE_URL: z.string().optional(),
    DB_SSL: bool.default(false),
    DB_POOL_MAX: z.coerce.number().int().default(10),

    // Sign-in with the AD password (authentication only; roles are managed in this app).
    // LDAP_SERVERS: one or more DCs (host or host:port), comma-separated, tried in order.
    LDAP_SERVERS: csv,
    // ldap = port 389 without encryption (default); starttls = port 389 upgraded to TLS; ldaps = port 636 with TLS.
    LDAP_PROTOCOL: z.enum(['ldap', 'ldaps', 'starttls']).default('ldap'),
    // AD DNS domain: users bind as <sAMAccountName>@<LDAP_DOMAIN>.
    LDAP_DOMAIN: z.string().optional(),
    // Where to look up the signed-in user's own entry (objectGUID): DC=corp,DC=local
    LDAP_BASE_DN: z.string().optional(),
    // CA certificate (PEM) that signed the DCs' LDAPS certificates, if not trusted by the OS.
    LDAP_CA_FILE: z.string().optional(),
    LDAP_TIMEOUT_MS: z.coerce.number().int().default(8000),
    // Password sign-in for users created with auth "local" (e.g. the break-glass admin).
    LOCAL_LOGIN_ENABLED: bool.default(true),

    SESSION_SECRET: z.string().min(32),
    SESSION_IDLE_MINUTES: z.coerce.number().int().default(15),
    SESSION_MAX_HOURS: z.coerce.number().int().default(8),
    // Secure cookies need HTTPS (the reverse proxy). Defaults to on in production.
    COOKIE_SECURE: bool.optional(),

    // 32 random bytes (64 hex digits): encrypts the secrets kept in the database (SMTP and backup passwords,
    // two-step keys). Lives on the app server only, never in the DB. LOG_HMAC_KEY is the old name of the same key.
    SECRET_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'SECRET_KEY must be 32 bytes hex').optional(),
    LOG_HMAC_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'LOG_HMAC_KEY must be 32 bytes hex').optional(),

    // Alerts: e-mail via SMTP (e.g. smtp://relay.corp.local:25) and/or a Teams incoming webhook.
    SMTP_URL: z.string().optional(),
    NOTIFY_FROM: z.string().default('bitlocker-keys@corp.local'),
    NOTIFY_TO: csv,
    TEAMS_WEBHOOK_URL: z.string().url().optional(),

    // Backups (Quan tri > Sao luu): folder of the encrypted files (outside the web root), and the
    // read-only account pg_dump uses for the database backup (role blk_backup). No URL = no database backup.
    BACKUP_DIR: z.string().default('backups'),
    BACKUP_DATABASE_URL: z.string().optional(),
    PG_DUMP_PATH: z.string().default('pg_dump'),

    // Text of every e-mail. Default: templates/mail-templates.yaml in the app folder.
    MAIL_TEMPLATES_FILE: z.string().optional(),

    // Background jobs (sync watchdog, audit chain check). Off in tests.
    JOBS_ENABLED: bool.default(true),
    APP_TZ: z.string().default('Asia/Ho_Chi_Minh'),

    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  })
  .superRefine((c, ctx) => {
    if (!c.SECRET_KEY && !c.LOG_HMAC_KEY) ctx.addIssue({ code: 'custom', path: ['SECRET_KEY'], message: 'SECRET_KEY is required (32 bytes hex)' });
    if (c.LDAP_SERVERS.length) {
      for (const k of ['LDAP_DOMAIN', 'LDAP_BASE_DN']) {
        if (!c[k]) ctx.addIssue({ code: 'custom', path: [k], message: `${k} is required when LDAP_SERVERS is set` });
      }
      if (c.LDAP_SERVERS.some((x) => x.includes('://'))) {
        ctx.addIssue({ code: 'custom', path: ['LDAP_SERVERS'], message: 'LDAP_SERVERS takes host or host:port, not a URL (set LDAP_PROTOCOL instead)' });
      }
    }
    if (!c.LDAP_SERVERS.length && !c.LOCAL_LOGIN_ENABLED) {
      ctx.addIssue({ code: 'custom', path: ['LOCAL_LOGIN_ENABLED'], message: 'no sign-in method left: set LDAP_SERVERS or enable local login' });
    }
    if (c.NODE_ENV === 'production') {
      // The worker always talks TLS in production (here, or at the reverse proxy: INGEST_TRUST_PROXY),
      // and must prove who it is (API key, from an allowed address).
      if (!c.INGEST_TRUST_PROXY) {
        for (const k of ['INGEST_TLS_CERT', 'INGEST_TLS_KEY']) {
          if (!c[k]) ctx.addIssue({ code: 'custom', path: [k], message: `${k} is required in production (or INGEST_TRUST_PROXY behind an HTTPS proxy)` });
        }
      }
      if (!c.INGEST_API_KEY) {
        ctx.addIssue({ code: 'custom', path: ['INGEST_API_KEY'], message: 'INGEST_API_KEY is required in production' });
      }
      if (c.SESSION_SECRET.startsWith('dev-only')) {
        ctx.addIssue({ code: 'custom', path: ['SESSION_SECRET'], message: 'the dev placeholder must not be used in production' });
      }
      if (c.INGEST_ALLOWED_IPS.length === 0) {
        ctx.addIssue({ code: 'custom', path: ['INGEST_ALLOWED_IPS'], message: 'required in production' });
      }
    }
  });

/** Reads and validates settings from environment variables. Throws with a readable list on error. */
export function loadConfig(env = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    // Names and messages only; never echo values (they include secrets).
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
    throw new Error(`Invalid configuration:\n  ${problems}`);
  }
  return { ...parsed.data, SECRET_KEY: parsed.data.SECRET_KEY ?? parsed.data.LOG_HMAC_KEY };
}

/** True when LDAP sign-in is sent without encryption (password in clear text). */
export const ldapIsPlain = (config) => config.LDAP_SERVERS.length > 0 && config.LDAP_PROTOCOL === 'ldap';

/** True when LDAP sign-in is configured. */
export const ldapEnabled = (config) => config.LDAP_SERVERS.length > 0;
