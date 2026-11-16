const crypto = require('crypto');

/** A realistic QuickBooks Online invoice: two lines (one taxed, one not), tax-exclusive. */
function makeKeys(bits = 2048) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: bits });
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  return { privateKey, publicKey: Buffer.from(pem).toString('base64'), certificate: 'bEF0V3FJbmo5cVZYbEdCblB4QVpjMG9HVWFrc29GM2hiYWFkYWMyODRBUT0=', pem };
}

/** Node 22+ refuses RSA_PKCS1_PADDING for decryption, so strip the padding by hand (tests only). */
function decryptPkcs1(privateKey, base64) {
  const em = crypto.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_NO_PADDING }, Buffer.from(base64, 'base64'));
  if (em[0] !== 0x00 || em[1] !== 0x02) throw new Error('Not PKCS#1 v1.5 (type 2) padded data');
  const sep = em.indexOf(0x00, 2);
  if (sep < 10) throw new Error('Bad padding');
  return em.subarray(sep + 1);
}

module.exports = { makeKeys, decryptPkcs1 };
