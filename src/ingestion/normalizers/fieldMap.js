/**
 * Reads an invoice from a system whose JSON we have not hard-coded (Sage 300, Sage 200, anything else),
 * using a "field map" stored on the connection: where each standard field lives in that system's own JSON.
 * Paths use dots and array positions, e.g. "Customer.Name" or "Lines.0.Description".
 *
 *   {
 *     "sourceRef":     "InvoiceUniquifier",
 *     "invoiceNumber": "DocumentNumber",
 *     "issueDate":     "InvoiceDate",
 *     "dueDate":       "DueDate",
 *     "currency":      "CurrencyCode",            // omit to use NGN
 *     "buyer": { "ref": "CustomerNumber", "name": "CustomerName", "address": "BillTo.Address", "city": "BillTo.City",
 *                "state": "BillTo.State", "postalZone": "BillTo.PostCode", "country": "BillTo.Country",
 *                "email": "CustomerEmail", "phone": "CustomerPhone", "tin": "CustomerTaxNumber" },
 *     "itemsPath":     "Lines",
 *     "item":  { "description": "Description", "productRef": "ItemNumber", "productName": "ItemDescription",
 *                "quantity": "Quantity", "unitPrice": "UnitPrice", "lineTotal": "NetAmount", "unit": "Unit" },
 *     "tax":   { "ratePath": "TaxRate", "totalPath": "TaxTotal" }     // or { "rate": 7.5 } for a fixed rate
 *   }
 *
 * The map is data: it is edited on the connection, with no code change, once a real sample of the system's
 * invoice JSON is available. Nothing is guessed: a path that finds nothing leaves the field empty, and
 * validation then says what is missing.
 */

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function getPath(obj, path) {
  if (!path || typeof path !== 'string') return undefined;
  let cur = obj;
  for (const part of path.split('.')) {
    if (cur === undefined || cur === null) return undefined;
    cur = cur[part];
  }
  return cur;
}

const clean = (v) => (v === undefined || v === null || v === '' ? undefined : v);

function fromFieldMap(native, map) {
  if (!map || typeof map !== 'object') throw new Error('This connection has no field map yet.');
  if (!native || typeof native !== 'object') throw new Error('Expected the invoice as a JSON object.');

  const pick = (spec) => (spec ? clean(getPath(native, spec)) : undefined);
  const sourceRef = pick(map.sourceRef) ?? pick(map.invoiceNumber);
  if (sourceRef === undefined) throw new Error('The field map found no sourceRef or invoiceNumber in this invoice.');

  const buyer = {};
  for (const [k, spec] of Object.entries(map.buyer || {})) buyer[k] = pick(spec);

  const lines = getPath(native, map.itemsPath);
  const items = (Array.isArray(lines) ? lines : lines ? [lines] : []).map((line) => {
    const it = {};
    for (const [k, spec] of Object.entries(map.item || {})) it[k] = clean(getPath(line, spec));
    return it;
  });

  const raw = {
    invoiceNumber: pick(map.invoiceNumber),
    issueDate: pick(map.issueDate),
    dueDate: pick(map.dueDate),
    currency: pick(map.currency),
    buyer,
    items,
  };

  const t = map.tax || {};
  const rate = clean(t.ratePath ? getPath(native, t.ratePath) : t.rate);
  const total = clean(t.totalPath ? getPath(native, t.totalPath) : undefined);
  if (rate !== undefined && total !== undefined && Number(rate) > 0) {
    raw.taxLines = [{ taxable: round2((Number(total) / Number(rate)) * 100), tax: Number(total), percent: Number(rate) }];
  } else if (rate !== undefined) {
    raw.vatRate = Number(rate); // the mapper works the tax out from the rate
  } // no tax information: the mapper assumes the standard rate and warns

  return { raw, sourceRef: String(sourceRef) };
}

module.exports = { fromFieldMap, getPath };
