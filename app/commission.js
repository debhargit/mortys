// =============================================================================
//  Morty's Auto Parts -- Commission v2 (Phase 8.3)
//
//  Mounted by server.js:  require('./commission').register(app, deps)
//  Routes under /api/comm. Capabilities: comm.view (everyone's commission),
//  comm.rules (rules), comm.approve (splits, adjustments, statements, payout).
//  Every rep can see their own earnings at /api/comm/me.
//
//  From the moment it is switched on, each sale line is worked out ONCE and
//  stored in commission_entries, so a later rate change never rewrites what
//  someone was already owed (the old report recalculates history).
//
//  Which rate, first that applies:
//    a rule for this part;
//    the part's own commission override (products.commission_type);
//    the best-fitting other rule (supplier > category > every part; a rule
//      for this rep beats one for every rep; higher priority first);
//    the rep's default % (mechanics.commission_pct). No rate = nothing.
//  Basis: % of the line (ex GCT), % of the margin (line less cost at sale),
//  or a flat J$ per unit. Tiers pick the rate from the rep's net sales so far
//  this month. A split sale shares each line by the reps' percentages.
//
//  Paid-on: 'sale' earns at once; 'collected' holds entries as pending until
//  the sale is fully paid, and drops them if it is still unpaid after N days.
//  A void takes back unpaid commission (or claws back paid commission); a
//  return claws back the returned share. Statements gather what is earned up
//  to a date; a manager approves (the ledger accrues it) and pays (the ledger
//  moves it from Commissions Payable to cash).
// =============================================================================
'use strict';

const TZ = 'America/Jamaica';
const SPEC = { product: 4, supplier: 3, category: 2, all: 1 };

function register(app, deps) {
  const { query, getPool, requireAdmin, requireCap } = deps;
  const can = (k) => [requireAdmin, requireCap(k)];
  const n = (v) => (v == null ? 0 : Number(v));
  const r2 = (v) => Math.round(n(v) * 100) / 100;
  function httpError(status, msg) { const e = new Error(msg); e.status = status; e.publicMessage = msg; return e; }
  function fail(res, e) { const s = e.status || 500; if (s >= 500) console.error('[comm]', e); res.status(s).json({ error: e.publicMessage || e.message }); }
  async function tx(fn) {
    const c = await getPool().connect();
    try { await c.query('BEGIN'); const out = await fn(c); await c.query('COMMIT'); return out; }
    catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} throw e; }
    finally { c.release(); }
  }
  async function setting(key, dflt) {
    const { rows } = await query('SELECT value FROM warehouse_settings WHERE key = $1', [key]);
    return rows.length && rows[0].value != null ? rows[0].value : dflt;
  }
  const put = (k, v, q = query) => q(`INSERT INTO warehouse_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [k, String(v)]);

  // ------------------------------------------------------------- rates --
  async function loadRules(q) {
    const { rows } = await q(`SELECT *, to_char(starts_on, 'YYYY-MM-DD') AS starts_on, to_char(ends_on, 'YYYY-MM-DD') AS ends_on FROM commission_rules
                               WHERE is_active AND (starts_on IS NULL OR starts_on <= CURRENT_DATE + 1) AND (ends_on IS NULL OR ends_on >= CURRENT_DATE - 400)`);
    return rows;
  }
  function pickRule(rules, line, repId, day) {
    let best = null, bestKey = null;
    for (const r of rules) {
      if (r.rep_id && r.rep_id !== repId) continue;
      if (r.starts_on && day < r.starts_on) continue;
      if (r.ends_on && day > r.ends_on) continue;
      const v = String(r.scope_value || '').toLowerCase();
      const fits = r.scope === 'all' || (r.scope === 'category' && v === String(line.category || '').toLowerCase())
        || (r.scope === 'supplier' && v === String(line.supplier_id || '')) || (r.scope === 'product' && v === String(line.product_img || '').toLowerCase());
      if (!fits) continue;
      const key = [r.priority, SPEC[r.scope] || 0, r.rep_id ? 1 : 0];
      if (!best || key[0] > bestKey[0] || (key[0] === bestKey[0] && (key[1] > bestKey[1] || (key[1] === bestKey[1] && key[2] > bestKey[2])))) { best = r; bestKey = key; }
    }
    return best;
  }
  function tierRate(rule, mtd) {
    let rate = n(rule.rate);
    const tiers = Array.isArray(rule.tiers) ? rule.tiers.slice().sort((a, b) => n(a.from) - n(b.from)) : [];
    for (const t of tiers) if (mtd >= n(t.from)) rate = n(t.rate);
    return rate;
  }

  // Work out and store one sale's commission (idempotent per line and rep).
  async function computeSale(c, saleId, rules) {
    const { rows: s } = await c.query(`SELECT id, receipt_number, created_at, sales_rep_id, voided, balance_due_usd, to_char(created_at AT TIME ZONE '${TZ}', 'YYYY-MM-DD') AS day FROM pos_sales WHERE id = $1`, [saleId]);
    if (!s.length || s[0].voided || /^CN/.test(s[0].receipt_number || '')) return 0;
    const sale = s[0];
    let { rows: reps } = await c.query(`SELECT rep_id, share_pct FROM sale_reps WHERE sale_id = $1`, [saleId]);
    if (!reps.length && sale.sales_rep_id) reps = [{ rep_id: sale.sales_rep_id, share_pct: 100 }];
    if (!reps.length) return 0;
    const paidOn = await setting('comm_paid_on', 'sale');
    const pending = paidOn === 'collected' && n(sale.balance_due_usd) > 0.01;
    const { rows: lines } = await c.query(
      `SELECT i.id, i.product_img, i.description, i.qty, COALESCE(i.total_usd, 0) AS total, COALESCE(i.unit_cost, p.cost_usd, 0) AS cost,
              p.category, p.supplier_id, p.commission_type, p.commission_value
         FROM pos_sale_items i LEFT JOIN products p ON p.img = i.product_img WHERE i.sale_id = $1 AND i.qty > 0`, [saleId]);
    let made = 0;
    for (const rep of reps) {
      const { rows: m } = await c.query(`SELECT id, name, commission_pct FROM mechanics WHERE id = $1`, [rep.rep_id]);
      if (!m.length) continue;
      const { rows: mt } = await c.query(
        `SELECT COALESCE(SUM(i.total_usd), 0) AS v FROM pos_sales s2 JOIN pos_sale_items i ON i.sale_id = s2.id
          WHERE s2.sales_rep_id = $1 AND NOT COALESCE(s2.voided, false) AND s2.receipt_number NOT LIKE 'CN%'
            AND s2.created_at >= date_trunc('month', $2::timestamptz AT TIME ZONE '${TZ}') AT TIME ZONE '${TZ}' AND s2.created_at < $2`, [rep.rep_id, sale.created_at]);
      const mtd = n(mt[0].v);
      for (const l of lines) {
        const rule = pickRule(rules, l, rep.rep_id, sale.day);
        let basis, rate, ruleName;
        if (rule && !(rule.scope !== 'product' && l.commission_type)) { basis = rule.basis; rate = tierRate(rule, mtd); ruleName = rule.name; }
        else if (l.commission_type === 'none') continue;
        else if (l.commission_type === 'amount') { basis = 'flat'; rate = n(l.commission_value); ruleName = 'part override'; }
        else if (l.commission_type === 'percent') { basis = 'sale'; rate = n(l.commission_value); ruleName = 'part override'; }
        else if (n(m[0].commission_pct) > 0) { basis = 'sale'; rate = n(m[0].commission_pct); ruleName = 'rep default'; }
        else continue;
        const basisAmt = basis === 'margin' ? n(l.total) - n(l.qty) * n(l.cost) : basis === 'flat' ? n(l.qty) : n(l.total);
        const amount = r2((basis === 'flat' ? basisAmt * rate : basisAmt * rate / 100) * n(rep.share_pct) / 100);
        if (!amount) continue;
        const { rowCount } = await c.query(
          `INSERT INTO commission_entries (rep_id, sale_id, sale_item_id, kind, basis, basis_amount, rate, share_pct, amount, rule_id, rule_name, status, earned_at)
           VALUES ($1,$2,$3,'earned',$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING`,
          [rep.rep_id, saleId, l.id, basis, r2(basisAmt), rate, rep.share_pct, amount, rule ? rule.id : null, ruleName, pending ? 'pending' : 'earned', sale.created_at]);
        made += rowCount;
      }
    }
    return made;
  }

  // -------------------------------------------------------------- sweep --
  let busy = false, lastRun = null;
  async function sweep() {
    if (busy) return { busy: true };
    busy = true;
    const out = { sales: 0, entries: 0, collected: 0, lapsed: 0, voided: 0, clawbacks: 0 };
    try {
      const start = await setting('comm_start_at', null);
      if (!start) return { not_started: true };
      const rules = await loadRules(query);
      // 1. New sales, in order, after a short settle.
      const cursor = parseInt(await setting('comm_last_sale_id', '0'), 10) || 0;
      const { rows: sales } = await query(
        `SELECT id FROM pos_sales WHERE id > $1 AND created_at >= $2 AND created_at < NOW() - INTERVAL '30 seconds' ORDER BY id LIMIT 500`, [cursor, start]);
      let last = cursor;
      for (const s of sales) {
        try { out.entries += await tx((c) => computeSale(c, s.id, rules)); out.sales++; } catch (e) { console.warn('[comm] sale', s.id, e.message); }
        last = s.id;
      }
      if (last !== cursor) await put('comm_last_sale_id', last);
      // 2. Pending -> earned once the sale is paid; dropped after the unpaid limit.
      const days = parseInt(await setting('comm_unpaid_days', '90'), 10) || 90;
      out.collected = (await query(
        `UPDATE commission_entries e SET status = 'earned', note = CONCAT_WS(' · ', e.note, 'collected ' || to_char(NOW() AT TIME ZONE '${TZ}', 'YYYY-MM-DD'))
           FROM pos_sales s WHERE e.sale_id = s.id AND e.status = 'pending' AND COALESCE(s.balance_due_usd, 0) <= 0.01 AND NOT COALESCE(s.voided, false)`)).rowCount;
      out.lapsed = (await query(
        `UPDATE commission_entries SET status = 'void', note = CONCAT_WS(' · ', note, 'sale not paid within ' || $1::int || ' days')
          WHERE status = 'pending' AND earned_at < NOW() - make_interval(days => $1::int)`, [days])).rowCount;
      // 3. Voided sales: unpaid commission is cancelled, paid commission clawed back.
      out.voided = (await query(
        `UPDATE commission_entries e SET status = 'void', note = CONCAT_WS(' · ', e.note, 'sale voided')
           FROM pos_sales s WHERE e.sale_id = s.id AND s.voided AND e.kind = 'earned' AND e.status IN ('pending', 'earned')`)).rowCount;
      out.clawbacks += (await query(
        `INSERT INTO commission_entries (rep_id, sale_id, sale_item_id, kind, basis, basis_amount, rate, share_pct, amount, rule_name, status, earned_at, note)
         SELECT e.rep_id, e.sale_id, e.sale_item_id, 'clawback_void', e.basis, -e.basis_amount, e.rate, e.share_pct, -e.amount, e.rule_name, 'earned', COALESCE(s.voided_at, NOW()), 'sale ' || s.receipt_number || ' voided after commission was settled'
           FROM commission_entries e JOIN pos_sales s ON s.id = e.sale_id
          WHERE s.voided AND e.kind = 'earned' AND e.status IN ('on_statement', 'approved', 'paid')
         ON CONFLICT DO NOTHING`)).rowCount;
      // 4. Returns: the returned share of each line's commission comes back.
      out.clawbacks += (await query(
        `INSERT INTO commission_entries (rep_id, sale_id, sale_item_id, return_id, kind, basis, basis_amount, rate, share_pct, amount, rule_name, status, earned_at, note)
         SELECT e.rep_id, e.sale_id, e.sale_item_id, r.id, 'clawback_return', e.basis, -ROUND(e.basis_amount * ri.qty / NULLIF(i.qty, 0), 2), e.rate, e.share_pct,
                -ROUND(e.amount * ri.qty / NULLIF(i.qty, 0), 2), e.rule_name, CASE WHEN e.status = 'pending' THEN 'pending' ELSE 'earned' END, r.created_at,
                'return ' || r.return_number || ': ' || ri.qty || ' of ' || i.qty
           FROM pos_sale_returns r JOIN pos_sale_return_items ri ON ri.return_id = r.id JOIN pos_sale_items i ON i.id = ri.sale_item_id
           JOIN commission_entries e ON e.sale_item_id = i.id AND e.kind = 'earned' AND e.status <> 'void'
          WHERE r.created_at >= $1
         ON CONFLICT DO NOTHING`, [start])).rowCount;
    } finally { busy = false; lastRun = { at: new Date().toISOString(), ...out }; }
    return out;
  }
  const timer = setInterval(() => { sweep().catch((e) => console.warn('[comm] sweep', e.message)); }, 120000);
  if (timer.unref) timer.unref();

  // ------------------------------------------------------------ status --
  app.get('/api/comm/status', ...can('comm.view'), async (req, res) => {
    try {
      const { rows: reps } = await query(`SELECT id, name, commission_pct, user_id, is_active FROM mechanics WHERE is_active ORDER BY name`);
      res.json({ started: !!(await setting('comm_start_at', null)), start_at: await setting('comm_start_at', null), paid_on: await setting('comm_paid_on', 'sale'),
        unpaid_days: parseInt(await setting('comm_unpaid_days', '90'), 10), last_run: lastRun, reps });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/comm/start', ...can('comm.rules'), async (req, res) => {
    try {
      if (await setting('comm_start_at', null)) throw httpError(409, 'Commission tracking has already started');
      const { rows } = await query(`SELECT COALESCE(MAX(id), 0) AS m, NOW() AS now FROM pos_sales`);
      await put('comm_last_sale_id', rows[0].m);
      await put('comm_start_at', new Date(rows[0].now).toISOString());
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/comm/settings', ...can('comm.rules'), async (req, res) => {
    try {
      const b = req.body || {};
      if (b.paid_on !== undefined) { if (!['sale', 'collected'].includes(b.paid_on)) throw httpError(400, 'Use sale or collected'); await put('comm_paid_on', b.paid_on); }
      if (b.unpaid_days !== undefined) { const d = parseInt(b.unpaid_days, 10); if (!(d >= 7 && d <= 730)) throw httpError(400, 'Days must be 7 to 730'); await put('comm_unpaid_days', d); }
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/comm/run', ...can('comm.view'), async (req, res) => {
    try { res.json(await sweep()); } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------------- rules --
  app.get('/api/comm/rules', ...can('comm.view'), async (req, res) => {
    try {
      const { rows } = await query(`SELECT r.*, m.name AS rep_name FROM commission_rules r LEFT JOIN mechanics m ON m.id = r.rep_id ORDER BY r.is_active DESC, r.priority DESC, r.id`);
      const { rows: cats } = await query(`SELECT DISTINCT lower(category) AS c FROM products WHERE category IS NOT NULL AND category <> '' ORDER BY 1`);
      const { rows: sups } = await query(`SELECT id, name FROM suppliers WHERE is_active ORDER BY name`);
      res.json({ rules: rows, categories: cats.map((x) => x.c), suppliers: sups });
    } catch (e) { fail(res, e); }
  });
  function cleanRule(b) {
    const r = {};
    r.name = String(b.name || '').trim().slice(0, 80);
    if (!r.name) throw httpError(400, 'Name the rule');
    r.scope = ['all', 'category', 'supplier', 'product'].includes(b.scope) ? b.scope : 'all';
    r.scope_value = r.scope === 'all' ? null : String(b.scope_value || '').trim().toLowerCase().slice(0, 200);
    if (r.scope !== 'all' && !r.scope_value) throw httpError(400, 'Which ' + r.scope + '?');
    r.rep_id = parseInt(b.rep_id, 10) || null;
    r.basis = ['sale', 'margin', 'flat'].includes(b.basis) ? b.basis : 'sale';
    r.rate = Number(b.rate);
    if (!(r.rate >= 0) || (r.basis !== 'flat' && r.rate > 100)) throw httpError(400, r.basis === 'flat' ? 'Give the J$ per unit' : 'Rate must be 0 to 100%');
    const tiers = Array.isArray(b.tiers) ? b.tiers.map((t) => ({ from: Number(t.from), rate: Number(t.rate) })).filter((t) => t.from >= 0 && t.rate >= 0) : [];
    r.tiers = tiers.length ? JSON.stringify(tiers) : null;
    r.priority = parseInt(b.priority, 10) || 0;
    r.starts_on = /^\d{4}-\d{2}-\d{2}$/.test(b.starts_on || '') ? b.starts_on : null;
    r.ends_on = /^\d{4}-\d{2}-\d{2}$/.test(b.ends_on || '') ? b.ends_on : null;
    r.is_active = b.is_active !== false;
    return r;
  }
  app.post('/api/comm/rules', ...can('comm.rules'), async (req, res) => {
    try {
      const r = cleanRule(req.body || {});
      const { rows } = await query(
        `INSERT INTO commission_rules (name, scope, scope_value, rep_id, basis, rate, tiers, priority, starts_on, ends_on, is_active, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [r.name, r.scope, r.scope_value, r.rep_id, r.basis, r.rate, r.tiers, r.priority, r.starts_on, r.ends_on, r.is_active, req.session.userId]);
      res.json({ rule: rows[0] });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/comm/rules/:id', ...can('comm.rules'), async (req, res) => {
    try {
      const r = cleanRule(req.body || {});
      const { rows } = await query(
        `UPDATE commission_rules SET name=$2, scope=$3, scope_value=$4, rep_id=$5, basis=$6, rate=$7, tiers=$8, priority=$9, starts_on=$10, ends_on=$11, is_active=$12 WHERE id = $1 RETURNING *`,
        [req.params.id, r.name, r.scope, r.scope_value, r.rep_id, r.basis, r.rate, r.tiers, r.priority, r.starts_on, r.ends_on, r.is_active]);
      if (!rows.length) throw httpError(404, 'Rule not found');
      res.json({ rule: rows[0], note: 'Applies to sales from now on; commission already worked out is not changed.' });
    } catch (e) { fail(res, e); }
  });

  // ---------------------------------------------------------- earnings --
  const dateArg = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s || '') ? s : null);
  const RANGE = (col) => `${col} >= ($1::date)::timestamp AT TIME ZONE '${TZ}' AND ${col} < ($2::date + 1)::timestamp AT TIME ZONE '${TZ}'`;
  async function summary(from, to, repId) {
    const { rows } = await query(
      `SELECT m.id AS rep_id, m.name AS rep,
              COALESCE(SUM(e.basis_amount) FILTER (WHERE e.kind = 'earned' AND e.basis = 'sale' AND e.status <> 'void' AND ${RANGE('e.earned_at')}), 0) AS sales,
              COALESCE(SUM(e.amount) FILTER (WHERE e.kind = 'earned' AND e.status <> 'void' AND e.status <> 'pending' AND ${RANGE('e.earned_at')}), 0) AS earned,
              COALESCE(SUM(e.amount) FILTER (WHERE e.status = 'pending' AND ${RANGE('e.earned_at')}), 0) AS pending,
              COALESCE(SUM(e.amount) FILTER (WHERE e.kind LIKE 'clawback%' AND e.status <> 'void' AND ${RANGE('e.earned_at')}), 0) AS clawbacks,
              COALESCE(SUM(e.amount) FILTER (WHERE e.kind = 'adjust' AND e.status <> 'void' AND ${RANGE('e.earned_at')}), 0) AS adjustments,
              COALESCE(SUM(e.amount) FILTER (WHERE e.status IN ('earned', 'on_statement', 'approved')), 0) AS owed,
              COALESCE(SUM(e.amount) FILTER (WHERE e.status = 'earned'), 0) AS not_on_statement
         FROM mechanics m LEFT JOIN commission_entries e ON e.rep_id = m.id
        WHERE ($3::int IS NULL OR m.id = $3)
        GROUP BY m.id HAVING COUNT(e.id) > 0 OR m.is_active ORDER BY earned DESC, m.name`, [from, to, repId]);
    const { rows: paid } = await query(
      `SELECT mechanic_id, COALESCE(SUM(amount_usd), 0) AS paid FROM commission_payouts WHERE ${RANGE('created_at')} GROUP BY 1`, [from, to]);
    const pm = new Map(paid.map((p) => [p.mechanic_id, n(p.paid)]));
    return rows.map((r) => ({ ...r, sales: r2(r.sales), earned: r2(r.earned), pending: r2(r.pending), clawbacks: r2(r.clawbacks), adjustments: r2(r.adjustments),
      owed: r2(r.owed), not_on_statement: r2(r.not_on_statement), paid_in_period: r2(pm.get(r.rep_id) || 0) }));
  }
  app.get('/api/comm/summary', ...can('comm.view'), async (req, res) => {
    try {
      const from = dateArg(req.query.from), to = dateArg(req.query.to);
      if (!from || !to) throw httpError(400, 'Choose the dates');
      res.json({ reps: (await summary(from, to, null)).filter((r) => r.earned || r.pending || r.owed || r.clawbacks || r.sales) });
    } catch (e) { fail(res, e); }
  });
  async function entries(from, to, repId, status) {
    const { rows } = await query(
      `SELECT e.*, s.receipt_number, i.description AS item, i.qty AS line_qty, m.name AS rep, cs.number AS statement
         FROM commission_entries e LEFT JOIN pos_sales s ON s.id = e.sale_id LEFT JOIN pos_sale_items i ON i.id = e.sale_item_id
         LEFT JOIN mechanics m ON m.id = e.rep_id LEFT JOIN commission_statements cs ON cs.id = e.statement_id
        WHERE ${RANGE('e.earned_at')} AND ($3::int IS NULL OR e.rep_id = $3) AND ($4::text IS NULL OR e.status = $4)
        ORDER BY e.earned_at DESC, e.id DESC LIMIT 1000`, [from, to, repId, status || null]);
    return rows.map((r) => ({ ...r, amount: r2(r.amount), basis_amount: r2(r.basis_amount) }));
  }
  app.get('/api/comm/entries', ...can('comm.view'), async (req, res) => {
    try {
      const from = dateArg(req.query.from), to = dateArg(req.query.to);
      if (!from || !to) throw httpError(400, 'Choose the dates');
      res.json({ entries: await entries(from, to, parseInt(req.query.rep, 10) || null, req.query.status ? String(req.query.status) : null) });
    } catch (e) { fail(res, e); }
  });

  // A rep's own commission (any staff member linked to a rep record).
  app.get('/api/comm/me', requireAdmin, async (req, res) => {
    try {
      const { rows: m } = await query(`SELECT id, name FROM mechanics WHERE user_id = $1 AND is_active LIMIT 1`, [req.session.userId]);
      if (!m.length) return res.json({ rep: null });
      const from = dateArg(req.query.from) || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
      const to = dateArg(req.query.to) || new Date().toISOString().slice(0, 10);
      const { rows: st } = await query(`SELECT number, period_to, total, status, approved_at, paid_at FROM commission_statements WHERE rep_id = $1 ORDER BY id DESC LIMIT 24`, [m[0].id]);
      res.json({ rep: m[0], summary: (await summary(from, to, m[0].id))[0] || null, entries: await entries(from, to, m[0].id, null), statements: st });
    } catch (e) { fail(res, e); }
  });

  // -------------------------------------------------------------- splits --
  app.get('/api/comm/sale', ...can('comm.view'), async (req, res) => {
    try {
      const ref = String(req.query.receipt || '').trim();
      const { rows } = await query(`SELECT id, receipt_number, created_at, customer_name, total_usd, sales_rep_id, sales_rep_name, voided FROM pos_sales WHERE upper(receipt_number) = upper($1)`, [ref]);
      if (!rows.length) throw httpError(404, 'No sale with that receipt number');
      const s = rows[0];
      const { rows: sp } = await query(`SELECT sr.rep_id, sr.share_pct, m.name FROM sale_reps sr JOIN mechanics m ON m.id = sr.rep_id WHERE sr.sale_id = $1`, [s.id]);
      const { rows: en } = await query(`SELECT e.*, m.name AS rep, i.description AS item FROM commission_entries e JOIN mechanics m ON m.id = e.rep_id LEFT JOIN pos_sale_items i ON i.id = e.sale_item_id WHERE e.sale_id = $1 ORDER BY e.id`, [s.id]);
      res.json({ sale: s, split: sp, entries: en });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/comm/sale/:id/split', ...can('comm.approve'), async (req, res) => {
    try {
      const saleId = parseInt(req.params.id, 10) || 0;
      const reps = (Array.isArray((req.body || {}).reps) ? req.body.reps : []).map((r) => ({ rep_id: parseInt(r.rep_id, 10), share: Number(r.share_pct) })).filter((r) => r.rep_id && r.share > 0);
      if (reps.length) {
        const tot = Math.round(reps.reduce((s, r) => s + r.share, 0) * 100) / 100;
        if (tot !== 100) throw httpError(400, 'The shares must add up to 100% (now ' + tot + '%)');
        if (new Set(reps.map((r) => r.rep_id)).size !== reps.length) throw httpError(400, 'Each rep once');
      }
      const made = await tx(async (c) => {
        const { rows: settled } = await c.query(`SELECT 1 FROM commission_entries WHERE sale_id = $1 AND status IN ('on_statement', 'approved', 'paid') LIMIT 1`, [saleId]);
        if (settled.length) throw httpError(409, 'Commission on this sale is already on a statement: change it with an adjustment instead');
        await c.query(`DELETE FROM sale_reps WHERE sale_id = $1`, [saleId]);
        for (const r of reps) await c.query(`INSERT INTO sale_reps (sale_id, rep_id, share_pct, set_by) VALUES ($1,$2,$3,$4)`, [saleId, r.rep_id, r.share, req.session.userId]);
        await c.query(`DELETE FROM commission_entries WHERE sale_id = $1 AND status IN ('pending', 'earned', 'void')`, [saleId]);
        if (!(await setting('comm_start_at', null))) return 0;
        return computeSale(c, saleId, await loadRules(c.query.bind(c)));
      });
      res.json({ ok: true, entries: made });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/comm/adjust', ...can('comm.approve'), async (req, res) => {
    try {
      const b = req.body || {};
      const rep = parseInt(b.rep_id, 10), amount = r2(b.amount), note = String(b.note || '').trim().slice(0, 300);
      if (!rep || !amount) throw httpError(400, 'Choose the rep and the amount (negative to take off)');
      if (note.length < 3) throw httpError(400, 'Say why');
      const { rows } = await query(`INSERT INTO commission_entries (rep_id, kind, amount, status, earned_at, note, created_by) VALUES ($1, 'adjust', $2, 'earned', NOW(), $3, $4) RETURNING id`, [rep, amount, note, req.session.userId]);
      res.json({ id: rows[0].id });
    } catch (e) { fail(res, e); }
  });

  // ---------------------------------------------------------- statements --
  app.get('/api/comm/statements', ...can('comm.view'), async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT cs.*, m.name AS rep, a.name AS approved_by_name, p.name AS paid_by_name,
                (SELECT COUNT(*) FROM commission_entries e WHERE e.statement_id = cs.id)::int AS lines
           FROM commission_statements cs JOIN mechanics m ON m.id = cs.rep_id LEFT JOIN users a ON a.id = cs.approved_by LEFT JOIN users p ON p.id = cs.paid_by
          ORDER BY cs.id DESC LIMIT 200`);
      res.json({ statements: rows });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/comm/statements/:id', ...can('comm.view'), async (req, res) => {
    try {
      const { rows } = await query(`SELECT cs.*, m.name AS rep FROM commission_statements cs JOIN mechanics m ON m.id = cs.rep_id WHERE cs.id = $1`, [req.params.id]);
      if (!rows.length) throw httpError(404, 'Statement not found');
      const { rows: en } = await query(
        `SELECT e.*, s.receipt_number, i.description AS item FROM commission_entries e LEFT JOIN pos_sales s ON s.id = e.sale_id LEFT JOIN pos_sale_items i ON i.id = e.sale_item_id
          WHERE e.statement_id = $1 ORDER BY e.earned_at, e.id`, [req.params.id]);
      res.json({ statement: rows[0], entries: en });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/comm/statements', ...can('comm.approve'), async (req, res) => {
    try {
      const b = req.body || {};
      const rep = parseInt(b.rep_id, 10), to = dateArg(b.period_to);
      if (!rep || !to) throw httpError(400, 'Choose the rep and the date');
      const id = await tx(async (c) => {
        const { rows: t } = await c.query(
          `SELECT COUNT(*)::int AS n, COALESCE(SUM(amount), 0) AS total FROM commission_entries
            WHERE rep_id = $1 AND status = 'earned' AND statement_id IS NULL AND earned_at < ($2::date + 1)::timestamp AT TIME ZONE '${TZ}'`, [rep, to]);
        if (!t[0].n) throw httpError(409, 'Nothing earned and not yet on a statement up to that date');
        if (n(t[0].total) <= 0) throw httpError(409, 'Clawbacks are more than earnings (' + r2(t[0].total) + '): nothing is owed; they carry forward');
        const { rows } = await c.query(`INSERT INTO commission_statements (rep_id, period_to, total, note, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [rep, to, r2(t[0].total), b.note ? String(b.note).slice(0, 300) : null, req.session.userId]);
        const sid = rows[0].id;
        await c.query(`UPDATE commission_statements SET number = 'CS-' || lpad(id::text, 6, '0') WHERE id = $1`, [sid]);
        await c.query(`UPDATE commission_entries SET status = 'on_statement', statement_id = $3
                        WHERE rep_id = $1 AND status = 'earned' AND statement_id IS NULL AND earned_at < ($2::date + 1)::timestamp AT TIME ZONE '${TZ}'`, [rep, to, sid]);
        return sid;
      });
      res.json({ id });
    } catch (e) { fail(res, e); }
  });
  async function lockStatement(c, id, want) {
    const { rows } = await c.query(`SELECT * FROM commission_statements WHERE id = $1 FOR UPDATE`, [id]);
    if (!rows.length) throw httpError(404, 'Statement not found');
    if (!want.includes(rows[0].status)) throw httpError(409, 'This statement is ' + rows[0].status);
    return rows[0];
  }
  app.post('/api/comm/statements/:id/cancel', ...can('comm.approve'), async (req, res) => {
    try {
      await tx(async (c) => {
        const s = await lockStatement(c, req.params.id, ['draft']);
        await c.query(`UPDATE commission_entries SET status = 'earned', statement_id = NULL WHERE statement_id = $1`, [s.id]);
        await c.query(`UPDATE commission_statements SET status = 'cancelled' WHERE id = $1`, [s.id]);
      });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/comm/statements/:id/approve', ...can('comm.approve'), async (req, res) => {
    try {
      await tx(async (c) => {
        const s = await lockStatement(c, req.params.id, ['draft']);
        const { rows: me } = await c.query(`SELECT m.id FROM mechanics m WHERE m.user_id = $1 AND m.id = $2`, [req.session.userId, s.rep_id]);
        if (me.length) throw httpError(403, 'Someone else must approve your own commission');
        await c.query(`UPDATE commission_entries SET status = 'approved' WHERE statement_id = $1`, [s.id]);
        await c.query(`UPDATE commission_statements SET status = 'approved', approved_by = $2, approved_at = NOW() WHERE id = $1`, [s.id, req.session.userId]);
      });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/comm/statements/:id/pay', ...can('comm.approve'), async (req, res) => {
    try {
      const out = await tx(async (c) => {
        const s = await lockStatement(c, req.params.id, ['approved']);
        const { rows: p } = await c.query(`INSERT INTO commission_payouts (mechanic_id, amount_usd, notes, paid_by, statement_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [s.rep_id, s.total, 'Statement ' + s.number + ((req.body || {}).note ? ' · ' + String(req.body.note).slice(0, 200) : ''), req.session.userId, s.id]);
        await c.query(`UPDATE commission_entries SET status = 'paid' WHERE statement_id = $1`, [s.id]);
        await c.query(`UPDATE commission_statements SET status = 'paid', paid_by = $2, paid_at = NOW(), payout_id = $3 WHERE id = $1`, [s.id, req.session.userId, p[0].id]);
        return p[0].id;
      });
      res.json({ ok: true, payout_id: out });
    } catch (e) { fail(res, e); }
  });

  return { sweep };
}

module.exports = { register };
