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
const ENV = { DB: makeDB(sdb) };
const routes = [];
const app = {};
for (const v of ['get', 'post', 'patch', 'delete', 'put']) app[v] = (p, ...r) => routes.push({ v, p, h: r[r.length - 1] });
(await import(APP + 'functions/_routes/pos_txn.js')).default(app);
console.log('mounted', routes.length);
function toRe(p) { return new RegExp('^' + p.replace(/:[A-Za-z_]+/g, '([^/]+)') + '$'); }
function pn(p) { return (p.match(/:([A-Za-z_]+)/g) || []).map((s) => s.slice(1)); }
function match(v, url) { const [p, qs] = url.split('?'); const query = Object.fromEntries(new URLSearchParams(qs || ''));
  for (const r of routes) { if (r.v !== v) continue; const m = toRe(r.p).exec(p); if (!m) continue;
    const params = {}; pn(r.p).forEach((n, i) => params[n] = decodeURIComponent(m[i + 1])); return { r, params, query }; } return null; }
const USER = { id: 900, is_admin: 1, admin_role: 'owner' };
let st = 200;
async function call(v, url, body) {
  const m = match(v, url); if (!m) throw new Error('no route ' + v + ' ' + url); st = 200;
  const c = { env: ENV, executionCtx: { waitUntil() {} }, get: () => USER,
    req: { param: (n) => m.params[n], query: (n) => (n == null ? m.query : m.query[n]), header: () => undefined, json: async () => body || {} },
    json: (o, s) => { if (s) st = s; return { _json: o }; } };
  const r = await m.r.h(c); return r && r._json !== undefined ? r._json : r;
}
const A = (l, ok) => { console.log((ok ? 'PASS  ' : 'FAIL  ') + l); if (!ok) process.exitCode = 1; };
const q1 = (s, ...p) => sdb.prepare(s).get(...p);

sdb.exec(`
INSERT INTO users (id,email,name,password_hash,is_admin,admin_role,is_staff,created_at) VALUES
 (900,'owner@x.com','Owner','h',1,'owner',1,datetime('now'));
INSERT INTO products (img,name,make_model,category,condition,price_cents,stock_count,is_active,sku)
VALUES ('BRAKE-1','Brake Pad','Generic','brakes','NEW',5000,20,1,'BRAKE-1');
INSERT INTO products (img,name,make_model,category,condition,price_cents,stock_count,is_active,sku)
VALUES ('WIPER-1','Wiper Blade','Generic','wipers','NEW',3000,20,1,'WIPER-1');
INSERT INTO coupons (code, kind, amount, min_subtotal) VALUES ('POS10', 'percent', 10, 0);
INSERT INTO coupons (code, kind, amount) VALUES ('BRAKES20', 'percent', 20);
INSERT INTO coupon_scopes (coupon_code, category) VALUES ('BRAKES20', 'brakes');
INSERT INTO coupons (code, kind, amount, min_subtotal) VALUES ('BIGSPEND', 'flat', 15, 1000);
INSERT INTO coupons (code, kind, amount, is_active) VALUES ('DEAD', 'flat', 5, 0);
`);

// ---- preview endpoint --------------------------------------------------------
let r = await call('post', '/api/admin/pos/coupon-preview', {
  code: 'POS10',
  items: [{ product_img: 'BRAKE-1', qty: 1, unit_price_usd: 50 }, { product_img: 'WIPER-1', qty: 1, unit_price_usd: 30 }],
});
A('preview: whole-cart coupon (10% of $80 = $8)', st === 200 && Math.abs(r.discount_usd - 8) < 0.01 && r.code === 'POS10');

r = await call('post', '/api/admin/pos/coupon-preview', {
  code: 'BRAKES20',
  items: [{ product_img: 'BRAKE-1', qty: 1, unit_price_usd: 50 }, { product_img: 'WIPER-1', qty: 1, unit_price_usd: 30 }],
});
A('preview: scoped coupon only discounts the matching category (20% of $50 = $10)', st === 200 && Math.abs(r.discount_usd - 10) < 0.01);

r = await call('post', '/api/admin/pos/coupon-preview', { code: 'NOPE', items: [{ product_img: 'BRAKE-1', qty: 1, unit_price_usd: 50 }] });
A('preview: unknown code -> 400', st === 400);
r = await call('post', '/api/admin/pos/coupon-preview', { code: 'DEAD', items: [{ product_img: 'BRAKE-1', qty: 1, unit_price_usd: 50 }] });
A('preview: inactive coupon -> 400', st === 400);
r = await call('post', '/api/admin/pos/coupon-preview', { code: 'BIGSPEND', items: [{ product_img: 'WIPER-1', qty: 1, unit_price_usd: 30 }] });
A('preview: min_subtotal not met -> 400 with a clear reason', st === 400 && /minimum subtotal/i.test(r.error || ''));

// ---- applying a coupon on an actual sale ------------------------------------
r = await call('post', '/api/admin/pos/sale', {
  items: [{ product_img: 'BRAKE-1', description: 'Brake Pad', qty: 1, unit_price_usd: 50 }],
  payment_method: 'cash', amount_tendered: 100, coupon_code: 'pos10',   // lowercase -> normalised
});
A('sale: coupon applied (case-insensitive code)', st === 200 && r.ok === true && r.coupon_code === 'POS10' && Math.abs(r.coupon_discount_usd - 5) < 0.01);
// total = (50 - 5) * 1.15 = 51.75
A('sale: total reflects the coupon discount before tax', Math.abs(r.total_usd - 51.75) < 0.01);

let sale = q1('SELECT * FROM pos_sales WHERE id = ?', r.id);
A('sale: coupon_code / coupon_discount_cents persisted on the sale row', sale.coupon_code === 'POS10' && sale.coupon_discount_cents === 500);
let coupon = q1('SELECT * FROM coupons WHERE code = ?', 'POS10');
A('sale: redeemed_count incremented', coupon.redeemed_count === 1);
let redemption = q1('SELECT * FROM coupon_redemptions WHERE coupon_code = ? AND sale_id = ?', 'POS10', r.id);
A('sale: coupon_redemptions row recorded against this sale (not an order)', redemption && redemption.sale_id === r.id && redemption.order_id == null);

// ---- an invalid code fails the whole sale, same as checkout would ----------
r = await call('post', '/api/admin/pos/sale', {
  items: [{ product_img: 'BRAKE-1', description: 'Brake Pad', qty: 1, unit_price_usd: 50 }],
  payment_method: 'cash', amount_tendered: 100, coupon_code: 'NOPE',
});
A('sale: an unknown coupon code rejects the whole sale', st === 400 && /invalid coupon/i.test(r.error || ''));

// ---- coupon discount is not gated by pos.line_discount/pos.ticket_discount
// (a role with neither permission can still redeem a valid code) ------------
const restrictedUser = { id: 901, is_admin: 1, admin_role: 'cashier', perms: JSON.stringify({ 'pos.ticket_discount': false, 'pos.line_discount': false }) };
sdb.exec("INSERT INTO users (id,email,name,password_hash,is_admin,admin_role,is_staff,perms,created_at) VALUES (901,'cash@x.com','Cash Cathy','h',1,'cashier',1,'{\"pos.ticket_discount\":false,\"pos.line_discount\":false}',datetime('now'))");
const routesForCashier = routes; // same app; just call with a different acting user via a tiny local call()
async function callAs(user, v, url, body) {
  const m = match(v, url); if (!m) throw new Error('no route ' + v + ' ' + url); st = 200;
  const c = { env: ENV, executionCtx: { waitUntil() {} }, get: () => user,
    req: { param: (n) => m.params[n], query: () => ({}), header: () => undefined, json: async () => body || {} },
    json: (o, s) => { if (s) st = s; return { _json: o }; } };
  const r2 = await m.r.h(c); return r2 && r2._json !== undefined ? r2._json : r2;
}
r = await callAs(restrictedUser, 'post', '/api/admin/pos/sale', {
  items: [{ product_img: 'WIPER-1', description: 'Wiper Blade', qty: 1, unit_price_usd: 30 }],
  payment_method: 'cash', amount_tendered: 100, coupon_code: 'POS10',
});
A('sale: a coupon still applies for a cashier with no discount permissions', st === 200 && r.ok === true && Math.abs(r.coupon_discount_usd - 3) < 0.01);

// ---- a scoped coupon with nothing matching in the sale is rejected ---------
r = await call('post', '/api/admin/pos/sale', {
  items: [{ product_img: 'WIPER-1', description: 'Wiper Blade', qty: 1, unit_price_usd: 30 }],
  payment_method: 'cash', amount_tendered: 100, coupon_code: 'BRAKES20',
});
A('sale: a scoped coupon with nothing matching rejects the sale', st === 400 && /doesn't apply/i.test(r.error || ''));
