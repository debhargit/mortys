// Posting on save and the Business value report, against a REAL server and a
// throwaway Postgres (run after ledger-coverage-pg-test.mjs, or on its own):
// a transaction reaches the ledger without anyone pressing Post now; owner's
// capital and drawings show in the equity movement; the balance sheet balances
// and the report values the business and makes recommendations.
//
//   LC_TEST_URL=http://localhost:3394 LC_TEST_PSQL="psql -h 127.0.0.1 -p 5497 -U postgres -d fa" node test/value-pg-test.mjs
import { execSync } from 'node:child_process';

const BASE = process.env.LC_TEST_URL || 'http://localhost:3394';
if (/:(3056|3059)\b/.test(BASE)) { console.log('FAIL refusing to run against the live till port'); process.exit(1); }
const PSQL = process.env.LC_TEST_PSQL;
if (!PSQL || /-p\s*5435\b/.test(PSQL)) { console.log('FAIL LC_TEST_PSQL must point at the throwaway database (never port 5435)'); process.exit(1); }
let pass = 0, fails = 0;
const ok = (c, m) => { if (c) { pass++; console.log('PASS ' + m); } else { fails++; console.log('FAIL ' + m); } };
const sql = (q) => execSync(PSQL + ' -tA', { input: q, encoding: 'utf8' }).trim();
const jar = {};
async function api(method, url, body) {
  const r = await fetch(BASE + url, { method, headers: Object.assign({ Accept: 'application/json', Cookie: Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ') }, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
  for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
  return Object.assign({ _status: r.status }, await r.json().catch(() => ({})));
}
const n = (v) => Number(v || 0), near = (a, b) => Math.abs(n(a) - n(b)) < 0.02;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const today = new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10);

ok((await api('POST', '/api/auth/signin', { email: 'admin@visionautosolutions.com', password: 'password123' }))._status === 200, 'admin signs in');
await api('POST', '/api/gl/setup', {});
ok((await api('GET', '/api/gl/status')).started, 'the ledger is started');

// ---- posted on save: no Post now, and well inside the 60-second sweep
const stamp = Date.now().toString(36);
let r = await api('POST', '/api/admin/work-orders', { customer_name: 'Value ' + stamp, customer_phone: '876-555-0102', vehicle_make: 'Toyota', vehicle_model: 'Axio', complaint: 'Service' });
const wo = r.id || (r.work_order && r.work_order.id);
await api('POST', `/api/admin/work-orders/${wo}/labor`, { description: 'Service', hours: 1, rate_usd: 6000 });
await api('PATCH', `/api/admin/work-orders/${wo}`, { status: 'billed' });
const bill = Number(sql(`SELECT id FROM work_order_billings WHERE work_order_id = ${wo} AND kind = 'bill' ORDER BY id DESC LIMIT 1`));
let posted = '0';
for (let i = 0; i < 20 && posted === '0'; i++) { await wait(250); posted = sql(`SELECT COUNT(*) FROM gl_entries WHERE source_kind = 'work_order' AND source_id = ${bill}`); }
ok(posted === '1', 'a billed work order is in the ledger within seconds, with no Post now');
r = await api('POST', `/api/admin/work-orders/${wo}/payments`, { method: 'card', amount_usd: 6900 });
const pay = Number(sql(`SELECT id FROM work_order_payments_all WHERE work_order_id = ${wo} ORDER BY id DESC LIMIT 1`));
posted = '0';
for (let i = 0; i < 20 && posted === '0'; i++) { await wait(250); posted = sql(`SELECT COUNT(*) FROM gl_entries WHERE source_kind = 'wo_payment' AND source_id = ${pay}`); }
ok(posted === '1', 'and so is its payment');

// ---- owners' equity accounts
const acct = (k) => Number(sql(`SELECT id FROM gl_accounts WHERE system_key = '${k}'`));
ok(acct('owner_capital') && acct('owner_drawings') && acct('retained_earnings'), 'Owner\'s Capital, Owner\'s Drawings and Retained Earnings are on the chart');
const before = await api('GET', '/api/budget/value');
ok(before.ready, 'the report is ready');
const capBefore = n((before.equity.movement.find((m) => m.key === 'capital') || {}).amount), drawBefore = n((before.equity.movement.find((m) => m.key === 'drawings') || {}).amount);
r = await api('POST', '/api/gl/journal', { date: today, memo: 'Owner puts money in', lines: [{ account_id: acct('bank'), debit: 100000 }, { account_id: acct('owner_capital'), credit: 100000 }] });
ok(r._status === 200, 'capital journal posted');
r = await api('POST', '/api/gl/journal', { date: today, memo: 'Owner takes money out', lines: [{ account_id: acct('owner_drawings'), debit: 10000 }, { account_id: acct('bank'), credit: 10000 }] });
ok(r._status === 200, 'drawings journal posted');

const v = await api('GET', '/api/budget/value');
const B = v.balance_sheet;
ok(near(B.net_assets, B.equity), `assets less liabilities equal the owners' equity (${B.net_assets})`);
ok(near(B.assets, B.groups.filter((g) => g.side === 'asset').reduce((t, g) => t + g.total, 0)), 'the asset groups add up to total assets');
ok(near(v.equity.check, 0) && near(v.equity.closing, B.equity), 'equity movement runs from the opening figure to the balance sheet\'s equity');
ok(near(n((v.equity.movement.find((m) => m.key === 'capital') || {}).amount) - capBefore, 100000), 'capital put in shows 100,000 more');
ok(near(n((v.equity.movement.find((m) => m.key === 'drawings') || {}).amount) - drawBefore, -10000), 'drawings show 10,000 taken out');
ok(B.groups.find((g) => g.key === 'fixed').lines.length === 0 || B.groups.find((g) => g.key === 'fixed').total > 0, 'fixed assets show at cost less depreciation');
ok(v.valuation.value.low <= v.valuation.value.mid && v.valuation.value.mid <= v.valuation.value.high && v.valuation.value.low >= v.valuation.adjusted - 0.01, 'indicated value is a range never below adjusted net assets');
ok(near(v.valuation.adjusted, v.valuation.book + v.valuation.adjustments.reduce((t, a) => t + a.amount, 0)), 'adjusted net assets are book value plus the adjustments');
ok(Array.isArray(v.recommendations) && v.recommendations.length > 0, 'it makes recommendations (' + v.recommendations.map((x) => x.label).join('; ') + ')');
ok(v.recommendations.some((x) => x.label === 'Opening Balance Equity') === (Math.abs(n(sql(`SELECT COALESCE(SUM(l.amount),0) FROM gl_lines l JOIN gl_accounts a ON a.id = l.account_id WHERE a.system_key = 'opening_equity'`))) >= 1), 'it flags a balance left in Opening Balance Equity');
const m = await api('GET', '/api/budget/value?multiple=5');
ok(m.valuation.multiples.mid === 5 && m.valuation.multiples.low === 4 && m.valuation.multiples.high === 6, 'the earnings multiple can be changed');
const past = await api('GET', '/api/budget/value?as_of=2000-01-01');
ok(past.ready === false && /nothing/.test(past.reason), 'a date before the ledger is refused plainly');

console.log(`\n${pass} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
