// Sales reps who do not take payment: their ticket is saved as an order and a
// cashier takes payment, against a REAL server and a throwaway Postgres.
// The rep list says who takes payment (so the till saves an order when the
// seller picked does not, whoever is signed in); a sale posted by someone who
// does not take payment is refused; the order is paid at the cashier and the
// sale stays credited to the rep.
//
//   PO_TEST_URL=http://localhost:3392 PO_TEST_PSQL="psql -h 127.0.0.1 -p 5496 -U postgres -d comm" node test/pos-order-route-pg-test.mjs
//
// Refuses the live till's ports, and stops unless the server is writing to
// the database PO_TEST_PSQL points at. Signs in as the default admin.
import { execSync } from 'node:child_process';

const BASE = process.env.PO_TEST_URL || 'http://localhost:3392';
if (/:(3057|3058)\b/.test(BASE)) { console.log('FAIL refusing to run against the live till port'); process.exit(1); }
const PSQL = process.env.PO_TEST_PSQL;
if (!PSQL || /-p\s*5435\b/.test(PSQL)) { console.log('FAIL PO_TEST_PSQL must point at the throwaway database (never port 5435)'); process.exit(1); }
let pass = 0, fails = 0;
const ok = (c, m) => { if (c) { pass++; console.log('PASS ' + m); } else { fails++; console.log('FAIL ' + m); } };
const sql = (q) => execSync(PSQL + ' -tA', { input: q, encoding: 'utf8' }).trim();
function client() {
  const jar = {};
  return async function call(method, url, body) {
    const r = await fetch(BASE + url, { method, headers: Object.assign({ Accept: 'application/json', Cookie: Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ') }, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
    for (const c of r.headers.getSetCookie ? r.headers.getSetCookie() : []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
    return Object.assign({ _status: r.status }, await r.json().catch(() => ({})));
  };
}
const stamp = Date.now().toString(36);
const admin = client();
ok((await admin('POST', '/api/auth/signin', { email: 'admin@mortysautoparts.com', password: 'password123' }))._status === 200, 'admin signs in');
let r = await admin('POST', '/api/admin/groups', { label: 'Probe ' + stamp });
if (sql(`SELECT COUNT(*) FROM user_categories WHERE label = 'Probe ${stamp}'`) !== '1') { console.log('FAIL the server is not writing to the PO_TEST_PSQL database: stopping'); process.exit(1); }
ok(true, 'the server is writing to the throwaway database');
await admin('DELETE', '/api/admin/groups/' + r.id);

const mk = async (name) => {
  const email = name.toLowerCase().replace(/\W+/g, '.') + '.' + stamp + '@example.test';
  const res = await admin('POST', '/api/admin/staff', { email, password: 'Passw0rd!' + stamp, name, admin_role: 'cashier' });
  const id = (res.user || res).id;
  const c = client(); await c('POST', '/api/auth/signin', { email, password: 'Passw0rd!' + stamp });
  return { id, c, name };
};
r = await admin('GET', '/api/admin/groups');
const caps = r;
const allOn = (extra) => Object.assign(Object.fromEntries(caps.capabilities.map((c) => [c.key, !c.restricted])), extra);
const salesRep = r.groups.find((g) => g.code === 'sales_rep'), cashier = r.groups.find((g) => g.code === 'cashier');
const keepRep = sql(`SELECT COALESCE(perms, '{}'::jsonb)::text FROM user_categories WHERE id = ${salesRep.id}`);
const keepCash = sql(`SELECT COALESCE(perms, '{}'::jsonb)::text FROM user_categories WHERE id = ${cashier.id}`);
ok(sql(`SELECT perms->>'pos.finalise_invoice' || '/' || (perms->>'cashier.access') FROM user_categories WHERE code = 'cashier'`) === 'true/true' || keepCash !== '{}', 'the Cashier group takes payment (from schema.sql)');

// Sales reps do not take payment; cashiers do. Carla is in both groups.
await admin('PUT', '/api/admin/groups/' + salesRep.id, { allowed: allOn({ 'pos.finalise_invoice': false, 'cashier.access': false }) });
await admin('PUT', '/api/admin/groups/' + cashier.id, { allowed: allOn({ 'pos.finalise_invoice': true, 'cashier.access': true }) });
const rob = await mk('Rob Rep ' + stamp), carla = await mk('Carla Cashier ' + stamp);
await admin('POST', '/api/admin/groups/' + salesRep.id + '/members', { user_ids: [rob.id, carla.id] });
await admin('POST', '/api/admin/groups/' + cashier.id + '/members', { user_ids: [carla.id] });
sql(`INSERT INTO mechanics (name, is_active, is_freelance, commission_pct) VALUES ('Freelance Fay ${stamp}', true, true, 10)`);

r = await admin('GET', '/api/admin/pos/reps');
const robRep = r.reps.find((x) => x.user_id === rob.id), carlaRep = r.reps.find((x) => x.user_id === carla.id), fay = r.reps.find((x) => x.name === 'Freelance Fay ' + stamp);
ok(robRep && robRep.takes_payment === false, 'the rep list says Rob (Sales rep) does not take payment');
ok(carlaRep && carlaRep.takes_payment === true, '… and Carla (Sales rep and Cashier) does: the Cashier group gives it');
ok(fay && fay.takes_payment === false, '… and a freelance rep never does');
ok(r.reps.filter((x) => x.user_id === 1).every((x) => x.takes_payment === true), '… and the manager does');

// Rob rings up a ticket: a sale is refused, an order is saved.
const img = sql(`SELECT img FROM products WHERE is_active AND price_usd > 0 AND NOT COALESCE(serial_required, false) ORDER BY img LIMIT 1`);
const items = [{ product_img: img, description: 'Brake pads', qty: 1, unit_price_usd: 2500 }];
r = await rob.c('POST', '/api/admin/pos/sale', { items, payment_method: 'cash', amount_tendered: 5000, sales_rep_id: robRep.id, sales_rep_name: rob.name });
ok(r._status === 403 && r.save_as_order === true && /order/.test(r.error), 'Rob cannot ring the sale himself: told to save an order');
r = await rob.c('POST', '/api/admin/pos/sale', { items, payment_method: 'cash', amount_tendered: 5000, dry_run: true });
ok(r._status === 200 && r.ok, '… but the till can still price his ticket (dry run)');
r = await rob.c('POST', '/api/admin/pos/order', { items, sales_rep_id: robRep.id, sales_rep_name: rob.name, customer_name: 'Walk-in ' + stamp });
ok(r._status === 200 && r.ok && r.order_id, 'Rob saves the ticket as an order');
const orderId = r.order_id;

// The cashier picks it up and takes payment.
ok((await rob.c('POST', '/api/admin/pos/orders/' + orderId + '/invoice', { payment_method: 'cash', amount_tendered: 5000 }))._status === 403, 'Rob cannot take payment on it');
r = await carla.c('GET', '/api/admin/pos/orders');
ok(r._status === 200 && r.orders.some((o) => o.id === orderId && o.sales_rep_name === rob.name), 'it is waiting on the Cashier screen, with Rob as the seller');
r = await carla.c('POST', '/api/admin/pos/orders/' + orderId + '/invoice', { payment_method: 'cash', amount_tendered: 5000 });
ok(r._status === 200 && r.ok && r.sale && r.sale.id, 'Carla takes payment');
ok(sql(`SELECT sales_rep_id FROM pos_sales WHERE id = ${r.sale.id}`) === String(robRep.id), 'the sale is credited to Rob (his commission)');
ok(sql(`SELECT status FROM pos_orders WHERE id = ${orderId}`) === 'completed', 'the order is completed');

// Carla can still ring her own sales.
r = await carla.c('POST', '/api/admin/pos/sale', { items, payment_method: 'cash', amount_tendered: 5000, sales_rep_id: carlaRep.id, sales_rep_name: carla.name });
ok(r._status === 200 && r.ok, 'Carla rings her own sale as before');

// Put the groups back as they were.
sql(`UPDATE user_categories SET perms = '${keepRep}'::jsonb WHERE id = ${salesRep.id}; UPDATE user_categories SET perms = '${keepCash}'::jsonb WHERE id = ${cashier.id};
     DELETE FROM user_category_members WHERE user_id IN (${rob.id}, ${carla.id}); UPDATE mechanics SET is_active = false WHERE name = 'Freelance Fay ${stamp}'`);

console.log('\n' + pass + ' passed, ' + fails + ' failed');
process.exit(fails ? 1 : 0);
