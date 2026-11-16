const crypto = require('crypto');
const { irnWithTimestamp } = require('../irn/irnGenerator');

/**
 * IRN signing exactly as the NRS "IRN Signing" page (v1.1) describes:
 *
 *   1. crypto_keys.txt (from the NRS portal) holds a public_key and a
 *      certificate. public_key is the base64 of a PEM public key.
 *   2. Message = { "irn": "<IRN>.<unix seconds>", "certificate": "<cert>" }
 *   3. Encrypt the message with the public key (RSA; this is what
 *      `openssl pkeyutl -encrypt -pubin` does, i.e. PKCS#1 v1.5 padding).
 *   4. Base64 the ciphertext. That string is what the QR code holds.
 *
 * No private key is involved or stored here: NRS holds the private key and
 * decrypts the QR when it is scanned. (This replaces the earlier demo
 * ECDSA signature, which used a throwaway key regenerated on every start.)
 */

/** Accepts the crypto_keys.txt content (JSON text or object). */
function parseCryptoKeys(input) {
  let obj = input;
  if (typeof input === 'string') {
    try { obj = JSON.parse(input); } catch {
      throw new Error('That is not valid JSON. Paste the full contents of crypto_keys.txt.');
    }
  }
  if (!obj || typeof obj.public_key !== 'string' || typeof obj.certificate !== 'string') {
    throw new Error('crypto_keys.txt must contain both "public_key" and "certificate".');
  }
  const publicKey = obj.public_key.trim();
  const certificate = obj.certificate.trim();
  if (!certificate) throw new Error('The certificate in crypto_keys.txt is empty.');
  decodePublicKeyPem(publicKey); // throws if unusable
  return { publicKey, certificate };
}

/** public_key is base64 of the PEM; a raw PEM is accepted too. */
function decodePublicKeyPem(value) {
  const text = String(value || '').trim();
  const pem = text.startsWith('-----BEGIN') ? text : Buffer.from(text, 'base64').toString('utf8').trim();
  try {
    const key = crypto.createPublicKey(pem);
    if (key.asymmetricKeyType !== 'rsa') throw new Error('not rsa');
  } catch {
    throw new Error('The public_key could not be read as an RSA public key. Copy crypto_keys.txt again, in full.');
  }
  return pem;
}

function keyFingerprint(value) {
  return crypto.createHash('sha256').update(decodePublicKeyPem(value)).digest('hex').slice(0, 16);
}

/**
 * Keys for a company: its own, else the account-wide pair from the
 * environment (NRS_PUBLIC_KEY + NRS_CERTIFICATE, or NRS_CRYPTO_KEYS holding the whole crypto_keys.txt). Returns null if neither
 * exists. `source` is recorded on the invoice so it is always visible
 * which pair was used.
 */
function resolveKeys(business, env = process.env) {
  if (business?.publicKey && business?.certificate) {
    return { publicKey: business.publicKey, certificate: business.certificate, source: 'company' };
  }
  if (env.NRS_PUBLIC_KEY && env.NRS_CERTIFICATE) {
    return { publicKey: env.NRS_PUBLIC_KEY, certificate: env.NRS_CERTIFICATE, source: 'environment' };
  }
  // The whole crypto_keys.txt in one setting (NRS_CRYPTO_KEYS), as the portal gives it.
  if (env.NRS_CRYPTO_KEYS) {
    try {
      const { publicKey, certificate } = parseCryptoKeys(env.NRS_CRYPTO_KEYS);
      return { publicKey, certificate, source: 'environment' };
    } catch {
      return null; // unreadable: treated as "no keys", and the invoice says so
    }
  }
  return null;
}

/** Returns { encrypted (base64), signedMessage, timestamp }. */
function signIrn({ irn, certificate, publicKey, timestamp = Math.floor(Date.now() / 1000) }) {
  const key = crypto.createPublicKey(decodePublicKeyPem(publicKey));
  const signedMessage = irnWithTimestamp(irn, timestamp);
  const data = Buffer.from(JSON.stringify({ irn: signedMessage, certificate }), 'utf8');

  const bits = key.asymmetricKeyDetails?.modulusLength;
  const max = bits / 8 - 11;
  if (data.length > max) {
    throw new Error(`The IRN and certificate are ${data.length} bytes but a ${bits}-bit RSA key can encrypt at most ${max}. Check that the certificate was pasted correctly.`);
  }
  const encrypted = crypto.publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_PADDING }, data).toString('base64');
  return { encrypted, signedMessage, timestamp };
}

module.exports = { parseCryptoKeys, decodePublicKeyPem, keyFingerprint, resolveKeys, signIrn };
