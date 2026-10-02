// Seed `purchase_orders` + `purchase_order_items` from the staged INVREC export
// -- the inventory received.
//
//   node app/tools/load-invrec.mjs [--replace]
//
// Run after load-suppliers.mjs and load-inventry.mjs.
//
// Grouping into purchase orders. INVREC is a flat receipt log with no order
// header: BILL_NO, ORDERNO, TRAN_NO and INV_NUMBER are empty on all 206,956
// rows, and only REFERENCE is populated (125,766 rows, 15,801 distinct -- the
// supplier's bill number). A purchase order is therefore synthesised per
//     (SUPPLIER, REC_DATE, REFERENCE)
// which yields 26,071 orders averaging 7.9 lines. Rows with no REFERENCE group
// into one receipt batch per supplier per day. That grouping key is stored in
// purchase_orders.legacy_key so a re-run updates in place instead of
// duplicating, and po_number is a readable LEG-YYYYMMDD-NNN derived from it.
//
// Totals: SUB_TOTAL, TOTAL, TOTAL_PAID and TXRATE are empty on every row, so
// order totals are computed as SUM(qty * cost) over the lines actually loaded.
//
// Which rows become lines:
//   * qty = 0 (28,961 rows) -- INVREC doubles as a cost/price revision log, and
//     these carry a new COST/PRICE with no goods movement. They are not
//     receipts, so they are not loaded as order lines.
//   * |qty| > 100,000 (6 rows) -- corrupt entry (-44,000,000 of one part number).
//     Rejected rather than loaded, so they cannot poison order totals.
//   * negative qty (3,780 rows within range) -- genuine returns to supplier;
//     loaded as negative-quantity lines.
// Everything excluded is written to legacy_import_rejects with its reason.
//
// Statuses: these are receipts that already happened, so status = 'received'
// and qty_received = qty_ordered. 24 rows carry an out-of-range REC_DATE
// (years 4201 and 6202) and land with a NULL date, which legacy_date() enforces.

import { pool, fmt, ensureLegacySchema } from './lib/db.mjs';

const REPLACE = process.argv.includes('--replace');
const QTY_LIMIT = 100000;

const db = pool(2);
const c = await db.connect();
try {
  await ensureLegacySchema(c);
  const { rows: [{ staged }] } = await c.query('SELECT count(*)::int AS staged FROM legacy_invrec');
  if (!staged) {
    console.error('legacy_invrec is empty -- run: node app/tools/stage-legacy.mjs');
    process.exit(1);
  }

  await c.query('BEGIN');
  await c.query("SET LOCAL work_mem = '256MB'");

  if (REPLACE) {
    await c.query('TRUNCATE purchase_orders RESTART IDENTITY CASCADE');
    console.log('purchase_orders truncated (order items cascaded)');
  }

  // ---- classify every source row -------------------------------------------
  await c.query(`
    CREATE TEMP TABLE _rec AS
    SELECT src_line,
           nullif(btrim(coalesce(sku, '')), '')            AS sku,
           legacy_name(supplier)                           AS supplier_name,
           legacy_date(rec_date)                           AS rec_day,
           legacy_num0(qty)                                AS qty,
           legacy_num(cost)                                AS cost,
           legacy_num(price)                               AS price,
           nullif(btrim(coalesce(reference, '')), '')      AS reference,
           legacy_ts(rec_date, det_time)                   AS rec_at,
           CASE
             WHEN legacy_num0(qty) = 0                     THEN 'price-revision'
             WHEN abs(legacy_num0(qty)) > ${QTY_LIMIT}     THEN 'corrupt qty'
             ELSE 'receipt' END                            AS row_kind
      FROM legacy_invrec`);

  const { rows: [k] } = await c.query(`
    SELECT count(*)::int                                              AS total,
           count(*) FILTER (WHERE row_kind = 'receipt')::int           AS receipts,
           count(*) FILTER (WHERE row_kind = 'price-revision')::int    AS revisions,
           count(*) FILTER (WHERE row_kind = 'corrupt qty')::int       AS corrupt,
           count(*) FILTER (WHERE row_kind = 'receipt' AND qty < 0)::int AS returns,
           count(*) FILTER (WHERE rec_day IS NULL)::int                AS no_date,
           count(*) FILTER (WHERE supplier_name IS NULL)::int          AS no_supplier
      FROM _rec`);
  console.log(`staged receipt rows: ${fmt(staged)}`);
  console.log(`  receipts loaded as order lines: ${fmt(k.receipts)} (of which returns: ${fmt(k.returns)})`);
  console.log(`  skipped: price/cost revisions (qty=0) ${fmt(k.revisions)}, corrupt qty ${fmt(k.corrupt)}`);
  console.log(`  unusable REC_DATE: ${fmt(k.no_date)}  |  no SUPPLIER: ${fmt(k.no_supplier)}`);

  await c.query(`DELETE FROM legacy_import_rejects WHERE source = 'INVREC'`);
  await c.query(`
    INSERT INTO legacy_import_rejects (source, reason, key1, key2, payload)
    SELECT 'INVREC',
           CASE WHEN row_kind = 'price-revision'
                THEN 'cost/price revision, no goods movement (qty=0)'
                ELSE 'corrupt quantity, outside +/-${QTY_LIMIT}' END,
           sku, supplier_name,
           jsonb_build_object('src_line', src_line, 'qty', qty, 'cost', cost,
                              'price', price, 'rec_date', rec_day, 'reference', reference)
      FROM _rec WHERE row_kind <> 'receipt'`);

  // ---- one purchase order per (supplier, date, reference) ------------------
  await c.query(`
    CREATE TEMP TABLE _po AS
    WITH g AS (
      SELECT supplier_name,
             rec_day,
             reference,
             coalesce(supplier_name, '?') || '|' || coalesce(rec_day::text, '?')
               || '|' || coalesce(reference, '~')                 AS legacy_key,
             min(rec_at)                                          AS rec_at,
             count(*)::int                                        AS lines,
             sum(qty)                                             AS units,
             round(sum(qty * coalesce(cost, 0)), 2)               AS subtotal
        FROM _rec WHERE row_kind = 'receipt'
       GROUP BY 1, 2, 3
    )
    SELECT g.*,
           'LEG-' || coalesce(to_char(g.rec_day, 'YYYYMMDD'), 'UNDATED') || '-'
             || lpad((row_number() OVER (PARTITION BY g.rec_day
                                         ORDER BY g.supplier_name, g.reference))::text, 4, '0') AS po_number,
           s.id AS supplier_id
      FROM g LEFT JOIN suppliers s ON lower(btrim(s.name)) = lower(g.supplier_name)`);

  const { rows: [g] } = await c.query(`
    SELECT count(*)::int                                        AS orders,
           count(*) FILTER (WHERE supplier_id IS NULL)::int       AS no_supplier,
           count(*) FILTER (WHERE reference IS NOT NULL)::int     AS with_ref,
           round(sum(subtotal), 2)::text                          AS value
      FROM _po`);
  console.log(`\npurchase orders synthesised: ${fmt(g.orders)}`
    + `  |  with a supplier bill reference: ${fmt(g.with_ref)}`
    + `  |  unresolved supplier: ${fmt(g.no_supplier)}`);

  const insPo = await c.query(`
    INSERT INTO purchase_orders (
      po_number, legacy_key, supplier_id, status, invoice_number,
      subtotal_usd, tax_usd, total_usd, created_at, received_at, received_date, notes)
    SELECT po_number, legacy_key, supplier_id, 'received', reference,
           subtotal, 0, subtotal,
           coalesce(rec_at, rec_day::timestamptz, now()),
           coalesce(rec_at, rec_day::timestamptz),
           coalesce(rec_at, rec_day::timestamptz),
           'Imported from INVREC.csv; ' || lines || ' line(s), '
             || round(units, 2) || ' unit(s)'
             || CASE WHEN rec_day IS NULL THEN '. Source REC_DATE was unusable.' ELSE '.' END
      FROM _po
    ON CONFLICT (legacy_key) DO UPDATE SET
      supplier_id    = EXCLUDED.supplier_id,
      status         = EXCLUDED.status,
      invoice_number = EXCLUDED.invoice_number,
      subtotal_usd   = EXCLUDED.subtotal_usd,
      total_usd      = EXCLUDED.total_usd,
      received_at    = EXCLUDED.received_at,
      received_date  = EXCLUDED.received_date,
      notes          = EXCLUDED.notes`);

  // Re-running must not stack duplicate lines under an order that already has
  // them, so replace the line set for every order this import touches.
  await c.query(`
    DELETE FROM purchase_order_items i
     USING purchase_orders p
     WHERE i.po_id = p.id
       AND p.legacy_key IN (SELECT legacy_key FROM _po)`);

  const insItems = await c.query(`
    INSERT INTO purchase_order_items (
      po_id, product_img, product_id, sku, description, qty, qty_ordered,
      qty_received, unit_cost_usd, total_usd, condition, notes)
    SELECT po.id,
           r.sku,
           pr.id,
           r.sku,
           coalesce(pr.name, r.sku, 'Received item'),
           round(r.qty)::int,
           round(r.qty)::int,
           round(r.qty)::int,
           r.cost,
           round(r.qty * coalesce(r.cost, 0), 2),
           'NEW',
           CASE WHEN r.price IS NOT NULL
                THEN 'Selling price on receipt: ' || r.price END
      FROM _rec r
      JOIN _po g ON g.legacy_key = coalesce(r.supplier_name, '?') || '|'
                                || coalesce(r.rec_day::text, '?') || '|'
                                || coalesce(r.reference, '~')
      JOIN purchase_orders po ON po.legacy_key = g.legacy_key
      LEFT JOIN products pr ON pr.img = r.sku
     WHERE r.row_kind = 'receipt'`);

  await c.query('COMMIT');

  const { rows: [t] } = await c.query(`
    SELECT (SELECT count(*) FROM purchase_orders)::int                            AS orders,
           (SELECT count(*) FROM purchase_order_items)::int                       AS items,
           (SELECT count(*) FROM purchase_order_items WHERE product_id IS NOT NULL)::int AS linked,
           (SELECT round(sum(total_usd), 2) FROM purchase_orders)::text           AS value,
           (SELECT min(received_date)::date FROM purchase_orders)::text            AS first_rec,
           (SELECT max(received_date)::date FROM purchase_orders)::text            AS last_rec`);
  console.log(`\nupserted ${fmt(insPo.rowCount)} purchase orders  |  inserted ${fmt(insItems.rowCount)} order lines`);
  console.log(`purchase_orders now: ${fmt(t.orders)}  |  purchase_order_items: ${fmt(t.items)}`
    + `  |  matched to a live product: ${fmt(t.linked)}`);
  console.log(`received value: ${fmt(t.value)}  |  ${t.first_rec} .. ${t.last_rec}`);
} catch (e) {
  await c.query('ROLLBACK').catch(() => {});
  console.error('FAILED, rolled back:', e.message);
  process.exitCode = 1;
} finally {
  c.release();
  await db.end();
}
