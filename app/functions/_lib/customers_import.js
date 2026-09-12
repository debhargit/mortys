// CSV/TSV importer for bulk customer upload — creates new customer accounts
// and updates existing ones (matched by account number or email) in one
// pass, the same shape as the inventory importer but for users instead of
// products: mode=preview reports without writing, mode=commit does the work.
//
// Row shape (per line): { name, email|null, phone|null, company_name|null,
//   customer_type|null, price_tier, credit_type|null, credit_limit_usd|null,
//   payment_terms_days|null, discount_pct|null, tax_exempt, tax_id|null,
//   account_number|null, notes|null, line }.

import {
  readTabular, detectHeader, cellText, toMoney, toInt, isBlankRow,
} from './inventory_import.js';

const FIELD_SYNONYMS = {
  name: ['name', 'customer_name', 'full_name', 'contact_name'],
  email: ['email', 'customer_email', 'e_mail'],
  phone: ['phone', 'customer_phone', 'telephone', 'tel', 'mobile', 'cell'],
  company_name: ['company', 'company_name', 'business', 'business_name'],
  customer_type: ['customer_type', 'type', 'segment', 'category'],
  price_tier: ['price_tier', 'tier', 'pricing_tier'],
  credit_type: ['credit_type', 'credit', 'terms_type'],
  credit_limit_usd: ['credit_limit_usd', 'credit_limit', 'limit', 'credit_limit_amount'],
  payment_terms_days: ['payment_terms_days', 'payment_terms', 'terms_days', 'net_days', 'net_terms'],
  discount_pct: ['discount_pct', 'discount', 'discount_percent', 'discount_percentage'],
  tax_exempt: ['tax_exempt', 'exempt', 'tax_free'],
  tax_id: ['tax_id', 'trn', 'vat_id', 'tax_number'],
  account_number: ['account_number', 'account', 'acct', 'acct_no', 'customer_number', 'account_no'],
  notes: ['notes', 'note', 'internal_notes', 'comment', 'comments'],
};
const CANONICAL_FIELDS = Object.keys(FIELD_SYNONYMS);

const HEADER_LOOKUP = (() => {
  const m = new Map();
  for (const field of CANONICAL_FIELDS) {
    for (const syn of FIELD_SYNONYMS[field]) {
      if (!m.has(syn)) m.set(syn, field);
    }
  }
  return m;
})();

const PRICE_TIERS = ['retail', 'trade', 'fleet', 'dealer'];
const CREDIT_TYPES = ['cash', 'open', 'revolving', 'cod'];

function toBoolish(raw) {
  const t = cellText(raw).toLowerCase().trim();
  return ['y', 'yes', 'true', '1', 'exempt'].includes(t);
}

// Left null rather than defaulted here when the file has nothing to say --
// a blank/unrecognised cell on a row that turns out to *update* an existing
// customer must mean "leave it as-is", not silently reset a fleet account
// back to retail. The route defaults a still-null tier to 'retail' only for
// a brand new customer, who needs one from something.
function normaliseTier(raw) {
  const t = cellText(raw).toLowerCase().trim();
  if (!t) return { value: null, guessed: false };
  if (PRICE_TIERS.includes(t)) return { value: t, guessed: false };
  return { value: null, guessed: true };
}

// credit_type is DB-constrained (cash|open|revolving|cod|null) -- an
// unrecognised value is left null rather than guessed at, since guessing
// wrong here has billing consequences a bad price-tier guess doesn't.
function normaliseCreditType(raw) {
  const t = cellText(raw).toLowerCase().trim();
  if (!t) return { value: null, guessed: false };
  if (CREDIT_TYPES.includes(t)) return { value: t, guessed: false };
  return { value: null, guessed: true };
}

function buildRows(rows, headerIndex, mapping) {
  const items = [];
  const issues = [];
  const seenKeys = new Map();

  const get = (row, field) => {
    const col = mapping[field];
    return col == null ? '' : cellText(row[col]);
  };

  for (let i = headerIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    if (isBlankRow(row)) continue;
    const lineNo = i + 1;

    const name = get(row, 'name');
    if (!name) {
      issues.push({ line: lineNo, level: 'skipped', message: 'no name to identify this customer by' });
      continue;
    }

    const email = get(row, 'email').toLowerCase() || null;
    const accountNumber = get(row, 'account_number') || null;

    const key = accountNumber || email;
    if (key) {
      if (seenKeys.has(key)) {
        issues.push({
          line: lineNo, level: 'duplicate',
          message: '"' + key + '" also appears on line ' + seenKeys.get(key) + ' - the later row wins',
        });
      }
      seenKeys.set(key, lineNo);
    }

    const tier = normaliseTier(get(row, 'price_tier'));
    if (mapping.price_tier != null && get(row, 'price_tier') && tier.guessed)
      issues.push({ line: lineNo, level: 'warning', message: 'price tier "' + get(row, 'price_tier') + '" not recognised - left unset (defaults to retail for a new customer)' });

    const creditType = normaliseCreditType(get(row, 'credit_type'));
    if (mapping.credit_type != null && get(row, 'credit_type') && creditType.guessed)
      issues.push({ line: lineNo, level: 'warning', message: 'credit type "' + get(row, 'credit_type') + '" not recognised - left unset' });

    const creditLimitRaw = get(row, 'credit_limit_usd');
    const creditLimit = toMoney(creditLimitRaw);
    if (creditLimitRaw && creditLimit == null)
      issues.push({ line: lineNo, level: 'warning', message: 'credit limit "' + creditLimitRaw + '" is not a number - left blank' });

    const termsRaw = get(row, 'payment_terms_days');
    const terms = toInt(termsRaw, null);
    if (termsRaw && terms == null)
      issues.push({ line: lineNo, level: 'warning', message: 'payment terms "' + termsRaw + '" is not a number - left blank' });

    const discRaw = get(row, 'discount_pct');
    let disc = toMoney(discRaw);
    if (discRaw && disc == null)
      issues.push({ line: lineNo, level: 'warning', message: 'discount "' + discRaw + '" is not a number - left blank' });
    if (disc != null && (disc < 0 || disc > 100)) {
      issues.push({ line: lineNo, level: 'warning', message: 'discount ' + disc + '% is out of range (0-100) - left blank' });
      disc = null;
    }

    items.push({
      name,
      email,
      phone: get(row, 'phone') || null,
      company_name: get(row, 'company_name') || null,
      customer_type: get(row, 'customer_type') || null,
      price_tier: tier.value,
      credit_type: creditType.value,
      credit_limit_usd: creditLimit,
      payment_terms_days: terms,
      discount_pct: disc,
      tax_exempt: toBoolish(get(row, 'tax_exempt')),
      tax_id: get(row, 'tax_id') || null,
      account_number: accountNumber,
      notes: get(row, 'notes') || null,
      line: lineNo,
    });
  }

  return { items, issues };
}

export function parseCustomersFile(buffer, filename) {
  const { rows, format, detail } = readTabular(buffer, filename);
  if (!rows.length) {
    const err = new Error('That file has no rows in it.');
    err.userFacing = true;
    throw err;
  }

  const header = detectHeader(rows, 25, HEADER_LOOKUP);
  if (header.headerIndex === -1) {
    const err = new Error(
      'Could not find a header row. The file needs a row naming the columns - ' +
      'at least a customer name. Recognised names include: Name, Email, Phone, ' +
      'Company, Account Number, Price Tier, Credit Limit.');
    err.userFacing = true;
    throw err;
  }

  const { items, issues } = buildRows(rows, header.headerIndex, header.mapping);
  return {
    format,
    detail,
    headerLine: header.headerIndex + 1,
    headers: header.headers,
    mapped: Object.keys(header.mapping).reduce((acc, f) => {
      acc[f] = header.headers[header.mapping[f]];
      return acc;
    }, {}),
    ignoredColumns: header.unmapped,
    totalDataRows: rows.length - header.headerIndex - 1,
    items,
    issues,
  };
}

// Offered as a download from the admin panel so there is a known-good shape
// to start from. account_number is left blank on two rows on purpose, to
// show that one gets assigned automatically for a new customer.
export const CUSTOMERS_TEMPLATE_CSV = [
  'name,email,phone,company_name,customer_type,price_tier,credit_type,credit_limit_usd,payment_terms_days,discount_pct,account_number,notes',
  'Jane Doe,jane@example.com,876-555-0101,,retail,retail,cash,,,,,',
  'Kingston Fleet Services,ap@kingstonfleet.com,876-555-0199,Kingston Fleet Services,fleet,fleet,open,5000,30,10,,',
  'Bob\'s Garage,,876-555-0142,Bob\'s Garage,trade,trade,revolving,2000,15,5,,',
].join('\r\n') + '\r\n';

export { FIELD_SYNONYMS as CUSTOMERS_FIELD_SYNONYMS };
