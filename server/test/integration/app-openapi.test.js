import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { loadSpec } from '../../src/http/api-docs.js';
import { appPool, resetDatabase, seedTwoBranches } from './db.js';
import { addUser, apiLogin, buildApp } from './app.js';

// Keeps server/openapi/app.openapi.yaml honest: it documents exactly the routes of the /api
// router, and every documented operation reaches a real handler.

const spec = loadSpec('app');
const METHODS = ['get', 'post', 'put', 'delete'];

/** Mount point of each module's router in src/api/index.js. */
const MOUNTS = {
  'auth/auth.api.js': '/api/auth',
  'computers/computers.api.js': '/api',
  'keys/keys.api.js': '/api/keys',
  'audit/audit.api.js': '/api/audit',
  'reports/reports.api.js': '/api/reports',
  'admin/admin.api.js': '/api/admin',
  'dashboard/dashboard.api.js': '/api/dashboard',
};

/** "METHOD /api/path/{param}" for every route the API source declares. */
function sourceRoutes() {
  const out = new Set();
  for (const [file, mount] of Object.entries(MOUNTS)) {
    const src = fs.readFileSync(new URL(`../../src/modules/${file}`, import.meta.url), 'utf8');
    // auth.api.js holds two routers: /api/auth/* and /api/me.
    const [authPart, mePart] = file.startsWith('auth/') ? src.split('export function meApi') : [src, ''];
    const scan = (text, base) => {
      for (const m of text.matchAll(/\br\.(get|post|put|delete)\('([^']*)'/g)) {
        const path = `${base}${m[2] === '/' ? '' : m[2]}`.replace(/:(\w+)/g, '{$1}');
        out.add(`${m[1].toUpperCase()} ${path}`);
      }
    };
    scan(authPart, mount);
    if (mePart) scan(mePart, '/api/me');
  }
  return out;
}

const specRoutes = () =>
  new Set(Object.entries(spec.paths).flatMap(([path, ops]) => METHODS.filter((m) => ops[m]).map((m) => `${m.toUpperCase()} ${path}`)));

let pool;
let app;

beforeAll(async () => {
  pool = appPool();
  ({ app } = buildApp(pool));
  await resetDatabase();
  await seedTwoBranches();
  await addUser(pool, 'admin.hq', [{ branchId: null, role: 'admin' }]);
});
afterAll(() => pool?.end());

describe('app OpenAPI document', () => {
  it('documents exactly the routes of the /api router (docs pages excepted)', () => {
    expect([...specRoutes()].sort()).toEqual([...sourceRoutes()].sort());
  });

  it('gives every operation a unique operationId and at least one tag', () => {
    const ops = Object.values(spec.paths).flatMap((p) => METHODS.map((m) => p[m]).filter(Boolean));
    const ids = ops.map((o) => o.operationId);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ops.every((o) => o.tags?.length)).toBe(true);
  });

  it('serves Swagger UI and the raw spec to signed-in users only', async () => {
    expect((await request(app).get('/api/docs/')).status).toBe(401);
    const { agent } = await apiLogin(app, 'admin.hq');
    const page = await agent.get('/api/docs/');
    expect(page.text).toContain('swagger-ui');
    expect(page.headers['content-security-policy']).toContain("style-src 'self' 'unsafe-inline'");
    for (const asset of ['swagger-ui.css', 'swagger-ui-bundle.js', 'swagger-ui-init.js']) {
      expect((await agent.get(`/api/docs/${asset}`)).status, asset).toBe(200);
    }
    expect((await agent.get('/api/docs/swagger-ui-init.js')).text).toContain(spec.info.title);
    expect((await agent.get('/api/docs/openapi.yaml')).text).toContain('openapi: 3.1.0');
    expect((await agent.get('/api/docs/openapi.json')).body.info.title).toBe(spec.info.title);
  });

  it('every documented GET reaches a real handler (not the catch-all 404)', async () => {
    const { agent } = await apiLogin(app, 'admin.hq');
    for (const path of Object.keys(spec.paths).filter((p) => spec.paths[p].get)) {
      const url = path.replace('{id}', '1').replace('{keyId}', 'aaaaaaaa-0000-0000-0000-000000000001');
      const res = await agent.get(url).query(path === '/api/keys/search' ? { keyId: 'aaaaaaaa' } : {});
      // The catch-all answers { error: 'not_found' } with no message; handlers always add one.
      expect(res.body?.error === 'not_found' && !res.body?.message, `${path}: ${res.status}`).toBe(false);
    }
  });
});
