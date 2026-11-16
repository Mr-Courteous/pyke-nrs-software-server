const crypto = require('crypto');
const { XMLParser } = require('fast-xml-parser');
const connectors = require('../../db/connectorStore');
const { processInvoice } = require('../../pipeline');
const { fromInvoiceRet } = require('../normalizers/quickbooksDesktop');
const { esc } = require('./soap');

/**
 * QuickBooks Web Connector (QBWC) service. QuickBooks Desktop cannot be reached from outside the office, so
 * Intuit's free Web Connector, running on the office PC, calls THIS app on a schedule:
 *
 *   authenticate -> sendRequestXML (we ask for invoices changed since the connection's cursor)
 *                -> receiveResponseXML (we take them in) -> [more pages?] -> closeConnection
 *
 * The connection id is the user name and the connection key is the password. Only reads are requested, and
 * the generated setup file marks the application read-only.
 */

const PAGE = 50;
const MAX_QBXML = 13; // the highest qbXML version these requests need; older QuickBooks versions are asked for less
const SESSION_MS = 30 * 60 * 1000;

const sessions = new Map(); // ticket -> { connection, iteratorId, maxModified, count, errors, error, version, created }

const qbParser = new XMLParser({
  ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, trimValues: true,
  isArray: (name) => ['InvoiceRet', 'InvoiceLineRet'].includes(name),
});

function sweep() {
  const cutoff = Date.now() - SESSION_MS;
  for (const [t, s] of sessions) if (s.created < cutoff) sessions.delete(t);
}

const pickVersion = (major, minor) => {
  const maj = Number(major);
  if (!Number.isFinite(maj) || maj <= 0) return '8.0'; // an old, safe default
  if (maj >= MAX_QBXML) return `${MAX_QBXML}.0`;
  return `${maj}.${Number(minor) || 0}`;
};

function queryXml(session) {
  const attrs = session.iteratorId
    ? ` requestID="2" iterator="Continue" iteratorID="${esc(session.iteratorId)}"`
    : ' requestID="1" iterator="Start"';
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    `<?qbxml version="${session.version}"?>` +
    '<QBXML><QBXMLMsgsRq onError="stopOnError">' +
    `<InvoiceQueryRq${attrs}>` +
    `<MaxReturned>${PAGE}</MaxReturned>` +
    `<ModifiedDateRangeFilter><FromModifiedDate>${esc(session.connection.syncCursor)}</FromModifiedDate></ModifiedDateRangeFilter>` +
    '<IncludeLineItems>true</IncludeLineItems>' +
    '</InvoiceQueryRq></QBXMLMsgsRq></QBXML>'
  );
}

const later = (a, b) => (!a || Date.parse(b) > Date.parse(a) ? b : a);

const handlers = {
  async authenticate({ strUserName, strPassword }) {
    sweep();
    const connection = await connectors.authenticateForUser(strUserName, strPassword);
    if (!connection || connection.sourceType !== 'quickbooks-desktop') return ['', 'nvu']; // not a valid user
    const ticket = crypto.randomUUID();
    sessions.set(ticket, { connection, iteratorId: null, maxModified: null, count: 0, errors: [], error: '', version: '8.0', created: Date.now() });
    return [ticket, '']; // empty company file name: use the company file that is open in QuickBooks
  },

  async sendRequestXML({ ticket, qbXMLMajorVers, qbXMLMinorVers }) {
    const session = sessions.get(ticket);
    if (!session) return ''; // an empty request ends the session
    session.version = pickVersion(qbXMLMajorVers, qbXMLMinorVers);
    return queryXml(session);
  },

  async receiveResponseXML({ ticket, response, hresult, message }) {
    const session = sessions.get(ticket);
    if (!session) return -1;
    if (hresult) { session.error = `QuickBooks reported ${hresult}: ${message || 'no message'}`; return -1; }

    let rs;
    try {
      rs = qbParser.parse(String(response || '')).QBXML?.QBXMLMsgsRs?.InvoiceQueryRs;
    } catch (err) {
      session.error = `Could not read QuickBooks' answer: ${err.message}`;
      return -1;
    }
    if (!rs) { session.error = 'QuickBooks sent no invoice answer.'; return -1; }

    const code = String(rs['@_statusCode'] ?? '0');
    if (code !== '0' && code !== '1') { // 1 = nothing matched, which is fine
      session.error = `QuickBooks refused the request (${code}): ${rs['@_statusMessage'] || ''}`;
      return -1;
    }

    const { id: connectionId, sourceType, businessId } = session.connection;
    for (const inv of rs.InvoiceRet || []) {
      if (inv.TimeModified) session.maxModified = later(session.maxModified, inv.TimeModified);
      if (String(inv.IsPending).toLowerCase() === 'true') continue; // not an issued invoice yet
      try {
        const { raw, sourceRef } = fromInvoiceRet(inv);
        const rec = await processInvoice(raw, sourceType, { sourceRef: `${connectionId}:${sourceRef}`, businessId });
        if (!rec.duplicate) session.count += 1;
      } catch (err) {
        session.errors.push(`${inv.RefNumber || inv.TxnID || 'an invoice'}: ${err.message}`);
      }
    }

    const remaining = Number(rs['@_iteratorRemainingCount'] || 0);
    if (remaining > 0 && rs['@_iteratorID']) {
      session.iteratorId = rs['@_iteratorID'];
      return 50; // less than 100: the Web Connector asks for the next page
    }

    // Everything was taken in: only now does the cursor move, so a failed run is simply repeated.
    if (session.maxModified) await connectors.setCursor(session.connection.id, session.maxModified);
    if (session.count > 0) await connectors.touchInvoice(session.connection.id).catch(() => {});
    return 100;
  },

  async getLastError({ ticket }) {
    const s = sessions.get(ticket);
    return s?.error || '';
  },

  async connectionError({ ticket, hresult, message }) {
    const s = sessions.get(ticket);
    if (s) s.error = `QuickBooks could not be reached: ${hresult || ''} ${message || ''}`.trim();
    return 'done'; // ends the session
  },

  async closeConnection({ ticket }) {
    sessions.delete(ticket);
    return 'OK';
  },

  async serverVersion() { return ''; },
  async clientVersion() { return ''; },
};

module.exports = { handlers, sessions };
