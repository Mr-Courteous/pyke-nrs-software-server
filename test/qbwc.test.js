const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const { records, table, customers, businesses } = require('./fakes');
const { createConnectorStore, hashKey } = require('../src/db/connectorStore');

// ---- a connection store over in-memory rows, swapped in for the real one ----------------------
const connRows = [];
const fakePrisma = {
  business: { async findUnique({ where }) { return businesses.get(where.id) || null; } },
  sourceConnection: {
    async create({ data }) { const r = { id: `conn-${connRows.length + 1}`, active: true, lastSeenAt: null, lastInvoiceAt: null, createdAt: new Date(), fieldMap: null, ...data }; connRows.push(r); return r; },
    async findUnique({ where }) { return connRows.find((r) => (where.id ? r.id === where.id : r.keyHash === where.keyHash)) || null; },
    async findMany() { return connRows; },
    async update({ where, data }) { const r = connRows.find((x) => x.id === where.id); Object.assign(r, data); return r; },
  },
};
const connectors = createConnectorStore(() => fakePrisma);
const connectorPath = require.resolve('../src/db/connectorStore');
require(connectorPath);
require.cache[connectorPath].exports = { ...connectors, createConnectorStore, hashKey };

const { router, qwcFor } = require('../src/ingestion/qbwc/router');
const { sessions } = require('../src/ingestion/qbwc/service');

// ---- a minimal Web Connector: it speaks the same SOAP the real one does ------------------------
const NS = 'http://developer.intuit.com/';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const call = (method, params = {}) =>
  `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${method} xmlns="${NS}">` +
  Object.entries(params).map(([k, v]) => `<${k}>${esc(v)}</${k}>`).join('') + `</${method}></soap:Body></soap:Envelope>`;
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const result = (xml, method) => unesc((xml.match(new RegExp(`<${method}Result[^>]*>([\\s\\S]*?)</${method}Result>`)) || [, ''])[1]);

let server; let base; let conn; let key;
const send = async (method, params) => {
  const res = await fetch(`${base}/qbwc`, { method: 'POST', headers: { 'content-type': 'text/xml; charset=utf-8', SOAPAction: `${NS}${method}` }, body: call(method, params) });
  return res.text();
};
const login = async (user = conn.id, pass = key) => {
  const xml = await send('authenticate', { strUserName: user, strPassword: pass });
  const strings = [...xml.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
  return { ticket: strings[0], second: strings[1] };
};

const invoiceRet = (n, extra = '') => `<InvoiceRet><TxnID>8000A-${n}</TxnID><TimeModified>2026-11-09T1${n}:15:30+01:00</TimeModified><TxnDate>2026-11-09</TxnDate><RefNumber>QB-100${n}</RefNumber>` +
  '<CustomerRef><ListID>80000001-1</ListID><FullName>Buyer Ltd</FullName></CustomerRef>' +
  '<BillAddress><Addr1>Buyer Ltd</Addr1><Addr2>12 Sample Avenue</Addr2><City>Ikeja</City><State>Lagos</State><PostalCode>100271</PostalCode></BillAddress>' +
  `<IsPending>false</IsPending>${extra}<SalesTaxPercentage>7.5</SalesTaxPercentage><SalesTaxTotal>412.50</SalesTaxTotal>` +
  '<InvoiceLineRet><TxnLineID>L1</TxnLineID><ItemRef><ListID>80000010-1</ListID><FullName>Cement 50kg</FullName></ItemRef><Desc>Cement, 50kg bag</Desc><Quantity>1</Quantity><Rate>5500.00</Rate><Amount>5500.00</Amount></InvoiceLineRet></InvoiceRet>';
const answer = (inner, attrs = 'statusCode="0" statusSeverity="Info" statusMessage="Status OK" iteratorRemainingCount="0" iteratorID="{AAA}"') =>
  `<?xml version="1.0" ?><QBXML><QBXMLMsgsRs><InvoiceQueryRs requestID="1" ${attrs}>${inner}</InvoiceQueryRs></QBXMLMsgsRs></QBXML>`;

test('set up: a server, a QuickBooks Desktop connection tied to a company, and the codes and buyer details', async () => {
  const app = express();
  app.use('/qbwc', router);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const made = await connectors.create({ name: 'QuickBooks, head office', sourceType: 'quickbooks-desktop', businessId: 'biz1', syncFrom: '2026-11-01' });
  conn = made; key = made.key;
  table.push({ id: 'q1', source: `conn:${conn.id}`, externalRef: '80000010-1', name: 'Cement 50kg', hsnCode: '2523.29', productCategory: 'Cements' });
  customers.push({ id: 'qc1', source: `conn:${conn.id}`, externalRef: '80000001-1', name: 'Buyer Ltd', tin: '98765432-0001', email: 'buyer@example.com', phone: null, street: null, city: null, state: 'Lagos', lga: 'NG-LA-IKJ', postalZone: null });
  assert.equal(made.syncCursor, '2026-11-01T00:00:00', 'a start date was given, so history before it is not swept in');
});

test('a wrong password, a wrong user name, or the wrong kind of connection is refused as "not a valid user"', async () => {
  assert.equal((await login(conn.id, 'sik_wrong')).second, 'nvu');
  assert.equal((await login('someone-else', key)).second, 'nvu');
  const sage = await connectors.create({ name: 'Sage', sourceType: 'sage300' });
  assert.equal((await login(sage.id, sage.key)).second, 'nvu', 'a Sage key cannot be used here');
});

test('a good sign-in gives a ticket and asks QuickBooks for invoices changed since the cursor', async () => {
  const { ticket, second } = await login();
  assert.match(ticket, /^[0-9a-f-]{36}$/);
  assert.equal(second, '', 'an empty company file name means: the one open in QuickBooks');
  const req = result(await send('sendRequestXML', { ticket, qbXMLMajorVers: '16', qbXMLMinorVers: '0' }), 'sendRequestXML');
  assert.match(req, /<\?qbxml version="13\.0"\?>/, 'asks for no newer qbXML than it needs');
  assert.match(req, /<InvoiceQueryRq requestID="1" iterator="Start">/);
  assert.match(req, /<FromModifiedDate>2026-11-01T00:00:00<\/FromModifiedDate>/);
  assert.match(req, /<IncludeLineItems>true<\/IncludeLineItems>/);
  assert.deepEqual([...req.matchAll(/<(\w+Rq)\b/g)].map((m) => m[1]), ['QBXMLMsgsRq', 'InvoiceQueryRq'], 'the only request is a read: an invoice query');
  const old = result(await send('sendRequestXML', { ticket, qbXMLMajorVers: '8', qbXMLMinorVers: '0' }), 'sendRequestXML');
  assert.match(old, /<\?qbxml version="8\.0"\?>/, 'an older QuickBooks is asked in its own version');
  await send('closeConnection', { ticket });
});

test('invoices in the answer are taken in: issued ones get an IRN and QR, pending ones are skipped, the cursor moves', async () => {
  const { ticket } = await login();
  await send('sendRequestXML', { ticket, qbXMLMajorVers: '16', qbXMLMinorVers: '0' });
  const body = answer(invoiceRet(1) + invoiceRet(2).replace('<IsPending>false</IsPending>', '<IsPending>true</IsPending>'));
  const percent = result(await send('receiveResponseXML', { ticket, response: body, hresult: '', message: '' }), 'receiveResponseXML');
  assert.equal(percent, '100');
  const mine = [...records.values()].filter((r) => r.sourceSystem === 'quickbooks-desktop');
  assert.equal(mine.length, 1, 'the pending invoice was not taken in');
  assert.equal(mine[0].status, 'READY', JSON.stringify(mine[0].errors));
  assert.equal(mine[0].irn, 'QB1001-94ND90NR-20261109');
  assert.equal(connRows.find((r) => r.id === conn.id).syncCursor, '2026-11-09T12:15:30+01:00', 'the cursor is the latest change seen');
  await send('closeConnection', { ticket });
});

test('the next run asks from the new cursor, and the same invoices again create nothing', async () => {
  const { ticket } = await login();
  const req = result(await send('sendRequestXML', { ticket, qbXMLMajorVers: '16', qbXMLMinorVers: '0' }), 'sendRequestXML');
  assert.match(req, /<FromModifiedDate>2026-11-09T12:15:30\+01:00<\/FromModifiedDate>/);
  const before = records.size;
  await send('receiveResponseXML', { ticket, response: answer(invoiceRet(1)), hresult: '', message: '' });
  assert.equal(records.size, before);
  await send('closeConnection', { ticket });
});

test('a long answer comes in pages, and the cursor only moves after the last page', async () => {
  const { ticket } = await login();
  const cursorBefore = connRows.find((r) => r.id === conn.id).syncCursor;
  await send('sendRequestXML', { ticket, qbXMLMajorVers: '16', qbXMLMinorVers: '0' });
  const p1 = result(await send('receiveResponseXML', { ticket, response: answer(invoiceRet(3), 'statusCode="0" iteratorRemainingCount="2" iteratorID="{PAGE-1}"'), hresult: '', message: '' }), 'receiveResponseXML');
  assert.equal(p1, '50', 'less than 100 means: ask again');
  assert.equal(connRows.find((r) => r.id === conn.id).syncCursor, cursorBefore, 'not moved yet');
  const next = result(await send('sendRequestXML', { ticket, qbXMLMajorVers: '16', qbXMLMinorVers: '0' }), 'sendRequestXML');
  assert.match(next, /iterator="Continue" iteratorID="\{PAGE-1\}"/);
  const p2 = result(await send('receiveResponseXML', { ticket, response: answer(invoiceRet(4), 'statusCode="0" iteratorRemainingCount="0" iteratorID="{PAGE-1}"'), hresult: '', message: '' }), 'receiveResponseXML');
  assert.equal(p2, '100');
  assert.equal(connRows.find((r) => r.id === conn.id).syncCursor, '2026-11-09T14:15:30+01:00');
  await send('closeConnection', { ticket });
});

test('"nothing found" is fine; a QuickBooks error is reported and moves nothing', async () => {
  let { ticket } = await login();
  await send('sendRequestXML', { ticket, qbXMLMajorVers: '16', qbXMLMinorVers: '0' });
  assert.equal(result(await send('receiveResponseXML', { ticket, response: answer('', 'statusCode="1" statusMessage="A query request did not find a matching object" iteratorRemainingCount="0"'), hresult: '', message: '' }), 'receiveResponseXML'), '100');
  await send('closeConnection', { ticket });

  ({ ticket } = await login());
  const cursor = connRows.find((r) => r.id === conn.id).syncCursor;
  const bad = result(await send('receiveResponseXML', { ticket, response: '', hresult: '0x80040400', message: 'QuickBooks found an error when parsing the provided XML text stream.' }), 'receiveResponseXML');
  assert.equal(bad, '-1');
  assert.match(result(await send('getLastError', { ticket }), 'getLastError'), /0x80040400/);
  assert.equal(connRows.find((r) => r.id === conn.id).syncCursor, cursor);
  await send('closeConnection', { ticket });
});

test('an invoice that cannot be read is reported and does not stop the others', async () => {
  const { ticket } = await login();
  await send('sendRequestXML', { ticket, qbXMLMajorVers: '16', qbXMLMinorVers: '0' });
  const broken = '<InvoiceRet><RefNumber>NO-ID</RefNumber></InvoiceRet>'; // no TxnID
  const before = records.size;
  const percent = result(await send('receiveResponseXML', { ticket, response: answer(broken + invoiceRet(5)), hresult: '', message: '' }), 'receiveResponseXML');
  assert.equal(percent, '100');
  assert.equal(records.size, before + 1, 'the good invoice was still taken in');
  assert.ok(sessions.get(ticket).errors.some((e) => /NO-ID/.test(e)));
  await send('closeConnection', { ticket });
});

test('a closed or unknown ticket gets nothing', async () => {
  const { ticket } = await login();
  await send('closeConnection', { ticket });
  assert.equal(result(await send('sendRequestXML', { ticket, qbXMLMajorVers: '16', qbXMLMinorVers: '0' }), 'sendRequestXML'), '');
  assert.equal(result(await send('receiveResponseXML', { ticket: 'nope', response: '', hresult: '', message: '' }), 'receiveResponseXML'), '-1');
});

test('the setup file names the connection and the address, marks it read-only, and holds no key', () => {
  const qwc = qwcFor({ id: conn.id, name: 'QuickBooks, head office' }, 'https://collector.example.com/');
  assert.match(qwc, new RegExp(`<UserName>${conn.id}</UserName>`));
  assert.match(qwc, /<AppURL>https:\/\/collector\.example\.com\/qbwc<\/AppURL>/);
  assert.match(qwc, /<IsReadOnly>true<\/IsReadOnly>/);
  assert.match(qwc, /<QBType>QBFS<\/QBType>/);
  assert.equal(qwc.includes(key), false);
  assert.match(qwc, /<OwnerID>\{[0-9A-F-]{36}\}<\/OwnerID>/);
  assert.equal(qwcFor({ id: conn.id, name: 'x' }, 'https://a.example').match(/<FileID>.*<\/FileID>/)[0], qwcFor({ id: conn.id, name: 'y' }, 'https://b.example').match(/<FileID>.*<\/FileID>/)[0], 'the same connection always gives the same ids');
});

test('tear down', async () => { await new Promise((r) => server.close(r)); });
