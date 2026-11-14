// =============================================================================
//  deptstore.js -- Department store: locations, department inventory & sales,
//  stock transfers (Phase 3, 2026-10)
//
//  Sits ABOVE the existing departments system (terminal.js owns department
//  CRUD, staff/till assignments and the sell-only-your-department rule under
//  /api/dept). This module adds the store-location layer and the roll-ups the
//  department store needs:
//
//    * Store locations (branches) -- CRUD, one default.
//    * Inventory by department -- on-hand units, cost value and retail value
//      rolled up from products via each department's category list, per
//      location (location_stock). Categories in no department fall into an
//      "Unassigned" bucket so nothing is hidden.
//    * Sales by department -- pos_sale_items joined to products.category and
//      mapped to the location's departments, over a date range.
//    * Stock transfers between locations -- draft, then post moves
//      location_stock from one branch to another in one transaction.
//
//  Department creation, category assignment and staff/till assignment stay on
//  /api/dept (terminal.js); the department-store page links to that screen.
// =============================================================================
'use strict';

function pad6(n) { return 'TRF-' + String(n).padStart(6, '0'); }
function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : (d === undefined ? 0 : d); }

exports.register = function register(app, deps) {
  const { query, requireCap, getPool } = deps;
  const manage = requireCap('dept.manage');       // set up stores/transfers
  const view = requireCap('reports.view');         // read inventory/sales reports

  const uid = (req) => (req.session && req.session.userId) || null;
  const fail = (res, e) => res.status(e && e.status || 500).json({ error: (e && e.message) || 'Server error' });

  async function defaultLocationId() {
    const { rows } = await query(`SELECT id FROM store_locations WHERE is_default ORDER BY sort, id LIMIT 1`);
    return rows[0] ? rows[0].id : null;
  }

  // ---------------------------------------------------------------- locations
  // One row per location with its department, till and stock summary.
  app.get('/api/deptstore/locations', view, async (req, res) => {
    try {
      const { rows } = await query(`
        SELECT l.*,
          (SELECT count(*) FROM departments d WHERE d.location_id = l.id AND d.is_active AND d.kind <> 'general') AS departments,
          (SELECT count(*) FROM pos_stations s WHERE s.location_id = l.id AND s.is_active)  AS tills,
          COALESCE((SELECT sum(ls.qty) FROM location_stock_v ls WHERE ls.location_id = l.id), 0) AS units,
          COALESCE((SELECT sum(ls.qty * COALESCE(p.cost_usd, 0)) FROM location_stock_v ls JOIN products p ON p.img = ls.product_img WHERE ls.location_id = l.id), 0) AS cost_value,
          COALESCE((SELECT sum(ls.qty * COALESCE(p.price_usd, 0)) FROM location_stock_v ls JOIN products p ON p.img = ls.product_img WHERE ls.location_id = l.id), 0) AS retail_value
        FROM store_locations l
        ORDER BY l.sort, l.id`);
      res.json({ locations: rows });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/deptstore/locations', manage, async (req, res) => {
    try {
      const b = req.body || {};
      const code = String(b.code || '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '');
      const name = String(b.name || '').trim();
      if (!code || !name) return res.status(400).json({ error: 'Code and name are required' });
      const kind = ['store', 'supermarket', 'wholesale', 'warehouse', 'branch'].includes(b.kind) ? b.kind : 'store';
      const { rows } = await query(
        `INSERT INTO store_locations (code, name, kind, address, phone, sort) VALUES ($1,$2,$3,$4,$5,COALESCE($6,0)) RETURNING *`,
        [code, name, kind, b.address || null, b.phone || null, b.sort == null ? null : num(b.sort)]).catch((e) => {
          if (/unique|duplicate/i.test(e.message)) throw Object.assign(new Error('That code is already used'), { status: 409 });
          throw e;
        });
      res.json({ location: rows[0] });
    } catch (e) { fail(res, e); }
  });

  app.patch('/api/deptstore/locations/:id(\\d+)', manage, async (req, res) => {
    try {
      const id = Number(req.params.id); const b = req.body || {};
      const sets = [], vals = [];
      const set = (col, v) => { vals.push(v); sets.push(col + ' = $' + vals.length); };
      if (b.name != null) set('name', String(b.name).trim());
      if (b.kind != null && ['store', 'supermarket', 'wholesale', 'warehouse', 'branch'].includes(b.kind)) set('kind', b.kind);
      if (b.address !== undefined) set('address', b.address || null);
      if (b.phone !== undefined) set('phone', b.phone || null);
      if (b.is_active != null) set('is_active', !!b.is_active);
      if (b.sort != null) set('sort', num(b.sort));
      if (sets.length) { vals.push(id); await query(`UPDATE store_locations SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals); }
      if (b.is_default === true) {
        const held = await query(`SELECT COUNT(*) AS c FROM location_stock ls JOIN store_locations l ON l.id = ls.location_id AND NOT l.is_default WHERE ls.qty > 0`);
        if (Number(held.rows[0].c) > 0) return res.status(400).json({ error: 'Move all branch stock back to the main store before changing which store is the main one.' });
        await query(`UPDATE store_locations SET is_default = (id = $1)`, [id]);  // exactly one default
      }
      const { rows } = await query(`SELECT * FROM store_locations WHERE id = $1`, [id]);
      if (!rows[0]) return res.status(404).json({ error: 'Not found' });
      res.json({ location: rows[0] });
    } catch (e) { fail(res, e); }
  });

  app.delete('/api/deptstore/locations/:id(\\d+)', manage, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const d = await query(`SELECT is_default FROM store_locations WHERE id = $1`, [id]);
      if (!d.rows[0]) return res.status(404).json({ error: 'Not found' });
      if (d.rows[0].is_default) return res.status(400).json({ error: 'Cannot delete the default location. Make another the default first.' });
      const stock = await query(`SELECT COALESCE(sum(qty), 0) q FROM location_stock WHERE location_id = $1`, [id]);
      if (num(stock.rows[0].q) > 0) return res.status(400).json({ error: 'This location still holds stock. Transfer it out first.' });
      const tr = await query(`SELECT count(*) c FROM stock_transfers WHERE from_location_id = $1 OR to_location_id = $1`, [id]);
      if (num(tr.rows[0].c) > 0) return res.status(400).json({ error: 'This location has transfer history and cannot be deleted. Switch it off (Active) instead to keep the records.' });
      await query(`DELETE FROM store_locations WHERE id = $1`, [id]);   // cascades departments/stock rows (already empty)
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // -------------------------------------------------- inventory by department
  // Roll up on-hand units and value by department (category list) for a
  // location. Categories in no department show as "Unassigned".
  app.get('/api/deptstore/inventory', view, async (req, res) => {
    try {
      const locId = Number(req.query.location) || await defaultLocationId();
      if (!locId) return res.json({ location_id: null, departments: [] });
      // Category totals at this location.
      const { rows: cats } = await query(`
        SELECT lower(COALESCE(NULLIF(TRIM(p.category), ''), '(uncategorised)')) AS category,
               count(DISTINCT p.img) AS skus,
               COALESCE(sum(ls.qty), 0) AS units,
               COALESCE(sum(ls.qty * COALESCE(p.cost_usd, 0)), 0) AS cost_value,
               COALESCE(sum(ls.qty * COALESCE(p.price_usd, 0)), 0) AS retail_value
          FROM products p
          JOIN location_stock_v ls ON ls.product_img = p.img AND ls.location_id = $1
         GROUP BY 1`, [locId]);
      // Departments of this location and their categories.
      const { rows: depts } = await query(
        `SELECT id, code, name, kind, categories FROM departments WHERE location_id = $1 AND is_active AND kind <> 'general' ORDER BY sort, name`, [locId]);
      const catMap = new Map();                 // category -> first department
      for (const d of depts) for (const c of (d.categories || [])) if (!catMap.has(c)) catMap.set(c, d);
      const bucket = new Map();                  // department id (or 'un') -> totals
      for (const d of depts) bucket.set(d.id, { id: d.id, code: d.code, name: d.name, kind: d.kind, categories: d.categories || [], skus: 0, units: 0, cost_value: 0, retail_value: 0 });
      bucket.set('un', { id: null, code: null, name: 'Unassigned', kind: 'unassigned', categories: [], skus: 0, units: 0, cost_value: 0, retail_value: 0 });
      for (const c of cats) {
        const d = catMap.get(c.category);
        const t = bucket.get(d ? d.id : 'un');
        t.skus += Number(c.skus); t.units += Number(c.units);
        t.cost_value += Number(c.cost_value); t.retail_value += Number(c.retail_value);
      }
      const out = [...bucket.values()].filter((t) => t.id !== null || t.units > 0 || t.skus > 0);
      res.json({ location_id: locId, departments: out });
    } catch (e) { fail(res, e); }
  });

  // Items inside one department (or the unassigned bucket) at a location.
  app.get('/api/deptstore/inventory/items', view, async (req, res) => {
    try {
      const locId = Number(req.query.location) || await defaultLocationId();
      const deptId = req.query.department === 'un' ? 'un' : Number(req.query.department) || null;
      let cats;
      if (deptId === 'un') {
        const { rows } = await query(`SELECT array_agg(DISTINCT c) AS all_cats FROM (SELECT unnest(categories) c FROM departments WHERE location_id = $1) t`, [locId]);
        const assigned = (rows[0] && rows[0].all_cats) || [];
        const items = await query(`
          SELECT p.img, p.name, p.sku, p.category, COALESCE(ls.qty,0) qty, p.cost_usd, p.price_usd
            FROM products p JOIN location_stock_v ls ON ls.product_img = p.img AND ls.location_id = $1
           WHERE lower(COALESCE(NULLIF(TRIM(p.category),''),'(uncategorised)')) <> ALL($2::text[])
           ORDER BY p.name LIMIT 500`, [locId, assigned.length ? assigned : ['']]);
        return res.json({ items: items.rows });
      }
      const dc = await query(`SELECT categories FROM departments WHERE id = $1`, [deptId]);
      cats = (dc.rows[0] && dc.rows[0].categories) || [];
      if (!cats.length) return res.json({ items: [] });
      const items = await query(`
        SELECT p.img, p.name, p.sku, p.category, COALESCE(ls.qty,0) qty, p.cost_usd, p.price_usd
          FROM products p JOIN location_stock_v ls ON ls.product_img = p.img AND ls.location_id = $1
         WHERE lower(COALESCE(NULLIF(TRIM(p.category),''),'(uncategorised)')) = ANY($2::text[])
         ORDER BY p.name LIMIT 500`, [locId, cats]);
      res.json({ items: items.rows });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------- sales by department
  app.get('/api/deptstore/sales', view, async (req, res) => {
    try {
      const locId = Number(req.query.location) || await defaultLocationId();
      const from = req.query.from || '1900-01-01';
      const to = req.query.to || '2999-12-31';
      // Revenue & units by product category over the range (not voided).
      const { rows: cats } = await query(`
        SELECT lower(COALESCE(NULLIF(TRIM(p.category), ''), '(uncategorised)')) AS category,
               COALESCE(sum(i.qty), 0) AS units,
               COALESCE(sum(i.total_usd), 0) AS revenue,
               COALESCE(sum(i.qty * COALESCE(p.cost_usd, 0)), 0) AS cost
          FROM pos_sale_items i
          JOIN pos_sales s ON s.id = i.sale_id
          LEFT JOIN products p ON p.img = i.product_img
         WHERE COALESCE(s.voided, false) = false
           AND s.created_at::date BETWEEN $1 AND $2
           AND (s.location_id = $3 OR (s.location_id IS NULL AND $3 = (SELECT id FROM store_locations WHERE is_default LIMIT 1)))
         GROUP BY 1`, [from, to, locId]);
      const { rows: depts } = await query(
        `SELECT id, code, name, kind, categories FROM departments WHERE location_id = $1 AND kind <> 'general' ORDER BY sort, name`, [locId]);
      const catMap = new Map();
      for (const d of depts) for (const c of (d.categories || [])) if (!catMap.has(c)) catMap.set(c, d);
      const bucket = new Map();
      for (const d of depts) bucket.set(d.id, { id: d.id, name: d.name, kind: d.kind, units: 0, revenue: 0, cost: 0 });
      bucket.set('un', { id: null, name: 'Unassigned', kind: 'unassigned', units: 0, revenue: 0, cost: 0 });
      for (const c of cats) {
        const d = catMap.get(c.category); const t = bucket.get(d ? d.id : 'un');
        t.units += Number(c.units); t.revenue += Number(c.revenue); t.cost += Number(c.cost);
      }
      const out = [...bucket.values()].filter((t) => t.revenue || t.units || t.id !== null)
        .map((t) => ({ ...t, margin: t.revenue - t.cost }));
      res.json({ location_id: locId, from, to, departments: out });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------------- product find
  // Search products that have stock at a given location (for transfer lines).
  app.get('/api/deptstore/products', view, async (req, res) => {
    try {
      const locId = Number(req.query.location) || await defaultLocationId();
      const q = String(req.query.q || '').trim();
      if (q.length < 2) return res.json({ products: [] });
      const like = '%' + q.replace(/[%_]/g, '') + '%';
      const { rows } = await query(`
        SELECT p.img, p.name, p.sku, p.category, COALESCE(ls.qty, 0) AS at_location
          FROM products p
          LEFT JOIN location_stock_v ls ON ls.product_img = p.img AND ls.location_id = $1
         WHERE p.name ILIKE $2 OR p.sku ILIKE $2 OR p.img ILIKE $2 OR p.barcode ILIKE $2
         ORDER BY (COALESCE(ls.qty,0) > 0) DESC, p.name LIMIT 25`, [locId, like]);
      res.json({ products: rows });
    } catch (e) { fail(res, e); }
  });

  // ---------------------------------------------------------------- transfers
  app.get('/api/deptstore/transfers', view, async (req, res) => {
    try {
      const status = req.query.status;
      const params = []; let where = '';
      if (status) { params.push(status); where = 'WHERE t.status = $1'; }
      const { rows } = await query(`
        SELECT t.*, f.name AS from_name, d.name AS to_name,
               (SELECT count(*) FROM stock_transfer_lines l WHERE l.transfer_id = t.id) AS lines,
               (SELECT COALESCE(sum(qty),0) FROM stock_transfer_lines l WHERE l.transfer_id = t.id) AS units
          FROM stock_transfers t
          JOIN store_locations f ON f.id = t.from_location_id
          JOIN store_locations d ON d.id = t.to_location_id
          ${where}
         ORDER BY t.created_at DESC LIMIT 200`, params);
      res.json({ transfers: rows });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/deptstore/transfers/:id(\\d+)', view, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const { rows: tr } = await query(`
        SELECT t.*, f.name AS from_name, d.name AS to_name
          FROM stock_transfers t JOIN store_locations f ON f.id = t.from_location_id JOIN store_locations d ON d.id = t.to_location_id
         WHERE t.id = $1`, [id]);
      if (!tr[0]) return res.status(404).json({ error: 'Not found' });
      const { rows: lines } = await query(`
        SELECT l.*, COALESCE(fs.qty,0) AS from_on_hand
          FROM stock_transfer_lines l
          LEFT JOIN location_stock_v fs ON fs.product_img = l.product_img AND fs.location_id = $2
         WHERE l.transfer_id = $1 ORDER BY l.id`, [id, tr[0].from_location_id]);
      res.json({ transfer: tr[0], lines });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/deptstore/transfers', manage, async (req, res) => {
    try {
      const b = req.body || {};
      const fromId = Number(b.from_location_id), toId = Number(b.to_location_id);
      const lines = Array.isArray(b.lines) ? b.lines : [];
      if (!fromId || !toId) return res.status(400).json({ error: 'Pick both a source and a destination' });
      if (fromId === toId) return res.status(400).json({ error: 'Source and destination must differ' });
      if (!lines.length) return res.status(400).json({ error: 'Add at least one item' });
      const number = pad6((await query(`SELECT nextval('stock_transfer_seq') AS n`)).rows[0].n);
      const { rows: tr } = await query(
        `INSERT INTO stock_transfers (number, from_location_id, to_location_id, note, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [number, fromId, toId, b.note || null, uid(req)]);
      for (const l of lines) {
        const img = String(l.product_img || '').trim(); const qty = Math.floor(num(l.qty));
        if (!img || qty <= 0) continue;
        await query(`INSERT INTO stock_transfer_lines (transfer_id, product_img, description, qty) VALUES ($1,$2,$3,$4)`,
          [tr[0].id, img, l.description || null, qty]);
      }
      res.json({ transfer: tr[0] });
    } catch (e) { fail(res, e); }
  });

  // Post a transfer: move location_stock from source to destination in one
  // transaction. Fails if the source does not hold enough of any line.
  app.post('/api/deptstore/transfers/:id(\\d+)/post', manage, async (req, res) => {
    const pool = getPool();
    const client = await pool.connect();
    try {
      const id = Number(req.params.id);
      await client.query('BEGIN');
      const { rows: tr } = await client.query(`SELECT * FROM stock_transfers WHERE id = $1 FOR UPDATE`, [id]);
      if (!tr[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
      if (tr[0].status !== 'draft') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Only a draft can be posted' }); }
      const { rows: lines } = await client.query(`SELECT * FROM stock_transfer_lines WHERE transfer_id = $1`, [id]);
      if (!lines.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Transfer has no items' }); }
      const defId = (await client.query('SELECT id FROM store_locations WHERE is_default ORDER BY sort, id LIMIT 1')).rows[0].id;
      for (const l of lines) {
        // Lock what the source quantity is derived from, so a sale cannot race it.
        if (tr[0].from_location_id === defId) await client.query('SELECT 1 FROM products WHERE img = $1 FOR UPDATE', [l.product_img]);
        else await client.query('SELECT 1 FROM location_stock WHERE product_img = $1 AND location_id = $2 FOR UPDATE', [l.product_img, tr[0].from_location_id]);
        const src = await client.query('SELECT qty FROM location_stock_v WHERE product_img = $1 AND location_id = $2', [l.product_img, tr[0].from_location_id]);
        const have = src.rows[0] ? Number(src.rows[0].qty) : 0;
        if (have < l.qty) { await client.query('ROLLBACK'); return res.status(400).json({ error: `Not enough stock of ${l.description || l.product_img} at source (${have} on hand, ${l.qty} needed)` }); }
        // Only branch rows are stored; the main store's quantity is the total minus
        // the branches, so moving units in or out of a branch moves the main store too.
        if (tr[0].from_location_id !== defId) await client.query('UPDATE location_stock SET qty = qty - $3, updated_at = NOW() WHERE product_img = $1 AND location_id = $2', [l.product_img, tr[0].from_location_id, l.qty]);
        if (tr[0].to_location_id !== defId) await client.query(`INSERT INTO location_stock (product_img, location_id, qty) VALUES ($1,$2,$3)
            ON CONFLICT (product_img, location_id) DO UPDATE SET qty = location_stock.qty + EXCLUDED.qty, updated_at = NOW()`, [l.product_img, tr[0].to_location_id, l.qty]);
      }
      await client.query(`UPDATE stock_transfers SET status = 'posted', posted_at = NOW(), posted_by = $2 WHERE id = $1`, [id, uid(req)]);
      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (e) { try { await client.query('ROLLBACK'); } catch (_) {} fail(res, e); }
    finally { client.release(); }
  });

  app.post('/api/deptstore/transfers/:id(\\d+)/cancel', manage, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const { rowCount } = await query(`UPDATE stock_transfers SET status = 'cancelled' WHERE id = $1 AND status = 'draft'`, [id]);
      if (!rowCount) return res.status(400).json({ error: 'Only a draft can be cancelled' });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  return {};
};
