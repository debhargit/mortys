// Seed `sale_payments` from the staged INVPAY export -- the payments received.
//
//   node app/tools/load-invpay.mjs [--replace]
//
// Run after load-invoices.mjs. Also fills in pos_sales.payment_method, which
// load-invoices.mjs leaves NULL because the method only exists in INVPAY.
//
// Sign convention. server.js reports takings as SUM(sale_payments.amount_usd)
// GROUPed BY method (admin dashboard, day/shift report), so a refund has to be
// money out or every cash total is overstated. The legacy file stores refunds as
// POSITIVE amounts distinguished only by PAY_DESC ('CASH REFUND' 70,750 rows,
// 'CHEQ REFUND' 329, 'ISSUE CR NOTE' 10,714), so those are loaded negative. The
// giveaway pattern is a credit note like B0000071: a CASH 480.00 and a CASH
// REFUND 480.00 against a 480.00 invoice -- net nil collected, which only comes
// out right if the refund is signed.
//
// PAY_DESC -> method, using the vocabulary the POS itself writes
// ('cash', 'card', 'cheque', 'account', 'other'):
//   CASH                        -> cash          CASH REFUND   -> cash    (neg)
//   CHEQUE                      -> cheque        CHEQ REFUND   -> cheque  (neg)
//   CARD                        -> card
//   ISSUE CR NOTE / CREDIT NOTE -> credit_note (neg)
//   REBATE                      -> other (neg)
//   CHARGE                      -> charge        OTHER/blank   -> other
//
// CHARGE is deliberately NOT mapped to 'account'. getAccountBalance() derives
// A/R as SUM(method='account') - SUM(account_payments), and all 3,087 CHARGE
// invoices are marked TOTAL_PAID = TOTAL in the source, so calling them
// 'account' would invent an outstanding balance the source explicitly denies.
// 'charge' keeps them visible per-method without fabricating A/R.
//
// NOTE ON COVERAGE: INVPAY has no rows dated 2019 or 2020 at all, and only 8,841
// for 2018 against 82,061 invoices. Those years' invoices therefore load with no
// payment rows even though their headers say paid. See reconcile-invoices.mjs,
// which reports the gap rather than papering over it.

import { pool, fmt, ensureLegacySchema } from './lib/db.mjs';

const REPLACE = process.argv.includes('--replace');
// --new-only (the import page): payments only for sales where the file has
// more payments than the system -- new invoices, and older ones paid since --
// and only where the invoice is certain. Every other sale's payments are left
// exactly as they are.
const NEW_ONLY = process.argv.includes('--new-only');

const db = pool(2);
const c = await db.connect();
try {
  await ensureLegacySchema(c);
  const { rows: [{ staged }] } = await c.query('SELECT count(*)::int AS staged FROM legacy_invpay');
  if (!staged) {
    console.error('legacy_invpay is empty -- run: node app/tools/stage-legacy.mjs');
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
    await c.query('TRUNCATE sale_payments RESTART IDENTITY');
    console.log('sale_payments truncated');
  }

  // ---- invoice number -> sale id (same tiering as load-invdetai.mjs) --------
  await c.query(`
    CREATE TEMP TABLE _per_no AS
    SELECT invoice_number, count(*)::int AS n, min(id) AS first_id
      FROM pos_sales WHERE invoice_number IS NOT NULL GROUP BY invoice_number`);
  await c.query('CREATE UNIQUE INDEX ON _per_no (invoice_number)');

  await c.query(`
    CREATE TEMP TABLE _uniq AS
    SELECT s.invoice_number, s.id FROM pos_sales s JOIN _per_no p USING (invoice_number)
     WHERE p.n = 1`);
  await c.query('CREATE UNIQUE INDEX ON _uniq (invoice_number)');

  await c.query(`
    CREATE TEMP TABLE _bytranno AS
    SELECT s.invoice_number, s.legacy_tranno, min(s.id) AS id
      FROM pos_sales s JOIN _per_no p USING (invoice_number)
     WHERE p.n > 1 AND s.legacy_tranno IS NOT NULL
     GROUP BY s.invoice_number, s.legacy_tranno HAVING count(*) = 1`);
  await c.query('CREATE UNIQUE INDEX ON _bytranno (invoice_number, legacy_tranno)');

  // ---- resolve + classify --------------------------------------------------
  await c.query(`
    CREATE TEMP TABLE _pay AS
    WITH base AS (
      SELECT src_line,
             nullif(btrim(coalesce(inv_number, '')), '')   AS inv_no,
             nullif(btrim(coalesce(tranno, '')), '')       AS tranno,
             upper(btrim(coalesce(pay_desc, '')))          AS desc_up,
             legacy_num0(amount)                           AS amount,
             legacy_ts(pay_date, pay_time)                 AS paid_at,
             legacy_date(pay_date)                         AS pay_day,
             nullif(btrim(coalesce(pay_number, '')), '')   AS pay_number,
             nullif(btrim(coalesce(pay_desc2, '')), '')    AS pay_desc2,
             legacy_name(salespersn)                       AS taken_by,
             nullif(btrim(coalesce(cl_name, '')), '')      AS cl_name
        FROM legacy_invpay
    )
    SELECT b.*,
           coalesce(u.id, bt.id, pn.first_id) AS sale_id,
           CASE WHEN u.id IS NOT NULL THEN 'unique'
                WHEN bt.id IS NOT NULL THEN 'by-tranno'
                WHEN pn.first_id IS NOT NULL THEN 'ambiguous-first'
                ELSE 'orphan' END             AS match_kind,
           CASE
             WHEN b.desc_up LIKE '%CR NOTE%' OR b.desc_up = 'CREDIT NOTE' THEN 'credit_note'
             WHEN b.desc_up LIKE 'CHEQ%'  THEN 'cheque'
             WHEN b.desc_up LIKE 'CASH%'  THEN 'cash'
             WHEN b.desc_up = 'CARD'      THEN 'card'
             WHEN b.desc_up = 'CHARGE'    THEN 'charge'
             ELSE 'other' END                 AS method,
           -- refunds and credit notes are money out
           (b.desc_up LIKE '%REFUND%' OR b.desc_up LIKE '%CR NOTE%'
            OR b.desc_up = 'CREDIT NOTE' OR b.desc_up = 'REBATE') AS is_out
      FROM base b
      LEFT JOIN _uniq     u  ON u.invoice_number  = b.inv_no
      LEFT JOIN _per_no   pn ON pn.invoice_number = b.inv_no
      LEFT JOIN _bytranno bt ON bt.invoice_number = b.inv_no AND bt.legacy_tranno = b.tranno`);

  const { rows: [m] } = await c.query(`
    SELECT count(*)::int                                               AS total,
           count(*) FILTER (WHERE match_kind = 'unique')::int           AS k_uniq,
           count(*) FILTER (WHERE match_kind = 'by-tranno')::int        AS k_tran,
           count(*) FILTER (WHERE match_kind = 'ambiguous-first')::int  AS k_amb,
           count(*) FILTER (WHERE match_kind = 'orphan')::int           AS k_orphan,
           count(*) FILTER (WHERE is_out)::int                          AS outflows,
           count(*) FILTER (WHERE paid_at IS NULL)::int                 AS no_date
      FROM _pay`);
  console.log(`staged payments: ${fmt(staged)}`);
  console.log(`attached: unique ${fmt(m.k_uniq)}, by-tranno ${fmt(m.k_tran)}, ambiguous ${fmt(m.k_amb)}`
    + `  |  orphan ${fmt(m.k_orphan)}  |  refunds/credit notes stored negative: ${fmt(m.outflows)}`
    + `  |  unparseable PAY_DATE: ${fmt(m.no_date)}`);

  if (NEW_ONLY) {
    // Keep only the sales the file has more payments for, as one join (a
    // DELETE ... IN (subquery) over 700k rows ran for hours on the full file).
    await c.query(`
      CREATE TEMP TABLE _keep AS
      SELECT f.sale_id
        FROM (SELECT sale_id, count(*)::int AS n FROM _pay
               WHERE sale_id IS NOT NULL AND match_kind IN ('unique', 'by-tranno') GROUP BY sale_id) f
        LEFT JOIN (SELECT sale_id, count(*)::int AS n FROM sale_payments GROUP BY sale_id) d ON d.sale_id = f.sale_id
       WHERE f.n > coalesce(d.n, 0)`);
    const { rows: [{ total }] } = await c.query('SELECT count(*)::int AS total FROM _pay');
    await c.query(`CREATE TEMP TABLE _pay_new AS SELECT p.* FROM _pay p JOIN _keep k ON k.sale_id = p.sale_id WHERE p.match_kind IN ('unique', 'by-tranno')`);
    await c.query('DROP TABLE _pay');
    await c.query('ALTER TABLE _pay_new RENAME TO _pay');
    await c.query('CREATE INDEX ON _pay (sale_id)');
    await c.query('ANALYZE _pay');
    const { rows: [{ kept }] } = await c.query('SELECT count(*)::int AS kept FROM _pay');
    console.log(`payments already in the system (left alone): ${fmt(total - kept)}`);
  } else {
  await c.query(`DELETE FROM legacy_import_rejects WHERE source = 'INVPAY'`);
  await c.query(`
    INSERT INTO legacy_import_rejects (source, reason, key1, key2, payload)
    SELECT 'INVPAY',
           CASE WHEN match_kind = 'orphan' THEN 'no matching invoice'
                ELSE 'ambiguous invoice number' END,
           inv_no, pay_number,
           jsonb_build_object('src_line', src_line, 'pay_desc', desc_up,
                              'amount', amount, 'pay_date', pay_day)
      FROM _pay WHERE match_kind IN ('orphan', 'ambiguous-first')`);
  }

  // sale_payments has no natural key either (INVPAY has no payment id -- its
  // PAY_NUMBER is blank on nearly every row), so a re-run replaces the payment
  // rows of every sale this import touches instead of stacking a second copy.
  // Scoped to the sales in _pay, so payments taken through the POS are safe.
  const wiped = await c.query(`
    DELETE FROM sale_payments
     WHERE sale_id IN (SELECT DISTINCT sale_id FROM _pay WHERE sale_id IS NOT NULL)`);
  if (wiped.rowCount) console.log(`replacing ${fmt(wiped.rowCount)} existing payment(s) on these sales`);

  const ins = await c.query(`
    INSERT INTO sale_payments (sale_id, method, amount_usd, reference, notes, created_at)
    SELECT p.sale_id,
           p.method,
           CASE WHEN p.is_out THEN -p.amount ELSE p.amount END,
           p.pay_number,
           nullif(concat_ws('; ',
             'Legacy ' || p.desc_up,
             CASE WHEN p.pay_desc2 IS NOT NULL THEN p.pay_desc2 END,
             CASE WHEN p.taken_by IS NOT NULL THEN 'Taken by ' || p.taken_by END,
             CASE WHEN p.cl_name IS NOT NULL THEN 'Payer: ' || p.cl_name END,
             'INVPAY.csv line ' || p.src_line), ''),
           coalesce(p.paid_at, (SELECT s.created_at FROM pos_sales s WHERE s.id = p.sale_id))
      FROM _pay p
     WHERE p.sale_id IS NOT NULL`);

  // ---- stamp the dominant method onto each sale ----------------------------
  // "Dominant" = the method that brought the most money in on that sale; a sale
  // whose only rows are refunds falls back to the single method present.
  const upd = await c.query(`
    WITH ranked AS (
      SELECT sale_id, method,
             row_number() OVER (PARTITION BY sale_id
                                ORDER BY sum(amount_usd) DESC, count(*) DESC, method) AS rn
        FROM sale_payments` + (NEW_ONLY ? ' WHERE sale_id IN (SELECT DISTINCT sale_id FROM _pay)' : '') + ` GROUP BY sale_id, method
    )
    UPDATE pos_sales s SET payment_method = r.method
      FROM ranked r WHERE r.sale_id = s.id AND r.rn = 1
       AND (s.payment_method IS DISTINCT FROM r.method)`);

  await c.query('COMMIT');
  if (NEW_ONLY) {
    console.log(`\npayments added: ${fmt(ins.rowCount)} (replacing ${fmt(wiped.rowCount)} on invoices paid since)`);
    console.log('@@result ' + JSON.stringify({ step: 'invpay', added: ins.rowCount, replaced: wiped.rowCount }));
    process.exit(0);
  }

  const { rows: byMethod } = await c.query(`
    SELECT method, count(*)::int AS n, round(sum(amount_usd), 2)::text AS total
      FROM sale_payments GROUP BY method ORDER BY sum(amount_usd) DESC`);
  const { rows: [t] } = await c.query(`
    SELECT count(*)::int                        AS payments,
           count(DISTINCT sale_id)::int         AS sales_covered,
           round(sum(amount_usd), 2)::text      AS net_collected,
           min(created_at)::date::text          AS first_pay,
           max(created_at)::date::text          AS last_pay
      FROM sale_payments`);

  console.log(`\ninserted ${fmt(ins.rowCount)} payments  |  payment_method stamped on ${fmt(upd.rowCount)} sales`);
  console.log(`sale_payments now: ${fmt(t.payments)}  |  covers ${fmt(t.sales_covered)} of ${fmt(sales)} sales`);
  console.log(`net collected: ${fmt(t.net_collected)}  |  ${t.first_pay} .. ${t.last_pay}`);
  console.log('\nby method:');
  for (const r of byMethod) console.log(`  ${r.method.padEnd(12)} ${String(fmt(r.n)).padStart(9)} rows  ${fmt(r.total).padStart(18)}`);
} catch (e) {
  await c.query('ROLLBACK').catch(() => {});
  console.error('FAILED, rolled back:', e.message);
  process.exitCode = 1;
} finally {
  c.release();
  await db.end();
}
