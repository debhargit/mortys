// Seed `products` from the staged INVENTRY export.
//
//   node app/tools/load-inventry.mjs [--replace]
//
// Reads legacy_inventry (see stage-legacy.mjs), not the CSV directly.
//
// Column mapping -- the export is the DOS-era part master, 108 columns wide,
// most of them unused price-break / warehouse scratch fields:
//   SKU                -> img (unique key) + sku
//   PART NAME          -> name        (falls back to DESCR2, then SKU)
//   BRAND + MODEL      -> make_model  ("BRAND / MODEL", de-duped / blank-safe)
//   LOCATION           -> bin_location   (a bin code like "BB10*C"; products
//                                         .location stays null, as the admin UI
//                                         treats bin_location as the shelf)
//   QUANTITY           -> stock_count
//   COST / PRICE       -> cost_usd / price_usd
//   WHOLEPRICE         -> list_price_usd
//   MARGIN             -> markup_pct
//   MIN_LEV            -> min_stock + low_threshold
//   UNIT               -> stock_uom + purchase_uom (normalised, default EA)
//   SUPPLIER           -> supplier_id (resolved by name against `suppliers`)
//   category           -> derived from PART NAME + DESCR2 keywords
//   condition          -> 'NEW' (the export carries no condition)
// search_text is a generated column and is never written.
//
//   default              upsert on img: existing parts are refreshed, new ones
//                        inserted, parts no longer in the export left alone.
//   --deactivate-missing additionally set is_active = false on parts that are
//                        not in this export, so they drop out of the storefront
//                        without losing their sale history.
//   --replace            TRUNCATE products first. Refuses to run if any sale or
//                        PO line already references a product, since that would
//                        cascade.
//
// Notes on the source data:
//   * ACTIVE is blank on 35,658 of 36,277 rows ('A' on 618), so it is NOT a
//     usable active/inactive flag -- every part loads with is_active = true.
//   * 1,192 rows are TAXCODE 'N' (non-taxable); products has no tax flag, so
//     that is dropped. It survives per-line in legacy_invdetai.tax.

import { pool, fmt, ensureLegacySchema } from './lib/db.mjs';
import { categorise } from './_categorise.mjs';

const REPLACE = process.argv.includes('--replace');
const DEACTIVATE_MISSING = process.argv.includes('--deactivate-missing');

// UNIT is free text: EA, EA., EACH, 1EA, SET, SET 4, PR/FT, PAIR...
function uom(v) {
  const s = String(v || '').toUpperCase().replace(/[^A-Z/]/g, '');
  if (!s) return 'EA';
  if (s === 'EA' || s === 'EACH' || s === 'A') return 'EA';
  if (s.startsWith('SET')) return 'SET';
  if (s.startsWith('PAIR') || s === 'PR') return 'PAIR';
  return s.slice(0, 12) || 'EA';
}

const db = pool(2);
const c = await db.connect();
try {
  await ensureLegacySchema(c);
  const { rows: [{ staged }] } = await c.query('SELECT count(*)::int AS staged FROM legacy_inventry');
  if (!staged) {
    console.error('legacy_inventry is empty -- run: node app/tools/stage-legacy.mjs');
    process.exit(1);
  }

  // Pull the cleaned rows out of staging and do the keyword categorisation and
  // UOM normalisation in JS (too fiddly for SQL), then write back through a
  // temp table so the upsert is one statement.
  const { rows: src } = await c.query(`
    SELECT DISTINCT ON (btrim(sku))
           btrim(sku)                                   AS img,
           coalesce(nullif(btrim(part_name), ''), nullif(btrim(descr2), ''), btrim(sku)) AS name,
           nullif(btrim(coalesce(brand, '')), '')       AS brand,
           nullif(btrim(coalesce(model, '')), '')       AS model,
           nullif(btrim(coalesce(part_name, '')), '')   AS part_name,
           nullif(btrim(coalesce(descr2, '')), '')      AS descr2,
           nullif(btrim(coalesce(location, '')), '')    AS bin_location,
           greatest(coalesce(round(legacy_num(quantity)), 0), 0)::int AS stock_count,
           legacy_num(cost)                             AS cost_usd,
           legacy_num(price)                            AS price_usd,
           legacy_num(wholeprice)                       AS list_price_usd,
           -- products.markup_pct is numeric(6,2); MARGIN runs up to 4,600,100
           -- on a handful of rows (data entry, not a real markup), so anything
           -- outside a plausible band is dropped rather than clamped to a lie.
           CASE WHEN legacy_num(margin) BETWEEN -100 AND 9999.99
                THEN legacy_num(margin) END             AS markup_pct,
           greatest(coalesce(round(legacy_num(min_lev)), 0), 0)::int   AS min_stock,
           unit                                         AS unit_raw,
           legacy_name(supplier)                        AS supplier_name
      FROM legacy_inventry
     WHERE nullif(btrim(sku), '') IS NOT NULL
     ORDER BY btrim(sku), src_line DESC          -- last row wins on duplicate SKU
  `);

  const { rows: [odd] } = await c.query(`
    SELECT count(*) FILTER (WHERE nullif(btrim(sku), '') IS NULL)::int        AS blanks,
           count(*) FILTER (WHERE legacy_num(quantity) < 0)::int              AS neg_qty,
           count(*) FILTER (WHERE legacy_num(margin) IS NOT NULL
                              AND legacy_num(margin) NOT BETWEEN -100 AND 9999.99)::int AS wild_margin,
           count(*) FILTER (WHERE legacy_name(supplier) IS NULL)::int         AS no_supplier
      FROM legacy_inventry`);
  const blanks = odd.blanks;

  const rows = src.map((r) => ({
    ...r,
    category: categorise([r.part_name, r.descr2].filter(Boolean).join(' ')),
    make_model: !r.brand && !r.model ? ''
      : !r.brand ? r.model
      : !r.model || r.model.toUpperCase() === r.brand.toUpperCase() ? r.brand
      : `${r.brand} / ${r.model}`,
    uom: uom(r.unit_raw),
    // price_usd is NOT NULL-able in practice for the storefront; a 0/blank
    // price means "not priced for POS" and is stored as NULL so the shop grid
    // filter (see commit 7d5aaed) keeps excluding it.
    price_usd: r.price_usd != null && Number(r.price_usd) > 0 ? r.price_usd : null,
  }));

  const dist = {};
  for (const x of rows) dist[x.category] = (dist[x.category] || 0) + 1;
  console.log(`staged rows: ${fmt(staged)}  |  loadable: ${fmt(rows.length)}`
    + `  |  blank SKU skipped: ${fmt(blanks)}  |  duplicate SKU collapsed: ${fmt(staged - blanks - rows.length)}`);
  console.log('category distribution:', dist);
  console.log(`source quirks: negative QUANTITY clamped to 0: ${fmt(odd.neg_qty)}`
    + `  |  out-of-range MARGIN dropped: ${fmt(odd.wild_margin)}`
    + `  |  rows with no SUPPLIER: ${fmt(odd.no_supplier)}`);

  await c.query('BEGIN');

  if (REPLACE) {
    const { rows: [refs] } = await c.query(`
      SELECT (SELECT count(*) FROM pos_sale_items       WHERE product_id IS NOT NULL)::int AS sale_lines,
             (SELECT count(*) FROM purchase_order_items WHERE product_id IS NOT NULL)::int AS po_lines`);
    if (refs.sale_lines || refs.po_lines) {
      throw new Error(`--replace refused: ${fmt(refs.sale_lines)} sale lines and ${fmt(refs.po_lines)} PO lines `
        + 'still reference products (TRUNCATE CASCADE would null their product_id). '
        + 'Run without --replace to upsert in place.');
    }
    await c.query('TRUNCATE products RESTART IDENTITY CASCADE');
    console.log('products truncated');
  }

  await c.query(`
    CREATE TEMP TABLE _p (
      img text, name text, make_model text, category text, bin_location text,
      stock_count int, cost_usd numeric, price_usd numeric, list_price_usd numeric,
      markup_pct numeric, min_stock int, uom text, supplier_name text
    ) ON COMMIT DROP`);

  const COLS = ['img', 'name', 'make_model', 'category', 'bin_location', 'stock_count',
    'cost_usd', 'price_usd', 'list_price_usd', 'markup_pct', 'min_stock', 'uom', 'supplier_name'];

  // copyInto() spawns its own psql connection, which cannot see this session's
  // TEMP table -- so the staging hop uses chunked INSERTs on this client.
  const CHUNK = 1000;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const vals = [];
    const tuples = slice.map((row, n) => {
      const b = n * COLS.length;
      COLS.forEach((k) => vals.push(row[k] === undefined ? null : row[k]));
      return '(' + COLS.map((_, k) => `$${b + k + 1}`).join(',') + ')';
    });
    await c.query(`INSERT INTO _p (${COLS.join(',')}) VALUES ${tuples.join(',')}`, vals);
  }

  const res = await c.query(`
    INSERT INTO products (
      img, sku, name, make_model, category, condition, bin_location, stock_count,
      low_threshold, min_stock, cost_usd, price_usd, list_price_usd, markup_pct,
      stock_uom, purchase_uom, units_per_purchase, supplier_id, is_active)
    SELECT p.img, p.img, p.name, p.make_model, p.category, 'NEW', p.bin_location, p.stock_count,
           p.min_stock, p.min_stock, p.cost_usd, p.price_usd, p.list_price_usd, p.markup_pct,
           p.uom, p.uom, 1, s.id, true
      FROM _p p
      LEFT JOIN suppliers s ON lower(btrim(s.name)) = lower(p.supplier_name)
    ON CONFLICT (img) DO UPDATE SET
      sku            = EXCLUDED.sku,
      name           = EXCLUDED.name,
      make_model     = EXCLUDED.make_model,
      category       = EXCLUDED.category,
      condition      = EXCLUDED.condition,
      bin_location   = EXCLUDED.bin_location,
      stock_count    = EXCLUDED.stock_count,
      low_threshold  = EXCLUDED.low_threshold,
      min_stock      = EXCLUDED.min_stock,
      cost_usd       = EXCLUDED.cost_usd,
      price_usd      = EXCLUDED.price_usd,
      list_price_usd = EXCLUDED.list_price_usd,
      markup_pct     = EXCLUDED.markup_pct,
      stock_uom      = EXCLUDED.stock_uom,
      purchase_uom   = EXCLUDED.purchase_uom,
      supplier_id    = EXCLUDED.supplier_id,
      updated_at     = now()`);

  // Parts carried by an earlier load that this export no longer lists. They are
  // never deleted -- sale history points at them -- only retired on request.
  const { rows: [{ missing }] } = await c.query(`
    SELECT count(*)::int AS missing FROM products p
     WHERE NOT EXISTS (SELECT 1 FROM _p x WHERE x.img = p.img)`);
  let retired = 0;
  if (DEACTIVATE_MISSING && missing) {
    const r = await c.query(`
      UPDATE products p SET is_active = false, updated_at = now()
       WHERE is_active AND NOT EXISTS (SELECT 1 FROM _p x WHERE x.img = p.img)`);
    retired = r.rowCount;
  }

  await c.query('COMMIT');

  const { rows: [t] } = await c.query(`
    SELECT count(*)::int                                            AS total,
           count(*) FILTER (WHERE supplier_id IS NOT NULL)::int      AS with_supplier,
           count(*) FILTER (WHERE price_usd IS NOT NULL)::int        AS priced,
           count(*) FILTER (WHERE stock_count > 0)::int              AS in_stock,
           count(*) FILTER (WHERE bin_location IS NOT NULL)::int     AS binned,
           coalesce(sum(stock_count), 0)::bigint                     AS units,
           coalesce(round(sum(stock_count * cost_usd), 2), 0)::text  AS stock_cost
      FROM products`);
  console.log(`\nupserted ${fmt(res.rowCount)} rows`);
  console.log(`products now: ${fmt(t.total)}  |  with supplier: ${fmt(t.with_supplier)}`
    + `  |  priced for POS: ${fmt(t.priced)}  |  in stock: ${fmt(t.in_stock)}  |  binned: ${fmt(t.binned)}`);
  console.log(`stock on hand: ${fmt(t.units)} units  |  at cost: ${fmt(t.stock_cost)}`);
  if (missing) {
    console.log(DEACTIVATE_MISSING
      ? `not in this export: ${fmt(missing)}  ->  ${fmt(retired)} set is_active = false`
      : `not in this export: ${fmt(missing)} (left active; pass --deactivate-missing to retire them)`);
  }
} catch (e) {
  await c.query('ROLLBACK').catch(() => {});
  console.error('FAILED, rolled back:', e.message);
  process.exitCode = 1;
} finally {
  c.release();
  await db.end();
}
