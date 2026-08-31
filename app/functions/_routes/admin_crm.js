// Phase 11 — admin CRM + storefront-admin. Ports server.js:
//   GET/PATCH  /api/admin/inquiries[/:id]
//   GET/PATCH  /api/admin/appointments[/:id]   GET /api/admin/appointments/calendar
//   GET        /api/admin/notifications
//   GET/PATCH/DELETE /api/admin/reviews[/:id]
//   GET/POST   /api/admin/users/:id/addresses   PATCH/DELETE /api/admin/addresses/:id
//   GET/POST   /api/admin/users/:id/contacts    PATCH/DELETE /api/admin/contacts/:id
//   GET        /api/admin/messages/inbox
//   GET/POST/PATCH/DELETE /api/admin/coupons[/:code]
//   GET /api/admin/gift-cards  GET /api/admin/gift-cards/:code
//   POST /api/admin/gift-cards  POST /api/admin/gift-cards/:code/reload
//   PATCH /api/admin/gift-cards/:code
import { d1 } from '../_lib/db.js';
import { adminMw, managerMw } from '../_lib/guards.js';
import { boolify } from '../_lib/util.js';

const cents = (usd) => Math.round((Number(usd) || 0) * 100);
const bit = (v) => (v ? 1 : 0);
const gcCode = () => {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const p = () => Array.from({ length: 4 }, () => a[Math.floor(Math.random() * a.length)]).join('');
  return `GC-${p()}-${p()}`;
};

const INQ_STATUSES = ['new', 'quoted', 'won', 'lost'];

function parseItems(json) {
  try { const a = JSON.parse(json || '[]'); return Array.isArray(a) ? a : []; }
  catch { return []; }
}

export default function mount(app) {
  // ---- parts inquiries / quote requests -----------------------
  app.get('/api/admin/inquiries', adminMw, async (c) => {
    const inquiries = await d1(c.env).many(
      `SELECT i.id, i.user_id, i.name, i.phone, i.email, i.vehicle_make, i.vehicle_model, i.vehicle_year,
              i.condition, i.part_description, i.items_json, i.source, i.photo_path, i.status,
              i.quote_total_cents / 100.0 AS quote_total_usd, i.quote_notes, i.priced_at, i.created_at,
              (i.photo_data IS NOT NULL) AS has_photo,
              u.name AS account_name, COALESCE(u.show_prices, 0) AS customer_show_prices
         FROM parts_inquiries i
         LEFT JOIN users u ON u.id = i.user_id
        ORDER BY i.created_at DESC LIMIT 200`);
    return c.json({ inquiries });
  });

  app.get('/api/admin/inquiries/:id', adminMw, async (c) => {
    const db = d1(c.env);
    const i = await db.one(
      `SELECT i.*, i.quote_total_cents / 100.0 AS quote_total_usd,
              (i.photo_data IS NOT NULL) AS has_photo,
              u.name AS account_name, u.email AS account_email, COALESCE(u.show_prices, 0) AS customer_show_prices
         FROM parts_inquiries i LEFT JOIN users u ON u.id = i.user_id
        WHERE i.id = ?`, c.req.param('id'));
    if (!i) return c.json({ error: 'Not found' }, 404);
    delete i.photo_data;
    const items = parseItems(i.items_json).map((it) => ({
      ...it,
      unit_price_usd: it.unit_price_cents != null ? it.unit_price_cents / 100 : null,
      list_price_usd: it.list_price_cents != null ? it.list_price_cents / 100 : null,
      line_total_usd: it.line_total_cents != null ? it.line_total_cents / 100 : null,
    }));
    // Current stock for each part on the request, so the counter can see
    // availability while pricing.
    const imgs = [...new Set(items.map((x) => x.img).filter(Boolean))];
    let stock = {};
    if (imgs.length) {
      const rows = await db.many(
        `SELECT img, stock_count, price_cents FROM products WHERE img IN (${imgs.map(() => '?').join(',')})`, ...imgs);
      stock = Object.fromEntries(rows.map((r) => [r.img, { stock_count: r.stock_count, list_price_usd: r.price_cents != null ? r.price_cents / 100 : null }]));
    }
    return c.json({ inquiry: i, items, stock });
  });

  // Status-only PATCH still works; sending `items` / `quote_notes` prices the
  // request (recomputes the total, stamps priced_at/priced_by, and moves a
  // 'new' request to 'quoted').
  app.patch('/api/admin/inquiries/:id', adminMw, async (c) => {
    const db = d1(c.env);
    const id = c.req.param('id');
    const b = await c.req.json().catch(() => ({}));
    const cur = await db.one('SELECT id, status, items_json FROM parts_inquiries WHERE id = ?', id);
    if (!cur) return c.json({ error: 'Not found' }, 404);

    const sets = [], vals = [];
    if (b.status !== undefined) {
      if (!INQ_STATUSES.includes(b.status)) return c.json({ error: 'Invalid status' }, 400);
      sets.push('status = ?'); vals.push(b.status);
    }
    if (b.quote_notes !== undefined) { sets.push('quote_notes = ?'); vals.push(String(b.quote_notes || '').trim() || null); }

    if (Array.isArray(b.items)) {
      const items = b.items.map((it) => {
        const qty = Math.min(999, Math.max(1, parseInt(it.qty, 10) || 1));
        const unit = it.unit_price_usd === '' || it.unit_price_usd == null ? null : Math.round(Number(it.unit_price_usd) * 100);
        const unitCents = unit != null && Number.isFinite(unit) && unit >= 0 ? unit : null;
        return {
          img: String(it.img || '').trim(),
          name: String(it.name || it.img || '').trim(),
          make_model: String(it.make_model || '').trim(),
          qty,
          list_price_cents: it.list_price_cents != null ? it.list_price_cents : (it.list_price_usd != null ? Math.round(Number(it.list_price_usd) * 100) : null),
          unit_price_cents: unitCents,
          line_total_cents: unitCents != null ? unitCents * qty : null,
        };
      }).filter((it) => it.img || it.name);
      const priced = items.filter((it) => it.unit_price_cents != null);
      const total = priced.reduce((s, it) => s + it.line_total_cents, 0);
      sets.push('items_json = ?'); vals.push(JSON.stringify(items));
      sets.push('quote_total_cents = ?'); vals.push(priced.length ? total : null);
      if (priced.length) {
        sets.push("priced_at = COALESCE(priced_at, datetime('now'))");
        sets.push('priced_by = ?'); vals.push(c.get('user').id);
        if (b.status === undefined && cur.status === 'new') { sets.push('status = ?'); vals.push('quoted'); }
      }
    }
    if (!sets.length) return c.json({ error: 'Nothing to update' }, 400);
    vals.push(id);
    await db.run(`UPDATE parts_inquiries SET ${sets.join(', ')} WHERE id = ?`, ...vals);
    const row = await db.one(
      `SELECT *, quote_total_cents / 100.0 AS quote_total_usd, (photo_data IS NOT NULL) AS has_photo
         FROM parts_inquiries WHERE id = ?`, id);
    delete row.photo_data;
    return c.json({ ok: true, inquiry: row, items: parseItems(row.items_json) });
  });

  // Flip the linked customer's price visibility (users.show_prices). Only
  // works when the request came from a signed-in account.
  app.post('/api/admin/inquiries/:id/show-prices', adminMw, async (c) => {
    const db = d1(c.env);
    const b = await c.req.json().catch(() => ({}));
    const enabled = b.enabled === undefined ? true : !!b.enabled;
    const i = await db.one('SELECT id, user_id, name, email FROM parts_inquiries WHERE id = ?', c.req.param('id'));
    if (!i) return c.json({ error: 'Not found' }, 404);
    if (!i.user_id) {
      return c.json({ error: 'This quote request has no customer account, so there is nobody to show prices to. Ask the customer to create an account and re-submit, or price the quote and send it manually.' }, 400);
    }
    await db.run('UPDATE users SET show_prices = ? WHERE id = ?', enabled ? 1 : 0, i.user_id);
    const u = await db.one('SELECT id, name, email, show_prices FROM users WHERE id = ?', i.user_id);
    return c.json({ ok: true, user: u, show_prices: !!(u && u.show_prices) });
  });

  // Inline photo (R2 is off on this account, so quote-request photos ride in
  // parts_inquiries.photo_data as a BLOB -- see migrations/0009).
  app.get('/api/admin/inquiries/:id/photo', adminMw, async (c) => {
    const row = await d1(c.env).one('SELECT photo_data, photo_type FROM parts_inquiries WHERE id = ?', c.req.param('id'));
    if (!row || !row.photo_data) return c.json({ error: 'No photo' }, 404);
    const bytes = row.photo_data instanceof ArrayBuffer ? new Uint8Array(row.photo_data) : row.photo_data;
    return new Response(bytes, { headers: { 'Content-Type': row.photo_type || 'image/jpeg', 'Cache-Control': 'private, max-age=86400' } });
  });

  // ---- service appointments -----------------------------------
  app.get('/api/admin/appointments', adminMw, async (c) => {
    const appointments = await d1(c.env).many(
      `SELECT id, name, phone, email, vehicle_make, vehicle_model, vehicle_year,
              service_type, preferred_date, time_slot, notes, status, created_at
         FROM service_appointments ORDER BY created_at DESC LIMIT 200`);
    return c.json({ appointments });
  });
  app.patch('/api/admin/appointments/:id', adminMw, async (c) => {
    const { status } = await c.req.json().catch(() => ({}));
    if (!['pending', 'confirmed', 'completed', 'cancelled'].includes(status)) return c.json({ error: 'Invalid status' }, 400);
    await d1(c.env).run('UPDATE service_appointments SET status = ? WHERE id = ?', status, c.req.param('id'));
    return c.json({ ok: true });
  });
  app.get('/api/admin/appointments/calendar', adminMw, async (c) => {
    const anchor = c.req.query('week') ? new Date(c.req.query('week')) : new Date();
    const day = anchor.getUTCDay();
    const diff = day === 0 ? -6 : 1 - day;
    const mon = new Date(anchor); mon.setUTCDate(anchor.getUTCDate() + diff); mon.setUTCHours(0, 0, 0, 0);
    const sat = new Date(mon); sat.setUTCDate(mon.getUTCDate() + 6);
    const ws = mon.toISOString().slice(0, 10), we = sat.toISOString().slice(0, 10);
    const appointments = await d1(c.env).many(
      `SELECT id, name, phone, vehicle_make, vehicle_model, vehicle_year,
              service_type, preferred_date, time_slot, status, notes
         FROM service_appointments
        WHERE date(preferred_date) BETWEEN ? AND ?
        ORDER BY preferred_date ASC, time_slot ASC`, ws, we);
    return c.json({ week_start: ws, week_end: we, appointments });
  });

  // ---- back-in-stock waiting list --------------------------
  app.get('/api/admin/notifications', adminMw, async (c) => {
    const notifications = await d1(c.env).many(
      `SELECT n.id, n.product_img, n.email, n.phone, n.notified_at, n.created_at,
              p.name AS product_name, p.stock_count
         FROM notify_subscriptions n
         LEFT JOIN products p ON p.img = n.product_img
        ORDER BY n.created_at DESC LIMIT 200`);
    return c.json({ notifications });
  });

  // ---- reviews moderation ---------------------------------
  app.get('/api/admin/reviews', adminMw, async (c) => {
    const rows = await d1(c.env).many(
      'SELECT id, name, city, vehicle, rating, body, approved, created_at FROM reviews ORDER BY created_at DESC LIMIT 200');
    return c.json({ reviews: rows.map((r) => boolify(r, ['approved'])) });
  });
  app.patch('/api/admin/reviews/:id', adminMw, async (c) => {
    const db = d1(c.env);
    const id = c.req.param('id');
    const { approved } = await c.req.json().catch(() => ({}));
    await db.run('UPDATE reviews SET approved = ? WHERE id = ?', bit(approved), id);
    if (approved) {
      const rv = await db.one('SELECT user_id FROM reviews WHERE id = ?', id);
      if (rv && rv.user_id) {
        const dup = await db.one("SELECT id FROM points_transactions WHERE reason = 'review' AND reference_id = ?", id);
        if (!dup) await db.run("INSERT INTO points_transactions (user_id, delta, reason, reference_id) VALUES (?, 50, 'review', ?)", rv.user_id, id);
      }
    }
    return c.json({ ok: true });
  });
  app.delete('/api/admin/reviews/:id', adminMw, async (c) => {
    await d1(c.env).run('DELETE FROM reviews WHERE id = ?', c.req.param('id'));
    return c.json({ ok: true });
  });

  // ---- customer addresses (admin-side) --------------------
  app.get('/api/admin/users/:id/addresses', adminMw, async (c) => {
    const addresses = await d1(c.env).many(
      'SELECT * FROM customer_addresses WHERE user_id = ? ORDER BY is_default DESC, created_at DESC', c.req.param('id'));
    return c.json({ addresses });
  });
  app.post('/api/admin/users/:id/addresses', adminMw, async (c) => {
    const db = d1(c.env);
    const uid = c.req.param('id');
    const b = await c.req.json().catch(() => ({}));
    if (!b.line1) return c.json({ error: 'line1 required' }, 400);
    const kind = b.kind || 'shipping';
    if (b.is_default) await db.run("UPDATE customer_addresses SET is_default = 0 WHERE user_id = ? AND COALESCE(kind,'shipping') = ?", uid, kind);
    const r = await db.run(
      `INSERT INTO customer_addresses (user_id, label, kind, recipient, line1, line2, city, parish, postal_code, country, phone, is_default, notes)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      uid, b.label || null, kind, b.recipient || null, b.line1, b.line2 || null,
      b.city || null, b.parish || null, b.postal_code || null, b.country || 'Jamaica', b.phone || null, bit(b.is_default), b.notes || null);
    return c.json({ ok: true, id: r.meta ? r.meta.last_row_id : undefined });
  });
  app.patch('/api/admin/addresses/:id', adminMw, async (c) => {
    const db = d1(c.env);
    const id = c.req.param('id');
    const b = await c.req.json().catch(() => ({}));
    const fields = ['label', 'kind', 'recipient', 'line1', 'line2', 'city', 'parish', 'postal_code', 'country', 'phone', 'is_default', 'notes'];
    const sets = []; const vals = [];
    for (const f of fields) if (b[f] !== undefined) { sets.push(`${f} = ?`); vals.push(f === 'is_default' ? bit(b[f]) : b[f]); }
    if (!sets.length) return c.json({ error: 'Nothing to update' }, 400);
    if (b.is_default) {
      const cur = await db.one("SELECT user_id, COALESCE(kind,'shipping') AS kind FROM customer_addresses WHERE id = ?", id);
      if (cur) await db.run("UPDATE customer_addresses SET is_default = 0 WHERE user_id = ? AND COALESCE(kind,'shipping') = ? AND id <> ?", cur.user_id, b.kind || cur.kind, id);
    }
    vals.push(id);
    await db.run(`UPDATE customer_addresses SET ${sets.join(', ')} WHERE id = ?`, ...vals);
    return c.json({ ok: true });
  });
  app.delete('/api/admin/addresses/:id', adminMw, async (c) => {
    await d1(c.env).run('DELETE FROM customer_addresses WHERE id = ?', c.req.param('id'));
    return c.json({ ok: true });
  });

  // ---- customer contacts (business customers) -------------
  app.get('/api/admin/users/:id/contacts', adminMw, async (c) => {
    const contacts = await d1(c.env).many(
      'SELECT * FROM customer_contacts WHERE user_id = ? ORDER BY is_primary DESC, name ASC', c.req.param('id'));
    return c.json({ contacts });
  });
  app.post('/api/admin/users/:id/contacts', adminMw, async (c) => {
    const db = d1(c.env);
    const uid = c.req.param('id');
    const b = await c.req.json().catch(() => ({}));
    if (!b.name) return c.json({ error: 'name required' }, 400);
    if (b.is_primary) await db.run('UPDATE customer_contacts SET is_primary = 0 WHERE user_id = ?', uid);
    const r = await db.run(
      'INSERT INTO customer_contacts (user_id, name, title, phone, email, is_primary, notes) VALUES (?,?,?,?,?,?,?)',
      uid, b.name, b.title || null, b.phone || null, b.email || null, bit(b.is_primary), b.notes || null);
    return c.json({ ok: true, id: r.meta ? r.meta.last_row_id : undefined });
  });
  app.patch('/api/admin/contacts/:id', adminMw, async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const fields = ['name', 'title', 'phone', 'email', 'is_primary', 'notes'];
    const sets = []; const vals = [];
    for (const f of fields) if (b[f] !== undefined) { sets.push(`${f} = ?`); vals.push(f === 'is_primary' ? bit(b[f]) : b[f]); }
    if (!sets.length) return c.json({ error: 'Nothing to update' }, 400);
    vals.push(c.req.param('id'));
    await d1(c.env).run(`UPDATE customer_contacts SET ${sets.join(', ')} WHERE id = ?`, ...vals);
    return c.json({ ok: true });
  });
  app.delete('/api/admin/contacts/:id', adminMw, async (c) => {
    await d1(c.env).run('DELETE FROM customer_contacts WHERE id = ?', c.req.param('id'));
    return c.json({ ok: true });
  });

  // ---- message inbox (thread rollup) ---------------------
  app.get('/api/admin/messages/inbox', adminMw, async (c) => {
    const threads = await d1(c.env).many(
      `SELECT cm.user_id, u.name AS customer_name, u.email AS customer_email, u.phone AS customer_phone,
              SUM(CASE WHEN cm.read_at IS NULL AND cm.sender = 'customer' THEN 1 ELSE 0 END) AS unread,
              MAX(cm.created_at) AS last_message_at,
              (SELECT body FROM customer_messages m2 WHERE m2.user_id = cm.user_id ORDER BY created_at DESC LIMIT 1) AS last_message
         FROM customer_messages cm
         LEFT JOIN users u ON u.id = cm.user_id
        GROUP BY cm.user_id, u.name, u.email, u.phone
        ORDER BY unread DESC, last_message_at DESC LIMIT 100`);
    return c.json({ threads });
  });

  // ---- coupons ---------------------------------------
  app.get('/api/admin/coupons', adminMw, async (c) => {
    const coupons = await d1(c.env).many(
      `SELECT code, kind, amount, min_subtotal, max_redemptions, redeemed_count,
              expires_at, is_active, description, created_at
         FROM coupons ORDER BY created_at DESC`);
    return c.json({ coupons: coupons.map((r) => boolify(r, ['is_active'])) });
  });
  app.post('/api/admin/coupons', managerMw, async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const code = String(b.code || '').trim().toUpperCase();
    const kind = b.kind === 'percent' ? 'percent' : 'flat';
    const amount = Number(b.amount || 0);
    if (!code || !amount || amount <= 0) return c.json({ error: 'code and positive amount required' }, 400);
    if (kind === 'percent' && amount > 100) return c.json({ error: 'percent cannot exceed 100' }, 400);
    try {
      await d1(c.env).run(
        `INSERT INTO coupons (code, kind, amount, min_subtotal, max_redemptions, expires_at, is_active, description)
           VALUES (?,?,?,?,?,?,?,?)`,
        code, kind, amount, Number(b.min_subtotal || 0), b.max_redemptions ? parseInt(b.max_redemptions, 10) : null,
        b.expires_at || null, b.is_active === false ? 0 : 1, b.description || null);
      return c.json({ ok: true, code });
    } catch (e) {
      if (String(e.message || '').includes('UNIQUE')) return c.json({ error: 'That coupon code already exists' }, 400);
      throw e;
    }
  });
  app.patch('/api/admin/coupons/:code', managerMw, async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const fields = ['amount', 'min_subtotal', 'max_redemptions', 'expires_at', 'is_active', 'description'];
    const sets = []; const vals = [];
    for (const f of fields) if (b[f] !== undefined) { sets.push(`${f} = ?`); vals.push(f === 'is_active' ? bit(b[f]) : b[f]); }
    if (!sets.length) return c.json({ error: 'No fields to update' }, 400);
    vals.push(String(c.req.param('code')).toUpperCase());
    await d1(c.env).run(`UPDATE coupons SET ${sets.join(', ')} WHERE code = ?`, ...vals);
    return c.json({ ok: true });
  });
  app.delete('/api/admin/coupons/:code', managerMw, async (c) => {
    await d1(c.env).run('DELETE FROM coupons WHERE code = ?', String(c.req.param('code')).toUpperCase());
    return c.json({ ok: true });
  });

  // ---- gift cards -----------------------------------
  const GC_USD = (t) => `${t}.id, ${t}.code,
    ${t}.initial_balance_cents / 100.0 AS initial_balance_usd,
    ${t}.balance_cents / 100.0 AS balance_usd, ${t}.is_active,
    ${t}.issued_to_name, ${t}.issued_to_phone, ${t}.issued_by, ${t}.notes,
    ${t}.last_used_at, ${t}.created_at`;

  app.get('/api/admin/gift-cards', adminMw, async (c) => {
    const gift_cards = await d1(c.env).many(
      `SELECT ${GC_USD('gc')}, u.name AS issued_by_name FROM gift_cards gc
         LEFT JOIN users u ON u.id = gc.issued_by ORDER BY gc.created_at DESC LIMIT 200`);
    return c.json({ gift_cards: gift_cards.map((r) => boolify(r, ['is_active'])) });
  });
  app.get('/api/admin/gift-cards/:code', adminMw, async (c) => {
    const db = d1(c.env);
    const gc = await db.one(`SELECT ${GC_USD('gift_cards')} FROM gift_cards WHERE code = ?`, String(c.req.param('code')).toUpperCase());
    if (!gc) return c.json({ error: 'Gift card not found' }, 404);
    const transactions = await db.many(
      'SELECT id, delta_cents / 100.0 AS delta_usd, reason, reference, performed_by, created_at FROM gift_card_transactions WHERE gift_card_id = ? ORDER BY created_at DESC',
      gc.id);
    return c.json({ gift_card: boolify(gc, ['is_active']), transactions });
  });
  app.post('/api/admin/gift-cards', managerMw, async (c) => {
    const db = d1(c.env);
    const b = await c.req.json().catch(() => ({}));
    const amount = Number(b.amount_usd);
    if (!(amount > 0)) return c.json({ error: 'amount_usd must be positive' }, 400);
    const code = b.code ? String(b.code).toUpperCase() : gcCode();
    const uid = c.get('user').id;
    try {
      const r = await db.run(
        `INSERT INTO gift_cards (code, initial_balance_cents, balance_cents, issued_to_name, issued_to_phone, issued_by, notes)
           VALUES (?,?,?,?,?,?,?)`,
        code, cents(amount), cents(amount), b.issued_to_name || null, b.issued_to_phone || null, uid, b.notes || null);
      const id = r.meta.last_row_id;
      await db.run("INSERT INTO gift_card_transactions (gift_card_id, delta_cents, reason, performed_by) VALUES (?,?,'issue',?)", id, cents(amount), uid);
      return c.json({ ok: true, id, code });
    } catch (e) {
      if (String(e.message || '').includes('UNIQUE')) return c.json({ error: 'That gift card code is already in use' }, 400);
      throw e;
    }
  });
  app.post('/api/admin/gift-cards/:code/reload', managerMw, async (c) => {
    const db = d1(c.env);
    const code = String(c.req.param('code')).toUpperCase();
    const amount = Number((await c.req.json().catch(() => ({}))).amount_usd);
    if (!(amount > 0)) return c.json({ error: 'amount_usd must be positive' }, 400);
    const gc = await db.one('SELECT id FROM gift_cards WHERE code = ? AND is_active = 1', code);
    if (!gc) return c.json({ error: 'Gift card not found or inactive' }, 404);
    await db.run('UPDATE gift_cards SET balance_cents = balance_cents + ? WHERE id = ?', cents(amount), gc.id);
    await db.run("INSERT INTO gift_card_transactions (gift_card_id, delta_cents, reason, performed_by) VALUES (?,?,'reload',?)", gc.id, cents(amount), c.get('user').id);
    const after = await db.one('SELECT balance_cents / 100.0 AS b FROM gift_cards WHERE id = ?', gc.id);
    return c.json({ ok: true, balance_usd: after.b });
  });
  app.patch('/api/admin/gift-cards/:code', managerMw, async (c) => {
    const b = await c.req.json().catch(() => ({}));
    if (b.is_active === undefined) return c.json({ error: 'is_active required' }, 400);
    const r = await d1(c.env).run('UPDATE gift_cards SET is_active = ? WHERE code = ?', bit(b.is_active), String(c.req.param('code')).toUpperCase());
    if (!r.meta || !r.meta.changes) return c.json({ error: 'Gift card not found' }, 404);
    return c.json({ ok: true });
  });
}
