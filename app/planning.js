// =============================================================================
//  Vision Auto Solutions -- Sales and planning (Phase 5)
//
//  Mounted by server.js:  require('./planning').register(app, deps)
//  Routes under /api/plan. Capabilities: sales.lost_record (record a sale we
//  could not make), planning.view (lost-sales report, planning dashboard,
//  targets).
//
//  Lost sales come from three places and are read where they live:
//    manual   lost_sales rows (counter, phone, online, warehouse)
//    short    fulfilment_lines.qty_short (picker could not find / damaged)
//    order    pos_orders that expired or were cancelled at the cashier
//  Value is J$ at the price asked (manual), the line price (orders) or the
//  part's current price (short picks).
//
//  Dashboard (one period, compared with the one before it):
//    sales and gross profit, inventory value and days of cover, dead and slow
//    stock, fill rate, stock-outs of parts that sell, pick and count accuracy,
//    supplier lead time (actual vs set), backorders, payables, cashier
//    over/short. Targets come from warehouse_settings (plan_*), so the
//    restructuring KPIs can be set once and shown against the actuals.
//  Read-only except lost-sale records and targets. Times are Jamaica local.
// =============================================================================
'use strict';

const TZ = 'America/Jamaica';
const REASONS = ['out_of_stock', 'not_stocked', 'price', 'lead_time', 'quality', 'other'];
const CHANNELS = ['counter', 'phone', 'online', 'warehouse'];
const TARGETS = {
  plan_target_fill_rate: { dflt: '95', label: 'Fill rate %' },
  plan_target_days_cover: { dflt: '90', label: 'Inventory days of cover' },
  plan_target_gp_pct: { dflt: '35', label: 'Gross profit %' },
  plan_target_pick_accuracy: { dflt: '99', label: 'Pick accuracy %' },
  plan_target_count_accuracy: { dflt: '97', label: 'Count accuracy %' },
  plan_target_dead_pct: { dflt: '10', label: 'Dead stock, max % of stock value' },
  plan_dead_days: { dflt: '365', label: 'Dead stock: no sale in (days)' },
  plan_slow_days: { dflt: '180', label: 'Slow stock: no sale in (days)' },
};

function register(app, deps) {
  const { query, requireAdmin, requireCap, userCan, notify } = deps;
  const can = (k) => [requireAdmin, requireCap(k)];
  const n = (v) => (v == null ? 0 : Number(v));
  const r2 = (v) => Math.round(n(v) * 100) / 100;
  const pct = (a, b) => (n(b) ? Math.round((n(a) / n(b)) * 1000) / 10 : null);
  const jm = (v) => 'J$' + Math.round(n(v)).toLocaleString('en-US');

  function httpError(status, msg) { const e = new Error(msg); e.status = status; e.publicMessage = msg; return e; }
  function fail(res, e) { const s = e.status || 500; if (s >= 500) console.error('[plan]', e); res.status(s).json({ error: e.publicMessage || e.message }); }
  async function settings() {
    const { rows } = await query(`SELECT key, value FROM warehouse_settings WHERE key = ANY($1)`, [Object.keys(TARGETS)]);
    const out = {};
    for (const k of Object.keys(TARGETS)) { const r = rows.find((x) => x.key === k); out[k] = n(r && r.value != null ? r.value : TARGETS[k].dflt); }
    return out;
  }
  // Period edges as instants, Jamaica midnight to midnight; default the last 30
  // days. p0 starts the equally long period before, for comparison.
  async function period(q) {
    const iso = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s || '') ? s : null);
    let from = iso(q.from), to = iso(q.to);
    if (!from || !to) {
      const { rows } = await query(`SELECT to_char((NOW() AT TIME ZONE '${TZ}')::date - 29, 'YYYY-MM-DD') AS f, to_char((NOW() AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS t`);
      from = rows[0].f; to = rows[0].t;
    }
    if (from > to) throw httpError(400, 'From must be before to');
    const { rows } = await query(
      `SELECT ($1::date)::timestamp AT TIME ZONE '${TZ}' AS t0, ($2::date + 1)::timestamp AT TIME ZONE '${TZ}' AS t1,
              ($1::date - ($2::date - $1::date + 1))::timestamp AT TIME ZONE '${TZ}' AS p0, ($2::date - $1::date + 1) AS days`, [from, to]);
    return { from, to, t0: rows[0].t0, t1: rows[0].t1, p0: rows[0].p0, days: n(rows[0].days) };
  }

  // ------------------------------------------------------- lost sales --
  // Every lost unit in a period, from all three sources, in one shape.
  const LOST_SQL = `
    SELECT 'manual' AS source, l.id::text AS ref, l.id AS lost_id, l.created_at, l.product_img, COALESCE(p.sku, '') AS sku,
           COALESCE(p.name, l.description) AS name, l.description AS asked_for, l.vehicle, l.qty,
           COALESCE(l.unit_price, p.price_usd, 0) AS unit_price, l.reason, l.channel, l.competitor,
           l.customer_name, l.customer_phone, l.follow_up, l.followed_up_at, l.note, u.name AS recorded_by,
           COALESCE(p.stock_count, 0) AS stock_now
      FROM lost_sales l LEFT JOIN products p ON p.img = l.product_img LEFT JOIN users u ON u.id = l.recorded_by
     WHERE l.created_at >= $1 AND l.created_at < $2
    UNION ALL
    SELECT 'short_pick', f.number, NULL, COALESCE(fl.picked_at, f.created_at), fl.product_img, COALESCE(fl.sku, p.sku, ''),
           COALESCE(p.name, fl.description), fl.description, NULL, fl.qty_short,
           COALESCE(p.price_usd, 0), 'short_' || COALESCE(fl.short_reason, 'not_found'), 'warehouse', NULL,
           f.customer_name, NULL, false, NULL, f.source_ref, u.name, COALESCE(p.stock_count, 0)
      FROM fulfilment_lines fl JOIN fulfilments f ON f.id = fl.fulfilment_id
      LEFT JOIN products p ON p.img = fl.product_img LEFT JOIN users u ON u.id = fl.picked_by
     WHERE fl.qty_short > 0 AND COALESCE(fl.picked_at, f.created_at) >= $1 AND COALESCE(fl.picked_at, f.created_at) < $2
    UNION ALL
    SELECT 'order_' || o.status, 'ORD-' || o.id, NULL, o.created_at, x->>'product_img', COALESCE(p.sku, ''),
           COALESCE(p.name, x->>'description'), x->>'description', NULL, GREATEST(COALESCE((x->>'qty')::numeric, 1), 1)::int,
           COALESCE((x->>'unit_price_usd')::numeric, p.price_usd, 0), 'order_' || o.status, 'counter', NULL,
           o.customer_name, o.customer_phone, false, NULL, o.cancel_reason, u.name, COALESCE(p.stock_count, 0)
      FROM pos_orders o CROSS JOIN LATERAL jsonb_array_elements(COALESCE(o.payload->'items', '[]'::jsonb)) x
      LEFT JOIN products p ON p.img = x->>'product_img' LEFT JOIN users u ON u.id = o.taken_by
     WHERE o.status IN ('expired', 'cancelled') AND o.created_at >= $1 AND o.created_at < $2`;

  async function lostSummary(t0, t1) {
    const { rows } = await query(
      `SELECT source, COUNT(*)::int AS lines, COALESCE(SUM(qty), 0)::int AS units, COALESCE(SUM(qty * unit_price), 0) AS value
         FROM (${LOST_SQL}) x GROUP BY source`, [t0, t1]);
    const tot = { lines: 0, units: 0, value: 0, by_source: {} };
    for (const r of rows) { tot.lines += r.lines; tot.units += r.units; tot.value += n(r.value); tot.by_source[r.source] = { lines: r.lines, units: r.units, value: r2(r.value) }; }
    tot.value = r2(tot.value);
    return tot;
  }

  app.post('/api/plan/lost-sales', ...can('sales.lost_record'), async (req, res) => {
    try {
      const b = req.body || {};
      const img = b.product_img ? String(b.product_img) : null;
      let desc = String(b.description || '').trim().slice(0, 300);
      if (img) {
        const { rows } = await query('SELECT name FROM products WHERE img = $1', [img]);
        if (!rows.length) throw httpError(400, 'That part is not in the catalogue');
        if (!desc) desc = rows[0].name;
      }
      if (!desc) throw httpError(400, 'Say what the customer asked for');
      const qty = Math.max(1, Math.min(9999, parseInt(b.qty, 10) || 1));
      const reason = REASONS.includes(b.reason) ? b.reason : (img ? 'out_of_stock' : 'not_stocked');
      const channel = CHANNELS.includes(b.channel) ? b.channel : 'counter';
      const price = b.unit_price === '' || b.unit_price == null ? null : Number(b.unit_price);
      if (price != null && !(price >= 0)) throw httpError(400, 'Price must be a number');
      const t = (v, m) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, m));
      const phone = t(b.customer_phone, 40);
      const { rows } = await query(
        `INSERT INTO lost_sales (product_img, description, vehicle, qty, unit_price, reason, channel, competitor,
                                 customer_id, customer_name, customer_phone, follow_up, note, recorded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [img, desc, t(b.vehicle, 120), qty, price, reason, channel, t(b.competitor, 80),
         parseInt(b.customer_id, 10) || null, t(b.customer_name, 120), phone, !!b.follow_up && !!phone,
         t(b.note, 500), req.session.userId]);
      res.json({ ok: true, id: rows[0].id });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/plan/lost-sales', ...can('planning.view'), async (req, res) => {
    try {
      const p = await period(req.query);
      const src = String(req.query.source || '').replace(/[^a-z_]/g, '');
      const { rows } = await query(
        `SELECT * FROM (${LOST_SQL}) x ${src ? `WHERE source LIKE $3 || '%'` : ''} ORDER BY created_at DESC LIMIT 1000`,
        src ? [p.t0, p.t1, src] : [p.t0, p.t1]);
      const { rows: byReason } = await query(
        `SELECT reason, COUNT(*)::int AS lines, SUM(qty)::int AS units, SUM(qty * unit_price) AS value
           FROM (${LOST_SQL}) x GROUP BY reason ORDER BY 4 DESC NULLS LAST`, [p.t0, p.t1]);
      // Parts asked for most: the stocking decisions. Parts not in the catalogue group by what was asked.
      const { rows: top } = await query(
        `SELECT MAX(product_img) AS product_img, MAX(sku) AS sku, MAX(name) AS name,
                COUNT(*)::int AS times, SUM(qty)::int AS units, SUM(qty * unit_price) AS value,
                MAX(stock_now)::int AS stock_now, string_agg(DISTINCT reason, ', ') AS reasons, MAX(created_at) AS last_at
           FROM (${LOST_SQL}) x GROUP BY COALESCE(product_img, 'ask:' || lower(trim(asked_for)))
          ORDER BY value DESC NULLS LAST, units DESC LIMIT 50`, [p.t0, p.t1]);
      res.json({
        period: { from: p.from, to: p.to }, summary: await lostSummary(p.t0, p.t1),
        by_reason: byReason.map((r) => ({ ...r, value: r2(r.value) })),
        top: top.map((r) => ({ ...r, value: r2(r.value) })),
        rows: rows.map((r) => ({ ...r, value: r2(n(r.qty) * n(r.unit_price)) })),
      });
    } catch (e) { fail(res, e); }
  });

  // Customers waiting on a part, the ones whose part is now on the shelf first.
  app.get('/api/plan/follow-ups', ...can('sales.lost_record'), async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT l.id, l.created_at, l.description, l.qty, l.customer_name, l.customer_phone, l.vehicle, p.sku, p.name, p.stock_count, p.price_usd,
                COALESCE(p.stock_count >= l.qty, false) AS in_stock,
                (SELECT MAX(n.created_at) FROM notifications n WHERE n.related_kind = 'lost_sale' AND n.related_id = l.id
                    AND n.status IN ('sent', 'stubbed', 'queued')) AS messaged_at,
                (SELECT n.id FROM notifications n WHERE n.related_kind = 'lost_sale' AND n.related_id = l.id AND n.status = 'link'
                  ORDER BY n.id DESC LIMIT 1) AS whatsapp_id
           FROM lost_sales l LEFT JOIN products p ON p.img = l.product_img
          WHERE l.follow_up AND l.followed_up_at IS NULL AND l.created_at > NOW() - INTERVAL '120 days'
          ORDER BY COALESCE(p.stock_count >= l.qty, false) DESC, l.created_at LIMIT 300`);
      res.json({ follow_ups: rows });
    } catch (e) { fail(res, e); }
  });

  // Text the customer that the part is in (template part_in_stock). Staff still
  // mark the call-back done once the customer has answered.
  app.post('/api/plan/lost-sales/:id/notify', ...can('sales.lost_record'), async (req, res) => {
    try {
      if (!notify) throw httpError(503, 'Messages are not available');
      const { rows } = await query(
        `SELECT l.*, p.name AS part_name, p.stock_count FROM lost_sales l LEFT JOIN products p ON p.img = l.product_img WHERE l.id = $1`,
        [parseInt(req.params.id, 10) || 0]);
      if (!rows.length) throw httpError(404, 'Not found');
      const l = rows[0];
      if (!l.customer_phone) throw httpError(409, 'No phone number on this entry');
      if (l.product_img && !(l.stock_count >= l.qty)) throw httpError(409, 'The part is not in stock yet');
      const out = await notify.send('part_in_stock',
        { name: l.customer_name, phone: l.customer_phone, customer_id: l.customer_id, part: l.part_name || l.description },
        { related_kind: 'lost_sale', related_id: l.id, by_user: req.session.userId, force: true });
      res.json({ messages: out.map((n) => ({ id: n.id, channel: n.channel, status: n.status, reason: n.reason,
        wa_link: n.channel === 'whatsapp' && n.status === 'link' ? notify.waLink(n.to_addr, n.body || '') : undefined })) });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/plan/lost-sales/:id/followed-up', ...can('sales.lost_record'), async (req, res) => {
    try {
      const { rowCount } = await query(
        `UPDATE lost_sales SET followed_up_at = NOW(), note = CONCAT_WS(' | ', note, NULLIF($2::text, '')) WHERE id = $1 AND followed_up_at IS NULL`,
        [parseInt(req.params.id, 10) || 0, String((req.body || {}).note || '').trim().slice(0, 300)]);
      if (!rowCount) throw httpError(404, 'Not found, or already followed up');
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // A mistaken entry can be removed by whoever recorded it within a day, or by a planner.
  app.delete('/api/plan/lost-sales/:id', ...can('sales.lost_record'), async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10) || 0;
      const { rows } = await query(`SELECT recorded_by, created_at > NOW() - INTERVAL '24 hours' AS fresh FROM lost_sales WHERE id = $1`, [id]);
      if (!rows.length) throw httpError(404, 'Not found');
      const own = rows[0].recorded_by === (req.session.userId) && rows[0].fresh;
      if (!own && !(await userCan(req, 'planning.view'))) throw httpError(403, 'Only the person who recorded it (within a day) or a planner can remove it');
      await query('DELETE FROM lost_sales WHERE id = $1', [id]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // -------------------------------------------------------- targets --
  app.get('/api/plan/targets', ...can('planning.view'), async (req, res) => {
    try {
      const s = await settings();
      res.json({ can_edit: await userCan(req, 'planning.targets'), targets: Object.keys(TARGETS).map((k) => ({ key: k, label: TARGETS[k].label, value: s[k] })) });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/plan/targets', ...can('planning.targets'), async (req, res) => {
    try {
      const b = req.body || {};
      for (const k of Object.keys(b)) {
        if (!TARGETS[k]) continue;
        const v = Number(b[k]);
        if (!(v >= 0) || v > 100000) throw httpError(400, TARGETS[k].label + ' must be a positive number');
        await query(`INSERT INTO warehouse_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [k, String(v)]);
      }
      ageCache = null;
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------ dashboard --
  // Every in-stock part banded by its last sale. Reading the last sale of every
  // part takes about a second over the full history, so it is kept 10 minutes.
  let ageCache = null;
  async function stockAgeing(deadDays, slowDays) {
    const key = deadDays + '/' + slowDays;
    if (ageCache && ageCache.key === key && ageCache.at > Date.now() - 600000) return ageCache.data;
    const { rows } = await query(
      `WITH ls AS (
         SELECT i.product_img, MAX(s.created_at) AS last_sold
           FROM pos_sale_items i JOIN pos_sales s ON s.id = i.sale_id
          WHERE i.product_img IS NOT NULL AND s.receipt_number NOT LIKE 'CN%' AND NOT COALESCE(s.voided, false)
          GROUP BY i.product_img),
       st AS (
         SELECT p.img, p.sku, p.name, p.category, p.stock_count, COALESCE(p.cost_usd, 0) AS cost, COALESCE(p.price_usd, 0) AS price, ls.last_sold,
                CASE WHEN COALESCE(ls.last_sold, p.created_at, NOW() - INTERVAL '100 years') < NOW() - make_interval(days => $1::int) THEN 'dead'
                     WHEN COALESCE(ls.last_sold, p.created_at, NOW() - INTERVAL '100 years') < NOW() - make_interval(days => $2::int) THEN 'slow'
                     ELSE 'active' END AS band
           FROM products p LEFT JOIN ls ON ls.product_img = p.img
          WHERE p.stock_count > 0)
       SELECT band, COUNT(*)::int AS skus, SUM(stock_count)::int AS units, SUM(stock_count * cost) AS cost, SUM(stock_count * price) AS retail,
              (SELECT json_agg(t) FROM (SELECT img, sku, name, category, stock_count, cost, price, stock_count * cost AS value,
                                               to_char(last_sold AT TIME ZONE '${TZ}', 'YYYY-MM-DD') AS last_sold
                                          FROM st s2 WHERE s2.band = st.band ORDER BY stock_count * cost DESC LIMIT 40) t) AS top
         FROM st GROUP BY band`, [deadDays, slowDays]);
    const data = {};
    for (const r of rows) data[r.band] = { skus: r.skus, units: r.units, cost: r2(r.cost), retail: r2(r.retail), top: (r.top || []).map((t) => ({ ...t, value: r2(t.value) })) };
    // Last sale dates are only trustworthy back to the newest sale that has no
    // lines; a part last sold before that may have sold since and not show it.
    const { rows: gap } = await query(
      `SELECT to_char(MAX(s.created_at) AT TIME ZONE '${TZ}', 'YYYY-MM-DD') AS d FROM pos_sales s
        WHERE s.receipt_number NOT LIKE 'CN%' AND NOT EXISTS (SELECT 1 FROM pos_sale_items i WHERE i.sale_id = s.id)`);
    data.lines_reliable_from = gap[0].d;
    ageCache = { at: Date.now(), key, data };
    return data;
  }

  // Net sales after returns (ex tax), cost of the catalogue parts sold, units.
  async function salesBlock(t0, t1) {
    const { rows: h } = await query(
      `SELECT COUNT(*) FILTER (WHERE receipt_number NOT LIKE 'CN%')::int AS tx,
              COALESCE(SUM(subtotal_usd), 0) - COALESCE(SUM(discount_usd) FILTER (WHERE receipt_number NOT LIKE 'CN%'), 0) AS net,
              COALESCE(-SUM(subtotal_usd) FILTER (WHERE receipt_number LIKE 'CN%'), 0) AS returns
         FROM pos_sales WHERE created_at >= $1 AND created_at < $2 AND NOT COALESCE(voided, false)`, [t0, t1]);
    const { rows: c } = await query(
      `SELECT COALESCE(SUM(i.qty * COALESCE(i.unit_cost, p.cost_usd, 0)), 0) AS cost,
              COALESCE(SUM(i.qty) FILTER (WHERE s.receipt_number NOT LIKE 'CN%'), 0)::int AS units
         FROM pos_sales s JOIN pos_sale_items i ON i.sale_id = s.id JOIN products p ON p.img = i.product_img
        WHERE s.created_at >= $1 AND s.created_at < $2 AND NOT COALESCE(s.voided, false)`, [t0, t1]);
    // Imported history can hold sale headers with no lines; then cost, profit
    // and units for those sales are unknown and are not shown as zero cost.
    const { rows: nl } = await query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(subtotal_usd - COALESCE(discount_usd, 0)), 0) AS value FROM pos_sales s
        WHERE s.created_at >= $1 AND s.created_at < $2 AND NOT COALESCE(s.voided, false) AND s.receipt_number NOT LIKE 'CN%'
          AND NOT EXISTS (SELECT 1 FROM pos_sale_items i WHERE i.sale_id = s.id)`, [t0, t1]);
    const net = r2(h[0].net), cost = r2(c[0].cost);
    const complete = !(n(nl[0].value) > Math.abs(net) * 0.02);
    return { transactions: h[0].tx, net_sales: net, returns: r2(h[0].returns), cost_of_sales: complete ? cost : null,
      gross_profit: complete ? r2(net - cost) : null, gp_pct: complete ? pct(net - cost, net) : null,
      avg_ticket: h[0].tx ? r2(net / h[0].tx) : null, units: complete ? c[0].units : null,
      lines_complete: complete, sales_without_lines: { count: nl[0].n, value: r2(nl[0].value) } };
  }

  const OPEN_QTY = `GREATEST(COALESCE(i.qty_ordered, i.qty, 0) - COALESCE(i.qty_received, 0) - COALESCE(i.qty_cancelled, 0), 0)`;
  const SOLD_90 = `s.created_at >= NOW() - INTERVAL '90 days' AND s.receipt_number NOT LIKE 'CN%' AND NOT COALESCE(s.voided, false)`;

  app.get('/api/plan/dashboard', ...can('planning.view'), async (req, res) => {
    try {
      const p = await period(req.query);
      const s = await settings();
      const P = [p.t0, p.t1];

      const [sales, prev] = await Promise.all([salesBlock(p.t0, p.t1), salesBlock(p.p0, p.t0)]);

      // Inventory now; days of cover on the last 90 days' cost of sales.
      const { rows: inv } = await query(
        `SELECT COUNT(*) FILTER (WHERE stock_count > 0)::int AS skus_in_stock, COALESCE(SUM(stock_count) FILTER (WHERE stock_count > 0), 0)::int AS units,
                COALESCE(SUM(stock_count * COALESCE(cost_usd, 0)) FILTER (WHERE stock_count > 0), 0) AS cost,
                COALESCE(SUM(stock_count * COALESCE(price_usd, 0)) FILTER (WHERE stock_count > 0), 0) AS retail,
                COUNT(*) FILTER (WHERE stock_count > 0 AND COALESCE(cost_usd, 0) = 0)::int AS skus_no_cost
           FROM products`);
      const { rows: c90 } = await query(
        `SELECT COALESCE(SUM(i.qty * COALESCE(i.unit_cost, p.cost_usd, 0)), 0) AS cost
           FROM pos_sales s JOIN pos_sale_items i ON i.sale_id = s.id JOIN products p ON p.img = i.product_img
          WHERE s.created_at >= NOW() - INTERVAL '90 days' AND NOT COALESCE(s.voided, false)`);
      const dailyCost = n(c90[0].cost) / 90;
      const inventory = { skus_in_stock: inv[0].skus_in_stock, units: inv[0].units, cost: r2(inv[0].cost), retail: r2(inv[0].retail),
        skus_no_cost: inv[0].skus_no_cost,
        days_cover: dailyCost ? Math.round(n(inv[0].cost) / dailyCost) : null,
        turns: n(inv[0].cost) ? Math.round((dailyCost * 365 / n(inv[0].cost)) * 10) / 10 : null };
      const { rows: ub } = await query(
        `SELECT COUNT(DISTINCT sb.product_img)::int AS skus, COALESCE(SUM(sb.qty), 0)::int AS units
           FROM stock_by_bin sb JOIN bins b ON b.id = sb.bin_id WHERE b.kind = 'unassigned' AND sb.qty > 0`);
      inventory.unassigned = ub[0];

      const ageing = await stockAgeing(s.plan_dead_days, s.plan_slow_days);
      ageing.dead_pct = pct(ageing.dead && ageing.dead.cost, inventory.cost);
      ageing.slow_pct = pct(ageing.slow && ageing.slow.cost, inventory.cost);

      // Fill rate: units supplied / (supplied + lost).
      const [lost, lostPrev] = await Promise.all([lostSummary(p.t0, p.t1), lostSummary(p.p0, p.t0)]);
      const fill = { supplied: sales.units, lost: lost.units,
        rate: sales.lines_complete ? pct(sales.units, sales.units + lost.units) : null,
        prev_rate: prev.lines_complete ? pct(prev.units, prev.units + lostPrev.units) : null, lost_value: lost.value, prev_lost_value: lostPrev.value, by_source: lost.by_source };

      // Parts that sold in the last 90 days and are out now.
      const { rows: oos } = await query(
        `SELECT p.img, p.sku, p.name, p.stock_count, SUM(i.qty)::int AS sold_90d, SUM(i.qty * i.unit_price_usd) AS sales_90d,
                (SELECT COALESCE(SUM(${OPEN_QTY}), 0)::int FROM purchase_order_items i JOIN purchase_orders po ON po.id = i.po_id
                  WHERE i.product_img = p.img AND po.status IN ('ordered', 'sent', 'partial')) AS on_order
           FROM products p JOIN pos_sale_items i ON i.product_img = p.img JOIN pos_sales s ON s.id = i.sale_id
          WHERE p.stock_count <= 0 AND p.is_active AND ${SOLD_90}
          GROUP BY p.id HAVING SUM(i.qty) > 0 ORDER BY SUM(i.qty * i.unit_price_usd) DESC LIMIT 30`);
      const { rows: oosN } = await query(
        `SELECT COUNT(DISTINCT p.img)::int AS n FROM products p JOIN pos_sale_items i ON i.product_img = p.img JOIN pos_sales s ON s.id = i.sale_id
          WHERE p.stock_count <= 0 AND p.is_active AND ${SOLD_90}`);

      // Pick accuracy: lines picked in the period that were filled in full.
      const { rows: pk } = await query(
        `SELECT COUNT(*)::int AS lines, COUNT(*) FILTER (WHERE qty_short > 0)::int AS short_lines,
                COALESCE(SUM(qty), 0)::int AS units, COALESCE(SUM(qty_short), 0)::int AS short_units,
                (SELECT ROUND(AVG(EXTRACT(EPOCH FROM (f.picked_at - f.pick_started_at)) / 60)::numeric, 1) FROM fulfilments f
                  WHERE f.picked_at >= $1 AND f.picked_at < $2 AND f.pick_started_at IS NOT NULL) AS avg_pick_min,
                (SELECT ROUND(AVG(EXTRACT(EPOCH FROM (COALESCE(f.ready_at, f.packed_at) - f.created_at)) / 60)::numeric, 1) FROM fulfilments f
                  WHERE COALESCE(f.ready_at, f.packed_at) >= $1 AND COALESCE(f.ready_at, f.packed_at) < $2) AS avg_order_to_ready_min
           FROM fulfilment_lines WHERE picked_at >= $1 AND picked_at < $2`, P);
      const picking = { ...pk[0], avg_pick_min: pk[0].avg_pick_min == null ? null : n(pk[0].avg_pick_min),
        avg_order_to_ready_min: pk[0].avg_order_to_ready_min == null ? null : n(pk[0].avg_order_to_ready_min),
        accuracy: pct(pk[0].lines - pk[0].short_lines, pk[0].lines) };

      // Count accuracy: lines on counts posted in the period whose final count matched the system.
      const { rows: ca } = await query(
        `SELECT COUNT(*)::int AS lines,
                COUNT(*) FILTER (WHERE COALESCE(l.recount_qty, l.counted_qty) = COALESCE(l.system_qty, 0))::int AS exact,
                COALESCE(SUM((COALESCE(l.recount_qty, l.counted_qty) - COALESCE(l.system_qty, 0)) * COALESCE(l.unit_cost, 0)), 0) AS net_value,
                COALESCE(SUM(ABS(COALESCE(l.recount_qty, l.counted_qty) - COALESCE(l.system_qty, 0)) * COALESCE(l.unit_cost, 0)), 0) AS abs_value,
                COUNT(DISTINCT c.id)::int AS counts
           FROM bin_count_lines l JOIN bin_counts c ON c.id = l.count_id
          WHERE c.status = 'posted' AND c.posted_at >= $1 AND c.posted_at < $2`, P);
      const { rows: cyc } = await query(
        `SELECT COUNT(*) FILTER (WHERE last_counted_at IS NULL)::int AS never,
                COUNT(*) FILTER (WHERE last_counted_at < NOW() - INTERVAL '365 days')::int AS over_year
           FROM products WHERE stock_count > 0`);
      const counting = { ...ca[0], net_value: r2(ca[0].net_value), abs_value: r2(ca[0].abs_value), accuracy: pct(ca[0].exact, ca[0].lines),
        in_stock_never_counted: cyc[0].never, in_stock_not_counted_12m: cyc[0].over_year };

      // Supplier lead time, last 12 months: order date to posted receipt, against the set lead time.
      const { rows: lt } = await query(
        `SELECT s.id, s.name, COALESCE(s.lead_time_days, 7) AS set_days, COUNT(*)::int AS receipts,
                ROUND(AVG(EXTRACT(EPOCH FROM (r.posted_at - COALESCE(po.ordered_at, po.created_at))) / 86400)::numeric, 1) AS actual_days,
                ROUND(MAX(EXTRACT(EPOCH FROM (r.posted_at - COALESCE(po.ordered_at, po.created_at))) / 86400)::numeric)::int AS worst_days,
                COUNT(*) FILTER (WHERE po.expected_date IS NOT NULL)::int AS with_due,
                COUNT(*) FILTER (WHERE po.expected_date IS NOT NULL AND (r.posted_at AT TIME ZONE '${TZ}')::date <= po.expected_date)::int AS on_time,
                COALESCE(SUM(rl.damaged), 0)::int AS damaged_units, COALESCE(SUM(rl.good), 0)::int AS good_units
           FROM receipts r JOIN purchase_orders po ON po.id = r.po_id JOIN suppliers s ON s.id = COALESCE(r.supplier_id, po.supplier_id)
           LEFT JOIN LATERAL (SELECT SUM(qty_damaged) AS damaged, SUM(qty_received) AS good FROM receipt_lines WHERE receipt_id = r.id) rl ON true
          WHERE r.status = 'posted' AND r.posted_at >= NOW() - INTERVAL '365 days'
          GROUP BY s.id ORDER BY COUNT(*) DESC LIMIT 25`);
      const suppliers = lt.map((r) => ({ ...r, actual_days: r.actual_days == null ? null : n(r.actual_days),
        on_time_pct: pct(r.on_time, r.with_due), damage_pct: pct(r.damaged_units, n(r.damaged_units) + n(r.good_units)),
        gap_days: r.actual_days == null ? null : Math.round((n(r.actual_days) - n(r.set_days)) * 10) / 10 }));

      // Backorders and payables.
      const { rows: bo } = await query(
        `SELECT COUNT(*)::int AS lines, COALESCE(SUM(${OPEN_QTY}), 0)::int AS units,
                COUNT(*) FILTER (WHERE po.expected_date < CURRENT_DATE)::int AS overdue_lines
           FROM purchase_order_items i JOIN purchase_orders po ON po.id = i.po_id
          WHERE po.status IN ('ordered', 'sent', 'partial') AND ${OPEN_QTY} > 0`);
      const { rows: ap } = await query(
        `SELECT COALESCE(SUM(balance_due_usd), 0) AS owed,
                COALESCE(SUM(balance_due_usd) FILTER (WHERE due_date < CURRENT_DATE), 0) AS overdue,
                COALESCE(SUM(balance_due_usd) FILTER (WHERE due_date >= CURRENT_DATE AND due_date < CURRENT_DATE + 8), 0) AS due_7d,
                COALESCE(SUM(balance_due_usd) FILTER (WHERE due_date >= CURRENT_DATE + 8 AND due_date < CURRENT_DATE + 31), 0) AS due_30d
           FROM purchase_orders WHERE balance_due_usd > 0 AND status <> 'cancelled'`);
      const { rows: pb } = await query(`SELECT COUNT(*)::int AS n FROM receipts WHERE status = 'posted' AND bill_status IN ('pending', 'disputed')`);

      // Cashier over/short on shifts closed in the period.
      const { rows: tl } = await query(
        `SELECT COUNT(*)::int AS shifts, COALESCE(SUM(variance), 0) AS net, COALESCE(SUM(ABS(variance)), 0) AS abs,
                COUNT(*) FILTER (WHERE ABS(COALESCE(variance, 0)) >= 1)::int AS off,
                COUNT(*) FILTER (WHERE reviewed_at IS NULL AND ABS(COALESCE(variance, 0)) >= 1)::int AS unreviewed
           FROM till_sessions WHERE status = 'closed' AND closed_at >= $1 AND closed_at < $2`, P);

      const { rows: fu } = await query(
        `SELECT COUNT(*)::int AS waiting, COUNT(*) FILTER (WHERE p.stock_count >= l.qty)::int AS ready
           FROM lost_sales l LEFT JOIN products p ON p.img = l.product_img
          WHERE l.follow_up AND l.followed_up_at IS NULL AND l.created_at > NOW() - INTERVAL '120 days'`);

      // Plain-language flags for the owner and the CEO briefing, worst first.
      const flags = [];
      const flag = (level, text) => flags.push({ level, text });
      if (fill.rate != null && fill.rate < s.plan_target_fill_rate) flag('bad', `Fill rate ${fill.rate}% is under the ${s.plan_target_fill_rate}% target: ${jm(lost.value)} of sales were lost.`);
      if (!sales.lines_complete) flag('info', `${sales.sales_without_lines.count.toLocaleString('en-US')} sales in this period (${jm(sales.sales_without_lines.value)}) were imported without their lines, so cost, profit and fill rate cannot be worked out for it.`);
      if (sales.gp_pct != null && sales.gp_pct < s.plan_target_gp_pct) flag('bad', `Gross profit ${sales.gp_pct}% is under the ${s.plan_target_gp_pct}% target.`);
      if (n(ap[0].overdue) > 0) flag('bad', `${jm(ap[0].overdue)} owed to suppliers is past due.`);
      if (inventory.days_cover != null && inventory.days_cover > s.plan_target_days_cover) flag('warn', `${inventory.days_cover} days of stock on hand against a ${s.plan_target_days_cover}-day target: cash is tied up in inventory.`);
      if (ageing.dead_pct != null && ageing.dead_pct > s.plan_target_dead_pct) flag('warn', `Dead stock is ${ageing.dead_pct}% of stock value (${jm(ageing.dead.cost)}); the target is under ${s.plan_target_dead_pct}%. Clear it with promotions or supplier returns.`);
      if (oosN[0].n) flag('warn', `${oosN[0].n.toLocaleString('en-US')} parts that sold in the last 90 days are out of stock now.`);
      if (picking.accuracy != null && picking.accuracy < s.plan_target_pick_accuracy) flag('warn', `Pick accuracy ${picking.accuracy}% is under ${s.plan_target_pick_accuracy}%: check the bins of the short-picked parts.`);
      if (counting.accuracy != null && counting.accuracy < s.plan_target_count_accuracy) flag('warn', `Count accuracy ${counting.accuracy}% is under ${s.plan_target_count_accuracy}%.`);
      if (tl[0].unreviewed) flag('warn', `${tl[0].unreviewed} cashier shifts closed over or short and are not reviewed.`);
      if (fu[0].ready) flag('info', `${fu[0].ready} customers who were turned away can be called now: their part is in stock.`);
      if (inventory.skus_no_cost) flag('info', `${inventory.skus_no_cost.toLocaleString('en-US')} parts in stock have no cost, so profit and stock value are off.`);
      if (inventory.unassigned.skus) flag('info', `${inventory.unassigned.skus.toLocaleString('en-US')} parts in stock have no bin yet.`);
      for (const sp of suppliers) if (sp.gap_days != null && sp.receipts >= 3 && sp.gap_days > 3) flag('info', `${sp.name} takes ${sp.actual_days} days against the ${sp.set_days} set: reorder points for their parts are too low.`);

      res.json({
        period: { from: p.from, to: p.to, days: p.days }, targets: s, flags: flags.sort((a, b) => ['bad', 'warn', 'info'].indexOf(a.level) - ['bad', 'warn', 'info'].indexOf(b.level)),
        sales, prev_sales: prev, inventory, ageing, fill, out_of_stock: { count: oosN[0].n, top: oos.map((r) => ({ ...r, sales_90d: r2(r.sales_90d) })) },
        picking, counting, suppliers, backorders: bo[0],
        payables: { owed: r2(ap[0].owed), overdue: r2(ap[0].overdue), due_7d: r2(ap[0].due_7d), due_30d: r2(ap[0].due_30d), bills_to_confirm: pb[0].n },
        tills: { ...tl[0], net: r2(tl[0].net), abs: r2(tl[0].abs) }, follow_ups: fu[0],
      });
    } catch (e) { fail(res, e); }
  });
}

module.exports = { register };
