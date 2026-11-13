// =============================================================================
//  Vision Auto Solutions -- Owner controls: exception alerts and purchase
//  order approvals (scaling roadmap, Phase 5: run without the owner)
//
//  Mounted by server.js BEFORE inbound.js (so the PO guard runs first):
//    require('./owner-controls').register(app, { query, requireAdmin, requireManager, requireCap, userCan, notify })
//  Page: owner-controls.html. Routes under /api/owner (cap growth.view;
//  approving a PO needs purchasing.approve_po).
//
//  Exception alerts. Every 2 minutes, anything unusual since the last look is
//  collected and sent as one message (SMS and/or email) to the owner:
//    voided sales             at or over alert_void_jmd
//    refunds                  at or over alert_refund_jmd
//    big discounts            a sale discounted alert_discount_pct or more
//    price cut at the till    a line price lowered alert_price_cut_pct or more
//    drawer over / short      at or over alert_drawer_jmd
//    hand stock adjustments   stock changed outside a sale, receipt or return,
//                             worth alert_adjust_jmd or more at cost
//    cash paid out            at or over alert_payout_jmd
//    POs waiting for approval
//  All of them are kept in owner_alerts so the page shows the history.
//
//  PO approvals. A purchase order whose total is at or over
//  po_approval_over (J$; 0 = switched off) cannot be marked ordered/sent until
//  someone with purchasing.approve_po approves it. Their own POs pass straight
//  through (and are recorded as approved by them). A PO changed after approval
//  so its total goes up needs approving again.
// =============================================================================
'use strict';

const TZ = 'America/Jamaica';
const SETTINGS = {
  alerts_enabled: 'off', alerts_emails: '', alerts_phones: '',
  alert_void_jmd: '5000', alert_refund_jmd: '5000', alert_discount_pct: '15', alert_price_cut_pct: '20',
  alert_drawer_jmd: '500', alert_adjust_jmd: '10000', alert_payout_jmd: '10000',
  alerts_cursor: '', po_approval_over: '0',
};
const KINDS = { void: 'Voided sale', refund: 'Refund', discount: 'Big discount', price_cut: 'Price cut at the till', drawer: 'Drawer over/short',
  adjust: 'Stock adjusted by hand', payout: 'Cash paid out', po_approval: 'PO waiting for approval' };

function register(app, deps) {
  const { query, requireAdmin, requireCap, userCan, notify } = deps;
  const can = (k) => [requireAdmin, requireCap(k)];
  // The approvals list and settings page open for owners (growth.view) and for PO approvers.
  const eitherCap = [requireAdmin, async (req, res, next) => {
    try {
      if (await userCan(req, 'growth.view') || await userCan(req, 'purchasing.approve_po')) return next();
      res.status(403).json({ error: 'Your account is not allowed to see owner controls.' });
    } catch (e) { next(e); }
  }];
  const n = (v) => (v == null ? 0 : Number(v));
  const jm = (v) => (n(v) < 0 ? '-' : '') + 'J$' + Math.round(Math.abs(n(v))).toLocaleString('en-US');
  function httpError(status, msg) { const e = new Error(msg); e.status = status; e.publicMessage = msg; return e; }
  function fail(res, e) { const s = e.status || 500; if (s >= 500) console.error('[owner]', e); res.status(s).json({ error: e.publicMessage || e.message }); }
  const uid = (req) => (req.session && req.session.userId) || (req.user && req.user.id) || null;

  // Created on first use, not at startup: DDL during the boot-time schema.sql
  // apply can deadlock it (it did on 2026-11-05).
  let readyP = null;
  const ready = () => readyP || (readyP = query(
    `CREATE TABLE IF NOT EXISTS owner_alerts (
       id         BIGSERIAL PRIMARY KEY,
       kind       TEXT NOT NULL,
       ref        TEXT NOT NULL,
       amount     NUMERIC(14,2),
       text       TEXT NOT NULL,
       happened_at TIMESTAMPTZ,
       sent       BOOLEAN NOT NULL DEFAULT false,
       created_at TIMESTAMPTZ DEFAULT NOW(),
       UNIQUE (kind, ref));
     CREATE TABLE IF NOT EXISTS po_approvals (
       id          SERIAL PRIMARY KEY,
       po_id       INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
       status      TEXT NOT NULL,              -- requested | approved | rejected
       total       NUMERIC(14,2),
       requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
       decided_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
       note        TEXT,
       created_at  TIMESTAMPTZ DEFAULT NOW(),
       decided_at  TIMESTAMPTZ);
     CREATE INDEX IF NOT EXISTS idx_po_approvals_po ON po_approvals (po_id, created_at DESC);`)
    .catch((e) => { readyP = null; console.error('[owner] tables', e.message); }));

  async function settings() {
    const { rows } = await query(`SELECT key, value FROM warehouse_settings WHERE key = ANY($1) OR key IN ('scorecard_emails', 'scorecard_phones')`, [Object.keys(SETTINGS)]);
    const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    const out = {};
    for (const k of Object.keys(SETTINGS)) out[k] = m[k] != null && m[k] !== '' ? m[k] : SETTINGS[k];
    out.scorecard_emails = m.scorecard_emails || ''; out.scorecard_phones = m.scorecard_phones || '';
    return out;
  }
  async function save(key, value) {
    await query(`INSERT INTO warehouse_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, String(value)]);
  }

  // ----------------------------------------------------------- PO totals --
  async function poTotal(id) {
    const { rows } = await query(
      `SELECT po.id, po.po_number, po.status, s.name AS supplier,
              COALESCE(NULLIF(po.total_usd, 0), (SELECT SUM(COALESCE(i.total_usd, COALESCE(i.qty_ordered, i.qty, 0) * i.unit_cost_usd)) FROM purchase_order_items i WHERE i.po_id = po.id), 0)::float AS total
         FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id WHERE po.id = $1`, [id]);
    return rows[0] || null;
  }
  async function lastApproval(id) {
    const { rows } = await query(`SELECT * FROM po_approvals WHERE po_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [id]);
    return rows[0] || null;
  }

  // Runs in front of the two ways a PO is sent: inbound's mark-ordered and the
  // PO edit screen setting the status to sent/ordered.
  async function poGuard(req, res, next) {
    try {
      if (req.method === 'PATCH' && !['sent', 'ordered'].includes(req.body && req.body.status)) return next();
      await ready();
      const limit = n((await settings()).po_approval_over);
      if (!(limit > 0)) return next();
      const po = await poTotal(Number(req.params.id) || 0);
      if (!po || po.total < limit) return next();
      const last = await lastApproval(po.id);
      if (last && last.status === 'approved' && n(last.total) + 0.005 >= po.total) return next();
      if (await userCan(req, 'purchasing.approve_po')) {
        await query(`INSERT INTO po_approvals (po_id, status, total, requested_by, decided_by, decided_at, note) VALUES ($1, 'approved', $2, $3, $3, NOW(), 'Approved by sending it')`, [po.id, po.total, uid(req)]);
        return next();
      }
      if (!last || last.status !== 'requested' || n(last.total) + 0.005 < po.total) {
        await query(`INSERT INTO po_approvals (po_id, status, total, requested_by) VALUES ($1, 'requested', $2, $3)`, [po.id, po.total, uid(req)]);
      }
      return res.status(409).json({ error: `${po.po_number} is ${jm(po.total)}, over the ${jm(limit)} limit. It has been sent for approval; you can send it once it is approved.`, needs_approval: true });
    } catch (e) { fail(res, e); }
  }
  // Same sign-in checks as the routes they guard, so nobody signed out (or not
  // allowed to order) can file approval requests.
  app.post('/api/inb/po/:id/mark-ordered', requireAdmin, requireCap('purchasing.create_po'), poGuard);
  app.patch('/api/admin/purchase-orders/:id', deps.requireManager || requireAdmin, poGuard);

  app.get('/api/owner/po-approvals', ...eitherCap, async (_req, res) => {
    try {
      await ready();
      const { rows } = await query(
        `SELECT DISTINCT ON (a.po_id) a.*, po.po_number, po.status AS po_status, s.name AS supplier, u.name AS requested_by_name, d.name AS decided_by_name
           FROM po_approvals a JOIN purchase_orders po ON po.id = a.po_id LEFT JOIN suppliers s ON s.id = po.supplier_id
           LEFT JOIN users u ON u.id = a.requested_by LEFT JOIN users d ON d.id = a.decided_by
          WHERE a.created_at >= NOW() - INTERVAL '60 days'
          ORDER BY a.po_id, a.created_at DESC, a.id DESC`);
      rows.sort((x, y) => (x.status === 'requested' ? 0 : 1) - (y.status === 'requested' ? 0 : 1) || new Date(y.created_at) - new Date(x.created_at));
      res.json({ approvals: rows });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/owner/po-approvals/:poId/:decision', ...can('purchasing.approve_po'), async (req, res) => {
    try {
      await ready();
      const decision = req.params.decision === 'approve' ? 'approved' : req.params.decision === 'reject' ? 'rejected' : null;
      if (!decision) throw httpError(400, 'Approve or reject?');
      const po = await poTotal(Number(req.params.poId) || 0);
      if (!po) throw httpError(404, 'PO not found');
      await query(`INSERT INTO po_approvals (po_id, status, total, decided_by, decided_at, note) VALUES ($1, $2, $3, $4, NOW(), $5)`,
        [po.id, decision, po.total, uid(req), String((req.body || {}).note || '').slice(0, 300) || null]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------------- alerts --
  async function collect(since, st) {
    const out = [];
    const add = (kind, ref, amount, text, at) => out.push({ kind, ref: String(ref), amount, text, at });
    const q = async (sql, params) => { try { return (await query(sql, params)).rows; } catch (e) { console.error('[owner] alert query', kind0, e.message); return []; } };
    let kind0;
    kind0 = 'void';
    for (const r of await q(`SELECT s.id, s.receipt_number, s.total_usd::float AS total, s.voided_at, COALESCE(u.name, s.cashier_name) AS who
                               FROM pos_sales s LEFT JOIN users u ON u.id = s.voided_by
                              WHERE COALESCE(s.voided, false) AND s.voided_at > $1 AND ABS(s.total_usd) >= $2`, [since, n(st.alert_void_jmd)]))
      add('void', r.id, r.total, `Voided ${r.receipt_number || 'sale'} ${jm(r.total)}${r.who ? ' by ' + r.who : ''}`, r.voided_at);
    kind0 = 'refund';
    for (const r of await q(`SELECT x.id, x.return_number, x.refund_total_usd::float AS total, x.refund_method, x.reason, x.created_at, u.name AS who
                               FROM pos_sale_returns x LEFT JOIN users u ON u.id = x.processed_by
                              WHERE x.created_at > $1 AND x.refund_total_usd >= $2`, [since, n(st.alert_refund_jmd)]))
      add('refund', r.id, r.total, `Refund ${r.return_number || ''} ${jm(r.total)} (${r.refund_method}${r.reason ? ', ' + r.reason : ''})${r.who ? ' by ' + r.who : ''}`, r.created_at);
    kind0 = 'discount';
    for (const r of await q(`SELECT id, receipt_number, discount_usd::float AS disc, (subtotal_usd + discount_usd)::float AS before, cashier_name, created_at
                               FROM pos_sales WHERE created_at > $1 AND NOT COALESCE(voided, false) AND discount_usd >= 1000
                                AND discount_usd * 100 >= $2 * NULLIF(subtotal_usd + discount_usd, 0)`, [since, n(st.alert_discount_pct)]))
      add('discount', r.id, r.disc, `Discount ${jm(r.disc)} (${Math.round(r.disc / r.before * 100)}%) on ${r.receipt_number}${r.cashier_name ? ' by ' + r.cashier_name : ''}`, r.created_at);
    kind0 = 'price_cut';
    for (const r of await q(`SELECT id, name, user_name, value_before::float AS b, value_after::float AS a, COALESCE(amount, (value_before - value_after) * COALESCE(qty, 1))::float AS amt, at
                               FROM pos_events WHERE kind = 'price_changed' AND at > $1 AND value_before > 0 AND value_after < value_before * (1 - $2 / 100.0)`, [since, n(st.alert_price_cut_pct)]))
      add('price_cut', r.id, r.amt, `Price cut on ${r.name || 'a part'}: ${jm(r.b)} to ${jm(r.a)}${r.user_name ? ' by ' + r.user_name : ''}`, r.at);
    kind0 = 'drawer';
    for (const r of await q(`SELECT id, variance::float AS v, closed_at FROM cash_drawer_sessions WHERE closed_at > $1 AND ABS(COALESCE(variance, 0)) >= $2`, [since, n(st.alert_drawer_jmd)]))
      add('drawer', r.id, r.v, `Drawer ${r.v < 0 ? 'short' : 'over'} ${jm(Math.abs(r.v))} at close`, r.closed_at);
    kind0 = 'adjust';
    for (const r of await q(`SELECT l.id, l.delta, (l.delta * COALESCE(l.unit_cost, p.cost_usd, 0))::float AS value, COALESCE(p.name, l.product_img) AS name, l.reason, l.created_at
                               FROM stock_ledger l LEFT JOIN products p ON p.img = l.product_img
                              WHERE l.created_at > $1 AND (l.reason IS NULL OR l.reason IN ('count', 'manual', 'adjust'))
                                AND ABS(l.delta * COALESCE(l.unit_cost, p.cost_usd, 0)) >= $2`, [since, n(st.alert_adjust_jmd)]))
      add('adjust', r.id, r.value, `Stock ${r.delta > 0 ? '+' : ''}${r.delta} on ${r.name} (${jm(r.value)} at cost${r.reason ? ', ' + r.reason : ', by hand'})`, r.created_at);
    kind0 = 'payout';
    for (const r of await q(`SELECT id, (amount_cents / 100.0)::float AS amt, reason, paid_to, created_at FROM cash_payouts
                              WHERE created_at > $1 AND NOT COALESCE(voided, false) AND amount_cents >= $2 * 100`, [since, n(st.alert_payout_jmd)]))
      add('payout', r.id, r.amt, `Cash paid out ${jm(r.amt)}${r.paid_to ? ' to ' + r.paid_to : ''}${r.reason ? ' (' + r.reason + ')' : ''}`, r.created_at);
    kind0 = 'po_approval';
    for (const r of await q(`SELECT a.id, a.total::float AS total, po.po_number, s.name AS supplier, a.created_at FROM po_approvals a
                               JOIN purchase_orders po ON po.id = a.po_id LEFT JOIN suppliers s ON s.id = po.supplier_id
                              WHERE a.status = 'requested' AND a.created_at > $1`, [since]))
      add('po_approval', r.id, r.total, `${r.po_number} to ${r.supplier || 'supplier'} for ${jm(r.total)} is waiting for your approval`, r.created_at);
    return out;
  }

  async function run(opts) {
    await ready();
    const st = await settings();
    const { rows: nowRow } = await query(`SELECT NOW() AS now`);
    const now = nowRow[0].now;
    // First run looks back one hour, never further.
    const since = st.alerts_cursor ? new Date(Math.max(Date.parse(st.alerts_cursor), Date.now() - 24 * 3600e3)) : new Date(Date.now() - 3600e3);
    const found = await collect(since, st);
    await save('alerts_cursor', new Date(now).toISOString());
    const fresh = [];
    for (const a of found) {
      const { rows } = await query(`INSERT INTO owner_alerts (kind, ref, amount, text, happened_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (kind, ref) DO NOTHING RETURNING id`,
        [a.kind, a.ref, a.amount, a.text, a.at]);
      if (rows[0]) fresh.push(Object.assign(a, { id: rows[0].id }));
    }
    if (!fresh.length || (st.alerts_enabled !== 'on' && !(opts && opts.force))) return { found: fresh.length, sent: 0 };
    const emails = (st.alerts_emails || st.scorecard_emails).split(/[,;\s]+/).filter(Boolean);
    const phones = (st.alerts_phones || st.scorecard_phones).split(/[,;]+/).map((x) => x.trim()).filter(Boolean);
    const lines = fresh.slice(0, 6).map((a) => '- ' + a.text);
    if (fresh.length > 6) lines.push(`- and ${fresh.length - 6} more on the Owner controls page`);
    const text = `Vision alert${fresh.length > 1 ? 's' : ''}:\n` + lines.join('\n');
    let sent = 0;
    for (const to of emails) { await notify.message({ channel: 'email', to, subject: `Vision: ${fresh.length} thing${fresh.length > 1 ? 's' : ''} to check`, text, event: 'owner_alert' }); sent++; }
    for (const to of phones) { await notify.message({ channel: 'sms', to, text: text.slice(0, 600), event: 'owner_alert' }); sent++; }
    if (sent) await query(`UPDATE owner_alerts SET sent = true WHERE id = ANY($1)`, [fresh.map((a) => a.id)]);
    return { found: fresh.length, sent };
  }

  app.get('/api/owner/alerts', ...can('growth.view'), async (req, res) => {
    try {
      await ready();
      const { rows } = await query(`SELECT * FROM owner_alerts ORDER BY COALESCE(happened_at, created_at) DESC LIMIT 200`);
      res.json({ alerts: rows.map((r) => Object.assign(r, { kind_label: KINDS[r.kind] || r.kind })) });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/owner/alerts/check', ...can('growth.view'), async (_req, res) => {
    try { res.json(await run({ force: false })); } catch (e) { fail(res, e); }
  });
  app.get('/api/owner/settings', ...eitherCap, async (_req, res) => {
    try { const s = await settings(); delete s.alerts_cursor; res.json(s); } catch (e) { fail(res, e); }
  });
  app.put('/api/owner/settings', ...can('growth.view'), async (req, res) => {
    try {
      const b = req.body || {};
      const cur = await settings();
      if (b.po_approval_over != null && n(b.po_approval_over) !== n(cur.po_approval_over) && !(await userCan(req, 'purchasing.approve_po')))
        throw httpError(403, 'Only someone who approves POs can change the approval limit');
      const todo = [];
      for (const k of Object.keys(SETTINGS)) {
        if (b[k] == null || k === 'alerts_cursor') continue;
        if (k === 'alerts_enabled') { todo.push([k, b[k] === 'on' ? 'on' : 'off']); continue; }
        if (k === 'alerts_emails' || k === 'alerts_phones') { todo.push([k, String(b[k]).slice(0, 400)]); continue; }
        const v = Number(b[k]);
        if (!Number.isFinite(v) || v < 0 || v > 1e9) throw httpError(400, k.replace(/_/g, ' ') + ' must be a number');
        todo.push([k, v]);
      }
      for (const [k, v] of todo) await save(k, v);
      const s = await settings(); delete s.alerts_cursor; res.json(s);
    } catch (e) { fail(res, e); }
  });

  let busy = false;
  async function tick() { if (busy) return; busy = true; try { await run(); } catch (e) { console.error('[owner] alerts', e.message || e); } finally { busy = false; } }
  if (!deps.noTimer) { const h = setInterval(tick, 120 * 1000); if (h.unref) h.unref(); }

  return { run, poGuard, KINDS };
}

module.exports = { register };
