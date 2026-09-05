// Phase 10 — customer-facing completion. Ports server.js:
//   POST /api/auth/signup, POST /api/auth/reset-default-admin, PATCH /api/me
//   POST /api/checkout, GET /api/orders, GET /api/orders/:id
//   GET  /api/points, GET /api/config, GET /api/vin/:vin
//   POST /api/newsletter, POST /api/coupon/validate
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
import { getShopSettings } from '../_lib/shop.js';
import { verifyQuote } from '../_lib/carriers/index.js';
import { bookShipment } from './shipping.js';
import { fygaroEnabled, buildCheckoutUrl } from '../_lib/fygaro.js';
import { bestUnitPriceCents, loadBreaksByImg } from '../_lib/price_breaks.js';

const SITE_BASE = 'https://mortsautoparts.com';

const POINTS_USD_RATE = 0.05;
const r2 = (n) => Math.round(n * 100) / 100;
const cents = (usd) => Math.round((Number(usd) || 0) * 100);
const digits7 = (s) => String(s || '').replace(/[^\d]/g, '').slice(-7);

async function pointsBalance(db, userId) {
  const r = await db.one('SELECT COALESCE(SUM(delta),0) AS b FROM points_transactions WHERE user_id = ?', userId);
  return (r && r.b) || 0;
}

// Reprice a fetched line list against each product's quantity breaks --
// checkout always starts from products.price_cents (never a client-supplied
// price), so this only ever brings the charged price *down* to whatever the
// line's own quantity qualifies for. Mutates price_usd in place; skips lines
// with no price (already flagged unpriced elsewhere) or no breaks at all.
async function repriceForQty(db, items) {
  const breaksByImg = await loadBreaksByImg(db, items.map((it) => it.product_img));
  for (const it of items) {
    if (it.price_usd == null) continue;
    const breaks = breaksByImg.get(it.product_img) || [];
    if (!breaks.length) continue;
    const baseCents = cents(it.price_usd);
    const effCents = bestUnitPriceCents(baseCents, breaks, it.qty);
    if (effCents != null && effCents < baseCents) it.price_usd = r2(effCents / 100);
  }
  return items;
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

// ---- shipping -------------------------------------------------------
const PARISHES = [
  'Kingston', 'St. Andrew', 'St. Catherine', 'Clarendon', 'Manchester',
  'St. Elizabeth', 'Westmoreland', 'Hanover', 'St. James', 'Trelawny',
  'St. Ann', 'St. Mary', 'Portland', 'St. Thomas',
];
const CARRIERS = ['dhl', 'fedex', 'knutsford', 'manual'];

function enabledCarriers(s) {
  const out = [];
  if (s.carrier_dhl_enabled) out.push('dhl');
  if (s.carrier_fedex_enabled) out.push('fedex');
  if (s.carrier_knutsford_enabled) out.push('knutsford');
  if (s.carrier_manual_enabled !== false && s.carrier_manual_enabled !== 0) out.push('manual');
  return out;
}

// Pull the fulfilment + address off a checkout body into { fulfilment, fee,
// cols } where `cols` is the exact set of orders columns to write. A pickup
// order writes nothing but the default 'pickup'. The fee is trusted from the
// client for now (clamped >= 0); Phase 3 swaps it for a signed quote token.
// `trusted` is the verified /api/shipping/quote token payload, when present:
// { carrier, service, amount }. It wins over the raw client fee/carrier so a
// shopper can't hand-edit the freight down.
function parseShip(b, trusted) {
  const ful = ['pickup', 'delivery', 'shipping'].includes(b.fulfilment) ? b.fulfilment : 'pickup';
  if (ful === 'pickup') return { fulfilment: 'pickup', fee: 0, cols: { fulfilment: 'pickup' } };
  const s = (v, n = 200) => (v == null ? null : (String(v).trim().slice(0, n) || null));
  const fee = trusted ? Math.max(0, r2(trusted.amount)) : Math.max(0, r2(Number(b.ship_fee_usd) || 0));
  const carrier = trusted && CARRIERS.includes(trusted.carrier) ? trusted.carrier
    : (CARRIERS.includes(b.ship_carrier) ? b.ship_carrier : 'manual');
  return {
    fulfilment: ful,
    fee,
    cols: {
      fulfilment: ful,
      ship_name: s(b.ship_name, 120),
      ship_phone: s(b.ship_phone, 40),
      ship_line1: s(b.ship_line1),
      ship_line2: s(b.ship_line2),
      ship_city: s(b.ship_city, 80),
      ship_parish: PARISHES.includes(b.ship_parish) ? b.ship_parish : null,
      ship_instructions: s(b.ship_instructions, 600),
      ship_carrier: carrier,
      ship_service: (trusted && trusted.service) ? String(trusted.service).slice(0, 80) : s(b.ship_service, 80),
      ship_fee_cents: cents(fee),
    },
  };
}
function shipError(ship) {
  if (ship.fulfilment === 'pickup') return null;
  if (!ship.cols.ship_line1) return 'A delivery address (street) is required.';
  if (!ship.cols.ship_parish) return 'Please choose a parish.';
  if (!ship.cols.ship_name) return 'A recipient name is required for delivery.';
  return null;
}
// Build an `INSERT INTO orders` statement from a column->value map, so the
// authed and guest checkout paths can share one insert with different columns.
function orderInsertStmt(orderId, cols) {
  const keys = Object.keys(cols);
  return {
    sql: `INSERT INTO orders (id, ${keys.join(', ')}) VALUES (?, ${keys.map(() => '?').join(', ')})`,
    binds: [orderId, ...keys.map((k) => cols[k])],
  };
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
    const existing = await db.one("SELECT id FROM users WHERE email = 'admin@mortysautoparts.com'");
    if (existing) {
      await db.run('UPDATE users SET is_admin = 1, password_hash = ? WHERE id = ?', hash, existing.id);
    } else {
      const id = await nextId(db, 'users');
      await db.run(
        `INSERT INTO users (id, email, name, password_hash, via, is_admin)
           VALUES (?, 'admin@mortysautoparts.com', 'Morty''s Auto Parts Admin', ?, 'local', 1)`, id, hash);
    }
    return c.json({ ok: true, email: 'admin@mortysautoparts.com', password: 'password123' });
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
  // ordering_enabled follows the global shop_settings.storefront_prices
  // switch: off => the cart can only file a quote request (POST /api/inquiry);
  // on => prices are public and cash-pickup / bank-transfer checkout works.
  // show_prices also turns on for an admin/staff session or a per-account
  // users.show_prices override.
  app.get('/api/config', async (c) => {
    const s = await getShopSettings(c.env);
    const ordering = !!s.storefront_prices;
    let showPrices = ordering;
    if (!showPrices) {
      try { const u = await currentUser(c.req.raw, c.env); showPrices = !!(u && (u.is_admin || u.is_staff || u.show_prices)); } catch { /* guest */ }
    }
    const fygaro = ordering && fygaroEnabled(c.env, s);
    return c.json({
      payments: {
        stripe_enabled: false, stripe_publishable_key: null,
        fygaro_enabled: !!fygaro,
        methods: ordering ? ['cash_pickup', 'bank_transfer', ...(fygaro ? ['fygaro'] : [])] : [],
      },
      ordering_enabled: ordering,
      show_prices: showPrices,
      shipping: {
        carriers: enabledCarriers(s),
        parishes: PARISHES,
        origin_parish: s.ship_origin_parish || null,
        local_flat_usd: Number(s.ship_local_flat_usd) || 0,
      },
    });
  });

  // ---- coupon pre-check ----------------------------------------
  app.post('/api/coupon/validate', authMw, async (c) => {
    const db = d1(c.env);
    const uid = c.get('user').id;
    const r = await loadCoupon(db, (await c.req.json().catch(() => ({}))).code);
    if (!r.ok) return c.json({ error: r.error }, 400);
    const items = await db.many(
      'SELECT c.product_img, c.qty, p.price_cents / 100.0 AS price_usd FROM cart_items c JOIN products p ON p.img = c.product_img WHERE c.user_id = ?', uid);
    await repriceForQty(db, items);
    const subtotal = r2(items.reduce((s, it) => s + Number(it.price_usd || 0) * it.qty, 0));
    const { discount, reason } = computeCouponDiscount(r.coupon, subtotal);
    if (discount === 0 && reason) return c.json({ error: reason }, 400);
    return c.json({ code: r.coupon.code, kind: r.coupon.kind, amount: r.coupon.amount, description: r.coupon.description, subtotal, discount_usd: discount });
  });

  // ---- checkout ------------------------------------------------
  // Checkout for a signed-in customer. Prices come from the server-side cart;
  // shipping (fulfilment + address + fee) rides along and the fee is added to
  // the order total after discounts. Card is still rejected (no Stripe here).
  app.post('/api/checkout', authMw, async (c) => {
    const settings = await getShopSettings(c.env);
    if (!settings.storefront_prices) {
      return c.json({
        error: 'Online ordering is disabled. Please submit a quote request and the parts desk will price it and call you back.',
        code: 'quote_only',
      }, 400);
    }
    const db = d1(c.env);
    const uid = c.get('user').id;
    const b = await c.req.json().catch(() => ({}));
    const method = b.payment_method || 'cash_pickup';
    if (!['cash_pickup', 'bank_transfer', 'stripe', 'fygaro', 'invoice_email'].includes(method)) return c.json({ error: 'Invalid payment_method' }, 400);
    if (method === 'stripe') return c.json({ error: 'Online card payment is not available' }, 400);
    if (method === 'fygaro' && !fygaroEnabled(c.env, settings)) return c.json({ error: 'Card payment is not available right now.' }, 400);

    const ship = parseShip(b, await verifyQuote(c.env, b.ship_quote_token));
    const shipErr = shipError(ship);
    if (shipErr) return c.json({ error: shipErr, code: 'ship_incomplete' }, 400);

    const items = await db.many(
      `SELECT c.product_img, c.qty, p.price_cents / 100.0 AS price_usd, p.name, p.make_model
         FROM cart_items c JOIN products p ON p.img = c.product_img WHERE c.user_id = ?`, uid);
    if (!items.length) return c.json({ error: 'Cart is empty' }, 400);
    if (items.some((it) => it.price_usd == null)) {
      return c.json({ error: 'Some items in your cart are not priced — remove them or submit a quote request for the whole cart.', code: 'unpriced_items' }, 400);
    }
    await repriceForQty(db, items);
    const subtotal = r2(items.reduce((s, it) => s + Number(it.price_usd || 0) * it.qty, 0));
    let total = subtotal;

    let couponCode = null, couponDiscount = 0;
    if (b.coupon_code) {
      const cr = await loadCoupon(db, b.coupon_code);
      if (cr.ok) {
        const cd = computeCouponDiscount(cr.coupon, total);
        if (cd.discount > 0) { couponCode = cr.coupon.code; couponDiscount = cd.discount; total = r2(total - couponDiscount); }
      }
    }

    let redeemPts = Math.max(0, parseInt(b.redeem_points || 0, 10) || 0);
    let pointsDiscount = 0;
    if (redeemPts > 0) {
      const bal = await pointsBalance(db, uid);
      redeemPts = Math.min(redeemPts, bal, Math.floor(total / POINTS_USD_RATE));
      pointsDiscount = r2(redeemPts * POINTS_USD_RATE);
      total = Math.max(0, r2(total - pointsDiscount));
    }

    const merchTotal = total;                       // earns points; freight excluded
    const grandTotal = r2(merchTotal + ship.fee);   // what the customer pays

    const orderId = await nextId(db, 'orders');
    const stmts = [orderInsertStmt(orderId, {
      user_id: uid, total_cents: cents(grandTotal), notes: b.notes || null,
      payment_method: method, coupon_code: couponCode, coupon_discount_cents: cents(couponDiscount),
      ...ship.cols,
    })];
    for (const it of items) {
      stmts.push({ sql: 'INSERT INTO order_items (order_id, product_img, qty, price_cents) VALUES (?,?,?,?)',
        binds: [orderId, it.product_img, it.qty, cents(it.price_usd || 0)] });
    }
    if (couponCode) {
      stmts.push({ sql: `INSERT OR IGNORE INTO coupon_redemptions (coupon_code, user_id, order_id, discount_usd) VALUES (?,?,?,?)`,
        binds: [couponCode, uid, orderId, couponDiscount] });
      stmts.push({ sql: 'UPDATE coupons SET redeemed_count = redeemed_count + 1 WHERE code = ?', binds: [couponCode] });
    }
    if (redeemPts > 0) {
      stmts.push({ sql: "INSERT INTO points_transactions (user_id, delta, reason, reference_id) VALUES (?,?,'redemption',?)",
        binds: [uid, -redeemPts, orderId] });
    }
    stmts.push({ sql: 'DELETE FROM cart_items WHERE user_id = ?', binds: [uid] });
    await db.batch(stmts);

    const earnedPoints = Math.floor(merchTotal);
    if (earnedPoints > 0) {
      await db.run("INSERT INTO points_transactions (user_id, delta, reason, reference_id) VALUES (?,?,'purchase',?)",
        uid, earnedPoints, orderId);
    }

    const u = await db.one('SELECT email, name FROM users WHERE id = ?', uid);
    if (u && u.email) {
      const li = items.map((it) => ({ product_img: it.product_img, qty: it.qty, price_usd: it.price_usd, name: it.name, make_model: it.make_model }));
      const tpl = method === 'invoice_email'
        ? templates.invoiceEmail({ name: u.name, orderId, items: li, total: grandTotal, payUrl: `https://mortsautoparts.com/order-print.html?order=${orderId}` })
        : templates.orderEmail({ name: u.name, orderId, items: li, total: grandTotal });
      c.executionCtx?.waitUntil?.(sendEmail(c.env, { to: u.email, ...tpl }).catch(() => {}));
    }

    let shipResult = null;
    if (ship.fulfilment !== 'pickup') {
      shipResult = await bookShipment(c.env, orderId).catch(() => null);
    }

    const checkoutUrl = method === 'fygaro'
      ? await buildCheckoutUrl({ env: c.env, settings, orderId, amount: grandTotal, redirectUrl: `${SITE_BASE}/order-success.html?order=${orderId}` })
      : null;

    return c.json({
      order_id: orderId, subtotal_usd: subtotal, total_usd: grandTotal, ship_fee_usd: ship.fee, fulfilment: ship.fulfilment,
      status: 'pending', payment_method: method, checkout_url: checkoutUrl,
      tracking_number: shipResult && shipResult.tracking_number || null,
      ship_status: shipResult ? shipResult.ship_status : null,
      points_redeemed: redeemPts, points_discount_usd: pointsDiscount, points_earned: earnedPoints,
      coupon_code: couponCode, coupon_discount_usd: couponDiscount,
    });
  });

  // Guest checkout — no account. Same body as /api/checkout plus contact
  // (name / email / phone) and an explicit items:[{img,qty}] list, since a
  // guest has no server-side cart. No loyalty points; coupons still apply.
  app.post('/api/checkout/guest', async (c) => {
    const settings = await getShopSettings(c.env);
    if (!settings.storefront_prices) {
      return c.json({
        error: 'Online ordering is disabled. Please submit a quote request and the parts desk will price it and call you back.',
        code: 'quote_only',
      }, 400);
    }
    const db = d1(c.env);
    const b = await c.req.json().catch(() => ({}));

    const name = (b.name || '').trim();
    const email = (b.email || '').trim().toLowerCase();
    const phone = (b.phone || '').trim();
    if (!name || (!email && !phone)) return c.json({ error: 'Name and an email or phone are required' }, 400);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return c.json({ error: 'That email address looks wrong' }, 400);

    const method = b.payment_method || 'cash_pickup';
    if (!['cash_pickup', 'bank_transfer', 'fygaro', 'invoice_email'].includes(method)) return c.json({ error: 'Invalid payment_method' }, 400);
    if (method === 'invoice_email' && !email) return c.json({ error: 'An email address is required to receive an invoice.' }, 400);
    if (method === 'fygaro' && !fygaroEnabled(c.env, settings)) return c.json({ error: 'Card payment is not available right now.' }, 400);

    const ship = parseShip(b, await verifyQuote(c.env, b.ship_quote_token));
    const shipErr = shipError(ship);
    if (shipErr) return c.json({ error: shipErr, code: 'ship_incomplete' }, 400);

    const reqItems = (Array.isArray(b.items) ? b.items : []).filter((it) => it && it.img);
    if (!reqItems.length) return c.json({ error: 'Cart is empty' }, 400);
    const imgs = [...new Set(reqItems.map((it) => String(it.img)))].slice(0, 200);
    const rows = await db.many(
      `SELECT img, price_cents / 100.0 AS price_usd, name, make_model
         FROM products WHERE img IN (${imgs.map(() => '?').join(',')})`, ...imgs);
    const byImg = new Map(rows.map((r) => [r.img, r]));
    const items = reqItems.map((it) => {
      const p = byImg.get(String(it.img));
      if (!p) return null;
      return { product_img: p.img, qty: Math.max(1, parseInt(it.qty, 10) || 1), price_usd: p.price_usd, name: p.name, make_model: p.make_model };
    }).filter(Boolean);
    if (!items.length) return c.json({ error: 'None of those items are still available' }, 400);
    if (items.some((it) => it.price_usd == null)) {
      return c.json({ error: 'Some items in your cart are not priced — submit a quote request for the whole cart.', code: 'unpriced_items' }, 400);
    }
    await repriceForQty(db, items);

    const subtotal = r2(items.reduce((s, it) => s + Number(it.price_usd || 0) * it.qty, 0));
    let total = subtotal;
    let couponCode = null, couponDiscount = 0;
    if (b.coupon_code) {
      const cr = await loadCoupon(db, b.coupon_code);
      if (cr.ok) {
        const cd = computeCouponDiscount(cr.coupon, total);
        if (cd.discount > 0) { couponCode = cr.coupon.code; couponDiscount = cd.discount; total = r2(total - couponDiscount); }
      }
    }
    const grandTotal = r2(total + ship.fee);

    const orderId = await nextId(db, 'orders');
    const stmts = [orderInsertStmt(orderId, {
      user_id: null, total_cents: cents(grandTotal), notes: b.notes || null,
      payment_method: method, coupon_code: couponCode, coupon_discount_cents: cents(couponDiscount),
      customer_name: name, customer_email: email || null, customer_phone: phone || null, source: 'storefront',
      ...ship.cols,
    })];
    for (const it of items) {
      stmts.push({ sql: 'INSERT INTO order_items (order_id, product_img, qty, price_cents) VALUES (?,?,?,?)',
        binds: [orderId, it.product_img, it.qty, cents(it.price_usd || 0)] });
    }
    if (couponCode) {
      stmts.push({ sql: `INSERT OR IGNORE INTO coupon_redemptions (coupon_code, user_id, order_id, discount_usd) VALUES (?,?,?,?)`,
        binds: [couponCode, null, orderId, couponDiscount] });
      stmts.push({ sql: 'UPDATE coupons SET redeemed_count = redeemed_count + 1 WHERE code = ?', binds: [couponCode] });
    }
    await db.batch(stmts);

    if (email) {
      const li = items.map((it) => ({ product_img: it.product_img, qty: it.qty, price_usd: it.price_usd, name: it.name, make_model: it.make_model }));
      const tpl = method === 'invoice_email'
        ? templates.invoiceEmail({ name, orderId, items: li, total: grandTotal, payUrl: `https://mortsautoparts.com/order-print.html?order=${orderId}&email=${encodeURIComponent(email)}` })
        : templates.orderEmail({ name, orderId, items: li, total: grandTotal });
      c.executionCtx?.waitUntil?.(sendEmail(c.env, { to: email, ...tpl }).catch(() => {}));
    }

    let shipResult = null;
    if (ship.fulfilment !== 'pickup') {
      shipResult = await bookShipment(c.env, orderId).catch(() => null);
    }

    const checkoutUrl = method === 'fygaro'
      ? await buildCheckoutUrl({ env: c.env, settings, orderId, amount: grandTotal, redirectUrl: `${SITE_BASE}/order-success.html?order=${orderId}` })
      : null;

    return c.json({
      order_id: orderId, subtotal_usd: subtotal, total_usd: grandTotal, ship_fee_usd: ship.fee, fulfilment: ship.fulfilment,
      status: 'pending', payment_method: method, checkout_url: checkoutUrl,
      tracking_number: shipResult && shipResult.tracking_number || null,
      ship_status: shipResult ? shipResult.ship_status : null,
      coupon_code: couponCode, coupon_discount_usd: couponDiscount,
    });
  });

  // ---- order history ----------------------------------------
  app.get('/api/orders', authMw, async (c) => {
    const orders = await d1(c.env).many(
      `SELECT id, total_cents / 100.0 AS total_usd, status, payment_method, payment_status, created_at
         FROM orders WHERE user_id = ? ORDER BY created_at DESC`, c.get('user').id);
    return c.json({ orders });
  });
  const ORDER_DETAIL_COLS = `id, total_cents / 100.0 AS total_usd, ship_fee_cents / 100.0 AS ship_fee_usd,
      coupon_code, coupon_discount_cents / 100.0 AS coupon_discount_usd,
      status, payment_method, payment_status, notes, created_at,
      customer_name, customer_email, customer_phone,
      fulfilment, ship_name, ship_phone, ship_line1, ship_line2, ship_city, ship_parish,
      ship_instructions, ship_carrier, ship_service, ship_status, tracking_number`;

  app.get('/api/orders/:id', authMw, async (c) => {
    const db = d1(c.env);
    const order = await db.one(
      `SELECT ${ORDER_DETAIL_COLS} FROM orders WHERE id = ? AND user_id = ?`, c.req.param('id'), c.get('user').id);
    if (!order) return c.json({ error: 'Order not found' }, 404);
    const items = await db.many(
      `SELECT oi.product_img, oi.qty, oi.price_cents / 100.0 AS price_usd, p.name, p.make_model
         FROM order_items oi LEFT JOIN products p ON p.img = oi.product_img WHERE oi.order_id = ?`, c.req.param('id'));
    return c.json({ order, items });
  });

  // Order detail for the print/receipt page. No session needed: a guest passes
  // ?email= and it must match the order's captured contact email; a signed-in
  // customer can also read their own order this way.
  app.get('/api/orders/:id/print', async (c) => {
    const db = d1(c.env);
    const id = c.req.param('id');
    const order = await db.one(`SELECT ${ORDER_DETAIL_COLS}, user_id FROM orders WHERE id = ?`, id);
    if (!order) return c.json({ error: 'Order not found' }, 404);
    const email = (c.req.query('email') || '').trim().toLowerCase();
    let ok = email && order.customer_email && email === String(order.customer_email).toLowerCase();
    if (!ok && order.user_id != null) {
      try { const u = await currentUser(c.req.raw, c.env); ok = !!(u && (u.id === order.user_id || u.is_admin || u.is_staff)); } catch { /* guest */ }
    }
    if (!ok) return c.json({ error: 'Not authorised to view this order' }, 403);
    delete order.user_id;
    const items = await db.many(
      `SELECT oi.product_img, oi.qty, oi.price_cents / 100.0 AS price_usd, p.name, p.make_model
         FROM order_items oi LEFT JOIN products p ON p.img = oi.product_img WHERE oi.order_id = ?`, id);
    const shop = await getShopSettings(c.env);
    return c.json({
      order, items,
      shop: { name: shop.company_name, address: shop.address, phone: shop.phone, email: shop.email },
    });
  });

  // ---- newsletter -----------------------------------------
  app.post('/api/newsletter', async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const email = (b.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return c.json({ error: 'Valid email required' }, 400);
    await d1(c.env).run('INSERT OR IGNORE INTO newsletter_subscribers (email, source) VALUES (?, ?)', email, b.source || null);
    return c.json({ ok: true });
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
