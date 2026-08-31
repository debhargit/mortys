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
console.log('migrations 0001-0022 OK');
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
(await import(APP + 'functions/_routes/admin_crm.js')).default(app);
console.log('mounted', routes.length);
function toRe(p) { return new RegExp('^' + p.replace(/:[A-Za-z_]+/g, '([^/]+)') + '$'); }
function pn(p) { return (p.match(/:([A-Za-z_]+)/g) || []).map((s) => s.slice(1)); }
function match(v, url) { const [p, qs] = url.split('?'); const query = Object.fromEntries(new URLSearchParams(qs || ''));
  for (const r of routes) { if (r.v !== v) continue; const m = toRe(r.p).exec(p); if (!m) continue;
    const params = {}; pn(r.p).forEach((n, i) => params[n] = decodeURIComponent(m[i + 1])); return { r, params, query }; } return null; }
const USER = { id: 900, is_admin: 1, admin_role: 'owner', perms: '{}' };
let st = 200;
async function call(v, url, body) {
  const m = match(v, url); if (!m) throw new Error('no route ' + v + ' ' + url); st = 200;
  const c = { env: ENV, get: () => USER,
    req: { param: (n) => m.params[n], query: (n) => (n == null ? m.query : m.query[n]), json: async () => body || {} },
    json: (o, s) => { if (s) st = s; return { _json: o }; } };
  const r = await m.r.h(c); return r && r._json !== undefined ? r._json : r;
}
const A = (l, ok) => console.log((ok ? 'PASS  ' : 'FAIL  ') + l);
const q1 = (s, ...p) => sdb.prepare(s).get(...p);

sdb.exec(`
INSERT INTO users (id,email,name,phone,password_hash,is_admin,admin_role) VALUES
 (900,'boss@x.com','Boss','111','h',1,'owner'),
 (901,'cust@x.com','Biz Customer','876-555-7777','h',0,'manager');
INSERT INTO parts_inquiries (name,phone,part_description,status) VALUES ('Al','876-1','brake pads','new');
INSERT INTO service_appointments (name,phone,preferred_date,status) VALUES ('Bo','876-2','2026-09-02','pending');
INSERT INTO reviews (user_id,name,rating,body,approved) VALUES (901,'Biz Customer',5,'Great service',0);
INSERT INTO products (img,name,make_model,category,condition,price_cents,stock_count,low_threshold,is_active) VALUES ('nx-1','ZZ Belt','ZZ','Belts','NEW',4000,3,4,1);
INSERT INTO notify_subscriptions (product_img,email) VALUES ('nx-1','w@x.com');
INSERT INTO customer_messages (user_id,sender,body,read_at) VALUES (901,'customer','Hi',NULL),(901,'staff','Hello',NULL);
`);

// inquiries
let r = await call('get', '/api/admin/inquiries');
A('inquiries list', r.inquiries.length === 1 && r.inquiries[0].status === 'new');
await call('patch', '/api/admin/inquiries/1', { status: 'quoted' });
A('inquiry status patched', q1('SELECT status s FROM parts_inquiries WHERE id=1').s === 'quoted');
r = await call('patch', '/api/admin/inquiries/1', { status: 'bogus' });
A('inquiry bad status 400', st === 400);

// appointments
r = await call('get', '/api/admin/appointments');
A('appointments list', r.appointments.length === 1);
await call('patch', '/api/admin/appointments/1', { status: 'confirmed' });
A('appointment confirmed', q1('SELECT status s FROM service_appointments WHERE id=1').s === 'confirmed');
r = await call('get', '/api/admin/appointments/calendar?week=2026-09-02');
A('appointments calendar week', r.week_start === '2026-08-31' && r.appointments.length === 1);

// notifications
r = await call('get', '/api/admin/notifications');
A('notifications list joins product', r.notifications.length === 1 && r.notifications[0].product_name === 'ZZ Belt');

// reviews
r = await call('get', '/api/admin/reviews');
A('reviews list, approved bool', r.reviews.length === 1 && r.reviews[0].approved === false);
await call('patch', '/api/admin/reviews/1', { approved: true });
A('review approved + 50pt award', q1('SELECT approved a FROM reviews WHERE id=1').a === 1 && q1("SELECT COALESCE(SUM(delta),0) b FROM points_transactions WHERE user_id=901 AND reason='review'").b === 50);
await call('patch', '/api/admin/reviews/1', { approved: true });
A('review re-approve does not double-award', q1("SELECT COUNT(*) n FROM points_transactions WHERE reason='review' AND reference_id=1").n === 1);
await call('delete', '/api/admin/reviews/1');
A('review deleted', !q1('SELECT id FROM reviews WHERE id=1'));

// addresses (admin)
r = await call('post', '/api/admin/users/901/addresses', { line1: '1 King St', kind: 'shipping', is_default: true });
const aid = r.id;
await call('post', '/api/admin/users/901/addresses', { line1: '2 Queen St', kind: 'shipping', is_default: true });
A('admin address: 2nd default in same kind unsets 1st', q1('SELECT is_default d FROM customer_addresses WHERE id=?', aid).d === 0);
await call('post', '/api/admin/users/901/addresses', { line1: '3 Bill Rd', kind: 'billing', is_default: true });
A('admin address: billing default independent of shipping', q1("SELECT COUNT(*) n FROM customer_addresses WHERE user_id=901 AND is_default=1").n === 2);
await call('patch', '/api/admin/addresses/' + aid, { is_default: true, city: 'Kingston' });
A('admin address patch re-promotes + edits', q1('SELECT is_default d, city c FROM customer_addresses WHERE id=?', aid).d === 1 && q1('SELECT city c FROM customer_addresses WHERE id=?', aid).c === 'Kingston');
r = await call('get', '/api/admin/users/901/addresses');
A('admin address list', r.addresses.length === 3);
await call('delete', '/api/admin/addresses/' + aid);
A('admin address deleted', q1('SELECT COUNT(*) n FROM customer_addresses WHERE user_id=901').n === 2);

// contacts
r = await call('post', '/api/admin/users/901/contacts', { name: 'Jane Buyer', title: 'AP', is_primary: true });
const cid = r.id;
await call('post', '/api/admin/users/901/contacts', { name: 'John Clerk', is_primary: true });
A('contact: 2nd primary unsets 1st', q1('SELECT is_primary p FROM customer_contacts WHERE id=?', cid).p === 0);
await call('patch', '/api/admin/contacts/' + cid, { phone: '876-999' });
A('contact patched', q1('SELECT phone p FROM customer_contacts WHERE id=?', cid).p === '876-999');
r = await call('get', '/api/admin/users/901/contacts');
A('contacts list primary-first', r.contacts.length === 2 && r.contacts[0].name === 'John Clerk');
await call('delete', '/api/admin/contacts/' + cid);
A('contact deleted', q1('SELECT COUNT(*) n FROM customer_contacts WHERE user_id=901').n === 1);
r = await call('post', '/api/admin/users/901/contacts', {});
A('contact name required', st === 400);

// message inbox
r = await call('get', '/api/admin/messages/inbox');
A('inbox: thread rollup w/ unread + last', r.threads.length === 1 && r.threads[0].unread === 1 && r.threads[0].last_message === 'Hello' && r.threads[0].customer_name === 'Biz Customer');

// coupons
r = await call('post', '/api/admin/coupons', { code: 'welcome15', kind: 'percent', amount: 15, min_subtotal: 20 });
A('coupon created (uppercased)', r.ok && r.code === 'WELCOME15' && q1("SELECT kind FROM coupons WHERE code='WELCOME15'").kind === 'percent');
r = await call('post', '/api/admin/coupons', { code: 'WELCOME15', kind: 'flat', amount: 5 });
A('coupon dup code 400', st === 400);
r = await call('post', '/api/admin/coupons', { code: 'BAD', kind: 'percent', amount: 150 });
A('coupon percent >100 rejected', st === 400);
await call('patch', '/api/admin/coupons/welcome15', { is_active: false, amount: 12 });
A('coupon patched', q1("SELECT is_active a, amount m FROM coupons WHERE code='WELCOME15'").a === 0 && q1("SELECT amount m FROM coupons WHERE code='WELCOME15'").m === 12);
r = await call('get', '/api/admin/coupons');
A('coupon list, is_active bool', r.coupons.some((x) => x.code === 'WELCOME15' && x.is_active === false));
await call('delete', '/api/admin/coupons/welcome15');
A('coupon deleted', !q1("SELECT code FROM coupons WHERE code='WELCOME15'"));

// gift cards
r = await call('post', '/api/admin/gift-cards', { amount_usd: 50, issued_to_name: 'Gift Recipient' });
const gcCode = r.code;
A('gift card issued (GC-XXXX-XXXX) + issue txn', /^GC-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(gcCode) && q1('SELECT balance_cents b FROM gift_cards WHERE code=?', gcCode).b === 5000 && q1("SELECT COUNT(*) n FROM gift_card_transactions WHERE reason='issue'").n === 1);
r = await call('post', '/api/admin/gift-cards/' + gcCode + '/reload', { amount_usd: 25 });
A('gift card reload -> balance 75, txn', r.balance_usd === 75 && q1('SELECT balance_cents b FROM gift_cards WHERE code=?', gcCode).b === 7500);
r = await call('get', '/api/admin/gift-cards/' + gcCode);
A('gift card detail: usd + 2 txns', r.gift_card.balance_usd === 75 && r.transactions.length === 2 && r.gift_card.is_active === true);
r = await call('get', '/api/admin/gift-cards');
A('gift card list joins issuer name', r.gift_cards.length === 1 && r.gift_cards[0].issued_by_name === 'Boss');
await call('patch', '/api/admin/gift-cards/' + gcCode, { is_active: false });
A('gift card deactivated', q1('SELECT is_active a FROM gift_cards WHERE code=?', gcCode).a === 0);
r = await call('post', '/api/admin/gift-cards/' + gcCode + '/reload', { amount_usd: 10 });
A('reload inactive card -> 404', st === 404);
r = await call('patch', '/api/admin/gift-cards/NOSUCH', { is_active: true });
A('patch unknown card -> 404', st === 404);

console.log('\ndone');
