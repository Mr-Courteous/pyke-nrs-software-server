const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { buildIrn, generateIrn, irnWithTimestamp } = require('../src/irn/irnGenerator');
const { parseCryptoKeys, resolveKeys, signIrn, keyFingerprint } = require('../src/sign/signer');
const { generateInvoiceQr } = require('../src/qr/qrGenerator');
const { makeKeys, decryptPkcs1 } = require('./helpers');

test('IRN matches the NRS example', () => {
  assert.equal(buildIrn({ invoiceNumber: 'INV001', serviceId: '94ND90NR', issueDate: '2024-06-11' }), 'INV001-94ND90NR-20240611');
});

test('IRN uses the invoice issue date, not today', () => {
  const irn = generateIrn({ invoiceMeta: { invoiceNumber: 'INV/2026/0042', issueDate: '2026-10-28' } }, 'd88c1d73');
  assert.equal(irn, 'INV20260042-D88C1D73-20261028');
  assert.equal(generateIrn({ invoiceMeta: { invoiceNumber: 'INV/2026/0042', issueDate: '2026-10-28' } }, 'd88c1d73'), irn, 'stable across calls');
});

test('IRN rejects what NRS would reject', () => {
  const ok = { invoiceNumber: 'INV001', serviceId: '94ND90NR', issueDate: '2024-06-11' };
  assert.throws(() => buildIrn({ ...ok, invoiceNumber: '---' }), /no letters or digits/);
  assert.throws(() => buildIrn({ ...ok, serviceId: '' }), /Service ID/);
  assert.throws(() => buildIrn({ ...ok, serviceId: '94ND90NRX' }), /Service ID/);
  assert.match(buildIrn({ ...ok, serviceId: '94ND90N' }), /^INV001-94ND90N-20240611$/);
  assert.throws(() => buildIrn({ ...ok, issueDate: '2024-02-30' }), /not a real date/);
  assert.throws(() => buildIrn({ ...ok, issueDate: '' }), /not a real date/);
  assert.throws(() => buildIrn({ ...ok, invoiceNumber: 'A'.repeat(70) }), /at most 80/);
});

test('signing round trip: QR payload decrypts to IRN.timestamp + certificate', async () => {
  const k = makeKeys();
  const { publicKey, certificate } = parseCryptoKeys(JSON.stringify({ public_key: k.publicKey, certificate: k.certificate }));
  const signed = signIrn({ irn: 'INV001-94ND90NR-20240611', certificate, publicKey, timestamp: 1731618237 });
  assert.equal(signed.signedMessage, 'INV001-94ND90NR-20240611.1731618237');
  assert.equal(signed.signedMessage, irnWithTimestamp('INV001-94ND90NR-20240611', 1731618237));
  assert.deepEqual(JSON.parse(decryptPkcs1(k.privateKey, signed.encrypted)), { irn: 'INV001-94ND90NR-20240611.1731618237', certificate: k.certificate });

  const qr = await generateInvoiceQr({ encrypted: signed.encrypted, irn: 'INV001-94ND90NR-20240611' });
  assert.match(qr.dataUrl, /^data:image\/png;base64,/);
  assert.equal(qr.payload, signed.encrypted, 'the QR holds the encrypted string and nothing else');
});

const HAS_OPENSSL = spawnSync('openssl', ['version']).status === 0;
test('signing is compatible with the openssl commands in the NRS doc', { skip: HAS_OPENSSL ? false : 'openssl is not on PATH' }, () => {
  const k = makeKeys();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'si-'));
  fs.writeFileSync(path.join(dir, 'priv.pem'), k.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  fs.writeFileSync(path.join(dir, 'public_key.txt'), k.publicKey);
  execFileSync('openssl', ['base64', '-d', '-A', '-in', path.join(dir, 'public_key.txt'), '-out', path.join(dir, 'public_key.pem')]);
  assert.equal(fs.readFileSync(path.join(dir, 'public_key.pem'), 'utf8').trim(), k.pem.trim());

  const { encrypted } = signIrn({ irn: 'INV001-94ND90NR-20240611', certificate: k.certificate, publicKey: k.publicKey, timestamp: 1731618237 });
  fs.writeFileSync(path.join(dir, 'enc.txt'), encrypted);
  execFileSync('openssl', ['base64', '-d', '-A', '-in', path.join(dir, 'enc.txt'), '-out', path.join(dir, 'enc.bin')]);
  const plain = execFileSync('openssl', ['pkeyutl', '-decrypt', '-inkey', path.join(dir, 'priv.pem'), '-in', path.join(dir, 'enc.bin')]).toString();
  assert.equal(JSON.parse(plain).irn, 'INV001-94ND90NR-20240611.1731618237');
});

test('crypto_keys parsing, key choice and size limits', () => {
  assert.throws(() => parseCryptoKeys('not json'), /not valid JSON/);
  assert.throws(() => parseCryptoKeys({ public_key: 'abc', certificate: 'x' }), /RSA public key/);
  assert.throws(() => parseCryptoKeys({ public_key: makeKeys().publicKey }), /both/);

  const own = makeKeys(); const env = makeKeys();
  const envVars = { NRS_PUBLIC_KEY: env.publicKey, NRS_CERTIFICATE: 'envcert' };
  assert.equal(resolveKeys({ publicKey: own.publicKey, certificate: 'owncert' }, envVars).source, 'company');
  assert.equal(resolveKeys({}, envVars).source, 'environment');
  assert.equal(resolveKeys({}, {}), null);
  assert.notEqual(keyFingerprint(own.publicKey), keyFingerprint(env.publicKey));

  const small = makeKeys(1024);
  assert.throws(() => signIrn({ irn: 'X'.repeat(70), certificate: 'c'.repeat(120), publicKey: small.publicKey }), /can encrypt at most/);
});

test('the account-wide key can be given as NRS_CRYPTO_KEYS (the whole crypto_keys.txt)', () => {
  const { resolveKeys } = require('../src/sign/signer');
  const k = makeKeys();
  const file = JSON.stringify({ public_key: k.publicKey, certificate: k.certificate });
  const got = resolveKeys(null, { NRS_CRYPTO_KEYS: file });
  assert.equal(got.source, 'environment');
  assert.equal(got.certificate, k.certificate);
  assert.equal(resolveKeys(null, { NRS_CRYPTO_KEYS: '{not json' }), null, 'unreadable keys count as no keys');
  assert.equal(resolveKeys({ publicKey: k.publicKey, certificate: 'own' }, { NRS_CRYPTO_KEYS: file }).source, 'company', 'a company\'s own keys still win');
});
