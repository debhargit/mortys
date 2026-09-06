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
for (const mod of ['pos']) (await import(APP + 'functions/_routes/' + mod + '.js')).default(app);
console.log('mounted', routes.length);
function toRe(p) { return new RegExp('^' + p.replace(/:[A-Za-z_]+/g, '([^/]+)') + '$'); }
function match(v, url) {
  const [p, qs] = url.split('?'); const query = Object.fromEntries(new URLSearchParams(qs || ''));
  for (const r of routes) { if (r.v !== v) continue; const m = toRe(r.p).exec(p); if (!m) continue; return { r, params: {}, query }; }
  return null;
}
const USER = { id: 900, is_admin: 1, admin_role: 'owner' };
let st = 200;
async function call(v, url) {
  const m = match(v, url); if (!m) throw new Error('no route ' + v + ' ' + url); st = 200;
  const c = { env: ENV, get: () => USER, req: { query: (n) => (n == null ? m.query : m.query[n]) },
    json: (o, s) => { if (s) st = s; return { _json: o }; } };
  const r = await m.r.h(c); return r && r._json !== undefined ? r._json : r;
}
const A = (l, ok) => { console.log((ok ? 'PASS  ' : 'FAIL  ') + l); if (!ok) process.exitCode = 1; };

// Two sales: one today (findable by date range), one ten days back (only
// findable by number search, proving `q` doesn't respect from/to).
sdb.exec(`
INSERT INTO users (id,email,name,password_hash,is_admin,created_at) VALUES (900,'r@x.com','Reporter','h',1,datetime('now'));
INSERT INTO pos_sales (id, receipt_number, invoice_number, cashier_name, customer_name, subtotal_cents, total_cents, voided, payment_method, created_at)
 VALUES (1, 'R-1001', 'INV-2001', 'Cathy', 'Cust One', 5000, 5000, 0, 'cash', datetime('now'));
INSERT INTO pos_sales (id, receipt_number, invoice_number, cashier_name, customer_name, subtotal_cents, total_cents, voided, payment_method, created_at)
 VALUES (2, 'R-9002', 'INV-2002', 'Dana', 'Cust Two', 8000, 8000, 0, 'card', datetime('now', '-10 days'));
INSERT INTO pos_returns (id, sale_id, return_number, reason, refund_method, refund_cents, refund_subtotal_cents, refund_discount_cents, refund_tax_cents, processed_by, created_at)
 VALUES (1, 2, 'RET-3001', 'defective', 'cash', 1000, 900, 0, 100, 900, datetime('now', '-10 days'));
`);

// ---- /api/admin/pos/sales ------------------------------------------------
let r = await call('get', '/api/admin/pos/sales?from=' + new Date().toISOString().slice(0, 10) + '&to=' + new Date().toISOString().slice(0, 10));
A('pos/sales: date range still works (today only)', st === 200 && r.sales.length === 1 && r.sales[0].receipt_number === 'R-1001');

r = await call('get', '/api/admin/pos/sales?q=R-9002');
A('pos/sales: q finds by receipt_number regardless of date', st === 200 && r.sales.length === 1 && r.sales[0].id === 2);

r = await call('get', '/api/admin/pos/sales?q=INV-2001');
A('pos/sales: q finds by invoice_number too', st === 200 && r.sales.length === 1 && r.sales[0].id === 1);

r = await call('get', '/api/admin/pos/sales?q=nope-nothing-here');
A('pos/sales: q with no match -> empty array, not an error', st === 200 && Array.isArray(r.sales) && r.sales.length === 0);

// ---- /api/admin/pos/returns (new) ----------------------------------------
r = await call('get', '/api/admin/pos/returns?from=' + new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10) + '&to=' + new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10));
A('pos/returns: date range, joined to the parent sale', st === 200 && r.returns.length === 1 &&
  r.returns[0].return_number === 'RET-3001' && r.returns[0].receipt_number === 'R-9002' &&
  r.returns[0].invoice_number === 'INV-2002' && r.returns[0].customer_name === 'Cust Two' &&
  r.returns[0].refund_total_usd === 10 && r.returns[0].refund_subtotal_usd === 9);

r = await call('get', '/api/admin/pos/returns?q=RET-3001');
A('pos/returns: q finds by return_number', st === 200 && r.returns.length === 1 && r.returns[0].sale_id === 2);

r = await call('get', '/api/admin/pos/returns?q=R-9002');
A('pos/returns: q finds by the parent sale\'s receipt_number', st === 200 && r.returns.length === 1 && r.returns[0].return_number === 'RET-3001');

r = await call('get', '/api/admin/pos/returns?q=INV-2002');
A('pos/returns: q finds by the parent sale\'s invoice_number', st === 200 && r.returns.length === 1);

r = await call('get', '/api/admin/pos/returns?q=nothing-matches');
A('pos/returns: q with no match -> empty array', st === 200 && Array.isArray(r.returns) && r.returns.length === 0);
