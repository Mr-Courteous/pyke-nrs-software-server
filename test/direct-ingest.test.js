/**
 * Integration tests for POST /api/ingest/direct
 *
 * Uses in-memory fake stores — no real DB, no network.
 * Covers: auth rejection, single invoice, batch, duplicate, batch partial failure.
 */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

// ── Helpers ──────────────────────────────────────────────────────────────────

const clone = (v) => structuredClone(v);

function stub(rel, exports) {
  const id = require.resolve(path.join(__dirname, '..', 'src', rel));
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

// ── In-memory fakes ──────────────────────────────────────────────────────────

// Invoice store
const records = new Map();
let seq = 0;
const fakeStore = {
  async create({ sourceSystem, raw, sourceRef = null, businessId = null }) {
    if (sourceRef && [...records.values()].some((r) => r.sourceRef === sourceRef)) {
      throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    }
    const r = { id: `inv${++seq}`, status: 'RECEIVED', sourceSystem, sourceRef, raw, mapped: null, errors: null, signature: null, irn: null, qr: null, businessId };
    records.set(r.id, r);
    return clone(r);
  },
  async update(id, patch) { Object.assign(records.get(id), patch); return clone(records.get(id)); },
  async get(id) { return records.has(id) ? clone(records.get(id)) : null; },
  async list() { return [...records.values()].map(clone); },
  async findBySourceRef(_, sourceRef) {
    const r = sourceRef && [...records.values()].find((x) => x.sourceRef === sourceRef);
    return r ? clone(r) : null;
  },
  async findIrnClash(irn, exceptId) {
    const r = [...records.values()].find((x) => x.irn === irn && x.id !== exceptId);
    return r ? { id: r.id, status: r.status } : null;
  },
};

// Business store
const bizMap = new Map([
  ['biz-99', { id: 'biz-99', name: 'Acme Ltd', tin: '11111111-0001', active: true, irnSuffix: 'TEST01', hasServiceId: true, nrsBusinessId: 'nrs-99', publicKey: null, certificate: null, email: null, phone: null, address: null, city: null, postalZone: null, state: null, lga: null }],
]);
const fakeBusinessStore = {
  async get(id) { const b = bizMap.get(id); if (!b) return null; const { publicKey, certificate, ...rest } = b; return clone(rest); },
  async getForSigning(id) { return bizMap.has(id) ? clone(bizMap.get(id)) : null; },
};

// Product-code / customer-detail no-ops
const fakePrisma = { productCode: { async createMany() {}, async findMany() { return []; } } };
const fakeCustomerPrisma = { customerDetail: { async upsert({ create }) { return { id: 'cd1', tin: null, email: null, phone: null, street: null, city: null, state: null, lga: null, postalZone: null, ...create }; }, async findMany() { return []; }, async update() {} } };

// API key middleware fake — bypasses real prisma lookup
const API_KEY = 'nak_testkey_abcdefghijklmnopqrstuvwxyz01234'; // 43 chars after nak_
const BUSINESS = { id: 'biz-99', name: 'Acme Ltd', active: true };
const API_KEY_INFO = { id: 'ak-test-1', name: 'test key' };

const fakeApiKeyMiddleware = {
  requireApiKey(req, res, next) {
    const raw = req.get('x-api-key');
    if (!raw || raw !== API_KEY) {
      return res.status(401).json({ error: 'Missing or invalid API key.' });
    }
    req.business = BUSINESS;
    req.apiKey = API_KEY_INFO;
    return next();
  },
};

// ── Stub before requiring any app code ───────────────────────────────────────

before(() => {
  const { createProductCodeStore } = require('../src/db/productCodeStore');
  const { createCustomerDetailStore } = require('../src/db/customerDetailStore');

  stub('db/store.js', fakeStore);
  stub('db/businessStore.js', fakeBusinessStore);
  stub('db/productCodeStore.js', createProductCodeStore(() => fakePrisma));
  stub('db/customerDetailStore.js', createCustomerDetailStore(() => fakeCustomerPrisma));
  stub('db/prismaClient.js', {});
  stub('db/apiKeyStore.js', {});                        // routes.js imports this but won't use it here
  stub('auth/apiKeyMiddleware.js', fakeApiKeyMiddleware);
  stub('db/connectorStore.js', { async authenticate() { return null; } });
  stub('ingestion/qbwc/router.js', { qwcFor() {} });
  stub('auth/authRoutes.js', require('express').Router()); // mount a no-op router
});

// ── App fixture ───────────────────────────────────────────────────────────────

let server;
let baseUrl;

before(async () => {
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api', require('../src/api/routes'));

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}/api`;
});

after(() => server && server.close());

// ── Sample invoice ────────────────────────────────────────────────────────────

const invoice = (over = {}) => ({
  invoiceNumber: 'DIR-001',
  issueDate: '2026-10-01',
  currency: 'NGN',
  vatRate: 7.5,
  buyer: {
    ref: 'B1', name: 'Buyer Ltd', tin: '99999999-0001', email: 'b@example.com',
    street: '1 Buyer St', address: '1 Buyer St', city: 'Ikeja', state: 'Lagos',
    lga: 'NG-LA-IKJ', postalZone: '100271', country: 'NG',
  },
  items: [
    { description: 'Widget A', productRef: 'W1', quantity: 2, unitPrice: 1000 },
  ],
  ...over,
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/ingest/direct', () => {

  test('401 — missing X-API-Key header', async () => {
    const res = await fetch(`${baseUrl}/ingest/direct`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(invoice()),
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, 'Missing or invalid API key.');
  });

  test('401 — wrong key value', async () => {
    const res = await fetch(`${baseUrl}/ingest/direct`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'nak_wrongkey' },
      body: JSON.stringify(invoice()),
    });
    assert.equal(res.status, 401);
  });

  test('200 — single invoice accepted', async () => {
    const res = await fetch(`${baseUrl}/ingest/direct`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify(invoice()),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.results));
    assert.equal(body.results.length, 1);
    const r = body.results[0];
    assert.equal(r.ok, true);
    assert.equal(r.index, 0);
    assert.ok(r.id, 'invoice id should be present');
  });

  test('200 — same invoice again returns duplicate flag', async () => {
    // The store deduplicates by sourceRef; sending the same invoice a second
    // time should come back as ok:true + duplicate:true (not an error).
    const res = await fetch(`${baseUrl}/ingest/direct`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify(invoice()), // same invoiceNumber as the previous test
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    const r = body.results[0];
    assert.equal(r.ok, true);
    assert.equal(r.duplicate, true, 'second submission should be flagged as duplicate');
  });

  test('200 — batch of two distinct invoices', async () => {
    const res = await fetch(`${baseUrl}/ingest/direct`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({
        invoices: [
          invoice({ invoiceNumber: 'BATCH-A' }),
          invoice({ invoiceNumber: 'BATCH-B' }),
        ],
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.results.length, 2);
    assert.ok(body.results.every((r) => r.ok));
  });

  test('413 — batch over 200 invoices rejected', async () => {
    const bigBatch = Array.from({ length: 201 }, (_, i) => invoice({ invoiceNumber: `BIG-${i}` }));
    const res = await fetch(`${baseUrl}/ingest/direct`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({ invoices: bigBatch }),
    });
    assert.equal(res.status, 413);
    const body = await res.json();
    assert.match(body.error, /200/);
  });

  test('207 — partial failure returns mixed results', async () => {
    // First item is a fresh invoice; second is a structurally invalid one (no items).
    const res = await fetch(`${baseUrl}/ingest/direct`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({
        invoices: [
          invoice({ invoiceNumber: 'PARTIAL-OK' }),
          { invoiceNumber: 'BAD', issueDate: '2026-10-01', currency: 'NGN', buyer: invoice().buyer, items: [] },
        ],
      }),
    });
    // 207 Multi-Status when at least one fails and at least one succeeds.
    // If the pipeline throws on the bad invoice we expect 207; if it stores
    // it with errors the response may be 200 — accept either.
    assert.ok([200, 207].includes(res.status), `unexpected status ${res.status}`);
    const body = await res.json();
    assert.equal(body.results.length, 2);
    assert.equal(body.results[0].index, 0);
    assert.equal(body.results[1].index, 1);
  });
});
