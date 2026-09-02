import { fileURLToPath } from 'node:url';
// Portable base: this file lives in app/test/, so app/ is one level up.
const APP = new URL('../', import.meta.url).href;            // file:///.../app/
const APP_DIR = fileURLToPath(APP);                          // native path

// Phase 8 — mount the REAL crm.js + cron.js against a fake Hono app + D1 shim.
// No EMAIL binding -> mailer takes its stub path; ORDER_NOTIFY_TO is set so the
// digests still "send" (and hit the once-a-day throttle).
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
process.chdir(APP_DIR);

const sdb = new DatabaseSync(':memory:');
sdb.exec('PRAGMA foreign_keys=ON;');
for (const f of fs.readdirSync('migrations').filter((x) => /^\d+.*\.sql$/.test(x)).sort()) {
  try { sdb.exec(fs.readFileSync('migrations/' + f, 'utf8')); }
  catch (e) { console.log('MIGRATION FAIL', f, e.message.split('\n')[0]); process.exit(1); }
}
console.log('migrations 0001-0020 OK');

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
const ENV = { DB: makeDB(sdb), ORDER_NOTIFY_TO: 'shop@mortysautoparts.com', CRON_SECRET: 'topsecret' };

const routes = [];
const app = {};
for (const verb of ['get', 'post', 'patch', 'delete', 'put']) app[verb] = (path, ...rest) => routes.push({ verb, path, handler: rest[rest.length - 1] });
for (const m of ['crm', 'cron']) (await import(APP + 'functions/_routes/' + m + '.js')).default(app);
console.log('mounted', routes.length, 'routes');

function toRe(p) { return new RegExp('^' + p.replace(/:[A-Za-z_]+\{([^}]+)\}/g, '($1)').replace(/:[A-Za-z_]+/g, '([^/]+)') + '$'); }
function pnames(p) { return (p.match(/:([A-Za-z_]+)/g) || []).map((s) => s.slice(1)); }
function match(verb, url) {
  const [path, qs] = url.split('?');
  const query = Object.fromEntries(new URLSearchParams(qs || ''));
  for (const r of routes) {
    if (r.verb !== verb) continue;
    const mm = toRe(r.path).exec(path);
    if (!mm) continue;
    const params = {}; pnames(r.path).forEach((n, i) => { params[n] = decodeURIComponent(mm[i + 1]); });
    return { r, params, query };
  }
  return null;
}
const USER = { id: 301, is_admin: 1, admin_role: 'owner', perms: '{}' };
let lastStatus = 200;
async function call(verb, url, { body, headers, env } = {}) {
  const m = match(verb, url);
  if (!m) throw new Error('no route for ' + verb + ' ' + url);
  lastStatus = 200;
  const hdr = {}; for (const k in (headers || {})) hdr[k.toLowerCase()] = headers[k];
  const c = {
    env: env || ENV,
    get: (k) => (k === 'user' ? USER : undefined),
    req: {
      param: (n) => m.params[n], query: (n) => (n == null ? m.query : m.query[n]),
      header: (n) => hdr[n.toLowerCase()], json: async () => body || {},
      parseBody: async () => ({}),
    },
    json: (o, s) => { if (s) lastStatus = s; return { _json: o, status: s || 200 }; },
    body: (d, s, h) => { if (s) lastStatus = s; return { _body: d, status: s || 200, hdrs: h }; },
  };
  const res = await m.r.handler(c);
  return res && res._json !== undefined ? res._json : res;
}
const A = (l, ok) => console.log((ok ? 'PASS  ' : 'FAIL  ') + l);
const q1 = (sql, ...p) => sdb.prepare(sql).get(...p);
const KEY = { authorization: 'Bearer topsecret' };

// ===== seed =====
sdb.exec(`
INSERT INTO users (id,email,name,phone,password_hash,is_admin,admin_role) VALUES
 (301,'boss@x.com','Boss','111','h',1,'owner'),
 (400,'cust1@x.com','Alice Customer','876-1','h',0,'manager'),
 (401,'cust2@x.com','Bob Customer','876-2','h',0,'manager');
INSERT INTO mechanics (id,name,is_active) VALUES (9,'Mickey Mech',1);
INSERT INTO products (img,name,make_model,category,condition,price_cents,stock_count,low_threshold,is_active) VALUES
 ('lp-1','ZZ Low Pad','ZZ Civic','Brakes','NEW',3000,2,4,1),
 ('lp-2','ZZ Out Rotor','ZZ Accord','Brakes','NEW',5000,0,3,1),
 ('lp-3','ZZ Fine Filter','ZZ CRV','Filters','NEW',900,50,4,1),
 ('lp-4','ZZ Inactive','ZZ X','Misc','NEW',100,0,4,0);
INSERT INTO notify_subscriptions (product_img,email,notified_at) VALUES
 ('lp-3','waiting@x.com',NULL),     -- lp-3 in stock -> should email
 ('lp-2','stillwaiting@x.com',NULL); -- lp-2 out of stock -> should NOT
INSERT INTO customer_reminders (user_id,due_date,subject,status) VALUES
 (400,'2020-01-01','Call about brake job','pending'),
 (401,'2020-06-15','Follow up trade-in','pending'),
 (400,'2999-01-01','Future service due','pending'),
 (401,'2020-02-02','Old done one','done');
`);

// ===== crm CRUD =====
let r = await call('post', '/api/admin/users/400/reminders', { body: { subject: 'Oil change reminder', due_date: '2020-03-03', assigned_to: 9 } });
A('reminder create', r.ok && r.id);
const remId = r.id;
r = await call('get', '/api/admin/users/400/reminders');
A('reminder list for user (pending first)', r.reminders.length === 3 && r.reminders[0].status === 'pending' && r.reminders.some((x) => x.assignee_name === 'Mickey Mech'));
r = await call('post', '/api/admin/users/400/reminders', { body: { subject: 'no date' } });
A('reminder create requires subject+due_date', lastStatus === 400);
await call('patch', '/api/admin/reminders/' + remId, { body: { status: 'done' } });
A('reminder patch to done sets done_at', q1('SELECT status,done_at FROM customer_reminders WHERE id=?', remId).done_at != null);
r = await call('get', '/api/admin/reminders/due');
A('reminders/due: only pending & due today', r.reminders.length === 2 && r.reminders.every((x) => x.status === 'pending') && r.reminders[0].due_date === '2020-01-01');
await call('delete', '/api/admin/reminders/' + remId);
A('reminder delete', !q1('SELECT id FROM customer_reminders WHERE id=?', remId));

// ===== cron auth =====
r = await call('post', '/api/cron/back-in-stock', { env: { DB: ENV.DB } });
A('cron 503 when CRON_SECRET unset', lastStatus === 503);
r = await call('post', '/api/cron/back-in-stock', { headers: { authorization: 'Bearer wrong' } });
A('cron 401 on bad key', lastStatus === 401);
r = await call('post', '/api/cron/not-a-job', { headers: KEY });
A('cron 404 on unknown job', lastStatus === 404 && /Unknown job/.test(r.error));

// ===== jobs =====
r = await call('post', '/api/cron/back-in-stock', { headers: KEY });
A('back-in-stock: only the in-stock waiter emailed + marked', r.ok && r.result.candidates === 1 && r.result.emails_sent === 1
  && q1("SELECT notified_at FROM notify_subscriptions WHERE email='waiting@x.com'").notified_at != null
  && q1("SELECT notified_at FROM notify_subscriptions WHERE email='stillwaiting@x.com'").notified_at == null);

r = await call('post', '/api/cron/reminders-digest', { headers: KEY });
A('reminders-digest: 2 due, emailed', r.result.due === 2 && r.result.emailed === true);
r = await call('post', '/api/cron/reminders-digest', { headers: KEY });
A('reminders-digest: throttled on same-day re-run', r.result.emailed === false && /already sent today/.test(r.result.reason));

// the 0006 seed ships ~23k parts, many already low/negative — clear them so the
// digest count reflects only this test's fixtures (the job query is unchanged).
sdb.exec("DELETE FROM products WHERE img NOT LIKE 'lp-%'");
r = await call('post', '/api/cron/low-stock-digest', { headers: KEY });
A('low-stock-digest: lp-1 + lp-2 (not lp-3/lp-4), 1 out of stock', r.result.low === 2 && r.result.out_of_stock === 1 && r.result.emailed === true);
r = await call('post', '/api/cron/low-stock-digest', { headers: KEY });
A('low-stock-digest: throttled on same-day re-run', r.result.emailed === false);

// ===== _all + listing + job_runs =====
r = await call('post', '/api/cron/_all', { headers: KEY });
A('cron _all runs every job', r.ok && r.ran['back-in-stock'] && r.ran['reminders-digest'] && r.ran['low-stock-digest']);
r = await call('get', '/api/cron', { headers: KEY });
A('GET /api/cron lists jobs + last runs', r.jobs.length === 3 && r.last_runs.length === 3 && r.last_runs.every((x) => x.ok === 1));
A('job_runs logged every invocation', q1('SELECT COUNT(*) n FROM job_runs').n >= 8);

// ===== CRON_FORCE bypasses throttle =====
r = await call('post', '/api/cron/low-stock-digest', { headers: KEY, env: { ...ENV, CRON_FORCE: '1' } });
A('CRON_FORCE re-sends despite throttle', r.result.emailed === true);

console.log('\ndone');
