// =============================================================================
//  Vision Auto Solutions -- People & HR, part 2 (registered by hr.js)
//
//  Adding staff from HR: a staff record with its HR file, the login switched
//  off until a manager sets it up on Users & Staff.
//
//  Employment contracts: written here from the staff file (job, start, pay in
//  J$ before PAYE / NIS / NHT / Education Tax, hours, probation, notice,
//  vacation) and sent to the staff member to sign.
//
//  Documents sent to staff to sign (an "envelope" each, hr_signatures): a
//  contract written here, a warning or other letter on the file, or any file
//  in the Document centre (a policy, a handbook). The staff member signs:
//    - in My HR file, signed in as themselves, or
//    - from a private link (emailed, or copied to WhatsApp). Only the link's
//      SHA-256 is stored; it expires; HR may also give an access code
//      separately (by phone), which must be typed before the document opens;
//      five wrong codes lock the link.
//  What is signed is fingerprinted (SHA-256 of the page, or of the file); a
//  file changed after sending cannot be signed. The signature (drawn, with the
//  typed name), the time, the address it came from and every step (sent,
//  opened, signed or declined) are sealed with an HMAC over all of it, like a
//  signed invoice. The signed copy, with that certificate, is filed in the
//  Document centre as restricted, against the staff member, and they can
//  download it from My HR file or from their link for 30 days.
//  No outside service: this is the shop's own signing, not DocuSign. Using
//  DocuSign itself would need an account and API keys.
//
//  QuickBooks: the employee list (IIF !EMP, or CSV from the Employee Contact
//  List / Employees export) and the payroll item list (CSV), previewed
//  against what is here before anything is added or changed, like the
//  supplier import in Payables.
// =============================================================================
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const mailer = require('./mailer');

const CONTRACT_KINDS = { employment: 'Contract of employment', fixed_term: 'Fixed-term contract of employment', amendment: 'Change to terms of employment', confidentiality: 'Confidentiality agreement', other: 'Agreement' };
const SIGN_KINDS = ['contract', 'letter', 'policy', 'other'];
const MAX_CODE_TRIES = 5;

function register(app, deps) {
  const { query, requireAdmin, requireCap, userCan, docs, audit, ensureFile, staffRow, httpError, fail } = deps;
  const P = [requireAdmin, requireCap('hr.people')];
  const me = (req) => req.session.userId;
  const devMode = process.env.VISION_DEV === '1';
  const SECRET = process.env.SESSION_SECRET || (devMode ? 'vision-dev-secret' : null);
  const TILL = (process.env.TILL_PUBLIC_URL || 'https://till.visionautosolutions.com').replace(/\/$/, '');
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const t = (v, m) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, m));
  const d = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
  const n = (v) => { const x = parseInt(v, 10); return Number.isFinite(x) && x > 0 ? x : null; };
  const money = (v) => { if (v == null || v === '') return null; const x = Number(String(v).replace(/[^0-9.]/g, '')); return Number.isFinite(x) && x > 0 ? Math.round(x * 100) / 100 : null; };
  const jmd = (v) => 'J$' + Number(v).toLocaleString('en-JM', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ipOf = (req) => String(req.ip || '').replace(/^::ffff:/, '').slice(0, 64);
  const realEmail = (e) => e && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && !/\.local$/i.test(e);
  const longDate = (v) => (v ? new Date(String(v instanceof Date ? v.toISOString() : v).slice(0, 10) + 'T12:00:00Z').toLocaleDateString('en-JM', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' }) : '');
  const jaTime = (v) => new Date(v).toLocaleString('en-JM', { timeZone: 'America/Jamaica', dateStyle: 'medium', timeStyle: 'short' });
  async function tell(ids, n0) { if (deps.notice && ids.length) await deps.notice(ids, n0).catch(() => {}); }
  async function shop() {
    const { rows } = await query(`SELECT key, value FROM warehouse_settings WHERE key IN ('company_name', 'shop_name', 'company_address', 'company_phone')`).catch(() => ({ rows: [] }));
    const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    return { name: s.company_name || s.shop_name || 'Vision Auto Solutions Ltd', address: s.company_address || '112C Waltham Park Road, Kingston', phone: s.company_phone || '876-728-4735' };
  }

  // ========================================================= adding staff ==
  async function newStaffUser(q, o) {
    let email = t(o.email, 160);
    if (email) {
      email = email.toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw httpError(400, 'That email address does not look right');
    } else {
      // No email: a placeholder login name, never mailed (.local is skipped everywhere).
      email = String(o.name).toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '').slice(0, 40) + '.' + crypto.randomBytes(3).toString('hex') + '@staff.local';
    }
    const { rows: ex } = await q(`SELECT id FROM users WHERE lower(email) = $1`, [email]);
    if (ex.length) throw Object.assign(httpError(409, 'Someone with that email is already on the system'), { user_id: ex[0].id });
    const pw = await require('bcryptjs').hash(crypto.randomBytes(24).toString('base64url'), 10);
    const { rows } = await q(`INSERT INTO users (email, name, phone, password_hash, via, is_admin, is_staff, admin_role, disabled, employee_no, internal_notes)
      VALUES ($1,$2,$3,$4,'hr',false,true,'cashier',true,$5,$6) RETURNING id`, [email, o.name, t(o.phone, 40), pw, t(o.employee_no, 30), o.note || 'Added from People & HR']);
    return rows[0].id;
  }
  app.post('/api/people/staff', ...P, async (req, res) => {
    try {
      const b = req.body || {};
      const name = t(b.name, 120);
      if (!name || name.length < 3) throw httpError(400, 'Their full name');
      let uid;
      try { uid = await newStaffUser(query, { name, email: b.email, phone: b.phone, employee_no: b.employee_no }); }
      catch (e) { if (e.user_id) { e.publicMessage = e.message + '. Open their file instead.'; } throw e; }
      await ensureFile(uid);
      const start = d(b.start_date);
      await query(`UPDATE hr_employees SET job_title = $2, department_id = $3, manager_user_id = $4, start_date = $5, contract_type = COALESCE($6, contract_type),
          status = CASE WHEN $7::int > 0 THEN 'probation' ELSE 'active' END, probation_months = $7::int,
          probation_end = CASE WHEN $7::int > 0 AND $5::date IS NOT NULL THEN ($5::date + make_interval(months => $7::int))::date END, updated_by = $8 WHERE user_id = $1`,
        [uid, t(b.job_title, 120), n(b.department_id), n(b.manager_user_id), start, ['permanent', 'fixed_term', 'part_time', 'casual', 'contractor', 'intern'].includes(b.contract_type) ? b.contract_type : null,
          Math.max(0, Math.min(12, parseInt(b.probation_months, 10) >= 0 ? parseInt(b.probation_months, 10) : 3)), me(req)]);
      if (start) await query(`INSERT INTO hr_job_history (user_id, kind, effective_date, job_title, department_id, manager_user_id, reason, by_user) VALUES ($1, 'start', $2, $3, $4, $5, 'Added from People & HR', $6)`,
        [uid, start, t(b.job_title, 120), n(b.department_id), n(b.manager_user_id), me(req)]);
      await audit({ user_id: uid, entity: 'profile', action: 'staff member added', detail: [name, t(b.job_title, 120)].filter(Boolean).join(' · ') + '. Login off until set up on Users & Staff.', by: me(req) });
      res.json({ id: uid, next: 'Their login is switched off. A manager sets the role, password or PIN on Users & Staff when they need one.' });
    } catch (e) { fail(res, e); }
  });
  // Everyone on the staff list gets an HR file (from what Payroll already has).
  app.post('/api/people/start-files', ...P, async (req, res) => {
    try {
      const { rows } = await query(`SELECT u.id FROM users u WHERE (u.is_staff OR u.is_admin) AND NOT COALESCE(u.is_archived, false) AND NOT EXISTS (SELECT 1 FROM hr_employees h WHERE h.user_id = u.id)`);
      for (const r of rows) await ensureFile(r.id);
      if (rows.length) await audit({ entity: 'profile', action: 'HR files started for ' + rows.length + ' staff', by: me(req) });
      res.json({ started: rows.length });
    } catch (e) { fail(res, e); }
  });

  // ============================================================ contracts ==
  const C_COLS = ['kind', 'title', 'job_title', 'start_date', 'end_date', 'pay_type', 'salary_annual', 'hourly_rate', 'frequency', 'hours', 'probation_months', 'notice_weeks', 'vacation_days', 'terms'];
  function cleanContract(b) {
    const c = { kind: CONTRACT_KINDS[b.kind] ? b.kind : 'employment', job_title: t(b.job_title, 120), start_date: d(b.start_date), end_date: d(b.end_date), pay_type: b.pay_type === 'hourly' ? 'hourly' : 'salary',
      salary_annual: money(b.salary_annual), hourly_rate: money(b.hourly_rate), frequency: ['weekly', 'fortnightly', 'monthly'].includes(b.frequency) ? b.frequency : 'monthly', hours: t(b.hours, 300),
      probation_months: Math.max(0, Math.min(12, parseInt(b.probation_months, 10) || 0)), notice_weeks: Math.max(0, Math.min(52, parseInt(b.notice_weeks, 10) >= 0 ? parseInt(b.notice_weeks, 10) : 2)),
      vacation_days: b.vacation_days === '' || b.vacation_days == null ? null : Math.max(0, Math.min(60, Number(b.vacation_days) || 0)), terms: t(b.terms, 8000) };
    c.title = t(b.title, 160) || CONTRACT_KINDS[c.kind];
    if (['employment', 'fixed_term'].includes(c.kind)) {
      if (!c.job_title) throw httpError(400, 'The job title');
      if (!c.start_date) throw httpError(400, 'The start date');
      if (c.pay_type === 'salary' ? !c.salary_annual : !c.hourly_rate) throw httpError(400, c.pay_type === 'salary' ? 'The yearly salary (J$)' : 'The hourly rate (J$)');
    }
    if (c.kind === 'fixed_term' && !c.end_date) throw httpError(400, 'When the fixed term ends');
    if (c.kind !== 'employment' && c.kind !== 'fixed_term' && !c.terms) throw httpError(400, 'Write what is being agreed');
    if (c.pay_type === 'salary') c.hourly_rate = null; else c.salary_annual = null;
    return c;
  }
  function contractHtml(c, u, s) {
    const emp = ['employment', 'fixed_term'].includes(c.kind);
    const rows = emp ? [['Employer', s.name + ', ' + s.address], ['Employee', u.name || u.email], ['Position', c.job_title], ['Start date', longDate(c.start_date)],
      c.end_date ? ['End date', longDate(c.end_date)] : null, ['Pay', (c.pay_type === 'hourly' ? jmd(c.hourly_rate) + ' an hour' : jmd(c.salary_annual) + ' a year') + ', paid ' + c.frequency + ', before the statutory deductions (PAYE income tax, NIS, NHT and Education Tax)'],
      c.hours ? ['Hours of work', c.hours] : null, ['Probation', c.probation_months ? c.probation_months + ' months, during which either side may end the employment with one week’s notice' : 'None'],
      ['Vacation leave', (c.vacation_days != null ? c.vacation_days + ' working days' : 'As set by the company and the law') + ' a year, with pay; public holidays are paid as the law requires'],
      ['Sick leave', 'As the law requires, with a doctor’s certificate for more than two days in a row'],
      ['Notice', (c.notice_weeks ? c.notice_weeks + ' weeks' : 'As the law requires') + ' in writing by either side, or the longer notice the Employment (Termination and Redundancy Payments) Act requires for their years of service']].filter(Boolean)
      : [['Between', s.name], ['And', u.name || u.email], c.start_date ? ['From', longDate(c.start_date)] : null, c.end_date ? ['Until', longDate(c.end_date)] : null].filter(Boolean);
    return '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(c.title) + '</title><style>body{font:14px/1.6 Arial,sans-serif;max-width:720px;margin:30px auto;color:#111;padding:0 12px}h1{font-size:20px}th{text-align:left;padding:4px 14px 4px 0;vertical-align:top;white-space:nowrap}td{padding:4px 0}</style></head><body>' +
      '<p><b>' + esc(s.name) + '</b><br>' + esc(s.address) + ' · ' + esc(s.phone) + '</p><h1>' + esc(c.title) + '</h1><table>' + rows.map((r) => '<tr><th>' + esc(r[0]) + '</th><td>' + esc(r[1]) + '</td></tr>').join('') + '</table>' +
      (emp ? '<h3>Duties and conduct</h3><p>The employee will do the work of the position and other reasonable duties asked of them, follow the company’s rules and policies, handle the company’s money, stock and customers’ information honestly and keep them confidential, during and after the employment.</p>' +
        '<h3>Deductions</h3><p>The company will take from pay the deductions the law requires, and any other deduction the employee agrees to in writing.</p>' : '') +
      (c.terms ? '<h3>' + (emp ? 'Other terms' : 'What is agreed') + '</h3><p>' + esc(c.terms).replace(/\n/g, '<br>') + '</p>' : '') +
      '<p>By signing, the employee confirms they have read and understood this ' + (emp ? 'contract' : 'agreement') + ' and agree to it.</p></body></html>';
  }
  async function contractRow(cid) {
    const { rows } = await query(`SELECT c.*, to_char(c.start_date, 'YYYY-MM-DD') AS start_date, to_char(c.end_date, 'YYYY-MM-DD') AS end_date, c.salary_annual::float, c.hourly_rate::float, c.vacation_days::float FROM hr_contracts c WHERE c.id = $1`, [cid]);
    if (!rows.length) throw httpError(404, 'Contract not found');
    return rows[0];
  }
  app.get('/api/people/staff/:id/contracts', ...P, async (req, res) => {
    try {
      const { rows } = await query(`SELECT c.*, to_char(c.start_date, 'YYYY-MM-DD') AS start_date, to_char(c.end_date, 'YYYY-MM-DD') AS end_date, c.salary_annual::float, c.hourly_rate::float, c.vacation_days::float, dc.number AS document_number,
          s.status AS sign_status, s.signed_at, s.viewed_at, s.sent_at
        FROM hr_contracts c LEFT JOIN documents dc ON dc.id = c.document_id LEFT JOIN hr_signatures s ON s.id = c.signature_id WHERE c.user_id = $1 ORDER BY c.id DESC`, [n(req.params.id)]);
      res.json({ contracts: rows, kinds: CONTRACT_KINDS });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/people/staff/:id/contracts', ...P, async (req, res) => {
    try {
      const uid = n(req.params.id); await staffRow(uid);
      const c = cleanContract(req.body || {});
      const { rows } = await query(`INSERT INTO hr_contracts (user_id, ${C_COLS.join(', ')}, created_by) VALUES ($1, ${C_COLS.map((k, i) => '$' + (i + 2)).join(', ')}, $${C_COLS.length + 2}) RETURNING id`, [uid].concat(C_COLS.map((k) => c[k]), [me(req)]));
      await audit({ user_id: uid, entity: 'contract', entity_id: rows[0].id, action: 'contract drafted', detail: c.title + (c.start_date ? ' from ' + c.start_date : ''), by: me(req) });
      res.json({ id: rows[0].id });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/people/contracts/:cid', ...P, async (req, res) => {
    try {
      const cur = await contractRow(n(req.params.cid));
      if (!['draft', 'declined'].includes(cur.status)) throw httpError(409, 'Only a draft can be changed. This one is ' + cur.status + '; make a new one (a change to terms) instead.');
      const c = cleanContract(req.body || {});
      await query(`UPDATE hr_contracts SET ${C_COLS.map((k, i) => k + ' = $' + (i + 2)).join(', ')}, status = 'draft', updated_at = NOW() WHERE id = $1`, [cur.id].concat(C_COLS.map((k) => c[k])));
      await audit({ user_id: cur.user_id, entity: 'contract', entity_id: cur.id, action: 'contract changed', detail: c.title, by: me(req) });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/people/contracts/:cid/status', ...P, async (req, res) => {
    try {
      const cur = await contractRow(n(req.params.cid)), to = (req.body || {}).status;
      const allowed = { cancelled: ['draft', 'sent', 'declined'], ended: ['signed'] };
      if (!allowed[to] || !allowed[to].includes(cur.status)) throw httpError(409, 'A contract that is ' + cur.status + ' cannot be marked ' + to);
      await query(`UPDATE hr_contracts SET status = $2, updated_at = NOW() WHERE id = $1`, [cur.id, to]);
      if (to === 'cancelled' && cur.signature_id) await query(`UPDATE hr_signatures SET status = 'cancelled', cancelled_at = NOW(), token_sha256 = NULL WHERE id = $1 AND status = 'sent'`, [cur.signature_id]);
      await audit({ user_id: cur.user_id, entity: 'contract', entity_id: cur.id, action: 'contract ' + to, detail: [cur.title, t((req.body || {}).note, 300)].filter(Boolean).join(' · '), by: me(req) });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/people/contracts/:cid/preview', ...P, async (req, res) => {
    try {
      const c = await contractRow(n(req.params.cid));
      const u = await staffRow(c.user_id);
      res.set('Content-Type', 'text/html; charset=utf-8'); res.set('Cache-Control', 'private, no-store');
      res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
      res.send(contractHtml(c, u, await shop()));
    } catch (e) { fail(res, e); }
  });

  // ================================================ documents to sign ==
  const sealOf = (s) => (SECRET ? crypto.createHmac('sha256', SECRET).update(JSON.stringify([s.id, s.user_id, s.title, s.content_sha256, s.method, s.signer_name,
    new Date(s.signed_at).toISOString(), sha(s.image || ''), s.ip || null, s.sent_to || null, s.sent_at ? new Date(s.sent_at).toISOString() : null])).digest('hex') : null);
  async function envRow(sid) {
    const { rows } = await query(`SELECT s.*, COALESCE(NULLIF(u.name, ''), u.email) AS staff_name, u.email AS staff_email, COALESCE(NULLIF(b.name, ''), b.email) AS sent_by_name,
        sd.number AS source_number, sd.file_name AS source_file, sd.mime AS source_mime, dc.number AS signed_number
      FROM hr_signatures s JOIN users u ON u.id = s.user_id LEFT JOIN users b ON b.id = s.sent_by LEFT JOIN documents sd ON sd.id = s.source_document_id LEFT JOIN documents dc ON dc.id = s.signed_document_id WHERE s.id = $1`, [sid]);
    if (!rows.length) throw httpError(404, 'Not found');
    return rows[0];
  }
  // The public face of an envelope: never the token, code or the drawn signature.
  const pub = (e) => ({ id: e.id, title: e.title, kind: e.kind, message: e.message, staff_name: e.staff_name, status: e.status, sent_at: e.sent_at, sent_by: e.sent_by_name, expires_at: e.expires_at,
    viewed_at: e.viewed_at, signed_at: e.signed_at, signer_name: e.signer_name, method: e.method, declined: e.decline_reason, is_file: !e.html, file_name: e.source_file, mime: e.source_mime,
    source_number: e.source_number, signed_number: e.signed_number, fingerprint: e.content_sha256, needs_code: !!e.code_sha256 });
  async function newLink(sid, days, withCode) {
    const token = crypto.randomBytes(24).toString('base64url');
    const code = withCode ? String(crypto.randomInt(0, 1000000)).padStart(6, '0') : null;
    await query(`UPDATE hr_signatures SET token_sha256 = $2, code_sha256 = $3, code_tries = 0, expires_at = NOW() + ($4 || ' days')::interval WHERE id = $1`, [sid, sha(token), code ? sha(sid + ':' + code) : null, String(days)]);
    return { token, code, link: TILL + '/sign-staff.html?t=' + token };
  }
  async function mailLink(e, link, days) {
    if (!realEmail(e.sent_to) || !mailer.isActive || !mailer.isActive()) return false;
    const s = await shop();
    try {
      await mailer.sendEmail({ to: e.sent_to, subject: 'Please sign: ' + e.title,
        text: 'Hello ' + String(e.staff_name || '').split(' ')[0] + ',\n\n' + s.name + ' has sent you "' + e.title + '" to read and sign.' + (e.message ? '\n\n' + e.message : '') +
          '\n\nOpen it here:\n' + link + '\n\nThe link is for you only and expires in ' + days + ' days.' + (e.code_sha256 ? ' You will be asked for an access code: HR gives it to you separately.' : '') +
          '\nIf you sign in to the staff system, you can also sign it under People & HR > My HR file.\n\n' + s.name + ' · ' + s.phone });
      return true;
    } catch (err) { console.warn('[hr-docs] sign email', err.message); return false; }
  }
  // Send one document to one staff member. What they sign is fixed now (its fingerprint).
  app.post('/api/people/staff/:id/signatures', ...P, async (req, res) => {
    try {
      const uid = n(req.params.id), u = await staffRow(uid), b = req.body || {};
      if (!SECRET) throw httpError(503, 'Signing is not set up on this till (SESSION_SECRET is missing)');
      let title = t(b.title, 200), kind = SIGN_KINDS.includes(b.kind) ? b.kind : 'other', html = null, docId = null, contractId = null, caseId = null;
      if (b.contract_id) {
        const c = await contractRow(n(b.contract_id));
        if (c.user_id !== uid) throw httpError(400, 'That contract is someone else’s');
        if (!['draft', 'declined'].includes(c.status)) throw httpError(409, 'This contract is already ' + c.status);
        html = contractHtml(c, u, await shop()); contractId = c.id; kind = 'contract'; title = title || c.title;
      } else if (b.case_id) {
        const { rows } = await query(`SELECT id, kind, summary, document_id FROM hr_cases WHERE id = $1 AND user_id = $2`, [n(b.case_id), uid]);
        if (!rows.length || !rows[0].document_id) throw httpError(400, 'That record has no letter filed to sign');
        docId = rows[0].document_id; caseId = rows[0].id; kind = 'letter'; title = title || ('Letter: ' + rows[0].summary).slice(0, 200);
      } else if (b.document_id || b.document_number) {
        const { rows } = await query(`SELECT id, title FROM documents WHERE deleted_at IS NULL AND (id = $1 OR number = upper($2))`, [n(b.document_id) || 0, String(b.document_number || '').trim()]);
        if (!rows.length) throw httpError(404, 'No document with that number in the Document centre');
        docId = rows[0].id; title = title || rows[0].title;
      } else throw httpError(400, 'Choose what to send: a contract, a letter on their file, or a document from the Document centre');
      let fingerprint;
      if (docId) {
        const f = await docs.fileOf(docId, req, 'send_to_sign', 'to ' + (u.name || u.email));
        fingerprint = f.sha256;
      } else fingerprint = sha(html);
      const to = t(b.email, 160) || (realEmail(u.email) ? u.email : null) || ((await query(`SELECT personal_email FROM hr_employees WHERE user_id = $1`, [uid])).rows[0] || {}).personal_email || null;
      const days = Math.max(1, Math.min(60, parseInt(b.days, 10) || 14));
      const { rows } = await query(`INSERT INTO hr_signatures (user_id, title, kind, contract_id, case_id, source_document_id, html, content_sha256, message, sent_to, sent_by, expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, NOW() + ($12 || ' days')::interval) RETURNING id`,
        [uid, title, kind, contractId, caseId, docId, html, fingerprint, t(b.message, 2000), to, me(req), String(days)]);
      const sid = rows[0].id;
      const l = await newLink(sid, days, !!b.code);
      if (contractId) await query(`UPDATE hr_contracts SET status = 'sent', signature_id = $2, updated_at = NOW() WHERE id = $1`, [contractId, sid]);
      const e = await envRow(sid);
      const emailed = await mailLink(e, l.link, days);
      await tell([uid], { kind: 'memo', title: '✍ Please sign: ' + title, body: 'Open My HR file to read and sign it.', link: '/people.html#me' });
      await audit({ user_id: uid, entity: 'signature', entity_id: sid, action: 'sent to sign', detail: title + (emailed ? ' · link emailed to ' + to : ' · link not emailed') + (l.code ? ' · with an access code' : ''), by: me(req) });
      res.json({ id: sid, link: l.link, code: l.code, emailed, sent_to: to, expires_in_days: days });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/people/staff/:id/signatures', ...P, async (req, res) => {
    try {
      const { rows } = await query(`SELECT id FROM hr_signatures WHERE user_id = $1 ORDER BY id DESC`, [n(req.params.id)]);
      const out = [];
      for (const r of rows) { const e = await envRow(r.id); out.push(Object.assign(pub(e), { sent_to: e.sent_to, sealed: e.status === 'signed' ? sealOf(e) === e.seal : null, contract_id: e.contract_id, case_id: e.case_id, code_locked: e.code_tries >= MAX_CODE_TRIES })); }
      res.json({ signatures: out });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/people/signatures/:sid/cancel', ...P, async (req, res) => {
    try {
      const e = await envRow(n(req.params.sid));
      if (e.status !== 'sent') throw httpError(409, 'It is already ' + e.status);
      await query(`UPDATE hr_signatures SET status = 'cancelled', cancelled_at = NOW(), token_sha256 = NULL WHERE id = $1`, [e.id]);
      if (e.contract_id) await query(`UPDATE hr_contracts SET status = 'draft', signature_id = NULL WHERE id = $1 AND status = 'sent'`, [e.contract_id]);
      await audit({ user_id: e.user_id, entity: 'signature', entity_id: e.id, action: 'signing cancelled', detail: e.title, by: me(req) });
      res.json({ ok: true });
    } catch (err) { fail(res, err); }
  });
  // A new link (the old one stops working), for a lost email or a locked code.
  app.post('/api/people/signatures/:sid/resend', ...P, async (req, res) => {
    try {
      const e = await envRow(n(req.params.sid)), b = req.body || {};
      if (e.status !== 'sent') throw httpError(409, 'It is already ' + e.status);
      const days = Math.max(1, Math.min(60, parseInt(b.days, 10) || 14));
      if (t(b.email, 160)) await query(`UPDATE hr_signatures SET sent_to = $2 WHERE id = $1`, [e.id, t(b.email, 160)]);
      const l = await newLink(e.id, days, b.code != null ? !!b.code : !!e.code_sha256);
      const emailed = await mailLink(await envRow(e.id), l.link, days);
      await audit({ user_id: e.user_id, entity: 'signature', entity_id: e.id, action: 'new signing link', detail: e.title + (emailed ? ' · emailed' : ''), by: me(req) });
      res.json({ link: l.link, code: l.code, emailed });
    } catch (err) { fail(res, err); }
  });

  // ---- the signed copy, with its certificate
  function signedHtml(e, s) {
    const steps = [['Sent by', (e.sent_by_name || '') + ', ' + jaTime(e.sent_at) + (e.sent_to ? ', link to ' + e.sent_to : '')], e.viewed_at ? ['First opened', jaTime(e.viewed_at)] : null,
      ['Signed', jaTime(e.signed_at) + ' by ' + e.signer_name + (e.method === 'in_app' ? ', signed in to the staff system as ' + e.staff_name : ', from the private link') + (e.ip ? ', from ' + e.ip : '')]].filter(Boolean);
    return '<!doctype html><html><head><meta charset="utf-8"><title>Signed: ' + esc(e.title) + '</title><style>body{font:14px/1.55 Arial,sans-serif;max-width:740px;margin:24px auto;color:#111;padding:0 12px}.box{border:1px solid #999;padding:12px;margin-top:18px}.box img{max-width:340px;height:auto;border-bottom:1px solid #333;display:block}.small{color:#555;font-size:11.5px;word-break:break-all}th{text-align:left;padding:3px 12px 3px 0;vertical-align:top;white-space:nowrap}</style></head><body>' +
      '<p class="small">' + esc(s.name) + ' · signed document</p>' +
      (e.html ? '<div>' + e.html.replace(/^[\s\S]*?<body>/i, '').replace(/<\/body>[\s\S]*$/i, '') + '</div>'
        : '<h1 style="font-size:19px">' + esc(e.title) + '</h1><p>The document signed is ' + esc(e.source_number || '') + ' “' + esc(e.source_file || e.title) + '” in the Document centre. Its fingerprint (SHA-256) is below: the same file always gives the same fingerprint, so any change to it shows.</p>') +
      '<div class="box"><p style="margin-top:0">I have read and agree to “' + esc(e.title) + '”.</p><img alt="Signature" src="' + e.image + '"><p><b>' + esc(e.signer_name) + '</b> · ' + esc(jaTime(e.signed_at)) + '</p>' +
      '<p><b>Certificate</b></p><table class="small">' + steps.map((r) => '<tr><th>' + esc(r[0]) + '</th><td>' + esc(r[1]) + '</td></tr>').join('') +
      '<tr><th>Fingerprint</th><td>' + esc(e.content_sha256) + '</td></tr><tr><th>Seal</th><td>' + esc(e.seal) + '</td></tr></table></div></body></html>';
  }
  async function sign(req, e, b, method) {
    if (!SECRET) throw httpError(503, 'Signing is not set up on this till');
    if (e.status !== 'sent') throw httpError(410, e.status === 'signed' ? 'This is already signed. Thank you.' : 'This is no longer waiting for your signature.');
    if (new Date(e.expires_at) <= new Date() && method === 'link') throw httpError(410, 'This link has expired. Please ask HR for a new one.');
    if (b.agree !== true) throw httpError(400, 'Tick the box to confirm you have read it');
    const name = t(b.name, 100);
    if (!name || name.length < 2) throw httpError(400, 'Type your full name');
    const image = String(b.image || ''), m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(image);
    if (!m || m[1].length > 400000) throw httpError(400, 'Sign in the box first');
    const png = Buffer.from(m[1], 'base64');
    if (png.length < 200 || png.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') throw httpError(400, 'Sign in the box first');
    // What they sign must be what was sent.
    const now = e.html ? sha(e.html) : (await docs.fileOf(e.source_document_id)).sha256;
    if (now !== e.content_sha256) throw httpError(409, 'The document has changed since it was sent. Please ask HR to send it again.');
    // Claim it first, so two taps cannot sign twice.
    const at = new Date();
    const { rowCount } = await query(`UPDATE hr_signatures SET status = 'signed', signed_at = $2, method = $3, signer_name = $4, image = $5, ip = $6, user_agent = $7 WHERE id = $1 AND status = 'sent'`,
      [e.id, at, method, name, image, ipOf(req), String(req.headers['user-agent'] || '').slice(0, 300)]);
    if (!rowCount) throw httpError(410, 'This is already signed.');
    const done = Object.assign({}, e, { status: 'signed', signed_at: at, method, signer_name: name, image, ip: ipOf(req) });
    done.seal = sealOf(done);
    await query(`UPDATE hr_signatures SET seal = $2 WHERE id = $1`, [e.id, done.seal]);
    let doc = null;
    try {
      doc = await docs.fileHtml(req, { title: 'Signed: ' + e.title + ' - ' + e.staff_name, category: e.kind === 'contract' ? 'contract' : 'staff', confidentiality: 'restricted', issuer: name,
        issue_date: at.toISOString().slice(0, 10), tags: 'signed', html: signedHtml(done, await shop()), file_name: 'Signed ' + e.title, note: method === 'in_app' ? 'Signed in My HR file' : 'Signed from a link',
        links: [{ type: 'staff', id: e.user_id }] });
      await query(`UPDATE hr_signatures SET signed_document_id = $2 WHERE id = $1`, [e.id, doc.id]);
      if (e.source_document_id) await query(`INSERT INTO document_links (document_id, entity_type, entity_id, label) VALUES ($1, 'staff', $2, $3) ON CONFLICT DO NOTHING`, [e.source_document_id, String(e.user_id), e.staff_name]).catch(() => {});
    } catch (err) { console.error('[hr-docs] filing the signed copy', err.message); }
    if (e.contract_id) await query(`UPDATE hr_contracts SET status = 'signed', document_id = $2, updated_at = NOW() WHERE id = $1`, [e.contract_id, doc ? doc.id : null]);
    if (e.case_id) await query(`UPDATE hr_cases SET acknowledged_at = COALESCE(acknowledged_at, NOW()) WHERE id = $1`, [e.case_id]);
    await audit({ user_id: e.user_id, entity: 'signature', entity_id: e.id, action: 'signed', detail: e.title + ' · by ' + name + (method === 'in_app' ? ' in My HR file' : ' from the link, ' + ipOf(req)) + (doc ? ' · filed as ' + doc.number : ''), by: method === 'in_app' ? e.user_id : null });
    if (e.sent_by && e.sent_by !== e.user_id) await tell([e.sent_by], { kind: 'memo', title: '✅ Signed: ' + e.title + ' (' + e.staff_name + ')', link: '/people.html#staff=' + e.user_id });
    // Their own copy: in My HR file, and by email from the same private link.
    if (method === 'link' && realEmail(e.sent_to) && mailer.isActive && mailer.isActive()) {
      mailer.sendEmail({ to: e.sent_to, subject: 'Your signed copy: ' + e.title, text: 'Thank you for signing "' + e.title + '". You can download your signed copy for 30 days from the same private link you used to sign. It is also in People & HR > My HR file.' }).catch(() => {});
    }
    await query(`UPDATE hr_signatures SET expires_at = GREATEST(expires_at, NOW() + interval '30 days') WHERE id = $1`, [e.id]);
    return { document: doc };
  }
  async function decline(req, e, reason, method) {
    if (e.status !== 'sent') throw httpError(410, 'This is no longer waiting for your signature.');
    const why = t(reason, 1000);
    if (!why) throw httpError(400, 'Say why you are not signing, so HR can follow up');
    await query(`UPDATE hr_signatures SET status = 'declined', decline_reason = $2, signed_at = NULL, method = $3, ip = $4 WHERE id = $1 AND status = 'sent'`, [e.id, why, method, ipOf(req)]);
    if (e.contract_id) await query(`UPDATE hr_contracts SET status = 'declined' WHERE id = $1`, [e.contract_id]);
    await audit({ user_id: e.user_id, entity: 'signature', entity_id: e.id, action: 'declined to sign', detail: e.title + ' · ' + why, by: method === 'in_app' ? e.user_id : null });
    if (e.sent_by) await tell([e.sent_by], { kind: 'memo', title: '❌ Not signed: ' + e.title + ' (' + e.staff_name + ')', body: why, link: '/people.html#staff=' + e.user_id });
  }
  async function viewed(e) { if (!e.viewed_at) await query(`UPDATE hr_signatures SET viewed_at = NOW() WHERE id = $1 AND viewed_at IS NULL`, [e.id]); }
  // The document itself, locked down: a page cannot run scripts, a file is sent as itself.
  async function sendContent(req, res, e, who) {
    await viewed(e);
    res.set('Cache-Control', 'private, no-store'); res.set('X-Content-Type-Options', 'nosniff'); res.set('Referrer-Policy', 'no-referrer');
    res.set('Content-Security-Policy', "default-src 'none'; img-src data: 'self'; style-src 'unsafe-inline'; sandbox");
    if (e.html) { res.set('Content-Type', 'text/html; charset=utf-8'); return res.send(e.html); }
    const f = await docs.fileOf(e.source_document_id, req, 'view_to_sign', who);
    if (f.sha256 !== e.content_sha256) throw httpError(409, 'The document has changed since it was sent. Please ask HR to send it again.');
    const mime = /\.html?$/i.test(f.storage) ? 'text/html; charset=utf-8' : (f.mime || 'application/octet-stream');
    const inline = /^(application\/pdf|image\/(png|jpe?g|gif|webp)|text\/html)/i.test(mime);
    res.set('Content-Type', inline ? mime : 'application/octet-stream');
    res.set('Content-Disposition', (inline ? 'inline' : 'attachment') + '; filename="' + String(f.file_name || f.number).replace(/[^\w.\- ()]/g, '_') + '"');
    fs.createReadStream(f.abs).pipe(res);
  }
  function sendCopy(res, e, s) {
    if (e.status !== 'signed') throw httpError(404, 'Not signed yet');
    res.set('Cache-Control', 'private, no-store'); res.set('Content-Type', 'text/html; charset=utf-8'); res.set('Referrer-Policy', 'no-referrer');
    res.set('Content-Security-Policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'");
    res.set('Content-Disposition', 'inline; filename="' + ('Signed ' + e.title).replace(/[^\w.\- ()]/g, '_') + '.html"');
    res.send(signedHtml(e, s));
  }
  app.get('/api/people/signatures/:sid/copy', ...P, async (req, res) => {
    try { sendCopy(res, await envRow(n(req.params.sid)), await shop()); } catch (e) { fail(res, e); }
  });

  // ---- signing in My HR file (signed in as themselves)
  async function mine(req) {
    const e = await envRow(n(req.params.sid));
    if (e.user_id !== me(req)) throw httpError(404, 'Not found');
    return e;
  }
  app.get('/api/people/me/signatures', requireAdmin, async (req, res) => {
    try {
      const { rows } = await query(`SELECT id FROM hr_signatures WHERE user_id = $1 AND status <> 'cancelled' ORDER BY (status = 'sent') DESC, id DESC`, [me(req)]);
      const out = [];
      for (const r of rows) out.push(pub(await envRow(r.id)));
      res.json({ signatures: out });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/people/me/signatures/:sid/content', requireAdmin, async (req, res) => {
    try { const e = await mine(req); if (e.status === 'cancelled') throw httpError(410, 'Cancelled'); await sendContent(req, res, e, 'by the staff member'); } catch (e) { fail(res, e); }
  });
  app.post('/api/people/me/signatures/:sid/sign', requireAdmin, async (req, res) => {
    try { res.json(Object.assign({ ok: true }, await sign(req, await mine(req), req.body || {}, 'in_app'))); } catch (e) { fail(res, e); }
  });
  app.post('/api/people/me/signatures/:sid/decline', requireAdmin, async (req, res) => {
    try { await decline(req, await mine(req), (req.body || {}).reason, 'in_app'); res.json({ ok: true }); } catch (e) { fail(res, e); }
  });
  app.get('/api/people/me/signatures/:sid/copy', requireAdmin, async (req, res) => {
    try { sendCopy(res, await mine(req), await shop()); } catch (e) { fail(res, e); }
  });

  // ---- signing from the private link (no sign-in: the link, and the code if set, are the key)
  const tries = new Map();
  function limited(req) {
    const k = ipOf(req), now = Date.now(), list = (tries.get(k) || []).filter((x) => now - x < 600000);
    list.push(now); tries.set(k, list);
    if (tries.size > 5000) tries.clear();
    return list.length > 60;
  }
  async function byToken(req, needCode) {
    if (limited(req)) throw httpError(429, 'Too many tries. Wait a few minutes.');
    const tok = String(req.params.token || '');
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(tok)) throw httpError(404, 'This link is not valid');
    const { rows } = await query(`SELECT id FROM hr_signatures WHERE token_sha256 = $1`, [sha(tok)]);
    if (!rows.length) throw httpError(404, 'This link is not valid, or a newer one was sent');
    const e = await envRow(rows[0].id);
    if (e.status === 'cancelled') throw httpError(410, 'This was withdrawn. Please speak to HR.');
    if (new Date(e.expires_at) <= new Date()) throw httpError(410, e.status === 'signed' ? 'Your copy is no longer available from this link. It is in My HR file.' : 'This link has expired. Please ask HR for a new one.');
    if (needCode && e.code_sha256) {
      if (e.code_tries >= MAX_CODE_TRIES) throw httpError(423, 'Too many wrong codes: this link is locked. Please ask HR for a new one.');
      const code = String(req.get('x-access-code') || (req.body || {}).code || req.query.code || '').replace(/\D/g, '');
      if (sha(e.id + ':' + code) !== e.code_sha256) {
        await query(`UPDATE hr_signatures SET code_tries = code_tries + 1 WHERE id = $1`, [e.id]);
        throw Object.assign(httpError(401, code ? 'That access code is not right' : 'Type the access code HR gave you'), { needs_code: true });
      }
    }
    return e;
  }
  app.get('/api/public/staff-sign/:token', async (req, res) => {
    try {
      const e = await byToken(req, false), s = await shop();
      res.set('Cache-Control', 'no-store');
      const p = pub(e);
      // Before the code: only what it is, not who it is for.
      if (e.code_sha256) { delete p.staff_name; delete p.message; delete p.signer_name; }
      res.json(Object.assign(p, { shop: { name: s.name, phone: s.phone } }));
    } catch (e) { fail(res, e); }
  });
  app.post('/api/public/staff-sign/:token/check', async (req, res) => {
    try { const e = await byToken(req, true); res.json(pub(e)); } catch (e) { res.status(e.status || 500).json({ error: e.publicMessage || e.message, needs_code: !!e.needs_code }); }
  });
  app.get('/api/public/staff-sign/:token/content', async (req, res) => {
    try { await sendContent(req, res, await byToken(req, true), 'from the signing link'); } catch (e) { fail(res, e); }
  });
  app.post('/api/public/staff-sign/:token/sign', async (req, res) => {
    try { res.json(Object.assign({ ok: true }, await sign(req, await byToken(req, true), req.body || {}, 'link'))); } catch (e) { fail(res, e); }
  });
  app.post('/api/public/staff-sign/:token/decline', async (req, res) => {
    try { await decline(req, await byToken(req, true), (req.body || {}).reason, 'link'); res.json({ ok: true }); } catch (e) { fail(res, e); }
  });
  app.get('/api/public/staff-sign/:token/copy', async (req, res) => {
    try { sendCopy(res, await byToken(req, true), await shop()); } catch (e) { fail(res, e); }
  });

  // ================================================ QuickBooks import ==
  function parseCsv(text) {
    const rows = []; let row = [], cell = '', q = false;
    const s = String(text || '').replace(/^﻿/, '');
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (q) { if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
      else if (ch === '"') q = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some((c) => c.trim() !== '')) rows.push(row); row = []; }
      else cell += ch;
    }
    row.push(cell); if (row.some((c) => c.trim() !== '')) rows.push(row);
    return rows;
  }
  function iifRows(text, kind) {
    const out = []; let head = null;
    for (const line of String(text).split(/\r?\n/)) {
      const c = line.split('\t').map((x) => x.replace(/^"|"$/g, '').trim());
      if (c[0] === '!' + kind) head = c.map((x) => x.toUpperCase());
      else if (c[0] === kind && head) out.push(Object.fromEntries(head.map((h, i) => [h, c[i] || ''])));
    }
    return out;
  }
  function headingRow(rows, alts) {
    for (let i = 0; i < Math.min(rows.length, 15); i++) {
      const h = rows[i].map((c) => c.trim().toLowerCase().replace(/[.:#]+$/, '').replace(/\s+/g, ' '));
      if (h.some((x) => alts.includes(x))) return { i, h };
    }
    return null;
  }
  // Dates as QuickBooks writes them (12/31/2024 in Desktop, 2024-12-31 in Online exports).
  function qbDate(v) {
    v = String(v || '').trim();
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(v);
    if (m) return m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
    m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/.exec(v);
    if (!m) return null;
    const y = m[3].length === 2 ? '20' + m[3] : m[3];
    let mo = +m[1], dy = +m[2];
    if (mo > 12) [mo, dy] = [dy, mo];          // 31/12/2024
    if (mo < 1 || mo > 12 || dy < 1 || dy > 31) return null;
    return y + '-' + String(mo).padStart(2, '0') + '-' + String(dy).padStart(2, '0');
  }
  const num = (v) => { const x = Number(String(v || '').replace(/[^0-9.\-]/g, '')); return Number.isFinite(x) && x > 0 ? Math.round(x * 100) / 100 : null; };
  const EMP_COLS = {
    name: ['employee', 'name', 'full name', 'display name', 'employee name', 'print on check as'], first: ['first name', 'first'], last: ['last name', 'last'],
    phone: ['phone', 'main phone', 'work phone', 'phone numbers', 'home phone', 'phone 1'], mobile: ['mobile', 'cell', 'mobile phone', 'phone 2'], email: ['email', 'main email', 'e-mail', 'email address'],
    address: ['address', 'street', 'street address', 'address 1', 'billing address'], city: ['city', 'town'], parish: ['parish', 'state', 'state/province', 'province'],
    trn: ['ss no', 'ssn', 'social security no', 'trn', 'tax id', 'tax registration number', 'taxpayer registration number'], nis: ['nis', 'nis no', 'nis number', 'national insurance no'],
    dob: ['birth date', 'date of birth', 'birthday', 'birthdate', 'dob'], hired: ['hire date', 'hired', 'date hired', 'start date'], released: ['release date', 'released', 'termination date', 'date released'],
    gender: ['gender', 'sex'], type: ['employee type', 'type'], title: ['job title', 'title', 'job'], department: ['department', 'class'], employee_no: ['employee id', 'employee no', 'employee #', 'account no', 'employee number'],
    rate: ['hourly rate', 'pay rate', 'rate', 'hourly wage'], salary: ['salary', 'annual salary', 'yearly salary'],
  };
  function parseEmployees(text) {
    const s = String(text || '');
    if (/^!EMP\t/m.test(s)) {
      return iifRows(s, 'EMP').map((e) => ({
        name: e.NAME || [e.FIRSTNAME, e.LASTNAME].filter(Boolean).join(' '), phone: e.PHONE1 || '', mobile: e.PHONE2 || '', email: e.EMAIL || '',
        address: ['ADDR1', 'ADDR2', 'ADDR3', 'ADDR4', 'ADDR5', 'CITY'].map((k) => e[k]).filter(Boolean).join(', '), parish: e.STATE || '', trn: e.SSNO || '', nis: '',
        dob: qbDate(e.BIRTHDATE || e.DOB), hired: qbDate(e.HIREDATE), released: qbDate(e.RELEASEDATE), gender: e.GENDER || '', type: e.EMPTYPE || e.EMPLOYEETYPE || '', title: e.TITLE || '',
        department: '', employee_no: e.ACCNUM || e.EMPNUM || '', rate: null, salary: null,
      })).filter((e) => e.name);
    }
    const rows = parseCsv(s);
    const hr = headingRow(rows, EMP_COLS.name.concat(EMP_COLS.first));
    if (!hr) throw httpError(400, 'This does not look like a QuickBooks employee list: no Employee or Name heading. Export the Employee Contact List as CSV (or the employee list as IIF).');
    const col = {}; for (const k of Object.keys(EMP_COLS)) col[k] = EMP_COLS[k].map((a) => hr.h.indexOf(a)).find((i) => i >= 0);
    const get = (r, k) => (col[k] != null && col[k] >= 0 ? String(r[col[k]] || '').trim() : '');
    return rows.slice(hr.i + 1).map((r) => ({
      name: get(r, 'name') || [get(r, 'first'), get(r, 'last')].filter(Boolean).join(' '), phone: get(r, 'phone'), mobile: get(r, 'mobile'), email: get(r, 'email'),
      address: [get(r, 'address'), get(r, 'city')].filter(Boolean).join(', '), parish: get(r, 'parish'), trn: get(r, 'trn'), nis: get(r, 'nis'), dob: qbDate(get(r, 'dob')), hired: qbDate(get(r, 'hired')),
      released: qbDate(get(r, 'released')), gender: get(r, 'gender'), type: get(r, 'type'), title: get(r, 'title'), department: get(r, 'department'), employee_no: get(r, 'employee_no'),
      rate: num(get(r, 'rate')), salary: num(get(r, 'salary')),
    })).filter((e) => e.name && !/^total\b/i.test(e.name));
  }
  const gender = (g) => (/^f/i.test(g) ? 'female' : /^m/i.test(g) ? 'male' : g ? 'other' : null);
  const empType = (v) => (/officer/i.test(v) ? 'officer' : /owner/i.test(v) ? 'owner' : /statutory/i.test(v) ? 'statutory' : v ? 'regular' : null);
  const same = (a, b) => String(a == null ? '' : a).trim().replace(/\s+/g, ' ').toLowerCase() === String(b == null ? '' : b).trim().replace(/\s+/g, ' ').toLowerCase();
  // [where, column, file field, label]: what a QuickBooks row fills in.
  const IMP_FIELDS = [['user', 'phone', 'phone', 'Phone'], ['user', 'employee_no', 'employee_no', 'Employee no.'], ['hr', 'mobile', 'mobile', 'Mobile'], ['hr', 'address', 'address', 'Address'],
    ['hr', 'parish', 'parish', 'Parish'], ['hr', 'date_of_birth', 'dob', 'Date of birth'], ['hr', 'start_date', 'hired', 'Hire date'], ['hr', 'release_date', 'released', 'Release date'],
    ['hr', 'gender', 'gender_v', 'Gender'], ['hr', 'employee_type', 'type_v', 'Employee type'], ['hr', 'job_title', 'title', 'Job title'], ['hr', 'personal_email', 'email', 'Email'],
    ['pay', 'trn', 'trn', 'TRN'], ['pay', 'nis_no', 'nis', 'NIS no.'], ['pay', 'hourly_rate', 'rate', 'Hourly rate'], ['pay', 'salary_annual', 'salary', 'Yearly salary']];
  async function empPreview(text, canPay) {
    const list = parseEmployees(text);
    const { rows: staff } = await query(`SELECT u.id, u.name, u.email, u.phone, u.employee_no, h.mobile, h.address, h.parish, to_char(h.date_of_birth, 'YYYY-MM-DD') AS date_of_birth, to_char(h.start_date, 'YYYY-MM-DD') AS start_date,
        to_char(h.release_date, 'YYYY-MM-DD') AS release_date, h.gender, h.employee_type, h.job_title, h.personal_email, h.qb_name, p.id AS payroll_id, p.trn, p.nis_no, p.hourly_rate::float, p.salary_annual::float
      FROM users u LEFT JOIN hr_employees h ON h.user_id = u.id LEFT JOIN payroll_employees p ON p.user_id = u.id WHERE u.is_staff OR u.is_admin OR u.archived_at IS NOT NULL`);
    const byEmail = new Map(), byName = new Map();
    for (const s of staff) { if (s.email) byEmail.set(s.email.toLowerCase(), s); for (const k of [s.qb_name, s.name]) if (k && !byName.has(k.trim().toLowerCase())) byName.set(k.trim().toLowerCase(), s); }
    const seen = new Set();
    return list.map((e, i) => {
      const row = Object.assign({ i }, e, { name: e.name.slice(0, 120), gender_v: gender(e.gender), type_v: empType(e.type) });
      const key = row.name.toLowerCase();
      if (seen.has(key)) return Object.assign(row, { status: 'duplicate', reason: 'Twice in the file' });
      seen.add(key);
      const m = (e.email && byEmail.get(e.email.toLowerCase())) || byName.get(key);
      if (!m) return Object.assign(row, { status: 'new' });
      const changes = [];
      for (const [where, colName, k, label] of IMP_FIELDS) {
        const to = row[k];
        if (to == null || to === '') continue;
        if (where === 'pay' && (!canPay || !m.payroll_id)) continue;
        if (colName === 'personal_email' && same(m.email, to)) continue;
        const from = m[colName];
        if (typeof to === 'number' ? Number(from) !== to : !same(from, to)) changes.push({ where, field: colName, label, from: from == null ? '' : from, to });
      }
      return Object.assign(row, { status: changes.length ? 'changed' : 'same', user_id: m.id, existing: m.name, changes });
    });
  }
  app.post('/api/people/import/employees', ...P, async (req, res) => {
    try {
      const b = req.body || {}, canPay = await userCan(req, 'payroll.run');
      const rows = await empPreview(String(b.file || '').slice(0, 5000000), canPay);
      if (!rows.length) throw httpError(400, 'No employees found in the file');
      if (b.preview) return res.json({ rows, payroll: canPay });
      const take = new Set((Array.isArray(b.include) ? b.include : []).map(Number));
      const out = { added: 0, updated: 0, left: 0 };
      for (const e of rows.filter((x) => take.has(x.i))) {
        if (e.status === 'new') {
          let email = realEmail(e.email) ? e.email : null;
          if (email && (await query(`SELECT 1 FROM users WHERE lower(email) = lower($1)`, [email])).rows.length) email = null;   // a customer with that email: keep them apart
          const uid = await newStaffUser(query, { name: e.name, email, phone: e.phone, employee_no: e.employee_no, note: 'Imported from QuickBooks' });
          await ensureFile(uid);
          const gone = e.released && e.released <= new Date().toISOString().slice(0, 10);
          await query(`UPDATE hr_employees SET mobile = $2, address = $3, parish = $4, date_of_birth = $5, start_date = $6, release_date = $7, gender = $8, employee_type = COALESCE($9, employee_type), job_title = $10,
              personal_email = $11, qb_name = $12, status = $13, updated_by = $14 WHERE user_id = $1`,
            [uid, t(e.mobile, 40), t(e.address, 300), t(e.parish, 40), e.dob, e.hired, e.released, e.gender_v, e.type_v, t(e.title, 120), realEmail(e.email) ? e.email : null, e.name, gone ? 'left' : 'active', me(req)]);
          if (gone) await query(`UPDATE users SET is_archived = true, archived_at = NOW(), left_on = $2, archive_reason = 'Released in QuickBooks' WHERE id = $1`, [uid, e.released]);
          if (canPay && (e.trn || e.nis || e.rate || e.salary)) {
            await query(`INSERT INTO payroll_employees (user_id, name, email, phone, address, trn, nis_no, date_of_birth, hire_date, termination_date, job_title, pay_type, salary_annual, hourly_rate, is_active, notes, updated_by)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,false,'Imported from QuickBooks: check pay and bank details, then switch on',$15) ON CONFLICT (user_id) DO NOTHING`,
              [uid, e.name, realEmail(e.email) ? e.email : null, t(e.phone, 40), t(e.address, 300), t(e.trn, 20), t(e.nis, 20), e.dob, e.hired, e.released, t(e.title, 120), e.salary ? 'salary' : 'hourly', e.salary, e.rate, me(req)]);
          }
          await audit({ user_id: uid, entity: 'profile', action: 'imported from QuickBooks', detail: e.name + (gone ? ' (released ' + e.released + ', archived)' : ''), by: me(req) });
          out.added++; if (gone) out.left++;
        } else if (e.status === 'changed') {
          await ensureFile(e.user_id);
          const by = { user: [], hr: [], pay: [] };
          for (const c of e.changes) by[c.where].push(c);
          const set = async (table, key, list) => { if (list.length) await query(`UPDATE ${table} SET ${list.map((c, k) => c.field + ' = $' + (k + 2)).join(', ')} WHERE ${key} = $1`, [e.user_id].concat(list.map((c) => c.to))); };
          await set('users', 'id', by.user); await set('hr_employees', 'user_id', by.hr); await set('payroll_employees', 'user_id', by.pay);
          await query(`UPDATE hr_employees SET qb_name = $2 WHERE user_id = $1`, [e.user_id, e.name]);
          await audit({ user_id: e.user_id, entity: 'profile', action: 'updated from QuickBooks', detail: e.changes.map((c) => c.label).join(', '), by: me(req) });
          out.updated++;
        }
      }
      res.json(Object.assign({ ok: true }, out));
    } catch (e) { fail(res, e); }
  });

  // ---- Payroll items (Payroll Item Listing as CSV). Taxes are worked out here, not imported.
  function parseItems(text) {
    const rows = parseCsv(text);
    const hr = headingRow(rows, ['payroll item', 'item', 'name', 'item name']);
    if (!hr) throw httpError(400, 'This does not look like a QuickBooks Payroll Item Listing: no Payroll Item heading. In QuickBooks run Lists > Payroll Item Listing and save it as CSV.');
    const ci = ['payroll item', 'item', 'name', 'item name'].map((a) => hr.h.indexOf(a)).find((i) => i >= 0), ti = hr.h.indexOf('type');
    return rows.slice(hr.i + 1).map((r) => ({ label: String(r[ci] || '').trim(), type: ti >= 0 ? String(r[ti] || '').trim() : '' })).filter((x) => x.label && !/^total\b/i.test(x.label));
  }
  function itemKind(type, label) {
    const s = (type + ' ' + label).toLowerCase();
    if (/\b(paye|income tax|nis|nht|education tax|ed tax|heart|federal|state|medicare|social security|withholding|unemployment)\b/.test(s)) return { skip: 'A statutory tax: Vision payroll works it out by the TAJ rules' };
    if (/contribution|employer|company/.test(s)) return { kind: 'employer' };
    if (/deduction|loan|advance|union|insurance|garnish|repay|pension|savings/.test(s)) return { kind: 'deduction' };
    if (/salary|wage|hourly|overtime|bonus|commission|allowance|addition|holiday|vacation|sick|pay|tip|incentive/.test(s)) return { kind: 'earning' };
    return { skip: 'Not sure what kind it is: add it by hand in Payroll if needed' };
  }
  app.post('/api/people/import/payroll-items', requireAdmin, requireCap('payroll.run'), async (req, res) => {
    try {
      const b = req.body || {};
      const list = parseItems(String(b.file || '').slice(0, 2000000));
      if (!list.length) throw httpError(400, 'No payroll items found in the file');
      const { rows: have } = await query(`SELECT code, label, kind FROM payroll_items`);
      const seen = new Set();
      const rows = list.map((x, i) => {
        const k = itemKind(x.type, x.label), key = x.label.toLowerCase();
        const r = Object.assign({ i }, x, k);
        if (seen.has(key)) return Object.assign(r, { status: 'duplicate', reason: 'Twice in the file' });
        seen.add(key);
        const m = have.find((h) => same(h.label, x.label));
        if (m) return Object.assign(r, { status: 'same', code: m.code, reason: 'Already in Payroll as ' + m.label });
        return Object.assign(r, { status: k.skip ? 'skip' : 'new', reason: k.skip || null });
      });
      if (b.preview) return res.json({ rows });
      const take = new Set((Array.isArray(b.include) ? b.include : []).map(Number));
      let added = 0;
      for (const x of rows.filter((r) => r.status === 'new' && take.has(r.i))) {
        let code = 'qb_' + x.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30);
        while (have.some((h) => h.code === code)) code += '_';
        // Earnings count for every statutory deduction; a deduction or employer item for none, until someone ticks otherwise in Payroll.
        const taxed = x.kind === 'earning';
        await query(`INSERT INTO payroll_items (code, label, kind, paye, nis, nht, ed, heart, is_system, is_active, sort) VALUES ($1,$2,$3,$4,$4,$4,$4,$4,false,true,200)`, [code, x.label.slice(0, 80), x.kind, taxed]);
        have.push({ code, label: x.label, kind: x.kind });
        added++;
      }
      if (added) await audit({ entity: 'payroll', action: added + ' payroll item(s) imported from QuickBooks', by: me(req) });
      res.json({ ok: true, added });
    } catch (e) { fail(res, e); }
  });

  return { newStaffUser };
}

module.exports = { register };
