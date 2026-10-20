// =============================================================================
//  Vision Auto Solutions -- Outbound API (Phase 3)
//
//  Mounted by server.js:  require('./outbound').register(app, deps)
//
//  A fulfilment is the warehouse job for one sale:
//     new -> picking -> picked -> (packed) -> ready -> dispatched -> delivered
//                                                  \-> collected (counter pickup, code checked)
//  Any stage can be put on hold by a manager; held orders can't be picked,
//  dispatched or collected. Every step writes a fulfilment_events row; the
//  ones marked public make up the customer's tracking timeline.
//
//  Sales are made in the POS exactly as before. A sweep (every 10 s) turns new
//  POS sales into fulfilments according to the 'fulfil_auto' setting, and
//  staff can send any sale or web order to the warehouse by hand.
//
//  Routes:
//    /api/out/...            staff (admin session + fulfil.* capabilities)
//    /api/public/order-board  counter screen: order number, masked name, stage
//    /api/public/track/:token customer tracking page
// =============================================================================
'use strict';

const crypto = require('crypto');

const OPEN = ['new', 'picking', 'picked', 'packed', 'ready', 'dispatched'];

function register(app, deps) {
  const { query, getPool, requireAdmin, requireCap, notify } = deps;
  const gate = [requireAdmin];
  const cap = (k) => requireCap(k);

  // ---------------------------------------------------------------- helpers --
  function httpError(status, msg) { const e = new Error(msg); e.status = status; e.publicMessage = msg; return e; }
  function fail(res, e) {
    const status = e.status || 500;
    if (status >= 500) console.error('[out]', e);
    res.status(status).json({ error: e.publicMessage || e.message });
  }
  const terminalOf = (req) => String(req.get('x-terminal') || req.ip || '').slice(0, 80);

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
  async function event(q, fId, kind, note, req, isPublic) {
    await q(`INSERT INTO fulfilment_events (fulfilment_id, kind, note, by_user, terminal, public) VALUES ($1, $2, $3, $4, $5, $6)`,
      [fId, kind, note || null, req && req.session ? req.session.userId : null, req ? terminalOf(req) : 'system', !!isPublic]);
  }
  // The till's generic accounts for walk-in buyers. Never a real person: not shown
  // by name and never sent a pickup code (they share one email / phone).
  const isWalkIn = (n) => /^(walk-?in( customer)?|cash( sale| customer)?|counter|customer)$/i.test(String(n || '').trim());
  function maskName(n) {
    const parts = String(n || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length || isWalkIn(n)) return 'Customer';
    const first = parts[0][0].toUpperCase() + parts[0].slice(1).toLowerCase();
    return parts.length > 1 ? first + ' ' + parts[parts.length - 1][0].toUpperCase() + '.' : first;
  }
  function sameCode(a, b) {
    const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
    return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
  }
  const newCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

  // Payment state comes from where the sale lives; the warehouse never takes money.
  async function paymentOf(f, q = query) {
    if (f.source_kind === 'pos_sale' && f.source_id) {
      const { rows } = await q(`SELECT payment_status, balance_due_usd::float AS due, voided FROM pos_sales WHERE id = $1`, [f.source_id]);
      if (!rows.length) return { paid: false, label: 'sale not found' };
      if (rows[0].voided) return { paid: false, label: 'sale voided' };
      const due = rows[0].due || 0;
      const paid = (rows[0].payment_status || 'paid') === 'paid' || due <= 0.009;
      return { paid, label: paid ? 'paid' : 'J$' + due.toFixed(2) + ' due', balance_due: due };
    }
    if (f.source_kind === 'web_order' && f.source_id) {
      const { rows } = await q(`SELECT payment_status FROM orders WHERE id = $1`, [f.source_id]);
      const paid = rows.length && rows[0].payment_status === 'paid';
      return { paid: !!paid, label: paid ? 'paid' : 'not paid' };
    }
    return { paid: true, label: 'no payment needed' };
  }

  // ------------------------------------------------- creating fulfilments --
  async function createFromSale(c, saleId, opts) {
    opts = opts || {};
    const { rows: s } = await c.query(
      `SELECT s.*, u.phone AS u_phone, u.email AS u_email, u.name AS u_name
         FROM pos_sales s LEFT JOIN users u ON u.id = s.customer_id WHERE s.id = $1`, [saleId]);
    if (!s.length) throw httpError(404, 'Sale not found');
    const sale = s[0];
    if (sale.voided) throw httpError(409, 'That sale was voided');
    const { rows: exists } = await c.query(`SELECT id FROM fulfilments WHERE source_kind = 'pos_sale' AND source_id = $1`, [saleId]);
    if (exists.length) return { id: exists[0].id, existed: true };
    const { rows: items } = await c.query(
      // p.img, not i.product_img: a sale line can point at a part since deleted
      // from the catalogue; it is still picked, by its description, unlinked.
      `SELECT p.img AS product_img, COALESCE(p.sku, i.product_img, i.description) AS sku, COALESCE(p.name, i.description) AS description, SUM(i.qty)::int AS qty
         FROM pos_sale_items i LEFT JOIN products p ON p.img = i.product_img
        WHERE i.sale_id = $1 AND i.qty > 0 AND i.product_img IS NOT NULL
        GROUP BY p.img, p.sku, p.name, i.product_img, i.description`, [saleId]);
    if (!items.length) return null;   // labour / service only: nothing to pick
    const method = opts.method || (['delivery', 'shipping'].includes(sale.fulfilment) ? sale.fulfilment : 'pickup');
    const shipTo = opts.ship_to || (method !== 'pickup' ? {
      name: sale.ship_name || sale.customer_name, phone: sale.ship_phone || sale.customer_phone || sale.u_phone,
      line1: sale.ship_line1, line2: sale.ship_line2, city: sale.ship_city, parish: sale.ship_parish, country: sale.ship_country || 'JM',
    } : null);
    // Pickup orders get their code at creation, so the counter can hand a walk-in
    // customer a ticket with it while they wait.
    const { rows: f } = await c.query(
      `INSERT INTO fulfilments (source_kind, source_id, source_ref, customer_name, customer_phone, customer_email, method, ship_to, track_token, created_by, notes, pickup_code)
       VALUES ('pos_sale', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [saleId, sale.receipt_number, sale.customer_name || sale.u_name || 'Walk-in', sale.customer_phone || sale.u_phone || null, sale.u_email || null,
       method, shipTo ? JSON.stringify(shipTo) : null, crypto.randomBytes(18).toString('base64url'), opts.userId || null, sale.ship_instructions || null,
       method === 'pickup' ? newCode() : null]);
    const id = f[0].id;
    await c.query(`UPDATE fulfilments SET number = 'F-' || lpad(id::text, 6, '0') WHERE id = $1`, [id]);
    for (const it of items) {
      await c.query(`INSERT INTO fulfilment_lines (fulfilment_id, product_img, sku, description, qty) VALUES ($1, $2, $3, $4, $5)`,
        [id, it.product_img, it.sku, it.description, it.qty]);
    }
    await event(c.query.bind(c), id, 'created', 'From sale ' + sale.receipt_number, opts.req || null, true);
    return { id, existed: false };
  }

  async function createFromWebOrder(c, orderId, opts) {
    opts = opts || {};
    const { rows: o } = await c.query(
      `SELECT o.*, u.name AS u_name, u.phone AS u_phone, u.email AS u_email FROM orders o LEFT JOIN users u ON u.id = o.user_id WHERE o.id = $1`, [orderId]);
    if (!o.length) throw httpError(404, 'Order not found');
    const { rows: exists } = await c.query(`SELECT id FROM fulfilments WHERE source_kind = 'web_order' AND source_id = $1`, [orderId]);
    if (exists.length) return { id: exists[0].id, existed: true };
    const { rows: items } = await c.query(
      `SELECT p.img AS product_img, COALESCE(p.sku, i.product_img) AS sku, COALESCE(p.name, i.product_img) AS description, SUM(i.qty)::int AS qty
         FROM order_items i LEFT JOIN products p ON p.img = i.product_img
        WHERE i.order_id = $1 AND i.qty > 0 GROUP BY p.img, p.sku, p.name, i.product_img`, [orderId]);
    if (!items.length) return null;
    const method = opts.method || 'pickup';
    const { rows: f } = await c.query(
      `INSERT INTO fulfilments (source_kind, source_id, source_ref, customer_name, customer_phone, customer_email, method, track_token, created_by, pickup_code)
       VALUES ('web_order', $1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [orderId, 'WEB-' + orderId, o[0].u_name || 'Online customer', o[0].u_phone || null, o[0].u_email || null,
       method, crypto.randomBytes(18).toString('base64url'), opts.userId || null, method === 'pickup' ? newCode() : null]);
    const id = f[0].id;
    await c.query(`UPDATE fulfilments SET number = 'F-' || lpad(id::text, 6, '0') WHERE id = $1`, [id]);
    for (const it of items) {
      await c.query(`INSERT INTO fulfilment_lines (fulfilment_id, product_img, sku, description, qty) VALUES ($1, $2, $3, $4, $5)`,
        [id, it.product_img, it.sku || it.product_img, it.description || it.product_img, it.qty]);
    }
    await event(c.query.bind(c), id, 'created', 'Online order', opts.req || null, true);
    return { id, existed: false };
  }

  // Sweep: new POS sales -> fulfilments, per the fulfil_auto setting.
  let sweeping = false;
  async function sweep() {
    if (sweeping) return;
    sweeping = true;
    try {
      const mode = await setting('fulfil_auto', 'off');
      if (mode === 'off') return;
      let from = parseInt(await setting('fulfil_sweep_from', ''), 10);
      if (!Number.isFinite(from)) {
        // First run after switching on: start from now, never backfill old history.
        const { rows } = await query('SELECT COALESCE(MAX(id), 0) AS m FROM pos_sales');
        from = rows[0].m;
        await query(`INSERT INTO warehouse_settings (key, value) VALUES ('fulfil_sweep_from', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [String(from)]);
        return;
      }
      const { rows: sales } = await query(
        `SELECT id, fulfilment FROM pos_sales WHERE id > $1 AND NOT COALESCE(voided, false)
            AND created_at < NOW() - INTERVAL '5 seconds' ORDER BY id LIMIT 200`, [from]);
      let last = from;
      for (const s of sales) {
        if (mode === 'all' || (mode === 'delivery' && ['delivery', 'shipping'].includes(s.fulfilment))) {
          try {
            const made = await tx((c) => createFromSale(c, s.id));
            if (made && !made.existed) await tell(made.id, 'order_received');
          } catch (e) { console.warn('[out] sweep sale', s.id, e.message); }
        }
        last = s.id;
      }
      if (last !== from) await query(`UPDATE warehouse_settings SET value = $1 WHERE key = 'fulfil_sweep_from'`, [String(last)]);
    } catch (e) {
      console.warn('[out] sweep failed:', e.message);
    } finally { sweeping = false; }
  }
  const sweepTimer = setInterval(sweep, 10000); sweepTimer.unref();

  // --------------------------------------------------------------- reading --
  const LIST_SQL = `
    SELECT f.id, f.number, f.source_kind, f.source_id, f.source_ref, f.customer_name, f.method, f.status, f.priority,
           f.on_hold, f.hold_reason, f.created_at, f.pick_started_at, f.picked_at, f.packed_at, f.ready_at, f.dispatched_at,
           f.completed_at, f.manifest_id, f.carrier, f.tracking_number, f.ship_to,
           pk.name AS picker_name,
           (SELECT COALESCE(SUM(qty), 0) FROM fulfilment_lines l WHERE l.fulfilment_id = f.id)::int AS units,
           (SELECT COALESCE(SUM(qty_picked + qty_short), 0) FROM fulfilment_lines l WHERE l.fulfilment_id = f.id)::int AS units_done,
           (SELECT COALESCE(SUM(qty_short), 0) FROM fulfilment_lines l WHERE l.fulfilment_id = f.id)::int AS units_short,
           (SELECT COUNT(*) FROM fulfilment_lines l WHERE l.fulfilment_id = f.id)::int AS lines,
           (SELECT COUNT(*) FROM fulfilment_packages p WHERE p.fulfilment_id = f.id)::int AS packages,
           EXTRACT(EPOCH FROM (NOW() - f.created_at))::int / 60 AS age_min
      FROM fulfilments f LEFT JOIN users pk ON pk.id = f.picker_id`;

  async function detail(id, q = query) {
    const { rows } = await q(LIST_SQL + ' WHERE f.id = $1', [id]);
    if (!rows.length) throw httpError(404, 'Order not found');
    const f = rows[0];
    const { rows: full } = await q('SELECT customer_phone, customer_email, track_token, received_by_name, notes, (pickup_code IS NOT NULL) AS has_code, pickup_attempts, authorised_collector, collected_by_other, id_checked FROM fulfilments WHERE id = $1', [id]);
    Object.assign(f, full[0]);
    // Route order: each line with the bin to take it from (main bin if it has stock,
    // else the bin holding most), walked by pick_sequence then aisle/number.
    const { rows: lines } = await q(
      `SELECT l.*, p.name AS product_name, p.stock_count, b.code AS picked_bin,
              sb.bin_id AS suggest_bin_id, sb.code AS suggest_bin, sb.kind AS suggest_kind, sb.qty AS suggest_qty,
              pu.name AS picked_by_name
         FROM fulfilment_lines l
         LEFT JOIN products p ON p.img = l.product_img
         LEFT JOIN bins b ON b.id = l.bin_id
         LEFT JOIN users pu ON pu.id = l.picked_by
         LEFT JOIN LATERAL (
           SELECT s.bin_id, bb.code, bb.kind, s.qty, bb.pick_sequence FROM stock_by_bin s JOIN bins bb ON bb.id = s.bin_id
            WHERE s.product_img = l.product_img AND bb.kind <> 'damaged'
            ORDER BY (upper(bb.code) = wh_norm_bin(p.bin_location) AND s.qty > 0) DESC, s.qty DESC LIMIT 1) sb ON true
        WHERE l.fulfilment_id = $1
        ORDER BY sb.pick_sequence NULLS LAST,
                 substring(COALESCE(sb.code, wh_norm_bin(p.bin_location), 'ZZZ') FROM '^[A-Z &]+') NULLS LAST,
                 NULLIF(substring(COALESCE(sb.code, wh_norm_bin(p.bin_location), '') FROM '[0-9]+'), '')::int NULLS LAST,
                 COALESCE(sb.code, wh_norm_bin(p.bin_location)), l.id`, [id]);
    f.lines = lines;
    const { rows: packages } = await q('SELECT * FROM fulfilment_packages WHERE fulfilment_id = $1 ORDER BY seq', [id]);
    const { rows: events } = await q(
      `SELECT e.kind, e.note, e.created_at, e.public, u.name AS by_name FROM fulfilment_events e
         LEFT JOIN users u ON u.id = e.by_user WHERE e.fulfilment_id = $1 ORDER BY e.created_at, e.id`, [id]);
    f.packages = packages; f.events = events;
    f.payment = await paymentOf(f, q);
    return f;
  }

  app.get('/api/out/queue', gate, cap('fulfil.pick'), async (req, res) => {
    try {
      const st = String(req.query.status || 'open');
      // open = everything still in the building / on the road; done = finished in the last 3 days.
      const where = st === 'done'
        ? `f.status = ANY($1::text[]) AND COALESCE(f.completed_at, f.created_at) > NOW() - INTERVAL '3 days'`
        : `f.status = ANY($1::text[])`;
      const statuses = st === 'open' ? OPEN : st === 'done' ? ['delivered', 'collected', 'cancelled'] : st.split(',');
      const q = String(req.query.q || '').trim();
      const { rows } = await query(
        `SELECT * FROM (${LIST_SQL} WHERE ${where}) x
          WHERE ($2 = '' OR x.number ILIKE $3 OR x.source_ref ILIKE $3 OR x.customer_name ILIKE $3)
          ORDER BY x.on_hold, x.priority DESC, x.created_at LIMIT 300`, [statuses, q, '%' + q + '%']);
      res.json({ orders: rows });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/out/f/:id', gate, cap('fulfil.pick'), async (req, res) => {
    try { res.json({ order: await detail(req.params.id) }); } catch (e) { fail(res, e); }
  });

  // Find an order from anything printed on its paperwork: F-000123, receipt number, PKG:F-000123-2.
  app.get('/api/out/find', gate, cap('fulfil.pick'), async (req, res) => {
    try {
      let code = String(req.query.code || '').trim().replace(/^(ORDER|PKG|FUL):/i, '');
      code = code.replace(/-\d+$/, (m) => (/^F-\d{6}-\d+$/i.test(code) ? '' : m));
      const { rows } = await query(
        `SELECT id FROM fulfilments WHERE upper(number) = upper($1) OR upper(source_ref) = upper($1) ORDER BY id DESC LIMIT 1`, [code]);
      if (!rows.length) throw httpError(404, 'No order matches "' + code + '"');
      res.json({ order: await detail(rows[0].id) });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------ manual create / cancel --
  app.post('/api/out/from-sale', gate, cap('fulfil.manage'), async (req, res) => {
    try {
      const b = req.body || {};
      const out = await tx(async (c) => {
        if (b.web_order_id) return createFromWebOrder(c, parseInt(b.web_order_id, 10), { method: b.method, userId: req.session.userId, req });
        let saleId = parseInt(b.sale_id, 10);
        if (!saleId && b.receipt_number) {
          const { rows } = await c.query('SELECT id FROM pos_sales WHERE upper(receipt_number) = upper($1)', [String(b.receipt_number).trim()]);
          if (!rows.length) throw httpError(404, 'No sale with receipt ' + b.receipt_number);
          saleId = rows[0].id;
        }
        if (!saleId) throw httpError(400, 'Which sale?');
        const method = ['pickup', 'delivery', 'shipping'].includes(b.method) ? b.method : undefined;
        return createFromSale(c, saleId, { method, ship_to: b.ship_to, userId: req.session.userId, req });
      });
      if (!out) throw httpError(400, 'That sale has no parts to pick (labour or services only)');
      if (!out.existed) await tell(out.id, 'order_received', { userId: req.session.userId });
      res.json({ existed: out.existed, order: await detail(out.id) });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/out/f/:id/cancel', gate, cap('fulfil.manage'), async (req, res) => {
    try {
      const reason = String((req.body || {}).reason || '').trim();
      if (reason.length < 3) throw httpError(400, 'Give a reason');
      await tx(async (c) => {
        const { rows } = await c.query(`UPDATE fulfilments SET status = 'cancelled', completed_at = NOW() WHERE id = $1 AND status = ANY($2::text[]) RETURNING id`, [req.params.id, OPEN]);
        if (!rows.length) throw httpError(409, 'Only an open order can be cancelled');
        await event(c.query.bind(c), req.params.id, 'cancelled', reason, req, true);
      });
      res.json({ order: await detail(req.params.id) });
    } catch (e) { fail(res, e); }
  });

  // ----------------------------------------------------------------- holds --
  app.post('/api/out/f/:id/hold', gate, cap('fulfil.hold'), async (req, res) => {
    try {
      const reason = String((req.body || {}).reason || '').trim();
      if (reason.length < 3) throw httpError(400, 'Give a reason for the hold');
      await tx(async (c) => {
        const { rows } = await c.query(
          `UPDATE fulfilments SET on_hold = true, hold_reason = $2, held_by = $3, held_at = NOW()
            WHERE id = $1 AND status = ANY($4::text[]) AND NOT on_hold RETURNING id`, [req.params.id, reason, req.session.userId, OPEN]);
        if (!rows.length) throw httpError(409, 'Order is closed or already on hold');
        await event(c.query.bind(c), req.params.id, 'hold', reason, req, false);
      });
      res.json({ order: await detail(req.params.id) });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/out/f/:id/release', gate, cap('fulfil.hold'), async (req, res) => {
    try {
      await tx(async (c) => {
        const { rows } = await c.query(`UPDATE fulfilments SET on_hold = false WHERE id = $1 AND on_hold RETURNING hold_reason`, [req.params.id]);
        if (!rows.length) throw httpError(409, 'Order is not on hold');
        await event(c.query.bind(c), req.params.id, 'release', String((req.body || {}).note || ''), req, false);
      });
      res.json({ order: await detail(req.params.id) });
    } catch (e) { fail(res, e); }
  });

  async function lockOpen(c, id, allowed) {
    const { rows } = await c.query('SELECT * FROM fulfilments WHERE id = $1 FOR UPDATE', [id]);
    if (!rows.length) throw httpError(404, 'Order not found');
    const f = rows[0];
    if (f.on_hold) throw httpError(423, 'On hold: ' + (f.hold_reason || 'ask a manager'));
    if (allowed && !allowed.includes(f.status)) throw httpError(409, 'This order is ' + f.status);
    return f;
  }

  // --------------------------------------------------------------- picking --
  app.post('/api/out/f/:id/start-pick', gate, cap('fulfil.pick'), async (req, res) => {
    try {
      await tx(async (c) => {
        const f = await lockOpen(c, req.params.id, ['new', 'picking']);
        if (f.status === 'picking' && f.picker_id && f.picker_id !== req.session.userId && !(req.body || {}).take_over) {
          const { rows: u } = await c.query('SELECT name FROM users WHERE id = $1', [f.picker_id]);
          throw httpError(409, (u[0] ? u[0].name : 'Someone') + ' is already picking this order. Take it over?');
        }
        await c.query(`UPDATE fulfilments SET status = 'picking', picker_id = $2, pick_started_at = COALESCE(pick_started_at, NOW()) WHERE id = $1`, [f.id, req.session.userId]);
        await event(c.query.bind(c), f.id, 'pick_start', f.status === 'picking' ? 'taken over' : null, req, true);
      });
      res.json({ order: await detail(req.params.id) });
    } catch (e) { fail(res, e); }
  });

  // Scan a part (and optionally the bin it came from). Adds 1 to that line.
  app.post('/api/out/f/:id/pick-scan', gate, cap('fulfil.pick'), async (req, res) => {
    try {
      const b = req.body || {};
      const raw = String(b.code || '').trim().replace(/^(ITEM|SKU):/i, '');
      const qty = Math.max(1, parseInt(b.qty, 10) || 1);
      let picked = null;
      await tx(async (c) => {
        const f = await lockOpen(c, req.params.id, ['picking']);
        if (f.picker_id !== req.session.userId) throw httpError(409, 'Start picking this order first');
        const { rows: p } = await c.query(`SELECT img, sku FROM products WHERE upper(sku) = upper($1) OR upper(barcode) = upper($1) OR img = $1 LIMIT 1`, [raw]);
        if (!p.length) throw httpError(404, 'Unknown part "' + raw + '"');
        const { rows: line } = await c.query(
          `SELECT * FROM fulfilment_lines WHERE fulfilment_id = $1 AND product_img = $2 AND qty_picked + qty_short < qty ORDER BY id LIMIT 1`, [f.id, p[0].img]);
        if (!line.length) {
          const { rows: any } = await c.query('SELECT 1 FROM fulfilment_lines WHERE fulfilment_id = $1 AND product_img = $2', [f.id, p[0].img]);
          throw httpError(409, any.length ? 'Already have enough ' + p[0].sku : 'Wrong part: ' + p[0].sku + ' is not on this order');
        }
        let binId = null;
        if (b.bin_code) {
          const { rows: bn } = await c.query('SELECT id FROM bins WHERE upper(code) = upper($1)', [String(b.bin_code).replace(/^BIN:/i, '')]);
          binId = bn.length ? bn[0].id : null;
        }
        const add = Math.min(qty, line[0].qty - line[0].qty_picked - line[0].qty_short);
        await c.query(
          `UPDATE fulfilment_lines SET qty_picked = qty_picked + $2, picked_by = $3, picked_at = NOW(), bin_id = COALESCE($4, bin_id) WHERE id = $1`,
          [line[0].id, add, req.session.userId, binId]);
        picked = { sku: p[0].sku, line_id: line[0].id, now: line[0].qty_picked + add, of: line[0].qty };
      });
      res.json({ picked, order: await detail(req.params.id) });
    } catch (e) { fail(res, e); }
  });

  // Set a line by hand, or record a shortage.
  app.patch('/api/out/f/:id/lines/:lineId', gate, cap('fulfil.pick'), async (req, res) => {
    try {
      const b = req.body || {};
      await tx(async (c) => {
        const f = await lockOpen(c, req.params.id, ['picking']);
        const { rows: l } = await c.query('SELECT * FROM fulfilment_lines WHERE id = $1 AND fulfilment_id = $2 FOR UPDATE', [req.params.lineId, f.id]);
        if (!l.length) throw httpError(404, 'Line not found');
        const picked = b.qty_picked !== undefined ? parseInt(b.qty_picked, 10) : l[0].qty_picked;
        const short = b.qty_short !== undefined ? parseInt(b.qty_short, 10) : l[0].qty_short;
        if (!(picked >= 0 && short >= 0 && picked + short <= l[0].qty)) throw httpError(400, 'Picked plus short cannot be more than ' + l[0].qty);
        const reason = short > 0 ? (['not_found', 'damaged', 'wrong_part', 'other'].includes(b.short_reason) ? b.short_reason : (l[0].short_reason || 'not_found')) : null;
        await c.query(`UPDATE fulfilment_lines SET qty_picked = $2, qty_short = $3, short_reason = $4, picked_by = $5, picked_at = NOW() WHERE id = $1`,
          [l[0].id, picked, short, reason, req.session.userId]);
        if (short > l[0].qty_short) await event(c.query.bind(c), f.id, 'short', (short - l[0].qty_short) + ' x ' + l[0].sku + ' (' + reason.replace('_', ' ') + ')', req, false);
      });
      res.json({ order: await detail(req.params.id) });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/out/f/:id/finish-pick', gate, cap('fulfil.pick'), async (req, res) => {
    try {
      await tx(async (c) => {
        const f = await lockOpen(c, req.params.id, ['picking']);
        const { rows } = await c.query(
          `SELECT COUNT(*) FILTER (WHERE qty_picked + qty_short < qty)::int AS open, COALESCE(SUM(qty_short),0)::int AS short, COALESCE(SUM(qty_picked),0)::int AS picked
             FROM fulfilment_lines WHERE fulfilment_id = $1`, [f.id]);
        if (rows[0].open) throw httpError(409, rows[0].open + ' line(s) not picked yet. Pick them or mark them short.');
        await c.query(`UPDATE fulfilments SET status = 'picked', picked_at = NOW() WHERE id = $1`, [f.id]);
        await event(c.query.bind(c), f.id, 'picked', rows[0].short ? rows[0].short + ' unit(s) short' : null, req, true);
      });
      res.json({ order: await detail(req.params.id) });
    } catch (e) { fail(res, e); }
  });

  // --------------------------------------------------------------- packing --
  // Tell the customer about a step (notify.js picks the channels and logs every
  // attempt). Walk-in / shared till accounts are skipped there: their pickup
  // code goes on the printed ticket instead. Returns the channels that went.
  async function tell(fId, ev, opts) {
    opts = opts || {};
    try {
      if (!notify || (await setting('fulfil_notify', 'on')) !== 'on') return [];
      const { rows } = await query(
        `SELECT f.*, COALESCE(s.customer_id, o.user_id) AS customer_id FROM fulfilments f
           LEFT JOIN pos_sales s ON f.source_kind = 'pos_sale' AND s.id = f.source_id
           LEFT JOIN orders o ON f.source_kind = 'web_order' AND o.id = f.source_id
          WHERE f.id = $1`, [fId]);
      if (!rows.length) return [];
      const f = rows[0];
      const evName = typeof ev === 'function' ? ev(f) : ev;
      const res = await notify.send(evName, {
        name: f.customer_name, phone: f.customer_phone, email: f.customer_email, customer_id: f.customer_id,
        number: f.number, code: f.pickup_code, carrier: f.carrier, tracking: f.tracking_number, received_by: f.received_by_name, track_token: f.track_token,
      }, { related_kind: 'fulfilment', related_id: f.id, by_user: opts.userId || null, force: !!opts.force });
      const went = res.filter((n) => ['sent', 'stubbed', 'queued'].includes(n.status)).map((n) => (n.channel === 'sms' ? 'SMS' : n.channel));
      if (went.length) await event(query, f.id, 'notified', 'Customer told by ' + went.join(' and ') + ' (' + evName.replace(/_/g, ' ') + ')', null, false);
      return went;
    } catch (e) { console.warn('[out] notify', e.message); return []; }
  }

  // {packages: [{kind, weight_kg, contents}]}; empty list = one bag. Marks the order ready.
  app.post('/api/out/f/:id/pack', gate, cap('fulfil.pack'), async (req, res) => {
    try {
      const pk = Array.isArray((req.body || {}).packages) && req.body.packages.length ? req.body.packages : [{ kind: 'bag' }];
      if (pk.length > 50) throw httpError(400, 'At most 50 packages');
      let readyRow = null;
      await tx(async (c) => {
        const f = await lockOpen(c, req.params.id, ['picked', 'packed']);
        const { rows: p } = await c.query('SELECT COALESCE(SUM(qty_picked),0)::int AS n FROM fulfilment_lines WHERE fulfilment_id = $1', [f.id]);
        if (!p[0].n) throw httpError(409, 'Nothing was picked: cancel the order instead');
        await c.query('DELETE FROM fulfilment_packages WHERE fulfilment_id = $1', [f.id]);
        let seq = 0;
        for (const x of pk) {
          const kind = ['bag', 'box', 'tyre', 'pallet', 'envelope'].includes(x.kind) ? x.kind : 'box';
          const w = x.weight_kg === '' || x.weight_kg == null ? null : Number(x.weight_kg);
          await c.query(`INSERT INTO fulfilment_packages (fulfilment_id, seq, kind, weight_kg, contents, created_by) VALUES ($1, $2, $3, $4, $5, $6)`,
            [f.id, ++seq, kind, Number.isFinite(w) ? w : null, x.contents ? String(x.contents).slice(0, 300) : null, req.session.userId]);
        }
        const code = f.method === 'pickup' ? (f.pickup_code || newCode()) : f.pickup_code;
        const { rows: u } = await c.query(
          `UPDATE fulfilments SET status = 'ready', packer_id = $2, packed_at = NOW(), ready_at = COALESCE(ready_at, NOW()), pickup_code = $3
            WHERE id = $1 RETURNING *`, [f.id, req.session.userId, code]);
        readyRow = u[0];
        await event(c.query.bind(c), f.id, 'packed', seq + ' package(s)', req, false);
        await event(c.query.bind(c), f.id, 'ready', f.method === 'pickup' ? 'Ready for pickup' : 'Packed, waiting for dispatch', req, true);
      });
      const sent = await tell(readyRow.id, (f) => (f.method === 'pickup' ? 'ready_pickup' : 'ready_delivery'), { userId: req.session.userId });
      res.json({ notified: sent, order: await detail(req.params.id) });
    } catch (e) { fail(res, e); }
  });

  // Customer ticket for the counter: order number + pickup code (+ tracking token
  // for the QR). Printing it is logged; the code is not shown anywhere else.
  app.get('/api/out/f/:id/ticket', gate, cap('fulfil.manage'), async (req, res) => {
    try {
      const { rows } = await query(`SELECT id, number, customer_name, method, pickup_code, track_token, status FROM fulfilments WHERE id = $1`, [req.params.id]);
      if (!rows.length) throw httpError(404, 'Order not found');
      const f = rows[0];
      if (f.method !== 'pickup' || !f.pickup_code) throw httpError(409, 'Only pickup orders have a ticket');
      if (!OPEN.includes(f.status)) throw httpError(409, 'This order is ' + f.status);
      await event(query, f.id, 'ticket', 'Customer ticket printed', req, false);
      res.json({ number: f.number, name: maskName(f.customer_name), code: f.pickup_code, track_token: f.track_token });
    } catch (e) { fail(res, e); }
  });

  // Re-send the pickup code (customer lost it). A new code replaces the old one.
  app.post('/api/out/f/:id/resend-code', gate, cap('fulfil.collect'), async (req, res) => {
    try {
      let row = null;
      await tx(async (c) => {
        const f = await lockOpen(c, req.params.id, ['ready']);
        if (f.method !== 'pickup') throw httpError(409, 'Only pickup orders have a code');
        const { rows } = await c.query('UPDATE fulfilments SET pickup_code = $2, pickup_attempts = 0 WHERE id = $1 RETURNING *', [f.id, newCode()]);
        row = rows[0];
        await event(c.query.bind(c), f.id, 'notified', 'New pickup code sent', req, false);
      });
      const sent = await tell(row.id, 'ready_pickup', { userId: req.session.userId, force: true });
      res.json({ notified: sent });
    } catch (e) { fail(res, e); }
  });

  // --------------------------------------------------------- counter pickup --
  // Staff look the order up first (shows payment state), then enter the code the customer gives.
  app.post('/api/out/collect', gate, cap('fulfil.collect'), async (req, res) => {
    try {
      const b = req.body || {};
      const out = await tx(async (c) => {
        const { rows: fr } = await c.query('SELECT id FROM fulfilments WHERE id = $1 OR upper(number) = upper($2) LIMIT 1', [parseInt(b.id, 10) || 0, String(b.number || '')]);
        if (!fr.length) throw httpError(404, 'Order not found');
        const f = await lockOpen(c, fr[0].id, ['ready']);
        if (f.method !== 'pickup') throw httpError(409, 'This order is for ' + f.method + ', not counter pickup');
        if (f.pickup_attempts >= 5) throw httpError(423, 'Too many wrong codes. A manager must send the customer a new code.');
        if (!sameCode(f.pickup_code, String(b.code || '').trim())) {
          await c.query('UPDATE fulfilments SET pickup_attempts = pickup_attempts + 1 WHERE id = $1', [f.id]);
          await event(c.query.bind(c), f.id, 'pickup_failed', 'Wrong pickup code', req, false);
          return { failed: true, left: 4 - f.pickup_attempts };
        }
        const pay = await paymentOf(f, c.query.bind(c));
        if (!pay.paid) throw httpError(402, 'Not paid: ' + pay.label + '. Send the customer to the cashier first.');
        // Someone else collecting needs the code AND photo ID, recorded (type + last 4).
        const other = b.collector === 'other';
        const who = String((other ? b.received_by_name : b.received_by_name || f.customer_name) || '').trim().slice(0, 120);
        const idType = String(b.id_type || '').trim().slice(0, 40), idRef = String(b.id_ref || '').replace(/\s/g, '').slice(-4);
        if (other && who.length < 2) throw httpError(400, 'Name of the person collecting, as on their ID');
        if (other && (!idType || idRef.length < 3)) throw httpError(400, 'Someone collecting for the customer must show photo ID: record the ID type and its last 4 characters');
        const idChecked = idType ? idType + (idRef ? ' …' + idRef : '') : null;
        await c.query(`UPDATE fulfilments SET status = 'collected', completed_at = NOW(), completed_by = $2, received_by_name = $3, collected_by_other = $4, id_checked = $5 WHERE id = $1`,
          [f.id, req.session.userId, who, other, idChecked]);
        await event(c.query.bind(c), f.id, 'collected', 'Collected' + (who ? ' by ' + who : '') + (other ? ' for the customer' : ''), req, true);
        if (idChecked) await event(c.query.bind(c), f.id, 'id_checked', idChecked + (f.authorised_collector && other ? ' · customer named ' + f.authorised_collector : ''), req, false);
        return { failed: false, id: f.id };
      });
      if (out.failed) return res.status(403).json({ error: 'Wrong pickup code.' + (out.left > 0 ? ' ' + out.left + ' tries left.' : ' Order is now locked.') });
      await tell(out.id, 'collected', { userId: req.session.userId });
      res.json({ ok: true, order: await detail(out.id) });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------------ dispatching --
  app.post('/api/out/manifests', gate, cap('fulfil.dispatch'), async (req, res) => {
    try {
      const b = req.body || {};
      const ids = (Array.isArray(b.fulfilment_ids) ? b.fulfilment_ids : []).map((x) => parseInt(x, 10)).filter(Boolean);
      if (!ids.length) throw httpError(400, 'Choose the orders going out');
      const id = await tx(async (c) => {
        const { rows: fs } = await c.query(`SELECT id, number, status, method, on_hold FROM fulfilments WHERE id = ANY($1::int[]) FOR UPDATE`, [ids]);
        const bad = fs.filter((f) => f.on_hold || f.status !== 'ready' || f.method === 'pickup');
        if (bad.length || fs.length !== ids.length) throw httpError(409, 'Only packed delivery or shipping orders that are not on hold can go on a manifest' + (bad.length ? ': ' + bad.map((x) => x.number).join(', ') : ''));
        const kind = b.kind === 'carrier' ? 'carrier' : 'delivery';
        const { rows: m } = await c.query(
          `INSERT INTO manifests (kind, carrier, driver_name, vehicle, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [kind, b.carrier || null, b.driver_name || null, b.vehicle || null, req.session.userId]);
        await c.query(`UPDATE manifests SET number = 'M-' || lpad(id::text, 6, '0') WHERE id = $1`, [m[0].id]);
        await c.query(`UPDATE fulfilments SET manifest_id = $2, carrier = COALESCE($3, carrier) WHERE id = ANY($1::int[])`, [ids, m[0].id, b.carrier || null]);
        return m[0].id;
      });
      res.json({ manifest: await manifestDetail(id) });
    } catch (e) { fail(res, e); }
  });

  async function manifestDetail(id) {
    const { rows } = await query(`SELECT m.*, u.name AS created_by_name FROM manifests m LEFT JOIN users u ON u.id = m.created_by WHERE m.id = $1`, [id]);
    if (!rows.length) throw httpError(404, 'Manifest not found');
    const { rows: fs } = await query(LIST_SQL + ' WHERE f.manifest_id = $1 ORDER BY f.id', [id]);
    return Object.assign(rows[0], { orders: fs });
  }
  app.get('/api/out/manifests', gate, cap('fulfil.dispatch'), async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT m.*, (SELECT COUNT(*) FROM fulfilments f WHERE f.manifest_id = m.id)::int AS orders FROM manifests m
          WHERE m.status <> 'closed' OR m.created_at > NOW() - INTERVAL '7 days' ORDER BY m.id DESC LIMIT 50`);
      res.json({ manifests: rows });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/out/manifests/:id', gate, cap('fulfil.dispatch'), async (req, res) => {
    try { res.json({ manifest: await manifestDetail(req.params.id) }); } catch (e) { fail(res, e); }
  });

  // Truck leaves: every order on it is out for delivery / handed to the carrier.
  app.post('/api/out/manifests/:id/dispatch', gate, cap('fulfil.dispatch'), async (req, res) => {
    try {
      await tx(async (c) => {
        const { rows: m } = await c.query(`SELECT * FROM manifests WHERE id = $1 FOR UPDATE`, [req.params.id]);
        if (!m.length) throw httpError(404, 'Manifest not found');
        if (m[0].status !== 'open') throw httpError(409, 'Already dispatched');
        const { rows: fs } = await c.query(`SELECT * FROM fulfilments WHERE manifest_id = $1 FOR UPDATE`, [m[0].id]);
        const held = fs.filter((f) => f.on_hold);
        if (held.length) throw httpError(423, 'On hold, take them off the manifest first: ' + held.map((f) => f.number).join(', '));
        for (const f of fs) {
          await c.query(`UPDATE fulfilments SET status = 'dispatched', dispatched_at = NOW() WHERE id = $1`, [f.id]);
          await event(c.query.bind(c), f.id, 'dispatched', m[0].kind === 'carrier' ? 'Handed to ' + (m[0].carrier || 'carrier') : 'Out for delivery', req, true);
          if (f.method === 'delivery') {
            const to = f.ship_to || {};
            await c.query(
              `INSERT INTO deliveries (delivery_number, related_kind, related_id, recipient_name, recipient_phone, address, vehicle, status, dispatched_at, notes, created_by)
               VALUES ($1, 'fulfilment', $2, $3, $4, $5, $6, 'dispatched', NOW(), $7, $8)
               ON CONFLICT (delivery_number) DO UPDATE SET status = 'dispatched', dispatched_at = NOW(), delivered_at = NULL, vehicle = EXCLUDED.vehicle,
                 notes = CONCAT_WS(' | ', deliveries.notes, 'Re-sent: ' || EXCLUDED.notes)`,
              [f.number, f.id, to.name || f.customer_name || 'Customer', to.phone || f.customer_phone || null,
               [to.line1, to.line2, to.city, to.parish].filter(Boolean).join(', ') || null, m[0].vehicle || null,
               m[0].number + (m[0].driver_name ? ' · driver ' + m[0].driver_name : ''), req.session.userId]);
          }
        }
        await c.query(`UPDATE manifests SET status = 'dispatched', dispatched_at = NOW() WHERE id = $1`, [m[0].id]);
        return { kind: m[0].kind, ids: fs.map((f) => f.id) };
      }).then(async (sent) => {
        for (const id of sent.ids) await tell(id, sent.kind === 'carrier' ? 'shipped' : 'out_for_delivery', { userId: req.session.userId });
      });
      res.json({ manifest: await manifestDetail(req.params.id) });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/out/f/:id/delivered', gate, cap('fulfil.dispatch'), async (req, res) => {
    try {
      const who = String((req.body || {}).received_by_name || '').trim();
      if (who.length < 2) throw httpError(400, 'Who received it?');
      await tx(async (c) => {
        const f = await lockOpen(c, req.params.id, ['dispatched']);
        await c.query(`UPDATE fulfilments SET status = 'delivered', completed_at = NOW(), completed_by = $2, received_by_name = $3 WHERE id = $1`, [f.id, req.session.userId, who.slice(0, 120)]);
        await c.query(`UPDATE deliveries SET status = 'delivered', delivered_at = NOW(), recipient_received_by = $2 WHERE related_kind = 'fulfilment' AND related_id = $1`, [f.id, who.slice(0, 120)]);
        await event(c.query.bind(c), f.id, 'delivered', 'Received by ' + who, req, true);
        if (f.manifest_id) {
          await c.query(
            `UPDATE manifests SET status = 'closed', closed_at = NOW() WHERE id = $1
               AND NOT EXISTS (SELECT 1 FROM fulfilments WHERE manifest_id = $1 AND status = 'dispatched')`, [f.manifest_id]);
        }
      });
      await tell(parseInt(req.params.id, 10), 'delivered', { userId: req.session.userId });
      res.json({ order: await detail(req.params.id) });
    } catch (e) { fail(res, e); }
  });

  // Driver could not deliver (nobody home, wrong address, refused): the order
  // comes back to "packed, waiting to go out" for the next run; the attempt is
  // kept for the delivery report.
  app.post('/api/out/f/:id/attempt-failed', gate, cap('fulfil.dispatch'), async (req, res) => {
    try {
      const reasons = { not_home: 'Nobody there', wrong_address: 'Wrong or incomplete address', refused: 'Refused', no_payment: 'Payment not ready', other: 'Other' };
      const b = req.body || {};
      const why = reasons[b.reason] ? b.reason : 'other';
      const note = String(b.note || '').trim().slice(0, 200);
      await tx(async (c) => {
        const f = await lockOpen(c, req.params.id, ['dispatched']);
        await c.query(`UPDATE fulfilments SET status = 'ready', manifest_id = NULL, dispatched_at = NULL WHERE id = $1`, [f.id]);
        await c.query(`UPDATE deliveries SET status = 'cancelled', notes = CONCAT_WS(' | ', notes, $2::text) WHERE related_kind = 'fulfilment' AND related_id = $1 AND status = 'dispatched'`,
          [f.id, 'Failed: ' + reasons[why] + (note ? ' - ' + note : '')]);
        await event(c.query.bind(c), f.id, 'delivery_failed', reasons[why] + (note ? ': ' + note : ''), req, false);
        await event(c.query.bind(c), f.id, 'ready', 'Delivery attempt missed; we will try again', req, true);
        if (f.manifest_id) {
          await c.query(
            `UPDATE manifests SET status = 'closed', closed_at = NOW() WHERE id = $1
               AND NOT EXISTS (SELECT 1 FROM fulfilments WHERE manifest_id = $1 AND status = 'dispatched')`, [f.manifest_id]);
        }
      });
      res.json({ order: await detail(req.params.id) });
    } catch (e) { fail(res, e); }
  });

  // Who the customer says may collect for them (still needs the code and ID).
  app.post('/api/out/f/:id/collector', gate, cap('fulfil.collect'), async (req, res) => {
    try {
      const name = String((req.body || {}).name || '').trim().slice(0, 120) || null;
      const { rowCount } = await query(`UPDATE fulfilments SET authorised_collector = $2 WHERE id = $1 AND status = ANY($3::text[])`, [req.params.id, name, OPEN]);
      if (!rowCount) throw httpError(409, 'Order is closed');
      await event(query, parseInt(req.params.id, 10), 'collector', name ? 'Customer says ' + name + ' may collect' : 'Named collector removed', req, false);
      res.json({ order: await detail(req.params.id) });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------ delivery report --
  // One period: delivery runs, on-time (same / next day), failed attempts,
  // ready-to-delivered time, per driver; pickups left uncollected.
  app.get('/api/out/reports/delivery', gate, cap('fulfil.dispatch'), async (req, res) => {
    try {
      const iso = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s || '') ? s : null);
      const from = iso(req.query.from), to = iso(req.query.to);
      if (!from || !to || from > to) throw httpError(400, 'Choose a from and to date');
      const TZ = 'America/Jamaica';
      const P = [from, to];
      const RANGE = (col) => `${col} >= ($1::date)::timestamp AT TIME ZONE '${TZ}' AND ${col} < ($2::date + 1)::timestamp AT TIME ZONE '${TZ}'`;
      const { rows: sum } = await query(
        `SELECT COUNT(*) FILTER (WHERE status = 'delivered')::int AS delivered,
                COUNT(*) FILTER (WHERE status = 'delivered' AND method = 'shipping')::int AS shipped,
                ROUND(AVG(EXTRACT(EPOCH FROM (completed_at - ready_at)) / 3600) FILTER (WHERE status = 'delivered' AND ready_at IS NOT NULL)::numeric, 1) AS avg_ready_to_delivered_h,
                ROUND(AVG(EXTRACT(EPOCH FROM (completed_at - created_at)) / 3600) FILTER (WHERE status = 'delivered')::numeric, 1) AS avg_order_to_delivered_h,
                COUNT(*) FILTER (WHERE status = 'delivered' AND (completed_at AT TIME ZONE '${TZ}')::date <= (created_at AT TIME ZONE '${TZ}')::date + 1)::int AS next_day,
                COUNT(*) FILTER (WHERE status = 'delivered' AND NOT EXISTS (SELECT 1 FROM fulfilment_events e WHERE e.fulfilment_id = fulfilments.id AND e.kind = 'delivery_failed'))::int AS first_time,
                COUNT(*) FILTER (WHERE status = 'collected')::int AS collected,
                COUNT(*) FILTER (WHERE status = 'collected' AND collected_by_other)::int AS collected_by_other,
                ROUND(AVG(EXTRACT(EPOCH FROM (completed_at - ready_at)) / 3600) FILTER (WHERE status = 'collected' AND ready_at IS NOT NULL)::numeric, 1) AS avg_ready_to_collected_h
           FROM fulfilments WHERE ${RANGE('completed_at')}`, P);
      const { rows: failed } = await query(
        `SELECT e.note, COUNT(*)::int AS n FROM fulfilment_events e WHERE e.kind = 'delivery_failed' AND ${RANGE('e.created_at')}
          GROUP BY e.note ORDER BY 2 DESC`, P);
      const { rows: drivers } = await query(
        `SELECT COALESCE(NULLIF(m.driver_name, ''), NULLIF(m.carrier, ''), 'Not recorded') AS driver, m.kind,
                COUNT(DISTINCT m.id)::int AS runs, COUNT(f.id) FILTER (WHERE f.status = 'delivered')::int AS delivered,
                ROUND(AVG(EXTRACT(EPOCH FROM (f.completed_at - m.dispatched_at)) / 3600) FILTER (WHERE f.status = 'delivered')::numeric, 1) AS avg_on_road_h
           FROM manifests m LEFT JOIN fulfilments f ON f.manifest_id = m.id
          WHERE ${RANGE('m.dispatched_at')} GROUP BY 1, 2 ORDER BY delivered DESC`, P);
      const { rows: fe } = await query(
        `SELECT COUNT(DISTINCT e.fulfilment_id)::int AS orders, COUNT(*)::int AS attempts FROM fulfilment_events e
          WHERE e.kind = 'delivery_failed' AND ${RANGE('e.created_at')}`, P);
      const days = parseInt(await setting('pickup_uncollected_days', '7'), 10) || 7;
      const { rows: unc } = await query(
        `SELECT f.id, f.number, f.customer_name, f.customer_phone, f.ready_at, (CURRENT_DATE - (f.ready_at AT TIME ZONE '${TZ}')::date) AS days_waiting,
                (SELECT COALESCE(SUM(qty_picked), 0) FROM fulfilment_lines l WHERE l.fulfilment_id = f.id)::int AS units
           FROM fulfilments f WHERE f.status = 'ready' AND f.method = 'pickup' AND f.ready_at < NOW() - make_interval(days => $1)
          ORDER BY f.ready_at LIMIT 200`, [days]);
      const { rows: road } = await query(
        `SELECT f.id, f.number, f.customer_name, f.dispatched_at, m.number AS manifest, COALESCE(m.driver_name, m.carrier) AS driver,
                ROUND(EXTRACT(EPOCH FROM (NOW() - f.dispatched_at)) / 3600)::int AS hours_out
           FROM fulfilments f LEFT JOIN manifests m ON m.id = f.manifest_id
          WHERE f.status = 'dispatched' AND f.dispatched_at < NOW() - INTERVAL '24 hours' ORDER BY f.dispatched_at LIMIT 200`);
      const s = sum[0];
      res.json({ from, to, summary: Object.assign({}, s, {
          next_day_pct: s.delivered ? Math.round(s.next_day / s.delivered * 1000) / 10 : null,
          failed_orders: fe[0].orders, failed_attempts: fe[0].attempts,
          first_time_pct: s.delivered ? Math.round(s.first_time / s.delivered * 1000) / 10 : null }),
        failed_reasons: failed, drivers, uncollected: { days, orders: unc }, out_too_long: road });
    } catch (e) { fail(res, e); }
  });

  // Shipping with a carrier: record the tracking number on the order.
  app.patch('/api/out/f/:id', gate, cap('fulfil.dispatch'), async (req, res) => {
    try {
      const b = req.body || {};
      const sets = [], vals = [];
      for (const k of ['carrier', 'tracking_number', 'notes']) if (b[k] !== undefined) { vals.push(b[k] || null); sets.push(`${k} = $${vals.length}`); }
      if (b.priority !== undefined) { vals.push(parseInt(b.priority, 10) || 0); sets.push(`priority = $${vals.length}`); }
      if (b.method !== undefined) {
        if (!['pickup', 'delivery', 'shipping'].includes(b.method)) throw httpError(400, 'Unknown method');
        vals.push(b.method); sets.push(`method = $${vals.length}`);
      }
      if (b.ship_to !== undefined) { vals.push(JSON.stringify(b.ship_to || null)); sets.push(`ship_to = $${vals.length}`); }
      if (!sets.length) throw httpError(400, 'Nothing to change');
      vals.push(req.params.id);
      const { rowCount } = await query(`UPDATE fulfilments SET ${sets.join(', ')} WHERE id = $${vals.length} AND status = ANY($${vals.length + 1}::text[])`, vals.concat([OPEN]));
      if (!rowCount) throw httpError(409, 'Order is closed');
      res.json({ order: await detail(req.params.id) });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------------- settings --
  app.get('/api/out/settings', gate, async (req, res) => {
    try {
      const { rows } = await query(`SELECT key, value FROM warehouse_settings WHERE key IN ('fulfil_auto','fulfil_sla_minutes','fulfil_notify','track_base_url')`);
      res.json(Object.fromEntries(rows.map((r) => [r.key, r.value])));
    } catch (e) { fail(res, e); }
  });
  app.patch('/api/out/settings', gate, cap('fulfil.manage'), async (req, res) => {
    try {
      const b = req.body || {};
      const put = (k, v) => query('INSERT INTO warehouse_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [k, v]);
      if (b.fulfil_auto !== undefined) {
        if (!['off', 'delivery', 'all'].includes(b.fulfil_auto)) throw httpError(400, 'Use off, delivery or all');
        const before = await setting('fulfil_auto', 'off');
        await put('fulfil_auto', b.fulfil_auto);
        // Turning it on starts from the latest sale; history is never swept in.
        if (before === 'off' && b.fulfil_auto !== 'off') await query(`DELETE FROM warehouse_settings WHERE key = 'fulfil_sweep_from'`);
      }
      if (b.fulfil_sla_minutes !== undefined) {
        const n = parseInt(b.fulfil_sla_minutes, 10);
        if (!(n >= 1 && n <= 1440)) throw httpError(400, 'Target must be 1 to 1440 minutes');
        await put('fulfil_sla_minutes', String(n));
      }
      if (b.fulfil_notify !== undefined) await put('fulfil_notify', b.fulfil_notify === 'on' ? 'on' : 'off');
      if (b.track_base_url !== undefined) {
        const u = String(b.track_base_url || '').trim();
        if (u && !/^https?:\/\/[^\s]+$/i.test(u)) throw httpError(400, 'Give a full web address, or leave it empty');
        await put('track_base_url', u);
      }
      const { rows } = await query(`SELECT key, value FROM warehouse_settings WHERE key IN ('fulfil_auto','fulfil_sla_minutes','fulfil_notify','track_base_url')`);
      res.json(Object.fromEntries(rows.map((r) => [r.key, r.value])));
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------- boards (staff) --
  app.get('/api/out/board', gate, cap('fulfil.pick'), async (req, res) => {
    try {
      const sla = parseInt(await setting('fulfil_sla_minutes', '15'), 10) || 15;
      const { rows: orders } = await query(`SELECT * FROM (${LIST_SQL} WHERE f.status = ANY($1::text[])) x ORDER BY x.on_hold DESC, x.priority DESC, x.created_at LIMIT 200`, [OPEN]);
      const { rows: today } = await query(
        `SELECT u.name, COUNT(*)::int AS lines, COALESCE(SUM(l.qty_picked),0)::int AS units,
                COUNT(*) FILTER (WHERE l.qty_short > 0)::int AS short_lines
           FROM fulfilment_lines l JOIN users u ON u.id = l.picked_by
          WHERE l.picked_at >= date_trunc('day', NOW()) GROUP BY u.name ORDER BY units DESC`);
      const { rows: done } = await query(
        `SELECT COUNT(*) FILTER (WHERE status IN ('collected','delivered'))::int AS completed,
                ROUND(AVG(EXTRACT(EPOCH FROM (ready_at - created_at)) / 60) FILTER (WHERE ready_at IS NOT NULL))::int AS avg_min_to_ready
           FROM fulfilments WHERE created_at >= date_trunc('day', NOW())`);
      res.json({ sla_minutes: sla, orders, pickers: today, today: done[0], at: new Date().toISOString() });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------ public screens --
  // Counter screen: no names beyond "Damion M.", no phone, no amounts.
  app.get('/api/public/order-board', async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT number, customer_name, status, method, ready_at FROM fulfilments
          WHERE method = 'pickup' AND (status IN ('new','picking','picked','packed','ready') AND created_at > NOW() - INTERVAL '2 days')
          ORDER BY created_at LIMIT 60`);
      res.set('Cache-Control', 'no-store');
      res.json({
        preparing: rows.filter((r) => r.status !== 'ready').map((r) => ({ number: r.number, name: maskName(r.customer_name) })),
        ready: rows.filter((r) => r.status === 'ready').map((r) => ({ number: r.number, name: maskName(r.customer_name) })),
      });
    } catch (e) { res.status(500).json({ error: 'unavailable' }); }
  });

  app.get('/api/public/track/:token', async (req, res) => {
    try {
      const t = String(req.params.token || '');
      if (t.length < 16) return res.status(404).json({ error: 'Not found' });
      const { rows } = await query(`SELECT id, number, customer_name, method, status, carrier, tracking_number, on_hold FROM fulfilments WHERE track_token = $1`, [t]);
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      const f = rows[0];
      const { rows: ev } = await query(`SELECT kind, note, created_at FROM fulfilment_events WHERE fulfilment_id = $1 AND public ORDER BY created_at, id`, [f.id]);
      res.set('Cache-Control', 'no-store');
      res.json({
        number: f.number, name: maskName(f.customer_name), method: f.method,
        status: f.on_hold ? 'delayed' : f.status, carrier: f.carrier, tracking_number: f.tracking_number,
        timeline: ev.map((e) => ({ kind: e.kind, note: e.note, at: e.created_at })),
      });
    } catch (e) { res.status(500).json({ error: 'unavailable' }); }
  });

  return { sweep, createFromSale, stop: () => clearInterval(sweepTimer) };
}

module.exports = { register };
