const prisma = require('./prismaClient');

// What every invoice read carries about its company, so the UI can show the name without a second request.
const businessSelect = { id: true, name: true, tin: true, nrsBusinessId: true, source: true };
const invoiceInclude = { history: true, business: { select: businessSelect } };

/** Same fields as the database row, with `history` as a plain array of { status, at }. */
function serialize(record) {
  if (!record) return null;
  const { history, ...rest } = record;
  return {
    ...rest,
    history: (history || [])
      .slice()
      .sort((a, b) => new Date(a.at) - new Date(b.at))
      .map((h) => ({ status: h.status, at: h.at.toISOString ? h.at.toISOString() : h.at })),
  };
}

async function create(record) {
  const { sourceSystem, raw, ...rest } = record;
  const createdAt = new Date();
  const full = await prisma.invoice.create({
    data: {
      status: 'RECEIVED',
      sourceSystem,
      raw,
      createdAt,
      ...rest,
      history: { create: [{ status: 'RECEIVED', at: createdAt }] },
    },
    include: invoiceInclude,
  });
  return serialize(full);
}

async function update(id, patch) {
  const existing = await prisma.invoice.findUnique({ where: { id } });
  if (!existing) return null;
  const historyWrite =
    patch.status && patch.status !== existing.status
      ? { history: { create: [{ status: patch.status, at: new Date() }] } }
      : undefined;
  const updated = await prisma.invoice.update({
    where: { id },
    data: { ...patch, ...historyWrite },
    include: invoiceInclude,
  });
  return serialize(updated);
}

async function get(id) {
  return serialize(await prisma.invoice.findUnique({ where: { id }, include: invoiceInclude }));
}

async function list() {
  const records = await prisma.invoice.findMany({ include: invoiceInclude, orderBy: { createdAt: 'desc' } });
  return records.map(serialize);
}

/** The invoice a source system already sent under this reference, if any. */
async function findBySourceRef(sourceSystem, sourceRef) {
  if (!sourceRef) return null;
  return serialize(await prisma.invoice.findUnique({
    where: { sourceSystem_sourceRef: { sourceSystem, sourceRef } },
    include: invoiceInclude,
  }));
}

/**
 * Another invoice already carrying this IRN, if any. Two invoice numbers such as INV-001 and
 * INV001 become the same IRN once punctuation is stripped; NRS would reject the second.
 */
async function findIrnClash(irn, exceptId) {
  return prisma.invoice.findFirst({ where: { irn, NOT: { id: exceptId } }, select: { id: true, status: true } });
}

module.exports = { create, update, get, list, findBySourceRef, findIrnClash };
