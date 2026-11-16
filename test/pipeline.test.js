const test = require('node:test');
const assert = require('node:assert/strict');
const { records, businesses, table, keys, company, invoice, fillCodes } = require('./fakes');
const { decryptPkcs1 } = require('./helpers');
const pipeline = require('../src/pipeline');

const SOURCE = 'manual-upload';
let first;

test('1. an invoice with items that have no product codes stops with a message naming them', async () => {
  first = await pipeline.processInvoice(invoice(), SOURCE);
  assert.equal(first.status, 'REJECTED');
  assert.match(first.errors.join(' '), /Cement 50kg, Delivery/);
  assert.equal(table.length, 2, 'both items were added to the Product codes list, blank');
  assert.equal(table.every((r) => r.hsnCode === null), true);
});

test('2. after the codes are filled in, retry validates it; with no company there is no IRN yet', async () => {
  fillCodes();
  const r = await pipeline.retryInvoice(first.id);
  assert.equal(r.status, 'VALIDATED', JSON.stringify(r.errors));
  assert.equal(r.irn, null);
  assert.equal(r.qr, null);
});

test('3. assigning a company builds the IRN from the issue date, signs it and makes the QR', async () => {
  const r = await pipeline.assignBusiness(first.id, 'biz1');
  assert.equal(r.status, 'READY', JSON.stringify(r.errors));
  assert.equal(r.irn, 'INV0042-94ND90NR-20261028');
  assert.match(r.signature.method, /^NRS MBS IRN signing/);
  assert.equal(r.signature.signedMessage, `${r.irn}.${r.signature.timestamp}`);
  assert.ok(Math.abs(r.signature.timestamp - Date.now() / 1000) < 30);
  assert.match(r.qr.dataUrl, /^data:image\/png;base64,/);
  // the QR holds only the encrypted string; NRS's private key reads IRN.timestamp + certificate from it
  assert.deepEqual(JSON.parse(decryptPkcs1(keys.privateKey, r.qr.payload)), { irn: r.signature.signedMessage, certificate: keys.certificate });
  assert.equal(r.mapped.supplier.name, 'Acme Supplies Ltd', 'the company replaces the source supplier');
  assert.equal(r.mapped.supplier.city, 'Ikeja');
});

test('4. the same company again rebuilds from current details: same IRN, a new signature and QR', async () => {
  const before = await pipeline.assignBusiness(first.id, 'biz1');
  businesses.set('biz1', company({ city: 'Lagos' }));
  const after = await pipeline.assignBusiness(first.id, 'biz1');
  assert.equal(after.irn, before.irn, 'the IRN never changes for the same invoice');
  assert.notEqual(after.qr.payload, before.qr.payload, 'RSA padding and a new timestamp make a new QR');
  assert.equal(after.mapped.supplier.city, 'Lagos', 'an edit to the company reached the invoice');
  businesses.set('biz1', company());
});

test('5. clearing the company removes the IRN, signature and QR', async () => {
  const r = await pipeline.assignBusiness(first.id, null);
  assert.equal(r.status, 'VALIDATED');
  assert.deepEqual([r.irn, r.qr, r.signature], [null, null, null]);
  await pipeline.assignBusiness(first.id, 'biz1');
});

test('6. a company without NRS keys cannot sign, and says so; adding keys and retrying works', async () => {
  businesses.set('nokeys', company({ id: 'nokeys', name: 'No Keys Ltd', publicKey: null, certificate: null }));
  const inv = await pipeline.processInvoice(invoice({ invoiceNumber: 'KEY-1', buyer: { ...invoice().buyer } }), SOURCE, { businessId: 'nokeys' });
  assert.equal(inv.status, 'REJECTED');
  assert.match(inv.errors.join(' '), /No Keys Ltd has no NRS cryptographic keys/);
  businesses.set('nokeys', company({ id: 'nokeys', name: 'No Keys Ltd' }));
  const fixed = await pipeline.retryInvoice(inv.id);
  assert.equal(fixed.status, 'READY');
});

test('7. a company with no Service ID or TIN is refused with exactly what is missing', async () => {
  businesses.set('new', company({ id: 'new', name: 'New Co', irnSuffix: null, hasServiceId: false, tin: null }));
  const inv = await pipeline.processInvoice(invoice({ invoiceNumber: 'NEW-1' }), SOURCE, { businessId: 'new' });
  assert.equal(inv.status, 'REJECTED');
  assert.match(inv.errors.join(' '), /New Co is missing its TIN and its NRS Service ID/);
});

test('8. two invoice numbers that become the same IRN are caught', async () => {
  const a = await pipeline.processInvoice(invoice({ invoiceNumber: 'AB-77' }), SOURCE, { businessId: 'biz1' });
  assert.equal(a.status, 'READY');
  const b = await pipeline.processInvoice(invoice({ invoiceNumber: 'AB77' }), SOURCE, { businessId: 'biz1' });
  assert.equal(b.status, 'REJECTED');
  assert.match(b.errors.join(' '), /Another invoice already uses the IRN AB77-94ND90NR-20261028/);
});

test('9. an invoice that arrives with a company (set by its connection) is READY straight away', async () => {
  // product codes belong to the connection: this client's Sage 300 items have their own entries
  for (const [ref, name] of [['I1', 'Cement 50kg'], ['I2', 'Delivery']]) {
    table.push({ id: `s3-${ref}`, source: 'conn:conn1', externalRef: ref, name, hsnCode: '2523.29', productCategory: 'Cements' });
  }
  const r = await pipeline.processInvoice(invoice({ invoiceNumber: 'AUTO-1' }), 'sage300', { sourceRef: 'conn1:900', businessId: 'biz1' });
  assert.equal(r.status, 'READY');
  assert.equal(r.irn, 'AUTO1-94ND90NR-20261028');
});

test('10. the same source reference sent again is not stored twice', async () => {
  const count = records.size;
  const again = await pipeline.processInvoice(invoice({ invoiceNumber: 'AUTO-1' }), 'sage300', { sourceRef: 'conn1:900', businessId: 'biz1' });
  assert.equal(again.duplicate, true);
  assert.equal(records.size, count);
  // a hand-entered invoice is matched on its invoice number
  const m1 = await pipeline.processInvoice(invoice({ invoiceNumber: 'HAND-1' }), SOURCE);
  const m2 = await pipeline.processInvoice(invoice({ invoiceNumber: 'HAND-1' }), SOURCE);
  assert.equal(m2.duplicate, true);
  assert.equal(m2.id, m1.id);
});

test('11. missing invoice number or date is rejected, never invented', async () => {
  const r = await pipeline.processInvoice(invoice({ invoiceNumber: '', issueDate: '' }), SOURCE);
  assert.equal(r.status, 'REJECTED');
  assert.match(r.errors.join(' '), /invoiceNumber/);
  assert.match(r.errors.join(' '), /issueDate/);
});

test('12. nothing in this app can send an invoice anywhere', () => {
  assert.deepEqual(Object.keys(pipeline).sort(), ['assignBusiness', 'processInvoice', 'retryInvoice']);
});
