const test = require('node:test');
const assert = require('node:assert/strict');
const { linkFields, addressFields } = require('../src/db/businessRules');
const { createCustomerDetailStore, missingOf } = require('../src/db/customerDetailStore');
const { checkState, checkLga } = require('../src/nrs/nigeriaStates');

test('a company can be given its NRS Business ID and Service ID by hand', () => {
  assert.deepEqual(linkFields({ nrsBusinessId: ' 6dj03c76-1d83-4a39-a4de-51bd70547aef ', irnSuffix: ' 94nd90nr ' }), {
    nrsBusinessId: '6dj03c76-1d83-4a39-a4de-51bd70547aef', irnSuffix: '94ND90NR',
  });
  assert.deepEqual(linkFields({ nrsBusinessId: '', irnSuffix: '' }, { source: 'LOCAL' }), { nrsBusinessId: null, irnSuffix: null }, 'clearing is allowed');
  assert.deepEqual(linkFields({}, { source: 'LOCAL' }), {}, 'untouched when not supplied');
});

test('a Service ID of 1 to 8 letters/digits is accepted; anything else is refused', () => {
  for (const ok of ['94ND90NR', '94ND90N', 'AB12']) {
    assert.equal(linkFields({ irnSuffix: ok }, { source: 'LOCAL' }).irnSuffix, ok.toUpperCase());
  }
  for (const bad of ['94ND-90NR', '94ND90NRX', 'AB 12']) {
    assert.throws(() => linkFields({ irnSuffix: bad }, { source: 'LOCAL' }), (e) => e.status === 400 && /1 to 8/.test(e.message));
  }
});

test('state and LGA are checked', () => {
  assert.deepEqual(addressFields({ state: 'Lagos', lga: 'ng-la-ikj' }), { state: 'Lagos', lga: 'NG-LA-IKJ' });
  assert.deepEqual(addressFields({ state: '', lga: '' }), { state: null, lga: null });
  assert.throws(() => addressFields({ lga: 'Ikeja' }), /LGA code/);
  assert.throws(() => addressFields({ state: 'Mars' }), /not a Nigerian state/);
  assert.ok(checkState('NG-LA').value && checkLga('NG-AB-ANO').value);
});

function fake() {
  const rows = [];
  return { rows, customerDetail: {
    async upsert({ where, create, update }) { const { source, externalRef } = where.source_externalRef; let r = rows.find((x) => x.source === source && x.externalRef === externalRef); if (r) Object.assign(r, update); else { r = { id: `c${rows.length + 1}`, tin: null, email: null, phone: null, street: null, city: null, state: null, lga: null, postalZone: null, ...create }; rows.push(r); } return r; },
    async findMany() { return rows; },
    async update({ where, data }) { const r = rows.find((x) => x.id === where.id); if (!r) throw Object.assign(new Error('x'), { code: 'P2025' }); Object.assign(r, data); return r; },
  } };
}

test('customer details: created once, entries win, source values kept', async () => {
  const p = fake(); const s = createCustomerDetailStore(() => p);
  const m = () => ({ buyer: { ref: '58', name: 'XYZ Ltd', tin: '', street: '1 Road', city: 'Ikoyi', state: 'Lagos', address: '' } });

  const first = await s.attach(m(), 'qbo');
  assert.equal(p.rows.length, 1);
  assert.equal(first.buyer.tin, '');
  assert.equal(first.buyer.address, '1 Road, Ikoyi, Lagos', 'one-line address is built from real parts');
  assert.deepEqual(missingOf(p.rows[0]), ['tin', 'lga']);

  await s.update('c1', { tin: '33467982-0001', state: 'Ogun' });
  const second = await s.attach(m(), 'qbo');
  assert.equal(p.rows.length, 1, 'no duplicate row');
  assert.equal(second.buyer.tin, '33467982-0001');
  assert.equal(second.buyer.state, 'Ogun', 'the entered value wins');
  assert.equal(second.buyer.city, 'Ikoyi', 'untouched fields still come from the source');
  assert.equal(second.sourceBuyer.state, 'Lagos', 'the source value is kept');

  // attaching to an already-overridden invoice does not mistake the override for the source's value
  const third = await s.attach(second, 'qbo');
  assert.equal(third.sourceBuyer.state, 'Lagos');
  assert.equal(p.rows[0].observed.state, 'Lagos');
});

test('customers are listed by what they still need', async () => {
  const p = fake(); const s = createCustomerDetailStore(() => p);
  await s.attach({ buyer: { ref: '1', name: 'A', tin: '1', city: 'x', state: 'Lagos', lga: 'NG-LA-IKJ' } }, 'qbo');
  await s.attach({ buyer: { ref: '2', name: 'B' } }, 'qbo');
  assert.deepEqual((await s.list({ needsDetails: true })).map((r) => r.name), ['B']);
  assert.equal((await s.list()).length, 2);
  await assert.rejects(() => s.update('nope', { tin: '1' }), (e) => e.status === 404);
});
