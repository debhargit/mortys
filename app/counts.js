// =============================================================================
//  Morty's Auto Parts -- Stock counts (Phase 4)
//
//  Mounted by server.js:  require('./counts').register(app, deps)
//  Routes under /api/cnt. Capabilities: count.do (count bins), count.create
//  (start counts), count.approve (see variances, post adjustments).
//
//  Flow: a count is a list of bins. A counter scans a bin label, scans every
//  part on the shelf (blind: the expected quantity is never sent to them),
//  adds a photo if useful, and finishes the bin. The bin's lines are then
//  compared with stock_by_bin as it stands at that moment. A difference over
//  the tolerance (units, or J$ at cost) sends the bin back for a recount by a
//  different person. A manager reviews and posts: each part moves by
//  (final count - system qty at finish), applied to today's quantity so sales
//  made during the count are kept. Posting is labelled 'count' in the stock
//  ledger and logged in warehouse_activity.
//
//  Cycle schedule: parts are ranked A/B/C by 12-month sales value (80/15/5);
//  A every 30 days, B 90, C 365 (settings). /cycle-due lists the bins holding
//  the most overdue parts.
// =============================================================================
'use strict';

function register(app, deps) {
  const { query, getPool, requireAdmin, requireCap, userCan, upload } = deps;
  const can = (k) => [requireAdmin, requireCap(k)];

  function httpError(status, msg) { const e = new Error(msg); e.status = status; e.publicMessage = msg; return e; }
  function fail(res, e) { const s = e.status || 500; if (s >= 500) console.error('[cnt]', e); res.status(s).json({ error: e.publicMessage || e.message }); }
  async function setting(key, dflt) {
    const { rows } = await query('SELECT value FROM warehouse_settings WHERE key = $1', [key]);
    return rows.length && rows[0].value != null ? rows[0].value : dflt;
  }
  async function tx(fn) {
    const c = await getPool().connect();
    try { await c.query('BEGIN'); const out = await fn(c); await c.query('COMMIT'); return out; }
    catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} throw e; }
    finally { c.release(); }
  }
  const cleanCode = (s) => String(s || '').trim().replace(/^(BIN|ITEM|SKU):/i, '');

  // ------------------------------------------------------- cycle schedule --
  app.get('/api/cnt/cycle-due', ...can('count.create'), async (req, res) => {
    try {
      const days = { A: +(await setting('count_cycle_days_a', '30')), B: +(await setting('count_cycle_days_b', '90')), C: +(await setting('count_cycle_days_c', '365')) };
      const limit = Math.min(parseInt(req.query.limit, 10) || 30, 200);
      const { rows } = await query(
        `WITH v AS (
           SELECT i.product_img AS img, SUM(i.total_usd) AS value
             FROM pos_sale_items i JOIN pos_sales s ON s.id = i.sale_id
            WHERE s.created_at >= NOW() - INTERVAL '365 days' AND NOT COALESCE(s.voided, false)
              AND s.receipt_number NOT LIKE 'CN%' AND i.product_img IS NOT NULL
            GROUP BY 1 HAVING SUM(i.total_usd) > 0),
         r AS (SELECT img, SUM(value) OVER (ORDER BY value DESC) / NULLIF(SUM(value) OVER (), 0) AS cum FROM v),
         cls AS (
           SELECT p.img, CASE WHEN r.cum <= 0.80 THEN 'A' WHEN r.cum <= 0.95 THEN 'B' ELSE 'C' END AS abc, p.last_counted_at
             FROM products p LEFT JOIN r ON r.img = p.img),
         due AS (
           SELECT s.bin_id, c.img, c.abc,
                  (c.last_counted_at IS NULL OR c.last_counted_at < NOW() - make_interval(days =>
                     CASE c.abc WHEN 'A' THEN $1::int WHEN 'B' THEN $2::int ELSE $3::int END)) AS overdue
             FROM stock_by_bin s JOIN cls c ON c.img = s.product_img JOIN bins b ON b.id = s.bin_id
            WHERE s.qty > 0 AND b.kind NOT IN ('unassigned', 'receiving', 'damaged') AND b.is_active)
         SELECT b.id, b.code, COUNT(*) FILTER (WHERE d.overdue)::int AS parts_due,
                COUNT(*) FILTER (WHERE d.overdue AND d.abc = 'A')::int AS a_due, COUNT(*)::int AS parts
           FROM due d JOIN bins b ON b.id = d.bin_id
          WHERE NOT EXISTS (SELECT 1 FROM bin_count_bins cb JOIN bin_counts k ON k.id = cb.count_id WHERE cb.bin_id = b.id AND k.status IN ('counting','review'))
          GROUP BY b.id, b.code HAVING COUNT(*) FILTER (WHERE d.overdue) > 0
          ORDER BY a_due DESC, parts_due DESC LIMIT $4`, [days.A, days.B, days.C, limit]);
      res.json({ cycle_days: days, bins: rows });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------------- counts --
  app.post('/api/cnt/counts', ...can('count.create'), async (req, res) => {
    try {
      const b = req.body || {};
      const codes = (Array.isArray(b.bin_codes) ? b.bin_codes : []).map(cleanCode).filter(Boolean);
      const ids = (Array.isArray(b.bin_ids) ? b.bin_ids : []).map((x) => parseInt(x, 10)).filter(Boolean);
      const id = await tx(async (c) => {
        const { rows: bins } = await c.query(
          `SELECT id, code FROM bins WHERE is_active AND kind <> 'unassigned' AND (id = ANY($1::int[]) OR upper(code) = ANY($2::text[]))`,
          [ids, codes.map((x) => x.toUpperCase())]);
        if (!bins.length) throw httpError(400, 'Choose at least one bin');
        const { rows: busy } = await c.query(
          `SELECT b.code FROM bin_count_bins cb JOIN bin_counts k ON k.id = cb.count_id JOIN bins b ON b.id = cb.bin_id
            WHERE cb.bin_id = ANY($1::int[]) AND k.status IN ('counting','review')`, [bins.map((x) => x.id)]);
        if (busy.length) throw httpError(409, 'Already in an open count: ' + busy.map((x) => x.code).join(', '));
        const { rows } = await c.query(`INSERT INTO bin_counts (kind, note, created_by) VALUES ($1, $2, $3) RETURNING id`,
          [['adhoc', 'cycle', 'full'].includes(b.kind) ? b.kind : 'adhoc', b.note || null, req.session.userId]);
        await c.query(`UPDATE bin_counts SET number = 'CNT-' || lpad(id::text, 6, '0') WHERE id = $1`, [rows[0].id]);
        for (const x of bins) await c.query('INSERT INTO bin_count_bins (count_id, bin_id) VALUES ($1, $2)', [rows[0].id, x.id]);
        return rows[0].id;
      });
      res.json({ ok: true, id });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/cnt/counts', ...can('count.do'), async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT k.id, k.number, k.kind, k.status, k.created_at, u.name AS created_by_name,
                COUNT(cb.bin_id)::int AS bins, COUNT(cb.bin_id) FILTER (WHERE cb.status IN ('counted','approved'))::int AS bins_done,
                COUNT(cb.bin_id) FILTER (WHERE cb.status = 'recount')::int AS bins_recount
           FROM bin_counts k LEFT JOIN bin_count_bins cb ON cb.count_id = k.id LEFT JOIN users u ON u.id = k.created_by
          WHERE k.status IN ('counting','review') OR k.created_at > NOW() - INTERVAL '30 days'
          GROUP BY k.id, u.name ORDER BY (k.status IN ('counting','review')) DESC, k.id DESC LIMIT 50`);
      res.json({ counts: rows });
    } catch (e) { fail(res, e); }
  });

  // Detail. Counters get bins and their own counted lines only; approvers get system quantities and variances.
  app.get('/api/cnt/counts/:id', ...can('count.do'), async (req, res) => {
    try {
      const mgr = await userCan(req, 'count.approve');
      const { rows: k } = await query(`SELECT * FROM bin_counts WHERE id = $1`, [req.params.id]);
      if (!k.length) throw httpError(404, 'Count not found');
      const { rows: bins } = await query(
        `SELECT cb.*, b.code, u.name AS counted_by_name, r.name AS recount_by_name
           FROM bin_count_bins cb JOIN bins b ON b.id = cb.bin_id LEFT JOIN users u ON u.id = cb.counted_by LEFT JOIN users r ON r.id = cb.recount_by
          WHERE cb.count_id = $1 ORDER BY b.code`, [req.params.id]);
      const { rows: lines } = await query(
        `SELECT l.id, l.bin_id, l.product_img, p.sku, p.name, l.counted_qty, l.recount_qty, l.system_qty, l.unit_cost::float AS unit_cost, l.photo, l.note
           FROM bin_count_lines l JOIN products p ON p.img = l.product_img WHERE l.count_id = $1 ORDER BY p.sku`, [req.params.id]);
      const out = lines.map((l) => {
        const final = l.recount_qty != null ? l.recount_qty : l.counted_qty;
        const x = { id: l.id, bin_id: l.bin_id, product_img: l.product_img, sku: l.sku, name: l.name, counted_qty: l.counted_qty, recount_qty: l.recount_qty, photo: l.photo };
        if (mgr && l.system_qty != null) Object.assign(x, { system_qty: l.system_qty, final_qty: final, diff: final - l.system_qty, diff_value: Math.round((final - l.system_qty) * (l.unit_cost || 0) * 100) / 100 });
        return x;
      });
      let summary = null;
      if (mgr) {
        const done = out.filter((l) => l.system_qty != null);
        summary = {
          lines: done.length, lines_exact: done.filter((l) => l.diff === 0).length,
          units_over: done.reduce((s, l) => s + Math.max(l.diff, 0), 0), units_short: done.reduce((s, l) => s + Math.min(l.diff, 0), 0),
          value: Math.round(done.reduce((s, l) => s + l.diff_value, 0) * 100) / 100,
        };
        summary.accuracy_pct = done.length ? Math.round(summary.lines_exact / done.length * 1000) / 10 : null;
      }
      res.json({ count: k[0], bins, lines: out, can_approve: mgr, summary });
    } catch (e) { fail(res, e); }
  });

  async function binState(c, countId, binId, userId) {
    const { rows } = await c.query(`SELECT cb.*, k.status AS count_status FROM bin_count_bins cb JOIN bin_counts k ON k.id = cb.count_id WHERE cb.count_id = $1 AND cb.bin_id = $2 FOR UPDATE OF cb`, [countId, binId]);
    if (!rows.length) throw httpError(404, 'That bin is not in this count');
    const s = rows[0];
    if (s.count_status !== 'counting') throw httpError(409, 'This count is ' + s.count_status);
    if (s.status === 'counted' || s.status === 'approved') throw httpError(409, 'This bin is already counted');
    if (s.status === 'recount' && s.counted_by === userId) throw httpError(409, 'A different person has to recount this bin');
    return s;
  }
  async function binByCode(code) {
    const { rows } = await query(`SELECT id, code FROM bins WHERE upper(code) = upper($1)`, [cleanCode(code)]);
    if (!rows.length) throw httpError(404, 'No bin "' + cleanCode(code) + '"');
    return rows[0];
  }

  // Scan a part into a bin (+qty). Returns only what this person has counted: never the system figure.
  app.post('/api/cnt/counts/:id/scan', ...can('count.do'), async (req, res) => {
    try {
      const b = req.body || {};
      const bin = b.bin_id ? { id: parseInt(b.bin_id, 10) } : await binByCode(b.bin_code);
      const qty = parseInt(b.qty, 10) || 1;
      const out = await tx(async (c) => {
        const st = await binState(c, req.params.id, bin.id, req.session.userId);
        const { rows: p } = await c.query(`SELECT img, sku FROM products WHERE upper(sku) = upper($1) OR upper(barcode) = upper($1) OR img = $1 LIMIT 1`, [cleanCode(b.code)]);
        if (!p.length) throw httpError(404, 'Unknown part "' + cleanCode(b.code) + '"');
        const col = st.status === 'recount' ? 'recount_qty' : 'counted_qty';
        const { rows } = await c.query(
          `INSERT INTO bin_count_lines (count_id, bin_id, product_img, ${col}) VALUES ($1, $2, $3, GREATEST($4, 0))
           ON CONFLICT (count_id, bin_id, product_img) DO UPDATE SET ${col} = GREATEST(COALESCE(bin_count_lines.${col}, 0) + $4, 0)
           RETURNING ${col} AS now`, [req.params.id, bin.id, p[0].img, qty]);
        return { sku: p[0].sku, now: rows[0].now, recount: st.status === 'recount' };
      });
      res.json(out);
    } catch (e) { fail(res, e); }
  });

  // Set a quantity by hand (e.g. 40 bolts weighed, not scanned).
  app.patch('/api/cnt/counts/:id/lines/:lineId', ...can('count.do'), async (req, res) => {
    try {
      const q = parseInt((req.body || {}).qty, 10);
      if (!(q >= 0 && q <= 100000)) throw httpError(400, 'Quantity must be 0 or more');
      await tx(async (c) => {
        const { rows } = await c.query('SELECT bin_id FROM bin_count_lines WHERE id = $1 AND count_id = $2', [req.params.lineId, req.params.id]);
        if (!rows.length) throw httpError(404, 'Line not found');
        const st = await binState(c, req.params.id, rows[0].bin_id, req.session.userId);
        await c.query(`UPDATE bin_count_lines SET ${st.status === 'recount' ? 'recount_qty' : 'counted_qty'} = $2, note = COALESCE($3, note) WHERE id = $1`,
          [req.params.lineId, q, (req.body || {}).note || null]);
      });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // What this person has scanned into a bin so far (their own numbers only).
  app.get('/api/cnt/counts/:id/bins/:binId', ...can('count.do'), async (req, res) => {
    try {
      const { rows: st } = await query(`SELECT cb.status, b.code, cb.photo FROM bin_count_bins cb JOIN bins b ON b.id = cb.bin_id WHERE cb.count_id = $1 AND cb.bin_id = $2`, [req.params.id, req.params.binId]);
      if (!st.length) throw httpError(404, 'That bin is not in this count');
      const col = st[0].status === 'recount' ? 'recount_qty' : 'counted_qty';
      const { rows } = await query(
        `SELECT l.id, p.sku, p.name, COALESCE(l.${col}, 0) AS qty FROM bin_count_lines l JOIN products p ON p.img = l.product_img
          WHERE l.count_id = $1 AND l.bin_id = $2 AND l.${col} IS NOT NULL AND l.${col} > 0 ORDER BY p.sku`,
        [req.params.id, req.params.binId]);
      res.json({ bin: st[0], lines: rows });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/cnt/counts/:id/bins/:binId/photo', ...can('count.do'), upload.single('photo'), async (req, res) => {
    try {
      if (!req.file) throw httpError(400, 'No photo');
      const url = '/uploads/' + req.file.filename;
      const { rowCount } = await query(`UPDATE bin_count_bins SET photo = $3 WHERE count_id = $1 AND bin_id = $2`, [req.params.id, req.params.binId, url]);
      if (!rowCount) throw httpError(404, 'That bin is not in this count');
      res.json({ ok: true, photo: url });
    } catch (e) { fail(res, e); }
  });

  // Finish a bin: parts on the system but not scanned count as zero; compare
  // with stock_by_bin now; over tolerance -> recount by someone else.
  app.post('/api/cnt/counts/:id/bins/:binId/finish', ...can('count.do'), async (req, res) => {
    try {
      const tolU = +(await setting('count_tolerance_units', '0'));
      const tolV = +(await setting('count_tolerance_value', '5000'));
      const result = await tx(async (c) => {
        const st = await binState(c, req.params.id, req.params.binId, req.session.userId);
        const id = req.params.id, binId = req.params.binId;
        if (st.status === 'open') {
          await c.query(
            `INSERT INTO bin_count_lines (count_id, bin_id, product_img, counted_qty)
             SELECT $1, $2, s.product_img, 0 FROM stock_by_bin s WHERE s.bin_id = $2 AND s.qty > 0
             ON CONFLICT (count_id, bin_id, product_img) DO NOTHING`, [id, binId]);
          await c.query(
            `UPDATE bin_count_lines l SET system_qty = COALESCE((SELECT s.qty FROM stock_by_bin s WHERE s.product_img = l.product_img AND s.bin_id = l.bin_id), 0),
                    unit_cost = (SELECT p.cost_usd FROM products p WHERE p.img = l.product_img)
              WHERE l.count_id = $1 AND l.bin_id = $2`, [id, binId]);
          const { rows: off } = await c.query(
            `SELECT COUNT(*)::int AS n FROM bin_count_lines WHERE count_id = $1 AND bin_id = $2
               AND (ABS(counted_qty - system_qty) > $3 OR ABS(counted_qty - system_qty) * COALESCE(unit_cost, 0) > $4)`, [id, binId, tolU, tolV]);
          const next = off[0].n ? 'recount' : 'counted';
          await c.query(`UPDATE bin_count_bins SET status = $3, counted_by = $4, counted_at = NOW() WHERE count_id = $1 AND bin_id = $2`, [id, binId, next, req.session.userId]);
          return next;
        }
        // Recount finished: unscanned parts in the recount are zero.
        await c.query(`UPDATE bin_count_lines SET recount_qty = COALESCE(recount_qty, 0) WHERE count_id = $1 AND bin_id = $2`, [id, binId]);
        await c.query(`UPDATE bin_count_bins SET status = 'counted', recount_by = $3, recount_at = NOW() WHERE count_id = $1 AND bin_id = $2`, [id, binId, req.session.userId]);
        return 'counted';
      });
      // Every bin done -> ready for review.
      await query(`UPDATE bin_counts SET status = 'review' WHERE id = $1 AND status = 'counting'
                    AND NOT EXISTS (SELECT 1 FROM bin_count_bins WHERE count_id = $1 AND status IN ('open','recount'))`, [req.params.id]);
      res.json({ ok: true, status: result, message: result === 'recount' ? 'Thank you. This bin needs a second count by someone else.' : 'Bin done.' });
    } catch (e) { fail(res, e); }
  });

  // Post: move stock by (final - system at finish), on top of today's quantity.
  app.post('/api/cnt/counts/:id/post', ...can('count.approve'), async (req, res) => {
    try {
      const out = await tx(async (c) => {
        const { rows: k } = await c.query(`SELECT * FROM bin_counts WHERE id = $1 FOR UPDATE`, [req.params.id]);
        if (!k.length) throw httpError(404, 'Count not found');
        if (k[0].status !== 'review') throw httpError(409, k[0].status === 'counting' ? 'Some bins are not counted yet' : 'This count is ' + k[0].status);
        await c.query("SELECT set_config('vision.bin_sync_off', 'on', true), set_config('vision.stock_reason', 'count', true)");
        const { rows: lines } = await c.query(
          `SELECT l.*, b.code FROM bin_count_lines l JOIN bins b ON b.id = l.bin_id WHERE l.count_id = $1 AND l.system_qty IS NOT NULL`, [req.params.id]);
        let changed = 0, units = 0, value = 0;
        for (const l of lines) {
          const final = l.recount_qty != null ? l.recount_qty : l.counted_qty;
          const delta = final - l.system_qty;
          await c.query(`UPDATE products SET last_counted_at = NOW() WHERE img = $1`, [l.product_img]);
          if (!delta) continue;
          const { rows: cur } = await c.query(`SELECT qty FROM stock_by_bin WHERE product_img = $1 AND bin_id = $2 FOR UPDATE`, [l.product_img, l.bin_id]);
          const newQty = Math.max((cur.length ? cur[0].qty : 0) + delta, 0);
          await c.query(
            `INSERT INTO stock_by_bin (product_img, bin_id, qty) VALUES ($1, $2, $3)
             ON CONFLICT (product_img, bin_id) DO UPDATE SET qty = EXCLUDED.qty, updated_at = NOW()`, [l.product_img, l.bin_id, newQty]);
          await c.query(`UPDATE products SET stock_count = stock_count + $2 WHERE img = $1`, [l.product_img, delta]);
          await c.query(
            `INSERT INTO warehouse_activity (kind, ref_kind, ref_id, product_img, performed_by, qty_delta, bin_location, bin_id, notes)
             VALUES ('count_adjust', 'bin_count', $1, $2, $3, $4, $5, $6, $7)`,
            [req.params.id, l.product_img, req.session.userId, delta, l.code, l.bin_id, k[0].number + ': counted ' + final + ', system ' + l.system_qty]);
          changed++; units += delta; value += delta * Number(l.unit_cost || 0);
        }
        await c.query(`UPDATE bin_count_bins SET status = 'approved' WHERE count_id = $1`, [req.params.id]);
        await c.query(`UPDATE bin_counts SET status = 'posted', posted_by = $2, posted_at = NOW() WHERE id = $1`, [req.params.id, req.session.userId]);
        return { changed, units, value: Math.round(value * 100) / 100 };
      });
      res.json(Object.assign({ ok: true }, out));
    } catch (e) { fail(res, e); }
  });

  // Send a bin back for another count (approver's call).
  app.post('/api/cnt/counts/:id/bins/:binId/recount', ...can('count.approve'), async (req, res) => {
    try {
      await tx(async (c) => {
        const { rowCount } = await c.query(
          `UPDATE bin_count_bins SET status = 'recount', recount_by = NULL, recount_at = NULL WHERE count_id = $1 AND bin_id = $2 AND status = 'counted'`, [req.params.id, req.params.binId]);
        if (!rowCount) throw httpError(409, 'Only a counted bin can be sent back');
        await c.query(`UPDATE bin_count_lines SET recount_qty = NULL WHERE count_id = $1 AND bin_id = $2`, [req.params.id, req.params.binId]);
        await c.query(`UPDATE bin_counts SET status = 'counting' WHERE id = $1 AND status = 'review'`, [req.params.id]);
      });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/cnt/counts/:id/cancel', ...can('count.create'), async (req, res) => {
    try {
      const { rowCount } = await query(`UPDATE bin_counts SET status = 'cancelled', note = COALESCE(note || ' | ', '') || $2 WHERE id = $1 AND status IN ('counting','review')`,
        [req.params.id, 'Cancelled: ' + String((req.body || {}).reason || '').slice(0, 200)]);
      if (!rowCount) throw httpError(409, 'Only an open count can be cancelled');
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
}

module.exports = { register };
