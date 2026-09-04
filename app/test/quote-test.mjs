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
console.log('migrations 0001-0027 OK');

function makeDB(db) {
  return { prepare(sql) { return { _sql: sql, _b: [], bind(...b) { this._b = b; return this; },
      all() { return { results: db.prepare(this._sql).all(...this._b) }; },
      first() { const r = db.prepare(this._sql).get(...this._b); return r === undefined ? null : r; },
      run() { const r = db.prepare(this._sql).run(...this._b); return { success: true, meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } }; } }; },
    async batch(s) { const o = []; for (const x of s) o.push(x.run()); return o; } };
}
const ENV = { DB: makeDB(sdb), ORDER_NOTIFY_TO: '', SESSION_SECRET: 'test-secret-quote' };
const { sessionCookie } = await import(APP + 'functions/_lib/session.js');
async function cookieFor(userId) { return (await sessionCookie(ENV, { userId, epoch: 0 })).split(';')[0]; }
const routes = [];
const app = {};
for (const v of ['get', 'post', 'patch', 'delete', 'put']) app[v] = (p, ...r) => routes.push({ v, p, mws: r.slice(0, -1), h: r[r.length - 1] });
for (const mod of ['auth', 'storefront', 'customer', 'shipping', 'admin_crm', 'admin_users']) {
  (await import(APP + 'functions/_routes/' + mod + '.js')).default(app);
}
console.log('mounted', routes.length);

function toRe(p) { return new RegExp('^' + p.replace(/:[A-Za-z_]+/g, '([^/]+)') + '$'); }
function pn(p) { return (p.match(/:([A-Za-z_]+)/g) || []).map((s) => s.slice(1)); }
function match(v, url) {
  const [p, qs] = url.split('?'); const query = Object.fromEntries(new URLSearchParams(qs || ''));
  for (const r of routes) { if (r.v !== v) continue; const m = toRe(r.p).exec(p); if (!m) continue;
    const params = {}; pn(r.p).forEach((n, i) => params[n] = decodeURIComponent(m[i + 1])); return { r, params, query }; }
  return null;
}
let SESSION_USER = null;   // the row currentUser() would return, or null
let st = 200;
async function call(v, url, { body, user, cookie } = {}) {
  const m = match(v, url); if (!m) throw new Error('no route ' + v + ' ' + url); st = 200;
  const ctxUser = user !== undefined ? user : SESSION_USER;
  const headers = new Headers({ 'content-type': 'application/json' });
  if (cookie) headers.set('cookie', cookie);
  const raw = new Request('https://x' + url, { method: v.toUpperCase(), headers });
  const c = {
    env: ENV, executionCtx: { waitUntil() {} },
    get: (k) => (k === 'user' ? ctxUser : undefined),
    req: {
      url: 'https://x' + url, method: v.toUpperCase(),
      param: (n) => m.params[n], query: (n) => (n == null ? m.query : m.query[n]),
      header: (n) => raw.headers.get(n),
      raw, json: async () => body || {},
      parseBody: async () => ({}),
    },
    json: (o, s) => { if (s) st = s; return { _json: o, _status: s || 200 }; },
    body: (d, s) => { st = s || 200; return { _body: d, _status: st }; },
  };
  // guards.currentUser reads the request/session; stub it by intercepting the
  // module via ENV -- simplest is to monkeypatch below. Here we rely on routes
  // that call c.get('user') for auth'd paths; public paths call currentUser().
  const r = await m.r.h(c);
  return r && r._json !== undefined ? r._json : r;
}

// storefront.js + customer.js call currentUser(c.req.raw, c.env) directly for
// optional auth. Patch that module's export to read our SESSION_USER.
const guards = await import(APP + 'functions/_lib/guards.js');
const realCurrent = guards.currentUser;
// can't reassign ESM export; instead the routes import the binding live -- so
// patch via the module namespace is not possible. Work around: the public
// routes we test (products/inquiry/config) use currentUser; give them a DB
// user by seeding a session-less path -- we assert on c.get('user') routes for
// price gating and call the compact endpoint with an explicit approved flag by
// seeding users + relying on cookie. Simpler: test the pure logic paths.

const A = (l, ok) => { console.log((ok ? 'PASS  ' : 'FAIL  ') + l); if (!ok) process.exitCode = 1; };
const q1 = (s, ...p) => sdb.prepare(s).get(...p);

sdb.exec(`
DELETE FROM products WHERE img NOT LIKE 'qz-%';
INSERT INTO products (img,name,make_model,category,condition,price_cents,stock_count,low_threshold,is_active,sku) VALUES
 ('qz-1','QZ Bumper','Civic','body','NEW',4500,7,2,1,'QZ-1'),
 ('qz-2','QZ Grille','Accord','body','NEW',NULL,0,2,1,'QZ-2');`);
// Bulk rows so the compact full-catalogue path (limit way over the 200 the
// grid uses) can be exercised.
{
  const ins = sdb.prepare("INSERT INTO products (img,name,make_model,category,condition,price_cents,stock_count,low_threshold,is_active,sku) VALUES (?,?,?,?,?,?,?,?,?,?)");
  for (let i = 0; i < 600; i++) ins.run('qz-bulk-' + i, 'QZ Bulk ' + i, 'Civic', 'body', 'NEW', null, 1, 2, 1, 'QZB-' + i);
}
sdb.exec(`
INSERT INTO users (id,email,name,phone,password_hash,is_admin,show_prices,created_at) VALUES
 (500,'buyer@x.com','Buyer B','876-555-1000','h',0,0,datetime('now')),
 (501,'approved@x.com','Appro A','876-555-2000','h',0,1,datetime('now')),
 (900,'admin@x.com','Adm',NULL,'h',1,0,datetime('now'));
`);

const ADMIN = { id: 900, is_admin: 1, admin_role: 'owner' };

let n = 0;

// ---- 1. compact products: prices hidden for a guest / un-approved -------
// currentUser() returns null when no session -> canSeePrices false.
let r = await call('get', '/api/products?compact=1&limit=1000');
n++; A('compact returns {cats,rows}', Array.isArray(r.rows) && Array.isArray(r.cats));
const byImg = Object.fromEntries(r.rows.map((row) => [row[0], row]));
n++; A('guest: qz-1 price_cents is null (hidden)', byImg['qz-1'] && byImg['qz-1'][5] === null);
n++; A('guest: prices_visible=false', r.prices_visible === false);
n++; A('row shape [img,name,mm,catIdx,condIdx,price,stock,bin]', byImg['qz-1'][0] === 'qz-1' && byImg['qz-1'][6] === 7);

// ---- 1a. compact honours a large limit (full-catalogue stream) --------
const TOTAL = q1('SELECT COUNT(*) c FROM products WHERE is_active = 1').c;   // 602
r = await call('get', '/api/products?compact=1&limit=4000');
n++; A('compact: limit=4000 honoured (not capped at 200)', r.rows.length === TOTAL && TOTAL > 500);
n++; A('compact: total is the true row count, not the 5000 cap', r.total === TOTAL);
r = await call('get', '/api/products?compact=1&limit=250&offset=100');
n++; A('compact: paginates (limit 250, offset 100)', r.rows.length === 250 && r.offset === 100 && r.total === TOTAL);
r = await call('get', '/api/products?limit=4000');   // non-compact stays capped
n++; A('non-compact still capped at 200', r.products.length === 200);

// ---- 1b. approved customer (real session cookie) SEES prices ----------
const ck501 = await cookieFor(501);
r = await call('get', '/api/products?compact=1&limit=1000', { cookie: ck501 });
const byImg2 = Object.fromEntries(r.rows.map((row) => [row[0], row]));
n++; A('approved: prices_visible=true', r.prices_visible === true);
n++; A('approved: qz-1 price_cents = 4500', byImg2['qz-1'] && byImg2['qz-1'][5] === 4500);
n++; A('approved: qz-2 (no price set) still null', byImg2['qz-2'] && byImg2['qz-2'][5] === null);

// ---- 2. non-compact also strips price for guest ------------------------
r = await call('get', '/api/products?limit=50');
n++; A('non-compact guest: price_usd null', r.products.every((p) => p.price_usd === null) && r.prices_visible === false);

// ---- 3. /api/config: ordering disabled -------------------------------
r = await call('get', '/api/config');
n++; A('config ordering_enabled=false', r.ordering_enabled === false);
n++; A('config payments.methods empty', Array.isArray(r.payments.methods) && r.payments.methods.length === 0);

// ---- 4. /api/checkout is disabled while storefront_prices = 0 ----------
r = await call('post', '/api/checkout', { user: { id: 501, show_prices: 1 }, body: { payment_method: 'cash_pickup' } });
n++; A('/api/checkout -> 400 quote_only (global pricing off)', st === 400 && r.code === 'quote_only');
n++; A('no order rows created', (q1('SELECT COUNT(*) c FROM orders').c) === 0);

// ---- 4a. admin / staff ALWAYS see prices, even with the global flag off ----
const ck900 = await cookieFor(900);   // user 900 is is_admin = 1
r = await call('get', '/api/products?compact=1&limit=1000', { cookie: ck900 });
const admBy = Object.fromEntries(r.rows.map((row) => [row[0], row]));
n++; A('admin session: prices_visible=true despite storefront_prices=0', r.prices_visible === true && admBy['qz-1'][5] === 4500);

// ---- 4b. flip the global switch ON: prices public + checkout works --------
sdb.prepare("UPDATE shop_settings SET storefront_prices = 1 WHERE id = 1").run();
r = await call('get', '/api/config');
n++; A('config: ordering_enabled=true when storefront_prices=1', r.ordering_enabled === true && r.show_prices === true);
n++; A('config: payment methods offered', r.payments.methods.length === 2);
r = await call('get', '/api/products?compact=1&limit=1000');   // guest, no cookie
n++; A('guest now sees prices (global on)', r.prices_visible === true && Object.fromEntries(r.rows.map((x) => [x[0], x]))['qz-1'][5] === 4500);

// a priced cart for user 501, then checkout
sdb.prepare('DELETE FROM cart_items').run();
sdb.prepare("INSERT INTO cart_items (user_id, product_img, qty) VALUES (501,'qz-1',2)").run();
r = await call('post', '/api/checkout', { user: { id: 501, show_prices: 1 }, body: { payment_method: 'cash_pickup' } });
n++; A('/api/checkout -> creates an order when global pricing on', st === 200 && r.order_id > 0 && Math.abs(r.total_usd - 90) < 0.01);
n++; A('order + order_items rows written, cart cleared',
  q1('SELECT COUNT(*) c FROM orders').c === 1 &&
  q1('SELECT COUNT(*) c FROM order_items WHERE order_id = ?', r.order_id).c === 1 &&
  q1('SELECT COUNT(*) c FROM cart_items WHERE user_id = 501').c === 0);

// an unpriced item blocks the order
sdb.prepare("INSERT INTO cart_items (user_id, product_img, qty) VALUES (501,'qz-2',1)").run();
r = await call('post', '/api/checkout', { user: { id: 501 }, body: { payment_method: 'cash_pickup' } });
n++; A('/api/checkout -> 400 when a cart line is unpriced', st === 400 && r.code === 'unpriced_items');

// ---- 4d. shipping: fulfilment + address + fee folded into the total -----
r = await call('get', '/api/config');
n++; A('config: shipping block (parishes + carriers)', r.shipping && Array.isArray(r.shipping.parishes) && r.shipping.parishes.includes('Kingston') && Array.isArray(r.shipping.carriers));

sdb.prepare('DELETE FROM cart_items').run();
sdb.prepare("INSERT INTO cart_items (user_id, product_img, qty) VALUES (501,'qz-1',2)").run();
r = await call('post', '/api/checkout', { user: { id: 501, show_prices: 1 }, body: {
  payment_method: 'bank_transfer', fulfilment: 'delivery',
  ship_name: 'Jane R', ship_phone: '876-555-0000', ship_line1: '5 Hope Rd', ship_parish: 'St. Andrew',
  ship_carrier: 'manual', ship_fee_usd: 15,
} });
n++; A('/api/checkout delivery -> total = merch + shipping fee', st === 200 && Math.abs(r.total_usd - 105) < 0.01 && Math.abs(r.ship_fee_usd - 15) < 0.01 && r.fulfilment === 'delivery');
n++; A('/api/checkout delivery -> ship_* persisted on the order row', (() => {
  const o = q1('SELECT fulfilment, ship_fee_cents, ship_line1, ship_parish, ship_carrier FROM orders WHERE id = ?', r.order_id);
  return o && o.fulfilment === 'delivery' && o.ship_fee_cents === 1500 && o.ship_line1 === '5 Hope Rd' && o.ship_parish === 'St. Andrew' && o.ship_carrier === 'manual';
})());

sdb.prepare("INSERT INTO cart_items (user_id, product_img, qty) VALUES (501,'qz-1',1)").run();
r = await call('post', '/api/checkout', { user: { id: 501, show_prices: 1 }, body: { payment_method: 'cash_pickup', fulfilment: 'delivery', ship_fee_usd: 10 } });
n++; A('/api/checkout delivery without an address -> 400 ship_incomplete', st === 400 && r.code === 'ship_incomplete');
sdb.prepare('DELETE FROM cart_items').run();

// ---- 4e. guest checkout: no session, explicit items, no points ---------
r = await call('post', '/api/checkout/guest', { user: undefined, body: {
  name: 'Walk Up', phone: '876-555-1212', payment_method: 'cash_pickup',
  items: [{ img: 'qz-1', qty: 2 }],
} });
n++; A('/api/checkout/guest -> 200, order for qz-1 x2', st === 200 && r.order_id > 0 && Math.abs(r.total_usd - 90) < 0.01);
n++; A('/api/checkout/guest -> guest order row (user_id NULL, contact + source)', (() => {
  const o = q1('SELECT user_id, customer_name, customer_phone, source, fulfilment FROM orders WHERE id = ?', r.order_id);
  return o && o.user_id === null && o.customer_name === 'Walk Up' && o.customer_phone === '876-555-1212' && o.source === 'storefront' && o.fulfilment === 'pickup';
})());
const guestOrderId = r.order_id;
r = await call('post', '/api/checkout/guest', { user: undefined, body: { name: '', items: [{ img: 'qz-1', qty: 1 }] } });
n++; A('/api/checkout/guest -> 400 without a name', st === 400);

// ---- 4e2. "email me an invoice" payment method ------------------------
sdb.prepare('DELETE FROM cart_items').run();
sdb.prepare("INSERT INTO cart_items (user_id, product_img, qty) VALUES (501,'qz-1',1)").run();
r = await call('post', '/api/checkout', { user: { id: 501, show_prices: 1 }, body: { payment_method: 'invoice_email' } });
n++; A('/api/checkout -> accepts payment_method=invoice_email', st === 200 && r.payment_method === 'invoice_email' &&
  q1('SELECT payment_method FROM orders WHERE id = ?', r.order_id).payment_method === 'invoice_email');
r = await call('post', '/api/checkout/guest', { user: undefined, body: { name: 'No Mail', phone: '876-555-7777', payment_method: 'invoice_email', items: [{ img: 'qz-1', qty: 1 }] } });
n++; A('/api/checkout/guest -> 400 invoice_email without an email', st === 400);
r = await call('post', '/api/checkout/guest', { user: undefined, body: { name: 'Has Mail', email: 'hm@example.com', payment_method: 'invoice_email', items: [{ img: 'qz-1', qty: 1 }] } });
n++; A('/api/checkout/guest -> invoice_email OK with an email', st === 200 && r.payment_method === 'invoice_email');
sdb.prepare('DELETE FROM cart_items').run();

// ---- 4f. /api/orders/:id/print — guest reads their order by contact ----
sdb.prepare("UPDATE orders SET customer_email = 'walkup@example.com' WHERE id = ?").run(guestOrderId);
r = await call('get', '/api/orders/' + guestOrderId + '/print?email=walkup@example.com', { user: undefined });
n++; A('/api/orders/:id/print?email= -> order + items for the guest', st === 200 && r.order && r.order.id === guestOrderId && Array.isArray(r.items) && r.items.length === 1);
r = await call('get', '/api/orders/' + guestOrderId + '/print?email=someone@else.com', { user: undefined });
n++; A('/api/orders/:id/print -> 403 on a wrong email', st === 403);

// ---- 4g. shipping: live rate quote + signed token + booking -------------
sdb.prepare("UPDATE shop_settings SET carrier_knutsford_enabled = 1, carrier_manual_enabled = 1, ship_local_flat_usd = 1200, ship_origin_parish = 'St. Andrew' WHERE id = 1").run();
r = await call('get', '/api/config');
n++; A('config: knutsford + manual in the enabled carrier list', Array.isArray(r.shipping.carriers) && r.shipping.carriers.includes('knutsford') && r.shipping.carriers.includes('manual'));

r = await call('post', '/api/shipping/quote', { user: undefined, body: { parish: 'St. Ann', items: [{ img: 'qz-1', qty: 2 }] } });
n++; A('/api/shipping/quote -> knutsford + manual quotes, each with a token', st === 200 && r.quotes.length >= 2 &&
  r.quotes.some((x) => x.carrier === 'knutsford') && r.quotes.some((x) => x.carrier === 'manual') &&
  r.quotes.every((x) => typeof x.token === 'string' && x.token.includes('.')));
const knut = r.quotes.find((x) => x.carrier === 'knutsford');

r = await call('post', '/api/shipping/quote', { user: undefined, body: { items: [{ img: 'qz-1', qty: 1 }] } });
n++; A('/api/shipping/quote -> 400 without a parish', st === 400);

// checkout trusting the signed quote token: fee + carrier come from the token
sdb.prepare('DELETE FROM cart_items').run();
sdb.prepare("INSERT INTO cart_items (user_id, product_img, qty) VALUES (501,'qz-1',2)").run();
r = await call('post', '/api/checkout', { user: { id: 501, show_prices: 1 }, body: {
  payment_method: 'cash_pickup', fulfilment: 'shipping',
  ship_name: 'Dee', ship_line1: '1 Main St', ship_parish: 'St. Ann',
  ship_carrier: 'manual', ship_fee_usd: 1,          // ignored — token wins
  ship_quote_token: knut.token,
} });
n++; A('/api/checkout -> trusts the quote token (carrier + fee from token, shipment booked)', (() => {
  if (st !== 200) return false;
  const o = q1('SELECT ship_carrier, ship_fee_cents, fulfilment, tracking_number, ship_status FROM orders WHERE id = ?', r.order_id);
  return o && o.ship_carrier === 'knutsford' && o.ship_fee_cents === Math.round(knut.amount * 100) &&
    o.fulfilment === 'shipping' && !!o.tracking_number && o.ship_status === 'booked' &&
    Math.abs(r.total_usd - (90 + knut.amount)) < 0.01;
})());
const shipOrderId = r.order_id;
sdb.prepare("UPDATE orders SET customer_email = 'dee@example.com' WHERE id = ?").run(shipOrderId);

r = await call('get', '/api/orders/' + shipOrderId + '/label?email=dee@example.com', { user: undefined });
n++; A('/api/orders/:id/label -> 404 for a carrier with no label bytes (manual/knutsford)', st === 404);

r = await call('get', '/api/orders/' + shipOrderId + '/tracking?email=dee@example.com', { user: undefined });
n++; A('/api/orders/:id/tracking -> returns the tracking number + a status', st === 200 && r.tracking_number && typeof r.status === 'string');

r = await call('post', '/api/admin/orders/' + shipOrderId + '/ship', { user: { id: 900 } });
n++; A('POST /api/admin/orders/:id/ship -> re-books (ok)', st === 200 && r.ok === true && !!r.tracking_number);

sdb.prepare("UPDATE shop_settings SET carrier_knutsford_enabled = 0, ship_local_flat_usd = 0 WHERE id = 1").run();
sdb.prepare('DELETE FROM cart_items').run();

// ---- 4c. flip back OFF for the rest of the suite -------------------------
sdb.prepare("UPDATE shop_settings SET storefront_prices = 0 WHERE id = 1").run();
sdb.prepare('DELETE FROM cart_items').run();
sdb.prepare('DELETE FROM orders').run();
sdb.prepare('DELETE FROM order_items').run();
sdb.prepare("DELETE FROM points_transactions WHERE reason IN ('purchase','redemption')").run();
r = await call('get', '/api/config');
n++; A('config back to ordering_enabled=false', r.ordering_enabled === false);

// ---- 5. /api/inquiry cart quote request ----------------------------
r = await call('post', '/api/inquiry', {
  user: undefined, // guest
  body: { name: 'Guest G', phone: '876-555-9999', items: [{ img: 'qz-1', qty: 3 }, { img: 'qz-2', qty: 1 }] },
});
n++; A('/api/inquiry cart -> ok + id', r.ok === true && r.id > 0);
const inqRow = q1('SELECT * FROM parts_inquiries WHERE id = ?', r.id);
n++; A('  source=cart, status=new', inqRow.source === 'cart' && inqRow.status === 'new');
const its = JSON.parse(inqRow.items_json);
n++; A('  items_json has 2 lines, unit_price null, list snapshot present', its.length === 2 && its[0].unit_price_cents === null && its[0].list_price_cents === 4500);
n++; A('  part_description summarised', /qz-1|QZ Bumper/.test(inqRow.part_description));

// ---- 6. /api/inquiry form request (no items) ----------------------
r = await call('post', '/api/inquiry', { user: undefined, body: { name: 'Formy', email: 'f@x.com', part_description: 'Left mirror for 2012 CR-V' } });
n++; A('/api/inquiry form -> ok', r.ok === true);
n++; A('  source=form', q1('SELECT source FROM parts_inquiries WHERE id = ?', r.id).source === 'form');

// ---- 7. /api/inquiry validation ---------------------------------
r = await call('post', '/api/inquiry', { user: undefined, body: { phone: '876-1' } });
n++; A('missing name -> 400', st === 400);
r = await call('post', '/api/inquiry', { user: undefined, body: { name: 'X' } });
n++; A('no phone/email -> 400', st === 400);

// ---- 8. admin list shows cart lines + account pricing state -------
const cartInqId = its ? q1("SELECT id FROM parts_inquiries WHERE source='cart' ORDER BY id LIMIT 1").id : null;
// link it to an account so show-prices can work
sdb.prepare('UPDATE parts_inquiries SET user_id = 500 WHERE id = ?').run(cartInqId);
r = await call('get', '/api/admin/inquiries', { user: ADMIN });
const listed = r.inquiries.find((x) => x.id === cartInqId);
n++; A('admin list: has_photo, source, customer_show_prices fields', listed && listed.source === 'cart' && Number(listed.customer_show_prices) === 0);

// ---- 9. admin detail ------------------------------------------
r = await call('get', '/api/admin/inquiries/' + cartInqId, { user: ADMIN });
n++; A('admin detail: items parsed + stock map', r.items.length === 2 && r.stock['qz-1'] && r.stock['qz-1'].stock_count === 7);
n++; A('  no photo_data leaked', !('photo_data' in r.inquiry));

// ---- 10. admin prices the quote --------------------------------
r = await call('patch', '/api/admin/inquiries/' + cartInqId, { user: ADMIN, body: {
  items: [ { img: 'qz-1', name: 'QZ Bumper', qty: 3, unit_price_usd: 50 }, { img: 'qz-2', name: 'QZ Grille', qty: 1, unit_price_usd: 20 } ],
  quote_notes: '3-5 day lead on the grille',
} });
n++; A('patch prices -> ok', r.ok === true);
const priced = q1('SELECT * FROM parts_inquiries WHERE id = ?', cartInqId);
n++; A('  quote_total_cents = 3*5000 + 2000 = 17000', priced.quote_total_cents === 17000);
n++; A('  status auto-moved new -> quoted', priced.status === 'quoted');
n++; A('  priced_at + priced_by stamped', priced.priced_at && priced.priced_by === 900);
n++; A('  quote_notes saved', priced.quote_notes === '3-5 day lead on the grille');

// ---- 11. show-prices toggle ----------------------------------
r = await call('post', '/api/admin/inquiries/' + cartInqId + '/show-prices', { user: ADMIN, body: { enabled: true } });
n++; A('show-prices enable -> ok + show_prices true', r.ok === true && r.show_prices === true);
n++; A('  users.show_prices flipped for user 500', q1('SELECT show_prices FROM users WHERE id=500').show_prices === 1);
r = await call('post', '/api/admin/inquiries/' + cartInqId + '/show-prices', { user: ADMIN, body: { enabled: false } });
n++; A('show-prices disable -> show_prices false', r.show_prices === false && q1('SELECT show_prices FROM users WHERE id=500').show_prices === 0);

// ---- 12. show-prices on a guest (no account) request errors -----
const formInqId = q1("SELECT id FROM parts_inquiries WHERE source='form' ORDER BY id LIMIT 1").id;
r = await call('post', '/api/admin/inquiries/' + formInqId + '/show-prices', { user: ADMIN, body: { enabled: true } });
n++; A('show-prices on account-less request -> 400', st === 400 && /no customer account/i.test(r.error || ''));

// ---- 13. status-only PATCH still works ----------------------
r = await call('patch', '/api/admin/inquiries/' + formInqId, { user: ADMIN, body: { status: 'lost' } });
n++; A('status-only patch still works', r.ok === true && q1('SELECT status FROM parts_inquiries WHERE id=?', formInqId).status === 'lost');

// ---- 14. user PATCH accepts show_prices ---------------------
r = await call('patch', '/api/admin/users/500', { user: ADMIN, body: { show_prices: true } });
n++; A('PATCH /api/admin/users/:id show_prices', q1('SELECT show_prices FROM users WHERE id=500').show_prices === 1);

console.log(`\n${n} checks`);
