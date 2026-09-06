// Matrix items — one product_matrices parent (shared price/cost/warranty/
// etc.) fanning out into N child products.img rows across one or two
// attribute axes (e.g. Position: Front/Rear). See migrations/0041 and
// _lib/product_matrix.js (the shared field vocabulary) for the design notes.
//
//   POST   /api/admin/product-matrix                create a matrix + its children
//   GET    /api/admin/product-matrix/:id             parent + children + override summary
//   PATCH  /api/admin/product-matrix/:id             edit shared fields, push to children
//   POST   /api/admin/product-matrix/:id/children    add one more variant later
//   POST   /api/admin/product-matrix/:id/reset/:img  un-diverge one child
//   DELETE /api/admin/product-matrix/:id/children/:img   remove one variant
//   DELETE /api/admin/product-matrix/:id             remove the whole matrix
import { d1 } from '../_lib/db.js';
import { adminMw, managerMw, userCan } from '../_lib/guards.js';
import { boolify, safeJson } from '../_lib/util.js';
import { centsToUsd } from '../_lib/money.js';
import { readUploadBody, putUpload, copyUpload } from '../_lib/uploads.js';
import { PUSHABLE_FIELDS, toColumnValue, slugify, childName, childSkuBase } from '../_lib/product_matrix.js';

const MAX_AXIS_VALUES = 20;
const MAX_CHILDREN = 40;

function parseAxisValues(raw) {
  if (!raw) return [];
  const seen = new Set();
  const out = [];
  for (const v of String(raw).split(/[,\n]/)) {
    const t = v.trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out;
}

// Shared-field values as they should land on a *child* products row, given
// either the create-time request body or the current product_matrices row.
function sharedValuesFrom(source, priceGateOk) {
  const out = {};
  for (const f of PUSHABLE_FIELDS) {
    if (f.kind === 'usd' && !priceGateOk && (f.key === 'price_usd' || f.key === 'cost_usd' || f.key === 'list_price_usd')) continue;
    const raw = source[f.key];
    if (raw === undefined) continue;
    out[f.col] = toColumnValue(f.kind, f.col, raw);
  }
  return out;
}

const PRICE_KEYS = new Set(['price_usd', 'cost_usd', 'list_price_usd']);

function uniqueSku(base, taken) {
  let sku = base, n = 2;
  while (taken.has(sku)) { sku = base + '-' + n; n++; }
  taken.add(sku);
  return sku;
}

function matrixUsdRow(m) {
  return {
    ...m,
    price_usd: centsToUsd(m.price_cents), cost_usd: centsToUsd(m.cost_cents),
    list_price_usd: centsToUsd(m.list_price_cents),
    core_charge_usd: centsToUsd(m.core_charge_cents), env_fee_usd: centsToUsd(m.env_fee_cents),
  };
}

export default function mount(app) {
  // =====================================================================
  //  CREATE — one photo + shared fields + axis values -> N child products
  // =====================================================================
  app.post('/api/admin/product-matrix', adminMw, async (c) => {
    const db = d1(c.env);
    const me = c.get('user');
    let file, body, upload;
    try { ({ file, body } = await readUploadBody(c, ['photo'])); }
    catch (e) { if (e.userFacing) return c.json({ error: e.message }, e.status || 400); throw e; }
    const b = body || {};
    if (!b.name || !b.category) return c.json({ error: 'name and category are required' }, 400);
    if (!b.axis1_label || !b.axis1_values) return c.json({ error: 'axis1_label and axis1_values are required' }, 400);

    const axis1 = parseAxisValues(b.axis1_values);
    if (axis1.length < 2) return c.json({ error: 'Axis 1 needs at least 2 distinct values — a single value isn\'t a matrix' }, 400);
    if (axis1.length > MAX_AXIS_VALUES) return c.json({ error: `Axis 1 has too many values (max ${MAX_AXIS_VALUES})` }, 400);
    const axis2 = b.axis2_label ? parseAxisValues(b.axis2_values) : [];
    if (b.axis2_label && axis2.length < 2) return c.json({ error: 'Axis 2 needs at least 2 distinct values, or leave its label blank' }, 400);
    if (axis2.length > MAX_AXIS_VALUES) return c.json({ error: `Axis 2 has too many values (max ${MAX_AXIS_VALUES})` }, 400);
    const totalChildren = axis1.length * (axis2.length || 1);
    if (totalChildren > MAX_CHILDREN) return c.json({ error: `That would create ${totalChildren} parts — the limit is ${MAX_CHILDREN}. Split it into more than one matrix.` }, 400);

    const priceGateOk = userCan(me, 'inventory.edit_price');
    if (!priceGateOk && (b.price_usd != null || b.cost_usd != null || b.list_price_usd != null))
      return c.json({ error: 'Your account is not allowed to set product pricing.' }, 403);

    // ----- resolve the one photo every child will get its own copy of -----
    let photoKey, firstImg;
    if (file) {
      if (file.size > 12 * 1024 * 1024) return c.json({ error: 'Image too large — the limit is 12 MB.' }, 413);
        try {
          upload = await putUpload(c.env, { prefix: 'products', bytes: new Uint8Array(await file.arrayBuffer()), contentType: file.type, filename: file.name });
        } catch (e) { if (e.userFacing) return c.json({ error: e.message }, e.status || 400); throw e; }
      photoKey = upload.key; firstImg = upload.url;
    } else if (b.source_img) {
      if (!String(b.source_img).startsWith('/uploads/'))
        return c.json({ error: 'That part\'s photo isn\'t a duplicable upload — take or pick a new photo for this matrix instead.' }, 400);
      photoKey = String(b.source_img).slice('/uploads/'.length);
      try { const first = await copyUpload(c.env, photoKey, { prefix: 'products' }); firstImg = first.url; }
      catch (e) { if (e.userFacing) return c.json({ error: e.message }, e.status || 400); throw e; }
    } else {
      return c.json({ error: 'A photo (or an existing part to copy the photo from) is required' }, 400);
    }

    const condition = ['NEW', 'USED'].includes(String(b.condition || '').toUpperCase()) ? b.condition.toUpperCase() : 'NEW';
    const shared = sharedValuesFrom(b, priceGateOk);
    const trimOrNull = (v) => (v && String(v).trim() ? String(v).trim() : null);

    const matrixIns = await db.run(
      `INSERT INTO product_matrices
         (name, make_model, category, condition, price_cents, cost_cents, list_price_cents, markup_pct,
          supplier_id, supplier_part_no, costing_method, stock_uom, purchase_uom, units_per_purchase,
          warranty_days, serial_required, core_charge_cents, env_fee_cents, axis1_label, axis2_label, photo_key)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      b.name, trimOrNull(b.make_model), b.category, condition,
      shared.price_cents ?? null, shared.cost_cents ?? null, shared.list_price_cents ?? null, shared.markup_pct ?? null,
      shared.supplier_id ?? null, shared.supplier_part_no ?? null, shared.costing_method ?? null,
      shared.stock_uom ?? null, shared.purchase_uom ?? null, shared.units_per_purchase ?? null,
      shared.warranty_days ?? null, shared.serial_required ?? 0, shared.core_charge_cents ?? 0, shared.env_fee_cents ?? 0,
      b.axis1_label, trimOrNull(b.axis2_label), photoKey,
    );
    const matrixId = matrixIns.meta.last_row_id;

    const baseSku = b.base_sku ? String(b.base_sku).trim() : b.name;
    const existingSkus = new Set((await db.many('SELECT sku FROM products WHERE sku LIKE ?', slugify(baseSku) + '%')).map((r) => r.sku));

    const stockCount = b.stock_count != null && b.stock_count !== '' ? Math.max(0, parseInt(b.stock_count, 10) || 0) : 1;
    const lowThreshold = b.low_threshold != null && b.low_threshold !== '' ? Math.max(0, parseInt(b.low_threshold, 10) || 0) : 0;
    const location = trimOrNull(b.location);

    const combos = [];
    for (const a1 of axis1) { if (axis2.length) for (const a2 of axis2) combos.push([a1, a2]); else combos.push([a1, null]); }

    const stmts = [];
    const children = [];
    for (let i = 0; i < combos.length; i++) {
      const [a1, a2] = combos[i];
      let img;
      if (i === 0) { img = firstImg; }
      else {
        const copy = await copyUpload(c.env, photoKey, { prefix: 'products' });
        img = copy.url;
      }
      const name = childName(b.name, a1, a2);
      const sku = uniqueSku(childSkuBase(baseSku, a1, a2), existingSkus);
      stmts.push({
        sql: `INSERT INTO products
          (img, name, make_model, category, condition, price_cents, cost_cents, list_price_cents,
           stock_count, low_threshold, location, sku, supplier_id, supplier_part_no, markup_pct, costing_method,
           warranty_days, serial_required, core_charge_cents, env_fee_cents, stock_uom, purchase_uom, units_per_purchase,
           matrix_id, matrix_axis1_value, matrix_axis2_value, matrix_overrides)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        binds: [
          img, name, b.make_model || '', b.category, condition,
          shared.price_cents ?? null, shared.cost_cents ?? null, shared.list_price_cents ?? null,
          stockCount, lowThreshold, location, sku,
          shared.supplier_id ?? null, shared.supplier_part_no ?? null, shared.markup_pct ?? null, shared.costing_method ?? null,
          shared.warranty_days ?? null, shared.serial_required ?? 0, shared.core_charge_cents ?? 0, shared.env_fee_cents ?? 0,
          shared.stock_uom ?? null, shared.purchase_uom ?? null, shared.units_per_purchase ?? null,
          matrixId, a1, a2, '[]',
        ],
      });
      children.push({ img, name, sku, matrix_axis1_value: a1, matrix_axis2_value: a2 });
    }
    await db.batch(stmts);
    return c.json({ ok: true, matrix_id: matrixId, children });
  });

  // =====================================================================
  //  GET — parent + children + which shared fields have diverged where
  // =====================================================================
  app.get('/api/admin/product-matrix/:id', adminMw, async (c) => {
    const db = d1(c.env);
    const id = c.req.param('id');
    const m = await db.one('SELECT * FROM product_matrices WHERE id = ?', id);
    if (!m) return c.json({ error: 'Matrix not found' }, 404);
    const children = await db.many(
      `SELECT img, name, sku, barcode, stock_count, low_threshold, is_active,
              matrix_axis1_value, matrix_axis2_value, matrix_overrides,
              price_cents / 100.0 AS price_usd
         FROM products WHERE matrix_id = ?
        ORDER BY matrix_axis1_value, matrix_axis2_value`, id
    );
    boolify(m, ['serial_required']);
    for (const ch of children) boolify(ch, ['is_active']);
    const counts = {};
    for (const ch of children) {
      const ov = safeJson(ch.matrix_overrides, []);
      ch.matrix_overrides = ov;
      for (const f of ov) counts[f] = (counts[f] || 0) + 1;
    }
    const overrides_summary = PUSHABLE_FIELDS.map((f) => ({ field: f.key, overridden_count: counts[f.key] || 0 }))
      .filter((r) => r.overridden_count > 0);
    return c.json({ matrix: matrixUsdRow(m), children, overrides_summary });
  });

  // =====================================================================
  //  PATCH — edit shared fields, push to non-overridden children
  // =====================================================================
  app.patch('/api/admin/product-matrix/:id', adminMw, async (c) => {
    const db = d1(c.env);
    const me = c.get('user');
    const id = c.req.param('id');
    const m = await db.one('SELECT * FROM product_matrices WHERE id = ?', id);
    if (!m) return c.json({ error: 'Matrix not found' }, 404);
    const b = await c.req.json().catch(() => ({}));
    const touched = PUSHABLE_FIELDS.filter((f) => b[f.key] !== undefined);
    if (!touched.length) return c.json({ error: 'Nothing to update' }, 400);
    if (touched.some((f) => PRICE_KEYS.has(f.key)) && !userCan(me, 'inventory.edit_price'))
      return c.json({ error: 'Your account is not allowed to edit product pricing.' }, 403);

    const sets = [], vals = [];
    for (const f of touched) { sets.push(`${f.col} = ?`); vals.push(toColumnValue(f.kind, f.col, b[f.key])); }
    sets.push('updated_at = CURRENT_TIMESTAMP');
    await db.run(`UPDATE product_matrices SET ${sets.join(', ')} WHERE id = ?`, ...vals, id);

    let updatedChildren = 0;
    if (b.push !== false) {
      const children = await db.many('SELECT img, matrix_overrides FROM products WHERE matrix_id = ?', id);
      const stmts = [];
      for (const ch of children) {
        const ov = new Set(safeJson(ch.matrix_overrides, []));
        const applicable = touched.filter((f) => !ov.has(f.key));
        if (!applicable.length) continue;
        const csets = applicable.map((f) => `${f.col} = ?`);
        const cvals = applicable.map((f) => toColumnValue(f.kind, f.col, b[f.key]));
        csets.push('updated_at = CURRENT_TIMESTAMP');
        stmts.push({ sql: `UPDATE products SET ${csets.join(', ')} WHERE img = ?`, binds: [...cvals, ch.img] });
        updatedChildren++;
      }
      if (stmts.length) await db.batch(stmts);
    }
    return c.json({ ok: true, updated_children: updatedChildren });
  });

  // =====================================================================
  //  ADD A VARIANT — one more axis-value combination, later
  // =====================================================================
  app.post('/api/admin/product-matrix/:id/children', adminMw, async (c) => {
    const db = d1(c.env);
    const id = c.req.param('id');
    const m = await db.one('SELECT * FROM product_matrices WHERE id = ?', id);
    if (!m) return c.json({ error: 'Matrix not found' }, 404);
    const b = await c.req.json().catch(() => ({}));
    const a1 = String(b.axis1_value || '').trim();
    if (!a1) return c.json({ error: `${m.axis1_label} value is required` }, 400);
    const a2 = m.axis2_label ? String(b.axis2_value || '').trim() : null;
    if (m.axis2_label && !a2) return c.json({ error: `${m.axis2_label} value is required` }, 400);
    if (!m.axis2_label && b.axis2_value) return c.json({ error: 'This matrix has only one axis' }, 400);

    const dupe = await db.one(
      `SELECT img FROM products WHERE matrix_id = ? AND matrix_axis1_value = ? AND ${m.axis2_label ? 'matrix_axis2_value = ?' : 'matrix_axis2_value IS NULL'}`,
      ...(m.axis2_label ? [id, a1, a2] : [id, a1])
    );
    if (dupe) return c.json({ error: 'That variant already exists (reactivate it in the part editor if it was removed)' }, 409);

    if (!m.photo_key) return c.json({ error: 'This matrix has no photo on file to copy' }, 400);
    let img;
    try { img = (await copyUpload(c.env, m.photo_key, { prefix: 'products' })).url; }
    catch (e) { if (e.userFacing) return c.json({ error: e.message }, e.status || 400); throw e; }

    const existingSkus = new Set((await db.many('SELECT sku FROM products WHERE sku LIKE ?', slugify(m.name) + '%')).map((r) => r.sku));
    const name = childName(m.name, a1, a2);
    const sku = uniqueSku(childSkuBase(m.name, a1, a2), existingSkus);

    await db.run(
      `INSERT INTO products
         (img, name, make_model, category, condition, price_cents, cost_cents, list_price_cents,
          stock_count, low_threshold, sku, supplier_id, supplier_part_no, markup_pct, costing_method,
          warranty_days, serial_required, core_charge_cents, env_fee_cents, stock_uom, purchase_uom, units_per_purchase,
          matrix_id, matrix_axis1_value, matrix_axis2_value, matrix_overrides)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      img, name, m.make_model || '', m.category, m.condition, m.price_cents, m.cost_cents, m.list_price_cents,
      1, 0, sku, m.supplier_id, m.supplier_part_no, m.markup_pct, m.costing_method,
      m.warranty_days, m.serial_required, m.core_charge_cents, m.env_fee_cents, m.stock_uom, m.purchase_uom, m.units_per_purchase,
      id, a1, a2, '[]',
    );
    return c.json({ ok: true, img, name, sku });
  });

  // =====================================================================
  //  RESET — un-diverge one child back to the matrix's current shared values
  // =====================================================================
  app.post('/api/admin/product-matrix/:id/reset/:img', adminMw, async (c) => {
    const db = d1(c.env);
    const id = c.req.param('id');
    const img = c.req.param('img');
    const m = await db.one('SELECT * FROM product_matrices WHERE id = ?', id);
    if (!m) return c.json({ error: 'Matrix not found' }, 404);
    const child = await db.one('SELECT img FROM products WHERE img = ? AND matrix_id = ?', img, id);
    if (!child) return c.json({ error: 'That part is not a child of this matrix' }, 404);
    await db.run(
      `UPDATE products SET
         category = ?, condition = ?, make_model = ?, price_cents = ?, cost_cents = ?, list_price_cents = ?,
         markup_pct = ?, warranty_days = ?, serial_required = ?, core_charge_cents = ?, env_fee_cents = ?,
         supplier_id = ?, supplier_part_no = ?, costing_method = ?, stock_uom = ?, purchase_uom = ?, units_per_purchase = ?,
         matrix_overrides = '[]', updated_at = CURRENT_TIMESTAMP
       WHERE img = ?`,
      m.category, m.condition, m.make_model || '', m.price_cents, m.cost_cents, m.list_price_cents,
      m.markup_pct, m.warranty_days, m.serial_required, m.core_charge_cents, m.env_fee_cents,
      m.supplier_id, m.supplier_part_no, m.costing_method, m.stock_uom, m.purchase_uom, m.units_per_purchase,
      img,
    );
    return c.json({ ok: true });
  });

  // =====================================================================
  //  REMOVE — one variant, or the whole matrix (both soft-delete)
  // =====================================================================
  app.delete('/api/admin/product-matrix/:id/children/:img', managerMw, async (c) => {
    await d1(c.env).run(
      'UPDATE products SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE img = ? AND matrix_id = ?',
      c.req.param('img'), c.req.param('id')
    );
    return c.json({ ok: true });
  });

  app.delete('/api/admin/product-matrix/:id', managerMw, async (c) => {
    const db = d1(c.env);
    const id = c.req.param('id');
    const r = await db.run('UPDATE products SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE matrix_id = ?', id);
    return c.json({ ok: true, deactivated: r.meta.changes });
  });
}
