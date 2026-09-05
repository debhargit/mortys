// Coupon lookup + discount math -- shared by the storefront checkout
// (customer.js) and the POS tender (pos_txn.js), so a code behaves exactly
// the same whether it's typed in online or read off a card at the counter.
// See migrations/0021 (coupons, coupon_redemptions) and 0046 (coupon_scopes).
const r2 = (n) => Math.round(n * 100) / 100;

export async function loadCoupon(db, rawCode) {
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
  // A coupon with no scope rows applies to the whole cart (unchanged
  // behaviour); one with rows only discounts matching category/product lines.
  const scopes = await db.many('SELECT category, product_img FROM coupon_scopes WHERE coupon_code = ?', code);
  return { ok: true, coupon: c, scopes };
}

// `items` need product_img/category/qty/price_usd (a POS line's per-unit
// price after any sale/bulk pricing already applied, or the storefront's own
// repriceForQty() result -- either way, the same price the sale will
// actually charge).
export function computeCouponDiscount(coupon, items, scopes) {
  const cartSubtotal = r2(items.reduce((s, it) => s + Number(it.price_usd || 0) * it.qty, 0));
  if (cartSubtotal < Number(coupon.min_subtotal || 0))
    return { discount: 0, reason: `Minimum subtotal $${Number(coupon.min_subtotal).toFixed(2)} not met` };
  let base = cartSubtotal;
  if (scopes && scopes.length) {
    const cats = new Set(scopes.filter((s) => s.category).map((s) => s.category));
    const imgs = new Set(scopes.filter((s) => s.product_img).map((s) => s.product_img));
    base = r2(items.reduce((s, it) => (imgs.has(it.product_img) || cats.has(it.category)) ? s + Number(it.price_usd || 0) * it.qty : s, 0));
    if (base <= 0) return { discount: 0, reason: "This coupon doesn't apply to anything in your cart" };
  }
  const raw = coupon.kind === 'percent' ? r2(base * (Number(coupon.amount) / 100)) : Number(coupon.amount);
  return { discount: Math.min(raw, base), reason: null };
}
