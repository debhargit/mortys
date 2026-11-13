// =============================================================================
//  Vision Auto Solutions -- Balancing report
//
//  GET /api/rep/balancing?from=YYYY-MM-DD&to=YYYY-MM-DD&by=day|week|month|hour|weekday
//  One report, four checks that must tie out:
//    1. Inventory roll-forward (units, cost, retail):
//         opening + receipts - sold + returned + adjustments = closing
//    2. Sales: gross, discounts, net, tax, credit notes (returns), cost of
//       sales, gross profit.
//    3. Sales vs inventory: net sales split into catalogue parts (taken out of
//       stock) and other lines; units sold = units relieved from stock.
//    4. Collections vs sales: billed = paid (by method) + paid without a
//       recorded method + still owed; refunds, account payments.
//  Plus earnings by time bucket. Read-only. Times are Jamaica local.
//
//  Honesty about history: until the stock ledger existed nothing recorded
//  stock changes, so for any period (or part of one) before the ledger
//  started, closing stock is worked back from today's stock using sales,
//  credit notes and receipts, and adjustments cannot be seen. Old sale lines
//  have no cost-at-sale, so today's average cost stands in. The response
//  says which parts are estimated.
// =============================================================================
'use strict';

const TZ = 'America/Jamaica';
const BUCKETS = {
  day: `to_char(created_at AT TIME ZONE '${TZ}', 'YYYY-MM-DD')`,
  week: `to_char(date_trunc('week', created_at AT TIME ZONE '${TZ}'), 'YYYY-MM-DD')`,
  month: `to_char(created_at AT TIME ZONE '${TZ}', 'YYYY-MM')`,
  hour: `to_char(created_at AT TIME ZONE '${TZ}', 'HH24') || ':00'`,
  weekday: `to_char(created_at AT TIME ZONE '${TZ}', 'ID') || ' ' || to_char(created_at AT TIME ZONE '${TZ}', 'Dy')`,
};

function register(app, deps) {
  const { query, requireAdmin, requireCap } = deps;
  const n = (v) => (v == null ? 0 : Number(v));
  const r2 = (v) => Math.round(n(v) * 100) / 100;

  app.get('/api/rep/balancing', requireAdmin, requireCap('reports.view'), async (req, res) => {
    try {
      const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : null;
      const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : null;
      if (!from || !to || from > to) return res.status(400).json({ error: 'Choose a from and to date' });
      const by = BUCKETS[req.query.by] ? req.query.by : 'day';

      // Period edges as instants, Jamaica midnight to midnight.
      const { rows: edge } = await query(
        `SELECT ($1::date)::timestamp AT TIME ZONE '${TZ}' AS t0, ($2::date + 1)::timestamp AT TIME ZONE '${TZ}' AS t1, NOW() AS now,
                (SELECT value::timestamptz FROM warehouse_settings WHERE key = 'stock_ledger_started') AS ledger_from`, [from, to]);
      const { t0, t1, ledger_from: ledgerFrom } = edge[0];
      if (t1 > edge[0].now && t0 > edge[0].now) return res.status(400).json({ error: 'That period is in the future' });
      const ledgerCoversPeriod = !!ledgerFrom && ledgerFrom <= t0;
      const ledgerCoversAfter = !!ledgerFrom && ledgerFrom <= t1;

      const P = [t0, t1];
      const SALES = `SELECT * FROM pos_sales WHERE created_at >= $1 AND created_at < $2 AND NOT COALESCE(voided, false)`;
      const IS_CN = `(s.receipt_number LIKE 'CN%')`;

      // ---------------------------------------------------------- sales --
      const { rows: hdr } = await query(
        `SELECT
           COUNT(*) FILTER (WHERE NOT ${IS_CN})::int                         AS sales_count,
           COALESCE(SUM(subtotal_usd) FILTER (WHERE NOT ${IS_CN}), 0)        AS net_lines,
           COALESCE(SUM(discount_usd) FILTER (WHERE NOT ${IS_CN}), 0)        AS ticket_discount,
           COALESCE(SUM(loyalty_discount_usd) FILTER (WHERE NOT ${IS_CN}), 0) AS loyalty_discount,
           COALESCE(SUM(tax_usd) FILTER (WHERE NOT ${IS_CN}), 0)             AS tax,
           COALESCE(SUM(ship_fee_usd) FILTER (WHERE NOT ${IS_CN}), 0)        AS ship_fees,
           COALESCE(SUM(total_usd) FILTER (WHERE NOT ${IS_CN}), 0)           AS billed,
           COALESCE(SUM(amount_paid_usd) FILTER (WHERE NOT ${IS_CN}), 0)     AS paid_on_sales,
           COALESCE(SUM(balance_due_usd) FILTER (WHERE NOT ${IS_CN}), 0)     AS still_owed,
           COUNT(*) FILTER (WHERE ${IS_CN})::int                             AS cn_count,
           COALESCE(SUM(subtotal_usd) FILTER (WHERE ${IS_CN}), 0)            AS cn_net,
           COALESCE(SUM(tax_usd) FILTER (WHERE ${IS_CN}), 0)                 AS cn_tax,
           COALESCE(SUM(total_usd) FILTER (WHERE ${IS_CN}), 0)               AS cn_total
         FROM (${SALES}) s`, P);
      const { rows: voids } = await query(
        `SELECT COUNT(*)::int AS n, COALESCE(SUM(total_usd), 0) AS total FROM pos_sales WHERE created_at >= $1 AND created_at < $2 AND voided`, P);

      const { rows: ln } = await query(
        `SELECT ${IS_CN} AS cn, (p.img IS NOT NULL) AS stocked,
                COALESCE(SUM(i.unit_price_usd * i.qty), 0)                     AS gross,
                COALESCE(SUM(i.discount_usd), 0)                               AS line_discount,
                COALESCE(SUM(i.total_usd), 0)                                  AS net,
                COALESCE(SUM(COALESCE(i.core_charge_usd,0) + COALESCE(i.env_fee_usd,0)), 0) AS fees,
                COALESCE(SUM(i.qty), 0)::int                                   AS units,
                COALESCE(SUM(i.qty * COALESCE(i.unit_cost, p.cost_usd, 0)), 0) AS cost,
                COALESCE(SUM(i.qty * COALESCE(i.unit_cost, p.cost_usd, 0)) FILTER (WHERE i.unit_cost IS NULL), 0) AS cost_estimated,
                COUNT(*)::int AS lines, COUNT(*) FILTER (WHERE p.img IS NOT NULL AND COALESCE(i.unit_cost, p.cost_usd, 0) = 0)::int AS lines_no_cost
           FROM (${SALES}) s JOIN pos_sale_items i ON i.sale_id = s.id LEFT JOIN products p ON p.img = i.product_img
          GROUP BY 1, 2`, P);
      const pick = (cn, stocked) => ln.find((x) => x.cn === cn && x.stocked === stocked) || {};
      const sp = pick(false, true), so = pick(false, false), rp = pick(true, true), ro = pick(true, false);
      const h = hdr[0];

      const sales = {
        transactions: h.sales_count,
        gross: r2(n(sp.gross) + n(so.gross)),
        line_discounts: r2(n(sp.line_discount) + n(so.line_discount)),
        ticket_discounts: r2(h.ticket_discount),
        loyalty_discounts: r2(h.loyalty_discount),
        net_sales: r2(n(h.net_lines) - n(h.ticket_discount)),
        tax: r2(h.tax),
        shipping_fees: r2(h.ship_fees),
        billed: r2(h.billed),
        cost_of_sales: r2(sp.cost),
        returns: { count: h.cn_count, net: r2(h.cn_net), tax: r2(h.cn_tax), total: r2(h.cn_total), units: -n(rp.units), cost: r2(-n(rp.cost)) },
        voided: { count: voids[0].n, total: r2(voids[0].total) },
      };
      sales.net_after_returns = r2(sales.net_sales + n(h.cn_net));
      sales.cost_after_returns = r2(sales.cost_of_sales - sales.returns.cost);
      sales.gross_profit = r2(sales.net_after_returns - sales.cost_after_returns);
      sales.margin_pct = sales.net_after_returns ? Math.round(sales.gross_profit / sales.net_after_returns * 1000) / 10 : null;

      // ------------------------------------------------ sales vs inventory --
      // The receipts behind any lines-vs-totals gap, so it can be looked up.
      const { rows: mism } = await query(
        `SELECT s.receipt_number, s.created_at, s.subtotal_usd::float AS total, COALESCE(SUM(i.total_usd), 0)::float AS lines
           FROM (${SALES}) s LEFT JOIN pos_sale_items i ON i.sale_id = s.id
          GROUP BY s.id, s.receipt_number, s.created_at, s.subtotal_usd
         HAVING ABS(s.subtotal_usd - COALESCE(SUM(i.total_usd), 0)) >= 0.01
          ORDER BY ABS(s.subtotal_usd - COALESCE(SUM(i.total_usd), 0)) DESC LIMIT 25`, P);
      const salesVsInventory = {
        mismatched_receipts: mism.map((x) => ({ receipt: x.receipt_number, at: x.created_at, total: r2(x.total), lines: r2(x.lines), difference: r2(x.total - x.lines) })),
        catalogue_parts: { net: r2(sp.net), units: n(sp.units), cost: r2(sp.cost), lines: n(sp.lines) },
        other_lines: { net: r2(so.net), lines: n(so.lines), note: 'Labour, services, fees and parts no longer in the catalogue: sold, but not taken out of stock' },
        lines_total: r2(n(sp.net) + n(so.net)),
        header_total: r2(h.net_lines),
        difference: r2(n(h.net_lines) - n(sp.net) - n(so.net)),
        returns_to_stock_units: -n(rp.units),
        returns_other_lines: r2(ro.net),
        lines_without_cost: n(sp.lines_no_cost),
      };

      // ---------------------------------------------------- collections --
      const { rows: pay } = await query(
        `SELECT ${IS_CN} AS cn, lower(COALESCE(p.method, 'unknown')) AS method, COUNT(*)::int AS n, COALESCE(SUM(p.amount_usd), 0) AS amount
           FROM (${SALES}) s JOIN sale_payments p ON p.sale_id = s.id GROUP BY 1, 2 ORDER BY 1, 4 DESC`, P);
      const { rows: acct } = await query(
        `SELECT lower(COALESCE(method, 'unknown')) AS method, COUNT(*)::int AS n, COALESCE(SUM(amount_usd), 0) AS amount
           FROM account_payments WHERE method NOT IN ('writeoff', 'credit_note') AND created_at >= $1 AND created_at < $2 GROUP BY 1 ORDER BY 3 DESC`, P);
      const onSales = pay.filter((x) => !x.cn && x.method !== 'charge');
      const detail = onSales.reduce((s, x) => s + n(x.amount), 0);
      const chargeRows = pay.filter((x) => !x.cn && x.method === 'charge');
      const collections = {
        billed: sales.billed,
        by_method: onSales.map((x) => ({ method: x.method, count: x.n, amount: r2(x.amount) })),
        recorded_total: r2(detail),
        paid_without_method: r2(n(h.paid_on_sales) - detail),
        still_owed: r2(h.still_owed),
        charged_to_account_count: chargeRows.reduce((s, x) => s + x.n, 0),
        difference: r2(sales.billed - n(h.paid_on_sales) - n(h.still_owed)),
        refunds_by_method: pay.filter((x) => x.cn).map((x) => ({ method: x.method, count: x.n, amount: r2(x.amount) })),
        credit_notes_total: r2(h.cn_total),
        account_payments: acct.map((x) => ({ method: x.method, count: x.n, amount: r2(x.amount) })),
      };
      // Real money only: a credit note used as payment, or a charge to account, is not cash in.
      const isMoney = (m) => !/note|charge|account|store|gift|loyal|redeem/.test(m) && /cash|cheque|check|card|debit|visa|master|transfer|bank|wire|fygaro|stripe/.test(m);
      const cashIn = onSales.filter((x) => isMoney(x.method)).reduce((s, x) => s + n(x.amount), 0)
        + acct.reduce((s, x) => s + n(x.amount), 0)
        + pay.filter((x) => x.cn).reduce((s, x) => s + n(x.amount), 0);
      collections.money_in = r2(cashIn);

      // ------------------------------------------------------ inventory --
      // Per part: movements inside the period and after it (to today), then
      // closing = today - after-movements, opening = closing - period movements.
      const { rows: inv } = await query(
        `WITH mv AS (
           -- sales (+) and credit notes (-) as units out of stock
           SELECT i.product_img AS img, (s.created_at >= $2) AS after,
                  SUM(i.qty) FILTER (WHERE s.receipt_number NOT LIKE 'CN%') AS sold,
                  -SUM(i.qty) FILTER (WHERE s.receipt_number LIKE 'CN%') AS returned,
                  0::numeric AS received, 0::numeric AS received_cost,
                  SUM(i.qty * COALESCE(i.unit_cost, p.cost_usd, 0)) FILTER (WHERE s.receipt_number NOT LIKE 'CN%') AS sold_cost,
                  SUM(i.unit_price_usd * i.qty) FILTER (WHERE s.receipt_number NOT LIKE 'CN%') AS sold_retail,
                  0::numeric AS ledger
             FROM pos_sales s JOIN pos_sale_items i ON i.sale_id = s.id JOIN products p ON p.img = i.product_img
            WHERE s.created_at >= $1 AND NOT COALESCE(s.voided, false)
            GROUP BY 1, 2
           UNION ALL
           -- receipts through the Receive screen (exact date and landed cost)
           SELECT l.product_img, (r.posted_at >= $2), 0, 0, SUM(l.qty_received), SUM(l.qty_received * COALESCE(l.landed_unit_cost, 0)), 0, 0, 0
             FROM receipts r JOIN receipt_lines l ON l.receipt_id = r.id
            WHERE r.status = 'posted' AND r.posted_at >= $1 AND l.product_img IS NOT NULL
            GROUP BY 1, 2
           UNION ALL
           -- purchase orders received the old way (no receipt record)
           SELECT i.product_img, (po.received_date >= $2), 0, 0, SUM(i.qty_received), SUM(i.qty_received * COALESCE(i.unit_cost_usd, 0)), 0, 0, 0
             FROM purchase_orders po JOIN purchase_order_items i ON i.po_id = po.id
            WHERE po.received_date >= $1 AND COALESCE(i.qty_received, 0) > 0 AND i.product_img IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.po_id = po.id)
            GROUP BY 1, 2
           UNION ALL
           -- every stock change, whatever made it (only from the day the ledger started)
           SELECT product_img, (created_at >= $2), 0, 0, 0, 0, 0, 0, SUM(delta)
             FROM stock_ledger WHERE created_at >= $1 GROUP BY 1, 2
         ),
         per AS (
           SELECT p.img, p.stock_count AS now_qty, COALESCE(p.cost_usd, 0) AS cost, COALESCE(p.price_usd, 0) AS price,
                  COALESCE(SUM(m.sold)     FILTER (WHERE NOT m.after), 0) AS sold_in,
                  COALESCE(SUM(m.returned) FILTER (WHERE NOT m.after), 0) AS ret_in,
                  COALESCE(SUM(m.received) FILTER (WHERE NOT m.after), 0) AS rec_in,
                  COALESCE(SUM(m.received_cost) FILTER (WHERE NOT m.after), 0) AS rec_cost_in,
                  COALESCE(SUM(m.sold_cost) FILTER (WHERE NOT m.after), 0) AS sold_cost_in,
                  COALESCE(SUM(m.sold_retail) FILTER (WHERE NOT m.after), 0) AS sold_retail_in,
                  COALESCE(SUM(m.ledger)   FILTER (WHERE NOT m.after), 0) AS ledger_in,
                  COALESCE(SUM(m.sold)     FILTER (WHERE m.after), 0) AS sold_after,
                  COALESCE(SUM(m.returned) FILTER (WHERE m.after), 0) AS ret_after,
                  COALESCE(SUM(m.received) FILTER (WHERE m.after), 0) AS rec_after,
                  COALESCE(SUM(m.ledger)   FILTER (WHERE m.after), 0) AS ledger_after
             FROM products p LEFT JOIN mv m ON m.img = p.img
            GROUP BY p.img, p.stock_count, p.cost_usd, p.price_usd
         ),
         rf AS (
           SELECT *,
                  CASE WHEN $3 THEN now_qty - ledger_after
                       ELSE now_qty + sold_after - ret_after - rec_after END AS close_qty,
                  CASE WHEN $4 THEN ledger_in - (rec_in - sold_in + ret_in) ELSE 0 END AS adj_in
             FROM per
         )
         SELECT
           SUM(close_qty - rec_in + sold_in - ret_in - adj_in)::bigint                     AS open_units,
           SUM((close_qty - rec_in + sold_in - ret_in - adj_in) * cost)                    AS open_cost,
           SUM((close_qty - rec_in + sold_in - ret_in - adj_in) * price)                   AS open_retail,
           SUM(rec_in)::bigint AS rec_units, SUM(rec_cost_in) AS rec_cost, SUM(rec_in * price) AS rec_retail,
           SUM(sold_in)::bigint AS sold_units, SUM(sold_cost_in) AS sold_cost, SUM(sold_retail_in) AS sold_retail,
           SUM(ret_in)::bigint AS ret_units, SUM(ret_in * cost) AS ret_cost, SUM(ret_in * price) AS ret_retail,
           SUM(adj_in)::bigint AS adj_units, SUM(adj_in * cost) AS adj_cost, SUM(adj_in * price) AS adj_retail,
           SUM(close_qty)::bigint AS close_units, SUM(close_qty * cost) AS close_cost, SUM(close_qty * price) AS close_retail,
           COUNT(*) FILTER (WHERE close_qty < 0)::int AS negative_parts
         FROM rf`, [t0, t1, ledgerCoversAfter, ledgerCoversPeriod]);
      const v = inv[0];
      const roll = (k) => ({ units: n(v[k + '_units']), cost: r2(v[k + '_cost']), retail: r2(v[k + '_retail']) });
      const inventory = {
        opening: roll('open'), receipts: roll('rec'), sold: roll('sold'), returned: roll('ret'), adjustments: roll('adj'), closing: roll('close'),
        negative_parts: v.negative_parts,
      };
      const expected = (f) => r2(inventory.opening[f] + inventory.receipts[f] - inventory.sold[f] + inventory.returned[f] + inventory.adjustments[f]);
      inventory.variance = {
        units: inventory.closing.units - (inventory.opening.units + inventory.receipts.units - inventory.sold.units + inventory.returned.units + inventory.adjustments.units),
        cost: r2(inventory.closing.cost - expected('cost')),
        retail: r2(inventory.closing.retail - expected('retail')),
        note: 'Units always tie. The money lines differ because opening and closing are valued at today\'s cost and price while receipts and sales are valued at what they actually cost or sold for: cost changes, price changes and discounts land here.',
      };

      // ------------------------------------------------- time breakdown --
      const bucket = BUCKETS[by].replace(/created_at/g, 's.created_at');
      const { rows: tb } = await query(
        `SELECT ${bucket} AS bucket,
                COUNT(DISTINCT s.id) FILTER (WHERE NOT ${IS_CN})::int AS transactions,
                COALESCE(SUM(i.total_usd) FILTER (WHERE NOT ${IS_CN}), 0) AS net_lines,
                COALESCE(SUM(i.discount_usd) FILTER (WHERE NOT ${IS_CN}), 0) AS discounts,
                COALESCE(SUM(i.total_usd) FILTER (WHERE ${IS_CN}), 0) AS returns,
                COALESCE(SUM(i.qty * COALESCE(i.unit_cost, p.cost_usd, 0)) FILTER (WHERE p.img IS NOT NULL), 0) AS cost
           FROM (${SALES}) s JOIN pos_sale_items i ON i.sale_id = s.id LEFT JOIN products p ON p.img = i.product_img
          GROUP BY 1 ORDER BY 1`, P);
      // Money per bucket from the sale totals (the same source as the summary, so
      // the columns add up to it); cost and discounts from the lines.
      const { rows: tbTax } = await query(
        `SELECT ${bucket} AS bucket, COALESCE(SUM(s.tax_usd), 0) AS tax,
                COALESCE(SUM(s.subtotal_usd - COALESCE(s.discount_usd, 0)) FILTER (WHERE s.receipt_number NOT LIKE 'CN%'), 0) AS net,
                COALESCE(SUM(s.subtotal_usd) FILTER (WHERE s.receipt_number LIKE 'CN%'), 0) AS ret
           FROM (${SALES}) s GROUP BY 1`, P);
      const hBy = new Map(tbTax.map((x) => [x.bucket, x]));
      const earnings = tb.map((x) => {
        const hb = hBy.get(x.bucket) || {};
        const net = n(hb.net) + n(hb.ret);
        const gp = net - n(x.cost);
        return {
          bucket: x.bucket, transactions: x.transactions, net_sales: r2(net), discounts: r2(x.discounts), returns: r2(hb.ret),
          tax: r2(hb.tax), cost: r2(x.cost), gross_profit: r2(gp), margin_pct: net ? Math.round(gp / net * 1000) / 10 : null,
          avg_ticket: x.transactions ? r2(n(hb.net) / x.transactions) : null,
        };
      });

      // ---------------------------------------------- what to trust --
      const notes = [];
      if (!ledgerCoversPeriod) {
        notes.push({ level: 'estimate', text: 'Stock history is only recorded from ' + (ledgerFrom ? new Date(ledgerFrom).toLocaleDateString('en-JM') : 'now') +
          '. For this period opening and closing stock were worked back from today\'s stock using sales, credit notes and receipts, and stock adjustments (manual edits, counts, write-offs) cannot be seen.' });
      }
      if (n(sp.cost_estimated) > 0) {
        notes.push({ level: 'estimate', text: 'Cost of sales uses today\'s average cost for ' + Math.round(n(sp.cost_estimated) / Math.max(n(sp.cost), 1) * 100) + '% of it: those sales were made before cost-at-sale was recorded.' });
      }
      if (sp.lines_no_cost) notes.push({ level: 'check', text: sp.lines_no_cost + ' sale line(s) are parts with no cost on file, so they show no cost of sales.' });
      if (Math.abs(collections.paid_without_method) >= 1) {
        notes.push({ level: 'check', text: 'J$' + collections.paid_without_method.toLocaleString('en-JM', { minimumFractionDigits: 2 }) + ' is marked paid on sales but has no payment record saying how (cash, card, cheque…).' });
      }
      if (sales.returns.count && !collections.refunds_by_method.length) {
        notes.push({ level: 'check', text: sales.returns.count + ' credit note(s) have no refund record: it is not recorded whether money was paid back or kept as store credit.' });
      }
      if (Math.abs(salesVsInventory.difference) >= 1) notes.push({ level: 'check', text: 'Sale lines and sale totals differ by J$' + salesVsInventory.difference + '.' });
      if (Math.abs(collections.difference) >= 1) notes.push({ level: 'check', text: 'Sales billed and (paid + owed) differ by J$' + collections.difference + '.' });
      if (inventory.negative_parts) notes.push({ level: 'check', text: inventory.negative_parts + ' part(s) end the period below zero stock.' });
      if (sales.voided.count) notes.push({ level: 'info', text: sales.voided.count + ' voided sale(s) (J$' + sales.voided.total + ') are left out.' });

      res.json({ period: { from, to, by, ledger_started: ledgerFrom, ledger_covers_period: ledgerCoversPeriod }, inventory, sales, sales_vs_inventory: salesVsInventory, collections, earnings, notes });
    } catch (e) {
      console.error('[rep]', e);
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = { register };
