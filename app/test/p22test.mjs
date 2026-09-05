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
for (const mod of ['pos_txn', 'redemptions']) (await import(APP + 'functions/_routes/' + mod + '.js')).default(app);
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
const qA = (s, ...p) => sdb.prepare(s).all(...p);

sdb.exec(`
INSERT INTO users (id,email,name,password_hash,is_admin,admin_role,is_staff,created_at) VALUES
 (900,'owner@x.com','Owner','h',1,'owner',1,datetime('now'));
INSERT INTO products (img,name,make_model,category,condition,price_cents,stock_count,is_active,sku,is_redeemable)
VALUES ('SCRATCH-5','Scratch Card $5','Lottery','lottery','NEW',500,100,1,'SCRATCH-5',1);
INSERT INTO products (img,name,make_model,category,condition,price_cents,stock_count,is_active,sku)
VALUES ('PLAIN-1','Plain Part','Generic','misc','NEW',1000,20,1,'PLAIN-1');
`);

// ---- selling a redeemable item mints one instrument per unit --------------
let r = await call('post', '/api/admin/pos/sale', {
  items: [
    { product_img: 'SCRATCH-5', description: 'Scratch Card $5', qty: 1, unit_price_usd: 5 },
    { product_img: 'SCRATCH-5', description: 'Scratch Card $5', qty: 1, unit_price_usd: 5 },
    { product_img: 'PLAIN-1', description: 'Plain Part', qty: 3, unit_price_usd: 10 },
  ],
  payment_method: 'cash', amount_tendered: 100,
});
A('sale: succeeds with a mix of redeemable and plain lines', st === 200 && r.ok === true);
let instruments = qA('SELECT * FROM redemption_instruments WHERE sale_id = ? ORDER BY id', r.id);
A('sale: one instrument minted per redeemable line (2 lines -> 2 instruments)', instruments.length === 2);
A('sale: no instrument minted for the plain-part line', instruments.every((i) => i.product_img === 'SCRATCH-5'));
A('sale: instrument codes are distinct and RD-prefixed', instruments[0].code !== instruments[1].code && /^RD-/.test(instruments[0].code));
A('sale: face value taken from the line\'s unit price', instruments[0].face_value_cents === 500);
A('sale: instrument starts in "sold" status, tied to the sale', instruments[0].status === 'sold' && instruments[0].sale_id === r.id);

// ---- GET /api/admin/redemptions (list + detail) ----------------------------
const code = instruments[0].code;
r = await call('get', '/api/admin/redemptions');
A('list: includes the newly-sold instruments', r.redemptions.filter((x) => x.sale_id === instruments[0].sale_id).length === 2);

r = await call('get', '/api/admin/redemptions?status=redeemed');
A('list: status filter excludes freshly-sold instruments', !r.redemptions.some((x) => x.code === code));

r = await call('get', '/api/admin/redemptions/' + code);
A('detail: returns the instrument + its product + its sale', st === 200 && r.redemption.code === code &&
  r.product.img === 'SCRATCH-5' && r.sale.id === instruments[0].sale_id);

// ---- redeem ------------------------------------------------------------------
r = await call('post', '/api/admin/redemptions/' + code + '/redeem', { payout_usd: 20, notes: 'winner!' });
A('redeem: succeeds and reports the payout', st === 200 && r.ok === true && r.payout_usd === 20);
let row = q1('SELECT * FROM redemption_instruments WHERE code = ?', code);
A('redeem: status + payout + redeemed_by persisted', row.status === 'redeemed' && row.payout_cents === 2000 && row.redeemed_by === 900);

r = await call('post', '/api/admin/redemptions/' + code + '/redeem', { payout_usd: 5 });
A('redeem: cannot redeem an already-redeemed instrument', st === 400 && /already redeemed/i.test(r.error));

// A losing card is redeemed with no payout at all.
const code2 = instruments[1].code;
r = await call('post', '/api/admin/redemptions/' + code2 + '/redeem', {});
A('redeem: a losing card redeems with no payout (null)', st === 200 && r.payout_usd === null);
row = q1('SELECT * FROM redemption_instruments WHERE code = ?', code2);
A('redeem: payout_cents stays null for a no-payout redemption', row.payout_cents === null && row.status === 'redeemed');

// ---- void --------------------------------------------------------------------
r = await call('post', '/api/admin/pos/sale', {
  items: [{ product_img: 'SCRATCH-5', description: 'Scratch Card $5', qty: 1, unit_price_usd: 5 }],
  payment_method: 'cash', amount_tendered: 10,
});
const spoiled = qA('SELECT * FROM redemption_instruments WHERE sale_id = ?', r.id)[0];
r = await call('post', '/api/admin/redemptions/' + spoiled.code + '/void', { notes: 'misprinted' });
A('void: succeeds', st === 200 && r.ok === true);
row = q1('SELECT * FROM redemption_instruments WHERE code = ?', spoiled.code);
A('void: status set to void', row.status === 'void');

r = await call('post', '/api/admin/redemptions/' + spoiled.code + '/void', {});
A('void: re-voiding an already-void instrument is a harmless no-op, not an error', st === 200);

r = await call('post', '/api/admin/redemptions/' + code + '/void', {});
A('void: cannot void an already-redeemed instrument', st === 400 && /already redeemed/i.test(r.error));

r = await call('post', '/api/admin/redemptions/RD-NOPE-NOPE/redeem', {});
A('redeem: 404 for an unknown code', st === 404);
