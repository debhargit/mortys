// =============================================================================
//  Vision Auto Solutions -- Cashier module
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
      if (s.user_id !== req.session.userId) return res.status(409).json({ error: 'The drawer at ' + st.name + ' is open under another cashier. Close it or sign in as them.' });
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
        if (session.user_id !== req.session.userId) throw httpError(409, 'The drawer at ' + st.name + ' is open under another cashier.');
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
      ['fulfilment', 'ship_method', 'ship_fee_usd', 'ship_name', 'ship_phone', 'ship_line1', 'ship_line2', 'ship_city', 'ship_parish', 'ship_instructions']
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
    const expected = r2(s[0].opening_float + cashSales + sum('float_in') - sum('drop') - sum('payout'));
    return {
      session: s[0], tenders, sales: sales[0], movements: mv,
      cash: { opening_float: s[0].opening_float, cash_sales: r2(cashSales), float_in: r2(sum('float_in')), drops: r2(sum('drop')), payouts: r2(sum('payout')), expected },
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
      if (!s && (await autoOpenOn()) && (await canAny(req, ['cashier.access', 'pos.finalise_invoice', 'pos.access']))) { s = await autoOpen(st.id, req.session.userId); opened = !!s; }
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
      res.json({ ok: true, expected: rep.cash.expected, counted, variance: r2(counted - rep.cash.expected) });
    } catch (e) { fail(res, e); }
  });
}

module.exports = { register, DENOMS };
