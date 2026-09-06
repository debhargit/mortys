// Serial register (migration 0056) + pre-loaded redemption instruments
// (0047 + 0056). Bounded-lookup helpers, same philosophy as price_breaks.js /
// kits.js: a second small query for the handful of imgs on screen.

// Map<img, { in_stock: N, available: [serial, ...] }>  -- in-stock serials
// for each product, oldest first (FIFO assignment at the counter).
export async function loadSerialStockByImg(db, imgs) {
  const list = [...new Set((imgs || []).filter(Boolean))];
  const map = new Map();
  if (!list.length) return map;
  const rows = await db.many(
    `SELECT product_img, serial FROM product_serials
      WHERE status = 'in_stock' AND product_img IN (${list.map(() => '?').join(',')})
      ORDER BY product_img, id`,
    ...list
  );
  for (const r of rows) {
    if (!map.has(r.product_img)) map.set(r.product_img, { in_stock: 0, available: [] });
    const e = map.get(r.product_img);
    e.in_stock++; e.available.push(r.serial);
  }
  return map;
}

// Map<img, N>  -- count of pre-loaded, unsold redemption instruments.
export async function loadRedeemableStockByImg(db, imgs) {
  const list = [...new Set((imgs || []).filter(Boolean))];
  const map = new Map();
  if (!list.length) return map;
  const rows = await db.many(
    `SELECT product_img, COUNT(*) AS n FROM redemption_instruments
      WHERE status = 'in_stock' AND product_img IN (${list.map(() => '?').join(',')})
      GROUP BY product_img`,
    ...list
  );
  for (const r of rows) map.set(r.product_img, r.n);
  return map;
}

// The oldest in-stock redemption instrument code for a product, or null.
export async function nextInstrumentCode(db, img) {
  const r = await db.one(
    `SELECT code FROM redemption_instruments WHERE product_img = ? AND status = 'in_stock' ORDER BY id LIMIT 1`,
    img
  );
  return r ? r.code : null;
}
