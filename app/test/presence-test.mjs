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
console.log('migrations 0001-0026 OK');
// admin_presence table exists?
const cols = sdb.prepare("PRAGMA table_info(admin_presence)").all().map((r) => r.name);
console.log('admin_presence cols:', cols.join(','));

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
(await import(APP + 'functions/_routes/admin_misc.js')).default(app);

function toRe(p) { return new RegExp('^' + p.replace(/:[A-Za-z_]+/g, '([^/]+)') + '$'); }
function pn(p) { return (p.match(/:([A-Za-z_]+)/g) || []).map((s) => s.slice(1)); }
function match(v, url) { const [p, qs] = url.split('?'); const query = Object.fromEntries(new URLSearchParams(qs || ''));
  for (const r of routes) { if (r.v !== v) continue; const m = toRe(r.p).exec(p); if (!m) continue;
    const params = {}; pn(r.p).forEach((n, i) => params[n] = decodeURIComponent(m[i + 1])); return { r, params, query }; } return null; }
let USER = { id: 800, name: 'Owner O', email: 'o@x.com', is_admin: 1, admin_role: 'owner' };
let st = 200;
async function call(v, url, { body, headers } = {}) {
  const m = match(v, url); if (!m) throw new Error('no route ' + v + ' ' + url); st = 200;
  const hdr = headers || {};
  const c = { env: ENV, executionCtx: { waitUntil() {} }, get: () => USER,
    req: { param: (n) => m.params[n], query: (n) => (n == null ? m.query : m.query[n]),
      header: (n) => hdr[n] ?? hdr[String(n).toLowerCase()] ?? undefined,
      raw: { headers: { get: () => null } },
      json: async () => body || {} },
    json: (o, s) => { if (s) st = s; return { _json: o }; } };
  const r = await m.r.h(c); return r && r._json !== undefined ? r._json : r;
}
const A = (l, ok) => { console.log((ok ? 'PASS  ' : 'FAIL  ') + l); if (!ok) process.exitCode = 1; };
const q1 = (s, ...p) => sdb.prepare(s).get(...p);

sdb.exec(`INSERT INTO users (id,email,name,password_hash,is_admin,admin_role,created_at) VALUES
 (800,'o@x.com','Owner O','h',1,'owner',datetime('now')),
 (801,'m@x.com','Manny M','h',1,'manager',datetime('now'));`);

let n = 0;
// 1. first beat from terminal A -> online:1, is_self true
let r = await call('post', '/api/admin/presence', { body: { terminal_id: 'T-aaa', label: 'Till AAA' }, headers: { 'CF-Connecting-IP': '1.2.3.4', 'User-Agent': 'jsdom' } });
n++; A('first beat ok + online=1', r.ok === true && r.online === 1);
n++; A('  terminal row persisted w/ user + ip + ua', (() => { const row = q1("SELECT * FROM admin_presence WHERE terminal_id='T-aaa'"); return row && row.user_id === 800 && row.user_name === 'Owner O' && row.ip === '1.2.3.4' && row.user_agent === 'jsdom' && row.label === 'Till AAA'; })());
n++; A('  self flagged in terminals[]', Array.isArray(r.terminals) && r.terminals[0].is_self === true);

// 2. second terminal, different user
USER = { id: 801, name: 'Manny M', email: 'm@x.com', is_admin: 1, admin_role: 'manager' };
r = await call('post', '/api/admin/presence', { body: { terminal_id: 'T-bbb', label: 'Till BBB' } });
n++; A('second terminal -> online=2', r.online === 2);

// 3. re-beat T-aaa: still 2 distinct, first_seen unchanged, last_seen bumped
const before = q1("SELECT first_seen,last_seen FROM admin_presence WHERE terminal_id='T-aaa'");
await new Promise((z) => setTimeout(z, 1100));
r = await call('post', '/api/admin/presence', { body: { terminal_id: 'T-aaa' } });  // no label this time
n++; A('re-beat keeps count at 2 (no dup rows)', r.online === 2);
const after = q1("SELECT first_seen,last_seen,label FROM admin_presence WHERE terminal_id='T-aaa'");
n++; A('  first_seen preserved on upsert', after.first_seen === before.first_seen);
n++; A('  last_seen advanced on upsert', after.last_seen >= before.last_seen);
n++; A('  label kept when beat omits it (COALESCE)', after.label === 'Till AAA');

// 4. stale terminal drops out of the count
sdb.prepare("UPDATE admin_presence SET last_seen = datetime('now','-10 minutes') WHERE terminal_id='T-bbb'").run();
r = await call('get', '/api/admin/presence?terminal_id=T-aaa');
n++; A('GET presence: stale terminal excluded -> online=1', r.online === 1);
n++; A('  GET reflects self flag from query param', r.terminals[0].terminal_id === 'T-aaa' && r.terminals[0].is_self === true);

// 5. prune removes >1d-old rows on write
sdb.prepare("UPDATE admin_presence SET last_seen = datetime('now','-2 days') WHERE terminal_id='T-bbb'").run();
r = await call('post', '/api/admin/presence', { body: { terminal_id: 'T-aaa' } });
n++; A('day-old row pruned on next beat', q1("SELECT COUNT(*) c FROM admin_presence WHERE terminal_id='T-bbb'").c === 0);

// 6. missing terminal_id -> 400
r = await call('post', '/api/admin/presence', { body: {} });
n++; A('missing terminal_id -> 400', st === 400 && /required/i.test(r.error || ''));

// 7. label + id length clamped
r = await call('post', '/api/admin/presence', { body: { terminal_id: 'X'.repeat(200), label: 'L'.repeat(200) } });
const clamped = q1("SELECT terminal_id,label FROM admin_presence ORDER BY first_seen DESC LIMIT 1");
n++; A('terminal_id clamped to 64, label to 60', clamped.terminal_id.length === 64 && clamped.label.length === 60);

console.log(`\n${n} checks`);
