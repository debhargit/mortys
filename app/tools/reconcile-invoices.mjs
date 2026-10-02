// Re-check the loaded invoices against their line items and payments.
//
//   node app/tools/reconcile-invoices.mjs            # report only
//   node app/tools/reconcile-invoices.mjs --apply    # also write the fixes below
//
// Run last, after load-invoices / load-invdetai / load-invpay.
//
// What is authoritative. The INVOICE header is what the business actually billed
// and collected -- it is the figure the customer paid and the one the legacy
// day-end reports were built on. INVDETAI is an incomplete record of the same
// transactions (see the coverage section below). So this tool NEVER rewrites a
// header total from the lines; it reports the disagreement and records it.
//
// --apply writes a row in legacy_import_rejects for every sale whose lines do
// not add up to its header, and for every sale with no lines at all, so the
// exceptions are a queryable list rather than a number in a console log.
//
// It deliberately does NOT touch pos_sales.discount_usd. In this schema that
// column is the WHOLE-TICKET discount (manual + loyalty) applied on top of an
// already-net subtotal: the POS computes
//     subtotal = SUM(line nets)      total = subtotal - discount_usd + tax
// and the tax report derives its taxable base as subtotal_usd - discount_usd.
// The legacy per-line DISC is already baked into INVOICE.SUB_TOTAL (which is why
// 96.8% of subtotals equal the sum of the line AMOUNTs), so copying the line
// discounts up to the header would double-count them -- breaking that invariant
// on every discounted invoice and understating taxable sales. The legacy
// discount therefore lives only on pos_sale_items.discount_usd, where
// load-invdetai.mjs put it, and is reported here for information.
//
// Coverage caveat that drives most of the variance: INVDETAI.csv was exported
// through Excel and stopped at exactly 1,048,575 data rows -- the sheet row
// limit. It covers 2010-2022 and carries NO lines for 2023-2026, so roughly a
// quarter of a million invoices have a header and no items. That is a source
// export problem, not an import bug; re-export INVDETAI in chunks to fix it.

import { pool, fmt, ensureLegacySchema } from './lib/db.mjs';

const APPLY = process.argv.includes('--apply');
const TOL = 0.02;          // cent-level rounding in the legacy figures

const db = pool(2);
const c = await db.connect();

const money = (v) => fmt(Number(v ?? 0).toFixed(2));

try {
  await ensureLegacySchema(c);
  const { rows: [{ sales }] } = await c.query('SELECT count(*)::int AS sales FROM pos_sales');
  if (!sales) {
    console.error('pos_sales is empty -- run: node app/tools/load-invoices.mjs');
    process.exit(1);
  }

  await c.query("SET work_mem = '256MB'");

  // One pass that everything below reads from.
  await c.query(`
    CREATE TEMP TABLE _chk AS
    SELECT s.id,
           s.receipt_number,
           s.invoice_number,
           extract(year FROM s.created_at)::int           AS yr,
           s.subtotal_usd, s.tax_usd, s.total_usd,
           s.amount_paid_usd,
           coalesce(l.n, 0)                               AS line_count,
           coalesce(l.line_total, 0)                      AS line_total,
           coalesce(l.line_disc, 0)                       AS line_disc,
           coalesce(p.n, 0)                               AS pay_count,
           coalesce(p.pay_total, 0)                       AS pay_total
      FROM pos_sales s
      LEFT JOIN (SELECT sale_id, count(*)::int AS n,
                        sum(total_usd) AS line_total, sum(discount_usd) AS line_disc
                   FROM pos_sale_items GROUP BY sale_id) l ON l.sale_id = s.id
      LEFT JOIN (SELECT sale_id, count(*)::int AS n, sum(amount_usd) AS pay_total
                   FROM sale_payments GROUP BY sale_id) p ON p.sale_id = s.id`);
  await c.query('CREATE INDEX ON _chk (id)');

  // ---- 1. line coverage ----------------------------------------------------
  const { rows: [cov] } = await c.query(`
    SELECT count(*)::int                                      AS sales,
           count(*) FILTER (WHERE line_count > 0)::int         AS with_lines,
           count(*) FILTER (WHERE line_count = 0)::int         AS no_lines,
           round(sum(total_usd), 2)::text                      AS billed,
           round(sum(total_usd) FILTER (WHERE line_count = 0), 2)::text AS billed_no_lines
      FROM _chk`);
  console.log('=== 1. line-item coverage ===');
  console.log(`invoices: ${fmt(cov.sales)}  |  with line items: ${fmt(cov.with_lines)}`
    + `  |  header only: ${fmt(cov.no_lines)} (${(cov.no_lines / cov.sales * 100).toFixed(1)}%)`);
  console.log(`billed overall: ${money(cov.billed)}  |  billed on header-only invoices: ${money(cov.billed_no_lines)}`);

  const { rows: byYear } = await c.query(`
    SELECT yr, count(*)::int AS sales,
           count(*) FILTER (WHERE line_count = 0)::int AS no_lines,
           count(*) FILTER (WHERE pay_count = 0)::int  AS no_pay
      FROM _chk WHERE yr IS NOT NULL GROUP BY yr ORDER BY yr`);
  console.log('\n  year   invoices   no line items   no payments');
  for (const r of byYear) {
    const flagL = r.no_lines === r.sales ? '  <-- no INVDETAI data' : '';
    const flagP = r.no_pay === r.sales ? '  <-- no INVPAY data' : '';
    console.log(`  ${r.yr}  ${String(fmt(r.sales)).padStart(9)}  ${String(fmt(r.no_lines)).padStart(13)}`
      + `  ${String(fmt(r.no_pay)).padStart(11)}${flagL}${flagP}`);
  }

  // ---- 2. header vs lines --------------------------------------------------
  const { rows: [agr] } = await c.query(`
    SELECT count(*)::int                                                           AS checked,
           count(*) FILTER (WHERE abs(subtotal_usd - line_total) <= ${TOL})::int     AS exact,
           count(*) FILTER (WHERE abs(subtotal_usd - line_total) > ${TOL})::int      AS off,
           count(*) FILTER (WHERE line_total < subtotal_usd - ${TOL})::int           AS lines_short,
           count(*) FILTER (WHERE line_total > subtotal_usd + ${TOL})::int           AS lines_over,
           round(sum(subtotal_usd - line_total) FILTER (WHERE abs(subtotal_usd - line_total) > ${TOL}), 2)::text AS net_gap
      FROM _chk WHERE line_count > 0`);
  console.log('\n=== 2. header subtotal vs sum of line items (invoices that have lines) ===');
  console.log(`checked: ${fmt(agr.checked)}  |  agree: ${fmt(agr.exact)} (${(agr.exact / agr.checked * 100).toFixed(2)}%)`
    + `  |  disagree: ${fmt(agr.off)}`);
  console.log(`  lines add up to less than the header: ${fmt(agr.lines_short)} (missing lines)`);
  console.log(`  lines add up to more than the header: ${fmt(agr.lines_over)}`);
  console.log(`  net unexplained subtotal: ${money(agr.net_gap)}`);

  // ---- 3. internal arithmetic ---------------------------------------------
  const { rows: [ar] } = await c.query(`
    SELECT count(*) FILTER (WHERE abs(subtotal_usd + tax_usd - total_usd) > ${TOL})::int AS tax_off,
           count(*) FILTER (WHERE total_usd < 0)::int                                     AS negative,
           count(*) FILTER (WHERE total_usd = 0)::int                                     AS zero
      FROM _chk`);
  console.log('\n=== 3. header arithmetic ===');
  console.log(`subtotal + tax <> total: ${fmt(ar.tax_off)}  |  negative totals: ${fmt(ar.negative)}`
    + `  |  zero totals: ${fmt(ar.zero)}`);

  // ---- 4. payments --------------------------------------------------------
  // pay_total is net of refunds (load-invpay.mjs signs them), so compare it
  // against the header's TOTAL_PAID only where payments actually exist.
  const { rows: [pay] } = await c.query(`
    SELECT count(*) FILTER (WHERE pay_count > 0)::int                                   AS with_pay,
           count(*) FILTER (WHERE pay_count = 0)::int                                   AS no_pay,
           count(*) FILTER (WHERE pay_count > 0
                              AND abs(amount_paid_usd - pay_total) <= ${TOL})::int       AS pay_match,
           count(*) FILTER (WHERE pay_count > 0
                              AND abs(amount_paid_usd - pay_total) > ${TOL})::int        AS pay_off,
           round(sum(amount_paid_usd), 2)::text                                          AS header_paid,
           round(sum(pay_total), 2)::text                                                AS ledger_paid
      FROM _chk`);
  console.log('\n=== 4. payments vs header TOTAL_PAID ===');
  console.log(`invoices with payment rows: ${fmt(pay.with_pay)}  |  without: ${fmt(pay.no_pay)}`);
  console.log(`  of those with rows -- agree: ${fmt(pay.pay_match)}, disagree: ${fmt(pay.pay_off)}`);
  console.log(`header says collected: ${money(pay.header_paid)}  |  payment ledger (net of refunds): ${money(pay.ledger_paid)}`);
  console.log('  (the difference is dominated by the missing 2018-2020 INVPAY rows, and by credit');
  console.log('   notes whose refund the header still counts as money in)');

  // ---- 5. apply -----------------------------------------------------------
  const { rows: [ld] } = await c.query(`
    SELECT count(*) FILTER (WHERE discount_usd > 0)::int AS lines_disc,
           round(sum(discount_usd), 2)::text             AS total_disc
      FROM pos_sale_items`);
  const { rows: [hd] } = await c.query(`
    SELECT count(*) FILTER (WHERE discount_usd > 0)::int AS hdr_disc,
           count(*) FILTER (WHERE abs(total_usd - (subtotal_usd - discount_usd + tax_usd)) <= ${TOL})::int AS invariant_ok,
           count(*)::int AS n
      FROM pos_sales`);
  console.log('\n=== 5. discounts ===');
  console.log(`line-level discount (from legacy DISC%): ${fmt(ld.lines_disc)} lines, ${money(ld.total_disc)}`);
  console.log(`whole-ticket discount_usd set on: ${fmt(hd.hdr_disc)} sales`
    + '  (expected 0 -- the legacy discount is already inside SUB_TOTAL)');
  console.log(`invariant total = subtotal - discount + tax holds on ${fmt(hd.invariant_ok)} of ${fmt(hd.n)} sales`);

  if (!APPLY) {
    console.log('\nreport only -- pass --apply to record the exceptions in legacy_import_rejects');
  } else {
    await c.query('BEGIN');
    await c.query(`DELETE FROM legacy_import_rejects
                    WHERE source = 'RECONCILE' AND reason IN ('subtotal does not match line items', 'invoice has no line items')`);
    const ex1 = await c.query(`
      INSERT INTO legacy_import_rejects (source, reason, key1, key2, payload)
      SELECT 'RECONCILE', 'subtotal does not match line items', invoice_number, receipt_number,
             jsonb_build_object('header_subtotal', subtotal_usd, 'line_total', line_total,
                                'gap', round(subtotal_usd - line_total, 2), 'lines', line_count)
        FROM _chk WHERE line_count > 0 AND abs(subtotal_usd - line_total) > ${TOL}`);
    const ex2 = await c.query(`
      INSERT INTO legacy_import_rejects (source, reason, key1, key2, payload)
      SELECT 'RECONCILE', 'invoice has no line items', invoice_number, receipt_number,
             jsonb_build_object('year', yr, 'total', total_usd)
        FROM _chk WHERE line_count = 0`);
    await c.query('COMMIT');

    console.log(`\napplied: recorded ${fmt(ex1.rowCount)} subtotal mismatches`
      + ` and ${fmt(ex2.rowCount)} header-only invoices`);
    console.log("  query them with: SELECT * FROM legacy_import_rejects WHERE source = 'RECONCILE'");
  }

  // ---- 6. rejects summary -------------------------------------------------
  const { rows: rej } = await c.query(`
    SELECT source, reason, count(*)::int AS n
      FROM legacy_import_rejects GROUP BY source, reason ORDER BY source, n DESC`);
  if (rej.length) {
    console.log('\n=== 6. import exceptions recorded ===');
    for (const r of rej) console.log(`  ${r.source.padEnd(10)} ${String(fmt(r.n)).padStart(9)}  ${r.reason}`);
  }
} catch (e) {
  await c.query('ROLLBACK').catch(() => {});
  console.error('FAILED:', e.message);
  process.exitCode = 1;
} finally {
  c.release();
  await db.end();
}
