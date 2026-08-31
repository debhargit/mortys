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
console.log('migrations 0001-0024 OK');
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
(await import(APP + 'functions/_routes/service.js')).default(app);
console.log('mounted', routes.length);
function toRe(p) { return new RegExp('^' + p.replace(/:[A-Za-z_]+/g, '([^/]+)') + '$'); }
function pn(p) { return (p.match(/:([A-Za-z_]+)/g) || []).map((s) => s.slice(1)); }
function match(v, url) { const [p, qs] = url.split('?'); const query = Object.fromEntries(new URLSearchParams(qs || ''));
  for (const r of routes) { if (r.v !== v) continue; const m = toRe(r.p).exec(p); if (!m) continue;
    const params = {}; pn(r.p).forEach((n, i) => params[n] = decodeURIComponent(m[i + 1])); return { r, params, query }; } return null; }
const USER = { id: 700, is_admin: 1, admin_role: 'owner' };
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
INSERT INTO users (id,email,name,password_hash,is_admin) VALUES (700,'insp@x.com','Ivy Inspector','h',1);
INSERT INTO products (img,name,make_model,category,condition,price_cents,stock_count,low_threshold,is_active) VALUES ('wp-1','ZZ Brake Pad','ZZ','Brakes','NEW',4500,8,4,1);
`);

// mechanics
let r = await call('post', '/api/admin/mechanics', { name: 'Max Wrench', role: 'mechanic', hourly_rate_usd: 30 });
const mid = r.id;
A('mechanic create (rate -> cents)', r.ok && q1('SELECT hourly_rate_cents c FROM mechanics WHERE id=?', mid).c === 3000);
await call('patch', '/api/admin/mechanics/' + mid, { specialty: 'Brakes', hourly_rate_usd: 32.5 });
A('mechanic patch', q1('SELECT specialty s, hourly_rate_cents c FROM mechanics WHERE id=?', mid).s === 'Brakes' && q1('SELECT hourly_rate_cents c FROM mechanics WHERE id=?', mid).c === 3250);
r = await call('get', '/api/admin/mechanics?role=mechanic');
A('mechanic list (rate -> usd, bool)', r.mechanics[0].hourly_rate_usd === 32.5 && r.mechanics[0].is_active === true);
await call('delete', '/api/admin/mechanics/' + mid);
A('mechanic soft-delete', q1('SELECT is_active a FROM mechanics WHERE id=?', mid).a === 0);
sdb.exec(`UPDATE mechanics SET is_active=1 WHERE id=${mid}`);

// services
r = await call('post', '/api/admin/services', { name: 'Brake Job', code: 'BRK-1', default_price_usd: 120, default_labor_usd: 80, default_parts_usd: 40, default_hours: 2 });
const svc = r.id;
A('service create (usd->cents split)', q1('SELECT default_price_cents p, default_labor_cents l, default_parts_cents pa FROM services WHERE id=?', svc).p === 12000 && q1('SELECT default_labor_cents l FROM services WHERE id=?', svc).l === 8000);
r = await call('post', '/api/admin/services', { name: 'Dup', code: 'BRK-1' });
A('service dup code -> 400', st === 400);
await call('patch', '/api/admin/services/' + svc, { default_price_usd: 130, is_active: true });
A('service patch', q1('SELECT default_price_cents p FROM services WHERE id=?', svc).p === 13000);
r = await call('get', '/api/admin/services?active=true');
A('service list (cents->usd)', r.services.some((s) => s.code === 'BRK-1' && s.default_price_usd === 130 && s.default_labor_usd === 80));
await call('delete', '/api/admin/services/' + svc);
A('service soft-delete', q1('SELECT is_active a FROM services WHERE id=?', svc).a === 0);

// work orders lifecycle
r = await call('post', '/api/admin/work-orders', { customer_name: 'Joe Owner', customer_phone: '876-555-3300', vehicle_make: 'Honda', vehicle_model: 'Civic', vehicle_vin: '1hgxx000000000001', assigned_mechanic_id: mid });
const wo = r.id;
A('WO create w/ number', r.ok && /^WO-\d{4}-0001$/.test(r.wo_number));
r = await call('post', '/api/admin/work-orders/' + wo + '/labor', { description: 'Replace pads', hours: 2, rate_usd: 32.5, mechanic_id: mid });
A('WO labor line: total + recalc (2*32.5=65 labor, tax 15%)', r.totals.labor === 65 && r.totals.tax === 9.75 && r.totals.total === 74.75 && q1('SELECT labor_total_cents c FROM work_orders WHERE id=?', wo).c === 6500);
r = await call('post', '/api/admin/work-orders/' + wo + '/parts', { description: 'Brake pad set', qty: 1, unit_price_usd: 45, product_img: 'wp-1' });
A('WO parts line: total + recalc (65 labor + 45 parts = 110, tax 16.5, total 126.5)', r.totals.parts === 45 && r.totals.total === 126.5 && q1('SELECT total_cents c FROM work_orders WHERE id=?', wo).c === 12650);
r = await call('get', '/api/admin/work-orders/' + wo);
A('WO detail: usd + labor/parts joined', r.work_order.total_usd === 126.5 && r.labor.length === 1 && r.labor[0].mechanic_name === 'Max Wrench' && r.parts[0].product_name === 'ZZ Brake Pad' && r.parts[0].unit_price_usd === 45);
r = await call('get', '/api/admin/work-orders?status=open');
A('WO list by status', r.work_orders.length === 1 && r.work_orders[0].mechanic_name === 'Max Wrench');
await call('patch', '/api/admin/work-orders/' + wo, { status: 'completed', diagnosis: 'worn pads' });
A('WO patch: status completed sets completed_at', q1('SELECT status s, completed_at ca FROM work_orders WHERE id=?', wo).s === 'completed' && q1('SELECT completed_at ca FROM work_orders WHERE id=?', wo).ca != null);
// payments
r = await call('post', '/api/admin/work-orders/' + wo + '/payments', { method: 'cash', amount_usd: 100 });
A('WO payment partial (not fully paid)', r.total_paid === 100 && r.fully_paid === false);
r = await call('post', '/api/admin/work-orders/' + wo + '/payments', { method: 'card', amount_usd: 26.5 });
A('WO payment completes -> auto status paid', r.fully_paid === true && q1('SELECT status s FROM work_orders WHERE id=?', wo).s === 'paid');
r = await call('get', '/api/admin/work-orders/' + wo + '/payments');
A('WO payments list (usd)', r.payments.length === 2 && r.payments.some((p) => p.amount_usd === 100));
const payId = q1('SELECT id FROM work_order_payments WHERE work_order_id=? AND amount_cents=2650', wo).id;
await call('delete', '/api/admin/work-orders/' + wo + '/payments/' + payId);
A('WO payment delete reverts paid status', q1('SELECT status s FROM work_orders WHERE id=?', wo).s === 'completed');
// labor/parts delete recalc
const labId = q1('SELECT id FROM work_order_labor WHERE work_order_id=?', wo).id;
r = await call('delete', '/api/admin/work-orders/' + wo + '/labor/' + labId);
A('WO labor delete recalc (only parts 45 left, tax 6.75)', r.totals.labor === 0 && r.totals.total === 51.75);
// signature
r = await call('post', '/api/admin/work-orders/' + wo + '/signature', { signature: 'data:image/png;base64,AAAA' });
A('WO signature stored', r.ok && q1('SELECT customer_signature s FROM work_orders WHERE id=?', wo).s.startsWith('data:image/'));
r = await call('post', '/api/admin/work-orders/' + wo + '/signature', { signature: 'nope' });
A('WO signature validates data url', st === 400);

// inspections
r = await call('post', '/api/admin/inspections', { kind: 'service', vehicle_make: 'Honda', vin: '1hgxx000000000001', items: [{ category: 'Brakes', item: 'Front pads' }, { category: 'Tyres', item: 'Tread depth' }] });
const insp = r.id;
A('inspection create + items + inspector name from user', r.ok && q1('SELECT inspector_name n FROM inspections WHERE id=?', insp).n === 'Ivy Inspector' && q1('SELECT COUNT(*) n FROM inspection_items WHERE inspection_id=?', insp).n === 2);
r = await call('get', '/api/admin/inspections/' + insp);
A('inspection detail: items + photos arrays', r.inspection.kind === 'service' && r.items.length === 2 && Array.isArray(r.photos));
const itemId = q1('SELECT id FROM inspection_items WHERE inspection_id=? LIMIT 1', insp).id;
await call('patch', '/api/admin/inspection-items/' + itemId, { status: 'attention', severity: 'medium', notes: '4mm' });
A('inspection item patch', q1('SELECT status s, notes n FROM inspection_items WHERE id=?', itemId).s === 'attention');
await call('patch', '/api/admin/inspections/' + insp, { status: 'completed', overall_notes: 'ok overall' });
A('inspection patch', q1('SELECT status s FROM inspections WHERE id=?', insp).s === 'completed');
r = await call('get', '/api/admin/inspections?kind=service');
A('inspection list w/ counts', r.inspections.length === 1 && r.inspections[0].items_count === 2);
await call('delete', '/api/admin/inspections/' + insp);
A('inspection delete cascades items', !q1('SELECT id FROM inspections WHERE id=?', insp) && !q1('SELECT id FROM inspection_items WHERE inspection_id=?', insp));

// labor standards + estimate (uses 0004 seed)
r = await call('get', '/api/admin/labor-standards');
A('labor standards: classes + tiers (usd) + ops', r.vehicle_classes.length > 0 && r.rate_tiers.length > 0 && typeof r.rate_tiers[0].rate_usd === 'number' && r.operations.length > 0);
const anyOp = r.operations[0].code;
const anyClass = r.vehicle_classes[0].code;
const anyTier = r.rate_tiers[0].name;
r = await call('get', `/api/admin/labor-estimate?code=${encodeURIComponent(anyOp)}&class=${encodeURIComponent(anyClass)}&tier=${encodeURIComponent(anyTier)}`);
A('labor estimate computes hours*rate', typeof r.hours === 'number' && typeof r.total_usd === 'number' && r.total_usd === Math.round(r.hours * r.rate_usd * 100) / 100);
r = await call('get', '/api/admin/labor-estimate?code=NOSUCH');
A('labor estimate unknown op -> 404', st === 404);

// maintenance-due + vehicle-history
sdb.exec(`INSERT INTO work_orders (wo_number,customer_name,customer_phone,vehicle_vin,mileage_in,intake_date,status)
  VALUES ('WO-2020-0001','Old Client','876-555-9000','2hgold00000000001',40000,datetime('now','-400 days'),'paid')`);
r = await call('get', '/api/admin/maintenance-due');
A('maintenance-due: flags overdue vehicle', r.count >= 1 && r.vehicles.some((v) => v.customer_name === 'Old Client' && v.flags.length > 0));
r = await call('get', '/api/admin/vehicle-history?vin=1HGXX000000000001');
A('vehicle-history: WOs by vin + summary', r.work_orders.length >= 1 && r.vehicle && r.vehicle.make === 'Honda' && Array.isArray(r.inspections) && Array.isArray(r.appointments));
r = await call('get', '/api/admin/vehicle-history');
A('vehicle-history: vin or plate required', st === 400);

console.log('\ndone');
