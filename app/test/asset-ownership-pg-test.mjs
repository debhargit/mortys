// Costs, income and rentals of a fixed asset, and sub-accounts folding under
// their main account, against a REAL server and a throwaway Postgres:
// a bill, a bank payment and a journal line tagged with an asset land in its
// cost of ownership; renting it out raises invoices tagged with it (rental
// income); it cannot be sold while rented; the trial balance and the balance
// sheet carry each account's main account.
//
//   LC_TEST_URL=http://localhost:3394 LC_TEST_PSQL="psql -h 127.0.0.1 -p 5497 -U postgres -d fa2" node test/asset-ownership-pg-test.mjs
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
const post = () => api('POST', '/api/gl/post-now');
const today = new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10);
const stamp = Date.now().toString(36);
const acct = (k) => Number(sql(`SELECT id FROM gl_accounts WHERE system_key = '${k}'`));
const code = (c) => Number(sql(`SELECT id FROM gl_accounts WHERE code = '${c}'`));

ok((await api('POST', '/api/auth/signin', { email: 'admin@mortysautoparts.com', password: 'password123' }))._status === 200, 'admin signs in');
await api('POST', '/api/gl/setup', {});

// ---- an asset to look after
const meta = await api('GET', '/api/assets/meta');
const klass = meta.classes.find((k) => k.name === 'Machinery and workshop equipment');
let r = await api('POST', '/api/assets', { name: 'Tow truck ' + stamp, class_id: klass.id, acquired_on: today, in_service_on: today, cost: 600000, life_months: 60, funding: 'opening' });
const fa = r.asset && r.asset.id;
ok(fa > 0, 'asset added (' + (r.asset ? r.asset.number : r.error) + ')');
ok((await api('GET', '/api/assets/pick')).assets.some((a) => a.id === fa), 'it is offered in the asset pickers');

// ---- running costs tagged with it: a bill, a bank payment, a journal line
const repairs = code('6400') || acct('petty_expense');
const sup = Number(sql(`INSERT INTO suppliers (name) VALUES ('Garage ${stamp}') RETURNING id`).split('\n')[0]);
r = await api('POST', '/api/ap/bills', { supplier_id: sup, bill_date: today, number: 'G-' + stamp, lines: [{ account_id: repairs, description: 'Brakes', amount: 12000, asset_id: fa }, { account_id: repairs, description: 'Shop stuff', amount: 500 }] });
ok(r._status === 200, 'bill with a line for the asset saved' + (r._status === 200 ? '' : ' [' + r.error + ']'));
r = await api('POST', '/api/bank/txns', { kind: 'expense', account_id: acct('bank'), txn_date: today, lines: [{ account_id: repairs, amount: 3000, memo: 'Fuel', asset_id: fa }] });
ok(r._status === 200, 'bank payment for the asset saved' + (r._status === 200 ? '' : ' [' + r.error + ']'));
r = await api('POST', '/api/gl/journal', { date: today, memo: 'Insurance for the truck', lines: [{ account_id: repairs, debit: 4500, asset_id: fa }, { account_id: acct('bank'), credit: 4500 }] });
ok(r._status === 200, 'journal line for the asset posted' + (r._status === 200 ? '' : ' [' + r.error + ']'));
r = await api('POST', '/api/gl/journal', { date: today, memo: 'Bad tag', lines: [{ account_id: repairs, debit: 1, asset_id: 99999999 }, { account_id: acct('bank'), credit: 1 }] });
ok(r._status >= 400, 'a journal line tagged with an asset that does not exist is refused');
await post();
ok(n(sql(`SELECT COALESCE(SUM(amount), 0) FROM gl_lines WHERE asset_id = ${fa} AND account_id = ${repairs}`)) === 19500, 'the ledger carries the asset on all three cost lines (12,000 + 3,000 + 4,500), not on the untagged one');

// ---- rent it out
const cust = { id: Number(sql(`SELECT id FROM users WHERE NOT is_staff AND NOT COALESCE(is_admin, false) ORDER BY id LIMIT 1`)) };
r = await api('POST', '/api/billing/plans', { side: 'ar', name: 'Rent of truck ' + stamp, customer_id: cust.id, frequency: 'monthly', start_date: today, due_days: 7, asset_id: fa,
  lines: [{ account_id: acct('rental_income'), description: 'Truck rental', amount: 25000, asset_id: fa }] });
const plan = r.id;
ok(plan > 0, 'rental set up' + (plan ? '' : ' [' + r.error + ']'));
r = await api('POST', `/api/billing/plans/${plan}/run`, {});
ok(r._status === 200 && r.created >= 1, 'the rental raised its first invoice' + (r._status === 200 ? '' : ' [' + r.error + ']'));
ok(sql(`SELECT COUNT(*) FROM ar_invoice_lines WHERE asset_id = ${fa}`) !== '0', 'the invoice line is tagged with the asset');
await post();
r = await api('GET', `/api/billing/plans?side=ar&asset_id=${fa}`);
ok((r.plans || []).length === 1 && (r.plans[0].asset_number || '').startsWith('FA-'), 'the plans list finds the rental by asset');

// ---- cost of ownership
const d = await api('GET', `/api/assets/${fa}`);
const o = d.ownership || {};
ok(near(o.costs, 19500), `its running costs are 19,500 (${o.costs})`);
ok(near(o.income, 25000), `its rental income is 25,000 (${o.income})`);
ok(near(o.net, n(o.income) + n(o.disposal) - n(o.costs) - n(o.depreciation)), 'net = income + disposal - costs - depreciation');
ok((d.rentals || []).length === 1 && near(d.rentals[0].amount, 25000) && d.rentals[0].invoices >= 1, 'the asset lists its rental with the invoice count');
const all = await api('GET', `/api/assets/ownership?from=${today.slice(0, 4)}-01-01&to=${today}`);
const mine = (all.assets || []).find((a) => a.id === fa);
ok(mine && mine.rented && near(mine.costs, 19500) && near(mine.income, 25000), 'the Costs & income report shows it, rented, with the same figures');

// ---- cannot sell while rented; can after the rental ends
r = await api('POST', `/api/assets/${fa}/dispose`, { disposed_on: today, kind: 'sold', proceeds: 500000, proceeds_account_id: acct('bank') });
ok(r._status === 409 && /rented/.test(r.error || ''), 'selling it while rented is refused: end the rental first');
ok((await api('POST', `/api/billing/plans/${plan}/status`, { status: 'ended' }))._status === 200, 'rental ended');
r = await api('POST', `/api/assets/${fa}/dispose`, { disposed_on: today, kind: 'sold', proceeds: 500000, proceeds_account_id: acct('bank') });
ok(r._status === 200, 'then it can be sold' + (r._status === 200 ? '' : ' [' + r.error + ']'));
await post();
const o2 = (await api('GET', `/api/assets/${fa}`)).ownership || {};
ok(n(o2.disposal) < 0 && near(o2.disposal, -100000), `selling 600,000 of cost for 500,000 shows a 100,000 loss on disposal (${o2.disposal})`);
r = await api('POST', '/api/billing/plans', { side: 'ar', name: 'Rent again ' + stamp, customer_id: cust.id, frequency: 'monthly', start_date: today, asset_id: fa, lines: [{ account_id: acct('rental_income'), amount: 100 }] });
ok(r._status === 409, 'a sold asset cannot be rented out');

// ---- sub-accounts carry their main account
r = await api('POST', '/api/gl/accounts', { parent_id: repairs, sub_no: '1' + stamp.slice(-3).replace(/\D/g, '1').padStart(3, '1').slice(0, 3), name: 'Truck repairs ' + stamp });
const sub = r.account && r.account.id;
ok(sub > 0, 'sub-account added under ' + sql(`SELECT code FROM gl_accounts WHERE id = ${repairs}`) + (sub ? ' (' + r.account.code + ')' : ' [' + r.error + ']'));
await api('POST', '/api/gl/journal', { date: today, memo: 'Sub test', lines: [{ account_id: sub, debit: 700 }, { account_id: acct('bank'), credit: 700 }] });
const tb = await api('GET', `/api/gl/trial-balance?from=${today}&to=${today}`);
const rows = tb.accounts || tb.rows || [];
const sr = rows.find((x) => x.id === sub);
ok(sr && sr.parent_id === repairs, 'the trial balance gives the sub-account its main account');
const fake = await api('POST', '/api/gl/accounts', { parent_id: acct('bank'), sub_no: '9' + stamp.slice(-2).replace(/\D/g, '9'), name: 'Petty tin ' + stamp });
if (fake.account) await api('POST', '/api/gl/journal', { date: today, memo: 'Sub bank', lines: [{ account_id: fake.account.id, debit: 50 }, { account_id: repairs, credit: 50 }] });
const v = await api('GET', '/api/budget/value');
const line = v.balance_sheet.groups.flatMap((g) => g.lines).find((l) => fake.account && l.id === fake.account.id);
ok(line && line.parent_id === acct('bank') && v.balance_sheet.chart.some((a) => a.id === acct('bank')), 'the balance sheet gives a sub-account its main account, and the chart to fold it under');

// ---- the guard on posted lines still holds
let blocked = false;
try { sql(`UPDATE gl_lines SET amount = amount + 1 WHERE id = (SELECT MIN(id) FROM gl_lines)`); } catch (_) { blocked = true; }
ok(blocked, 'posted journal lines still cannot be changed');
blocked = false;
try { sql(`UPDATE gl_lines SET asset_id = NULL WHERE asset_id IS NOT NULL`); } catch (_) { blocked = true; }
ok(blocked, 'nor can an asset tag be taken off');

console.log(`\n${pass} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
