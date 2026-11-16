/**
 * QuickBooks Desktop -> the standard invoice shape.
 *
 * Reads one qbXML <InvoiceRet> (as an object: XML parsed to JSON, repeated elements as arrays or a single
 * object). This is what QuickBooks Desktop returns through the QuickBooks Web Connector or the QB SDK for
 * an InvoiceQuery. Field names follow the qbXML InvoiceRet specification; check them against a real export
 * from your QuickBooks version before relying on it in production.
 */

const arr = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const num = (v) => (v === undefined || v === null || v === '' ? undefined : Number(v));
const text = (v) => (v === undefined || v === null ? '' : String(v).trim());
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function fromInvoiceRet(inv) {
  if (!inv || typeof inv !== 'object') throw new Error('Expected a QuickBooks InvoiceRet object.');
  const sourceRef = text(inv.TxnID);
  if (!sourceRef) throw new Error('InvoiceRet has no TxnID.');

  const lines = arr(inv.InvoiceLineRet)
    .filter((l) => l && (l.Amount !== undefined || l.Quantity !== undefined) && (l.ItemRef || l.Desc))
    .map((l) => {
      const quantity = num(l.Quantity);
      const amount = num(l.Amount);
      const rate = num(l.Rate);
      const item = l.ItemRef || {};
      return {
        description: text(l.Desc) || text(item.FullName),
        productName: text(item.FullName) || text(l.Desc),
        productRef: text(item.ListID) || undefined, // the item's QuickBooks id: what product codes are keyed by
        quantity: quantity ?? 1,
        unitPrice: rate ?? (quantity ? round2(amount / quantity) : amount ?? 0),
        lineTotal: amount,
        unit: text(l.UnitOfMeasure) || undefined,
      };
    });

  const addr = inv.BillAddress || {};
  const street = [addr.Addr1, addr.Addr2, addr.Addr3, addr.Addr4, addr.Addr5].map(text).filter(Boolean);
  // QuickBooks often puts the customer's name on Addr1 as well; keep it out of the street line.
  const name = text(inv.CustomerRef?.FullName);
  const streetLines = street[0] && name && street[0].toLowerCase() === name.toLowerCase() ? street.slice(1) : street;

  const raw = {
    invoiceNumber: text(inv.RefNumber),
    issueDate: text(inv.TxnDate),
    dueDate: text(inv.DueDate) || undefined,
    currency: text(inv.CurrencyRef?.FullName) ? undefined : 'NGN', // multi-currency files carry a currency name, not a code
    buyer: {
      ref: text(inv.CustomerRef?.ListID),
      name,
      address: [...streetLines, text(addr.City), text(addr.State)].filter(Boolean).join(', '),
      street: streetLines.join(', '),
      city: text(addr.City),
      state: text(addr.State),
      postalZone: text(addr.PostalCode),
      country: text(addr.Country),
    },
    items: lines,
  };

  // Tax: QuickBooks reports one sales-tax total and rate for the invoice.
  const taxTotal = num(inv.SalesTaxTotal);
  const taxPercent = num(inv.SalesTaxPercentage);
  if (taxTotal !== undefined && taxPercent !== undefined && taxPercent > 0) {
    raw.taxLines = [{ taxable: round2((taxTotal / taxPercent) * 100), tax: taxTotal, percent: taxPercent }];
  } else if (taxTotal === 0) {
    raw.taxLines = []; // QuickBooks says there is no tax; everything is then zero-rated and the mapper says so
  } // otherwise tax is unknown: the mapper assumes the standard rate and warns

  return { raw, sourceRef };
}

module.exports = { fromInvoiceRet };
