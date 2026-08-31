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
console.log('migrations 0001-0023 OK');
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
(await import(APP + 'functions/_routes/admin_users.js')).default(app);
console.log('mounted', routes.length);
function toRe(p) { return new RegExp('^' + p.replace(/:[A-Za-z_]+/g, '([^/]+)') + '$'); }
function pn(p) { return (p.match(/:([A-Za-z_]+)/g) || []).map((s) => s.slice(1)); }
function match(v, url) { const [p, qs] = url.split('?'); const query = Object.fromEntries(new URLSearchParams(qs || ''));
  for (const r of routes) { if (r.v !== v) continue; const m = toRe(r.p).exec(p); if (!m) continue;
    const params = {}; pn(r.p).forEach((n, i) => params[n] = decodeURIComponent(m[i + 1])); return { r, params, query }; } return null; }
let ACT = { id: 900, admin_role: 'owner' };
let st = 200;
async function call(v, url, body) {
  const m = match(v, url); if (!m) throw new Error('no route ' + v + ' ' + url); st = 200;
  const c = { env: ENV, executionCtx: { waitUntil() {} }, get: () => ACT,
    req: { param: (n) => m.params[n], query: (n) => (n == null ? m.query : m.query[n]), header: () => undefined, json: async () => body || {} },
    json: (o, s) => { if (s) st = s; return { _json: o }; } };
  const r = await m.r.h(c); return r && r._json !== undefined ? r._json : r;
}
const A = (l, ok) => console.log((ok ? 'PASS  ' : 'FAIL  ') + l);
const q1 = (s, ...p) => sdb.prepare(s).get(...p);

sdb.exec(`
INSERT INTO users (id,email,name,password_hash,is_admin,admin_role,is_staff) VALUES
 (900,'owner@x.com','Owner','h',1,'owner',1),
 (901,'mgr@x.com','Manny Mgr','h',1,'manager',1),
 (902,'cash@x.com','Cathy Cash','h',1,'cashier',1);
`);
const CAT_MECH = q1("SELECT id FROM user_categories WHERE code='mechanic'").id;
const CAT_ADV = q1("SELECT id FROM user_categories WHERE code='service_advisor'").id;

// ---- customers ----
let r = await call('post', '/api/admin/users', { name: 'Acme Ltd', company_name: 'Acme', customer_type: 'fleet', credit_limit_usd: 5000, price_tier: 'fleet' });
const cid = r.customer.id;
A('customer create: synth email + account no + cents', /@walkin\.melthahonda\.local$/.test(r.customer.email) && /^C-\d{6}$/.test(r.customer.account_number) && q1('SELECT credit_limit_cents c FROM users WHERE id=?', cid).c === 500000);
r = await call('post', '/api/admin/users', { name: 'Dup', account_number: r.customer.account_number });
A('customer create dup account no -> 409', st === 409);
r = await call('get', '/api/admin/users?origin=counter');
A('users list counter origin + counts', r.users.some((u) => u.id === cid) && typeof r.counts.counter === 'number');
r = await call('get', '/api/admin/users/' + cid);
A('user detail: credit_limit_usd + sub-lists + balances', r.user.credit_limit_usd === 5000 && Array.isArray(r.orders) && r.points_balance === 0 && r.account_balance_usd === 0);
await call('patch', '/api/admin/users/' + cid, { discount_pct: 12.5, tax_exempt: true, credit_limit_usd: 8000 });
A('user patch: cents conv + bool', q1('SELECT credit_limit_cents c, tax_exempt t, discount_pct d FROM users WHERE id=?', cid).c === 800000 && q1('SELECT tax_exempt t FROM users WHERE id=?', cid).t === 1);
// delete with no history -> hard delete
r = await call('delete', '/api/admin/users/' + cid);
A('user delete (no history) -> deleted', r.deleted && !q1('SELECT id FROM users WHERE id=?', cid));
// delete with history -> archive
sdb.exec("INSERT INTO users (id,email,name,password_hash) VALUES (950,'hist@x.com','Has History','h'); INSERT INTO orders (user_id,total_cents,status) VALUES (950,1000,'pending')");
r = await call('delete', '/api/admin/users/950');
A('user delete (has orders) -> archived', r.archived && q1('SELECT is_archived a FROM users WHERE id=950').a === 1);
r = await call('delete', '/api/admin/users/901');
A('user delete refuses staff', st === 400);

// ---- points ----
r = await call('post', '/api/admin/points/950', { delta: 200, reason: 'goodwill' });
A('points adjust', r.balance === 200 && q1("SELECT reason FROM points_transactions WHERE user_id=950").reason === 'goodwill');
r = await call('post', '/api/admin/points/950', { delta: 0 });
A('points adjust zero -> 400', st === 400);

// ---- role change guards ----
r = await call('patch', '/api/admin/users/902/role', { admin_role: 'manager' });
A('role change: cashier -> manager (owner acting)', st === 200 && q1('SELECT admin_role r FROM users WHERE id=902').r === 'manager');
ACT = { id: 901, admin_role: 'manager' };
r = await call('patch', '/api/admin/users/902/role', { admin_role: 'owner' });
A('role change: manager cannot grant owner -> 403', st === 403);
r = await call('patch', '/api/admin/users/901/role', { is_admin: false });
A('role change: cannot revoke own admin -> 400', st === 400);
ACT = { id: 900, admin_role: 'owner' };
sdb.exec("UPDATE users SET admin_role='cashier' WHERE id=902");
// last-admin guard: make 902 not admin, then try to demote 901 leaving only 900... 900 still admin so ok. Force scenario:
r = await call('patch', '/api/admin/users/902/role', { is_admin: false });
A('role change: demote non-last admin ok', st === 200 && q1('SELECT is_admin a FROM users WHERE id=902').a === 0);

// ---- perms ----
sdb.exec("UPDATE users SET admin_role='cashier', is_admin=1 WHERE id=902");
r = await call('patch', '/api/admin/users/902/perms', { perms: { 'pos.void_sale': false, 'pos.refund': true, 'bogus.key': false } });
A('user perms: clean tri-state, drop unknown', r.denied['pos.void_sale'] === false && r.denied['pos.refund'] === true && !('bogus.key' in r.denied) && r.perms['pos.void_sale'] === false);
r = await call('patch', '/api/admin/users/901/perms', { perms: { 'pos.refund': false } });
A('user perms: manager target rejected (full access)', st === 400);

// ---- notifications + messages + account-payments ----
r = await call('post', '/api/admin/users/950/notifications', { kind: 'dunning', body: 'Balance overdue' });
A('notification logged', r.ok && q1("SELECT kind FROM customer_notifications WHERE user_id=950").kind === 'dunning');
r = await call('get', '/api/admin/users/950/notifications');
A('notifications list', r.notifications.length === 1);
r = await call('post', '/api/admin/users/950/account-payments', { amount_usd: 40, method: 'cash', reference: 'RCT-1' });
A('account payment recorded (cents)', r.ok && q1('SELECT amount_cents a FROM account_payments WHERE customer_id=950').a === 4000 && r.balance_after_usd === -40 && r.overpaid === true);
r = await call('get', '/api/admin/users/950/account-payments');
A('account payments list + balance', r.payments.length === 1 && r.payments[0].amount_usd === 40 && r.balance_usd === -40);
r = await call('post', '/api/admin/users/950/account-payments', { amount_usd: 5, method: 'crypto' });
A('account payment bad method -> 400', st === 400);
await call('post', '/api/admin/users/950/messages', { body: 'Please call us' });
A('admin message stored w/ staff_id', q1("SELECT sender,staff_id FROM customer_messages WHERE user_id=950").sender === 'staff' && q1("SELECT staff_id FROM customer_messages WHERE user_id=950").staff_id === 900);

// ---- ui-prefs ----
r = await call('post', '/api/admin/me/ui-prefs', { theme: 'dark', density: 'compact' });
A('ui-prefs saved', r.ok && JSON.parse(q1('SELECT ui_prefs p FROM users WHERE id=900').p).theme === 'dark');
r = await call('post', '/api/admin/me/ui-prefs', [1, 2, 3]);
A('ui-prefs rejects non-object', st === 400);

// ---- staff ----
r = await call('post', '/api/admin/staff', { email: 'newmech@x.com', password: 'secret1', name: 'New Mech', admin_role: 'cashier', pin: '4790', categories: [CAT_MECH] });
const sid = r.user.id;
A('staff create + PIN + category + mechanics row', r.ok && q1('SELECT pin_hash h FROM users WHERE id=?', sid).h && q1('SELECT COUNT(*) n FROM user_category_members WHERE user_id=?', sid).n === 1 && q1('SELECT role r FROM mechanics WHERE user_id=?', sid).r === 'mechanic');
r = await call('post', '/api/admin/staff', { email: 'newmech@x.com', password: 'x' });
A('staff create dup email -> 409', st === 409);
r = await call('post', '/api/admin/staff', { email: 'p@x.com', password: 'secret1', pin: '4790' });
A('staff create PIN collision -> 400', st === 400);
await call('patch', '/api/admin/staff/' + sid, { categories: [CAT_MECH, CAT_ADV], phone: '876-1' });
A('staff patch: categories -> role becomes both', q1('SELECT role r FROM mechanics WHERE user_id=?', sid).r === 'both' && q1('SELECT phone p FROM users WHERE id=?', sid).p === '876-1');
r = await call('post', '/api/admin/staff/' + sid + '/pin/reset');
A('staff pin reset returns 4-digit pin', /^\d{4}$/.test(r.pin));
const oldHash = q1('SELECT pin_hash h FROM users WHERE id=?', sid).h;
r = await call('post', '/api/admin/staff/' + sid + '/pin', { clear: true });
A('staff pin clear', r.cleared && q1('SELECT pin_hash h FROM users WHERE id=?', sid).h === null);
r = await call('post', '/api/admin/staff/' + sid + '/password', { password: 'brandnew9' });
A('staff password reset', r.ok && q1('SELECT password_hash h FROM users WHERE id=?', sid).h !== 'h');
r = await call('post', '/api/admin/staff/900/password', { password: 'xxxxxx9' });
A('staff password: cannot reset own -> 400', st === 400);
// pin-verify: set a known pin on 902 then verify
const bcrypt = (await import(APP + 'node_modules/bcryptjs/index.js')).default;
sdb.exec(`UPDATE users SET pin_hash='${bcrypt.hashSync('8642', 10)}', is_staff=1 WHERE id=902`);
r = await call('post', '/api/admin/staff/pin-verify', { pin: '8642', purpose: 'signin' });
A('pin-verify: matches staff 902', r.ok && r.user.id === 902);
r = await call('post', '/api/admin/staff/pin-verify', { pin: '0001' });
A('pin-verify: no match -> 401', st === 401);

// ---- roles ----
r = await call('post', '/api/admin/roles', { label: 'Parts Clerk', can_manage: false });
A('role create (owner) w/ derived code', r.ok && r.role.code === 'parts_clerk');
r = await call('patch', '/api/admin/roles/parts_clerk', { label: 'Parts Desk', can_manage: true });
A('role patch', q1("SELECT label l, can_manage m FROM roles WHERE code='parts_clerk'").l === 'Parts Desk' && q1("SELECT can_manage m FROM roles WHERE code='parts_clerk'").m === 1);
r = await call('patch', '/api/admin/roles/owner', {});
A('role patch: owner refused', st === 400);
r = await call('delete', '/api/admin/roles/parts_clerk');
A('role delete (unheld)', !q1("SELECT code FROM roles WHERE code='parts_clerk'"));
r = await call('delete', '/api/admin/roles/manager');
A('role delete: built-in refused', st === 400);

// ---- user categories ----
r = await call('post', '/api/admin/user-categories', { label: 'Tyre Fitter' });
const ucid = r.category.id;
A('user-category create derived code', r.ok && r.category.code === 'tyre_fitter');
await call('patch', '/api/admin/user-categories/' + ucid, { label: 'Tyre Bay', sort_order: 30 });
A('user-category patch', q1('SELECT label l, sort_order s FROM user_categories WHERE id=?', ucid).l === 'Tyre Bay');
r = await call('patch', '/api/admin/user-categories/' + ucid + '/perms', { perms: { 'pos.void_sale': false, 'pos.refund': true } });
A('user-category perms: only false kept', r.perms['pos.void_sale'] === false && !('pos.refund' in r.perms));
r = await call('delete', '/api/admin/user-categories/' + ucid);
A('user-category delete', !q1('SELECT id FROM user_categories WHERE id=?', ucid));
r = await call('delete', '/api/admin/user-categories/' + CAT_MECH);
A('user-category delete: is_system refused', st === 400);

console.log('\ndone');
