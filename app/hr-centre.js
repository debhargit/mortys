// =============================================================================
//  Morty's Auto Parts -- People & HR, part 3: the employee centre
//  (registered by hr.js), as in the QuickBooks Employee Center, for Jamaica.
//
//  The list: Active / Inactive / Released / All, every column to choose from,
//  Excel and CSV, and a side panel with the person's details and their
//  transactions (payslips, year-to-date, leave taken, loans).
//
//  The record: personal (legal and preferred name, TRN, NIS, date of birth,
//  gender, marital status, photo), address and contact, additional info
//  (fields a manager defines), payroll info, employment (original hire date,
//  adjusted service date, release date, eligible for rehire), notes and to
//  do's with reminders, and an employee summary of their pay.
//
//  Pay is Payroll's (payroll_employees, payroll_slips): read here, never
//  copied. Seeing pay needs payroll.view; seeing a whole TRN or NIS number,
//  or changing pay, needs payroll.run (changes go through /api/payroll).
//
//  Also: the New Employee wizard, Employee Defaults, Make inactive, Release
//  and Rehire, and the lists: Employee contact list, Employee details,
//  Withholding (TRN / NIS, PAYE, NIS, NHT, Education Tax), Paid time off,
//  Birthdays and anniversaries.
// =============================================================================
'use strict';

const SALUTATIONS = ['Mr', 'Mrs', 'Ms', 'Miss', 'Dr'];
const MARITAL = ['single', 'married', 'common_law', 'divorced', 'widowed'];
const TODO_TYPES = ['call', 'meeting', 'email', 'task', 'follow_up'];
const FIELD_KINDS = ['text', 'number', 'date', 'list', 'yesno'];
const STATES = ['active', 'inactive', 'released', 'all'];
const CONTRACTS = ['permanent', 'fixed_term', 'part_time', 'casual', 'contractor', 'intern'];
const EMP_TYPES = ['regular', 'officer', 'owner', 'statutory'];
// What a new employee starts with, until a manager changes it (Employee Defaults).
const DEFAULTS = {
  contract_type: 'permanent', probation_months: 3, department_id: null, employee_type: 'regular', work_location: null, parish: null, leave_accrual: 'year', onboarding: true,
  payroll: { add: true, pay_type: 'salary', frequency: 'monthly', pay_method: 'bank', hours_per_day: 8, ot_rate: 1.5, use_timeclock: true, vacation_days: null, sick_days: null, pension_ee_pct: 0, pension_er_pct: 0, items: [] },
};
const YTD_COLS = ['gross', 'statutory', 'paye', 'nis_ee', 'nht_ee', 'ed_ee', 'pension_ee', 'other_ded', 'net', 'nis_er', 'nht_er', 'ed_er', 'heart_er', 'pension_er', 'levy', 'wht'];

function register(app, deps) {
  const { query, requireAdmin, requireCap, userCan, audit, ensureFile, staffRow, httpError, fail, newStaffUser, leaveFor, addTasks, ONBOARDING } = deps;
  const P = [requireAdmin, requireCap('hr.people')];
  const me = (req) => req.session.userId;
  const t = (v, m) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, m));
  const d = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
  const n = (v) => { const x = parseInt(v, 10); return Number.isFinite(x) && x > 0 ? x : null; };
  const num = (v) => { if (v == null || v === '') return null; const x = Number(String(v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(x) ? Math.round(x * 100) / 100 : null; };
  const one = (v, list, dflt) => (list.includes(v) ? v : dflt);
  const today = () => new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10);   // Jamaica (no daylight saving)
  const DATE = (c) => `to_char(${c}, 'YYYY-MM-DD')`;
  const mask = (v, keep = 3) => (v ? String(v).replace(/\s/g, '').replace(new RegExp('.(?=.{' + keep + '})', 'g'), '•') : null);
  const TRN_RE = /^\d{3}-?\d{3}-?\d{3}$/, NIS_RE = /^[A-Za-z]{0,2}\d{6,8}$/;
  async function level(req) {
    const run = await userCan(req, 'payroll.run');
    return { run, view: run || (await userCan(req, 'payroll.view')) };
  }
  async function tell(ids, n0) { if (deps.notice && ids.length) await deps.notice(ids, n0).catch(() => {}); }

  // ------------------------------------------------------------ the list --
  // released: archived, left, or past their release date. inactive: taken off
  // the active list by HR (long leave, a break) without being released.
  const STATE = `CASE WHEN COALESCE(u.is_archived, false) OR h.status = 'left' OR h.release_date < CURRENT_DATE THEN 'released' WHEN COALESCE(h.inactive, false) THEN 'inactive' ELSE 'active' END`;
  const CENTRE_SQL = `SELECT u.id, COALESCE(NULLIF(u.name, ''), u.email) AS name, CASE WHEN u.email ~* '\\.local$' THEN NULL ELSE u.email END AS email, u.phone, u.employee_no,
      COALESCE(u.is_archived, false) AS is_archived, COALESCE(u.disabled, false) AS login_off, ${DATE('u.left_on')} AS left_on,
      h.salutation, h.legal_name, h.preferred_name, h.gender, h.marital_status, ${DATE('COALESCE(h.date_of_birth, p.date_of_birth)')} AS date_of_birth,
      h.mobile, h.personal_phone, h.personal_email, COALESCE(h.address, p.address) AS address, h.town, h.parish,
      h.job_title, h.department_id, dp.name AS department, h.manager_user_id, COALESCE(NULLIF(m.name, ''), m.email) AS manager, h.work_location,
      ${DATE('COALESCE(h.start_date, p.hire_date)')} AS start_date, ${DATE('h.adjusted_service_date')} AS adjusted_service_date,
      ${DATE('COALESCE(h.release_date, p.termination_date, u.left_on)')} AS release_date, h.release_reason, h.rehire_eligible, h.inactive_reason,
      COALESCE(h.contract_type, 'permanent') AS contract_type, ${DATE('h.contract_end')} AS contract_end, COALESCE(h.employee_type, 'regular') AS employee_type,
      CASE WHEN u.is_archived THEN 'left' ELSE COALESCE(h.status, 'active') END AS status, ${DATE('h.probation_end')} AS probation_end, ${STATE} AS state,
      (h.user_id IS NOT NULL) AS has_file, (h.photo IS NOT NULL) AS has_photo, COALESCE(h.leave_accrual, 'year') AS leave_accrual,
      p.id AS payroll_id, p.is_active AS pay_active, p.pay_type, p.frequency, p.pay_method, p.salary_annual::float, p.hourly_rate::float, p.day_rate::float, p.trn, p.nis_no, p.bank_name,
      (SELECT COUNT(*)::int FROM hr_cases c WHERE c.user_id = u.id AND c.status = 'open' AND c.kind <> 'commendation' AND (c.expires_on IS NULL OR c.expires_on >= CURRENT_DATE)) AS open_cases,
      (SELECT COUNT(*)::int FROM hr_tasks k WHERE k.user_id = u.id AND k.done_at IS NULL) AS open_tasks,
      (SELECT COUNT(*)::int FROM hr_contacts c WHERE c.user_id = u.id) AS contacts,
      (SELECT ${DATE('MIN(r.due_on)')} FROM hr_reviews r WHERE r.user_id = u.id AND r.status = 'draft') AS review_due,
      (SELECT COUNT(*)::int FROM hr_notes x WHERE x.user_id = u.id AND x.kind = 'todo' AND x.done_at IS NULL) AS open_todos,
      (SELECT json_object_agg(v.field_id, v.value) FROM hr_custom_values v WHERE v.user_id = u.id AND v.value IS NOT NULL) AS custom
    FROM users u LEFT JOIN hr_employees h ON h.user_id = u.id LEFT JOIN departments dp ON dp.id = h.department_id
      LEFT JOIN users m ON m.id = h.manager_user_id LEFT JOIN payroll_employees p ON p.user_id = u.id
    WHERE (u.is_staff OR u.is_admin OR u.archived_at IS NOT NULL)`;
  // Pay only for payroll.view; whole TRN / NIS only for payroll.run.
  function shape(r, lv) {
    r.has_trn = !!r.trn; r.has_nis = !!r.nis_no;
    if (!lv.run) { r.trn = lv.view ? mask(r.trn) : null; r.nis_no = lv.view ? mask(r.nis_no) : null; }
    if (!lv.view) for (const k of ['pay_type', 'frequency', 'pay_method', 'salary_annual', 'hourly_rate', 'day_rate', 'bank_name']) delete r[k];
    return r;
  }
  async function centreRows(req, where, vals) {
    const lv = await level(req);
    const { rows } = await query(`SELECT * FROM (${CENTRE_SQL}) x ${where ? 'WHERE ' + where : ''} ORDER BY x.name`, vals || []);
    return rows.map((r) => shape(r, lv));
  }
  app.get('/api/people/centre', ...P, async (req, res) => {
    try {
      const state = one(req.query.state, STATES, 'active');
      const rows = await centreRows(req, state === 'all' ? null : 'x.state = $1', state === 'all' ? [] : [state]);
      const { rows: counts } = await query(`SELECT x.state, COUNT(*)::int AS n FROM (${CENTRE_SQL}) x GROUP BY 1`);
      const { rows: fields } = await query(`SELECT id, label, kind, options FROM hr_custom_fields WHERE is_active ORDER BY sort, id`);
      res.json({ state, staff: rows, counts: Object.fromEntries(counts.map((c) => [c.state, c.n])), fields, access: await level(req) });
    } catch (e) { fail(res, e); }
  });

  // The side panel: details, what is due, and the transactions.
  async function slipList(pid, where, vals) {
    const { rows } = await query(`SELECT s.id, r.id AS run_id, r.number, r.status, ${DATE('r.pay_date')} AS pay_date, ${DATE('r.period_start')} AS period_start, ${DATE('r.period_end')} AS period_end,
        s.gross::float, s.paye::float, s.nis_ee::float, s.nht_ee::float, s.ed_ee::float, s.pension_ee::float, s.other_ded::float, s.net::float, s.cheque_number,
        (s.paye + s.nis_ee + s.nht_ee + s.ed_ee + s.pension_ee + s.other_ded)::float AS deductions
      FROM payroll_slips s JOIN payroll_runs r ON r.id = s.run_id WHERE s.employee_id = $1 AND r.status IN ('approved', 'paid', 'void') ${where || ''} ORDER BY r.pay_date DESC, r.id DESC`, [pid].concat(vals || []));
    return rows;
  }
  async function ytdFor(pid, year) {
    const { rows } = await query(`SELECT ${YTD_COLS.map((k) => `COALESCE(SUM(s.${k}), 0)::float AS ${k}`).join(', ')}, COUNT(*)::int AS slips
      FROM payroll_slips s JOIN payroll_runs r ON r.id = s.run_id WHERE s.employee_id = $1 AND r.status IN ('approved', 'paid') AND EXTRACT(YEAR FROM r.pay_date) = $2`, [pid, year]);
    return rows[0];
  }
  async function leaveTaken(uid, from, to) {
    const { rows } = await query(`SELECT l.id, ${DATE('l.from_date')} AS from_date, ${DATE('l.to_date')} AS to_date, l.kind, l.note,
        (SELECT COUNT(*)::int FROM generate_series(GREATEST(l.from_date, $2::date), LEAST(l.to_date, $3::date), interval '1 day') g(x) WHERE EXTRACT(DOW FROM g.x) <> 0) AS days
      FROM staff_leave l WHERE l.user_id = $1 AND l.to_date >= $2::date AND l.from_date <= $3::date ORDER BY l.from_date DESC`, [uid, from, to]);
    return rows;
  }
  app.get('/api/people/centre/:id', ...P, async (req, res) => {
    try {
      const uid = n(req.params.id);
      const r = (await centreRows(req, 'x.id = $1', [uid]))[0];
      if (!r) throw httpError(404, 'Staff member not found');
      const lv = await level(req), year = Number(today().slice(0, 4));
      const out = { person: r, access: lv, leave: (await leaveFor([uid], year))[uid] || null };
      out.todos = (await query(`SELECT x.id, x.body, x.todo_type, x.priority, ${DATE('x.due_on')} AS due_on, x.remind_at, COALESCE(NULLIF(a.name, ''), a.email) AS assignee
        FROM hr_notes x LEFT JOIN users a ON a.id = x.assignee_id WHERE x.user_id = $1 AND x.kind = 'todo' AND x.done_at IS NULL ORDER BY x.due_on NULLS LAST, x.id LIMIT 10`, [uid])).rows;
      out.notes = (await query(`SELECT x.id, x.body, x.pinned, x.created_at, COALESCE(NULLIF(b.name, ''), b.email) AS by_name FROM hr_notes x LEFT JOIN users b ON b.id = x.created_by
        WHERE x.user_id = $1 AND x.kind = 'note' ORDER BY x.pinned DESC, x.id DESC LIMIT 3`, [uid])).rows;
      out.leave_taken = await leaveTaken(uid, (year - 1) + '-01-01', year + '-12-31').then((l) => l.slice(0, 8));
      out.events = (await query(`SELECT a.at, a.action, a.detail FROM hr_audit a WHERE a.user_id = $1 ORDER BY a.at DESC LIMIT 6`, [uid])).rows;
      if (lv.view && r.payroll_id) {
        out.slips = (await slipList(r.payroll_id)).slice(0, 12);
        out.ytd = await ytdFor(r.payroll_id, year);
      }
      res.json(out);
    } catch (e) { fail(res, e); }
  });

  // Excel for any list on the page: the rows as shown, in an .xlsx.
  app.post('/api/people/xlsx', ...P, async (req, res) => {
    try {
      const b = req.body || {};
      const sheets = (Array.isArray(b.sheets) ? b.sheets : []).slice(0, 10);
      if (!sheets.length) throw httpError(400, 'Nothing to export');
      const ExcelJS = require('exceljs');
      const wb = new ExcelJS.Workbook(); wb.creator = 'Morty\'s Auto Parts';
      const used = new Set();
      for (const s of sheets) {
        let title = String(s.title || 'Sheet').replace(/[\[\]:*?/\\]/g, ' ').slice(0, 31).trim() || 'Sheet';
        while (used.has(title.toLowerCase())) title = title.slice(0, 28) + ' ' + used.size;
        used.add(title.toLowerCase());
        const ws = wb.addWorksheet(title);
        const header = (Array.isArray(s.header) ? s.header : []).slice(0, 80).map((h) => String(h == null ? '' : h).slice(0, 120));
        ws.addRow(header); ws.getRow(1).font = { bold: true };
        const rows = (Array.isArray(s.rows) ? s.rows : []).slice(0, 20000);
        for (const row of rows) ws.addRow((Array.isArray(row) ? row : []).slice(0, 80).map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : v == null ? '' : String(v).slice(0, 2000))));
        ws.columns.forEach((c, i) => { let w = String(header[i] || '').length; c.eachCell({ includeEmpty: false }, (cell) => { w = Math.max(w, String(cell.value == null ? '' : cell.value).length); }); c.width = Math.min(50, Math.max(8, w + 2)); });
        ws.views = [{ state: 'frozen', ySplit: 1 }];
      }
      const name = (String(b.name || 'staff').replace(/[^a-z0-9-]+/gi, '-').slice(0, 60) || 'staff') + '-' + today() + '.xlsx';
      res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').set('Content-Disposition', 'attachment; filename="' + name + '"').set('Cache-Control', 'no-store');
      res.send(Buffer.from(await wb.xlsx.writeBuffer()));
    } catch (e) { fail(res, e); }
  });

  // ----------------------------------------------------- TRN and NIS no. --
  // Kept in Payroll. Changing them is for someone who may change pay; a
  // person not in Payroll yet is added there, pay switched off.
  app.put('/api/people/staff/:id/ids', ...P, async (req, res) => {
    try {
      const uid = n(req.params.id); const u = await staffRow(uid); const b = req.body || {};
      if (!(await userCan(req, 'payroll.run'))) throw httpError(403, 'Only someone who may change pay can change a TRN or NIS number');
      const trn = t(b.trn, 20), nis = t(b.nis_no, 20) ? t(b.nis_no, 20).toUpperCase().replace(/\s/g, '') : null;
      if (trn && !TRN_RE.test(trn)) throw httpError(400, 'A TRN is nine digits (123-456-789)');
      if (nis && !NIS_RE.test(nis)) throw httpError(400, 'An NIS number is a letter and six digits, as on the NIS card (A123456)');
      const { rows } = await query(`SELECT id, trn, nis_no FROM payroll_employees WHERE user_id = $1`, [uid]);
      if (rows.length) await query(`UPDATE payroll_employees SET trn = $2, nis_no = $3, updated_by = $4, updated_at = NOW() WHERE id = $1`, [rows[0].id, trn, nis, me(req)]);
      else await query(`INSERT INTO payroll_employees (user_id, name, email, employee_no, trn, nis_no, is_active, notes, updated_by) VALUES ($1,$2,$3,$4,$5,$6,false,$7,$8)`,
        [uid, u.name || u.email, /\.local$/i.test(u.email) ? null : u.email, u.employee_no, trn, nis, 'Added from People & HR with the TRN / NIS. Enter the pay, then switch pay on.', me(req)]);
      const what = [(rows[0] ? rows[0].trn : null) !== trn ? 'TRN' : null, (rows[0] ? rows[0].nis_no : null) !== nis ? 'NIS number' : null].filter(Boolean);
      if (what.length) await audit({ user_id: uid, entity: 'profile', action: what.join(' and ') + ' changed', detail: rows.length ? null : 'added to Payroll, pay switched off', by: me(req) });
      res.json({ ok: true, added_to_payroll: !rows.length });
    } catch (e) { fail(res, e); }
  });

  // --------------------------------------------------------------- photo --
  app.post('/api/people/staff/:id/photo', ...P, async (req, res) => {
    try {
      const uid = n(req.params.id); await staffRow(uid); await ensureFile(uid);
      const m = /^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(String((req.body || {}).data || ''));
      if (!m) throw httpError(400, 'Choose a photo (JPEG or PNG)');
      const raw = Buffer.from(m[2], 'base64');
      if (raw.length > 8 * 1024 * 1024) throw httpError(400, 'That photo is too big (8 MB at most)');
      let jpg;
      try { jpg = await require('sharp')(raw).rotate().resize(320, 320, { fit: 'cover' }).jpeg({ quality: 80 }).toBuffer(); }
      catch (_) { throw httpError(400, 'That file is not a photo we can read'); }
      await query(`UPDATE hr_employees SET photo = $2, photo_at = NOW(), updated_by = $3, updated_at = NOW() WHERE user_id = $1`, [uid, jpg, me(req)]);
      await audit({ user_id: uid, entity: 'profile', action: 'photo added', by: me(req) });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/people/staff/:id/photo', ...P, async (req, res) => {
    try {
      const { rows } = await query(`SELECT photo FROM hr_employees WHERE user_id = $1 AND photo IS NOT NULL`, [n(req.params.id)]);
      if (!rows.length) return res.status(404).end();
      res.set('Content-Type', 'image/jpeg').set('Cache-Control', 'private, max-age=60').send(rows[0].photo);
    } catch (e) { fail(res, e); }
  });
  app.delete('/api/people/staff/:id/photo', ...P, async (req, res) => {
    try {
      const uid = n(req.params.id);
      await query(`UPDATE hr_employees SET photo = NULL, photo_at = NULL, updated_by = $2, updated_at = NOW() WHERE user_id = $1`, [uid, me(req)]);
      await audit({ user_id: uid, entity: 'profile', action: 'photo removed', by: me(req) });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------ additional info --
  app.get('/api/people/custom-fields', ...P, async (req, res) => {
    try {
      const { rows } = await query(`SELECT f.*, (SELECT COUNT(*)::int FROM hr_custom_values v WHERE v.field_id = f.id AND v.value IS NOT NULL) AS used FROM hr_custom_fields f ORDER BY f.is_active DESC, f.sort, f.id`);
      res.json({ fields: rows });
    } catch (e) { fail(res, e); }
  });
  function cleanField(b, cur) {
    const f = { label: 'label' in b ? t(b.label, 60) : cur.label, kind: 'kind' in b ? one(b.kind, FIELD_KINDS, null) : cur.kind,
      options: 'options' in b ? (Array.isArray(b.options) ? b.options : String(b.options || '').split(/[\n,]/)).map((o) => t(o, 60)).filter(Boolean).slice(0, 40) : cur.options || [],
      sort: 'sort' in b ? (parseInt(b.sort, 10) || 100) : (cur.sort || 100), is_active: 'is_active' in b ? !!b.is_active : cur.is_active !== false };
    if (!f.label) throw httpError(400, 'A name for the field (for example: Uniform size)');
    if (!f.kind) throw httpError(400, 'What kind of field it is');
    if (f.kind === 'list' && f.options.length < 2) throw httpError(400, 'At least two choices for a list, one per line');
    return f;
  }
  app.post('/api/people/custom-fields', ...P, async (req, res) => {
    try {
      const f = cleanField(req.body || {}, {});
      const { rows: n0 } = await query(`SELECT COUNT(*)::int AS n FROM hr_custom_fields WHERE is_active`);
      if (n0[0].n >= 30) throw httpError(400, 'Thirty fields at most. Switch one off first.');
      const { rows } = await query(`INSERT INTO hr_custom_fields (label, kind, options, sort, is_active, created_by) VALUES ($1,$2,$3,$4,true,$5) RETURNING id`, [f.label, f.kind, f.options, f.sort, me(req)]);
      await audit({ entity: 'setting', entity_id: rows[0].id, action: 'staff field added', detail: f.label + ' (' + f.kind + ')', by: me(req) });
      res.json({ id: rows[0].id });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/people/custom-fields/:fid', ...P, async (req, res) => {
    try {
      const id = n(req.params.fid);
      const { rows } = await query(`SELECT * FROM hr_custom_fields WHERE id = $1`, [id]);
      if (!rows.length) throw httpError(404, 'Field not found');
      const b = Object.assign({}, req.body || {}); delete b.kind;   // the kind stays: values are already kept that way
      const f = cleanField(b, rows[0]);
      await query(`UPDATE hr_custom_fields SET label = $2, options = $3, sort = $4, is_active = $5 WHERE id = $1`, [id, f.label, f.options, f.sort, f.is_active]);
      await audit({ entity: 'setting', entity_id: id, action: 'staff field changed', detail: f.label + (f.is_active ? '' : ' (switched off)'), by: me(req) });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.delete('/api/people/custom-fields/:fid', ...P, async (req, res) => {
    try {
      const id = n(req.params.fid);
      const { rows: used } = await query(`SELECT COUNT(*)::int AS n FROM hr_custom_values WHERE field_id = $1 AND value IS NOT NULL`, [id]);
      if (used[0].n) throw httpError(409, 'Filled in for ' + used[0].n + ' staff member(s). Switch it off instead, so what was recorded stays.');
      const { rows } = await query(`DELETE FROM hr_custom_fields WHERE id = $1 RETURNING label`, [id]);
      if (!rows.length) throw httpError(404, 'Field not found');
      await audit({ entity: 'setting', entity_id: id, action: 'staff field removed', detail: rows[0].label, by: me(req) });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  function fieldValue(f, v) {
    if (v == null || String(v).trim() === '') return null;
    v = String(v).trim();
    if (f.kind === 'number') { const x = num(v); if (x == null) throw httpError(400, f.label + ': a number'); return String(x); }
    if (f.kind === 'date') { if (!d(v)) throw httpError(400, f.label + ': a date'); return v; }
    if (f.kind === 'yesno') return ['yes', 'true', '1', 'on'].includes(v.toLowerCase()) ? 'yes' : 'no';
    if (f.kind === 'list' && !(f.options || []).includes(v)) throw httpError(400, f.label + ': one of ' + f.options.join(', '));
    return v.slice(0, 500);
  }
  async function saveCustom(uid, values, by, q = query) {
    const { rows: fields } = await q(`SELECT * FROM hr_custom_fields WHERE is_active`);
    const changed = [];
    for (const f of fields) {
      if (!(String(f.id) in values)) continue;
      const v = fieldValue(f, values[f.id]);
      const { rows: cur } = await q(`SELECT value FROM hr_custom_values WHERE user_id = $1 AND field_id = $2`, [uid, f.id]);
      if ((cur[0] ? cur[0].value : null) === v) continue;
      await q(`INSERT INTO hr_custom_values (user_id, field_id, value, updated_by, updated_at) VALUES ($1,$2,$3,$4,NOW())
        ON CONFLICT (user_id, field_id) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`, [uid, f.id, v, by]);
      changed.push(f.label);
    }
    if (changed.length) await audit({ user_id: uid, entity: 'profile', action: 'additional info updated', detail: 'Changed: ' + changed.join(', '), by }, q);
    return changed;
  }
  app.get('/api/people/staff/:id/custom', ...P, async (req, res) => {
    try {
      const uid = n(req.params.id); await staffRow(uid);
      const { rows } = await query(`SELECT f.id, f.label, f.kind, f.options, v.value, v.updated_at FROM hr_custom_fields f LEFT JOIN hr_custom_values v ON v.field_id = f.id AND v.user_id = $1
        WHERE f.is_active OR v.value IS NOT NULL ORDER BY f.sort, f.id`, [uid]);
      res.json({ fields: rows });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/people/staff/:id/custom', ...P, async (req, res) => {
    try {
      const uid = n(req.params.id); await staffRow(uid);
      res.json({ ok: true, changed: await saveCustom(uid, (req.body || {}).values || {}, me(req)) });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------- notes and to do's --
  // remind_at comes as "YYYY-MM-DDTHH:MM", Jamaica time.
  const remindAt = (v) => { if (!v) return null; const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(String(v)); if (!m) return undefined; const x = new Date(m[1] + 'T' + m[2] + ':00-05:00'); return isNaN(x) ? undefined : x.toISOString(); };
  const NOTE_SQL = `SELECT x.*, ${DATE('x.due_on')} AS due_on, COALESCE(NULLIF(a.name, ''), a.email) AS assignee, COALESCE(NULLIF(b.name, ''), b.email) AS by_name, COALESCE(NULLIF(c.name, ''), c.email) AS done_by_name
    FROM hr_notes x LEFT JOIN users a ON a.id = x.assignee_id LEFT JOIN users b ON b.id = x.created_by LEFT JOIN users c ON c.id = x.done_by`;
  app.get('/api/people/staff/:id/notes', ...P, async (req, res) => {
    try {
      const uid = n(req.params.id); await staffRow(uid);
      const { rows } = await query(`${NOTE_SQL} WHERE x.user_id = $1 ORDER BY x.kind, (x.done_at IS NULL) DESC, x.pinned DESC, COALESCE(x.due_on, x.created_at::date) DESC, x.id DESC`, [uid]);
      res.json({ notes: rows.filter((r) => r.kind === 'note'), todos: rows.filter((r) => r.kind === 'todo') });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/people/staff/:id/notes', ...P, async (req, res) => {
    try {
      const uid = n(req.params.id); const u = await staffRow(uid); const b = req.body || {};
      const kind = one(b.kind, ['note', 'todo'], 'note');
      const body = t(b.body, 4000);
      if (!body) throw httpError(400, kind === 'todo' ? 'What needs doing' : 'The note');
      const at = remindAt(b.remind_at);
      if (at === undefined) throw httpError(400, 'The reminder needs a date and a time');
      const assignee = kind === 'todo' ? (n(b.assignee_id) || me(req)) : null;
      const { rows } = await query(`INSERT INTO hr_notes (user_id, kind, todo_type, priority, body, due_on, remind_at, assignee_id, pinned, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [uid, kind, kind === 'todo' ? one(b.todo_type, TODO_TYPES, 'task') : null, one(b.priority, ['low', 'medium', 'high'], 'medium'), body, kind === 'todo' ? d(b.due_on) : null, kind === 'todo' ? at : null, assignee, !!b.pinned, me(req)]);
      if (assignee && assignee !== me(req)) await tell([assignee], { kind: 'memo', title: '📝 HR to do for you: ' + body.slice(0, 120), body: (u.name || u.email) + (d(b.due_on) ? ' · by ' + d(b.due_on) : ''), link: '/people.html#staff=' + uid });
      await audit({ user_id: uid, entity: kind, entity_id: rows[0].id, action: kind === 'todo' ? 'to do added' : 'note added', detail: body.slice(0, 200), by: me(req) });
      res.json({ id: rows[0].id });
    } catch (e) { fail(res, e); }
  });
  app.patch('/api/people/notes/:nid', ...P, async (req, res) => {
    try {
      const id = n(req.params.nid), b = req.body || {};
      const { rows } = await query(`SELECT * FROM hr_notes WHERE id = $1`, [id]);
      if (!rows.length) throw httpError(404, 'Not found');
      const x = rows[0];
      const at = 'remind_at' in b ? remindAt(b.remind_at) : x.remind_at;
      if (at === undefined) throw httpError(400, 'The reminder needs a date and a time');
      const body = 'body' in b ? t(b.body, 4000) : x.body;
      if (!body) throw httpError(400, 'The text cannot be blank');
      const assignee = 'assignee_id' in b ? (n(b.assignee_id) || me(req)) : x.assignee_id;
      await query(`UPDATE hr_notes SET body = $2, priority = $3, due_on = $4, remind_at = $5, reminded_at = CASE WHEN $6 THEN NULL ELSE reminded_at END, assignee_id = $7, pinned = $8,
          todo_type = $9, done_at = CASE WHEN $10::boolean IS NULL THEN done_at WHEN $10 THEN COALESCE(done_at, NOW()) ELSE NULL END,
          done_by = CASE WHEN $10::boolean IS NULL THEN done_by WHEN $10 THEN COALESCE(done_by, $11) ELSE NULL END, updated_at = NOW() WHERE id = $1`,
        [id, body, 'priority' in b ? one(b.priority, ['low', 'medium', 'high'], x.priority) : x.priority, 'due_on' in b ? d(b.due_on) : x.due_on, at, 'remind_at' in b, x.kind === 'todo' ? assignee : null,
          'pinned' in b ? !!b.pinned : x.pinned, 'todo_type' in b ? one(b.todo_type, TODO_TYPES, x.todo_type) : x.todo_type, 'done' in b ? !!b.done : null, me(req)]);
      if (x.kind === 'todo' && assignee && assignee !== x.assignee_id && assignee !== me(req)) await tell([assignee], { kind: 'memo', title: '📝 HR to do for you: ' + body.slice(0, 120), link: '/people.html#staff=' + x.user_id });
      await audit({ user_id: x.user_id, entity: x.kind, entity_id: id, action: 'done' in b ? (b.done ? 'to do done' : 'to do reopened') : x.kind === 'todo' ? 'to do changed' : 'note changed', detail: body.slice(0, 200), by: me(req) });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.delete('/api/people/notes/:nid', ...P, async (req, res) => {
    try {
      const { rows } = await query(`DELETE FROM hr_notes WHERE id = $1 RETURNING user_id, kind, body`, [n(req.params.nid)]);
      if (!rows.length) throw httpError(404, 'Not found');
      await audit({ user_id: rows[0].user_id, entity: rows[0].kind, entity_id: n(req.params.nid), action: rows[0].kind === 'todo' ? 'to do removed' : 'note removed', detail: rows[0].body.slice(0, 200), by: me(req) });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  // Every open to do, across everyone (mine=1: only those for me).
  app.get('/api/people/todos', ...P, async (req, res) => {
    try {
      const { rows } = await query(`${NOTE_SQL.replace('FROM hr_notes x', ', COALESCE(NULLIF(p.name, \'\'), p.email) AS person FROM hr_notes x JOIN users p ON p.id = x.user_id')}
        WHERE x.kind = 'todo' AND x.done_at IS NULL AND ($1::int IS NULL OR x.assignee_id = $1) ORDER BY x.due_on NULLS LAST, x.priority = 'high' DESC, x.id LIMIT 300`, [req.query.mine === '1' ? me(req) : null]);
      res.json({ todos: rows });
    } catch (e) { fail(res, e); }
  });
  // Reminders: a notice to whoever the to do is for, once, when its time comes.
  async function remind() {
    const { rows } = await query(`UPDATE hr_notes x SET reminded_at = NOW() FROM users u WHERE u.id = x.user_id AND x.kind = 'todo' AND x.done_at IS NULL AND x.reminded_at IS NULL AND x.remind_at <= NOW()
      RETURNING x.id, x.user_id, x.body, ${DATE('x.due_on')} AS due_on, COALESCE(x.assignee_id, x.created_by) AS to_id, COALESCE(NULLIF(u.name, ''), u.email) AS person`);
    for (const r of rows) await tell([r.to_id], { kind: 'memo', title: '⏰ Reminder: ' + r.body.slice(0, 120), body: r.person + (r.due_on ? ' · due ' + r.due_on : ''), link: '/people.html#staff=' + r.user_id, urgent: true });
    return rows.length;
  }
  setInterval(() => { remind().catch((e) => console.warn('[hr] reminders', e.message)); }, 60000).unref();

  // ------------------------------------------------------ payroll info --
  // What Payroll holds for them, read from Payroll. Changes are made with
  // the Payroll calls (/api/payroll/employees/:id) by someone who may.
  app.get('/api/people/staff/:id/payroll', ...P, async (req, res) => {
    try {
      const uid = n(req.params.id); await staffRow(uid);
      const lv = await level(req);
      const { rows: hs } = await query(`SELECT COALESCE(leave_accrual, 'year') AS leave_accrual FROM hr_employees WHERE user_id = $1`, [uid]);
      const out = { access: lv, leave_accrual: hs[0] ? hs[0].leave_accrual : 'year', leave: (await leaveFor([uid], Number(today().slice(0, 4))))[uid] || null };
      const { rows: st } = await query(`SELECT key, value FROM warehouse_settings WHERE key IN ('payroll_module', 'payroll_vacation_days', 'payroll_sick_days')`);
      const s = Object.fromEntries(st.map((r) => [r.key, r.value]));
      out.module_on = s.payroll_module === 'on';
      out.shop_vacation_days = s.payroll_vacation_days != null ? Number(s.payroll_vacation_days) : 10; out.shop_sick_days = s.payroll_sick_days != null ? Number(s.payroll_sick_days) : 10;
      if (!lv.view) return res.json(out);
      const { rows: pe } = await query(`SELECT e.*, ${DATE('e.date_of_birth')} AS date_of_birth, ${DATE('e.hire_date')} AS hire_date, ${DATE('e.termination_date')} AS termination_date, ${DATE('e.tcc_expiry')} AS tcc_expiry,
          e.salary_annual::float, e.hourly_rate::float, e.day_rate::float, e.fee_per_period::float, e.ot_rate::float, e.hours_per_period::float, e.hours_per_day::float,
          e.pension_ee_pct::float, e.pension_er_pct::float, e.extra_threshold::float, e.vacation_days::float, e.sick_days::float FROM payroll_employees e WHERE e.user_id = $1`, [uid]);
      const e = pe[0] || null;
      if (e && !lv.run) { e.trn = mask(e.trn); e.nis_no = mask(e.nis_no); e.bank_account = mask(e.bank_account, 4); }
      out.employee = e;
      if (e) {
        out.items = (await query(`SELECT x.id, x.code, x.amount::float, x.balance::float, x.pct::float, x.note, x.payee, x.reference, ${DATE('x.end_date')} AS end_date, x.is_active, i.label, i.kind
          FROM payroll_employee_items x JOIN payroll_items i ON i.code = x.code WHERE x.employee_id = $1 ORDER BY x.is_active DESC, i.kind DESC, i.sort`, [e.id])).rows;
        out.ytd = await ytdFor(e.id, Number(today().slice(0, 4)));
      }
      out.catalogue = (await query(`SELECT code, label, kind FROM payroll_items WHERE is_active AND NOT is_system ORDER BY kind DESC, sort`)).rows;
      const { rows: rt } = await query(`SELECT nis_er::float, nht_er::float, ed_er::float, heart_er::float, nis_ee::float, nht_ee::float, ed_ee::float FROM payroll_rates WHERE effective_from <= CURRENT_DATE ORDER BY effective_from DESC LIMIT 1`);
      out.rates = rt[0] || null;
      res.json(out);
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------- transactions --
  // Payslips, year-to-date, the employee summary by pay item, leave taken
  // and loans, for a year.
  app.get('/api/people/staff/:id/transactions', ...P, async (req, res) => {
    try {
      const uid = n(req.params.id); await staffRow(uid);
      const lv = await level(req);
      const year = parseInt(req.query.year, 10) || Number(today().slice(0, 4));
      const out = { year, access: lv, leave: await leaveTaken(uid, year + '-01-01', year + '-12-31') };
      if (!lv.view) return res.json(out);
      const { rows: pe } = await query(`SELECT id FROM payroll_employees WHERE user_id = $1`, [uid]);
      if (!pe.length) return res.json(Object.assign(out, { on_payroll: false }));
      const pid = pe[0].id;
      out.on_payroll = true;
      out.years = (await query(`SELECT DISTINCT EXTRACT(YEAR FROM r.pay_date)::int AS y FROM payroll_slips s JOIN payroll_runs r ON r.id = s.run_id WHERE s.employee_id = $1 AND r.status IN ('approved', 'paid') ORDER BY 1 DESC`, [pid])).rows.map((r) => r.y);
      out.slips = await slipList(pid, 'AND EXTRACT(YEAR FROM r.pay_date) = $2', [year]);
      out.ytd = await ytdFor(pid, year);
      out.summary = (await query(`SELECT l->>'code' AS code, MAX(l->>'label') AS label, MAX(l->>'kind') AS kind, COALESCE(SUM(NULLIF(l->>'qty', '')::numeric), 0)::float AS qty, COALESCE(SUM(NULLIF(l->>'amount', '')::numeric), 0)::float AS amount
        FROM payroll_slips s JOIN payroll_runs r ON r.id = s.run_id, jsonb_array_elements(s.lines) l
        WHERE s.employee_id = $1 AND r.status IN ('approved', 'paid') AND EXTRACT(YEAR FROM r.pay_date) = $2 GROUP BY 1 ORDER BY MAX(l->>'kind') DESC, 1`, [pid, year])).rows;
      out.loans = (await query(`SELECT l.id, l.kind, l.amount::float, ${DATE('l.issue_date')} AS issue_date, l.method, l.reference, l.voided_at, x.balance::float AS balance
        FROM payroll_loans l LEFT JOIN payroll_employee_items x ON x.id = l.item_id WHERE l.employee_id = $1 ORDER BY l.issue_date DESC`, [pid])).rows;
      res.json(out);
    } catch (e) { fail(res, e); }
  });

  // ----------------------------------------------------- employee defaults --
  async function defaults() {
    const { rows } = await query(`SELECT value FROM warehouse_settings WHERE key = 'hr_employee_defaults'`);
    let saved = {};
    try { saved = rows.length ? JSON.parse(rows[0].value) || {} : {}; } catch (_) { saved = {}; }
    return Object.assign({}, DEFAULTS, saved, { payroll: Object.assign({}, DEFAULTS.payroll, saved.payroll || {}) });
  }
  app.get('/api/people/defaults', ...P, async (req, res) => {
    try {
      const { rows: catalogue } = await query(`SELECT code, label, kind FROM payroll_items WHERE is_active AND NOT is_system ORDER BY kind DESC, sort`);
      res.json({ defaults: await defaults(), access: await level(req), catalogue });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/people/defaults', ...P, async (req, res) => {
    try {
      const b = req.body || {}, cur = await defaults(), lv = await level(req);
      const v = {
        contract_type: one(b.contract_type, CONTRACTS, cur.contract_type), employee_type: one(b.employee_type, EMP_TYPES, cur.employee_type),
        probation_months: 'probation_months' in b ? Math.max(0, Math.min(12, parseInt(b.probation_months, 10) || 0)) : cur.probation_months,
        department_id: 'department_id' in b ? n(b.department_id) : cur.department_id, work_location: 'work_location' in b ? t(b.work_location, 80) : cur.work_location,
        parish: 'parish' in b ? t(b.parish, 40) : cur.parish, leave_accrual: one(b.leave_accrual, ['year', 'monthly'], cur.leave_accrual), onboarding: 'onboarding' in b ? !!b.onboarding : cur.onboarding,
        payroll: cur.payroll,
      };
      // The pay part: only someone who may change pay.
      if (b.payroll && lv.run) {
        const p = b.payroll, c = cur.payroll;
        const nn = (k, lo, hi) => (k in p ? (p[k] === '' || p[k] == null ? null : Math.max(lo, Math.min(hi, Number(p[k]) || 0))) : c[k]);
        const items = Array.isArray(p.items) ? p.items : c.items;
        const { rows: cat } = await query(`SELECT code FROM payroll_items WHERE is_active AND NOT is_system`);
        const ok = new Set(cat.map((r) => r.code));
        v.payroll = { add: 'add' in p ? !!p.add : c.add, pay_type: one(p.pay_type, ['salary', 'hourly', 'daily'], c.pay_type), frequency: one(p.frequency, ['weekly', 'fortnightly', 'monthly'], c.frequency),
          pay_method: one(p.pay_method, ['bank', 'cheque', 'cash'], c.pay_method), hours_per_day: nn('hours_per_day', 1, 24) || 8, ot_rate: nn('ot_rate', 1, 3) || 1.5, use_timeclock: 'use_timeclock' in p ? !!p.use_timeclock : c.use_timeclock,
          vacation_days: nn('vacation_days', 0, 60), sick_days: nn('sick_days', 0, 60), pension_ee_pct: nn('pension_ee_pct', 0, 100) || 0, pension_er_pct: nn('pension_er_pct', 0, 100) || 0,
          items: items.filter((x) => x && ok.has(x.code) && Number(x.amount) > 0).slice(0, 20).map((x) => ({ code: x.code, amount: Math.round(Number(x.amount) * 100) / 100 })) };
      } else if (b.payroll && JSON.stringify(b.payroll) !== JSON.stringify(cur.payroll) && !lv.run) {
        throw httpError(403, 'Only someone who may change pay can change the payroll defaults. Save without them, or ask them.');
      }
      await query(`INSERT INTO warehouse_settings (key, value) VALUES ('hr_employee_defaults', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(v)]);
      await audit({ entity: 'setting', action: 'employee defaults changed', by: me(req) });
      res.json({ ok: true, defaults: v });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------- new employee wizard --
  // Everything about a new starter in one go: the staff record (login off),
  // the HR file, an emergency contact, additional info, Payroll (pay off
  // unless switched on by someone who may) and the starter checklist.
  app.post('/api/people/new-employee', ...P, async (req, res) => {
    let uid = null;
    try {
      const b = req.body || {}, lv = await level(req), dft = await defaults();
      const ps = b.personal || {}, ct = b.contact || {}, em = b.employment || {}, pay = b.payroll || {}, ec = b.emergency || {};
      const name = t(ps.name, 120);
      if (!name || name.length < 3) throw httpError(400, 'Their full name');
      // Check everything before anything is saved.
      const start = d(em.start_date);
      if (!start) throw httpError(400, 'Their start date (the original hire date)');
      if (ec.name && !t(ec.phone, 40)) throw httpError(400, 'A phone number for the emergency contact');
      const wantPay = !!pay.add && lv.run;
      if (pay.add && !lv.run) throw httpError(403, 'Only someone who may change pay can put them on Payroll. Untick it, and ask them to add the pay.');
      const trn = t(pay.trn, 20), nis = t(pay.nis_no, 20) ? t(pay.nis_no, 20).toUpperCase().replace(/\s/g, '') : null;
      if (wantPay && trn && !TRN_RE.test(trn)) throw httpError(400, 'A TRN is nine digits (123-456-789)');
      if (wantPay && nis && !NIS_RE.test(nis)) throw httpError(400, 'An NIS number is a letter and six digits, as on the NIS card (A123456)');
      const payType = one(pay.pay_type, ['salary', 'hourly', 'daily'], dft.payroll.pay_type);
      const rate = { salary_annual: num(pay.salary_annual), hourly_rate: num(pay.hourly_rate), day_rate: num(pay.day_rate) };
      const payOn = wantPay && !!pay.pay_on;
      if (payOn && !((payType === 'salary' && rate.salary_annual > 0) || (payType === 'hourly' && rate.hourly_rate > 0) || (payType === 'daily' && rate.day_rate > 0)))
        throw httpError(400, 'Enter the ' + (payType === 'salary' ? 'yearly salary' : payType === 'hourly' ? 'hourly rate' : 'day rate') + ' to switch pay on, or leave pay off for now');
      const { rows: cat } = await query(`SELECT code FROM payroll_items WHERE is_active AND NOT is_system`);
      const okItem = new Set(cat.map((r) => r.code));
      const items = (Array.isArray(pay.items) ? pay.items : dft.payroll.items).filter((x) => x && okItem.has(x.code) && Number(x.amount) > 0).slice(0, 20);
      if (!b.confirm_duplicate) {
        const { rows: same } = await query(`SELECT id FROM users WHERE lower(trim(name)) = lower($1) AND (is_staff OR is_admin) AND NOT COALESCE(is_archived, false)`, [name]);
        if (same.length) throw Object.assign(httpError(409, 'Someone called ' + name + ' is already on the staff list. Add them anyway?'), { duplicate: same[0].id });
      }
      const { rows: fields } = await query(`SELECT * FROM hr_custom_fields WHERE is_active`);
      for (const f of fields) if (b.custom && String(f.id) in b.custom) fieldValue(f, b.custom[f.id]);

      try { uid = await newStaffUser(query, { name, email: ct.email, phone: ct.phone, employee_no: em.employee_no, note: 'Added with the New Employee wizard' }); }
      catch (e) { if (e.user_id) { e.publicMessage = e.message + '. Open their file instead.'; } throw e; }
      const months = 'probation_months' in em ? Math.max(0, Math.min(12, parseInt(em.probation_months, 10) || 0)) : dft.probation_months;
      let probEnd = null;
      if (months > 0) { const x = new Date(start + 'T12:00:00Z'); x.setUTCMonth(x.getUTCMonth() + months); probEnd = x.toISOString().slice(0, 10); }
      const manager = n(em.manager_user_id), dept = 'department_id' in em ? n(em.department_id) : dft.department_id;
      await query(`INSERT INTO hr_employees (user_id, salutation, legal_name, preferred_name, gender, date_of_birth, marital_status, mobile, personal_phone, personal_email, address, town, parish,
          job_title, department_id, manager_user_id, start_date, contract_type, contract_end, status, probation_months, probation_end, employee_type, work_location, job_description, leave_accrual, updated_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)`,
        [uid, one(ps.salutation, SALUTATIONS, null), t(ps.legal_name, 160), t(ps.preferred_name, 80), one(ps.gender, ['female', 'male', 'other'], null), d(ps.date_of_birth), one(ps.marital_status, MARITAL, null),
          t(ct.mobile, 40), t(ct.personal_phone, 40), t(ct.personal_email, 160), t(ct.address, 300), t(ct.town, 80), t(ct.parish, 40) || dft.parish,
          t(em.job_title, 120), dept, manager, start, one(em.contract_type, CONTRACTS, dft.contract_type), d(em.contract_end), months > 0 ? 'probation' : 'active', months, probEnd,
          one(em.employee_type, EMP_TYPES, dft.employee_type), t(em.work_location, 80) || dft.work_location, t(em.job_description, 4000), one(em.leave_accrual, ['year', 'monthly'], dft.leave_accrual), me(req)]);
      await query(`INSERT INTO hr_job_history (user_id, kind, effective_date, job_title, department_id, manager_user_id, salary_annual, hourly_rate, reason, applied_to_payroll, by_user) VALUES ($1, 'start', $2, $3, $4, $5, $6, $7, 'New Employee wizard', $8, $9)`,
        [uid, start, t(em.job_title, 120), dept, manager, wantPay ? rate.salary_annual : null, wantPay ? rate.hourly_rate : null, wantPay, me(req)]);
      if (ec.name) await query(`INSERT INTO hr_contacts (user_id, name, relationship, phone, alt_phone, is_primary) VALUES ($1,$2,$3,$4,$5,true)`, [uid, t(ec.name, 120), t(ec.relationship, 60), t(ec.phone, 40), t(ec.alt_phone, 40)]);
      let payrollId = null;
      if (wantPay) {
        const pd = dft.payroll;
        const { rows } = await query(`INSERT INTO payroll_employees (user_id, employee_no, name, email, phone, address, trn, nis_no, date_of_birth, hire_date, job_title, department, pay_type, frequency, salary_annual, hourly_rate, day_rate,
            pay_method, bank_name, bank_branch, bank_account, bank_account_type, hours_per_day, ot_rate, use_timeclock, vacation_days, sick_days, pension_ee_pct, pension_er_pct, is_active, notes, updated_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,(SELECT name FROM departments WHERE id = $12),$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32) RETURNING id`,
          [uid, t(em.employee_no, 30), name, ct.email && !/\.local$/i.test(ct.email) ? t(ct.email, 160) : null, t(ct.phone, 40), t(ct.address, 300), trn, nis, d(ps.date_of_birth), start, t(em.job_title, 120), dept,
            payType, one(pay.frequency, ['weekly', 'fortnightly', 'monthly'], pd.frequency), rate.salary_annual, rate.hourly_rate, rate.day_rate, one(pay.pay_method, ['bank', 'cheque', 'cash'], pd.pay_method),
            t(pay.bank_name, 120), t(pay.bank_branch, 120), t(pay.bank_account, 40), t(pay.bank_account_type, 40), pd.hours_per_day || 8, pd.ot_rate || 1.5, pd.use_timeclock !== false,
            'vacation_days' in pay && pay.vacation_days !== '' ? num(pay.vacation_days) : pd.vacation_days, 'sick_days' in pay && pay.sick_days !== '' ? num(pay.sick_days) : pd.sick_days,
            pd.pension_ee_pct || 0, pd.pension_er_pct || 0, payOn, payOn ? null : 'From the New Employee wizard: switch pay on from the start date.', me(req)]);
        payrollId = rows[0].id;
        for (const x of items) await query(`INSERT INTO payroll_employee_items (employee_id, code, amount, note, created_by) VALUES ($1,$2,$3,'From the employee defaults',$4)`, [payrollId, x.code, Math.round(Number(x.amount) * 100) / 100, me(req)]);
      }
      if (b.custom) await saveCustom(uid, b.custom, me(req));
      const onboard = 'onboarding' in b ? !!b.onboarding : dft.onboarding;
      if (onboard) await addTasks(uid, 'onboarding', ONBOARDING, { due_on: start, assignee_id: manager || me(req) });
      await audit({ user_id: uid, entity: 'profile', action: 'staff member added (New Employee wizard)', by: me(req),
        detail: [name, t(em.job_title, 120), 'starts ' + start, payrollId ? 'on Payroll, pay ' + (payOn ? 'on' : 'off') : 'not on Payroll', onboard ? 'starter checklist added' : null].filter(Boolean).join(' · ') });
      res.json({ id: uid, payroll_id: payrollId, pay_on: payOn, next: 'Their login is switched off. A manager sets the role, password or PIN on Users & Staff when they need one.' + (payrollId && !payOn ? ' Pay is off in Payroll until switched on.' : '') });
    } catch (e) {
      // Not all saved: take back the staff record just made (nothing else points to it yet).
      if (uid) await query(`DELETE FROM users WHERE id = $1`, [uid]).catch(() => {});
      if (e.duplicate) return res.status(409).json({ error: e.publicMessage, duplicate: e.duplicate });
      fail(res, e);
    }
  });

  // ------------------------------------ inactive, release and rehire --
  async function stateOf(uid) {
    const { rows } = await query(`SELECT * FROM (${CENTRE_SQL}) x WHERE x.id = $1`, [uid]);
    if (!rows.length) throw httpError(404, 'Staff member not found');
    return rows[0];
  }
  app.post('/api/people/staff/:id/inactive', ...P, async (req, res) => {
    try {
      const uid = n(req.params.id); await staffRow(uid); await ensureFile(uid); const b = req.body || {};
      const s = await stateOf(uid);
      if (s.state === 'released') throw httpError(409, 'They have been released. Rehire them instead.');
      const off = b.inactive !== false;
      await query(`UPDATE hr_employees SET inactive = $2, inactive_reason = $3, updated_by = $4, updated_at = NOW() WHERE user_id = $1`, [uid, off, off ? t(b.reason, 300) : null, me(req)]);
      await audit({ user_id: uid, entity: 'profile', action: off ? 'made inactive' : 'made active again', detail: off ? t(b.reason, 300) : null, by: me(req) });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  // Release: the last day worked. Payroll pays up to that day and no further
  // (its termination date); the login is archived from the page, by choice.
  app.post('/api/people/staff/:id/release', ...P, async (req, res) => {
    try {
      const uid = n(req.params.id); await staffRow(uid); await ensureFile(uid); const b = req.body || {};
      const on = d(b.release_date);
      if (!on) throw httpError(400, 'Their release date (the last day they worked)');
      const reason = t(b.reason, 300);
      if (!reason) throw httpError(400, 'Why they are leaving (for example: resigned, end of contract)');
      const s = await stateOf(uid);
      if (s.state === 'released' && s.release_date && s.status === 'left') throw httpError(409, 'They were already released on ' + s.release_date);
      const rehire = b.rehire_eligible == null || b.rehire_eligible === '' ? null : !!b.rehire_eligible;
      await query(`UPDATE hr_employees SET release_date = $2, release_reason = $3, rehire_eligible = $4, status = CASE WHEN $2::date <= $6::date THEN 'left' ELSE 'notice' END, inactive = false, updated_by = $5, updated_at = NOW() WHERE user_id = $1`,
        [uid, on, reason, rehire, me(req), today()]);
      // An exit in progress ends with it.
      await query(`UPDATE hr_exits SET last_day = $2, rehire = COALESCE($3, rehire), status = CASE WHEN $2::date <= $5::date THEN 'done' ELSE status END, completed_by = CASE WHEN $2::date <= $5::date THEN $4 ELSE completed_by END,
          completed_at = CASE WHEN $2::date <= $5::date THEN NOW() ELSE completed_at END WHERE user_id = $1 AND status = 'open'`, [uid, on, rehire, me(req), today()]);
      let payroll = 'not on Payroll';
      if (s.payroll_id) {
        if (await userCan(req, 'payroll.run')) {
          await query(`UPDATE payroll_employees SET termination_date = $2, termination_reason = $3, updated_by = $4, updated_at = NOW() WHERE id = $1`, [s.payroll_id, on, reason, me(req)]);
          payroll = 'Payroll pays up to ' + on;
        } else {
          await addTasks(uid, 'offboarding', [['Payroll: set the termination date to ' + on + ' and work out the final pay', '/payroll.html']], { due_on: on });
          payroll = 'someone who runs Payroll is to set the termination date (a checklist item was added)';
        }
      }
      await audit({ user_id: uid, entity: 'exit', action: 'released', detail: ['last day ' + on, reason, rehire == null ? null : 'eligible for rehire: ' + (rehire ? 'yes' : 'no'), payroll].filter(Boolean).join(' · '), by: me(req) });
      res.json({ ok: true, payroll, login_archived: s.is_archived });
    } catch (e) { fail(res, e); }
  });
  // Rehire: back on the active list from a new start. The original hire date
  // stays; service counts from the rehire date unless it is continued.
  app.post('/api/people/staff/:id/rehire', ...P, async (req, res) => {
    try {
      const uid = n(req.params.id); await staffRow(uid); await ensureFile(uid); const b = req.body || {};
      const on = d(b.rehire_date);
      if (!on) throw httpError(400, 'The date they start again');
      const s = await stateOf(uid);
      if (s.state !== 'released' && s.status !== 'left') throw httpError(409, 'They are not released');
      if (s.rehire_eligible === false && !t(b.override_reason, 300)) throw Object.assign(httpError(409, 'Their file says they are not eligible for rehire. Give the reason to go ahead.'), { needs_override: true });
      const months = 'probation_months' in b ? Math.max(0, Math.min(12, parseInt(b.probation_months, 10) || 0)) : 0;
      let probEnd = null;
      if (months > 0) { const x = new Date(on + 'T12:00:00Z'); x.setUTCMonth(x.getUTCMonth() + months); probEnd = x.toISOString().slice(0, 10); }
      const restart = b.service !== 'continue';
      const job = { title: t(b.job_title, 120), dept: n(b.department_id), manager: n(b.manager_user_id) };
      if (job.manager === uid) throw httpError(400, 'Someone cannot be their own manager');
      await query(`UPDATE hr_employees SET release_date = NULL, release_reason = NULL, inactive = false, inactive_reason = NULL, status = $2, probation_months = $3, probation_end = $4,
          confirmed_on = CASE WHEN $3 > 0 THEN NULL ELSE confirmed_on END, adjusted_service_date = CASE WHEN $5 THEN $6::date ELSE adjusted_service_date END,
          job_title = COALESCE($7, job_title), department_id = COALESCE($8, department_id), manager_user_id = COALESCE($9, manager_user_id), contract_type = COALESCE($10, contract_type), updated_by = $11, updated_at = NOW() WHERE user_id = $1`,
        [uid, months > 0 ? 'probation' : 'active', months, probEnd, restart, on, job.title, job.dept, job.manager, one(b.contract_type, CONTRACTS, null), me(req)]);
      await query(`INSERT INTO hr_job_history (user_id, kind, effective_date, job_title, department_id, manager_user_id, reason, by_user) VALUES ($1, 'rehire', $2, $3, $4, $5, $6, $7)`,
        [uid, on, job.title || s.job_title, job.dept || s.department_id, job.manager || s.manager_user_id, [restart ? 'Service counted from this date' : 'Service continued from before', t(b.override_reason, 300) ? 'not marked for rehire: ' + t(b.override_reason, 300) : null, t(b.reason, 300)].filter(Boolean).join(' · '), me(req)]);
      let payroll = 'not on Payroll';
      if (s.payroll_id) {
        if (await userCan(req, 'payroll.run')) {
          // Pay starts from the rehire date; it stays off until switched on.
          await query(`UPDATE payroll_employees SET termination_date = NULL, termination_reason = NULL, hire_date = $2, is_active = false, updated_by = $3, updated_at = NOW() WHERE id = $1`, [s.payroll_id, on, me(req)]);
          payroll = 'Payroll: pay from ' + on + ', switched off until someone switches it on';
        } else {
          await addTasks(uid, 'onboarding', [['Payroll: clear the termination date, set the hire date to ' + on + ', and switch pay on', '/payroll.html']], { due_on: on });
          payroll = 'someone who runs Payroll is to start their pay again (a checklist item was added)';
        }
      }
      if (b.onboarding) await addTasks(uid, 'onboarding', ONBOARDING, { due_on: on, assignee_id: job.manager || s.manager_user_id || me(req) });
      await audit({ user_id: uid, entity: 'hire', action: 'rehired', detail: ['from ' + on, restart ? 'service from ' + on : 'service continued', payroll].join(' · '), by: me(req) });
      res.json({ ok: true, payroll, login_archived: s.is_archived });
    } catch (e) { if (e.needs_override) return res.status(409).json({ error: e.publicMessage, needs_override: true }); fail(res, e); }
  });

  // ------------------------------------------------------------- lists --
  function nextDay(md, from) {
    // The next time a month-day comes round, on or after `from`. 29 Feb is kept on 28 Feb.
    const [y] = from.split('-').map(Number);
    for (const yy of [y, y + 1]) {
      let s = yy + '-' + md;
      if (md === '02-29' && !((yy % 4 === 0 && yy % 100 !== 0) || yy % 400 === 0)) s = yy + '-02-28';
      if (s >= from) return { date: s, year: yy };
    }
    return null;
  }
  app.get('/api/people/lists/:name', ...P, async (req, res) => {
    try {
      const name = req.params.name, lv = await level(req);
      const state = one(req.query.state, STATES, 'active');
      const year = parseInt(req.query.year, 10) || Number(today().slice(0, 4));
      const people = await centreRows(req, state === 'all' ? null : 'x.state = $1', state === 'all' ? [] : [state]);
      const ids = people.map((p) => p.id);
      if (name === 'contacts') {
        const { rows: ec } = await query(`SELECT DISTINCT ON (user_id) user_id, name, relationship, phone FROM hr_contacts WHERE user_id = ANY($1::int[]) ORDER BY user_id, is_primary DESC, id`, [ids]);
        const by = Object.fromEntries(ec.map((c) => [c.user_id, c]));
        return res.json({ name, state, rows: people.map((p) => Object.assign(p, { emergency: by[p.id] || null })) });
      }
      if (name === 'details') {
        const { rows: fields } = await query(`SELECT id, label FROM hr_custom_fields WHERE is_active ORDER BY sort, id`);
        return res.json({ name, state, rows: people, fields, access: lv });
      }
      if (name === 'withholding') {
        if (!lv.view) throw httpError(403, 'The withholding list shows pay: it needs the Payroll permission to see pay');
        const { rows } = await query(`SELECT e.user_id, e.paye_exempt, e.nis_exempt, e.nht_exempt, e.ed_exempt, e.extra_threshold::float, e.pension_ee_pct::float, e.pension_scheme, e.worker_type,
            ${YTD_COLS.map((k) => `COALESCE((SELECT SUM(s.${k}) FROM payroll_slips s JOIN payroll_runs r ON r.id = s.run_id WHERE s.employee_id = e.id AND r.status IN ('approved', 'paid') AND EXTRACT(YEAR FROM r.pay_date) = $2), 0)::float AS ${k}`).join(', ')}
          FROM payroll_employees e WHERE e.user_id = ANY($1::int[])`, [ids, year]);
        const by = Object.fromEntries(rows.map((r) => [r.user_id, r]));
        return res.json({ name, state, year, access: lv, rows: people.filter((p) => p.payroll_id).map((p) => Object.assign(p, { tax: by[p.id] || null })), not_on_payroll: people.filter((p) => !p.payroll_id).map((p) => ({ id: p.id, name: p.name })) });
      }
      if (name === 'pto') {
        const bal = await leaveFor(ids, year);
        return res.json({ name, state, year, rows: people.map((p) => Object.assign({ id: p.id, name: p.name, department: p.department, leave_accrual: p.leave_accrual }, bal[p.id] || {})) });
      }
      if (name === 'birthdays') {
        const days = Math.max(1, Math.min(366, parseInt(req.query.days, 10) || 60));
        const from = today(), until = new Date(Date.parse(from + 'T12:00:00Z') + days * 86400000).toISOString().slice(0, 10);
        const out = [];
        for (const p of people) {
          if (p.date_of_birth) {
            const x = nextDay(p.date_of_birth.slice(5), from);
            if (x && x.date <= until) out.push({ id: p.id, name: p.name, department: p.department, kind: 'birthday', date: x.date, years: x.year - Number(p.date_of_birth.slice(0, 4)) });
          }
          const since = p.adjusted_service_date || p.start_date;
          if (since) {
            const x = nextDay(since.slice(5), from);
            const yrs = x ? x.year - Number(since.slice(0, 4)) : 0;
            if (x && yrs > 0 && x.date <= until) out.push({ id: p.id, name: p.name, department: p.department, kind: 'anniversary', date: x.date, years: yrs, since });
          }
        }
        out.sort((a, b2) => (a.date < b2.date ? -1 : a.date > b2.date ? 1 : a.name.localeCompare(b2.name)));
        return res.json({ name, state, days, from, until, rows: out });
      }
      throw httpError(404, 'No such list');
    } catch (e) { fail(res, e); }
  });

  return { remind };
}

module.exports = { register };
