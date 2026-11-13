// =============================================================================
//  Vision Auto Solutions -- Buy overseas or local (foreign purchase comparison)
//
//  For fast selling parts, parts that are out of stock or running low, or any
//  group of parts (category, supplier, search, ticked), work out the most we
//  could pay overseas in US$ and still make our markup selling at today's
//  price, and set that against what we pay locally now.
//
//    max landed J$   = selling price (before GCT) / (1 + markup)
//    landed J$       = US$ cost x BOJ rate x (1 + shipping) x (1 + duty)
//                      (duty on cost + shipping, the CIF value; or on cost only)
//                      x (1 + import GCT) only when GCT is not claimed back
//    max US$ cost    = max landed J$ / (BOJ rate x that factor)
//    break-even US$  = local cost J$ / (BOJ rate x that factor)
//
//  The working is done in the page so markups and quotes change instantly;
//  this file only serves the parts, sales, stock, local cost and the rate.
//
//  Mounted by server.js:
//    require('./overseas-compare').register(app, { query, requireAdmin, requireCap, userCan })
//  Page: overseas-compare.html. Routes under /api/overseas:
//    GET  setup     defaults, BOJ US$ rate, categories, suppliers, permissions
//    PUT  setup     save the defaults (cap purchasing.settings)
//    GET  items     ?pick=fast|out|low|category|supplier|search|ids|po &value= &days= &limit=
//                   (pick=po also returns the order's own qty and unit cost per part)
//    GET  pos       recent purchase orders to run through the comparison
//  Opens for purchasing.create_po or growth.view. Defaults are kept as one
//  JSON row in warehouse_settings (key overseas_compare). No new tables.
//
//  Money: products.price_usd / cost_usd hold J$ (historic names). Shelf prices
//  are before GCT (GCT is added at the till). PO unit costs are in the
//  supplier's currency.
// =============================================================================
'use strict';

const DEFAULTS = {
  markup_pct: 30,          // markup on landed cost used for every line unless changed
  duty_pct: 45,            // average customs duty
  ship_pct: 5,             // shipping and handling, % of the US$ cost
  duty_on: 'cif',          // 'cif' = duty on cost + shipping; 'cost' = on cost only
  import_gct_pct: 15,
  import_gct_on: false,    // false = GCT paid at the border is claimed back, so left out
  lead_days: 14,           // overseas lead time
  cover_days: 30,          // order enough for the lead time plus this many days
  fast_days: 60,           // "fast selling" = units sold in this many days
  fixed_jmd: 0,            // broker, port and delivery per overseas shipment, J$
  min_saving_pct: 10,      // overseas is only worth it when it saves at least this much
};
const KEY = 'overseas_compare';
const PICKS = ['fast', 'out', 'low', 'category', 'supplier', 'search', 'ids', 'po'];

function clean(b, base) {
  const o = Object.assign({}, base);
  const num = (k, lo, hi) => {
    if (b[k] === undefined || b[k] === null || b[k] === '') return;
    const v = Number(b[k]);
    if (!Number.isFinite(v) || v < lo || v > hi) { const e = new Error(k.replace(/_/g, ' ') + ' must be ' + lo + ' to ' + hi); e.status = 400; throw e; }
    o[k] = v;
  };
  num('markup_pct', 0, 500); num('duty_pct', 0, 200); num('ship_pct', 0, 100); num('import_gct_pct', 0, 50);
  num('lead_days', 0, 365); num('cover_days', 0, 365); num('fast_days', 7, 365);
  num('fixed_jmd', 0, 1e8); num('min_saving_pct', 0, 100);
  if (b.duty_on !== undefined) o.duty_on = b.duty_on === 'cost' ? 'cost' : 'cif';
  if (b.import_gct_on !== undefined) o.import_gct_on = b.import_gct_on === true || b.import_gct_on === 'true';
  return o;
}

function register(app, deps) {
  const { query, requireAdmin, requireCap, userCan } = deps;
  function fail(res, e) { const s = e.status || 500; if (s >= 500) console.error('[overseas]', e); res.status(s).json({ error: e.publicMessage || e.message }); }
  // Either permission opens the screen.
  const anyCap = (keys) => async (req, res, next) => {
    if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Sign in required' });
    for (const k of keys) if (await userCan(req, k)) return next();
    return res.status(403).json({ error: 'Your account is not allowed to see purchasing comparisons.' });
  };
  const view = [requireAdmin, anyCap(['purchasing.create_po', 'growth.view'])];

  async function settings() {
    const { rows } = await query('SELECT value FROM warehouse_settings WHERE key = $1', [KEY]);
    let saved = {};
    try { saved = rows.length && rows[0].value ? JSON.parse(rows[0].value) : {}; } catch (_) { saved = {}; }
    try { return clean(saved, DEFAULTS); } catch (_) { return Object.assign({}, DEFAULTS); }
  }

  // Latest US$ rate on or before today; on the same date a manual entry wins
  // over the Bank of Jamaica one (same rule as inbound.js).
  async function fxUsd() {
    const { rows } = await query(
      `SELECT rate::float AS rate, buy::float AS buy, sell::float AS sell, source, rate_date
         FROM exchange_rates WHERE currency = 'USD' AND rate_date <= CURRENT_DATE
        ORDER BY rate_date DESC, (source = 'manual') DESC, created_at DESC LIMIT 1`);
    const { rows: u } = await query("SELECT value FROM warehouse_settings WHERE key = 'fx_use'");
    return Object.assign({ rate: null, buy: null, sell: null, source: null, rate_date: null }, rows[0] || {}, { use: (u[0] && u[0].value) || 'sell' });
  }

  app.get('/api/overseas/setup', view, async (req, res) => {
    try {
      const [s, fx, cats, sups] = await Promise.all([
        settings(), fxUsd(),
        query(`SELECT category, COUNT(*)::int AS n FROM products WHERE COALESCE(is_active, true) AND category IS NOT NULL AND category <> '' GROUP BY 1 ORDER BY 1`),
        query(`SELECT s.id, s.name, COALESCE(s.currency, 'JMD') AS currency,
                      (SELECT COUNT(*) FROM products p WHERE p.supplier_id = s.id)::int AS products
                 FROM suppliers s WHERE COALESCE(s.is_active, true) ORDER BY s.name`),
      ]);
      res.json({
        settings: s, defaults: DEFAULTS, fx,
        categories: cats.rows, suppliers: sups.rows,
        can_settings: await userCan(req, 'purchasing.settings'),
        can_po: await userCan(req, 'purchasing.create_po'),
      });
    } catch (e) { fail(res, e); }
  });

  // Recent purchase orders to pick from (newest first), with a search.
  app.get('/api/overseas/pos', view, async (req, res) => {
    try {
      const q = String(req.query.q || '').trim().slice(0, 60);
      const { rows } = await query(
        `SELECT po.id, po.po_number, po.status, COALESCE(po.currency, s.currency, 'JMD') AS currency, po.created_at,
                s.name AS supplier_name, po.total_usd::float AS total,
                (SELECT COUNT(*) FROM purchase_order_items i WHERE i.po_id = po.id)::int AS lines
           FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id
          WHERE COALESCE(po.status, '') NOT IN ('cancelled', 'void')
            AND ($1 = '' OR po.po_number ILIKE '%' || $1 || '%' OR s.name ILIKE '%' || $1 || '%')
          ORDER BY po.created_at DESC NULLS LAST, po.id DESC LIMIT 60`, [q]);
      res.json({ pos: rows });
    } catch (e) { fail(res, e); }
  });

  app.put('/api/overseas/setup', requireAdmin, requireCap('purchasing.settings'), async (req, res) => {
    try {
      const s = clean(req.body || {}, await settings());
      await query(`INSERT INTO warehouse_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [KEY, JSON.stringify(s)]);
      res.json({ settings: s });
    } catch (e) { fail(res, e); }
  });

  // One row per part: sales in the window and in 12 months, stock, on order,
  // price, local cost (last PO from a J$ supplier, else the average cost) and
  // the last overseas (US$) price we paid, if any.
  const ITEMS_SQL = (where, order) => `
    WITH sales AS (
      SELECT i.product_img,
             SUM(i.qty) FILTER (WHERE s.created_at >= NOW() - make_interval(days => $1::int)) AS qw,
             SUM(i.qty) AS q12, MAX(s.created_at) AS last_sold
        FROM pos_sale_items i JOIN pos_sales s ON s.id = i.sale_id
       WHERE s.created_at >= NOW() - INTERVAL '365 days' AND NOT COALESCE(s.voided, false)
         AND i.qty > 0 AND i.product_img IS NOT NULL
       GROUP BY i.product_img),
    on_order AS (
      SELECT poi.product_img,
             SUM(GREATEST(COALESCE(poi.qty_ordered, poi.qty, 0) - COALESCE(poi.qty_received, 0) - COALESCE(poi.qty_cancelled, 0), 0)) AS q
        FROM purchase_order_items poi JOIN purchase_orders po ON po.id = poi.po_id
       WHERE po.status IN ('draft', 'sent', 'ordered', 'partial') AND po.created_at >= NOW() - INTERVAL '180 days'
       GROUP BY poi.product_img),
    base AS (
      SELECT p.id, p.img, p.sku, p.name, p.make_model, p.category, p.condition, p.stock_count,
             p.price_usd::float AS price, p.cost_usd::float AS avg_cost, p.supplier_id,
             p.supplier_part_no, p.reorder_qty,
             sup.name AS supplier_name, COALESCE(sup.currency, 'JMD') AS supplier_currency,
             COALESCE(sa.qw, 0)::int AS sold_window, COALESCE(sa.q12, 0)::int AS sold_12m, sa.last_sold,
             COALESCE(oo.q, 0)::int AS on_order
        FROM products p
        LEFT JOIN suppliers sup ON sup.id = p.supplier_id
        LEFT JOIN sales sa ON sa.product_img = p.img
        LEFT JOIN on_order oo ON oo.product_img = p.img
       WHERE COALESCE(p.is_active, true) AND NOT COALESCE(p.discontinued, false) AND p.variant_of IS NULL
         AND ${where})
    SELECT b.*,
           loc.unit_cost AS last_local_cost, loc.at AS last_local_at, loc.supplier AS last_local_supplier,
           usd.unit_cost AS last_usd_cost, usd.at AS last_usd_at, usd.supplier AS last_usd_supplier
      FROM base b
      LEFT JOIN LATERAL (
        SELECT poi.unit_cost_usd::float AS unit_cost, COALESCE(po.ordered_at, po.created_at) AS at, s.name AS supplier
          FROM purchase_order_items poi JOIN purchase_orders po ON po.id = poi.po_id LEFT JOIN suppliers s ON s.id = po.supplier_id
         WHERE poi.product_img = b.img AND poi.unit_cost_usd > 0 AND COALESCE(po.currency, s.currency, 'JMD') = 'JMD'
           AND COALESCE(po.status, '') NOT IN ('cancelled', 'void', 'draft')
         ORDER BY COALESCE(po.ordered_at, po.created_at) DESC LIMIT 1) loc ON true
      LEFT JOIN LATERAL (
        SELECT poi.unit_cost_usd::float AS unit_cost, COALESCE(po.ordered_at, po.created_at) AS at, s.name AS supplier
          FROM purchase_order_items poi JOIN purchase_orders po ON po.id = poi.po_id LEFT JOIN suppliers s ON s.id = po.supplier_id
         WHERE poi.product_img = b.img AND poi.unit_cost_usd > 0 AND COALESCE(po.currency, s.currency, 'JMD') = 'USD'
           AND COALESCE(po.status, '') NOT IN ('cancelled', 'void', 'draft')
         ORDER BY COALESCE(po.ordered_at, po.created_at) DESC LIMIT 1) usd ON true
     ORDER BY ${order}
     LIMIT $2`;

  app.get('/api/overseas/items', view, async (req, res) => {
    try {
      const s = await settings();
      const pick = PICKS.includes(req.query.pick) ? req.query.pick : 'fast';
      const days = Math.max(7, Math.min(365, parseInt(req.query.days, 10) || s.fast_days));
      const limit = Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 100));
      const lead = Math.max(0, Math.min(365, parseInt(req.query.lead_days, 10) || s.lead_days));
      const value = String(req.query.value || '').trim().slice(0, 80);
      const params = [days, pick === 'po' ? 1000 : limit];
      let where = 'true', order = 'sold_window DESC, sold_12m DESC, name';
      if (pick === 'fast') where = 'COALESCE(sa.qw, 0) > 0';
      else if (pick === 'out') { where = 'p.stock_count <= 0 AND COALESCE(sa.q12, 0) > 0'; order = 'sold_12m DESC, name'; }
      else if (pick === 'low') {
        // Stock (with what is on order) will not last until an overseas order lands.
        params.push(lead);
        where = `COALESCE(sa.q12, 0) > 0 AND (p.stock_count + COALESCE(oo.q, 0)) <
                 GREATEST((0.5 * COALESCE(sa.qw, 0) / $1::float + 0.5 * COALESCE(sa.q12, 0) / 365.0) * $3::int, 1)`;
        order = '(stock_count + on_order) ASC, sold_window DESC, name';
      } else if (pick === 'category') {
        if (!value) return res.status(400).json({ error: 'Choose a category' });
        params.push(value); where = 'lower(p.category) = lower($3)';
      } else if (pick === 'supplier') {
        const id = parseInt(value, 10);
        if (!(id > 0)) return res.status(400).json({ error: 'Choose a supplier' });
        params.push(id); where = 'p.supplier_id = $3';
      } else if (pick === 'search') {
        if (value.length < 2) return res.json({ lines: [], days, pick });
        params.push('%' + value + '%');
        where = '(p.name ILIKE $3 OR p.sku ILIKE $3 OR p.make_model ILIKE $3 OR p.supplier_part_no ILIKE $3 OR p.barcode ILIKE $3)';
      } else if (pick === 'po') {
        const poId = parseInt(value, 10);
        if (!(poId > 0)) return res.status(400).json({ error: 'Choose a purchase order' });
        params.push(poId); where = 'p.img IN (SELECT product_img FROM purchase_order_items WHERE po_id = $3)';
        order = 'name';
      } else if (pick === 'ids') {
        const ids = value.split(',').map((x) => parseInt(x, 10)).filter((x) => x > 0).slice(0, 500);
        if (!ids.length) return res.json({ lines: [], days, pick });
        params.push(ids); where = 'p.id = ANY($3::int[])';
      }
      const { rows } = await query(ITEMS_SQL(where, order), params);
      const lines = rows.map((r) => {
        // Daily rate: half the recent window, half the year (as reorder does).
        const perDay = 0.5 * r.sold_window / days + 0.5 * r.sold_12m / 365;
        const local = r.last_local_cost != null ? r.last_local_cost : (r.avg_cost > 0 ? r.avg_cost : null);
        return {
          id: r.id, img: r.img, sku: r.sku, name: r.name, make_model: r.make_model, category: r.category, condition: r.condition,
          supplier_id: r.supplier_id, supplier_name: r.supplier_name, supplier_currency: r.supplier_currency, supplier_part_no: r.supplier_part_no,
          stock: r.stock_count, on_order: r.on_order, sold_window: r.sold_window, sold_12m: r.sold_12m, last_sold: r.last_sold,
          per_day: Math.round(perDay * 1000) / 1000, pack: r.reorder_qty > 1 ? r.reorder_qty : null,
          price: r.price,
          local_cost: local, local_source: r.last_local_cost != null ? 'last_po' : (local != null ? 'average' : null),
          local_at: r.last_local_at, local_supplier: r.last_local_supplier, avg_cost: r.avg_cost,
          last_usd_cost: r.last_usd_cost, last_usd_at: r.last_usd_at, last_usd_supplier: r.last_usd_supplier,
        };
      });
      let po = null;
      if (pick === 'po') {
        // The order's own quantities and prices, one per part (lines for the same part added up).
        const poId = parseInt(value, 10);
        const { rows: h } = await query(
          `SELECT po.id, po.po_number, po.status, COALESCE(po.currency, s.currency, 'JMD') AS currency, po.created_at, po.notes,
                  s.id AS supplier_id, s.name AS supplier_name, po.total_usd::float AS total
             FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id WHERE po.id = $1`, [poId]);
        if (!h.length) return res.status(404).json({ error: 'Purchase order not found' });
        const { rows: pl } = await query(
          `SELECT product_img, description, SUM(COALESCE(qty_ordered, qty, 0))::float AS qty,
                  SUM(COALESCE(qty_ordered, qty, 0) * COALESCE(unit_cost_usd, 0))::float AS amount
             FROM purchase_order_items WHERE po_id = $1 GROUP BY product_img, description`, [poId]);
        const byImg = new Map();
        for (const r of pl) {
          if (!r.product_img) continue;
          const x = byImg.get(r.product_img) || { qty: 0, amount: 0 };
          x.qty += r.qty; x.amount += r.amount; byImg.set(r.product_img, x);
        }
        for (const l of lines) {
          const x = byImg.get(l.img);
          l.po_qty = x ? x.qty : 0;
          l.po_unit_cost = x && x.qty > 0 ? Math.round(x.amount / x.qty * 100) / 100 : null;
        }
        const known = new Set(lines.map((l) => l.img));
        po = Object.assign(h[0], {
          lines: pl.length,
          not_in_stock_list: pl.filter((r) => !r.product_img || !known.has(r.product_img)).map((r) => r.description).slice(0, 20),
        });
      }
      res.json({ lines, days, pick, lead_days: lead, po });
    } catch (e) { fail(res, e); }
  });

  return { settings, fxUsd };
}

module.exports = { register, DEFAULTS, clean };
