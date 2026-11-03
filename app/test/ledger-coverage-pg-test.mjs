// Every transaction to the chart of accounts, against a REAL server and a
// throwaway Postgres: work orders billed, taken back and billed again, paid and
// a payment voided; fixed assets bought from the bank and owned before the
// ledger, depreciation runs (with catch-up), a disposal with a gain and its
// void; the tie-out (A/R with the workshop, A/P from Payables, fixed assets)
// and the coverage report (deleted documents, documents changed after posting).
//
//   LC_TEST_URL=http://localhost:3394 LC_TEST_PSQL="psql -h 127.0.0.1 -p 5497 -U postgres -d fa" node test/ledger-coverage-pg-test.mjs
//
// Refuses the live till's ports, and stops unless the server is writing to
// the database LC_TEST_PSQL points at. Signs in as the default admin. Run it
// on a fresh database: it starts the ledger and expects the tie-out to be
// clean to begin with.
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
const post = () => api('POST', '/api/gl/post-now');
// The lines of the live entry for a document, by account system key / code: {key: amount}.
function entry(kind, id) {
  const rows = sql(`SELECT COALESCE(a.system_key, a.code), SUM(l.amount) FROM gl_entries e JOIN gl_lines l ON l.entry_id = e.id JOIN gl_accounts a ON a.id = l.account_id
                     WHERE e.source_kind = '${kind}' AND e.source_id = ${id} GROUP BY 1`);
  return Object.fromEntries(rows ? rows.split('\n').map((r) => { const [k, v] = r.split('|'); return [k, Number(v)]; }) : []);
}
const reversed = (kind, id) => sql(`SELECT reversed_by IS NOT NULL FROM gl_entries WHERE source_kind = '${kind}' AND source_id = ${id}`) === 't';
const tie = async (key) => ((await api('GET', '/api/gl/tieout')).checks || []).find((c) => c.key === key) || {};
const month = (d, k) => { const t = d.getUTCFullYear() * 12 + d.getUTCMonth() + k; return Math.floor(t / 12) + '-' + String(t % 12 + 1).padStart(2, '0'); };
const jm = new Date(Date.now() - 5 * 3600000), thisMonth = month(jm, 0), today = jm.toISOString().slice(0, 10);

ok((await api('POST', '/api/auth/signin', { email: 'admin@visionautosolutions.com', password: 'password123' }))._status === 200, 'admin signs in');
await api('POST', '/api/gl/setup', {});
ok((await api('GET', '/api/gl/status')).started, 'the ledger is started');
const stamp = Date.now().toString(36);

// ===================================================================== workshop
let r = await api('POST', '/api/admin/work-orders', { customer_name: 'Tie Out ' + stamp, customer_phone: '876-555-0101', vehicle_make: 'Honda', vehicle_model: 'Fit', complaint: 'Brakes' });
const wo = r.id || (r.work_order && r.work_order.id);
ok(wo > 0, 'work order opened');
if (sql(`SELECT COUNT(*) FROM work_orders WHERE id = ${wo} AND customer_name = 'Tie Out ${stamp}'`) !== '1') { console.log('FAIL the server is not writing to the LC_TEST_PSQL database: stopping'); process.exit(1); }
await api('POST', `/api/admin/work-orders/${wo}/labor`, { description: 'Replace pads', hours: 2, rate_usd: 5000 });
await api('POST', `/api/admin/work-orders/${wo}/parts`, { description: 'Brake pads', qty: 1, unit_price_usd: 8000 });
await api('PATCH', `/api/admin/work-orders/${wo}`, { status: 'billed' });
await post();
let bill1 = Number(sql(`SELECT id FROM work_order_billings WHERE work_order_id = ${wo} AND kind = 'bill' ORDER BY id LIMIT 1`));
let e = entry('work_order', bill1);
ok(near(e.ar, 20700) && near(e.sales_services, -10000) && near(e.sales, -8000) && near(e.gct, -2700), 'billed work order posts Dr A/R 20,700; Cr labour 10,000, parts 8,000, GCT 2,700');
r = await api('POST', `/api/admin/work-orders/${wo}/labor`, { description: 'Bleed brakes', hours: 1, rate_usd: 3000 });
ok(r._status === 409, 'a billed work order\'s lines cannot change (409)');
r = await api('PATCH', `/api/admin/work-orders/${wo}`, { tax_usd: 0 });
ok(r._status === 409, 'nor its GCT');
ok((await api('DELETE', `/api/admin/work-orders/${wo}`))._status === 409, 'a billed work order cannot be deleted');

r = await api('POST', `/api/admin/work-orders/${wo}/payments`, { method: 'cash', amount_usd: 5000 });
await post();
const pay1 = Number(sql(`SELECT id FROM work_order_payments_all WHERE work_order_id = ${wo} ORDER BY id LIMIT 1`));
e = entry('wo_payment', pay1);
ok(near(e.cash_safe, 5000) && near(e.ar, -5000), 'workshop cash payment posts Dr Undeposited Funds (safe), Cr A/R');
await api('DELETE', `/api/admin/work-orders/${wo}/payments/${pay1}`, { reason: 'Keyed twice' });
await post();
ok(sql(`SELECT voided_at IS NOT NULL FROM work_order_payments_all WHERE id = ${pay1}`) === 't' && sql(`SELECT COUNT(*) FROM work_order_payments WHERE id = ${pay1}`) === '0', 'taking a payment off voids it (kept on file, gone from the view)');
ok(reversed('wo_payment', pay1), 'the voided payment is reversed in the ledger');

await api('PATCH', `/api/admin/work-orders/${wo}`, { status: 'completed' });
await post();
ok(reversed('work_order', bill1), 'moving it back to completed reverses the invoice');
r = await api('POST', `/api/admin/work-orders/${wo}/labor`, { description: 'Bleed brakes', hours: 1, rate_usd: 3000 });
ok(r._status === 200, 'once taken back its lines can change');
await api('POST', `/api/admin/work-orders/${wo}/payments`, { method: 'card', amount_usd: 24150 });   // 21,000 + 15% = 24,150: paid in full
await post();
ok(sql(`SELECT status FROM work_orders WHERE id = ${wo}`) === 'paid', 'paid in full: the work order is paid');
const bill2 = Number(sql(`SELECT id FROM work_order_billings WHERE work_order_id = ${wo} AND kind = 'bill' ORDER BY id DESC LIMIT 1`));
e = entry('work_order', bill2);
ok(bill2 !== bill1 && near(e.ar, 24150) && near(e.sales_services, -13000) && near(e.gct, -3150), 'paid in full bills it again at the new total (24,150)');
e = entry('wo_payment', Number(sql(`SELECT MAX(id) FROM work_order_payments_all WHERE work_order_id = ${wo}`)));
ok(near(e.card_clearing, 24150), 'card payment posts to Card Settlements Clearing');
let t = await tie('ar');
ok(near(t.difference, 0), 'A/R ties out with the workshop in it (ledger ' + t.gl + ', system ' + t.system + ')');

// Parts pulled onto a work order keep the GCT in the total.
const wo2 = (await api('POST', '/api/admin/work-orders', { customer_name: 'Req ' + stamp, customer_phone: '876-555-0102' })).id;
await api('POST', `/api/admin/work-orders/${wo2}/labor`, { description: 'Diag', hours: 1, rate_usd: 1000 });
const req2 = sql(`INSERT INTO parts_requisitions (work_order_id, status) VALUES (${wo2}, 'pending') RETURNING id`).split('\n')[0];
sql(`INSERT INTO parts_requisition_items (requisition_id, description, qty_requested, unit_price_usd) VALUES (${req2}, 'Fuse', 1, 1000)`);
r = await api('POST', `/api/admin/parts-requisitions/${req2}/fulfill`, {});
ok(near(sql(`SELECT total_usd FROM work_orders WHERE id = ${wo2}`), 2300), 'a parts requisition onto a work order keeps GCT in its total (2,000 + 300)' + (r._status === 200 ? '' : ' [fulfil ' + r._status + ' ' + r.error + ']'));

// ================================================================ fixed assets
const meta = await api('GET', '/api/assets/meta');
const klass = (name) => meta.classes.find((k) => k.name === name);
ok(klass('Computer equipment') && klass('Land') && klass('Machinery and workshop equipment'), 'asset classes are set up with their accounts');
const bank = Number(sql(`SELECT id FROM gl_accounts WHERE system_key = 'bank'`));
const inUse = month(jm, -2) + '-10';
r = await api('POST', '/api/assets', { name: 'Vehicle lift ' + stamp, class_id: klass('Machinery and workshop equipment').id, acquired_on: inUse, in_service_on: inUse, cost: 120000, life_months: 12, funding: 'account', funding_account_id: bank });
const lift = r.asset && r.asset.id;
ok(lift > 0 && r.asset.number.startsWith('FA-'), 'asset bought from the bank added (' + (r.asset ? r.asset.number : r.error) + ')');
await post();
e = entry('fa_acquire', lift);
ok(near(e.fa_equipment, 120000) && near(e.bank, -120000), 'its cost posts Dr Machinery and Equipment, Cr Bank');

r = await api('POST', '/api/assets', { name: 'Server PC ' + stamp, class_id: klass('Computer equipment').id, acquired_on: '2024-03-01', in_service_on: '2024-03-01', cost: 36000, funding: 'opening' });
const pc = r.asset && r.asset.id;
ok(pc > 0 && near(r.asset.opening_accum, 32000) && r.asset.opening_through === month(jm, -1), 'owned before the ledger: depreciation to last month worked out (32 of 36 months = 32,000)');
await post();
e = entry('fa_acquire', pc);
ok(near(e.fa_computers, 36000) && near(e.fa_computers_ad, -32000) && near(e.opening_equity, -4000), 'posts Dr cost 36,000; Cr accumulated 32,000, Opening Balance Equity 4,000');
r = await api('PUT', `/api/assets/${lift}`, { cost: 99000 });
ok(r._status === 409, 'cost cannot change once it is in the books');

r = await api('GET', '/api/assets/runs/preview?month=' + thisMonth);
const liftPlan = (r.plan || []).find((p) => p.asset_id === lift), pcPlan = (r.plan || []).find((p) => p.asset_id === pc);
ok(liftPlan && liftPlan.months.length === 3 && near(liftPlan.amount, 30000), 'the run catches up the lift\'s 3 months (30,000)');
ok(pcPlan && pcPlan.months.length === 1 && near(pcPlan.amount, 1000), 'and charges the PC this month (1,000)');
r = await api('POST', '/api/assets/runs', { month: thisMonth });
const run1 = r.id;
ok(run1 > 0 && near(r.total, 31000), 'depreciation run posted through ' + thisMonth + ' (31,000)');
await post();
e = entry('fa_run', run1);
ok(near(e.depreciation, 31000) && near(e.fa_equipment_ad, -30000) && near(e.fa_computers_ad, -1000), 'run posts Dr Depreciation Expense; Cr each class\'s accumulated depreciation');
ok((await api('POST', '/api/assets/runs', { month: thisMonth }))._status === 409, 'running the same month again finds nothing to charge');
t = await tie('fa_cost');
let t2 = await tie('fa_accum');
ok(near(t.difference, 0) && near(t2.difference, 0), 'fixed assets tie out: cost ' + t.gl + ', accumulated ' + t2.gl);

r = await api('POST', `/api/assets/${pc}/dispose`, { disposed_on: today, kind: 'sold', proceeds: 5000, proceeds_account_id: bank });
ok(r._status === 409, 'cannot dispose of it in a month already depreciated (void the run first)');
ok((await api('POST', `/api/assets/runs/${run1}/void`, { reason: 'Test disposal' }))._status === 200, 'latest run voided');
await post();
ok(reversed('fa_run', run1) && sql(`SELECT COUNT(*) FROM fa_depreciation WHERE run_id = ${run1}`) === '0', 'the run is reversed and its charges gone');
r = await api('POST', `/api/assets/${pc}/dispose`, { disposed_on: today, kind: 'sold', proceeds: 5000, proceeds_account_id: bank, note: 'Sold to staff' });
const disp = r.id;
ok(disp > 0 && r.asset.status === 'disposed', 'PC sold for 5,000');
await post();
e = entry('fa_dispose', disp);
ok(near(e.fa_computers_ad, 32000) && near(e.bank, 5000) && near(e.fa_computers, -36000) && near(e.fa_gain, -1000), 'disposal posts Dr accumulated 32,000, Bank 5,000; Cr cost 36,000, gain 1,000');
t = await tie('fa_cost'); t2 = await tie('fa_accum');
ok(near(t.difference, 0) && near(t2.difference, 0), 'fixed assets still tie out after the sale');
ok((await api('POST', `/api/assets/disposals/${disp}/void`, { reason: 'Sale fell through' }))._status === 200, 'disposal voided');
await post();
ok(reversed('fa_dispose', disp) && sql(`SELECT status FROM fa_assets WHERE id = ${pc}`) === 'active', 'the disposal is reversed and the PC is back in use');
r = await api('POST', '/api/assets/runs', { month: thisMonth });
await post();
ok(r.id > 0 && near(entry('fa_run', r.id).depreciation, 31000), 'run again after the void: 31,000');

// An asset said to be in the books already, but no bill was coded to it: the tie-out shows it.
r = await api('POST', '/api/assets', { name: 'Desk ' + stamp, class_id: klass('Furniture and fixtures').id, acquired_on: today, cost: 15000, funding: 'in_ledger' });
const desk = r.asset && r.asset.id;
await post();
ok(desk > 0 && !Object.keys(entry('fa_acquire', desk)).length, 'an asset already in the books posts nothing for its cost');
t = await tie('fa_cost');
ok(near(t.difference, -15000), 'the tie-out shows the 15,000 no bill put on the asset account');
ok((await api('POST', `/api/assets/${desk}/void`, { reason: 'Entered by mistake' }))._status === 200 && near((await tie('fa_cost')).difference, 0), 'voided: ties again');
r = await api('GET', '/api/assets/report?from=' + thisMonth.slice(0, 4) + '-01-01&to=' + today);
ok(r.rows && near(r.totals.charge, 31000) && near(r.totals.cost_close, 156000), 'asset schedule: 31,000 charged this year, 156,000 at cost');
r = await api('GET', '/api/assets/' + lift);
ok(r.asset && near(r.asset.book_value, 90000) && r.projected.length === 9, 'the lift\'s book value 90,000 with 9 months still to charge');

// ==================================================================== coverage
let c = await api('GET', '/api/gl/coverage');
ok(c.started && !c.problems.length, 'coverage: the posting rules all point at active accounts' + (c.problems && c.problems.length ? ' (' + c.problems.map((p) => p.what).join('; ') + ')' : ''));
ok(!c.orphans.length && !c.drift.length, 'coverage: nothing deleted or changed after posting');
ok(c.sources.find((s) => s.kind === 'work_order').posted >= 2 && c.sources.find((s) => s.kind === 'fa_run').posted >= 2, 'coverage counts the workshop and depreciation entries');
// A posted payment deleted behind the system's back, and a billed total changed after posting.
const sneaky = Number(sql(`SELECT MAX(id) FROM work_order_payments_all WHERE work_order_id = ${wo}`));
sql(`DELETE FROM work_order_payments_all WHERE id = ${sneaky}`);
sql(`UPDATE work_orders SET total_usd = total_usd + 100 WHERE id = ${wo}`);
c = await api('GET', '/api/gl/coverage');
ok(c.orphans.some((o) => o.kind === 'wo_payment' && Number(o.source_id) === sneaky), 'coverage finds the entry whose payment was deleted');
ok(c.drift.some((d) => d.kind === 'work_order' && near(d.difference, -100)), 'coverage finds the work order changed after it was posted');

const tb = await api('GET', '/api/gl/trial-balance?from=2000-01-01&to=' + today);
ok(tb.totals && tb.totals.balanced && near(tb.balance_sheet.check, 0), 'trial balance balances and the balance sheet adds up');
const ap = await tie('ap');
ok(ap.key === 'ap' && /Payables/.test(ap.note), 'A/P tie-out uses Payables\' unpaid bills');

console.log(`\n${pass} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
