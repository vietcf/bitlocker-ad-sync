import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { appPool } from './db.js';
import { buildApp, config } from './app.js';
import { createIngestApp } from '../../src/ingest/ingest.app.js';
import { createLogger } from '../../src/logger.js';
import { loadConfig } from '../../src/config.js';

// The ingest API behind the nginx container: TLS at the proxy, the worker checked by the API key and
// by its address, which nginx writes into X-Forwarded-For (INGEST_TRUST_PROXY=1: one trusted hop).

let pool;
let services;
const KEY = 'k'.repeat(40);
const logger = createLogger('silent');

beforeAll(() => {
  pool = appPool();
  ({ services } = buildApp(pool));
});
afterAll(() => pool?.end());

const ingestApp = (extra) => createIngestApp({ config: { ...config, INGEST_API_KEY: KEY, ...extra }, logger, services });
const last = (app) => request(app).get('/api/ingest/sync-runs/last').set('Authorization', `Bearer ${KEY}`);

describe('ingest API behind the HTTPS reverse proxy', () => {
  it('checks the allow-list against the worker address written by the proxy', async () => {
    const app = ingestApp({ INGEST_TRUST_PROXY: '1', INGEST_ALLOWED_IPS: ['10.0.5.21'] });
    expect((await last(app).set('X-Forwarded-For', '10.0.5.21')).status).toBe(200);
    expect((await last(app).set('X-Forwarded-For', '10.0.5.99')).status).toBe(403);
  });

  it('cannot be fooled by an address the client put in front: only the hop the proxy added counts', async () => {
    const app = ingestApp({ INGEST_TRUST_PROXY: '1', INGEST_ALLOWED_IPS: ['10.0.5.21'] });
    // A client sends "X-Forwarded-For: 10.0.5.21"; a proxy that appended would make it "10.0.5.21, <real>".
    expect((await last(app).set('X-Forwarded-For', '10.0.5.21, 203.0.113.9')).status).toBe(403);
  });

  it('ignores X-Forwarded-For when no proxy is trusted', async () => {
    const app = ingestApp({ INGEST_ALLOWED_IPS: ['10.0.5.21'] });
    expect((await last(app).set('X-Forwarded-For', '10.0.5.21')).status).toBe(403); // the peer is 127.0.0.1
  });

  it('still requires the API key', async () => {
    const app = ingestApp({ INGEST_TRUST_PROXY: '1' });
    expect((await request(app).get('/api/ingest/sync-runs/last')).status).toBe(401);
    expect((await request(app).get('/api/ingest/sync-runs/last').set('Authorization', 'Bearer wrong')).status).toBe(401);
  });

  it('does not require INGEST_TLS_CERT in production when TLS is done by the proxy, but always the API key', () => {
    const base = {
      NODE_ENV: 'production', DATABASE_URL: 'postgres://x', SESSION_SECRET: 's'.repeat(40), LOG_HMAC_KEY: 'a'.repeat(64),
      INGEST_API_KEY: KEY, INGEST_ALLOWED_IPS: '10.0.5.21', LOCAL_LOGIN_ENABLED: 'true',
    };
    expect(() => loadConfig(base)).toThrow(/INGEST_TLS_CERT/);
    expect(() => loadConfig({ ...base, INGEST_TRUST_PROXY: '1' })).not.toThrow();
    expect(() => loadConfig({ ...base, INGEST_TRUST_PROXY: '1', INGEST_API_KEY: undefined })).toThrow(/INGEST_API_KEY/);
  });

  it('an empty INGEST_ALLOWED_IPS means any address in production (no IP filter)', async () => {
    const base = {
      NODE_ENV: 'production', DATABASE_URL: 'postgres://x', SESSION_SECRET: 's'.repeat(40), LOG_HMAC_KEY: 'a'.repeat(64),
      INGEST_API_KEY: KEY, INGEST_TRUST_PROXY: '1', LOCAL_LOGIN_ENABLED: 'true',
    };
    expect(() => loadConfig(base)).not.toThrow();
    expect(loadConfig({ ...base, INGEST_ALLOWED_IPS: '' }).INGEST_ALLOWED_IPS).toEqual([]);
    const app = ingestApp({ INGEST_TRUST_PROXY: '1', INGEST_ALLOWED_IPS: [] });
    expect((await request(app).get('/api/ingest/sync-runs/last').set('X-Forwarded-For', '203.0.113.9').set('Authorization', `Bearer ${KEY}`)).status).toBe(200);
  });
});
