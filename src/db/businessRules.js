const { SERVICE_ID_RE } = require('../irn/irnGenerator');
const { checkState, checkLga } = require('../nrs/nigeriaStates');

const bad = (message) => Object.assign(new Error(message), { status: 400 });

/**
 * Validates the NRS fields a person can type into the Companies form.
 *   nrsBusinessId  the Business ID NRS issued (a UUID in the NRS docs)
 *   irnSuffix      the Service ID (the fixed middle part of the IRN)
 * Returns only the fields to write.
 */
function linkFields(input) {
  const out = {};
  if (input.nrsBusinessId !== undefined) {
    const v = String(input.nrsBusinessId ?? '').trim();
    out.nrsBusinessId = v || null;
  }
  if (input.irnSuffix !== undefined) {
    const v = String(input.irnSuffix ?? '').trim().toUpperCase();
    if (v && !SERVICE_ID_RE.test(v)) throw bad('The Service ID must be 1 to 8 letters or digits, for example 94ND90NR.');
    out.irnSuffix = v || null;
  }
  return out;
}

/** State and LGA typed on the Companies form. */
function addressFields(input) {
  const out = {};
  if (input.state !== undefined) { const r = checkState(input.state); if (r.error) throw bad(r.error); out.state = r.value; }
  if (input.lga !== undefined) { const r = checkLga(input.lga); if (r.error) throw bad(r.error); out.lga = r.value; }
  return out;
}

module.exports = { linkFields, addressFields };
