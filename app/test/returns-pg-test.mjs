// Return Merchandise end to end (returns.js), against a REAL server and a
// throwaway Postgres: a cash sale returned in part and again, never more than
// was sold; a sale on account returned (the credit comes off what the customer
// owes, no money leaves); a paid account sale returned (credit on the account,
// then paid out); split tender and part-paid sales reversed in the same split;
// a restocking fee; a damaged unit written off; a return with no receipt; the
// commission clawback, before and after the statement was paid; voiding a
// return; a closed month. Every journal must balance, the cash drawer and the
// receivable must agree with the ledger, and every return must be listed as a
// credit note.
//
//   RET_TEST_URL=http://localhost:3394 RET_TEST_PSQL="psql -h 127.0.0.1 -p 5497 -U postgres -d ret1" node test/returns-pg-test.mjs
//
// Refuses the live till's ports, and stops unless the server is writing to
// the database RET_TEST_PSQL points at. Signs in as the default admin (a
// manager). Run it on a fresh database: it starts the ledger and commission.
import { execSync } from 'node:child_process';

const BASE = process.env.RET_TEST_URL || 'http://localhost:3394';
if (/:(3056|3059)\b/.test(BASE)) { console.log('FAIL refusing to run against the live till port'); process.exit(1); }
const PSQL = process.env.RET_TEST_PSQL;
if (!PSQL || /-p\s*5435\b/.test(PSQL)) { console.log('FAIL RET_TEST_PSQL must point at the throwaway database (never port 5435)'); process.exit(1); }
let pass = 0, fails = 0;
const ok = (c, m) => { if (c) { pass++; console.log('PASS ' + m); } else { fails++; console.log('FAIL ' + m); } };
const sql = (q) => execSync(PSQL + ' -tA', { input: q, encoding: 'utf8' }).replace(/\r/g, '').trim();
const jar = {};
async function api(method, url, body) {
  const r = await fetch(BASE + url, { method, headers: Object.assign({ Accept: 'application/json', Cookie: Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ') }, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
  for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
  return Object.assign({ _status: r.status }, await r.json().catch(() => ({})));
}
const n = (v) => Number(v || 0), near = (a, b) => Math.abs(n(a) - n(b)) < 0.02, r2 = (v) => Math.round(n(v) * 100) / 100;
const sleep = (ms) => new Promise((go) => setTimeout(go, ms));
// The ledger posts in the background after a return; ask again until this run was not a busy one.
async function post() { for (let i = 0; i < 20; i++) { const r = await api('POST', '/api/gl/post-now'); if (!r.busy) return r; await sleep(300); } }
// Lines of one document's entry, by account system key / code: {key: amount}.
function entry(kind, id) {
  const rows = sql(`SELECT COALESCE(a.system_key, a.code), SUM(l.amount) FROM gl_entries e JOIN gl_lines l ON l.entry_id = e.id JOIN gl_accounts a ON a.id = l.account_id
                     WHERE e.source_kind = '${kind}' AND e.source_id = ${id} GROUP BY 1`);
  return Object.fromEntries(rows ? rows.split('\n').map((r) => { const [k, v] = r.split('|'); return [k, Number(v)]; }) : []);
}
const bal = (key) => n(sql(`SELECT COALESCE(SUM(l.amount), 0) FROM gl_lines l JOIN gl_accounts a ON a.id = l.account_id WHERE a.system_key = '${key}'`));
const stock = (img) => n(sql(`SELECT stock_count FROM products WHERE img = '${img}'`));
const settle = (ret) => Object.fromEntries((ret.settlements || []).map((s) => [s.method, n(s.amount)]));
const stamp = Date.now().toString(36);
const today = new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10);

ok((await api('POST', '/api/auth/signin', { email: 'admin@visionautosolutions.com', password: 'password123' }))._status === 200, 'admin signs in');
await api('POST', '/api/gl/setup', {});
ok((await api('GET', '/api/gl/status')).started, 'the ledger is started');
await api('POST', '/api/comm/start', {});
// Commission only looks at sales that have settled for 30 seconds, so the test
// ages its sales (sweep() below); start tracking an hour back so they still count.
// The same for the ledger, which only posts documents dated after its start.
sql(`UPDATE warehouse_settings SET value = (NOW() - INTERVAL '1 hour')::text WHERE key IN ('comm_start_at', 'gl_start_at')`);
ok((await api('GET', '/api/comm/status')).started, 'commission tracking is started');

// ------------------------------------------------------------------ set-up
const A = 'RET-A-' + stamp, B = 'RET-B-' + stamp;
sql(`INSERT INTO products (img, name, make_model, category, condition, price_usd, cost_usd, stock_count, is_active)
     VALUES ('${A}', 'Test brake pad ${stamp}', 'Test', 'Brakes', 'NEW', 1000, 600, 50, true), ('${B}', 'Test oil filter ${stamp}', 'Test', 'Filters', 'NEW', 500, 200, 50, true)`);
const rep = Number(sql(`INSERT INTO mechanics (name, commission_pct, is_active) VALUES ('Rep ${stamp}', 5, true) RETURNING id`).split('\n')[0]);
const cust = Number(sql(`INSERT INTO users (email, name, password_hash, payment_terms_days, credit_limit_usd) VALUES ('ret${stamp}@example.test', 'Account Customer ${stamp}', 'x', 30, 1000000) RETURNING id`).split('\n')[0]);
const custName = 'Account Customer ' + stamp;
const bank = Number(sql(`SELECT id FROM gl_accounts WHERE system_key = 'bank'`));
const line = (img, qty, price) => ({ product_img: img, description: img === A ? 'Test brake pad' : 'Test oil filter', qty, unit_price_usd: price });
// Ring a sale; `pay(total)` gives the tenders.
async function sell(items, pay, extra) {
  const base = Object.assign({ items }, extra || {});
  const dry = await api('POST', '/api/admin/pos/sale', Object.assign({}, base, { payment_method: 'cash', dry_run: true }));
  const total = n(dry.total_usd);
  const s = await api('POST', '/api/admin/pos/sale', Object.assign({}, base, { payments: pay(total) }));
  if (!s.id) console.log('   sale failed: ' + (s.error || JSON.stringify(s)));
  s.items = sql(`SELECT id || ':' || product_img FROM pos_sale_items WHERE sale_id = ${s.id || 0} ORDER BY id`).split('\n').map((x) => { const [id, img] = x.split(':'); return { id: Number(id), img }; });
  s.item = (img) => (s.items.find((x) => x.img === img) || {}).id;
  return s;
}
const cash = (t) => [{ method: 'cash', amount_usd: t, amount_tendered: t }];
const onAccount = (t) => [{ method: 'account', amount_usd: t }];
const ret = (saleId, body) => api('POST', `/api/admin/pos/sales/${saleId}/return`, body);
const custAr = async () => api('GET', `/api/ar/customers/${cust}`);
// Commission only looks at sales that have settled for 30 seconds: age them.
async function sweep() { sql(`UPDATE pos_sales SET created_at = created_at - INTERVAL '2 minutes' WHERE created_at > NOW() - INTERVAL '40 seconds'`); for (let i = 0; i < 20; i++) { const r = await api('POST', '/api/comm/run'); if (!r.busy) return r; await sleep(300); } }

// =============================================================== 1. cash sale
const s1 = await sell([line(A, 2, 1000), line(B, 1, 500)], cash, { sales_rep_id: rep, sales_rep_name: 'Rep ' + stamp });
ok(s1.id > 0, 'cash sale rung: 2 pads and 1 filter, ' + s1.total_usd);
if (sql(`SELECT COUNT(*) FROM pos_sales WHERE id = ${s1.id || 0}`) !== '1') { console.log('FAIL the server is not writing to the RET_TEST_PSQL database: stopping'); process.exit(1); }
const gct = r2(n(s1.tax_usd) / n(s1.subtotal_usd));   // the rate this store charges
ok(stock(A) === 48 && stock(B) === 49, 'stock left the shelf');
await sweep();
const earned1 = n(sql(`SELECT COALESCE(SUM(amount), 0) FROM commission_entries WHERE sale_id = ${s1.id} AND kind = 'earned'`));
ok(near(earned1, 125), `the rep earned 5% of 2,500 = 125 (${earned1})`);
await post();
const till = Number(sql(`SELECT session_id FROM till_sales WHERE sale_id = ${s1.id}`) || 0);
const drawer = async () => (await api('GET', `/api/cash/till/sessions/${till}`)).cash || {};
const drawer0 = await drawer();
ok(till > 0 && near(drawer0.cash_sales, s1.total_usd), 'the sale is in the cash drawer for this shift');

// a look before leaping: what it would be, with nothing written
let r = await ret(s1.id, { items: [{ sale_item_id: s1.item(A), qty: 1 }], dry_run: true });
ok(r.dry_run && near(r.refund_total_usd, 1000 * (1 + gct)) && settle(r).cash === r.refund_total_usd, `a dry run says ${r.refund_total_usd} back in cash`);
ok(sql(`SELECT COUNT(*) FROM pos_sale_returns_all`) === '0', 'and writes nothing');

// partial return: 1 of the 2 pads
const arBefore = bal('ar'), cashBefore = bal('cash_drawers');
const r1 = await ret(s1.id, { items: [{ sale_item_id: s1.item(A), qty: 1 }], reason: 'Wrong part' });
ok(r1._status === 200 && /^RET-\d{4}-\d{5}$/.test(r1.return_number), 'returned 1 pad: credit note ' + r1.return_number + (r1.error ? ' [' + r1.error + ']' : ''));
ok(near(r1.refund_subtotal_usd, 1000) && near(r1.refund_tax_usd, 1000 * gct) && near(r1.refund_total_usd, 1000 * (1 + gct)), 'worth the pad and its GCT');
ok(near(settle(r1).cash, r1.refund_total_usd) && r1.settlements.length === 1, 'given back in cash, the way the sale was paid');
ok(stock(A) === 49, 'the pad is back in stock');
await post();
let e = entry('return', r1.id);
ok(near(e.sales_returns, 1000) && near(e.gct, 1000 * gct) && near(e.ar, -r1.refund_total_usd), 'the return posts Dr sales returns 1,000 and GCT; Cr A/R');
ok(near(e.inventory, 600) && near(e.cogs, -600), 'and puts the pad back at the 600 it cost: Dr inventory, Cr cost of goods');
e = entry('return_refund', r1.settlements[0].id);
ok(near(e.ar, r1.refund_total_usd) && near(e.cash_drawers, -r1.refund_total_usd), 'the refund posts Dr A/R; Cr cash drawer');
ok(near(bal('ar'), arBefore) && near(bal('cash_drawers'), cashBefore - r1.refund_total_usd), 'A/R is back where it was; the drawer account is down by the refund');
const drawer1 = await drawer();
ok(near(drawer1.refunds, r1.refund_total_usd) && near(drawer1.expected, drawer0.expected - r1.refund_total_usd), 'the cashier\'s drawer expects that much less cash');
await sweep();
ok(near(sql(`SELECT COALESCE(SUM(amount), 0) FROM commission_entries WHERE return_id = ${r1.id} AND kind = 'clawback_return'`), -50), 'commission on the returned pad is clawed back: 5% of 1,000 = -50');

// credit note list
let list = await api('GET', '/api/admin/pos/returns?from=' + today + '&to=' + today);
let cn = (list.returns || []).find((x) => x.id === r1.id);
ok(list._status === 200 && cn, 'the return is listed under credit notes');
ok(cn && cn.receipt_number === s1.receipt_number && near(cn.refund_tax_usd, 1000 * gct) && cn.settlements[0].method === 'cash' && cn.units === 1, 'with its invoice, GCT, units and how it was given back');
let d = await api('GET', '/api/admin/pos/returns/' + r1.id);
ok(d.items && d.items.length === 1 && d.items[0].qty === 1 && d.journals.length === 2 && d.commission.length === 1, 'opening it shows the line, both journals and the clawback');
let sd = await api('GET', '/api/admin/pos/sales/' + s1.id);
ok(sd.items.find((i) => i.id === s1.item(A)).returned_qty === 1 && sd.returns.length === 1 && sd.returns[0].settlements.length === 1, 'the sale shows 1 pad returned and the credit note against it');

// never more than was sold
r = await ret(s1.id, { items: [{ sale_item_id: s1.item(A), qty: 2 }] });
ok(r._status === 400 && /Only 1 of 2/.test(r.error || ''), 'cannot return 2 pads when only 1 is left: ' + r.error);
r = await ret(s1.id, { items: [{ sale_item_id: s1.item(A), qty: 1 }, { sale_item_id: s1.item(A), qty: 1 }] });
ok(r._status === 400, 'nor by asking for the same line twice');
r = await ret(s1.id, { items: [{ sale_item_id: s1.item(A), qty: 0.5 }] });
ok(r._status === 400, 'nor half a unit');
r = await ret(s1.id, { items: [{ sale_item_id: s1.item(B), qty: 1 }], settlements: [{ method: 'cash', amount: 99999 }] });
ok(r._status === 400, 'the amounts given back must add up to the return');
r = await ret(s1.id, { items: [{ sale_item_id: s1.item(B), qty: 1 }], refund_method: 'account' });
ok(r._status === 400, 'a walk-in sale has no account to credit');
r = await api('POST', `/api/admin/pos/sales/${s1.id}/void`, {});
ok(r._status === 400, 'a sale with a return on it cannot be voided whole');

// a second return on the same sale: the other pad, with a 10% restocking fee, to store credit
const r1b = await ret(s1.id, { items: [{ sale_item_id: s1.item(A), qty: 1 }], refund_method: 'store_credit', restock_fee_pct: 10 });
ok(r1b._status === 200 && near(r1b.restock_fee_usd, 100) && near(r1b.refund_total_usd, 1000 * (1 + gct) - 100), 'second return keeps a 10% restocking fee (100) and gives back the rest' + (r1b.error ? ' [' + r1b.error + ']' : ''));
ok(/^GC-/.test(r1b.store_credit_code || '') && near(sql(`SELECT balance_usd FROM gift_cards WHERE code = '${r1b.store_credit_code}'`), r1b.refund_total_usd), 'as store credit ' + r1b.store_credit_code);
await post();
e = entry('return', r1b.id);
ok(near(e.restocking_fees, -100) && near(e.sales_returns, 1000) && near(e.ar, -r1b.refund_total_usd), 'the fee is income: Cr restocking fees 100');
e = entry('return_refund', r1b.settlements[0].id);
ok(near(e.gift_cards, -r1b.refund_total_usd), 'store credit is owed to the customer: Cr gift cards and store credit');
r = await ret(s1.id, { items: [{ sale_item_id: s1.item(A), qty: 1 }] });
ok(r._status === 400 && /already been returned/.test(r.error || ''), 'the pads are all returned now');

// ========================================================= 2. sale on account
const s2 = await sell([line(A, 2, 1000)], onAccount, { customer_id: cust, customer_name: custName });
ok(s2.id > 0 && near(s2.balance_due_usd, s2.total_usd), 'sale on account: 2 pads, ' + s2.total_usd + ' owed');
await post();
let ar = await custAr();
ok(near(ar.open, s2.total_usd), 'the customer owes it');
const cashB2 = bal('cash_drawers'), arB2 = bal('ar');
r = await ret(s2.id, { items: [{ sale_item_id: s2.item(A), qty: 1 }], settlements: [{ method: 'cash', amount: 1000 * (1 + gct) }] });
ok(r._status === 400 && /paid/.test(r.error || ''), 'no cash back on an invoice nobody has paid: ' + (r.error || '').slice(0, 70));
const r2a = await ret(s2.id, { items: [{ sale_item_id: s2.item(A), qty: 1 }], refund_method: 'cash' });
ok(r2a._status === 200 && near(settle(r2a).account, r2a.refund_total_usd) && !settle(r2a).cash, 'asked for cash, it goes on the account instead: a credit note for ' + r2a.refund_total_usd);
ok(near(r2a.account_credit_applied, r2a.refund_total_usd) && near(r2a.account_credit_left, 0), 'taken off the invoice it was sold on');
ar = await custAr();
ok(near(ar.open, s2.total_usd / 2) && near(ar.credit, 0), 'the customer now owes half');
ok(ar.payments.some((p) => p.method === 'credit_note' && p.reference === r2a.return_number), 'the credit note shows on the customer\'s account');
await post();
e = entry('return', r2a.id);
ok(near(e.ar, -r2a.refund_total_usd) && near(e.sales_returns, 1000), 'the ledger takes it off A/R: the reversal of the sale');
ok(sql(`SELECT COUNT(*) FROM gl_entries e JOIN pos_return_settlements st ON st.id = e.source_id WHERE e.source_kind = 'return_refund' AND st.return_id = ${r2a.id}`) === '0', 'no refund entry: no money moved');
ok(sql(`SELECT COUNT(*) FROM gl_entries e JOIN account_payments_all ap ON ap.id = e.source_id WHERE e.source_kind = 'account_payment' AND ap.return_id = ${r2a.id}`) === '0', 'and the credit is not posted a second time as a payment');
ok(near(bal('cash_drawers'), cashB2) && near(bal('ar'), arB2 - r2a.refund_total_usd), 'cash untouched; A/R down by the credit note');

// ======================================= 3. account sale, paid, then returned
const s3 = await sell([line(B, 4, 500)], onAccount, { customer_id: cust, customer_name: custName });
r = await api('POST', '/api/ar/payments', { customer_id: cust, amount: s3.total_usd, method: 'bank', paid_on: today, deposit_account_id: bank, applications: [{ sale_id: s3.id, amount: s3.total_usd }] });
ok(r._status === 200, 'second account sale paid in full by bank transfer' + (r.error ? ' [' + r.error + ']' : ''));
const r3 = await ret(s3.id, { items: [{ sale_item_id: s3.item(B), qty: 2 }] });
ok(r3._status === 200 && near(settle(r3).account, r3.refund_total_usd), 'returned 2 of 4: credit note ' + r3.return_number + (r3.error ? ' [' + r3.error + ']' : ''));
ok(near(r3.account_credit_applied, 0) && near(r3.account_credit_left, r3.refund_total_usd), 'the invoice was already paid, so it is credit on the account');
ar = await custAr();
ok(near(ar.credit, r3.refund_total_usd) && near(ar.open, s2.total_usd / 2), 'the customer has that credit, and still owes the first invoice');
// use part of it on the open invoice, pay the rest out
const cnPay = ar.payments.find((p) => p.reference === r3.return_number);
r = await api('POST', `/api/ar/payments/${cnPay.id}/apply`, { applications: [{ sale_id: s2.id, amount: 200 }] });
ok(r._status === 200, 'credit applied to another open invoice');
r = await api('POST', `/api/admin/pos/returns/${r3.id}/refund-credit`, { amount: r3.refund_total_usd, method: 'cash' });
ok(r._status === 400, 'cannot pay out credit already used on an invoice');
const out3 = r2(r3.refund_total_usd - 200);
const cashB3 = bal('cash_drawers');
r = await api('POST', `/api/admin/pos/returns/${r3.id}/refund-credit`, { amount: out3, method: 'cash' });
ok(r._status === 200 && near(r.paid_out, out3), 'the unused credit is paid out in cash' + (r.error ? ' [' + r.error + ']' : ''));
await post();
ar = await custAr();
ok(near(ar.credit, 0) && near(ar.open, s2.total_usd / 2 - 200), 'no credit left; the first invoice is down by the 200');
e = entry('return_refund', r.settlement_id);
ok(near(e.ar, out3) && near(e.cash_drawers, -out3) && near(bal('cash_drawers'), cashB3 - out3), 'paying it out posts Dr A/R; Cr cash drawer');

// ========================================================== 4. split tender
const s4 = await sell([line(A, 2, 1000)], (t) => [{ method: 'cash', amount_usd: r2(t * 0.4), amount_tendered: r2(t * 0.4) }, { method: 'card', amount_usd: r2(t - r2(t * 0.4)), reference: '4242' }]);
const r4 = await ret(s4.id, { items: [{ sale_item_id: s4.item(A), qty: 1 }] });
ok(r4._status === 200 && near(settle(r4).cash, r4.refund_total_usd * 0.4) && near(settle(r4).card, r4.refund_total_usd * 0.6), 'split tender (40% cash, 60% card) is given back 40% cash, 60% card' + (r4.error ? ' [' + r4.error + ']' : ''));
await post();
ok(near(entry('return_refund', r4.settlements.find((x) => x.method === 'card').id).card_clearing, -settle(r4).card), 'the card part posts to card clearing');

// part paid: half cash, half on account
const s5 = await sell([line(A, 2, 1000)], (t) => [{ method: 'cash', amount_usd: r2(t / 2), amount_tendered: r2(t / 2) }, { method: 'account', amount_usd: r2(t - r2(t / 2)) }], { customer_id: cust, customer_name: custName });
ok(s5.id > 0 && near(s5.balance_due_usd, s5.total_usd / 2), 'part-paid sale: half cash, half on account');
const openB5 = (await custAr()).open;
const r5 = await ret(s5.id, { items: [{ sale_item_id: s5.item(A), qty: 2 }] });
ok(r5._status === 200 && near(settle(r5).cash, s5.total_usd / 2) && near(settle(r5).account, s5.total_usd / 2), 'returned whole: the cash half back in cash, the other half off the account' + (r5.error ? ' [' + r5.error + ']' : ''));
ok(near((await custAr()).open, openB5 - s5.total_usd / 2), 'and that invoice no longer owes anything');
r = await ret(s5.id, { items: [{ sale_item_id: s5.item(A), qty: 1 }] });
ok(r._status === 400, 'nothing left to return on it');
// the bill itself, recalled: it shows what is owed now, not what was charged at the till
sd = await api('GET', '/api/admin/pos/sales/' + s5.id);
ok(sd.sale.fully_returned === true && near(sd.sale.balance_due_usd, 0) && near(sd.sale.charged_to_account_usd, s5.total_usd / 2) && near(sd.sale.returned_usd, s5.total_usd), 'recalled, the bill shows returned in full and nothing owed (it was charged ' + sd.sale.charged_to_account_usd + ')');
list = await api('GET', '/api/admin/pos/sales?q=' + s5.receipt_number);
ok((list.sales || []).some((x) => x.id === s5.id && x.fully_returned && near(x.balance_due_usd, 0)), 'and so does the recall list');
sd = await api('GET', '/api/admin/pos/sales/' + s2.id);
ok(sd.sale.fully_returned === false && near(sd.sale.balance_due_usd, (await custAr()).invoices.find((i) => i.id === s2.id && i.doc === 'sale').open), 'a part-returned bill shows the same balance as Receivables');

// ===================================== 5. damaged goods; a return, no receipt
const s6 = await sell([line(B, 2, 500)], cash);
const stockB6 = stock(B);
const r6 = await ret(s6.id, { items: [{ sale_item_id: s6.item(B), qty: 1, condition: 'writeoff' }], reason: 'Crushed' });
ok(r6._status === 200 && stock(B) === stockB6, 'a unit returned as a write-off does not go back on the shelf' + (r6.error ? ' [' + r6.error + ']' : ''));
ok(sql(`SELECT d.kind FROM pos_sale_return_items ri JOIN stock_dispositions d ON d.id = ri.disposition_id WHERE ri.return_id = ${r6.id}`) === 'writeoff', 'it is on the stock screen as written off');

const stockA7 = stock(A);
r = await api('POST', '/api/admin/pos/returns/no-receipt', { items: [{ product_img: A, qty: 1 }] });
ok(r._status === 400, 'a return with no receipt needs a reason');
r = await api('POST', '/api/admin/pos/returns/no-receipt', { items: [{ product_img: A, qty: 1, unit_price_usd: 5000 }], reason: 'Lost receipt' });
ok(r._status === 400, 'and cannot be given more than the part sells for');
const r7 = await api('POST', '/api/admin/pos/returns/no-receipt', { items: [{ product_img: A, qty: 1, unit_price_usd: 800 }], reason: 'Lost receipt', customer_name: 'No Receipt ' + stamp });
ok(r7._status === 200 && settle(r7).store_credit > 0 && stock(A) === stockA7 + 1, 'a manager takes a part back with no receipt, for store credit ' + (r7.store_credit_code || r7.error));
await post();
e = entry('return', r7.id);
ok(near(e.sales_returns, 800) && near(e.inventory, 600) && near(e.ar, -r7.refund_total_usd), 'it posts like any return, at today\'s cost');
ok(sql(`SELECT no_receipt::text || ':' || (approved_by IS NOT NULL)::text FROM pos_sale_returns_all WHERE id = ${r7.id}`) === 'true:true', 'and records who approved it');

// ============================== 6. return after the commission was paid
const s8 = await sell([line(A, 2, 1000)], cash, { sales_rep_id: rep, sales_rep_name: 'Rep ' + stamp });
await sweep();
r = await api('POST', '/api/comm/statements', { rep_id: rep, period_to: today });
const stId = r.id || (r.statement && r.statement.id);
ok(stId > 0, 'commission statement raised' + (r.error ? ' [' + r.error + ']' : ''));
await api('POST', `/api/comm/statements/${stId}/approve`, {});
r = await api('POST', `/api/comm/statements/${stId}/pay`, {});
ok(sql(`SELECT status FROM commission_statements WHERE id = ${stId}`) === 'paid' && sql(`SELECT status FROM commission_entries WHERE sale_id = ${s8.id} AND kind = 'earned' LIMIT 1`) === 'paid', 'approved and paid: the rep has the commission on this sale');
const r8 = await ret(s8.id, { items: [{ sale_item_id: s8.item(A), qty: 1 }] });
await sweep();
const claw = sql(`SELECT amount || '|' || status || '|' || COALESCE(statement_id::text, 'none') FROM commission_entries WHERE return_id = ${r8.id} AND kind = 'clawback_return'`);
ok(claw === '-50.00|earned|none', 'returned after payment: -50 waits for the rep\'s next statement (' + claw + ')');
const stPaid = n(sql(`SELECT total FROM commission_statements WHERE id = ${stId}`));
r = await api('POST', '/api/comm/statements', { rep_id: rep, period_to: today });
ok(r._status === 409 && /carry forward/.test(r.error || ''), 'on its own it makes no statement (nothing is owed): it carries forward');
const s9 = await sell([line(A, 2, 1000)], cash, { sales_rep_id: rep, sales_rep_name: 'Rep ' + stamp });
await sweep();
r = await api('POST', '/api/comm/statements', { rep_id: rep, period_to: today });
const st2 = r.id || (r.statement && r.statement.id);
ok(st2 > 0 && near(sql(`SELECT total FROM commission_statements WHERE id = ${st2}`), 50), 'the next statement is the new sale\'s 100 less the 50 clawed back' + (r.error ? ' [' + r.error + ']' : ''));
ok(near(sql(`SELECT total FROM commission_statements WHERE id = ${stId}`), stPaid) && sql(`SELECT status FROM commission_statements WHERE id = ${stId}`) === 'paid', 'the paid statement (' + stPaid + ') is not touched, so what payroll already paid stands');
await api('POST', `/api/comm/statements/${st2}/approve`, {});

// ============================================================ 7. void a return
// r8's clawback is on a statement: voiding the return must give it back with an adjustment.
const cashB9 = bal('cash_drawers'), stockA9 = stock(A), drawerB9 = await drawer();
r = await api('POST', `/api/admin/pos/returns/${r8.id}/void`, {});
ok(r._status === 400, 'voiding a return needs a reason');
await post();
r = await api('POST', `/api/admin/pos/returns/${r8.id}/void`, { reason: 'Customer kept it after all' });
ok(r._status === 200, 'return voided' + (r.error ? ' [' + r.error + ']' : ''));
ok(stock(A) === stockA9 - 1, 'the pad leaves stock again');
await post();
ok(sql(`SELECT COUNT(*) FROM gl_entries WHERE source_kind = 'return_void' AND source_id = ${r8.id}`) === '1' && sql(`SELECT COUNT(*) FROM gl_entries WHERE source_kind = 'return_refund_void' AND source_id = ${r8.settlements[0].id}`) === '1', 'both journals are reversed');
ok(sql(`SELECT COALESCE(SUM(l.amount), 0) FROM gl_lines l JOIN gl_entries e ON e.id = l.entry_id JOIN gl_accounts a ON a.id = l.account_id
          WHERE a.system_key IN ('sales_returns', 'gct', 'inventory', 'cogs', 'cash_drawers')
            AND ((e.source_kind IN ('return', 'return_void') AND e.source_id = ${r8.id}) OR (e.source_kind IN ('return_refund', 'return_refund_void') AND e.source_id = ${r8.settlements[0].id}))`) === '0.00', 'and net to nothing on every account');
ok(near(bal('cash_drawers'), cashB9 + r8.refund_total_usd) && near((await drawer()).expected, drawerB9.expected + r8.refund_total_usd), 'the cash is back in the drawer, in the ledger and on the cashier\'s count');
ok(sql(`SELECT COUNT(*) FROM pos_sale_returns WHERE id = ${r8.id}`) === '0' && sql(`SELECT COUNT(*) FROM pos_sale_returns_all WHERE id = ${r8.id} AND voided_at IS NOT NULL`) === '1', 'reports no longer count it; the record is kept');
list = await api('GET', '/api/admin/pos/returns?q=' + r8.return_number);
ok((list.returns || []).some((x) => x.id === r8.id && x.voided_at), 'it still shows under credit notes, marked voided');
sd = await api('GET', '/api/admin/pos/sales/' + s8.id);
ok(sd.items[0].returned_qty === 0 && sd.returns.length === 0, 'the sale shows nothing returned');
await sweep();
ok(sql(`SELECT amount || '|' || kind FROM commission_entries WHERE return_id = ${r8.id} AND kind = 'adjust'`) === '50.00|adjust', 'the clawback had been settled, so +50 is put back as an adjustment');
r = await api('POST', `/api/admin/pos/returns/${r8.id}/void`, { reason: 'Again' });
ok(r._status === 409, 'a return is voided once');
// a clawback not yet on a statement is simply cancelled
const s10 = await sell([line(A, 1, 1000)], cash, { sales_rep_id: rep, sales_rep_name: 'Rep ' + stamp });
await sweep();
const r10 = await ret(s10.id, { items: [{ sale_item_id: s10.item(A), qty: 1 }] });
await sweep();
await api('POST', `/api/admin/pos/returns/${r10.id}/void`, { reason: 'Keyed on the wrong invoice' });
await sweep();
ok(sql(`SELECT status FROM commission_entries WHERE return_id = ${r10.id} AND kind = 'clawback_return'`) === 'void', 'a clawback not yet on a statement is cancelled when the return is voided');
r = await ret(s10.id, { items: [{ sale_item_id: s10.item(A), qty: 1 }] });
ok(r._status === 200, 'and the sale can be returned again, properly');
// store credit that has been spent blocks the void
sql(`UPDATE gift_cards SET balance_usd = 1 WHERE code = '${r1b.store_credit_code}'`);
r = await api('POST', `/api/admin/pos/returns/${r1b.id}/void`, { reason: 'Test' });
ok(r._status === 409 && /spent/.test(r.error || ''), 'a return whose store credit has been spent cannot be voided');
sql(`UPDATE gift_cards SET balance_usd = ${r1b.refund_total_usd} WHERE code = '${r1b.store_credit_code}'`);
// voiding an account credit note puts the debt back
const openB11 = (await custAr()).open;
r = await api('POST', `/api/admin/pos/returns/${r2a.id}/void`, { reason: 'Customer kept it' });
ok(r._status === 200 && near((await custAr()).open, openB11 + r2a.refund_total_usd), 'voiding a credit note on an account sale puts the amount back on what the customer owes');

// ============================================================ 8. closed month
const monthStart = today.slice(0, 7) + '-01';
sql(`INSERT INTO gl_periods (month) VALUES ('${monthStart}') ON CONFLICT DO NOTHING`);
const s12 = await sell([line(B, 1, 500)], cash);
const r12 = await ret(s12.id, { items: [{ sale_item_id: s12.item(B), qty: 1 }] });
await post();
const dated = sql(`SELECT to_char(entry_date, 'YYYY-MM-DD') || '|' || memo FROM gl_entries WHERE source_kind = 'return' AND source_id = ${r12.id}`);
ok(dated && dated.slice(0, 7) > today.slice(0, 7) && /closed/.test(dated), 'with this month closed, a return posts on the first day of the next open month and says so');
sql(`DELETE FROM gl_periods WHERE month = '${monthStart}'`);

// ====================================================== 9. everything agrees
await post();
ok(sql(`SELECT COUNT(*) FROM (SELECT entry_id FROM gl_lines GROUP BY 1 HAVING abs(SUM(amount)) > 0.005) x`) === '0', 'every journal balances');
ok(sql(`SELECT COUNT(*) FROM gl_lines l JOIN gl_entries e ON e.id = l.entry_id JOIN gl_accounts a ON a.id = l.account_id WHERE a.system_key = 'suspense' AND e.source_kind LIKE 'return%'`) === '0', 'no return needed the suspense account');
ok(sql(`SELECT COUNT(*) FROM pos_sale_returns_all r WHERE NOT EXISTS (SELECT 1 FROM gl_entries e WHERE e.source_kind = 'return' AND e.source_id = r.id)`) === '0', 'every return is in the ledger');
ok(sql(`SELECT COUNT(*) FROM pos_return_settlements st WHERE st.method <> 'account' AND st.voided_at IS NULL AND NOT EXISTS (SELECT 1 FROM gl_entries e WHERE e.source_kind = 'return_refund' AND e.source_id = st.id)`) === '0', 'and so is every refund');
const tie = ((await api('GET', '/api/gl/tieout')).checks || []);
const tAr = tie.find((c) => c.key === 'ar') || {}, tGc = tie.find((c) => c.key === 'gift_cards') || {}, tSu = tie.find((c) => c.key === 'suspense') || {};
ok(near(tAr.gl, tAr.system), `A/R in the ledger (${tAr.gl}) is what customers owe (${tAr.system})`);
ok(near(tGc.gl, tGc.system), `store credit in the ledger (${tGc.gl}) is what is on the cards (${tGc.system})`);
ok(near(tSu.gl, 0), 'suspense is empty');
ar = await custAr();
ok(near(ar.balance, n(sql(`SELECT COALESCE(SUM(l.amount), 0) FROM gl_lines l JOIN gl_accounts a ON a.id = l.account_id WHERE a.system_key = 'ar' AND l.party = '${custName.slice(0, 41)}'`))), `the customer's balance in Receivables (${ar.balance}) is their balance in the ledger`);
const live = sql(`SELECT COUNT(*) || '|' || COALESCE(SUM(refund_total_usd), 0) || '|' || COALESCE(SUM(refund_tax_usd), 0) FROM pos_sale_returns`).split('|');
r = await api('GET', `/api/admin/reports/returns?from=2000-01-01&to=2999-12-31`);
const rt = r.totals || r.summary || r;
ok(r._status === 200 && JSON.stringify(r).includes(String(Number(live[1]))), 'the returns report totals ' + live[1] + ' over ' + live[0] + ' returns, voided ones left out');
list = await api('GET', '/api/admin/pos/returns?from=2000-01-01&to=2999-12-31');
ok(near(list.totals.count, live[0]) && near(list.totals.refunded, live[1]) && near(list.totals.tax, live[2]), 'and the credit note list agrees with it');
const cashOut = n(sql(`SELECT COALESCE(SUM(amount_usd), 0) FROM pos_return_settlements WHERE method = 'cash' AND voided_at IS NULL AND till_session_id = ${till}`));
ok(near((await drawer()).refunds, cashOut), `the drawer shows ${cashOut} of cash refunds, the same as the refunds on record`);

console.log(`\n${pass} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
