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
}
