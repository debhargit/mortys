// Fills a THROWAWAY till (its own empty database) with made-up Jamaican sample
// data for the website's demo (see tools/demo-record.mjs). Never the live till.
//
//   DEMO_TILL_URL=http://127.0.0.1:3396 DEMO_PSQL="psql -h 127.0.0.1 -p 5498 -U postgres -d demo" node tools/demo-seed.mjs
import { execSync } from 'node:child_process';
const BASE = process.env.DEMO_TILL_URL || 'http://127.0.0.1:3396';
const PSQL = process.env.DEMO_PSQL || 'psql -h 127.0.0.1 -p 5498 -U postgres -d demo';
if (/:(3056|3059)\b/.test(BASE) || /-p\s*5435\b/.test(PSQL)) { console.log('refusing to fill the live till'); process.exit(1); }
const sql = (q) => execSync(PSQL + ' -tA', { input: q, encoding: 'utf8' }).trim();
const jar = {};
async function api(method, url, body) {
  const r = await fetch(BASE + url, { method, headers: Object.assign({ Accept: 'application/json', Cookie: Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ') }, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
  for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) console.log('  !', method, url, r.status, j.error || '');
  return j;
}
const day = (n) => new Date(Date.now() - 5 * 3600000 + n * 86400000).toISOString().slice(0, 10);

const si = await api('POST', '/api/auth/signin', { email: 'admin@visionautosolutions.com', password: 'password123' });
if (si.error) { console.log('not signed in'); process.exit(1); }
await api('POST', '/api/payroll/module', { on: true });

// ---- People & payroll
const STAFF = [
  ['Mr', 'Andre Campbell', 'male', '1988-03-14', 'Store manager', 'salary', 2400000, 'Kingston', 'St. Andrew', '123-456-781', 'A123451', -1400],
  ['Ms', 'Tanisha Brown', 'female', '1995-07-22', 'Cashier', 'hourly', 0, 'Portmore', 'St. Catherine', '123-456-782', 'A123452', -600],
  ['Mr', 'Kemar Williams', 'male', '1992-11-02', 'Parts counter clerk', 'hourly', 0, 'Spanish Town', 'St. Catherine', '123-456-783', 'A123453', -900],
  ['Ms', 'Shanice Thompson', 'female', '1990-01-30', 'Accounts clerk', 'salary', 1650000, 'Half Way Tree', 'St. Andrew', '123-456-784', 'A123454', -1100],
  ['Mr', 'Dwayne Reid', 'male', '1985-09-09', 'Warehouse supervisor', 'salary', 1500000, 'Old Harbour', 'St. Catherine', '123-456-785', 'A123455', -2000],
  ['Ms', 'Kerry-Ann Grant', 'female', '1998-05-17', 'Sales associate', 'hourly', 0, 'Mandeville', 'Manchester', '123-456-786', 'A123456', -200],
  ['Mr', 'Romaine Palmer', 'male', '1993-12-25', 'Delivery driver', 'hourly', 0, 'May Pen', 'Clarendon', '123-456-787', 'A123457', -450],
  ['Ms', 'Sasha-Gaye Morgan', 'female', '1987-04-08', 'HR officer', 'salary', 1800000, 'Constant Spring', 'St. Andrew', '123-456-788', 'A123458', -1600],
];
const ids = [];
for (const [sal, name, g, dob, job, pt, salary, town, parish, trn, nis, startAgo] of STAFF) {
  const first = name.split(' ')[0].toLowerCase();
  const r = await api('POST', '/api/people/new-employee', {
    personal: { salutation: sal, name, legal_name: name, preferred_name: name.split(' ')[0], gender: g, date_of_birth: dob, marital_status: 'single' },
    contact: { mobile: '876-55' + (ids.length + 1) + '-' + (1200 + ids.length * 37), email: first + '@demo.example', address: (12 + ids.length * 7) + ' Hope Road', town, parish },
    employment: { job_title: job, start_date: day(startAgo), probation_months: startAgo > -120 ? 3 : 0, job_description: job + ' at the Kingston store.' },
    payroll: { add: true, pay_on: true, trn, nis_no: nis, pay_type: pt, salary_annual: salary, hourly_rate: pt === 'hourly' ? 850 + ids.length * 40 : 0, frequency: pt === 'salary' ? 'monthly' : 'fortnightly', pay_method: 'bank', bank_name: 'NCB', bank_branch: 'Half Way Tree', bank_account: '4040' + (100200 + ids.length) },
    emergency: { name: 'Next of kin of ' + name.split(' ')[0], relationship: 'Parent', phone: '876-99' + ids.length + '-0000' },
    confirm_duplicate: true,
  });
  ids.push(r.id);
}
console.log('staff', ids.length);
// Notes and to do's
for (const [i, txt] of [[0, 'Completed supervisor training at the Kingston store.'], [1, 'Asked for weekend shifts during December.'], [4, 'Forklift licence renewed.']]) await api('POST', '/api/people/staff/' + ids[i] + '/notes', { kind: 'note', body: txt });
await api('POST', '/api/people/staff/' + ids[2] + '/notes', { kind: 'todo', body: 'Probation review meeting', due_on: day(5), priority: 'high' });

// ---- Suppliers and customers (straight into the throwaway database)
sql(`INSERT INTO suppliers (name, contact_name, phone, email, address, payment_terms_days, payment_terms, is_active) VALUES
  ('Island Auto Parts Ltd', 'Marcia Henry', '876-922-1100', 'orders@islandauto.example', '45 Spanish Town Road, Kingston 11', 30, 'Net 30', true),
  ('Caribbean Lubricants Co.', 'Paul Chin', '876-923-4500', 'sales@caribelube.example', '8 Marcus Garvey Drive, Kingston', 15, 'Net 15', true),
  ('JPS (electricity)', NULL, '888-225-5577', NULL, 'Knutsford Blvd, Kingston 5', 14, 'Net 14', true),
  ('Digicel Business', NULL, '876-619-5000', NULL, 'Ocean Blvd, Kingston', 21, 'Net 21', true),
  ('Kingston Tyre Distributors', 'Neville Gayle', '876-937-2200', 'neville@kingstontyre.example', '22 Hagley Park Road, Kingston 10', 30, 'Net 30', true)`);
const sup = sql(`SELECT string_agg(id::text, ',' ORDER BY id) FROM suppliers`).split(',').map(Number);
sql(`INSERT INTO users (email, name, phone, is_admin, is_staff, company_name, customer_type, payment_terms_days, credit_limit_usd, account_number) VALUES
  ('fleet@sunshinetaxi.example', 'Sunshine Taxi Co-op', '876-901-2233', false, false, 'Sunshine Taxi Co-op', 'business', 30, 500000, 'C-1001'),
  ('accounts@blueriverhaulage.example', 'Blue River Haulage', '876-955-8811', false, false, 'Blue River Haulage', 'business', 30, 800000, 'C-1002'),
  ('garage@mobaygarage.example', 'Montego Bay Garage', '876-952-3344', false, false, 'Montego Bay Garage', 'business', 15, 300000, 'C-1003'),
  ('marlon.f@demo.example', 'Marlon Francis', '876-888-1212', false, false, NULL, 'retail', 0, 0, 'C-1004')`);
const cus = sql(`SELECT string_agg(id::text, ',' ORDER BY id) FROM users WHERE account_number LIKE 'C-10%'`).split(',').map(Number);

// ---- Accounts
const acc = (await api('GET', '/api/books/accounts')).accounts || [];
const pick = (re, f) => (acc.find((a) => re.test(a.name) && (!f || f(a))) || {}).id;
let bank = acc.find((a) => a.qb_type === 'BANK');
if (!bank) { await api('POST', '/api/bank/accounts', { name: 'NCB Business Chequing', code: '1025' }); bank = ((await api('GET', '/api/books/accounts')).accounts || []).find((a) => a.qb_type === 'BANK'); }
const exp = (re) => pick(re, (a) => a.type === 'expense') || pick(/expense|supplies|purchases/i, (a) => a.type === 'expense');
const inc = pick(/sales|income|revenue/i, (a) => a.type === 'income' || a.type === 'revenue');
console.log('bank', bank && bank.id, 'income', inc);

// ---- Bills and payments
const bills = [
  [0, 'IAP-20431', -40, 'Brake pads, filters and belts', /inventory|purchases|cost of goods/i, 186500],
  [0, 'IAP-20488', -12, 'Shock absorbers (Toyota Corolla)', /inventory|purchases|cost of goods/i, 94300],
  [1, 'CL-7712', -20, 'Engine oil 5W-30, 40 cases', /inventory|purchases|cost of goods/i, 132000],
  [2, 'JPS-0925', -18, 'Electricity, October', /utilit|electric/i, 48760],
  [3, 'DGB-11-25', -9, 'Phones and internet, October', /telephone|internet|utilit/i, 21450],
  [4, 'KTD-5530', -3, 'Tyres 195/65R15, 24 units', /inventory|purchases|cost of goods/i, 312000],
];
const billIds = [];
for (const [s, no, ago, memo, re, amt] of bills) {
  const r = await api('POST', '/api/ap/bills', { supplier_id: sup[s], number: no, bill_date: day(ago), memo, gct_amount: Math.round(amt * 0.15), lines: [{ account_id: exp(re), description: memo, amount: amt }] });
  billIds.push(r.id);
}
await api('POST', '/api/ap/payments', { supplier_id: sup[0], method: 'cheque', cheque_number: '001245', account_id: bank.id, pay_date: day(-10), bills: [{ kind: 'bill', id: billIds[0], amount: Math.round(186500 * 1.15) }] });
await api('POST', '/api/ap/payments', { supplier_id: sup[2], method: 'transfer', account_id: bank.id, pay_date: day(-5), bills: [{ kind: 'bill', id: billIds[3], amount: Math.round(48760 * 1.15) }] });

// ---- Customer invoices and payments
const invs = [[0, -35, 'Fleet service parts, October', 268400], [1, -25, 'Truck filters and lubricants', 415750], [2, -14, 'Brake parts for workshop', 98200], [0, -6, 'Tyres for 6 taxis', 384000], [1, -2, 'Clutch kits (2)', 156300]];
const invIds = [];
for (const [c, ago, memo, amt] of invs) {
  const r = await api('POST', '/api/ar/invoices', { customer_id: cus[c], invoice_date: day(ago), memo, gct_amount: Math.round(amt * 0.15), lines: [{ description: memo, quantity: 1, unit_price: amt, amount: amt, account_id: inc }] });
  invIds.push(r.id);
}
await api('POST', '/api/ar/payments', { customer_id: cus[0], amount: Math.round(268400 * 1.15), method: 'cheque', reference: 'CHQ 88213', paid_on: day(-8), deposit_account_id: bank.id });
await api('POST', '/api/ar/payments', { customer_id: cus[2], amount: 50000, method: 'bank', reference: 'Transfer', paid_on: day(-3), deposit_account_id: bank.id });

// ---- Bank: opening deposit, expenses
const cap = pick(/capital|equity|opening/i, (a) => a.type === 'equity');
await api('POST', '/api/bank/txns', { kind: 'deposit', account_id: bank.id, txn_date: day(-60), memo: 'Opening balance', lines: [{ account_id: cap, amount: 3500000, memo: 'Opening balance' }] });
await api('POST', '/api/bank/txns', { kind: 'expense', account_id: bank.id, txn_date: day(-15), payee: 'Kingston Properties Ltd', cheque_number: '001246', memo: 'Rent, November', lines: [{ account_id: exp(/rent/i), amount: 250000, memo: 'Shop rent' }] });
await api('POST', '/api/bank/txns', { kind: 'expense', account_id: bank.id, txn_date: day(-4), payee: 'Total Energies Half Way Tree', memo: 'Fuel for delivery van', lines: [{ account_id: exp(/fuel|motor|vehicle|travel/i), amount: 18500, memo: 'Fuel' }] });

// ---- A paid payroll run (monthly salaried staff), and a draft fortnight
const ld = new Date(Date.now() - 5 * 3600000); const y = ld.getUTCFullYear(), m = ld.getUTCMonth();
const ms = new Date(Date.UTC(y, m - 1, 1)).toISOString().slice(0, 10), me2 = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
let run = await api('POST', '/api/payroll/runs', { frequency: 'monthly', period_start: ms, period_end: me2, pay_date: me2 });
if (run.id) { await api('POST', '/api/payroll/runs/' + run.id + '/approve', {}); await api('POST', '/api/payroll/runs/' + run.id + '/pay', { account_id: bank.id, pay_date: me2 }); }
await api('POST', '/api/payroll/runs', { frequency: 'fortnightly', period_start: day(-13), period_end: day(0), pay_date: day(2) });

// ---- Ledger: post everything
await api('POST', '/api/gl/post-now', {});
console.log('done', JSON.stringify({ staff: ids.length, suppliers: sup.length, customers: cus.length, bills: billIds.filter(Boolean).length, invoices: invIds.filter(Boolean).length, run: run.id || null }));
