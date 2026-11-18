const express = require('express');
const crypto = require('crypto');
const { processInvoice, retryInvoice, assignBusiness } = require('../pipeline');
const store = require('../db/store');
const businessStore = require('../db/businessStore');
const productCodeStore = require('../db/productCodeStore');
const customerDetailStore = require('../db/customerDetailStore');
const connectorStore = require('../db/connectorStore');
const apiKeyStore = require('../db/apiKeyStore');
const { normalize } = require('../ingestion');
const { qwcFor } = require('../ingestion/qbwc/router');
const { requireAuth, requireRole } = require('../auth/authMiddleware');
const { requireApiKey } = require('../auth/apiKeyMiddleware');

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

// ---- API Keys: direct REST ingestion keys linked to a company ---------------
//
//   GET    /api/businesses/:id/api-keys           list keys (hashes never shown)
//   POST   /api/businesses/:id/api-keys           generate a new key (plain text shown ONCE)
//   POST   /api/businesses/:id/api-keys/:kid/rotate  replace a key (old one stops immediately)
//   PATCH  /api/businesses/:id/api-keys/:kid/revoke  deactivate without deleting
//   DELETE /api/businesses/:id/api-keys/:kid      hard-delete

router.get('/businesses/:id/api-keys', requireAuth, requireRole('ADMIN'), async (req, res) => {
  try {
    res.json(await apiKeyStore.list(req.params.id));
  } catch (err) {
    fail(res, err, 500);
  }
});

/**
 * Generate a new API key for a business.
 * Optional body: { name: "My integration" }
 * Response includes `key` (plain text) exactly once — copy it immediately.
 */
router.post('/businesses/:id/api-keys', requireAuth, requireRole('ADMIN'), async (req, res) => {
  try {
    const { name } = req.body || {};
    res.status(201).json(await apiKeyStore.create(req.params.id, { name }));
  } catch (err) {
    fail(res, err);
  }
});

/**
 * Rotate an existing key.
 * Generates a fresh key; the old one stops working immediately.
 * Response includes `key` (plain text) exactly once.
 */
router.post('/businesses/:id/api-keys/:kid/rotate', requireAuth, requireRole('ADMIN'), async (req, res) => {
  try {
    res.json(await apiKeyStore.rotate(req.params.kid, req.params.id));
  } catch (err) {
    fail(res, err);
  }
});

/** Revoke (deactivate) a key — it becomes invalid but stays in the audit trail. */
router.patch('/businesses/:id/api-keys/:kid/revoke', requireAuth, requireRole('ADMIN'), async (req, res) => {
  try {
    res.json(await apiKeyStore.revoke(req.params.kid, req.params.id));
  } catch (err) {
    fail(res, err);
  }
});

/** Hard-delete a key. */
router.delete('/businesses/:id/api-keys/:kid', requireAuth, requireRole('ADMIN'), async (req, res) => {
  try {
    await apiKeyStore.remove(req.params.kid, req.params.id);
    res.status(204).end();
  } catch (err) {
    fail(res, err);
  }
});

// ---- Direct REST ingestion: for businesses with API keys --------------------
//
//   POST /api/ingest/direct   header  X-API-Key: nak_...
//   body: one invoice in canonical shape, or { "invoices": [ ... ] } (batch).
//   Invoices are deduplicated by  <businessId>:<apiKeyId>:<invoiceNumber>.
//   Returns the same result shape as POST /api/ingest.

router.post('/ingest/direct', requireApiKey, async (req, res) => {
  const body = req.body;
  const list = Array.isArray(body?.invoices) ? body.invoices : [body];
  if (list.length > 200) {
    return res.status(413).json({ error: 'Send at most 200 invoices at a time.' });
  }

  const { id: businessId } = req.business;
  const { id: apiKeyId } = req.apiKey;

  // Canonical format: invoices arrive in the standard internal shape, so we
  // use a synthetic "connection" object that tells normalize() to treat them
  // as already canonical (sourceType = 'canonical').
  const syntheticConnection = {
    id: `api:${apiKeyId}`,
    sourceType: 'canonical',
    businessId,
  };

  const results = [];
  for (const [index, item] of list.entries()) {
    try {
      const { raw, sourceRef } = normalize(syntheticConnection, item);
      // Namespace the deduplication key so two different businesses (or keys)
      // can send the same invoice number without collision.
      const namespacedRef = `direct:${businessId}:${apiKeyId}:${sourceRef}`;
      const inv = await processInvoice(raw, 'canonical', {
        sourceRef: namespacedRef,
        businessId,
      });
      results.push({
        index,
        ok: true,
        id: inv.id,
        status: inv.status,
        duplicate: Boolean(inv.duplicate),
        irn: inv.irn || null,
        errors: inv.errors || null,
      });
    } catch (err) {
      results.push({ index, ok: false, error: err.message });
    }
  }

  res.status(results.every((r) => r.ok) ? 200 : 207).json({ results });
});

// ---- Direct Invoice Ingestion: Single Invoice REST Endpoint ------------------
//
//   POST /api/invoices/ingest
//   POST /api/v1/invoices
//   Header: X-API-Key: nak_...
//   Body: raw JSON invoice payload representing B2B/B2G or B2C transaction.
//   Strictly bound to authenticated req.business.id.
//   Returns 201 Created with status, generated IRN, digital signature, confirmation timestamp.

router.post(['/invoices/ingest', '/v1/invoices'], requireApiKey, async (req, res) => {
  try {
    const raw = req.body?.invoice || req.body;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length === 0) {
      return res.status(400).json({ error: 'Invoice payload is required as a JSON object.' });
    }

    const { id: businessId } = req.business;
    const { id: apiKeyId } = req.apiKey;

    const invoiceNumber = raw.invoiceNumber || raw.invoiceId;
    const clientRef = raw.sourceRef || invoiceNumber || crypto.randomUUID();
    const sourceRef = `direct:${businessId}:${apiKeyId}:${clientRef}`;

    const inv = await processInvoice(raw, 'canonical', {
      sourceRef,
      businessId,
    });

    if (inv.status === 'REJECTED' || inv.status === 'ERROR') {
      return res.status(400).json({
        error: 'Invoice validation or processing failed.',
        id: inv.id,
        status: inv.status,
        errors: inv.errors || (inv.errorMessage ? [inv.errorMessage] : []),
        confirmationTimestamp: new Date().toISOString(),
      });
    }

    return res.status(201).json({
      id: inv.id,
      status: inv.status,
      irn: inv.irn,
      signature: inv.signature,
      qr: inv.qr || null,
      confirmationTimestamp: new Date().toISOString(),
      duplicate: Boolean(inv.duplicate),
      invoice: inv,
    });
  } catch (err) {
    fail(res, err, 500);
  }
});

module.exports = router;
