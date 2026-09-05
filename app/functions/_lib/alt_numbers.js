// Alternate / interchange part numbers (migration 0054). Bounded-lookup
// helpers, same philosophy as price_breaks.js / kits.js -- a second small
// query for the handful of imgs on screen, never a join folded into a list
// SELECT.

// Map<img, [{ number, kind, note }, ...]>
export async function loadAltNumbersByImg(db, imgs) {
  const list = [...new Set((imgs || []).filter(Boolean))];
  const map = new Map();
  if (!list.length) return map;
  const rows = await db.many(
    `SELECT product_img, number, kind, note FROM product_alt_numbers
      WHERE product_img IN (${list.map(() => '?').join(',')})
      ORDER BY product_img, id`,
    ...list
  );
  for (const r of rows) {
    if (!map.has(r.product_img)) map.set(r.product_img, []);
    map.get(r.product_img).push({ number: r.number, kind: r.kind || null, note: r.note || null });
  }
  return map;
}

export async function loadAltNumbersForImg(db, img) {
  return (await loadAltNumbersByImg(db, [img])).get(img) || [];
}
