// =============================================================================
//  Vision Auto Solutions -- Franchise store network (the parts-retail model)
//
//  Mounted by franchise.js (same permission, franchise.manage). Screens: the
//  "Store network" tabs of franchise.html and the store's own page
//  (franchisee.html?p=...). Tables in schema.sql ("FRANCHISE STORE NETWORK").
//
//  How an auto-parts network runs, and what each part of this file does:
//    * Three kinds of store share one system: franchised stores, affiliate
//      (independent dealer-member) stores that keep their own name and buy
//      through the network, and company-owned stores (store_type).
//    * Distribution centres (DCs) supply every store. Hub stores carry deeper
//      stock and send parts to the spoke stores near them the same day ("hot
//      shot"). Parts availability looks in the store, then its hub, then its DC.
//    * One network catalogue: part numbers, brands, interchange numbers, what
//      each part fits (make, model, years, engine), the dealer cost a store
//      pays the DC and the list price; price tiers set retail, loyalty and
//      pro (commercial) prices, never below a floor over dealer cost.
//    * Stock at each DC and store with min and max levels; the replenishment
//      list orders back up to the max. Supply orders are invoiced to the store
//      in Receivables when shipped (4610 franchise_supply) and add to its stock
//      when received; the share of lines shipped is the fill rate.
//    * Commercial (do-it-for-me) sales: garage and fleet accounts with a tier,
//      credit limit and terms, served on delivery routes.
//    * Programmes: the purchasing commitment (share of buying through the DC),
//      quarterly purchasing rebates, the co-op advertising allowance and its
//      claims, and money the network owes stores (fr_credits: rebates, co-op,
//      loyalty points redeemed). Credits are settled by cheque, transfer or set
//      against invoices through Banking/Receivables and recorded here.
//    * Required systems at each store and staff certification (parts
//      specialist levels and the rest), each counted on the scorecard.
//    * The scorecard: net sales, sales per sq ft, commercial share, average
//      sale, gross margin, inventory turns, shrink, fill rate, DC share,
//      delivery time, certification and systems, against the targets.
// =============================================================================
'use strict';

const COMM_KINDS = { garage: 'Garage', fleet: 'Fleet', dealer: 'Dealer', government: 'Government', body_shop: 'Body shop', other: 'Other' };
const ORDER_KINDS = { stock: 'Stock order', special: 'Special order', hot: 'Hot shot from the hub' };
const ROLES = { hub: 'Hub', spoke: 'Spoke', standalone: 'Stand-alone' };

function register(app, deps, h) {
  const { query, getPool } = deps;
  const { M, me, fail, httpError, t, d, n, r2, amt, money, today, addDays, monthName, DATE, settings, frRow, log, invoice, accountFor, ensureCustomer, byPortal, noStore, STORE_TYPES, SYSTEMS } = h;
  const int = (v, lo, hi) => { const x = parseInt(v, 10); return Number.isFinite(x) && x >= (lo == null ? -Infinity : lo) && x <= (hi == null ? Infinity : hi) ? x : null; };
  const pctIn = (v, label, max) => { if (v == null || v === '') return null; const x = Number(v); if (!(Number.isFinite(x) && x >= 0 && x <= (max || 100))) throw httpError(400, label + ': 0 to ' + (max || 100)); return x; };
  const SYS = new Set(SYSTEMS.map((s) => s[0]));
  const LIVE = `('onboarding', 'open', 'suspended')`;
  const nameOf = (f) => f.trading_name || f.legal_name;
  async function tx(fn) {
    const c = await getPool().connect();
    try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  }
  const unique = (msg) => (e) => { if (e.code === '23505') throw httpError(409, msg); throw e; };
  // Jamaica time of day, for the DC cut-off.
  const hhmmNow = () => new Date(Date.now() - 5 * 3600000).toISOString().slice(11, 16);
  function quarter(q) {
    const m = /^(\d{4})-Q([1-4])$/.exec(String(q || ''));
    if (!m) return null;
    const from = m[1] + '-' + String((+m[2] - 1) * 3 + 1).padStart(2, '0') + '-01';
    return { key: m[0], from, to: h.addMonths(from, 3) };
  }
  function tierPrice(item, tier) {
    const list = Number(item.list_price || 0), cost = Number(item.dealer_cost || 0);
    if (!tier) return r2(list);
    const floor = cost * (1 + Number(tier.floor_pct || 0) / 100);
    return r2(Math.min(list || floor, Math.max(list * (1 - Number(tier.discount_pct || 0) / 100), floor)));
  }

  // =================================================================== meta ==
  app.get('/api/franchise/network/meta', ...M, async (req, res) => {
    try {
      const [dcs, formats, tiers, rebates, programs, stores, att] = await Promise.all([
        query(`SELECT d.*, (SELECT COUNT(*)::int FROM fr_franchisees f WHERE f.dc_id = d.id AND f.status IN ${LIVE}) AS stores FROM fr_dcs d ORDER BY d.code`),
        query(`SELECT key, name, description, sq_ft_min, sq_ft_max, sku_target, staff, investment_low::float AS investment_low, investment_high::float AS investment_high, sort FROM fr_formats ORDER BY sort, key`),
        query(`SELECT id, code, name, kind, discount_pct::float AS discount_pct, floor_pct::float AS floor_pct, min_monthly::float AS min_monthly, description, sort FROM fr_price_tiers ORDER BY sort, code`),
        query(`SELECT id, min_quarter::float AS min_quarter, rebate_pct::float AS rebate_pct FROM fr_rebate_tiers ORDER BY min_quarter`),
        query(`SELECT * FROM fr_cert_programs ORDER BY sort, code`),
        query(`SELECT f.id, f.number, COALESCE(f.trading_name, f.legal_name) AS name, f.store_type, f.network_role, f.format_key, f.dc_id, f.hub_id, f.sq_ft, f.status
          FROM fr_franchisees f WHERE f.status IN ${LIVE} ORDER BY f.number`),
        attention()]);
      res.json({ dcs: dcs.rows, formats: formats.rows, tiers: tiers.rows, rebate_tiers: rebates.rows, programs: programs.rows, stores: stores.rows, attention: att,
        systems: SYSTEMS, store_types: STORE_TYPES, roles: ROLES, comm_kinds: COMM_KINDS, order_kinds: ORDER_KINDS });
    } catch (e) { fail(res, e); }
  });
  async function attention() {
    const [orders, claims, credits, certs, systems] = await Promise.all([
      query(`SELECT COUNT(*)::int AS c, COUNT(*) FILTER (WHERE kind = 'hot')::int AS hot FROM fr_supply_orders WHERE status = 'submitted'`),
      query(`SELECT COUNT(*)::int AS c FROM fr_coop_claims WHERE status = 'submitted'`),
      query(`SELECT COUNT(*)::int AS c, COALESCE(SUM(amount), 0)::float AS amount FROM fr_credits WHERE status = 'owed'`),
      query(`SELECT COUNT(*)::int AS c FROM fr_staff_certs WHERE revoked_at IS NULL AND expires_on BETWEEN CURRENT_DATE AND CURRENT_DATE + 30`),
      query(`SELECT COUNT(*)::int AS c FROM fr_franchisees f WHERE f.status IN ('onboarding', 'open') AND
        (SELECT COUNT(*) FROM fr_store_systems s WHERE s.franchisee_id = f.id AND s.status IN ('verified', 'not_needed')) < $1`, [SYSTEMS.length])]);
    return { orders_waiting: orders.rows[0].c, hot_waiting: orders.rows[0].hot, claims_waiting: claims.rows[0].c, credits_owed: credits.rows[0].c, credits_amount: credits.rows[0].amount,
      certs_expiring: certs.rows[0].c, stores_missing_systems: systems.rows[0].c };
  }

  // ========================================================== DCs, formats ==
  function dcInput(b) {
    const code = t(b.code, 20), name = t(b.name, 120);
    if (!code || !name) throw httpError(400, 'A code and a name for the distribution centre');
    const cutoff = t(b.cutoff_time, 5) || '14:00';
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(cutoff)) throw httpError(400, 'Cut-off time as HH:MM, for example 14:00');
    return [code.toUpperCase(), name, t(b.address, 500), t(b.parish, 60), t(b.manager, 120), t(b.phone, 60), cutoff, t(b.delivery_days, 60) || 'Mon-Sat', int(b.runs_per_day, 1, 12) || 1, b.active !== false, t(b.notes, 2000)];
  }
  app.post('/api/franchise/network/dcs', ...M, async (req, res) => {
    try {
      const { rows } = await query(`INSERT INTO fr_dcs (code, name, address, parish, manager, phone, cutoff_time, delivery_days, runs_per_day, active, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`, dcInput(req.body || {}))
        .catch(unique('That DC code is already used'));
      await log({ action: 'distribution centre added', detail: req.body.name }, req);
      res.json({ ok: true, id: rows[0].id });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/franchise/network/dcs/:id(\\d+)', ...M, async (req, res) => {
    try {
      const { rowCount } = await query(`UPDATE fr_dcs SET code = $2, name = $3, address = $4, parish = $5, manager = $6, phone = $7, cutoff_time = $8, delivery_days = $9, runs_per_day = $10, active = $11, notes = $12 WHERE id = $1`,
        [n(req.params.id)].concat(dcInput(req.body || {}))).catch(unique('That DC code is already used'));
      if (!rowCount) throw httpError(404, 'Distribution centre not found');
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/franchise/network/formats/:key', ...M, async (req, res) => {
    try {
      const key = String(req.params.key || '').toLowerCase();
      if (!/^[a-z0-9_-]{2,30}$/.test(key)) throw httpError(400, 'Format key: 2 to 30 letters, numbers or dashes');
      const b = req.body || {};
      const name = t(b.name, 120); if (!name) throw httpError(400, 'The format name');
      await query(`INSERT INTO fr_formats (key, name, description, sq_ft_min, sq_ft_max, sku_target, staff, investment_low, investment_high, sort) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, sq_ft_min = EXCLUDED.sq_ft_min, sq_ft_max = EXCLUDED.sq_ft_max, sku_target = EXCLUDED.sku_target,
          staff = EXCLUDED.staff, investment_low = EXCLUDED.investment_low, investment_high = EXCLUDED.investment_high, sort = EXCLUDED.sort`,
        [key, name, t(b.description, 2000), int(b.sq_ft_min, 0), int(b.sq_ft_max, 0), int(b.sku_target, 0), int(b.staff, 0), amt(b.investment_low), amt(b.investment_high), int(b.sort, 0) || 100]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ================================================================ stores ==
  app.get('/api/franchise/network/stores', ...M, async (req, res) => {
    try {
      const { rows } = await query(`SELECT f.id, f.number, COALESCE(f.trading_name, f.legal_name) AS name, f.legal_name, f.status, f.store_type, f.network_role, f.format_key, fm.name AS format_name,
          f.dc_id, dc.code AS dc_code, f.hub_id, COALESCE(hb.trading_name, hb.legal_name) AS hub_name, f.sq_ft, t.name AS territory_name, ${DATE('f.opened_on')} AS opened_on,
          (SELECT COUNT(*)::int FROM fr_franchisees s WHERE s.hub_id = f.id AND s.status IN ${LIVE}) AS spokes,
          (SELECT COUNT(*)::int FROM fr_store_systems s WHERE s.franchisee_id = f.id AND s.status IN ('verified', 'not_needed')) AS systems_ok,
          (SELECT COUNT(*)::int FROM fr_commercial_accounts a WHERE a.franchisee_id = f.id AND a.status = 'active') AS accounts,
          (SELECT COUNT(*)::int FROM fr_routes r WHERE r.franchisee_id = f.id AND r.active) AS routes,
          (SELECT COUNT(*)::int FROM fr_staff_certs c WHERE c.franchisee_id = f.id AND c.revoked_at IS NULL AND (c.expires_on IS NULL OR c.expires_on >= CURRENT_DATE)) AS certs,
          (SELECT COUNT(*)::int FROM fr_stock k WHERE k.franchisee_id = f.id AND k.min_qty IS NOT NULL AND k.on_hand < k.min_qty) AS below_min
        FROM fr_franchisees f LEFT JOIN fr_formats fm ON fm.key = f.format_key LEFT JOIN fr_dcs dc ON dc.id = f.dc_id LEFT JOIN fr_franchisees hb ON hb.id = f.hub_id
          LEFT JOIN fr_territories t ON t.id = f.territory_id
        WHERE f.status IN ${LIVE} OR $1 ORDER BY f.network_role = 'hub' DESC, f.number`, [req.query.all === '1']);
      res.json({ stores: rows, systems_total: SYSTEMS.length });
    } catch (e) { fail(res, e); }
  });
  // Where a store sits in the network: format, hub or spoke, its DC and hub.
  app.post('/api/franchise/network/stores/:id(\\d+)/placement', ...M, async (req, res) => {
    try {
      const f = await frRow(req.params.id);
      const b = req.body || {};
      const role = ['hub', 'spoke', 'standalone'].includes(b.network_role) ? b.network_role : 'standalone';
      const dc = n(b.dc_id), hub = role === 'spoke' ? n(b.hub_id) : null, fmt = t(b.format_key, 40);
      if (dc && !(await query(`SELECT 1 FROM fr_dcs WHERE id = $1`, [dc])).rows.length) throw httpError(400, 'Unknown distribution centre');
      if (fmt && !(await query(`SELECT 1 FROM fr_formats WHERE key = $1`, [fmt])).rows.length) throw httpError(400, 'Unknown store format');
      if (role === 'spoke') {
        if (!hub) throw httpError(400, 'Which hub store serves this spoke?');
        if (hub === f.id) throw httpError(400, 'A store cannot be its own hub');
        const { rows } = await query(`SELECT network_role, status FROM fr_franchisees WHERE id = $1`, [hub]);
        if (!rows.length || rows[0].network_role !== 'hub') throw httpError(400, 'That store is not a hub; make it a hub first');
      }
      if (role !== 'hub' && f.network_role === 'hub') {
        const { rows } = await query(`SELECT COUNT(*)::int AS c FROM fr_franchisees WHERE hub_id = $1 AND status IN ${LIVE}`, [f.id]);
        if (rows[0].c) throw httpError(409, 'This hub still serves ' + rows[0].c + ' spoke store(s); move them to another hub first');
      }
      const sq = b.sq_ft === '' || b.sq_ft == null ? null : int(b.sq_ft, 100, 200000);
      if (b.sq_ft !== '' && b.sq_ft != null && sq == null) throw httpError(400, 'Floor area: 100 to 200,000 sq ft');
      await query(`UPDATE fr_franchisees SET network_role = $2, dc_id = $3, hub_id = $4, format_key = $5, sq_ft = $6, updated_at = NOW() WHERE id = $1`, [f.id, role, dc, hub, fmt, sq]);
      if (dc && (role !== 'spoke' || hub)) await query(`UPDATE fr_tasks SET done_at = NOW(), done_by = $2, note = COALESCE(note, 'Set on the network screen') WHERE franchisee_id = $1 AND done_at IS NULL AND title LIKE 'Distribution centre account set up%'`, [f.id, me(req)]);
      await log({ franchisee_id: f.id, action: 'network placement', detail: [ROLES[role], fmt, dc ? 'DC ' + dc : null].filter(Boolean).join(', ') }, req);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  // ------------------------------------------------------- required systems --
  async function systemsOf(id) {
    const { rows } = await query(`SELECT s.system_key, s.status, s.detail, s.checked_at, COALESCE(NULLIF(u.name, ''), u.email) AS checked_by_name FROM fr_store_systems s LEFT JOIN users u ON u.id = s.checked_by WHERE s.franchisee_id = $1`, [id]);
    const by = Object.fromEntries(rows.map((r) => [r.system_key, r]));
    return SYSTEMS.map(([key, name, what]) => Object.assign({ key, name, what, status: 'missing' }, by[key] || {}, { key }));
  }
  app.get('/api/franchise/network/stores/:id(\\d+)/systems', ...M, async (req, res) => {
    try { const f = await frRow(req.params.id); res.json({ systems: await systemsOf(f.id) }); } catch (e) { fail(res, e); }
  });
  app.put('/api/franchise/network/stores/:id(\\d+)/systems/:key', ...M, async (req, res) => {
    try {
      const f = await frRow(req.params.id);
      const key = String(req.params.key);
      if (!SYS.has(key)) throw httpError(404, 'Unknown system');
      const b = req.body || {};
      const status = ['missing', 'installed', 'verified', 'not_needed'].includes(b.status) ? b.status : null;
      if (!status) throw httpError(400, 'Missing, installed, verified or not needed');
      await query(`INSERT INTO fr_store_systems (franchisee_id, system_key, status, detail, checked_at, checked_by) VALUES ($1,$2,$3,$4,NOW(),$5)
        ON CONFLICT (franchisee_id, system_key) DO UPDATE SET status = EXCLUDED.status, detail = COALESCE(EXCLUDED.detail, fr_store_systems.detail), checked_at = NOW(), checked_by = EXCLUDED.checked_by`,
        [f.id, key, status, t(b.detail, 300), me(req)]);
      const list = await systemsOf(f.id);
      const done = list.every((x) => x.status === 'verified' || x.status === 'not_needed');
      if (done) await query(`UPDATE fr_tasks SET done_at = NOW(), done_by = $2 WHERE franchisee_id = $1 AND done_at IS NULL AND title LIKE 'Required systems installed%'`, [f.id, me(req)]);
      await log({ franchisee_id: f.id, action: 'system ' + status.replace('_', ' '), detail: SYSTEMS.find((s) => s[0] === key)[1] }, req);
      res.json({ ok: true, all_verified: done });
    } catch (e) { fail(res, e); }
  });

  // ============================================================= catalogue ==
  const ITEM = `c.id, c.sku, c.part_number, c.brand, c.description, c.category, c.interchange, c.dealer_cost::float AS dealer_cost, c.list_price::float AS list_price,
    c.core_charge::float AS core_charge, c.warranty_months, c.stocking, c.active, c.product_id,
    (SELECT string_agg(trim(concat_ws(' ', x.make, x.model, CASE WHEN x.year_from IS NOT NULL OR x.year_to IS NOT NULL THEN concat(COALESCE(x.year_from::text, ''), '-', COALESCE(x.year_to::text, '')) END, x.engine)), '; ' ORDER BY x.make, x.model, x.year_from)
       FROM fr_fitment x WHERE x.catalogue_id = c.id) AS fits`;
  // Search by words, part or interchange number, and by vehicle.
  async function search(q, limit) {
    const where = [], args = [];
    if (!q.all) where.push('c.active');
    if (q.q) {
      const words = String(q.q).trim().split(/\s+/).slice(0, 6);
      for (const w of words) { args.push('%' + w + '%'); const i = args.length; where.push(`(c.sku ILIKE $${i} OR c.part_number ILIKE $${i} OR c.description ILIKE $${i} OR c.brand ILIKE $${i} OR c.interchange ILIKE $${i} OR c.category ILIKE $${i})`); }
    }
    if (q.category) { args.push(String(q.category)); where.push(`c.category = $${args.length}`); }
    if (q.make) {
      args.push(String(q.make).trim().toLowerCase()); const mk = args.length;
      let fit = `lower(x.make) = $${mk}`;
      if (q.model) { args.push('%' + String(q.model).trim() + '%'); fit += ` AND (x.model IS NULL OR x.model ILIKE $${args.length})`; }
      const yr = int(q.year, 1900, 2100);
      if (yr) { args.push(yr); fit += ` AND $${args.length} BETWEEN COALESCE(x.year_from, 1900) AND COALESCE(x.year_to, 2100)`; }
      where.push(`EXISTS (SELECT 1 FROM fr_fitment x WHERE x.catalogue_id = c.id AND ${fit})`);
    }
    args.push(Math.max(1, Math.min(500, limit || 100)));
    const { rows } = await query(`SELECT ${ITEM}, (SELECT COALESCE(SUM(on_hand), 0)::int FROM fr_stock k WHERE k.catalogue_id = c.id AND k.dc_id IS NOT NULL) AS dc_on_hand
      FROM fr_catalogue c ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY c.category NULLS LAST, c.description LIMIT $${args.length}`, args);
    return rows;
  }
  app.get('/api/franchise/network/catalogue', ...M, async (req, res) => {
    try {
      const items = await search(req.query, int(req.query.limit, 1, 500) || 100);
      const tierId = n(req.query.tier_id);
      if (tierId) {
        const { rows } = await query(`SELECT * FROM fr_price_tiers WHERE id = $1`, [tierId]);
        if (rows[0]) items.forEach((i) => { i.tier_price = tierPrice(i, rows[0]); });
      }
      const { rows: cats } = await query(`SELECT category, COUNT(*)::int AS c FROM fr_catalogue WHERE active AND category IS NOT NULL GROUP BY 1 ORDER BY 1`);
      const { rows: makes } = await query(`SELECT DISTINCT make FROM fr_fitment ORDER BY 1 LIMIT 300`);
      res.json({ items, categories: cats, makes: makes.map((m) => m.make) });
    } catch (e) { fail(res, e); }
  });
  async function itemRow(id) {
    const { rows } = await query(`SELECT ${ITEM} FROM fr_catalogue c WHERE c.id = $1`, [n(id)]);
    if (!rows.length) throw httpError(404, 'Part not found');
    return rows[0];
  }
  app.get('/api/franchise/network/catalogue/:id(\\d+)', ...M, async (req, res) => {
    try {
      const item = await itemRow(req.params.id);
      const [fit, stock, tiers] = await Promise.all([
        query(`SELECT id, make, model, year_from, year_to, engine, note FROM fr_fitment WHERE catalogue_id = $1 ORDER BY make, model, year_from`, [item.id]),
        query(`SELECT k.on_hand, k.min_qty, k.max_qty, k.dc_id, d.code AS dc_code, d.name AS dc_name, k.franchisee_id, COALESCE(f.trading_name, f.legal_name) AS store_name, f.network_role
          FROM fr_stock k LEFT JOIN fr_dcs d ON d.id = k.dc_id LEFT JOIN fr_franchisees f ON f.id = k.franchisee_id WHERE k.catalogue_id = $1 ORDER BY k.dc_id IS NULL, 3 DESC`, [item.id]),
        query(`SELECT * FROM fr_price_tiers ORDER BY sort, code`)]);
      res.json({ item, fitment: fit.rows, stock: stock.rows, prices: tiers.rows.map((x) => ({ tier_id: x.id, code: x.code, name: x.name, price: tierPrice(item, x) })) });
    } catch (e) { fail(res, e); }
  });
  function itemInput(b) {
    const sku = t(b.sku, 60), description = t(b.description, 300);
    if (!sku || !description) throw httpError(400, 'A SKU and a description');
    const cost = amt(b.dealer_cost), list = amt(b.list_price);
    if (cost == null || list == null) throw httpError(400, 'The dealer cost and the list price (J$)');
    if (list && list < cost) throw httpError(400, 'The list price is below the dealer cost');
    const stocking = ['store', 'hub', 'dc'].includes(b.stocking) ? b.stocking : 'store';
    const fit = (Array.isArray(b.fitment) ? b.fitment : []).slice(0, 200).map((x) => ({ make: t(x.make, 60), model: t(x.model, 80), year_from: int(x.year_from, 1900, 2100), year_to: int(x.year_to, 1900, 2100), engine: t(x.engine, 60), note: t(x.note, 200) }))
      .filter((x) => x.make);
    for (const x of fit) if (x.year_from && x.year_to && x.year_from > x.year_to) throw httpError(400, 'Fitment years: the first year is after the last (' + x.make + ' ' + (x.model || '') + ')');
    return { cols: { sku: sku.toUpperCase(), part_number: t(b.part_number, 60), brand: t(b.brand, 80), description, category: t(b.category, 80), interchange: t(b.interchange, 500), dealer_cost: cost, list_price: list,
      core_charge: amt(b.core_charge) || 0, warranty_months: int(b.warranty_months, 0, 600), stocking, active: b.active !== false }, fit };
  }
  async function saveFitment(c, id, fit) {
    await c.query(`DELETE FROM fr_fitment WHERE catalogue_id = $1`, [id]);
    for (const x of fit) await c.query(`INSERT INTO fr_fitment (catalogue_id, make, model, year_from, year_to, engine, note) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, x.make, x.model, x.year_from, x.year_to, x.engine, x.note]);
  }
  app.post('/api/franchise/network/catalogue', ...M, async (req, res) => {
    try {
      const { cols, fit } = itemInput(req.body || {});
      const k = Object.keys(cols);
      const id = await tx(async (c) => {
        const { rows } = await c.query(`INSERT INTO fr_catalogue (${k.join(', ')}) VALUES (${k.map((_, i) => '$' + (i + 1)).join(', ')}) RETURNING id`, k.map((x) => cols[x])).catch(unique('That SKU is already in the catalogue'));
        await saveFitment(c, rows[0].id, fit);
        return rows[0].id;
      });
      res.json({ ok: true, id });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/franchise/network/catalogue/:id(\\d+)', ...M, async (req, res) => {
    try {
      const item = await itemRow(req.params.id);
      const { cols, fit } = itemInput(req.body || {});
      const k = Object.keys(cols);
      await tx(async (c) => {
        await c.query(`UPDATE fr_catalogue SET ${k.map((x, i) => x + ' = $' + (i + 2)).join(', ')}, updated_at = NOW() WHERE id = $1`, [item.id].concat(k.map((x) => cols[x]))).catch(unique('That SKU is already in the catalogue'));
        if ('fitment' in (req.body || {})) await saveFitment(c, item.id, fit);
      });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  // From the till's own products: name, SKU, cost, price, core charge, warranty and "make model years".
  app.post('/api/franchise/network/catalogue/import', ...M, async (req, res) => {
    try {
      // One statement for the parts (a SKU already in the catalogue is skipped), then one for what they fit.
      const ins = await tx(async (c) => {
        const { rows } = await c.query(`INSERT INTO fr_catalogue (sku, part_number, description, category, dealer_cost, list_price, core_charge, warranty_months, product_id)
          SELECT DISTINCT ON (x.sku) x.sku, p.supplier_part_no, left(p.name, 300), p.category,
            ROUND(CASE WHEN p.cost_usd IS NULL THEN COALESCE(p.price_usd, 0) * 0.6 WHEN COALESCE(p.price_usd, 0) > 0 THEN LEAST(p.cost_usd, p.price_usd) ELSE p.cost_usd END, 2),
            ROUND(COALESCE(p.price_usd, 0), 2), ROUND(COALESCE(p.core_charge_usd, 0), 2), CASE WHEN p.warranty_days > 0 THEN ROUND(p.warranty_days / 30.0)::int END, p.id
          FROM (SELECT y.* FROM (SELECT p.id, left(upper(trim(COALESCE(NULLIF(p.sku, ''), 'P' || p.id))), 60) AS sku FROM products p WHERE p.is_active) y
              WHERE NOT EXISTS (SELECT 1 FROM fr_catalogue c WHERE c.product_id = y.id) AND NOT EXISTS (SELECT 1 FROM fr_catalogue c WHERE c.sku = y.sku) ORDER BY y.id LIMIT 20000) x
            JOIN products p ON p.id = x.id
          ORDER BY x.sku, p.id
          ON CONFLICT (sku) DO NOTHING RETURNING id, product_id`);
        // "Toyota Corolla 2009-2013" -> make Toyota, model Corolla, years 2009 to 2013.
        const ids = [], makes = [], models = [], yfs = [], yts = [];
        if (rows.length) {
          const { rows: mm } = await c.query(`SELECT id, make_model FROM products WHERE id = ANY($1)`, [rows.map((x) => x.product_id)]);
          const cat = Object.fromEntries(rows.map((x) => [x.product_id, x.id]));
          for (const p of mm) {
            const s = String(p.make_model || '').trim();
            if (!s || /^(universal|all|various|n\/?a|-)$/i.test(s)) continue;
            const y = /((?:19|20)\d{2})\s*(?:[-–to]+\s*((?:19|20)?\d{2}))?/.exec(s);
            const yf = y ? +y[1] : null;
            let yt = y ? (y[2] ? (y[2].length === 2 ? +(y[1].slice(0, 2) + y[2]) : +y[2]) : +y[1]) : null;
            if (yf && yt && yt < yf) yt = yf;
            const words = s.replace(y ? y[0] : '', ' ').trim().split(/\s+/).filter(Boolean);
            if (!words.length) continue;
            ids.push(cat[p.id]); makes.push(words[0].slice(0, 60)); models.push(words.slice(1).join(' ').slice(0, 80) || null); yfs.push(yf); yts.push(yt);
          }
          if (ids.length) await c.query(`INSERT INTO fr_fitment (catalogue_id, make, model, year_from, year_to, note)
            SELECT * , 'from the till product' FROM unnest($1::int[], $2::text[], $3::text[], $4::int[], $5::int[])`, [ids, makes, models, yfs, yts]);
        }
        return rows.length;
      });
      const added = ins, skipped = 0;
      // Up to 20,000 a run; the screen says how many are left for the next run.
      const { rows: left } = await query(`SELECT COUNT(*)::int AS c FROM products p WHERE p.is_active AND NOT EXISTS (SELECT 1 FROM fr_catalogue c WHERE c.product_id = p.id) AND NOT EXISTS (SELECT 1 FROM fr_catalogue c WHERE c.sku = left(upper(trim(COALESCE(NULLIF(p.sku, ''), 'P' || p.id))), 60))`);
      await log({ action: 'catalogue import', detail: added + ' added from the till products' + (skipped ? ', ' + skipped + ' SKUs already there' : '') }, req);
      res.json({ ok: true, added, skipped, remaining: left[0].c });
    } catch (e) { fail(res, e); }
  });
  // Can we get it, and how soon: this store, its hub, its DC, then the rest of the network.
  async function availability(itemId, storeId) {
    const s = await settings();
    const item = await itemRow(itemId);
    const f = storeId ? await frRow(storeId) : null;
    const { rows } = await query(`SELECT k.on_hand, k.dc_id, k.franchisee_id, d.name AS dc_name, d.cutoff_time, d.delivery_days, COALESCE(fs.trading_name, fs.legal_name) AS store_name, fs.network_role
      FROM fr_stock k LEFT JOIN fr_dcs d ON d.id = k.dc_id LEFT JOIN fr_franchisees fs ON fs.id = k.franchisee_id
      WHERE k.catalogue_id = $1 AND k.on_hand > 0 AND (k.dc_id IS NOT NULL OR fs.status IN ${LIVE})`, [item.id]);
    const here = f ? rows.find((r) => r.franchisee_id === f.id) : null;
    const hub = f && f.hub_id ? rows.find((r) => r.franchisee_id === f.hub_id) : null;
    const dc = f && f.dc_id ? rows.find((r) => r.dc_id === f.dc_id) : null;
    const dcRow = f && f.dc_id ? (await query(`SELECT name, cutoff_time, delivery_days FROM fr_dcs WHERE id = $1`, [f.dc_id])).rows[0] : null;
    const beforeCutoff = dcRow ? hhmmNow() < dcRow.cutoff_time : false;
    const options = [];
    if (here) options.push({ where: 'store', name: 'In this store', on_hand: here.on_hand, eta: 'Now' });
    if (hub) options.push({ where: 'hub', name: hub.store_name + ' (hub)', on_hand: hub.on_hand, eta: 'Today, hot shot in about ' + s.hot_shot_minutes + ' minutes' });
    if (dc) options.push({ where: 'dc', name: dc.dc_name, on_hand: dc.on_hand, eta: beforeCutoff ? 'Today, on the DC run (order before ' + dcRow.cutoff_time + ')' : 'Next delivery day (' + dcRow.delivery_days + '); today\'s cut-off ' + dcRow.cutoff_time + ' has passed' });
    for (const r of rows) {
      if (r === here || r === hub || r === dc) continue;
      options.push(r.dc_id ? { where: 'other_dc', name: r.dc_name, on_hand: r.on_hand, eta: 'Transfer from another DC: 1 to 2 days' } : { where: 'other_store', name: r.store_name, on_hand: r.on_hand, eta: 'Ask the store; transfer by arrangement' });
    }
    return { item, store: f ? { id: f.id, name: nameOf(f), role: f.network_role } : null, options, answer: options.length ? options[0].name + ': ' + options[0].eta : (item.stocking === 'dc' ? 'Out of stock at the DC: place a special order' : 'Not in stock anywhere in the network: place a special order') };
  }
  app.get('/api/franchise/network/availability', ...M, async (req, res) => {
    try { res.json(await availability(req.query.catalogue_id, n(req.query.store_id))); } catch (e) { fail(res, e); }
  });

  // ================================================================= stock ==
  app.get('/api/franchise/network/stock', ...M, async (req, res) => {
    try {
      const dc = n(req.query.dc_id), fr = n(req.query.store_id);
      if (!dc && !fr) throw httpError(400, 'Choose a DC or a store');
      const { rows } = await query(`SELECT k.id, k.catalogue_id, c.sku, c.description, c.category, k.on_hand, k.min_qty, k.max_qty, c.dealer_cost::float AS dealer_cost, (k.on_hand * c.dealer_cost)::float AS value, k.updated_at
        FROM fr_stock k JOIN fr_catalogue c ON c.id = k.catalogue_id WHERE ${dc ? 'k.dc_id = $1' : 'k.franchisee_id = $1'} ${req.query.low === '1' ? 'AND k.min_qty IS NOT NULL AND k.on_hand < k.min_qty' : ''} ORDER BY c.category NULLS LAST, c.description LIMIT 2000`, [dc || fr]);
      res.json({ stock: rows, value: r2(rows.reduce((x, r) => x + Number(r.value || 0), 0)) });
    } catch (e) { fail(res, e); }
  });
  // Counts and levels: [{ sku | catalogue_id, on_hand, min_qty, max_qty }]. Blank keeps what is there.
  async function saveStock(where, rowsIn, userId) {
    const out = { saved: 0, unknown: [] };
    await tx(async (c) => {
      for (const r of rowsIn.slice(0, 5000)) {
        let id = n(r.catalogue_id);
        if (!id && r.sku) { const { rows } = await c.query(`SELECT id FROM fr_catalogue WHERE sku = $1`, [String(r.sku).trim().toUpperCase()]); id = rows[0] && rows[0].id; }
        if (!id) { out.unknown.push(String(r.sku || r.catalogue_id || '?')); continue; }
        const oh = r.on_hand === '' || r.on_hand == null ? null : int(r.on_hand, 0, 10000000), mn = r.min_qty === '' || r.min_qty == null ? null : int(r.min_qty, 0, 1000000), mx = r.max_qty === '' || r.max_qty == null ? null : int(r.max_qty, 0, 1000000);
        if (mn != null && mx != null && mx < mn) throw httpError(400, 'Max is below min for ' + (r.sku || id));
        const col = where.dc_id ? 'dc_id' : 'franchisee_id', key = where.dc_id || where.franchisee_id;
        await c.query(`INSERT INTO fr_stock (catalogue_id, ${col}, on_hand, min_qty, max_qty, updated_at) VALUES ($1,$2,COALESCE($3, 0),$4,$5,NOW())
          ON CONFLICT (${col}, catalogue_id) WHERE ${col} IS NOT NULL DO UPDATE SET on_hand = COALESCE($3, fr_stock.on_hand), min_qty = COALESCE($4, fr_stock.min_qty), max_qty = COALESCE($5, fr_stock.max_qty), updated_at = NOW()`,
          [id, key, oh, mn, mx]);
        out.saved++;
      }
    });
    return out;
  }
  app.put('/api/franchise/network/stock', ...M, async (req, res) => {
    try {
      const b = req.body || {};
      const where = n(b.dc_id) ? { dc_id: n(b.dc_id) } : n(b.franchisee_id) ? { franchisee_id: (await frRow(b.franchisee_id)).id } : null;
      if (!where) throw httpError(400, 'Choose a DC or a store');
      const out = await saveStock(where, Array.isArray(b.rows) ? b.rows : [], me(req));
      await log({ franchisee_id: where.franchisee_id || null, action: 'stock levels saved', detail: out.saved + ' line(s)' + (where.dc_id ? ' at DC ' + where.dc_id : '') }, req);
      res.json(Object.assign({ ok: true }, out));
    } catch (e) { fail(res, e); }
  });
  async function replenishList(f) {
    const { rows } = await query(`SELECT k.catalogue_id, c.sku, c.description, k.on_hand, k.min_qty, k.max_qty, c.dealer_cost::float AS dealer_cost,
        GREATEST(COALESCE(k.max_qty, k.min_qty * 2) - k.on_hand, 1) AS suggest,
        (SELECT COALESCE(SUM(l.qty), 0)::int FROM fr_supply_lines l JOIN fr_supply_orders o ON o.id = l.order_id WHERE o.franchisee_id = k.franchisee_id AND o.status IN ('submitted', 'shipped') AND l.catalogue_id = k.catalogue_id) AS on_order
      FROM fr_stock k JOIN fr_catalogue c ON c.id = k.catalogue_id WHERE k.franchisee_id = $1 AND c.active AND k.min_qty IS NOT NULL AND k.on_hand < k.min_qty ORDER BY c.description`, [f.id]);
    return rows.map((r) => Object.assign(r, { suggest: Math.max(0, r.suggest - r.on_order) })).filter((r) => r.suggest > 0);
  }
  app.get('/api/franchise/network/stores/:id(\\d+)/replenish', ...M, async (req, res) => {
    try { const f = await frRow(req.params.id); const list = await replenishList(f); res.json({ lines: list, cost: r2(list.reduce((x, l) => x + l.suggest * l.dealer_cost, 0)) }); } catch (e) { fail(res, e); }
  });
  app.post('/api/franchise/network/stores/:id(\\d+)/replenish', ...M, async (req, res) => {
    try {
      const f = await frRow(req.params.id);
      const list = await replenishList(f);
      if (!list.length) throw httpError(409, 'Nothing is below its minimum (or it is already on order)');
      res.json(Object.assign({ ok: true }, await createOrder(req, f, { kind: 'stock', lines: list.map((l) => ({ catalogue_id: l.catalogue_id, qty: l.suggest })), notes: 'Replenishment to max' }, 'replenish')));
    } catch (e) { fail(res, e); }
  });

  // ========================================================= supply orders ==
  const onum = (id) => 'SO-' + String(id).padStart(5, '0');
  async function createOrder(req, f, b, source) {
    if (!['onboarding', 'open', 'suspended'].includes(f.status)) throw httpError(409, 'This store is not trading');
    const kind = ORDER_KINDS[b.kind] ? b.kind : 'stock';
    let hub = null;
    if (kind === 'hot') {
      if (!f.hub_id) throw httpError(409, 'This store has no hub; order from the DC');
      hub = f.hub_id;
    } else if (!f.dc_id) throw httpError(409, 'Set the store\'s distribution centre first (Store network > Stores)');
    const lines = [];
    for (const l of (Array.isArray(b.lines) ? b.lines : []).slice(0, 300)) {
      const qty = int(l.qty, 1, 100000); if (!qty) continue;
      let id = n(l.catalogue_id);
      if (!id && l.sku) { const { rows } = await query(`SELECT id FROM fr_catalogue WHERE sku = $1`, [String(l.sku).trim().toUpperCase()]); id = rows[0] && rows[0].id; if (!id) throw httpError(400, 'Unknown SKU ' + l.sku); }
      if (!id) continue;
      const { rows } = await query(`SELECT id, sku, dealer_cost::float AS dealer_cost, active FROM fr_catalogue WHERE id = $1`, [id]);
      if (!rows.length || !rows[0].active) throw httpError(400, 'That part is not in the catalogue (or is switched off)');
      const same = lines.find((x) => x.catalogue_id === id);
      if (same) same.qty += qty; else lines.push({ catalogue_id: id, qty, unit_cost: rows[0].dealer_cost });
    }
    if (!lines.length) throw httpError(400, 'Add at least one part and quantity');
    const total = r2(lines.reduce((x, l) => x + l.qty * l.unit_cost, 0));
    const id = await tx(async (c) => {
      const { rows } = await c.query(`INSERT INTO fr_supply_orders (franchisee_id, kind, dc_id, hub_id, needed_by, notes, source, total_cost, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [f.id, kind, kind === 'hot' ? null : f.dc_id, hub, d(b.needed_by), t(b.notes, 1000), source, total, me(req)]);
      await c.query(`UPDATE fr_supply_orders SET number = $2 WHERE id = $1`, [rows[0].id, onum(rows[0].id)]);
      for (const l of lines) await c.query(`INSERT INTO fr_supply_lines (order_id, catalogue_id, qty, unit_cost) VALUES ($1,$2,$3,$4)`, [rows[0].id, l.catalogue_id, l.qty, l.unit_cost]);
      return rows[0].id;
    });
    await log({ franchisee_id: f.id, action: 'supply order', detail: onum(id) + ' ' + ORDER_KINDS[kind] + ', ' + lines.length + ' line(s), ' + money(total) + (source === 'portal' ? ' (from their link)' : '') }, req);
    return { id, number: onum(id), total_cost: total };
  }
  app.post('/api/franchise/network/orders', ...M, async (req, res) => {
    try { const f = await frRow((req.body || {}).franchisee_id); res.json(Object.assign({ ok: true }, await createOrder(req, f, req.body || {}, 'staff'))); } catch (e) { fail(res, e); }
  });
  app.get('/api/franchise/network/orders', ...M, async (req, res) => {
    try {
      const where = [], args = [];
      if (req.query.status) { args.push(String(req.query.status)); where.push(`o.status = $${args.length}`); }
      if (n(req.query.store_id)) { args.push(n(req.query.store_id)); where.push(`o.franchisee_id = $${args.length}`); }
      if (n(req.query.dc_id)) { args.push(n(req.query.dc_id)); where.push(`o.dc_id = $${args.length}`); }
      if (n(req.query.hub_id)) { args.push(n(req.query.hub_id)); where.push(`o.hub_id = $${args.length}`); }
      const { rows } = await query(`SELECT o.id, o.number, o.kind, o.status, o.franchisee_id, COALESCE(f.trading_name, f.legal_name) AS store_name, f.store_type, o.dc_id, d.code AS dc_code, o.hub_id, COALESCE(hb.trading_name, hb.legal_name) AS hub_name,
          ${DATE('o.needed_by')} AS needed_by, o.total_cost::float AS total_cost, o.created_at, o.shipped_at, o.received_at, o.source, i.number AS invoice_number,
          (SELECT COUNT(*)::int FROM fr_supply_lines l WHERE l.order_id = o.id) AS lines,
          (SELECT SUM(LEAST(COALESCE(l.qty_shipped, 0), l.qty))::float / NULLIF(SUM(l.qty), 0) FROM fr_supply_lines l WHERE l.order_id = o.id) AS fill
        FROM fr_supply_orders o JOIN fr_franchisees f ON f.id = o.franchisee_id LEFT JOIN fr_dcs d ON d.id = o.dc_id LEFT JOIN fr_franchisees hb ON hb.id = o.hub_id LEFT JOIN ar_invoices i ON i.id = o.ar_invoice_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY o.status = 'submitted' DESC, o.kind = 'hot' DESC, o.id DESC LIMIT 300`, args);
      res.json({ orders: rows.map((r) => Object.assign(r, { fill_pct: r.status === 'submitted' || r.status === 'cancelled' || r.fill == null ? null : Math.round(r.fill * 1000) / 10 })) });
    } catch (e) { fail(res, e); }
  });
  async function orderRow(id) {
    const { rows } = await query(`SELECT o.*, ${DATE('o.needed_by')} AS needed_by, i.number AS invoice_number FROM fr_supply_orders o LEFT JOIN ar_invoices i ON i.id = o.ar_invoice_id WHERE o.id = $1`, [n(id)]);
    if (!rows.length) throw httpError(404, 'Order not found');
    const o = rows[0];
    o.total_cost = Number(o.total_cost);
    const { rows: lines } = await query(`SELECT l.id, l.catalogue_id, c.sku, c.description, l.qty, l.qty_shipped, l.qty_received, l.unit_cost::float AS unit_cost,
        (SELECT on_hand FROM fr_stock k WHERE k.catalogue_id = l.catalogue_id AND ${o.hub_id ? 'k.franchisee_id = $2' : 'k.dc_id = $2'}) AS source_on_hand
      FROM fr_supply_lines l JOIN fr_catalogue c ON c.id = l.catalogue_id WHERE l.order_id = $1 ORDER BY l.id`, [o.id, o.hub_id || o.dc_id || 0]);
    o.lines = lines;
    return o;
  }
  app.get('/api/franchise/network/orders/:id(\\d+)', ...M, async (req, res) => {
    try { const o = await orderRow(req.params.id); const f = await frRow(o.franchisee_id); res.json({ order: o, store: { id: f.id, name: nameOf(f), store_type: f.store_type, number: f.number } }); } catch (e) { fail(res, e); }
  });
  // Shipped: the quantities that left, the stock taken out at the DC (or hub), and the invoice.
  app.post('/api/franchise/network/orders/:id(\\d+)/ship', ...M, async (req, res) => {
    try {
      const o = await orderRow(req.params.id);
      if (o.status !== 'submitted') throw httpError(409, 'This order is ' + o.status);
      const f = await frRow(o.franchisee_id);
      const given = Object.fromEntries((Array.isArray((req.body || {}).lines) ? req.body.lines : []).map((l) => [String(l.id), l.qty_shipped]));
      const ship = o.lines.map((l) => {
        const v = given[String(l.id)];
        const def = l.source_on_hand == null ? l.qty : Math.max(0, Math.min(l.qty, l.source_on_hand));
        const q = v == null || v === '' ? def : int(v, 0, l.qty);
        if (q == null) throw httpError(400, 'Shipped quantity for ' + l.sku + ': 0 to ' + l.qty);
        return Object.assign({}, l, { ship: q });
      });
      const total = r2(ship.reduce((x, l) => x + l.ship * l.unit_cost, 0));
      if (!ship.some((l) => l.ship > 0)) throw httpError(409, 'Nothing to ship. Cancel the order instead, or record a quantity.');
      const billed = f.store_type !== 'company';
      if (billed && !f.customer_id) f.customer_id = await ensureCustomer(f);
      const acct = billed ? await accountFor('franchise_supply') : null;
      const out = await tx(async (c) => {
        for (const l of ship) {
          await c.query(`UPDATE fr_supply_lines SET qty_shipped = $2 WHERE id = $1`, [l.id, l.ship]);
          if (l.ship) await c.query(`UPDATE fr_stock SET on_hand = GREATEST(on_hand - $3, 0), updated_at = NOW() WHERE catalogue_id = $1 AND ${o.hub_id ? 'franchisee_id' : 'dc_id'} = $2`, [l.catalogue_id, o.hub_id || o.dc_id, l.ship]);
        }
        let inv = null;
        if (billed && total > 0) {
          inv = await invoice(c, f, [{ account_id: acct, amount: total, description: (o.kind === 'hot' ? 'Hot shot parts' : 'Parts and supplies') + ' ' + o.number + ' (' + ship.filter((l) => l.ship).length + ' line(s))' }],
            { due: addDays(today(), 30), memo: 'Supply order ' + o.number + ' - ' + nameOf(f) + ' (' + f.number + ')', userId: me(req) });
          await c.query(`INSERT INTO fr_charges (franchisee_id, kind, description, amount, gct, ar_invoice_id, created_by) VALUES ($1,'supply',$2,$3,$4,$5,$6)`, [f.id, 'Supply order ' + o.number, total, inv.gct, inv.id, me(req)]);
        }
        // A hub that fills a spoke's order is paid back the parts at dealer cost.
        if (o.hub_id && total > 0) {
          const { rows: hb } = await c.query(`SELECT store_type FROM fr_franchisees WHERE id = $1`, [o.hub_id]);
          if (hb[0] && hb[0].store_type !== 'company') await c.query(`INSERT INTO fr_credits (franchisee_id, kind, description, amount, source_id, created_by) VALUES ($1,'other',$2,$3,$4,$5)`,
            [o.hub_id, 'Hot shot ' + o.number + ' to ' + nameOf(f) + ' (parts at dealer cost)', total, o.id, me(req)]);
        }
        await c.query(`UPDATE fr_supply_orders SET status = 'shipped', total_cost = $2, shipped_at = NOW(), shipped_by = $3, ar_invoice_id = $4 WHERE id = $1`, [o.id, total, me(req), inv ? inv.id : null]);
        return inv;
      });
      const fill = Math.round(ship.reduce((x, l) => x + l.ship, 0) / ship.reduce((x, l) => x + l.qty, 0) * 1000) / 10;
      await log({ franchisee_id: f.id, action: 'supply order shipped', detail: o.number + ': ' + money(total) + ', fill ' + fill + '%' + (out ? ', invoice ' + out.number : '') }, req);
      res.json({ ok: true, total_cost: total, fill_pct: fill, invoice: out ? { id: out.id, number: out.number, total: out.total } : null });
    } catch (e) { fail(res, e); }
  });
  async function receiveOrder(req, o, b) {
    if (o.status !== 'shipped') throw httpError(409, o.status === 'received' ? 'Already received' : 'The order has not been shipped yet');
    const given = Object.fromEntries((Array.isArray(b.lines) ? b.lines : []).map((l) => [String(l.id), l.qty_received]));
    const short = [];
    await tx(async (c) => {
      for (const l of o.lines) {
        const v = given[String(l.id)];
        const q = v == null || v === '' ? (l.qty_shipped || 0) : int(v, 0, 100000);
        if (q == null) throw httpError(400, 'Received quantity for ' + l.sku);
        if (q < (l.qty_shipped || 0)) short.push(l.sku + ' short ' + ((l.qty_shipped || 0) - q));
        await c.query(`UPDATE fr_supply_lines SET qty_received = $2 WHERE id = $1`, [l.id, q]);
        if (q) await c.query(`INSERT INTO fr_stock (catalogue_id, franchisee_id, on_hand, updated_at) VALUES ($1,$2,$3,NOW())
          ON CONFLICT (franchisee_id, catalogue_id) WHERE franchisee_id IS NOT NULL DO UPDATE SET on_hand = fr_stock.on_hand + $3, updated_at = NOW()`, [l.catalogue_id, o.franchisee_id, q]);
      }
      const note = [t(b.note, 1000), short.length ? 'Short: ' + short.join(', ') : null].filter(Boolean).join(' · ') || null;
      await c.query(`UPDATE fr_supply_orders SET status = 'received', received_at = NOW(), receive_note = $2 WHERE id = $1`, [o.id, note]);
    });
    await log({ franchisee_id: o.franchisee_id, action: 'supply order received', detail: o.number + (short.length ? ' (short: ' + short.join(', ') + ')' : '') }, req);
    return { short };
  }
  app.post('/api/franchise/network/orders/:id(\\d+)/receive', ...M, async (req, res) => {
    try { const o = await orderRow(req.params.id); res.json(Object.assign({ ok: true }, await receiveOrder(req, o, req.body || {}))); } catch (e) { fail(res, e); }
  });
  app.post('/api/franchise/network/orders/:id(\\d+)/cancel', ...M, async (req, res) => {
    try {
      const o = await orderRow(req.params.id);
      const { rowCount } = await query(`UPDATE fr_supply_orders SET status = 'cancelled', receive_note = $2 WHERE id = $1 AND status = 'submitted'`, [o.id, t((req.body || {}).reason, 500)]);
      if (!rowCount) throw httpError(409, 'Only an order not yet shipped can be cancelled');
      await log({ franchisee_id: o.franchisee_id, action: 'supply order cancelled', detail: o.number }, req);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  // Lines shipped out of lines ordered, for orders shipped in the window.
  async function fillRates(from, to) {
    const { rows } = await query(`SELECT o.franchisee_id, o.dc_id, SUM(LEAST(COALESCE(l.qty_shipped, 0), l.qty))::float AS shipped, SUM(l.qty)::float AS ordered,
        COUNT(*) FILTER (WHERE COALESCE(l.qty_shipped, 0) >= l.qty)::int AS lines_full, COUNT(*)::int AS lines
      FROM fr_supply_orders o JOIN fr_supply_lines l ON l.order_id = o.id WHERE o.status IN ('shipped', 'received') AND o.shipped_at >= $1 AND o.shipped_at < $2 AND o.kind <> 'hot'
      GROUP BY GROUPING SETS ((o.franchisee_id), (o.dc_id))`, [from, to]);
    const store = {}, dc = {};
    for (const r of rows) {
      const v = { fill_pct: r.ordered ? Math.round(r.shipped / r.ordered * 1000) / 10 : null, line_fill_pct: r.lines ? Math.round(r.lines_full / r.lines * 1000) / 10 : null, lines: r.lines };
      if (r.franchisee_id != null) store[r.franchisee_id] = v; else if (r.dc_id != null) dc[r.dc_id] = v;
    }
    return { store, dc };
  }

  // ============================================================ commercial ==
  app.get('/api/franchise/network/commercial', ...M, async (req, res) => {
    try {
      const st = n(req.query.store_id);
      const [acc, routes] = await Promise.all([
        query(`SELECT a.*, ${DATE('a.opened_on')} AS opened_on, a.credit_limit::float AS credit_limit, a.monthly_target::float AS monthly_target, COALESCE(f.trading_name, f.legal_name) AS store_name,
            p.code AS tier_code, p.name AS tier_name, r.name AS route_name FROM fr_commercial_accounts a JOIN fr_franchisees f ON f.id = a.franchisee_id
            LEFT JOIN fr_price_tiers p ON p.id = a.tier_id LEFT JOIN fr_routes r ON r.id = a.route_id ${st ? 'WHERE a.franchisee_id = $1' : ''} ORDER BY a.status = 'active' DESC, store_name, r.name NULLS LAST, a.stop_order NULLS LAST, a.name`, st ? [st] : []),
        query(`SELECT r.*, COALESCE(f.trading_name, f.legal_name) AS store_name, (SELECT COUNT(*)::int FROM fr_commercial_accounts a WHERE a.route_id = r.id AND a.status = 'active') AS stops
          FROM fr_routes r JOIN fr_franchisees f ON f.id = r.franchisee_id ${st ? 'WHERE r.franchisee_id = $1' : ''} ORDER BY store_name, r.name`, st ? [st] : [])]);
      res.json({ accounts: acc.rows, routes: routes.rows });
    } catch (e) { fail(res, e); }
  });
  async function accountInput(b, frId) {
    const name = t(b.name, 200); if (!name) throw httpError(400, 'The business name');
    const tier = n(b.tier_id), route = n(b.route_id);
    if (tier && !(await query(`SELECT 1 FROM fr_price_tiers WHERE id = $1`, [tier])).rows.length) throw httpError(400, 'Unknown price tier');
    if (route) { const { rows } = await query(`SELECT franchisee_id FROM fr_routes WHERE id = $1`, [route]); if (!rows.length || rows[0].franchisee_id !== frId) throw httpError(400, 'That route belongs to another store'); }
    const email = t(b.email, 200); if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw httpError(400, 'That email address does not look right');
    return { name, kind: COMM_KINDS[b.kind] ? b.kind : 'garage', contact: t(b.contact, 120), phone: t(b.phone, 60), email, address: t(b.address, 500), trn: t(b.trn, 30), tier_id: tier,
      credit_limit: amt(b.credit_limit), terms_days: int(b.terms_days, 0, 120) == null ? 30 : int(b.terms_days, 0, 120), route_id: route, stop_order: int(b.stop_order, 0, 999), monthly_target: amt(b.monthly_target),
      bays: int(b.bays, 0, 500), status: ['prospect', 'active', 'on_hold', 'closed'].includes(b.status) ? b.status : 'active', opened_on: d(b.opened_on) || (b.status === 'prospect' ? null : today()), notes: t(b.notes, 2000) };
  }
  app.post('/api/franchise/network/commercial', ...M, async (req, res) => {
    try {
      const f = await frRow((req.body || {}).franchisee_id);
      const a = await accountInput(req.body || {}, f.id);
      const k = Object.keys(a);
      const { rows } = await query(`INSERT INTO fr_commercial_accounts (franchisee_id, ${k.join(', ')}) VALUES ($1, ${k.map((_, i) => '$' + (i + 2)).join(', ')}) RETURNING id`, [f.id].concat(k.map((x) => a[x])));
      const { rows: first } = await query(`SELECT COUNT(*)::int AS c FROM fr_commercial_accounts WHERE franchisee_id = $1 AND status = 'active' AND route_id IS NOT NULL`, [f.id]);
      if (first[0].c) await query(`UPDATE fr_tasks SET done_at = NOW(), done_by = $2 WHERE franchisee_id = $1 AND done_at IS NULL AND title LIKE 'Commercial accounts and first delivery route%'`, [f.id, me(req)]);
      await log({ franchisee_id: f.id, action: 'commercial account opened', detail: a.name + ' (' + COMM_KINDS[a.kind] + ')' }, req);
      res.json({ ok: true, id: rows[0].id });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/franchise/network/commercial/:id(\\d+)', ...M, async (req, res) => {
    try {
      const { rows: cur } = await query(`SELECT franchisee_id, name, status FROM fr_commercial_accounts WHERE id = $1`, [n(req.params.id)]);
      if (!cur.length) throw httpError(404, 'Account not found');
      const a = await accountInput(Object.assign({ opened_on: null }, req.body || {}), cur[0].franchisee_id);
      if (!(req.body || {}).opened_on) delete a.opened_on;
      const k = Object.keys(a);
      await query(`UPDATE fr_commercial_accounts SET ${k.map((x, i) => x + ' = $' + (i + 2)).join(', ')}, updated_at = NOW() WHERE id = $1`, [n(req.params.id)].concat(k.map((x) => a[x])));
      if (cur[0].status !== a.status) await log({ franchisee_id: cur[0].franchisee_id, action: 'commercial account ' + a.status.replace('_', ' '), detail: a.name }, req);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  function routeInput(b) {
    const name = t(b.name, 120); if (!name) throw httpError(400, 'The route name');
    return [name, t(b.driver, 120), t(b.vehicle, 120), t(b.runs, 200), int(b.promise_minutes, 5, 600), b.active !== false];
  }
  app.post('/api/franchise/network/routes', ...M, async (req, res) => {
    try {
      const f = await frRow((req.body || {}).franchisee_id);
      const { rows } = await query(`INSERT INTO fr_routes (franchisee_id, name, driver, vehicle, runs, promise_minutes, active) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [f.id].concat(routeInput(req.body || {})));
      await log({ franchisee_id: f.id, action: 'delivery route added', detail: req.body.name }, req);
      res.json({ ok: true, id: rows[0].id });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/franchise/network/routes/:id(\\d+)', ...M, async (req, res) => {
    try {
      const { rowCount } = await query(`UPDATE fr_routes SET name = $2, driver = $3, vehicle = $4, runs = $5, promise_minutes = $6, active = $7 WHERE id = $1`, [n(req.params.id)].concat(routeInput(req.body || {})));
      if (!rowCount) throw httpError(404, 'Route not found');
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  function tierInput(b) {
    const code = t(b.code, 20), name = t(b.name, 120);
    if (!code || !name) throw httpError(400, 'A code and a name for the tier');
    const disc = pctIn(b.discount_pct, 'Discount', 99), floor = pctIn(b.floor_pct, 'Margin floor over dealer cost', 200);
    return [code.toUpperCase(), name, ['retail', 'loyalty', 'commercial'].includes(b.kind) ? b.kind : 'commercial', disc || 0, floor == null ? 10 : floor, amt(b.min_monthly), t(b.description, 500), int(b.sort, 0) || 100];
  }
  app.post('/api/franchise/network/tiers', ...M, async (req, res) => {
    try {
      const { rows } = await query(`INSERT INTO fr_price_tiers (code, name, kind, discount_pct, floor_pct, min_monthly, description, sort) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, tierInput(req.body || {})).catch(unique('That tier code is already used'));
      res.json({ ok: true, id: rows[0].id });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/franchise/network/tiers/:id(\\d+)', ...M, async (req, res) => {
    try {
      const { rowCount } = await query(`UPDATE fr_price_tiers SET code = $2, name = $3, kind = $4, discount_pct = $5, floor_pct = $6, min_monthly = $7, description = $8, sort = $9 WHERE id = $1`, [n(req.params.id)].concat(tierInput(req.body || {})))
        .catch(unique('That tier code is already used'));
      if (!rowCount) throw httpError(404, 'Tier not found');
      await log({ action: 'price tier changed', detail: req.body.code }, req);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ============================================================ programmes ==
  // DC purchases: what was shipped to the store from its DC (hub hot shots are transfers, not DC purchases).
  const DC_BUYS = (from, to) => `COALESCE((SELECT SUM(o.total_cost) FROM fr_supply_orders o WHERE o.franchisee_id = f.id AND o.kind <> 'hot' AND o.status IN ('shipped', 'received') AND o.shipped_at >= ${from} AND o.shipped_at < ${to}), 0)::float`;
  async function coopOf(fid) {
    const s = await settings();
    const { rows } = await query(`SELECT f.id, COALESCE(f.coop_pct, $2)::float AS coop_pct, ${DC_BUYS("CURRENT_DATE - interval '12 months'", "CURRENT_DATE + 1")} AS buys,
        COALESCE((SELECT SUM(approved) FROM fr_coop_claims c WHERE c.franchisee_id = f.id AND c.status = 'approved' AND c.decided_at >= CURRENT_DATE - interval '12 months'), 0)::float AS used
      FROM fr_franchisees f WHERE f.id = $1`, [fid, s.coop_pct]);
    const r = rows[0];
    const earned = r2(r.buys * r.coop_pct / 100);
    return { earned, used: r2(r.used), balance: r2(Math.max(0, earned - r.used)), coop_pct: r.coop_pct, dc_purchases_12m: r2(r.buys), claim_pct: s.coop_claim_pct };
  }
  app.get('/api/franchise/network/programmes', ...M, async (req, res) => {
    try {
      const s = await settings();
      const year = int(req.query.year, 2000, 2100) || +today().slice(0, 4);
      const y0 = year + '-01-01', y1 = (year + 1) + '-01-01';
      const { rows: stores } = await query(`SELECT f.id, f.number, COALESCE(f.trading_name, f.legal_name) AS name, f.store_type, COALESCE(f.commit_pct, $3)::float AS commit_pct, COALESCE(f.coop_pct, $4)::float AS coop_pct,
          ${DC_BUYS('$1::date', '$2::date')} AS dc_purchases,
          COALESCE((SELECT SUM(r.purchases_total) FROM fr_reports r WHERE r.franchisee_id = f.id AND r.period >= $1 AND r.period < $2), 0)::float AS reported_purchases,
          COALESCE((SELECT SUM(amount) FROM fr_credits c WHERE c.franchisee_id = f.id AND c.kind = 'rebate' AND c.status <> 'cancelled' AND c.period LIKE $5), 0)::float AS rebates,
          COALESCE((SELECT SUM(amount) FROM fr_credits c WHERE c.franchisee_id = f.id AND c.status = 'owed'), 0)::float AS owed
        FROM fr_franchisees f WHERE f.status IN ${LIVE} AND f.store_type <> 'company' ORDER BY f.number`, [y0, y1, s.commit_pct, s.coop_pct, year + '-Q%']);
      for (const r of stores) {
        r.compliance_pct = r.reported_purchases > 0 ? Math.round(r.dc_purchases / r.reported_purchases * 1000) / 10 : null;
        r.coop = await coopOf(r.id);
      }
      const [claims, credits, tiers] = await Promise.all([
        query(`SELECT c.*, ${DATE('c.spend_date')} AS spend_date, c.spend::float AS spend, c.claimed::float AS claimed, c.approved::float AS approved, COALESCE(f.trading_name, f.legal_name) AS store_name
          FROM fr_coop_claims c JOIN fr_franchisees f ON f.id = c.franchisee_id ORDER BY c.status = 'submitted' DESC, c.id DESC LIMIT 200`),
        query(`SELECT c.id, c.franchisee_id, COALESCE(f.trading_name, f.legal_name) AS store_name, c.kind, c.period, c.description, c.amount::float AS amount, c.status, c.settled_how, c.settled_ref, c.settled_at, c.created_at
          FROM fr_credits c JOIN fr_franchisees f ON f.id = c.franchisee_id ORDER BY c.status = 'owed' DESC, c.id DESC LIMIT 300`),
        query(`SELECT id, min_quarter::float AS min_quarter, rebate_pct::float AS rebate_pct FROM fr_rebate_tiers ORDER BY min_quarter`)]);
      res.json({ year, stores, claims: claims.rows, credits: credits.rows, rebate_tiers: tiers.rows,
        loyalty: { points_per_100: s.loyalty_points_per_100, point_value: s.loyalty_point_value }, coop: { pct: s.coop_pct, claim_pct: s.coop_claim_pct }, commit_pct: s.commit_pct });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/franchise/network/rebate-tiers', ...M, async (req, res) => {
    try {
      const list = (Array.isArray((req.body || {}).tiers) ? req.body.tiers : []).map((x) => ({ min: amt(x.min_quarter), pct: pctIn(x.rebate_pct, 'Rebate', 20) })).filter((x) => x.min != null && x.pct != null);
      const seen = new Set(); for (const x of list) { if (seen.has(x.min)) throw httpError(400, 'Two steps start at the same amount'); seen.add(x.min); }
      await tx(async (c) => {
        await c.query(`DELETE FROM fr_rebate_tiers`);
        for (const x of list) await c.query(`INSERT INTO fr_rebate_tiers (min_quarter, rebate_pct) VALUES ($1,$2)`, [x.min, x.pct]);
      });
      await log({ action: 'rebate scale changed', detail: list.map((x) => money(x.min) + ': ' + x.pct + '%').join('; ') || 'no rebates' }, req);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  // The quarter's rebates: one credit per store, at the step its DC purchases reach. A store under its
  // purchasing commitment (from its reported total purchases) is held back unless the manager allows it.
  app.post('/api/franchise/network/rebates/run', ...M, async (req, res) => {
    try {
      const b = req.body || {};
      const q = quarter(b.quarter);
      if (!q) throw httpError(400, 'Which quarter (for example 2026-Q3)?');
      if (q.to > today()) throw httpError(409, 'That quarter has not ended yet');
      const s = await settings();
      const { rows: tiers } = await query(`SELECT min_quarter::float AS min_quarter, rebate_pct::float AS rebate_pct FROM fr_rebate_tiers ORDER BY min_quarter DESC`);
      if (!tiers.length) throw httpError(409, 'Set the rebate scale first');
      const { rows: stores } = await query(`SELECT f.id, f.number, COALESCE(f.trading_name, f.legal_name) AS name, COALESCE(f.commit_pct, $3)::float AS commit_pct, ${DC_BUYS('$1::date', '$2::date')} AS buys,
          (SELECT SUM(r.purchases_total) FROM fr_reports r WHERE r.franchisee_id = f.id AND r.period >= $1 AND r.period < $2)::float AS reported
        FROM fr_franchisees f WHERE f.store_type <> 'company' AND (f.status IN ('open', 'suspended') OR f.ended_on >= $1)`, [q.from, q.to, s.commit_pct]);
      const out = [];
      for (const st of stores) {
        const tier = tiers.find((x) => st.buys >= x.min_quarter);
        const compliance = st.reported > 0 ? Math.round(st.buys / st.reported * 1000) / 10 : null;
        const row = { franchisee_id: st.id, name: st.name, dc_purchases: r2(st.buys), compliance_pct: compliance, rebate_pct: tier ? tier.rebate_pct : 0, amount: tier ? r2(st.buys * tier.rebate_pct / 100) : 0 };
        if (!tier || !row.amount) { row.result = 'below the first step'; out.push(row); continue; }
        if (compliance != null && compliance < st.commit_pct && !(Array.isArray(b.allow) && b.allow.map(Number).includes(st.id))) { row.result = 'held back: ' + compliance + '% through the DC, commitment ' + st.commit_pct + '%'; out.push(row); continue; }
        const ins = await query(`INSERT INTO fr_credits (franchisee_id, kind, period, description, amount, created_by) VALUES ($1,'rebate',$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id`,
          [st.id, q.key, 'Purchasing rebate ' + q.key + ': ' + tier.rebate_pct + '% of DC purchases ' + money(st.buys), row.amount, me(req)]);
        row.result = ins.rows.length ? 'credited' : 'already credited';
        if (ins.rows.length) await log({ franchisee_id: st.id, action: 'rebate credited', detail: q.key + ': ' + money(row.amount) }, req);
        out.push(row);
      }
      res.json({ ok: true, quarter: q.key, stores: out, total: r2(out.filter((x) => x.result === 'credited').reduce((x, r) => x + r.amount, 0)) });
    } catch (e) { fail(res, e); }
  });
  async function newClaim(req, f, b, source) {
    if (f.store_type === 'company') throw httpError(409, 'Company stores spend the marketing budget directly');
    const s = await settings();
    const description = t(b.description, 1000), spend = amt(b.spend), day = d(b.spend_date);
    if (!description || !(spend > 0) || !day) throw httpError(400, 'What the advertising was, the date and the amount spent');
    if (day > today()) throw httpError(400, 'The spend date is in the future');
    const claimed = r2(spend * s.coop_claim_pct / 100);
    const { rows } = await query(`INSERT INTO fr_coop_claims (franchisee_id, description, media, spend_date, spend, claimed, proof, source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [f.id, description, t(b.media, 60), day, spend, claimed, t(b.proof, 500), source]);
    await log({ franchisee_id: f.id, action: 'co-op claim', detail: money(claimed) + ' of ' + money(spend) + ': ' + description.slice(0, 80) + (source === 'portal' ? ' (from their link)' : '') }, req);
    return { id: rows[0].id, claimed };
  }
  app.post('/api/franchise/network/coop-claims', ...M, async (req, res) => {
    try { const f = await frRow((req.body || {}).franchisee_id); res.json(Object.assign({ ok: true }, await newClaim(req, f, req.body || {}, 'staff'))); } catch (e) { fail(res, e); }
  });
  app.post('/api/franchise/network/coop-claims/:id(\\d+)/decide', ...M, async (req, res) => {
    try {
      const { rows } = await query(`SELECT * FROM fr_coop_claims WHERE id = $1`, [n(req.params.id)]);
      const c = rows[0]; if (!c) throw httpError(404, 'Claim not found');
      if (c.status !== 'submitted') throw httpError(409, 'Already decided');
      const b = req.body || {};
      if (b.decision === 'decline') {
        const why = t(b.note, 1000); if (!why) throw httpError(400, 'Say why it is declined');
        await query(`UPDATE fr_coop_claims SET status = 'declined', decided_by = $2, decided_at = NOW(), decision_note = $3 WHERE id = $1`, [c.id, me(req), why]);
        await log({ franchisee_id: c.franchisee_id, action: 'co-op claim declined', detail: why }, req);
        return res.json({ ok: true });
      }
      if (b.decision !== 'approve') throw httpError(400, 'Approve or decline');
      const bal = await coopOf(c.franchisee_id);
      const want = b.amount == null || b.amount === '' ? Number(c.claimed) : amt(b.amount);
      if (!(want > 0)) throw httpError(400, 'The amount to approve');
      if (want > Number(c.claimed) + 0.004) throw httpError(400, 'More than was claimed (' + money(c.claimed) + ')');
      if (want > bal.balance + 0.004) throw httpError(409, 'The store\'s co-op allowance is ' + money(bal.balance) + '; approve that much or less');
      await tx(async (q) => {
        await q.query(`UPDATE fr_coop_claims SET status = 'approved', approved = $2, decided_by = $3, decided_at = NOW(), decision_note = $4 WHERE id = $1`, [c.id, want, me(req), t(b.note, 1000)]);
        await q.query(`INSERT INTO fr_credits (franchisee_id, kind, period, description, amount, source_id, created_by) VALUES ($1,'coop',$2,$3,$4,$5,$6)`,
          [c.franchisee_id, today().slice(0, 7), 'Co-op advertising: ' + String(c.description).slice(0, 120), want, c.id, me(req)]);
      });
      await log({ franchisee_id: c.franchisee_id, action: 'co-op claim approved', detail: money(want) }, req);
      res.json({ ok: true, approved: want });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/franchise/network/credits/:id(\\d+)/settle', ...M, async (req, res) => {
    try {
      const b = req.body || {};
      const how = ['cheque', 'transfer', 'set_off', 'other'].includes(b.how) ? b.how : null;
      if (!how) throw httpError(400, 'How was it paid: cheque, bank transfer, set against their invoices, or other');
      const { rows } = await query(`UPDATE fr_credits SET status = 'settled', settled_how = $2, settled_ref = $3, settled_at = NOW(), settled_by = $4 WHERE id = $1 AND status = 'owed' RETURNING franchisee_id, amount::float AS amount, description`,
        [n(req.params.id), how, t(b.reference, 200), me(req)]);
      if (!rows.length) throw httpError(409, 'Only money still owed can be settled');
      await log({ franchisee_id: rows[0].franchisee_id, action: 'credit settled', detail: money(rows[0].amount) + ' (' + how.replace('_', ' ') + (b.reference ? ' ' + t(b.reference, 60) : '') + '): ' + rows[0].description }, req);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/franchise/network/credits/:id(\\d+)/cancel', ...M, async (req, res) => {
    try {
      const why = t((req.body || {}).reason, 500); if (!why) throw httpError(400, 'Say why');
      const { rows } = await query(`UPDATE fr_credits SET status = 'cancelled', settled_ref = $2, settled_at = NOW(), settled_by = $3 WHERE id = $1 AND status = 'owed' RETURNING franchisee_id, amount::float AS amount`, [n(req.params.id), why, me(req)]);
      if (!rows.length) throw httpError(409, 'Only money still owed can be cancelled');
      await log({ franchisee_id: rows[0].franchisee_id, action: 'credit cancelled', detail: money(rows[0].amount) + ': ' + why }, req);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ========================================================= certification ==
  async function certCompliance(fid) {
    const { rows } = await query(`SELECT p.code, p.name, p.required_per_store, (SELECT COUNT(*)::int FROM fr_staff_certs c WHERE c.franchisee_id = $1 AND c.program_code = p.code AND c.revoked_at IS NULL AND (c.expires_on IS NULL OR c.expires_on >= CURRENT_DATE)) AS have
      FROM fr_cert_programs p WHERE p.active AND p.required_per_store > 0 ORDER BY p.sort`, [fid]);
    const need = rows.reduce((x, r) => x + r.required_per_store, 0), met = rows.reduce((x, r) => x + Math.min(r.have, r.required_per_store), 0);
    return { programs: rows, pct: need ? Math.round(met / need * 1000) / 10 : 100, short: rows.filter((r) => r.have < r.required_per_store).map((r) => r.name + ' (' + r.have + ' of ' + r.required_per_store + ')') };
  }
  app.get('/api/franchise/network/certs', ...M, async (req, res) => {
    try {
      const st = n(req.query.store_id);
      const { rows: certs } = await query(`SELECT c.id, c.franchisee_id, COALESCE(f.trading_name, f.legal_name) AS store_name, c.person, c.role, c.program_code, p.name AS program_name, ${DATE('c.earned_on')} AS earned_on,
          ${DATE('c.expires_on')} AS expires_on, c.score, c.certificate_no, c.revoked_at,
          CASE WHEN c.revoked_at IS NOT NULL THEN 'revoked' WHEN c.expires_on < CURRENT_DATE THEN 'expired' WHEN c.expires_on < CURRENT_DATE + 60 THEN 'expiring' ELSE 'current' END AS state
        FROM fr_staff_certs c JOIN fr_cert_programs p ON p.code = c.program_code JOIN fr_franchisees f ON f.id = c.franchisee_id ${st ? 'WHERE c.franchisee_id = $1' : ''} ORDER BY store_name, c.person, p.sort`, st ? [st] : []);
      const { rows: stores } = await query(`SELECT id, number, COALESCE(trading_name, legal_name) AS name, store_type FROM fr_franchisees WHERE status IN ${LIVE} ${st ? 'AND id = $1' : ''} ORDER BY number`, st ? [st] : []);
      for (const s of stores) s.compliance = await certCompliance(s.id);
      res.json({ certs, stores });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/franchise/network/cert-programs/:code', ...M, async (req, res) => {
    try {
      const code = String(req.params.code || '').toUpperCase();
      if (!/^[A-Z0-9_-]{2,12}$/.test(code)) throw httpError(400, 'Code: 2 to 12 letters or numbers');
      const b = req.body || {};
      const name = t(b.name, 120); if (!name) throw httpError(400, 'The certificate name');
      await query(`INSERT INTO fr_cert_programs (code, name, description, for_role, valid_months, required_per_store, lesson_key, pass_pct, sort, active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, for_role = EXCLUDED.for_role, valid_months = EXCLUDED.valid_months, required_per_store = EXCLUDED.required_per_store,
          lesson_key = EXCLUDED.lesson_key, pass_pct = EXCLUDED.pass_pct, sort = EXCLUDED.sort, active = EXCLUDED.active`,
        [code, name, t(b.description, 1000), t(b.for_role, 120), int(b.valid_months, 1, 120) || 24, int(b.required_per_store, 0, 50) || 0, t(b.lesson_key, 60), int(b.pass_pct, 1, 100) || 80, int(b.sort, 0) || 100, b.active !== false]);
      await log({ action: 'certificate changed', detail: code + ' ' + name }, req);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/franchise/network/certs', ...M, async (req, res) => {
    try {
      const b = req.body || {};
      const f = await frRow(b.franchisee_id);
      const { rows: pr } = await query(`SELECT * FROM fr_cert_programs WHERE code = $1 AND active`, [String(b.program_code || '').toUpperCase()]);
      const p = pr[0]; if (!p) throw httpError(400, 'Choose the certificate');
      const person = t(b.person, 120); if (!person) throw httpError(400, 'Who earned it?');
      const earned = d(b.earned_on) || today();
      if (earned > today()) throw httpError(400, 'The date earned is in the future');
      const score = b.score === '' || b.score == null ? null : int(b.score, 0, 100);
      if (score != null && score < p.pass_pct) throw httpError(400, 'A score of ' + score + '% is below the ' + p.pass_pct + '% pass mark');
      const expires = h.addMonths(earned, p.valid_months);
      const { rows } = await query(`INSERT INTO fr_staff_certs (franchisee_id, person, role, program_code, earned_on, expires_on, score, certificate_no, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [f.id, person, t(b.role, 120), p.code, earned, expires, score, t(b.certificate_no, 60), me(req)]);
      await query(`UPDATE fr_staff_certs SET certificate_no = COALESCE(certificate_no, $2) WHERE id = $1`, [rows[0].id, p.code + '-' + String(rows[0].id).padStart(5, '0')]);
      const comp = await certCompliance(f.id);
      const ps1 = comp.programs.find((x) => x.code === 'PS1'), mgr = comp.programs.find((x) => x.code === 'MGR');
      if ((!ps1 || ps1.have >= ps1.required_per_store) && (!mgr || mgr.have >= mgr.required_per_store))
        await query(`UPDATE fr_tasks SET done_at = NOW(), done_by = $2 WHERE franchisee_id = $1 AND done_at IS NULL AND title LIKE 'Counter staff certified%'`, [f.id, me(req)]);
      await log({ franchisee_id: f.id, action: 'certificate earned', detail: person + ': ' + p.name + (score != null ? ' (' + score + '%)' : '') + ', to ' + expires }, req);
      res.json({ ok: true, id: rows[0].id, expires_on: expires, compliance_pct: comp.pct });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/franchise/network/certs/:id(\\d+)/revoke', ...M, async (req, res) => {
    try {
      const { rows } = await query(`UPDATE fr_staff_certs SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL RETURNING franchisee_id, person, program_code`, [n(req.params.id)]);
      if (!rows.length) throw httpError(409, 'Already withdrawn');
      await log({ franchisee_id: rows[0].franchisee_id, action: 'certificate withdrawn', detail: rows[0].person + ' ' + rows[0].program_code + (req.body && req.body.reason ? ': ' + t(req.body.reason, 200) : '') }, req);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ============================================================= scorecard ==
  // Green when on target, amber within a fifth of it, red beyond.
  function grade(v, target, lowerIsBetter) {
    if (v == null || target == null) return null;
    if (lowerIsBetter) return v <= target ? 'ok' : v <= target * 1.5 ? 'warn' : 'bad';
    return v >= target ? 'ok' : v >= target * 0.8 ? 'warn' : 'bad';
  }
  async function scorecard(months, onlyId) {
    const s = await settings();
    const end = today().slice(0, 8) + '01', from = h.addMonths(end, -months);
    const { rows } = await query(`SELECT f.id, f.number, COALESCE(f.trading_name, f.legal_name) AS name, f.store_type, f.network_role, f.format_key, fm.name AS format_name, f.sq_ft, f.status,
        COUNT(r.id)::int AS months_reported, COALESCE(SUM(r.net_sales), 0)::float AS net, SUM(r.diy_sales)::float AS diy, SUM(r.commercial_sales)::float AS commercial,
        SUM(r.cogs)::float AS cogs, SUM(r.net_sales) FILTER (WHERE r.cogs IS NOT NULL)::float AS net_with_cogs, AVG(r.inventory_value)::float AS avg_inventory,
        SUM(r.shrink)::float AS shrink, SUM(r.net_sales) FILTER (WHERE r.shrink IS NOT NULL)::float AS net_with_shrink, SUM(r.transactions)::float AS tx,
        SUM(r.net_sales) FILTER (WHERE r.transactions IS NOT NULL)::float AS net_with_tx, SUM(r.purchases_total)::float AS purchases, SUM(r.deliveries)::int AS deliveries,
        (SUM(r.delivery_minutes * COALESCE(r.deliveries, 1)) / NULLIF(SUM(COALESCE(r.deliveries, 1)) FILTER (WHERE r.delivery_minutes IS NOT NULL), 0))::float AS delivery_minutes,
        SUM(r.loyalty_members)::int AS loyalty_members, SUM(r.loyalty_issued)::int AS loyalty_issued, SUM(r.loyalty_redeemed)::int AS loyalty_redeemed,
        ${DC_BUYS('$1::date', '$2::date')} AS dc_purchases,
        (SELECT score_pct::float FROM fr_audits a WHERE a.franchisee_id = f.id ORDER BY audit_date DESC, id DESC LIMIT 1) AS last_audit,
        (SELECT COUNT(*)::int FROM fr_store_systems x WHERE x.franchisee_id = f.id AND x.status IN ('verified', 'not_needed')) AS systems_ok,
        (SELECT COUNT(*)::int FROM fr_commercial_accounts a WHERE a.franchisee_id = f.id AND a.status = 'active') AS accounts
      FROM fr_franchisees f LEFT JOIN fr_formats fm ON fm.key = f.format_key LEFT JOIN fr_reports r ON r.franchisee_id = f.id AND r.period >= $1 AND r.period < $2
      WHERE (f.status IN ('open', 'suspended') OR f.opened_on IS NOT NULL) ${onlyId ? 'AND f.id = $3' : ''}
      GROUP BY f.id, fm.name ORDER BY net DESC`, onlyId ? [from, end, onlyId] : [from, end]);
    const fills = await fillRates(from, end);
    const out = [];
    for (const r of rows) {
      const m = r.months_reported || 0;
      const k = {
        net_sales: r2(r.net), per_month: m ? r2(r.net / m) : null,
        sales_per_sqft: m && r.sq_ft ? r2(r.net / m * 12 / r.sq_ft) : null,
        commercial_pct: r.diy != null && r.commercial != null && r.diy + r.commercial > 0 ? Math.round(r.commercial / (r.diy + r.commercial) * 1000) / 10 : null,
        avg_ticket: r.tx ? r2(r.net_with_tx / r.tx) : null,
        margin_pct: r.cogs != null && r.net_with_cogs ? Math.round((r.net_with_cogs - r.cogs) / r.net_with_cogs * 1000) / 10 : null,
        turns: r.cogs != null && r.avg_inventory ? Math.round(r.cogs / m * 12 / r.avg_inventory * 10) / 10 : null,
        shrink_pct: r.shrink != null && r.net_with_shrink ? Math.round(r.shrink / r.net_with_shrink * 10000) / 100 : null,
        fill_pct: fills.store[r.id] ? fills.store[r.id].fill_pct : null,
        dc_share_pct: r.purchases ? Math.round(r.dc_purchases / r.purchases * 1000) / 10 : null,
        delivery_minutes: r.delivery_minutes != null ? Math.round(r.delivery_minutes) : null,
        cert_pct: (await certCompliance(r.id)).pct, systems_pct: Math.round(r.systems_ok / SYSTEMS.length * 1000) / 10,
        last_audit: r.last_audit, deliveries: r.deliveries, loyalty_members: r.loyalty_members, accounts: r.accounts,
      };
      const commit = s.commit_pct;
      k.grades = { commercial_pct: grade(k.commercial_pct, s.target_commercial_pct), margin_pct: grade(k.margin_pct, s.target_margin_pct), turns: grade(k.turns, s.target_turns),
        shrink_pct: grade(k.shrink_pct, s.max_shrink_pct, true), fill_pct: grade(k.fill_pct, s.target_fill_rate), dc_share_pct: r.store_type === 'company' ? null : grade(k.dc_share_pct, commit),
        delivery_minutes: grade(k.delivery_minutes, s.delivery_promise_minutes, true), cert_pct: grade(k.cert_pct, s.target_cert_pct), systems_pct: grade(k.systems_pct, 100), last_audit: grade(k.last_audit, s.pass_pct) };
      const g = Object.values(k.grades).filter(Boolean);
      k.score = g.length ? Math.round(g.reduce((x, v) => x + (v === 'ok' ? 2 : v === 'warn' ? 1 : 0), 0) / (g.length * 2) * 100) : null;
      out.push(Object.assign({ id: r.id, number: r.number, name: r.name, store_type: r.store_type, network_role: r.network_role, format_key: r.format_key, format_name: r.format_name, sq_ft: r.sq_ft, months_reported: m }, k));
    }
    const avg = (key) => { const v = out.map((x) => x[key]).filter((x) => x != null); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length * 10) / 10 : null; };
    const group = (key) => {
      const g = {};
      for (const x of out) { const k2 = x[key] || 'none'; (g[k2] = g[k2] || { stores: 0, net_sales: 0 }); g[k2].stores++; g[k2].net_sales = r2(g[k2].net_sales + x.net_sales); }
      Object.values(g).forEach((v) => { v.per_store = v.stores ? r2(v.net_sales / v.stores) : 0; });
      return g;
    };
    return { from, to: end, months, stores: out,
      network: { stores: out.length, net_sales: r2(out.reduce((x, r) => x + r.net_sales, 0)), per_store: out.length ? r2(out.reduce((x, r) => x + r.net_sales, 0) / out.length) : 0,
        commercial_pct: avg('commercial_pct'), margin_pct: avg('margin_pct'), turns: avg('turns'), shrink_pct: avg('shrink_pct'), fill_pct: avg('fill_pct'), cert_pct: avg('cert_pct'), score: avg('score') },
      by_type: group('store_type'), by_format: group('format_key'), dc_fill: fills.dc,
      targets: { commercial_pct: s.target_commercial_pct, margin_pct: s.target_margin_pct, turns: s.target_turns, shrink_pct: s.max_shrink_pct, fill_pct: s.target_fill_rate, dc_share_pct: s.commit_pct,
        delivery_minutes: s.delivery_promise_minutes, cert_pct: s.target_cert_pct, systems_pct: 100, last_audit: s.pass_pct } };
  }
  app.get('/api/franchise/network/scorecard', ...M, async (req, res) => {
    try { res.json(await scorecard(Math.max(1, Math.min(24, parseInt(req.query.months, 10) || 3)), n(req.query.store_id))); } catch (e) { fail(res, e); }
  });
  // Territory planning: market size, stores serving it and the planned next store.
  app.get('/api/franchise/network/territories', ...M, async (req, res) => {
    try {
      const s = await settings();
      const { rows } = await query(`SELECT t.*, d.code AS dc_code, d.name AS dc_name, fm.name AS planned_format_name,
          (SELECT COUNT(*)::int FROM fr_franchisees f WHERE f.territory_id = t.id AND f.status IN ${LIVE}) AS stores,
          (SELECT string_agg(COALESCE(f.trading_name, f.legal_name), ', ') FROM fr_franchisees f WHERE f.territory_id = t.id AND f.status IN ${LIVE}) AS store_names,
          (SELECT COALESCE(SUM(r.net_sales), 0)::float FROM fr_reports r JOIN fr_franchisees f ON f.id = r.franchisee_id WHERE f.territory_id = t.id AND r.period >= CURRENT_DATE - interval '12 months') AS sales_12m
        FROM fr_territories t LEFT JOIN fr_dcs d ON d.id = t.dc_id LEFT JOIN fr_formats fm ON fm.key = t.planned_format ORDER BY t.priority NULLS LAST, t.code`);
      rows.forEach((r) => {
        r.potential = (r.vehicles || r.garages) ? r2((r.vehicles || 0) * s.spend_per_vehicle + (r.garages || 0) * s.spend_per_garage) : null;
        r.share_pct = r.potential ? Math.round(r.sales_12m / r.potential * 1000) / 10 : null;
      });
      res.json({ territories: rows, spend_per_vehicle: s.spend_per_vehicle, spend_per_garage: s.spend_per_garage });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/franchise/network/territories/:id(\\d+)', ...M, async (req, res) => {
    try {
      const b = req.body || {};
      const dc = n(b.dc_id), fmt = t(b.planned_format, 40);
      const type = ['franchise', 'affiliate', 'company'].includes(b.planned_type) ? b.planned_type : null;
      const { rowCount } = await query(`UPDATE fr_territories SET vehicles = $2, garages = $3, dc_id = $4, dc_minutes = $5, planned_format = $6, planned_type = $7, priority = $8 WHERE id = $1`,
        [n(req.params.id), int(b.vehicles, 0), int(b.garages, 0), dc, int(b.dc_minutes, 0, 1440), fmt, type, int(b.priority, 1, 999)]);
      if (!rowCount) throw httpError(404, 'Territory not found');
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ============================================== the store's own link ==
  // What the store sees on franchisee.html?p=...
  async function portal(f) {
    const [orders, claims, certs, credits] = await Promise.all([
      query(`SELECT o.id, o.number, o.kind, o.status, o.total_cost::float AS total_cost, o.created_at, o.shipped_at, o.received_at, i.number AS invoice_number,
          (SELECT json_agg(json_build_object('id', l.id, 'sku', c.sku, 'description', c.description, 'qty', l.qty, 'qty_shipped', l.qty_shipped, 'qty_received', l.qty_received) ORDER BY l.id)
             FROM fr_supply_lines l JOIN fr_catalogue c ON c.id = l.catalogue_id WHERE l.order_id = o.id) AS lines
        FROM fr_supply_orders o LEFT JOIN ar_invoices i ON i.id = o.ar_invoice_id WHERE o.franchisee_id = $1 ORDER BY o.id DESC LIMIT 15`, [f.id]),
      query(`SELECT ${DATE('spend_date')} AS spend_date, description, spend::float AS spend, claimed::float AS claimed, approved::float AS approved, status, decision_note FROM fr_coop_claims WHERE franchisee_id = $1 ORDER BY id DESC LIMIT 20`, [f.id]),
      query(`SELECT c.person, p.name AS program_name, ${DATE('c.earned_on')} AS earned_on, ${DATE('c.expires_on')} AS expires_on FROM fr_staff_certs c JOIN fr_cert_programs p ON p.code = c.program_code
        WHERE c.franchisee_id = $1 AND c.revoked_at IS NULL ORDER BY c.person, p.sort`, [f.id]),
      query(`SELECT kind, period, description, amount::float AS amount, status, settled_how, settled_at FROM fr_credits WHERE franchisee_id = $1 AND status <> 'cancelled' ORDER BY id DESC LIMIT 30`, [f.id])]);
    const sc = await scorecard(3, f.id).catch(() => null);
    return { orders: orders.rows, coop: f.store_type === 'company' ? null : Object.assign(await coopOf(f.id), { claims: claims.rows }), certs: certs.rows, compliance: await certCompliance(f.id),
      credits: credits.rows, scorecard: sc && sc.stores[0] ? sc.stores[0] : null, targets: sc ? sc.targets : null, can_order: !!(f.dc_id || f.hub_id), has_hub: !!f.hub_id };
  }
  app.get('/api/public/franchisee/:token/parts', async (req, res) => {
    noStore(res);
    try {
      const f = await byPortal(req);
      const items = await search(Object.assign({}, req.query, { all: false }), 60);
      const ids = items.map((i) => i.id);
      const { rows: stock } = ids.length ? await query(`SELECT catalogue_id, dc_id, franchisee_id, on_hand FROM fr_stock WHERE catalogue_id = ANY($1) AND (franchisee_id = $2 OR franchisee_id = $3 OR dc_id = $4)`,
        [ids, f.id, f.hub_id || 0, f.dc_id || 0]) : { rows: [] };
      res.json({ items: items.map((i) => {
        const at = (pred) => { const r = stock.find((k) => k.catalogue_id === i.id && pred(k)); return r ? r.on_hand : null; };
        return { id: i.id, sku: i.sku, part_number: i.part_number, brand: i.brand, description: i.description, category: i.category, interchange: i.interchange, fits: i.fits,
          dealer_cost: i.dealer_cost, list_price: i.list_price, core_charge: i.core_charge, warranty_months: i.warranty_months,
          in_store: at((k) => k.franchisee_id === f.id), at_hub: f.hub_id ? at((k) => k.franchisee_id === f.hub_id) : null, at_dc: f.dc_id ? at((k) => k.dc_id === f.dc_id) : null };
      }) });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/public/franchisee/:token/orders', async (req, res) => {
    noStore(res);
    try {
      const f = await byPortal(req);
      if (f.status === 'suspended') throw httpError(409, 'Ordering is paused while the store is suspended. Call the franchise office.');
      res.json(Object.assign({ ok: true }, await createOrder(req, f, req.body || {}, 'portal')));
    } catch (e) { fail(res, e); }
  });
  app.post('/api/public/franchisee/:token/orders/:id(\\d+)/receive', async (req, res) => {
    noStore(res);
    try {
      const f = await byPortal(req);
      const o = await orderRow(req.params.id);
      if (o.franchisee_id !== f.id) throw httpError(404, 'Order not found');
      res.json(Object.assign({ ok: true }, await receiveOrder(req, o, req.body || {})));
    } catch (e) { fail(res, e); }
  });
  app.post('/api/public/franchisee/:token/coop', async (req, res) => {
    noStore(res);
    try { const f = await byPortal(req); res.json(Object.assign({ ok: true }, await newClaim(req, f, req.body || {}, 'portal'))); } catch (e) { fail(res, e); }
  });

  return { portal, scorecard, availability };
}

module.exports = { register, COMM_KINDS, ORDER_KINDS, ROLES };
