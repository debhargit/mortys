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
const ENV = { DB: makeDB(sdb), SESSION_SECRET: 'test-secret-p21' };
const { sessionCookie } = await import(APP + 'functions/_lib/session.js');
async function cookieFor(userId) { return (await sessionCookie(ENV, { userId, epoch: 0 })).split(';')[0]; }
const routes = [];
const app = {};
for (const v of ['get', 'post', 'patch', 'delete', 'put']) app[v] = (p, ...r) => routes.push({ v, p, h: r[r.length - 1] });
for (const mod of ['storefront', 'customer', 'admin_crm']) {
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
VALUES ('BRAKE-1','Brake Pad','Generic','brakes','NEW',5000,20,1,'BRAKE-1');
INSERT INTO products (img,name,make_model,category,condition,price_cents,stock_count,is_active,sku)
VALUES ('WIPER-1','Wiper Blade','Generic','wipers','NEW',3000,20,1,'WIPER-1');
`);
const ADMIN = { id: 900, is_admin: 1, admin_role: 'owner' };
const ck700 = await cookieFor(700);

// ---- create a whole-cart coupon (no scopes) -- must behave exactly as before ----
let r = await call('post', '/api/admin/coupons', { user: ADMIN, body: { code: 'WHOLECART', kind: 'percent', amount: 10 } });
A('create: whole-cart coupon (no scopes)', st === 200 && r.ok === true);

// ---- create a coupon scoped to the "brakes" category ------------------------
r = await call('post', '/api/admin/coupons', { user: ADMIN, body: {
  code: 'BRAKES20', kind: 'percent', amount: 20, scopes: [{ category: 'brakes' }],
} });
A('create: scoped coupon accepts scopes at creation', st === 200 && r.ok === true);

r = await call('get', '/api/admin/coupons', { user: ADMIN });
let wholecart = r.coupons.find((x) => x.code === 'WHOLECART');
let brakes20 = r.coupons.find((x) => x.code === 'BRAKES20');
A('list: whole-cart coupon has no scopes', wholecart && wholecart.scopes.length === 0);
A('list: scoped coupon reports its category scope', brakes20 && brakes20.scopes.length === 1 && brakes20.scopes[0].category === 'brakes');

// ---- PATCH replaces the scope set --------------------------------------------
r = await call('patch', '/api/admin/coupons/BRAKES20', { user: ADMIN, body: { scopes: [{ product_img: 'WIPER-1' }] } });
A('patch: replaces scopes', st === 200 && r.ok === true);
r = await call('get', '/api/admin/coupons', { user: ADMIN });
brakes20 = r.coupons.find((x) => x.code === 'BRAKES20');
A('patch: old category scope gone, new product scope present', brakes20.scopes.length === 1 && brakes20.scopes[0].product_img === 'WIPER-1');

// Put the category scope back for the rest of the suite.
await call('patch', '/api/admin/coupons/BRAKES20', { user: ADMIN, body: { scopes: [{ category: 'brakes' }] } });

// ---- coupon/validate + checkout: scoped discount only touches matching lines ----
sdb.exec(`
INSERT INTO cart_items (user_id, product_img, qty) VALUES (700, 'BRAKE-1', 1);
INSERT INTO cart_items (user_id, product_img, qty) VALUES (700, 'WIPER-1', 1);
`);
// Cart subtotal = 50 (brakes) + 30 (wiper) = 80. BRAKES20 (20% off, brakes only) -> discount on 50 only = 10.
r = await call('post', '/api/coupon/validate', { user: { id: 700 }, body: { code: 'BRAKES20' } });
A('validate: scoped coupon discounts only the matching category subtotal (20% of $50 = $10)', st === 200 && Math.abs(r.discount_usd - 10) < 0.01);
A('validate: subtotal reported is still the whole cart ($80)', Math.abs(r.subtotal - 80) < 0.01);

r = await call('post', '/api/coupon/validate', { user: { id: 700 }, body: { code: 'WHOLECART' } });
A('validate: an unscoped coupon still discounts the whole cart (10% of $80 = $8)', st === 200 && Math.abs(r.discount_usd - 8) < 0.01);

r = await call('post', '/api/checkout', { user: { id: 700, show_prices: 1 }, body: { payment_method: 'cash_pickup', coupon_code: 'BRAKES20' } });
A('checkout: scoped coupon applied -> total = 80 - 10 = 70', st === 200 && Math.abs(r.total_usd - 70) < 0.01);

// ---- a coupon scoped to something not in the cart discounts nothing --------
sdb.exec("INSERT INTO cart_items (user_id, product_img, qty) VALUES (700, 'WIPER-1', 1)");
r = await call('post', '/api/coupon/validate', { user: { id: 700 }, body: { code: 'BRAKES20' } });
A("validate: a scoped coupon with nothing matching in the cart discounts $0 with a clear reason",
  st === 400 && /doesn't apply/i.test(r.error || ''));
