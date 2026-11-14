// =============================================================================
//  Morty's Auto Parts -- Petty cash payout vouchers (Deb, 2026-11-07)
//
//  Mounted by server.js:
//    require('./petty-voucher').register(app, { query, getPool, requireAdmin,
//      userCan, permState, mailer, notice })
//  Page: /petty-voucher.html (its own window; also a tab in the back office).
//
//  A voucher is the paper behind a petty cash payout: who is paid (name,
//  address, phone, email), their reference, line items (quantity x unit
//  amount = line total, each line to the expense account picked on it), the
//  total, prepared by, approved by, comments, print and email.
//
//    draft -> pending (sent for approval: notice + optional email with the
//    link to a manager or anyone with petty.approve) -> approved | rejected
//    approved -> sent (to the cashiers' Due for payment, one cashier / one
//    till / everyone, via the existing till_tasks payout) -> paid when a
//    cashier pays it from the drawer;  or approved -> paid from a petty cash
//    fund (a cash_payouts row);  void before it is paid.
//
//  Ledger: nothing posts here. gl.js posts the till payout (till_movement) or
//  the fund payout (petty_payout) as usual, and when that payout belongs to a
//  voucher it splits the debit over the voucher's lines and their accounts.
//
//  Tables (lazy DDL here AND appended to schema.sql; no DDL at startup):
//  petty_vouchers, petty_voucher_lines, petty_voucher_comments,
//  petty_voucher_events, and till_tasks.voucher_id.
// =============================================================================
'use strict';

const TZ = 'America/Jamaica';
const STATUSES = ['draft', 'pending', 'approved', 'rejected', 'sent', 'paid', 'void'];
const DDL = `
CREATE TABLE IF NOT EXISTS petty_vouchers (
  id             SERIAL PRIMARY KEY,
  number         TEXT UNIQUE,
  status         TEXT NOT NULL DEFAULT 'draft',
  voucher_date   DATE NOT NULL DEFAULT ((NOW() AT TIME ZONE 'America/Jamaica')::date),
  payee_name     TEXT NOT NULL,
  payee_address  TEXT,
  payee_phone    TEXT,
  payee_email    TEXT,
  reference      TEXT,
  purpose        TEXT,
  total          NUMERIC(14,2) NOT NULL DEFAULT 0,
  prepared_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  approver_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  submitted_at   TIMESTAMPTZ,
  approved_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  approved_at    TIMESTAMPTZ,
  approval_note  TEXT,
  rejected_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  rejected_at    TIMESTAMPTZ,
  reject_reason  TEXT,
  pay_via        TEXT,
  task_id        INTEGER,
  movement_id    INTEGER,
  payout_id      INTEGER,
  fund_id        INTEGER,
  session_id     INTEGER,
  paid_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  paid_at        TIMESTAMPTZ,
  voided_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  voided_at      TIMESTAMPTZ,
  void_reason    TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_petty_vouchers_status ON petty_vouchers (status, created_at);
CREATE INDEX IF NOT EXISTS ix_petty_vouchers_task ON petty_vouchers (task_id);
CREATE INDEX IF NOT EXISTS ix_petty_vouchers_payout ON petty_vouchers (payout_id);
CREATE TABLE IF NOT EXISTS petty_voucher_lines (
  id           SERIAL PRIMARY KEY,
  voucher_id   INTEGER NOT NULL REFERENCES petty_vouchers(id) ON DELETE CASCADE,
  line_no      INTEGER NOT NULL DEFAULT 1,
  qty          NUMERIC(12,3) NOT NULL DEFAULT 1,
  detail       TEXT NOT NULL,
  unit_amount  NUMERIC(14,2) NOT NULL DEFAULT 0,
  amount       NUMERIC(14,2) NOT NULL DEFAULT 0,
  account_id   INTEGER REFERENCES gl_accounts(id)
);
CREATE INDEX IF NOT EXISTS ix_petty_voucher_lines_v ON petty_voucher_lines (voucher_id);
CREATE TABLE IF NOT EXISTS petty_voucher_comments (
  id          SERIAL PRIMARY KEY,
  voucher_id  INTEGER NOT NULL REFERENCES petty_vouchers(id) ON DELETE CASCADE,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS petty_voucher_events (
  id          SERIAL PRIMARY KEY,
  voucher_id  INTEGER NOT NULL REFERENCES petty_vouchers(id) ON DELETE CASCADE,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  detail      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_petty_voucher_events_v ON petty_voucher_events (voucher_id);
ALTER TABLE till_tasks ADD COLUMN IF NOT EXISTS voucher_id INTEGER;
`;

// ---- amount in words (Jamaican dollars) ------------------------------------
const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen',
  'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
function under1000(n) {
  const h = Math.floor(n / 100), r = n % 100, out = [];
  if (h) out.push(ONES[h] + ' hundred');
  if (r) out.push(r < 20 ? ONES[r] : TENS[Math.floor(r / 10)] + (r % 10 ? '-' + ONES[r % 10] : ''));
  return out.join(' and ');
}
function amountWords(v) {
  const cents = Math.round(Math.abs(Number(v) || 0) * 100);
  let d = Math.floor(cents / 100);
  const c = cents % 100;
  if (d === 0) return 'Zero dollars and ' + String(c).padStart(2, '0') + '/100';
  const parts = [];
  for (const [size, name] of [[1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand'], [1, '']]) {
    const k = Math.floor(d / size);
    if (k) { parts.push(under1000(k) + (name ? ' ' + name : '')); d -= k * size; }
  }
  const s = parts.join(' ') + ' dollar' + (Math.floor(cents / 100) === 1 ? '' : 's') + ' and ' + String(c).padStart(2, '0') + '/100';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function register(app, deps) {
  const { query, getPool, requireAdmin, userCan } = deps;
  const notice = deps.notice || (async () => {});
  const mailer = deps.mailer || null;
  const permState = deps.permState || null;

  const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
  const t = (v, max) => { const s = String(v == null ? '' : v).trim(); return s ? s.slice(0, max) : null; };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (v) => 'J$' + r2(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  function httpError(status, msg) { const e = new Error(msg); e.status = status; e.publicMessage = msg; return e; }
  function fail(res, e) { const s = e.status || 500; if (s >= 500) console.error('[petty-voucher]', e); res.status(s).json({ error: e.publicMessage || e.message }); }
  const me = (req) => req.session.userId;

  let readyP = null;
  function ready() {
    if (!readyP) readyP = (async () => {
      const c = await getPool().connect();
      try {
        await c.query(`SELECT pg_advisory_lock(hashtext('vision.pettyvoucher.ddl'))`);
        try {
          await c.query(`SET lock_timeout = '5s'`);
          await c.query(DDL);
        } finally {
          await c.query(`RESET lock_timeout`).catch(() => {});
          await c.query(`SELECT pg_advisory_unlock(hashtext('vision.pettyvoucher.ddl'))`);
        }
      } finally { c.release(); }
    })().catch((e) => { readyP = null; throw e; });
    return readyP;
  }
  async function tx(fn) {
    const c = await getPool().connect();
    try { await c.query('BEGIN'); const out = await fn(c); await c.query('COMMIT'); return out; }
    catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} throw e; }
    finally { c.release(); }
  }

  // ---- who may do what ----------------------------------------------------
  async function caps(req) {
    let full = false;
    if (permState) { try { full = !!(await permState(me(req))).full; } catch (_) {} }
    const c = async (k) => full || (await userCan(req, k));
    const out = {
      full,
      prepare: await c('petty.voucher'),
      approve: await c('petty.approve'),
      send: await c('cashier.send_payout'),
      manage: await c('cashier.manage'),
      till: (await c('cashier.access')) || (await c('pos.finalise_invoice')),
    };
    out.view_all = out.approve || out.manage;
    out.fund = out.approve || out.manage;
    return out;
  }
  const gate = [requireAdmin, async (req, res, next) => {
    try {
      const k = await caps(req);
      if (!(k.prepare || k.approve || k.manage || k.till)) return res.status(403).json({ error: 'Your account is not allowed to use petty cash vouchers.' });
      req.pv = k; next();
    } catch (e) { fail(res, e); }
  }];
  async function event(q, id, uid, action, detail) {
    await q(`INSERT INTO petty_voucher_events (voucher_id, user_id, action, detail) VALUES ($1, $2, $3, $4)`, [id, uid || null, action, detail ? String(detail).slice(0, 500) : null]);
  }
  async function nameOf(id) {
    if (!id) return null;
    const { rows } = await query(`SELECT COALESCE(NULLIF(name, ''), email) AS n FROM users WHERE id = $1`, [id]);
    return rows[0] ? rows[0].n : null;
  }
  async function shop() {
    try { const { rows } = await query(`SELECT company_name, address, phone, email, logo_url FROM shop_settings ORDER BY id LIMIT 1`); if (rows[0]) return rows[0]; } catch (_) {}
    return { company_name: 'Morty\'s Auto Parts', address: '', phone: '', email: '', logo_url: null };
  }
  // People who can approve: full access, or petty.approve granted.
  async function approvers() {
    const { rows } = await query(`SELECT id, COALESCE(NULLIF(name, ''), email) AS name, email, admin_role FROM users WHERE is_admin AND NOT COALESCE(disabled, false) ORDER BY name`);
    const out = [];
    for (const u of rows) {
      let ok = false;
      if (permState) { try { const st = await permState(u.id); ok = st.full || st.perms['petty.approve'] === true; } catch (_) {} }
      if (ok) out.push({ id: u.id, name: u.name, email: u.email, role: u.admin_role });
    }
    return out;
  }

  // A voucher sent to the till follows its till task: paid when the cashier
  // pays it, back to approved when the task is taken back.
  async function sync() {
    const { rows: paid } = await query(
      `UPDATE petty_vouchers v SET status = 'paid', movement_id = t.movement_id, paid_by = t.done_by, paid_at = t.done_at, session_id = t.session_id, updated_at = NOW()
         FROM till_tasks t WHERE t.id = v.task_id AND v.status = 'sent' AND t.status = 'done' RETURNING v.id, v.number, v.prepared_by, v.approved_by, v.total, t.done_by`);
    for (const p of paid) {
      await event(query, p.id, p.done_by, 'paid', 'Paid from the drawer at the till');
      await notice([p.prepared_by, p.approved_by].filter((x) => x && x !== p.done_by), { kind: 'petty', title: 'Voucher ' + p.number + ' paid', body: money(p.total) + ' paid at the till by ' + ((await nameOf(p.done_by)) || 'a cashier') + '.', link: '/petty-voucher.html#v=' + p.id }).catch(() => {});
    }
    const { rows: back } = await query(
      `UPDATE petty_vouchers v SET status = 'approved', task_id = NULL, pay_via = NULL, updated_at = NOW()
         FROM till_tasks t WHERE t.id = v.task_id AND v.status = 'sent' AND t.status = 'cancelled' RETURNING v.id, t.cancelled_by, t.cancel_reason`);
    for (const b of back) await event(query, b.id, b.cancelled_by, 'taken_back', 'Taken back from the till' + (b.cancel_reason ? ': ' + b.cancel_reason : ''));
  }

  const V_COLS = `v.*, v.total::float AS total, to_char(v.voucher_date, 'YYYY-MM-DD') AS voucher_date,
      pu.name AS prepared_by_name, au.name AS approved_by_name, ru.name AS rejected_by_name, qu.name AS approver_name,
      xu.name AS paid_by_name, vu.name AS voided_by_name, f.name AS fund_name,
      t.status AS task_status, t.target_kind AS task_target_kind, tu.name AS task_target_user, ts.name AS task_target_station`;
  const V_FROM = `FROM petty_vouchers v
      LEFT JOIN users pu ON pu.id = v.prepared_by LEFT JOIN users au ON au.id = v.approved_by LEFT JOIN users ru ON ru.id = v.rejected_by
      LEFT JOIN users qu ON qu.id = v.approver_id LEFT JOIN users xu ON xu.id = v.paid_by LEFT JOIN users vu ON vu.id = v.voided_by
      LEFT JOIN petty_cash_funds f ON f.id = v.fund_id
      LEFT JOIN till_tasks t ON t.id = v.task_id LEFT JOIN users tu ON tu.id = t.target_user_id LEFT JOIN pos_stations ts ON ts.id = t.target_station_id`;

  async function load(id) {
    const { rows } = await query(`SELECT ${V_COLS} ${V_FROM} WHERE v.id = $1`, [id]);
    if (!rows[0]) throw httpError(404, 'Voucher not found');
    const v = rows[0];
    const { rows: lines } = await query(
      `SELECT l.id, l.line_no, l.qty::float AS qty, l.detail, l.unit_amount::float AS unit_amount, l.amount::float AS amount, l.account_id, a.code AS account_code, a.name AS account_name
         FROM petty_voucher_lines l LEFT JOIN gl_accounts a ON a.id = l.account_id WHERE l.voucher_id = $1 ORDER BY l.line_no, l.id`, [id]);
    const { rows: comments } = await query(
      `SELECT c.id, c.body, c.created_at, c.user_id, COALESCE(NULLIF(u.name, ''), u.email) AS user_name FROM petty_voucher_comments c LEFT JOIN users u ON u.id = c.user_id WHERE c.voucher_id = $1 ORDER BY c.id`, [id]);
    const { rows: events } = await query(
      `SELECT e.id, e.action, e.detail, e.created_at, COALESCE(NULLIF(u.name, ''), u.email) AS user_name FROM petty_voucher_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.voucher_id = $1 ORDER BY e.id`, [id]);
    v.lines = lines; v.comments = comments; v.events = events; v.amount_words = amountWords(v.total);
    return v;
  }
  function mayView(req, v) {
    const k = req.pv;
    return k.view_all || v.prepared_by === me(req) || v.approver_id === me(req) || v.approved_by === me(req) || (k.till && v.status === 'sent');
  }
  function mayEdit(req, v) {
    return ['draft', 'pending', 'rejected'].includes(v.status) && (v.prepared_by === me(req) || req.pv.approve || req.pv.manage);
  }
  async function loadFor(req, id) {
    await ready(); await sync();
    const v = await load(parseInt(id, 10) || 0);
    if (!mayView(req, v)) throw httpError(403, 'This voucher is not yours to see');
    return v;
  }

  // Lines from the form: qty x unit = amount; each needs a detail and an account.
  async function cleanLines(list) {
    if (!Array.isArray(list)) throw httpError(400, 'Add at least one line');
    const rows = list.filter((l) => l && (t(l.detail, 300) || Number(l.unit_amount)));
    if (!rows.length) throw httpError(400, 'Add at least one line');
    if (rows.length > 60) throw httpError(400, 'Up to 60 lines on one voucher');
    const { rows: accts } = await query(`SELECT id FROM gl_accounts WHERE is_active`);
    const ok = new Set(accts.map((a) => a.id));
    const { rows: dflt } = await query(`SELECT id FROM gl_accounts WHERE system_key = 'petty_expense' LIMIT 1`);
    return rows.map((l, i) => {
      const qty = Math.round((Number(l.qty === '' || l.qty == null ? 1 : l.qty)) * 1000) / 1000;
      const unit = r2(l.unit_amount);
      const detail = t(l.detail, 300);
      if (!detail) throw httpError(400, 'Line ' + (i + 1) + ': what was it for?');
      if (!(qty > 0)) throw httpError(400, 'Line ' + (i + 1) + ': quantity must be more than 0');
      if (!(unit > 0)) throw httpError(400, 'Line ' + (i + 1) + ': enter the unit amount');
      let acct = parseInt(l.account_id, 10) || null;
      if (acct && !ok.has(acct)) throw httpError(400, 'Line ' + (i + 1) + ': that account is not in the chart (or is switched off)');
      if (!acct) acct = dflt[0] ? dflt[0].id : null;
      return { line_no: i + 1, qty, detail, unit_amount: unit, amount: r2(qty * unit), account_id: acct };
    });
  }
  function head(b) {
    const h = {
      payee_name: t(b.payee_name, 160), payee_address: t(b.payee_address, 400), payee_phone: t(b.payee_phone, 40),
      payee_email: t(b.payee_email, 160), reference: t(b.reference, 120), purpose: t(b.purpose, 1000),
      voucher_date: /^\d{4}-\d{2}-\d{2}$/.test(String(b.voucher_date || '')) ? b.voucher_date : null,
    };
    if (!h.payee_name || h.payee_name.length < 2) throw httpError(400, 'Who is being paid? Enter the name.');
    if (h.payee_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(h.payee_email)) throw httpError(400, 'That email address does not look right');
    return h;
  }
  async function writeLines(c, id, lines) {
    await c.query(`DELETE FROM petty_voucher_lines WHERE voucher_id = $1`, [id]);
    for (const l of lines)
      await c.query(`INSERT INTO petty_voucher_lines (voucher_id, line_no, qty, detail, unit_amount, amount, account_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, l.line_no, l.qty, l.detail, l.unit_amount, l.amount, l.account_id]);
    return r2(lines.reduce((a, l) => a + l.amount, 0));
  }

  // ---- the page's setup ---------------------------------------------------
  app.get('/api/pv/meta', gate, async (req, res) => {
    try {
      await ready();
      const { rows: u } = await query(`SELECT id, COALESCE(NULLIF(name, ''), email) AS name FROM users WHERE id = $1`, [me(req)]);
      const { rows: accounts } = await query(
        `SELECT id, code, name, type, system_key FROM gl_accounts WHERE is_active
          ORDER BY CASE type WHEN 'expense' THEN 0 WHEN 'cogs' THEN 1 WHEN 'other_expense' THEN 2 WHEN 'asset' THEN 3 WHEN 'liability' THEN 4 ELSE 5 END, code`);
      const dflt = accounts.find((a) => a.system_key === 'petty_expense');
      // What was typed before, with the account it went to, to fill in the next one.
      const { rows: recent } = await query(
        `SELECT DISTINCT ON (lower(l.detail)) l.detail, l.account_id, l.unit_amount::float AS unit_amount FROM petty_voucher_lines l
           JOIN petty_vouchers v ON v.id = l.voucher_id WHERE v.status <> 'void' ORDER BY lower(l.detail), l.id DESC LIMIT 300`);
      const { rows: payees } = await query(
        `SELECT DISTINCT ON (lower(payee_name)) payee_name, payee_address, payee_phone, payee_email FROM petty_vouchers WHERE status <> 'void' ORDER BY lower(payee_name), id DESC LIMIT 300`);
      const { rows: cashiers } = await query(
        `SELECT DISTINCT u.id, u.name FROM users u JOIN till_sessions s ON s.user_id = u.id WHERE s.opened_at > NOW() - INTERVAL '60 days' AND NOT COALESCE(u.disabled, false) ORDER BY u.name`);
      const { rows: stations } = await query(`SELECT id, name FROM pos_stations WHERE is_active AND kind IN ('cashier', 'integrated') ORDER BY name`);
      const { rows: funds } = await query(`SELECT id, name, (balance_cents / 100.0)::float AS balance FROM petty_cash_funds WHERE is_active ORDER BY name`);
      res.json({ me: u[0] || null, can: req.pv, accounts, default_account_id: dflt ? dflt.id : null, recent, payees, approvers: await approvers(), cashiers, stations, funds, shop: await shop() });
    } catch (e) { fail(res, e); }
  });

  // ---- list ---------------------------------------------------------------
  app.get('/api/pv/vouchers', gate, async (req, res) => {
    try {
      await ready(); await sync();
      const where = [], p = [];
      const add = (sql, v) => { p.push(v); where.push(sql.replace(/\?/g, '$' + p.length)); };
      if (STATUSES.includes(req.query.status)) add('v.status = ?', req.query.status);
      else if (req.query.status === 'open') where.push(`v.status IN ('draft', 'pending', 'approved', 'rejected', 'sent')`);
      if (!req.pv.view_all || req.query.mine === '1') add('(v.prepared_by = ? OR v.approver_id = ? OR v.approved_by = ?)', me(req));
      if (req.query.waiting === '1') { add(`v.status = 'pending' AND (v.approver_id IS NULL OR v.approver_id = ?)`, me(req)); }
      const q = t(req.query.q, 60);
      if (q) add(`(v.number ILIKE '%' || ? || '%' OR v.payee_name ILIKE '%' || ? || '%' OR v.reference ILIKE '%' || ? || '%' OR EXISTS (SELECT 1 FROM petty_voucher_lines l WHERE l.voucher_id = v.id AND l.detail ILIKE '%' || ? || '%'))`, q);
      if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '')) add('v.voucher_date >= ?::date', req.query.from);
      if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '')) add('v.voucher_date <= ?::date', req.query.to);
      const { rows } = await query(
        `SELECT ${V_COLS}, (SELECT COUNT(*)::int FROM petty_voucher_lines l WHERE l.voucher_id = v.id) AS line_count,
                (SELECT COUNT(*)::int FROM petty_voucher_comments c WHERE c.voucher_id = v.id) AS comment_count
           ${V_FROM} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY (v.status = 'pending') DESC, v.id DESC LIMIT 300`, p);
      const { rows: cnt } = await query(
        `SELECT status, COUNT(*)::int AS n, COALESCE(SUM(total), 0)::float AS total FROM petty_vouchers v
          ${req.pv.view_all ? '' : 'WHERE (v.prepared_by = $1 OR v.approver_id = $1 OR v.approved_by = $1)'} GROUP BY status`, req.pv.view_all ? [] : [me(req)]);
      res.json({ vouchers: rows, counts: cnt });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/pv/vouchers/:id', gate, async (req, res) => {
    try {
      const v = await loadFor(req, req.params.id);
      const k = req.pv, mine = v.prepared_by === me(req);
      v.can = {
        edit: mayEdit(req, v),
        submit: ['draft', 'rejected', 'pending'].includes(v.status) && (mine || k.approve || k.manage),
        approve: ['draft', 'pending', 'rejected'].includes(v.status) && k.approve && (!mine || k.full),
        reject: v.status === 'pending' && k.approve && (!mine || k.full),
        recall: v.status === 'approved' && (mine || k.approve || k.manage),
        send: v.status === 'approved' && (mine || k.approve || k.send || k.manage),
        pay_here: v.status === 'approved' && k.till && (mine || k.approve || k.send || k.manage),
        pay_fund: v.status === 'approved' && k.fund,
        take_back: v.status === 'sent' && v.task_status === 'open' && (mine || k.approve || k.send || k.manage),
        void: ['draft', 'pending', 'approved', 'rejected'].includes(v.status) && (mine || k.approve || k.manage),
        own_approval_blocked: mine && k.approve && !k.full,
      };
      res.json({ voucher: v });
    } catch (e) { fail(res, e); }
  });

  // ---- create / edit ------------------------------------------------------
  app.post('/api/pv/vouchers', gate, async (req, res) => {
    try {
      await ready();
      if (!(req.pv.prepare || req.pv.approve || req.pv.manage)) throw httpError(403, 'Your account is not allowed to prepare petty cash vouchers.');
      const b = req.body || {};
      const h = head(b), lines = await cleanLines(b.lines);
      const id = await tx(async (c) => {
        const { rows } = await c.query(
          `INSERT INTO petty_vouchers (payee_name, payee_address, payee_phone, payee_email, reference, purpose, voucher_date, prepared_by)
           VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::date, (NOW() AT TIME ZONE '${TZ}')::date),$8) RETURNING id`,
          [h.payee_name, h.payee_address, h.payee_phone, h.payee_email, h.reference, h.purpose, h.voucher_date, me(req)]);
        const vid = rows[0].id;
        const total = await writeLines(c, vid, lines);
        await c.query(`UPDATE petty_vouchers SET number = 'PV-' || lpad(id::text, 6, '0'), total = $2 WHERE id = $1`, [vid, total]);
        await event(c.query.bind(c), vid, me(req), 'prepared', money(total) + ', ' + lines.length + ' line' + (lines.length === 1 ? '' : 's'));
        if (t(b.comment, 2000)) await c.query(`INSERT INTO petty_voucher_comments (voucher_id, user_id, body) VALUES ($1, $2, $3)`, [vid, me(req), t(b.comment, 2000)]);
        return vid;
      });
      res.json({ ok: true, id, voucher: await load(id) });
    } catch (e) { fail(res, e); }
  });

  app.put('/api/pv/vouchers/:id', gate, async (req, res) => {
    try {
      const v = await loadFor(req, req.params.id);
      if (!mayEdit(req, v)) throw httpError(409, v.status === 'draft' || v.status === 'pending' || v.status === 'rejected' ? 'Only the person who prepared it or an approver can change it' : 'A voucher that is ' + v.status + ' can no longer be changed' + (v.status === 'approved' ? ' (recall it first)' : ''));
      const b = req.body || {};
      const h = head(b), lines = await cleanLines(b.lines);
      await tx(async (c) => {
        const total = await writeLines(c, v.id, lines);
        await c.query(
          `UPDATE petty_vouchers SET payee_name = $2, payee_address = $3, payee_phone = $4, payee_email = $5, reference = $6, purpose = $7,
                  voucher_date = COALESCE($8::date, voucher_date), total = $9, status = CASE WHEN status = 'rejected' THEN 'draft' ELSE status END, updated_at = NOW() WHERE id = $1`,
          [v.id, h.payee_name, h.payee_address, h.payee_phone, h.payee_email, h.reference, h.purpose, h.voucher_date, total]);
        await event(c.query.bind(c), v.id, me(req), 'edited', money(total) + (r2(total) !== r2(v.total) ? ' (was ' + money(v.total) + ')' : ''));
      });
      res.json({ ok: true, voucher: await load(v.id) });
    } catch (e) { fail(res, e); }
  });

  // ---- approval -----------------------------------------------------------
  function linkOf(req, id) {
    const host = req.get('host');
    return (host ? req.protocol + '://' + host : '') + '/petty-voucher.html#v=' + id;
  }
  app.post('/api/pv/vouchers/:id/submit', gate, async (req, res) => {
    try {
      const v = await loadFor(req, req.params.id);
      if (!['draft', 'rejected', 'pending'].includes(v.status)) throw httpError(409, 'This voucher is already ' + v.status);
      if (!(v.prepared_by === me(req) || req.pv.approve || req.pv.manage)) throw httpError(403, 'Only the person who prepared it can send it for approval');
      const b = req.body || {};
      const list = await approvers();
      let to = [];
      const pick = parseInt(b.approver_id, 10) || null;
      if (pick) {
        const a = list.find((x) => x.id === pick);
        if (!a) throw httpError(400, 'That person cannot approve petty cash vouchers. Give them "Approve petty cash vouchers" in their permissions, or choose someone else.');
        to = [a];
      } else to = list;
      const others = to.filter((a) => a.id !== v.prepared_by);
      if (!others.length && !to.length) throw httpError(400, 'Nobody has permission to approve petty cash vouchers yet');
      await query(`UPDATE petty_vouchers SET status = 'pending', approver_id = $2, submitted_at = NOW(), rejected_by = NULL, rejected_at = NULL, reject_reason = NULL, updated_at = NOW() WHERE id = $1`, [v.id, pick]);
      const link = linkOf(req, v.id);
      const note = t(b.note, 500);
      const who = (await nameOf(me(req))) || 'Someone';
      const tell = (others.length ? others : to).map((a) => a.id);
      await notice(tell, { kind: 'petty', urgent: false, title: 'Approve petty cash ' + v.number + ' · ' + money(v.total), body: who + ' asks you to approve ' + money(v.total) + ' to ' + v.payee_name + (note ? '. "' + note + '"' : ''), link: '/petty-voucher.html#v=' + v.id }).catch(() => {});
      const emailed = [];
      if (b.email && mailer) {
        const s = await shop();
        for (const a of (others.length ? others : to)) {
          if (!a.email) continue;
          try {
            const r = await mailer.sendEmail({ to: a.email, subject: 'Please approve petty cash voucher ' + v.number + ' (' + money(v.total) + ')',
              html: emailShell(s, '<p>' + esc(who) + ' asks you to approve this petty cash payout.' + (note ? '</p><p><i>"' + esc(note) + '"</i>' : '') + '</p>' +
                '<p><a href="' + esc(link) + '" style="display:inline-block;background:#d62828;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:700">Open the voucher to approve</a></p>' + voucherHtml(v, s)),
              text: who + ' asks you to approve petty cash voucher ' + v.number + ' for ' + money(v.total) + ' to ' + v.payee_name + '.\nOpen: ' + link });
            emailed.push(a.email + (r && r.stubbed ? ' (not sent: email is not set up on this server)' : ''));
          } catch (e) { emailed.push(a.email + ' (failed: ' + e.message + ')'); }
        }
      }
      await event(query, v.id, me(req), 'submitted', 'Sent for approval to ' + (pick ? to[0].name : 'everyone who can approve') + (emailed.length ? '; emailed ' + emailed.join(', ') : '') + (note ? ' - ' + note : ''));
      res.json({ ok: true, link, told: tell.length, emailed, voucher: await load(v.id) });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/pv/vouchers/:id/approve', gate, async (req, res) => {
    try {
      const v = await loadFor(req, req.params.id);
      if (!req.pv.approve) throw httpError(403, 'Your account is not allowed to approve petty cash vouchers.');
      if (!['draft', 'pending', 'rejected'].includes(v.status)) throw httpError(409, 'This voucher is already ' + v.status);
      if (v.prepared_by === me(req) && !req.pv.full) throw httpError(403, 'You prepared this voucher, so someone else has to approve it.');
      const note = t((req.body || {}).note, 500);
      const { rowCount } = await query(`UPDATE petty_vouchers SET status = 'approved', approved_by = $2, approved_at = NOW(), approval_note = $3, updated_at = NOW() WHERE id = $1 AND status = $4`, [v.id, me(req), note, v.status]);
      if (!rowCount) throw httpError(409, 'It changed while you were looking. Open it again.');
      await event(query, v.id, me(req), 'approved', note);
      if (note) await query(`INSERT INTO petty_voucher_comments (voucher_id, user_id, body) VALUES ($1, $2, $3)`, [v.id, me(req), note]);
      if (v.prepared_by && v.prepared_by !== me(req))
        await notice([v.prepared_by], { kind: 'petty', title: 'Voucher ' + v.number + ' approved', body: money(v.total) + ' to ' + v.payee_name + ' approved by ' + ((await nameOf(me(req))) || 'a manager') + '. Pay it or send it to a cashier.', link: '/petty-voucher.html#v=' + v.id }).catch(() => {});
      res.json({ ok: true, voucher: await load(v.id) });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/pv/vouchers/:id/reject', gate, async (req, res) => {
    try {
      const v = await loadFor(req, req.params.id);
      if (!req.pv.approve) throw httpError(403, 'Your account is not allowed to approve petty cash vouchers.');
      if (v.status !== 'pending') throw httpError(409, 'Only a voucher waiting for approval can be turned down');
      const why = t((req.body || {}).reason, 500);
      if (!why || why.length < 3) throw httpError(400, 'Say why it is turned down');
      await query(`UPDATE petty_vouchers SET status = 'rejected', rejected_by = $2, rejected_at = NOW(), reject_reason = $3, updated_at = NOW() WHERE id = $1`, [v.id, me(req), why]);
      await event(query, v.id, me(req), 'rejected', why);
      await query(`INSERT INTO petty_voucher_comments (voucher_id, user_id, body) VALUES ($1, $2, $3)`, [v.id, me(req), 'Turned down: ' + why]);
      if (v.prepared_by && v.prepared_by !== me(req))
        await notice([v.prepared_by], { kind: 'petty', title: 'Voucher ' + v.number + ' turned down', body: why, link: '/petty-voucher.html#v=' + v.id }).catch(() => {});
      res.json({ ok: true, voucher: await load(v.id) });
    } catch (e) { fail(res, e); }
  });

  // Approved but not yet paid: back to draft to change it (approval cleared).
  app.post('/api/pv/vouchers/:id/recall', gate, async (req, res) => {
    try {
      const v = await loadFor(req, req.params.id);
      if (v.status !== 'approved') throw httpError(409, 'Only an approved voucher that is not yet paid or sent can be recalled');
      if (!(v.prepared_by === me(req) || req.pv.approve || req.pv.manage)) throw httpError(403, 'Only the person who prepared it or an approver can recall it');
      await query(`UPDATE petty_vouchers SET status = 'draft', approved_by = NULL, approved_at = NULL, approval_note = NULL, updated_at = NOW() WHERE id = $1 AND status = 'approved'`, [v.id]);
      await event(query, v.id, me(req), 'recalled', 'Back to draft; the approval was cleared');
      res.json({ ok: true, voucher: await load(v.id) });
    } catch (e) { fail(res, e); }
  });

  // ---- paying it ----------------------------------------------------------
  // To the cashiers' Due for payment (one cashier, one till, everyone, or me).
  app.post('/api/pv/vouchers/:id/send', gate, async (req, res) => {
    try {
      const v = await loadFor(req, req.params.id);
      const k = req.pv, mine = v.prepared_by === me(req);
      if (v.status !== 'approved') throw httpError(409, v.status === 'pending' || v.status === 'draft' ? 'It has to be approved before it is paid' : 'This voucher is already ' + v.status);
      const b = req.body || {};
      const kind = ['user', 'station', 'me'].includes(b.target_kind) ? b.target_kind : 'all';
      if (kind === 'me' ? !(k.till && (mine || k.approve || k.send || k.manage)) : !(mine || k.approve || k.send || k.manage)) throw httpError(403, 'Your account cannot send this voucher to the till');
      const uid = kind === 'me' ? me(req) : kind === 'user' ? parseInt(b.target_user_id, 10) : null;
      const sid = kind === 'station' ? parseInt(b.target_station_id, 10) : null;
      if (kind === 'user' && !uid) throw httpError(400, 'Choose the cashier');
      if (kind === 'station' && !sid) throw httpError(400, 'Choose the till');
      const first = v.lines[0] ? v.lines[0].detail : '';
      const reason = ('Voucher ' + v.number + ': ' + first + (v.lines.length > 1 ? ' (+' + (v.lines.length - 1) + ' more)' : '')).slice(0, 200);
      const note = ([v.reference ? 'Ref ' + v.reference : null, t(b.note, 200)].filter(Boolean).join(' · ') || null);
      const out = await tx(async (c) => {
        const { rows: lock } = await c.query(`SELECT status FROM petty_vouchers WHERE id = $1 FOR UPDATE`, [v.id]);
        if (lock[0].status !== 'approved') throw httpError(409, 'Someone else just sent or paid it');
        const { rows } = await c.query(
          `INSERT INTO till_tasks (kind, target_kind, target_user_id, target_station_id, payee, reason, amount, note, created_by, voucher_id)
           VALUES ('payout', $1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
          [kind === 'me' ? 'user' : kind, uid, sid, v.payee_name.slice(0, 120), reason, v.total, note, v.approved_by || me(req), v.id]);
        await c.query(`UPDATE petty_vouchers SET status = 'sent', pay_via = 'drawer', task_id = $2, updated_at = NOW() WHERE id = $1`, [v.id, rows[0].id]);
        return rows[0].id;
      });
      let label = 'everyone at the tills';
      if (kind === 'me') label = 'my own drawer';
      else if (kind === 'user') label = (await nameOf(uid)) || 'a cashier';
      else if (kind === 'station') { const { rows } = await query(`SELECT name FROM pos_stations WHERE id = $1`, [sid]); label = rows[0] ? rows[0].name : 'a till'; }
      await event(query, v.id, me(req), 'sent', 'Sent to ' + label + ' to pay from the drawer');
      if (kind === 'user' && uid !== me(req))
        await notice([uid], { kind: 'petty', title: 'Payout to make: ' + money(v.total), body: 'Voucher ' + v.number + ' to ' + v.payee_name + ' is in your Due for payment.', link: '/admin.html#tab=cashier' }).catch(() => {});
      res.json({ ok: true, task_id: out, voucher: await load(v.id) });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/pv/vouchers/:id/take-back', gate, async (req, res) => {
    try {
      const v = await loadFor(req, req.params.id);
      const k = req.pv;
      if (v.status !== 'sent' || !v.task_id) throw httpError(409, 'It is not waiting at the till');
      if (!(v.prepared_by === me(req) || k.approve || k.send || k.manage)) throw httpError(403, 'Your account cannot take this back');
      const why = t((req.body || {}).reason, 300) || 'Taken back from the voucher';
      const { rowCount } = await query(`UPDATE till_tasks SET status = 'cancelled', cancelled_by = $2, cancelled_at = NOW(), cancel_reason = $3 WHERE id = $1 AND status = 'open'`, [v.task_id, me(req), why]);
      if (!rowCount) { await sync(); throw httpError(409, 'The cashier has already paid it'); }
      await sync();
      res.json({ ok: true, voucher: await load(v.id) });
    } catch (e) { fail(res, e); }
  });

  // Paid from a petty cash fund: a cash_payouts row (gl.js splits it by line).
  app.post('/api/pv/vouchers/:id/pay-fund', gate, async (req, res) => {
    try {
      const v = await loadFor(req, req.params.id);
      if (!req.pv.fund) throw httpError(403, 'Only an approver or a cashier manager can pay from a petty cash fund');
      if (v.status !== 'approved') throw httpError(409, 'It has to be approved (and not sent to the till) first');
      const fid = parseInt((req.body || {}).fund_id, 10) || 0;
      const cents = Math.round(Number(v.total) * 100);
      await tx(async (c) => {
        const { rows: lock } = await c.query(`SELECT status FROM petty_vouchers WHERE id = $1 FOR UPDATE`, [v.id]);
        if (lock[0].status !== 'approved') throw httpError(409, 'Someone else just sent or paid it');
        const { rows: f } = await c.query(`SELECT id, name, balance_cents FROM petty_cash_funds WHERE id = $1 AND is_active FOR UPDATE`, [fid]);
        if (!f.length) throw httpError(400, 'Choose the petty cash fund');
        if (Number(f[0].balance_cents) < cents) throw httpError(400, f[0].name + ' only has ' + money(Number(f[0].balance_cents) / 100));
        await c.query(`UPDATE petty_cash_funds SET balance_cents = balance_cents - $1 WHERE id = $2`, [cents, fid]);
        const { rows: p } = await c.query(
          `INSERT INTO cash_payouts (amount_cents, reason, paid_to, notes, source_type, fund_id, authorized_by, receipt_ref)
           VALUES ($1, $2, $3, $4, 'fund', $5, $6, $7) RETURNING id`,
          [cents, ('Voucher ' + v.number + ': ' + (v.lines[0] ? v.lines[0].detail : '') + (v.lines.length > 1 ? ' (+' + (v.lines.length - 1) + ' more)' : '')).slice(0, 200),
           v.payee_name.slice(0, 200), (v.purpose || '').slice(0, 500) || null, fid, v.approved_by || me(req), (v.reference || v.number).slice(0, 120)]);
        await c.query(`UPDATE petty_vouchers SET status = 'paid', pay_via = 'fund', fund_id = $2, payout_id = $3, paid_by = $4, paid_at = NOW(), updated_at = NOW() WHERE id = $1`, [v.id, fid, p[0].id, me(req)]);
        await event(c.query.bind(c), v.id, me(req), 'paid', 'Paid from petty cash fund ' + f[0].name + ' (payout #' + p[0].id + ')');
      });
      if (v.prepared_by && v.prepared_by !== me(req))
        await notice([v.prepared_by], { kind: 'petty', title: 'Voucher ' + v.number + ' paid', body: money(v.total) + ' paid from petty cash.', link: '/petty-voucher.html#v=' + v.id }).catch(() => {});
      res.json({ ok: true, voucher: await load(v.id) });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/pv/vouchers/:id/void', gate, async (req, res) => {
    try {
      const v = await loadFor(req, req.params.id);
      if (!['draft', 'pending', 'approved', 'rejected'].includes(v.status)) throw httpError(409, v.status === 'sent' ? 'Take it back from the till first' : 'A ' + v.status + ' voucher cannot be voided');
      if (!(v.prepared_by === me(req) || req.pv.approve || req.pv.manage)) throw httpError(403, 'Only the person who prepared it or an approver can void it');
      const why = t((req.body || {}).reason, 300);
      if (!why || why.length < 3) throw httpError(400, 'Say why it is voided');
      await query(`UPDATE petty_vouchers SET status = 'void', voided_by = $2, voided_at = NOW(), void_reason = $3, updated_at = NOW() WHERE id = $1`, [v.id, me(req), why]);
      await event(query, v.id, me(req), 'voided', why);
      res.json({ ok: true, voucher: await load(v.id) });
    } catch (e) { fail(res, e); }
  });

  // ---- comments -----------------------------------------------------------
  app.post('/api/pv/vouchers/:id/comments', gate, async (req, res) => {
    try {
      const v = await loadFor(req, req.params.id);
      const body = t((req.body || {}).body, 2000);
      if (!body) throw httpError(400, 'Write the comment');
      await query(`INSERT INTO petty_voucher_comments (voucher_id, user_id, body) VALUES ($1, $2, $3)`, [v.id, me(req), body]);
      const tell = [v.prepared_by, v.approved_by, v.approver_id].filter((x) => x && x !== me(req));
      if (tell.length) await notice(tell, { kind: 'petty', title: 'Comment on voucher ' + v.number, body: ((await nameOf(me(req))) || 'Someone') + ': ' + body.slice(0, 200), link: '/petty-voucher.html#v=' + v.id }).catch(() => {});
      res.json({ ok: true, voucher: await load(v.id) });
    } catch (e) { fail(res, e); }
  });

  // ---- email --------------------------------------------------------------
  function emailShell(s, inner) {
    return '<div style="font-family:Segoe UI,Arial,sans-serif;color:#111;max-width:760px">' + inner +
      '<p style="color:#666;font-size:12px;margin-top:18px">' + esc(s.company_name || '') + (s.phone ? ' · ' + esc(s.phone) : '') + '</p></div>';
  }
  function voucherHtml(v, s) {
    const cell = 'padding:6px 8px;border-bottom:1px solid #ddd;font-size:13px';
    return '<table style="width:100%;border-collapse:collapse;margin:10px 0;border:1px solid #ccc">' +
      '<tr><td colspan="5" style="padding:10px;background:#0b1b2b;color:#fff"><b style="font-size:16px">' + esc(s.company_name || '') + '</b><br><span style="font-size:12px">' + esc(s.address || '') + (s.phone ? ' · ' + esc(s.phone) : '') + '</span>' +
        '<span style="float:right;text-align:right"><b>PETTY CASH VOUCHER</b><br>' + esc(v.number) + ' · ' + esc(v.voucher_date) + '</span></td></tr>' +
      '<tr><td colspan="5" style="padding:8px 10px;font-size:13px">' +
        '<b>Pay to:</b> ' + esc(v.payee_name) + (v.payee_address ? '<br><b>Address:</b> ' + esc(v.payee_address).replace(/\n/g, '<br>') : '') +
        (v.payee_phone ? '<br><b>Phone:</b> ' + esc(v.payee_phone) : '') + (v.reference ? '<br><b>Reference:</b> ' + esc(v.reference) : '') +
        (v.purpose ? '<br><b>Purpose:</b> ' + esc(v.purpose) : '') + '</td></tr>' +
      '<tr style="background:#f3f4f6"><th style="' + cell + ';text-align:right">Qty</th><th style="' + cell + ';text-align:left">Detail</th><th style="' + cell + ';text-align:left">Account</th><th style="' + cell + ';text-align:right">Unit</th><th style="' + cell + ';text-align:right">Amount</th></tr>' +
      v.lines.map((l) => '<tr><td style="' + cell + ';text-align:right">' + esc(l.qty) + '</td><td style="' + cell + '">' + esc(l.detail) + '</td><td style="' + cell + ';color:#555">' + esc((l.account_code ? l.account_code + ' ' : '') + (l.account_name || '')) + '</td><td style="' + cell + ';text-align:right">' + money(l.unit_amount) + '</td><td style="' + cell + ';text-align:right">' + money(l.amount) + '</td></tr>').join('') +
      '<tr><td colspan="4" style="' + cell + ';text-align:right"><b>Total</b></td><td style="' + cell + ';text-align:right"><b>' + money(v.total) + '</b></td></tr>' +
      '<tr><td colspan="5" style="padding:6px 10px;font-size:12px;color:#444"><i>' + esc(v.amount_words) + '</i></td></tr>' +
      '<tr><td colspan="5" style="padding:8px 10px;font-size:13px">' +
        '<b>Prepared by:</b> ' + esc(v.prepared_by_name || '') + ' &nbsp; <b>Approved by:</b> ' + esc(v.approved_by_name || (v.status === 'pending' ? 'waiting for approval' : '-')) + (v.approved_at ? ' (' + esc(new Date(v.approved_at).toLocaleString('en-JM', { timeZone: TZ })) + ')' : '') +
        (v.paid_at ? '<br><b>Paid:</b> ' + esc(new Date(v.paid_at).toLocaleString('en-JM', { timeZone: TZ })) + (v.paid_by_name ? ' by ' + esc(v.paid_by_name) : '') : '') +
        '<br><b>Status:</b> ' + esc(v.status) + '</td></tr></table>';
  }
  app.post('/api/pv/vouchers/:id/email', gate, async (req, res) => {
    try {
      const v = await loadFor(req, req.params.id);
      const b = req.body || {};
      const to = String(b.to || '').split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
      if (!to.length) throw httpError(400, 'Enter the email address');
      if (to.length > 10) throw httpError(400, 'Up to 10 addresses');
      for (const x of to) if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x)) throw httpError(400, x + ' does not look like an email address');
      if (!mailer) throw httpError(503, 'Email is not available on this server');
      const s = await shop();
      const msg = t(b.message, 1000);
      const r = await mailer.sendEmail({ to: to.join(', '), subject: 'Petty cash voucher ' + v.number + ' · ' + money(v.total) + ' · ' + v.payee_name,
        html: emailShell(s, (msg ? '<p>' + esc(msg).replace(/\n/g, '<br>') + '</p>' : '') + voucherHtml(v, s)),
        text: (msg ? msg + '\n\n' : '') + 'Petty cash voucher ' + v.number + ' (' + v.voucher_date + ')\nPay to: ' + v.payee_name + '\n' +
          v.lines.map((l) => l.qty + ' x ' + l.detail + ' @ ' + money(l.unit_amount) + ' = ' + money(l.amount)).join('\n') + '\nTotal: ' + money(v.total) });
      const stubbed = !!(r && r.stubbed);
      await event(query, v.id, me(req), 'emailed', to.join(', ') + (stubbed ? ' (not sent: email is not set up on this server)' : ''));
      res.json({ ok: true, stubbed, voucher: await load(v.id) });
    } catch (e) { fail(res, e); }
  });

  // ---- report (Petty Cash › Report) ---------------------------------------
  // Paid vouchers in the range (by the day they were paid) by account, by how
  // they were paid and by payee; what is still waiting; every voucher dated in
  // the range; and every line for the CSV. Approvers and cashier managers see
  // everyone's; anyone else only their own.
  app.get('/api/pv/report', gate, async (req, res) => {
    try {
      await ready(); await sync();
      const D = /^\d{4}-\d{2}-\d{2}$/;
      const from = D.test(req.query.from || '') ? req.query.from : new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
      const to = D.test(req.query.to || '') ? req.query.to : new Date().toISOString().slice(0, 10);
      const fundId = parseInt(req.query.fund_id, 10) || null;
      const p = [from, to];
      let who = '';
      if (!req.pv.view_all) { p.push(me(req)); who = ` AND (v.prepared_by = $${p.length} OR v.approver_id = $${p.length} OR v.approved_by = $${p.length})`; }
      let fw = '';
      if (fundId) { p.push(fundId); fw = ` AND v.pay_via = 'fund' AND v.fund_id = $${p.length}`; }
      const paidIn = `v.status = 'paid' AND (v.paid_at AT TIME ZONE '${TZ}')::date BETWEEN $1::date AND $2::date${who}${fw}`;
      const [byAcct, byVia, byPayee, waiting, list, lines] = await Promise.all([
        query(`SELECT a.code, a.name, a.type, COUNT(*)::int AS n, COALESCE(SUM(l.amount), 0)::float AS amount
                 FROM petty_vouchers v JOIN petty_voucher_lines l ON l.voucher_id = v.id LEFT JOIN gl_accounts a ON a.id = l.account_id
                WHERE ${paidIn} GROUP BY a.code, a.name, a.type ORDER BY amount DESC`, p),
        query(`SELECT CASE WHEN v.pay_via = 'fund' THEN 'Petty cash fund' || COALESCE(' (' || f.name || ')', '') ELSE 'Cashier drawer' END AS via,
                      COUNT(*)::int AS n, COALESCE(SUM(v.total), 0)::float AS amount
                 FROM petty_vouchers v LEFT JOIN petty_cash_funds f ON f.id = v.fund_id WHERE ${paidIn} GROUP BY 1 ORDER BY amount DESC`, p),
        query(`SELECT v.payee_name AS payee, COUNT(*)::int AS n, COALESCE(SUM(v.total), 0)::float AS amount
                 FROM petty_vouchers v WHERE ${paidIn} GROUP BY 1 ORDER BY amount DESC LIMIT 15`, p),
        query(`SELECT v.status, COUNT(*)::int AS n, COALESCE(SUM(v.total), 0)::float AS amount FROM petty_vouchers v
                WHERE v.status IN ('draft', 'pending', 'approved', 'rejected', 'sent')${who.replace(/\$(\d+)/g, (m, k) => '$' + (k - 2))}
                GROUP BY v.status`, req.pv.view_all ? [] : [me(req)]),
        query(`SELECT ${V_COLS}, (SELECT COUNT(*)::int FROM petty_voucher_lines l WHERE l.voucher_id = v.id) AS line_count ${V_FROM}
                WHERE (v.voucher_date BETWEEN $1::date AND $2::date OR (v.status = 'paid' AND (v.paid_at AT TIME ZONE '${TZ}')::date BETWEEN $1::date AND $2::date))${who}${fw}
                ORDER BY v.voucher_date DESC, v.id DESC LIMIT 1000`, p),
        query(`SELECT v.number, to_char(v.voucher_date, 'YYYY-MM-DD') AS voucher_date, v.status, v.payee_name, v.payee_address, v.reference, v.purpose,
                      l.line_no, l.qty::float AS qty, l.detail, a.code AS account_code, a.name AS account_name, l.unit_amount::float AS unit_amount, l.amount::float AS amount,
                      pu.name AS prepared_by, au.name AS approved_by, to_char(v.approved_at AT TIME ZONE '${TZ}', 'YYYY-MM-DD HH24:MI') AS approved_at,
                      xu.name AS paid_by, to_char(v.paid_at AT TIME ZONE '${TZ}', 'YYYY-MM-DD HH24:MI') AS paid_at,
                      CASE WHEN v.pay_via = 'fund' THEN 'fund: ' || COALESCE(f.name, '') WHEN v.pay_via = 'drawer' THEN 'drawer' || COALESCE(', shift ' || v.session_id, '') END AS paid_from
                 FROM petty_vouchers v JOIN petty_voucher_lines l ON l.voucher_id = v.id LEFT JOIN gl_accounts a ON a.id = l.account_id
                 LEFT JOIN users pu ON pu.id = v.prepared_by LEFT JOIN users au ON au.id = v.approved_by LEFT JOIN users xu ON xu.id = v.paid_by
                 LEFT JOIN petty_cash_funds f ON f.id = v.fund_id
                WHERE (v.voucher_date BETWEEN $1::date AND $2::date OR (v.status = 'paid' AND (v.paid_at AT TIME ZONE '${TZ}')::date BETWEEN $1::date AND $2::date))${who}${fw}
                ORDER BY v.id, l.line_no LIMIT 5000`, p),
      ]);
      const paid = r2(byVia.rows.reduce((a, x) => a + x.amount, 0));
      res.json({ from, to, all: req.pv.view_all, paid_total: paid, paid_count: byVia.rows.reduce((a, x) => a + x.n, 0),
        by_account: byAcct.rows, by_via: byVia.rows, by_payee: byPayee.rows, waiting: waiting.rows, vouchers: list.rows, lines: lines.rows });
    } catch (e) { fail(res, e); }
  });

  return { ready, sync, amountWords };
}

module.exports = { register, amountWords };
