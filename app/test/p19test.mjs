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
const ENV = { DB: makeDB(sdb), SESSION_SECRET: 'test-secret-p19' };
const { sessionCookie } = await import(APP + 'functions/_lib/session.js');
async function cookieFor(userId) { return (await sessionCookie(ENV, { userId, epoch: 0 })).split(';')[0]; }
const routes = [];
const app = {};
for (const v of ['get', 'post', 'patch', 'delete', 'put']) app[v] = (p, ...r) => routes.push({ v, p, h: r[r.length - 1] });
for (const mod of ['inventory', 'storefront', 'customer']) {
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
let st = 200;
async function call(v, url, { body, user, cookie } = {}) {
  const m = match(v, url); if (!m) throw new Error('no route ' + v + ' ' + url); st = 200;
  const headers = new Headers({ 'content-type': 'application/json' });
  if (cookie) headers.set('cookie', cookie);
  const raw = new Request('https://x' + url, { method: v.toUpperCase(), headers });
  const c = {
    env: ENV, executionCtx: { waitUntil() {} },
    get: (k) => (k === 'user' ? user : undefined),
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
INSERT INTO products (img,name,make_model,category,condition,price_cents,stock_count,is_active,sku)
VALUES ('SALE-1','Wiper Blade','Generic','wipers','NEW',1000,50,1,'SALE-1-SKU');
INSERT INTO products (img,name,make_model,category,condition,price_cents,stock_count,is_active,sku)
VALUES ('SALE-EXPIRED','Old Filter','Generic','filters','NEW',2000,50,1,'SALE-EXP-SKU');
INSERT INTO products (img,name,make_model,category,condition,price_cents,stock_count,is_active,sku)
VALUES ('SALE-FUTURE','Air Filter','Generic','filters','NEW',3000,50,1,'SALE-FUT-SKU');
`);
const ADMIN = { id: 900, is_admin: 1, admin_role: 'owner' };

// ---- PATCH /api/admin/products/:img sets sale fields -----------------------
let r = await call('patch', '/api/admin/products/SALE-1', { user: ADMIN, body: {
  sale_price_usd: 7, sale_starts_at: null, sale_ends_at: '2099-01-01',
} });
A('patch: sale fields saved', r.ok === true);
let row = q1('SELECT * FROM products WHERE img = ?', 'SALE-1');
A('patch: sale_price_cents / sale_ends_at persisted', row.sale_price_cents === 700 && row.sale_ends_at === '2099-01-01');

// An already-expired sale on a different product (ends in the past).
sdb.exec("UPDATE products SET sale_price_cents = 1500, sale_ends_at = '2000-01-01' WHERE img = 'SALE-EXPIRED'");
// A not-yet-started sale (starts in the future).
sdb.exec("UPDATE products SET sale_price_cents = 2500, sale_starts_at = '2099-01-01' WHERE img = 'SALE-FUTURE'");

// ---- storefront list/detail expose sale_price_usd only while active -------
const ck700 = await cookieFor(700);
r = await call('get', '/api/products?q=SALE-1-SKU', { cookie: ck700 });
let p = r.products.find((x) => x.img === 'SALE-1');
A('list: active sale price exposed', p && p.price_usd === 10 && p.sale_price_usd === 7);

r = await call('get', '/api/products?q=SALE-EXP-SKU', { cookie: ck700 });
p = r.products.find((x) => x.img === 'SALE-EXPIRED');
A('list: an expired sale reports no active sale price', p && p.sale_price_usd === null);

r = await call('get', '/api/products?q=SALE-FUT-SKU', { cookie: ck700 });
p = r.products.find((x) => x.img === 'SALE-FUTURE');
A('list: a not-yet-started sale reports no active sale price', p && p.sale_price_usd === null);

r = await call('get', '/api/products/SALE-1', { cookie: ck700 });
A('single product: active sale price exposed', r.product.sale_price_usd === 7);

r = await call('get', '/api/products?q=SALE-1-SKU');   // guest, but storefront_prices=1 -> visible
A('list: sale price also visible to an un-approved guest once prices are public', r.products.find((x) => x.img === 'SALE-1').sale_price_usd === 7);

// ---- GET /api/cart: effective_price_usd uses the sale price ----------------
sdb.exec("INSERT INTO cart_items (user_id, product_img, qty) VALUES (700, 'SALE-1', 2)");
r = await call('get', '/api/cart', { user: { id: 700 } });
let cartRow = r.cart.find((x) => x.img === 'SALE-1');
A('cart: effective price is the sale price (below the bulk-break threshold)', cartRow.effective_price_usd === 7 && cartRow.sale_price_usd === 7);
A('cart: total reflects the sale price (2 * 7 = 14)', Math.abs(r.total_usd - 14) < 0.01);

// Sale price + a deeper bulk-break price -- customer gets whichever is cheaper.
await call('put', '/api/admin/products/SALE-1/price-breaks', { user: ADMIN, body: { breaks: [{ min_qty: 5, price_usd: 6 }] } });
sdb.exec("UPDATE cart_items SET qty = 5 WHERE product_img = 'SALE-1'");
r = await call('get', '/api/cart', { user: { id: 700 } });
cartRow = r.cart.find((x) => x.img === 'SALE-1');
A('cart: bulk break beats the sale price when it is cheaper', cartRow.effective_price_usd === 6);

// A quantity too low for the break still gets the sale price, not the regular one.
sdb.exec("UPDATE cart_items SET qty = 1 WHERE product_img = 'SALE-1'");
r = await call('get', '/api/cart', { user: { id: 700 } });
cartRow = r.cart.find((x) => x.img === 'SALE-1');
A('cart: below the break qty, sale price still wins over regular price', cartRow.effective_price_usd === 7);

// ---- checkout charges the sale price ---------------------------------------
r = await call('post', '/api/checkout', { user: { id: 700, show_prices: 1 }, body: { payment_method: 'cash_pickup' } });
A('checkout: total reflects the sale price (1 * $7)', st === 200 && Math.abs(r.total_usd - 7) < 0.01);
let orderItem = q1('SELECT * FROM order_items WHERE order_id = ?', r.order_id);
A('checkout: order_items line stores the sale price, not the regular price', orderItem.price_cents === 700);

// An expired sale never gets charged even if the admin forgot to clear it.
sdb.exec("INSERT INTO cart_items (user_id, product_img, qty) VALUES (700, 'SALE-EXPIRED', 1)");
r = await call('post', '/api/checkout', { user: { id: 700, show_prices: 1 }, body: { payment_method: 'cash_pickup' } });
A('checkout: an expired sale charges the regular price', st === 200 && Math.abs(r.total_usd - 20) < 0.01);

// ---- restricted (in-store-only) items block online checkout ----------------
sdb.exec(`
INSERT INTO products (img,name,make_model,category,condition,price_cents,stock_count,is_active,sku,restricted_instore_only)
VALUES ('INSTORE-1','Counter Only Part','Generic','misc','NEW',4000,10,1,'INSTORE-1-SKU',1);
`);
sdb.exec("DELETE FROM cart_items WHERE user_id = 700");
sdb.exec("INSERT INTO cart_items (user_id, product_img, qty) VALUES (700, 'INSTORE-1', 1)");
r = await call('post', '/api/checkout', { user: { id: 700, show_prices: 1 }, body: { payment_method: 'cash_pickup' } });
A('checkout: an in-store-only item blocks online checkout', st === 400 && r.code === 'restricted_instore_only' && /Counter Only Part/.test(r.error));
A('checkout: no order_items row was created for the blocked item', !q1("SELECT order_id FROM order_items WHERE product_img = 'INSTORE-1'"));

r = await call('post', '/api/checkout/guest', { user: undefined, body: {
  name: 'Guest Buyer', email: 'guest@example.com', payment_method: 'cash_pickup',
  items: [{ img: 'INSTORE-1', qty: 1 }],
} });
A('guest checkout: an in-store-only item blocks online checkout too', st === 400 && r.code === 'restricted_instore_only');
