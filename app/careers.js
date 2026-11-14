// =============================================================================
//  Morty's Auto Parts -- Careers and applicant tracking (Phase 8.5)
//
//  Mounted by server.js:  require('./careers').register(app, deps)
//  Public: /api/public/jobs (open posts), /api/public/jobs/:id/apply (form,
//  CV, the documents the job asks for, answers to its questions), and
//  /api/public/applications/:token (the applicant's own status page: add a
//  missing document, or withdraw and delete). Staff: /api/hr/* (cap hr.manage).
//
//  Files: CVs are PDF or Word; documents may also be JPG or PNG photos. Each
//  is checked by its first bytes, 5 MB at most, saved under data/careers-cvs
//  (outside the website folder, so never served) with a random name. Staff
//  open them through /api/hr/applications/:id/cv and .../documents/:docId,
//  which is logged on the application.
//
//  Automatic reply: on applying, the applicant is emailed a reference number,
//  what we still need from them and a private link to their status page, and
//  the hiring inbox (setting careers_notify_email) is told. Interview, offer,
//  rejection and "documents needed" emails are drafted from the templates in
//  the careers_templates setting, edited by the person sending them, and
//  logged on the application. Without SMTP (mailer stub) nothing leaves the
//  till and the history says so.
//
//  Consent to keep the details is required and recorded with its wording.
//  After the retention period an applicant who was not hired has the CV and
//  documents deleted and their details blanked; the job, dates and stage stay
//  for hiring statistics. A hire becomes a staff login (switched off until a
//  manager sets its role and password).
//
//  The whole process: a requisition (the case for the job, approved by
//  someone with hr.approve) becomes a posting; applications are screened
//  (pass / maybe / fail with notes), shortlisted, interviewed by a panel
//  (each interview goes on the staff calendar for the panel, with a notice;
//  each panel member fills in a scorecard, even without hr.manage),
//  compared side by side, reference-checked, and offered the job. The offer
//  is approved (hr.approve), sent with a private link where the candidate
//  accepts by typing their name (or staff record a spoken / paper answer),
//  and filed in the Document centre. Hire then opens the staff file
//  (hr.js onHire): job, start date, probation, payroll (switched off) and
//  the onboarding checklist. Every decision is written to hr_audit and to
//  the application's history.
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mailer = require('./mailer');

const STAGES = ['new', 'screen', 'shortlist', 'interview', 'references', 'offer', 'hired', 'rejected'];
const CONSENT = 'I agree that Morty\'s Auto Parts may keep my application, CV and documents to consider me for work, for up to 12 months, after which they are deleted. I can ask for them to be deleted sooner.';
// What the applicant sees on their status page for each stage. Internal
// stages (screening) are not spelled out to them.
const PUBLIC_STAGE = { new: 'Received: being reviewed', screen: 'Received: being reviewed', shortlist: 'Shortlisted', interview: 'Interview stage', references: 'Final checks', offer: 'Offer stage', hired: 'Hired', rejected: 'Closed: not taken forward this time' };
// What an interview scores, 1 to 5, when the job has no scorecard of its own.
const SCORECARD = [
  { key: 'experience', label: 'Experience for this job' },
  { key: 'knowledge', label: 'Parts and vehicle knowledge' },
  { key: 'customer', label: 'Customer service' },
  { key: 'communication', label: 'Communication' },
  { key: 'reliability', label: 'Reliability and attitude' },
  { key: 'teamwork', label: 'Teamwork' },
];
const RECOMMEND = ['strong_yes', 'yes', 'no', 'strong_no'];
const CONTRACTS = ['permanent', 'fixed_term', 'part_time', 'casual', 'contractor', 'intern'];
const FILE_RE = /^[0-9a-f]{32}\.(pdf|docx|doc|jpg|png)$/;
const TYPES = { '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.doc': 'application/msword', '.jpg': 'image/jpeg', '.png': 'image/png' };

// Email templates. {first} {name} {job} {ref} {link} {missing} {interview}
// are filled in; the hiring screen edits these (careers_templates setting).
const TEMPLATES = {
  ack: {
    label: 'Automatic reply when someone applies',
    subject: 'We received your application for {job} ({ref})',
    body: 'Hi {first},\n\nThank you for applying for {job} at Morty\'s Auto Parts. Your reference is {ref}.\n\n{missing}\n\nYou can see where your application is, add documents, or withdraw it here:\n{link}\n\nWe read every application. If you are shortlisted we will contact you by phone or email.\n\nMorty\'s Auto Parts\n51 Red Hills Road, Kingston · +1 876-905-4111',
  },
  docs: {
    label: 'Documents needed',
    subject: 'Documents needed for your application ({ref})',
    body: 'Hi {first},\n\nThank you for your application for {job}. To move it forward we need:\n\n{missing}\n\nPlease upload them here:\n{link}\n\nMorty\'s Auto Parts',
  },
  interview: {
    label: 'Interview invitation',
    subject: 'Interview for {job} ({ref})',
    body: 'Hi {first},\n\nWe would like to meet you about the {job} position{interview}.\n\nPlease reply to this email or call +1 876-905-4111 to confirm, and bring a photo ID and any certificates you mentioned.\n\nMorty\'s Auto Parts\n51 Red Hills Road, Kingston',
  },
  offer: {
    label: 'Offer',
    subject: 'Job offer: {job}',
    body: 'Hi {first},\n\nWe are pleased to offer you the {job} position at Morty\'s Auto Parts{start}.\n\nYour offer letter, with the pay and conditions, is here. You can accept or decline it on the same page:\n{offer}\n\nIf you have any questions, reply to this email or call +1 876-905-4111.\n\nMorty\'s Auto Parts',
  },
  reference: {
    label: 'Reference request (to the referee)',
    subject: 'Reference for {name}',
    body: 'Dear {referee},\n\n{name} has applied for the {job} position at Morty\'s Auto Parts and has given your name as a referee.\n\nCould you tell us, by reply or by phone (+1 876-905-4111): how you know them and for how long, what work they did, their reliability and honesty, and whether you would employ them again?\n\nWhat you tell us is kept confidential.\n\nThank you,\nMorty\'s Auto Parts',
  },
  rejected: {
    label: 'Not taken forward',
    subject: 'Your application for {job}',
    body: 'Hi {first},\n\nThank you for your interest in the {job} position and for the time you put into your application. We have decided not to take your application forward this time.\n\nWe keep applications on file for 12 months and may contact you if a suitable position opens.\n\nMorty\'s Auto Parts',
  },
};

function register(app, deps) {
  const { query, requireAdmin, requireCap, bcrypt, userCan, getPool, hr, docs } = deps;
  const notice = deps.notice || null;
  const can = (k) => [requireAdmin, requireCap(k)];
  // A list of staff ids from a form (interviewers), cleaned.
  const ids = (v) => [...new Set((Array.isArray(v) ? v : []).map((x) => parseInt(x, 10)).filter((x) => x > 0))].slice(0, 20);
  // Who someone is for one job: hiring staff, its hiring manager, one of its interviewers, or nobody.
  async function jobRole(req, jobId) {
    if (await userCan(req, 'hr.manage')) return 'hr';
    const { rows } = await query(`SELECT hiring_manager_id, interviewer_ids FROM job_posts WHERE id = $1`, [jobId || 0]);
    if (!rows.length) return null;
    if (rows[0].hiring_manager_id === req.session.userId) return 'manager';
    return (rows[0].interviewer_ids || []).includes(req.session.userId) ? 'interviewer' : null;
  }
  // The full application (answers, CV, documents, history) is for hiring staff and the job's hiring manager.
  async function canSeeApp(req, appId) {
    const { rows } = await query(`SELECT job_id FROM job_applications WHERE id = $1`, [parseInt(appId, 10) || 0]);
    const role = rows.length ? await jobRole(req, rows[0].job_id) : null;
    if (!['hr', 'manager'].includes(role)) throw httpError(rows.length ? 403 : 404, rows.length ? 'Only hiring staff and the job’s hiring manager can open this application' : 'Application not found');
    return role;
  }
  const DIR = path.join(__dirname, '..', 'data', 'careers-cvs');
  fs.mkdirSync(DIR, { recursive: true });
  function httpError(status, msg) { const e = new Error(msg); e.status = status; e.publicMessage = msg; return e; }
  function fail(res, e) { const s = e.status || 500; if (s >= 500) console.error('[careers]', e); res.status(s).json({ error: e.publicMessage || e.message }); }
  async function setting(key, dflt) {
    const { rows } = await query('SELECT value FROM warehouse_settings WHERE key = $1', [key]);
    return rows.length && rows[0].value != null ? rows[0].value : dflt;
  }
  async function putSetting(key, value) {
    await query('INSERT INTO warehouse_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, value]);
  }
  const t = (v, m) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, m));
  const ipOf = (req) => String(req.headers['cf-connecting-ip'] || (req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '').slice(0, 64);
  // Links in emails: the configured public address, else the address this
  // request came in on (a till on the shop network).
  const baseUrl = (req) => (process.env.PUBLIC_BASE_URL || ((req.headers['x-forwarded-proto'] || req.protocol || 'http') + '://' + req.get('host'))).replace(/\/$/, '');
  const statusLink = (req, token) => baseUrl(req) + '/careers.html?app=' + token;
  const offerLink = (req, token) => baseUrl(req) + '/careers.html?offer=' + token;
  const me = (req) => req.session.userId;
  // Every decision: on the application's history and in the HR audit.
  async function decision(appId, entity, entityId, action, detail, by, q = query) {
    const line = action + (detail ? ': ' + detail : '');
    await q(`INSERT INTO application_notes (application_id, kind, note, by_user) VALUES ($1, 'decision', $2, $3)`, [appId, line.slice(0, 2000), by || null]);
    if (hr) await hr.audit({ application_id: appId, entity, entity_id: entityId, action, detail, by }, q);
  }
  // Who can approve: owners and managers, and anyone given hr.approve by name.
  async function approvers() {
    const { rows } = await query(`SELECT u.id, u.email FROM users u LEFT JOIN roles r ON r.code = u.admin_role
      WHERE (COALESCE(r.can_manage, false) OR (u.perms->>'hr.approve') = 'true') AND NOT COALESCE(u.disabled, false) AND NOT COALESCE(u.is_archived, false)`).catch(() => ({ rows: [] }));
    return rows;
  }
  async function tell(ids, n0) { if (notice && ids.length) await notice(ids, n0).catch((e) => console.warn('[careers] notice', e.message)); }

  let upload = null;
  try {
    const multer = require('multer');
    upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 10, fields: 60 } });
  } catch (e) { console.warn('[careers] multer missing: applications without files only'); }
  // What the file really is, from its first bytes (the name and type sent can lie).
  function sniff(buf) {
    if (!buf || buf.length < 8) return null;
    if (buf.slice(0, 5).toString('latin1') === '%PDF-') return '.pdf';
    if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return '.docx';
    if (buf.slice(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return '.doc';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
    if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
    return null;
  }
  const uploadMw = upload ? (req, res, next) => upload.any()(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Each file must be 5 MB or smaller' : err.code === 'LIMIT_FILE_COUNT' ? 'Too many files' : 'Could not read the upload' });
    next();
  }) : (req, res, next) => next();
  // Checked before anything is written, so a bad file fails with nothing saved.
  function checkFile(f, cvOnly) {
    const ext = sniff(f.buffer);
    if (!ext || (cvOnly && !['.pdf', '.docx', '.doc'].includes(ext))) {
      throw httpError(400, (cvOnly ? 'The CV must be a PDF or a Word document' : '“' + String(f.originalname || 'A file').slice(0, 60) + '” must be a PDF, Word document, JPG or PNG'));
    }
    return ext;
  }
  function saveFile(f, ext) {
    const name = crypto.randomBytes(16).toString('hex') + ext;
    fs.writeFileSync(path.join(DIR, name), f.buffer, { flag: 'wx' });
    return name;
  }
  const cleanName = (f, ext) => String(f.originalname || 'file' + ext).replace(/[^\w.\- ]/g, '_').slice(0, 120);
  function removeFile(name) { if (name && FILE_RE.test(name)) { try { fs.unlinkSync(path.join(DIR, name)); } catch (_) {} } }

  // The documents and questions a job asks for, cleaned. Keys are stable so a
  // document uploaded later lands against the same requirement.
  const keyOf = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  function cleanList(list, kind) {
    if (!Array.isArray(list)) return [];
    const seen = new Set(), out = [];
    for (const x of list.slice(0, 12)) {
      const label = t(x && (kind === 'doc' ? x.label : x.q), kind === 'doc' ? 80 : 240);
      if (!label) continue;
      let key = keyOf(x.key || label) || 'item';
      while (seen.has(key)) key += '_';
      seen.add(key);
      out.push(kind === 'doc'
        ? { key, label, required: !!x.required }
        : { key, q: label, kind: x.kind === 'yesno' ? 'yesno' : 'text', required: !!x.required });
    }
    return out;
  }
  const jobDocs = (j) => (Array.isArray(j && j.documents) ? j.documents : []);
  // Required documents the applicant has not sent yet.
  async function missingDocs(appId, job) {
    const { rows } = await query('SELECT DISTINCT doc_key FROM application_documents WHERE application_id = $1', [appId]);
    const have = new Set(rows.map((r) => r.doc_key));
    return jobDocs(job).filter((d) => d.required && !have.has(d.key));
  }

  // ---------------------------------------------------------- email ------
  async function templates() {
    let saved = {};
    try { saved = JSON.parse(await setting('careers_templates', '{}')) || {}; } catch (_) {}
    const out = {};
    for (const k of Object.keys(TEMPLATES)) {
      const s = saved[k] || {};
      out[k] = { label: TEMPLATES[k].label, subject: s.subject || TEMPLATES[k].subject, body: s.body || TEMPLATES[k].body };
    }
    return out;
  }
  function fill(text, v) { return String(text).replace(/\{(first|name|job|ref|link|missing|interview|offer|start|referee)\}/g, (m, k) => (v[k] == null ? '' : v[k])); }
  const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Plain text in, a simple branded HTML version alongside; links clickable.
  function asHtml(text) {
    const body = escHtml(text).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#d62828">$1</a>').replace(/\n/g, '<br>');
    return '<!doctype html><html><body style="margin:0;padding:24px 0;background:#f6f7f9;font-family:Arial,sans-serif;color:#0f1720">' +
      '<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden"><div style="background:#d62828;color:#fff;padding:16px 22px;font-size:18px;font-weight:800">Morty\'s Auto Parts · Careers</div>' +
      '<div style="padding:22px;font-size:14px;line-height:1.6">' + body + '</div></div></body></html>';
  }
  async function ensureToken(a) {
    if (a.token) return a.token;
    const token = crypto.randomBytes(16).toString('hex');
    await query('UPDATE job_applications SET token = $2 WHERE id = $1 AND token IS NULL', [a.id, token]);
    const { rows } = await query('SELECT token FROM job_applications WHERE id = $1', [a.id]);
    return rows[0].token;
  }
  async function vars(req, a, job) {
    const missing = await missingDocs(a.id, job);
    const when = a.interview_at ? new Date(a.interview_at).toLocaleString('en-JM', { timeZone: 'America/Jamaica', weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' }) : null;
    const { rows: of } = await query(`SELECT token, start_date FROM hr_offers WHERE application_id = $1 AND status NOT IN ('withdrawn', 'declined') ORDER BY id DESC LIMIT 1`, [a.id]).catch(() => ({ rows: [] }));
    const o = of[0];
    return {
      offer: o && o.token ? offerLink(req, o.token) : '(the offer letter link is added when the offer is sent)',
      start: o && o.start_date ? ', starting ' + new Date(o.start_date).toLocaleDateString('en-JM', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : '',
      first: String(a.name || '').split(' ')[0], name: a.name, job: (job && job.title) || 'the position', ref: a.ref || ('#' + a.id),
      link: statusLink(req, await ensureToken(a)),
      missing: missing.length ? 'We still need: ' + missing.map((d) => d.label).join(', ') + '. You can upload them at the link below.' : 'We have the documents we asked for.',
      interview: when ? ' on ' + when : '',
    };
  }
  // Sends (or, without SMTP, logs) and records it on the application.
  async function sendToApplicant(a, subject, body, by) {
    if (!a.email) throw httpError(400, 'This applicant has no email address');
    let note;
    try {
      const r = await mailer.sendEmail({ to: a.email, subject, text: body, html: asHtml(body) });
      note = (r && r.stubbed ? 'Email not sent (email is not set up on this till): ' : 'Emailed: ') + subject;
    } catch (e) {
      note = 'Email failed (' + String(e.message).slice(0, 120) + '): ' + subject;
    }
    await query(`INSERT INTO application_notes (application_id, kind, note, by_user) VALUES ($1, 'email', $2, $3)`, [a.id, note, by || null]);
    return note;
  }

  // ------------------------------------------------------------ public --
  app.get('/api/public/jobs', async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT id, title, department, location, kind, pay, summary, description, requirements, closes_on, openings, documents, questions, cv_required, created_at FROM job_posts
          WHERE is_open AND (closes_on IS NULL OR closes_on >= CURRENT_DATE) ORDER BY created_at DESC`);
      res.set('Cache-Control', 'no-store');
      res.json({ jobs: rows, consent: CONSENT });
    } catch (e) { fail(res, e); }
  });

  const RATE = new Map();
  app.post('/api/public/jobs/:id/apply', uploadMw, async (req, res) => {
    const written = [];
    try {
      const b = req.body || {};
      if (b.website) return res.json({ ok: true });   // honeypot: bots fill every field
      const ip = ipOf(req), r = RATE.get(ip) || { n: 0, first: Date.now() };
      if (Date.now() - r.first > 3600000) { r.n = 0; r.first = Date.now(); }
      if (r.n >= 5) throw httpError(429, 'Too many applications from this connection. Please try again later.');
      const { rows: jr } = await query(`SELECT * FROM job_posts WHERE id = $1 AND is_open AND (closes_on IS NULL OR closes_on >= CURRENT_DATE)`, [parseInt(req.params.id, 10) || 0]);
      if (!jr.length) throw httpError(404, 'This job is no longer open');
      const job = jr[0];
      const name = t(b.name, 120), email = t(b.email, 160), phone = t(b.phone, 40);
      if (!name || name.length < 3) throw httpError(400, 'Your full name');
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, 'A working email address');
      if (!phone || phone.replace(/\D/g, '').length < 7) throw httpError(400, 'A phone number');
      if (b.consent !== 'yes' && b.consent !== true && b.consent !== 'true' && b.consent !== 'on') throw httpError(400, 'Please tick the box to agree to us keeping your application');

      // Answers to the job's questions, kept with the question as it was asked.
      const answers = [];
      for (const q of (Array.isArray(job.questions) ? job.questions : [])) {
        let v = t(b['q_' + q.key], 2000);
        if (q.kind === 'yesno') v = v === 'yes' ? 'Yes' : v === 'no' ? 'No' : null;
        if (q.required && !v) throw httpError(400, 'Please answer: ' + q.q);
        answers.push({ q: q.q, a: v });
      }
      // Files: field "cv", and "doc_<key>" for each document the job asks for.
      const files = req.files || [];
      const cv = files.find((f) => f.fieldname === 'cv');
      if (job.cv_required && !cv) throw httpError(400, 'Please attach your CV');
      // A required document may follow later: people apply before they have a
      // police record in hand. What is still needed goes in the reply.
      const docs = [];
      for (const d of jobDocs(job)) {
        const f = files.find((x) => x.fieldname === 'doc_' + d.key);
        if (f) docs.push({ d, f, ext: checkFile(f, false) });
      }
      const other = files.filter((f) => f.fieldname === 'doc_other').slice(0, 3).map((f) => ({ d: { key: 'other', label: 'Other document' }, f, ext: checkFile(f, false) }));
      const cvExt = cv ? checkFile(cv, true) : null;

      let cvFile = null, cvName = null;
      if (cv) { cvFile = saveFile(cv, cvExt); written.push(cvFile); cvName = cleanName(cv, cvExt); }
      const days = parseInt(await setting('careers_retention_days', '365'), 10) || 365;
      const token = crypto.randomBytes(16).toString('hex');
      const { rows: ins } = await query(
        `INSERT INTO job_applications (job_id, name, email, phone, parish, cover, cv_file, cv_name, consent_at, consent_text, ip, retain_until, answers, token)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),$9,$10, CURRENT_DATE + $11::int, $12::jsonb, $13) RETURNING *`,
        [job.id, name, email.toLowerCase(), phone, t(b.parish, 40), t(b.cover, 4000), cvFile, cvName, CONSENT, ip, days, JSON.stringify(answers), token]);
      const { rows: refd } = await query(
        `UPDATE job_applications SET ref = 'VA-' || to_char(created_at, 'YY') || '-' || lpad(id::text, 4, '0') WHERE id = $1 RETURNING *`, [ins[0].id]);
      const a = refd[0];
      for (const x of docs.concat(other)) {
        const fileName = saveFile(x.f, x.ext); written.push(fileName);
        await query(`INSERT INTO application_documents (application_id, doc_key, label, file, orig_name, bytes, via) VALUES ($1,$2,$3,$4,$5,$6,'apply')`,
          [a.id, x.d.key, x.d.label, fileName, cleanName(x.f, x.ext), x.f.size]);
      }
      written.length = 0;   // all stored: nothing to clean up from here on
      r.n++; RATE.set(ip, r);

      // The automatic reply, and a heads-up to the hiring inbox. Neither holds
      // up the answer to the applicant.
      const v = await vars(req, a, job);
      (async () => {
        const tpl = (await templates()).ack;
        await sendToApplicant(a, fill(tpl.subject, v), fill(tpl.body, v), null);
        const inbox = t(await setting('careers_notify_email', ''), 160);
        if (job.hiring_manager_id) await tell([job.hiring_manager_id], { kind: 'memo', title: '📥 New applicant for ' + job.title + ': ' + name, link: '/hiring.html#app=' + a.id });
        if (inbox) {
          const body = 'New application for ' + job.title + ' (' + a.ref + ')\n\n' + name + '\n' + email + ' · ' + phone + '\n' +
            (cvFile ? 'CV attached. ' : 'No CV. ') + (docs.length + other.length) + ' document(s).' +
            (v.missing.startsWith('We still need') ? '\n' + v.missing.split('.')[0] + '.' : '') + '\n\nOpen the hiring screen: ' + baseUrl(req) + '/hiring.html';
          await mailer.sendEmail({ to: inbox, subject: 'New application: ' + job.title + ' — ' + name, text: body, html: asHtml(body) }).catch((e) => console.warn('[careers] inbox email', e.message));
        }
      })().catch((e) => console.warn('[careers] auto-reply', e.message));

      res.json({
        ok: true, ref: a.ref, status_url: v.link,
        missing: (await missingDocs(a.id, job)).map((d) => d.label),
        message: 'Thank you, ' + name.split(' ')[0] + '. We have your application for ' + job.title + '. Your reference is ' + a.ref + '. We have emailed you a copy and a link where you can check on it and add documents.',
      });
    } catch (e) { written.forEach(removeFile); fail(res, e); }
  });

  // The applicant's own page, reached by the private link in their email.
  const LOOK = new Map();
  async function byToken(req) {
    const ip = ipOf(req), r = LOOK.get(ip) || { n: 0, first: Date.now() };
    if (Date.now() - r.first > 3600000) { r.n = 0; r.first = Date.now(); }
    if (r.n >= 30) throw httpError(429, 'Too many tries. Please try again later.');
    const token = String(req.params.token || '');
    const { rows } = /^[0-9a-f]{32}$/.test(token)
      ? await query(`SELECT a.*, row_to_json(j.*) AS job_row FROM job_applications a LEFT JOIN job_posts j ON j.id = a.job_id WHERE a.token = $1 AND a.anonymised_at IS NULL`, [token])
      : { rows: [] };
    if (!rows.length) { r.n++; LOOK.set(ip, r); throw httpError(404, 'This link is not valid, or the application has been deleted.'); }
    return rows[0];
  }
  const canAdd = (a) => !['hired', 'rejected'].includes(a.stage);
  async function publicView(a) {
    const { rows: docs } = await query('SELECT label, orig_name, uploaded_at FROM application_documents WHERE application_id = $1 ORDER BY uploaded_at', [a.id]);
    const job = a.job_row || {};
    return {
      ref: a.ref, name: a.name, job: job.title || null, applied: a.created_at, stage: PUBLIC_STAGE[a.stage] || a.stage,
      cv: a.cv_name || null, documents: docs,
      asked_for: jobDocs(job).map((d) => ({ key: d.key, label: d.label, required: d.required })),
      missing: (await missingDocs(a.id, job)).map((d) => ({ key: d.key, label: d.label })),
      can_add: canAdd(a), retain_until: a.retain_until,
    };
  }
  app.get('/api/public/applications/:token', async (req, res) => {
    try { res.set('Cache-Control', 'no-store'); res.json(await publicView(await byToken(req))); } catch (e) { fail(res, e); }
  });
  // Add documents later: "doc_<key>" for something the job asked for, "doc_other" otherwise.
  app.post('/api/public/applications/:token/documents', uploadMw, async (req, res) => {
    try {
      const a = await byToken(req);
      if (!canAdd(a)) throw httpError(409, 'This application is closed, so documents can no longer be added.');
      const n = await storeDocs(a, req.files || [], 'applicant', null);
      res.json({ ok: true, added: n, view: await publicView(a) });
    } catch (e) { fail(res, e); }
  });
  app.delete('/api/public/applications/:token', async (req, res) => {
    try {
      const a = await byToken(req);
      if (a.stage === 'hired') throw httpError(409, 'You have been hired, so this application is kept with your staff file. Please speak to the manager.');
      await anonymise('a.id = $1', [a.id], null, 'Withdrawn by the applicant: details and files deleted');
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  async function storeDocs(a, files, via, by) {
    const job = a.job_row || (await query('SELECT * FROM job_posts WHERE id = $1', [a.job_id])).rows[0] || {};
    const wanted = new Map(jobDocs(job).map((d) => [d.key, d]));
    const list = [];
    for (const f of files) {
      const key = String(f.fieldname || '').replace(/^doc_/, '');
      const d = wanted.get(key) || { key: 'other', label: t(f.label, 80) || 'Other document' };
      list.push({ f, d, ext: checkFile(f, false) });
    }
    if (!list.length) throw httpError(400, 'Choose a file to upload');
    const { rows: c } = await query('SELECT COUNT(*)::int AS n FROM application_documents WHERE application_id = $1', [a.id]);
    if (c[0].n + list.length > 20) throw httpError(400, 'An application can hold 20 documents at most');
    for (const x of list) {
      const fileName = saveFile(x.f, x.ext);
      await query(`INSERT INTO application_documents (application_id, doc_key, label, file, orig_name, bytes, via) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [a.id, x.d.key, x.d.label, fileName, cleanName(x.f, x.ext), x.f.size, via]);
    }
    await query(`INSERT INTO application_notes (application_id, kind, note, by_user) VALUES ($1, 'document', $2, $3)`,
      [a.id, (via === 'applicant' ? 'Applicant added: ' : 'Added: ') + list.map((x) => x.d.label).join(', '), by]);
    await query('UPDATE job_applications SET updated_at = NOW() WHERE id = $1', [a.id]);
    return list.length;
  }

  // ------------------------------------------------------------- staff --
  app.get('/api/hr/jobs', ...can('hr.manage'), async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT j.*, ${STAGES.map((s) => `COUNT(a.id) FILTER (WHERE a.stage = '${s}' AND a.anonymised_at IS NULL)::int AS ${s}`).join(', ')}
           FROM job_posts j LEFT JOIN job_applications a ON a.job_id = j.id GROUP BY j.id ORDER BY j.is_open DESC, j.created_at DESC`);
      res.json({ jobs: rows });
    } catch (e) { fail(res, e); }
  });
  function cleanJob(b) {
    const j = { title: t(b.title, 120) };
    if (!j.title) throw httpError(400, 'Job title');
    j.department = t(b.department, 60); j.location = t(b.location, 80);
    j.kind = ['full_time', 'part_time', 'contract', 'freelance_rep'].includes(b.kind) ? b.kind : 'full_time';
    j.pay = t(b.pay, 80); j.summary = t(b.summary, 300); j.description = t(b.description, 6000); j.requirements = t(b.requirements, 4000);
    j.is_open = b.is_open !== false;
    j.closes_on = /^\d{4}-\d{2}-\d{2}$/.test(b.closes_on || '') ? b.closes_on : null;
    j.openings = Math.max(1, Math.min(99, parseInt(b.openings, 10) || 1));
    j.documents = JSON.stringify(cleanList(b.documents, 'doc'));
    j.questions = JSON.stringify(cleanList(b.questions, 'q'));
    j.cv_required = !!b.cv_required;
    j.requisition_id = parseInt(b.requisition_id, 10) || null;
    j.hiring_manager_id = parseInt(b.hiring_manager_id, 10) || null;
    j.interviewer_ids = ids(b.interviewer_ids);
    j.scorecard = JSON.stringify(cleanList((Array.isArray(b.scorecard) ? b.scorecard : []).map((x) => ({ key: x && x.key, label: x && x.label })), 'doc').map((x) => ({ key: x.key, label: x.label })));
    return j;
  }
  const JOB_COLS = ['title', 'department', 'location', 'kind', 'pay', 'summary', 'description', 'requirements', 'is_open', 'closes_on', 'openings', 'documents', 'questions', 'cv_required', 'requisition_id', 'hiring_manager_id', 'scorecard', 'interviewer_ids'];
  const JSONB_COLS = ['documents', 'questions', 'scorecard'];
  const jobVals = (j) => JOB_COLS.map((c) => j[c]);
  // With "postings need an approved requisition" on, a post opens only against one.
  async function checkCanOpen(j) {
    if (!j.is_open || (await setting('hr_require_requisition', 'off')) !== 'on') return;
    const { rows } = j.requisition_id ? await query(`SELECT status FROM job_requisitions WHERE id = $1`, [j.requisition_id]) : { rows: [] };
    if (!rows.length || !['approved', 'filled'].includes(rows[0].status)) throw httpError(409, 'This shop needs an approved requisition before a job is posted. Raise one under Requisitions, or save the posting closed.');
  }
  app.post('/api/hr/jobs', ...can('hr.manage'), async (req, res) => {
    try {
      const j = cleanJob(req.body || {});
      await checkCanOpen(j);
      const { rows } = await query(
        `INSERT INTO job_posts (${JOB_COLS.join(', ')}, created_by) VALUES (${JOB_COLS.map((c, i) => '$' + (i + 1) + (JSONB_COLS.includes(c) ? '::jsonb' : '')).join(',')}, $${JOB_COLS.length + 1}) RETURNING *`,
        jobVals(j).concat([req.session.userId]));
      if (hr) await hr.audit({ entity: 'job_post', entity_id: rows[0].id, action: 'posting created' + (j.is_open ? ' and opened' : ''), detail: j.title, by: me(req) });
      res.json({ job: rows[0] });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/hr/jobs/:id', ...can('hr.manage'), async (req, res) => {
    try {
      const j = cleanJob(req.body || {});
      await checkCanOpen(j);
      const { rows } = await query(
        `UPDATE job_posts SET ${JOB_COLS.map((c, i) => c + ' = $' + (i + 2) + (JSONB_COLS.includes(c) ? '::jsonb' : '')).join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING *`,
        [req.params.id].concat(jobVals(j)));
      if (!rows.length) throw httpError(404, 'Job not found');
      if (hr) await hr.audit({ entity: 'job_post', entity_id: rows[0].id, action: 'posting changed', detail: j.title + (j.is_open ? ' (open)' : ' (closed)'), by: me(req) });
      res.json({ job: rows[0] });
    } catch (e) { fail(res, e); }
  });
  // Open or close a posting without opening the form.
  app.patch('/api/hr/jobs/:id', ...can('hr.manage'), async (req, res) => {
    try {
      const open = !!(req.body || {}).is_open;
      const { rows: cur } = await query('SELECT requisition_id, title FROM job_posts WHERE id = $1', [req.params.id]);
      if (!cur.length) throw httpError(404, 'Job not found');
      await checkCanOpen({ is_open: open, requisition_id: cur[0].requisition_id });
      const { rows } = await query('UPDATE job_posts SET is_open = $2, updated_at = NOW() WHERE id = $1 RETURNING id, is_open', [req.params.id, open]);
      if (hr) await hr.audit({ entity: 'job_post', entity_id: rows[0].id, action: open ? 'posting opened' : 'posting closed', detail: cur[0].title, by: me(req) });
      res.json({ job: rows[0] });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/hr/applications', ...can('hr.manage'), async (req, res) => {
    try {
      const job = parseInt(req.query.job, 10) || null;
      const { rows } = await query(
        `SELECT a.id, a.ref, a.job_id, j.title AS job, a.name, a.email, a.phone, a.parish, a.stage, a.rating, a.interview_at, a.created_at, a.updated_at, (a.cv_file IS NOT NULL) AS has_cv,
                a.retain_until, a.hired_user_id, (SELECT COUNT(*) FROM application_notes n WHERE n.application_id = a.id AND n.kind = 'note')::int AS notes,
                (SELECT COUNT(*) FROM application_documents d WHERE d.application_id = a.id)::int AS docs,
                (SELECT COUNT(*) FROM jsonb_array_elements(COALESCE(j.documents, '[]'::jsonb)) x
                  WHERE (x->>'required')::boolean AND NOT EXISTS (SELECT 1 FROM application_documents d WHERE d.application_id = a.id AND d.doc_key = x->>'key'))::int AS docs_missing
           FROM job_applications a LEFT JOIN job_posts j ON j.id = a.job_id
          WHERE a.anonymised_at IS NULL AND ($1::int IS NULL OR a.job_id = $1) ORDER BY a.created_at DESC LIMIT 500`, [job]);
      res.json({ applications: rows, stages: STAGES });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/hr/applications/:id', requireAdmin, async (req, res) => {
    try {
      const role = await canSeeApp(req, req.params.id);
      const { rows } = await query(`SELECT a.*, j.title AS job, j.documents AS job_documents FROM job_applications a LEFT JOIN job_posts j ON j.id = a.job_id WHERE a.id = $1 AND a.anonymised_at IS NULL`, [req.params.id]);
      if (!rows.length) throw httpError(404, 'Application not found');
      const { rows: notes } = await query(`SELECT n.*, u.name AS by_name FROM application_notes n LEFT JOIN users u ON u.id = n.by_user WHERE n.application_id = $1 ORDER BY n.at DESC`, [req.params.id]);
      const { rows: docs } = await query(`SELECT id, doc_key, label, orig_name, bytes, via, uploaded_at FROM application_documents WHERE application_id = $1 ORDER BY uploaded_at`, [req.params.id]);
      const a = rows[0];
      const missing = await missingDocs(a.id, { documents: a.job_documents });
      delete a.cv_file; delete a.ip; delete a.token;
      res.json(Object.assign({ role, application: a, notes, documents: docs, missing: missing.map((d) => d.label) }, await pipeline(a.id)));
    } catch (e) { fail(res, e); }
  });
  function sendStored(res, file, shownName) {
    const p = path.join(DIR, file);
    if (!fs.existsSync(p)) throw httpError(404, 'The file is missing');
    const ext = path.extname(file);
    res.set('Content-Type', TYPES[ext] || 'application/octet-stream');
    res.set('Content-Disposition', `${['.pdf', '.jpg', '.png'].includes(ext) ? 'inline' : 'attachment'}; filename="${String(shownName || 'file' + ext).replace(/"/g, '')}"`);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'private, no-store');
    res.sendFile(p);
  }
  app.get('/api/hr/applications/:id/cv', requireAdmin, async (req, res) => {
    try {
      await canSeeApp(req, req.params.id);
      const { rows } = await query(`SELECT id, cv_file, cv_name FROM job_applications WHERE id = $1 AND anonymised_at IS NULL`, [req.params.id]);
      if (!rows.length || !rows[0].cv_file || !FILE_RE.test(rows[0].cv_file)) throw httpError(404, 'No CV');
      await query(`INSERT INTO application_notes (application_id, kind, note, by_user) VALUES ($1, 'cv_viewed', 'CV opened', $2)`, [rows[0].id, req.session.userId]);
      sendStored(res, rows[0].cv_file, rows[0].cv_name);
    } catch (e) { fail(res, e); }
  });
  app.get('/api/hr/applications/:id/documents/:docId', requireAdmin, async (req, res) => {
    try {
      await canSeeApp(req, req.params.id);
      const { rows } = await query(
        `SELECT d.* FROM application_documents d JOIN job_applications a ON a.id = d.application_id
          WHERE d.id = $2 AND d.application_id = $1 AND a.anonymised_at IS NULL`, [req.params.id, req.params.docId]);
      if (!rows.length || !FILE_RE.test(rows[0].file)) throw httpError(404, 'No such document');
      await query(`INSERT INTO application_notes (application_id, kind, note, by_user) VALUES ($1, 'cv_viewed', $2, $3)`, [rows[0].application_id, 'Opened: ' + rows[0].label, req.session.userId]);
      sendStored(res, rows[0].file, rows[0].orig_name);
    } catch (e) { fail(res, e); }
  });
  // Paper documents handed in at the counter, scanned or photographed.
  app.post('/api/hr/applications/:id/documents', ...can('hr.manage'), uploadMw, async (req, res) => {
    try {
      const { rows } = await query(`SELECT * FROM job_applications WHERE id = $1 AND anonymised_at IS NULL`, [req.params.id]);
      if (!rows.length) throw httpError(404, 'Application not found');
      (req.files || []).forEach((f) => { f.label = (req.body || {}).label; });
      res.json({ ok: true, added: await storeDocs(rows[0], req.files || [], 'staff', req.session.userId) });
    } catch (e) { fail(res, e); }
  });
  app.delete('/api/hr/applications/:id/documents/:docId', ...can('hr.manage'), async (req, res) => {
    try {
      const { rows } = await query('DELETE FROM application_documents WHERE id = $2 AND application_id = $1 RETURNING file, label', [req.params.id, req.params.docId]);
      if (!rows.length) throw httpError(404, 'No such document');
      removeFile(rows[0].file);
      await query(`INSERT INTO application_notes (application_id, kind, note, by_user) VALUES ($1, 'document', $2, $3)`, [req.params.id, 'Removed: ' + rows[0].label, req.session.userId]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // An email ready to edit: kind is a template key (interview, offer,
  // rejected, docs, ack) or "blank".
  app.get('/api/hr/applications/:id/email-draft', ...can('hr.manage'), async (req, res) => {
    try {
      const { rows } = await query(`SELECT a.*, row_to_json(j.*) AS job_row FROM job_applications a LEFT JOIN job_posts j ON j.id = a.job_id WHERE a.id = $1 AND a.anonymised_at IS NULL`, [req.params.id]);
      if (!rows.length) throw httpError(404, 'Application not found');
      const a = rows[0], v = await vars(req, a, a.job_row);
      const tpl = (await templates())[req.query.kind];
      res.json({ to: a.email, subject: tpl ? fill(tpl.subject, v) : 'Your application for ' + v.job + ' (' + v.ref + ')', body: tpl ? fill(tpl.body, v) : 'Hi ' + v.first + ',\n\n\n\nMorty\'s Auto Parts', mail_on: mailer.isActive() });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/hr/applications/:id/email', ...can('hr.manage'), async (req, res) => {
    try {
      const b = req.body || {};
      const subject = t(b.subject, 200), body = t(b.body, 8000);
      if (!subject || !body) throw httpError(400, 'A subject and a message');
      const { rows } = await query(`SELECT * FROM job_applications WHERE id = $1 AND anonymised_at IS NULL`, [req.params.id]);
      if (!rows.length) throw httpError(404, 'Application not found');
      res.json({ ok: true, note: await sendToApplicant(rows[0], subject, body, req.session.userId) });
    } catch (e) { fail(res, e); }
  });

  app.patch('/api/hr/applications/:id', ...can('hr.manage'), async (req, res) => {
    try {
      const b = req.body || {};
      const { rows } = await query(`SELECT * FROM job_applications WHERE id = $1 AND anonymised_at IS NULL`, [req.params.id]);
      if (!rows.length) throw httpError(404, 'Application not found');
      const a = rows[0];
      // Screening: the first look at the application, with the reason.
      if (b.screen_result !== undefined) {
        const r = ['pass', 'maybe', 'fail'].includes(b.screen_result) ? b.screen_result : null;
        await query(`UPDATE job_applications SET screen_result = $2, screen_notes = $3, screened_by = $4, screened_at = NOW(), updated_at = NOW() WHERE id = $1`, [a.id, r, t(b.screen_notes, 2000), me(req)]);
        await decision(a.id, 'application', a.id, 'screened: ' + (r || 'cleared'), t(b.screen_notes, 300), me(req));
      }
      if (b.stage !== undefined && b.stage !== a.stage) {
        if (!STAGES.includes(b.stage) || b.stage === 'hired') throw httpError(400, b.stage === 'hired' ? 'Use Hire, which also makes their staff login' : 'Unknown stage');
        if (a.stage === 'hired') throw httpError(409, 'Already hired');
        const why = t(b.reason, 500);
        if (b.stage === 'rejected' && !why) throw httpError(400, 'Say why they are not taken forward (kept for the record, not sent to them)');
        await query(`UPDATE job_applications SET stage = $2, reject_reason = CASE WHEN $2 = 'rejected' THEN $3 ELSE reject_reason END, updated_at = NOW() WHERE id = $1`, [a.id, b.stage, why]);
        await query(`INSERT INTO application_notes (application_id, kind, note, by_user) VALUES ($1, 'stage', $2, $3)`, [a.id, a.stage + ' → ' + b.stage + (why ? ' (' + why + ')' : ''), req.session.userId]);
        if (hr) await hr.audit({ application_id: a.id, entity: 'application', entity_id: a.id, action: 'stage ' + a.stage + ' → ' + b.stage, detail: why, by: me(req) });
      }
      if (b.rating !== undefined) { const r = parseInt(b.rating, 10); await query(`UPDATE job_applications SET rating = $2, updated_at = NOW() WHERE id = $1`, [a.id, r >= 1 && r <= 5 ? r : null]); }
      if (b.interview_at !== undefined) await query(`UPDATE job_applications SET interview_at = $2, updated_at = NOW() WHERE id = $1`, [a.id, b.interview_at ? new Date(b.interview_at) : null]);
      if (t(b.note, 2000)) await query(`INSERT INTO application_notes (application_id, kind, note, by_user) VALUES ($1, 'note', $2, $3)`, [a.id, t(b.note, 2000), req.session.userId]);
      // An email written alongside the change (the stage's template, edited).
      let emailed = null;
      if (b.email && t(b.email.subject, 200) && t(b.email.body, 8000)) emailed = await sendToApplicant(a, t(b.email.subject, 200), t(b.email.body, 8000), req.session.userId);
      res.json({ ok: true, emailed });
    } catch (e) { fail(res, e); }
  });
  // Hire: a staff login, switched off until a manager sets its role and password on the Staff screen.
  app.post('/api/hr/applications/:id/hire', ...can('hr.manage'), async (req, res) => {
    try {
      const { rows } = await query(`SELECT a.*, j.title FROM job_applications a LEFT JOIN job_posts j ON j.id = a.job_id WHERE a.id = $1 AND a.anonymised_at IS NULL`, [req.params.id]);
      if (!rows.length) throw httpError(404, 'Application not found');
      const a = rows[0];
      if (a.stage === 'hired') throw httpError(409, 'Already hired');
      if (!a.email) throw httpError(400, 'This applicant has no email address, which their staff login needs');
      // An offer that was made must have been accepted.
      const { rows: offers } = await query(`SELECT * FROM hr_offers WHERE application_id = $1 AND status <> 'withdrawn' ORDER BY id DESC`, [a.id]);
      const offer = offers.find((o) => o.status === 'accepted') || null;
      if (offers.length && !offer) throw httpError(409, 'The offer has not been accepted yet. Record their answer on the offer first.');
      const { rows: jr } = await query(`SELECT * FROM job_posts WHERE id = $1`, [a.job_id]);
      const pw = await bcrypt.hash(crypto.randomBytes(24).toString('base64url'), 10);
      const c = await getPool().connect();
      let uid, existed, opened;
      try {
        await c.query('BEGIN');
        const q = c.query.bind(c);
        const { rows: ex } = await q(`SELECT id, is_staff FROM users WHERE lower(email) = lower($1)`, [a.email]);
        existed = ex.length > 0;
        if (ex.length) {
          uid = ex[0].id;
          await q(`UPDATE users SET is_staff = true, name = COALESCE(name, $2), phone = COALESCE(phone, $3) WHERE id = $1`, [uid, a.name, a.phone]);
        } else {
          const { rows: u } = await q(
            `INSERT INTO users (email, name, phone, password_hash, via, is_admin, is_staff, admin_role, disabled, internal_notes) VALUES ($1,$2,$3,$4,'hire',false,true,'cashier',true,$5) RETURNING id`,
            [a.email.toLowerCase(), a.name, a.phone, pw, 'Hired from application ' + (a.ref || '#' + a.id) + (a.title ? ' (' + a.title + ')' : '')]);
          uid = u[0].id;
        }
        // Hired: kept with the staff file, not purged with applicants.
        await q(`UPDATE job_applications SET stage = 'hired', hired_user_id = $2, retain_until = CURRENT_DATE + 3650, updated_at = NOW() WHERE id = $1`, [a.id, uid]);
        await q(`INSERT INTO application_notes (application_id, kind, note, by_user) VALUES ($1, 'stage', $2, $3)`, [a.id, a.stage + ' → hired (staff login #' + uid + ', switched off until set up)', req.session.userId]);
        opened = hr ? await hr.onHire({ uid, app: a, offer, job: jr[0] || null, by: me(req) }, q) : {};
        // The offer letter (and acceptance) filed for the applicant now belong to the staff member too.
        await q(`INSERT INTO document_links (document_id, entity_type, entity_id, label, created_by)
          SELECT l.document_id, 'staff', $2::text, $3, $4 FROM document_links l WHERE l.entity_type = 'applicant' AND l.entity_id = $1::text ON CONFLICT DO NOTHING`, [String(a.id), String(uid), a.name, me(req)]);
        // A requisition is filled once it has as many hires as openings.
        if (jr[0] && jr[0].requisition_id) {
          await q(`UPDATE job_requisitions r SET status = 'filled' WHERE r.id = $1 AND r.status = 'approved' AND r.openings <=
            (SELECT COUNT(*) FROM job_applications a JOIN job_posts p ON p.id = a.job_id WHERE p.requisition_id = r.id AND a.stage = 'hired')`, [jr[0].requisition_id]);
        }
        await decision(a.id, 'hire', uid, 'hired', 'staff login #' + uid + (offer ? ', from the accepted offer' : ''), me(req), q);
        await c.query('COMMIT');
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
      const mgr = (offer && offer.manager_user_id) || (jr[0] && jr[0].hiring_manager_id);
      if (mgr && mgr !== me(req)) await tell([mgr], { kind: 'memo', title: '🎉 New starter: ' + a.name, body: 'Their onboarding checklist is in their HR file.', link: '/people.html#staff=' + uid });
      res.json({ ok: true, user_id: uid, existed, payroll_id: opened.payroll_id || null,
        next: 'On the Staff screen: give them a role, a password or PIN, and switch the account on. Their HR file has the onboarding checklist' + (opened.payroll_id ? '; they are in Payroll, switched off until you switch pay on.' : '.') });
    } catch (e) { fail(res, e); }
  });
  // Deleted at the applicant's request (or by the manager) before the retention date.
  app.delete('/api/hr/applications/:id', ...can('hr.manage'), async (req, res) => {
    try { const n = await anonymise('a.id = $1', [parseInt(req.params.id, 10) || 0], req.session.userId); if (!n) throw httpError(404, 'Application not found'); res.json({ ok: true }); } catch (e) { fail(res, e); }
  });

  // ======================================================= the pipeline ==
  const D = (c) => `to_char(${c}, 'YYYY-MM-DD')`;
  const nm = (c) => `COALESCE(NULLIF(${c}.name, ''), ${c}.email)`;
  const id = (v) => parseInt(v, 10) || 0;
  const money = (v) => { if (v == null || v === '') return null; const x = Number(String(v).replace(/[^0-9.]/g, '')); return Number.isFinite(x) && x > 0 ? Math.round(x * 100) / 100 : null; };
  const isDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
  const jmd = (v) => 'J$' + Number(v).toLocaleString('en-JM', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // hr.manage or hr.approve: approvers see requisitions and offers to decide on them.
  const manageOrApprove = [requireAdmin, async (req, res, next) => {
    if ((await userCan(req, 'hr.manage')) || (await userCan(req, 'hr.approve'))) return next();
    res.status(403).json({ error: 'Your account is not allowed to run hiring or approve it.' });
  }];
  async function appRow(appId) {
    const { rows } = await query(`SELECT a.*, j.title AS job, j.scorecard AS job_scorecard, j.hiring_manager_id FROM job_applications a LEFT JOIN job_posts j ON j.id = a.job_id WHERE a.id = $1 AND a.anonymised_at IS NULL`, [appId]);
    if (!rows.length) throw httpError(404, 'Application not found');
    return rows[0];
  }
  async function pipeline(appId) {
    const { rows: interviews } = await query(`SELECT i.*, (SELECT json_agg(json_build_object('id', u.id, 'name', ${nm('u')},
          'scored', EXISTS (SELECT 1 FROM hr_interview_scores s WHERE s.interview_id = i.id AND s.user_id = u.id)) ORDER BY u.name) FROM hr_interview_panel p JOIN users u ON u.id = p.user_id WHERE p.interview_id = i.id) AS panel
        FROM hr_interviews i WHERE i.application_id = $1 ORDER BY i.starts_at`, [appId]);
    const { rows: scores } = await query(`SELECT s.*, ${nm('u')} AS by_name, i.round FROM hr_interview_scores s JOIN hr_interviews i ON i.id = s.interview_id JOIN users u ON u.id = s.user_id WHERE i.application_id = $1 ORDER BY i.round, s.submitted_at`, [appId]);
    const { rows: references } = await query(`SELECT r.*, ${nm('u')} AS by_name FROM hr_references r LEFT JOIN users u ON u.id = r.by_user WHERE r.application_id = $1 ORDER BY r.id`, [appId]);
    const { rows: offers } = await query(`SELECT o.*, ${D('o.start_date')} AS start_date, ${D('o.contract_end')} AS contract_end, ${D('o.respond_by')} AS respond_by, o.salary_annual::float, o.hourly_rate::float,
        dp.name AS department, ${nm('m')} AS manager, ${nm('ap')} AS approved_by_name, dc.number AS document_number, (o.token IS NOT NULL) AS has_link
        FROM hr_offers o LEFT JOIN departments dp ON dp.id = o.department_id LEFT JOIN users m ON m.id = o.manager_user_id LEFT JOIN users ap ON ap.id = o.approved_by LEFT JOIN documents dc ON dc.id = o.document_id
        WHERE o.application_id = $1 ORDER BY o.id DESC`, [appId]);
    offers.forEach((o) => { delete o.token; delete o.response_ip; });
    const { rows: decisions } = await query(`SELECT a.at, a.entity, a.action, a.detail, ${nm('b')} AS by_name FROM hr_audit a LEFT JOIN users b ON b.id = a.by_user WHERE a.application_id = $1 ORDER BY a.at DESC`, [appId]);
    return { interviews, scores, references, offers, decisions, scorecard_default: SCORECARD };
  }

  // ---------------------------------------------------- requisitions --
  function cleanReq(b) {
    const r = { title: t(b.title, 120), department: t(b.department, 60), kind: ['full_time', 'part_time', 'contract', 'freelance_rep'].includes(b.kind) ? b.kind : 'full_time',
      openings: Math.max(1, Math.min(99, parseInt(b.openings, 10) || 1)), reason: ['new', 'replacement', 'temporary'].includes(b.reason) ? b.reason : 'new',
      replaces_user_id: id(b.replaces_user_id) || null, salary_min: money(b.salary_min), salary_max: money(b.salary_max), start_by: isDate(b.start_by),
      justification: t(b.justification, 4000), hiring_manager_id: id(b.hiring_manager_id) || null, interviewer_ids: ids(b.interviewer_ids) };
    if (!r.title) throw httpError(400, 'The job title');
    if (!r.justification) throw httpError(400, 'Why the shop needs this person (the approver reads this)');
    if (r.salary_min && r.salary_max && r.salary_min > r.salary_max) throw httpError(400, 'The lowest pay is more than the highest');
    return r;
  }
  const REQ_COLS = ['title', 'department', 'kind', 'openings', 'reason', 'replaces_user_id', 'salary_min', 'salary_max', 'start_by', 'justification', 'hiring_manager_id', 'interviewer_ids'];
  async function reqRow(rid) {
    const { rows } = await query(`SELECT * FROM job_requisitions WHERE id = $1`, [rid]);
    if (!rows.length) throw httpError(404, 'Requisition not found');
    return rows[0];
  }
  app.get('/api/hr/requisitions', ...manageOrApprove, async (req, res) => {
    try {
      const { rows } = await query(`SELECT r.*, ${D('r.start_by')} AS start_by, r.salary_min::float, r.salary_max::float, ${nm('q')} AS requested_by_name, ${nm('dc')} AS decided_by_name, ${nm('hm')} AS hiring_manager, ${nm('rp')} AS replaces,
          (SELECT json_agg(json_build_object('id', p.id, 'title', p.title, 'is_open', p.is_open)) FROM job_posts p WHERE p.requisition_id = r.id) AS posts,
          (SELECT COUNT(*)::int FROM job_applications a JOIN job_posts p ON p.id = a.job_id WHERE p.requisition_id = r.id AND a.stage = 'hired') AS hired
        FROM job_requisitions r LEFT JOIN users q ON q.id = r.requested_by LEFT JOIN users dc ON dc.id = r.decided_by LEFT JOIN users hm ON hm.id = r.hiring_manager_id LEFT JOIN users rp ON rp.id = r.replaces_user_id
        ORDER BY (r.status IN ('submitted', 'draft', 'approved')) DESC, r.created_at DESC LIMIT 300`);
      const { rows: people } = await query(`SELECT id, ${nm('users')} AS name FROM users WHERE (is_staff OR is_admin) AND NOT COALESCE(is_archived, false) AND NOT COALESCE(disabled, false) ORDER BY 2`);
      const { rows: depts } = await query(`SELECT id, name FROM departments WHERE is_active ORDER BY name`).catch(() => ({ rows: [] }));
      res.json({ requisitions: rows, people, departments: depts, can_approve: await userCan(req, 'hr.approve'), can_manage: await userCan(req, 'hr.manage'), me: me(req) });
    } catch (e) { fail(res, e); }
  });
  async function submitReq(r, by) {
    await query(`UPDATE job_requisitions SET status = 'submitted', submitted_at = NOW(), decided_by = NULL, decided_at = NULL WHERE id = $1`, [r.id]);
    if (hr) await hr.audit({ entity: 'requisition', entity_id: r.id, action: 'requisition sent for approval', detail: r.title + ' × ' + r.openings, by });
    await tell((await approvers()).map((u) => u.id).filter((u) => u !== by), { kind: 'memo', title: '🧾 Job requisition to approve: ' + r.title, body: r.openings + ' opening(s). ' + String(r.justification || '').slice(0, 200), link: '/hiring.html#requisitions' });
  }
  app.post('/api/hr/requisitions', ...can('hr.manage'), async (req, res) => {
    try {
      const r = cleanReq(req.body || {});
      const { rows } = await query(`INSERT INTO job_requisitions (${REQ_COLS.join(', ')}, requested_by) VALUES (${REQ_COLS.map((c, i) => '$' + (i + 1)).join(', ')}, $${REQ_COLS.length + 1}) RETURNING *`,
        REQ_COLS.map((c) => r[c]).concat([me(req)]));
      if (hr) await hr.audit({ entity: 'requisition', entity_id: rows[0].id, action: 'requisition raised', detail: r.title, by: me(req) });
      if ((req.body || {}).submit) await submitReq(rows[0], me(req));
      res.json({ id: rows[0].id });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/hr/requisitions/:id', ...can('hr.manage'), async (req, res) => {
    try {
      const cur = await reqRow(id(req.params.id));
      if (!['draft', 'rejected'].includes(cur.status)) throw httpError(409, 'Only a draft or a turned-down requisition can be changed. This one is ' + cur.status + '.');
      const r = cleanReq(req.body || {});
      await query(`UPDATE job_requisitions SET ${REQ_COLS.map((c, i) => c + ' = $' + (i + 2)).join(', ')}, status = 'draft' WHERE id = $1`, [cur.id].concat(REQ_COLS.map((c) => r[c])));
      if (hr) await hr.audit({ entity: 'requisition', entity_id: cur.id, action: 'requisition changed', detail: r.title, by: me(req) });
      if ((req.body || {}).submit) await submitReq(Object.assign(cur, r), me(req));
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/hr/requisitions/:id/submit', ...can('hr.manage'), async (req, res) => {
    try {
      const r = await reqRow(id(req.params.id));
      if (!['draft', 'rejected'].includes(r.status)) throw httpError(409, 'It is already ' + r.status);
      await submitReq(r, me(req));
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/hr/requisitions/:id/decide', ...can('hr.approve'), async (req, res) => {
    try {
      const r = await reqRow(id(req.params.id)), b = req.body || {};
      if (r.status !== 'submitted') throw httpError(409, 'It is not waiting for approval (it is ' + r.status + ')');
      const ok = b.decision === 'approve', note = t(b.note, 1000);
      if (!ok && !note) throw httpError(400, 'Say why it is turned down');
      await query(`UPDATE job_requisitions SET status = $2, decided_by = $3, decided_at = NOW(), decision_note = $4 WHERE id = $1`, [r.id, ok ? 'approved' : 'rejected', me(req), note]);
      if (hr) await hr.audit({ entity: 'requisition', entity_id: r.id, action: ok ? 'requisition approved' : 'requisition turned down', detail: [r.title, note].filter(Boolean).join(' · '), by: me(req) });
      if (r.requested_by && r.requested_by !== me(req)) await tell([r.requested_by], { kind: 'memo', title: (ok ? '✅ Approved: ' : '❌ Turned down: ') + r.title, body: note, link: '/hiring.html#requisitions' });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/hr/requisitions/:id/cancel', ...can('hr.manage'), async (req, res) => {
    try {
      const r = await reqRow(id(req.params.id));
      if (['filled', 'cancelled'].includes(r.status)) throw httpError(409, 'It is already ' + r.status);
      await query(`UPDATE job_requisitions SET status = 'cancelled' WHERE id = $1`, [r.id]);
      if (hr) await hr.audit({ entity: 'requisition', entity_id: r.id, action: 'requisition cancelled', detail: [r.title, t((req.body || {}).note, 500)].filter(Boolean).join(' · '), by: me(req) });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  // An approved requisition becomes a posting (saved closed, to finish and open).
  app.post('/api/hr/requisitions/:id/post', ...can('hr.manage'), async (req, res) => {
    try {
      const r = await reqRow(id(req.params.id));
      if (r.status !== 'approved') throw httpError(409, 'Only an approved requisition can be posted');
      const pay = r.salary_min || r.salary_max ? [r.salary_min, r.salary_max].filter(Boolean).map((v) => 'J$' + Math.round(v).toLocaleString('en-JM')).join(' to ') + ' a year' : null;
      const { rows } = await query(`INSERT INTO job_posts (title, department, kind, openings, pay, is_open, requisition_id, hiring_manager_id, interviewer_ids, location, created_by) VALUES ($1,$2,$3,$4,$5,false,$6,$7,$8,'Kingston',$9) RETURNING *`,
        [r.title, r.department, r.kind, r.openings, pay, r.id, r.hiring_manager_id, r.interviewer_ids || [], me(req)]);
      if (hr) await hr.audit({ entity: 'job_post', entity_id: rows[0].id, action: 'posting made from requisition #' + r.id, detail: r.title, by: me(req) });
      res.json({ job: rows[0] });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------- interviews --
  // Hiring staff, the job's hiring manager, or someone on this interview's panel.
  async function panelOk(req, iv) {
    if (await userCan(req, 'hr.manage')) return true;
    const { rows: j } = await query(`SELECT p.hiring_manager_id FROM job_applications a JOIN job_posts p ON p.id = a.job_id WHERE a.id = $1`, [iv.application_id]);
    if (j.length && j[0].hiring_manager_id === me(req)) return true;
    const { rows } = await query(`SELECT 1 FROM hr_interview_panel WHERE interview_id = $1 AND user_id = $2`, [iv.id, me(req)]);
    return rows.length > 0;
  }
  async function syncInterviewAt(appId) {
    await query(`UPDATE job_applications SET interview_at = (SELECT COALESCE(MIN(starts_at) FILTER (WHERE starts_at >= NOW()), MAX(starts_at)) FROM hr_interviews WHERE application_id = $1 AND status = 'scheduled'), updated_at = NOW() WHERE id = $1`, [appId]);
  }
  const MODES = { in_person: 'In person', phone: 'By phone', video: 'Video call' };
  // The interview on the staff calendar, for the panel (invitation, reminder).
  async function calendar(iv, a, panel, by, verb) {
    const title = 'Interview: ' + (a.name || 'applicant') + (a.job ? ' (' + a.job + ')' : '');
    const desc = MODES[iv.mode] + (iv.round > 1 ? ' · round ' + iv.round : '') + '. Score the candidate afterwards: Hiring > My interviews (/hiring.html#interview=' + iv.id + ').' + (iv.notes ? '\n\n' + iv.notes : '');
    const ends = new Date(new Date(iv.starts_at).getTime() + iv.minutes * 60000);
    let ev = iv.event_id;
    if (ev) {
      await query(`UPDATE team_events SET title = $2, description = $3, location = $4, starts_at = $5, ends_at = $6, updated_at = NOW(), cancelled_at = NULL WHERE id = $1`, [ev, title, desc, iv.location, iv.starts_at, ends]);
      await query(`DELETE FROM team_event_attendees WHERE event_id = $1 AND user_id <> ALL($2::int[])`, [ev, panel.concat(by)]);
    } else {
      const { rows } = await query(`INSERT INTO team_events (title, description, location, kind, all_day, starts_at, ends_at, visibility, recurrence, remind_minutes, video, created_by)
        VALUES ($1,$2,$3,'meeting',false,$4,$5,'invitees','none',30,false,$6) RETURNING id`, [title, desc, iv.location, iv.starts_at, ends, by]);
      ev = rows[0].id;
      await query(`UPDATE hr_interviews SET event_id = $2 WHERE id = $1`, [iv.id, ev]);
    }
    await query(`INSERT INTO team_event_attendees (event_id, user_id, response) SELECT $1, u, CASE WHEN u = $3 THEN 'yes' ELSE 'pending' END FROM unnest($2::int[]) u ON CONFLICT DO NOTHING`, [ev, [...new Set(panel.concat(by))], by]);
    const when = new Date(iv.starts_at).toLocaleString('en-JM', { timeZone: 'America/Jamaica', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    await tell(panel.filter((u) => u !== by), { kind: 'event', title: '📅 ' + verb + ': ' + title, body: when + (iv.location ? ' · ' + iv.location : '') + ' · you are on the panel', event_id: ev, link: '/hiring.html#interview=' + iv.id });
    return ev;
  }
  function cleanInterview(b, cur) {
    const s = b.starts_at !== undefined ? new Date(b.starts_at) : cur && new Date(cur.starts_at);
    if (!s || isNaN(s)) throw httpError(400, 'When the interview is');
    return { starts_at: s, minutes: Math.max(10, Math.min(480, parseInt(b.minutes, 10) || (cur ? cur.minutes : 45))), mode: MODES[b.mode] ? b.mode : (cur ? cur.mode : 'in_person'),
      location: b.location !== undefined ? t(b.location, 160) : (cur ? cur.location : null), round: Math.max(1, Math.min(9, parseInt(b.round, 10) || (cur ? cur.round : 1))), notes: b.notes !== undefined ? t(b.notes, 2000) : (cur ? cur.notes : null) };
  }
  const panelOf = (b) => [...new Set((Array.isArray(b.panel) ? b.panel : []).map(id).filter(Boolean))].slice(0, 12);
  app.post('/api/hr/applications/:id/interviews', ...can('hr.manage'), async (req, res) => {
    try {
      const a = await appRow(id(req.params.id)), b = req.body || {};
      if (['hired', 'rejected'].includes(a.stage)) throw httpError(409, 'This application is closed');
      const iv = cleanInterview(b);
      const panel = panelOf(b);
      if (!panel.length) throw httpError(400, 'Choose who is on the interview panel');
      const { rows } = await query(`INSERT INTO hr_interviews (application_id, round, mode, starts_at, minutes, location, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [a.id, iv.round, iv.mode, iv.starts_at, iv.minutes, iv.location, iv.notes, me(req)]);
      for (const u of panel) await query(`INSERT INTO hr_interview_panel (interview_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [rows[0].id, u]);
      if (b.calendar !== false) await calendar(rows[0], a, panel, me(req), 'Interview');
      if (['new', 'screen', 'shortlist'].includes(a.stage)) {
        await query(`UPDATE job_applications SET stage = 'interview' WHERE id = $1`, [a.id]);
        await query(`INSERT INTO application_notes (application_id, kind, note, by_user) VALUES ($1, 'stage', $2, $3)`, [a.id, a.stage + ' → interview', me(req)]);
      }
      await syncInterviewAt(a.id);
      await decision(a.id, 'interview', rows[0].id, 'interview booked', 'round ' + iv.round + ', ' + iv.starts_at.toISOString() + ', panel of ' + panel.length, me(req));
      res.json({ id: rows[0].id });
    } catch (e) { fail(res, e); }
  });
  app.patch('/api/hr/interviews/:id', ...can('hr.manage'), async (req, res) => {
    try {
      const { rows: cur } = await query(`SELECT * FROM hr_interviews WHERE id = $1`, [id(req.params.id)]);
      if (!cur.length) throw httpError(404, 'Interview not found');
      const old = cur[0], b = req.body || {};
      const a = await appRow(old.application_id);
      const iv = cleanInterview(b, old);
      const status = ['scheduled', 'done', 'cancelled', 'no_show'].includes(b.status) ? b.status : old.status;
      await query(`UPDATE hr_interviews SET starts_at = $2, minutes = $3, mode = $4, location = $5, round = $6, notes = $7, status = $8 WHERE id = $1`, [old.id, iv.starts_at, iv.minutes, iv.mode, iv.location, iv.round, iv.notes, status]);
      let panel = null;
      if (Array.isArray(b.panel)) {
        panel = panelOf(b);
        if (!panel.length) throw httpError(400, 'Choose who is on the interview panel');
        await query(`DELETE FROM hr_interview_panel WHERE interview_id = $1 AND user_id <> ALL($2::int[])`, [old.id, panel]);
        for (const u of panel) await query(`INSERT INTO hr_interview_panel (interview_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [old.id, u]);
      } else panel = (await query(`SELECT user_id FROM hr_interview_panel WHERE interview_id = $1`, [old.id])).rows.map((r) => r.user_id);
      const moved = +new Date(old.starts_at) !== +iv.starts_at;
      if (status === 'cancelled' && old.status !== 'cancelled') {
        if (old.event_id) await query(`UPDATE team_events SET cancelled_at = NOW() WHERE id = $1`, [old.event_id]);
        await tell(panel.filter((u) => u !== me(req)), { kind: 'event', title: '📅 Cancelled: interview with ' + (a.name || 'applicant'), event_id: old.event_id });
      } else if (status === 'scheduled' && (moved || Array.isArray(b.panel) || old.status === 'cancelled')) {
        await calendar(Object.assign({}, old, iv, { id: old.id }), a, panel, me(req), moved ? 'Interview moved' : 'Interview');
      }
      await syncInterviewAt(a.id);
      await decision(a.id, 'interview', old.id, status !== old.status ? 'interview ' + status.replace('_', ' ') : moved ? 'interview moved' : 'interview changed', moved ? iv.starts_at.toISOString() : t(b.reason, 300), me(req));
      res.json({ ok: true, moved });
    } catch (e) { fail(res, e); }
  });
  // Jobs I am the hiring manager or an interviewer for, with their applicants
  // (the hiring manager sees each one; interviewers see the ones they meet).
  app.get('/api/hr/my-jobs', requireAdmin, async (req, res) => {
    try {
      const { rows: jobs } = await query(`SELECT j.id, j.title, j.is_open, j.openings, (j.hiring_manager_id = $1) AS is_manager, j.interviewer_ids,
          ${STAGES.map((s) => `COUNT(a.id) FILTER (WHERE a.stage = '${s}' AND a.anonymised_at IS NULL)::int AS ${s}`).join(', ')}
        FROM job_posts j LEFT JOIN job_applications a ON a.job_id = j.id WHERE j.hiring_manager_id = $1 OR $1 = ANY(j.interviewer_ids) GROUP BY j.id ORDER BY j.is_open DESC, j.created_at DESC`, [me(req)]);
      const managed = jobs.filter((j) => j.is_manager).map((j) => j.id);
      const { rows: apps } = managed.length ? await query(`SELECT a.id, a.job_id, a.ref, a.name, a.stage, a.screen_result, a.interview_at, a.created_at,
          (SELECT ROUND(AVG(s.overall)::numeric, 1)::float FROM hr_interview_scores s JOIN hr_interviews i ON i.id = s.interview_id WHERE i.application_id = a.id) AS avg_overall
        FROM job_applications a WHERE a.job_id = ANY($1::int[]) AND a.anonymised_at IS NULL ORDER BY a.created_at DESC LIMIT 500`, [managed]) : { rows: [] };
      res.json({ jobs, applications: apps, stages: STAGES });
    } catch (e) { fail(res, e); }
  });
  // The hiring manager's word on an applicant: a note on the history.
  app.post('/api/hr/applications/:id/notes', requireAdmin, async (req, res) => {
    try {
      await canSeeApp(req, req.params.id);
      const note = t((req.body || {}).note, 2000);
      if (!note) throw httpError(400, 'Write the note');
      await query(`INSERT INTO application_notes (application_id, kind, note, by_user) VALUES ($1, 'note', $2, $3)`, [id(req.params.id), note, me(req)]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  // Interviews I sit on: to prepare and to score. Any staff member on a panel.
  app.get('/api/hr/my-interviews', requireAdmin, async (req, res) => {
    try {
      const { rows } = await query(`SELECT i.id, i.round, i.mode, i.starts_at, i.minutes, i.location, i.status, a.name, a.ref, j.title AS job,
          EXISTS (SELECT 1 FROM hr_interview_scores s WHERE s.interview_id = i.id AND s.user_id = $1) AS scored
        FROM hr_interviews i JOIN hr_interview_panel p ON p.interview_id = i.id AND p.user_id = $1 JOIN job_applications a ON a.id = i.application_id LEFT JOIN job_posts j ON j.id = a.job_id
        WHERE a.anonymised_at IS NULL AND i.status <> 'cancelled' AND i.starts_at > NOW() - interval '60 days' ORDER BY i.starts_at`, [me(req)]);
      res.json({ interviews: rows, hr: await userCan(req, 'hr.manage') });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/hr/interviews/:id', requireAdmin, async (req, res) => {
    try {
      const { rows } = await query(`SELECT * FROM hr_interviews WHERE id = $1`, [id(req.params.id)]);
      if (!rows.length || !(await panelOk(req, rows[0]))) throw httpError(404, 'Interview not found');
      const iv = rows[0], a = await appRow(iv.application_id);
      const { rows: mine } = await query(`SELECT * FROM hr_interview_scores WHERE interview_id = $1 AND user_id = $2`, [iv.id, me(req)]);
      const criteria = Array.isArray(a.job_scorecard) && a.job_scorecard.length ? a.job_scorecard : SCORECARD;
      // A panel member sees what they need to interview: not the contact details or the CV.
      res.json({ interview: iv, candidate: { name: a.name, ref: a.ref, job: a.job, parish: a.parish, answers: a.answers, cover: a.cover, screen_notes: a.screen_notes, stage: a.stage },
        criteria, my_score: mine[0] || null });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/hr/interviews/:id/score', requireAdmin, async (req, res) => {
    try {
      const { rows } = await query(`SELECT * FROM hr_interviews WHERE id = $1`, [id(req.params.id)]);
      if (!rows.length || !(await panelOk(req, rows[0]))) throw httpError(404, 'Interview not found');
      const iv = rows[0], a = await appRow(iv.application_id), b = req.body || {};
      if (iv.status === 'cancelled') throw httpError(409, 'This interview was cancelled');
      const criteria = Array.isArray(a.job_scorecard) && a.job_scorecard.length ? a.job_scorecard : SCORECARD;
      const given = new Map((Array.isArray(b.scores) ? b.scores : []).map((x) => [x && x.key, x]));
      const scores = criteria.map((c) => { const x = given.get(c.key) || {}; const s = parseInt(x.score, 10); return { key: c.key, label: c.label, score: s >= 1 && s <= 5 ? s : null, comment: t(x.comment, 600) }; });
      const scored = scores.filter((s) => s.score);
      if (scored.length < Math.ceil(criteria.length / 2)) throw httpError(400, 'Score at least half of the areas');
      const recommend = RECOMMEND.includes(b.recommend) ? b.recommend : null;
      if (!recommend) throw httpError(400, 'Say whether you would hire them');
      const overall = parseInt(b.overall, 10) >= 1 && parseInt(b.overall, 10) <= 5 ? parseInt(b.overall, 10) : Math.round(scored.reduce((s, x) => s + x.score, 0) / scored.length);
      await query(`INSERT INTO hr_interview_scores (interview_id, user_id, scores, overall, recommend, strengths, concerns) VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7)
        ON CONFLICT (interview_id, user_id) DO UPDATE SET scores = EXCLUDED.scores, overall = EXCLUDED.overall, recommend = EXCLUDED.recommend, strengths = EXCLUDED.strengths, concerns = EXCLUDED.concerns, submitted_at = NOW()`,
        [iv.id, me(req), JSON.stringify(scores), overall, recommend, t(b.strengths, 2000), t(b.concerns, 2000)]);
      // Everyone on the panel has scored a past interview: it is done.
      await query(`UPDATE hr_interviews i SET status = 'done' WHERE i.id = $1 AND i.status = 'scheduled' AND i.starts_at < NOW()
        AND NOT EXISTS (SELECT 1 FROM hr_interview_panel p WHERE p.interview_id = i.id AND NOT EXISTS (SELECT 1 FROM hr_interview_scores s WHERE s.interview_id = i.id AND s.user_id = p.user_id))`, [iv.id]);
      await decision(a.id, 'score', iv.id, 'scorecard in (round ' + iv.round + ')', overall + '/5, ' + recommend.replace('_', ' '), me(req));
      res.json({ ok: true, overall });
    } catch (e) { fail(res, e); }
  });

  // Side by side: everyone past screening for one job, with the panel's view.
  app.get('/api/hr/jobs/:id/compare', requireAdmin, async (req, res) => {
    try {
      if (!['hr', 'manager'].includes(await jobRole(req, id(req.params.id)))) throw httpError(403, 'Only hiring staff and this job’s hiring manager can compare its candidates');
      const { rows: jr } = await query(`SELECT id, title, scorecard FROM job_posts WHERE id = $1`, [id(req.params.id)]);
      if (!jr.length) throw httpError(404, 'Job not found');
      const criteria = Array.isArray(jr[0].scorecard) && jr[0].scorecard.length ? jr[0].scorecard : SCORECARD;
      const { rows } = await query(`SELECT a.id, a.ref, a.name, a.stage, a.rating, a.screen_result, a.created_at,
          (SELECT ROUND(AVG(s.overall)::numeric, 1)::float FROM hr_interview_scores s JOIN hr_interviews i ON i.id = s.interview_id WHERE i.application_id = a.id) AS avg_overall,
          (SELECT COUNT(*)::int FROM hr_interview_scores s JOIN hr_interviews i ON i.id = s.interview_id WHERE i.application_id = a.id) AS n_scores,
          (SELECT json_object_agg(r, n) FROM (SELECT s.recommend AS r, COUNT(*)::int AS n FROM hr_interview_scores s JOIN hr_interviews i ON i.id = s.interview_id WHERE i.application_id = a.id GROUP BY s.recommend) x) AS recommend,
          (SELECT json_object_agg(k, v) FROM (SELECT x->>'key' AS k, ROUND(AVG((x->>'score')::numeric), 1)::float AS v FROM hr_interview_scores s JOIN hr_interviews i ON i.id = s.interview_id, jsonb_array_elements(s.scores) x
            WHERE i.application_id = a.id AND x->>'score' IS NOT NULL GROUP BY 1) y) AS by_area,
          (SELECT COUNT(*)::int FROM hr_references r WHERE r.application_id = a.id) AS refs, (SELECT COUNT(*)::int FROM hr_references r WHERE r.application_id = a.id AND r.status = 'done') AS refs_done,
          (SELECT COUNT(*)::int FROM hr_references r WHERE r.application_id = a.id AND r.rating = 'poor') AS refs_poor,
          (SELECT o.status FROM hr_offers o WHERE o.application_id = a.id ORDER BY o.id DESC LIMIT 1) AS offer
        FROM job_applications a WHERE a.job_id = $1 AND a.anonymised_at IS NULL AND a.stage IN ('shortlist', 'interview', 'references', 'offer', 'hired')
        ORDER BY avg_overall DESC NULLS LAST, a.rating DESC NULLS LAST, a.created_at`, [jr[0].id]);
      res.json({ job: jr[0], criteria, candidates: rows });
    } catch (e) { fail(res, e); }
  });
  // The choice, with the reason: moves the chosen one on and records why.
  app.post('/api/hr/applications/:id/select', ...can('hr.manage'), async (req, res) => {
    try {
      const a = await appRow(id(req.params.id)), b = req.body || {};
      const why = t(b.reason, 1000);
      if (!why) throw httpError(400, 'Say why this candidate was chosen');
      const to = b.to === 'offer' ? 'offer' : 'references';
      if (['hired', 'rejected'].includes(a.stage)) throw httpError(409, 'This application is closed');
      await query(`UPDATE job_applications SET stage = $2, updated_at = NOW() WHERE id = $1`, [a.id, to]);
      await query(`INSERT INTO application_notes (application_id, kind, note, by_user) VALUES ($1, 'stage', $2, $3)`, [a.id, a.stage + ' → ' + to + ' (selected)', me(req)]);
      await decision(a.id, 'application', a.id, 'selected for ' + (to === 'offer' ? 'an offer' : 'reference checks'), why, me(req));
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------- references --
  function cleanRef(b) {
    const r = { referee_name: t(b.referee_name, 120), relationship: t(b.relationship, 80), company: t(b.company, 120), phone: t(b.phone, 40), email: t(b.email, 160) };
    if (!r.referee_name) throw httpError(400, 'The referee’s name');
    if (!r.phone && !r.email) throw httpError(400, 'A phone number or email for the referee');
    if (r.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email)) throw httpError(400, 'The referee’s email does not look right');
    return r;
  }
  async function refRow(rid) {
    const { rows } = await query(`SELECT r.*, a.name, j.title AS job FROM hr_references r JOIN job_applications a ON a.id = r.application_id LEFT JOIN job_posts j ON j.id = a.job_id WHERE r.id = $1 AND a.anonymised_at IS NULL`, [rid]);
    if (!rows.length) throw httpError(404, 'Reference not found');
    return rows[0];
  }
  app.post('/api/hr/applications/:id/references', ...can('hr.manage'), async (req, res) => {
    try {
      const a = await appRow(id(req.params.id)), r = cleanRef(req.body || {});
      const { rows } = await query(`INSERT INTO hr_references (application_id, referee_name, relationship, company, phone, email, by_user) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [a.id, r.referee_name, r.relationship, r.company, r.phone, r.email, me(req)]);
      await decision(a.id, 'reference', rows[0].id, 'referee added', r.referee_name + (r.company ? ', ' + r.company : ''), me(req));
      res.json({ id: rows[0].id });
    } catch (e) { fail(res, e); }
  });
  app.patch('/api/hr/references/:id', ...can('hr.manage'), async (req, res) => {
    try {
      const r = await refRow(id(req.params.id)), b = req.body || {};
      const c = b.referee_name !== undefined ? cleanRef(Object.assign({}, r, b)) : r;
      const status = ['pending', 'asked', 'done', 'unreachable'].includes(b.status) ? b.status : r.status;
      const rating = b.rating !== undefined ? (['good', 'mixed', 'poor'].includes(b.rating) ? b.rating : null) : r.rating;
      if (status === 'done' && !(t(b.summary, 4000) || r.summary)) throw httpError(400, 'Write down what the referee said');
      await query(`UPDATE hr_references SET referee_name = $2, relationship = $3, company = $4, phone = $5, email = $6, status = $7, summary = COALESCE($8, summary), rating = $9,
          would_rehire = CASE WHEN $10 THEN $11 ELSE would_rehire END, done_at = CASE WHEN $7 = 'done' THEN COALESCE(done_at, NOW()) ELSE NULL END, by_user = $12 WHERE id = $1`,
        [r.id, c.referee_name, c.relationship, c.company, c.phone, c.email, status, t(b.summary, 4000), rating, 'would_rehire' in b, b.would_rehire == null ? null : !!b.would_rehire, me(req)]);
      if (status !== r.status || rating !== r.rating) await decision(r.application_id, 'reference', r.id, 'reference ' + status, r.referee_name + (rating ? ' · ' + rating : ''), me(req));
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.delete('/api/hr/references/:id', ...can('hr.manage'), async (req, res) => {
    try {
      const r = await refRow(id(req.params.id));
      await query(`DELETE FROM hr_references WHERE id = $1`, [r.id]);
      await decision(r.application_id, 'reference', r.id, 'referee removed', r.referee_name, me(req));
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/hr/references/:id/email-draft', ...can('hr.manage'), async (req, res) => {
    try {
      const r = await refRow(id(req.params.id));
      if (!r.email) throw httpError(400, 'This referee has no email address. Phone them instead.');
      const tpl = (await templates()).reference, v = { referee: r.referee_name, name: r.name, job: r.job || 'the position', first: r.referee_name.split(' ')[0] };
      res.json({ to: r.email, subject: fill(tpl.subject, v), body: fill(tpl.body, v), mail_on: mailer.isActive() });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/hr/references/:id/email', ...can('hr.manage'), async (req, res) => {
    try {
      const r = await refRow(id(req.params.id)), b = req.body || {};
      const subject = t(b.subject, 200), body = t(b.body, 8000);
      if (!r.email) throw httpError(400, 'This referee has no email address');
      if (!subject || !body) throw httpError(400, 'A subject and a message');
      let note;
      try {
        const m = await mailer.sendEmail({ to: r.email, subject, text: body, html: asHtml(body) });
        note = (m && m.stubbed ? 'Reference request not sent (email is not set up on this till)' : 'Reference request emailed') + ' to ' + r.referee_name;
      } catch (e) { note = 'Reference request failed (' + String(e.message).slice(0, 100) + ')'; }
      await query(`UPDATE hr_references SET status = CASE WHEN status = 'pending' THEN 'asked' ELSE status END, asked_at = NOW() WHERE id = $1`, [r.id]);
      await query(`INSERT INTO application_notes (application_id, kind, note, by_user) VALUES ($1, 'email', $2, $3)`, [r.application_id, note, me(req)]);
      res.json({ ok: true, note });
    } catch (e) { fail(res, e); }
  });

  // ----------------------------------------------------------- offers --
  const OFFER_COLS = ['job_title', 'department_id', 'manager_user_id', 'start_date', 'contract_type', 'contract_end', 'pay_type', 'salary_annual', 'hourly_rate', 'frequency', 'probation_months', 'hours', 'benefits', 'conditions', 'respond_by'];
  function cleanOffer(b) {
    const o = { job_title: t(b.job_title, 120), department_id: id(b.department_id) || null, manager_user_id: id(b.manager_user_id) || null, start_date: isDate(b.start_date),
      contract_type: CONTRACTS.includes(b.contract_type) ? b.contract_type : 'permanent', contract_end: isDate(b.contract_end), pay_type: b.pay_type === 'hourly' ? 'hourly' : 'salary',
      salary_annual: money(b.salary_annual), hourly_rate: money(b.hourly_rate), frequency: ['weekly', 'fortnightly', 'monthly'].includes(b.frequency) ? b.frequency : 'monthly',
      probation_months: Math.max(0, Math.min(12, parseInt(b.probation_months, 10) >= 0 ? parseInt(b.probation_months, 10) : 3)), hours: t(b.hours, 300), benefits: t(b.benefits, 2000), conditions: t(b.conditions, 4000), respond_by: isDate(b.respond_by) };
    if (!o.job_title) throw httpError(400, 'The job title');
    if (!o.start_date) throw httpError(400, 'The start date');
    if (o.pay_type === 'salary' ? !o.salary_annual : !o.hourly_rate) throw httpError(400, o.pay_type === 'salary' ? 'The yearly salary (J$)' : 'The hourly rate (J$)');
    if (o.pay_type === 'salary') o.hourly_rate = null; else o.salary_annual = null;
    if (o.contract_type === 'fixed_term' && !o.contract_end) throw httpError(400, 'When the fixed-term contract ends');
    return o;
  }
  async function offerRow(oid) {
    const { rows } = await query(`SELECT o.*, a.name, a.email, a.ref, a.id AS app_id, a.stage, dp.name AS department, ${nm('m')} AS manager FROM hr_offers o JOIN job_applications a ON a.id = o.application_id
      LEFT JOIN departments dp ON dp.id = o.department_id LEFT JOIN users m ON m.id = o.manager_user_id WHERE o.id = $1 AND a.anonymised_at IS NULL`, [oid]);
    if (!rows.length) throw httpError(404, 'Offer not found');
    return rows[0];
  }
  const CONTRACT_LABEL = { permanent: 'Permanent', fixed_term: 'Fixed term', part_time: 'Part time', casual: 'Casual', contractor: 'Contractor', intern: 'Internship' };
  const longDate = (v) => (v ? new Date(String(v instanceof Date ? v.toISOString() : v).slice(0, 10) + 'T12:00:00Z').toLocaleDateString('en-JM', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' }) : '');
  // The letter itself, as a fragment (shown on the careers page) or a whole page (filed and printed).
  function offerLetter(o, whole) {
    const pay = o.pay_type === 'hourly' ? jmd(o.hourly_rate) + ' an hour' : jmd(o.salary_annual) + ' a year, paid ' + o.frequency;
    const rows = [['Position', o.job_title], ['Department', o.department], ['Reporting to', o.manager], ['Start date', longDate(o.start_date)],
      ['Contract', CONTRACT_LABEL[o.contract_type] + (o.contract_end ? ', ending ' + longDate(o.contract_end) : '')], ['Pay', pay + ', before the statutory deductions (PAYE, NIS, NHT and Education Tax)'],
      ['Hours', o.hours], ['Probation', o.probation_months ? o.probation_months + ' months' : 'None'], ['Benefits', o.benefits]].filter((r) => r[1]);
    const body = '<p><b>Morty\'s Auto Parts Ltd</b><br>51 Red Hills Road, Kingston · +1 876-905-4111</p><p>' + escHtml(new Date(o.sent_at || Date.now()).toLocaleDateString('en-JM', { timeZone: 'America/Jamaica', day: 'numeric', month: 'long', year: 'numeric' })) + '</p>' +
      '<p>Dear ' + escHtml(o.name || '') + ',</p><p>We are pleased to offer you employment with Morty\'s Auto Parts Ltd on the terms below.</p>' +
      '<table style="border-collapse:collapse">' + rows.map((r) => '<tr><th style="text-align:left;padding:4px 14px 4px 0;vertical-align:top">' + escHtml(r[0]) + '</th><td style="padding:4px 0">' + escHtml(r[1]) + '</td></tr>').join('') + '</table>' +
      (o.conditions ? '<p><b>Conditions</b><br>' + escHtml(o.conditions).replace(/\n/g, '<br>') + '</p>' : '') +
      '<p>This offer depends on satisfactory references and on you giving us your TRN, NIS number and a photo ID before you start.' + (o.respond_by ? ' Please let us know your answer by ' + escHtml(longDate(o.respond_by)) + '.' : '') + '</p>' +
      '<p>Yours sincerely,<br>Morty\'s Auto Parts Ltd</p>' +
      (o.status === 'accepted' ? '<p style="border-top:1px solid #ccc;padding-top:8px"><b>Accepted</b> by ' + escHtml(o.response_name || o.name || '') + ' on ' + escHtml(new Date(o.responded_at).toLocaleString('en-JM', { timeZone: 'America/Jamaica' })) + (o.response_ip ? ' (from ' + escHtml(o.response_ip) + ')' : ' (recorded by staff)') + '</p>' : '');
    return whole ? '<!doctype html><html><head><meta charset="utf-8"><title>Offer of employment</title><style>body{font:14px/1.6 Arial,sans-serif;max-width:680px;margin:30px auto;color:#111}</style></head><body><h1 style="font-size:20px">Offer of employment</h1>' + body + '</body></html>' : body;
  }
  app.post('/api/hr/applications/:id/offers', ...can('hr.manage'), async (req, res) => {
    try {
      const a = await appRow(id(req.params.id));
      if (['hired', 'rejected'].includes(a.stage)) throw httpError(409, 'This application is closed');
      const { rows: live } = await query(`SELECT id FROM hr_offers WHERE application_id = $1 AND status NOT IN ('withdrawn', 'declined')`, [a.id]);
      if (live.length) throw httpError(409, 'There is already an offer for this applicant. Change or withdraw that one.');
      const o = cleanOffer(req.body || {});
      const { rows } = await query(`INSERT INTO hr_offers (application_id, ${OFFER_COLS.join(', ')}, created_by) VALUES ($1, ${OFFER_COLS.map((c, i) => '$' + (i + 2)).join(', ')}, $${OFFER_COLS.length + 2}) RETURNING id`,
        [a.id].concat(OFFER_COLS.map((c) => o[c]), [me(req)]));
      if (a.stage !== 'offer') {
        await query(`UPDATE job_applications SET stage = 'offer', updated_at = NOW() WHERE id = $1`, [a.id]);
        await query(`INSERT INTO application_notes (application_id, kind, note, by_user) VALUES ($1, 'stage', $2, $3)`, [a.id, a.stage + ' → offer', me(req)]);
      }
      await decision(a.id, 'offer', rows[0].id, 'offer drafted', o.job_title + ', ' + (o.salary_annual ? jmd(o.salary_annual) + '/yr' : jmd(o.hourly_rate) + '/hr') + ', start ' + o.start_date, me(req));
      if ((req.body || {}).submit) await submitOffer(await offerRow(rows[0].id), me(req));
      res.json({ id: rows[0].id });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/hr/offers/:id', ...can('hr.manage'), async (req, res) => {
    try {
      const cur = await offerRow(id(req.params.id));
      if (cur.status !== 'draft') throw httpError(409, 'Only a draft offer can be changed. Withdraw this one and make a new one.');
      const o = cleanOffer(req.body || {});
      await query(`UPDATE hr_offers SET ${OFFER_COLS.map((c, i) => c + ' = $' + (i + 2)).join(', ')}, updated_at = NOW() WHERE id = $1`, [cur.id].concat(OFFER_COLS.map((c) => o[c])));
      await decision(cur.app_id, 'offer', cur.id, 'offer changed', o.job_title + ', ' + (o.salary_annual ? jmd(o.salary_annual) + '/yr' : jmd(o.hourly_rate) + '/hr'), me(req));
      if ((req.body || {}).submit) await submitOffer(await offerRow(cur.id), me(req));
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  async function submitOffer(o, by) {
    if (o.status !== 'draft') throw httpError(409, 'The offer is already ' + o.status.replace('_', ' '));
    await query(`UPDATE hr_offers SET status = 'pending_approval', updated_at = NOW() WHERE id = $1`, [o.id]);
    await decision(o.app_id, 'offer', o.id, 'offer sent for approval', null, by);
    await tell((await approvers()).map((u) => u.id).filter((u) => u !== by), { kind: 'memo', title: '📄 Job offer to approve: ' + o.name + ' (' + o.job_title + ')', body: o.salary_annual ? jmd(o.salary_annual) + ' a year' : jmd(o.hourly_rate) + ' an hour', link: '/hiring.html#app=' + o.app_id });
  }
  app.post('/api/hr/offers/:id/submit', ...can('hr.manage'), async (req, res) => {
    try { await submitOffer(await offerRow(id(req.params.id)), me(req)); res.json({ ok: true }); } catch (e) { fail(res, e); }
  });
  app.post('/api/hr/offers/:id/decide', ...can('hr.approve'), async (req, res) => {
    try {
      const o = await offerRow(id(req.params.id)), b = req.body || {};
      if (o.status !== 'pending_approval') throw httpError(409, 'This offer is not waiting for approval');
      const ok = b.decision === 'approve', note = t(b.note, 1000);
      if (!ok && !note) throw httpError(400, 'Say what needs changing');
      await query(`UPDATE hr_offers SET status = $2, approved_by = CASE WHEN $3 THEN $4::int ELSE NULL END, approved_at = CASE WHEN $3 THEN NOW() ELSE NULL END, updated_at = NOW() WHERE id = $1`, [o.id, ok ? 'approved' : 'draft', ok, me(req)]);
      await decision(o.app_id, 'offer', o.id, ok ? 'offer approved' : 'offer sent back', note, me(req));
      if (o.created_by && o.created_by !== me(req)) await tell([o.created_by], { kind: 'memo', title: (ok ? '✅ Offer approved: ' : '↩ Offer sent back: ') + o.name, body: note || (ok ? 'You can send it now.' : null), link: '/hiring.html#app=' + o.app_id });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/hr/offers/:id/letter', ...manageOrApprove, async (req, res) => {
    try {
      const o = await offerRow(id(req.params.id));
      res.set('Content-Type', 'text/html; charset=utf-8'); res.set('Cache-Control', 'private, no-store');
      res.send(offerLetter(o, true));
    } catch (e) { fail(res, e); }
  });
  async function fileOffer(req, o, title) {
    if (!docs) return null;
    try {
      const doc = await docs.fileHtml(req, { title: title + ': ' + (o.name || '') + ' (' + o.job_title + ')', category: 'contract', html: offerLetter(o, true),
        links: [{ type: 'applicant', id: o.app_id }].concat(o.hired_user_id ? [{ type: 'staff', id: o.hired_user_id }] : []), note: 'From the hiring screen' });
      await query(`UPDATE hr_offers SET document_id = $2 WHERE id = $1`, [o.id, doc.id]);
      return doc;
    } catch (e) { console.warn('[careers] offer not filed', e.message); return null; }
  }
  app.post('/api/hr/offers/:id/send', ...can('hr.manage'), async (req, res) => {
    try {
      const o = await offerRow(id(req.params.id)), b = req.body || {};
      if (!['approved', 'sent'].includes(o.status)) throw httpError(409, o.status === 'pending_approval' ? 'The offer is waiting for approval' : 'Only an approved offer can be sent');
      if (!o.email) throw httpError(400, 'This applicant has no email address. Print the letter and record their answer instead.');
      const token = o.token || crypto.randomBytes(16).toString('hex');
      await query(`UPDATE hr_offers SET status = 'sent', token = $2, sent_at = NOW(), updated_at = NOW() WHERE id = $1`, [o.id, token]);
      const a = await appRow(o.app_id);
      const v = await vars(req, a, { title: o.job_title });
      const tpl = (await templates()).offer;
      const subject = t(b.subject, 200) || fill(tpl.subject, v), text = t(b.body, 8000) || fill(tpl.body, v);
      const note = await sendToApplicant(a, subject, text.includes(offerLink(req, token)) ? text : text + '\n\nYour offer letter: ' + offerLink(req, token), me(req));
      const doc = o.document_id ? null : await fileOffer(req, Object.assign(o, { status: 'sent' }), 'Offer letter');
      await decision(o.app_id, 'offer', o.id, 'offer sent', note + (doc ? ' · filed as ' + doc.number : ''), me(req));
      res.json({ ok: true, note, link: offerLink(req, token) });
    } catch (e) { fail(res, e); }
  });
  async function respond(req, o, accepted, name, note, ip, by) {
    await query(`UPDATE hr_offers SET status = $2, responded_at = NOW(), response_name = $3, response_note = $4, response_ip = $5, updated_at = NOW() WHERE id = $1`, [o.id, accepted ? 'accepted' : 'declined', name, note, ip]);
    const fresh = await offerRow(o.id);
    let doc = null;
    if (accepted) doc = await fileOffer(req, fresh, 'Offer accepted');
    await decision(o.app_id, 'offer', o.id, accepted ? 'offer accepted' : 'offer declined', [by ? 'recorded by staff' : 'by the candidate online, typed name “' + name + '”', note, doc ? 'filed as ' + doc.number : null].filter(Boolean).join(' · '), by);
    const who = [o.created_by, o.manager_user_id].filter((u) => u && u !== by);
    await tell(who, { kind: 'memo', title: (accepted ? '🎉 Offer accepted: ' : 'Offer declined: ') + o.name + ' (' + o.job_title + ')', body: accepted ? 'Press Hire on the application to open their staff file.' : note, link: '/hiring.html#app=' + o.app_id });
    const inbox = t(await setting('careers_notify_email', ''), 160);
    if (inbox && !by) mailer.sendEmail({ to: inbox, subject: 'Offer ' + (accepted ? 'accepted' : 'declined') + ': ' + o.name + ' (' + o.job_title + ')', text: (note ? note + '\n\n' : '') + 'Open the hiring screen: ' + baseUrl(req) + '/hiring.html#app=' + o.app_id }).catch(() => {});
  }
  app.post('/api/hr/offers/:id/response', ...can('hr.manage'), async (req, res) => {
    try {
      const o = await offerRow(id(req.params.id)), b = req.body || {};
      if (!['approved', 'sent'].includes(o.status)) throw httpError(409, o.status === 'pending_approval' || o.status === 'draft' ? 'The offer must be approved first' : 'This offer is already ' + o.status);
      const accepted = b.decision === 'accept';
      const note = t(b.note, 1000);
      if (!note) throw httpError(400, accepted ? 'How they accepted (for example: signed the letter in the office)' : 'What they said');
      await respond(req, o, accepted, o.name, note, null, me(req));
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/hr/offers/:id/withdraw', ...can('hr.manage'), async (req, res) => {
    try {
      const o = await offerRow(id(req.params.id)), why = t((req.body || {}).reason, 1000);
      if (['withdrawn', 'declined'].includes(o.status) || o.stage === 'hired') throw httpError(409, 'This offer cannot be withdrawn now');
      if (!why) throw httpError(400, 'Say why the offer is withdrawn');
      await query(`UPDATE hr_offers SET status = 'withdrawn', token = NULL, updated_at = NOW() WHERE id = $1`, [o.id]);
      await decision(o.app_id, 'offer', o.id, 'offer withdrawn', why, me(req));
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  // The candidate's offer page, reached by the private link in the offer email.
  async function offerByToken(req) {
    const ip = ipOf(req), r = LOOK.get(ip) || { n: 0, first: Date.now() };
    if (Date.now() - r.first > 3600000) { r.n = 0; r.first = Date.now(); }
    if (r.n >= 30) throw httpError(429, 'Too many tries. Please try again later.');
    const token = String(req.params.token || '');
    const { rows } = /^[0-9a-f]{32}$/.test(token) ? await query(`SELECT id FROM hr_offers WHERE token = $1 AND status IN ('sent', 'accepted', 'declined')`, [token]) : { rows: [] };
    if (!rows.length) { r.n++; LOOK.set(ip, r); throw httpError(404, 'This offer link is not valid, or the offer has been withdrawn.'); }
    return offerRow(rows[0].id);
  }
  app.get('/api/public/offers/:token', async (req, res) => {
    try {
      const o = await offerByToken(req);
      res.set('Cache-Control', 'no-store');
      res.json({ name: o.name, job_title: o.job_title, status: o.status, respond_by: o.respond_by, responded_at: o.responded_at, letter: offerLetter(o, false) });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/public/offers/:token/respond', async (req, res) => {
    try {
      const o = await offerByToken(req), b = req.body || {};
      if (o.status !== 'sent') throw httpError(409, 'You have already answered this offer. Please call us if you want to change your answer.');
      const accepted = b.decision === 'accept', name = t(b.name, 120);
      if (accepted && (!name || name.length < 3)) throw httpError(400, 'Type your full name to accept');
      await respond(req, o, accepted, name || o.name, t(b.note, 1000), ipOf(req), null);
      res.json({ ok: true, message: accepted ? 'Thank you, ' + String(o.name || '').split(' ')[0] + '. Your acceptance is recorded. We will contact you about your first day.' : 'Thank you for letting us know. We have recorded your answer.' });
    } catch (e) { fail(res, e); }
  });
  // Every hiring decision, newest first.
  app.get('/api/hr/audit', ...can('hr.manage'), async (req, res) => {
    try {
      const { rows } = await query(`SELECT a.at, a.entity, a.action, a.detail, a.application_id, x.name AS applicant, x.ref, ${nm('b')} AS by_name FROM hr_audit a
        LEFT JOIN job_applications x ON x.id = a.application_id LEFT JOIN users b ON b.id = a.by_user
        WHERE a.entity IN ('requisition', 'job_post', 'application', 'interview', 'score', 'reference', 'offer', 'hire') ORDER BY a.at DESC LIMIT 500`);
      res.json({ log: rows });
    } catch (e) { fail(res, e); }
  });

  // Hiring settings: the email templates, the inbox told about new
  // applications, and how long applicants who are not hired are kept.
  app.get('/api/hr/settings', ...can('hr.manage'), async (req, res) => {
    try {
      res.json({
        templates: await templates(), defaults: TEMPLATES,
        notify_email: await setting('careers_notify_email', ''),
        retention_days: parseInt(await setting('careers_retention_days', '365'), 10) || 365,
        require_requisition: (await setting('hr_require_requisition', 'off')) === 'on',
        mail_on: mailer.isActive(),
      });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/hr/settings', ...can('hr.manage'), async (req, res) => {
    try {
      const b = req.body || {};
      if (b.templates && typeof b.templates === 'object') {
        const out = {};
        for (const k of Object.keys(TEMPLATES)) {
          const s = b.templates[k] || {};
          const subject = t(s.subject, 200), body = t(s.body, 8000);
          // Saved only where it differs from the default, so a later
          // improvement to a default reaches shops that never changed it.
          if (subject && subject !== TEMPLATES[k].subject) (out[k] = out[k] || {}).subject = subject;
          if (body && body !== TEMPLATES[k].body) (out[k] = out[k] || {}).body = body;
        }
        await putSetting('careers_templates', JSON.stringify(out));
      }
      if (b.notify_email !== undefined) {
        const e = t(b.notify_email, 160);
        if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw httpError(400, 'The hiring inbox must be an email address');
        await putSetting('careers_notify_email', e || '');
      }
      if (b.retention_days !== undefined) {
        const d = parseInt(b.retention_days, 10);
        if (!(d >= 30 && d <= 1095)) throw httpError(400, 'Keep applications between 30 days and 3 years');
        await putSetting('careers_retention_days', String(d));
      }
      if (b.require_requisition !== undefined && (await setting('hr_require_requisition', 'off') === 'on') !== !!b.require_requisition) {
        await putSetting('hr_require_requisition', b.require_requisition ? 'on' : 'off');
        if (hr) await hr.audit({ entity: 'requisition', action: 'rule changed', detail: 'postings ' + (b.require_requisition ? 'need' : 'do not need') + ' an approved requisition', by: me(req) });
      }
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  async function anonymise(where, vals, by, why) {
    const { rows } = await query(`SELECT a.id, a.cv_file FROM job_applications a WHERE a.anonymised_at IS NULL AND a.stage <> 'hired' AND ${where}`, vals);
    for (const r of rows) {
      removeFile(r.cv_file);
      const { rows: docs } = await query('DELETE FROM application_documents WHERE application_id = $1 RETURNING file', [r.id]);
      docs.forEach((d) => removeFile(d.file));
      await query(`UPDATE job_applications SET name = NULL, email = NULL, phone = NULL, parish = NULL, cover = NULL, cv_file = NULL, cv_name = NULL, ip = NULL, answers = '[]', token = NULL, screen_notes = NULL, anonymised_at = NOW() WHERE id = $1`, [r.id]);
      // Referees' details and the offer link go too; scores stay for the statistics.
      await query(`DELETE FROM hr_references WHERE application_id = $1`, [r.id]);
      await query(`UPDATE hr_offers SET token = NULL, response_name = NULL, response_ip = NULL WHERE application_id = $1`, [r.id]);
      await query(`UPDATE hr_interview_scores SET strengths = NULL, concerns = NULL, scores = (SELECT COALESCE(jsonb_agg(x - 'comment'), '[]'::jsonb) FROM jsonb_array_elements(scores) x) WHERE interview_id IN (SELECT id FROM hr_interviews WHERE application_id = $1)`, [r.id]);
      await query(`DELETE FROM application_notes WHERE application_id = $1`, [r.id]);
      await query(`INSERT INTO application_notes (application_id, kind, note, by_user) VALUES ($1, 'stage', $2, $3)`, [r.id, why || 'Details, CV and documents deleted', by || null]);
    }
    return rows.length;
  }
  const purge = setInterval(() => { anonymise('a.retain_until < CURRENT_DATE', [], null).then((n) => { if (n) console.log('[careers] removed', n, 'expired applications'); }).catch((e) => console.warn('[careers] purge', e.message)); }, 6 * 3600000);
  if (purge.unref) purge.unref();
}

module.exports = { register };
