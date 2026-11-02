// Seed `pos_sales` from the staged INVOICE export -- the invoice headers.
//
//   node app/tools/load-invoices.mjs [--replace]
//
// Run order: stage-legacy -> load-suppliers -> load-inventry -> load-users
//            -> load-salesreps -> load-invoices -> load-invdetai -> load-invpay
//
// Key handling. pos_sales.receipt_number is UNIQUE, but NEITHER legacy key is:
//   INV_NUMBER  931,078 rows / 929,860 distinct -- the counter was reset, so
//               e.g. B0000201 is one invoice on 2011-09-28 and a different one
//               (different total, different TRANNO) on 2012-12-22.
//   TRANNO      931,078 rows / 721,630 distinct -- reused across the A and B
//               series.
// Rather than drop the 1,218 collisions, receipt_number gets a -2 / -3 suffix
// in source order; the original number stays in invoice_number (not unique) and
// the transaction number in legacy_tranno. Every source row lands in the table,
// and each suffixed row is also recorded in legacy_import_rejects so the
// collisions are easy to review.
//
// STATUS. 'A' (861,666) and 'C' (69,369) are both live invoices with positive
// totals that were paid -- 'C' is the legacy credit-note / returned-goods form
// (64% of them carry a CASH REFUND or ISSUE CR NOTE payment in INVPAY). Neither
// is a void, so `voided` stays false for all of them and the legacy status is
// recorded in notes instead of being guessed away.
//
// payment_method is deliberately left NULL here: the method lives in INVPAY, so
// load-invpay.mjs fills it in from the payments it actually loads.
// discount_usd is likewise left 0 and computed by reconcile-invoices.mjs from
// the line items, which are the only place a per-line discount is recorded.

import { pool, fmt, ensureLegacySchema } from './lib/db.mjs';

const REPLACE = process.argv.includes('--replace');
// --new-only (the import page): add only invoices the system does not have --
// by INV_NUMBER and TRANNO, since the legacy program reused invoice numbers --
// and on the ones it has, bring across only what has been paid since (account
// invoices paid later). Nothing else on an existing sale is touched.
const NEW_ONLY = process.argv.includes('--new-only');

const db = pool(2);
const c = await db.connect();
try {
  await ensureLegacySchema(c);
  const { rows: [{ staged }] } = await c.query('SELECT count(*)::int AS staged FROM legacy_invoice');
  if (!staged) {
    console.error('legacy_invoice is empty -- run: node app/tools/stage-legacy.mjs');
    process.exit(1);
  }
  const { rows: [pre] } = await c.query(`
    SELECT (SELECT count(*) FROM users WHERE is_staff)::int AS staff,
           (SELECT count(*) FROM mechanics)::int            AS reps`);
  if (!pre.staff || !pre.reps) {
    console.error('run load-users.mjs and load-salesreps.mjs first (need staff users and the rep roster)');
    process.exit(1);
  }

  await c.query('BEGIN');
  // Long single-statement scans over ~1M rows; let the planner parallelise.
  await c.query("SET LOCAL work_mem = '256MB'");

  if (REPLACE) {
    // pos_sale_items and sale_payments cascade off pos_sales.
    await c.query('TRUNCATE pos_sales RESTART IDENTITY CASCADE');
    console.log('pos_sales truncated (sale items and payments cascaded)');
  }

  // ---- name -> id lookups --------------------------------------------------
  // Staff and reps are keyed the same way load-users.mjs built them: upper-cased
  // letters and digits only, so 'K BLAIR' and 'KBLAIR' resolve to one person.
  await c.query(`
    CREATE TEMP TABLE _staff AS
    SELECT upper(regexp_replace(name, '[^A-Za-z0-9]', '', 'g')) AS key, min(id) AS id
      FROM users WHERE is_staff AND name IS NOT NULL
     GROUP BY 1`);
  await c.query('CREATE UNIQUE INDEX ON _staff (key)');

  await c.query(`
    CREATE TEMP TABLE _rep AS
    SELECT upper(regexp_replace(name, '[^A-Za-z0-9]', '', 'g')) AS key, min(id) AS id
      FROM mechanics WHERE name IS NOT NULL
     GROUP BY 1`);
  await c.query('CREATE UNIQUE INDEX ON _rep (key)');

  // Account customers are keyed on the upper-cased name as legacy_name()
  // normalises it -- that collapses runs of whitespace, so the key built here
  // must do the same or names like 'ZION  RICHARDS' (double space in the
  // source) never match the user load-users.mjs created for them.
  await c.query(`
    CREATE TEMP TABLE _cust AS
    SELECT upper(regexp_replace(btrim(name), '\\s+', ' ', 'g')) AS key, min(id) AS id
      FROM users WHERE NOT is_staff AND name IS NOT NULL
     GROUP BY 1`);
  await c.query('CREATE UNIQUE INDEX ON _cust (key)');

  const { rows: [walkin] } = await c.query(`
    SELECT id FROM users
     WHERE email = 'walkin@visionautosolutions.local'
        OR lower(name) LIKE '%walk-in%'
     ORDER BY id LIMIT 1`);
  if (!walkin) throw new Error('no walk-in customer user found; expected walkin@visionautosolutions.local');
  console.log(`walk-in customer user: id ${walkin.id}`);

  // ---- resolve + de-collide ------------------------------------------------
  await c.query(`
    CREATE TEMP TABLE _sale AS
    WITH base AS (
      SELECT
        src_line,
        nullif(btrim(coalesce(inv_number, '')), '')          AS inv_no,
        legacy_ts(inv_date, inv_time)                        AS created_at,
        legacy_date(inv_date)                                AS inv_day,
        legacy_name(salespersn)                              AS rep_name,
        legacy_name(app_user)                                AS user_name,
        legacy_name(customer)                                AS cust_name,
        upper(btrim(coalesce(customer, '')))                 AS cust_up,
        nullif(btrim(coalesce(phone, '')), '')               AS phone,
        nullif(btrim(coalesce(reference, '')), '')           AS reference,
        legacy_num0(sub_total)                               AS subtotal,
        legacy_num0(tax)                                     AS tax,
        legacy_num0(total)                                   AS total,
        legacy_num0(total_paid)                              AS paid,
        legacy_num(tend)                                     AS tend,
        legacy_num(change_due)                               AS change_due,
        upper(btrim(coalesce(status, '')))                   AS status,
        upper(btrim(coalesce(taxable, '')))                  AS taxable,
        upper(btrim(coalesce(cred_terms, '')))               AS terms,
        nullif(btrim(coalesce(reason, '')), '')              AS reason,
        nullif(btrim(coalesce(tranno, '')), '')              AS tranno,
        nullif(btrim(coalesce(receipt, '')), '')             AS receipt
      FROM legacy_invoice
    ), keyed AS (
      SELECT b.*,
             -- blank INV_NUMBER (39 rows) still gets a stable receipt number
             coalesce(b.inv_no, 'LEGACY-' || b.src_line) AS base_no,
             row_number() OVER (PARTITION BY coalesce(b.inv_no, 'LEGACY-' || b.src_line)
                                ORDER BY b.src_line) AS dup_n,
             -- -1 for a credit note, 1 for a sale. See the money columns below.
             CASE WHEN b.inv_no LIKE 'CN%' THEN -1 ELSE 1 END AS sign
        FROM base b
    )
    SELECT
      k.src_line,
      CASE WHEN k.dup_n = 1 THEN k.base_no ELSE k.base_no || '-' || k.dup_n END AS receipt_number,
      k.base_no                                        AS invoice_number,
      k.dup_n,
      k.tranno                                         AS legacy_tranno,
      coalesce(k.created_at, k.inv_day::timestamptz)   AS created_at,
      st.id                                            AS cashier_id,
      coalesce(k.user_name, k.rep_name)                AS cashier_name,
      CASE WHEN k.cust_up = 'CASH' OR k.cust_name IS NULL THEN ${walkin.id} ELSE cu.id END AS customer_id,
      coalesce(k.cust_name, 'CASH')                    AS customer_name,
      k.phone                                          AS customer_phone,
      rp.id                                            AS sales_rep_id,
      k.rep_name                                       AS sales_rep_name,
      -- A 'CN' invoice number is a credit note: goods came back and money went
      -- out. The legacy file stores them with everything POSITIVE, exactly like
      -- a sale -- 112,044 of them, J$320,091,292.96 -- so loading them verbatim
      -- counts a return as revenue and overstates sales by twice their value.
      -- Signed negative here instead, which is what makes them net out of every
      -- aggregate downstream without a single report having to know what a "CN"
      -- invoice is. load-invdetai.mjs signs their lines and quantities to match.
      k.sign * k.subtotal AS subtotal,
      k.sign * k.tax      AS tax,
      k.sign * k.total    AS total,
      k.sign * k.paid     AS paid,
      k.tend, k.change_due,
      greatest(k.total - k.paid, 0)                    AS balance_due,
      CASE WHEN k.paid >= k.total - 0.005 THEN 'paid'
           WHEN k.paid > 0               THEN 'partial'
           ELSE 'unpaid' END                           AS payment_status,
      (k.taxable = 'N')                                AS tax_exempt,
      k.reference,
      -- net-days credit terms drive the due date; COD and blanks have none
      CASE WHEN k.terms ~ '^N[0-9]{1,3}$' AND k.inv_day IS NOT NULL
           THEN k.inv_day + (substring(k.terms from 2))::int END AS due_date,
      nullif(concat_ws('; ',
        -- The CN prefix is the credit-note marker, not STATUS: 112,044 invoices
        -- are numbered CN* while only 3 carry STATUS='C'.
        CASE WHEN k.sign = -1 THEN 'Credit note (CN invoice number); money and quantities signed negative' END,
        CASE WHEN k.status = 'C' THEN 'Legacy STATUS=C'
             WHEN k.status <> 'A' AND k.status <> '' THEN 'Legacy STATUS=' || k.status END,
        CASE WHEN k.reason IS NOT NULL THEN 'Reason: ' || k.reason END,
        CASE WHEN k.terms <> '' THEN 'Terms: ' || k.terms END,
        CASE WHEN k.receipt IS NOT NULL THEN 'Receipt: ' || k.receipt END,
        'Imported from INVOICE.csv line ' || k.src_line
      ), '')                                           AS notes
    FROM keyed k
    LEFT JOIN _staff st ON st.key = upper(regexp_replace(coalesce(k.user_name, k.rep_name, ''), '[^A-Za-z0-9]', '', 'g'))
    LEFT JOIN _rep   rp ON rp.key = upper(regexp_replace(coalesce(k.rep_name, ''), '[^A-Za-z0-9]', '', 'g'))
    LEFT JOIN _cust  cu ON cu.key = upper(k.cust_name)`);

  const { rows: [d] } = await c.query(`
    SELECT count(*)::int                                          AS total,
           count(*) FILTER (WHERE dup_n > 1)::int                 AS collided,
           count(*) FILTER (WHERE created_at IS NULL)::int         AS no_date,
           count(*) FILTER (WHERE cashier_id IS NULL)::int         AS no_cashier,
           count(*) FILTER (WHERE sales_rep_id IS NULL)::int       AS no_rep,
           count(*) FILTER (WHERE customer_id IS NULL)::int        AS no_customer
      FROM _sale`);
  console.log(`staged invoices: ${fmt(staged)}  |  prepared: ${fmt(d.total)}`);
  console.log(`receipt_number collisions suffixed: ${fmt(d.collided)}`
    + `  |  unresolved: cashier ${fmt(d.no_cashier)}, rep ${fmt(d.no_rep)}, customer ${fmt(d.no_customer)}`
    + `  |  no usable date: ${fmt(d.no_date)}`);

  // Park the collisions so the renumbering is auditable rather than silent.
  await c.query(`DELETE FROM legacy_import_rejects WHERE source = 'INVOICE' AND reason = 'duplicate INV_NUMBER'`);
  await c.query(`
    INSERT INTO legacy_import_rejects (source, reason, key1, key2, payload)
    SELECT 'INVOICE', 'duplicate INV_NUMBER', invoice_number, receipt_number,
           jsonb_build_object('src_line', src_line, 'tranno', legacy_tranno,
                              'created_at', created_at, 'total', total)
      FROM _sale WHERE dup_n > 1`);

  if (NEW_ONLY) {
    await c.query(`CREATE TEMP TABLE _known AS SELECT DISTINCT invoice_number, legacy_tranno FROM pos_sales WHERE invoice_number IS NOT NULL`);
    await c.query('CREATE INDEX ON _known (invoice_number, legacy_tranno)');
    // A new invoice whose number is already a receipt (the counter was reset)
    // takes -L<line>, like the -2/-3 suffixes the first load gave collisions.
    const added = await c.query(`
      INSERT INTO pos_sales (
        receipt_number, invoice_number, legacy_tranno, created_at,
        cashier_id, cashier_name, customer_id, customer_name, customer_phone,
        sales_rep_id, sales_rep_name,
        subtotal_usd, tax_usd, total_usd, amount_paid_usd, balance_due_usd,
        amount_tendered, change_due, payment_status, tax_exempt, reference,
        due_date, notes, voided, fulfilment)
      SELECT CASE WHEN EXISTS (SELECT 1 FROM pos_sales p WHERE p.receipt_number = s.receipt_number)
                  THEN s.invoice_number || '-L' || s.src_line ELSE s.receipt_number END,
             s.invoice_number, s.legacy_tranno, s.created_at,
             s.cashier_id, s.cashier_name, s.customer_id, s.customer_name, s.customer_phone,
             s.sales_rep_id, s.sales_rep_name,
             s.subtotal, s.tax, s.total, s.paid, s.balance_due,
             s.tend, s.change_due, s.payment_status, s.tax_exempt, s.reference,
             s.due_date, s.notes, false, 'pickup'
        FROM _sale s
       WHERE s.invoice_number NOT LIKE 'LEGACY-%'
         AND NOT EXISTS (SELECT 1 FROM _known k WHERE k.invoice_number = s.invoice_number
                                                  AND k.legacy_tranno IS NOT DISTINCT FROM s.legacy_tranno)
      ON CONFLICT (receipt_number) DO NOTHING`);
    // Only where the (number, TRANNO) pair is on one row of the file: a few pairs
    // repeat with different amounts, and matching those crosswise would flip
    // the amounts paid back and forth on every import.
    const paid = await c.query(`
      UPDATE pos_sales p
         SET amount_paid_usd = s.paid, balance_due_usd = s.balance_due, payment_status = s.payment_status
        FROM _sale s
       WHERE p.legacy_tranno IS NOT NULL AND p.invoice_number = s.invoice_number AND p.legacy_tranno = s.legacy_tranno
         AND (s.invoice_number, s.legacy_tranno) IN (SELECT invoice_number, legacy_tranno FROM _sale GROUP BY 1, 2 HAVING count(*) = 1)
         AND (p.invoice_number, p.legacy_tranno) IN (SELECT invoice_number, legacy_tranno FROM pos_sales WHERE legacy_tranno IS NOT NULL
                                                      AND invoice_number IN (SELECT invoice_number FROM _sale) GROUP BY 1, 2 HAVING count(*) = 1)
         AND (p.amount_paid_usd IS DISTINCT FROM s.paid OR p.balance_due_usd IS DISTINCT FROM s.balance_due)`);
    await c.query('COMMIT');
    console.log(`\nnew invoices added: ${fmt(added.rowCount)}  |  older invoices with a new amount paid: ${fmt(paid.rowCount)}`);
    console.log('@@result ' + JSON.stringify({ step: 'invoices', added: added.rowCount, updated: paid.rowCount }));
    process.exit(0);
  }

  const ins = await c.query(`
    INSERT INTO pos_sales (
      receipt_number, invoice_number, legacy_tranno, created_at,
      cashier_id, cashier_name, customer_id, customer_name, customer_phone,
      sales_rep_id, sales_rep_name,
      subtotal_usd, tax_usd, total_usd, amount_paid_usd, balance_due_usd,
      amount_tendered, change_due, payment_status, tax_exempt, reference,
      due_date, notes, voided, fulfilment)
    SELECT receipt_number, invoice_number, legacy_tranno, created_at,
           cashier_id, cashier_name, customer_id, customer_name, customer_phone,
           sales_rep_id, sales_rep_name,
           subtotal, tax, total, paid, balance_due,
           tend, change_due, payment_status, tax_exempt, reference,
           due_date, notes, false, 'pickup'
      FROM _sale
    ON CONFLICT (receipt_number) DO UPDATE SET
      invoice_number  = EXCLUDED.invoice_number,
      legacy_tranno   = EXCLUDED.legacy_tranno,
      created_at      = EXCLUDED.created_at,
      cashier_id      = EXCLUDED.cashier_id,
      cashier_name    = EXCLUDED.cashier_name,
      customer_id     = EXCLUDED.customer_id,
      customer_name   = EXCLUDED.customer_name,
      customer_phone  = EXCLUDED.customer_phone,
      sales_rep_id    = EXCLUDED.sales_rep_id,
      sales_rep_name  = EXCLUDED.sales_rep_name,
      subtotal_usd    = EXCLUDED.subtotal_usd,
      tax_usd         = EXCLUDED.tax_usd,
      total_usd       = EXCLUDED.total_usd,
      amount_paid_usd = EXCLUDED.amount_paid_usd,
      balance_due_usd = EXCLUDED.balance_due_usd,
      amount_tendered = EXCLUDED.amount_tendered,
      change_due      = EXCLUDED.change_due,
      payment_status  = EXCLUDED.payment_status,
      tax_exempt      = EXCLUDED.tax_exempt,
      reference       = EXCLUDED.reference,
      due_date        = EXCLUDED.due_date,
      notes           = EXCLUDED.notes`);

  await c.query('COMMIT');

  const { rows: [t] } = await c.query(`
    SELECT count(*)::int                                           AS sales,
           count(*) FILTER (WHERE payment_status = 'paid')::int     AS paid,
           count(*) FILTER (WHERE payment_status = 'partial')::int  AS partial,
           count(*) FILTER (WHERE payment_status = 'unpaid')::int   AS unpaid,
           count(*) FILTER (WHERE sales_rep_id IS NOT NULL)::int    AS with_rep,
           round(sum(total_usd), 2)::text                           AS revenue,
           min(created_at)::date::text                              AS first_sale,
           max(created_at)::date::text                              AS last_sale
      FROM pos_sales`);
  console.log(`\nupserted ${fmt(ins.rowCount)} sales`);
  console.log(`pos_sales now: ${fmt(t.sales)}  |  paid ${fmt(t.paid)}, partial ${fmt(t.partial)}, unpaid ${fmt(t.unpaid)}`
    + `  |  with a rep: ${fmt(t.with_rep)}`);
  console.log(`billed total: ${fmt(t.revenue)}  |  ${t.first_sale} .. ${t.last_sale}`);
} catch (e) {
  await c.query('ROLLBACK').catch(() => {});
  console.error('FAILED, rolled back:', e.message);
  process.exitCode = 1;
} finally {
  c.release();
  await db.end();
}
