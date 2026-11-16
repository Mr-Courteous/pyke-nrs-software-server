const express = require('express');
const { processInvoice, retryInvoice, assignBusiness } = require('../pipeline');
const store = require('../db/store');
const businessStore = require('../db/businessStore');
const productCodeStore = require('../db/productCodeStore');
const customerDetailStore = require('../db/customerDetailStore');
const connectorStore = require('../db/connectorStore');
const { normalize } = require('../ingestion');
const { qwcFor } = require('../ingestion/qbwc/router');
const { requireAuth, requireRole } = require('../auth/authMiddleware');

const router = express.Router();

const fail = (res, err, fallback = 400) => res.status(err.status || fallback).json({ error: err.message });

// ---- Invoices -------------------------------------------------------------------------------

router.get('/invoices', requireAuth, async (req, res) => {
  res.json(await store.list());
});

router.get('/invoices/:id', requireAuth, async (req, res) => {
  const invoice = await store.get(req.params.id);
  if (!invoice) return res.status(404).json({ error: 'Not found' });
  res.json(invoice);
});

// Hand-entered invoice (for testing, or one-offs). Maps and validates; with a company it also makes the IRN and QR.
router.post('/upload/manual', requireAuth, requireRole('FINANCE'), async (req, res) => {
  try {
    const { businessId, ...raw } = req.body || {};
    res.status(202).json(await processInvoice(raw, 'manual-upload', { businessId }));
  } catch (err) {
    fail(res, err, 500);
  }
});

router.post('/invoices/:id/retry', requireAuth, requireRole('FINANCE'), async (req, res) => {
  try {
    const updated = await retryInvoice(req.params.id);
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json(updated);
  } catch (err) {
    fail(res, err);
  }
});

// Gives each listed invoice a company (or clears it with businessId: null) and makes its IRN and QR.
router.post('/invoices/assign-business', requireAuth, requireRole('FINANCE'), async (req, res) => {
  const { invoiceIds, businessId } = req.body || {};
  if (!Array.isArray(invoiceIds) || invoiceIds.length === 0) {
    return res.status(400).json({ error: 'invoiceIds must be a non-empty array.' });
  }
  const results = [];
  for (const id of invoiceIds) {
    try {
      const inv = await assignBusiness(id, businessId || null);
      results.push({ id, ok: true, status: inv.status });
    } catch (err) {
      results.push({ id, ok: false, error: err.message });
    }
  }
  res.json({ results });
});

router.get('/stats', requireAuth, async (req, res) => {
  const all = await store.list();
  const byStatus = all.reduce((acc, inv) => ({ ...acc, [inv.status]: (acc[inv.status] || 0) + 1 }), {});
  res.json({ total: all.length, byStatus });
});

// ---- Companies ------------------------------------------------------------------------------

router.get('/businesses', requireAuth, async (req, res) => {
  try {
    res.json(await businessStore.list());
  } catch (err) {
    fail(res, err, 500);
  }
});

router.post('/businesses', requireAuth, requireRole('FINANCE'), async (req, res) => {
  try {
    res.status(201).json(await businessStore.createLocal(req.body || {}));
  } catch (err) {
    fail(res, err);
  }
});

router.patch('/businesses/:id', requireAuth, requireRole('FINANCE'), async (req, res) => {
  try {
    res.json(await businessStore.update(req.params.id, req.body || {}));
  } catch (err) {
    fail(res, err);
  }
});

// ---- Product codes and buyer details (what the accounting software does not hold) -----------

router.get('/product-codes', requireAuth, async (req, res) => {
  try {
    res.json(await productCodeStore.list({ needsCode: req.query.needsCode === '1' }));
  } catch (err) {
    fail(res, err, 500);
  }
});

router.patch('/product-codes/:id', requireAuth, requireRole('FINANCE'), async (req, res) => {
  try {
    res.json(await productCodeStore.update(req.params.id, req.body || {}));
  } catch (err) {
    fail(res, err);
  }
});

router.get('/customer-details', requireAuth, async (req, res) => {
  try {
    res.json(await customerDetailStore.list({ needsDetails: req.query.needsDetails === '1' }));
  } catch (err) {
    fail(res, err, 500);
  }
});

router.patch('/customer-details/:id', requireAuth, requireRole('FINANCE'), async (req, res) => {
  try {
    res.json(await customerDetailStore.update(req.params.id, req.body || {}));
  } catch (err) {
    fail(res, err);
  }
});

// ---- Connections: the keys accounting-software connectors use to send invoices --------------

router.get('/connections', requireAuth, requireRole('ADMIN'), async (req, res) => {
  try {
    res.json(await connectorStore.list());
  } catch (err) {
    fail(res, err, 500);
  }
});

// The response includes the key. It is shown once and cannot be read again.
router.post('/connections', requireAuth, requireRole('ADMIN'), async (req, res) => {
  try {
    res.status(201).json(await connectorStore.create(req.body || {}));
  } catch (err) {
    fail(res, err);
  }
});

// The QuickBooks Web Connector setup file for a QuickBooks Desktop connection. It holds no password.
router.get('/connections/:id/qwc', requireAuth, requireRole('ADMIN'), async (req, res) => {
  try {
    const connection = await connectorStore.get(req.params.id);
    if (!connection) return res.status(404).json({ error: 'Connection not found.' });
    if (connection.sourceType !== 'quickbooks-desktop') return res.status(400).json({ error: 'Only QuickBooks Desktop connections use a setup file.' });
    const base = process.env.PUBLIC_BASE_URL;
    if (!base || !/^(https:\/\/|http:\/\/localhost)/.test(base)) {
      return res.status(400).json({ error: 'Set PUBLIC_BASE_URL to this app\'s public https address (for example https://collector.example.com), then download again. QuickBooks Web Connector only accepts https.' });
    }
    const file = connection.name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'connection';
    res.set({ 'Content-Type': 'application/xml', 'Content-Disposition': `attachment; filename="nrs-si-collector-${file}.qwc"` }).send(qwcFor(connection, base));
  } catch (err) {
    fail(res, err, 500);
  }
});

router.patch('/connections/:id', requireAuth, requireRole('ADMIN'), async (req, res) => {
  try {
    res.json(await connectorStore.update(req.params.id, req.body || {}));
  } catch (err) {
    fail(res, err);
  }
});

// ---- Intake: how connectors send invoices ---------------------------------------------------
//
//   POST /api/ingest        header  X-Connector-Key: sik_...
//   body: one invoice, or { "invoices": [ ... ] }, in the shape the connection's source type expects.
//   Answers one result per invoice. Sending the same invoice again never makes a second one.

async function requireConnection(req, res, next) {
  const connection = await connectorStore.authenticate(req.get('x-connector-key'));
  if (!connection) return res.status(401).json({ error: 'Missing, wrong or switched-off connector key.' });
  req.connection = connection;
  next();
}

router.post('/ingest', requireConnection, async (req, res) => {
  const body = req.body;
  const list = Array.isArray(body?.invoices) ? body.invoices : [body];
  if (list.length > 200) return res.status(413).json({ error: 'Send at most 200 invoices at a time.' });

  const { id: connectionId, sourceType, businessId } = req.connection;
  const results = [];
  for (const [index, item] of list.entries()) {
    try {
      const { raw, sourceRef } = normalize(req.connection, item);
      const inv = await processInvoice(raw, sourceType, { sourceRef: `${connectionId}:${sourceRef}`, businessId });
      results.push({ index, ok: true, id: inv.id, status: inv.status, duplicate: Boolean(inv.duplicate), irn: inv.irn || null, errors: inv.errors || null });
    } catch (err) {
      results.push({ index, ok: false, error: err.message });
    }
  }
  if (results.some((r) => r.ok && !r.duplicate)) await connectorStore.touchInvoice(connectionId).catch(() => {});
  res.status(results.every((r) => r.ok) ? 200 : 207).json({ results });
});

// Administrative Services (sign-in and users): see src/auth/authRoutes.js
router.use('/auth', require('../auth/authRoutes'));

module.exports = router;
