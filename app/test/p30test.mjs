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
const ENV = { DB: makeDB(sdb), SESSION_SECRET: 'test-secret-p30' };
const routes = [];
const app = {};
for (const v of ['get', 'post', 'patch', 'delete', 'put']) app[v] = (p, ...r) => routes.push({ v, p, h: r[r.length - 1] });
for (const mod of ['inventory', 'storefront', 'admin_misc']) (await import(APP + 'functions/_routes/' + mod + '.js')).default(app);
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

sdb.exec('DELETE FROM products;');
sdb.exec(`
UPDATE shop_settings SET storefront_prices = 1 WHERE id = 1;
INSERT INTO products (img,name,make_model,category,condition,price_cents,stock_count,is_active,sku,barcode) VALUES
 ('ALT-PART','Alternator','2018 Honda Civic','electrical','NEW',12000,10,1,'ALT-001','0123456789'),
 ('PLAIN','Plain Bracket','Generic','misc','NEW',900,10,1,'BRK-9',NULL);
`);

// ---- 1. save + validation --------------------------------------------------
let r = await call('put', '/api/admin/products/ALT-PART/alt-numbers', { body: { numbers: [
  { number: '31100-RNA-A01', kind: 'OEM' },
  { number: 'AL5052X', kind: 'interchange', note: 'Bosch' },
  { number: '13977', kind: 'superseded' },
  { number: '' },   // blank -> skipped
] } });
A('alt-numbers: saved 3 (blank skipped)', st === 200 && r.count === 3);
A('alt-numbers: rows persisted', q1("SELECT kind FROM product_alt_numbers WHERE product_img='ALT-PART' AND number='AL5052X'").kind === 'interchange');

r = await call('put', '/api/admin/products/ALT-PART/alt-numbers', { body: { numbers: [
  { number: 'X1' }, { number: 'x1' },   // case-insensitive dup
] } });
A('alt-numbers: rejects a case-insensitive duplicate', st === 400 && /duplicate/i.test(r.error || ''));

r = await call('put', '/api/admin/products/NOPE/alt-numbers', { body: { numbers: [] } });
A('alt-numbers: 404 for an unknown product', st === 404);

// re-save the real set (the two failed calls above didn't touch the table)
await call('put', '/api/admin/products/ALT-PART/alt-numbers', { body: { numbers: [
  { number: '31100-RNA-A01', kind: 'OEM' }, { number: 'AL5052X', kind: 'interchange' }, { number: '13977' },
] } });

// ---- 2. _lib/alt_numbers.js ---------------------------------------------
const { d1 } = await import(APP + 'functions/_lib/db.js');
const alt = await import(APP + 'functions/_lib/alt_numbers.js');
const m = await alt.loadAltNumbersByImg(d1(ENV), ['ALT-PART', 'PLAIN']);
A('loadAltNumbersByImg: 3 for ALT-PART, none for PLAIN',
  (m.get('ALT-PART') || []).length === 3 && !m.has('PLAIN'));

// ---- 3. POS scan matches an alternate number --------------------------
r = await call('get', '/api/admin/pos/scan?code=AL5052X');
A('pos scan: an exact alternate number resolves the part', st === 200 && r.product && r.product.img === 'ALT-PART');
r = await call('get', '/api/admin/pos/scan?code=al5052x');
A('pos scan: alternate-number match is case-insensitive', st === 200 && r.product && r.product.img === 'ALT-PART');
A('pos scan: the resolved product carries its alt_numbers', Array.isArray(r.product.alt_numbers) && r.product.alt_numbers.length === 3);
r = await call('get', '/api/admin/pos/scan?code=ALT-001');   // still works by SKU
A('pos scan: SKU still resolves', st === 200 && r.product.img === 'ALT-PART');
r = await call('get', '/api/admin/pos/scan?code=NOTHING');
A('pos scan: an unknown code is still a 404', st === 404);

// ---- 4. admin lookup: partial alternate number -----------------------
r = await call('get', '/api/admin/lookup?q=5052');
A('admin lookup: a partial alternate number finds the part', st === 200 && (r.products || []).some((x) => x.img === 'ALT-PART'));

// ---- 5. storefront / POS parts search (/api/products?q=) ------------
r = await call('get', '/api/products?limit=50&q=' + encodeURIComponent('31100-RNA-A01'));
A('products search: an alternate number returns the part', (r.products || []).some((x) => x.img === 'ALT-PART'));
r = await call('get', '/api/products?limit=50&q=13977');
A('products search: a superseded number returns the part', (r.products || []).some((x) => x.img === 'ALT-PART'));
r = await call('get', '/api/products?limit=50&q=nonsense-xyz');
A('products search: an unrelated term does not', !(r.products || []).some((x) => x.img === 'ALT-PART'));

// ---- 6. compact feed carries the alt string for client-side search --
r = await call('get', '/api/products?compact=1&limit=500');
const cRow = (r.rows || []).find((x) => x[0] === 'ALT-PART');
const pRow = (r.rows || []).find((x) => x[0] === 'PLAIN');
A('compact feed: a part with alt numbers gets element [8] = space-joined numbers',
  cRow && typeof cRow[8] === 'string' && /31100-RNA-A01/.test(cRow[8]) && /AL5052X/.test(cRow[8]));
A('compact feed: a part with no alt numbers has no element [8]', pRow && pRow.length === 8);
