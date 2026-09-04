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
console.log('migrations 0001-0025 OK');
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
for (const mod of ['reports', 'admin_misc']) (await import(APP + 'functions/_routes/' + mod + '.js')).default(app);
console.log('mounted', routes.length);
function toRe(p) { return new RegExp('^' + p.replace(/:[A-Za-z_]+/g, '([^/]+)') + '$'); }
function pn(p) { return (p.match(/:([A-Za-z_]+)/g) || []).map((s) => s.slice(1)); }
function match(v, url) { const [p, qs] = url.split('?'); const query = Object.fromEntries(new URLSearchParams(qs || ''));
  for (const r of routes) { if (r.v !== v) continue; const m = toRe(r.p).exec(p); if (!m) continue;
    const params = {}; pn(r.p).forEach((n, i) => params[n] = decodeURIComponent(m[i + 1])); return { r, params, query }; } return null; }
const USER = { id: 800, is_admin: 1, admin_role: 'owner' };
let st = 200;
async function call(v, url, { body, form, cookie } = {}) {
  const m = match(v, url); if (!m) throw new Error('no route ' + v + ' ' + url); st = 200;
  const c = { env: ENV, executionCtx: { waitUntil() {} }, get: () => USER,
    req: { url: 'https://test.local' + url, method: v.toUpperCase(),
      param: (n) => m.params[n], query: (n) => (n == null ? m.query : m.query[n]),
      header: (n) => (n && n.toLowerCase() === 'content-type' && form ? 'multipart/form-data; boundary=x' : (n && n.toLowerCase() === 'cookie' ? (cookie || '') : undefined)),
      raw: { headers: { get: (h) => (h.toLowerCase() === 'cookie' ? (cookie || null) : null) } },
      json: async () => body || {}, parseBody: async () => form || {} },
    json: (o, s) => { if (s) st = s; return { _json: o }; },
    body: (d, s) => { if (s) st = s; return { _body: d, status: s || 200 }; } };
  const r = await m.r.h(c); return r && r._json !== undefined ? r._json : r;
}
const A = (l, ok) => console.log((ok ? 'PASS  ' : 'FAIL  ') + l);
const q1 = (s, ...p) => sdb.prepare(s).get(...p);
const mkFile = (str) => { const b = Buffer.from(str); return { name: 'x.csv', size: b.length, type: 'text/csv', arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }; };

sdb.exec(`
INSERT INTO users (id,email,name,password_hash,is_admin,email_opt_in,price_tier,created_at) VALUES
 (800,'r@x.com','Reporter','h',1,1,'retail',datetime('now')),
 (810,'c1@x.com','Cust One','h',0,1,'fleet',datetime('now'));
INSERT INTO mechanics (id,name,is_active,hourly_rate_cents) VALUES (7,'Mech Seven',1,3000);
INSERT INTO products (img,name,make_model,category,condition,price_cents,cost_cents,stock_count,low_threshold,is_active,sku,barcode) VALUES
 ('r-1','ZZ Widget','ZZ','Gadgets','NEW',2000,1000,5,4,1,'ZZ-W1','999111'),
 ('r-2','ZZ Gizmo','ZZ','Gadgets','NEW',9000,4000,0,4,1,'ZZ-G1','999222');
INSERT INTO pos_sales (id,receipt_number,cashier_name,customer_name,subtotal_cents,discount_cents,tax_cents,total_cents,voided,payment_method,created_at)
 VALUES (1,'R-1','Cathy','Cust One',3000,0,450,3450,0,'cash',datetime('now'));
INSERT INTO pos_sale_items (sale_id,product_img,description,qty,unit_price_cents,total_cents) VALUES (1,'r-1','ZZ Widget',1,2000,2000),(1,'r-2','ZZ Gizmo',1,1000,1000);
INSERT INTO sale_payments (sale_id,method,amount_cents,created_at) VALUES (1,'cash',3450,datetime('now'));
INSERT INTO orders (id,user_id,total_cents,status,payment_method,payment_status,created_at) VALUES (1,810,5000,'pending','cash_pickup','unpaid',datetime('now'));
INSERT INTO order_items (order_id,product_img,qty,price_cents) VALUES (1,'r-1',2,2000);
INSERT INTO work_orders (id,wo_number,customer_name,customer_phone,status,labor_total_cents,parts_total_cents,tax_cents,total_cents,intake_date,paid_at)
 VALUES (1,'WO-2026-0001','WO Cust','876-555-4433','paid',6000,4000,1500,11500,datetime('now'),datetime('now'));
INSERT INTO work_order_labor (work_order_id,mechanic_id,description,hours,rate_cents,total_cents,created_at) VALUES (1,7,'Fix',2,3000,6000,datetime('now'));
INSERT INTO work_order_parts (work_order_id,product_img,description,qty,unit_price_cents,total_cents) VALUES (1,'r-1','ZZ Widget',2,2000,4000);
INSERT INTO work_order_payments (work_order_id,method,amount_cents,received_by,received_at) VALUES (1,'cash',11500,7,datetime('now'));
INSERT INTO purchase_orders (id,po_number,status,total_cents,created_at) VALUES (1,'PO-2026-0001','received',20000,datetime('now'));
INSERT INTO pos_returns (return_number,sale_id,reason,refund_method,refund_cents,refund_tax_cents,created_at) VALUES ('RET-1',1,'defective','cash',1150,150,datetime('now'));
INSERT INTO time_entries (mechanic_id,clocked_in_at,clocked_out_at,hours) VALUES (7,datetime('now','-2 hours'),datetime('now','-1 hours'),1);
INSERT INTO cash_drawer_sessions (id,opened_by,opening_float_cents,opened_at) VALUES (1,7,20000,datetime('now','-3 hours'));
INSERT INTO newsletter_subscribers (email,subscribed_at) VALUES ('n@x.com',datetime('now'));
INSERT INTO points_transactions (user_id,delta,reason,created_at) VALUES (810,100,'signup_bonus',datetime('now'));
`);

// ---- reports ----
let r = await call('get', '/api/admin/analytics');
A('analytics: revenue + top cats', r.revenue_7d === 50 && r.orders_7d === 1 && Array.isArray(r.top_categories) && r.newsletter_subs === 1);
r = await call('get', '/api/admin/reports/sales');
A('reports/sales: totals + tender + net', r.totals.n === 1 && r.totals.total === 34.5 && r.totals.units === 2 && r.by_tender.some((t) => t.method === 'cash' && t.total === 34.5) && r.totals.net_total === 34.5 - 11.5);
r = await call('get', '/api/admin/reports/products');
A('reports/products: top + no-movement', r.top_products.length === 2 && r.no_movement.length >= 0);
r = await call('get', '/api/admin/reports/returns');
A('reports/returns', r.totals.n === 1 && r.totals.total === 11.5 && r.totals.tax === 1.5 && r.by_method[0].method === 'cash');
r = await call('get', '/api/admin/reports/tax');
A('reports/tax: pos + wo - refunded', r.pos.tax === 4.5 && r.work_orders.tax === 15 && r.refunded_tax === 1.5 && r.net_tax === 4.5 + 15 - 1.5);
r = await call('get', '/api/admin/reports/orders');
A('reports/orders', r.totals.n === 1 && r.totals.total === 50 && r.by_status[0].status === 'pending');
r = await call('get', '/api/admin/reports/workorders');
A('reports/workorders: labour/parts/tax/total', r.totals.n === 1 && r.totals.labour === 60 && r.totals.parts === 40 && r.totals.total === 115 && r.by_mechanic[0].mechanic === 'Mech Seven');
r = await call('get', '/api/admin/reports/purchasing');
A('reports/purchasing', r.totals.n >= 1 && r.totals.total >= 200 && typeof r.received.n === 'number');
r = await call('get', '/api/admin/reports/inventory');
A('reports/inventory: valuation + margin + out_of_stock', r.valuation.margin_value === r.valuation.retail_value - r.valuation.cost_value && r.out_of_stock >= 1 && r.by_category.length >= 1);
r = await call('get', '/api/admin/reports/labour');
A('reports/labour: hours', r.totals.hours === 1 && r.by_mechanic[0].mechanic === 'Mech Seven');
r = await call('get', '/api/admin/reports/customers');
A('reports/customers: new + loyalty + newsletter', typeof r.new_customers === 'number' && r.loyalty.earned === 100 && r.newsletter_signups === 1);
r = await call('get', '/api/admin/reports/drawer-sessions');
A('reports/drawer-sessions', Array.isArray(r.sessions) && r.sessions.length === 1 && r.sessions[0].opening_float === 200);

// ---- new reports (supplier / customer-detail / order-ledger / users-staff /
//      setup-config / inventory-custom / warehouse / audit-log) ----
sdb.exec(`
INSERT INTO suppliers (id,name,contact_name,phone,is_active) VALUES (5,'Acme Parts','Al','876-1',1);
UPDATE products SET supplier_id = 5 WHERE img = 'r-1';
UPDATE purchase_orders SET supplier_id = 5, received_date = datetime('now') WHERE id = 1;
INSERT INTO users (id,email,name,password_hash,is_staff,admin_role,employee_no,created_at)
 VALUES (820,'s@x.com','Staffer','h',1,'manager','E-001',datetime('now'));
INSERT INTO warehouse_activity (kind,product_img,qty_delta,performed_by,created_at)
 VALUES ('receipt','r-1',5,7,datetime('now'));
`);

r = await call('get', '/api/admin/reports/supplier');
A('reports/supplier: Acme with a received PO + a SKU', r.suppliers.some((s) => s.name === 'Acme Parts' && s.pos === 1 && s.po_value === 200 && s.received_value === 200 && s.skus === 1) && r.totals.suppliers === 1);
r = await call('get', '/api/admin/reports/customer-detail');
A('reports/customer-detail: Cust One, storefront spend, points', r.customers.some((x) => x.name === 'Cust One' && x.orders === 1 && x.order_spend === 50 && x.points === 100) && typeof r.tiles.new_customers === 'number');
r = await call('get', '/api/admin/reports/order-ledger');
A('reports/order-ledger: line + tiles + fulfilment', r.orders.length === 1 && r.orders[0].id === 1 && r.tiles.n === 1 && r.tiles.unpaid === 50 && r.by_fulfilment[0].fulfilment === 'pickup');
r = await call('get', '/api/admin/reports/users-staff');
A('reports/users-staff: roster + role count', r.staff.some((s) => s.name === 'Staffer' && s.state === 'active' && s.pin_set === 'no') && r.tiles.total >= 2 && Array.isArray(r.roles));
r = await call('get', '/api/admin/reports/setup-config');
A('reports/setup-config: company + carriers + counts, no secrets', r.company && r.carriers.dhl.secret === 'no' && r.card_payment.fygaro_enabled === false && r.counts.suppliers === 1 && typeof r.storefront.public_pricing === 'boolean');
r = await call('get', '/api/admin/reports/inventory-custom?cols=cost,retail,margin,supplier&category=Gadgets&active=1');
A('reports/inventory-custom: requested cols + totals', r.cols.join(',') === 'cost,retail,margin,supplier' && r.rows.length === 2 && 'margin' in r.rows[0] && !('bin' in r.rows[0]) && r.totals.name === '2 SKUs' && r.totals.retail === 5 * 20 + 0 * 90);
r = await call('get', '/api/admin/reports/inventory-custom?cols=stock&category=Gadgets&stock=out');
A('reports/inventory-custom: stock=out filter', r.rows.length === 1 && r.rows[0].name === 'ZZ Gizmo');
r = await call('get', '/api/admin/reports/warehouse');
A('reports/warehouse: movement + bins', r.by_kind.some((k) => k.kind === 'receipt' && k.n === 1) && r.net_delta === 5 && Array.isArray(r.bins) && typeof r.unbinned === 'number');
r = await call('get', '/api/admin/reports/audit-log');
A('reports/audit-log: merged feed incl. warehouse + loyalty', Array.isArray(r.feed) && r.feed.some((e) => e.area === 'Warehouse') && r.feed.some((e) => e.area === 'Loyalty') && r.by_area.some((a) => a.area === 'Warehouse'));
r = await call('get', '/api/admin/reports/x');
A('reports/x: open session till read', r.kind === 'X' && r.cash.opening_float === 200 && r.cash.cash_sales === 34.5 && r.sales.count === 1);
r = await call('get', '/api/admin/reports/z');
A('reports/z: no closed session -> 404', st === 404);

// ---- settings ----
r = await call('patch', '/api/admin/settings', { body: { phone: '876-000-0000', print_logo_on_invoice: false } });
A('settings patch', r.ok && q1('SELECT phone p, print_logo_on_invoice l FROM shop_settings WHERE id=1').p === '876-000-0000' && q1('SELECT print_logo_on_invoice l FROM shop_settings WHERE id=1').l === 0);
r = await call('get', '/api/admin/settings/machine');
A('settings/machine stub', r.ok && r.cloud === true);
r = await call('patch', '/api/admin/settings/server', { body: { port: 8080 } });
A('settings/server patch noop', r.ok && r.cloud === true);

// ---- local-server installer ----
r = await call('get', '/api/admin/local-server');
A('local-server: no bundle -> defaults returned, url null', r.url === null && r.defaults && r.defaults.port === 3057);
r = await call('post', '/api/admin/local-server/installer', { body: { admin_email: 'a@b.com', admin_password: 'secret9' } });
A('local-server installer: 400 when LOCAL_SERVER_URL unset', st === 400);
ENV.LOCAL_SERVER_URL = 'https://example.com/mh-portable.zip';
ENV.LOCAL_SERVER_SHA256 = 'ABC123';
r = await call('get', '/api/admin/local-server');
A('local-server: url + sha reported once published', r.url === 'https://example.com/mh-portable.zip' && r.sha256 === 'ABC123');
r = await call('post', '/api/admin/local-server/installer', { body: { admin_email: 'bad', admin_password: 'secret9' } });
A('installer: bad email -> 400', st === 400);
r = await call('post', '/api/admin/local-server/installer', { body: { admin_email: 'a@b.com', admin_password: 'x' } });
A('installer: short password -> 400', st === 400);
r = await call('post', '/api/admin/local-server/installer', {
  body: { shop_name: "O'Brien Auto", install_dir: 'C:\\Shop', port: 3055, admin_email: 'boss@shop.com', admin_password: 'strong-pw-1', open_firewall: true, install_service: false },
});
A('installer: 200 + .cmd attachment', st === 200 && /attachment; filename="Install Morty's Auto Parts Offline\.cmd"/.test(r.headers.get('content-disposition') || ''));
const cmdText = await r.text();
const b64 = (cmdText.match(/set "MHPS=([A-Za-z0-9+/=]+)"/) || [])[1];
const psText = b64 ? Buffer.from(b64, 'base64').toString('utf8') : '';
A('installer: cmd self-elevates + embeds a base64 PS payload', /Verb RunAs/.test(cmdText) && b64 && b64.length > 100);
A('installer: presets baked into the PS (port, dir, hash, escaped quote)',
  /\$Port\s*=\s*3055/.test(psText) && /\$Dir\s+=\s+'C:\\Shop'/.test(psText) &&
  /O''Brien Auto/.test(psText) && /\$Sha256\s+=\s+'ABC123'/.test(psText) && /\$DoService\s+=\s+\$false/.test(psText));
A('installer: PS writes machine/server/offline-setup config + firewall + first-run',
  /machine-config\.json/.test(psText) && /offline-setup\.json/.test(psText) &&
  /netsh advfirewall/.test(psText) && /Morty''s Auto Parts Admin\.vbs/.test(psText) && /admin\.html/.test(psText));
delete ENV.LOCAL_SERVER_URL; delete ENV.LOCAL_SERVER_SHA256;

// ---- marketing ----
r = await call('get', '/api/admin/marketing/segments/count');
A('marketing segments count', typeof r.counts.all === 'number' && r.counts.fleet >= 1);
r = await call('post', '/api/admin/marketing/campaigns', { body: { name: 'Spring Promo', body: 'Hi {name}', kind: 'email', segment: 'fleet' } });
const campId = r.id;
A('campaign create', r.ok && q1('SELECT status s FROM marketing_campaigns WHERE id=?', campId).s === 'draft');
r = await call('post', '/api/admin/marketing/campaigns/' + campId + '/send');
A('campaign send -> sent + counts', r.ok && r.recipients >= 1 && q1('SELECT status s FROM marketing_campaigns WHERE id=?', campId).s === 'sent');
r = await call('post', '/api/admin/marketing/campaigns/' + campId + '/send');
A('campaign re-send -> 400', st === 400);
r = await call('get', '/api/admin/marketing/campaigns');
A('campaign list', r.campaigns.length === 1);
await call('delete', '/api/admin/marketing/campaigns/' + campId);
A('campaign delete', !q1('SELECT id FROM marketing_campaigns WHERE id=?', campId));

// ---- schedule ----
r = await call('post', '/api/admin/schedule-blocks', { body: { block_date: '2026-09-05', mechanic_id: 7, reason: 'training' } });
const blkId = r.id;
A('schedule-block create', r.ok && blkId);
r = await call('get', '/api/admin/schedule-blocks?from=2026-09-01&to=2026-09-30');
A('schedule-blocks list', r.blocks.length === 1 && r.blocks[0].mechanic_name === 'Mech Seven');
r = await call('get', '/api/admin/schedule?week=2026-09-05');
A('schedule week: appts/WOs/blocks/mechs', r.week_start === '2026-08-31' && Array.isArray(r.work_orders) && r.blocks.length === 1 && r.mechanics.length === 1);
await call('delete', '/api/admin/schedule-blocks/' + blkId);
A('schedule-block delete', !q1('SELECT id FROM schedule_blocks WHERE id=?', blkId));

// ---- time entries ----
r = await call('post', '/api/admin/time-entries/clock-in', { body: { mechanic_id: 7, work_order_id: 1 } });
const teId = r.id;
A('clock-in', r.ok && teId);
r = await call('post', '/api/admin/time-entries/clock-in', { body: { mechanic_id: 7 } });
A('clock-in: already clocked in -> 400', st === 400);
r = await call('post', '/api/admin/time-entries/' + teId + '/clock-out');
A('clock-out: hours + WO labor line + rollup', r.ok && r.labor_entry_id && q1('SELECT clocked_out_at c, hours h FROM time_entries WHERE id=?', teId).c != null
  && q1('SELECT COUNT(*) n FROM work_order_labor WHERE work_order_id=1').n === 2);
r = await call('post', '/api/admin/time-entries/' + teId + '/clock-out');
A('clock-out: already -> 400', st === 400);
r = await call('get', '/api/admin/time-entries?open=true');
A('time-entries open filter', r.entries.length === 0);

// ---- pos helpers ----
r = await call('post', '/api/admin/pos/customer', { body: { name: 'Quick Cust', price_tier: 'trade' } });
A('pos/customer create', r.ok && /^C-\d{6}$/.test(r.account_number) && q1('SELECT via FROM users WHERE id=?', r.id).via === 'pos');
r = await call('get', '/api/admin/pos/scan?code=ZZ-W1');
A('pos/scan by sku', r.product && r.product.img === 'r-1' && r.product.stock_level === 'in' && r.product.price_usd === 20);
r = await call('get', '/api/admin/pos/scan?code=nope');
A('pos/scan miss -> 404', st === 404);
r = await call('get', '/api/admin/lookup?q=999222');
A('lookup by barcode', r.products.length === 1 && r.products[0].img === 'r-2');
r = await call('get', '/api/admin/lookup?q=Widget');
A('lookup by name LIKE', r.products.some((p) => p.img === 'r-1'));

// ---- external refs + orders patch ----
r = await call('get', '/api/admin/external-refs?vin=1HGABCDEFGH123456&year=2020&make=Honda&model=Civic');
A('external-refs: 7 links, vin-filled', r.links.length === 7 && r.links[0].url.includes('1HGABCDEFGH123456'));
r = await call('patch', '/api/admin/orders/1', { body: { status: 'confirmed' } });
A('orders patch status', r.ok && q1('SELECT status s FROM orders WHERE id=1').s === 'confirmed');
r = await call('patch', '/api/admin/orders/1', { body: { status: 'bogus' } });
A('orders patch bad status -> 400', st === 400);

// ---- invoice + pickslip ----
r = await call('get', '/api/invoice/WO-2026-0001?phone=5554433');
A('invoice (phone match): wo + labor + parts + shop', r.work_order.wo_number === 'WO-2026-0001' && r.labor.length >= 1 && r.parts.length === 1 && r.shop.name);
r = await call('get', '/api/pickslip?wo=WO-2026-0001');
A('pickslip wo: items w/ bin', r.kind === 'work_order' && r.items.length === 1 && r.items[0].product_name === 'ZZ Widget');
r = await call('get', '/api/pickslip?pos=1');
A('pickslip pos', r.kind === 'pos_sale' && r.items.length === 2);
r = await call('get', '/api/pickslip');
A('pickslip: needs a ref -> 400', st === 400);

// ---- import services ----
const csv = 'code,name,category,default_hours,default_price_usd,default_labor_usd\nSVC-A,Wheel Align,Steering,1,80,60\nSVC-C,,,,,\nSVC-B,Tyre Rotation,Tires,0.5,25,25\n';
r = await call('post', '/api/admin/import/services', { form: { csv: mkFile(csv) } });
A('import/services: 2 inserted, 1 skipped, cents', r.inserted === 2 && r.skipped === 1 && q1("SELECT default_price_cents p, default_labor_cents l FROM services WHERE code='SVC-A'").p === 8000 && q1("SELECT default_labor_cents l FROM services WHERE code='SVC-A'").l === 6000);
r = await call('post', '/api/admin/import/services', { form: {} });
A('import/services: no file -> 400', st === 400);

console.log('\ndone');
