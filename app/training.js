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
// =============================================================================
const crypto = require('crypto');

function register(app, deps) {
  const { query, requireAdmin, requireCap, userCan, posSaleHandler } = deps;
  const can = (k) => [requireAdmin, requireCap(k)];
  const n = (v) => (v == null || v === '' ? 0 : Number(v));
  const r2 = (v) => Math.round(n(v) * 100) / 100;
  function httpError(status, msg) { const e = new Error(msg); e.status = status; e.publicMessage = msg; return e; }
  function fail(res, e) { const s = e.status || 500; if (s >= 500) console.error('[training]', e); res.status(s).json({ error: e.publicMessage || e.message }); }
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
  app.get('/api/training/modules/:key', requireAdmin, async (req, res) => {
    try {
      const u = await me(req);
      const { rows } = await query(`SELECT id, key, title, summary, body, pass_pct, valid_months, quiz, practice, roles FROM training_modules WHERE key = $1 AND active`, [String(req.params.key)]);
      if (!rows.length) throw httpError(404, 'Module not found');
      if (!applies(rows[0], u.admin_role) && !(await userCan(req, 'training.manage'))) throw httpError(403, 'This module is not for your role');
      const { rows: c } = await query(`SELECT COUNT(*)::int AS n FROM training_questions WHERE module_id = $1 AND active`, [rows[0].id]);
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
}

module.exports = { register };
