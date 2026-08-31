// Phase 15 — analytics + the reports suite. Ports server.js:
//   GET /api/admin/analytics
//   GET /api/admin/reports/{x,z,drawer-sessions,sales,products,returns,tax,
//       orders,workorders,purchasing,inventory,labour,customers}
import { d1 } from '../_lib/db.js';
import { adminMw } from '../_lib/guards.js';

function range(c) {
  const today = new Date().toISOString().slice(0, 10);
  const from = String(c.req.query('from') || today).slice(0, 10);
  const to = String(c.req.query('to') || from).slice(0, 10);
  return { from, to };
}

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
    const [totals, byStatus, byPayment, byDay, top] = await Promise.all([
      db.one(`SELECT COUNT(*) AS n, COALESCE(SUM(total_cents),0)/100.0 AS total FROM orders WHERE date(created_at) BETWEEN ? AND ?`, ...p),
      db.many(`SELECT status, COUNT(*) AS n, COALESCE(SUM(total_cents),0)/100.0 AS total FROM orders WHERE date(created_at) BETWEEN ? AND ? GROUP BY status ORDER BY total DESC`, ...p),
      db.many(`SELECT payment_method, payment_status, COUNT(*) AS n, COALESCE(SUM(total_cents),0)/100.0 AS total
                 FROM orders WHERE date(created_at) BETWEEN ? AND ? GROUP BY payment_method, payment_status ORDER BY total DESC`, ...p),
      db.many(`SELECT date(created_at) AS day, COUNT(*) AS n, COALESCE(SUM(total_cents),0)/100.0 AS total FROM orders WHERE date(created_at) BETWEEN ? AND ? GROUP BY day ORDER BY day DESC`, ...p),
      db.many(`SELECT COALESCE(pr.name, oi.product_img) AS name, COALESCE(SUM(oi.qty),0) AS units, COALESCE(SUM(oi.qty * oi.price_cents),0)/100.0 AS revenue
                 FROM order_items oi JOIN orders o ON o.id = oi.order_id LEFT JOIN products pr ON pr.img = oi.product_img
                WHERE date(o.created_at) BETWEEN ? AND ? GROUP BY COALESCE(pr.name, oi.product_img) ORDER BY revenue DESC LIMIT 25`, ...p),
    ]);
    return c.json({ from, to, totals: { ...totals, avg_order: totals.n ? totals.total / totals.n : 0 }, by_status: byStatus, by_payment: byPayment, by_day: byDay, top_products: top });
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
                 FROM products WHERE is_active = 1 AND stock_count <= low_threshold ORDER BY stock_count ASC LIMIT 100`),
      db.one(`SELECT COUNT(*) AS n FROM products WHERE is_active = 1 AND stock_count <= 0`),
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
}
