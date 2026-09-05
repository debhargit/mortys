import { fileURLToPath } from 'node:url';
const APP = new URL('../', import.meta.url).href;
const APP_DIR = fileURLToPath(APP);

import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
process.chdir(APP_DIR);
const sdb = new DatabaseSync(':memory:');
sdb.exec('PRAGMA foreign_keys=ON;');
for (const f of fs.readdirSync('migrations').filter((x) => /^\d+.*\.sql$/.test(x)).sort()) {
  try { sdb.exec(fs.readFileSync('migrations/' + f, 'utf8')); }
  catch (e) { console.log('MIGRATION FAIL', f, e.message.split('\n')[0]); process.exit(1); }
}
console.log('migrations OK');
function makeDB(db) {
  return { prepare(sql) { return { _sql: sql, _b: [], bind(...b) { this._b = b; return this; },
      all() { return { results: db.prepare(this._sql).all(...this._b) }; },
      first() { const r = db.prepare(this._sql).get(...this._b); return r === undefined ? null : r; },
      run() { const r = db.prepare(this._sql).run(...this._b); return { success: true, meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } }; } }; },
    async batch(s) { const o = []; for (const x of s) o.push(x.run()); return o; } };
}
const ENV = { DB: makeDB(sdb), SESSION_SECRET: 'test-secret-p29' };
const routes = [];
const app = {};
for (const v of ['get', 'post', 'patch', 'delete', 'put']) app[v] = (p, ...r) => routes.push({ v, p, h: r[r.length - 1] });
for (const mod of ['inventory', 'storefront', 'customer', 'pos_txn']) (await import(APP + 'functions/_routes/' + mod + '.js')).default(app);
console.log('mounted', routes.length);
function toRe(p) { return new RegExp('^' + p.replace(/:[A-Za-z_]+/g, '([^/]+)') + '$'); }
function pn(p) { return (p.match(/:([A-Za-z_]+)/g) || []).map((s) => s.slice(1)); }
function match(v, url) { const [p, qs] = url.split('?'); const query = Object.fromEntries(new URLSearchParams(qs || ''));
  for (const r of routes) { if (r.v !== v) continue; const m = toRe(r.p).exec(p); if (!m) continue;
    const params = {}; pn(r.p).forEach((n, i) => params[n] = decodeURIComponent(m[i + 1])); return { r, params, query }; } return null; }
const OWNER = { id: 900, is_admin: 1, admin_role: 'owner' };
let st = 200;
async function call(v, url, { body, user } = {}) {
  const m = match(v, url); if (!m) throw new Error('no route ' + v + ' ' + url); st = 200;
  const raw = new Request('https://x' + url, { method: v.toUpperCase(), headers: { 'content-type': 'application/json' } });
  const c = {
    env: ENV, executionCtx: { waitUntil() {} },
    get: (k) => (k === 'user' ? (user === undefined ? OWNER : user) : undefined),
    req: { url: 'https://x' + url, method: v.toUpperCase(), param: (n) => m.params[n],
      query: (n) => (n == null ? m.query : m.query[n]),
      header: (n) => raw.headers.get(n), raw, json: async () => body || {}, parseBody: async () => ({}) },
    json: (o, s) => { if (s) st = s; return { _json: o, _status: s || 200 }; },
  };
  const r = await m.r.h(c); return r && r._json !== undefined ? r._json : r;
}
const A = (l, ok) => { console.log((ok ? 'PASS  ' : 'FAIL  ') + l); if (!ok) process.exitCode = 1; };
const q1 = (s, ...p) => sdb.prepare(s).get(...p);

sdb.exec('DELETE FROM products;');
sdb.exec(`
UPDATE shop_settings SET storefront_prices = 1 WHERE id = 1;
INSERT INTO users (id,email,name,password_hash,is_admin,admin_role,is_staff,show_prices,price_tier,created_at) VALUES
 (900,'owner@x.com','Owner','h',1,'owner',1,1,'retail',datetime('now')),
 (700,'trade@x.com','Trade Ted','h',0,'',0,1,'trade',datetime('now')),
 (701,'retail@x.com','Retail Rita','h',0,'',0,1,'retail',datetime('now')),
 (800,'tradepos@x.com','Trade POS','h',0,'',0,1,'trade',datetime('now')),
 (801,'retailpos@x.com','Retail POS','h',0,'',0,1,'retail',datetime('now'));
INSERT INTO products (img,name,make_model,category,condition,price_cents,stock_count,is_active,sku) VALUES
 ('WIDGET','Widget','Generic','misc','NEW',10000,100,1,'WIDGET'),
 ('GADGET','Gadget','Generic','misc','NEW',5000,100,1,'GADGET');
`);

// ---- 1. endpoints: save + validation ---------------------------------------
let r = await call('put', '/api/admin/products/WIDGET/qty-discounts', { body: { discounts: [
  { min_qty: 3, discount_pct: 2 }, { min_qty: 6, discount_pct: 5 },
] } });
A('qty-discounts: saved 2 tiers', st === 200 && r.count === 2);
A('qty-discounts: rows persisted', q1("SELECT discount_pct d FROM product_qty_discounts WHERE product_img='WIDGET' AND min_qty=6").d === 5);

r = await call('put', '/api/admin/products/WIDGET/qty-discounts', { body: { discounts: [{ min_qty: 1, discount_pct: 5 }] } });
A('qty-discounts: rejects min_qty < 2', st === 400);
r = await call('put', '/api/admin/products/WIDGET/qty-discounts', { body: { discounts: [{ min_qty: 3, discount_pct: 150 }] } });
A('qty-discounts: rejects pct > 100', st === 400);
// re-save the good set (the two bad calls above didn't touch the table -- they errored before the batch)
await call('put', '/api/admin/products/WIDGET/qty-discounts', { body: { discounts: [{ min_qty: 3, discount_pct: 2 }, { min_qty: 6, discount_pct: 5 }] } });

r = await call('put', '/api/admin/products/WIDGET/tier-prices', { body: { prices: { trade: 80, dealer: 70 } } });
A('tier-prices: saved trade + dealer', st === 200 && r.count === 2);
A('tier-prices: trade row is 8000c', q1("SELECT price_cents c FROM product_tier_prices WHERE product_img='WIDGET' AND tier='trade'").c === 8000);
A('tier-prices: fleet left unset (no row)', !q1("SELECT 1 FROM product_tier_prices WHERE product_img='WIDGET' AND tier='fleet'"));
r = await call('put', '/api/admin/products/WIDGET/tier-prices', { body: { prices: { trade: 80 } } });
A('tier-prices: a blank/omitted tier clears its row', st === 200 && !q1("SELECT 1 FROM product_tier_prices WHERE product_img='WIDGET' AND tier='dealer'"));
// restore trade + dealer
await call('put', '/api/admin/products/WIDGET/tier-prices', { body: { prices: { trade: 80, dealer: 70 } } });

// ---- 2. _lib/price_breaks.js resolver directly ---------------------------
const pb = await import(APP + 'functions/_lib/price_breaks.js');
const { d1 } = await import(APP + 'functions/_lib/db.js');
const DBW = d1(ENV);
A('effectiveBaseCents: min of retail / sale / tier', pb.effectiveBaseCents(10000, 9000, 8500) === 8500);
A('effectiveBaseCents: nulls ignored', pb.effectiveBaseCents(10000, null, null) === 10000);
const rows = [{ min_qty: 3, price_cents: null, discount_pct: 2 }, { min_qty: 6, price_cents: null, discount_pct: 5 }];
A('bestUnitPriceCents: below the first tier = base', pb.bestUnitPriceCents(10000, rows, 2, 10000) === 10000);
A('bestUnitPriceCents: qty 3 -> 2% off retail', pb.bestUnitPriceCents(10000, rows, 3, 10000) === 9800);
A('bestUnitPriceCents: % is off RETAIL not the base, then cheapest wins',
  pb.bestUnitPriceCents(8000, rows, 6, 10000) === 8000 /* 5% off 10000 = 9500 > 8000 tier base -> base wins */);
A('bestUnitPriceCents: % beats the base when it is lower',
  pb.bestUnitPriceCents(10000, rows, 6, 10000) === 9500);
A('bestUnitPriceCents: a too-generous row never raises the price',
  pb.bestUnitPriceCents(7000, [{ min_qty: 2, price_cents: null, discount_pct: 1 }], 5, 10000) === 7000);
const uni = await pb.loadBreaksByImg(DBW, ['WIDGET']);
A('loadBreaksByImg: returns the % rows for WIDGET, sorted', (uni.get('WIDGET') || []).map((x) => x.min_qty).join(',') === '3,6');
const tmap = await pb.loadTierPricesByImg(DBW, ['WIDGET']);
A('tierCentsFor: trade -> 8000, retail -> null, fleet(unset) -> null',
  pb.tierCentsFor(tmap.get('WIDGET'), 'trade') === 8000 &&
  pb.tierCentsFor(tmap.get('WIDGET'), 'retail') === null &&
  pb.tierCentsFor(tmap.get('WIDGET'), 'fleet') === null);

// ---- 3. /api/products carries the new fields --------------------------
r = await call('get', '/api/products?limit=50&q=WIDGET');
const wrow = (r.products || []).find((x) => x.img === 'WIDGET');
A('products: row exposes qty_discounts', wrow && Array.isArray(wrow.qty_discounts) && wrow.qty_discounts.length === 2);
A('products: headline price_usd stays retail (100)', wrow && Math.abs(wrow.price_usd - 100) < 0.01);
A('products: tier_price_usd null for a retail viewer', wrow && wrow.tier_price_usd == null);

// ---- 4. checkout applies the tier price + % break -------------------
async function checkoutOne(uid, img, qty) {
  sdb.exec(`DELETE FROM cart_items WHERE user_id = ${uid}`);
  sdb.exec(`INSERT INTO cart_items (user_id, product_img, qty) VALUES (${uid}, '${img}', ${qty})`);
  const res = await call('post', '/api/checkout', { user: { id: uid, show_prices: 1 }, body: { payment_method: 'cash_pickup' } });
  return res;
}
r = await checkoutOne(700, 'WIDGET', 1);   // trade, qty 1 -> tier price 80
A('checkout: a trade customer pays the tier set price ($80, not $100)',
  st === 200 && q1('SELECT price_cents c FROM order_items WHERE order_id = ?', r.order_id).c === 8000);
r = await checkoutOne(701, 'WIDGET', 1);   // retail, qty 1 -> retail 100
A('checkout: a retail customer pays retail ($100)',
  st === 200 && q1('SELECT price_cents c FROM order_items WHERE order_id = ?', r.order_id).c === 10000);
r = await checkoutOne(701, 'WIDGET', 6);   // retail, qty 6 -> 5% off retail = 95
A('checkout: qty 6 earns the 5% quantity discount ($95)',
  st === 200 && q1('SELECT price_cents c FROM order_items WHERE order_id = ?', r.order_id).c === 9500);
r = await checkoutOne(700, 'WIDGET', 6);   // trade: min(tier 80, 5%-off-retail 95) = 80
A('checkout: trade + qty 6 -> cheapest of tier ($80) and the % break ($95) wins',
  st === 200 && q1('SELECT price_cents c FROM order_items WHERE order_id = ?', r.order_id).c === 8000);
// guest checkout is always retail
r = await call('post', '/api/checkout/guest', { body: {
  name: 'Guest', email: 'g@example.com', payment_method: 'cash_pickup', items: [{ img: 'WIDGET', qty: 1 }],
} });
A('checkout/guest: always retail ($100)', st === 200 && q1('SELECT price_cents c FROM order_items WHERE order_id = ?', r.order_id).c === 10000);

// ---- 5. createPosSale floors a line to the tier price -----------------
const posSale = (customerId, item) => call('post', '/api/admin/pos/sale', { body: {
  items: [item], customer_id: customerId, payment_method: 'cash', amount_tendered: 100000,
} });
const lineCents = (id) => q1('SELECT unit_price_cents c FROM pos_sale_items WHERE sale_id = ?', id).c;

r = await posSale(800, { product_img: 'WIDGET', description: 'Widget', qty: 1, unit_price_usd: 100 });
if (st !== 200) console.log('  (sale error:', JSON.stringify(r) + ')');
A('pos sale: a trade customer’s line sent at retail is floored to the tier price ($80)',
  st === 200 && lineCents(r.id) === 8000);
r = await posSale(800, { product_img: 'GADGET', description: 'Gadget', qty: 1, unit_price_usd: 40 });
A('pos sale: a line with no tier price for that product is left as sent ($40)',
  st === 200 && lineCents(r.id) === 4000);
r = await posSale(801, { product_img: 'WIDGET', description: 'Widget', qty: 1, unit_price_usd: 100 });
A('pos sale: a retail customer is never floored ($100)',
  st === 200 && lineCents(r.id) === 10000);
r = await posSale(800, { product_img: 'WIDGET', description: 'Widget', qty: 1, unit_price_usd: 60 });
A('pos sale: a line already below the tier price is left alone ($60)',
  st === 200 && lineCents(r.id) === 6000);
