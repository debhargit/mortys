// Payment webhooks for the storefront. Currently just Fygaro (hosted card
// checkout — see _lib/fygaro.js). Fygaro POSTs here after a card payment; we
// verify the signed JWT and mark the matching order paid.
import { d1 } from '../_lib/db.js';
import { getShopSettings } from '../_lib/shop.js';
import { verifyWebhook } from '../_lib/fygaro.js';

export default function mount(app) {
  app.post('/api/webhooks/fygaro', async (c) => {
    const settings = await getShopSettings(c.env);
    const result = await verifyWebhook({ env: c.env, settings, request: c.req.raw });
    if (!result) return c.json({ error: 'invalid signature' }, 400);

    const orderId = parseInt(result.reference, 10);
    if (!Number.isFinite(orderId)) return c.json({ ok: true, ignored: 'no order reference' });

    const db = d1(c.env);
    const order = await db.one('SELECT id, payment_status, total_cents FROM orders WHERE id = ?', orderId);
    if (!order) return c.json({ ok: true, ignored: 'unknown order' });

    if (result.paid) {
      // Audit H1: a signed "paid" is only good for the amount and currency the
      // order was raised for. Anything else leaves the order untouched.
      if (result.amount == null || Math.round(result.amount * 100) !== Number(order.total_cents)) {
        return c.json({ error: 'amount mismatch' }, 400);
      }
      if (result.currency && result.currency !== result.expectedCurrency) {
        return c.json({ error: 'currency mismatch' }, 400);
      }
      // Only advance an unpaid order; a replayed webhook is a no-op.
      if (order.payment_status !== 'paid') {
        await db.run(
          `UPDATE orders SET payment_status = 'paid', payment_ref = ?, status = CASE WHEN status = 'pending' THEN 'confirmed' ELSE status END WHERE id = ?`,
          result.txnId || null, orderId);
      }
      return c.json({ ok: true, order_id: orderId, payment_status: 'paid' });
    }

    // A declined / cancelled result — record the ref, leave it unpaid.
    if (order.payment_status !== 'paid') {
      await db.run("UPDATE orders SET payment_status = 'failed', payment_ref = ? WHERE id = ?", result.txnId || null, orderId);
    }
    return c.json({ ok: true, order_id: orderId, payment_status: result.status });
  });
}
