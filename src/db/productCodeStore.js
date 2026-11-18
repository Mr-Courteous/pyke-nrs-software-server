/**
 * HSN code + product category per item sold.
 *
 * NRS needs both on every invoice line, and QuickBooks has no field for
 * them. They are kept here, keyed by the source system and its item id
 * (the QuickBooks Item Id; for sources without ids, the item name).
 *
 * Items are added automatically the first time an invoice containing them is
 * received, with the codes blank. A person fills them in once on the Product
 * codes page; every later invoice for that item picks them up. Until then
 * invoices with an uncoded item stop at REJECTED with a message naming it.
 */
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

/** Stable lookup key for a line: the source's item id, else the item name. */
const keyOf = (item) => item.productRef || norm(item.productName || item.description);

function createProductCodeStore(getPrisma) {
  async function attach(mapped, sourceSystem) {
    const prisma = getPrisma();
    const source = sourceSystem || 'unknown';
    const items = mapped.lineItems?.items || [];
    if (!items.length) return mapped;

    const wanted = new Map();
    for (const it of items) {
      const k = keyOf(it);
      if (k && !wanted.has(k)) {
        wanted.set(k, {
          name: it.productName || it.description || k,
          hsnCode: it.hsnCode || null,
          productCategory: it.productCategory || null,
        });
      }
    }
    await prisma.productCode.createMany({
      data: [...wanted].map(([externalRef, info]) => ({
        source,
        externalRef,
        name: info.name,
        hsnCode: info.hsnCode,
        productCategory: info.productCategory,
      })),
      skipDuplicates: true,
    });
    const rows = await prisma.productCode.findMany({ where: { source, externalRef: { in: [...wanted.keys()] } } });
    const byKey = new Map(rows.map((r) => [r.externalRef, r]));
    for (const it of items) {
      const row = byKey.get(keyOf(it));
      it.hsnCode = row?.hsnCode || it.hsnCode || null;
      it.productCategory = row?.productCategory || it.productCategory || null;
    }
    return mapped;
  }

  const list = ({ needsCode } = {}) =>
    getPrisma().productCode.findMany({
      where: needsCode ? { OR: [{ hsnCode: null }, { productCategory: null }] } : undefined,
      orderBy: [{ updatedAt: 'desc' }],
    });

  async function update(id, { hsnCode, productCategory }) {
    const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    const data = {};
    if (hsnCode !== undefined) {
      data.hsnCode = clean(hsnCode);
      if (data.hsnCode && !/^\d{4}([.\d]{0,8})$/.test(data.hsnCode)) {
        throw Object.assign(new Error('An HSN code is digits, optionally with dots, for example 2523.29 or 0101.21.'), { status: 400 });
      }
    }
    if (productCategory !== undefined) data.productCategory = clean(productCategory);
    try {
      return await getPrisma().productCode.update({ where: { id }, data });
    } catch (err) {
      if (err.code === 'P2025') throw Object.assign(new Error('Product code not found.'), { status: 404 });
      throw err;
    }
  }

  return { attach, list, update };
}

module.exports = createProductCodeStore(() => require('./prismaClient'));
module.exports.createProductCodeStore = createProductCodeStore;
module.exports.keyOf = keyOf;
