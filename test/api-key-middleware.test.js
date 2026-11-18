/**
 * Tests for src/auth/apiKeyMiddleware.js.
 *
 * We inject a fake Prisma client via dependency-injection so no real DB hit
 * is needed: the module imports prismaClient from '../db/prismaClient', so
 * we override require.cache before importing the middleware.
 */
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// ── Helpers ─────────────────────────────────────────────────────────────────

const hashHex = (key) => crypto.createHash('sha256').update(key).digest('hex');

/** Build a fake req / res / next triple for Express middleware testing. */
function makeCtx(headers = {}) {
  const req = {
    headers,
    get(name) { return this.headers[name.toLowerCase()]; },
    business: undefined,
    apiKey: undefined,
  };
  let statusCode = null;
  let body = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(payload) { body = payload; return this; },
    _status() { return statusCode; },
    _body() { return body; },
  };
  let nextCalled = false;
  const next = () => { nextCalled = true; };
  return { req, res, next, wasNext: () => nextCalled };
}

// ── Fake Prisma setup ────────────────────────────────────────────────────────

const GOOD_KEY = 'nak_goodKeyForTest1234567890abcdef';
const GOOD_BIZ = { id: 'biz-1', name: 'Acme Ltd', active: true };
const GOOD_RECORD = {
  id: 'ak-1',
  name: 'Test key',
  keyPrefix: GOOD_KEY.slice(0, 8),
  keyHash: hashHex(GOOD_KEY),
  active: true,
  business: GOOD_BIZ,
};

const fakePrisma = {
  _updateCalled: false,
  apiKey: {
    findMany: async ({ where }) => {
      if (where.keyPrefix === GOOD_KEY.slice(0, 8) && where.active === true) {
        return [GOOD_RECORD];
      }
      return [];
    },
    update: async () => { fakePrisma._updateCalled = true; },
  },
};

// Inject the fake before requiring the middleware.
before(() => {
  const prismaPath = require.resolve('../src/db/prismaClient');
  require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: fakePrisma };
});

// ── Tests ────────────────────────────────────────────────────────────────────

const { requireApiKey } = require('../src/auth/apiKeyMiddleware');

test('missing x-api-key header returns 401', async () => {
  const { req, res, wasNext } = makeCtx({});
  await requireApiKey(req, res, () => {});
  assert.equal(res._status(), 401);
  assert.match(res._body().error, /missing or invalid/i);
  assert.equal(wasNext(), false);
});

test('key with wrong prefix (not nak_) returns 401 without DB query', async () => {
  const { req, res, wasNext } = makeCtx({ 'x-api-key': 'sik_wrongprefix' });
  await requireApiKey(req, res, () => {});
  assert.equal(res._status(), 401);
  assert.equal(wasNext(), false);
});

test('key with correct prefix but wrong value returns 401', async () => {
  const { req, res, wasNext } = makeCtx({ 'x-api-key': 'nak_goodKeyBAD_VALUE_HERE!!!!!!!!' });
  await requireApiKey(req, res, () => {});
  assert.equal(res._status(), 401);
  assert.equal(wasNext(), false);
});

test('valid key: attaches req.business and req.apiKey, calls next', async () => {
  fakePrisma._updateCalled = false;
  const { req, res, next, wasNext } = makeCtx({ 'x-api-key': GOOD_KEY });
  await requireApiKey(req, res, next);
  assert.equal(wasNext(), true, 'next() should have been called');
  assert.deepEqual(req.business, GOOD_BIZ, 'req.business should be the matched business');
  assert.equal(req.apiKey.id, GOOD_RECORD.id);
  assert.equal(req.apiKey.name, GOOD_RECORD.name);
});

test('lastUsedAt is updated asynchronously (non-blocking)', async (t) => {
  // Give the fire-and-forget update a tick to settle.
  fakePrisma._updateCalled = false;
  const { req, res, next } = makeCtx({ 'x-api-key': GOOD_KEY });
  await requireApiKey(req, res, next);
  await new Promise((r) => setImmediate(r));
  assert.equal(fakePrisma._updateCalled, true, 'lastUsedAt update should fire');
});

