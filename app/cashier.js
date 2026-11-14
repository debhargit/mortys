// =============================================================================
//  Morty's Auto Parts -- Cashier module
//
//  Mounted by server.js BEFORE the POS sale route:
//      require('./cashier').register(app, deps)
//
//  Stations (pos_stations) are counter positions, each bound to one device by
//  a key the device sends as X-Station-Key:
//      order       builds carts; checkout saves a POS order for a cashier
//      cashier     takes payment for the order stations assigned to it
//      integrated  single-user: rings the sale and takes payment itself
//  A device with no station keeps working exactly as before.
//
//  POS orders: the endpoints the existing admin.html cashier screen calls
//  (/api/admin/pos/order, /orders, /orders/:id, /cancel, /invoice). Saving an
//  order runs the sale code as a dry run under the person who built the cart,
//  so their discount permissions are checked and the stored total is exact.
//  Taking payment replays the cart through that same sale code
//  (posSaleHandler) with the cashier's tenders.
//
//  Drawer shifts (till_sessions): one per station, opened with a float counted
//  by denomination, drops / payouts / no-sales recorded, X report while open,
//  blind close (the cashier never sees the expected figure), Z report and
//  manager review. Every sale made at a station during a shift is linked to it.
// =============================================================================
'use strict';

const crypto = require('crypto');
const pins = require('./pins');

// Jamaican dollar notes and coins, largest first.
const DENOMS = [5000, 1000, 500, 100, 50, 20, 10, 5, 1];

function register(app, deps) {
  const { query, requireAdmin, requireCap, userCan, bcrypt, posSaleHandler } = deps;
  const gate = [requireAdmin];
  // The till gates every /api/admin/pos/* route on pos.access; these load before
  // that rule, so they carry it themselves.
  const posGate = [requireAdmin, requireCap('pos.access')];

  // ---------------------------------------------------------------- helpers --
  function httpError(status, msg) { const e = new Error(msg); e.status = status; e.publicMessage = msg; return e; }
  function fail(res, e) {
    const status = e.status || 500;
    if (status >= 500) console.error('[cash]', e);
    res.status(status).json({ error: e.publicMessage || e.message });
  }
  const r2 = (v) => Math.round(Number(v || 0) * 100) / 100;
  const hashKey = (k) => crypto.createHash('sha256').update(String(k)).digest('hex');
  async function canAny(req, keys) { for (const k of keys) if (await userCan(req, k)) return true; return false; }
  function requireAny(keys, label) {
    return async (req, res, next) => (await canAny(req, keys)) ? next() : res.status(403).json({ error: 'Your account is not allowed to ' + label + '.' });
  }
  async function setting(key, dflt) {
    const { rows } = await query('SELECT value FROM warehouse_settings WHERE key = $1', [key]);
    return rows.length && rows[0].value != null ? rows[0].value : dflt;
  }
  function countTotal(count) {
    if (!count || typeof count !== 'object') return 0;
    let t = 0;
    for (const d of DENOMS) { const q = parseInt(count[d], 10); if (q > 0) t += q * d; }
    return r2(t);
  }

  async function stationOf(req) {
    const key = req.get('x-station-key');
    if (!key || key.length < 20) return null;
    const { rows } = await query('SELECT * FROM pos_stations WHERE device_key_hash = $1 AND is_active', [hashKey(key)]);
    return rows[0] || null;
  }
  async function openSession(stationId) {
    const { rows } = await query(`SELECT * FROM till_sessions WHERE station_id = $1 AND status = 'open'`, [stationId]);
    return rows[0] || null;
  }

  // The default till: what a terminal that is not set up as its own station
  // (the shop's shared counter PC) rings through. Created on first use as
  // "Main Till" (integrated) at the main store, remembered in
  // cash_default_station_id.
  async function defaultStation() {
    const id = parseInt(await setting('cash_default_station_id', ''), 10);
    if (id) {
      const { rows } = await query('SELECT * FROM pos_stations WHERE id = $1 AND is_active', [id]);
      if (rows[0]) return rows[0];
    }
    let { rows } = await query(`SELECT * FROM pos_stations WHERE lower(name) = 'main till' AND is_active LIMIT 1`);
    if (!rows[0]) {
      ({ rows } = await query(
        `INSERT INTO pos_stations (name, kind, location_id)
         VALUES ('Main Till', 'integrated', (SELECT id FROM store_locations WHERE is_default ORDER BY sort, id LIMIT 1))
         ON CONFLICT DO NOTHING RETURNING *`));
      if (!rows[0]) ({ rows } = await query(`SELECT * FROM pos_stations WHERE lower(name) = 'main till' LIMIT 1`));
    }
    if (rows[0]) {
      await query(`INSERT INTO warehouse_settings (key, value) VALUES ('cash_default_station_id', $1)
                   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [String(rows[0].id)]);
    }
    return rows[0] || null;
  }
  // This device's station, or the default till when the device is not bound.
  async function terminalStation(req) { return (await stationOf(req)) || (await defaultStation()); }
  // Open a shift with the default float (cash_default_float, J$) unless one is
  // already open; a racing second opener just gets the open one back.
  async function autoOpen(stationId, userId) {
    const float = r2(parseFloat(await setting('cash_default_float', '0')) || 0);
    try {
      const { rows } = await query(
        `INSERT INTO till_sessions (station_id, user_id, opening_float, opening_count) VALUES ($1, $2, $3, '{}'::jsonb) RETURNING *`,
        [stationId, userId, float]);
      return rows[0];
    } catch (e) {
      if (e.code === '23505') return openSession(stationId);
      throw e;
    }
  }
  const autoOpenOn = async () => (await setting('cash_auto_open', 'on')) === 'on';

  // Run a body through the real POS sale code and capture its reply.
  function runSale(req, body, cashierOrder) {
    const sreq = Object.create(req);
    sreq.body = body;
    if (cashierOrder) sreq.cashierOrder = cashierOrder;
    return new Promise((resolve) => {
      const fake = {
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        json(d) { resolve({ status: this.statusCode, body: d }); return this; },
        send(d) { resolve({ status: this.statusCode, body: d }); return this; },
        set() { return this; }, setHeader() { return this; },
      };
      Promise.resolve(posSaleHandler(sreq, fake)).catch((e) => resolve({ status: 500, body: { error: e.message } }));
    });
  }

  // userId: the manager picked from the keypad's staff list (the PIN is checked against them only).
  async function verifyManagerPin(pin, userId) {
    if (!pin) return null;
    const picked = pins.pickedId({ user_id: userId });
    const { rows } = await query(`SELECT id, name, pin_hash FROM users WHERE pin_hash IS NOT NULL AND is_staff = true AND NOT disabled` + (picked ? ' AND id = $1' : ''), picked ? [picked] : []);
    const u = await pins.pick(rows, String(pin));
    if (u && await userCan({ session: { userId: u.id } }, 'cashier.manage')) return u;
    return null;
  }

  // ------------------------------------- guard + link on the normal checkout --
  // Registered before app.post('/api/admin/pos/sale') so it runs first.
  app.use('/api/admin/pos/sale', async (req, res, next) => {
    if (req.method !== 'POST' || (req.body && req.body.dry_run === true)) return next();
    try {
      // Someone who does not take payment saves an order instead (the till does
      // this itself; this stops a sale posted straight at the API). Taking
      // payment on a saved order replays the sale without passing through here.
      if (!(await userCan(req, 'pos.finalise_invoice'))) {
        return res.status(403).json({ error: 'You do not take payment at the till: save the ticket as an order and a cashier takes payment.', save_as_order: true });
      }
      const st = await stationOf(req);
      if (!st) {
        // Unbound device (the shared counter PC): its sales belong to the default
        // till's shift, opened on demand. Never blocks -- a PIN takeover changes
        // the person at the counter, not the till.
        const ds = await defaultStation();
        let ds_s = ds && (await openSession(ds.id));
        if (!ds_s && ds && (await autoOpenOn())) ds_s = await autoOpen(ds.id, req.session.userId);
        if (ds_s) {
          const orig0 = res.json.bind(res);
          res.json = (d) => {
            if (d && d.ok && d.id && !d.dry_run) query('INSERT INTO till_sales (session_id, sale_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [ds_s.id, d.id]).catch(() => {});
            return orig0(d);
          };
        }
        return next();
      }
      if (st.kind === 'order') return res.status(403).json({ error: 'This is an order station: save the order and the cashier takes payment.' });
      const s = await openSession(st.id);
      if (!s) return res.status(409).json({ error: 'Open the cash drawer for ' + st.name + ' before taking payment.' });
      if (s.user_id !== req.session.userId) return res.status(409).json({ error: 'The drawer at ' + st.name + ' is open under another cashier. Take it over on the Cashier screen, or sign in as them.' });
      if (await waitingForRelief(s.id)) return res.status(409).json({ error: 'The drawer at ' + st.name + ' was handed over. Take it over on the Cashier screen before taking payment.' });
      const orig = res.json.bind(res);
      res.json = (d) => {
        if (d && d.ok && d.id && !d.dry_run) query('INSERT INTO till_sales (session_id, sale_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [s.id, d.id]).catch(() => {});
        return orig(d);
      };
      next();
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------------- POS orders --
  async function expireStale() {
    const min = parseInt(await setting('cash_order_expiry_min', '240'), 10) || 240;
    // Orders from reps and customer links carry their own deadline (expires_at).
    await query(`UPDATE pos_orders SET status = 'expired',
                        cancel_reason = CASE WHEN expires_at IS NOT NULL THEN 'Not paid by ' || to_char(expires_at AT TIME ZONE 'America/Jamaica', 'YYYY-MM-DD') ELSE 'Not paid within ' || $1 || ' minutes' END
                  WHERE status = 'pending' AND (CASE WHEN expires_at IS NOT NULL THEN expires_at < NOW() ELSE created_at < NOW() - ($1 || ' minutes')::interval END)`, [String(min)]);
  }

  app.post('/api/admin/pos/order', posGate, async (req, res) => {
    try {
      const b = Object.assign({}, req.body || {});
      delete b.payments; delete b.payment_method; delete b.amount_tendered; delete b.dry_run;
      if (!Array.isArray(b.items) || !b.items.length) throw httpError(400, 'At least one item required');
      // Dry run under the person saving it: their discount permissions, the exact total.
      const dry = await runSale(req, Object.assign({}, b, { dry_run: true, payments: [{ method: 'cash', amount_usd: null }] }), null);
      // Over the person's discount limit: the till asks for a manager's PIN and sends it again.
      if (dry.body && dry.body.discount_limit) return res.status(403).json(dry.body);
      if (dry.status !== 200 || !dry.body || !dry.body.ok) throw httpError(dry.status || 400, (dry.body && dry.body.error) || 'Could not price this order');
      const st = await stationOf(req);
      // Route to the order station's cashier; if that drawer is closed, to its backup.
      let target = st ? st.cashier_station_id : null;
      const pick = parseInt(b.collect_station_id, 10);
      delete b.collect_station_id;
      if (pick && (req.session.posDeptGeneral === true || (await userCan(req, 'cashier.manage')))) {
        const { rows: cs } = await query(`SELECT id FROM pos_stations WHERE id = $1 AND is_active AND kind IN ('cashier', 'integrated')`, [pick]);
        if (!cs[0]) throw httpError(400, 'That cashier station is not available.');
        target = pick;
      }
      if (target && !pick && !(await openSession(target))) {
        const { rows } = await query('SELECT backup_station_id FROM pos_stations WHERE id = $1', [target]);
        if (rows[0] && rows[0].backup_station_id && (await openSession(rows[0].backup_station_id))) target = rows[0].backup_station_id;
      }
      const { rows } = await query(
        `INSERT INTO pos_orders (payload, total_usd, preview, customer_id, customer_name, customer_phone, sales_rep_id, sales_rep_name,
                                 ship_instructions, taken_by, order_station_id, cashier_station_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [JSON.stringify(b), dry.body.total_usd, JSON.stringify(dry.body), Number.isInteger(b.customer_id) ? b.customer_id : null,
         b.customer_name || null, b.customer_phone || null, Number.isInteger(b.sales_rep_id) ? b.sales_rep_id : null,
         b.sales_rep_name || null, b.ship_instructions || null, req.session.userId, st ? st.id : null, target]);
      res.json({ ok: true, order_id: rows[0].id, total_usd: dry.body.total_usd });
    } catch (e) { fail(res, e); }
  });

  const ORDER_LIST = `
    SELECT o.id, o.created_at, o.customer_name, o.customer_phone, o.total_usd::float AS total_usd, o.status, o.sales_rep_name,
           o.ship_instructions, o.converted_sale_id, u.name AS taken_by_name,
           jsonb_array_length(o.payload->'items') AS line_count,
           (SELECT COALESCE(SUM((x->>'qty')::numeric), 0) FROM jsonb_array_elements(o.payload->'items') x)::int AS unit_count,
           os.name AS order_station, cs.name AS cashier_station, o.order_station_id, o.cashier_station_id,
           EXTRACT(EPOCH FROM (NOW() - o.created_at))::int / 60 AS age_min
      FROM pos_orders o LEFT JOIN users u ON u.id = o.taken_by
      LEFT JOIN pos_stations os ON os.id = o.order_station_id LEFT JOIN pos_stations cs ON cs.id = o.cashier_station_id`;

  app.get('/api/admin/pos/orders', posGate, async (req, res) => {
    try {
      await expireStale();
      const status = ['pending', 'invoicing', 'completed', 'cancelled', 'expired'].includes(req.query.status) ? req.query.status : 'pending';
      const st = await stationOf(req);
      let rows;
      if (st && st.kind === 'cashier' && status === 'pending') {
        // This cashier's orders, the unassigned pool, and those of any station it backs up whose drawer is closed.
        ({ rows } = await query(
          `${ORDER_LIST}
            WHERE o.status = 'pending'
              AND (o.cashier_station_id = $1 OR o.cashier_station_id IS NULL
                   OR (cs.backup_station_id = $1 AND NOT EXISTS (SELECT 1 FROM till_sessions t WHERE t.station_id = o.cashier_station_id AND t.status = 'open')))
            ORDER BY o.created_at LIMIT 200`, [st.id]));
      } else {
        ({ rows } = await query(`${ORDER_LIST} WHERE o.status = $1 ORDER BY o.created_at ${status === 'pending' ? 'ASC' : 'DESC'} LIMIT 200`, [status]));
      }
      res.json({ orders: rows, station: st ? { id: st.id, name: st.name, kind: st.kind } : null });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/admin/pos/orders/:id', posGate, async (req, res) => {
    try {
      const { rows } = await query(`${ORDER_LIST} WHERE o.id = $1`, [req.params.id]);
      if (!rows.length) throw httpError(404, 'Order not found');
      const { rows: raw } = await query('SELECT payload, preview FROM pos_orders WHERE id = $1', [req.params.id]);
      const payload = raw[0].payload || {};
      const imgs = (payload.items || []).map((it) => it.product_img).filter(Boolean);
      const { rows: prods } = await query('SELECT img, name, sku, stock_count FROM products WHERE img = ANY($1::text[])', [imgs]);
      const pm = new Map(prods.map((p) => [p.img, p]));
      const items = (payload.items || []).map((it) => {
        const p = pm.get(it.product_img) || {};
        return { product_img: it.product_img, qty: it.qty, unit_price_usd: Number(it.unit_price_usd) || 0, discount_usd: Number(it.discount_usd) || 0,
                 name: p.name || it.description, sku: p.sku || it.product_img, stock_count: p.stock_count };
      });
      const order = Object.assign(rows[0], { total_cents: Math.round(Number(rows[0].total_usd || 0) * 100), preview: raw[0].preview });
      res.json({ order, payload, items });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/admin/pos/orders/:id/cancel', posGate, async (req, res) => {
    try {
      const { rows: o } = await query('SELECT taken_by FROM pos_orders WHERE id = $1', [req.params.id]);
      if (!o.length) throw httpError(404, 'Order not found');
      if (o[0].taken_by !== req.session.userId && !(await canAny(req, ['cashier.access', 'cashier.manage', 'pos.finalise_invoice'])))
        throw httpError(403, 'Only the person who saved it or a cashier can cancel this order');
      const { rowCount } = await query(
        `UPDATE pos_orders SET status = 'cancelled', cancel_reason = $2, cancelled_by = $3 WHERE id = $1 AND status = 'pending'`,
        [req.params.id, String((req.body || {}).reason || '').slice(0, 300) || null, req.session.userId]);
      if (!rowCount) throw httpError(409, 'Order not found or not cancellable');
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // Take payment: claim, replay through the sale code with the cashier's tenders, link to the shift.
  app.post('/api/admin/pos/orders/:id/invoice', posGate, requireAny(['cashier.access', 'pos.finalise_invoice'], 'take payment on POS orders'), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    try {
      const st = await stationOf(req);
      let session = null;
      if (!st) {
        const ds = await defaultStation();
        session = ds && (await openSession(ds.id));
        if (!session && ds && (await autoOpenOn())) session = await autoOpen(ds.id, req.session.userId);
      }
      if (st) {
        if (st.kind === 'order') throw httpError(403, 'This is an order station; take payment at a cashier station.');
        session = await openSession(st.id);
        if (!session) throw httpError(409, 'Open the cash drawer for ' + st.name + ' first.');
        if (session.user_id !== req.session.userId) throw httpError(409, 'The drawer at ' + st.name + ' is open under another cashier. Take it over first.');
        if (await waitingForRelief(session.id)) throw httpError(409, 'The drawer at ' + st.name + ' was handed over. Take it over before taking payment.');
      }
      const { rows: claim } = await query(
        `UPDATE pos_orders SET status = 'invoicing', claimed_by = $2, claimed_at = NOW() WHERE id = $1 AND status = 'pending' RETURNING *`,
        [id, req.session.userId]);
      if (!claim.length) {
        const { rows } = await query('SELECT status FROM pos_orders WHERE id = $1', [id]);
        throw httpError(rows.length ? 409 : 404, rows.length ? 'Order is already ' + rows[0].status : 'Order not found');
      }
      const order = claim[0];
      const b = req.body || {};
      const body = Object.assign({}, order.payload, {
        payments: Array.isArray(b.payments) ? b.payments : undefined,
        payment_method: b.payment_method, amount_tendered: b.amount_tendered,
      });
      ['po_number', 'notes', 'due_date', 'fulfilment', 'ship_method', 'ship_fee_usd', 'ship_name', 'ship_phone', 'ship_line1', 'ship_line2', 'ship_city', 'ship_parish', 'ship_instructions']
        .forEach((k) => { if (b[k] !== undefined) body[k] = b[k]; });
      const r = await runSale(req, body, order);
      if (r.status !== 200 || !r.body || !r.body.ok) {
        await query(`UPDATE pos_orders SET status = 'pending', claimed_by = NULL, claimed_at = NULL WHERE id = $1`, [id]);
        throw httpError(r.status >= 400 ? r.status : 400, (r.body && r.body.error) || 'Sale failed');
      }
      await query(`UPDATE pos_orders SET status = 'completed', converted_sale_id = $2, completed_at = NOW(), till_session_id = $3 WHERE id = $1`,
        [id, r.body.id, session ? session.id : null]);
      if (session) await query('INSERT INTO till_sales (session_id, sale_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [session.id, r.body.id]);
      res.json({ ok: true, order_id: id, sale: r.body, till_session_id: session ? session.id : null });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------------- stations --
  app.get('/api/cash/me', gate, async (req, res) => {
    try {
      const st = await terminalStation(req);
      const session = st ? await openSession(st.id) : null;
      res.json({
        station: st ? { id: st.id, name: st.name, kind: st.kind, cashier_station_id: st.cashier_station_id, backup_station_id: st.backup_station_id } : null,
        session: session ? { id: session.id, user_id: session.user_id, opened_at: session.opened_at, mine: session.user_id === req.session.userId } : null,
        can: {
          take: await canAny(req, ['cashier.access', 'pos.finalise_invoice']),
          manage: await userCan(req, 'cashier.manage'),
        },
        denominations: DENOMS,
      });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/cash/stations', gate, async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT s.id, s.name, s.kind, s.cashier_station_id, c.name AS cashier_station, s.backup_station_id, bk.name AS backup_station,
                s.is_active, (s.device_key_hash IS NOT NULL) AS bound, s.bound_at,
                t.id AS session_id, u.name AS session_user, t.opened_at AS session_opened
           FROM pos_stations s
           LEFT JOIN pos_stations c ON c.id = s.cashier_station_id
           LEFT JOIN pos_stations bk ON bk.id = s.backup_station_id
           LEFT JOIN till_sessions t ON t.station_id = s.id AND t.status = 'open'
           LEFT JOIN users u ON u.id = t.user_id
          ORDER BY s.kind, s.name`);
      res.json({ stations: rows });
    } catch (e) { fail(res, e); }
  });

  async function checkStationBody(b, selfId) {
    if (b.kind !== undefined && !['order', 'cashier', 'integrated'].includes(b.kind)) throw httpError(400, 'Kind is order, cashier or integrated');
    for (const k of ['cashier_station_id', 'backup_station_id']) {
      if (b[k] == null || b[k] === '') continue;
      if (selfId && Number(b[k]) === Number(selfId)) throw httpError(400, 'A station cannot point at itself');
      const { rows } = await query(`SELECT kind FROM pos_stations WHERE id = $1 AND is_active`, [b[k]]);
      if (!rows.length || rows[0].kind !== 'cashier') throw httpError(400, 'That must be an active cashier station');
    }
  }

  app.post('/api/cash/stations', gate, requireCap('cashier.manage'), async (req, res) => {
    try {
      const b = req.body || {};
      const name = String(b.name || '').trim();
      if (name.length < 2 || name.length > 60) throw httpError(400, 'Give the station a name (2 to 60 characters)');
      await checkStationBody(b);
      const { rows } = await query(
        `INSERT INTO pos_stations (name, kind, cashier_station_id, backup_station_id) VALUES ($1, $2, $3, $4) RETURNING id`,
        [name, b.kind || 'order', b.cashier_station_id || null, b.backup_station_id || null]);
      res.json({ ok: true, id: rows[0].id });
    } catch (e) {
      if (e.code === '23505') return fail(res, httpError(409, 'A station with that name already exists'));
      fail(res, e);
    }
  });

  app.patch('/api/cash/stations/:id', gate, requireCap('cashier.manage'), async (req, res) => {
    try {
      const b = req.body || {};
      await checkStationBody(b, req.params.id);
      const sets = [], vals = [];
      const put = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
      if (b.name !== undefined) put('name', String(b.name).trim());
      if (b.kind !== undefined) put('kind', b.kind);
      if (b.cashier_station_id !== undefined) put('cashier_station_id', b.cashier_station_id || null);
      if (b.backup_station_id !== undefined) put('backup_station_id', b.backup_station_id || null);
      if (b.is_active !== undefined) {
        if (!b.is_active && (await openSession(req.params.id))) throw httpError(409, 'Close the drawer at this station first');
        put('is_active', !!b.is_active);
      }
      if (!sets.length) throw httpError(400, 'Nothing to change');
      vals.push(req.params.id);
      const { rowCount } = await query(`UPDATE pos_stations SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
      if (!rowCount) throw httpError(404, 'Station not found');
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // Make THIS device the station. The key is shown once and kept by the device;
  // binding again (new device, lost key) replaces it.
  app.post('/api/cash/stations/:id/bind', gate, requireCap('cashier.manage'), async (req, res) => {
    try {
      const key = crypto.randomBytes(24).toString('base64url');
      const { rowCount } = await query(
        `UPDATE pos_stations SET device_key_hash = $2, bound_at = NOW(), bound_by = $3 WHERE id = $1 AND is_active`,
        [req.params.id, hashKey(key), req.session.userId]);
      if (!rowCount) throw httpError(404, 'Station not found');
      res.json({ ok: true, key });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------------- the till --
  // Cash this shift's drawer gave back on returns (returns.js), less cash it
  // took back when a return was voided. Each is counted when it happened, so a
  // refund in one turn voided in the next shows in both.
  async function cashRefunds(sessionId, from, to) {
    try {
      const { rows } = await query(
        `SELECT COALESCE(SUM(amount_usd) FILTER (WHERE till_session_id = $1 AND ($2::timestamptz IS NULL OR created_at >= $2) AND ($3::timestamptz IS NULL OR created_at < $3)), 0)::float AS paid,
                COALESCE(SUM(amount_usd) FILTER (WHERE void_till_session_id = $1 AND ($2::timestamptz IS NULL OR voided_at >= $2) AND ($3::timestamptz IS NULL OR voided_at < $3)), 0)::float AS back,
                COUNT(*) FILTER (WHERE till_session_id = $1 AND ($2::timestamptz IS NULL OR created_at >= $2) AND ($3::timestamptz IS NULL OR created_at < $3))::int AS n
           FROM pos_return_settlements WHERE method = 'cash' AND (till_session_id = $1 OR void_till_session_id = $1)`, [sessionId, from || null, to || null]);
      return { amount: r2(rows[0].paid - rows[0].back), n: rows[0].n };
    } catch (_) { return { amount: 0, n: 0 }; }   // returns tables not made yet on this till
  }
  async function sessionReport(sessionId) {
    const { rows: s } = await query(
      `SELECT t.*, t.opening_float::float AS opening_float, t.counted_cash::float AS counted_cash, t.expected_cash::float AS expected_cash,
              t.variance::float AS variance, st.name AS station, u.name AS cashier, cb.name AS closed_by_name, rv.name AS reviewed_by_name
         FROM till_sessions t JOIN pos_stations st ON st.id = t.station_id JOIN users u ON u.id = t.user_id
         LEFT JOIN users cb ON cb.id = t.closed_by LEFT JOIN users rv ON rv.id = t.reviewed_by WHERE t.id = $1`, [sessionId]);
    if (!s.length) throw httpError(404, 'Shift not found');
    const { rows: tenders } = await query(
      `SELECT lower(p.method) AS method, COUNT(*)::int AS n, COALESCE(SUM(p.amount_usd), 0)::float AS amount
         FROM till_sales ts JOIN pos_sales ps ON ps.id = ts.sale_id JOIN sale_payments p ON p.sale_id = ts.sale_id
        WHERE ts.session_id = $1 AND NOT COALESCE(ps.voided, false) GROUP BY 1 ORDER BY 3 DESC`, [sessionId]);
    const { rows: sales } = await query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(ps.total_usd) FILTER (WHERE NOT ps.voided), 0)::float AS total,
              COALESCE(SUM(ps.tax_usd) FILTER (WHERE NOT ps.voided), 0)::float AS tax,
              COALESCE(SUM(ps.discount_usd) FILTER (WHERE NOT ps.voided), 0)::float AS discounts, COUNT(*) FILTER (WHERE ps.voided)::int AS voided,
              COALESCE(SUM(ps.change_due) FILTER (WHERE NOT ps.voided), 0)::float AS change_given
         FROM till_sales ts JOIN pos_sales ps ON ps.id = ts.sale_id WHERE ts.session_id = $1`, [sessionId]);
    const { rows: mv } = await query(
      `SELECT m.kind, m.amount::float AS amount, m.reason, m.created_at, u.name AS by_name, a.name AS approved_by_name
         FROM till_movements m LEFT JOIN users u ON u.id = m.by_user LEFT JOIN users a ON a.id = m.approved_by
        WHERE m.session_id = $1 ORDER BY m.created_at`, [sessionId]);
    const cashSales = tenders.filter((x) => x.method === 'cash').reduce((a, x) => a + x.amount, 0);
    const sum = (k) => mv.filter((x) => x.kind === k).reduce((a, x) => a + x.amount, 0);
    const collected = await collectedCash(sessionId);
    const refunds = await cashRefunds(sessionId, null, null);
    const expected = r2(s[0].opening_float + cashSales + sum('float_in') + collected - sum('drop') - sum('payout') - refunds.amount);
    return {
      session: s[0], tenders, sales: sales[0], movements: mv,
      cash: { opening_float: s[0].opening_float, cash_sales: r2(cashSales), float_in: r2(sum('float_in')), collected, drops: r2(sum('drop')), payouts: r2(sum('payout')), refunds: refunds.amount, refunds_n: refunds.n, expected },
    };
  }
  async function myStationSession(req, mustOwn) {
    const st = await terminalStation(req);
    if (!st) throw httpError(400, 'This device is not set up as a station. A manager can set it up on the Stations tab.');
    if (st.kind === 'order') throw httpError(403, 'An order station has no cash drawer');
    const s = await openSession(st.id);
    if (mustOwn && (!s || s.user_id !== req.session.userId)) throw httpError(409, s ? 'The drawer here is open under another cashier' : 'The drawer is not open');
    return { st, s };
  }

  // The cashier's right-hand queue: invoices paid on this terminal's open till
  // shift (or, with no shift open, today's), plus the shift itself for the
  // tender window.
  app.get('/api/cash/paid', gate, async (req, res) => {
    try {
      const st = await terminalStation(req);
      const s = st && st.kind !== 'order' ? await openSession(st.id) : null;
      const cols = `ps.id, ps.receipt_number, ps.invoice_number, ps.customer_name, ps.total_usd::float AS total_usd,
                    ps.payment_method, ps.created_at, ps.cashier_name, COALESCE(ps.voided, false) AS voided`;
      const { rows } = s
        ? await query(`SELECT ${cols} FROM till_sales ts JOIN pos_sales ps ON ps.id = ts.sale_id
                        WHERE ts.session_id = $1 ORDER BY ps.created_at DESC LIMIT 200`, [s.id])
        : await query(`SELECT ${cols} FROM pos_sales ps
                        WHERE ps.created_at >= (date_trunc('day', NOW() AT TIME ZONE 'America/Jamaica') AT TIME ZONE 'America/Jamaica')
                        ORDER BY ps.created_at DESC LIMIT 200`);
      let cashier = null;
      if (s) { const { rows: u } = await query('SELECT name FROM users WHERE id = $1', [s.user_id]); cashier = u[0] ? u[0].name : null; }
      const live = rows.filter((r) => !r.voided);
      res.json({
        scope: s ? 'shift' : 'today',
        station: st ? { id: st.id, name: st.name, kind: st.kind } : null,
        shift: s ? { id: s.id, opened_at: s.opened_at, cashier, opening_float: Number(s.opening_float), mine: s.user_id === req.session.userId } : null,
        totals: { count: live.length, total: r2(live.reduce((a, r) => a + Number(r.total_usd || 0), 0)) },
        sales: rows,
      });
    } catch (e) { fail(res, e); }
  });

  // Called by the POS as soon as it opens: make sure this terminal's till has
  // an open shift (default float), so a counter never starts the day "closed".
  app.post('/api/cash/till/ensure', gate, async (req, res) => {
    try {
      const st = await terminalStation(req);
      if (!st || st.kind === 'order') return res.json({ station: st ? { id: st.id, name: st.name, kind: st.kind } : null, session: null, opened: false });
      // The POS bar's "Shift open" badge and the Cash Report use the older
      // register-wide cash_drawer_sessions shift: open that one too.
      let drawerOpened = false;
      if ((await autoOpenOn()) && (await canAny(req, ['pos.open_close_shift', 'pos.access']))) {
        const { rows: od } = await query('SELECT id FROM cash_drawer_sessions WHERE closed_at IS NULL LIMIT 1');
        if (!od.length) {
          await query(`INSERT INTO cash_drawer_sessions (opened_by, opening_float, notes) VALUES (NULL, $1, 'Opened automatically when the POS started')`,
            [r2(parseFloat(await setting('cash_default_float', '0')) || 0)]);
          drawerOpened = true;
        }
      }
      let s = await openSession(st.id), opened = false;
      if (!s && (await autoOpenOn()) && !(await heldClosed(st.id)) && (await canAny(req, ['cashier.access', 'pos.finalise_invoice', 'pos.access']))) { s = await autoOpen(st.id, req.session.userId); opened = !!s; }
      res.json({ station: { id: st.id, name: st.name, kind: st.kind },
        session: s ? { id: s.id, user_id: s.user_id, opened_at: s.opened_at, opening_float: s.opening_float, mine: s.user_id === req.session.userId } : null, opened: opened || drawerOpened });
    } catch (e) { fail(res, e); }
  });

  // Who can collect payment: active cashier / integrated tills, with whoever
  // has the drawer open. Used by GENERAL to pick the cashier for a ticket.
  app.get('/api/cash/collectors', gate, async (req, res) => {
    try {
      await defaultStation();
      const { rows } = await query(`
        SELECT s.id, s.name, s.kind, l.name AS location, t.id AS session_id, u.name AS cashier
          FROM pos_stations s
          LEFT JOIN store_locations l ON l.id = s.location_id
          LEFT JOIN till_sessions t ON t.station_id = s.id AND t.status = 'open'
          LEFT JOIN users u ON u.id = t.user_id
         WHERE s.is_active AND s.kind IN ('cashier', 'integrated')
         ORDER BY (t.id IS NULL), s.name`);
      res.json({ collectors: rows });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/cash/till/open', gate, requireAny(['cashier.access', 'pos.finalise_invoice'], 'open a cash drawer'), async (req, res) => {
    try {
      const { st, s } = await myStationSession(req, false);
      if (s) throw httpError(409, 'The drawer at ' + st.name + ' is already open');
      const count = (req.body || {}).count || {};
      const float = countTotal(count);
      const { rows } = await query(
        `INSERT INTO till_sessions (station_id, user_id, opening_float, opening_count) VALUES ($1, $2, $3, $4) RETURNING id`,
        [st.id, req.session.userId, float, JSON.stringify(count)]);
      res.json({ ok: true, session_id: rows[0].id, opening_float: float });
    } catch (e) {
      if (e.code === '23505') return fail(res, httpError(409, 'The drawer here was just opened by someone else'));
      fail(res, e);
    }
  });

  // X report: the shift so far. A cashier sees sales by tender but not the
  // expected cash (that would defeat the blind count); managers see it all.
  app.get('/api/cash/till/current', gate, async (req, res) => {
    try {
      const { st, s } = await myStationSession(req, false);
      if (!s) return res.json({ station: { id: st.id, name: st.name, kind: st.kind }, session: null });
      const rep = await sessionReport(s.id);
      if (!(await userCan(req, 'cashier.manage'))) delete rep.cash.expected;
      res.json(Object.assign({ station: { id: st.id, name: st.name, kind: st.kind }, mine: s.user_id === req.session.userId }, rep));
    } catch (e) { fail(res, e); }
  });

  app.post('/api/cash/till/movement', gate, async (req, res) => {
    try {
      const { s } = await myStationSession(req, true);
      const b = req.body || {};
      if (!['drop', 'payout', 'float_in', 'no_sale'].includes(b.kind)) throw httpError(400, 'Unknown drawer movement');
      const amount = b.kind === 'no_sale' ? 0 : r2(b.amount);
      if (b.kind !== 'no_sale' && !(amount > 0)) throw httpError(400, 'Enter an amount');
      const reason = String(b.reason || '').trim();
      if ((b.kind === 'payout' || b.kind === 'no_sale') && reason.length < 3) throw httpError(400, 'Give a reason');
      let approver = null;
      const limit = Number(await setting('cash_payout_limit', '5000')) || 5000;
      if (b.kind === 'payout' && amount > limit) {
        approver = await verifyManagerPin(b.manager_pin, b.manager_user_id);
        if (!approver) throw httpError(403, 'Payouts over J$' + limit + ' need a manager PIN');
      }
      await query(`INSERT INTO till_movements (session_id, kind, amount, reason, by_user, approved_by) VALUES ($1, $2, $3, $4, $5, $6)`,
        [s.id, b.kind, amount, reason || null, req.session.userId, approver ? approver.id : null]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // Blind close: the cashier counts by denomination without seeing what is
  // expected; the variance is stored and shown only to managers.
  app.post('/api/cash/till/close', gate, async (req, res) => {
    try {
      const { s } = await myStationSession(req, true);
      const b = req.body || {};
      const counted = countTotal(b.count);
      const rep = await sessionReport(s.id);
      const variance = r2(counted - rep.cash.expected);
      await query(
        `UPDATE till_sessions SET status = 'closed', counted_cash = $2, closing_count = $3, expected_cash = $4, variance = $5,
                closed_at = NOW(), closed_by = $6, close_notes = $7 WHERE id = $1 AND status = 'open'`,
        [s.id, counted, JSON.stringify(b.count || {}), rep.cash.expected, variance, req.session.userId, String(b.notes || '').slice(0, 500) || null]);
      await endTurnOnClose(s.id, b.count, req.session.userId, 'close', b.actuals);
      const manager = await userCan(req, 'cashier.manage');
      res.json(manager ? { ok: true, session_id: s.id, counted, expected: rep.cash.expected, variance }
                       : { ok: true, session_id: s.id, counted, message: 'Count saved. A manager will review the drawer.' });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/cash/till/sessions', gate, requireCap('cashier.manage'), async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT t.id, t.status, st.name AS station, u.name AS cashier, t.opened_at, t.closed_at, t.opening_float::float AS opening_float,
                t.counted_cash::float AS counted_cash, t.expected_cash::float AS expected_cash, t.variance::float AS variance,
                t.reviewed_at, rv.name AS reviewed_by_name, (SELECT COUNT(*) FROM till_sales x WHERE x.session_id = t.id)::int AS sales
           FROM till_sessions t JOIN pos_stations st ON st.id = t.station_id JOIN users u ON u.id = t.user_id LEFT JOIN users rv ON rv.id = t.reviewed_by
          ORDER BY t.opened_at DESC LIMIT 100`);
      res.json({ sessions: rows });
    } catch (e) { fail(res, e); }
  });

  // Z report for one shift: managers any shift, a cashier only their own.
  app.get('/api/cash/till/sessions/:id', gate, async (req, res) => {
    try {
      const rep = await sessionReport(req.params.id);
      const manager = await userCan(req, 'cashier.manage');
      if (!manager && rep.session.user_id !== req.session.userId) throw httpError(403, 'Not your shift');
      if (!manager) { delete rep.cash.expected; delete rep.session.expected_cash; delete rep.session.variance; }
      res.json(rep);
    } catch (e) { fail(res, e); }
  });

  app.post('/api/cash/till/sessions/:id/review', gate, requireCap('cashier.manage'), async (req, res) => {
    try {
      const { rowCount } = await query(
        `UPDATE till_sessions SET reviewed_by = $2, reviewed_at = NOW(), review_note = $3 WHERE id = $1 AND status = 'closed'`,
        [req.params.id, req.session.userId, String((req.body || {}).note || '').slice(0, 500) || null]);
      if (!rowCount) throw httpError(409, 'Only a closed shift can be reviewed');
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // A manager can force-close a drawer left open (cashier went home).
  app.post('/api/cash/till/sessions/:id/force-close', gate, requireCap('cashier.manage'), async (req, res) => {
    try {
      const b = req.body || {};
      const rep = await sessionReport(req.params.id);
      if (rep.session.status !== 'open') throw httpError(409, 'Already closed');
      const counted = countTotal(b.count);
      await query(
        `UPDATE till_sessions SET status = 'closed', counted_cash = $2, closing_count = $3, expected_cash = $4, variance = $5,
                closed_at = NOW(), closed_by = $6, close_notes = $7 WHERE id = $1`,
        [req.params.id, counted, JSON.stringify(b.count || {}), rep.cash.expected, r2(counted - rep.cash.expected), req.session.userId,
         'Closed by manager' + (b.notes ? ': ' + String(b.notes).slice(0, 400) : '')]);
      await endTurnOnClose(req.params.id, b.count, req.session.userId, 'manager_close', b.actuals);
      res.json({ ok: true, expected: rep.cash.expected, counted, variance: r2(counted - rep.cash.expected) });
    } catch (e) { fail(res, e); }
  });

  // =========================================================================
  //  SHIFTS, RELIEF CASHIERS AND BALANCING (2026-11-07, Deb)
  //  A shift is one till_sessions row. Inside it each cashier's stretch at the
  //  drawer is a "turn" (till_turns): the first cashier from the opening float,
  //  then whoever relieves them for lunch, then the first cashier again, and so
  //  on. Each change of hands is a blind count, so every cashier is balanced on
  //  their own turn. A spot count (till_counts) can be taken at any time, e.g.
  //  straight after a sale, without closing anything. Balancing is then read by
  //  cashier, by shift, by day, or spot count by spot count.
  //  Tables are created on first use (never at startup), and also in schema.sql.
  // =========================================================================
  const SHIFT_DDL = `
    CREATE TABLE IF NOT EXISTS till_turns (
      id            SERIAL PRIMARY KEY,
      session_id    INTEGER NOT NULL REFERENCES till_sessions(id) ON DELETE CASCADE,
      seq           INTEGER NOT NULL,
      user_id       INTEGER NOT NULL REFERENCES users(id),
      started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      start_cash    NUMERIC(14,2) NOT NULL DEFAULT 0,
      start_count   JSONB,
      ended_at      TIMESTAMPTZ,
      end_kind      TEXT,
      end_count     JSONB,
      counted_cash  NUMERIC(14,2),
      expected_cash NUMERIC(14,2),
      variance      NUMERIC(14,2),
      ended_by      INTEGER REFERENCES users(id),
      notes         TEXT,
      end_actuals   JSONB
    );
    ALTER TABLE till_turns ADD COLUMN IF NOT EXISTS end_actuals JSONB;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_till_turns_seq ON till_turns (session_id, seq);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_till_turns_open ON till_turns (session_id) WHERE ended_at IS NULL;
    CREATE TABLE IF NOT EXISTS till_counts (
      id            SERIAL PRIMARY KEY,
      session_id    INTEGER NOT NULL REFERENCES till_sessions(id) ON DELETE CASCADE,
      turn_id       INTEGER REFERENCES till_turns(id) ON DELETE SET NULL,
      user_id       INTEGER REFERENCES users(id),
      count         JSONB,
      counted       NUMERIC(14,2) NOT NULL DEFAULT 0,
      expected      NUMERIC(14,2),
      variance      NUMERIC(14,2),
      after_sale_id INTEGER,
      notes         TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_till_counts_session ON till_counts (session_id, created_at);
    CREATE TABLE IF NOT EXISTS till_confirmations (
      session_id    INTEGER PRIMARY KEY REFERENCES till_sessions(id) ON DELETE CASCADE,
      status        TEXT NOT NULL DEFAULT 'confirmed',
      detail        JSONB,
      note          TEXT,
      confirmed_by  INTEGER REFERENCES users(id),
      confirmed_at  TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS till_lodgements (
      id              SERIAL PRIMARY KEY,
      number          TEXT,
      status          TEXT NOT NULL DEFAULT 'draft',
      lodge_date      DATE NOT NULL DEFAULT CURRENT_DATE,
      bank_account_id INTEGER,
      bank_name       TEXT,
      slip_number     TEXT,
      cash_count      JSONB,
      cash_amount     NUMERIC(14,2) NOT NULL DEFAULT 0,
      cheques         JSONB,
      cheque_amount   NUMERIC(14,2) NOT NULL DEFAULT 0,
      total           NUMERIC(14,2) NOT NULL DEFAULT 0,
      system_cash     NUMERIC(14,2),
      system_cheques  NUMERIC(14,2),
      float_kept      NUMERIC(14,2) NOT NULL DEFAULT 0,
      sessions        INTEGER[],
      notes           TEXT,
      made_by         INTEGER REFERENCES users(id),
      made_at         TIMESTAMPTZ DEFAULT NOW(),
      confirmed_by    INTEGER REFERENCES users(id),
      confirmed_at    TIMESTAMPTZ,
      voided_by       INTEGER REFERENCES users(id),
      voided_at       TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS till_lodgement_shifts (
      lodgement_id  INTEGER NOT NULL REFERENCES till_lodgements(id) ON DELETE CASCADE,
      session_id    INTEGER NOT NULL REFERENCES till_sessions(id) ON DELETE CASCADE,
      PRIMARY KEY (lodgement_id, session_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_till_lodgement_shift ON till_lodgement_shifts (session_id);
    CREATE TABLE IF NOT EXISTS till_comments (
      id            SERIAL PRIMARY KEY,
      session_id    INTEGER REFERENCES till_sessions(id) ON DELETE CASCADE,
      day           DATE,
      user_id       INTEGER REFERENCES users(id),
      role          TEXT NOT NULL DEFAULT 'cashier',
      body          TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS ix_till_comments_session ON till_comments (session_id);
    CREATE INDEX IF NOT EXISTS ix_till_comments_day ON till_comments (day);
    CREATE TABLE IF NOT EXISTS till_tasks (
      id              SERIAL PRIMARY KEY,
      kind            TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'open',
      target_kind     TEXT NOT NULL DEFAULT 'all',
      target_user_id  INTEGER REFERENCES users(id),
      target_station_id INTEGER REFERENCES pos_stations(id),
      customer_id     INTEGER REFERENCES users(id),
      customer_name   TEXT,
      apps            JSONB,
      payee           TEXT,
      reason          TEXT,
      amount          NUMERIC(14,2) NOT NULL,
      note            TEXT,
      created_by      INTEGER REFERENCES users(id),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      done_by         INTEGER REFERENCES users(id),
      done_at         TIMESTAMPTZ,
      session_id      INTEGER REFERENCES till_sessions(id),
      done_amount     NUMERIC(14,2),
      done_method     TEXT,
      done_reference  TEXT,
      account_payment_id INTEGER,
      movement_id     INTEGER,
      cancelled_by    INTEGER REFERENCES users(id),
      cancelled_at    TIMESTAMPTZ,
      cancel_reason   TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_till_tasks_open ON till_tasks (status, kind);
    CREATE INDEX IF NOT EXISTS ix_till_tasks_session ON till_tasks (session_id);
    CREATE TABLE IF NOT EXISTS pos_order_events (
      id          SERIAL PRIMARY KEY,
      order_id    INTEGER NOT NULL,
      kind        TEXT NOT NULL,
      user_id     INTEGER REFERENCES users(id),
      detail      JSONB,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS ix_pos_order_events ON pos_order_events (order_id);
    CREATE TABLE IF NOT EXISTS till_days (
      day           DATE PRIMARY KEY,
      status        TEXT NOT NULL DEFAULT 'open',
      opened_by     INTEGER REFERENCES users(id),
      opened_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closed_by     INTEGER REFERENCES users(id),
      closed_at     TIMESTAMPTZ,
      totals        JSONB
    );`;
  let shiftReadyP = null;
  function shiftReady() {
    if (!shiftReadyP) shiftReadyP = query(SHIFT_DDL).catch((e) => { shiftReadyP = null; throw e; });
    return shiftReadyP;
  }
  const isManager = (req) => userCan(req, 'cashier.manage');
  async function userName(id) {
    if (!id) return null;
    const { rows } = await query('SELECT name FROM users WHERE id = $1', [id]);
    return rows[0] ? rows[0].name : null;
  }

  // The turns of a shift, creating the first one for a shift that predates them.
  async function turnsOf(session) {
    await shiftReady();
    let { rows } = await query('SELECT * FROM till_turns WHERE session_id = $1 ORDER BY seq', [session.id]);
    if (!rows.length) {
      const closed = session.status !== 'open';
      await query(
        `INSERT INTO till_turns (session_id, seq, user_id, started_at, start_cash, start_count, ended_at, end_kind, end_count, counted_cash, expected_cash, variance, ended_by)
         VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT DO NOTHING`,
        [session.id, session.user_id, session.opened_at, session.opening_float || 0, session.opening_count ? JSON.stringify(session.opening_count) : null,
         closed ? (session.closed_at || new Date()) : null, closed ? 'close' : null, closed && session.closing_count ? JSON.stringify(session.closing_count) : null,
         closed ? session.counted_cash : null, closed ? session.expected_cash : null, closed ? session.variance : null, closed ? session.closed_by : null]);
      ({ rows } = await query('SELECT * FROM till_turns WHERE session_id = $1 ORDER BY seq', [session.id]));
    }
    return rows;
  }

  // Money through the drawer between two moments of a shift (end null = now).
  // The first turn has no lower bound so nothing rung as the shift opened is lost.
  async function windowReport(sessionId, from, to) {
    const p = [sessionId, from, to];
    const { rows: tenders } = await query(
      `SELECT lower(p.method) AS method, COALESCE(SUM(p.amount_usd), 0)::float AS amount
         FROM till_sales ts JOIN pos_sales ps ON ps.id = ts.sale_id JOIN sale_payments p ON p.sale_id = ts.sale_id
        WHERE ts.session_id = $1 AND NOT COALESCE(ps.voided, false)
          AND ($2::timestamptz IS NULL OR ps.created_at >= $2) AND ($3::timestamptz IS NULL OR ps.created_at < $3)
        GROUP BY 1 ORDER BY 2 DESC`, p);
    const { rows: s } = await query(
      `SELECT COUNT(*) FILTER (WHERE NOT COALESCE(ps.voided, false))::int AS n,
              COALESCE(SUM(ps.total_usd) FILTER (WHERE NOT COALESCE(ps.voided, false)), 0)::float AS total,
              COUNT(*) FILTER (WHERE ps.voided)::int AS voided
         FROM till_sales ts JOIN pos_sales ps ON ps.id = ts.sale_id
        WHERE ts.session_id = $1 AND ($2::timestamptz IS NULL OR ps.created_at >= $2) AND ($3::timestamptz IS NULL OR ps.created_at < $3)`, p);
    const { rows: mv } = await query(
      `SELECT kind, COALESCE(SUM(amount), 0)::float AS amount FROM till_movements
        WHERE session_id = $1 AND ($2::timestamptz IS NULL OR created_at >= $2) AND ($3::timestamptz IS NULL OR created_at < $3) GROUP BY kind`, p);
    const m = (k) => (mv.find((x) => x.kind === k) || { amount: 0 }).amount;
    const cash = tenders.filter((x) => x.method === 'cash').reduce((a, x) => a + x.amount, 0);
    // Customer account payments the cashier took (receivables sent to the till).
    const { rows: col } = await query(
      `SELECT lower(done_method) AS method, COUNT(*)::int AS n, COALESCE(SUM(done_amount), 0)::float AS amount FROM till_tasks
        WHERE kind = 'collect' AND status = 'done' AND session_id = $1
          AND ($2::timestamptz IS NULL OR done_at >= $2) AND ($3::timestamptz IS NULL OR done_at < $3) GROUP BY 1`, p);
    const collected = r2(col.filter((x) => x.method === 'cash').reduce((a, x) => a + x.amount, 0));
    const refunds = await cashRefunds(sessionId, from, to);
    return { refunds: refunds.amount, refunds_n: refunds.n, sales: s[0], tenders, cash_sales: r2(cash), float_in: r2(m('float_in')), drops: r2(m('drop')), payouts: r2(m('payout')),
             collected, collections: { n: col.reduce((a, x) => a + x.n, 0), total: r2(col.reduce((a, x) => a + x.amount, 0)), tenders: col } };
  }
  async function turnReport(turn) {
    const w = await windowReport(turn.session_id, turn.seq === 1 ? null : turn.started_at, turn.ended_at);
    const expected = r2(Number(turn.start_cash || 0) + w.cash_sales + w.float_in + w.collected - w.drops - w.payouts - w.refunds);
    return Object.assign(w, { expected });
  }
  async function openTurn(sessionId) {
    const { rows } = await query('SELECT * FROM till_turns WHERE session_id = $1 AND ended_at IS NULL', [sessionId]);
    return rows[0] || null;
  }
  // End a turn with a blind count. Returns { counted, expected, variance }.
  // The cashier's own totals for the other tenders (card slips, cheques, bank
  // transfers, gift cards), as declared at hand-over or close.
  function cleanActuals(a) {
    if (!a || typeof a !== 'object') return null;
    const out = {};
    for (const k of Object.keys(a)) { if (!/^[a-z_]{2,20}$/.test(k) || k === 'cash' || a[k] === '' || a[k] == null) continue; const v = r2(a[k]); if (v >= 0) out[k] = v; }
    return Object.keys(out).length ? out : null;
  }
  async function endTurn(turn, count, userId, kind, notes, actuals) {
    const counted = countTotal(count);
    const { rows } = await query(
      `UPDATE till_turns SET ended_at = NOW(), end_kind = $2, end_count = $3, counted_cash = $4, ended_by = $5, notes = $6, end_actuals = $7
        WHERE id = $1 AND ended_at IS NULL RETURNING *`,
      [turn.id, kind, JSON.stringify(count || {}), counted, userId, notes ? String(notes).slice(0, 500) : null, JSON.stringify(cleanActuals(actuals))]);
    if (!rows.length) throw httpError(409, 'That cashier\'s turn has already ended');
    if (notes && String(notes).trim()) await addComment({ session_id: turn.session_id }, userId, 'cashier', notes);
    const rep = await turnReport(rows[0]);
    const variance = r2(counted - rep.expected);
    await query('UPDATE till_turns SET expected_cash = $2, variance = $3 WHERE id = $1', [turn.id, rep.expected, variance]);
    return { counted, expected: rep.expected, variance };
  }
  // Called after the existing close / force-close: the last turn ends with the closing count.
  async function endTurnOnClose(sessionId, count, userId, kind, actuals) {
    try {
      const { rows } = await query('SELECT * FROM till_sessions WHERE id = $1', [sessionId]);
      if (!rows[0]) return;
      await turnsOf(rows[0]);
      const t = await openTurn(sessionId);
      if (t) await endTurn(t, count, userId, kind || 'close', null, actuals);
      if (rows[0].close_notes && rows[0].close_notes !== 'Closed by manager') await addComment({ session_id: sessionId }, userId, kind === 'manager_close' ? 'supervisor' : 'cashier', rows[0].close_notes);
    } catch (e) { console.error('[cash] turn close', e); }
  }
  // The shift a request is about: ?session_id= (managers, or your own), else this terminal's open one, else its latest.
  async function shiftFor(req) {
    const id = parseInt(req.query.session_id || (req.body || {}).session_id, 10);
    if (id) {
      const { rows } = await query('SELECT * FROM till_sessions WHERE id = $1', [id]);
      if (!rows[0]) throw httpError(404, 'Shift not found');
      return { s: rows[0], st: null };
    }
    const st = await terminalStation(req);
    if (!st || st.kind === 'order') return { s: null, st };
    let s = await openSession(st.id);
    if (!s) { const { rows } = await query('SELECT * FROM till_sessions WHERE station_id = $1 ORDER BY opened_at DESC LIMIT 1', [st.id]); s = rows[0] || null; }
    return { s, st };
  }
  async function canTake(req) { return canAny(req, ['cashier.access', 'pos.finalise_invoice']); }

  // Everything that happened in one shift, in order: sales (with how they were
  // paid and who rang them), drawer drops / payouts, each change of cashier and
  // every count. Managers also get the drawer's book balance after each line.
  app.get('/api/cash/shift', gate, async (req, res) => {
    try {
      const { s, st } = await shiftFor(req);
      const manager = await isManager(req);
      if (!s) return res.json({ station: st ? { id: st.id, name: st.name, kind: st.kind } : null, session: null, manager, me: req.session.userId,
                                 day: await dayRow(jamaicaToday()), held_closed: st ? await heldClosed(st.id) : false });
      const turns = await turnsOf(s);
      const { rows: stn } = await query('SELECT id, name, kind FROM pos_stations WHERE id = $1', [s.station_id]);
      const { rows: sales } = await query(
        `SELECT ps.id, ps.receipt_number, ps.invoice_number, ps.customer_name, ps.total_usd::float AS total, ps.created_at,
                ps.cashier_name, COALESCE(ps.voided, false) AS voided, ps.payment_method,
                COALESCE((SELECT json_agg(json_build_object('method', lower(p.method), 'amount', p.amount_usd::float) ORDER BY p.id)
                            FROM sale_payments p WHERE p.sale_id = ps.id), '[]'::json) AS tenders
           FROM till_sales ts JOIN pos_sales ps ON ps.id = ts.sale_id WHERE ts.session_id = $1 ORDER BY ps.created_at, ps.id`, [s.id]);
      const { rows: mv } = await query(
        `SELECT m.id, m.kind, m.amount::float AS amount, m.reason, m.created_at, u.name AS by_name, a.name AS approved_by_name
           FROM till_movements m LEFT JOIN users u ON u.id = m.by_user LEFT JOIN users a ON a.id = m.approved_by
          WHERE m.session_id = $1 ORDER BY m.created_at`, [s.id]);
      const { rows: counts } = await query(
        `SELECT c.id, c.counted::float AS counted, c.expected::float AS expected, c.variance::float AS variance, c.created_at, c.notes,
                u.name AS by_name, c.after_sale_id FROM till_counts c LEFT JOIN users u ON u.id = c.user_id
          WHERE c.session_id = $1 ORDER BY c.created_at`, [s.id]);
      const names = {};
      for (const t of turns) { if (!(t.user_id in names)) names[t.user_id] = await userName(t.user_id); if (t.ended_by && !(t.ended_by in names)) names[t.ended_by] = await userName(t.ended_by); }

      const items = [];
      turns.forEach((t) => {
        items.push({ at: t.seq === 1 ? s.opened_at : t.started_at, kind: 'turn_start', seq: t.seq, cashier: names[t.user_id],
                     start_cash: manager || t.seq === 1 ? Number(t.start_cash) : undefined });
        if (t.ended_at) items.push({ at: t.ended_at, kind: 'turn_end', seq: t.seq, end_kind: t.end_kind, cashier: names[t.user_id], by: names[t.ended_by],
          counted: Number(t.counted_cash), expected: manager ? Number(t.expected_cash) : undefined, variance: manager ? Number(t.variance) : undefined });
      });
      sales.forEach((x) => items.push({ at: x.created_at, kind: 'sale', id: x.id, number: x.invoice_number || x.receipt_number || ('#' + x.id),
        customer: x.customer_name, total: x.total, voided: x.voided, cashier: x.cashier_name, tenders: x.tenders,
        cash: r2((x.tenders || []).filter((p) => p.method === 'cash').reduce((a, p) => a + Number(p.amount || 0), 0)) }));
      mv.forEach((x) => items.push({ at: x.created_at, kind: 'move', move: x.kind, amount: x.amount, reason: x.reason, by: x.by_name, approved_by: x.approved_by_name }));
      counts.forEach((x) => items.push({ at: x.created_at, kind: 'count', counted: x.counted, by: x.by_name, notes: x.notes,
        expected: manager ? x.expected : undefined, variance: manager ? x.variance : undefined }));
      const { rows: cols } = await query(
        `SELECT t.id, t.customer_name, t.done_amount::float AS amount, t.done_method, t.done_reference, t.done_at, t.apps, u.name AS by_name
           FROM till_tasks t LEFT JOIN users u ON u.id = t.done_by WHERE t.kind = 'collect' AND t.status = 'done' AND t.session_id = $1`, [s.id]);
      cols.forEach((x) => items.push({ at: x.done_at, kind: 'collect', id: x.id, customer: x.customer_name, amount: x.amount, method: x.done_method,
        reference: x.done_reference, by: x.by_name, receipts: (x.apps || []).map((a) => a.receipt).filter(Boolean) }));
      const order = { turn_start: 0, sale: 1, collect: 1, move: 2, count: 3, turn_end: 4 };
      items.sort((a, b) => (new Date(a.at) - new Date(b.at)) || (order[a.kind] - order[b.kind]));
      if (manager) {
        let bal = Number(s.opening_float || 0);
        items.forEach((it) => {
          if (it.kind === 'sale' && !it.voided) bal += it.cash;
          if (it.kind === 'collect' && it.method === 'cash') bal += it.amount;
          if (it.kind === 'move') bal += it.move === 'float_in' ? it.amount : (it.move === 'drop' || it.move === 'payout') ? -it.amount : 0;
          it.drawer = r2(bal);
        });
      }
      const live = sales.filter((x) => !x.voided);
      const cur = turns.find((t) => !t.ended_at) || null;
      const turnOut = [];
      for (const t of turns) {
        const rep = await turnReport(t);
        turnOut.push({ id: t.id, seq: t.seq, cashier: names[t.user_id], user_id: t.user_id, started_at: t.seq === 1 ? s.opened_at : t.started_at, ended_at: t.ended_at,
          end_kind: t.end_kind, sales: rep.sales, tenders: rep.tenders, cash_sales: rep.cash_sales, counted: t.counted_cash == null ? null : Number(t.counted_cash),
          expected: manager ? rep.expected : undefined, variance: manager && t.variance != null ? Number(t.variance) : undefined });
      }
      res.json({
        manager, me: req.session.userId,
        station: stn[0] || null,
        session: { id: s.id, status: s.status, opened_at: s.opened_at, closed_at: s.closed_at, opening_float: Number(s.opening_float || 0),
                   counted_cash: s.counted_cash == null ? null : Number(s.counted_cash),
                   expected_cash: manager && s.expected_cash != null ? Number(s.expected_cash) : undefined,
                   variance: manager && s.variance != null ? Number(s.variance) : undefined },
        current: cur ? { seq: cur.seq, user_id: cur.user_id, cashier: names[cur.user_id], since: cur.seq === 1 ? s.opened_at : cur.started_at, mine: cur.user_id === req.session.userId } : null,
        waiting_for_relief: s.status === 'open' && !cur,
        turns: turnOut,
        comments: await commentsOf({ session_id: s.id }),
        can_comment: manager || await workedShift(s.id, req.session.userId),
        held_closed: s.status !== 'open' ? await heldClosed(s.station_id) : false,
        day: await dayRow(jamaicaToday()),
        totals: { count: live.length, total: r2(live.reduce((a, x) => a + Number(x.total || 0), 0)), voided: sales.length - live.length },
        items,
      });
    } catch (e) { fail(res, e); }
  });

  // Going on break: the cashier on the drawer counts it (blind) and the drawer
  // waits for a relief cashier. A manager can do this for them.
  app.post('/api/cash/till/handover', gate, async (req, res) => {
    try {
      const { s } = await shiftFor(req);
      if (!s || s.status !== 'open') throw httpError(409, 'No shift is open on this till');
      await turnsOf(s);
      const t = await openTurn(s.id);
      if (!t) throw httpError(409, 'The drawer is already waiting for the relief cashier');
      const manager = await isManager(req);
      if (t.user_id !== req.session.userId && !manager) throw httpError(403, 'Only the cashier on the drawer, or a manager, can hand it over');
      const b = req.body || {};
      const r = await endTurn(t, b.count, req.session.userId, 'handover', b.notes, b.actuals);
      res.json(manager ? Object.assign({ ok: true }, r) : { ok: true, counted: r.counted, message: 'Drawer counted and handed over. The relief cashier takes over next.' });
    } catch (e) { fail(res, e); }
  });

  // The relief (or the cashier coming back) takes the drawer. If someone is
  // still on it, the relief's count ends their turn; after a hand-over the count
  // is optional and, when given, becomes what the relief starts with.
  app.post('/api/cash/till/takeover', gate, async (req, res) => {
    try {
      if (!(await canTake(req))) throw httpError(403, 'Your account does not take payment, so it cannot take over a drawer');
      const { s } = await shiftFor(req);
      if (!s || s.status !== 'open') throw httpError(409, 'No shift is open on this till');
      const turns = await turnsOf(s);
      const b = req.body || {};
      const hasCount = b.count && Object.keys(b.count).some((k) => parseInt(b.count[k], 10) > 0);
      let t = await openTurn(s.id), ended = null;
      if (t && t.user_id === req.session.userId) throw httpError(409, 'You are already on this drawer');
      if (t) {
        if (!hasCount) throw httpError(400, 'Count the drawer first: the count closes the other cashier\'s turn');
        ended = await endTurn(t, b.count, req.session.userId, 'relieved', b.notes);
      }
      const last = (await query('SELECT * FROM till_turns WHERE session_id = $1 ORDER BY seq DESC LIMIT 1', [s.id])).rows[0] || turns[turns.length - 1];
      const startCash = hasCount ? countTotal(b.count) : Number(last.counted_cash || 0);
      try {
        await query(`INSERT INTO till_turns (session_id, seq, user_id, start_cash, start_count) VALUES ($1, $2, $3, $4, $5)`,
          [s.id, last.seq + 1, req.session.userId, startCash, hasCount ? JSON.stringify(b.count) : null]);
      } catch (e) { if (e.code === '23505') throw httpError(409, 'Someone else just took over this drawer'); throw e; }
      await query('UPDATE till_sessions SET user_id = $2 WHERE id = $1', [s.id, req.session.userId]);
      const manager = await isManager(req);
      res.json({ ok: true, start_cash: manager ? startCash : undefined, previous: ended && manager ? ended : undefined });
    } catch (e) { fail(res, e); }
  });

  // Count the drawer now (for example straight after a sale) without closing
  // anything. Blind for the cashier; the difference is kept for the manager.
  app.post('/api/cash/till/spot', gate, async (req, res) => {
    try {
      const { s } = await shiftFor(req);
      if (!s || s.status !== 'open') throw httpError(409, 'No shift is open on this till');
      const manager = await isManager(req);
      if (s.user_id !== req.session.userId && !manager) throw httpError(403, 'Only the cashier on the drawer, or a manager, can count it');
      await turnsOf(s);
      const t = await openTurn(s.id);
      const b = req.body || {};
      const counted = countTotal(b.count);
      // Book cash for the whole shift right now.
      const w = await windowReport(s.id, null, null);
      const expected = r2(Number(s.opening_float || 0) + w.cash_sales + w.float_in + w.collected - w.drops - w.payouts - w.refunds);
      const { rows: ls } = await query(`SELECT ts.sale_id FROM till_sales ts JOIN pos_sales ps ON ps.id = ts.sale_id WHERE ts.session_id = $1 ORDER BY ps.created_at DESC LIMIT 1`, [s.id]);
      const variance = r2(counted - expected);
      await query(`INSERT INTO till_counts (session_id, turn_id, user_id, count, counted, expected, variance, after_sale_id, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [s.id, t ? t.id : null, req.session.userId, JSON.stringify(b.count || {}), counted, expected, variance, ls[0] ? ls[0].sale_id : null, b.notes ? String(b.notes).slice(0, 500) : null]);
      res.json(manager ? { ok: true, counted, expected, variance } : { ok: true, counted, message: 'Count saved. A manager sees whether it balances.' });
    } catch (e) { fail(res, e); }
  });

  // Balancing for managers over a date range (Jamaica dates, at most 92 days):
  // by cashier (each turn), by shift, by day, and every spot count.
  app.get('/api/cash/balance', gate, requireCap('cashier.manage'), async (req, res) => {
    try {
      await shiftReady();
      const d = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
      const today = new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
      const from = d(req.query.from) || today, to = d(req.query.to) || from;
      if ((new Date(to) - new Date(from)) / 86400000 > 92) throw httpError(400, 'Pick 92 days or fewer');
      const { rows: sess } = await query(
        `SELECT t.*, st.name AS station, to_char(t.opened_at AT TIME ZONE 'America/Jamaica', 'YYYY-MM-DD') AS day, rv.name AS reviewed_by_name
           FROM till_sessions t JOIN pos_stations st ON st.id = t.station_id LEFT JOIN users rv ON rv.id = t.reviewed_by
          WHERE t.opened_at >= ($1::date::timestamp AT TIME ZONE 'America/Jamaica')
            AND t.opened_at < (($2::date + 1)::timestamp AT TIME ZONE 'America/Jamaica')
          ORDER BY t.opened_at`, [from, to]);
      const shifts = [], cashiers = {}, days = {};
      const names = {};
      const nm = async (id) => { if (!(id in names)) names[id] = await userName(id); return names[id]; };
      const addT = (o, tenders) => tenders.forEach((x) => { o[x.method] = r2((o[x.method] || 0) + x.amount); });
      for (const s of sess) {
        const turns = await turnsOf(s);
        const whole = await windowReport(s.id, null, null);
        const expected = s.status === 'open' ? r2(Number(s.opening_float || 0) + whole.cash_sales + whole.float_in + whole.collected - whole.drops - whole.payouts - whole.refunds) : Number(s.expected_cash);
        const counted = s.counted_cash == null ? null : Number(s.counted_cash);
        const turnVar = [];
        const people = [];
        for (const t of turns) {
          const rep = await turnReport(t);
          const who = await nm(t.user_id);
          if (people.indexOf(who) === -1) people.push(who);
          const c = cashiers[t.user_id] || (cashiers[t.user_id] = { cashier: who, turns: 0, open_turns: 0, sales: 0, total: 0, tenders: {}, expected: 0, counted: 0, variance: 0, short: 0, over: 0 });
          c.turns++; c.sales += rep.sales.n; c.total = r2(c.total + rep.sales.total); addT(c.tenders, rep.tenders);
          if (t.ended_at && t.counted_cash != null) {
            const v = t.variance != null ? Number(t.variance) : r2(Number(t.counted_cash) - rep.expected);
            c.expected = r2(c.expected + (t.expected_cash != null ? Number(t.expected_cash) : rep.expected)); c.counted = r2(c.counted + Number(t.counted_cash)); c.variance = r2(c.variance + v);
            if (v < -0.005) c.short++; if (v > 0.005) c.over++;
            turnVar.push({ seq: t.seq, cashier: who, variance: v });
          } else c.open_turns++;
        }
        const row = { id: s.id, day: s.day, station: s.station, status: s.status, opened_at: s.opened_at, closed_at: s.closed_at, cashiers: people,
          opening_float: Number(s.opening_float || 0), sales: whole.sales.n, total: whole.sales.total, voided: whole.sales.voided, tenders: {},
          cash_sales: whole.cash_sales, drops: whole.drops, payouts: whole.payouts, float_in: whole.float_in, collections: whole.collections,
          expected, counted, variance: s.variance == null ? null : Number(s.variance), turns: turnVar, reviewed_by: s.reviewed_by_name || null };
        const { rows: cfr } = await query(`SELECT c.status, u.name FROM till_confirmations c LEFT JOIN users u ON u.id = c.confirmed_by WHERE c.session_id = $1`, [s.id]);
        const { rows: lgr } = await query(`SELECT l.id, l.number, l.status FROM till_lodgement_shifts x JOIN till_lodgements l ON l.id = x.lodgement_id WHERE x.session_id = $1`, [s.id]);
        row.confirmation = cfr[0] ? { status: cfr[0].status, by: cfr[0].name } : null;
        row.lodgement = lgr[0] || null;
        row.comments = await commentsOf({ session_id: s.id });
        addT(row.tenders, whole.tenders);
        shifts.push(row);
        const dd = days[s.day] || (days[s.day] = { day: s.day, shifts: 0, open: 0, sales: 0, total: 0, tenders: {}, expected: 0, counted: 0, variance: 0 });
        dd.shifts++; dd.sales += row.sales; dd.total = r2(dd.total + row.total); addT(dd.tenders, whole.tenders);
        if (s.status === 'open') dd.open++; else { dd.expected = r2(dd.expected + (expected || 0)); dd.counted = r2(dd.counted + (counted || 0)); dd.variance = r2(dd.variance + (row.variance || 0)); }
      }
      const { rows: spots } = await query(
        `SELECT c.id, c.session_id, c.created_at, c.counted::float AS counted, c.expected::float AS expected, c.variance::float AS variance, c.notes,
                u.name AS cashier, st.name AS station, COALESCE(ps.invoice_number, ps.receipt_number) AS after_sale
           FROM till_counts c JOIN till_sessions t ON t.id = c.session_id JOIN pos_stations st ON st.id = t.station_id
           LEFT JOIN users u ON u.id = c.user_id LEFT JOIN pos_sales ps ON ps.id = c.after_sale_id
          WHERE c.created_at >= ($1::date::timestamp AT TIME ZONE 'America/Jamaica') AND c.created_at < (($2::date + 1)::timestamp AT TIME ZONE 'America/Jamaica')
          ORDER BY c.created_at`, [from, to]);
      // Every day in the range, a day with no sale included, with whether it was
      // opened / closed and the comments on it.
      const { rows: dr } = await query(
        `SELECT g::date::text AS day FROM generate_series($1::date, LEAST($2::date, (NOW() AT TIME ZONE 'America/Jamaica')::date), '1 day') g`, [from, to]);
      const dayList = [];
      for (const { day } of dr) {
        const x = days[day] || { day, shifts: 0, open: 0, sales: 0, total: 0, tenders: {}, expected: 0, counted: 0, variance: 0 };
        x.state = await dayRow(day);
        x.comments = await commentsOf({ day });
        dayList.push(x);
      }
      res.json({ from, to, shifts, cashiers: Object.values(cashiers).sort((a, b) => a.cashier < b.cashier ? -1 : 1), days: dayList, spots });
    } catch (e) { fail(res, e); }
  });
  // True when the shift's last cashier handed over and nobody has taken over yet.
  async function waitingForRelief(sessionId) {
    await shiftReady();
    const { rows } = await query(
      `SELECT EXISTS (SELECT 1 FROM till_turns WHERE session_id = $1) AS any, EXISTS (SELECT 1 FROM till_turns WHERE session_id = $1 AND ended_at IS NULL) AS open`, [sessionId]);
    return rows[0].any && !rows[0].open;
  }

  // ---------------------------------------------------- live cashier tracker --
  // Every till that takes money: who is on its drawer now, since when, what
  // they have taken on this turn, and whether it is waiting for a relief.
  app.get('/api/cash/tracker', gate, requireCap('cashier.manage'), async (req, res) => {
    try {
      await shiftReady();
      const { rows: st } = await query(
        `SELECT s.id, s.name, s.kind, t.id AS session_id, t.opened_at FROM pos_stations s
           LEFT JOIN till_sessions t ON t.station_id = s.id AND t.status = 'open'
          WHERE s.is_active AND s.kind IN ('cashier', 'integrated') ORDER BY (t.id IS NULL), s.name`);
      const out = [];
      for (const x of st) {
        const row = { station_id: x.id, station: x.name, kind: x.kind, session_id: x.session_id, opened_at: x.opened_at, cashier: null, since: null, waiting: false, turns: 0, turn_sales: null, shift_sales: null };
        if (x.session_id) {
          const { rows: ss } = await query('SELECT * FROM till_sessions WHERE id = $1', [x.session_id]);
          const turns = await turnsOf(ss[0]);
          const cur = turns.find((t) => !t.ended_at);
          row.turns = turns.length;
          row.waiting = !cur;
          if (cur) {
            row.cashier = await userName(cur.user_id); row.since = cur.seq === 1 ? ss[0].opened_at : cur.started_at;
            const rep = await turnReport(cur);
            row.turn_sales = { n: rep.sales.n, total: rep.sales.total, cash: rep.cash_sales, expected: rep.expected };
          } else {
            const last = turns[turns.length - 1];
            row.last_cashier = await userName(last.user_id); row.since = last.ended_at;
          }
          const w = await windowReport(x.session_id, null, null);
          row.shift_sales = { n: w.sales.n, total: w.sales.total };
        }
        out.push(row);
      }
      res.json({ tills: out });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------- supervisor confirms a shift --
  // Tender by tender: what the system took, what the cashier declared (cash by
  // note and coin, the rest as totals), and the supervisor's own figure.
  async function confirmView(sessionId) {
    const { rows: ss } = await query(
      `SELECT t.*, st.name AS station FROM till_sessions t JOIN pos_stations st ON st.id = t.station_id WHERE t.id = $1`, [sessionId]);
    if (!ss[0]) throw httpError(404, 'Shift not found');
    const s = ss[0];
    const turns = await turnsOf(s);
    const w = await windowReport(s.id, null, null);
    const expectedCash = s.status === 'open' ? r2(Number(s.opening_float || 0) + w.cash_sales + w.float_in + w.collected - w.drops - w.payouts - w.refunds) : Number(s.expected_cash);
    const declared = {};
    let anyDeclared = false;
    turns.forEach((t) => { const a = t.end_actuals || {}; Object.keys(a).forEach((k) => { declared[k] = r2((declared[k] || 0) + Number(a[k] || 0)); anyDeclared = true; }); });
    w.collections.tenders.forEach((c) => { if (c.method === 'cash') return; const t = w.tenders.find((x) => x.method === c.method); if (t) t.amount = r2(t.amount + c.amount); else w.tenders.push({ method: c.method, amount: c.amount }); });
    const methods = [...new Set(['cash', ...w.tenders.map((x) => x.method), ...Object.keys(declared)])].filter((m) => m !== 'account');
    const rows = methods.map((m) => {
      if (m === 'cash') return { method: 'cash', label: 'Cash in drawer', system: expectedCash, declared: s.counted_cash == null ? null : Number(s.counted_cash) };
      const sys = (w.tenders.find((x) => x.method === m) || { amount: 0 }).amount;
      return { method: m, system: r2(sys), declared: anyDeclared ? (declared[m] != null ? declared[m] : 0) : null };
    });
    const charged = (w.tenders.find((x) => x.method === 'account') || { amount: 0 }).amount;
    const { rows: cf } = await query(
      `SELECT c.*, u.name AS confirmed_by_name FROM till_confirmations c LEFT JOIN users u ON u.id = c.confirmed_by WHERE c.session_id = $1`, [s.id]);
    const names = {};
    for (const t of turns) if (!(t.user_id in names)) names[t.user_id] = await userName(t.user_id);
    return {
      session: { id: s.id, station: s.station, status: s.status, opened_at: s.opened_at, closed_at: s.closed_at, opening_float: Number(s.opening_float || 0),
                 closing_count: s.closing_count, close_notes: s.close_notes },
      sales: w.sales, drops: w.drops, payouts: w.payouts, float_in: w.float_in, charged: r2(charged), rows, collections: w.collections,
      turns: turns.map((t) => ({ seq: t.seq, cashier: names[t.user_id], ended_at: t.ended_at, end_kind: t.end_kind, counted: t.counted_cash == null ? null : Number(t.counted_cash),
        expected: t.expected_cash == null ? null : Number(t.expected_cash), variance: t.variance == null ? null : Number(t.variance), actuals: t.end_actuals || null })),
      confirmation: cf[0] ? { status: cf[0].status, detail: cf[0].detail, note: cf[0].note, by: cf[0].confirmed_by_name, at: cf[0].confirmed_at } : null,
      comments: await commentsOf({ session_id: s.id }),
    };
  }
  app.get('/api/cash/confirm/:id', gate, requireCap('cashier.manage'), async (req, res) => {
    try { await shiftReady(); res.json(await confirmView(req.params.id)); } catch (e) { fail(res, e); }
  });
  app.post('/api/cash/confirm/:id', gate, requireCap('cashier.manage'), async (req, res) => {
    try {
      await shiftReady();
      const v = await confirmView(req.params.id);
      if (v.session.status === 'open') throw httpError(409, 'Close the shift before confirming it');
      const b = req.body || {};
      const sup = (b.supervisor && typeof b.supervisor === 'object') ? b.supervisor : {};
      const status = b.status === 'query' ? 'query' : 'confirmed';
      const detail = { tenders: v.rows.map((r) => {
        const s = sup[r.method] === '' || sup[r.method] == null ? (r.declared != null ? r.declared : r.system) : r2(sup[r.method]);
        return { method: r.method, system: r.system, declared: r.declared, supervisor: s, difference: r2(s - r.system) };
      }) };
      detail.total_difference = r2(detail.tenders.reduce((a, t) => a + t.difference, 0));
      if (status === 'confirmed' && Math.abs(detail.total_difference) > 0.005 && String(b.note || '').trim().length < 3)
        throw httpError(400, 'It does not balance: write a note saying why before confirming');
      await query(
        `INSERT INTO till_confirmations (session_id, status, detail, note, confirmed_by, confirmed_at) VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (session_id) DO UPDATE SET status = EXCLUDED.status, detail = EXCLUDED.detail, note = EXCLUDED.note, confirmed_by = EXCLUDED.confirmed_by, confirmed_at = NOW()`,
        [v.session.id, status, JSON.stringify(detail), String(b.note || '').slice(0, 500) || null, req.session.userId]);
      if (status === 'confirmed')
        await query(`UPDATE till_sessions SET reviewed_by = $2, reviewed_at = NOW(), review_note = $3 WHERE id = $1`,
          [v.session.id, req.session.userId, ('Confirmed against system totals' + (b.note ? ': ' + String(b.note) : '')).slice(0, 500)]);
      res.json({ ok: true, status, detail });
    } catch (e) { fail(res, e); }
  });

  // ---------------------------------------------------------- lodgements --
  // The bank lodgement made up from closed shifts: their counted cash less the
  // float kept back, plus the cheques taken. The supervisor makes it up (or
  // confirms the proposal), counts it by note and coin, and records the bank
  // and deposit slip. Recording it in the bank register stays in Banking >
  // Make Deposits, which this does not touch.
  async function lodgementProposal(sessionIds) {
    const shifts = [];
    let cash = 0, cheques = [];
    for (const id of sessionIds) {
      const { rows: ss } = await query(
        `SELECT t.id, t.status, t.counted_cash::float AS counted, t.opening_float::float AS opening_float, t.closed_at, t.opened_at, st.name AS station,
                (SELECT l.lodgement_id FROM till_lodgement_shifts l WHERE l.session_id = t.id) AS lodgement_id,
                (SELECT status FROM till_confirmations c WHERE c.session_id = t.id) AS confirmed
           FROM till_sessions t JOIN pos_stations st ON st.id = t.station_id WHERE t.id = $1`, [id]);
      if (!ss[0]) continue;
      const s = ss[0];
      const { rows: ch } = await query(
        `SELECT p.id, p.amount_usd::float AS amount, p.reference, ps.customer_name, COALESCE(ps.invoice_number, ps.receipt_number) AS sale
           FROM till_sales ts JOIN pos_sales ps ON ps.id = ts.sale_id JOIN sale_payments p ON p.sale_id = ps.id
          WHERE ts.session_id = $1 AND lower(p.method) = 'cheque' AND NOT COALESCE(ps.voided, false) ORDER BY p.id`, [id]);
      shifts.push(Object.assign(s, { cheques: ch }));
      if (s.status !== 'open' && !s.lodgement_id) { cash += Number(s.counted || 0); cheques = cheques.concat(ch.map((c) => Object.assign({ session_id: s.id }, c))); }
    }
    return { shifts, system_cash: r2(cash), cheques, system_cheques: r2(cheques.reduce((a, c) => a + c.amount, 0)) };
  }
  app.get('/api/cash/lodgements/proposal', gate, requireCap('cashier.manage'), async (req, res) => {
    try {
      await shiftReady();
      const d = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
      const today = new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
      const from = d(req.query.from) || today, to = d(req.query.to) || from;
      const { rows } = await query(
        `SELECT t.id FROM till_sessions t
          WHERE t.status = 'closed' AND NOT EXISTS (SELECT 1 FROM till_lodgement_shifts l WHERE l.session_id = t.id)
            AND t.opened_at >= ($1::date::timestamp AT TIME ZONE 'America/Jamaica') AND t.opened_at < (($2::date + 1)::timestamp AT TIME ZONE 'America/Jamaica')
          ORDER BY t.opened_at`, [from, to]);
      const p = await lodgementProposal(rows.map((r) => r.id));
      const float = r2(parseFloat(await setting('cash_default_float', '0')) || 0);
      let banks = [];
      try { ({ rows: banks } = await query(`SELECT id, code, name FROM gl_accounts WHERE is_active AND qb_type = 'BANK' ORDER BY code`)); } catch (_) {}
      res.json(Object.assign({ from, to, default_float: float, banks }, p));
    } catch (e) { fail(res, e); }
  });
  app.get('/api/cash/lodgements', gate, requireCap('cashier.manage'), async (req, res) => {
    try {
      await shiftReady();
      const d = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
      const from = d(req.query.from), to = d(req.query.to);
      const { rows } = await query(
        `SELECT l.*, l.cash_amount::float AS cash_amount, l.cheque_amount::float AS cheque_amount, l.total::float AS total, l.system_cash::float AS system_cash,
                l.system_cheques::float AS system_cheques, l.float_kept::float AS float_kept, to_char(l.lodge_date, 'YYYY-MM-DD') AS lodge_day,
                m.name AS made_by_name, c.name AS confirmed_by_name
           FROM till_lodgements l LEFT JOIN users m ON m.id = l.made_by LEFT JOIN users c ON c.id = l.confirmed_by
          WHERE ($1::date IS NULL OR l.lodge_date >= $1::date) AND ($2::date IS NULL OR l.lodge_date <= $2::date)
          ORDER BY l.lodge_date DESC, l.id DESC LIMIT 200`, [from, to]);
      res.json({ lodgements: rows });
    } catch (e) { fail(res, e); }
  });
  // Make up a lodgement (draft) or make it up and confirm in one go.
  app.post('/api/cash/lodgements', gate, requireCap('cashier.manage'), async (req, res) => {
    try {
      await shiftReady();
      const b = req.body || {};
      const ids = [...new Set((Array.isArray(b.sessions) ? b.sessions : []).map((x) => parseInt(x, 10)).filter(Boolean))];
      if (!ids.length) throw httpError(400, 'Pick the shifts this lodgement covers');
      const p = await lodgementProposal(ids);
      const bad = p.shifts.filter((s) => s.status === 'open' || s.lodgement_id);
      if (bad.length) throw httpError(409, 'Shift ' + bad.map((s) => '#' + s.id).join(', ') + (bad[0].status === 'open' ? ' is still open' : ' is already in a lodgement'));
      const cashAmount = countTotal(b.cash_count);
      const chIds = new Set((Array.isArray(b.cheque_ids) ? b.cheque_ids : p.cheques.map((c) => c.id)).map((x) => parseInt(x, 10)));
      const cheques = p.cheques.filter((c) => chIds.has(c.id));
      const chequeAmount = r2(cheques.reduce((a, c) => a + c.amount, 0));
      const total = r2(cashAmount + chequeAmount);
      if (!(total > 0)) throw httpError(400, 'Count the cash going to the bank (or tick the cheques)');
      const confirm = b.confirm === true;
      if (confirm && !String(b.slip_number || '').trim()) throw httpError(400, 'Enter the deposit slip number to confirm the lodgement');
      const lodgeDate = /^\d{4}-\d{2}-\d{2}$/.test(String(b.lodge_date || '')) ? b.lodge_date : new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
      let bankName = String(b.bank_name || '').trim().slice(0, 80) || null, bankId = parseInt(b.bank_account_id, 10) || null;
      if (bankId) { try { const { rows } = await query('SELECT name FROM gl_accounts WHERE id = $1', [bankId]); if (rows[0]) bankName = rows[0].name; else bankId = null; } catch (_) { bankId = null; } }
      const { rows } = await query(
        `INSERT INTO till_lodgements (status, lodge_date, bank_account_id, bank_name, slip_number, cash_count, cash_amount, cheques, cheque_amount, total,
                                      system_cash, system_cheques, float_kept, sessions, notes, made_by, confirmed_by, confirmed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
        [confirm ? 'confirmed' : 'draft', lodgeDate, bankId, bankName, String(b.slip_number || '').trim().slice(0, 40) || null, JSON.stringify(b.cash_count || {}), cashAmount,
         JSON.stringify(cheques), chequeAmount, total, p.system_cash, p.system_cheques, r2(b.float_kept), ids, String(b.notes || '').slice(0, 500) || null,
         req.session.userId, confirm ? req.session.userId : null, confirm ? new Date() : null]);
      const id = rows[0].id;
      try {
        for (const sid of ids) await query('INSERT INTO till_lodgement_shifts (lodgement_id, session_id) VALUES ($1, $2)', [id, sid]);
      } catch (e) {
        await query('DELETE FROM till_lodgements WHERE id = $1', [id]);
        if (e.code === '23505') throw httpError(409, 'One of those shifts was just put in another lodgement');
        throw e;
      }
      await query(`UPDATE till_lodgements SET number = 'LDG-' || lpad(id::text, 6, '0') WHERE id = $1`, [id]);
      res.json({ ok: true, id, number: 'LDG-' + String(id).padStart(6, '0'), status: confirm ? 'confirmed' : 'draft', total,
                 expected: r2(p.system_cash - r2(b.float_kept) + chequeAmount) });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/cash/lodgements/:id', gate, requireCap('cashier.manage'), async (req, res) => {
    try {
      await shiftReady();
      const { rows } = await query(
        `SELECT l.*, l.cash_amount::float AS cash_amount, l.cheque_amount::float AS cheque_amount, l.total::float AS total, l.system_cash::float AS system_cash,
                l.system_cheques::float AS system_cheques, l.float_kept::float AS float_kept, to_char(l.lodge_date, 'YYYY-MM-DD') AS lodge_day,
                m.name AS made_by_name, c.name AS confirmed_by_name
           FROM till_lodgements l LEFT JOIN users m ON m.id = l.made_by LEFT JOIN users c ON c.id = l.confirmed_by WHERE l.id = $1`, [req.params.id]);
      if (!rows[0]) throw httpError(404, 'Lodgement not found');
      res.json({ lodgement: rows[0] });
    } catch (e) { fail(res, e); }
  });
  // Confirm a draft (supervisor checks the count and enters the slip number).
  app.post('/api/cash/lodgements/:id/confirm', gate, requireCap('cashier.manage'), async (req, res) => {
    try {
      await shiftReady();
      const b = req.body || {};
      const slip = String(b.slip_number || '').trim().slice(0, 40);
      const { rows: cur } = await query('SELECT * FROM till_lodgements WHERE id = $1', [req.params.id]);
      if (!cur[0]) throw httpError(404, 'Lodgement not found');
      if (cur[0].status !== 'draft') throw httpError(409, 'Only a draft lodgement can be confirmed');
      if (!slip && !cur[0].slip_number) throw httpError(400, 'Enter the deposit slip number');
      let cashAmount = Number(cur[0].cash_amount), count = cur[0].cash_count;
      if (b.cash_count && Object.keys(b.cash_count).length) { count = b.cash_count; cashAmount = countTotal(b.cash_count); }
      await query(
        `UPDATE till_lodgements SET status = 'confirmed', slip_number = COALESCE(NULLIF($2, ''), slip_number), cash_count = $3, cash_amount = $4, total = $4 + cheque_amount,
                confirmed_by = $5, confirmed_at = NOW(), notes = COALESCE(NULLIF($6, ''), notes) WHERE id = $1`,
        [cur[0].id, slip, JSON.stringify(count || {}), cashAmount, req.session.userId, String(b.notes || '').slice(0, 500)]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/cash/lodgements/:id/void', gate, requireCap('cashier.manage'), async (req, res) => {
    try {
      await shiftReady();
      const why = String((req.body || {}).reason || '').trim();
      if (why.length < 3) throw httpError(400, 'Say why it is being voided');
      const { rowCount } = await query(`UPDATE till_lodgements SET status = 'void', voided_by = $2, voided_at = NOW(), notes = left(COALESCE(notes || ' | ', '') || 'Voided: ' || $3, 500) WHERE id = $1 AND status <> 'void'`,
        [req.params.id, req.session.userId, why]);
      if (!rowCount) throw httpError(409, 'Already void');
      await query('DELETE FROM till_lodgement_shifts WHERE lodgement_id = $1', [req.params.id]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------ comments on the report --
  // The cashier writes on their own shift (what happened, why it is short); the
  // supervisor writes on any shift and on the day. Both show on the balancing
  // report. A comment is never edited or deleted: a correction is a new one.
  const jamaicaToday = () => new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
  const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
  async function addComment(scope, userId, role, body) {
    await shiftReady();
    const text = String(body || '').trim().slice(0, 1000);
    if (!text) return null;
    const { rows } = await query(
      `INSERT INTO till_comments (session_id, day, user_id, role, body) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [scope.session_id || null, scope.session_id ? null : scope.day, userId, role, text]);
    return rows[0].id;
  }
  async function commentsOf(scope) {
    await shiftReady();
    const { rows } = await query(
      `SELECT c.id, c.role, c.body, c.created_at AS at, u.name AS by FROM till_comments c LEFT JOIN users u ON u.id = c.user_id
        WHERE ${scope.session_id ? 'c.session_id = $1' : 'c.day = $1::date'} ORDER BY c.created_at, c.id`, [scope.session_id || scope.day]);
    return rows;
  }
  // Was this cashier on that shift (opened it or had a turn on it)?
  async function workedShift(sessionId, userId) {
    const { rows } = await query(
      `SELECT EXISTS (SELECT 1 FROM till_sessions WHERE id = $1 AND user_id = $2) OR EXISTS (SELECT 1 FROM till_turns WHERE session_id = $1 AND user_id = $2) AS yes`,
      [sessionId, userId]);
    return rows[0].yes;
  }
  async function commentScope(req, src) {
    const id = parseInt(src.session_id, 10);
    const manager = await isManager(req);
    if (id) {
      const { rows } = await query('SELECT id FROM till_sessions WHERE id = $1', [id]);
      if (!rows[0]) throw httpError(404, 'Shift not found');
      const mine = await workedShift(id, req.session.userId);
      if (!manager && !mine) throw httpError(403, 'You can only comment on a shift you worked');
      return { scope: { session_id: id }, role: manager ? 'supervisor' : 'cashier' };
    }
    if (isDay(src.day)) {
      if (!manager) throw httpError(403, 'Comments on the day are for the supervisor');
      return { scope: { day: src.day }, role: 'supervisor' };
    }
    throw httpError(400, 'Say which shift or day');
  }
  app.get('/api/cash/comments', gate, async (req, res) => {
    try { await shiftReady(); const { scope } = await commentScope(req, req.query); res.json({ comments: await commentsOf(scope) }); } catch (e) { fail(res, e); }
  });
  app.post('/api/cash/comments', gate, async (req, res) => {
    try {
      await shiftReady();
      const b = req.body || {};
      const { scope, role } = await commentScope(req, b);
      if (String(b.body || '').trim().length < 2) throw httpError(400, 'Write the comment first');
      await addComment(scope, req.session.userId, role, b.body);
      res.json({ ok: true, comments: await commentsOf(scope) });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------- open / close with no sale --
  // A shift can be opened by hand (count the float) and closed with nothing
  // sold. Once a till's shift is closed by hand, or the day is closed, the
  // Cashier screen and the POS stop opening a new shift on their own: it stays
  // closed until someone opens one or a sale is rung on the shared counter PC.
  async function dayRow(day) {
    await shiftReady();
    const { rows } = await query(
      `SELECT d.day::text AS day, d.status, d.opened_at, d.closed_at, d.totals, o.name AS opened_by, c.name AS closed_by
         FROM till_days d LEFT JOIN users o ON o.id = d.opened_by LEFT JOIN users c ON c.id = d.closed_by WHERE d.day = $1::date`, [day]);
    const r = rows[0] || null;
    if (r && r.status === 'closed') {
      const { rows: after } = await query(`SELECT COUNT(*)::int AS n FROM till_sessions WHERE opened_at > $1`, [r.closed_at]);
      r.activity_after_close = after[0].n > 0 && day === jamaicaToday();
    }
    return r;
  }
  async function heldClosed(stationId) {
    await shiftReady();
    const { rows } = await query(
      `SELECT EXISTS (SELECT 1 FROM till_days WHERE day = (NOW() AT TIME ZONE 'America/Jamaica')::date AND status = 'closed')
           OR EXISTS (SELECT 1 FROM till_sessions WHERE station_id = $1 AND status = 'closed'
                       AND closed_at >= ((NOW() AT TIME ZONE 'America/Jamaica')::date::timestamp AT TIME ZONE 'America/Jamaica')) AS held`, [stationId]);
    return rows[0].held;
  }
  async function openDay(day, userId) {
    await query(`INSERT INTO till_days (day, status, opened_by) VALUES ($1::date, 'open', $2) ON CONFLICT (day) DO NOTHING`, [day, userId]);
  }
  // Open a shift by hand: count the float (nothing at all is fine).
  app.post('/api/cash/till/open-shift', gate, async (req, res) => {
    try {
      await shiftReady();
      if (!(await canTake(req)) && !(await isManager(req))) throw httpError(403, 'You do not open a cash drawer');
      const st = await terminalStation(req);
      if (!st) throw httpError(400, 'This device is not set up as a station. A manager can set it up on the Stations tab.');
      if (st.kind === 'order') throw httpError(403, 'An order station has no cash drawer');
      if (await openSession(st.id)) throw httpError(409, 'A shift is already open on ' + st.name);
      const b = req.body || {};
      const float = countTotal(b.count);
      const today = jamaicaToday();
      const d = await dayRow(today);
      if (d && d.status === 'closed') {
        if (!(await isManager(req))) throw httpError(409, 'Today has been closed. A supervisor reopens the day first.');
        await query(`UPDATE till_days SET status = 'open', closed_by = NULL, closed_at = NULL WHERE day = $1::date`, [today]);
        await addComment({ day: today }, req.session.userId, 'supervisor', 'Day reopened to open a shift on ' + st.name);
      }
      await openDay(today, req.session.userId);
      let s;
      try {
        ({ rows: [s] } = await query(
          `INSERT INTO till_sessions (station_id, user_id, opening_float, opening_count) VALUES ($1, $2, $3, $4) RETURNING *`,
          [st.id, req.session.userId, float, JSON.stringify(b.count || {})]));
      } catch (e) { if (e.code === '23505') throw httpError(409, 'The drawer here was just opened by someone else'); throw e; }
      await turnsOf(s);
      if (b.notes) await addComment({ session_id: s.id }, req.session.userId, 'cashier', b.notes);
      res.json({ ok: true, session_id: s.id, opening_float: float, station: st.name });
    } catch (e) { fail(res, e); }
  });
  // Open the day (nothing is needed to sell; this just records who opened it).
  app.post('/api/cash/day/open', gate, async (req, res) => {
    try {
      await shiftReady();
      if (!(await canTake(req)) && !(await isManager(req))) throw httpError(403, 'Not allowed');
      const day = isDay((req.body || {}).day) ? req.body.day : jamaicaToday();
      const d = await dayRow(day);
      if (d && d.status === 'closed') {
        if (!(await isManager(req))) throw httpError(409, 'That day has been closed. A supervisor reopens it.');
        await query(`UPDATE till_days SET status = 'open', closed_by = NULL, closed_at = NULL WHERE day = $1::date`, [day]);
      } else await openDay(day, req.session.userId);
      if ((req.body || {}).comment) await addComment({ day }, req.session.userId, (await isManager(req)) ? 'supervisor' : 'cashier', req.body.comment);
      res.json({ ok: true, day: await dayRow(day) });
    } catch (e) { fail(res, e); }
  });
  // Close the day: every shift that day must be closed first. A day with no sale closes at zero.
  app.post('/api/cash/day/close', gate, requireCap('cashier.manage'), async (req, res) => {
    try {
      await shiftReady();
      const b = req.body || {};
      const day = isDay(b.day) ? b.day : jamaicaToday();
      const range = [day];
      const { rows: open } = await query(
        `SELECT t.id, st.name FROM till_sessions t JOIN pos_stations st ON st.id = t.station_id
          WHERE t.status = 'open' AND t.opened_at < (($1::date + 1)::timestamp AT TIME ZONE 'America/Jamaica')`, range);
      if (open.length) throw httpError(409, 'Close these shifts first: ' + open.map((x) => '#' + x.id + ' ' + x.name).join(', '));
      const { rows: sess } = await query(
        `SELECT id, counted_cash, expected_cash, variance FROM till_sessions
          WHERE opened_at >= ($1::date::timestamp AT TIME ZONE 'America/Jamaica') AND opened_at < (($1::date + 1)::timestamp AT TIME ZONE 'America/Jamaica')`, range);
      let sales = 0, total = 0;
      for (const s of sess) { const w = await windowReport(s.id, null, null); sales += w.sales.n; total = r2(total + w.sales.total); }
      const totals = { shifts: sess.length, sales, total,
        counted: r2(sess.reduce((a, s) => a + Number(s.counted_cash || 0), 0)), expected: r2(sess.reduce((a, s) => a + Number(s.expected_cash || 0), 0)),
        variance: r2(sess.reduce((a, s) => a + Number(s.variance || 0), 0)) };
      await query(
        `INSERT INTO till_days (day, status, opened_by, closed_by, closed_at, totals) VALUES ($1::date, 'closed', $2, $2, NOW(), $3)
         ON CONFLICT (day) DO UPDATE SET status = 'closed', closed_by = $2, closed_at = NOW(), totals = $3`, [day, req.session.userId, JSON.stringify(totals)]);
      await addComment({ day }, req.session.userId, 'supervisor', b.comment || (sales ? '' : 'Closed with no sale'));
      res.json({ ok: true, day: await dayRow(day), totals });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/cash/day/reopen', gate, requireCap('cashier.manage'), async (req, res) => {
    try {
      await shiftReady();
      const b = req.body || {};
      if (!isDay(b.day)) throw httpError(400, 'Which day?');
      if (String(b.comment || '').trim().length < 3) throw httpError(400, 'Say why the day is being reopened');
      const { rowCount } = await query(`UPDATE till_days SET status = 'open', closed_by = NULL, closed_at = NULL WHERE day = $1::date AND status = 'closed'`, [b.day]);
      if (!rowCount) throw httpError(409, 'That day is not closed');
      await addComment({ day: b.day }, req.session.userId, 'supervisor', 'Reopened: ' + b.comment);
      res.json({ ok: true, day: await dayRow(b.day) });
    } catch (e) { fail(res, e); }
  });

  // =========================================================================
  //  SENT TO THE CASHIER (2026-11-07, Deb)
  //  Receivables flag a customer's outstanding invoice(s) for a cashier to
  //  collect; a manager (or anyone with cashier.send_payout) sends a payout for
  //  a cashier to pay from the drawer. Either goes to one cashier, one till, or
  //  every cashier, and shows in Due for payment. Whoever pays it owns it: the
  //  money lands on that cashier's shift and report.
  //    collect -> account_payments (deposited to the drawer, card clearing or
  //               cheques account) applied to the flagged invoices
  //    payout  -> a till_movements payout, approved by the sender
  // =========================================================================
  const AR_OPEN = deps.arOpenSql ? `SELECT o.*, GREATEST(o.charged - o.settled, 0) AS open FROM (${deps.arOpenSql}) o WHERE o.charged - o.settled > 0.005` : null;
  const TASK_SENDERS = ['ar.manage', 'cashier.send_payout', 'cashier.manage'];
  async function openItems(customerId, q) {
    if (!AR_OPEN) throw httpError(503, 'Receivables are not available on this server');
    const { rows } = await (q || query)(
      `SELECT o.doc, o.id, o.receipt_number, to_char(o.created_at, 'YYYY-MM-DD') AS day, to_char(o.due_date, 'YYYY-MM-DD') AS due,
              ROUND(o.charged::numeric, 2)::float AS total, ROUND(o.open::numeric, 2)::float AS open
         FROM (${AR_OPEN}) o WHERE o.customer_id = $1 ORDER BY o.created_at, o.id`, [customerId]);
    return rows;
  }
  function targetOf(b) {
    const k = ['user', 'station'].includes(b.target_kind) ? b.target_kind : 'all';
    const uid = parseInt(b.target_user_id, 10), sid = parseInt(b.target_station_id, 10);
    if (k === 'user' && !uid) throw httpError(400, 'Choose the cashier');
    if (k === 'station' && !sid) throw httpError(400, 'Choose the till');
    return { k, uid: k === 'user' ? uid : null, sid: k === 'station' ? sid : null };
  }
  const TASK_COLS = `t.*, t.amount::float AS amount, t.done_amount::float AS done_amount, cu.name AS created_by_name, du.name AS done_by_name,
                     tu.name AS target_user_name, ts.name AS target_station_name`;
  const TASK_FROM = `FROM till_tasks t LEFT JOIN users cu ON cu.id = t.created_by LEFT JOIN users du ON du.id = t.done_by
                     LEFT JOIN users tu ON tu.id = t.target_user_id LEFT JOIN pos_stations ts ON ts.id = t.target_station_id`;
  // What this cashier at this till may take from the list.
  async function mineFilter(req) {
    const st = await terminalStation(req);
    return { sql: `(t.target_kind = 'all' OR (t.target_kind = 'user' AND t.target_user_id = $1) OR (t.target_kind = 'station' AND t.target_station_id = $2))`,
             params: [req.session.userId, st ? st.id : 0], st };
  }

  // The cashier's list: open items sent to them, their till, or everyone.
  app.get('/api/cash/queue', gate, async (req, res) => {
    try {
      await shiftReady();
      const f = await mineFilter(req);
      const { rows } = await query(`SELECT ${TASK_COLS} ${TASK_FROM} WHERE t.status = 'open' AND ${f.sql} ORDER BY t.created_at`, f.params);
      res.json({ tasks: rows });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/cash/tasks/:id', gate, async (req, res) => {
    try {
      await shiftReady();
      const { rows } = await query(`SELECT ${TASK_COLS} ${TASK_FROM} WHERE t.id = $1`, [req.params.id]);
      if (!rows[0]) throw httpError(404, 'Not found');
      const t = rows[0];
      if (t.kind === 'collect' && t.status === 'open' && t.customer_id && AR_OPEN) {
        const open = await openItems(t.customer_id);
        (t.apps || []).forEach((a) => { const o = open.find((x) => x.doc === a.doc && x.id === a.id); a.open_now = o ? o.open : 0; });
      }
      res.json({ task: t });
    } catch (e) { fail(res, e); }
  });
  // Senders' list: everything sent, newest first.
  app.get('/api/cash/tasks', gate, requireAny(TASK_SENDERS, 'send work to the cashiers'), async (req, res) => {
    try {
      await shiftReady();
      const st = ['open', 'done', 'cancelled'].includes(req.query.status) ? req.query.status : null;
      const { rows } = await query(`SELECT ${TASK_COLS} ${TASK_FROM} WHERE ($1::text IS NULL OR t.status = $1) ORDER BY (t.status = 'open') DESC, t.created_at DESC LIMIT 200`, [st]);
      const { rows: cashiers } = await query(
        `SELECT DISTINCT u.id, u.name FROM users u JOIN till_sessions s ON s.user_id = u.id WHERE s.opened_at > NOW() - INTERVAL '60 days' ORDER BY u.name`);
      const { rows: stations } = await query(`SELECT id, name FROM pos_stations WHERE is_active AND kind IN ('cashier', 'integrated') ORDER BY name`);
      res.json({ tasks: rows, cashiers, stations, can: { collect: await userCan(req, 'ar.manage'), payout: await canAny(req, ['cashier.send_payout', 'cashier.manage']) } });
    } catch (e) { fail(res, e); }
  });
  // Customers with something owing, and one customer's open invoices (for the sender's form).
  app.get('/api/cash/tasks-ar/customers', gate, requireCap('ar.manage'), async (req, res) => {
    try {
      if (!AR_OPEN) throw httpError(503, 'Receivables are not available on this server');
      const q = String(req.query.q || '').trim().slice(0, 60);
      const { rows } = await query(
        `SELECT o.customer_id AS id, MAX(o.customer_name) AS name, MAX(u.phone) AS phone, MAX(u.account_number) AS account_number,
                ROUND(SUM(o.open)::numeric, 2)::float AS open, COUNT(*)::int AS invoices
           FROM (${AR_OPEN}) o JOIN users u ON u.id = o.customer_id
          WHERE ($1 = '' OR u.name ILIKE '%' || $1 || '%' OR u.account_number ILIKE $1 || '%' OR u.phone ILIKE '%' || $1 || '%')
          GROUP BY o.customer_id ORDER BY SUM(o.open) DESC LIMIT 40`, [q]);
      res.json({ customers: rows });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/cash/tasks-ar/customers/:id', gate, requireCap('ar.manage'), async (req, res) => {
    try { res.json({ invoices: await openItems(parseInt(req.params.id, 10)) }); } catch (e) { fail(res, e); }
  });
  app.post('/api/cash/tasks/collect', gate, requireCap('ar.manage'), async (req, res) => {
    try {
      await shiftReady();
      const b = req.body || {};
      const cid = parseInt(b.customer_id, 10);
      if (!cid) throw httpError(400, 'Choose the customer');
      const open = await openItems(cid);
      const apps = [];
      for (const a of (Array.isArray(b.items) ? b.items : [])) {
        const o = open.find((x) => x.doc === a.doc && x.id === parseInt(a.id, 10));
        if (!o) throw httpError(400, 'Invoice ' + (a.receipt || a.id) + ' is not open on this account');
        const amt = a.amount == null || a.amount === '' ? o.open : r2(a.amount);
        if (!(amt > 0) || amt > o.open + 0.005) throw httpError(400, (o.receipt_number || 'Invoice') + ' only owes ' + o.open.toFixed(2));
        const dup = await query(`SELECT id FROM till_tasks WHERE kind = 'collect' AND status = 'open' AND apps @> $1::jsonb`, [JSON.stringify([{ doc: o.doc, id: o.id }])]);
        if (dup.rows.length) throw httpError(409, (o.receipt_number || 'That invoice') + ' is already with the cashiers (#' + dup.rows[0].id + ')');
        apps.push({ doc: o.doc, id: o.id, receipt: o.receipt_number, amount: amt, open: o.open });
      }
      if (!apps.length) throw httpError(400, 'Tick the invoice(s) the cashier should collect');
      const tg = targetOf(b);
      const { rows: cu } = await query(`SELECT COALESCE(NULLIF(name, ''), email) AS name FROM users WHERE id = $1`, [cid]);
      const total = r2(apps.reduce((a, x) => a + x.amount, 0));
      const { rows } = await query(
        `INSERT INTO till_tasks (kind, target_kind, target_user_id, target_station_id, customer_id, customer_name, apps, amount, note, created_by)
         VALUES ('collect', $1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [tg.k, tg.uid, tg.sid, cid, cu[0] ? cu[0].name : null, JSON.stringify(apps), total, String(b.note || '').slice(0, 300) || null, req.session.userId]);
      res.json({ ok: true, id: rows[0].id, amount: total });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/cash/tasks/payout', gate, requireAny(['cashier.send_payout', 'cashier.manage'], 'send a payout to a cashier'), async (req, res) => {
    try {
      await shiftReady();
      const b = req.body || {};
      const amount = r2(b.amount), payee = String(b.payee || '').trim(), reason = String(b.reason || '').trim();
      if (!(amount > 0)) throw httpError(400, 'Enter the amount');
      if (payee.length < 2) throw httpError(400, 'Who is being paid?');
      if (reason.length < 3) throw httpError(400, 'What is it for?');
      const tg = targetOf(b);
      const { rows } = await query(
        `INSERT INTO till_tasks (kind, target_kind, target_user_id, target_station_id, payee, reason, amount, note, created_by)
         VALUES ('payout', $1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [tg.k, tg.uid, tg.sid, payee.slice(0, 120), reason.slice(0, 200), amount, String(b.note || '').slice(0, 300) || null, req.session.userId]);
      res.json({ ok: true, id: rows[0].id });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/cash/tasks/:id/cancel', gate, async (req, res) => {
    try {
      await shiftReady();
      const { rows } = await query('SELECT * FROM till_tasks WHERE id = $1', [req.params.id]);
      if (!rows[0]) throw httpError(404, 'Not found');
      if (rows[0].created_by !== req.session.userId && !(await isManager(req))) throw httpError(403, 'Only the sender or a manager can take it back');
      const why = String((req.body || {}).reason || '').trim();
      const { rowCount } = await query(`UPDATE till_tasks SET status = 'cancelled', cancelled_by = $2, cancelled_at = NOW(), cancel_reason = $3 WHERE id = $1 AND status = 'open'`,
        [req.params.id, req.session.userId, why.slice(0, 300) || null]);
      if (!rowCount) throw httpError(409, 'It has already been ' + rows[0].status);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  const DEPOSIT_KEY = { cash: 'cash_drawers', card: 'card_clearing', cheque: 'cheques' };
  // The cashier takes the money (collect) or pays it out (payout) on their own shift.
  app.post('/api/cash/tasks/:id/pay', gate, requireAny(['cashier.access', 'pos.finalise_invoice'], 'take payment at the till'), async (req, res) => {
    try {
      await shiftReady();
      const b = req.body || {};
      const f = await mineFilter(req);
      const st = f.st;
      if (!st || st.kind === 'order') throw httpError(403, 'Use a cashier till for this');
      const s = await openSession(st.id);
      if (!s) throw httpError(409, 'Open a shift on ' + st.name + ' first');
      if (s.user_id !== req.session.userId) throw httpError(409, 'The drawer at ' + st.name + ' is under another cashier. Take it over first.');
      if (await waitingForRelief(s.id)) throw httpError(409, 'The drawer was handed over. Take it over first.');
      const { rows: tk } = await query(`SELECT t.* FROM till_tasks t WHERE t.id = $1 AND t.status = 'open' AND (t.target_kind = 'all' OR (t.target_kind = 'user' AND t.target_user_id = $2) OR (t.target_kind = 'station' AND t.target_station_id = $3))`,
        [req.params.id, req.session.userId, st.id]);
      if (!tk[0]) throw httpError(409, 'This is no longer waiting for you (taken, taken back, or sent to another cashier)');
      const t = tk[0];
      const ref = String(b.reference || '').slice(0, 60) || null;
      let out;
      if (t.kind === 'payout') {
        const amount = t.amount;
        out = await txn(async (c) => {
          const { rowCount } = await c.query(`UPDATE till_tasks SET status = 'done' WHERE id = $1 AND status = 'open'`, [t.id]);
          if (!rowCount) throw httpError(409, 'Someone else just paid it');
          const { rows: m } = await c.query(
            `INSERT INTO till_movements (session_id, kind, amount, reason, by_user, approved_by) VALUES ($1, 'payout', $2, $3, $4, $5) RETURNING id`,
            [s.id, amount, (t.payee + ': ' + t.reason).slice(0, 300), req.session.userId, t.created_by]);
          await c.query(`UPDATE till_tasks SET done_by = $2, done_at = NOW(), session_id = $3, done_amount = $4, done_method = 'cash', done_reference = $5, movement_id = $6 WHERE id = $1`,
            [t.id, req.session.userId, s.id, amount, ref, m[0].id]);
          return { paid_out: Number(amount) };
        });
      } else {
        const method = ['cash', 'card', 'cheque', 'bank'].includes(b.method) ? b.method : null;
        if (!method) throw httpError(400, 'Cash, card, cheque or bank transfer?');
        if (method !== 'cash' && !ref && method !== 'bank') throw httpError(400, 'Enter the ' + (method === 'card' ? 'card slip' : 'cheque') + ' number');
        const amount = b.amount == null || b.amount === '' ? Number(t.amount) : r2(b.amount);
        if (!(amount > 0)) throw httpError(400, 'Enter the amount received');
        const open = await openItems(t.customer_id);
        let left = amount; const apply = [];
        for (const a of (t.apps || [])) {
          const o = open.find((x) => x.doc === a.doc && x.id === a.id);
          const room = Math.min(o ? o.open : 0, Number(a.amount));
          const take = r2(Math.min(left, room));
          if (take > 0) { apply.push({ doc: a.doc, id: a.id, amount: take }); left = r2(left - take); }
        }
        if (left > 0.005) throw httpError(400, 'That is more than the ' + r2(amount - left).toFixed(2) + ' still owed on these invoices');
        const { rows: acct } = DEPOSIT_KEY[method] ? await query(`SELECT id FROM gl_accounts WHERE system_key = $1 LIMIT 1`, [DEPOSIT_KEY[method]]) : { rows: [] };
        out = await txn(async (c) => {
          const { rowCount } = await c.query(`UPDATE till_tasks SET status = 'done' WHERE id = $1 AND status = 'open'`, [t.id]);
          if (!rowCount) throw httpError(409, 'Someone else just took it');
          const { rows: ap } = await c.query(
            `INSERT INTO account_payments (customer_id, amount_usd, method, reference, notes, received_by, paid_on, deposit_account_id)
             VALUES ($1, $2, $3, $4, $5, $6, (NOW() AT TIME ZONE 'America/Jamaica')::date, $7) RETURNING id`,
            [t.customer_id, amount, method, ref, ('Taken at the till, ' + st.name + ' shift ' + s.id).slice(0, 300), req.session.userId, acct[0] ? acct[0].id : null]);
          for (const a of apply)
            await c.query(`INSERT INTO ar_applications (payment_id, sale_id, invoice_id, amount, applied_by) VALUES ($1, $2, $3, $4, $5)`,
              [ap[0].id, a.doc === 'sale' ? a.id : null, a.doc === 'invoice' ? a.id : null, a.amount, req.session.userId]);
          await c.query(`UPDATE till_tasks SET done_by = $2, done_at = NOW(), session_id = $3, done_amount = $4, done_method = $5, done_reference = $6, account_payment_id = $7 WHERE id = $1`,
            [t.id, req.session.userId, s.id, amount, method, ref, ap[0].id]);
          return { collected: amount, method, payment_id: ap[0].id, short: r2(Number(t.amount) - amount) };
        });
      }
      res.json(Object.assign({ ok: true, session_id: s.id }, out));
    } catch (e) { fail(res, e); }
  });
  // One transaction on a pooled client when the server gives us one, else plain queries.
  async function txn(fn) {
    if (!deps.getPool) return fn({ query });   // no pool handed over: the status guard still stops a double take
    const c = await deps.getPool().connect();
    try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
    catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
    finally { c.release(); }
  }
  // Cash taken on account at the till during a shift (for the Z report's expected cash).
  async function collectedCash(sessionId) {
    await shiftReady();
    const { rows } = await query(`SELECT COALESCE(SUM(done_amount), 0)::float AS c FROM till_tasks WHERE kind = 'collect' AND status = 'done' AND session_id = $1 AND done_method = 'cash'`, [sessionId]);
    return r2(rows[0].c);
  }

  // =========================================================================
  //  ADJUST THE BILL AT THE CASHIER (customer is short)
  //  Lower a quantity or take a line off (cashier.adjust_bill), or give a
  //  discount (the cashier's own POS discount permissions and limit; past the
  //  limit, a manager's PIN, as at the till). Priced again through the sale
  //  code; every change is kept on the order with the reason.
  // =========================================================================
  app.post('/api/admin/pos/orders/:id/adjust', posGate, requireAny(['cashier.access', 'pos.finalise_invoice'], 'adjust bills at the cashier'), async (req, res) => {
    try {
      await shiftReady();
      const id = parseInt(req.params.id, 10);
      const { rows: o } = await query(`SELECT * FROM pos_orders WHERE id = $1`, [id]);
      if (!o[0]) throw httpError(404, 'Order not found');
      if (o[0].status !== 'pending') throw httpError(409, 'Order is ' + o[0].status);
      const b = req.body || {};
      const reason = String(b.reason || '').trim();
      if (reason.length < 3) throw httpError(400, 'Say why the bill is being changed');
      const before = o[0].payload || {};
      const items = (before.items || []).map((x) => Object.assign({}, x));
      const lines = Array.isArray(b.lines) ? b.lines : [];
      let cut = false, moreDisc = false;
      const changes = [];
      const keep = [];
      items.forEach((it, i) => {
        const l = lines.find((x) => Number(x.index) === i) || {};
        const q0 = Number(it.qty) || 0, d0 = Number(it.discount_usd) || 0;
        let q = l.remove ? 0 : (l.qty == null || l.qty === '' ? q0 : Number(l.qty));
        if (!(q >= 0) || Math.floor(q) !== q) throw httpError(400, 'Quantities are whole numbers');
        if (q > q0) throw httpError(400, 'A quantity can only go down here; the counter adds items');
        let d = l.discount_usd == null || l.discount_usd === '' ? d0 : r2(l.discount_usd);
        if (d < 0) throw httpError(400, 'A discount cannot be negative');
        const name = it.description || it.product_img;
        if (q < q0) { cut = true; changes.push(q === 0 ? 'Removed ' + name + ' (×' + q0 + ')' : name + ': qty ' + q0 + ' → ' + q); }
        if (q > 0) {
          if (q < q0 && d0 > 0) d = Math.min(d, r2(d0 * q / q0) + Math.max(0, d - d0));   // a line discount shrinks with the quantity
          if (d > d0 + 0.004) { moreDisc = true; changes.push(name + ': discount ' + d0.toFixed(2) + ' → ' + d.toFixed(2)); }
          else if (d < d0 - 0.004) changes.push(name + ': discount ' + d0.toFixed(2) + ' → ' + d.toFixed(2));
          keep.push(Object.assign(it, { qty: q, discount_usd: d }));
        }
      });
      const td0 = Number(before.discount_usd) || 0;
      const td = b.ticket_discount_usd == null || b.ticket_discount_usd === '' ? td0 : r2(b.ticket_discount_usd);
      if (td < 0) throw httpError(400, 'A discount cannot be negative');
      if (td > td0 + 0.004) { moreDisc = true; changes.push('Ticket discount ' + td0.toFixed(2) + ' → ' + td.toFixed(2)); }
      else if (td < td0 - 0.004) changes.push('Ticket discount ' + td0.toFixed(2) + ' → ' + td.toFixed(2));
      if (!changes.length) throw httpError(400, 'Nothing was changed');
      if (!keep.length) throw httpError(400, 'Every line would be gone: cancel the order instead');
      if (cut && !(await canAny(req, ['cashier.adjust_bill', 'cashier.manage']))) throw httpError(403, 'Your account is not allowed to take items off a bill or lower a quantity (Cashier: adjust a bill).');
      const after = Object.assign({}, before, { items: keep, discount_usd: td });
      // Discounts given here are checked against the cashier (permissions, own
      // limit, manager PIN); a cut alone is priced as the saved order.
      const dryBody = Object.assign({}, after, { dry_run: true, payments: [{ method: 'cash', amount_usd: null }] });
      const dry = await runSale(req, dryBody, moreDisc ? null : o[0]);
      if (dry.body && dry.body.discount_limit) return res.status(403).json(dry.body);
      if (dry.status !== 200 || !dry.body || !dry.body.ok) {
        const msg = (dry.body && dry.body.error) || 'Could not price the changed bill';
        throw httpError(dry.status || 400, /unit price/.test(msg) ? 'This order has hand-priced lines, so a manager has to give this discount. ' + msg : msg);
      }
      const { rowCount } = await query(`UPDATE pos_orders SET payload = $2, preview = $3, total_usd = $4 WHERE id = $1 AND status = 'pending'`,
        [id, JSON.stringify(after), JSON.stringify(dry.body), dry.body.total_usd]);
      if (!rowCount) throw httpError(409, 'The order was taken meanwhile');
      await query(`INSERT INTO pos_order_events (order_id, kind, user_id, detail) VALUES ($1, 'adjust', $2, $3)`,
        [id, req.session.userId, JSON.stringify({ reason: reason.slice(0, 300), changes, total_before: Number(o[0].total_usd), total_after: dry.body.total_usd })]);
      res.json({ ok: true, total_usd: dry.body.total_usd, total_before: Number(o[0].total_usd), changes });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/admin/pos/orders/:id/events', posGate, async (req, res) => {
    try {
      await shiftReady();
      const { rows } = await query(`SELECT e.id, e.kind, e.detail, e.created_at AS at, u.name AS by FROM pos_order_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.order_id = $1 ORDER BY e.id`, [req.params.id]);
      res.json({ events: rows });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------- send the bill to the sales rep --
  // Who to send it to (the order's sales rep, else whoever saved it) and the
  // bill as a chat message. The Cashier screen posts it through Team chat.
  app.get('/api/admin/pos/orders/:id/for-rep', posGate, async (req, res) => {
    try {
      const { rows: o } = await query(
        `SELECT o.*, tb.name AS taken_by_name, m.user_id AS rep_user_id, ru.name AS rep_user_name
           FROM pos_orders o LEFT JOIN users tb ON tb.id = o.taken_by LEFT JOIN mechanics m ON m.id = o.sales_rep_id LEFT JOIN users ru ON ru.id = m.user_id
          WHERE o.id = $1`, [req.params.id]);
      if (!o[0]) throw httpError(404, 'Order not found');
      const x = o[0];
      const to = [];
      if (x.rep_user_id) to.push({ user_id: x.rep_user_id, name: x.rep_user_name || x.sales_rep_name, why: 'sales rep' });
      if (x.taken_by && x.taken_by !== x.rep_user_id) to.push({ user_id: x.taken_by, name: x.taken_by_name, why: 'saved the order' });
      const p = x.payload || {}, pv = x.preview || {};
      const imgs = (p.items || []).map((it) => it.product_img).filter(Boolean);
      const { rows: prods } = imgs.length ? await query('SELECT img, name FROM products WHERE img = ANY($1::text[])', [imgs]) : { rows: [] };
      const nm = new Map(prods.map((r) => [r.img, r.name]));
      const money = (v) => 'J$' + Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const lines = (p.items || []).map((it) => '• ' + (nm.get(it.product_img) || it.description || it.product_img) + ' × ' + it.qty + ' @ ' + money(it.unit_price_usd) +
        (Number(it.discount_usd) > 0 ? ' (−' + money(it.discount_usd) + ')' : ''));
      const { rows: ev } = await query(`SELECT detail FROM pos_order_events WHERE order_id = $1 AND kind = 'adjust' ORDER BY id`, [x.id]).catch(() => ({ rows: [] }));
      const text = '🧾 Bill for order #' + x.id + ' · ' + (x.customer_name || 'Walk-in') + (x.customer_phone ? ' · ' + x.customer_phone : '') + '\n' +
        lines.join('\n') + '\n' +
        (Number(p.discount_usd) > 0 ? 'Ticket discount: −' + money(p.discount_usd) + '\n' : '') +
        (pv.tax_usd != null ? 'GCT: ' + money(pv.tax_usd) + '\n' : '') +
        'TOTAL DUE: ' + money(x.total_usd) +
        (ev.length ? '\nChanged at the cashier: ' + ev.map((e) => (e.detail.changes || []).join('; ') + ' (' + e.detail.reason + ')').join(' | ') : '');
      res.json({ to, text, order_id: x.id });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/admin/pos/orders/:id/sent-to-rep', posGate, async (req, res) => {
    try {
      await shiftReady();
      const b = req.body || {};
      await query(`INSERT INTO pos_order_events (order_id, kind, user_id, detail) VALUES ($1, 'sent_to_rep', $2, $3)`,
        [parseInt(req.params.id, 10), req.session.userId, JSON.stringify({ to_user_id: parseInt(b.to_user_id, 10) || null, to: String(b.to || '').slice(0, 80), conversation_id: parseInt(b.conversation_id, 10) || null })]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
}

module.exports = { register, DENOMS };
