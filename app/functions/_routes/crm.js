// Phase 8 — customer reminder CRUD (the data the reminders-digest job reads).
// Ports server.js:
//   GET    /api/admin/users/:id/reminders
//   POST   /api/admin/users/:id/reminders
//   PATCH  /api/admin/reminders/:id
//   DELETE /api/admin/reminders/:id
//   GET    /api/admin/reminders/due
import { d1 } from '../_lib/db.js';
import { adminMw } from '../_lib/guards.js';

export default function mount(app) {
  app.get('/api/admin/users/:id/reminders', adminMw, async (c) => {
    const reminders = await d1(c.env).many(
      `SELECT cr.*, m.name AS assignee_name
         FROM customer_reminders cr
         LEFT JOIN mechanics m ON m.id = cr.assigned_to
        WHERE cr.user_id = ?
        ORDER BY cr.status ASC, cr.due_date ASC`, c.req.param('id'));
    return c.json({ reminders });
  });

  app.post('/api/admin/users/:id/reminders', adminMw, async (c) => {
    const b = await c.req.json().catch(() => ({}));
    if (!b.subject || !b.due_date) return c.json({ error: 'subject and due_date required' }, 400);
    const r = await d1(c.env).run(
      `INSERT INTO customer_reminders (user_id, due_date, subject, body, assigned_to, created_by)
         VALUES (?,?,?,?,?,?)`,
      c.req.param('id'), b.due_date, b.subject, b.body || null,
      b.assigned_to || null, c.get('user').id);
    return c.json({ ok: true, id: r.meta ? r.meta.last_row_id : undefined });
  });

  app.patch('/api/admin/reminders/:id', adminMw, async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const fields = ['due_date', 'subject', 'body', 'assigned_to', 'status'];
    const sets = []; const vals = [];
    for (const f of fields) if (b[f] !== undefined) { sets.push(`${f} = ?`); vals.push(b[f]); }
    if (!sets.length) return c.json({ error: 'Nothing to update' }, 400);
    if (b.status === 'done') sets.push('done_at = CURRENT_TIMESTAMP');
    vals.push(c.req.param('id'));
    await d1(c.env).run(`UPDATE customer_reminders SET ${sets.join(', ')} WHERE id = ?`, ...vals);
    return c.json({ ok: true });
  });

  app.delete('/api/admin/reminders/:id', adminMw, async (c) => {
    await d1(c.env).run('DELETE FROM customer_reminders WHERE id = ?', c.req.param('id'));
    return c.json({ ok: true });
  });

  app.get('/api/admin/reminders/due', adminMw, async (c) => {
    const reminders = await d1(c.env).many(
      `SELECT cr.*, u.name AS customer_name, u.phone AS customer_phone, m.name AS assignee_name
         FROM customer_reminders cr
         LEFT JOIN users u ON u.id = cr.user_id
         LEFT JOIN mechanics m ON m.id = cr.assigned_to
        WHERE cr.status = 'pending' AND cr.due_date <= date('now')
        ORDER BY cr.due_date ASC LIMIT 100`);
    return c.json({ reminders });
  });
}
