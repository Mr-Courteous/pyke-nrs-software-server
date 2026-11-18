const { REQUIRED_FIELDS, LINE_ITEM_REQUIRED_FIELDS, NRS_CATEGORIES } = require('../transform/schema');
const { isRealDate } = require('../irn/irnGenerator');
const { TAX_CATEGORY_IDS } = require('../nrs/nrsCodes');

const KNOWN_RATES = Object.keys(TAX_CATEGORY_IDS).map(Number);
const TOLERANCE = 0.05; // rounding slack, in naira

const blank = (v) => v === undefined || v === null || v === '';

/**
 * Local check of a mapped invoice, before anything is signed or sent.
 * It enforces what the NRS Invoice Schema page makes mandatory and the
 * arithmetic NRS validates, and refuses to let missing data be papered over.
 *
 * deferSupplier: before a company is assigned, the supplier block still holds
 * the source system's guess (QuickBooks has no TIN), and the company replaces it
 * on assignment. Its checks run then, so no placeholder TIN has to be configured.
 *
 * Returns { valid, errors, warnings }. Errors block; warnings are advice
 * shown to the person but never stop an invoice.
 */
function validateInvoice(invoice, { deferSupplier = false } = {}) {
  const errors = [];
  const warnings = [];

  const isB2C = Boolean(
    invoice?.sourceFlags?.isB2C ||
    String(invoice?.[NRS_CATEGORIES.INVOICE_META]?.transactionType || '').toUpperCase() === 'B2C' ||
    String(invoice?.[NRS_CATEGORIES.INVOICE_META]?.invoiceKind || '').toUpperCase() === 'B2C' ||
    String(invoice?.[NRS_CATEGORIES.INVOICE_META]?.invoiceType || '').toUpperCase() === 'B2C'
  );

  for (const [category, fields] of Object.entries(REQUIRED_FIELDS)) {
    if (category === NRS_CATEGORIES.SECURITY) continue;
    if (deferSupplier && category === NRS_CATEGORIES.SUPPLIER) continue; // the company supplies these on assignment
    for (const field of fields) {
      if (isB2C && category === NRS_CATEGORIES.BUYER && field === 'tin') continue;
      if (blank(invoice[category]?.[field])) errors.push(`Missing required field: ${category}.${field}`);
    }
  }

  const meta = invoice[NRS_CATEGORIES.INVOICE_META] || {};
  if (meta.issueDate && !isRealDate(meta.issueDate)) errors.push(`Issue date "${meta.issueDate}" is not a real date (YYYY-MM-DD).`);
  else if (meta.issueDate && meta.issueDate > new Date().toISOString().slice(0, 10)) warnings.push('The issue date is in the future.');
  if (meta.invoiceNumber && !/[A-Za-z0-9]/.test(meta.invoiceNumber)) errors.push('The invoice number has no letters or digits.');
  if (meta.currency && !/^[A-Z]{3}$/.test(meta.currency)) errors.push(`Currency "${meta.currency}" is not a 3-letter code.`);

  const flags = invoice.sourceFlags || {};
  if (flags.taxInclusive) errors.push('This QuickBooks invoice is tax-inclusive. NRS needs tax-exclusive lines, so it cannot be sent as it is.');
  if (flags.hasDiscount) errors.push('This QuickBooks invoice has a discount line. Discounts are not supported yet, so it cannot be sent as it is.');

  const items = invoice[NRS_CATEGORIES.LINE_ITEMS]?.items || [];
  if (items.length === 0) errors.push('Invoice must contain at least one line item');
  const unmapped = [];
  items.forEach((item, idx) => {
    for (const field of LINE_ITEM_REQUIRED_FIELDS) {
      if (blank(item[field])) errors.push(`Line item ${idx + 1} missing required field: ${field}`);
    }
    if (blank(item.hsnCode) || blank(item.productCategory)) unmapped.push(item.productName || item.description);
  });
  if (unmapped.length) {
    errors.push(`No HSN code or product category for: ${[...new Set(unmapped)].join(', ')}. Fill them in on the Product codes page, then retry.`);
  }

  const supplier = invoice[NRS_CATEGORIES.SUPPLIER] || {};
  const buyer = invoice[NRS_CATEGORIES.BUYER] || {};
  if (!deferSupplier && supplier.address && (blank(supplier.city) || blank(supplier.postalZone))) warnings.push('The company has no city or postal zone, so they will be left out of the NRS payload.');
  if (!deferSupplier && supplier.address && (blank(supplier.state) || blank(supplier.lga))) warnings.push('The company has no state or LGA code. NRS may require them.');
  if (buyer.name && (blank(buyer.city) || blank(buyer.state))) warnings.push('The buyer address has no city or state, so they will be left out of the NRS payload.');
  if (buyer.name && blank(buyer.lga)) warnings.push('QuickBooks has no LGA for the buyer. NRS may require it.');

  const totals = invoice[NRS_CATEGORIES.TOTALS];
  const tax = invoice[NRS_CATEGORIES.TAX];
  if (totals && tax) {
    const breakdown = tax.breakdown || [];
    if (!blank(totals.subtotal) && !blank(tax.vatAmount) && Math.abs(totals.subtotal + tax.vatAmount - totals.grandTotal) > TOLERANCE) {
      errors.push(`Totals mismatch: subtotal (${totals.subtotal}) + VAT (${tax.vatAmount}) != grandTotal (${totals.grandTotal})`);
    }
    for (const t of breakdown) {
      if (!Number.isFinite(t.percent)) errors.push('A VAT line in the source has no percentage, so its tax category cannot be determined.');
      else if (!KNOWN_RATES.includes(t.percent)) errors.push(`VAT rate ${t.percent}% is not one this system can send (${KNOWN_RATES.join('%, ')}%).`);
      else if (Math.abs(t.taxableAmount * t.percent / 100 - t.taxAmount) > TOLERANCE) {
        errors.push(`VAT of ${t.taxAmount} does not match ${t.percent}% of ${t.taxableAmount}.`);
      }
    }
    if (tax.source === 'assumed-standard-rate') warnings.push('The source gave no VAT information, so the standard 7.5% rate was assumed.');
  }

  return { valid: errors.length === 0, errors, warnings };
}

module.exports = { validateInvoice };
