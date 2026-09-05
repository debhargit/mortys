// Phase 3 — auth-gated admin READ paths. Ports server.js:
//   GET /api/admin/settings                 GET /api/admin/me/ui-prefs
//   GET /api/admin/capabilities             GET /api/admin/user-categories
//   GET /api/admin/roles   GET /api/admin/roles/mine
//   GET /api/admin/staff
//   GET /api/admin/products  GET /api/admin/products/:img  GET /api/admin/low-stock
//   GET /api/admin/orders    GET /api/admin/orders/:id
//   GET /api/admin/dashboard
//
// D1 dialect (see PORT.md): created_at is TEXT UTC; money is *_cents ->
// convert to *_usd at the SELECT; no FILTER (-> SUM(CASE ...)); no
// JSON_AGG/JSON_BUILD_OBJECT (-> a second query grouped in JS); children key
// on product_img, not product_id; NOW()/CURRENT_DATE/INTERVAL -> datetime()/
// date(); jsonb columns come back as TEXT -> safeJson().
import { d1 } from '../_lib/db.js';
import { adminMw, roleCanManage } from '../_lib/guards.js';
import { safeJson, boolify } from '../_lib/util.js';
import { CAPABILITIES } from '../_lib/capabilities.js';
import { getShopSettings } from '../_lib/shop.js';
import { loadBreaksForImg, ACTIVE_SALE_PRICE_SQL, effectiveBaseCents } from '../_lib/price_breaks.js';
import { loadKitComponentsForImg, kitRollupCents } from '../_lib/kits.js';
import { centsToUsd } from '../_lib/money.js';

// 14-day zero-filled series from rows [{ day:'YYYY-MM-DD', <key> }]
function fill14(rows, key) {
  const map = {};
  for (const r of rows) map[r.day] = Number(r[key]) || 0;
  const out = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    out.push({ day: d, total: map[d] || 0 });
  }
  return out;
}

export default function mount(app) {
  // ---- settings ------------------------------------------------------
  app.get('/api/admin/settings', adminMw, async (c) => {
    return c.json({ settings: await getShopSettings(c.env) });
  });

  app.get('/api/admin/capabilities', adminMw, (c) => c.json({ capabilities: CAPABILITIES }));

  app.get('/api/admin/me/ui-prefs', adminMw, async (c) => {
    try {
      const row = await d1(c.env).one('SELECT ui_prefs, forced_favs, favs_locked FROM users WHERE id = ?', c.get('user').id);
      const ff = row ? safeJson(row.forced_favs, null) : null;
      return c.json({
        ok: true,
        prefs: row ? safeJson(row.ui_prefs, {}) : {},
        forced_favs: Array.isArray(ff) ? ff : null,
        favs_locked: !!(row && row.favs_locked),
      });
    } catch (e) {
      return c.json({ ok: false, error: e.message, prefs: {} }, 500);
    }
  });

  // ---- roles / categories -----------------------------------------
  app.get('/api/admin/roles', adminMw, async (c) => {
    const rows = await d1(c.env).many(
      `SELECT r.code, r.label, r.rank, r.can_manage, r.hidden_tabs, r.is_system,
              COALESCE(r.show_extra_menus, 0) AS show_extra_menus,
              (SELECT COUNT(*) FROM users u WHERE u.admin_role = r.code) AS member_count
         FROM roles r ORDER BY r.rank, r.label`
    );
    for (const r of rows) {
      boolify(r, ['can_manage', 'is_system', 'show_extra_menus']);
      r.hidden_tabs = safeJson(r.hidden_tabs, []);
    }
    return c.json({ roles: rows });
  });

  app.get('/api/admin/roles/mine', adminMw, async (c) => {
    const code = c.get('user').admin_role || null;
    const r = await d1(c.env).one(
      'SELECT code, label, can_manage, hidden_tabs, rank, COALESCE(show_extra_menus, 0) AS show_extra_menus FROM roles WHERE code = ?', code);
    if (!r) {
      return c.json({ role: { code, label: code || 'unknown', can_manage: code === 'owner', hidden_tabs: [], rank: 99, show_extra_menus: false } });
    }
    r.can_manage = code === 'owner' ? true : !!r.can_manage;
    r.show_extra_menus = !!r.show_extra_menus;
    r.hidden_tabs = safeJson(r.hidden_tabs, []);
    return c.json({ role: r });
  });

  app.get('/api/admin/user-categories', adminMw, async (c) => {
    const rows = await d1(c.env).many(
      `SELECT c.id, c.code, c.label, c.department, c.is_staff, c.sort_order, c.is_active, c.is_system, c.perms,
              (SELECT COUNT(*) FROM user_category_members m WHERE m.category_id = c.id) AS member_count
         FROM user_categories c ORDER BY c.sort_order, c.label`
    );
    for (const r of rows) {
      boolify(r, ['is_staff', 'is_active', 'is_system']);
      r.perms = safeJson(r.perms, {});
    }
    return c.json({ categories: rows });
  });

  // ---- staff ------------------------------------------------------
  app.get('/api/admin/staff', adminMw, async (c) => {
    const db = d1(c.env);
    const u = c.get('user');
    const canNid = u.admin_role === 'owner' || (await roleCanManage(c.env, u.admin_role));
    const rows = await db.many(
      `SELECT u.id, u.name, u.email, u.phone, u.is_admin, u.admin_role, u.employee_no,
              u.is_staff, u.disabled, u.created_at, u.perms, u.forced_favs, u.favs_locked,
              (u.pin_hash IS NOT NULL) AS has_pin, u.pin_set_at,
              ${canNid ? 'u.national_id' : 'NULL AS national_id'}
         FROM users u
        WHERE u.is_staff = 1 OR u.is_admin = 1
        ORDER BY (u.name IS NULL), u.name, u.email`
    );
    const cats = await db.many(
      `SELECT m.user_id, c.id, c.code, c.label
         FROM user_category_members m JOIN user_categories c ON c.id = m.category_id
        ORDER BY c.sort_order`
    );
    const byUser = {};
    for (const r of cats) (byUser[r.user_id] = byUser[r.user_id] || []).push({ id: r.id, code: r.code, label: r.label });
    for (const r of rows) {
      boolify(r, ['is_admin', 'is_staff', 'disabled', 'has_pin', 'favs_locked']);
      r.perms = safeJson(r.perms, {});
      const ff = safeJson(r.forced_favs, null);
      r.forced_favs = Array.isArray(ff) ? ff : null;
      r.categories = byUser[r.id] || [];
    }
    return c.json({ staff: rows, national_id_visible: canNid });
  });

  // ---- products ------------------------------------------------
  app.get('/api/admin/products', adminMw, async (c) => {
    const rows = await d1(c.env).many(
      `SELECT img, name, make_model, category, condition, price_cents / 100.0 AS price_usd,
              stock_count, low_threshold, is_active, created_at
         FROM products ORDER BY created_at DESC, name ASC`
    );
    for (const r of rows) boolify(r, ['is_active']);
    return c.json({ products: rows });
  });

  app.get('/api/admin/products/:img', adminMw, async (c) => {
    const row = await d1(c.env).one(
      `SELECT p.img, p.name, p.make_model, p.category, p.condition,
              p.price_cents / 100.0 AS price_usd, p.cost_cents / 100.0 AS cost_usd,
              p.list_price_cents / 100.0 AS list_price_usd, p.markup_pct, p.costing_method,
              p.stock_count, p.low_threshold, p.is_active, p.sku, p.barcode,
              p.warranty_days, p.serial_required,
              p.stock_uom, p.purchase_uom, p.units_per_purchase, p.supplier_part_no,
              p.location, p.bin_location, p.supplier_id, s.name AS supplier_name,
              p.commission_type, p.commission_value,
              p.core_charge_cents / 100.0 AS core_charge_usd, p.env_fee_cents / 100.0 AS env_fee_usd,
              p.matrix_id, p.matrix_axis1_value, p.matrix_axis2_value, p.matrix_overrides,
              m.name AS matrix_name, m.axis1_label AS matrix_axis1_label, m.axis2_label AS matrix_axis2_label,
              p.sale_price_cents / 100.0 AS sale_price_usd, p.sale_starts_at, p.sale_ends_at,
              ${ACTIVE_SALE_PRICE_SQL} AS active_sale_cents,
              p.max_discount_pct, p.is_redeemable, p.item_type,
              p.is_kit, p.kit_price_mode, p.kit_line_mode,
              p.restricted_instore_only, p.restricted_manager_approval, p.restricted_id_required, p.restricted_tax_id_required
         FROM products p LEFT JOIN suppliers s ON s.id = p.supplier_id
                          LEFT JOIN product_matrices m ON m.id = p.matrix_id
        WHERE p.img = ?`,
      c.req.param('img')
    );
    if (!row) return c.json({ error: 'Not found' }, 404);
    boolify(row, ['is_active', 'serial_required', 'is_redeemable', 'is_kit',
      'restricted_instore_only', 'restricted_manager_approval', 'restricted_id_required', 'restricted_tax_id_required']);
    row.matrix_overrides = safeJson(row.matrix_overrides, []);
    row.price_breaks = (await loadBreaksForImg(d1(c.env), row.img)).map((b) => ({ min_qty: b.min_qty, price_usd: centsToUsd(b.price_cents) }));
    const kitComps = await loadKitComponentsForImg(d1(c.env), row.img);
    row.kit_components = kitComps.map((k) => ({
      component_img: k.component_img, qty_each: k.qty_each, name: k.name,
      price_usd: centsToUsd(k.price_cents || 0),
      effective_price_usd: centsToUsd(effectiveBaseCents(k.price_cents, k.active_sale_cents) || 0),
      item_type: k.item_type,
    }));
    row.kit_rollup_usd = centsToUsd(kitRollupCents(kitComps));
    row.sale_active = row.active_sale_cents != null;
    delete row.active_sale_cents;
    return c.json({ product: row });
  });

  app.get('/api/admin/low-stock', adminMw, async (c) => {
    const rows = await d1(c.env).many(
      `SELECT img, name, make_model, category, condition, price_cents / 100.0 AS price_usd,
              stock_count, low_threshold
         FROM products
        WHERE is_active = 1 AND item_type != 'service' AND is_kit = 0 AND stock_count <= low_threshold
        ORDER BY stock_count ASC, name ASC LIMIT 100`
    );
    return c.json({ products: rows, count: rows.length });
  });

  // ---- orders (merged online + counter) --------------------------
  const ORDERS_UNION = `
    SELECT 'online' AS source, o.id, ('#' || o.id) AS ref, o.created_at,
           u.name AS customer_name, u.email AS customer_email, u.phone AS customer_phone,
           (o.user_id IS NULL) AS is_guest,
           (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_count,
           o.total_cents / 100.0 AS total_usd,
           o.status, o.payment_method, o.payment_status,
           NULL AS fulfilment, 0 AS voided
      FROM orders o LEFT JOIN users u ON u.id = o.user_id
    UNION ALL
    SELECT 'counter', s.id, s.receipt_number, s.created_at,
           s.customer_name, NULL, s.customer_phone,
           (s.customer_id IS NULL),
           (SELECT COUNT(*) FROM pos_sale_items psi WHERE psi.sale_id = s.id),
           s.total_cents / 100.0,
           (CASE WHEN s.voided = 1 THEN 'voided' ELSE 'completed' END),
           s.payment_method, s.payment_status, s.fulfilment, s.voided
      FROM pos_sales s`;

  app.get('/api/admin/orders', adminMw, async (c) => {
    try {
      const db = d1(c.env);
      const q = c.req.query();
      const source     = ['online', 'counter'].includes(q.source) ? q.source : null;
      const status     = q.status ? String(q.status) : null;
      const payment    = q.payment ? String(q.payment) : null;
      const fulfilment = ['pickup', 'delivery', 'shipping'].includes(q.fulfilment) ? q.fulfilment : null;
      const custType   = ['guest', 'account'].includes(q.type) ? q.type : null;
      const from       = q.from ? String(q.from) : null;
      const to         = q.to ? String(q.to) : null;
      const search     = q.q ? String(q.q).trim().toLowerCase() : null;
      const limit      = Math.min(1000, Math.max(1, parseInt(q.limit, 10) || 300));

      const cond = ['1=1'];
      const b = [];
      if (source)     { cond.push('x.source = ?'); b.push(source); }
      if (status)     { cond.push('x.status = ?'); b.push(status); }
      if (payment)    { cond.push('x.payment_status = ?'); b.push(payment); }
      if (fulfilment) { cond.push('x.fulfilment = ?'); b.push(fulfilment); }
      if (custType === 'guest')   cond.push('x.is_guest = 1');
      if (custType === 'account') cond.push('x.is_guest = 0');
      if (from) { cond.push('date(x.created_at) >= date(?)'); b.push(from); }
      if (to)   { cond.push('date(x.created_at) <= date(?)'); b.push(to); }
      if (search) {
        cond.push("(lower(coalesce(x.customer_name,'')) LIKE ? OR lower(coalesce(x.customer_email,'')) LIKE ? OR lower(coalesce(x.customer_phone,'')) LIKE ? OR lower(x.ref) LIKE ?)");
        const s = '%' + search + '%';
        b.push(s, s, s, s);
      }
      const W = cond.join(' AND ');

      const [orders, agg] = await Promise.all([
        db.many(`WITH x AS (${ORDERS_UNION}) SELECT x.* FROM x WHERE ${W} ORDER BY x.created_at DESC LIMIT ?`, ...b, limit),
        db.one(`WITH x AS (${ORDERS_UNION}) SELECT COUNT(*) AS n, COALESCE(SUM(x.total_usd),0) AS total FROM x WHERE ${W}`, ...b),
      ]);
      return c.json({ orders, summary: agg, limit });
    } catch (e) {
      return c.json({ error: e.message }, 500);
    }
  });

  app.get('/api/admin/orders/:id', adminMw, async (c) => {
    const db = d1(c.env);
    const o = await db.one(
      `SELECT o.*, o.total_cents / 100.0 AS total_usd,
              o.coupon_discount_cents / 100.0 AS coupon_discount_usd,
              u.email AS user_email, u.name AS user_name
         FROM orders o LEFT JOIN users u ON u.id = o.user_id WHERE o.id = ?`,
      c.req.param('id')
    );
    if (!o) return c.json({ error: 'Not found' }, 404);
    const items = await db.many(
      `SELECT oi.product_img, oi.qty, oi.price_cents / 100.0 AS price_usd, p.name, p.make_model
         FROM order_items oi LEFT JOIN products p ON p.img = oi.product_img
        WHERE oi.order_id = ?`,
      c.req.param('id')
    );
    return c.json({ order: o, items });
  });

  // ---- summary (top-bar badge counts; admin.html calls this on load) ----
  app.get('/api/admin/summary', adminMw, async (c) => {
    const db = d1(c.env);
    const n = async (sql, ...b) => {
      try { const r = await db.one(sql, ...b); return (r && r.n) || 0; }
      catch { return 0; }
    };
    const [new_inquiries, pending_appointments, pending_notifications, pending_reviews, pending_orders, low_stock_count] = await Promise.all([
      n("SELECT COUNT(*) AS n FROM parts_inquiries WHERE status = 'new'"),
      n("SELECT COUNT(*) AS n FROM service_appointments WHERE status = 'pending'"),
      n('SELECT COUNT(*) AS n FROM notify_subscriptions WHERE notified_at IS NULL'),
      n('SELECT COUNT(*) AS n FROM reviews WHERE approved = 0'),
      n("SELECT COUNT(*) AS n FROM orders WHERE status = 'pending'"),
      n("SELECT COUNT(*) AS n FROM products WHERE item_type != 'service' AND is_kit = 0 AND stock_count <= low_threshold"),
    ]);
    return c.json({ new_inquiries, pending_appointments, pending_notifications, pending_reviews, pending_orders, low_stock_count });
  });

  // ---- dashboard ------------------------------------------------
  app.get('/api/admin/dashboard', adminMw, async (c) => {
    const db = d1(c.env);
    const salesUnion = `
      SELECT created_at, total_cents / 100.0 AS total FROM pos_sales WHERE voided = 0
      UNION ALL
      SELECT created_at, total_cents / 100.0 AS total FROM orders WHERE status <> 'cancelled'`;

    const [
      sales, spark, tender, topSellers, ar, attention, recent,
      revToday, revWeek, revMonth, wosOpen, mechUtil, svcDaily, woByStatus, openInspections,
    ] = await Promise.all([
      db.one(`WITH x AS (${salesUnion}) SELECT
          COALESCE(SUM(CASE WHEN date(created_at) = date('now') THEN total END),0)             AS today,
          SUM(CASE WHEN date(created_at) = date('now') THEN 1 ELSE 0 END)                      AS today_n,
          COALESCE(SUM(CASE WHEN created_at >= datetime('now','-7 days')  THEN total END),0)   AS week,
          SUM(CASE WHEN created_at >= datetime('now','-7 days')  THEN 1 ELSE 0 END)            AS week_n,
          COALESCE(SUM(CASE WHEN created_at >= datetime('now','-30 days') THEN total END),0)   AS month,
          SUM(CASE WHEN created_at >= datetime('now','-30 days') THEN 1 ELSE 0 END)            AS month_n
        FROM x`),
      db.many(`WITH x AS (${salesUnion})
        SELECT date(created_at) AS day, COALESCE(SUM(total),0) AS total
          FROM x WHERE date(created_at) >= date('now','-13 days') GROUP BY day ORDER BY day`),
      db.many(`SELECT sp.method, COUNT(*) AS n, COALESCE(SUM(sp.amount_cents),0) / 100.0 AS total
          FROM sale_payments sp JOIN pos_sales s ON s.id = sp.sale_id
         WHERE s.voided = 0 AND s.created_at >= datetime('now','-7 days')
         GROUP BY sp.method ORDER BY total DESC`),
      db.many(`SELECT COALESCE(p.name, psi.description) AS name, p.sku,
                SUM(psi.qty) AS qty, COALESCE(SUM(psi.total_cents),0) / 100.0 AS revenue
          FROM pos_sale_items psi
          JOIN pos_sales s ON s.id = psi.sale_id
          LEFT JOIN products p ON p.img = psi.product_img
         WHERE s.voided = 0 AND s.created_at >= datetime('now','-7 days')
         GROUP BY COALESCE(p.name, psi.description), p.sku
         ORDER BY revenue DESC LIMIT 8`),
      db.one(`SELECT COUNT(*) AS customers_owing, COALESCE(SUM(bal),0) AS total_owed FROM (
          SELECT u.id,
            COALESCE((SELECT SUM(sp.amount_cents) FROM sale_payments sp JOIN pos_sales s ON s.id = sp.sale_id
                       WHERE sp.method = 'account' AND s.customer_id = u.id AND s.voided = 0),0) / 100.0
            - COALESCE((SELECT SUM(amount_cents) FROM account_payments ap WHERE ap.customer_id = u.id),0) / 100.0 AS bal
          FROM users u) t WHERE bal > 0.01`),
      db.one(`SELECT
          (SELECT COUNT(*) FROM orders WHERE status IN ('pending','confirmed'))                                    AS orders_pending,
          (SELECT COUNT(*) FROM products WHERE is_active = 1 AND item_type != 'service' AND is_kit = 0 AND stock_count > 0 AND stock_count <= low_threshold)  AS low_stock,
          (SELECT COUNT(*) FROM products WHERE is_active = 1 AND item_type != 'service' AND is_kit = 0 AND stock_count <= 0)                                  AS out_of_stock,
          (SELECT COUNT(*) FROM parts_requisitions WHERE status IN ('pending','partial','backordered'))             AS parts_pulls_open,
          (SELECT COUNT(*) FROM pos_quotes WHERE status = 'open')                                                   AS quotes_open,
          (SELECT COUNT(*) FROM pos_holds)                                                                          AS holds`),
      db.many(`SELECT * FROM (
          SELECT 'counter' AS source, s.id, s.receipt_number AS ref, s.created_at,
                 COALESCE(NULLIF(s.customer_name,''),'Walk-in') AS customer, s.total_cents / 100.0 AS total, s.voided
            FROM pos_sales s
          UNION ALL
          SELECT 'online', o.id, ('#' || o.id), o.created_at,
                 COALESCE(u.name,'Guest'), o.total_cents / 100.0, (o.status = 'cancelled')
            FROM orders o LEFT JOIN users u ON u.id = o.user_id
        ) x ORDER BY created_at DESC LIMIT 8`),
      db.one(`SELECT COALESCE(SUM(amount_cents),0) / 100.0 AS s FROM work_order_payments WHERE date(received_at) = date('now')`),
      db.one(`SELECT COALESCE(SUM(amount_cents),0) / 100.0 AS s FROM work_order_payments WHERE received_at >= datetime('now','-7 days')`),
      db.one(`SELECT COALESCE(SUM(amount_cents),0) / 100.0 AS s FROM work_order_payments WHERE received_at >= datetime('now','-30 days')`),
      db.many(`SELECT status, COUNT(*) AS n FROM work_orders WHERE status NOT IN ('paid','cancelled') GROUP BY status`),
      db.many(`SELECT m.name, COUNT(l.id) AS jobs, COALESCE(SUM(l.hours),0) AS hours, COALESCE(SUM(l.total_cents),0) / 100.0 AS revenue
                FROM mechanics m LEFT JOIN work_order_labor l ON l.mechanic_id = m.id AND l.created_at >= datetime('now','-7 days')
               WHERE m.is_active = 1 AND m.role IN ('mechanic','both')
               GROUP BY m.name ORDER BY revenue DESC LIMIT 8`),
      db.many(`SELECT date(received_at) AS day, COALESCE(SUM(amount_cents),0) / 100.0 AS s
                FROM work_order_payments WHERE date(received_at) >= date('now','-13 days')
                GROUP BY day ORDER BY day`),
      db.many(`SELECT status, COUNT(*) AS n FROM work_orders GROUP BY status`),
      db.one(`SELECT COUNT(*) AS n FROM inspections WHERE status = 'in_progress'`),
    ]);

    const s = sales || {};
    const svcActive = woByStatus.some((r) => !['paid', 'cancelled'].includes(r.status) && r.n > 0)
      || Number((revMonth && revMonth.s) || 0) > 0;

    return c.json({
      sales: {
        today: s.today || 0, today_n: s.today_n || 0,
        week: s.week || 0, week_n: s.week_n || 0,
        month: s.month || 0, month_n: s.month_n || 0,
        avg_today: s.today_n ? s.today / s.today_n : 0,
      },
      sales_sparkline: fill14(spark, 'total'),
      tender_mix: tender,
      top_sellers: topSellers,
      ar: ar || { customers_owing: 0, total_owed: 0 },
      attention: attention || {},
      recent,
      has_service: svcActive,
      revenue: {
        today: (revToday && revToday.s) || 0,
        week: (revWeek && revWeek.s) || 0,
        month: (revMonth && revMonth.s) || 0,
        sparkline: fill14(svcDaily, 's'),
      },
      work_orders_open: wosOpen,
      mechanic_utilization: mechUtil,
      work_orders_by_status: woByStatus,
      low_stock_count: (attention && attention.low_stock) || 0,
      open_inspections: (openInspections && openInspections.n) || 0,
    });
  });
}
