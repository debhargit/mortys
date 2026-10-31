'use strict';
// =============================================================================
//  Vision Auto Solutions -- staff training (Phase 10c)
//
//  Modules: a lesson, a quiz with a pass mark, and how long a pass lasts.
//  Quizzes are graded here; the right answers never reach the browser (the
//  order of questions and choices is shuffled per attempt and the key kept on
//  the server). Practice orders run on a sandbox till: the trainee builds the
//  order and takes payment, it is priced by the real till code as a dry run
//  (nothing is saved, no stock moves), and the result is checked.
//  Managers see who is certified, and edit lessons and questions.
//  Each employee's record: lessons opened, every quiz attempt, the practice
//  till, training done elsewhere (courses, certificates and licences, with the
//  file and expiry), training assigned with a due date; all searchable.
// =============================================================================
const crypto = require('crypto');

function register(app, deps) {
  const { query, requireAdmin, requireCap, userCan, posSaleHandler } = deps;
  const can = (k) => [requireAdmin, requireCap(k)];
  const n = (v) => (v == null || v === '' ? 0 : Number(v));
  const r2 = (v) => Math.round(n(v) * 100) / 100;
  function httpError(status, msg) { const e = new Error(msg); e.status = status; e.publicMessage = msg; return e; }
  function fail(res, e) { const s = e.status || 500; if (s >= 500) console.error('[training]', e); res.status(s).json({ error: e.publicMessage || e.message }); }
  let notice = null;   // team.js notice(), for assigned training and reminders
  const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };

  require('./training-seed').seed(query).then((k) => { if (k) console.log('[training] added or updated ' + k + ' lesson(s)'); }).catch((e) => console.warn('[training] seed', e.message));

  async function me(req) {
    const { rows } = await query(`SELECT id, name, admin_role FROM users WHERE id = $1`, [req.session.userId]);
    return rows[0];
  }
  const applies = (m, role) => !m.roles || !m.roles.length || m.roles.includes(role);

  // Status of every module for one person.
  async function statusFor(uid, role) {
    const { rows: mods } = await query(`SELECT id, key, title, summary, sort, pass_pct, valid_months, quiz, practice, roles,
                                          (SELECT COUNT(*)::int FROM training_questions q WHERE q.module_id = m.id AND q.active) AS questions
                                          FROM training_modules m WHERE active ORDER BY sort, id`);
    const { rows: best } = await query(
      `SELECT DISTINCT ON (module_id) module_id, finished_at, score_pct::float AS score FROM training_attempts
        WHERE user_id = $1 AND passed ORDER BY module_id, finished_at DESC`, [uid]);
    const { rows: last } = await query(
      `SELECT DISTINCT ON (module_id) module_id, finished_at, score_pct::float AS score, passed FROM training_attempts
        WHERE user_id = $1 AND finished_at IS NOT NULL ORDER BY module_id, finished_at DESC`, [uid]);
    const { rows: prac } = await query(`SELECT COUNT(*) FILTER (WHERE passed)::int AS passed FROM training_practice WHERE user_id = $1`, [uid]);
    return mods.map((m) => {
      const b = best.find((x) => x.module_id === m.id), l = last.find((x) => x.module_id === m.id);
      let status = m.quiz ? 'not started' : 'reference', expires = null;
      if (b) {
        expires = new Date(new Date(b.finished_at).getTime() + m.valid_months * 30.44 * 86400000);
        status = expires < new Date() ? 'expired' : 'passed';
      } else if (l) status = 'not passed';
      return { key: m.key, title: m.title, summary: m.summary, quiz: m.quiz, practice: m.practice, questions: m.questions, pass_pct: m.pass_pct,
        for_me: applies(m, role), required: m.quiz && applies(m, role), status, passed_at: b ? b.finished_at : null, expires, best: b ? b.score : null,
        last: l ? { score: l.score, passed: l.passed, at: l.finished_at } : null, practice_passed: m.practice ? prac[0].passed : undefined };
    });
  }

  app.get('/api/training/me', requireAdmin, async (req, res) => {
    try {
      const u = await me(req), manage = await userCan(req, 'training.manage');
      const mods = await statusFor(u.id, u.admin_role);
      res.json({ name: u.name, modules: mods.filter((m) => m.for_me || manage), can_manage: manage });
    } catch (e) { fail(res, e); }
  });
  // The whole manual: every lesson for this person's role (managers: every
  // lesson), in order, for reading straight through or printing.
  app.get('/api/training/manual', requireAdmin, async (req, res) => {
    try {
      const u = await me(req), manage = await userCan(req, 'training.manage');
      const { rows } = await query(`SELECT key, title, summary, body, roles FROM training_modules WHERE active ORDER BY sort, id`);
      res.json({ name: u.name, lessons: rows.filter((m) => manage || applies(m, u.admin_role)).map((m) => ({ key: m.key, title: m.title, summary: m.summary, body: m.body, roles: m.roles })) });
    } catch (e) { fail(res, e); }
  });
  // A lesson this person may open: active, and for their role (managers: any).
  async function lessonFor(req, key) {
    const u = await me(req);
    const { rows } = await query(`SELECT id, key, title, summary, body, pass_pct, valid_months, quiz, practice, roles FROM training_modules WHERE key = $1 AND active`, [String(key)]);
    if (!rows.length) throw httpError(404, 'Module not found');
    if (!applies(rows[0], u.admin_role) && !(await userCan(req, 'training.manage'))) throw httpError(403, 'This module is not for your role');
    return Object.assign(rows[0], { user: u });
  }
  // Reading a lesson aloud (voice.js): Gemini or Google voices, or the browser's.
  require('./voice').register(app, { requireAdmin, lessonFor, fail });
  app.get('/api/training/modules/:key', requireAdmin, async (req, res) => {
    try {
      const m = await lessonFor(req, req.params.key), u = m.user, rows = [m];
      delete m.user;
      const { rows: c } = await query(`SELECT COUNT(*)::int AS n FROM training_questions WHERE module_id = $1 AND active`, [rows[0].id]);
      // Opening a lesson is recorded (first time, last time, how often).
      await query(`INSERT INTO training_views (user_id, module_id) VALUES ($1, $2) ON CONFLICT (user_id, module_id) DO UPDATE SET last_at = NOW(), views = training_views.views + 1`, [u.id, rows[0].id]);
      res.json(Object.assign({}, rows[0], { id: undefined, questions: c[0].n }));
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------------- quiz --
  app.post('/api/training/modules/:key/quiz', requireAdmin, async (req, res) => {
    try {
      const u = await me(req);
      const { rows } = await query(`SELECT id, title, pass_pct, quiz, roles FROM training_modules WHERE key = $1 AND active`, [String(req.params.key)]);
      if (!rows.length || !rows[0].quiz) throw httpError(404, 'No quiz for this module');
      if (!applies(rows[0], u.admin_role) && !(await userCan(req, 'training.manage'))) throw httpError(403, 'This module is not for your role');
      const { rows: recent } = await query(`SELECT COUNT(*)::int AS n FROM training_attempts WHERE user_id = $1 AND started_at > NOW() - INTERVAL '10 minutes'`, [u.id]);
      if (recent[0].n >= 10) throw httpError(429, 'Too many attempts. Read the lesson again and try later.');
      const { rows: qs } = await query(`SELECT id, question, choices, answer FROM training_questions WHERE module_id = $1 AND active`, [rows[0].id]);
      if (!qs.length) throw httpError(409, 'This quiz has no questions yet');
      const picked = shuffle(qs).slice(0, 12);
      const keyMap = {}, shown = [];
      for (const q of picked) {
        const order = shuffle(q.choices.map((c, i) => i));
        keyMap[q.id] = order.indexOf(q.answer);
        shown.push({ id: q.id, question: q.question, choices: order.map((i) => q.choices[i]) });
      }
      const { rows: a } = await query(`INSERT INTO training_attempts (user_id, module_id, key_map) VALUES ($1,$2,$3) RETURNING id`, [u.id, rows[0].id, JSON.stringify(keyMap)]);
      res.json({ attempt: Number(a[0].id), title: rows[0].title, pass_pct: rows[0].pass_pct, questions: shown });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/training/attempts/:id', requireAdmin, async (req, res) => {
    try {
      const { rows } = await query(`SELECT a.*, m.pass_pct FROM training_attempts a JOIN training_modules m ON m.id = a.module_id WHERE a.id = $1 AND a.user_id = $2`, [parseInt(req.params.id, 10), req.session.userId]);
      if (!rows.length) throw httpError(404, 'Attempt not found');
      const a = rows[0];
      if (a.finished_at) throw httpError(409, 'Already marked');
      if (Date.now() - new Date(a.started_at).getTime() > 2 * 3600000) throw httpError(410, 'This attempt has expired; start the quiz again');
      const answers = (req.body && req.body.answers) || {};
      const ids = Object.keys(a.key_map);
      const { rows: qs } = await query(`SELECT id, question, explain FROM training_questions WHERE id = ANY($1)`, [ids.map(Number)]);
      let right = 0;
      const wrong = [];
      for (const id of ids) {
        const given = answers[id] == null ? null : parseInt(answers[id], 10);
        if (given === a.key_map[id]) right++;
        else { const q = qs.find((x) => String(x.id) === id); wrong.push({ question: q && q.question, explain: q && q.explain }); }
      }
      const pct = Math.round((right / ids.length) * 1000) / 10, passed = pct >= a.pass_pct;
      await query(`UPDATE training_attempts SET score_pct = $2, passed = $3, answers = $4, finished_at = NOW() WHERE id = $1`, [a.id, pct, passed, JSON.stringify(answers)]);
      res.json({ score: pct, passed, right, total: ids.length, pass_pct: a.pass_pct, review: wrong });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------ practice till --
  function runSale(req, body) {
    const sreq = Object.create(req);
    sreq.body = body;
    return new Promise((resolve) => {
      const fake = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(d) { resolve({ status: this.statusCode, body: d }); return this; },
        send(d) { resolve({ status: this.statusCode, body: d }); return this; }, set() { return this; }, setHeader() { return this; } };
      Promise.resolve(posSaleHandler(sreq, fake)).catch((e) => resolve({ status: 500, body: { error: e.message } }));
    });
  }
  // Always a dry run: priced by the real till code, nothing saved, no stock moved.
  async function price(req, items) {
    const lines = [];
    for (const i of items) {
      const { rows } = await query(`SELECT img, name, price_usd::float AS price FROM products WHERE img = $1 AND is_active`, [i.img]);
      if (!rows.length) throw httpError(400, 'Part ' + i.img + ' not found');
      lines.push({ product_img: rows[0].img, description: rows[0].name, qty: i.qty, unit_price_usd: rows[0].price, discount_usd: 0 });
    }
    const dry = await runSale(req, { items: lines, dry_run: true, payments: [{ method: 'cash', amount_usd: null }] });
    if (dry.status !== 200 || !dry.body || !dry.body.ok || dry.body.dry_run !== true) throw httpError(400, 'The practice till could not price this: ' + ((dry.body && dry.body.error) || 'unknown'));
    return r2(dry.body.total_usd);
  }
  app.post('/api/training/practice/new', requireAdmin, async (req, res) => {
    try {
      const { rows: open } = await query(`SELECT COUNT(*)::int AS n FROM training_practice WHERE user_id = $1 AND created_at > NOW() - INTERVAL '10 minutes'`, [req.session.userId]);
      if (open[0].n >= 15) throw httpError(429, 'Take a break - try again in a few minutes.');
      const { rows: ps } = await query(
        `SELECT img, name, make_model, price_usd::float AS price FROM products
          WHERE is_active AND stock_count >= 3 AND price_usd BETWEEN 300 AND 15000 AND variant_of IS NULL
          ORDER BY random() LIMIT 3`);
      if (!ps.length) throw httpError(409, 'No parts to practise with');
      const k = 1 + crypto.randomInt(Math.min(3, ps.length));
      const items = ps.slice(0, k).map((p) => ({ img: p.img, name: p.name, fits: p.make_model, qty: 1 + crypto.randomInt(3) }));
      const total = await price(req, items);
      const mode = crypto.randomInt(3) === 0 ? 'split' : 'cash';
      let pay;
      if (mode === 'cash') {
        const step = total > 5000 ? 5000 : 1000;
        pay = { mode, cash_given: Math.ceil((total + 1) / step) * step };
      } else {
        const card = Math.max(500, Math.floor((total * 0.6) / 500) * 500);
        pay = { mode, card, cash_given: Math.ceil((r2(total - card) + 1) / 1000) * 1000 };
      }
      const task = { items, pay, total };
      const { rows } = await query(`INSERT INTO training_practice (user_id, task) VALUES ($1,$2) RETURNING id`, [req.session.userId, JSON.stringify(task)]);
      const words = items.map((i) => i.qty + ' x ' + i.name + ' (part ' + i.img + ')').join(', ');
      const how = mode === 'cash' ? 'They pay cash and hand you J$' + pay.cash_given.toLocaleString() + '.'
        : 'They pay J$' + pay.card.toLocaleString() + ' by card and the rest in cash, handing you J$' + pay.cash_given.toLocaleString() + ' for the cash part.';
      res.json({ id: Number(rows[0].id), customer: 'A walk-in customer wants ' + words + '. ' + how, pay: { mode, card: pay.card || null, cash_given: pay.cash_given } });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/training/practice/:id', requireAdmin, async (req, res) => {
    try {
      const { rows } = await query(`SELECT * FROM training_practice WHERE id = $1 AND user_id = $2`, [parseInt(req.params.id, 10), req.session.userId]);
      if (!rows.length) throw httpError(404, 'Practice order not found');
      const p = rows[0], t = p.task;
      if (p.done_at) throw httpError(409, 'Already checked - start a new one');
      const b = req.body || {};
      const items = (Array.isArray(b.items) ? b.items : []).map((i) => ({ img: String(i.img || '').trim(), qty: parseInt(i.qty, 10) || 0 })).filter((i) => i.img && i.qty > 0).slice(0, 30);
      const notes = [];
      // The right parts and quantities.
      const want = Object.fromEntries(t.items.map((i) => [i.img, i.qty]));
      const got = {};
      for (const i of items) got[i.img] = (got[i.img] || 0) + i.qty;
      for (const [img, q] of Object.entries(want)) if (got[img] !== q) notes.push(got[img] ? 'Wrong quantity of ' + img + ': ' + got[img] + ' instead of ' + q : 'Missing ' + img);
      for (const img of Object.keys(got)) if (!want[img]) notes.push('Not asked for: ' + img);
      // The total the real till works out for what was rung up.
      let total = null;
      if (items.length) { try { total = await price(req, items); } catch (e) { notes.push(e.publicMessage || e.message); } }
      // Payment and change.
      const pays = (Array.isArray(b.payments) ? b.payments : []).map((x) => ({ method: String(x.method || ''), amount: r2(x.amount) }));
      const cash = pays.filter((x) => x.method === 'cash').reduce((s, x) => s + x.amount, 0), card = pays.filter((x) => x.method === 'card').reduce((s, x) => s + x.amount, 0);
      const money = (v) => 'J$' + Number(v).toLocaleString('en-JM', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      if (t.pay.mode === 'split' && Math.abs(card - t.pay.card) > 0.01) notes.push('Card should be ' + money(t.pay.card) + ' (you entered ' + money(card) + ')');
      if (t.pay.mode === 'cash' && card > 0) notes.push('This customer paid only cash');
      if (Math.abs(cash - t.pay.cash_given) > 0.01) notes.push('Cash handed over was ' + money(t.pay.cash_given) + ' (you entered ' + money(cash) + ')');
      const rightChange = r2(t.pay.cash_given - r2(t.total - (t.pay.mode === 'split' ? t.pay.card : 0)));
      if (Math.abs(r2(b.change) - rightChange) > 0.01) notes.push('Change should be ' + money(rightChange) + ' (you gave ' + money(r2(b.change)) + ')');
      const passed = !notes.length;
      const result = { passed, notes, total: t.total, change: rightChange, your_total: total };
      await query(`UPDATE training_practice SET done_at = NOW(), passed = $2, result = $3 WHERE id = $1`, [p.id, passed, JSON.stringify(result)]);
      res.json(result);
    } catch (e) { fail(res, e); }
  });
  // Parts for the practice till's search (names and prices only).
  app.get('/api/training/practice/parts', requireAdmin, async (req, res) => {
    try {
      const q = String(req.query.q || '').trim().slice(0, 40);
      if (q.length < 2) return res.json({ parts: [] });
      const { rows } = await query(`SELECT img, name, make_model, price_usd::float AS price FROM products WHERE is_active AND price_usd > 0 AND (img ILIKE $1 || '%' OR name ILIKE '%' || $1 || '%') ORDER BY img = $1 DESC, name LIMIT 15`, [q]);
      res.json({ parts: rows });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------------ manager --
  const M = can('training.manage');
  app.get('/api/training/team', ...M, async (req, res) => {
    try {
      const { rows: staff } = await query(`SELECT id, name, admin_role FROM users WHERE is_staff AND NOT disabled AND admin_role <> 'rep' ORDER BY name`);
      const out = [];
      for (const s of staff) out.push({ id: s.id, name: s.name, role: s.admin_role, modules: (await statusFor(s.id, s.admin_role)).filter((m) => m.quiz).map((m) => ({ key: m.key, required: m.required, status: m.status, best: m.best, expires: m.expires })) });
      const { rows: mods } = await query(`SELECT key, title FROM training_modules WHERE active AND quiz ORDER BY sort, id`);
      res.json({ modules: mods, staff: out });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/training/admin/modules', ...M, async (req, res) => {
    try {
      const { rows } = await query(`SELECT m.*, COALESCE((SELECT json_agg(json_build_object('id', q.id, 'question', q.question, 'choices', q.choices, 'answer', q.answer, 'explain', q.explain, 'active', q.active) ORDER BY q.sort, q.id) FROM training_questions q WHERE q.module_id = m.id), '[]') AS qs FROM training_modules m ORDER BY m.sort, m.id`);
      res.json({ modules: rows });
    } catch (e) { fail(res, e); }
  });
  function cleanModule(b) {
    const out = {};
    if (b.title !== undefined) { out.title = String(b.title).trim().slice(0, 120); if (!out.title) throw httpError(400, 'Title'); }
    if (b.summary !== undefined) out.summary = String(b.summary || '').slice(0, 300) || null;
    if (b.body !== undefined) out.body = String(b.body || '').slice(0, 30000);
    if (b.pass_pct !== undefined) { out.pass_pct = parseInt(b.pass_pct, 10); if (!(out.pass_pct >= 50 && out.pass_pct <= 100)) throw httpError(400, 'Pass mark 50 to 100%'); }
    if (b.valid_months !== undefined) { out.valid_months = parseInt(b.valid_months, 10); if (!(out.valid_months >= 1 && out.valid_months <= 60)) throw httpError(400, 'Valid for 1 to 60 months'); }
    if (b.active !== undefined) out.active = !!b.active;
    if (b.quiz !== undefined) out.quiz = !!b.quiz;
    if (b.sort !== undefined) out.sort = parseInt(b.sort, 10) || 100;
    if (b.roles !== undefined) out.roles = Array.isArray(b.roles) && b.roles.length ? b.roles.map(String).filter((r) => /^[a-z_]{2,30}$/.test(r)) : null;
    return out;
  }
  app.post('/api/training/admin/modules', ...M, async (req, res) => {
    try {
      const b = req.body || {};
      const key = String(b.key || '').trim().toLowerCase();
      if (!/^[a-z0-9-]{2,40}$/.test(key)) throw httpError(400, 'Key: letters, numbers and dashes');
      const m = cleanModule(Object.assign({ title: b.title || key }, b));
      const { rows } = await query(`INSERT INTO training_modules (key, title, summary, body, updated_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [key, m.title, m.summary || null, m.body || '', req.session.userId]);
      res.json({ ok: true, id: rows[0].id });
    } catch (e) { if (e.code === '23505') e = httpError(409, 'That key is taken'); fail(res, e); }
  });
  app.put('/api/training/admin/modules/:id', ...M, async (req, res) => {
    try {
      const m = cleanModule(req.body || {});
      const keys = Object.keys(m);
      if (!keys.length) throw httpError(400, 'Nothing to change');
      const vals = [parseInt(req.params.id, 10), req.session.userId].concat(keys.map((k) => m[k]));
      const { rowCount } = await query(`UPDATE training_modules SET ${keys.map((k, i) => k + ' = $' + (i + 3)).join(', ')}, updated_by = $2, updated_at = NOW() WHERE id = $1`, vals);
      if (!rowCount) throw httpError(404, 'Module not found');
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  function cleanQuestion(b) {
    const question = String(b.question || '').trim().slice(0, 500);
    const choices = (Array.isArray(b.choices) ? b.choices : []).map((c) => String(c).trim().slice(0, 200)).filter(Boolean);
    const answer = parseInt(b.answer, 10);
    if (!question) throw httpError(400, 'Write the question');
    if (choices.length < 2 || choices.length > 6) throw httpError(400, 'Two to six answers');
    if (!(answer >= 0 && answer < choices.length)) throw httpError(400, 'Mark the right answer');
    return { question, choices, answer, explain: String(b.explain || '').slice(0, 400) || null, active: b.active !== false };
  }
  app.post('/api/training/admin/modules/:id/questions', ...M, async (req, res) => {
    try {
      const q = cleanQuestion(req.body || {});
      const { rows } = await query(`INSERT INTO training_questions (module_id, question, choices, answer, explain, active, sort) VALUES ($1,$2,$3,$4,$5,$6, COALESCE((SELECT MAX(sort) + 10 FROM training_questions WHERE module_id = $1), 10)) RETURNING id`,
        [parseInt(req.params.id, 10), q.question, JSON.stringify(q.choices), q.answer, q.explain, q.active]);
      res.json({ ok: true, id: rows[0].id });
    } catch (e) { if (e.code === '23503') e = httpError(404, 'Module not found'); fail(res, e); }
  });
  app.put('/api/training/admin/questions/:id', ...M, async (req, res) => {
    try {
      const q = cleanQuestion(req.body || {});
      const { rowCount } = await query(`UPDATE training_questions SET question = $2, choices = $3, answer = $4, explain = $5, active = $6 WHERE id = $1`, [parseInt(req.params.id, 10), q.question, JSON.stringify(q.choices), q.answer, q.explain, q.active]);
      if (!rowCount) throw httpError(404, 'Question not found');
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.delete('/api/training/admin/questions/:id', ...M, async (req, res) => {
    try { await query(`UPDATE training_questions SET active = false WHERE id = $1`, [parseInt(req.params.id, 10)]); res.json({ ok: true }); } catch (e) { fail(res, e); }
  });

  // ============================================= each employee's training record --
  //  Lessons and quizzes (status, every attempt, which lessons they opened), the
  //  practice till, training done elsewhere (training_records, with the
  //  certificate file), and training assigned with a due date. Searchable across
  //  everyone, with a CSV.
  const fs = require('fs');
  const path = require('path');
  const FILES = path.join(__dirname, '..', 'data', 'training-files');
  fs.mkdirSync(FILES, { recursive: true });
  let upload = null;
  try {
    const multer = require('multer');
    upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 30 } });
  } catch (e) { console.warn('[training] multer missing: records without files'); }
  const withFile = (req, res, next) => (upload ? upload.single('file')(req, res, (err) => (err ? fail(res, httpError(400, err.code === 'LIMIT_FILE_SIZE' ? 'The file is over 10 MB' : 'Could not read the file')) : next())) : next());
  // Certificates: PDF or a photo, recognised by their first bytes, not the name.
  function sniff(buf) {
    if (!buf || buf.length < 8) return null;
    if (buf.slice(0, 5).toString('latin1') === '%PDF-') return { ext: '.pdf', mime: 'application/pdf' };
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: '.jpg', mime: 'image/jpeg' };
    if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: '.png', mime: 'image/png' };
    return null;
  }
  const KINDS = { course: 'Course', certification: 'Certificate / licence', on_the_job: 'On-the-job training', induction: 'Induction', safety: 'Health and safety', external: 'External training', other: 'Other' };
  const RESULTS = ['completed', 'passed', 'failed', 'attended', 'in progress'];
  const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
  const jmToday = () => new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10);
  const plusDays = (d, k) => new Date(new Date(d + 'T12:00:00Z').getTime() + k * 86400000).toISOString().slice(0, 10);
  const SOON = 60;   // days: "expiring soon"

  async function person(uid) {
    const { rows } = await query(
      `SELECT u.id, u.name, u.email, u.admin_role AS role, u.employee_no, u.disabled, u.archived_at, u.left_on,
              COALESCE((SELECT string_agg(d.name, ', ' ORDER BY d.name) FROM user_departments ud JOIN departments d ON d.id = ud.department_id WHERE ud.user_id = u.id), '') AS departments
         FROM users u WHERE u.id = $1 AND (u.is_staff OR u.is_admin)`, [uid]);
    return rows[0] || null;
  }
  const recOut = (r) => ({ id: r.id, kind: r.kind, kind_label: KINDS[r.kind] || r.kind, title: r.title, provider: r.provider, trainer_user_id: r.trainer_user_id, trainer: r.trainer_full || r.trainer_name || null,
    trainer_name: r.trainer_name, completed_on: r.completed_on, hours: r.hours == null ? null : Number(r.hours), result: r.result, score: r.score, expires_on: r.expires_on, certificate_no: r.certificate_no,
    notes: r.notes, has_file: !!r.file_storage, file_name: r.file_name, created_at: r.created_at, created_by: r.created_by_name || null });
  function recStatus(r, today) {
    if (r.result === 'failed' || r.result === 'in progress') return r.result;
    if (r.expires_on && r.expires_on < today) return 'expired';
    if (r.expires_on && r.expires_on <= plusDays(today, SOON)) return 'expiring';
    return r.result === 'passed' ? 'passed' : r.result === 'attended' ? 'attended' : 'completed';
  }
  // Everything about one person's training.
  async function profileFor(uid) {
    const p = await person(uid);
    if (!p) throw httpError(404, 'Employee not found');
    const today = jmToday();
    const mods = await statusFor(uid, p.role);
    const { rows: views } = await query(`SELECT m.key, v.first_at, v.last_at, v.views FROM training_views v JOIN training_modules m ON m.id = v.module_id WHERE v.user_id = $1`, [uid]);
    const { rows: tries } = await query(`SELECT COUNT(*)::int AS n, module_id FROM training_attempts WHERE user_id = $1 AND finished_at IS NOT NULL GROUP BY module_id`, [uid]);
    const { rows: mids } = await query(`SELECT id, key FROM training_modules`);
    const lessons = mods.map((m) => {
      const v = views.find((x) => x.key === m.key), mid = (mids.find((x) => x.key === m.key) || {}).id, t = tries.find((x) => x.module_id === mid);
      let status = m.status;
      if (status === 'passed' && m.expires && new Date(m.expires) <= new Date(plusDays(today, SOON) + 'T23:59:59Z')) status = 'expiring';
      if (status === 'reference') status = v ? 'read' : 'not read';
      return { key: m.key, title: m.title, quiz: m.quiz, required: m.required, for_role: m.for_me, status, best: m.best, passed_at: m.passed_at, expires: m.expires,
        attempts: t ? t.n : 0, last: m.last, first_opened: v ? v.first_at : null, last_opened: v ? v.last_at : null, opened: v ? v.views : 0 };
    });
    const { rows: attempts } = await query(
      `SELECT a.id, m.key, m.title, a.score_pct::float AS score, a.passed, a.finished_at FROM training_attempts a JOIN training_modules m ON m.id = a.module_id
        WHERE a.user_id = $1 AND a.finished_at IS NOT NULL ORDER BY a.finished_at DESC LIMIT 300`, [uid]);
    const { rows: prac } = await query(`SELECT COUNT(*) FILTER (WHERE done_at IS NOT NULL)::int AS done, COUNT(*) FILTER (WHERE passed)::int AS passed, MAX(done_at) AS last FROM training_practice WHERE user_id = $1`, [uid]);
    const { rows: recs } = await query(
      `SELECT r.*, to_char(r.completed_on, 'YYYY-MM-DD') AS completed_on, to_char(r.expires_on, 'YYYY-MM-DD') AS expires_on, t.name AS trainer_full, c.name AS created_by_name
         FROM training_records r LEFT JOIN users t ON t.id = r.trainer_user_id LEFT JOIN users c ON c.id = r.created_by
        WHERE r.user_id = $1 AND r.deleted_at IS NULL ORDER BY r.completed_on DESC NULLS FIRST, r.id DESC`, [uid]);
    const records = recs.map((r) => Object.assign(recOut(r), { status: recStatus(r, today) }));
    const { rows: asg } = await query(
      `SELECT a.id, a.module_id, m.key, COALESCE(m.title, a.title) AS title, m.quiz, to_char(a.due_on, 'YYYY-MM-DD') AS due_on, a.note, a.assigned_at, b.name AS assigned_by, a.done_at, d.name AS done_by,
              (SELECT MIN(x.finished_at) FROM training_attempts x WHERE x.user_id = a.user_id AND x.module_id = a.module_id AND x.passed AND x.finished_at >= a.assigned_at) AS passed_at,
              (SELECT v.last_at FROM training_views v WHERE v.user_id = a.user_id AND v.module_id = a.module_id AND v.last_at >= a.assigned_at) AS read_at
         FROM training_assignments a LEFT JOIN training_modules m ON m.id = a.module_id LEFT JOIN users b ON b.id = a.assigned_by LEFT JOIN users d ON d.id = a.done_by
        WHERE a.user_id = $1 AND a.cancelled_at IS NULL ORDER BY a.assigned_at DESC`, [uid]);
    const assignments = asg.map((a) => {
      const done = a.done_at || a.passed_at || (a.module_id && a.quiz === false ? a.read_at : null);
      return { id: a.id, key: a.key, title: a.title, lesson: !!a.module_id, due_on: a.due_on, note: a.note, assigned_at: a.assigned_at, assigned_by: a.assigned_by,
        done_at: done, done_by: a.done_by, status: done ? 'done' : a.due_on && a.due_on < today ? 'overdue' : 'due' };
    });
    const yearStart = today.slice(0, 4) + '-01-01';
    const summary = {
      required: lessons.filter((l) => l.required).length,
      required_passed: lessons.filter((l) => l.required && (l.status === 'passed' || l.status === 'expiring')).length,
      expired: lessons.filter((l) => l.status === 'expired').length + records.filter((r) => r.status === 'expired').length,
      expiring: lessons.filter((l) => l.status === 'expiring').length + records.filter((r) => r.status === 'expiring').length,
      not_passed: lessons.filter((l) => l.required && l.status === 'not passed').length,
      not_started: lessons.filter((l) => l.required && l.status === 'not started').length,
      overdue: assignments.filter((a) => a.status === 'overdue').length,
      due: assignments.filter((a) => a.status === 'due').length,
      records: records.length,
      hours_year: Math.round(records.filter((r) => r.completed_on && r.completed_on >= yearStart).reduce((t, r) => t + (r.hours || 0), 0) * 10) / 10,
      last_activity: [attempts[0] && attempts[0].finished_at, records[0] && records[0].completed_on, prac[0].last].filter(Boolean).map((x) => new Date(x)).sort((a, b) => b - a)[0] || null,
    };
    return { person: p, summary, lessons, attempts, practice: prac[0], records, assignments, kinds: KINDS };
  }

  // Staff: their own record.
  app.get('/api/training/me/record', requireAdmin, async (req, res) => {
    try { res.json(await profileFor(req.session.userId)); } catch (e) { fail(res, e); }
  });

  // Managers: everyone, with a summary each.
  async function staffList(f) {
    const { rows } = await query(
      `SELECT u.id FROM users u WHERE u.is_staff AND u.admin_role <> 'rep'
          AND ($1::boolean OR (NOT u.disabled AND u.archived_at IS NULL))
          AND ($2::int IS NULL OR u.id = $2)
          AND ($3::text IS NULL OR u.admin_role = $3)
          AND ($4::int IS NULL OR EXISTS (SELECT 1 FROM user_departments ud WHERE ud.user_id = u.id AND ud.department_id = $4))
        ORDER BY u.name`, [!!f.past, f.user || null, f.role || null, f.dept || null]);
    return rows.map((r) => r.id);
  }
  app.get('/api/training/people', ...M, async (req, res) => {
    try {
      const q = String(req.query.q || '').trim().toLowerCase();
      const ids = await staffList({ past: req.query.past === '1', role: req.query.role || null, dept: parseInt(req.query.dept, 10) || null });
      const out = [];
      for (const id of ids) {
        const p = await profileFor(id);
        if (q && ![p.person.name, p.person.email, p.person.employee_no, p.person.departments, p.person.role].some((x) => String(x || '').toLowerCase().includes(q))) continue;
        out.push(Object.assign({ id, name: p.person.name, role: p.person.role, departments: p.person.departments, employee_no: p.person.employee_no, past: !!(p.person.archived_at || p.person.disabled) }, p.summary));
      }
      const { rows: depts } = await query(`SELECT id, name FROM departments WHERE is_active ORDER BY name`);
      const { rows: mods } = await query(`SELECT key, title, quiz FROM training_modules WHERE active ORDER BY sort, id`);
      res.json({ people: out, departments: depts, modules: mods, kinds: KINDS });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/training/people/:id', ...M, async (req, res) => {
    try { res.json(await profileFor(parseInt(req.params.id, 10) || 0)); } catch (e) { fail(res, e); }
  });

  // Training done elsewhere.
  function cleanRecord(b) {
    const title = String(b.title || '').trim().slice(0, 200);
    if (!title) throw httpError(400, 'What was the training?');
    const kind = KINDS[b.kind] ? b.kind : 'course', result = RESULTS.includes(b.result) ? b.result : 'completed';
    const hours = b.hours === '' || b.hours == null ? null : Number(b.hours);
    if (hours != null && !(hours >= 0 && hours <= 2000)) throw httpError(400, 'Hours: 0 to 2000');
    const completed = day(b.completed_on), expires = day(b.expires_on);
    if (b.completed_on && !completed) throw httpError(400, 'Completed: a date');
    if (b.expires_on && !expires) throw httpError(400, 'Expires: a date');
    if (completed && expires && expires < completed) throw httpError(400, 'It cannot expire before it was done');
    const t = (v, n) => String(v == null ? '' : v).trim().slice(0, n) || null;
    return { kind, title, result, hours, completed, expires, provider: t(b.provider, 200), trainer_user_id: parseInt(b.trainer_user_id, 10) || null, trainer_name: t(b.trainer_name, 120),
      score: t(b.score, 40), certificate_no: t(b.certificate_no, 80), notes: t(b.notes, 2000) };
  }
  function saveFile(req) {
    if (!req.file) return null;
    const kind = sniff(req.file.buffer);
    if (!kind) throw httpError(400, 'The certificate must be a PDF, JPG or PNG');
    const name = crypto.randomBytes(16).toString('hex') + kind.ext;
    fs.writeFileSync(path.join(FILES, name), req.file.buffer, { flag: 'wx' });
    return { storage: name, mime: kind.mime, name: String(req.file.originalname || 'certificate' + kind.ext).replace(/[\\/\r\n"]/g, '_').slice(0, 120) };
  }
  app.post('/api/training/people/:id/records', ...M, withFile, async (req, res) => {
    try {
      const uid = parseInt(req.params.id, 10) || 0;
      if (!(await person(uid))) throw httpError(404, 'Employee not found');
      const r = cleanRecord(req.body || {}), f = saveFile(req);
      const { rows } = await query(
        `INSERT INTO training_records (user_id, kind, title, provider, trainer_user_id, trainer_name, completed_on, hours, result, score, expires_on, certificate_no, notes, file_name, file_mime, file_storage, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
        [uid, r.kind, r.title, r.provider, r.trainer_user_id, r.trainer_name, r.completed, r.hours, r.result, r.score, r.expires, r.certificate_no, r.notes, f && f.name, f && f.mime, f && f.storage, req.session.userId]);
      res.json({ ok: true, id: rows[0].id });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/training/records/:id', ...M, withFile, async (req, res) => {
    try {
      const r = cleanRecord(req.body || {}), f = saveFile(req);
      const { rowCount } = await query(
        `UPDATE training_records SET kind = $2, title = $3, provider = $4, trainer_user_id = $5, trainer_name = $6, completed_on = $7, hours = $8, result = $9, score = $10, expires_on = $11,
                certificate_no = $12, notes = $13, file_name = COALESCE($14, file_name), file_mime = COALESCE($15, file_mime), file_storage = COALESCE($16, file_storage),
                expiry_reminded = CASE WHEN expires_on IS DISTINCT FROM $11 THEN NULL ELSE expiry_reminded END, updated_by = $17, updated_at = NOW()
          WHERE id = $1 AND deleted_at IS NULL`,
        [parseInt(req.params.id, 10) || 0, r.kind, r.title, r.provider, r.trainer_user_id, r.trainer_name, r.completed, r.hours, r.result, r.score, r.expires, r.certificate_no, r.notes, f && f.name, f && f.mime, f && f.storage, req.session.userId]);
      if (!rowCount) throw httpError(404, 'Record not found');
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.delete('/api/training/records/:id', ...M, async (req, res) => {
    try {
      const { rowCount } = await query(`UPDATE training_records SET deleted_at = NOW(), deleted_by = $2 WHERE id = $1 AND deleted_at IS NULL`, [parseInt(req.params.id, 10) || 0, req.session.userId]);
      if (!rowCount) throw httpError(404, 'Record not found');
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  // The certificate: the employee themself, or a manager.
  app.get('/api/training/records/:id/file', requireAdmin, async (req, res) => {
    try {
      const { rows } = await query(`SELECT user_id, file_name, file_mime, file_storage FROM training_records WHERE id = $1 AND deleted_at IS NULL`, [parseInt(req.params.id, 10) || 0]);
      if (!rows.length || !rows[0].file_storage) throw httpError(404, 'No file');
      if (rows[0].user_id !== req.session.userId && !(await userCan(req, 'training.manage'))) throw httpError(403, 'Not your record');
      if (!/^[0-9a-f]{32}\.(pdf|jpg|png)$/.test(rows[0].file_storage)) throw httpError(404, 'No file');
      res.set('Content-Type', rows[0].file_mime);
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Cache-Control', 'private, no-store');
      res.set('Content-Disposition', (req.query.download === '1' ? 'attachment' : 'inline') + '; filename="' + String(rows[0].file_name || 'certificate').replace(/["\\\r\n]/g, '_') + '"');
      res.sendFile(path.join(FILES, rows[0].file_storage), (err) => { if (err && !res.headersSent) res.status(404).end(); });
    } catch (e) { fail(res, e); }
  });

  // Assigning training: a lesson (done when its quiz is passed) or anything else.
  app.post('/api/training/assign', ...M, async (req, res) => {
    try {
      const b = req.body || {};
      const ids = [...new Set((Array.isArray(b.user_ids) ? b.user_ids : [b.user_id]).map((x) => parseInt(x, 10)).filter(Boolean))];
      if (!ids.length) throw httpError(400, 'Choose who');
      let mod = null;
      if (b.module_key) {
        const { rows } = await query(`SELECT id, key, title, quiz FROM training_modules WHERE key = $1 AND active`, [String(b.module_key)]);
        if (!rows.length) throw httpError(404, 'Lesson not found');
        mod = rows[0];
      }
      const title = mod ? null : String(b.title || '').trim().slice(0, 200);
      if (!mod && !title) throw httpError(400, 'Choose a lesson or say what the training is');
      const due = day(b.due_on);
      if (b.due_on && !due) throw httpError(400, 'Due: a date');
      const note = String(b.note || '').trim().slice(0, 500) || null;
      let n = 0;
      for (const uid of ids) {
        if (!(await person(uid))) continue;
        if (mod) {
          const { rows: open } = await query(`SELECT 1 FROM training_assignments WHERE user_id = $1 AND module_id = $2 AND cancelled_at IS NULL AND done_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM training_attempts x WHERE x.user_id = $1 AND x.module_id = $2 AND x.passed AND x.finished_at >= training_assignments.assigned_at)`, [uid, mod.id]);
          if (open.length) continue;   // already waiting for this lesson
        }
        await query(`INSERT INTO training_assignments (user_id, module_id, title, due_on, note, assigned_by) VALUES ($1,$2,$3,$4,$5,$6)`, [uid, mod ? mod.id : null, title, due, note, req.session.userId]);
        n++;
        if (notice) notice([uid], { kind: 'training', title: '📚 Training for you: ' + (mod ? mod.title : title) + (due ? ', by ' + new Date(due + 'T12:00:00Z').toLocaleDateString('en-JM', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : ''),
          body: note || (mod ? (mod.quiz ? 'Read the lesson and pass its quiz.' : 'Read the lesson.') : 'Your manager will mark it done.'), link: mod ? '/training.html#lesson=' + mod.key : '/training.html#record' }).catch(() => {});
      }
      res.json({ ok: true, assigned: n, skipped: ids.length - n });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/training/assignments/:id/done', ...M, async (req, res) => {
    try {
      const { rowCount } = await query(`UPDATE training_assignments SET done_at = NOW(), done_by = $2 WHERE id = $1 AND module_id IS NULL AND done_at IS NULL AND cancelled_at IS NULL`, [parseInt(req.params.id, 10) || 0, req.session.userId]);
      if (!rowCount) throw httpError(409, 'Lessons are done when the quiz is passed; or this is already done');
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.delete('/api/training/assignments/:id', ...M, async (req, res) => {
    try {
      const { rowCount } = await query(`UPDATE training_assignments SET cancelled_at = NOW(), cancelled_by = $2 WHERE id = $1 AND cancelled_at IS NULL`, [parseInt(req.params.id, 10) || 0, req.session.userId]);
      if (!rowCount) throw httpError(404, 'Not found');
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // Search: one row per person and lesson, training record or assignment.
  const ATTENTION = ['expired', 'expiring', 'not passed', 'not started', 'overdue', 'failed'];
  const ATTENTION_RANK = { expired: 0, overdue: 1, expiring: 2, failed: 3, 'not passed': 4, 'not started': 5 };   // most urgent first
  app.get('/api/training/search', ...M, async (req, res) => {
    try {
      const f = req.query;
      const q = String(f.q || '').trim().toLowerCase();
      const type = ['lesson', 'record', 'assignment'].includes(f.type) ? f.type : null;
      const status = String(f.status || ''), from = day(f.from), to = day(f.to), kind = KINDS[f.kind] ? f.kind : null, module = f.module ? String(f.module) : null;
      const expiring = parseInt(f.expiring, 10) || null, today = jmToday();
      const ids = await staffList({ past: f.past === '1', user: parseInt(f.user, 10) || null, role: f.role || null, dept: parseInt(f.dept, 10) || null });
      const rows = [];
      for (const id of ids) {
        const p = await profileFor(id), who = { user_id: id, name: p.person.name, role: p.person.role, departments: p.person.departments, employee_no: p.person.employee_no };
        if (!type || type === 'lesson') for (const l of p.lessons) {
          if (!l.required && !l.attempts && !l.opened) continue;   // not for them and never touched
          rows.push(Object.assign({ type: 'lesson', type_label: l.quiz ? 'Lesson and quiz' : 'Lesson', key: l.key, title: l.title, status: l.status, date: l.passed_at || (l.last && l.last.at) || l.last_opened,
            expires: l.expires ? new Date(l.expires).toISOString().slice(0, 10) : null, score: l.best != null ? l.best + '%' : l.last ? l.last.score + '%' : null, detail: l.attempts + ' attempt(s), opened ' + l.opened + ' time(s)' + (l.required ? '' : ' · not required for the role') }, who));
        }
        if (!type || type === 'record') for (const r of p.records) {
          rows.push(Object.assign({ type: 'record', type_label: r.kind_label, kind: r.kind, id: r.id, title: r.title, status: r.status, date: r.completed_on, expires: r.expires_on, score: r.score, hours: r.hours,
            provider: r.provider, trainer: r.trainer, certificate_no: r.certificate_no, has_file: r.has_file, detail: r.notes }, who));
        }
        if (!type || type === 'assignment') for (const a of p.assignments) {
          rows.push(Object.assign({ type: 'assignment', type_label: 'Assigned', id: a.id, key: a.key, title: a.title, status: a.status, date: a.done_at || a.assigned_at, due: a.due_on, detail: (a.assigned_by ? 'by ' + a.assigned_by : '') + (a.note ? ' · ' + a.note : '') }, who));
        }
      }
      const d10 = (v) => (v ? (typeof v === 'string' && v.length === 10 ? v : new Date(new Date(v).getTime() - 5 * 3600000).toISOString().slice(0, 10)) : null);
      const out = rows.filter((r) => {
        if (status === 'attention' ? !ATTENTION.includes(r.status) : status && r.status !== status) return false;
        if (kind && r.kind !== kind) return false;
        if (module && r.key !== module) return false;
        const dd = d10(r.date);
        if (from && (!dd || dd < from)) return false;
        if (to && (!dd || dd > to)) return false;
        if (expiring && !(r.expires && r.expires >= today && r.expires <= plusDays(today, expiring))) return false;
        if (q && ![r.name, r.employee_no, r.departments, r.title, r.type_label, r.provider, r.trainer, r.certificate_no, r.detail, r.status].some((x) => String(x || '').toLowerCase().includes(q))) return false;
        return true;
      });
      if (status === 'attention') out.sort((a, b) => ATTENTION_RANK[a.status] - ATTENTION_RANK[b.status] || a.name.localeCompare(b.name));
      // Lessons whose text mentions the words (what the training says about a subject).
      let lessons = [];
      if (q.length >= 3) {
        const { rows: ls } = await query(`SELECT key, title, summary, body FROM training_modules WHERE active AND (title ILIKE $1 OR summary ILIKE $1 OR body ILIKE $1) ORDER BY sort, id LIMIT 20`, ['%' + q.replace(/[%_\\]/g, '\\$&') + '%']);
        lessons = ls.map((l) => { const i = l.body.toLowerCase().indexOf(q); return { key: l.key, title: l.title, snippet: i >= 0 ? (i > 60 ? '…' : '') + l.body.slice(Math.max(0, i - 60), i + q.length + 100) + '…' : l.summary }; });
      }
      if (f.format === 'csv') {
        const cols = [['name', 'Employee'], ['employee_no', 'Employee no'], ['role', 'Role'], ['departments', 'Departments'], ['type_label', 'Type'], ['title', 'Training'], ['status', 'Status'], ['date', 'Date'], ['due', 'Due'], ['expires', 'Expires'],
          ['score', 'Score'], ['hours', 'Hours'], ['provider', 'Provider'], ['trainer', 'Trainer'], ['certificate_no', 'Certificate no'], ['detail', 'Notes']];
        const cell = (v) => { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
        res.set('Content-Type', 'text/csv; charset=utf-8');
        res.set('Content-Disposition', 'attachment; filename="training-' + today + '.csv"');
        return res.send([cols.map((c) => c[1]).join(',')].concat(out.map((r) => cols.map((c) => cell(c[0] === 'date' ? d10(r.date) : r[c[0]])).join(','))).join('\n'));
      }
      res.json({ rows: out.slice(0, 2000), total: out.length, lessons });
    } catch (e) { fail(res, e); }
  });

  // Reminders, once a day: certificates expiring within 30 days; assigned
  // training due tomorrow or overdue (once).
  async function remind() {
    if (!notice) return;
    const today = jmToday();
    const { rows: exp } = await query(
      `SELECT r.id, r.user_id, r.title, to_char(r.expires_on, 'YYYY-MM-DD') AS expires_on FROM training_records r JOIN users u ON u.id = r.user_id
        WHERE r.deleted_at IS NULL AND NOT u.disabled AND u.archived_at IS NULL AND r.expires_on BETWEEN $1::date AND $1::date + 30 AND r.expiry_reminded IS DISTINCT FROM r.expires_on`, [today]);
    for (const r of exp) {
      await query(`UPDATE training_records SET expiry_reminded = expires_on WHERE id = $1`, [r.id]);
      notice([r.user_id], { kind: 'training', title: '📜 ' + r.title + ' expires on ' + r.expires_on, body: 'Arrange the renewal with your manager.', link: '/training.html#record' }).catch(() => {});
    }
    const { rows: due } = await query(
      `SELECT a.id, a.user_id, COALESCE(m.title, a.title) AS title, m.key, to_char(a.due_on, 'YYYY-MM-DD') AS due_on FROM training_assignments a LEFT JOIN training_modules m ON m.id = a.module_id
        WHERE a.cancelled_at IS NULL AND a.done_at IS NULL AND a.due_on IS NOT NULL AND a.due_on <= $1::date + 1 AND a.reminded_on IS NULL
          AND NOT EXISTS (SELECT 1 FROM training_attempts x WHERE x.user_id = a.user_id AND x.module_id = a.module_id AND x.passed AND x.finished_at >= a.assigned_at)`, [today]);
    for (const a of due) {
      await query(`UPDATE training_assignments SET reminded_on = $2 WHERE id = $1`, [a.id, today]);
      notice([a.user_id], { kind: 'training', title: '📚 ' + a.title + (a.due_on < today ? ' was due on ' : ' is due on ') + a.due_on, body: a.key ? 'Open the lesson and pass its quiz.' : 'Talk to your manager.', link: a.key ? '/training.html#lesson=' + a.key : '/training.html#record' }).catch(() => {});
    }
  }
  const remindTimer = setInterval(() => remind().catch((e) => console.warn('[training] reminders', e.message)), 3600000);
  if (remindTimer.unref) remindTimer.unref();
  setTimeout(() => remind().catch(() => {}), 60000).unref();

  return { useNotices(fn) { notice = fn; }, remind };
}

module.exports = { register };
