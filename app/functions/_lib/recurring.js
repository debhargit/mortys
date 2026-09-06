// Recurring charges: a plan generates a real charge on a schedule, targeting
// either a storefront order (invoiced by email) or a POS account sale. Runs
// through the same scheduled-job engine as every other digest (JOBS in this
// directory's jobs.js, hit via /api/cron/:job) -- no new scheduling
// infrastructure, just a new job. See migrations/0050.
import { d1 } from './db.js';
import { nextId } from './pos.js';
import { createPosSale } from '../_routes/pos_txn.js';
import { orderInsertStmt } from '../_routes/customer.js';
import { sendEmail, templates } from './mailer.js';

const today = () => new Date().toISOString().slice(0, 10);
const SITE_BASE = 'https://mortsautoparts.com';

export function advanceDate(dateStr, frequency) {
  const d = new Date(dateStr + 'T00:00:00Z');
  if (frequency === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
  else if (frequency === 'monthly') d.setUTCMonth(d.getUTCMonth() + 1);
  else if (frequency === 'quarterly') d.setUTCMonth(d.getUTCMonth() + 3);
  else if (frequency === 'yearly') d.setUTCFullYear(d.getUTCFullYear() + 1);
  else throw new Error('Unknown frequency: ' + frequency);
  return d.toISOString().slice(0, 10);
}

function parseItems(itemsJson) {
  try {
    const items = JSON.parse(itemsJson);
    return Array.isArray(items) ? items : [];
  } catch { return []; }
}

async function runOrderPlan(env, plan, items) {
  const db = d1(env);
  const customer = await db.one('SELECT id, name, email FROM users WHERE id = ?', plan.customer_id);
  if (!customer) throw new Error('Customer not found');
  const total = Math.round(items.reduce((s, it) => s + Number(it.unit_price_usd || 0) * Number(it.qty || 1), 0) * 100) / 100;
  const orderId = await nextId(env, 'orders');
  const stmts = [orderInsertStmt(orderId, {
    user_id: plan.customer_id, total_cents: Math.round(total * 100),
    status: 'confirmed', notes: 'Recurring: ' + plan.description,
    payment_method: 'invoice_email', payment_status: 'unpaid', source: 'recurring',
  })];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    // order_items.product_img is NOT NULL with no FK to products -- a
    // recurring line doesn't have to name a real stocked part (e.g. "Late
    // fee"), so fall back to a synthetic, unique-enough key rather than
    // requiring one.
    stmts.push({
      sql: 'INSERT INTO order_items (order_id, product_img, qty, price_cents) VALUES (?,?,?,?)',
      binds: [orderId, it.product_img || `recurring-${orderId}-${i}`, Number(it.qty) || 1, Math.round(Number(it.unit_price_usd || 0) * 100)],
    });
  }
  await db.batch(stmts);
  if (customer.email) {
    const li = items.map((it) => ({ product_img: it.product_img || null, qty: it.qty, price_usd: it.unit_price_usd, name: it.description }));
    const t = templates.invoiceEmail({ name: customer.name, orderId, items: li, total, payUrl: `${SITE_BASE}/order-print.html?order=${orderId}` });
    await sendEmail(env, { to: customer.email, ...t }).catch(() => {});
  }
  return { order_id: orderId };
}

async function runPosAccountSalePlan(env, plan, items) {
  const posItems = items.map((it) => ({
    product_img: it.product_img || null, description: it.description,
    qty: Number(it.qty) || 1, unit_price_usd: Number(it.unit_price_usd) || 0, discount_usd: 0,
  }));
  // A synthetic actor with owner-level rights -- this is a scheduled business
  // rule the admin already set up by creating the plan, not a live cashier
  // who might be missing a permission; created_by still identifies who's
  // accountable for it on the resulting sale row.
  const actingUser = { id: plan.created_by || null, is_admin: 1, admin_role: 'owner' };
  // amount_usd left null so createPosSale auto-fills it to the actual total
  // (goods + tax) -- the plan's line items are pre-tax, same as any other
  // POS cart.
  return createPosSale(env, {
    items: posItems,
    payments: [{ method: 'account', amount_usd: null }],
    customer_id: plan.customer_id,
    notes: 'Recurring: ' + plan.description,
  }, actingUser);
}

// Run one plan's charge, record the outcome, and advance its schedule --
// shared by the scheduled job (below) and a manual "run now" trigger. Never
// throws: a failed charge (e.g. the customer has no payment terms set up)
// is recorded on the plan's run history rather than wedging the plan
// retrying the same date forever.
export async function runOnePlan(env, plan) {
  const db = d1(env);
  const items = parseItems(plan.items_json);
  let status = 'ok', error = null, orderId = null, saleId = null;
  try {
    if (!items.length) throw new Error('This plan has no line items');
    if (plan.target === 'order') {
      const r = await runOrderPlan(env, plan, items);
      orderId = r.order_id;
    } else {
      const r = await runPosAccountSalePlan(env, plan, items);
      if (r.status !== 200) throw new Error(r.body.error || 'Sale failed');
      saleId = r.body.id;
    }
  } catch (e) {
    status = 'failed'; error = e.message;
  }
  await db.run(
    'INSERT INTO recurring_plan_runs (plan_id, run_date, order_id, sale_id, status, error) VALUES (?,?,?,?,?,?)',
    plan.id, today(), orderId, saleId, status, error
  );

  const nextDate = advanceDate(plan.next_run_date, plan.frequency);
  let occLeft = plan.occurrences_left;
  let active = 1;
  if (occLeft != null) { occLeft = occLeft - 1; if (occLeft <= 0) active = 0; }
  if (plan.end_date && nextDate > plan.end_date) active = 0;
  await db.run('UPDATE recurring_plans SET next_run_date = ?, occurrences_left = ?, is_active = ? WHERE id = ?',
    nextDate, occLeft, active, plan.id);

  return { status, error, order_id: orderId, sale_id: saleId, next_run_date: nextDate, is_active: !!active };
}

export async function generateRecurringCharges(env) {
  const db = d1(env);
  const due = await db.many('SELECT * FROM recurring_plans WHERE is_active = 1 AND next_run_date <= ?', today());
  let ran = 0, failed = 0;
  for (const plan of due) {
    const r = await runOnePlan(env, plan);
    if (r.status === 'ok') ran++; else failed++;
  }
  return { due: due.length, ran, failed };
}
