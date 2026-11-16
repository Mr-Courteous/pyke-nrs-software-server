const { checkState, checkLga } = require('../nrs/nigeriaStates');

/**
 * Buyer details QuickBooks does not hold: TIN (unless a TIN custom field is
 * filled in), state, LGA code, postal zone and so on.
 *
 * A row is created automatically the first time an invoice for a customer
 * arrives. `observed` keeps what the source system supplied, shown as a hint
 * on the Customer details page; the person's own entries sit beside it and
 * win wherever they are filled in. Nothing is guessed: a detail that is in
 * neither place stays blank and shows up in `missing`.
 */
const FIELDS = ['tin', 'email', 'phone', 'street', 'city', 'state', 'lga', 'postalZone'];
const NEEDED = ['tin', 'city', 'state', 'lga']; // what NRS payloads need that sources often lack
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const keyOf = (buyer) => buyer.ref || norm(buyer.name);
const filled = (v) => v !== undefined && v !== null && String(v).trim() !== '';

const missingOf = (row) => NEEDED.filter((f) => !filled(row[f]) && !filled(row.observed?.[f]));

function createCustomerDetailStore(getPrisma) {
  /** Adds the person's entries to mapped.buyer. Safe to call repeatedly. */
  async function attach(mapped, sourceSystem) {
    const prisma = getPrisma();
    const source = sourceSystem || 'unknown';
    const original = mapped.sourceBuyer || { ...mapped.buyer }; // what the source said, before any override
    mapped.sourceBuyer = original;
    if (!original.name && !original.ref) { mapped.buyer = { ...original }; return mapped; }

    const externalRef = keyOf(original);
    const observed = Object.fromEntries(FIELDS.map((f) => [f, original[f] || null]));
    const row = await prisma.customerDetail.upsert({
      where: { source_externalRef: { source, externalRef } },
      create: { source, externalRef, name: original.name || externalRef, observed },
      update: { name: original.name || externalRef, observed },
    });

    const buyer = { ...original };
    for (const f of FIELDS) if (filled(row[f])) buyer[f] = String(row[f]).trim();
    if (!filled(buyer.address)) buyer.address = [buyer.street, buyer.city, buyer.state].filter(filled).join(', ');
    mapped.buyer = buyer;
    return mapped;
  }

  async function list({ needsDetails } = {}) {
    const rows = (await getPrisma().customerDetail.findMany({ orderBy: [{ updatedAt: 'desc' }] })).map((r) => ({ ...r, missing: missingOf(r) }));
    return needsDetails ? rows.filter((r) => r.missing.length) : rows;
  }

  async function update(id, input) {
    const data = {};
    for (const f of FIELDS) if (input[f] !== undefined) data[f] = filled(input[f]) ? String(input[f]).trim() : null;
    const fail = (message) => { throw Object.assign(new Error(message), { status: 400 }); };
    if (data.state) { const r = checkState(data.state); if (r.error) fail(r.error); }
    if (data.lga) { const r = checkLga(data.lga); if (r.error) fail(r.error); data.lga = r.value; }
    try {
      const row = await getPrisma().customerDetail.update({ where: { id }, data });
      return { ...row, missing: missingOf(row) };
    } catch (err) {
      if (err.code === 'P2025') throw Object.assign(new Error('Customer not found.'), { status: 404 });
      throw err;
    }
  }

  return { attach, list, update };
}

module.exports = createCustomerDetailStore(() => require('./prismaClient'));
module.exports.createCustomerDetailStore = createCustomerDetailStore;
module.exports.missingOf = missingOf;
