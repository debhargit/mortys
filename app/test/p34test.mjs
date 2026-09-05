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
    req: { param: (n) => m.params[n], query: (n) => (n == null ? m.query : m.query[n]), json: async () => body || {}, header: () => null },
    json: (o, s) => { if (s) st = s; return { _json: o }; } };
  const r = await m.r.h(c); return r && r._json !== undefined ? r._json : r;
}
const A = (l, ok) => { console.log((ok ? 'PASS  ' : 'FAIL  ') + l); if (!ok) process.exitCode = 1; };
const q1 = (s, ...p) => sdb.prepare(s).get(...p);
const CAT = () => q1("SELECT id FROM petty_cash_categories WHERE name = 'Fuel'").id;

sdb.exec(`INSERT INTO users (id,email,name,password_hash,is_admin,admin_role,is_staff,created_at)
 VALUES (600,'owner@x.com','Owner','h',1,'owner',1,datetime('now'));`);

// ---- 1. fund with opening + float ---------------------------------------
let r = await call('post', '/api/admin/petty-cash-funds', { name: 'Front Desk', opening_balance_usd: 200, float_usd: 200, receipt_threshold_usd: 25 });
const fund = r.id;
A('fund: created with opening + float', st === 200 && r.ok === true);
A('fund: an opening movement was logged', q1("SELECT delta_cents FROM petty_cash_movements WHERE fund_id=? AND kind='opening'", fund).delta_cents === 20000);
r = await call('get', '/api/admin/petty-cash-funds/' + fund);
A('fund detail: ledger opens at the opening balance', r.ledger.length === 1 && r.ledger[0].kind === 'opening' && r.ledger[0].balance_usd === 200);
A('fund detail: computed balance matches the denormalised one', r.computed_balance_usd === 200 && r.fund.balance_usd === 200);

// ---- 2. categorised payout + guards -----------------------------------
r = await call('post', '/api/admin/cash-payouts', { amount_usd: 12, reason: 'Diesel', source_type: 'fund', fund_id: fund, category_id: CAT(), paid_to: 'Shell' });
A('payout: a categorised fund payout succeeds, no receipt warning under threshold', st === 200 && r.ok === true && !r.warning);
A('payout: balance dropped to 188', q1('SELECT balance_cents b FROM petty_cash_funds WHERE id=?', fund).b === 18800);
r = await call('post', '/api/admin/cash-payouts', { amount_usd: 5, reason: 'x', source_type: 'fund', fund_id: fund });
A('payout: a fund payout with no category is rejected', st === 400 && /category/i.test(r.error || ''));
r = await call('post', '/api/admin/cash-payouts', { amount_usd: 40, reason: 'Big buy', source_type: 'fund', fund_id: fund, category_id: CAT() });
A('payout: over the receipt threshold with no reference -> ok WITH a warning', st === 200 && r.ok === true && /receipt/i.test(r.warning || ''));
const bigPayout = q1("SELECT id FROM cash_payouts WHERE reason='Big buy'").id;
r = await call('get', '/api/admin/petty-cash-funds/' + fund);
A('ledger: the categorised payout shows with its category and a running balance',
  r.ledger.some((e) => e.category === 'Fuel' && e.delta_usd === -12));

// ---- 3. replenish to float -----------------------------------------
r = await call('post', '/api/admin/petty-cash-funds/' + fund + '/replenish', { to_float: true, source: 'bank' });
A('replenish to_float: tops the fund back up to 200', st === 200 && q1('SELECT balance_cents b FROM petty_cash_funds WHERE id=?', fund).b === 20000);
A('replenish: a replenishment movement was logged', !!q1("SELECT id FROM petty_cash_movements WHERE fund_id=? AND kind='replenishment'", fund));

// ---- 4. void a payout --------------------------------------------
r = await call('post', '/api/admin/cash-payouts/' + bigPayout + '/void', {});
A('void: the payout is flagged voided', st === 200 && q1('SELECT voided v FROM cash_payouts WHERE id=?', bigPayout).v === 1);
A('void: a void_reversal movement re-credits the fund (200 + 40 = 240)',
  !!q1("SELECT id FROM petty_cash_movements WHERE related_payout_id=? AND kind='void_reversal'", bigPayout) &&
  q1('SELECT balance_cents b FROM petty_cash_funds WHERE id=?', fund).b === 24000);
r = await call('get', '/api/admin/petty-cash-funds/' + fund);
A('ledger: the voided payout is struck and ignored in the running total',
  r.ledger.find((e) => e.payout_id === bigPayout).voided === true);

// ---- 5. staff advances --------------------------------------------
r = await call('post', '/api/admin/cash-payouts', { amount_usd: 30, reason: 'Advance for parts run', source_type: 'fund', fund_id: fund, is_advance: true, advance_to: 'Marlon' });
const adv1 = q1("SELECT id FROM cash_payouts WHERE reason='Advance for parts run'").id;
A('advance: opens as open, balance drops to 210', st === 200 && q1('SELECT advance_status s FROM cash_payouts WHERE id=?', adv1).s === 'open' &&
  q1('SELECT balance_cents b FROM petty_cash_funds WHERE id=?', fund).b === 21000);
r = await call('get', '/api/admin/petty-cash-funds/' + fund);
A('advance: shows under open advances', (r.open_advances || []).some((x) => x.advance_to === 'Marlon' && x.amount_usd === 30));
r = await call('post', '/api/admin/cash-payouts/' + adv1 + '/settle-advance', { how: 'repay' });
A('advance repay: status -> repaid, an advance_repay movement, balance back to 240',
  st === 200 && q1('SELECT advance_status s FROM cash_payouts WHERE id=?', adv1).s === 'repaid' &&
  !!q1("SELECT id FROM petty_cash_movements WHERE related_payout_id=? AND kind='advance_repay'", adv1) &&
  q1('SELECT balance_cents b FROM petty_cash_funds WHERE id=?', fund).b === 24000);
r = await call('post', '/api/admin/cash-payouts', { amount_usd: 20, reason: 'Advance 2', source_type: 'fund', fund_id: fund, is_advance: true, advance_to: 'Sam' });
const adv2 = q1("SELECT id FROM cash_payouts WHERE reason='Advance 2'").id;
r = await call('post', '/api/admin/cash-payouts/' + adv2 + '/settle-advance', { how: 'expense', category_id: CAT(), receipt_ref: 'R-88' });
A('advance expense: status -> expensed, category assigned, balance unchanged (220)',
  st === 200 && q1('SELECT advance_status s, category_id c FROM cash_payouts WHERE id=?', adv2).s === 'expensed' &&
  q1('SELECT category_id c FROM cash_payouts WHERE id=?', adv2).c === CAT() &&
  q1('SELECT balance_cents b FROM petty_cash_funds WHERE id=?', fund).b === 22000);

// ---- 6. reconcile ----------------------------------------------
r = await call('post', '/api/admin/petty-cash-funds/' + fund + '/reconcile', { counted_usd: 218, notes: 'monthly count' });
A('reconcile: variance -2, balance set to the counted 218, last_reconciled_at stamped',
  st === 200 && r.variance_usd === -2 &&
  q1('SELECT balance_cents b, last_reconciled_at t FROM petty_cash_funds WHERE id=?', fund).b === 21800 &&
  !!q1('SELECT last_reconciled_at t FROM petty_cash_funds WHERE id=?', fund).t);
A('reconcile: a count row + a negative reconcile_adjust movement were written',
  q1("SELECT variance_cents v FROM petty_cash_counts WHERE fund_id=?", fund).v === -200 &&
  !!q1("SELECT id FROM petty_cash_movements WHERE fund_id=? AND kind='reconcile_adjust' AND delta_cents=-200", fund));

// ---- 7. transfer between funds ---------------------------------
r = await call('post', '/api/admin/petty-cash-funds', { name: 'Workshop', opening_balance_usd: 0, float_usd: 100 });
const fund2 = r.id;
r = await call('post', '/api/admin/petty-cash-funds/' + fund + '/transfer', { to_fund_id: fund2, amount_usd: 50, notes: 'seed workshop' });
A('transfer: source drops, destination rises',
  st === 200 && q1('SELECT balance_cents b FROM petty_cash_funds WHERE id=?', fund).b === 16800 &&
  q1('SELECT balance_cents b FROM petty_cash_funds WHERE id=?', fund2).b === 5000);
A('transfer: transfer_out + transfer_in movements exist',
  !!q1("SELECT id FROM petty_cash_movements WHERE fund_id=? AND kind='transfer_out'", fund) &&
  !!q1("SELECT id FROM petty_cash_movements WHERE fund_id=? AND kind='transfer_in'", fund2));
r = await call('post', '/api/admin/petty-cash-funds/' + fund + '/transfer', { to_fund_id: fund2, amount_usd: 99999 });
A('transfer: over the source balance is rejected', st === 400);

// ---- 8. report ----------------------------------------------
r = await call('get', '/api/admin/petty-cash-report?from=2000-01-01&to=2999-12-31');
A('report: by_category sums the (non-voided) categorised fund spend for Fuel',
  (r.by_category || []).find((x) => x.category === 'Fuel') && r.by_category.find((x) => x.category === 'Fuel').spend_usd > 0);
A('report: replenishments total is positive', r.totals.replenishments_usd > 0);
A('report: lines is a flat array of fund payouts', Array.isArray(r.lines) && r.lines.length > 0);
A('report: the expensed advance (Fuel) is folded into by_category, the repaid one is not',
  r.by_category.find((x) => x.category === 'Fuel').n >= 2);
