// Seed `pos_sale_items` from the staged INVDETAI export -- the items sold.
//
//   node app/tools/load-invdetai.mjs [--replace]
//
// Run after load-invoices.mjs (lines attach to pos_sales.id) and
// load-inventry.mjs (so product_id can resolve).
//
// Money. The column literally named UNIT holds the unit PRICE, not a UOM, and
// DISC is a NEGATIVE percentage: AMOUNT = QUANTITY * UNIT * (1 - |DISC|/100)
// holds for 1,048,399 of 1,048,575 rows (99.98%). AMOUNT is therefore treated
// as authoritative for the line total, and discount_usd is derived as
// qty*unit - amount so the two always reconcile.
//
// Attaching a line to its sale. INVDETAI only carries INV_NUMBER, but the
// legacy counter reused invoice numbers, so 1,179 numbers map to more than one
// sale (see load-invoices.mjs). Lines are resolved in this order:
//   1. the invoice number identifies exactly one sale        (1,044,000+ lines)
//   2. otherwise DDATE picks one of them                     (3,990 lines)
//   3. otherwise TRANNO picks one of them
//   4. otherwise the earliest sale with that number, recorded as ambiguous
// Lines whose invoice number has no sale at all (57) cannot be attached and are
// recorded in legacy_import_rejects rather than dropped silently.
//
// Known lossy field: pos_sale_items.qty is an integer but 194 source lines sell
// a fractional quantity (0.5 of a tyre-fitting charge, 0.3 of a litre). Those
// are rounded, and a line that would round to 0 while carrying money is kept at
// 1. total_usd still comes from AMOUNT, so the revenue stays exact -- only the
// displayed quantity is approximate. All 194 are listed in the rejects table.

import { pool, fmt, ensureLegacySchema } from './lib/db.mjs';

const REPLACE = process.argv.includes('--replace');

const db = pool(2);
const c = await db.connect();
try {
  await ensureLegacySchema(c);
  const { rows: [{ staged }] } = await c.query('SELECT count(*)::int AS staged FROM legacy_invdetai');
  if (!staged) {
    console.error('legacy_invdetai is empty -- run: node app/tools/stage-legacy.mjs');
    process.exit(1);
  }
  const { rows: [{ sales }] } = await c.query('SELECT count(*)::int AS sales FROM pos_sales');
  if (!sales) {
    console.error('pos_sales is empty -- run: node app/tools/load-invoices.mjs');
    process.exit(1);
  }

  await c.query('BEGIN');
  await c.query("SET LOCAL work_mem = '256MB'");

  if (REPLACE) {
    await c.query('TRUNCATE pos_sale_items RESTART IDENTITY');
    console.log('pos_sale_items truncated');
  }

  // ---- invoice number -> sale id, in four tiers ----------------------------
  await c.query(`
    CREATE TEMP TABLE _per_no AS
    SELECT invoice_number, count(*)::int AS n, min(id) AS first_id
      FROM pos_sales WHERE invoice_number IS NOT NULL
     GROUP BY invoice_number`);
  await c.query('CREATE UNIQUE INDEX ON _per_no (invoice_number)');

  // Tier 1: unambiguous.
  await c.query(`
    CREATE TEMP TABLE _uniq AS
    SELECT s.invoice_number, s.id
      FROM pos_sales s JOIN _per_no p USING (invoice_number)
     WHERE p.n = 1`);
  await c.query('CREATE UNIQUE INDEX ON _uniq (invoice_number)');

  // Tiers 2 and 3 only need the reused numbers, which is a tiny set.
  await c.query(`
    CREATE TEMP TABLE _amb AS
    SELECT s.invoice_number, s.id, s.created_at::date AS d, s.legacy_tranno
      FROM pos_sales s JOIN _per_no p USING (invoice_number)
     WHERE p.n > 1`);
  await c.query('CREATE INDEX ON _amb (invoice_number, d)');
  await c.query('CREATE INDEX ON _amb (invoice_number, legacy_tranno)');

  // A (number, date) pair is only usable if it identifies a single sale.
  await c.query(`
    CREATE TEMP TABLE _bydate AS
    SELECT invoice_number, d, min(id) AS id
      FROM _amb GROUP BY invoice_number, d HAVING count(*) = 1`);
  await c.query('CREATE UNIQUE INDEX ON _bydate (invoice_number, d)');

  await c.query(`
    CREATE TEMP TABLE _bytranno AS
    SELECT invoice_number, legacy_tranno, min(id) AS id
      FROM _amb WHERE legacy_tranno IS NOT NULL
     GROUP BY invoice_number, legacy_tranno HAVING count(*) = 1`);
  await c.query('CREATE UNIQUE INDEX ON _bytranno (invoice_number, legacy_tranno)');

  // ---- resolve every line --------------------------------------------------
  await c.query(`
    CREATE TEMP TABLE _line AS
    WITH base AS (
      SELECT src_line,
             nullif(btrim(coalesce(inv_number, '')), '')   AS inv_no,
             nullif(btrim(coalesce(sku, '')), '')          AS sku,
             nullif(btrim(coalesce(part_name, '')), '')    AS part_name,
             legacy_num0(quantity)                         AS qty_raw,
             legacy_num0(unit_price)                       AS unit_price,
             legacy_num0(amount)                           AS amount,
             abs(legacy_num0(disc))                        AS disc_pct,
             legacy_date(ddate)                            AS dd,
             nullif(btrim(coalesce(tranno, '')), '')       AS tranno,
             upper(btrim(coalesce(tax, '')))               AS tax_flag,
             nullif(btrim(coalesce(lin_number, '')), '')   AS lin_no
        FROM legacy_invdetai
    )
    SELECT b.*,
           coalesce(u.id, bd.id, bt.id, pn.first_id)                   AS sale_id,
           CASE WHEN u.id  IS NOT NULL THEN 'unique'
                WHEN bd.id IS NOT NULL THEN 'by-date'
                WHEN bt.id IS NOT NULL THEN 'by-tranno'
                WHEN pn.first_id IS NOT NULL THEN 'ambiguous-first'
                ELSE 'orphan' END                                      AS match_kind,
           -- qty is an integer column; keep a money-bearing line visible at 1
           -- A line on a 'CN' invoice is returned stock: the quantity came back
           -- and the money went out, but the legacy file stores both positive
           -- (92,599 lines, J$182,364,547.98, 142,116 units). Signed negative
           -- so returns net out of revenue, units sold and demand everywhere
           -- downstream -- the reorder and best-seller reports would otherwise
           -- read a return as a sale and buy more of it.
           -- load-invoices.mjs signs the matching header the same way.
           CASE WHEN b.inv_no LIKE 'CN%' THEN -1 ELSE 1 END             AS sign,
           CASE WHEN round(b.qty_raw) = 0 AND b.amount <> 0 THEN 1
                ELSE greatest(round(b.qty_raw), 0) END::int             AS qty
      FROM base b
      LEFT JOIN _uniq    u  ON u.invoice_number  = b.inv_no
      LEFT JOIN _per_no  pn ON pn.invoice_number = b.inv_no
      LEFT JOIN _bydate  bd ON bd.invoice_number = b.inv_no AND bd.d = b.dd
      LEFT JOIN _bytranno bt ON bt.invoice_number = b.inv_no AND bt.legacy_tranno = b.tranno`);

  const { rows: [m] } = await c.query(`
    SELECT count(*)::int                                                  AS total,
           count(*) FILTER (WHERE match_kind = 'unique')::int             AS k_uniq,
           count(*) FILTER (WHERE match_kind = 'by-date')::int            AS k_date,
           count(*) FILTER (WHERE match_kind = 'by-tranno')::int          AS k_tran,
           count(*) FILTER (WHERE match_kind = 'ambiguous-first')::int    AS k_amb,
           count(*) FILTER (WHERE match_kind = 'orphan')::int             AS k_orphan,
           count(*) FILTER (WHERE qty_raw <> round(qty_raw))::int         AS fractional
      FROM _line`);
  console.log(`staged lines: ${fmt(staged)}`);
  console.log(`attached: unique ${fmt(m.k_uniq)}, by-date ${fmt(m.k_date)}, by-tranno ${fmt(m.k_tran)},`
    + ` ambiguous ${fmt(m.k_amb)}  |  orphan (no such invoice) ${fmt(m.k_orphan)}`);
  console.log(`fractional quantities rounded: ${fmt(m.fractional)}`);

  // ---- record what could not be loaded cleanly -----------------------------
  await c.query(`DELETE FROM legacy_import_rejects WHERE source = 'INVDETAI'`);
  await c.query(`
    INSERT INTO legacy_import_rejects (source, reason, key1, key2, payload)
    SELECT 'INVDETAI',
           CASE WHEN match_kind = 'orphan' THEN 'no matching invoice'
                ELSE 'ambiguous invoice number' END,
           inv_no, lin_no,
           jsonb_build_object('src_line', src_line, 'sku', sku, 'qty', qty_raw,
                              'amount', amount, 'ddate', dd)
      FROM _line WHERE match_kind IN ('orphan', 'ambiguous-first')`);
  await c.query(`
    INSERT INTO legacy_import_rejects (source, reason, key1, key2, payload)
    SELECT 'INVDETAI', 'fractional quantity rounded', inv_no, lin_no,
           jsonb_build_object('src_line', src_line, 'sku', sku,
                              'qty_source', qty_raw, 'qty_loaded', qty, 'amount', amount)
      FROM _line WHERE qty_raw <> round(qty_raw)`);

  // ---- load ----------------------------------------------------------------
  // pos_sale_items has no natural key to upsert on (the legacy
  // (INV_NUMBER, LIN_NUMBER) pair repeats 1,458 times), so a re-run has to
  // replace the line set of every sale this import touches rather than
  // ON CONFLICT -- otherwise the second run stacks a duplicate copy of all
  // 1.05M lines on top of the first. Scoped to the sales in _line, so lines
  // belonging to sales created in the app are never touched.
  const wiped = await c.query(`
    DELETE FROM pos_sale_items
     WHERE sale_id IN (SELECT DISTINCT sale_id FROM _line WHERE sale_id IS NOT NULL)`);
  if (wiped.rowCount) console.log(`replacing ${fmt(wiped.rowCount)} existing line(s) on these sales`);

  // product_img keeps the legacy SKU even when the part is gone from INVENTRY
  // (23% of historic lines), so the sale still says what was sold; product_id
  // is only set when the part still exists.
  const ins = await c.query(`
    INSERT INTO pos_sale_items (
      sale_id, product_img, product_id, description, qty,
      unit_price_usd, total_usd, discount_usd, discount_note)
    SELECT l.sale_id,
           l.sku,
           p.id,
           coalesce(l.part_name, l.sku, 'Item')                  AS description,
           l.sign * l.qty                                        AS qty,
           -- unit_price stays positive: it is a rate, not a direction.
           l.unit_price,
           l.sign * l.amount                                     AS total_usd,
           -- The discount is a reduction either way, so it keeps its own sign
           -- rather than following the line's.
           greatest(round(l.qty_raw * l.unit_price - l.amount, 2), 0) AS discount_usd,
           CASE WHEN l.disc_pct > 0 THEN l.disc_pct::text || '% (legacy DISC)' END
      FROM _line l
      LEFT JOIN products p ON p.img = l.sku
     WHERE l.sale_id IS NOT NULL`);

  await c.query('COMMIT');

  const { rows: [t] } = await c.query(`
    SELECT count(*)::int                                            AS items,
           count(*) FILTER (WHERE product_id IS NOT NULL)::int       AS linked,
           count(*) FILTER (WHERE product_id IS NULL)::int           AS unlinked,
           count(DISTINCT sale_id)::int                             AS sales_covered,
           coalesce(sum(qty), 0)::bigint                            AS units,
           round(coalesce(sum(total_usd), 0), 2)::text              AS line_revenue,
           round(coalesce(sum(discount_usd), 0), 2)::text           AS discounts
      FROM pos_sale_items`);
  console.log(`\ninserted ${fmt(ins.rowCount)} line items`);
  console.log(`pos_sale_items now: ${fmt(t.items)}  |  matched to a live product: ${fmt(t.linked)}`
    + `  |  discontinued part (SKU kept): ${fmt(t.unlinked)}`);
  console.log(`covers ${fmt(t.sales_covered)} of ${fmt(sales)} sales  |  units ${fmt(t.units)}`
    + `  |  line revenue ${fmt(t.line_revenue)}  |  discounts ${fmt(t.discounts)}`);
} catch (e) {
  await c.query('ROLLBACK').catch(() => {});
  console.error('FAILED, rolled back:', e.message);
  process.exitCode = 1;
} finally {
  c.release();
  await db.end();
}
