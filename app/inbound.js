// =============================================================================
//  Morty's Auto Parts -- Inbound API (Phase 2)
//
//  Mounted by server.js:  require('./inbound').register(app, deps)
//  Routes under /api/inb:
//    fx          Bank of Jamaica rates (fetched daily) + manual override
//    reorder     suggestions from sales history and lead time -> draft POs
//    receipts    receive against a PO in batches (GRN), landed cost, average
//                cost, suggested prices, post into the RECEIVING bin
//    bills       three-way match (PO / receipt / supplier invoice), confirm
//                as payable, dispute
//    backorders  short-shipped PO lines: list, cancel the remainder
//    pricing     markup rules used for suggested prices
//
//  Money: product cost_usd / price_usd hold J$ (historic column names).
//  PO and receipt unit costs are in the supplier's currency; a receipt carries
//  the fx_rate (J$ per unit) it was costed at.
// =============================================================================
'use strict';

// Names exactly as the BOJ table spells them.
const CURRENCIES = { USD: 'U.S. DOLLAR', CAD: 'CANADIAN DOLLAR', GBP: 'GREAT BRITAIN POUND', EUR: 'EURO' };
const BOJ_PAGE = 'https://boj.org.jm/market/foreign-exchange/indicative-rates/';
const BOJ_AJAX = 'https://boj.org.jm/wp-admin/admin-ajax.php?action=get_wdtable&table_id=';

function register(app, deps) {
  const { query, getPool, requireAdmin, requireCap, recalcPoDueDate, recalcPoPaid, DEV_MODE } = deps;
  const gate = [requireAdmin];
  const cap = (k) => requireCap(k);

  // ---------------------------------------------------------------- helpers --
  function httpError(status, msg) { const e = new Error(msg); e.status = status; e.publicMessage = msg; return e; }
  function fail(res, e) {
    const status = e.status || 500;
    if (status >= 500) console.error('[inb]', e);
    res.status(status).json({ error: e.publicMessage || e.message });
  }
  const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  const round = (v, dp) => { const f = Math.pow(10, dp); return Math.round(v * f) / f; };

  async function tx(fn, binSyncOff) {
    const c = await getPool().connect();
    try {
      await c.query('BEGIN');
      if (binSyncOff) await c.query("SELECT set_config('vision.bin_sync_off', 'on', true)");
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      try { await c.query('ROLLBACK'); } catch (_) {}
      throw e;
    } finally { c.release(); }
  }

  // Run a read-only query on its own connection with a hard statement timeout,
  // so a heavy analytical query (e.g. reorder suggestions) can never run away
  // and stall the till. On timeout it throws a 503 the caller can report.
  async function queryCapped(sql, params, ms) {
    const c = await getPool().connect();
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL statement_timeout = ${parseInt(ms, 10) || 60000}`);  // LOCAL: resets on COMMIT/ROLLBACK, never leaks to the pooled connection
      const r = await c.query(sql, params);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      try { await c.query('ROLLBACK'); } catch (_) {}
      if (e && e.code === '57014') throw Object.assign(new Error('That report took too long and was stopped. Narrow it (e.g. pick one supplier) or try again shortly.'), { status: 503 });
      throw e;
    } finally { c.release(); }
  }

  async function setting(key, dflt, q = query) {
    const { rows } = await q('SELECT value FROM warehouse_settings WHERE key = $1', [key]);
    return rows.length && rows[0].value != null ? rows[0].value : dflt;
  }

  async function userCanCap(req, key) {
    // requireCap as a predicate: run it with a fake res and see if it calls next().
    return new Promise((resolve) => {
      const res = { status() { return this; }, json() { resolve(false); } };
      requireCap(key)(req, res, () => resolve(true));
    });
  }

  // ------------------------------------------------------- exchange rates --
  async function effectiveRate(currency, onDate, q = query) {
    if (!currency || currency === 'JMD') return { rate: 1, source: 'base', rate_date: null };
    // Latest rate on/before the date; on the same date a manual entry wins over BOJ.
    const { rows } = await q(
      `SELECT rate::float AS rate, source, rate_date FROM exchange_rates
        WHERE currency = $1 AND rate_date <= COALESCE($2::date, CURRENT_DATE)
        ORDER BY rate_date DESC, (source = 'manual') DESC, created_at DESC LIMIT 1`, [currency, onDate || null]);
    return rows[0] || null;
  }

  async function fetchBoj() {
    const use = await setting('fx_use', 'sell');
    const ua = { 'User-Agent': 'Mozilla/5.0 (MortysAutoParts rate check)' };
    const page = await fetch(BOJ_PAGE, { headers: ua, signal: AbortSignal.timeout(20000) }).then((r) => r.text());
    const m = /wdtNonceFrontendServerSide_(\d+)"[^>]*value="([a-f0-9]+)"/.exec(page);
    if (!m) throw new Error('BOJ page layout changed: rate table not found');
    const [, tableId, nonce] = m;
    const saved = [];
    for (const [code, label] of Object.entries(CURRENCIES)) {
      const p = new URLSearchParams({ draw: '1', start: '0', length: '5', 'order[0][column]': '0', 'order[0][dir]': 'desc', wdtNonce: nonce, 'search[value]': label });
      for (let i = 0; i < 4; i++) {
        p.set(`columns[${i}][data]`, String(i)); p.set(`columns[${i}][searchable]`, 'true');
        p.set(`columns[${i}][orderable]`, 'true'); p.set(`columns[${i}][search][value]`, '');
      }
      const d = await fetch(BOJ_AJAX + tableId, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded' }, ua), body: p.toString(), signal: AbortSignal.timeout(20000) }).then((r) => r.json());
      for (const row of (d && d.data) || []) {
        const [dateTxt, name, buy, sell] = row;
        if (String(name).trim().toUpperCase() !== label) continue;
        const dt = new Date(dateTxt + ' UTC');
        if (isNaN(dt)) continue;
        const b = Number(buy), s = Number(sell);
        if (!(b > 0) || !(s > 0)) continue;
        const rate = use === 'buy' ? b : use === 'mid' ? (b + s) / 2 : s;
        await query(
          `INSERT INTO exchange_rates (currency, rate_date, buy, sell, rate, source)
           VALUES ($1, $2, $3, $4, $5, 'boj')
           ON CONFLICT (currency, rate_date, source) DO UPDATE SET buy = EXCLUDED.buy, sell = EXCLUDED.sell, rate = EXCLUDED.rate`,
          [code, dt.toISOString().slice(0, 10), b, s, rate]);
        saved.push({ currency: code, rate_date: dt.toISOString().slice(0, 10), buy: b, sell: s });
      }
    }
    return saved;
  }

  // Daily-ish refresh. Reading a public page is harmless even in dev mode.
  let fxTimer = null;
  function scheduleFx() {
    const run = () => fetchBoj().then((s) => { if (s.length) console.log('[fx] BOJ rates updated:', s.filter((x) => x.currency === 'USD').slice(0, 1).map((x) => x.rate_date + ' USD sell ' + x.sell).join('')); })
      .catch((e) => console.warn('[fx] BOJ fetch failed (manual rate still works):', e.message));
    setTimeout(run, 30 * 1000).unref();
    fxTimer = setInterval(run, 6 * 60 * 60 * 1000); fxTimer.unref();
  }
  scheduleFx();

  app.get('/api/inb/fx', gate, async (req, res) => {
    try {
      const out = {};
      for (const code of Object.keys(CURRENCIES)) out[code] = await effectiveRate(code);
      const { rows: history } = await query(
        `SELECT e.currency, e.rate_date, e.buy::float, e.sell::float, e.rate::float, e.source, e.note, e.created_at, u.name AS set_by_name
           FROM exchange_rates e LEFT JOIN users u ON u.id = e.set_by
          ORDER BY e.rate_date DESC, e.created_at DESC LIMIT 40`);
      res.json({ effective: out, use: await setting('fx_use', 'sell'), history });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/inb/fx/refresh', gate, cap('purchasing.settings'), async (req, res) => {
    try { res.json({ saved: await fetchBoj() }); } catch (e) { fail(res, httpError(502, 'Could not read the Bank of Jamaica rates: ' + e.message)); }
  });
  app.post('/api/inb/fx', gate, cap('purchasing.settings'), async (req, res) => {
    try {
      const b = req.body || {};
      const currency = String(b.currency || '').toUpperCase();
      if (!CURRENCIES[currency]) throw httpError(400, 'Unknown currency');
      const rate = num(b.rate);
      if (!(rate > 0)) throw httpError(400, 'Enter a rate above zero');
      const date = b.rate_date || new Date().toISOString().slice(0, 10);
      await query(
        `INSERT INTO exchange_rates (currency, rate_date, rate, source, set_by, note)
         VALUES ($1, $2, $3, 'manual', $4, $5)
         ON CONFLICT (currency, rate_date, source) DO UPDATE SET rate = EXCLUDED.rate, set_by = EXCLUDED.set_by, note = EXCLUDED.note, created_at = NOW()`,
        [currency, date, rate, req.session.userId, b.note || null]);
      res.json({ ok: true, effective: await effectiveRate(currency) });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------------- reorder --
  const REORDER_SQL = `
    WITH sales AS (
      SELECT i.product_img,
             SUM(i.qty) FILTER (WHERE s.created_at >= NOW() - INTERVAL '90 days') AS q90,
             SUM(i.qty) AS q365,
             COUNT(DISTINCT date_trunc('month', s.created_at)) AS months_sold,
             MAX(s.created_at) AS last_sold
        FROM pos_sale_items i JOIN pos_sales s ON s.id = i.sale_id
       WHERE s.created_at >= NOW() - INTERVAL '365 days' AND NOT COALESCE(s.voided, false)
         AND i.qty > 0 AND i.product_img IS NOT NULL
       GROUP BY i.product_img),
    monthly AS (
      SELECT i.product_img, date_trunc('month', s.created_at) AS m, SUM(i.qty) AS q
        FROM pos_sale_items i JOIN pos_sales s ON s.id = i.sale_id
       WHERE s.created_at >= date_trunc('month', NOW()) - INTERVAL '12 months'
         AND s.created_at < date_trunc('month', NOW())
         AND NOT COALESCE(s.voided, false) AND i.qty > 0 AND i.product_img IS NOT NULL
       GROUP BY 1, 2),
    var AS (
      SELECT product_img, sqrt(GREATEST((SUM(q*q) / 12.0) - power(SUM(q) / 12.0, 2), 0)) AS sd_month
        FROM monthly GROUP BY product_img),
    on_order AS (
      SELECT poi.product_img,
             SUM(GREATEST(COALESCE(poi.qty_ordered, poi.qty, 0) - COALESCE(poi.qty_received, 0) - COALESCE(poi.qty_cancelled, 0), 0)) AS q
        FROM purchase_order_items poi JOIN purchase_orders po ON po.id = poi.po_id
       WHERE po.status IN ('draft', 'sent', 'ordered', 'partial') AND po.created_at >= NOW() - INTERVAL '180 days'
       GROUP BY poi.product_img),
    lead AS (
      -- Real lead time once POs carry an order date; supplier setting until then.
      SELECT po.supplier_id, AVG(EXTRACT(EPOCH FROM (r.received_at - po.ordered_at)) / 86400.0) AS days, COUNT(*) AS n
        FROM receipts r JOIN purchase_orders po ON po.id = r.po_id
       WHERE r.status = 'posted' AND po.ordered_at IS NOT NULL AND r.received_at > po.ordered_at
       GROUP BY po.supplier_id),
    calc AS (
      SELECT p.img, p.sku, p.name, p.category, p.stock_count, p.cost_usd::float AS cost, p.reorder_qty,
             p.supplier_id, sup.name AS supplier_name, COALESCE(sup.currency, 'JMD') AS currency,
             ROUND(CASE WHEN ld.n >= 3 THEN ld.days ELSE COALESCE(sup.lead_time_days, 7) END)::int AS lead_days,
             COALESCE(ld.n >= 3, false) AS lead_measured,
             COALESCE(oo.q, 0)::int AS on_order, sa.q90::int, sa.q365::int, sa.months_sold::int, sa.last_sold,
             (0.5 * COALESCE(sa.q90, 0) / 90.0 + 0.5 * sa.q365 / 365.0) AS daily,
             COALESCE(v.sd_month, 0) / sqrt(30.0) AS sd_daily
        FROM sales sa
        JOIN products p ON p.img = sa.product_img
        LEFT JOIN suppliers sup ON sup.id = p.supplier_id
        LEFT JOIN lead ld ON ld.supplier_id = p.supplier_id
        LEFT JOIN var v ON v.product_img = p.img
        LEFT JOIN on_order oo ON oo.product_img = p.img
       WHERE sa.q365 >= $3 AND ($4::int IS NULL OR p.supplier_id = $4) AND NOT p.discontinued AND p.superseded_by IS NULL AND p.variant_of IS NULL),   -- Phase 9: never reorder these
    pts AS (
      SELECT c.*,
             CEIL(c.daily * c.lead_days + $2 * c.sd_daily * sqrt(GREATEST(c.lead_days, 1)))::int AS reorder_point,
             CEIL(c.daily * (c.lead_days + $1) + $2 * c.sd_daily * sqrt(GREATEST(c.lead_days + $1, 1)))::int AS target
        FROM calc c)
    SELECT pts.*,
           (SELECT poi.unit_cost_usd::float FROM purchase_order_items poi JOIN purchase_orders po ON po.id = poi.po_id
             WHERE poi.product_img = pts.img AND po.supplier_id IS NOT DISTINCT FROM pts.supplier_id AND poi.unit_cost_usd > 0
               -- Only a price quoted in the supplier's current currency: after a
               -- supplier is switched to US$, its old J$ PO prices must not be
               -- read as dollars.
               AND COALESCE(po.currency, 'JMD') = pts.currency
             ORDER BY po.created_at DESC LIMIT 1) AS last_po_cost
      FROM pts
     WHERE pts.stock_count + pts.on_order <= pts.reorder_point
     ORDER BY pts.supplier_name NULLS LAST, pts.daily DESC
     LIMIT 3000`;

  app.get('/api/inb/reorder', gate, cap('purchasing.create_po'), async (req, res) => {
    try {
      const review = num(await setting('reorder_review_days', '14'), 14);
      const z = num(await setting('reorder_service_z', '1.65'), 1.65);
      const minSales = Math.max(1, parseInt(req.query.min_sales, 10) || 2);
      const sup = req.query.supplier_id ? parseInt(req.query.supplier_id, 10) : null;
      const { rows } = await queryCapped(REORDER_SQL, [review, z, minSales, sup], 60000);
      const usd = await effectiveRate('USD');
      const out = rows.map((r) => {
        let qty = Math.max(r.target - (r.stock_count + r.on_order), 1);
        if (r.reorder_qty > 1) qty = Math.ceil(qty / r.reorder_qty) * r.reorder_qty;   // pack / minimum order multiple
        const unitCost = r.last_po_cost != null ? r.last_po_cost
          : (r.currency === 'JMD' ? r.cost : (r.cost && usd && r.currency === 'USD' ? round(r.cost / usd.rate, 2) : null));
        return {
          img: r.img, sku: r.sku, name: r.name, category: r.category, supplier_id: r.supplier_id, supplier_name: r.supplier_name,
          currency: r.currency, on_hand: r.stock_count, on_order: r.on_order, sold_90d: r.q90 || 0, sold_365d: r.q365,
          months_sold: r.months_sold, per_month: round(r.daily * 30, 1), lead_days: r.lead_days, lead_measured: r.lead_measured,
          reorder_point: r.reorder_point, target: r.target, suggested_qty: qty, unit_cost: unitCost,
          last_sold: r.last_sold, pack: r.reorder_qty || null,
        };
      });
      res.json({ settings: { review_days: review, service_z: z, min_sales: minSales }, lines: out });
    } catch (e) { fail(res, e); }
  });

  async function nextPoNumber(c) {
    const year = new Date().getFullYear();
    const { rows } = await c.query(
      `SELECT COALESCE(MAX(NULLIF(substring(po_number FROM $1), '')::int), 0) AS n FROM purchase_orders WHERE po_number LIKE $2`,
      [`^PO-${year}-(\\d+)$`, `PO-${year}-%`]);
    return `PO-${year}-${String(rows[0].n + 1).padStart(4, '0')}`;
  }

  // {lines:[{img, qty, supplier_id, unit_cost}]} -> one draft PO per supplier
  app.post('/api/inb/reorder/draft-pos', gate, cap('purchasing.create_po'), async (req, res) => {
    try {
      const lines = Array.isArray(req.body && req.body.lines) ? req.body.lines : [];
      const clean = lines.map((l) => ({ img: String(l.img || ''), qty: parseInt(l.qty, 10), supplier_id: l.supplier_id ? parseInt(l.supplier_id, 10) : null, unit_cost: l.unit_cost == null || l.unit_cost === '' ? null : num(l.unit_cost) }))
        .filter((l) => l.img && l.qty > 0);
      if (!clean.length) throw httpError(400, 'Choose at least one line with a quantity');
      if (clean.some((l) => !l.supplier_id)) throw httpError(400, 'Every line needs a supplier. Set the part\'s supplier first.');
      const bySup = new Map();
      for (const l of clean) { if (!bySup.has(l.supplier_id)) bySup.set(l.supplier_id, []); bySup.get(l.supplier_id).push(l); }
      const created = await tx(async (c) => {
        const out = [];
        for (const [supId, ls] of bySup) {
          const { rows: s } = await c.query('SELECT id, name, COALESCE(currency, \'JMD\') AS currency, lead_time_days FROM suppliers WHERE id = $1', [supId]);
          if (!s.length) throw httpError(404, 'Supplier ' + supId + ' not found');
          const poNum = await nextPoNumber(c);
          const { rows: po } = await c.query(
            `INSERT INTO purchase_orders (po_number, supplier_id, status, currency, origin, created_by, expected_date, notes)
             VALUES ($1, $2, 'draft', $3, 'reorder', $4, CURRENT_DATE + COALESCE($5, 7), 'Drafted from reorder suggestions')
             RETURNING id`, [poNum, supId, s[0].currency, req.session.userId, s[0].lead_time_days]);
          for (const l of ls) {
            const { rows: p } = await c.query('SELECT id, sku, name FROM products WHERE img = $1', [l.img]);
            if (!p.length) continue;
            const cost = l.unit_cost != null ? l.unit_cost : 0;
            await c.query(
              `INSERT INTO purchase_order_items (po_id, product_img, product_id, sku, description, qty_ordered, unit_cost_usd, total_usd, condition)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'NEW')`,
              [po[0].id, l.img, p[0].id, p[0].sku, p[0].name, l.qty, cost, round(l.qty * cost, 2)]);
          }
          await c.query(
            `UPDATE purchase_orders SET subtotal_usd = t.s, total_usd = t.s + COALESCE(shipping_usd,0) + COALESCE(tax_usd,0)
               FROM (SELECT COALESCE(SUM(total_usd),0) AS s FROM purchase_order_items WHERE po_id = $1) t WHERE id = $1`, [po[0].id]);
          out.push({ id: po[0].id, po_number: poNum, supplier: s[0].name, currency: s[0].currency, lines: ls.length });
        }
        return out;
      });
      res.json({ created });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/inb/suppliers', gate, async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT s.id, s.name, s.code, COALESCE(s.currency,'JMD') AS currency, s.lead_time_days, s.payment_terms, s.is_active,
                (SELECT COUNT(*) FROM products p WHERE p.supplier_id = s.id)::int AS products
           FROM suppliers s WHERE s.is_active ORDER BY s.name`);
      res.json({ suppliers: rows });
    } catch (e) { fail(res, e); }
  });
  app.patch('/api/inb/suppliers/:id', gate, cap('purchasing.settings'), async (req, res) => {
    try {
      const b = req.body || {};
      const sets = [], vals = [];
      if (b.currency !== undefined) {
        const cur = String(b.currency).toUpperCase();
        if (cur !== 'JMD' && !CURRENCIES[cur]) throw httpError(400, 'Unknown currency');
        vals.push(cur); sets.push(`currency = $${vals.length}`);
      }
      if (b.lead_time_days !== undefined) {
        const d = parseInt(b.lead_time_days, 10);
        if (!(d >= 0 && d <= 365)) throw httpError(400, 'Lead time must be 0 to 365 days');
        vals.push(d); sets.push(`lead_time_days = $${vals.length}`);
      }
      if (!sets.length) throw httpError(400, 'Nothing to change');
      vals.push(req.params.id);
      const { rows } = await query(`UPDATE suppliers SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING id, name, currency, lead_time_days`, vals);
      if (!rows.length) throw httpError(404, 'Supplier not found');
      res.json({ supplier: rows[0] });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/inb/settings', gate, async (req, res) => {
    try {
      const { rows } = await query("SELECT key, value FROM warehouse_settings WHERE key IN ('reorder_review_days','reorder_service_z','fx_use','bill_tolerance_pct')");
      res.json(Object.fromEntries(rows.map((r) => [r.key, r.value])));
    } catch (e) { fail(res, e); }
  });
  app.patch('/api/inb/settings', gate, cap('purchasing.settings'), async (req, res) => {
    try {
      const b = req.body || {};
      const allowed = {
        reorder_review_days: (v) => { const n = parseInt(v, 10); if (!(n >= 1 && n <= 180)) throw httpError(400, 'Review period must be 1 to 180 days'); return String(n); },
        reorder_service_z: (v) => { const n = num(v, -1); if (!(n >= 0 && n <= 3.5)) throw httpError(400, 'Service factor must be 0 to 3.5'); return String(n); },
        fx_use: (v) => { if (!['buy', 'sell', 'mid'].includes(v)) throw httpError(400, 'Use buy, sell or mid'); return v; },
        bill_tolerance_pct: (v) => { const n = num(v, -1); if (!(n >= 0 && n <= 20)) throw httpError(400, 'Tolerance must be 0 to 20%'); return String(n); },
      };
      for (const [k, fn] of Object.entries(allowed)) {
        if (b[k] === undefined) continue;
        await query('INSERT INTO warehouse_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [k, fn(b[k])]);
      }
      const { rows } = await query("SELECT key, value FROM warehouse_settings WHERE key IN ('reorder_review_days','reorder_service_z','fx_use','bill_tolerance_pct')");
      res.json(Object.fromEntries(rows.map((r) => [r.key, r.value])));
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------------- pricing --
  async function ruleFor(category, q = query) {
    const { rows } = await q(
      `SELECT markup_pct::float, round_to::float, min_margin_pct::float, never_lower FROM pricing_rules
        WHERE is_active AND (lower(category) = lower($1) OR category IS NULL)
        ORDER BY (category IS NULL) LIMIT 1`, [category || '']);
    return rows[0] || null;
  }
  function suggestPrice(cost, rule, currentPrice) {
    if (!rule || !(cost > 0)) return null;
    let p = cost * (1 + rule.markup_pct / 100);
    if (rule.min_margin_pct != null && rule.min_margin_pct < 100) p = Math.max(p, cost / (1 - rule.min_margin_pct / 100));
    const step = rule.round_to > 0 ? rule.round_to : 0.01;
    p = Math.ceil(round(p / step, 6)) * step;
    if (rule.never_lower && currentPrice > 0 && p < currentPrice) p = currentPrice;
    return round(p, 2);
  }

  app.get('/api/inb/pricing-rules', gate, async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT r.id, r.category, r.markup_pct::float, r.round_to::float, r.min_margin_pct::float, r.never_lower, r.is_active, r.updated_at, u.name AS updated_by_name
           FROM pricing_rules r LEFT JOIN users u ON u.id = r.updated_by ORDER BY r.category NULLS FIRST`);
      res.json({ rules: rows });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/inb/pricing-rules', gate, cap('purchasing.settings'), async (req, res) => {
    try {
      const b = req.body || {};
      const markup = num(b.markup_pct, NaN);
      if (!(markup >= 0 && markup <= 1000)) throw httpError(400, 'Markup must be 0 to 1000%');
      const roundTo = b.round_to === '' || b.round_to == null ? 10 : num(b.round_to, -1);
      if (!(roundTo >= 0)) throw httpError(400, 'Rounding must be zero or more');
      const minM = b.min_margin_pct === '' || b.min_margin_pct == null ? null : num(b.min_margin_pct, NaN);
      if (minM != null && !(minM >= 0 && minM < 100)) throw httpError(400, 'Minimum margin must be 0 to 99%');
      const category = b.category ? String(b.category).trim() : null;
      const { rows } = await query(
        `INSERT INTO pricing_rules (category, markup_pct, round_to, min_margin_pct, never_lower, is_active, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT ((COALESCE(lower(category), ''))) DO UPDATE
           SET markup_pct = EXCLUDED.markup_pct, round_to = EXCLUDED.round_to, min_margin_pct = EXCLUDED.min_margin_pct,
               never_lower = EXCLUDED.never_lower, is_active = EXCLUDED.is_active, updated_by = EXCLUDED.updated_by, updated_at = NOW()
         RETURNING id`, [category, markup, roundTo, minM, b.never_lower !== false, b.is_active !== false, req.session.userId]);
      res.json({ ok: true, id: rows[0].id });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------------ receiving --
  const RECEIVABLE = "('draft','sent','ordered','partial')";

  app.get('/api/inb/receivable', gate, cap('purchasing.receive'), async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      const { rows } = await query(
        `SELECT po.id, po.po_number, po.status, po.currency, po.created_at, po.expected_date, s.name AS supplier_name,
                SUM(GREATEST(COALESCE(i.qty_ordered, i.qty, 0) - COALESCE(i.qty_received, 0) - i.qty_cancelled, 0))::int AS outstanding,
                COUNT(i.id)::int AS lines,
                (SELECT r.id FROM receipts r WHERE r.po_id = po.id AND r.status = 'open' ORDER BY r.id DESC LIMIT 1) AS open_receipt_id
           FROM purchase_orders po
           JOIN purchase_order_items i ON i.po_id = po.id
           LEFT JOIN suppliers s ON s.id = po.supplier_id
          WHERE po.status IN ${RECEIVABLE}
            AND ($1 = '' OR po.po_number ILIKE $2 OR s.name ILIKE $2)
          GROUP BY po.id, s.name
         HAVING SUM(GREATEST(COALESCE(i.qty_ordered, i.qty, 0) - COALESCE(i.qty_received, 0) - i.qty_cancelled, 0)) > 0
          ORDER BY po.created_at DESC LIMIT 100`, [q, '%' + q + '%']);
      res.json({ purchase_orders: rows });
    } catch (e) { fail(res, e); }
  });

  // Mark a PO as sent to the supplier: starts the measured lead time.
  app.post('/api/inb/po/:id/mark-ordered', gate, cap('purchasing.create_po'), async (req, res) => {
    try {
      const { rows } = await query(
        `UPDATE purchase_orders SET status = 'ordered', ordered_at = COALESCE(ordered_at, NOW())
          WHERE id = $1 AND status IN ('draft','sent') RETURNING id, po_number, status, ordered_at`, [req.params.id]);
      if (!rows.length) throw httpError(409, 'Only a draft PO can be marked as ordered');
      res.json({ purchase_order: rows[0] });
    } catch (e) { fail(res, e); }
  });

  async function receiptDetail(id, q = query) {
    const { rows: r } = await q(
      `SELECT r.*, r.fx_rate::float AS fx_rate, r.freight::float AS freight, r.duty::float AS duty, r.customs::float AS customs,
              r.brokerage::float AS brokerage, r.other_costs::float AS other_costs, r.supplier_invoice_total::float AS supplier_invoice_total,
              r.bill_amount_jmd::float AS bill_amount_jmd, po.po_number, s.name AS supplier_name, b.code AS receiving_bin,
              ru.name AS received_by_name, pu.name AS posted_by_name, cu.name AS bill_confirmed_by_name
         FROM receipts r
         LEFT JOIN purchase_orders po ON po.id = r.po_id
         LEFT JOIN suppliers s ON s.id = r.supplier_id
         LEFT JOIN bins b ON b.id = r.receiving_bin_id
         LEFT JOIN users ru ON ru.id = r.received_by
         LEFT JOIN users pu ON pu.id = r.posted_by
         LEFT JOIN users cu ON cu.id = r.bill_confirmed_by
        WHERE r.id = $1`, [id]);
    if (!r.length) throw httpError(404, 'Receipt not found');
    const { rows: lines } = await q(
      `SELECT l.*, l.unit_cost::float AS unit_cost, l.landed_unit_cost::float AS landed_unit_cost,
              l.old_avg_cost::float AS old_avg_cost, l.new_avg_cost::float AS new_avg_cost, l.old_price::float AS old_price,
              l.suggested_price::float AS suggested_price, l.new_price::float AS new_price,
              p.sku, p.name, p.category, p.stock_count, p.price_usd::float AS current_price, p.cost_usd::float AS current_cost,
              wh_norm_bin(p.bin_location) AS primary_bin,
              COALESCE(i.qty_ordered, i.qty) AS qty_ordered, i.qty_received AS po_qty_received, i.qty_cancelled AS po_qty_cancelled,
              i.unit_cost_usd::float AS po_unit_cost
         FROM receipt_lines l
         LEFT JOIN products p ON p.img = l.product_img
         LEFT JOIN purchase_order_items i ON i.id = l.po_item_id
        WHERE l.receipt_id = $1 ORDER BY l.id`, [id]);
    return Object.assign(r[0], { lines });
  }

  // Start receiving a PO (or resume its open receipt).
  app.post('/api/inb/receipts', gate, cap('purchasing.receive'), async (req, res) => {
    try {
      const poId = parseInt((req.body || {}).po_id, 10);
      if (!poId) throw httpError(400, 'Which purchase order?');
      const id = await tx(async (c) => {
        const { rows: po } = await c.query(`SELECT * FROM purchase_orders WHERE id = $1 FOR UPDATE`, [poId]);
        if (!po.length) throw httpError(404, 'PO not found');
        if (!['draft', 'sent', 'ordered', 'partial'].includes(po[0].status)) throw httpError(409, 'This PO is ' + po[0].status + ' and cannot be received');
        const { rows: open } = await c.query(`SELECT id FROM receipts WHERE po_id = $1 AND status = 'open'`, [poId]);
        if (open.length) return open[0].id;
        const fx = await effectiveRate(po[0].currency || 'JMD', null, c.query.bind(c));
        if (!fx) throw httpError(409, 'No exchange rate for ' + po[0].currency + ' yet. Set one under Office > Exchange rate.');
        const { rows: binR } = await c.query(`SELECT id FROM bins WHERE upper(code) = 'RECEIVING'`);
        const { rows: sup } = await c.query(`SELECT payment_terms FROM suppliers WHERE id = $1`, [po[0].supplier_id]);
        const terms = sup.length && /(\d+)/.exec(sup[0].payment_terms || '') ? parseInt(/(\d+)/.exec(sup[0].payment_terms)[1], 10) : null;
        const { rows: r } = await c.query(
          `INSERT INTO receipts (po_id, supplier_id, currency, fx_rate, fx_source, receiving_bin_id, received_by, payment_terms_days)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [poId, po[0].supplier_id, po[0].currency || 'JMD', fx.rate, fx.source + (fx.rate_date ? ' ' + new Date(fx.rate_date).toISOString().slice(0, 10) : ''),
           binR.length ? binR[0].id : null, req.session.userId, terms]);
        await c.query(`UPDATE receipts SET receipt_number = 'GRN-' || to_char(NOW(), 'YYYY') || '-' || lpad(id::text, 5, '0') WHERE id = $1`, [r[0].id]);
        // One line per outstanding PO line, counted from zero.
        await c.query(
          `INSERT INTO receipt_lines (receipt_id, po_item_id, product_img, unit_cost, qty_received)
           SELECT $1, i.id, i.product_img, i.unit_cost_usd, 0 FROM purchase_order_items i
            WHERE i.po_id = $2 AND COALESCE(i.qty_ordered, i.qty, 0) - COALESCE(i.qty_received, 0) - i.qty_cancelled > 0
            ORDER BY i.id`, [r[0].id, poId]);
        return r[0].id;
      });
      res.json({ receipt: await receiptDetail(id) });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/inb/receipts', gate, async (req, res) => {
    try {
      const st = ['open', 'posted', 'void'].includes(req.query.status) ? req.query.status : null;
      const { rows } = await query(
        `SELECT r.id, r.receipt_number, r.status, r.bill_status, r.received_at, r.posted_at, r.currency, po.po_number, s.name AS supplier_name,
                u.name AS received_by_name,
                (SELECT COALESCE(SUM(qty_received),0) FROM receipt_lines l WHERE l.receipt_id = r.id)::int AS units,
                (SELECT COALESCE(SUM(GREATEST(qty_received - qty_putaway, 0)),0) FROM receipt_lines l WHERE l.receipt_id = r.id)::int AS to_put_away
           FROM receipts r LEFT JOIN purchase_orders po ON po.id = r.po_id LEFT JOIN suppliers s ON s.id = r.supplier_id
           LEFT JOIN users u ON u.id = r.received_by
          WHERE ($1::text IS NULL OR r.status = $1)
          ORDER BY r.id DESC LIMIT 100`, [st]);
      res.json({ receipts: rows });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/inb/receipts/:id', gate, async (req, res) => {
    try { res.json({ receipt: await receiptDetail(req.params.id) }); } catch (e) { fail(res, e); }
  });

  const HEADER_FIELDS = {
    fx_rate: 'num', freight: 'num', duty: 'num', customs: 'num', brokerage: 'num', other_costs: 'num',
    allocation_method: 'enum', supplier_invoice_number: 'text', supplier_invoice_date: 'date',
    supplier_invoice_total: 'num', payment_terms_days: 'int', notes: 'text',
  };
  const AFTER_POST_OK = new Set(['supplier_invoice_number', 'supplier_invoice_date', 'supplier_invoice_total', 'payment_terms_days', 'notes']);

  app.patch('/api/inb/receipts/:id', gate, cap('purchasing.receive'), async (req, res) => {
    try {
      const b = req.body || {};
      const { rows: cur } = await query('SELECT status, bill_status FROM receipts WHERE id = $1', [req.params.id]);
      if (!cur.length) throw httpError(404, 'Receipt not found');
      const sets = [], vals = [];
      for (const [k, kind] of Object.entries(HEADER_FIELDS)) {
        if (b[k] === undefined) continue;
        if (cur[0].status !== 'open' && !AFTER_POST_OK.has(k)) throw httpError(409, 'The receipt is posted; costs can no longer change');
        if (cur[0].bill_status === 'confirmed' && AFTER_POST_OK.has(k) && k !== 'notes') throw httpError(409, 'The bill is confirmed; reopen it first');
        let v = b[k];
        if (v === '' || v === null) v = null;
        else if (kind === 'num') { v = num(v, NaN); if (!Number.isFinite(v) || v < 0) throw httpError(400, k + ' must be a positive number'); }
        else if (kind === 'int') { v = parseInt(v, 10); if (!(v >= 0)) throw httpError(400, k + ' must be a whole number'); }
        else if (kind === 'enum') { if (!['value', 'qty'].includes(v)) throw httpError(400, 'Allocate by value or qty'); }
        if (k === 'fx_rate' && !(v > 0)) throw httpError(400, 'Exchange rate must be above zero');
        if (['freight', 'duty', 'customs', 'brokerage', 'other_costs'].includes(k) && v == null) v = 0;
        vals.push(v); sets.push(`${k} = $${vals.length}`);
      }
      if (b.fx_rate !== undefined) { vals.push('manual'); sets.push(`fx_source = $${vals.length}`); }
      if (!sets.length) throw httpError(400, 'Nothing to change');
      vals.push(req.params.id);
      await query(`UPDATE receipts SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
      res.json({ receipt: await receiptDetail(req.params.id) });
    } catch (e) { fail(res, e); }
  });

  app.patch('/api/inb/receipts/:id/lines/:lineId', gate, cap('purchasing.receive'), async (req, res) => {
    try {
      const b = req.body || {};
      const { rows: cur } = await query('SELECT status FROM receipts WHERE id = $1', [req.params.id]);
      if (!cur.length) throw httpError(404, 'Receipt not found');
      if (cur[0].status !== 'open') throw httpError(409, 'This receipt is already posted');
      const sets = [], vals = [];
      for (const k of ['qty_received', 'qty_damaged']) {
        if (b[k] === undefined) continue;
        const v = parseInt(b[k], 10);
        if (!(v >= 0 && v <= 100000)) throw httpError(400, 'Quantities must be 0 or more');
        vals.push(v); sets.push(`${k} = $${vals.length}`);
      }
      if (b.unit_cost !== undefined) { const v = num(b.unit_cost, NaN); if (!(v >= 0)) throw httpError(400, 'Unit cost must be 0 or more'); vals.push(v); sets.push(`unit_cost = $${vals.length}`); }
      if (b.notes !== undefined) { vals.push(b.notes || null); sets.push(`notes = $${vals.length}`); }
      if (!sets.length) throw httpError(400, 'Nothing to change');
      vals.push(req.params.lineId, req.params.id);
      const { rowCount } = await query(`UPDATE receipt_lines SET ${sets.join(', ')} WHERE id = $${vals.length - 1} AND receipt_id = $${vals.length}`, vals);
      if (!rowCount) throw httpError(404, 'Line not found');
      res.json({ receipt: await receiptDetail(req.params.id) });
    } catch (e) { fail(res, e); }
  });

  // Count by scanning: each scan of a part adds 1 to its line. A part that is
  // not on the PO is added as an extra line (supplier sent something else).
  app.post('/api/inb/receipts/:id/scan', gate, cap('purchasing.receive'), async (req, res) => {
    try {
      const raw = String((req.body || {}).code || '').trim().replace(/^(ITEM|SKU):/i, '');
      const step = parseInt((req.body || {}).qty, 10) || 1;
      if (!raw) throw httpError(400, 'Nothing scanned');
      const out = await tx(async (c) => {
        const { rows: r } = await c.query('SELECT id, status, currency, fx_rate::float AS fx FROM receipts WHERE id = $1 FOR UPDATE', [req.params.id]);
        if (!r.length) throw httpError(404, 'Receipt not found');
        if (r[0].status !== 'open') throw httpError(409, 'This receipt is already posted');
        const { rows: p } = await c.query(
          'SELECT img, sku, name, cost_usd::float AS cost FROM products WHERE upper(sku) = upper($1) OR upper(barcode) = upper($1) OR img = $1 LIMIT 1', [raw]);
        if (!p.length) throw httpError(404, 'No part matches "' + raw + '"');
        const { rows: line } = await c.query('SELECT id FROM receipt_lines WHERE receipt_id = $1 AND product_img = $2 ORDER BY id LIMIT 1', [r[0].id, p[0].img]);
        if (line.length) {
          await c.query('UPDATE receipt_lines SET qty_received = GREATEST(qty_received + $2, 0) WHERE id = $1', [line[0].id, step]);
          return { sku: p[0].sku, added_line: false };
        }
        const unit = r[0].currency === 'JMD' ? p[0].cost : (p[0].cost && r[0].fx ? round(p[0].cost / r[0].fx, 4) : null);
        await c.query('INSERT INTO receipt_lines (receipt_id, product_img, unit_cost, qty_received, notes) VALUES ($1, $2, $3, $4, $5)',
          [r[0].id, p[0].img, unit, Math.max(step, 0), 'Not on the PO']);
        return { sku: p[0].sku, added_line: true };
      });
      res.json(Object.assign(out, { receipt: await receiptDetail(req.params.id) }));
    } catch (e) { fail(res, e); }
  });

  // Landed cost + average cost + suggested price per line. Pure calculation:
  // used by the preview and by posting, so both always agree.
  async function costReceipt(r, q) {
    const extras = num(r.freight) + num(r.duty) + num(r.customs) + num(r.brokerage) + num(r.other_costs);
    const lines = r.lines.filter((l) => l.qty_received > 0 && l.product_img);
    const base = lines.map((l) => r.allocation_method === 'qty' ? l.qty_received : num(l.unit_cost) * r.fx_rate * l.qty_received);
    const sumBase = base.reduce((s, x) => s + x, 0);
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const alloc = sumBase > 0 ? extras * base[i] / sumBase : (lines.length ? extras / lines.length : 0);
      const landed = num(l.unit_cost) * r.fx_rate + alloc / l.qty_received;
      const { rows: p } = await q('SELECT stock_count, cost_usd::float AS cost, price_usd::float AS price, category FROM products WHERE img = $1', [l.product_img]);
      const pr = p[0] || {};
      const oldQty = Math.max(num(pr.stock_count), 0);
      const oldCost = num(pr.cost);
      const newAvg = oldQty > 0 && oldCost > 0 ? (oldQty * oldCost + l.qty_received * landed) / (oldQty + l.qty_received) : landed;
      const rule = await ruleFor(pr.category, q);
      out.push({
        line_id: l.id, product_img: l.product_img, qty: l.qty_received,
        allocated_extras: round(alloc, 2), landed_unit_cost: round(landed, 4),
        old_avg_cost: oldCost || null, new_avg_cost: round(newAvg, 4),
        old_price: pr.price || null, suggested_price: suggestPrice(newAvg, rule, pr.price),
        margin_at_current_price: pr.price > 0 ? round((pr.price - newAvg) / pr.price * 100, 1) : null,
      });
    }
    return { extras: round(extras, 2), lines: out };
  }

  app.get('/api/inb/receipts/:id/preview', gate, cap('purchasing.receive'), async (req, res) => {
    try {
      const r = await receiptDetail(req.params.id);
      res.json(Object.assign({ receipt_id: r.id }, await costReceipt(r, query)));
    } catch (e) { fail(res, e); }
  });

  // Post: stock into RECEIVING, average cost, chosen prices, PO roll-up,
  // batch codes. {prices: {<lineId>: {action: 'keep'|'suggested'|'custom', price}}}
  app.post('/api/inb/receipts/:id/post', gate, cap('purchasing.receive'), async (req, res) => {
    try {
      const prices = (req.body && req.body.prices) || {};
      const canPrice = await userCanCap(req, 'inventory.edit_price');
      const warnings = [];
      await tx(async (c) => {
        const qc = c.query.bind(c);
        const { rows: lock } = await c.query('SELECT status FROM receipts WHERE id = $1 FOR UPDATE', [req.params.id]);
        if (!lock.length) throw httpError(404, 'Receipt not found');
        if (lock[0].status !== 'open') throw httpError(409, 'This receipt is already posted');
        const r = await receiptDetail(req.params.id, qc);
        if (!r.lines.some((l) => l.qty_received > 0 || l.qty_damaged > 0)) throw httpError(400, 'Nothing has been counted yet');
        for (const l of r.lines) if (l.product_img) await c.query('SELECT 1 FROM products WHERE img = $1 FOR UPDATE', [l.product_img]);
        const costed = await costReceipt(r, qc);
        const byLine = new Map(costed.lines.map((x) => [x.line_id, x]));
        const binId = r.receiving_bin_id;
        for (const l of r.lines) {
          const k = byLine.get(l.id);
          let newPrice = null, action = null;
          if (k) {
            const choice = prices[l.id] || prices[String(l.id)] || { action: 'keep' };
            if (choice.action === 'suggested' && k.suggested_price) newPrice = k.suggested_price;
            if (choice.action === 'custom' && num(choice.price) > 0) newPrice = round(num(choice.price), 2);
            if (newPrice != null && !canPrice) { warnings.push(l.sku + ': price not changed (no permission)'); newPrice = null; }
            action = newPrice != null && newPrice !== k.old_price ? 'updated' : 'kept';
            await c.query("SELECT set_config('vision.stock_reason', 'receipt', true)");   // stock ledger: why it moved (GL)
            await c.query(
              `UPDATE products SET stock_count = stock_count + $2, cost_usd = $3, costing_method = 'average'
                    ${newPrice != null ? ', price_usd = $4' : ''}
                WHERE img = $1`, newPrice != null ? [l.product_img, k.qty, round(k.new_avg_cost, 2), newPrice] : [l.product_img, k.qty, round(k.new_avg_cost, 2)]);
            if (binId) {
              await c.query(
                `INSERT INTO stock_by_bin (product_img, bin_id, qty) VALUES ($1, $2, $3)
                 ON CONFLICT (product_img, bin_id) DO UPDATE SET qty = stock_by_bin.qty + EXCLUDED.qty, updated_at = NOW()`,
                [l.product_img, binId, k.qty]);
            }
          }
          await c.query(
            `UPDATE receipt_lines SET batch_code = 'B' || id, landed_unit_cost = $2, old_avg_cost = $3, new_avg_cost = $4,
                    old_price = $5, suggested_price = $6, new_price = $7, price_action = $8
              WHERE id = $1`,
            [l.id, k ? k.landed_unit_cost : null, k ? k.old_avg_cost : null, k ? k.new_avg_cost : null,
             k ? k.old_price : null, k ? k.suggested_price : null, newPrice, action]);
          if (l.po_item_id) {
            await c.query('UPDATE purchase_order_items SET qty_received = COALESCE(qty_received, 0) + $2 WHERE id = $1',
              [l.po_item_id, l.qty_received + l.qty_damaged]);
          }
          if (k || l.qty_damaged) {
            await c.query(
              `INSERT INTO warehouse_activity (kind, ref_kind, ref_id, product_img, performed_by, qty_delta, bin_location, bin_id, notes)
               VALUES ('receive', 'receipt_line', $1, $2, $3, $4, $5, $6, $7)`,
              [l.id, l.product_img, req.session.userId, k ? k.qty : 0, r.receiving_bin, binId,
               r.receipt_number + (l.qty_damaged ? ' | ' + l.qty_damaged + ' damaged' : '') + (action === 'updated' ? ' | price ' + k.old_price + ' -> ' + newPrice : '')]);
          }
        }
        // PO: received when nothing is outstanding, otherwise partial (backorder).
        if (r.po_id) {
          const { rows: rem } = await c.query(
            `SELECT COALESCE(SUM(GREATEST(COALESCE(qty_ordered, qty, 0) - COALESCE(qty_received, 0) - qty_cancelled, 0)), 0)::int AS r
               FROM purchase_order_items WHERE po_id = $1`, [r.po_id]);
          await c.query(
            `UPDATE purchase_orders SET status = $2, received_date = COALESCE(received_date, NOW()), received_at = NOW() WHERE id = $1`,
            [r.po_id, rem[0].r > 0 ? 'partial' : 'received']);
        }
        await c.query(`UPDATE receipts SET status = 'posted', posted_by = $2, posted_at = NOW() WHERE id = $1`, [r.id, req.session.userId]);
      }, true);
      res.json({ ok: true, warnings, receipt: await receiptDetail(req.params.id) });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/inb/receipts/:id/void', gate, cap('purchasing.receive'), async (req, res) => {
    try {
      const { rows } = await query(`UPDATE receipts SET status = 'void' WHERE id = $1 AND status = 'open' RETURNING id`, [req.params.id]);
      if (!rows.length) throw httpError(409, 'Only an open receipt can be cancelled');
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // --------------------------------------------------------------- bills --
  const BILL_SQL = `
    SELECT r.id, r.receipt_number, r.bill_status, r.currency, r.fx_rate::float AS fx_rate, r.posted_at,
           r.supplier_invoice_number, r.supplier_invoice_date, r.supplier_invoice_total::float AS invoice_total,
           r.payment_terms_days, r.due_date, r.bill_amount_jmd::float AS bill_amount_jmd, r.bill_variance_note,
           r.bill_confirmed_at, cu.name AS confirmed_by_name, po.id AS po_id, po.po_number, s.name AS supplier_name,
           (SELECT COALESCE(SUM((l.qty_received + l.qty_damaged) * l.unit_cost), 0) FROM receipt_lines l WHERE l.receipt_id = r.id)::float AS received_value,
           (SELECT COALESCE(SUM((l.qty_received + l.qty_damaged) * COALESCE(i.unit_cost_usd, l.unit_cost)), 0)
              FROM receipt_lines l LEFT JOIN purchase_order_items i ON i.id = l.po_item_id WHERE l.receipt_id = r.id)::float AS po_value,
           (SELECT COALESCE(SUM(l.qty_damaged), 0) FROM receipt_lines l WHERE l.receipt_id = r.id)::int AS damaged_units
      FROM receipts r
      LEFT JOIN purchase_orders po ON po.id = r.po_id
      LEFT JOIN suppliers s ON s.id = r.supplier_id
      LEFT JOIN users cu ON cu.id = r.bill_confirmed_by
     WHERE r.status = 'posted'`;

  function billChecks(b, tolPct) {
    const inv = b.invoice_total;
    const diffRecv = inv != null ? inv - b.received_value : null;
    const diffPo = round(b.received_value - b.po_value, 2);
    const pct = inv != null && b.received_value > 0 ? Math.abs(diffRecv) / b.received_value * 100 : null;
    return Object.assign(b, {
      variance: diffRecv == null ? null : round(diffRecv, 2), variance_pct: pct == null ? null : round(pct, 2),
      price_vs_po: diffPo, within_tolerance: pct != null && pct <= tolPct && Math.abs(diffPo) < 0.01,
    });
  }

  app.get('/api/inb/bills', gate, async (req, res) => {
    try {
      const st = ['pending', 'confirmed', 'disputed'].includes(req.query.status) ? req.query.status : 'pending';
      const tol = num(await setting('bill_tolerance_pct', '1'), 1);
      const { rows } = await query(BILL_SQL + ' AND r.bill_status = $1 ORDER BY r.posted_at DESC LIMIT 200', [st]);
      res.json({ tolerance_pct: tol, bills: rows.map((b) => billChecks(b, tol)) });
    } catch (e) { fail(res, e); }
  });

  // The PO keeps the payables roll-up the existing payables report reads:
  // invoice_total_usd = J$ total of the confirmed bills against it.
  async function rollupPoBills(c, poId) {
    await c.query(
      `UPDATE purchase_orders po SET
          invoice_total_usd  = t.total,
          invoice_number     = t.numbers,
          invoice_date       = t.first_date,
          payment_terms_days = COALESCE(t.terms, po.payment_terms_days)
         FROM (SELECT SUM(bill_amount_jmd) AS total,
                      string_agg(DISTINCT supplier_invoice_number, ', ') AS numbers,
                      MIN(supplier_invoice_date) AS first_date, MAX(payment_terms_days) AS terms
                 FROM receipts WHERE po_id = $1 AND bill_status = 'confirmed') t
        WHERE po.id = $1`, [poId]);
    const run = c.query.bind(c);
    if (recalcPoDueDate) await recalcPoDueDate(poId, run);
    if (recalcPoPaid) await recalcPoPaid(poId, run);
  }

  app.post('/api/inb/bills/:id/confirm', gate, cap('purchasing.approve_bills'), async (req, res) => {
    try {
      const note = String((req.body || {}).note || '').trim();
      const tol = num(await setting('bill_tolerance_pct', '1'), 1);
      await tx(async (c) => {
        const { rows } = await c.query(BILL_SQL + ' AND r.id = $1 FOR UPDATE OF r', [req.params.id]);
        if (!rows.length) throw httpError(404, 'Bill not found (receive and post the goods first)');
        const b = billChecks(rows[0], tol);
        if (b.bill_status === 'confirmed') throw httpError(409, 'Already confirmed');
        if (!b.supplier_invoice_number || b.invoice_total == null) throw httpError(400, 'Enter the supplier\'s invoice number and total first');
        if (!b.within_tolerance && note.length < 5) throw httpError(400, 'The invoice does not match the goods received (' + (b.variance_pct == null ? '?' : b.variance_pct) + '%). Add a note explaining why it is being approved.');
        const amt = round(b.invoice_total * b.fx_rate, 2);
        await c.query(
          `UPDATE receipts SET bill_status = 'confirmed', bill_amount_jmd = $2, bill_variance_note = $3,
                  bill_confirmed_by = $4, bill_confirmed_at = NOW(),
                  due_date = COALESCE(supplier_invoice_date, posted_at::date) + COALESCE(payment_terms_days, 0)
            WHERE id = $1`, [b.id, amt, note || null, req.session.userId]);
        if (b.po_id) await rollupPoBills(c, b.po_id);
      });
      const { rows } = await query(BILL_SQL + ' AND r.id = $1', [req.params.id]);
      res.json({ bill: billChecks(rows[0], tol) });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/inb/bills/:id/dispute', gate, cap('purchasing.approve_bills'), async (req, res) => {
    try {
      const note = String((req.body || {}).note || '').trim();
      if (note.length < 5) throw httpError(400, 'Say what is wrong with the bill');
      const { rows } = await query(
        `UPDATE receipts SET bill_status = 'disputed', bill_variance_note = $2 WHERE id = $1 AND status = 'posted' AND bill_status <> 'confirmed' RETURNING id`,
        [req.params.id, note]);
      if (!rows.length) throw httpError(409, 'Only an unconfirmed bill can be disputed');
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/inb/bills/:id/reopen', gate, cap('purchasing.approve_bills'), async (req, res) => {
    try {
      await tx(async (c) => {
        const { rows } = await c.query(
          `UPDATE receipts SET bill_status = 'pending', bill_amount_jmd = NULL, bill_confirmed_by = NULL, bill_confirmed_at = NULL, due_date = NULL
            WHERE id = $1 AND status = 'posted' RETURNING po_id`, [req.params.id]);
        if (!rows.length) throw httpError(404, 'Bill not found');
        if (rows[0].po_id) await rollupPoBills(c, rows[0].po_id);
      });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ---------------------------------------------------------- backorders --
  app.get('/api/inb/backorders', gate, async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT i.id AS po_item_id, po.id AS po_id, po.po_number, po.status, po.expected_date, po.ordered_at, po.created_at,
                s.name AS supplier_name, i.sku, COALESCE(p.name, i.description) AS name, i.product_img,
                COALESCE(i.qty_ordered, i.qty, 0) AS qty_ordered, COALESCE(i.qty_received, 0) AS qty_received, i.qty_cancelled,
                GREATEST(COALESCE(i.qty_ordered, i.qty, 0) - COALESCE(i.qty_received, 0) - i.qty_cancelled, 0) AS outstanding,
                (CURRENT_DATE - COALESCE(po.ordered_at, po.created_at)::date) AS days_open,
                (po.expected_date IS NOT NULL AND po.expected_date < CURRENT_DATE) AS overdue
           FROM purchase_order_items i
           JOIN purchase_orders po ON po.id = i.po_id
           LEFT JOIN suppliers s ON s.id = po.supplier_id
           LEFT JOIN products p ON p.img = i.product_img
          WHERE po.status IN ('ordered', 'sent', 'partial')
            AND COALESCE(i.qty_ordered, i.qty, 0) - COALESCE(i.qty_received, 0) - i.qty_cancelled > 0
          ORDER BY (po.expected_date IS NOT NULL AND po.expected_date < CURRENT_DATE) DESC, po.created_at
          LIMIT 500`);
      res.json({ backorders: rows });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/inb/backorders/:poItemId/cancel', gate, cap('purchasing.create_po'), async (req, res) => {
    try {
      const out = await tx(async (c) => {
        const { rows } = await c.query(
          `UPDATE purchase_order_items SET qty_cancelled = qty_cancelled + GREATEST(COALESCE(qty_ordered, qty, 0) - COALESCE(qty_received, 0) - qty_cancelled, 0)
            WHERE id = $1 RETURNING po_id`, [req.params.poItemId]);
        if (!rows.length) throw httpError(404, 'Line not found');
        const poId = rows[0].po_id;
        const { rows: rem } = await c.query(
          `SELECT COALESCE(SUM(GREATEST(COALESCE(qty_ordered, qty, 0) - COALESCE(qty_received, 0) - qty_cancelled, 0)), 0)::int AS r,
                  COALESCE(SUM(COALESCE(qty_received, 0)), 0)::int AS got FROM purchase_order_items WHERE po_id = $1`, [poId]);
        let status = null;
        if (rem[0].r === 0) {
          status = rem[0].got > 0 ? 'received' : 'cancelled';
          await c.query('UPDATE purchase_orders SET status = $2 WHERE id = $1 AND status IN (\'ordered\',\'sent\',\'partial\',\'draft\')', [poId, status]);
        }
        return { po_id: poId, po_status: status };
      });
      res.json(Object.assign({ ok: true }, out));
    } catch (e) { fail(res, e); }
  });

  // --------------------------------------------------- batch for putaway --
  // Used by warehouse.js lookup: what a BATCH:<code> label refers to.
  async function batchInfo(code) {
    const { rows } = await query(
      `SELECT l.id, l.batch_code, l.product_img, l.qty_received, l.qty_putaway, r.receipt_number, r.receiving_bin_id,
              b.code AS receiving_bin,
              COALESCE((SELECT qty FROM stock_by_bin s WHERE s.product_img = l.product_img AND s.bin_id = r.receiving_bin_id), 0) AS in_receiving
         FROM receipt_lines l JOIN receipts r ON r.id = l.receipt_id LEFT JOIN bins b ON b.id = r.receiving_bin_id
        WHERE upper(l.batch_code) = upper($1) AND r.status = 'posted'`, [code]);
    if (!rows.length) return null;
    const x = rows[0];
    x.remaining = Math.max(Math.min(x.qty_received - x.qty_putaway, x.in_receiving), 0);
    return x;
  }

  return { batchInfo, effectiveRate, suggestPrice, fetchBoj, stop: () => fxTimer && clearInterval(fxTimer), DEV_MODE };
}

module.exports = { register, CURRENCIES };
