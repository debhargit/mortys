// Storefront shipping — live rate quotes, label bytes, tracking, and the
// admin (re)book. Carrier specifics live in ../_lib/carriers/*; this module
// is the HTTP surface + the order-row plumbing.
import { d1 } from '../_lib/db.js';
import { adminMw, currentUser } from '../_lib/guards.js';
import { getShopSettings } from '../_lib/shop.js';
import {
  enabledCarrierCodes, getAdapter, originFrom, toFrom, parcelFor, signQuote, localTracking,
} from '../_lib/carriers/index.js';

const cents = (n) => Math.round((Number(n) || 0) * 100);

// May the caller read this order? The owning session, an admin/staff session,
// or a guest whose ?email= matches the order's captured contact.
async function canReadOrder(c, order) {
  const email = (c.req.query('email') || '').trim().toLowerCase();
  if (email && order.customer_email && email === String(order.customer_email).toLowerCase()) return true;
  try {
    const u = await currentUser(c.req.raw, c.env);
    if (u && (u.is_admin || u.is_staff)) return true;
    if (u && order.user_id != null && u.id === order.user_id) return true;
  } catch { /* guest */ }
  return false;
}

// Cart lines with weights, for the parcel estimate.
async function lineWeights(db, items) {
  const list = (Array.isArray(items) ? items : []).filter((it) => it && it.img);
  if (!list.length) return [];
  const imgs = [...new Set(list.map((it) => String(it.img)))].slice(0, 200);
  const rows = await db.many(
    `SELECT img, weight_kg, price_cents / 100.0 AS price_usd, name
       FROM products WHERE img IN (${imgs.map(() => '?').join(',')})`, ...imgs);
  const byImg = new Map(rows.map((r) => [r.img, r]));
  return list.map((it) => {
    const p = byImg.get(String(it.img)) || {};
    return { img: it.img, qty: Math.max(1, parseInt(it.qty, 10) || 1), weight_kg: p.weight_kg, price_usd: p.price_usd, name: p.name };
  });
}

// Book (or re-book) a shipment for an order id. Best-effort: a carrier failure
// leaves the order intact with ship_status='label_failed' for an admin retry.
// Returns { ok, tracking_number, ship_status }.
export async function bookShipment(env, orderId) {
  const db = d1(env);
  const order = await db.one(
    `SELECT id, fulfilment, ship_carrier, ship_service, ship_name, ship_phone, ship_line1, ship_line2,
            ship_city, ship_parish, ship_instructions
       FROM orders WHERE id = ?`, orderId);
  if (!order || !order.fulfilment || order.fulfilment === 'pickup') return { ok: false, skipped: true };
  const settings = await getShopSettings(env);
  const code = order.ship_carrier || 'manual';
  const adapter = getAdapter(code);
  const items = await db.many(
    `SELECT oi.qty, oi.price_cents / 100.0 AS price_usd, p.name, p.weight_kg
       FROM order_items oi LEFT JOIN products p ON p.img = oi.product_img WHERE oi.order_id = ?`, orderId);
  const parcel = parcelFor(items, settings);
  const ctx = { env, settings, origin: originFrom(settings), to: toFrom(order), parcel, order, items };
  try {
    const r = await adapter.ship(ctx);
    await db.run(
      `UPDATE orders SET tracking_number = ?, carrier_ref = ?, label_format = ?, label_data = ?,
              ship_service = COALESCE(?, ship_service), ship_status = 'booked' WHERE id = ?`,
      r.tracking_number || localTracking(orderId), r.carrier_ref || null,
      r.label_format || null, r.label_data || null, r.service || null, orderId);
    return { ok: true, tracking_number: r.tracking_number, ship_status: 'booked' };
  } catch (e) {
    await db.run(
      `UPDATE orders SET tracking_number = COALESCE(tracking_number, ?), ship_status = 'label_failed' WHERE id = ?`,
      localTracking(orderId), orderId);
    return { ok: false, error: String(e && e.message || e), ship_status: 'label_failed' };
  }
}

export default function mount(app) {
  // ---- live rate quote --------------------------------------------------
  app.post('/api/shipping/quote', async (c) => {
    const settings = await getShopSettings(c.env);
    if (!settings.storefront_prices) return c.json({ quotes: [] });
    const b = await c.req.json().catch(() => ({}));
    const to = toFrom({
      parish: b.parish || b.ship_parish, city: b.city || b.ship_city,
      country: b.country || b.ship_country || 'JM', name: b.name || '', phone: b.phone || '',
      line1: b.line1 || b.ship_line1 || '', line2: b.line2 || b.ship_line2 || '',
    });
    if (!to.parish && (to.country === 'JM')) return c.json({ error: 'Choose a parish for a delivery quote.', quotes: [] }, 400);

    const db = d1(c.env);
    const lines = await lineWeights(db, b.items);
    const parcel = parcelFor(lines.length ? lines : [{ qty: 1 }], settings);
    const origin = originFrom(settings);

    const codes = enabledCarrierCodes(settings);
    const out = [];
    await Promise.all(codes.map(async (code) => {
      try {
        const rates = await getAdapter(code).rate({ env: c.env, settings, origin, to, parcel });
        for (const r of (rates || [])) {
          out.push({
            carrier: r.carrier || code,
            service: r.service || null,
            service_label: r.service_label || code,
            amount: Math.round((Number(r.amount) || 0) * 100) / 100,
            currency: r.currency || 'JMD',
            eta_days: r.eta_days ?? null,
            token: await signQuote(c.env, { carrier: r.carrier || code, service: r.service, amount: r.amount }),
          });
        }
      } catch { /* one carrier down shouldn't sink the quote */ }
    }));
    out.sort((a, b2) => a.amount - b2.amount);
    return c.json({ quotes: out, parcel });
  });

  // ---- label bytes ----------------------------------------------------
  app.get('/api/orders/:id/label', async (c) => {
    const db = d1(c.env);
    const order = await db.one(
      'SELECT id, user_id, customer_email, label_format, label_data FROM orders WHERE id = ?', c.req.param('id'));
    if (!order) return c.json({ error: 'Order not found' }, 404);
    if (!(await canReadOrder(c, order))) return c.json({ error: 'Not authorised' }, 403);
    if (!order.label_data) return c.json({ error: 'No carrier label for this order' }, 404);
    const bin = Uint8Array.from(atob(order.label_data), (ch) => ch.charCodeAt(0));
    const type = order.label_format === 'png' ? 'image/png'
      : order.label_format === 'zpl' ? 'application/octet-stream'
        : 'application/pdf';
    return new Response(bin, { headers: { 'Content-Type': type, 'Content-Disposition': `inline; filename="label-${order.id}.${order.label_format || 'pdf'}"` } });
  });

  // ---- tracking -----------------------------------------------------
  app.get('/api/orders/:id/tracking', async (c) => {
    const db = d1(c.env);
    const order = await db.one(
      'SELECT id, user_id, customer_email, ship_carrier, ship_status, tracking_number FROM orders WHERE id = ?', c.req.param('id'));
    if (!order) return c.json({ error: 'Order not found' }, 404);
    if (!(await canReadOrder(c, order))) return c.json({ error: 'Not authorised' }, 403);
    if (!order.tracking_number) return c.json({ tracking_number: null, status: order.ship_status || 'pending', events: [] });
    const settings = await getShopSettings(c.env);
    try {
      const t = await getAdapter(order.ship_carrier || 'manual').track({ env: c.env, settings, tracking_number: order.tracking_number });
      return c.json({ tracking_number: order.tracking_number, carrier: order.ship_carrier || 'manual', ...t });
    } catch (e) {
      return c.json({ tracking_number: order.tracking_number, carrier: order.ship_carrier || 'manual', status: 'unknown', detail: String(e && e.message || e), events: [] });
    }
  });

  // ---- admin: (re)book a shipment ---------------------------------
  app.post('/api/admin/orders/:id/ship', adminMw, async (c) => {
    const r = await bookShipment(c.env, c.req.param('id'));
    if (r.skipped) return c.json({ error: 'That order is a counter pickup — nothing to ship.' }, 400);
    return c.json(r, r.ok ? 200 : 502);
  });
}
