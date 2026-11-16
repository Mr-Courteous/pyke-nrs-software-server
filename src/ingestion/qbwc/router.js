const express = require('express');
const crypto = require('crypto');
const { parseCall, respond, fault, esc } = require('./soap');
const { handlers } = require('./service');

const router = express.Router();

// The Web Connector's own address: POST <public address>/qbwc
router.post('/', express.text({ type: () => true, limit: '10mb' }), async (req, res) => {
  res.type('text/xml');
  try {
    const { method, params } = parseCall(req.body);
    const handler = handlers[method];
    if (!handler) return res.status(500).send(fault(`Unknown method ${method}`));
    res.send(respond(method, await handler(params)));
  } catch (err) {
    res.status(500).send(fault(err.message));
  }
});

// A person opening the address in a browser gets a plain answer.
router.get('/', (req, res) => res.type('text/plain').send('NRS SI collector: QuickBooks Web Connector endpoint.'));

/** Stable GUID-shaped ids for the setup file, so downloading it twice gives the same application. */
const guid = (seed) => {
  const h = crypto.createHash('sha1').update(seed).digest('hex');
  return `{${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}}`.toUpperCase();
};

/** The .qwc setup file the office loads into the Web Connector. It holds no password. */
function qwcFor(connection, baseUrl) {
  const base = String(baseUrl).replace(/\/+$/, '');
  return (
    '<?xml version="1.0"?>\n<QBWCXML>\n' +
    `  <AppName>${esc(`NRS SI collector: ${connection.name}`)}</AppName>\n` +
    `  <AppURL>${esc(`${base}/qbwc`)}</AppURL>\n` +
    '  <AppDescription>Sends issued invoices to the NRS SI collector, which makes their IRN and QR code. Reads only.</AppDescription>\n' +
    `  <AppSupport>${esc(base)}</AppSupport>\n` +
    `  <UserName>${esc(connection.id)}</UserName>\n` +
    `  <OwnerID>${guid(`owner:${connection.id}`)}</OwnerID>\n` +
    `  <FileID>${guid(`file:${connection.id}`)}</FileID>\n` +
    '  <QBType>QBFS</QBType>\n' +
    '  <IsReadOnly>true</IsReadOnly>\n' +
    '  <Scheduler><RunEveryNMinutes>15</RunEveryNMinutes></Scheduler>\n' +
    '</QBWCXML>\n'
  );
}

module.exports = { router, qwcFor };
