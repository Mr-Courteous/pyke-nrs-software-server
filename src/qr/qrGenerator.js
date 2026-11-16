const QRCode = require('qrcode');

/**
 * The QR code holds ONLY the base64 string produced by signIrn(): the IRN
 * plus timestamp and certificate, encrypted with the business's NRS public
 * key (NRS "IRN Signing" page, step 4). It is not readable without NRS's
 * private key, which is the point: the NRS app decrypts it on scan.
 *
 * Error correction is level L, the same as `qrencode`'s default in the NRS
 * example. The payload is ~344 characters for a 2048-bit key, so show the
 * image at 200px or larger or phones cannot resolve it.
 */
async function generateInvoiceQr({ encrypted, irn }) {
  if (!encrypted) throw new Error('Nothing to encode: the invoice has not been signed.');
  const dataUrl = await QRCode.toDataURL(encrypted, { errorCorrectionLevel: 'L', margin: 2, width: 520 });
  return { dataUrl, payload: encrypted, irn };
}

module.exports = { generateInvoiceQr };
