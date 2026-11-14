// What an import of the staged legacy files would change, without changing it.
//
//   node app/tools/legacy-check.mjs [--only=INVENTRY,INVOICE,...]
//
// Run after stage-legacy.mjs. Reads the legacy_* staging tables and compares
// them with the system using the same rules as the --new-only loaders, so the
// numbers are what the import page's Import button will do: new parts and the
// parts whose stock, cost or price changed; new invoices (by INV_NUMBER and
// TRANNO) and older ones paid since; line items and payments for them; new
// receipts (supplier, date, reference).
//
// Prints a readable summary, and one '@@check {json}' line for the import page.
import { pool, fmt, ensureLegacySchema } from './lib/db.mjs';

const argv = process.argv.slice(2);
const only = argv.find((a) => a.startsWith('--only='));
const FILES = only ? only.slice(7).split(',').map((s) => s.trim().toUpperCase()) : ['INVENTRY', 'INVOICE', 'INVDETAI', 'INVPAY', 'INVREC'];
const want = (f) => FILES.includes(f);

const db = pool(2);
const c = await db.connect();
const one = async (sql) => (await c.query(sql)).rows[0];
const out = {};
try {
  await ensureLegacySchema(c);

  if (want('INVENTRY')) {
    out.inventory = await one(`
      WITH p AS (
        SELECT DISTINCT ON (btrim(sku)) btrim(sku) AS img,
               greatest(coalesce(round(legacy_num(quantity)), 0), 0)::int AS qty,
               legacy_num(cost) AS cost,
               CASE WHEN legacy_num(price) > 0 THEN legacy_num(price) END AS price
          FROM legacy_inventry WHERE nullif(btrim(sku), '') IS NOT NULL
         ORDER BY btrim(sku), src_line DESC)
      SELECT count(*)::int AS rows,
             count(*) FILTER (WHERE x.img IS NULL)::int AS new_parts,
             count(*) FILTER (WHERE x.img IS NOT NULL AND x.stock_count IS DISTINCT FROM p.qty)::int AS stock_changed,
             count(*) FILTER (WHERE x.img IS NOT NULL AND p.cost IS NOT NULL AND x.cost_usd IS DISTINCT FROM p.cost)::int AS cost_changed,
             count(*) FILTER (WHERE x.img IS NOT NULL AND p.price IS NOT NULL AND x.price_usd IS DISTINCT FROM p.price)::int AS price_changed
        FROM p LEFT JOIN products x ON x.img = p.img`);
  }

  if (want('INVOICE')) {
    await c.query(`CREATE TEMP TABLE _known AS SELECT DISTINCT invoice_number, legacy_tranno FROM pos_sales WHERE invoice_number IS NOT NULL`);
    await c.query('CREATE INDEX ON _known (invoice_number, legacy_tranno)');
    await c.query(`
      CREATE TEMP TABLE _inv AS
      SELECT nullif(btrim(inv_number), '') AS inv_no, nullif(btrim(tranno), '') AS tranno,
             legacy_date(inv_date) AS d,
             CASE WHEN inv_number LIKE 'CN%' THEN -1 ELSE 1 END * legacy_num0(total) AS total,
             CASE WHEN inv_number LIKE 'CN%' THEN -1 ELSE 1 END * legacy_num0(total_paid) AS paid
        FROM legacy_invoice`);
    out.invoices = await one(`
      SELECT count(*)::int AS rows,
             count(*) FILTER (WHERE i.inv_no IS NOT NULL AND k.invoice_number IS NULL)::int AS new_invoices,
             min(i.d) FILTER (WHERE i.inv_no IS NOT NULL AND k.invoice_number IS NULL)::text AS new_from,
             max(i.d) FILTER (WHERE i.inv_no IS NOT NULL AND k.invoice_number IS NULL)::text AS new_to,
             round(coalesce(sum(i.total) FILTER (WHERE i.inv_no IS NOT NULL AND k.invoice_number IS NULL), 0), 2)::float AS new_total
        FROM _inv i LEFT JOIN _known k ON k.invoice_number = i.inv_no AND k.legacy_tranno IS NOT DISTINCT FROM i.tranno`);
    out.invoices.paid_since = (await one(`
      SELECT count(*)::int AS n FROM _inv i JOIN pos_sales p ON p.invoice_number = i.inv_no AND p.legacy_tranno = i.tranno
       WHERE p.amount_paid_usd IS DISTINCT FROM i.paid
         AND (i.inv_no, i.tranno) IN (SELECT inv_no, tranno FROM _inv GROUP BY 1, 2 HAVING count(*) = 1)
         AND (p.invoice_number, p.legacy_tranno) IN (SELECT invoice_number, legacy_tranno FROM pos_sales WHERE legacy_tranno IS NOT NULL GROUP BY 1, 2 HAVING count(*) = 1)`)).n;
  }

  if (want('INVDETAI')) {
    out.lines = await one(`
      SELECT count(*)::int AS rows,
             count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM pos_sales s WHERE s.invoice_number = btrim(l.inv_number)))::int AS for_new_invoices,
             max(legacy_date(ddate))::text AS last_date
        FROM legacy_invdetai l`);
    out.lines.excel_limit = out.lines.rows >= 1048565 && out.lines.rows <= 1048575;
  }

  if (want('INVPAY')) {
    await c.query(`CREATE TEMP TABLE _fp AS SELECT btrim(inv_number) AS inv_no, count(*)::int AS n, sum(legacy_num0(amount)) AS amt FROM legacy_invpay GROUP BY 1`);
    await c.query(`CREATE TEMP TABLE _sp AS SELECT s.invoice_number AS inv_no, count(p.id)::int AS n FROM pos_sales s LEFT JOIN sale_payments p ON p.sale_id = s.id
                    WHERE s.invoice_number IN (SELECT inv_no FROM _fp) GROUP BY 1`);
    out.payments = await one(`
      SELECT (SELECT count(*) FROM legacy_invpay)::int AS rows,
             coalesce(sum(f.n) FILTER (WHERE s.inv_no IS NULL), 0)::int AS for_new_invoices,
             count(*) FILTER (WHERE s.inv_no IS NOT NULL AND f.n > s.n)::int AS invoices_paid_since,
             (SELECT max(legacy_date(pay_date)) FROM legacy_invpay)::text AS last_date
        FROM _fp f LEFT JOIN _sp s ON s.inv_no = f.inv_no`);
  }

  if (want('INVREC')) {
    out.receipts = await one(`
      WITH r AS (
        SELECT coalesce(legacy_name(supplier), '?') || '|' || coalesce(legacy_date(rec_date)::text, '?') || '|'
                 || coalesce(nullif(btrim(coalesce(reference, '')), ''), '~') AS legacy_key
          FROM legacy_invrec WHERE legacy_num0(qty) <> 0 AND abs(legacy_num0(qty)) <= 100000)
      SELECT count(*)::int AS rows,
             count(DISTINCT legacy_key) FILTER (WHERE NOT EXISTS (SELECT 1 FROM purchase_orders p WHERE p.legacy_key = r.legacy_key))::int AS new_receipts,
             count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM purchase_orders p WHERE p.legacy_key = r.legacy_key))::int AS new_lines
        FROM r`);
    out.receipts.last_date = (await one(`SELECT max(legacy_date(rec_date)) FILTER (WHERE legacy_date(rec_date) <= CURRENT_DATE + 1)::text AS d FROM legacy_invrec`)).d;
  }

  const L = [];
  if (out.inventory) L.push(`Stock (INVENTRY): ${fmt(out.inventory.rows)} parts. New: ${fmt(out.inventory.new_parts)}. Stock changed on ${fmt(out.inventory.stock_changed)}, cost on ${fmt(out.inventory.cost_changed)}, price on ${fmt(out.inventory.price_changed)}.`);
  if (out.invoices) L.push(`Invoices (INVOICE): ${fmt(out.invoices.rows)}. New: ${fmt(out.invoices.new_invoices)}` + (out.invoices.new_invoices ? ` (${out.invoices.new_from} to ${out.invoices.new_to}, J$${fmt(out.invoices.new_total)})` : '') + `. Older invoices with a new amount paid: ${fmt(out.invoices.paid_since)}.`);
  if (out.lines) L.push(`Items sold (INVDETAI): ${fmt(out.lines.rows)} lines, up to ${out.lines.last_date}. For invoices not in the system: ${fmt(out.lines.for_new_invoices)}.` + (out.lines.excel_limit ? ' WARNING: this file stops at Excel\'s row limit, so it was cut short.' : ''));
  if (out.payments) L.push(`Payments (INVPAY): ${fmt(out.payments.rows)}, up to ${out.payments.last_date}. For invoices not in the system: ${fmt(out.payments.for_new_invoices)}. Older invoices with more payments: ${fmt(out.payments.invoices_paid_since)}.`);
  if (out.receipts) L.push(`Stock received (INVREC): ${fmt(out.receipts.rows)} rows, up to ${out.receipts.last_date}. New receipts: ${fmt(out.receipts.new_receipts)} (${fmt(out.receipts.new_lines)} lines).`);
  console.log(L.join('\n'));
  console.log('@@check ' + JSON.stringify(out));
} catch (e) {
  console.error('FAILED:', e.message);
  process.exitCode = 1;
} finally {
  c.release();
  await db.end();
}
