import { fileURLToPath } from 'node:url';
const APP = new URL('../', import.meta.url).href;
const APP_DIR = fileURLToPath(APP);

import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
process.chdir(APP_DIR);
const sdb = new DatabaseSync(':memory:');
sdb.exec('PRAGMA foreign_keys=ON;');
for (const f of fs.readdirSync('migrations').filter((x) => /^\d+.*\.sql$/.test(x)).sort()) {
  try { sdb.exec(fs.readFileSync('migrations/' + f, 'utf8')); }
  catch (e) { console.log('MIGRATION FAIL', f, e.message.split('\n')[0]); process.exit(1); }
}
console.log('migrations OK');
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
(await import(APP + 'functions/_routes/recurring.js')).default(app);
console.log('mounted', routes.length);
function toRe(p) { return new RegExp('^' + p.replace(/:[A-Za-z_]+/g, '([^/]+)') + '$'); }
function pn(p) { return (p.match(/:([A-Za-z_]+)/g) || []).map((s) => s.slice(1)); }
function match(v, url) { const [p, qs] = url.split('?'); const query = Object.fromEntries(new URLSearchParams(qs || ''));
  for (const r of routes) { if (r.v !== v) continue; const m = toRe(r.p).exec(p); if (!m) continue;
    const params = {}; pn(r.p).forEach((n, i) => params[n] = decodeURIComponent(m[i + 1])); return { r, params, query }; } return null; }
const USER = { id: 900, is_admin: 1, admin_role: 'owner' };
let st = 200;
async function call(v, url, body) {
  const m = match(v, url); if (!m) throw new Error('no route ' + v + ' ' + url); st = 200;
  const c = { env: ENV, executionCtx: { waitUntil() {} }, get: () => USER,
    req: { param: (n) => m.params[n], query: (n) => (n == null ? m.query : m.query[n]), header: () => undefined, json: async () => body || {} },
    json: (o, s) => { if (s) st = s; return { _json: o }; } };
  const r = await m.r.h(c); return r && r._json !== undefined ? r._json : r;
}
const A = (l, ok) => { console.log((ok ? 'PASS  ' : 'FAIL  ') + l); if (!ok) process.exitCode = 1; };
const q1 = (s, ...p) => sdb.prepare(s).get(...p);

sdb.exec(`
INSERT INTO users (id,email,name,password_hash,is_admin,admin_role,is_staff,created_at) VALUES
 (900,'owner@x.com','Owner','h',1,'owner',1,datetime('now'));
INSERT INTO users (id,email,name,password_hash,is_admin,admin_role,is_staff,created_at,payment_terms_days)
 VALUES (700,'wholesale@x.com','Wholesale Wendy','h',0,'',0,datetime('now'),30);
INSERT INTO users (id,email,name,password_hash,is_admin,admin_role,is_staff,created_at)
 VALUES (701,'noterms@x.com','No Terms Nancy','h',0,'',0,datetime('now'));
`);

// ---- advanceDate covers every frequency --------------------------------------
const { advanceDate } = await import(APP + 'functions/_lib/recurring.js');
A('advanceDate: weekly', advanceDate('2026-01-01', 'weekly') === '2026-01-08');
A('advanceDate: monthly', advanceDate('2026-01-31', 'monthly') === '2026-03-03'); // JS Date rolls over short months -- documented, not "wrong"
A('advanceDate: quarterly', advanceDate('2026-01-15', 'quarterly') === '2026-04-15');
A('advanceDate: yearly', advanceDate('2026-01-15', 'yearly') === '2027-01-15');

// ---- create plans via the admin endpoints ------------------------------------
const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
let r = await call('post', '/api/admin/recurring-plans', {
  customer_id: 700, target: 'order', description: 'Monthly parts allowance', frequency: 'monthly',
  next_run_date: yesterday, items: [{ description: 'Parts allowance', qty: 1, unit_price_usd: 250 }],
});
A('create: order-target plan', st === 200 && r.ok === true);
const orderPlanId = r.id;

r = await call('post', '/api/admin/recurring-plans', {
  customer_id: 700, target: 'pos_account_sale', description: 'Monthly storage fee', frequency: 'monthly',
  next_run_date: yesterday, items: [{ description: 'Storage fee', qty: 1, unit_price_usd: 75 }],
  occurrences_left: 2,
});
A('create: pos_account_sale-target plan with a limited occurrence count', st === 200 && r.ok === true);
const saleplanId = r.id;

r = await call('post', '/api/admin/recurring-plans', { customer_id: 700, target: 'order', description: 'x', frequency: 'monthly', items: [] });
A('create: rejects a plan with no line items', st === 400);
r = await call('post', '/api/admin/recurring-plans', { customer_id: 999999, target: 'order', description: 'x', frequency: 'monthly', items: [{ description: 'a', unit_price_usd: 1 }] });
A('create: rejects an unknown customer', st === 404);

r = await call('get', '/api/admin/recurring-plans');
A('list: both plans present with computed amount_usd', st === 200 && r.plans.length === 2 &&
  r.plans.find((p) => p.id === orderPlanId).amount_usd === 250 && r.plans.find((p) => p.id === saleplanId).amount_usd === 75);

// ---- generateRecurringCharges: both targets fire on the due plans ----------
const { generateRecurringCharges } = await import(APP + 'functions/_lib/recurring.js');
const result = await generateRecurringCharges(ENV);
A('generate: both due plans ran ok', result.due === 2 && result.ran === 2 && result.failed === 0);

let order = q1('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT 1', 700);
A('order target: an order was created for the customer', order && order.total_cents === 25000 && order.payment_method === 'invoice_email' && order.source === 'recurring');
let orderItem = q1('SELECT * FROM order_items WHERE order_id = ?', order.id);
A('order target: order_items line matches the plan', orderItem.qty === 1 && orderItem.price_cents === 25000);

let sale = q1("SELECT * FROM pos_sales WHERE customer_id = ? AND payment_method = 'account' ORDER BY id DESC LIMIT 1", 700);
A('pos_account_sale target: a POS sale charged to account was created', sale && sale.total_cents === 8625); // 75 * 1.15 GCT
let planAfter = q1('SELECT * FROM recurring_plans WHERE id = ?', orderPlanId);
A('order plan: next_run_date advanced a month past yesterday', planAfter.next_run_date > yesterday && planAfter.is_active === 1);
let saleplanAfter = q1('SELECT * FROM recurring_plans WHERE id = ?', saleplanId);
A('sale plan: occurrences_left decremented (2 -> 1), still active', saleplanAfter.occurrences_left === 1 && saleplanAfter.is_active === 1);

// A second run today is a no-op -- nothing is due yet.
const result2 = await generateRecurringCharges(ENV);
A('generate: nothing due on a second run the same day', result2.due === 0);

// ---- run history recorded ---------------------------------------------------
r = await call('get', '/api/admin/recurring-plans/' + orderPlanId);
A('detail: run history shows the successful order run', st === 200 && r.runs.length === 1 && r.runs[0].status === 'ok' && r.runs[0].order_id === order.id);

// ---- a plan for a customer with no payment terms fails cleanly, but still advances
r = await call('post', '/api/admin/recurring-plans', {
  customer_id: 701, target: 'pos_account_sale', description: 'Bad plan', frequency: 'monthly',
  next_run_date: yesterday, items: [{ description: 'x', qty: 1, unit_price_usd: 10 }],
});
const badPlanId = r.id;
const result3 = await generateRecurringCharges(ENV);
A('generate: a plan that fails (no payment terms) is counted as failed', result3.failed === 1);
r = await call('get', '/api/admin/recurring-plans/' + badPlanId);
A('detail: the failed run is recorded with an error message', r.runs[0].status === 'failed' && /payment terms/i.test(r.runs[0].error || ''));
A('detail: the plan still advanced (does not retry the same date forever)', r.plan.next_run_date > yesterday);

// ---- occurrences hitting zero deactivates the plan --------------------------
r = await call('post', '/api/admin/recurring-plans/' + saleplanId + '/run-now', {});
A('run-now: succeeds directly', st === 200 && r.status === 'ok');
saleplanAfter = q1('SELECT * FROM recurring_plans WHERE id = ?', saleplanId);
A('run-now: occurrences_left hit 0 -> plan auto-deactivated', saleplanAfter.occurrences_left === 0 && saleplanAfter.is_active === 0);

// A deactivated plan is never picked up again even if next_run_date is due --
// by this point every other plan's next_run_date has already been advanced
// past yesterday, so nothing at all should be due.
sdb.exec(`UPDATE recurring_plans SET next_run_date = '${yesterday}' WHERE id = ${saleplanId}`);
const runsBefore = q1('SELECT COUNT(*) n FROM recurring_plan_runs WHERE plan_id = ?', saleplanId).n;
const result4 = await generateRecurringCharges(ENV);
A('generate: a deactivated plan due today is not picked up', result4.due === 0);
const runsAfter = q1('SELECT COUNT(*) n FROM recurring_plan_runs WHERE plan_id = ?', saleplanId).n;
A('generate: no new run was logged for the deactivated plan', runsAfter === runsBefore);

// ---- PATCH: pause / resume / edit --------------------------------------------
r = await call('patch', '/api/admin/recurring-plans/' + orderPlanId, { is_active: false });
A('patch: pauses a plan', st === 200 && r.ok === true);
planAfter = q1('SELECT is_active FROM recurring_plans WHERE id = ?', orderPlanId);
A('patch: is_active persisted as paused', planAfter.is_active === 0);

r = await call('patch', '/api/admin/recurring-plans/' + orderPlanId, { items: [] });
A('patch: rejects clearing all line items', st === 400);
