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
const ENV = { DB: makeDB(sdb), SESSION_SECRET: 'test-secret-p28' };
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

// The 0002 seed's ~17k products pollute /api/products result pages -- wipe and
// seed a controlled catalogue (same pattern as p23 / p26).
sdb.exec('DELETE FROM products;');
sdb.exec(`
UPDATE shop_settings SET storefront_prices = 1 WHERE id = 1;
INSERT INTO users (id,email,name,password_hash,is_admin,admin_role,is_staff,show_prices,created_at)
 VALUES (900,'owner@x.com','Owner','h',1,'owner',1,1,datetime('now')),
        (700,'buyer@x.com','Buyer','h',0,'',0,1,datetime('now'));
INSERT INTO products (img,name,make_model,category,condition,price_cents,stock_count,low_threshold,is_active,sku)
VALUES ('COMP-A','Component A','Generic','brakes','NEW',5000,20,2,1,'COMP-A'),
       ('COMP-B','Component B','Generic','brakes','NEW',3000,20,2,1,'COMP-B'),
       ('KIT-1','Brake Kit','Generic','brakes','NEW',10000,0,0,1,'KIT-1'),
       ('KIT-EXP','Exploded Kit','Generic','brakes','NEW',9000,0,0,1,'KIT-EXP'),
       ('KIT-CLEAN','Clean Kit','Generic','brakes','NEW',7000,0,0,1,'KIT-CLEAN'),
       ('KIT-2','Other Kit','Generic','brakes','NEW',5000,0,0,1,'KIT-2');
INSERT INTO products (img,name,make_model,category,condition,price_cents,stock_count,low_threshold,is_active,sku,item_type)
VALUES ('SVC-FEE','Assembly fee','Generic','service','NEW',1000,5,0,1,'SVC-FEE','service');
INSERT INTO products (img,name,make_model,category,condition,price_cents,stock_count,is_active,sku,serial_required)
VALUES ('SER-1','Serialised part','Generic','brakes','NEW',4000,20,1,'SER-1',1);
`);

const put = (img, body) => call('put', '/api/admin/products/' + img + '/kit-components', { body });

// ---- 1. defining a kit --------------------------------------------------------
let r = await put('KIT-1', { is_kit: true, kit_price_mode: 'fixed', kit_line_mode: 'single',
  components: [{ component_img: 'COMP-A', qty_each: 1 }, { component_img: 'COMP-B', qty_each: 2 }] });
A('kit save: happy path (2 components)', st === 200 && r.count === 2);
A('kit save: is_kit flag persisted', !!q1("SELECT is_kit FROM products WHERE img='KIT-1'").is_kit);
A('kit save: rows persisted with qty_each', q1("SELECT qty_each FROM kit_components WHERE kit_img='KIT-1' AND component_img='COMP-B'").qty_each === 2);

r = await put('KIT-1', { components: [{ component_img: 'KIT-1', qty_each: 1 }] });
A('kit save: rejects a self-reference', st === 400 && /itself/i.test(r.error || ''));

await put('KIT-2', { is_kit: true, components: [{ component_img: 'COMP-A', qty_each: 1 }] });
r = await put('KIT-1', { components: [{ component_img: 'COMP-A', qty_each: 1 }, { component_img: 'KIT-2', qty_each: 1 }] });
A('kit save: rejects a nested kit', st === 400 && /another kit/i.test(r.error || ''));

r = await put('KIT-1', { components: [{ component_img: 'COMP-A', qty_each: 1 }, { component_img: 'SER-1', qty_each: 1 }] });
A('kit save: rejects a serial-required component', st === 400 && /serial/i.test(r.error || ''));

r = await put('KIT-1', { components: [{ component_img: 'COMP-A', qty_each: 1 }, { component_img: 'COMP-A', qty_each: 2 }] });
A('kit save: rejects a duplicate component', st === 400);

// restore KIT-1's real recipe
await put('KIT-1', { is_kit: true, kit_price_mode: 'fixed', kit_line_mode: 'single',
  components: [{ component_img: 'COMP-A', qty_each: 1 }, { component_img: 'COMP-B', qty_each: 2 }] });

// ---- 2. derived availability + roll-up price via /api/products --------------
async function kitRow(img) {
  const res = await call('get', '/api/products?limit=200&offset=0&q=' + img);
  return (res.products || []).find((x) => x.img === img);
}
let row = await kitRow('KIT-1');
A('products: kit stock = min(floor(component/qty_each)) = 10', row && row.stock_count === 10 && row.stock_level === 'in');

sdb.exec("UPDATE products SET stock_count = 1 WHERE img='COMP-B'");   // floor(1/2) = 0
row = await kitRow('KIT-1');
A('products: kit goes out of stock when a component runs short', row && row.stock_count === 0 && row.stock_level === 'out');
sdb.exec("UPDATE products SET stock_count = 20 WHERE img='COMP-B'");

await put('KIT-1', { is_kit: true, kit_price_mode: 'rollup', kit_line_mode: 'single',
  components: [{ component_img: 'COMP-A', qty_each: 1 }, { component_img: 'COMP-B', qty_each: 2 }] });
row = await kitRow('KIT-1');
A('products: roll-up kit price = 50 + 2*30 = 110', row && Math.abs(row.price_usd - 110) < 0.01);

sdb.exec("UPDATE products SET sale_price_cents = 2000 WHERE img='COMP-B'");   // active sale, no window
row = await kitRow('KIT-1');
A('products: roll-up tracks a component active sale price (50 + 2*20 = 90)', row && Math.abs(row.price_usd - 90) < 0.01);
sdb.exec("UPDATE products SET sale_price_cents = NULL WHERE img='COMP-B'");

// back to a fixed-price single-line kit for the sale tests
await put('KIT-1', { is_kit: true, kit_price_mode: 'fixed', kit_line_mode: 'single',
  components: [{ component_img: 'COMP-A', qty_each: 1 }, { component_img: 'COMP-B', qty_each: 2 }] });

// ---- 3. single-mode kit sale draws down components -------------------------
r = await call('post', '/api/admin/pos/sale', { body: {
  items: [{ product_img: 'KIT-1', description: 'Brake Kit', qty: 1, unit_price_usd: 100 }],
  payment_method: 'cash', amount_tendered: 100000,
} });
A('sale: single-mode kit succeeds', st === 200 && r.ok === true);
const kitSaleId = r.id;
A('sale: one sale item for the kit itself (not the components)',
  q1('SELECT COUNT(*) n FROM pos_sale_items WHERE sale_id = ?', kitSaleId).n === 1 &&
  q1('SELECT product_img p FROM pos_sale_items WHERE sale_id = ?', kitSaleId).p === 'KIT-1');
A('sale: component stock drawn down (COMP-A 20->19, COMP-B 20->18)',
  q1("SELECT stock_count s FROM products WHERE img='COMP-A'").s === 19 &&
  q1("SELECT stock_count s FROM products WHERE img='COMP-B'").s === 18);
A('sale: kit shell stock untouched', q1("SELECT stock_count s FROM products WHERE img='KIT-1'").s === 0);
A('sale: kit_components_json snapshot stored',
  /COMP-A/.test(q1('SELECT kit_components_json j FROM pos_sale_items WHERE sale_id = ?', kitSaleId).j || ''));

// a service component is never decremented
await put('KIT-CLEAN', { is_kit: true, kit_price_mode: 'fixed', kit_line_mode: 'single',
  components: [{ component_img: 'COMP-A', qty_each: 1 }, { component_img: 'SVC-FEE', qty_each: 1 }] });
r = await call('post', '/api/admin/pos/sale', { body: {
  items: [{ product_img: 'KIT-CLEAN', description: 'Clean Kit', qty: 1, unit_price_usd: 70 }],
  payment_method: 'cash', amount_tendered: 100000,
} });
A('sale: kit with a service component - service stock stays put (5)',
  st === 200 && q1("SELECT stock_count s FROM products WHERE img='SVC-FEE'").s === 5 &&
  q1("SELECT stock_count s FROM products WHERE img='COMP-A'").s === 18);

// ---- 4. void + return restock the components -----------------------------
r = await call('post', '/api/admin/pos/sales/' + kitSaleId + '/void', { body: {} });
A('void: restocks the snapshotted components (COMP-A 18->19, COMP-B 18->20)',
  st === 200 && q1("SELECT stock_count s FROM products WHERE img='COMP-A'").s === 19 &&
  q1("SELECT stock_count s FROM products WHERE img='COMP-B'").s === 20);

// sell 2 kits, return 1 -> half the components come back
r = await call('post', '/api/admin/pos/sale', { body: {
  items: [{ product_img: 'KIT-1', description: 'Brake Kit', qty: 2, unit_price_usd: 100 }],
  payment_method: 'cash', amount_tendered: 100000,
} });
const rs = r.id;
A('sale: 2 kits draw 2x components (COMP-A 19->17, COMP-B 20->16)',
  q1("SELECT stock_count s FROM products WHERE img='COMP-A'").s === 17 &&
  q1("SELECT stock_count s FROM products WHERE img='COMP-B'").s === 16);
const siId = q1('SELECT id FROM pos_sale_items WHERE sale_id = ?', rs).id;
r = await call('post', '/api/admin/pos/sales/' + rs + '/return', { body: {
  items: [{ sale_item_id: siId, qty: 1 }], refund_method: 'cash',
} });
A('return: one of two kits restocks one kit’s worth of components (COMP-A 17->18, COMP-B 16->18)',
  st === 200 && q1("SELECT stock_count s FROM products WHERE img='COMP-A'").s === 18 &&
  q1("SELECT stock_count s FROM products WHERE img='COMP-B'").s === 18);

// ---- 5. a restricted component makes the whole kit restricted ------------
sdb.exec("UPDATE products SET restricted_id_required = 1 WHERE img='COMP-A'");
r = await call('post', '/api/admin/pos/sale', { body: {
  items: [{ product_img: 'KIT-1', description: 'Brake Kit', qty: 1, unit_price_usd: 100 }],
  payment_method: 'cash', amount_tendered: 100000,
} });
A('sale: kit blocked when a component needs an ID and none given', st === 400 && /ID/i.test(r.error || ''));
r = await call('post', '/api/admin/pos/sale', { body: {
  items: [{ product_img: 'KIT-1', description: 'Brake Kit', qty: 1, unit_price_usd: 100 }],
  payment_method: 'cash', amount_tendered: 100000, verify_id_number: 'A12345',
} });
A('sale: same kit goes through once the ID is recorded', st === 200 && r.ok === true);

// ---- 6. exploded-mode kit writes component sale lines -------------------
sdb.exec("UPDATE products SET restricted_id_required = 0 WHERE img='COMP-A'");
sdb.exec("UPDATE products SET stock_count = 20 WHERE img IN ('COMP-A','COMP-B')");
await put('KIT-EXP', { is_kit: true, kit_price_mode: 'fixed', kit_line_mode: 'exploded',
  components: [{ component_img: 'COMP-A', qty_each: 1 }, { component_img: 'COMP-B', qty_each: 2 }] });
r = await call('post', '/api/admin/pos/sale', { body: {
  items: [{ product_img: 'KIT-EXP', description: 'Exploded Kit', qty: 1, unit_price_usd: 90 }],
  payment_method: 'cash', amount_tendered: 100000,
} });
const exId = r.id;
const exItems = sdb.prepare('SELECT product_img, qty, total_cents FROM pos_sale_items WHERE sale_id = ? ORDER BY product_img').all(exId);
A('sale: exploded kit writes component lines, not a KIT-EXP line',
  st === 200 && exItems.length === 2 && exItems.every((x) => x.product_img !== 'KIT-EXP'));
A('sale: exploded component quantities are qty_each * line qty (A:1, B:2)',
  exItems.find((x) => x.product_img === 'COMP-A').qty === 1 && exItems.find((x) => x.product_img === 'COMP-B').qty === 2);
A('sale: exploded component line totals sum to the kit price ($90)',
  Math.abs(exItems.reduce((s, x) => s + x.total_cents, 0) - 9000) < 5);
A('sale: exploded kit decremented each component (COMP-A 20->19, COMP-B 20->18)',
  q1("SELECT stock_count s FROM products WHERE img='COMP-A'").s === 19 &&
  q1("SELECT stock_count s FROM products WHERE img='COMP-B'").s === 18);

// ---- 7. storefront checkout: a kit inherits a component's online block --
await put('KIT-CLEAN', { is_kit: true, kit_price_mode: 'fixed', kit_line_mode: 'single',
  components: [{ component_img: 'COMP-B', qty_each: 1 }] });
sdb.exec("UPDATE products SET restricted_instore_only = 1 WHERE img='COMP-A'");
await put('KIT-1', { is_kit: true, kit_price_mode: 'fixed', kit_line_mode: 'single',
  components: [{ component_img: 'COMP-A', qty_each: 1 }, { component_img: 'COMP-B', qty_each: 2 }] });
sdb.exec("DELETE FROM cart_items WHERE user_id = 700");
sdb.exec("INSERT INTO cart_items (user_id, product_img, qty) VALUES (700, 'KIT-1', 1)");
r = await call('post', '/api/checkout', { user: { id: 700, show_prices: 1 }, body: { payment_method: 'cash_pickup' } });
A('checkout: a kit with an in-store-only component is blocked online', st === 400 && r.code === 'restricted_instore_only');

sdb.exec("DELETE FROM cart_items WHERE user_id = 700");
sdb.exec("INSERT INTO cart_items (user_id, product_img, qty) VALUES (700, 'KIT-CLEAN', 1)");
r = await call('post', '/api/checkout', { user: { id: 700, show_prices: 1 }, body: { payment_method: 'cash_pickup' } });
A('checkout: a clean kit checks out and its order line is the kit itself',
  st === 200 && !r.code && q1('SELECT product_img p FROM order_items WHERE order_id = ?', r.order_id).p === 'KIT-CLEAN');

// ---- 8. kits.js helpers directly ---------------------------------------
const kits = await import(APP + 'functions/_lib/kits.js');
const comps = [
  { component_img: 'X', qty_each: 2, price_cents: 1000, active_sale_cents: null, stock_count: 9, item_type: 'inventory' },
  { component_img: 'Y', qty_each: 1, price_cents: 500, active_sale_cents: 300, stock_count: 4, item_type: 'inventory' },
  { component_img: 'Z', qty_each: 1, price_cents: null, active_sale_cents: null, stock_count: 0, item_type: 'service' },
];
A('kits.kitRollupCents = 2*1000 + 1*300 + 0 = 2300', kits.kitRollupCents(comps) === 2300);
A('kits.kitBuildableQty = min(floor(9/2), floor(4/1)) = 4 (service ignored)', kits.kitBuildableQty(comps) === 4);
const ex = kits.explodeKitLine({ qty: 2, unit_price_usd: 46 }, comps, 'rollup');
A('kits.explodeKitLine rollup: qty = line qty * qty_each', ex[0].qty === 4 && ex[1].qty === 2 && ex[2].qty === 2);
A('kits.explodeKitLine rollup: unit price = component effective price', ex[0].unit_price_usd === 10 && ex[1].unit_price_usd === 3);
const exF = kits.explodeKitLine({ qty: 1, unit_price_usd: 23 }, comps, 'fixed');
A('kits.explodeKitLine fixed: component line totals sum to the kit price',
  Math.abs(exF.reduce((s, l) => s + l.unit_price_usd * l.qty, 0) - 23) < 0.02);
