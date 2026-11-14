// =============================================================================
//  Morty's Auto Parts -- Service <-> Parts requisitions (Phases 2-4).
//
//  When a department may not sell an item directly (see dept-rules.js), it
//  raises a requisition to the Parts department instead of ringing it. Parts
//  fulfils it -- as a TRANSFER (internal: the part is tracked as taken from
//  Parts, the customer sale rings on the Service ticket) or as BILLING (the
//  departments are kept separate, so Parts bills Service like an internal
//  supplier) -- and sets the PRICE (basis: cost / retail / discounted). The
//  Service ticket then sells it to the customer, where Service may mark it up
//  (hidden on the customer's bill) or discount it (shown).
//
//  This module does NOT move stock or post to the ledger. Stock leaves once,
//  on the normal customer sale at the Service till; the requisition is the
//  authorisation + price + tracking record. The internal-supplier billing
//  amount is recorded (billed_total_usd) but its GL treatment is deferred
//  until confirmed.
//
//  Mounted: require('./dept-requisitions').register(app, { query, requireAdmin, requireCap })
// =============================================================================
'use strict';

function register(app, deps) {
  const { query, requireAdmin } = deps;
  const uid = (req) => (req.session && req.session.userId) || null;
  function httpError(status, msg) { const e = new Error(msg); e.status = status; e.publicMessage = msg; return e; }
  function fail(res, e) { const s = e.status || 500; if (s >= 500) console.error('[dept-requisitions]', e); res.status(s).json({ error: e.publicMessage || e.message }); }

  // Created on first use, not at startup: DDL running while server.js applies
  // schema.sql at boot can deadlock it (it did on 2026-11-05).
  let readyP = null;
  const ready = () => readyP || (readyP = query(
    `CREATE TABLE IF NOT EXISTS dept_requisitions (
       id              SERIAL PRIMARY KEY,
       req_number      TEXT UNIQUE,
       from_department TEXT NOT NULL,
       to_department   TEXT NOT NULL DEFAULT 'counter',
       customer_name   TEXT,
       customer_phone  TEXT,
       ticket_ref      TEXT,                       -- POS park/ticket it hangs off, if any
       method          TEXT,                       -- NULL until Parts picks: 'transfer' | 'billing'
       status          TEXT NOT NULL DEFAULT 'open',-- open | fulfilled | backordered | cancelled
       billed_total_usd NUMERIC(12,2),             -- internal invoice to Service when method='billing'
       notes           TEXT,
       created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
       fulfilled_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
       created_at      TIMESTAMPTZ DEFAULT NOW(),
       fulfilled_at    TIMESTAMPTZ);
     CREATE TABLE IF NOT EXISTS dept_requisition_items (
       id             SERIAL PRIMARY KEY,
       requisition_id INTEGER NOT NULL REFERENCES dept_requisitions(id) ON DELETE CASCADE,
       product_img    TEXT,
       description    TEXT NOT NULL,
       qty_requested  NUMERIC(12,3) NOT NULL DEFAULT 1,
       qty_fulfilled  NUMERIC(12,3) NOT NULL DEFAULT 0,
       price_basis    TEXT,                         -- 'cost' | 'retail' | 'discounted'
       parts_price_usd NUMERIC(12,2),               -- per-unit price Parts sets
       status         TEXT NOT NULL DEFAULT 'pending'); -- pending | fulfilled | backordered | cancelled
     CREATE INDEX IF NOT EXISTS idx_dept_req_items_req ON dept_requisition_items (requisition_id);
     CREATE INDEX IF NOT EXISTS idx_dept_req_status ON dept_requisitions (status, to_department);`)
    .catch((e) => { readyP = null; console.error('[dept-requisitions] table', e.message); }));

  async function nextReqNumber() {
    const yr = new Date().getFullYear();
    const { rows } = await query(
      `SELECT COALESCE(MAX(split_part(req_number, '-', 3)::int), 0) + 1 AS n
         FROM dept_requisitions WHERE req_number LIKE $1`, ['RQ-' + yr + '-%']);
    return 'RQ-' + yr + '-' + String(rows[0].n).padStart(4, '0');
  }

  // Re-derive a requisition's status from its line statuses.
  async function recalcStatus(reqId) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE status = 'fulfilled')::int AS done,
              COUNT(*) FILTER (WHERE status = 'backordered')::int AS back,
              COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled
         FROM dept_requisition_items WHERE requisition_id = $1`, [reqId]);
    const r = rows[0];
    let status = 'open';
    if (r.n > 0 && r.cancelled === r.n) status = 'cancelled';
    else if (r.back > 0) status = 'backordered';          // "awaiting parts" on the requester's side
    else if (r.n > 0 && r.done + r.cancelled === r.n) status = 'fulfilled';
    await query(`UPDATE dept_requisitions SET status = $1 WHERE id = $2`, [status, reqId]);
    return status;
  }

  // Raise a requisition. body: { from_department, to_department?, customer_name?,
  //   customer_phone?, ticket_ref?, notes?, items: [{ product_img?, description, qty }] }
  app.post('/api/requisitions', requireAdmin, async (req, res) => {
    try {
      await ready();
      const b = req.body || {};
      const from = String(b.from_department || '').trim();
      if (!from) throw httpError(400, 'from_department required');
      const items = Array.isArray(b.items) ? b.items.filter((it) => it && String(it.description || '').trim()) : [];
      if (!items.length) throw httpError(400, 'At least one item is required');
      const num = await nextReqNumber();
      const { rows } = await query(
        `INSERT INTO dept_requisitions (req_number, from_department, to_department, customer_name, customer_phone, ticket_ref, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [num, from, String(b.to_department || 'counter').trim(), b.customer_name || null, b.customer_phone || null,
         b.ticket_ref || null, b.notes || null, uid(req)]);
      const reqId = rows[0].id;
      for (const it of items) {
        await query(
          `INSERT INTO dept_requisition_items (requisition_id, product_img, description, qty_requested)
           VALUES ($1,$2,$3,$4)`,
          [reqId, it.product_img || null, String(it.description).slice(0, 300), Math.max(0, Number(it.qty) || 1)]);
      }
      res.json({ ok: true, id: reqId, req_number: num });
    } catch (e) { fail(res, e); }
  });

  // The Parts queue (and history). ?status=open|backordered|fulfilled|cancelled|all (default open+backordered)
  app.get('/api/requisitions', requireAdmin, async (req, res) => {
    try {
      await ready();
      const st = String(req.query.status || '').trim();
      const where = st === 'all' ? 'TRUE'
        : st ? 'r.status = $1'
        : "r.status IN ('open','backordered')";
      const binds = (st && st !== 'all') ? [st] : [];
      const { rows } = await query(
        `SELECT r.*, u.name AS created_by_name,
                (SELECT COUNT(*) FROM dept_requisition_items i WHERE i.requisition_id = r.id)::int AS item_count,
                (SELECT COALESCE(SUM(qty_requested),0) FROM dept_requisition_items i WHERE i.requisition_id = r.id)::float AS qty_total
           FROM dept_requisitions r LEFT JOIN users u ON u.id = r.created_by
          WHERE ${where}
          ORDER BY (r.status = 'open') DESC, r.created_at ASC
          LIMIT 300`, binds);
      res.json({ requisitions: rows });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/requisitions/stats', requireAdmin, async (_req, res) => {
    try {
      await ready();
      const { rows } = await query(
        `SELECT COUNT(*) FILTER (WHERE status = 'open')::int AS open,
                COUNT(*) FILTER (WHERE status = 'backordered')::int AS backordered,
                COUNT(*) FILTER (WHERE status = 'fulfilled' AND fulfilled_at > NOW() - INTERVAL '7 days')::int AS fulfilled_7d
           FROM dept_requisitions`);
      res.json(rows[0] || { open: 0, backordered: 0, fulfilled_7d: 0 });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/requisitions/:id', requireAdmin, async (req, res) => {
    try {
      await ready();
      const id = parseInt(req.params.id, 10) || 0;
      const { rows } = await query(
        `SELECT r.*, u.name AS created_by_name, f.name AS fulfilled_by_name
           FROM dept_requisitions r LEFT JOIN users u ON u.id = r.created_by
           LEFT JOIN users f ON f.id = r.fulfilled_by WHERE r.id = $1`, [id]);
      if (!rows.length) throw httpError(404, 'Requisition not found');
      const { rows: items } = await query(
        `SELECT * FROM dept_requisition_items WHERE requisition_id = $1 ORDER BY id`, [id]);
      res.json({ requisition: rows[0], items });
    } catch (e) { fail(res, e); }
  });

  // Parts fulfils. body: { method: 'transfer'|'billing',
  //   lines: [{ item_id, qty_fulfilled, price_basis, parts_price_usd, backorder? }] }
  app.post('/api/requisitions/:id/fulfil', requireAdmin, async (req, res) => {
    try {
      await ready();
      const id = parseInt(req.params.id, 10) || 0;
      const b = req.body || {};
      const method = String(b.method || '').trim();
      if (!['transfer', 'billing'].includes(method)) throw httpError(400, "method must be 'transfer' or 'billing'");
      const found = await query(`SELECT id, status FROM dept_requisitions WHERE id = $1`, [id]);
      if (!found.rows.length) throw httpError(404, 'Requisition not found');
      if (found.rows[0].status === 'cancelled') throw httpError(409, 'Requisition is cancelled');
      const lines = Array.isArray(b.lines) ? b.lines : [];
      for (const ln of lines) {
        const itemId = parseInt(ln.item_id, 10) || 0;
        if (!itemId) continue;
        const back = ln.backorder === true;
        const basis = ['cost', 'retail', 'discounted'].includes(String(ln.price_basis)) ? String(ln.price_basis) : null;
        const price = (ln.parts_price_usd == null || ln.parts_price_usd === '') ? null : Math.max(0, Number(ln.parts_price_usd) || 0);
        const qtyF = back ? 0 : Math.max(0, Number(ln.qty_fulfilled) || 0);
        await query(
          `UPDATE dept_requisition_items
              SET qty_fulfilled = $1, price_basis = $2, parts_price_usd = $3,
                  status = $4
            WHERE id = $5 AND requisition_id = $6`,
          [qtyF, basis, price, back ? 'backordered' : 'fulfilled', itemId, id]);
      }
      // Internal invoice total when Parts is billing Service as a supplier.
      const { rows: tot } = await query(
        `SELECT COALESCE(SUM(qty_fulfilled * COALESCE(parts_price_usd,0)),0)::float AS t
           FROM dept_requisition_items WHERE requisition_id = $1 AND status = 'fulfilled'`, [id]);
      await query(
        `UPDATE dept_requisitions
            SET method = $1, fulfilled_by = $2, fulfilled_at = NOW(),
                billed_total_usd = $3
          WHERE id = $4`,
        [method, uid(req), method === 'billing' ? tot.rows[0].t : null, id]);
      const status = await recalcStatus(id);
      res.json({ ok: true, status: status, billed_total: method === 'billing' ? tot.rows[0].t : null });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/requisitions/:id/cancel', requireAdmin, async (req, res) => {
    try {
      await ready();
      const id = parseInt(req.params.id, 10) || 0;
      const found = await query(`SELECT id FROM dept_requisitions WHERE id = $1`, [id]);
      if (!found.rows.length) throw httpError(404, 'Requisition not found');
      await query(`UPDATE dept_requisition_items SET status = 'cancelled' WHERE requisition_id = $1 AND status IN ('pending','backordered')`, [id]);
      await query(`UPDATE dept_requisitions SET status = 'cancelled' WHERE id = $1`, [id]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // Mark a fulfilled requisition as billed to the customer (the Service ticket has pulled its lines). Drops it off the 'fulfilled' list the till picker shows.
  app.post('/api/requisitions/:id/mark-billed', requireAdmin, async (req, res) => {
    try {
      await ready();
      const id = parseInt(req.params.id, 10) || 0;
      const found = await query(`SELECT id FROM dept_requisitions WHERE id = $1`, [id]);
      if (!found.rows.length) throw httpError(404, 'Requisition not found');
      await query(`UPDATE dept_requisitions SET status = 'billed' WHERE id = $1`, [id]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  return {};
}

module.exports = { register };
