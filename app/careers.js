// =============================================================================
//  Vision Auto Solutions -- Careers and applicant tracking (Phase 8.5)
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
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mailer = require('./mailer');

const STAGES = ['new', 'screen', 'interview', 'offer', 'hired', 'rejected'];
const CONSENT = 'I agree that Vision Auto Solutions may keep my application, CV and documents to consider me for work, for up to 12 months, after which they are deleted. I can ask for them to be deleted sooner.';
// What the applicant sees on their status page for each stage. Internal
// stages (screening) are not spelled out to them.
const PUBLIC_STAGE = { new: 'Received: being reviewed', screen: 'Received: being reviewed', interview: 'Interview stage', offer: 'Offer stage', hired: 'Hired', rejected: 'Closed: not taken forward this time' };
const FILE_RE = /^[0-9a-f]{32}\.(pdf|docx|doc|jpg|png)$/;
const TYPES = { '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.doc': 'application/msword', '.jpg': 'image/jpeg', '.png': 'image/png' };

// Email templates. {first} {name} {job} {ref} {link} {missing} {interview}
// are filled in; the hiring screen edits these (careers_templates setting).
const TEMPLATES = {
  ack: {
    label: 'Automatic reply when someone applies',
    subject: 'We received your application for {job} ({ref})',
    body: 'Hi {first},\n\nThank you for applying for {job} at Vision Auto Solutions. Your reference is {ref}.\n\n{missing}\n\nYou can see where your application is, add documents, or withdraw it here:\n{link}\n\nWe read every application. If you are shortlisted we will contact you by phone or email.\n\nVision Auto Solutions\n112C Waltham Park Road, Kingston · +1 876-728-4735',
  },
  docs: {
    label: 'Documents needed',
    subject: 'Documents needed for your application ({ref})',
    body: 'Hi {first},\n\nThank you for your application for {job}. To move it forward we need:\n\n{missing}\n\nPlease upload them here:\n{link}\n\nVision Auto Solutions',
  },
  interview: {
    label: 'Interview invitation',
    subject: 'Interview for {job} ({ref})',
    body: 'Hi {first},\n\nWe would like to meet you about the {job} position{interview}.\n\nPlease reply to this email or call +1 876-728-4735 to confirm, and bring a photo ID and any certificates you mentioned.\n\nVision Auto Solutions\n112C Waltham Park Road, Kingston',
  },
  offer: {
    label: 'Offer',
    subject: 'Job offer: {job}',
    body: 'Hi {first},\n\nWe are pleased to offer you the {job} position at Vision Auto Solutions. We will call you to go through the details, start date and pay.\n\nPlease reply to this email to let us know you have received it.\n\nVision Auto Solutions',
  },
  rejected: {
    label: 'Not taken forward',
    subject: 'Your application for {job}',
    body: 'Hi {first},\n\nThank you for your interest in the {job} position and for the time you put into your application. We have decided not to take your application forward this time.\n\nWe keep applications on file for 12 months and may contact you if a suitable position opens.\n\nVision Auto Solutions',
  },
};

function register(app, deps) {
  const { query, requireAdmin, requireCap, bcrypt } = deps;
  const can = (k) => [requireAdmin, requireCap(k)];
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
  function fill(text, v) { return String(text).replace(/\{(first|name|job|ref|link|missing|interview)\}/g, (m, k) => (v[k] == null ? '' : v[k])); }
  const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Plain text in, a simple branded HTML version alongside; links clickable.
  function asHtml(text) {
    const body = escHtml(text).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#d62828">$1</a>').replace(/\n/g, '<br>');
    return '<!doctype html><html><body style="margin:0;padding:24px 0;background:#f6f7f9;font-family:Arial,sans-serif;color:#0f1720">' +
      '<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden"><div style="background:#d62828;color:#fff;padding:16px 22px;font-size:18px;font-weight:800">Vision Auto Solutions · Careers</div>' +
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
    return {
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
    return j;
  }
  const JOB_COLS = ['title', 'department', 'location', 'kind', 'pay', 'summary', 'description', 'requirements', 'is_open', 'closes_on', 'openings', 'documents', 'questions', 'cv_required'];
  const jobVals = (j) => JOB_COLS.map((c) => j[c]);
  app.post('/api/hr/jobs', ...can('hr.manage'), async (req, res) => {
    try {
      const j = cleanJob(req.body || {});
      const { rows } = await query(
        `INSERT INTO job_posts (${JOB_COLS.join(', ')}, created_by) VALUES (${JOB_COLS.map((c, i) => '$' + (i + 1) + (c === 'documents' || c === 'questions' ? '::jsonb' : '')).join(',')}, $${JOB_COLS.length + 1}) RETURNING *`,
        jobVals(j).concat([req.session.userId]));
      res.json({ job: rows[0] });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/hr/jobs/:id', ...can('hr.manage'), async (req, res) => {
    try {
      const j = cleanJob(req.body || {});
      const { rows } = await query(
        `UPDATE job_posts SET ${JOB_COLS.map((c, i) => c + ' = $' + (i + 2) + (c === 'documents' || c === 'questions' ? '::jsonb' : '')).join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING *`,
        [req.params.id].concat(jobVals(j)));
      if (!rows.length) throw httpError(404, 'Job not found');
      res.json({ job: rows[0] });
    } catch (e) { fail(res, e); }
  });
  // Open or close a posting without opening the form.
  app.patch('/api/hr/jobs/:id', ...can('hr.manage'), async (req, res) => {
    try {
      const { rows } = await query('UPDATE job_posts SET is_open = $2, updated_at = NOW() WHERE id = $1 RETURNING id, is_open', [req.params.id, !!(req.body || {}).is_open]);
      if (!rows.length) throw httpError(404, 'Job not found');
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
  app.get('/api/hr/applications/:id', ...can('hr.manage'), async (req, res) => {
    try {
      const { rows } = await query(`SELECT a.*, j.title AS job, j.documents AS job_documents FROM job_applications a LEFT JOIN job_posts j ON j.id = a.job_id WHERE a.id = $1 AND a.anonymised_at IS NULL`, [req.params.id]);
      if (!rows.length) throw httpError(404, 'Application not found');
      const { rows: notes } = await query(`SELECT n.*, u.name AS by_name FROM application_notes n LEFT JOIN users u ON u.id = n.by_user WHERE n.application_id = $1 ORDER BY n.at DESC`, [req.params.id]);
      const { rows: docs } = await query(`SELECT id, doc_key, label, orig_name, bytes, via, uploaded_at FROM application_documents WHERE application_id = $1 ORDER BY uploaded_at`, [req.params.id]);
      const a = rows[0];
      const missing = await missingDocs(a.id, { documents: a.job_documents });
      delete a.cv_file; delete a.ip; delete a.token;
      res.json({ application: a, notes, documents: docs, missing: missing.map((d) => d.label) });
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
  app.get('/api/hr/applications/:id/cv', ...can('hr.manage'), async (req, res) => {
    try {
      const { rows } = await query(`SELECT id, cv_file, cv_name FROM job_applications WHERE id = $1 AND anonymised_at IS NULL`, [req.params.id]);
      if (!rows.length || !rows[0].cv_file || !FILE_RE.test(rows[0].cv_file)) throw httpError(404, 'No CV');
      await query(`INSERT INTO application_notes (application_id, kind, note, by_user) VALUES ($1, 'cv_viewed', 'CV opened', $2)`, [rows[0].id, req.session.userId]);
      sendStored(res, rows[0].cv_file, rows[0].cv_name);
    } catch (e) { fail(res, e); }
  });
  app.get('/api/hr/applications/:id/documents/:docId', ...can('hr.manage'), async (req, res) => {
    try {
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
      res.json({ to: a.email, subject: tpl ? fill(tpl.subject, v) : 'Your application for ' + v.job + ' (' + v.ref + ')', body: tpl ? fill(tpl.body, v) : 'Hi ' + v.first + ',\n\n\n\nVision Auto Solutions', mail_on: mailer.isActive() });
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
      if (b.stage !== undefined && b.stage !== a.stage) {
        if (!STAGES.includes(b.stage) || b.stage === 'hired') throw httpError(400, b.stage === 'hired' ? 'Use Hire, which also makes their staff login' : 'Unknown stage');
        if (a.stage === 'hired') throw httpError(409, 'Already hired');
        await query(`UPDATE job_applications SET stage = $2, updated_at = NOW() WHERE id = $1`, [a.id, b.stage]);
        await query(`INSERT INTO application_notes (application_id, kind, note, by_user) VALUES ($1, 'stage', $2, $3)`, [a.id, a.stage + ' → ' + b.stage, req.session.userId]);
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
      const { rows: ex } = await query(`SELECT id, is_staff FROM users WHERE lower(email) = lower($1)`, [a.email]);
      let uid;
      if (ex.length) {
        uid = ex[0].id;
        await query(`UPDATE users SET is_staff = true, name = COALESCE(name, $2), phone = COALESCE(phone, $3) WHERE id = $1`, [uid, a.name, a.phone]);
      } else {
        const { rows: u } = await query(
          `INSERT INTO users (email, name, phone, password_hash, via, is_admin, is_staff, admin_role, disabled, internal_notes) VALUES ($1,$2,$3,$4,'hire',false,true,'cashier',true,$5) RETURNING id`,
          [a.email.toLowerCase(), a.name, a.phone, await bcrypt.hash(crypto.randomBytes(24).toString('base64url'), 10), 'Hired from application ' + (a.ref || '#' + a.id) + (a.title ? ' (' + a.title + ')' : '')]);
        uid = u[0].id;
      }
      // Hired: kept with the staff file, not purged with applicants.
      await query(`UPDATE job_applications SET stage = 'hired', hired_user_id = $2, retain_until = CURRENT_DATE + 3650, updated_at = NOW() WHERE id = $1`, [a.id, uid]);
      await query(`INSERT INTO application_notes (application_id, kind, note, by_user) VALUES ($1, 'stage', $2, $3)`, [a.id, a.stage + ' → hired (staff login #' + uid + ', switched off until set up)', req.session.userId]);
      res.json({ ok: true, user_id: uid, existed: ex.length > 0, next: 'On the Staff screen: give them a role, a password or PIN, and switch the account on.' });
    } catch (e) { fail(res, e); }
  });
  // Deleted at the applicant's request (or by the manager) before the retention date.
  app.delete('/api/hr/applications/:id', ...can('hr.manage'), async (req, res) => {
    try { const n = await anonymise('a.id = $1', [parseInt(req.params.id, 10) || 0], req.session.userId); if (!n) throw httpError(404, 'Application not found'); res.json({ ok: true }); } catch (e) { fail(res, e); }
  });

  // Hiring settings: the email templates, the inbox told about new
  // applications, and how long applicants who are not hired are kept.
  app.get('/api/hr/settings', ...can('hr.manage'), async (req, res) => {
    try {
      res.json({
        templates: await templates(), defaults: TEMPLATES,
        notify_email: await setting('careers_notify_email', ''),
        retention_days: parseInt(await setting('careers_retention_days', '365'), 10) || 365,
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
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  async function anonymise(where, vals, by, why) {
    const { rows } = await query(`SELECT a.id, a.cv_file FROM job_applications a WHERE a.anonymised_at IS NULL AND a.stage <> 'hired' AND ${where}`, vals);
    for (const r of rows) {
      removeFile(r.cv_file);
      const { rows: docs } = await query('DELETE FROM application_documents WHERE application_id = $1 RETURNING file', [r.id]);
      docs.forEach((d) => removeFile(d.file));
      await query(`UPDATE job_applications SET name = NULL, email = NULL, phone = NULL, parish = NULL, cover = NULL, cv_file = NULL, cv_name = NULL, ip = NULL, answers = '[]', token = NULL, anonymised_at = NOW() WHERE id = $1`, [r.id]);
      await query(`DELETE FROM application_notes WHERE application_id = $1`, [r.id]);
      await query(`INSERT INTO application_notes (application_id, kind, note, by_user) VALUES ($1, 'stage', $2, $3)`, [r.id, why || 'Details, CV and documents deleted', by || null]);
    }
    return rows.length;
  }
  const purge = setInterval(() => { anonymise('a.retain_until < CURRENT_DATE', [], null).then((n) => { if (n) console.log('[careers] removed', n, 'expired applications'); }).catch((e) => console.warn('[careers] purge', e.message)); }, 6 * 3600000);
  if (purge.unref) purge.unref();
}

module.exports = { register };
