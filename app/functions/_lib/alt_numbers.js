// Alternate / interchange part numbers (migration 0054) and substitute
// product links (0055). Bounded-lookup helpers, same philosophy as
// price_breaks.js / kits.js -- a second small query for the handful of imgs
// on screen, never a join folded into a list SELECT.
import { ACTIVE_SALE_PRICE_SQL, effectiveBaseCents } from './price_breaks.js';

// Relationship labels derived from the row's free-text `kind`. Forward = "for
// THIS part, the linked part is ...". Reverse = seen from the linked part's
// side ("this part is <reverse> <the other part>").
const norm = (k) => String(k || '').trim().toLowerCase().replace(/[\s_-]+/g, ' ');
export function fwdLabel(kind) {
  const k = norm(kind);
  if (k === 'supersedes') return 'supersedes';
  if (k === 'superseded by' || k === 'superseded') return 'superseded by';
  if (k === 'interchange' || k === 'interchangeable') return 'interchangeable with';
  if (k === 'oem') return 'OEM equivalent';
  return 'substitute';
}
export function revLabel(kind) {
  const k = norm(kind);
  if (k === 'supersedes') return 'superseded by';
  if (k === 'superseded by' || k === 'superseded') return 'supersedes';
  if (k === 'interchange' || k === 'interchangeable') return 'interchangeable with';
  if (k === 'oem') return 'aftermarket equivalent';
  return 'a substitute for';
}

function subShape(r, p) {
  // r.* = alt-number row aliases (s_*), p = plain "products" row aliases.
  const priceCents = p
    ? effectiveBaseCents(p.price_cents, p.sale_cents)
    : effectiveBaseCents(r.s_price_cents, r.s_sale_cents);
  const stock = Number(p ? p.stock_count : r.s_stock) || 0;
  const low = p ? p.low_threshold : r.s_low;
  const itemType = p ? p.item_type : r.s_item_type;
  const level = itemType === 'service' ? 'in' : stock <= 0 ? 'out' : (low != null && stock <= low) ? 'low' : 'in';
  return {
    img: p ? p.img : r.substitute_img,
    name: p ? p.name : r.s_name,
    sku: (p ? p.sku : r.s_sku) || null,
    is_active: !!(p ? p.is_active : r.s_active),
    price_cents: priceCents,
    price_usd: priceCents != null ? priceCents / 100 : null,
    stock_count: stock,
    stock_level: level,
  };
}

// Map<img, [{ number, kind, note, substitute_img, substitute? }]>
export async function loadAltNumbersByImg(db, imgs) {
  const list = [...new Set((imgs || []).filter(Boolean))];
  const map = new Map();
  if (!list.length) return map;
  const rows = await db.many(
    `SELECT an.product_img, an.number, an.kind, an.note, an.substitute_img,
            s.name AS s_name, s.sku AS s_sku, s.is_active AS s_active,
            s.price_cents AS s_price_cents, ${ACTIVE_SALE_PRICE_SQL} AS s_sale_cents,
            s.stock_count AS s_stock, s.low_threshold AS s_low, s.item_type AS s_item_type
       FROM product_alt_numbers an
       LEFT JOIN products s ON s.img = an.substitute_img
      WHERE an.product_img IN (${list.map(() => '?').join(',')})
      ORDER BY an.product_img, an.id`,
    ...list
  );
  for (const r of rows) {
    if (!map.has(r.product_img)) map.set(r.product_img, []);
    map.get(r.product_img).push({
      number: r.number,
      kind: r.kind || null,
      note: r.note || null,
      substitute_img: r.substitute_img || null,
      substitute: r.substitute_img && r.s_name != null ? subShape(r, null) : null,
    });
  }
  return map;
}

export async function loadAltNumbersForImg(db, img) {
  return (await loadAltNumbersByImg(db, [img])).get(img) || [];
}

// Map<img, { forward: [...], reverse: [...] }> -- the substitute *products*
// linked to each img, both ways round. `forward` = links stored on this
// part; `reverse` = links other parts stored pointing AT this part (shown
// with an inverted label). Each entry: the linked part's
// img/name/sku/price/stock plus `relationship` (a label) and `kind` (raw).
export async function loadSubstitutesByImg(db, imgs) {
  const list = [...new Set((imgs || []).filter(Boolean))];
  const out = new Map();
  if (!list.length) return out;
  for (const img of list) out.set(img, { forward: [], reverse: [] });

  const fwd = await loadAltNumbersByImg(db, list);
  for (const [img, rows] of fwd) {
    const bucket = out.get(img);
    for (const row of rows) {
      if (!row.substitute || !row.substitute.is_active) continue;
      bucket.forward.push({ ...row.substitute, kind: row.kind, relationship: fwdLabel(row.kind), note: row.note });
    }
  }

  const revRows = await db.many(
    `SELECT an.substitute_img AS target, an.kind, an.note,
            p.img, p.name, p.sku, p.is_active, p.price_cents,
            ${ACTIVE_SALE_PRICE_SQL} AS sale_cents,
            p.stock_count, p.low_threshold, p.item_type
       FROM product_alt_numbers an
       JOIN products p ON p.img = an.product_img
      WHERE an.substitute_img IN (${list.map(() => '?').join(',')}) AND p.is_active = 1
      ORDER BY an.substitute_img, an.id`,
    ...list
  );
  for (const r of revRows) {
    const bucket = out.get(r.target);
    if (!bucket) continue;
    bucket.reverse.push({ ...subShape(null, r), kind: r.kind, relationship: revLabel(r.kind), note: r.note || null });
  }
  return out;
}

export async function loadSubstitutesForImg(db, img) {
  return (await loadSubstitutesByImg(db, [img])).get(img) || { forward: [], reverse: [] };
}
