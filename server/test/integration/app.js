import request from 'supertest';
import { loadConfig } from '../../src/config.js';
import { createLogger } from '../../src/logger.js';
import { createServices } from '../../src/services.js';
import { createUserApp } from '../../src/app.js';
import { createIngestApp } from '../../src/ingest/ingest.app.js';
import { createUser } from '../../src/modules/auth/users.repo.js';
import { hashPassword } from '../../src/modules/auth/password.js';
import { DirectoryError } from '../../src/modules/auth/ldap.client.js';
import { APP_URL, HMAC_KEY } from './db.js';

export const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: APP_URL,
  SESSION_SECRET: 'test-session-secret-0000000000000000000000',
  LOG_HMAC_KEY: HMAC_KEY.toString('hex'),
  JOBS_ENABLED: 'false',
});

/** A notifier that records messages instead of sending them. */
export function fakeNotifier() {
  const sent = [];
  return { sent, send: async (m) => void sent.push(m) };
}

/**
 * A stand-in for Active Directory: accounts { sam: { password, objectGuid } }.
 * Set `down = true` to simulate unreachable DCs.
 */
export function fakeDirectory(accounts = {}) {
  return {
    accounts,
    down: false,
    binds: 0,
    async authenticate(sam, password) {
      this.binds++;
      if (this.down) throw new DirectoryError('unavailable');
      const a = Object.entries(this.accounts).find(([k]) => k.toLowerCase() === sam.toLowerCase())?.[1];
      if (!password || !a || a.password !== password) throw new DirectoryError('invalid_credentials');
      return { objectGuid: a.objectGuid, sam, upn: `${sam}@corp.local`, displayName: sam, mail: a.mail ?? null };
    },
  };
}

/**
 * A stand-in for nodemailer: records every message in `delivered`; set `fail` to an error message
 * to make sends throw. `options` holds the last transport options (SMTP settings).
 */
export function fakeMailTransport() {
  const t = { delivered: [], fail: null, options: null };
  t.create = (options) => {
    t.options = options;
    return {
      sendMail: async (m) => {
        if (t.fail) throw new Error(t.fail);
        t.delivered.push(m);
      },
    };
  };
  return t;
}

/** User app + ingest app wired exactly like production, with a fake notifier, a fake AD and a fake SMTP server. */
export function buildApp(pool, { notifier: ownNotifier, logger: ownLogger } = {}) {
  const logger = ownLogger ?? createLogger(process.env.TEST_LOG ?? 'silent');
  // ownNotifier === 'real': alerts go through the mail outbox like in production.
  const notifier = ownNotifier === 'real' ? undefined : fakeNotifier();
  const directory = fakeDirectory();
  const smtp = fakeMailTransport();
  const services = createServices({
    config: { ...config, LDAP_DOMAIN: 'corp.local' }, pool, logger, hmacKey: HMAC_KEY, notifier, ldap: directory, mailTransport: smtp.create,
  });
  return {
    app: createUserApp({ config, pool, logger, services }),
    ingestApp: createIngestApp({ config, logger, services }),
    services,
    sent: notifier?.sent ?? [],
    directory,
    smtp,
  };
}

export const PASSWORD = 'a-test-passphrase-123';

/** Creates a local user (password PASSWORD, no forced change) with grants [{ role, branchId }]. */
export async function addUser(pool, username, grants, { mustChange = false } = {}) {
  return createUser(pool, {
    username,
    displayName: username.toUpperCase(),
    authSource: 'local',
    passwordHash: await hashPassword(PASSWORD),
    mustChange,
    grants,
  });
}

/** Creates an AD user (no password stored here) with grants. */
export function addAdUser(pool, username, grants) {
  return createUser(pool, { username, displayName: username.toUpperCase(), authSource: 'ldap', grants });
}

/** API sign-in with a cookie-keeping agent. Returns { agent, csrf }. */
export async function apiLogin(app, username, password = PASSWORD) {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ username, password });
  if (res.status !== 200) throw new Error(`login ${username} failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { agent, csrf: res.body.csrfToken };
}

/** Pulls the CSRF token out of a rendered page. */
export const csrfFrom = (html) => /name="_csrf" value="([^"]+)"/.exec(html)?.[1];

/** Web (form) sign-in. Returns { agent, csrf } where csrf is the post-login token. */
export async function webLogin(app, username, password = PASSWORD) {
  const agent = request.agent(app);
  const page = await agent.get('/login');
  const res = await agent.post('/login').type('form').send({ _csrf: csrfFrom(page.text), username, password });
  if (res.status !== 302) throw new Error(`web login ${username} failed: ${res.status}`);
  const home = await agent.get('/change-password');
  return { agent, csrf: csrfFrom(home.text) };
}
