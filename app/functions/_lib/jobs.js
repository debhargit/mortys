// Phase 8 — scheduled jobs. server.js ran these off setInterval on the box
// that owned the database; a Worker has no long-lived process, so they run
// from HTTP (functions/_routes/cron.js) triggered by the companion
// cron-worker's Cron Triggers (see cron-worker/).
//
// Each job is idempotent and self-throttling: digests write a
// "last sent on YYYY-MM-DD" marker into app_config so re-running the same day
// is a no-op. Every run is logged to job_runs.
import { d1 } from './db.js';
import { sendEmail, templates } from './mailer.js';

const today = () => new Date().toISOString().slice(0, 10);

async function getCfg(db, key) {
  const r = await db.one('SELECT value FROM app_config WHERE key = ?', key);
  return r ? r.value : null;
}
async function setCfg(db, key, value) {
  await db.run(
    `INSERT INTO app_config (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value);
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function digestHtml(title, intro, rows) {
  return `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#0f1720;font-size:14px;line-height:1.5">
    <h2 style="margin:0 0 6px">${esc(title)}</h2>
    <p style="margin:0 0 12px;color:#475569">${esc(intro)}</p>
    <table cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:13px">${rows}</table>
    <p style="margin:14px 0 0;color:#94a3b8;font-size:12px">Sent by the Meltha Honda scheduled jobs.</p>
  </body></html>`;
}

// ---- back in stock: email everyone waiting on a now-in-stock part ---------
export async function notifyBackInStock(env) {
  const db = d1(env);
  const subs = await db.many(
    `SELECT n.id, n.email, n.phone, p.img AS product_img, p.name AS product_name,
            p.price_cents / 100.0 AS price_usd
       FROM notify_subscriptions n
       JOIN products p ON p.img = n.product_img
      WHERE n.notified_at IS NULL AND p.stock_count > 0`);
  let emails_sent = 0, failed = 0;
  for (const sub of subs) {
    try {
      const t = templates.backInStockEmail(sub);
      await sendEmail(env, { to: sub.email, ...t });
      await db.run('UPDATE notify_subscriptions SET notified_at = CURRENT_TIMESTAMP WHERE id = ?', sub.id);
      emails_sent++;
    } catch (e) {
      failed++;
      console.warn('[jobs:back-in-stock]', sub.email, e.message);
    }
  }
  return { candidates: subs.length, emails_sent, failed };
}

// ---- reminders digest: one mail to the shop when follow-ups are due ------
export async function remindersDigest(env) {
  const db = d1(env);
  const to = env && env.ORDER_NOTIFY_TO;
  const due = await db.many(
    `SELECT cr.id, cr.due_date, cr.subject, cr.body,
            u.name AS customer_name, u.phone AS customer_phone,
            m.name AS assignee_name
       FROM customer_reminders cr
       LEFT JOIN users u ON u.id = cr.user_id
       LEFT JOIN mechanics m ON m.id = cr.assigned_to
      WHERE cr.status = 'pending' AND cr.due_date <= date('now')
      ORDER BY cr.due_date ASC LIMIT 200`);
  if (!due.length) return { due: 0, emailed: false };

  const marker = 'job:reminders-digest:last_date';
  if ((await getCfg(db, marker)) === today() && !(env && env.CRON_FORCE))
    return { due: due.length, emailed: false, reason: 'already sent today' };

  if (to) {
    const rows = due.map((r) =>
      `<tr style="border-top:1px solid #e2e8f0">
         <td><b>${esc(r.due_date)}</b></td>
         <td>${esc(r.customer_name || '—')}${r.customer_phone ? ' · ' + esc(r.customer_phone) : ''}</td>
         <td>${esc(r.subject)}</td>
         <td style="color:#64748b">${esc(r.assignee_name || '')}</td>
       </tr>`).join('');
    await sendEmail(env, {
      to,
      subject: `${due.length} customer reminder${due.length === 1 ? '' : 's'} due — Meltha Honda`,
      text: due.map((r) => `${r.due_date}  ${r.customer_name || '—'}  ${r.subject}`).join('\n'),
      html: digestHtml('Customer reminders due', `${due.length} follow-up${due.length === 1 ? '' : 's'} pending as of ${today()}.`, rows),
    });
  }
  await setCfg(db, marker, today());
  return { due: due.length, emailed: !!to };
}

// ---- low-stock digest: one mail to the shop, once a day ------------------
export async function lowStockDigest(env) {
  const db = d1(env);
  const to = env && env.ORDER_NOTIFY_TO;
  const low = await db.many(
    `SELECT img, name, make_model, category, stock_count, low_threshold,
            price_cents / 100.0 AS price_usd
       FROM products
      WHERE is_active = 1 AND stock_count <= low_threshold
      ORDER BY (stock_count <= 0) DESC, stock_count ASC, name ASC LIMIT 200`);
  if (!low.length) return { low: 0, emailed: false };

  const marker = 'job:low-stock-digest:last_date';
  if ((await getCfg(db, marker)) === today() && !(env && env.CRON_FORCE))
    return { low: low.length, emailed: false, reason: 'already sent today' };

  const out = low.filter((r) => r.stock_count <= 0).length;
  if (to) {
    const rows = low.map((r) =>
      `<tr style="border-top:1px solid #e2e8f0">
         <td><b style="color:${r.stock_count <= 0 ? '#b91c1c' : '#b45309'}">${r.stock_count}</b> / ${r.low_threshold}</td>
         <td>${esc(r.name)}</td>
         <td style="color:#64748b">${esc(r.make_model || '')}</td>
         <td style="color:#64748b">${esc(r.category || '')}</td>
       </tr>`).join('');
    await sendEmail(env, {
      to,
      subject: `${low.length} part${low.length === 1 ? '' : 's'} at or below reorder level${out ? ` (${out} out of stock)` : ''} — Meltha Honda`,
      text: low.map((r) => `${r.stock_count}/${r.low_threshold}  ${r.name}  ${r.make_model || ''}`).join('\n'),
      html: digestHtml('Low stock', `${low.length} active part${low.length === 1 ? '' : 's'} at or below the reorder level as of ${today()}${out ? `, ${out} of them out of stock` : ''}.`, rows),
    });
  }
  await setCfg(db, marker, today());
  return { low: low.length, out_of_stock: out, emailed: !!to };
}

export const JOBS = {
  'back-in-stock': notifyBackInStock,
  'reminders-digest': remindersDigest,
  'low-stock-digest': lowStockDigest,
};

// Run one job by name, logging the outcome to job_runs. Throws for an unknown
// name; never throws for a job that itself fails — the failure is logged and
// returned so the caller (and cron-worker) can see it.
export async function runJob(env, name) {
  const fn = JOBS[name];
  if (!fn) { const e = new Error('Unknown job: ' + name); e.status = 404; throw e; }
  const db = d1(env);
  const started = Date.now();
  try {
    const result = await fn(env);
    await db.run('INSERT INTO job_runs (job, ok, detail, ms) VALUES (?, 1, ?, ?)',
      name, JSON.stringify(result), Date.now() - started).catch(() => {});
    return { ok: true, job: name, ms: Date.now() - started, result };
  } catch (e) {
    await db.run('INSERT INTO job_runs (job, ok, detail, ms) VALUES (?, 0, ?, ?)',
      name, JSON.stringify({ error: e.message }), Date.now() - started).catch(() => {});
    return { ok: false, job: name, ms: Date.now() - started, error: e.message };
  }
}

export async function runAllJobs(env) {
  const out = {};
  for (const name of Object.keys(JOBS)) out[name] = await runJob(env, name);
  return out;
}
