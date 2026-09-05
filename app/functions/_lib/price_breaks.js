// Quantity-break (bulk) pricing helpers -- shared by every place that has to
// turn (base price, this product's break rows, a quantity) into "what does
// one unit actually cost on this line". See migrations/0042.

// The lowest of the base price and every break the quantity qualifies for --
// so a misconfigured or out-of-order set of rows can never charge *more*
// than the base price, only ever the best price the quantity earns.
export function bestUnitPriceCents(baseCents, breaks, qty) {
  let best = baseCents == null ? null : baseCents;
  for (const b of breaks || []) {
    if (qty >= b.min_qty && b.price_cents != null && (best == null || b.price_cents < best)) best = b.price_cents;
  }
  return best;
}

// Bounded lookup: attach each product's break rows (ascending by min_qty) to
// a Map keyed by img, for however many images the caller already has on
// screen (a page of search results, a cart, one scanned part). Deliberately
// a second small query rather than a join -- a join would multiply every
// list row by however many breaks it has, and most products have none.
export async function loadBreaksByImg(db, imgs) {
  const list = [...new Set((imgs || []).filter(Boolean))];
  const map = new Map();
  if (!list.length) return map;
  const rows = await db.many(
    `SELECT product_img, min_qty, price_cents FROM product_price_breaks
      WHERE product_img IN (${list.map(() => '?').join(',')}) ORDER BY product_img, min_qty`,
    ...list
  );
  for (const r of rows) {
    if (!map.has(r.product_img)) map.set(r.product_img, []);
    map.get(r.product_img).push({ min_qty: r.min_qty, price_cents: r.price_cents });
  }
  return map;
}

export async function loadBreaksForImg(db, img) {
  return (await loadBreaksByImg(db, [img])).get(img) || [];
}
