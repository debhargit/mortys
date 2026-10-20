// =============================================================================
//  Vision Auto Solutions -- Careers and applicant tracking (Phase 8.5)
//
//  Mounted by server.js:  require('./careers').register(app, deps)
//  Public: /api/public/jobs (open posts), /api/public/jobs/:id/apply (form +
//  CV). Staff: /api/hr/* (cap hr.manage).
//
//  CVs: PDF or Word only, checked by their first bytes, 5 MB at most, saved
//  under data/careers-cvs (outside the website folder, so never served) with
//  a random name. Staff open them through /api/hr/applications/:id/cv, which
//  is logged on the application. Consent to keep the details is required and
//  recorded with its wording. After the retention period an applicant who was
//  not hired has the CV deleted and their details blanked; the job, dates and
//  stage stay for hiring statistics. A hire becomes a staff login (switched
//  off until a manager sets its role and password).
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STAGES = ['new', 'screen', 'interview', 'offer', 'hired', 'rejected'];
const CONSENT = 'I agree that Vision Auto Solutions may keep my application and CV to consider me for work, for up to 12 months, after which they are deleted. I can ask for them to be deleted sooner.';

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
  const t = (v, m) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, m));
  const ipOf = (req) => String(req.headers['cf-connecting-ip'] || (req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '').slice(0, 64);

  let upload = null;
  try {
    const multer = require('multer');
    upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 20 } });
  } catch (e) { console.warn('[careers] multer missing: applications without CV only'); }
  // What the file really is, from its first bytes (the name and type sent can lie).
  function sniff(buf) {
    if (!buf || buf.length < 8) return null;
    if (buf.slice(0, 5).toString('latin1') === '%PDF-') return '.pdf';
    if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return '.docx';
    if (buf.slice(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return '.doc';
    return null;
  }

  // ------------------------------------------------------------ public --
  app.get('/api/public/jobs', async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT id, title, department, location, kind, pay, summary, description, requirements, closes_on, created_at FROM job_posts
          WHERE is_open AND (closes_on IS NULL OR closes_on >= CURRENT_DATE) ORDER BY created_at DESC`);
      res.set('Cache-Control', 'no-store');
      res.json({ jobs: rows, consent: CONSENT });
    } catch (e) { fail(res, e); }
  });

  const RATE = new Map();
  const applyMw = upload ? (req, res, next) => upload.single('cv')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'The CV must be 5 MB or smaller' : 'Could not read the upload' });
    next();
  }) : (req, res, next) => next();
  app.post('/api/public/jobs/:id/apply', applyMw, async (req, res) => {
    try {
      const b = req.body || {};
      if (b.website) return res.json({ ok: true });   // honeypot: bots fill every field
      const ip = ipOf(req), r = RATE.get(ip) || { n: 0, first: Date.now() };
      if (Date.now() - r.first > 3600000) { r.n = 0; r.first = Date.now(); }
      if (r.n >= 5) throw httpError(429, 'Too many applications from this connection. Please try again later.');
      const { rows: job } = await query(`SELECT id, title FROM job_posts WHERE id = $1 AND is_open AND (closes_on IS NULL OR closes_on >= CURRENT_DATE)`, [parseInt(req.params.id, 10) || 0]);
      if (!job.length) throw httpError(404, 'This job is no longer open');
      const name = t(b.name, 120), email = t(b.email, 160), phone = t(b.phone, 40);
      if (!name || name.length < 3) throw httpError(400, 'Your full name');
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, 'A working email address');
      if (!phone || phone.replace(/\D/g, '').length < 7) throw httpError(400, 'A phone number');
      if (b.consent !== 'yes' && b.consent !== true && b.consent !== 'true' && b.consent !== 'on') throw httpError(400, 'Please tick the box to agree to us keeping your application');
      let cvFile = null, cvName = null;
      if (req.file) {
        const ext = sniff(req.file.buffer);
        if (!ext) throw httpError(400, 'The CV must be a PDF or a Word document');
        cvFile = crypto.randomBytes(16).toString('hex') + ext;
        fs.writeFileSync(path.join(DIR, cvFile), req.file.buffer, { flag: 'wx' });
        cvName = String(req.file.originalname || 'cv' + ext).replace(/[^\w.\- ]/g, '_').slice(0, 120);
      }
      const days = parseInt(await setting('careers_retention_days', '365'), 10) || 365;
      await query(
        `INSERT INTO job_applications (job_id, name, email, phone, parish, cover, cv_file, cv_name, consent_at, consent_text, ip, retain_until)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),$9,$10, CURRENT_DATE + $11::int)`,
        [job[0].id, name, email.toLowerCase(), phone, t(b.parish, 40), t(b.cover, 4000), cvFile, cvName, CONSENT, ip, days]);
      r.n++; RATE.set(ip, r);
      res.json({ ok: true, message: 'Thank you, ' + name.split(' ')[0] + '. We have your application for ' + job[0].title + ' and will be in touch if you are shortlisted.' });
    } catch (e) { fail(res, e); }
  });

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
    return j;
  }
  app.post('/api/hr/jobs', ...can('hr.manage'), async (req, res) => {
    try {
      const j = cleanJob(req.body || {});
      const { rows } = await query(
        `INSERT INTO job_posts (title, department, location, kind, pay, summary, description, requirements, is_open, closes_on, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [j.title, j.department, j.location, j.kind, j.pay, j.summary, j.description, j.requirements, j.is_open, j.closes_on, req.session.userId]);
      res.json({ job: rows[0] });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/hr/jobs/:id', ...can('hr.manage'), async (req, res) => {
    try {
      const j = cleanJob(req.body || {});
      const { rows } = await query(
        `UPDATE job_posts SET title=$2, department=$3, location=$4, kind=$5, pay=$6, summary=$7, description=$8, requirements=$9, is_open=$10, closes_on=$11 WHERE id = $1 RETURNING *`,
        [req.params.id, j.title, j.department, j.location, j.kind, j.pay, j.summary, j.description, j.requirements, j.is_open, j.closes_on]);
      if (!rows.length) throw httpError(404, 'Job not found');
      res.json({ job: rows[0] });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/hr/applications', ...can('hr.manage'), async (req, res) => {
    try {
      const job = parseInt(req.query.job, 10) || null;
      const { rows } = await query(
        `SELECT a.id, a.job_id, j.title AS job, a.name, a.email, a.phone, a.parish, a.stage, a.rating, a.interview_at, a.created_at, a.updated_at, (a.cv_file IS NOT NULL) AS has_cv,
                a.retain_until, a.hired_user_id, (SELECT COUNT(*) FROM application_notes n WHERE n.application_id = a.id AND n.kind = 'note')::int AS notes
           FROM job_applications a LEFT JOIN job_posts j ON j.id = a.job_id
          WHERE a.anonymised_at IS NULL AND ($1::int IS NULL OR a.job_id = $1) ORDER BY a.created_at DESC LIMIT 500`, [job]);
      res.json({ applications: rows, stages: STAGES });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/hr/applications/:id', ...can('hr.manage'), async (req, res) => {
    try {
      const { rows } = await query(`SELECT a.*, j.title AS job FROM job_applications a LEFT JOIN job_posts j ON j.id = a.job_id WHERE a.id = $1 AND a.anonymised_at IS NULL`, [req.params.id]);
      if (!rows.length) throw httpError(404, 'Application not found');
      const { rows: notes } = await query(`SELECT n.*, u.name AS by_name FROM application_notes n LEFT JOIN users u ON u.id = n.by_user WHERE n.application_id = $1 ORDER BY n.at DESC`, [req.params.id]);
      const a = rows[0]; delete a.cv_file; delete a.ip;
      res.json({ application: a, notes });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/hr/applications/:id/cv', ...can('hr.manage'), async (req, res) => {
    try {
      const { rows } = await query(`SELECT id, cv_file, cv_name FROM job_applications WHERE id = $1 AND anonymised_at IS NULL`, [req.params.id]);
      if (!rows.length || !rows[0].cv_file || !/^[0-9a-f]{32}\.(pdf|docx|doc)$/.test(rows[0].cv_file)) throw httpError(404, 'No CV');
      const file = path.join(DIR, rows[0].cv_file);
      if (!fs.existsSync(file)) throw httpError(404, 'The CV file is missing');
      await query(`INSERT INTO application_notes (application_id, kind, note, by_user) VALUES ($1, 'cv_viewed', 'CV opened', $2)`, [rows[0].id, req.session.userId]);
      const ext = path.extname(rows[0].cv_file);
      res.set('Content-Type', ext === '.pdf' ? 'application/pdf' : ext === '.docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/msword');
      res.set('Content-Disposition', `${ext === '.pdf' ? 'inline' : 'attachment'}; filename="${String(rows[0].cv_name || 'cv' + ext).replace(/"/g, '')}"`);
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Cache-Control', 'private, no-store');
      res.sendFile(file);
    } catch (e) { fail(res, e); }
  });
  app.patch('/api/hr/applications/:id', ...can('hr.manage'), async (req, res) => {
    try {
      const b = req.body || {};
      const { rows } = await query(`SELECT * FROM job_applications WHERE id = $1 AND anonymised_at IS NULL`, [req.params.id]);
      if (!rows.length) throw httpError(404, 'Application not found');
      const a = rows[0];
      if (b.stage !== undefined) {
        if (!STAGES.includes(b.stage) || b.stage === 'hired') throw httpError(400, b.stage === 'hired' ? 'Use Hire, which also makes their staff login' : 'Unknown stage');
        if (a.stage === 'hired') throw httpError(409, 'Already hired');
        await query(`UPDATE job_applications SET stage = $2, updated_at = NOW() WHERE id = $1`, [a.id, b.stage]);
        await query(`INSERT INTO application_notes (application_id, kind, note, by_user) VALUES ($1, 'stage', $2, $3)`, [a.id, a.stage + ' → ' + b.stage, req.session.userId]);
      }
      if (b.rating !== undefined) { const r = parseInt(b.rating, 10); await query(`UPDATE job_applications SET rating = $2, updated_at = NOW() WHERE id = $1`, [a.id, r >= 1 && r <= 5 ? r : null]); }
      if (b.interview_at !== undefined) await query(`UPDATE job_applications SET interview_at = $2, updated_at = NOW() WHERE id = $1`, [a.id, b.interview_at ? new Date(b.interview_at) : null]);
      if (t(b.note, 2000)) await query(`INSERT INTO application_notes (application_id, kind, note, by_user) VALUES ($1, 'note', $2, $3)`, [a.id, t(b.note, 2000), req.session.userId]);
      res.json({ ok: true });
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
          [a.email.toLowerCase(), a.name, a.phone, await bcrypt.hash(crypto.randomBytes(24).toString('base64url'), 10), 'Hired from application #' + a.id + (a.title ? ' (' + a.title + ')' : '')]);
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

  async function anonymise(where, vals, by) {
    const { rows } = await query(`SELECT a.id, a.cv_file FROM job_applications a WHERE a.anonymised_at IS NULL AND a.stage <> 'hired' AND ${where}`, vals);
    for (const r of rows) {
      if (r.cv_file && /^[0-9a-f]{32}\.(pdf|docx|doc)$/.test(r.cv_file)) { try { fs.unlinkSync(path.join(DIR, r.cv_file)); } catch (_) {} }
      await query(`UPDATE job_applications SET name = NULL, email = NULL, phone = NULL, parish = NULL, cover = NULL, cv_file = NULL, cv_name = NULL, ip = NULL, anonymised_at = NOW() WHERE id = $1`, [r.id]);
      await query(`DELETE FROM application_notes WHERE application_id = $1`, [r.id]);
      await query(`INSERT INTO application_notes (application_id, kind, note, by_user) VALUES ($1, 'stage', 'Details and CV deleted', $2)`, [r.id, by || null]);
    }
    return rows.length;
  }
  const purge = setInterval(() => { anonymise('a.retain_until < CURRENT_DATE', [], null).then((n) => { if (n) console.log('[careers] removed', n, 'expired applications'); }).catch((e) => console.warn('[careers] purge', e.message)); }, 6 * 3600000);
  if (purge.unref) purge.unref();
}

module.exports = { register };
