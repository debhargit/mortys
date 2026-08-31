// Phase 10 — customer-facing completion. Ports server.js:
//   POST /api/auth/signup, POST /api/auth/reset-default-admin, PATCH /api/me
//   POST /api/checkout, GET /api/orders, GET /api/orders/:id
//   GET  /api/points, GET /api/config, GET /api/vin/:vin
//   POST /api/newsletter, POST /api/service, POST /api/coupon/validate
//   GET/POST/DELETE /api/vehicles[/:id]         (saved_vehicles)
//   GET/POST/DELETE /api/my-addresses[/:id]
//   GET/POST /api/my-messages
//   GET  /api/my-work-orders, POST /api/work-order-lookup
//
// D1 notes: no interactive txns -> checkout is read → compute → one db.batch()
// with a pre-assigned order id. Stripe/SMS are dropped (see PORT.md); the card
// path returns a clean 400 and /api/config always reports payments off.
import bcrypt from 'bcryptjs';
import { d1 } from '../_lib/db.js';
import { authMw, sessionEpoch, currentUser } from '../_lib/guards.js';
import { sessionCookie } from '../_lib/session.js';
import { publicUser } from './auth.js';
import { sendEmail, templates } from '../_lib/mailer.js';

const POINTS_USD_RATE = 0.05;
const r2 = (n) => Math.round(n * 100) / 100;
const cents = (usd) => Math.round((Number(usd) || 0) * 100);
const digits7 = (s) => String(s || '').replace(/[^\d]/g, '').slice(-7);

async function pointsBalance(db, userId) {
  const r = await db.one('SELECT COALESCE(SUM(delta),0) AS b FROM points_transactions WHERE user_id = ?', userId);
  return (r && r.b) || 0;
}
async function nextAccountNumber(db) {
  const rows = await db.many("SELECT account_number AS a FROM users WHERE account_number LIKE 'C-%'");
  let max = 0;
  for (const r of rows) { const m = String(r.a || '').match(/(\d+)\s*$/); if (m) max = Math.max(max, +m[1]); }
  return 'C-' + String(max + 1).padStart(6, '0');
}
async function nextId(db, table) {
  const r = await db.one(`SELECT COALESCE(MAX(id),0)+1 AS n FROM ${table}`);
  return r.n;
}

async function loadCoupon(db, rawCode) {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!code) return { ok: false, error: 'Coupon code required' };
  const c = await db.one(
    `SELECT code, kind, amount, min_subtotal, max_redemptions, redeemed_count, expires_at, is_active, description
       FROM coupons WHERE code = ?`, code);
  if (!c) return { ok: false, error: 'Invalid coupon code' };
  if (!c.is_active) return { ok: false, error: 'This coupon is no longer active' };
  if (c.expires_at && new Date(c.expires_at) < new Date()) return { ok: false, error: 'This coupon has expired' };
  if (c.max_redemptions != null && c.redeemed_count >= c.max_redemptions)
    return { ok: false, error: 'This coupon has reached its redemption limit' };
  return { ok: true, coupon: c };
}
function computeCouponDiscount(coupon, subtotal) {
  if (subtotal < Number(coupon.min_subtotal || 0))
    return { discount: 0, reason: `Minimum subtotal $${Number(coupon.min_subtotal).toFixed(2)} not met` };
  const raw = coupon.kind === 'percent'
    ? r2(subtotal * (Number(coupon.amount) / 100))
    : Number(coupon.amount);
  return { discount: Math.min(raw, subtotal), reason: null };
}

export default function mount(app) {
  // ---- signup --------------------------------------------------------
  app.post('/api/auth/signup', async (c) => {
    const db = d1(c.env);
    const { email, password, name, phone } = await c.req.json().catch(() => ({}));
    if (!email || !password) return c.json({ error: 'email and password are required' }, 400);
    const exists = await db.one('SELECT id FROM users WHERE lower(email) = lower(?)', email);
    if (exists) return c.json({ error: 'Email already registered' }, 409);
    const hash = await bcrypt.hash(password, 10);
    const cnt = await db.one('SELECT COUNT(*) AS n FROM users');
    const isFirst = (cnt.n || 0) === 0;
    const acctNo = await nextAccountNumber(db);
    const id = await nextId(db, 'users');
    await db.run(
      `INSERT INTO users (id, email, name, password_hash, phone, via, is_admin, account_number)
         VALUES (?, lower(?), ?, ?, ?, 'local', ?, ?)`,
      id, email, name || null, hash, phone || null, isFirst ? 1 : 0, acctNo);
    await db.run("INSERT INTO points_transactions (user_id, delta, reason, reference_id) VALUES (?, 100, 'signup_bonus', ?)", id, id);
    c.header('Set-Cookie', await sessionCookie(c.env, { userId: id, epoch: await sessionEpoch(db) }));
    const row = { id, email: String(email).toLowerCase(), name: name || null, is_admin: isFirst, admin_role: null };
    c.executionCtx?.waitUntil?.(sendEmail(c.env, { to: row.email, ...templates.welcomeEmail({ name: row.name }) }).catch(() => {}));
    return c.json({ user: publicUser(row), first_admin: isFirst });
  });

  // ---- emergency admin reset (single well-known email only) ---------
  app.post('/api/auth/reset-default-admin', async (c) => {
    const db = d1(c.env);
    const hash = await bcrypt.hash('password123', 10);
    const existing = await db.one("SELECT id FROM users WHERE email = 'admin@melthahonda.com'");
    if (existing) {
      await db.run('UPDATE users SET is_admin = 1, password_hash = ? WHERE id = ?', hash, existing.id);
    } else {
      const id = await nextId(db, 'users');
      await db.run(
        `INSERT INTO users (id, email, name, password_hash, via, is_admin)
           VALUES (?, 'admin@melthahonda.com', 'Meltha Honda Admin', ?, 'local', 1)`, id, hash);
    }
    return c.json({ ok: true, email: 'admin@melthahonda.com', password: 'password123' });
  });

  // ---- self-serve profile edit ------------------------------------
  app.patch('/api/me', authMw, async (c) => {
    const db = d1(c.env);
    const uid = c.get('user').id;
    const b = await c.req.json().catch(() => ({}));
    const sets = []; const vals = [];
    if (b.name !== undefined) { sets.push('name = ?'); vals.push((b.name || '').trim() || null); }
    if (b.phone !== undefined) { sets.push('phone = ?'); vals.push((b.phone || '').trim() || null); }
    if (b.password) {
      if (String(b.password).length < 4) return c.json({ error: 'Password must be at least 4 characters' }, 400);
      sets.push('password_hash = ?'); vals.push(await bcrypt.hash(String(b.password), 10));
    }
    if (!sets.length) return c.json({ error: 'Nothing to update' }, 400);
    vals.push(uid);
    await db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, ...vals);
    const u = await db.one('SELECT id, email, name, phone, is_admin, admin_role FROM users WHERE id = ?', uid);
    return c.json({ user: { ...publicUser(u), phone: u.phone || null } });
  });

  // ---- points ledger ---------------------------------------------
  app.get('/api/points', authMw, async (c) => {
    const db = d1(c.env);
    const uid = c.get('user').id;
    const balance = await pointsBalance(db, uid);
    const transactions = await db.many(
      `SELECT delta, reason, reference_id, created_at FROM points_transactions
        WHERE user_id = ? ORDER BY created_at DESC LIMIT 30`, uid);
    return c.json({ balance, transactions, rate_usd_per_point: POINTS_USD_RATE });
  });

  // ---- payments config (Stripe dropped -> always off) -------------
  // ordering_enabled:false tells the storefront the cart can only produce a
  // quote request now (see POST /api/inquiry); show_prices is the per-customer
  // pricing flag so the catalogue knows whether to render prices.
  app.get('/api/config', async (c) => {
    let showPrices = false;
    try { const u = await currentUser(c.req.raw, c.env); showPrices = !!(u && u.show_prices); } catch { /* guest */ }
    return c.json({
      payments: { stripe_enabled: false, stripe_publishable_key: null, methods: [] },
      ordering_enabled: false,
      show_prices: showPrices,
    });
  });

  // ---- coupon pre-check ----------------------------------------
  app.post('/api/coupon/validate', authMw, async (c) => {
    const db = d1(c.env);
    const uid = c.get('user').id;
    const r = await loadCoupon(db, (await c.req.json().catch(() => ({}))).code);
    if (!r.ok) return c.json({ error: r.error }, 400);
    const items = await db.many(
      'SELECT c.qty, p.price_cents / 100.0 AS price_usd FROM cart_items c JOIN products p ON p.img = c.product_img WHERE c.user_id = ?', uid);
    const subtotal = r2(items.reduce((s, it) => s + Number(it.price_usd || 0) * it.qty, 0));
    const { discount, reason } = computeCouponDiscount(r.coupon, subtotal);
    if (discount === 0 && reason) return c.json({ error: reason }, 400);
    return c.json({ code: r.coupon.code, kind: r.coupon.kind, amount: r.coupon.amount, description: r.coupon.description, subtotal, discount_usd: discount });
  });

  // ---- checkout ------------------------------------------------
  // Online ordering is disabled: the storefront is quote-first now. A cart
  // "checkout" must go to POST /api/inquiry, which files a quote request the
  // counter prices by hand. This route stays mounted only to give a stale
  // client a clear answer instead of silently creating an order.
  app.post('/api/checkout', authMw, (c) => c.json({
    error: 'Online ordering is disabled. Please submit a quote request and the parts desk will price it and call you back.',
    code: 'quote_only',
  }, 400));

  // ---- order history ----------------------------------------
  app.get('/api/orders', authMw, async (c) => {
    const orders = await d1(c.env).many(
      `SELECT id, total_cents / 100.0 AS total_usd, status, payment_method, payment_status, created_at
         FROM orders WHERE user_id = ? ORDER BY created_at DESC`, c.get('user').id);
    return c.json({ orders });
  });
  app.get('/api/orders/:id', authMw, async (c) => {
    const db = d1(c.env);
    const order = await db.one(
      `SELECT id, total_cents / 100.0 AS total_usd, status, payment_method, payment_status, notes, created_at
         FROM orders WHERE id = ? AND user_id = ?`, c.req.param('id'), c.get('user').id);
    if (!order) return c.json({ error: 'Order not found' }, 404);
    const items = await db.many(
      `SELECT oi.product_img, oi.qty, oi.price_cents / 100.0 AS price_usd, p.name, p.make_model
         FROM order_items oi LEFT JOIN products p ON p.img = oi.product_img WHERE oi.order_id = ?`, c.req.param('id'));
    return c.json({ order, items });
  });

  // ---- newsletter -----------------------------------------
  app.post('/api/newsletter', async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const email = (b.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return c.json({ error: 'Valid email required' }, 400);
    await d1(c.env).run('INSERT OR IGNORE INTO newsletter_subscribers (email, source) VALUES (?, ?)', email, b.source || null);
    return c.json({ ok: true });
  });

  // ---- service booking ----------------------------------
  app.post('/api/service', async (c) => {
    const db = d1(c.env);
    const b = await c.req.json().catch(() => ({}));
    if (!b.name || !b.phone) return c.json({ error: 'name and phone are required' }, 400);
    let uid = null;
    try { const u = await currentUser(c.req.raw, c.env); uid = u ? u.id : null; } catch { /* anon booking */ }
    const r = await db.run(
      `INSERT INTO service_appointments
         (user_id, name, phone, email, vehicle_make, vehicle_model, vehicle_year, service_type, preferred_date, time_slot, notes)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      uid, b.name, b.phone, b.email || null, b.make || null, b.model || null,
      b.year ? parseInt(b.year, 10) : null, b.service_type || null, b.preferred_date || null, b.time_slot || null, b.notes || null);
    return c.json({ id: r.meta ? r.meta.last_row_id : undefined });
  });

  // ---- VIN decode (NHTSA proxy) -----------------------
  app.get('/api/vin/:vin', async (c) => {
    const vin = (c.req.param('vin') || '').trim().toUpperCase();
    if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return c.json({ error: 'VIN must be 17 letters/numbers (no I, O, Q)' }, 400);
    try {
      const r = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${vin}?format=json`, { headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error('NHTSA returned ' + r.status);
      const data = await r.json();
      const v = (data.Results && data.Results[0]) || {};
      return c.json({
        vin, make: v.Make || null, model: v.Model || null, year: v.ModelYear || null,
        trim: v.Trim || null, body: v.BodyClass || null, engine: v.DisplacementL ? v.DisplacementL + 'L' : null,
        fuel: v.FuelTypePrimary || null, plant: v.PlantCountry || null,
      });
    } catch (e) { return c.json({ error: 'VIN lookup failed: ' + e.message }, 502); }
  });

  // ---- saved vehicles ------------------------------
  app.get('/api/vehicles', authMw, async (c) => {
    const vehicles = await d1(c.env).many(
      'SELECT id, label, make, model, year, vin, nickname, created_at FROM saved_vehicles WHERE user_id = ? ORDER BY created_at DESC',
      c.get('user').id);
    return c.json({ vehicles });
  });
  app.post('/api/vehicles', authMw, async (c) => {
    const db = d1(c.env);
    const uid = c.get('user').id;
    const b = await c.req.json().catch(() => ({}));
    const make = (b.make || '').trim() || null;
    const model = (b.model || '').trim() || null;
    const year = parseInt(b.year, 10) || null;
    const vin = (b.vin || '').trim().toUpperCase() || null;
    const label = (b.label || b.nickname || '').trim() || null;
    if (!make && !model && !vin) return c.json({ error: 'make/model or VIN required' }, 400);
    const existing = vin ? await db.one('SELECT id FROM saved_vehicles WHERE user_id = ? AND vin = ?', uid, vin) : null;
    if (existing) {
      await db.run('UPDATE saved_vehicles SET label=?, make=?, model=?, year=?, nickname=? WHERE id = ?',
        label, make, model, year, label, existing.id);
      return c.json({ ok: true, id: existing.id });
    }
    const r = await db.run(
      'INSERT INTO saved_vehicles (user_id, label, make, model, year, vin, nickname) VALUES (?,?,?,?,?,?,?)',
      uid, label, make, model, year, vin, label);
    return c.json({ ok: true, id: r.meta ? r.meta.last_row_id : undefined });
  });
  app.delete('/api/vehicles/:id', authMw, async (c) => {
    await d1(c.env).run('DELETE FROM saved_vehicles WHERE id = ? AND user_id = ?', c.req.param('id'), c.get('user').id);
    return c.json({ ok: true });
  });

  // ---- address book -----------------------------
  app.get('/api/my-addresses', authMw, async (c) => {
    const addresses = await d1(c.env).many(
      'SELECT * FROM customer_addresses WHERE user_id = ? ORDER BY is_default DESC, created_at DESC', c.get('user').id);
    return c.json({ addresses });
  });
  app.post('/api/my-addresses', authMw, async (c) => {
    const db = d1(c.env);
    const uid = c.get('user').id;
    const b = await c.req.json().catch(() => ({}));
    if (!b.line1) return c.json({ error: 'line1 required' }, 400);
    if (b.is_default) await db.run('UPDATE customer_addresses SET is_default = 0 WHERE user_id = ?', uid);
    const r = await db.run(
      `INSERT INTO customer_addresses (user_id, label, kind, line1, line2, city, parish, postal_code, country, phone, is_default)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      uid, b.label || null, b.kind || 'shipping', b.line1, b.line2 || null,
      b.city || null, b.parish || null, b.postal_code || null, b.country || 'Jamaica', b.phone || null, b.is_default ? 1 : 0);
    return c.json({ ok: true, id: r.meta ? r.meta.last_row_id : undefined });
  });
  app.delete('/api/my-addresses/:id', authMw, async (c) => {
    await d1(c.env).run('DELETE FROM customer_addresses WHERE id = ? AND user_id = ?', c.req.param('id'), c.get('user').id);
    return c.json({ ok: true });
  });

  // ---- customer <-> staff messages -----------------
  app.get('/api/my-messages', authMw, async (c) => {
    const db = d1(c.env);
    const uid = c.get('user').id;
    const messages = await db.many('SELECT * FROM customer_messages WHERE user_id = ? ORDER BY created_at ASC LIMIT 500', uid);
    await db.run("UPDATE customer_messages SET read_at = CURRENT_TIMESTAMP WHERE user_id = ? AND sender = 'staff' AND read_at IS NULL", uid);
    return c.json({ messages });
  });
  app.post('/api/my-messages', authMw, async (c) => {
    const db = d1(c.env);
    const body = ((await c.req.json().catch(() => ({}))).body || '').trim();
    if (!body) return c.json({ error: 'Message required' }, 400);
    const r = await db.run("INSERT INTO customer_messages (user_id, sender, body) VALUES (?, 'customer', ?)", c.get('user').id, body);
    return c.json({ ok: true, id: r.meta ? r.meta.last_row_id : undefined });
  });

  // ---- customer's own work orders --------------
  const WO_COLS = `id, wo_number, customer_name, vehicle_year, vehicle_make, vehicle_model,
    status, priority, intake_date, promised_date, completed_at, paid_at,
    labor_total_cents / 100.0 AS labor_total_usd, parts_total_cents / 100.0 AS parts_total_usd,
    tax_cents / 100.0 AS tax_usd, total_cents / 100.0 AS total_usd, complaint, work_performed`;
  const digitsSql = (col) => `replace(replace(replace(replace(replace(replace(${col},'-',''),' ',''),'(',''),')',''),'+',''),'.','')`;

  app.get('/api/my-work-orders', authMw, async (c) => {
    const db = d1(c.env);
    const uid = c.get('user').id;
    const u = await db.one('SELECT phone FROM users WHERE id = ?', uid);
    const phone = digits7(u && u.phone);
    const binds = [uid];
    let phoneClause = '';
    if (phone) { phoneClause = ` OR ${digitsSql('customer_phone')} LIKE ?`; binds.push('%' + phone); }
    const work_orders = await db.many(
      `SELECT ${WO_COLS} FROM work_orders WHERE (customer_user_id = ?${phoneClause}) ORDER BY intake_date DESC LIMIT 100`, ...binds);
    return c.json({ work_orders });
  });

  app.post('/api/work-order-lookup', async (c) => {
    const db = d1(c.env);
    const b = await c.req.json().catch(() => ({}));
    const wo = (b.wo_number || '').trim().toUpperCase();
    const phone = digits7(b.phone);
    if (!wo || !phone) return c.json({ error: 'WO number and phone required' }, 400);
    const work_order = await db.one(
      `SELECT ${WO_COLS}, diagnosis FROM work_orders WHERE wo_number = ? AND ${digitsSql('customer_phone')} LIKE ?`, wo, '%' + phone);
    if (!work_order) return c.json({ error: 'No work order found.' }, 404);
    return c.json({ work_order });
  });
}
