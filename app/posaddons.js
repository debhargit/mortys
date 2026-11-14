'use strict';
// =============================================================================
//  Morty's Auto Parts -- POS add-ons on the till: petty cash and payouts,
//  the warranty register and claims, redeemable instruments, terminal presence
//
//  Mounted by server.js:  require('./posaddons').register(app, deps)
//  Ported from the D1 backend so the same admin.html screens work on the till:
//    functions/_routes/ops.js (petty cash + cash payouts), _lib/petty_cash.js,
//    functions/_routes/warranty.js, redemptions.js, admin_misc.js (presence).
//  Same URLs and the same *_usd JSON the admin UI already speaks; money is in
//  integer cents in the tables (BIGINT, so node-pg hands it back as a string:
//  every read goes through Number() or a ::float cast).
//
//  Tables in schema.sql: PETTY CASH, and POS ADD-ONS ON THE TILL.
//  Ledger: gl.js posts petty cash (petty_payout, petty_payout_void,
//  petty_advance_expensed, petty_movement) and redeemables (the sale line to
//  Redeemables Held for Operator; redemption_payout) -- nothing here posts.
// =============================================================================

const c2u = (c) => (c == null ? 0 : Number(c) / 100);
const u2c = (u) => { const n = Number(u); return Number.isFinite(n) ? Math.round(n * 100) : null; };
const today = () => new Date().toISOString().slice(0, 10);

const MOVEMENT_LABEL = {
  opening: 'Opening balance', replenishment: 'Replenishment', reconcile_adjust: 'Reconciliation adjustment',
  transfer_in: 'Transfer in', transfer_out: 'Transfer out', void_reversal: 'Payout voided', advance_repay: 'Advance repaid',
};
const CLAIM_STATUS = ['open', 'repair', 'replace', 'refund', 'denied', 'closed'];
const truthy = (v) => v === true || v === 'true' || v === '1' || v === 1;

function genRedemptionCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const part = () => Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join('');
  return `RD-${part()}-${part()}`;
}

function register(app, deps) {
  const { query, getPool, requireAdmin, requireManager, userCan, upload } = deps;
  const receiptUpload = upload ? upload.single('receipt') : (_req, _res, next) => next();

  function fail(res, e, tag) {
    const s = e.status || 500;
    if (s >= 500) console.error('[' + tag + ']', e);
    res.status(s).json({ error: e.publicMessage || e.message });
  }
  function httpError(status, msg) { const e = new Error(msg); e.status = status; e.publicMessage = msg; return e; }
  async function tx(fn) {
    const c = await getPool().connect();
    try { await c.query('BEGIN'); const out = await fn(c); await c.query('COMMIT'); return out; }
    catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} throw e; }
    finally { c.release(); }
  }
  const one = async (sql, p) => (await query(sql, p)).rows[0] || null;
  const receiptUrlOf = (req) => (req.file && req.file.filename ? '/uploads/' + req.file.filename : null);

  // ============================================================ petty cash --
  // A merged, oldest-first ledger with a running balance (port of
  // _lib/petty_cash.js fundLedger). A voided payout still shows the cash going
  // out, and its void_reversal movement brings it back -- the D1 version skipped
  // the voided payout AND added the reversal, so it ran high by every void.
  async function fundLedger(fundId, from, to) {
    const ranged = /^\d{4}-\d{2}-\d{2}$/.test(from || '') && /^\d{4}-\d{2}-\d{2}$/.test(to || '');
    const range = (col) => (ranged ? ` AND ${col}::date BETWEEN $2::date AND $3::date` : '');
    const p = ranged ? [fundId, from, to] : [fundId];
    const { rows: movements } = await query(
      `SELECT m.id, m.kind, m.delta_cents, m.source, m.ref, m.notes, m.created_at, u.name AS by_name
         FROM petty_cash_movements m LEFT JOIN users u ON u.id = m.created_by
        WHERE m.fund_id = $1${range('m.created_at')} ORDER BY m.created_at, m.id`, p);
    const { rows: payouts } = await query(
      `SELECT cp.id, cp.amount_cents, cp.reason, cp.paid_to, cp.notes, cp.created_at, cp.receipt_ref, cp.receipt_url,
              cp.is_advance, cp.advance_to, cp.advance_status, cp.voided, cat.name AS category, u.name AS by_name
         FROM cash_payouts cp
         LEFT JOIN petty_cash_categories cat ON cat.id = cp.category_id
         LEFT JOIN users u ON u.id = cp.authorized_by
        WHERE cp.fund_id = $1 AND cp.source_type = 'fund'${range('cp.created_at')} ORDER BY cp.created_at, cp.id`, p);
    const entries = [];
    for (const m of movements) {
      entries.push({ at: m.created_at, kind: m.kind, label: MOVEMENT_LABEL[m.kind] || m.kind, delta_usd: c2u(m.delta_cents),
        source: m.source || null, ref: m.ref || null, notes: m.notes || null, by_name: m.by_name || null, voided: false });
    }
    for (const x of payouts) {
      entries.push({
        at: x.created_at, kind: x.is_advance ? 'advance' : 'payout',
        label: x.is_advance ? ('Staff advance' + (x.advance_to ? ' — ' + x.advance_to : '') + (x.advance_status && x.advance_status !== 'open' ? ' (' + x.advance_status + ')' : ''))
                            : (x.category || 'Payout'),
        delta_usd: -c2u(x.amount_cents), reason: x.reason || null, paid_to: x.paid_to || null, category: x.category || null,
        receipt_ref: x.receipt_ref || null, receipt_url: x.receipt_url || null, notes: x.notes || null, by_name: x.by_name || null,
        payout_id: x.id, voided: !!x.voided, advance_status: x.advance_status || null,
      });
    }
    entries.sort((a, b) => a.at - b.at);
    let bal = 0;
    for (const e of entries) { bal += e.delta_usd; e.balance_usd = Math.round(bal * 100) / 100; }
    return entries;
  }
  // Every movement (void reversals included) less every payout from the fund:
  // a cross-check on the stored balance_cents.
  async function recomputeBalanceCents(fundId) {
    const mv = await one('SELECT COALESCE(SUM(delta_cents),0)::bigint AS s FROM petty_cash_movements WHERE fund_id = $1', [fundId]);
    const po = await one(`SELECT COALESCE(SUM(amount_cents),0)::bigint AS s FROM cash_payouts WHERE fund_id = $1 AND source_type = 'fund'`, [fundId]);
    return Number(mv.s) - Number(po.s);
  }

  // ---- expense categories ----
  app.get('/api/admin/petty-cash-categories', requireAdmin, async (req, res) => {
    try {
      const all = req.query.all === '1';
      const { rows } = await query(`SELECT id, name, is_active, sort_order FROM petty_cash_categories ${all ? '' : 'WHERE is_active'} ORDER BY sort_order, name`);
      res.json({ categories: rows });
    } catch (e) { fail(res, e, 'petty cash'); }
  });
  app.post('/api/admin/petty-cash-categories', requireManager, async (req, res) => {
    try {
      const b = req.body || {};
      const name = String(b.name || '').trim().slice(0, 80);
      if (!name) throw httpError(400, 'A name is required');
      const r = await query('INSERT INTO petty_cash_categories (name, sort_order) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING RETURNING id',
        [name, b.sort_order != null ? parseInt(b.sort_order, 10) || 0 : 99]);
      if (!r.rows.length) throw httpError(400, 'That category already exists');
      res.json({ ok: true, id: r.rows[0].id });
    } catch (e) { fail(res, e, 'petty cash'); }
  });
  app.patch('/api/admin/petty-cash-categories/:id', requireManager, async (req, res) => {
    try {
      const b = req.body || {};
      const sets = [], vals = [];
      if (b.name !== undefined) { vals.push(String(b.name).trim().slice(0, 80)); sets.push('name = $' + vals.length); }
      if (b.is_active !== undefined) { vals.push(!!b.is_active); sets.push('is_active = $' + vals.length); }
      if (b.sort_order !== undefined) { vals.push(parseInt(b.sort_order, 10) || 0); sets.push('sort_order = $' + vals.length); }
      if (!sets.length) throw httpError(400, 'Nothing to update');
      vals.push(parseInt(req.params.id, 10) || 0);
      await query(`UPDATE petty_cash_categories SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
      res.json({ ok: true });
    } catch (e) { fail(res, e, 'petty cash'); }
  });

  // ---- payouts (from a drawer session, or from a fund) ----
  app.get('/api/admin/cash-payouts', requireAdmin, async (req, res) => {
    try {
      const q = req.query, where = [], vals = [];
      const add = (sql, v) => { vals.push(v); where.push(sql.replace('?', '$' + vals.length)); };
      if (q.drawer_session_id) add('cp.drawer_session_id = ?', parseInt(q.drawer_session_id, 10) || 0);
      if (q.fund_id) add('cp.fund_id = ?', parseInt(q.fund_id, 10) || 0);
      if (q.advance_status) add('cp.advance_status = ?', String(q.advance_status));
      if (q.is_advance === '1') where.push('cp.is_advance');
      if (q.include_voided !== '1') where.push('NOT cp.voided');
      const { rows } = await query(
        `SELECT cp.id, (cp.amount_cents / 100.0)::float AS amount_usd, cp.reason, cp.paid_to, cp.notes,
                cp.source_type, cp.drawer_session_id, cp.fund_id, cp.created_at, cp.voided,
                cp.category_id, cp.receipt_ref, cp.receipt_url, cp.is_advance, cp.advance_to, cp.advance_status,
                cat.name AS category, u.name AS authorized_by_name
           FROM cash_payouts cp
           LEFT JOIN users u ON u.id = cp.authorized_by
           LEFT JOIN petty_cash_categories cat ON cat.id = cp.category_id
           ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY cp.created_at DESC LIMIT 500`, vals);
      res.json({ payouts: rows });
    } catch (e) { fail(res, e, 'cash payouts'); }
  });

  app.post('/api/admin/cash-payouts', requireManager, receiptUpload, async (req, res) => {
    try {
      const b = req.body || {};
      const amountCents = u2c(b.amount_usd || 0);
      if (!(amountCents > 0)) throw httpError(400, 'A positive amount is required');
      if (!String(b.reason || '').trim()) throw httpError(400, 'A reason is required');
      const sourceType = b.source_type === 'fund' ? 'fund' : 'drawer';
      const isAdvance = sourceType === 'fund' && truthy(b.is_advance);
      const receiptRef = b.receipt_ref ? String(b.receipt_ref).trim().slice(0, 120) : null;
      const receiptUrl = receiptUrlOf(req);
      const out = await tx(async (c) => {
        let categoryId = null, threshold = 0;
        if (!isAdvance) {
          categoryId = b.category_id ? parseInt(b.category_id, 10) : null;
          if (sourceType === 'fund' && !categoryId) throw httpError(400, 'Pick an expense category, or mark it a staff advance.');
          if (categoryId && !(await c.query('SELECT id FROM petty_cash_categories WHERE id = $1 AND is_active', [categoryId])).rows.length)
            throw httpError(400, 'Unknown category');
        }
        if (sourceType === 'drawer') {
          const { rows } = await c.query('SELECT id FROM cash_drawer_sessions WHERE id = $1 AND closed_at IS NULL', [parseInt(b.drawer_session_id, 10) || 0]);
          if (!rows.length) throw httpError(400, 'That cash drawer session is not open');
        } else {
          const { rows } = await c.query('SELECT id, balance_cents, receipt_threshold_cents FROM petty_cash_funds WHERE id = $1 AND is_active FOR UPDATE', [parseInt(b.fund_id, 10) || 0]);
          if (!rows.length) throw httpError(404, 'Petty cash fund not found');
          if (Number(rows[0].balance_cents) < amountCents)
            throw httpError(400, 'That would take the fund below zero (balance is ' + c2u(rows[0].balance_cents).toFixed(2) + ')');
          threshold = Number(rows[0].receipt_threshold_cents) || 0;
          await c.query('UPDATE petty_cash_funds SET balance_cents = balance_cents - $1 WHERE id = $2', [amountCents, rows[0].id]);
        }
        const { rows } = await c.query(
          `INSERT INTO cash_payouts (amount_cents, reason, paid_to, notes, source_type, drawer_session_id, fund_id, authorized_by,
                                     category_id, receipt_ref, receipt_url, is_advance, advance_to, advance_status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
          [amountCents, String(b.reason).trim().slice(0, 200), b.paid_to ? String(b.paid_to).trim().slice(0, 200) : null,
           b.notes ? String(b.notes).trim().slice(0, 500) : null, sourceType,
           sourceType === 'drawer' ? parseInt(b.drawer_session_id, 10) : null,
           sourceType === 'fund' ? parseInt(b.fund_id, 10) : null, req.session.userId,
           categoryId, receiptRef, receiptUrl, isAdvance,
           isAdvance ? (b.advance_to ? String(b.advance_to).trim().slice(0, 120) : null) : null,
           isAdvance ? 'open' : null]);
        return { id: rows[0].id, threshold };
      });
      const warning = out.threshold > 0 && amountCents >= out.threshold && !receiptRef && !receiptUrl ? 'A receipt is recommended for this amount.' : null;
      res.json({ ok: true, id: out.id, warning });
    } catch (e) { fail(res, e, 'cash payouts'); }
  });

  app.post('/api/admin/cash-payouts/:id/void', requireManager, async (req, res) => {
    try {
      await tx(async (c) => {
        const { rows } = await c.query('SELECT * FROM cash_payouts WHERE id = $1 FOR UPDATE', [parseInt(req.params.id, 10) || 0]);
        if (!rows.length) throw httpError(404, 'Not found');
        const p = rows[0];
        if (p.voided) throw httpError(400, 'Already voided');
        // A settled advance has already been repaid into the fund or expensed:
        // voiding it would hand the money back a second time.
        if (p.is_advance && p.advance_status !== 'open') throw httpError(400, 'This advance is already ' + p.advance_status + ' — it can no longer be voided');
        await c.query('UPDATE cash_payouts SET voided = true, voided_by = $1, voided_at = NOW() WHERE id = $2', [req.session.userId, p.id]);
        if (p.source_type === 'fund' && p.fund_id) {
          await c.query('UPDATE petty_cash_funds SET balance_cents = balance_cents + $1 WHERE id = $2', [p.amount_cents, p.fund_id]);
          await c.query(`INSERT INTO petty_cash_movements (fund_id, kind, delta_cents, ref, related_payout_id, created_by)
                         VALUES ($1, 'void_reversal', $2, $3, $4, $5)`, [p.fund_id, p.amount_cents, 'void of payout #' + p.id, p.id, req.session.userId]);
        }
      });
      res.json({ ok: true });
    } catch (e) { fail(res, e, 'cash payouts'); }
  });

  app.post('/api/admin/cash-payouts/:id/settle-advance', requireManager, receiptUpload, async (req, res) => {
    try {
      const b = req.body || {};
      await tx(async (c) => {
        const { rows } = await c.query('SELECT * FROM cash_payouts WHERE id = $1 FOR UPDATE', [parseInt(req.params.id, 10) || 0]);
        const p = rows[0];
        if (!p || !p.is_advance) throw httpError(404, 'Not a staff advance');
        if (p.voided) throw httpError(400, 'This advance was voided');
        if (p.advance_status !== 'open') throw httpError(400, 'This advance is already ' + p.advance_status);
        if (b.how === 'expense') {
          const catId = b.category_id ? parseInt(b.category_id, 10) : null;
          if (!catId) throw httpError(400, 'Pick a category to expense the advance to');
          await c.query(
            `UPDATE cash_payouts SET advance_status = 'expensed', advance_settled_at = NOW(), category_id = $1,
                    receipt_ref = COALESCE($2, receipt_ref), receipt_url = COALESCE($3, receipt_url) WHERE id = $4`,
            [catId, b.receipt_ref ? String(b.receipt_ref).trim().slice(0, 120) : null, receiptUrlOf(req), p.id]);
        } else {
          await c.query(`UPDATE cash_payouts SET advance_status = 'repaid', advance_settled_at = NOW() WHERE id = $1`, [p.id]);
          if (p.fund_id) {
            await c.query('UPDATE petty_cash_funds SET balance_cents = balance_cents + $1 WHERE id = $2', [p.amount_cents, p.fund_id]);
            await c.query(`INSERT INTO petty_cash_movements (fund_id, kind, delta_cents, ref, related_payout_id, created_by)
                           VALUES ($1, 'advance_repay', $2, $3, $4, $5)`, [p.fund_id, p.amount_cents, 'advance #' + p.id + ' repaid', p.id, req.session.userId]);
          }
        }
      });
      res.json({ ok: true });
    } catch (e) { fail(res, e, 'cash payouts'); }
  });

  // ---- funds ----
  app.get('/api/admin/petty-cash-funds', requireAdmin, async (_req, res) => {
    try {
      const { rows } = await query(
        `SELECT f.id, f.name, (f.balance_cents / 100.0)::float AS balance_usd, (f.float_cents / 100.0)::float AS float_usd,
                (f.receipt_threshold_cents / 100.0)::float AS receipt_threshold_usd, f.location, f.notes,
                f.custodian_id, f.is_active, f.created_at, f.last_reconciled_at,
                (f.float_cents > 0 AND f.balance_cents < f.float_cents) AS needs_topup, u.name AS custodian_name
           FROM petty_cash_funds f LEFT JOIN users u ON u.id = f.custodian_id
          ORDER BY f.is_active DESC, f.name`);
      res.json({ funds: rows });
    } catch (e) { fail(res, e, 'petty cash'); }
  });

  app.post('/api/admin/petty-cash-funds', requireManager, async (req, res) => {
    try {
      const b = req.body || {};
      if (!String(b.name || '').trim()) throw httpError(400, 'A name is required');
      const opening = u2c(b.opening_balance_usd || 0) || 0;
      if (opening < 0) throw httpError(400, 'The opening balance cannot be negative');
      const id = await tx(async (c) => {
        const { rows } = await c.query(
          `INSERT INTO petty_cash_funds (name, balance_cents, float_cents, receipt_threshold_cents, location, custodian_id)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [String(b.name).trim().slice(0, 120), opening, u2c(b.float_usd || 0) || 0, u2c(b.receipt_threshold_usd || 0) || 0,
           b.location ? String(b.location).trim().slice(0, 120) : null, b.custodian_id ? parseInt(b.custodian_id, 10) : null]);
        if (opening) {
          await c.query(`INSERT INTO petty_cash_movements (fund_id, kind, delta_cents, source, notes, created_by)
                         VALUES ($1, 'opening', $2, 'bank', 'Opening balance', $3)`, [rows[0].id, opening, req.session.userId]);
        }
        return rows[0].id;
      });
      res.json({ ok: true, id });
    } catch (e) { fail(res, e, 'petty cash'); }
  });

  app.patch('/api/admin/petty-cash-funds/:id', requireManager, async (req, res) => {
    try {
      const b = req.body || {};
      await tx(async (c) => {
        const { rows } = await c.query('SELECT id, balance_cents FROM petty_cash_funds WHERE id = $1 FOR UPDATE', [parseInt(req.params.id, 10) || 0]);
        if (!rows.length) throw httpError(404, 'Not found');
        const fund = rows[0], bal = Number(fund.balance_cents);
        const sets = [], vals = [];
        const set = (col, v) => { vals.push(v); sets.push(col + ' = $' + vals.length); };
        if (b.name !== undefined) set('name', String(b.name).trim().slice(0, 120));
        if (b.custodian_id !== undefined) set('custodian_id', b.custodian_id ? parseInt(b.custodian_id, 10) : null);
        if (b.float_usd !== undefined) set('float_cents', u2c(b.float_usd) || 0);
        if (b.receipt_threshold_usd !== undefined) set('receipt_threshold_cents', u2c(b.receipt_threshold_usd) || 0);
        if (b.location !== undefined) set('location', b.location ? String(b.location).trim().slice(0, 120) : null);
        if (b.notes !== undefined) set('notes', b.notes ? String(b.notes).trim().slice(0, 500) : null);
        if (b.is_active !== undefined) {
          const active = !!b.is_active;
          if (!active && bal !== 0 && !b.force)
            throw httpError(400, 'Fund balance is ' + c2u(bal).toFixed(2) + ' — reconcile it to zero, or pass force to write it off.');
          if (!active && bal !== 0) {
            await c.query(`INSERT INTO petty_cash_movements (fund_id, kind, delta_cents, notes, created_by)
                           VALUES ($1, 'reconcile_adjust', $2, 'Written off on close', $3)`, [fund.id, -bal, req.session.userId]);
            sets.push('balance_cents = 0');
          }
          set('is_active', active);
          sets.push('closed_at = ' + (active ? 'NULL' : 'NOW()'));
        }
        if (!sets.length) throw httpError(400, 'Nothing to update');
        vals.push(fund.id);
        await c.query(`UPDATE petty_cash_funds SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
      });
      res.json({ ok: true });
    } catch (e) { fail(res, e, 'petty cash'); }
  });

  app.get('/api/admin/petty-cash-funds/:id', requireAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10) || 0;
      const fund = await one(
        `SELECT f.*, (f.balance_cents / 100.0)::float AS balance_usd, (f.float_cents / 100.0)::float AS float_usd,
                (f.receipt_threshold_cents / 100.0)::float AS receipt_threshold_usd, u.name AS custodian_name
           FROM petty_cash_funds f LEFT JOIN users u ON u.id = f.custodian_id WHERE f.id = $1`, [id]);
      if (!fund) throw httpError(404, 'Not found');
      const q = req.query;
      const [ledger, advances, counts, computed] = await Promise.all([
        fundLedger(id, q.from, q.to),
        query(`SELECT cp.id, (cp.amount_cents / 100.0)::float AS amount_usd, cp.advance_to, cp.reason, cp.created_at, cp.advance_status, u.name AS authorized_by_name
                 FROM cash_payouts cp LEFT JOIN users u ON u.id = cp.authorized_by
                WHERE cp.fund_id = $1 AND cp.is_advance AND cp.advance_status = 'open' AND NOT cp.voided ORDER BY cp.created_at`, [id]),
        query(`SELECT id, (counted_cents / 100.0)::float AS counted_usd, (expected_cents / 100.0)::float AS expected_usd,
                      (variance_cents / 100.0)::float AS variance_usd, notes, created_at
                 FROM petty_cash_counts WHERE fund_id = $1 ORDER BY created_at DESC LIMIT 30`, [id]),
        recomputeBalanceCents(id),
      ]);
      fund.needs_topup = Number(fund.float_cents) > 0 && Number(fund.balance_cents) < Number(fund.float_cents);
      res.json({ fund, ledger, open_advances: advances.rows, counts: counts.rows, computed_balance_usd: computed / 100 });
    } catch (e) { fail(res, e, 'petty cash'); }
  });

  app.post('/api/admin/petty-cash-funds/:id/replenish', requireManager, async (req, res) => {
    try {
      const b = req.body || {};
      const amt = await tx(async (c) => {
        const { rows } = await c.query('SELECT id, balance_cents, float_cents FROM petty_cash_funds WHERE id = $1 AND is_active FOR UPDATE', [parseInt(req.params.id, 10) || 0]);
        if (!rows.length) throw httpError(404, 'Petty cash fund not found');
        const fund = rows[0];
        let amountCents;
        if (b.to_float) {
          amountCents = Number(fund.float_cents || 0) - Number(fund.balance_cents);
          if (amountCents <= 0) throw httpError(400, 'The fund is already at (or above) its float.');
        } else {
          amountCents = u2c(b.amount_usd || 0);
          if (!(amountCents > 0)) throw httpError(400, 'A positive amount is required');
        }
        const source = b.source === 'drawer' ? 'drawer' : 'bank';
        let sessId = null;
        if (source === 'drawer') {
          const { rows: s } = await c.query('SELECT id FROM cash_drawer_sessions WHERE id = $1 AND closed_at IS NULL', [parseInt(b.drawer_session_id, 10) || 0]);
          if (!s.length) throw httpError(400, 'That cash drawer session is not open');
          sessId = s[0].id;
          // The cash leaves the drawer: a drawer payout that the drawer close nets
          // off, and that gl.js posts Dr Petty Cash / Cr Cash Drawers.
          await c.query(`INSERT INTO cash_payouts (amount_cents, reason, source_type, drawer_session_id, fund_id, authorized_by)
                         VALUES ($1, 'Petty cash replenishment', 'drawer', $2, $3, $4)`, [amountCents, sessId, fund.id, req.session.userId]);
        }
        await c.query('UPDATE petty_cash_funds SET balance_cents = balance_cents + $1 WHERE id = $2', [amountCents, fund.id]);
        await c.query(`INSERT INTO petty_cash_movements (fund_id, kind, delta_cents, source, drawer_session_id, notes, created_by)
                       VALUES ($1, 'replenishment', $2, $3, $4, $5, $6)`,
          [fund.id, amountCents, source, sessId, b.notes ? String(b.notes).slice(0, 300) : null, req.session.userId]);
        return amountCents;
      });
      res.json({ ok: true, amount_usd: amt / 100 });
    } catch (e) { fail(res, e, 'petty cash'); }
  });

  app.post('/api/admin/petty-cash-funds/:id/reconcile', requireManager, async (req, res) => {
    try {
      const b = req.body || {};
      const countedCents = b.counted_usd === '' || b.counted_usd == null ? null : u2c(b.counted_usd);
      if (countedCents == null || countedCents < 0) throw httpError(400, 'Enter the counted amount');
      const out = await tx(async (c) => {
        const { rows } = await c.query('SELECT id, balance_cents FROM petty_cash_funds WHERE id = $1 AND is_active FOR UPDATE', [parseInt(req.params.id, 10) || 0]);
        if (!rows.length) throw httpError(404, 'Petty cash fund not found');
        const expected = Number(rows[0].balance_cents), variance = countedCents - expected;
        await c.query(`INSERT INTO petty_cash_counts (fund_id, counted_cents, expected_cents, variance_cents, notes, counted_by) VALUES ($1,$2,$3,$4,$5,$6)`,
          [rows[0].id, countedCents, expected, variance, b.notes ? String(b.notes).slice(0, 300) : null, req.session.userId]);
        await c.query('UPDATE petty_cash_funds SET balance_cents = $1, last_reconciled_at = NOW() WHERE id = $2', [countedCents, rows[0].id]);
        if (variance !== 0) {
          await c.query(`INSERT INTO petty_cash_movements (fund_id, kind, delta_cents, notes, created_by) VALUES ($1, 'reconcile_adjust', $2, $3, $4)`,
            [rows[0].id, variance, 'Count ' + (variance < 0 ? 'short' : 'over') + ' by ' + Math.abs(variance / 100).toFixed(2), req.session.userId]);
        }
        return { expected, variance };
      });
      res.json({ ok: true, expected_usd: out.expected / 100, counted_usd: countedCents / 100, variance_usd: out.variance / 100 });
    } catch (e) { fail(res, e, 'petty cash'); }
  });

  app.post('/api/admin/petty-cash-funds/:id/transfer', requireManager, async (req, res) => {
    try {
      const b = req.body || {};
      const id = parseInt(req.params.id, 10) || 0, toId = parseInt(b.to_fund_id, 10) || 0;
      const amountCents = u2c(b.amount_usd || 0);
      if (!(amountCents > 0)) throw httpError(400, 'A positive amount is required');
      if (!toId || toId === id) throw httpError(400, 'Pick a different destination fund');
      await tx(async (c) => {
        const { rows } = await c.query('SELECT id, balance_cents FROM petty_cash_funds WHERE id = ANY($1::int[]) AND is_active ORDER BY id FOR UPDATE', [[id, toId]]);
        const src = rows.find((r) => r.id === id), dst = rows.find((r) => r.id === toId);
        if (!src || !dst) throw httpError(404, 'Fund not found');
        if (Number(src.balance_cents) < amountCents) throw httpError(400, 'The source fund only has ' + c2u(src.balance_cents).toFixed(2));
        const note = b.notes ? String(b.notes).slice(0, 300) : null;
        await c.query('UPDATE petty_cash_funds SET balance_cents = balance_cents - $1 WHERE id = $2', [amountCents, id]);
        await c.query('UPDATE petty_cash_funds SET balance_cents = balance_cents + $1 WHERE id = $2', [amountCents, toId]);
        await c.query(`INSERT INTO petty_cash_movements (fund_id, kind, delta_cents, source, related_fund_id, notes, created_by)
                       VALUES ($1, 'transfer_out', $2, 'fund', $3, $4, $5), ($3, 'transfer_in', $6, 'fund', $1, $4, $5)`,
          [id, -amountCents, toId, note, req.session.userId, amountCents]);
      });
      res.json({ ok: true });
    } catch (e) { fail(res, e, 'petty cash'); }
  });

  // ---- petty cash report (for accounting) ----
  app.get('/api/admin/petty-cash-report', requireAdmin, async (req, res) => {
    try {
      const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
      const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : today();
      const fundId = req.query.fund_id ? parseInt(req.query.fund_id, 10) || 0 : null;
      const fw = fundId ? ' AND cp.fund_id = $3' : '', mw = fundId ? ' AND fund_id = $3' : '';
      const p = fundId ? [from, to, fundId] : [from, to];
      const [byCat, byFund, repl, variance, openAdv, lines] = await Promise.all([
        query(`SELECT COALESCE(cat.name, CASE WHEN cp.reason LIKE 'Voucher PV-%' THEN 'Petty cash vouchers' ELSE 'Uncategorised' END) AS category, COUNT(*)::int AS n, (COALESCE(SUM(cp.amount_cents),0) / 100.0)::float AS spend_usd
                 FROM cash_payouts cp LEFT JOIN petty_cash_categories cat ON cat.id = cp.category_id
                WHERE cp.source_type = 'fund' AND NOT cp.voided AND (NOT cp.is_advance OR cp.advance_status = 'expensed')
                  AND cp.created_at::date BETWEEN $1::date AND $2::date${fw}
                GROUP BY 1 ORDER BY spend_usd DESC`, p),
        query(`SELECT f.name AS fund, COUNT(*)::int AS n, (COALESCE(SUM(cp.amount_cents),0) / 100.0)::float AS spend_usd
                 FROM cash_payouts cp JOIN petty_cash_funds f ON f.id = cp.fund_id
                WHERE cp.source_type = 'fund' AND NOT cp.voided AND cp.created_at::date BETWEEN $1::date AND $2::date${fw}
                GROUP BY f.name ORDER BY spend_usd DESC`, p),
        one(`SELECT (COALESCE(SUM(delta_cents),0) / 100.0)::float AS s FROM petty_cash_movements
              WHERE kind = 'replenishment' AND created_at::date BETWEEN $1::date AND $2::date${mw}`, p),
        one(`SELECT (COALESCE(SUM(delta_cents),0) / 100.0)::float AS s FROM petty_cash_movements
              WHERE kind = 'reconcile_adjust' AND created_at::date BETWEEN $1::date AND $2::date${mw}`, p),
        query(`SELECT COALESCE(cp.advance_to, 'unnamed') AS advance_to, COUNT(*)::int AS count, (COALESCE(SUM(cp.amount_cents),0) / 100.0)::float AS amount_usd
                 FROM cash_payouts cp WHERE cp.is_advance AND cp.advance_status = 'open' AND NOT cp.voided${fundId ? ' AND cp.fund_id = $1' : ''}
                GROUP BY 1 ORDER BY amount_usd DESC`, fundId ? [fundId] : []),
        query(`SELECT cp.created_at, f.name AS fund, COALESCE(cat.name, CASE WHEN cp.is_advance THEN 'Staff advance' WHEN cp.reason LIKE 'Voucher PV-%' THEN 'Petty cash voucher' END) AS category,
                      cp.paid_to, cp.reason, cp.receipt_ref, (cp.amount_cents / 100.0)::float AS amount_usd,
                      cp.is_advance, cp.advance_status, cp.voided, u.name AS authorized_by
                 FROM cash_payouts cp
                 JOIN petty_cash_funds f ON f.id = cp.fund_id
                 LEFT JOIN petty_cash_categories cat ON cat.id = cp.category_id
                 LEFT JOIN users u ON u.id = cp.authorized_by
                WHERE cp.source_type = 'fund' AND cp.created_at::date BETWEEN $1::date AND $2::date${fw}
                ORDER BY cp.created_at DESC LIMIT 1000`, p),
      ]);
      const totalSpend = byCat.rows.reduce((s, x) => s + x.spend_usd, 0);
      res.json({
        from, to,
        totals: { spend_usd: Math.round(totalSpend * 100) / 100, replenishments_usd: repl.s || 0, reconcile_variance_usd: variance.s || 0 },
        by_category: byCat.rows, by_fund: byFund.rows, open_advances: openAdv.rows, lines: lines.rows,
      });
    } catch (e) { fail(res, e, 'petty cash'); }
  });

  // ============================================================== warranty --
  // WARRANTY-RULES: the register, claims (with photos), and the warranty plans
  // live in warranty.js now; the URLs are the same.
  require('./warranty').register(app, deps);

  // =========================================================== redeemables --
  const RI_COLS = `ri.id, ri.code, ri.product_img, ri.sale_id, ri.sale_item_id, ri.status,
    (ri.face_value_cents / 100.0)::float AS face_value_usd, (ri.payout_cents / 100.0)::float AS payout_usd,
    ri.sold_by, ri.redeemed_by, ri.redeemed_at, ri.notes, ri.created_at`;

  // Bulk-load real printed codes for a redeemable product as 'in_stock'; a sale
  // then assigns the next one instead of minting an RD-xxxx code.
  app.post('/api/admin/redemptions/load', requireManager, async (req, res) => {
    try {
      const b = req.body || {};
      const img = String(b.product_img || '').trim();
      const p = img ? await one('SELECT img, price_usd, is_redeemable FROM products WHERE img = $1', [img]) : null;
      if (!p) throw httpError(404, 'Product not found');
      if (!p.is_redeemable) throw httpError(400, 'That product is not a redeemable item');
      const raw = Array.isArray(b.codes) ? b.codes : String(b.codes || '').split(/[\r\n,]+/);
      const codes = [...new Set(raw.map((x) => String(x || '').trim().toUpperCase().slice(0, 60)).filter(Boolean))];
      if (!codes.length) throw httpError(400, 'No codes given');
      await query(
        `INSERT INTO redemption_instruments (code, product_img, status, face_value_cents, received_at, received_note)
         SELECT c, $2, 'in_stock', $3, NOW(), $4 FROM unnest($1::text[]) AS c ON CONFLICT (code) DO NOTHING`,
        [codes, img, u2c(p.price_usd) || 0, b.note ? String(b.note).slice(0, 200) : null]);
      const n = await one(`SELECT COUNT(*)::int AS n FROM redemption_instruments WHERE product_img = $1 AND status = 'in_stock'`, [img]);
      res.json({ ok: true, in_stock: n.n });
    } catch (e) { fail(res, e, 'redemptions'); }
  });

  app.get('/api/admin/redemptions', requireAdmin, async (req, res) => {
    try {
      const status = ['in_stock', 'sold', 'redeemed', 'void'].includes(req.query.status) ? req.query.status : null;
      const { rows } = await query(
        `SELECT ${RI_COLS}, p.name AS product_name, sb.name AS sold_by_name, rb.name AS redeemed_by_name
           FROM redemption_instruments ri
           LEFT JOIN products p ON p.img = ri.product_img
           LEFT JOIN users sb ON sb.id = ri.sold_by
           LEFT JOIN users rb ON rb.id = ri.redeemed_by
          ${status ? 'WHERE ri.status = $1' : ''}
          ORDER BY ri.created_at DESC LIMIT 500`, status ? [status] : []);
      res.json({ redemptions: rows });
    } catch (e) { fail(res, e, 'redemptions'); }
  });

  app.get('/api/admin/redemptions/:code', requireAdmin, async (req, res) => {
    try {
      const ri = await one(`SELECT ${RI_COLS} FROM redemption_instruments ri WHERE ri.code = $1`, [String(req.params.code).toUpperCase()]);
      if (!ri) throw httpError(404, 'Not found');
      const [product, sale] = await Promise.all([
        one('SELECT img, name, sku FROM products WHERE img = $1', [ri.product_img]),
        ri.sale_id ? one('SELECT id, receipt_number, created_at FROM pos_sales WHERE id = $1', [ri.sale_id]) : null,
      ]);
      res.json({ redemption: ri, product, sale });
    } catch (e) { fail(res, e, 'redemptions'); }
  });

  // A winning card paid out of the drawer: gl.js posts the payout against the
  // money held for the operator (Dr 2160 / Cr Cash Drawers).
  app.post('/api/admin/redemptions/:code/redeem', requireAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      const code = String(req.params.code).toUpperCase();
      const payoutCents = b.payout_usd != null && b.payout_usd !== '' ? u2c(b.payout_usd) : null;
      if (payoutCents != null && !(payoutCents >= 0)) throw httpError(400, 'The payout cannot be negative');
      const { rows } = await query(
        `UPDATE redemption_instruments SET status = 'redeemed', payout_cents = $1, redeemed_by = $2, redeemed_at = NOW(), notes = COALESCE($3, notes)
          WHERE code = $4 AND status = 'sold' RETURNING id`,
        [payoutCents, req.session.userId, b.notes ? String(b.notes).slice(0, 500) : null, code]);
      if (!rows.length) {
        const ri = await one('SELECT status FROM redemption_instruments WHERE code = $1', [code]);
        throw ri ? httpError(400, 'This instrument is already ' + ri.status) : httpError(404, 'Not found');
      }
      res.json({ ok: true, payout_usd: payoutCents != null ? payoutCents / 100 : null });
    } catch (e) { fail(res, e, 'redemptions'); }
  });

  app.post('/api/admin/redemptions/:code/void', requireManager, async (req, res) => {
    try {
      const b = req.body || {};
      const code = String(req.params.code).toUpperCase();
      const ri = await one('SELECT id, status FROM redemption_instruments WHERE code = $1', [code]);
      if (!ri) throw httpError(404, 'Not found');
      if (ri.status === 'redeemed') throw httpError(400, 'Already redeemed — cannot void');
      await query(`UPDATE redemption_instruments SET status = 'void', notes = COALESCE($1, notes) WHERE id = $2`,
        [b.notes ? String(b.notes).slice(0, 500) : null, ri.id]);
      res.json({ ok: true });
    } catch (e) { fail(res, e, 'redemptions'); }
  });

  // ============================================================== presence --
  // Each open admin page beats about once a minute with the terminal id it
  // keeps in localStorage; a row counts as online for ~2.5 min after its last
  // beat, and rows older than a day are pruned on write.
  async function presenceSnapshot(selfId) {
    const { rows } = await query(
      `SELECT terminal_id, label, user_name, last_seen FROM admin_presence
        WHERE last_seen >= NOW() - INTERVAL '150 seconds' ORDER BY last_seen DESC`);
    return {
      online: rows.length,
      terminals: rows.map((r) => ({ terminal_id: r.terminal_id, label: r.label || 'Terminal', user_name: r.user_name || null,
        last_seen: r.last_seen, is_self: selfId != null && r.terminal_id === selfId })),
    };
  }
  app.post('/api/admin/presence', requireAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      const tid = String(b.terminal_id || '').trim().slice(0, 64);
      if (!tid) throw httpError(400, 'terminal_id required');
      const label = String(b.label || '').trim().slice(0, 60) || null;
      const u = await one('SELECT id, name, email FROM users WHERE id = $1', [req.session.userId]);
      const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim().slice(0, 64) || null;
      const ua = String(req.headers['user-agent'] || '').slice(0, 200) || null;
      await query(
        `INSERT INTO admin_presence (terminal_id, label, user_id, user_name, ip, user_agent, first_seen, last_seen)
         VALUES ($1,$2,$3,$4,$5,$6,NOW(),NOW())
         ON CONFLICT (terminal_id) DO UPDATE SET label = COALESCE(EXCLUDED.label, admin_presence.label), user_id = EXCLUDED.user_id,
           user_name = EXCLUDED.user_name, ip = EXCLUDED.ip, user_agent = EXCLUDED.user_agent, last_seen = NOW()`,
        [tid, label, u ? u.id : null, u ? (u.name || u.email) : null, ip, ua]);
      await query(`DELETE FROM admin_presence WHERE last_seen < NOW() - INTERVAL '1 day'`);
      res.json({ ok: true, ...(await presenceSnapshot(tid)) });
    } catch (e) { fail(res, e, 'presence'); }
  });
  app.get('/api/admin/presence', requireAdmin, async (req, res) => {
    try { res.json(await presenceSnapshot(req.query.terminal_id || null)); }
    catch (e) { fail(res, e, 'presence'); }
  });
}

// --------------------------------------------------------- the sale hooks --
// Called inside posSaleHandler's transaction (client c), before any write:
// pick a pre-loaded code for every redeemable unit on the ticket, or mint one
// when the cashier may (pos.redeemable_mint). Throws a 400 when neither is
// possible, so nothing has been written yet.
async function planRedeemables(c, items, canMint) {
  const imgs = [...new Set(items.map((it) => it.product_img).filter(Boolean))];
  if (!imgs.length) return items.map(() => null);
  const { rows } = await c.query('SELECT img FROM products WHERE img = ANY($1::text[]) AND is_redeemable', [imgs]);
  const redeemable = new Set(rows.map((r) => r.img));
  const plan = items.map(() => null), taken = {};
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!redeemable.has(it.product_img)) continue;
    const units = [];
    const used = taken[it.product_img] || (taken[it.product_img] = []);
    for (let u = 0; u < Math.max(1, parseInt(it.qty, 10) || 1); u++) {
      const { rows: r } = await c.query(
        `SELECT code FROM redemption_instruments WHERE product_img = $1 AND status = 'in_stock' AND NOT (code = ANY($2::text[]))
          ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`, [it.product_img, used]);
      if (r.length) { used.push(r[0].code); units.push({ code: r[0].code, preloaded: true }); }
      else if (canMint) units.push({ code: genRedemptionCode(), preloaded: false });
      else { const e = new Error(`No "${it.description}" instruments are loaded — a manager must load them first.`); e.status = 400; throw e; }
    }
    plan[i] = units;
  }
  return plan;
}
// After the line is inserted: sell its planned codes against it.
async function sellRedeemables(c, units, { saleId, saleItemId, productImg, unitPriceUsd, userId }) {
  const codes = [];
  for (const u of units || []) {
    if (u.preloaded) {
      await c.query(`UPDATE redemption_instruments SET status = 'sold', sale_id = $1, sale_item_id = $2, face_value_cents = $3, sold_by = $4 WHERE code = $5`,
        [saleId, saleItemId, u2c(unitPriceUsd) || 0, userId, u.code]);
    } else {
      await c.query(`INSERT INTO redemption_instruments (code, product_img, sale_id, sale_item_id, face_value_cents, sold_by) VALUES ($1,$2,$3,$4,$5,$6)`,
        [u.code, productImg, saleId, saleItemId, u2c(unitPriceUsd) || 0, userId]);
    }
    codes.push(u.code);
  }
  return codes;
}
// A voided sale: pre-loaded codes go back on the shelf, minted ones are void.
async function voidSaleRedeemables(q, saleId) {
  await q(`UPDATE redemption_instruments SET status = 'in_stock', sale_id = NULL, sale_item_id = NULL, sold_by = NULL
            WHERE sale_id = $1 AND status = 'sold' AND received_at IS NOT NULL`, [saleId]);
  await q(`UPDATE redemption_instruments SET status = 'void' WHERE sale_id = $1 AND status = 'sold' AND received_at IS NULL`, [saleId]);
}

module.exports = { register, planRedeemables, sellRedeemables, voidSaleRedeemables };
