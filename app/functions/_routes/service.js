// Phase 13 — service centre. Ports server.js:
//   GET/POST/PATCH/DELETE /api/admin/mechanics[/:id]
//   GET/POST/PATCH/DELETE /api/admin/services[/:id]
//   GET/POST/PATCH/DELETE /api/admin/work-orders[/:id]
//   POST/DELETE /api/admin/work-orders/:id/labor[/:id]
//   POST/DELETE /api/admin/work-orders/:id/parts[/:id]
//   GET/POST/DELETE /api/admin/work-orders/:id/payments[/:id]
//   POST /api/admin/work-orders/:id/signature
//   GET/POST/PATCH/DELETE /api/admin/inspections[/:id]
//   PATCH /api/admin/inspection-items/:id
//   GET /api/admin/labor-standards   GET /api/admin/labor-estimate
//   GET /api/admin/maintenance-due   GET /api/admin/vehicle-history
import { d1 } from '../_lib/db.js';
import { adminMw, managerMw } from '../_lib/guards.js';
import { boolify } from '../_lib/util.js';
import { inClause } from '../_lib/db.js';

const TAX_RATE = 0.15;
const c2u = (c) => (c == null ? null : c / 100);
const u2c = (u) => (u == null || u === '' ? null : Math.round(Number(u) * 100));
const r2 = (n) => Math.round(n * 100) / 100;
const bit = (v) => (v ? 1 : 0);
const MAINT_KM = { 'Oil Change': 8000, 'Tire Rotation': 12000, 'Brake Inspection': 20000, 'Transmission Service': 50000 };

async function nextWoNumber(db) {
  const year = new Date().getFullYear();
  const rows = await db.many("SELECT wo_number AS w FROM work_orders WHERE wo_number LIKE ?", `WO-${year}-%`);
  let mx = 0; for (const r of rows) { const m = String(r.w || '').match(/(\d+)\s*$/); if (m) mx = Math.max(mx, +m[1]); }
  return `WO-${year}-${String(mx + 1).padStart(4, '0')}`;
}
async function recalcWoTotals(db, woId) {
  const l = await db.one('SELECT COALESCE(SUM(total_cents),0) AS s FROM work_order_labor WHERE work_order_id = ?', woId);
  const p = await db.one('SELECT COALESCE(SUM(total_cents),0) AS s FROM work_order_parts WHERE work_order_id = ?', woId);
  const labor = (l.s || 0) / 100, parts = (p.s || 0) / 100;
  const subtotal = r2(labor + parts);
  const tax = r2(subtotal * TAX_RATE);
  const total = r2(subtotal + tax);
  await db.run('UPDATE work_orders SET labor_total_cents = ?, parts_total_cents = ?, tax_cents = ?, total_cents = ? WHERE id = ?',
    u2c(labor), u2c(parts), u2c(tax), u2c(total), woId);
  return { labor, parts, tax, total };
}

const WO_USD = `w.labor_total_cents / 100.0 AS labor_total_usd, w.parts_total_cents / 100.0 AS parts_total_usd,
  w.tax_cents / 100.0 AS tax_usd, w.total_cents / 100.0 AS total_usd`;

export default function mount(app) {
  // ============ MECHANICS ============
  app.get('/api/admin/mechanics', adminMw, async (c) => {
    const cl = []; const vals = [];
    if (c.req.query('active') === 'true') cl.push('is_active = 1');
    if (c.req.query('role') === 'advisor') cl.push("role IN ('advisor','both')");
    else if (c.req.query('role') === 'mechanic') cl.push("role IN ('mechanic','both')");
    const mechanics = await d1(c.env).many(
      `SELECT id, user_id, name, phone, email, specialty, certifications,
              hourly_rate_cents / 100.0 AS hourly_rate_usd, hire_date, is_active, notes, role, created_at
         FROM mechanics ${cl.length ? 'WHERE ' + cl.join(' AND ') : ''} ORDER BY is_active DESC, name ASC`);
    return c.json({ mechanics: mechanics.map((r) => boolify(r, ['is_active'])) });
  });
  app.post('/api/admin/mechanics', managerMw, async (c) => {
    const b = await c.req.json().catch(() => ({}));
    if (!b.name) return c.json({ error: 'name required' }, 400);
    const role = ['mechanic', 'advisor', 'both'].includes(b.role) ? b.role : 'mechanic';
    const r = await d1(c.env).run(
      `INSERT INTO mechanics (user_id, name, phone, email, specialty, certifications, hourly_rate_cents, hire_date, is_active, notes, role)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      b.user_id || null, b.name, b.phone || null, b.email || null, b.specialty || null, b.certifications || null,
      b.hourly_rate_usd != null ? u2c(b.hourly_rate_usd) : 2500, b.hire_date || null, b.is_active === false ? 0 : 1, b.notes || null, role);
    return c.json({ ok: true, id: r.meta.last_row_id });
  });
  app.patch('/api/admin/mechanics/:id', managerMw, async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const MAP = { name: 0, phone: 0, email: 0, specialty: 0, certifications: 0, hire_date: 0, is_active: 1, notes: 0, user_id: 0, role: 0 };
    const sets = []; const vals = [];
    for (const [f, isB] of Object.entries(MAP)) if (b[f] !== undefined) { sets.push(`${f} = ?`); vals.push(isB ? bit(b[f]) : b[f]); }
    if (b.hourly_rate_usd !== undefined) { sets.push('hourly_rate_cents = ?'); vals.push(u2c(b.hourly_rate_usd)); }
    if (!sets.length) return c.json({ error: 'Nothing to update' }, 400);
    vals.push(c.req.param('id'));
    await d1(c.env).run(`UPDATE mechanics SET ${sets.join(', ')} WHERE id = ?`, ...vals);
    return c.json({ ok: true });
  });
  app.delete('/api/admin/mechanics/:id', managerMw, async (c) => {
    await d1(c.env).run('UPDATE mechanics SET is_active = 0 WHERE id = ?', c.req.param('id'));
    return c.json({ ok: true });
  });

  // ============ SERVICES CATALOGUE ============
  const SVC_USD = `id, code, name, category, description, default_hours,
    default_price_cents / 100.0 AS default_price_usd,
    default_labor_cents / 100.0 AS default_labor_usd,
    default_parts_cents / 100.0 AS default_parts_usd, is_active, created_at`;
  app.get('/api/admin/services', adminMw, async (c) => {
    const where = c.req.query('active') === 'true' ? 'WHERE is_active = 1' : '';
    const services = await d1(c.env).many(
      `SELECT ${SVC_USD} FROM services ${where} ORDER BY is_active DESC, category ASC, name ASC`);
    return c.json({ services: services.map((r) => boolify(r, ['is_active'])) });
  });
  app.post('/api/admin/services', adminMw, async (c) => {
    const b = await c.req.json().catch(() => ({}));
    if (!b.name) return c.json({ error: 'name required' }, 400);
    try {
      const r = await d1(c.env).run(
        `INSERT INTO services (code, name, category, description, default_hours, default_price_cents, default_labor_cents, default_parts_cents, is_active)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        b.code || null, b.name, b.category || null, b.description || null,
        b.default_hours != null ? Number(b.default_hours) : 1.0,
        u2c(b.default_price_usd), u2c(b.default_labor_usd), u2c(b.default_parts_usd), b.is_active === false ? 0 : 1);
      return c.json({ ok: true, id: r.meta.last_row_id });
    } catch (e) {
      if (String(e.message || '').includes('UNIQUE')) return c.json({ error: 'Service code already exists' }, 400);
      throw e;
    }
  });
  app.patch('/api/admin/services/:id', adminMw, async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const PLAIN = ['code', 'name', 'category', 'description', 'default_hours'];
    const CENTS = { default_price_usd: 'default_price_cents', default_labor_usd: 'default_labor_cents', default_parts_usd: 'default_parts_cents' };
    const sets = []; const vals = [];
    for (const f of PLAIN) if (b[f] !== undefined) { sets.push(`${f} = ?`); vals.push(b[f]); }
    for (const [f, col] of Object.entries(CENTS)) if (b[f] !== undefined) { sets.push(`${col} = ?`); vals.push(u2c(b[f])); }
    if (b.is_active !== undefined) { sets.push('is_active = ?'); vals.push(bit(b.is_active)); }
    if (!sets.length) return c.json({ error: 'Nothing to update' }, 400);
    vals.push(c.req.param('id'));
    await d1(c.env).run(`UPDATE services SET ${sets.join(', ')} WHERE id = ?`, ...vals);
    return c.json({ ok: true });
  });
  app.delete('/api/admin/services/:id', managerMw, async (c) => {
    await d1(c.env).run('UPDATE services SET is_active = 0 WHERE id = ?', c.req.param('id'));
    return c.json({ ok: true });
  });

  // ============ WORK ORDERS ============
  app.get('/api/admin/work-orders', adminMw, async (c) => {
    const status = c.req.query('status') || null;
    const base = `SELECT w.*, ${WO_USD}, m.name AS mechanic_name, sa.name AS advisor_name
       FROM work_orders w
       LEFT JOIN mechanics m ON m.id = w.assigned_mechanic_id
       LEFT JOIN mechanics sa ON sa.id = w.service_advisor_id`;
    const work_orders = status
      ? await d1(c.env).many(`${base} WHERE w.status = ? ORDER BY w.created_at DESC LIMIT 200`, status)
      : await d1(c.env).many(`${base} ORDER BY w.created_at DESC LIMIT 200`);
    return c.json({ work_orders });
  });

  app.get('/api/admin/work-orders/:id', adminMw, async (c) => {
    const db = d1(c.env);
    const id = c.req.param('id');
    const wo = await db.one(
      `SELECT w.*, ${WO_USD}, m.name AS mechanic_name, m.hourly_rate_cents / 100.0 AS mechanic_rate,
              sa.name AS advisor_name, sa.phone AS advisor_phone
         FROM work_orders w
         LEFT JOIN mechanics m ON m.id = w.assigned_mechanic_id
         LEFT JOIN mechanics sa ON sa.id = w.service_advisor_id WHERE w.id = ?`, id);
    if (!wo) return c.json({ error: 'Work order not found' }, 404);
    const labor = await db.many(
      `SELECT l.*, l.rate_cents / 100.0 AS rate_usd, l.total_cents / 100.0 AS total_usd, m.name AS mechanic_name
         FROM work_order_labor l LEFT JOIN mechanics m ON m.id = l.mechanic_id
        WHERE l.work_order_id = ? ORDER BY l.id`, id);
    const parts = await db.many(
      `SELECT p.*, p.unit_price_cents / 100.0 AS unit_price_usd, p.total_cents / 100.0 AS total_usd, pr.name AS product_name
         FROM work_order_parts p LEFT JOIN products pr ON pr.img = p.product_img
        WHERE p.work_order_id = ? ORDER BY p.id`, id);
    return c.json({ work_order: wo, labor, parts });
  });

  app.post('/api/admin/work-orders', adminMw, async (c) => {
    const db = d1(c.env);
    const b = await c.req.json().catch(() => ({}));
    if (!b.customer_name || !b.customer_phone) return c.json({ error: 'customer_name and customer_phone required' }, 400);
    const woNum = await nextWoNumber(db);
    const r = await db.run(
      `INSERT INTO work_orders
         (wo_number, customer_user_id, customer_name, customer_phone, customer_email,
          vehicle_year, vehicle_make, vehicle_model, vehicle_vin, license_plate, mileage_in,
          assigned_mechanic_id, service_advisor_id, service_appointment_id, inspection_id,
          complaint, priority, promised_date, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      woNum, b.customer_user_id || null, b.customer_name, b.customer_phone, b.customer_email || null,
      b.vehicle_year || null, b.vehicle_make || null, b.vehicle_model || null,
      (b.vehicle_vin || '').toUpperCase() || null, b.license_plate || null,
      b.mileage_in ? parseInt(b.mileage_in, 10) : null,
      b.assigned_mechanic_id || null, b.service_advisor_id || null, b.service_appointment_id || null, b.inspection_id || null,
      b.complaint || null, ['low', 'normal', 'rush'].includes(b.priority) ? b.priority : 'normal',
      b.promised_date || null, c.get('user').id);
    return c.json({ ok: true, id: r.meta.last_row_id, wo_number: woNum });
  });

  app.patch('/api/admin/work-orders/:id', adminMw, async (c) => {
    const db = d1(c.env);
    const id = c.req.param('id');
    const b = await c.req.json().catch(() => ({}));
    const PLAIN = ['status', 'priority', 'assigned_mechanic_id', 'service_advisor_id', 'complaint', 'diagnosis',
      'work_performed', 'promised_date', 'completed_at', 'paid_at', 'payment_method', 'internal_notes',
      'customer_name', 'customer_phone', 'customer_email', 'vehicle_year', 'vehicle_make', 'vehicle_model',
      'vehicle_vin', 'license_plate', 'mileage_in'];
    const sets = []; const vals = [];
    for (const f of PLAIN) if (b[f] !== undefined) { sets.push(`${f} = ?`); vals.push(b[f]); }
    if (b.tax_usd !== undefined) { sets.push('tax_cents = ?'); vals.push(u2c(b.tax_usd)); }
    if (!sets.length) return c.json({ error: 'Nothing to update' }, 400);
    vals.push(id);
    await db.run(`UPDATE work_orders SET ${sets.join(', ')} WHERE id = ?`, ...vals);
    if (b.status === 'completed') await db.run("UPDATE work_orders SET completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP) WHERE id = ?", id);
    if (b.status === 'paid') await db.run("UPDATE work_orders SET paid_at = COALESCE(paid_at, CURRENT_TIMESTAMP) WHERE id = ?", id);
    return c.json({ ok: true });
  });

  app.delete('/api/admin/work-orders/:id', managerMw, async (c) => {
    await d1(c.env).run('DELETE FROM work_orders WHERE id = ?', c.req.param('id'));
    return c.json({ ok: true });
  });

  app.post('/api/admin/work-orders/:id/labor', adminMw, async (c) => {
    const db = d1(c.env);
    const id = c.req.param('id');
    const b = await c.req.json().catch(() => ({}));
    if (!b.description || !b.hours || !b.rate_usd) return c.json({ error: 'description, hours, rate_usd required' }, 400);
    const hours = Number(b.hours), rate = Number(b.rate_usd);
    await db.run(
      `INSERT INTO work_order_labor (work_order_id, mechanic_id, description, hours, rate_cents, total_cents, performed_date)
         VALUES (?,?,?,?,?,?,?)`,
      id, b.mechanic_id || null, b.description, hours, u2c(rate), u2c(r2(hours * rate)), b.performed_date || null);
    return c.json({ ok: true, totals: await recalcWoTotals(db, id) });
  });
  app.delete('/api/admin/work-orders/:woId/labor/:id', adminMw, async (c) => {
    const db = d1(c.env);
    await db.run('DELETE FROM work_order_labor WHERE id = ? AND work_order_id = ?', c.req.param('id'), c.req.param('woId'));
    return c.json({ ok: true, totals: await recalcWoTotals(db, c.req.param('woId')) });
  });

  app.post('/api/admin/work-orders/:id/parts', adminMw, async (c) => {
    const db = d1(c.env);
    const id = c.req.param('id');
    const b = await c.req.json().catch(() => ({}));
    if (!b.description || !b.qty || b.unit_price_usd == null) return c.json({ error: 'description, qty, unit_price_usd required' }, 400);
    const qty = parseInt(b.qty, 10), unit = Number(b.unit_price_usd);
    await db.run(
      `INSERT INTO work_order_parts (work_order_id, product_img, description, qty, unit_price_cents, total_cents)
         VALUES (?,?,?,?,?,?)`,
      id, b.product_img || null, b.description, qty, u2c(unit), u2c(r2(qty * unit)));
    return c.json({ ok: true, totals: await recalcWoTotals(db, id) });
  });
  app.delete('/api/admin/work-orders/:woId/parts/:id', adminMw, async (c) => {
    const db = d1(c.env);
    await db.run('DELETE FROM work_order_parts WHERE id = ? AND work_order_id = ?', c.req.param('id'), c.req.param('woId'));
    return c.json({ ok: true, totals: await recalcWoTotals(db, c.req.param('woId')) });
  });

  app.post('/api/admin/work-orders/:id/signature', adminMw, async (c) => {
    const sig = (await c.req.json().catch(() => ({}))).signature || '';
    if (!sig.startsWith('data:image/')) return c.json({ error: 'signature must be a data: URL' }, 400);
    await d1(c.env).run('UPDATE work_orders SET customer_signature = ?, customer_signed_at = CURRENT_TIMESTAMP WHERE id = ?', sig, c.req.param('id'));
    return c.json({ ok: true });
  });

  app.get('/api/admin/work-orders/:id/payments', adminMw, async (c) => {
    const payments = await d1(c.env).many(
      `SELECT p.*, p.amount_cents / 100.0 AS amount_usd, m.name AS receiver_name
         FROM work_order_payments p LEFT JOIN mechanics m ON m.id = p.received_by
        WHERE p.work_order_id = ? ORDER BY p.received_at DESC`, c.req.param('id'));
    return c.json({ payments });
  });
  app.post('/api/admin/work-orders/:id/payments', adminMw, async (c) => {
    const db = d1(c.env);
    const id = c.req.param('id');
    const b = await c.req.json().catch(() => ({}));
    if (!b.method || !b.amount_usd) return c.json({ error: 'method and amount_usd required' }, 400);
    if (!['cash', 'card', 'bank_transfer', 'cheque', 'mobile'].includes(b.method)) return c.json({ error: 'Invalid payment method' }, 400);
    const amt = Number(b.amount_usd);
    if (!(amt > 0)) return c.json({ error: 'amount must be positive' }, 400);
    await db.run(
      'INSERT INTO work_order_payments (work_order_id, method, amount_cents, reference, received_by, notes) VALUES (?,?,?,?,?,?)',
      id, b.method, u2c(amt), b.reference || null, b.received_by || null, b.notes || null);
    const w = await db.one('SELECT total_cents / 100.0 AS total FROM work_orders WHERE id = ?', id);
    const p = await db.one('SELECT COALESCE(SUM(amount_cents),0) / 100.0 AS paid FROM work_order_payments WHERE work_order_id = ?', id);
    const fully = w && p && p.paid >= w.total && w.total > 0;
    if (fully) await db.run("UPDATE work_orders SET status = 'paid', paid_at = COALESCE(paid_at, CURRENT_TIMESTAMP) WHERE id = ?", id);
    return c.json({ ok: true, total_paid: p.paid, fully_paid: !!fully });
  });
  app.delete('/api/admin/work-orders/:woId/payments/:id', adminMw, async (c) => {
    const db = d1(c.env);
    const woId = c.req.param('woId');
    await db.run('DELETE FROM work_order_payments WHERE id = ? AND work_order_id = ?', c.req.param('id'), woId);
    const w = await db.one('SELECT total_cents / 100.0 AS total FROM work_orders WHERE id = ?', woId);
    const p = await db.one('SELECT COALESCE(SUM(amount_cents),0) / 100.0 AS paid FROM work_order_payments WHERE work_order_id = ?', woId);
    if (w && p && p.paid < w.total) await db.run("UPDATE work_orders SET status = 'completed', paid_at = NULL WHERE id = ? AND status = 'paid'", woId);
    return c.json({ ok: true });
  });

  // ============ INSPECTIONS ============
  app.get('/api/admin/inspections', adminMw, async (c) => {
    const kind = c.req.query('kind') || null;
    const sel = `SELECT i.id, i.kind, i.status, i.vehicle_year, i.vehicle_make, i.vehicle_model,
              i.vin, i.mileage, i.customer_name, i.inspector_name, i.created_at, i.completed_at,
              (SELECT COUNT(*) FROM inspection_items WHERE inspection_id = i.id) AS items_count,
              (SELECT COUNT(*) FROM inspection_photos WHERE inspection_id = i.id) AS photos_count
         FROM inspections i`;
    const inspections = kind
      ? await d1(c.env).many(`${sel} WHERE i.kind = ? ORDER BY i.created_at DESC LIMIT 200`, kind)
      : await d1(c.env).many(`${sel} ORDER BY i.created_at DESC LIMIT 200`);
    return c.json({ inspections });
  });
  app.get('/api/admin/inspections/:id', adminMw, async (c) => {
    const db = d1(c.env);
    const id = c.req.param('id');
    const inspection = await db.one('SELECT * FROM inspections WHERE id = ?', id);
    if (!inspection) return c.json({ error: 'Inspection not found' }, 404);
    const items = await db.many('SELECT id, category, item, status, severity, notes FROM inspection_items WHERE inspection_id = ? ORDER BY id', id);
    const photos = await db.many('SELECT id, photo_path, caption, annotations, area, created_at FROM inspection_photos WHERE inspection_id = ? ORDER BY id', id);
    return c.json({ inspection, items, photos });
  });
  app.post('/api/admin/inspections', adminMw, async (c) => {
    const db = d1(c.env);
    const b = await c.req.json().catch(() => ({}));
    const me = await db.one('SELECT name FROM users WHERE id = ?', c.get('user').id);
    const inspectorName = (me && me.name) || b.inspector_name || null;
    const r = await db.run(
      `INSERT INTO inspections
         (inspector_id, inspector_name, kind, vehicle_year, vehicle_make, vehicle_model,
          vin, mileage, license_plate, customer_name, customer_phone, service_appointment_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      c.get('user').id, inspectorName, b.kind === 'service' ? 'service' : 'inspection',
      b.vehicle_year || null, b.vehicle_make || null, b.vehicle_model || null,
      (b.vin || '').toUpperCase() || null, b.mileage ? parseInt(b.mileage, 10) : null,
      b.license_plate || null, b.customer_name || null, b.customer_phone || null, b.service_appointment_id || null);
    const id = r.meta.last_row_id;
    for (const it of (Array.isArray(b.items) ? b.items : [])) {
      if (!it.category || !it.item) continue;
      await db.run('INSERT INTO inspection_items (inspection_id, category, item) VALUES (?,?,?)', id, it.category, it.item);
    }
    return c.json({ ok: true, id });
  });
  app.patch('/api/admin/inspections/:id', adminMw, async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const fields = ['status', 'overall_notes', 'vehicle_year', 'vehicle_make', 'vehicle_model', 'vin', 'mileage', 'license_plate', 'customer_name', 'customer_phone', 'completed_at'];
    const sets = []; const vals = [];
    for (const f of fields) if (b[f] !== undefined) { sets.push(`${f} = ?`); vals.push(b[f]); }
    if (!sets.length) return c.json({ error: 'Nothing to update' }, 400);
    vals.push(c.req.param('id'));
    await d1(c.env).run(`UPDATE inspections SET ${sets.join(', ')} WHERE id = ?`, ...vals);
    return c.json({ ok: true });
  });
  app.delete('/api/admin/inspections/:id', adminMw, async (c) => {
    await d1(c.env).run('DELETE FROM inspections WHERE id = ?', c.req.param('id'));
    return c.json({ ok: true });
  });
  app.patch('/api/admin/inspection-items/:id', adminMw, async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const sets = []; const vals = [];
    for (const f of ['status', 'severity', 'notes']) if (b[f] !== undefined) { sets.push(`${f} = ?`); vals.push(b[f]); }
    if (!sets.length) return c.json({ error: 'Nothing to update' }, 400);
    sets.push('updated_at = CURRENT_TIMESTAMP');
    vals.push(c.req.param('id'));
    await d1(c.env).run(`UPDATE inspection_items SET ${sets.join(', ')} WHERE id = ?`, ...vals);
    return c.json({ ok: true });
  });

  // ============ LABOR STANDARDS ============
  app.get('/api/admin/labor-standards', adminMw, async (c) => {
    const db = d1(c.env);
    const [vehicle_classes, rate_tiers, operations] = await Promise.all([
      db.many('SELECT code, name, labor_multiplier, description FROM vehicle_classes ORDER BY labor_multiplier ASC'),
      db.many('SELECT id, name, rate_cents / 100.0 AS rate_usd, description, is_default FROM labor_rate_tiers ORDER BY rate_cents ASC'),
      db.many("SELECT id, code, category, operation, base_hours, notes, source, is_active FROM labor_rates WHERE is_active = 1 ORDER BY category, code"),
    ]);
    return c.json({ vehicle_classes, rate_tiers: rate_tiers.map((r) => boolify(r, ['is_default'])), operations });
  });
  app.get('/api/admin/labor-estimate', adminMw, async (c) => {
    const db = d1(c.env);
    const code = (c.req.query('code') || '').trim();
    const klass = (c.req.query('class') || 'compact').trim();
    const tier = (c.req.query('tier') || 'Standard').trim();
    if (!code) return c.json({ error: 'code required' }, 400);
    const op = await db.one('SELECT * FROM labor_rates WHERE code = ?', code);
    if (!op) return c.json({ error: 'operation not found' }, 404);
    const vc = await db.one('SELECT labor_multiplier AS m FROM vehicle_classes WHERE code = ?', klass);
    const rt = await db.one('SELECT rate_cents / 100.0 AS r FROM labor_rate_tiers WHERE name = ?', tier);
    const mult = (vc && vc.m) || 1.0;
    const rate = (rt && rt.r) || 35.0;
    const hours = r2(Number(op.base_hours) * mult);
    return c.json({ operation: op, hours, rate_usd: rate, total_usd: r2(hours * rate), vehicle_class: klass, multiplier: mult, tier });
  });

  // ============ MAINTENANCE DUE ============
  app.get('/api/admin/maintenance-due', adminMw, async (c) => {
    const rows = await d1(c.env).many(`
      SELECT * FROM (
        SELECT COALESCE(NULLIF(vehicle_vin,''), NULLIF(license_plate,''), customer_phone) AS key,
               customer_name, customer_phone, vehicle_year, vehicle_make, vehicle_model,
               vehicle_vin, license_plate, mileage_in, intake_date, work_performed,
               ROW_NUMBER() OVER (PARTITION BY COALESCE(NULLIF(vehicle_vin,''), NULLIF(license_plate,''), customer_phone)
                                  ORDER BY intake_date DESC) AS rn
          FROM work_orders WHERE customer_phone IS NOT NULL
      ) WHERE rn = 1 AND (intake_date < datetime('now','-90 days') OR mileage_in IS NOT NULL)
      ORDER BY intake_date ASC LIMIT 200`);
    const today = Date.now();
    const dueList = rows.map((v) => {
      const daysSince = Math.floor((today - new Date(v.intake_date).getTime()) / 86400000);
      const estKm = v.mileage_in ? Number(v.mileage_in) + Math.round((daysSince / 30) * 1500) : null;
      const flags = [];
      if (daysSince >= 180) flags.push({ type: 'overdue_visit', label: `Haven't seen this customer in ${daysSince} days` });
      if (estKm) for (const [svc, interval] of Object.entries(MAINT_KM)) {
        const sinceLast = estKm - Number(v.mileage_in);
        if (sinceLast >= interval) flags.push({ type: 'mileage_due', label: `${svc} likely due (~${Math.round(sinceLast / 1000)}k km since last visit)` });
      }
      return { ...v, days_since: daysSince, est_current_km: estKm, flags };
    }).filter((v) => v.flags.length > 0);
    return c.json({ vehicles: dueList, count: dueList.length });
  });

  // ============ VEHICLE HISTORY ============
  app.get('/api/admin/vehicle-history', adminMw, async (c) => {
    const db = d1(c.env);
    const vin = (c.req.query('vin') || '').trim().toUpperCase();
    const plate = (c.req.query('plate') || '').trim().toUpperCase();
    if (!vin && !plate) return c.json({ error: 'vin or plate required' }, 400);
    const conds = []; const binds = [];
    if (vin) { conds.push('UPPER(vehicle_vin) = ?'); binds.push(vin); }
    if (plate) { conds.push('UPPER(license_plate) = ?'); binds.push(plate); }
    const where = conds.join(' OR ');
    const wos = await db.many(
      `SELECT id, wo_number, customer_name, customer_phone, vehicle_year, vehicle_make, vehicle_model,
              vehicle_vin, license_plate, status, complaint, work_performed,
              total_cents / 100.0 AS total_usd, intake_date, completed_at, paid_at, mileage_in
         FROM work_orders WHERE ${where} ORDER BY intake_date DESC LIMIT 100`, ...binds);
    const keyList = [vin, plate].filter(Boolean);
    const insCl = inClause('UPPER(vin)', keyList);
    const insps = await db.many(
      `SELECT id, kind, vehicle_year, vehicle_make, vehicle_model, vin, mileage, status, inspector_name, overall_notes, created_at, completed_at
         FROM inspections WHERE ${insCl.sql} ORDER BY created_at DESC LIMIT 50`, ...insCl.binds);
    const phones = [...new Set(wos.map((w) => w.customer_phone).filter(Boolean))];
    let appts = [];
    if (phones.length) {
      const pc = inClause('phone', phones);
      appts = await db.many(
        `SELECT id, name, phone, vehicle_year, vehicle_make, vehicle_model, service_type, preferred_date, time_slot, status, created_at
           FROM service_appointments WHERE ${pc.sql} ORDER BY preferred_date DESC, created_at DESC LIMIT 50`, ...pc.binds);
    }
    const s = wos[0] || null;
    return c.json({
      vehicle: s ? { year: s.vehicle_year, make: s.vehicle_make, model: s.vehicle_model, vin: s.vehicle_vin, plate: s.license_plate } : null,
      work_orders: wos, appointments: appts, inspections: insps,
    });
  });
}
