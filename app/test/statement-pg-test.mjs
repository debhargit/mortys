// The customer statement (Receivables > customer > Statement) and the auto
// parts / general merchandise accounts, against a REAL server and a throwaway
// Postgres: the QuickBooks-style heading, the To: block, Amount Due /
// Amount Enc., the activity with its running balance, the aging at the foot
// (the same figures as the A/R aging report), and the emailed statement being
// the same page as the printed one.
//
//   LC_TEST_URL=http://localhost:3394 LC_TEST_PSQL="psql -h 127.0.0.1 -p 5497 -U postgres -d fb" node test/statement-pg-test.mjs
import { execSync } from 'node:child_process';

const BASE = process.env.LC_TEST_URL || 'http://localhost:3394';
if (/:(3056|3059)\b/.test(BASE)) { console.log('FAIL refusing to run against the live till port'); process.exit(1); }
const PSQL = process.env.LC_TEST_PSQL;
if (!PSQL || /-p\s*5435\b/.test(PSQL)) { console.log('FAIL LC_TEST_PSQL must point at the throwaway database (never port 5435)'); process.exit(1); }
let pass = 0, fails = 0;
const ok = (c, m) => { if (c) { pass++; console.log('PASS ' + m); } else { fails++; console.log('FAIL ' + m); } };
const sql = (q) => execSync(PSQL + ' -tA -v ON_ERROR_STOP=1', { input: q, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
const jar = {};
async function api(method, url, body) {
  const r = await fetch(BASE + url, { method, headers: Object.assign({ Accept: 'application/json', Cookie: Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ') }, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
  for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
  return Object.assign({ _status: r.status }, await r.json().catch(() => ({})));
}
const n = (v) => Number(v || 0), near = (a, b) => Math.abs(n(a) - n(b)) < 0.02;
const day = (offset) => new Date(Date.now() - 5 * 3600000 + offset * 86400000).toISOString().slice(0, 10);
const today = day(0), stamp = Date.now().toString(36);
const acct = (k) => Number(sql(`SELECT id FROM gl_accounts WHERE system_key = '${k}'`));

ok((await api('POST', '/api/auth/signin', { email: 'admin@visionautosolutions.com', password: 'password123' }))._status === 200, 'admin signs in');
ok(sql(`SELECT current_database()`) !== '' && !/5435/.test(PSQL), 'the test database is the throwaway one (' + sql(`SELECT current_database()`) + ')');

// ---------------------------------------------------------------- chart --
const NEW = ['1155', '1180', '1220', '1230', '1240', '1250', '1260', '1270', '1280', '2110', '2120', '2130', '4010', '4020', '4030', '4040', '4045', '4060', '4080', '4210',
  '5020', '5030', '5040', '5045', '5048', '5062', '5064', '5066', '5070', '5075', '5080', '5110', '6110', '6120', '6720', '6852', '6854', '6856', '6858', '6952'];
const got = sql(`SELECT code || '|' || type || '|' || qb_type || '|' || COALESCE(system_key, '') || '|' || qb_name FROM gl_accounts WHERE code IN (${NEW.map((c) => `'${c}'`).join(',')}) ORDER BY code`).split('\n');
ok(got.length === NEW.length, `all ${NEW.length} auto parts / merchandise accounts are in the chart (${got.length})`);
const TYPE = { 1: 'asset|OCASSET', 2: 'liability|OCLIAB', 4: 'income|INC', 5: 'cogs|COGS', 6: 'expense|EXP' };
ok(got.every((g) => { const [code, type, qbt, sk, qbn] = g.split('|'); return TYPE[code[0]] === type + '|' + qbt && sk === '' && qbn; }), 'each has the right type and QuickBooks type, a QuickBooks name, and no posting key');
ok(sql(`SELECT name FROM gl_accounts WHERE code = '4000'`) === 'Sales - Parts' && sql(`SELECT system_key FROM gl_accounts WHERE code = '4000'`) === 'sales', 'existing accounts keep their names and posting keys (4000 Sales - Parts / sales)');
ok(sql(`SELECT COUNT(*) FROM (SELECT lower(name) FROM gl_accounts GROUP BY lower(name) HAVING COUNT(*) > 1) x`) === '0', 'no two accounts share a name');
const chart = await api('GET', '/api/gl/accounts');
ok(chart._status === 200 && chart.accounts.some((a) => a.code === '5064' && a.name === 'Customs Duty and Import Charges'), 'the Ledger chart of accounts lists them (5064 Customs Duty and Import Charges)');
const pick = await api('GET', '/api/books/accounts');
ok(pick.accounts.some((a) => a.code === '6952' && !a.bank) && !pick.accounts.some((a) => a.code === '1270' && a.bank), 'they can be picked on bills and are not mistaken for bank accounts');

// ------------------------------------------------------------ statement --
sql(`INSERT INTO warehouse_settings (key, value) VALUES ('payroll_employer_trn', '001-234-567') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
const cust = Number(sql(`INSERT INTO users (email, name, password_hash, phone, company_name, account_number, payment_terms_days) VALUES ('st${stamp}@example.com', 'Marcia Brown ${stamp}', 'x', '876-555-0101', 'Brown''s Taxi Service', 'C-ST${stamp}', 30) RETURNING id`).split('\n')[0]);
sql(`INSERT INTO customer_addresses (user_id, kind, line1, line2, city, parish) VALUES (${cust}, 'shipping', '1 Wrong Road', NULL, 'Ocho Rios', 'St Ann'), (${cust}, 'billing', '22 Hope Road', 'Unit 4', 'Kingston 10', 'St Andrew')`);
const inc = acct('rental_income');
async function invoice(amount, dated, due) {
  const r = await api('POST', '/api/ar/invoices', { customer_id: cust, invoice_date: today, lines: [{ account_id: inc, description: 'Parts on account', amount }] });
  const id = r.id || (r.invoice && r.invoice.id);
  sql(`UPDATE ar_invoices SET invoice_date = '${day(dated)}', due_date = '${day(due)}' WHERE id = ${id}`);
  return id;
}
const A = await invoice(10000, -100, -95);   // over 90 days past due
const B2 = await invoice(5000, -50, -45);    // 31-60
const C = await invoice(3000, -20, -10);     // 1-30
const D = await invoice(2000, 0, 30);        // current
const E = await invoice(1500, -70, -65);     // 61-90
ok(A && B2 && C && D && E, 'five invoices raised, aged into every bucket');
// A till sale charged to the account: 2,500, 1,000 paid at the till, no terms (aged from its date).
sql(`INSERT INTO pos_sales (receipt_number, customer_id, customer_name, total_usd, amount_paid_usd, payment_status, created_at) VALUES ('R-ST${stamp}', ${cust}, 'Marcia Brown', 2500, 1000, 'partial', NOW() - INTERVAL '5 days')`);
const bank = acct('bank');
let r = await api('POST', '/api/ar/payments', { customer_id: cust, amount: 4000, method: 'cheque', reference: '000451', paid_on: day(-10), deposit_account_id: bank, applications: [{ invoice_id: A, amount: 4000 }] });
ok(r._status === 200, 'a 4,000 cheque paid on the oldest invoice' + (r._status === 200 ? '' : ' [' + r.error + ']'));
r = await api('POST', '/api/ar/payments', { customer_id: cust, amount: 500, method: 'cash', paid_on: today, deposit_account_id: bank, applications: [] });
ok(r._status === 200, '500 cash left unapplied (a credit on the account)');

const from = day(-30);
const s = await api('GET', `/api/ar/customers/${cust}/statement?from=${from}`);
ok(s._status === 200, 'the statement loads' + (s._status === 200 ? '' : ' [' + s.error + ']'));
const want = { current: 2000, d30: 4500, d60: 5000, d90: 1500, over90: 6000 };
ok(Object.keys(want).every((k) => near(s.aging[k], want[k])), 'aging: current 2,000; 1-30 4,500; 31-60 5,000; 61-90 1,500; over 90 6,000 (' + JSON.stringify(s.aging) + ')');
ok(near(s.open, 19000) && near(s.credit, 500) && near(s.due, 18500), `amount due 18,500 = 19,000 open less 500 credit (${s.due})`);
const ag = await api('GET', '/api/ar/aging');
const row = ag.rows.find((x) => x.customer_id === cust);
ok(row && Object.keys(want).every((k) => near(row[k], s.aging[k])), 'the statement aging is the same as the A/R aging report for this customer');
const det = await api('GET', `/api/ar/customers/${cust}`);
ok(Object.keys(want).every((k) => near(det.aging[k], s.aging[k])) && near(det.balance, s.due), 'and the same as the customer centre tiles and balance');
ok(near(s.forward, 16500), `balance forward 16,500: the invoices before ${from} (${s.forward})`);
ok(s.lines.length === 5, `five lines in the period: two invoices, the till sale, two payments (${s.lines.length})`);
ok(near(s.lines[s.lines.length - 1].balance, s.due), 'the last balance is the amount due');
const days = s.lines.map((l) => l.day);
ok(days.every((d, i) => i === 0 || d >= days[i - 1]), 'activity is in date order');
const sale = s.lines.find((l) => l.ref === 'R-ST' + stamp);
ok(sale && near(sale.amount, 1500), 'the till sale shows only what was charged to the account (1,500)');
const chq = s.lines.find((l) => l.kind === 'payment' && l.ref === '000451');
ok(chq && near(chq.amount, -4000) && /^PMT - Cheque #000451/.test(chq.text), 'the cheque shows as "PMT - Cheque #000451", -4,000');
ok(s.lines.some((l) => l.kind === 'invoice' && /^INV-\d+\. Due \d/.test(l.text)) && sale.text === 'INV #R-ST' + stamp, 'invoices show as "INV-000003. Due ...", till sales as "INV #R-..."');
const h = s.html;
ok(/<div[^>]*>Statement<\/div>/.test(h) && h.includes('Account No.') && h.includes('C-ST' + stamp), 'heading: "Statement", date and account number');
ok(h.includes('Vision Auto Solutions') && h.includes('TRN: 001-234-567') && h.includes('Tel: '), 'top left: the shop name, address, phone and TRN');
ok(h.includes('>To:<') && h.includes('22 Hope Road') && h.includes('Unit 4') && h.includes('Kingston 10, St Andrew') && h.includes('Brown&#39;s Taxi Service') && !h.includes('1 Wrong Road'), 'To: block: customer, company and the billing address');
ok(h.includes('Amount Due') && h.includes('Amount Enc.'), 'the Amount Due / Amount Enc. box');
ok(['>Date<', '>Transaction<', '>Amount<', '>Balance<', 'Balance forward'].every((x) => h.includes(x)), 'activity table: Date, Transaction, Amount, Balance, from the balance forward');
ok(['Current', '1-30 Days Past Due', '31-60 Days Past Due', '61-90 Days Past Due', 'Over 90 Days Past Due', 'Unapplied Credit'].every((x) => h.includes('>' + x + '<')) && h.includes('J$18,500.00'), 'aging at the foot, with the unapplied credit and the amount due');
ok(/max-width:720px/.test(h) && /@page\{size:auto;margin:12mm\}/.test(h), 'fits letter and A4 paper');
ok(!/<script/i.test(h), 'the page carries no script');
ok(s.email === 'st' + stamp + '@example.com', 'the email address on the record is shown');

const s2 = await api('GET', `/api/ar/customers/${cust}/statement`);
const m = new Date(Date.now() - 5 * 3600000); m.setUTCDate(1); m.setUTCMonth(m.getUTCMonth() - 2);
ok(s2.from === m.toISOString().slice(0, 10) && near(s2.lines[s2.lines.length - 1].balance, s2.due), `with no date it starts on the first of the month two months back (${s2.from}) and still ends on the amount due`);
const s3 = await api('GET', `/api/ar/customers/${cust}/statement?from=${day(-400)}`);
ok(near(s3.forward, 0) && near(s3.lines[s3.lines.length - 1].balance, 18500), 'from before the first invoice the balance forward is 0');
ok((await api('GET', `/api/ar/customers/${cust}/statement?from=${day(5)}`))._status === 400, 'a start date after today is refused');
ok((await api('GET', `/api/ar/customers/999999/statement`))._status === 404, 'an unknown customer is refused');

// ---------------------------------------------------------------- send --
r = await api('POST', `/api/ar/customers/${cust}/statement/send`, { channel: 'email', from });
ok(r.ok && r.to === 'st' + stamp + '@example.com', 'email: sent to the address on the record (' + r.status + (r.reason ? ', ' + r.reason : '') + ')');
const html = sql(`SELECT body_html FROM notifications WHERE customer_id = ${cust} AND channel = 'email' ORDER BY id DESC LIMIT 1`);
ok(html === s.html.trim() || html === s.html, 'the emailed statement is the same page as the printed one');
const txt = sql(`SELECT body FROM notifications WHERE customer_id = ${cust} AND channel = 'email' ORDER BY id DESC LIMIT 1`);
ok(/AMOUNT DUE: J\$18,500\.00/.test(txt) && /Over 90 Days Past Due: J\$6,000\.00/.test(txt), 'with a plain-text copy for mail programs that do not show HTML');
ok(sql(`SELECT COUNT(*) FROM ar_notes WHERE customer_id = ${cust} AND kind = 'email' AND note LIKE 'Statement (J$18,500.00 due) sent by email%'`) === '1', 'it is noted in the collections notes');
r = await api('POST', `/api/ar/customers/${cust}/statement/send`, { channel: 'sms', from });
ok(r.ok && r.to === '876-555-0101', 'SMS: a summary to the phone on the record (' + r.status + ')');
ok(/Amount due J\$18,500\.00, of which J\$17,000\.00 is past due\./.test(sql(`SELECT body FROM notifications WHERE customer_id = ${cust} AND channel = 'sms' ORDER BY id DESC LIMIT 1`)), 'the summary gives the amount due and how much is past due');
ok(sql(`SELECT COUNT(*) FROM notifications WHERE customer_id = ${cust} AND channel = 'sms' AND body_html IS NOT NULL`) === '0', 'an SMS carries no HTML');
r = await api('POST', `/api/ar/customers/${cust}/statement/send`, { channel: 'whatsapp', from });
ok(r.ok && /^https:\/\/wa\.me\/18765550101\?text=/.test(r.wa_link || ''), 'WhatsApp: opens with the summary ready');
ok((await api('POST', `/api/ar/customers/${cust}/statement/send`, { channel: 'fax' }))._status === 400, 'an unknown channel is refused');
const noMail = Number(sql(`INSERT INTO users (email, name, password_hash) VALUES ('nm${stamp}@customer.visionautosolutions.local', 'No Mail ${stamp}', 'x') RETURNING id`).split('\n')[0]);
r = await api('POST', `/api/ar/customers/${noMail}/statement/send`, { channel: 'email' });
ok(!r.ok && r.status === 'skipped', 'a customer with a placeholder email is not mailed (' + r.reason + ')');
// Other messages still go out as before (wrapped text, no HTML of their own).
ok(sql(`SELECT COUNT(*) FROM notifications WHERE channel = 'email' AND body_html IS NULL AND related_kind = 'billing_statement'`) === '0', 'only the statement carries its own HTML');

const page = await (await fetch(BASE + '/receivables.html')).text();
ok(page.includes("'/statement/send'") && page.includes('Activity from') && page.includes('DOMParser'), 'the Receivables page has the statement preview with Print / PDF, Email, SMS and WhatsApp');

console.log(`\n${pass} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
