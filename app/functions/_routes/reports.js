// Phase 15 — analytics + the reports suite. Ports server.js:
//   GET /api/admin/analytics
//   GET /api/admin/reports/{x,z,drawer-sessions,sales,products,returns,tax,
//       orders,workorders,purchasing,inventory,labour,customers}
import { d1 } from '../_lib/db.js';
import { adminMw, capMw } from '../_lib/guards.js';

// 'reports.view' is in the permissions UI as "View reports"; until now nothing
// checked it, so an owner could switch it off for a cashier and the cashier
// could still pull margin, valuation and customer reports.
const reportsMw = capMw('reports.view');

function range(c) {
  const today = new Date().toISOString().slice(0, 10);
  const from = String(c.req.query('from') || today).slice(0, 10);
  const to = String(c.req.query('to') || from).slice(0, 10);
  return { from, to };
}

// ---------------------------------------------------------------------------
//  Shared helpers for the reports ported from server.js (Phase 16)
// ---------------------------------------------------------------------------
// Dialect differences that matter, all of them bugs if missed:
//   money            *_cents integers here, NUMERIC *_usd on Postgres
//   booleans         0/1, not true/false
//   returns tables   pos_returns / pos_return_items (refund_cents),
//                    not pos_sale_returns / pos_sale_return_items
//   day arithmetic   julianday(), not CURRENT_DATE - date
//   month buckets    strftime('%Y-%m', x), not to_char
//   conditional count SUM(CASE WHEN … THEN 1 ELSE 0 END), SQLite has no FILTER
//   greatest/least   MAX()/MIN() take multiple scalars in SQLite
//   warehouse_activity has NO meta_json column here, so a receival's own unit
//                    cost is unavailable -- these reports fall back to the
//                    product's cost price and say so.
const dayCount = (from, to) =>
  Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1);

function priorPeriod(from, to) {
  const days = dayCount(from, to);
  const end = new Date(Date.parse(from) - 86400000);
  const start = new Date(end.getTime() - (days - 1) * 86400000);
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}
function yearAgo(from, to) {
  const shift = (d) => { const x = new Date(Date.parse(d)); x.setFullYear(x.getFullYear() - 1); return x.toISOString().slice(0, 10); };
  return { from: shift(from), to: shift(to) };
}
const delta = (now, was) => {
  const d = Math.round((now - was) * 100) / 100;
  return { change: d, pct: was ? Math.round((d / Math.abs(was)) * 1000) / 10 : null };
};
const rnd = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Identical scoring to server.js's scoreItems(), so a part cannot be called
// overstocked on the hosted site and healthy in the shop.
function scoreItems(rows, days, defaultLead) {
  const span = Math.max(1, days);
  const ranked = rows.slice().sort((a, b) => (b.revenue || 0) - (a.revenue || 0));
  const totalRev = ranked.reduce((a, r) => a + (r.revenue || 0), 0);
  let cum = 0;
  for (const r of ranked) {
    cum += r.revenue || 0;
    const share = totalRev > 0 ? cum / totalRev : 1;
    r.abc = r.revenue > 0 ? (share <= 0.8 ? 'A' : share <= 0.95 ? 'B' : 'C') : '-';
  }
  const today = new Date();
  for (const r of rows) {
    const lead = Number(r.lead_time_days) > 0 ? Number(r.lead_time_days) : defaultLead;
    const rate = (r.sold || 0) / span;
    r.rate = Math.round(rate * 1000) / 1000;
    r.lead_demand = Math.ceil(rate * lead);
    r.safety = Math.ceil(rate * lead * 0.5);
    r.reorder_at = r.lead_demand + r.safety;
    r.cover_days = rate > 0 ? Math.round((r.stock / rate) * 10) / 10 : null;
    r.order_qty = rate > 0 ? Math.max(0, Math.ceil(rate * 90 + r.safety - r.stock)) : 0;
    r.order_cost = rnd(r.order_qty * Number(r.cost_usd || 0));
    if (rate > 0) {
      const slack = Math.max(0, Math.floor((r.stock / rate) - lead));
      r.order_by = new Date(today.getTime() + slack * 86400000).toISOString().slice(0, 10);
      r.order_now = slack <= 0;
    } else { r.order_by = null; r.order_now = false; }
    const a = r.sold_first || 0, b = r.sold_second || 0;
    r.trend = (a + b) === 0 ? 'no sales' : b > a * 1.25 ? 'rising' : b < a * 0.75 ? 'falling' : 'steady';
    r.margin = rnd((r.revenue || 0) - (r.cogs || 0));
    r.margin_pct = r.revenue > 0 ? Math.round((r.margin / r.revenue) * 1000) / 10 : null;
    r.flag = (r.sold || 0) === 0 && r.stock > 0 ? 'dead — no sales, cash on the shelf'
      : r.stock <= 0 && rate > 0 ? 'stocked out while still selling'
      : r.order_now ? 'below reorder point — order now'
      : r.cover_days != null && r.cover_days > 365 ? 'over a year of stock'
      : r.cover_days != null && r.cover_days > 180 ? 'overstocked — 6 months+'
      : r.margin_pct != null && r.margin_pct < 10 && r.revenue > 0 ? 'thin margin'
      : r.trend === 'rising' ? 'demand rising — review quantity'
      : 'healthy';
  }
  return rows;
}

// Per-part sales and receipts over a range. Pre-aggregated CTEs joined once --
// the correlated-subquery shape this replaced measured 4.5s on Postgres, and D1
// bills by rows read, so it would be worse here.
const ITEM_ANALYSIS_SQL = (extraWhere) => `
  WITH sales AS (
    SELECT i.product_img,
           SUM(i.qty) AS sold,
           SUM(i.total_cents)/100.0 AS revenue,
           SUM(CASE WHEN date(ps.created_at) <= date(?, '+' || (CAST(julianday(?) - julianday(?) AS INTEGER)/2) || ' days') THEN i.qty ELSE 0 END) AS sold_first,
           SUM(CASE WHEN date(ps.created_at) >  date(?, '+' || (CAST(julianday(?) - julianday(?) AS INTEGER)/2) || ' days') THEN i.qty ELSE 0 END) AS sold_second
      FROM pos_sale_items i JOIN pos_sales ps ON ps.id = i.sale_id
     WHERE ps.voided = 0 AND date(ps.created_at) BETWEEN ? AND ?
     GROUP BY i.product_img),
  ever_sold AS (
    SELECT i.product_img, MAX(date(ps.created_at)) AS last_sold
      FROM pos_sale_items i JOIN pos_sales ps ON ps.id = i.sale_id
     WHERE ps.voided = 0 GROUP BY i.product_img),
  recv AS (
    SELECT product_img, SUM(qty_delta) AS received FROM warehouse_activity
     WHERE kind = 'receive' AND date(created_at) BETWEEN ? AND ? GROUP BY product_img),
  ever_recv AS (
    SELECT product_img, MAX(date(created_at)) AS last_received FROM warehouse_activity
     WHERE kind = 'receive' GROUP BY product_img)
  SELECT pr.img, pr.sku, pr.name, COALESCE(pr.category,'-') AS category,
         COALESCE(NULLIF(pr.bin_location,''),'(unbinned)') AS bin,
         pr.stock_count AS stock, COALESCE(pr.cost_cents,0)/100.0 AS cost_usd,
         pr.price_cents/100.0 AS price_usd,
         COALESCE(s.name,'-') AS supplier, s.lead_time_days,
         COALESCE(sa.sold,0) AS sold, COALESCE(sa.revenue,0) AS revenue,
         (COALESCE(sa.sold,0) * COALESCE(pr.cost_cents,0))/100.0 AS cogs,
         COALESCE(sa.sold_first,0) AS sold_first, COALESCE(sa.sold_second,0) AS sold_second,
         COALESCE(rc.received,0) AS received,
         er.last_received AS last_received, es.last_sold AS last_sold
    FROM products pr
    LEFT JOIN suppliers s  ON s.id = pr.supplier_id
    LEFT JOIN sales sa     ON sa.product_img = pr.img
    LEFT JOIN ever_sold es ON es.product_img = pr.img
    LEFT JOIN recv rc      ON rc.product_img = pr.img
    LEFT JOIN ever_recv er ON er.product_img = pr.img
   WHERE ${extraWhere}`;
// The ten binds ITEM_ANALYSIS_SQL needs, in order, before any of extraWhere's
// own: two midpoint expressions of three each, then the sales range, then the
// receipts range.
const itemBinds = (from, to) => [from, to, from, from, to, from, from, to, from, to];

const PERIOD_SQL = `
  SELECT COUNT(*) AS tickets,
         COALESCE(SUM(s.total_cents),0)/100.0 AS revenue,
         COALESCE(SUM(s.subtotal_cents),0)/100.0 AS subtotal,
         COALESCE(SUM(s.tax_cents),0)/100.0 AS tax,
         COALESCE(SUM(s.discount_cents),0)/100.0 AS discount,
         COALESCE((SELECT SUM(i.qty) FROM pos_sale_items i JOIN pos_sales p2 ON p2.id = i.sale_id
                    WHERE p2.voided = 0 AND date(p2.created_at) BETWEEN ? AND ?),0) AS units,
         COALESCE((SELECT SUM(i.qty * COALESCE(pr.cost_cents,0))/100.0 FROM pos_sale_items i
                    JOIN pos_sales p3 ON p3.id = i.sale_id LEFT JOIN products pr ON pr.img = i.product_img
                   WHERE p3.voided = 0 AND date(p3.created_at) BETWEEN ? AND ?),0) AS cogs
    FROM pos_sales s
   WHERE s.voided = 0 AND date(s.created_at) BETWEEN ? AND ?`;
const periodBinds = (from, to) => [from, to, from, to, from, to];
function finishPeriod(p) {
  p.gross_profit = rnd(p.revenue - p.tax - p.cogs);
  p.margin_pct = (p.revenue - p.tax) > 0 ? Math.round((p.gross_profit / (p.revenue - p.tax)) * 1000) / 10 : null;
  p.avg_ticket = p.tickets > 0 ? rnd(p.revenue / p.tickets) : 0;
  return p;
}

// Receivables: netted per customer, floored at zero. One customer's credit
// cannot cancel another's debt. Must match server.js or the two runtimes report
// different positions for the same ledger.
const NET_OWED_SQL = `
  SELECT COALESCE(SUM(MAX(bal, 0)),0) AS owed FROM (
    SELECT COALESCE((SELECT SUM(sp.amount_cents)/100.0 FROM sale_payments sp
                      JOIN pos_sales s ON s.id = sp.sale_id
                     WHERE sp.method = 'account' AND s.customer_id = u.id AND s.voided = 0),0)
         - COALESCE((SELECT SUM(amount_cents)/100.0 FROM account_payments ap WHERE ap.customer_id = u.id),0) AS bal
      FROM users u WHERE COALESCE(u.is_staff,0) = 0 AND COALESCE(u.is_admin,0) = 0) t`;

const RANK_DIMS = {
  overall:  { sql: "'All sales'", label: 'Overall' },
  customer: { sql: "COALESCE(NULLIF(ps.customer_name,''),'Walk-in')", label: 'Customer' },
  supplier: { sql: "COALESCE(s.name,'(no supplier)')", label: 'Supplier' },
  rep:      { sql: "COALESCE(NULLIF(ps.sales_rep_name,''), NULLIF(ps.cashier_name,''),'(no rep)')", label: 'Sales rep' },
  bin:      { sql: "COALESCE(NULLIF(pr.bin_location,''),'(unbinned)')", label: 'Bin' },
  location: { sql: "COALESCE(NULLIF(pr.location,''),'(no location)')", label: 'Location' },
};

async function loadSessionRow(db, where, params) {
  return db.one(
    `SELECT s.*, s.opening_float_cents / 100.0 AS opening_float, s.closing_amount_cents / 100.0 AS closing_amount,
            o.name AS opener_name, c.name AS closer_name
       FROM cash_drawer_sessions s
       LEFT JOIN mechanics o ON o.id = s.opened_by
       LEFT JOIN mechanics c ON c.id = s.closed_by
      ${where}`, ...params);
}

async function buildTillReport(db, session) {
  const from = session.opened_at;
  const to = session.closed_at || new Date().toISOString().replace('T', ' ').slice(0, 19);
  const p = [from, to];
  const [sales, voids, tenders, refunds, units, grand, hourly, byCashier] = await Promise.all([
    db.one(`SELECT COUNT(*) AS n, COALESCE(SUM(subtotal_cents),0)/100.0 AS subtotal, COALESCE(SUM(discount_cents),0)/100.0 AS discount,
                   COALESCE(SUM(tax_cents),0)/100.0 AS tax, COALESCE(SUM(total_cents),0)/100.0 AS total
              FROM pos_sales WHERE voided = 0 AND created_at BETWEEN ? AND ?`, ...p),
    db.one(`SELECT COUNT(*) AS n, COALESCE(SUM(total_cents),0)/100.0 AS total FROM pos_sales WHERE voided = 1 AND created_at BETWEEN ? AND ?`, ...p),
    db.many(`SELECT sp.method, COUNT(*) AS n, COALESCE(SUM(sp.amount_cents),0)/100.0 AS total
               FROM sale_payments sp JOIN pos_sales ps ON ps.id = sp.sale_id
              WHERE ps.voided = 0 AND sp.created_at BETWEEN ? AND ? GROUP BY sp.method ORDER BY total DESC`, ...p),
    db.many(`SELECT refund_method AS method, COUNT(*) AS n, COALESCE(SUM(refund_cents),0)/100.0 AS total
               FROM pos_returns WHERE created_at BETWEEN ? AND ? GROUP BY refund_method ORDER BY total DESC`, ...p),
    db.one(`SELECT COALESCE(SUM(i.qty),0) AS units FROM pos_sale_items i JOIN pos_sales ps ON ps.id = i.sale_id
             WHERE ps.voided = 0 AND ps.created_at BETWEEN ? AND ?`, ...p),
    db.one(`SELECT COALESCE(SUM(total_cents),0)/100.0 AS total, COUNT(*) AS n FROM pos_sales WHERE voided = 0 AND created_at <= ?`, to),
    db.many(`SELECT CAST(strftime('%H', created_at) AS INTEGER) AS hour, COUNT(*) AS n, COALESCE(SUM(total_cents),0)/100.0 AS total
               FROM pos_sales WHERE voided = 0 AND created_at BETWEEN ? AND ? GROUP BY hour ORDER BY hour ASC`, ...p),
    db.many(`SELECT COALESCE(cashier_name,'-') AS cashier, COUNT(*) AS n, COALESCE(SUM(total_cents),0)/100.0 AS total
               FROM pos_sales WHERE voided = 0 AND created_at BETWEEN ? AND ? GROUP BY cashier_name ORDER BY total DESC`, ...p),
  ]);
  const s = sales;
  const cashIn = Number((tenders.find((r) => r.method === 'cash') || {}).total || 0);
  const cashOut = Number((refunds.find((r) => r.method === 'cash') || {}).total || 0);
  const openingFloat = Number(session.opening_float || 0);
  const expectedCash = openingFloat + cashIn - cashOut;
  const counted = session.closing_amount == null ? null : Number(session.closing_amount);
  const refundTotal = refunds.reduce((a, r) => a + Number(r.total), 0);
  return {
    session: {
      id: session.id, opened_at: session.opened_at, closed_at: session.closed_at,
      opener_name: session.opener_name || null, closer_name: session.closer_name || null,
      opening_float: openingFloat, notes: session.notes || null,
    },
    window: { from, to },
    sales: { count: s.n, subtotal: s.subtotal, discount: s.discount, tax: s.tax, total: s.total, units: units.units, avg_ticket: s.n ? s.total / s.n : 0 },
    voids, tenders, refunds, refund_total: refundTotal, net_total: Number(s.total) - refundTotal,
    cash: { opening_float: openingFloat, cash_sales: cashIn, cash_refunds: cashOut, expected: expectedCash, counted, variance: counted == null ? null : counted - expectedCash },
    by_cashier: byCashier, hourly, grand_total: grand,
  };
}

export default function mount(app) {
  app.get('/api/admin/analytics', adminMw, async (c) => {
    const db = d1(c.env);
    const [rev7, rev30, ord7, ord30, newU7, topCats, topProds, slots, subs] = await Promise.all([
      db.one("SELECT COALESCE(SUM(total_cents),0)/100.0 AS s FROM orders WHERE created_at > datetime('now','-7 days')"),
      db.one("SELECT COALESCE(SUM(total_cents),0)/100.0 AS s FROM orders WHERE created_at > datetime('now','-30 days')"),
      db.one("SELECT COUNT(*) AS n FROM orders WHERE created_at > datetime('now','-7 days')"),
      db.one("SELECT COUNT(*) AS n FROM orders WHERE created_at > datetime('now','-30 days')"),
      db.one("SELECT COUNT(*) AS n FROM users WHERE created_at > datetime('now','-7 days')"),
      db.many("SELECT p.category, COUNT(*) AS n FROM order_items oi JOIN products p ON p.img = oi.product_img GROUP BY p.category ORDER BY n DESC LIMIT 5"),
      db.many("SELECT oi.product_img AS img, p.name, SUM(oi.qty) AS units FROM order_items oi LEFT JOIN products p ON p.img = oi.product_img GROUP BY oi.product_img, p.name ORDER BY units DESC LIMIT 5"),
      db.many("SELECT time_slot, COUNT(*) AS n FROM service_appointments WHERE time_slot IS NOT NULL GROUP BY time_slot ORDER BY n DESC LIMIT 5"),
      db.one("SELECT COUNT(*) AS n FROM newsletter_subscribers"),
    ]);
    return c.json({
      revenue_7d: rev7.s || 0, revenue_30d: rev30.s || 0, orders_7d: ord7.n, orders_30d: ord30.n,
      new_users_7d: newU7.n, newsletter_subs: subs.n,
      top_categories: topCats, top_products: topProds, busy_slots: slots,
    });
  });

  app.get('/api/admin/reports/drawer-sessions', adminMw, async (c) => {
    const { from, to } = range(c);
    const sessions = await d1(c.env).many(
      `SELECT s.id, s.opened_at, s.closed_at, s.opening_float_cents/100.0 AS opening_float,
              s.closing_amount_cents/100.0 AS closing_amount, s.expected_cash_cents/100.0 AS expected_cash,
              s.variance_cents/100.0 AS variance, o.name AS opener_name, c.name AS closer_name
         FROM cash_drawer_sessions s
         LEFT JOIN mechanics o ON o.id = s.opened_by LEFT JOIN mechanics c ON c.id = s.closed_by
        WHERE date(s.opened_at) BETWEEN ? AND ? ORDER BY s.opened_at DESC`, from, to);
    return c.json({ from, to, sessions });
  });

  app.get('/api/admin/reports/z', adminMw, async (c) => {
    const db = d1(c.env);
    const id = c.req.query('session_id');
    const session = id
      ? await loadSessionRow(db, 'WHERE s.id = ?', [id])
      : await loadSessionRow(db, 'WHERE s.closed_at IS NOT NULL ORDER BY s.closed_at DESC LIMIT 1', []);
    if (!session) return c.json({ error: 'No closed drawer session found to report on.' }, 404);
    return c.json({ kind: 'Z', final: !!session.closed_at, ...(await buildTillReport(db, session)) });
  });
  app.get('/api/admin/reports/x', adminMw, async (c) => {
    const db = d1(c.env);
    const session = await loadSessionRow(db, 'WHERE s.closed_at IS NULL ORDER BY s.opened_at DESC LIMIT 1', []);
    if (!session) return c.json({ error: 'No cash drawer session is currently open.' }, 404);
    return c.json({ kind: 'X', final: false, ...(await buildTillReport(db, session)) });
  });

  app.get('/api/admin/reports/sales', adminMw, async (c) => {
    const db = d1(c.env);
    const { from, to } = range(c);
    const p = [from, to];
    const [totals, byDay, byCashier, byTender, byHour, voids, refunds, units] = await Promise.all([
      db.one(`SELECT COUNT(*) AS n, COALESCE(SUM(subtotal_cents),0)/100.0 AS subtotal, COALESCE(SUM(discount_cents),0)/100.0 AS discount,
                     COALESCE(SUM(tax_cents),0)/100.0 AS tax, COALESCE(SUM(total_cents),0)/100.0 AS total
                FROM pos_sales WHERE voided = 0 AND date(created_at) BETWEEN ? AND ?`, ...p),
      db.many(`SELECT date(created_at) AS day, COUNT(*) AS n, COALESCE(SUM(discount_cents),0)/100.0 AS discount,
                      COALESCE(SUM(tax_cents),0)/100.0 AS tax, COALESCE(SUM(total_cents),0)/100.0 AS total
                 FROM pos_sales WHERE voided = 0 AND date(created_at) BETWEEN ? AND ? GROUP BY day ORDER BY day DESC`, ...p),
      db.many(`SELECT COALESCE(cashier_name,'-') AS cashier, COUNT(*) AS n, COALESCE(SUM(total_cents),0)/100.0 AS total
                 FROM pos_sales WHERE voided = 0 AND date(created_at) BETWEEN ? AND ? GROUP BY cashier_name ORDER BY total DESC`, ...p),
      db.many(`SELECT sp.method, COUNT(*) AS n, COALESCE(SUM(sp.amount_cents),0)/100.0 AS total
                 FROM sale_payments sp JOIN pos_sales ps ON ps.id = sp.sale_id
                WHERE ps.voided = 0 AND date(sp.created_at) BETWEEN ? AND ? GROUP BY sp.method ORDER BY total DESC`, ...p),
      db.many(`SELECT CAST(strftime('%H', created_at) AS INTEGER) AS hour, COUNT(*) AS n, COALESCE(SUM(total_cents),0)/100.0 AS total
                 FROM pos_sales WHERE voided = 0 AND date(created_at) BETWEEN ? AND ? GROUP BY hour ORDER BY hour ASC`, ...p),
      db.one(`SELECT COUNT(*) AS n, COALESCE(SUM(total_cents),0)/100.0 AS total FROM pos_sales WHERE voided = 1 AND date(created_at) BETWEEN ? AND ?`, ...p),
      db.one(`SELECT COUNT(*) AS n, COALESCE(SUM(refund_cents),0)/100.0 AS total FROM pos_returns WHERE date(created_at) BETWEEN ? AND ?`, ...p),
      db.one(`SELECT COALESCE(SUM(i.qty),0) AS units FROM pos_sale_items i JOIN pos_sales ps ON ps.id = i.sale_id
               WHERE ps.voided = 0 AND date(ps.created_at) BETWEEN ? AND ?`, ...p),
    ]);
    return c.json({
      from, to,
      totals: { ...totals, units: units.units, avg_ticket: totals.n ? totals.total / totals.n : 0, net_total: totals.total - refunds.total },
      by_day: byDay, by_cashier: byCashier, by_tender: byTender, by_hour: byHour, voids, refunds,
    });
  });

  app.get('/api/admin/reports/products', adminMw, async (c) => {
    const db = d1(c.env);
    const { from, to } = range(c);
    const p = [from, to];
    const [top, byCategory, slow] = await Promise.all([
      db.many(`SELECT i.description AS name, i.product_img, COALESCE(SUM(i.qty),0) AS units, COALESCE(SUM(i.total_cents),0)/100.0 AS revenue
                 FROM pos_sale_items i JOIN pos_sales ps ON ps.id = i.sale_id
                WHERE ps.voided = 0 AND date(ps.created_at) BETWEEN ? AND ? GROUP BY i.description, i.product_img ORDER BY revenue DESC LIMIT 50`, ...p),
      db.many(`SELECT COALESCE(pr.category,'-') AS category, COALESCE(SUM(i.qty),0) AS units, COALESCE(SUM(i.total_cents),0)/100.0 AS revenue
                 FROM pos_sale_items i JOIN pos_sales ps ON ps.id = i.sale_id LEFT JOIN products pr ON pr.img = i.product_img
                WHERE ps.voided = 0 AND date(ps.created_at) BETWEEN ? AND ? GROUP BY pr.category ORDER BY revenue DESC`, ...p),
      db.many(`SELECT pr.img, pr.name, pr.category, pr.stock_count, pr.price_cents/100.0 AS price_usd
                 FROM products pr WHERE pr.is_active = 1 AND pr.stock_count > 0
                   AND NOT EXISTS (SELECT 1 FROM pos_sale_items i JOIN pos_sales ps ON ps.id = i.sale_id
                                    WHERE i.product_img = pr.img AND ps.voided = 0 AND date(ps.created_at) BETWEEN ? AND ?)
                ORDER BY pr.stock_count DESC LIMIT 50`, ...p),
    ]);
    return c.json({ from, to, top_products: top, by_category: byCategory, no_movement: slow });
  });

  app.get('/api/admin/reports/returns', adminMw, async (c) => {
    const db = d1(c.env);
    const { from, to } = range(c);
    const p = [from, to];
    const [totals, byMethod, byReason, recent] = await Promise.all([
      db.one(`SELECT COUNT(*) AS n, COALESCE(SUM(refund_cents),0)/100.0 AS total, COALESCE(SUM(refund_tax_cents),0)/100.0 AS tax
                FROM pos_returns WHERE date(created_at) BETWEEN ? AND ?`, ...p),
      db.many(`SELECT refund_method AS method, COUNT(*) AS n, COALESCE(SUM(refund_cents),0)/100.0 AS total
                 FROM pos_returns WHERE date(created_at) BETWEEN ? AND ? GROUP BY refund_method ORDER BY total DESC`, ...p),
      db.many(`SELECT COALESCE(NULLIF(reason,''),'-') AS reason, COUNT(*) AS n, COALESCE(SUM(refund_cents),0)/100.0 AS total
                 FROM pos_returns WHERE date(created_at) BETWEEN ? AND ? GROUP BY reason ORDER BY total DESC LIMIT 25`, ...p),
      db.many(`SELECT r.return_number, r.created_at, r.refund_method, r.refund_cents/100.0 AS refund_total_usd, r.reason,
                      ps.receipt_number, ps.customer_name
                 FROM pos_returns r LEFT JOIN pos_sales ps ON ps.id = r.sale_id
                WHERE date(r.created_at) BETWEEN ? AND ? ORDER BY r.created_at DESC LIMIT 100`, ...p),
    ]);
    return c.json({ from, to, totals, by_method: byMethod, by_reason: byReason, recent });
  });

  app.get('/api/admin/reports/tax', adminMw, async (c) => {
    const db = d1(c.env);
    const { from, to } = range(c);
    const p = [from, to];
    const [pos, wo, refunded, byDay] = await Promise.all([
      db.one(`SELECT COUNT(*) AS n, COALESCE(SUM(tax_cents),0)/100.0 AS tax, COALESCE(SUM(subtotal_cents - discount_cents),0)/100.0 AS taxable
                FROM pos_sales WHERE voided = 0 AND date(created_at) BETWEEN ? AND ?`, ...p),
      db.one(`SELECT COUNT(*) AS n, COALESCE(SUM(tax_cents),0)/100.0 AS tax FROM work_orders WHERE status = 'paid' AND date(paid_at) BETWEEN ? AND ?`, ...p),
      db.one(`SELECT COALESCE(SUM(refund_tax_cents),0)/100.0 AS tax FROM pos_returns WHERE date(created_at) BETWEEN ? AND ?`, ...p),
      db.many(`SELECT date(created_at) AS day, COALESCE(SUM(tax_cents),0)/100.0 AS tax FROM pos_sales
                WHERE voided = 0 AND date(created_at) BETWEEN ? AND ? GROUP BY day ORDER BY day DESC`, ...p),
    ]);
    return c.json({ from, to, pos, work_orders: wo, refunded_tax: refunded.tax, net_tax: pos.tax + wo.tax - refunded.tax, by_day: byDay });
  });

  app.get('/api/admin/reports/orders', adminMw, async (c) => {
    const db = d1(c.env);
    const { from, to } = range(c);
    const p = [from, to];
    const [totals, bySource, byStatus, byPayment, byDay, top] = await Promise.all([
      db.one(`SELECT COUNT(*) AS n, COALESCE(SUM(total_cents),0)/100.0 AS total FROM orders WHERE date(created_at) BETWEEN ? AND ?`, ...p),
      db.many(`SELECT COALESCE(NULLIF(source,''),'storefront') AS source, COUNT(*) AS n,
                      SUM(CASE WHEN status IN ('pending','invoicing') THEN 1 ELSE 0 END) AS open,
                      COALESCE(SUM(total_cents),0)/100.0 AS total
                 FROM orders WHERE date(created_at) BETWEEN ? AND ? GROUP BY source ORDER BY total DESC`, ...p),
      db.many(`SELECT status, COUNT(*) AS n, COALESCE(SUM(total_cents),0)/100.0 AS total FROM orders WHERE date(created_at) BETWEEN ? AND ? GROUP BY status ORDER BY total DESC`, ...p),
      db.many(`SELECT payment_method, payment_status, COUNT(*) AS n, COALESCE(SUM(total_cents),0)/100.0 AS total
                 FROM orders WHERE date(created_at) BETWEEN ? AND ? GROUP BY payment_method, payment_status ORDER BY total DESC`, ...p),
      db.many(`SELECT date(created_at) AS day, COUNT(*) AS n, COALESCE(SUM(total_cents),0)/100.0 AS total FROM orders WHERE date(created_at) BETWEEN ? AND ? GROUP BY day ORDER BY day DESC`, ...p),
      db.many(`SELECT COALESCE(pr.name, oi.product_img) AS name, COALESCE(SUM(oi.qty),0) AS units, COALESCE(SUM(oi.qty * oi.price_cents),0)/100.0 AS revenue
                 FROM order_items oi JOIN orders o ON o.id = oi.order_id LEFT JOIN products pr ON pr.img = oi.product_img
                WHERE date(o.created_at) BETWEEN ? AND ? GROUP BY COALESCE(pr.name, oi.product_img) ORDER BY revenue DESC LIMIT 25`, ...p),
    ]);
    return c.json({ from, to, totals: { ...totals, avg_order: totals.n ? totals.total / totals.n : 0 }, by_source: bySource, by_status: byStatus, by_payment: byPayment, by_day: byDay, top_products: top });
  });

  app.get('/api/admin/reports/workorders', adminMw, async (c) => {
    const db = d1(c.env);
    const { from, to } = range(c);
    const p = [from, to];
    const [totals, byStatus, payments, byMechanic, parts] = await Promise.all([
      db.one(`SELECT COUNT(*) AS n, COALESCE(SUM(labor_total_cents),0)/100.0 AS labour, COALESCE(SUM(parts_total_cents),0)/100.0 AS parts,
                     COALESCE(SUM(tax_cents),0)/100.0 AS tax, COALESCE(SUM(total_cents),0)/100.0 AS total
                FROM work_orders WHERE date(intake_date) BETWEEN ? AND ?`, ...p),
      db.many(`SELECT status, COUNT(*) AS n, COALESCE(SUM(total_cents),0)/100.0 AS total FROM work_orders WHERE date(intake_date) BETWEEN ? AND ? GROUP BY status ORDER BY n DESC`, ...p),
      db.many(`SELECT method, COUNT(*) AS n, COALESCE(SUM(amount_cents),0)/100.0 AS total FROM work_order_payments WHERE date(received_at) BETWEEN ? AND ? GROUP BY method ORDER BY total DESC`, ...p),
      db.many(`SELECT COALESCE(m.name,'-') AS mechanic, COUNT(l.id) AS jobs, COALESCE(SUM(l.hours),0) AS hours, COALESCE(SUM(l.total_cents),0)/100.0 AS revenue
                 FROM work_order_labor l LEFT JOIN mechanics m ON m.id = l.mechanic_id WHERE date(l.created_at) BETWEEN ? AND ? GROUP BY m.name ORDER BY revenue DESC`, ...p),
      db.one(`SELECT COUNT(*) AS n, COALESCE(SUM(wp.total_cents),0)/100.0 AS total FROM work_order_parts wp JOIN work_orders w ON w.id = wp.work_order_id WHERE date(w.intake_date) BETWEEN ? AND ?`, ...p),
    ]);
    return c.json({ from, to, totals, by_status: byStatus, payments, by_mechanic: byMechanic, parts });
  });

  app.get('/api/admin/reports/purchasing', adminMw, async (c) => {
    const db = d1(c.env);
    const { from, to } = range(c);
    const p = [from, to];
    const [totals, byStatus, bySupplier, received] = await Promise.all([
      db.one(`SELECT COUNT(*) AS n, COALESCE(SUM(total_cents),0)/100.0 AS total FROM purchase_orders WHERE date(created_at) BETWEEN ? AND ?`, ...p),
      db.many(`SELECT status, COUNT(*) AS n, COALESCE(SUM(total_cents),0)/100.0 AS total FROM purchase_orders WHERE date(created_at) BETWEEN ? AND ? GROUP BY status ORDER BY total DESC`, ...p),
      db.many(`SELECT COALESCE(s.name,'-') AS supplier, COUNT(*) AS n, COALESCE(SUM(po.total_cents),0)/100.0 AS total
                 FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id WHERE date(po.created_at) BETWEEN ? AND ? GROUP BY s.name ORDER BY total DESC`, ...p),
      db.one(`SELECT COUNT(*) AS n, COALESCE(SUM(total_cents),0)/100.0 AS total FROM purchase_orders WHERE received_date IS NOT NULL AND date(received_date) BETWEEN ? AND ?`, ...p),
    ]);
    return c.json({ from, to, totals, by_status: byStatus, by_supplier: bySupplier, received });
  });

  app.get('/api/admin/reports/inventory', adminMw, async (c) => {
    const db = d1(c.env);
    const [valuation, byCategory, low, out] = await Promise.all([
      db.one(`SELECT COUNT(*) AS lines, COALESCE(SUM(stock_count),0) AS units,
                     COALESCE(SUM(stock_count * price_cents),0)/100.0 AS retail_value,
                     COALESCE(SUM(stock_count * COALESCE(cost_cents,0)),0)/100.0 AS cost_value
                FROM products WHERE is_active = 1`),
      db.many(`SELECT COALESCE(category,'-') AS category, COUNT(*) AS lines, COALESCE(SUM(stock_count),0) AS units,
                      COALESCE(SUM(stock_count * price_cents),0)/100.0 AS retail_value
                 FROM products WHERE is_active = 1 GROUP BY category ORDER BY retail_value DESC`),
      db.many(`SELECT img, name, category, stock_count, low_threshold, price_cents/100.0 AS price_usd
                 FROM products WHERE is_active = 1 AND item_type != 'service' AND is_kit = 0 AND stock_count <= low_threshold ORDER BY stock_count ASC LIMIT 100`),
      db.one(`SELECT COUNT(*) AS n FROM products WHERE is_active = 1 AND item_type != 'service' AND is_kit = 0 AND stock_count <= 0`),
    ]);
    return c.json({
      valuation: { ...valuation, margin_value: valuation.retail_value - valuation.cost_value },
      by_category: byCategory, low_stock: low, out_of_stock: out.n,
    });
  });

  app.get('/api/admin/reports/labour', adminMw, async (c) => {
    const db = d1(c.env);
    const { from, to } = range(c);
    const p = [from, to];
    const [byMechanic, byDay, totals] = await Promise.all([
      db.many(`SELECT COALESCE(m.name,'-') AS mechanic, COUNT(*) AS entries, COALESCE(SUM(t.hours),0) AS hours
                 FROM time_entries t LEFT JOIN mechanics m ON m.id = t.mechanic_id WHERE date(t.clocked_in_at) BETWEEN ? AND ? GROUP BY m.name ORDER BY hours DESC`, ...p),
      db.many(`SELECT date(clocked_in_at) AS day, COALESCE(SUM(hours),0) AS hours FROM time_entries WHERE date(clocked_in_at) BETWEEN ? AND ? GROUP BY day ORDER BY day DESC`, ...p),
      db.one(`SELECT COUNT(*) AS entries, COALESCE(SUM(hours),0) AS hours FROM time_entries WHERE date(clocked_in_at) BETWEEN ? AND ?`, ...p),
    ]);
    return c.json({ from, to, totals, by_mechanic: byMechanic, by_day: byDay });
  });

  app.get('/api/admin/reports/customers', adminMw, async (c) => {
    const db = d1(c.env);
    const { from, to } = range(c);
    const p = [from, to];
    const [newUsers, topPos, loyalty, newsletter] = await Promise.all([
      db.one(`SELECT COUNT(*) AS n FROM users WHERE date(created_at) BETWEEN ? AND ?`, ...p),
      db.many(`SELECT COALESCE(customer_name,'Walk-in') AS customer, COUNT(*) AS visits, COALESCE(SUM(total_cents),0)/100.0 AS spend
                 FROM pos_sales WHERE voided = 0 AND date(created_at) BETWEEN ? AND ? GROUP BY customer_name ORDER BY spend DESC LIMIT 25`, ...p),
      db.one(`SELECT COALESCE(SUM(CASE WHEN delta > 0 THEN delta ELSE 0 END),0) AS earned,
                     COALESCE(SUM(CASE WHEN delta < 0 THEN -delta ELSE 0 END),0) AS redeemed
                FROM points_transactions WHERE date(created_at) BETWEEN ? AND ?`, ...p),
      db.one(`SELECT COUNT(*) AS n FROM newsletter_subscribers WHERE date(subscribed_at) BETWEEN ? AND ?`, ...p),
    ]);
    return c.json({ from, to, new_customers: newUsers.n, top_customers: topPos, loyalty, newsletter_signups: newsletter.n });
  });

  // ---- POS orders / cashier (order-first checkout) -----------------------
  app.get('/api/admin/reports/pos-orders', adminMw, async (c) => {
    const db = d1(c.env);
    const { from, to } = range(c);
    const p = [from, to];
    const [pending, converted, cancelled, byTaker, aging, speed] = await Promise.all([
      db.one(`SELECT COUNT(*) AS n, COALESCE(SUM(total_cents),0)/100.0 AS total FROM orders WHERE source='pos' AND status='pending'`),
      db.one(`SELECT COUNT(*) AS n, COALESCE(SUM(total_cents),0)/100.0 AS total FROM orders WHERE source='pos' AND status='completed' AND date(created_at) BETWEEN ? AND ?`, ...p),
      db.one(`SELECT COUNT(*) AS n, COALESCE(SUM(total_cents),0)/100.0 AS total FROM orders WHERE source='pos' AND status='cancelled' AND date(created_at) BETWEEN ? AND ?`, ...p),
      db.many(`SELECT COALESCE(u.name,'-') AS operator,
                      SUM(CASE WHEN o.status='pending' THEN 1 ELSE 0 END) AS pending,
                      SUM(CASE WHEN o.status='completed' AND date(o.created_at) BETWEEN ? AND ? THEN 1 ELSE 0 END) AS invoiced,
                      COALESCE(SUM(CASE WHEN o.status IN ('pending','completed') THEN o.total_cents ELSE 0 END),0)/100.0 AS total
                 FROM orders o LEFT JOIN users u ON u.id = o.taken_by
                WHERE o.source='pos' GROUP BY u.name ORDER BY total DESC`, ...p),
      db.many(`SELECT CASE
                        WHEN julianday('now') - julianday(created_at) < 1 THEN 'under 1 day'
                        WHEN julianday('now') - julianday(created_at) < 3 THEN '1-3 days'
                        WHEN julianday('now') - julianday(created_at) < 7 THEN '3-7 days'
                        ELSE 'over 7 days' END AS bucket,
                      COUNT(*) AS n, COALESCE(SUM(total_cents),0)/100.0 AS total
                 FROM orders WHERE source='pos' AND status='pending' GROUP BY bucket ORDER BY MIN(created_at)`),
      db.one(`SELECT AVG((julianday(s.created_at) - julianday(o.created_at)) * 24) AS hours
                FROM orders o JOIN pos_sales s ON s.id = o.converted_sale_id
               WHERE o.source='pos' AND date(o.created_at) BETWEEN ? AND ?`, ...p),
    ]);
    return c.json({ from, to, pending, converted, cancelled, by_taker: byTaker, aging, avg_hours_to_invoice: speed && speed.hours != null ? Number(speed.hours) : null });
  });

  // ---- sales by rep ----------------------------------------------------
  app.get('/api/admin/reports/sales-reps', adminMw, async (c) => {
    const db = d1(c.env);
    const { from, to } = range(c);
    const p = [from, to];
    const rows = await db.many(
      `SELECT COALESCE(NULLIF(ps.sales_rep_name,''),'(no rep)') AS rep,
              COUNT(DISTINCT ps.id) AS tickets,
              COALESCE(SUM(i.qty),0) AS units,
              COALESCE(SUM(i.total_cents),0)/100.0 AS revenue,
              COALESCE(SUM(i.discount_cents),0)/100.0 AS discount,
              COALESCE(SUM(i.qty * COALESCE(pr.cost_cents,0)),0)/100.0 AS cost
         FROM pos_sales ps
         JOIN pos_sale_items i ON i.sale_id = ps.id
         LEFT JOIN products pr ON pr.img = i.product_img
        WHERE ps.voided = 0 AND date(ps.created_at) BETWEEN ? AND ?
        GROUP BY rep ORDER BY revenue DESC`, ...p);
    for (const r of rows) {
      r.margin = Math.round((r.revenue - r.cost) * 100) / 100;
      r.margin_pct = r.revenue > 0 ? Math.round((r.margin / r.revenue) * 1000) / 10 : null;
    }
    return c.json({ from, to, reps: rows });
  });

  // ---- gross margin (by product / category) --------------------------
  app.get('/api/admin/reports/margin', adminMw, async (c) => {
    const db = d1(c.env);
    const { from, to } = range(c);
    const p = [from, to];
    const marginRows = (rows) => {
      for (const r of rows) {
        r.gross = Math.round((r.revenue - r.cost) * 100) / 100;
        r.margin_pct = r.revenue > 0 ? Math.round((r.gross / r.revenue) * 1000) / 10 : null;
      }
      return rows;
    };
    const [byProduct, byCategory, totals] = await Promise.all([
      db.many(`SELECT i.description AS name, COALESCE(SUM(i.qty),0) AS units,
                      COALESCE(SUM(i.total_cents),0)/100.0 AS revenue,
                      COALESCE(SUM(i.qty * COALESCE(pr.cost_cents,0)),0)/100.0 AS cost
                 FROM pos_sale_items i JOIN pos_sales ps ON ps.id = i.sale_id
                 LEFT JOIN products pr ON pr.img = i.product_img
                WHERE ps.voided = 0 AND date(ps.created_at) BETWEEN ? AND ?
                GROUP BY i.description ORDER BY revenue DESC LIMIT 60`, ...p),
      db.many(`SELECT COALESCE(pr.category,'-') AS category, COALESCE(SUM(i.qty),0) AS units,
                      COALESCE(SUM(i.total_cents),0)/100.0 AS revenue,
                      COALESCE(SUM(i.qty * COALESCE(pr.cost_cents,0)),0)/100.0 AS cost
                 FROM pos_sale_items i JOIN pos_sales ps ON ps.id = i.sale_id
                 LEFT JOIN products pr ON pr.img = i.product_img
                WHERE ps.voided = 0 AND date(ps.created_at) BETWEEN ? AND ?
                GROUP BY pr.category ORDER BY revenue DESC`, ...p),
      db.one(`SELECT COALESCE(SUM(i.total_cents),0)/100.0 AS revenue,
                     COALESCE(SUM(i.qty * COALESCE(pr.cost_cents,0)),0)/100.0 AS cost
                FROM pos_sale_items i JOIN pos_sales ps ON ps.id = i.sale_id
                LEFT JOIN products pr ON pr.img = i.product_img
               WHERE ps.voided = 0 AND date(ps.created_at) BETWEEN ? AND ?`, ...p),
    ]);
    const gross = Math.round(((totals.revenue || 0) - (totals.cost || 0)) * 100) / 100;
    return c.json({
      from, to,
      totals: { revenue: totals.revenue || 0, cost: totals.cost || 0, gross,
                margin_pct: totals.revenue > 0 ? Math.round((gross / totals.revenue) * 1000) / 10 : null },
      by_product: marginRows(byProduct), by_category: marginRows(byCategory),
    });
  });

  // ---- stock valuation + dead stock ---------------------------------
  app.get('/api/admin/reports/valuation', adminMw, async (c) => {
    const db = d1(c.env);
    const { from, to } = range(c);
    const p = [from, to];
    const [totals, byCategory, byLocation, dead] = await Promise.all([
      db.one(`SELECT COUNT(*) AS lines, COALESCE(SUM(stock_count),0) AS units,
                     COALESCE(SUM(stock_count * price_cents),0)/100.0 AS retail_value,
                     COALESCE(SUM(stock_count * COALESCE(cost_cents,0)),0)/100.0 AS cost_value
                FROM products WHERE is_active = 1 AND stock_count > 0`),
      db.many(`SELECT COALESCE(category,'-') AS category, COUNT(*) AS lines, COALESCE(SUM(stock_count),0) AS units,
                      COALESCE(SUM(stock_count * COALESCE(cost_cents,0)),0)/100.0 AS cost_value,
                      COALESCE(SUM(stock_count * price_cents),0)/100.0 AS retail_value
                 FROM products WHERE is_active = 1 AND stock_count > 0 GROUP BY category ORDER BY cost_value DESC`),
      db.many(`SELECT COALESCE(NULLIF(location,''),'-') AS location, COUNT(*) AS lines, COALESCE(SUM(stock_count),0) AS units,
                      COALESCE(SUM(stock_count * COALESCE(cost_cents,0)),0)/100.0 AS cost_value
                 FROM products WHERE is_active = 1 AND stock_count > 0 GROUP BY location ORDER BY cost_value DESC`),
      db.many(`SELECT pr.sku, pr.name, pr.category, pr.location, pr.stock_count,
                      pr.stock_count * COALESCE(pr.cost_cents,0) / 100.0 AS tied_up_cost
                 FROM products pr
                WHERE pr.is_active = 1 AND pr.stock_count > 0
                  AND NOT EXISTS (SELECT 1 FROM pos_sale_items i JOIN pos_sales ps ON ps.id = i.sale_id
                                   WHERE i.product_img = pr.img AND ps.voided = 0 AND date(ps.created_at) BETWEEN ? AND ?)
                ORDER BY tied_up_cost DESC LIMIT 100`, ...p),
    ]);
    return c.json({
      from, to,
      totals: { ...totals, potential_gross: (totals.retail_value || 0) - (totals.cost_value || 0) },
      by_category: byCategory, by_location: byLocation, dead_stock: dead,
    });
  });

  // ---- suppliers -----------------------------------------------------
  app.get('/api/admin/reports/supplier', adminMw, async (c) => {
    const db = d1(c.env);
    const { from, to } = range(c);
    const p = [from, to];
    const [rows, totals] = await Promise.all([
      db.many(
        `SELECT s.id, s.name, s.contact_name, s.phone, s.is_active,
                (SELECT COUNT(*) FROM purchase_orders po WHERE po.supplier_id = s.id AND date(po.created_at) BETWEEN ? AND ?) AS pos,
                (SELECT COALESCE(SUM(po.total_cents),0)/100.0 FROM purchase_orders po WHERE po.supplier_id = s.id AND date(po.created_at) BETWEEN ? AND ?) AS po_value,
                (SELECT COALESCE(SUM(po.total_cents),0)/100.0 FROM purchase_orders po WHERE po.supplier_id = s.id AND po.received_date IS NOT NULL AND date(po.received_date) BETWEEN ? AND ?) AS received_value,
                (SELECT COUNT(*) FROM products pr WHERE pr.supplier_id = s.id) AS skus,
                (SELECT COALESCE(SUM(pr.stock_count * COALESCE(pr.cost_cents,0)),0)/100.0 FROM products pr WHERE pr.supplier_id = s.id AND pr.is_active = 1) AS stock_cost,
                (SELECT MAX(date(po.created_at)) FROM purchase_orders po WHERE po.supplier_id = s.id) AS last_po
           FROM suppliers s ORDER BY po_value DESC, s.name ASC`,
        ...p, ...p, ...p),
      db.one(
        `SELECT COUNT(*) AS suppliers,
                SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active
           FROM suppliers`),
    ]);
    const po_value = rows.reduce((a, r) => a + Number(r.po_value || 0), 0);
    const stock_cost = rows.reduce((a, r) => a + Number(r.stock_cost || 0), 0);
    return c.json({ from, to, suppliers: rows, totals: { ...totals, po_value, stock_cost } });
  });

  // ---- customer detail ---------------------------------------------
  app.get('/api/admin/reports/customer-detail', adminMw, async (c) => {
    const db = d1(c.env);
    const { from, to } = range(c);
    const p = [from, to];
    const [rows, tiles, byTier] = await Promise.all([
      db.many(
        `SELECT u.id, u.name, u.email, u.account_number, COALESCE(u.customer_type, u.price_tier, '-') AS tier,
                date(u.created_at) AS joined,
                (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS orders,
                (SELECT COALESCE(SUM(o.total_cents),0)/100.0 FROM orders o WHERE o.user_id = u.id) AS order_spend,
                (SELECT COALESCE(SUM(ps.total_cents),0)/100.0 FROM pos_sales ps WHERE ps.voided = 0 AND ps.customer_name = u.name) AS pos_spend,
                (SELECT COALESCE(SUM(pt.delta),0) FROM points_transactions pt WHERE pt.user_id = u.id) AS points
           FROM users u
          WHERE u.is_staff = 0 AND COALESCE(u.is_admin,0) = 0
          ORDER BY order_spend + pos_spend DESC
          LIMIT 100`),
      db.one(
        `SELECT (SELECT COUNT(*) FROM users WHERE is_staff = 0 AND COALESCE(is_admin,0) = 0 AND date(created_at) BETWEEN ? AND ?) AS new_customers,
                (SELECT COUNT(DISTINCT user_id) FROM orders WHERE user_id IS NOT NULL AND date(created_at) BETWEEN ? AND ?) AS active_buyers,
                (SELECT COUNT(*) FROM newsletter_subscribers WHERE date(subscribed_at) BETWEEN ? AND ?) AS newsletter`,
        ...p, ...p, ...p),
      db.many(
        `SELECT COALESCE(customer_type, price_tier, '-') AS tier, COUNT(*) AS n
           FROM users WHERE is_staff = 0 AND COALESCE(is_admin,0) = 0 GROUP BY tier ORDER BY n DESC`),
    ]);
    return c.json({ from, to, customers: rows, tiles, by_tier: byTier });
  });

  // ---- order ledger (line list + shipping angle) ------------------
  app.get('/api/admin/reports/order-ledger', adminMw, async (c) => {
    const db = d1(c.env);
    const { from, to } = range(c);
    const p = [from, to];
    const [rows, tiles, byFulfilment, byCarrier] = await Promise.all([
      db.many(
        `SELECT id, date(created_at) AS day, COALESCE(NULLIF(source,''),'storefront') AS source,
                COALESCE(customer_name,'-') AS customer, status, payment_method, payment_status,
                COALESCE(fulfilment,'pickup') AS fulfilment, ship_carrier, tracking_number,
                ship_fee_cents/100.0 AS ship_fee, total_cents/100.0 AS total
           FROM orders WHERE date(created_at) BETWEEN ? AND ? ORDER BY created_at DESC LIMIT 500`, ...p),
      db.one(
        `SELECT COUNT(*) AS n, COALESCE(SUM(total_cents),0)/100.0 AS revenue,
                COALESCE(SUM(CASE WHEN payment_status != 'paid' THEN total_cents ELSE 0 END),0)/100.0 AS unpaid,
                COALESCE(SUM(ship_fee_cents),0)/100.0 AS shipping
           FROM orders WHERE date(created_at) BETWEEN ? AND ?`, ...p),
      db.many(
        `SELECT COALESCE(fulfilment,'pickup') AS fulfilment, COUNT(*) AS n,
                COALESCE(SUM(ship_fee_cents),0)/100.0 AS ship_fee, COALESCE(SUM(total_cents),0)/100.0 AS total
           FROM orders WHERE date(created_at) BETWEEN ? AND ? GROUP BY fulfilment ORDER BY n DESC`, ...p),
      db.many(
        `SELECT COALESCE(ship_carrier,'(none)') AS carrier, COUNT(*) AS n,
                SUM(CASE WHEN tracking_number IS NOT NULL THEN 1 ELSE 0 END) AS tracked,
                COALESCE(SUM(ship_fee_cents),0)/100.0 AS ship_fee
           FROM orders WHERE date(created_at) BETWEEN ? AND ? AND COALESCE(fulfilment,'pickup') != 'pickup'
          GROUP BY ship_carrier ORDER BY n DESC`, ...p),
    ]);
    return c.json({ from, to, orders: rows, tiles, by_fulfilment: byFulfilment, by_carrier: byCarrier });
  });

  // ---- users & staff ---------------------------------------------
  app.get('/api/admin/reports/users-staff', adminMw, async (c) => {
    const db = d1(c.env);
    const [rows, byRole, tiles] = await Promise.all([
      db.many(
        `SELECT u.id, u.name, u.email, u.employee_no, u.admin_role,
                CASE WHEN u.pin_hash IS NOT NULL THEN 'yes' ELSE 'no' END AS pin_set,
                CASE WHEN COALESCE(u.disabled,0) = 1 THEN 'disabled'
                     WHEN COALESCE(u.is_archived,0) = 1 THEN 'archived'
                     ELSE 'active' END AS state,
                date(u.created_at) AS joined,
                (SELECT MAX(ap.last_seen) FROM admin_presence ap WHERE ap.user_id = u.id) AS last_seen,
                m.specialty, m.role AS staff_role
           FROM users u
           LEFT JOIN mechanics m ON m.user_id = u.id
          WHERE u.is_staff = 1 OR COALESCE(u.is_admin,0) = 1
          ORDER BY state ASC, u.name ASC`),
      db.many(
        `SELECT COALESCE(admin_role,'-') AS role, COUNT(*) AS n
           FROM users WHERE is_staff = 1 OR COALESCE(is_admin,0) = 1 GROUP BY admin_role ORDER BY n DESC`),
      db.one(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN COALESCE(disabled,0) = 0 AND COALESCE(is_archived,0) = 0 THEN 1 ELSE 0 END) AS active,
                SUM(CASE WHEN COALESCE(disabled,0) = 1 THEN 1 ELSE 0 END) AS disabled
           FROM users WHERE is_staff = 1 OR COALESCE(is_admin,0) = 1`),
    ]);
    const roleDefs = await db.many('SELECT code, label, rank, can_manage, hidden_tabs FROM roles ORDER BY rank ASC');
    return c.json({ staff: rows, by_role: byRole, tiles, roles: roleDefs.map((r) => ({ code: r.code, label: r.label, rank: r.rank, can_manage: r.can_manage, hidden_tabs: (() => { try { return JSON.parse(r.hidden_tabs || '[]').length; } catch { return 0; } })() })) });
  });

  // ---- setup / configuration snapshot --------------------------
  app.get('/api/admin/reports/setup-config', adminMw, async (c) => {
    const db = d1(c.env);
    const s = (await db.one('SELECT * FROM shop_settings ORDER BY id LIMIT 1')) || {};
    const has = (v) => (v == null || v === '' ? 'no' : 'yes');
    const [counts, roles] = await Promise.all([
      db.one(
        `SELECT (SELECT COUNT(*) FROM users WHERE is_staff = 0 AND COALESCE(is_admin,0) = 0) AS customers,
                (SELECT COUNT(*) FROM users WHERE is_staff = 1 OR COALESCE(is_admin,0) = 1) AS staff,
                (SELECT COUNT(*) FROM products WHERE is_active = 1) AS products,
                (SELECT COUNT(*) FROM suppliers WHERE is_active = 1) AS suppliers,
                (SELECT COUNT(*) FROM coupons WHERE is_active = 1) AS coupons`),
      db.many('SELECT code, label, rank FROM roles ORDER BY rank ASC'),
    ]);
    return c.json({
      company: { name: s.company_name || null, address: s.address || null, phone: s.phone || null, email: s.email || null, country: s.country || null },
      storefront: {
        public_pricing: !!s.storefront_prices,
        pos_enforce_login: !!s.pos_enforce_login,
        pos_enforce_customer: !!s.pos_enforce_customer,
        pos_default_fulfilment: s.pos_default_fulfilment || '(ask each time)',
      },
      print: { logo_on_invoice: !!s.print_logo_on_invoice, default_template: s.default_print_template || null, quote_valid_days: s.quote_valid_days || null },
      shipping_origin: { name: s.ship_origin_name || null, city: s.ship_origin_city || null, parish: s.ship_origin_parish || null, country: s.ship_origin_country || null },
      carriers: {
        dhl: { enabled: !!s.carrier_dhl_enabled, account: has(s.carrier_dhl_account), secret: has(c.env.DHL_API_KEY) },
        fedex: { enabled: !!s.carrier_fedex_enabled, account: has(s.carrier_fedex_account), secret: has(c.env.FEDEX_CLIENT_ID) },
        knutsford: { enabled: !!s.carrier_knutsford_enabled },
        manual: { enabled: s.carrier_manual_enabled == null ? true : !!s.carrier_manual_enabled, flat_fee: Number(s.ship_local_flat_usd) || 0 },
      },
      card_payment: { fygaro_enabled: !!s.fygaro_enabled, button_configured: has(s.fygaro_button_id), secret: has(c.env.FYGARO_JWT_SECRET), currency: s.fygaro_currency || 'JMD' },
      counts,
      roles,
    });
  });

  // ---- custom inventory (configurable columns + filters) --------
  app.get('/api/admin/reports/inventory-custom', adminMw, async (c) => {
    const db = d1(c.env);
    const ALL_COLS = ['sku', 'barcode', 'category', 'bin', 'supplier', 'stock', 'threshold', 'cost', 'retail', 'margin', 'age'];
    const want = String(c.req.query('cols') || 'category,stock,retail')
      .split(',').map((x) => x.trim()).filter((x) => ALL_COLS.includes(x));
    const cols = want.length ? want : ['category', 'stock', 'retail'];

    const where = ['1=1'];
    const binds = [];
    const active = String(c.req.query('active') || '1');
    if (active === '1') where.push('pr.is_active = 1');
    else if (active === '0') where.push('pr.is_active = 0');
    const cat = c.req.query('category');
    if (cat) { where.push('pr.category = ?'); binds.push(cat); }
    const sup = c.req.query('supplier_id');
    if (sup) { where.push('pr.supplier_id = ?'); binds.push(parseInt(sup, 10) || 0); }
    const stock = String(c.req.query('stock') || 'all');
    if (stock === 'in') where.push('pr.stock_count > 0');
    else if (stock === 'out') where.push('pr.stock_count <= 0');
    else if (stock === 'low') where.push('pr.stock_count <= pr.low_threshold');

    const rows = await db.many(
      `SELECT pr.img, pr.name, pr.sku, pr.barcode, COALESCE(pr.category,'-') AS category,
              pr.bin_location AS bin, COALESCE(sp.name,'-') AS supplier,
              pr.stock_count AS stock, pr.low_threshold AS threshold,
              COALESCE(pr.cost_cents,0)/100.0 AS cost, pr.price_cents/100.0 AS retail,
              (pr.price_cents - COALESCE(pr.cost_cents,0))/100.0 AS margin,
              CAST(julianday('now') - julianday(pr.created_at) AS INTEGER) AS age
         FROM products pr LEFT JOIN suppliers sp ON sp.id = pr.supplier_id
        WHERE ${where.join(' AND ')}
        ORDER BY pr.name ASC LIMIT 2000`, ...binds);

    const [cats, sups] = await Promise.all([
      db.many(`SELECT DISTINCT category FROM products WHERE category IS NOT NULL AND category != '' ORDER BY category`),
      db.many(`SELECT id, name FROM suppliers WHERE is_active = 1 ORDER BY name`),
    ]);

    const keep = ['name', ...cols];
    const trimmed = rows.map((r) => { const o = {}; keep.forEach((k) => { o[k] = r[k]; }); return o; });
    const totals = {
      name: `${rows.length} SKUs`,
      stock: rows.reduce((a, r) => a + Number(r.stock || 0), 0),
      cost: Math.round(rows.reduce((a, r) => a + Number(r.stock || 0) * Number(r.cost || 0), 0) * 100) / 100,
      retail: Math.round(rows.reduce((a, r) => a + Number(r.stock || 0) * Number(r.retail || 0), 0) * 100) / 100,
    };
    totals.margin = Math.round((totals.retail - totals.cost) * 100) / 100;
    return c.json({
      cols, rows: trimmed, totals,
      all_cols: ALL_COLS,
      facets: { categories: cats.map((x) => x.category), suppliers: sups },
    });
  });

  // ---- warehouse activity + bin occupancy --------------------
  app.get('/api/admin/reports/warehouse', adminMw, async (c) => {
    const db = d1(c.env);
    const { from, to } = range(c);
    const p = [from, to];
    const [byKind, topMoved, byPerson, net, bins, unbinned, counts] = await Promise.all([
      db.many(`SELECT kind, COUNT(*) AS n, COALESCE(SUM(ABS(qty_delta)),0) AS units
                 FROM warehouse_activity WHERE date(created_at) BETWEEN ? AND ? GROUP BY kind ORDER BY n DESC`, ...p),
      db.many(`SELECT COALESCE(pr.name, wa.product_img) AS product, COUNT(*) AS moves,
                      COALESCE(SUM(wa.qty_delta),0) AS net_delta
                 FROM warehouse_activity wa LEFT JOIN products pr ON pr.img = wa.product_img
                WHERE date(wa.created_at) BETWEEN ? AND ? GROUP BY product ORDER BY moves DESC LIMIT 25`, ...p),
      db.many(`SELECT COALESCE(m.name,'-') AS person, COUNT(*) AS moves
                 FROM warehouse_activity wa LEFT JOIN mechanics m ON m.id = wa.performed_by
                WHERE date(wa.created_at) BETWEEN ? AND ? GROUP BY m.name ORDER BY moves DESC`, ...p),
      db.one(`SELECT COALESCE(SUM(qty_delta),0) AS net FROM warehouse_activity WHERE date(created_at) BETWEEN ? AND ?`, ...p),
      db.many(`SELECT COALESCE(NULLIF(bin_location,''),'(unbinned)') AS bin, COUNT(*) AS skus, COALESCE(SUM(stock_count),0) AS units
                 FROM products WHERE is_active = 1 GROUP BY bin ORDER BY units DESC LIMIT 50`),
      db.one(`SELECT COUNT(*) AS n FROM products WHERE is_active = 1 AND (bin_location IS NULL OR bin_location = '')`),
      db.many(`SELECT count_number, scope, status, date(started_at) AS started, total_items, total_variance
                 FROM stock_counts ORDER BY started_at DESC LIMIT 15`),
    ]);
    return c.json({ from, to, by_kind: byKind, top_moved: topMoved, by_person: byPerson, net_delta: net.net, bins, unbinned: unbinned.n, recent_counts: counts });
  });

  // ---- audit log (synthesized activity feed) ----------------
  app.get('/api/admin/reports/audit-log', adminMw, async (c) => {
    const db = d1(c.env);
    const { from, to } = range(c);
    // date range is inclusive of the whole 'to' day
    const lo = from + ' 00:00:00';
    const hi = to + ' 23:59:59';
    const p = [lo, hi];
    const feed = await db.many(
      `SELECT * FROM (
         SELECT wa.created_at AS at, 'Warehouse' AS area, 'Stock ' || wa.kind AS action,
                COALESCE(pr.name, wa.product_img, '') || ' (' || COALESCE(wa.qty_delta,0) || ')' AS detail,
                COALESCE(m.name,'-') AS by, NULL AS amount
           FROM warehouse_activity wa LEFT JOIN products pr ON pr.img = wa.product_img
           LEFT JOIN mechanics m ON m.id = wa.performed_by
          WHERE wa.created_at BETWEEN ? AND ?
         UNION ALL
         SELECT pt.created_at AS at, 'Loyalty' AS area, 'Points ' || pt.reason AS action,
                'user #' || pt.user_id || ' ' || (CASE WHEN pt.delta >= 0 THEN '+' ELSE '' END) || pt.delta AS detail,
                '-' AS by, NULL AS amount
           FROM points_transactions pt WHERE pt.created_at BETWEEN ? AND ?
         UNION ALL
         SELECT gt.created_at AS at, 'Gift card' AS area, 'Gift card ' || gt.reason AS action,
                gt.reference AS detail, COALESCE(u.name,'-') AS by, gt.delta_cents/100.0 AS amount
           FROM gift_card_transactions gt LEFT JOIN users u ON u.id = gt.performed_by
          WHERE gt.created_at BETWEEN ? AND ?
         UNION ALL
         SELECT ps.created_at AS at, 'POS' AS area, 'Sale voided' AS action,
                COALESCE(ps.receipt_number,'#' || ps.id) AS detail, COALESCE(ps.cashier_name,'-') AS by, ps.total_cents/100.0 AS amount
           FROM pos_sales ps WHERE ps.voided = 1 AND ps.created_at BETWEEN ? AND ?
         UNION ALL
         SELECT pr2.created_at AS at, 'POS' AS area, 'Return / refund' AS action,
                COALESCE(pr2.return_number,'#' || pr2.id) || ' (' || COALESCE(pr2.refund_method,'') || ')' AS detail,
                COALESCE(u.name,'-') AS by, pr2.refund_cents/100.0 AS amount
           FROM pos_returns pr2 LEFT JOIN users u ON u.id = pr2.processed_by
          WHERE pr2.created_at BETWEEN ? AND ?
         UNION ALL
         SELECT o.created_at AS at, 'Orders' AS area, 'Order ' || o.status AS action,
                '#' || o.id || ' ' || COALESCE(o.customer_name,'') AS detail, '-' AS by, o.total_cents/100.0 AS amount
           FROM orders o WHERE o.status NOT IN ('pending') AND o.created_at BETWEEN ? AND ?
       ) ORDER BY at DESC LIMIT 500`,
      ...p, ...p, ...p, ...p, ...p, ...p);
    const byArea = {};
    for (const row of feed) byArea[row.area] = (byArea[row.area] || 0) + 1;
    return c.json({ from, to, feed, by_area: Object.keys(byArea).map((k) => ({ area: k, n: byArea[k] })).sort((a, b) => b.n - a.n) });
  });

  // ---- sales rep commission ------------------------------------
  // Computed at report time, never stored per-sale: a line's commission comes
  // from the product's own override (percent / flat amount / none-at-all) if
  // it has one, else the crediting rep's default percent. Changing a rate
  // recalculates every past sale the same way the margin report already
  // recalculates off products.cost_cents.
  app.get('/api/admin/reports/commission', adminMw, async (c) => {
    const db = d1(c.env);
    const { from, to } = range(c);
    const p = [from, to];
    const CASE = `CASE
        WHEN pr.commission_type = 'none' THEN 0
        WHEN pr.commission_type = 'amount' THEN COALESCE(pr.commission_value,0) * i.qty
        WHEN pr.commission_type = 'percent' THEN (i.total_cents/100.0) * (COALESCE(pr.commission_value,0)/100.0)
        ELSE (i.total_cents/100.0) * (COALESCE(m.commission_pct,0)/100.0)
      END`;
    const JOIN = `FROM pos_sale_items i JOIN pos_sales ps ON ps.id = i.sale_id
                  LEFT JOIN mechanics m ON m.id = ps.sales_rep_id
                  LEFT JOIN products pr ON pr.img = i.product_img`;
    const [byRep, totals, detail, allTime, paid, reps] = await Promise.all([
      db.many(`SELECT ps.sales_rep_id AS mechanic_id, COALESCE(m.name, ps.sales_rep_name, '(no rep)') AS rep,
                      COUNT(*) AS lines, COALESCE(SUM(i.total_cents),0)/100.0 AS revenue,
                      COALESCE(SUM(${CASE}),0) AS commission,
                      SUM(CASE WHEN (${CASE}) = 0 THEN 1 ELSE 0 END) AS skipped_lines
                 ${JOIN}
                WHERE ps.voided = 0 AND ps.sales_rep_id IS NOT NULL AND date(ps.created_at) BETWEEN ? AND ?
                GROUP BY ps.sales_rep_id ORDER BY commission DESC`, ...p),
      db.one(`SELECT COUNT(*) AS lines, COALESCE(SUM(i.total_cents),0)/100.0 AS revenue, COALESCE(SUM(${CASE}),0) AS commission
                 ${JOIN}
                WHERE ps.voided = 0 AND ps.sales_rep_id IS NOT NULL AND date(ps.created_at) BETWEEN ? AND ?`, ...p),
      db.many(`SELECT ps.receipt_number, ps.created_at, COALESCE(m.name, ps.sales_rep_name, '(no rep)') AS rep,
                      i.description, i.qty, i.total_cents/100.0 AS line_total,
                      COALESCE(pr.commission_type, 'rep default') AS commission_type,
                      (${CASE}) AS commission
                 ${JOIN}
                WHERE ps.voided = 0 AND ps.sales_rep_id IS NOT NULL AND date(ps.created_at) BETWEEN ? AND ?
                ORDER BY ps.created_at DESC LIMIT 300`, ...p),
      db.many(`SELECT ps.sales_rep_id AS mechanic_id, COALESCE(SUM(${CASE}),0) AS earned
                 ${JOIN}
                WHERE ps.voided = 0 AND ps.sales_rep_id IS NOT NULL GROUP BY ps.sales_rep_id`),
      db.many(`SELECT mechanic_id, COALESCE(SUM(amount_cents),0)/100.0 AS paid FROM commission_payouts GROUP BY mechanic_id`),
      db.many(`SELECT id, name FROM mechanics WHERE is_active = 1 ORDER BY name`),
    ]);
    const earnedByMech = {}; for (const r of allTime) earnedByMech[r.mechanic_id] = r.earned;
    const paidByMech = {}; for (const r of paid) paidByMech[r.mechanic_id] = r.paid;
    for (const r of byRep) {
      r.earned_all_time = earnedByMech[r.mechanic_id] || 0;
      r.paid_all_time = paidByMech[r.mechanic_id] || 0;
      r.owed = Math.round((r.earned_all_time - r.paid_all_time) * 100) / 100;
    }
    const repOptions = reps.map((m) => ({
      id: m.id, name: m.name,
      owed: Math.round(((earnedByMech[m.id] || 0) - (paidByMech[m.id] || 0)) * 100) / 100,
    }));
    return c.json({ from, to, totals, by_rep: byRep, detail, reps: repOptions });
  });

  // ---- serial number lookup ---------------------------------------
  // Not date-ranged -- this is a query tool (warranty claims, recalls,
  // "who has this unit"), not a period report. Empty query = empty result,
  // not the whole table.
  app.get('/api/admin/reports/serial-lookup', adminMw, async (c) => {
    const term = String(c.req.query('q') || '').trim();
    if (!term) return c.json({ results: [] });
    const db = d1(c.env);
    const like = '%' + term + '%';
    // Sold-line history (free-typed serials + any serial ever put on a sale).
    const rows = await db.many(
      `SELECT psi.id, psi.serial_number, psi.description, psi.product_img, psi.warranty_until, psi.qty,
              ps.id AS sale_id, ps.receipt_number, ps.invoice_number, ps.created_at, ps.customer_name, ps.customer_phone, ps.voided,
              COALESCE((SELECT SUM(pri.qty) FROM pos_return_items pri WHERE pri.sale_item_id = psi.id), 0) AS returned_qty
         FROM pos_sale_items psi JOIN pos_sales ps ON ps.id = psi.sale_id
        WHERE psi.serial_number LIKE ? ORDER BY ps.created_at DESC LIMIT 100`, like);
    // Register rows (0056) -- includes in-stock and returned units the sale
    // history alone can't show.
    const reg = await db.many(
      `SELECT s.id, s.serial AS serial_number, p.name AS description, s.product_img, s.status AS register_status,
              s.warranty_until, s.sale_id, s.sold_at, s.returned_at, s.received_at,
              ps.receipt_number, ps.customer_name, ps.customer_phone
         FROM product_serials s
         JOIN products p ON p.img = s.product_img
         LEFT JOIN pos_sales ps ON ps.id = s.sale_id
        WHERE s.serial LIKE ? ORDER BY s.id DESC LIMIT 100`, like);
    const today = new Date().toISOString().slice(0, 10);
    for (const r of rows) {
      r.warranty_status = !r.warranty_until ? 'no warranty' : r.warranty_until >= today ? 'in warranty' : 'expired';
      r.returned = r.returned_qty >= r.qty;
      r.source = 'sale_line';
    }
    for (const r of reg) {
      r.warranty_status = !r.warranty_until ? 'no warranty' : r.warranty_until >= today ? 'in warranty' : 'expired';
      r.source = 'register';
    }
    return c.json({ results: rows, register: reg });
  });

  // ---- core charges: charged vs. still outstanding -----------------
  // "Outstanding" = a core-charged line whose unit(s) haven't come back yet
  // -- the customer still owes the shop the physical core.
  app.get('/api/admin/reports/core-charges', adminMw, async (c) => {
    const db = d1(c.env);
    const { from, to } = range(c);
    const p = [from, to];
    const rows = await db.many(
      `SELECT psi.id, psi.description, psi.product_img, psi.qty, psi.core_charge_cents/100.0 AS core_charge_usd,
              psi.core_returned,
              ps.id AS sale_id, ps.receipt_number, ps.created_at, ps.customer_name, ps.customer_phone,
              COALESCE((SELECT SUM(pri.qty) FROM pos_return_items pri WHERE pri.sale_item_id = psi.id), 0) AS part_returned_qty,
              COALESCE((SELECT SUM(cr.qty) FROM core_returns cr WHERE cr.sale_item_id = psi.id), 0) AS core_returned_qty
         FROM pos_sale_items psi JOIN pos_sales ps ON ps.id = psi.sale_id
        WHERE psi.core_charge_cents > 0 AND ps.voided = 0 AND date(ps.created_at) BETWEEN ? AND ?
        ORDER BY ps.created_at DESC LIMIT 300`, ...p);
    let charged = 0, outstanding = 0, outstandingLines = 0, waivedAtSale = 0, refundedLater = 0;
    for (const r of rows) {
      // core_returned = 1 -> the deposit was never charged on this line.
      if (r.core_returned) { r.core_outstanding_usd = 0; r.waived_at_sale = true; waivedAtSale += r.core_charge_usd; continue; }
      charged += r.core_charge_usd;
      const done = Math.min(r.qty, (r.part_returned_qty || 0) + (r.core_returned_qty || 0));
      refundedLater += r.core_charge_usd * (Math.min(r.qty, r.core_returned_qty || 0) / r.qty);
      const frac = Math.max(0, (r.qty - done) / r.qty);
      if (frac > 0) { outstanding += r.core_charge_usd * frac; outstandingLines++; }
      r.core_outstanding_usd = Math.round(r.core_charge_usd * frac * 100) / 100;
    }
    const rnd = (n) => Math.round(n * 100) / 100;
    return c.json({
      from, to,
      totals: {
        lines: rows.length, core_charged: rnd(charged),
        waived_at_sale: rnd(waivedAtSale), refunded_later: rnd(refundedLater),
        outstanding_lines: outstandingLines, core_outstanding: rnd(outstanding),
      },
      lines: rows,
    });
  });

  // =========================================================================
  //  Phase 16 — ported from server.js so the hosted menu matches its backend
  // =========================================================================
  // One rule runs through every money report: a sale_payments row with
  // method='account' is NOT cash. It is the debit side of a charge sale, so
  // "payments received" excludes it and receivables are built from it.
  // Backwards, every credit sale counts twice -- once as income, once as debt.

  // ---- payments received -------------------------------------------------
  app.get('/api/admin/reports/payments', adminMw, reportsMw, async (c) => {
    const db = d1(c.env);
    const { from, to } = range(c);
    const p = [from, to];
    const [t, byMethod, byDay, byCashier, st, sv, rf] = await Promise.all([
      db.one(`SELECT COUNT(*) AS n, COALESCE(SUM(sp.amount_cents),0)/100.0 AS total
                FROM sale_payments sp JOIN pos_sales s ON s.id = sp.sale_id
               WHERE s.voided = 0 AND sp.method <> 'account' AND date(sp.created_at) BETWEEN ? AND ?`, ...p),
      db.many(`SELECT sp.method, COUNT(*) AS n, COALESCE(SUM(sp.amount_cents),0)/100.0 AS total
                 FROM sale_payments sp JOIN pos_sales s ON s.id = sp.sale_id
                WHERE s.voided = 0 AND sp.method <> 'account' AND date(sp.created_at) BETWEEN ? AND ?
                GROUP BY sp.method ORDER BY total DESC`, ...p),
      db.many(`SELECT date(sp.created_at) AS day, COUNT(*) AS n, COALESCE(SUM(sp.amount_cents),0)/100.0 AS total
                 FROM sale_payments sp JOIN pos_sales s ON s.id = sp.sale_id
                WHERE s.voided = 0 AND sp.method <> 'account' AND date(sp.created_at) BETWEEN ? AND ?
                GROUP BY 1 ORDER BY 1`, ...p),
      db.many(`SELECT COALESCE(NULLIF(s.cashier_name,''),'-') AS cashier, COUNT(*) AS n,
                      COALESCE(SUM(sp.amount_cents),0)/100.0 AS total
                 FROM sale_payments sp JOIN pos_sales s ON s.id = sp.sale_id
                WHERE s.voided = 0 AND sp.method <> 'account' AND date(sp.created_at) BETWEEN ? AND ?
                GROUP BY 1 ORDER BY total DESC`, ...p),
      db.one(`SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents),0)/100.0 AS total
                FROM account_payments WHERE date(created_at) BETWEEN ? AND ?`, ...p),
      db.one(`SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents),0)/100.0 AS total
                FROM work_order_payments WHERE date(received_at) BETWEEN ? AND ?`, ...p),
      db.one(`SELECT COUNT(*) AS n, COALESCE(SUM(refund_cents),0)/100.0 AS total
                FROM pos_returns WHERE date(created_at) BETWEEN ? AND ?`, ...p),
    ]);
    const gross = (t.total || 0) + (st.total || 0) + (sv.total || 0);
    return c.json({ from, to,
      totals: { counter: t.total || 0, counter_n: t.n, settlements: st.total || 0, settlements_n: st.n,
        service: sv.total || 0, service_n: sv.n, refunds: rf.total || 0, refunds_n: rf.n,
        gross: rnd(gross), net: rnd(gross - (rf.total || 0)) },
      by_method: byMethod, by_day: byDay, by_cashier: byCashier });
  });

  // ---- A/R aging ---------------------------------------------------------
  app.get('/api/admin/reports/ar-aging', adminMw, reportsMw, async (c) => {
    const db = d1(c.env);
    const OPEN = `SELECT s.id, s.receipt_number, s.created_at, s.customer_id,
             COALESCE(NULLIF(s.customer_name,''),'Walk-in') AS customer_name,
             SUM(sp.amount_cents)/100.0 AS charged,
             COALESCE((SELECT SUM(ap.amount_cents)/100.0 FROM account_payments ap
                        WHERE ap.reference = s.receipt_number),0) AS settled
        FROM pos_sales s
        JOIN sale_payments sp ON sp.sale_id = s.id AND sp.method = 'account'
       WHERE s.voided = 0
       GROUP BY s.id, s.receipt_number, s.created_at, s.customer_id, s.customer_name`;
    const [byCustomer, buckets, oldest, net] = await Promise.all([
      db.many(`SELECT customer_name, customer_id, COUNT(*) AS invoices,
                      SUM(charged) AS charged, SUM(settled) AS settled,
                      SUM(charged - settled) AS balance,
                      MIN(date(created_at)) AS oldest,
                      MAX(CAST(julianday('now') - julianday(created_at) AS INTEGER)) AS oldest_days
                 FROM (${OPEN}) o WHERE charged - settled > 0.005
                GROUP BY customer_name, customer_id ORDER BY balance DESC`),
      db.many(`SELECT CASE WHEN julianday('now') - julianday(created_at) <= 30 THEN '0-30 days'
                           WHEN julianday('now') - julianday(created_at) <= 60 THEN '31-60 days'
                           WHEN julianday('now') - julianday(created_at) <= 90 THEN '61-90 days'
                           ELSE 'over 90 days' END AS bucket,
                      COUNT(*) AS invoices, SUM(charged - settled) AS balance,
                      MIN(CAST(julianday('now') - julianday(created_at) AS INTEGER)) AS sort_key
                 FROM (${OPEN}) o WHERE charged - settled > 0.005
                GROUP BY 1 ORDER BY sort_key`),
      db.many(`SELECT receipt_number, customer_name, date(created_at) AS day,
                      CAST(julianday('now') - julianday(created_at) AS INTEGER) AS days,
                      (charged - settled) AS balance
                 FROM (${OPEN}) o WHERE charged - settled > 0.005
                ORDER BY created_at ASC LIMIT 200`),
      db.one(NET_OWED_SQL),
    ]);
    const owed = byCustomer.reduce((a, r) => a + Number(r.balance || 0), 0);
    const netOwed = rnd(net.owed);
    return c.json({
      totals: { customers: byCustomer.length, owed: rnd(owed), net_owed: netOwed, invoices: oldest.length },
      advice: [{ kind: 'data', text: 'Two figures, both correct. The aged total (J$' +
        Math.round(owed).toLocaleString() + ') adds up every invoice still short, which is what you chase. ' +
        'The net position (J$' + Math.round(netOwed).toLocaleString() + ') nets each customer’s overpayments ' +
        'against their own arrears, and is the figure the Management Summary and Customer List report.' }],
      by_customer: byCustomer, buckets, oldest });
  });

  // ---- payables (A/P) ----------------------------------------------------
  app.get('/api/admin/reports/payables', adminMw, reportsMw, async (c) => {
    const db = d1(c.env);
    const { from, to } = range(c);
    const p = [from, to];
    const [paid, byMethod, bySupplier, open] = await Promise.all([
      db.one(`SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents),0)/100.0 AS total
                FROM purchase_order_payments WHERE date(created_at) BETWEEN ? AND ?`, ...p),
      db.many(`SELECT method, COUNT(*) AS n, COALESCE(SUM(amount_cents),0)/100.0 AS total
                 FROM purchase_order_payments WHERE date(created_at) BETWEEN ? AND ?
                GROUP BY method ORDER BY total DESC`, ...p),
      db.many(`SELECT COALESCE(s.name,'(no supplier)') AS supplier, COUNT(DISTINCT po.id) AS pos,
                      COALESCE(SUM(po.total_cents),0)/100.0 AS ordered,
                      COALESCE((SELECT SUM(pp.amount_cents)/100.0 FROM purchase_order_payments pp
                                 WHERE pp.po_id IN (SELECT id FROM purchase_orders WHERE supplier_id = s.id)),0) AS paid
                 FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id
                GROUP BY s.id, s.name ORDER BY ordered DESC`),
      db.many(`SELECT po.po_number, COALESCE(s.name,'(no supplier)') AS supplier, po.status,
                      date(po.created_at) AS day, po.total_cents/100.0 AS total,
                      COALESCE((SELECT SUM(pp.amount_cents)/100.0 FROM purchase_order_payments pp WHERE pp.po_id = po.id),0) AS paid
                 FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id
                ORDER BY po.created_at DESC LIMIT 200`),
    ]);
    for (const r of bySupplier) r.outstanding = rnd(r.ordered - r.paid);
    for (const r of open) r.outstanding = rnd(r.total - r.paid);
    return c.json({ from, to,
      totals: { paid: paid.total || 0, paid_n: paid.n,
        outstanding: rnd(bySupplier.reduce((a, r) => a + r.outstanding, 0)) },
      by_method: byMethod, by_supplier: bySupplier, purchase_orders: open });
  });

  // ---- daily sales journal ----------------------------------------------
  app.get('/api/admin/reports/daily-journal', adminMw, reportsMw, async (c) => {
    const db = d1(c.env);
    const { from, to } = range(c);
    const p = [from, to];
    const [days, tenders, cogs, totals] = await Promise.all([
      db.many(`SELECT date(created_at) AS day, COUNT(*) AS tickets,
                      COALESCE(SUM(subtotal_cents),0)/100.0 AS gross,
                      COALESCE(SUM(discount_cents),0)/100.0 AS discount,
                      COALESCE(SUM(tax_cents),0)/100.0 AS tax,
                      COALESCE(SUM(total_cents),0)/100.0 AS net
                 FROM pos_sales WHERE voided = 0 AND date(created_at) BETWEEN ? AND ?
                GROUP BY 1 ORDER BY 1`, ...p),
      db.many(`SELECT date(s.created_at) AS day, sp.method, COALESCE(SUM(sp.amount_cents),0)/100.0 AS total
                 FROM sale_payments sp JOIN pos_sales s ON s.id = sp.sale_id
                WHERE s.voided = 0 AND date(s.created_at) BETWEEN ? AND ?
                GROUP BY 1, 2 ORDER BY 1`, ...p),
      db.many(`SELECT date(s.created_at) AS day,
                      COALESCE(SUM(i.qty * COALESCE(pr.cost_cents,0)),0)/100.0 AS cogs
                 FROM pos_sale_items i JOIN pos_sales s ON s.id = i.sale_id
                 LEFT JOIN products pr ON pr.img = i.product_img
                WHERE s.voided = 0 AND date(s.created_at) BETWEEN ? AND ?
                GROUP BY 1 ORDER BY 1`, ...p),
      db.one(PERIOD_SQL, ...periodBinds(from, to)),
    ]);
    const cogsByDay = {}; for (const r of cogs) cogsByDay[r.day] = r.cogs;
    const methods = [...new Set(tenders.map((r) => r.method))].sort();
    const tenderByDay = {};
    for (const r of tenders) (tenderByDay[r.day] = tenderByDay[r.day] || {})[r.method] = r.total;
    for (const d of days) {
      d.cogs = cogsByDay[d.day] || 0;
      d.gross_profit = rnd(d.net - d.tax - d.cogs);
      Object.assign(d, tenderByDay[d.day] || {});
    }
    const t = finishPeriod(totals);
    const totalCogs = cogs.reduce((a, r) => a + r.cogs, 0);
    return c.json({ from, to, methods, days,
      totals: { ...t, cogs: rnd(totalCogs), gross_profit: rnd(t.revenue - t.tax - totalCogs) } });
  });

  // ---- goods received ----------------------------------------------------
  // No meta_json here, so a receipt's own unit cost does not exist on this
  // runtime -- value is the product's current cost price instead, which the
  // report states rather than presenting as the purchase price.
  app.get('/api/admin/reports/receivals', adminMw, reportsMw, async (c) => {
    const db = d1(c.env);
    const { from, to } = range(c);
    const p = [from, to];
    const [totals, byDay, topParts, bySupplier, detail, poReceipts] = await Promise.all([
      db.one(`SELECT COUNT(*) AS receipts, COALESCE(SUM(qty_delta),0) AS units
                FROM warehouse_activity WHERE kind = 'receive' AND date(created_at) BETWEEN ? AND ?`, ...p),
      db.many(`SELECT date(created_at) AS day, COUNT(*) AS receipts, COALESCE(SUM(qty_delta),0) AS units
                 FROM warehouse_activity WHERE kind = 'receive' AND date(created_at) BETWEEN ? AND ?
                GROUP BY 1 ORDER BY 1`, ...p),
      db.many(`SELECT COALESCE(pr.name, wa.product_img) AS product, wa.product_img AS sku,
                      COUNT(*) AS receipts, COALESCE(SUM(wa.qty_delta),0) AS units,
                      COALESCE(SUM(wa.qty_delta * COALESCE(pr.cost_cents,0)),0)/100.0 AS cost_value
                 FROM warehouse_activity wa LEFT JOIN products pr ON pr.img = wa.product_img
                WHERE wa.kind = 'receive' AND date(wa.created_at) BETWEEN ? AND ?
                GROUP BY 1, 2 ORDER BY units DESC LIMIT 50`, ...p),
      db.many(`SELECT COALESCE(s.name,'(not recorded)') AS supplier, COUNT(*) AS receipts,
                      COALESCE(SUM(wa.qty_delta),0) AS units
                 FROM warehouse_activity wa
                 LEFT JOIN products pr ON pr.img = wa.product_img
                 LEFT JOIN suppliers s ON s.id = pr.supplier_id
                WHERE wa.kind = 'receive' AND date(wa.created_at) BETWEEN ? AND ?
                GROUP BY 1 ORDER BY units DESC LIMIT 40`, ...p),
      db.many(`SELECT date(wa.created_at) AS day, wa.product_img AS sku,
                      COALESCE(pr.name, wa.product_img) AS product, wa.qty_delta AS qty,
                      COALESCE(s.name,'-') AS supplier, wa.notes
                 FROM warehouse_activity wa
                 LEFT JOIN products pr ON pr.img = wa.product_img
                 LEFT JOIN suppliers s ON s.id = pr.supplier_id
                WHERE wa.kind = 'receive' AND date(wa.created_at) BETWEEN ? AND ?
                ORDER BY wa.created_at DESC LIMIT 300`, ...p),
      db.many(`SELECT po.po_number, COALESCE(s.name,'-') AS supplier,
                      date(po.received_date) AS received, po.total_cents/100.0 AS total,
                      (SELECT COALESCE(SUM(qty_received),0) FROM purchase_order_items WHERE po_id = po.id) AS units
                 FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id
                WHERE po.received_date IS NOT NULL AND date(po.received_date) BETWEEN ? AND ?
                ORDER BY po.received_date DESC LIMIT 200`, ...p),
    ]);
    return c.json({ from, to,
      totals: { ...totals, po_receipts: poReceipts.length,
        top_parts_cost_value: rnd(topParts.reduce((a, r) => a + r.cost_value, 0)) },
      by_day: byDay, top_parts: topParts, by_supplier: bySupplier,
      detail, po_receipts: poReceipts,
      advice: [{ kind: 'data', text: 'Values here use each part’s current cost price. This runtime does not store a per-receipt unit cost, so these are an indication of what the goods are worth, not what was paid for them.' }] });
  });

  // ---- reorder / purchasing ---------------------------------------------
  app.get('/api/admin/reports/reorder', adminMw, reportsMw, async (c) => {
    const db = d1(c.env);
    const { from, to } = range(c);
    // A line qualifies only if someone set a real reorder point, or it is out
    // of stock AND sold in the range. The obvious "stock <= point" test flags a
    // third of the catalogue, which is noise rather than a purchase plan.
    const W = `pr.is_active = 1 AND (
        (COALESCE(pr.reorder_point,0) > 0 AND pr.stock_count <= pr.reorder_point)
        OR (pr.low_threshold > 0 AND pr.stock_count <= pr.low_threshold)
        OR (pr.stock_count <= 0 AND EXISTS (
              SELECT 1 FROM pos_sale_items i JOIN pos_sales ps ON ps.id = i.sale_id
               WHERE i.product_img = pr.img AND ps.voided = 0
                 AND date(ps.created_at) BETWEEN ? AND ?)))`;
    const [rows, totals] = await Promise.all([
      db.many(`SELECT pr.img, pr.sku, pr.name, COALESCE(pr.category,'-') AS category,
                      pr.stock_count AS stock,
                      MAX(COALESCE(NULLIF(pr.reorder_point,0), pr.low_threshold), 0) AS reorder_point,
                      pr.reorder_qty, COALESCE(pr.cost_cents,0)/100.0 AS cost_usd,
                      COALESCE(s.name,'-') AS supplier, s.lead_time_days,
                      COALESCE((SELECT SUM(i.qty) FROM pos_sale_items i JOIN pos_sales ps ON ps.id = i.sale_id
                                 WHERE i.product_img = pr.img AND ps.voided = 0
                                   AND date(ps.created_at) BETWEEN ? AND ?),0) AS sold
                 FROM products pr LEFT JOIN suppliers s ON s.id = pr.supplier_id
                WHERE ${W}
                ORDER BY sold DESC, pr.name ASC LIMIT 400`, from, to, from, to),
      db.one(`SELECT COUNT(*) AS flagged,
                     SUM(CASE WHEN pr.stock_count <= 0 THEN 1 ELSE 0 END) AS out_of_stock
                FROM products pr WHERE ${W}`, from, to),
    ]);
    let cost = 0;
    for (const r of rows) {
      const gap = Math.max(0, (r.reorder_point || 0) - r.stock);
      r.suggest_qty = r.reorder_qty && r.reorder_qty > 0 ? r.reorder_qty : Math.max(1, gap + r.sold);
      r.suggest_cost = rnd(r.suggest_qty * Number(r.cost_usd || 0));
      cost += r.suggest_cost;
    }
    return c.json({ from, to, totals: { ...totals, suggest_cost: rnd(cost) }, items: rows });
  });

  // ---- was it a good order? ---------------------------------------------
  app.get('/api/admin/reports/order-quality', adminMw, reportsMw, async (c) => {
    const db = d1(c.env);
    const { from, to } = range(c);
    const rows = await db.many(
      `WITH recv AS (
         SELECT product_img, MIN(date(created_at)) AS first_recv, SUM(qty_delta) AS received
           FROM warehouse_activity
          WHERE kind = 'receive' AND date(created_at) BETWEEN ? AND ?
          GROUP BY product_img HAVING SUM(qty_delta) > 0)
       SELECT r.product_img AS sku, COALESCE(pr.name, r.product_img) AS product,
              COALESCE(pr.category,'-') AS category, COALESCE(s.name,'-') AS supplier,
              r.received, r.first_recv AS first_received,
              pr.stock_count AS stock_now, COALESCE(pr.cost_cents,0)/100.0 AS cost_usd,
              CAST(julianday('now') - julianday(r.first_recv) AS INTEGER) AS days_since,
              COALESCE((SELECT SUM(i.qty) FROM pos_sale_items i JOIN pos_sales ps ON ps.id = i.sale_id
                         WHERE i.product_img = r.product_img AND ps.voided = 0
                           AND date(ps.created_at) >= r.first_recv),0) AS sold_after
         FROM recv r
         LEFT JOIN products pr ON pr.img = r.product_img
         LEFT JOIN suppliers s ON s.id = pr.supplier_id
        ORDER BY r.received DESC LIMIT 400`, from, to);
    const tally = { good: 0, over: 0, under: 0, slow: 0 };
    let tiedUp = 0, wasted = 0;
    for (const r of rows) {
      const st = r.received > 0 ? r.sold_after / r.received : 0;
      r.sell_through_pct = Math.round(st * 1000) / 10;
      const days = Math.max(1, r.days_since || 1);
      const perDay = r.sold_after / days;
      r.days_cover = perDay > 0 ? Math.round((r.stock_now / perDay) * 10) / 10 : null;
      r.better_qty = perDay > 0 ? Math.max(1, Math.ceil(perDay * 90)) : 0;
      r.over_by = Math.max(0, r.received - r.better_qty);
      r.tied_up_usd = rnd(Math.max(0, r.stock_now) * Number(r.cost_usd || 0));
      if (r.sold_after === 0) { r.verdict = 'never sold'; tally.slow++; wasted += r.tied_up_usd; }
      else if (st >= 0.9 && r.stock_now <= 0) { r.verdict = 'under-bought'; tally.under++; }
      else if (st >= 0.6) { r.verdict = 'good'; tally.good++; }
      else if (st < 0.25) { r.verdict = 'over-bought'; tally.over++; tiedUp += r.tied_up_usd; }
      else { r.verdict = 'slow'; tally.slow++; tiedUp += r.tied_up_usd; }
      r.note = r.verdict === 'under-bought' ? 'sold out — ' + r.better_qty + ' would have covered 90 days'
        : (r.verdict === 'over-bought' || r.verdict === 'slow') ? 'ordered ' + r.received + ', ' + r.better_qty + ' would have done'
        : r.verdict === 'never sold' ? 'no sales since it landed' : 'about right';
    }
    const scored = rows.length || 1;
    return c.json({ from, to,
      totals: { lines: rows.length, good: tally.good, over_bought: tally.over,
        under_bought: tally.under, slow_or_dead: tally.slow,
        good_pct: Math.round((tally.good / scored) * 1000) / 10,
        tied_up: rnd(tiedUp), never_sold_value: rnd(wasted) },
      by_verdict: ['good', 'under-bought', 'slow', 'over-bought', 'never sold'].map((v) => ({
        verdict: v, lines: rows.filter((r) => r.verdict === v).length,
        received: rows.filter((r) => r.verdict === v).reduce((a, r) => a + r.received, 0),
        tied_up: rnd(rows.filter((r) => r.verdict === v).reduce((a, r) => a + r.tied_up_usd, 0)),
      })).filter((x) => x.lines > 0),
      items: rows });
  });

  // =========================================================================
  //  MANAGEMENT REPORTS — summary and detail (ported from server.js)
  // =========================================================================
  // Two dialect notes that apply throughout. pos_sale_returns does not exist on
  // D1 -- returns live in pos_returns with refund_cents -- and cash_payouts /
  // petty_cash_movements were already *_cents here, so unlike Postgres there is
  // no mixed-unit trap: everything divides by 100 the same way.

  // ---- management summary -------------------------------------------------
  app.get('/api/admin/reports/exec-summary', adminMw, reportsMw, async (c) => {
    const db = d1(c.env);
    const { from, to } = range(c);
    const prev = priorPeriod(from, to);
    const ya = yearAgo(from, to);
    const [cur, pre, lastYear, ar, ap, stock, byCat, byCust, byRep, cov] = await Promise.all([
      db.one(PERIOD_SQL, ...periodBinds(from, to)),
      db.one(PERIOD_SQL, ...periodBinds(prev.from, prev.to)),
      db.one(PERIOD_SQL, ...periodBinds(ya.from, ya.to)),
      db.one(NET_OWED_SQL),
      db.one(`SELECT COALESCE(SUM(po.total_cents),0)/100.0
                   - COALESCE((SELECT SUM(amount_cents) FROM purchase_order_payments),0)/100.0 AS outstanding
                FROM purchase_orders po`),
      db.one(`SELECT COALESCE(SUM(stock_count * COALESCE(cost_cents,0)),0)/100.0 AS at_cost,
                     COALESCE(SUM(stock_count * price_cents),0)/100.0 AS at_retail,
                     SUM(CASE WHEN stock_count <= 0 THEN 1 ELSE 0 END) AS out_of_stock
                FROM products WHERE is_active = 1`),
      db.many(`SELECT COALESCE(pr.category,'-') AS category, SUM(i.qty) AS units,
                      SUM(i.total_cents)/100.0 AS revenue,
                      SUM(i.qty * COALESCE(pr.cost_cents,0))/100.0 AS cogs
                 FROM pos_sale_items i JOIN pos_sales s ON s.id = i.sale_id
                 LEFT JOIN products pr ON pr.img = i.product_img
                WHERE s.voided = 0 AND date(s.created_at) BETWEEN ? AND ?
                GROUP BY 1 ORDER BY revenue DESC`, from, to),
      db.many(`SELECT COALESCE(NULLIF(customer_name,''),'Walk-in') AS customer, COUNT(*) AS tickets,
                      SUM(total_cents)/100.0 AS revenue
                 FROM pos_sales WHERE voided = 0 AND date(created_at) BETWEEN ? AND ?
                GROUP BY 1 ORDER BY revenue DESC LIMIT 12`, from, to),
      db.many(`SELECT COALESCE(NULLIF(sales_rep_name,''), NULLIF(cashier_name,''),'(no rep)') AS rep,
                      COUNT(*) AS tickets, SUM(total_cents)/100.0 AS revenue
                 FROM pos_sales WHERE voided = 0 AND date(created_at) BETWEEN ? AND ?
                GROUP BY 1 ORDER BY revenue DESC LIMIT 12`, from, to),
      db.one(`SELECT SUM(CASE WHEN COALESCE(pr.cost_cents,0) = 0 THEN 1 ELSE 0 END) AS no_cost,
                     COUNT(*) AS total
                FROM pos_sale_items i JOIN pos_sales s ON s.id = i.sale_id
                LEFT JOIN products pr ON pr.img = i.product_img
               WHERE s.voided = 0 AND date(s.created_at) BETWEEN ? AND ?`, from, to),
    ]);
    const cu = finishPeriod(cur), pv = finishPeriod(pre), yr = finishPeriod(lastYear);
    for (const r of byCat) {
      r.gross = rnd(r.revenue - r.cogs);
      r.margin_pct = r.revenue > 0 ? Math.round((r.gross / r.revenue) * 1000) / 10 : null;
    }
    const turns = stock.at_cost > 0
      ? Math.round((cu.cogs / stock.at_cost) * (365 / dayCount(from, to)) * 100) / 100 : null;
    // A margin computed against incomplete costs flatters the whole page, and
    // this is the most-read page in the set. Say so before the numbers are
    // believed.
    const advice = [];
    if (cov.no_cost) advice.push({ kind: 'risk', text: cov.no_cost.toLocaleString() + ' of ' +
      cov.total.toLocaleString() + ' sold lines have no cost price, so cost of sales is understated and the ' +
      (cu.margin_pct == null ? 'margin' : cu.margin_pct + '% margin') +
      ' above is higher than reality. Fix the costs (Exception Report lists them) before using this to price or plan.' });
    const rev = delta(cu.revenue, pv.revenue);
    advice.push({ kind: rev.change >= 0 ? 'margin' : 'risk',
      text: 'Revenue ' + (rev.change >= 0 ? 'up' : 'down') + ' J$' + Math.abs(Math.round(rev.change)).toLocaleString() +
        (rev.pct != null ? ' (' + (rev.pct >= 0 ? '+' : '') + rev.pct + '%)' : '') +
        ' against the previous ' + dayCount(from, to) + ' days.' });
    if (cu.margin_pct != null && pv.margin_pct != null) {
      const md = Math.round((cu.margin_pct - pv.margin_pct) * 10) / 10;
      advice.push({ kind: md >= 0 ? 'margin' : 'risk',
        text: 'Gross margin ' + cu.margin_pct + '%, ' + (md >= 0 ? 'up' : 'down') + ' ' + Math.abs(md) +
          ' points on the previous period. Margin moving the opposite way to revenue is the one to watch.' });
    }
    if (ar.owed > 0) advice.push({ kind: 'money', text: 'J$' + Math.round(ar.owed).toLocaleString() + ' is owed to the shop on account. See A/R Aging for how old it is.' });
    if (turns != null && turns < 2) advice.push({ kind: 'cut', text: 'Stock turns ' + turns + ' times a year on J$' + Math.round(stock.at_cost).toLocaleString() + ' at cost. Anything under 2 means cash is sitting on shelves.' });
    if (stock.out_of_stock) advice.push({ kind: 'risk', text: stock.out_of_stock.toLocaleString() + ' active lines are at zero stock. Reorder / Purchasing lists the ones that are actually selling.' });
    return c.json({ from, to, prior: prev, year_ago: ya,
      current: cu, previous: pv, last_year: yr,
      vs_prior: { revenue: delta(cu.revenue, pv.revenue), gross_profit: delta(cu.gross_profit, pv.gross_profit),
        tickets: delta(cu.tickets, pv.tickets), units: delta(cu.units, pv.units),
        avg_ticket: delta(cu.avg_ticket, pv.avg_ticket) },
      vs_year: { revenue: delta(cu.revenue, yr.revenue), gross_profit: delta(cu.gross_profit, yr.gross_profit),
        tickets: delta(cu.tickets, yr.tickets) },
      position: { receivables: rnd(ar.owed), payables: rnd(ap.outstanding),
        stock_at_cost: stock.at_cost, stock_at_retail: stock.at_retail,
        out_of_stock: stock.out_of_stock, turns },
      by_category: byCat, by_customer: byCust, by_rep: byRep, advice });
  });

  // ---- profit & loss ------------------------------------------------------
  app.get('/api/admin/reports/pnl', adminMw, reportsMw, async (c) => {
    const db = d1(c.env);
    const { from, to } = range(c);
    const [sales, service, byMonth, byCat, payouts, petty, refunds] = await Promise.all([
      db.one(PERIOD_SQL, ...periodBinds(from, to)),
      db.one(`SELECT COALESCE(SUM(amount_cents),0)/100.0 AS revenue, COUNT(*) AS n
                FROM work_order_payments WHERE date(received_at) BETWEEN ? AND ?`, from, to),
      db.many(`SELECT strftime('%Y-%m', s.created_at) AS month, COUNT(*) AS tickets,
                      SUM(s.subtotal_cents)/100.0 AS net_sales,
                      SUM(s.tax_cents)/100.0 AS tax,
                      SUM(s.total_cents)/100.0 AS gross,
                      COALESCE(SUM((SELECT SUM(i.qty * COALESCE(pr.cost_cents,0)) FROM pos_sale_items i
                                     LEFT JOIN products pr ON pr.img = i.product_img
                                    WHERE i.sale_id = s.id)),0)/100.0 AS cogs
                 FROM pos_sales s
                WHERE s.voided = 0 AND date(s.created_at) BETWEEN ? AND ?
                GROUP BY 1 ORDER BY 1`, from, to),
      db.many(`SELECT COALESCE(pr.category,'-') AS category,
                      SUM(i.total_cents)/100.0 AS revenue,
                      SUM(i.qty * COALESCE(pr.cost_cents,0))/100.0 AS cogs
                 FROM pos_sale_items i JOIN pos_sales s ON s.id = i.sale_id
                 LEFT JOIN products pr ON pr.img = i.product_img
                WHERE s.voided = 0 AND date(s.created_at) BETWEEN ? AND ?
                GROUP BY 1 ORDER BY revenue DESC`, from, to),
      db.one(`SELECT COALESCE(SUM(amount_cents),0)/100.0 AS total, COUNT(*) AS n
                FROM cash_payouts WHERE COALESCE(voided,0) = 0
                 AND date(created_at) BETWEEN ? AND ?`, from, to),
      db.one(`SELECT COALESCE(SUM(CASE WHEN delta_cents < 0 THEN -delta_cents ELSE 0 END),0)/100.0 AS spent
                FROM petty_cash_movements WHERE date(created_at) BETWEEN ? AND ?`, from, to),
      db.one(`SELECT COALESCE(SUM(refund_cents),0)/100.0 AS total, COUNT(*) AS n
                FROM pos_returns WHERE date(created_at) BETWEEN ? AND ?`, from, to),
    ]);
    const s = finishPeriod(sales);
    for (const r of byMonth) {
      r.gross_profit = rnd(r.net_sales - r.cogs);
      r.margin_pct = r.net_sales > 0 ? Math.round((r.gross_profit / r.net_sales) * 1000) / 10 : null;
    }
    for (const r of byCat) {
      r.gross_profit = rnd(r.revenue - r.cogs);
      r.margin_pct = r.revenue > 0 ? Math.round((r.gross_profit / r.revenue) * 1000) / 10 : null;
    }
    const expenses = rnd(payouts.total + Number(petty.spent));
    const advice = [];
    advice.push({ kind: 'data', text: 'Revenue is net of tax; tax collected is a liability, not income. Expenses here are only what the system records — cash payouts and petty cash. Rent, wages, utilities and anything else paid outside this app are not in it, so “operating result” is gross profit less recorded outgoings, not a statutory P&L.' });
    if (s.cogs === 0 && s.revenue > 0) advice.push({ kind: 'risk', text: 'COGS came out at zero, which means no sold part had a cost price. Gross profit below is therefore the same as net sales and is not a real margin.' });
    return c.json({ from, to,
      revenue: { gross: s.revenue, tax: s.tax, net_sales: rnd(s.revenue - s.tax), discount: s.discount,
        service: service.revenue, refunds: refunds.total },
      cost_of_sales: s.cogs,
      gross_profit: s.gross_profit, margin_pct: s.margin_pct,
      expenses: { cash_payouts: payouts.total, petty_cash: Number(petty.spent), total: expenses },
      operating_result: rnd(s.gross_profit + service.revenue - expenses),
      by_month: byMonth, by_category: byCat, advice });
  });

  // ---- cash flow ----------------------------------------------------------
  app.get('/api/admin/reports/cash-flow', adminMw, reportsMw, async (c) => {
    const db = d1(c.env);
    const { from, to } = range(c);
    const [inCounter, inSettle, inService, outSupplier, outPayout, outPetty, outRefund, byMonth] =
      await Promise.all([
        db.one(`SELECT COALESCE(SUM(sp.amount_cents),0)/100.0 AS total, COUNT(*) AS n
                  FROM sale_payments sp JOIN pos_sales s ON s.id = sp.sale_id
                 WHERE s.voided = 0 AND sp.method <> 'account'
                   AND date(sp.created_at) BETWEEN ? AND ?`, from, to),
        db.one(`SELECT COALESCE(SUM(amount_cents),0)/100.0 AS total, COUNT(*) AS n
                  FROM account_payments WHERE date(created_at) BETWEEN ? AND ?`, from, to),
        db.one(`SELECT COALESCE(SUM(amount_cents),0)/100.0 AS total, COUNT(*) AS n
                  FROM work_order_payments WHERE date(received_at) BETWEEN ? AND ?`, from, to),
        db.one(`SELECT COALESCE(SUM(amount_cents),0)/100.0 AS total, COUNT(*) AS n
                  FROM purchase_order_payments WHERE date(created_at) BETWEEN ? AND ?`, from, to),
        db.one(`SELECT COALESCE(SUM(amount_cents),0)/100.0 AS total, COUNT(*) AS n
                  FROM cash_payouts WHERE COALESCE(voided,0) = 0
                   AND date(created_at) BETWEEN ? AND ?`, from, to),
        db.one(`SELECT COALESCE(SUM(CASE WHEN delta_cents < 0 THEN -delta_cents ELSE 0 END),0)/100.0 AS total
                  FROM petty_cash_movements WHERE date(created_at) BETWEEN ? AND ?`, from, to),
        db.one(`SELECT COALESCE(SUM(refund_cents),0)/100.0 AS total, COUNT(*) AS n
                  FROM pos_returns WHERE date(created_at) BETWEEN ? AND ?`, from, to),
        db.many(`SELECT m AS month,
                        COALESCE((SELECT SUM(sp.amount_cents)/100.0 FROM sale_payments sp
                                   JOIN pos_sales s ON s.id = sp.sale_id
                                  WHERE s.voided = 0 AND sp.method <> 'account'
                                    AND strftime('%Y-%m', sp.created_at) = m),0) AS counter,
                        COALESCE((SELECT SUM(amount_cents)/100.0 FROM account_payments
                                   WHERE strftime('%Y-%m', created_at) = m),0) AS settlements,
                        COALESCE((SELECT SUM(amount_cents)/100.0 FROM purchase_order_payments
                                   WHERE strftime('%Y-%m', created_at) = m),0) AS suppliers,
                        COALESCE((SELECT SUM(amount_cents)/100.0 FROM cash_payouts
                                   WHERE COALESCE(voided,0) = 0
                                     AND strftime('%Y-%m', created_at) = m),0) AS payouts,
                        COALESCE((SELECT SUM(refund_cents)/100.0 FROM pos_returns
                                   WHERE strftime('%Y-%m', created_at) = m),0) AS refunds
                   FROM (SELECT DISTINCT strftime('%Y-%m', created_at) AS m FROM pos_sales
                          WHERE voided = 0 AND date(created_at) BETWEEN ? AND ?) months
                  ORDER BY 1`, from, to),
      ]);
    const money = (r) => Number(r.total) || 0;
    const cashIn = money(inCounter) + money(inSettle) + money(inService);
    const cashOut = money(outSupplier) + money(outPayout) + money(outPetty) + money(outRefund);
    for (const r of byMonth) {
      r.in_total = rnd(r.counter + r.settlements);
      r.out_total = rnd(r.suppliers + r.payouts + r.refunds);
      r.net = rnd(r.in_total - r.out_total);
    }
    let running = 0;
    for (const r of byMonth) { running = rnd(running + r.net); r.running = running; }
    const advice = [];
    advice.push({ kind: 'data', text: 'This tracks money the system saw move. An account-tender sale is not cash in — it becomes cash when the customer settles, which is the Settlements column. Anything paid outside the app (bank fees, wages, rent) is not here.' });
    if (cashOut === 0 && cashIn > 0) advice.push({ kind: 'data', text: 'Nothing is recorded going out: no supplier payments, payouts, petty cash or refunds exist in this range. The net figure is therefore money in, not a true net position.' });
    return c.json({ from, to,
      money_in: { counter: money(inCounter), settlements: money(inSettle), service: money(inService), total: rnd(cashIn) },
      money_out: { suppliers: money(outSupplier), payouts: money(outPayout), petty_cash: money(outPetty), refunds: money(outRefund), total: rnd(cashOut) },
      net: rnd(cashIn - cashOut), by_month: byMonth, advice });
  });

  // ---- period comparison --------------------------------------------------
  app.get('/api/admin/reports/period-compare', adminMw, reportsMw, async (c) => {
    const db = d1(c.env);
    const { from, to } = range(c);
    const prev = priorPeriod(from, to);
    const ya = yearAgo(from, to);
    const catSql = `SELECT COALESCE(pr.category,'-') AS category, SUM(i.qty) AS units,
                           SUM(i.total_cents)/100.0 AS revenue,
                           SUM(i.qty * COALESCE(pr.cost_cents,0))/100.0 AS cogs
                      FROM pos_sale_items i JOIN pos_sales s ON s.id = i.sale_id
                      LEFT JOIN products pr ON pr.img = i.product_img
                     WHERE s.voided = 0 AND date(s.created_at) BETWEEN ? AND ?
                     GROUP BY 1`;
    const [cRow, p1, y1, cc, pc, yc] = await Promise.all([
      db.one(PERIOD_SQL, ...periodBinds(from, to)),
      db.one(PERIOD_SQL, ...periodBinds(prev.from, prev.to)),
      db.one(PERIOD_SQL, ...periodBinds(ya.from, ya.to)),
      db.many(catSql, from, to), db.many(catSql, prev.from, prev.to), db.many(catSql, ya.from, ya.to),
    ]);
    const idx = (rows) => { const m = {}; for (const r of rows) m[r.category] = r; return m; };
    const P = idx(pc), Y = idx(yc);
    const cats = cc.map((r) => {
      const prior = P[r.category] || { revenue: 0, units: 0 };
      const last = Y[r.category] || { revenue: 0, units: 0 };
      return { category: r.category, units: r.units, revenue: rnd(r.revenue),
        prior_revenue: rnd(prior.revenue), year_revenue: rnd(last.revenue),
        vs_prior: delta(r.revenue, prior.revenue).change,
        vs_prior_pct: delta(r.revenue, prior.revenue).pct,
        vs_year: delta(r.revenue, last.revenue).change,
        vs_year_pct: delta(r.revenue, last.revenue).pct };
    }).sort((a, b) => b.revenue - a.revenue);
    const C = finishPeriod(cRow), PP = finishPeriod(p1), YY = finishPeriod(y1);
    const lines = [
      ['Tickets', C.tickets, PP.tickets, YY.tickets, 'num'],
      ['Units', C.units, PP.units, YY.units, 'num'],
      ['Revenue', C.revenue, PP.revenue, YY.revenue, 'money'],
      ['Tax', C.tax, PP.tax, YY.tax, 'money'],
      ['Cost of sales', C.cogs, PP.cogs, YY.cogs, 'money'],
      ['Gross profit', C.gross_profit, PP.gross_profit, YY.gross_profit, 'money'],
      ['Average ticket', C.avg_ticket, PP.avg_ticket, YY.avg_ticket, 'money'],
    ].map((l) => ({ measure: l[0], current: l[1], prior: l[2], year_ago: l[3], kind: l[4],
      vs_prior: delta(l[1], l[2]).change, vs_prior_pct: delta(l[1], l[2]).pct,
      vs_year: delta(l[1], l[3]).change, vs_year_pct: delta(l[1], l[3]).pct }));
    const grew = cats.filter((x) => x.vs_prior > 0).length;
    const advice = [{ kind: 'data', text: 'Prior period is the ' + dayCount(from, to) + ' days immediately before this one (' + prev.from + ' to ' + prev.to + '). Year ago is the same calendar window twelve months back (' + ya.from + ' to ' + ya.to + ').' }];
    if (cats.length) advice.push({ kind: grew >= cats.length / 2 ? 'margin' : 'risk',
      text: grew + ' of ' + cats.length + ' categories grew on the prior period. ' +
        'Biggest mover by value: ' + cats.slice().sort((a, b) => Math.abs(b.vs_prior) - Math.abs(a.vs_prior))[0].category + '.' });
    return c.json({ from, to, prior: prev, year_ago: ya, lines, by_category: cats, advice });
  });

  // ---- exception report ---------------------------------------------------
  // The things that make every other report less trustworthy, counted, with the
  // worst offenders listed. Deliberately blunt: these are jobs, not statistics.
  app.get('/api/admin/reports/exceptions', adminMw, reportsMw, async (c) => {
    const db = d1(c.env);
    const { from, to } = range(c);
    const [counts, noCost, noBin, stockout, overstock, oldUnpaid, splitBins, noSupplier] =
      await Promise.all([
        db.one(`SELECT
          (SELECT COUNT(*) FROM products WHERE is_active = 1 AND COALESCE(cost_cents,0) = 0) AS no_cost,
          (SELECT COUNT(*) FROM products WHERE is_active = 1 AND COALESCE(price_cents,0) = 0) AS no_price,
          (SELECT COUNT(*) FROM products WHERE is_active = 1 AND (bin_location IS NULL OR bin_location = '')) AS no_bin,
          (SELECT COUNT(*) FROM products WHERE is_active = 1 AND supplier_id IS NULL) AS no_supplier,
          (SELECT COUNT(*) FROM products WHERE is_active = 1 AND stock_count < 0) AS negative_stock,
          (SELECT COUNT(*) FROM products WHERE is_active = 1 AND stock_count <= 0) AS out_of_stock,
          (SELECT COUNT(*) FROM pos_sales WHERE voided = 0 AND balance_due_cents > 0) AS unpaid_invoices,
          (SELECT COUNT(*) FROM users WHERE COALESCE(is_staff,0) = 1 AND COALESCE(must_change_password,0) = 1) AS staff_default_pw,
          (SELECT COUNT(*) FROM users WHERE COALESCE(is_staff,0) = 1 AND pin_hash IS NULL) AS staff_no_pin,
          (SELECT COUNT(*) FROM suppliers WHERE is_active = 1 AND (phone IS NULL OR phone = '') AND (email IS NULL OR email = '')) AS supplier_no_contact`),
        db.many(`SELECT sku, name, stock_count, price_cents/100.0 AS price_usd,
                        (stock_count * COALESCE(price_cents,0))/100.0 AS retail_value
                   FROM products WHERE is_active = 1 AND COALESCE(cost_cents,0) = 0 AND stock_count > 0
                  ORDER BY retail_value DESC LIMIT 100`),
        db.many(`SELECT sku, name, stock_count, (stock_count * COALESCE(cost_cents,0))/100.0 AS at_cost
                   FROM products WHERE is_active = 1 AND (bin_location IS NULL OR bin_location = '') AND stock_count > 0
                  ORDER BY at_cost DESC LIMIT 100`),
        db.many(`SELECT pr.sku, pr.name, pr.stock_count, COALESCE(SUM(i.qty),0) AS sold
                   FROM products pr JOIN pos_sale_items i ON i.product_img = pr.img
                   JOIN pos_sales s ON s.id = i.sale_id
                  WHERE pr.is_active = 1 AND pr.stock_count <= 0 AND s.voided = 0
                    AND date(s.created_at) BETWEEN ? AND ?
                  GROUP BY 1,2,3 HAVING SUM(i.qty) > 0 ORDER BY sold DESC LIMIT 100`, from, to),
        db.many(`SELECT pr.sku, pr.name, pr.stock_count,
                        (pr.stock_count * COALESCE(pr.cost_cents,0))/100.0 AS at_cost
                   FROM products pr
                  WHERE pr.is_active = 1 AND pr.stock_count > 0 AND COALESCE(pr.cost_cents,0) > 0
                    AND NOT EXISTS (SELECT 1 FROM pos_sale_items i JOIN pos_sales s ON s.id = i.sale_id
                                     WHERE i.product_img = pr.img AND s.voided = 0
                                       AND date(s.created_at) >= date('now','-365 days'))
                  ORDER BY at_cost DESC LIMIT 100`),
        db.many(`SELECT receipt_number, date(created_at) AS day,
                        COALESCE(NULLIF(customer_name,''),'Walk-in') AS customer,
                        total_cents/100.0 AS total, balance_due_cents/100.0 AS balance,
                        CAST(julianday('now') - julianday(date(created_at)) AS INTEGER) AS days_old
                   FROM pos_sales WHERE voided = 0 AND balance_due_cents > 0
                  ORDER BY created_at ASC LIMIT 100`),
        db.many(`SELECT sku, name, COUNT(DISTINCT bin_location) AS bins
                   FROM products WHERE is_active = 1 AND bin_location IS NOT NULL AND bin_location <> ''
                  GROUP BY sku, name HAVING COUNT(DISTINCT bin_location) > 1 ORDER BY bins DESC LIMIT 100`),
        db.many(`SELECT sku, name, stock_count, (stock_count * COALESCE(cost_cents,0))/100.0 AS at_cost
                   FROM products WHERE is_active = 1 AND supplier_id IS NULL AND stock_count > 0
                  ORDER BY at_cost DESC LIMIT 100`),
      ]);
    const k = counts;
    const issues = [
      { issue: 'Parts with no cost price', n: k.no_cost, impact: 'every margin, COGS and turnover figure is understated', fix: 'Set cost on the highest-value lines first' },
      { issue: 'Parts with no selling price', n: k.no_price, impact: 'cannot be sold at the counter without a manual price', fix: 'Price them or deactivate them' },
      { issue: 'Stocked parts with no bin', n: k.no_bin, impact: 'pickers cannot find them; counts drift', fix: 'Bin the fast movers first' },
      { issue: 'Parts with no supplier', n: k.no_supplier, impact: 'excluded from every supplier report and reorder suggestion', fix: 'Assign a default supplier' },
      { issue: 'Negative stock', n: k.negative_stock, impact: 'a count or a sale is wrong', fix: 'Stock count on those lines' },
      { issue: 'Out of stock', n: k.out_of_stock, impact: 'lost sales if they are still selling', fix: 'See Reorder / Purchasing' },
      { issue: 'Invoices with a balance owing', n: k.unpaid_invoices, impact: 'cash not collected', fix: 'See A/R Aging' },
      { issue: 'Part numbers split across bins', n: splitBins.length, impact: 'pickers find one bin and assume that is all of it', fix: 'Consolidate or record both properly' },
      { issue: 'Staff still on a forced password change', n: k.staff_default_pw, impact: 'those accounts cannot be used until set up', fix: 'Set passwords in Users & Staff' },
      { issue: 'Staff with no till PIN', n: k.staff_no_pin, impact: 'cannot sign in at the keypad', fix: 'Set a PIN in Users & Staff' },
      { issue: 'Suppliers with no phone or email', n: k.supplier_no_contact, impact: 'cannot be chased on an order', fix: 'Fill in contact details' },
    ].filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
    const advice = [{ kind: 'data', text: 'Nothing here is a system error — it is missing or inconsistent data, and each line says what it distorts. The first two are the ones worth doing first: without cost prices, no margin or turnover figure anywhere in Reports can be trusted.' }];
    return c.json({ from, to, counts: k, issues,
      no_cost: noCost, no_bin: noBin, stocked_out_selling: stockout,
      no_sale_12m: overstock, oldest_unpaid: oldUnpaid,
      split_bins: splitBins, no_supplier: noSupplier, advice });
  });

  // ---- stock ageing -------------------------------------------------------
  app.get('/api/admin/reports/stock-ageing', adminMw, reportsMw, async (c) => {
    const db = d1(c.env);
    // julianday() rather than Postgres's CURRENT_DATE - date arithmetic. The
    // CAST matters: julianday returns a float, so without it every bucket
    // boundary straddles by a fraction of a day.
    const AGED = `CAST(julianday('now') - julianday(lr.last_received) AS INTEGER)`;
    const AGE = `CASE
        WHEN lr.last_received IS NULL THEN 'never received'
        WHEN ${AGED} <= 30 THEN '0-30 days'
        WHEN ${AGED} <= 90 THEN '31-90 days'
        WHEN ${AGED} <= 180 THEN '91-180 days'
        WHEN ${AGED} <= 365 THEN '181-365 days'
        ELSE 'over a year' END`;
    const BASE = `FROM products pr
      LEFT JOIN (SELECT product_img, MAX(date(created_at)) AS last_received
                   FROM warehouse_activity WHERE kind = 'receive' GROUP BY 1) lr ON lr.product_img = pr.img
      LEFT JOIN (SELECT i.product_img, MAX(date(s.created_at)) AS last_sold
                   FROM pos_sale_items i JOIN pos_sales s ON s.id = i.sale_id
                  WHERE s.voided = 0 GROUP BY 1) ls ON ls.product_img = pr.img
     WHERE pr.is_active = 1 AND pr.stock_count > 0`;
    const [buckets, items, byCat] = await Promise.all([
      db.many(`SELECT ${AGE} AS bucket, COUNT(*) AS lines,
                      SUM(pr.stock_count) AS units,
                      SUM(pr.stock_count * COALESCE(pr.cost_cents,0))/100.0 AS at_cost,
                      MIN(CASE WHEN lr.last_received IS NULL THEN 99999 ELSE ${AGED} END) AS sort_key
               ${BASE} GROUP BY 1 ORDER BY sort_key`),
      db.many(`SELECT pr.sku, pr.name, COALESCE(pr.category,'-') AS category,
                      COALESCE(NULLIF(pr.bin_location,''),'(unbinned)') AS bin,
                      pr.stock_count AS stock,
                      (pr.stock_count * COALESCE(pr.cost_cents,0))/100.0 AS at_cost,
                      lr.last_received AS last_received, ls.last_sold AS last_sold,
                      ${AGED} AS days_since_received,
                      CAST(julianday('now') - julianday(ls.last_sold) AS INTEGER) AS days_since_sold,
                      ${AGE} AS bucket
               ${BASE} ORDER BY at_cost DESC LIMIT 400`),
      db.many(`SELECT COALESCE(pr.category,'-') AS category, COUNT(*) AS lines,
                      SUM(pr.stock_count * COALESCE(pr.cost_cents,0))/100.0 AS at_cost,
                      SUM(CASE WHEN lr.last_received IS NULL OR ${AGED} > 365
                               THEN pr.stock_count * COALESCE(pr.cost_cents,0) ELSE 0 END)/100.0 AS over_year_cost
               ${BASE} GROUP BY 1 ORDER BY at_cost DESC`),
    ]);
    const total = buckets.reduce((a, r) => a + r.at_cost, 0);
    const stale = buckets.filter((r) => r.bucket === 'over a year' || r.bucket === 'never received')
      .reduce((a, r) => a + r.at_cost, 0);
    for (const r of buckets) r.share_pct = total > 0 ? Math.round((r.at_cost / total) * 1000) / 10 : null;
    const advice = [
      { kind: 'data', text: 'Age is measured from the last time a part was received, because that is the only date this data records for stock arriving. A part received recently but never sold still reads as new — Stock Valuation’s dead-stock list and “no sale in 12 months” in the Exception report catch those.' },
    ];
    if (total > 0) advice.push({ kind: stale / total > 0.5 ? 'cut' : 'margin',
      text: 'J$' + Math.round(stale).toLocaleString() + ' of J$' + Math.round(total).toLocaleString() +
        ' at cost (' + Math.round((stale / total) * 100) + '%) has not been restocked in over a year. That is the capital least likely to come back.' });
    return c.json({ buckets, items, by_category: byCat,
      totals: { at_cost: rnd(total), stale_at_cost: rnd(stale) }, advice });
  });

  // ---- sales detail register ----------------------------------------------
  app.get('/api/admin/reports/sales-detail', adminMw, reportsMw, async (c) => {
    const db = d1(c.env);
    const { from, to } = range(c);
    const [rows, t] = await Promise.all([
      db.many(`SELECT s.receipt_number AS invoice, date(s.created_at) AS day,
                      COALESCE(NULLIF(s.customer_name,''),'Walk-in') AS customer,
                      COALESCE(NULLIF(s.sales_rep_name,''), NULLIF(s.cashier_name,''),'-') AS rep,
                      s.payment_method, i.product_img AS sku,
                      COALESCE(pr.name, i.description) AS product,
                      COALESCE(pr.category,'-') AS category,
                      i.qty, i.unit_price_cents/100.0 AS unit_price,
                      i.total_cents/100.0 AS line_total,
                      COALESCE(pr.cost_cents,0)/100.0 AS unit_cost,
                      (i.qty * COALESCE(pr.cost_cents,0))/100.0 AS line_cost,
                      (i.total_cents - i.qty * COALESCE(pr.cost_cents,0))/100.0 AS line_margin
                 FROM pos_sale_items i JOIN pos_sales s ON s.id = i.sale_id
                 LEFT JOIN products pr ON pr.img = i.product_img
                WHERE s.voided = 0 AND date(s.created_at) BETWEEN ? AND ?
                ORDER BY s.created_at DESC, i.id ASC LIMIT 2000`, from, to),
      db.one(`SELECT COUNT(*) AS lines, COUNT(DISTINCT s.id) AS invoices,
                     COALESCE(SUM(i.qty),0) AS units,
                     COALESCE(SUM(i.total_cents),0)/100.0 AS revenue,
                     COALESCE(SUM(i.qty * COALESCE(pr.cost_cents,0)),0)/100.0 AS cost
                FROM pos_sale_items i JOIN pos_sales s ON s.id = i.sale_id
                LEFT JOIN products pr ON pr.img = i.product_img
               WHERE s.voided = 0 AND date(s.created_at) BETWEEN ? AND ?`, from, to),
    ]);
    t.margin = rnd(t.revenue - t.cost);
    t.margin_pct = t.revenue > 0 ? Math.round((t.margin / t.revenue) * 1000) / 10 : null;
    return c.json({ from, to, totals: t, rows,
      shown: rows.length, truncated: rows.length >= 2000,
      advice: [{ kind: 'data', text: 'One row per sold line, newest first, capped at 2,000. The totals above cover the whole range, not just the rows shown. Credit-note lines carry negative quantities, so they subtract here as they do everywhere else.' }] });
  });

  // ---- customer statement -------------------------------------------------
  app.get('/api/admin/reports/customer-statement', adminMw, reportsMw, async (c) => {
    const db = d1(c.env);
    const { from, to } = range(c);
    const id = parseInt(c.req.query('customer_id'), 10);
    const list = await db.many(
      `SELECT u.id, COALESCE(NULLIF(u.name,''), u.email) AS name,
              COALESCE((SELECT SUM(sp.amount_cents)/100.0 FROM sale_payments sp
                         JOIN pos_sales s ON s.id = sp.sale_id
                        WHERE sp.method = 'account' AND s.customer_id = u.id AND s.voided = 0),0)
            - COALESCE((SELECT SUM(amount_cents)/100.0 FROM account_payments WHERE customer_id = u.id),0) AS balance
         FROM users u WHERE COALESCE(u.is_staff,0) = 0 AND COALESCE(u.is_admin,0) = 0
        ORDER BY balance DESC LIMIT 400`);
    if (!id) return c.json({ from, to, customers: list, customer: null });
    const cust = await db.one('SELECT * FROM users WHERE id = ?', id);
    if (!cust) return c.json({ error: 'That customer no longer exists.' }, 404);

    const [opening, lines, closing, charged] = await Promise.all([
      // Everything before the window, netted, is the opening balance.
      db.one(`SELECT COALESCE((SELECT SUM(sp.amount_cents)/100.0 FROM sale_payments sp
                                JOIN pos_sales s ON s.id = sp.sale_id
                               WHERE sp.method = 'account' AND s.customer_id = ? AND s.voided = 0
                                 AND date(s.created_at) < ?),0)
                   - COALESCE((SELECT SUM(amount_cents)/100.0 FROM account_payments
                                WHERE customer_id = ? AND date(created_at) < ?),0) AS opening`,
        id, from, id, from),
      db.many(`SELECT * FROM (
                 SELECT s.created_at AS at, date(s.created_at) AS day, 'Invoice' AS kind,
                        s.receipt_number AS reference, s.total_cents/100.0 AS charge, 0.0 AS credit,
                        COALESCE(s.payment_method,'') AS detail
                   FROM pos_sales s
                  WHERE s.customer_id = ? AND s.voided = 0
                    AND date(s.created_at) BETWEEN ? AND ?
                 UNION ALL
                 SELECT ap.created_at AS at, date(ap.created_at) AS day, 'Payment' AS kind,
                        COALESCE(ap.reference,'') AS reference, 0.0 AS charge, ap.amount_cents/100.0 AS credit,
                        COALESCE(ap.method,'') AS detail
                   FROM account_payments ap
                  WHERE ap.customer_id = ? AND date(ap.created_at) BETWEEN ? AND ?
               ) t ORDER BY at ASC LIMIT 1000`, id, from, to, id, from, to),
      db.one(`SELECT COALESCE((SELECT SUM(sp.amount_cents)/100.0 FROM sale_payments sp
                                JOIN pos_sales s ON s.id = sp.sale_id
                               WHERE sp.method = 'account' AND s.customer_id = ? AND s.voided = 0
                                 AND date(s.created_at) <= ?),0)
                   - COALESCE((SELECT SUM(amount_cents)/100.0 FROM account_payments
                                WHERE customer_id = ? AND date(created_at) <= ?),0) AS closing`,
        id, to, id, to),
      db.many(`SELECT s.receipt_number, COALESCE(SUM(sp.amount_cents),0)/100.0 AS on_account
                 FROM pos_sales s JOIN sale_payments sp ON sp.sale_id = s.id AND sp.method = 'account'
                WHERE s.customer_id = ? AND s.voided = 0
                  AND date(s.created_at) BETWEEN ? AND ?
                GROUP BY 1`, id, from, to),
    ]);
    // A running balance only makes sense on the account side, so the charge
    // column shows the invoice total while the balance moves by what went on
    // account.
    let bal = Number(opening.opening) || 0;
    const onAcct = new Map(charged.map((r) => [r.receipt_number, r.on_account]));
    for (const l of lines) {
      l.on_account = l.kind === 'Invoice' ? (onAcct.get(l.reference) || 0) : 0;
      bal = rnd(bal + l.on_account - l.credit);
      l.balance = bal;
    }
    const t = { opening: rnd(Number(opening.opening) || 0), closing: rnd(Number(closing.closing) || 0),
      invoices: lines.filter((l) => l.kind === 'Invoice').length,
      payments: lines.filter((l) => l.kind === 'Payment').length,
      charged: rnd(lines.reduce((a, l) => a + l.on_account, 0)),
      paid: rnd(lines.reduce((a, l) => a + l.credit, 0)) };
    return c.json({ from, to, customers: list,
      customer: { id: cust.id, name: cust.name || cust.email, email: cust.email, phone: cust.phone,
        account_number: cust.account_number, customer_type: cust.customer_type,
        payment_terms_days: cust.payment_terms_days,
        credit_limit_usd: cust.credit_limit_cents != null ? cust.credit_limit_cents / 100 : null },
      totals: t, lines,
      advice: [{ kind: 'data', text: 'The balance column tracks the account only: a cash sale appears as an invoice but does not move it. Opening is everything on account before ' + from + ', netted against payments; closing is the same test at ' + to + '.' }] });
  });

  // =========================================================================
  //  RANKING, TURNOVER AND BATCH REPORTS
  // =========================================================================
  // "Best selling item" and "best selling item by customer / supplier / rep /
  // bin" are the same question asked down a different column, so they are one
  // endpoint with a dimension rather than five near-identical reports. Same for
  // the profitability pair. `by=overall` gives the plain item ranking; any other
  // dimension gives each group's own top sellers, which is what "by customer"
  // actually means in a shop -- not a filter, a per-customer answer.
  //
  // Credit notes carry negative qty and value, so they net out of every ranking
  // here on their own -- a part that was sold and returned does not rank.
  function rankingSql(dimSql, metric, perGroup) {
    // SQLite resolves window ORDER BY the same way Postgres does: a SELECT alias
    // from the same list is not visible to it. Rank on the expression.
    const rankBy = metric === 'profit' ? '(revenue - cogs)' : metric;
    return `
      WITH base AS (
        SELECT ${dimSql} AS dim, i.product_img AS sku,
               COALESCE(pr.name, i.description) AS product,
               COALESCE(pr.category,'-') AS category,
               COALESCE(s.name,'(no supplier)') AS supplier,
               COALESCE(NULLIF(pr.bin_location,''),'(unbinned)') AS bin,
               SUM(i.qty) AS units,
               SUM(i.total_cents)/100.0 AS revenue,
               (SUM(i.qty) * COALESCE(pr.cost_cents,0))/100.0 AS cogs,
               COUNT(DISTINCT ps.id) AS tickets,
               MAX(date(ps.created_at)) AS last_sold
          FROM pos_sale_items i
          JOIN pos_sales ps ON ps.id = i.sale_id
          LEFT JOIN products pr ON pr.img = i.product_img
          LEFT JOIN suppliers s ON s.id = pr.supplier_id
         WHERE ps.voided = 0 AND date(ps.created_at) BETWEEN ? AND ?
         GROUP BY 1, 2, 3, 4, 5, 6, pr.cost_cents),
      scored AS (
        SELECT *, (revenue - cogs) AS profit,
               CASE WHEN revenue > 0 THEN ROUND((revenue - cogs) / revenue * 100, 1) END AS margin_pct,
               -- Thousands of active parts carry no cost price, which computes
               -- as 100% margin. Say so per line instead of reporting a fiction.
               (CASE WHEN cogs > 0 THEN 1 ELSE 0 END) AS cost_known,
               ROW_NUMBER() OVER (PARTITION BY dim ORDER BY ${rankBy} DESC) AS rn,
               -- Group totals, so the breakdown leads with the biggest groups
               -- rather than sorting junk customer names to the top.
               SUM(units) OVER (PARTITION BY dim) AS dim_units,
               SUM(revenue - cogs) OVER (PARTITION BY dim) AS dim_profit
          FROM base WHERE units > 0)
      SELECT * FROM scored WHERE rn <= ${perGroup}
       ORDER BY ${metric === 'profit' ? 'dim_profit' : 'dim_units'} DESC, dim ASC, rn ASC LIMIT 1200`;
  }

  async function rankingReport(c, metric) {
    const db = d1(c.env);
    const { from, to } = range(c);
    const key = RANK_DIMS[c.req.query('by')] ? c.req.query('by') : 'overall';
    const dim = RANK_DIMS[key];
    const perGroup = key === 'overall' ? 200 : 3;
    const [rows, groups, recv, cov] = await Promise.all([
      db.many(rankingSql(dim.sql, metric, perGroup), from, to),
      db.many(`SELECT ${dim.sql} AS dim, COUNT(DISTINCT ps.id) AS tickets,
                      SUM(i.qty) AS units, SUM(i.total_cents)/100.0 AS revenue,
                      SUM(i.qty * COALESCE(pr.cost_cents,0))/100.0 AS cogs
                 FROM pos_sale_items i JOIN pos_sales ps ON ps.id = i.sale_id
                 LEFT JOIN products pr ON pr.img = i.product_img
                 LEFT JOIN suppliers s ON s.id = pr.supplier_id
                WHERE ps.voided = 0 AND date(ps.created_at) BETWEEN ? AND ?
                GROUP BY 1
                ORDER BY ${metric === 'profit'
                  ? '(SUM(i.total_cents) - SUM(i.qty * COALESCE(pr.cost_cents,0)))' : metric} DESC
                LIMIT 300`, from, to),
      // What each part cost to bring in over the range -- the "based on order
      // from receival" side. warehouse_activity has no meta_json on D1, so the
      // unit cost is the part's current cost rather than the receipt's own.
      db.many(`SELECT wa.product_img AS sku, SUM(wa.qty_delta) AS received,
                      SUM(wa.qty_delta * COALESCE(pr.cost_cents,0))/100.0 AS received_cost
                 FROM warehouse_activity wa
                 LEFT JOIN products pr ON pr.img = wa.product_img
                WHERE wa.kind = 'receive' AND date(wa.created_at) BETWEEN ? AND ?
                GROUP BY 1`, from, to),
      db.one(`SELECT SUM(CASE WHEN COALESCE(pr.cost_cents,0) = 0 THEN 1 ELSE 0 END) AS no_cost,
                     COUNT(*) AS total
                FROM pos_sale_items i JOIN pos_sales ps ON ps.id = i.sale_id
                LEFT JOIN products pr ON pr.img = i.product_img
               WHERE ps.voided = 0 AND date(ps.created_at) BETWEEN ? AND ?`, from, to),
    ]);
    const recvBy = new Map(recv.map((r) => [r.sku, r]));
    for (const r of rows) {
      const rc = recvBy.get(r.sku);
      r.received = rc ? rc.received : 0;
      r.received_cost = rc ? rnd(rc.received_cost) : 0;
      r.profit = rnd(r.profit);
      r.cost_known = !!r.cost_known;
      r.sell_through_pct = r.received > 0 ? Math.round((r.units / r.received) * 1000) / 10 : null;
      r.profit_per_unit = r.units > 0 ? rnd(r.profit / r.units) : null;
    }
    for (const g of groups) {
      g.profit = rnd(g.revenue - g.cogs);
      g.margin_pct = g.revenue > 0 ? Math.round((g.profit / g.revenue) * 1000) / 10 : null;
    }
    const totals = {
      units: groups.reduce((a, g) => a + g.units, 0),
      revenue: rnd(groups.reduce((a, g) => a + g.revenue, 0)),
      profit: rnd(groups.reduce((a, g) => a + g.profit, 0)),
      groups: groups.length, lines: rows.length,
    };
    totals.margin_pct = totals.revenue > 0 ? Math.round((totals.profit / totals.revenue) * 1000) / 10 : null;
    totals.lines_no_cost = rows.filter((r) => !r.cost_known).length;
    const advice = [];
    if (cov.no_cost) {
      advice.push({ kind: 'data', text: cov.no_cost.toLocaleString() + ' of ' + cov.total.toLocaleString() +
        ' sold lines in this range have no cost price on the part, so their cost counts as zero and they show a 100% margin. ' +
        'Profit rankings favour them unfairly until those costs are filled in — the Margin % column reads “no cost” where that applies.' });
    }
    advice.push({ kind: 'margin', text: metric === 'profit'
      ? 'Ranked on gross profit (revenue less quantity × the part’s current cost), not revenue. A part can top revenue and still rank low here.'
      : 'Ranked on units sold. Revenue and profit are shown alongside so a high-volume, low-margin line is visible as such.' });
    return c.json({ from, to, by: key, by_label: dim.label, per_group: perGroup, metric,
      dims: Object.keys(RANK_DIMS).map((k) => ({ key: k, label: RANK_DIMS[k].label })),
      totals, rows, groups, advice });
  }

  app.get('/api/admin/reports/best-sellers', adminMw, reportsMw, (c) => rankingReport(c, 'units'));
  app.get('/api/admin/reports/most-profitable', adminMw, reportsMw, (c) => rankingReport(c, 'profit'));

  // ---- inventory turnover -------------------------------------------------
  // turns = cost of goods sold in the range / inventory held at cost, annualised
  // to the range so a 30-day window and a 12-month one are comparable. DSI is
  // the days of sales the shelf represents.
  //
  // The honest limit: this schema keeps no historical stock snapshots, so the
  // denominator is inventory as it stands TODAY, not the average over the range.
  app.get('/api/admin/reports/inventory-turnover', adminMw, reportsMw, async (c) => {
    const db = d1(c.env);
    const { from, to } = range(c);
    const days = dayCount(from, to);
    const annualise = 365 / days;
    const shape = (rows) => {
      for (const r of rows) {
        r.turns = r.stock_cost > 0 ? Math.round((r.cogs / r.stock_cost) * annualise * 100) / 100 : null;
        r.dsi = r.turns > 0 ? Math.round(365 / r.turns) : null;
        r.verdict = r.cogs <= 0 ? 'not selling'
          : r.turns == null ? 'no stock held'
          : r.turns >= 6 ? 'fast — keep stocked'
          : r.turns >= 2 ? 'healthy'
          : r.turns >= 0.5 ? 'slow — order less'
          : 'very slow — stop reordering';
      }
      return rows;
    };
    const COGS_CTE = `WITH cogs AS (
        SELECT i.product_img, SUM(i.qty * COALESCE(pr.cost_cents,0))/100.0 AS cogs,
               SUM(i.total_cents)/100.0 AS revenue, SUM(i.qty) AS units
          FROM pos_sale_items i JOIN pos_sales ps ON ps.id = i.sale_id
          LEFT JOIN products pr ON pr.img = i.product_img
         WHERE ps.voided = 0 AND date(ps.created_at) BETWEEN ? AND ?
         GROUP BY i.product_img)`;
    const [overall, byCategory, bySupplier, byBin, items, cov] = await Promise.all([
      db.one(`${COGS_CTE}
              SELECT COALESCE(SUM(c.cogs),0) AS cogs, COALESCE(SUM(c.revenue),0) AS revenue,
                     (SELECT COALESCE(SUM(stock_count * COALESCE(cost_cents,0)),0)/100.0
                        FROM products WHERE is_active = 1) AS stock_cost
                FROM cogs c`, from, to),
      db.many(`${COGS_CTE}
               SELECT COALESCE(pr.category,'-') AS category,
                      COALESCE(SUM(c.cogs),0) AS cogs,
                      COALESCE(SUM(c.revenue),0) AS revenue,
                      COALESCE(SUM(pr.stock_count * COALESCE(pr.cost_cents,0)),0)/100.0 AS stock_cost
                 FROM products pr LEFT JOIN cogs c ON c.product_img = pr.img
                WHERE pr.is_active = 1 GROUP BY 1 ORDER BY cogs DESC`, from, to),
      db.many(`${COGS_CTE}
               SELECT COALESCE(s.name,'(no supplier)') AS supplier,
                      COALESCE(SUM(c.cogs),0) AS cogs,
                      COALESCE(SUM(c.revenue),0) AS revenue,
                      COALESCE(SUM(pr.stock_count * COALESCE(pr.cost_cents,0)),0)/100.0 AS stock_cost
                 FROM products pr LEFT JOIN suppliers s ON s.id = pr.supplier_id
                 LEFT JOIN cogs c ON c.product_img = pr.img
                WHERE pr.is_active = 1 GROUP BY 1 ORDER BY cogs DESC LIMIT 60`, from, to),
      db.many(`${COGS_CTE}
               SELECT COALESCE(NULLIF(pr.bin_location,''),'(unbinned)') AS bin,
                      COALESCE(SUM(c.cogs),0) AS cogs,
                      COALESCE(SUM(c.revenue),0) AS revenue,
                      COALESCE(SUM(pr.stock_count * COALESCE(pr.cost_cents,0)),0)/100.0 AS stock_cost
                 FROM products pr LEFT JOIN cogs c ON c.product_img = pr.img
                WHERE pr.is_active = 1 GROUP BY 1 ORDER BY stock_cost DESC LIMIT 60`, from, to),
      db.many(`${COGS_CTE}
               SELECT pr.sku, pr.name, COALESCE(pr.category,'-') AS category,
                      COALESCE(NULLIF(pr.bin_location,''),'(unbinned)') AS bin,
                      pr.stock_count AS stock,
                      COALESCE(c.units,0) AS units, COALESCE(c.cogs,0) AS cogs,
                      COALESCE(c.revenue,0) AS revenue,
                      (pr.stock_count * COALESCE(pr.cost_cents,0))/100.0 AS stock_cost
                 FROM products pr LEFT JOIN cogs c ON c.product_img = pr.img
                WHERE pr.is_active = 1 AND pr.stock_count > 0
                ORDER BY stock_cost DESC LIMIT 300`, from, to),
      db.one(`SELECT SUM(CASE WHEN COALESCE(cost_cents,0) = 0 THEN 1 ELSE 0 END) AS no_cost,
                     COUNT(*) AS total FROM products WHERE is_active = 1`),
    ]);
    const o = shape([overall])[0];
    const slow = shape(items).filter((r) => r.turns != null && r.turns < 0.5).length;
    const advice = [];
    advice.push({ kind: 'data', text: 'Turns are annualised from a ' + days + '-day range, against inventory as it stands today — this schema keeps no historical stock snapshots, so read it as an indication rather than an audited figure.' });
    if (cov.no_cost) {
      advice.push({ kind: 'data', text: cov.no_cost.toLocaleString() + ' of ' + cov.total.toLocaleString() +
        ' active parts have no cost price. Those contribute nothing to COGS but their stock still counts in the denominator, so every turns figure below is understated — the gap, not the trading, is what makes the shop-wide number look stalled.' });
    }
    if (o.turns != null) advice.push({ kind: 'margin', text: 'The shop as a whole turns its stock ' + o.turns + ' times a year, which is about ' + (o.dsi || '—') + ' days of inventory. Under 2 is slow for fast-moving parts.' });
    if (slow) advice.push({ kind: 'cut', text: slow + ' of the ' + items.length + ' highest-value lines turn less than half a time a year. Those are the first candidates to stop reordering.' });
    return c.json({ from, to, days, totals: o, by_category: shape(byCategory),
      by_supplier: shape(bySupplier), by_bin: shape(byBin), items, advice });
  });

  // ---- best receival batch ------------------------------------------------
  // A "batch" is a day's receiving from one supplier. The source export carried
  // no bill or order number, so the day is the only grouping the data supports.
  //
  // Scored on what happened in the 90 days after it landed: how much of it sold,
  // what it earned, and how long it took. profit_per_day is the one that ranks
  // them, because a batch that earns the same money in a third of the time tied
  // up a third of the cash.
  app.get('/api/admin/reports/receival-batches', adminMw, reportsMw, async (c) => {
    const db = d1(c.env);
    const { from, to } = range(c);
    const rows = await db.many(
      `WITH recv AS (
         SELECT date(wa.created_at) AS day, wa.product_img,
                COALESCE(s.name,'(no supplier)') AS supplier,
                SUM(wa.qty_delta) AS qty,
                SUM(wa.qty_delta * COALESCE(pr.cost_cents,0))/100.0 AS cost
           FROM warehouse_activity wa
           LEFT JOIN products pr ON pr.img = wa.product_img
           LEFT JOIN suppliers s ON s.id = pr.supplier_id
          WHERE wa.kind = 'receive' AND date(wa.created_at) BETWEEN ? AND ?
          GROUP BY 1, 2, 3 HAVING SUM(wa.qty_delta) > 0),
       -- Bound the sale lines once, to the only window any batch can draw on
       -- (the earliest receipt through 90 days past the latest). Without this
       -- the planner re-walks pos_sale_items for every batch; the Postgres
       -- version of that measured 3.8s.
       win AS (
         SELECT i.product_img, i.qty, i.total_cents, date(ps.created_at) AS d
           FROM pos_sale_items i JOIN pos_sales ps ON ps.id = i.sale_id
          WHERE ps.voided = 0
            AND date(ps.created_at) BETWEEN ? AND date(?, '+90 days')),
       sold AS (
         SELECT r.day, r.supplier, SUM(w.qty) AS sold,
                SUM(w.total_cents)/100.0 AS revenue,
                SUM(w.qty * COALESCE(pr.cost_cents,0))/100.0 AS cogs,
                CAST(MIN(julianday(w.d) - julianday(r.day)) AS INTEGER) AS first_sale_days,
                CAST(MAX(julianday(w.d) - julianday(r.day)) AS INTEGER) AS last_sale_days
           FROM recv r
           JOIN win w ON w.product_img = r.product_img
            AND w.d >= r.day AND w.d <= date(r.day, '+90 days')
           LEFT JOIN products pr ON pr.img = r.product_img
          GROUP BY 1, 2)
       SELECT b.day AS day, b.supplier, b.lines, b.units_in, b.cost_in,
              COALESCE(sd.sold,0) AS sold, COALESCE(sd.revenue,0) AS revenue,
              COALESCE(sd.cogs,0) AS cogs,
              sd.first_sale_days, sd.last_sale_days
         FROM (SELECT day, supplier, COUNT(*) AS lines,
                      SUM(qty) AS units_in, SUM(cost) AS cost_in
                 FROM recv GROUP BY day, supplier) b
         LEFT JOIN sold sd ON sd.day = b.day AND sd.supplier = b.supplier
        ORDER BY b.day DESC LIMIT 400`, from, to, from, to);

    for (const r of rows) {
      r.profit = rnd(r.revenue - r.cogs);
      r.margin_pct = r.revenue > 0 ? Math.round((r.profit / r.revenue) * 1000) / 10 : null;
      r.sell_through_pct = r.units_in > 0 ? Math.round((r.sold / r.units_in) * 1000) / 10 : null;
      // Days of shelf time actually used: how long it took to shift what shifted.
      r.days_to_sell = r.sold > 0 ? (r.last_sale_days || 0) + 1 : null;
      // Pace: at the rate it sold, how long the whole batch would take to clear.
      r.est_clear_days = r.sold > 0 && r.days_to_sell
        ? Math.round((r.units_in / (r.sold / r.days_to_sell)) * 10) / 10 : null;
      r.profit_per_day = r.days_to_sell ? rnd(r.profit / r.days_to_sell) : null;
      r.verdict = r.sold === 0 ? 'never sold — dead buy'
        : r.sell_through_pct >= 90 ? 'cleared — buy more next time'
        : r.sell_through_pct >= 50 ? 'good'
        : r.sell_through_pct >= 20 ? 'slow — order less'
        : 'mostly unsold — stop';
    }
    const scored = rows.filter((r) => r.sold > 0);
    const best = scored.slice().sort((a, b) => (b.profit_per_day || 0) - (a.profit_per_day || 0));
    const worst = rows.slice().sort((a, b) => (a.sell_through_pct || 0) - (b.sell_through_pct || 0));
    const totals = {
      batches: rows.length, units_in: rows.reduce((a, r) => a + r.units_in, 0),
      cost_in: rnd(rows.reduce((a, r) => a + r.cost_in, 0)),
      sold: rows.reduce((a, r) => a + r.sold, 0),
      revenue: rnd(rows.reduce((a, r) => a + r.revenue, 0)),
      profit: rnd(rows.reduce((a, r) => a + r.profit, 0)),
      dead_batches: rows.filter((r) => r.sold === 0).length,
      avg_days_to_sell: scored.length
        ? Math.round(scored.reduce((a, r) => a + (r.days_to_sell || 0), 0) / scored.length) : null,
    };
    totals.sell_through_pct = totals.units_in > 0
      ? Math.round((totals.sold / totals.units_in) * 1000) / 10 : null;
    const advice = [];
    advice.push({ kind: 'data', text: 'A batch here is one day’s receiving from one supplier — the export carried no bill or order number, so that is the finest grouping the data supports. Each is measured over the 90 days after it landed.' });
    // The Postgres build reads each receipt's own unit cost out of
    // warehouse_activity.meta_json. That column does not exist on D1, so "cost
    // in" here is quantity × the part's CURRENT cost price. Say so plainly: it
    // is a ranking, not a historical purchase figure.
    advice.push({ kind: 'data', text: '“Cost in” is units received × the part’s current cost price. This runtime does not store the cost on each receipt, so it is not what was actually paid at the time — treat “Cost in” and “Profit / day” as rankings rather than money.' });
    if (totals.sell_through_pct != null && totals.sell_through_pct > 100) {
      advice.push({ kind: 'data', text: 'Sell-through above 100% is expected here: sales in the 90-day window include stock that was already on the shelf when the delivery landed, not only the units it brought. Read it as “this part moved faster than this delivery supplied”.' });
    }
    if (best.length) advice.push({ kind: 'order', text: 'Best batch by profit per day on the shelf: ' + best[0].supplier + ' on ' + best[0].day + ' — J$' + Math.round(best[0].profit).toLocaleString() + ' profit in ' + best[0].days_to_sell + ' days. Repeat that shape of order.' });
    if (totals.dead_batches) advice.push({ kind: 'cut', text: totals.dead_batches + ' batch(es) sold nothing at all in their first 90 days. Those suppliers and dates are worth reviewing before the next order.' });
    if (totals.avg_days_to_sell) advice.push({ kind: 'when', text: 'Typical batch takes about ' + totals.avg_days_to_sell + ' days to shift what it shifts. Order cycles shorter than that will stack stock faster than it leaves.' });
    return c.json({ from, to, totals, batches: rows,
      best: best.slice(0, 40), worst: worst.slice(0, 40), advice });
  });

  // =========================================================================
  //  DRILL-DOWN ANALYSIS — supplier, customer, bin
  // =========================================================================
  // All three share scoreItems(), so a part cannot be called overstocked on one
  // page and healthy on another.

  // ---- supplier drill-down ------------------------------------------------
  app.get('/api/admin/reports/supplier-detail', adminMw, reportsMw, async (c) => {
    const db = d1(c.env);
    const { from, to } = range(c);
    const id = parseInt(c.req.query('supplier_id'), 10);
    const list = await db.many(
      `SELECT s.id, s.name, (SELECT COUNT(*) FROM products pr WHERE pr.supplier_id = s.id) AS skus
         FROM suppliers s WHERE s.is_active = 1 ORDER BY skus DESC, s.name ASC`);
    if (!id) return c.json({ from, to, suppliers: list, supplier: null });

    const sup = await db.one('SELECT * FROM suppliers WHERE id = ?', id);
    if (!sup) return c.json({ error: 'That supplier no longer exists.' }, 404);

    // No LIMIT on `items`: the tiles and the order total have to cover every
    // part this supplier carries, not the top slice. Scoring a truncated list is
    // how a supplier with 11,542 SKUs reported 500 of them as its whole book.
    // Only the display lists are cut down, after the arithmetic.
    const [items, recv, byDay, byType, unattributed] = await Promise.all([
      db.many(ITEM_ANALYSIS_SQL('pr.supplier_id = ?') + ' ORDER BY revenue DESC',
        ...itemBinds(from, to), id),
      // warehouse_activity carries no meta_json on D1, so a receipt's own unit
      // cost and reference are unavailable -- the part's current cost stands in
      // and the reference reads as unrecorded. Said plainly in `advice` below.
      db.many(`SELECT date(wa.created_at) AS day, wa.product_img AS sku,
                      COALESCE(pr.name, wa.product_img) AS product, wa.qty_delta AS qty,
                      wa.kind AS type,
                      COALESCE(pr.cost_cents,0)/100.0 AS unit_cost,
                      '—' AS reference,
                      (wa.qty_delta * COALESCE(pr.cost_cents,0))/100.0 AS line_cost
                 FROM warehouse_activity wa JOIN products pr ON pr.img = wa.product_img
                WHERE pr.supplier_id = ? AND date(wa.created_at) BETWEEN ? AND ?
                ORDER BY wa.created_at DESC LIMIT 400`, id, from, to),
      db.many(`SELECT date(wa.created_at) AS day, COUNT(*) AS receipts,
                      COALESCE(SUM(wa.qty_delta),0) AS units,
                      COALESCE(SUM(wa.qty_delta * COALESCE(pr.cost_cents,0)),0)/100.0 AS cost
                 FROM warehouse_activity wa JOIN products pr ON pr.img = wa.product_img
                WHERE pr.supplier_id = ? AND wa.kind = 'receive'
                  AND date(wa.created_at) BETWEEN ? AND ?
                GROUP BY 1 ORDER BY 1`, id, from, to),
      db.many(`SELECT wa.kind AS type, COUNT(*) AS movements,
                      COALESCE(SUM(wa.qty_delta),0) AS units
                 FROM warehouse_activity wa JOIN products pr ON pr.img = wa.product_img
                WHERE pr.supplier_id = ? AND date(wa.created_at) BETWEEN ? AND ?
                GROUP BY 1 ORDER BY movements DESC`, id, from, to),
      db.one(`SELECT COUNT(*) AS n FROM warehouse_activity wa
                LEFT JOIN products pr ON pr.img = wa.product_img
               WHERE wa.kind = 'receive' AND pr.supplier_id IS NULL`),
    ]);

    const days = dayCount(from, to);
    const scored = scoreItems(items, days, Number(sup.lead_time_days) || 7);
    const sum = (f) => rnd(scored.reduce((a, r) => a + (f(r) || 0), 0));
    const buy = scored.filter((r) => r.order_qty > 0)
      .sort((a, b) => (Number(b.order_now) - Number(a.order_now)) || (b.revenue - a.revenue));
    const totals = {
      skus: scored.length,
      stock_units: scored.reduce((a, r) => a + r.stock, 0),
      stock_cost: sum((r) => r.stock * Number(r.cost_usd || 0)),
      received_units: scored.reduce((a, r) => a + r.received, 0),
      sold_units: scored.reduce((a, r) => a + r.sold, 0),
      revenue: sum((r) => r.revenue), cogs: sum((r) => r.cogs),
      dead_lines: scored.filter((r) => r.sold === 0 && r.stock > 0).length,
      dead_cost: sum((r) => (r.sold === 0 && r.stock > 0 ? r.stock * Number(r.cost_usd || 0) : 0)),
      stockouts: scored.filter((r) => r.stock <= 0 && r.sold > 0).length,
      order_lines: buy.length, order_cost: sum((r) => (r.order_qty > 0 ? r.order_cost : 0)),
      order_now_lines: buy.filter((r) => r.order_now).length,
    };
    totals.margin = rnd(totals.revenue - totals.cogs);
    totals.margin_pct = totals.revenue > 0 ? Math.round((totals.margin / totals.revenue) * 1000) / 10 : null;
    totals.sell_through_pct = totals.received_units > 0
      ? Math.round((totals.sold_units / totals.received_units) * 1000) / 10 : null;

    // What to say about this supplier, in plain words, from the figures above.
    const advice = [];
    if (totals.order_now_lines) advice.push({ kind: 'order', text: totals.order_now_lines + ' line(s) are at or below their reorder point and should go on the next order — ' + totals.order_lines + ' lines in total, about J$' + Math.round(totals.order_cost).toLocaleString() + ' at cost.' });
    if (totals.stockouts) advice.push({ kind: 'risk', text: totals.stockouts + ' part(s) are out of stock but still selling. Those are lost sales now, not later.' });
    if (totals.dead_lines) advice.push({ kind: 'cut', text: totals.dead_lines + ' part(s) from this supplier have not sold at all in this range, holding J$' + Math.round(totals.dead_cost).toLocaleString() + ' at cost. Stop reordering these before adding anything new.' });
    const rising = scored.filter((r) => r.trend === 'rising' && r.sold > 0).length;
    if (rising) advice.push({ kind: 'order', text: rising + ' part(s) are selling faster in the second half of this range than the first — raise their quantities rather than reordering the same amount.' });
    const lead = Number(sup.lead_time_days) || 7;
    advice.push({ kind: 'when', text: 'Lead time on file is ' + lead + ' day(s), so every reorder point below assumes ' + lead + ' days of cover plus half again as safety. Set a real lead time on the supplier record if that is wrong — it moves every date on this page.' });
    if (totals.margin_pct != null) advice.push({ kind: 'margin', text: 'Parts from this supplier run at ' + totals.margin_pct + '% gross margin over the range. Compare against the Suppliers report before committing to a bigger order.' });
    advice.push({ kind: 'data', text: 'This runtime does not store a cost or a reference on each receipt, so the receival list below prices every line at the part’s current cost and shows no bill number. Read “cost” there as an indication of value received, not what was paid.' });
    if (!recv.length) advice.push({ kind: 'data', text: 'No receipts are recorded against this supplier in this range, so quantities here are inferred from sales alone.' });

    return c.json({ from, to, days, suppliers: list,
      supplier: { id: sup.id, name: sup.name, contact_name: sup.contact_name, phone: sup.phone,
        email: sup.email, payment_terms: sup.payment_terms, lead_time_days: sup.lead_time_days,
        account_number: sup.account_number },
      totals,
      // Totals above are over all of them; these two lists are trimmed for the
      // page, and say so.
      items: scored.slice(0, 400), items_shown: Math.min(400, scored.length), items_total: scored.length,
      buy_list: buy.slice(0, 200), buy_shown: Math.min(200, buy.length), buy_total: buy.length,
      receivals: recv, by_day: byDay, by_type: byType, advice,
      unattributed_receivals: unattributed.n });
  });

  // ---- customer drill-down: what they buy ---------------------------------
  app.get('/api/admin/reports/customer-items', adminMw, reportsMw, async (c) => {
    const db = d1(c.env);
    const { from, to } = range(c);
    const id = parseInt(c.req.query('customer_id'), 10);
    const list = await db.many(
      `SELECT u.id, COALESCE(NULLIF(u.name,''), u.email) AS name,
              COALESCE((SELECT SUM(ps.total_cents)/100.0 FROM pos_sales ps
                         WHERE ps.customer_id = u.id AND ps.voided = 0),0) AS spend
         FROM users u WHERE COALESCE(u.is_staff,0) = 0
        ORDER BY spend DESC LIMIT 400`);
    if (!id) return c.json({ from, to, customers: list, customer: null });

    const cust = await db.one('SELECT * FROM users WHERE id = ?', id);
    if (!cust) return c.json({ error: 'That customer no longer exists.' }, 404);

    const [items, byMonth, invoices, tiles, bal] = await Promise.all([
      db.many(`SELECT i.product_img AS sku, COALESCE(pr.name, i.description) AS product,
                      COALESCE(pr.category,'-') AS category, COALESCE(s.name,'-') AS supplier,
                      COUNT(DISTINCT ps.id) AS orders,
                      COALESCE(SUM(i.qty),0) AS qty,
                      COALESCE(SUM(i.total_cents),0)/100.0 AS revenue,
                      COALESCE(SUM(i.qty * COALESCE(pr.cost_cents,0)),0)/100.0 AS cogs,
                      MAX(date(ps.created_at)) AS last_bought,
                      MIN(date(ps.created_at)) AS first_bought,
                      pr.stock_count AS stock_now
                 FROM pos_sale_items i JOIN pos_sales ps ON ps.id = i.sale_id
                 LEFT JOIN products pr ON pr.img = i.product_img
                 LEFT JOIN suppliers s ON s.id = pr.supplier_id
                WHERE ps.voided = 0 AND ps.customer_id = ?
                  AND date(ps.created_at) BETWEEN ? AND ?
                GROUP BY i.product_img, pr.name, i.description, pr.category, s.name, pr.stock_count
                ORDER BY revenue DESC LIMIT 400`, id, from, to),
      db.many(`SELECT strftime('%Y-%m', ps.created_at) AS month, COUNT(*) AS invoices,
                      COALESCE(SUM(ps.total_cents),0)/100.0 AS spend
                 FROM pos_sales ps
                WHERE ps.voided = 0 AND ps.customer_id = ?
                  AND date(ps.created_at) BETWEEN ? AND ?
                GROUP BY 1 ORDER BY 1`, id, from, to),
      db.many(`SELECT ps.receipt_number, date(ps.created_at) AS day, ps.payment_method,
                      ps.total_cents/100.0 AS total, ps.balance_due_cents/100.0 AS balance
                 FROM pos_sales ps
                WHERE ps.voided = 0 AND ps.customer_id = ?
                  AND date(ps.created_at) BETWEEN ? AND ?
                ORDER BY ps.created_at DESC LIMIT 200`, id, from, to),
      db.one(`SELECT COUNT(*) AS invoices, COALESCE(SUM(total_cents),0)/100.0 AS spend,
                     MIN(date(created_at)) AS first_seen, MAX(date(created_at)) AS last_seen
                FROM pos_sales WHERE voided = 0 AND customer_id = ?`, id),
      db.one(`SELECT COALESCE((SELECT SUM(sp.amount_cents)/100.0 FROM sale_payments sp
                                JOIN pos_sales ps ON ps.id = sp.sale_id
                               WHERE sp.method = 'account' AND ps.customer_id = ? AND ps.voided = 0),0)
                   - COALESCE((SELECT SUM(amount_cents)/100.0 FROM account_payments
                                WHERE customer_id = ?),0) AS balance`, id, id),
    ]);

    const days = dayCount(from, to);
    for (const r of items) {
      r.margin = rnd(r.revenue - r.cogs);
      r.margin_pct = r.revenue > 0 ? Math.round((r.margin / r.revenue) * 1000) / 10 : null;
      // How often they come back for it, and therefore when they are next due.
      const span = r.first_bought && r.last_bought
        ? Math.max(1, Math.round((Date.parse(r.last_bought) - Date.parse(r.first_bought)) / 86400000)) : null;
      r.every_days = r.orders > 1 && span ? Math.round(span / (r.orders - 1)) : null;
      r.due_in_days = r.every_days
        ? r.every_days - Math.round((Date.now() - Date.parse(r.last_bought)) / 86400000) : null;
      r.note = r.due_in_days == null ? 'bought once — no pattern yet'
        : r.due_in_days <= 0 ? 'overdue to reorder — follow up'
        : r.due_in_days <= 14 ? 'due within ' + r.due_in_days + ' days'
        : 'next due in about ' + r.due_in_days + ' days';
      r.can_supply = r.stock_now == null ? 'not stocked'
        : r.stock_now >= (r.qty / Math.max(1, r.orders)) ? 'in stock' : 'short';
    }

    const overdue = items.filter((r) => r.due_in_days != null && r.due_in_days <= 0);
    const soon = items.filter((r) => r.due_in_days != null && r.due_in_days > 0 && r.due_in_days <= 14);
    const short = items.filter((r) => r.can_supply === 'short');
    const advice = [];
    if (overdue.length) advice.push({ kind: 'call', text: overdue.length + ' part(s) are past this customer’s usual reorder interval. Worth a call — the top one is ' + overdue[0].product + ', normally every ' + overdue[0].every_days + ' days.' });
    if (soon.length) advice.push({ kind: 'when', text: soon.length + ' part(s) fall due within two weeks. Have them on the shelf before they ask.' });
    if (short.length) advice.push({ kind: 'risk', text: short.length + ' part(s) this customer buys regularly are short or out of stock. They are the lines most likely to send them elsewhere.' });
    if (bal.balance > 0.005) advice.push({ kind: 'money', text: 'This account owes J$' + Math.round(bal.balance).toLocaleString() + '. Settle or agree terms before taking a large order on credit.' });
    const topCat = {};
    for (const r of items) topCat[r.category] = (topCat[r.category] || 0) + r.revenue;
    const best = Object.entries(topCat).sort((a, b) => b[1] - a[1])[0];
    if (best) advice.push({ kind: 'sell', text: 'Spend concentrates in ' + best[0] + ' (J$' + Math.round(best[1]).toLocaleString() + '). That is the category to quote first and stock deepest for them.' });

    return c.json({ from, to, days, customers: list,
      customer: { id: cust.id, name: cust.name || cust.email, email: cust.email, phone: cust.phone,
        account_number: cust.account_number, customer_type: cust.customer_type,
        payment_terms_days: cust.payment_terms_days },
      totals: { ...tiles, balance: rnd(bal.balance), lines: items.length,
        margin: rnd(items.reduce((a, r) => a + r.margin, 0)) },
      items, by_month: byMonth, invoices, advice });
  });

  // ---- bin / location analysis --------------------------------------------
  // Compares where stock sits against how fast it moves. A fast mover in a far
  // bin costs a walk on every sale; a dead line in a prime bin costs the space.
  app.get('/api/admin/reports/bin-analysis', adminMw, reportsMw, async (c) => {
    const db = d1(c.env);
    const { from, to } = range(c);
    const [bins, items, unbinned, spread] = await Promise.all([
      // Same pre-aggregate-once shape as ITEM_ANALYSIS_SQL: the correlated
      // version of this measured 7.8s on Postgres because it ran one sales
      // lookup for every active product, and D1 bills by rows read.
      db.many(`WITH sales AS (
                 SELECT i.product_img, SUM(i.qty) AS sold
                   FROM pos_sale_items i JOIN pos_sales ps ON ps.id = i.sale_id
                  WHERE ps.voided = 0 AND date(ps.created_at) BETWEEN ? AND ?
                  GROUP BY i.product_img)
               SELECT COALESCE(NULLIF(pr.bin_location,''),'(unbinned)') AS bin,
                      COUNT(*) AS skus, COALESCE(SUM(pr.stock_count),0) AS units,
                      COALESCE(SUM(pr.stock_count * COALESCE(pr.cost_cents,0)),0)/100.0 AS stock_cost,
                      COALESCE(SUM(sa.sold),0) AS sold,
                      SUM(CASE WHEN pr.stock_count <= 0 THEN 1 ELSE 0 END) AS empty_lines
                 FROM products pr LEFT JOIN sales sa ON sa.product_img = pr.img
                WHERE pr.is_active = 1
                GROUP BY 1 ORDER BY stock_cost DESC LIMIT 80`, from, to),
      db.many(ITEM_ANALYSIS_SQL('pr.is_active = 1 AND pr.stock_count > 0')
        + ' ORDER BY revenue DESC LIMIT 300', ...itemBinds(from, to)),
      db.one(`SELECT COUNT(*) AS skus, COALESCE(SUM(stock_count),0) AS units,
                     COALESCE(SUM(stock_count * COALESCE(cost_cents,0)),0)/100.0 AS stock_cost,
                     -- The true bin count, because the bins list above is capped
                     -- at 80 and "bins in use: 80" would be a cap, not a fact.
                     (SELECT COUNT(DISTINCT bin_location) FROM products
                       WHERE is_active = 1 AND bin_location IS NOT NULL AND bin_location <> '') AS bins_total
                FROM products WHERE is_active = 1 AND (bin_location IS NULL OR bin_location = '')`),
      db.many(`SELECT pr.sku, pr.name, COUNT(DISTINCT pr.bin_location) AS bins
                 FROM products pr WHERE pr.is_active = 1 AND pr.bin_location IS NOT NULL
                GROUP BY pr.sku, pr.name HAVING COUNT(DISTINCT pr.bin_location) > 1
                ORDER BY bins DESC LIMIT 50`),
    ]);
    const days = dayCount(from, to);
    const scored = scoreItems(items, days, 7);
    for (const b of bins) {
      b.turns = b.stock_cost > 0 && b.sold > 0 ? Math.round((b.sold / Math.max(1, b.units)) * 100) / 100 : 0;
      b.dead = b.sold === 0;
    }
    const fastFar = scored.filter((r) => r.abc === 'A' && r.bin === '(unbinned)').slice(0, 50);
    const deadPrime = bins.filter((b) => b.dead && b.stock_cost > 0).slice(0, 50);
    const advice = [];
    if (unbinned.skus) advice.push({ kind: 'risk', text: unbinned.skus.toLocaleString() + ' stocked part(s) have no bin at all, holding J$' + Math.round(unbinned.stock_cost).toLocaleString() + ' at cost. Nobody can pick what nobody can find — bin these first.' });
    if (fastFar.length) advice.push({ kind: 'move', text: fastFar.length + ' of your A-class (top 80% of revenue) parts have no bin recorded. These are the ones picked most often, so they are the ones worth binning first.' });
    if (deadPrime.length) advice.push({ kind: 'cut', text: deadPrime.length + ' bin(s) hold stock that did not sell at all in this range. That is shelf space earning nothing.' });
    if (spread.length) advice.push({ kind: 'tidy', text: spread.length + ' part number(s) appear in more than one bin. Pickers will find one and assume that is all of it, so counts drift.' });
    return c.json({ from, to, days, bins, items: scored,
      unbinned, split_across_bins: spread,
      fast_unbinned: fastFar, dead_bins: deadPrime, advice });
  });

  // =========================================================================
  //  DIRECTORY REPORTS
  // =========================================================================

  // ---- customer list -----------------------------------------------------
  app.get('/api/admin/reports/customer-list', adminMw, reportsMw, async (c) => {
    const db = d1(c.env);
    const [rows, byType, totals] = await Promise.all([
      db.many(`SELECT u.id, u.name, u.email, u.phone, u.account_number,
                      COALESCE(u.customer_type,'retail') AS customer_type,
                      COALESCE(u.price_tier,'retail') AS price_tier,
                      u.credit_type, u.payment_terms_days,
                      COALESCE(u.credit_limit_cents,0)/100.0 AS credit_limit_usd,
                      date(u.created_at) AS joined,
                      (SELECT COUNT(*) FROM pos_sales ps WHERE ps.customer_id = u.id AND ps.voided = 0) AS sales,
                      COALESCE((SELECT SUM(ps.total_cents)/100.0 FROM pos_sales ps
                                 WHERE ps.customer_id = u.id AND ps.voided = 0),0) AS spend,
                      (SELECT MAX(date(ps.created_at)) FROM pos_sales ps
                        WHERE ps.customer_id = u.id AND ps.voided = 0) AS last_sale,
                      COALESCE((SELECT SUM(sp.amount_cents)/100.0 FROM sale_payments sp
                                 JOIN pos_sales ps ON ps.id = sp.sale_id
                                WHERE sp.method = 'account' AND ps.customer_id = u.id AND ps.voided = 0),0)
                    - COALESCE((SELECT SUM(ap.amount_cents)/100.0 FROM account_payments ap
                                WHERE ap.customer_id = u.id),0) AS balance
                 FROM users u
                WHERE COALESCE(u.is_staff,0) = 0 AND COALESCE(u.is_admin,0) = 0
                ORDER BY spend DESC, u.name ASC LIMIT 2000`),
      db.many(`SELECT COALESCE(customer_type,'retail') AS customer_type, COUNT(*) AS n
                 FROM users WHERE COALESCE(is_staff,0) = 0 AND COALESCE(is_admin,0) = 0
                GROUP BY 1 ORDER BY n DESC`),
      // Counted in SQL over every customer, not summed from the 2,000 rows the
      // list shows. Doing it in JS over the limited array put the Postgres build
      // J$363,602 out of step with the Management Summary and A/R Aging.
      db.one(`SELECT COUNT(*) AS customers,
                     SUM(CASE WHEN account_number IS NOT NULL THEN 1 ELSE 0 END) AS with_account,
                     SUM(CASE WHEN customer_type = 'trade' THEN 1 ELSE 0 END) AS trade,
                     (${NET_OWED_SQL}) AS owed
                FROM users WHERE COALESCE(is_staff,0) = 0 AND COALESCE(is_admin,0) = 0`),
    ]);
    return c.json({ totals, by_type: byType, customers: rows, shown: rows.length });
  });

  // ---- vendor list -------------------------------------------------------
  app.get('/api/admin/reports/vendor-list', adminMw, reportsMw, async (c) => {
    const db = d1(c.env);
    const [rows, totals] = await Promise.all([
      db.many(`SELECT s.id, s.name, s.code, s.contact_name, s.phone, s.email,
                      s.payment_terms, s.lead_time_days, s.account_number, s.is_active,
                      (SELECT COUNT(*) FROM products pr WHERE pr.supplier_id = s.id) AS skus,
                      COALESCE((SELECT SUM(pr.stock_count * COALESCE(pr.cost_cents,0))/100.0
                                  FROM products pr
                                 WHERE pr.supplier_id = s.id AND pr.is_active = 1),0) AS stock_cost,
                      (SELECT COUNT(*) FROM purchase_orders po WHERE po.supplier_id = s.id) AS pos,
                      (SELECT MAX(date(po.created_at)) FROM purchase_orders po
                        WHERE po.supplier_id = s.id) AS last_po
                 FROM suppliers s ORDER BY stock_cost DESC, s.name ASC`),
      // Aggregated in SQL for the same reason as customer-list: the vendor list
      // is unbounded today but the tile must not depend on that staying true.
      db.one(`SELECT COUNT(*) AS vendors,
                     SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active,
                     COALESCE((SELECT SUM(stock_count * COALESCE(cost_cents,0))/100.0 FROM products
                                WHERE is_active = 1 AND supplier_id IS NOT NULL),0) AS stock_cost
                FROM suppliers`),
    ]);
    return c.json({ totals, vendors: rows });
  });
}
