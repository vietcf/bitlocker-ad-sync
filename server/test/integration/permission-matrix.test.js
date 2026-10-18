import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { loadSpec } from '../../src/http/api-docs.js';
import { appPool, resetDatabase, seedTwoBranches } from './db.js';
import { addUser, apiLogin, buildApp, webLogin } from './app.js';

// Who may reach what, for every documented API operation and the web pages:
//   keys    (computers, keys)  it, lead, admin          audit / reports   lead, admin, auditor
//   /api/admin, /admin/*       admin only
// A role that is not allowed must get 403 (never data, never a 5xx); nobody signed in gets 401 / a redirect.

const spec = loadSpec('app');
const METHODS = ['get', 'post', 'put', 'delete'];
const ROLES = ['it', 'lead', 'auditor', 'admin'];

const ALLOWED = [
  [/^\/api\/admin(\/|$)/, ['admin']],
  [/^\/api\/(computers|keys)(\/|$)/, ['it', 'lead', 'admin']],
  [/^\/api\/audit(\/|$)/, ['lead', 'admin', 'auditor']],
  [/^\/api\/reports(\/|$)/, ['lead', 'admin', 'auditor']],
];
const allowedFor = (path) => ALLOWED.find(([re]) => re.test(path))?.[1] ?? null;

let pool;
let app;
const sessions = {};

beforeAll(async () => {
  pool = appPool();
  ({ app } = buildApp(pool));
  await resetDatabase();
  await seedTwoBranches();
  await addUser(pool, 'u.it', [{ branchId: 1, role: 'it' }]);
  await addUser(pool, 'u.lead', [{ branchId: 1, role: 'lead' }]);
  await addUser(pool, 'u.auditor', [{ branchId: 1, role: 'auditor' }]);
  await addUser(pool, 'u.admin', [{ branchId: null, role: 'admin' }]);
  for (const r of ROLES) sessions[r] = await apiLogin(app, `u.${r}`);
});
afterAll(() => pool?.end());

const operations = Object.entries(spec.paths).flatMap(([path, ops]) =>
  METHODS.filter((m) => ops[m]).map((m) => ({ method: m, spec: path, url: path.replace(/\{\w+\}/g, '1') })));

describe('API permissions follow the role table', () => {
  it('rejects every call without a session', async () => {
    for (const op of operations) {
      if (op.spec.startsWith('/api/auth/') || op.spec === '/api/me' || op.spec.startsWith('/api/docs')) continue;
      const res = await request(app)[op.method](op.url).send({});
      // Writes without a session may be stopped by the CSRF check (403) before the sign-in check; never let through.
      expect([401, 403], `${op.method} ${op.spec}`).toContain(res.status);
      if (op.method === 'get') expect(res.status, `${op.method} ${op.spec}`).toBe(401);
    }
  });

  it('answers 403 to every role that is not allowed, on every method', async () => {
    const wrong = [];
    for (const op of operations) {
      const allowed = allowedFor(op.spec);
      if (!allowed) continue;
      for (const role of ROLES.filter((r) => !allowed.includes(r))) {
        const s = sessions[role];
        const res = await s.agent[op.method](op.url).set('X-CSRF-Token', s.csrf).send({});
        if (res.status !== 403) wrong.push(`${role} ${op.method.toUpperCase()} ${op.spec} -> ${res.status}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('lets allowed roles read (GET) without 401 / 403 / 5xx', async () => {
    const wrong = [];
    for (const op of operations.filter((o) => o.method === 'get')) {
      const allowed = allowedFor(op.spec);
      if (!allowed) continue;
      for (const role of allowed) {
        const res = await sessions[role].agent.get(op.url);
        if ([401, 403].includes(res.status) || res.status >= 500) wrong.push(`${role} GET ${op.spec} -> ${res.status}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});

/** GET routes declared in the web modules, with the prefix each module is mounted on. */
function webGetPaths() {
  const mods = [
    ['admin/admin.web.js', '/admin'], ['settings/settings.web.js', '/admin'], ['backup/backup.web.js', '/admin/backup'],
    ['sync/sync.web.js', '/admin/sync'], ['audit/audit.web.js', '/audit'], ['reports/reports.web.js', '/reports'],
  ];
  const out = [];
  for (const [file, mount] of mods) {
    let src;
    try { src = fs.readFileSync(new URL(`../../src/modules/${file}`, import.meta.url), 'utf8'); } catch { continue; }
    for (const m of src.matchAll(/\br\.get\('([^']*)'/g)) out.push(`${mount}${m[1] === '/' ? '' : m[1]}`.replace(/:\w+/g, '1'));
  }
  return [...new Set(out)];
}

describe('web pages follow the same role table', () => {
  it('shows /admin/*, /audit, /reports only to the roles allowed there', async () => {
    const wrong = [];
    const web = {};
    for (const r of ROLES) web[r] = await webLogin(app, `u.${r}`);
    for (const url of webGetPaths()) {
      const allowed = url.startsWith('/admin') ? ['admin'] : ['lead', 'admin', 'auditor'];
      for (const role of ROLES) {
        const res = await web[role].agent.get(url).redirects(0);
        const denied = res.status === 403;
        if (allowed.includes(role) && denied) wrong.push(`${role} GET ${url} was refused`);
        if (!allowed.includes(role) && !denied) wrong.push(`${role} GET ${url} -> ${res.status}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('computer pages and exports are for it / lead / admin only', async () => {
    const wrong = [];
    const web = {};
    for (const r of ROLES) web[r] = await webLogin(app, `u.${r}`);
    // export-keys is also switched off by default (Quan tri > Tinh nang), so allowed roles may see 403 there.
    for (const url of ['/computers/1', '/computers/export.csv', '/computers/export-keys', '/computers/1/reveal']) {
      for (const role of ROLES) {
        const res = await web[role].agent.get(url).redirects(0);
        const allowed = ['it', 'lead', 'admin'].includes(role);
        if (!allowed && res.status !== 403) wrong.push(`${role} GET ${url} -> ${res.status}`);
        if (allowed && (res.status === 401 || res.status >= 500 || (res.status === 403 && url !== '/computers/export-keys'))) wrong.push(`${role} GET ${url} -> ${res.status}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});
