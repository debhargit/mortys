// =============================================================================
//  Vision Auto Solutions -- System management: audit, security, tech support
//
//    const sysops = require('./sysops').register(app, deps)   (early: its
//    session middleware has to run before the other routes)
//
//  Kept apart from running the business, under its own capabilities:
//    sys.audit     audit trail (with tamper check), exceptions, audit reviews,
//                  access reviews
//    sys.security  security posture, who is online, sign everyone / one person
//                  out, disable an account, incident register
//    sys.support   help desk (all tickets), equipment register, maintenance,
//                  change log, system health
//    support.raise every staff member: raise a ticket, follow their own
//  The first three are manager-only unless granted by name; a dedicated IT
//  person can be given them without any business powers.
//
//  Sessions are cookies (no server store), so signing people out works by
//  time: sign-in stamps session.at; a session older than the shop-wide
//  sys_signout_at, or than that person's users.sessions_revoked_at, is ended
//  on its next request.
// =============================================================================
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const TZ = 'America/Jamaica';
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const T_STATUS = ['new', 'assigned', 'in_progress', 'waiting', 'resolved', 'closed'];
const T_CATS = ['hardware', 'software', 'till', 'printer', 'network', 'account', 'website', 'email', 'other'];
const I_KINDS = ['security', 'fraud', 'privacy', 'outage', 'data', 'physical', 'other'];
const I_SEV = ['low', 'medium', 'high', 'critical'];
const I_STATUS = ['open', 'investigating', 'contained', 'resolved', 'closed'];
const A_KINDS = ['pc', 'till', 'server', 'printer', 'receipt_printer', 'label_printer', 'scanner', 'cash_drawer', 'phone', 'tablet', 'router', 'switch', 'ups', 'camera', 'other'];
const A_STATUS = ['in_use', 'spare', 'repair', 'retired', 'lost'];
const C_KINDS = ['software', 'config', 'hardware', 'access', 'data', 'network'];
const C_STATUS = ['planned', 'approved', 'done', 'rolled_back', 'cancelled'];

function register(app, deps) {
  const { query, requireAdmin, requireCap, userCan, bcrypt, mailer, devMode, permState } = deps;
  // The permission list is defined later in server.js than this module is mounted.
  const capabilities = () => deps.getCapabilities(), restrictedCaps = () => deps.getRestricted();
  const can = (k) => [requireAdmin, requireCap(k)];
  const AUD = can('sys.audit'), SEC = can('sys.security'), SUP = can('sys.support');
  const n = (v) => (v == null || v === '' || isNaN(Number(v)) ? 0 : Number(v));
  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
  const today = () => new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10);
  const addDays = (d, k) => new Date(new Date(d + 'T12:00:00Z').getTime() + k * 86400000).toISOString().slice(0, 10);
  const txt = (v, max) => { const s = String(v == null ? '' : v).trim(); return s ? s.slice(0, max || 200) : null; };
  const pick = (v, list, dflt) => (list.includes(v) ? v : dflt);
  const ipOf = (req) => String((req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.ip || '')).split(',')[0].trim().slice(0, 60);
  function httpError(status, msg) { const e = new Error(msg); e.status = status; e.publicMessage = msg; return e; }
  function fail(res, e) { const s = e.status || 500; if (s >= 500) console.error('[sysops]', e); res.status(s).json({ error: e.publicMessage || e.message }); }
  async function setting(key, dflt) {
    const { rows } = await query(`SELECT value FROM warehouse_settings WHERE key = $1`, [key]);
    return rows.length && rows[0].value != null && rows[0].value !== '' ? rows[0].value : dflt;
  }
  const putSetting = (k, v) => query(`INSERT INTO warehouse_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [k, String(v)]);
  async function audit(req, action, detail) {
    try {
      const { rows } = await query(`SELECT name FROM users WHERE id = $1`, [req.session && req.session.userId]);
      await query(`INSERT INTO audit_log (user_id, user_name, action, ip, detail) VALUES ($1,$2,$3,$4,$5)`,
        [req.session && req.session.userId || null, rows[0] && rows[0].name || null, action, ipOf(req), detail ? JSON.stringify(detail) : null]);
    } catch (e) { console.warn('[sysops] audit', e.message); }
  }
  async function nextNumber(table, prefix) {
    const { rows } = await query(`SELECT COALESCE(MAX(id), 0) + 1 AS n FROM ${table}`);
    return prefix + '-' + String(rows[0].n).padStart(4, '0');
  }
  const send = (to, subject, text) => { if (!devMode && mailer && mailer.sendEmail && to && !/\.local$/i.test(to)) mailer.sendEmail({ to, subject, text }).catch(() => {}); };

  // --------------------------------------------------------- session control --
  const ctl = { signoutAt: 0, revoked: new Map(), loaded: 0 };
  async function loadCtl(force) {
    if (!force && Date.now() - ctl.loaded < 15000) return ctl;
    ctl.signoutAt = n(await setting('sys_signout_at', '0'));
    const { rows } = await query(`SELECT id, EXTRACT(EPOCH FROM sessions_revoked_at) * 1000 AS ms FROM users WHERE sessions_revoked_at IS NOT NULL`);
    ctl.revoked = new Map(rows.map((r) => [r.id, Number(r.ms)]));
    ctl.loaded = Date.now();
    return ctl;
  }
  const seen = new Map();   // userId -> when last_seen_at was last written
  app.use(async (req, res, next) => {
    const s = req.session;
    if (!s || !s.userId) return next();
    try {
      const c = await loadCtl(false);
      const at = n(s.at), rev = c.revoked.get(s.userId);
      if ((c.signoutAt && at < c.signoutAt) || (rev && at < rev)) {
        req.session = null;
        if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'You were signed out by the system administrator. Please sign in again.', signed_out: true });
        return next();
      }
      if (Date.now() - (seen.get(s.userId) || 0) > 120000) {
        seen.set(s.userId, Date.now());
        query(`UPDATE users SET last_seen_at = NOW(), last_seen_ip = $2 WHERE id = $1`, [s.userId, ipOf(req)]).catch(() => {});
      }
    } catch (_) { /* never block a request on this */ }
    next();
  });

  const checkHooks = [], overviewHooks = [];

  // ---------------------------------------------------------------- access --
  app.get('/api/sys/me', requireAdmin, async (req, res) => {
    try {
      const [a, s, p, r, nw] = await Promise.all(['sys.audit', 'sys.security', 'sys.support', 'support.raise', 'sys.network'].map((k) => userCan(req, k)));
      res.json({ audit: a, security: s, support: p, raise: r, network: nw, user_id: req.session.userId });
    } catch (e) { fail(res, e); }
  });

  // =================================================================== AUDIT ==
  const AUDIT_COLS = `a.id, a.at, a.user_id, a.user_name, a.action, a.target, a.status, a.ip, a.remote, a.station, a.detail, a.hash IS NOT NULL AS chained`;
  function auditWhere(q) {
    const w = ['true'], b = [];
    if (isDate(q.from)) { b.push(q.from); w.push(`a.at >= ($${b.length}::date)::timestamp AT TIME ZONE '${TZ}'`); }
    if (isDate(q.to)) { b.push(q.to); w.push(`a.at < ($${b.length}::date + 1)::timestamp AT TIME ZONE '${TZ}'`); }
    if (parseInt(q.user, 10)) { b.push(parseInt(q.user, 10)); w.push(`a.user_id = $${b.length}`); }
    if (q.action) { b.push('%' + String(q.action).slice(0, 80) + '%'); w.push(`a.action ILIKE $${b.length}`); }
    if (q.q) { b.push('%' + String(q.q).slice(0, 80) + '%'); w.push(`(a.action ILIKE $${b.length} OR a.user_name ILIKE $${b.length} OR a.target ILIKE $${b.length} OR a.ip ILIKE $${b.length} OR a.detail::text ILIKE $${b.length})`); }
    if (q.remote === '1') w.push('a.remote');
    if (q.kind === 'signin') w.push(`a.action IN ('signin', 'signin_failed', 'locked', 'signin_refused')`);
    if (q.kind === 'change') w.push(`a.action ~ '^(POST|PUT|PATCH|DELETE) '`);
    return { where: w.join(' AND '), binds: b };
  }
  app.get('/api/sys/audit', ...AUD, async (req, res) => {
    try {
      const { where, binds } = auditWhere(req.query);
      const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100)), offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
      const { rows } = await query(`SELECT ${AUDIT_COLS} FROM audit_log a WHERE ${where} ORDER BY a.id DESC LIMIT ${limit} OFFSET ${offset}`, binds);
      const { rows: cnt } = await query(`SELECT COUNT(*)::int AS n FROM (SELECT 1 FROM audit_log a WHERE ${where} LIMIT 100001) x`, binds);
      res.json({ rows, total: cnt[0].n, limit, offset });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/sys/audit.csv', ...AUD, async (req, res) => {
    try {
      const { where, binds } = auditWhere(req.query);
      const { rows } = await query(`SELECT ${AUDIT_COLS} FROM audit_log a WHERE ${where} ORDER BY a.id LIMIT 50000`, binds);
      const q = (v) => { v = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
      const out = [['id', 'at', 'user_id', 'user', 'action', 'target', 'status', 'ip', 'remote', 'station', 'detail']]
        .concat(rows.map((r) => [r.id, new Date(r.at).toISOString(), r.user_id, r.user_name, r.action, r.target, r.status, r.ip, r.remote, r.station, r.detail]));
      await audit(req, 'audit_export', { rows: rows.length, filter: req.query });
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="audit-${today()}.csv"`);
      res.send(out.map((l) => l.map(q).join(',')).join('\n'));
    } catch (e) { fail(res, e); }
  });
  // Tamper check: recompute every chained row's hash in order.
  async function verifyChain() {
    const { rows } = await query(
      `SELECT id, prev_hash, hash,
              encode(sha256(convert_to(prev_hash || '|' || id::text || '|' || to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') || '|' ||
                COALESCE(user_id::text, '') || '|' || COALESCE(action, '') || '|' || COALESCE(target, '') || '|' ||
                COALESCE(status::text, '') || '|' || COALESCE(ip, '') || '|' || COALESCE(detail::text, ''), 'UTF8')), 'hex') AS calc
         FROM audit_log WHERE hash IS NOT NULL ORDER BY id`);
    const { rows: un } = await query(`SELECT COUNT(*)::int AS n, MIN(id) AS first, MAX(id) AS last FROM audit_log WHERE hash IS NULL`);
    let prev = 'genesis', broken = null;
    for (const r of rows) {
      if (r.prev_hash !== prev) { broken = { id: Number(r.id), problem: 'a row before this one was removed or changed' }; break; }
      if (r.calc !== r.hash) { broken = { id: Number(r.id), problem: 'this row was changed after it was written' }; break; }
      prev = r.hash;
    }
    return { ok: !broken, checked: rows.length, first_id: rows.length ? Number(rows[0].id) : null, last_id: rows.length ? Number(rows[rows.length - 1].id) : null,
      broken, before_chain: { rows: un[0].n, note: un[0].n ? 'Rows written before the tamper check was switched on cannot be checked.' : null } };
  }
  app.get('/api/sys/audit/verify', ...AUD, async (req, res) => {
    try { const v = await verifyChain(); await audit(req, 'audit_verify', { ok: v.ok, checked: v.checked }); res.json(v); } catch (e) { fail(res, e); }
  });

  // Exceptions: the things an auditor looks at first, for a date range.
  async function exceptions(from, to) {
    const open = await setting('sys_business_open', '07:00'), close = await setting('sys_business_close', '19:00');
    const range = `at >= ($1::date)::timestamp AT TIME ZONE '${TZ}' AND at < ($2::date + 1)::timestamp AT TIME ZONE '${TZ}'`;
    const sections = [];
    async function sec(key, label, severity, sql, binds) {
      try {
        const { rows } = await query(sql, binds || [from, to]);
        const count = rows.length ? Number(rows[0].total_count || rows.length) : 0;
        sections.push({ key, label, severity, count, sample: rows.slice(0, 25).map((r) => { const o = Object.assign({}, r); delete o.total_count; return o; }) });
      } catch (e) { sections.push({ key, label, severity, count: null, error: 'not available: ' + e.message.slice(0, 80) }); }
    }
    const A = (cond, sev, key, label) => sec(key, label, sev,
      `SELECT id, at, user_name, action, target, ip, remote, COUNT(*) OVER () AS total_count FROM audit_log WHERE ${range} AND ${cond} ORDER BY id DESC LIMIT 25`);
    await A(`action = 'signin' AND ((at AT TIME ZONE '${TZ}')::time < '${open}'::time OR (at AT TIME ZONE '${TZ}')::time > '${close}'::time)`, 'medium', 'after_hours', 'Sign-ins outside business hours (' + open + '–' + close + ')');
    await A(`action = 'signin' AND remote`, 'low', 'remote', 'Sign-ins from outside the shop network');
    await A(`action IN ('signin_failed', 'locked', 'signin_refused')`, 'medium', 'failed', 'Failed or refused sign-ins and lockouts');
    await A(`action ~ '^(POST|PUT|PATCH|DELETE) /api/(admin/(users|roles|categories|staff)|sec/)'`, 'high', 'access', 'Changes to staff accounts, roles, permissions or security settings');
    await A(`action ~ '^DELETE '`, 'medium', 'deletes', 'Deletions');
    await A(`action ~ '/api/(payroll/(runs/:id/(approve|void)|payments/:id/void|remittances)|bank/(txns/:id/void|reconcile)|ar/payments/:id/void|ap/payments/:id/void)'`, 'high', 'money', 'Payroll approvals and voids, bank and payment voids, reconciliations');
    await A(`action ~ '^(POST|PUT|PATCH) /api/admin/products' AND detail::text ~* 'price|cost'`, 'medium', 'prices', 'Price or cost changes on parts');
    await A(`action ~ '^(POST|PUT|PATCH) /api/(admin/stock|stock|counts/.*/(approve|post))'`, 'medium', 'stock', 'Stock adjustments and count postings');
    await sec('voids', 'Voided sales', 'high',
      `SELECT s.id, s.receipt_number, s.total_usd AS total, s.voided_at AS at, u.name AS voided_by, COUNT(*) OVER () AS total_count
         FROM pos_sales s LEFT JOIN users u ON u.id = s.voided_by WHERE s.voided AND s.voided_at >= ($1::date)::timestamp AT TIME ZONE '${TZ}' AND s.voided_at < ($2::date + 1)::timestamp AT TIME ZONE '${TZ}' ORDER BY s.voided_at DESC LIMIT 25`);
    await sec('returns', 'Returns and refunds', 'medium',
      `SELECT r.id, r.return_number, r.refund_method, r.refund_subtotal_usd AS amount, r.reason, r.created_at AS at, COUNT(*) OVER () AS total_count
         FROM pos_sale_returns r WHERE r.created_at >= ($1::date)::timestamp AT TIME ZONE '${TZ}' AND r.created_at < ($2::date + 1)::timestamp AT TIME ZONE '${TZ}' ORDER BY r.id DESC LIMIT 25`);
    await sec('till', 'Till overrides: price drops, removed items, cleared carts, department overrides', 'medium',
      `SELECT id, at, user_name, kind, name, amount, COUNT(*) OVER () AS total_count FROM pos_events WHERE ${range}
          AND kind IN ('price_changed', 'item_removed', 'cart_cleared', 'dept_override', 'discount_changed') AND COALESCE(amount, 0) <> 0 ORDER BY id DESC LIMIT 25`);
    await sec('manual_je', 'Manual journal entries and reversals', 'high',
      `SELECT id, number, entry_date, book, source_kind, memo, COUNT(*) OVER () AS total_count FROM gl_entries
        WHERE entry_date BETWEEN $1 AND $2 AND (book = 'manual' OR source_kind IN ('manual', 'reversal')) ORDER BY id DESC LIMIT 25`);
    return { from, to, sections, total: sections.reduce((t, s) => t + (s.count || 0), 0) };
  }
  const rangeOf = (q) => { const to = isDate(q.to) ? q.to : today(); const from = isDate(q.from) ? q.from : addDays(to, -6); return [from, to]; };
  app.get('/api/sys/exceptions', ...AUD, async (req, res) => {
    try { const [from, to] = rangeOf(req.query); res.json(await exceptions(from, to)); } catch (e) { fail(res, e); }
  });
  app.get('/api/sys/audit-reviews', ...AUD, async (req, res) => {
    try {
      const { rows } = await query(`SELECT r.id, to_char(r.from_date, 'YYYY-MM-DD') AS from_date, to_char(r.to_date, 'YYYY-MM-DD') AS to_date, r.notes, r.reviewed_at, u.name AS reviewed_by,
                                           (SELECT SUM((s->>'count')::int) FROM jsonb_array_elements(r.exceptions->'sections') s) AS exceptions, r.chain->>'ok' AS chain_ok
                                      FROM sys_audit_reviews r LEFT JOIN users u ON u.id = r.reviewed_by ORDER BY r.to_date DESC, r.id DESC LIMIT 100`);
      res.json({ reviews: rows });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/sys/audit-reviews', ...AUD, async (req, res) => {
    try {
      const b = req.body || {};
      if (!isDate(b.from) || !isDate(b.to) || b.from > b.to) throw httpError(400, 'Choose the period reviewed');
      const notes = txt(b.notes, 2000);
      if (!notes) throw httpError(400, 'Write what you checked and found (it is the record of the review)');
      const ex = await exceptions(b.from, b.to), chain = await verifyChain();
      const { rows } = await query(`INSERT INTO sys_audit_reviews (from_date, to_date, exceptions, chain, notes, reviewed_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [b.from, b.to, JSON.stringify(ex), JSON.stringify(chain), notes, req.session.userId]);
      res.json({ ok: true, id: rows[0].id, exceptions: ex.total, chain_ok: chain.ok });
    } catch (e) { fail(res, e); }
  });

  // Access reviews: everyone who can sign in to the back office, with what they can do.
  async function staffSnapshot() {
    const { rows } = await query(
      `SELECT id, name, email, admin_role, disabled, is_staff, is_admin, totp_enabled_at IS NOT NULL AS two_step, last_login_at, last_seen_at, perms
         FROM users WHERE is_admin OR is_staff ORDER BY disabled, name`);
    const out = [];
    for (const u of rows) {
      let powers = [], full = false;
      try {
        const st = await permState(u.id);
        full = !!st.full;
        powers = full ? ['everything (owner / manager role)'] : capabilities().filter((c) => restrictedCaps().has(c.key) && st.perms[c.key]).map((c) => c.label);
      } catch (_) {}
      out.push({ user_id: u.id, name: u.name, email: u.email, role: u.admin_role, disabled: !!u.disabled, two_step: !!u.two_step, last_login_at: u.last_login_at, last_seen_at: u.last_seen_at, full, powers });
    }
    return out;
  }
  app.get('/api/sys/access-reviews', ...AUD, async (req, res) => {
    try {
      const { rows } = await query(`SELECT r.*, a.name AS started_by_name, f.name AS finished_by_name,
                                           (SELECT COUNT(*)::int FROM sys_access_review_items i WHERE i.review_id = r.id) AS people,
                                           (SELECT COUNT(*)::int FROM sys_access_review_items i WHERE i.review_id = r.id AND i.decision IS NOT NULL) AS decided
                                      FROM sys_access_reviews r LEFT JOIN users a ON a.id = r.started_by LEFT JOIN users f ON f.id = r.finished_by ORDER BY r.id DESC LIMIT 50`);
      res.json({ reviews: rows });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/sys/access-reviews', ...AUD, async (req, res) => {
    try {
      const title = txt(req.body && req.body.title, 120) || 'Access review ' + today();
      const { rows } = await query(`INSERT INTO sys_access_reviews (title, started_by) VALUES ($1, $2) RETURNING id`, [title, req.session.userId]);
      const snap = await staffSnapshot();
      for (const s of snap) await query(`INSERT INTO sys_access_review_items (review_id, user_id, snapshot) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [rows[0].id, s.user_id, JSON.stringify(s)]);
      res.json({ ok: true, id: rows[0].id, people: snap.length });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/sys/access-reviews/:id', ...AUD, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10) || 0;
      const { rows: r } = await query(`SELECT * FROM sys_access_reviews WHERE id = $1`, [id]);
      if (!r.length) throw httpError(404, 'Not found');
      const { rows: items } = await query(`SELECT i.*, d.name AS decided_by_name FROM sys_access_review_items i LEFT JOIN users d ON d.id = i.decided_by WHERE i.review_id = $1 ORDER BY (i.snapshot->>'disabled')::boolean, i.snapshot->>'name'`, [id]);
      res.json({ review: r[0], items });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/sys/access-reviews/:id/items/:item', ...AUD, async (req, res) => {
    try {
      const b = req.body || {};
      const decision = pick(b.decision, ['keep', 'change', 'disable'], null);
      if (!decision) throw httpError(400, 'Keep, change or disable?');
      if (decision !== 'keep' && !txt(b.note)) throw httpError(400, 'Say what should change, or why');
      const { rowCount } = await query(`UPDATE sys_access_review_items i SET decision = $3, note = $4, decided_by = $5, decided_at = NOW()
                                         FROM sys_access_reviews r WHERE r.id = i.review_id AND r.status = 'open' AND i.id = $2 AND i.review_id = $1`,
        [parseInt(req.params.id, 10) || 0, parseInt(req.params.item, 10) || 0, decision, txt(b.note, 300), req.session.userId]);
      if (!rowCount) throw httpError(409, 'This review is finished or the person is not on it');
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  // Finish: everyone decided; "disable" decisions are carried out (never yourself or the last owner).
  app.post('/api/sys/access-reviews/:id/finish', ...AUD, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10) || 0;
      const { rows: items } = await query(`SELECT i.*, r.status FROM sys_access_review_items i JOIN sys_access_reviews r ON r.id = i.review_id WHERE i.review_id = $1`, [id]);
      if (!items.length) throw httpError(404, 'Not found');
      if (items[0].status !== 'open') throw httpError(409, 'Already finished');
      const left = items.filter((i) => !i.decision).length;
      if (left) throw httpError(409, left + ' person(s) still need a decision');
      const disabled = [];
      for (const i of items.filter((x) => x.decision === 'disable' && x.user_id)) {
        if (i.user_id === req.session.userId) continue;
        const r = await disableUser(i.user_id, 'Access review #' + id + ': ' + (i.note || ''), req);
        if (r) disabled.push(i.snapshot.name);
      }
      await query(`UPDATE sys_access_reviews SET status = 'finished', finished_by = $2, finished_at = NOW() WHERE id = $1`, [id, req.session.userId]);
      await audit(req, 'access_review_finished', { review: id, disabled });
      res.json({ ok: true, disabled });
    } catch (e) { fail(res, e); }
  });

  // ================================================================ SECURITY ==
  async function disableUser(uid, reason, req) {
    const { rows } = await query(`SELECT id, name, admin_role, disabled FROM users WHERE id = $1`, [uid]);
    if (!rows.length || rows[0].disabled) return false;
    if (rows[0].admin_role === 'owner') {
      const { rows: o } = await query(`SELECT COUNT(*)::int AS n FROM users WHERE admin_role = 'owner' AND NOT disabled AND id <> $1`, [uid]);
      if (!o[0].n) throw httpError(409, rows[0].name + ' is the only active owner and cannot be disabled');
    }
    await query(`UPDATE users SET disabled = true, sessions_revoked_at = NOW() WHERE id = $1`, [uid]);
    await loadCtl(true);
    await audit(req, 'user_disabled', { user_id: uid, name: rows[0].name, reason });
    return true;
  }
  // A password hash that matches a default / obvious password. bcrypt is slow on
  // purpose, so each hash is checked once and remembered (a new password = a new hash).
  const weakSeen = new Map();
  async function weakHash(h) {
    if (weakSeen.has(h)) return weakSeen.get(h);
    let weak = false;
    for (const p of ['password123', 'password', 'admin123']) { try { if (await bcrypt.compare(p, h)) { weak = true; break; } } catch (_) {} }
    weakSeen.set(h, weak);
    return weak;
  }
  // Posture: plain checks with pass / warn / fail and what to do.
  async function posture() {
    const checks = [];
    const add = (key, label, state, detail, fix) => checks.push({ key, label, state, detail, fix });
    const s = {};
    const { rows: st } = await query(`SELECT key, value FROM warehouse_settings WHERE key LIKE 'sec\\_%' OR key LIKE 'sys\\_%'`);
    for (const r of st) s[r.key] = r.value;
    const policy = s.sec_2fa_policy || 'off';
    add('2fa_policy', '2-step sign-in policy', policy === 'off' ? 'fail' : policy === 'remote' ? 'warn' : 'pass', 'Policy: ' + policy,
      'Security page: set 2-step to "managers" (or "staff") so a stolen password alone cannot get in.');
    const { rows: mg } = await query(`SELECT name FROM users WHERE NOT disabled AND is_admin AND admin_role IN ('owner', 'manager') AND totp_enabled_at IS NULL ORDER BY name`);
    add('2fa_managers', 'Owners and managers using 2-step', mg.length ? 'fail' : 'pass', mg.length ? mg.length + ' without it: ' + mg.map((x) => x.name).slice(0, 8).join(', ') : 'All set up', 'Each one sets it up under their own account (Security page, My sign-in).');
    // Known default / test passwords on active back-office accounts.
    const { rows: adm } = await query(`SELECT id, name, password_hash FROM users WHERE NOT disabled AND is_admin AND password_hash IS NOT NULL LIMIT 60`);
    const weak = [];
    for (const u of adm) { if (await weakHash(u.password_hash)) weak.push(u.name); }
    add('default_pw', 'No default or obvious passwords', weak.length ? 'fail' : 'pass', weak.length ? 'Using a default / obvious password: ' + weak.join(', ') : 'None found among ' + adm.length + ' accounts', 'Change those passwords now.');
    const dormantDays = n(s.sys_dormant_days) || 60;
    const { rows: dor } = await query(`SELECT name FROM users WHERE NOT disabled AND is_admin AND COALESCE(last_seen_at, last_login_at, created_at) < NOW() - make_interval(days => $1) ORDER BY name`, [dormantDays]).catch(() => ({ rows: [] }));
    add('dormant', 'No unused back-office logins', dor.length ? 'warn' : 'pass', dor.length ? dor.length + ' not used in ' + dormantDays + ' days: ' + dor.map((x) => x.name).slice(0, 10).join(', ') : 'None', 'Disable logins nobody uses (Security tab, or an access review).');
    const { rows: own } = await query(`SELECT COUNT(*) FILTER (WHERE admin_role = 'owner')::int AS owners, COUNT(*) FILTER (WHERE admin_role IN ('owner', 'manager'))::int AS full FROM users WHERE NOT disabled AND is_admin`);
    add('full_access', 'Few people with full access', own[0].full > 4 ? 'warn' : 'pass', own[0].full + ' owner / manager accounts (' + own[0].owners + ' owners)', 'Give staff the specific permissions they need instead of the manager role.');
    const lockA = n(s.sec_lockout_attempts) || 5;
    add('lockout', 'Lockout after wrong passwords', lockA <= 6 ? 'pass' : 'warn', lockA + ' attempts, ' + (s.sec_lockout_minutes || 15) + ' minutes', 'Security page: 5 attempts or fewer.');
    const idle = n(s.sec_idle_minutes);
    add('idle', 'Idle sign-out', idle && idle <= 60 ? 'pass' : 'warn', idle ? idle + ' minutes' : 'never', 'Security page: sign out after 30–60 minutes idle, so an unattended screen is not left open.');
    add('audit_keep', 'Audit history kept at least a year', n(s.sec_audit_days) >= 365 ? 'pass' : 'warn', (s.sec_audit_days || 730) + ' days', 'Security page: keep 365 days or more.');
    const chain = await verifyChain();
    add('audit_chain', 'Audit log not tampered with', chain.ok ? 'pass' : 'fail', chain.ok ? chain.checked + ' entries checked' : 'Broken at entry ' + chain.broken.id + ': ' + chain.broken.problem, 'Open an incident: an audit entry was removed or edited.');
    const { rows: bk } = await query(`SELECT created_at, ok, note FROM backup_log WHERE direction = 'out' ORDER BY created_at DESC LIMIT 1`).catch(() => ({ rows: [] }));
    const bkAge = bk.length ? (Date.now() - new Date(bk[0].created_at).getTime()) / 3600000 : null;
    add('backup', 'Recent off-site backup', bk.length && bk[0].ok && bkAge < 30 ? 'pass' : bk.length && bkAge < 72 ? 'warn' : 'fail',
      bk.length ? 'Last ' + (bk[0].ok ? 'good' : 'FAILED') + ' backup ' + Math.round(bkAge) + ' h ago' : 'No off-site backup recorded', 'Admin > Backups: switch on the automatic off-site backup and check it runs.');
    const { rows: tm } = await query(`SELECT COUNT(*) FILTER (WHERE status = 'pending')::int AS pending, COUNT(*) FILTER (WHERE status = 'approved' AND last_seen < NOW() - INTERVAL '30 days')::int AS stale FROM terminals`).catch(() => ({ rows: [{ pending: 0, stale: 0 }] }));
    add('terminals', 'Only known computers can use the system', tm[0].pending ? 'warn' : 'pass', tm[0].pending + ' waiting for approval, ' + tm[0].stale + ' approved but unseen for 30 days', 'Approve or block waiting computers; block old ones.');
    const { rows: fl } = await query(`SELECT COUNT(*)::int AS n FROM audit_log WHERE action IN ('signin_failed', 'locked') AND at > NOW() - INTERVAL '24 hours'`);
    add('failed_24h', 'Failed sign-ins in the last day', fl[0].n > 20 ? 'fail' : fl[0].n > 5 ? 'warn' : 'pass', fl[0].n + ' failed sign-ins', 'Check the audit trail for who and from where; someone may be guessing passwords.');
    const { rows: lk } = await query(`SELECT name FROM users WHERE locked_until > NOW()`);
    add('locked_now', 'Accounts locked right now', lk.length ? 'warn' : 'pass', lk.length ? lk.map((x) => x.name).join(', ') : 'None', 'Find out why before unlocking (Security page).');
    add('secrets', 'Keys kept out of the code', process.env.SESSION_SECRET ? 'pass' : 'warn', process.env.SESSION_SECRET ? 'Session secret set in the environment' : 'Session secret not set in the environment',
      'Set SESSION_SECRET (and API keys) as environment variables on the server.');
    const { rows: ic } = await query(`SELECT COUNT(*)::int AS n FROM sys_incidents WHERE status NOT IN ('resolved', 'closed') AND severity IN ('high', 'critical')`);
    add('incidents', 'No serious incidents open', ic[0].n ? 'fail' : 'pass', ic[0].n + ' high / critical open', 'Work the open incidents (Incidents tab).');
    for (const h of checkHooks) { try { for (const c of await h()) checks.push(c); } catch (e) { console.warn('[sysops] check hook', e.message); } }
    const score = Math.round(100 * checks.reduce((t, c) => t + (c.state === 'pass' ? 1 : c.state === 'warn' ? 0.5 : 0), 0) / checks.length);
    return { score, checks };
  }
  app.get('/api/sys/security', ...SEC, async (req, res) => {
    try {
      const p = await posture();
      const c = await loadCtl(true);
      res.json(Object.assign(p, { signout_at: c.signoutAt || null }));
    } catch (e) { fail(res, e); }
  });
  app.get('/api/sys/online', ...SEC, async (req, res) => {
    try {
      const { rows } = await query(`SELECT id, name, admin_role, last_seen_at, last_seen_ip, last_login_at, last_login_ip, totp_enabled_at IS NOT NULL AS two_step
                                      FROM users WHERE NOT disabled AND last_seen_at > NOW() - INTERVAL '30 minutes' ORDER BY last_seen_at DESC`);
      res.json({ online: rows });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/sys/staff', ...SEC, async (req, res) => {
    try {
      const { rows } = await query(`SELECT id, name, email, admin_role, disabled, totp_enabled_at IS NOT NULL AS two_step, last_login_at, last_seen_at, locked_until > NOW() AS locked, sessions_revoked_at
                                      FROM users WHERE is_admin OR is_staff ORDER BY disabled, name`);
      res.json({ staff: rows });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/sys/signout-all', ...SEC, async (req, res) => {
    try {
      const reason = txt(req.body && req.body.reason, 200);
      if (!reason) throw httpError(400, 'Say why everyone is being signed out');
      const at = Date.now();
      await putSetting('sys_signout_at', at);
      await loadCtl(true);
      req.session.at = at + 1;   // the person doing it stays signed in
      await audit(req, 'signout_all', { reason });
      res.json({ ok: true, at });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/sys/users/:id/signout', ...SEC, async (req, res) => {
    try {
      const uid = parseInt(req.params.id, 10) || 0;
      const { rows } = await query(`UPDATE users SET sessions_revoked_at = NOW() WHERE id = $1 RETURNING name`, [uid]);
      if (!rows.length) throw httpError(404, 'Not found');
      await loadCtl(true);
      if (uid === req.session.userId) req.session.at = Date.now() + 1;
      await audit(req, 'user_signed_out', { user_id: uid, name: rows[0].name, reason: txt(req.body && req.body.reason, 200) });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/sys/users/:id/disable', ...SEC, async (req, res) => {
    try {
      const uid = parseInt(req.params.id, 10) || 0;
      const reason = txt(req.body && req.body.reason, 200);
      if (!reason) throw httpError(400, 'Say why the account is disabled');
      if (uid === req.session.userId) throw httpError(409, 'You cannot disable your own account');
      const ok = await disableUser(uid, reason, req);
      if (!ok) throw httpError(409, 'Not found or already disabled');
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // Incidents.
  app.get('/api/sys/incidents', ...SEC, async (req, res) => {
    try {
      const st = req.query.status === 'all' ? null : req.query.status === 'closed' ? ['resolved', 'closed'] : ['open', 'investigating', 'contained'];
      const { rows } = await query(`SELECT i.*, r.name AS reported_by_name, a.name AS assigned_to_name FROM sys_incidents i LEFT JOIN users r ON r.id = i.reported_by LEFT JOIN users a ON a.id = i.assigned_to
                                     WHERE ($1::text[] IS NULL OR i.status = ANY($1)) ORDER BY CASE i.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, i.id DESC LIMIT 200`, [st]);
      res.json({ incidents: rows });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/sys/incidents', ...SEC, async (req, res) => {
    try {
      const b = req.body || {};
      const title = txt(b.title, 160);
      if (!title) throw httpError(400, 'Give the incident a title');
      const num = await nextNumber('sys_incidents', 'INC');
      const tl = [{ at: new Date().toISOString(), by: req.session.userId, status: 'open', note: 'Reported' }];
      const { rows } = await query(`INSERT INTO sys_incidents (number, title, kind, severity, description, impact, occurred_at, reported_by, assigned_to, timeline) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [num, title, pick(b.kind, I_KINDS, 'security'), pick(b.severity, I_SEV, 'medium'), txt(b.description, 4000), txt(b.impact, 1000),
          b.occurred_at && !isNaN(Date.parse(b.occurred_at)) ? new Date(b.occurred_at) : null, req.session.userId, parseInt(b.assigned_to, 10) || null, JSON.stringify(tl)]);
      await audit(req, 'incident_opened', { number: num, severity: b.severity });
      res.json({ ok: true, id: rows[0].id, number: num });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/sys/incidents/:id/update', ...SEC, async (req, res) => {
    try {
      const b = req.body || {}, id = parseInt(req.params.id, 10) || 0;
      const { rows } = await query(`SELECT * FROM sys_incidents WHERE id = $1`, [id]);
      if (!rows.length) throw httpError(404, 'Not found');
      const inc = rows[0];
      const status = b.status ? pick(b.status, I_STATUS, null) : null;
      const note = txt(b.note, 2000);
      if (!status && !note && !('assigned_to' in b) && !b.root_cause && !b.severity) throw httpError(400, 'Nothing to update');
      if (status === 'closed' && !(txt(b.root_cause) || inc.root_cause)) throw httpError(400, 'Record the root cause before closing');
      const tl = (inc.timeline || []).concat([{ at: new Date().toISOString(), by: req.session.userId, status: status || undefined, note: note || undefined }]);
      await query(`UPDATE sys_incidents SET status = COALESCE($2, status), severity = COALESCE($3, severity), root_cause = COALESCE($4, root_cause),
                     assigned_to = CASE WHEN $5::boolean THEN $6 ELSE assigned_to END, timeline = $7,
                     resolved_at = CASE WHEN $2 IN ('resolved', 'closed') AND resolved_at IS NULL THEN NOW() ELSE resolved_at END,
                     closed_at = CASE WHEN $2 = 'closed' THEN NOW() ELSE closed_at END WHERE id = $1`,
        [id, status, b.severity ? pick(b.severity, I_SEV, null) : null, txt(b.root_cause, 2000), 'assigned_to' in b, parseInt(b.assigned_to, 10) || null, JSON.stringify(tl)]);
      if (status) await audit(req, 'incident_' + status, { number: inc.number });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ============================================================ TECH SUPPORT ==
  async function slaHours(priority) { return n(await setting('sys_sla_' + priority + '_hours', { urgent: 4, high: 24, normal: 72, low: 168 }[priority])); }
  const TICKET_SELECT = `t.*, r.name AS requester_name, r.email AS requester_email, a.name AS assignee_name, a.email AS assignee_email, s.name AS asset_name, s.tag AS asset_tag,
     (t.due_at < NOW() AND t.status NOT IN ('resolved', 'closed')) AS overdue
     FROM sys_tickets t LEFT JOIN users r ON r.id = t.requester_id LEFT JOIN users a ON a.id = t.assignee_id LEFT JOIN sys_assets s ON s.id = t.asset_id`;
  async function canRaise(req) { return userCan(req, 'support.raise'); }
  async function canSupport(req) { return userCan(req, 'sys.support'); }
  app.get('/api/sys/tickets', requireAdmin, async (req, res) => {
    try {
      const support = await canSupport(req);
      if (!support && !(await canRaise(req))) throw httpError(403, 'Not allowed');
      const mine = !support || req.query.mine === '1';
      const st = req.query.status === 'all' ? null : req.query.status === 'done' ? ['resolved', 'closed'] : ['new', 'assigned', 'in_progress', 'waiting'];
      const { rows } = await query(`SELECT ${TICKET_SELECT} WHERE ($1::text[] IS NULL OR t.status = ANY($1)) AND (NOT $2 OR t.requester_id = $3 OR t.assignee_id = $3)
                                     ORDER BY CASE WHEN t.status IN ('resolved', 'closed') THEN 1 ELSE 0 END, CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, t.due_at NULLS LAST, t.id DESC LIMIT 300`,
        [st, mine, req.session.userId]);
      res.json({ tickets: rows, support });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/sys/tickets', requireAdmin, async (req, res) => {
    try {
      if (!(await canRaise(req))) throw httpError(403, 'Not allowed to raise IT tickets');
      const b = req.body || {};
      const title = txt(b.title, 160);
      if (!title) throw httpError(400, 'What is the problem? (a short title)');
      const priority = pick(b.priority, PRIORITIES, 'normal');
      const num = await nextNumber('sys_tickets', 'TCK');
      const { rows } = await query(`INSERT INTO sys_tickets (number, title, description, category, priority, requester_id, asset_id, location, due_at)
                                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8, NOW() + make_interval(hours => $9)) RETURNING id`,
        [num, title, txt(b.description, 4000), pick(b.category, T_CATS, 'other'), priority, req.session.userId, parseInt(b.asset_id, 10) || null, txt(b.location, 120), await slaHours(priority)]);
      // Tell the people who handle support (anyone with sys.support who has an email).
      const { rows: who } = await query(`SELECT name FROM users WHERE id = $1`, [req.session.userId]);
      const { rows: techs } = await query(`SELECT id, email FROM users WHERE NOT disabled AND is_admin AND email IS NOT NULL`);
      for (const t of techs) { if (await userCanId(t.id, 'sys.support')) send(t.email, '[IT] ' + num + ' ' + priority + ': ' + title, (who[0] && who[0].name || 'Someone') + ' raised ' + num + ':\n\n' + (b.description || title)); }
      res.json({ ok: true, id: rows[0].id, number: num });
    } catch (e) { fail(res, e); }
  });
  async function userCanId(uid, cap) { try { const st = await permState(uid); return st.full || !!st.perms[cap]; } catch (_) { return false; } }
  async function ticketFor(req, id) {
    const { rows } = await query(`SELECT ${TICKET_SELECT} WHERE t.id = $1`, [id]);
    if (!rows.length) throw httpError(404, 'Ticket not found');
    const support = await canSupport(req);
    if (!support && rows[0].requester_id !== req.session.userId) throw httpError(403, 'Not your ticket');
    return { t: rows[0], support };
  }
  app.get('/api/sys/tickets/:id', requireAdmin, async (req, res) => {
    try {
      const { t, support } = await ticketFor(req, parseInt(req.params.id, 10) || 0);
      const { rows: notes } = await query(`SELECT nt.*, u.name AS user_name FROM sys_ticket_notes nt LEFT JOIN users u ON u.id = nt.user_id WHERE nt.ticket_id = $1 AND ($2 OR NOT nt.internal) ORDER BY nt.id`, [t.id, support]);
      res.json({ ticket: t, notes, support });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/sys/tickets/:id/notes', requireAdmin, async (req, res) => {
    try {
      const { t, support } = await ticketFor(req, parseInt(req.params.id, 10) || 0);
      const body = txt(req.body && req.body.body, 4000);
      if (!body) throw httpError(400, 'Write the note');
      const internal = support && !!(req.body && req.body.internal);
      await query(`INSERT INTO sys_ticket_notes (ticket_id, user_id, body, internal) VALUES ($1,$2,$3,$4)`, [t.id, req.session.userId, body, internal]);
      if (support && req.session.userId !== t.requester_id && !t.first_response_at && !internal) await query(`UPDATE sys_tickets SET first_response_at = NOW() WHERE id = $1`, [t.id]);
      // A reply from the requester re-opens a waiting ticket.
      if (!support && t.status === 'waiting') await query(`UPDATE sys_tickets SET status = 'in_progress', updated_at = NOW() WHERE id = $1`, [t.id]);
      await query(`UPDATE sys_tickets SET updated_at = NOW() WHERE id = $1`, [t.id]);
      if (!internal) {
        const to = req.session.userId === t.requester_id ? t.assignee_email : t.requester_email;
        send(to, '[IT] ' + t.number + ': ' + t.title, body);
      }
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/sys/tickets/:id', ...SUP, async (req, res) => {
    try {
      const b = req.body || {}, id = parseInt(req.params.id, 10) || 0;
      const { rows } = await query(`SELECT * FROM sys_tickets WHERE id = $1`, [id]);
      if (!rows.length) throw httpError(404, 'Ticket not found');
      const t = rows[0];
      const status = b.status ? pick(b.status, T_STATUS, null) : t.status;
      if (status === 'resolved' && !(txt(b.resolution) || t.resolution)) throw httpError(400, 'Say how it was fixed before resolving');
      const priority = b.priority ? pick(b.priority, PRIORITIES, t.priority) : t.priority;
      const assignee = 'assignee_id' in b ? (parseInt(b.assignee_id, 10) || null) : t.assignee_id;
      const due = priority !== t.priority ? `created_at + make_interval(hours => ${await slaHours(priority)})` : 'due_at';
      await query(`UPDATE sys_tickets SET status = $2, priority = $3, assignee_id = $4, resolution = COALESCE($5, resolution), category = COALESCE($6, category), asset_id = CASE WHEN $7::boolean THEN $8 ELSE asset_id END,
                     due_at = ${due}, resolved_at = CASE WHEN $2 = 'resolved' AND resolved_at IS NULL THEN NOW() WHEN $2 NOT IN ('resolved', 'closed') THEN NULL ELSE resolved_at END,
                     closed_at = CASE WHEN $2 = 'closed' THEN NOW() ELSE closed_at END,
                     first_response_at = COALESCE(first_response_at, CASE WHEN $2 <> 'new' THEN NOW() END), updated_at = NOW() WHERE id = $1`,
        [id, status === 'new' && assignee ? 'assigned' : status, priority, assignee, txt(b.resolution, 2000), b.category ? pick(b.category, T_CATS, null) : null, 'asset_id' in b, parseInt(b.asset_id, 10) || null]);
      if (status === 'resolved' && t.status !== 'resolved') {
        const { rows: rq } = await query(`SELECT email FROM users WHERE id = $1`, [t.requester_id]);
        send(rq[0] && rq[0].email, '[IT] ' + t.number + ' fixed: ' + t.title, (b.resolution || t.resolution || '') + '\n\nIf it is not fixed, reply on the ticket.');
      }
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  // The requester confirms the fix (and rates it), or says it is not fixed.
  app.post('/api/sys/tickets/:id/confirm', requireAdmin, async (req, res) => {
    try {
      const { t } = await ticketFor(req, parseInt(req.params.id, 10) || 0);
      if (t.requester_id !== req.session.userId) throw httpError(403, 'Only the person who raised it can confirm');
      if (t.status !== 'resolved') throw httpError(409, 'It is not marked fixed yet');
      const fixed = !(req.body && req.body.fixed === false);
      const rating = Math.max(1, Math.min(5, parseInt(req.body && req.body.rating, 10) || 0)) || null;
      if (fixed) await query(`UPDATE sys_tickets SET status = 'closed', closed_at = NOW(), satisfaction = $2, updated_at = NOW() WHERE id = $1`, [t.id, rating]);
      else {
        await query(`UPDATE sys_tickets SET status = 'in_progress', resolved_at = NULL, updated_at = NOW() WHERE id = $1`, [t.id]);
        await query(`INSERT INTO sys_ticket_notes (ticket_id, user_id, body) VALUES ($1,$2,$3)`, [t.id, req.session.userId, 'Not fixed: ' + (txt(req.body && req.body.note, 2000) || '')]);
      }
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // Equipment.
  const ASSET_TEXT = ['tag', 'name', 'make', 'model', 'serial', 'location', 'ip', 'mac', 'supplier', 'notes'];
  function assetValues(b, cur) {
    const v = {};
    for (const k of ASSET_TEXT) v[k] = k in b ? txt(b[k], k === 'notes' ? 1000 : 120) : (cur ? cur[k] : null);
    v.kind = b.kind ? pick(b.kind, A_KINDS, 'other') : (cur ? cur.kind : 'pc');
    v.status = b.status ? pick(b.status, A_STATUS, 'in_use') : (cur ? cur.status : 'in_use');
    for (const k of ['purchase_date', 'warranty_until']) v[k] = k in b ? (isDate(b[k]) ? b[k] : null) : (cur ? cur[k] : null);
    v.cost = 'cost' in b ? (b.cost === '' || b.cost == null ? null : n(b.cost)) : (cur ? cur.cost : null);
    for (const k of ['assigned_to', 'terminal_id']) v[k] = k in b ? (parseInt(b[k], 10) || null) : (cur ? cur[k] : null);
    if (!v.name) throw httpError(400, 'Name the device (e.g. "Front counter till")');
    return v;
  }
  const ASSET_COLS = [...ASSET_TEXT, 'kind', 'status', 'purchase_date', 'warranty_until', 'cost', 'assigned_to', 'terminal_id'];
  app.get('/api/sys/assets', requireAdmin, async (req, res) => {
    try {
      if (!(await canSupport(req)) && !(await canRaise(req))) throw httpError(403, 'Not allowed');
      const { rows } = await query(`SELECT s.*, to_char(s.purchase_date, 'YYYY-MM-DD') AS purchase_date, to_char(s.warranty_until, 'YYYY-MM-DD') AS warranty_until, u.name AS assigned_name, tm.name AS terminal_name,
                                           (SELECT COUNT(*)::int FROM sys_tickets t WHERE t.asset_id = s.id AND t.status NOT IN ('resolved', 'closed')) AS open_tickets
                                      FROM sys_assets s LEFT JOIN users u ON u.id = s.assigned_to LEFT JOIN terminals tm ON tm.id = s.terminal_id ORDER BY s.status = 'retired', s.kind, s.name`);
      res.json({ assets: rows });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/sys/assets', ...SUP, async (req, res) => {
    try {
      const v = assetValues(req.body || {}, null);
      if (!v.tag) v.tag = await nextNumber('sys_assets', 'IT');
      const { rows } = await query(`INSERT INTO sys_assets (${ASSET_COLS.join(', ')}) VALUES (${ASSET_COLS.map((_, i) => '$' + (i + 1)).join(', ')}) RETURNING id`, ASSET_COLS.map((k) => v[k]));
      res.json({ ok: true, id: rows[0].id, tag: v.tag });
    } catch (e) { if (/sys_assets_tag_key/.test(e.message)) e = httpError(409, 'That asset tag is already used'); fail(res, e); }
  });
  app.put('/api/sys/assets/:id', ...SUP, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10) || 0;
      const { rows } = await query(`SELECT *, to_char(purchase_date, 'YYYY-MM-DD') AS purchase_date, to_char(warranty_until, 'YYYY-MM-DD') AS warranty_until FROM sys_assets WHERE id = $1`, [id]);
      if (!rows.length) throw httpError(404, 'Not found');
      const v = assetValues(req.body || {}, rows[0]);
      await query(`UPDATE sys_assets SET ${ASSET_COLS.map((k, i) => k + ' = $' + (i + 2)).join(', ')}, updated_at = NOW() WHERE id = $1`, [id, ...ASSET_COLS.map((k) => v[k])]);
      res.json({ ok: true });
    } catch (e) { if (/sys_assets_tag_key/.test(e.message)) e = httpError(409, 'That asset tag is already used'); fail(res, e); }
  });
  app.get('/api/sys/assets/:id', ...SUP, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10) || 0;
      const { rows } = await query(`SELECT s.*, to_char(s.purchase_date, 'YYYY-MM-DD') AS purchase_date, to_char(s.warranty_until, 'YYYY-MM-DD') AS warranty_until FROM sys_assets s WHERE s.id = $1`, [id]);
      if (!rows.length) throw httpError(404, 'Not found');
      const { rows: m } = await query(`SELECT m.*, to_char(m.done_at, 'YYYY-MM-DD') AS done_at, t.number AS ticket FROM sys_maintenance m LEFT JOIN sys_tickets t ON t.id = m.ticket_id WHERE m.asset_id = $1 ORDER BY m.done_at DESC, m.id DESC`, [id]);
      const { rows: t } = await query(`SELECT id, number, title, status, created_at FROM sys_tickets WHERE asset_id = $1 ORDER BY id DESC LIMIT 50`, [id]);
      res.json({ asset: rows[0], maintenance: m, tickets: t });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/sys/assets/:id/maintenance', ...SUP, async (req, res) => {
    try {
      const b = req.body || {}, id = parseInt(req.params.id, 10) || 0;
      if (!txt(b.notes)) throw httpError(400, 'Say what was done');
      await query(`INSERT INTO sys_maintenance (asset_id, ticket_id, kind, done_at, done_by, cost, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, parseInt(b.ticket_id, 10) || null, pick(b.kind, ['repair', 'service', 'upgrade', 'replacement', 'check'], 'repair'), isDate(b.done_at) ? b.done_at : today(), txt(b.done_by, 120), b.cost === '' || b.cost == null ? null : n(b.cost), txt(b.notes, 2000), req.session.userId]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  // Bring the registered terminals (computers running the system) in as equipment.
  app.post('/api/sys/assets/import-terminals', ...SUP, async (req, res) => {
    try {
      const { rows } = await query(`SELECT t.id, COALESCE(t.name, t.hostname, 'Terminal ' || t.id) AS name, t.hostname, t.address FROM terminals t WHERE NOT EXISTS (SELECT 1 FROM sys_assets a WHERE a.terminal_id = t.id) AND t.status <> 'blocked'`);
      let added = 0;
      for (const t of rows) {
        const tag = await nextNumber('sys_assets', 'IT');
        await query(`INSERT INTO sys_assets (tag, name, kind, terminal_id, ip, notes) VALUES ($1,$2,'pc',$3,$4,$5)`, [tag, t.name, t.id, t.address || null, t.hostname ? 'Hostname ' + t.hostname : null]);
        added++;
      }
      res.json({ ok: true, added });
    } catch (e) { fail(res, e); }
  });

  // Change log.
  app.get('/api/sys/changes', ...SUP, async (req, res) => {
    try {
      const { rows } = await query(`SELECT c.*, r.name AS requested_by_name, a.name AS approved_by_name FROM sys_changes c LEFT JOIN users r ON r.id = c.requested_by LEFT JOIN users a ON a.id = c.approved_by ORDER BY c.id DESC LIMIT 200`);
      res.json({ changes: rows });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/sys/changes', ...SUP, async (req, res) => {
    try {
      const b = req.body || {};
      const title = txt(b.title, 160);
      if (!title) throw httpError(400, 'Name the change');
      const risk = pick(b.risk, ['low', 'medium', 'high'], 'low');
      if (risk !== 'low' && !txt(b.rollback_plan)) throw httpError(400, 'A medium or high-risk change needs a way back (rollback plan)');
      const num = await nextNumber('sys_changes', 'CHG');
      const { rows } = await query(`INSERT INTO sys_changes (number, title, description, kind, risk, planned_at, rollback_plan, requested_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [num, title, txt(b.description, 4000), pick(b.kind, C_KINDS, 'software'), risk, b.planned_at && !isNaN(Date.parse(b.planned_at)) ? new Date(b.planned_at) : null, txt(b.rollback_plan, 2000), req.session.userId]);
      res.json({ ok: true, id: rows[0].id, number: num });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/sys/changes/:id/status', ...SUP, async (req, res) => {
    try {
      const b = req.body || {}, id = parseInt(req.params.id, 10) || 0;
      const status = pick(b.status, C_STATUS, null);
      if (!status) throw httpError(400, 'Which status?');
      const { rows } = await query(`SELECT * FROM sys_changes WHERE id = $1`, [id]);
      if (!rows.length) throw httpError(404, 'Not found');
      const c = rows[0];
      if (status === 'approved' && c.requested_by === req.session.userId && c.risk !== 'low') throw httpError(403, 'Someone else must approve a ' + c.risk + '-risk change');
      if (['done', 'rolled_back'].includes(status) && !txt(b.result)) throw httpError(400, 'Record what happened');
      if (status === 'done' && c.risk !== 'low' && !c.approved_by) throw httpError(409, 'Approve it before marking it done');
      await query(`UPDATE sys_changes SET status = $2, approved_by = CASE WHEN $2 = 'approved' THEN $3 ELSE approved_by END,
                     done_at = CASE WHEN $2 IN ('done', 'rolled_back') THEN NOW() ELSE done_at END, result = COALESCE($4, result) WHERE id = $1`,
        [id, status, req.session.userId, txt(b.result, 2000)]);
      await audit(req, 'change_' + status, { number: c.number });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // System health.
  app.get('/api/sys/health', ...SUP, async (req, res) => {
    try {
      const dataDir = path.join(__dirname, '..', 'data');
      let disk = null;
      try { const st = fs.statfsSync(dataDir); disk = { free_gb: +(st.bavail * st.bsize / 1e9).toFixed(1), total_gb: +(st.blocks * st.bsize / 1e9).toFixed(1) }; } catch (_) {}
      const { rows: db } = await query(`SELECT pg_database_size(current_database()) AS bytes, (SELECT COUNT(*)::int FROM pg_stat_activity WHERE datname = current_database()) AS connections, version() AS version`);
      const { rows: big } = await query(`SELECT relname AS name, pg_total_relation_size(c.oid) AS bytes, c.reltuples::bigint AS rows FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
                                          WHERE ns.nspname = 'public' AND c.relkind = 'r' ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 10`);
      // Recent errors from the server log (data/logs/server.log, the last ~400 KB).
      let errors = [];
      try {
        const f = path.join(dataDir, 'logs', 'server.log');
        const st = fs.statSync(f), len = Math.min(st.size, 400000), buf = Buffer.alloc(len);
        const fd = fs.openSync(f, 'r'); fs.readSync(fd, buf, 0, len, st.size - len); fs.closeSync(fd);
        errors = buf.toString('utf8').split(/\r?\n/).filter((l) => /\b(error|exception|failed|fatal|unhandled)\b/i.test(l) && !/GET |POST /.test(l)).slice(-40);
      } catch (_) {}
      const { rows: bk } = await query(`SELECT direction, filename, bytes, ok, note, created_at FROM backup_log ORDER BY created_at DESC LIMIT 5`).catch(() => ({ rows: [] }));
      const { rows: tm } = await query(`SELECT name, hostname, status, app_version, last_seen FROM terminals ORDER BY last_seen DESC NULLS LAST LIMIT 30`).catch(() => ({ rows: [] }));
      let website = null;
      if (req.query.website === '1' && !devMode) {
        try {
          const ctrl = new AbortController(); const tmr = setTimeout(() => ctrl.abort(), 6000);
          const t0 = Date.now(); const r = await fetch('https://visionautosolutions.com/api/health', { signal: ctrl.signal }); clearTimeout(tmr);
          website = { status: r.status, ms: Date.now() - t0, body: (await r.text()).slice(0, 200) };
        } catch (e) { website = { error: e.message }; }
      }
      const mem = process.memoryUsage();
      res.json({
        server: { hostname: os.hostname(), platform: os.platform() + ' ' + os.release(), node: process.version, uptime_h: +(process.uptime() / 3600).toFixed(1), os_uptime_h: +(os.uptime() / 3600).toFixed(1),
          cpus: os.cpus().length, load: os.loadavg(), mem_free_gb: +(os.freemem() / 1e9).toFixed(1), mem_total_gb: +(os.totalmem() / 1e9).toFixed(1), app_mem_mb: Math.round(mem.rss / 1e6), dev_mode: !!devMode },
        disk, database: { size_mb: Math.round(Number(db[0].bytes) / 1e6), connections: db[0].connections, version: String(db[0].version).split(',')[0], biggest: big.map((x) => ({ name: x.name, mb: +(Number(x.bytes) / 1e6).toFixed(1), rows: Number(x.rows) })) },
        backups: bk, terminals: tm, errors, website,
      });
    } catch (e) { fail(res, e); }
  });

  // ---------------------------------------------------------------- overview --
  app.get('/api/sys/overview', requireAdmin, async (req, res) => {
    try {
      const [a, s, p] = await Promise.all(['sys.audit', 'sys.security', 'sys.support'].map((k) => userCan(req, k)));
      if (!a && !s && !p) throw httpError(403, 'Not allowed');
      const out = { audit: a, security: s, support: p };
      if (p) {
        const { rows } = await query(`SELECT COUNT(*) FILTER (WHERE status NOT IN ('resolved', 'closed'))::int AS open,
                                             COUNT(*) FILTER (WHERE status NOT IN ('resolved', 'closed') AND due_at < NOW())::int AS overdue,
                                             COUNT(*) FILTER (WHERE status = 'new')::int AS unassigned,
                                             COUNT(*) FILTER (WHERE status NOT IN ('resolved', 'closed') AND priority = 'urgent')::int AS urgent,
                                             ROUND(AVG(EXTRACT(EPOCH FROM (resolved_at - created_at)) / 3600) FILTER (WHERE resolved_at > NOW() - INTERVAL '30 days')::numeric, 1) AS avg_fix_h,
                                             ROUND(AVG(satisfaction) FILTER (WHERE closed_at > NOW() - INTERVAL '90 days')::numeric, 1) AS rating
                                        FROM sys_tickets`);
        const { rows: w } = await query(`SELECT COUNT(*)::int AS n FROM sys_assets WHERE status IN ('in_use', 'spare') AND warranty_until BETWEEN CURRENT_DATE AND CURRENT_DATE + 60`);
        out.tickets = rows[0]; out.warranty_soon = w[0].n;
      }
      if (s) {
        const p2 = await posture();
        out.score = p2.score; out.failing = p2.checks.filter((c) => c.state === 'fail').map((c) => c.label);
        const { rows } = await query(`SELECT COUNT(*)::int AS n FROM sys_incidents WHERE status NOT IN ('resolved', 'closed')`);
        out.incidents_open = rows[0].n;
        const { rows: on } = await query(`SELECT COUNT(*)::int AS n FROM users WHERE NOT disabled AND last_seen_at > NOW() - INTERVAL '30 minutes'`);
        out.online = on[0].n;
      }
      if (a) {
        const v = await verifyChain();
        out.chain_ok = v.ok;
        const { rows } = await query(`SELECT to_char(MAX(to_date), 'YYYY-MM-DD') AS last FROM sys_audit_reviews`);
        out.last_audit_review = rows[0].last;
        const { rows: ar } = await query(`SELECT to_char(MAX(finished_at), 'YYYY-MM-DD') AS last FROM sys_access_reviews WHERE status = 'finished'`);
        out.last_access_review = ar[0].last;
        const ex = await exceptions(addDays(today(), -6), today());
        out.exceptions_7d = ex.sections.filter((x) => x.count).map((x) => ({ label: x.label, count: x.count, severity: x.severity }));
      }
      for (const h of overviewHooks) { try { Object.assign(out, await h(req, { audit: a, security: s, support: p })); } catch (e) { console.warn('[sysops] overview hook', e.message); } }
      res.json(out);
    } catch (e) { fail(res, e); }
  });

  async function revokeSessions(uid) { await query(`UPDATE users SET sessions_revoked_at = NOW() WHERE id = $1`, [uid]); await loadCtl(true); }
  // Other parts of system management (cyber.js) add posture checks and overview figures here.
  return { verifyChain, posture, audit, disableUser, revokeSessions, addChecks: (fn) => checkHooks.push(fn), addOverview: (fn) => overviewHooks.push(fn) };
}

module.exports = { register };
