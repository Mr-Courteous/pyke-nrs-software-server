const { XMLParser } = require('fast-xml-parser');

/** The little SOAP the QuickBooks Web Connector speaks: read a call, write a response. */

const NS = 'http://developer.intuit.com/';
const parser = new XMLParser({ removeNSPrefix: true, ignoreAttributes: true, parseTagValue: false, trimValues: false });

const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** { method, params } from a SOAP request body. */
function parseCall(xml) {
  const body = parser.parse(String(xml || ''))?.Envelope?.Body;
  if (!body || typeof body !== 'object') throw new Error('Not a SOAP request.');
  const method = Object.keys(body).find((k) => !k.startsWith('#') && !k.startsWith('?'));
  if (!method) throw new Error('The SOAP request names no method.');
  const params = body[method] && typeof body[method] === 'object' ? body[method] : {};
  return { method, params };
}

const envelope = (inner) =>
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">' +
  `<soap:Body>${inner}</soap:Body></soap:Envelope>`;

/** A response: <nameResponse><nameResult>…</nameResult></nameResponse>. `strings` become <string> items. */
function respond(name, result) {
  const inner = Array.isArray(result) ? result.map((s) => `<string>${esc(s)}</string>`).join('') : esc(result);
  return envelope(`<${name}Response xmlns="${NS}"><${name}Result>${inner}</${name}Result></${name}Response>`);
}

function fault(message) {
  return envelope(`<soap:Fault><faultcode>soap:Server</faultcode><faultstring>${esc(message)}</faultstring></soap:Fault>`);
}

module.exports = { parseCall, respond, fault, esc, NS };
