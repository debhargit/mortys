// =============================================================================
//  supplierportal.js -- suppliers log in and run their side of the business
//
//  A supplier gets their own login (and staff logins with roles). In the portal
//  they:
//    * see their account status -- what we owe them, aging, and the credit
//      limit THEY extend to us (they set it; an admin can too)
//    * manage their items: load new ones, edit, set their warehouse location,
//      upload a price list (CSV). On upload we compare their list against:
//        - our lost-sales list   (things we turned customers away for)
//        - our current cost       (where they beat it, or where we already win)
//        - our stale costs/prices (items of ours, linked to them, not re-priced
//          in a long time)
//    * run consignment: their stock sits in our shop, we sell it, the ledger
//      records what we owe them on each sale
//    * make a retail sale to a customer through our portal, and print the
//      pick list, packing slip and shipping label from our system
//    * see a live queue of orders (new ones flash) and update their status
//    * read reports: best-selling, fastest-moving, most-profitable items
//    * read the supplier training notes we publish
//
//  Supplier sessions are separate from staff/customer sessions
//  (req.session.supplierUserId), so a supplier can never reach the admin panel.
//  Shop admins manage all of this under the "suppliers.manage" permission.
// =============================================================================
'use strict';
const crypto = require('crypto');

const httpError = (s, m) => { const e = new Error(m); e.status = s; return e; };
const money = (v) => { if (v === '' || v == null) return null; const x = Number(v); return Number.isFinite(x) ? Math.round(x * 100) / 100 : null; };
const int = (v) => { const x = parseInt(v, 10); return Number.isFinite(x) ? x : null; };
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
// Permissions a role carries; a per-user perms object can turn extras on/off.
const ROLE_PERMS = {
  owner:   { items: true, orders: true, retail: true, financials: true, staff: true, settings: true },
  manager: { items: true, orders: true, retail: true, financials: true, staff: false, settings: false },
  staff:   { items: true, orders: true, retail: false, financials: false, staff: false, settings: false },
};

// Minimal, quote-aware CSV parser (handles "a,b" and embedded quotes/newlines).
function parseCsv(text) {
  const rows = []; let row = [], field = '', q = false;
  text = String(text).replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((x) => String(x).trim() !== ''));
}

exports.register = function register(app, deps) {
  const { query, requireCap, bcrypt, mailer, devMode } = deps;
  const fail = (res, e) => { if (!e.status) console.error('[supplier]', e); res.status(e.status || 500).json({ error: e.status ? e.message : 'Server error' }); };
  const ipOf = (req) => String(req.headers['cf-connecting-ip'] || (req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '').slice(0, 64);
  let upload = null;
  try { const multer = require('multer'); upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } }); } catch (_) {}

  // -------------------------------------------------------- supplier auth --
  async function supUser(req) {
    if (!req.session || !req.session.supplierUserId) return null;
    const { rows } = await query(`SELECT su.*, s.name AS supplier_name, s.portal_enabled, s.web_retail_enabled FROM supplier_users su JOIN suppliers s ON s.id = su.supplier_id WHERE su.id = $1`, [req.session.supplierUserId]);
    if (!rows.length || !rows[0].is_active || !rows[0].portal_enabled) return null;
    return rows[0];
  }
  function requireSupplier(fn) {
    return async (req, res) => {
      try { const su = await supUser(req); if (!su) throw httpError(401, 'Sign in to the supplier portal'); req._su = su; await fn(req, res, su); }
      catch (e) { fail(res, e); }
    };
  }
  const perm = (su, key) => { const base = ROLE_PERMS[su.role] || {}; const ov = su.perms || {}; return ov[key] !== undefined ? !!ov[key] : !!base[key]; };
  const need = (su, key) => { if (!perm(su, key)) throw httpError(403, 'Your supplier role cannot do this. Ask your account owner.'); };

  app.post('/api/supplier/login', async (req, res) => {
    try {
      const email = String((req.body || {}).email || '').trim().toLowerCase();
      const pw = String((req.body || {}).password || '');
      if (!email || !pw) throw httpError(400, 'Email and password are required');
      const { rows } = await query(`SELECT su.*, s.portal_enabled FROM supplier_users su JOIN suppliers s ON s.id = su.supplier_id WHERE lower(su.email) = lower($1)`, [email]);
      const u = rows[0];
      if (u && u.locked_until && new Date(u.locked_until) > new Date()) throw httpError(423, 'Too many wrong tries. Try again later.');
      const okPw = u && u.password_hash && await bcrypt.compare(pw, u.password_hash);
      if (!u || !okPw) {
        if (u) { const n = (u.failed_logins || 0) + 1; await query(`UPDATE supplier_users SET failed_logins = $2, locked_until = CASE WHEN $2 >= 6 THEN NOW() + INTERVAL '15 minutes' ELSE locked_until END WHERE id = $1`, [u.id, n]); }
        throw httpError(401, 'Email or password is wrong');
      }
      if (!u.is_active) throw httpError(403, 'This supplier login is switched off. Ask the shop.');
      if (!u.portal_enabled) throw httpError(403, 'The supplier portal is not switched on for your company yet. Ask the shop.');
      await query(`UPDATE supplier_users SET failed_logins = 0, locked_until = NULL, last_login_at = NOW() WHERE id = $1`, [u.id]);
      req.session.supplierUserId = u.id; req.session.supplierId = u.supplier_id;
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/supplier/logout', (req, res) => { if (req.session) { req.session.supplierUserId = null; req.session.supplierId = null; } res.json({ ok: true }); });

  app.get('/api/supplier/me', requireSupplier(async (req, res, su) => {
    const { rows: nn } = await query(`SELECT COUNT(*)::int AS n FROM supplier_orders WHERE supplier_id = $1 AND status = 'new'`, [su.supplier_id]);
    res.json({ user: { id: su.id, email: su.email, name: su.name, role: su.role }, supplier: { id: su.supplier_id, name: su.supplier_name, web_retail: su.web_retail_enabled },
      perms: { items: perm(su, 'items'), orders: perm(su, 'orders'), retail: perm(su, 'retail'), financials: perm(su, 'financials'), staff: perm(su, 'staff'), settings: perm(su, 'settings') },
      new_orders: nn[0].n });
  }));
  app.post('/api/supplier/change-password', requireSupplier(async (req, res, su) => {
    const b = req.body || {};
    if (!(await bcrypt.compare(String(b.current || ''), su.password_hash || ''))) throw httpError(403, 'Your current password is wrong');
    if (String(b.password || '').length < 8) throw httpError(400, 'Use at least 8 characters');
    await query(`UPDATE supplier_users SET password_hash = $2 WHERE id = $1`, [su.id, await bcrypt.hash(b.password, 10)]);
    res.json({ ok: true });
  }));

  // --------------------------------------------------------- supplier staff --
  app.get('/api/supplier/staff', requireSupplier(async (req, res, su) => {
    need(su, 'staff');
    const { rows } = await query(`SELECT id, email, name, phone, role, is_active, last_login_at, created_at FROM supplier_users WHERE supplier_id = $1 ORDER BY role, name`, [su.supplier_id]);
    res.json({ staff: rows });
  }));
  app.post('/api/supplier/staff', requireSupplier(async (req, res, su) => {
    need(su, 'staff');
    const b = req.body || {}; const email = String(b.email || '').trim().toLowerCase();
    if (!email || !/@/.test(email)) throw httpError(400, 'A valid email is needed');
    if (String(b.password || '').length < 8) throw httpError(400, 'Set a password of at least 8 characters');
    const role = ['manager', 'staff'].includes(b.role) ? b.role : 'staff';   // owners are created by the shop
    try {
      const { rows } = await query(`INSERT INTO supplier_users (supplier_id, email, password_hash, name, phone, role) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [su.supplier_id, email, await bcrypt.hash(b.password, 10), b.name || null, b.phone || null, role]);
      res.json({ ok: true, id: rows[0].id });
    } catch (e) { fail(res, e.code === '23505' ? httpError(409, 'That email already has a login') : e); }
  }));
  app.patch('/api/supplier/staff/:id(\\d+)', requireSupplier(async (req, res, su) => {
    need(su, 'staff');
    const b = req.body || {}; const id = int(req.params.id);
    if (id === su.id && (b.role || b.is_active === false)) throw httpError(400, 'You cannot change your own role or switch yourself off');
    const sets = [], vals = [id, su.supplier_id];
    if (b.name !== undefined) { vals.push(b.name || null); sets.push('name = $' + vals.length); }
    if (b.phone !== undefined) { vals.push(b.phone || null); sets.push('phone = $' + vals.length); }
    if (b.role && ['manager', 'staff'].includes(b.role)) { vals.push(b.role); sets.push('role = $' + vals.length); }
    if (b.is_active !== undefined) { vals.push(!!b.is_active); sets.push('is_active = $' + vals.length); }
    if (b.password && String(b.password).length >= 8) { vals.push(await bcrypt.hash(b.password, 10)); sets.push('password_hash = $' + vals.length); }
    if (!sets.length) return res.json({ ok: true });
    await query(`UPDATE supplier_users SET ${sets.join(', ')} WHERE id = $1 AND supplier_id = $2 AND role <> 'owner'`, vals);
    res.json({ ok: true });
  }));

  // -------------------------------------------------------- account status --
  async function accountStatus(supplierId) {
    // What we owe: unvoided AP bills (positive) minus credits, minus payments, plus unsettled consignment.
    const { rows: ap } = await query(`SELECT
        COALESCE(SUM(CASE WHEN kind = 'bill' THEN total ELSE -total END) FILTER (WHERE voided_at IS NULL), 0)::numeric AS billed,
        COALESCE(SUM(total) FILTER (WHERE voided_at IS NULL AND kind = 'bill' AND due_date < CURRENT_DATE), 0)::numeric AS overdue
      FROM ap_bills WHERE supplier_id = $1`, [supplierId]);
    const { rows: paid } = await query(`SELECT COALESCE(SUM(amount), 0)::numeric AS paid FROM ap_payments WHERE supplier_id = $1 AND voided_at IS NULL`, [supplierId]).catch(() => ({ rows: [{ paid: 0 }] }));
    const { rows: con } = await query(`SELECT COALESCE(SUM(amount), 0)::numeric AS owed FROM consignment_ledger WHERE supplier_id = $1 AND settled = false`, [supplierId]);
    const { rows: s } = await query(`SELECT name, credit_limit, credit_set_by, credit_updated_at, payment_terms, payment_terms_days, currency FROM suppliers WHERE id = $1`, [supplierId]);
    const balance = Number(ap[0].billed) - Number(paid[0].paid) + Number(con[0].owed);
    return { supplier: s[0], balance: Math.round(balance * 100) / 100, bills_outstanding: Math.round((Number(ap[0].billed) - Number(paid[0].paid)) * 100) / 100,
      overdue: Number(ap[0].overdue), consignment_owed: Number(con[0].owed), credit_limit: s[0].credit_limit == null ? null : Number(s[0].credit_limit),
      available: s[0].credit_limit == null ? null : Math.round((Number(s[0].credit_limit) - balance) * 100) / 100 };
  }
  app.get('/api/supplier/account', requireSupplier(async (req, res, su) => {
    need(su, 'financials');
    const st = await accountStatus(su.supplier_id);
    const { rows: recent } = await query(`SELECT 'bill' AS kind, number AS ref, bill_date AS at, total AS amount, voided_at FROM ap_bills WHERE supplier_id = $1
      UNION ALL SELECT 'consignment sale', sale_ref, created_at::date, amount, NULL FROM consignment_ledger WHERE supplier_id = $1 AND kind = 'sale'
      ORDER BY at DESC LIMIT 30`, [su.supplier_id]);
    res.json(Object.assign(st, { recent }));
  }));
  // The supplier sets the credit limit they extend to us.
  app.put('/api/supplier/credit', requireSupplier(async (req, res, su) => {
    need(su, 'financials');
    const lim = money((req.body || {}).credit_limit);
    if (lim != null && lim < 0) throw httpError(400, 'The credit limit cannot be negative');
    await query(`UPDATE suppliers SET credit_limit = $2, credit_set_by = 'supplier', credit_updated_at = NOW() WHERE id = $1`, [su.supplier_id, lim]);
    res.json(Object.assign({ ok: true }, await accountStatus(su.supplier_id)));
  }));

  // --------------------------------------------------------------- items --
  function itemFields(b, partial) {
    const f = {};
    if (!partial || 'name' in b) { const t = String(b.name || '').trim(); if (!t) throw httpError(400, 'An item name is needed'); f.name = t.slice(0, 200); }
    for (const k of ['supplier_sku', 'brand', 'category', 'description', 'barcode', 'warehouse_location']) if (!partial || k in b) f[k] = String(b[k] || '').trim().slice(0, k === 'description' ? 1000 : 120) || null;
    for (const k of ['supply_price', 'retail_price']) if (!partial || k in b) f[k] = money(b[k]);
    if (!partial || 'qty_available' in b) f.qty_available = Math.max(0, int(b.qty_available) || 0);
    if (!partial || 'is_consignment' in b) f.is_consignment = !!b.is_consignment;
    if (!partial || 'web_retail' in b) f.web_retail = !!b.web_retail;
    if ('product_img' in b) f.product_img = b.product_img ? String(b.product_img) : null;
    if ('status' in b && ['active', 'inactive'].includes(b.status)) f.status = b.status;
    return f;
  }
  app.get('/api/supplier/items', requireSupplier(async (req, res, su) => {
    const q = String(req.query.q || '').trim();
    const args = [su.supplier_id]; let where = 'si.supplier_id = $1';
    if (q) { args.push('%' + q + '%'); where += ` AND (si.name ILIKE $2 OR si.supplier_sku ILIKE $2 OR si.brand ILIKE $2 OR si.barcode ILIKE $2)`; }
    if (req.query.consignment === '1') where += ' AND si.is_consignment';
    const { rows } = await query(`SELECT si.*, p.name AS our_name, p.cost_usd AS our_cost, p.price_usd AS our_price, p.stock_count AS our_stock
      FROM supplier_items si LEFT JOIN products p ON p.img = si.product_img WHERE ${where} ORDER BY si.updated_at DESC LIMIT 500`, args);
    res.json({ items: rows });
  }));
  app.post('/api/supplier/items', requireSupplier(async (req, res, su) => {
    need(su, 'items');
    const f = itemFields(req.body || {}, false);
    const cols = Object.keys(f).concat(['supplier_id', 'created_by']); const vals = cols.map((k) => k === 'supplier_id' ? su.supplier_id : k === 'created_by' ? su.id : f[k]);
    try {
      const { rows } = await query(`INSERT INTO supplier_items (${cols.join(', ')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(', ')}) RETURNING id`, vals);
      res.json({ ok: true, id: rows[0].id });
    } catch (e) { fail(res, e.code === '23505' ? httpError(409, 'You already have an item with that SKU') : e); }
  }));
  app.patch('/api/supplier/items/:id(\\d+)', requireSupplier(async (req, res, su) => {
    need(su, 'items');
    const f = itemFields(req.body || {}, true); const cols = Object.keys(f);
    if (!cols.length) return res.json({ ok: true });
    await query(`UPDATE supplier_items SET ${cols.map((k, i) => k + ' = $' + (i + 3)).join(', ')}, updated_at = NOW() WHERE id = $1 AND supplier_id = $2`, [int(req.params.id), su.supplier_id].concat(cols.map((k) => f[k])));
    res.json({ ok: true });
  }));
  app.delete('/api/supplier/items/:id(\\d+)', requireSupplier(async (req, res, su) => {
    need(su, 'items');
    await query(`UPDATE supplier_items SET status = 'inactive', updated_at = NOW() WHERE id = $1 AND supplier_id = $2`, [int(req.params.id), su.supplier_id]);
    res.json({ ok: true });
  }));

  // Upload a price list (CSV): columns sku,name,brand,price[,retail,qty,barcode,location].
  app.post('/api/supplier/items/upload', requireSupplier(async (req, res, su) => {
    need(su, 'items');
    await new Promise((resolve, reject) => upload.single('file')(req, res, (e) => e ? reject(httpError(400, 'Could not read the file')) : resolve()));
    if (!req.file) throw httpError(400, 'Choose a CSV file');
    const rows = parseCsv(req.file.buffer.toString('utf8'));
    if (rows.length < 2) throw httpError(400, 'The file has no rows');
    const head = rows[0].map((h) => norm(h));
    const col = (names) => { for (const n of names) { const i = head.indexOf(n); if (i >= 0) return i; } return -1; };
    const ci = { sku: col(['sku', 'part', 'part no', 'part number', 'supplier sku', 'code']), name: col(['name', 'description', 'item', 'product']),
      brand: col(['brand', 'make', 'manufacturer']), price: col(['price', 'supply price', 'cost', 'unit price', 'our price']),
      retail: col(['retail', 'retail price', 'list', 'msrp']), qty: col(['qty', 'quantity', 'stock', 'available', 'on hand']),
      barcode: col(['barcode', 'upc', 'ean']), location: col(['location', 'bin', 'warehouse', 'aisle']) };
    if (ci.name < 0 && ci.sku < 0) throw httpError(400, 'The file needs at least a "name" or "sku" column');
    let added = 0, updated = 0; const items = [];
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r]; const get = (i) => i >= 0 ? String(row[i] || '').trim() : '';
      const sku = get(ci.sku) || null, name = get(ci.name) || sku;
      if (!name) continue;
      const price = money(get(ci.price)), retail = money(get(ci.retail)), qty = int(get(ci.qty));
      const f = { supplier_id: su.supplier_id, supplier_sku: sku, name: name.slice(0, 200), brand: get(ci.brand) || null,
        supply_price: price, retail_price: retail, qty_available: qty == null ? 0 : Math.max(0, qty), barcode: get(ci.barcode) || null,
        warehouse_location: get(ci.location) || null, created_by: su.id };
      // Upsert by (supplier, sku) when a sku is present, else by (supplier, name).
      let existing = null;
      if (sku) existing = (await query(`SELECT id FROM supplier_items WHERE supplier_id = $1 AND supplier_sku = $2`, [su.supplier_id, sku])).rows[0];
      if (!existing && !sku) existing = (await query(`SELECT id FROM supplier_items WHERE supplier_id = $1 AND lower(name) = lower($2) AND supplier_sku IS NULL`, [su.supplier_id, name])).rows[0];
      if (existing) {
        await query(`UPDATE supplier_items SET name = $2, brand = COALESCE($3, brand), supply_price = COALESCE($4, supply_price), retail_price = COALESCE($5, retail_price), qty_available = $6, barcode = COALESCE($7, barcode), warehouse_location = COALESCE($8, warehouse_location), status = 'active', updated_at = NOW() WHERE id = $1`,
          [existing.id, f.name, f.brand, f.supply_price, f.retail_price, f.qty_available, f.barcode, f.warehouse_location]);
        updated++; items.push({ id: existing.id, name: f.name, sku, supply_price: price });
      } else {
        const ins = await query(`INSERT INTO supplier_items (supplier_id, supplier_sku, name, brand, supply_price, retail_price, qty_available, barcode, warehouse_location, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [su.supplier_id, sku, f.name, f.brand, f.supply_price, f.retail_price, f.qty_available, f.barcode, f.warehouse_location, su.id]).catch(() => ({ rows: [] }));
        if (ins.rows.length) { added++; items.push({ id: ins.rows[0].id, name: f.name, sku, supply_price: price }); }
      }
    }
    const cmp = await compare(su.supplier_id);
    await query(`INSERT INTO supplier_catalog_uploads (supplier_id, filename, rows_total, rows_added, rows_updated, lost_sales_hits, cheaper_hits, result, uploaded_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [su.supplier_id, String(req.file.originalname || 'upload.csv').slice(0, 200), rows.length - 1, added, updated, cmp.lost_sales.length, cmp.cheaper.length, JSON.stringify({ counts: { added, updated } }), su.id]);
    res.json({ ok: true, rows: rows.length - 1, added, updated, compare: cmp });
  }));

  // ------------------------------------------------------------- compare --
  // Three checks the shop (and the supplier) cares about.
  async function compare(supplierId) {
    const { rows: items } = await query(`SELECT si.id, si.supplier_sku, si.name, si.barcode, si.supply_price, si.product_img,
        p.name AS our_name, p.cost_usd AS our_cost, p.price_usd AS our_price, p.stock_count AS our_stock
      FROM supplier_items si LEFT JOIN products p ON p.img = si.product_img WHERE si.supplier_id = $1 AND si.status = 'active'`, [supplierId]);
    // 1) lost sales we recorded that match a supplier item (by linked product, barcode, or name).
    const { rows: lost } = await query(`SELECT id, description, vehicle, qty, unit_price, reason, created_at, product_img FROM lost_sales
      WHERE created_at > NOW() - INTERVAL '365 days' AND reason IN ('out_of_stock', 'not_stocked', 'discontinued')`);
    const byImg = {}; items.forEach((i) => { if (i.product_img) (byImg[i.product_img] = byImg[i.product_img] || []).push(i); });
    const lost_sales = [];
    for (const l of lost) {
      let hit = null;
      if (l.product_img && byImg[l.product_img]) hit = byImg[l.product_img][0];
      if (!hit) { const d = norm(l.description); hit = items.find((i) => d && (norm(i.name) === d || (norm(i.name).length > 4 && d.includes(norm(i.name))))); }
      if (hit) lost_sales.push({ supplier_item_id: hit.id, supplier_item: hit.name, lost: l.description, vehicle: l.vehicle, qty: l.qty, quoted: l.unit_price == null ? null : Number(l.unit_price), when: l.created_at });
    }
    // 2) price vs our current cost, for items linked to one of our products.
    const cheaper = [], we_win = [];
    for (const i of items) {
      if (i.our_cost == null || i.supply_price == null) continue;
      const theirs = Number(i.supply_price), ours = Number(i.our_cost);
      if (theirs < ours) cheaper.push({ supplier_item_id: i.id, name: i.name, product_img: i.product_img, our_name: i.our_name, our_cost: ours, their_price: theirs, saving: Math.round((ours - theirs) * 100) / 100 });
      else if (ours < theirs) we_win.push({ supplier_item_id: i.id, name: i.name, our_name: i.our_name, our_cost: ours, their_price: theirs, we_save: Math.round((theirs - ours) * 100) / 100 });
    }
    // 3) our stale costs/prices on products linked to this supplier.
    const { rows: stale } = await query(`SELECT value FROM warehouse_settings WHERE key = 'cost_stale_days'`);
    const days = int(stale[0] && stale[0].value) || 365;
    const { rows: old } = await query(`SELECT p.img, p.name, p.cost_usd, p.price_usd, GREATEST(p.updated_at, p.last_counted_at) AS last
      FROM products p WHERE p.supplier_id = $1 AND p.is_active AND COALESCE(GREATEST(p.updated_at, p.last_counted_at), p.created_at) < NOW() - make_interval(days => $2) ORDER BY last NULLS FIRST LIMIT 100`, [supplierId, days]);
    return { lost_sales: lost_sales.slice(0, 100), cheaper, we_win, stale: old.map((o) => ({ product_img: o.img, name: o.name, cost: o.cost_usd == null ? null : Number(o.cost_usd), price: o.price_usd == null ? null : Number(o.price_usd), last: o.last })), days };
  }
  app.get('/api/supplier/compare', requireSupplier(async (req, res, su) => { res.json(await compare(su.supplier_id)); }));

  // --------------------------------------------------------------- orders --
  async function orderRow(id, supplierId) {
    const { rows } = await query(`SELECT o.*, (SELECT json_agg(l.* ORDER BY l.id) FROM supplier_order_lines l WHERE l.order_id = o.id) AS lines FROM supplier_orders o WHERE o.id = $1 AND o.supplier_id = $2`, [id, supplierId]);
    if (!rows.length) throw httpError(404, 'Order not found');
    return rows[0];
  }
  app.get('/api/supplier/orders', requireSupplier(async (req, res, su) => {
    const st = req.query.status;
    const args = [su.supplier_id]; let where = 'supplier_id = $1';
    if (st === 'open') where += ` AND status IN ('new','acknowledged','preparing')`;
    else if (st) { args.push(st); where += ' AND status = $2'; }
    const { rows } = await query(`SELECT o.*, (SELECT COUNT(*)::int FROM supplier_order_lines l WHERE l.order_id = o.id) AS line_count FROM supplier_orders o WHERE ${where} ORDER BY status = 'new' DESC, created_at DESC LIMIT 200`, args);
    res.json({ orders: rows });
  }));
  app.get('/api/supplier/orders/:id(\\d+)', requireSupplier(async (req, res, su) => { res.json({ order: await orderRow(int(req.params.id), su.supplier_id) }); }));
  app.patch('/api/supplier/orders/:id(\\d+)/status', requireSupplier(async (req, res, su) => {
    need(su, 'orders');
    const o = await orderRow(int(req.params.id), su.supplier_id);
    const to = String((req.body || {}).status || '');
    const flow = { new: ['acknowledged', 'cancelled'], acknowledged: ['preparing', 'cancelled'], preparing: ['shipped', 'cancelled'], shipped: ['received'] };
    if (!(flow[o.status] || []).includes(to)) throw httpError(409, 'Cannot move a ' + o.status + ' order to ' + to);
    const stamp = { acknowledged: 'acknowledged_at', shipped: 'shipped_at', received: 'received_at' }[to];
    await query(`UPDATE supplier_orders SET status = $2, tracking = COALESCE($3, tracking), ${stamp ? stamp + ' = NOW(),' : ''} updated_at = NOW() WHERE id = $1`, [o.id, to, (req.body || {}).tracking || null]);
    res.json({ ok: true });
  }));
  // Supplier makes a retail sale to a customer through our portal.
  app.post('/api/supplier/orders/retail', requireSupplier(async (req, res, su) => {
    need(su, 'retail');
    if (!su.web_retail_enabled) throw httpError(403, 'Retail through the portal is not switched on for your company. Ask the shop.');
    const b = req.body || {}; const lines = Array.isArray(b.lines) ? b.lines : [];
    if (!lines.length) throw httpError(400, 'Add at least one item');
    if (!String(b.customer_name || '').trim()) throw httpError(400, 'Who is the customer?');
    const number = (await query(`SELECT 'SPO-' || lpad(nextval('supplier_order_seq')::text, 6, '0') AS n`)).rows[0].n;
    const { rows: ins } = await query(`INSERT INTO supplier_orders (number, supplier_id, kind, status, customer_name, customer_phone, ship_address, notes, created_by_supplier)
      VALUES ($1,$2,'retail','preparing',$3,$4,$5,$6,$7) RETURNING id`, [number, su.supplier_id, String(b.customer_name).trim().slice(0, 120), b.customer_phone || null, b.ship_address || null, b.notes || null, su.id]);
    const oid = ins[0].id; let total = 0;
    for (const l of lines) {
      const it = (await query(`SELECT * FROM supplier_items WHERE id = $1 AND supplier_id = $2`, [int(l.supplier_item_id), su.supplier_id])).rows[0];
      if (!it) continue;
      const qty = Math.max(1, int(l.qty) || 1); const price = money(l.unit_price) != null ? money(l.unit_price) : Number(it.retail_price || 0);
      const lt = Math.round(qty * price * 100) / 100; total += lt;
      await query(`INSERT INTO supplier_order_lines (order_id, supplier_item_id, product_img, supplier_sku, description, warehouse_location, qty, unit_price, line_total)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [oid, it.id, it.product_img, it.supplier_sku, it.name, it.warehouse_location, qty, price, lt]);
    }
    await query(`UPDATE supplier_orders SET total = $2 WHERE id = $1`, [oid, Math.round(total * 100) / 100]);
    res.json({ ok: true, id: oid, number });
  }));
  // Printable pick list / packing slip / shipping label (from our system).
  app.get('/api/supplier/orders/:id(\\d+)/slip', requireSupplier(async (req, res, su) => {
    const o = await orderRow(int(req.params.id), su.supplier_id);
    const doc = ['pick', 'pack', 'ship'].includes(req.query.doc) ? req.query.doc : 'pick';
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const lines = o.lines || [];
    const title = { pick: 'PICK LIST', pack: 'PACKING SLIP', ship: 'SHIPPING LABEL' }[doc];
    let body;
    if (doc === 'ship') {
      body = '<div class="label"><div class="from">From: ' + esc(su.supplier_name) + '</div><h2>SHIP TO</h2><div class="to">' + esc(o.customer_name || '') + '<br>' + esc(o.customer_phone || '') + '<br>' + esc(o.ship_address || '').replace(/\n/g, '<br>') + '</div>' +
        '<div class="bc">' + esc(o.number) + '</div>' + (o.tracking ? '<div>Tracking: ' + esc(o.tracking) + '</div>' : '') + '</div>';
    } else {
      body = '<table><thead><tr><th>#</th>' + (doc === 'pick' ? '<th>Location</th>' : '') + '<th>SKU</th><th>Item</th><th>Qty</th>' + (doc === 'pack' ? '<th>Each</th><th>Total</th>' : '') + '</tr></thead><tbody>' +
        lines.map((l, i) => '<tr><td>' + (i + 1) + '</td>' + (doc === 'pick' ? '<td><b>' + esc(l.warehouse_location || '—') + '</b></td>' : '') + '<td>' + esc(l.supplier_sku || '') + '</td><td>' + esc(l.description) + '</td><td>' + l.qty + '</td>' +
          (doc === 'pack' ? '<td>' + Number(l.unit_price).toFixed(2) + '</td><td>' + Number(l.line_total).toFixed(2) + '</td>' : '') + '</tr>').join('') + '</tbody></table>' +
        (doc === 'pack' ? '<p style="text-align:right;font-weight:bold">Total: J$' + Number(o.total).toLocaleString('en-JM', { minimumFractionDigits: 2 }) + '</p>' : '');
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    res.send('<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="/favicon.svg?v=vision2" type="image/svg+xml"><link rel="icon" href="/favicon.ico?v=vision2" sizes="any"><link rel="apple-touch-icon" href="/apple-touch-icon.png?v=vision2"><title>' + title + ' ' + esc(o.number) + '</title><style>' +
      'body{font-family:Arial,sans-serif;max-width:720px;margin:20px auto;padding:0 16px;color:#111}h1{border-bottom:3px solid #d61f2b;padding-bottom:6px}' +
      'table{border-collapse:collapse;width:100%;margin-top:10px}th,td{border:1px solid #ccc;padding:7px 9px;text-align:left}th{background:#f3f4f5}' +
      '.label{border:2px solid #111;padding:18px;margin-top:12px}.label h2{margin:8px 0}.to{font-size:20px;font-weight:bold}.bc{font-family:monospace;font-size:22px;margin-top:12px;letter-spacing:2px}.from{color:#555}' +
      '@media print{body{margin:0}}</style></head><body><h1>' + title + '</h1><p><b>' + esc(o.number) + '</b> &middot; ' + esc(su.supplier_name) + ' &middot; ' + new Date(o.created_at).toLocaleDateString('en-GB') +
      (o.customer_name ? ' &middot; for ' + esc(o.customer_name) : '') + '</p>' + body + '<p style="margin-top:20px;color:#777;font-size:12px">Printed from Morty\'s Auto Parts</p></body></html>');
  }));

  // --------------------------------------------------------------- reports --
  app.get('/api/supplier/reports', requireSupplier(async (req, res, su) => {
    need(su, 'financials');
    // Sales to the supplier's credit: consignment sales + shipped retail lines.
    const { rows: best } = await query(`SELECT name, SUM(qty)::int AS units, SUM(value)::numeric AS value, SUM(profit)::numeric AS profit, MIN(first_at) AS first_at, MAX(last_at) AS last_at FROM (
        SELECT si.name, cl.qty, (cl.qty * cl.unit_cost) AS value, 0::numeric AS profit, cl.created_at AS first_at, cl.created_at AS last_at
          FROM consignment_ledger cl JOIN supplier_items si ON si.id = cl.supplier_item_id WHERE cl.supplier_id = $1 AND cl.kind = 'sale'
        UNION ALL
        SELECT l.description AS name, l.qty_shipped AS qty, (l.qty_shipped * l.unit_price) AS value, 0::numeric, o.shipped_at, o.shipped_at
          FROM supplier_order_lines l JOIN supplier_orders o ON o.id = l.order_id WHERE o.supplier_id = $1 AND o.status IN ('shipped','received') AND l.qty_shipped > 0
      ) t GROUP BY name`, [su.supplier_id]);
    const now = Date.now();
    const withVel = best.map((b) => { const span = Math.max(1, (now - new Date(b.first_at || now)) / 86400000); return Object.assign({}, b, { units: Number(b.units), value: Number(b.value), per_week: Math.round((Number(b.units) / span) * 7 * 10) / 10 }); });
    res.json({
      best_selling: withVel.slice().sort((a, b) => b.units - a.units).slice(0, 15),
      fastest_moving: withVel.slice().sort((a, b) => b.per_week - a.per_week).slice(0, 15),
      most_value: withVel.slice().sort((a, b) => b.value - a.value).slice(0, 15),
      total_units: withVel.reduce((s, b) => s + b.units, 0), total_value: Math.round(withVel.reduce((s, b) => s + b.value, 0) * 100) / 100,
    });
  }));

  // --------------------------------------------------------------- training --
  app.get('/api/supplier/training', requireSupplier(async (req, res, su) => {
    const { rows } = await query(`SELECT id, title, body, url, created_at FROM supplier_training WHERE supplier_id IS NULL OR supplier_id = $1 ORDER BY sort, created_at DESC`, [su.supplier_id]);
    res.json({ items: rows });
  }));

  // =========================================================== shop admin ==
  // The shop enables the portal, invites supplier logins, sets credit, and
  // publishes training. Guarded by the suppliers.manage permission.
  app.get('/api/admin/suppliers/:id(\\d+)/portal', requireCap('suppliers.manage'), async (req, res) => {
    try {
      const id = int(req.params.id);
      const { rows: s } = await query(`SELECT id, name, portal_enabled, web_retail_enabled, credit_limit, credit_set_by, credit_updated_at FROM suppliers WHERE id = $1`, [id]);
      if (!s.length) throw httpError(404, 'Supplier not found');
      const { rows: users } = await query(`SELECT id, email, name, role, is_active, last_login_at, created_at FROM supplier_users WHERE supplier_id = $1 ORDER BY role, name`, [id]);
      const { rows: counts } = await query(`SELECT (SELECT COUNT(*)::int FROM supplier_items WHERE supplier_id = $1 AND status='active') AS items,
        (SELECT COUNT(*)::int FROM supplier_orders WHERE supplier_id = $1 AND status <> 'cancelled') AS orders`, [id]);
      res.json({ supplier: s[0], users, counts: counts[0], account: await accountStatus(id) });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/admin/suppliers/:id(\\d+)/portal', requireCap('suppliers.manage'), async (req, res) => {
    try {
      const b = req.body || {}; const sets = [], vals = [int(req.params.id)];
      if ('portal_enabled' in b) { vals.push(!!b.portal_enabled); sets.push('portal_enabled = $' + vals.length); }
      if ('web_retail_enabled' in b) { vals.push(!!b.web_retail_enabled); sets.push('web_retail_enabled = $' + vals.length); }
      if ('credit_limit' in b) { vals.push(money(b.credit_limit)); sets.push('credit_limit = $' + vals.length); sets.push("credit_set_by = 'admin'"); sets.push('credit_updated_at = NOW()'); }
      if (!sets.length) return res.json({ ok: true });
      await query(`UPDATE suppliers SET ${sets.join(', ')} WHERE id = $1`, vals);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/admin/suppliers/:id(\\d+)/users', requireCap('suppliers.manage'), async (req, res) => {
    try {
      const id = int(req.params.id); const b = req.body || {};
      const email = String(b.email || '').trim().toLowerCase();
      if (!email || !/@/.test(email)) throw httpError(400, 'A valid email is needed');
      const pw = String(b.password || '') || crypto.randomBytes(6).toString('base64url');
      const role = ['owner', 'manager', 'staff'].includes(b.role) ? b.role : 'owner';
      const { rows } = await query(`INSERT INTO supplier_users (supplier_id, email, password_hash, name, phone, role, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [id, email, await bcrypt.hash(pw, 10), b.name || null, b.phone || null, role, req.session.userId]);
      await query(`UPDATE suppliers SET portal_enabled = true WHERE id = $1`, [id]);
      if (!devMode && mailer && mailer.sendEmail) {
        const { rows: s } = await query(`SELECT name FROM suppliers WHERE id = $1`, [id]);
        const base = (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.get('host');
        mailer.sendEmail({ to: email, subject: 'Your Morty\'s Auto supplier portal login', text: 'Hello,\n\n' + (s[0] && s[0].name) + ' has a supplier portal with Morty\'s Auto Parts.\n\nSign in at ' + base + '/supplier.html\nEmail: ' + email + '\nTemporary password: ' + pw + '\n\nPlease change your password after you sign in.\n\nMorty\'s Auto Parts, 876-905-4111' }).catch(() => {});
      }
      res.json({ ok: true, id: rows[0].id, temp_password: b.password ? undefined : pw });
    } catch (e) { fail(res, e.code === '23505' ? httpError(409, 'That email already has a supplier login') : e); }
  });
  app.post('/api/admin/suppliers/:sid(\\d+)/users/:id(\\d+)/reset', requireCap('suppliers.manage'), async (req, res) => {
    try {
      const pw = crypto.randomBytes(6).toString('base64url');
      await query(`UPDATE supplier_users SET password_hash = $3, failed_logins = 0, locked_until = NULL WHERE id = $1 AND supplier_id = $2`, [int(req.params.id), int(req.params.sid), await bcrypt.hash(pw, 10)]);
      res.json({ ok: true, temp_password: pw });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/admin/supplier-training', requireCap('suppliers.manage'), async (req, res) => {
    try { const { rows } = await query(`SELECT t.*, s.name AS supplier_name FROM supplier_training t LEFT JOIN suppliers s ON s.id = t.supplier_id ORDER BY t.sort, t.created_at DESC`); res.json({ items: rows }); } catch (e) { fail(res, e); }
  });
  app.post('/api/admin/supplier-training', requireCap('suppliers.manage'), async (req, res) => {
    try {
      const b = req.body || {}; if (!String(b.title || '').trim()) throw httpError(400, 'A title is needed');
      const { rows } = await query(`INSERT INTO supplier_training (supplier_id, title, body, url, sort, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [int(b.supplier_id) || null, String(b.title).slice(0, 200), b.body || null, b.url || null, int(b.sort) || 0, req.session.userId]);
      res.json({ ok: true, id: rows[0].id });
    } catch (e) { fail(res, e); }
  });
  app.delete('/api/admin/supplier-training/:id(\\d+)', requireCap('suppliers.manage'), async (req, res) => {
    try { await query(`DELETE FROM supplier_training WHERE id = $1`, [int(req.params.id)]); res.json({ ok: true }); } catch (e) { fail(res, e); }
  });

  return { compare, accountStatus };
};
