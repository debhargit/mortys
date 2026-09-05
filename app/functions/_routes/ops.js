// Phase 14 — ops. Ports server.js:
//   GET/POST /api/admin/parts-requisitions[/:id]  + /:id/fulfill
//   GET/POST/PATCH/DELETE /api/admin/requisitions[/:id]  + /:id/items
//     + DELETE /:reqId/items/:id  + POST /:id/convert
//   GET/POST /api/admin/stock-counts[/:id]  + /:id/post
//   PATCH /api/admin/stock-count-items/:id
//   POST /api/admin/stock-adjust
//   GET/POST/PATCH /api/admin/deliveries[/:id]
//   GET/POST /api/admin/cash-drawer/open  + POST /api/admin/cash-drawer/:id/close
//   GET /api/admin/cash-report   GET /api/admin/warehouse-activity
//   GET /api/admin/bin/:bin
import { d1 } from '../_lib/db.js';
import { adminMw, managerMw } from '../_lib/guards.js';

const c2u = (c) => (c == null ? 0 : c / 100);
const u2c = (u) => (u == null || u === '' ? null : Math.round(Number(u) * 100));
const r2 = (n) => Math.round(n * 100) / 100;
const yr = () => new Date().getFullYear();

async function seqCount(db, table, col, prefix, pad) {
  const r = await db.one(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} LIKE ?`, prefix + '%');
  return prefix + String((r.n || 0) + 1).padStart(pad, '0');
}
async function seqMax(db, table, col, prefix, pad) {
  const rows = await db.many(`SELECT ${col} AS v FROM ${table} WHERE ${col} LIKE ?`, prefix + '%');
  let mx = 0; for (const r of rows) { const m = String(r.v || '').match(/(\d+)\s*$/); if (m) mx = Math.max(mx, +m[1]); }
  return prefix + String(mx + 1).padStart(pad, '0');
}
const nextPartsReqNumber = (db) => seqCount(db, 'parts_requisitions', 'pr_number', `PR-${yr()}-`, 4);
const nextStockCountNumber = (db) => seqCount(db, 'stock_counts', 'count_number', `SC-${yr()}-`, 4);
const nextDeliveryNumber = (db) => seqCount(db, 'deliveries', 'delivery_number', `DEL-${yr()}-`, 4);
const nextReqNumber = (db) => seqMax(db, 'service_requisitions', 'req_number', `REQ-${yr()}-`, 4);
const nextWoNumber = (db) => seqMax(db, 'work_orders', 'wo_number', `WO-${yr()}-`, 4);

async function recalcReqTotal(db, reqId) {
  const r = await db.one('SELECT COALESCE(SUM(total_cents),0) AS s FROM service_requisition_items WHERE requisition_id = ?', reqId);
  await db.run('UPDATE service_requisitions SET estimate_total_cents = ? WHERE id = ?', r.s || 0, reqId);
  return c2u(r.s || 0);
}
async function rollupWo(db, woId) {
  const l = await db.one('SELECT COALESCE(SUM(total_cents),0) AS s FROM work_order_labor WHERE work_order_id = ?', woId);
  const p = await db.one('SELECT COALESCE(SUM(total_cents),0) AS s FROM work_order_parts WHERE work_order_id = ?', woId);
  await db.run('UPDATE work_orders SET labor_total_cents = ?, parts_total_cents = ?, total_cents = ? WHERE id = ?',
    l.s || 0, p.s || 0, (l.s || 0) + (p.s || 0), woId);
}
function logActivity(kind, o) {
  return {
    sql: `INSERT INTO warehouse_activity (kind, product_img, qty_before, qty_after, qty_delta, bin_location, performed_by, ref_kind, ref_id, notes)
            VALUES (?,?,?,?,?,?,?,?,?,?)`,
    binds: [kind, o.product_img || null, o.qty_before ?? null, o.qty_after ?? null, o.qty_delta ?? null,
      o.bin_location || null, null, o.ref_kind || null, o.ref_id || null, o.notes || null],
  };
}

export default function mount(app) {
  // ============ PARTS REQUISITIONS ============
  app.get('/api/admin/parts-requisitions', adminMw, async (c) => {
    const status = c.req.query('status') || null;
    const base = `SELECT pr.*, w.wo_number, w.customer_name, w.vehicle_make, w.vehicle_model,
        rb.name AS requester_name, fb.name AS fulfiller_name,
        (SELECT COUNT(*) FROM parts_requisition_items pi WHERE pi.requisition_id = pr.id) AS item_count
      FROM parts_requisitions pr
      LEFT JOIN work_orders w ON w.id = pr.work_order_id
      LEFT JOIN mechanics rb ON rb.id = pr.requested_by
      LEFT JOIN mechanics fb ON fb.id = pr.fulfilled_by`;
    const requisitions = status
      ? await d1(c.env).many(`${base} WHERE pr.status = ? ORDER BY pr.created_at DESC LIMIT 200`, status)
      : await d1(c.env).many(`${base} ORDER BY pr.created_at DESC LIMIT 200`);
    return c.json({ requisitions });
  });

  app.get('/api/admin/parts-requisitions/:id', adminMw, async (c) => {
    const db = d1(c.env);
    const id = c.req.param('id');
    const requisition = await db.one(
      'SELECT pr.*, w.wo_number, w.customer_name FROM parts_requisitions pr LEFT JOIN work_orders w ON w.id = pr.work_order_id WHERE pr.id = ?', id);
    if (!requisition) return c.json({ error: 'Requisition not found' }, 404);
    const items = await db.many(
      `SELECT pi.*, pi.unit_price_cents / 100.0 AS unit_price_usd, p.name AS product_name, p.stock_count AS in_stock
         FROM parts_requisition_items pi LEFT JOIN products p ON p.img = pi.product_img
        WHERE pi.requisition_id = ? ORDER BY pi.id`, id);
    return c.json({ requisition, items });
  });

  app.post('/api/admin/parts-requisitions', adminMw, async (c) => {
    const db = d1(c.env);
    const b = await c.req.json().catch(() => ({}));
    const workOrderId = b.work_order_id ? parseInt(b.work_order_id, 10) : null;
    const items = (Array.isArray(b.items) ? b.items : []).filter((it) => it.description && it.qty_requested);
    if (!items.length) return c.json({ error: 'At least one item required' }, 400);
    if (workOrderId && !(await db.one('SELECT id FROM work_orders WHERE id = ?', workOrderId)))
      return c.json({ error: 'No work order #' + workOrderId }, 400);
    const prNum = await nextPartsReqNumber(db);
    const r = await db.run('INSERT INTO parts_requisitions (pr_number, work_order_id, requested_by, notes) VALUES (?,?,?,?)',
      prNum, workOrderId, b.requested_by || null, b.notes || null);
    const prId = r.meta.last_row_id;
    for (const it of items) {
      await db.run(
        `INSERT INTO parts_requisition_items (requisition_id, product_img, description, qty_requested, unit_price_cents)
           VALUES (?,?,?,?,?)`,
        prId, it.product_img || null, it.description, parseInt(it.qty_requested, 10),
        it.unit_price_usd != null && it.unit_price_usd !== '' ? u2c(it.unit_price_usd) : null);
    }
    return c.json({ ok: true, id: prId, pr_number: prNum });
  });

  app.post('/api/admin/parts-requisitions/:id/fulfill', adminMw, async (c) => {
    const db = d1(c.env);
    const id = c.req.param('id');
    const pr = await db.one('SELECT * FROM parts_requisitions WHERE id = ?', id);
    if (!pr) return c.json({ error: 'Requisition not found' }, 404);
    if (pr.status === 'fulfilled') return c.json({ error: 'Already fulfilled' }, 400);
    const items = await db.many('SELECT * FROM parts_requisition_items WHERE requisition_id = ?', id);
    const stmts = [];
    let anyBack = false;
    for (const it of items) {
      if (it.status === 'fulfilled' || it.status === 'cancelled') continue;
      const want = it.qty_requested - it.qty_fulfilled;
      let avail = Infinity;
      if (it.product_img) {
        const p = await db.one('SELECT stock_count FROM products WHERE img = ?', it.product_img);
        if (p) avail = p.stock_count;
      }
      const got = Math.max(0, Math.min(want, avail === Infinity ? want : avail));
      if (got < want) anyBack = true;
      if (got > 0) {
        if (it.product_img) stmts.push({ sql: 'UPDATE products SET stock_count = MAX(0, stock_count - ?) WHERE img = ?', binds: [got, it.product_img] });
        if (pr.work_order_id) {
          stmts.push({
            sql: `INSERT INTO work_order_parts (work_order_id, product_img, description, qty, unit_price_cents, total_cents)
                    VALUES (?,?,?,?,?,?)`,
            binds: [pr.work_order_id, it.product_img || null, it.description, got, it.unit_price_cents || 0, (it.unit_price_cents || 0) * got],
          });
        }
        stmts.push({
          sql: `UPDATE parts_requisition_items SET qty_fulfilled = qty_fulfilled + ?,
                  status = CASE WHEN qty_fulfilled + ? >= qty_requested THEN 'fulfilled' ELSE 'backordered' END WHERE id = ?`,
          binds: [got, got, it.id],
        });
      } else {
        stmts.push({ sql: "UPDATE parts_requisition_items SET status = 'backordered' WHERE id = ?", binds: [it.id] });
      }
    }
    const meMech = await db.one('SELECT id FROM mechanics WHERE user_id = ? LIMIT 1', c.get('user').id);
    stmts.push({
      sql: "UPDATE parts_requisitions SET status = ?, fulfilled_by = ?, fulfilled_at = CURRENT_TIMESTAMP WHERE id = ?",
      binds: [anyBack ? 'partial' : 'fulfilled', meMech ? meMech.id : null, id],
    });
    await db.batch(stmts);
    if (pr.work_order_id) await rollupWo(db, pr.work_order_id);
    return c.json({ ok: true, status: anyBack ? 'partial' : 'fulfilled' });
  });

  // ============ SERVICE REQUISITIONS (estimates) ============
  app.get('/api/admin/requisitions', adminMw, async (c) => {
    const status = c.req.query('status') || null;
    const base = `SELECT r.*, r.estimate_total_cents / 100.0 AS estimate_total_usd, sa.name AS advisor_name
      FROM service_requisitions r LEFT JOIN mechanics sa ON sa.id = r.service_advisor_id`;
    const requisitions = status
      ? await d1(c.env).many(`${base} WHERE r.status = ? ORDER BY r.created_at DESC LIMIT 200`, status)
      : await d1(c.env).many(`${base} ORDER BY r.created_at DESC LIMIT 200`);
    return c.json({ requisitions });
  });
  app.get('/api/admin/requisitions/:id', adminMw, async (c) => {
    const db = d1(c.env);
    const id = c.req.param('id');
    const requisition = await db.one(
      `SELECT r.*, r.estimate_total_cents / 100.0 AS estimate_total_usd, sa.name AS advisor_name
         FROM service_requisitions r LEFT JOIN mechanics sa ON sa.id = r.service_advisor_id WHERE r.id = ?`, id);
    if (!requisition) return c.json({ error: 'Requisition not found' }, 404);
    const items = await db.many(
      `SELECT ri.*, ri.labor_cents / 100.0 AS labor_usd, ri.parts_cents / 100.0 AS parts_usd, ri.total_cents / 100.0 AS total_usd,
              s.name AS service_name, s.code AS service_code
         FROM service_requisition_items ri LEFT JOIN services s ON s.id = ri.service_id
        WHERE ri.requisition_id = ? ORDER BY ri.id`, id);
    return c.json({ requisition, items });
  });
  app.post('/api/admin/requisitions', adminMw, async (c) => {
    const db = d1(c.env);
    const b = await c.req.json().catch(() => ({}));
    if (!b.customer_name || !b.customer_phone) return c.json({ error: 'customer_name and customer_phone required' }, 400);
    const reqNum = await nextReqNumber(db);
    const r = await db.run(
      `INSERT INTO service_requisitions
         (req_number, customer_user_id, customer_name, customer_phone, customer_email,
          vehicle_year, vehicle_make, vehicle_model, vehicle_vin, license_plate, mileage_in,
          service_advisor_id, inspection_id, complaint, recommended, valid_until, notes, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      reqNum, b.customer_user_id || null, b.customer_name, b.customer_phone, b.customer_email || null,
      b.vehicle_year || null, b.vehicle_make || null, b.vehicle_model || null,
      (b.vehicle_vin || '').toUpperCase() || null, b.license_plate || null,
      b.mileage_in ? parseInt(b.mileage_in, 10) : null, b.service_advisor_id || null, b.inspection_id || null,
      b.complaint || null, b.recommended || null, b.valid_until || null, b.notes || null, c.get('user').id);
    return c.json({ ok: true, id: r.meta.last_row_id, req_number: reqNum });
  });
  app.patch('/api/admin/requisitions/:id', adminMw, async (c) => {
    const db = d1(c.env);
    const id = c.req.param('id');
    const b = await c.req.json().catch(() => ({}));
    const fields = ['status', 'customer_name', 'customer_phone', 'customer_email', 'vehicle_year', 'vehicle_make',
      'vehicle_model', 'vehicle_vin', 'license_plate', 'mileage_in', 'service_advisor_id', 'complaint',
      'recommended', 'valid_until', 'notes', 'approved_at'];
    const sets = []; const vals = [];
    for (const f of fields) if (b[f] !== undefined) { sets.push(`${f} = ?`); vals.push(b[f]); }
    if (!sets.length) return c.json({ error: 'Nothing to update' }, 400);
    vals.push(id);
    await db.run(`UPDATE service_requisitions SET ${sets.join(', ')} WHERE id = ?`, ...vals);
    if (b.status === 'approved') await db.run("UPDATE service_requisitions SET approved_at = COALESCE(approved_at, CURRENT_TIMESTAMP) WHERE id = ?", id);
    return c.json({ ok: true });
  });
  app.delete('/api/admin/requisitions/:id', managerMw, async (c) => {
    await d1(c.env).run('DELETE FROM service_requisitions WHERE id = ?', c.req.param('id'));
    return c.json({ ok: true });
  });
  app.post('/api/admin/requisitions/:id/items', adminMw, async (c) => {
    const db = d1(c.env);
    const id = c.req.param('id');
    const b = await c.req.json().catch(() => ({}));
    if (!b.description) return c.json({ error: 'description required' }, 400);
    const labor = u2c(b.labor_usd || 0) || 0;
    const parts = u2c(b.parts_usd || 0) || 0;
    await db.run(
      `INSERT INTO service_requisition_items (requisition_id, service_id, description, hours, labor_cents, parts_cents, total_cents)
         VALUES (?,?,?,?,?,?,?)`,
      id, b.service_id || null, b.description, Number(b.hours || 0), labor, parts, labor + parts);
    return c.json({ ok: true, total: await recalcReqTotal(db, id) });
  });
  app.delete('/api/admin/requisitions/:reqId/items/:id', adminMw, async (c) => {
    const db = d1(c.env);
    await db.run('DELETE FROM service_requisition_items WHERE id = ? AND requisition_id = ?', c.req.param('id'), c.req.param('reqId'));
    return c.json({ ok: true, total: await recalcReqTotal(db, c.req.param('reqId')) });
  });
  app.post('/api/admin/requisitions/:id/convert', adminMw, async (c) => {
    const db = d1(c.env);
    const id = c.req.param('id');
    const r = await db.one('SELECT * FROM service_requisitions WHERE id = ?', id);
    if (!r) return c.json({ error: 'Requisition not found' }, 404);
    if (r.converted_to_work_order_id) return c.json({ error: 'Already converted to WO #' + r.converted_to_work_order_id }, 400);
    const woNum = await nextWoNumber(db);
    const wo = await db.run(
      `INSERT INTO work_orders
         (wo_number, customer_user_id, customer_name, customer_phone, customer_email,
          vehicle_year, vehicle_make, vehicle_model, vehicle_vin, license_plate, mileage_in,
          service_advisor_id, inspection_id, complaint, status, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'open',?)`,
      woNum, r.customer_user_id, r.customer_name, r.customer_phone, r.customer_email,
      r.vehicle_year, r.vehicle_make, r.vehicle_model, r.vehicle_vin, r.license_plate, r.mileage_in,
      r.service_advisor_id, r.inspection_id, r.complaint, c.get('user').id);
    const woId = wo.meta.last_row_id;
    const items = await db.many('SELECT * FROM service_requisition_items WHERE requisition_id = ?', id);
    for (const it of items) {
      if ((it.labor_cents || 0) > 0) {
        const hrs = Number(it.hours) > 0 ? Number(it.hours) : 1.0;
        const rateC = Math.round((it.labor_cents || 0) / hrs);
        await db.run('INSERT INTO work_order_labor (work_order_id, description, hours, rate_cents, total_cents) VALUES (?,?,?,?,?)',
          woId, it.description, hrs, rateC, it.labor_cents);
      }
      if ((it.parts_cents || 0) > 0) {
        await db.run('INSERT INTO work_order_parts (work_order_id, description, qty, unit_price_cents, total_cents) VALUES (?,?,?,?,?)',
          woId, it.description + ' (parts)', 1, it.parts_cents, it.parts_cents);
      }
    }
    await rollupWo(db, woId);
    await db.run("UPDATE service_requisitions SET status = 'converted', converted_to_work_order_id = ? WHERE id = ?", woId, id);
    return c.json({ ok: true, work_order_id: woId, wo_number: woNum });
  });

  // ============ STOCK COUNTS ============
  app.post('/api/admin/stock-counts', adminMw, async (c) => {
    const db = d1(c.env);
    const b = await c.req.json().catch(() => ({}));
    const scope = ['full', 'bin', 'category'].includes(b.scope) ? b.scope : 'full';
    const num = await nextStockCountNumber(db);
    const r = await db.run('INSERT INTO stock_counts (count_number, scope, scope_value, counted_by, notes) VALUES (?,?,?,?,?)',
      num, scope, b.scope_value || null, b.counted_by || null, b.notes || null);
    const countId = r.meta.last_row_id;
    let where = 'is_active = 1'; const vals = [];
    if (scope === 'bin') { where += ' AND bin_location = ?'; vals.push(b.scope_value || ''); }
    else if (scope === 'category') { where += ' AND category = ?'; vals.push(b.scope_value || ''); }
    const prods = await db.many(`SELECT img, bin_location, stock_count FROM products WHERE ${where} ORDER BY bin_location, name`, ...vals);
    for (const p of prods) {
      await db.run('INSERT INTO stock_count_items (count_id, product_img, bin_location, system_qty) VALUES (?,?,?,?)',
        countId, p.img, p.bin_location, p.stock_count);
    }
    await db.run('UPDATE stock_counts SET total_items = ? WHERE id = ?', prods.length, countId);
    return c.json({ ok: true, id: countId, count_number: num, total_items: prods.length });
  });
  app.get('/api/admin/stock-counts', adminMw, async (c) => {
    const counts = await d1(c.env).many(
      `SELECT sc.*, m.name AS counter_name FROM stock_counts sc LEFT JOIN mechanics m ON m.id = sc.counted_by
        ORDER BY sc.started_at DESC LIMIT 100`);
    return c.json({ counts });
  });
  app.get('/api/admin/stock-counts/:id', adminMw, async (c) => {
    const db = d1(c.env);
    const id = c.req.param('id');
    const count = await db.one(
      'SELECT sc.*, m.name AS counter_name FROM stock_counts sc LEFT JOIN mechanics m ON m.id = sc.counted_by WHERE sc.id = ?', id);
    if (!count) return c.json({ error: 'Count not found' }, 404);
    const items = await db.many(
      `SELECT sci.*, p.name AS product_name, p.sku FROM stock_count_items sci
         LEFT JOIN products p ON p.img = sci.product_img WHERE sci.count_id = ? ORDER BY sci.bin_location, p.name`, id);
    return c.json({ count, items });
  });
  app.patch('/api/admin/stock-count-items/:id', adminMw, async (c) => {
    const b = await c.req.json().catch(() => ({}));
    if (b.counted_qty == null) return c.json({ error: 'counted_qty required' }, 400);
    await d1(c.env).run(
      'UPDATE stock_count_items SET counted_qty = ?, notes = COALESCE(?, notes), counted_at = CURRENT_TIMESTAMP WHERE id = ?',
      parseInt(b.counted_qty, 10), b.notes || null, c.req.param('id'));
    return c.json({ ok: true });
  });
  app.post('/api/admin/stock-counts/:id/post', adminMw, async (c) => {
    const db = d1(c.env);
    const id = c.req.param('id');
    const count = await db.one('SELECT * FROM stock_counts WHERE id = ?', id);
    if (!count) return c.json({ error: 'Count not found' }, 404);
    if (count.status === 'posted') return c.json({ error: 'Already posted' }, 400);
    const items = await db.many('SELECT * FROM stock_count_items WHERE count_id = ? AND counted_qty IS NOT NULL', id);
    const stmts = [];
    let totalVar = 0;
    for (const it of items) {
      const delta = (it.counted_qty || 0) - it.system_qty;
      if (delta !== 0 && it.product_img) {
        stmts.push({ sql: 'UPDATE products SET stock_count = ? WHERE img = ?', binds: [it.counted_qty, it.product_img] });
        stmts.push(logActivity('count_post', {
          product_img: it.product_img, qty_before: it.system_qty, qty_after: it.counted_qty, qty_delta: delta,
          ref_kind: 'stock_count', ref_id: count.id, notes: 'Adjusted from stock count ' + count.count_number,
        }));
        totalVar += Math.abs(delta);
      }
    }
    stmts.push({ sql: "UPDATE stock_counts SET status = 'posted', posted_at = CURRENT_TIMESTAMP, total_variance = ? WHERE id = ?", binds: [totalVar, id] });
    await db.batch(stmts);
    return c.json({ ok: true, total_variance: totalVar, items_adjusted: items.length });
  });

  // ============ STOCK ADJUST ============
  app.post('/api/admin/stock-adjust', managerMw, async (c) => {
    const db = d1(c.env);
    const b = await c.req.json().catch(() => ({}));
    if (!b.product_img || b.new_qty == null) return c.json({ error: 'product_img and new_qty required' }, 400);
    const before = await db.one('SELECT stock_count FROM products WHERE img = ?', b.product_img);
    if (!before) return c.json({ error: 'Product not found' }, 404);
    const newQty = Math.max(0, parseInt(b.new_qty, 10));
    await db.batch([
      { sql: 'UPDATE products SET stock_count = ? WHERE img = ?', binds: [newQty, b.product_img] },
      logActivity('adjust', {
        product_img: b.product_img, qty_before: before.stock_count, qty_after: newQty,
        qty_delta: newQty - before.stock_count, ref_kind: 'manual', notes: b.reason || 'Manual adjustment',
      }),
    ]);
    return c.json({ ok: true, qty_before: before.stock_count, qty_after: newQty });
  });

  // ============ WAREHOUSE ACTIVITY ============
  app.get('/api/admin/warehouse-activity', adminMw, async (c) => {
    const limit = Math.min(500, parseInt(c.req.query('limit'), 10) || 100);
    const productImg = c.req.query('product') || null;
    const base = `SELECT wa.*, p.name AS product_name FROM warehouse_activity wa LEFT JOIN products p ON p.img = wa.product_img`;
    const activity = productImg
      ? await d1(c.env).many(`${base} WHERE wa.product_img = ? ORDER BY wa.created_at DESC LIMIT ?`, productImg, limit)
      : await d1(c.env).many(`${base} ORDER BY wa.created_at DESC LIMIT ?`, limit);
    return c.json({ activity });
  });

  // ============ BIN LOOKUP ============
  app.get('/api/admin/bin/:bin', adminMw, async (c) => {
    const bin = c.req.param('bin');
    const products = await d1(c.env).many(
      'SELECT img, name, sku, barcode, category, stock_count, low_threshold FROM products WHERE bin_location = ? ORDER BY name', bin);
    return c.json({ bin, products });
  });

  // ============ DELIVERIES ============
  app.get('/api/admin/deliveries', adminMw, async (c) => {
    const status = c.req.query('status') || null;
    const base = `SELECT d.*, m.name AS driver_name FROM deliveries d LEFT JOIN mechanics m ON m.id = d.driver_id`;
    const deliveries = status
      ? await d1(c.env).many(`${base} WHERE d.status = ? ORDER BY COALESCE(d.scheduled_for, d.created_at) DESC LIMIT 100`, status)
      : await d1(c.env).many(`${base} ORDER BY COALESCE(d.scheduled_for, d.created_at) DESC LIMIT 100`);
    return c.json({ deliveries });
  });
  app.post('/api/admin/deliveries', adminMw, async (c) => {
    const db = d1(c.env);
    const b = await c.req.json().catch(() => ({}));
    if (!b.recipient_name) return c.json({ error: 'recipient_name required' }, 400);
    const num = await nextDeliveryNumber(db);
    const r = await db.run(
      `INSERT INTO deliveries (delivery_number, related_kind, related_id, recipient_name, recipient_phone, address, driver_id, vehicle, scheduled_for, notes, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      num, b.related_kind || null, b.related_id || null, b.recipient_name, b.recipient_phone || null,
      b.address || null, b.driver_id || null, b.vehicle || null, b.scheduled_for || null, b.notes || null, c.get('user').id);
    return c.json({ ok: true, id: r.meta.last_row_id, delivery_number: num });
  });
  app.patch('/api/admin/deliveries/:id', adminMw, async (c) => {
    const db = d1(c.env);
    const id = c.req.param('id');
    const b = await c.req.json().catch(() => ({}));
    const fields = ['status', 'driver_id', 'vehicle', 'scheduled_for', 'dispatched_at', 'delivered_at', 'proof_photo',
      'proof_signature', 'recipient_received_by', 'notes', 'recipient_name', 'recipient_phone', 'address'];
    const sets = []; const vals = [];
    for (const f of fields) if (b[f] !== undefined) { sets.push(`${f} = ?`); vals.push(b[f]); }
    if (!sets.length) return c.json({ error: 'Nothing to update' }, 400);
    vals.push(id);
    await db.run(`UPDATE deliveries SET ${sets.join(', ')} WHERE id = ?`, ...vals);
    if (b.status === 'dispatched') await db.run("UPDATE deliveries SET dispatched_at = COALESCE(dispatched_at, CURRENT_TIMESTAMP) WHERE id = ?", id);
    if (b.status === 'delivered') {
      await db.run("UPDATE deliveries SET delivered_at = COALESCE(delivered_at, CURRENT_TIMESTAMP) WHERE id = ?", id);
      await db.run(logActivity('delivery', { ref_kind: 'delivery', ref_id: id, notes: 'Marked delivered' }).sql,
        ...logActivity('delivery', { ref_kind: 'delivery', ref_id: id, notes: 'Marked delivered' }).binds);
    }
    return c.json({ ok: true });
  });

  // ============ CASH DRAWER ============
  app.get('/api/admin/cash-drawer/open', adminMw, async (c) => {
    const session = await d1(c.env).one(
      `SELECT cds.*, cds.opening_float_cents / 100.0 AS opening_float,
              cds.closing_amount_cents / 100.0 AS closing_amount, cds.expected_cash_cents / 100.0 AS expected_cash,
              cds.variance_cents / 100.0 AS variance, m.name AS opener_name
         FROM cash_drawer_sessions cds LEFT JOIN mechanics m ON m.id = cds.opened_by
        WHERE cds.closed_at IS NULL ORDER BY cds.opened_at DESC LIMIT 1`);
    return c.json({ session: session || null });
  });
  app.post('/api/admin/cash-drawer/open', managerMw, async (c) => {
    const db = d1(c.env);
    const b = await c.req.json().catch(() => ({}));
    const open = await db.one('SELECT id FROM cash_drawer_sessions WHERE closed_at IS NULL');
    if (open) return c.json({ error: 'A cash drawer session is already open (#' + open.id + ')' }, 400);
    const r = await db.run('INSERT INTO cash_drawer_sessions (opened_by, opening_float_cents, notes) VALUES (?,?,?)',
      b.opened_by || null, u2c(b.opening_float || 0) || 0, b.notes || null);
    return c.json({ ok: true, id: r.meta.last_row_id });
  });
  app.post('/api/admin/cash-drawer/:id/close', managerMw, async (c) => {
    const db = d1(c.env);
    const id = c.req.param('id');
    const b = await c.req.json().catch(() => ({}));
    const sess = await db.one('SELECT * FROM cash_drawer_sessions WHERE id = ?', id);
    if (!sess || sess.closed_at) return c.json({ error: 'Session not open' }, 400);
    const cs = await db.one(
      "SELECT COALESCE(SUM(total_cents),0) / 100.0 AS s FROM pos_sales WHERE payment_method = 'cash' AND voided = 0 AND created_at >= ?",
      sess.opened_at);
    // Cash paid straight out of this drawer (petty cash, a fund replenishment,
    // any other payout) never made it into the count -- subtract it from what
    // we expect to find, or every payout would read as an unexplained shortage.
    const po = await db.one(
      "SELECT COALESCE(SUM(amount_cents),0) / 100.0 AS s FROM cash_payouts WHERE source_type = 'drawer' AND drawer_session_id = ?",
      id);
    const expected = r2(c2u(sess.opening_float_cents) + (cs.s || 0) - (po.s || 0));
    const closing = Number(b.closing_amount || 0);
    const variance = r2(closing - expected);
    await db.run(
      `UPDATE cash_drawer_sessions SET closed_by = ?, closing_amount_cents = ?, expected_cash_cents = ?, variance_cents = ?, notes = ?, closed_at = CURRENT_TIMESTAMP WHERE id = ?`,
      b.closed_by || null, u2c(closing), u2c(expected), u2c(variance), b.notes || sess.notes, id);
    return c.json({ ok: true, expected_cash: expected, closing_amount: closing, variance, payouts: po.s || 0 });
  });

  // ============ CASH PAYOUTS + PETTY CASH ============
  app.get('/api/admin/cash-payouts', adminMw, async (c) => {
    const db = d1(c.env);
    const drawerId = c.req.query('drawer_session_id');
    const fundId = c.req.query('fund_id');
    const where = []; const binds = [];
    if (drawerId) { where.push('cp.drawer_session_id = ?'); binds.push(drawerId); }
    if (fundId) { where.push('cp.fund_id = ?'); binds.push(fundId); }
    const rows = await db.many(
      `SELECT cp.id, cp.amount_cents / 100.0 AS amount_usd, cp.reason, cp.paid_to, cp.notes,
              cp.source_type, cp.drawer_session_id, cp.fund_id, cp.created_at,
              u.name AS authorized_by_name
         FROM cash_payouts cp LEFT JOIN users u ON u.id = cp.authorized_by
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY cp.created_at DESC LIMIT 500`, ...binds);
    return c.json({ payouts: rows });
  });
  app.post('/api/admin/cash-payouts', managerMw, async (c) => {
    const db = d1(c.env);
    const me = c.get('user');
    const b = await c.req.json().catch(() => ({}));
    const amount = Number(b.amount_usd || 0);
    if (!(amount > 0)) return c.json({ error: 'A positive amount is required' }, 400);
    if (!String(b.reason || '').trim()) return c.json({ error: 'A reason is required' }, 400);
    const sourceType = b.source_type === 'fund' ? 'fund' : 'drawer';
    const amountCents = u2c(amount);
    const stmts = [];
    if (sourceType === 'drawer') {
      const sess = await db.one('SELECT id FROM cash_drawer_sessions WHERE id = ? AND closed_at IS NULL', b.drawer_session_id);
      if (!sess) return c.json({ error: 'That cash drawer session is not open' }, 400);
    } else {
      const fund = await db.one('SELECT id, balance_cents FROM petty_cash_funds WHERE id = ? AND is_active = 1', b.fund_id);
      if (!fund) return c.json({ error: 'Petty cash fund not found' }, 404);
      if (fund.balance_cents < amountCents) return c.json({ error: 'That would take the fund below zero (balance is ' + (fund.balance_cents / 100).toFixed(2) + ')' }, 400);
      stmts.push({ sql: 'UPDATE petty_cash_funds SET balance_cents = balance_cents - ? WHERE id = ?', binds: [amountCents, fund.id] });
    }
    stmts.push({
      sql: `INSERT INTO cash_payouts (amount_cents, reason, paid_to, notes, source_type, drawer_session_id, fund_id, authorized_by)
            VALUES (?,?,?,?,?,?,?,?)`,
      binds: [amountCents, String(b.reason).trim().slice(0, 200), b.paid_to ? String(b.paid_to).trim().slice(0, 200) : null,
        b.notes ? String(b.notes).trim().slice(0, 500) : null, sourceType,
        sourceType === 'drawer' ? parseInt(b.drawer_session_id, 10) : null,
        sourceType === 'fund' ? parseInt(b.fund_id, 10) : null, me.id],
    });
    await db.batch(stmts);
    return c.json({ ok: true });
  });

  app.get('/api/admin/petty-cash-funds', adminMw, async (c) => {
    const rows = await d1(c.env).many(
      `SELECT f.id, f.name, f.balance_cents / 100.0 AS balance_usd, f.custodian_id, f.is_active, f.created_at,
              u.name AS custodian_name
         FROM petty_cash_funds f LEFT JOIN users u ON u.id = f.custodian_id
        ORDER BY f.is_active DESC, f.name`);
    return c.json({ funds: rows });
  });
  app.post('/api/admin/petty-cash-funds', managerMw, async (c) => {
    const db = d1(c.env);
    const b = await c.req.json().catch(() => ({}));
    if (!String(b.name || '').trim()) return c.json({ error: 'A name is required' }, 400);
    const r = await db.run(
      'INSERT INTO petty_cash_funds (name, balance_cents, custodian_id) VALUES (?,?,?)',
      String(b.name).trim().slice(0, 120), u2c(b.opening_balance_usd || 0) || 0, b.custodian_id ? parseInt(b.custodian_id, 10) : null);
    return c.json({ ok: true, id: r.meta.last_row_id });
  });
  app.post('/api/admin/petty-cash-funds/:id/replenish', managerMw, async (c) => {
    const db = d1(c.env);
    const me = c.get('user');
    const id = c.req.param('id');
    const b = await c.req.json().catch(() => ({}));
    const amount = Number(b.amount_usd || 0);
    if (!(amount > 0)) return c.json({ error: 'A positive amount is required' }, 400);
    const fund = await db.one('SELECT id FROM petty_cash_funds WHERE id = ? AND is_active = 1', id);
    if (!fund) return c.json({ error: 'Petty cash fund not found' }, 404);
    const amountCents = u2c(amount);
    const stmts = [{ sql: 'UPDATE petty_cash_funds SET balance_cents = balance_cents + ? WHERE id = ?', binds: [amountCents, id] }];
    // Sourced from the till: the transfer out of the drawer is itself a
    // drawer payout, so it still shows up in that session's reconciliation.
    if (b.source === 'drawer') {
      const sess = await db.one('SELECT id FROM cash_drawer_sessions WHERE id = ? AND closed_at IS NULL', b.drawer_session_id);
      if (!sess) return c.json({ error: 'That cash drawer session is not open' }, 400);
      stmts.push({
        sql: `INSERT INTO cash_payouts (amount_cents, reason, source_type, drawer_session_id, fund_id, authorized_by)
              VALUES (?, 'Petty cash replenishment', 'drawer', ?, ?, ?)`,
        binds: [amountCents, sess.id, id, me.id],
      });
    }
    await db.batch(stmts);
    return c.json({ ok: true });
  });

  // ============ CASH REPORT ============
  app.get('/api/admin/cash-report', adminMw, async (c) => {
    const db = d1(c.env);
    const from = c.req.query('from') || new Date().toISOString().slice(0, 10);
    const to = c.req.query('to') || from;
    const [by_method, by_mechanic, per_day, totals, recent] = await Promise.all([
      db.many(`SELECT method, COUNT(*) AS n, COALESCE(SUM(amount_cents),0) / 100.0 AS s
                 FROM work_order_payments WHERE date(received_at) BETWEEN ? AND ? GROUP BY method ORDER BY s DESC`, from, to),
      db.many(`SELECT m.name AS mechanic_name, COUNT(*) AS n, COALESCE(SUM(p.amount_cents),0) / 100.0 AS s
                 FROM work_order_payments p LEFT JOIN mechanics m ON m.id = p.received_by
                WHERE date(p.received_at) BETWEEN ? AND ? GROUP BY m.name ORDER BY s DESC`, from, to),
      db.many(`SELECT date(received_at) AS day, COALESCE(SUM(amount_cents),0) / 100.0 AS s, COUNT(*) AS n
                 FROM work_order_payments WHERE date(received_at) BETWEEN ? AND ? GROUP BY day ORDER BY day DESC`, from, to),
      db.one(`SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents),0) / 100.0 AS s
                FROM work_order_payments WHERE date(received_at) BETWEEN ? AND ?`, from, to),
      db.many(`SELECT p.*, p.amount_cents / 100.0 AS amount_usd, w.wo_number, w.customer_name, m.name AS receiver_name
                 FROM work_order_payments p
                 LEFT JOIN work_orders w ON w.id = p.work_order_id
                 LEFT JOIN mechanics m ON m.id = p.received_by
                WHERE date(p.received_at) BETWEEN ? AND ? ORDER BY p.received_at DESC LIMIT 100`, from, to),
    ]);
    return c.json({ from, to, by_method, by_mechanic, per_day, totals, recent });
  });
}
