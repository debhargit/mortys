'use strict';
// =============================================================================
//  Vision Auto Solutions -- budgets, forecasts, break-even, ROI and a
//  financial health report
//
//  Mounted by server.js:  require('./budget').register(app, deps)
//  Tables in schema.sql ("BUDGET AND FORECAST"). Page: budget.html.
//  Everything is in J$, the books' currency; the page converts for display.
//
//  Budget       an amount per P&L account per month, for the whole business
//               (class_id NULL) or one class, against the ledger's actuals.
//               Saved versions keep named copies of a year's budget.
//  Outlook      12 months of profit from this month on, from the books (or
//               the budget), with a rough cash balance and the year's outturn.
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
//  Health       ratios from the books rated against guide figures, with
//               findings and recommendations; reports can be kept.
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
  // The first of the month n months after (or before) the month of m.
  const monthAdd = (m, n) => { const k = +m.slice(5, 7) - 1 + n; return `${+m.slice(0, 4) + Math.floor(k / 12)}-${String((((k % 12) + 12) % 12) + 1).padStart(2, '0')}-01`; };
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

  // Actual P&L per account and calendar month (income positive, as costs are) between two dates.
  async function monthly(from, to, cls) {
    return (await query(
      `SELECT l.account_id, to_char(date_trunc('month', e.entry_date), 'YYYY-MM-DD') AS month,
              SUM(CASE WHEN a.type IN ('income', 'other_income') THEN -l.amount ELSE l.amount END)::float AS amount
         FROM gl_lines l JOIN gl_entries e ON e.id = l.entry_id JOIN gl_accounts a ON a.id = l.account_id
        WHERE e.entry_date BETWEEN $1 AND $2 AND a.type = ANY($3) AND ($4::int IS NULL OR l.class_id = $4)
        GROUP BY 1, 2`, [from, to, PL_TYPES, cls])).rows;
  }
  // The working budget for one year and class: {months, rows: [{account_id, amounts[12]}]} (rows with nothing in them left out).
  async function workingBudget(year, cls) {
    const { months } = await fyMonths(year);
    const { rows } = await query(
      `SELECT account_id, to_char(month, 'YYYY-MM-DD') AS month, amount::float AS amount FROM gl_budgets
        WHERE month = ANY($1::date[]) AND class_id IS NOT DISTINCT FROM $2`, [months, cls]);
    const by = {};
    for (const r of rows) (by[r.account_id] = by[r.account_id] || Array(12).fill(0))[months.indexOf(r.month)] = r2(r.amount);
    return { months, rows: Object.entries(by).map(([id, amounts]) => ({ account_id: +id, amounts })).filter((r) => r.amounts.some((v) => v)) };
  }
  async function versionRow(id) {
    const { rows } = await query(
      `SELECT v.id, v.year, v.class_id, v.name, v.notes, v.data, u.name AS saved_by,
              to_char(v.created_at AT TIME ZONE 'America/Jamaica', 'YYYY-MM-DD HH24:MI') AS saved_at
         FROM gl_budget_versions v LEFT JOIN users u ON u.id = v.created_by WHERE v.id = $1`, [id]);
    if (!rows.length) throw httpError(404, 'That budget version is not there any more');
    return rows[0];
  }

  // Budget and actual per account and month. Income is shown positive, as costs are.
  // With version_id, the budget is that saved version (its own year, class and months).
  app.get('/api/budget', ...VIEW, async (req, res) => {
    try {
      let year = parseInt(req.query.year, 10), cls = classArg(req.query.class_id), months, budget, version = null;
      const vid = parseInt(req.query.version_id, 10);
      if (vid > 0) {
        const v = await versionRow(vid);
        year = v.year; cls = v.class_id; months = v.data.months; budget = v.data.rows;
        version = { id: v.id, name: v.name, notes: v.notes, saved_by: v.saved_by, saved_at: v.saved_at };
      } else {
        if (!(year >= 2000 && year <= 2100)) throw httpError(400, 'Choose a year');
        ({ months, rows: budget } = await workingBudget(year, cls));
      }
      const actual = await monthly(months[0], addDays(monthAdd(months[11], 1), -1), cls);
      const by = {};
      const slot = (id) => (by[id] = by[id] || { account_id: id, budget: Array(12).fill(0), actual: Array(12).fill(0) });
      for (const b of budget) slot(b.account_id).budget = b.amounts.map(r2);
      for (const a of actual) { const i = months.indexOf(a.month); if (i >= 0) slot(a.account_id).actual[i] = r2(a.amount); }
      res.json({ year, class_id: cls, months, rows: Object.values(by), saved: budget.length > 0, version });
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

  // The money on hand now: bank accounts and cash not yet banked, from the ledger (or as typed in).
  async function moneyOnHand(S) {
    const { rows: cash } = await query(
      `SELECT a.code, a.name, COALESCE((SELECT SUM(l.amount) FROM gl_lines l WHERE l.account_id = a.id), 0)::float AS balance
         FROM gl_accounts a WHERE a.is_active AND (a.qb_type = 'BANK' OR a.system_key = ANY($1)) ORDER BY (a.qb_type = 'BANK') DESC, a.code`, [MONEY_KEYS]);
    const ledger = !!(await setting('gl_start_at', null));
    const opening = r2(S.opening_override != null ? S.opening_override : cash.reduce((t, a) => t + a.balance, 0));
    return { cash, opening, ledger };
  }
  async function buildForecast() {
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

    const { cash, opening, ledger } = await moneyOnHand(S);
    if (S.opening_override == null && !ledger) notes.push('The ledger has not been started, so the money on hand is 0. Type today\'s bank and cash total under Assumptions.');

    // Customers: open items by due date. Overdue ones land in this week, at the % expected to be collected.
    if (books && books.arOpenItems) {
      const items = await books.arOpenItems();
      let overdue = 0;
      for (const it of items) {
        if (it.due < now) { overdue = r2(overdue + it.open); continue; }
        put('ar', weekOf(it.due), it.open, (it.doc === 'invoice' ? 'Invoice' : 'Sale on account') + ' #' + it.id, it.due);
      }
      if (overdue > 0) put('ar', 0, r2(overdue * S.overdue_pct / 100), `${S.overdue_pct}% of what is already overdue`, now);
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
    return {
      today: now, weeks, opening, cash_accounts: cash.map((a) => ({ code: a.code, name: a.name, balance: r2(a.balance) })), ledger_started: ledger,
      sources: SOURCES.map(([key, dir, label]) => ({ key, dir, label, weeks: cells[key] })),
      settings: S, averages: { takings_weekly: avgTakings, purchases_weekly: avgPurchases }, own: ownList, notes,
    };
  }
  app.get('/api/budget/forecast', ...VIEW, async (req, res) => {
    try { res.json(await buildForecast()); } catch (e) { fail(res, e); }
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
  async function investmentRows(now) {
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
    return rows;
  }
  app.get('/api/budget/investments', ...VIEW, async (req, res) => {
    try { const now = today(); res.json({ investments: await investmentRows(now), today: now }); } catch (e) { fail(res, e); }
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

  // ====================================================== BUDGET VERSIONS ==
  // A named copy of one year's working budget, kept while it is revised, so it
  // can be compared with actuals or put back later.
  const SIGN = { income: 1, other_income: 1, cogs: -1, expense: -1, other_expense: -1 };
  async function accountTypes() {
    const t = {};
    for (const r of (await query(`SELECT id, type FROM gl_accounts WHERE type = ANY($1)`, [PL_TYPES])).rows) t[r.id] = r.type;
    return t;
  }
  function rowTotals(rows, types) {
    let income = 0, net = 0;
    for (const r of rows) {
      const t = types[r.account_id], y = r.amounts.reduce((a, b) => a + b, 0);
      if (!t) continue;
      if (t === 'income') income += y;
      net += SIGN[t] * y;
    }
    return { income: r2(income), net: r2(net) };
  }
  async function keepVersion(year, cls, name, notes, userId) {
    const w = await workingBudget(year, cls);
    if (!w.rows.length) return null;
    const { rows } = await query(`INSERT INTO gl_budget_versions (year, class_id, name, notes, data, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [year, cls, name, notes, JSON.stringify(w), userId]);
    return rows[0].id;
  }
  app.get('/api/budget/versions', ...VIEW, async (req, res) => {
    try {
      const year = parseInt(req.query.year, 10), cls = classArg(req.query.class_id);
      if (!(year >= 2000 && year <= 2100)) throw httpError(400, 'Choose a year');
      const { rows } = await query(
        `SELECT v.id, v.name, v.notes, v.data, u.name AS saved_by, to_char(v.created_at AT TIME ZONE 'America/Jamaica', 'YYYY-MM-DD HH24:MI') AS saved_at
           FROM gl_budget_versions v LEFT JOIN users u ON u.id = v.created_by
          WHERE v.year = $1 AND v.class_id IS NOT DISTINCT FROM $2 ORDER BY v.created_at DESC, v.id DESC`, [year, cls]);
      const types = await accountTypes();
      res.json({ versions: rows.map((v) => Object.assign({ id: v.id, name: v.name, notes: v.notes, saved_by: v.saved_by, saved_at: v.saved_at }, rowTotals(v.data.rows, types))) });
    } catch (e) { fail(res, e); }
  });
  // Keeps the working budget as it is saved now under a name.
  app.post('/api/budget/versions', ...EDIT, async (req, res) => {
    try {
      const b = req.body || {}, year = parseInt(b.year, 10), cls = classArg(b.class_id);
      const name = String(b.name || '').trim().slice(0, 80), notes = String(b.notes || '').trim().slice(0, 1000) || null;
      if (!(year >= 2000 && year <= 2100)) throw httpError(400, 'Choose a year');
      if (!name) throw httpError(400, 'Give the version a name');
      const id = await keepVersion(year, cls, name, notes, me(req));
      if (!id) throw httpError(400, 'There is no saved budget for this year to keep. Enter it and press Save budget first.');
      res.json({ ok: true, id });
    } catch (e) { fail(res, e); }
  });
  // Puts a version back as the working budget. The working budget is kept as a version first.
  app.post('/api/budget/versions/:id(\\d+)/restore', ...EDIT, async (req, res) => {
    try {
      const v = await versionRow(parseInt(req.params.id, 10)), months = v.data.months;
      const kept = await keepVersion(v.year, v.class_id, `Working budget before "${v.name}" was put back`.slice(0, 80), null, me(req));
      // Every account with a working amount in those months, plus the version's: one statement, so it all changes together.
      const { rows: cur } = await query(`SELECT DISTINCT account_id FROM gl_budgets WHERE month = ANY($1::date[]) AND class_id IS NOT DISTINCT FROM $2`, [months, v.class_id]);
      const types = await accountTypes(), byAcct = {};
      for (const r of cur) byAcct[r.account_id] = Array(12).fill(0);
      for (const r of v.data.rows) if (types[r.account_id]) byAcct[r.account_id] = r.amounts.map(r2);
      const ids = [], ms = [], vs = [];
      for (const [id, amounts] of Object.entries(byAcct)) for (let i = 0; i < 12; i++) { ids.push(+id); ms.push(months[i]); vs.push(amounts[i]); }
      if (ids.length) await query(
        `INSERT INTO gl_budgets (account_id, class_id, month, amount, updated_by)
         SELECT a, $4::int, m, v, $5 FROM unnest($1::int[], $2::date[], $3::numeric[]) AS x(a, m, v)
         ON CONFLICT (account_id, COALESCE(class_id, 0), month) DO UPDATE SET amount = EXCLUDED.amount, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
        [ids, ms, vs, v.class_id, me(req)]);
      res.json({ ok: true, kept, year: v.year, class_id: v.class_id });
    } catch (e) { fail(res, e); }
  });
  app.delete('/api/budget/versions/:id(\\d+)', ...EDIT, async (req, res) => {
    try {
      const { rowCount } = await query(`DELETE FROM gl_budget_versions WHERE id = $1`, [parseInt(req.params.id, 10)]);
      if (!rowCount) throw httpError(404, 'Not found');
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // =========================================================== CURRENCIES ==
  // The books are kept in J$. The page can show them in another currency at
  // its latest rate from Purchasing's exchange rates (J$ per 1 unit).
  const SYMBOLS = { JMD: 'J$', USD: 'US$', CAD: 'CA$', GBP: '£', EUR: '€' };
  app.get('/api/budget/currencies', ...VIEW, async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT DISTINCT ON (currency) currency, rate::float AS rate, to_char(rate_date, 'YYYY-MM-DD') AS rate_date, source
           FROM exchange_rates WHERE rate > 0 AND currency <> 'JMD' AND rate_date <= $1
          ORDER BY currency, rate_date DESC, (source = 'manual') DESC, created_at DESC`, [today()]);
      res.json({ base: 'JMD', currencies: [{ code: 'JMD', symbol: 'J$', rate: 1 }].concat(rows.map((r) => ({ code: r.currency, symbol: SYMBOLS[r.currency] || r.currency + ' ', rate: r.rate, rate_date: r.rate_date, source: r.source }))) });
    } catch (e) { fail(res, e); }
  });

  // ============================================================== OUTLOOK ==
  // 12 months of profit from this month on, per account, worked out from the
  // books one of five ways, then turned into a rough month-end cash balance.
  const INCOME_T = { income: 1, other_income: 1 };
  const sumOf = (arr, i, j) => arr.slice(i, j).reduce((t, v) => t + v, 0);
  // The 24 full months before this one per P&L account, and how many of them the books cover.
  async function history(cls) {
    const now = today(), m0 = now.slice(0, 8) + '01';
    const H = Array.from({ length: 24 }, (_, k) => monthAdd(m0, k - 24));
    const { rows: accts } = await query(`SELECT id, code, name, type FROM gl_accounts WHERE type = ANY($1) ORDER BY array_position($1::text[], type), code`, [PL_TYPES]);
    const hist = {};
    for (const a of accts) hist[a.id] = Array(24).fill(0);
    for (const r of await monthly(H[0], addDays(m0, -1), cls)) { const k = H.indexOf(r.month); if (k >= 0 && hist[r.account_id]) hist[r.account_id][k] = r2(r.amount); }
    const { rows: f } = await query(`SELECT to_char(MIN(entry_date), 'YYYY-MM') || '-01' AS m FROM gl_entries`);
    const covered = f[0].m ? H.filter((m) => m >= f[0].m).length : 0;
    return { now, m0, H, accts, hist, covered };
  }
  function totalsOf(rows, key, n) {
    const t = {};
    for (const k of PL_TYPES) t[k] = Array(n).fill(0);
    for (const r of rows) r[key].forEach((v, i) => { t[r.type][i] += v; });
    for (const k of PL_TYPES) t[k] = t[k].map(r2);
    t.gross = t.income.map((v, i) => r2(v - t.cogs[i]));
    t.net = t.gross.map((v, i) => r2(v - t.expense[i] + t.other_income[i] - t.other_expense[i]));
    return t;
  }
  async function depreciationIds() {
    return (await query(`SELECT id FROM gl_accounts WHERE type IN ('expense', 'other_expense') AND (name ILIKE '%depreciat%' OR name ILIKE '%amorti%')`)).rows.map((r) => r.id);
  }
  const METHODS = {
    seasonal: 'Same month last year, grown at the past year\'s rate',
    lastyear: 'Same month last year',
    avg3: 'Average of the last 3 months',
    avg12: 'Average of the last 12 months',
    budget: 'The budget',
  };
  async function buildOutlook(o) {
    const h = await history(o.cls), { now, m0, H } = h, notes = [];
    const F = Array.from({ length: 12 }, (_, i) => monthAdd(m0, i));
    const method = o.method || (h.covered >= 24 ? 'seasonal' : h.covered >= 12 ? 'lastyear' : 'avg3');
    const firstK = 24 - h.covered;   // the first of the 24 months the books cover
    const variable = new Set(await variableIds());
    const salesF = 1 + o.sales_pct / 100, costF = 1 + o.costs_pct / 100;
    let bud = null;
    if (method === 'budget') {
      bud = {};
      const { rows } = await query(`SELECT account_id, to_char(month, 'YYYY-MM-DD') AS month, amount::float AS amount FROM gl_budgets WHERE month = ANY($1::date[]) AND class_id IS NOT DISTINCT FROM $2`, [F, o.cls]);
      for (const r of rows) (bud[r.account_id] = bud[r.account_id] || {})[r.month] = r.amount;
    }
    const budMonths = new Set(bud ? Object.values(bud).flatMap((x) => Object.keys(x)) : []);
    // The past year's growth on the year before, for income and for costs ("seasonal": needs two full years).
    let grow = null;
    if (method === 'seasonal' && h.covered >= 24) {
      let ci = 0, pi = 0, cc = 0, pc = 0;
      for (const a of h.accts) { const x = h.hist[a.id]; if (INCOME_T[a.type]) { ci += sumOf(x, 12, 24); pi += sumOf(x, 0, 12); } else { cc += sumOf(x, 12, 24); pc += sumOf(x, 0, 12); } }
      const clamp = (v) => Math.min(2, Math.max(0.5, v));
      grow = { income: pi > 0 ? clamp(ci / pi) : 1, cost: pc > 0 ? clamp(cc / pc) : 1 };
    } else if (method === 'seasonal') notes.push('Two full years are not in the books yet, so the same month last year is used without growth.');
    const avg = (x, n) => { const k = Math.min(n, h.covered); return k ? sumOf(x, 24 - k, 24) / k : 0; };
    const fell = new Set();   // months that fell back to the 3-month average
    const rows = [];
    for (const a of h.accts) {
      const x = h.hist[a.id];
      const factor = a.type === 'income' ? salesF : a.type === 'other_income' ? 1 : (a.type === 'cogs' || variable.has(a.id)) ? salesF : costF;
      const f = F.map((m, i) => {
        let v;
        if (method === 'avg3') v = avg(x, 3);
        else if (method === 'avg12') v = avg(x, 12);
        else if (method === 'budget') { if (budMonths.has(m)) v = (bud[a.id] && bud[a.id][m]) || 0; else { v = avg(x, 3); fell.add(m); } }
        else if (12 + i >= firstK) v = x[12 + i] * (grow ? (INCOME_T[a.type] ? grow.income : grow.cost) : 1);
        else { v = avg(x, 3); fell.add(m); }
        return r2(v * factor);
      });
      if (f.some((v) => v) || x.slice(12).some((v) => v)) rows.push({ account_id: a.id, code: a.code, name: a.name, type: a.type, history: x.slice(12), forecast: f });
    }
    if (!h.covered) notes.push('There is no complete month in the books yet, so there is nothing to forecast from.');
    else if (h.covered < 12 && method !== 'budget') notes.push(`Only ${h.covered} complete month${h.covered === 1 ? ' is' : 's are'} in the books, so the forecast rests on ${h.covered === 1 ? 'it' : 'them'}.`);
    if (fell.size) notes.push(`${fell.size} month${fell.size === 1 ? '' : 's'} had ${method === 'budget' ? 'no budget' : 'no figures a year earlier'}, so ${fell.size === 1 ? 'it uses' : 'they use'} the average of the last 3 months.`);
    const tot = totalsOf(rows, 'forecast', 12);

    // Cash: today's money on hand plus each month's profit (this month: only the days left), with
    // depreciation added back, loan capital repayments and your own one-off lines. Whole business only.
    let cash = null;
    if (!o.cls) {
      const S = await forecastSettings(), { opening } = await moneyOnHand(S), end = addDays(monthAdd(m0, 12), -1);
      const dep = new Set(await depreciationIds());
      const { rows: li } = await query(
        `SELECT to_char(date_trunc('month', i.due_date), 'YYYY-MM-DD') AS month, SUM(i.principal)::float AS v FROM loan_instalments i JOIN loans l ON l.id = i.loan_id
          WHERE l.status = 'active' AND i.due_date BETWEEN $1 AND $2 GROUP BY 1`, [now, end]);
      const { rows: own } = await query(
        `SELECT to_char(date_trunc('month', day), 'YYYY-MM-DD') AS month, SUM(CASE WHEN direction = 'in' THEN amount ELSE -amount END)::float AS v
           FROM cash_forecast_items WHERE day BETWEEN $1 AND $2 GROUP BY 1`, [now, end]);
      const of = (list, m) => r2((list.find((x) => x.month === m) || {}).v || 0);
      const share0 = daysBetween(now, monthAdd(m0, 1)) / daysBetween(m0, monthAdd(m0, 1));
      let bal = opening;
      const months = F.map((m, i) => {
        const share = i === 0 ? share0 : 1;
        const profit = r2(tot.net[i] * share), addback = r2(rows.filter((r) => dep.has(r.account_id)).reduce((t, r) => t + r.forecast[i], 0) * share);
        const loans = of(li, m), ownv = of(own, m);
        bal = r2(bal + profit + addback - loans + ownv);
        return { month: m, profit, addback, loans, own: ownv, closing: bal };
      });
      cash = { opening, months, min_cash: S.min_cash };
    }

    // This financial year: the months gone from the books, the rest from the forecast, against the budget and last year.
    const s0 = parseInt(await setting('budget_fy_start', '1'), 10) || 1, fy = +now.slice(5, 7) >= s0 ? +now.slice(0, 4) : +now.slice(0, 4) - 1;
    const FM = (await fyMonths(fy)).months, wb = await workingBudget(fy, o.cls);
    const fc = {}, bd = {};
    for (const r of rows) fc[r.account_id] = r.forecast;
    for (const r of wb.rows) bd[r.account_id] = r.amounts;
    const at = (x, m) => { const k = H.indexOf(m); return k >= firstK && k >= 0 ? x[k] : 0; };
    const fyRows = h.accts.map((a) => ({
      type: a.type,
      outlook: FM.map((m) => (m < m0 ? at(h.hist[a.id], m) : (fc[a.id] || [])[F.indexOf(m)] || 0)),
      budget: bd[a.id] || Array(12).fill(0),
      last_year: FM.map((m) => at(h.hist[a.id], monthAdd(m, -12))),
    }));
    const pick = (t) => ({ income: t.income, gross: t.gross, net: t.net });
    const outturn = {
      fy, months: FM, done: FM.filter((m) => m < m0).length, has_budget: wb.rows.length > 0,
      outlook: pick(totalsOf(fyRows, 'outlook', 12)), budget: pick(totalsOf(fyRows, 'budget', 12)), last_year: pick(totalsOf(fyRows, 'last_year', 12)),
    };
    return {
      today: now, months: F, history_months: H.slice(12), method, methods: METHODS, sales_pct: o.sales_pct, costs_pct: o.costs_pct, class_id: o.cls,
      covered: h.covered, rows, totals: tot, history_totals: totalsOf(rows, 'history', 12), cash, outturn, notes, fy_start: s0,
    };
  }
  app.get('/api/budget/outlook', ...VIEW, async (req, res) => {
    try {
      const pctArg = (v) => { const n = Number(v || 0); if (!Number.isFinite(n) || n < -90 || n > 500) throw httpError(400, 'A % change is out of range'); return n; };
      res.json(await buildOutlook({ method: METHODS[req.query.method] ? req.query.method : null, cls: classArg(req.query.class_id), sales_pct: pctArg(req.query.sales_pct), costs_pct: pctArg(req.query.costs_pct) }));
    } catch (e) { fail(res, e); }
  });

  // ======================================================== HEALTH REPORT ==
  // A check-up of the whole business from the books: profitability, growth,
  // cash, working capital, debt and planning. Each measure is rated against a
  // guide figure, with what it shows and what to do about it. Fixed rules, no
  // AI: the same books always give the same report. Money in the text is
  // written {J:amount} so the page can show it in the chosen currency.
  const SECTIONS = [['profit', 'Profitability'], ['growth', 'Growth'], ['cash', 'Cash and liquidity'], ['working', 'Working capital'], ['debt', 'Debt and solvency'], ['control', 'Planning and control']];
  const POINTS = { good: 100, watch: 55, poor: 10 };
  const VERDICT = {
    Strong: 'The business is in good financial health: profitable, able to pay its bills and in control of its working capital. The job now is to keep it that way as it grows.',
    Sound: 'The business is basically sound, with some areas that need attention before they turn into problems.',
    'Needs attention': 'Several measures are outside healthy ranges. None has to become a crisis, but each needs a plan and a monthly check.',
    'At risk': 'The business is under serious financial strain. Deal with the priority actions now, together with your accountant and your bank.',
  };
  async function buildHealth() {
    const h = await history(null), { now, H } = h;
    const started = !!(await setting('gl_start_at', null));
    if (!started || !h.covered) {
      return { ready: false, as_of: now, reason: started ? 'The books do not hold a complete month yet. The report needs at least one full month of figures.' : 'The ledger has not been started, so there are no figures to report on yet.' };
    }
    const n = Math.min(12, h.covered), A = 12 / n, k0 = 24 - n, notes = [];
    const J = (v) => `{J:${r2(v)}}`, P = (v, d = 1) => (v * 100).toFixed(d) + '%', D = (v) => Math.round(v) + ' days', X = (v) => v.toFixed(2);
    const plural = (k, one, many) => (k === 1 ? one : many);
    const tot = (a, b) => {
      const t = { income: 0, cogs: 0, expense: 0, other_income: 0, other_expense: 0 };
      for (const x of h.accts) t[x.type] += sumOf(h.hist[x.id], a, b);
      for (const k in t) t[k] = r2(t[k]);
      t.gross = r2(t.income - t.cogs); t.net = r2(t.gross - t.expense + t.other_income - t.other_expense); t.overheads = r2(t.expense + t.other_expense);
      return t;
    };
    const idSet = async (sql) => new Set((await query(sql)).rows.map((r) => r.id).filter(Boolean));
    const sumIds = (set, a, b) => r2([...set].reduce((t, id) => t + (h.hist[id] ? sumOf(h.hist[id], a, b) : 0), 0));
    const cur = tot(k0, 24), sales = cur.income * A, cogsY = cur.cogs * A, netY = cur.net * A;   // a year's worth
    const dep = new Set(await depreciationIds()), variable = new Set(await variableIds());
    const interestY = sumIds(await idSet(`SELECT id FROM gl_accounts WHERE system_key = 'interest_expense' UNION SELECT interest_account_id FROM loans`), k0, 24) * A;
    const wagesY = sumIds(await idSet(`SELECT id FROM gl_accounts WHERE system_key IN ('wages', 'payroll_taxes')`), k0, 24) * A;

    // Balances today. Liabilities and equity are credits (negative) in the ledger.
    const { rows: bal } = await query(
      `SELECT a.type, a.qb_type, a.system_key, SUM(l.amount)::float AS bal FROM gl_accounts a JOIN gl_lines l ON l.account_id = a.id JOIN gl_entries e ON e.id = l.entry_id
        WHERE e.entry_date <= $1 GROUP BY a.id`, [now]);
    const B = { cash: 0, ar: 0, stock: 0, other_ca: 0, fixed: 0, ap: 0, other_cl: 0, long_term: 0, equity: 0, suspense: 0 };
    for (const r of bal) {
      if (r.type === 'asset') {
        if (r.qb_type === 'BANK' || MONEY_KEYS.includes(r.system_key)) B.cash += r.bal;
        else if (r.qb_type === 'AR') B.ar += r.bal;
        else if (r.system_key === 'inventory') B.stock += r.bal;
        else if (r.qb_type === 'OCASSET') B.other_ca += r.bal;
        else B.fixed += r.bal;
      } else if (r.type === 'liability') {
        if (r.qb_type === 'AP') B.ap -= r.bal; else if (r.qb_type === 'LTLIAB') B.long_term -= r.bal; else B.other_cl -= r.bal;
      } else {
        B.equity -= r.bal;   // equity, and profit not yet closed to it
        if (r.system_key === 'suspense') B.suspense += r.bal;
      }
    }
    for (const k in B) B[k] = r2(B[k]);
    const CA = r2(B.cash + B.ar + B.stock + B.other_ca), CL = r2(B.ap + B.other_cl), debt = r2(CL + B.long_term);

    const M = [];
    const add = (key, section, label, shown, guide, weight, rating, finding, advice) => M.push({ key, section, label, shown, guide, weight, rating, finding, advice: advice || '' });
    const na = (key, section, label, guide, why) => add(key, section, label, '–', guide, 0, 'na', why, '');

    // ---- Profitability
    if (cur.income > 0) {
      const gm = cur.gross / cur.income, pt = J(sales * 0.01);
      if (gm >= 0.30) add('gross_margin', 'profit', 'Gross margin', P(gm), '30% or more', 3, 'good',
        `Gross margin is ${P(gm)}: after paying for the goods sold, ${Math.round(gm * 100)} cents of every dollar of sales is left for overheads and profit.`,
        'Protect it: compare supplier prices with your selling prices every quarter and keep the pricing rules in step with landed costs.');
      else if (gm >= 0.20) add('gross_margin', 'profit', 'Gross margin', P(gm), '30% or more', 3, 'watch',
        `Gross margin is ${P(gm)}, below the 30% to 45% that motor-parts retailers and workshops usually earn.`,
        `Check the margin on the 50 best-selling lines and on discounts given at the counter. Each extra point of margin is worth about ${pt} a year.`);
      else add('gross_margin', 'profit', 'Gross margin', P(gm), '30% or more', 3, 'poor',
        `Gross margin is only ${P(gm)}: too little is left after the cost of goods to pay rent, wages and other overheads.`,
        `Review selling prices against current landed costs now, limit counter discounts to managers, and look into stock adjustments and shrinkage, which are booked to cost of sales. Each point of margin is worth about ${pt} a year.`);

      const nm = cur.net / cur.income, over = `${J(cur.net)} over ${n} ${plural(n, 'month', 'months')}`;
      const fix = 'Work on both sides at once: lift the gross margin (prices, discounts, shrinkage) and cut or put off overheads that do not bring in sales. The Break-even tab shows the sales needed each month.';
      if (nm >= 0.08) add('net_margin', 'profit', 'Net profit margin', P(nm), '8% or more', 3, 'good',
        `Net profit is ${P(nm)} of sales (${over}).`, 'Set part of each month\'s profit aside for tax and for replacing equipment and vehicles, and decide on purpose how much to reinvest.');
      else if (nm >= 0.03) add('net_margin', 'profit', 'Net profit margin', P(nm), '8% or more', 3, 'watch',
        `Net profit is ${P(nm)} of sales (${over}). That is a thin cushion: a small fall in sales or margin would wipe it out.`,
        `Go through the overheads one by one and give each a limit on the Budget tab. Reaching 8% would mean about ${J(sales * (0.08 - nm))} more profit a year.`);
      else if (cur.net >= 0) add('net_margin', 'profit', 'Net profit margin', P(nm), '8% or more', 3, 'poor',
        `Net profit is only ${P(nm)} of sales (${over}): the business is close to break-even.`, fix);
      else add('net_margin', 'profit', 'Net profit margin', P(nm), '8% or more', 3, 'poor',
        `The business lost ${J(-cur.net)} over the last ${n} ${plural(n, 'month', 'months')} (${P(nm)} of sales).`, fix);

      if (wagesY > 0) {
        const w = wagesY / sales;
        if (w <= 0.25) add('staff_costs', 'profit', 'Staff costs', P(w) + ' of sales', '25% or less', 1, 'good',
          `Wages and payroll taxes are ${P(w)} of sales.`, 'Keep it there as the business grows: add hours only where the extra sales pay for them.');
        else if (w <= 0.35) add('staff_costs', 'profit', 'Staff costs', P(w) + ' of sales', '25% or less', 1, 'watch',
          `Wages and payroll taxes take ${P(w)} of sales, above the 25% guide.`, 'Compare rostered hours with the busiest trading times (Attendance), and pay commission on gross profit rather than on sales.');
        else add('staff_costs', 'profit', 'Staff costs', P(w) + ' of sales', '25% or less', 1, 'poor',
          `Wages and payroll taxes take ${P(w)} of sales, leaving little for other costs and profit.`, 'Match rosters to trading hours, review overtime, and make sure workshop labour is charged out on every job.');
      }

      const varExp = sumIds(variable, k0, 24), cm = (cur.income - cur.cogs - varExp) / cur.income;
      if (!(cm > 0)) add('safety', 'profit', 'Margin of safety', '–', '20% or more', 2, 'poor',
        'Costs that rise with sales are more than the sales themselves, so no level of sales breaks even.', 'Raise prices or cut the cost of goods before anything else: at these prices, selling more only adds to the loss.');
      else {
        const be = (cur.overheads - varExp - cur.other_income) / n / cm, avgS = cur.income / n, mos = (avgS - be) / avgS;
        const vs = `Sales average ${J(avgS)} a month against a break-even of ${J(be)}`;
        if (mos >= 0.2) add('safety', 'profit', 'Margin of safety', P(mos, 0), '20% or more', 2, 'good',
          `${vs}: they could fall ${P(mos, 0)} before the business made a loss.`, 'Use the headroom to build cash reserves rather than to add fixed costs.');
        else if (mos >= 0.05) add('safety', 'profit', 'Margin of safety', P(mos, 0), '20% or more', 2, 'watch',
          `${vs}, only ${P(mos, 0)} above it. One quiet month could mean a loss.`, `Hold fixed costs where they are until sales are at least 20% above break-even, about ${J(be / 0.8)} a month.`);
        else add('safety', 'profit', 'Margin of safety', P(mos, 0), '20% or more', 2, 'poor',
          `${vs}: ${mos < 0 ? P(-mos, 0) + ' below it' : 'only ' + P(mos, 0) + ' above it'}.`, `Either lift sales to at least ${J(be / 0.8)} a month or bring fixed costs down. The What if sliders on the Break-even tab show which works best.`);
      }
    } else na('gross_margin', 'profit', 'Gross margin', '30% or more', 'No sales are in the books for the period, so profitability cannot be measured.');

    // ---- Growth
    let now3 = null, then3 = null, since = '';
    if (h.covered >= 24) { now3 = cur; then3 = tot(0, 12); since = 'the 12 months before'; }
    else if (h.covered >= 15) { now3 = tot(21, 24); then3 = tot(9, 12); since = 'the same 3 months a year earlier'; }
    if (now3 && then3.income > 0) {
      const g = now3.income / then3.income - 1;
      if (g >= 0.05) add('growth', 'growth', 'Sales growth', (g >= 0 ? '+' : '') + P(g), '5% a year or more', 2, 'good',
        `Sales are up ${P(g)} on ${since}.`, 'Make sure the growth is profitable: gross margin and overheads should hold steady as sales rise.');
      else if (g >= 0) add('growth', 'growth', 'Sales growth', '+' + P(g), '5% a year or more', 2, 'watch',
        `Sales are up ${P(g)} on ${since}, less than inflation (about 5% a year), so they are flat or falling in real terms.`, 'Find the categories and customers that are slipping (Reports: sales by category and by customer) and follow up account customers who have stopped buying.');
      else add('growth', 'growth', 'Sales growth', P(g), '5% a year or more', 2, 'poor',
        `Sales are down ${P(-g)} on ${since}.`, 'Find where the sales went: compare categories, brands and customers year on year, check for stock-outs on fast movers, and win back lapsed account customers.');
      if (then3.overheads > 0) {
        const og = now3.overheads / then3.overheads - 1, gap = og - g;
        const said = `Overheads ${og >= 0 ? 'rose' : 'fell'} ${P(Math.abs(og))} while sales ${g >= 0 ? 'rose' : 'fell'} ${P(Math.abs(g))}.`;
        if (gap <= 0) add('cost_growth', 'growth', 'Overheads against sales', (gap > 0 ? '+' : '') + P(gap) + ' pts', 'no faster than sales', 1, 'good', said, 'Costs are under control. Keep comparing them with the budget each month.');
        else if (gap <= 0.05) add('cost_growth', 'growth', 'Overheads against sales', '+' + P(gap) + ' pts', 'no faster than sales', 1, 'watch', said + ' Costs are growing a little faster than sales.', 'Look at the overheads that grew most (Budget tab, Budget against actual) and set a limit for each.');
        else add('cost_growth', 'growth', 'Overheads against sales', '+' + P(gap) + ' pts', 'no faster than sales', 1, 'poor', said + ' Costs are outpacing sales.', 'Give every overhead a budget, compare budget against actual monthly, and question each cost that grew faster than sales.');
      }
    } else na('growth', 'growth', 'Sales growth', '5% a year or more', 'Growth needs at least 15 months in the books, to compare with the same months a year earlier.');

    // ---- Cash and liquidity
    const ohMonth = (cur.overheads - sumIds(dep, k0, 24)) / n;
    if (ohMonth > 0) {
      const run = B.cash / ohMonth, shown = (run < 0 ? 0 : run).toFixed(1) + ' months';
      if (run >= 3) add('runway', 'cash', 'Cash cover for overheads', shown, '3 months or more', 3, 'good',
        `Money on hand (${J(B.cash)}) would pay ${run.toFixed(1)} months of overheads.`, 'Keep at least three months in reserve. Anything well beyond that could pay down debt or fund stock that sells.');
      else if (run >= 1) add('runway', 'cash', 'Cash cover for overheads', shown, '3 months or more', 3, 'watch',
        `Money on hand (${J(B.cash)}) would pay ${run.toFixed(1)} months of overheads, short of the three months a business should keep.`, `Build the reserve to about ${J(ohMonth * 3)} by setting aside a fixed sum each week.`);
      else add('runway', 'cash', 'Cash cover for overheads', shown, '3 months or more', 3, 'poor',
        B.cash < 0 ? `The bank and cash accounts are overdrawn by ${J(-B.cash)}.` : `Money on hand (${J(B.cash)}) would not pay even one month of overheads (${J(ohMonth)} a month).`,
        'Collect overdue customer accounts, hold back buying that is not urgent, and agree an overdraft with the bank now, before it is needed.');
    }
    if (CL > 0) {
      const cr = CA / CL;
      if (cr > 3) add('current_ratio', 'cash', 'Current ratio', X(cr), '1.5 to 3', 2, 'watch',
        `Current assets (cash, customers, stock) are ${X(cr)} times the debts due within a year. That is safe, but a ratio this high often means money sitting idle.`,
        'Put idle money to work: clear expensive debt, take early-payment discounts from suppliers, and cut stock that does not sell.');
      else if (cr >= 1.5) add('current_ratio', 'cash', 'Current ratio', X(cr), '1.5 to 3', 2, 'good',
        `Current assets (cash, customers, stock) are ${X(cr)} times the debts due within a year.`, 'A comfortable position. Keep it as the business grows.');
      else if (cr >= 1) add('current_ratio', 'cash', 'Current ratio', X(cr), '1.5 to 3', 2, 'watch',
        `Current assets are ${X(cr)} times the debts due within a year: enough, with little to spare.`, 'Do not pay for long-lasting things (vehicles, equipment, fit-outs) out of day-to-day cash; finance them over their life.');
      else add('current_ratio', 'cash', 'Current ratio', X(cr), '1.5 to 3', 2, 'poor',
        `Debts due within a year are more than current assets (ratio ${X(cr)}): the business may struggle to pay its bills on time.`,
        'Talk to the bank and the largest suppliers about terms before payments fall behind, turn slow stock into cash, and consider moving short-term debt onto a longer loan.');
      const qr = (B.cash + B.ar) / CL, said = qr >= 1 ? `Without selling any stock, cash and what customers owe would pay every debt due within a year, ${X(qr)} times over.`
        : `Without selling any stock, cash and what customers owe would pay ${P(qr, 0)} of the debts due within a year.`;
      if (qr >= 0.8) add('quick_ratio', 'cash', 'Quick ratio', X(qr), '0.8 or more', 2, 'good', said, 'Keep collecting from customers on time to hold this.');
      else if (qr >= 0.4) add('quick_ratio', 'cash', 'Quick ratio', X(qr), '0.8 or more', 2, 'watch', said, 'Much of the working money is tied up in stock. Bring stock down to what sells and collect from customers faster.');
      else add('quick_ratio', 'cash', 'Quick ratio', X(qr), '0.8 or more', 2, 'poor', said + ' The business depends on selling stock to pay its bills.', 'Free cash from slow stock, chase overdue customers, and agree longer terms with key suppliers.');
    } else add('current_ratio', 'cash', 'Current ratio', '–', '1.5 to 3', 2, 'good', 'No debts due within a year are in the books.', '');
    const fc = await buildForecast(), low = fc.weeks.reduce((m, w) => (w.closing < m.closing ? w : m), fc.weeks[0]), min = fc.settings.min_cash;
    if (low.closing < 0) add('forecast', 'cash', '13-week cash forecast', J(low.closing), 'stays above your minimum', 3, 'poor',
      `The 13-week cash forecast goes overdrawn: its lowest point is ${J(low.closing)} in the week of ${low.start}.`, 'Arrange funding now or move payments to later weeks. The Cash forecast tab shows the weeks and the bills behind them.');
    else if (min != null && low.closing < min) add('forecast', 'cash', '13-week cash forecast', J(low.closing), 'stays above your minimum', 3, 'watch',
      `The 13-week cash forecast falls below your minimum of ${J(min)}: lowest ${J(low.closing)} in the week of ${low.start}.`, 'Plan for that week now: bring collections forward or ask suppliers to spread the larger bills.');
    else add('forecast', 'cash', '13-week cash forecast', J(low.closing), 'stays above your minimum', 3, 'good',
      `The 13-week cash forecast stays ${min != null ? 'above your minimum' : 'positive'}; its lowest point is ${J(low.closing)} in the week of ${low.start}.`,
      min != null ? 'Keep the forecast current with your own one-off lines.' : 'Set the lowest balance you want to keep (Cash forecast, Assumptions) so the report can warn you earlier.');

    // ---- Working capital
    let dso = null, dio = null, dpo = null;
    if (sales > 0) {
      dso = B.ar / sales * 365;
      const said = `Customers owe ${J(B.ar)}, about ${D(dso)} of sales.`;
      if (dso <= 30) add('debtor_days', 'working', 'Debtor days', D(dso), '30 days or less', 1, 'good', said, 'Keep sending statements on time.');
      else if (dso <= 45) add('debtor_days', 'working', 'Debtor days', D(dso), '30 days or less', 1, 'watch',
        said + ' Most counter sales are paid on the spot, so account customers are taking longer than that.', 'Send statements on the 1st, call every account more than 30 days old, and make paying easy (card, bank transfer).');
      else add('debtor_days', 'working', 'Debtor days', D(dso), '30 days or less', 1, 'poor',
        said + ' Too much of the business\'s money is sitting with customers.', `Getting to 30 days would free about ${J(B.ar - sales * 30 / 365)}. Stop credit for accounts more than 60 days late and agree payment plans with the largest.`);
    }
    if (books && books.arOpenItems) {
      const items = await books.arOpenItems();
      const open = items.reduce((t, x) => t + x.open, 0), late = items.filter((x) => x.due < now).reduce((t, x) => t + x.open, 0);
      if (open > 0.5) {
        const s = late / open, said = `${P(s, 0)} of what customers owe${late > 0 ? ' (' + J(late) + ')' : ''} is past its due date.`;
        if (s <= 0.15) add('overdue', 'working', 'Overdue customer accounts', P(s, 0), '15% or less', 2, 'good', said, 'Collections are under control.');
        else if (s <= 0.35) add('overdue', 'working', 'Overdue customer accounts', P(s, 0), '15% or less', 2, 'watch', said, 'Call the five largest overdue accounts this week and send reminders to the rest (Receivables).');
        else add('overdue', 'working', 'Overdue customer accounts', P(s, 0), '15% or less', 2, 'poor', said, 'Make collections a weekly job: call every overdue account, stop credit for those more than 60 days late, and agree written payment plans.');
      }
    }
    if (cogsY > 0) {
      dio = B.stock / cogsY * 365;
      const said = `Stock of ${J(B.stock)} is about ${D(dio)} of sales at cost`, free = `Getting to 120 days would free about ${J(B.stock - cogsY * 120 / 365)}.`;
      if (dio <= 120) add('stock_days', 'working', 'Stock days', D(dio), '120 days or less', 2, 'good', said + '.', 'Keep reorder points tied to recent sales so stock stays lean.');
      else if (dio <= 200) add('stock_days', 'working', 'Stock days', D(dio), '120 days or less', 2, 'watch', said + ', more than a parts business usually needs.', 'Stop reordering lines that have not sold in six months (slow-movers report). ' + free);
      else add('stock_days', 'working', 'Stock days', D(dio), '120 days or less', 2, 'poor', said + ': a lot of money is tied up on the shelves.', 'Clear dead stock (return it, discount it or bundle it), stop reordering slow lines, and buy fast movers little and often. ' + free);
      dpo = Math.max(0, B.ap) / cogsY * 365;
      const owe = `Supplier bills of ${J(B.ap)} are about ${D(dpo)} of purchases`;
      if (dpo > 90) add('creditor_days', 'working', 'Creditor days', D(dpo), '20 to 60 days', 1, 'poor', `Suppliers wait about ${D(dpo)} to be paid, which risks stopped accounts, lost discounts and worse prices.`, 'Agree a payment plan with the most overdue suppliers (Payables) and match buying to what sells.');
      else if (dpo > 60) add('creditor_days', 'working', 'Creditor days', D(dpo), '20 to 60 days', 1, 'watch', owe + ', longer than usual terms.', 'Check that no supplier is overdue (Payables) before it affects prices or supply.');
      else if (dpo < 20) add('creditor_days', 'working', 'Creditor days', D(dpo), '20 to 60 days', 1, 'watch', `Suppliers are paid in about ${D(dpo)}, faster than most terms require.`, 'Use the full credit terms you are given (often 30 days) unless an early-payment discount is worth more than holding the cash.');
      else add('creditor_days', 'working', 'Creditor days', D(dpo), '20 to 60 days', 1, 'good', owe + '.', 'Supplier credit is being used sensibly.');
    }
    if (dso != null && dio != null && dpo != null) {
      const c = dso + dio - dpo, said = `Money spent on stock takes about ${D(c)} to come back as cash (stock ${D(dio)}, plus customers ${D(dso)}, less suppliers ${D(dpo)}).`;
      add('cash_cycle', 'working', 'Cash cycle', D(c), '90 days or less', 1, c <= 90 ? 'good' : c <= 150 ? 'watch' : 'poor', said,
        c <= 90 ? '' : 'The quickest gains are usually in stock: see Stock days.');
    }

    // ---- Debt and solvency
    if (B.equity <= 0) add('gearing', 'debt', 'Debt to equity', 'Negative', '1 or less', 2, 'poor',
      `What the business owes (${J(debt)}) is more than what it owns: the owners' stake is ${J(B.equity)}.`, 'Bring in capital or turn owner loans into equity, and use profits to pay down debt before taking on more.');
    else {
      const de = debt / B.equity, said = `The business owes ${J(debt)}, ${X(de)} times the owners' stake of ${J(B.equity)}.`;
      if (de <= 1) add('gearing', 'debt', 'Debt to equity', X(de), '1 or less', 2, 'good', said, 'There is room to borrow for a sound investment if one comes along.');
      else if (de <= 2) add('gearing', 'debt', 'Debt to equity', X(de), '1 or less', 2, 'watch', said + ' Lenders will look closely at any more borrowing.', 'Pay down the dearest debt first and borrow only for things that earn their keep.');
      else add('gearing', 'debt', 'Debt to equity', X(de), '1 or less', 2, 'poor', said + ' That is heavily borrowed.', 'Make reducing debt a priority: no new borrowing until the ratio is under 2, and use spare cash to clear the most expensive loans.');
    }
    if (interestY > 0) {
      const ic = (netY + interestY) / interestY;
      if (ic >= 4) add('interest_cover', 'debt', 'Interest cover', ic.toFixed(1) + ' times', '4 times or more', 2, 'good', `Profit before interest pays the interest bill ${ic.toFixed(1)} times over.`, '');
      else if (ic >= 2) add('interest_cover', 'debt', 'Interest cover', ic.toFixed(1) + ' times', '4 times or more', 2, 'watch',
        `Profit before interest pays the interest bill only ${ic.toFixed(1)} times over.`, 'A fall in profit would make loan payments hard. Avoid new borrowing and ask the bank about a lower rate.');
      else add('interest_cover', 'debt', 'Interest cover', ic.toFixed(1) + ' times', '4 times or more', 2, 'poor',
        `Profit before interest ${ic < 1 ? 'does not cover' : 'barely covers'} the interest bill of about ${J(interestY)} a year.`, 'Talk to the lender about restructuring, and use the Loans page to see how extra payments would cut the interest.');
    }

    // ---- Planning and control
    const s0 = parseInt(await setting('budget_fy_start', '1'), 10) || 1, fy = +now.slice(5, 7) >= s0 ? +now.slice(0, 4) : +now.slice(0, 4) - 1;
    const wb = await workingBudget(fy, null), done = wb.months.filter((m) => m < h.m0).length;
    if (!wb.rows.length) add('budget', 'control', 'Budget', 'None', 'saved and on track', 1, 'watch',
      'No budget is saved for this financial year, so there is nothing to measure the results against.', 'On the Budget tab, use Fill from last year\'s actuals, adjust it for what you know is coming, save it, and keep a copy as a version.');
    else if (!done) na('budget', 'control', 'Budget', 'saved and on track', 'A budget is saved; no month of this financial year has finished yet.');
    else {
      const types = {};
      for (const a of h.accts) types[a.id] = a.type;
      const bn = r2(wb.rows.reduce((t, r) => t + (SIGN[types[r.account_id]] || 0) * sumOf(r.amounts, 0, done), 0));
      const an = r2(h.accts.reduce((t, a) => t + SIGN[a.type] * wb.months.slice(0, done).reduce((s, m) => { const k = H.indexOf(m); return s + (k >= 0 ? h.hist[a.id][k] : 0); }, 0), 0));
      const said = `For the ${done} ${plural(done, 'month', 'months')} of this financial year so far, net profit is ${J(an)} against a budget of ${J(bn)}.`;
      const rate = bn > 0 ? an / bn : null, rating = bn > 0 ? (rate >= 0.95 ? 'good' : rate >= 0.75 ? 'watch' : 'poor') : (an >= bn ? 'good' : 'poor');
      add('budget', 'control', 'Profit against budget', bn > 0 ? P(rate, 0) + ' of budget' : J(an - bn), '95% of budget or better', 2, rating, said,
        rating === 'good' ? 'Keep comparing budget against actual each month.' : rating === 'watch' ? 'Find the lines furthest from budget (Budget tab, Budget against actual) and agree what will be done about each.'
          : 'Results are well behind budget. Act on the lines furthest from it, and update the 12-month forecast so cash plans reflect what is really happening.');
    }
    const susp = Math.abs(B.suspense);
    if (susp >= 1) add('suspense', 'control', 'Unsorted entries', J(susp), 'nothing in Suspense', 1, susp < sales * 0.005 ? 'watch' : 'poor',
      `${J(susp)} is sitting in the Suspense account, waiting to be put in the right place.`, 'Have it cleared into the right accounts. Until then the figures in this report are less reliable.');
    else add('suspense', 'control', 'Unsorted entries', J(0), 'nothing in Suspense', 1, 'good', 'Nothing is waiting in the Suspense account.', '');
    const inv = (await investmentRows(now)).filter((i) => i.status === 'active' && i.class_id && i.months >= 3);
    if (inv.length) {
      const perM = (i) => i.actual_profit / i.months, names = (l) => l.map((i) => i.name).join(', ');
      const losing = inv.filter((i) => perM(i) < 0), slow = inv.filter((i) => perM(i) >= 0 && perM(i) < i.monthly_profit * 0.5);
      if (losing.length) add('investments', 'control', 'Investments', `${losing.length} losing money`, 'earning what was expected', 1, 'poor',
        `${names(losing)} ${plural(losing.length, 'has', 'have')} lost money since starting.`, 'Set a deadline to turn each one around, sell it or close it; the money tied up there could be earning elsewhere.');
      else if (slow.length) add('investments', 'control', 'Investments', `${slow.length} behind plan`, 'earning what was expected', 1, 'watch',
        `${names(slow)} ${plural(slow.length, 'is', 'are')} earning less than half of what was expected.`, 'Review the plan behind each: are prices, volumes and costs what was assumed? Set a date to decide.');
      else add('investments', 'control', 'Investments', 'On track', 'earning what was expected', 1, 'good', 'Every investment with its own class is earning at least half of what was expected.', '');
    }

    if (n < 12) notes.push(`Only ${n} complete ${plural(n, 'month is', 'months are')} in the books, so yearly figures are scaled up from ${plural(n, 'it', 'them')}. Read them with care.`);
    notes.push('Debtor days use all sales, cash and account together. Creditor days compare supplier bills with the cost of goods sold, as purchases are close to it.');
    const rated = M.filter((m) => POINTS[m.rating] != null && m.weight > 0);
    const score = rated.length ? Math.round(rated.reduce((t, m) => t + POINTS[m.rating] * m.weight, 0) / rated.reduce((t, m) => t + m.weight, 0)) : null;
    const band = score == null ? null : score >= 80 ? 'Strong' : score >= 65 ? 'Sound' : score >= 50 ? 'Needs attention' : 'At risk';
    const worst = (a, b) => (a.rating === b.rating ? b.weight - a.weight : a.rating === 'poor' ? -1 : 1);
    const concerns = M.filter((m) => m.rating === 'poor' || m.rating === 'watch').sort(worst);
    return {
      ready: true, as_of: now, period: { from: H[k0], to: addDays(h.m0, -1), months: n }, score, band, verdict: band ? VERDICT[band] : '',
      key: { sales: cur.income, gross: cur.gross, net: cur.net, cash: B.cash, ar: B.ar, stock: B.stock, ap: B.ap, current_assets: CA, current_liabilities: CL, long_term: B.long_term, equity: B.equity },
      sections: SECTIONS, metrics: M,
      strengths: M.filter((m) => m.rating === 'good').sort((a, b) => b.weight - a.weight).slice(0, 5).map((m) => ({ label: m.label, text: m.finding })),
      concerns: concerns.slice(0, 6).map((m) => ({ label: m.label, rating: m.rating, text: m.finding })),
      actions: concerns.filter((m) => m.advice).slice(0, 6).map((m) => ({ label: m.label, rating: m.rating, text: m.advice })),
      notes,
    };
  }
  app.get('/api/budget/health', ...VIEW, async (req, res) => {
    try { res.json(await buildHealth()); } catch (e) { fail(res, e); }
  });
  // Keeps today's report, to compare with later ones.
  app.post('/api/budget/health/saved', ...EDIT, async (req, res) => {
    try {
      const r = await buildHealth();
      if (!r.ready) throw httpError(400, r.reason);
      const { rows } = await query(`INSERT INTO financial_health_reports (as_of, score, report, created_by) VALUES ($1,$2,$3,$4) RETURNING id`, [r.as_of, r.score, JSON.stringify(r), me(req)]);
      res.json({ ok: true, id: rows[0].id });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/budget/health/saved', ...VIEW, async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT f.id, to_char(f.as_of, 'YYYY-MM-DD') AS as_of, f.score, f.report->>'band' AS band, u.name AS saved_by,
                to_char(f.created_at AT TIME ZONE 'America/Jamaica', 'YYYY-MM-DD HH24:MI') AS saved_at
           FROM financial_health_reports f LEFT JOIN users u ON u.id = f.created_by ORDER BY f.created_at DESC, f.id DESC LIMIT 100`);
      res.json({ reports: rows });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/budget/health/saved/:id(\\d+)', ...VIEW, async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT f.id, f.report, u.name AS saved_by, to_char(f.created_at AT TIME ZONE 'America/Jamaica', 'YYYY-MM-DD HH24:MI') AS saved_at
           FROM financial_health_reports f LEFT JOIN users u ON u.id = f.created_by WHERE f.id = $1`, [parseInt(req.params.id, 10)]);
      if (!rows.length) throw httpError(404, 'Not found');
      res.json(Object.assign(rows[0].report, { saved: { id: rows[0].id, by: rows[0].saved_by, at: rows[0].saved_at } }));
    } catch (e) { fail(res, e); }
  });
  app.delete('/api/budget/health/saved/:id(\\d+)', ...EDIT, async (req, res) => {
    try {
      const { rowCount } = await query(`DELETE FROM financial_health_reports WHERE id = $1`, [parseInt(req.params.id, 10)]);
      if (!rowCount) throw httpError(404, 'Not found');
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
}

module.exports = { register };
