// =============================================================================
//  Morty's Auto Parts -- Payroll (Jamaica). An optional module.
//
//    require('./payroll').register(app, deps)
//
//  Switched off by default (setting payroll_module). While it is off, every
//  /api/payroll route answers "switched off" except the switch itself, nothing
//  posts to the ledger, and the rest of the system runs exactly as before.
//  Its parts can be used selectively too: time clock hours, commission,
//  ledger posting, staff self-service and the two-person rule are separate
//  settings, and only the people added to payroll are paid by it.
//
//  Statutory deductions (per pay period, the TAJ non-cumulative method):
//    NIS        employee 3% + employer 3% of pay, up to the annual wage ceiling / periods
//    NHT        employee 2% + employer 3% of gross pay
//    Education  employee 2.25% + employer 3.5% of pay less employee NIS and approved pension
//    HEART/NSTA employer 3% of gross pay
//    PAYE       25% of statutory income (pay less NIS and approved pension, up to the
//               cap) above the tax-free threshold / periods; 30% above J$6M / periods
//  Rates come from payroll_rates by pay date (add a row when the law changes);
//  each run keeps a copy of the rates it used.
//
//  Income tax method, per person: non-cumulative (above), or cumulative: tax
//  on the statutory income for the year to date (pay and tax from an earlier
//  employer this year included, off the P45) less the tax-free pay for the
//  year to date, less the tax already paid. Someone who starts in the middle
//  of the year, or whose pay goes up and down, is then taxed on the year as a
//  whole. Age relief (payroll_rates.age_relief) is added to the tax-free pay
//  from the age in the rates. Year-to-date figures are worked from pay dates,
//  so they start again by themselves every 1 January; "Year end" closes the
//  year (no more runs in it) and carries vacation days forward.
//
//  Benefits in kind (payroll_items.notional: a company vehicle used privately,
//  housing provided): taxed through their ticks, never paid and never posted.
//  Savings (payroll_items.is_savings): a deduction that builds up a balance;
//  staff savings held by the business are paid back out on a payslip.
//
//  Capabilities (manager-only unless granted): payroll.view (runs, payslips,
//  reports), payroll.run (people, pay runs, payments, remittances, rates,
//  settings), payroll.approve (approve and void runs).
// =============================================================================
'use strict';

const PERIODS = { weekly: 52, fortnightly: 26, monthly: 12 };
const SETTINGS = {
  payroll_module: 'off', payroll_use_timeclock: 'on', payroll_include_commission: 'on', payroll_post_ledger: 'on',
  payroll_self_service: 'on', payroll_two_person: 'off', payroll_heart: 'on', payroll_vacation_days: '10', payroll_sick_days: '10',
  payroll_employer_trn: '', payroll_employer_nis: '', payroll_wht_agent: 'off', payroll_carry_vacation_max: '0',
};
const STAT = ['gross', 'statutory', 'nis_ee', 'nis_er', 'nht_ee', 'nht_er', 'ed_ee', 'ed_er', 'heart_er', 'paye', 'pension_ee', 'pension_er', 'levy', 'wht', 'other_ded', 'net', 'er_benefits', 'taxable_benefits'];
const WORK_CODE = { days: 'day_work', piece: 'piece_work', hours: 'extra_hours', invoice: 'contract_work' };
// Deductions that are the business's own money back (not paid on to anyone).
const OWN_DEDUCTIONS = ['loan', 'advance', 'staff_purchase', 'cash_shortage', 'uniform', 'salary_deduction', 'staff_savings'];
// Company vehicle used privately: the yearly taxable value by what the vehicle
// cost, its age and how much of its use is private. A starting point only:
// check it against the Income Tax Act schedule / TAJ and change it under
// Rates (setting payroll_mv_schedule). Rows: [cost up to, up to half private
// and up to 5 years old, up to half and older, over half and up to 5 years, over half and older].
const MV_SCHEDULE = [[300000, 40000, 30000, 48000, 40000], [700000, 50000, 40000, 60000, 48000], [1000000, 75000, 50000, 90000, 60000],
  [1500000, 90000, 60000, 108000, 72000], [null, 100000, 80000, 140000, 96000]];
// Paid with the wages but not pay: a loan handed out, the person's own savings coming back, expenses repaid.
// Never in gross pay (so not in the S01 / S02 / P24 figures); added to net pay.
const NOT_PAY = ['advance_paid', 'savings_payout', 'reimbursement', 'mileage'];
const PRIOR = ['prior_gross', 'prior_statutory', 'prior_paye', 'prior_nis', 'prior_nht', 'prior_ed', 'prior_pension'];

function register(app, deps) {
  const { query, getPool, requireAdmin, requireCap, userCan, mailer, glPost, getShop, weekFor } = deps;
  const can = (k) => [requireAdmin, requireCap(k)];
  const PV = can('payroll.view'), PR = can('payroll.run'), PA = can('payroll.approve');
  const n = (v) => (v == null || v === '' || isNaN(Number(v)) ? 0 : Number(v));
  const r2 = (v) => Math.round((n(v) + Number.EPSILON) * 100) / 100;
  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
  const addDays = (d, k) => new Date(new Date(d + 'T12:00:00Z').getTime() + k * 86400000).toISOString().slice(0, 10);
  const weekday = (d) => new Date(d + 'T12:00:00Z').getUTCDay();   // 0 = Sunday
  const today = () => new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10);
  function httpError(status, msg) { const e = new Error(msg); e.status = status; e.publicMessage = msg; return e; }
  function fail(res, e) { const s = e.status || 500; if (s >= 500) console.error('[payroll]', e); res.status(s).json({ error: e.publicMessage || e.message }); }
  async function tx(fn) {
    const c = await getPool().connect();
    try { await c.query('BEGIN'); const out = await fn(c); await c.query('COMMIT'); return out; }
    catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} throw e; }
    finally { c.release(); }
  }
  async function post() {
    if (!glPost) return;
    for (let i = 0; i < 8; i++) {
      try { const r = await glPost(); if (!r || !r.busy) return r; } catch (e) { console.warn('[payroll] post', e.message); return null; }
      await new Promise((ok) => setTimeout(ok, 400));
    }
  }
  async function settings() {
    const { rows } = await query(`SELECT key, value FROM warehouse_settings WHERE key LIKE 'payroll\\_%'`);
    const s = Object.assign({}, SETTINGS);
    for (const r of rows) if (r.key in SETTINGS) s[r.key] = r.value == null ? '' : r.value;
    return s;
  }
  const on = (s, k) => s[k] === 'on';
  const mask = (v, keep = 4) => (v ? String(v).replace(/\s/g, '').replace(new RegExp('.(?=.{' + keep + '})', 'g'), '•') : '');

  // ------------------------------------------------------------ the switch --
  // Everything under /api/payroll is closed while the module is off, except
  // the switch itself (so it can be turned on).
  app.use('/api/payroll', async (req, res, next) => {
    if (req.path === '/module') return next();
    try { const s = await settings(); if (on(s, 'payroll_module')) return next(); } catch (e) { return fail(res, e); }
    res.status(404).json({ error: 'Payroll is switched off. A manager can switch it on in Payroll > Settings.', off: true });
  });
  app.get('/api/payroll/module', requireAdmin, async (req, res) => {
    try {
      const s = await settings();
      const [v, r, a] = await Promise.all([userCan(req, 'payroll.view'), userCan(req, 'payroll.run'), userCan(req, 'payroll.approve')]);
      const { rows } = await query(`SELECT id FROM payroll_employees WHERE user_id = $1`, [req.session.userId]);
      res.json({ on: on(s, 'payroll_module'), can_view: v, can_run: r, can_approve: a, self_service: on(s, 'payroll_self_service') && rows.length > 0 });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/payroll/module', ...PR, async (req, res) => {
    try {
      const v = req.body && req.body.on ? 'on' : 'off';
      await query(`INSERT INTO warehouse_settings (key, value) VALUES ('payroll_module', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [v]);
      res.json({ ok: true, on: v === 'on' });
    } catch (e) { fail(res, e); }
  });

  // -------------------------------------------------------------- settings --
  app.get('/api/payroll/settings', ...PV, async (req, res) => {
    try { res.json({ settings: await settings() }); } catch (e) { fail(res, e); }
  });
  app.put('/api/payroll/settings', ...PR, async (req, res) => {
    try {
      const b = req.body || {};
      for (const k of Object.keys(SETTINGS)) {
        if (!(k in b) || k === 'payroll_module') continue;
        let v = String(b[k] == null ? '' : b[k]).trim().slice(0, 60);
        if (/_days$|_max$/.test(k)) v = String(Math.max(0, Math.min(60, n(v))));
        else if (!/_trn$|_nis$/.test(k)) v = (v === 'on' || v === 'true') ? 'on' : 'off';
        await query(`INSERT INTO warehouse_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [k, v]);
      }
      res.json({ ok: true, settings: await settings() });
    } catch (e) { fail(res, e); }
  });

  // ----------------------------------------------------------------- rates --
  async function ratesFor(q, payDate) {
    const { rows } = await q(`SELECT * FROM payroll_rates WHERE effective_from <= $1 ORDER BY effective_from DESC LIMIT 1`, [payDate]);
    if (rows.length) return rows[0];
    const { rows: first } = await q(`SELECT * FROM payroll_rates ORDER BY effective_from LIMIT 1`);
    if (!first.length) throw httpError(409, 'No statutory rates are set up. Add them under Payroll > Rates.');
    return first[0];
  }
  app.get('/api/payroll/rates', ...PV, async (req, res) => {
    try {
      const { rows } = await query(`SELECT r.*, to_char(r.effective_from, 'YYYY-MM-DD') AS effective_from, u.name AS updated_by_name FROM payroll_rates r LEFT JOIN users u ON u.id = r.updated_by ORDER BY r.effective_from DESC`);
      res.json({ rates: rows, current: rows.find((r) => r.effective_from <= today()) || null });
    } catch (e) { fail(res, e); }
  });
  const RATE_COLS = ['paye_threshold', 'paye_rate1', 'paye_band2_from', 'paye_rate2', 'nis_ee', 'nis_er', 'nis_ceiling', 'nht_ee', 'nht_er', 'ed_ee', 'ed_er', 'heart_er', 'pension_cap', 'min_wage_week', 'min_wage_hours',
    'levy_rate', 'wht_rate', 'wht_threshold', 'wht_aggregate', 'age_relief', 'age_relief_from'];
  app.post('/api/payroll/rates', ...PR, async (req, res) => {
    try {
      const b = req.body || {};
      if (!isDate(b.effective_from)) throw httpError(400, 'Choose the date the rates take effect');
      if (!(n(b.paye_threshold) > 0)) throw httpError(400, 'Enter the annual tax-free threshold');
      for (const k of RATE_COLS) if (/_(ee|er|rate1|rate2|cap)$|^(levy|wht)_rate$/.test(k) && k !== 'age_relief' && (n(b[k]) < 0 || n(b[k]) > 1)) throw httpError(400, k + ' is a fraction: 3% is 0.03');
      const vals = RATE_COLS.map((k) => (b[k] === '' || b[k] == null ? null : n(b[k])));
      const { rows: cur } = await query(`SELECT * FROM payroll_rates WHERE effective_from <= $1 ORDER BY effective_from DESC LIMIT 1`, [b.effective_from]);
      RATE_COLS.forEach((k, i) => { if (vals[i] == null && k !== 'min_wage_week') vals[i] = cur.length ? n(cur[0][k]) : null; });
      if (vals.some((v, i) => v == null && RATE_COLS[i] !== 'min_wage_week')) throw httpError(400, 'Fill in every rate (this is the first row)');
      await query(
        `INSERT INTO payroll_rates (effective_from, ${RATE_COLS.join(', ')}, note, updated_by, updated_at)
         VALUES ($1, ${RATE_COLS.map((_, i) => '$' + (i + 2)).join(', ')}, $${RATE_COLS.length + 2}, $${RATE_COLS.length + 3}, NOW())
         ON CONFLICT (effective_from) DO UPDATE SET ${RATE_COLS.map((k) => k + ' = EXCLUDED.' + k).join(', ')}, note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
        [b.effective_from, ...vals, String(b.note || '').slice(0, 300) || null, req.session.userId]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------- earning / deduction types --
  async function itemMap(q = query) {
    const { rows } = await q(`SELECT * FROM payroll_items`);
    const m = {}; for (const r of rows) m[r.code] = r; return m;
  }
  // No two with the same name: capitals and extra spaces do not make a name different.
  const sameName = (s) => String(s == null ? '' : s).trim().replace(/\s+/g, ' ').toLowerCase();
  const SAME_NAME_SQL = (col) => `lower(regexp_replace(btrim(${col}), '\\s+', ' ', 'g'))`;
  async function itemNameFree(label, exceptCode) {
    if (!sameName(label)) return;
    const { rows } = await query(`SELECT label, kind FROM payroll_items WHERE ${SAME_NAME_SQL('label')} = $1 AND ($2::text IS NULL OR code <> $2) LIMIT 1`, [sameName(label), exceptCode]);
    if (rows.length) throw httpError(409, 'There is already ' + (rows[0].kind === 'earning' ? 'an earning' : rows[0].kind === 'deduction' ? 'a deduction' : 'an employer item') + ' called "' + rows[0].label + '". Give this one a different name.');
  }
  async function employeeNameFree(name, exceptId) {
    const { rows } = await query(`SELECT id, name, is_active, employee_no FROM payroll_employees WHERE ${SAME_NAME_SQL('name')} = $1 AND ($2::int IS NULL OR id <> $2) ORDER BY is_active DESC LIMIT 1`, [sameName(name), exceptId]);
    if (rows.length) {
      throw httpError(409, '"' + rows[0].name + '" is already on payroll' + (rows[0].employee_no ? ' (no. ' + rows[0].employee_no + ')' : '') + (rows[0].is_active ? '' : ', marked not active')
        + '. Open that record instead, or if this is a different person add something to tell them apart (a middle name or initial).');
    }
  }
  app.get('/api/payroll/items', ...PV, async (req, res) => {
    try {
      const { rows } = await query(`SELECT i.*, a.code AS gl_code, a.name AS gl_name FROM payroll_items i LEFT JOIN gl_accounts a ON a.id = i.gl_account_id ORDER BY i.kind DESC, i.sort, i.label`);
      res.json({ items: rows });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/payroll/items', ...PR, async (req, res) => {
    try {
      const b = req.body || {};
      const label = String(b.label || '').trim().slice(0, 60);
      if (!label) throw httpError(400, 'Name the earning or deduction');
      const kind = ['deduction', 'employer'].includes(b.kind) ? b.kind : 'earning';
      let code = String(b.code || label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30);
      if (!code) throw httpError(400, 'Give it a code');
      await itemNameFree(label, null);
      const { rows: ex } = await query(`SELECT 1 FROM payroll_items WHERE code = $1`, [code]);
      if (ex.length) code = code + '_' + Date.now().toString(36).slice(-4);
      const f = (k) => (kind === 'deduction' ? false : b[k] !== false);
      // paid_outside: an earning the person already has (cash tips kept): taxed as ticked, not paid again.
      // notional: a benefit in kind (nothing is paid to anyone). is_savings: a deduction that builds up a balance.
      await query(`INSERT INTO payroll_items (code, label, kind, paye, nis, nht, ed, heart, gl_account_id, sort, paid_outside, notional, is_savings) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [code, label, kind, kind === 'employer' ? !!b.paye : f('paye'), kind === 'employer' ? !!b.nis : f('nis'), kind === 'employer' ? !!b.nht : f('nht'), kind === 'employer' ? !!b.ed : f('ed'), kind === 'employer' ? !!b.heart : f('heart'), parseInt(b.gl_account_id, 10) || null, kind === 'deduction' ? 140 : kind === 'employer' ? 210 : 70,
          kind === 'earning' && !!b.paid_outside, kind === 'employer' && !!b.notional, kind === 'deduction' && !!b.is_savings]);
      res.json({ ok: true, code });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/payroll/items/:code', ...PR, async (req, res) => {
    try {
      const b = req.body || {};
      const { rows } = await query(`SELECT * FROM payroll_items WHERE code = $1`, [req.params.code]);
      if (!rows.length) throw httpError(404, 'Not found');
      const it = rows[0], ded = it.kind === 'deduction';
      if ('label' in b && sameName(b.label) !== sameName(it.label)) await itemNameFree(String(b.label || '').trim(), it.code);
      const flag = (k) => (ded ? false : (k in b ? !!b[k] : it[k]));
      // Worked-out items (basic pay, overtime...) are always paid through payroll.
      const outside = it.kind === 'earning' && !it.is_system && 'paid_outside' in b ? !!b.paid_outside : it.paid_outside;
      await query(`UPDATE payroll_items SET label = $2, paye = $3, nis = $4, nht = $5, ed = $6, heart = $7, gl_account_id = $8, is_active = $9, pension_relief = $10, paid_outside = $11, notional = $12, is_savings = $13 WHERE code = $1`,
        [it.code, String(b.label || it.label).trim().slice(0, 60), flag('paye'), flag('nis'), flag('nht'), flag('ed'), flag('heart'),
          'gl_account_id' in b ? (parseInt(b.gl_account_id, 10) || null) : it.gl_account_id, it.is_system ? true : ('is_active' in b ? !!b.is_active : it.is_active), ded && 'pension_relief' in b ? !!b.pension_relief : it.pension_relief, outside,
          it.kind === 'employer' && 'notional' in b ? !!b.notional : it.notional, ded && !it.is_system && 'is_savings' in b ? !!b.is_savings : it.is_savings]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------------- employees --
  const EMP_TEXT = ['employee_no', 'name', 'email', 'phone', 'address', 'trn', 'nis_no', 'termination_reason', 'job_title', 'department', 'bank_name', 'bank_branch', 'bank_account', 'bank_account_type', 'pension_scheme', 'notes', 'business_name', 'tcc_no', 'prior_employer'];
  const EMP_DATE = ['date_of_birth', 'hire_date', 'termination_date', 'tcc_expiry'];
  const EMP_NUM = ['salary_annual', 'hourly_rate', 'ot_rate', 'hours_per_period', 'hours_per_day', 'pension_ee_pct', 'pension_er_pct', 'extra_threshold', 'vacation_days', 'sick_days', 'day_rate', 'fee_per_period', ...PRIOR];
  const EMP_BOOL = ['use_timeclock', 'paye_exempt', 'nis_exempt', 'nht_exempt', 'ed_exempt', 'is_active', 'levy_applies', 'wht_applies', 'age_relief'];
  const PAY_TYPES = ['salary', 'hourly', 'daily', 'piece', 'contract'], WORKER_TYPES = ['employee', 'day_worker', 'contractor'];
  function empValues(b, cur) {
    const out = {};
    for (const k of EMP_TEXT) out[k] = k in b ? (String(b[k] == null ? '' : b[k]).trim().slice(0, k === 'notes' || k === 'address' ? 500 : 120) || null) : (cur ? cur[k] : null);
    for (const k of EMP_DATE) out[k] = k in b ? (isDate(b[k]) ? b[k] : null) : (cur ? cur[k] : null);
    for (const k of EMP_NUM) out[k] = k in b ? (b[k] === '' || b[k] == null ? null : n(b[k])) : (cur ? cur[k] : null);
    for (const k of EMP_BOOL) out[k] = k in b ? !!b[k] : (cur ? cur[k] : (k === 'use_timeclock' || k === 'is_active' || k === 'age_relief'));
    out.worker_type = WORKER_TYPES.includes(b.worker_type) ? b.worker_type : (cur ? cur.worker_type : 'employee');
    out.pay_type = PAY_TYPES.includes(b.pay_type) ? b.pay_type : (cur ? cur.pay_type : (out.worker_type === 'contractor' ? 'contract' : out.worker_type === 'day_worker' ? 'daily' : 'salary'));
    out.frequency = PERIODS[b.frequency] ? b.frequency : (cur ? cur.frequency : 'monthly');
    out.pay_method = ['bank', 'cheque', 'cash'].includes(b.pay_method) ? b.pay_method : (cur ? cur.pay_method : 'bank');
    out.user_id = 'user_id' in b ? (parseInt(b.user_id, 10) || null) : (cur ? cur.user_id : null);
    out.paye_method = ['non_cumulative', 'cumulative'].includes(b.paye_method) ? b.paye_method : (cur ? cur.paye_method : 'non_cumulative');
    // Pay and deductions with an earlier employer belong to one year (the P45's).
    out.prior_year = 'prior_year' in b ? (/^\d{4}$/.test(String(b.prior_year || '')) ? Number(b.prior_year) : null) : (cur ? cur.prior_year : null);
    const hasPrior = PRIOR.some((k) => n(out[k]) > 0);
    if (hasPrior && !out.prior_year) out.prior_year = Number((out.hire_date || today()).slice(0, 4));
    if (hasPrior && !(n(out.prior_statutory) > 0) && n(out.prior_gross) > 0) out.prior_statutory = r2(Math.max(0, n(out.prior_gross) - n(out.prior_nis) - n(out.prior_pension)));
    for (const k of PRIOR) if (n(out[k]) < 0) throw httpError(400, 'The figures from the earlier employer cannot be negative');
    if (out.ot_rate == null) out.ot_rate = 1.5;
    if (out.hours_per_day == null) out.hours_per_day = 8;
    for (const k of ['pension_ee_pct', 'pension_er_pct', 'extra_threshold']) if (out[k] == null) out[k] = 0;
    if (!out.name) throw httpError(400, 'Enter the employee\'s name');
    if (out.trn && !/^\d{3}-?\d{3}-?\d{3}$/.test(out.trn)) throw httpError(400, 'A TRN is nine digits (123-456-789)');
    if (out.worker_type === 'contractor' && out.pay_type === 'salary') throw httpError(400, 'A contractor is paid by the hour, day, job or invoice, not a salary');
    if (out.worker_type !== 'contractor') { out.levy_applies = false; out.wht_applies = false; }
    if (out.pay_type === 'salary' && !(n(out.salary_annual) > 0) && out.is_active) throw httpError(400, 'Enter the yearly salary');
    if (out.pay_type === 'hourly' && !(n(out.hourly_rate) > 0) && out.is_active) throw httpError(400, 'Enter the hourly rate');
    if (out.pay_type === 'daily' && !(n(out.day_rate) > 0) && out.is_active) throw httpError(400, 'Enter the day rate');
    if (n(out.pension_ee_pct) > 100 || n(out.pension_er_pct) > 100) throw httpError(400, 'Pension is a percentage of pay');
    return out;
  }
  const empCols = () => [...EMP_TEXT, ...EMP_DATE, ...EMP_NUM, ...EMP_BOOL, 'pay_type', 'worker_type', 'frequency', 'pay_method', 'user_id', 'paye_method', 'prior_year'];
  const EMP_SELECT = `e.*, to_char(e.date_of_birth, 'YYYY-MM-DD') AS date_of_birth, to_char(e.hire_date, 'YYYY-MM-DD') AS hire_date, to_char(e.termination_date, 'YYYY-MM-DD') AS termination_date, to_char(e.tcc_expiry, 'YYYY-MM-DD') AS tcc_expiry, u.email AS user_email, u.name AS user_name`;

  app.get('/api/payroll/employees', ...PV, async (req, res) => {
    try {
      const all = req.query.all === '1';
      const { rows } = await query(`SELECT ${EMP_SELECT} FROM payroll_employees e LEFT JOIN users u ON u.id = e.user_id ${all ? '' : 'WHERE e.is_active'} ORDER BY e.is_active DESC, e.name`);
      const full = await userCan(req, 'payroll.run');
      res.json({ employees: rows.map((e) => Object.assign(e, full ? {} : { bank_account: mask(e.bank_account), trn: mask(e.trn, 3), nis_no: mask(e.nis_no, 3) }, { bank_masked: mask(e.bank_account) })) });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/payroll/employees/:id', ...PR, async (req, res) => {
    try {
      const { rows } = await query(`SELECT ${EMP_SELECT} FROM payroll_employees e LEFT JOIN users u ON u.id = e.user_id WHERE e.id = $1`, [parseInt(req.params.id, 10) || 0]);
      if (!rows.length) throw httpError(404, 'Not found');
      const e = rows[0];
      const { rows: items } = await query(`SELECT x.*, i.label, i.kind FROM payroll_employee_items x JOIN payroll_items i ON i.code = x.code WHERE x.employee_id = $1 ORDER BY x.is_active DESC, i.kind DESC, i.sort`, [e.id]);
      const year = today().slice(0, 4);
      res.json({ employee: e, items, ytd: await ytd(e.id, year + '-01-01', year + '-12-31'), leave: await leaveBalance(e, year),
        work: await workList(e.id), contracts: await contractList(e.id), loans: await loanList(e.id), savings: await savingsList(e.id), prior: priorFor(e, year),
        slips: (await query(`SELECT s.id, s.gross, s.net, s.paye, r.number, r.status, to_char(r.pay_date, 'YYYY-MM-DD') AS pay_date FROM payroll_slips s JOIN payroll_runs r ON r.id = s.run_id WHERE s.employee_id = $1 ORDER BY r.pay_date DESC LIMIT 60`, [e.id])).rows });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/payroll/employees', ...PR, async (req, res) => {
    try {
      const v = empValues(req.body || {}, null), cols = empCols();
      await employeeNameFree(v.name, null);
      if (v.user_id) { const { rows } = await query(`SELECT 1 FROM payroll_employees WHERE user_id = $1`, [v.user_id]); if (rows.length) throw httpError(409, 'That staff member is already on payroll'); }
      const { rows } = await query(`INSERT INTO payroll_employees (${cols.join(', ')}, updated_by) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(', ')}, $${cols.length + 1}) RETURNING id`, [...cols.map((k) => v[k]), req.session.userId]);
      res.json({ ok: true, id: rows[0].id });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/payroll/employees/:id', ...PR, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10) || 0;
      const { rows: cur } = await query(`SELECT ${EMP_SELECT} FROM payroll_employees e LEFT JOIN users u ON u.id = e.user_id WHERE e.id = $1`, [id]);
      if (!cur.length) throw httpError(404, 'Not found');
      const v = empValues(req.body || {}, cur[0]), cols = empCols();
      // Checked when the name changes or the person is made active again, so a
      // record that already shares a name can still be opened and put right.
      if (sameName(v.name) !== sameName(cur[0].name) || (v.is_active && !cur[0].is_active)) await employeeNameFree(v.name, id);
      if (v.user_id && v.user_id !== cur[0].user_id) { const { rows } = await query(`SELECT 1 FROM payroll_employees WHERE user_id = $1 AND id <> $2`, [v.user_id, id]); if (rows.length) throw httpError(409, 'That staff member is already on payroll'); }
      await query(`UPDATE payroll_employees SET ${cols.map((k, i) => k + ' = $' + (i + 2)).join(', ')}, updated_by = $${cols.length + 2}, updated_at = NOW() WHERE id = $1`, [id, ...cols.map((k) => v[k]), req.session.userId]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  // Staff in the system who are not on payroll yet (to add them in one go).
  app.get('/api/payroll/staff-not-on-payroll', ...PR, async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT u.id, u.name, u.email, u.employee_no, c.hourly_rate FROM users u LEFT JOIN staff_clock c ON c.user_id = u.id
          WHERE u.is_staff AND NOT u.disabled AND u.admin_role <> 'rep' AND NOT EXISTS (SELECT 1 FROM payroll_employees e WHERE e.user_id = u.id) ORDER BY u.name`);
      res.json({ staff: rows });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/payroll/employees/import-staff', ...PR, async (req, res) => {
    try {
      const ids = (Array.isArray(req.body && req.body.user_ids) ? req.body.user_ids : []).map((x) => parseInt(x, 10)).filter(Boolean);
      if (!ids.length) throw httpError(400, 'Tick the staff to add');
      let added = 0;
      const dupes = [];
      for (const uid of ids) {
        const { rows: nm } = await query(`SELECT name FROM users WHERE id = $1`, [uid]);
        if (nm.length) { try { await employeeNameFree(nm[0].name, null); } catch (e) { if (e.status !== 409) throw e; dupes.push(nm[0].name); continue; } }
        const { rows } = await query(
          `INSERT INTO payroll_employees (user_id, name, email, employee_no, pay_type, frequency, hourly_rate, is_active, updated_by)
           SELECT u.id, u.name, CASE WHEN u.email ~* '\\.local$' THEN NULL ELSE u.email END, u.employee_no,
                  CASE WHEN c.hourly_rate > 0 THEN 'hourly' ELSE 'salary' END, CASE WHEN c.hourly_rate > 0 THEN 'fortnightly' ELSE 'monthly' END,
                  c.hourly_rate, COALESCE(c.hourly_rate > 0, false), $2
             FROM users u LEFT JOIN staff_clock c ON c.user_id = u.id
            WHERE u.id = $1 AND u.is_staff AND NOT EXISTS (SELECT 1 FROM payroll_employees e WHERE e.user_id = u.id) RETURNING id`, [uid, req.session.userId]);
        added += rows.length;
      }
      res.json({ ok: true, added, skipped: dupes, note: (dupes.length ? 'Not added, the name is already on payroll: ' + dupes.join(', ') + '. ' : '') + 'People without an hourly rate on the time clock were added as not active: open each one, enter the pay, TRN and NIS number, then tick Active.' });
    } catch (e) { fail(res, e); }
  });
  // Recurring earnings and deductions.
  app.post('/api/payroll/employees/:id/items', ...PR, async (req, res) => {
    try {
      const b = req.body || {}, id = parseInt(req.params.id, 10) || 0;
      const { rows: it } = await query(`SELECT * FROM payroll_items WHERE code = $1 AND is_active`, [b.code]);
      if (!it.length) throw httpError(400, 'Choose the earning or deduction');
      const pct = b.pct === '' || b.pct == null ? null : n(b.pct);
      if (!(n(b.amount) > 0) && !(pct > 0)) throw httpError(400, 'Enter the amount each pay, or a percentage of pay');
      if (pct != null && (pct < 0 || pct > 100)) throw httpError(400, 'A percentage is 0 to 100');
      const bal = b.balance === '' || b.balance == null ? null : n(b.balance);
      if (['loan', 'advance'].includes(it[0].code) && !(bal > 0)) throw httpError(400, 'Enter how much is owed, so the deduction stops when it is paid');
      const { rows: e } = await query(`SELECT 1 FROM payroll_employees WHERE id = $1`, [id]);
      if (!e.length) throw httpError(404, 'Employee not found');
      if (it[0].code === 'child_maint' && !String(b.payee || '').trim()) throw httpError(400, 'Who is the maintenance paid to (the court or the person named in the order)?');
      const { rows } = await query(`INSERT INTO payroll_employee_items (employee_id, code, amount, balance, note, payee, reference, end_date, created_by, pct) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [id, it[0].code, pct > 0 ? 0 : r2(b.amount), bal == null ? null : r2(bal), String(b.note || '').slice(0, 120) || null, String(b.payee || '').trim().slice(0, 80) || null,
          String(b.reference || '').trim().slice(0, 60) || null, isDate(b.end_date) ? b.end_date : null, req.session.userId, pct > 0 ? pct : null]);
      res.json({ ok: true, id: rows[0].id });
    } catch (e) { fail(res, e); }
  });
  // Savings: what has built up, per item.
  async function savingsList(empId, q = query) {
    const { rows } = await q(
      `SELECT x.id, x.code, i.label, x.amount::float AS per_pay, x.pct::float AS pct, x.saved::float AS saved, x.payout_pending::float AS payout_pending, x.is_active, x.payee, x.reference
         FROM payroll_employee_items x JOIN payroll_items i ON i.code = x.code WHERE x.employee_id = $1 AND i.is_savings ORDER BY x.id`, [empId]);
    return rows.map((r) => Object.assign(r, { held: r.code === 'staff_savings' }));
  }
  // Pay savings held by the business back to the person on their next payslip.
  app.post('/api/payroll/employee-items/:id/payout', ...PR, async (req, res) => {
    try {
      const { rows } = await query(`SELECT x.*, i.is_savings FROM payroll_employee_items x JOIN payroll_items i ON i.code = x.code WHERE x.id = $1`, [parseInt(req.params.id, 10) || 0]);
      if (!rows.length || !rows[0].is_savings) throw httpError(404, 'Not a savings item');
      const x = rows[0];
      if (x.code !== 'staff_savings') throw httpError(409, 'These savings are paid over to someone else (a credit union or partner plan): the person takes them out there');
      const b = req.body || {};
      const amount = b.amount === '' || b.amount == null ? n(x.saved) : r2(b.amount);
      if (amount < 0 || amount > n(x.saved) + 0.004) throw httpError(400, 'No more than has been saved (' + r2(x.saved).toFixed(2) + ')');
      await query(`UPDATE payroll_employee_items SET payout_pending = $2 WHERE id = $1`, [x.id, amount]);
      res.json({ ok: true, amount, note: amount > 0 ? 'It is added to the next payslip (not taxed: it is their own money).' : 'The payout is cancelled.' });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/payroll/employee-items/:id', ...PR, async (req, res) => {
    try {
      const b = req.body || {};
      const { rows } = await query(`SELECT * FROM payroll_employee_items WHERE id = $1`, [parseInt(req.params.id, 10) || 0]);
      if (!rows.length) throw httpError(404, 'Not found');
      const x = rows[0];
      await query(`UPDATE payroll_employee_items SET amount = $2, balance = $3, note = $4, is_active = $5, payee = $6, reference = $7, end_date = $8, pct = $9 WHERE id = $1`,
        [x.id, 'amount' in b ? r2(b.amount) : x.amount, 'balance' in b ? (b.balance === '' || b.balance == null ? null : r2(b.balance)) : x.balance,
          'note' in b ? (String(b.note || '').slice(0, 120) || null) : x.note, 'is_active' in b ? !!b.is_active : x.is_active,
          'payee' in b ? (String(b.payee || '').trim().slice(0, 80) || null) : x.payee, 'reference' in b ? (String(b.reference || '').trim().slice(0, 60) || null) : x.reference,
          'end_date' in b ? (isDate(b.end_date) ? b.end_date : null) : x.end_date, 'pct' in b ? (b.pct === '' || b.pct == null ? null : n(b.pct)) : x.pct]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------- work, invoices and contracts --
  // Work waiting to be paid: not void, and not on a live payslip (other than `slipId`).
  const OPEN_WORK = (alias, slipParam) => `${alias}.voided_at IS NULL AND (${alias}.slip_id IS NULL ${slipParam ? `OR ${alias}.slip_id = ${slipParam}` : ''}
      OR EXISTS (SELECT 1 FROM payroll_slips ws JOIN payroll_runs wr ON wr.id = ws.run_id WHERE ws.id = ${alias}.slip_id AND wr.status = 'void'))`;
  const WORK_SELECT = `w.*, to_char(w.work_date, 'YYYY-MM-DD') AS work_date, c.title AS contract, e.name AS employee, e.worker_type,
      CASE WHEN w.voided_at IS NOT NULL THEN 'void' WHEN ${OPEN_WORK('w')} THEN 'open' WHEN r.status = 'draft' THEN 'on draft' ELSE 'paid' END AS status, r.number AS run_number, r.id AS run_id
      FROM payroll_work w JOIN payroll_employees e ON e.id = w.employee_id LEFT JOIN payroll_contracts c ON c.id = w.contract_id
      LEFT JOIN payroll_slips s ON s.id = w.slip_id LEFT JOIN payroll_runs r ON r.id = s.run_id`;
  async function workList(empId) {
    const { rows } = await query(`SELECT ${WORK_SELECT} WHERE w.employee_id = $1 ORDER BY w.work_date DESC, w.id DESC LIMIT 200`, [empId]);
    return rows;
  }
  async function contractList(empId) {
    const { rows } = await query(
      `SELECT c.*, to_char(c.start_date, 'YYYY-MM-DD') AS start_date, to_char(c.end_date, 'YYYY-MM-DD') AS end_date,
              COALESCE((SELECT SUM(w.amount) FROM payroll_work w WHERE w.contract_id = c.id AND w.voided_at IS NULL), 0)::float AS billed,
              COALESCE((SELECT SUM(w.amount) FROM payroll_work w JOIN payroll_slips s ON s.id = w.slip_id JOIN payroll_runs r ON r.id = s.run_id
                         WHERE w.contract_id = c.id AND w.voided_at IS NULL AND r.status IN ('approved', 'paid')), 0)::float AS paid
         FROM payroll_contracts c WHERE c.employee_id = $1 ORDER BY c.status, c.id DESC`, [empId]);
    return rows.map((c) => Object.assign(c, { remaining: c.value == null ? null : r2(n(c.value) - c.billed) }));
  }
  app.get('/api/payroll/work', ...PV, async (req, res) => {
    try {
      const st = ['open', 'all'].includes(req.query.status) ? req.query.status : 'open';
      const { rows } = await query(`SELECT ${WORK_SELECT} WHERE ${st === 'open' ? OPEN_WORK('w') : 'true'} ORDER BY w.work_date DESC, w.id DESC LIMIT 500`);
      res.json({ work: rows });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/payroll/employees/:id/work', ...PR, async (req, res) => {
    try {
      const b = req.body || {}, eid = parseInt(req.params.id, 10) || 0;
      const emp = await loadEmp(eid);
      if (!emp) throw httpError(404, 'Employee not found');
      const kind = WORK_CODE[b.kind] ? b.kind : null;
      if (!kind) throw httpError(400, 'Days, piece work, hours or an invoice?');
      if (!isDate(b.work_date)) throw httpError(400, 'Enter the date of the work or invoice');
      const description = String(b.description || '').trim().slice(0, 160);
      if (!description) throw httpError(400, 'Say what the work was');
      let qty = n(b.qty), rate = n(b.rate), amount;
      if (kind === 'invoice') { amount = r2(b.amount); qty = 1; rate = amount; }
      else {
        if (!(qty > 0)) throw httpError(400, 'Enter how many (days, pieces or hours)');
        if (!rate) rate = kind === 'days' ? n(emp.day_rate) : kind === 'hours' ? n(emp.hourly_rate) : 0;
        amount = r2(qty * rate);
      }
      if (!(amount > 0)) throw httpError(400, 'Enter the rate or amount');
      const inv = String(b.invoice_no || '').trim().slice(0, 40) || null;
      if (inv) { const { rows } = await query(`SELECT 1 FROM payroll_work WHERE employee_id = $1 AND lower(invoice_no) = lower($2) AND voided_at IS NULL`, [eid, inv]); if (rows.length) throw httpError(409, 'Invoice ' + inv + ' from ' + emp.name + ' is already entered'); }
      const cid = parseInt(b.contract_id, 10) || null;
      if (cid) { const { rows } = await query(`SELECT value, (SELECT COALESCE(SUM(amount), 0) FROM payroll_work WHERE contract_id = $1 AND voided_at IS NULL) AS billed FROM payroll_contracts WHERE id = $1 AND employee_id = $2 AND status = 'open'`, [cid, eid]);
        if (!rows.length) throw httpError(400, 'That contract is not open for ' + emp.name);
        if (rows[0].value != null && n(rows[0].billed) + amount > n(rows[0].value) + 0.004 && !b.over_ok) throw httpError(409, 'This takes the contract over its agreed price (' + r2(rows[0].value).toFixed(2) + '); tick "over the price is agreed" to enter it anyway'); }
      const { rows } = await query(`INSERT INTO payroll_work (employee_id, kind, work_date, description, qty, rate, amount, invoice_no, contract_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [eid, kind, b.work_date, description, qty, rate, amount, inv, cid, req.session.userId]);
      res.json({ ok: true, id: rows[0].id, amount });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/payroll/work/:id/void', ...PR, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10) || 0;
      const { rows } = await query(`SELECT w.id FROM payroll_work w WHERE w.id = $1 AND ${OPEN_WORK('w')}`, [id]);
      if (!rows.length) throw httpError(409, 'Only work not yet on a pay run can be removed (take it off the draft first)');
      await query(`UPDATE payroll_work SET voided_at = NOW() WHERE id = $1`, [id]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/payroll/employees/:id/contracts', ...PR, async (req, res) => {
    try {
      const b = req.body || {}, eid = parseInt(req.params.id, 10) || 0;
      if (!(await loadEmp(eid))) throw httpError(404, 'Employee not found');
      const title = String(b.title || '').trim().slice(0, 120);
      if (!title) throw httpError(400, 'Name the contract (the job)');
      const { rows } = await query(`INSERT INTO payroll_contracts (employee_id, title, value, start_date, end_date, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [eid, title, b.value === '' || b.value == null ? null : r2(b.value), isDate(b.start_date) ? b.start_date : null, isDate(b.end_date) ? b.end_date : null, String(b.notes || '').slice(0, 300) || null, req.session.userId]);
      res.json({ ok: true, id: rows[0].id });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/payroll/contracts/:id', ...PR, async (req, res) => {
    try {
      const b = req.body || {};
      const { rowCount } = await query(`UPDATE payroll_contracts SET status = COALESCE($2, status), value = CASE WHEN $3::boolean THEN $4 ELSE value END, notes = COALESCE($5, notes) WHERE id = $1`,
        [parseInt(req.params.id, 10) || 0, ['open', 'done', 'cancelled'].includes(b.status) ? b.status : null, 'value' in b, b.value === '' || b.value == null ? null : r2(b.value), b.notes == null ? null : String(b.notes).slice(0, 300)]);
      if (!rowCount) throw httpError(404, 'Not found');
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------- loans and salary advances --
  async function loanList(empId) {
    const { rows } = await query(
      `SELECT l.*, to_char(l.issue_date, 'YYYY-MM-DD') AS issue_date, i.amount::float AS per_pay, i.balance::float AS balance, i.is_active AS repaying, a.code || ' ' || a.name AS account,
              r.number AS paid_on_run, r.status AS run_status
         FROM payroll_loans l LEFT JOIN payroll_employee_items i ON i.id = l.item_id LEFT JOIN gl_accounts a ON a.id = l.account_id
         LEFT JOIN payroll_slips s ON s.id = l.slip_id LEFT JOIN payroll_runs r ON r.id = s.run_id
        WHERE l.employee_id = $1 ORDER BY l.id DESC`, [empId]);
    for (const l of rows) {
      l.repaid = l.voided_at ? 0 : r2(n(l.amount) - n(l.balance));
      l.status = l.voided_at ? 'void' : l.method === 'payslip' && !(l.run_status === 'approved' || l.run_status === 'paid') ? 'to be paid on the next payslip' : n(l.balance) <= 0.004 ? 'repaid' : 'repaying';
    }
    return rows;
  }
  app.post('/api/payroll/employees/:id/loans', ...PR, async (req, res) => {
    try {
      const b = req.body || {}, s = await settings(), eid = parseInt(req.params.id, 10) || 0;
      const emp = await loadEmp(eid);
      if (!emp) throw httpError(404, 'Employee not found');
      const kind = b.kind === 'advance' ? 'advance' : 'loan', amount = r2(b.amount), repay = r2(b.repay_per_pay || b.amount);
      if (!(amount > 0)) throw httpError(400, 'Enter the amount');
      if (!(repay > 0) || repay > amount) throw httpError(400, 'Enter how much comes off each pay (no more than the amount)');
      const method = b.method === 'payslip' ? 'payslip' : 'bank';
      const acct = parseInt(b.account_id, 10) || null;
      if (method === 'bank') { const { rows } = await query(`SELECT id FROM gl_accounts WHERE id = $1 AND type = 'asset' AND is_active`, [acct || 0]); if (!rows.length) throw httpError(400, 'Choose the account the money was paid from'); }
      const date = isDate(b.issue_date) ? b.issue_date : today();
      const id = await tx(async (c) => {
        const { rows: it } = await c.query(`INSERT INTO payroll_employee_items (employee_id, code, amount, balance, note, is_active, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [eid, kind, repay, amount, (kind === 'loan' ? 'Loan ' : 'Advance ') + date, method === 'bank', req.session.userId]);
        const { rows } = await c.query(`INSERT INTO payroll_loans (employee_id, kind, amount, issue_date, method, account_id, item_id, reference, note, post_gl, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
          [eid, kind, amount, date, method, method === 'bank' ? acct : null, it[0].id, String(b.reference || '').slice(0, 60) || null, String(b.note || '').slice(0, 200) || null, on(s, 'payroll_post_ledger'), req.session.userId]);
        return rows[0].id;
      });
      if (method === 'bank') await post();
      res.json({ ok: true, id, note: method === 'payslip' ? 'It is added to ' + emp.name + '\'s next payslip; repayments start on the pay after that.' : 'Repayments start on the next payslip.' });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/payroll/loans/:id/void', ...PR, async (req, res) => {
    try {
      const reason = String((req.body && req.body.reason) || '').trim().slice(0, 200);
      if (!reason) throw httpError(400, 'Say why it is cancelled');
      const { rows } = await query(`SELECT l.*, i.balance, r.status AS run_status FROM payroll_loans l LEFT JOIN payroll_employee_items i ON i.id = l.item_id
                                      LEFT JOIN payroll_slips s ON s.id = l.slip_id LEFT JOIN payroll_runs r ON r.id = s.run_id WHERE l.id = $1 AND l.voided_at IS NULL`, [parseInt(req.params.id, 10) || 0]);
      if (!rows.length) throw httpError(404, 'Not found or already cancelled');
      const l = rows[0];
      if (n(l.balance) < n(l.amount) - 0.004) throw httpError(409, 'Repayments have been taken: stop the repayments instead, or pay it off');
      if (l.method === 'payslip' && ['approved', 'paid'].includes(l.run_status)) throw httpError(409, 'It was already paid out on a payslip: void that pay run first');
      if (l.method === 'payslip' && l.run_status === 'draft') throw httpError(409, 'It is on a draft pay run: recalculate or take it off that run first');
      await tx(async (c) => {
        await c.query(`UPDATE payroll_loans SET voided_at = NOW(), voided_by = $2, void_reason = $3 WHERE id = $1`, [l.id, req.session.userId, reason]);
        if (l.item_id) await c.query(`UPDATE payroll_employee_items SET is_active = false WHERE id = $1`, [l.item_id]);
      });
      await post();
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ----------------------------------------------------------- leave, YTD --
  async function leaveBalance(e, year) {
    const s = await settings();
    const out = { year, vacation_entitled: e.vacation_days != null ? n(e.vacation_days) : n(s.payroll_vacation_days), sick_entitled: e.sick_days != null ? n(e.sick_days) : n(s.payroll_sick_days), vacation_taken: 0, sick_taken: 0, unpaid_taken: 0 };
    if (e.user_id) {
      const { rows } = await query(
        `SELECT l.kind, COUNT(*)::int AS days FROM staff_leave l, generate_series(GREATEST(l.from_date, $2::date), LEAST(l.to_date, $3::date), interval '1 day') g(d)
          WHERE l.user_id = $1 AND l.to_date >= $2::date AND l.from_date <= $3::date AND EXTRACT(DOW FROM g.d) <> 0 GROUP BY l.kind`, [e.user_id, year + '-01-01', year + '-12-31']);
      for (const r of rows) { if (r.kind === 'vacation') out.vacation_taken = r.days; else if (r.kind === 'sick') out.sick_taken = r.days; else if (r.kind === 'unpaid') out.unpaid_taken = r.days; }
      // Days carried forward at year end, and other adjustments made in People.
      const { rows: adj } = await query(`SELECT kind, COALESCE(SUM(days), 0)::float AS days FROM hr_leave_adjustments WHERE user_id = $1 AND year = $2 GROUP BY kind`, [e.user_id, Number(year)]);
      for (const a of adj) { if (a.kind === 'vacation') { out.vacation_entitled += a.days; out.vacation_adjusted = a.days; } else if (a.kind === 'sick') { out.sick_entitled += a.days; out.sick_adjusted = a.days; } }
    }
    out.vacation_left = out.vacation_entitled - out.vacation_taken;
    out.sick_left = out.sick_entitled - out.sick_taken;
    return out;
  }
  // Totals for one person over approved / paid runs paid in [from, to].
  async function ytd(empId, from, to, q = query) {
    const { rows } = await q(
      `SELECT ${STAT.map((k) => `COALESCE(SUM(s.${k}), 0)::float AS ${k}`).join(', ')}, COUNT(*)::int AS slips
         FROM payroll_slips s JOIN payroll_runs r ON r.id = s.run_id
        WHERE s.employee_id = $1 AND r.status IN ('approved', 'paid') AND r.pay_date BETWEEN $2 AND $3`, [empId, from, to]);
    return rows[0];
  }

  // Pay and deductions with an earlier employer in this year (off the P45).
  function priorFor(e, year) {
    if (!e || Number(e.prior_year) !== Number(year) || !PRIOR.some((k) => n(e[k]) > 0)) return null;
    return { year: Number(year), employer: e.prior_employer || null, gross: n(e.prior_gross), statutory: n(e.prior_statutory), paye: n(e.prior_paye), nis: n(e.prior_nis), nht: n(e.prior_nht), ed: n(e.prior_ed), pension: n(e.prior_pension) };
  }
  const ageOn = (dob, date) => { if (!dob || !date) return null; const a = Number(date.slice(0, 4)) - Number(String(dob).slice(0, 4)); return date.slice(5) < String(dob).slice(5, 10) ? a - 1 : a; };
  // Tax-free income a year: the threshold, the person's own extra amount, and age relief from the age in the rates.
  function freeYear(emp, rt, date) {
    const age = ageOn(emp.date_of_birth, date);
    const relief = emp.age_relief !== false && age != null && n(rt.age_relief) > 0 && age >= (n(rt.age_relief_from) || 65) ? n(rt.age_relief) : 0;
    return { threshold: n(rt.paye_threshold), extra: n(emp.extra_threshold), age_relief: relief, total: n(rt.paye_threshold) + n(emp.extra_threshold) + relief };
  }
  // Which pay of the year a pay date is (1..52 / 26 / 12).
  function periodNo(freq, payDate) {
    if (freq === 'monthly') return Number(payDate.slice(5, 7));
    const len = freq === 'weekly' ? 7 : 14;
    const doy = Math.round((new Date(payDate + 'T12:00:00Z') - new Date(payDate.slice(0, 4) + '-01-01T12:00:00Z')) / 86400000) + 1;
    return Math.min(PERIODS[freq], Math.ceil(doy / len));
  }
  // Cumulative income tax: what the year so far looks like before this payslip:
  // tax-free pay and the higher-rate band for the pays gone by (at the rates in
  // force then), and statutory income and tax from approved runs and from an
  // earlier employer this year.
  async function cumFor(emp, run) {
    if (!emp || emp.paye_method !== 'cumulative' || emp.worker_type === 'contractor') return null;
    const freq = run.frequency, PP = PERIODS[freq], year = run.pay_date.slice(0, 4), jan1 = year + '-01-01', k = periodNo(freq, run.pay_date);
    const { rows: rates } = await query(`SELECT *, to_char(effective_from, 'YYYY-MM-DD') AS ef FROM payroll_rates ORDER BY effective_from`);
    const rateAt = (d) => { let r = rates[0]; for (const x of rates) if (x.ef <= d) r = x; return r; };
    let free = 0, band = 0;
    for (let i = 1; i < k; i++) {
      const d = freq === 'monthly' ? monthEnd(year + '-' + String(i).padStart(2, '0')) : addDays(jan1, i * (freq === 'weekly' ? 7 : 14) - 1);
      const r = rateAt(d);
      if (!r) continue;
      free += freeYear(emp, r, d).total / PP; band += n(r.paye_band2_from) / PP;
    }
    const { rows } = await query(
      `SELECT COALESCE(SUM(s.statutory), 0)::float AS statutory, COALESCE(SUM(s.paye), 0)::float AS paye, COUNT(*)::int AS slips
         FROM payroll_slips s JOIN payroll_runs r ON r.id = s.run_id
        WHERE s.employee_id = $1 AND r.status IN ('approved', 'paid') AND r.id <> $2 AND r.pay_date >= $3 AND (r.pay_date < $4 OR (r.pay_date = $4 AND r.id < $2))`, [emp.id, run.id || 0, jan1, run.pay_date]);
    const prior = priorFor(emp, year);
    return { period: k, free, band, statutory: r2(rows[0].statutory + (prior ? prior.statutory : 0)), paye: r2(rows[0].paye + (prior ? prior.paye : 0)), prior, slips: rows[0].slips };
  }

  // ------------------------------------------------------------- the maths --
  // Statutory figures for one payslip from its lines.
  // ctx: { date (the pay date, for age relief), cum (cumFor's result: cumulative income tax) }.
  function compute(lines, emp, rt, P, s, items, ctx) {
    const flag = (l, f) => (items[l.code] ? items[l.code][f] : l.kind === 'earning');
    const earn = lines.filter((l) => l.kind === 'earning'), ded = lines.filter((l) => l.kind === 'deduction'), er = lines.filter((l) => l.kind === 'employer');
    const sum = (arr) => r2(arr.reduce((t, l) => t + n(l.amount), 0));
    // Employer contributions are not cash: a ticked one is a taxable benefit and
    // joins that contribution's base; gross and net pay stay as paid.
    const base = (f) => Math.max(0, sum(earn.filter((l) => flag(l, f))) + sum(er.filter((l) => flag(l, f))));
    const nonPay = sum(earn.filter((l) => NOT_PAY.includes(l.code)));
    const gross = r2(sum(earn) - nonPay), bPaye = base('paye'), bNis = base('nis'), bNht = base('nht'), bEd = base('ed'), bHeart = base('heart');
    const cashPaye = Math.max(0, sum(earn.filter((l) => flag(l, 'paye'))));   // pensionable pay
    // A benefit in kind (a company vehicle, housing) costs nothing extra to pay over: taxed, not an employer cost here.
    const notional = (l) => !!(items[l.code] && items[l.code].notional);
    const other_ded0 = sum(ded), er_benefits = sum(er.filter((l) => !notional(l))), taxable_benefits = sum(er.filter((l) => flag(l, 'paye')));
    // Already in the person's hand (cash tips kept): in gross and taxed as ticked, not paid again.
    const received = sum(earn.filter((l) => items[l.code] && items[l.code].paid_outside));
    // A contractor is self-employed: no PAYE / NIS / NHT / Education Tax / HEART.
    // Contractor levy on construction, haulage and tillage work; withholding tax
    // on specified services when the business is a withholding agent.
    if (emp.worker_type === 'contractor') {
      const levy = emp.levy_applies ? r2(bPaye * n(rt.levy_rate)) : 0;
      let wht = 0;
      if (on(s, 'payroll_wht_agent') && emp.wht_applies) {
        for (const l of earn) {
          if (l.wht != null) wht += n(l.wht);
          else if (flag(l, 'paye') && n(l.amount) >= n(rt.wht_threshold)) wht += r2(n(l.amount) * n(rt.wht_rate));
        }
      }
      wht = r2(wht);
      const z = { statutory: 0, nis_ee: 0, nis_er: 0, nht_ee: 0, nht_er: 0, ed_ee: 0, ed_er: 0, heart_er: 0, paye: 0, pension_ee: 0, pension_er: 0 };
      return Object.assign(z, { gross, levy, wht, other_ded: other_ded0, net: r2(gross + nonPay - levy - wht - other_ded0 - received), er_benefits, taxable_benefits: 0 });
    }
    const pension_ee = r2(cashPaye * n(emp.pension_ee_pct) / 100);
    const pension_er = r2(cashPaye * n(emp.pension_er_pct) / 100);
    // Approved pension relief: the pension % plus voluntary / second-scheme
    // contributions to approved schemes, up to the cap of pensionable pay.
    const extraPension = sum(ded.filter((l) => items[l.code] && items[l.code].pension_relief));
    const pensionRelief = Math.min(r2(pension_ee + extraPension), r2(cashPaye * n(rt.pension_cap)));
    const nisBase = Math.min(bNis, n(rt.nis_ceiling) / P);
    const nis_ee = emp.nis_exempt ? 0 : r2(nisBase * n(rt.nis_ee));
    const nis_er = emp.nis_exempt ? 0 : r2(nisBase * n(rt.nis_er));
    const nht_ee = emp.nht_exempt ? 0 : r2(bNht * n(rt.nht_ee));
    const nht_er = emp.nht_exempt ? 0 : r2(bNht * n(rt.nht_er));
    const edBase = Math.max(0, bEd - nis_ee - pensionRelief);
    const ed_ee = emp.ed_exempt ? 0 : r2(edBase * n(rt.ed_ee));
    const ed_er = emp.ed_exempt ? 0 : r2(edBase * n(rt.ed_er));
    const heart_er = on(s, 'payroll_heart') ? r2(bHeart * n(rt.heart_er)) : 0;
    const statutory = r2(Math.max(0, bPaye - nis_ee - pensionRelief));
    const fy = freeYear(emp, rt, ctx && ctx.date), cum = ctx && ctx.cum;
    const thr = fy.total / P, band = n(rt.paye_band2_from) / P;
    const taxOn = (st, t, b) => n(rt.paye_rate1) * Math.max(0, Math.min(st, b) - t) + n(rt.paye_rate2) * Math.max(0, st - Math.max(b, t));
    let paye, tax;
    if (cum) {
      // Year to date: tax on everything so far, less the tax already paid.
      const statTD = r2(cum.statutory + statutory), freeTD = cum.free + thr, due = taxOn(statTD, freeTD, cum.band + band);
      paye = emp.paye_exempt ? 0 : r2(Math.max(0, due - cum.paye));
      tax = { method: 'cumulative', period: cum.period, periods: P, free_to_date: r2(freeTD), statutory_to_date: statTD, tax_to_date: r2(due), paid_before: r2(cum.paye), prior: cum.prior || null };
    } else {
      paye = emp.paye_exempt ? 0 : r2(taxOn(statutory, thr, band));
      tax = { method: 'non_cumulative', periods: P, free_period: r2(thr) };
    }
    Object.assign(tax, { threshold: fy.threshold, extra: fy.extra, age_relief: fy.age_relief, exempt: !!emp.paye_exempt });
    const other_ded = other_ded0;
    const net = r2(gross + nonPay - nis_ee - nht_ee - ed_ee - paye - pension_ee - other_ded - received);
    return { gross, statutory, nis_ee, nis_er, nht_ee, nht_er, ed_ee, ed_er, heart_er, paye, pension_ee, pension_er, levy: 0, wht: 0, other_ded, net, er_benefits, taxable_benefits, tax };
  }

  // Working days (by the person's shifts, else Monday-Saturday) between two dates.
  async function workDays(emp, from, to) {
    if (from > to) return [];
    let pattern = [1, 2, 3, 4, 5, 6];
    if (emp.user_id) {
      const { rows } = await query(`SELECT weekday FROM staff_shifts WHERE user_id = $1`, [emp.user_id]);
      if (rows.length) pattern = rows.map((r) => Number(r.weekday));
    }
    const out = [];
    for (let d = from; d <= to; d = addDays(d, 1)) if (pattern.includes(weekday(d))) out.push(d);
    return out;
  }

  // The lines for one person's payslip, worked out from their pay, the time
  // clock, leave, holidays, commission and their recurring items.
  async function build(emp, run, s, rt, slipId) {
    const P = PERIODS[run.frequency];
    const lines = [], warnings = [], commissionIds = [];
    const contractor = emp.worker_type === 'contractor';
    const start = run.period_start, end = run.period_end;
    const from = emp.hire_date && emp.hire_date > start ? emp.hire_date : start;
    const to = emp.termination_date && emp.termination_date < end ? emp.termination_date : end;
    if (from > to) warnings.push('Not employed in this period');
    const rate = n(emp.hourly_rate), hpd = n(emp.hours_per_day) || 8;
    const { rows: hol } = await query(`SELECT to_char(day, 'YYYY-MM-DD') AS day, name FROM public_holidays WHERE day BETWEEN $1 AND $2 ORDER BY day`, [from, to]);
    const leave = { vacation: [], sick: [], unpaid: [] };
    if (emp.user_id && from <= to) {
      const { rows } = await query(
        `SELECT l.kind, to_char(g.d, 'YYYY-MM-DD') AS day FROM staff_leave l, generate_series(GREATEST(l.from_date, $2::date), LEAST(l.to_date, $3::date), interval '1 day') g(d)
          WHERE l.user_id = $1 AND l.to_date >= $2::date AND l.from_date <= $3::date`, [emp.user_id, from, to]);
      const wd = new Set(await workDays(emp, from, to));
      for (const r of rows) if (wd.has(r.day) && leave[r.kind]) leave[r.kind].push(r.day);
    }

    if (emp.pay_type === 'salary') {
      const per = r2(n(emp.salary_annual) / P), daily = n(emp.salary_annual) / 260;
      if (from <= to) {
        if (from !== start || to !== end) {
          const all = (await workDays(emp, start, end)).length, worked = (await workDays(emp, from, to)).length;
          const amt = all ? r2(per * worked / all) : 0;
          lines.push({ code: 'basic', label: 'Basic pay (' + worked + ' of ' + all + ' working days)', kind: 'earning', qty: worked, rate: all ? r2(per / all) : 0, amount: amt, source: 'auto' });
        } else lines.push({ code: 'basic', label: 'Basic pay', kind: 'earning', qty: 1, rate: per, amount: per, source: 'auto' });
        if (leave.unpaid.length) lines.push({ code: 'unpaid_leave', label: 'Unpaid leave (' + leave.unpaid.length + ' day' + (leave.unpaid.length > 1 ? 's' : '') + ')', kind: 'earning', qty: leave.unpaid.length, rate: -r2(daily), amount: -r2(daily * leave.unpaid.length), source: 'auto' });
      }
    } else if (emp.pay_type === 'hourly') {
      let reg = 0, ot = 0, fromClock = false;
      const workedOn = {};
      if (on(s, 'payroll_use_timeclock') && emp.use_timeclock && emp.user_id && weekFor) {
        fromClock = true;
        // A week is paid in the period its Sunday falls in.
        let monday = addDays(from, -((weekday(from) + 6) % 7));
        for (; monday <= to; monday = addDays(monday, 7)) {
          const sunday = addDays(monday, 6);
          if (sunday < from || sunday > to) continue;
          const { rows: ap } = await query(`SELECT totals FROM timesheet_weeks WHERE user_id = $1 AND week_start = $2`, [emp.user_id, monday]);
          const live = await weekFor(emp.user_id, monday);
          const t = ap.length ? ap[0].totals : live.totals;
          if (!ap.length && (n(t.regular_h) + n(t.overtime_h)) > 0) warnings.push('Week of ' + monday + ' is not approved on the time clock: paid on the hours as they stand');
          if (n(t.ot_pending_h)) warnings.push('Week of ' + monday + ': ' + t.ot_pending_h + ' h of overtime still waiting for approval (not paid)');
          reg += n(t.regular_h); ot += n(t.overtime_h);
          for (const d of live.days) if (n(d.hours)) workedOn[d.day] = n(d.hours);
        }
        if (!reg && !ot) warnings.push('No hours on the time clock for this period');
      } else {
        reg = from <= to ? n(emp.hours_per_period) : 0;
        if (!reg) warnings.push('No hours: enter the hours on this payslip, or set the usual hours per period');
      }
      lines.push({ code: 'basic', label: 'Basic pay (' + r2(reg) + ' h' + (fromClock ? ', time clock' : '') + ')', kind: 'earning', qty: r2(reg), rate, amount: r2(reg * rate), source: 'auto' });
      if (ot) lines.push({ code: 'overtime', label: 'Overtime (' + r2(ot) + ' h at ' + n(emp.ot_rate) + 'x)', kind: 'earning', qty: r2(ot), rate: r2(rate * n(emp.ot_rate)), amount: r2(ot * rate * n(emp.ot_rate)), source: 'auto' });
      // Public holidays: worked ones earn an extra single time (double in all); a
      // scheduled day off for the holiday is paid at the usual daily hours.
      const wd = new Set(contractor ? [] : await workDays(emp, from, to));
      if (contractor) { leave.vacation = []; leave.sick = []; }
      for (const h of contractor ? [] : hol) {
        if (workedOn[h.day]) lines.push({ code: 'holiday_work', label: h.name + ' worked (' + workedOn[h.day] + ' h, extra 1x)', kind: 'earning', qty: workedOn[h.day], rate, amount: r2(workedOn[h.day] * rate), source: 'auto' });
        else if (wd.has(h.day)) lines.push({ code: 'holiday_pay', label: h.name + ' (' + hpd + ' h)', kind: 'earning', qty: hpd, rate, amount: r2(hpd * rate), source: 'auto' });
      }
      if (leave.vacation.length) lines.push({ code: 'vacation_pay', label: 'Vacation pay (' + leave.vacation.length + ' d x ' + hpd + ' h)', kind: 'earning', qty: leave.vacation.length * hpd, rate, amount: r2(leave.vacation.length * hpd * rate), source: 'auto' });
      if (leave.sick.length) lines.push({ code: 'sick_pay', label: 'Sick pay (' + leave.sick.length + ' d x ' + hpd + ' h)', kind: 'earning', qty: leave.sick.length * hpd, rate, amount: r2(leave.sick.length * hpd * rate), source: 'auto' });
    } else if (emp.pay_type === 'daily' && on(s, 'payroll_use_timeclock') && emp.use_timeclock && emp.user_id && weekFor && from <= to) {
      // Day workers on the time clock: every day with time on it is a day's pay.
      const days = [];
      for (let monday = addDays(from, -((weekday(from) + 6) % 7)); monday <= to; monday = addDays(monday, 7)) {
        const live = await weekFor(emp.user_id, monday);
        for (const d of live.days) if (n(d.hours) > 0 && d.day >= from && d.day <= to) days.push(d.day);
      }
      if (days.length) lines.push({ code: 'day_work', label: 'Days worked (' + days.length + ', time clock)', kind: 'earning', qty: days.length, rate: n(emp.day_rate), amount: r2(days.length * n(emp.day_rate)), source: 'auto' });
      else warnings.push('No days on the time clock for this period');
    }
    // A contractor's fixed fee each pay (a retainer); jobs and invoices come in as work below.
    if (n(emp.fee_per_period) > 0 && from <= to) lines.push({ code: 'contract_work', label: 'Contract fee', kind: 'earning', qty: 1, rate: r2(emp.fee_per_period), amount: r2(emp.fee_per_period), source: 'auto' });

    // Work entered for this person and not yet paid: days, piece work, hours, invoices.
    const { rows: work } = await query(
      `SELECT w.*, to_char(w.work_date, 'YYYY-MM-DD') AS day, c.title AS contract FROM payroll_work w LEFT JOIN payroll_contracts c ON c.id = w.contract_id
        WHERE w.employee_id = $1 AND w.work_date <= $2 AND ${OPEN_WORK('w', '$3')} ORDER BY w.work_date, w.id`, [emp.id, end, slipId || 0]);
    for (const w of work) {
      lines.push({ code: WORK_CODE[w.kind], label: w.description + (w.invoice_no ? ' · inv ' + w.invoice_no : '') + (w.contract ? ' · ' + w.contract : '') + ' (' + w.day + ')', kind: 'earning',
        qty: n(w.qty), rate: n(w.rate), amount: r2(w.amount), source: 'auto', work_id: w.id });
    }
    if (!contractor && emp.pay_type === 'daily' && !lines.some((l) => l.code === 'day_work')) warnings.push('No days worked entered for this period');
    if ((emp.pay_type === 'piece' || emp.pay_type === 'contract') && !lines.length) warnings.push('No work or invoices entered for this period');

    // Withholding tax (contractors on specified services, business a withholding agent):
    // 3% on any invoice of the threshold or more; smaller ones once they add up to the
    // aggregate within 30 days (taking in earlier small ones paid without it).
    if (contractor && emp.wht_applies && on(s, 'payroll_wht_agent')) {
      const pay = lines.filter((l) => l.code === 'contract_work' || l.work_id);
      const small = pay.filter((l) => n(l.amount) < n(rt.wht_threshold));
      for (const l of pay) l.wht = n(l.amount) >= n(rt.wht_threshold) ? r2(n(l.amount) * n(rt.wht_rate)) : 0;
      if (small.length) {
        const { rows: prior } = await query(
          `SELECT w.id, w.amount FROM payroll_work w JOIN payroll_slips ps ON ps.id = w.slip_id JOIN payroll_runs pr ON pr.id = ps.run_id
            WHERE w.employee_id = $1 AND pr.status IN ('approved', 'paid') AND w.wht = 0 AND w.amount < $2 AND w.work_date >= ($3::date - 30) AND w.voided_at IS NULL`, [emp.id, n(rt.wht_threshold), run.pay_date]);
        const priorSum = prior.reduce((t, p) => t + n(p.amount), 0), smallSum = small.reduce((t, l) => t + n(l.amount), 0);
        if (smallSum + priorSum >= n(rt.wht_aggregate)) {
          for (const l of small) l.wht = r2(n(l.amount) * n(rt.wht_rate));
          if (prior.length) { small[0].wht = r2(small[0].wht + priorSum * n(rt.wht_rate)); small[0].wht_prior = prior.map((p) => p.id); small[0].label += ' (+ WHT on earlier invoices ' + r2(priorSum).toFixed(2) + ')'; }
        }
      }
    }

    // Loans / advances handed out on the payslip (not pay: no tax, repaid later).
    const { rows: adv } = await query(
      `SELECT l.* FROM payroll_loans l WHERE l.employee_id = $1 AND l.method = 'payslip' AND l.voided_at IS NULL AND l.issue_date <= $2
          AND (l.slip_id IS NULL OR l.slip_id = $3 OR EXISTS (SELECT 1 FROM payroll_slips s JOIN payroll_runs r ON r.id = s.run_id WHERE s.id = l.slip_id AND r.status = 'void'))`, [emp.id, end, slipId || 0]);
    for (const l of adv) lines.push({ code: 'advance_paid', label: (l.kind === 'loan' ? 'Loan' : 'Salary advance') + ' paid out' + (l.reference ? ' · ' + l.reference : ''), kind: 'earning', qty: 1, rate: r2(l.amount), amount: r2(l.amount), source: 'auto', loan_id: l.id });

    // Approved commission statements for this person, not yet paid.
    if (on(s, 'payroll_include_commission') && emp.user_id) {
      const { rows } = await query(
        `SELECT cs.id, cs.number, cs.total FROM commission_statements cs JOIN mechanics m ON m.id = cs.rep_id
          WHERE m.user_id = $1 AND cs.status = 'approved' AND cs.payroll_run_id IS NULL AND cs.period_to <= $2 AND cs.total <> 0
            AND NOT EXISTS (SELECT 1 FROM payroll_slips ps JOIN payroll_runs pr ON pr.id = ps.run_id WHERE pr.status <> 'void' AND pr.id <> $3 AND cs.id = ANY(ps.commission_ids))
          ORDER BY cs.id`, [emp.user_id, end, run.id || 0]);
      for (const c of rows) { lines.push({ code: 'commission', label: 'Commission ' + c.number, kind: 'earning', qty: 1, rate: n(c.total), amount: r2(c.total), source: 'auto', ref: c.id }); commissionIds.push(c.id); }
    }

    // Savings the person asked to take out (their own money back: not pay, not taxed).
    const { rows: pay } = await query(`SELECT x.id, x.payout_pending, x.saved, i.label FROM payroll_employee_items x JOIN payroll_items i ON i.code = x.code
                                        WHERE x.employee_id = $1 AND x.payout_pending > 0 AND i.is_savings ORDER BY x.id`, [emp.id]);
    for (const x of pay) {
      const amt = r2(Math.min(n(x.payout_pending), n(x.saved)));
      if (amt > 0) lines.push({ code: 'savings_payout', label: 'Savings paid out · ' + x.label, kind: 'earning', qty: 1, rate: amt, amount: amt, source: 'auto', savings_id: x.id });
    }

    // Recurring items. A loan never takes more than is still owed.
    const { rows: rec } = await query(`SELECT x.*, i.label, i.kind, i.is_savings FROM payroll_employee_items x JOIN payroll_items i ON i.code = x.code WHERE x.employee_id = $1 AND x.is_active ORDER BY i.sort, x.id`, [emp.id]);
    // A percentage item is worked on the person's pensionable / taxable cash pay.
    const { rows: flagsRows } = await query(`SELECT code FROM payroll_items WHERE paye`);
    const taxableCodes = new Set(flagsRows.map((f) => f.code));
    const payBase = lines.filter((l) => l.kind === 'earning' && taxableCodes.has(l.code)).reduce((t, l) => t + n(l.amount), 0);
    for (const x of rec) {
      if (x.end_date && String(x.end_date instanceof Date ? x.end_date.toISOString() : x.end_date).slice(0, 10) < from) continue;
      let amt = x.pct != null && n(x.pct) > 0 ? r2(Math.max(0, payBase) * n(x.pct) / 100) : n(x.amount);
      if (!(amt > 0)) continue;
      if (x.balance != null) { amt = Math.min(amt, n(x.balance)); if (!(amt > 0)) continue; }
      const line = { code: x.code, label: x.label + (x.pct != null && n(x.pct) > 0 ? ' (' + n(x.pct) + '% of pay)' : '') + (x.note ? ' · ' + x.note : '') + (x.balance != null ? ' (owed ' + r2(x.balance).toFixed(2) + ')' : '') +
        (x.is_savings && n(x.saved) > 0 ? ' (saved so far ' + r2(x.saved).toFixed(2) + ')' : ''), kind: x.kind, qty: 1, rate: r2(amt), amount: r2(amt), source: 'auto', item_id: x.id };
      if (x.payee) line.payee = x.payee;
      if (x.reference) line.reference = x.reference;
      lines.push(line);
    }

    // Starting and leaving in this period.
    if (!contractor && emp.hire_date && emp.hire_date >= start && emp.hire_date <= end) {
      const first = emp.hire_date.slice(5) > '01-31' && emp.paye_method !== 'cumulative' && !priorFor(emp, emp.hire_date.slice(0, 4));
      warnings.push('Started ' + emp.hire_date + ': first pay' + (first ? '. If they have a P45, or earned nothing earlier this year, enter that on their page and choose year-to-date income tax so the tax-free pay not used earlier in the year is given' : ''));
    }
    if (emp.termination_date && emp.termination_date >= start && emp.termination_date <= end) {
      const bits = [];
      const owed = rec.filter((x) => x.balance != null && n(x.balance) > 0.004).reduce((t, x) => t + n(x.balance), 0);
      if (owed > 0.004) bits.push('loans / advances still owed ' + r2(owed).toFixed(2));
      const { rows: sv } = await query(`SELECT COALESCE(SUM(x.saved - x.payout_pending), 0)::float AS v FROM payroll_employee_items x WHERE x.employee_id = $1 AND x.code = 'staff_savings'`, [emp.id]);
      if (sv[0].v > 0.004) bits.push('staff savings to pay out ' + r2(sv[0].v).toFixed(2));
      if (!contractor && emp.user_id) {
        const lb = await leaveBalance(emp, end.slice(0, 4));
        if (lb.vacation_left > 0) bits.push(lb.vacation_left + ' vacation day(s) not taken to pay in lieu');
      }
      warnings.push('Final pay (leaving ' + emp.termination_date + ')' + (bits.length ? ': ' + bits.join('; ') : '') + '. Add notice pay or redundancy if due, and print the P45');
    }

    // Checks.
    const gross = lines.filter((l) => l.kind === 'earning' && !NOT_PAY.includes(l.code)).reduce((t, l) => t + n(l.amount), 0);
    const own = lines.filter((l) => l.kind === 'deduction' && l.code !== 'child_maint' && l.code !== 'court_order').reduce((t, l) => t + n(l.amount), 0);
    if (gross > 0 && own > gross / 2) warnings.push('Deductions other than statutory and court orders are more than half the pay: make sure each is agreed in writing');
    if (lines.some((l) => ['salary_deduction', 'cash_shortage'].includes(l.code))) warnings.push('A salary deduction or cash shortage is on this payslip: keep the signed agreement on file');
    if (contractor) {
      if (!emp.trn) warnings.push('No TRN: needed for the contractor levy / withholding tax returns');
      if (emp.tcc_expiry && emp.tcc_expiry < run.pay_date) warnings.push('Tax compliance certificate expired ' + emp.tcc_expiry);
      if (emp.pay_method === 'bank' && !emp.bank_account) warnings.push('Paid by bank but no account number');
    } else {
    const dayRate = emp.pay_type === 'daily' ? n(emp.day_rate) / (n(emp.hours_per_day) || 8) : 0;
    const hourly = emp.pay_type === 'hourly' ? rate : emp.pay_type === 'daily' ? dayRate : emp.pay_type === 'salary' ? n(emp.salary_annual) / 52 / 40 : 0;
    if (n(rt.min_wage_week) && hourly > 0 && hourly < n(rt.min_wage_week) / n(rt.min_wage_hours || 40) - 0.005)
      warnings.push('Pay rate J$' + hourly.toFixed(2) + '/h is below the national minimum wage (J$' + (n(rt.min_wage_week) / n(rt.min_wage_hours || 40)).toFixed(2) + '/h)');
    if (!emp.trn) warnings.push('No TRN: needed for the S01 / S02 returns');
    if (!emp.nis_no) warnings.push('No NIS number');
    if (emp.pay_method === 'bank' && !emp.bank_account) warnings.push('Paid by bank but no account number');
    }
    if (!contractor && emp.date_of_birth) {
      const age = Math.floor((new Date(end) - new Date(emp.date_of_birth)) / (365.25 * 86400000));
      if (age >= 65 && !(emp.nht_exempt && emp.ed_exempt)) warnings.push('Aged ' + age + ': check the NHT / Education Tax exemption for people over pensionable age');
      if (age >= 70 && !emp.nis_exempt) warnings.push('Aged ' + age + ': check whether NIS is still payable');
    }
    if (n(emp.pension_ee_pct) / 100 > n(rt.pension_cap)) warnings.push('Pension over ' + (n(rt.pension_cap) * 100) + '% of pay: only that much reduces income tax');
    const snapshot = { name: emp.name, employee_no: emp.employee_no, trn: emp.trn, nis_no: emp.nis_no, job_title: emp.job_title, department: emp.department, pay_type: emp.pay_type,
      worker_type: emp.worker_type, business_name: emp.business_name, tcc_no: emp.tcc_no, day_rate: emp.day_rate, address: emp.address,
      frequency: emp.frequency, salary_annual: emp.salary_annual, hourly_rate: emp.hourly_rate, pay_method: emp.pay_method, bank_name: emp.bank_name, bank_masked: mask(emp.bank_account),
      email: emp.email || emp.user_email || null, pension_ee_pct: emp.pension_ee_pct, pension_er_pct: emp.pension_er_pct,
      paye_method: emp.paye_method, hire_date: emp.hire_date, termination_date: emp.termination_date };
    return { lines, warnings, commissionIds, snapshot };
  }

  async function loadEmp(id, q = query) {
    const { rows } = await q(`SELECT ${EMP_SELECT} FROM payroll_employees e LEFT JOIN users u ON u.id = e.user_id WHERE e.id = $1`, [id]);
    return rows[0];
  }
  async function loadRun(id, q = query) {
    const { rows } = await q(`SELECT r.*, to_char(r.period_start, 'YYYY-MM-DD') AS period_start, to_char(r.period_end, 'YYYY-MM-DD') AS period_end, to_char(r.pay_date, 'YYYY-MM-DD') AS pay_date FROM payroll_runs r WHERE r.id = $1`, [parseInt(id, 10) || 0]);
    if (!rows.length) throw httpError(404, 'Pay run not found');
    return rows[0];
  }
  // Work a payslip out again. Edited slips keep their lines; only the statutory maths is redone.
  async function refreshSlip(run, slipRow, s, rt, items, rebuild) {
    const emp = await loadEmp(slipRow.employee_id);
    let lines = slipRow.lines, warnings = slipRow.warnings, cids = slipRow.commission_ids || [], snapshot = slipRow.snapshot;
    if (rebuild || !slipRow.edited) {
      const b = await build(emp, run, s, rt, slipRow.id);
      lines = b.lines; warnings = b.warnings; cids = b.commissionIds; snapshot = b.snapshot;
    }
    const v = compute(lines, emp, rt, PERIODS[run.frequency], s, items, { date: run.pay_date, cum: await cumFor(emp, run) });
    // The payslip and the ledger read this from the line, so a later change to the item leaves this slip as worked out.
    for (const l of lines) {
      if (l.kind === 'earning' && items[l.code] && items[l.code].paid_outside) l.received = true; else delete l.received;
      if (l.kind === 'employer' && items[l.code] && items[l.code].notional) l.notional = true; else delete l.notional;
    }
    warnings = warnings.filter((w) => !/^Net pay is below/.test(w));
    if (v.net < 0) warnings.push('Net pay is below zero: reduce the deductions');
    await query(`UPDATE payroll_slips SET lines = $2, warnings = $3, commission_ids = $4, snapshot = $5, edited = $6, ${STAT.map((k, i) => k + ' = $' + (i + 7)).join(', ')}, tax = $${STAT.length + 7} WHERE id = $1`,
      [slipRow.id, JSON.stringify(lines), JSON.stringify(warnings), cids, JSON.stringify(snapshot), rebuild ? false : slipRow.edited, ...STAT.map((k) => v[k]), v.tax ? JSON.stringify(v.tax) : null]);
    await linkSlip(slipRow.id, emp.id, lines);
  }
  // The work and payslip loans a payslip pays: claimed by it, so no other run pays them.
  async function linkSlip(slipId, empId, lines) {
    const wids = lines.filter((l) => l.work_id).map((l) => l.work_id), lids = lines.filter((l) => l.loan_id).map((l) => l.loan_id);
    await query(`UPDATE payroll_work SET slip_id = NULL WHERE slip_id = $1 AND NOT (id = ANY($2::int[]))`, [slipId, wids]);
    if (wids.length) await query(`UPDATE payroll_work SET slip_id = $1 WHERE id = ANY($2::int[]) AND employee_id = $3`, [slipId, wids, empId]);
    await query(`UPDATE payroll_loans SET slip_id = NULL WHERE slip_id = $1 AND NOT (id = ANY($2::int[]))`, [slipId, lids]);
    if (lids.length) await query(`UPDATE payroll_loans SET slip_id = $1 WHERE id = ANY($2::int[]) AND employee_id = $3`, [slipId, lids, empId]);
  }
  async function totals(runId) {
    const { rows } = await query(`SELECT ${STAT.map((k) => `COALESCE(SUM(${k}), 0)::float AS ${k}`).join(', ')}, COUNT(*)::int AS people FROM payroll_slips WHERE run_id = $1`, [runId]);
    const t = rows[0];
    t.employer_cost = r2(t.gross + t.nis_er + t.nht_er + t.ed_er + t.heart_er + t.pension_er + t.er_benefits);
    t.to_taj = r2(t.paye + t.nis_ee + t.nis_er + t.nht_ee + t.nht_er + t.ed_ee + t.ed_er + t.heart_er + t.levy + t.wht);
    await query(`UPDATE payroll_runs SET totals = $2 WHERE id = $1`, [runId, JSON.stringify(t)]);
    return t;
  }
  async function recalcRun(run, rebuild) {
    const s = await settings(), rt = await ratesFor(query, run.pay_date), items = await itemMap();
    await query(`UPDATE payroll_runs SET rates = $2 WHERE id = $1`, [run.id, JSON.stringify(rt)]);
    const { rows } = await query(`SELECT * FROM payroll_slips WHERE run_id = $1`, [run.id]);
    for (const sl of rows) await refreshSlip(run, sl, s, rt, items, rebuild);
    return totals(run.id);
  }
  // A live run that already pays this person for any of these dates.
  async function overlapping(empId, run) {
    const { rows } = await query(
      `SELECT r.number FROM payroll_slips s JOIN payroll_runs r ON r.id = s.run_id
        WHERE s.employee_id = $1 AND r.status <> 'void' AND r.id <> $2 AND r.period_start <= $4 AND r.period_end >= $3 LIMIT 1`, [empId, run.id || 0, run.period_start, run.period_end]);
    return rows.length ? rows[0].number : null;
  }

  // A closed payroll year takes no new, approved or voided pay runs.
  async function yearOpen(date) {
    const y = Number(String(date).slice(0, 4));
    const { rows } = await query(`SELECT 1 FROM payroll_years WHERE year = $1 AND closed`, [y]);
    if (rows.length) throw httpError(409, 'The payroll year ' + y + ' is closed. Someone who may approve pay runs can reopen it under Year end.');
  }

  // --------------------------------------------------------------- pay runs --
  // The usual period for a frequency: the last full month, or the weeks ending last Sunday.
  function suggestPeriod(freq, ref) {
    const d = ref || today();
    if (freq === 'monthly') {
      const firstThis = d.slice(0, 8) + '01', end = addDays(firstThis, -1);
      return { start: end.slice(0, 8) + '01', end, pay: end };
    }
    const lastSunday = addDays(d, -weekday(d));
    const days = freq === 'weekly' ? 7 : 14;
    return { start: addDays(lastSunday, -(days - 1)), end: lastSunday, pay: addDays(lastSunday, 5) };
  }
  app.get('/api/payroll/runs', ...PV, async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT r.id, r.number, r.frequency, r.status, r.totals, to_char(r.period_start, 'YYYY-MM-DD') AS period_start, to_char(r.period_end, 'YYYY-MM-DD') AS period_end,
                to_char(r.pay_date, 'YYYY-MM-DD') AS pay_date, r.created_at, r.approved_at, u.name AS created_by, a.name AS approved_by,
                (SELECT COUNT(*)::int FROM payroll_slips s WHERE s.run_id = r.id AND jsonb_array_length(s.warnings) > 0) AS with_warnings,
                (SELECT p.id FROM payroll_payments p WHERE p.run_id = r.id AND p.voided_at IS NULL) AS payment_id
           FROM payroll_runs r LEFT JOIN users u ON u.id = r.created_by LEFT JOIN users a ON a.id = r.approved_by
          ORDER BY r.pay_date DESC, r.id DESC LIMIT 200`);
      const sug = {}; for (const f of Object.keys(PERIODS)) sug[f] = suggestPeriod(f);
      res.json({ runs: rows, suggest: sug });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/payroll/runs', ...PR, async (req, res) => {
    try {
      const b = req.body || {};
      const freq = PERIODS[b.frequency] ? b.frequency : null;
      if (!freq) throw httpError(400, 'Choose weekly, fortnightly or monthly');
      if (!isDate(b.period_start) || !isDate(b.period_end) || b.period_start > b.period_end) throw httpError(400, 'Choose the pay period');
      if (!isDate(b.pay_date)) throw httpError(400, 'Choose the pay date');
      const days = (new Date(b.period_end) - new Date(b.period_start)) / 86400000 + 1;
      if (days > 31) throw httpError(400, 'A pay period is at most a month');
      await yearOpen(b.pay_date);
      const ids = Array.isArray(b.employee_ids) && b.employee_ids.length ? b.employee_ids.map((x) => parseInt(x, 10)).filter(Boolean) : null;
      const { rows: emps } = await query(
        `SELECT id FROM payroll_employees WHERE is_active AND frequency = $1 AND ($2::int[] IS NULL OR id = ANY($2))
            AND (hire_date IS NULL OR hire_date <= $4) AND (termination_date IS NULL OR termination_date >= $3) ORDER BY name`, [freq, ids, b.period_start, b.period_end]);
      if (!emps.length) throw httpError(400, 'Nobody on ' + freq + ' pay is active in this period');
      const keep = [], skipped = [];
      for (const e of emps) {
        const dup = await overlapping(e.id, { id: 0, period_start: b.period_start, period_end: b.period_end });
        if (dup) { const em = await loadEmp(e.id); skipped.push(em.name + ' (already on ' + dup + ')'); } else keep.push(e.id);
      }
      if (!keep.length) throw httpError(409, 'Everyone is already paid for these dates: ' + skipped.join(', '));
      const { rows: r } = await query(`INSERT INTO payroll_runs (frequency, period_start, period_end, pay_date, note, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [freq, b.period_start, b.period_end, b.pay_date, String(b.note || '').slice(0, 200) || null, req.session.userId]);
      const id = r[0].id;
      await query(`UPDATE payroll_runs SET number = 'PR-' || lpad(id::text, 6, '0') WHERE id = $1`, [id]);
      const run = await loadRun(id);
      for (const eid of keep) await query(`INSERT INTO payroll_slips (run_id, employee_id, snapshot) VALUES ($1, $2, '{}')`, [id, eid]);
      const t = await recalcRun(run, true);
      res.json({ ok: true, id, totals: t, skipped });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/payroll/runs/:id', ...PV, async (req, res) => {
    try {
      const run = await loadRun(req.params.id);
      const { rows: slips } = await query(`SELECT s.*, e.name, e.pay_method FROM payroll_slips s JOIN payroll_employees e ON e.id = s.employee_id WHERE s.run_id = $1 ORDER BY e.name`, [run.id]);
      const { rows: pay } = await query(`SELECT p.*, to_char(p.pay_date, 'YYYY-MM-DD') AS pay_date, a.code || ' ' || a.name AS account FROM payroll_payments p JOIN gl_accounts a ON a.id = p.account_id WHERE p.run_id = $1 ORDER BY p.id`, [run.id]);
      const { rows: who } = await query(`SELECT (SELECT name FROM users WHERE id = $1) AS created_by_name, (SELECT name FROM users WHERE id = $2) AS approved_by_name`, [run.created_by, run.approved_by]);
      const { rows: notIn } = await query(
        `SELECT id, name FROM payroll_employees e WHERE is_active AND frequency = $1 AND NOT EXISTS (SELECT 1 FROM payroll_slips s WHERE s.run_id = $2 AND s.employee_id = e.id) ORDER BY name`, [run.frequency, run.id]);
      const { rows: je } = await query(`SELECT number, source_kind FROM gl_entries WHERE (source_kind IN ('payroll_run', 'payroll_run_void') AND source_id = $1) OR (source_kind IN ('payroll_payment', 'payroll_payment_void') AND source_id = ANY($2::bigint[])) ORDER BY id`, [run.id, pay.map((p) => p.id)]);
      res.json({ run: Object.assign(run, who[0]), slips, payments: pay, not_in_run: notIn, journal: je });
    } catch (e) { fail(res, e); }
  });
  const draft = async (id) => { const run = await loadRun(id); if (run.status !== 'draft') throw httpError(409, 'This run is ' + run.status + ': only a draft can be changed'); return run; };
  app.post('/api/payroll/runs/:id/recalculate', ...PR, async (req, res) => {
    try { const run = await draft(req.params.id); res.json({ ok: true, totals: await recalcRun(run, !!(req.body && req.body.reset)) }); } catch (e) { fail(res, e); }
  });
  app.post('/api/payroll/runs/:id/add', ...PR, async (req, res) => {
    try {
      const run = await draft(req.params.id), eid = parseInt(req.body && req.body.employee_id, 10) || 0;
      const emp = await loadEmp(eid);
      if (!emp) throw httpError(404, 'Employee not found');
      const dup = await overlapping(eid, run);
      if (dup) throw httpError(409, emp.name + ' is already paid for these dates on ' + dup);
      const { rows } = await query(`INSERT INTO payroll_slips (run_id, employee_id, snapshot) VALUES ($1, $2, '{}') ON CONFLICT DO NOTHING RETURNING *`, [run.id, eid]);
      if (rows.length) await refreshSlip(run, rows[0], await settings(), await ratesFor(query, run.pay_date), await itemMap(), true);
      res.json({ ok: true, totals: await totals(run.id) });
    } catch (e) { fail(res, e); }
  });
  app.delete('/api/payroll/runs/:id/slips/:slip', ...PR, async (req, res) => {
    try {
      const run = await draft(req.params.id);
      await query(`DELETE FROM payroll_slips WHERE id = $1 AND run_id = $2`, [parseInt(req.params.slip, 10) || 0, run.id]);
      res.json({ ok: true, totals: await totals(run.id) });
    } catch (e) { fail(res, e); }
  });
  // Change a payslip's lines by hand (hours, a bonus, a one-off deduction).
  app.put('/api/payroll/runs/:id/slips/:slip', ...PR, async (req, res) => {
    try {
      const run = await draft(req.params.id);
      const { rows } = await query(`SELECT * FROM payroll_slips WHERE id = $1 AND run_id = $2`, [parseInt(req.params.slip, 10) || 0, run.id]);
      if (!rows.length) throw httpError(404, 'Payslip not found');
      const items = await itemMap();
      const lines = (Array.isArray(req.body && req.body.lines) ? req.body.lines : []).slice(0, 60).map((l) => {
        const it = items[l.code];
        if (!it) throw httpError(400, 'Unknown earning or deduction: ' + l.code);
        const noQty = l.qty === '' || l.qty == null;
        const qty = noQty ? 1 : n(l.qty), rate = n(l.rate);
        const amount = noQty && l.amount != null && l.amount !== '' ? r2(l.amount) : r2(qty * rate);
        const out = { code: it.code, label: String(l.label || it.label).slice(0, 80), kind: it.kind, qty, rate: noQty ? amount : rate, amount, source: l.source === 'auto' ? 'auto' : 'manual' };
        if (l.ref) out.ref = parseInt(l.ref, 10) || undefined;
        if (l.item_id) out.item_id = parseInt(l.item_id, 10) || undefined;
        if (l.work_id) out.work_id = parseInt(l.work_id, 10) || undefined;
        if (l.loan_id) out.loan_id = parseInt(l.loan_id, 10) || undefined;
        if (l.savings_id && it.code === 'savings_payout') out.savings_id = parseInt(l.savings_id, 10) || undefined;
        if (l.payee) out.payee = String(l.payee).slice(0, 80);
        if (l.reference) out.reference = String(l.reference).slice(0, 60);
        if (it.kind !== 'earning' && amount < 0) throw httpError(400, 'A deduction or contribution is a positive amount');
        return out;
      });
      // Work and payslip loans are linked records: they can be dropped, not invented; WHT on
      // them stays as worked out (scaled if the amount was changed).
      const prev = rows[0].lines || [];
      for (const l of lines) {
        const was = prev.find((p) => (l.work_id && p.work_id === l.work_id) || (l.loan_id && p.loan_id === l.loan_id) || (l.savings_id && p.code === 'savings_payout' && p.savings_id === l.savings_id));
        if ((l.work_id || l.loan_id || l.code === 'savings_payout') && !was) throw httpError(400, 'Work, invoices, loans and savings payouts are added from the employee\'s page, not typed on a payslip');
        if (l.code === 'savings_payout' && r2(l.amount) !== r2(was.amount)) throw httpError(400, 'Change a savings payout on the employee\'s page, then recalculate the run');
        if (was && was.wht != null) { l.wht = n(was.amount) ? r2(n(was.wht) * n(l.amount) / n(was.amount)) : 0; if (was.wht_prior) l.wht_prior = was.wht_prior; }
        if (l.loan_id && was && r2(l.amount) !== r2(was.amount)) throw httpError(400, 'A loan paid out on the payslip cannot be changed here: cancel it and enter it again');
      }
      // Commission comes from statements: it can be dropped from a slip but not invented.
      const had = rows[0].commission_ids || [];
      for (const l of lines) if (l.code === 'commission' && (!l.ref || !had.includes(l.ref))) throw httpError(400, 'Commission is paid from approved commission statements; add it as a bonus instead');
      const cids = lines.filter((l) => l.code === 'commission').map((l) => l.ref);
      const cheque = req.body && 'cheque_number' in req.body ? (String(req.body.cheque_number || '').slice(0, 30) || null) : rows[0].cheque_number;
      await query(`UPDATE payroll_slips SET lines = $2, edited = true, commission_ids = $3, cheque_number = $4 WHERE id = $1`, [rows[0].id, JSON.stringify(lines), cids, cheque]);
      const { rows: again } = await query(`SELECT * FROM payroll_slips WHERE id = $1`, [rows[0].id]);
      await refreshSlip(run, again[0], await settings(), await ratesFor(query, run.pay_date), items, false);
      res.json({ ok: true, totals: await totals(run.id) });
    } catch (e) { fail(res, e); }
  });
  app.delete('/api/payroll/runs/:id', ...PR, async (req, res) => {
    try { const run = await draft(req.params.id); await query(`DELETE FROM payroll_runs WHERE id = $1`, [run.id]); res.json({ ok: true }); } catch (e) { fail(res, e); }
  });

  // Approve: the run is locked, commission statements and loan balances are
  // settled, and (ledger on) the wages, contributions and net pay post.
  app.post('/api/payroll/runs/:id/approve', ...PA, async (req, res) => {
    try {
      const s = await settings();
      const run = await draft(req.params.id);
      await yearOpen(run.pay_date);
      const uid = req.session.userId;
      const { rows: slips } = await query(`SELECT s.*, e.user_id FROM payroll_slips s JOIN payroll_employees e ON e.id = s.employee_id WHERE s.run_id = $1`, [run.id]);
      if (!slips.length) throw httpError(409, 'There is nobody on this run');
      const neg = slips.filter((x) => n(x.net) < 0);
      if (neg.length) throw httpError(409, neg.length + ' payslip(s) have net pay below zero');
      if (on(s, 'payroll_two_person')) {
        if (run.created_by === uid) throw httpError(403, 'Someone other than the person who prepared this run must approve it');
        if (slips.some((x) => x.user_id === uid)) throw httpError(403, 'Your own pay is on this run: someone else must approve it');
      }
      // Year-to-date income tax depends on the runs approved before this one: it must be current.
      for (const sl of slips.filter((x) => x.tax && x.tax.method === 'cumulative')) {
        const c = await cumFor(await loadEmp(sl.employee_id), run);
        if (!c || Math.abs(c.paye - n(sl.tax.paid_before)) > 0.011 || Math.abs(r2(c.statutory + n(sl.statutory)) - n(sl.tax.statutory_to_date)) > 0.011)
          throw httpError(409, sl.snapshot.name + '\'s year-to-date income tax has changed since this run was worked out (another run was approved or voided, or their earlier pay was changed): recalculate the run');
      }
      await tx(async (c) => {
        const { rows: lock } = await c.query(`SELECT status FROM payroll_runs WHERE id = $1 FOR UPDATE`, [run.id]);
        if (lock[0].status !== 'draft') throw httpError(409, 'This run was changed by someone else: reload');
        for (const sl of slips) {
          const ids = sl.commission_ids || [];
          if (ids.length) {
            const { rowCount } = await c.query(`UPDATE commission_statements SET status = 'paid', paid_at = NOW(), paid_by = $2, payroll_run_id = $3, note = COALESCE(note || ' · ', '') || $4
                                                 WHERE id = ANY($1) AND status = 'approved' AND payroll_run_id IS NULL`, [ids, uid, run.id, 'Paid through payroll ' + run.number]);
            if (rowCount !== ids.length) throw httpError(409, 'A commission statement on ' + sl.snapshot.name + '\'s payslip has changed: recalculate the run');
          }
          for (const l of sl.lines || []) {
            if (l.work_id) await c.query(`UPDATE payroll_work SET wht = $2 WHERE id = $1`, [l.work_id, r2(l.wht || 0)]);
            // Earlier small invoices now taxed on this payslip: mark them so they are not taxed again.
            if (l.wht_prior && l.wht_prior.length) await c.query(`UPDATE payroll_work SET wht = ROUND(amount * $2, 2) WHERE id = ANY($1::int[]) AND wht = 0`, [l.wht_prior, n(run.rates && run.rates.wht_rate)]);
            if (l.code === 'savings_payout' && l.savings_id) {
              const { rowCount } = await c.query(`UPDATE payroll_employee_items SET saved = saved - $2, payout_pending = GREATEST(payout_pending - $2, 0) WHERE id = $1 AND saved >= $2 - 0.004`, [l.savings_id, n(l.amount)]);
              if (!rowCount) throw httpError(409, 'A savings payout on ' + sl.snapshot.name + '\'s payslip is more than is saved: recalculate the run');
              continue;
            }
            if (l.kind !== 'deduction' || !l.item_id) continue;
            await c.query(`UPDATE payroll_employee_items SET balance = GREATEST(balance - $2, 0), is_active = (balance - $2) > 0.004 WHERE id = $1 AND balance IS NOT NULL`, [l.item_id, n(l.amount)]);
            await c.query(`UPDATE payroll_employee_items x SET saved = x.saved + $2 FROM payroll_items i WHERE x.id = $1 AND i.code = x.code AND i.is_savings`, [l.item_id, n(l.amount)]);
          }
        }
        // Loans paid out on these payslips start being repaid from the next pay.
        await c.query(`UPDATE payroll_employee_items SET is_active = true WHERE id IN (SELECT l.item_id FROM payroll_loans l JOIN payroll_slips s ON s.id = l.slip_id WHERE s.run_id = $1 AND l.voided_at IS NULL)`, [run.id]);
        await c.query(`UPDATE payroll_runs SET status = 'approved', approved_by = $2, approved_at = NOW(), post_gl = $3 WHERE id = $1`, [run.id, uid, on(s, 'payroll_post_ledger')]);
      });
      await post();
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  // Void an approved run (its payment must be voided first): commission and loans go back.
  async function voidRun(run, reason, userId) {
    if (run.status === 'paid') throw httpError(409, 'Void the payment first');
    if (run.status !== 'approved') throw httpError(409, 'Only an approved run can be voided (a draft is just deleted)');
    await yearOpen(run.pay_date);
    const { rows: repaid } = await query(`SELECT 1 FROM payroll_loans l JOIN payroll_slips s ON s.id = l.slip_id JOIN payroll_employee_items i ON i.id = l.item_id
                                           WHERE s.run_id = $1 AND l.voided_at IS NULL AND i.balance < l.amount - 0.004 LIMIT 1`, [run.id]);
    if (repaid.length) throw httpError(409, 'A loan paid out on this run has already had repayments taken on a later run: void that run first');
    await tx(async (c) => {
      const { rows: slips } = await c.query(`SELECT * FROM payroll_slips WHERE run_id = $1`, [run.id]);
      await c.query(`UPDATE commission_statements SET status = 'approved', paid_at = NULL, paid_by = NULL, payroll_run_id = NULL WHERE payroll_run_id = $1`, [run.id]);
      // Work and payslip loans on this run are free to be paid again.
      await c.query(`UPDATE payroll_employee_items SET is_active = false WHERE id IN (SELECT l.item_id FROM payroll_loans l JOIN payroll_slips s ON s.id = l.slip_id WHERE s.run_id = $1)`, [run.id]);
      await c.query(`UPDATE payroll_loans SET slip_id = NULL WHERE slip_id IN (SELECT id FROM payroll_slips WHERE run_id = $1)`, [run.id]);
      await c.query(`UPDATE payroll_work SET slip_id = NULL, wht = 0 WHERE slip_id IN (SELECT id FROM payroll_slips WHERE run_id = $1)`, [run.id]);
      for (const sl of slips) for (const l of sl.lines || []) {
        if (l.wht_prior && l.wht_prior.length) await c.query(`UPDATE payroll_work SET wht = 0 WHERE id = ANY($1::int[])`, [l.wht_prior]);
        // A savings payout goes back to being saved, and waits for the next payslip again.
        if (l.code === 'savings_payout' && l.savings_id) { await c.query(`UPDATE payroll_employee_items SET saved = saved + $2, payout_pending = $2 WHERE id = $1`, [l.savings_id, n(l.amount)]); continue; }
        if (l.kind !== 'deduction' || !l.item_id) continue;
        await c.query(`UPDATE payroll_employee_items SET balance = balance + $2, is_active = true WHERE id = $1 AND balance IS NOT NULL`, [l.item_id, n(l.amount)]);
        await c.query(`UPDATE payroll_employee_items x SET saved = GREATEST(x.saved - $2, 0) FROM payroll_items i WHERE x.id = $1 AND i.code = x.code AND i.is_savings`, [l.item_id, n(l.amount)]);
      }
      await c.query(`UPDATE payroll_runs SET status = 'void', voided_at = NOW(), voided_by = $2, void_reason = $3 WHERE id = $1`, [run.id, userId, reason]);
    });
  }
  async function voidPayment(paymentId, reason, userId) {
    const { rows } = await query(`SELECT * FROM payroll_payments WHERE id = $1 AND voided_at IS NULL`, [parseInt(paymentId, 10) || 0]);
    if (!rows.length) throw httpError(404, 'Payment not found or already voided');
    const { rows: rec } = await query(`SELECT 1 FROM bank_cleared bc JOIN gl_lines l ON l.id = bc.gl_line_id JOIN gl_entries e ON e.id = l.entry_id
                                        WHERE e.source_kind = 'payroll_payment' AND e.source_id = $1 LIMIT 1`, [rows[0].id]);
    if (rec.length) throw httpError(409, 'This payment is ticked on a bank reconciliation: undo that first');
    await tx(async (c) => {
      await c.query(`UPDATE payroll_payments SET voided_at = NOW(), voided_by = $2, void_reason = $3 WHERE id = $1`, [rows[0].id, userId, reason]);
      await c.query(`UPDATE payroll_runs SET status = 'approved' WHERE id = $1 AND status = 'paid'`, [rows[0].run_id]);
    });
  }
  app.post('/api/payroll/runs/:id/void', ...PA, async (req, res) => {
    try {
      const reason = String((req.body && req.body.reason) || '').trim().slice(0, 200);
      if (!reason) throw httpError(400, 'Say why the run is voided');
      await voidRun(await loadRun(req.params.id), reason, req.session.userId);
      await post();
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // Reverse and rerun: a run that was approved (or already paid) and turns out
  // wrong is reversed in full -- the wages payment, then the run, each with
  // its own reversing ledger entry -- and a new draft is opened for the same
  // people, period and pay date, worked out again from the records as they
  // are now. Nothing is lost: the reversed run stays on file, marked void.
  app.post('/api/payroll/runs/:id/rerun', ...PA, async (req, res) => {
    try {
      const reason = String((req.body && req.body.reason) || '').trim().slice(0, 180);
      if (!reason) throw httpError(400, 'Say why the run is reversed');
      let run = await loadRun(req.params.id);
      if (!['approved', 'paid'].includes(run.status)) throw httpError(409, run.status === 'draft' ? 'A draft has posted nothing: change it, or use Recalculate' : 'This run is already void');
      await yearOpen(run.pay_date);
      const uid = req.session.userId, why = 'Reversed to rerun: ' + reason;
      if (run.status === 'paid') {
        const { rows: p } = await query(`SELECT id FROM payroll_payments WHERE run_id = $1 AND voided_at IS NULL`, [run.id]);
        for (const x of p) await voidPayment(x.id, why, uid);
        run = await loadRun(run.id);
      }
      const { rows: old } = await query(`SELECT s.employee_id, e.name, e.is_active FROM payroll_slips s JOIN payroll_employees e ON e.id = s.employee_id WHERE s.run_id = $1 ORDER BY e.name`, [run.id]);
      await voidRun(run, why, uid);
      const { rows: r } = await query(`INSERT INTO payroll_runs (frequency, period_start, period_end, pay_date, note, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [run.frequency, run.period_start, run.period_end, run.pay_date, ('Rerun of ' + run.number + ': ' + reason).slice(0, 200), uid]);
      const id = r[0].id;
      await query(`UPDATE payroll_runs SET number = 'PR-' || lpad(id::text, 6, '0') WHERE id = $1`, [id]);
      const fresh = await loadRun(id), left = [];
      for (const e of old) {
        if (!e.is_active || (await overlapping(e.employee_id, fresh))) { left.push(e.name); continue; }
        await query(`INSERT INTO payroll_slips (run_id, employee_id, snapshot) VALUES ($1, $2, '{}')`, [id, e.employee_id]);
      }
      const totals = await recalcRun(fresh, true);
      await post();
      res.json({ ok: true, id, number: fresh.number, reversed: run.number, totals, left_out: left });
    } catch (e) { fail(res, e); }
  });

  // Pay the net wages from a bank / cash account.
  app.post('/api/payroll/runs/:id/pay', ...PR, async (req, res) => {
    try {
      const b = req.body || {};
      const run = await loadRun(req.params.id);
      if (run.status !== 'approved') throw httpError(409, run.status === 'paid' ? 'Already paid' : 'Approve the run first');
      const acct = parseInt(b.account_id, 10) || 0;
      const { rows: a } = await query(`SELECT id FROM gl_accounts WHERE id = $1 AND type = 'asset' AND is_active`, [acct]);
      if (!a.length) throw httpError(400, 'Choose the bank or cash account the wages are paid from');
      const date = isDate(b.pay_date) ? b.pay_date : run.pay_date;
      const cheques = b.cheques && typeof b.cheques === 'object' ? b.cheques : {};
      const id = await tx(async (c) => {
        const { rows: lock } = await c.query(`SELECT status FROM payroll_runs WHERE id = $1 FOR UPDATE`, [run.id]);
        if (lock[0].status !== 'approved') throw httpError(409, 'Already paid');
        for (const [slip, no] of Object.entries(cheques)) if (no) await c.query(`UPDATE payroll_slips SET cheque_number = $3 WHERE id = $1 AND run_id = $2`, [parseInt(slip, 10) || 0, run.id, String(no).slice(0, 30)]);
        const { rows: t } = await c.query(`SELECT COALESCE(SUM(net), 0) AS v FROM payroll_slips WHERE run_id = $1`, [run.id]);
        const { rows } = await c.query(`INSERT INTO payroll_payments (run_id, account_id, pay_date, per_person, reference, amount, post_gl, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [run.id, acct, date, b.per_person !== false, String(b.reference || '').slice(0, 60) || null, t[0].v, run.post_gl, req.session.userId]);
        await c.query(`UPDATE payroll_runs SET status = 'paid' WHERE id = $1`, [run.id]);
        return rows[0].id;
      });
      await post();
      res.json({ ok: true, payment_id: id });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/payroll/payments/:id/void', ...PR, async (req, res) => {
    try {
      const reason = String((req.body && req.body.reason) || '').trim().slice(0, 200);
      if (!reason) throw httpError(400, 'Say why the payment is voided');
      await voidPayment(req.params.id, reason, req.session.userId);
      await post();
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // Bank upload file (name, bank, branch, account, amount).
  app.get('/api/payroll/runs/:id/bank.csv', ...PR, async (req, res) => {
    try {
      const run = await loadRun(req.params.id);
      if (run.status === 'draft' || run.status === 'void') throw httpError(409, 'Approve the run first');
      const { rows } = await query(`SELECT e.name, e.employee_no, e.trn, e.bank_name, e.bank_branch, e.bank_account, e.bank_account_type, s.net FROM payroll_slips s JOIN payroll_employees e ON e.id = s.employee_id
                                     WHERE s.run_id = $1 AND e.pay_method = 'bank' AND s.net > 0 ORDER BY e.name`, [run.id]);
      const q = (v) => { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
      const out = [['name', 'employee_no', 'trn', 'bank', 'branch', 'account', 'account_type', 'amount', 'reference']].concat(rows.map((r) => [r.name, r.employee_no, r.trn, r.bank_name, r.bank_branch, r.bank_account, r.bank_account_type, n(r.net).toFixed(2), run.number]));
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="${run.number}-bank.csv"`);
      res.send(out.map((l) => l.map(q).join(',')).join('\n'));
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------------- payslips --
  async function employer() {
    const s = await settings(); let shop = {};
    try { shop = (getShop && await getShop()) || {}; } catch (_) {}
    return { name: shop.name || shop.shop_name || 'Morty\'s Auto Parts', address: shop.address || '', phone: shop.phone || '', trn: s.payroll_employer_trn, nis: s.payroll_employer_nis };
  }
  async function slipView(id) {
    const { rows } = await query(`SELECT s.*, e.user_id, r.number, r.status, r.frequency, to_char(r.period_start, 'YYYY-MM-DD') AS period_start, to_char(r.period_end, 'YYYY-MM-DD') AS period_end, to_char(r.pay_date, 'YYYY-MM-DD') AS pay_date
                                    FROM payroll_slips s JOIN payroll_runs r ON r.id = s.run_id JOIN payroll_employees e ON e.id = s.employee_id WHERE s.id = $1`, [parseInt(id, 10) || 0]);
    if (!rows.length) throw httpError(404, 'Payslip not found');
    const sl = rows[0];
    const y = await ytd(sl.employee_id, sl.pay_date.slice(0, 4) + '-01-01', sl.pay_date);
    if (sl.status === 'draft') for (const k of STAT) y[k] = r2(n(y[k]) + n(sl[k]));
    const emp = await loadEmp(sl.employee_id), year = sl.pay_date.slice(0, 4), ctr = emp.worker_type === 'contractor';
    return { slip: sl, ytd: y, employer: await employer(), prior: ctr ? null : priorFor(emp, year),
      // As they stand today (not as at the pay date).
      loans: (await loanList(emp.id)).filter((l) => !l.voided_at && n(l.balance) > 0.004).map((l) => ({ kind: l.kind, issue_date: l.issue_date, amount: n(l.amount), per_pay: n(l.per_pay), balance: n(l.balance), repaid: l.repaid })),
      savings: (await savingsList(emp.id)).filter((x) => x.saved > 0.004 || x.is_active),
      leave: !ctr && emp.user_id ? await leaveBalance(emp, year) : null };
  }
  app.get('/api/payroll/slips/:id', requireAdmin, async (req, res) => {
    try {
      const v = await slipView(req.params.id);
      if (!(await userCan(req, 'payroll.view'))) {
        const s = await settings();
        if (!(on(s, 'payroll_self_service') && v.slip.user_id === req.session.userId && ['approved', 'paid'].includes(v.slip.status))) throw httpError(403, 'Not your payslip');
      }
      res.json(v);
    } catch (e) { fail(res, e); }
  });
  app.get('/api/payroll/me', requireAdmin, async (req, res) => {
    try {
      const s = await settings();
      if (!on(s, 'payroll_self_service')) throw httpError(403, 'Payslips are not shown to staff');
      const { rows: e } = await query(`SELECT ${EMP_SELECT} FROM payroll_employees e LEFT JOIN users u ON u.id = e.user_id WHERE e.user_id = $1`, [req.session.userId]);
      if (!e.length) return res.json({ employee: null, slips: [] });
      const { rows } = await query(`SELECT s.id, s.gross, s.net, r.number, to_char(r.pay_date, 'YYYY-MM-DD') AS pay_date, to_char(r.period_start, 'YYYY-MM-DD') AS period_start, to_char(r.period_end, 'YYYY-MM-DD') AS period_end
                                      FROM payroll_slips s JOIN payroll_runs r ON r.id = s.run_id WHERE s.employee_id = $1 AND r.status IN ('approved', 'paid') ORDER BY r.pay_date DESC LIMIT 60`, [e[0].id]);
      const year = today().slice(0, 4);
      const { rows: items } = await query(`SELECT i.label, i.kind, x.amount::float AS amount, x.pct::float AS pct, x.balance::float AS balance, x.payee FROM payroll_employee_items x JOIN payroll_items i ON i.code = x.code
                                             WHERE x.employee_id = $1 AND x.is_active AND x.code NOT IN ('loan', 'advance') ORDER BY i.kind DESC, i.sort`, [e[0].id]);
      res.json({ employee: { id: e[0].id, name: e[0].name, job_title: e[0].job_title, frequency: e[0].frequency, pay_method: e[0].pay_method, bank_masked: mask(e[0].bank_account), paye_method: e[0].paye_method },
        slips: rows, ytd: await ytd(e[0].id, year + '-01-01', year + '-12-31'), leave: await leaveBalance(e[0], year), year, prior: priorFor(e[0], year), items,
        loans: (await loanList(e[0].id)).filter((l) => !l.voided_at).map((l) => ({ kind: l.kind, issue_date: l.issue_date, amount: n(l.amount), per_pay: n(l.per_pay), balance: n(l.balance), repaid: l.repaid, status: l.status })),
        savings: await savingsList(e[0].id) });
    } catch (e) { fail(res, e); }
  });
  // Email payslips (text) to everyone on the run with a real address.
  app.post('/api/payroll/runs/:id/email', ...PR, async (req, res) => {
    try {
      const run = await loadRun(req.params.id);
      if (!['approved', 'paid'].includes(run.status)) throw httpError(409, 'Approve the run first');
      if (!mailer || !mailer.sendEmail) throw httpError(409, 'Email is not set up');
      const { rows } = await query(`SELECT s.id, s.snapshot FROM payroll_slips s WHERE s.run_id = $1`, [run.id]);
      const emp = await employer();
      const J = (x) => 'J$' + n(x).toLocaleString('en-JM', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      let sent = 0, skipped = 0;
      for (const r of rows) {
        const to = r.snapshot && r.snapshot.email;
        if (!to || /\.local$/i.test(to)) { skipped++; continue; }
        const v = await slipView(r.id), sl = v.slip;
        const text = [emp.name + ' - payslip ' + run.number, 'Period ' + sl.period_start + ' to ' + sl.period_end + ', paid ' + sl.pay_date, '',
          ...sl.lines.filter((l) => l.kind !== 'employer').map((l) => (l.kind === 'deduction' ? '  less ' : '  ') + l.label + (NOT_PAY.includes(l.code) ? ' (not pay)' : '') + ': ' + J(l.amount)),
          '', 'Gross pay: ' + J(sl.gross), 'NIS: ' + J(sl.nis_ee), 'NHT: ' + J(sl.nht_ee), 'Education Tax: ' + J(sl.ed_ee), 'Income tax (PAYE): ' + J(sl.paye),
          ...(n(sl.pension_ee) ? ['Pension: ' + J(sl.pension_ee)] : []), ...(n(sl.levy) ? ['Contractor levy: ' + J(sl.levy)] : []), ...(n(sl.wht) ? ['Withholding tax: ' + J(sl.wht)] : []),
          ...((sl.lines || []).some((l) => l.received) ? ['Already received, not paid again (e.g. cash tips): ' + J((sl.lines || []).filter((l) => l.received).reduce((t, l) => t + n(l.amount), 0))] : []), 'NET PAY: ' + J(sl.net), '', 'Year to date: gross ' + J(v.ytd.gross) + ', PAYE ' + J(v.ytd.paye) + ', net ' + J(v.ytd.net)].join('\n');
        try { await mailer.sendEmail({ to, subject: 'Your payslip ' + sl.pay_date, text }); sent++; } catch (_) { skipped++; }
      }
      res.json({ ok: true, sent, skipped });
    } catch (e) { fail(res, e); }
  });

  // ----------------------------------------------------- statutory returns --
  const monthEnd = (m) => addDays((Number(m.slice(5, 7)) === 12 ? (Number(m.slice(0, 4)) + 1) + '-01' : m.slice(0, 5) + String(Number(m.slice(5, 7)) + 1).padStart(2, '0')) + '-01', -1);
  // S01: what was deducted and contributed for pay dated in a month (due the 14th of the next month).
  async function s01(month) {
    const from = month + '-01', to = monthEnd(month);
    const { rows: all } = await query(
      `SELECT e.id, e.name, e.trn, e.nis_no, e.worker_type, e.business_name, to_char(e.date_of_birth, 'YYYY-MM-DD') AS date_of_birth, ${STAT.map((k) => `SUM(s.${k})::float AS ${k}`).join(', ')}
         FROM payroll_slips s JOIN payroll_runs r ON r.id = s.run_id JOIN payroll_employees e ON e.id = s.employee_id
        WHERE r.status IN ('approved', 'paid') AND r.pay_date BETWEEN $1 AND $2 GROUP BY e.id ORDER BY e.name`, [from, to]);
    const rows = all.filter((x) => x.worker_type !== 'contractor'), contractors = all.filter((x) => x.worker_type === 'contractor');
    const t = {}; for (const k of STAT) t[k] = r2(rows.reduce((a, x) => a + n(x[k]), 0));
    const ct = { gross: r2(contractors.reduce((a, x) => a + n(x.gross), 0)), levy: r2(contractors.reduce((a, x) => a + n(x.levy), 0)), wht: r2(contractors.reduce((a, x) => a + n(x.wht), 0)) };
    const due = { paye: t.paye, nis: r2(t.nis_ee + t.nis_er), nht: r2(t.nht_ee + t.nht_er), ed: r2(t.ed_ee + t.ed_er), heart: t.heart_er, levy: ct.levy, wht: ct.wht, pension: r2(t.pension_ee + t.pension_er) };
    const { rows: rem } = await query(`SELECT r.*, to_char(r.pay_date, 'YYYY-MM-DD') AS pay_date, a.code || ' ' || a.name AS account FROM payroll_remittances r JOIN gl_accounts a ON a.id = r.account_id WHERE r.month = $1 ORDER BY r.id`, [from]);
    const paid = { paye: 0, nis: 0, nht: 0, ed: 0, heart: 0, levy: 0, wht: 0, pension: 0 };
    for (const r of rem) if (!r.voided_at) for (const k of Object.keys(paid)) paid[k] = r2(paid[k] + n(r[k]));
    const owing = {}; for (const k of Object.keys(due)) owing[k] = r2(due[k] - paid[k]);
    return { month, from, to, due_date: addDays(to, 14), employees: rows, contractors, contractor_totals: ct, totals: t, due, paid, owing, remittances: rem,
      taj_total: r2(due.paye + due.nis + due.nht + due.ed + due.heart + due.levy + due.wht) };
  }
  app.get('/api/payroll/s01', ...PV, async (req, res) => {
    try { const m = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : today().slice(0, 7); res.json(Object.assign(await s01(m), { employer: await employer() })); } catch (e) { fail(res, e); }
  });
  app.post('/api/payroll/remittances', ...PR, async (req, res) => {
    try {
      const b = req.body || {}, s = await settings();
      if (!/^\d{4}-\d{2}$/.test(b.month || '')) throw httpError(400, 'Choose the month');
      const acct = parseInt(b.account_id, 10) || 0;
      const { rows: a } = await query(`SELECT id FROM gl_accounts WHERE id = $1 AND type = 'asset' AND is_active`, [acct]);
      if (!a.length) throw httpError(400, 'Choose the account it was paid from');
      const r = await s01(b.month);
      const amt = { paye: r.owing.paye, nis: r.owing.nis, nht: r.owing.nht, ed: r.owing.ed, heart: r.owing.heart, levy: r.owing.levy, wht: r.owing.wht, pension: b.include_pension ? r.owing.pension : 0 };
      for (const k of Object.keys(amt)) if (amt[k] < 0) amt[k] = 0;
      const total = r2(Object.values(amt).reduce((t, v) => t + v, 0));
      if (!(total > 0)) throw httpError(409, 'Nothing is owing for ' + b.month);
      const { rows } = await query(`INSERT INTO payroll_remittances (month, paye, nis, nht, ed, heart, levy, wht, pension, total, account_id, pay_date, reference, post_gl, created_by)
                                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
        [r.from, amt.paye, amt.nis, amt.nht, amt.ed, amt.heart, amt.levy, amt.wht, amt.pension, total, acct, isDate(b.pay_date) ? b.pay_date : today(), String(b.reference || '').slice(0, 60) || null, on(s, 'payroll_post_ledger'), req.session.userId]);
      await post();
      res.json({ ok: true, id: rows[0].id, total });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/payroll/remittances/:id/void', ...PR, async (req, res) => {
    try {
      const reason = String((req.body && req.body.reason) || '').trim().slice(0, 200);
      if (!reason) throw httpError(400, 'Say why it is voided');
      const { rows: rec } = await query(`SELECT 1 FROM bank_cleared bc JOIN gl_lines l ON l.id = bc.gl_line_id JOIN gl_entries e ON e.id = l.entry_id
                                          WHERE e.source_kind = 'payroll_remit' AND e.source_id = $1 LIMIT 1`, [parseInt(req.params.id, 10) || 0]);
      if (rec.length) throw httpError(409, 'This payment is ticked on a bank reconciliation: undo that first');
      const { rowCount } = await query(`UPDATE payroll_remittances SET voided_at = NOW(), voided_by = $2, void_reason = $3 WHERE id = $1 AND voided_at IS NULL`, [parseInt(req.params.id, 10) || 0, req.session.userId, reason]);
      if (!rowCount) throw httpError(404, 'Not found or already voided');
      await post();
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  // Deductions held for others (insurer, union, court / maintenance, credit union,
  // NHT mortgage, Student Loan Bureau...): deducted in a month, paid over, owing.
  async function thirdParty(month) {
    const from = month + '-01', to = monthEnd(month);
    const { rows: ded } = await query(
      `SELECT l->>'code' AS code, COALESCE(NULLIF(l->>'payee', ''), i.label) AS payee, i.label, i.kind, COUNT(DISTINCT s.employee_id)::int AS people, SUM((l->>'amount')::numeric)::float AS deducted
         FROM payroll_slips s JOIN payroll_runs r ON r.id = s.run_id CROSS JOIN LATERAL jsonb_array_elements(s.lines) l JOIN payroll_items i ON i.code = l->>'code'
        WHERE r.status IN ('approved', 'paid') AND r.pay_date BETWEEN $1 AND $2 AND l->>'kind' IN ('deduction', 'employer') AND NOT (l->>'code' = ANY($3::text[])) AND COALESCE(l->>'notional', '') <> 'true'
        GROUP BY 1, 2, 3, 4 ORDER BY 3, 2`, [from, to, OWN_DEDUCTIONS]);
    const { rows: pays } = await query(`SELECT p.*, to_char(p.pay_date, 'YYYY-MM-DD') AS pay_date, a.code || ' ' || a.name AS account FROM payroll_ded_payments p JOIN gl_accounts a ON a.id = p.account_id WHERE p.month = $1 ORDER BY p.id`, [from]);
    for (const d of ded) {
      d.paid = r2(pays.filter((p) => !p.voided_at && p.code === d.code && p.payee === d.payee).reduce((t, p) => t + n(p.amount), 0));
      d.owing = r2(d.deducted - d.paid);
    }
    return { month, from, to, lines: ded, payments: pays };
  }
  app.get('/api/payroll/deductions', ...PV, async (req, res) => {
    try { res.json(await thirdParty(/^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : today().slice(0, 7))); } catch (e) { fail(res, e); }
  });
  app.post('/api/payroll/ded-payments', ...PR, async (req, res) => {
    try {
      const b = req.body || {}, s = await settings();
      if (!/^\d{4}-\d{2}$/.test(b.month || '')) throw httpError(400, 'Choose the month');
      const acct = parseInt(b.account_id, 10) || 0;
      const { rows: a } = await query(`SELECT id FROM gl_accounts WHERE id = $1 AND type = 'asset' AND is_active`, [acct]);
      if (!a.length) throw httpError(400, 'Choose the account it was paid from');
      const tp = await thirdParty(b.month);
      const line = tp.lines.find((d) => d.code === b.code && d.payee === b.payee);
      if (!line || !(line.owing > 0)) throw httpError(409, 'Nothing is owing to ' + (b.payee || 'them') + ' for ' + b.month);
      const amount = b.amount === '' || b.amount == null ? line.owing : r2(b.amount);
      if (!(amount > 0) || amount > line.owing + 0.004) throw httpError(400, 'Pay no more than is owing (' + line.owing.toFixed(2) + ')');
      const { rows } = await query(`INSERT INTO payroll_ded_payments (month, code, payee, amount, account_id, pay_date, reference, post_gl, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [tp.from, b.code, b.payee, amount, acct, isDate(b.pay_date) ? b.pay_date : today(), String(b.reference || '').slice(0, 60) || null, on(s, 'payroll_post_ledger'), req.session.userId]);
      await post();
      res.json({ ok: true, id: rows[0].id, amount });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/payroll/ded-payments/:id/void', ...PR, async (req, res) => {
    try {
      const reason = String((req.body && req.body.reason) || '').trim().slice(0, 200);
      if (!reason) throw httpError(400, 'Say why it is voided');
      const id = parseInt(req.params.id, 10) || 0;
      const { rows: rec } = await query(`SELECT 1 FROM bank_cleared bc JOIN gl_lines l ON l.id = bc.gl_line_id JOIN gl_entries e ON e.id = l.entry_id WHERE e.source_kind = 'payroll_dedpay' AND e.source_id = $1 LIMIT 1`, [id]);
      if (rec.length) throw httpError(409, 'This payment is ticked on a bank reconciliation: undo that first');
      const { rowCount } = await query(`UPDATE payroll_ded_payments SET voided_at = NOW(), voided_by = $2, void_reason = $3 WHERE id = $1 AND voided_at IS NULL`, [id, req.session.userId, reason]);
      if (!rowCount) throw httpError(404, 'Not found or already voided');
      await post();
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // S02 / P24: the year's totals per person.
  app.get('/api/payroll/annual', ...PV, async (req, res) => {
    try {
      const year = /^\d{4}$/.test(req.query.year || '') ? req.query.year : today().slice(0, 4);
      const { rows: all } = await query(
        `SELECT e.id, e.name, e.employee_no, e.trn, e.nis_no, e.address, e.job_title, e.worker_type, e.business_name, to_char(e.hire_date, 'YYYY-MM-DD') AS hire_date, to_char(e.termination_date, 'YYYY-MM-DD') AS termination_date,
                ${STAT.map((k) => `SUM(s.${k})::float AS ${k}`).join(', ')}, COUNT(*)::int AS slips
           FROM payroll_slips s JOIN payroll_runs r ON r.id = s.run_id JOIN payroll_employees e ON e.id = s.employee_id
          WHERE r.status IN ('approved', 'paid') AND r.pay_date BETWEEN $1 AND $2 GROUP BY e.id ORDER BY e.name`, [year + '-01-01', year + '-12-31']);
      const rows = all.filter((x) => x.worker_type !== 'contractor'), contractors = all.filter((x) => x.worker_type === 'contractor');
      const t = {}; for (const k of STAT) t[k] = r2(rows.reduce((a, x) => a + n(x[k]), 0));
      const { rows: rem } = await query(`SELECT COALESCE(SUM(paye), 0)::float AS paye, COALESCE(SUM(nis), 0)::float AS nis, COALESCE(SUM(nht), 0)::float AS nht, COALESCE(SUM(ed), 0)::float AS ed, COALESCE(SUM(heart), 0)::float AS heart
                                           FROM payroll_remittances WHERE voided_at IS NULL AND month BETWEEN $1 AND $2`, [year + '-01-01', year + '-12-31']);
      res.json({ year, employees: rows, contractors, totals: t, remitted: rem[0], employer: await employer(), due_date: (Number(year) + 1) + '-03-31' });
    } catch (e) { fail(res, e); }
  });
  // P45: pay and tax to the leaving date, for the next employer.
  app.get('/api/payroll/employees/:id/p45', ...PV, async (req, res) => {
    try {
      const e = await loadEmp(parseInt(req.params.id, 10) || 0);
      if (!e) throw httpError(404, 'Not found');
      const end = e.termination_date || today(), year = end.slice(0, 4);
      res.json({ employee: { name: e.name, trn: e.trn, nis_no: e.nis_no, address: e.address, job_title: e.job_title, hire_date: e.hire_date, termination_date: e.termination_date, termination_reason: e.termination_reason, frequency: e.frequency },
        ytd: await ytd(e.id, year + '-01-01', end), year, employer: await employer() });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------- company vehicle schedule --
  async function mvSchedule() {
    const { rows } = await query(`SELECT value FROM warehouse_settings WHERE key = 'payroll_mv_schedule'`);
    try {
      const j = JSON.parse((rows[0] && rows[0].value) || '');
      if (Array.isArray(j) && j.length && j.every((r) => Array.isArray(r) && r.length === 5)) return { rows: j, custom: true };
    } catch (_) {}
    return { rows: MV_SCHEDULE, custom: false };
  }
  app.get('/api/payroll/mv-schedule', ...PV, async (req, res) => { try { res.json(await mvSchedule()); } catch (e) { fail(res, e); } });
  app.put('/api/payroll/mv-schedule', ...PR, async (req, res) => {
    try {
      const b = req.body || {};
      let v = '';
      if (!b.reset) {
        const rows = (Array.isArray(b.rows) ? b.rows : []).slice(0, 12).map((r) => [r[0] === '' || r[0] == null ? null : n(r[0]), r2(r[1]), r2(r[2]), r2(r[3]), r2(r[4])]);
        if (!rows.length) throw httpError(400, 'Enter at least one row');
        rows.sort((a, c) => (a[0] == null ? Infinity : a[0]) - (c[0] == null ? Infinity : c[0]));
        if (rows.some((r) => r.slice(1).some((x) => x < 0)) || rows.slice(0, -1).some((r) => !(r[0] > 0))) throw httpError(400, 'Each row needs a cost limit (the last row can be blank: any cost above) and four yearly values');
        rows[rows.length - 1][0] = null;
        v = JSON.stringify(rows);
      }
      await query(`INSERT INTO warehouse_settings (key, value) VALUES ('payroll_mv_schedule', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [v]);
      res.json(Object.assign({ ok: true }, await mvSchedule()));
    } catch (e) { fail(res, e); }
  });

  // -------------------------------------------------------------- year end --
  // The year's figures start again by themselves on 1 January (they are worked
  // from pay dates). Closing a year checks it is complete, locks it, and
  // carries vacation days not taken into the next year.
  const CARRY_REASON = (y) => 'Carried forward from ' + y + ' (payroll year end)';
  async function yearEnd(year) {
    const from = year + '-01-01', to = year + '-12-31', next = String(Number(year) + 1), s = await settings();
    const { rows: yr } = await query(`SELECT y.*, u.name AS closed_by_name, ru.name AS reopened_by_name FROM payroll_years y LEFT JOIN users u ON u.id = y.closed_by LEFT JOIN users ru ON ru.id = y.reopened_by WHERE y.year = $1`, [Number(year)]);
    const { rows: open } = await query(`SELECT id, number, status, to_char(pay_date, 'YYYY-MM-DD') AS pay_date, totals FROM payroll_runs WHERE pay_date BETWEEN $1 AND $2 AND status IN ('draft', 'approved') ORDER BY pay_date, id`, [from, to]);
    const { rows: tot } = await query(
      `SELECT ${STAT.map((k) => `COALESCE(SUM(s.${k}), 0)::float AS ${k}`).join(', ')}, COUNT(DISTINCT s.employee_id)::int AS people, COUNT(DISTINCT r.id)::int AS runs
         FROM payroll_slips s JOIN payroll_runs r ON r.id = s.run_id WHERE r.status IN ('approved', 'paid') AND r.pay_date BETWEEN $1 AND $2`, [from, to]);
    const { rows: months } = await query(`SELECT DISTINCT to_char(pay_date, 'YYYY-MM') AS m FROM payroll_runs WHERE status IN ('approved', 'paid') AND pay_date BETWEEN $1 AND $2 ORDER BY 1`, [from, to]);
    const owing = [];
    for (const m of months) { const r = await s01(m.m); const o = r2(r.owing.paye + r.owing.nis + r.owing.nht + r.owing.ed + r.owing.heart + r.owing.levy + r.owing.wht); if (o > 0.004) owing.push({ month: m.m, owing: o, due_date: r.due_date }); }
    const { rows: noIds } = await query(
      `SELECT DISTINCT e.id, e.name FROM payroll_slips s JOIN payroll_runs r ON r.id = s.run_id JOIN payroll_employees e ON e.id = s.employee_id
        WHERE r.status IN ('approved', 'paid') AND r.pay_date BETWEEN $1 AND $2 AND e.worker_type <> 'contractor' AND (e.trn IS NULL OR e.nis_no IS NULL) ORDER BY e.name`, [from, to]);
    const { rows: loans } = await query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(balance), 0)::float AS v FROM payroll_employee_items WHERE code IN ('loan', 'advance') AND balance > 0.004`);
    const { rows: sav } = await query(`SELECT COUNT(*) FILTER (WHERE x.saved > 0.004)::int AS n, COALESCE(SUM(x.saved), 0)::float AS v, COALESCE(SUM(x.saved) FILTER (WHERE x.code = 'staff_savings'), 0)::float AS held
                                         FROM payroll_employee_items x JOIN payroll_items i ON i.code = x.code WHERE i.is_savings`);
    const { rows: emps } = await query(`SELECT ${EMP_SELECT} FROM payroll_employees e LEFT JOIN users u ON u.id = e.user_id WHERE e.is_active AND e.worker_type <> 'contractor' AND e.user_id IS NOT NULL AND e.termination_date IS NULL ORDER BY e.name`);
    const max = n(s.payroll_carry_vacation_max), leave = [];
    for (const e of emps) { const lb = await leaveBalance(e, year); leave.push({ id: e.id, user_id: e.user_id, name: e.name, entitled: lb.vacation_entitled, taken: lb.vacation_taken, left: lb.vacation_left, carry: Math.max(0, Math.min(lb.vacation_left, max)) }); }
    const { rows: nextRates } = await query(`SELECT to_char(effective_from, 'YYYY-MM-DD') AS effective_from, paye_threshold::float AS paye_threshold FROM payroll_rates WHERE effective_from BETWEEN $1 AND $2 ORDER BY 1`, [next + '-01-01', next + '-12-31']);
    const { rows: prior } = await query(`SELECT COUNT(*)::int AS n FROM payroll_employees WHERE prior_year = $1`, [Number(year)]);
    const { rows: cumul } = await query(`SELECT COUNT(*)::int AS n FROM payroll_employees WHERE is_active AND paye_method = 'cumulative'`);
    const drafts = open.filter((r) => r.status === 'draft'), unpaid = open.filter((r) => r.status === 'approved');
    const blockers = [];
    if (drafts.length) blockers.push(drafts.length + ' draft pay run(s) dated in ' + year + ': approve or delete them');
    if (today() < year + '-12-01') blockers.push('The year can be closed from 1 December, once its last pay run is approved');
    return { year, next, closed: !!(yr[0] && yr[0].closed), record: yr[0] || null, totals: tot[0], drafts, unpaid, s01_owing: owing, missing_ids: noIds, loans: loans[0], savings: sav[0], leave, carry_max: max,
      next_rates: nextRates, prior_employment: prior[0].n, cumulative: cumul[0].n, blockers, can_close: !blockers.length, s02_due: next + '-03-31' };
  }
  const yearOf = (v) => (/^\d{4}$/.test(String(v || '')) ? String(v) : (today().slice(5, 7) <= '03' ? String(Number(today().slice(0, 4)) - 1) : today().slice(0, 4)));
  app.get('/api/payroll/year-end', ...PV, async (req, res) => {
    try { res.json(await yearEnd(yearOf(req.query.year))); } catch (e) { fail(res, e); }
  });
  app.post('/api/payroll/year-end/close', ...PA, async (req, res) => {
    try {
      const b = req.body || {};
      if (!/^\d{4}$/.test(String(b.year || ''))) throw httpError(400, 'Choose the year');
      if ('carry_max' in b && b.carry_max !== '' && b.carry_max != null)
        await query(`INSERT INTO warehouse_settings (key, value) VALUES ('payroll_carry_vacation_max', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [String(Math.max(0, Math.min(60, n(b.carry_max))))]);
      const ye = await yearEnd(String(b.year));
      if (ye.closed) throw httpError(409, ye.year + ' is already closed');
      if (ye.blockers.length) throw httpError(409, ye.blockers.join('. '));
      const carried = ye.leave.filter((l) => l.carry > 0).map((l) => ({ employee_id: l.id, user_id: l.user_id, name: l.name, days: l.carry }));
      await tx(async (c) => {
        // Closing again after a reopen writes the carried days afresh.
        await c.query(`DELETE FROM hr_leave_adjustments WHERE year = $1 AND kind = 'vacation' AND reason = $2`, [Number(ye.next), CARRY_REASON(ye.year)]);
        for (const l of carried) await c.query(`INSERT INTO hr_leave_adjustments (user_id, year, kind, days, reason, by_user) VALUES ($1, $2, 'vacation', $3, $4, $5)`, [l.user_id, Number(ye.next), l.days, CARRY_REASON(ye.year), req.session.userId]);
        await c.query(
          `INSERT INTO payroll_years (year, closed, closed_at, closed_by, summary, carried) VALUES ($1, true, NOW(), $2, $3, $4)
           ON CONFLICT (year) DO UPDATE SET closed = true, closed_at = NOW(), closed_by = EXCLUDED.closed_by, summary = EXCLUDED.summary, carried = EXCLUDED.carried`,
          [Number(ye.year), req.session.userId, JSON.stringify(Object.assign({}, ye.totals, { s01_owing: ye.s01_owing, loans: ye.loans, savings: ye.savings })), JSON.stringify(carried)]);
      });
      res.json({ ok: true, year: ye.year, carried: carried.length, note: 'Pay dated in ' + ye.next + ' starts its year-to-date figures from zero. Loans and savings carry on as they are.' });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/payroll/year-end/reopen', ...PA, async (req, res) => {
    try {
      const b = req.body || {}, reason = String(b.reason || '').trim().slice(0, 200);
      if (!reason) throw httpError(400, 'Say why the year is reopened');
      const { rowCount } = await query(`UPDATE payroll_years SET closed = false, reopened_at = NOW(), reopened_by = $2, reopen_reason = $3 WHERE year = $1 AND closed`, [parseInt(b.year, 10) || 0, req.session.userId, reason]);
      if (!rowCount) throw httpError(404, 'That year is not closed');
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // --------------------------------------------------------------- summary --
  app.get('/api/payroll/summary', ...PV, async (req, res) => {
    try {
      const { rows: emp } = await query(`SELECT COUNT(*) FILTER (WHERE is_active)::int AS active, COUNT(*) FILTER (WHERE is_active AND (trn IS NULL OR nis_no IS NULL))::int AS missing_ids FROM payroll_employees`);
      const { rows: runs } = await query(`SELECT status, COUNT(*)::int AS n FROM payroll_runs GROUP BY status`);
      const last = (await query(`SELECT id, number, status, totals, to_char(pay_date, 'YYYY-MM-DD') AS pay_date FROM payroll_runs WHERE status IN ('approved', 'paid') ORDER BY pay_date DESC, id DESC LIMIT 1`)).rows[0] || null;
      // Months with statutory amounts still owing.
      const { rows: months } = await query(`SELECT DISTINCT to_char(pay_date, 'YYYY-MM') AS m FROM payroll_runs WHERE status IN ('approved', 'paid') ORDER BY 1 DESC LIMIT 12`);
      const owing = [];
      for (const m of months) { const r = await s01(m.m); const o = r2(r.owing.paye + r.owing.nis + r.owing.nht + r.owing.ed + r.owing.heart + r.owing.levy + r.owing.wht); if (o > 0.004) owing.push({ month: m.m, owing: o, due_date: r.due_date, late: r.due_date < today() }); }
      const st = {}; for (const r of runs) st[r.status] = r.n;
      const { rows: unpaid } = await query(`SELECT COUNT(*)::int AS n, COALESCE(SUM((totals->>'net')::numeric), 0)::float AS v FROM payroll_runs WHERE status = 'approved'`);
      // From December to March: is the year just gone (or ending) closed?
      const mm = today().slice(5, 7), yy = Number(today().slice(0, 4));
      let year_end = null;
      if (mm === '12' || mm <= '03') {
        const y = mm === '12' ? yy : yy - 1;
        const { rows: ye } = await query(`SELECT (SELECT COUNT(*)::int FROM payroll_runs WHERE status <> 'void' AND EXTRACT(YEAR FROM pay_date) = $1) AS runs, EXISTS (SELECT 1 FROM payroll_years WHERE year = $1 AND closed) AS closed`, [y]);
        if (ye[0].runs && !ye[0].closed) year_end = { year: y };
      }
      res.json({ employees: emp[0], runs: st, last, s01_owing: owing, net_unpaid: unpaid[0], settings: await settings(), year_end });
    } catch (e) { fail(res, e); }
  });

  return { settings, compute, cumFor, yearEnd };
}

module.exports = { register, PERIODS, NOT_PAY };
