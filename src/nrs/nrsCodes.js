/**
 * Code values sent to NRS. Change them here, in one place.
 * Values marked UNCONFIRMED came from sample payloads, not from a published
 * NRS code list; if NRS rejects one, the rejection message names it.
 */
module.exports = {
  // 396 is what your sandbox accepted. The NRS signing page's schema example uses 381.
  INVOICE_TYPE_CODE: process.env.NRS_INVOICE_TYPE_CODE || '396',
  INVOICE_KIND: process.env.NRS_INVOICE_KIND || 'B2B',
  // UNCONFIRMED except STANDARD_VAT, which appears in the NRS schema example.
  TAX_CATEGORY_IDS: { 7.5: 'STANDARD_VAT', 0: 'ZERO_VAT' },
  // Unit when the source system has none (QuickBooks items carry no unit).
  DEFAULT_PRICE_UNIT: process.env.NRS_DEFAULT_PRICE_UNIT || 'EA',
};
