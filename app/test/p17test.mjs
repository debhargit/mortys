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
// Minimal R2-bucket-shaped mock: Map-backed get/put, enough for putUpload()/
// copyUpload() in _lib/uploads.js to round-trip real bytes through fake keys.
function makeR2() {
  const store = new Map();
  return {
    async put(key, bytes, opts) { store.set(key, { bytes, contentType: opts && opts.httpMetadata && opts.httpMetadata.contentType }); },
    async get(key) {
      const v = store.get(key);
      if (!v) return null;
      return { arrayBuffer: async () => v.bytes, httpMetadata: { contentType: v.contentType } };
    },
    _store: store,
  };
}
const UPLOADS = makeR2();
const ENV = { DB: makeDB(sdb), UPLOADS };
const routes = [];
const app = {};
for (const v of ['get', 'post', 'patch', 'delete', 'put']) app[v] = (p, ...r) => routes.push({ v, p, h: r[r.length - 1] });
for (const mod of ['product_matrix', 'inventory']) (await import(APP + 'functions/_routes/' + mod + '.js')).default(app);
console.log('mounted', routes.length);
function toRe(p) { return new RegExp('^' + p.replace(/:[A-Za-z_]+/g, '([^/]+)') + '$'); }
function pn(p) { return (p.match(/:([A-Za-z_]+)/g) || []).map((s) => s.slice(1)); }
function match(v, url) { const [p, qs] = url.split('?'); const query = Object.fromEntries(new URLSearchParams(qs || ''));
  for (const r of routes) { if (r.v !== v) continue; const m = toRe(r.p).exec(p); if (!m) continue;
    const params = {}; pn(r.p).forEach((n, i) => params[n] = decodeURIComponent(m[i + 1])); return { r, params, query }; } return null; }
const USER = { id: 900, is_admin: 1, admin_role: 'owner' };
let st = 200;
// `opts.multipart` (a plain object with a non-string `photo` field) simulates
// a multipart POST so readUploadBody() takes the file branch; otherwise the
// call is treated as a plain JSON body.
async function call(v, url, body, opts) {
  const m = match(v, url); if (!m) throw new Error('no route ' + v + ' ' + url); st = 200;
  const mp = opts && opts.multipart;
  const c = {
    env: ENV, executionCtx: { waitUntil() {} }, get: () => USER,
    req: {
      param: (n) => m.params[n], query: (n) => (n == null ? m.query : m.query[n]),
      header: (n) => (mp && String(n).toLowerCase() === 'content-type' ? 'multipart/form-data; boundary=x' : undefined),
      json: async () => body || {},
      parseBody: async () => mp || {},
    },
    json: (o, s) => { if (s) st = s; return { _json: o }; },
  };
  const r = await m.r.h(c); return r && r._json !== undefined ? r._json : r;
}
const A = (l, ok) => { console.log((ok ? 'PASS  ' : 'FAIL  ') + l); if (!ok) process.exitCode = 1; };
const q1 = (s, ...p) => sdb.prepare(s).get(...p);
const qA = (s, ...p) => sdb.prepare(s).all(...p);

function fakeFile(name) {
  return { size: 2048, type: 'image/jpeg', name: name || 'photo.jpg', arrayBuffer: async () => new TextEncoder().encode('fake-bytes-' + name).buffer };
}

sdb.exec(`
INSERT INTO users (id,email,name,password_hash,is_admin,admin_role,is_staff,created_at)
 VALUES (900,'owner@x.com','Owner','h',1,'owner',1,datetime('now'));
`);
// A pre-existing R2-backed product, used to test the "copy the photo from an
// existing part" creation path.
await UPLOADS.put('products/existing.jpg', new TextEncoder().encode('existing-bytes').buffer, { httpMetadata: { contentType: 'image/jpeg' } });
sdb.exec(`
INSERT INTO products (img,name,make_model,category,condition,price_cents,stock_count,is_active)
VALUES ('/uploads/products/existing.jpg','Old Brake Pad','Generic','brakes','NEW',5000,10,1);
INSERT INTO products (img,name,make_model,category,condition,price_cents,stock_count,is_active)
VALUES ('legacy-static-photo.webp','Legacy Static Part','Generic','brakes','NEW',3000,5,1);
`);

// ---- reject: axis1 too short ----------------------------------------------
let r = await call('post', '/api/admin/product-matrix', null, { multipart: {
  photo: fakeFile(), name: 'Brake Pad Set', category: 'brakes',
  axis1_label: 'Position', axis1_values: 'Front',
}});
A('create: axis1 needs >=2 values', st === 400 && /at least 2/i.test(r.error || ''));

// ---- reject: no photo, no source_img --------------------------------------
r = await call('post', '/api/admin/product-matrix', null, { multipart: {
  name: 'Brake Pad Set', category: 'brakes', axis1_label: 'Position', axis1_values: 'Front,Rear',
}});
A('create: photo or source_img required', st === 400 && /photo/i.test(r.error || ''));

// ---- reject: source_img pointing at a non-uploads static photo ------------
r = await call('post', '/api/admin/product-matrix', null, { multipart: {
  name: 'Brake Pad Set', category: 'brakes', axis1_label: 'Position', axis1_values: 'Front,Rear',
  source_img: 'legacy-static-photo.webp',
}});
A('create: rejects a non-duplicable static photo as source_img', st === 400 && /duplicable/i.test(r.error || ''));

// ---- reject: too many total children ---------------------------------------
r = await call('post', '/api/admin/product-matrix', null, { multipart: {
  photo: fakeFile(), name: 'Huge Matrix', category: 'brakes',
  axis1_label: 'A', axis1_values: Array.from({ length: 10 }, (_, i) => 'a' + i).join(','),
  axis2_label: 'B', axis2_values: Array.from({ length: 10 }, (_, i) => 'b' + i).join(','),
}});
A('create: rejects a combination that exceeds the child cap', st === 400 && /limit is 40/i.test(r.error || ''));

// ---- 1-axis matrix, fresh photo upload -------------------------------------
r = await call('post', '/api/admin/product-matrix', null, { multipart: {
  photo: fakeFile('brake.jpg'), name: 'Brake Pad Set', category: 'brakes', condition: 'NEW',
  price_usd: '45.00', cost_usd: '20.00', warranty_days: '90', core_charge_usd: '5', env_fee_usd: '1.5',
  axis1_label: 'Position', axis1_values: 'Front, Rear, Front', // dupe "Front" should be deduped
  stock_count: '3',
}});
A('create: 1-axis matrix succeeds', st === 200 && r.ok === true);
A('create: dedupes axis values (Front listed twice -> 2 children, not 3)', r.children.length === 2);
const matrixId = r.matrix_id;
const [child1, child2] = r.children;
A('create: distinct copied photo keys per child', child1.img !== child2.img);
A('create: child names include the base + axis value', child1.name === 'Brake Pad Set — Front' && child2.name === 'Brake Pad Set — Rear');
A('create: child skus are distinct', child1.sku !== child2.sku);

let row1 = q1('SELECT * FROM products WHERE img = ?', child1.img);
A('create: shared price/cost/warranty/core/env copied to the child', row1.price_cents === 4500 && row1.cost_cents === 2000 &&
  row1.warranty_days === 90 && row1.core_charge_cents === 500 && row1.env_fee_cents === 150);
A('create: per-matrix stock_count applied to every child', row1.stock_count === 3);
A('create: matrix_id / axis value stamped on the child', row1.matrix_id === matrixId && row1.matrix_axis1_value === 'Front');
A('create: matrix_overrides starts empty', row1.matrix_overrides === '[]');

// ---- 2-axis matrix ----------------------------------------------------------
r = await call('post', '/api/admin/product-matrix', null, { multipart: {
  photo: fakeFile('pad2.jpg'), name: 'Brake Pad Kit', category: 'brakes',
  axis1_label: 'Position', axis1_values: 'Front,Rear', axis2_label: 'Side', axis2_values: 'Left,Right',
}});
A('create: 2-axis matrix creates the full cross product (2x2=4)', st === 200 && r.children.length === 4);
A('create: 2-axis child name includes both values', r.children.some((x) => x.name === 'Brake Pad Kit — Front / Left'));

// ---- clone photo from an existing R2-backed product ------------------------
r = await call('post', '/api/admin/product-matrix', null, { multipart: {
  name: 'Cloned Matrix', category: 'brakes', axis1_label: 'Size', axis1_values: 'S,M',
  source_img: '/uploads/products/existing.jpg',
}});
A('create: clones the photo from an existing uploaded part', st === 200 && r.ok === true);
A('create: the clone is a fresh key, not the literal source', r.children[0].img !== '/uploads/products/existing.jpg');

// ---- GET matrix detail ------------------------------------------------------
r = await call('get', '/api/admin/product-matrix/' + matrixId);
A('get: returns matrix + children', st === 200 && r.matrix.id === matrixId && r.children.length === 2);
A('get: no overrides yet', r.overrides_summary.length === 0);
A('get: matrix money fields converted to usd', r.matrix.price_usd === 45 && r.matrix.core_charge_usd === 5);

// ---- PATCH push: propagates to all (non-overridden) children --------------
r = await call('patch', '/api/admin/product-matrix/' + matrixId, { price_usd: 50, warranty_days: 120 });
A('patch: push updates every child by default', st === 200 && r.updated_children === 2);
row1 = q1('SELECT * FROM products WHERE img = ?', child1.img);
let row2 = q1('SELECT * FROM products WHERE img = ?', child2.img);
A('patch: both children now reflect the new shared price', row1.price_cents === 5000 && row2.price_cents === 5000);
A('patch: both children now reflect the new warranty', row1.warranty_days === 120 && row2.warranty_days === 120);
let parentRow = q1('SELECT * FROM product_matrices WHERE id = ?', matrixId);
A('patch: the matrix parent itself is updated', parentRow.price_cents === 5000 && parentRow.warranty_days === 120);

// ---- diverge one child via the normal product PATCH, diff-based -----------
r = await call('patch', '/api/admin/products/' + encodeURIComponent(child1.img), {
  price_usd: 65, // differs from the matrix's current 50 -> should override
});
A('product patch: child price updated', st === 200);
row1 = q1('SELECT * FROM products WHERE img = ?', child1.img);
A('product patch: price_usd added to matrix_overrides (value now diverges)', JSON.parse(row1.matrix_overrides).includes('price_usd'));

// Push again from the matrix -- the overridden child must be skipped.
r = await call('patch', '/api/admin/product-matrix/' + matrixId, { price_usd: 55 });
A('patch: skips the overridden child', r.updated_children === 1);
row1 = q1('SELECT * FROM products WHERE img = ?', child1.img);
row2 = q1('SELECT * FROM products WHERE img = ?', child2.img);
A('patch: overridden child keeps its own price', row1.price_cents === 6500);
A('patch: non-overridden child gets the new shared price', row2.price_cents === 5500);

// A save that resends the FULL form (as peSave always does) but happens to
// match the current shared value must NOT mark the field overridden --
// otherwise every ordinary edit would detach a child from future pushes.
r = await call('patch', '/api/admin/products/' + encodeURIComponent(child2.img), { price_usd: 55, warranty_days: 120 });
row2 = q1('SELECT * FROM products WHERE img = ?', child2.img);
A('product patch: resubmitting the already-matching shared value stays un-overridden', JSON.parse(row2.matrix_overrides).length === 0);

// Retyping the shared value on the overridden child un-diverges it.
r = await call('patch', '/api/admin/products/' + encodeURIComponent(child1.img), { price_usd: 55 });
row1 = q1('SELECT * FROM products WHERE img = ?', child1.img);
A('product patch: matching the shared value again removes the override', JSON.parse(row1.matrix_overrides).length === 0);

// ---- add a variant later -----------------------------------------------------
r = await call('post', '/api/admin/product-matrix/' + matrixId + '/children', { axis1_value: 'Middle' });
A('add variant: succeeds', st === 200 && r.ok === true);
A('add variant: name/sku follow the same pattern', r.name === 'Brake Pad Set — Middle');
let row3 = q1('SELECT * FROM products WHERE img = ?', r.img);
A('add variant: carries the matrix\'s current shared values', row3.price_cents === 5500 && row3.warranty_days === 120);
A('add variant: fresh photo, distinct from the others', row3.img !== child1.img && row3.img !== child2.img);

r = await call('post', '/api/admin/product-matrix/' + matrixId + '/children', { axis1_value: 'Middle' });
A('add variant: rejects a duplicate axis combination', st === 409);

// ---- reset one child to the matrix default ----------------------------------
await call('patch', '/api/admin/products/' + encodeURIComponent(child1.img), { price_usd: 999 });
r = await call('post', '/api/admin/product-matrix/' + matrixId + '/reset/' + encodeURIComponent(child1.img));
A('reset: succeeds', st === 200 && r.ok === true);
row1 = q1('SELECT * FROM products WHERE img = ?', child1.img);
A('reset: value restored to the matrix default', row1.price_cents === 5500);
A('reset: overrides cleared', row1.matrix_overrides === '[]');

// ---- remove one variant, then the whole matrix ------------------------------
r = await call('delete', '/api/admin/product-matrix/' + matrixId + '/children/' + encodeURIComponent(child1.img));
A('delete child: succeeds', st === 200 && r.ok === true);
row1 = q1('SELECT * FROM products WHERE img = ?', child1.img);
A('delete child: deactivates just that child', row1.is_active === 0);
row2 = q1('SELECT * FROM products WHERE img = ?', child2.img);
A('delete child: leaves the sibling untouched', row2.is_active === 1);

r = await call('delete', '/api/admin/product-matrix/' + matrixId);
A('delete matrix: deactivates every remaining child', st === 200 && r.deactivated >= 1);
const stillActive = qA('SELECT img FROM products WHERE matrix_id = ? AND is_active = 1', matrixId);
A('delete matrix: no active children remain', stillActive.length === 0);
