const prisma = require('./prismaClient');
const { parseCryptoKeys, keyFingerprint } = require('../sign/signer');
const { linkFields, addressFields } = require('./businessRules');

/**
 * Companies invoices are issued for. Each is entered by hand with what NRS issued it
 * (Service ID, and Business ID for later) and its NRS cryptographic keys.
 */

const READY = 'READY';

function serialize(b) {
  if (!b) return null;
  // The public key and certificate are never sent to the browser; the UI
  // only learns whether keys exist and a short fingerprint to tell them apart.
  const { _count, invoices, publicKey, certificate, ...rest } = b;
  let keyFp = null;
  if (publicKey) { try { keyFp = keyFingerprint(publicKey); } catch { keyFp = 'unreadable'; } }
  return {
    ...rest,
    hasKeys: Boolean(publicKey && certificate),
    keyFingerprint: keyFp,
    hasServiceId: Boolean(rest.irnSuffix),
    invoiceCount: _count?.invoices ?? undefined,
    readyCount: invoices ? invoices.length : undefined,
  };
}

async function list() {
  const rows = await prisma.business.findMany({
    orderBy: { name: 'asc' },
    include: {
      _count: { select: { invoices: true } },
      invoices: { where: { status: READY }, select: { id: true } },
    },
  });
  return rows.map(serialize);
}

async function get(id) {
  return serialize(await prisma.business.findUnique({ where: { id } }));
}

/** Pipeline use only: includes publicKey and certificate. Never return this from an API route. */
async function getForSigning(id) {
  const b = await prisma.business.findUnique({ where: { id } });
  return b ? { ...serialize(b), publicKey: b.publicKey, certificate: b.certificate } : null;
}

const STRUCTURED = ['phone', 'city', 'postalZone', 'state', 'lga'];

/** cryptoKeys = the pasted crypto_keys.txt. Throws a 400 if it is not usable. */
function keysFrom(cryptoKeys) {
  if (cryptoKeys === undefined || cryptoKeys === null || cryptoKeys === '') return {};
  try {
    const { publicKey, certificate } = parseCryptoKeys(cryptoKeys);
    return { publicKey, certificate };
  } catch (err) {
    throw Object.assign(new Error(err.message), { status: 400 });
  }
}

function uniqueToFriendly(err) {
  if (err.code === 'P2002') throw Object.assign(new Error('Another company already uses this NRS Business ID.'), { status: 409 });
  throw err;
}

function clean(v) {
  const t = typeof v === 'string' ? v.trim() : v;
  return t === '' || t === undefined ? null : t;
}

async function createLocal({ name, tin, address, email, cryptoKeys, ...rest }) {
  const trimmed = (name || '').trim();
  if (!trimmed) throw Object.assign(new Error('Company name is required.'), { status: 400 });
  return serialize(
    await prisma.business.create({
      data: {
        name: trimmed, tin: clean(tin), address: clean(address), email: clean(email), source: 'LOCAL',
        ...Object.fromEntries(STRUCTURED.map((f) => [f, clean(rest[f])])),
        ...addressFields(rest),
        ...linkFields(rest, null),
        ...keysFrom(cryptoKeys),
      },
    }).catch(uniqueToFriendly)
  );
}

async function update(id, { name, tin, address, email, active, cryptoKeys, ...rest }) {
  const existing = await prisma.business.findUnique({ where: { id } });
  if (!existing) throw Object.assign(new Error('Company not found.'), { status: 404 });
  const data = {};
  if (name !== undefined) {
    const trimmed = String(name).trim();
    if (!trimmed) throw Object.assign(new Error('Company name cannot be empty.'), { status: 400 });
    data.name = trimmed;
  }
  if (tin !== undefined) data.tin = clean(tin);
  if (address !== undefined) data.address = clean(address);
  if (email !== undefined) data.email = clean(email);
  if (active !== undefined) data.active = Boolean(active);
  for (const f of STRUCTURED) if (rest[f] !== undefined) data[f] = clean(rest[f]);
  Object.assign(data, addressFields(rest), linkFields(rest, existing), keysFrom(cryptoKeys));
  return serialize(await prisma.business.update({ where: { id }, data }).catch(uniqueToFriendly));
}

module.exports = { list, get, getForSigning, createLocal, update };
