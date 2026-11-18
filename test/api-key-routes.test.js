/**
 * Integration-level tests for the API-key management routes.
 *
 * We use the real app and in-memory fake stores so no real DB or network is
 * needed.  The pattern mirrors the existing test/pipeline.test.js: start the
 * Express app under test, hit it with fetch(), and assert on HTTP status + body.
 */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// ── In-memory fakes ──────────────────────────────────────────────────────────

const businesses = new Map([
  ['biz-1', { id: 'biz-1', name: 'Acme Ltd', active: true }],
]);

const apiKeys = new Map(); // id → row
let nextId = 1;

const hashKey = (k) => crypto.createHash('sha256').update(k).digest('hex');

const fakeApiKeyStore = {
  async create(businessId, { name = 'Default' } = {}) {
    if (!businesses.has(businessId)) {
      throw Object.assign(new Error('Company not found.'), { status: 404 });
    }
    const id = `ak-${nextId++}`;
    const key = `nak_${crypto.randomBytes(32).toString('base64url')}`;
    const row = { id, name, keyPrefix: key.slice(0, 8), active: true, businessId, lastUsedAt: null, createdAt: new Date(), updatedAt: new Date(), key };
    apiKeys.set(id, row);
    return row;
  },
  async list(businessId) {
    return [...apiKeys.values()].filter((r) => r.businessId === businessId).map(({ key: _, ...r }) => r);
  },
  async rotate(id, businessId) {
    const existing = apiKeys.get(id);
    if (!existing || existing.businessId !== businessId) throw Object.assign(new Error('API key not found.'), { status: 404 });
    const key = `nak_${crypto.randomBytes(32).toString('base64url')}`;
    existing.keyPrefix = key.slice(0, 8);
    existing.key = key;
    return existing;
  },
  async revoke(id, businessId) {
    const existing = apiKeys.get(id);
    if (!existing || existing.businessId !== businessId) throw Object.assign(new Error('API key not found.'), { status: 404 });
    existing.active = false;
    return existing;
  },
  async remove(id, businessId) {
    const existing = apiKeys.get(id);
    if (!existing || existing.businessId !== businessId) throw Object.assign(new Error('API key not found.'), { status: 404 });
    apiKeys.delete(id);
  },
};

// ── Inject fakes before requiring routes ─────────────────────────────────────

before(() => {
  // Replace apiKeyStore module in cache
  const storePath = require.resolve('../src/db/apiKeyStore');
  require.cache[storePath] = { id: storePath, filename: storePath, loaded: true, exports: fakeApiKeyStore };

  // Replace auth middleware so every request passes as ADMIN
  const mwPath = require.resolve('../src/auth/authMiddleware');
  require.cache[mwPath] = {
    id: mwPath, filename: mwPath, loaded: true,
    exports: {
      requireAuth: (req, _res, next) => { req.user = { id: 'u1', email: 'admin@test.com', role: 'ADMIN' }; next(); },
      requireRole: () => (_req, _res, next) => next(),
    },
  };
});

// ── Start the app ─────────────────────────────────────────────────────────────

let server;
let base;

before(async () => {
  // Avoid loading the real pipeline by stubbing its imports too
  const pipelinePath = require.resolve('../src/pipeline');
  if (!require.cache[pipelinePath]) {
    require.cache[pipelinePath] = {
      id: pipelinePath, filename: pipelinePath, loaded: true,
      exports: { processInvoice: async () => ({}), retryInvoice: async () => null, assignBusiness: async () => ({}) },
    };
  }

  const app = require('../src/api/routes');
  const express = require('express');
  const wrapper = express();
  wrapper.use(express.json());
  wrapper.use('/api', app);
  await new Promise((resolve) => {
    server = wrapper.listen(0, resolve);
  });
  base = `http://localhost:${server.address().port}/api`;
});

after(() => server?.close());

// ── Helpers ───────────────────────────────────────────────────────────────────

const get = (path) => fetch(`${base}${path}`);
const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const patch = (path) => fetch(`${base}${path}`, { method: 'PATCH' });
const del = (path) => fetch(`${base}${path}`, { method: 'DELETE' });

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('API key management routes', () => {
  let createdKeyId;
  let plainKey;

  test('GET /businesses/biz-1/api-keys returns empty list initially', async () => {
    const r = await get('/businesses/biz-1/api-keys');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(Array.isArray(body));
    assert.equal(body.length, 0);
  });

  test('POST /businesses/biz-1/api-keys generates a key (returned once)', async () => {
    const r = await post('/businesses/biz-1/api-keys', { name: 'Test integration' });
    assert.equal(r.status, 201);
    const body = await r.json();
    assert.ok(body.key, 'plain-text key should be in the response');
    assert.match(body.key, /^nak_/, 'key should start with nak_');
    assert.ok(body.id, 'id should be present');
    assert.equal(body.name, 'Test integration');
    createdKeyId = body.id;
    plainKey = body.key;
  });

  test('GET list after creation: key present but no plain-text', async () => {
    const r = await get('/businesses/biz-1/api-keys');
    const body = await r.json();
    assert.equal(body.length, 1);
    assert.equal(body[0].id, createdKeyId);
    assert.equal(body[0].key, undefined, 'plain-text key must NOT appear in list');
  });

  test('POST /businesses/biz-nonexistent/api-keys returns 404', async () => {
    const r = await post('/businesses/biz-nonexistent/api-keys', {});
    assert.equal(r.status, 404);
  });

  test('POST .../rotate returns a new plain-text key', async () => {
    const r = await post(`/businesses/biz-1/api-keys/${createdKeyId}/rotate`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(body.key, 'rotated key should be present');
    assert.match(body.key, /^nak_/);
    assert.notEqual(body.key, plainKey, 'rotated key must differ from original');
  });

  test('POST .../rotate for wrong business returns 404', async () => {
    const r = await post(`/businesses/biz-other/api-keys/${createdKeyId}/rotate`);
    assert.equal(r.status, 404);
  });

  test('PATCH .../revoke deactivates the key', async () => {
    const r = await patch(`/businesses/biz-1/api-keys/${createdKeyId}/revoke`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.active, false);
  });

  test('DELETE .../api-keys/:id removes the key; 204 on success', async () => {
    // Recreate so we have something to delete
    const cr = await post('/businesses/biz-1/api-keys', { name: 'To delete' });
    const { id } = await cr.json();
    const r = await del(`/businesses/biz-1/api-keys/${id}`);
    assert.equal(r.status, 204);
  });

  test('DELETE for wrong business returns 404', async () => {
    const r = await del(`/businesses/biz-other/api-keys/${createdKeyId}`);
    assert.equal(r.status, 404);
  });
});
