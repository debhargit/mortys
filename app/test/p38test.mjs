// Website visitor tracking (functions/_lib/visits.js) and website management
// for the till (functions/_routes/sitemgmt.js, signed by site-manage.js).
// D1 is SQLite, so node:sqlite stands in for it with D1's prepare/bind shape.
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const APP = new URL('../', import.meta.url).href;
const { onRequest } = await import(APP + 'functions/[[path]].js');
const { sessionCookie } = await import(APP + 'functions/_lib/session.js');
const { siteSignature } = require('../site-manage.js');
const { DatabaseSync } = await import('node:sqlite');

const sq = new DatabaseSync(':memory:');
const stmt = (sql, binds = []) => ({
  bind: (...b) => stmt(sql, b),
  all: async () => ({ results: sq.prepare(sql).all(...binds).map((r) => ({ ...r })), success: true }),
  first: async () => { const r = sq.prepare(sql).get(...binds); return r ? { ...r } : null; },
  run: async () => { const r = sq.prepare(sql).run(...binds); return { success: true, meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } }; },
});
const DB = { prepare: (sql) => stmt(sql), batch: async (l) => Promise.all(l.map((s) => s.run())) };
sq.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, name TEXT, phone TEXT, via TEXT, is_admin INTEGER NOT NULL DEFAULT 0,
  admin_role TEXT NOT NULL DEFAULT 'manager', disabled INTEGER NOT NULL DEFAULT 0, is_archived INTEGER NOT NULL DEFAULT 0, is_staff INTEGER DEFAULT 0, perms TEXT,
  show_prices INTEGER, price_tier TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT);
INSERT INTO app_config (key, value) VALUES ('session_epoch', '0');
INSERT INTO users (email, name, is_admin, admin_role) VALUES ('owner@test.local', 'Owner', 1, 'owner'), ('staff@test.local', 'Staff', 1, 'cashier');
INSERT INTO users (email, name, is_admin) VALUES ('c1@test.local', 'Customer One', 0);`);
sq.exec(fs.readFileSync(new URL('../migrations/0068_site_visits.sql', import.meta.url), 'utf8'));

const SECRET = 'p38-secret';
const ENV = { DB, TILL_GATEWAY_SECRET: SECRET, SESSION_SECRET: 'p38-session', COOKIE_SECURE: 'false' };
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const PAGE = () => new Response('<!doctype html><html><body><h1>page</h1></body></html>', { headers: { 'content-type': 'text/html' } });
let n = 0, bad = 0;
const A = (label, ok, extra) => { n++; if (!ok) bad++; console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || extra === undefined ? '' : '  -> ' + JSON.stringify(extra).slice(0, 400))); };
const rows = (q) => sq.prepare(q).all().map((r) => ({ ...r }));
async function get(path, headers = {}) {
  const jobs = [];
  const r = await onRequest({ request: new Request('https://mortsautoparts.com' + path, { headers }), env: ENV, waitUntil: (p) => jobs.push(p), next: PAGE });
  await Promise.all(jobs);
  return r;
}
async function signed(method, pq, body, opt = {}) {
  const ts = String(opt.ts || Date.now()), email = 'mgr@test.local';
  const b = method === 'GET' ? '' : JSON.stringify(body || {});
  const sig = siteSignature(opt.secret || SECRET, ts, method, pq, email, opt.signBody != null ? opt.signBody : b);
  const r = await onRequest({ request: new Request('https://mortsautoparts.com' + pq, { method, headers: { 'x-vision-site-ts': ts, 'x-vision-site-user': email, 'x-vision-site-sig': sig, 'content-type': 'application/json' }, body: b || undefined }), env: ENV, waitUntil: () => {}, next: PAGE });
  return { status: r.status, body: await r.json().catch(() => null) };
}

let r = await get('/index.html', { 'user-agent': UA, referer: 'https://www.google.com/search?q=x', 'cf-connecting-ip': '1.2.3.4' });
const html = await r.text();
const vv = (r.headers.get('set-cookie') || '').match(/vv=([^;]+)/);
A('first visit: visitor cookie set', !!vv);
A('page intact, beacon added before </body>', /<h1>page<\/h1>/.test(html) && /sendBeacon\("\/api\/visit"/.test(html));
let v = rows('SELECT * FROM site_visits');
A('page view written: public, desktop Chrome, from google, address hashed', v.length === 1 && v[0].area === 'public' && v[0].browser === 'Chrome' && v[0].referrer === 'www.google.com/search' && v[0].ip_hash && !v[0].ip_hash.includes('1.2.3.4'), v);
r = await get('/shop.html', { 'user-agent': UA, cookie: 'vv=' + vv[1] });
A('returning visitor keeps their cookie', !(r.headers.get('set-cookie') || '').includes('vv='));
const staff = (await sessionCookie(ENV, { userId: 2, epoch: 0 })).split(';')[0];
await (await get('/admin.html', { 'user-agent': UA, cookie: staff + '; vv=staff0000001' })).text();
v = rows("SELECT * FROM site_visits WHERE path = '/admin.html'");
A('staff page view: admin side, account 2', v.length === 1 && v[0].area === 'admin' && v[0].user_id === 2, v);
await (await get('/admin.html', { 'user-agent': UA, cookie: staff.replace(/\.[^.]+$/, '.AAAA') + '; vv=forger000001' })).text();
A('forged session not taken as the account', rows("SELECT user_id FROM site_visits WHERE visitor = 'forger000001'")[0].user_id === null);
await (await get('/', { 'user-agent': 'Googlebot/2.1' })).text();
A('search engine marked as a bot', rows('SELECT * FROM site_visits WHERE bot = 1').length === 1);
const rp = await get('/payables.html', { 'user-agent': UA });
A('till page without TILL_ORIGIN still served (tracking never blocks a page)', rp.status === 200);
const jobs = [];
r = await onRequest({ request: new Request('https://mortsautoparts.com/api/visit', { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': UA, cookie: staff, origin: 'https://mortsautoparts.com' }, body: JSON.stringify({ p: '/admin.html', h: '#tab=pos' }) }), env: ENV, waitUntil: (p) => jobs.push(p), next: PAGE });
await Promise.all(jobs);
A('beacon records a move inside a page', r.status === 204 && rows("SELECT * FROM site_visits WHERE kind = 'nav' AND hash = '#tab=pos' AND user_id = 2").length === 1);
r = await onRequest({ request: new Request('https://mortsautoparts.com/api/visit', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ p: '/spam' }) }), env: ENV, waitUntil: () => {}, next: PAGE });
A('beacon from another site ignored', rows("SELECT * FROM site_visits WHERE path = '/spam'").length === 0);

r = await signed('GET', '/api/sitemgmt/summary?days=7', null, { secret: 'wrong' });
A('management: wrong secret refused', r.status === 401, r);
r = await signed('GET', '/api/sitemgmt/summary?days=7', null, { ts: Date.now() - 120000 });
A('management: old signature refused', r.status === 401, r);
r = await signed('POST', '/api/sitemgmt/users/3', { action: 'disable' }, { signBody: '{"action":"enable"}' });
A('management: body changed after signing refused', r.status === 401, r);
r = await signed('GET', '/api/sitemgmt/summary?days=7');
A('summary: shop front and back office counted apart, bot left out', r.status === 200 && r.body.totals.find((t) => t.area === 'public').views === 2 && r.body.totals.find((t) => t.area === 'admin').views === 4 && r.body.bot_views === 1, r.body);
r = await signed('GET', '/api/sitemgmt/visits?user_id=2');
A('visits for one account', r.status === 200 && r.body.visits.length === 2 && r.body.visits[0].name === 'Staff', r.body);
r = await signed('GET', '/api/sitemgmt/users?kind=admin');
A('back office accounts listed apart from customers', r.status === 200 && r.body.total === 2, r.body);
r = await signed('POST', '/api/sitemgmt/users/3', { action: 'disable' });
A('disable a customer', r.status === 200 && rows('SELECT disabled FROM users WHERE id = 3')[0].disabled === 1, r);
r = await signed('POST', '/api/sitemgmt/users/1', { action: 'disable' });
A('the owner cannot be disabled from the till', r.status === 403, r);
r = await signed('POST', '/api/sitemgmt/users/2', { action: 'remove_admin' });
A('remove back office access', r.status === 200 && rows('SELECT is_admin FROM users WHERE id = 2')[0].is_admin === 0, r);
r = await signed('POST', '/api/sitemgmt/signout-all', {});
A('sign everyone out moves the session epoch', r.status === 200 && rows("SELECT value FROM app_config WHERE key = 'session_epoch'")[0].value === '1', r);
r = await onRequest({ request: new Request('https://mortsautoparts.com/api/sitemgmt/summary'), env: Object.assign({}, ENV, { TILL_GATEWAY_SECRET: '' }), waitUntil: () => {}, next: PAGE });
A('no shared secret: management is not there', r.status === 404, r.status);

console.log(n + ' checks');
if (bad) process.exitCode = 1;
