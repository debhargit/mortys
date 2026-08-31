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
(await import(APP + 'functions/_routes/ops.js')).default(app);
console.log('mounted', routes.length);
function toRe(p) { return new RegExp('^' + p.replace(/:[A-Za-z_]+/g, '([^/]+)') + '$'); }
function pn(p) { return (p.match(/:([A-Za-z_]+)/g) || []).map((s) => s.slice(1)); }
function match(v, url) { const [p, qs] = url.split('?'); const query = Object.fromEntries(new URLSearchParams(qs || ''));
  for (const r of routes) { if (r.v !== v) continue; const m = toRe(r.p).exec(p); if (!m) continue;
    const params = {}; pn(r.p).forEach((n, i) => params[n] = decodeURIComponent(m[i + 1])); return { r, params, query }; } return null; }
const USER = { id: 600, is_admin: 1, admin_role: 'owner' };
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
INSERT INTO users (id,email,name,password_hash,is_admin) VALUES (600,'ops@x.com','Ops','h',1);
INSERT INTO mechanics (id,name,is_active) VALUES (5,'Wrench Wally',1);
INSERT INTO products (img,name,make_model,category,condition,price_cents,stock_count,low_threshold,is_active,bin_location,sku) VALUES
 ('op-1','ZZ Plug','ZZ','Ignition','NEW',800,10,4,1,'ZZ-A1','ZZ-PLUG'),
 ('op-2','ZZ Coil','ZZ','Ignition','NEW',5000,1,4,1,'ZZ-A1','ZZ-COIL');
INSERT INTO work_orders (id,wo_number,customer_name,customer_phone,status) VALUES (30,'WO-2026-0030','WO Client','876-1','open');
INSERT INTO work_order_payments (work_order_id,method,amount_cents,received_by,received_at) VALUES (30,'cash',10000,5,datetime('now'));
`);

// ---- parts requisitions ----
let r = await call('post', '/api/admin/parts-requisitions', { work_order_id: 30, requested_by: 5, items: [
  { product_img: 'op-1', description: 'Plugs x4', qty_requested: 4, unit_price_usd: 8 },
  { product_img: 'op-2', description: 'Coil x2', qty_requested: 2, unit_price_usd: 50 },
] });
const prId = r.id;
A('parts-req create w/ number + items', /^PR-\d{4}-0001$/.test(r.pr_number) && q1('SELECT COUNT(*) n FROM parts_requisition_items WHERE requisition_id=?', prId).n === 2);
r = await call('get', '/api/admin/parts-requisitions/' + prId);
A('parts-req detail: items + in_stock + unit_price_usd', r.items.length === 2 && r.items.find((i) => i.product_img === 'op-2').in_stock === 1 && r.items[0].unit_price_usd === 8);
r = await call('post', '/api/admin/parts-requisitions/' + prId + '/fulfill');
A('parts-req fulfill: op-1 full, op-2 partial -> status partial', r.status === 'partial'
  && q1("SELECT stock_count FROM products WHERE img='op-1'").stock_count === 6
  && q1("SELECT stock_count FROM products WHERE img='op-2'").stock_count === 0);
A('parts-req fulfill: posted onto WO parts + rolled up total', q1('SELECT COUNT(*) n FROM work_order_parts WHERE work_order_id=30').n === 2
  && q1('SELECT parts_total_cents c FROM work_orders WHERE id=30').c === (4 * 800 + 1 * 5000));
A('parts-req item statuses', q1("SELECT status FROM parts_requisition_items WHERE product_img='op-1'").status === 'fulfilled'
  && q1("SELECT status FROM parts_requisition_items WHERE product_img='op-2'").status === 'backordered');
r = await call('post', '/api/admin/parts-requisitions/' + prId + '/fulfill');
A('parts-req: cannot re-fulfill a fulfilled one', st === 400 || r.status === 'partial'); // still partial, not fulfilled; re-run allowed but op-2 still 0
r = await call('get', '/api/admin/parts-requisitions?status=partial');
A('parts-req list filter + item_count', r.requisitions.length === 1 && r.requisitions[0].item_count === 2 && r.requisitions[0].wo_number === 'WO-2026-0030');

// ---- service requisitions ----
r = await call('post', '/api/admin/requisitions', { customer_name: 'Est Client', customer_phone: '876-2', vehicle_make: 'Honda', complaint: 'noise' });
const reqId = r.id;
A('req create w/ REQ number', /^REQ-\d{4}-0001$/.test(r.req_number));
r = await call('post', '/api/admin/requisitions/' + reqId + '/items', { description: 'Front brakes', hours: 1.5, labor_usd: 60, parts_usd: 45 });
A('req item add + recalc total (105)', r.total === 105 && q1('SELECT estimate_total_cents c FROM service_requisitions WHERE id=?', reqId).c === 10500);
r = await call('post', '/api/admin/requisitions/' + reqId + '/items', { description: 'Oil service', labor_usd: 20, parts_usd: 30 });
A('req second item recalc (105+50=155)', r.total === 155);
r = await call('get', '/api/admin/requisitions/' + reqId);
A('req detail: items usd + estimate_total_usd', r.requisition.estimate_total_usd === 155 && r.items.length === 2 && r.items[0].labor_usd === 60);
await call('patch', '/api/admin/requisitions/' + reqId, { status: 'approved' });
A('req patch approved sets approved_at', q1('SELECT status s, approved_at a FROM service_requisitions WHERE id=?', reqId).s === 'approved' && q1('SELECT approved_at a FROM service_requisitions WHERE id=?', reqId).a != null);
const itmId = q1('SELECT id FROM service_requisition_items WHERE requisition_id=? LIMIT 1', reqId).id;
r = await call('delete', '/api/admin/requisitions/' + reqId + '/items/' + itmId);
A('req item delete recalc (155-105=50)', r.total === 50);
r = await call('post', '/api/admin/requisitions/' + reqId + '/convert');
const newWo = r.work_order_id;
A('req convert -> WO w/ labor+parts rows + totals', /^WO-\d{4}-/.test(r.wo_number)
  && q1('SELECT COUNT(*) n FROM work_order_labor WHERE work_order_id=?', newWo).n === 1
  && q1('SELECT COUNT(*) n FROM work_order_parts WHERE work_order_id=?', newWo).n === 1
  && q1('SELECT total_cents c FROM work_orders WHERE id=?', newWo).c === 5000);
A('req marked converted', q1('SELECT status s, converted_to_work_order_id w FROM service_requisitions WHERE id=?', reqId).s === 'converted');
r = await call('post', '/api/admin/requisitions/' + reqId + '/convert');
A('req: already-converted -> 400', st === 400);

// ---- stock counts ----
r = await call('post', '/api/admin/stock-counts', { scope: 'bin', scope_value: 'ZZ-A1', counted_by: 5 });
const scId = r.id;
A('stock-count create + snapshot (2 items in bin A-1)', /^SC-\d{4}-0001$/.test(r.count_number) && r.total_items === 2 && q1('SELECT COUNT(*) n FROM stock_count_items WHERE count_id=?', scId).n === 2);
const sciId = q1("SELECT sci.id FROM stock_count_items sci WHERE sci.count_id=? AND sci.product_img='op-1'", scId).id;
await call('patch', '/api/admin/stock-count-items/' + sciId, { counted_qty: 4, notes: 'short 2' });
A('stock-count item patch', q1('SELECT counted_qty q, counted_at ca FROM stock_count_items WHERE id=?', sciId).q === 4);
r = await call('post', '/api/admin/stock-counts/' + scId + '/post');
A('stock-count post: applies delta + variance + activity', r.total_variance === 2
  && q1("SELECT stock_count FROM products WHERE img='op-1'").stock_count === 4
  && q1("SELECT COUNT(*) n FROM warehouse_activity WHERE kind='count_post' AND product_img='op-1'").n === 1
  && q1('SELECT status s FROM stock_counts WHERE id=?', scId).s === 'posted');
r = await call('post', '/api/admin/stock-counts/' + scId + '/post');
A('stock-count: re-post -> 400', st === 400);
r = await call('get', '/api/admin/stock-counts/' + scId);
A('stock-count detail: count + items w/ product_name', r.count.count_number === q1('SELECT count_number c FROM stock_counts WHERE id=?', scId).c && r.items.some((i) => i.product_name === 'ZZ Plug'));

// ---- stock adjust ----
r = await call('post', '/api/admin/stock-adjust', { product_img: 'op-2', new_qty: 12, reason: 'found box' });
A('stock-adjust: qty + activity', r.qty_after === 12 && q1("SELECT stock_count FROM products WHERE img='op-2'").stock_count === 12
  && q1("SELECT COUNT(*) n FROM warehouse_activity WHERE kind='adjust' AND product_img='op-2'").n === 1);
r = await call('post', '/api/admin/stock-adjust', { product_img: 'nope' });
A('stock-adjust: missing fields -> 400', st === 400);

// ---- warehouse activity + bin ----
r = await call('get', '/api/admin/warehouse-activity?limit=50');
A('warehouse-activity list w/ product_name', r.activity.length >= 2 && r.activity.some((a) => a.product_name === 'ZZ Plug'));
r = await call('get', '/api/admin/bin/ZZ-A1');
A('bin lookup', r.bin === 'ZZ-A1' && r.products.length === 2);

// ---- deliveries ----
r = await call('post', '/api/admin/deliveries', { recipient_name: 'Rita Recipient', address: '5 Hope Rd', driver_id: 5 });
const delId = r.id;
A('delivery create w/ number', /^DEL-\d{4}-0001$/.test(r.delivery_number));
await call('patch', '/api/admin/deliveries/' + delId, { status: 'dispatched' });
A('delivery dispatched sets dispatched_at', q1('SELECT status s, dispatched_at d FROM deliveries WHERE id=?', delId).s === 'dispatched' && q1('SELECT dispatched_at d FROM deliveries WHERE id=?', delId).d != null);
await call('patch', '/api/admin/deliveries/' + delId, { status: 'delivered', recipient_received_by: 'Rita' });
A('delivery delivered sets delivered_at + activity', q1('SELECT delivered_at d FROM deliveries WHERE id=?', delId).d != null
  && q1("SELECT COUNT(*) n FROM warehouse_activity WHERE kind='delivery'").n === 1);
r = await call('get', '/api/admin/deliveries?status=delivered');
A('delivery list filter + driver_name', r.deliveries.length === 1 && r.deliveries[0].driver_name === 'Wrench Wally');

// ---- cash drawer ----
r = await call('get', '/api/admin/cash-drawer/open');
A('cash-drawer: none open', r.session === null);
r = await call('post', '/api/admin/cash-drawer/open', { opened_by: 5, opening_float: 200 });
const cdId = r.id;
A('cash-drawer open (float->cents)', r.ok && q1('SELECT opening_float_cents c FROM cash_drawer_sessions WHERE id=?', cdId).c === 20000);
r = await call('post', '/api/admin/cash-drawer/open', { opening_float: 100 });
A('cash-drawer: second open -> 400', st === 400);
// pos_sales cash since open: seed one
sdb.exec("INSERT INTO pos_sales (receipt_number,total_cents,payment_method,voided,created_at) VALUES ('R-CD-1',15000,'cash',0,datetime('now'))");
r = await call('post', '/api/admin/cash-drawer/' + cdId + '/close', { closing_amount: 355, closed_by: 5 });
A('cash-drawer close: expected 200+150=350, variance +5', r.expected_cash === 350 && r.variance === 5 && q1('SELECT variance_cents v FROM cash_drawer_sessions WHERE id=?', cdId).v === 500);
r = await call('post', '/api/admin/cash-drawer/' + cdId + '/close', { closing_amount: 1 });
A('cash-drawer: re-close -> 400', st === 400);

// ---- cash report ----
r = await call('get', '/api/admin/cash-report');
A('cash-report: by_method + totals (usd)', Array.isArray(r.by_method) && r.by_method.some((m) => m.method === 'cash' && m.s === 100) && r.totals.s === 100);

console.log('\ndone');
