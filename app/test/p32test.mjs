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
const ENV = { DB: makeDB(sdb), SESSION_SECRET: 'test-secret-p32' };
const routes = [];
const app = {};
for (const v of ['get', 'post', 'patch', 'delete', 'put']) app[v] = (p, ...r) => routes.push({ v, p, h: r[r.length - 1] });
for (const mod of ['inventory', 'pos_txn', 'redemptions', 'warranty', 'reports']) (await import(APP + 'functions/_routes/' + mod + '.js')).default(app);
console.log('mounted', routes.length);
function toRe(p) { return new RegExp('^' + p.replace(/:[A-Za-z_]+/g, '([^/]+)') + '$'); }
function pn(p) { return (p.match(/:([A-Za-z_]+)/g) || []).map((s) => s.slice(1)); }
function match(v, url) { const [p, qs] = url.split('?'); const query = Object.fromEntries(new URLSearchParams(qs || ''));
  for (const r of routes) { if (r.v !== v) continue; const m = toRe(r.p).exec(p); if (!m) continue;
    const params = {}; pn(r.p).forEach((n, i) => params[n] = decodeURIComponent(m[i + 1])); return { r, params, query }; } return null; }
const OWNER = { id: 900, is_admin: 1, admin_role: 'owner' };
const CASHIER = { id: 901, is_admin: 1, admin_role: 'cashier', perms: JSON.stringify({ 'pos.serial_freetype': false, 'pos.redeemable_mint': false }) };
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

sdb.exec(`
INSERT INTO users (id,email,name,password_hash,is_admin,admin_role,is_staff,created_at) VALUES
 (900,'owner@x.com','Owner','h',1,'owner',1,datetime('now')),
 (901,'cash@x.com','Cash','h',1,'cashier',1,datetime('now'));
INSERT INTO products (img,name,make_model,category,condition,price_cents,stock_count,is_active,sku,serial_required,warranty_days)
VALUES ('ECU-1','Engine ECU','Generic','electrical','NEW',30000,20,1,'ECU-1',1,20);
INSERT INTO products (img,name,make_model,category,condition,price_cents,stock_count,is_active,sku,core_charge_cents)
VALUES ('ALT-CORE','Alternator w/ core','Generic','electrical','NEW',18000,20,1,'ALT-CORE',5000);
INSERT INTO products (img,name,make_model,category,condition,price_cents,stock_count,is_active,sku,is_redeemable)
VALUES ('SCRATCH','Scratch Card','Lottery','lottery','NEW',500,50,1,'SCRATCH',1);
`);

// ---- 1. serial register load ------------------------------------------------
let r = await call('post', '/api/admin/products/ECU-1/serials', { body: { serials: 'SN-001\nSN-002\nsn-002\n\nSN-003' } });
A('serials: loaded 3 (blank + dup skipped)', st === 200 && r.in_stock === 3);
r = await call('get', '/api/admin/products/ECU-1/serials?status=in_stock');
A('serials: GET lists them in_stock', (r.serials || []).length === 3 && r.counts.in_stock === 3);
const badId = (r.serials.find((s) => s.serial === 'SN-003')).id;
r = await call('patch', '/api/admin/products/ECU-1/serials/' + badId, { body: { status: 'void' } });
A('serials: PATCH void works', st === 200 && q1("SELECT status FROM product_serials WHERE id=?", badId).status === 'void');

// ---- 2. serialised sale: register gate + lifecycle ------------------------
const serialSale = (user, sn) => call('post', '/api/admin/pos/sale', { body: {
  items: [{ product_img: 'ECU-1', description: 'Engine ECU', qty: 1, unit_price_usd: 300, warranty_days: 20, serial_number: sn }],
  payment_method: 'cash', amount_tendered: 100000,
}, user });

r = await serialSale(CASHIER, 'SN-999');
A('sale: a cashier is blocked from an off-register serial', st === 400 && /register/i.test(r.error || ''));
r = await serialSale(CASHIER, 'SN-001');
A('sale: a cashier may sell an in-stock serial', st === 200 && r.ok === true);
const s1 = q1("SELECT * FROM product_serials WHERE serial='SN-001'");
A('sale: that serial is now sold with a warranty date', s1.status === 'sold' && !!s1.warranty_until && s1.sale_id === r.id);
const saleWithSerial = r.id;
r = await serialSale(OWNER, 'SN-OFFREG');
A('sale: an owner (freetype) may sell an off-register serial', st === 200 && r.ok === true);
A('sale: the off-register serial got its own sold row (received_at NULL)',
  (function(){ const x = q1("SELECT * FROM product_serials WHERE serial='SN-OFFREG'"); return x && x.status === 'sold' && x.received_at == null; })());
const offRegSale = r.id;

r = await call('post', '/api/admin/pos/sales/' + saleWithSerial + '/void', { body: {} });
A('void: an in-register serial goes back to in_stock', st === 200 && q1("SELECT status FROM product_serials WHERE serial='SN-001'").status === 'in_stock');
r = await call('post', '/api/admin/pos/sales/' + offRegSale + '/void', { body: {} });
A('void: an off-register (free-typed) serial is voided', q1("SELECT status FROM product_serials WHERE serial='SN-OFFREG'").status === 'void');

// sell again then return -> 'returned'
r = await serialSale(CASHIER, 'SN-002');
const si = q1('SELECT id FROM pos_sale_items WHERE sale_id=?', r.id).id;
r = await call('post', '/api/admin/pos/sales/' + (q1('SELECT sale_id FROM pos_sale_items WHERE id=?', si).sale_id) + '/return', { body: {
  items: [{ sale_item_id: si, qty: 1 }], refund_method: 'cash',
} });
A('return: a returned serial is marked returned', st === 200 && q1("SELECT status FROM product_serials WHERE serial='SN-002'").status === 'returned');

// ---- 3. redeemable instruments -------------------------------------------
r = await call('post', '/api/admin/redemptions/load', { body: { product_img: 'SCRATCH', codes: 'CARD-A\nCARD-B' } });
A('redeem: loaded 2 instruments', st === 200 && r.in_stock === 2);
const redeemSale = (user) => call('post', '/api/admin/pos/sale', { body: {
  items: [{ product_img: 'SCRATCH', description: 'Scratch Card', qty: 1, unit_price_usd: 5 }],
  payment_method: 'cash', amount_tendered: 100000,
}, user });
r = await redeemSale(CASHIER);
A('sale: assigns the first pre-loaded instrument', st === 200 && q1("SELECT status FROM redemption_instruments WHERE code='CARD-A'").status === 'sold');
r = await redeemSale(CASHIER);
A('sale: assigns the second one', st === 200 && q1("SELECT status FROM redemption_instruments WHERE code='CARD-B'").status === 'sold');
r = await redeemSale(CASHIER);
A('sale: a cashier with no mint permission is blocked once stock is out', st === 400 && /instruments/i.test(r.error || ''));
r = await redeemSale(OWNER);
A('sale: an owner mints an RD- code when none are loaded', st === 200 &&
  !!q1("SELECT 1 FROM redemption_instruments WHERE sale_id=? AND code LIKE 'RD-%'", r.id));

// ---- 4. core deposit ---------------------------------------------------
r = await call('post', '/api/admin/pos/sale', { body: {
  items: [{ product_img: 'ALT-CORE', description: 'Alternator', qty: 1, unit_price_usd: 180, core_charge_usd: 0, core_returned: true }],
  payment_method: 'cash', amount_tendered: 100000,
} });
A('core: a line sold with core_returned=true has the flag set and no core charge',
  st === 200 && (function(){ const x = q1('SELECT core_returned, core_charge_cents FROM pos_sale_items WHERE sale_id=?', r.id); return x.core_returned === 1 && x.core_charge_cents === 0; })());

r = await call('post', '/api/admin/pos/sale', { body: {
  items: [{ product_img: 'ALT-CORE', description: 'Alternator', qty: 1, unit_price_usd: 180, core_charge_usd: 50 }],
  payment_method: 'cash', amount_tendered: 100000,
} });
const coreSale = r.id;
const coreLine = q1('SELECT id FROM pos_sale_items WHERE sale_id=?', coreSale).id;
r = await call('post', '/api/admin/pos/sales/' + coreSale + '/core-return', { body: { sale_item_id: coreLine, qty: 1, refund_method: 'cash' } });
A('core-return: refunds the deposit and writes a core_returns row',
  st === 200 && Math.abs(r.refund_usd - 50) < 0.01 && q1('SELECT qty FROM core_returns WHERE sale_item_id=?', coreLine).qty === 1);
A('core-return: the part was not restocked', q1("SELECT stock_count FROM products WHERE img='ALT-CORE'").stock_count === 18);
r = await call('post', '/api/admin/pos/sales/' + coreSale + '/core-return', { body: { sale_item_id: coreLine, qty: 1, refund_method: 'cash' } });
A('core-return: rejects a second claim once the line is exhausted', st === 400 && /remain/i.test(r.error || ''));

r = await call('get', '/api/admin/reports/core-charges?from=2000-01-01&to=2999-01-01');
A('report: outstanding ignores a core_returned line and drops the refunded qty',
  r.totals && r.totals.core_outstanding === 0 && r.totals.refunded_later > 0);

// ---- 5. warranty register + claim -----------------------------------
// SN-001 is back in stock after the void above -- sell it fresh so there's a
// live warrantied unit to register / claim against.
r = await serialSale(CASHIER, 'SN-001');
A('warranty: sold SN-001 fresh', st === 200 && r.ok === true);
r = await call('get', '/api/admin/warranty/register?filter=expiring');
A('warranty: an ECU sold with a 20-day warranty shows under "expiring"',
  (r.register || []).some((x) => x.serial === 'SN-001'));
r = await call('post', '/api/admin/warranty/claims', { body: { serial: 'SN-001', fault: 'no crank', customer_name: 'Bob' } });
A('warranty: a claim opens from a serial', st === 200 && r.id > 0);
const claimId = r.id;
r = await call('patch', '/api/admin/warranty/claims/' + claimId, { body: { status: 'replace', resolution_note: 'swapped' } });
A('warranty: resolving as replace flips the serial to claimed',
  st === 200 && q1("SELECT status FROM product_serials WHERE serial='SN-001'").status === 'claimed');
r = await call('get', '/api/admin/warranty/register?filter=claimed');
A('warranty: the claimed unit appears under the "claimed" filter',
  (r.register || []).some((x) => x.serial === 'SN-001' && x.has_open_claim));
