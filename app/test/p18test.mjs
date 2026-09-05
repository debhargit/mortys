import { fileURLToPath } from 'node:url';
// Portable base: this file lives in app/test/, so app/ is one level up.
const APP = new URL('../', import.meta.url).href;            // file:///.../app/
const APP_DIR = fileURLToPath(APP);                          // native path

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
const ENV = { DB: makeDB(sdb), SESSION_SECRET: 'test-secret-p18' };
const { sessionCookie } = await import(APP + 'functions/_lib/session.js');
async function cookieFor(userId) { return (await sessionCookie(ENV, { userId, epoch: 0 })).split(';')[0]; }
const routes = [];
const app = {};
for (const v of ['get', 'post', 'patch', 'delete', 'put']) app[v] = (p, ...r) => routes.push({ v, p, h: r[r.length - 1] });
for (const mod of ['inventory', 'storefront', 'customer', 'admin', 'admin_misc']) {
  (await import(APP + 'functions/_routes/' + mod + '.js')).default(app);
}
console.log('mounted', routes.length);

function toRe(p) { return new RegExp('^' + p.replace(/:[A-Za-z_]+/g, '([^/]+)') + '$'); }
function pn(p) { return (p.match(/:([A-Za-z_]+)/g) || []).map((s) => s.slice(1)); }
function match(v, url) {
  const [p, qs] = url.split('?'); const query = Object.fromEntries(new URLSearchParams(qs || ''));
  for (const r of routes) { if (r.v !== v) continue; const m = toRe(r.p).exec(p); if (!m) continue;
    const params = {}; pn(r.p).forEach((n, i) => params[n] = decodeURIComponent(m[i + 1])); return { r, params, query }; }
  return null;
}
let SESSION_USER = null;
let st = 200;
async function call(v, url, { body, user, cookie } = {}) {
  const m = match(v, url); if (!m) throw new Error('no route ' + v + ' ' + url); st = 200;
  const ctxUser = user !== undefined ? user : SESSION_USER;
  const headers = new Headers({ 'content-type': 'application/json' });
  if (cookie) headers.set('cookie', cookie);
  const raw = new Request('https://x' + url, { method: v.toUpperCase(), headers });
  const c = {
    env: ENV, executionCtx: { waitUntil() {} },
    get: (k) => (k === 'user' ? ctxUser : undefined),
    req: {
      url: 'https://x' + url, method: v.toUpperCase(),
      param: (n) => m.params[n], query: (n) => (n == null ? m.query : m.query[n]),
      header: (n) => raw.headers.get(n),
      raw, json: async () => body || {},
      parseBody: async () => ({}),
    },
    json: (o, s) => { if (s) st = s; return { _json: o, _status: s || 200 }; },
  };
  const r = await m.r.h(c);
  return r && r._json !== undefined ? r._json : r;
}
const A = (l, ok) => { console.log((ok ? 'PASS  ' : 'FAIL  ') + l); if (!ok) process.exitCode = 1; };
const q1 = (s, ...p) => sdb.prepare(s).get(...p);

sdb.exec(`
UPDATE shop_settings SET storefront_prices = 1 WHERE id = 1;
INSERT INTO users (id,email,name,password_hash,is_admin,admin_role,is_staff,show_prices,created_at) VALUES
 (900,'owner@x.com','Owner','h',1,'owner',1,0,datetime('now')),
 (700,'buyer@x.com','Buyer','h',0,'',0,1,datetime('now'));
INSERT INTO products (img,name,make_model,category,condition,price_cents,stock_count,is_active,sku,barcode)
VALUES ('PLUG-BULK','Spark Plug','Generic','ignition','NEW',1000,100,1,'PLUG-BULK','111222');
INSERT INTO products (img,name,make_model,category,condition,price_cents,stock_count,is_active,sku)
VALUES ('NO-BREAKS','Wiper Blade','Generic','wipers','NEW',500,20,1,'WIPE-1');
`);

// ---- _lib/price_breaks.js: pure logic --------------------------------------
const { bestUnitPriceCents, loadBreaksByImg } = await import(APP + 'functions/_lib/price_breaks.js');
A('bestUnitPriceCents: below every break -> base price', bestUnitPriceCents(1000, [{ min_qty: 5, price_cents: 900 }], 1) === 1000);
A('bestUnitPriceCents: qty meets a break -> that price', bestUnitPriceCents(1000, [{ min_qty: 5, price_cents: 900 }], 5) === 900);
A('bestUnitPriceCents: qty meets the higher of two breaks -> the cheaper one', bestUnitPriceCents(1000, [{ min_qty: 5, price_cents: 900 }, { min_qty: 10, price_cents: 800 }], 12) === 800);
A('bestUnitPriceCents: out-of-order rows still resolve to the best price', bestUnitPriceCents(1000, [{ min_qty: 10, price_cents: 800 }, { min_qty: 5, price_cents: 900 }], 10) === 800);
A('bestUnitPriceCents: no breaks -> base price unchanged', bestUnitPriceCents(1000, [], 50) === 1000);

// ---- PUT /api/admin/products/:img/price-breaks -----------------------------
const ADMIN = { id: 900, is_admin: 1, admin_role: 'owner' };
let r = await call('put', '/api/admin/products/PLUG-BULK/price-breaks', { user: ADMIN, body: { breaks: [
  { min_qty: 5, price_usd: 9 }, { min_qty: 10, price_usd: 8 },
] } });
A('save breaks: succeeds', st === 200 && r.ok === true && r.count === 2);
let rows = sdb.prepare('SELECT * FROM product_price_breaks WHERE product_img = ? ORDER BY min_qty').all('PLUG-BULK');
A('save breaks: two rows persisted with the right prices', rows.length === 2 && rows[0].min_qty === 5 && rows[0].price_cents === 900 && rows[1].min_qty === 10 && rows[1].price_cents === 800);

r = await call('put', '/api/admin/products/PLUG-BULK/price-breaks', { user: ADMIN, body: { breaks: [{ min_qty: 1, price_usd: 9 }] } });
A('save breaks: rejects a quantity below 2', st === 400);
r = await call('put', '/api/admin/products/PLUG-BULK/price-breaks', { user: ADMIN, body: { breaks: [{ min_qty: 5, price_usd: 9 }, { min_qty: 5, price_usd: 8 }] } });
A('save breaks: rejects a duplicate quantity', st === 400);
r = await call('put', '/api/admin/products/does-not-exist/price-breaks', { user: ADMIN, body: { breaks: [] } });
A('save breaks: 404 for an unknown part', st === 404);

// Replacing the whole set drops what isn't resent.
r = await call('put', '/api/admin/products/PLUG-BULK/price-breaks', { user: ADMIN, body: { breaks: [{ min_qty: 5, price_usd: 9 }] } });
rows = sdb.prepare('SELECT * FROM product_price_breaks WHERE product_img = ?').all('PLUG-BULK');
A('save breaks: replace-the-whole-set semantics (down to 1 row)', st === 200 && rows.length === 1);

// Put the 2-tier set back for the rest of the suite.
await call('put', '/api/admin/products/PLUG-BULK/price-breaks', { user: ADMIN, body: { breaks: [
  { min_qty: 5, price_usd: 9 }, { min_qty: 10, price_usd: 8 },
] } });

// ---- GET /api/admin/products/:img exposes price_breaks ---------------------
r = await call('get', '/api/admin/products/PLUG-BULK', { user: ADMIN });
A('admin GET product: price_breaks present, ascending', st === 200 && r.product.price_breaks.length === 2 &&
  r.product.price_breaks[0].min_qty === 5 && r.product.price_breaks[0].price_usd === 9 && r.product.price_breaks[1].price_usd === 8);
r = await call('get', '/api/admin/products/NO-BREAKS', { user: ADMIN });
A('admin GET product: no breaks -> empty array, not missing', st === 200 && Array.isArray(r.product.price_breaks) && r.product.price_breaks.length === 0);

// ---- /api/admin/pos/scan exposes price_breaks ------------------------------
r = await call('get', '/api/admin/pos/scan?code=111222', { user: ADMIN });
A('pos/scan: finds by barcode and includes price_breaks', st === 200 && r.product.img === 'PLUG-BULK' && r.product.price_breaks.length === 2);

// ---- /api/products (list + single) expose price_breaks when priced --------
// The 0002 seed data already has dozens of real "Spark Plug" parts, so search
// by this test row's own SKU (unique) rather than the generic name.
const ck700 = await cookieFor(700);   // show_prices=1 customer
r = await call('get', '/api/products?q=PLUG-BULK', { cookie: ck700 });
const plug = (r.products || []).find((p) => p.img === 'PLUG-BULK');
A('storefront list: priced caller sees price_breaks', st === 200 && plug && plug.price_breaks.length === 2);

r = await call('get', '/api/products?q=PLUG-BULK');   // guest, storefront_prices=1 globally -> visible
A('storefront list: prices_visible true (global switch on)', r.prices_visible === true);

r = await call('get', '/api/products/PLUG-BULK', { cookie: ck700 });
A('storefront single product: price_breaks present', st === 200 && r.product.price_breaks.length === 2);

// ---- GET /api/cart: effective_price_usd reflects the qty already in cart ---
sdb.exec("INSERT INTO cart_items (user_id, product_img, qty) VALUES (700, 'PLUG-BULK', 7)");
r = await call('get', '/api/cart', { user: { id: 700 } });
const cartRow = r.cart.find((x) => x.img === 'PLUG-BULK');
A('cart: qty 7 (>= the 5-tier, < the 10-tier) prices at $9', cartRow && cartRow.price_usd === 10 && cartRow.effective_price_usd === 9);
A('cart: total reflects the effective price (7 * 9 = 63)', Math.abs(r.total_usd - 63) < 0.01);

// ---- /api/coupon/validate: subtotal preview matches the bulk price --------
r = await call('post', '/api/coupon/validate', { user: { id: 700 }, body: { code: 'NOPE-NOT-REAL' } });
A('coupon/validate: an unknown code still 400s cleanly (sanity check)', st === 400);

// ---- /api/checkout: charges the bulk price, not the base price ------------
r = await call('post', '/api/checkout', { user: { id: 700, show_prices: 1 }, body: { payment_method: 'cash_pickup' } });
A('checkout: bulk-priced order total (7 * $9 = $63)', st === 200 && Math.abs(r.total_usd - 63) < 0.01);
let orderItem = q1('SELECT * FROM order_items WHERE order_id = ?', r.order_id);
A('checkout: order_items line stores the bulk unit price, not the base price', orderItem.price_cents === 900);

// A quantity that does NOT reach any break still charges the base price.
sdb.exec("INSERT INTO cart_items (user_id, product_img, qty) VALUES (700, 'PLUG-BULK', 2)");
r = await call('post', '/api/checkout', { user: { id: 700, show_prices: 1 }, body: { payment_method: 'cash_pickup' } });
A('checkout: qty below every break -> base price (2 * $10 = $20)', st === 200 && Math.abs(r.total_usd - 20) < 0.01);

// ---- /api/checkout/guest: same repricing, no server-side cart -------------
r = await call('post', '/api/checkout/guest', { user: undefined, body: {
  name: 'Bulk Buyer', email: 'bulk@example.com', payment_method: 'cash_pickup',
  items: [{ img: 'PLUG-BULK', qty: 10 }],
} });
A('guest checkout: qty 10 hits the deeper tier (10 * $8 = $80)', st === 200 && Math.abs(r.total_usd - 80) < 0.01);

// ---- a product with no breaks is never affected ----------------------------
sdb.exec("INSERT INTO cart_items (user_id, product_img, qty) VALUES (700, 'NO-BREAKS', 50)");
r = await call('get', '/api/cart', { user: { id: 700 } });
const wiper = r.cart.find((x) => x.img === 'NO-BREAKS');
A('cart: a product with no breaks reports its base price as the effective price', wiper && wiper.effective_price_usd === 5);
