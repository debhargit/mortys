// Phase 4 — POS read paths + the two simple writes (hold, quote). Ports:
//   GET  /api/admin/pos/holds        GET /api/admin/pos/holds/:id
//   POST /api/admin/pos/hold         DELETE /api/admin/pos/holds/:id
//   GET  /api/admin/pos/quotes       GET /api/admin/pos/quotes/:id
//   POST /api/admin/pos/quote
//   GET  /api/admin/pos/sales        GET /api/admin/pos/sales/:id
//   GET  /api/admin/pos/customer-lookup
//   GET  /api/admin/pos/reps
//   GET  /api/admin/pos/walkin-customer
//   GET  /api/admin/pos/locations    GET /api/admin/pos/vehicle-models
//
// The sale / void / return TRANSACTIONS are Phase 5 (D1 has no interactive
// transactions -> they become a computed db.batch()).
//
// D1 notes: pos_holds/pos_quotes/pos_sales store *_cents and items_json as
// TEXT (JSON.parse-able, unlike Postgres jsonb); returns live in pos_returns/
// pos_return_items with refund_cents (not the Postgres pos_sale_returns shape);
// no user_points view -> sum points_transactions; no product_id -> product_img.
import { d1 } from '../_lib/db.js';
import { adminMw } from '../_lib/guards.js';
import { boolify } from '../_lib/util.js';
import { getShopSettings, shopSettingsToShop } from '../_lib/shop.js';
import {
  TAX_RATE, POS_SALE_USD, POS_ITEM_USD, PHONE_DIGITS_SQL,
  nextQuoteNumber, nextHoldNumber,
} from '../_lib/pos.js';

const round2 = (n) => Math.round(n * 100) / 100;
const cents = (usd) => Math.round((Number(usd) || 0) * 100);

export default function mount(app) {
  // ---- holds -------------------------------------------------------
  const HOLD_COLS = `id, hold_number, label, items_json, subtotal_cents,
    customer_id, customer_name, customer_phone, vehicle_info, sales_rep_id,
    sales_rep_name, notes, held_by_name, created_at`;

  app.get('/api/admin/pos/holds', adminMw, async (c) => {
    const holds = await d1(c.env).many(`SELECT ${HOLD_COLS} FROM pos_holds ORDER BY created_at DESC LIMIT 100`);
    return c.json({ holds });
  });

  app.get('/api/admin/pos/holds/:id', adminMw, async (c) => {
    const hold = await d1(c.env).one(`SELECT ${HOLD_COLS} FROM pos_holds WHERE id = ?`, c.req.param('id'));
    if (!hold) return c.json({ error: 'Hold not found' }, 404);
    return c.json({ hold });
  });

  app.post('/api/admin/pos/hold', adminMw, async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const items = Array.isArray(b.items) ? b.items : [];
    if (!items.length) return c.json({ error: 'Cart is empty' }, 400);
    let subtotal = 0;
    for (const it of items) subtotal += (Number(it.unit_price_usd) || 0) * (Number(it.qty) || 0);
    const num = await nextHoldNumber(c.env);
    const uid = c.get('user').id;
    const r = await d1(c.env).run(
      `INSERT INTO pos_holds (hold_number, label, items_json, subtotal_cents, customer_id, customer_name,
                              customer_phone, vehicle_info, sales_rep_id, sales_rep_name, notes, held_by, held_by_name)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?, (SELECT COALESCE(name, email) FROM users WHERE id = ?))`,
      num, b.label || null, JSON.stringify(items), cents(subtotal),
      Number.isInteger(b.customer_id) ? b.customer_id : null, b.customer_name || null,
      b.customer_phone || null, b.vehicle_info || null,
      Number.isInteger(b.sales_rep_id) ? b.sales_rep_id : null, b.sales_rep_name || null,
      b.notes || null, uid, uid
    );
    return c.json({ ok: true, id: r.meta.last_row_id, hold_number: num });
  });

  app.delete('/api/admin/pos/holds/:id', adminMw, async (c) => {
    await d1(c.env).run('DELETE FROM pos_holds WHERE id = ?', c.req.param('id'));
    return c.json({ ok: true });
  });

  // ---- quotes ----------------------------------------------------
  app.get('/api/admin/pos/quotes', adminMw, async (c) => {
    const quotes = await d1(c.env).many(
      `SELECT id, quote_number, customer_name, customer_phone, total_cents / 100.0 AS total_usd,
              status, valid_until, created_at
         FROM pos_quotes ORDER BY created_at DESC LIMIT 200`
    );
    return c.json({ quotes });
  });

  app.get('/api/admin/pos/quotes/:id', adminMw, async (c) => {
    const ref = c.req.param('id');
    const quote = await d1(c.env).one(
      `SELECT *, subtotal_cents / 100.0 AS subtotal_usd, tax_cents / 100.0 AS tax_usd,
              discount_cents / 100.0 AS discount_usd, total_cents / 100.0 AS total_usd
         FROM pos_quotes WHERE id = ? OR quote_number = ?`,
      parseInt(ref, 10) || 0, String(ref).toUpperCase()
    );
    if (!quote) return c.json({ error: 'Quote not found' }, 404);
    return c.json({ quote, shop: shopSettingsToShop(await getShopSettings(c.env)) });
  });

  app.post('/api/admin/pos/quote', adminMw, async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const items = Array.isArray(b.items) ? b.items : [];
    if (!items.length) return c.json({ error: 'At least one item required' }, 400);
    try {
      let subtotal = 0;
      for (const it of items) {
        subtotal += Number(it.unit_price_usd) * Number(it.qty) + Number(it.core_charge_usd || 0) + Number(it.env_fee_usd || 0);
      }
      subtotal = round2(subtotal);
      const discount = Math.max(0, Number(b.discount_usd || 0));
      const taxable = Math.max(0, subtotal - discount);
      const tax = round2(taxable * TAX_RATE);
      const total = round2(taxable + tax);
      const num = await nextQuoteNumber(c.env);
      const settings = await getShopSettings(c.env);
      const validDays = Number(settings.quote_valid_days) || 14;
      const validUntil = b.valid_until || new Date(Date.now() + validDays * 86400000).toISOString().slice(0, 10);
      const r = await d1(c.env).run(
        `INSERT INTO pos_quotes (quote_number, cashier_id, customer_id, customer_name, customer_phone, customer_email,
                                 vehicle_info, subtotal_cents, tax_cents, discount_cents, total_cents, items_json,
                                 valid_until, notes, sales_rep_id, sales_rep_name, created_by, status)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'open')`,
        num, b.cashier_id || null, Number.isInteger(b.customer_id) ? b.customer_id : null,
        b.customer_name || null, b.customer_phone || null, b.customer_email || null,
        b.vehicle_info || null, cents(subtotal), cents(tax), cents(discount), cents(total),
        JSON.stringify(items), validUntil, b.notes || null,
        Number.isInteger(b.sales_rep_id) ? b.sales_rep_id : null,
        b.sales_rep_name ? String(b.sales_rep_name).slice(0, 200) : null,
        c.get('user').id || null
      );
      return c.json({ ok: true, id: r.meta.last_row_id, quote_number: num, total_usd: total, total_cents: cents(total) });
    } catch (e) {
      return c.json({ error: e.message }, 500);
    }
  });

  // ---- sales list + detail -------------------------------------
  // Recall (POS F8) uses this both for the date-range Invoices tab and, when
  // `q` is given, to jump straight to a specific receipt/invoice number --
  // that search runs across every date, not just the picked range, since the
  // whole point is not having to know when the sale happened.
  app.get('/api/admin/pos/sales', adminMw, async (c) => {
    const q = c.req.query();
    const includeVoided = q.include_voided === '1' || q.include_voided === 'true';
    const term = String(q.q || '').trim();
    const db = d1(c.env);
    let sales;
    if (term) {
      const like = '%' + term + '%';
      sales = await db.many(
        `SELECT s.*, ${POS_SALE_USD}, COALESCE(u.name, u.email) AS cashier_name
           FROM pos_sales s LEFT JOIN users u ON u.id = s.cashier_id
          WHERE (s.receipt_number LIKE ? OR s.invoice_number LIKE ?) ${includeVoided ? '' : 'AND s.voided = 0'}
          ORDER BY s.created_at DESC LIMIT 200`,
        like, like
      );
    } else {
      const today = new Date().toISOString().slice(0, 10);
      const from = q.from || today;
      const to = q.to || from;
      sales = await db.many(
        `SELECT s.*, ${POS_SALE_USD}, COALESCE(u.name, u.email) AS cashier_name
           FROM pos_sales s LEFT JOIN users u ON u.id = s.cashier_id
          WHERE date(s.created_at) BETWEEN date(?) AND date(?) ${includeVoided ? '' : 'AND s.voided = 0'}
          ORDER BY s.created_at DESC LIMIT 200`,
        from, to
      );
    }
    for (const s of sales) boolify(s, ['voided', 'tax_exempt']);
    return c.json({ sales });
  });

  // ---- returns / credit notes list ------------------------------
  // Same shape as the sales list above: a date range by default, or `q`
  // searching the return number and the parent sale's receipt/invoice number
  // across all time.
  app.get('/api/admin/pos/returns', adminMw, async (c) => {
    const q = c.req.query();
    const term = String(q.q || '').trim();
    const db = d1(c.env);
    const cols = `r.*, r.refund_cents / 100.0 AS refund_total_usd,
              r.refund_subtotal_cents / 100.0 AS refund_subtotal_usd,
              r.refund_discount_cents / 100.0 AS refund_discount_usd,
              r.refund_tax_cents / 100.0 AS refund_tax_usd,
              s.receipt_number, s.invoice_number, s.customer_name, s.voided AS sale_voided,
              COALESCE(u.name, u.email) AS processed_by_name`;
    let returns;
    if (term) {
      const like = '%' + term + '%';
      returns = await db.many(
        `SELECT ${cols} FROM pos_returns r
           JOIN pos_sales s ON s.id = r.sale_id LEFT JOIN users u ON u.id = r.processed_by
          WHERE r.return_number LIKE ? OR s.receipt_number LIKE ? OR s.invoice_number LIKE ?
          ORDER BY r.created_at DESC LIMIT 200`,
        like, like, like
      );
    } else {
      const today = new Date().toISOString().slice(0, 10);
      const from = q.from || today;
      const to = q.to || from;
      returns = await db.many(
        `SELECT ${cols} FROM pos_returns r
           JOIN pos_sales s ON s.id = r.sale_id LEFT JOIN users u ON u.id = r.processed_by
          WHERE date(r.created_at) BETWEEN date(?) AND date(?)
          ORDER BY r.created_at DESC LIMIT 200`,
        from, to
      );
    }
    return c.json({ returns });
  });

  app.get('/api/admin/pos/sales/:id', adminMw, async (c) => {
    const db = d1(c.env);
    const id = c.req.param('id');
    const sale = await db.one(
      `SELECT s.*, ${POS_SALE_USD}, COALESCE(u.name, u.email) AS cashier_name
         FROM pos_sales s LEFT JOIN users u ON u.id = s.cashier_id WHERE s.id = ?`, id
    );
    if (!sale) return c.json({ error: 'Sale not found' }, 404);
    boolify(sale, ['voided', 'tax_exempt']);

    const items = await db.many(
      `SELECT psi.*, ${POS_ITEM_USD},
              p.name AS product_name, p.bin_location, p.location, p.stock_count, p.sku,
              COALESCE((SELECT SUM(pri.qty) FROM pos_return_items pri
                         JOIN pos_returns r ON r.id = pri.return_id
                        WHERE pri.sale_item_id = psi.id), 0) AS returned_qty
         FROM pos_sale_items psi LEFT JOIN products p ON p.img = psi.product_img
        WHERE psi.sale_id = ? ORDER BY psi.id`, id
    );
    const payments = await db.many(
      `SELECT *, amount_cents / 100.0 AS amount_usd, amount_tendered_cents / 100.0 AS amount_tendered
         FROM sale_payments WHERE sale_id = ? ORDER BY id`, id
    );
    const returns = await db.many(
      `SELECT r.*, r.refund_cents / 100.0 AS refund_total_usd,
              NULL AS refund_subtotal_usd, NULL AS refund_discount_usd, NULL AS refund_tax_usd, NULL AS store_credit_code,
              COALESCE(u.name, u.email) AS processed_by_name
         FROM pos_returns r LEFT JOIN users u ON u.id = r.processed_by
        WHERE r.sale_id = ? ORDER BY r.created_at DESC`, id
    );
    if (returns.length) {
      const ids = returns.map((r) => r.id);
      const retItems = await db.many(
        `SELECT pri.return_id, pri.qty, pri.refund_cents / 100.0 AS refund_usd,
                psi.description, pri.product_img, psi.unit_price_cents / 100.0 AS unit_price_usd, p.sku
           FROM pos_return_items pri
           LEFT JOIN pos_sale_items psi ON psi.id = pri.sale_item_id
           LEFT JOIN products p ON p.img = pri.product_img
          WHERE pri.return_id IN (${ids.map(() => '?').join(',')}) ORDER BY pri.id`, ...ids
      );
      const byRet = {};
      for (const it of retItems) (byRet[it.return_id] = byRet[it.return_id] || []).push(it);
      for (const r of returns) r.items = byRet[r.id] || [];
    }
    return c.json({ sale, items, payments, returns });
  });

  // ---- customer lookup for the tender modal --------------------
  app.get('/api/admin/pos/customer-lookup', adminMw, async (c) => {
    const q = c.req.query();
    const phone = String(q.phone || '').trim();
    const term = String(q.q || '').trim().toLowerCase();
    if (!phone && !term) return c.json({ matches: [] });
    const digits = phone.replace(/\D/g, '');
    const cond = [];
    const b = [];
    if (digits.length >= 4) {
      cond.push(`${PHONE_DIGITS_SQL('u.phone')} LIKE ?`);
      b.push('%' + digits.slice(-7) + '%');
    }
    if (term) {
      cond.push(`(lower(coalesce(u.name,'')) LIKE ? OR lower(coalesce(u.email,'')) LIKE ? OR lower(coalesce(u.account_number,'')) LIKE ?)`);
      b.push('%' + term + '%', '%' + term + '%', '%' + term + '%');
    }
    const rows = await d1(c.env).many(
      `SELECT u.id, u.name, u.email, u.phone, u.price_tier, u.discount_pct, u.account_number,
              u.credit_limit_cents / 100.0 AS credit_limit_usd, u.payment_terms_days, u.discount_limit_pct, u.tax_exempt,
              COALESCE((SELECT SUM(delta) FROM points_transactions pt WHERE pt.user_id = u.id), 0) AS points_balance,
              (COALESCE((SELECT SUM(sp.amount_cents) FROM sale_payments sp JOIN pos_sales s ON s.id = sp.sale_id
                          WHERE sp.method = 'account' AND s.customer_id = u.id AND s.voided = 0), 0)
               - COALESCE((SELECT SUM(amount_cents) FROM account_payments WHERE customer_id = u.id), 0)) AS open_balance_cents,
              (SELECT vehicle_info FROM pos_sales WHERE customer_id = u.id AND vehicle_info IS NOT NULL
                 ORDER BY created_at DESC LIMIT 1) AS last_vehicle
         FROM users u
        WHERE ${cond.join(' OR ')}
        ORDER BY u.name LIMIT 10`,
      ...b
    );
    for (const r of rows) boolify(r, ['tax_exempt']);
    return c.json({ matches: rows });
  });

  // ---- sales-rep picker --------------------------------------
  app.get('/api/admin/pos/reps', adminMw, async (c) => {
    const db = d1(c.env);
    const rows = await db.many(
      `SELECT m.id, m.user_id, m.name, m.role, m.email
         FROM mechanics m
        WHERE m.is_active = 1
          AND (
            m.user_id IS NULL
            OR EXISTS (SELECT 1 FROM user_category_members mem JOIN user_categories cc ON cc.id = mem.category_id
                        WHERE mem.user_id = m.user_id AND cc.is_active = 1
                          AND cc.code IN ('sales_rep','cashier','service_advisor','mechanic'))
            OR NOT EXISTS (SELECT 1 FROM user_category_members mem WHERE mem.user_id = m.user_id)
          )
        ORDER BY m.name`
    );
    const me = c.get('user');
    const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();
    let meRepId = null;
    let hit = rows.find((r) => r.user_id != null && r.user_id === me.id);
    if (!hit && norm(me.email)) hit = rows.find((r) => norm(r.email) && norm(r.email) === norm(me.email));
    if (!hit && norm(me.name)) {
      const byName = rows.filter((r) => norm(r.name) === norm(me.name));
      if (byName.length === 1) hit = byName[0];
    }
    meRepId = hit ? hit.id : null;
    return c.json({
      reps: rows.map((r) => ({ id: r.id, user_id: r.user_id, name: r.name, role: r.role })),
      me_rep_id: meRepId,
    });
  });

  // Staff who can unlock a POS terminal: anyone with a PIN set. Used by the
  // lock screen when shop_settings.pos_enforce_login is on. Name + id only --
  // the PIN itself is checked by POST /api/admin/staff/pin-verify.
  app.get('/api/admin/pos/operators', adminMw, async (c) => {
    const rows = await d1(c.env).many(
      `SELECT id, name FROM users
        WHERE pin_hash IS NOT NULL AND is_staff = 1 AND (disabled IS NULL OR disabled = 0)
        ORDER BY name`
    );
    return c.json({ operators: rows });
  });

  app.get('/api/admin/pos/walkin-customer', adminMw, async (c) => {
    const row = await d1(c.env).one(
      "SELECT id, name, account_number FROM users WHERE email = 'walkin@mortysautoparts.local' LIMIT 1"
    );
    if (!row) return c.json({ error: 'Walk-in account not seeded yet' }, 404);
    return c.json({ customer: row });
  });

  app.get('/api/admin/pos/locations', adminMw, async (c) => {
    const rows = await d1(c.env).many(
      "SELECT DISTINCT location FROM products WHERE is_active = 1 AND location IS NOT NULL AND location <> '' ORDER BY location"
    );
    return c.json({ locations: rows.map((r) => r.location) });
  });

  app.get('/api/admin/pos/vehicle-models', adminMw, async (c) => {
    const rows = await d1(c.env).many(
      "SELECT DISTINCT make_model FROM products WHERE is_active = 1 AND make_model IS NOT NULL AND make_model <> '' ORDER BY make_model"
    );
    return c.json({ models: rows.map((r) => r.make_model) });
  });
}
