// =============================================================================
//  Vision Auto Solutions -- Warehouse API (Phase 1: scan, bins, stock per bin)
//
//  Mounted by server.js:  require('./warehouse').register(app, deps)
//  Everything lives under /api/wh and needs an admin session plus the
//  warehouse.access capability; changing stock locations needs
//  warehouse.move_stock, creating/editing bins needs warehouse.manage_bins.
//
//  Stock model (see schema.sql "WAREHOUSE FOUNDATION"):
//    products.stock_count  -- the total every other screen uses
//    stock_by_bin          -- where that total physically sits
//  A trigger keeps them equal when other code changes the total. Code here
//  moves stock between bins without changing the total, so the trigger is
//  switched off for these transactions (vision.bin_sync_off).
// =============================================================================
'use strict';

const BIN_KINDS = ['storage', 'display', 'receiving', 'staging', 'damaged', 'returns', 'unassigned'];
const MAX_BINS_PER_REQUEST = 500;

// Scanned labels may carry a type prefix ("BIN:J14", "ITEM:90311-76001-G") so a
// bin and a part number that happen to read the same can't be confused.
function parseScan(raw) {
  const s = String(raw || '').trim();
  const m = /^(BIN|ITEM|SKU|BATCH):(.+)$/i.exec(s);
  if (m) return { prefix: m[1].toUpperCase(), code: m[2].trim() };
  return { prefix: null, code: s };
}

function register(app, deps) {
  const { query, getPool, requireAdmin, requireCap } = deps;
  // Receiving batches (inbound.js). Optional so this module also runs alone.
  const batchInfo = deps.batchInfo || (async () => null);
  const gate = [requireAdmin, requireCap('warehouse.access')];
  const canMove = requireCap('warehouse.move_stock');
  const canManageBins = requireCap('warehouse.manage_bins');

  async function tx(fn) {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('vision.bin_sync_off', 'on', true)");
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw e;
    } finally {
      client.release();
    }
  }

  function terminalOf(req) {
    return String(req.get('x-terminal') || req.ip || '').slice(0, 80);
  }

  function fail(res, e) {
    const status = e.status || 500;
    if (status >= 500) console.error('[wh]', e);
    res.status(status).json({ error: e.publicMessage || e.message });
  }

  function httpError(status, msg) {
    const e = new Error(msg);
    e.status = status;
    e.publicMessage = msg;
    return e;
  }

  async function productLocations(img, q = query) {
    const { rows } = await q(
      `SELECT b.id AS bin_id, b.code, b.kind, s.qty,
              (upper(b.code) = wh_norm_bin(p.bin_location)) AS is_primary
         FROM stock_by_bin s
         JOIN bins b ON b.id = s.bin_id
         JOIN products p ON p.img = s.product_img
        WHERE s.product_img = $1
        ORDER BY (upper(b.code) = wh_norm_bin(p.bin_location)) DESC, s.qty DESC, b.code`,
      [img]);
    return rows;
  }

  const PRODUCT_COLS = `p.img, p.name, p.sku, p.barcode, p.category, p.make_model,
    p.stock_count, p.low_threshold, p.price_usd::float AS price_usd, p.bin_location,
    wh_norm_bin(p.bin_location) AS primary_bin`;

  async function findProduct(code) {
    const { rows } = await query(
      `SELECT ${PRODUCT_COLS} FROM products p
        WHERE upper(p.sku) = upper($1) OR upper(p.barcode) = upper($1) OR p.img = $1
        ORDER BY (upper(p.sku) = upper($1)) DESC
        LIMIT 1`, [code]);
    return rows[0] || null;
  }

  async function findBin(code) {
    const { rows } = await query(
      `SELECT id, code, kind, zone, aisle, rack, shelf, pick_sequence, is_active, notes
         FROM bins WHERE upper(code) = upper($1)`, [code]);
    return rows[0] || null;
  }

  async function binContents(binId) {
    const { rows } = await query(
      `SELECT p.img, p.name, p.sku, s.qty, p.stock_count,
              (upper(b.code) = wh_norm_bin(p.bin_location)) AS is_primary
         FROM stock_by_bin s
         JOIN products p ON p.img = s.product_img
         JOIN bins b ON b.id = s.bin_id
        WHERE s.bin_id = $1
        ORDER BY p.name`, [binId]);
    return rows;
  }

  // ---- scan / lookup ---------------------------------------------------------
  app.get('/api/wh/lookup', gate, async (req, res) => {
    try {
      const { prefix, code } = parseScan(req.query.code);
      if (!code) return res.status(400).json({ error: 'Nothing scanned' });
      // A receiving batch label: the part, where it is waiting, how many are left to shelve.
      if (prefix === 'BATCH' || (!prefix && /^B\d+$/i.test(code))) {
        const batch = await batchInfo(code);
        if (batch) {
          const product = await findProduct(batch.product_img);
          return res.json({ type: 'batch', batch, product, locations: product ? await productLocations(product.img) : [] });
        }
        if (prefix === 'BATCH') return res.status(404).json({ type: null, error: 'No received batch "' + code + '"' });
      }
      if (prefix !== 'ITEM' && prefix !== 'SKU') {
        const bin = await findBin(code);
        if (bin) return res.json({ type: 'bin', bin, contents: await binContents(bin.id) });
      }
      if (prefix !== 'BIN') {
        const product = await findProduct(code);
        if (product) return res.json({ type: 'product', product, locations: await productLocations(product.img) });
      }
      res.status(404).json({ type: null, error: 'No bin or part matches "' + code + '"' });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/wh/products/search', gate, async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      if (q.length < 2) return res.json({ products: [] });
      const { rows } = await query(
        `SELECT ${PRODUCT_COLS} FROM products p
          WHERE p.sku ILIKE $1 OR p.name ILIKE $1 OR p.barcode ILIKE $1
          ORDER BY (upper(p.sku) = upper($2)) DESC, p.stock_count DESC, p.name
          LIMIT 40`, ['%' + q + '%', q]);
      res.json({ products: rows });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/wh/products/:img/locations', gate, async (req, res) => {
    try { res.json({ locations: await productLocations(req.params.img) }); } catch (e) { fail(res, e); }
  });

  // ---- bins ------------------------------------------------------------------
  app.get('/api/wh/bins', gate, async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      const kind = BIN_KINDS.includes(req.query.kind) ? req.query.kind : null;
      const limit = Math.min(parseInt(req.query.limit, 10) || 200, 2000);
      const { rows } = await query(
        `SELECT b.id, b.code, b.kind, b.zone, b.aisle, b.rack, b.shelf, b.pick_sequence, b.is_active, b.notes,
                COUNT(s.product_img) FILTER (WHERE s.qty > 0)::int AS items,
                COALESCE(SUM(s.qty), 0)::int AS units
           FROM bins b LEFT JOIN stock_by_bin s ON s.bin_id = b.id
          WHERE ($1 = '' OR b.code ILIKE $2) AND ($3::text IS NULL OR b.kind = $3)
          GROUP BY b.id
          ORDER BY b.pick_sequence NULLS LAST, b.code
          LIMIT $4`, [q, '%' + q + '%', kind, limit]);
      res.json({ bins: rows });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/wh/bins/:id/contents', gate, async (req, res) => {
    try {
      const { rows } = await query('SELECT id, code, kind FROM bins WHERE id = $1', [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: 'Bin not found' });
      res.json({ bin: rows[0], contents: await binContents(rows[0].id) });
    } catch (e) { fail(res, e); }
  });

  // Create one bin, a list, or a generated range: {prefix:"A-", from:1, to:12, pad:2}
  app.post('/api/wh/bins', gate, canManageBins, async (req, res) => {
    try {
      const b = req.body || {};
      let codes = [];
      if (Array.isArray(b.codes)) codes = b.codes;
      else if (b.code) codes = [b.code];
      else if (b.prefix != null && Number.isInteger(+b.from) && Number.isInteger(+b.to)) {
        const from = +b.from, to = +b.to, pad = Math.min(Math.max(+b.pad || 0, 0), 6);
        if (to < from) throw httpError(400, '"to" must be at least "from"');
        if (to - from + 1 > MAX_BINS_PER_REQUEST) throw httpError(400, 'At most ' + MAX_BINS_PER_REQUEST + ' bins at once');
        for (let i = from; i <= to; i++) codes.push(String(b.prefix) + String(i).padStart(pad, '0') + String(b.suffix || ''));
      }
      codes = [...new Set(codes.map((c) => String(c || '').trim().toUpperCase()).filter(Boolean))];
      if (!codes.length) throw httpError(400, 'Give a bin code, a list of codes, or a range');
      if (codes.length > MAX_BINS_PER_REQUEST) throw httpError(400, 'At most ' + MAX_BINS_PER_REQUEST + ' bins at once');
      if (codes.some((c) => c.length > 40 || /[*:]/.test(c))) throw httpError(400, 'Bin codes are up to 40 characters and cannot contain * or :');
      const kind = BIN_KINDS.includes(b.kind) && b.kind !== 'unassigned' ? b.kind : 'storage';
      const { rows } = await query(
        `INSERT INTO bins (code, kind, zone, created_by)
         SELECT c, $2, $3, $4 FROM unnest($1::text[]) AS c
          WHERE NOT EXISTS (SELECT 1 FROM bins x WHERE upper(x.code) = upper(c))
         RETURNING id, code, kind`,
        [codes, kind, b.zone || null, req.session.userId]);
      res.json({ created: rows, skipped_existing: codes.length - rows.length });
    } catch (e) { fail(res, e); }
  });

  app.patch('/api/wh/bins/:id', gate, canManageBins, async (req, res) => {
    try {
      const b = req.body || {};
      const sets = [], vals = [];
      const put = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
      if (b.kind !== undefined) {
        if (!BIN_KINDS.includes(b.kind) || b.kind === 'unassigned') throw httpError(400, 'Unknown bin type');
        put('kind', b.kind);
      }
      for (const col of ['zone', 'aisle', 'rack', 'shelf', 'notes']) if (b[col] !== undefined) put(col, b[col] || null);
      if (b.pick_sequence !== undefined) put('pick_sequence', b.pick_sequence === '' || b.pick_sequence == null ? null : parseInt(b.pick_sequence, 10));
      if (b.is_active !== undefined) {
        if (!b.is_active) {
          const { rows } = await query('SELECT COALESCE(SUM(qty),0)::int AS u FROM stock_by_bin WHERE bin_id = $1', [req.params.id]);
          if (rows[0].u > 0) throw httpError(409, 'Move the ' + rows[0].u + ' unit(s) out of this bin before closing it');
        }
        put('is_active', !!b.is_active);
      }
      if (!sets.length) throw httpError(400, 'Nothing to change');
      vals.push(req.params.id);
      const { rows } = await query(`UPDATE bins SET ${sets.join(', ')} WHERE id = $${vals.length} AND kind <> 'unassigned' RETURNING *`, vals);
      if (!rows.length) throw httpError(404, 'Bin not found (the UNASSIGNED bin cannot be edited)');
      res.json({ bin: rows[0] });
    } catch (e) { fail(res, e); }
  });

  // ---- moving stock ----------------------------------------------------------
  // {img, from_bin_id, to_bin_id | to_code, qty, set_primary?, kind?: 'putaway'}
  // Also the putaway action: from UNASSIGNED (or a receiving bin) to a shelf.
  app.post('/api/wh/move', gate, canMove, async (req, res) => {
    try {
      const b = req.body || {};
      const qty = parseInt(b.qty, 10);
      if (!b.img) throw httpError(400, 'Which part?');
      if (!Number.isInteger(qty) || qty < 1) throw httpError(400, 'Quantity must be at least 1');
      const out = await tx(async (c) => {
        let toId = b.to_bin_id ? parseInt(b.to_bin_id, 10) : null;
        if (!toId && b.to_code) {
          const { rows } = await c.query('SELECT id, is_active FROM bins WHERE upper(code) = upper($1)', [parseScan(b.to_code).code]);
          if (!rows.length) throw httpError(404, 'No bin "' + b.to_code + '". Create it first under Bins.');
          if (!rows[0].is_active) throw httpError(409, 'That bin is closed');
          toId = rows[0].id;
        }
        const fromId = parseInt(b.from_bin_id, 10);
        if (!fromId || !toId) throw httpError(400, 'Choose where the stock comes from and where it goes');
        if (fromId === toId) throw httpError(400, 'That is the same bin');
        const { rows: src } = await c.query(
          'SELECT qty FROM stock_by_bin WHERE product_img = $1 AND bin_id = $2 FOR UPDATE', [b.img, fromId]);
        const have = src.length ? src[0].qty : 0;
        if (have < qty) throw httpError(409, 'Only ' + have + ' in that bin');
        await c.query('UPDATE stock_by_bin SET qty = qty - $3, updated_at = NOW() WHERE product_img = $1 AND bin_id = $2', [b.img, fromId, qty]);
        await c.query(
          `INSERT INTO stock_by_bin (product_img, bin_id, qty) VALUES ($1, $2, $3)
           ON CONFLICT (product_img, bin_id) DO UPDATE SET qty = stock_by_bin.qty + EXCLUDED.qty, updated_at = NOW()`,
          [b.img, toId, qty]);
        const { rows: bins } = await c.query('SELECT id, code FROM bins WHERE id = ANY($1::int[])', [[fromId, toId]]);
        const codeOf = (id) => (bins.find((x) => x.id === id) || {}).code;
        if (b.set_primary) await c.query('UPDATE products SET bin_location = $2 WHERE img = $1', [b.img, codeOf(toId)]);
        // Drop the emptied source row unless it is the item's primary home.
        await c.query(
          `DELETE FROM stock_by_bin s USING bins bb, products p
            WHERE s.product_img = $1 AND s.bin_id = $2 AND s.qty = 0
              AND bb.id = s.bin_id AND p.img = s.product_img
              AND upper(bb.code) IS DISTINCT FROM wh_norm_bin(p.bin_location)`, [b.img, fromId]);
        // Putting away a received batch: record it against the batch, so the
        // receipt shows who shelved what, where, and how much is still waiting.
        let batch = null;
        if (b.batch_line_id) {
          const { rows: bl } = await c.query(
            `UPDATE receipt_lines SET qty_putaway = LEAST(qty_received, qty_putaway + $2)
              WHERE id = $1 AND product_img = $3 RETURNING id, batch_code`, [parseInt(b.batch_line_id, 10), qty, b.img]);
          batch = bl[0] || null;
        }
        await c.query(
          `INSERT INTO warehouse_activity (kind, product_img, performed_by, qty_delta, bin_location, bin_id, to_bin_id, terminal, notes, ref_kind, ref_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [b.kind === 'putaway' || batch ? 'putaway' : 'move', b.img, req.session.userId, qty, codeOf(toId), fromId, toId,
           terminalOf(req), codeOf(fromId) + ' -> ' + codeOf(toId) + (batch ? ' | batch ' + batch.batch_code : '') + (b.note ? ' | ' + String(b.note).slice(0, 200) : ''),
           batch ? 'receipt_line' : null, batch ? batch.id : null]);
        return { locations: await productLocations(b.img, c.query.bind(c)) };
      });
      res.json(Object.assign({ ok: true }, out));
    } catch (e) { fail(res, e); }
  });

  // Make a bin the item's primary home (where new receipts land, where sales draw first).
  app.post('/api/wh/primary', gate, canMove, async (req, res) => {
    try {
      const b = req.body || {};
      const { rows } = await query('SELECT code FROM bins WHERE id = $1 AND is_active AND kind <> $2', [b.bin_id, 'unassigned']);
      if (!rows.length) throw httpError(404, 'Bin not found');
      const r = await query('UPDATE products SET bin_location = $2 WHERE img = $1 RETURNING img', [b.img, rows[0].code]);
      if (!r.rows.length) throw httpError(404, 'Part not found');
      await query(
        `INSERT INTO warehouse_activity (kind, product_img, performed_by, bin_location, bin_id, terminal)
         VALUES ('set_primary', $1, $2, $3, $4, $5)`, [b.img, req.session.userId, rows[0].code, b.bin_id, terminalOf(req)]);
      res.json({ ok: true, locations: await productLocations(b.img) });
    } catch (e) { fail(res, e); }
  });

  // ---- activity --------------------------------------------------------------
  app.get('/api/wh/activity', gate, async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
      const { rows } = await query(
        `SELECT a.id, a.kind, a.product_img, p.name, p.sku, a.qty_delta, a.bin_location, a.notes, a.terminal,
                a.created_at, u.name AS by_name
           FROM warehouse_activity a
           LEFT JOIN products p ON p.img = a.product_img
           LEFT JOIN users u ON u.id = a.performed_by
          WHERE ($1::text IS NULL OR a.product_img = $1)
            AND ($2::int IS NULL OR a.bin_id = $2 OR a.to_bin_id = $2)
          ORDER BY a.created_at DESC
          LIMIT $3`, [req.query.img || null, req.query.bin_id ? parseInt(req.query.bin_id, 10) : null, limit]);
      res.json({ activity: rows });
    } catch (e) { fail(res, e); }
  });

  // ---- summary for the page header -------------------------------------------
  app.get('/api/wh/summary', gate, async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT (SELECT COUNT(*) FROM bins WHERE is_active)::int AS bins,
                (SELECT COALESCE(SUM(s.qty),0) FROM stock_by_bin s JOIN bins b ON b.id = s.bin_id WHERE b.kind = 'unassigned')::int AS unassigned_units,
                (SELECT COUNT(DISTINCT s.product_img) FROM stock_by_bin s JOIN bins b ON b.id = s.bin_id WHERE b.kind = 'unassigned' AND s.qty > 0)::int AS unassigned_items,
                (SELECT COUNT(*) FROM products p WHERE p.stock_count > 0
                   AND p.stock_count <> (SELECT COALESCE(SUM(qty),0) FROM stock_by_bin s WHERE s.product_img = p.img))::int AS mismatched_items`);
      res.json(rows[0]);
    } catch (e) { fail(res, e); }
  });
}

module.exports = { register, parseScan, BIN_KINDS };
