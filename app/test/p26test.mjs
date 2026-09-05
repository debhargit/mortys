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
const ENV = { DB: makeDB(sdb), SESSION_SECRET: 'test-secret-p26' };
const routes = [];
const app = {};
for (const v of ['get', 'post', 'patch', 'delete', 'put']) app[v] = (p, ...r) => routes.push({ v, p, h: r[r.length - 1] });
for (const mod of ['storefront', 'customer']) (await import(APP + 'functions/_routes/' + mod + '.js')).default(app);
console.log('mounted', routes.length);
function toRe(p) { return new RegExp('^' + p.replace(/:[A-Za-z_]+/g, '([^/]+)') + '$'); }
function pn(p) { return (p.match(/:([A-Za-z_]+)/g) || []).map((s) => s.slice(1)); }
function match(v, url) { const [p, qs] = url.split('?'); const query = Object.fromEntries(new URLSearchParams(qs || ''));
  for (const r of routes) { if (r.v !== v) continue; const m = toRe(r.p).exec(p); if (!m) continue;
    const params = {}; pn(r.p).forEach((n, i) => params[n] = decodeURIComponent(m[i + 1])); return { r, params, query }; } return null; }
let st = 200;
async function call(v, url, { body, user } = {}) {
  const m = match(v, url); if (!m) throw new Error('no route ' + v + ' ' + url); st = 200;
  const raw = new Request('https://x' + url, { method: v.toUpperCase(), headers: { 'content-type': 'application/json' } });
  const c = {
    env: ENV, executionCtx: { waitUntil() {} },
    get: (k) => (k === 'user' ? user : undefined),
    req: { url: 'https://x' + url, method: v.toUpperCase(), param: (n) => m.params[n], query: (n) => (n == null ? m.query : m.query[n]),
      header: (n) => raw.headers.get(n), raw, json: async () => body || {}, parseBody: async () => ({}) },
    json: (o, s) => { if (s) st = s; return { _json: o, _status: s || 200 }; },
  };
  const r = await m.r.h(c); return r && r._json !== undefined ? r._json : r;
}
const A = (l, ok) => { console.log((ok ? 'PASS  ' : 'FAIL  ') + l); if (!ok) process.exitCode = 1; };
const q1 = (s, ...p) => sdb.prepare(s).get(...p);

sdb.exec(`
UPDATE shop_settings SET storefront_prices = 1 WHERE id = 1;
INSERT INTO users (id,email,name,password_hash,is_admin,admin_role,is_staff,show_prices,created_at)
 VALUES (700,'buyer@x.com','Buyer','h',0,'',0,1,datetime('now'));
INSERT INTO products (img,name,make_model,category,condition,price_cents,stock_count,is_active,sku)
VALUES ('PLAIN-1','Plain Part','Generic','misc','NEW',1000,10,1,'PLAIN-1');
INSERT INTO products (img,name,make_model,category,condition,price_cents,stock_count,is_active,sku,restricted_manager_approval)
VALUES ('APPROVAL-1','Needs Approval','Generic','misc','NEW',1000,10,1,'APPROVAL-1',1);
INSERT INTO products (img,name,make_model,category,condition,price_cents,stock_count,is_active,sku,restricted_id_required)
VALUES ('IDREQ-1','Needs ID','Generic','misc','NEW',1000,10,1,'IDREQ-1',1);
INSERT INTO products (img,name,make_model,category,condition,price_cents,stock_count,is_active,sku,restricted_tax_id_required)
VALUES ('TAXREQ-1','Needs Tax ID','Generic','misc','NEW',1000,10,1,'TAXREQ-1',1);
INSERT INTO products (img,name,make_model,category,condition,price_cents,stock_count,is_active,sku,is_redeemable)
VALUES ('SCRATCH-1','Scratch Card','Lottery','lottery','NEW',500,10,1,'SCRATCH-1',1);
`);

async function checkoutBlocked(img, label) {
  sdb.exec('DELETE FROM cart_items WHERE user_id = 700');
  sdb.exec(`INSERT INTO cart_items (user_id, product_img, qty) VALUES (700, '${img}', 1)`);
  const r = await call('post', '/api/checkout', { user: { id: 700, show_prices: 1 }, body: { payment_method: 'cash_pickup' } });
  A('checkout blocks ' + label, st === 400 && r.code === 'restricted_instore_only');
  const rg = await call('post', '/api/checkout/guest', { user: undefined, body: {
    name: 'Guest', email: 'g@example.com', payment_method: 'cash_pickup', items: [{ img, qty: 1 }],
  } });
  A('guest checkout blocks ' + label, st === 400 && rg.code === 'restricted_instore_only');
}

await checkoutBlocked('APPROVAL-1', 'a manager-approval item');
await checkoutBlocked('IDREQ-1', 'an ID-required item');
await checkoutBlocked('TAXREQ-1', 'a tax-ID-required item');
await checkoutBlocked('SCRATCH-1', 'a redeemable item');

// A plain item still checks out fine (no over-blocking).
sdb.exec('DELETE FROM cart_items WHERE user_id = 700');
sdb.exec("INSERT INTO cart_items (user_id, product_img, qty) VALUES (700, 'PLAIN-1', 1)");
let r = await call('post', '/api/checkout', { user: { id: 700, show_prices: 1 }, body: { payment_method: 'cash_pickup' } });
A('checkout: an ordinary item is unaffected', r && !r.code);
A('checkout: an ordinary item actually created an order', !!q1('SELECT id FROM orders WHERE id = ?', r.order_id));
