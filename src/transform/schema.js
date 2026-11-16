/**
 * NRS Merchant Buyer Solution — Invoice Schema (reference model)
 *
 * Public reporting confirms the NRS e-invoice schema covers 55 mandatory
 * fields across 8 categories, delivered as XML/JSON built on UBL 3.0,
 * with an Invoice Reference Number (IRN), QR code, and digital signature
 * required for validity. This file is our internal canonical shape for
 * that schema. When wiring to a live NRS-accredited APP (Interswitch,
 * Afri Invoice, e-Afrinvoice, etc.), map their exact field names here —
 * the rest of the pipeline (validate/sign/irn/qr/transmit) stays the same.
 */

const NRS_CATEGORIES = {
  SUPPLIER: 'supplier',           // Seller / issuing business details
  BUYER: 'buyer',                 // Customer details
  INVOICE_META: 'invoiceMeta',    // Invoice number, dates, currency, type
  LINE_ITEMS: 'lineItems',        // Products/services, qty, unit price
  TAX: 'tax',                     // VAT breakdown, tax categories
  TOTALS: 'totals',               // Subtotal, tax total, grand total
  PAYMENT: 'payment',             // Payment means, terms, due date
  SECURITY: 'security',           // IRN, QR, digital signature, timestamps
};

// Required fields per category — trimmed to the load-bearing set for a
// working demo; extend field-by-field against the live NRS schema
// reference before production use.
const REQUIRED_FIELDS = {
  [NRS_CATEGORIES.SUPPLIER]: ['tin', 'name', 'address', 'email'],
  [NRS_CATEGORIES.BUYER]: ['tin', 'name', 'address'],
  [NRS_CATEGORIES.INVOICE_META]: ['invoiceNumber', 'issueDate', 'currency', 'invoiceType'],
  [NRS_CATEGORIES.LINE_ITEMS]: ['items'], // array, each item validated separately
  [NRS_CATEGORIES.TAX]: ['vatRate', 'vatAmount'],
  [NRS_CATEGORIES.TOTALS]: ['subtotal', 'taxTotal', 'grandTotal'],
  [NRS_CATEGORIES.PAYMENT]: ['paymentMeans'],
  [NRS_CATEGORIES.SECURITY]: [], // populated by our pipeline, not the source system
};

const LINE_ITEM_REQUIRED_FIELDS = ['description', 'quantity', 'unitPrice', 'lineTotal'];

module.exports = { NRS_CATEGORIES, REQUIRED_FIELDS, LINE_ITEM_REQUIRED_FIELDS };
