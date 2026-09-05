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
for (const mod of ['pos_txn', 'inventory', 'admin']) (await import(APP + 'functions/_routes/' + mod + '.js')).default(app);
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

// The 0002 seed data has 20k+ real products, many already at/below their own
// low_threshold -- clear them so this file's low-stock assertions aren't at
// the mercy of pagination over that noise.
sdb.exec('DELETE FROM products;');
sdb.exec(`
INSERT INTO users (id,email,name,password_hash,is_admin,admin_role,is_staff,created_at) VALUES
 (900,'owner@x.com','Owner','h',1,'owner',1,datetime('now'));
INSERT INTO products (img,name,make_model,category,condition,price_cents,stock_count,low_threshold,is_active,sku,item_type)
VALUES ('FEE-DELIVERY','Delivery Fee','Generic','fees','NEW',1000,0,0,1,'FEE-DELIVERY','service');
INSERT INTO products (img,name,make_model,category,condition,price_cents,stock_count,low_threshold,is_active,sku,item_type)
VALUES ('TOKEN-1','Wash Token','Generic','tokens','NEW',500,10,3,1,'TOKEN-1','tracked');
INSERT INTO products (img,name,make_model,category,condition,price_cents,stock_count,low_threshold,is_active,sku)
VALUES ('PART-1','Normal Part','Generic','misc','NEW',2000,10,3,1,'PART-1');
`);

// ---- selling a service item never touches stock_count ----------------------
let r = await call('post', '/api/admin/pos/sale', {
  items: [{ product_img: 'FEE-DELIVERY', description: 'Delivery Fee', qty: 3, unit_price_usd: 10 }],
  payment_method: 'cash', amount_tendered: 100,
});
A('sale: a service-item line sells fine at qty 3 despite stock_count=0', st === 200 && r.ok === true);
let row = q1('SELECT stock_count FROM products WHERE img = ?', 'FEE-DELIVERY');
A('sale: stock_count on a service item stays untouched (still 0, not negative)', row.stock_count === 0);

// ---- selling a tracked item decrements stock like a normal part ------------
r = await call('post', '/api/admin/pos/sale', {
  items: [{ product_img: 'TOKEN-1', description: 'Wash Token', qty: 4, unit_price_usd: 5 }],
  payment_method: 'cash', amount_tendered: 100,
});
A('sale: a tracked item sells normally', st === 200 && r.ok === true);
const tokenSaleId = r.id;
row = q1('SELECT stock_count FROM products WHERE img = ?', 'TOKEN-1');
A('sale: tracked item stock_count decremented like inventory (10 - 4 = 6)', row.stock_count === 6);

// ---- voiding a sale with a service line does not fabricate stock -----------
r = await call('post', '/api/admin/pos/sale', {
  items: [{ product_img: 'FEE-DELIVERY', description: 'Delivery Fee', qty: 2, unit_price_usd: 10 }],
  payment_method: 'cash', amount_tendered: 100,
});
const feeSaleId = r.id;
r = await call('post', '/api/admin/pos/sales/' + feeSaleId + '/void', {});
A('void: succeeds', st === 200 && r.ok === true);
row = q1('SELECT stock_count FROM products WHERE img = ?', 'FEE-DELIVERY');
A('void: service item stock_count still untouched after voiding', row.stock_count === 0);

// Voiding the tracked-item sale DOES restock it, same as inventory.
r = await call('post', '/api/admin/pos/sales/' + tokenSaleId + '/void', {});
A('void: tracked-item sale voids fine', st === 200 && r.ok === true);
row = q1('SELECT stock_count FROM products WHERE img = ?', 'TOKEN-1');
A('void: tracked item is restocked on void like inventory (6 + 4 = 10)', row.stock_count === 10);

// ---- returning a service item line does not fabricate stock ---------------
r = await call('post', '/api/admin/pos/sale', {
  items: [{ product_img: 'FEE-DELIVERY', description: 'Delivery Fee', qty: 1, unit_price_usd: 10 }],
  payment_method: 'cash', amount_tendered: 20,
});
const feeSaleId2 = r.id;
let saleItem = q1('SELECT * FROM pos_sale_items WHERE sale_id = ?', feeSaleId2);
r = await call('post', '/api/admin/pos/sales/' + feeSaleId2 + '/return', {
  items: [{ sale_item_id: saleItem.id, qty: 1 }], refund_method: 'cash',
});
A('return: succeeds for a service item', st === 200 && r.ok === true);
row = q1('SELECT stock_count FROM products WHERE img = ?', 'FEE-DELIVERY');
A('return: service item stock_count still untouched after a return', row.stock_count === 0);

// ---- PATCH item_type ---------------------------------------------------------
r = await call('patch', '/api/admin/products/PART-1', { item_type: 'service' });
A('patch: item_type accepted', st === 200 && r.ok === true);
row = q1('SELECT item_type FROM products WHERE img = ?', 'PART-1');
A('patch: item_type persisted', row.item_type === 'service');

r = await call('patch', '/api/admin/products/PART-1', { item_type: 'nonsense' });
row = q1('SELECT item_type FROM products WHERE img = ?', 'PART-1');
A('patch: an invalid item_type falls back to inventory rather than erroring', st === 200 && row.item_type === 'inventory');

// Put PART-1 back to plain inventory for the low-stock checks below.
sdb.exec("UPDATE products SET item_type = 'inventory', stock_count = 1, low_threshold = 3 WHERE img = 'PART-1'");
sdb.exec("UPDATE products SET stock_count = 0 WHERE img = 'FEE-DELIVERY'");   // still a service item, "0 stock"

// ---- admin GET returns item_type -------------------------------------------
r = await call('get', '/api/admin/products/TOKEN-1');
A('admin GET product: item_type present', r.product.item_type === 'tracked');

// ---- low-stock alerts never include a service item -------------------------
r = await call('get', '/api/admin/low-stock');
A('low-stock: PART-1 (real inventory, below threshold) is listed', r.products.some((p) => p.img === 'PART-1'));
A('low-stock: FEE-DELIVERY (service, "0 stock") is excluded', !r.products.some((p) => p.img === 'FEE-DELIVERY'));

// ---- _lib/jobs.js lowStockDigest also excludes service items --------------
const { lowStockDigest } = await import(APP + 'functions/_lib/jobs.js');
const digest = await lowStockDigest(ENV);
A('lowStockDigest: counts PART-1 but not the service item', digest.low === 1);
