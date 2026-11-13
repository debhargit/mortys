// =============================================================================
//  Vision Auto Solutions -- People & HR (the staff file)
//
//  Mounted by server.js:  const hr = require('./hr').register(app, deps)
//  Screen: people.html. Staff: /api/people/* (cap hr.people). Each person's
//  own file: /api/people/me (any signed-in staff member).
//
//  What lives here: personal details and emergency contacts; the job (title,
//  department, manager, start date, contract type, probation); every
//  promotion, transfer and pay change; warnings, discipline and
//  commendations; reviews and goals; days added to or taken off the leave
//  allowance; exits with an offboarding checklist; onboarding checklists; an
//  org chart; HR reports; and an audit of every change (hr_audit).
//
//  What does not, and is linked instead: pay and payslips (Payroll,
//  payroll_employees -- a pay change can be passed on to it), leave days
//  taken (Attendance > Leave, staff_leave), training (Training), papers
//  (Document centre, linked to the "staff" record), the login itself
//  (Users & Staff -- archive is done there).
//
//  Hiring (careers.js) calls onHire() to open the file for a new starter.
// =============================================================================
'use strict';

const CONTRACTS = ['permanent', 'fixed_term', 'part_time', 'casual', 'contractor', 'intern'];
const STATUSES = ['probation', 'active', 'notice', 'left'];
// As in the QuickBooks employee list: officers and owners are paid differently.
const EMP_TYPES = ['regular', 'officer', 'owner', 'statutory'];
const JOB_KINDS = ['start', 'promotion', 'transfer', 'pay_change', 'title_change', 'confirmation', 'demotion', 'rehire', 'other'];
const SALUTATIONS = ['Mr', 'Mrs', 'Ms', 'Miss', 'Dr'];
const MARITAL = ['single', 'married', 'common_law', 'divorced', 'widowed'];
const CASE_KINDS = ['counselling', 'verbal_warning', 'written_warning', 'final_warning', 'suspension', 'dismissal', 'commendation'];
const CASE_LABEL = { counselling: 'Counselling', verbal_warning: 'Verbal warning', written_warning: 'Written warning', final_warning: 'Final written warning', suspension: 'Suspension', dismissal: 'Dismissal', commendation: 'Commendation' };
const EXIT_KINDS = ['resignation', 'termination', 'redundancy', 'end_of_contract', 'retirement', 'other'];
const REVIEW_KINDS = ['probation', 'annual', 'midyear', 'other'];
// What a review scores, 1 (poor) to 5 (excellent). Kept on each review as it was.
const REVIEW_CRITERIA = [
  { key: 'job_knowledge', label: 'Knows the job and the parts' },
  { key: 'quality', label: 'Quality and accuracy of work' },
  { key: 'customer', label: 'Customer service' },
  { key: 'reliability', label: 'Reliability and time-keeping' },
  { key: 'teamwork', label: 'Teamwork and attitude' },
  { key: 'initiative', label: 'Initiative and problem solving' },
];
// A new starter's checklist. link: the screen where it is done.
const ONBOARDING = [
  ['Signed contract or offer letter filed in the Document centre', '/documents.html'],
  ['Copies of TRN, NIS card and photo ID filed', '/documents.html'],
  ['Set their role, password and till PIN, and switch the login on', '/admin.html#tab=staff'],
  ['Add them to Payroll with bank details; switch pay on from the start date', '/payroll.html'],
  ['Set their shifts', '/attendance.html#staff'],
  ['Emergency contact recorded', null],
  ['Uniform, keys and tools handed over', null],
  ['Induction: fire exits, health and safety, the shop rules', null],
  ['Assign the training lessons for their role', '/training.html#people'],
  ['Introduce them to the team', null],
  ['Book the end-of-probation review', null],
];
const OFFBOARDING = [
  ['Resignation or termination letter filed', '/documents.html'],
  ['Exit interview held', null],
  ['Keys, uniform, tools, phone and badge returned', null],
  ['Final pay worked out: last days, vacation not taken, deductions', '/payroll.html'],
  ['Loans or advances still owed settled', '/payroll.html'],
  ['Archive their login on the last day (signs them out, removes the PIN)', '/admin.html#tab=staff'],
  ['Take them off shifts', '/attendance.html#staff'],
  ['Letter of employment / reference given if asked', null],
];

function register(app, deps) {
  const { query, requireAdmin, requireCap, userCan } = deps;
  const can = (k) => [requireAdmin, requireCap(k)];
  const P = can('hr.people');
  const me = (req) => req.session.userId;
  function httpError(status, msg) { const e = new Error(msg); e.status = status; e.publicMessage = msg; return e; }
  function fail(res, e) { const s = e.status || 500; if (s >= 500) console.error('[hr]', e); res.status(s).json({ error: e.publicMessage || e.message }); }
  const t = (v, m) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, m));
  const d = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
  const n = (v) => { const x = parseInt(v, 10); return Number.isFinite(x) && x > 0 ? x : null; };
  const money = (v) => { if (v == null || v === '') return null; const x = Number(String(v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(x) && x >= 0 ? Math.round(x * 100) / 100 : null; };
  const one = (v, list, dflt) => (list.includes(v) ? v : dflt);
  const today = () => new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10);   // Jamaica (no daylight saving)
  const DATE = (c) => `to_char(${c}, 'YYYY-MM-DD')`;

  async function audit(o, q = query) {
    await q(`INSERT INTO hr_audit (user_id, application_id, entity, entity_id, action, detail, by_user) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [o.user_id || null, o.application_id || null, o.entity, o.entity_id || null, o.action, o.detail ? String(o.detail).slice(0, 2000) : null, o.by || null]);
  }
  async function staffRow(id) {
    const { rows } = await query(`SELECT id, name, email, phone, employee_no, admin_role, is_staff, is_admin, disabled, is_archived, ${DATE('left_on')} AS left_on, archive_reason
      FROM users WHERE id = $1 AND (is_staff OR is_admin OR archived_at IS NOT NULL)`, [id]);
    if (!rows.length) throw httpError(404, 'Staff member not found');
    return rows[0];
  }
  // The file exists from the first time it is opened or saved.
  async function ensureFile(uid) {
    await query(`INSERT INTO hr_employees (user_id, job_title, start_date, date_of_birth, address)
      SELECT $1, p.job_title, p.hire_date, p.date_of_birth, p.address FROM (SELECT 1) x LEFT JOIN payroll_employees p ON p.user_id = $1
      ON CONFLICT (user_id) DO NOTHING`, [uid]);
  }

  // ---------------------------------------------------------- the list --
  const LIST_SQL = `SELECT u.id, COALESCE(NULLIF(u.name, ''), u.email) AS name, u.email, u.phone, u.employee_no, u.admin_role, u.disabled, u.is_archived, ${DATE('u.left_on')} AS left_on,
      h.job_title, h.department_id, dp.name AS department, h.manager_user_id, COALESCE(NULLIF(m.name, ''), m.email) AS manager,
      ${DATE('COALESCE(h.start_date, p.hire_date)')} AS start_date, COALESCE(h.contract_type, 'permanent') AS contract_type, ${DATE('h.contract_end')} AS contract_end,
      CASE WHEN u.is_archived THEN 'left' ELSE COALESCE(h.status, 'active') END AS status, ${DATE('h.probation_end')} AS probation_end,
      (h.user_id IS NOT NULL) AS has_file, p.id AS payroll_id,
      (SELECT COUNT(*)::int FROM hr_cases c WHERE c.user_id = u.id AND c.status = 'open' AND c.kind <> 'commendation' AND (c.expires_on IS NULL OR c.expires_on >= CURRENT_DATE)) AS open_cases,
      (SELECT COUNT(*)::int FROM hr_tasks k WHERE k.user_id = u.id AND k.done_at IS NULL) AS open_tasks,
      (SELECT COUNT(*)::int FROM hr_contacts c WHERE c.user_id = u.id) AS contacts,
      (SELECT ${DATE('MIN(r.due_on)')} FROM hr_reviews r WHERE r.user_id = u.id AND r.status = 'draft') AS review_due
    FROM users u LEFT JOIN hr_employees h ON h.user_id = u.id LEFT JOIN departments dp ON dp.id = h.department_id
      LEFT JOIN users m ON m.id = h.manager_user_id LEFT JOIN payroll_employees p ON p.user_id = u.id`;
  app.get('/api/people/staff', ...P, async (req, res) => {
    try {
      const all = req.query.all === '1';
      const { rows } = await query(`${LIST_SQL} WHERE ${all ? '(u.is_staff OR u.is_admin OR u.archived_at IS NOT NULL)' : '(u.is_staff OR u.is_admin) AND NOT COALESCE(u.is_archived, false)'}
        ORDER BY u.is_archived NULLS FIRST, name`);
      res.json({ staff: rows });
    } catch (e) { fail(res, e); }
  });
  // Pickers: departments, people (for manager, reviewer, assignee), settings.
  app.get('/api/people/meta', ...P, async (req, res) => {
    try {
      const { rows: depts } = await query(`SELECT id, name FROM departments WHERE is_active ORDER BY name`);
      const { rows: people } = await query(`SELECT id, COALESCE(NULLIF(name, ''), email) AS name FROM users WHERE (is_staff OR is_admin) AND NOT COALESCE(is_archived, false) AND NOT COALESCE(disabled, false) ORDER BY 2`);
      res.json({ departments: depts, people, criteria: REVIEW_CRITERIA, case_labels: CASE_LABEL,
        can_payroll: await userCan(req, 'payroll.run'), can_archive: await userCan(req, 'hr.people') });
    } catch (e) { fail(res, e); }
  });

  // ---------------------------------------------------------- one file --
  async function fileFor(uid, opts) {
    const u = await staffRow(uid);
    const { rows: h } = await query(`SELECT h.*, ${DATE('h.start_date')} AS start_date, ${DATE('h.contract_end')} AS contract_end, ${DATE('h.probation_end')} AS probation_end,
        ${DATE('h.confirmed_on')} AS confirmed_on, ${DATE('h.date_of_birth')} AS date_of_birth, ${DATE('h.release_date')} AS release_date, ${DATE('h.adjusted_service_date')} AS adjusted_service_date, dp.name AS department, COALESCE(NULLIF(m.name, ''), m.email) AS manager
      FROM hr_employees h LEFT JOIN departments dp ON dp.id = h.department_id LEFT JOIN users m ON m.id = h.manager_user_id WHERE h.user_id = $1`, [uid]);
    // The photo is fetched on its own (/photo).
    if (h[0]) { h[0].has_photo = !!h[0].photo; delete h[0].photo; }
    const { rows: pay } = await query(`SELECT id, employee_no, pay_type, frequency, salary_annual::float, hourly_rate::float, is_active, ${DATE('hire_date')} AS hire_date, department, job_title,
        vacation_days::float, sick_days::float FROM payroll_employees WHERE user_id = $1`, [uid]);
    const { rows: contacts } = await query(`SELECT * FROM hr_contacts WHERE user_id = $1 ORDER BY is_primary DESC, id`, [uid]);
    const out = { user: u, profile: h[0] || null, payroll: pay[0] || null, contacts, leave: await leaveFor([uid], new Date().getFullYear()).then((m) => m[uid] || null) };
    const { rows: goals } = await query(`SELECT g.*, ${DATE('g.due_on')} AS due_on FROM hr_goals g WHERE g.user_id = $1 ORDER BY (g.status = 'open') DESC, g.due_on NULLS LAST, g.id`, [uid]);
    const { rows: reviews } = await query(`SELECT r.*, ${DATE('r.period_from')} AS period_from, ${DATE('r.period_to')} AS period_to, ${DATE('r.due_on')} AS due_on, COALESCE(NULLIF(v.name, ''), v.email) AS reviewer
      FROM hr_reviews r LEFT JOIN users v ON v.id = r.reviewer_id WHERE r.user_id = $1 ${opts.self ? "AND r.status <> 'draft'" : ''} ORDER BY COALESCE(r.due_on, r.created_at::date) DESC`, [uid]);
    const { rows: cases } = await query(`SELECT c.*, ${DATE('c.incident_date')} AS incident_date, ${DATE('c.expires_on')} AS expires_on, COALESCE(NULLIF(b.name, ''), b.email) AS issued_by_name, dc.number AS document_number
      FROM hr_cases c LEFT JOIN users b ON b.id = c.issued_by LEFT JOIN documents dc ON dc.id = c.document_id WHERE c.user_id = $1 ORDER BY COALESCE(c.incident_date, c.created_at::date) DESC, c.id DESC`, [uid]);
    Object.assign(out, { goals, reviews, cases });
    if (opts.self) {
      const { rows: tasks } = await query(`SELECT id, title, link, ${DATE('due_on')} AS due_on, done_at, kind FROM hr_tasks WHERE assignee_id = $1 AND done_at IS NULL ORDER BY due_on NULLS LAST, id`, [uid]);
      out.my_tasks = tasks;
      return out;
    }
    const { rows: history } = await query(`SELECT j.*, ${DATE('j.effective_date')} AS effective_date, j.salary_annual::float, j.hourly_rate::float, dp.name AS department, COALESCE(NULLIF(m.name, ''), m.email) AS manager, COALESCE(NULLIF(b.name, ''), b.email) AS by_name
      FROM hr_job_history j LEFT JOIN departments dp ON dp.id = j.department_id LEFT JOIN users m ON m.id = j.manager_user_id LEFT JOIN users b ON b.id = j.by_user
      WHERE j.user_id = $1 ORDER BY j.effective_date DESC, j.id DESC`, [uid]);
    const { rows: adj } = await query(`SELECT a.*, a.days::float, COALESCE(NULLIF(b.name, ''), b.email) AS by_name FROM hr_leave_adjustments a LEFT JOIN users b ON b.id = a.by_user WHERE a.user_id = $1 ORDER BY a.year DESC, a.id DESC`, [uid]);
    const { rows: exits } = await query(`SELECT x.*, ${DATE('x.notice_date')} AS notice_date, ${DATE('x.last_day')} AS last_day FROM hr_exits x WHERE x.user_id = $1 ORDER BY x.id DESC`, [uid]);
    const { rows: tasks } = await query(`SELECT k.*, ${DATE('k.due_on')} AS due_on, COALESCE(NULLIF(a.name, ''), a.email) AS assignee, COALESCE(NULLIF(b.name, ''), b.email) AS done_by_name
      FROM hr_tasks k LEFT JOIN users a ON a.id = k.assignee_id LEFT JOIN users b ON b.id = k.done_by WHERE k.user_id = $1 ORDER BY k.kind, k.done_at IS NOT NULL, k.sort, k.id`, [uid]);
    const { rows: log } = await query(`SELECT a.at, a.entity, a.action, a.detail, COALESCE(NULLIF(b.name, ''), b.email) AS by_name FROM hr_audit a LEFT JOIN users b ON b.id = a.by_user WHERE a.user_id = $1 ORDER BY a.at DESC LIMIT 200`, [uid]);
    const { rows: apps } = await query(`SELECT a.id, a.ref, j.title FROM job_applications a LEFT JOIN job_posts j ON j.id = a.job_id WHERE a.hired_user_id = $1`, [uid]);
    const { rows: train } = await query(`SELECT COUNT(*)::int AS records, COUNT(*) FILTER (WHERE expires_on IS NOT NULL AND expires_on < CURRENT_DATE + 30)::int AS expiring FROM training_records WHERE user_id = $1`, [uid]).catch(() => ({ rows: [{}] }));
    return Object.assign(out, { history, leave_adjustments: adj, exits, tasks, log, applications: apps, training: train[0] });
  }
  app.get('/api/people/staff/:id', ...P, async (req, res) => {
    try { res.json(await fileFor(n(req.params.id), {})); } catch (e) { fail(res, e); }
  });

  const PROFILE_TEXT = { job_title: 120, work_location: 80, personal_email: 160, personal_phone: 40, mobile: 40, address: 300, parish: 40, notes: 4000,
    legal_name: 160, preferred_name: 80, town: 80, job_description: 4000, release_reason: 300 };
  app.put('/api/people/staff/:id/profile', ...P, async (req, res) => {
    try {
      const uid = n(req.params.id); const u = await staffRow(uid); await ensureFile(uid);
      const b = req.body || {};
      const { rows: cur } = await query(`SELECT * FROM hr_employees WHERE user_id = $1`, [uid]);
      delete cur[0].photo;
      const c = cur[0], v = {};
      for (const k of Object.keys(PROFILE_TEXT)) v[k] = k in b ? t(b[k], PROFILE_TEXT[k]) : c[k];
      for (const k of ['start_date', 'contract_end', 'probation_end', 'date_of_birth', 'release_date', 'adjusted_service_date']) v[k] = k in b ? d(b[k]) : c[k];
      v.department_id = 'department_id' in b ? n(b.department_id) : c.department_id;
      v.manager_user_id = 'manager_user_id' in b ? n(b.manager_user_id) : c.manager_user_id;
      if (v.manager_user_id === uid) throw httpError(400, 'Someone cannot be their own manager');
      v.contract_type = 'contract_type' in b ? one(b.contract_type, CONTRACTS, 'permanent') : c.contract_type;
      v.status = 'status' in b ? one(b.status, STATUSES, c.status) : c.status;
      v.gender = 'gender' in b ? one(b.gender, ['female', 'male', 'other'], null) : c.gender;
      v.employee_type = 'employee_type' in b ? one(b.employee_type, EMP_TYPES, 'regular') : c.employee_type;
      v.salutation = 'salutation' in b ? one(b.salutation, SALUTATIONS, null) : c.salutation;
      v.marital_status = 'marital_status' in b ? one(b.marital_status, MARITAL, null) : c.marital_status;
      v.leave_accrual = 'leave_accrual' in b ? one(b.leave_accrual, ['year', 'monthly'], 'year') : c.leave_accrual;
      v.rehire_eligible = 'rehire_eligible' in b ? (b.rehire_eligible == null || b.rehire_eligible === '' ? null : b.rehire_eligible === true || b.rehire_eligible === 'yes') : c.rehire_eligible;
      v.probation_months = 'probation_months' in b ? Math.max(0, Math.min(12, parseInt(b.probation_months, 10) || 0)) : c.probation_months;
      // Probation end follows the start date unless it was typed in.
      if (!('probation_end' in b) && v.start_date && (!c.probation_end || 'start_date' in b || 'probation_months' in b) && v.status === 'probation') {
        const x = new Date(v.start_date + 'T12:00:00Z'); x.setUTCMonth(x.getUTCMonth() + v.probation_months); v.probation_end = x.toISOString().slice(0, 10);
      }
      if (v.manager_user_id) {
        // No loops in the org chart: walk up from the new manager.
        let at = v.manager_user_id, hops = 0;
        while (at && hops++ < 50) {
          if (at === uid) throw httpError(400, 'That would make a loop: ' + 'the manager reports to this person');
          const { rows } = await query(`SELECT manager_user_id FROM hr_employees WHERE user_id = $1`, [at]);
          at = rows[0] && rows[0].manager_user_id;
        }
      }
      const cols = Object.keys(v);
      const changed = cols.filter((k) => String(c[k] instanceof Date ? c[k].toISOString().slice(0, 10) : c[k] == null ? '' : c[k]) !== String(v[k] == null ? '' : v[k]));
      await query(`UPDATE hr_employees SET ${cols.map((k, i) => k + ' = $' + (i + 2)).join(', ')}, updated_by = $${cols.length + 2}, updated_at = NOW() WHERE user_id = $1`,
        [uid].concat(cols.map((k) => v[k]), [me(req)]));
      // Payroll keeps its own copy of these three for the payslip: keep it in step.
      if (changed.some((k) => ['job_title', 'department_id', 'start_date'].includes(k))) {
        await query(`UPDATE payroll_employees SET job_title = $2, department = COALESCE((SELECT name FROM departments WHERE id = $3), department), hire_date = COALESCE($4::date, hire_date), updated_at = NOW() WHERE user_id = $1`,
          [uid, v.job_title, v.department_id, v.start_date]);
      }
      // The name is the staff record's (Users & Staff); Payroll's copy follows when it was the same.
      const name = 'name' in b ? t(b.name, 120) : null;
      if (name && name !== u.name) {
        if (name.length < 3) throw httpError(400, 'Their full name');
        await query(`UPDATE users SET name = $2 WHERE id = $1`, [uid, name]);
        await query(`UPDATE payroll_employees SET name = $2, updated_at = NOW() WHERE user_id = $1 AND name = $3`, [uid, name, u.name || '']);
        changed.push('name');
      }
      if (changed.length) await audit({ user_id: uid, entity: 'profile', action: 'updated', detail: 'Changed: ' + changed.join(', ').replace(/_/g, ' '), by: me(req) });
      res.json({ ok: true, changed });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------------ contacts --
  function cleanContact(b) {
    const c = { name: t(b.name, 120), relationship: t(b.relationship, 60), phone: t(b.phone, 40), alt_phone: t(b.alt_phone, 40), email: t(b.email, 160), address: t(b.address, 300), is_primary: !!b.is_primary };
    if (!c.name) throw httpError(400, 'The contact’s name');
    if (!c.phone && !c.alt_phone) throw httpError(400, 'A phone number for the contact');
    return c;
  }
  const C_COLS = ['name', 'relationship', 'phone', 'alt_phone', 'email', 'address', 'is_primary'];
  async function addContact(uid, b, by) {
    const c = cleanContact(b);
    if (c.is_primary) await query(`UPDATE hr_contacts SET is_primary = false WHERE user_id = $1`, [uid]);
    const { rows } = await query(`INSERT INTO hr_contacts (user_id, ${C_COLS.join(', ')}) VALUES ($1, ${C_COLS.map((k, i) => '$' + (i + 2)).join(', ')}) RETURNING id`, [uid].concat(C_COLS.map((k) => c[k])));
    await audit({ user_id: uid, entity: 'contact', entity_id: rows[0].id, action: 'added', detail: c.name + (c.relationship ? ' (' + c.relationship + ')' : ''), by });
    return rows[0].id;
  }
  async function editContact(uid, id, b, by) {
    const c = cleanContact(b);
    if (c.is_primary) await query(`UPDATE hr_contacts SET is_primary = false WHERE user_id = $1`, [uid]);
    const { rowCount } = await query(`UPDATE hr_contacts SET ${C_COLS.map((k, i) => k + ' = $' + (i + 3)).join(', ')} WHERE id = $1 AND user_id = $2`, [id, uid].concat(C_COLS.map((k) => c[k])));
    if (!rowCount) throw httpError(404, 'Contact not found');
    await audit({ user_id: uid, entity: 'contact', entity_id: id, action: 'changed', detail: c.name, by });
  }
  async function dropContact(uid, id, by) {
    const { rows } = await query(`DELETE FROM hr_contacts WHERE id = $1 AND user_id = $2 RETURNING name`, [id, uid]);
    if (!rows.length) throw httpError(404, 'Contact not found');
    await audit({ user_id: uid, entity: 'contact', entity_id: id, action: 'removed', detail: rows[0].name, by });
  }
  app.post('/api/people/staff/:id/contacts', ...P, async (req, res) => {
    try { const uid = n(req.params.id); await staffRow(uid); res.json({ id: await addContact(uid, req.body || {}, me(req)) }); } catch (e) { fail(res, e); }
  });
  app.put('/api/people/staff/:id/contacts/:cid', ...P, async (req, res) => {
    try { await editContact(n(req.params.id), n(req.params.cid), req.body || {}, me(req)); res.json({ ok: true }); } catch (e) { fail(res, e); }
  });
  app.delete('/api/people/staff/:id/contacts/:cid', ...P, async (req, res) => {
    try { await dropContact(n(req.params.id), n(req.params.cid), me(req)); res.json({ ok: true }); } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------- job and pay history --
  // A promotion, transfer or pay change. From its date it is the current job;
  // a pay change can be passed on to Payroll (by someone who may change pay).
  app.post('/api/people/staff/:id/job', ...P, async (req, res) => {
    try {
      const uid = n(req.params.id); await staffRow(uid); await ensureFile(uid);
      const b = req.body || {};
      const kind = one(b.kind, JOB_KINDS, null);
      if (!kind) throw httpError(400, 'What kind of change it is');
      const eff = d(b.effective_date);
      if (!eff) throw httpError(400, 'The date it takes effect');
      const j = { job_title: t(b.job_title, 120), department_id: n(b.department_id), manager_user_id: n(b.manager_user_id), salary_annual: money(b.salary_annual), hourly_rate: money(b.hourly_rate), reason: t(b.reason, 1000) };
      if (j.manager_user_id === uid) throw httpError(400, 'Someone cannot be their own manager');
      if (kind === 'pay_change' && j.salary_annual == null && j.hourly_rate == null) throw httpError(400, 'The new yearly salary or hourly rate');
      let toPayroll = false;
      if (b.apply_payroll && (j.salary_annual != null || j.hourly_rate != null)) {
        if (!(await userCan(req, 'payroll.run'))) throw httpError(403, 'Only someone who may change pay can pass this on to Payroll. Save it without that tick, and ask them.');
        const { rows: pe } = await query(`SELECT id, pay_type FROM payroll_employees WHERE user_id = $1`, [uid]);
        if (!pe.length) throw httpError(400, 'They are not in Payroll yet. Add them there first, or save without passing it on.');
        toPayroll = true;
      }
      const { rows } = await query(`INSERT INTO hr_job_history (user_id, kind, effective_date, job_title, department_id, manager_user_id, salary_annual, hourly_rate, reason, applied_to_payroll, by_user)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`, [uid, kind, eff, j.job_title, j.department_id, j.manager_user_id, j.salary_annual, j.hourly_rate, j.reason, toPayroll, me(req)]);
      // Dated today or earlier: it is the job now.
      if (eff <= today()) {
        await query(`UPDATE hr_employees SET job_title = COALESCE($2, job_title), department_id = COALESCE($3, department_id), manager_user_id = COALESCE($4, manager_user_id),
          start_date = CASE WHEN $5 = 'start' THEN $6::date ELSE start_date END, updated_by = $7, updated_at = NOW() WHERE user_id = $1`, [uid, j.job_title, j.department_id, j.manager_user_id, kind, eff, me(req)]);
        await query(`UPDATE payroll_employees SET job_title = COALESCE($2, job_title), department = COALESCE((SELECT name FROM departments WHERE id = $3), department) WHERE user_id = $1`, [uid, j.job_title, j.department_id]);
      }
      if (toPayroll) {
        await query(`UPDATE payroll_employees SET salary_annual = COALESCE($2, salary_annual), hourly_rate = COALESCE($3, hourly_rate), updated_by = $4, updated_at = NOW() WHERE user_id = $1`, [uid, j.salary_annual, j.hourly_rate, me(req)]);
      }
      const pay = [j.salary_annual != null ? 'J$' + j.salary_annual.toLocaleString('en-JM') + ' a year' : null, j.hourly_rate != null ? 'J$' + j.hourly_rate + ' an hour' : null].filter(Boolean).join(', ');
      await audit({ user_id: uid, entity: 'job', entity_id: rows[0].id, action: kind.replace('_', ' '), by: me(req),
        detail: [eff, j.job_title, pay, toPayroll ? 'passed on to Payroll' : null, j.reason].filter(Boolean).join(' · ') });
      res.json({ id: rows[0].id, payroll_updated: toPayroll });
    } catch (e) { fail(res, e); }
  });
  app.delete('/api/people/staff/:id/job/:jid', ...P, async (req, res) => {
    try {
      const { rows } = await query(`DELETE FROM hr_job_history WHERE id = $1 AND user_id = $2 RETURNING kind, ${DATE('effective_date')} AS eff`, [n(req.params.jid), n(req.params.id)]);
      if (!rows.length) throw httpError(404, 'Not found');
      await audit({ user_id: n(req.params.id), entity: 'job', entity_id: n(req.params.jid), action: 'removed', detail: rows[0].kind + ' of ' + rows[0].eff + ' (entered by mistake). Pay already passed on to Payroll is not changed back.', by: me(req) });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ---------------------------------------------------------- probation --
  async function decideProbation(uid, outcome, b, by) {
    await ensureFile(uid);
    if (outcome === 'confirm') {
      const on = d(b.date) || today();
      await query(`UPDATE hr_employees SET status = 'active', confirmed_on = $2, confirmed_by = $3, updated_by = $3, updated_at = NOW() WHERE user_id = $1`, [uid, on, by]);
      await query(`INSERT INTO hr_job_history (user_id, kind, effective_date, reason, by_user) VALUES ($1, 'confirmation', $2, $3, $4)`, [uid, on, t(b.note, 1000) || 'Probation passed', by]);
      await audit({ user_id: uid, entity: 'profile', action: 'confirmed in post', detail: on + (b.note ? ' · ' + b.note : ''), by });
    } else if (outcome === 'extend') {
      const until = d(b.until);
      if (!until) throw httpError(400, 'The new end of probation');
      await query(`UPDATE hr_employees SET status = 'probation', probation_end = $2, updated_by = $3, updated_at = NOW() WHERE user_id = $1`, [uid, until, by]);
      await audit({ user_id: uid, entity: 'profile', action: 'probation extended', detail: 'to ' + until + (b.note ? ' · ' + b.note : ''), by });
    } else throw httpError(400, 'Confirm or extend');
  }
  app.post('/api/people/staff/:id/probation', ...P, async (req, res) => {
    try { const uid = n(req.params.id); await staffRow(uid); await decideProbation(uid, (req.body || {}).outcome, req.body || {}, me(req)); res.json({ ok: true }); } catch (e) { fail(res, e); }
  });

  // ------------------------------------------- warnings and discipline --
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function caseLetter(u, c, byName) {
    return '<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="/favicon.svg?v=vision2" type="image/svg+xml"><link rel="icon" href="/favicon.ico?v=vision2" sizes="any"><link rel="apple-touch-icon" href="/apple-touch-icon.png?v=vision2"><title>' + esc(CASE_LABEL[c.kind]) + '</title><style>body{font:14px/1.6 Arial,sans-serif;max-width:680px;margin:30px auto;color:#111}h1{font-size:20px}th{text-align:left;padding:4px 12px 4px 0;vertical-align:top}.sig{margin-top:40px}</style></head><body>' +
      '<p><b>Vision Auto Solutions Ltd</b><br>112C Waltham Park Road, Kingston</p><h1>' + esc(CASE_LABEL[c.kind]) + '</h1>' +
      '<table><tr><th>To</th><td>' + esc(u.name || u.email) + '</td></tr><tr><th>Date</th><td>' + esc(today()) + '</td></tr>' + (c.incident_date ? '<tr><th>About</th><td>' + esc(c.incident_date) + '</td></tr>' : '') + '</table>' +
      '<p><b>' + esc(c.summary) + '</b></p>' + (c.details ? '<p>' + esc(c.details).replace(/\n/g, '<br>') + '</p>' : '') +
      (c.action ? '<p><b>What happens next:</b> ' + esc(c.action).replace(/\n/g, '<br>') + '</p>' : '') +
      (c.expires_on ? '<p>This stays on your file until ' + esc(c.expires_on) + '.</p>' : '') +
      (c.kind !== 'commendation' ? '<p>You may reply in writing, and you may bring a colleague to any meeting about it.</p>' : '') +
      '<p class="sig">Issued by: ' + esc(byName || '') + ' &nbsp; ____________________</p><p class="sig">Received by: ____________________ &nbsp; Date: __________</p></body></html>';
  }
  app.post('/api/people/staff/:id/cases', ...P, async (req, res) => {
    try {
      const uid = n(req.params.id); const u = await staffRow(uid);
      const b = req.body || {};
      const c = { kind: one(b.kind, CASE_KINDS, null), incident_date: d(b.incident_date), summary: t(b.summary, 300), details: t(b.details, 6000), action: t(b.action, 3000), expires_on: d(b.expires_on) };
      if (!c.kind) throw httpError(400, 'What kind of record it is');
      if (!c.summary) throw httpError(400, 'What happened, in a line');
      const { rows } = await query(`INSERT INTO hr_cases (user_id, kind, incident_date, summary, details, action, expires_on, issued_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [uid, c.kind, c.incident_date, c.summary, c.details, c.action, c.expires_on, me(req)]);
      const id = rows[0].id;
      // The letter, filed in the staff file in the Document centre.
      let doc = null;
      if (b.file_letter !== false && deps.docs) {
        try {
          const { rows: by } = await query(`SELECT COALESCE(NULLIF(name, ''), email) AS n FROM users WHERE id = $1`, [me(req)]);
          doc = await deps.docs.fileHtml(req, { title: CASE_LABEL[c.kind] + ': ' + (u.name || u.email), category: 'staff', html: caseLetter(u, c, by[0] && by[0].n), links: [{ type: 'staff', id: uid }], note: 'Written from the HR file' });
          await query(`UPDATE hr_cases SET document_id = $2 WHERE id = $1`, [id, doc.id]);
        } catch (e) { console.warn('[hr] letter not filed', e.message); }
      }
      if (b.tell && deps.notice) await deps.notice([uid], { kind: 'memo', title: c.kind === 'commendation' ? '⭐ A commendation from management' : '📄 You have a letter from management', body: 'Open My HR file to read it and reply.', link: '/people.html#me' }).catch(() => {});
      await audit({ user_id: uid, entity: 'case', entity_id: id, action: CASE_LABEL[c.kind].toLowerCase() + ' recorded', detail: c.summary + (doc ? ' · letter ' + doc.number : ''), by: me(req) });
      res.json({ id, document: doc });
    } catch (e) { fail(res, e); }
  });
  app.patch('/api/people/staff/:id/cases/:cid', ...P, async (req, res) => {
    try {
      const uid = n(req.params.id), id = n(req.params.cid), b = req.body || {};
      const { rows } = await query(`SELECT * FROM hr_cases WHERE id = $1 AND user_id = $2`, [id, uid]);
      if (!rows.length) throw httpError(404, 'Not found');
      const status = 'status' in b ? one(b.status, ['open', 'closed', 'appealed', 'withdrawn'], rows[0].status) : rows[0].status;
      await query(`UPDATE hr_cases SET status = $2, employee_response = COALESCE($3, employee_response), action = COALESCE($4, action), expires_on = CASE WHEN $5 THEN $6::date ELSE expires_on END,
          closed_at = CASE WHEN $2 IN ('closed', 'withdrawn') THEN COALESCE(closed_at, NOW()) ELSE NULL END WHERE id = $1`,
        [id, status, t(b.employee_response, 4000), t(b.action, 3000), 'expires_on' in b, d(b.expires_on)]);
      await audit({ user_id: uid, entity: 'case', entity_id: id, action: status !== rows[0].status ? 'marked ' + status : 'updated', detail: [rows[0].summary, t(b.note, 500)].filter(Boolean).join(' · '), by: me(req) });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ---------------------------------------------------- reviews and goals --
  function cleanRatings(list) {
    const byKey = new Map((Array.isArray(list) ? list : []).map((x) => [x && x.key, x]));
    const base = Array.isArray(list) && list.length ? list : REVIEW_CRITERIA;
    return base.slice(0, 15).map((c) => {
      const x = byKey.get(c.key) || {};
      const s = parseInt(x.score, 10);
      return { key: String(c.key || '').slice(0, 40), label: String(c.label || '').slice(0, 120), score: s >= 1 && s <= 5 ? s : null, comment: t(x.comment, 600) };
    }).filter((c) => c.key && c.label);
  }
  app.post('/api/people/staff/:id/reviews', ...P, async (req, res) => {
    try {
      const uid = n(req.params.id); await staffRow(uid); const b = req.body || {};
      const kind = one(b.kind, REVIEW_KINDS, 'annual');
      const { rows } = await query(`INSERT INTO hr_reviews (user_id, kind, period_from, period_to, due_on, reviewer_id, ratings, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING id`,
        [uid, kind, d(b.period_from), d(b.period_to), d(b.due_on), n(b.reviewer_id) || me(req), JSON.stringify(cleanRatings(null)), me(req)]);
      if (n(b.reviewer_id) && n(b.reviewer_id) !== me(req) && deps.notice) await deps.notice([n(b.reviewer_id)], { kind: 'memo', title: '📝 You have a staff review to do', body: 'Due ' + (d(b.due_on) || 'soon'), link: '/people.html#staff=' + uid }).catch(() => {});
      await audit({ user_id: uid, entity: 'review', entity_id: rows[0].id, action: kind + ' review set up', detail: d(b.due_on) ? 'due ' + d(b.due_on) : null, by: me(req) });
      res.json({ id: rows[0].id });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/people/staff/:id/reviews/:rid', ...P, async (req, res) => {
    try {
      const uid = n(req.params.id), id = n(req.params.rid), b = req.body || {};
      const { rows } = await query(`SELECT * FROM hr_reviews WHERE id = $1 AND user_id = $2`, [id, uid]);
      if (!rows.length) throw httpError(404, 'Review not found');
      const r = rows[0];
      if (r.status !== 'draft' && !b.reopen) throw httpError(409, 'This review is finished. Reopen it to change it.');
      const ratings = cleanRatings(Array.isArray(b.ratings) ? b.ratings.map((x) => Object.assign({}, (r.ratings || []).find((y) => y.key === x.key) || {}, x)) : r.ratings);
      const scored = ratings.filter((x) => x.score);
      const overall = parseInt(b.overall, 10) >= 1 && parseInt(b.overall, 10) <= 5 ? parseInt(b.overall, 10) : (scored.length ? Math.round(scored.reduce((s, x) => s + x.score, 0) / scored.length) : null);
      const finish = !!b.finish;
      const outcome = r.kind === 'probation' ? one(b.outcome, ['confirm', 'extend', 'end'], null) : null;
      if (finish && !scored.length) throw httpError(400, 'Score at least one area before finishing');
      if (finish && r.kind === 'probation' && !outcome) throw httpError(400, 'Choose the outcome of the probation');
      await query(`UPDATE hr_reviews SET ratings = $2::jsonb, overall = $3, strengths = $4, improve = $5, comments = $6, outcome = $7, reviewer_id = COALESCE($8, reviewer_id),
          due_on = COALESCE($9, due_on), period_from = COALESCE($10, period_from), period_to = COALESCE($11, period_to),
          status = CASE WHEN $12 THEN 'done' WHEN $13 THEN 'draft' ELSE status END, completed_at = CASE WHEN $12 THEN NOW() WHEN $13 THEN NULL ELSE completed_at END,
          acknowledged_at = CASE WHEN $13 THEN NULL ELSE acknowledged_at END WHERE id = $1`,
        [id, JSON.stringify(ratings), overall, t(b.strengths, 4000), t(b.improve, 4000), t(b.comments, 4000), outcome, n(b.reviewer_id), d(b.due_on), d(b.period_from), d(b.period_to), finish, !!b.reopen]);
      if (finish && outcome === 'confirm') await decideProbation(uid, 'confirm', { note: 'Probation review passed' }, me(req));
      if (finish && outcome === 'extend') await decideProbation(uid, 'extend', { until: d(b.extend_until), note: 'Probation review: extended' }, me(req));
      if (finish && deps.notice) await deps.notice([uid], { kind: 'memo', title: '📝 Your review is ready to read', body: 'Open My HR file to read it, add your comments and sign it off.', link: '/people.html#me' }).catch(() => {});
      await audit({ user_id: uid, entity: 'review', entity_id: id, action: finish ? 'review finished' : b.reopen ? 'review reopened' : 'review saved', detail: [overall ? 'overall ' + overall + '/5' : null, outcome ? 'outcome: ' + outcome : null].filter(Boolean).join(' · '), by: me(req) });
      res.json({ ok: true, overall });
    } catch (e) { fail(res, e); }
  });
  app.delete('/api/people/staff/:id/reviews/:rid', ...P, async (req, res) => {
    try {
      const { rows } = await query(`DELETE FROM hr_reviews WHERE id = $1 AND user_id = $2 AND status = 'draft' RETURNING kind`, [n(req.params.rid), n(req.params.id)]);
      if (!rows.length) throw httpError(409, 'Only a review not yet finished can be deleted');
      await audit({ user_id: n(req.params.id), entity: 'review', entity_id: n(req.params.rid), action: 'review deleted', detail: rows[0].kind, by: me(req) });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  function cleanGoal(b) {
    const g = { title: t(b.title, 200), measure: t(b.measure, 1000), due_on: d(b.due_on), status: one(b.status, ['open', 'done', 'dropped'], 'open'), progress: Math.max(0, Math.min(100, parseInt(b.progress, 10) || 0)), note: t(b.note, 2000), review_id: n(b.review_id) };
    if (!g.title) throw httpError(400, 'The goal');
    if (g.status === 'done') g.progress = 100;
    return g;
  }
  app.post('/api/people/staff/:id/goals', ...P, async (req, res) => {
    try {
      const uid = n(req.params.id); await staffRow(uid); const g = cleanGoal(req.body || {});
      const { rows } = await query(`INSERT INTO hr_goals (user_id, review_id, title, measure, due_on, status, progress, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [uid, g.review_id, g.title, g.measure, g.due_on, g.status, g.progress, g.note, me(req)]);
      await audit({ user_id: uid, entity: 'goal', entity_id: rows[0].id, action: 'goal set', detail: g.title + (g.due_on ? ' · by ' + g.due_on : ''), by: me(req) });
      res.json({ id: rows[0].id });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/people/staff/:id/goals/:gid', ...P, async (req, res) => {
    try {
      const uid = n(req.params.id), id = n(req.params.gid), g = cleanGoal(req.body || {});
      const { rowCount } = await query(`UPDATE hr_goals SET title = $3, measure = $4, due_on = $5, status = $6, progress = $7, note = $8, updated_at = NOW() WHERE id = $1 AND user_id = $2`,
        [id, uid, g.title, g.measure, g.due_on, g.status, g.progress, g.note]);
      if (!rowCount) throw httpError(404, 'Goal not found');
      await audit({ user_id: uid, entity: 'goal', entity_id: id, action: 'goal ' + (g.status === 'open' ? 'updated' : g.status), detail: g.title + ' · ' + g.progress + '%', by: me(req) });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.delete('/api/people/staff/:id/goals/:gid', ...P, async (req, res) => {
    try {
      const { rows } = await query(`DELETE FROM hr_goals WHERE id = $1 AND user_id = $2 RETURNING title`, [n(req.params.gid), n(req.params.id)]);
      if (!rows.length) throw httpError(404, 'Goal not found');
      await audit({ user_id: n(req.params.id), entity: 'goal', entity_id: n(req.params.gid), action: 'goal removed', detail: rows[0].title, by: me(req) });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ---------------------------------------------------------------- leave --
  // The allowance is Payroll's (the person's own days, else the shop's
  // setting), plus or minus adjustments here; days taken are Attendance's
  // leave records, Monday to Saturday, as Payroll counts them.
  const halves = (x) => Math.floor(x * 2) / 2;
  function earnedPart(accrual, since, year) {
    if (accrual !== 'monthly') return 1;
    const now = today(), cy = Number(now.slice(0, 4));
    if (year > cy) return 0;
    const end = year < cy ? 12 : Number(now.slice(5, 7)) - 1;          // whole months gone this year
    let first = 0;
    if (since && Number(since.slice(0, 4)) === year) first = Number(since.slice(5, 7)) - 1 + (since.slice(8) === '01' ? 0 : 1);
    else if (since && Number(since.slice(0, 4)) > year) return 0;
    return Math.max(0, end - first) / 12;
  }
  async function leaveFor(uids, year) {
    if (!uids.length) return {};
    const { rows: s } = await query(`SELECT key, value FROM warehouse_settings WHERE key IN ('payroll_vacation_days', 'payroll_sick_days')`);
    const st = Object.fromEntries(s.map((r) => [r.key, Number(r.value)]));
    const dv = Number.isFinite(st.payroll_vacation_days) ? st.payroll_vacation_days : 10, ds = Number.isFinite(st.payroll_sick_days) ? st.payroll_sick_days : 10;
    const { rows } = await query(`SELECT u.id, p.vacation_days::float AS pv, p.sick_days::float AS ps, COALESCE(h.leave_accrual, 'year') AS accrual, ${DATE('COALESCE(h.adjusted_service_date, h.start_date, p.hire_date)')} AS since,
        COALESCE((SELECT SUM(days) FROM hr_leave_adjustments a WHERE a.user_id = u.id AND a.year = $2 AND a.kind = 'vacation'), 0)::float AS adj_v,
        COALESCE((SELECT SUM(days) FROM hr_leave_adjustments a WHERE a.user_id = u.id AND a.year = $2 AND a.kind = 'sick'), 0)::float AS adj_s
      FROM users u LEFT JOIN payroll_employees p ON p.user_id = u.id LEFT JOIN hr_employees h ON h.user_id = u.id WHERE u.id = ANY($1::int[])`, [uids, year]);
    const { rows: taken } = await query(`SELECT l.user_id, l.kind, COUNT(*)::int AS days FROM staff_leave l, generate_series(GREATEST(l.from_date, $2::date), LEAST(l.to_date, $3::date), interval '1 day') g(d)
      WHERE l.user_id = ANY($1::int[]) AND l.to_date >= $2::date AND l.from_date <= $3::date AND EXTRACT(DOW FROM g.d) <> 0 GROUP BY l.user_id, l.kind`, [uids, year + '-01-01', year + '-12-31']);
    const out = {};
    for (const r of rows) {
      const tk = (k) => (taken.find((x) => x.user_id === r.id && x.kind === k) || { days: 0 }).days;
      const ve = (r.pv != null ? r.pv : dv) + r.adj_v, se = (r.ps != null ? r.ps : ds) + r.adj_s;
      // Monthly accrual: a twelfth of the year's days for each whole month worked so far; days added or taken off count in full.
      const part = earnedPart(r.accrual, r.since, year);
      const vEarn = part === 1 ? ve : halves((ve - r.adj_v) * part) + r.adj_v, sEarn = part === 1 ? se : halves((se - r.adj_s) * part) + r.adj_s;
      out[r.id] = { year, accrual: r.accrual, vacation_entitled: ve, vacation_earned: vEarn, vacation_taken: tk('vacation'), vacation_left: vEarn - tk('vacation'), sick_entitled: se, sick_earned: sEarn, sick_taken: tk('sick'), sick_left: sEarn - tk('sick'),
        unpaid_taken: tk('unpaid'), other_taken: tk('other'), adjusted_vacation: r.adj_v, adjusted_sick: r.adj_s, own_allowance: r.pv != null };
    }
    return out;
  }
  app.get('/api/people/leave', ...P, async (req, res) => {
    try {
      const year = parseInt(req.query.year, 10) || new Date().getFullYear();
      const { rows } = await query(`SELECT u.id, COALESCE(NULLIF(u.name, ''), u.email) AS name, dp.name AS department FROM users u LEFT JOIN hr_employees h ON h.user_id = u.id LEFT JOIN departments dp ON dp.id = h.department_id
        WHERE (u.is_staff OR u.is_admin) AND NOT COALESCE(u.is_archived, false) ORDER BY 2`);
      const bal = await leaveFor(rows.map((r) => r.id), year);
      res.json({ year, staff: rows.map((r) => Object.assign(r, bal[r.id] || {})) });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/people/staff/:id/leave-adjustments', ...P, async (req, res) => {
    try {
      const uid = n(req.params.id); await staffRow(uid); const b = req.body || {};
      const days = Number(b.days);
      if (!Number.isFinite(days) || days === 0 || Math.abs(days) > 60) throw httpError(400, 'The number of days to add (or take off, with a minus sign)');
      const reason = t(b.reason, 300);
      if (!reason) throw httpError(400, 'Why (for example: carried over from last year)');
      const year = parseInt(b.year, 10) || new Date().getFullYear();
      const kind = one(b.kind, ['vacation', 'sick'], 'vacation');
      const { rows } = await query(`INSERT INTO hr_leave_adjustments (user_id, year, kind, days, reason, by_user) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [uid, year, kind, days, reason, me(req)]);
      await audit({ user_id: uid, entity: 'leave', entity_id: rows[0].id, action: kind + ' allowance ' + (days > 0 ? '+' : '') + days + ' days (' + year + ')', detail: reason, by: me(req) });
      res.json({ id: rows[0].id });
    } catch (e) { fail(res, e); }
  });
  app.delete('/api/people/staff/:id/leave-adjustments/:aid', ...P, async (req, res) => {
    try {
      const { rows } = await query(`DELETE FROM hr_leave_adjustments WHERE id = $1 AND user_id = $2 RETURNING kind, days::float, year`, [n(req.params.aid), n(req.params.id)]);
      if (!rows.length) throw httpError(404, 'Not found');
      await audit({ user_id: n(req.params.id), entity: 'leave', entity_id: n(req.params.aid), action: 'allowance change removed', detail: rows[0].kind + ' ' + rows[0].days + ' days (' + rows[0].year + ')', by: me(req) });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ---------------------------------------------------------------- tasks --
  async function addTasks(uid, kind, list, o, q = query) {
    let i = 0;
    for (const [title, link] of list) {
      await q(`INSERT INTO hr_tasks (user_id, kind, exit_id, title, link, due_on, assignee_id, sort) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [uid, kind, o.exit_id || null, title, link, o.due_on || null, o.assignee_id || null, i++]);
    }
  }
  app.post('/api/people/staff/:id/tasks', ...P, async (req, res) => {
    try {
      const uid = n(req.params.id); await staffRow(uid); const b = req.body || {};
      if (b.template === 'onboarding') {
        await addTasks(uid, 'onboarding', ONBOARDING, { due_on: d(b.due_on), assignee_id: n(b.assignee_id) || me(req) });
        await audit({ user_id: uid, entity: 'task', action: 'onboarding checklist added', by: me(req) });
        return res.json({ ok: true });
      }
      const title = t(b.title, 200);
      if (!title) throw httpError(400, 'What needs doing');
      const { rows } = await query(`INSERT INTO hr_tasks (user_id, kind, title, due_on, assignee_id, sort) VALUES ($1,$2,$3,$4,$5,100) RETURNING id`,
        [uid, one(b.kind, ['onboarding', 'offboarding', 'other'], 'other'), title, d(b.due_on), n(b.assignee_id)]);
      if (n(b.assignee_id) && n(b.assignee_id) !== me(req) && deps.notice) await deps.notice([n(b.assignee_id)], { kind: 'memo', title: '✅ HR task for you: ' + title, link: '/people.html#staff=' + uid }).catch(() => {});
      await audit({ user_id: uid, entity: 'task', entity_id: rows[0].id, action: 'task added', detail: title, by: me(req) });
      res.json({ id: rows[0].id });
    } catch (e) { fail(res, e); }
  });
  app.patch('/api/people/tasks/:tid', ...P, async (req, res) => {
    try {
      const id = n(req.params.tid), b = req.body || {};
      const { rows } = await query(`SELECT * FROM hr_tasks WHERE id = $1`, [id]);
      if (!rows.length) throw httpError(404, 'Task not found');
      const k = rows[0];
      await query(`UPDATE hr_tasks SET done_at = CASE WHEN $2::boolean IS NULL THEN done_at WHEN $2 THEN COALESCE(done_at, NOW()) ELSE NULL END,
          done_by = CASE WHEN $2::boolean IS NULL THEN done_by WHEN $2 THEN COALESCE(done_by, $3) ELSE NULL END,
          note = COALESCE($4, note), assignee_id = CASE WHEN $5 THEN $6 ELSE assignee_id END, due_on = CASE WHEN $7 THEN $8::date ELSE due_on END WHERE id = $1`,
        [id, 'done' in b ? !!b.done : null, me(req), t(b.note, 500), 'assignee_id' in b, n(b.assignee_id), 'due_on' in b, d(b.due_on)]);
      if ('done' in b) await audit({ user_id: k.user_id, entity: 'task', entity_id: id, action: b.done ? 'ticked off' : 'unticked', detail: k.title, by: me(req) });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.delete('/api/people/tasks/:tid', ...P, async (req, res) => {
    try {
      const { rows } = await query(`DELETE FROM hr_tasks WHERE id = $1 RETURNING user_id, title`, [n(req.params.tid)]);
      if (!rows.length) throw httpError(404, 'Task not found');
      await audit({ user_id: rows[0].user_id, entity: 'task', entity_id: n(req.params.tid), action: 'task removed', detail: rows[0].title, by: me(req) });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  // Everything still to do, across everyone.
  app.get('/api/people/tasks', ...P, async (req, res) => {
    try {
      const { rows } = await query(`SELECT k.id, k.user_id, k.kind, k.title, k.link, ${DATE('k.due_on')} AS due_on, COALESCE(NULLIF(u.name, ''), u.email) AS person, COALESCE(NULLIF(a.name, ''), a.email) AS assignee
        FROM hr_tasks k JOIN users u ON u.id = k.user_id LEFT JOIN users a ON a.id = k.assignee_id WHERE k.done_at IS NULL ORDER BY k.due_on NULLS LAST, u.name, k.sort LIMIT 500`);
      res.json({ tasks: rows });
    } catch (e) { fail(res, e); }
  });

  // ---------------------------------------------------------------- exits --
  app.post('/api/people/staff/:id/exits', ...P, async (req, res) => {
    try {
      const uid = n(req.params.id); await staffRow(uid); await ensureFile(uid); const b = req.body || {};
      const last = d(b.last_day);
      if (!last) throw httpError(400, 'Their last day');
      const { rows: open } = await query(`SELECT id FROM hr_exits WHERE user_id = $1 AND status = 'open'`, [uid]);
      if (open.length) throw httpError(409, 'There is already an exit in progress for them');
      const kind = one(b.kind, EXIT_KINDS, 'resignation');
      const { rows } = await query(`INSERT INTO hr_exits (user_id, kind, notice_date, last_day, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [uid, kind, d(b.notice_date) || today(), last, t(b.reason, 2000), me(req)]);
      const id = rows[0].id;
      await addTasks(uid, 'offboarding', OFFBOARDING, { exit_id: id, due_on: last, assignee_id: n(b.assignee_id) || me(req) });
      await query(`UPDATE hr_employees SET status = 'notice', updated_by = $2, updated_at = NOW() WHERE user_id = $1`, [uid, me(req)]);
      await audit({ user_id: uid, entity: 'exit', entity_id: id, action: kind.replace(/_/g, ' ') + ' recorded', detail: 'last day ' + last + (b.reason ? ' · ' + t(b.reason, 300) : ''), by: me(req) });
      res.json({ id });
    } catch (e) { fail(res, e); }
  });
  app.patch('/api/people/exits/:xid', ...P, async (req, res) => {
    try {
      const id = n(req.params.xid), b = req.body || {};
      const { rows } = await query(`SELECT * FROM hr_exits WHERE id = $1`, [id]);
      if (!rows.length) throw httpError(404, 'Exit not found');
      const x = rows[0];
      if (x.status !== 'open') throw httpError(409, 'This exit is ' + x.status);
      await query(`UPDATE hr_exits SET last_day = COALESCE($2, last_day), reason = COALESCE($3, reason), exit_interview = COALESCE($4, exit_interview), rehire = CASE WHEN $5 THEN $6 ELSE rehire END, kind = COALESCE($7, kind) WHERE id = $1`,
        [id, d(b.last_day), t(b.reason, 2000), t(b.exit_interview, 6000), 'rehire' in b, b.rehire == null ? null : !!b.rehire, one(b.kind, EXIT_KINDS, null)]);
      if (b.cancel) {
        await query(`UPDATE hr_exits SET status = 'cancelled', completed_by = $2, completed_at = NOW() WHERE id = $1`, [id, me(req)]);
        await query(`DELETE FROM hr_tasks WHERE exit_id = $1 AND done_at IS NULL`, [id]);
        await query(`UPDATE hr_employees SET status = CASE WHEN probation_end > CURRENT_DATE AND confirmed_on IS NULL THEN 'probation' ELSE 'active' END WHERE user_id = $1`, [x.user_id]);
      }
      if (b.complete) {
        await query(`UPDATE hr_exits SET status = 'done', completed_by = $2, completed_at = NOW() WHERE id = $1`, [id, me(req)]);
        await query(`UPDATE hr_employees SET status = 'left', release_date = COALESCE(release_date, $3::date, (SELECT last_day FROM hr_exits WHERE id = $6)), release_reason = COALESCE(release_reason, $4), rehire_eligible = COALESCE($5, rehire_eligible), updated_by = $2, updated_at = NOW() WHERE user_id = $1`,
          [x.user_id, me(req), d(b.last_day), x.kind.replace(/_/g, ' '), 'rehire' in b ? (b.rehire == null ? null : !!b.rehire) : x.rehire, id]);
      }
      await audit({ user_id: x.user_id, entity: 'exit', entity_id: id, action: b.cancel ? 'exit cancelled (staying on)' : b.complete ? 'exit completed' : 'exit updated', detail: [d(b.last_day) ? 'last day ' + d(b.last_day) : null, 'rehire' in b ? 'would rehire: ' + (b.rehire ? 'yes' : 'no') : null, t(b.note, 300)].filter(Boolean).join(' · '), by: me(req) });
      const { rows: left } = await query(`SELECT COUNT(*)::int AS n FROM hr_tasks WHERE exit_id = $1 AND done_at IS NULL`, [id]);
      res.json({ ok: true, tasks_left: left[0].n });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------------ org chart --
  app.get('/api/people/org', ...P, async (req, res) => {
    try {
      const { rows } = await query(`SELECT u.id, COALESCE(NULLIF(u.name, ''), u.email) AS name, h.job_title, dp.name AS department, h.manager_user_id AS manager_id, COALESCE(h.status, 'active') AS status
        FROM users u LEFT JOIN hr_employees h ON h.user_id = u.id LEFT JOIN departments dp ON dp.id = h.department_id
        WHERE (u.is_staff OR u.is_admin) AND NOT COALESCE(u.is_archived, false) AND NOT COALESCE(u.disabled, false) ORDER BY 2`);
      // A manager who has left, or is not on the list, makes their people top level.
      const ids = new Set(rows.map((r) => r.id));
      for (const r of rows) if (r.manager_id && !ids.has(r.manager_id)) r.manager_id = null;
      res.json({ people: rows });
    } catch (e) { fail(res, e); }
  });

  // -------------------------------------------------------------- reports --
  app.get('/api/people/reports', ...P, async (req, res) => {
    try {
      const cur = `(u.is_staff OR u.is_admin) AND NOT COALESCE(u.is_archived, false)`;
      const base = `FROM users u LEFT JOIN hr_employees h ON h.user_id = u.id LEFT JOIN departments dp ON dp.id = h.department_id LEFT JOIN payroll_employees p ON p.user_id = u.id`;
      const q = async (sql, v) => (await query(sql, v || [])).rows;
      const headcount = (await q(`SELECT COUNT(*)::int AS n ${base} WHERE ${cur}`))[0].n;
      const by_department = await q(`SELECT COALESCE(dp.name, 'Not set') AS label, COUNT(*)::int AS n ${base} WHERE ${cur} GROUP BY 1 ORDER BY 2 DESC`);
      const by_contract = await q(`SELECT COALESCE(h.contract_type, 'not set') AS label, COUNT(*)::int AS n ${base} WHERE ${cur} GROUP BY 1 ORDER BY 2 DESC`);
      const by_status = await q(`SELECT COALESCE(h.status, 'active') AS label, COUNT(*)::int AS n ${base} WHERE ${cur} GROUP BY 1 ORDER BY 2 DESC`);
      // Starters and leavers by month, the last 12 months.
      const moves = await q(`WITH m AS (SELECT to_char(g, 'YYYY-MM') AS ym FROM generate_series(date_trunc('month', CURRENT_DATE) - interval '11 months', date_trunc('month', CURRENT_DATE), interval '1 month') g)
        SELECT m.ym, (SELECT COUNT(*)::int ${base} WHERE to_char(COALESCE(h.start_date, p.hire_date), 'YYYY-MM') = m.ym) AS starters,
          (SELECT COUNT(*)::int FROM users u WHERE u.archived_at IS NOT NULL AND to_char(COALESCE(u.left_on, u.archived_at::date), 'YYYY-MM') = m.ym) AS leavers FROM m ORDER BY m.ym`);
      const leavers12 = moves.reduce((s, r) => s + r.leavers, 0), starters12 = moves.reduce((s, r) => s + r.starters, 0);
      const avg = Math.max(1, (headcount + (headcount - starters12 + leavers12)) / 2);
      const probation_due = await q(`SELECT u.id, COALESCE(NULLIF(u.name, ''), u.email) AS name, ${DATE('h.probation_end')} AS due ${base} WHERE ${cur} AND h.status = 'probation' AND h.probation_end <= CURRENT_DATE + 30 ORDER BY h.probation_end`);
      const contracts_ending = await q(`SELECT u.id, COALESCE(NULLIF(u.name, ''), u.email) AS name, h.contract_type, ${DATE('h.contract_end')} AS due ${base} WHERE ${cur} AND h.contract_end IS NOT NULL AND h.contract_end <= CURRENT_DATE + 60 ORDER BY h.contract_end`);
      const warnings = await q(`SELECT u.id, COALESCE(NULLIF(u.name, ''), u.email) AS name, c.kind, c.summary, ${DATE('c.expires_on')} AS expires_on FROM hr_cases c JOIN users u ON u.id = c.user_id
        WHERE ${cur} AND c.status = 'open' AND c.kind NOT IN ('commendation', 'counselling') AND (c.expires_on IS NULL OR c.expires_on >= CURRENT_DATE) ORDER BY c.created_at DESC`);
      const reviews_overdue = await q(`SELECT u.id, COALESCE(NULLIF(u.name, ''), u.email) AS name, r.kind, ${DATE('r.due_on')} AS due FROM hr_reviews r JOIN users u ON u.id = r.user_id WHERE ${cur} AND r.status = 'draft' AND r.due_on < CURRENT_DATE ORDER BY r.due_on`);
      const no_contact = await q(`SELECT u.id, COALESCE(NULLIF(u.name, ''), u.email) AS name ${base} WHERE ${cur} AND NOT EXISTS (SELECT 1 FROM hr_contacts c WHERE c.user_id = u.id) ORDER BY 2`);
      const missing = await q(`SELECT u.id, COALESCE(NULLIF(u.name, ''), u.email) AS name, (COALESCE(h.start_date, p.hire_date) IS NULL) AS no_start, (h.job_title IS NULL) AS no_title, (h.manager_user_id IS NULL) AS no_manager
        ${base} WHERE ${cur} AND (COALESCE(h.start_date, p.hire_date) IS NULL OR h.job_title IS NULL) ORDER BY 2`);
      const birthdays = await q(`SELECT u.id, COALESCE(NULLIF(u.name, ''), u.email) AS name, to_char(COALESCE(h.date_of_birth, p.date_of_birth), 'DD Mon') AS day ${base}
        WHERE ${cur} AND EXTRACT(MONTH FROM COALESCE(h.date_of_birth, p.date_of_birth)) = EXTRACT(MONTH FROM CURRENT_DATE) ORDER BY EXTRACT(DAY FROM COALESCE(h.date_of_birth, p.date_of_birth))`);
      const service = await q(`SELECT CASE WHEN s IS NULL THEN 'Not known' WHEN s < 1 THEN 'Under 1 year' WHEN s < 3 THEN '1 to 3 years' WHEN s < 5 THEN '3 to 5 years' ELSE '5 years or more' END AS label, COUNT(*)::int AS n
        FROM (SELECT EXTRACT(YEAR FROM age(CURRENT_DATE, COALESCE(h.start_date, p.hire_date))) AS s ${base} WHERE ${cur}) x GROUP BY 1 ORDER BY 1`);
      const exits = await q(`SELECT x.kind AS label, COUNT(*)::int AS n FROM hr_exits x WHERE x.status = 'done' AND x.last_day >= CURRENT_DATE - 365 GROUP BY 1 ORDER BY 2 DESC`);
      const hiring = (await q(`SELECT (SELECT COUNT(*)::int FROM job_requisitions WHERE status = 'submitted') AS reqs_waiting, (SELECT COUNT(*)::int FROM job_posts WHERE is_open) AS posts_open,
          (SELECT COUNT(*)::int FROM job_applications WHERE anonymised_at IS NULL AND stage NOT IN ('hired', 'rejected')) AS in_progress,
          (SELECT ROUND(AVG(EXTRACT(EPOCH FROM (a.updated_at - a.created_at)) / 86400))::int FROM job_applications a WHERE a.stage = 'hired' AND a.updated_at >= NOW() - interval '365 days') AS days_to_hire`))[0];
      res.json({ headcount, by_department, by_contract, by_status, service, moves, starters12, leavers12, turnover_pct: Math.round(1000 * leavers12 / avg) / 10,
        probation_due, contracts_ending, warnings, reviews_overdue, no_contact, missing, birthdays, exits, hiring });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/people/audit', ...P, async (req, res) => {
    try {
      const { rows } = await query(`SELECT a.at, a.entity, a.action, a.detail, a.user_id, a.application_id, COALESCE(NULLIF(u.name, ''), u.email) AS person, COALESCE(NULLIF(b.name, ''), b.email) AS by_name
        FROM hr_audit a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN users b ON b.id = a.by_user
        WHERE ($1::text IS NULL OR a.entity = ANY(string_to_array($1, ','))) ORDER BY a.at DESC LIMIT 500`, [t(req.query.entity, 200)]);
      res.json({ log: rows });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------ my own HR file --
  // Every member of staff: read their file (not drafts, not the audit),
  // keep their own phone, address and emergency contacts up to date, reply
  // to a review or a letter.
  app.get('/api/people/me', requireAdmin, async (req, res) => {
    try { res.json(Object.assign(await fileFor(me(req), { self: true }), { hr: await userCan(req, 'hr.people') })); } catch (e) { fail(res, e); }
  });
  app.put('/api/people/me/details', requireAdmin, async (req, res) => {
    try {
      const uid = me(req); await staffRow(uid); await ensureFile(uid); const b = req.body || {};
      await query(`UPDATE hr_employees SET personal_phone = $2, personal_email = $3, address = $4, parish = $5, mobile = $6, updated_by = $1, updated_at = NOW() WHERE user_id = $1`,
        [uid, t(b.personal_phone, 40), t(b.personal_email, 160), t(b.address, 300), t(b.parish, 40), t(b.mobile, 40)]);
      await audit({ user_id: uid, entity: 'profile', action: 'own contact details updated', by: uid });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/people/me/contacts', requireAdmin, async (req, res) => {
    try { await staffRow(me(req)); res.json({ id: await addContact(me(req), req.body || {}, me(req)) }); } catch (e) { fail(res, e); }
  });
  app.put('/api/people/me/contacts/:cid', requireAdmin, async (req, res) => {
    try { await editContact(me(req), n(req.params.cid), req.body || {}, me(req)); res.json({ ok: true }); } catch (e) { fail(res, e); }
  });
  app.delete('/api/people/me/contacts/:cid', requireAdmin, async (req, res) => {
    try { await dropContact(me(req), n(req.params.cid), me(req)); res.json({ ok: true }); } catch (e) { fail(res, e); }
  });
  app.post('/api/people/me/reviews/:rid/ack', requireAdmin, async (req, res) => {
    try {
      const { rows } = await query(`UPDATE hr_reviews SET status = 'acknowledged', acknowledged_at = NOW(), employee_comments = $3 WHERE id = $1 AND user_id = $2 AND status = 'done' RETURNING id`,
        [n(req.params.rid), me(req), t((req.body || {}).comments, 4000)]);
      if (!rows.length) throw httpError(409, 'This review is not waiting for you');
      await audit({ user_id: me(req), entity: 'review', entity_id: rows[0].id, action: 'review signed off by the employee', by: me(req) });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/people/me/cases/:cid/ack', requireAdmin, async (req, res) => {
    try {
      const { rows } = await query(`UPDATE hr_cases SET acknowledged_at = COALESCE(acknowledged_at, NOW()), employee_response = COALESCE($3, employee_response) WHERE id = $1 AND user_id = $2 RETURNING id, summary`,
        [n(req.params.cid), me(req), t((req.body || {}).response, 4000)]);
      if (!rows.length) throw httpError(404, 'Not found');
      await audit({ user_id: me(req), entity: 'case', entity_id: rows[0].id, action: 'received by the employee' + ((req.body || {}).response ? ', with a reply' : ''), detail: rows[0].summary, by: me(req) });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.patch('/api/people/me/tasks/:tid', requireAdmin, async (req, res) => {
    try {
      const { rows } = await query(`UPDATE hr_tasks SET done_at = CASE WHEN $3 THEN NOW() ELSE NULL END, done_by = CASE WHEN $3 THEN $2 ELSE NULL END WHERE id = $1 AND assignee_id = $2 RETURNING user_id, title`,
        [n(req.params.tid), me(req), !!(req.body || {}).done]);
      if (!rows.length) throw httpError(404, 'Task not found');
      await audit({ user_id: rows[0].user_id, entity: 'task', entity_id: n(req.params.tid), action: (req.body || {}).done ? 'ticked off' : 'unticked', detail: rows[0].title, by: me(req) });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------ from hiring --
  // A hired applicant: open their staff file from the accepted offer, record
  // the start in the job history, put them in Payroll switched off (pay
  // starts when someone switches it on from the start date), and give them
  // the onboarding checklist. q runs inside the hire's transaction.
  async function onHire(o, q = query) {
    const { uid, app: a, offer, job, by } = o;
    const start = offer && offer.start_date ? (offer.start_date instanceof Date ? offer.start_date.toISOString().slice(0, 10) : String(offer.start_date).slice(0, 10)) : null;
    const months = offer ? offer.probation_months : 3;
    let probEnd = null;
    if (start && months > 0) { const x = new Date(start + 'T12:00:00Z'); x.setUTCMonth(x.getUTCMonth() + months); probEnd = x.toISOString().slice(0, 10); }
    const deptId = offer ? offer.department_id : null;
    const title = (offer && offer.job_title) || (job && job.title) || null;
    const manager = (offer && offer.manager_user_id) || (job && job.hiring_manager_id) || null;
    await q(`INSERT INTO hr_employees (user_id, job_title, department_id, manager_user_id, start_date, contract_type, contract_end, status, probation_months, probation_end, personal_phone, parish, from_application, updated_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT (user_id) DO UPDATE SET job_title = EXCLUDED.job_title, department_id = COALESCE(EXCLUDED.department_id, hr_employees.department_id), manager_user_id = COALESCE(EXCLUDED.manager_user_id, hr_employees.manager_user_id),
        start_date = COALESCE(EXCLUDED.start_date, hr_employees.start_date), contract_type = EXCLUDED.contract_type, contract_end = EXCLUDED.contract_end, status = EXCLUDED.status,
        probation_months = EXCLUDED.probation_months, probation_end = EXCLUDED.probation_end, from_application = EXCLUDED.from_application, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [uid, title, deptId, manager, start, (offer && offer.contract_type) || 'permanent', offer ? offer.contract_end : null, months > 0 ? 'probation' : 'active', months, probEnd, a.phone, a.parish, a.id, by]);
    await q(`INSERT INTO hr_job_history (user_id, kind, effective_date, job_title, department_id, manager_user_id, salary_annual, hourly_rate, reason, by_user) VALUES ($1, 'start', $2, $3, $4, $5, $6, $7, $8, $9)`,
      [uid, start || today(), title, deptId, manager, offer ? offer.salary_annual : null, offer ? offer.hourly_rate : null, 'Hired from application ' + (a.ref || '#' + a.id), by]);
    let payrollId = null;
    if (offer && (offer.salary_annual || offer.hourly_rate)) {
      const { rows: ex } = await q(`SELECT id FROM payroll_employees WHERE user_id = $1`, [uid]);
      if (!ex.length) {
        const { rows } = await q(`INSERT INTO payroll_employees (user_id, name, email, phone, hire_date, job_title, department, pay_type, frequency, salary_annual, hourly_rate, is_active, notes, updated_by)
          VALUES ($1,$2,$3,$4,$5,$6,(SELECT name FROM departments WHERE id = $7),$8,$9,$10,$11,false,$12,$13) RETURNING id`,
          [uid, a.name, a.email, a.phone, start, title, deptId, offer.pay_type === 'hourly' ? 'hourly' : 'salary', ['weekly', 'fortnightly', 'monthly'].includes(offer.frequency) ? offer.frequency : 'monthly',
            offer.salary_annual, offer.hourly_rate, 'From the accepted offer. Add TRN, NIS and bank details, then switch pay on from the start date.', by]);
        payrollId = rows[0].id;
      }
    }
    await addTasks(uid, 'onboarding', ONBOARDING, { due_on: start, assignee_id: manager || by }, q);
    await audit({ user_id: uid, application_id: a.id, entity: 'hire', action: 'staff file opened from hiring', detail: [title, start ? 'starts ' + start : null, payrollId ? 'added to Payroll (switched off)' : null].filter(Boolean).join(' · '), by }, q);
    return { payroll_id: payrollId, probation_end: probEnd };
  }

  // Contracts, documents to sign, adding staff and the QuickBooks import (hr-docs.js).
  const hrDocs = require('./hr-docs').register(app, Object.assign({}, deps, { audit, ensureFile, staffRow, httpError, fail }));
  // The employee centre: list, record, transactions, wizard, release and rehire, lists (hr-centre.js).
  require('./hr-centre').register(app, Object.assign({}, deps, { audit, ensureFile, staffRow, httpError, fail, leaveFor, addTasks, ONBOARDING, newStaffUser: hrDocs.newStaffUser }));

  return { audit, onHire, ONBOARDING, OFFBOARDING };
}

module.exports = { register };
