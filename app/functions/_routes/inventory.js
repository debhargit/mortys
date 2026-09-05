// Phase 6 — inventory + purchasing writes, and the CSV importer. Ports:
//   PATCH  /api/admin/products/:img            POST /api/admin/products
//   DELETE /api/admin/products/:img
//   GET/POST /api/admin/suppliers   PATCH/DELETE /api/admin/suppliers/:id
//   GET/PATCH /api/admin/products-ext[/:img]
//   GET  /api/admin/purchase-orders            GET /api/admin/purchase-orders/:id
//   POST /api/admin/purchase-orders            PATCH /api/admin/purchase-orders/:id
//   POST /api/admin/purchase-orders/:id/items
//   DELETE /api/admin/purchase-orders/:poId/items/:id
//   POST /api/admin/purchase-orders/:id/receive
//   POST /api/admin/receive                    (stock-in without a PO)
//   GET  /api/admin/inventory/import/columns
//   GET  /api/admin/inventory/import/template.csv
//   POST /api/admin/inventory/import           POST /api/admin/import/parts (alias)
//
// D1 notes: money is *_cents (converted at the SELECT boundary / with money.js);
// products has no `id` — children link on product_img; warehouse_activity has
// the 0004 shape (kind/qty_before/qty_after/qty_delta). No interactive txns —
// the receive paths do every read, compute in JS, then one db.batch().
import { d1 } from '../_lib/db.js';
import { adminMw, managerMw, userCan } from '../_lib/guards.js';
import { boolify, safeJson } from '../_lib/util.js';
import { usdToCents } from '../_lib/money.js';
import { readUploadBody, putUpload } from '../_lib/uploads.js';
import { PUSHABLE_FIELDS, toColumnValue, valuesEqual } from '../_lib/product_matrix.js';
import {
  parseInventoryFile, TEMPLATE_CSV, FIELD_SYNONYMS,
} from '../_lib/inventory_import.js';

const IMPORT_MAX_BYTES = 8 * 1024 * 1024; // 8 MB — a 20k-row CSV is ~2 MB

// Which product columns an uploaded file may write, and how each behaves on a
// row that already exists (mirrors server.js IMPORT_COLUMN_RULES, in *_cents).
const IMPORT_COLUMN_RULES = {
  sku:           'fill',
  name:          'name',
  make_model:    'name',
  category:      'overwrite',
  condition:     'overwrite',
  price_cents:   'fill',
  cost_cents:    'fill',
  stock_count:   'overwrite',
  low_threshold: 'overwrite',
  bin_location:  'overwrite',
  location:      'overwrite',
  barcode:       'fill',
};
const IMPORT_COLUMNS = Object.keys(IMPORT_COLUMN_RULES);
// file -> canonical field name for the "did the file supply this column?" test
const COL_SOURCE_FIELD = {
  price_cents: 'price_usd', cost_cents: 'cost_usd',
};

const num = (v) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const toBit = (v) => (v === false || v === 0 || v === '0' || v === 'false' ? 0 : 1);

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function recalcPoTotals(db, poId) {
  const it = await db.one('SELECT COALESCE(SUM(total_cents),0) AS s FROM purchase_order_items WHERE po_id = ?', poId);
  const po = await db.one('SELECT shipping_cents AS sh, tax_cents AS tx FROM purchase_orders WHERE id = ?', poId);
  const sub = (it && it.s) || 0;
  const tot = sub + ((po && po.sh) || 0) + ((po && po.tx) || 0);
  await db.run('UPDATE purchase_orders SET subtotal_cents = ?, total_cents = ? WHERE id = ?', sub, tot, poId);
}

async function nextPoNumber(db) {
  const year = new Date().getFullYear();
  const r = await db.one('SELECT COUNT(*) AS n FROM purchase_orders WHERE po_number LIKE ?', `PO-${year}-%`);
  return `PO-${year}-${String(((r && r.n) || 0) + 1).padStart(4, '0')}`;
}

const PO_USD_ALIASES = `total_cents / 100.0 AS total_usd,
  subtotal_cents / 100.0 AS subtotal_usd,
  shipping_cents / 100.0 AS shipping_usd,
  tax_cents / 100.0 AS tax_usd`;

export default function mount(app) {
  // =====================================================================
  //  PRODUCTS — quick edit / create / deactivate
  // =====================================================================
  app.patch('/api/admin/products/:img', adminMw, async (c) => {
    const db = d1(c.env);
    const me = c.get('user');
    const b = await c.req.json().catch(() => ({}));
    if ((b.price_usd != null || b.cost_usd != null || b.list_price_usd != null || b.sale_price_usd !== undefined) && !userCan(me, 'inventory.edit_price'))
      return c.json({ error: 'Your account is not allowed to edit product pricing.' }, 403);
    if (b.stock_count != null && !userCan(me, 'inventory.adjust_stock'))
      return c.json({ error: 'Your account is not allowed to adjust stock counts.' }, 403);

    const sets = []; const vals = [];
    const put = (frag, v) => { sets.push(frag); vals.push(v); };
    const numOrNull = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
    const intOrNull = (v) => (v === '' || v == null ? null : parseInt(v, 10));
    if (b.stock_count != null) put('stock_count = ?', parseInt(b.stock_count, 10));
    if (b.price_usd != null) put('price_cents = ?', usdToCents(b.price_usd));
    if (b.cost_usd != null) put('cost_cents = ?', b.cost_usd === '' ? null : usdToCents(b.cost_usd));
    if (b.list_price_usd != null) put('list_price_cents = ?', b.list_price_usd === '' ? null : usdToCents(b.list_price_usd));
    if (b.markup_pct !== undefined) put('markup_pct = ?', numOrNull(b.markup_pct));
    if (b.supplier_id !== undefined) put('supplier_id = ?', b.supplier_id ? parseInt(b.supplier_id, 10) : null);
    if (b.supplier_part_no !== undefined) put('supplier_part_no = ?', String(b.supplier_part_no || '').trim() || null);
    if (b.costing_method !== undefined) put('costing_method = ?', String(b.costing_method || '').trim() || null);
    if (b.stock_uom !== undefined) put('stock_uom = ?', String(b.stock_uom || '').trim() || null);
    if (b.purchase_uom !== undefined) put('purchase_uom = ?', String(b.purchase_uom || '').trim() || null);
    if (b.units_per_purchase !== undefined) put('units_per_purchase = ?', numOrNull(b.units_per_purchase));
    if (b.warranty_days !== undefined) put('warranty_days = ?', intOrNull(b.warranty_days));
    if (b.serial_required !== undefined) put('serial_required = ?', toBit(b.serial_required));
    if (b.core_charge_usd !== undefined) put('core_charge_cents = ?', usdToCents(b.core_charge_usd) || 0);
    if (b.env_fee_usd !== undefined) put('env_fee_cents = ?', usdToCents(b.env_fee_usd) || 0);
    if (b.low_threshold != null) put('low_threshold = ?', Math.max(0, parseInt(b.low_threshold, 10) || 0));
    if (b.is_active != null) put('is_active = ?', toBit(b.is_active));
    if (b.name != null) put('name = ?', String(b.name));
    if (b.sku != null) put('sku = ?', String(b.sku).trim() || null);
    if (b.barcode != null) put('barcode = ?', String(b.barcode).trim() || null);
    if (b.make_model != null) put('make_model = ?', String(b.make_model));
    if (b.category != null) put('category = ?', String(b.category));
    if (b.condition != null) put('condition = ?', String(b.condition));
    if (b.location != null) put('location = ?', String(b.location));
    if (b.bin_location != null) put('bin_location = ?', String(b.bin_location));
    if (b.commission_type !== undefined) {
      const t = String(b.commission_type || '').trim();
      put('commission_type = ?', ['percent', 'amount', 'none'].includes(t) ? t : null);
    }
    if (b.commission_value !== undefined) put('commission_value = ?', numOrNull(b.commission_value));
    if (b.sale_price_usd !== undefined) put('sale_price_cents = ?', b.sale_price_usd === '' ? null : usdToCents(b.sale_price_usd));
    if (b.sale_starts_at !== undefined) put('sale_starts_at = ?', b.sale_starts_at || null);
    if (b.sale_ends_at !== undefined) put('sale_ends_at = ?', b.sale_ends_at || null);
    if (b.max_discount_pct !== undefined) put('max_discount_pct = ?', numOrNull(b.max_discount_pct));
    if (b.is_redeemable !== undefined) put('is_redeemable = ?', toBit(b.is_redeemable));
    if (b.restricted_instore_only !== undefined) put('restricted_instore_only = ?', toBit(b.restricted_instore_only));
    if (b.restricted_manager_approval !== undefined) put('restricted_manager_approval = ?', toBit(b.restricted_manager_approval));
    if (b.restricted_id_required !== undefined) put('restricted_id_required = ?', toBit(b.restricted_id_required));
    if (b.restricted_tax_id_required !== undefined) put('restricted_tax_id_required = ?', toBit(b.restricted_tax_id_required));
    if (b.item_type !== undefined) {
      const t = String(b.item_type || '').trim();
      put('item_type = ?', ['inventory', 'tracked', 'service'].includes(t) ? t : 'inventory');
    }

    // Matrix-item bookkeeping: a plain save from the product editor always
    // resubmits every field, not just the deltas, so "touched" alone can't
    // mean "overridden" -- compare the incoming value to the matrix's
    // *current* shared value instead. A field only diverges (and stops
    // inheriting future "push to children" edits) when it now actually
    // differs; retyping the shared value re-aligns it automatically.
    const touchedShared = PUSHABLE_FIELDS.filter((f) => b[f.key] !== undefined);
    if (touchedShared.length) {
      const row = await db.one('SELECT matrix_id, matrix_overrides FROM products WHERE img = ?', c.req.param('img'));
      const parent = row && row.matrix_id ? await db.one('SELECT * FROM product_matrices WHERE id = ?', row.matrix_id) : null;
      if (parent) {
        const ov = new Set(safeJson(row.matrix_overrides, []));
        for (const f of touchedShared) {
          const childVal = toColumnValue(f.kind, f.col, b[f.key]);
          if (valuesEqual(f.kind, childVal, parent[f.col])) ov.delete(f.key); else ov.add(f.key);
        }
        put('matrix_overrides = ?', JSON.stringify([...ov]));
      }
    }

    if (!sets.length) return c.json({ error: 'Nothing to update' }, 400);
    sets.push('updated_at = CURRENT_TIMESTAMP');
    vals.push(c.req.param('img'));
    await db.run(`UPDATE products SET ${sets.join(', ')} WHERE img = ?`, ...vals);
    return c.json({ ok: true });
  });

  // Create a product. Accepts a multipart body with a `photo` file (stored in
  // R2, Phase 7) or a JSON body carrying an `img` image URL. When R2 is not
  // yet enabled the upload path returns a clean 501 (see _lib/uploads.js).
  app.post('/api/admin/products', adminMw, async (c) => {
    const db = d1(c.env);
    let file, body, upload;
    try {
      ({ file, body } = await readUploadBody(c, ['photo']));
      if (file) {
        if (file.size > 12 * 1024 * 1024) return c.json({ error: 'Image too large — the limit is 12 MB.' }, 413);
        upload = await putUpload(c.env, {
          prefix: 'products', bytes: new Uint8Array(await file.arrayBuffer()),
          contentType: file.type, filename: file.name,
        });
      }
    } catch (e) {
      if (e.userFacing) return c.json({ error: e.message }, e.status || 400);
      throw e;
    }
    const b = body || {};
    const img = upload ? upload.url : b.img;
    if (!img) return c.json({ error: 'A photo upload or an img image URL is required' }, 400);
    if (!b.name || !b.category) return c.json({ error: 'name and category are required' }, 400);
    const condition = ['NEW', 'USED'].includes(String(b.condition || '').toUpperCase())
      ? b.condition.toUpperCase() : 'USED';
    const exists = await db.one('SELECT img FROM products WHERE img = ?', img);
    if (exists) return c.json({ error: 'A product with that image key already exists' }, 409);
    const nn = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
    const trimOrNull = (v) => (v && String(v).trim() ? String(v).trim() : null);
    const itemType = ['inventory', 'tracked', 'service'].includes(String(b.item_type || '').trim()) ? b.item_type : 'inventory';
    await db.run(
      `INSERT INTO products
         (img, name, make_model, category, condition, price_cents, cost_cents, list_price_cents,
          stock_count, low_threshold, location, bin_location, sku, barcode, supplier_id, supplier_part_no,
          markup_pct, costing_method, warranty_days, serial_required, stock_uom, purchase_uom, units_per_purchase, item_type)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      img, b.name, b.make_model || '', b.category, condition,
      b.price_usd ? usdToCents(b.price_usd) : null,
      b.cost_usd ? usdToCents(b.cost_usd) : null,
      b.list_price_usd ? usdToCents(b.list_price_usd) : null,
      b.stock_count != null ? parseInt(b.stock_count, 10) : 1,
      b.low_threshold != null ? parseInt(b.low_threshold, 10) : 0,
      b.location || null, b.bin_location || null,
      trimOrNull(b.sku), trimOrNull(b.barcode),
      b.supplier_id ? parseInt(b.supplier_id, 10) : null, trimOrNull(b.supplier_part_no),
      nn(b.markup_pct), trimOrNull(b.costing_method),
      b.warranty_days === '' || b.warranty_days == null ? null : parseInt(b.warranty_days, 10),
      toBit(b.serial_required || 0),
      trimOrNull(b.stock_uom), trimOrNull(b.purchase_uom), nn(b.units_per_purchase), itemType,
    );
    return c.json({ ok: true, img });
  });

  app.delete('/api/admin/products/:img', managerMw, async (c) => {
    await d1(c.env).run('UPDATE products SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE img = ?', c.req.param('img'));
    return c.json({ ok: true });
  });

  // =====================================================================
  //  QUANTITY-BREAK (BULK) PRICING — replace the whole set for one product
  // =====================================================================
  app.put('/api/admin/products/:img/price-breaks', adminMw, async (c) => {
    const db = d1(c.env);
    if (!userCan(c.get('user'), 'inventory.edit_price'))
      return c.json({ error: 'Your account is not allowed to edit product pricing.' }, 403);
    const img = c.req.param('img');
    const exists = await db.one('SELECT img FROM products WHERE img = ?', img);
    if (!exists) return c.json({ error: 'Not found' }, 404);
    const b = await c.req.json().catch(() => ({}));
    const raw = Array.isArray(b.breaks) ? b.breaks : [];
    const seen = new Set();
    const rows = [];
    for (const r of raw) {
      const minQty = parseInt(r.min_qty, 10);
      if (!Number.isInteger(minQty) || minQty < 2) return c.json({ error: 'Each tier needs a quantity of 2 or more' }, 400);
      if (seen.has(minQty)) return c.json({ error: 'Duplicate quantity ' + minQty }, 400);
      const priceCents = usdToCents(r.price_usd);
      if (priceCents == null || priceCents < 0) return c.json({ error: 'Each tier needs a price' }, 400);
      seen.add(minQty);
      rows.push({ minQty, priceCents });
    }
    const stmts = [{ sql: 'DELETE FROM product_price_breaks WHERE product_img = ?', binds: [img] }];
    for (const r of rows) {
      stmts.push({ sql: 'INSERT INTO product_price_breaks (product_img, min_qty, price_cents) VALUES (?,?,?)', binds: [img, r.minQty, r.priceCents] });
    }
    await db.batch(stmts);
    return c.json({ ok: true, count: rows.length });
  });

  // =====================================================================
  //  SUPPLIERS / VENDORS
  // =====================================================================
  const SUPPLIER_COLS = `id, code, name, contact_name, phone, email, address, website,
    payment_terms, account_number, lead_time_days, notes, is_active, created_at`;

  app.get('/api/admin/suppliers', adminMw, async (c) => {
    const where = c.req.query('active') === 'true' ? 'WHERE is_active = 1' : '';
    const rows = await d1(c.env).many(
      `SELECT ${SUPPLIER_COLS} FROM suppliers ${where} ORDER BY is_active DESC, name ASC`);
    return c.json({ suppliers: rows.map((r) => boolify(r, ['is_active'])) });
  });

  app.post('/api/admin/suppliers', managerMw, async (c) => {
    const db = d1(c.env);
    const b = await c.req.json().catch(() => ({}));
    if (!b.name) return c.json({ error: 'name required' }, 400);
    try {
      const r = await db.run(
        `INSERT INTO suppliers (code, name, contact_name, phone, email, address, website, payment_terms, account_number, lead_time_days, notes, is_active)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        b.code || null, b.name, b.contact_name || null, b.phone || null, b.email || null,
        b.address || null, b.website || null, b.payment_terms || null, b.account_number || null,
        b.lead_time_days ? parseInt(b.lead_time_days, 10) : 7, b.notes || null, b.is_active === false ? 0 : 1,
      );
      return c.json({ ok: true, id: r.meta ? r.meta.last_row_id : undefined });
    } catch (e) {
      if (String(e.message || '').includes('UNIQUE'))
        return c.json({ error: 'Supplier code already in use' }, 400);
      throw e;
    }
  });

  app.patch('/api/admin/suppliers/:id', managerMw, async (c) => {
    const fields = ['code', 'name', 'contact_name', 'phone', 'email', 'address', 'website',
      'payment_terms', 'account_number', 'lead_time_days', 'notes', 'is_active'];
    const b = await c.req.json().catch(() => ({}));
    const sets = []; const vals = [];
    for (const f of fields) {
      if (b[f] === undefined) continue;
      if (f === 'is_active') { sets.push('is_active = ?'); vals.push(toBit(b[f])); }
      else if (f === 'lead_time_days') { sets.push('lead_time_days = ?'); vals.push(b[f] == null ? null : parseInt(b[f], 10)); }
      else { sets.push(`${f} = ?`); vals.push(b[f]); }
    }
    if (!sets.length) return c.json({ error: 'Nothing to update' }, 400);
    vals.push(c.req.param('id'));
    await d1(c.env).run(`UPDATE suppliers SET ${sets.join(', ')} WHERE id = ?`, ...vals);
    return c.json({ ok: true });
  });

  app.delete('/api/admin/suppliers/:id', managerMw, async (c) => {
    await d1(c.env).run('UPDATE suppliers SET is_active = 0 WHERE id = ?', c.req.param('id'));
    return c.json({ ok: true });
  });

  // =====================================================================
  //  EXTENDED PRODUCT EDIT / LIST (all part-department fields)
  // =====================================================================
  app.patch('/api/admin/products-ext/:img', adminMw, async (c) => {
    const b = await c.req.json().catch(() => ({}));
    // column -> (value transformer | null for pass-through)
    const MAP = {
      name: null, make_model: null, category: null, condition: null,
      stock_count: (v) => parseInt(v, 10), low_threshold: (v) => parseInt(v, 10),
      is_active: toBit, sku: null, barcode: null,
      supplier_id: (v) => (v ? parseInt(v, 10) : null),
      supplier_part_no: (v) => (String(v || '').trim() || null),
      warranty_days: (v) => (v === '' || v == null ? null : parseInt(v, 10)),
      serial_required: toBit, weight_kg: num, dim_cm: null,
      bin_location: null, min_stock: (v) => (v === '' || v == null ? null : parseInt(v, 10)),
      markup_pct: num,
      costing_method: (v) => (String(v || '').trim() || null),
      stock_uom: (v) => (String(v || '').trim() || null),
      purchase_uom: (v) => (String(v || '').trim() || null),
      units_per_purchase: num,
      price_usd: null, cost_usd: null, list_price_usd: null, core_charge_usd: null, env_fee_usd: null,
    };
    const CENTS = { price_usd: 'price_cents', cost_usd: 'cost_cents', list_price_usd: 'list_price_cents', core_charge_usd: 'core_charge_cents', env_fee_usd: 'env_fee_cents' };
    const sets = []; const vals = [];
    for (const [f, tf] of Object.entries(MAP)) {
      if (b[f] === undefined) continue;
      if (CENTS[f]) { sets.push(`${CENTS[f]} = ?`); vals.push(usdToCents(b[f])); }
      else { sets.push(`${f} = ?`); vals.push(tf ? tf(b[f]) : b[f]); }
    }
    if (!sets.length) return c.json({ error: 'Nothing to update' }, 400);
    sets.push('updated_at = CURRENT_TIMESTAMP');
    vals.push(c.req.param('img'));
    await d1(c.env).run(`UPDATE products SET ${sets.join(', ')} WHERE img = ?`, ...vals);
    return c.json({ ok: true });
  });

  app.get('/api/admin/products-ext', adminMw, async (c) => {
    const search = (c.req.query('q') || '').trim();
    const lowOnly = c.req.query('low') === 'true';
    const where = []; const vals = [];
    if (search) {
      const terms = search.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 4);
      for (const t of terms) {
        const like = '%' + t + '%';
        vals.push(like, like, like, like, like);
        where.push('(p.name LIKE ? OR p.sku LIKE ? OR p.barcode LIKE ? OR p.make_model LIKE ? OR p.category LIKE ?)');
      }
    }
    if (lowOnly) where.push("p.stock_count <= COALESCE(p.low_threshold, 4) AND p.item_type != 'service'");
    const rows = await d1(c.env).many(
      `SELECT p.img, p.name, p.make_model, p.category, p.condition,
              p.price_cents / 100.0 AS price_usd, p.cost_cents / 100.0 AS cost_usd,
              p.stock_count, p.low_threshold, p.min_stock, p.is_active,
              p.sku, p.barcode, p.core_charge_cents / 100.0 AS core_charge_usd,
              p.env_fee_cents / 100.0 AS env_fee_usd, p.warranty_days, p.serial_required,
              p.weight_kg, p.dim_cm, p.bin_location, p.markup_pct,
              p.list_price_cents / 100.0 AS list_price_usd, p.costing_method, p.supplier_part_no,
              p.stock_uom, p.purchase_uom, p.units_per_purchase,
              p.supplier_id, s.name AS supplier_name
         FROM products p LEFT JOIN suppliers s ON s.id = p.supplier_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY p.is_active DESC, p.name ASC LIMIT 300`,
      ...vals,
    );
    return c.json({ products: rows.map((r) => boolify(r, ['is_active', 'serial_required'])) });
  });

  // =====================================================================
  //  PURCHASE ORDERS
  // =====================================================================
  app.get('/api/admin/purchase-orders', adminMw, async (c) => {
    const status = c.req.query('status') || null;
    const base = `SELECT po.*, ${PO_USD_ALIASES}, s.name AS supplier_name
                    FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id`;
    const rows = status
      ? await d1(c.env).many(`${base} WHERE po.status = ? ORDER BY po.created_at DESC LIMIT 200`, status)
      : await d1(c.env).many(`${base} ORDER BY po.created_at DESC LIMIT 200`);
    return c.json({ purchase_orders: rows });
  });

  app.get('/api/admin/purchase-orders/:id', adminMw, async (c) => {
    const db = d1(c.env);
    const id = c.req.param('id');
    const po = await db.one(
      `SELECT po.*, ${PO_USD_ALIASES}, s.name AS supplier_name, s.phone AS supplier_phone, s.email AS supplier_email
         FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id WHERE po.id = ?`, id);
    if (!po) return c.json({ error: 'PO not found' }, 404);
    const items = await db.many(
      `SELECT poi.*, poi.unit_cost_cents / 100.0 AS unit_cost_usd, poi.total_cents / 100.0 AS total_usd,
              p.name AS product_name, p.stock_count AS current_stock
         FROM purchase_order_items poi LEFT JOIN products p ON p.img = poi.product_img
        WHERE poi.po_id = ? ORDER BY poi.id`, id);
    return c.json({ purchase_order: po, items });
  });

  app.post('/api/admin/purchase-orders', managerMw, async (c) => {
    const db = d1(c.env);
    const b = await c.req.json().catch(() => ({}));
    if (!b.supplier_id) return c.json({ error: 'supplier_id required' }, 400);
    const poNum = await nextPoNumber(db);
    const r = await db.run(
      `INSERT INTO purchase_orders (po_number, supplier_id, expected_date, notes, created_by)
         VALUES (?,?,?,?,?)`,
      poNum, b.supplier_id, b.expected_date || null, b.notes || null, c.get('user').id,
    );
    return c.json({ ok: true, id: r.meta ? r.meta.last_row_id : undefined, po_number: poNum });
  });

  app.patch('/api/admin/purchase-orders/:id', managerMw, async (c) => {
    const db = d1(c.env);
    const id = c.req.param('id');
    const b = await c.req.json().catch(() => ({}));
    const CENTS = { shipping_usd: 'shipping_cents', tax_usd: 'tax_cents' };
    const plain = ['status', 'expected_date', 'received_date', 'invoice_number', 'notes'];
    const sets = []; const vals = [];
    for (const f of plain) if (b[f] !== undefined) { sets.push(`${f} = ?`); vals.push(b[f]); }
    let totalsTouched = false;
    for (const [f, col] of Object.entries(CENTS)) {
      if (b[f] === undefined) continue;
      sets.push(`${col} = ?`); vals.push(usdToCents(b[f])); totalsTouched = true;
    }
    if (!sets.length) return c.json({ error: 'Nothing to update' }, 400);
    vals.push(id);
    await db.run(`UPDATE purchase_orders SET ${sets.join(', ')} WHERE id = ?`, ...vals);
    if (totalsTouched) await recalcPoTotals(db, id);
    return c.json({ ok: true });
  });

  app.post('/api/admin/purchase-orders/:id/items', managerMw, async (c) => {
    const db = d1(c.env);
    const id = c.req.param('id');
    const b = await c.req.json().catch(() => ({}));
    if (!b.description || !b.qty_ordered || b.unit_cost_usd == null)
      return c.json({ error: 'description, qty_ordered, unit_cost_usd required' }, 400);
    const qty = parseInt(b.qty_ordered, 10);
    const costCents = usdToCents(b.unit_cost_usd) || 0;
    await db.run(
      `INSERT INTO purchase_order_items (po_id, product_img, sku, description, qty_ordered, unit_cost_cents, total_cents, condition, notes)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      id, b.product_img || null, b.sku || null, b.description, qty, costCents, qty * costCents,
      b.condition || 'NEW', b.notes || null,
    );
    await recalcPoTotals(db, id);
    return c.json({ ok: true });
  });

  app.delete('/api/admin/purchase-orders/:poId/items/:id', managerMw, async (c) => {
    const db = d1(c.env);
    await db.run('DELETE FROM purchase_order_items WHERE id = ? AND po_id = ?', c.req.param('id'), c.req.param('poId'));
    await recalcPoTotals(db, c.req.param('poId'));
    return c.json({ ok: true });
  });

  // Receive a PO (full or partial). Body: { items: [{ id, qty_now, price_now, bin_now }] }
  app.post('/api/admin/purchase-orders/:id/receive', managerMw, async (c) => {
    const db = d1(c.env);
    const id = c.req.param('id');
    const reqItems = (await c.req.json().catch(() => ({}))).items || [];

    const stmts = [];
    for (const r of reqItems) {
      const want = parseInt(r.qty_now, 10);
      if (!want || want < 1) continue;
      const it = await db.one('SELECT * FROM purchase_order_items WHERE id = ?', r.id);
      if (!it) continue;
      const max = it.qty_ordered - it.qty_received;
      const got = Math.min(want, max);
      if (got <= 0) continue;
      if (it.product_img) {
        stmts.push({
          sql: 'UPDATE products SET stock_count = stock_count + ?, cost_cents = ?, updated_at = CURRENT_TIMESTAMP WHERE img = ?',
          binds: [got, it.unit_cost_cents, it.product_img],
        });
        const pn = num(r.price_now);
        if (pn != null) stmts.push({ sql: 'UPDATE products SET price_cents = ? WHERE img = ?', binds: [usdToCents(pn), it.product_img] });
        if (r.bin_now != null && String(r.bin_now).trim())
          stmts.push({ sql: 'UPDATE products SET bin_location = ? WHERE img = ?', binds: [String(r.bin_now).trim(), it.product_img] });
      }
      stmts.push({ sql: 'UPDATE purchase_order_items SET qty_received = qty_received + ? WHERE id = ?', binds: [got, it.id] });
    }
    if (stmts.length) await db.batch(stmts);

    const rem = await db.one('SELECT SUM(qty_ordered - qty_received) AS r FROM purchase_order_items WHERE po_id = ?', id);
    const newStatus = ((rem && rem.r) || 0) > 0 ? 'partial' : 'received';
    await db.run(
      'UPDATE purchase_orders SET status = ?, received_date = COALESCE(received_date, CURRENT_TIMESTAMP) WHERE id = ?',
      newStatus, id);
    return c.json({ ok: true, status: newStatus });
  });

  // Stock straight into inventory without a PO. Each item matches a product by
  // img (exact) or sku. Lands in warehouse_activity so the movement is auditable.
  app.post('/api/admin/receive', managerMw, async (c) => {
    const db = d1(c.env);
    if (!userCan(c.get('user'), 'inventory.adjust_stock'))
      return c.json({ error: 'Your account is not allowed to adjust stock counts.' }, 403);
    const b = await c.req.json().catch(() => ({}));
    const rows = Array.isArray(b.items) ? b.items : [];
    if (!rows.length) return c.json({ error: 'items[] required' }, 400);
    const supplierId = b.supplier_id ? parseInt(b.supplier_id, 10) : null;
    const invoice = String(b.invoice || b.reference || '').trim();
    const note = String(b.notes || '').trim();
    let supplierName = null;
    if (supplierId) {
      const sr = await db.one('SELECT name FROM suppliers WHERE id = ?', supplierId);
      supplierName = sr ? sr.name : null;
    }
    const activityNote = [
      supplierName ? 'supplier: ' + supplierName : '',
      invoice ? 'invoice ' + invoice : '',
      note,
    ].filter(Boolean).join(' · ') || 'Received without a PO';

    const stmts = [];
    const results = [];
    for (const r of rows) {
      const qty = parseInt(r.qty, 10);
      if (!qty || qty < 1) { results.push({ ok: false, error: 'qty must be a positive whole number', item: r }); continue; }
      const key = String(r.product_img || r.sku || '').trim();
      if (!key) { results.push({ ok: false, error: 'product_img or sku required', item: r }); continue; }
      const p = await db.one(
        'SELECT img, name, stock_count FROM products WHERE img = ? OR (sku IS NOT NULL AND sku = ?) LIMIT 1', key, key);
      if (!p) { results.push({ ok: false, error: 'no product matches "' + key + '"', item: r }); continue; }
      stmts.push({ sql: 'UPDATE products SET stock_count = stock_count + ?, updated_at = CURRENT_TIMESTAMP WHERE img = ?', binds: [qty, p.img] });
      const cost = num(r.unit_cost_usd);
      const price = num(r.price_usd);
      if (cost != null) stmts.push({ sql: 'UPDATE products SET cost_cents = ? WHERE img = ?', binds: [usdToCents(cost), p.img] });
      if (price != null) stmts.push({ sql: 'UPDATE products SET price_cents = ? WHERE img = ?', binds: [usdToCents(price), p.img] });
      if (r.name != null && String(r.name).trim()) stmts.push({ sql: 'UPDATE products SET name = ? WHERE img = ?', binds: [String(r.name).trim(), p.img] });
      if (r.location != null) stmts.push({ sql: 'UPDATE products SET location = ? WHERE img = ?', binds: [String(r.location), p.img] });
      if (r.bin_location != null) stmts.push({ sql: 'UPDATE products SET bin_location = ? WHERE img = ?', binds: [String(r.bin_location), p.img] });
      if (supplierId) stmts.push({ sql: 'UPDATE products SET supplier_id = COALESCE(supplier_id, ?) WHERE img = ?', binds: [supplierId, p.img] });
      stmts.push({
        sql: `INSERT INTO warehouse_activity (kind, product_img, qty_before, qty_after, qty_delta, bin_location, performed_by, ref_kind, ref_id, notes)
                VALUES (?,?,?,?,?,?,?,?,?,?)`,
        binds: ['receive', p.img, p.stock_count, p.stock_count + qty, qty,
          r.bin_location != null ? String(r.bin_location) : null, null, 'no_po', supplierId, activityNote],
      });
      results.push({ ok: true, product_img: p.img, name: p.name, qty });
    }
    if (stmts.length) await db.batch(stmts);
    return c.json({ ok: results.every((x) => x.ok), received: results.filter((x) => x.ok).length, results });
  });

  // =====================================================================
  //  CSV IMPORT
  // =====================================================================
  app.get('/api/admin/inventory/import/columns', adminMw, (c) => c.json({ fields: FIELD_SYNONYMS }));

  app.get('/api/admin/inventory/import/template.csv', adminMw, (c) =>
    c.body(TEMPLATE_CSV, 200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="mortysautoparts-inventory-template.csv"',
    }));

  async function handleImport(c, fileFields) {
    const db = d1(c.env);
    const cl = parseInt(c.req.header('content-length') || '0', 10);
    if (cl && cl > IMPORT_MAX_BYTES)
      return c.json({ error: `File too large — the limit is ${IMPORT_MAX_BYTES / 1024 / 1024} MB.` }, 413);

    let body;
    try { body = await c.req.parseBody(); }
    catch { return c.json({ error: 'Could not read the upload (expected multipart/form-data).' }, 400); }

    let file = null;
    for (const f of fileFields) if (body[f] && typeof body[f] !== 'string') { file = body[f]; break; }
    if (!file) return c.json({ error: 'Choose a .csv or .tsv file to import.' }, 400);
    if (file.size > IMPORT_MAX_BYTES)
      return c.json({ error: `File too large — the limit is ${IMPORT_MAX_BYTES / 1024 / 1024} MB.` }, 413);

    const mode = String(c.req.query('mode') || body.mode || 'preview').toLowerCase();
    const deactivateMissing = String(c.req.query('deactivate_missing') || body.deactivate_missing || '') === 'true';
    const sourceName = file.name || 'upload.csv';

    let parsed;
    try {
      parsed = parseInventoryFile(new Uint8Array(await file.arrayBuffer()), sourceName);
    } catch (e) {
      if (e.userFacing) return c.json({ error: e.message }, 400);
      return c.json({ error: 'Could not read that file: ' + e.message }, 400);
    }

    const { items, issues, mapped, ignoredColumns, headerLine, format, detail, totalDataRows } = parsed;
    if (!items.length)
      return c.json({
        error: 'No usable rows found. The header row was line ' + headerLine +
               ' and none of the rows under it had a part number.',
        mapped, ignoredColumns, issues: issues.slice(0, 50),
      }, 400);
    if (mapped.sku == null && mapped.img == null)
      return c.json({
        error: 'No part-number column found. One column must hold the part number ' +
               '(named Item, Part No, SKU or similar) so rows can be matched to existing stock.',
        mapped, ignoredColumns,
      }, 400);

    const keys = items.map((it) => it.img);
    const uniqueKeys = [...new Set(keys)];

    // Which already exist? (chunked — SQLite caps bound params)
    const existing = new Set();
    for (const grp of chunk(uniqueKeys, 100)) {
      const rows = await db.many(
        `SELECT img FROM products WHERE img IN (${grp.map(() => '?').join(',')})`, ...grp);
      for (const r of rows) existing.add(r.img);
    }
    const willUpdate = uniqueKeys.filter((k) => existing.has(k)).length;
    const willInsert = uniqueKeys.length - willUpdate;

    // Active products not in the file (for deactivate_missing)
    let activeImgs = null;
    let deactivateCount = 0;
    if (deactivateMissing) {
      activeImgs = (await db.many('SELECT img FROM products WHERE is_active = 1')).map((r) => r.img);
      const keySet = new Set(keys);
      deactivateCount = activeImgs.filter((img) => !keySet.has(img)).length;
    }

    const summary = {
      file: sourceName, format, detail,
      header_line: headerLine,
      mapped_columns: mapped,
      ignored_columns: ignoredColumns,
      rows_in_file: totalDataRows,
      rows_usable: items.length,
      unique_parts: uniqueKeys.length,
      will_add: willInsert,
      will_update: willUpdate,
      will_deactivate: deactivateCount,
      issues: issues.slice(0, 200),
      issue_count: issues.length,
      sample: items.slice(0, 15),
    };

    if (mode !== 'commit')
      return c.json(Object.assign({ ok: true, mode: 'preview', committed: false }, summary));

    // ---- commit ----
    const present = IMPORT_COLUMNS.filter((col) => {
      const field = COL_SOURCE_FIELD[col] || col;
      return mapped[field] != null;
    });
    if (!present.includes('sku')) present.push('sku');

    const setClause = present.map((col) => {
      const rule = IMPORT_COLUMN_RULES[col];
      if (rule === 'fill') return `${col} = COALESCE(excluded.${col}, products.${col})`;
      if (rule === 'name') return `${col} = COALESCE(NULLIF(excluded.${col}, ''), products.${col})`;
      return `${col} = excluded.${col}`;
    }).concat(['is_active = 1', 'updated_at = CURRENT_TIMESTAMP']).join(', ');

    const cols = ['img'].concat(IMPORT_COLUMNS);
    const placeholders = '(' + cols.map(() => '?').join(',') + ')';
    const upsertSql =
      `INSERT INTO products (${cols.join(', ')}) VALUES ${placeholders} ` +
      `ON CONFLICT(img) DO UPDATE SET ${setClause}`;

    const rowBinds = (it) => [
      it.img, it.sku, it.name, it.make_model, it.category || 'Other', it.condition,
      usdToCents(it.price_usd), usdToCents(it.cost_usd), it.stock_count, it.low_threshold,
      it.bin_location, it.location, it.barcode,
    ];

    for (const grp of chunk(items, 50))
      await db.batch(grp.map((it) => ({ sql: upsertSql, binds: rowBinds(it) })));

    let deactivated = 0;
    if (deactivateMissing && activeImgs) {
      const keySet = new Set(keys);
      const gone = activeImgs.filter((img) => !keySet.has(img));
      deactivated = gone.length;
      for (const grp of chunk(gone, 50))
        await db.batch(grp.map((img) => ({
          sql: 'UPDATE products SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE img = ?',
          binds: [img],
        })));
    }

    return c.json(Object.assign(
      { ok: true, mode: 'commit', committed: true, inserted: willInsert, updated: willUpdate, deactivated },
      summary));
  }

  app.post('/api/admin/inventory/import', managerMw, (c) => handleImport(c, ['file', 'csv']));
  app.post('/api/admin/import/parts', managerMw, (c) => handleImport(c, ['csv', 'file']));
}
