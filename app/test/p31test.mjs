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
const ENV = { DB: makeDB(sdb), SESSION_SECRET: 'test-secret-p31' };
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
INSERT INTO products (img,name,make_model,category,condition,price_cents,stock_count,low_threshold,is_active,sku) VALUES
 ('PREMIUM','Premium Filter','Generic','engine','NEW',20000,5,2,1,'PREM-1'),
 ('ECONOMY','Economy Filter','Generic','engine','NEW',12000,8,2,1,'ECON-1'),
 ('OOS-SUB','Backorder Filter','Generic','engine','NEW',9000,0,2,1,'OOS-1'),
 ('OLD-PART','Old Sensor','Generic','electrical','NEW',9000,0,2,1,'OLD-1'),
 ('NEW-PART','New Sensor','Generic','electrical','NEW',10000,10,2,1,'NEW-1');
`);

// ---- 1. save with a substitute link + validation --------------------------
let r = await call('put', '/api/admin/products/PREMIUM/alt-numbers', { body: { numbers: [
  { number: 'PR-100', kind: 'substitute', substitute_img: 'ECONOMY', note: 'cheaper equivalent' },
  { number: 'PR-100-B', kind: 'substitute', substitute_img: 'OOS-SUB' },
] } });
A('save: 2 substitute-linked alt numbers', st === 200 && r.count === 2);
A('save: substitute_img persisted', q1("SELECT substitute_img s FROM product_alt_numbers WHERE product_img='PREMIUM' AND number='PR-100'").s === 'ECONOMY');

r = await call('put', '/api/admin/products/PREMIUM/alt-numbers', { body: { numbers: [{ number: 'X', substitute_img: 'PREMIUM' }] } });
A('save: rejects a self-substitute', st === 400 && /own substitute/i.test(r.error || ''));
r = await call('put', '/api/admin/products/PREMIUM/alt-numbers', { body: { numbers: [{ number: 'X', substitute_img: 'GHOST' }] } });
A('save: rejects an unknown substitute target', st === 400 && /not found/i.test(r.error || ''));

// re-save the good set + the supersession link
await call('put', '/api/admin/products/PREMIUM/alt-numbers', { body: { numbers: [
  { number: 'PR-100', kind: 'substitute', substitute_img: 'ECONOMY' },
  { number: 'PR-100-B', kind: 'substitute', substitute_img: 'OOS-SUB' },
] } });
await call('put', '/api/admin/products/OLD-PART/alt-numbers', { body: { numbers: [
  { number: 'SEN-OLD', kind: 'superseded by', substitute_img: 'NEW-PART' },
] } });

// ---- 2. loadSubstitutesByImg direct ------------------------------------
const { d1 } = await import(APP + 'functions/_lib/db.js');
const an = await import(APP + 'functions/_lib/alt_numbers.js');
let subs = await an.loadSubstitutesForImg(d1(ENV), 'PREMIUM');
A('subs: PREMIUM forward -> ECONOMY + OOS-SUB, both labelled "substitute"',
  subs.forward.length === 2 && subs.forward.every((s) => s.relationship === 'substitute') &&
  subs.forward.some((s) => s.img === 'ECONOMY'));
subs = await an.loadSubstitutesForImg(d1(ENV), 'ECONOMY');
A('subs: ECONOMY reverse -> PREMIUM, labelled "a substitute for"',
  subs.forward.length === 0 && subs.reverse.length === 1 && subs.reverse[0].img === 'PREMIUM' && subs.reverse[0].relationship === 'a substitute for');
subs = await an.loadSubstitutesForImg(d1(ENV), 'OLD-PART');
A('subs: OLD-PART forward "superseded by" NEW-PART', subs.forward.length === 1 && subs.forward[0].img === 'NEW-PART' && subs.forward[0].relationship === 'superseded by');
subs = await an.loadSubstitutesForImg(d1(ENV), 'NEW-PART');
A('subs: NEW-PART reverse inverts to "supersedes" OLD-PART', subs.reverse.length === 1 && subs.reverse[0].img === 'OLD-PART' && subs.reverse[0].relationship === 'supersedes');

sdb.exec("UPDATE products SET is_active = 0 WHERE img = 'OOS-SUB'");
subs = await an.loadSubstitutesForImg(d1(ENV), 'PREMIUM');
A('subs: an inactive substitute is dropped from forward', subs.forward.length === 1 && subs.forward[0].img === 'ECONOMY');
sdb.exec("UPDATE products SET is_active = 1 WHERE img = 'OOS-SUB'");

// ---- 3. POS scan carries the substitutes -----------------------------
r = await call('get', '/api/admin/pos/scan?code=PREM-1');
A('scan: resolved product carries substitutes.forward with price + stock',
  st === 200 && r.product.substitutes && r.product.substitutes.forward.some((s) =>
    s.img === 'ECONOMY' && Math.abs(s.price_usd - 120) < 0.01 && s.stock_count === 8));

// ---- 4. storefront detail: in-stock forward links only --------------
r = await call('get', '/api/products/PREMIUM', { user: { id: 1, show_prices: 1 } });
const shownSubs = (r.product && r.product.substitutes) || [];
A('detail: PREMIUM shows ECONOMY (active + in stock)', shownSubs.some((s) => s.img === 'ECONOMY'));
A('detail: an out-of-stock substitute (OOS-SUB) is omitted', !shownSubs.some((s) => s.img === 'OOS-SUB'));
r = await call('get', '/api/products/ECONOMY', { user: { id: 1, show_prices: 1 } });
A('detail: ECONOMY has no substitutes strip (reverse links are POS-only)', !(r.product && r.product.substitutes));

// ---- 5. 0054 alias search still works on a row that also links -------
r = await call('get', '/api/products?limit=50&q=PR-100');
A('search: an alt number whose row also has a substitute still finds its own part', (r.products || []).some((x) => x.img === 'PREMIUM'));

// ---- 6. compact feed still carries the alt string --------------------
r = await call('get', '/api/products?compact=1&limit=500');
const cRow = (r.rows || []).find((x) => x[0] === 'PREMIUM');
A('compact: PREMIUM row element [8] still lists its alt numbers', cRow && typeof cRow[8] === 'string' && /PR-100/.test(cRow[8]));
