const { mapToNrsSchema } = require('./transform/mapper');
const { validateInvoice } = require('./validate/validator');
const { signIrn, resolveKeys, keyFingerprint } = require('./sign/signer');
const { generateIrn } = require('./irn/irnGenerator');
const { generateInvoiceQr } = require('./qr/qrGenerator');
const store = require('./db/store');
const businessStore = require('./db/businessStore');
const productCodeStore = require('./db/productCodeStore');
const customerDetailStore = require('./db/customerDetailStore');

/**
 * Product codes and buyer details belong to ONE connection (one client's accounting file), not to a kind of
 * software: two clients on Sage 300 can both have a customer "C-100" or an item "I1" that mean different things.
 * Invoices from a connection carry its id in their source reference; hand-entered ones share one scope.
 */
const scopeOf = (record) =>
  record.sourceRef && record.sourceRef.includes(':') ? `conn:${record.sourceRef.split(':')[0]}` : record.sourceSystem;

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

/**
 * What this app does, and where it stops:
 *
 *   Stage 1 (automatic, when an invoice arrives or is retried):
 *     map -> product codes + buyer details -> validate          => VALIDATED
 *
 *   Stage 2 (when the invoice has a company: set by the connection, or chosen by a person):
 *     company details -> IRN -> validate -> sign -> QR           => READY
 *     (NRS "Generate IRN", then "IRN Signing")
 *
 * Nothing is sent to NRS or to any access point. READY means the invoice has its IRN and QR.
 */

/** Stage 1: map and validate. Carries on to stage 2 if the invoice already has a company. */
async function runPrepare(record) {
  const { id, raw, sourceSystem } = record;
  try {
    const mapped = mapToNrsSchema(raw, sourceSystem);
    await productCodeStore.attach(mapped, scopeOf(record));
    await customerDetailStore.attach(mapped, scopeOf(record));
    await store.update(id, { status: 'MAPPED', mapped, errors: null });

    // The supplier block is the company's, stamped on later: it is checked in stage 2, not here.
    const { valid, errors, warnings } = validateInvoice(mapped, { deferSupplier: true });
    mapped.warnings = warnings;
    if (!valid) {
      await store.update(id, { status: 'REJECTED', mapped, errors });
      return await store.get(id);
    }
    await store.update(id, { mapped });
    await store.update(id, { status: 'VALIDATED' });

    if (record.businessId) return await finalizeForBusiness(id);
    return await store.get(id);
  } catch (err) {
    await store.update(id, { status: 'ERROR', errorMessage: err.message });
    return await store.get(id);
  }
}

/**
 * Stage 2: stamp the invoice with its company's details and produce the IRN, the signature and the QR.
 * The company needs a Service ID, a TIN and NRS keys (its own, or the shared ones in the environment).
 */
async function finalizeForBusiness(id) {
  const record = await store.get(id);
  if (!record?.mapped) throw httpError(409, 'Invoice has not been mapped yet.');
  const business = record.businessId ? await businessStore.getForSigning(record.businessId) : null;
  if (!business) throw httpError(409, 'No company assigned to this invoice.');

  // The company issues the invoice: its name/TIN/address (and email, phone)
  // replace the source system's supplier block. The original is kept.
  const mapped = { ...record.mapped };
  const sourceSupplier = mapped.sourceSupplier || mapped.supplier;
  mapped.sourceSupplier = sourceSupplier;
  mapped.supplier = {
    ...sourceSupplier,
    name: business.name,
    tin: business.tin,
    ...(business.address ? { address: business.address } : {}),
    ...(business.email ? { email: business.email } : {}),
    ...(business.phone ? { phone: business.phone } : {}),
    ...(business.city ? { city: business.city } : {}),
    ...(business.postalZone ? { postalZone: business.postalZone } : {}),
    ...(business.state ? { state: business.state } : {}),
    ...(business.lga ? { lga: business.lga } : {}),
  };

  // Re-read the product codes so a code added since the invoice arrived is used.
  await productCodeStore.attach(mapped, scopeOf(record));
  await customerDetailStore.attach(mapped, scopeOf(record));


  const reject = async (errors, extra = {}) => {
    await store.update(id, { status: 'REJECTED', mapped: { ...mapped, ...extra }, errors, irn: null, qr: null, signature: null });
    return await store.get(id);
  };

  // A company that is not set up yet cannot issue an IRN: say exactly what is missing.
  const missing = [];
  if (!business.tin) missing.push('its TIN');
  if (!business.irnSuffix) missing.push('its NRS Service ID');
  if (missing.length) {
    return reject([`${business.name} is missing ${missing.join(' and ')}. Add ${missing.length > 1 ? 'them' : 'it'} on the Companies page, then press Retry.`]);
  }

  // 1. IRN: InvoiceNumber-ServiceID-IssueDate (NRS "Generate IRN").
  let irn;
  try {
    irn = generateIrn(mapped, business.irnSuffix);
  } catch (err) {
    return reject([err.message]);
  }

  // 2. Local compliance check against the NRS Invoice Schema.
  const { valid, errors, warnings } = validateInvoice(mapped);
  if (!valid) return reject(errors, { warnings });

  // 3. The IRN must be unique across every invoice we hold.
  const clash = await store.findIrnClash(irn, id);
  if (clash) {
    return reject([`Another invoice already uses the IRN ${irn}. Two invoice numbers become the same once punctuation is removed (for example INV-001 and INV001). Change one in the accounting software.`], { warnings });
  }

  // 4. IRN signing: encrypt IRN.timestamp + certificate with the NRS public key (NRS "IRN Signing").
  const keys = resolveKeys(business);
  if (!keys) {
    return reject([`${business.name} has no NRS cryptographic keys yet. Paste its crypto_keys.txt on the Companies page, then retry.`], { warnings });
  }
  let signed;
  try {
    signed = signIrn({ irn, certificate: keys.certificate, publicKey: keys.publicKey });
  } catch (err) {
    return reject([err.message], { warnings });
  }

  const signature = {
    method: 'NRS MBS IRN signing: RSA (PKCS#1 v1.5) encryption of IRN.timestamp + certificate',
    signedMessage: signed.signedMessage,
    timestamp: signed.timestamp,
    keySource: keys.source,
    keyFingerprint: keyFingerprint(keys.publicKey),
    signedAt: new Date(signed.timestamp * 1000).toISOString(),
  };
  await store.update(id, { status: 'SIGNED', mapped: { ...mapped, warnings }, signature, irn, errors: null });

  // 5. QR = the encrypted string, nothing else.
  const qr = await generateInvoiceQr({ encrypted: signed.encrypted, irn });
  await store.update(id, { status: 'READY', qr, errorMessage: null });
  return await store.get(id);
}

/**
 * Assigns (or clears, with businessId = null) the company for one invoice. With the same company again it
 * rebuilds the IRN, signature and QR from the company's and buyer's CURRENT details; the IRN does not change.
 */
async function assignBusiness(id, businessId) {
  const record = await store.get(id);
  if (!record) throw httpError(404, 'Invoice not found.');

  if (businessId) {
    const business = await businessStore.get(businessId);
    if (!business) throw httpError(404, 'Company not found.');
    if (business.active === false) throw httpError(409, `${business.name} is inactive.`);
  }

  const rebuildable = ['VALIDATED', 'SIGNED', 'READY', 'ERROR'].includes(record.status) && record.mapped;

  if ((record.businessId || null) === (businessId || null)) {
    if (businessId && record.status === 'REJECTED') return await retryInvoice(id); // after fixing the company or buyer
    return businessId && rebuildable ? await finalizeForBusiness(id) : record;
  }

  await store.update(id, { businessId: businessId || null });

  if (rebuildable) {
    if (!businessId) {
      await store.update(id, { status: 'VALIDATED', irn: null, qr: null, signature: null });
      return await store.get(id);
    }
    return await finalizeForBusiness(id);
  }
  if (businessId && record.status === 'REJECTED') return await retryInvoice(id);
  return await store.get(id); // RECEIVED / MAPPED: the company is kept
}

/**
 * Receives one invoice. `sourceRef` is the source system's own id for it: if it was received before, the
 * existing invoice is returned (with duplicate: true) and nothing new is made.
 * `businessId` issues it for that company straight away.
 */
async function processInvoice(raw, sourceSystem = 'unknown', { sourceRef, businessId } = {}) {
  if (sourceRef) {
    const existing = await store.findBySourceRef(sourceSystem, sourceRef);
    if (existing) return { ...existing, duplicate: true };
  } else if (raw?.invoiceNumber) {
    // Hand-entered invoices have no source id: fall back to the invoice number.
    const all = await store.list();
    const dupe = all.find((r) => r.sourceSystem === sourceSystem && !r.sourceRef && r.raw?.invoiceNumber === raw.invoiceNumber);
    if (dupe) return { ...dupe, duplicate: true };
  }

  let record;
  try {
    record = await store.create({ sourceSystem, raw, sourceRef: sourceRef || null, businessId: businessId || null });
  } catch (err) {
    if (err.code === 'P2002' && sourceRef) { // two copies arrived at once
      const existing = await store.findBySourceRef(sourceSystem, sourceRef);
      if (existing) return { ...existing, duplicate: true };
    }
    throw err;
  }
  return runPrepare(record);
}

/** Retry for REJECTED / ERROR invoices: map, validate and (with a company) sign again. */
async function retryInvoice(id) {
  const record = await store.get(id);
  if (!record) return null;
  if (!['REJECTED', 'ERROR'].includes(record.status)) {
    throw new Error(`Only REJECTED or ERROR invoices can be retried (this one is ${record.status}).`);
  }
  await store.update(id, { errors: null, errorMessage: null });
  return runPrepare(record);
}

module.exports = { processInvoice, retryInvoice, assignBusiness };
