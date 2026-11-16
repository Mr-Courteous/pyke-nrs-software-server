const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const { records, table, customers, company, businesses } = require('./fakes');
const { createConnectorStore, hashKey } = require('../src/db/connectorStore');
const { fromInvoiceRet } = require('../src/ingestion/normalizers/quickbooksDesktop');
const { fromFieldMap } = require('../src/ingestion/normalizers/fieldMap');
const { normalize } = require('../src/ingestion');

// ---- connections: keys are shown once and only their hash is kept ---------------------------
const connRows = [];
const fakePrisma = {
  business: { async findUnique({ where }) { return businesses.get(where.id) || null; } },
  sourceConnection: {
    async create({ data }) { const r = { id: `c${connRows.length + 1}`, active: true, lastSeenAt: null, lastInvoiceAt: null, createdAt: new Date(), fieldMap: null, ...data }; connRows.push(r); return r; },
    async findUnique({ where }) { return connRows.find((r) => (where.id ? r.id === where.id : r.keyHash === where.keyHash)) || null; },
    async findMany() { return connRows; },
    async update({ where, data }) { const r = connRows.find((x) => x.id === where.id); Object.assign(r, data); return r; },
  },
};
const connectors = createConnectorStore(() => fakePrisma);

test('a connection key is returned once and only its hash is stored', async () => {
  const c = await connectors.create({ name: 'Sage 300 head office', sourceType: 'sage300', businessId: 'biz1' });
  assert.match(c.key, /^sik_[A-Za-z0-9_-]{40,}$/);
  assert.equal(c.keyHash, undefined, 'the hash is not returned either');
  const stored = connRows.find((r) => r.id === c.id);
  assert.equal(stored.keyHash, hashKey(c.key));
  assert.equal(JSON.stringify(stored).includes(c.key), false, 'the key itself is nowhere in what is stored');
  assert.equal((await connectors.list())[0].keyHash, undefined, 'the list never shows hashes');
});

test('only an active connection\'s own key gets in', async () => {
  const c = await connectors.create({ name: 'QB desktop', sourceType: 'quickbooks-desktop' });
  assert.equal((await connectors.authenticate(c.key)).id, c.id);
  assert.equal(await connectors.authenticate(c.key + 'x'), null);
  assert.equal(await connectors.authenticate(undefined), null);
  assert.equal(await connectors.authenticate('not-a-key'), null);
  await connectors.update(c.id, { active: false });
  assert.equal(await connectors.authenticate(c.key), null, 'switched-off keys stop working');
});

test('bad connection settings are refused', async () => {
  await assert.rejects(() => connectors.create({ name: '', sourceType: 'sage300' }), /name/);
  await assert.rejects(() => connectors.create({ name: 'x', sourceType: 'oracle' }), /Source type/);
  await assert.rejects(() => connectors.create({ name: 'x', sourceType: 'sage300', businessId: 'nope' }), /Company not found/);
  await assert.rejects(() => connectors.create({ name: 'x', sourceType: 'sage300', fieldMap: [] }), /JSON object/);
});

// ---- reading each system's invoices ----------------------------------------------------------
const invoiceRet = () => ({
  TxnID: '8000A-1700000000', TxnDate: '2026-10-28', RefNumber: 'QB-1001', DueDate: '2026-11-27',
  CustomerRef: { ListID: '80000001-1', FullName: 'Buyer Ltd' },
  BillAddress: { Addr1: 'Buyer Ltd', Addr2: '1 Buyer Street', City: 'Ikeja', State: 'Lagos', PostalCode: '100271', Country: 'Nigeria' },
  SalesTaxPercentage: '7.5', SalesTaxTotal: '412.50',
  InvoiceLineRet: [
    { TxnLineID: 'L1', ItemRef: { ListID: '80000010-1', FullName: 'Cement 50kg' }, Desc: 'Cement, 50kg bag', Quantity: '1', Rate: '5500.00', Amount: '5500.00' },
  ],
});

test('QuickBooks Desktop: an InvoiceRet becomes the standard shape, with the tax QuickBooks reported', () => {
  const { raw, sourceRef } = fromInvoiceRet(invoiceRet());
  assert.equal(sourceRef, '8000A-1700000000');
  assert.equal(raw.invoiceNumber, 'QB-1001');
  assert.equal(raw.issueDate, '2026-10-28');
  assert.equal(raw.buyer.ref, '80000001-1');
  assert.equal(raw.buyer.street, '1 Buyer Street', 'the customer name QuickBooks repeats on Addr1 is not part of the street');
  assert.equal(raw.buyer.city, 'Ikeja');
  assert.deepEqual(raw.items, [{ description: 'Cement, 50kg bag', productName: 'Cement 50kg', productRef: '80000010-1', quantity: 1, unitPrice: 5500, lineTotal: 5500, unit: undefined }]);
  assert.deepEqual(raw.taxLines, [{ taxable: 5500, tax: 412.5, percent: 7.5 }]);
});

test('QuickBooks Desktop: one line arriving as a single object, and no tax information, are both handled', () => {
  const inv = invoiceRet();
  delete inv.SalesTaxTotal; delete inv.SalesTaxPercentage;
  const { raw } = fromInvoiceRet(inv);
  assert.equal(raw.items.length, 1);
  assert.equal(raw.taxLines, undefined, 'unknown tax is left unknown, so the mapper warns instead of inventing a rate');
  assert.throws(() => fromInvoiceRet({ RefNumber: '1' }), /no TxnID/);
});

const sage = () => ({
  InvoiceUniquifier: 'U-55', DocumentNumber: 'SI-5001', InvoiceDate: '2026-10-28T00:00:00Z', CurrencyCode: 'NGN',
  CustomerNumber: 'C-100', CustomerName: 'Buyer Ltd', CustomerTin: '98765432-0001', CustomerEmail: 'buyer@example.com',
  BillTo: { Street: '1 Buyer Street', City: 'Ikeja', State: 'Lagos', Zip: '100271' },
  TaxRate: 7.5, TaxTotal: 412.5,
  Details: [{ ItemNumber: 'I1', ItemDescription: 'Cement 50kg', Qty: 1, Price: 5500, NetAmount: 5500 }],
});
const sageMap = {
  sourceRef: 'InvoiceUniquifier', invoiceNumber: 'DocumentNumber', issueDate: 'InvoiceDate', currency: 'CurrencyCode',
  buyer: { ref: 'CustomerNumber', name: 'CustomerName', tin: 'CustomerTin', email: 'CustomerEmail', street: 'BillTo.Street', city: 'BillTo.City', state: 'BillTo.State', postalZone: 'BillTo.Zip' },
  itemsPath: 'Details', item: { description: 'ItemDescription', productRef: 'ItemNumber', quantity: 'Qty', unitPrice: 'Price', lineTotal: 'NetAmount' },
  tax: { ratePath: 'TaxRate', totalPath: 'TaxTotal' },
};

test('Sage: a field map reads the system\'s own invoice JSON, and a missing path is left empty, not invented', () => {
  const { raw, sourceRef } = fromFieldMap(sage(), sageMap);
  assert.equal(sourceRef, 'U-55');
  assert.equal(raw.invoiceNumber, 'SI-5001');
  assert.equal(raw.buyer.tin, '98765432-0001');
  assert.equal(raw.buyer.city, 'Ikeja');
  assert.deepEqual(raw.items, [{ description: 'Cement 50kg', productRef: 'I1', quantity: 1, unitPrice: 5500, lineTotal: 5500 }]);
  assert.deepEqual(raw.taxLines, [{ taxable: 5500, tax: 412.5, percent: 7.5 }]);

  const noPhone = fromFieldMap(sage(), { ...sageMap, buyer: { ...sageMap.buyer, phone: 'Nowhere.Phone' } });
  assert.equal(noPhone.raw.buyer.phone, undefined);
  assert.throws(() => fromFieldMap({ x: 1 }, sageMap), /no sourceRef or invoiceNumber/);
  assert.equal(fromFieldMap(sage(), { ...sageMap, tax: { rate: 7.5 } }).raw.vatRate, 7.5, 'a fixed rate can be set in the map');
});

test('the standard shape is accepted as it is, and needs an id', () => {
  const conn = { sourceType: 'canonical' };
  assert.equal(normalize(conn, { invoiceNumber: 'A1', items: [] }).sourceRef, 'A1');
  assert.equal(normalize(conn, { sourceRef: 'ERP-9', invoiceNumber: 'A1' }).sourceRef, 'ERP-9');
  assert.throws(() => normalize(conn, { items: [] }), /sourceRef/);
  assert.throws(() => normalize(conn, [1]), /one invoice/);
});

// ---- the intake endpoint, over real HTTP ------------------------------------------------------
require('../src/db/connectorStore'); // make sure the real module is loaded before it is replaced
const connectorPath = require.resolve('../src/db/connectorStore');
require.cache[connectorPath].exports = { ...connectors, createConnectorStore, hashKey };
const routes = require('../src/api/routes');

let server; let base; let qbKey; let sageKey; let qbConn; let sageConn;
test('set up: a server, two connections and the codes and buyer details the invoices need', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', routes);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api`;

  qbConn = await connectors.create({ name: 'QB Desktop, head office', sourceType: 'quickbooks-desktop', businessId: 'biz1' });
  sageConn = await connectors.create({ name: 'Sage 300', sourceType: 'sage300', businessId: 'biz1', fieldMap: sageMap });
  qbKey = qbConn.key;
  sageKey = sageConn.key;

  // codes and buyer details the accounting software cannot hold, entered once on the app's pages
  table.push({ id: 'qb1', source: `conn:${qbConn.id}`, externalRef: '80000010-1', name: 'Cement 50kg', hsnCode: '2523.29', productCategory: 'Cements' });
  table.push({ id: 'sg1', source: `conn:${sageConn.id}`, externalRef: 'I1', name: 'Cement 50kg', hsnCode: '2523.29', productCategory: 'Cements' });
  customers.push({ id: 'qbc', source: `conn:${qbConn.id}`, externalRef: '80000001-1', name: 'Buyer Ltd', tin: '98765432-0001', email: 'buyer@example.com', phone: null, street: null, city: null, state: 'Lagos', lga: 'NG-LA-IKJ', postalZone: null });
});

const post = (key, body) => fetch(`${base}/ingest`, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { 'x-connector-key': key } : {}) }, body: JSON.stringify(body) });

test('intake refuses a missing or wrong key', async () => {
  assert.equal((await post(undefined, invoiceRet())).status, 401);
  assert.equal((await post('sik_wrong', invoiceRet())).status, 401);
});

test('intake: a QuickBooks Desktop invoice arrives, is issued for the connection\'s company, and is READY with an IRN', async () => {
  const res = await post(qbKey, invoiceRet());
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  const r = body.results[0];
  assert.equal(r.ok, true);
  assert.equal(r.status, 'READY', JSON.stringify(r.errors));
  assert.equal(r.irn, 'QB1001-94ND90NR-20261028');
  assert.equal(r.duplicate, false);
});

test('intake: sending the same invoice again does not make a second one', async () => {
  const before = records.size;
  const body = await (await post(qbKey, invoiceRet())).json();
  assert.equal(body.results[0].duplicate, true);
  assert.equal(records.size, before);
});

test('intake: a Sage 300 invoice is read through the connection\'s field map', async () => {
  const body = await (await post(sageKey, sage())).json();
  assert.equal(body.results[0].status, 'READY', JSON.stringify(body));
  assert.equal(body.results[0].irn, 'SI5001-94ND90NR-20261028');
});

test('intake: a batch reports each invoice on its own; one bad invoice does not stop the others', async () => {
  const good = { ...sage(), InvoiceUniquifier: 'U-56', DocumentNumber: 'SI-5002' };
  const res = await post(sageKey, { invoices: [good, { nothing: 'useful' }] });
  const body = await res.json();
  assert.equal(res.status, 207);
  assert.equal(body.results[0].ok, true);
  assert.equal(body.results[1].ok, false);
  assert.match(body.results[1].error, /no sourceRef or invoiceNumber/);
});

test('two clients on the same software keep their own product codes and buyer details', async () => {
  const clientA = sageConn; // already set up above: item I1 coded, buyer Buyer Ltd with its own TIN
  const clientB = await connectors.create({ name: 'Sage 300, second client', sourceType: 'sage300', businessId: 'biz1', fieldMap: sageMap });
  // client B's Sage has the SAME item number and customer number, but they mean different things there
  const nativeB = { ...sage(), InvoiceUniquifier: 'B-1', DocumentNumber: 'B-5001', CustomerTin: undefined, CustomerEmail: 'other@example.com' };
  const res = await post(clientB.key, nativeB);
  const body = await res.json();
  const r = body.results[0];
  assert.equal(r.status, 'REJECTED', 'client B\'s item has no code of its own yet: client A\'s code was not borrowed');
  assert.match(r.errors.join(' '), /Cement 50kg/);
  assert.equal(table.filter((x) => x.source === `conn:${clientB.id}`).length, 1, 'client B got its own blank entry');
  assert.equal(table.find((x) => x.source === `conn:${clientA.id}`).hsnCode, '2523.29', 'client A\'s code is untouched');
});

test('intake: a switched-off connection is refused', async () => {
  await connectors.update(sageConn.id, { active: false });
  assert.equal((await post(sageKey, sage())).status, 401);
});

test('tear down', async () => { await new Promise((r) => server.close(r)); });
