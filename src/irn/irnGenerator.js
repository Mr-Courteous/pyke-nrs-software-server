/**
 * Builds the Invoice Reference Number exactly as the NRS "Generate IRN"
 * page (v1.1) defines it:
 *
 *   InvoiceNumber - ServiceID - YYYYMMDD
 *
 *   InvoiceNumber  the taxpayer's own number, letters and digits only
 *   ServiceID      8 letters/digits NRS assigned to this business (the
 *                  fixed middle part of its irn_template, stored on the
 *                  company as irnSuffix)
 *   YYYYMMDD       the date the invoice was ISSUED
 *
 * The date comes from the invoice, never from "today". That keeps the IRN
 * stable: re-assigning the company, retrying, or back-filling last
 * month's QuickBooks invoices all produce the same IRN for the same
 * invoice, and the date in the IRN matches the issue date NRS sees.
 *
 * The whole IRN may not exceed 80 characters (Invoice Schema, field 1.2).
 */
// NRS documents the Service ID as 8 characters; shorter ones are accepted here so a business whose
// ID is shorter is not blocked. NRS's own IRN validation is the final judge.
const SERVICE_ID_RE = /^[A-Za-z0-9]{1,8}$/;
const IRN_MAX_LENGTH = 80;

function isRealDate(iso) {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
}

/** QuickBooks numbers like "INV/2026/0042" become "INV20260042". */
function sanitizeInvoiceNumber(raw) {
  return String(raw ?? '').replace(/[^A-Za-z0-9]/g, '');
}

function buildIrn({ invoiceNumber, serviceId, issueDate }) {
  const number = sanitizeInvoiceNumber(invoiceNumber);
  if (!number) throw new Error('Cannot build the IRN: the invoice number has no letters or digits.');

  const sid = String(serviceId ?? '').trim().toUpperCase();
  if (!SERVICE_ID_RE.test(sid)) {
    throw new Error('This company has no valid Service ID (IRN suffix: 1 to 8 letters or digits). Sync it from NRS first.');
  }

  const date = String(issueDate ?? '').slice(0, 10);
  if (!isRealDate(date)) {
    throw new Error(`Cannot build the IRN: the invoice issue date "${issueDate ?? ''}" is not a real date (YYYY-MM-DD).`);
  }

  const irn = `${number}-${sid}-${date.replaceAll('-', '')}`;
  if (irn.length > IRN_MAX_LENGTH) {
    throw new Error(`The IRN would be ${irn.length} characters; NRS allows at most ${IRN_MAX_LENGTH}. Shorten the invoice number.`);
  }
  return irn;
}

/** Pipeline entry point (same signature as before). */
function generateIrn(invoice, businessSuffix) {
  return buildIrn({
    invoiceNumber: invoice.invoiceMeta?.invoiceNumber,
    serviceId: businessSuffix,
    issueDate: invoice.invoiceMeta?.issueDate,
  });
}

/** The message that is signed: IRN + "." + Unix seconds (NRS "IRN Signing", step 3). */
const irnWithTimestamp = (irn, unixSeconds) => `${irn}.${unixSeconds}`;

module.exports = { generateIrn, buildIrn, irnWithTimestamp, sanitizeInvoiceNumber, isRealDate, SERVICE_ID_RE, IRN_MAX_LENGTH };
