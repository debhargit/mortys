'use strict';
// =============================================================================
//  Morty's Auto Parts -- asset register: investments, the share register,
//  loans and contracts on assets, and the company net worth report
//
//  Mounted by server.js:  require('./capital').register(app, deps)
//  Routes under /api/capital. Capabilities: acct.view (registers, net worth),
//  acct.post (investments, shares, shareholders, linking loans to assets),
//  acct.setup (share classes).
//
//  The fixed asset register (assets.js) holds equipment, vehicles, buildings,
//  land and intangibles (software, licences), their cost, depreciation and
//  amortisation, disposals, rentals and running costs. This module adds:
//
//  Investments   a stake in another company or business, bonds, deposits,
//                unit trusts. Held at cost, on the equity method (the share of
//                the investee's profit is added; dividends come off), or at
//                fair value (revalued). Events: more bought, part or all sold
//                (the book value of the part sold comes off, the rest is a gain
//                or loss), revalued, share of profit, dividend, interest. Only
//                the latest event can be voided, so the book value always
//                follows the events in order.
//  Shares        the business's own share register: classes, shareholders,
//                issues, transfers and buy-backs. Holdings and each holder's
//                percentage (of the shares and of the votes) come from it.
//  Asset links   a loan that bought an asset, or is secured on it
//                (loans.asset_id); maintenance and service contracts are
//                recurring bills naming the asset (billing.js).
//  Net worth     /api/capital/networth: what the business owns less what it
//                owes on a date, from the ledger, broken down by the registers
//                (fixed assets, intangibles, investments, loans), with market
//                values where they are known, the share of assets held with
//                others, the equity in each asset after its loans, each
//                shareholder's part, and a 12-month trend.
//
//  Every posting is made by gl.js (inv_acquire, inv_event, share_txn and their
//  _void); glPost() runs it straight after a save so the ledger shows it.
// =============================================================================

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const r4 = (v) => Math.round((Number(v) || 0) * 10000) / 10000;
const n = (v) => (v == null || v === '' ? 0 : Number(v));

const INV_KINDS = { company_shares: 'Shares in a company', partnership: 'Partnership stake', joint_venture: 'Joint venture', bonds: 'Bonds', fixed_deposit: 'Fixed deposit', unit_trust: 'Unit trust / fund', property: 'Investment property', other: 'Other' };
const BUSINESS_KINDS = ['company_shares', 'partnership', 'joint_venture'];
const METHODS = { cost: 'At cost', equity: 'Equity method (share of profit)', fair_value: 'At fair value (revalued)' };
const EVENTS = { buy: 'Bought more', sell: 'Sold', revalue: 'Revalued', share_of_profit: 'Share of profit / loss', dividend: 'Dividend received', interest: 'Interest received' };
const SHARE_KINDS = { opening: 'Held before (opening)', issue: 'Issued', transfer: 'Transferred', buyback: 'Bought back' };

// Where a holding stands after its events (in date order): shares, stake,
// book value, and what it has earned. `sold` is the fraction of the holding
// each sale took, for the next sale's book value.
function invState(i, events) {
  const s = { shares: n(i.shares), stake: n(i.stake_pct), carrying: n(i.cost), bought: n(i.cost), income: 0, realised: 0, revalued: 0, profit_share: 0, proceeds: 0, last_date: null };
  for (const e of events) {
    const amt = n(e.amount);
    if (e.kind === 'buy') { s.shares += n(e.shares); s.stake += n(e.stake_pct); s.carrying += amt; s.bought += amt; }
    else if (e.kind === 'sell') { s.shares -= n(e.shares); s.stake -= n(e.stake_pct); s.carrying -= n(e.carrying); s.realised += amt - n(e.carrying); s.proceeds += amt; }
    else if (e.kind === 'revalue') { s.carrying += amt; s.revalued += amt; }
    else if (e.kind === 'share_of_profit') { s.carrying += amt; s.profit_share += amt; }
    else if (e.kind === 'dividend') { s.income += amt; if (i.method === 'equity') s.carrying -= amt; }
    else if (e.kind === 'interest') s.income += amt;
    s.last_date = e.event_date;
  }
  for (const k of ['carrying', 'bought', 'income', 'realised', 'revalued', 'profit_share', 'proceeds']) s[k] = r2(s[k]);
  s.shares = r4(s.shares); s.stake = r4(s.stake);
  // The business's percentage of the investee: its shares of those in issue, or the stake held.
  s.pct = n(i.shares_outstanding) > 0 ? r4(s.shares / n(i.shares_outstanding) * 100) : i.stake_pct != null ? s.stake : null;
  return s;
}

// Holdings per class and shareholder from the share transactions (date order).
// Returns { holdings: {classId: {holderId: shares}}, negative: txn or null }.
function shareHoldings(txns) {
  const h = {};
  let negative = null;
  const add = (c, who, k) => { const x = h[c] = h[c] || {}; x[who] = (x[who] || 0) + k; if (x[who] < 0 && !negative) negative = { holder: who }; };
  for (const t of txns) {
    const k = n(t.shares);
    if (t.kind === 'opening' || t.kind === 'issue') add(t.class_id, t.shareholder_id, k);
    else if (t.kind === 'transfer') { add(t.class_id, t.from_shareholder_id, -k); add(t.class_id, t.shareholder_id, k); }
    else if (t.kind === 'buyback') add(t.class_id, t.from_shareholder_id, -k);
    if (negative && !negative.txn) negative.txn = t;
  }
  return { holdings: h, negative };
}

// The cap table: each holder's shares by class, of all shares and of the votes.
function capTable(classes, holders, holdings) {
  const byClass = {};
  let totalShares = 0, totalVotes = 0;
  for (const k of classes) {
    const x = holdings[k.id] || {};
    const issued = Object.values(x).reduce((t, v) => t + v, 0);
    byClass[k.id] = issued; totalShares += issued; totalVotes += issued * n(k.votes_per_share);
  }
  const rows = [];
  for (const p of holders) {
    const per = {};
    let shares = 0, votes = 0;
    for (const k of classes) { const v = (holdings[k.id] || {})[p.id] || 0; if (v) { per[k.id] = v; shares += v; votes += v * n(k.votes_per_share); } }
    if (!shares) continue;
    rows.push({ shareholder_id: p.id, name: p.name, kind: p.kind, by_class: per, shares, pct: totalShares ? r4(shares / totalShares * 100) : 0, votes, vote_pct: totalVotes ? r4(votes / totalVotes * 100) : 0 });
  }
  rows.sort((a, b) => b.shares - a.shares || a.name.localeCompare(b.name));
  return { rows, by_class: byClass, total_shares: totalShares, total_votes: totalVotes };
}

function register(app, deps) {
  const { query, getPool, requireAdmin, requireCap, glPost } = deps;
  const can = (k) => [requireAdmin, requireCap(k)];
  const VIEW = can('acct.view'), POST = can('acct.post'), SETUP = can('acct.setup');
  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !isNaN(Date.parse(v));
  const today = () => new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10);
  function httpError(status, msg) { const e = new Error(msg); e.status = status; e.publicMessage = msg; return e; }
  function fail(res, e) { if (e.code === '23503') e = httpError(400, 'Something it points at (account, shareholder, class) was not found'); const s = e.status || 500; if (s >= 500) console.error('[capital]', e); res.status(s).json({ error: e.publicMessage || e.message }); }
  async function tx(fn) {
    const c = await getPool().connect();
    try { await c.query('BEGIN'); const out = await fn(c); await c.query('COMMIT'); return out; }
    catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} throw e; }
    finally { c.release(); }
  }
  async function post() {
    if (!glPost) return;
    for (let i = 0; i < 8; i++) {
      try { const r = await glPost(); if (!r || !r.busy) return; } catch (e) { console.warn('[capital] post', e.message); return; }
      await new Promise((ok) => setTimeout(ok, 400));
    }
  }
  async function ledgerStart() {
    const { rows } = await query(`SELECT to_char((value::timestamptz AT TIME ZONE 'America/Jamaica')::date, 'YYYY-MM-DD') AS d FROM warehouse_settings WHERE key = 'gl_start_at' AND value IS NOT NULL`);
    return rows.length ? rows[0].d : null;
  }
  // A date something posts on: not in the future, not in a closed month, not before the ledger started.
  async function postingDate(day, what) {
    if (!isDate(day)) throw httpError(400, 'Give the date' + (what ? ' ' + what : ''));
    if (day > today()) throw httpError(400, 'The date cannot be in the future');
    const start = await ledgerStart();
    if (start && day < start) throw httpError(400, 'The ledger started ' + start + ': anything before then belongs in the opening figures');
    const { rows } = await query(`SELECT 1 FROM gl_periods WHERE month = date_trunc('month', $1::date)::date`, [day]);
    if (rows.length) throw httpError(409, 'The books for ' + day.slice(0, 7) + ' are closed');
    return day;
  }
  // An account money comes from or goes to: active, not A/R or A/P.
  async function plainAccount(id, what, types) {
    const { rows } = await query(`SELECT id, name, type, system_key, qb_type, is_active FROM gl_accounts WHERE id = $1`, [parseInt(id, 10) || 0]);
    const a = rows[0];
    if (!a || !a.is_active) throw httpError(400, 'Choose the account ' + what);
    if (['ar', 'ap'].includes(a.system_key) || ['AR', 'AP'].includes(a.qb_type)) throw httpError(400, 'Use Payables or Receivables for supplier and customer balances, not ' + a.name);
    if (types && !types.includes(a.type)) throw httpError(400, a.name + ' cannot be used ' + what);
    return a.id;
  }
  const sysAccount = async (k) => { const { rows } = await query(`SELECT id FROM gl_accounts WHERE system_key = $1`, [k]); if (!rows.length) throw httpError(500, 'No account set up for ' + k); return rows[0].id; };

  // --------------------------------------------------------------- meta --
  app.get('/api/capital/meta', ...VIEW, async (req, res) => {
    try {
      const { rows: accounts } = await query(
        `SELECT id, code, name, type, qb_type, system_key FROM gl_accounts WHERE is_active AND COALESCE(system_key, '') NOT IN ('ar', 'ap') AND COALESCE(qb_type, '') NOT IN ('AR', 'AP') ORDER BY code`);
      const { rows: classes } = await query(`SELECT *, par_value::float AS par_value, votes_per_share::float AS votes_per_share, authorised::float AS authorised FROM cap_share_classes ORDER BY id`);
      const { rows: holders } = await query(`SELECT * FROM cap_shareholders ORDER BY name`);
      const keys = Object.fromEntries((await query(`SELECT system_key, id FROM gl_accounts WHERE system_key IN ('inv_companies', 'inv_other', 'bank', 'owner_capital', 'opening_equity')`)).rows.map((r) => [r.system_key, r.id]));
      res.json({ accounts, share_classes: classes, shareholders: holders, keys, ledger_start: await ledgerStart(), today: today(),
        investment_kinds: INV_KINDS, business_kinds: BUSINESS_KINDS, methods: METHODS, events: EVENTS, share_kinds: SHARE_KINDS });
    } catch (e) { fail(res, e); }
  });

  // -------------------------------------------------------- investments --
  const INV_SQL = `SELECT i.*, to_char(i.acquired_on, 'YYYY-MM-DD') AS acquired_on, to_char(i.market_value_on, 'YYYY-MM-DD') AS market_value_on,
        i.cost::float AS cost, i.shares::float AS shares, i.shares_outstanding::float AS shares_outstanding, i.stake_pct::float AS stake_pct, i.market_value::float AS market_value,
        a.code || ' ' || a.name AS account, fa.code || ' ' || fa.name AS funding_account,
        EXISTS (SELECT 1 FROM gl_entries e WHERE e.source_kind = 'inv_acquire' AND e.source_id = i.id AND e.reversed_by IS NULL) AS posted
      FROM cap_investments i JOIN gl_accounts a ON a.id = i.account_id LEFT JOIN gl_accounts fa ON fa.id = i.funding_account_id`;
  async function invEvents(id, q = query, asOf = null) {
    return (await q(
      `SELECT e.id, e.kind, to_char(e.event_date, 'YYYY-MM-DD') AS event_date, e.amount::float AS amount, e.shares::float AS shares, e.stake_pct::float AS stake_pct, e.carrying::float AS carrying,
              e.account_id, e.note, e.voided_at, e.void_reason, e.created_at, g.code || ' ' || g.name AS account
         FROM cap_inv_events e LEFT JOIN gl_accounts g ON g.id = e.account_id
        WHERE e.investment_id = $1 AND ($2::date IS NULL OR e.event_date <= $2) ORDER BY e.event_date, e.id`, [id, asOf])).rows;
  }
  const live = (evs) => evs.filter((e) => !e.voided_at);
  function shapeInv(i, evs) {
    const s = invState(i, live(evs));
    const market = i.status === 'active' && i.market_value != null ? r2(i.market_value) : null;
    return Object.assign({}, i, { kind_label: INV_KINDS[i.kind], method_label: METHODS[i.method], state: s, carrying: i.status === 'void' ? 0 : s.carrying,
      market_value: i.market_value == null ? null : r2(i.market_value), value: i.status === 'active' ? (market != null ? market : s.carrying) : 0,
      unrealised: market != null ? r2(market - s.carrying) : null });
  }
  async function loadInv(id, q = query) {
    const { rows } = await q(INV_SQL + ' WHERE i.id = $1', [parseInt(id, 10) || 0]);
    if (!rows.length) throw httpError(404, 'Investment not found');
    return rows[0];
  }

  app.get('/api/capital/investments', ...VIEW, async (req, res) => {
    try {
      const { rows } = await query(INV_SQL + ` ORDER BY i.status = 'void', i.status = 'sold', i.number`);
      const list = [];
      for (const i of rows) list.push(shapeInv(i, await invEvents(i.id)));
      const act = list.filter((x) => x.status === 'active');
      const sum = (f) => r2(act.reduce((t, x) => t + n(f(x)), 0));
      res.json({ investments: list, totals: { count: act.length, cost: sum((x) => x.state.bought), carrying: sum((x) => x.carrying), value: sum((x) => x.value),
        income: r2(list.filter((x) => x.status !== 'void').reduce((t, x) => t + x.state.income, 0)), realised: r2(list.filter((x) => x.status !== 'void').reduce((t, x) => t + x.state.realised, 0)) } });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/capital/investments/:id(\\d+)', ...VIEW, async (req, res) => {
    try {
      const i = await loadInv(req.params.id), evs = await invEvents(i.id);
      const { rows: entries } = await query(
        `SELECT e.id, e.number, to_char(e.entry_date, 'YYYY-MM-DD') AS entry_date, e.source_kind, e.memo, e.reversed_by,
                (SELECT SUM(l.amount) FROM gl_lines l WHERE l.entry_id = e.id AND l.amount > 0)::float AS total
           FROM gl_entries e
          WHERE (e.source_kind IN ('inv_acquire', 'inv_acquire_void') AND e.source_id = $1)
             OR (e.source_kind IN ('inv_event', 'inv_event_void') AND e.source_id IN (SELECT id FROM cap_inv_events WHERE investment_id = $1))
          ORDER BY e.entry_date, e.id`, [i.id]);
      res.json({ investment: shapeInv(i, evs), events: evs.map((e) => Object.assign(e, { label: EVENTS[e.kind] })), entries });
    } catch (e) { fail(res, e); }
  });

  async function cleanInv(b, cur) {
    const out = {};
    const text = (k, max) => { if (b[k] !== undefined) out[k] = String(b[k] || '').trim().slice(0, max) || null; };
    if (!cur || b.name !== undefined) { out.name = String(b.name || '').trim().slice(0, 120); if (!out.name) throw httpError(400, 'Give the name of the company, business or investment'); }
    text('registration_no', 60); text('share_class', 40); text('contact', 200); text('notes', 1000);
    if (b.shares_outstanding !== undefined) {
      out.shares_outstanding = b.shares_outstanding === '' || b.shares_outstanding == null ? null : r4(b.shares_outstanding);
      if (out.shares_outstanding != null && !(out.shares_outstanding > 0)) throw httpError(400, 'Shares in issue must be more than 0 (or left blank)');
    }
    if (b.market_value !== undefined) {
      out.market_value = b.market_value === '' || b.market_value == null ? null : r2(b.market_value);
      if (out.market_value != null && out.market_value < 0) throw httpError(400, 'The market value cannot be negative');
      out.market_value_on = out.market_value == null ? null : isDate(b.market_value_on) ? b.market_value_on : today();
    }
    const m = Object.assign({}, cur || {}, b);
    const fixed = {};
    fixed.kind = INV_KINDS[m.kind] ? m.kind : null;
    if (!fixed.kind) throw httpError(400, 'Say what kind of investment it is');
    fixed.method = METHODS[m.method] ? m.method : 'cost';
    fixed.account_id = m.account_id ? await plainAccount(m.account_id, 'to hold the investment', ['asset']) : await sysAccount(BUSINESS_KINDS.includes(fixed.kind) ? 'inv_companies' : 'inv_other');
    fixed.acquired_on = String(m.acquired_on || '').slice(0, 10);
    if (!isDate(fixed.acquired_on)) throw httpError(400, 'Give the date it was bought');
    if (fixed.acquired_on > today()) throw httpError(400, 'The date bought cannot be in the future');
    fixed.cost = r2(m.cost);
    if (!(fixed.cost > 0)) throw httpError(400, 'Give what it cost');
    fixed.shares = r4(m.shares);
    if (fixed.shares < 0) throw httpError(400, 'Shares cannot be negative');
    fixed.stake_pct = m.stake_pct === '' || m.stake_pct == null ? null : r4(m.stake_pct);
    if (fixed.stake_pct != null && !(fixed.stake_pct > 0 && fixed.stake_pct <= 100)) throw httpError(400, 'The stake is a percentage, more than 0 and up to 100');
    const outstanding = out.shares_outstanding !== undefined ? out.shares_outstanding : cur ? cur.shares_outstanding : null;
    if (outstanding != null && fixed.shares > outstanding) throw httpError(400, 'More shares held than the company has in issue');
    fixed.funding = ['in_ledger', 'account', 'opening'].includes(m.funding) ? m.funding : null;
    if (!fixed.funding) throw httpError(400, 'Say how it was paid for');
    fixed.funding_account_id = fixed.funding === 'account' ? await plainAccount(m.funding_account_id, 'it was paid from') : null;
    if (fixed.funding_account_id && fixed.funding_account_id === fixed.account_id) throw httpError(400, 'It cannot be paid from its own account');
    return { out, fixed };
  }
  app.post('/api/capital/investments', ...POST, async (req, res) => {
    try {
      const { out, fixed } = await cleanInv(req.body || {}, null);
      const row = Object.assign({}, fixed, out, { created_by: req.session.userId || null }), cols = Object.keys(row);
      const id = await tx(async (c) => {
        const { rows } = await c.query(`INSERT INTO cap_investments (${cols.join(', ')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(', ')}) RETURNING id`, cols.map((k) => row[k]));
        await c.query(`UPDATE cap_investments SET number = 'IV-' || lpad(id::text, 4, '0') WHERE id = $1`, [rows[0].id]);
        return rows[0].id;
      });
      await post();
      const i = await loadInv(id);
      res.json({ investment: shapeInv(i, []) });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/capital/investments/:id(\\d+)', ...POST, async (req, res) => {
    try {
      const cur = await loadInv(req.params.id);
      if (cur.status === 'void') throw httpError(409, 'This investment is void');
      const { out, fixed } = await cleanInv(req.body || {}, cur);
      const evs = live(await invEvents(cur.id));
      const changes = Object.assign({}, out);
      const same = (k) => String(fixed[k] == null ? '' : fixed[k]) === String(cur[k] == null ? '' : cur[k]) || (['cost', 'shares', 'stake_pct'].includes(k) && n(fixed[k]) === n(cur[k]));
      for (const k of Object.keys(fixed)) {
        if (same(k)) continue;
        if ((cur.posted || evs.length) && ['account_id', 'acquired_on', 'cost', 'funding', 'funding_account_id'].includes(k))
          throw httpError(409, 'The investment is in the books: what it cost, its account and how it was paid for cannot change. Void it and enter it again if nothing has happened to it since, or post a journal.');
        if (evs.length && ['method', 'shares', 'stake_pct'].includes(k)) throw httpError(409, 'Things have happened to this investment since it was bought: its method and the holding bought cannot change now');
        changes[k] = fixed[k];
      }
      const cols = Object.keys(changes);
      if (cols.length) await query(`UPDATE cap_investments SET ${cols.map((k, i) => k + ' = $' + (i + 2)).join(', ')} WHERE id = $1`, [cur.id, ...cols.map((k) => changes[k])]);
      res.json({ investment: shapeInv(await loadInv(cur.id), await invEvents(cur.id)) });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/capital/investments/:id(\\d+)/void', ...POST, async (req, res) => {
    try {
      const reason = String((req.body || {}).reason || '').trim().slice(0, 200);
      if (reason.length < 3) throw httpError(400, 'Say why it is being voided');
      await tx(async (c) => {
        const { rows } = await c.query(`SELECT * FROM cap_investments WHERE id = $1 FOR UPDATE`, [req.params.id]);
        if (!rows.length) throw httpError(404, 'Investment not found');
        if (rows[0].status === 'void') throw httpError(409, 'Already void');
        const { rows: ev } = await c.query(`SELECT 1 FROM cap_inv_events WHERE investment_id = $1 AND voided_at IS NULL LIMIT 1`, [rows[0].id]);
        if (ev.length) throw httpError(409, 'Things have been recorded against it since: void those first (latest first)');
        await c.query(`UPDATE cap_investments SET status = 'void', voided_at = NOW(), voided_by = $2, void_reason = $3 WHERE id = $1`, [rows[0].id, req.session.userId || null, reason]);
      });
      await post();
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // Something that happened to a holding. Events go in date order.
  app.post('/api/capital/investments/:id(\\d+)/events', ...POST, async (req, res) => {
    try {
      const b = req.body || {};
      const kind = EVENTS[b.kind] ? b.kind : null;
      if (!kind) throw httpError(400, 'Say what happened (bought more, sold, revalued...)');
      const day = await postingDate(String(b.event_date || '').slice(0, 10));
      const amount = r2(b.amount);
      const note = String(b.note || '').trim().slice(0, 300) || null;
      let account = null;
      if (['buy', 'dividend', 'interest'].includes(kind) || (kind === 'sell' && amount > 0)) account = await plainAccount(b.account_id, kind === 'buy' ? 'it was paid from' : 'the money went to');
      const id = await tx(async (c) => {
        const { rows } = await c.query(INV_SQL + ' WHERE i.id = $1 FOR UPDATE OF i', [req.params.id]);
        if (!rows.length) throw httpError(404, 'Investment not found');
        const i = rows[0];
        if (i.status !== 'active') throw httpError(409, 'This investment is ' + i.status);
        if (account && account === i.account_id) throw httpError(400, 'Choose the bank or cash account, not the investment\'s own account');
        if (day < i.acquired_on) throw httpError(400, 'It cannot be before the investment was bought (' + i.acquired_on + ')');
        const evs = live(await invEvents(i.id, c.query.bind(c)));
        const s = invState(i, evs);
        if (s.last_date && day < s.last_date) throw httpError(400, 'Enter things in date order: the last one recorded is dated ' + s.last_date);
        const row = { investment_id: i.id, kind, event_date: day, amount, shares: 0, stake_pct: 0, carrying: 0, account_id: account, note, created_by: req.session.userId || null };
        if (kind === 'buy') {
          if (!(amount > 0)) throw httpError(400, 'Give what was paid');
          row.shares = r4(b.shares); row.stake_pct = r4(b.stake_pct);
          if (row.shares < 0 || row.stake_pct < 0) throw httpError(400, 'Shares and stake bought cannot be negative');
          if (n(i.shares_outstanding) > 0 && s.shares + row.shares > n(i.shares_outstanding) + 0.00005) throw httpError(400, 'That would be more shares than the company has in issue');
          if (s.stake + row.stake_pct > 100.00005) throw httpError(400, 'That would be a stake of more than 100%');
        } else if (kind === 'sell') {
          if (amount < 0) throw httpError(400, 'The amount received cannot be negative');
          // How much of the holding is sold: shares, stake points, or (for a holding of neither) a % of it.
          let frac;
          if (s.shares > 0) {
            row.shares = r4(b.shares);
            if (!(row.shares > 0)) throw httpError(400, 'How many shares were sold?');
            if (row.shares > s.shares + 0.00005) throw httpError(400, 'Only ' + s.shares + ' shares are held');
            frac = row.shares / s.shares;
          } else if (s.stake > 0) {
            row.stake_pct = r4(b.stake_pct);
            if (!(row.stake_pct > 0)) throw httpError(400, 'How many points of the business were sold (e.g. 10 of a 30% stake)?');
            if (row.stake_pct > s.stake + 0.00005) throw httpError(400, 'Only a ' + s.stake + '% stake is held');
            frac = row.stake_pct / s.stake;
          } else {
            const p = b.portion_pct === '' || b.portion_pct == null ? 100 : n(b.portion_pct);
            if (!(p > 0 && p <= 100)) throw httpError(400, 'Say what share of the holding was sold (1 to 100%)');
            frac = p / 100;
          }
          if (frac > 0.99999) frac = 1;
          row.carrying = frac === 1 ? s.carrying : r2(s.carrying * frac);
          if (frac === 1) { row.shares = s.shares; row.stake_pct = s.stake; }
          row.full = frac === 1;
        } else if (kind === 'revalue') {
          // A new value for the holding: the change is posted.
          if (b.new_value === undefined || b.new_value === '' || b.new_value == null) throw httpError(400, 'Give the holding\'s value now');
          const nv = r2(b.new_value);
          if (nv < 0) throw httpError(400, 'A value cannot be negative');
          row.amount = r2(nv - s.carrying);
          if (!row.amount) throw httpError(400, 'That is its book value already');
          if (i.method !== 'fair_value' && row.amount > 0) throw httpError(400, 'A holding ' + (i.method === 'equity' ? 'on the equity method' : 'at cost') + ' can only be written down (impaired), not up. Record the share of profit, or change the method to fair value');
        } else if (kind === 'share_of_profit') {
          if (i.method !== 'equity') throw httpError(400, 'A share of profit is recorded only for a holding on the equity method');
          if (!amount) throw httpError(400, 'Give the share of the profit (negative for a loss)');
          if (s.carrying + amount < 0) throw httpError(400, 'A loss cannot take the holding below nothing');
        } else {
          if (!(amount > 0)) throw httpError(400, 'Give what was received');
          if (kind === 'dividend' && i.method === 'equity' && amount > s.carrying + 0.005) throw httpError(400, 'On the equity method a dividend comes off the holding: it cannot be more than its book value (' + s.carrying + ')');
        }
        const full = row.full; delete row.full;
        const cols = Object.keys(row);
        const { rows: ins } = await c.query(`INSERT INTO cap_inv_events (${cols.join(', ')}) VALUES (${cols.map((_, k) => '$' + (k + 1)).join(', ')}) RETURNING id`, cols.map((k) => row[k]));
        if (full) await c.query(`UPDATE cap_investments SET status = 'sold' WHERE id = $1`, [i.id]);
        return ins[0].id;
      });
      await post();
      const i = await loadInv(req.params.id);
      res.json({ id, investment: shapeInv(i, await invEvents(i.id)) });
    } catch (e) { fail(res, e); }
  });
  // Only the latest event of a holding, so its book value always follows the events in order.
  app.post('/api/capital/inv-events/:id(\\d+)/void', ...POST, async (req, res) => {
    try {
      const reason = String((req.body || {}).reason || '').trim().slice(0, 200);
      if (reason.length < 3) throw httpError(400, 'Say why it is being voided');
      await tx(async (c) => {
        const { rows } = await c.query(`SELECT e.*, i.status FROM cap_inv_events e JOIN cap_investments i ON i.id = e.investment_id WHERE e.id = $1 FOR UPDATE OF e, i`, [req.params.id]);
        if (!rows.length || rows[0].voided_at) throw httpError(404, 'Not found, or already void');
        const { rows: last } = await c.query(`SELECT id FROM cap_inv_events WHERE investment_id = $1 AND voided_at IS NULL ORDER BY event_date DESC, id DESC LIMIT 1`, [rows[0].investment_id]);
        if (String(last[0].id) !== String(rows[0].id)) throw httpError(409, 'Only the latest thing recorded on a holding can be voided: void the later ones first');
        const { rows: shut } = await c.query(`SELECT 1 FROM gl_periods WHERE month = date_trunc('month', $1::date)::date`, [rows[0].event_date]);
        if (shut.length) throw httpError(409, 'The books for that month are closed: post a correcting entry instead');
        await c.query(`UPDATE cap_inv_events SET voided_at = NOW(), voided_by = $2, void_reason = $3 WHERE id = $1`, [rows[0].id, req.session.userId || null, reason]);
        if (rows[0].kind === 'sell' && rows[0].status === 'sold') await c.query(`UPDATE cap_investments SET status = 'active' WHERE id = $1`, [rows[0].investment_id]);
      });
      await post();
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------ share register --
  async function shareTxns(q = query, asOf = null) {
    return (await q(
      `SELECT t.id, t.number, t.kind, t.class_id, to_char(t.txn_date, 'YYYY-MM-DD') AS txn_date, t.shareholder_id, t.from_shareholder_id, t.shares::float AS shares, t.price::float AS price,
              t.amount::float AS amount, t.capital::float AS capital, t.account_id, t.certificate_no, t.note, t.voided_at, t.void_reason, t.created_at,
              k.name AS class_name, h.name AS holder, f.name AS from_holder, g.code || ' ' || g.name AS account
         FROM cap_share_txns t JOIN cap_share_classes k ON k.id = t.class_id LEFT JOIN cap_shareholders h ON h.id = t.shareholder_id
         LEFT JOIN cap_shareholders f ON f.id = t.from_shareholder_id LEFT JOIN gl_accounts g ON g.id = t.account_id
        WHERE ($1::date IS NULL OR t.txn_date <= $1) ORDER BY t.txn_date, t.id`, [asOf])).rows;
  }
  async function shareState(asOf = null) {
    const { rows: classes } = await query(`SELECT *, par_value::float AS par_value, votes_per_share::float AS votes_per_share, authorised::float AS authorised FROM cap_share_classes ORDER BY id`);
    const { rows: holders } = await query(`SELECT * FROM cap_shareholders ORDER BY name`);
    const txns = await shareTxns(query, asOf);
    const { holdings } = shareHoldings(live(txns));
    const table = capTable(classes, holders, holdings);
    // Paid in per class: issues, less the capital bought back.
    for (const k of classes) {
      const t = live(txns).filter((x) => x.class_id === k.id);
      k.issued = table.by_class[k.id] || 0;
      k.paid_in = r2(t.reduce((s, x) => s + (x.kind === 'issue' ? x.amount : x.kind === 'buyback' ? -x.capital : 0), 0));
    }
    return { classes, holders, txns, table };
  }
  app.get('/api/capital/shares', ...VIEW, async (req, res) => {
    try {
      const asOf = isDate(req.query.as_of) ? req.query.as_of : null;
      const s = await shareState(asOf);
      const { rows: gl } = await query(`SELECT COALESCE(-SUM(l.amount), 0)::float AS v FROM gl_lines l JOIN gl_accounts a ON a.id = l.account_id JOIN gl_entries e ON e.id = l.entry_id
                                          WHERE a.system_key IN ('share_capital', 'share_premium') AND ($1::date IS NULL OR e.entry_date <= $1)`, [asOf]);
      res.json({ as_of: asOf, classes: s.classes, shareholders: s.holders, txns: s.txns.map((t) => Object.assign(t, { label: SHARE_KINDS[t.kind] })).reverse(), cap_table: s.table,
        paid_in: r2(s.classes.reduce((t, k) => t + k.paid_in, 0)), ledger_capital: r2(gl[0].v) });
    } catch (e) { fail(res, e); }
  });

  function cleanClass(b) {
    const out = { name: String(b.name || '').trim().slice(0, 60) };
    if (!out.name) throw httpError(400, 'Give the class a name (e.g. Ordinary)');
    out.par_value = r4(b.par_value); if (out.par_value < 0) throw httpError(400, 'Par value cannot be negative');
    out.votes_per_share = b.votes_per_share === '' || b.votes_per_share == null ? 1 : r4(b.votes_per_share); if (out.votes_per_share < 0) throw httpError(400, 'Votes cannot be negative');
    out.authorised = b.authorised === '' || b.authorised == null ? null : Math.floor(n(b.authorised)); if (out.authorised != null && !(out.authorised > 0)) throw httpError(400, 'Authorised shares must be more than 0 (or blank for no limit)');
    out.rights = String(b.rights || '').trim().slice(0, 500) || null;
    if (b.is_active !== undefined) out.is_active = !!b.is_active;
    return out;
  }
  app.post('/api/capital/share-classes', ...SETUP, async (req, res) => {
    try {
      const k = cleanClass(req.body || {}), cols = Object.keys(k);
      const { rows } = await query(`INSERT INTO cap_share_classes (${cols.join(', ')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(', ')}) RETURNING id`, cols.map((c) => k[c]));
      res.json({ id: rows[0].id });
    } catch (e) { if (e.code === '23505') e = httpError(409, 'There is already a class with that name'); fail(res, e); }
  });
  app.put('/api/capital/share-classes/:id(\\d+)', ...SETUP, async (req, res) => {
    try {
      const k = cleanClass(req.body || {});
      const { rows: cur } = await query(`SELECT * FROM cap_share_classes WHERE id = $1`, [req.params.id]);
      if (!cur.length) throw httpError(404, 'Class not found');
      // Par value decides how issues posted; it stays once shares have been issued.
      const { rows: used } = await query(`SELECT EXISTS (SELECT 1 FROM cap_share_txns WHERE class_id = $1 AND voided_at IS NULL AND kind = 'issue') AS u`, [cur[0].id]);
      if (used[0].u && n(k.par_value) !== n(cur[0].par_value)) throw httpError(409, 'Shares of this class have been issued on its par value: it cannot change now');
      if (k.authorised != null) {
        const s = await shareState();
        const issued = s.classes.find((x) => x.id === cur[0].id).issued;
        if (issued > k.authorised) throw httpError(409, issued + ' shares of this class are in issue: the authorised number cannot be lower');
      }
      const cols = Object.keys(k);
      await query(`UPDATE cap_share_classes SET ${cols.map((c, i) => c + ' = $' + (i + 2)).join(', ')} WHERE id = $1`, [cur[0].id, ...cols.map((c) => k[c])]);
      res.json({ ok: true });
    } catch (e) { if (e.code === '23505') e = httpError(409, 'There is already a class with that name'); fail(res, e); }
  });

  function cleanHolder(b) {
    const out = { name: String(b.name || '').trim().slice(0, 120) };
    if (!out.name) throw httpError(400, 'Give the shareholder\'s name');
    out.kind = ['person', 'company', 'trust'].includes(b.kind) ? b.kind : 'person';
    for (const [k, max] of [['id_no', 40], ['email', 120], ['phone', 40], ['address', 300], ['notes', 1000]]) out[k] = String(b[k] || '').trim().slice(0, max) || null;
    if (out.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(out.email)) throw httpError(400, 'That email address does not look right');
    return out;
  }
  app.post('/api/capital/shareholders', ...POST, async (req, res) => {
    try {
      const h = cleanHolder(req.body || {}), cols = Object.keys(h);
      const { rows } = await query(`INSERT INTO cap_shareholders (${cols.join(', ')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(', ')}) RETURNING id`, cols.map((c) => h[c]));
      res.json({ id: rows[0].id });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/capital/shareholders/:id(\\d+)', ...POST, async (req, res) => {
    try {
      const h = cleanHolder(req.body || {}), cols = Object.keys(h);
      const { rowCount } = await query(`UPDATE cap_shareholders SET ${cols.map((c, i) => c + ' = $' + (i + 2)).join(', ')} WHERE id = $1`, [req.params.id, ...cols.map((c) => h[c])]);
      if (!rowCount) throw httpError(404, 'Shareholder not found');
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/capital/share-txns', ...POST, async (req, res) => {
    try {
      const b = req.body || {};
      const kind = SHARE_KINDS[b.kind] ? b.kind : null;
      if (!kind) throw httpError(400, 'Say what happened (issued, transferred, bought back...)');
      const day = String(b.txn_date || '').slice(0, 10);
      // Opening holdings and transfers post nothing, so any past date will do; issues and buy-backs post.
      if (['issue', 'buyback'].includes(kind)) await postingDate(day);
      else { if (!isDate(day)) throw httpError(400, 'Give the date'); if (day > today()) throw httpError(400, 'The date cannot be in the future'); }
      const shares = Math.floor(n(b.shares));
      if (!(shares > 0) || shares !== n(b.shares)) throw httpError(400, 'Give the number of shares (a whole number)');
      const price = r4(b.price);
      if (price < 0) throw httpError(400, 'The price cannot be negative');
      const amount = b.amount === '' || b.amount == null ? r2(shares * price) : r2(b.amount);
      if (amount < 0) throw httpError(400, 'The amount cannot be negative');
      const to = ['opening', 'issue', 'transfer'].includes(kind) ? parseInt(b.shareholder_id, 10) || null : null;
      const from = ['transfer', 'buyback'].includes(kind) ? parseInt(b.from_shareholder_id, 10) || null : null;
      if (['opening', 'issue', 'transfer'].includes(kind) && !to) throw httpError(400, 'Choose the shareholder who receives the shares');
      if (['transfer', 'buyback'].includes(kind) && !from) throw httpError(400, 'Choose the shareholder giving up the shares');
      if (to && from && to === from) throw httpError(400, 'A transfer is from one shareholder to another');
      let account = null;
      if (kind === 'issue' && amount > 0) account = await plainAccount(b.account_id, 'the money went to (or Owner\'s Capital, for capital turned into shares)', ['asset', 'equity', 'liability']);
      if (kind === 'buyback' && amount > 0) account = await plainAccount(b.account_id, 'it was paid from', ['asset', 'liability']);
      if (account) {
        const { rows: k } = await query(`SELECT system_key FROM gl_accounts WHERE id = $1`, [account]);
        if (['share_capital', 'share_premium'].includes(k[0].system_key)) throw httpError(400, 'Choose where the money went, not the share capital account itself');
      }
      const id = await tx(async (c) => {
        await c.query(`SELECT pg_advisory_xact_lock(hashtext('cap_share_txns'))`);
        const { rows: cls } = await c.query(`SELECT * FROM cap_share_classes WHERE id = $1`, [parseInt(b.class_id, 10) || 0]);
        if (!cls.length) throw httpError(400, 'Choose the class of shares');
        const k = cls[0];
        if (!k.is_active && ['opening', 'issue'].includes(kind)) throw httpError(400, k.name + ' shares are no longer issued');
        for (const who of [to, from].filter(Boolean)) if (!(await c.query(`SELECT 1 FROM cap_shareholders WHERE id = $1`, [who])).rows.length) throw httpError(400, 'Shareholder not found');
        const txns = live(await shareTxns(c.query.bind(c)));
        const { holdings } = shareHoldings(txns);
        const held = (who) => (holdings[k.id] || {})[who] || 0;
        const issued = Object.values(holdings[k.id] || {}).reduce((t, v) => t + v, 0);
        if (from && held(from) < shares) throw httpError(400, 'They hold only ' + held(from).toLocaleString('en-US') + ' ' + k.name + ' shares');
        if (['opening', 'issue'].includes(kind) && k.authorised != null && issued + shares > n(k.authorised)) throw httpError(400, 'Only ' + (n(k.authorised) - issued).toLocaleString('en-US') + ' more ' + k.name + ' shares are authorised');
        let capital = 0;
        if (kind === 'buyback') {
          // The paid-in capital of the shares bought back, at the class's average; what was paid over or under it goes to retained earnings.
          const paidIn = txns.filter((x) => x.class_id === k.id).reduce((s, x) => s + (x.kind === 'issue' ? x.amount : x.kind === 'buyback' ? -x.capital : 0), 0);
          capital = issued > 0 ? Math.min(amount || Infinity, r2(Math.max(0, paidIn) * shares / issued)) : 0;
          if (!isFinite(capital)) capital = r2(Math.max(0, paidIn) * shares / issued);
          if (!amount) capital = 0;   // given back for nothing: nothing posts
        }
        const { rows } = await c.query(
          `INSERT INTO cap_share_txns (kind, class_id, txn_date, shareholder_id, from_shareholder_id, shares, price, amount, account_id, capital, certificate_no, note, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
          [kind, k.id, day, to, from, shares, price, amount, account, capital,
            String(b.certificate_no || '').trim().slice(0, 40) || null, String(b.note || '').trim().slice(0, 300) || null, req.session.userId || null]);
        await c.query(`UPDATE cap_share_txns SET number = 'SH-' || lpad(id::text, 4, '0') WHERE id = $1`, [rows[0].id]);
        return rows[0].id;
      });
      await post();
      res.json({ id });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/capital/share-txns/:id(\\d+)/void', ...POST, async (req, res) => {
    try {
      const reason = String((req.body || {}).reason || '').trim().slice(0, 200);
      if (reason.length < 3) throw httpError(400, 'Say why it is being voided');
      await tx(async (c) => {
        await c.query(`SELECT pg_advisory_xact_lock(hashtext('cap_share_txns'))`);
        const { rows } = await c.query(`SELECT *, to_char(txn_date, 'YYYY-MM-DD') AS day FROM cap_share_txns WHERE id = $1 AND voided_at IS NULL FOR UPDATE`, [req.params.id]);
        if (!rows.length) throw httpError(404, 'Not found, or already void');
        const t = rows[0];
        if (['issue', 'buyback'].includes(t.kind)) {
          const { rows: shut } = await c.query(`SELECT 1 FROM gl_periods WHERE month = date_trunc('month', $1::date)::date`, [t.day]);
          if (shut.length) throw httpError(409, 'The books for that month are closed');
        }
        // Without it, no one may ever have held fewer than nothing.
        const rest = live(await shareTxns(c.query.bind(c))).filter((x) => x.id !== t.id);
        if (shareHoldings(rest).negative) throw httpError(409, 'Shares from this were passed on or bought back later: void those first');
        await c.query(`UPDATE cap_share_txns SET voided_at = NOW(), voided_by = $2, void_reason = $3 WHERE id = $1`, [t.id, req.session.userId || null, reason]);
      });
      await post();
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // --------------------------------------------- loans linked to assets --
  // Loans the asset page can link (any loan; one asset per loan).
  app.get('/api/capital/loans', ...VIEW, async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT l.id, l.name, l.reference, l.status, l.asset_id, fa.number AS asset_number, s.name AS lender, l.principal::float AS principal,
                (l.principal - COALESCE((SELECT SUM(li.principal) FROM loan_instalments li LEFT JOIN ap_bills b ON b.id = li.ap_bill_id
                                          WHERE li.loan_id = l.id AND li.status = 'billed' AND b.voided_at IS NULL), 0))::float AS balance
           FROM loans l JOIN suppliers s ON s.id = l.supplier_id LEFT JOIN fa_assets fa ON fa.id = l.asset_id ORDER BY (l.status = 'active') DESC, l.id DESC`);
      for (const r of rows) r.balance = r.status === 'cancelled' ? 0 : r2(r.balance);
      res.json({ loans: rows });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/capital/assets/:id(\\d+)/loans', ...POST, async (req, res) => {
    try {
      const b = req.body || {}, loanId = parseInt(b.loan_id, 10) || 0;
      const { rows: a } = await query(`SELECT id, status FROM fa_assets WHERE id = $1`, [req.params.id]);
      if (!a.length) throw httpError(404, 'Asset not found');
      const { rows: l } = await query(`SELECT id, asset_id FROM loans WHERE id = $1`, [loanId]);
      if (!l.length) throw httpError(404, 'Loan not found');
      if (b.unlink) {
        if (String(l[0].asset_id) !== String(a[0].id)) throw httpError(409, 'That loan is not linked to this asset');
        await query(`UPDATE loans SET asset_id = NULL WHERE id = $1`, [loanId]);
      } else {
        if (a[0].status === 'void') throw httpError(409, 'This asset is void');
        if (l[0].asset_id && String(l[0].asset_id) !== String(a[0].id)) throw httpError(409, 'That loan is already linked to another asset: unlink it there first');
        await query(`UPDATE loans SET asset_id = $2 WHERE id = $1`, [loanId, a[0].id]);
      }
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ----------------------------------------------------------- net worth --
  // What the business owns less what it owes on a date, from the ledger, with
  // the registers behind each part. Market values (report only) give a second,
  // adjusted figure.
  async function netWorth(asOf) {
    const MONEY = ['cash_safe', 'cheques', 'card_clearing', 'cash_drawers'];
    const { rows: acc } = await query(
      `SELECT a.id, a.parent_id, a.code, a.name, a.type, a.qb_type, a.system_key, COALESCE(SUM(l.amount), 0)::float AS bal
         FROM gl_accounts a JOIN gl_lines l ON l.account_id = a.id JOIN gl_entries e ON e.id = l.entry_id
        WHERE e.entry_date <= $1 GROUP BY a.id ORDER BY a.code`, [asOf]);
    const ids = async (sql) => new Set((await query(sql)).rows.map((r) => r.id).filter(Boolean));
    const intangible = await ids(`SELECT asset_account_id AS id FROM fa_classes WHERE kind = 'intangible' UNION SELECT accum_account_id FROM fa_classes WHERE kind = 'intangible'`);
    const fixed = await ids(`SELECT asset_account_id AS id FROM fa_classes WHERE kind = 'tangible' UNION SELECT accum_account_id FROM fa_classes WHERE kind = 'tangible'`);
    const invest = await ids(`SELECT account_id AS id FROM cap_investments UNION SELECT id FROM gl_accounts WHERE system_key IN ('inv_companies', 'inv_other')`);
    const loanAccts = await ids(`SELECT liability_account_id AS id FROM loans UNION SELECT id FROM gl_accounts WHERE system_key = 'loans_payable'`);
    const G = {
      cash: ['Cash and bank', 'asset'], ar: ['Customers owe', 'asset'], stock: ['Stock at cost', 'asset'], other_ca: ['Other current assets', 'asset'],
      fixed: ['Fixed assets (cost less depreciation)', 'asset'], intangible: ['Software and other intangibles (cost less amortisation)', 'asset'], investments: ['Investments in other businesses', 'asset'], other_a: ['Other assets', 'asset'],
      cl: ['Current liabilities', 'liability'], loans: ['Loans', 'liability'], ltl: ['Other long-term liabilities', 'liability'], equity: ['Owners\' equity', 'equity'],
    };
    const groups = {};
    for (const k in G) groups[k] = { key: k, label: G[k][0], side: G[k][1], lines: [], total: 0 };
    const put = (k, a, v) => { if (Math.abs(v) < 0.005) return; groups[k].lines.push({ id: a.id, parent_id: a.parent_id, code: a.code, name: a.name, amount: r2(v) }); groups[k].total = r2(groups[k].total + v); };
    let pl = 0;
    for (const a of acc) {
      if (a.type === 'asset') {
        const k = invest.has(a.id) ? 'investments' : intangible.has(a.id) ? 'intangible' : fixed.has(a.id) || a.qb_type === 'FIXASSET' ? 'fixed'
          : a.qb_type === 'BANK' || MONEY.includes(a.system_key) ? 'cash' : a.qb_type === 'AR' ? 'ar' : a.system_key === 'inventory' ? 'stock' : a.qb_type === 'OCASSET' ? 'other_ca' : 'other_a';
        put(k, a, a.bal);
      } else if (a.type === 'liability') put(loanAccts.has(a.id) ? 'loans' : a.qb_type === 'LTLIAB' ? 'ltl' : 'cl', a, -a.bal);
      else if (a.type === 'equity') put('equity', a, -a.bal);
      else pl += a.bal;
    }
    if (Math.abs(pl) >= 0.005) { groups.equity.lines.push({ id: null, code: '', name: 'Profit not yet closed to equity', amount: r2(-pl) }); groups.equity.total = r2(groups.equity.total - pl); }
    const assetKeys = ['cash', 'ar', 'stock', 'other_ca', 'fixed', 'intangible', 'investments', 'other_a'], liabKeys = ['cl', 'loans', 'ltl'];
    const assets = r2(assetKeys.reduce((t, k) => t + groups[k].total, 0)), liabilities = r2(liabKeys.reduce((t, k) => t + groups[k].total, 0));
    const book = r2(assets - liabilities);

    // Fixed assets and intangibles in the register on the date: cost, and depreciation from the runs posted by then
    // (a run is dated the last day of its month, catch-up months included), as the ledger has it.
    const { rows: fa } = await query(
      `SELECT a.id, a.number, a.name, a.class_id, k.name AS class_name, k.kind, a.cost::float AS cost, a.ownership_pct::float AS ownership_pct, a.co_owners,
              a.market_value::float AS market_value, to_char(a.market_value_on, 'YYYY-MM-DD') AS market_value_on, a.status,
              (a.opening_accum + COALESCE((SELECT SUM(d.amount) FROM fa_depreciation d JOIN fa_runs r ON r.id = d.run_id WHERE d.asset_id = a.id AND (r.month + INTERVAL '1 month' - INTERVAL '1 day')::date <= $1), 0))::float AS accum
         FROM fa_assets a JOIN fa_classes k ON k.id = a.class_id
        WHERE a.status <> 'void' AND a.acquired_on <= $1
          AND NOT EXISTS (SELECT 1 FROM fa_disposals d WHERE d.asset_id = a.id AND d.voided_at IS NULL AND d.disposed_on <= $1)
        ORDER BY a.number`, [asOf]);
    const byClass = {};
    for (const a of fa) {
      a.accum = r2(Math.min(a.accum, a.cost)); a.book_value = r2(a.cost - a.accum);
      const x = byClass[a.class_id] = byClass[a.class_id] || { class_id: a.class_id, class_name: a.class_name, kind: a.kind, count: 0, cost: 0, accum: 0, book_value: 0 };
      x.count++; x.cost = r2(x.cost + a.cost); x.accum = r2(x.accum + a.accum); x.book_value = r2(x.book_value + a.book_value);
    }
    const isNow = asOf >= today();
    // Loans on the date: principal less the principal of instalments billed by then.
    const { rows: loans } = await query(
      `SELECT l.id, l.name, l.reference, l.asset_id, s.name AS lender, l.principal::float AS principal, l.annual_rate::float AS annual_rate,
              (l.principal - COALESCE((SELECT SUM(li.principal) FROM loan_instalments li LEFT JOIN ap_bills b ON b.id = li.ap_bill_id
                                        WHERE li.loan_id = l.id AND li.status = 'billed' AND b.voided_at IS NULL AND li.due_date <= $1), 0))::float AS owed
         FROM loans l JOIN suppliers s ON s.id = l.supplier_id
        WHERE l.start_date <= $1 AND (l.status <> 'cancelled' OR l.cancelled_at::date > $1) ORDER BY l.id`, [asOf]);
    for (const l of loans) l.owed = r2(Math.max(0, l.owed));
    // Each asset with loans on it: what the business has in it after them.
    const assetEquity = [];
    for (const a of fa) {
      const on = loans.filter((l) => String(l.asset_id) === String(a.id));
      if (!on.length) continue;
      const owed = r2(on.reduce((t, l) => t + l.owed, 0)), val = isNow && a.market_value != null ? a.market_value : a.book_value;
      assetEquity.push({ asset_id: a.id, number: a.number, name: a.name, book_value: a.book_value, market_value: isNow ? a.market_value : null, owed, equity: r2(val - owed), loans: on.map((l) => ({ id: l.id, name: l.name, lender: l.lender, owed: l.owed })) });
    }
    // Held with others: the business's share and the whole asset.
    const shared = fa.filter((a) => n(a.ownership_pct) < 100).map((a) => ({ asset_id: a.id, number: a.number, name: a.name, ownership_pct: a.ownership_pct, co_owners: a.co_owners,
      book_value: a.book_value, whole_book_value: r2(a.book_value * 100 / n(a.ownership_pct)) }));

    // Investments on the date.
    const { rows: invs } = await query(INV_SQL + ` WHERE i.status <> 'void' AND i.acquired_on <= $1 ORDER BY i.number`, [asOf]);
    const investments = [];
    for (const i of invs) {
      const evs = live(await invEvents(i.id, query, asOf)), s = invState(i, evs);
      // Sold in full by the date: no longer held.
      if (s.carrying === 0 && s.shares <= 0 && s.stake <= 0 && evs.some((e) => e.kind === 'sell')) continue;
      const market = isNow && i.status === 'active' && i.market_value != null ? r2(i.market_value) : null;
      investments.push({ id: i.id, number: i.number, name: i.name, kind: INV_KINDS[i.kind], method: METHODS[i.method], shares: s.shares, pct: s.pct, carrying: s.carrying, market_value: market, market_value_on: market != null ? i.market_value_on : null, income: s.income });
    }

    // Market values (today only): the difference from book.
    const adjustments = [];
    const M = (v) => 'J$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (isNow) {
      for (const a of fa) if (a.market_value != null && r2(a.market_value - a.book_value)) adjustments.push({ kind: 'asset', ref: a.number, label: a.number + ' ' + a.name + ': appraised at ' + M(a.market_value) + (a.market_value_on ? ' on ' + a.market_value_on : '') + ', book value ' + M(a.book_value), amount: r2(a.market_value - a.book_value) });
      for (const i of investments) if (i.market_value != null && r2(i.market_value - i.carrying)) adjustments.push({ kind: 'investment', ref: i.number, label: i.number + ' ' + i.name + ': worth ' + M(i.market_value) + (i.market_value_on ? ' on ' + i.market_value_on : '') + ', book value ' + M(i.carrying), amount: r2(i.market_value - i.carrying) });
    }
    const adjusted = r2(book + adjustments.reduce((t, x) => t + x.amount, 0));

    // Who owns the business, and their part of it.
    const sh = await shareState(asOf);
    const holders = sh.table.rows.map((r) => Object.assign({}, r, { book: r2(book * r.pct / 100), adjusted: r2(adjusted * r.pct / 100) }));

    // The trend: net worth at each of the last 12 month ends (to the date).
    const { rows: mv } = await query(
      `WITH mv AS (SELECT to_char(date_trunc('month', e.entry_date), 'YYYY-MM') AS m,
                          SUM(CASE WHEN a.type = 'asset' THEN l.amount ELSE 0 END) AS da, SUM(CASE WHEN a.type = 'liability' THEN -l.amount ELSE 0 END) AS dl
                     FROM gl_lines l JOIN gl_entries e ON e.id = l.entry_id JOIN gl_accounts a ON a.id = l.account_id WHERE e.entry_date <= $1 GROUP BY 1)
       SELECT m, (SUM(da) OVER (ORDER BY m))::float AS assets, (SUM(dl) OVER (ORDER BY m))::float AS liabilities FROM mv ORDER BY m`, [asOf]);
    const trend = [];
    const mAdd = (m, k) => { const [y, mo] = m.split('-').map(Number), t = y * 12 + mo - 1 + k; return Math.floor(t / 12) + '-' + String(t % 12 + 1).padStart(2, '0'); };
    const lastM = asOf.slice(0, 7);
    let prev = null, j = 0;
    for (let m = mAdd(lastM, -11); m <= lastM; m = mAdd(m, 1)) {
      while (j < mv.length && mv[j].m <= m) { prev = mv[j]; j++; }
      if (prev) trend.push({ month: m, assets: r2(prev.assets), liabilities: r2(prev.liabilities), net_worth: r2(prev.assets - prev.liabilities) });
    }

    // Registers against the ledger.
    const regFixed = r2(Object.values(byClass).filter((c) => c.kind === 'tangible').reduce((t, c) => t + c.book_value, 0));
    const regIntangible = r2(Object.values(byClass).filter((c) => c.kind === 'intangible').reduce((t, c) => t + c.book_value, 0));
    const regInv = r2(investments.reduce((t, i) => t + i.carrying, 0));
    const regLoans = r2(loans.reduce((t, l) => t + l.owed, 0));
    const checks = [
      { key: 'fixed', label: 'Fixed assets', ledger: groups.fixed.total, register: regFixed },
      { key: 'intangible', label: 'Software and intangibles', ledger: groups.intangible.total, register: regIntangible },
      { key: 'investments', label: 'Investments', ledger: groups.investments.total, register: regInv },
      { key: 'loans', label: 'Loans (not yet billed)', ledger: groups.loans.total, register: regLoans },
    ].map((c) => Object.assign(c, { difference: r2(c.ledger - c.register) }));

    return {
      as_of: asOf, is_now: isNow, groups: Object.values(groups), assets, liabilities, net_worth: book, equity: groups.equity.total, balanced: Math.abs(r2(book - groups.equity.total)) < 0.01,
      adjustments, adjusted_net_worth: adjusted,
      fixed_assets: { by_class: Object.values(byClass).sort((a, b) => a.kind.localeCompare(b.kind) || a.class_name.localeCompare(b.class_name)), count: fa.length },
      shared_assets: shared, asset_equity: assetEquity, loans, investments,
      shares: { classes: sh.classes.map((k) => ({ id: k.id, name: k.name, issued: k.issued, paid_in: k.paid_in, votes_per_share: k.votes_per_share })), total_shares: sh.table.total_shares, holders,
        per_share: sh.table.total_shares ? { book: r4(book / sh.table.total_shares), adjusted: r4(adjusted / sh.table.total_shares) } : null },
      trend, checks,
    };
  }
  app.get('/api/capital/networth', ...VIEW, async (req, res) => {
    try {
      const asOf = isDate(req.query.as_of) ? (req.query.as_of > today() ? today() : req.query.as_of) : today();
      if (!(await ledgerStart())) return res.json({ ready: false, as_of: asOf, reason: 'The ledger has not been started (Accounting), so there are no figures yet.' });
      res.json(Object.assign({ ready: true }, await netWorth(asOf)));
    } catch (e) { fail(res, e); }
  });
}

module.exports = { register, invState, shareHoldings, capTable };
