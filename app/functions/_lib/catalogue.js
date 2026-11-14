// Guest catalogue assembly, shared by the storefront request path
// (functions/_routes/storefront.js) and the cron precompute
// (functions/_lib/jobs.js -> catalogue-cache). Keeping one builder guarantees
// the packed shape the storefront JS expects is identical whether a page is
// built live or served from the KV cache.
//
// D1 bills rows *scanned*, so a full-catalogue load is expensive even though the
// data is small. The cron builds this once and stores it in KV; guests then read
// KV (no D1 rows). See storefront.js for how the KV copy is served.
import { loadKitComponentsByImg, kitBuildableQty } from './kits.js';
import { loadAltNumbersByImg } from './alt_numbers.js';

// Must match storefront.js: the columns the packed row is built from.
export const COMPACT_COLS = `img, name, make_model, category, condition, price_cents, stock_count, low_threshold,
  bin_location, is_kit, kit_price_mode, COALESCE(primary_image_override, img) AS thumb_url`;

const byText = (a, b) => (a == null ? -1 : b == null ? 1 : a < b ? -1 : a > b ? 1 : 0);
export const JS_SORTS = {
  name: (a, b) => byText(a.category, b.category) || byText(a.name, b.name),
  name_asc: (a, b) => byText(a.name, b.name),
  name_desc: (a, b) => byText(b.name, a.name),
  stock_asc: (a, b) => (a.stock_count - b.stock_count) || byText(a.name, b.name),
  stock_desc: (a, b) => (b.stock_count - a.stock_count) || byText(a.name, b.name),
};

// Read the whole matching catalogue in cheap rowid ranges, sort in JS, and pack
// into the storefront's positional rows. Returns { cats, rows, total }.
export async function assembleGuestCatalogue(db, where, binds, sortKey = 'name') {
  const rows = [];
  for (let last = -1; ;) {
    const part = await db.many(
      `SELECT rowid AS rid, ${COMPACT_COLS} FROM products WHERE rowid > ? AND ${where} ORDER BY rowid LIMIT 5000`,
      last, ...binds);
    rows.push(...part);
    if (part.length < 5000) break;
    last = part[part.length - 1].rid;
  }
  rows.sort(JS_SORTS[sortKey] || JS_SORTS.name);

  const kitImgs = rows.filter((r) => r.is_kit).map((r) => r.img);
  if (kitImgs.length) {
    const compMap = await loadKitComponentsByImg(db, kitImgs);
    for (const r of rows) {
      if (!r.is_kit) continue;
      const buildable = kitBuildableQty(compMap.get(r.img) || []);
      r.stock_count = Number.isFinite(buildable) ? buildable : 9999;
    }
  }
  const altByImg = await loadAltNumbersByImg(db, rows.map((r) => r.img));
  const catIndex = {}, cats = [];
  const packed = rows.map((r) => {
    const cat = r.category || '';
    if (!(cat in catIndex)) { catIndex[cat] = cats.length; cats.push(cat); }
    const condIdx = String(r.condition || '').toUpperCase() === 'USED' ? 1 : 0;
    const alt = (altByImg.get(r.img) || []).map((a) => a.number).join(' ');
    const thumb = r.thumb_url && r.thumb_url !== r.img ? r.thumb_url : '';
    const row = [r.img, r.name, r.make_model || '', catIndex[cat], condIdx, null, r.stock_count, r.bin_location || ''];
    if (thumb) { row.push(alt, thumb); } else if (alt) { row.push(alt); }
    return row;
  });
  return { cats, rows: packed, total: packed.length };
}

// The filter a signed-out guest with no search/filters sees: every active part.
// Kept here so the cron and the request path agree on what "the guest catalogue"
// means.
export const GUEST_BASE_WHERE = 'is_active = 1';
