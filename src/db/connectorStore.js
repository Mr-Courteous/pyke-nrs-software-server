const crypto = require('crypto');

/**
 * Source connections: one per accounting-software installation that sends invoices here.
 * Each has a secret key, shown ONCE when it is created. Only its SHA-256 hash is stored,
 * so a database leak does not leak working keys (the keys are long random values, so a
 * plain hash is enough).
 */

const SOURCE_TYPES = ['quickbooks-desktop', 'sage300', 'sage200', 'canonical'];

const hashKey = (key) => crypto.createHash('sha256').update(String(key)).digest('hex');
const bad = (message, status = 400) => Object.assign(new Error(message), { status });

function publicView(c) {
  if (!c) return null;
  const { keyHash, ...rest } = c; // the hash never leaves the server
  return rest;
}

function createConnectorStore(getPrisma) {
  async function create({ name, sourceType, businessId, fieldMap, syncFrom }) {
    const prisma = getPrisma();
    const trimmed = String(name || '').trim();
    if (!trimmed) throw bad('Give the connection a name, for example "Sage 300 head office".');
    if (!SOURCE_TYPES.includes(sourceType)) throw bad(`Source type must be one of: ${SOURCE_TYPES.join(', ')}.`);
    if (businessId) {
      const b = await prisma.business.findUnique({ where: { id: businessId } });
      if (!b) throw bad('Company not found.', 404);
    }
    if (fieldMap !== undefined && fieldMap !== null && (typeof fieldMap !== 'object' || Array.isArray(fieldMap))) {
      throw bad('The field map must be a JSON object.');
    }
    if (syncFrom && !/^\d{4}-\d{2}-\d{2}$/.test(String(syncFrom))) throw bad('"Collect invoices from" must be a date like 2026-11-01.');
    // QuickBooks Desktop: only invoices changed since this moment are fetched (default: now), so old history is never swept in.
    const syncCursor = sourceType === 'quickbooks-desktop'
      ? (syncFrom ? `${syncFrom}T00:00:00` : new Date().toISOString().slice(0, 19))
      : null;
    const key = `sik_${crypto.randomBytes(32).toString('base64url')}`;
    const row = await prisma.sourceConnection.create({
      data: {
        name: trimmed, sourceType, businessId: businessId || null, fieldMap: fieldMap ?? undefined,
        keyPrefix: key.slice(0, 8), keyHash: hashKey(key), syncCursor,
      },
    });
    return { ...publicView(row), key }; // the only time the key is returned
  }

  async function list() {
    const prisma = getPrisma();
    const rows = await prisma.sourceConnection.findMany({
      orderBy: { createdAt: 'desc' },
      include: { business: { select: { id: true, name: true } } },
    });
    return rows.map(publicView);
  }

  async function update(id, { name, active, businessId, fieldMap }) {
    const prisma = getPrisma();
    const existing = await prisma.sourceConnection.findUnique({ where: { id } });
    if (!existing) throw bad('Connection not found.', 404);
    const data = {};
    if (name !== undefined) {
      const t = String(name).trim();
      if (!t) throw bad('The name cannot be empty.');
      data.name = t;
    }
    if (active !== undefined) data.active = Boolean(active);
    if (businessId !== undefined) {
      if (businessId) {
        const b = await prisma.business.findUnique({ where: { id: businessId } });
        if (!b) throw bad('Company not found.', 404);
      }
      data.businessId = businessId || null;
    }
    if (fieldMap !== undefined) {
      if (fieldMap !== null && (typeof fieldMap !== 'object' || Array.isArray(fieldMap))) throw bad('The field map must be a JSON object.');
      data.fieldMap = fieldMap === null ? null : fieldMap;
    }
    return publicView(await prisma.sourceConnection.update({ where: { id }, data }));
  }

  /** The active connection a key belongs to, or null. Records that it was used. */
  async function authenticate(key) {
    if (!key || typeof key !== 'string' || !key.startsWith('sik_')) return null;
    const prisma = getPrisma();
    const row = await prisma.sourceConnection.findUnique({ where: { keyHash: hashKey(key) } });
    if (!row || !row.active) return null;
    await prisma.sourceConnection.update({ where: { id: row.id }, data: { lastSeenAt: new Date() } });
    return publicView(row);
  }

  async function get(id) {
    return publicView(await getPrisma().sourceConnection.findUnique({ where: { id } }));
  }

  /** The QuickBooks Web Connector signs in with a user name (the connection's id) and a password (its key). */
  async function authenticateForUser(username, key) {
    const connection = await authenticate(key);
    return connection && connection.id === String(username || '') ? connection : null;
  }

  async function setCursor(id, syncCursor) {
    await getPrisma().sourceConnection.update({ where: { id }, data: { syncCursor } });
  }

  async function touchInvoice(id) {
    await getPrisma().sourceConnection.update({ where: { id }, data: { lastInvoiceAt: new Date() } });
  }

  return { create, list, get, update, authenticate, authenticateForUser, setCursor, touchInvoice };
}

module.exports = { ...createConnectorStore(() => require('./prismaClient')), createConnectorStore, SOURCE_TYPES, hashKey };
