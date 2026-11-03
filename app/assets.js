'use strict';
// =============================================================================
//  Vision Auto Solutions -- fixed assets and depreciation
//
//  Mounted by server.js:  require('./assets').register(app, deps)
//  Routes under /api/assets. Capabilities: acct.view (register, schedules,
//  report), acct.post (add / change / void assets, depreciation runs,
//  disposals), acct.setup (asset classes and their accounts).
//
//  Register   each asset with its class (which says the cost, accumulated
//             depreciation and expense accounts), cost, salvage, method and
//             life, and how its cost reached the books:
//               in_ledger  a bill or bank payment already coded it to the
//                          class's asset account: nothing more to post
//               account    paid from an account outside Payables / Banking:
//                          Dr asset, Cr that account
//               opening    owned before the ledger started: Dr asset, Cr the
//                          depreciation to date, Cr Opening Balance Equity
//  Methods    straight_line      (cost - salvage) spread evenly over the life;
//                                a change of life or salvage spreads what is
//                                left over the months that are left
//             declining_balance  rate % a year of the book value, monthly
//             none               not depreciated (land)
//             A month is charged in full from the month the asset goes into
//             service; the last month takes what rounding left, so book value
//             ends exactly at salvage.
//  Runs       depreciation through a month, catching up any month missed, for
//             every asset in service: one journal entry per run. Only the
//             latest run can be voided (the ledger reverses it).
//  Disposals  sold, scrapped, written off, traded in, stolen: depreciation must
//             be run to the month before; posts cost and depreciation off and
//             the gain or loss. A disposal can be voided.
//
//  Every posting is made by gl.js (fa_acquire, fa_run, fa_dispose and their
//  _void); glPost() runs it straight after a save so the ledger shows it.
// =============================================================================

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const n = (v) => (v == null || v === '' ? 0 : Number(v));
// Months are 'YYYY-MM' strings.
const ym = (d) => String(d).slice(0, 7);
function mAdd(m, k) {
  const [y, mo] = m.split('-').map(Number), t = y * 12 + (mo - 1) + k;
  return Math.floor(t / 12) + '-' + String((t % 12) + 1).padStart(2, '0');
}
const mDiff = (a, b) => { const [ay, am] = a.split('-').map(Number), [by, bm] = b.split('-').map(Number); return (by - ay) * 12 + (bm - am); };

// One month's charge for an asset, given the depreciation already taken.
function monthCharge(a, month, accumBefore) {
  if (a.method === 'none') return 0;
  const start = ym(a.in_service_on);
  if (month < start) return 0;
  const left = r2(n(a.cost) - n(a.salvage) - accumBefore);
  if (left <= 0) return 0;
  if (a.method === 'straight_line') {
    const remaining = n(a.life_months) - mDiff(start, month);
    // The last month of the life takes what is left (and so does any month after, when the life was shortened).
    return remaining <= 1 ? left : Math.min(left, r2(left / remaining));
  }
  if (a.method === 'declining_balance') {
    if (a.life_months && n(a.life_months) - mDiff(start, month) <= 1) return left;   // the life ends: write it down to salvage
    return Math.min(left, r2((n(a.cost) - accumBefore) * n(a.rate_pct) / 1200));
  }
  return 0;
}

// The months still to charge through `through`, from where the asset's
// depreciation stands: [{month, amount}]. `charged` is what is on file.
function dueMonths(a, through, charged) {
  if (a.method === 'none' || a.status === 'void') return [];
  let accum = n(a.opening_accum) + charged.reduce((t, d) => t + n(d.amount), 0);
  const last = charged.length ? charged.map((d) => ym(d.month)).sort().pop() : null;
  let from = ym(a.in_service_on);
  if (a.opening_through && mAdd(ym(a.opening_through), 1) > from) from = mAdd(ym(a.opening_through), 1);
  if (last && mAdd(last, 1) > from) from = mAdd(last, 1);
  const out = [];
  for (let m = from; m <= through && out.length < 1200; m = mAdd(m, 1)) {
    const amt = monthCharge(a, m, accum);
    if (amt > 0) { out.push({ month: m, amount: amt }); accum = r2(accum + amt); }
    else if (r2(n(a.cost) - n(a.salvage) - accum) <= 0) break;
  }
  return out;
}

// Straight-line depreciation an asset would have had before `beforeMonth`:
// the suggested brought-forward figure for something owned before the ledger.
function depreciationBefore(a, beforeMonth) {
  const through = mAdd(beforeMonth, -1);
  const rows = dueMonths(Object.assign({}, a, { opening_accum: 0, opening_through: null }), through, []);
  return { amount: r2(rows.reduce((t, d) => t + d.amount, 0)), through: rows.length ? rows[rows.length - 1].month : null };
}

function register(app, deps) {
  const { query, getPool, requireAdmin, requireCap, glPost } = deps;
  const can = (k) => [requireAdmin, requireCap(k)];
  const VIEW = can('acct.view'), POST = can('acct.post'), SETUP = can('acct.setup');
  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !isNaN(Date.parse(v));
  const today = () => new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10);
  const METHODS = ['straight_line', 'declining_balance', 'none'];
  const FUNDING = ['in_ledger', 'account', 'opening'];
  const DISPOSALS = ['sold', 'scrapped', 'written_off', 'traded_in', 'stolen'];
  function httpError(status, msg) { const e = new Error(msg); e.status = status; e.publicMessage = msg; return e; }
  function fail(res, e) { if (e.code === '23503') e = httpError(400, 'Something it points at (supplier, account, class) was not found'); const s = e.status || 500; if (s >= 500) console.error('[assets]', e); res.status(s).json({ error: e.publicMessage || e.message }); }
  async function tx(fn) {
    const c = await getPool().connect();
    try { await c.query('BEGIN'); const out = await fn(c); await c.query('COMMIT'); return out; }
    catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} throw e; }
    finally { c.release(); }
  }
  // Post to the ledger now (best effort: the ledger's own timer posts it anyway).
  async function post() {
    if (!glPost) return;
    for (let i = 0; i < 8; i++) {
      try { const r = await glPost(); if (!r || !r.busy) return; } catch (e) { console.warn('[assets] post', e.message); return; }
      await new Promise((ok) => setTimeout(ok, 400));
    }
  }
  async function ledgerStart() {
    const { rows } = await query(`SELECT to_char((value::timestamptz AT TIME ZONE 'America/Jamaica')::date, 'YYYY-MM-DD') AS d FROM warehouse_settings WHERE key = 'gl_start_at' AND value IS NOT NULL`);
    return rows.length ? rows[0].d : null;
  }
  // An account an asset may be paid from / sold into: active, and not A/R or A/P (those need Receivables / Payables).
  async function plainAccount(id, what) {
    const { rows } = await query(`SELECT id, name, system_key, qb_type, is_active FROM gl_accounts WHERE id = $1`, [parseInt(id, 10) || 0]);
    const a = rows[0];
    if (!a || !a.is_active) throw httpError(400, 'Choose the account ' + what);
    if (['ar', 'ap'].includes(a.system_key) || ['AR', 'AP'].includes(a.qb_type)) throw httpError(400, 'Use Payables or Receivables for supplier and customer balances, not ' + a.name);
    return a.id;
  }
  const ASSET_SQL = `SELECT a.*, to_char(a.acquired_on, 'YYYY-MM-DD') AS acquired_on, to_char(a.in_service_on, 'YYYY-MM-DD') AS in_service_on,
        to_char(a.opening_through, 'YYYY-MM') AS opening_through, k.name AS class_name, k.asset_account_id, k.accum_account_id, k.expense_account_id,
        s.name AS supplier, gc.name AS gl_class, fa.code || ' ' || fa.name AS funding_account,
        COALESCE((SELECT SUM(d.amount) FROM fa_depreciation d WHERE d.asset_id = a.id), 0) AS depreciated,
        (SELECT to_char(MAX(d.month), 'YYYY-MM') FROM fa_depreciation d WHERE d.asset_id = a.id) AS last_month,
        EXISTS (SELECT 1 FROM gl_entries e WHERE e.source_kind = 'fa_acquire' AND e.source_id = a.id AND e.reversed_by IS NULL) AS posted
      FROM fa_assets a JOIN fa_classes k ON k.id = a.class_id LEFT JOIN suppliers s ON s.id = a.supplier_id
      LEFT JOIN gl_classes gc ON gc.id = a.gl_class_id LEFT JOIN gl_accounts fa ON fa.id = a.funding_account_id`;
  const shape = (a) => {
    const accum = r2(n(a.opening_accum) + n(a.depreciated));
    return { ...a, cost: r2(a.cost), salvage: r2(a.salvage), opening_accum: r2(a.opening_accum), rate_pct: a.rate_pct == null ? null : Number(a.rate_pct),
      depreciated: r2(a.depreciated), accumulated: accum, book_value: r2(n(a.cost) - accum) };
  };
  async function loadAsset(id, q = query) {
    const { rows } = await q(ASSET_SQL + ' WHERE a.id = $1', [parseInt(id, 10) || 0]);
    if (!rows.length) throw httpError(404, 'Asset not found');
    return rows[0];
  }
  async function charged(assetId, q = query) {
    return (await q(`SELECT to_char(month, 'YYYY-MM') AS month, amount FROM fa_depreciation WHERE asset_id = $1 ORDER BY month`, [assetId])).rows;
  }
  // A disposal ends depreciation the month before it.
  async function liveDisposal(assetId, q = query) {
    const { rows } = await q(`SELECT *, to_char(disposed_on, 'YYYY-MM-DD') AS disposed_on FROM fa_disposals WHERE asset_id = $1 AND voided_at IS NULL`, [assetId]);
    return rows[0] || null;
  }

  // ------------------------------------------------------------- meta --
  app.get('/api/assets/meta', ...VIEW, async (req, res) => {
    try {
      const { rows: classes } = await query(
        `SELECT k.*, a.code || ' ' || a.name AS asset_account, ad.code || ' ' || ad.name AS accum_account, ex.code || ' ' || ex.name AS expense_account,
                (SELECT COUNT(*)::int FROM fa_assets x WHERE x.class_id = k.id AND x.status = 'active') AS assets
           FROM fa_classes k JOIN gl_accounts a ON a.id = k.asset_account_id LEFT JOIN gl_accounts ad ON ad.id = k.accum_account_id LEFT JOIN gl_accounts ex ON ex.id = k.expense_account_id
          ORDER BY k.name`);
      const { rows: accounts } = await query(
        `SELECT id, code, name, type, qb_type, system_key FROM gl_accounts WHERE is_active AND COALESCE(system_key, '') NOT IN ('ar', 'ap') AND COALESCE(qb_type, '') NOT IN ('AR', 'AP') ORDER BY code`);
      const { rows: glClasses } = await query(`SELECT id, name FROM gl_classes WHERE is_active ORDER BY name`);
      const { rows: suppliers } = await query(`SELECT id, name FROM suppliers WHERE name IS NOT NULL AND name <> '' ORDER BY name LIMIT 3000`);
      const { rows: run } = await query(`SELECT to_char(MAX(month), 'YYYY-MM') AS m FROM fa_runs WHERE voided_at IS NULL`);
      res.json({ classes: classes.map((k) => ({ ...k, rate_pct: k.rate_pct == null ? null : Number(k.rate_pct), salvage_pct: Number(k.salvage_pct) })), accounts, gl_classes: glClasses, suppliers,
        ledger_start: await ledgerStart(), last_run: run[0].m, today: today(), methods: METHODS, funding: FUNDING, disposals: DISPOSALS });
    } catch (e) { fail(res, e); }
  });

  // ----------------------------------------------------------- classes --
  async function cleanClass(b) {
    const out = { name: String(b.name || '').trim().slice(0, 80) };
    if (!out.name) throw httpError(400, 'Give the class a name');
    out.method = METHODS.includes(b.method) ? b.method : 'straight_line';
    const acct = async (v, need, what, types) => {
      if (!v) { if (need) throw httpError(400, 'Choose the ' + what + ' account'); return null; }
      const { rows } = await query(`SELECT id, type FROM gl_accounts WHERE id = $1 AND is_active`, [parseInt(v, 10) || 0]);
      if (!rows.length || !types.includes(rows[0].type)) throw httpError(400, 'Choose an active ' + types.join(' / ') + ' account for the ' + what);
      return rows[0].id;
    };
    const dep = out.method !== 'none';
    out.asset_account_id = await acct(b.asset_account_id, true, 'cost', ['asset']);
    out.accum_account_id = await acct(b.accum_account_id, dep, 'accumulated depreciation', ['asset']);
    out.expense_account_id = await acct(b.expense_account_id, dep, 'depreciation expense', ['expense', 'other_expense', 'cogs']);
    if (out.accum_account_id && out.accum_account_id === out.asset_account_id) throw httpError(400, 'Cost and accumulated depreciation need different accounts');
    out.life_months = b.life_months === '' || b.life_months == null ? null : parseInt(b.life_months, 10);
    if (out.method === 'straight_line' && !(out.life_months >= 1 && out.life_months <= 1200)) throw httpError(400, 'Give the usual life in months (1 to 1200)');
    out.rate_pct = b.rate_pct === '' || b.rate_pct == null ? null : Number(b.rate_pct);
    if (out.method === 'declining_balance' && !(out.rate_pct > 0 && out.rate_pct <= 100)) throw httpError(400, 'Give the yearly rate (%)');
    out.salvage_pct = n(b.salvage_pct);
    if (!(out.salvage_pct >= 0 && out.salvage_pct < 100)) throw httpError(400, 'Salvage is a % of cost, under 100');
    if (b.is_active !== undefined) out.is_active = !!b.is_active;
    return out;
  }
  app.post('/api/assets/classes', ...SETUP, async (req, res) => {
    try {
      const k = await cleanClass(req.body || {}), cols = Object.keys(k);
      const { rows } = await query(`INSERT INTO fa_classes (${cols.join(', ')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(', ')}) RETURNING *`, cols.map((c) => k[c]));
      res.json({ class: rows[0] });
    } catch (e) { if (e.code === '23505') e = httpError(409, 'There is already a class with that name'); fail(res, e); }
  });
  app.put('/api/assets/classes/:id', ...SETUP, async (req, res) => {
    try {
      const k = await cleanClass(req.body || {});
      // Assets already depreciated or posted keep the accounts they were posted to.
      const { rows: cur } = await query(`SELECT * FROM fa_classes WHERE id = $1`, [req.params.id]);
      if (!cur.length) throw httpError(404, 'Class not found');
      const { rows: used } = await query(`SELECT EXISTS (SELECT 1 FROM fa_assets WHERE class_id = $1 AND status <> 'void') AS used`, [req.params.id]);
      if (used[0].used && ['asset_account_id', 'accum_account_id', 'expense_account_id'].some((f) => String(k[f] || '') !== String(cur[0][f] || '')))
        throw httpError(409, 'Assets in this class are in the books on its accounts: make a new class for new accounts');
      const cols = Object.keys(k);
      const { rows } = await query(`UPDATE fa_classes SET ${cols.map((c, i) => c + ' = $' + (i + 2)).join(', ')} WHERE id = $1 RETURNING *`, [req.params.id, ...cols.map((c) => k[c])]);
      res.json({ class: rows[0] });
    } catch (e) { if (e.code === '23505') e = httpError(409, 'There is already a class with that name'); fail(res, e); }
  });

  // ---------------------------------------------------------- register --
  app.get('/api/assets', ...VIEW, async (req, res) => {
    try {
      const { rows } = await query(ASSET_SQL + ` ORDER BY a.status = 'void', a.status = 'disposed', a.number`);
      const list = rows.map(shape);
      const live = list.filter((a) => a.status === 'active');
      const through = req.query.through && /^\d{4}-\d{2}$/.test(req.query.through) ? req.query.through : ym(today());
      // What a run through this month would charge, so the screen can say depreciation is behind.
      let due = 0, dueAssets = 0;
      for (const a of live) {
        const d = dueMonths(a, through, await charged(a.id));
        if (d.length) { dueAssets++; due += d.reduce((t, x) => t + x.amount, 0); }
      }
      res.json({ assets: list, totals: { cost: r2(live.reduce((t, a) => t + a.cost, 0)), accumulated: r2(live.reduce((t, a) => t + a.accumulated, 0)),
        book_value: r2(live.reduce((t, a) => t + a.book_value, 0)), count: live.length }, due: { through, amount: r2(due), assets: dueAssets } });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/assets/:id(\\d+)', ...VIEW, async (req, res) => {
    try {
      const a = shape(await loadAsset(req.params.id));
      const done = await charged(a.id);
      const disposal = await liveDisposal(a.id);
      // The schedule: months charged, then what is still to come at today's figures.
      let projected = [];
      if (a.status === 'active') {
        const end = a.method === 'straight_line' ? mAdd(ym(a.in_service_on), n(a.life_months) - 1) : mAdd(ym(today()), 600);
        projected = dueMonths(a, end, done);
      }
      const { rows: entries } = await query(
        `SELECT e.id, e.number, to_char(e.entry_date, 'YYYY-MM-DD') AS entry_date, e.source_kind, e.memo, e.reversed_by,
                (SELECT SUM(l.amount) FROM gl_lines l WHERE l.entry_id = e.id AND l.amount > 0) AS total
           FROM gl_entries e
          WHERE (e.source_kind IN ('fa_acquire', 'fa_acquire_void') AND e.source_id = $1)
             OR (e.source_kind IN ('fa_dispose', 'fa_dispose_void') AND e.source_id IN (SELECT id FROM fa_disposals WHERE asset_id = $1))
             OR (e.source_kind IN ('fa_run', 'fa_run_void') AND e.source_id IN (SELECT DISTINCT run_id FROM fa_depreciation WHERE asset_id = $1))
          ORDER BY e.entry_date, e.id`, [a.id]);
      const { rows: disposals } = await query(`SELECT d.*, to_char(d.disposed_on, 'YYYY-MM-DD') AS disposed_on, g.code || ' ' || g.name AS proceeds_account FROM fa_disposals d LEFT JOIN gl_accounts g ON g.id = d.proceeds_account_id WHERE d.asset_id = $1 ORDER BY d.id`, [a.id]);
      res.json({ asset: a, charged: done.map((d) => ({ month: d.month, amount: r2(d.amount) })), projected, disposal, disposals, entries: entries.map((e) => ({ ...e, total: r2(e.total) })) });
    } catch (e) { fail(res, e); }
  });

  // Fields people may change at any time, and those fixed once the asset is in the books.
  async function cleanAsset(b, cur) {
    const out = {};
    const text = (k, max) => { if (b[k] !== undefined) out[k] = String(b[k] || '').trim().slice(0, max) || null; };
    if (!cur || b.name !== undefined) { out.name = String(b.name || '').trim().slice(0, 120); if (!out.name) throw httpError(400, 'Give the asset a name'); }
    text('description', 500); text('serial_no', 80); text('location', 80); text('custodian', 80); text('reference', 80); text('notes', 1000);
    if (b.supplier_id !== undefined) out.supplier_id = parseInt(b.supplier_id, 10) || null;
    if (b.gl_class_id !== undefined) {
      out.gl_class_id = parseInt(b.gl_class_id, 10) || null;
      if (out.gl_class_id && !(await query(`SELECT 1 FROM gl_classes WHERE id = $1 AND is_active`, [out.gl_class_id])).rows.length) throw httpError(400, 'Choose an active class (or none)');
    }
    const merged = Object.assign({}, cur || {}, b);
    const klass = (await query(`SELECT * FROM fa_classes WHERE id = $1`, [parseInt(merged.class_id, 10) || 0])).rows[0];
    if (!klass || (!cur && !klass.is_active)) throw httpError(400, 'Choose the kind of asset');
    // Depreciation: the class's usual figures unless given.
    out.method = METHODS.includes(merged.method) ? merged.method : klass.method;
    if (klass.method === 'none' && out.method !== 'none') throw httpError(400, klass.name + ' is not depreciated');
    if (out.method !== 'none' && (!klass.accum_account_id || !klass.expense_account_id)) throw httpError(400, klass.name + ' has no depreciation accounts: set them on the class first');
    out.life_months = merged.life_months === '' || merged.life_months == null ? (cur ? null : klass.life_months) : parseInt(merged.life_months, 10);
    if (out.method === 'straight_line' && !(out.life_months >= 1 && out.life_months <= 1200)) throw httpError(400, 'Give the useful life in months (1 to 1200)');
    if (out.method === 'none') out.life_months = null;
    out.rate_pct = merged.rate_pct === '' || merged.rate_pct == null ? (cur ? null : klass.rate_pct) : Number(merged.rate_pct);
    if (out.method === 'declining_balance' && !(out.rate_pct > 0 && out.rate_pct <= 100)) throw httpError(400, 'Give the yearly rate (%) for declining balance');
    if (out.method !== 'declining_balance') out.rate_pct = null;
    // What it cost and how it reached the books.
    const fixed = {};
    fixed.class_id = klass.id;
    fixed.acquired_on = String(merged.acquired_on || '').slice(0, 10);
    if (!isDate(fixed.acquired_on)) throw httpError(400, 'Give the date it was bought');
    if (fixed.acquired_on > today()) throw httpError(400, 'The date bought cannot be in the future');
    fixed.in_service_on = merged.in_service_on ? String(merged.in_service_on).slice(0, 10) : fixed.acquired_on;
    if (!isDate(fixed.in_service_on) || fixed.in_service_on < fixed.acquired_on) throw httpError(400, 'The date it went into use must be on or after the date bought');
    fixed.cost = r2(merged.cost);
    if (!(fixed.cost > 0)) throw httpError(400, 'Give the cost');
    out.salvage = merged.salvage === '' || merged.salvage == null ? r2(fixed.cost * n(klass.salvage_pct) / 100) : r2(merged.salvage);
    if (out.salvage < 0 || out.salvage >= fixed.cost) throw httpError(400, 'Salvage value must be less than the cost');
    fixed.funding = FUNDING.includes(merged.funding) ? merged.funding : null;
    if (!fixed.funding) throw httpError(400, 'Say how it was paid for');
    fixed.funding_account_id = fixed.funding === 'account' ? await plainAccount(merged.funding_account_id, 'it was paid from') : null;
    fixed.opening_accum = r2(merged.opening_accum);
    fixed.opening_through = null;
    if (fixed.opening_accum < 0 || fixed.opening_accum > fixed.cost - out.salvage) throw httpError(400, 'Depreciation already taken cannot be more than cost less salvage');
    if (fixed.opening_accum) {
      const thr = String(merged.opening_through || '').slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(thr) || thr < ym(fixed.in_service_on)) throw httpError(400, 'Say the last month the depreciation already taken covers');
      fixed.opening_through = thr + '-01';
    }
    if (!cur && !fixed.opening_accum && fixed.funding === 'opening' && out.method !== 'none') {
      // Owned before the ledger: unless told otherwise, depreciation to the month before the ledger started.
      const start = await ledgerStart();
      if (start && ym(fixed.in_service_on) < ym(start)) {
        const before = depreciationBefore(Object.assign({}, fixed, out), ym(start));
        if (before.through) { fixed.opening_accum = before.amount; fixed.opening_through = before.through + '-01'; }
      }
    }
    return { out, fixed };
  }

  app.post('/api/assets', ...POST, async (req, res) => {
    try {
      const { out, fixed } = await cleanAsset(req.body || {}, null);
      const a = Object.assign({}, fixed, out, { created_by: req.session.userId || null }), cols = Object.keys(a);
      const id = await tx(async (c) => {
        const { rows } = await c.query(`INSERT INTO fa_assets (${cols.join(', ')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(', ')}) RETURNING id`, cols.map((k) => a[k]));
        await c.query(`UPDATE fa_assets SET number = 'FA-' || lpad(id::text, 4, '0') WHERE id = $1`, [rows[0].id]);
        return rows[0].id;
      });
      await post();
      res.json({ asset: shape(await loadAsset(id)) });
    } catch (e) { fail(res, e); }
  });

  app.put('/api/assets/:id(\\d+)', ...POST, async (req, res) => {
    try {
      const cur = await loadAsset(req.params.id);
      if (cur.status !== 'active') throw httpError(409, 'This asset is ' + cur.status + ': it can no longer change');
      const b = req.body || {};
      const { out, fixed } = await cleanAsset(b, cur);
      // Once in the books (posted, or depreciation charged), cost and how it was paid for stay as posted.
      const done = await charged(cur.id);
      const locked = cur.posted || done.length;
      const changes = Object.assign({}, out);
      const same = (k) => String(fixed[k] == null ? '' : fixed[k]).slice(0, 10) === String(cur[k] == null ? '' : (k === 'opening_through' ? cur[k] + '-01' : cur[k])).slice(0, 10)
        || (['cost', 'opening_accum'].includes(k) && r2(fixed[k]) === r2(cur[k]));
      for (const k of Object.keys(fixed)) {
        if (same(k)) continue;
        if (locked && ['class_id', 'cost', 'funding', 'funding_account_id', 'opening_accum', 'opening_through', 'acquired_on'].includes(k))
          throw httpError(409, 'The asset is in the books: its cost, class and how it was paid for cannot change. Void it and enter it again if nothing has been depreciated, or post a journal.');
        if (done.length && k === 'in_service_on') throw httpError(409, 'Depreciation has been charged from the date it went into use: that date cannot change now');
        changes[k] = fixed[k];
      }
      if (done.length && r2(changes.salvage) > r2(n(cur.cost) - n(cur.opening_accum) - done.reduce((t, d) => t + n(d.amount), 0)))
        throw httpError(409, 'Salvage cannot be more than the book value now');
      const cols = Object.keys(changes);
      if (cols.length) await query(`UPDATE fa_assets SET ${cols.map((k, i) => k + ' = $' + (i + 2)).join(', ')} WHERE id = $1`, [cur.id, ...cols.map((k) => changes[k])]);
      res.json({ asset: shape(await loadAsset(cur.id)) });
    } catch (e) { fail(res, e); }
  });

  // Entered by mistake: only while nothing has been depreciated or disposed. The ledger reverses its cost entry.
  app.post('/api/assets/:id(\\d+)/void', ...POST, async (req, res) => {
    try {
      const reason = String((req.body || {}).reason || '').trim().slice(0, 200);
      if (reason.length < 3) throw httpError(400, 'Say why it is being voided');
      await tx(async (c) => {
        const { rows } = await c.query(`SELECT * FROM fa_assets WHERE id = $1 FOR UPDATE`, [req.params.id]);
        if (!rows.length) throw httpError(404, 'Asset not found');
        if (rows[0].status !== 'active') throw httpError(409, 'This asset is ' + rows[0].status);
        if ((await charged(rows[0].id, c.query.bind(c))).length) throw httpError(409, 'Depreciation has been charged on it: dispose of it (written off) instead');
        await c.query(`UPDATE fa_assets SET status = 'void', voided_at = NOW(), voided_by = $2, void_reason = $3 WHERE id = $1`, [rows[0].id, req.session.userId || null, reason]);
      });
      await post();
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------- depreciation --
  // What a run through a month would charge: [{asset, months:[{month, amount}]}].
  async function runPlan(through, q = query) {
    const { rows } = await q(ASSET_SQL + ` WHERE a.status IN ('active', 'disposed') AND a.method <> 'none' ORDER BY a.number`);
    const plan = [];
    for (const a of rows) {
      let upto = through;
      const disp = a.status === 'disposed' ? await liveDisposal(a.id, q) : null;
      if (disp) { const before = mAdd(ym(disp.disposed_on), -1); if (before < upto) upto = before; }
      const months = dueMonths(a, upto, await charged(a.id, q));
      if (months.length) plan.push({ asset_id: a.id, number: a.number, name: a.name, class_name: a.class_name, months, amount: r2(months.reduce((t, m) => t + m.amount, 0)) });
    }
    return plan;
  }
  async function checkRunMonth(m) {
    if (!/^\d{4}-\d{2}$/.test(m || '')) throw httpError(400, 'Which month (YYYY-MM)?');
    if (m > ym(today())) throw httpError(400, 'That month has not started yet');
    const start = await ledgerStart();
    if (!start) throw httpError(409, 'Start the ledger (Accounting) before running depreciation');
    if (m < ym(start)) throw httpError(400, 'The ledger started ' + start + ': depreciation before that belongs in each asset\'s depreciation already taken');
    const { rows: shut } = await query(`SELECT 1 FROM gl_periods WHERE month = ($1 || '-01')::date`, [m]);
    if (shut.length) throw httpError(409, 'The books for ' + m + ' are closed');
  }
  app.get('/api/assets/runs', ...VIEW, async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT r.*, to_char(r.month, 'YYYY-MM') AS month, u.name AS created_by_name, e.number AS entry_number, e.id AS entry_id
           FROM fa_runs r LEFT JOIN users u ON u.id = r.created_by LEFT JOIN gl_entries e ON e.source_kind = 'fa_run' AND e.source_id = r.id
          ORDER BY r.id DESC LIMIT 200`);
      res.json({ runs: rows.map((r) => ({ ...r, total: r2(r.total) })) });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/assets/runs/preview', ...VIEW, async (req, res) => {
    try {
      const m = String(req.query.month || '');
      await checkRunMonth(m);
      const plan = await runPlan(m);
      res.json({ month: m, plan, total: r2(plan.reduce((t, p) => t + p.amount, 0)) });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/assets/runs', ...POST, async (req, res) => {
    try {
      const m = String((req.body || {}).month || '');
      await checkRunMonth(m);
      const out = await tx(async (c) => {
        await c.query(`SELECT pg_advisory_xact_lock(hashtext('fa_runs'))`);   // one run at a time
        const plan = await runPlan(m, c.query.bind(c));
        if (!plan.length) throw httpError(409, 'Nothing to depreciate through ' + m + ': every asset is charged up to date');
        const total = r2(plan.reduce((t, p) => t + p.amount, 0));
        const { rows } = await c.query(`INSERT INTO fa_runs (month, total, assets, created_by) VALUES (($1 || '-01')::date, $2, $3, $4) RETURNING id`, [m, total, plan.length, req.session.userId || null]);
        for (const p of plan) for (const x of p.months)
          await c.query(`INSERT INTO fa_depreciation (run_id, asset_id, month, amount) VALUES ($1, $2, ($3 || '-01')::date, $4)`, [rows[0].id, p.asset_id, x.month, x.amount]);
        return { id: rows[0].id, total, assets: plan.length };
      });
      await post();
      res.json(out);
    } catch (e) { fail(res, e); }
  });
  // Only the latest run: earlier ones would leave a gap the next run would not refill.
  app.post('/api/assets/runs/:id(\\d+)/void', ...POST, async (req, res) => {
    try {
      const reason = String((req.body || {}).reason || '').trim().slice(0, 200);
      if (reason.length < 3) throw httpError(400, 'Say why the run is being voided');
      await tx(async (c) => {
        await c.query(`SELECT pg_advisory_xact_lock(hashtext('fa_runs'))`);
        const { rows } = await c.query(`SELECT id FROM fa_runs WHERE voided_at IS NULL ORDER BY id DESC LIMIT 1`);
        if (!rows.length || String(rows[0].id) !== String(req.params.id)) throw httpError(409, 'Only the latest depreciation run can be voided');
        const { rows: disp } = await c.query(`SELECT a.number FROM fa_disposals d JOIN fa_assets a ON a.id = d.asset_id WHERE d.voided_at IS NULL AND d.asset_id IN (SELECT asset_id FROM fa_depreciation WHERE run_id = $1) LIMIT 1`, [rows[0].id]);
        if (disp.length) throw httpError(409, disp[0].number + ' has been disposed of since: void that disposal first');
        await c.query(`DELETE FROM fa_depreciation WHERE run_id = $1`, [rows[0].id]);
        await c.query(`UPDATE fa_runs SET voided_at = NOW(), voided_by = $2, void_reason = $3 WHERE id = $1`, [rows[0].id, req.session.userId || null, reason]);
      });
      await post();
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ---------------------------------------------------------- disposal --
  app.post('/api/assets/:id(\\d+)/dispose', ...POST, async (req, res) => {
    try {
      const b = req.body || {};
      const day = String(b.disposed_on || '').slice(0, 10);
      if (!isDate(day)) throw httpError(400, 'Give the date');
      if (day > today()) throw httpError(400, 'The date cannot be in the future');
      const kind = DISPOSALS.includes(b.kind) ? b.kind : null;
      if (!kind) throw httpError(400, 'Say what happened to it (sold, scrapped...)');
      const proceeds = r2(b.proceeds);
      if (proceeds < 0) throw httpError(400, 'The amount received cannot be negative');
      const acct = proceeds ? await plainAccount(b.proceeds_account_id, 'the money went to') : null;
      const start = await ledgerStart();
      if (!start) throw httpError(409, 'Start the ledger (Accounting) first');
      const { rows: shut } = await query(`SELECT 1 FROM gl_periods WHERE month = date_trunc('month', $1::date)::date`, [day]);
      if (shut.length) throw httpError(409, 'The books for that month are closed');
      const id = await tx(async (c) => {
        await c.query(`SELECT pg_advisory_xact_lock(hashtext('fa_runs'))`);
        const { rows } = await c.query(ASSET_SQL + ' WHERE a.id = $1 FOR UPDATE OF a', [req.params.id]);
        if (!rows.length) throw httpError(404, 'Asset not found');
        const a = rows[0];
        if (a.status !== 'active') throw httpError(409, 'This asset is ' + a.status);
        if (day < a.acquired_on) throw httpError(400, 'It cannot go before it was bought (' + a.acquired_on + ')');
        const done = await charged(a.id, c.query.bind(c));
        if (done.some((d) => d.month >= ym(day))) throw httpError(409, 'Depreciation has been charged for ' + ym(day) + ' or later: void that run first, or give a later date');
        const owing = dueMonths(a, mAdd(ym(day), -1), done);
        if (owing.length) throw httpError(409, 'Run depreciation through ' + owing[owing.length - 1].month + ' first (' + owing.length + ' month' + (owing.length > 1 ? 's' : '') + ' not charged yet)');
        const accum = r2(n(a.opening_accum) + done.reduce((t, d) => t + n(d.amount), 0));
        const { rows: d } = await c.query(
          `INSERT INTO fa_disposals (asset_id, disposed_on, kind, proceeds, proceeds_account_id, accum_at, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [a.id, day, kind, proceeds, acct, accum, String(b.note || '').slice(0, 500) || null, req.session.userId || null]);
        await c.query(`UPDATE fa_assets SET status = 'disposed' WHERE id = $1`, [a.id]);
        return d[0].id;
      });
      await post();
      res.json({ id, asset: shape(await loadAsset(req.params.id)) });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/assets/disposals/:id(\\d+)/void', ...POST, async (req, res) => {
    try {
      const reason = String((req.body || {}).reason || '').trim().slice(0, 200);
      if (reason.length < 3) throw httpError(400, 'Say why the disposal is being voided');
      await tx(async (c) => {
        const { rows } = await c.query(`SELECT * FROM fa_disposals WHERE id = $1 AND voided_at IS NULL FOR UPDATE`, [req.params.id]);
        if (!rows.length) throw httpError(404, 'Disposal not found');
        await c.query(`UPDATE fa_disposals SET voided_at = NOW(), voided_by = $2, void_reason = $3 WHERE id = $1`, [rows[0].id, req.session.userId || null, reason]);
        await c.query(`UPDATE fa_assets SET status = 'active' WHERE id = $1`, [rows[0].asset_id]);
      });
      await post();
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------------ report --
  // The fixed asset schedule for a period, by class: cost at the start, bought,
  // disposed of, cost at the end; depreciation at the start, charged, taken
  // off on disposal, at the end; book value.
  app.get('/api/assets/report', ...VIEW, async (req, res) => {
    try {
      const from = String(req.query.from || ''), to = String(req.query.to || '');
      if (!isDate(from) || !isDate(to) || from > to) throw httpError(400, 'Choose a from and to date');
      const { rows: assets } = await query(
        `SELECT a.id, a.class_id, k.name AS class_name, a.cost, a.opening_accum, to_char(a.acquired_on, 'YYYY-MM-DD') AS acquired_on,
                (SELECT to_char(d.disposed_on, 'YYYY-MM-DD') FROM fa_disposals d WHERE d.asset_id = a.id AND d.voided_at IS NULL) AS disposed_on,
                (SELECT d.accum_at FROM fa_disposals d WHERE d.asset_id = a.id AND d.voided_at IS NULL) AS accum_at,
                COALESCE((SELECT SUM(x.amount) FROM fa_depreciation x WHERE x.asset_id = a.id AND x.month < date_trunc('month', $1::date)), 0) AS dep_before,
                COALESCE((SELECT SUM(x.amount) FROM fa_depreciation x WHERE x.asset_id = a.id AND x.month >= date_trunc('month', $1::date) AND x.month <= date_trunc('month', $2::date)), 0) AS dep_in
           FROM fa_assets a JOIN fa_classes k ON k.id = a.class_id WHERE a.status <> 'void' AND a.acquired_on <= $2`, [from, to]);
      const by = {};
      const blank = (k) => ({ class_id: k.class_id, class_name: k.class_name, cost_open: 0, additions: 0, cost_disposed: 0, cost_close: 0, accum_open: 0, charge: 0, accum_disposed: 0, accum_close: 0 });
      for (const a of assets) {
        if (a.disposed_on && a.disposed_on < from) continue;   // gone before the period
        const s = by[a.class_id] = by[a.class_id] || blank(a);
        const isNew = a.acquired_on >= from, gone = a.disposed_on && a.disposed_on <= to;
        if (isNew) s.additions += n(a.cost); else s.cost_open += n(a.cost);
        // Depreciation already taken when it came into the register is brought forward, not charged in the period.
        s.accum_open += n(a.opening_accum) + (isNew ? 0 : n(a.dep_before));
        s.charge += n(a.dep_in) + (isNew ? n(a.dep_before) : 0);
        if (gone) { s.cost_disposed += n(a.cost); s.accum_disposed += n(a.accum_at); }
      }
      const rows = Object.values(by).map((s) => {
        for (const k of Object.keys(s)) if (typeof s[k] === 'number' && k !== 'class_id') s[k] = r2(s[k]);
        s.cost_close = r2(s.cost_open + s.additions - s.cost_disposed);
        s.accum_close = r2(s.accum_open + s.charge - s.accum_disposed);
        s.book_value = r2(s.cost_close - s.accum_close);
        return s;
      }).sort((a, b) => a.class_name.localeCompare(b.class_name));
      const tot = {};
      for (const k of ['cost_open', 'additions', 'cost_disposed', 'cost_close', 'accum_open', 'charge', 'accum_disposed', 'accum_close', 'book_value']) tot[k] = r2(rows.reduce((t, r) => t + r[k], 0));
      res.json({ from, to, rows, totals: tot });
    } catch (e) { fail(res, e); }
  });
}

module.exports = { register, monthCharge, dueMonths, depreciationBefore, mAdd };
