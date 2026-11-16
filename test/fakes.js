// In-memory stand-ins for the database, shared by the pipeline and intake tests.
// The REAL product-code and customer-detail logic runs over in-memory tables.
const path = require('path');
const { createProductCodeStore } = require('../src/db/productCodeStore');
const { createCustomerDetailStore } = require('../src/db/customerDetailStore');
const { makeKeys } = require('./helpers');

const clone = (v) => structuredClone(v);

const records = new Map();
let seq = 0;
const fakeStore = {
  async create({ sourceSystem, raw, sourceRef = null, businessId = null }) {
    if (sourceRef && [...records.values()].some((r) => r.sourceSystem === sourceSystem && r.sourceRef === sourceRef)) {
      throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    }
    const r = { id: `inv${++seq}`, status: 'RECEIVED', sourceSystem, sourceRef, raw, mapped: null, errors: null, signature: null, irn: null, qr: null, businessId };
    records.set(r.id, r);
    return clone(r);
  },
  async update(id, patch) { Object.assign(records.get(id), patch); return clone(records.get(id)); },
  async get(id) { return records.has(id) ? clone(records.get(id)) : null; },
  async list() { return [...records.values()].map(clone); },
  async findBySourceRef(sourceSystem, sourceRef) {
    const r = sourceRef && [...records.values()].find((x) => x.sourceSystem === sourceSystem && x.sourceRef === sourceRef);
    return r ? clone(r) : null;
  },
  async findIrnClash(irn, exceptId) {
    const r = [...records.values()].find((x) => x.irn === irn && x.id !== exceptId);
    return r ? { id: r.id, status: r.status } : null;
  },
};

const keys = makeKeys();
const businesses = new Map();
const fakeBusinessStore = {
  async get(id) { const b = businesses.get(id); if (!b) return null; const { publicKey, certificate, ...rest } = b; return clone(rest); },
  async getForSigning(id) { return businesses.has(id) ? clone(businesses.get(id)) : null; },
};

const table = []; // product codes
const fakePrisma = { productCode: {
  async createMany({ data }) { for (const d of data) if (!table.some((r) => r.source === d.source && r.externalRef === d.externalRef)) table.push({ id: `pc${table.length + 1}`, hsnCode: null, productCategory: null, ...d }); },
  async findMany({ where }) { return table.filter((r) => r.source === where.source && where.externalRef.in.includes(r.externalRef)); },
} };

const customers = []; // buyer details
const fakeCustomerPrisma = { customerDetail: {
  async upsert({ where, create, update }) {
    const { source, externalRef } = where.source_externalRef;
    let r = customers.find((x) => x.source === source && x.externalRef === externalRef);
    if (r) Object.assign(r, update);
    else { r = { id: `cd${customers.length + 1}`, tin: null, email: null, phone: null, street: null, city: null, state: null, lga: null, postalZone: null, ...create }; customers.push(r); }
    return r;
  },
  async findMany() { return customers; },
  async update({ where, data }) { const r = customers.find((x) => x.id === where.id); Object.assign(r, data); return r; },
} };

function stub(rel, exports) {
  const id = require.resolve(path.join(__dirname, '..', 'src', rel));
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
stub('db/store.js', fakeStore);
stub('db/businessStore.js', fakeBusinessStore);
stub('db/productCodeStore.js', createProductCodeStore(() => fakePrisma));
stub('db/customerDetailStore.js', createCustomerDetailStore(() => fakeCustomerPrisma));
stub('db/prismaClient.js', {}); // anything that would really use it is replaced above

const company = (over = {}) => ({
  id: 'biz1', name: 'Acme Supplies Ltd', tin: '12345678-0001', nrsBusinessId: 'nrs-1', irnSuffix: '94ND90NR', hasServiceId: true,
  address: '32 Owonikoko Street', email: 'billing@acme.example', phone: '+2348030000000', city: 'Ikeja', postalZone: '023401', state: 'Lagos', lga: 'NG-LA-IKJ',
  publicKey: keys.publicKey, certificate: keys.certificate, ...over,
});
businesses.set('biz1', company());

/** An invoice in the standard shape (what a connector sends, or what is typed in). */
const invoice = (over = {}) => ({
  invoiceNumber: 'INV-0042', issueDate: '2026-10-28', currency: 'NGN', vatRate: 7.5,
  buyer: { ref: 'C1', name: 'Buyer Ltd', tin: '98765432-0001', email: 'buyer@example.com', street: '1 Buyer Street', address: '1 Buyer Street, Ikeja', city: 'Ikeja', state: 'Lagos', lga: 'NG-LA-IKJ', postalZone: '100271', country: 'NG' },
  items: [
    { description: 'Cement 50kg', productRef: 'I1', quantity: 10, unitPrice: 5500 },
    { description: 'Delivery', productRef: 'I2', quantity: 1, unitPrice: 15000 },
  ],
  ...over,
});

const fillCodes = () => table.forEach((r) => { r.hsnCode = '2523.29'; r.productCategory = 'Cements'; });

module.exports = { records, businesses, table, customers, keys, company, invoice, fillCodes, fakeStore };
