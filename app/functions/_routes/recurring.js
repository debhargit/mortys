// Recurring charges — admin CRUD for the plans the scheduled job
// (_lib/recurring.js:generateRecurringCharges, registered in _lib/jobs.js as
// 'recurring-charges') bills automatically. See migrations/0050.
//   GET/POST /api/admin/recurring-plans        PATCH /api/admin/recurring-plans/:id
//   GET      /api/admin/recurring-plans/:id    POST  /api/admin/recurring-plans/:id/run-now
import { d1 } from '../_lib/db.js';
import { adminMw, managerMw } from '../_lib/guards.js';
import { boolify } from '../_lib/util.js';
import { runOnePlan } from '../_lib/recurring.js';

const FREQUENCIES = ['weekly', 'monthly', 'quarterly', 'yearly'];
const TARGETS = ['order', 'pos_account_sale'];

function validItems(raw) {
  if (!Array.isArray(raw) || !raw.length) return null;
  const items = [];
  for (const it of raw) {
    const qty = parseInt(it.qty, 10) || 1;
    const price = Number(it.unit_price_usd);
    if (!it.description || !Number.isFinite(price) || price < 0) return null;
    items.push({ description: String(it.description).slice(0, 200), qty, unit_price_usd: price, product_img: it.product_img || null });
  }
  return items;
}

export default function mount(app) {
  app.get('/api/admin/recurring-plans', adminMw, async (c) => {
    const rows = await d1(c.env).many(
      `SELECT p.id, p.customer_id, p.target, p.description, p.items_json, p.frequency,
              p.next_run_date, p.end_date, p.occurrences_left, p.is_active, p.notes, p.created_at,
              u.name AS customer_name, u.email AS customer_email
         FROM recurring_plans p LEFT JOIN users u ON u.id = p.customer_id
        ORDER BY p.is_active DESC, p.next_run_date ASC`);
    for (const r of rows) {
      boolify(r, ['is_active']);
      try { r.items = JSON.parse(r.items_json); } catch { r.items = []; }
      r.amount_usd = r.items.reduce((s, it) => s + Number(it.unit_price_usd || 0) * Number(it.qty || 1), 0);
      delete r.items_json;
    }
    return c.json({ plans: rows });
  });

  app.post('/api/admin/recurring-plans', managerMw, async (c) => {
    const db = d1(c.env);
    const me = c.get('user');
    const b = await c.req.json().catch(() => ({}));
    if (!b.customer_id) return c.json({ error: 'customer_id is required' }, 400);
    const customer = await db.one('SELECT id FROM users WHERE id = ?', b.customer_id);
    if (!customer) return c.json({ error: 'Customer not found' }, 404);
    if (!TARGETS.includes(b.target)) return c.json({ error: 'target must be order or pos_account_sale' }, 400);
    if (!FREQUENCIES.includes(b.frequency)) return c.json({ error: 'frequency must be weekly, monthly, quarterly, or yearly' }, 400);
    if (!String(b.description || '').trim()) return c.json({ error: 'A description is required' }, 400);
    const items = validItems(b.items);
    if (!items) return c.json({ error: 'At least one valid line item (description, unit_price_usd) is required' }, 400);
    const nextRunDate = b.next_run_date && !isNaN(Date.parse(b.next_run_date))
      ? new Date(b.next_run_date).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10);
    const r = await db.run(
      `INSERT INTO recurring_plans
         (customer_id, target, description, items_json, frequency, next_run_date, end_date, occurrences_left, notes, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      b.customer_id, b.target, String(b.description).trim().slice(0, 300), JSON.stringify(items), b.frequency, nextRunDate,
      b.end_date || null, b.occurrences_left ? parseInt(b.occurrences_left, 10) : null, b.notes || null, me.id
    );
    return c.json({ ok: true, id: r.meta.last_row_id });
  });

  app.get('/api/admin/recurring-plans/:id', adminMw, async (c) => {
    const db = d1(c.env);
    const id = c.req.param('id');
    const plan = await db.one(
      `SELECT p.*, u.name AS customer_name, u.email AS customer_email
         FROM recurring_plans p LEFT JOIN users u ON u.id = p.customer_id WHERE p.id = ?`, id);
    if (!plan) return c.json({ error: 'Not found' }, 404);
    boolify(plan, ['is_active']);
    try { plan.items = JSON.parse(plan.items_json); } catch { plan.items = []; }
    delete plan.items_json;
    const runs = await db.many('SELECT * FROM recurring_plan_runs WHERE plan_id = ? ORDER BY created_at DESC LIMIT 100', id);
    return c.json({ plan, runs });
  });

  app.patch('/api/admin/recurring-plans/:id', managerMw, async (c) => {
    const db = d1(c.env);
    const id = c.req.param('id');
    const b = await c.req.json().catch(() => ({}));
    const sets = []; const vals = [];
    if (b.is_active != null) { sets.push('is_active = ?'); vals.push(b.is_active ? 1 : 0); }
    if (b.description !== undefined) { sets.push('description = ?'); vals.push(String(b.description).trim().slice(0, 300)); }
    if (b.next_run_date !== undefined) { sets.push('next_run_date = ?'); vals.push(b.next_run_date); }
    if (b.end_date !== undefined) { sets.push('end_date = ?'); vals.push(b.end_date || null); }
    if (b.occurrences_left !== undefined) { sets.push('occurrences_left = ?'); vals.push(b.occurrences_left === '' || b.occurrences_left == null ? null : parseInt(b.occurrences_left, 10)); }
    if (b.notes !== undefined) { sets.push('notes = ?'); vals.push(b.notes || null); }
    if (b.items !== undefined) {
      const items = validItems(b.items);
      if (!items) return c.json({ error: 'At least one valid line item is required' }, 400);
      sets.push('items_json = ?'); vals.push(JSON.stringify(items));
    }
    if (!sets.length) return c.json({ error: 'No fields to update' }, 400);
    vals.push(id);
    await db.run(`UPDATE recurring_plans SET ${sets.join(', ')} WHERE id = ?`, ...vals);
    return c.json({ ok: true });
  });

  app.post('/api/admin/recurring-plans/:id/run-now', managerMw, async (c) => {
    const db = d1(c.env);
    const id = c.req.param('id');
    const plan = await db.one('SELECT * FROM recurring_plans WHERE id = ?', id);
    if (!plan) return c.json({ error: 'Not found' }, 404);
    const r = await runOnePlan(c.env, plan);
    return c.json(r, r.status === 'ok' ? 200 : 500);
  });
}
