// Multiple product images (migration 0057). products.img is the identity +
// fallback photo; product_images holds the extras; products
// .primary_image_override, when set, is the photo shown in lists / grid /
// cards. Bounded-lookup helper, same philosophy as price_breaks.js / kits.js.

// The url shown as the thumbnail for a product row (needs `img` and, when
// selected in the SELECT, `primary_image_override`).
export function primaryUrl(row) {
  return (row && row.primary_image_override) || (row && row.img) || null;
}

// Map<img, [{ id, url, caption, sort_order }]>  -- the extra shots only.
export async function loadImagesByImg(db, imgs) {
  const list = [...new Set((imgs || []).filter(Boolean))];
  const map = new Map();
  if (!list.length) return map;
  const rows = await db.many(
    `SELECT product_img, id, url, caption, sort_order FROM product_images
      WHERE product_img IN (${list.map(() => '?').join(',')})
      ORDER BY product_img, sort_order, id`,
    ...list
  );
  for (const r of rows) {
    if (!map.has(r.product_img)) map.set(r.product_img, []);
    map.get(r.product_img).push({ id: r.id, url: r.url, caption: r.caption || null, sort_order: r.sort_order });
  }
  return map;
}

export async function loadImagesForImg(db, img) {
  return (await loadImagesByImg(db, [img])).get(img) || [];
}

// Ordered gallery for a product-detail view: the effective primary first,
// then the original `img` if it was overridden, then the product_images rows
// (de-duped against those two by url).
export function galleryFor(row, extras) {
  const prim = primaryUrl(row);
  const seen = new Set();
  const out = [];
  const push = (url, caption, is_primary) => {
    if (!url || seen.has(url)) return;
    seen.add(url); out.push({ url, caption: caption || null, is_primary: !!is_primary });
  };
  push(prim, null, true);
  if (row && row.img && row.img !== prim) push(row.img, null, false);
  for (const e of extras || []) push(e.url, e.caption, false);
  return out;
}
