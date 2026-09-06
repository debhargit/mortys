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
INSERT INTO products (img,name,make_model,category,condition,price_cents,stock_count,is_active,sku,max_discount_pct)
VALUES ('CAPPED-1','Capped Part','Generic','misc','NEW',10000,20,1,'CAPPED-1',10);
INSERT INTO products (img,name,make_model,category,condition,price_cents,stock_count,is_active,sku,max_discount_pct)
VALUES ('NOCAP-1','Uncapped Part','Generic','misc','NEW',10000,20,1,'NOCAP-1',NULL);
INSERT INTO products (img,name,make_model,category,condition,price_cents,stock_count,is_active,sku,restricted_manager_approval)
VALUES ('APPROVAL-1','Needs Approval','Generic','misc','NEW',5000,20,1,'APPROVAL-1',1);
INSERT INTO products (img,name,make_model,category,condition,price_cents,stock_count,is_active,sku,restricted_id_required)
VALUES ('IDREQ-1','Needs ID','Generic','misc','NEW',5000,20,1,'IDREQ-1',1);
INSERT INTO products (img,name,make_model,category,condition,price_cents,stock_count,is_active,sku,restricted_tax_id_required)
VALUES ('TAXREQ-1','Needs Tax ID','Generic','misc','NEW',5000,20,1,'TAXREQ-1',1);
INSERT INTO products (img,name,make_model,category,condition,price_cents,stock_count,is_active,sku,restricted_instore_only)
VALUES ('INSTORE-1','In-store Only','Generic','misc','NEW',5000,20,1,'INSTORE-1',1);
`);

// ---- B: per-item discount limit --------------------------------------------
let r = await call('post', '/api/admin/pos/sale', {
  items: [{ product_img: 'CAPPED-1', description: 'Capped Part', qty: 1, unit_price_usd: 100, discount_usd: 15 }],
  payment_method: 'cash', amount_tendered: 200,
});
A('discount cap: 15% on a 10%-capped item is rejected', st === 400 && /can only be discounted up to 10/.test(r.error || ''));

r = await call('post', '/api/admin/pos/sale', {
  items: [{ product_img: 'CAPPED-1', description: 'Capped Part', qty: 1, unit_price_usd: 100, discount_usd: 10 }],
  payment_method: 'cash', amount_tendered: 200,
});
A('discount cap: exactly at the cap is allowed', st === 200 && r.ok === true);

r = await call('post', '/api/admin/pos/sale', {
  items: [{ product_img: 'NOCAP-1', description: 'Uncapped Part', qty: 1, unit_price_usd: 100, discount_usd: 90 }],
  payment_method: 'cash', amount_tendered: 200,
});
A('discount cap: no item-specific cap -> any discount goes through (still needs pos.line_discount, granted to owner)', st === 200 && r.ok === true);

// ---- C: restricted items ----------------------------------------------------
r = await call('post', '/api/admin/pos/sale', {
  items: [{ product_img: 'APPROVAL-1', description: 'Needs Approval', qty: 1, unit_price_usd: 50 }],
  payment_method: 'cash', amount_tendered: 100,
});
A('restricted: manager-approval item blocked without an approver name', st === 400 && /manager approval/i.test(r.error || ''));

r = await call('post', '/api/admin/pos/sale', {
  items: [{ product_img: 'APPROVAL-1', description: 'Needs Approval', qty: 1, unit_price_usd: 50 }],
  payment_method: 'cash', amount_tendered: 100, restricted_approved_by: 'Manager Manny',
});
A('restricted: manager-approval item sells once an approver name is sent', st === 200 && r.ok === true);
let sale = q1('SELECT * FROM pos_sales WHERE id = ?', r.id);
A('restricted: approver name persisted on the sale', sale.restricted_approved_by === 'Manager Manny');

r = await call('post', '/api/admin/pos/sale', {
  items: [{ product_img: 'IDREQ-1', description: 'Needs ID', qty: 1, unit_price_usd: 50 }],
  payment_method: 'cash', amount_tendered: 100,
});
A('restricted: ID-required item blocked without an ID number', st === 400 && /require an ID/i.test(r.error || ''));

r = await call('post', '/api/admin/pos/sale', {
  items: [{ product_img: 'IDREQ-1', description: 'Needs ID', qty: 1, unit_price_usd: 50 }],
  payment_method: 'cash', amount_tendered: 100, verify_id_type: 'drivers_license', verify_id_number: 'DL123456',
});
A('restricted: ID-required item sells once an ID is recorded', st === 200 && r.ok === true);
sale = q1('SELECT * FROM pos_sales WHERE id = ?', r.id);
A('restricted: id type/number persisted on the sale', sale.verify_id_type === 'drivers_license' && sale.verify_id_number === 'DL123456');

r = await call('post', '/api/admin/pos/sale', {
  items: [{ product_img: 'TAXREQ-1', description: 'Needs Tax ID', qty: 1, unit_price_usd: 50 }],
  payment_method: 'cash', amount_tendered: 100,
});
A('restricted: tax-ID-required item blocked without a tax ID', st === 400 && /require a Tax ID/i.test(r.error || ''));

r = await call('post', '/api/admin/pos/sale', {
  items: [{ product_img: 'TAXREQ-1', description: 'Needs Tax ID', qty: 1, unit_price_usd: 50 }],
  payment_method: 'cash', amount_tendered: 100, verify_tax_id: '123-456-789',
});
A('restricted: tax-ID-required item sells once a tax ID is recorded', st === 200 && r.ok === true);
sale = q1('SELECT * FROM pos_sales WHERE id = ?', r.id);
A('restricted: tax id persisted on the sale', sale.verify_tax_id === '123-456-789');

// in-store-only items are a storefront-checkout rule, not a POS rule -- POS
// (which is inherently in-store) must be able to sell one with no fuss.
r = await call('post', '/api/admin/pos/sale', {
  items: [{ product_img: 'INSTORE-1', description: 'In-store Only', qty: 1, unit_price_usd: 50 }],
  payment_method: 'cash', amount_tendered: 100,
});
A('restricted: in-store-only items sell normally at POS', st === 200 && r.ok === true);
