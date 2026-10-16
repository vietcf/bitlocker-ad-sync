import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { loadIngestSpec } from '../../src/ingest/ingest.app.js';
import { appPool, asOwner, resetDatabase } from './db.js';
import { buildApp } from './app.js';

// Keeps server/openapi/ingest.openapi.yaml honest: every operation in the spec exists, its request
// examples are accepted by the real API, and the responses carry the fields the spec requires.

const spec = loadIngestSpec();
const BASE = '/api/ingest';

let pool;
let ingestApp;

beforeAll(() => {
  pool = appPool();
  ({ ingestApp } = buildApp(pool));
});
afterAll(() => pool?.end());
beforeEach(async () => {
  await resetDatabase();
  await asOwner(`
    INSERT INTO branch (code, name) VALUES ('HN', 'Ha Noi');
    INSERT INTO branch_ou (branch_id, root_dn) VALUES (1, 'ou=computers,ou=hn,dc=corp,dc=local');`);
});

const op = (path, method) => spec.paths[path][method];
const requestExample = (path, method, name) => {
  const content = op(path, method).requestBody.content['application/json'];
  return structuredClone(name ? content.examples[name].value : content.example);
};
const schema = (name) => spec.components.schemas[name];
/** The response has every property the schema marks as required. */
const expectRequired = (body, schemaName) => {
  for (const field of schema(schemaName).required ?? []) expect(body, `${schemaName}.${field}`).toHaveProperty(field);
};

describe('ingest OpenAPI document', () => {
  it('is served as Swagger UI and as raw YAML/JSON', async () => {
    expect((await request(ingestApp).get('/docs/')).text).toContain('swagger-ui');
    expect((await request(ingestApp).get('/docs/openapi.yaml')).text).toContain('openapi: 3.1.0');
    expect((await request(ingestApp).get('/docs/openapi.json')).body.info.title).toBe(spec.info.title);
  });

  it('describes exactly the routes the server has', () => {
    expect(Object.keys(spec.paths).sort()).toEqual(
      ['/computers', '/heartbeat', '/keys', '/sync-runs', '/sync-runs/last', '/sync-runs/{runId}/complete'],
    );
    expect(spec.servers[0].url.endsWith(BASE)).toBe(true);
  });

  it('accepts its own request examples, in the documented order, with the documented responses', async () => {
    const api = () => request(ingestApp);

    const last0 = await api().get(`${BASE}/sync-runs/last`);
    expect(last0.status).toBe(200);
    expect(last0.body).toEqual({});

    const open = await api().post(`${BASE}/sync-runs`).send(requestExample('/sync-runs', 'post'));
    expect(open.status).toBe(201);
    expectRequired(open.body, 'OpenRunResponse');
    expect(open.body.mode).toBe('full'); // no successful run yet: the documented delta -> full rule
    const { runId } = open.body;

    const computers = requestExample('/computers', 'post');
    computers.runId = runId;
    const c = await api().post(`${BASE}/computers`).send(computers);
    expect(c.status).toBe(200);
    expectRequired(c.body, 'ComputersResult');
    expect(c.body).toEqual({ upserted: 1, moved: 0, unmapped: 0 });

    const keys = requestExample('/keys', 'post');
    keys.runId = runId;
    const k = await api().post(`${BASE}/keys`).send(keys);
    expect(k.status).toBe(200);
    expectRequired(k.body, 'KeysResult');
    expect(k.body).toMatchObject({ inserted: 1, orphans: [] });

    const complete = requestExample('/sync-runs/{runId}/complete', 'post', 'success');
    complete.computersSeen = 1;
    complete.keysSeen = 1;
    const done = await api().post(`${BASE}/sync-runs/${runId}/complete`).send(complete);
    expect(done.status).toBe(200);
    expectRequired(done.body, 'CompleteResult');
    expect(done.body.status).toBe('success');

    const last = await api().get(`${BASE}/sync-runs/last`);
    expectRequired(last.body, 'LastRun');

    const hb = await api().post(`${BASE}/heartbeat`).send(requestExample('/heartbeat', 'post'));
    expect(hb.status).toBe(200);
    expectRequired(hb.body, 'HeartbeatResponse');
  });

  it('documents the error shapes the server really returns', async () => {
    const bad = await request(ingestApp).post(`${BASE}/sync-runs`).send({ mode: 'sometimes' });
    expect(bad.status).toBe(400);
    for (const f of ['error', 'message', 'fields']) expect(bad.body).toHaveProperty(f);

    await request(ingestApp).post(`${BASE}/sync-runs`).send({ mode: 'full', dcName: 'DC01' });
    const busy = await request(ingestApp).post(`${BASE}/sync-runs`).send({ mode: 'full', dcName: 'DC01' });
    expect(busy.status).toBe(409);
    expect(busy.body.error).toBe(op('/sync-runs', 'post').responses['409'].content['application/json'].example.error);

    const missing = await request(ingestApp).post(`${BASE}/sync-runs/999999/complete`).send({ status: 'failed' });
    expect(missing.status).toBe(404);
  });

  it('lists every worker error code the server knows', async () => {
    const { ERROR_SEVERITY } = await import('../../src/modules/sync/ingest.service.js');
    const documented = schema('ErrorCode').enum;
    for (const code of Object.keys(ERROR_SEVERITY)) expect(documented).toContain(code);
  });
});
