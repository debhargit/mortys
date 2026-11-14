// The checks on sales rung offline (offline-check.js), without a database.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const check = require('../offline-check.js');
const storeTax = require('../store-tax.js');

let n = 0, bad = 0;
const A = (label, ok, extra) => { n++; if (!ok) bad++; console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || extra === undefined ? '' : '  -> ' + JSON.stringify(extra).slice(0, 400))); };
const KEY = 'a'.repeat(64);
const now = Date.parse('2026-11-13T20:00:00Z');
const taxCfg = { enabled: true, default_class: 'STD', default_rate: 15, classes: [{ code: 'STD', rate: 15 }], categories: {}, freight_taxable: true };
const taxRates = { 'oil.jpg': { code: 'STD', rate: 15, standard: true } };
const products = new Map([['oil.jpg', { img: 'oil.jpg', name: 'Oil filter', price: 1500, is_active: true }]]);
const cashier = (caps) => ({ exists: true, disabled: false, can: (k) => (caps || ['pos.access', 'pos.line_discount', 'pos.price_override']).includes(k) });

function sale(seq, prev, over) {
  const rec = Object.assign({
    uid: 'u-0000000000000000-' + seq, receipt: 'OFF-1-000' + seq, seq, prev, at: '2026-11-13T19:30:00Z', down_since: '2026-11-13T19:00:00Z',
    terminal_id: 1, user_id: 7, method: 'cash', tendered: 2000, subtotal: 1500, discount: 0, tax: 225, total: 1725,
    lines: [{ img: 'oil.jpg', name: 'Oil filter', sku: 'OF', qty: 1, price: 1500, disc: 0, net: 1500, rate: 15 }],
    customer_name: 'Ann Brown',
    body: { items: [{ product_img: 'oil.jpg', description: 'Oil filter', qty: 1, unit_price_usd: 1500, discount_usd: 0, price_manual: false }],
      payment_method: 'cash', amount_tendered: 2000, reference: null, customer_name: 'Ann Brown', customer_phone: null, notes: 'Rung offline as OFF-1-000' + seq, cashier_id: 7 },
  }, over || {});
  rec.sig = check.sign(KEY, rec);
  return rec;
}
const row = (rec) => ({ uid: rec.uid, terminal_id: rec.terminal_id, cashier_id: rec.user_id, total_usd: rec.total, record: rec, body: rec.body });
const ctx = (term, extra) => Object.assign({ terminal: Object.assign({ id: 1, status: 'approved', offline_key: KEY, offline_seq: 0, offline_head: null }, term || {}),
  uploader: 1, cashier: cashier(), products, taxCfg, taxRates, compute: storeTax.compute, reviewOver: 0, now }, extra || {});
const codes = (f) => f.map((x) => x.code);

const s1 = sale(1, '');
A('a clean first sale has no findings', check.scan(row(s1), ctx()).length === 0, check.scan(row(s1), ctx()));
const s2 = sale(2, check.chainHash(s1));
A('the next sale in the chain is clean', check.scan(row(s2), ctx({ offline_seq: 1, offline_head: check.chainHash(s1) })).length === 0);

const t = JSON.parse(JSON.stringify(s1)); t.body.items[0].unit_price_usd = 10; t.lines[0].price = 10;
A('changed after signing: signature', codes(check.scan(row(t), ctx())).includes('signature'));
A('signed with another key: signature', codes(check.scan(row(s1), ctx({ offline_key: 'b'.repeat(64) }))).includes('signature'));
A('no key on the server: unsigned', codes(check.scan(row(s1), ctx({ offline_key: null }))).includes('unsigned'));
A('a replayed sale: replay', codes(check.scan(row(s1), ctx({ offline_seq: 1, offline_head: check.chainHash(s1) }))).includes('replay'));
A('a sale missing before this one: gap', codes(check.scan(row(sale(3, 'x')), ctx({ offline_seq: 1, offline_head: check.chainHash(s1) }))).includes('gap'));
A('wrong previous hash: chain', codes(check.scan(row(sale(2, 'f'.repeat(64))), ctx({ offline_seq: 1, offline_head: check.chainHash(s1) }))).includes('chain'));
A('sent by another terminal: uploader', codes(check.scan(row(s1), ctx({}, { uploader: 2 }))).includes('uploader'));
A('a blocked terminal: terminal', codes(check.scan(row(s1), ctx({ status: 'blocked' }))).includes('terminal'));

const inj = (over) => codes(check.scan(row(sale(1, '', over)), ctx()));
A('SQL in a customer name: sql', inj({ customer_name: "x'; DROP TABLE users; --", body: Object.assign({}, s1.body, { customer_name: "x'; DROP TABLE users; --" }) }).includes('sql'));
A('UNION SELECT in a reference: sql', inj({ body: Object.assign({}, s1.body, { reference: '1 UNION SELECT password_hash FROM users' }) }).includes('sql'));
A('a script tag: script', inj({ body: Object.assign({}, s1.body, { notes: '<script>alert(1)</script>' }) }).includes('script'));
A('an onerror handler: script', inj({ body: Object.assign({}, s1.body, { customer_name: '<img src=x onerror=alert(1)>' }) }).includes('script'));
A('hidden control characters: control', inj({ body: Object.assign({}, s1.body, { customer_name: 'Ann\u0000Brown' }) }).includes('control'));
A('an extra field in the sale: field', inj({ body: Object.assign({}, s1.body, { cashier_id: 7, is_admin: true }) }).includes('field'));
A('an apostrophe in a name is fine', inj({ customer_name: "Ann O'Brien", body: Object.assign({}, s1.body, { customer_name: "Ann O'Brien" }) }).length === 0);
A('a part name with "<" and "--" is fine', check.scan(row(sale(1, '', { lines: [Object.assign({}, s1.lines[0], { name: 'FILTER <A/C> -- HONDA' })] })), ctx()).length === 0);

const s9 = sale(1, '', { body: Object.assign({}, s1.body, { items: [Object.assign({}, s1.body.items[0], { unit_price_usd: 1000 })] }), lines: [Object.assign({}, s1.lines[0], { price: 1000, net: 1000 })], subtotal: 1000, tax: 150, total: 1150 });
A('a price that is not the catalogue’s: price', codes(check.scan(row(s9), ctx())).includes('price'));
const s10 = sale(1, '', { total: 1800 });
A('a total the server cannot reach: total', codes(check.scan(row(Object.assign(row(s10), { total_usd: 1800 })), ctx())).includes('total') || codes(check.scan(row(s10), ctx())).includes('total'));
const s11 = sale(1, '', { body: Object.assign({}, s1.body, { items: [Object.assign({}, s1.body.items[0], { discount_usd: 100 })] }), lines: [Object.assign({}, s1.lines[0], { disc: 100, net: 1400 })], discount: 100, tax: 210, total: 1610 });
A('a discount by a cashier who may not: discount', codes(check.scan(row(s11), ctx({}, { cashier: cashier(['pos.access']) }))).includes('discount'));
A('a product not in the catalogue: product', codes(check.scan(row(sale(1, '', { body: Object.assign({}, s1.body, { items: [Object.assign({}, s1.body.items[0], { product_img: 'nope.jpg' })] }), lines: [Object.assign({}, s1.lines[0], { img: 'nope.jpg' })] })), ctx())).includes('product'));
A('dated in the future: time', codes(check.scan(row(sale(1, '', { at: '2026-11-20T00:00:00Z' })), ctx())).includes('time'));
A('a big sale over the limit: amount', codes(check.scan(row(s1), ctx({}, { reviewOver: 1000 }))).includes('amount'));
A('less cash than the total: payment', codes(check.scan(row(sale(1, '', { tendered: 100, body: Object.assign({}, s1.body, { amount_tendered: 100 }) })), ctx())).includes('payment'));
A('a method the offline till does not take: payment', codes(check.scan(row(sale(1, '', { method: 'account', body: Object.assign({}, s1.body, { payment_method: 'account' }) })), ctx())).includes('payment'));
A('the filed total differs from the signed sale: mismatch', codes(check.scan(Object.assign(row(s1), { total_usd: 1 }), ctx())).includes('mismatch'));

console.log(n + ' checks');
if (bad) process.exitCode = 1;
