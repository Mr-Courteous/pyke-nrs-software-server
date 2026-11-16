/** ISO 3166-2:NG subdivision codes, so a QuickBooks address "Lagos" becomes "NG-LA". */
const STATES = {
  AB: 'Abia', AD: 'Adamawa', AK: 'Akwa Ibom', AN: 'Anambra', BA: 'Bauchi', BY: 'Bayelsa', BE: 'Benue', BO: 'Borno',
  CR: 'Cross River', DE: 'Delta', EB: 'Ebonyi', ED: 'Edo', EK: 'Ekiti', EN: 'Enugu', FC: 'Federal Capital Territory',
  GO: 'Gombe', IM: 'Imo', JI: 'Jigawa', KD: 'Kaduna', KN: 'Kano', KT: 'Katsina', KE: 'Kebbi', KO: 'Kogi', KW: 'Kwara',
  LA: 'Lagos', NA: 'Nasarawa', NI: 'Niger', OG: 'Ogun', ON: 'Ondo', OS: 'Osun', OY: 'Oyo', PL: 'Plateau', RI: 'Rivers',
  SO: 'Sokoto', TA: 'Taraba', YO: 'Yobe', ZA: 'Zamfara',
};
const norm = (s) => String(s).toLowerCase().replace(/\bstate\b/g, '').replace(/[^a-z]/g, '');
const BY_NAME = Object.fromEntries(Object.entries(STATES).map(([code, name]) => [norm(name), `NG-${code}`]));
Object.assign(BY_NAME, { fct: 'NG-FC', abuja: 'NG-FC', fctabuja: 'NG-FC', akwaibom: 'NG-AK', crossriver: 'NG-CR' });

/** Returns "NG-LA" style code, or undefined when it cannot be determined (never guesses). */
function toStateCode(value) {
  if (!value) return undefined;
  const v = String(value).trim();
  if (/^NG-[A-Z]{2}$/i.test(v)) return v.toUpperCase();
  if (/^[A-Za-z]{2}$/.test(v) && STATES[v.toUpperCase()]) return `NG-${v.toUpperCase()}`;
  return BY_NAME[norm(v)];
}

/** LGA codes are NRS's, e.g. NG-LA-IKJ. We only check the shape; copy the exact code from NRS. */
const LGA_RE = /^NG-[A-Z]{2}-[A-Z0-9]{2,5}$/;

/** Returns { value } (normalised, or null when blank) or { error }. */
function checkState(v) {
  const t = String(v ?? '').trim();
  if (!t) return { value: null };
  return toStateCode(t) ? { value: t } : { error: `"${t}" is not a Nigerian state. Use the state name (Lagos) or its code (NG-LA).` };
}
function checkLga(v) {
  const t = String(v ?? '').trim().toUpperCase();
  if (!t) return { value: null };
  return LGA_RE.test(t) ? { value: t } : { error: `"${v}" is not an LGA code. It looks like NG-LA-IKJ (copy it from NRS).` };
}

module.exports = { toStateCode, checkState, checkLga, STATES };
