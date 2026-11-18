const crypto = require('crypto');
const prisma = require('../db/prismaClient');

/**
 * Hashes a raw API key with SHA-256, same algorithm used at creation time.
 * Returns a Buffer so we can use crypto.timingSafeEqual().
 */
const hashKeyBuffer = (key) =>
  crypto.createHash('sha256').update(String(key)).digest();

/**
 * Middleware: authenticates a request using the `X-API-Key` header.
 *
 * The key is a randomly generated string starting with `nak_` (NRS API Key).
 * Only its SHA-256 hash is stored in the database, so a database leak never
 * exposes working keys. The comparison uses crypto.timingSafeEqual() to
 * prevent timing-based attacks that could reveal whether a guessed prefix
 * is correct.
 *
 * On success:  sets req.business to the full Business row and calls next().
 * On failure:  returns 401 — identical message for missing / wrong key to
 *              avoid leaking whether the key prefix exists at all.
 *
 * Usage:
 *   router.post('/api/ingest/direct', requireApiKey, handler);
 */
async function requireApiKey(req, res, next) {
  const raw = req.get('x-api-key');

  // Fast reject: missing header or wrong prefix to avoid unnecessary DB lookups.
  if (!raw || typeof raw !== 'string' || !raw.startsWith('nak_')) {
    return res.status(401).json({ error: 'Missing or invalid API key.' });
  }

  const incomingHash = hashKeyBuffer(raw);

  // Look up by the first 8 characters (key prefix) to reduce the scan to at
  // most a handful of rows, then compare hashes with timingSafeEqual.
  const prefix = raw.slice(0, 8); // e.g. "nak_abcd"
  const candidates = await prisma.apiKey.findMany({
    where: { keyPrefix: prefix, active: true },
    include: {
      business: true,
    },
  });

  let matched = null;
  for (const candidate of candidates) {
    // Both buffers must be the same length for timingSafeEqual.
    const storedHash = Buffer.from(candidate.keyHash, 'hex');
    if (incomingHash.length === storedHash.length) {
      if (crypto.timingSafeEqual(incomingHash, storedHash)) {
        matched = candidate;
        break;
      }
    }
  }

  if (!matched || !matched.business || !matched.business.active) {
    return res.status(401).json({ error: 'Missing or invalid API key.' });
  }

  // Record usage timestamp asynchronously — do not block the request.
  prisma.apiKey
    .update({ where: { id: matched.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});

  // Attach the business to the request for downstream handlers.
  req.business = matched.business;
  req.apiKey = { id: matched.id, name: matched.name };
  return next();
}

module.exports = { requireApiKey };

