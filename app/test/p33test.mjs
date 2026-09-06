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
const ENV = { DB: makeDB(sdb), SESSION_SECRET: 'test-secret-p33' };
const routes = [];
const app = {};
for (const v of ['get', 'post', 'patch', 'delete', 'put']) app[v] = (p, ...r) => routes.push({ v, p, h: r[r.length - 1] });
for (const mod of ['inventory', 'storefront']) (await import(APP + 'functions/_routes/' + mod + '.js')).default(app);
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

sdb.exec(`
DELETE FROM products;
UPDATE shop_settings SET storefront_prices = 1 WHERE id = 1;
INSERT INTO products (img,name,make_model,category,condition,price_cents,stock_count,is_active,sku)
VALUES ('/uploads/products/hero.jpg','Widget','Generic','misc','NEW',1000,10,1,'W-1'),
       ('/uploads/products/plain.jpg','Plain','Generic','misc','NEW',500,10,1,'P-1');
`);

// ---- 1. add images (urls branch) ----------------------------------------
let r = await call('post', '/api/admin/products/' + encodeURIComponent('/uploads/products/hero.jpg') + '/images',
  { body: { urls: ['https://cdn/a.jpg', 'https://cdn/b.jpg'] } });
A('images: added 2 via urls', st === 200 && r.images.length === 2);
r = await call('get', '/api/admin/products/' + encodeURIComponent('/uploads/products/hero.jpg') + '/images');
A('images: GET lists them, sort_order 0 then 1',
  r.images.length === 2 && r.images[0].sort_order === 0 && r.images[1].sort_order === 1 && r.primary_image_override == null);
const imgA = r.images[0].id, imgB = r.images[1].id;

// ---- 2. make-primary --------------------------------------------------
r = await call('post', '/api/admin/products/' + encodeURIComponent('/uploads/products/hero.jpg') + '/images/' + imgB + '/make-primary', { body: {} });
A('make-primary: sets primary_image_override to that url', st === 200 && r.primary_image_override === 'https://cdn/b.jpg');
r = await call('get', '/api/products?limit=50&q=Widget');
const wrow = (r.products || []).find((x) => x.img === '/uploads/products/hero.jpg');
A('products list: thumb_url follows the override', wrow && wrow.thumb_url === 'https://cdn/b.jpg');
r = await call('get', '/api/products/' + encodeURIComponent('/uploads/products/hero.jpg'));
A('products detail: gallery lists the effective primary first, then the original, then the rest, no dupes',
  st === 200 && r.product.images.map((g) => g.url).join(',') === 'https://cdn/b.jpg,/uploads/products/hero.jpg,https://cdn/a.jpg' &&
  r.product.images[0].is_primary === true && r.product.primary_image_url === 'https://cdn/b.jpg');
r = await call('post', '/api/admin/products/' + encodeURIComponent('/uploads/products/hero.jpg') + '/images/original/make-primary', { body: {} });
A('make-primary original: clears the override', st === 200 && q1("SELECT primary_image_override p FROM products WHERE img='/uploads/products/hero.jpg'").p == null);

// ---- 3. delete + override fallback ---------------------------------
await call('post', '/api/admin/products/' + encodeURIComponent('/uploads/products/hero.jpg') + '/images/' + imgA + '/make-primary', { body: {} });
r = await call('delete', '/api/admin/products/' + encodeURIComponent('/uploads/products/hero.jpg') + '/images/' + imgA);
A('delete: row removed and the override it was pointing at is cleared',
  st === 200 && !q1('SELECT 1 FROM product_images WHERE id=?', imgA) &&
  q1("SELECT primary_image_override p FROM products WHERE img='/uploads/products/hero.jpg'").p == null);

// ---- 4. a product with no extras still returns a 1-entry gallery ----
r = await call('get', '/api/products/' + encodeURIComponent('/uploads/products/plain.jpg'));
A('detail: a no-gallery product returns exactly its one photo',
  st === 200 && r.product.images.length === 1 && r.product.images[0].url === '/uploads/products/plain.jpg' && r.product.images[0].is_primary === true);

// ---- 5. _lib/product_images.js -------------------------------------
const pi = await import(APP + 'functions/_lib/product_images.js');
A('primaryUrl: override wins, else img', pi.primaryUrl({ img: 'x', primary_image_override: 'y' }) === 'y' && pi.primaryUrl({ img: 'x' }) === 'x');
const g = pi.galleryFor({ img: 'orig', primary_image_override: 'ovr' }, [{ url: 'e1' }, { url: 'ovr' }]);
A('galleryFor: primary first, original next, extras after, dup dropped',
  g.map((x) => x.url).join(',') === 'ovr,orig,e1' && g[0].is_primary === true);
const g2 = pi.galleryFor({ img: 'orig' }, []);
A('galleryFor: no override + no extras -> just the original', g2.length === 1 && g2[0].url === 'orig' && g2[0].is_primary);

// ---- 6. compact feed carries element [9] when the thumb differs -----
await call('post', '/api/admin/products/' + encodeURIComponent('/uploads/products/hero.jpg') + '/images', { body: { urls: ['https://cdn/c.jpg'] } });
r = await call('get', '/api/admin/products/' + encodeURIComponent('/uploads/products/hero.jpg') + '/images');
await call('post', '/api/admin/products/' + encodeURIComponent('/uploads/products/hero.jpg') + '/images/' + r.images[r.images.length - 1].id + '/make-primary', { body: {} });
r = await call('get', '/api/products?compact=1&limit=50');
const cw = (r.rows || []).find((x) => x[0] === '/uploads/products/hero.jpg');
const cp = (r.rows || []).find((x) => x[0] === '/uploads/products/plain.jpg');
A('compact: an overridden part gets element [9] = the effective thumb', cw && cw[9] === 'https://cdn/c.jpg');
A('compact: a plain part has no element [9]', cp && cp.length <= 8);
