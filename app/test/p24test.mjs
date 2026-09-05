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
    req: { param: (n) => m.params[n], query: (n) => (n == null ? m.query : m.query[n]), json: async () => body || {} },
    json: (o, s) => { if (s) st = s; return { _json: o }; } };
  const r = await m.r.h(c); return r && r._json !== undefined ? r._json : r;
}
const A = (l, ok) => { console.log((ok ? 'PASS  ' : 'FAIL  ') + l); if (!ok) process.exitCode = 1; };
const q1 = (s, ...p) => sdb.prepare(s).get(...p);

sdb.exec(`
INSERT INTO mechanics (id,name,is_active) VALUES (5,'Cashier Cathy',1);
INSERT INTO users (id,email,name,password_hash,is_admin,admin_role,is_staff,created_at)
 VALUES (600,'owner@x.com','Owner','h',1,'owner',1,datetime('now'));
`);

// ---- open a drawer, record a payout straight from it, close it -----------
let r = await call('post', '/api/admin/cash-drawer/open', { opened_by: 5, opening_float: 100 });
A('drawer: opens', r.ok === true);
const drawerId = r.id;

r = await call('post', '/api/admin/cash-payouts', {
  amount_usd: 20, reason: 'Paid courier for a rush delivery', paid_to: 'Speedy Courier',
  source_type: 'drawer', drawer_session_id: drawerId,
});
A('payout: recorded against the open drawer', st === 200 && r.ok === true);

r = await call('post', '/api/admin/cash-payouts', { amount_usd: -5, reason: 'bad', source_type: 'drawer', drawer_session_id: drawerId });
A('payout: rejects a non-positive amount', st === 400);
r = await call('post', '/api/admin/cash-payouts', { amount_usd: 5, source_type: 'drawer', drawer_session_id: drawerId });
A('payout: rejects a missing reason', st === 400);
r = await call('post', '/api/admin/cash-payouts', { amount_usd: 5, reason: 'x', source_type: 'drawer', drawer_session_id: 999999 });
A('payout: rejects a drawer session that is not open', st === 400);

r = await call('get', '/api/admin/cash-payouts?drawer_session_id=' + drawerId);
A('list: the drawer payout shows up', r.payouts.length === 1 && r.payouts[0].amount_usd === 20 && r.payouts[0].reason.includes('courier'));

// Close with no cash sales: expected = opening float (100) - payouts (20) = 80.
r = await call('post', '/api/admin/cash-drawer/' + drawerId + '/close', { closing_amount: 80, closed_by: 5 });
A('close: expected cash subtracts the drawer payout (100 - 20 = 80)', st === 200 && r.expected_cash === 80 && r.variance === 0);
A('close: reports the payout total', r.payouts === 20);

// ---- petty cash fund: create, payout from it, replenish -------------------
r = await call('post', '/api/admin/petty-cash-funds', { name: 'Front Desk Petty Cash', opening_balance_usd: 50, custodian_id: 600 });
A('fund: created', st === 200 && r.ok === true);
const fundId = r.id;

r = await call('get', '/api/admin/petty-cash-funds');
let fund = r.funds.find((f) => f.id === fundId);
A('fund: list shows the opening balance', fund && fund.balance_usd === 50);

r = await call('post', '/api/admin/cash-payouts', {
  amount_usd: 15, reason: 'Cleaning supplies', source_type: 'fund', fund_id: fundId,
});
A('payout: a fund payout succeeds', st === 200 && r.ok === true);
fund = (await call('get', '/api/admin/petty-cash-funds')).funds.find((f) => f.id === fundId);
A('payout: fund balance drops (50 - 15 = 35)', fund.balance_usd === 35);

r = await call('post', '/api/admin/cash-payouts', { amount_usd: 1000, reason: 'too much', source_type: 'fund', fund_id: fundId });
A('payout: a fund payout that would go negative is rejected', st === 400);
fund = (await call('get', '/api/admin/petty-cash-funds')).funds.find((f) => f.id === fundId);
A('payout: rejected payout does not touch the balance (still 35)', fund.balance_usd === 35);

// A fund payout never touches any drawer's reconciliation.
A('sanity: no cash_payouts row for the fund payout carries a drawer_session_id',
  !q1("SELECT id FROM cash_payouts WHERE fund_id = ? AND drawer_session_id IS NOT NULL", fundId));

// ---- replenish from the bank: credits the fund, no drawer involved --------
r = await call('post', '/api/admin/petty-cash-funds/' + fundId + '/replenish', { amount_usd: 25, source: 'bank' });
A('replenish (bank): succeeds', st === 200 && r.ok === true);
fund = (await call('get', '/api/admin/petty-cash-funds')).funds.find((f) => f.id === fundId);
A('replenish (bank): balance credited (35 + 25 = 60)', fund.balance_usd === 60);
A('replenish (bank): creates no cash_payouts row', !q1('SELECT id FROM cash_payouts WHERE reason = ?', 'Petty cash replenishment'));

// ---- replenish from an open drawer: credits the fund AND logs a drawer payout
r = await call('post', '/api/admin/cash-drawer/open', { opened_by: 5, opening_float: 200 });
const drawer2 = r.id;
r = await call('post', '/api/admin/petty-cash-funds/' + fundId + '/replenish', { amount_usd: 40, source: 'drawer', drawer_session_id: drawer2 });
A('replenish (drawer): succeeds', st === 200 && r.ok === true);
fund = (await call('get', '/api/admin/petty-cash-funds')).funds.find((f) => f.id === fundId);
A('replenish (drawer): balance credited (60 + 40 = 100)', fund.balance_usd === 100);
let transferRow = q1("SELECT * FROM cash_payouts WHERE fund_id = ? AND drawer_session_id = ?", fundId, drawer2);
A('replenish (drawer): logs a matching drawer payout', transferRow && transferRow.amount_cents === 4000 && transferRow.reason === 'Petty cash replenishment');

// That drawer's own close now reflects the $40 transfer as a payout.
r = await call('post', '/api/admin/cash-drawer/' + drawer2 + '/close', { closing_amount: 160, closed_by: 5 });
A('close: the fund-replenishment transfer counts as this drawer\'s payout (200 - 40 = 160)', st === 200 && r.expected_cash === 160 && r.variance === 0);

r = await call('post', '/api/admin/petty-cash-funds/' + fundId + '/replenish', { amount_usd: 10, source: 'drawer', drawer_session_id: 999999 });
A('replenish (drawer): rejects a drawer session that is not open', st === 400);
