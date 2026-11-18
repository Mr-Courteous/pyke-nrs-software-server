const crypto = require('crypto');
const prisma = require('./prismaClient');

/**
 * API keys for direct REST invoice ingestion.
 * Each key is linked to a Business and is shown ONCE when created;
 * only the SHA-256 hex-digest is stored, so a database leak is not useful.
 *
 * Key format:  nak_<43-char base64url random>
 * Example:     nak_oKjARMTkngXUdeHo0G3c8nZ18P96Dr0a_H7oFTT
 */

const PREFIX = 'nak_';
const KEY_BYTES = 32; // 256 random bits → 43-char base64url string

const hashKey = (key) => crypto.createHash('sha256').update(String(key)).digest('hex');

function generateRaw() {
  return PREFIX + crypto.randomBytes(KEY_BYTES).toString('base64url');
}

/** Strips sensitive fields before returning to callers. */
function publicView(row) {
  if (!row) return null;
  const { keyHash, ...rest } = row;
  void keyHash; // never leak the hash
  return rest;
}

/**
 * Generate a new API key for a business.
 * Returns the full key (plain text) exactly once inside the `key` property.
 * Subsequent calls to `list` will never include it.
 *
 * @param {string} businessId
 * @param {{ name?: string }} options
 */
async function create(businessId, { name = 'Default' } = {}) {
  const business = await prisma.business.findUnique({ where: { id: businessId } });
  if (!business) throw Object.assign(new Error('Company not found.'), { status: 404 });

  const key = generateRaw();
  const keyPrefix = key.slice(0, 8); // "nak_abcd"
  const row = await prisma.apiKey.create({
    data: {
      name: String(name).trim() || 'Default',
      keyPrefix,
      keyHash: hashKey(key),
      businessId,
    },
  });
  // key is returned only here — it is not persisted anywhere
  return { ...publicView(row), key };
}

/** List all API keys for a business (hashes are stripped). */
async function list(businessId) {
  const rows = await prisma.apiKey.findMany({
    where: { businessId },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(publicView);
}

/**
 * Rotate (replace) a specific key by ID.
 * Generates a fresh key, updates the stored hash and prefix, and returns the
 * new plain-text key once.  The old key stops working immediately.
 */
async function rotate(id, businessId) {
  const existing = await prisma.apiKey.findUnique({ where: { id } });
  if (!existing) throw Object.assign(new Error('API key not found.'), { status: 404 });
  if (existing.businessId !== businessId) throw Object.assign(new Error('API key not found.'), { status: 404 });

  const key = generateRaw();
  const row = await prisma.apiKey.update({
    where: { id },
    data: {
      keyPrefix: key.slice(0, 8),
      keyHash: hashKey(key),
    },
  });
  return { ...publicView(row), key };
}

/** Revoke (deactivate) a specific key without deleting it (preserves audit trail). */
async function revoke(id, businessId) {
  const existing = await prisma.apiKey.findUnique({ where: { id } });
  if (!existing) throw Object.assign(new Error('API key not found.'), { status: 404 });
  if (existing.businessId !== businessId) throw Object.assign(new Error('API key not found.'), { status: 404 });

  const row = await prisma.apiKey.update({ where: { id }, data: { active: false } });
  return publicView(row);
}

/** Hard-delete a key. */
async function remove(id, businessId) {
  const existing = await prisma.apiKey.findUnique({ where: { id } });
  if (!existing) throw Object.assign(new Error('API key not found.'), { status: 404 });
  if (existing.businessId !== businessId) throw Object.assign(new Error('API key not found.'), { status: 404 });

  await prisma.apiKey.delete({ where: { id } });
}

module.exports = { create, list, rotate, revoke, remove };
