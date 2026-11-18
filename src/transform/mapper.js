const { NRS_CATEGORIES } = require('./schema');

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * Normalizes a raw invoice from any source into our canonical NRS-shaped
 * structure.
 *
 * Rules (the difference from the first version):
 *   - Nothing that identifies the invoice is invented. A missing invoice
 *     number or issue date stays empty so validation rejects it, instead of
 *     being replaced by "INV-<timestamp>" and today's date.
 *   - Tax comes from the source system when it supplies a breakdown
 *     (`taxLines`, as QuickBooks does). Only generic sources that give no tax
 *     information at all fall back to the standard 7.5% rate, and the
 *     result says so (tax.source), which validation turns into a warning.
 */
function mapToNrsSchema(raw, sourceSystem = 'unknown') {
  const items = (raw.items || raw.lineItems || []).map((it, idx) => {
    const quantity = Number(it.quantity ?? 1);
    const unitPrice = Number(it.unitPrice ?? it.price ?? 0);
    return {
      id: idx + 1,
      description: it.description || it.name || 'Unnamed item',
      quantity,
      unitPrice,
      lineTotal: round2(it.lineTotal ?? quantity * unitPrice),
      productCode: it.productCode || it.sku || null,
      hsnCode: it.hsnCode || null,
      productCategory: it.productCategory || null,
      productRef: it.productRef || null,                                   // the source system's item id
      productName: it.productName || it.name || it.description || null,
      unit: it.unit || null,
    };
  });

  const subtotal = round2(items.reduce((sum, it) => sum + it.lineTotal, 0));

  let breakdown;
  let taxSource;
  if (Array.isArray(raw.taxLines)) {
    taxSource = 'source-system';
    breakdown = raw.taxLines
      .filter((t) => Number(t.tax) || Number(t.taxable))
      .map((t) => ({ taxableAmount: round2(t.taxable), taxAmount: round2(t.tax), percent: t.percent === undefined ? NaN : Number(t.percent) }));
    const rest = round2(subtotal - breakdown.reduce((s, t) => s + t.taxableAmount, 0));
    if (rest > 0.01) breakdown.push({ taxableAmount: rest, taxAmount: 0, percent: 0 }); // the part QuickBooks did not tax
    if (!breakdown.length) breakdown.push({ taxableAmount: subtotal, taxAmount: 0, percent: 0 });
  } else {
    const rate = raw.vatRate ?? 7.5;
    taxSource = raw.vatRate !== undefined ? 'source-system' : 'assumed-standard-rate';
    breakdown = [{ taxableAmount: subtotal, taxAmount: round2(raw.vatAmount ?? (subtotal * rate) / 100), percent: Number(rate) }];
  }
  const vatAmount = round2(breakdown.reduce((s, t) => s + t.taxAmount, 0));
  const vatRate = Math.max(...breakdown.filter((t) => t.taxableAmount > 0).map((t) => t.percent), 0);
  const grandTotal = round2(raw.grandTotal ?? subtotal + vatAmount);

  const isB2C = Boolean(
    raw.isB2C ||
    raw.buyer?.isB2C ||
    String(raw.transactionType || raw.invoiceKind || raw.invoiceType || raw.customerType || raw.buyer?.type || raw.buyer?.customerType || '').toUpperCase() === 'B2C'
  );

  const s = raw.supplier || {};
  const b = raw.buyer || {};
  return {
    sourceSystem,
    receivedAt: new Date().toISOString(),
    [NRS_CATEGORIES.SUPPLIER]: {
      tin: s.tin || raw.supplierTin || '',
      name: s.name || raw.supplierName || '',
      address: s.address || raw.supplierAddress || '',
      email: s.email || raw.supplierEmail || '',
      phone: s.phone || '', city: s.city || '', postalZone: s.postalZone || '', state: s.state || '', lga: s.lga || '',
    },
    [NRS_CATEGORIES.BUYER]: {
      ref: b.ref || '',
      tin: b.tin || raw.buyerTin || '',
      name: b.name || raw.buyerName || '',
      address: b.address || raw.buyerAddress || '',
      street: b.street || '', city: b.city || '', postalZone: b.postalZone || '', state: b.state || '', lga: b.lga || '',
      country: b.country || '', email: b.email || '', phone: b.phone || '',
    },
    [NRS_CATEGORIES.INVOICE_META]: {
      invoiceNumber: String(raw.invoiceNumber || raw.invoiceId || ''),
      issueDate: raw.issueDate ? String(raw.issueDate).slice(0, 10) : '',
      currency: raw.currency || 'NGN',
      invoiceType: raw.invoiceType || 'Standard Tax Invoice', // internal label; the NRS type code is set in nrs/nrsCodes.js
      transactionType: isB2C ? 'B2C' : (raw.transactionType || raw.invoiceKind || 'B2B'),
      dueDate: raw.dueDate || null,
    },
    [NRS_CATEGORIES.LINE_ITEMS]: { items },
    [NRS_CATEGORIES.TAX]: { vatRate, vatAmount, breakdown, source: taxSource },
    [NRS_CATEGORIES.TOTALS]: { subtotal, taxTotal: vatAmount, grandTotal },
    [NRS_CATEGORIES.PAYMENT]: { paymentMeans: raw.paymentMeans || 'Bank Transfer', dueDate: raw.dueDate || null },
    [NRS_CATEGORIES.SECURITY]: {}, // filled in later by the IRN / signing / QR stages
    sourceFlags: { taxInclusive: !!raw.taxInclusive, hasDiscount: !!raw.hasDiscount, isB2C },
  };
}

module.exports = { mapToNrsSchema };
