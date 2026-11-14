// Writing off a bad debt, against a REAL server and a throwaway Postgres:
// the write-off takes the amount off what the customer owes, posts
// Dr Bad Debts, Cr A/R (sales untouched), keeps Receivables tied to the
// ledger, and can be undone when the customer pays after all.
//
//   LC_TEST_URL=http://localhost:3394 LC_TEST_PSQL="psql -h 127.0.0.1 -p 5497 -U postgres -d fb" node test/bad-debt-pg-test.mjs
import { execSync } from 'node:child_process';

const BASE = process.env.LC_TEST_URL || 'http://localhost:3394';
if (/:(3057|3058)\b/.test(BASE)) { console.log('FAIL refusing to run against the live till port'); process.exit(1); }
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
// Post now can return while a sweep that started on save is still running: run it again once that one is done.
const post = async () => { await api('POST', '/api/gl/post-now'); await new Promise((r) => setTimeout(r, 500)); await api('POST', '/api/gl/post-now'); };
const today = new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10);
const stamp = Date.now().toString(36);
const acct = (k) => Number(sql(`SELECT id FROM gl_accounts WHERE system_key = '${k}'`));
const bal = (k, extra = '') => n(sql(`SELECT COALESCE(SUM(l.amount), 0) FROM gl_lines l WHERE l.account_id = ${acct(k)} ${extra}`));
const tie = async () => ((await api('GET', '/api/gl/tieout')).checks || []).find((c) => c.key === 'ar') || {};

ok((await api('POST', '/api/auth/signin', { email: 'admin@mortysautoparts.com', password: 'password123' }))._status === 200, 'admin signs in');
await api('POST', '/api/gl/setup', {});
ok(acct('bad_debt') > 0, 'the chart has a Bad Debts expense account (' + sql(`SELECT code || ' ' || name FROM gl_accounts WHERE system_key = 'bad_debt'`) + ')');

const cust = Number(sql(`INSERT INTO users (email, name, password_hash) VALUES ('bd${stamp}@example.test', 'Slow Payer ${stamp}', 'x') RETURNING id`).split('\n')[0]);
const inc = acct('rental_income');
const i1 = await api('POST', '/api/ar/invoices', { customer_id: cust, invoice_date: today, lines: [{ account_id: inc, description: 'Hire', amount: 10000 }] });
const i2 = await api('POST', '/api/ar/invoices', { customer_id: cust, invoice_date: today, lines: [{ account_id: inc, description: 'Hire', amount: 5000 }] });
const inv1 = i1.id || (i1.invoice && i1.invoice.id), inv2 = i2.id || (i2.invoice && i2.invoice.id);
ok(inv1 && inv2, 'two invoices raised, 10,000 and 5,000' + (inv1 ? '' : ' [' + i1.error + ']'));
await post();
const incomeBefore = bal('rental_income'), arBefore = bal('ar'), bdBefore = bal('bad_debt');
let d = await api('GET', `/api/ar/customers/${cust}`);
ok(near(d.balance, 15000), `the customer owes 15,000 (${d.balance})`);

// ---- refused
let r = await api('POST', '/api/ar/writeoffs', { customer_id: cust, applications: [{ invoice_id: inv1, amount: 10000 }] });
ok(r._status === 400, 'a write-off needs a reason');
r = await api('POST', '/api/ar/writeoffs', { customer_id: cust, reason: 'Gone', applications: [{ invoice_id: inv1, amount: 10001 }] });
ok(r._status === 400, 'cannot write off more than an invoice owes');
r = await api('POST', '/api/ar/writeoffs', { customer_id: cust, reason: 'Gone', written_off_on: '2999-01-01', applications: [{ invoice_id: inv1, amount: 100 }] });
ok(r._status === 400, 'cannot date a write-off in the future');
r = await api('POST', '/api/ar/writeoffs', { customer_id: cust, reason: 'Gone', applications: [] });
ok(r._status === 400, 'cannot write off nothing');

// ---- write off invoice 1 and part of invoice 2
r = await api('POST', '/api/ar/writeoffs', { customer_id: cust, reason: 'Business closed down', written_off_on: today, applications: [{ invoice_id: inv1, amount: 10000 }, { invoice_id: inv2, amount: 2000 }] });
const wo = r.id;
ok(r._status === 200 && near(r.amount, 12000), 'wrote off 12,000' + (r._status === 200 ? '' : ' [' + r.error + ']'));
await post();
d = await api('GET', `/api/ar/customers/${cust}`);
ok(near(d.balance, 3000) && d.invoices.length === 1 && near(d.invoices[0].open, 3000), `the customer now owes 3,000 on the second invoice only (${d.balance})`);
ok(near(d.credit, 0), 'the write-off leaves no credit on the account');
const p = d.payments.find((x) => x.id === wo);
ok(p && p.method === 'writeoff' && p.notes === 'Business closed down' && !p.deposit_to, 'it shows on the account as a write-off with its reason, banked nowhere');
ok(near(bal('bad_debt') - bdBefore, 12000) && near(bal('ar') - arBefore, -12000), 'the ledger posts Dr Bad Debts 12,000, Cr Accounts Receivable 12,000');
ok(near(bal('rental_income'), incomeBefore), 'the sales (income) are left as they were');
ok(sql(`SELECT memo FROM gl_entries WHERE source_kind = 'account_payment' AND source_id = ${wo}`).startsWith('Bad debt written off'), 'the journal says it is a bad debt written off');
let t = await tie();
ok(near(t.difference, 0), `Receivables still ties to the ledger (difference ${t.difference})`);
ok((await api('POST', `/api/ar/payments/${wo}/apply`, { applications: [{ invoice_id: inv2, amount: 1 }] }))._status === 409, 'a write-off cannot be stretched to other invoices');
const list = await api('GET', `/api/ar/writeoffs?from=${today}&to=${today}`);
ok(list.writeoffs.some((w) => w.id === wo && w.items.length === 2) && list.total >= 12000, 'the bad debts list shows it with the two items');
ok(n(sql(`SELECT COUNT(*) FROM account_payments WHERE method = 'writeoff' AND deposit_account_id IS NOT NULL`)) === 0, 'no money account is touched');

// ---- the customer pays after all
r = await api('POST', `/api/ar/payments/${wo}/void`, { reason: 'Customer is paying after all' });
ok(r._status === 200, 'undo write-off');
await post();
d = await api('GET', `/api/ar/customers/${cust}`);
ok(near(d.balance, 15000), `the 12,000 is owed again (${d.balance})`);
ok(near(bal('bad_debt'), bdBefore) && near(bal('ar'), arBefore), 'the bad debt expense is reversed');
r = await api('POST', '/api/ar/payments', { customer_id: cust, amount: 15000, method: 'bank', deposit_account_id: acct('bank'), paid_on: today, applications: [{ invoice_id: inv1, amount: 10000 }, { invoice_id: inv2, amount: 5000 }] });
ok(r._status === 200, 'then the payment is received as usual');
await post();
d = await api('GET', `/api/ar/customers/${cust}`);
ok(near(d.balance, 0), 'and the account is clear');
t = await tie();
ok(near(t.difference, 0), `Receivables ties to the ledger at the end (difference ${t.difference})`);
ok(!((await api('GET', '/api/gl/meta')).pay_method || []).includes('writeoff'), 'write-off is not offered as a payment method to map in Posting rules');

console.log(`\n${pass} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
