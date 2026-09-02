import { fileURLToPath } from 'node:url';
// Portable base: this file lives in app/test/, so app/ is one level up.
const APP = new URL('../', import.meta.url).href;            // file:///.../app/
const APP_DIR = fileURLToPath(APP);                          // native path

// Phase 7 — mount the REAL functions/_routes/media.js + inventory.js against a
// fake Hono app, a D1 shim over node:sqlite, and an in-memory R2 shim. Also
// unit-test _lib/mailer.js and _lib/uploads.js directly. No EMAIL binding, so
// the mailer takes its console-stub path (cloudflare:email is never imported).
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
process.chdir(APP_DIR);

const sdb = new DatabaseSync(':memory:');
sdb.exec('PRAGMA foreign_keys=ON;');
for (const f of fs.readdirSync('migrations').filter((x) => /^\d+.*\.sql$/.test(x)).sort()) {
  try { sdb.exec(fs.readFileSync('migrations/' + f, 'utf8')); }
  catch (e) { console.log('MIGRATION FAIL', f, e.message.split('\n')[0]); process.exit(1); }
}
console.log('migrations 0001-0019 OK');

// ---- D1 shim ----
function makeDB(db) {
  return {
    prepare(sql) {
      return {
        _sql: sql, _b: [],
        bind(...b) { this._b = b; return this; },
        all() { return { results: db.prepare(this._sql).all(...this._b) }; },
        first() { const r = db.prepare(this._sql).get(...this._b); return r === undefined ? null : r; },
        run() { const r = db.prepare(this._sql).run(...this._b); return { success: true, meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } }; },
      };
    },
    async batch(stmts) { const out = []; for (const s of stmts) out.push(s.run()); return out; },
  };
}
// ---- R2 shim ----
function makeR2() {
  const m = new Map();
  return {
    _m: m,
    async put(key, val, opts) { m.set(key, { body: val, httpMetadata: (opts && opts.httpMetadata) || {} }); return { key }; },
    async get(key) { const o = m.get(key); if (!o) return null; return { body: o.body, httpMetadata: o.httpMetadata, httpEtag: '"e"' }; },
    async delete(key) { m.delete(key); },
  };
}
const R2 = makeR2();
const ENV = { DB: makeDB(sdb), UPLOADS: R2, EMAIL_FROM: 'Morty\'s Auto Parts <noreply@mortysautoparts.com>' };

// ---- fake Hono ----
const routes = [];
const app = {};
for (const verb of ['get', 'post', 'patch', 'delete', 'put']) app[verb] = (path, ...rest) => routes.push({ verb, path, handler: rest[rest.length - 1] });
for (const m of ['media', 'inventory']) (await import(APP + 'functions/_routes/' + m + '.js')).default(app);
console.log('mounted', routes.length, 'routes');

function toRe(path) {
  // supports :p and :p{.+}
  return new RegExp('^' + path.replace(/:[A-Za-z_]+\{([^}]+)\}/g, '($1)').replace(/:[A-Za-z_]+/g, '([^/]+)') + '$');
}
function paramNames(path) { return (path.match(/:([A-Za-z_]+)/g) || []).map((s) => s.slice(1)); }
function match(verb, url) {
  const [pathOnly, qs] = url.split('?');
  const query = Object.fromEntries(new URLSearchParams(qs || ''));
  for (const r of routes) {
    if (r.verb !== verb) continue;
    const mm = toRe(r.path).exec(pathOnly);
    if (!mm) continue;
    const names = paramNames(r.path); const params = {};
    names.forEach((n, i) => { params[n] = decodeURIComponent(mm[i + 1]); });
    return { r, params, query };
  }
  return null;
}

const USER = { id: 301, is_admin: 1, admin_role: 'owner', perms: '{}' };
let lastStatus = 200;
async function call(verb, url, { body, form, headers } = {}) {
  const m = match(verb, url);
  if (!m) throw new Error('no route for ' + verb + ' ' + url);
  lastStatus = 200;
  const hdr = {}; for (const k in (headers || {})) hdr[k.toLowerCase()] = headers[k];
  const c = {
    env: ENV,
    get: (k) => (k === 'user' ? USER : undefined),
    req: {
      param: (n) => m.params[n],
      query: (n) => (n == null ? m.query : m.query[n]),
      header: (n) => hdr[n.toLowerCase()],
      json: async () => body || {},
      parseBody: async () => form || {},
    },
    json: (obj, status) => { if (status) lastStatus = status; return { _json: obj, status: status || 200 }; },
    body: (data, status, h) => { if (status) lastStatus = status; return { _body: data, status: status || 200, hdrs: h }; },
  };
  const res = await m.r.handler(c);
  return res && res._json !== undefined ? res._json : res;
}

const A = (label, cond) => console.log((cond ? 'PASS  ' : 'FAIL  ') + label);
const q1 = (sql, ...p) => sdb.prepare(sql).get(...p);
const MP = { 'content-type': 'multipart/form-data; boundary=xx' };
const mkFile = (name, type, str) => { const b = Buffer.from(str); return { name, type, size: b.length, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }; };

// ================= _lib/mailer.js =================
const mailer = await import(APP + 'functions/_lib/mailer.js');
const wt = mailer.templates.welcomeEmail({ name: 'Sam' });
A('welcome template: subject + greeting', /Welcome/.test(wt.subject) && wt.html.includes('Hi Sam,') && wt.text.includes('Hi Sam,'));
const ot = mailer.templates.orderEmail({ name: 'Sam', orderId: 42, items: [{ name: 'Pad', make_model: 'Civic', qty: 2, price_usd: 19 }], total: 38 });
A('order template renders line + total', ot.subject === 'Order #42 confirmed' && ot.html.includes('&times; 2') && ot.html.includes('$38.00'));
let threw = false;
try { await mailer.sendEmail(ENV, { subject: 'x' }); } catch { threw = true; }
A('sendEmail rejects missing "to"', threw);
const st = await mailer.sendEmail(null, { to: 'a@b.com', subject: 'Hi', text: 'line1\nline2' });
A('sendEmail without binding -> console stub', st && st.stubbed === true);

// ================= _lib/uploads.js =================
const up = await import(APP + 'functions/_lib/uploads.js');
let e501 = null;
try { await up.putUpload({}, { prefix: 'x', bytes: new Uint8Array([1]), contentType: 'image/png' }); } catch (err) { e501 = err; }
A('putUpload without R2 -> userFacing 501', e501 && e501.userFacing && e501.status === 501);
const put1 = await up.putUpload(ENV, { prefix: 'products', bytes: new Uint8Array([1, 2, 3]), contentType: 'image/png', filename: 'shot.PNG' });
A('putUpload -> key/url, ext from filename', /^products\/\d+-[a-z0-9]+\.png$/.test(put1.key) && put1.url === '/uploads/' + put1.key);
const got1 = await up.getUpload(ENV, put1.key);
A('getUpload round-trips bytes + content-type', got1 && got1.httpMetadata.contentType === 'image/png');

// ================= media routes =================
// seed
sdb.exec(`
INSERT INTO users (id,email,name,password_hash,is_admin,admin_role) VALUES (301,'boss@x.com','Boss','h',1,'owner');
INSERT INTO products (img,name,make_model,category,condition,price_cents,stock_count,low_threshold,is_active) VALUES
 ('prod-a','ZZ Alternator','ZZ Civic','Electrical','NEW',12000,3,4,1),
 ('prod-b','ZZ Starter','ZZ Accord','Electrical','NEW',9000,0,4,1);
INSERT INTO inspections (id,kind,status) VALUES (77,'service','in_progress');
INSERT INTO notify_subscriptions (product_img,email,notified_at) VALUES
 ('prod-a','wants-a@x.com',NULL),
 ('prod-b','wants-b@x.com',NULL);
`);

// ---- logo upload ----
let r = await call('post', '/api/admin/settings/logo', { headers: MP, form: { logo: mkFile('logo.png', 'image/png', 'PNGDATA') } });
A('logo upload -> url + shop_settings.logo_url set', /^\/uploads\/logo\/\d+-/.test(r.logo_url) && q1('SELECT logo_url FROM shop_settings ORDER BY id LIMIT 1').logo_url === r.logo_url);
const logoKey = r.logo_url.replace('/uploads/', '');
A('logo bytes actually landed in R2', R2._m.has(logoKey));

// ---- serve it back ----
r = await call('get', '/uploads/' + logoKey);
A('GET /uploads/* serves bytes + content-type + cache', Buffer.from(r._body).toString() === 'PNGDATA' && r.hdrs['Content-Type'] === 'image/png' && /max-age=604800/.test(r.hdrs['Cache-Control']));
r = await call('get', '/uploads/nope/missing.png');
A('GET /uploads/* 404 for unknown key', lastStatus === 404);

// ---- product photo via upload ----
r = await call('post', '/api/admin/products-photo', { headers: MP, form: { photo: mkFile('a.jpg', 'image/jpeg', 'JPGDATA'), product_img: 'prod-a' } });
A('products-photo upload -> url + warehouse_activity logged', /^\/uploads\/products\//.test(r.photo_url) && q1("SELECT COUNT(*) n FROM warehouse_activity WHERE kind='photo_update' AND product_img='prod-a'").n === 1);
// ---- product photo via URL (JSON body, no file) ----
r = await call('post', '/api/admin/products-photo', { body: { product_img: 'prod-a', url: 'https://cdn.example/x.jpg' } });
A('products-photo url path (JSON body)', r.photo_url === 'https://cdn.example/x.jpg');
r = await call('post', '/api/admin/products-photo', { body: {} });
A('products-photo requires product_img', lastStatus === 400);

// ---- inspection photo ----
r = await call('post', '/api/admin/inspections/77/photos', { headers: MP, form: { photo: mkFile('dent.jpg', 'image/jpeg', 'DENT'), caption: 'front bumper', annotations: '[{"x":1}]' } });
A('inspection photo -> row inserted w/ annotations', /^\/uploads\/inspections\//.test(r.photo_path) && q1('SELECT caption,annotations FROM inspection_photos WHERE inspection_id=77').annotations === '[{"x":1}]');

// ---- product create with photo (inventory.js, Phase 6 handler now R2-aware) ----
r = await call('post', '/api/admin/products', { headers: MP, form: { photo: mkFile('new.jpg', 'image/jpeg', 'NEWPART'), name: 'ZZ Coil Pack', category: 'Electrical', price_usd: 55, stock_count: 8 } });
A('product create stores photo in R2 and rows the product', /^\/uploads\/products\//.test(r.img) && q1('SELECT price_cents,stock_count FROM products WHERE img=?', r.img).price_cents === 5500);
// still works with a plain img URL / JSON body
r = await call('post', '/api/admin/products', { body: { img: 'ext-url-1', name: 'ZZ Relay', category: 'Electrical' } });
A('product create still accepts img URL (JSON)', r.ok && r.img === 'ext-url-1');

// ---- product create when R2 is OFF -> clean 501 ----
const noR2 = { ...ENV, UPLOADS: undefined };
{
  const m = match('post', '/api/admin/products');
  const c = {
    env: noR2, get: () => USER,
    req: { param: () => undefined, query: () => undefined, header: (n) => MP[n.toLowerCase()], json: async () => ({}), parseBody: async () => ({ photo: mkFile('x.jpg', 'image/jpeg', 'X'), name: 'N', category: 'C' }) },
    json: (o, s) => { lastStatus = s || 200; return { _json: o }; }, body: () => ({}),
  };
  const res = await m.r.handler(c);
  A('product create w/ photo but no R2 -> 501 userFacing', lastStatus === 501 && /R2/.test(res._json.error));
}

// ================= notify-back-in-stock =================
r = await call('post', '/api/admin/notify-back-in-stock');
A('notify-back-in-stock: only in-stock candidate emailed + marked', r.candidates === 1 && r.emails_sent === 1 && r.failed === 0
  && q1("SELECT notified_at FROM notify_subscriptions WHERE email='wants-a@x.com'").notified_at != null
  && q1("SELECT notified_at FROM notify_subscriptions WHERE email='wants-b@x.com'").notified_at == null);
r = await call('post', '/api/admin/notify-back-in-stock');
A('notify-back-in-stock: nothing left to send on re-run', r.candidates === 0 && r.emails_sent === 0);

console.log('\ndone');
