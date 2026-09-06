// Redeemable items (e.g. lottery scratch cards) — modeled on the gift-card
// shape in admin_crm.js: a sale (functions/_routes/pos_txn.js) mints one row
// here per unit of an `is_redeemable` product sold; these endpoints manage
// its lifecycle afterward.
//   GET  /api/admin/redemptions            GET /api/admin/redemptions/:code
//   POST /api/admin/redemptions/:code/redeem   POST /api/admin/redemptions/:code/void
import { d1 } from '../_lib/db.js';
import { adminMw, managerMw } from '../_lib/guards.js';
import { boolify } from '../_lib/util.js';
import { usdToCents, centsToUsd } from '../_lib/money.js';

const RI_USD = `id, code, product_img, sale_id, sale_item_id, status,
  face_value_cents / 100.0 AS face_value_usd,
  payout_cents / 100.0 AS payout_usd,
  sold_by, redeemed_by, redeemed_at, notes, created_at`;

export default function mount(app) {
  // Bulk-load real printed instrument codes for a redeemable product as
  // 'in_stock' -- a sale then assigns the next one instead of minting RD-xxxx.
  app.post('/api/admin/redemptions/load', managerMw, async (c) => {
    const db = d1(c.env);
    const b = await c.req.json().catch(() => ({}));
    const img = String(b.product_img || '').trim();
    const p = img ? await db.one('SELECT img, price_cents, is_redeemable FROM products WHERE img = ?', img) : null;
    if (!p) return c.json({ error: 'Product not found' }, 404);
    if (!p.is_redeemable) return c.json({ error: 'That product is not a redeemable item' }, 400);
    const note = b.note ? String(b.note).slice(0, 200) : null;
    const raw = Array.isArray(b.codes) ? b.codes : String(b.codes || '').split(/[\r\n,]+/);
    const seen = new Set();
    const codes = [];
    for (const x of raw) {
      const v = String(x || '').trim().toUpperCase().slice(0, 60);
      if (!v || seen.has(v)) continue;
      seen.add(v); codes.push(v);
    }
    if (!codes.length) return c.json({ error: 'No codes given' }, 400);
    await db.batch(codes.map((code) => ({
      sql: `INSERT OR IGNORE INTO redemption_instruments (code, product_img, status, face_value_cents, received_at, received_note)
            VALUES (?,?,'in_stock',?,CURRENT_TIMESTAMP,?)`,
      binds: [code, img, p.price_cents || 0, note],
    })));
    const n = await db.one(`SELECT COUNT(*) AS n FROM redemption_instruments WHERE product_img = ? AND status = 'in_stock'`, img);
    return c.json({ ok: true, in_stock: n ? n.n : 0 });
  });

  app.get('/api/admin/redemptions', adminMw, async (c) => {
    const status = c.req.query('status');
    const where = status && ['in_stock', 'sold', 'redeemed', 'void'].includes(status) ? 'WHERE ri.status = ?' : '';
    const rows = await d1(c.env).many(
      `SELECT ri.id, ri.code, ri.product_img, ri.sale_id, ri.sale_item_id, ri.status,
              ri.face_value_cents / 100.0 AS face_value_usd, ri.payout_cents / 100.0 AS payout_usd,
              ri.sold_by, ri.redeemed_by, ri.redeemed_at, ri.notes, ri.created_at,
              p.name AS product_name, sb.name AS sold_by_name, rb.name AS redeemed_by_name
         FROM redemption_instruments ri
         LEFT JOIN products p ON p.img = ri.product_img
         LEFT JOIN users sb ON sb.id = ri.sold_by
         LEFT JOIN users rb ON rb.id = ri.redeemed_by
         ${where}
        ORDER BY ri.created_at DESC LIMIT 500`,
      ...(where ? [status] : [])
    );
    return c.json({ redemptions: rows });
  });

  app.get('/api/admin/redemptions/:code', adminMw, async (c) => {
    const db = d1(c.env);
    const code = String(c.req.param('code')).toUpperCase();
    const ri = await db.one(`SELECT ${RI_USD} FROM redemption_instruments WHERE code = ?`, code);
    if (!ri) return c.json({ error: 'Not found' }, 404);
    const [product, sale] = await Promise.all([
      db.one('SELECT img, name, sku FROM products WHERE img = ?', ri.product_img),
      ri.sale_id ? db.one('SELECT id, receipt_number, created_at FROM pos_sales WHERE id = ?', ri.sale_id) : null,
    ]);
    return c.json({ redemption: ri, product, sale });
  });

  app.post('/api/admin/redemptions/:code/redeem', adminMw, async (c) => {
    const db = d1(c.env);
    const me = c.get('user');
    const code = String(c.req.param('code')).toUpperCase();
    const ri = await db.one('SELECT id, status FROM redemption_instruments WHERE code = ?', code);
    if (!ri) return c.json({ error: 'Not found' }, 404);
    if (ri.status !== 'sold') return c.json({ error: `This instrument is already ${ri.status}` }, 400);
    const b = await c.req.json().catch(() => ({}));
    const payoutCents = b.payout_usd != null && b.payout_usd !== '' ? usdToCents(b.payout_usd) : null;
    await db.run(
      `UPDATE redemption_instruments
          SET status = 'redeemed', payout_cents = ?, redeemed_by = ?, redeemed_at = CURRENT_TIMESTAMP,
              notes = COALESCE(?, notes)
        WHERE id = ?`,
      payoutCents, me.id, b.notes ? String(b.notes).slice(0, 500) : null, ri.id
    );
    return c.json({ ok: true, payout_usd: payoutCents != null ? centsToUsd(payoutCents) : null });
  });

  app.post('/api/admin/redemptions/:code/void', managerMw, async (c) => {
    const db = d1(c.env);
    const code = String(c.req.param('code')).toUpperCase();
    const ri = await db.one('SELECT id, status FROM redemption_instruments WHERE code = ?', code);
    if (!ri) return c.json({ error: 'Not found' }, 404);
    if (ri.status === 'redeemed') return c.json({ error: 'Already redeemed — cannot void' }, 400);
    const b = await c.req.json().catch(() => ({}));
    await db.run(`UPDATE redemption_instruments SET status = 'void', notes = COALESCE(?, notes) WHERE id = ?`,
      b.notes ? String(b.notes).slice(0, 500) : null, ri.id);
    return c.json({ ok: true });
  });
}
