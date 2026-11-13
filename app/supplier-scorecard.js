// =============================================================================
//  Vision Auto Solutions -- Supplier scorecard and the import-or-buy-local
//  calculator (scaling roadmap, Phase 4)
//
//  Mounted by server.js:
//    require('./supplier-scorecard').register(app, { query, requireAdmin, requireCap })
//  Page: supplier-scorecard.html. Routes under /api/supscore (cap growth.view).
//
//  Scorecard, per supplier, over the last N months (default 12) from purchase
//  orders and their lines:
//    spend and share    what we bought and its share of all buying
//    price change       cost of the same parts from this supplier, this period
//                       against the period before, weighted by what we bought
//    cheapest share     of the parts we also bought from someone else in the
//                       period, how often this supplier's price was the lowest
//    overpaid           what we would have saved paying the lowest price we
//                       paid anyone for those same parts in the period
//    fill rate          received / ordered (new receiving only: the old
//                       system recorded every PO as received in full)
//    lead time          ordered to received, days (same caveat)
//
//  Import calculator: for chosen parts, an overseas price in US$ turned into a
//  landed J$ cost per unit (FOB + freight + insurance = CIF; duty, customs
//  administrative fee, environmental levy and standard compliance fee on CIF;
//  broker and local delivery shared by value) and set against what we pay
//  locally now, with the yearly saving at the last 12 months' sales. GCT paid
//  at the border is left out: a GCT-registered business claims it back. The
//  default rates are a starting point to confirm with a customs broker.
// =============================================================================
'use strict';

const DEFAULTS = { insurance_pct: 1.5, duty_pct: 20, caf_pct: 2, env_levy_pct: 0.5, scf_pct: 0.3, broker_jmd: 25000, local_delivery_jmd: 15000 };

function register(app, deps) {
  const { query, requireAdmin, requireCap } = deps;
  const can = (k) => [requireAdmin, requireCap(k)];
  function httpError(status, msg) { const e = new Error(msg); e.status = status; e.publicMessage = msg; return e; }
  function fail(res, e) { const s = e.status || 500; if (s >= 500) console.error('[supscore]', e); res.status(s).json({ error: e.publicMessage || e.message }); }
  const n = (v) => (v == null ? 0 : Number(v));
  const r1 = (v) => Math.round(n(v) * 10) / 10;
  const months = (q) => Math.max(1, Math.min(36, Math.round(Number(q) || 12)));

  // One row per PO line in a window, with a key that identifies the part.
  const LINES = `
    SELECT po.id AS po_id, po.supplier_id, po.created_at, COALESCE(po.ordered_at, po.created_at) AS ordered_at,
           COALESCE(po.received_date::timestamptz, po.received_at) AS received_at, po.legacy_key,
           COALESCE(i.product_id::text, NULLIF(i.product_img, ''), NULLIF(i.sku, ''), LOWER(i.description)) AS part,
           COALESCE(i.qty_ordered, i.qty, 0)::float AS qty_ordered, COALESCE(i.qty_received, 0)::float AS qty_received,
           COALESCE(i.qty, i.qty_ordered, 0)::float AS qty, i.unit_cost_usd::float AS unit_cost,
           COALESCE(i.total_usd, i.qty * i.unit_cost_usd)::float AS amount, i.description
      FROM purchase_orders po JOIN purchase_order_items i ON i.po_id = po.id
     WHERE po.status <> 'draft' AND COALESCE(po.status, '') NOT IN ('cancelled', 'void') AND i.unit_cost_usd > 0`;

  async function scorecard(m) {
    const { rows } = await query(
      `WITH cur AS (SELECT * FROM (${LINES}) l WHERE created_at >= NOW() - make_interval(months => $1::int)),
            prev AS (SELECT * FROM (${LINES}) l WHERE created_at >= NOW() - make_interval(months => 2 * $1::int) AND created_at < NOW() - make_interval(months => $1::int)),
            -- average cost per supplier and part, each period
            cp AS (SELECT supplier_id, part, SUM(amount) / NULLIF(SUM(qty), 0) AS cost, SUM(qty) AS qty, SUM(amount) AS amount FROM cur GROUP BY 1, 2),
            pp AS (SELECT supplier_id, part, SUM(amount) / NULLIF(SUM(qty), 0) AS cost FROM prev GROUP BY 1, 2),
            -- lowest price paid to anyone for each part this period
            low AS (SELECT part, MIN(cost) AS low_cost, COUNT(DISTINCT supplier_id) AS suppliers FROM cp GROUP BY part),
            per AS (
              SELECT cp.supplier_id,
                     SUM(cp.amount) AS spend,
                     SUM(cp.qty * pp.cost) FILTER (WHERE pp.cost IS NOT NULL) AS same_parts_prev_cost,
                     SUM(cp.amount) FILTER (WHERE pp.cost IS NOT NULL) AS same_parts_cur_cost,
                     COUNT(*) FILTER (WHERE low.suppliers > 1) AS shared_parts,
                     COUNT(*) FILTER (WHERE low.suppliers > 1 AND cp.cost <= low.low_cost * 1.0001) AS cheapest_parts,
                     SUM(GREATEST(cp.cost - low.low_cost, 0) * cp.qty) FILTER (WHERE low.suppliers > 1) AS overpaid,
                     COUNT(DISTINCT cp.part) AS parts
                FROM cp LEFT JOIN pp ON pp.supplier_id = cp.supplier_id AND pp.part = cp.part
                JOIN low ON low.part = cp.part
               GROUP BY cp.supplier_id),
            ops AS (
              SELECT supplier_id, COUNT(DISTINCT po_id) AS pos,
                     SUM(qty_received) FILTER (WHERE legacy_key IS NULL) AS rcv, SUM(qty_ordered) FILTER (WHERE legacy_key IS NULL) AS ord,
                     AVG(EXTRACT(EPOCH FROM (received_at - ordered_at)) / 86400) FILTER (WHERE legacy_key IS NULL AND received_at IS NOT NULL AND received_at >= ordered_at) AS lead_days
                FROM cur GROUP BY supplier_id)
       SELECT s.id, s.name, s.lead_time_days AS stated_lead_days, s.payment_terms_days, s.currency,
              per.spend::float, per.parts::int, ops.pos::int,
              CASE WHEN per.same_parts_prev_cost > 0 THEN (per.same_parts_cur_cost / per.same_parts_prev_cost - 1) * 100 END::float AS price_change_pct,
              per.shared_parts::int, per.cheapest_parts::int, COALESCE(per.overpaid, 0)::float AS overpaid,
              CASE WHEN ops.ord > 0 THEN ops.rcv / ops.ord * 100 END::float AS fill_rate, ops.lead_days::float AS lead_days
         FROM per JOIN suppliers s ON s.id = per.supplier_id LEFT JOIN ops ON ops.supplier_id = per.supplier_id
        ORDER BY per.spend DESC`, [m]);
    const total = rows.reduce((a, r) => a + n(r.spend), 0);
    return {
      months: m, total_spend: Math.round(total),
      top10_share: total ? r1(rows.slice(0, 10).reduce((a, r) => a + n(r.spend), 0) / total * 100) : null,
      overpaid_total: Math.round(rows.reduce((a, r) => a + n(r.overpaid), 0)),
      suppliers: rows.map((r) => Object.assign(r, {
        spend: Math.round(n(r.spend)), share_pct: total ? r1(n(r.spend) / total * 100) : null,
        price_change_pct: r.price_change_pct == null ? null : r1(r.price_change_pct),
        cheapest_pct: r.shared_parts ? r1(r.cheapest_parts / r.shared_parts * 100) : null,
        overpaid: Math.round(n(r.overpaid)), fill_rate: r.fill_rate == null ? null : r1(r.fill_rate), lead_days: r.lead_days == null ? null : r1(r.lead_days),
      })),
    };
  }

  // The parts where this supplier cost us most against the cheapest price we
  // paid someone else, and the parts whose price went up most.
  async function detail(id, m) {
    const { rows } = await query(
      `WITH cur AS (SELECT * FROM (${LINES}) l WHERE created_at >= NOW() - make_interval(months => $2::int)),
            prev AS (SELECT * FROM (${LINES}) l WHERE created_at >= NOW() - make_interval(months => 2 * $2::int) AND created_at < NOW() - make_interval(months => $2::int)),
            cp AS (SELECT supplier_id, part, MAX(description) AS description, SUM(amount) / NULLIF(SUM(qty), 0) AS cost, SUM(qty) AS qty FROM cur GROUP BY 1, 2),
            pp AS (SELECT supplier_id, part, SUM(amount) / NULLIF(SUM(qty), 0) AS cost FROM prev GROUP BY 1, 2),
            best AS (SELECT DISTINCT ON (part) part, supplier_id AS best_supplier, cost AS best_cost FROM cp ORDER BY part, cost)
       SELECT cp.part, cp.description, cp.qty::float, cp.cost::float, pp.cost::float AS prev_cost,
              b.best_cost::float, bs.name AS best_supplier,
              CASE WHEN b.best_supplier <> cp.supplier_id THEN (cp.cost - b.best_cost) * cp.qty ELSE 0 END::float AS overpaid,
              CASE WHEN pp.cost > 0 THEN (cp.cost / pp.cost - 1) * 100 END::float AS change_pct
         FROM cp LEFT JOIN pp ON pp.supplier_id = cp.supplier_id AND pp.part = cp.part
         JOIN best b ON b.part = cp.part LEFT JOIN suppliers bs ON bs.id = b.best_supplier
        WHERE cp.supplier_id = $1`, [id, m]);
    const fix = (r) => Object.assign(r, { cost: Math.round(r.cost * 100) / 100, prev_cost: r.prev_cost == null ? null : Math.round(r.prev_cost * 100) / 100,
      best_cost: Math.round(r.best_cost * 100) / 100, overpaid: Math.round(r.overpaid), change_pct: r.change_pct == null ? null : r1(r.change_pct) });
    return {
      overpaid: rows.filter((r) => r.overpaid > 0).sort((a, b) => b.overpaid - a.overpaid).slice(0, 25).map(fix),
      price_rises: rows.filter((r) => r.change_pct != null && r.change_pct > 0).sort((a, b) => (b.change_pct * b.qty * b.cost) - (a.change_pct * a.qty * a.cost)).slice(0, 25).map(fix),
    };
  }

  app.get('/api/supscore', ...can('growth.view'), async (req, res) => {
    try { res.json(await scorecard(months(req.query.months))); } catch (e) { fail(res, e); }
  });
  app.get('/api/supscore/supplier/:id', ...can('growth.view'), async (req, res) => {
    try { res.json(await detail(Number(req.params.id) || 0, months(req.query.months))); } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------- import calculator --
  async function fxUsd() {
    const { rows } = await query(`SELECT rate::float AS rate, rate_date FROM exchange_rates WHERE currency = 'USD' ORDER BY rate_date DESC, (source = 'manual') DESC LIMIT 1`);
    return rows[0] || { rate: null, rate_date: null };
  }
  async function partsInfo(ids) {
    if (!ids.length) return [];
    const { rows } = await query(
      `SELECT p.id, p.name, p.sku, p.cost_usd::float AS cost, p.price_usd::float AS price,
              COALESCE((SELECT SUM(i.qty) FROM pos_sale_items i JOIN pos_sales s ON s.id = i.sale_id
                         WHERE i.product_id = p.id AND NOT COALESCE(s.voided, false) AND s.created_at >= NOW() - INTERVAL '365 days'), 0)::float AS sold_12m
         FROM products p WHERE p.id = ANY($1::int[])`, [ids]);
    return rows;
  }
  app.get('/api/supscore/import/defaults', ...can('growth.view'), async (_req, res) => {
    try { res.json(Object.assign({}, DEFAULTS, { fx: await fxUsd() })); } catch (e) { fail(res, e); }
  });
  app.get('/api/supscore/import/parts', ...can('growth.view'), async (req, res) => {
    try {
      const q = String(req.query.q || '').trim().slice(0, 60);
      if (q.length < 2) return res.json({ parts: [] });
      const { rows } = await query(
        `SELECT id FROM products WHERE COALESCE(is_active, true) AND (name ILIKE $1 OR sku ILIKE $1) ORDER BY stock_count DESC NULLS LAST LIMIT 15`, ['%' + q + '%']);
      res.json({ parts: await partsInfo(rows.map((r) => r.id)) });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/supscore/import/calc', ...can('growth.view'), async (req, res) => {
    try {
      const b = req.body || {};
      const num = (k, lo, hi) => { const v = b[k] == null || b[k] === '' ? DEFAULTS[k] : Number(b[k]); if (!Number.isFinite(v) || v < lo || v > hi) throw httpError(400, k.replace(/_/g, ' ') + ' is out of range'); return v; };
      const fx = Number(b.fx) > 0 ? Number(b.fx) : (await fxUsd()).rate;
      if (!(fx > 0)) throw httpError(400, 'Enter the US$ exchange rate');
      const lines = (Array.isArray(b.lines) ? b.lines : []).filter((l) => Number(l.product_id) > 0 && Number(l.fob_usd) > 0 && Number(l.qty) > 0).slice(0, 50);
      if (!lines.length) throw httpError(400, 'Add at least one part with a US$ price and quantity');
      const freight = Math.max(0, Number(b.freight_usd) || 0);
      const ins = num('insurance_pct', 0, 20), duty = num('duty_pct', 0, 100), caf = num('caf_pct', 0, 20), env = num('env_levy_pct', 0, 10), scf = num('scf_pct', 0, 10);
      const broker = num('broker_jmd', 0, 1e8), delivery = num('local_delivery_jmd', 0, 1e8);
      const info = new Map((await partsInfo(lines.map((l) => Number(l.product_id)))).map((p) => [p.id, p]));
      const fobTotal = lines.reduce((a, l) => a + Number(l.fob_usd) * Number(l.qty), 0);
      const out = lines.map((l) => {
        const p = info.get(Number(l.product_id)) || {};
        const fob = Number(l.fob_usd) * Number(l.qty);
        const share = fob / fobTotal;
        const cifUsd = fob + freight * share + fob * ins / 100;
        const cif = cifUsd * fx;
        const charges = cif * (duty + caf + env + scf) / 100;
        const landed = cif + charges + (broker + delivery) * share;
        const unit = landed / Number(l.qty);
        const local = n(p.cost);
        return { product_id: p.id, name: p.name, sku: p.sku, qty: Number(l.qty), fob_usd: Number(l.fob_usd),
          landed_unit: Math.round(unit * 100) / 100, local_unit: local || null,
          saving_unit: local ? Math.round((local - unit) * 100) / 100 : null,
          saving_pct: local ? r1((local - unit) / local * 100) : null,
          sold_12m: n(p.sold_12m), yearly_saving: local ? Math.round((local - unit) * n(p.sold_12m)) : null,
          margin_now_pct: p.price ? r1((p.price - local) / p.price * 100) : null, margin_import_pct: p.price ? r1((p.price - unit) / p.price * 100) : null };
      });
      const shipmentLanded = out.reduce((a, l) => a + l.landed_unit * l.qty, 0);
      const shipmentLocal = out.reduce((a, l) => a + (l.local_unit || 0) * l.qty, 0);
      res.json({ fx, lines: out, shipment: { landed: Math.round(shipmentLanded), local: Math.round(shipmentLocal), saving: Math.round(shipmentLocal - shipmentLanded),
        yearly_saving: out.reduce((a, l) => a + (l.yearly_saving || 0), 0) } });
    } catch (e) { fail(res, e); }
  });

  return { scorecard, detail };
}

module.exports = { register, DEFAULTS };
