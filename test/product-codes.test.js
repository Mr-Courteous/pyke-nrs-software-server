const test = require('node:test');
const assert = require('node:assert/strict');
const { createProductCodeStore, keyOf } = require('../src/db/productCodeStore');

function fakePrisma() {
  const rows = [];
  return { rows, productCode: {
    async createMany({ data }) { for (const d of data) if (!rows.some((r) => r.source === d.source && r.externalRef === d.externalRef)) rows.push({ id: `p${rows.length + 1}`, hsnCode: null, productCategory: null, ...d }); },
    async findMany({ where }) { return rows.filter((r) => (!where?.source || r.source === where.source) && (!where?.externalRef || where.externalRef.in.includes(r.externalRef))); },
    async update({ where, data }) { const r = rows.find((x) => x.id === where.id); if (!r) throw Object.assign(new Error('x'), { code: 'P2025' }); Object.assign(r, data); return r; },
  } };
}

test('items are keyed by source item id, else by normalised name', () => {
  assert.equal(keyOf({ productRef: '7', productName: 'Cement' }), '7');
  assert.equal(keyOf({ productName: '  Cement   50KG ' }), 'cement 50kg');
});

test('new items are added blank once, and codes are attached when present', async () => {
  const prisma = fakePrisma(); const s = createProductCodeStore(() => prisma);
  const m = { lineItems: { items: [{ productRef: '7', productName: 'Cement' }, { productRef: '7', productName: 'Cement' }, { productName: 'Haulage' }] } };
  await s.attach(m, 'qbo');
  assert.equal(prisma.rows.length, 2);
  assert.equal(m.lineItems.items[0].hsnCode, null);

  await s.update('p1', { hsnCode: '2523.29', productCategory: 'Cements' });
  const m2 = { lineItems: { items: [{ productRef: '7', productName: 'Cement' }] } };
  await s.attach(m2, 'qbo');
  assert.equal(m2.lineItems.items[0].hsnCode, '2523.29');
  assert.equal(prisma.rows.length, 2, 'no duplicates');
});

test('another source system does not borrow these codes', async () => {
  const prisma = fakePrisma(); const s = createProductCodeStore(() => prisma);
  await s.attach({ lineItems: { items: [{ productRef: '7', productName: 'Cement' }] } }, 'qbo');
  await s.update('p1', { hsnCode: '2523.29', productCategory: 'Cements' });
  const other = { lineItems: { items: [{ productRef: '7', productName: 'Something else' }] } };
  await s.attach(other, 'sage');
  assert.equal(other.lineItems.items[0].hsnCode, null);
});

test('HSN codes are checked for shape; unknown ids give 404', async () => {
  const s = createProductCodeStore(() => fakePrisma());
  await assert.rejects(() => s.update('p1', { hsnCode: 'abc' }), (e) => e.status === 400);
  await assert.rejects(() => s.update('missing', { hsnCode: '2523.29' }), (e) => e.status === 404);
});
