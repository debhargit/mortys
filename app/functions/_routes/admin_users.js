// Phase 12 — users / staff / roles / categories admin. Ports server.js:
//   GET/POST/PATCH/DELETE /api/admin/users[/:id]  + /:id/{role,perms,messages,
//     notifications,account-payments}
//   POST /api/admin/points/:userId
//   POST /api/admin/me/ui-prefs
//   POST/PATCH /api/admin/staff[/:id]  + /:id/{password,pin,pin/reset}  + /staff/pin-verify
//   POST/PATCH/DELETE /api/admin/roles[/:code]
//   POST/PATCH/DELETE /api/admin/user-categories[/:id]  + /:id/perms
import bcrypt from 'bcryptjs';
import { d1 } from '../_lib/db.js';
import { adminMw, managerMw } from '../_lib/guards.js';
import { CAPABILITY_KEYS } from '../_lib/capabilities.js';
import { safeJson, boolify } from '../_lib/util.js';
import { userPermState, roleExists, roleCanManage } from '../_lib/perms.js';

const cents = (u) => Math.round((Number(u) || 0) * 100);
const bit = (v) => (v ? 1 : 0);
const PIN_MIN = 4, PIN_MAX = 8;
const slug = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

const actingRole = (c) => (c.get('user') || {}).admin_role || null;
const actingId = (c) => (c.get('user') || {}).id;

function mechanicsRoleFor(codes) {
  const wrench = codes.includes('mechanic');
  const counter = codes.includes('service_advisor') || codes.includes('sales_rep');
  if (wrench && counter) return 'both';
  if (wrench) return 'mechanic';
  if (counter) return 'advisor';
  return null;
}

async function staffCodes(db, userId) {
  const rows = await db.many(
    `SELECT c.code FROM user_category_members m
       JOIN user_categories c ON c.id = m.category_id AND c.is_active = 1
      WHERE m.user_id = ?`, userId);
  return rows.map((r) => r.code);
}

async function syncStaffProfile(db, userId) {
  const u = await db.one('SELECT id, name, email, phone, is_staff FROM users WHERE id = ?', userId);
  if (!u) return;
  const role = u.is_staff ? mechanicsRoleFor(await staffCodes(db, userId)) : null;
  const existing = await db.one('SELECT id FROM mechanics WHERE user_id = ? LIMIT 1', userId);
  if (!role) {
    if (existing) await db.run('UPDATE mechanics SET is_active = 0 WHERE id = ?', existing.id);
    return;
  }
  if (existing) {
    await db.run('UPDATE mechanics SET name = ?, email = ?, phone = ?, role = ?, is_active = 1 WHERE id = ?',
      u.name || u.email, u.email, u.phone, role, existing.id);
  } else {
    await db.run(
      'INSERT INTO mechanics (user_id, name, email, phone, role, hourly_rate_cents, is_active) VALUES (?,?,?,?,?,0,1)',
      userId, u.name || u.email, u.email, u.phone, role);
  }
}

async function setUserCategories(db, userId, ids) {
  await db.run('DELETE FROM user_category_members WHERE user_id = ?', userId);
  const clean = (Array.isArray(ids) ? ids : []).map((n) => parseInt(n, 10)).filter(Number.isFinite);
  for (const cid of clean) {
    await db.run('INSERT OR IGNORE INTO user_category_members (user_id, category_id) VALUES (?, ?)', userId, cid);
  }
}

async function pinCollides(db, pin, exceptId) {
  const rows = await db.many('SELECT pin_hash FROM users WHERE pin_hash IS NOT NULL AND id <> ?', exceptId || 0);
  for (const r of rows) if (await bcrypt.compare(pin, r.pin_hash)) return true;
  return false;
}
async function validateAndHashPin(db, pin, exceptId) {
  const clean = String(pin == null ? '' : pin).trim();
  if (!/^[0-9]+$/.test(clean) || clean.length < PIN_MIN || clean.length > PIN_MAX) {
    const e = new Error(`PIN must be ${PIN_MIN} to ${PIN_MAX} digits`); e.userFacing = true; throw e;
  }
  if (await pinCollides(db, clean, exceptId)) {
    const e = new Error('Another staff member already uses that PIN.'); e.userFacing = true; throw e;
  }
  return bcrypt.hash(clean, 10);
}

async function accountBalance(db, customerId) {
  const r = await db.one(
    `SELECT
       COALESCE((SELECT SUM(sp.amount_cents) FROM sale_payments sp JOIN pos_sales s ON s.id = sp.sale_id
                  WHERE sp.method = 'account' AND s.customer_id = ? AND s.voided = 0), 0)
     - COALESCE((SELECT SUM(amount_cents) FROM account_payments WHERE customer_id = ?), 0) AS bal_cents`,
    customerId, customerId);
  return ((r && r.bal_cents) || 0) / 100;
}
async function pointsBalance(db, userId) {
  const r = await db.one('SELECT COALESCE(SUM(delta),0) AS b FROM points_transactions WHERE user_id = ?', userId);
  return (r && r.b) || 0;
}

// PIN brute-force throttle (per isolate; a soft gate — see server.js note).
const PIN_ATTEMPTS = new Map();
const PIN_MAX_TRIES = 10, PIN_LOCK_MS = 60000;

export default function mount(app) {
  // ============ CUSTOMERS ============
  app.get('/api/admin/users', adminMw, async (c) => {
    const db = d1(c.env);
    const q = (c.req.query('q') || '').toLowerCase().trim();
    const origin = String(c.req.query('origin') || '').toLowerCase();
    const type = String(c.req.query('customer_type') || '').trim();
    const cl = []; const vals = [];
    if (q) {
      const like = '%' + q + '%';
      vals.push(like, like, like, like, like);
      cl.push(`(lower(u.email) LIKE ? OR lower(coalesce(u.name,'')) LIKE ? OR coalesce(u.phone,'') LIKE ? OR lower(coalesce(u.company_name,'')) LIKE ? OR lower(coalesce(u.account_number,'')) LIKE ?)`);
    }
    if (type) { cl.push('u.customer_type = ?'); vals.push(type); }
    if (origin === 'archived') cl.push('u.is_archived = 1');
    else if (origin === 'staff') cl.push('(u.is_staff = 1 OR u.is_admin = 1)');
    else {
      cl.push('u.is_archived = 0', 'u.is_staff = 0 AND u.is_admin = 0');
      if (origin === 'online') cl.push("(u.via IS NULL OR u.via NOT IN ('pos','local'))");
      else if (origin === 'counter') cl.push("u.via = 'pos'");
    }
    const where = cl.length ? cl.join(' AND ') : '1=1';
    const users = await db.many(
      `SELECT u.id, u.email, u.name, u.phone, u.is_admin, u.is_staff, u.created_at,
              u.via, u.company_name, u.customer_type, u.account_number,
              u.credit_limit_cents / 100.0 AS credit_limit_usd, u.credit_type,
              (SELECT COUNT(*) FROM orders WHERE user_id = u.id) AS orders,
              (SELECT COALESCE(SUM(total_cents),0) / 100.0 FROM orders WHERE user_id = u.id) AS lifetime_usd,
              COALESCE((SELECT balance FROM user_points WHERE user_id = u.id), 0) AS points
         FROM users u WHERE ${where} ORDER BY u.created_at DESC LIMIT 100`, ...vals);
    const counts = await db.one(
      `SELECT
         SUM(CASE WHEN is_staff = 0 AND is_admin = 0 AND is_archived = 0 AND (via IS NULL OR via NOT IN ('pos','local')) THEN 1 ELSE 0 END) AS online,
         SUM(CASE WHEN is_staff = 0 AND is_admin = 0 AND is_archived = 0 AND via = 'pos' THEN 1 ELSE 0 END) AS counter,
         SUM(CASE WHEN is_staff = 1 OR is_admin = 1 THEN 1 ELSE 0 END) AS staff,
         SUM(CASE WHEN is_archived = 1 THEN 1 ELSE 0 END) AS archived
       FROM users`);
    return c.json({ users: users.map((r) => boolify(r, ['is_admin', 'is_staff'])), counts });
  });

  app.get('/api/admin/users/:id', adminMw, async (c) => {
    const db = d1(c.env);
    const id = c.req.param('id');
    const u = await db.one(
      `SELECT id, email, name, phone, is_admin, created_at, account_number, company_name, customer_type, tax_id,
              credit_limit_cents / 100.0 AS credit_limit_usd, discount_pct, price_tier, sales_rep_id, how_heard, rating,
              internal_notes, email_opt_in, sms_opt_in, preferred_contact, payment_terms_days,
              discount_limit_pct, tax_exempt, credit_type, credit_length_months, is_staff, via, admin_role, perms,
              COALESCE(show_prices, 0) AS show_prices
         FROM users WHERE id = ?`, id);
    if (!u) return c.json({ error: 'Not found' }, 404);
    const [orders, inquiries, appointments] = await Promise.all([
      db.many(`SELECT id, total_cents / 100.0 AS total_usd, status, payment_method, payment_status, created_at
                 FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`, id),
      db.many(`SELECT id, vehicle_make, vehicle_model, part_description, status, created_at
                 FROM parts_inquiries WHERE user_id = ? ORDER BY created_at DESC LIMIT 30`, id),
      db.many(`SELECT id, service_type, preferred_date, time_slot, status, created_at
                 FROM service_appointments WHERE user_id = ? ORDER BY created_at DESC LIMIT 30`, id),
    ]);
    return c.json({
      user: u, orders, inquiries, appointments,
      points_balance: await pointsBalance(db, id),
      account_balance_usd: await accountBalance(db, id),
    });
  });

  app.post('/api/admin/users', adminMw, async (c) => {
    const db = d1(c.env);
    const b = await c.req.json().catch(() => ({}));
    const name = String(b.name || '').trim();
    if (!name) return c.json({ error: 'Name is required' }, 400);
    let acctNo = b.account_number ? String(b.account_number).trim() : null;
    if (!acctNo) {
      const rows = await db.many("SELECT account_number AS a FROM users WHERE account_number LIKE 'C-%'");
      let mx = 0; for (const r of rows) { const m = String(r.a || '').match(/(\d+)\s*$/); if (m) mx = Math.max(mx, +m[1]); }
      acctNo = 'C-' + String(mx + 1).padStart(6, '0');
    }
    const email = String(b.email || '').trim().toLowerCase() || `${acctNo.toLowerCase()}@walkin.melthahonda.local`;
    if (await db.one('SELECT id FROM users WHERE lower(email) = lower(?) OR account_number = ?', email, acctNo))
      return c.json({ error: 'A customer with that email or account number already exists' }, 409);
    const hash = await bcrypt.hash(crypto.randomUUID(), 10);
    const r = await db.run(
      `INSERT INTO users (email, name, password_hash, phone, via, is_admin, is_staff, price_tier, account_number,
                          company_name, customer_type, credit_type, credit_limit_cents, credit_length_months,
                          payment_terms_days, discount_pct, tax_exempt, tax_id, internal_notes)
         VALUES (lower(?),?,?,?, 'pos', 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      email, name, hash, b.phone || null,
      ['retail', 'trade', 'fleet', 'dealer'].includes(b.price_tier) ? b.price_tier : 'retail',
      acctNo, b.company_name || null, b.customer_type || null, b.credit_type || null,
      b.credit_limit_usd != null ? cents(b.credit_limit_usd) : null, b.credit_length_months || null,
      b.payment_terms_days || null, b.discount_pct || null, bit(b.tax_exempt), b.tax_id || null, b.internal_notes || null);
    const customer = await db.one('SELECT id, email, name, phone, account_number FROM users WHERE id = ?', r.meta.last_row_id);
    return c.json({ ok: true, customer });
  });

  app.patch('/api/admin/users/:id', adminMw, async (c) => {
    const db = d1(c.env);
    const b = await c.req.json().catch(() => ({}));
    const MAP = { name: 0, phone: 0, company_name: 0, customer_type: 0, tax_id: 0, discount_pct: 0, price_tier: 0,
      sales_rep_id: 0, how_heard: 0, rating: 0, internal_notes: 0, email_opt_in: 1, sms_opt_in: 1, preferred_contact: 0,
      payment_terms_days: 0, discount_limit_pct: 0, tax_exempt: 1, credit_type: 0, credit_length_months: 0,
      account_number: 0, is_archived: 1, show_prices: 1 };
    const sets = []; const vals = [];
    for (const [f, isBool] of Object.entries(MAP)) {
      if (b[f] === undefined) continue;
      sets.push(`${f} = ?`); vals.push(isBool ? bit(b[f]) : b[f]);
    }
    if (b.credit_limit_usd !== undefined) { sets.push('credit_limit_cents = ?'); vals.push(b.credit_limit_usd === '' ? null : cents(b.credit_limit_usd)); }
    if (!sets.length) return c.json({ error: 'Nothing to update' }, 400);
    vals.push(c.req.param('id'));
    await db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, ...vals);
    return c.json({ ok: true });
  });

  app.delete('/api/admin/users/:id', managerMw, async (c) => {
    const db = d1(c.env);
    const id = parseInt(c.req.param('id'), 10);
    const u = await db.one('SELECT id, email, is_admin, is_staff FROM users WHERE id = ?', id);
    if (!u) return c.json({ error: 'No such customer' }, 404);
    if (u.is_admin || u.is_staff) return c.json({ error: 'That is a staff account — manage it under Settings → Users & Staff.' }, 400);
    if (u.email === 'walkin@melthahonda.local') return c.json({ error: 'The walk-in customer cannot be removed.' }, 400);
    const h = await db.one(
      `SELECT (SELECT COUNT(*) FROM orders WHERE user_id = ?) AS orders,
              (SELECT COUNT(*) FROM pos_sales WHERE customer_id = ?) AS sales,
              (SELECT COUNT(*) FROM account_payments WHERE customer_id = ?) AS payments`, id, id, id);
    if ((h.orders + h.sales + h.payments) > 0) {
      await db.run('UPDATE users SET is_archived = 1 WHERE id = ?', id);
      return c.json({ ok: true, archived: true });
    }
    await db.run('DELETE FROM users WHERE id = ?', id);
    return c.json({ ok: true, deleted: true });
  });

  app.post('/api/admin/points/:userId', adminMw, async (c) => {
    const db = d1(c.env);
    const b = await c.req.json().catch(() => ({}));
    const delta = parseInt(b.delta, 10);
    if (!Number.isInteger(delta) || delta === 0) return c.json({ error: 'delta (non-zero integer) required' }, 400);
    await db.run('INSERT INTO points_transactions (user_id, delta, reason) VALUES (?,?,?)',
      c.req.param('userId'), delta, b.reason || 'admin_adjust');
    return c.json({ ok: true, balance: await pointsBalance(db, c.req.param('userId')) });
  });

  app.patch('/api/admin/users/:id/role', managerMw, async (c) => {
    const db = d1(c.env);
    const b = await c.req.json().catch(() => ({}));
    const targetId = parseInt(c.req.param('id'), 10);
    const wantsAdmin = b.is_admin !== undefined ? !!b.is_admin : null;
    const wantsRole = (await roleExists(c.env, b.admin_role)) ? b.admin_role : null;
    if (!targetId) return c.json({ error: 'Invalid user id' }, 400);
    if (wantsAdmin === null && !wantsRole) return c.json({ error: 'is_admin or admin_role required' }, 400);
    if (targetId === actingId(c) && wantsAdmin === false) return c.json({ error: "You can't revoke your own admin access" }, 400);
    if (wantsRole === 'owner' && actingRole(c) !== 'owner') return c.json({ error: 'Only an owner can grant owner access' }, 403);
    if (wantsAdmin === false) {
      const other = await db.one('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND id <> ?', targetId);
      if ((other.n || 0) === 0) return c.json({ error: 'Cannot demote the last remaining admin' }, 400);
    }
    const sets = []; const vals = [];
    if (wantsAdmin !== null) { sets.push('is_admin = ?'); vals.push(bit(wantsAdmin)); }
    if (wantsRole) { sets.push('admin_role = ?'); vals.push(wantsRole); }
    vals.push(targetId);
    const r = await db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, ...vals);
    if (!r.meta.changes) return c.json({ error: 'User not found' }, 404);
    const user = await db.one('SELECT id, email, name, is_admin, admin_role FROM users WHERE id = ?', targetId);
    return c.json({ ok: true, user: boolify(user, ['is_admin']) });
  });

  app.patch('/api/admin/users/:id/perms', managerMw, async (c) => {
    const db = d1(c.env);
    const targetId = parseInt(c.req.param('id'), 10);
    const b = await c.req.json().catch(() => ({}));
    const incoming = (b && typeof b.perms === 'object' && b.perms) || {};
    if (!targetId) return c.json({ error: 'Invalid user id' }, 400);
    const tgt = await db.one('SELECT admin_role FROM users WHERE id = ?', targetId);
    if (!tgt) return c.json({ error: 'User not found' }, 404);
    if (tgt.admin_role === 'owner' && actingRole(c) !== 'owner') return c.json({ error: 'Only an owner can change an owner account.' }, 403);
    if (await roleCanManage(c.env, tgt.admin_role))
      return c.json({ error: 'That role already has full access — per-user permissions only apply to non-manager staff.' }, 400);
    const clean = {};
    for (const [k, v] of Object.entries(incoming)) if (CAPABILITY_KEYS.has(k) && (v === false || v === true)) clean[k] = v;
    await db.run('UPDATE users SET perms = ? WHERE id = ?', JSON.stringify(clean), targetId);
    const st = await userPermState(c.env, targetId);
    return c.json({ ok: true, perms: st.perms, denied: clean });
  });

  // ---- customer notifications ----
  app.get('/api/admin/users/:id/notifications', adminMw, async (c) => {
    const notifications = await d1(c.env).many(
      'SELECT * FROM customer_notifications WHERE user_id = ? ORDER BY sent_at DESC LIMIT 200', c.req.param('id'));
    return c.json({ notifications });
  });
  app.post('/api/admin/users/:id/notifications', adminMw, async (c) => {
    const db = d1(c.env);
    const id = c.req.param('id');
    const b = await c.req.json().catch(() => ({}));
    const kind = ['dunning', 'reminder', 'general', 'other'].includes(b.kind) ? b.kind : 'general';
    const body = (b.body || '').trim();
    if (!body) return c.json({ error: 'body is required' }, 400);
    const u = await db.one('SELECT name, email FROM users WHERE id = ?', id);
    if (!u) return c.json({ error: 'Customer not found' }, 404);
    const r = await db.run('INSERT INTO customer_notifications (user_id, kind, body) VALUES (?,?,?)', id, kind, body);
    if (u.email) {
      const { sendEmail } = await import('../_lib/mailer.js');
      const subject = kind === 'dunning' ? 'Payment reminder — Meltha Honda Sales & Servs' : 'A note from Meltha Honda Sales & Servs';
      c.executionCtx?.waitUntil?.(sendEmail(c.env, { to: u.email, subject, text: body, html: `<p>${body.replace(/\n/g, '<br>')}</p>` }).catch(() => {}));
    }
    return c.json({ ok: true, id: r.meta.last_row_id, emailed: !!u.email });
  });

  // ---- account payments ----
  app.get('/api/admin/users/:id/account-payments', adminMw, async (c) => {
    const db = d1(c.env);
    const id = c.req.param('id');
    const payments = await db.many(
      `SELECT ap.id, ap.amount_cents / 100.0 AS amount_usd, ap.method, ap.reference, ap.notes,
              ap.received_by, ap.created_at, COALESCE(u.name, u.email) AS received_by_name
         FROM account_payments ap LEFT JOIN users u ON u.id = ap.received_by
        WHERE ap.customer_id = ? ORDER BY ap.created_at DESC LIMIT 200`, id);
    return c.json({ payments, balance_usd: await accountBalance(db, id) });
  });
  app.post('/api/admin/users/:id/account-payments', managerMw, async (c) => {
    const db = d1(c.env);
    const id = c.req.param('id');
    const b = await c.req.json().catch(() => ({}));
    const amount = Number(b.amount_usd);
    if (!(amount > 0)) return c.json({ error: 'amount_usd must be positive' }, 400);
    if (!['cash', 'card', 'cheque', 'bank'].includes(b.method)) return c.json({ error: 'method must be cash, card, cheque, or bank' }, 400);
    if (!await db.one('SELECT id FROM users WHERE id = ?', id)) return c.json({ error: 'Customer not found' }, 404);
    const before = await accountBalance(db, id);
    const r = await db.run(
      'INSERT INTO account_payments (customer_id, amount_cents, method, reference, notes, received_by) VALUES (?,?,?,?,?,?)',
      id, cents(amount), b.method, b.reference || null, b.notes || null, actingId(c));
    const after = before - amount;
    return c.json({ ok: true, id: r.meta.last_row_id, balance_before_usd: before, balance_after_usd: after, overpaid: after < 0 });
  });

  // ---- admin-side message thread ----
  app.get('/api/admin/users/:id/messages', adminMw, async (c) => {
    const db = d1(c.env);
    const id = c.req.param('id');
    const messages = await db.many('SELECT * FROM customer_messages WHERE user_id = ? ORDER BY created_at ASC LIMIT 500', id);
    await db.run("UPDATE customer_messages SET read_at = CURRENT_TIMESTAMP WHERE user_id = ? AND sender = 'customer' AND read_at IS NULL", id);
    return c.json({ messages });
  });
  app.post('/api/admin/users/:id/messages', adminMw, async (c) => {
    const db = d1(c.env);
    const body = ((await c.req.json().catch(() => ({}))).body || '').trim();
    if (!body) return c.json({ error: 'body required' }, 400);
    const r = await db.run("INSERT INTO customer_messages (user_id, sender, staff_id, body) VALUES (?, 'staff', ?, ?)",
      c.req.param('id'), actingId(c), body);
    return c.json({ ok: true, id: r.meta.last_row_id });
  });

  // ---- my UI prefs (write) ----
  app.post('/api/admin/me/ui-prefs', adminMw, async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ ok: false, error: 'Expected an object of preferences.' }, 400);
    const json = JSON.stringify(body);
    if (json.length > 8192) return c.json({ ok: false, error: 'Preferences too large.' }, 413);
    await d1(c.env).run('UPDATE users SET ui_prefs = ? WHERE id = ?', json, actingId(c));
    return c.json({ ok: true });
  });

  // ============ STAFF ============
  app.post('/api/admin/staff', managerMw, async (c) => {
    const db = d1(c.env);
    const b = await c.req.json().catch(() => ({}));
    if (!b.email || !b.password) return c.json({ error: 'email and password required' }, 400);
    let role = (await roleExists(c.env, b.admin_role)) ? b.admin_role : 'cashier';
    if (role === 'owner' && actingRole(c) !== 'owner') role = 'manager';
    const isAdmin = b.is_admin !== false;
    if (await db.one('SELECT id FROM users WHERE lower(email) = lower(?)', b.email))
      return c.json({ error: 'Email already registered — use the promote button on the existing user instead' }, 409);
    const hash = await bcrypt.hash(b.password, 10);
    let pinHash = null;
    try { if (b.pin) pinHash = await validateAndHashPin(db, b.pin, 0); }
    catch (e) { if (e.userFacing) return c.json({ error: e.message }, 400); throw e; }
    const r = await db.run(
      `INSERT INTO users (email, name, password_hash, phone, via, is_admin, admin_role, is_staff, employee_no, national_id, pin_hash, pin_set_at)
         VALUES (lower(?),?,?,?, 'local', ?, ?, 1, ?, ?, ?, ${pinHash ? 'CURRENT_TIMESTAMP' : 'NULL'})`,
      b.email, b.name || null, hash, b.phone || null, bit(isAdmin), role, b.employee_no || null, b.national_id || null, pinHash);
    const uid = r.meta.last_row_id;
    if (Array.isArray(b.categories) && b.categories.length) await setUserCategories(db, uid, b.categories);
    await syncStaffProfile(db, uid);
    const user = await db.one('SELECT id, email, name, is_admin, admin_role, employee_no FROM users WHERE id = ?', uid);
    return c.json({ ok: true, user: boolify(user, ['is_admin']) });
  });

  app.patch('/api/admin/staff/:id', managerMw, async (c) => {
    const db = d1(c.env);
    const id = parseInt(c.req.param('id'), 10);
    const b = await c.req.json().catch(() => ({}));
    if (b.disabled === true) {
      if (id === actingId(c)) return c.json({ error: 'You cannot disable your own account.' }, 400);
      const tgt = await db.one('SELECT admin_role FROM users WHERE id = ?', id);
      if (tgt && tgt.admin_role === 'owner' && actingRole(c) !== 'owner') return c.json({ error: 'Only an owner can disable an owner account.' }, 403);
    }
    const MAP = { name: 0, phone: 0, employee_no: 0, national_id: 0, is_staff: 1, is_admin: 1, disabled: 1, favs_locked: 1 };
    const sets = []; const vals = [];
    for (const [f, isBool] of Object.entries(MAP)) if (b[f] !== undefined) { sets.push(`${f} = ?`); vals.push(isBool ? bit(b[f]) : b[f]); }
    if (b.forced_favs !== undefined) {
      const arr = Array.isArray(b.forced_favs) ? b.forced_favs.filter((t) => typeof t === 'string').slice(0, 40) : [];
      sets.push('forced_favs = ?'); vals.push(JSON.stringify(arr));
    }
    if (b.admin_role !== undefined && await roleExists(c.env, b.admin_role)) {
      let role = b.admin_role;
      if (role === 'owner' && actingRole(c) !== 'owner') role = 'manager';
      sets.push('admin_role = ?'); vals.push(role);
    }
    if (sets.length) { vals.push(id); await db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, ...vals); }
    if (b.categories !== undefined) await setUserCategories(db, id, b.categories);
    await syncStaffProfile(db, id);
    return c.json({ ok: true });
  });

  app.post('/api/admin/staff/:id/password', managerMw, async (c) => {
    const db = d1(c.env);
    const id = parseInt(c.req.param('id'), 10);
    const pw = String((await c.req.json().catch(() => ({}))).password || '');
    if (pw.length < 6) return c.json({ error: 'Password must be at least 6 characters' }, 400);
    const u = await db.one('SELECT id, name, email, admin_role FROM users WHERE id = ?', id);
    if (!u) return c.json({ error: 'No such staff member' }, 404);
    if (u.admin_role === 'owner' && actingRole(c) !== 'owner') return c.json({ error: "Only an owner can reset an owner's password." }, 403);
    if (id === actingId(c)) return c.json({ error: 'Change your own password from your account page.' }, 400);
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', await bcrypt.hash(pw, 10), id);
    return c.json({ ok: true, user: { id: u.id, name: u.name, email: u.email } });
  });

  app.post('/api/admin/staff/:id/pin', managerMw, async (c) => {
    const db = d1(c.env);
    const id = parseInt(c.req.param('id'), 10);
    const b = await c.req.json().catch(() => ({}));
    if (b.clear) {
      await db.run('UPDATE users SET pin_hash = NULL, pin_set_at = NULL WHERE id = ?', id);
      return c.json({ ok: true, cleared: true });
    }
    try {
      const hash = await validateAndHashPin(db, b.pin, id);
      await db.run('UPDATE users SET pin_hash = ?, pin_set_at = CURRENT_TIMESTAMP WHERE id = ?', hash, id);
      return c.json({ ok: true });
    } catch (e) { if (e.userFacing) return c.json({ error: e.message }, 400); throw e; }
  });

  app.post('/api/admin/staff/:id/pin/reset', managerMw, async (c) => {
    const db = d1(c.env);
    const id = parseInt(c.req.param('id'), 10);
    const u = await db.one('SELECT id, name FROM users WHERE id = ?', id);
    if (!u) return c.json({ error: 'No such staff member' }, 404);
    const banned = new Set(['0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999', '1234', '4321', '1010']);
    let pin = null;
    for (let i = 0; i < 40 && !pin; i++) {
      const cand = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
      if (banned.has(cand)) continue;
      if (!(await pinCollides(db, cand, id))) pin = cand;
    }
    if (!pin) return c.json({ error: 'Could not find a free PIN — clear some unused ones and try again.' }, 409);
    await db.run('UPDATE users SET pin_hash = ?, pin_set_at = CURRENT_TIMESTAMP WHERE id = ?', await bcrypt.hash(pin, 10), id);
    return c.json({ ok: true, pin, name: u.name });
  });

  app.post('/api/admin/staff/pin-verify', adminMw, async (c) => {
    const db = d1(c.env);
    const b = await c.req.json().catch(() => ({}));
    const purpose = String(b.purpose || 'signin');
    const key = c.req.header('cf-connecting-ip') || 'local';
    const now = Date.now();
    const rec = PIN_ATTEMPTS.get(key) || { fails: 0, until: 0 };
    if (rec.until > now) return c.json({ error: `Too many wrong PINs. Try again in ${Math.ceil((rec.until - now) / 1000)}s.` }, 429);
    const pin = String(b.pin || '').trim();
    if (!pin) return c.json({ error: 'PIN required' }, 400);
    const rows = await db.many('SELECT id, name, email, admin_role, pin_hash FROM users WHERE pin_hash IS NOT NULL AND is_staff = 1');
    let hit = null;
    for (const r of rows) if (await bcrypt.compare(pin, r.pin_hash)) { hit = r; break; }
    if (!hit) {
      rec.fails++;
      if (rec.fails >= PIN_MAX_TRIES) { rec.until = now + PIN_LOCK_MS; rec.fails = 0; }
      PIN_ATTEMPTS.set(key, rec);
      return c.json({ error: 'PIN not recognised' }, 401);
    }
    PIN_ATTEMPTS.delete(key);
    if (purpose === 'override' && !['owner', 'manager'].includes(hit.admin_role))
      return c.json({ error: (hit.name || 'That staff member') + ' cannot authorise this — a manager is needed.' }, 403);
    const codes = await staffCodes(db, hit.id);
    const mech = await db.one('SELECT id FROM mechanics WHERE user_id = ? AND is_active = 1 LIMIT 1', hit.id);
    return c.json({ ok: true, purpose, user: { id: hit.id, name: hit.name, email: hit.email, admin_role: hit.admin_role, categories: codes, rep_id: mech ? mech.id : null } });
  });

  // ============ ROLES ============
  app.post('/api/admin/roles', managerMw, async (c) => {
    const db = d1(c.env);
    const b = await c.req.json().catch(() => ({}));
    const label = String(b.label || '').trim();
    if (!label) return c.json({ error: 'label required' }, 400);
    const code = slug(b.code || label);
    if (!code) return c.json({ error: 'label must contain a letter or digit' }, 400);
    const acting = actingRole(c);
    const mine = await db.one('SELECT rank FROM roles WHERE code = ?', acting);
    const myRank = acting === 'owner' ? 0 : (mine ? mine.rank : 99);
    const rank = Math.max(myRank + 1, parseInt(b.rank, 10) || 50);
    const canManage = acting === 'owner' ? !!b.can_manage : (!!b.can_manage && await roleCanManage(c.env, acting));
    if (await db.one('SELECT code FROM roles WHERE code = ?', code)) return c.json({ error: 'A role with that code already exists' }, 409);
    await db.run('INSERT INTO roles (code, label, rank, can_manage, hidden_tabs, show_extra_menus, is_system) VALUES (?,?,?,?,?,?,0)',
      code, label, rank, bit(canManage), JSON.stringify(Array.isArray(b.hidden_tabs) ? b.hidden_tabs : []), bit(b.show_extra_menus));
    const role = await db.one('SELECT * FROM roles WHERE code = ?', code);
    return c.json({ ok: true, role: boolify(role, ['can_manage', 'is_system', 'show_extra_menus']) });
  });

  app.patch('/api/admin/roles/:code', managerMw, async (c) => {
    const db = d1(c.env);
    const code = c.req.param('code');
    const b = await c.req.json().catch(() => ({}));
    const target = await db.one('SELECT * FROM roles WHERE code = ?', code);
    if (!target) return c.json({ error: 'No such role' }, 404);
    const acting = actingRole(c);
    const mine = await db.one('SELECT rank FROM roles WHERE code = ?', acting);
    const myRank = acting === 'owner' ? 0 : (mine ? mine.rank : 99);
    if (acting !== 'owner' && target.rank <= myRank) return c.json({ error: 'You cannot change a role at or above your own level.' }, 403);
    if (target.code === 'owner') return c.json({ error: 'The Owner role cannot be edited.' }, 400);
    const sets = []; const vals = [];
    if (b.label !== undefined) { sets.push('label = ?'); vals.push(String(b.label).trim()); }
    if (b.can_manage !== undefined) { sets.push('can_manage = ?'); vals.push(bit(b.can_manage)); }
    if (b.hidden_tabs !== undefined) { sets.push('hidden_tabs = ?'); vals.push(JSON.stringify(Array.isArray(b.hidden_tabs) ? b.hidden_tabs : [])); }
    if (b.show_extra_menus !== undefined) { sets.push('show_extra_menus = ?'); vals.push(bit(b.show_extra_menus)); }
    if (b.rank !== undefined && !target.is_system) { sets.push('rank = ?'); vals.push(Math.max(myRank + 1, parseInt(b.rank, 10) || 50)); }
    if (!sets.length) return c.json({ error: 'Nothing to update' }, 400);
    vals.push(code);
    await db.run(`UPDATE roles SET ${sets.join(', ')} WHERE code = ?`, ...vals);
    return c.json({ ok: true });
  });

  app.delete('/api/admin/roles/:code', managerMw, async (c) => {
    const db = d1(c.env);
    const code = c.req.param('code');
    const role = await db.one('SELECT is_system, label FROM roles WHERE code = ?', code);
    if (!role) return c.json({ error: 'No such role' }, 404);
    if (role.is_system) return c.json({ error: `"${role.label}" is a built-in role and cannot be deleted.` }, 400);
    const held = await db.one('SELECT COUNT(*) AS n FROM users WHERE admin_role = ?', code);
    if ((held.n || 0) > 0) return c.json({ error: `${held.n} staff still have this role. Move them to another role first.` }, 400);
    await db.run('DELETE FROM roles WHERE code = ?', code);
    return c.json({ ok: true });
  });

  // ============ USER CATEGORIES ============
  app.post('/api/admin/user-categories', managerMw, async (c) => {
    const db = d1(c.env);
    const b = await c.req.json().catch(() => ({}));
    const label = String(b.label || '').trim();
    if (!label) return c.json({ error: 'label required' }, 400);
    const code = slug(b.code || label);
    if (!code) return c.json({ error: 'label must contain a letter or digit' }, 400);
    if (await db.one('SELECT id FROM user_categories WHERE code = ?', code)) return c.json({ error: 'A category with that code already exists' }, 409);
    const r = await db.run(
      'INSERT INTO user_categories (code, label, department, is_staff, sort_order, is_system) VALUES (?,?,?,?,?,0)',
      code, label, b.department || null, b.is_staff === false ? 0 : 1, b.sort_order != null ? parseInt(b.sort_order, 10) : 100);
    const category = await db.one('SELECT * FROM user_categories WHERE id = ?', r.meta.last_row_id);
    return c.json({ ok: true, category: boolify(category, ['is_staff', 'is_active', 'is_system']) });
  });

  app.patch('/api/admin/user-categories/:id', managerMw, async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const MAP = { label: 0, department: 0, is_staff: 1, sort_order: 0, is_active: 1 };
    const sets = []; const vals = [];
    for (const [f, isBool] of Object.entries(MAP)) if (b[f] !== undefined) { sets.push(`${f} = ?`); vals.push(isBool ? bit(b[f]) : b[f]); }
    if (!sets.length) return c.json({ error: 'Nothing to update' }, 400);
    vals.push(c.req.param('id'));
    await d1(c.env).run(`UPDATE user_categories SET ${sets.join(', ')} WHERE id = ?`, ...vals);
    return c.json({ ok: true });
  });

  app.patch('/api/admin/user-categories/:id/perms', managerMw, async (c) => {
    const id = parseInt(c.req.param('id'), 10);
    if (!id) return c.json({ error: 'Invalid id' }, 400);
    const incoming = ((await c.req.json().catch(() => ({}))).perms) || {};
    const clean = {};
    for (const [k, v] of Object.entries(incoming)) if (CAPABILITY_KEYS.has(k) && v === false) clean[k] = false;
    const r = await d1(c.env).run('UPDATE user_categories SET perms = ? WHERE id = ?', JSON.stringify(clean), id);
    if (!r.meta.changes) return c.json({ error: 'No such category' }, 404);
    return c.json({ ok: true, perms: clean });
  });

  app.delete('/api/admin/user-categories/:id', managerMw, async (c) => {
    const db = d1(c.env);
    const cat = await db.one('SELECT is_system, label FROM user_categories WHERE id = ?', c.req.param('id'));
    if (!cat) return c.json({ error: 'No such category' }, 404);
    if (cat.is_system) return c.json({ error: `"${cat.label}" is built in — deactivate it instead of deleting it.` }, 400);
    await db.run('DELETE FROM user_categories WHERE id = ?', c.req.param('id'));
    return c.json({ ok: true });
  });
}
