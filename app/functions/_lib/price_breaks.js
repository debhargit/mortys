// Pricing helpers -- the single place that turns
//   (retail price, active sale price, the customer's tier price,
//    this product's quantity-break rows, a quantity)
// into "what does one unit actually cost on this line". "Cheapest wins" is
// the rule everywhere: a misconfigured / out-of-order set of inputs can only
// ever help the buyer, never charge more than the retail price.
//
// Quantity-break rows come in two shapes (see migrations 0042 / 0053):
//   { min_qty, price_cents }   -- an absolute per-unit price at that qty
//   { min_qty, discount_pct }  -- a percentage off the RETAIL price at that qty
// loadBreaksByImg() returns both, unified, ascending by min_qty.

// The lowest of the base price and every quantity-break the qty qualifies
// for. `retailCents` is needed to evaluate percentage rows (pct off retail);
// pass it whenever you have it -- an absolute-only set doesn't need it.
export function bestUnitPriceCents(baseCents, breaks, qty, retailCents) {
  let best = baseCents == null ? null : baseCents;
  for (const b of breaks || []) {
    if (qty < b.min_qty) continue;
    let cand = null;
    if (b.price_cents != null) cand = b.price_cents;
    else if (b.discount_pct != null && retailCents != null) cand = Math.round(retailCents * (1 - b.discount_pct / 100));
    if (cand != null && cand >= 0 && (best == null || cand < best)) best = cand;
  }
  return best;
}

// Bounded lookup: attach each product's quantity-break rows (ascending by
// min_qty) to a Map keyed by img, for however many images the caller already
// has on screen. Two small queries unioned in JS rather than a join -- a join
// would multiply every list row by its break count, and most products have
// none.
export async function loadBreaksByImg(db, imgs) {
  const list = [...new Set((imgs || []).filter(Boolean))];
  const map = new Map();
  if (!list.length) return map;
  const ph = list.map(() => '?').join(',');
  const [abs, pct] = await Promise.all([
    db.many(`SELECT product_img, min_qty, price_cents FROM product_price_breaks WHERE product_img IN (${ph})`, ...list),
    db.many(`SELECT product_img, min_qty, discount_pct FROM product_qty_discounts WHERE product_img IN (${ph})`, ...list),
  ]);
  const push = (img, row) => { if (!map.has(img)) map.set(img, []); map.get(img).push(row); };
  for (const r of abs) push(r.product_img, { min_qty: r.min_qty, price_cents: r.price_cents, discount_pct: null });
  for (const r of pct) push(r.product_img, { min_qty: r.min_qty, price_cents: null, discount_pct: r.discount_pct });
  for (const arr of map.values()) arr.sort((a, b) => a.min_qty - b.min_qty);
  return map;
}

export async function loadBreaksForImg(db, img) {
  return (await loadBreaksByImg(db, [img])).get(img) || [];
}

// ---------------------------------------------------------------------------
// Tier price book (migration 0053) -- a per-item absolute price for a
// non-retail customer tier (users.price_tier: trade | fleet | dealer). No row
// for a tier = that tier pays retail.
export async function loadTierPricesByImg(db, imgs) {
  const list = [...new Set((imgs || []).filter(Boolean))];
  const map = new Map();
  if (!list.length) return map;
  const rows = await db.many(
    `SELECT product_img, tier, price_cents FROM product_tier_prices WHERE product_img IN (${list.map(() => '?').join(',')})`,
    ...list
  );
  for (const r of rows) {
    if (!map.has(r.product_img)) map.set(r.product_img, {});
    map.get(r.product_img)[r.tier] = r.price_cents;
  }
  return map;
}

// The cents a given tier pays for this product, or null (retail / no
// override). `entry` is one value from loadTierPricesByImg's Map.
export function tierCentsFor(entry, tier) {
  if (!entry || !tier || tier === 'retail') return null;
  const v = entry[tier];
  return v == null ? null : v;
}

// ---------------------------------------------------------------------------
// Sale pricing (migration 0043) -- a per-product price that only applies
// while "now" falls inside [sale_starts_at, sale_ends_at] (either bound may
// be null: open-ended start = active immediately, open-ended end = no
// auto-expiry). This is the one place that window is evaluated -- splice it
// into any SELECT that already computes price_usd, alongside price_cents, to
// get `active_sale_cents` (null when there's no sale or it isn't in-window).
export const ACTIVE_SALE_PRICE_SQL = `
  CASE WHEN sale_price_cents IS NOT NULL
        AND (sale_starts_at IS NULL OR sale_starts_at <= datetime('now'))
        AND (sale_ends_at   IS NULL OR sale_ends_at   >= datetime('now'))
       THEN sale_price_cents ELSE NULL END`;

// The price everything else (quantity breaks included) should treat as "the
// base price" for this product right now -- the lower of the regular price,
// an active sale price, and the customer's tier price. Breaks then apply on
// top via bestUnitPriceCents, so a customer always gets whichever of
// {regular, sale, tier, bulk} is cheapest. `tierCents` is optional.
export function effectiveBaseCents(priceCents, activeSaleCents, tierCents) {
  let best = priceCents == null ? null : priceCents;
  for (const v of [activeSaleCents, tierCents]) {
    if (v == null) continue;
    if (best == null || v < best) best = v;
  }
  return best;
}

// Same bounded-lookup shape as loadBreaksByImg -- a second small query so
// callers that already fetched price_usd from products (checkout, coupon
// preview) don't have to duplicate ACTIVE_SALE_PRICE_SQL in their own SELECT.
export async function loadActiveSaleCentsByImg(db, imgs) {
  const list = [...new Set((imgs || []).filter(Boolean))];
  const map = new Map();
  if (!list.length) return map;
  const rows = await db.many(
    `SELECT img, ${ACTIVE_SALE_PRICE_SQL} AS active_sale_cents FROM products
      WHERE img IN (${list.map(() => '?').join(',')})`,
    ...list
  );
  for (const r of rows) map.set(r.img, r.active_sale_cents);
  return map;
}
