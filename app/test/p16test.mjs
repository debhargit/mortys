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

INSERT INTO products (img,name,make_model,category,condition,price_cents,stock_count,is_active,sku,cost_cents,
 serial_required,core_charge_cents,env_fee_cents,warranty_days)
VALUES ('ALT-1','Alternator','Toyota Corolla','Electrical','NEW',15000,10,1,'ALT-1',9000,1,500,150,90);

INSERT INTO products (img,name,make_model,category,condition,price_cents,stock_count,is_active,sku,cost_cents,
 serial_required,core_charge_cents,env_fee_cents,warranty_days)
VALUES ('PLUG-1','Spark Plug','Toyota Corolla','Ignition','NEW',2000,50,1,'PLUG-1',1000,0,0,0,NULL);
`);

// ---- POST /api/admin/pos/sale: serial required, missing -> 400 -----------
let r = await call('post', '/api/admin/pos/sale', {
  items: [{ product_img: 'ALT-1', description: 'Alternator', qty: 1, unit_price_usd: 150 }],
  payment_method: 'cash', amount_tendered: 150,
});
A('sale: serial-required item with no serial_number is rejected', st === 400 && /serial number/i.test(r.error || ''));

// ---- client-supplied serial_required:0 is ignored (server re-checks products) ----
r = await call('post', '/api/admin/pos/sale', {
  items: [{ product_img: 'ALT-1', description: 'Alternator', qty: 1, unit_price_usd: 150, serial_required: false }],
  payment_method: 'cash', amount_tendered: 150,
});
A('sale: server trusts products.serial_required, not the client-sent flag', st === 400);

// ---- serial provided, with core charge + env fee + warranty -> succeeds ---
r = await call('post', '/api/admin/pos/sale', {
  items: [{ product_img: 'ALT-1', description: 'Alternator', qty: 2, unit_price_usd: 150,
    serial_number: 'SN-0001', core_charge_usd: 5, env_fee_usd: 1.5, warranty_days: 90 }],
  payment_method: 'cash', amount_tendered: 1000,
});
A('sale: succeeds once a serial number is supplied', st === 200 && r.ok === true);
const saleId1 = r.id;

let row = q1('SELECT * FROM pos_sale_items WHERE sale_id = ?', saleId1);
A('sale item: serial_number stored', row.serial_number === 'SN-0001');
A('sale item: core_charge_cents scaled by qty (5 * 2 = $10 -> 1000c)', row.core_charge_cents === 1000);
A('sale item: env_fee_cents scaled by qty (1.5 * 2 = $3 -> 300c)', row.env_fee_cents === 300);
A('sale item: warranty_until set ~90 days out', !!row.warranty_until &&
  Math.abs((new Date(row.warranty_until) - new Date()) / 86400000 - 90) < 2);
// gross = (150 + 5 + 1.5) * 2 = 313; total = 313 * 1.15 (GCT) = 359.95
A('sale: total includes the scaled core charge + env fee before tax', st === 200 && Math.abs(Number(r.total_usd) - 359.95) < 0.02);

// ---- a non-serialised item sells normally, no serial required -------------
r = await call('post', '/api/admin/pos/sale', {
  items: [{ product_img: 'PLUG-1', description: 'Spark Plug', qty: 4, unit_price_usd: 20 }],
  payment_method: 'cash', amount_tendered: 100,
});
A('sale: item with serial_required=0 needs no serial number', st === 200 && r.ok === true);

// ---- return: full-price refund on the alternator sale, no warranty claim --
row = q1('SELECT * FROM pos_sale_items WHERE sale_id = ?', saleId1);
r = await call('post', '/api/admin/pos/sales/' + saleId1 + '/return', {
  items: [{ sale_item_id: row.id, qty: 1 }],
  refund_method: 'cash',
});
// unit_price_usd is stored per-unit ($150); core/env are stored as the
// line's total ($10 / $3 across the 2 units sold) -- perUnit = 150 + (10+3)/2 = 156.5
A('return: full-price line (no proration) refunds unit + its share of core + env',
  st === 200 && Math.abs(Number(r.refund_subtotal_usd) - 156.5) < 0.01);
let retRow = q1('SELECT * FROM pos_return_items WHERE return_id = ?', r.id);
A('return item: prorate_pct defaults to 100, warranty_claim 0',
  retRow.prorate_pct === 100 && retRow.warranty_claim === 0);

// ---- second sale + prorated warranty-claim return on the remaining unit ---
r = await call('post', '/api/admin/pos/sale', {
  items: [{ product_img: 'ALT-1', description: 'Alternator', qty: 1, unit_price_usd: 150,
    serial_number: 'SN-0002', core_charge_usd: 5, env_fee_usd: 1.5, warranty_days: 90 }],
  payment_method: 'cash', amount_tendered: 200,
});
const saleId2 = r.id;
row = q1('SELECT * FROM pos_sale_items WHERE sale_id = ?', saleId2);
r = await call('post', '/api/admin/pos/sales/' + saleId2 + '/return', {
  items: [{ sale_item_id: row.id, qty: 1, prorate_pct: 40, warranty_claim: true }],
  refund_method: 'store_credit',
});
// perUnit = 150 + 5 + 1.5 = 156.5; refund = 156.5 * 1 * 0.40 = 62.6
A('return: warranty claim at 40% prorates the refund', st === 200 && Math.abs(Number(r.refund_subtotal_usd) - 62.6) < 0.01);
retRow = q1('SELECT * FROM pos_return_items WHERE return_id = ?', r.id);
A('return item: prorate_pct and warranty_claim persisted', retRow.prorate_pct === 40 && retRow.warranty_claim === 1);
A('return: issues a store-credit gift card for the prorated amount', !!r.store_credit_code);
let gc = q1('SELECT * FROM gift_cards WHERE code = ?', r.store_credit_code);
A('gift card: balance matches the prorated refund total', gc && Math.abs(gc.balance_cents / 100 - Number(r.refund_total_usd)) < 0.01);

// ---- over-returning past what remains is rejected --------------------------
r = await call('post', '/api/admin/pos/sales/' + saleId2 + '/return', {
  items: [{ sale_item_id: row.id, qty: 1 }],
  refund_method: 'cash',
});
A('return: cannot return a unit that was already returned', st === 400 && /remain returnable/i.test(r.error || ''));
