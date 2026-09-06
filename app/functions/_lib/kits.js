// Kit / bundle helpers (migration 0052). A kit is a product with is_kit = 1
// and one or more kit_components rows. It carries no stock of its own --
// everything here derives price / availability / the sale-time explosion
// from the components.
//
// Same bounded-lookup philosophy as price_breaks.js: a second small query
// for the handful of kit imgs actually on screen, never a join folded into
// a list SELECT (that multiplies row-reads).
import { ACTIVE_SALE_PRICE_SQL, effectiveBaseCents } from './price_breaks.js';

const r2 = (n) => Math.round(n * 100) / 100;

// Map<kitImg, [componentRow, ...]> for however many kit imgs the caller has.
// Each row carries the component's live product fields the callers need:
// price (+ active sale), stock, item_type, and every gate flag so a kit can
// inherit its components' restrictions.
export async function loadKitComponentsByImg(db, kitImgs) {
  const list = [...new Set((kitImgs || []).filter(Boolean))];
  const map = new Map();
  if (!list.length) return map;
  const rows = await db.many(
    `SELECT kc.kit_img, kc.component_img, kc.qty_each, kc.sort_order,
            p.name, p.price_cents, ${ACTIVE_SALE_PRICE_SQL} AS active_sale_cents,
            p.stock_count, p.item_type, p.serial_required,
            p.restricted_instore_only, p.restricted_manager_approval,
            p.restricted_id_required, p.restricted_tax_id_required, p.is_redeemable
       FROM kit_components kc JOIN products p ON p.img = kc.component_img
      WHERE kc.kit_img IN (${list.map(() => '?').join(',')})
      ORDER BY kc.kit_img, kc.sort_order, kc.id`,
    ...list
  );
  for (const r of rows) {
    if (!map.has(r.kit_img)) map.set(r.kit_img, []);
    map.get(r.kit_img).push(r);
  }
  return map;
}

export async function loadKitComponentsForImg(db, img) {
  return (await loadKitComponentsByImg(db, [img])).get(img) || [];
}

// Roll-up price in cents: sum of each component's effective unit price (the
// lower of regular / active-sale, via price_breaks.js) times how many of it
// the kit contains. A component with no price (e.g. a service line) adds 0.
export function kitRollupCents(components) {
  let total = 0;
  for (const c of components || []) {
    const base = effectiveBaseCents(c.price_cents, c.active_sale_cents);
    total += (base == null ? 0 : base) * (Number(c.qty_each) || 1);
  }
  return total;
}

// How many whole kits the components on hand can make -- min over components
// of floor(stock_count / qty_each). `service` components impose no limit.
// Returns Infinity when nothing constrains it (all-service / no components);
// callers decide how to present that.
export function kitBuildableQty(components) {
  let min = Infinity;
  for (const c of components || []) {
    if (c.item_type === 'service') continue;
    const per = Math.max(1, Number(c.qty_each) || 1);
    const canMake = Math.floor((Number(c.stock_count) || 0) / per);
    if (canMake < min) min = canMake;
  }
  return min === Infinity ? Infinity : Math.max(0, min);
}

// Expand one kit cart line into its component lines. Used two ways:
//   - exploded kit_line_mode: the POS cart / storefront show these instead
//     of the kit;
//   - single kit_line_mode: the qty half of each entry is the void/return
//     restock snapshot stored on pos_sale_items.kit_components_json.
//
// qty  = kit line qty * component qty_each
// price:
//   rollup -> each component at its own effective unit price
//   fixed  -> the kit's unit price split across components pro-rata by
//             effective-price weight (equal split if nothing is priced);
//             per-unit rounded to cents, so an exploded kit's line sum can
//             differ from the kit price by a cent -- acceptable for v1.
export function explodeKitLine(kitItem, components, priceMode) {
  const list = components || [];
  const lineQty = Math.max(1, Number(kitItem.qty) || 1);
  const kitUnit = Number(kitItem.unit_price_usd) || 0;

  const weights = list.map((c) => {
    const base = effectiveBaseCents(c.price_cents, c.active_sale_cents);
    return (base == null ? 0 : base) * (Number(c.qty_each) || 1);
  });
  const W = weights.reduce((s, w) => s + w, 0);

  return list.map((c, i) => {
    const per = Number(c.qty_each) || 1;
    let unit;
    if (priceMode === 'rollup') {
      const base = effectiveBaseCents(c.price_cents, c.active_sale_cents);
      unit = (base == null ? 0 : base) / 100;
    } else if (W > 0) {
      unit = r2((kitUnit * weights[i]) / (W * per));
    } else {
      unit = r2(kitUnit / (list.length * per));
    }
    return {
      product_img: c.component_img,
      description: c.name || c.component_img,
      qty: lineQty * per,
      unit_price_usd: unit,
      serial_required: !!c.serial_required,
      item_type: c.item_type,
    };
  });
}
