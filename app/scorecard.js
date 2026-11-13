// =============================================================================
//  Vision Auto Solutions -- Owner's daily scorecard (scaling roadmap, Phase 1)
//
//  Mounted by server.js:
//    require('./scorecard').register(app, { query, requireAdmin, requireCap, notify, arOpenSql: AR_OPEN_SQL })
//  Page: scorecard.html. Routes under /api/scorecard (cap growth.view):
//    GET  /api/scorecard?date=YYYY-MM-DD   one day's numbers (default today)
//    GET  /api/scorecard/settings          who gets it and when
//    PUT  /api/scorecard/settings
//    POST /api/scorecard/send              send it now (body: { date? })
//
//  One screen, and one message at closing time, that tells the owner whether
//  the day was good and what needs attention, without opening ten modules:
//    sales      net sales (credit notes and refunds taken off), sales count,
//               average sale, against the same weekday last year and
//               month to date against the same days last year
//    margin     gross profit from item cost (the cost saved on the sale line,
//               else the product's current cost)
//    returns    credit notes (negative sales, the old system's CN numbers)
//               plus refunds through the returns screen, and their share
//    customers  share of sales with a known customer (not CASH / walk-in)
//    payments   share of sales paid other than cash
//    watch      drawer over/short, voids, lost sales, fast sellers out of
//               stock, overdue customer accounts
//
//  Sending: by email and/or SMS through notify.message, at scorecard_send_at
//  (Jamaica time), once a day, when scorecard_enabled is 'on'. Settings live
//  in warehouse_settings (scorecard_*). Read-only on the business data.
// =============================================================================
'use strict';

const TZ = 'America/Jamaica';
const WALKIN_RE = '^(cash|cash sale|cash customer|walk-?in( customer)?|counter|customer)$';
const KEYS = {
  scorecard_enabled: 'off',
  scorecard_send_at: '18:30',
  scorecard_emails: '',
  scorecard_phones: '',
  scorecard_last_sent: '',
};

function register(app, deps) {
  const { query, requireAdmin, requireCap, notify, arOpenSql } = deps;
  const can = (k) => [requireAdmin, requireCap(k)];
  const n = (v) => (v == null ? 0 : Number(v));
  const r2 = (v) => Math.round(n(v) * 100) / 100;
  const pct = (a, b) => (n(b) ? Math.round((n(a) / n(b)) * 1000) / 10 : null);
  const jm = (v) => (n(v) < 0 ? '-' : '') + 'J$' + Math.round(Math.abs(n(v))).toLocaleString('en-US');
  const change = (a, b) => (n(b) ? Math.round(((n(a) - n(b)) / Math.abs(n(b))) * 1000) / 10 : null);

  function httpError(status, msg) { const e = new Error(msg); e.status = status; e.publicMessage = msg; return e; }
  function fail(res, e) { const s = e.status || 500; if (s >= 500) console.error('[scorecard]', e); res.status(s).json({ error: e.publicMessage || e.message }); }

  async function settings() {
    const { rows } = await query(`SELECT key, value FROM warehouse_settings WHERE key = ANY($1)`, [Object.keys(KEYS)]);
    const out = Object.assign({}, KEYS);
    for (const r of rows) if (r.value != null) out[r.key] = r.value;
    return out;
  }
  async function saveSetting(key, value) {
    await query(`INSERT INTO warehouse_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, value]);
  }
  async function today() {
    const { rows } = await query(`SELECT to_char((NOW() AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS d, to_char(NOW() AT TIME ZONE '${TZ}', 'HH24:MI') AS hm`);
    return rows[0];
  }

  // Net sales, counts, returns, customer capture and payment mix between two
  // instants. Credit notes are stored as negative sales; refunds through the
  // returns screen are in pos_sale_returns.
  async function salesBetween(t0, t1) {
    const { rows } = await query(
      `SELECT COALESCE(SUM(total_usd - COALESCE(tax_usd, 0)), 0)::float AS net,
              COALESCE(SUM(total_usd - COALESCE(tax_usd, 0)) FILTER (WHERE total_usd > 0), 0)::float AS gross,
              COALESCE(-SUM(total_usd - COALESCE(tax_usd, 0)) FILTER (WHERE total_usd < 0), 0)::float AS credit_notes,
              COUNT(*) FILTER (WHERE total_usd > 0)::int AS sales,
              COUNT(*) FILTER (WHERE total_usd < 0)::int AS credit_note_count,
              COUNT(*) FILTER (WHERE total_usd > 0 AND customer_id IS NOT NULL
                                 AND COALESCE(customer_name, '') !~* '${WALKIN_RE}'
                                 AND COALESCE(customer_name, '') <> '')::int AS named,
              COALESCE(SUM(total_usd) FILTER (WHERE total_usd > 0 AND LOWER(COALESCE(payment_method, 'cash')) <> 'cash'), 0)::float AS non_cash,
              COALESCE(SUM(total_usd) FILTER (WHERE total_usd > 0), 0)::float AS gross_with_tax
         FROM pos_sales WHERE NOT COALESCE(voided, false) AND created_at >= $1 AND created_at < $2`, [t0, t1]);
    const s = rows[0];
    const { rows: rf } = await query(
      `SELECT COALESCE(SUM(refund_subtotal_usd - COALESCE(refund_discount_usd, 0)), 0)::float AS refunds, COUNT(*)::int AS refund_count
         FROM pos_sale_returns WHERE created_at >= $1 AND created_at < $2`, [t0, t1]);
    s.refunds = n(rf[0].refunds); s.refund_count = rf[0].refund_count;
    s.net = r2(s.net - s.refunds);
    s.returns = r2(s.credit_notes + s.refunds);
    return s;
  }

  async function marginBetween(t0, t1) {
    const { rows } = await query(
      `SELECT COALESCE(SUM(i.total_usd), 0)::float AS revenue,
              COALESCE(SUM(i.qty * COALESCE(NULLIF(i.unit_cost, 0), p.cost_usd)), 0)::float AS cost,
              COALESCE(SUM(i.total_usd) FILTER (WHERE COALESCE(NULLIF(i.unit_cost, 0), p.cost_usd, 0) > 0), 0)::float AS costed_revenue
         FROM pos_sale_items i
         JOIN pos_sales s ON s.id = i.sale_id
         LEFT JOIN products p ON p.id = i.product_id
        WHERE NOT COALESCE(s.voided, false) AND s.created_at >= $1 AND s.created_at < $2`, [t0, t1]);
    const m = rows[0];
    // Margin only over lines with a known cost, so missing costs don't read as profit.
    const costedCost = m.cost;
    return { revenue: r2(m.revenue), gp: r2(m.costed_revenue - costedCost), gp_pct: pct(m.costed_revenue - costedCost, m.costed_revenue),
      cost_coverage_pct: pct(m.costed_revenue, m.revenue) };
  }

  async function compute(dateStr) {
    const t = await today();
    const date = /^\d{4}-\d{2}-\d{2}$/.test(dateStr || '') ? dateStr : t.d;
    const { rows: b } = await query(
      `SELECT ($1::date)::timestamp AT TIME ZONE '${TZ}' AS d0,
              ($1::date + 1)::timestamp AT TIME ZONE '${TZ}' AS d1,
              ($1::date - 364)::timestamp AT TIME ZONE '${TZ}' AS l0,
              ($1::date - 363)::timestamp AT TIME ZONE '${TZ}' AS l1,
              (date_trunc('month', $1::date))::timestamp AT TIME ZONE '${TZ}' AS m0,
              (date_trunc('month', $1::date) - INTERVAL '1 year')::timestamp AT TIME ZONE '${TZ}' AS lm0,
              ($1::date + 1 - INTERVAL '1 year')::timestamp AT TIME ZONE '${TZ}' AS lm1,
              to_char($1::date - 364, 'Dy DD Mon YYYY') AS last_year_label,
              to_char($1::date, 'Dy DD Mon YYYY') AS label`, [date]);
    const B = b[0];
    const [day, lastYear, mtd, lastMtd, margin] = await Promise.all([
      salesBetween(B.d0, B.d1), salesBetween(B.l0, B.l1), salesBetween(B.m0, B.d1), salesBetween(B.lm0, B.lm1), marginBetween(B.d0, B.d1)]);

    const { rows: voids } = await query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(total_usd), 0)::float AS amount FROM pos_sales
        WHERE COALESCE(voided, false) AND COALESCE(voided_at, created_at) >= $1 AND COALESCE(voided_at, created_at) < $2`, [B.d0, B.d1]);
    const { rows: drawers } = await query(
      `SELECT id, opened_at, closed_at, variance::float AS variance FROM cash_drawer_sessions
        WHERE closed_at >= $1 AND closed_at < $2 ORDER BY closed_at`, [B.d0, B.d1]);
    const { rows: lost } = await query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(qty * COALESCE(unit_price, 0)), 0)::float AS value FROM lost_sales
        WHERE created_at >= $1 AND created_at < $2`, [B.d0, B.d1]);
    // Fast sellers (sold at least 3 times in the last 90 days) with nothing on the shelf.
    const { rows: outs } = await query(
      `SELECT p.id, p.name, p.sku, x.sold::int AS sold_90d, x.revenue::float AS revenue_90d, COUNT(*) OVER ()::int AS total
         FROM products p
         JOIN (SELECT i.product_id, SUM(i.qty) AS sold, SUM(i.total_usd) AS revenue, COUNT(DISTINCT i.sale_id) AS sales
                 FROM pos_sale_items i JOIN pos_sales s ON s.id = i.sale_id
                WHERE NOT COALESCE(s.voided, false) AND s.created_at >= $1::timestamptz - INTERVAL '90 days' AND s.created_at < $1 AND i.qty > 0
                GROUP BY i.product_id) x ON x.product_id = p.id
        WHERE COALESCE(p.is_active, true) AND COALESCE(p.stock_count, 0) <= 0 AND x.sales >= 3
        ORDER BY x.revenue DESC LIMIT 20`, [B.d1]);
    let overdue = { amount: 0, customers: 0, over_60: 0 };
    if (arOpenSql) {
      const { rows: od } = await query(
        `SELECT COALESCE(SUM(open), 0)::float AS amount, COUNT(DISTINCT customer_id)::int AS customers,
                COALESCE(SUM(open) FILTER (WHERE $1::date - COALESCE(due_date, created_at::date) > 60), 0)::float AS over_60
           FROM (SELECT o.*, GREATEST(o.charged - o.settled, 0) AS open FROM (${arOpenSql}) o WHERE o.charged - o.settled > 0.005) z
          WHERE COALESCE(due_date, created_at::date) < $1::date`, [date]);
      overdue = od[0];
    }

    const drawerShort = drawers.filter((d) => Math.abs(n(d.variance)) >= 100);
    const out = {
      date, label: B.label, last_year_label: B.last_year_label,
      sales: {
        net: r2(day.net), count: day.sales, avg: day.sales ? r2(day.gross / day.sales) : 0,
        last_year: r2(lastYear.net), vs_last_year_pct: change(day.net, lastYear.net),
        mtd: r2(mtd.net), last_year_mtd: r2(lastMtd.net), mtd_vs_last_year_pct: change(mtd.net, lastMtd.net),
      },
      margin,
      returns: { amount: day.returns, credit_notes: day.credit_note_count, refunds: day.refund_count, pct_of_gross: pct(day.returns, day.gross),
        mtd_pct_of_gross: pct(mtd.returns, mtd.gross) },
      customers: { named_pct: pct(day.named, day.sales), mtd_named_pct: pct(mtd.named, mtd.sales) },
      payments: { non_cash_pct: pct(day.non_cash, day.gross_with_tax) },
      watch: {
        voids: voids[0], drawers: drawers.length, drawer_issues: drawerShort,
        lost_sales: lost[0], out_of_stock_fast_sellers: outs.length ? outs[0].total : 0, out_of_stock_top: outs.slice(0, 5),
        overdue,
      },
    };
    out.alerts = alerts(out);
    return out;
  }

  function alerts(s) {
    const a = [];
    if (s.sales.vs_last_year_pct != null && s.sales.vs_last_year_pct <= -10) a.push(`Sales ${s.sales.vs_last_year_pct}% on the same day last year`);
    if (s.sales.mtd_vs_last_year_pct != null && s.sales.mtd_vs_last_year_pct <= -5) a.push(`Month to date ${s.sales.mtd_vs_last_year_pct}% on last year`);
    if (s.returns.pct_of_gross != null && s.returns.pct_of_gross >= 15) a.push(`Returns ${s.returns.pct_of_gross}% of sales`);
    if (s.margin.gp_pct != null && s.margin.gp_pct < 30) a.push(`Margin ${s.margin.gp_pct}%`);
    for (const d of s.watch.drawer_issues) a.push(`Drawer ${n(d.variance) < 0 ? 'short' : 'over'} ${jm(Math.abs(d.variance))}`);
    if (s.watch.voids.n >= 3) a.push(`${s.watch.voids.n} voided sales`);
    if (s.watch.out_of_stock_fast_sellers) a.push(`${s.watch.out_of_stock_fast_sellers} fast sellers out of stock`);
    if (n(s.watch.overdue.over_60) > 0) a.push(`${jm(s.watch.overdue.over_60)} owed over 60 days`);
    return a;
  }

  function asText(s, shopName) {
    const p = (v) => (v == null ? 'n/a' : (v > 0 ? '+' : '') + v + '%');
    const L = [];
    L.push(`${shopName || 'Vision Auto'} daily scorecard, ${s.label}`);
    L.push('');
    L.push(`Sales ${jm(s.sales.net)} from ${s.sales.count} sales (avg ${jm(s.sales.avg)})`);
    L.push(`Same day last year ${jm(s.sales.last_year)} (${p(s.sales.vs_last_year_pct)})`);
    L.push(`Month to date ${jm(s.sales.mtd)} vs ${jm(s.sales.last_year_mtd)} last year (${p(s.sales.mtd_vs_last_year_pct)})`);
    L.push(`Margin ${s.margin.gp_pct == null ? 'n/a' : s.margin.gp_pct + '%'} (${jm(s.margin.gp)} gross profit)`);
    L.push(`Returns ${jm(s.returns.amount)} (${s.returns.pct_of_gross == null ? 'n/a' : s.returns.pct_of_gross + '%'} of sales)`);
    L.push(`Known customers ${s.customers.named_pct == null ? 'n/a' : s.customers.named_pct + '%'}, paid other than cash ${s.payments.non_cash_pct == null ? 'n/a' : s.payments.non_cash_pct + '%'}`);
    L.push(`Lost sales ${s.watch.lost_sales.n} (${jm(s.watch.lost_sales.value)}), voids ${s.watch.voids.n}`);
    L.push(`Fast sellers out of stock ${s.watch.out_of_stock_fast_sellers}`);
    L.push(`Overdue accounts ${jm(s.watch.overdue.amount)} from ${s.watch.overdue.customers} customers`);
    if (s.alerts.length) { L.push(''); L.push('Needs attention:'); for (const x of s.alerts) L.push('- ' + x); }
    return L.join('\n');
  }
  function asSms(s) {
    const p = (v) => (v == null ? '' : ` (${v > 0 ? '+' : ''}${v}% LY)`);
    return `Vision ${s.date}: sales ${jm(s.sales.net)}${p(s.sales.vs_last_year_pct)}, MTD ${jm(s.sales.mtd)}${p(s.sales.mtd_vs_last_year_pct)}, ` +
      `margin ${s.margin.gp_pct == null ? 'n/a' : s.margin.gp_pct + '%'}, returns ${jm(s.returns.amount)}` +
      (s.alerts.length ? '. Check: ' + s.alerts.slice(0, 3).join('; ') : '');
  }

  async function send(date, byUser) {
    const st = await settings();
    const s = await compute(date);
    const emails = st.scorecard_emails.split(/[,;\s]+/).filter(Boolean);
    const phones = st.scorecard_phones.split(/[,;]+/).map((x) => x.trim()).filter(Boolean);
    if (!emails.length && !phones.length) throw httpError(400, 'Add an email address or phone number to send the scorecard to');
    const results = [];
    const text = asText(s);
    for (const to of emails) results.push(await notify.message({ channel: 'email', to, subject: `Daily scorecard ${s.label}`, text, event: 'owner_scorecard', by_user: byUser }));
    for (const to of phones) results.push(await notify.message({ channel: 'sms', to, text: asSms(s), event: 'owner_scorecard', by_user: byUser }));
    return { scorecard: s, results: results.map((r) => ({ channel: r.channel, to: r.to_addr, status: r.status, reason: r.reason })) };
  }

  // ------------------------------------------------------------- routes --
  app.get('/api/scorecard', ...can('growth.view'), async (req, res) => {
    try { const s = await compute(req.query.date); s.text = asText(s); res.json(s); } catch (e) { fail(res, e); }
  });
  app.get('/api/scorecard/settings', ...can('growth.view'), async (_req, res) => {
    try { res.json(await settings()); } catch (e) { fail(res, e); }
  });
  app.put('/api/scorecard/settings', ...can('growth.view'), async (req, res) => {
    try {
      const b = req.body || {};
      if (b.scorecard_enabled != null) await saveSetting('scorecard_enabled', b.scorecard_enabled === 'on' || b.scorecard_enabled === true ? 'on' : 'off');
      if (b.scorecard_send_at != null) {
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(b.scorecard_send_at))) throw httpError(400, 'Send time must be HH:MM');
        await saveSetting('scorecard_send_at', String(b.scorecard_send_at));
      }
      if (b.scorecard_emails != null) await saveSetting('scorecard_emails', String(b.scorecard_emails).slice(0, 500));
      if (b.scorecard_phones != null) await saveSetting('scorecard_phones', String(b.scorecard_phones).slice(0, 300));
      res.json(await settings());
    } catch (e) { fail(res, e); }
  });
  app.post('/api/scorecard/send', ...can('growth.view'), async (req, res) => {
    try { const r = await send((req.body || {}).date, req.user && req.user.id); res.json({ ok: true, results: r.results }); } catch (e) { fail(res, e); }
  });

  // -------------------------------------------------------- daily send --
  let busy = false;
  async function tick() {
    if (busy) return; busy = true;
    try {
      const st = await settings();
      if (st.scorecard_enabled !== 'on') return;
      const t = await today();
      if (t.hm < st.scorecard_send_at || st.scorecard_last_sent === t.d) return;
      await saveSetting('scorecard_last_sent', t.d);   // first, so a failure can't send twice
      await send(t.d, null);
    } catch (e) { console.error('[scorecard] daily send', e.message || e); } finally { busy = false; }
  }
  if (!deps.noTimer) { const h = setInterval(tick, 60 * 1000); if (h.unref) h.unref(); }

  return { compute, asText, asSms, send, tick };
}

module.exports = { register };
