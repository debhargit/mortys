'use strict';
// =============================================================================
//  Vision Auto Solutions -- budgets, cash forecast, break-even and ROI
//
//  Mounted by server.js:  require('./budget').register(app, deps)
//  Tables in schema.sql ("BUDGET AND FORECAST"). Page: budget.html.
//
//  Budget       an amount per P&L account per month, for the whole business
//               (class_id NULL) or one class, against the ledger's actuals.
//  Forecast     13 weeks from the start of this week (Monday): the money on
//               hand now, then what is due in and out -- open customer items,
//               recurring invoices and bills, open supplier bills, loan
//               instalments, payroll, the usual counter takings and stock
//               buying -- plus one-off lines people add.
//  Break-even   the P&L for a period, split into variable costs (cost of sales
//               and any expense account marked variable) and fixed costs, so
//               the page can work out break-even sales and what-ifs.
//  Investments  what was put in and what it is expected to earn; with a class,
//               what it has actually earned since it started.
//
//  Reading needs acct.view; changing anything needs acct.budget.
// =============================================================================

const PL_TYPES = ['income', 'cogs', 'expense', 'other_income', 'other_expense'];
const MONEY_KEYS = ['cash_safe', 'cheques', 'card_clearing', 'cash_drawers'];   // as books.js: cash that is ours but not yet in the bank

function register(app, deps) {
  const { query, requireAdmin, requireCap, books } = deps;
  const can = (k) => [requireAdmin, requireCap(k)];
  const VIEW = can('acct.view'), EDIT = can('acct.budget');
  const r2 = (v) => Math.round(Number(v || 0) * 100) / 100;
  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !isNaN(Date.parse(v));
  const today = () => new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10);   // Jamaica, no DST
  const addDays = (d, n) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);
  const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
  // Months in a date range, counting part months by their share of days (1 Jul - 30 Sep = 3).
  function monthsIn(from, to) {
    let t = 0, d = from;
    while (d <= to) {
      const y = +d.slice(0, 4), m = +d.slice(5, 7), dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const last = `${d.slice(0, 8)}${String(dim).padStart(2, '0')}`, upto = last < to ? last : to;
      t += (daysBetween(d, upto) + 1) / dim; d = addDays(last, 1);
    }
    return Math.round(t * 100) / 100;
  }
  function httpError(status, msg) { const e = new Error(msg); e.status = status; return e; }
  const fail = (res, e) => { if (!e.status) console.error('[budget]', e); res.status(e.status || 500).json({ error: e.status ? e.message : 'Server error' }); };
  const me = (req) => (req.session && req.session.userId) || null;

  async function setting(key, dflt) {
    const { rows } = await query('SELECT value FROM warehouse_settings WHERE key = $1', [key]);
    return rows.length && rows[0].value != null && rows[0].value !== '' ? rows[0].value : dflt;
  }
  const setSetting = (key, value) => query(
    `INSERT INTO warehouse_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, value == null ? null : String(value)]);
  const classArg = (v) => { const n = parseInt(v, 10); return n > 0 ? n : null; };

  // ================================================================ BUDGET ==
  // The 12 months of a financial year: year 2027 with a start month of 4 runs April 2027 - March 2028.
  async function fyMonths(year) {
    const start = Math.max(1, Math.min(12, parseInt(await setting('budget_fy_start', '1'), 10) || 1));
    const out = [];
    for (let i = 0; i < 12; i++) { const m = start - 1 + i; out.push(`${year + Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, '0')}-01`); }
    return { start, months: out };
  }
  app.get('/api/budget/meta', ...VIEW, async (req, res) => {
    try {
      const { rows: accounts } = await query(`SELECT id, code, name, type, parent_id FROM gl_accounts WHERE is_active AND type = ANY($1) ORDER BY array_position($1::text[], type), code`, [PL_TYPES]);
      const { rows: classes } = await query(`SELECT id, name FROM gl_classes WHERE COALESCE(is_active, true) ORDER BY location_id IS NULL, name`);
      const started = !!(await setting('gl_start_at', null));
      res.json({ accounts, classes, fy_start: parseInt(await setting('budget_fy_start', '1'), 10) || 1, ledger_started: started, today: today() });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/budget/settings', ...EDIT, async (req, res) => {
    try {
      const m = parseInt((req.body || {}).fy_start, 10);
      if (!(m >= 1 && m <= 12)) throw httpError(400, 'Choose the month the financial year starts');
      await setSetting('budget_fy_start', m);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // Budget and actual per account and month. Income is shown positive, as costs are.
  app.get('/api/budget', ...VIEW, async (req, res) => {
    try {
      const year = parseInt(req.query.year, 10);
      if (!(year >= 2000 && year <= 2100)) throw httpError(400, 'Choose a year');
      const cls = classArg(req.query.class_id);
      const { months } = await fyMonths(year);
      const from = months[0], to = addDays(new Date(Date.UTC(+months[11].slice(0, 4), +months[11].slice(5, 7), 1)).toISOString().slice(0, 10), -1);
      const { rows: budget } = await query(
        `SELECT account_id, to_char(month, 'YYYY-MM-DD') AS month, amount::float AS amount FROM gl_budgets
          WHERE month BETWEEN $1 AND $2 AND class_id IS NOT DISTINCT FROM $3`, [from, to, cls]);
      const { rows: actual } = await query(
        `SELECT l.account_id, to_char(date_trunc('month', e.entry_date), 'YYYY-MM-DD') AS month,
                SUM(CASE WHEN a.type IN ('income', 'other_income') THEN -l.amount ELSE l.amount END)::float AS amount
           FROM gl_lines l JOIN gl_entries e ON e.id = l.entry_id JOIN gl_accounts a ON a.id = l.account_id
          WHERE e.entry_date BETWEEN $1 AND $2 AND a.type = ANY($3) AND ($4::int IS NULL OR l.class_id = $4)
          GROUP BY 1, 2`, [from, to, PL_TYPES, cls]);
      const by = {};
      const slot = (id) => (by[id] = by[id] || { account_id: id, budget: Array(12).fill(0), actual: Array(12).fill(0) });
      for (const b of budget) { const i = months.indexOf(b.month); if (i >= 0) slot(b.account_id).budget[i] = r2(b.amount); }
      for (const a of actual) { const i = months.indexOf(a.month); if (i >= 0) slot(a.account_id).actual[i] = r2(a.amount); }
      res.json({ year, class_id: cls, months, rows: Object.values(by), saved: budget.length > 0 });
    } catch (e) { fail(res, e); }
  });
  // Saves the whole grid for one year and class: rows [{account_id, amounts[12]}].
  app.put('/api/budget', ...EDIT, async (req, res) => {
    try {
      const b = req.body || {}, year = parseInt(b.year, 10), cls = classArg(b.class_id);
      if (!(year >= 2000 && year <= 2100)) throw httpError(400, 'Choose a year');
      if (!Array.isArray(b.rows) || b.rows.length > 1000) throw httpError(400, 'Nothing to save');
      const { months } = await fyMonths(year);
      const { rows: ok } = await query(`SELECT id FROM gl_accounts WHERE type = ANY($1)`, [PL_TYPES]);
      const valid = new Set(ok.map((r) => r.id));
      if (cls && !(await query(`SELECT 1 FROM gl_classes WHERE id = $1`, [cls])).rows.length) throw httpError(400, 'Unknown class');
      const ids = [], ms = [], vs = [];
      for (const r of b.rows) {
        const id = parseInt(r.account_id, 10);
        if (!valid.has(id) || ids.includes(id) || !Array.isArray(r.amounts) || r.amounts.length !== 12) throw httpError(400, 'A budget row is not valid');
        for (let i = 0; i < 12; i++) {
          const v = r2(r.amounts[i]);
          if (!Number.isFinite(v) || Math.abs(v) > 1e12) throw httpError(400, 'An amount is not valid');
          ids.push(id); ms.push(months[i]); vs.push(v);
        }
      }
      if (ids.length) await query(
        `INSERT INTO gl_budgets (account_id, class_id, month, amount, updated_by)
         SELECT a, $4::int, m, v, $5 FROM unnest($1::int[], $2::date[], $3::numeric[]) AS x(a, m, v)
         ON CONFLICT (account_id, COALESCE(class_id, 0), month) DO UPDATE SET amount = EXCLUDED.amount, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
        [ids, ms, vs, cls, me(req)]);
      res.json({ ok: true, saved: ids.length });
    } catch (e) { fail(res, e); }
  });

  // ======================================================== CASH FORECAST ==
  const WEEKS = 13;
  const STEP = { weekly: [7, 0], fortnightly: [14, 0], monthly: [0, 1], quarterly: [0, 3], yearly: [0, 12] };
  // The next date of a schedule: days, or whole months keeping the day of the first date (31st -> end of month).
  function nextDate(d, freq, anchorDay) {
    const [days, months] = STEP[freq] || STEP.monthly;
    if (days) return addDays(d, days);
    const y = +d.slice(0, 4), m = +d.slice(5, 7) - 1 + months, ny = y + Math.floor(m / 12), nm = m % 12;
    const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
    return `${ny}-${String(nm + 1).padStart(2, '0')}-${String(Math.min(anchorDay, last)).padStart(2, '0')}`;
  }
  async function forecastSettings() {
    const num = async (k) => { const v = await setting(k, null); return v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v); };
    return {
      min_cash: await num('forecast_min_cash'),
      overdue_pct: (await num('forecast_overdue_pct')) ?? 50,
      takings_weekly: await num('forecast_takings_weekly'),            // null: the last 8 weeks' average
      purchases_weekly: await num('forecast_purchases_weekly'),        // null: the last 8 weeks' average
      purchases_from_week: (await num('forecast_purchases_from_week')) ?? 5,
      opening_override: await num('forecast_opening'),                 // null: from the ledger
    };
  }
  app.put('/api/budget/forecast/settings', ...EDIT, async (req, res) => {
    try {
      const b = req.body || {};
      const val = (v, lo, hi) => { if (v === '' || v == null) return null; const n = Number(v); if (!Number.isFinite(n) || n < lo || n > hi) throw httpError(400, 'A setting is out of range'); return n; };
      const s = { forecast_min_cash: val(b.min_cash, 0, 1e12), forecast_overdue_pct: val(b.overdue_pct, 0, 100), forecast_takings_weekly: val(b.takings_weekly, 0, 1e12),
        forecast_purchases_weekly: val(b.purchases_weekly, 0, 1e12), forecast_purchases_from_week: val(b.purchases_from_week, 1, WEEKS), forecast_opening: val(b.opening_override, -1e12, 1e12) };
      for (const [k, v] of Object.entries(s)) await setSetting(k, v);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/budget/forecast', ...VIEW, async (req, res) => {
    try {
      const S = await forecastSettings();
      const now = today(), dow = (new Date(now + 'T00:00:00Z').getUTCDay() + 6) % 7;   // Monday = 0
      const start = addDays(now, -dow), end = addDays(start, WEEKS * 7 - 1);
      const weeks = Array.from({ length: WEEKS }, (_, i) => ({ start: addDays(start, i * 7), end: addDays(start, i * 7 + 6) }));
      const weekOf = (d) => { if (!d || d > end) return -1; if (d < start) return 0; return Math.floor(daysBetween(start, d) / 7); };
      const SOURCES = [
        ['ar', 'in', 'Customers paying what they owe'], ['ar_plans', 'in', 'Recurring invoices'], ['takings', 'in', 'Counter and workshop takings'], ['own_in', 'in', 'Other money in'],
        ['ap', 'out', 'Supplier bills'], ['ap_plans', 'out', 'Recurring bills'], ['loans', 'out', 'Loan instalments'], ['payroll', 'out', 'Payroll'], ['purchases', 'out', 'Stock buying (not yet billed)'], ['own_out', 'out', 'Other money out'],
      ];
      const cells = {};   // key -> per week {amount, items[]}
      for (const [k] of SOURCES) cells[k] = weeks.map(() => ({ amount: 0, items: [] }));
      const put = (key, w, amount, label, day) => {
        if (w < 0 || !(Math.abs(amount) > 0.004)) return;
        const c = cells[key][w]; c.amount = r2(c.amount + amount);
        if (c.items.length < 60) c.items.push({ label, day: day || null, amount: r2(amount) }); else c.more = (c.more || 0) + 1;
      };
      const notes = [];

      // The money on hand now: bank accounts and cash not yet banked, from the ledger.
      const { rows: cash } = await query(
        `SELECT a.code, a.name, COALESCE((SELECT SUM(l.amount) FROM gl_lines l WHERE l.account_id = a.id), 0)::float AS balance
           FROM gl_accounts a WHERE a.is_active AND (a.qb_type = 'BANK' OR a.system_key = ANY($1)) ORDER BY (a.qb_type = 'BANK') DESC, a.code`, [MONEY_KEYS]);
      const ledger = !!(await setting('gl_start_at', null));
      let opening = r2(cash.reduce((t, a) => t + a.balance, 0));
      if (S.opening_override != null) opening = r2(S.opening_override);
      else if (!ledger) notes.push('The ledger has not been started, so the money on hand is 0. Type today\'s bank and cash total under Assumptions.');

      // Customers: open items by due date. Overdue ones land in this week, at the % expected to be collected.
      if (books && books.arOpenItems) {
        const items = await books.arOpenItems();
        let overdue = 0;
        for (const it of items) {
          if (it.due < now) { overdue = r2(overdue + it.open); continue; }
          put('ar', weekOf(it.due), it.open, (it.doc === 'invoice' ? 'Invoice' : 'Sale on account') + ' #' + it.id, it.due);
        }
        if (overdue > 0) put('ar', 0, r2(overdue * S.overdue_pct / 100), `Overdue ${S.overdue_pct}% of J$${overdue.toLocaleString('en-JM', { minimumFractionDigits: 2 })}`, now);
      }
      // Supplier bills: open, by due date (no due date: the bill date); overdue in this week. Credits are left out.
      if (books && books.apDocs) {
        for (const d of await books.apDocs(null)) {
          if (d.kind === 'credit' || !(d.open > 0.005)) continue;
          put('ap', weekOf(d.due || d.day), d.open, (d.supplier || 'Supplier') + ' ' + (d.number || ''), d.due || d.day);
        }
      }
      // Recurring invoices and bills: each future period, paid due_days after its date.
      const { rows: plans } = await query(
        `SELECT p.id, p.side, p.name, p.frequency, to_char(p.start_date, 'YYYY-MM-DD') AS start_date, to_char(p.end_date, 'YYYY-MM-DD') AS end_date, p.max_runs,
                to_char(p.next_run, 'YYYY-MM-DD') AS next_run, p.due_days, p.gct_amount::float AS gct,
                (SELECT COALESCE(SUM((x->>'amount')::numeric), 0) FROM jsonb_array_elements(p.lines) x)::float AS amount,
                (SELECT COUNT(*)::int FROM billing_runs r WHERE r.plan_id = p.id) AS runs
           FROM billing_plans p WHERE p.status = 'active' AND p.next_run IS NOT NULL`);
      for (const p of plans) {
        const total = r2(p.amount + p.gct), anchor = +p.start_date.slice(8, 10);
        let d = p.next_run, runs = p.runs;
        for (let guard = 0; guard < 200 && d <= end; guard++) {
          if ((p.end_date && d > p.end_date) || (p.max_runs && runs >= p.max_runs)) break;
          put(p.side === 'ar' ? 'ar_plans' : 'ap_plans', weekOf(addDays(d, p.due_days || 0)), total, p.name, addDays(d, p.due_days || 0));
          runs++; d = nextDate(d, p.frequency, anchor);
        }
      }
      // Loan instalments not yet billed (billed ones are already supplier bills).
      const { rows: inst } = await query(
        `SELECT l.name, to_char(i.due_date, 'YYYY-MM-DD') AS due, i.payment::float AS payment FROM loan_instalments i JOIN loans l ON l.id = i.loan_id
          WHERE l.status = 'active' AND i.status = 'scheduled' AND i.due_date <= $1 ORDER BY i.due_date`, [end]);
      for (const i of inst) put('loans', weekOf(i.due), i.payment, i.name, i.due);
      // Payroll: approved runs not yet paid on their pay date, then the average of the last 3 runs on the same schedule.
      const { rows: runs } = await query(
        `SELECT number, status, frequency, to_char(pay_date, 'YYYY-MM-DD') AS pay_date,
                COALESCE((totals->>'employer_cost')::numeric, (totals->>'gross')::numeric, (totals->>'net')::numeric, 0)::float AS cost
           FROM payroll_runs WHERE status IN ('approved', 'paid') ORDER BY pay_date DESC, id DESC LIMIT 12`);
      for (const r of runs.filter((x) => x.status === 'approved')) put('payroll', weekOf(r.pay_date), r.cost, 'Payroll ' + r.number, r.pay_date);
      if (runs.length) {
        const last = runs[0], same = runs.filter((x) => x.frequency === last.frequency).slice(0, 3);
        const avg = r2(same.reduce((t, x) => t + x.cost, 0) / same.length);
        const anchor = +last.pay_date.slice(8, 10);
        let d = nextDate(last.pay_date, last.frequency, anchor);
        for (let guard = 0; guard < 60 && d <= end; guard++) { if (d >= now) put('payroll', weekOf(d), avg, 'Payroll (average of the last ' + same.length + ')', d); d = nextDate(d, last.frequency, anchor); }
      }
      // The usual takings and stock buying: the last 8 full weeks' averages unless set by hand.
      const from8 = addDays(start, -56), to8 = addDays(start, -1);
      const { rows: tk } = await query(
        `SELECT (COALESCE((SELECT SUM(sp.amount_usd) FROM sale_payments sp JOIN pos_sales s ON s.id = sp.sale_id
                            WHERE s.voided = false AND sp.method <> 'account' AND sp.created_at::date BETWEEN $1 AND $2), 0)
               + COALESCE((SELECT SUM(amount_usd) FROM work_order_payments WHERE received_at::date BETWEEN $1 AND $2), 0))::float AS v`, [from8, to8]);
      const { rows: pb } = await query(
        `SELECT (COALESCE((SELECT SUM(bill_amount_jmd) FROM receipts WHERE bill_status = 'confirmed' AND status = 'posted' AND COALESCE(supplier_invoice_date, bill_confirmed_at::date) BETWEEN $1 AND $2), 0)
               + COALESCE((SELECT SUM(b.total) FROM ap_bills b WHERE b.voided_at IS NULL AND b.kind <> 'credit' AND b.bill_date BETWEEN $1 AND $2
                             AND NOT EXISTS (SELECT 1 FROM billing_runs r WHERE r.ap_bill_id = b.id) AND NOT EXISTS (SELECT 1 FROM loan_instalments i WHERE i.ap_bill_id = b.id)), 0))::float AS v`, [from8, to8]);
      const avgTakings = r2((tk[0] ? tk[0].v : 0) / 8), avgPurchases = r2((pb[0] ? pb[0].v : 0) / 8);
      const takings = S.takings_weekly != null ? S.takings_weekly : avgTakings, purchases = S.purchases_weekly != null ? S.purchases_weekly : avgPurchases;
      const left = 7 - dow;   // this week: only the days still to come
      for (let w = 0; w < WEEKS; w++) put('takings', w, w === 0 ? r2(takings * left / 7) : takings, w === 0 ? `Usual week, ${left} day${left === 1 ? '' : 's'} left` : 'Usual week', weeks[w].start);
      for (let w = Math.max(0, S.purchases_from_week - 1); w < WEEKS; w++) put('purchases', w, purchases, 'Usual week of new supplier bills', weeks[w].start);
      // One-off lines people added.
      const { rows: own } = await query(`SELECT id, to_char(day, 'YYYY-MM-DD') AS day, direction, amount::float AS amount, description FROM cash_forecast_items WHERE day <= $1 ORDER BY day, id`, [end]);
      const ownList = [];
      for (const o of own) {
        if (o.day < start) continue;
        ownList.push(o);
        put(o.direction === 'in' ? 'own_in' : 'own_out', weekOf(o.day), o.amount, o.description, o.day);
      }

      let bal = opening;
      for (let w = 0; w < WEEKS; w++) {
        const wk = weeks[w];
        wk.opening = bal;
        wk.in = r2(SOURCES.filter((s) => s[1] === 'in').reduce((t, s) => t + cells[s[0]][w].amount, 0));
        wk.out = r2(SOURCES.filter((s) => s[1] === 'out').reduce((t, s) => t + cells[s[0]][w].amount, 0));
        wk.net = r2(wk.in - wk.out); bal = r2(bal + wk.net); wk.closing = bal;
        wk.low = S.min_cash != null && bal < S.min_cash;
      }
      res.json({
        today: now, weeks, opening, cash_accounts: cash.map((a) => ({ code: a.code, name: a.name, balance: r2(a.balance) })), ledger_started: ledger,
        sources: SOURCES.map(([key, dir, label]) => ({ key, dir, label, weeks: cells[key] })),
        settings: S, averages: { takings_weekly: avgTakings, purchases_weekly: avgPurchases }, own: ownList, notes,
      });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/budget/forecast/items', ...EDIT, async (req, res) => {
    try {
      const b = req.body || {};
      const amount = r2(b.amount), desc = String(b.description || '').trim().slice(0, 200);
      if (!isDate(b.day)) throw httpError(400, 'Choose the date');
      if (!['in', 'out'].includes(b.direction)) throw httpError(400, 'Money in or out?');
      if (!(amount > 0) || amount > 1e12) throw httpError(400, 'Type the amount');
      if (!desc) throw httpError(400, 'Say what it is');
      const { rows } = await query(`INSERT INTO cash_forecast_items (day, direction, amount, description, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [b.day, b.direction, amount, desc, me(req)]);
      res.json({ ok: true, id: rows[0].id });
    } catch (e) { fail(res, e); }
  });
  app.delete('/api/budget/forecast/items/:id(\\d+)', ...EDIT, async (req, res) => {
    try {
      const { rowCount } = await query(`DELETE FROM cash_forecast_items WHERE id = $1`, [parseInt(req.params.id, 10)]);
      if (!rowCount) throw httpError(404, 'Not found');
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // =========================================================== BREAK-EVEN ==
  async function variableIds() {
    try { const v = JSON.parse(await setting('breakeven_variable', '[]')); return Array.isArray(v) ? v.map(Number).filter((n) => n > 0) : []; } catch (_) { return []; }
  }
  app.get('/api/budget/breakeven', ...VIEW, async (req, res) => {
    try {
      const from = req.query.from, to = req.query.to, cls = classArg(req.query.class_id);
      if (!isDate(from) || !isDate(to) || from > to) throw httpError(400, 'Choose a from and to date');
      const pl = async (a, b) => (await query(
        `SELECT a.id, a.code, a.name, a.type, SUM(CASE WHEN a.type IN ('income', 'other_income') THEN -l.amount ELSE l.amount END)::float AS amount
           FROM gl_lines l JOIN gl_entries e ON e.id = l.entry_id JOIN gl_accounts a ON a.id = l.account_id
          WHERE e.entry_date BETWEEN $1 AND $2 AND a.type = ANY($3) AND ($4::int IS NULL OR l.class_id = $4)
          GROUP BY a.id ORDER BY array_position($3::text[], a.type), a.code`, [a, b, PL_TYPES, cls])).rows.map((r) => Object.assign(r, { amount: r2(r.amount) })).filter((r) => r.amount !== 0);
      const accounts = await pl(from, to);
      // This month so far, and the days the shop traded in the period (days with a till sale).
      const now = today(), m0 = now.slice(0, 8) + '01', mEnd = addDays(new Date(Date.UTC(+now.slice(0, 4), +now.slice(5, 7), 1)).toISOString().slice(0, 10), -1);
      const month = await pl(m0, now);
      const { rows: td } = await query(
        `SELECT COUNT(DISTINCT (created_at AT TIME ZONE 'America/Jamaica')::date)::int AS days FROM pos_sales WHERE voided = false AND (created_at AT TIME ZONE 'America/Jamaica')::date BETWEEN $1 AND $2`, [from, to]);
      const { rows: tm } = await query(
        `SELECT COUNT(DISTINCT (created_at AT TIME ZONE 'America/Jamaica')::date)::int AS days FROM pos_sales WHERE voided = false AND (created_at AT TIME ZONE 'America/Jamaica')::date BETWEEN $1 AND $2`, [m0, now]);
      res.json({
        from, to, class_id: cls, accounts, variable: await variableIds(), months: monthsIn(from, to),
        trading_days: td[0].days, period_days: daysBetween(from, to) + 1,
        month: { from: m0, to: now, end: mEnd, accounts: month, days_gone: daysBetween(m0, now) + 1, days_in_month: daysBetween(m0, mEnd) + 1, trading_days: tm[0].days },
      });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/budget/breakeven/variable', ...EDIT, async (req, res) => {
    try {
      const ids = (Array.isArray((req.body || {}).account_ids) ? req.body.account_ids : []).map((v) => parseInt(v, 10)).filter((n) => n > 0).slice(0, 500);
      const { rows } = ids.length ? await query(`SELECT id FROM gl_accounts WHERE id = ANY($1) AND type IN ('expense', 'other_expense')`, [ids]) : { rows: [] };
      await setSetting('breakeven_variable', JSON.stringify(rows.map((r) => r.id)));
      res.json({ ok: true, variable: rows.map((r) => r.id) });
    } catch (e) { fail(res, e); }
  });

  // ========================================================== INVESTMENTS ==
  app.get('/api/budget/investments', ...VIEW, async (req, res) => {
    try {
      const now = today();
      const { rows } = await query(
        `SELECT i.id, i.name, i.class_id, c.name AS class, to_char(i.start_date, 'YYYY-MM-DD') AS start_date, i.amount::float AS amount, i.monthly_profit::float AS monthly_profit,
                i.notes, i.status, -- profit: income is a credit (negative), costs a debit
                CASE WHEN i.class_id IS NULL THEN NULL ELSE
                  (SELECT COALESCE(-SUM(l.amount), 0)
                     FROM gl_lines l JOIN gl_entries e ON e.id = l.entry_id JOIN gl_accounts a ON a.id = l.account_id
                    WHERE l.class_id = i.class_id AND e.entry_date BETWEEN i.start_date AND $1 AND a.type = ANY($2)) END::float AS actual_profit
           FROM investments i LEFT JOIN gl_classes c ON c.id = i.class_id ORDER BY i.status, i.start_date DESC, i.id DESC`, [now, PL_TYPES]);
      for (const r of rows) {
        r.months = r.start_date <= now ? monthsIn(r.start_date, now) : 0;
        if (r.actual_profit != null) r.actual_profit = r2(r.actual_profit);
      }
      res.json({ investments: rows, today: now });
    } catch (e) { fail(res, e); }
  });
  function investmentBody(b) {
    const name = String(b.name || '').trim().slice(0, 120), amount = r2(b.amount), mp = r2(b.monthly_profit);
    if (!name) throw httpError(400, 'Give the investment a name');
    if (!isDate(b.start_date)) throw httpError(400, 'Choose the start date');
    if (!(amount > 0) || amount > 1e12) throw httpError(400, 'Type the amount invested');
    if (!Number.isFinite(mp) || Math.abs(mp) > 1e12) throw httpError(400, 'Type the expected profit a month');
    return [name, classArg(b.class_id), b.start_date, amount, mp, String(b.notes || '').trim().slice(0, 2000) || null, b.status === 'closed' ? 'closed' : 'active'];
  }
  app.post('/api/budget/investments', ...EDIT, async (req, res) => {
    try {
      const v = investmentBody(req.body || {});
      const { rows } = await query(`INSERT INTO investments (name, class_id, start_date, amount, monthly_profit, notes, status, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, v.concat([me(req)]));
      res.json({ ok: true, id: rows[0].id });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/budget/investments/:id(\\d+)', ...EDIT, async (req, res) => {
    try {
      const v = investmentBody(req.body || {});
      const { rowCount } = await query(`UPDATE investments SET name = $2, class_id = $3, start_date = $4, amount = $5, monthly_profit = $6, notes = $7, status = $8, updated_at = NOW() WHERE id = $1`, [parseInt(req.params.id, 10)].concat(v));
      if (!rowCount) throw httpError(404, 'Not found');
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.delete('/api/budget/investments/:id(\\d+)', ...EDIT, async (req, res) => {
    try {
      const { rowCount } = await query(`DELETE FROM investments WHERE id = $1`, [parseInt(req.params.id, 10)]);
      if (!rowCount) throw httpError(404, 'Not found');
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
}

module.exports = { register };
