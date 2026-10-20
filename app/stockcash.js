'use strict';
// =============================================================================
//  Vision Auto Solutions -- stock to cash (Phase 9: inventory to marketing)
//
//  Classes, worked out live from sales history (defaults editable):
//    overstock     on hand > N months of the last year's demand
//    aged          no sale in 6-12 months           -> clearance price ladder
//    dead          no sale in 12+ months, or marked -> lot, marketplace, supplier
//    discontinued  discontinued or superseded       -> sell through, never reorder
//    open_box /    copies of a part (variant_of) that sell at their own price
//    damaged
//  Returned units are graded after the refund: A stays in stock, B becomes
//  open box, C is written off or claimed from the supplier.
//
//  Stock moves carry a stock ledger reason (regrade / writeoff / vendor_claim)
//  so the general ledger posts them; a regrade moves cost between two products
//  and nets to nothing.
//
//  Last-sale dates: sales imported without lines (see planning.js) hide when a
//  part last sold before that date, so "idle since" is then a minimum and a part
//  is never classed older than the data can show.
// =============================================================================
const crypto = require('crypto');

function register(app, deps) {
  const { query, getPool, requireAdmin, requireCap, userCan, posSaleHandler, mailer, sms, getShopName } = deps;
  const can = (k) => [requireAdmin, requireCap(k)];
  const n = (v) => (v == null || v === '' ? 0 : Number(v));
  const r2 = (v) => Math.round(n(v) * 100) / 100;
  function httpError(status, msg) { const e = new Error(msg); e.status = status; e.publicMessage = msg; return e; }
  function fail(res, e) { const s = e.status || 500; if (s >= 500) console.error('[stockcash]', e); res.status(s).json({ error: e.publicMessage || e.message }); }
  async function tx(fn) {
    const c = await getPool().connect();
    try { await c.query('BEGIN'); const out = await fn(c); await c.query('COMMIT'); return out; }
    catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} throw e; }
    finally { c.release(); }
  }
  const put = (k, v) => query(`INSERT INTO warehouse_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [k, String(v)]);
  async function settings() {
    const { rows } = await query(`SELECT key, value FROM warehouse_settings WHERE key LIKE 'mkt\\_%' OR key = 'public_base_url'`);
    const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    const ladder = String(s.mkt_ladder || '10,20,30').split(',').map((x) => parseFloat(x)).filter((x) => x > 0 && x < 95);
    return { months: n(s.mkt_overstock_months) || 6, slow: n(s.mkt_slow_days) || 180, dead: n(s.mkt_dead_days) || 365,
      ladder: ladder.length ? ladder : [10, 20, 30], ladderDays: n(s.mkt_ladder_days) || 30,
      openBox: n(s.mkt_open_box_pct) || 25, damaged: n(s.mkt_damaged_pct) || 40, boost: n(s.mkt_boost_pct) || 5, base: s.public_base_url || '' };
  }
  async function baseUrl(req) {
    const s = await settings();
    if (s.base) return s.base.replace(/\/$/, '');
    return req ? (req.headers['x-forwarded-proto'] || req.protocol || 'http') + '://' + req.get('host') : '';
  }
  const price0 = (v) => Math.max(0, Math.round(n(v)));   // clearance prices in whole dollars

  // ---------------------------------------------------------- classify --
  let cache = null;
  function invalidate() { cache = null; }
  async function classify(force) {
    if (!force && cache && cache.at > Date.now() - 300000) return cache;
    const s = await settings();
    // Newest sale with no lines: before this, a part's last sale is unknown.
    const { rows: gap } = await query(
      `SELECT MAX(s.created_at) AS d FROM pos_sales s WHERE s.receipt_number NOT LIKE 'CN%' AND NOT EXISTS (SELECT 1 FROM pos_sale_items i WHERE i.sale_id = s.id)`);
    const reliable = gap[0].d ? new Date(gap[0].d) : null;
    const { rows } = await query(
      `WITH ls AS (
         SELECT i.product_img, MAX(s.created_at) AS last_sold,
                COALESCE(SUM(i.qty) FILTER (WHERE s.created_at >= NOW() - INTERVAL '365 days'), 0) AS q365
           FROM pos_sale_items i JOIN pos_sales s ON s.id = i.sale_id
          WHERE i.product_img IS NOT NULL AND s.receipt_number NOT LIKE 'CN%' AND NOT COALESCE(s.voided, false)
          GROUP BY i.product_img)
       SELECT p.img, p.sku, p.name, p.make_model, p.category, p.stock_count, COALESCE(p.cost_usd, 0)::float AS cost, COALESCE(p.price_usd, 0)::float AS price,
              p.clearance_step, p.clearance_pct::float AS clearance_pct, p.clearance_base_price::float AS base_price, p.clearance_stepped_at,
              p.discontinued, p.superseded_by, p.stock_class_override, p.variant_of, p.variant_kind, p.supplier_id, sup.name AS supplier,
              p.commission_type, p.commission_value::float AS commission_value, (p.comm_boost_prev IS NOT NULL) AS boosted,
              p.created_at, ls.last_sold, COALESCE(ls.q365, 0)::int AS q365
         FROM products p LEFT JOIN ls ON ls.product_img = p.img LEFT JOIN suppliers sup ON sup.id = p.supplier_id
        WHERE p.is_active AND p.stock_count > 0`);
    const now = Date.now(), DAY = 86400000;
    const out = rows.map((r) => {
      let since = r.last_sold ? new Date(r.last_sold) : null, minimum = false;
      // A recorded sale older than the gap may have been followed by sales with
      // no lines, so the most we know is "no sale since the gap".
      if (since && reliable && since < reliable) { since = reliable; minimum = true; }
      if (!since) {
        const created = r.created_at ? new Date(r.created_at) : null;
        if (reliable && (!created || created < reliable)) { since = reliable; minimum = true; }
        else since = created;
      }
      const idle = since ? Math.floor((now - since.getTime()) / DAY) : null;
      let cls = 'active';
      if (r.variant_kind) cls = r.variant_kind;
      else if (r.stock_class_override === 'keep') cls = 'active';
      else if (r.discontinued || r.superseded_by) cls = 'discontinued';
      else if (r.stock_class_override === 'dead' || (idle != null && idle >= s.dead)) cls = 'dead';
      else if (idle != null && idle >= s.slow) cls = 'aged';
      else if (r.q365 > 0 && r.stock_count > (r.q365 / 12) * s.months) cls = 'overstock';
      const regular = r.clearance_step > 0 && r.base_price != null ? r.base_price : r.price;
      const cover = r.q365 > 0 ? Math.round((r.stock_count / (r.q365 / 12)) * 10) / 10 : null;
      const steppedDays = r.clearance_stepped_at ? Math.floor((now - new Date(r.clearance_stepped_at).getTime()) / DAY) : null;
      const nextStep = r.clearance_step < s.ladder.length ? s.ladder[r.clearance_step] : null;
      const stepDue = (cls === 'aged' || cls === 'dead') && nextStep != null && (r.clearance_step === 0 || steppedDays >= s.ladderDays);
      let suggestion = '';
      if (cls === 'overstock') suggestion = cover + ' months of stock: bundle it or boost the commission';
      else if (cls === 'aged' || cls === 'dead') {
        if (stepDue) suggestion = 'Clearance step ' + (r.clearance_step + 1) + ': ' + nextStep + '% off';
        else if (r.clearance_step > 0 && nextStep != null) suggestion = 'On clearance ' + r.clearance_pct + '% off; next step in ' + Math.max(0, s.ladderDays - steppedDays) + ' days';
        else if (cls === 'dead') suggestion = 'Ladder done: liquidation lot, marketplace or return to the supplier';
        else suggestion = 'On clearance ' + r.clearance_pct + '% off';
      } else if (cls === 'discontinued') suggestion = 'Sell through; not reordered' + (r.superseded_by ? ' (replaced by ' + r.superseded_by + ')' : '');
      else if (cls === 'open_box' || cls === 'damaged') suggestion = 'Sells at its own reduced price';
      return { img: r.img, sku: r.sku, name: r.name, make_model: r.make_model, category: r.category, stock: r.stock_count, cost: r.cost, price: r.price, regular,
        value: r2(r.stock_count * r.cost), retail: r2(r.stock_count * r.price), q365: r.q365, cover, idle_days: idle, idle_minimum: minimum,
        last_sold: r.last_sold, cls, clearance_step: r.clearance_step, clearance_pct: r.clearance_pct, step_due: stepDue, next_pct: nextStep,
        below_cost: r.cost > 0 && r.price < r.cost, discontinued: r.discontinued, superseded_by: r.superseded_by, override: r.stock_class_override,
        variant_of: r.variant_of, supplier_id: r.supplier_id, supplier: r.supplier, boosted: r.boosted,
        commission: r.commission_type ? r.commission_type + (r.commission_value != null ? ' ' + r.commission_value : '') : null, suggestion };
    });
    cache = { at: Date.now(), rows: out, reliable_from: reliable ? reliable.toISOString().slice(0, 10) : null, settings: s };
    return cache;
  }

  // -------------------------------------------------------- dispositions --
  // Moves units out of normal stock: to an open-box / damaged copy (regrade),
  // or out of the books (writeoff) or into a supplier claim.
  async function dispose(c, { img, qty, kind, source, sourceRef, note, pct, userId }) {
    qty = parseInt(qty, 10);
    if (!(qty > 0 && qty <= 100000)) throw httpError(400, 'How many units?');
    if (!['open_box', 'damaged', 'writeoff', 'vendor_claim'].includes(kind)) throw httpError(400, 'Open box, damaged, write off or supplier claim?');
    const { rows } = await c.query(`SELECT * FROM products WHERE img = $1 FOR UPDATE`, [img]);
    if (!rows.length) throw httpError(404, 'Part not found');
    const p = rows[0];
    if (p.stock_count < qty) throw httpError(409, 'Only ' + p.stock_count + ' of ' + p.img + ' in stock');
    let toImg = null;
    if (kind === 'open_box' || kind === 'damaged') {
      if (p.variant_of) throw httpError(400, 'This is already an open-box / damaged copy');
      toImg = p.img + (kind === 'open_box' ? '-OB' : '-DMG');
      const s = await settings();
      const off = pct != null && pct !== '' ? n(pct) : (kind === 'open_box' ? s.openBox : s.damaged);
      if (!(off >= 0 && off < 100)) throw httpError(400, 'Discount 0 to 99%');
      const regular = p.clearance_step > 0 && p.clearance_base_price != null ? n(p.clearance_base_price) : n(p.price_usd);
      let { rows: v } = await c.query(`SELECT * FROM products WHERE img = $1 FOR UPDATE`, [toImg]);
      if (!v.length) {
        ({ rows: v } = await c.query(
          `INSERT INTO products (img, name, make_model, category, condition, price_usd, stock_count, low_threshold, is_active, sku, cost_usd, supplier_id, variant_of, variant_kind)
           VALUES ($1,$2,$3,$4,$5,$6,0,0,true,$7,$8,$9,$10,$11) RETURNING *`,
          [toImg, p.name + (kind === 'open_box' ? ' (open box)' : ' (damaged)'), p.make_model, p.category, p.condition, price0(regular * (1 - off / 100)),
           p.sku ? p.sku + (kind === 'open_box' ? '-OB' : '-DMG') : null, p.cost_usd, p.supplier_id, p.img, kind]));
      } else if (v[0].variant_of !== p.img) throw httpError(409, toImg + ' already exists and is not a copy of ' + p.img);
      const vc = v[0].stock_count > 0 ? n(v[0].stock_count) : 0, pc = n(p.cost_usd);
      const avg = vc + qty > 0 ? Math.round(((vc * n(v[0].cost_usd) + qty * pc) / (vc + qty)) * 10000) / 10000 : pc;
      await c.query(`SELECT set_config('vision.stock_reason', 'regrade', true)`);
      await c.query(`UPDATE products SET stock_count = stock_count - $2, updated_at = NOW() WHERE img = $1`, [p.img, qty]);
      // Moved at the part's cost (the ledger values the move at the row's cost),
      // then the copy's cost is averaged without another ledger line.
      await c.query(`UPDATE products SET cost_usd = $2 WHERE img = $1`, [toImg, pc]);
      await c.query(`UPDATE products SET stock_count = stock_count + $2, updated_at = NOW() WHERE img = $1`, [toImg, qty]);
      await c.query(`UPDATE products SET cost_usd = $2 WHERE img = $1`, [toImg, avg]);
    } else {
      await c.query(`SELECT set_config('vision.stock_reason', $1, true)`, [kind]);
      await c.query(`UPDATE products SET stock_count = stock_count - $2, updated_at = NOW() WHERE img = $1`, [p.img, qty]);
    }
    const { rows: d } = await c.query(
      `INSERT INTO stock_dispositions (product_img, qty, kind, source, source_ref, to_img, unit_cost, supplier_id, claim_status, claim_amount, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [p.img, qty, kind, source || 'manual', sourceRef || null, toImg, n(p.cost_usd), p.supplier_id, kind === 'vendor_claim' ? 'open' : null,
       kind === 'vendor_claim' ? r2(qty * n(p.cost_usd)) : null, String(note || '').slice(0, 300) || null, userId]);
    invalidate();
    return d[0];
  }

  // ------------------------------------------------------- unsubscribe --
  let unsubKey = null;
  async function key() {
    if (unsubKey) return unsubKey;
    const { rows } = await query(`SELECT value FROM warehouse_settings WHERE key = 'mkt_unsub_key'`);
    if (rows.length && rows[0].value) return (unsubKey = rows[0].value);
    const k = crypto.randomBytes(32).toString('hex');
    await query(`INSERT INTO warehouse_settings (key, value) VALUES ('mkt_unsub_key', $1) ON CONFLICT (key) DO NOTHING`, [k]);
    const { rows: again } = await query(`SELECT value FROM warehouse_settings WHERE key = 'mkt_unsub_key'`);
    return (unsubKey = again[0].value);
  }
  async function unsubToken(uid, channel) {
    const body = uid + '.' + (channel === 'email' ? 'e' : 's');
    const mac = crypto.createHmac('sha256', await key()).update(body).digest('base64url').slice(0, 22);
    return body + '.' + mac;
  }
  async function readToken(t) {
    const m = /^(\d+)\.([es])\.([A-Za-z0-9_-]{22})$/.exec(String(t || ''));
    if (!m) return null;
    const mac = crypto.createHmac('sha256', await key()).update(m[1] + '.' + m[2]).digest('base64url').slice(0, 22);
    if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(m[3]))) return null;
    return { uid: parseInt(m[1], 10), channel: m[2] === 'e' ? 'email' : 'sms' };
  }
  async function unsubLink(req, uid, channel) { return (await baseUrl(req)) + '/unsubscribe.html?t=' + (await unsubToken(uid, channel)); }

  app.get('/api/unsubscribe', async (req, res) => {
    try {
      const t = await readToken(req.query.t);
      if (!t) throw httpError(404, 'This link is not valid');
      const { rows } = await query(`SELECT name, email_opt_in, sms_opt_in FROM users WHERE id = $1`, [t.uid]);
      if (!rows.length) throw httpError(404, 'This link is not valid');
      res.set('Cache-Control', 'no-store');
      res.json({ channel: t.channel, first_name: String(rows[0].name || '').split(' ')[0], subscribed: t.channel === 'email' ? rows[0].email_opt_in : rows[0].sms_opt_in });
    } catch (e) { fail(res, e); }
  });
  // POST, so a mail scanner opening the link changes nothing.
  app.post('/api/unsubscribe', async (req, res) => {
    try {
      const t = await readToken((req.body || {}).t);
      if (!t) throw httpError(404, 'This link is not valid');
      const on = (req.body || {}).subscribe === true;
      await query(`UPDATE users SET ${t.channel === 'email' ? 'email_opt_in' : 'sms_opt_in'} = $2, marketing_changed_at = NOW(), marketing_changed_by = 'unsubscribe link' WHERE id = $1`, [t.uid, on]);
      res.json({ ok: true, subscribed: on });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------- public list --
  app.get('/api/clearance', async (req, res) => {
    try {
      const qs = String(req.query.q || '').trim().slice(0, 60);
      const cat = String(req.query.category || '').trim().slice(0, 60);
      const { rows } = await query(
        `SELECT p.img, p.name, p.make_model, p.category, p.condition, p.price_usd::float AS price,
                CASE WHEN p.clearance_step > 0 THEN p.clearance_base_price::float
                     WHEN p.variant_of IS NOT NULL THEN COALESCE(o.clearance_base_price, o.price_usd)::float END AS was,
                p.variant_kind, LEAST(p.stock_count, 20) AS stock
           FROM products p LEFT JOIN products o ON o.img = p.variant_of
          WHERE p.is_active AND p.stock_count > 0 AND p.price_usd > 0 AND (p.clearance_step > 0 OR p.variant_kind IS NOT NULL)
            AND ($1 = '' OR p.name ILIKE '%' || $1 || '%' OR p.make_model ILIKE '%' || $1 || '%' OR p.img ILIKE $1 || '%')
            AND ($2 = '' OR p.category = $2)
          ORDER BY (CASE WHEN p.clearance_step > 0 THEN p.clearance_pct ELSE 0 END) DESC, p.name LIMIT 300`, [qs, cat]);
      const camp = parseInt(req.query.c, 10);
      if (camp && req.session && !(req.session.seenC || []).includes(camp)) {
        req.session.seenC = (req.session.seenC || []).concat(camp).slice(-20);
        query(`UPDATE marketing_campaigns SET views = views + 1 WHERE id = $1`, [camp]).catch(() => {});
      }
      res.set('Cache-Control', 'no-store');
      res.json({ items: rows.map((r) => Object.assign(r, { was: r.was != null && r.was > r.price ? r.was : null })) });
    } catch (e) { fail(res, e); }
  });

  // ---------------------------------------------------------- manager --
  const M = can('mkt.manage');
  const imgsOf = (b) => (Array.isArray(b.imgs) ? b.imgs : []).map(String).filter(Boolean).slice(0, 2000);

  app.get('/api/stockcash/summary', ...M, async (req, res) => {
    try {
      const c = await classify(req.query.refresh === '1');
      const by = {};
      for (const r of c.rows) {
        const k = r.cls; by[k] = by[k] || { skus: 0, units: 0, value: 0, retail: 0, due: 0, on_clearance: 0 };
        by[k].skus++; by[k].units += r.stock; by[k].value += r.value; by[k].retail += r.retail;
        if (r.step_due) by[k].due++;
        if (r.clearance_step > 0) by[k].on_clearance++;
      }
      for (const k of Object.keys(by)) { by[k].value = r2(by[k].value); by[k].retail = r2(by[k].retail); }
      const one = async (sql) => (await query(sql)).rows[0];
      res.json({ classes: by, reliable_from: c.reliable_from, settings: c.settings, at: new Date(c.at).toISOString(),
        returns_to_grade: (await one(`SELECT COUNT(*)::int AS n FROM pos_sale_return_items ri JOIN pos_sale_returns r ON r.id = ri.return_id WHERE ri.grade IS NULL AND r.created_at > NOW() - INTERVAL '90 days'`)).n,
        open_claims: await one(`SELECT COUNT(*)::int AS n, COALESCE(SUM(claim_amount), 0)::float AS value FROM stock_dispositions WHERE kind = 'vendor_claim' AND claim_status = 'open'`),
        open_tasks: (await one(`SELECT COUNT(*)::int AS n FROM marketing_tasks WHERE status = 'open'`)).n,
        open_lots: (await one(`SELECT COUNT(*)::int AS n FROM clearance_lots WHERE status IN ('open', 'at_till')`)).n });
    } catch (e) { fail(res, e); }
  });

  function filterRows(c, q) {
    let rows = c.rows;
    if (q.class) rows = rows.filter((r) => r.cls === q.class);
    else rows = rows.filter((r) => r.cls !== 'active' || r.clearance_step > 0);
    if (q.due === '1') rows = rows.filter((r) => r.step_due);
    if (q.clearance === '1') rows = rows.filter((r) => r.clearance_step > 0);
    if (q.q) { const s = String(q.q).toLowerCase(); rows = rows.filter((r) => (r.img + ' ' + (r.sku || '') + ' ' + r.name + ' ' + (r.make_model || '') + ' ' + (r.category || '')).toLowerCase().includes(s)); }
    if (q.category) rows = rows.filter((r) => r.category === q.category);
    if (q.supplier) rows = rows.filter((r) => String(r.supplier_id) === String(q.supplier));
    const sort = { value: (a, b) => b.value - a.value, idle: (a, b) => (b.idle_days || 0) - (a.idle_days || 0), name: (a, b) => String(a.name).localeCompare(String(b.name)), cover: (a, b) => (b.cover || 0) - (a.cover || 0) }[q.sort] || ((a, b) => b.value - a.value);
    return rows.slice().sort(sort);
  }
  app.get('/api/stockcash/items', ...M, async (req, res) => {
    try {
      const c = await classify(false);
      const rows = filterRows(c, req.query);
      const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100)), offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
      res.json({ total: rows.length, value: r2(rows.reduce((s, r) => s + r.value, 0)), items: rows.slice(offset, offset + limit), reliable_from: c.reliable_from });
    } catch (e) { fail(res, e); }
  });
  // For a marketplace listing, a liquidation buyer or a supplier return.
  app.get('/api/stockcash/items.csv', ...M, async (req, res) => {
    try {
      const rows = filterRows(await classify(false), req.query);
      const q = (v) => { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
      const lines = [['part_no', 'sku', 'name', 'fits', 'category', 'class', 'on_hand', 'unit_cost', 'price', 'regular_price', 'stock_value', 'last_sold', 'supplier'].join(',')]
        .concat(rows.map((r) => [r.img, r.sku, r.name, r.make_model, r.category, r.cls, r.stock, r.cost, r.price, r.regular, r.value, r.last_sold ? new Date(r.last_sold).toISOString().slice(0, 10) : '', r.supplier].map(q).join(',')));
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', 'attachment; filename="stock-' + String(req.query.class || 'all').replace(/[^a-z_]/g, '') + '.csv"');
      res.send(lines.join('\n'));
    } catch (e) { fail(res, e); }
  });

  // Clearance ladder: next step / a set % / end (regular price back).
  app.post('/api/stockcash/clearance', ...M, async (req, res) => {
    try {
      const b = req.body || {};
      const imgs = imgsOf(b);
      if (!imgs.length) throw httpError(400, 'Choose the parts');
      const action = String(b.action || '');
      if (!['step', 'set', 'end'].includes(action)) throw httpError(400, 'Step, set or end?');
      const s = await settings();
      const done = [], skipped = [];
      await tx(async (c) => {
        const { rows } = await c.query(`SELECT img, name, price_usd, cost_usd, clearance_step, clearance_base_price, variant_of FROM products WHERE img = ANY($1) FOR UPDATE`, [imgs]);
        for (const p of rows) {
          if (p.variant_of) { skipped.push({ img: p.img, why: 'open-box / damaged copies have their own price' }); continue; }
          if (action === 'end') {
            if (!(p.clearance_step > 0)) { skipped.push({ img: p.img, why: 'not on clearance' }); continue; }
            await c.query(`UPDATE products SET price_usd = COALESCE(clearance_base_price, price_usd), clearance_step = 0, clearance_pct = NULL, clearance_base_price = NULL, clearance_since = NULL, clearance_stepped_at = NULL, updated_at = NOW() WHERE img = $1`, [p.img]);
            done.push({ img: p.img, price: n(p.clearance_base_price) }); continue;
          }
          const base = p.clearance_step > 0 && p.clearance_base_price != null ? n(p.clearance_base_price) : n(p.price_usd);
          if (!(base > 0)) { skipped.push({ img: p.img, why: 'no price' }); continue; }
          let step, pct;
          if (action === 'step') {
            if (p.clearance_step >= s.ladder.length) { skipped.push({ img: p.img, why: 'already at the last step' }); continue; }
            step = p.clearance_step + 1; pct = s.ladder[step - 1];
          } else {
            pct = n(b.pct); if (!(pct > 0 && pct < 95)) throw httpError(400, 'Discount 1 to 94%');
            step = Math.max(1, p.clearance_step);
          }
          const price = price0(base * (1 - pct / 100));
          if (n(p.cost_usd) > 0 && price < n(p.cost_usd) && !b.allow_below_cost) { skipped.push({ img: p.img, why: 'below cost (J$' + n(p.cost_usd) + ')', below_cost: true }); continue; }
          await c.query(`UPDATE products SET price_usd = $2, clearance_step = $3, clearance_pct = $4, clearance_base_price = $5, clearance_since = COALESCE(clearance_since, NOW()), clearance_stepped_at = NOW(), updated_at = NOW() WHERE img = $1`,
            [p.img, price, step, pct, base]);
          done.push({ img: p.img, price, pct, step });
        }
      });
      invalidate();
      res.json({ ok: true, done, skipped });
    } catch (e) { fail(res, e); }
  });

  // Discontinued / superseded / class overrides.
  app.post('/api/stockcash/flags', ...M, async (req, res) => {
    try {
      const b = req.body || {};
      const imgs = imgsOf(b);
      if (!imgs.length) throw httpError(400, 'Choose the parts');
      if (b.superseded_by !== undefined && b.superseded_by) {
        const { rows } = await query(`SELECT 1 FROM products WHERE img = $1`, [String(b.superseded_by)]);
        if (!rows.length) throw httpError(400, 'The replacement part ' + b.superseded_by + ' is not in the catalogue');
        if (imgs.includes(String(b.superseded_by))) throw httpError(400, 'A part cannot replace itself');
      }
      const sets = [], vals = [imgs];
      if (b.discontinued !== undefined) { vals.push(!!b.discontinued); sets.push('discontinued = $' + vals.length); }
      if (b.superseded_by !== undefined) { vals.push(b.superseded_by ? String(b.superseded_by) : null); sets.push('superseded_by = $' + vals.length); }
      if (b.override !== undefined) { vals.push(['dead', 'keep'].includes(b.override) ? b.override : null); sets.push('stock_class_override = $' + vals.length); }
      if (!sets.length) throw httpError(400, 'Nothing to change');
      const { rowCount } = await query(`UPDATE products SET ${sets.join(', ')}, updated_at = NOW() WHERE img = ANY($1)`, vals);
      invalidate();
      res.json({ ok: true, changed: rowCount });
    } catch (e) { fail(res, e); }
  });

  // Sell-through incentive: a higher commission on these parts (the old setting is kept).
  app.post('/api/stockcash/boost', ...M, async (req, res) => {
    try {
      const b = req.body || {};
      const imgs = imgsOf(b);
      if (!imgs.length) throw httpError(400, 'Choose the parts');
      let changed = 0;
      if (b.remove) {
        ({ rowCount: changed } = await query(
          `UPDATE products SET commission_type = comm_boost_prev->>'type', commission_value = (comm_boost_prev->>'value')::numeric, comm_boost_prev = NULL
            WHERE img = ANY($1) AND comm_boost_prev IS NOT NULL`, [imgs]));
      } else {
        const pct = b.pct != null && b.pct !== '' ? n(b.pct) : (await settings()).boost;
        if (!(pct >= 0.5 && pct <= 50)) throw httpError(400, 'Commission 0.5 to 50% of the sale');
        ({ rowCount: changed } = await query(
          `UPDATE products SET comm_boost_prev = COALESCE(comm_boost_prev, jsonb_build_object('type', commission_type, 'value', commission_value)),
                  commission_type = 'percent', commission_value = $2 WHERE img = ANY($1)`, [imgs, pct]));
      }
      invalidate();
      res.json({ ok: true, changed });
    } catch (e) { fail(res, e); }
  });

  // Mark units open box / damaged, or write them off / claim them.
  app.post('/api/stockcash/dispose', ...M, async (req, res) => {
    try {
      const b = req.body || {};
      const d = await tx((c) => dispose(c, { img: String(b.img || ''), qty: b.qty, kind: b.kind, source: ['receiving', 'count', 'manual'].includes(b.source) ? b.source : 'manual', note: b.note, pct: b.pct, userId: req.session.userId }));
      res.json({ ok: true, disposition: d });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/stockcash/dispositions', ...M, async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT d.*, p.name, s.name AS supplier, u.name AS by_name, rb.name AS resolved_by_name FROM stock_dispositions d LEFT JOIN products p ON p.img = d.product_img
           LEFT JOIN suppliers s ON s.id = d.supplier_id LEFT JOIN users u ON u.id = d.created_by LEFT JOIN users rb ON rb.id = d.resolved_by
          WHERE ($1 = '' OR d.kind = $1) AND ($2 = '' OR d.claim_status = $2) ORDER BY d.id DESC LIMIT 300`, [String(req.query.kind || ''), String(req.query.status || '')]);
      res.json({ dispositions: rows });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/stockcash/claims/:id', ...M, async (req, res) => {
    try {
      const b = req.body || {};
      if (!['credited', 'rejected'].includes(b.status)) throw httpError(400, 'Credited or rejected?');
      const out = await tx(async (c) => {
        const { rows } = await c.query(`SELECT * FROM stock_dispositions WHERE id = $1 AND kind = 'vendor_claim' FOR UPDATE`, [parseInt(req.params.id, 10)]);
        if (!rows.length) throw httpError(404, 'Claim not found');
        if (rows[0].claim_status !== 'open') throw httpError(409, 'Already ' + rows[0].claim_status);
        const value = r2(n(rows[0].qty) * n(rows[0].unit_cost));
        const amt = b.status === 'credited' ? (b.amount != null && b.amount !== '' ? r2(b.amount) : value) : 0;
        if (b.status === 'credited' && !(amt > 0 && amt <= value)) throw httpError(400, 'Credit between 0 and the claim value (J$' + value + ')');
        const { rows: u } = await c.query(`UPDATE stock_dispositions SET claim_status = $2, claim_amount = $3, resolved_by = $4, resolved_at = NOW(), note = COALESCE($5, note) WHERE id = $1 RETURNING *`,
          [rows[0].id, b.status, amt, req.session.userId, String(b.note || '').slice(0, 300) || null]);
        return u[0];
      });
      res.json({ ok: true, claim: out });
    } catch (e) { fail(res, e); }
  });

  // ---------------------------------------------------------- returns --
  const G = [requireAdmin, async (req, res, next) => { try { if ((await userCan(req, 'stock.grade_returns')) || (await userCan(req, 'mkt.manage'))) return next(); res.status(403).json({ error: 'Not allowed to grade returns' }); } catch (e) { next(e); } }];
  app.get('/api/stockcash/returns', ...G, async (req, res) => {
    try {
      const all = req.query.all === '1';
      const { rows } = await query(
        `SELECT ri.id, ri.qty, ri.grade, ri.graded_at, r.return_number, r.reason, r.created_at, si.product_img, COALESCE(p.name, si.description) AS name,
                s.receipt_number, g.name AS graded_by_name, d.kind AS outcome, d.to_img, (p.supplier_id IS NOT NULL) AS has_supplier, p.stock_count
           FROM pos_sale_return_items ri JOIN pos_sale_returns r ON r.id = ri.return_id JOIN pos_sale_items si ON si.id = ri.sale_item_id
           JOIN pos_sales s ON s.id = r.sale_id LEFT JOIN products p ON p.img = si.product_img LEFT JOIN users g ON g.id = ri.graded_by
           LEFT JOIN stock_dispositions d ON d.id = ri.disposition_id
          WHERE r.created_at > NOW() - INTERVAL '90 days' AND ($1 OR ri.grade IS NULL)
          ORDER BY (ri.grade IS NULL) DESC, r.created_at DESC LIMIT 300`, [all]);
      res.json({ returns: rows });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/stockcash/returns/:id/grade', ...G, async (req, res) => {
    try {
      const b = req.body || {};
      const grade = String(b.grade || '').toUpperCase();
      if (!['A', 'B', 'C'].includes(grade)) throw httpError(400, 'Grade A, B or C');
      const out = await tx(async (c) => {
        const { rows } = await c.query(
          `SELECT ri.*, si.product_img FROM pos_sale_return_items ri JOIN pos_sale_items si ON si.id = ri.sale_item_id WHERE ri.id = $1 FOR UPDATE OF ri`, [parseInt(req.params.id, 10)]);
        if (!rows.length) throw httpError(404, 'Return line not found');
        const ri = rows[0];
        if (ri.grade) throw httpError(409, 'Already graded ' + ri.grade);
        let d = null;
        if (grade !== 'A') {
          if (!ri.product_img) throw httpError(400, 'This line is not a stocked part');
          const kind = grade === 'B' ? 'open_box' : (b.outcome === 'vendor_claim' ? 'vendor_claim' : 'writeoff');
          d = await dispose(c, { img: ri.product_img, qty: ri.qty, kind, source: 'return', sourceRef: String(ri.id), note: b.note, pct: b.pct, userId: req.session.userId });
        }
        await c.query(`UPDATE pos_sale_return_items SET grade = $2, graded_by = $3, graded_at = NOW(), disposition_id = $4 WHERE id = $1`, [ri.id, grade, req.session.userId, d ? d.id : null]);
        return { grade, disposition: d };
      });
      res.json(Object.assign({ ok: true }, out));
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------------- lots --
  app.get('/api/stockcash/lots', ...M, async (req, res) => {
    try {
      // A lot sent to the till is sold once its order is paid; back to open if the order lapsed.
      await query(`UPDATE clearance_lots l SET status = 'sold', closed_at = o.completed_at FROM pos_orders o WHERE o.id = l.pos_order_id AND l.status = 'at_till' AND o.status = 'completed'`);
      await query(`UPDATE clearance_lots l SET status = 'open', pos_order_id = NULL FROM pos_orders o WHERE o.id = l.pos_order_id AND l.status = 'at_till' AND o.status IN ('cancelled', 'expired')`);
      const { rows } = await query(
        `SELECT l.*, u.name AS by_name, COALESCE(SUM(i.qty * i.unit_price), 0)::float AS total, COALESCE(SUM(i.qty * COALESCE(p.cost_usd, 0)), 0)::float AS cost, COUNT(i.product_img)::int AS lines
           FROM clearance_lots l LEFT JOIN clearance_lot_items i ON i.lot_id = l.id LEFT JOIN products p ON p.img = i.product_img LEFT JOIN users u ON u.id = l.created_by
          GROUP BY l.id, u.name ORDER BY (l.status IN ('open', 'at_till')) DESC, l.id DESC LIMIT 100`);
      res.json({ lots: rows });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/stockcash/lots/:id', ...M, async (req, res) => {
    try {
      const { rows } = await query(`SELECT * FROM clearance_lots WHERE id = $1`, [parseInt(req.params.id, 10)]);
      if (!rows.length) throw httpError(404, 'Lot not found');
      const { rows: items } = await query(
        `SELECT i.*, p.name, p.make_model, p.stock_count, p.cost_usd::float AS cost, p.price_usd::float AS price FROM clearance_lot_items i LEFT JOIN products p ON p.img = i.product_img WHERE i.lot_id = $1 ORDER BY p.name`, [rows[0].id]);
      res.json({ lot: rows[0], items });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/stockcash/lots', ...M, async (req, res) => {
    try {
      const b = req.body || {};
      const name = String(b.name || '').trim().slice(0, 80);
      if (!name) throw httpError(400, 'Name the lot');
      const items = (Array.isArray(b.items) ? b.items : []).slice(0, 500).map((i) => ({ img: String(i.img || ''), qty: parseInt(i.qty, 10), price: r2(i.unit_price) }));
      if (!items.length) throw httpError(400, 'Add parts to the lot');
      const id = await tx(async (c) => {
        const { rows: l } = await c.query(`INSERT INTO clearance_lots (name, buyer_name, buyer_phone, note, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [name, String(b.buyer_name || '').slice(0, 80) || null, String(b.buyer_phone || '').slice(0, 30) || null, String(b.note || '').slice(0, 300) || null, req.session.userId]);
        for (const i of items) {
          const { rows: p } = await c.query(`SELECT stock_count FROM products WHERE img = $1`, [i.img]);
          if (!p.length) throw httpError(400, 'Unknown part ' + i.img);
          if (!(i.qty > 0 && i.qty <= p[0].stock_count)) throw httpError(400, i.img + ': quantity 1 to ' + p[0].stock_count);
          if (!(i.price >= 0)) throw httpError(400, i.img + ': price');
          await c.query(`INSERT INTO clearance_lot_items (lot_id, product_img, qty, unit_price) VALUES ($1,$2,$3,$4) ON CONFLICT (lot_id, product_img) DO UPDATE SET qty = EXCLUDED.qty, unit_price = EXCLUDED.unit_price`, [l[0].id, i.img, i.qty, i.price]);
        }
        return l[0].id;
      });
      res.json({ ok: true, id });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/stockcash/lots/:id/cancel', ...M, async (req, res) => {
    try {
      const { rowCount } = await query(`UPDATE clearance_lots SET status = 'cancelled', closed_at = NOW() WHERE id = $1 AND status = 'open'`, [parseInt(req.params.id, 10)]);
      if (!rowCount) throw httpError(409, 'Only an open lot can be cancelled (cancel its till order first)');
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/stockcash/lots/:id/csv', ...M, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const { rows } = await query(`SELECT i.product_img, p.name AS part, p.make_model, i.qty, i.unit_price FROM clearance_lot_items i LEFT JOIN products p ON p.img = i.product_img WHERE i.lot_id = $1 ORDER BY p.name`, [id]);
      const q = (v) => { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', 'attachment; filename="lot-' + id + '.csv"');
      res.send([['part_no', 'name', 'fits', 'qty', 'unit_price', 'line_total'].join(',')].concat(rows.map((r) => [r.product_img, r.part, r.make_model, r.qty, r.unit_price, r2(r.qty * r.unit_price)].map(q).join(','))).join('\n'));
    } catch (e) { fail(res, e); }
  });
  // Sold through the till like any order: the cashier takes payment, and the GL
  // and commission see a normal sale at the lot prices.
  function runSale(req, body) {
    const sreq = Object.create(req);
    sreq.body = body;
    return new Promise((resolve) => {
      const fake = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(d) { resolve({ status: this.statusCode, body: d }); return this; },
        send(d) { resolve({ status: this.statusCode, body: d }); return this; }, set() { return this; }, setHeader() { return this; } };
      Promise.resolve(posSaleHandler(sreq, fake)).catch((e) => resolve({ status: 500, body: { error: e.message } }));
    });
  }
  app.post('/api/stockcash/lots/:id/till', ...M, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const { rows: l } = await query(`SELECT * FROM clearance_lots WHERE id = $1`, [id]);
      if (!l.length) throw httpError(404, 'Lot not found');
      if (l[0].status !== 'open') throw httpError(409, 'This lot is ' + l[0].status);
      const { rows: items } = await query(`SELECT i.*, p.name FROM clearance_lot_items i JOIN products p ON p.img = i.product_img WHERE i.lot_id = $1`, [id]);
      if (!items.length) throw httpError(400, 'The lot is empty');
      const body = { items: items.map((i) => ({ product_img: i.product_img, description: i.name, qty: i.qty, unit_price_usd: n(i.unit_price), discount_usd: 0, price_manual: true })),
        customer_name: l[0].buyer_name || null, customer_phone: l[0].buyer_phone || null, ship_instructions: 'Clearance lot #' + id + ': ' + l[0].name };
      const dry = await runSale(req, Object.assign({}, body, { dry_run: true, payments: [{ method: 'cash', amount_usd: null }] }));
      if (dry.status !== 200 || !dry.body || !dry.body.ok) throw httpError(dry.status || 400, (dry.body && dry.body.error) || 'Could not price the lot');
      const { rows: o } = await query(
        `INSERT INTO pos_orders (payload, total_usd, preview, customer_name, customer_phone, ship_instructions, taken_by, expires_at, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7, NOW() + INTERVAL '7 days', 'clearance_lot') RETURNING id`,
        [JSON.stringify(body), dry.body.total_usd, JSON.stringify(dry.body), body.customer_name, body.customer_phone, body.ship_instructions, req.session.userId]);
      await query(`UPDATE clearance_lots SET status = 'at_till', pos_order_id = $2 WHERE id = $1`, [id, o[0].id]);
      res.json({ ok: true, order_id: o[0].id, total: r2(dry.body.total_usd) });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------------ tasks --
  const TASK = { step_price: 'Step the clearance price', list_marketplace: 'List on a marketplace', return_vendor: 'Ask the supplier to take it back',
    photograph: 'Photograph for the website', bundle: 'Make a bundle offer', boost_commission: 'Boost the commission', chase_claim: 'Chase the supplier claim', other: 'Other' };
  app.get('/api/stockcash/tasks', ...M, async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT t.*, p.name AS part, p.stock_count, a.name AS assigned_name, d.name AS done_name FROM marketing_tasks t LEFT JOIN products p ON p.img = t.product_img
           LEFT JOIN users a ON a.id = t.assigned_to LEFT JOIN users d ON d.id = t.done_by
          WHERE ($1 OR t.status = 'open') ORDER BY (t.status = 'open') DESC, t.due_on NULLS LAST, t.id DESC LIMIT 500`, [req.query.all === '1']);
      const { rows: staff } = await query(`SELECT id, name FROM users WHERE is_staff AND NOT disabled AND admin_role <> 'rep' ORDER BY name`);
      res.json({ tasks: rows, staff, kinds: TASK });
    } catch (e) { fail(res, e); }
  });
  // Turn the suggestions into a worklist (one open task per part and kind).
  app.post('/api/stockcash/tasks/build', ...M, async (req, res) => {
    try {
      const c = await classify(true);
      const want = [];
      for (const r of c.rows.slice().sort((a, b) => b.value - a.value)) {
        if (r.step_due) want.push([r.img, 'step_price', TASK.step_price + ' to ' + r.next_pct + '% off: ' + r.name]);
        else if (r.cls === 'dead' && r.next_pct == null) want.push([r.img, r.supplier_id ? 'return_vendor' : 'list_marketplace', (r.supplier_id ? TASK.return_vendor : TASK.list_marketplace) + ': ' + r.name]);
        else if (r.cls === 'overstock' && !r.boosted && r.value >= 20000) want.push([r.img, 'boost_commission', TASK.boost_commission + ' / bundle: ' + r.name + ' (' + r.cover + ' months of stock)']);
      }
      const { rows: claims } = await query(`SELECT id, product_img FROM stock_dispositions WHERE kind = 'vendor_claim' AND claim_status = 'open' AND created_at < NOW() - INTERVAL '21 days'`);
      for (const cl of claims) want.unshift([cl.product_img, 'chase_claim', TASK.chase_claim + ' #' + cl.id]);
      // Claims first, then by stock value: a list people can work through, not every part at once.
      const limit = Math.min(500, Math.max(1, parseInt((req.body || {}).limit, 10) || 100));
      let made = 0;
      for (const [img, kind, title] of want) {
        if (made >= limit) break;
        const { rowCount } = await query(`INSERT INTO marketing_tasks (product_img, kind, title, created_by) VALUES ($1,$2,$3,$4) ON CONFLICT (product_img, kind) WHERE status = 'open' DO NOTHING`, [img, kind, title.slice(0, 200), req.session.userId]);
        made += rowCount;
      }
      res.json({ ok: true, made, considered: want.length });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/stockcash/tasks', ...M, async (req, res) => {
    try {
      const b = req.body || {};
      const kind = TASK[b.kind] ? b.kind : 'other';
      const title = String(b.title || TASK[kind]).trim().slice(0, 200);
      const { rows } = await query(`INSERT INTO marketing_tasks (product_img, kind, title, assigned_to, due_on, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (product_img, kind) WHERE status = 'open' DO NOTHING RETURNING id`,
        [b.img || null, kind, title, parseInt(b.assigned_to, 10) || null, /^\d{4}-\d{2}-\d{2}$/.test(b.due_on || '') ? b.due_on : null, String(b.note || '').slice(0, 300) || null, req.session.userId]);
      if (!rows.length) throw httpError(409, 'There is already an open task like this for that part');
      res.json({ ok: true, id: rows[0].id });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/stockcash/tasks/:id', ...M, async (req, res) => {
    try {
      const b = req.body || {};
      const sets = [], vals = [parseInt(req.params.id, 10)];
      if (b.status !== undefined) {
        if (!['open', 'done', 'skipped'].includes(b.status)) throw httpError(400, 'Status');
        vals.push(b.status); sets.push('status = $' + vals.length);
        vals.push(b.status === 'open' ? null : req.session.userId); sets.push('done_by = $' + vals.length);
        sets.push(b.status === 'open' ? 'done_at = NULL' : 'done_at = NOW()');
      }
      if (b.assigned_to !== undefined) { vals.push(parseInt(b.assigned_to, 10) || null); sets.push('assigned_to = $' + vals.length); }
      if (b.due_on !== undefined) { vals.push(/^\d{4}-\d{2}-\d{2}$/.test(b.due_on || '') ? b.due_on : null); sets.push('due_on = $' + vals.length); }
      if (b.note !== undefined) { vals.push(String(b.note || '').slice(0, 300) || null); sets.push('note = $' + vals.length); }
      if (!sets.length) throw httpError(400, 'Nothing to change');
      const { rowCount } = await query(`UPDATE marketing_tasks SET ${sets.join(', ')} WHERE id = $1`, vals);
      if (!rowCount) throw httpError(404, 'Task not found');
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // -------------------------------------------------------- campaigns --
  // Only customers who said yes to that channel, never staff, never the
  // placeholder addresses imported customers carry.
  function audienceSql(channel, a) {
    const where = [`NOT u.is_staff`, `NOT COALESCE(u.is_admin, false)`, `NOT u.disabled`], vals = [];
    if (channel === 'email') where.push(`u.email_opt_in`, `u.email LIKE '%@%'`, `u.email NOT ILIKE '%.local'`);
    else where.push(`u.sms_opt_in`, `length(regexp_replace(COALESCE(u.phone, ''), '[^0-9]', '', 'g')) >= 7`);
    a = a || {};
    if (a.type === 'tier') {
      if (!['retail', 'trade', 'fleet', 'dealer'].includes(a.tier)) throw httpError(400, 'Which price tier?');
      vals.push(a.tier); where.push(a.tier === 'retail' ? `COALESCE(u.price_tier, 'retail') = $${vals.length}` : `u.price_tier = $${vals.length}`);
    }
    if (a.type === 'bought') {
      const cats = (Array.isArray(a.categories) ? a.categories : []).map(String).filter(Boolean).slice(0, 50);
      const makes = (Array.isArray(a.makes) ? a.makes : []).map(String).filter(Boolean).slice(0, 50);
      if (!cats.length && !makes.length) throw httpError(400, 'Choose categories or vehicles they bought for');
      vals.push(cats); const ci = vals.length; vals.push(makes.map((m) => '%' + m + '%')); const mi = vals.length;
      where.push(`EXISTS (SELECT 1 FROM pos_sales ps JOIN pos_sale_items i ON i.sale_id = ps.id JOIN products p ON p.img = i.product_img
                   WHERE ps.customer_id = u.id AND NOT COALESCE(ps.voided, false) AND (p.category = ANY($${ci}) OR p.make_model ILIKE ANY($${mi})))`);
    }
    return { sql: `SELECT u.id, u.name, u.email, u.phone FROM users u WHERE ${where.join(' AND ')} ORDER BY u.id LIMIT 5000`, vals };
  }
  const CHANNELS = ['email', 'sms', 'whatsapp'];
  const consentOf = (ch) => (ch === 'email' ? 'email' : 'sms');   // WhatsApp counts as a text message
  app.post('/api/stockcash/campaigns/preview', ...M, async (req, res) => {
    try {
      const b = req.body || {};
      if (!CHANNELS.includes(b.channel)) throw httpError(400, 'Email, SMS or WhatsApp?');
      const a = audienceSql(consentOf(b.channel), b.audience);
      const { rows } = await query(a.sql, a.vals);
      const { rows: all } = await query(`SELECT COUNT(*)::int AS n FROM users WHERE NOT is_staff AND NOT COALESCE(is_admin, false) AND NOT disabled`);
      res.json({ recipients: rows.length, customers: all[0].n, sample: rows.slice(0, 5).map((r) => r.name) });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/stockcash/campaigns', ...M, async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT c.id, c.name, c.kind, c.status, c.created_at, c.sent_at, c.recipients_count, c.sent_count, c.failed_count, c.views, c.coupon_code, c.audience, c.body,
                jsonb_array_length(COALESCE(c.items, '[]')) AS item_count, cp.redeemed_count
           FROM marketing_campaigns c LEFT JOIN coupons cp ON cp.code = c.coupon_code WHERE c.segment = 'stockcash' ORDER BY c.id DESC LIMIT 100`);
      res.json({ campaigns: rows });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/stockcash/campaigns', ...M, async (req, res) => {
    try {
      const b = req.body || {};
      if (!CHANNELS.includes(b.channel)) throw httpError(400, 'Email, SMS or WhatsApp?');
      const name = String(b.name || '').trim().slice(0, 100), body = String(b.body || '').trim().slice(0, 2000);
      if (!name || !body) throw httpError(400, 'Name and message');
      if (b.channel !== 'email' && body.length > 600) throw httpError(400, 'Keep a text message under 600 characters');
      if (!/\{link\}/.test(body)) throw httpError(400, 'Put {link} in the message: it opens the clearance page');
      audienceSql(consentOf(b.channel), b.audience);   // validates the audience
      const items = imgsOf(b).slice(0, 200);
      let code = null;
      if (b.coupon && n(b.coupon.pct) > 0) {
        const pct = n(b.coupon.pct), days = Math.max(1, Math.min(90, parseInt(b.coupon.days, 10) || 14));
        if (!(pct <= 50)) throw httpError(400, 'Coupon 1 to 50%');
        code = 'CLR' + crypto.randomBytes(3).toString('hex').toUpperCase();
        await query(`INSERT INTO coupons (code, kind, amount, min_subtotal, max_redemptions, expires_at, description, is_active, scope)
                     VALUES ($1, 'percent', $2, 0, $3, NOW() + make_interval(days => $4), $5, true, 'clearance')`,
          [code, pct, parseInt(b.coupon.max, 10) || null, days, 'Campaign: ' + name]);
      }
      const { rows } = await query(
        `INSERT INTO marketing_campaigns (name, kind, subject, body, segment, status, created_by, coupon_code, audience, items)
         VALUES ($1,$2,$3,$4,'stockcash','draft',$5,$6,$7,$8) RETURNING id`,
        [name, b.channel, String(b.subject || '').slice(0, 150) || name, body, req.session.userId, code, JSON.stringify(b.audience || { type: 'all' }), JSON.stringify(items)]);
      res.json({ ok: true, id: rows[0].id, coupon_code: code });
    } catch (e) { fail(res, e); }
  });
  const fill = (text, r, link, code) => text.replace(/\{name\}/g, String(r.name || '').split(' ')[0] || 'there').replace(/\{link\}/g, link).replace(/\{code\}/g, code || '');
  const waUrl = (phone, text) => { const d = String(phone || '').replace(/[^0-9]/g, ''); return 'https://wa.me/' + (d.length === 7 ? '1876' + d : d.length === 10 ? '1' + d : d) + '?text=' + encodeURIComponent(text); };
  app.post('/api/stockcash/campaigns/:id/send', ...M, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      // Claimed first, so two clicks cannot send twice.
      const { rows: cl } = await query(`UPDATE marketing_campaigns SET status = 'sending' WHERE id = $1 AND segment = 'stockcash' AND status IN ('draft', 'scheduled') RETURNING *`, [id]);
      if (!cl.length) throw httpError(409, 'Already sent or sending');
      const c = cl[0];
      const shop = (getShopName && await getShopName()) || 'Vision Auto Solutions';
      const link = (await baseUrl(req)) + '/clearance.html?c=' + id;
      const a = audienceSql(consentOf(c.kind), c.audience);
      const { rows: people } = await query(a.sql, a.vals);
      const esc = (v) => String(v).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
      let sent = 0, failed = 0;
      const share = [];
      for (const r of people) {
        let status = 'sent', detail = null;
        try {
          const msg = fill(c.body, r, link, c.coupon_code);
          if (c.kind === 'email') {
            const un = await unsubLink(req, r.id, 'email');
            await mailer.sendEmail({ to: r.email, subject: c.subject || c.name,
              text: msg + '\n\n--\n' + shop + '\nYou get this because you asked for our offers. Unsubscribe: ' + un,
              html: '<p>' + esc(msg).replace(/\n/g, '<br>').split(esc(link)).join('<a href="' + esc(link) + '">' + esc(link) + '</a>') + '</p>' +
                '<p style="color:#888;font-size:12px">' + esc(shop) + '. You get this because you asked for our offers. <a href="' + esc(un) + '">Unsubscribe</a></p>' });
            sent++;
          } else if (c.kind === 'sms') {
            await sms.sendSMS({ to: r.phone, body: msg + ' Stop: ' + (await unsubLink(req, r.id, 'sms')) });
            sent++;
          } else {
            // No WhatsApp sending account: one-tap chats for staff to send by hand.
            status = 'share';
            share.push({ name: r.name, phone: r.phone, url: waUrl(r.phone, msg) });
          }
        } catch (e) { status = 'failed'; detail = String(e.message).slice(0, 200); failed++; }
        await query(`INSERT INTO marketing_campaign_recipients (campaign_id, user_id, channel, status, detail) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [id, r.id, c.kind, status, detail]);
      }
      await query(`UPDATE marketing_campaigns SET status = 'sent', sent_at = NOW(), recipients_count = $2, sent_count = $3, failed_count = $4 WHERE id = $1`, [id, people.length, sent, failed]);
      res.json({ ok: true, recipients: people.length, sent, failed, share });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/stockcash/campaigns/:id/share', ...M, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const { rows: c } = await query(`SELECT * FROM marketing_campaigns WHERE id = $1`, [id]);
      if (!c.length) throw httpError(404, 'Campaign not found');
      const link = (await baseUrl(req)) + '/clearance.html?c=' + id;
      // Re-checked: anyone who opted out since is left off.
      const { rows } = await query(`SELECT u.id, u.name, u.phone FROM marketing_campaign_recipients r JOIN users u ON u.id = r.user_id WHERE r.campaign_id = $1 AND r.status = 'share' AND u.sms_opt_in ORDER BY u.name`, [id]);
      res.json({ share: rows.map((r) => ({ name: r.name, phone: r.phone, url: waUrl(r.phone, fill(c[0].body, r, link, c[0].coupon_code)) })) });
    } catch (e) { fail(res, e); }
  });

  // --------------------------------------------------------- settings --
  app.put('/api/stockcash/settings', ...M, async (req, res) => {
    try {
      const b = req.body || {};
      const nums = [['months', 'mkt_overstock_months', 1, 60], ['slow', 'mkt_slow_days', 30, 1000], ['dead', 'mkt_dead_days', 60, 3000], ['ladder_days', 'mkt_ladder_days', 1, 365],
        ['open_box_pct', 'mkt_open_box_pct', 0, 90], ['damaged_pct', 'mkt_damaged_pct', 0, 95], ['boost_pct', 'mkt_boost_pct', 0.5, 50]];
      const cur = await settings();
      const slow = b.slow !== undefined ? Number(b.slow) : cur.slow, dead = b.dead !== undefined ? Number(b.dead) : cur.dead;
      if (!(dead > slow)) throw httpError(400, 'Dead must be longer than aged');
      for (const [k, key, lo, hi] of nums) {
        if (b[k] === undefined) continue;
        const v = Number(b[k]);
        if (!(v >= lo && v <= hi)) throw httpError(400, k + ' must be ' + lo + ' to ' + hi);
        await put(key, v);
      }
      if (b.ladder !== undefined) {
        const l = String(b.ladder).split(',').map((x) => parseFloat(x)).filter((x) => x > 0);
        if (!l.length || l.some((x) => !(x < 95)) || l.some((x, i) => i && x <= l[i - 1])) throw httpError(400, 'Ladder like 10,20,30 (rising, under 95)');
        await put('mkt_ladder', l.join(','));
      }
      invalidate();
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  return { unsubLink, invalidate };
}

module.exports = { register };
