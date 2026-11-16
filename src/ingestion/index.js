const { fromInvoiceRet } = require('./normalizers/quickbooksDesktop');
const { fromFieldMap } = require('./normalizers/fieldMap');

/**
 * Turns one invoice as a connection sends it into { raw, sourceRef } for the pipeline.
 *   quickbooks-desktop  an InvoiceRet object
 *   sage300 / sage200   the system's own invoice JSON, read through the connection's field map
 *                       (no map yet: the standard shape is expected)
 *   canonical           the standard shape (see the sample files)
 * `raw` is the standard shape the mapper reads; `sourceRef` is the source's own id for the invoice.
 */
function normalize(connection, body) {
  if (connection.sourceType === 'quickbooks-desktop') return fromInvoiceRet(body);

  if ((connection.sourceType === 'sage300' || connection.sourceType === 'sage200') && connection.fieldMap) {
    return fromFieldMap(body, connection.fieldMap);
  }

  // The standard shape: the connector already translated the invoice.
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Expected one invoice as a JSON object.');
  const ref = body.sourceRef ?? body.invoiceNumber;
  if (ref === undefined || ref === null || ref === '') throw new Error('The invoice needs a sourceRef (the source system\'s own id) or an invoiceNumber.');
  const { sourceRef: _drop, ...raw } = body;
  return { raw, sourceRef: String(ref) };
}

module.exports = { normalize };
