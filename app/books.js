'use strict';
// =============================================================================
//  Vision Auto Solutions -- receivables, payables and banking (QuickBooks-style)
//
//  Receivables  customer centre (balances, aging, credit), Receive Payment
//               applied to chosen invoices (left-over = credit on the account,
//               applied later), void, credit hold (the till refuses a charge),
//               collections notes and reminders.
//  Payables     supplier centre; unpaid bills of every kind (confirmed goods
//               receipts, PO invoices, expense bills entered here) and vendor
//               credits; Pay Bills (one payment, several bills, credits used);
//               void; aging.
//  Banking      bank and cash accounts with their register (from the ledger),
//               write cheque / spend money, receive money, transfer, Make
//               Deposits from Undeposited Funds, reconcile, statement import
//               with matching and rules.
//  QuickBooks   import of the supplier list, unpaid bills and bank registers
//               exported from QuickBooks, each previewed before it is added.
//
//  Documents are posted to the general ledger by gl.js (ap_bill, ap_payment,
//  bank_txn, account_payment, and a reversal for each void); glPost() runs the
//  poster straight after a save so registers show the entry at once.
// =============================================================================
const crypto = require('crypto');

function register(app, deps) {
  const { query, getPool, requireAdmin, requireCap, mailer, glPost, getShop, arOpenSql } = deps;
  const can = (k) => [requireAdmin, requireCap(k)];
  const n = (v) => (v == null || v === '' ? 0 : Number(v));
  const r2 = (v) => Math.round(n(v) * 100) / 100;
  const money = (v) => (r2(v) < 0 ? '-' : '') + 'J$' + Math.abs(r2(v)).toLocaleString('en-JM', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !isNaN(Date.parse(v));
  const today = () => new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10);
  function httpError(status, msg) { const e = new Error(msg); e.status = status; e.publicMessage = msg; return e; }
  function fail(res, e) { const s = e.status || 500; if (s >= 500) console.error('[books]', e); res.status(s).json({ error: e.publicMessage || e.message }); }
  async function tx(fn) {
    const c = await getPool().connect();
    try { await c.query('BEGIN'); const out = await fn(c); await c.query('COMMIT'); return out; }
    catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} throw e; }
    finally { c.release(); }
  }
  // Post to the ledger now (best effort: the ledger's own timer posts it anyway).
  async function post() {
    if (!glPost) return;
    for (let i = 0; i < 8; i++) {
      try { const r = await glPost(); if (!r || !r.busy) return r; } catch (e) { console.warn('[books] post', e.message); return null; }
      await new Promise((ok) => setTimeout(ok, 400));   // another run is posting: wait for it
    }
    return null;
  }

  // ----------------------------------------------------------- accounts --
  const MONEY_KEYS = ['cash_safe', 'cheques', 'card_clearing', 'cash_drawers'];
  async function account(id) {
    const { rows } = await query(`SELECT id, code, name, type, qb_type, system_key, is_active FROM gl_accounts WHERE id = $1`, [parseInt(id, 10) || 0]);
    return rows[0] || null;
  }
  const isBank = (a) => !!(a && a.is_active && (a.qb_type === 'BANK' || MONEY_KEYS.includes(a.system_key)));
  async function bankAccount(id) {
    const a = await account(id);
    if (!isBank(a)) throw httpError(400, 'Choose a bank or cash account');
    return a;
  }
  async function lineAccount(id) {
    const a = await account(id);
    if (!a || !a.is_active) throw httpError(400, 'Choose an account for every line');
    if (['ar', 'ap'].includes(a.system_key) || ['AR', 'AP'].includes(a.qb_type)) throw httpError(400, 'Use Receive Payment or Pay Bills for customer and supplier balances, not ' + a.name);
    return a;
  }
  // A line's class (QuickBooks class, gl_classes): blank for none, else an active class.
  async function classId(v) {
    if (v == null || v === '') return null;
    const { rows } = await query(`SELECT id FROM gl_classes WHERE id = $1 AND is_active`, [parseInt(v, 10) || 0]);
    if (!rows.length) throw httpError(400, 'Choose an active class (or none)');
    return rows[0].id;
  }
  // Shop name and address for printed statements, cheques and deposit slips.
  app.get('/api/books/shop', requireAdmin, async (req, res) => {
    try { const s = (await getShop()) || {}; res.json({ name: s.name || 'Vision Auto Solutions', address: s.address || '', phone: s.phone || '', email: s.email || '' }); } catch (e) { fail(res, e); }
  });
  app.get('/api/books/accounts', requireAdmin, async (req, res) => {
    try {
      const { rows } = await query(`SELECT id, code, name, type, qb_type, system_key FROM gl_accounts WHERE is_active ORDER BY code`);
      res.json({ accounts: rows.map((a) => Object.assign(a, { bank: isBank(Object.assign({ is_active: true }, a)), ar_ap: ['ar', 'ap'].includes(a.system_key) || ['AR', 'AP'].includes(a.qb_type) })) });
    } catch (e) { fail(res, e); }
  });

  // ======================================================== RECEIVABLES ==
  const AR = can('ar.manage');
  // Per customer: payment money not used on any invoice (a credit on the account).
  // A payment from before this module, never applied but referencing one of the
  // customer's receipts, already settled that invoice (the old rule) -- not credit.
  const CREDIT_SQL = `
    SELECT ap.customer_id,
           SUM(GREATEST(ap.amount_usd - COALESCE(x.applied, 0)
                 - CASE WHEN x.applied IS NULL AND EXISTS (SELECT 1 FROM pos_sales s WHERE s.receipt_number = ap.reference AND s.customer_id = ap.customer_id) THEN ap.amount_usd ELSE 0 END, 0)) AS credit
      FROM account_payments ap
      LEFT JOIN (SELECT payment_id, SUM(amount) AS applied FROM ar_applications GROUP BY payment_id) x ON x.payment_id = ap.id
     GROUP BY ap.customer_id`;
  const OPEN_SQL = `SELECT o.*, GREATEST(o.charged - o.settled, 0) AS open FROM (${arOpenSql}) o WHERE o.charged - o.settled > 0.005`;

  app.get('/api/ar/customers', ...AR, async (req, res) => {
    try {
      const q = String(req.query.q || '').trim().slice(0, 60), f = String(req.query.filter || '');
      const { rows } = await query(
        `WITH inv AS (SELECT customer_id, SUM(open) AS open, SUM(open) FILTER (WHERE COALESCE(due_date, created_at::date) < CURRENT_DATE) AS overdue,
                             MAX(CURRENT_DATE - COALESCE(due_date, created_at::date)) AS oldest, COUNT(*)::int AS invoices
                        FROM (${OPEN_SQL}) z WHERE customer_id IS NOT NULL GROUP BY customer_id),
              cr AS (${CREDIT_SQL})
         SELECT u.id, COALESCE(NULLIF(u.name, ''), u.email) AS name, u.account_number, u.phone, u.credit_limit_usd::float AS credit_limit, u.payment_terms_days,
                u.credit_hold, COALESCE(inv.open, 0)::float AS open, COALESCE(inv.overdue, 0)::float AS overdue, GREATEST(COALESCE(inv.oldest, 0), 0)::int AS oldest_days,
                COALESCE(inv.invoices, 0) AS invoices, COALESCE(cr.credit, 0)::float AS credit,
                (COALESCE(inv.open, 0) - COALESCE(cr.credit, 0))::float AS balance,
                (SELECT MAX(created_at) FROM ar_notes nn WHERE nn.customer_id = u.id) AS last_note
           FROM users u LEFT JOIN inv ON inv.customer_id = u.id LEFT JOIN cr ON cr.customer_id = u.id
          WHERE NOT u.is_staff AND NOT COALESCE(u.is_admin, false)
            AND ($1 = '' OR u.name ILIKE '%' || $1 || '%' OR u.account_number ILIKE $1 || '%' OR regexp_replace(COALESCE(u.phone, ''), '[^0-9]', '', 'g') LIKE '%' || NULLIF(regexp_replace($1, '[^0-9]', '', 'g'), '') || '%')
            AND ($1 <> '' OR COALESCE(inv.open, 0) > 0.005 OR COALESCE(cr.credit, 0) > 0.005 OR u.credit_hold)
            AND ($2 = '' OR ($2 = 'overdue' AND COALESCE(inv.overdue, 0) > 0.005) OR ($2 = 'hold' AND u.credit_hold) OR ($2 = 'credit' AND COALESCE(cr.credit, 0) > 0.005)
                 OR ($2 = 'over_limit' AND u.credit_limit_usd IS NOT NULL AND COALESCE(inv.open, 0) - COALESCE(cr.credit, 0) > u.credit_limit_usd))
          ORDER BY COALESCE(inv.overdue, 0) DESC, COALESCE(inv.open, 0) DESC LIMIT 300`, [q, f]);
      for (const r of rows) { r.open = r2(r.open); r.overdue = r2(r.overdue); r.credit = r2(r.credit); r.balance = r2(r.balance); }
      const tot = rows.reduce((t, r) => ({ open: t.open + r.open, overdue: t.overdue + r.overdue, credit: t.credit + r.credit }), { open: 0, overdue: 0, credit: 0 });
      res.json({ customers: rows, totals: { open: r2(tot.open), overdue: r2(tot.overdue), credit: r2(tot.credit) } });
    } catch (e) { fail(res, e); }
  });

  // Open items: POS sales (doc 'sale') and invoices raised on the books (doc
  // 'invoice', billing.js). An id is only unique together with its doc.
  async function openInvoices(customerId, q = query) {
    const { rows } = await q(
      `SELECT o.doc, o.id, o.receipt_number, CASE WHEN o.doc = 'invoice' THEN o.payment_status END AS invoice_kind, to_char(o.created_at, 'YYYY-MM-DD') AS day, to_char(o.due_date, 'YYYY-MM-DD') AS due, ROUND(o.charged::numeric, 2)::float AS total, ROUND(o.settled::numeric, 2)::float AS paid, ROUND(o.open::numeric, 2)::float AS open,
              GREATEST(CURRENT_DATE - COALESCE(o.due_date, o.created_at::date), 0)::int AS days_overdue
         FROM (${OPEN_SQL}) o WHERE o.customer_id = $1 ORDER BY o.created_at, o.id`, [customerId]);
    return rows;
  }
  async function paymentCredit(paymentId, q = query) {
    const { rows } = await q(
      `SELECT ap.amount_usd::float AS amount,
              COALESCE((SELECT SUM(amount) FROM ar_applications WHERE payment_id = ap.id), 0)::float AS applied,
              (NOT EXISTS (SELECT 1 FROM ar_applications WHERE payment_id = ap.id) AND EXISTS (SELECT 1 FROM pos_sales s WHERE s.receipt_number = ap.reference AND s.customer_id = ap.customer_id)) AS legacy_applied
         FROM account_payments ap WHERE ap.id = $1`, [paymentId]);
    if (!rows.length) return null;
    const p = rows[0];
    return { amount: p.amount, applied: p.legacy_applied ? p.amount : p.applied, unapplied: p.legacy_applied ? 0 : r2(p.amount - p.applied) };
  }

  app.get('/api/ar/customers/:id', ...AR, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const { rows: cu } = await query(`SELECT id, COALESCE(NULLIF(name, ''), email) AS name, email, phone, account_number, company_name, credit_limit_usd::float AS credit_limit, payment_terms_days, credit_hold, credit_hold_reason, default_income_account_id, default_class_id FROM users WHERE id = $1 AND NOT is_staff`, [id]);
      if (!cu.length) throw httpError(404, 'Customer not found');
      const invoices = await openInvoices(id);
      const { rows: pays } = await query(
        `SELECT ap.id, to_char(COALESCE(ap.paid_on, ap.created_at::date), 'YYYY-MM-DD') AS day, ap.amount_usd::float AS amount, ap.method, ap.reference, ap.notes, ap.voided_at, ap.void_reason,
                ga.name AS deposit_to, u.name AS by_name,
                COALESCE((SELECT json_agg(json_build_object('receipt', COALESCE(s.receipt_number, i.number), 'amount', x.amount::float)) FROM ar_applications x LEFT JOIN pos_sales s ON s.id = x.sale_id LEFT JOIN ar_invoices i ON i.id = x.invoice_id WHERE x.payment_id = ap.id), '[]') AS applied_to
           FROM account_payments_all ap LEFT JOIN gl_accounts ga ON ga.id = ap.deposit_account_id LEFT JOIN users u ON u.id = ap.received_by
          WHERE ap.customer_id = $1 ORDER BY COALESCE(ap.paid_on, ap.created_at::date) DESC, ap.id DESC LIMIT 100`, [id]);
      for (const p of pays) if (!p.voided_at) Object.assign(p, await paymentCredit(p.id));
      const { rows: notes } = await query(`SELECT n.*, to_char(n.promise_date, 'YYYY-MM-DD') AS promise_day, u.name AS by_name FROM ar_notes n LEFT JOIN users u ON u.id = n.created_by WHERE n.customer_id = $1 ORDER BY n.created_at DESC LIMIT 50`, [id]);
      const aging = { current: 0, d30: 0, d60: 0, d90: 0, over90: 0 };
      for (const i of invoices) { const d = i.days_overdue; aging[d <= 0 ? 'current' : d <= 30 ? 'd30' : d <= 60 ? 'd60' : d <= 90 ? 'd90' : 'over90'] += i.open; }
      for (const k of Object.keys(aging)) aging[k] = r2(aging[k]);
      const credit = r2(pays.filter((p) => !p.voided_at).reduce((t, p) => t + (p.unapplied || 0), 0));
      const open = r2(invoices.reduce((t, i) => t + i.open, 0));
      res.json({ customer: cu[0], invoices, payments: pays, notes, aging, open, credit, balance: r2(open - credit) });
    } catch (e) { fail(res, e); }
  });

  // Applications: [{sale_id, amount}] or [{invoice_id, amount}], checked against
  // what each invoice still owes.
  async function applyAll(c, customerId, paymentId, apps, available, userId) {
    const list = (Array.isArray(apps) ? apps : []).map((a) => (a.invoice_id ? { doc: 'invoice', id: parseInt(a.invoice_id, 10) } : { doc: 'sale', id: parseInt(a.sale_id, 10) }))
      .map((a, k) => Object.assign(a, { amount: r2(apps[k].amount) })).filter((a) => a.id && a.amount > 0);
    const total = r2(list.reduce((t, a) => t + a.amount, 0));
    if (total > available + 0.005) throw httpError(400, 'You applied ' + money(total) + ' but only ' + money(available) + ' is available');
    const inv = await openInvoices(customerId, c.query.bind(c));
    for (const a of list) {
      const i = inv.find((x) => x.doc === a.doc && x.id === a.id);
      if (!i) throw httpError(400, 'Invoice ' + a.id + ' is not open on this account');
      if (a.amount > i.open + 0.005) throw httpError(400, 'Invoice ' + i.receipt_number + ' only owes ' + money(i.open));
      await c.query(`INSERT INTO ar_applications (payment_id, sale_id, invoice_id, amount, applied_by) VALUES ($1,$2,$3,$4,$5)`,
        [paymentId, a.doc === 'sale' ? a.id : null, a.doc === 'invoice' ? a.id : null, a.amount, userId]);
    }
    return total;
  }
  app.post('/api/ar/payments', ...AR, async (req, res) => {
    try {
      const b = req.body || {};
      const cid = parseInt(b.customer_id, 10), amount = r2(b.amount);
      if (!(amount > 0)) throw httpError(400, 'Amount received');
      if (!['cash', 'cheque', 'card', 'bank'].includes(b.method)) throw httpError(400, 'Cash, cheque, card or bank transfer?');
      const paidOn = isDate(b.paid_on) ? b.paid_on : today();
      if (paidOn > today()) throw httpError(400, 'The payment date is in the future');
      const dep = await bankAccount(b.deposit_account_id);
      const { rows: cu } = await query(`SELECT id FROM users WHERE id = $1 AND NOT is_staff`, [cid]);
      if (!cu.length) throw httpError(404, 'Customer not found');
      const out = await tx(async (c) => {
        const { rows } = await c.query(
          `INSERT INTO account_payments (customer_id, amount_usd, method, reference, notes, received_by, paid_on, deposit_account_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [cid, amount, b.method, String(b.reference || '').slice(0, 60) || null, String(b.memo || '').slice(0, 300) || null, req.session.userId, paidOn, dep.id]);
        const applied = await applyAll(c, cid, rows[0].id, b.applications, amount, req.session.userId);
        return { id: rows[0].id, applied, credit: r2(amount - applied) };
      });
      post();
      res.json(Object.assign({ ok: true }, out));
    } catch (e) { fail(res, e); }
  });
  app.post('/api/ar/payments/:id/apply', ...AR, async (req, res) => {
    try {
      const pid = parseInt(req.params.id, 10);
      const out = await tx(async (c) => {
        const { rows } = await c.query(`SELECT * FROM account_payments_all WHERE id = $1 AND voided_at IS NULL FOR UPDATE`, [pid]);
        if (!rows.length) throw httpError(404, 'Payment not found (or voided)');
        const cr = await paymentCredit(pid, c.query.bind(c));
        if (!(cr.unapplied > 0.005)) throw httpError(409, 'Nothing left on this payment to apply');
        return applyAll(c, rows[0].customer_id, pid, (req.body || {}).applications, cr.unapplied, req.session.userId);
      });
      res.json({ ok: true, applied: out });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/ar/payments/:id/void', ...AR, async (req, res) => {
    try {
      const reason = String((req.body || {}).reason || '').trim().slice(0, 200);
      if (reason.length < 3) throw httpError(400, 'Say why the payment is voided');
      const id = parseInt(req.params.id, 10);
      const { rows: cl } = await query(`SELECT 1 FROM bank_cleared bc JOIN gl_lines l ON l.id = bc.gl_line_id JOIN gl_entries e ON e.id = l.entry_id JOIN bank_recons r ON r.id = bc.recon_id WHERE e.source_kind = 'account_payment' AND e.source_id = $1 AND r.status = 'done'`, [id]);
      if (cl.length) throw httpError(409, 'This payment is in a finished bank reconciliation; undo that reconciliation first');
      const { rows: dep } = await query(`SELECT 1 FROM bank_txn_lines bl JOIN bank_txns t ON t.id = bl.txn_id JOIN gl_lines l ON l.id = bl.gl_line_id JOIN gl_entries e ON e.id = l.entry_id WHERE e.source_kind = 'account_payment' AND e.source_id = $1 AND t.voided_at IS NULL`, [id]);
      if (dep.length) throw httpError(409, 'This payment has been banked in a deposit; void the deposit first');
      const { rowCount } = await query(`UPDATE account_payments_all SET voided_at = NOW(), voided_by = $2, void_reason = $3 WHERE id = $1 AND voided_at IS NULL`, [id, req.session.userId, reason]);
      if (!rowCount) throw httpError(409, 'Payment not found or already voided');
      post();
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/ar/customers/:id/hold', ...AR, async (req, res) => {
    try {
      const b = req.body || {}, hold = !!b.hold, reason = String(b.reason || '').trim().slice(0, 200);
      if (hold && reason.length < 3) throw httpError(400, 'Say why the account is on hold');
      const id = parseInt(req.params.id, 10);
      const { rowCount } = await query(`UPDATE users SET credit_hold = $2, credit_hold_reason = $3 WHERE id = $1 AND NOT is_staff`, [id, hold, hold ? reason : null]);
      if (!rowCount) throw httpError(404, 'Customer not found');
      await query(`INSERT INTO ar_notes (customer_id, kind, note, created_by) VALUES ($1, 'hold', $2, $3)`, [id, hold ? 'Put on credit hold: ' + reason : 'Credit hold lifted' + (reason ? ': ' + reason : ''), req.session.userId]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/ar/customers/:id/notes', ...AR, async (req, res) => {
    try {
      const b = req.body || {};
      const note = String(b.note || '').trim().slice(0, 1000);
      if (!note) throw httpError(400, 'Write the note');
      const kind = ['note', 'call', 'email', 'promise'].includes(b.kind) ? b.kind : 'note';
      if (kind === 'promise' && !isDate(b.promise_date)) throw httpError(400, 'When did they promise to pay?');
      await query(`INSERT INTO ar_notes (customer_id, kind, note, promise_date, promise_amount, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
        [parseInt(req.params.id, 10), kind, note, kind === 'promise' ? b.promise_date : null, kind === 'promise' && n(b.promise_amount) > 0 ? r2(b.promise_amount) : null, req.session.userId]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  // A reminder email with what is overdue (account business, not marketing).
  // Shared with the scheduled reminders (billing.js), which can also list
  // invoices coming due or due today; `inv` there is what is past due.
  const canEmail = (e) => !!e && /@/.test(e) && !/\.local$/i.test(e);
  function reminderEmail(name, inv, sh, upcoming) {
    const soon = upcoming || [];
    const total = r2(inv.reduce((t, i) => t + i.open, 0)), dueSoon = r2(soon.reduce((t, i) => t + i.open, 0));
    const line = (i) => i.receipt_number + '  dated ' + i.day + '  due ' + (i.due || i.day) + '  ' + money(i.open);
    const text = 'Dear ' + (name || 'customer') + ',\n\n' +
      (inv.length ? 'Our records show these invoices are past due:\n\n' + inv.map((i) => line(i) + ' (' + i.days_overdue + ' days overdue)').join('\n') + '\n\nTotal past due: ' + money(total) + '\n\n' : '') +
      (soon.length ? (inv.length ? 'Also coming due:\n\n' : 'This is a friendly reminder that these invoices are coming due:\n\n') + soon.map((i) => line(i) + (i.due === today() ? ' (due today)' : '')).join('\n') + '\n\n' : '') +
      'Please arrange payment, or call us on ' + (sh.phone || 'the shop number') + ' if you have any questions. If you have already paid, thank you, and please ignore this reminder.\n\n' + (sh.name || 'Vision Auto Solutions');
    const subject = inv.length ? 'Payment reminder - ' + money(total) + ' past due' : 'Payment reminder - ' + money(dueSoon) + ' due ' + (soon.every((i) => i.due === today()) ? 'today' : 'soon');
    return { subject, text, total, due_soon: dueSoon };
  }
  app.post('/api/ar/customers/:id/reminder', ...AR, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const { rows: cu } = await query(`SELECT name, email FROM users WHERE id = $1 AND NOT is_staff`, [id]);
      if (!cu.length) throw httpError(404, 'Customer not found');
      if (!canEmail(cu[0].email)) throw httpError(409, 'No email address for this customer: phone them instead');
      const inv = (await openInvoices(id)).filter((i) => i.days_overdue > 0);
      if (!inv.length) throw httpError(409, 'Nothing is overdue');
      const sh = (await getShop()) || {};
      const { subject, text, total } = reminderEmail(cu[0].name, inv, sh);
      await mailer.sendEmail({ to: cu[0].email, subject, text });
      await query(`INSERT INTO ar_notes (customer_id, kind, note, created_by) VALUES ($1, 'reminder', $2, $3)`, [id, 'Reminder emailed: ' + inv.length + ' invoice(s), ' + money(total) + ' past due', req.session.userId]);
      res.json({ ok: true, invoices: inv.length, total });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/ar/aging', ...AR, async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT o.customer_id, COALESCE(NULLIF(u.name, ''), o.customer_name) AS name,
                COALESCE(SUM(o.open) FILTER (WHERE CURRENT_DATE - COALESCE(o.due_date, o.created_at::date) <= 0), 0)::float AS current,
                COALESCE(SUM(o.open) FILTER (WHERE CURRENT_DATE - COALESCE(o.due_date, o.created_at::date) BETWEEN 1 AND 30), 0)::float AS d30,
                COALESCE(SUM(o.open) FILTER (WHERE CURRENT_DATE - COALESCE(o.due_date, o.created_at::date) BETWEEN 31 AND 60), 0)::float AS d60,
                COALESCE(SUM(o.open) FILTER (WHERE CURRENT_DATE - COALESCE(o.due_date, o.created_at::date) BETWEEN 61 AND 90), 0)::float AS d90,
                COALESCE(SUM(o.open) FILTER (WHERE CURRENT_DATE - COALESCE(o.due_date, o.created_at::date) > 90), 0)::float AS over90,
                SUM(o.open)::float AS total
           FROM (${OPEN_SQL}) o LEFT JOIN users u ON u.id = o.customer_id
          GROUP BY o.customer_id, COALESCE(NULLIF(u.name, ''), o.customer_name) ORDER BY total DESC LIMIT 500`);
      const t = { current: 0, d30: 0, d60: 0, d90: 0, over90: 0, total: 0 };
      for (const r of rows) for (const k of Object.keys(t)) { r[k] = r2(r[k]); t[k] = r2(t[k] + r[k]); }
      res.json({ rows, totals: t, as_of: today() });
    } catch (e) { fail(res, e); }
  });
  // Collections worklist, following SOP-09: reminder from day 1 overdue, a call from day 15, hold at day 45.
  app.get('/api/ar/collections', ...AR, async (req, res) => {
    try {
      const { rows } = await query(
        `WITH inv AS (SELECT customer_id, SUM(open) FILTER (WHERE COALESCE(due_date, created_at::date) < CURRENT_DATE) AS overdue,
                             MAX(CURRENT_DATE - COALESCE(due_date, created_at::date)) AS oldest
                        FROM (${OPEN_SQL}) z WHERE customer_id IS NOT NULL GROUP BY customer_id)
         SELECT u.id, COALESCE(NULLIF(u.name, ''), u.email) AS name, u.phone, u.email, u.credit_hold, inv.overdue::float AS overdue, inv.oldest::int AS oldest_days,
                (SELECT row_to_json(x) FROM (SELECT kind, note, created_at, to_char(promise_date, 'YYYY-MM-DD') AS promise_day FROM ar_notes WHERE customer_id = u.id ORDER BY created_at DESC LIMIT 1) x) AS last
           FROM inv JOIN users u ON u.id = inv.customer_id WHERE inv.overdue > 0.005 AND NOT u.is_staff ORDER BY inv.oldest DESC LIMIT 300`);
      for (const r of rows) {
        r.overdue = r2(r.overdue);
        const promised = r.last && r.last.kind === 'promise' && r.last.promise_day >= today();
        r.step = promised ? 'promised' : r.oldest_days >= 45 && !r.credit_hold ? 'hold' : r.oldest_days >= 15 ? 'call' : 'remind';
      }
      res.json({ rows });
    } catch (e) { fail(res, e); }
  });
  // Accounting defaults (QuickBooks-style): the income category and class new invoice lines start with.
  app.put('/api/ar/customers/:id/defaults', ...AR, async (req, res) => {
    try {
      const b = req.body || {};
      let inc = null;
      if (b.default_income_account_id) {
        const a = await lineAccount(b.default_income_account_id);
        if (!['income', 'other_income'].includes(a.type)) throw httpError(400, 'Choose an income account for the default category');
        inc = a.id;
      }
      const cls = await classId(b.default_class_id);
      const { rowCount } = await query(`UPDATE users SET default_income_account_id = $2, default_class_id = $3 WHERE id = $1 AND NOT is_staff`, [parseInt(req.params.id, 10), inc, cls]);
      if (!rowCount) throw httpError(404, 'Customer not found');
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/ar/customers/:id/terms', ...AR, async (req, res) => {
    try {
      const b = req.body || {};
      const terms = b.payment_terms_days === '' || b.payment_terms_days == null ? null : parseInt(b.payment_terms_days, 10);
      const limit = b.credit_limit === '' || b.credit_limit == null ? null : r2(b.credit_limit);
      if (terms != null && !(terms >= 0 && terms <= 365)) throw httpError(400, 'Terms 0 to 365 days');
      if (limit != null && !(limit >= 0)) throw httpError(400, 'Credit limit');
      const { rowCount } = await query(`UPDATE users SET payment_terms_days = $2, credit_limit_usd = $3 WHERE id = $1 AND NOT is_staff`, [parseInt(req.params.id, 10), terms, limit]);
      if (!rowCount) throw httpError(404, 'Customer not found');
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ============================================================ PAYABLES ==
  const AP = can('ap.manage');
  // Every unpaid bill and vendor credit, from the three places bills come from.
  async function apDocs(supplierId, q = query) {
    const sid = supplierId || null;
    const { rows: rec } = await q(
      `SELECT 'receipt' AS kind, r.id, r.po_id, r.supplier_id, s.name AS supplier, COALESCE(r.supplier_invoice_number, r.receipt_number) AS number,
              to_char(COALESCE(r.supplier_invoice_date, r.bill_confirmed_at::date), 'YYYY-MM-DD') AS day, to_char(r.due_date, 'YYYY-MM-DD') AS due, r.bill_amount_jmd::float AS amount
         FROM receipts r LEFT JOIN suppliers s ON s.id = r.supplier_id
        WHERE r.bill_status = 'confirmed' AND r.status = 'posted' AND COALESCE(r.bill_amount_jmd, 0) > 0 AND ($1::int IS NULL OR r.supplier_id = $1)`, [sid]);
    const { rows: pos } = await q(
      `SELECT 'po' AS kind, po.id, po.id AS po_id, po.supplier_id, s.name AS supplier, COALESCE(po.invoice_number, po.po_number) AS number,
              to_char(COALESCE(po.received_date, po.created_at::date), 'YYYY-MM-DD') AS day, to_char(po.due_date, 'YYYY-MM-DD') AS due, po.invoice_total_usd::float AS amount
         FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id
        WHERE COALESCE(po.invoice_total_usd, 0) > 0 AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.po_id = po.id) AND ($1::int IS NULL OR po.supplier_id = $1)`, [sid]);
    const { rows: bills } = await q(
      `SELECT CASE WHEN b.kind = 'credit' THEN 'credit' ELSE 'bill' END AS kind, b.id, NULL::int AS po_id, b.supplier_id, s.name AS supplier, COALESCE(b.number, '#' || b.id) AS number,
              to_char(b.bill_date, 'YYYY-MM-DD') AS day, to_char(b.due_date, 'YYYY-MM-DD') AS due, b.total::float AS amount, b.memo
         FROM ap_bills b JOIN suppliers s ON s.id = b.supplier_id WHERE b.voided_at IS NULL AND ($1::int IS NULL OR b.supplier_id = $1)`, [sid]);
    const { rows: apps } = await q(`SELECT a.bill_kind, a.bill_id, SUM(a.amount)::float AS paid FROM ap_applications a JOIN ap_payments p ON p.id = a.payment_id WHERE p.voided_at IS NULL GROUP BY 1, 2`);
    const { rows: pop } = await q(`SELECT po_id, SUM(amount_usd)::float AS paid FROM purchase_order_payments GROUP BY po_id`);
    const appOf = (k, id) => { const x = apps.find((a) => a.bill_kind === k && a.bill_id === id); return x ? x.paid : 0; };
    // Payments recorded against a purchase order before this module count toward its bills, oldest first.
    const poLeft = Object.fromEntries(pop.map((p) => [p.po_id, p.paid]));
    const all = rec.concat(pos, bills).sort((a, b) => String(a.day).localeCompare(String(b.day)) || a.id - b.id);
    const now = today();
    for (const d of all) {
      let paid = appOf(d.kind, d.id);
      if ((d.kind === 'receipt' || d.kind === 'po') && poLeft[d.po_id] > 0) { const use = Math.min(poLeft[d.po_id], r2(d.amount - paid)); paid += use; poLeft[d.po_id] = r2(poLeft[d.po_id] - use); }
      d.paid = r2(paid); d.open = r2(d.amount - paid);
      d.days_overdue = d.due && d.due < now ? Math.round((Date.parse(now) - Date.parse(d.due)) / 86400000) : 0;
    }
    return all;
  }
  app.get('/api/ap/suppliers', ...AP, async (req, res) => {
    try {
      const q = String(req.query.q || '').trim().toLowerCase();
      const docs = (await apDocs(null)).filter((d) => d.open > 0.005);
      const by = {};
      for (const d of docs) {
        const s = by[d.supplier_id] = by[d.supplier_id] || { id: d.supplier_id, name: d.supplier, open: 0, overdue: 0, credits: 0, bills: 0, next_due: null };
        if (d.kind === 'credit') s.credits = r2(s.credits + d.open);
        else { s.open = r2(s.open + d.open); s.bills++; if (d.days_overdue > 0) s.overdue = r2(s.overdue + d.open); if (d.due && (!s.next_due || d.due < s.next_due)) s.next_due = d.due; }
      }
      let list = Object.values(by);
      if (q) {
        const { rows } = await query(`SELECT id, name FROM suppliers WHERE name ILIKE '%' || $1 || '%' ORDER BY name LIMIT 50`, [q]);
        for (const r of rows) if (!by[r.id]) list.push({ id: r.id, name: r.name, open: 0, overdue: 0, credits: 0, bills: 0, next_due: null });
        list = list.filter((s) => String(s.name || '').toLowerCase().includes(q));
      }
      list.sort((a, b) => b.overdue - a.overdue || b.open - a.open);
      res.json({ suppliers: list, totals: { open: r2(list.reduce((t, s) => t + s.open, 0)), overdue: r2(list.reduce((t, s) => t + s.overdue, 0)), credits: r2(list.reduce((t, s) => t + s.credits, 0)) } });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/ap/supplier-list', ...AP, async (req, res) => {
    try {
      const { rows } = await query(`SELECT s.id, s.name, s.payment_terms_days, s.default_account_id, s.default_class_id FROM suppliers s WHERE s.name IS NOT NULL AND s.name <> '' ORDER BY s.name LIMIT 3000`);
      res.json({ suppliers: rows });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/ap/suppliers/:id', ...AP, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const { rows: s } = await query(`SELECT s.id, s.name, s.payment_terms, s.payment_terms_days, s.default_account_id, s.default_class_id, ga.name AS default_account FROM suppliers s LEFT JOIN gl_accounts ga ON ga.id = s.default_account_id WHERE s.id = $1`, [id]);
      if (!s.length) throw httpError(404, 'Supplier not found');
      const docs = await apDocs(id);
      const { rows: pays } = await query(
        `SELECT p.id, to_char(p.pay_date, 'YYYY-MM-DD') AS day, p.amount::float AS amount, p.method, p.cheque_number, p.reference, p.memo, p.voided_at, p.void_reason, ga.name AS paid_from,
                COALESCE((SELECT json_agg(json_build_object('kind', a.bill_kind, 'id', a.bill_id, 'amount', a.amount::float)) FROM ap_applications a WHERE a.payment_id = p.id), '[]') AS applied
           FROM ap_payments p JOIN gl_accounts ga ON ga.id = p.account_id WHERE p.supplier_id = $1 ORDER BY p.pay_date DESC, p.id DESC LIMIT 100`, [id]);
      res.json({ supplier: s[0], open: docs.filter((d) => d.open > 0.005), history: docs.filter((d) => d.open <= 0.005).slice(-50).reverse(), payments: pays });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/ap/suppliers/:id', ...AP, async (req, res) => {
    try {
      const b = req.body || {};
      const terms = b.payment_terms_days === '' || b.payment_terms_days == null ? null : parseInt(b.payment_terms_days, 10);
      if (terms != null && !(terms >= 0 && terms <= 365)) throw httpError(400, 'Terms 0 to 365 days');
      const acct = b.default_account_id ? (await lineAccount(b.default_account_id)).id : null;
      const cls = b.default_class_id === undefined ? undefined : await classId(b.default_class_id);
      const { rowCount } = await query(`UPDATE suppliers SET payment_terms_days = $2, default_account_id = $3, default_class_id = CASE WHEN $4 THEN $5 ELSE default_class_id END WHERE id = $1`, [parseInt(req.params.id, 10), terms, acct, cls !== undefined, cls === undefined ? null : cls]);
      if (!rowCount) throw httpError(404, 'Supplier not found');
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  // The supplier record's Bills tab: every bill and credit from this supplier,
  // paid or not, newest first. Same apDocs as the Payables screen, so the
  // paid and balance figures cannot disagree with it.
  app.get('/api/admin/suppliers/:id/bills', ...AP, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) throw httpError(400, 'Bad supplier id');
      const docs = (await apDocs(id)).reverse();
      const bills = docs.filter((d) => d.kind !== 'credit');
      res.json({
        bills: docs,
        totals: { billed: r2(bills.reduce((t, d) => t + n(d.amount), 0)), paid: r2(bills.reduce((t, d) => t + d.paid, 0)), open: r2(bills.reduce((t, d) => t + d.open, 0)) },
      });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/ap/bills', ...AP, async (req, res) => {
    try {
      let docs = (await apDocs(parseInt(req.query.supplier, 10) || null)).filter((d) => d.open > 0.005);
      if (isDate(req.query.due_by)) docs = docs.filter((d) => d.kind === 'credit' || !d.due || d.due <= req.query.due_by);
      docs.sort((a, b) => String(a.due || a.day).localeCompare(String(b.due || b.day)));
      res.json({ bills: docs.filter((d) => d.kind !== 'credit'), credits: docs.filter((d) => d.kind === 'credit') });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/ap/bills/:id', ...AP, async (req, res) => {
    try {
      const { rows } = await query(`SELECT b.*, b.total::float AS total, b.gct_amount::float AS gct_amount, to_char(b.bill_date, 'YYYY-MM-DD') AS day, to_char(b.due_date, 'YYYY-MM-DD') AS due, s.name AS supplier FROM ap_bills b JOIN suppliers s ON s.id = b.supplier_id WHERE b.id = $1`, [parseInt(req.params.id, 10)]);
      if (!rows.length) throw httpError(404, 'Bill not found');
      const { rows: lines } = await query(`SELECT l.id, l.description, l.amount::float AS amount, a.code, a.name AS account, c.name AS class FROM ap_bill_lines l JOIN gl_accounts a ON a.id = l.account_id LEFT JOIN gl_classes c ON c.id = l.class_id WHERE l.bill_id = $1 ORDER BY l.id`, [rows[0].id]);
      res.json({ bill: rows[0], lines });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/ap/bills', ...AP, async (req, res) => {
    try {
      const b = req.body || {};
      const kind = b.kind === 'credit' ? 'credit' : 'bill';
      const sid = parseInt(b.supplier_id, 10);
      const { rows: sup } = await query(`SELECT id, payment_terms_days FROM suppliers WHERE id = $1`, [sid || 0]);
      if (!sup.length) throw httpError(400, 'Choose the supplier');
      if (!isDate(b.bill_date)) throw httpError(400, 'Bill date');
      const lines = (Array.isArray(b.lines) ? b.lines : []).map((l) => ({ account_id: parseInt(l.account_id, 10), description: String(l.description || '').slice(0, 200) || null, amount: r2(l.amount), class_id: l.class_id })).filter((l) => l.amount > 0);
      if (!lines.length) throw httpError(400, 'Add at least one line with an amount');
      for (const l of lines) { await lineAccount(l.account_id); l.class_id = await classId(l.class_id); }
      const gct = r2(b.gct_amount);
      if (gct < 0) throw httpError(400, 'GCT cannot be negative');
      const total = r2(lines.reduce((t, l) => t + l.amount, 0) + gct);
      const number = String(b.number || '').trim().slice(0, 60) || null;
      if (number && !b.allow_duplicate) {
        const { rows: dup } = await query(`SELECT id FROM ap_bills WHERE supplier_id = $1 AND lower(number) = lower($2) AND kind = $3 AND voided_at IS NULL`, [sid, number, kind]);
        if (dup.length) throw httpError(409, 'This supplier already has ' + (kind === 'credit' ? 'a credit' : 'a bill') + ' numbered ' + number);
      }
      let due = isDate(b.due_date) ? b.due_date : null;
      if (!due && kind === 'bill') due = new Date(Date.parse(b.bill_date) + (sup[0].payment_terms_days || 0) * 86400000).toISOString().slice(0, 10);
      const id = await tx(async (c) => {
        const { rows } = await c.query(`INSERT INTO ap_bills (kind, supplier_id, number, bill_date, due_date, memo, gct_amount, total, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [kind, sid, number, b.bill_date, kind === 'bill' ? due : null, String(b.memo || '').slice(0, 300) || null, gct, total, req.session.userId]);
        for (const l of lines) await c.query(`INSERT INTO ap_bill_lines (bill_id, account_id, description, amount, class_id) VALUES ($1,$2,$3,$4,$5)`, [rows[0].id, l.account_id, l.description, l.amount, l.class_id]);
        return rows[0].id;
      });
      post();
      res.json({ ok: true, id, total, due_date: kind === 'bill' ? due : null });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/ap/bills/:id/void', ...AP, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10), reason = String((req.body || {}).reason || '').trim().slice(0, 200);
      if (reason.length < 3) throw httpError(400, 'Say why it is voided');
      const { rows: used } = await query(`SELECT COUNT(*)::int AS n FROM ap_applications a JOIN ap_payments p ON p.id = a.payment_id WHERE a.bill_kind IN ('bill', 'credit') AND a.bill_id = $1 AND p.voided_at IS NULL`, [id]);
      if (used[0].n) throw httpError(409, 'Payments use this bill: void those payments first');
      const { rowCount } = await query(`UPDATE ap_bills SET voided_at = NOW(), voided_by = $2, void_reason = $3 WHERE id = $1 AND voided_at IS NULL`, [id, req.session.userId, reason]);
      if (!rowCount) throw httpError(409, 'Not found or already voided');
      post();
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  // Pay Bills: one payment from one account to one supplier, for several bills, using credits.
  app.post('/api/ap/payments', ...AP, async (req, res) => {
    try {
      const b = req.body || {};
      const sid = parseInt(b.supplier_id, 10);
      if (!['cheque', 'transfer', 'cash', 'card'].includes(b.method)) throw httpError(400, 'Cheque, transfer, cash or card?');
      const payDate = isDate(b.pay_date) ? b.pay_date : today();
      const acct = await bankAccount(b.account_id);
      const bills = (Array.isArray(b.bills) ? b.bills : []).map((x) => ({ kind: String(x.kind), id: parseInt(x.id, 10), amount: r2(x.amount) })).filter((x) => x.amount > 0);
      const credits = (Array.isArray(b.credits) ? b.credits : []).map((x) => ({ kind: 'credit', id: parseInt(x.id, 10), amount: r2(x.amount) })).filter((x) => x.amount > 0);
      if (!bills.length) throw httpError(400, 'Choose the bills to pay');
      const cheque = String(b.cheque_number || '').trim().slice(0, 30) || null;
      if (b.method === 'cheque' && !cheque) throw httpError(400, 'Cheque number');
      const out = await tx(async (c) => {
        await c.query(`SELECT pg_advisory_xact_lock(hashtext('ap_pay'))`);   // two people paying the same bill at once
        const docs = await apDocs(sid, c.query.bind(c));
        for (const x of bills) {
          if (!['receipt', 'po', 'bill'].includes(x.kind)) throw httpError(400, 'Unknown bill type');
          const d = docs.find((y) => y.kind === x.kind && y.id === x.id);
          if (!d) throw httpError(400, 'A bill is not this supplier\'s');
          if (x.amount > d.open + 0.005) throw httpError(400, 'Bill ' + d.number + ' only has ' + money(d.open) + ' left to pay');
        }
        for (const x of credits) {
          const d = docs.find((y) => y.kind === 'credit' && y.id === x.id);
          if (!d || x.amount > d.open + 0.005) throw httpError(400, 'A credit is not available for that amount');
        }
        const amount = r2(bills.reduce((t, x) => t + x.amount, 0) - credits.reduce((t, x) => t + x.amount, 0));
        if (amount < 0) throw httpError(400, 'The credits used are more than the bills paid');
        if (cheque) {
          const { rows: dup } = await c.query(`SELECT 1 FROM ap_payments WHERE account_id = $1 AND cheque_number = $2 AND voided_at IS NULL UNION ALL SELECT 1 FROM bank_txns WHERE account_id = $1 AND cheque_number = $2 AND voided_at IS NULL`, [acct.id, cheque]);
          if (dup.length && !b.allow_duplicate) throw httpError(409, 'Cheque ' + cheque + ' has already been used on this account');
        }
        const { rows } = await c.query(
          `INSERT INTO ap_payments (supplier_id, pay_date, method, account_id, cheque_number, reference, amount, memo, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [sid, payDate, b.method, acct.id, cheque, String(b.reference || '').slice(0, 60) || null, amount, String(b.memo || '').slice(0, 300) || null, req.session.userId]);
        for (const x of bills.concat(credits)) await c.query(`INSERT INTO ap_applications (payment_id, bill_kind, bill_id, amount) VALUES ($1,$2,$3,$4)`, [rows[0].id, x.kind, x.id, x.amount]);
        return { id: rows[0].id, amount };
      });
      post();
      res.json(Object.assign({ ok: true }, out));
    } catch (e) { fail(res, e); }
  });
  app.get('/api/ap/payments/:id', ...AP, async (req, res) => {
    try {
      const { rows } = await query(`SELECT p.*, to_char(p.pay_date, 'YYYY-MM-DD') AS day, p.amount::float AS amount, s.name AS supplier, ga.name AS paid_from FROM ap_payments p JOIN suppliers s ON s.id = p.supplier_id JOIN gl_accounts ga ON ga.id = p.account_id WHERE p.id = $1`, [parseInt(req.params.id, 10)]);
      if (!rows.length) throw httpError(404, 'Payment not found');
      const docs = await apDocs(rows[0].supplier_id);
      const { rows: apps } = await query(`SELECT bill_kind, bill_id, amount::float AS amount FROM ap_applications WHERE payment_id = $1 ORDER BY id`, [rows[0].id]);
      res.json({ payment: rows[0], lines: apps.map((a) => { const d = docs.find((x) => x.kind === a.bill_kind && x.id === a.bill_id) || {}; return Object.assign(a, { number: d.number, day: d.day, bill_amount: d.amount }); }), shop: (await getShop()) || {} });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/ap/payments/:id/void', ...AP, async (req, res) => {
    try {
      const reason = String((req.body || {}).reason || '').trim().slice(0, 200);
      if (reason.length < 3) throw httpError(400, 'Say why the payment is voided');
      const id = parseInt(req.params.id, 10);
      const { rows: cl } = await query(`SELECT 1 FROM bank_cleared bc JOIN gl_lines l ON l.id = bc.gl_line_id JOIN gl_entries e ON e.id = l.entry_id JOIN bank_recons r ON r.id = bc.recon_id WHERE e.source_kind = 'ap_payment' AND e.source_id = $1 AND r.status = 'done'`, [id]);
      if (cl.length) throw httpError(409, 'This payment is in a finished bank reconciliation; undo that reconciliation first');
      const { rowCount } = await query(`UPDATE ap_payments SET voided_at = NOW(), voided_by = $2, void_reason = $3 WHERE id = $1 AND voided_at IS NULL`, [id, req.session.userId, reason]);
      if (!rowCount) throw httpError(409, 'Not found or already voided');
      post();
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/ap/aging', ...AP, async (req, res) => {
    try {
      const docs = (await apDocs(null)).filter((d) => d.open > 0.005 && d.kind !== 'credit');
      const by = {}, t = { current: 0, d30: 0, d60: 0, d90: 0, over90: 0, total: 0 };
      for (const d of docs) {
        const s = by[d.supplier_id] = by[d.supplier_id] || { supplier_id: d.supplier_id, name: d.supplier, current: 0, d30: 0, d60: 0, d90: 0, over90: 0, total: 0 };
        const k = d.days_overdue <= 0 ? 'current' : d.days_overdue <= 30 ? 'd30' : d.days_overdue <= 60 ? 'd60' : d.days_overdue <= 90 ? 'd90' : 'over90';
        s[k] = r2(s[k] + d.open); s.total = r2(s.total + d.open); t[k] = r2(t[k] + d.open); t.total = r2(t.total + d.open);
      }
      res.json({ rows: Object.values(by).sort((a, b) => b.total - a.total), totals: t, as_of: today() });
    } catch (e) { fail(res, e); }
  });

  // ============================================================= BANKING ==
  const BK = can('bank.manage');
  const CLEARED = `CASE WHEN bc.gl_line_id IS NULL THEN '' WHEN br.status = 'done' THEN 'R' ELSE 'C' END`;
  app.get('/api/bank/accounts', ...BK, async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT a.id, a.code, a.name, a.qb_type, a.system_key,
                COALESCE((SELECT SUM(l.amount) FROM gl_lines l WHERE l.account_id = a.id), 0)::float AS balance,
                COALESCE((SELECT SUM(l.amount) FROM gl_lines l JOIN bank_cleared bc ON bc.gl_line_id = l.id JOIN bank_recons r ON r.id = bc.recon_id AND r.status = 'done' WHERE l.account_id = a.id), 0)::float AS reconciled,
                (SELECT to_char(MAX(statement_date), 'YYYY-MM-DD') FROM bank_recons r WHERE r.account_id = a.id AND r.status = 'done') AS last_reconciled,
                (SELECT COUNT(*)::int FROM bank_feed_lines f WHERE f.account_id = a.id AND f.status = 'new') AS to_review
           FROM gl_accounts a WHERE a.is_active AND (a.qb_type = 'BANK' OR a.system_key = ANY($1)) ORDER BY (a.qb_type = 'BANK') DESC, a.code`, [MONEY_KEYS]);
      const { rows: st } = await query(`SELECT value FROM warehouse_settings WHERE key = 'gl_start_at'`);
      res.json({ accounts: rows, ledger_started: !!(st.length && st[0].value) });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/bank/accounts', ...BK, async (req, res) => {
    try {
      const b = req.body || {};
      const name = String(b.name || '').trim().slice(0, 80), code = String(b.code || '').trim().slice(0, 10);
      if (!name || !/^\d{4,6}$/.test(code)) throw httpError(400, 'Name, and a 4 to 6 digit account number (e.g. 1025)');
      const { rows } = await query(`INSERT INTO gl_accounts (code, name, type, qb_name, qb_type) VALUES ($1,$2,'asset',$2,'BANK') RETURNING id`, [code, name]);
      res.json({ ok: true, id: rows[0].id });
    } catch (e) { if (e.code === '23505') e = httpError(409, 'That account number is taken'); fail(res, e); }
  });
  app.get('/api/bank/register/:id', ...BK, async (req, res) => {
    try {
      const a = await bankAccount(req.params.id);
      const from = isDate(req.query.from) ? req.query.from : null, to = isDate(req.query.to) ? req.query.to : null;
      const qs = String(req.query.q || '').trim().slice(0, 60);
      const { rows: before } = await query(`SELECT COALESCE(SUM(l.amount), 0)::float AS v FROM gl_lines l JOIN gl_entries e ON e.id = l.entry_id WHERE l.account_id = $1 AND $2::date IS NOT NULL AND e.entry_date < $2::date`, [a.id, from]);
      const { rows } = await query(
        `SELECT l.id::int AS id, to_char(e.entry_date, 'YYYY-MM-DD') AS day, e.number, e.source_kind, e.source_id::int AS source_id, e.source_ref AS ref, e.memo, l.party, l.memo AS line_memo, l.amount::float AS amount,
                (e.reversed_by IS NOT NULL OR e.reverses_id IS NOT NULL) AS voided, ${CLEARED} AS cleared
           FROM gl_lines l JOIN gl_entries e ON e.id = l.entry_id LEFT JOIN bank_cleared bc ON bc.gl_line_id = l.id LEFT JOIN bank_recons br ON br.id = bc.recon_id
          WHERE l.account_id = $1 AND ($2::date IS NULL OR e.entry_date >= $2::date) AND ($3::date IS NULL OR e.entry_date <= $3::date)
            AND ($4 = '' OR e.memo ILIKE '%' || $4 || '%' OR l.party ILIKE '%' || $4 || '%' OR e.source_ref ILIKE '%' || $4 || '%' OR abs(l.amount)::text = $4)
          ORDER BY e.entry_date, e.id, l.id`, [a.id, from, to, qs]);
      let bal = qs ? null : before[0].v;
      for (const r of rows) { if (bal != null) { bal = r2(bal + r.amount); r.balance = bal; } }
      res.json({ account: a, opening: qs ? null : r2(before[0].v), lines: rows.slice(-1000).reverse(), more: rows.length > 1000 });
    } catch (e) { fail(res, e); }
  });
  // Write cheque / spend money (expense), receive money (deposit), transfer.
  async function makeTxn(c, { kind, accountId, date, payee, supplierId, cheque, reference, memo, lines, userId }) {
    const amount = r2(lines.reduce((t, l) => t + l.amount, 0));
    if (!(amount > 0)) throw httpError(400, 'Enter the amount');
    const { rows } = await c.query(
      `INSERT INTO bank_txns (kind, account_id, txn_date, payee, supplier_id, cheque_number, reference, memo, amount, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [kind, accountId, date, payee, supplierId, cheque, reference, memo, amount, userId]);
    for (const l of lines) await c.query(`INSERT INTO bank_txn_lines (txn_id, account_id, amount, memo, gl_line_id, class_id) VALUES ($1,$2,$3,$4,$5,$6)`, [rows[0].id, l.account_id, l.amount, l.memo || null, l.gl_line_id || null, l.class_id || null]);
    return { id: rows[0].id, amount };
  }
  app.post('/api/bank/txns', ...BK, async (req, res) => {
    try {
      const b = req.body || {};
      const kind = ['expense', 'deposit', 'transfer'].includes(b.kind) ? b.kind : null;
      if (!kind) throw httpError(400, 'Payment, deposit or transfer?');
      const acct = await bankAccount(b.account_id);
      const date = isDate(b.txn_date) ? b.txn_date : today();
      let lines = (Array.isArray(b.lines) ? b.lines : []).map((l) => ({ account_id: parseInt(l.account_id, 10), amount: r2(l.amount), memo: String(l.memo || '').slice(0, 200) || null, class_id: l.class_id })).filter((l) => l.amount > 0);
      for (const l of lines) l.class_id = await classId(l.class_id);
      if (kind === 'transfer') {
        const toAcct = await bankAccount(b.to_account_id);
        if (toAcct.id === acct.id) throw httpError(400, 'Transfer to a different account');
        lines = [{ account_id: toAcct.id, amount: r2(b.amount), memo: 'Transfer from ' + acct.name }];
      } else {
        if (!lines.length) throw httpError(400, 'Add at least one line with an account and amount');
        for (const l of lines) { const la = await lineAccount(l.account_id); if (la.id === acct.id) throw httpError(400, 'A line cannot use the same account'); }
      }
      const cheque = kind === 'expense' ? String(b.cheque_number || '').trim().slice(0, 30) || null : null;
      const out = await tx(async (c) => {
        if (cheque) {
          const { rows: dup } = await c.query(`SELECT 1 FROM ap_payments WHERE account_id = $1 AND cheque_number = $2 AND voided_at IS NULL UNION ALL SELECT 1 FROM bank_txns WHERE account_id = $1 AND cheque_number = $2 AND voided_at IS NULL`, [acct.id, cheque]);
          if (dup.length && !b.allow_duplicate) throw httpError(409, 'Cheque ' + cheque + ' has already been used on this account');
        }
        const sid = parseInt(b.supplier_id, 10) || null;
        return makeTxn(c, { kind, accountId: acct.id, date, payee: String(b.payee || '').trim().slice(0, 80) || null, supplierId: sid, cheque, reference: String(b.reference || '').slice(0, 60) || null, memo: String(b.memo || '').slice(0, 300) || null, lines, userId: req.session.userId });
      });
      await post();
      res.json(Object.assign({ ok: true }, out));
    } catch (e) { fail(res, e); }
  });
  app.post('/api/bank/txns/:id/void', ...BK, async (req, res) => {
    try {
      const reason = String((req.body || {}).reason || '').trim().slice(0, 200);
      if (reason.length < 3) throw httpError(400, 'Say why it is voided');
      const id = parseInt(req.params.id, 10);
      const { rows: cl } = await query(`SELECT 1 FROM bank_cleared bc JOIN gl_lines l ON l.id = bc.gl_line_id JOIN gl_entries e ON e.id = l.entry_id JOIN bank_recons r ON r.id = bc.recon_id WHERE e.source_kind = 'bank_txn' AND e.source_id = $1 AND r.status = 'done'`, [id]);
      if (cl.length) throw httpError(409, 'This is in a finished bank reconciliation; undo that reconciliation first');
      await tx(async (c) => {
        const { rowCount } = await c.query(`UPDATE bank_txns SET voided_at = NOW(), voided_by = $2, void_reason = $3 WHERE id = $1 AND voided_at IS NULL`, [id, req.session.userId, reason]);
        if (!rowCount) throw httpError(409, 'Not found or already voided');
        // A voided deposit releases its undeposited items; a statement line it came from goes back to review.
        await c.query(`UPDATE bank_txn_lines SET gl_line_id = NULL WHERE txn_id = $1`, [id]);
        await c.query(`UPDATE bank_feed_lines SET status = 'new', bank_txn_id = NULL, gl_line_id = NULL WHERE bank_txn_id = $1`, [id]);
      });
      await post();
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/bank/txns/:id', ...BK, async (req, res) => {
    try {
      const { rows } = await query(`SELECT t.*, to_char(t.txn_date, 'YYYY-MM-DD') AS day, t.amount::float AS amount, a.name AS account FROM bank_txns t JOIN gl_accounts a ON a.id = t.account_id WHERE t.id = $1`, [parseInt(req.params.id, 10)]);
      if (!rows.length) throw httpError(404, 'Not found');
      const { rows: lines } = await query(`SELECT l.amount::float AS amount, l.memo, a.code, a.name AS account FROM bank_txn_lines l JOIN gl_accounts a ON a.id = l.account_id WHERE l.txn_id = $1 ORDER BY l.id`, [rows[0].id]);
      res.json({ txn: rows[0], lines, shop: (await getShop()) || {} });
    } catch (e) { fail(res, e); }
  });

  // Make Deposits: money received into Undeposited Funds / Cheques to Deposit / card clearing, not yet banked.
  const UNDEPOSITED = `SELECT l.id::int AS id, to_char(e.entry_date, 'YYYY-MM-DD') AS day, e.number, e.source_ref AS ref, e.memo, l.party, l.amount::float AS amount, l.account_id, a.name AS account
      FROM gl_lines l JOIN gl_entries e ON e.id = l.entry_id JOIN gl_accounts a ON a.id = l.account_id
     WHERE a.system_key IN ('cash_safe', 'cheques', 'card_clearing') AND l.amount > 0 AND e.reversed_by IS NULL AND e.reverses_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM bank_txn_lines bl JOIN bank_txns t ON t.id = bl.txn_id WHERE bl.gl_line_id = l.id AND t.voided_at IS NULL)`;
  app.get('/api/bank/undeposited', ...BK, async (req, res) => {
    try {
      const { rows } = await query(UNDEPOSITED + ` ORDER BY e.entry_date, l.id LIMIT 1000`);
      res.json({ items: rows });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/bank/deposits', ...BK, async (req, res) => {
    try {
      const b = req.body || {};
      const acct = await bankAccount(b.account_id);
      if (acct.qb_type !== 'BANK') throw httpError(400, 'Deposit into a bank account');
      const ids = (Array.isArray(b.items) ? b.items : []).map((x) => parseInt(x, 10)).filter(Boolean);
      const extra = (Array.isArray(b.lines) ? b.lines : []).map((l) => ({ account_id: parseInt(l.account_id, 10), amount: r2(l.amount), memo: String(l.memo || '').slice(0, 200) || null })).filter((l) => l.amount > 0);
      if (!ids.length && !extra.length) throw httpError(400, 'Tick what is being deposited');
      for (const l of extra) await lineAccount(l.account_id);
      const out = await tx(async (c) => {
        await c.query(`SELECT pg_advisory_xact_lock(hashtext('bank_deposit'))`);
        const { rows: items } = await c.query(UNDEPOSITED + ` AND l.id = ANY($1)`, [ids]);
        if (items.length !== ids.length) throw httpError(409, 'Some items were already deposited or cannot be deposited');
        const lines = items.map((i) => ({ account_id: i.account_id, amount: i.amount, memo: i.party || i.ref || i.memo, gl_line_id: i.id })).concat(extra);
        return makeTxn(c, { kind: 'deposit', accountId: acct.id, date: isDate(b.txn_date) ? b.txn_date : today(), payee: null, supplierId: null, cheque: null, reference: String(b.reference || '').slice(0, 60) || null, memo: String(b.memo || 'Deposit').slice(0, 300), lines, userId: req.session.userId });
      });
      await post();
      res.json(Object.assign({ ok: true }, out));
    } catch (e) { fail(res, e); }
  });

  // -------------------------------------------------------- reconcile --
  async function reconView(accountId, reconId) {
    const { rows: rr } = await query(`SELECT *, to_char(statement_date, 'YYYY-MM-DD') AS sday, statement_balance::float AS sbal, opening_balance::float AS obal FROM bank_recons WHERE id = $1`, [reconId]);
    const r = rr[0];
    const { rows: lines } = await query(
      `SELECT l.id::int AS id, to_char(e.entry_date, 'YYYY-MM-DD') AS day, e.number, e.source_ref AS ref, e.memo, l.party, l.amount::float AS amount, COALESCE(bc.recon_id = $2, false) AS ticked,
              EXISTS (SELECT 1 FROM bank_feed_lines f WHERE f.gl_line_id = l.id AND f.status = 'matched') AS on_statement
         FROM gl_lines l JOIN gl_entries e ON e.id = l.entry_id LEFT JOIN bank_cleared bc ON bc.gl_line_id = l.id
        WHERE l.account_id = $1 AND e.entry_date <= $3::date AND (bc.gl_line_id IS NULL OR bc.recon_id = $2)
        ORDER BY e.entry_date, l.id`, [accountId, reconId, r.sday]);
    const cleared = r2(lines.filter((l) => l.ticked).reduce((t, l) => t + l.amount, 0));
    return { recon: { id: r.id, statement_date: r.sday, statement_balance: r.sbal, opening_balance: r.obal, status: r.status }, lines,
      cleared_balance: r2(r.obal + cleared), difference: r2(r.sbal - (r.obal + cleared)) };
  }
  app.get('/api/bank/reconcile/:accountId', ...BK, async (req, res) => {
    try {
      const a = await bankAccount(req.params.accountId);
      const { rows: open } = await query(`SELECT id FROM bank_recons WHERE account_id = $1 AND status = 'open'`, [a.id]);
      const { rows: done } = await query(`SELECT r.id, to_char(r.statement_date, 'YYYY-MM-DD') AS statement_date, r.statement_balance::float AS statement_balance, r.finished_at, u.name AS by_name
                                            FROM bank_recons r LEFT JOIN users u ON u.id = r.finished_by WHERE r.account_id = $1 AND r.status = 'done' ORDER BY r.statement_date DESC, r.id DESC LIMIT 24`, [a.id]);
      res.json(Object.assign({ account: a, history: done }, open.length ? await reconView(a.id, open[0].id) : { recon: null }));
    } catch (e) { fail(res, e); }
  });
  app.post('/api/bank/reconcile/:accountId/start', ...BK, async (req, res) => {
    try {
      const a = await bankAccount(req.params.accountId);
      const b = req.body || {};
      if (!isDate(b.statement_date)) throw httpError(400, 'Statement end date');
      if (b.statement_balance === '' || b.statement_balance == null || isNaN(Number(b.statement_balance))) throw httpError(400, 'Statement ending balance');
      const { rows: last } = await query(`SELECT statement_balance::float AS v, to_char(statement_date, 'YYYY-MM-DD') AS d FROM bank_recons WHERE account_id = $1 AND status = 'done' ORDER BY statement_date DESC, id DESC LIMIT 1`, [a.id]);
      if (last.length && b.statement_date <= last[0].d) throw httpError(400, 'The last reconciliation was to ' + last[0].d + '; choose a later statement date');
      const { rows } = await query(`INSERT INTO bank_recons (account_id, statement_date, statement_balance, opening_balance, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [a.id, b.statement_date, r2(b.statement_balance), last.length ? last[0].v : 0, req.session.userId]);
      res.json(Object.assign({ ok: true }, await reconView(a.id, rows[0].id)));
    } catch (e) { if (e.code === '23505') e = httpError(409, 'A reconciliation is already open for this account'); fail(res, e); }
  });
  app.post('/api/bank/reconcile/r/:id/tick', ...BK, async (req, res) => {
    try {
      const b = req.body || {};
      const { rows: rr } = await query(`SELECT * FROM bank_recons WHERE id = $1 AND status = 'open'`, [parseInt(req.params.id, 10)]);
      if (!rr.length) throw httpError(409, 'No open reconciliation');
      const r = rr[0];
      let ids = (Array.isArray(b.lines) ? b.lines : []).map((x) => parseInt(x, 10)).filter(Boolean);
      if (b.matched) {
        const { rows } = await query(`SELECT f.gl_line_id AS id FROM bank_feed_lines f JOIN gl_lines l ON l.id = f.gl_line_id JOIN gl_entries e ON e.id = l.entry_id
                                       WHERE f.account_id = $1 AND f.status = 'matched' AND e.entry_date <= $2 AND NOT EXISTS (SELECT 1 FROM bank_cleared bc WHERE bc.gl_line_id = f.gl_line_id)`, [r.account_id, r.statement_date]);
        ids = rows.map((x) => Number(x.id));
      }
      if (b.clear === false) await query(`DELETE FROM bank_cleared WHERE recon_id = $1 AND gl_line_id = ANY($2)`, [r.id, ids]);
      else {
        // Only this account's lines up to the statement date, not reconciled before.
        await query(`INSERT INTO bank_cleared (gl_line_id, recon_id, cleared_by)
                     SELECT l.id, $1, $4 FROM gl_lines l JOIN gl_entries e ON e.id = l.entry_id
                      WHERE l.id = ANY($2) AND l.account_id = $3 AND e.entry_date <= $5 ON CONFLICT (gl_line_id) DO NOTHING`, [r.id, ids, r.account_id, req.session.userId, r.statement_date]);
      }
      res.json(Object.assign({ ok: true }, await reconView(r.account_id, r.id)));
    } catch (e) { fail(res, e); }
  });
  // Bank charges, interest or a difference found while reconciling: entered and ticked in one go.
  app.post('/api/bank/reconcile/r/:id/adjust', ...BK, async (req, res) => {
    try {
      const b = req.body || {};
      const { rows: rr } = await query(`SELECT *, to_char(statement_date, 'YYYY-MM-DD') AS sday FROM bank_recons WHERE id = $1 AND status = 'open'`, [parseInt(req.params.id, 10)]);
      if (!rr.length) throw httpError(409, 'No open reconciliation');
      const r = rr[0], amt = r2(b.amount);
      if (!amt) throw httpError(400, 'Amount (minus for money out)');
      const { rows: ak } = await query(`SELECT id FROM gl_accounts WHERE system_key = $1`, [b.kind === 'difference' ? 'recon_diff' : 'bank_charges']);
      const t = await tx((c) => makeTxn(c, { kind: amt < 0 ? 'expense' : 'deposit', accountId: r.account_id, date: r.sday, payee: b.kind === 'difference' ? 'Reconciliation adjustment' : 'Bank', supplierId: null, cheque: null, reference: null,
        memo: String(b.memo || (b.kind === 'difference' ? 'Reconciliation difference' : amt < 0 ? 'Bank charges' : 'Interest')).slice(0, 200), lines: [{ account_id: ak[0].id, amount: Math.abs(amt), memo: null }], userId: req.session.userId }));
      await post();
      const { rows: gl } = await query(`SELECT l.id FROM gl_lines l JOIN gl_entries e ON e.id = l.entry_id WHERE e.source_kind = 'bank_txn' AND e.source_id = $1 AND l.account_id = $2`, [t.id, r.account_id]);
      if (gl.length) await query(`INSERT INTO bank_cleared (gl_line_id, recon_id, cleared_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [gl[0].id, r.id, req.session.userId]);
      res.json(Object.assign({ ok: true, posted: !!gl.length }, await reconView(r.account_id, r.id)));
    } catch (e) { fail(res, e); }
  });
  app.post('/api/bank/reconcile/r/:id/finish', ...BK, async (req, res) => {
    try {
      const { rows: rr } = await query(`SELECT * FROM bank_recons WHERE id = $1 AND status = 'open'`, [parseInt(req.params.id, 10)]);
      if (!rr.length) throw httpError(409, 'No open reconciliation');
      const v = await reconView(rr[0].account_id, rr[0].id);
      if (Math.abs(v.difference) > 0.005) throw httpError(409, 'The difference is ' + money(v.difference) + '. Tick the items on the statement, or enter bank charges / an adjustment.');
      await query(`UPDATE bank_recons SET status = 'done', finished_by = $2, finished_at = NOW() WHERE id = $1`, [rr[0].id, req.session.userId]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/bank/reconcile/r/:id/cancel', ...BK, async (req, res) => {
    try {
      const { rowCount } = await query(`DELETE FROM bank_recons WHERE id = $1 AND status = 'open'`, [parseInt(req.params.id, 10)]);
      if (!rowCount) throw httpError(409, 'No open reconciliation');
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  // Undo the most recent finished reconciliation (its items become uncleared again).
  app.post('/api/bank/reconcile/:accountId/undo-last', ...BK, async (req, res) => {
    try {
      const a = await bankAccount(req.params.accountId);
      const { rows: open } = await query(`SELECT 1 FROM bank_recons WHERE account_id = $1 AND status = 'open'`, [a.id]);
      if (open.length) throw httpError(409, 'Finish or cancel the open reconciliation first');
      const { rows } = await query(`SELECT id FROM bank_recons WHERE account_id = $1 AND status = 'done' ORDER BY statement_date DESC, id DESC LIMIT 1`, [a.id]);
      if (!rows.length) throw httpError(409, 'Nothing to undo');
      await query(`DELETE FROM bank_recons WHERE id = $1`, [rows[0].id]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ---------------------------------------------------- statement import --
  function parseCsv(text) {
    const rows = []; let row = [], cell = '', q = false;
    const s = String(text || '').replace(/^﻿/, '');
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (q) { if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
      else if (ch === '"') q = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some((c) => c.trim() !== '')) rows.push(row); row = []; }
      else cell += ch;
    }
    row.push(cell); if (row.some((c) => c.trim() !== '')) rows.push(row);
    return rows;
  }
  function parseDate(v, order) {
    v = String(v || '').trim();
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(v);
    if (m) return m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
    m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/.exec(v);
    if (m) {
      const y = m[3].length === 2 ? '20' + m[3] : m[3];
      const [d, mo] = order === 'mdy' ? [m[2], m[1]] : [m[1], m[2]];
      if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31) return null;
      return y + '-' + mo.padStart(2, '0') + '-' + d.padStart(2, '0');
    }
    m = /^(\d{1,2})[ \-]([A-Za-z]{3})[A-Za-z]*[ \-,]+(\d{2,4})$/.exec(v);
    if (m) {
      const mo = 'janfebmaraprmayjunjulaugsepoctnovdec'.indexOf(m[2].toLowerCase()) / 3 + 1;
      if (mo < 1 || mo % 1) return null;
      return (m[3].length === 2 ? '20' + m[3] : m[3]) + '-' + String(mo).padStart(2, '0') + '-' + m[1].padStart(2, '0');
    }
    return null;
  }
  const num = (v) => {
    let s = String(v || '').trim();
    if (!s) return null;
    const neg = /^\(.*\)$/.test(s) || /-$/.test(s) || /^-/.test(s) || /\bDR\b/i.test(s);
    s = s.replace(/[^0-9.]/g, '');
    if (!s) return null;
    const x = Number(s);
    return isNaN(x) ? null : (neg ? -x : x);
  };
  app.post('/api/bank/import/:accountId', ...BK, async (req, res) => {
    try {
      const a = await bankAccount(req.params.accountId);
      const b = req.body || {};
      const rows = parseCsv(String(b.csv || '').slice(0, 2000000));
      if (rows.length < 2) throw httpError(400, 'Paste or choose the CSV file from the bank (with a heading row)');
      const head = rows[0].map((h) => h.trim().toLowerCase());
      const find = (...names) => head.findIndex((h) => names.some((x) => h === x || h.includes(x)));
      const ci = { date: find('date', 'posted'), desc: find('description', 'details', 'narrative', 'memo', 'particulars', 'payee'),
        amount: head.findIndex((h) => /^(amount|amount \(jmd\)|transaction amount|amt)$/.test(h)), debit: find('debit', 'withdrawal', 'money out', 'paid out'), credit: find('credit', 'deposit', 'money in', 'paid in') };
      if (ci.date < 0 || ci.desc < 0 || (ci.amount < 0 && ci.debit < 0 && ci.credit < 0)) throw httpError(400, 'Could not find the Date, Description and Amount (or Debit / Credit) columns in the heading row: ' + rows[0].join(', '));
      const order = b.date_order === 'mdy' ? 'mdy' : 'dmy';
      const seen = {}, out = { added: 0, duplicates: 0, skipped: 0 };
      const ref = 'import ' + new Date().toISOString().slice(0, 16);
      for (const r of rows.slice(1)) {
        const date = parseDate(r[ci.date], order);
        let amt = ci.amount >= 0 ? num(r[ci.amount]) : null;
        if (amt == null) {
          const d = ci.debit >= 0 ? num(r[ci.debit]) : null, c2 = ci.credit >= 0 ? num(r[ci.credit]) : null;
          amt = d || c2 ? (c2 ? Math.abs(c2) : 0) - (d ? Math.abs(d) : 0) : null;
        }
        const desc = String(r[ci.desc] || '').trim().slice(0, 200);
        if (!date || amt == null || !amt || !desc) { out.skipped++; continue; }
        const base = date + '|' + r2(amt) + '|' + desc.toLowerCase();
        seen[base] = (seen[base] || 0) + 1;   // the same line twice on one statement is two lines
        const hash = crypto.createHash('sha256').update(base + '|' + seen[base]).digest('hex').slice(0, 32);
        const { rowCount } = await query(`INSERT INTO bank_feed_lines (account_id, import_ref, txn_date, description, amount, line_hash, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (account_id, line_hash) DO NOTHING`,
          [a.id, ref, date, desc, r2(amt), hash, req.session.userId]);
        if (rowCount) out.added++; else out.duplicates++;
      }
      res.json(Object.assign({ ok: true }, out));
    } catch (e) { fail(res, e); }
  });
  app.get('/api/bank/feed/:accountId', ...BK, async (req, res) => {
    try {
      const a = await bankAccount(req.params.accountId);
      const st = ['new', 'matched', 'added', 'ignored'].includes(req.query.status) ? req.query.status : 'new';
      const { rows } = await query(
        `SELECT f.id, to_char(f.txn_date, 'YYYY-MM-DD') AS day, f.description, f.amount::float AS amount, f.status, f.gl_line_id::int AS gl_line_id, f.bank_txn_id,
                f.source, f.payee, f.reference, f.note, CASE WHEN ga.is_active AND ga.qb_type NOT IN ('AR', 'AP') THEN f.suggest_account_id END AS suggest_account_id
           FROM bank_feed_lines f LEFT JOIN gl_accounts ga ON ga.id = f.suggest_account_id
          WHERE f.account_id = $1 AND f.status = $2 ORDER BY f.txn_date DESC, f.id DESC LIMIT 500`, [a.id, st]);
      const rules = await rulesWithSplits(`ORDER BY length(r.contains) DESC`);
      if (st === 'new') {
        for (const f of rows) {
          // Ledger lines on this account: same amount, within a week, not matched to another statement line.
          const { rows: m } = await query(
            `SELECT l.id::int AS id, to_char(e.entry_date, 'YYYY-MM-DD') AS day, e.number, e.source_ref AS ref, COALESCE(l.party, e.memo) AS what, l.amount::float AS amount
               FROM gl_lines l JOIN gl_entries e ON e.id = l.entry_id
              WHERE l.account_id = $1 AND abs(l.amount - $2) < 0.005 AND e.entry_date BETWEEN $3::date - 7 AND $3::date + 7
                AND NOT EXISTS (SELECT 1 FROM bank_feed_lines f2 WHERE f2.gl_line_id = l.id AND f2.status = 'matched')
              ORDER BY abs(e.entry_date - $3::date), l.id LIMIT 3`, [a.id, f.amount, f.day]);
          f.matches = m;
          const rule = rules.find((r) => f.description.toLowerCase().includes(r.contains.toLowerCase()));
          if (rule) {
            f.rule = { id: rule.id, account_id: rule.gl_account_id, account: rule.account, payee: rule.payee, mode: rule.mode };
            // A split rule: the lines it would make for this amount (or why it cannot), offered with "use one account instead".
            if (rule.mode === 'split') { try { f.rule.split = splitAmount(rule.splits, Math.abs(f.amount)); } catch (e) { f.rule.split_error = e.publicMessage || e.message; } }
          }
        }
      }
      res.json({ lines: rows });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/bank/feed/:id/match', ...BK, async (req, res) => {
    try {
      const { rows: f } = await query(`SELECT * FROM bank_feed_lines WHERE id = $1 AND status = 'new'`, [parseInt(req.params.id, 10)]);
      if (!f.length) throw httpError(409, 'Already dealt with');
      const gid = parseInt((req.body || {}).gl_line_id, 10);
      const { rows: l } = await query(`SELECT l.amount::float AS amount FROM gl_lines l WHERE l.id = $1 AND l.account_id = $2 AND NOT EXISTS (SELECT 1 FROM bank_feed_lines x WHERE x.gl_line_id = l.id AND x.status = 'matched')`, [gid || 0, f[0].account_id]);
      if (!l.length) throw httpError(400, 'That ledger line is not available');
      if (Math.abs(l[0].amount - Number(f[0].amount)) > 0.005) throw httpError(400, 'The amounts differ');
      await query(`UPDATE bank_feed_lines SET status = 'matched', gl_line_id = $2 WHERE id = $1`, [f[0].id, gid]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/bank/feed/:id/add', ...BK, async (req, res) => {
    try {
      const b = req.body || {};
      const { rows: f } = await query(`SELECT *, to_char(txn_date, 'YYYY-MM-DD') AS day, amount::float AS amt FROM bank_feed_lines WHERE id = $1 AND status = 'new'`, [parseInt(req.params.id, 10)]);
      if (!f.length) throw httpError(409, 'Already dealt with');
      const line = f[0];
      const payee = String(b.payee || '').trim().slice(0, 80) || line.payee || null;
      // The rule's split, unless staff chose one account for this line.
      let txLines;
      if (b.use_split && b.rule_id) {
        const [rule] = await rulesWithSplits('', parseInt(b.rule_id, 10));
        if (!rule || rule.mode !== 'split') throw httpError(409, 'That rule no longer splits: choose one account');
        txLines = splitAmount(rule.splits, Math.abs(line.amt)).map((x) => ({ account_id: x.account_id, amount: x.amount, memo: x.memo || line.description, class_id: x.class_id }));
        if (txLines.some((x) => x.account_id === line.account_id)) throw httpError(400, 'A split line cannot use the bank account itself');
      } else {
        const one = await lineAccount(b.account_id);
        if (one.id === line.account_id) throw httpError(400, 'Choose the other side of the transaction');
        txLines = [{ account_id: one.id, amount: Math.abs(line.amt), memo: line.description, class_id: await classId(b.class_id) }];
      }
      const la = { id: txLines[0].account_id };
      const t = await tx(async (c) => {
        const out = await makeTxn(c, { kind: line.amt < 0 ? 'expense' : 'deposit', accountId: line.account_id, date: line.day, payee, supplierId: null, cheque: null, reference: line.reference || null,
          memo: String(b.memo || line.description).slice(0, 300), lines: txLines, userId: req.session.userId });
        await c.query(`UPDATE bank_feed_lines SET status = 'added', bank_txn_id = $2 WHERE id = $1`, [line.id, out.id]);
        if (b.make_rule && String(b.rule_text || '').trim().length >= 3) await c.query(`INSERT INTO bank_rules (contains, gl_account_id, payee, created_by) VALUES ($1,$2,$3,$4)`, [String(b.rule_text).trim().slice(0, 80), la.id, payee, req.session.userId]);
        return out;
      });
      await post();
      // The new transaction's bank line is what the statement line shows: mark it matched.
      const { rows: gl } = await query(`SELECT l.id FROM gl_lines l JOIN gl_entries e ON e.id = l.entry_id WHERE e.source_kind = 'bank_txn' AND e.source_id = $1 AND l.account_id = $2`, [t.id, line.account_id]);
      if (gl.length) await query(`UPDATE bank_feed_lines SET gl_line_id = $2, status = 'matched' WHERE id = $1`, [line.id, gl[0].id]);
      res.json({ ok: true, id: t.id });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/bank/feed/:id/ignore', ...BK, async (req, res) => {
    try {
      const undo = !!(req.body || {}).undo;
      const { rowCount } = await query(`UPDATE bank_feed_lines SET status = $2 WHERE id = $1 AND status = $3`, [parseInt(req.params.id, 10), undo ? 'new' : 'ignored', undo ? 'ignored' : 'new']);
      if (!rowCount) throw httpError(409, 'Already dealt with');
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  // Statement rules: text in the description -> one account (as before), or a
  // split across several accounts and classes: fixed amounts, percentages, and
  // one "rest" line for what the others leave. gl_account_id stays the account
  // used when staff choose "use one account instead" for a line.
  async function rulesWithSplits(order, id) {
    const { rows } = await query(`SELECT r.*, a.code, a.name AS account FROM bank_rules r JOIN gl_accounts a ON a.id = r.gl_account_id${id ? ' WHERE r.id = $1' : ''} ${order || 'ORDER BY r.contains'}`, id ? [id] : []);
    const { rows: sp } = rows.length ? await query(`SELECT s.*, s.value::float AS value, a.code || ' ' || a.name AS account, c.name AS class FROM bank_rule_splits s JOIN gl_accounts a ON a.id = s.account_id LEFT JOIN gl_classes c ON c.id = s.class_id
                                                    WHERE s.rule_id = ANY($1) ORDER BY s.rule_id, s.sort, s.id`, [rows.map((r) => r.id)]) : { rows: [] };
    for (const r of rows) r.splits = sp.filter((x) => x.rule_id === r.id);
    return rows;
  }
  // The split of one amount: fixed amounts first, then percentages; the rest line takes what is left.
  function splitAmount(splits, total) {
    if (!splits || !splits.length) throw httpError(400, 'This rule has no split lines');
    let left = r2(total);
    const out = splits.map((x) => ({ account_id: x.account_id, class_id: x.class_id || null, memo: x.memo || null, kind: x.kind, value: n(x.value), amount: 0 }));
    for (const x of out) if (x.kind === 'amount') { x.amount = r2(x.value); left = r2(left - x.amount); }
    for (const x of out) if (x.kind === 'percent') { x.amount = r2(total * x.value / 100); left = r2(left - x.amount); }
    const rest = out.filter((x) => x.kind === 'rest');
    if (rest.length) rest[0].amount = left;
    else if (Math.abs(left) > 0.005) throw httpError(400, 'The split adds up to ' + money(r2(total - left)) + ', not ' + money(total) + ': add a "rest" line');
    if (out.some((x) => x.amount < 0)) throw httpError(400, 'The fixed amounts are more than the statement line (' + money(total) + ')');
    return out.filter((x) => x.amount > 0).map((x) => ({ account_id: x.account_id, class_id: x.class_id, memo: x.memo, amount: x.amount }));
  }
  async function ruleInput(b) {
    const contains = String(b.contains || '').trim().slice(0, 80);
    if (contains.length < 3) throw httpError(400, 'The text to look for (3 letters or more)');
    const mode = b.mode === 'split' ? 'split' : 'single';
    const splits = [];
    if (mode === 'split') {
      const raw = Array.isArray(b.splits) ? b.splits : [];
      for (let i = 0; i < raw.length; i++) {
        const x = raw[i];
        if (!x || !x.account_id) continue;
        const kind = ['amount', 'percent', 'rest'].includes(x.kind) ? x.kind : null;
        if (!kind) throw httpError(400, 'Each split line is a fixed amount, a percentage, or the rest');
        const value = kind === 'rest' ? null : r2(x.value);
        if (kind !== 'rest' && !(value > 0)) throw httpError(400, 'Give each fixed amount / percentage');
        if (kind === 'percent' && value > 100) throw httpError(400, 'A percentage over 100');
        splits.push({ sort: i, account_id: (await lineAccount(x.account_id)).id, class_id: await classId(x.class_id), kind, value, memo: String(x.memo || '').slice(0, 200) || null });
      }
      if (splits.length < 2) throw httpError(400, 'A split needs at least two lines');
      if (splits.filter((x) => x.kind === 'rest').length > 1) throw httpError(400, 'Only one line can take the rest');
      const pct = splits.filter((x) => x.kind === 'percent').reduce((t, x) => t + x.value, 0);
      if (!splits.some((x) => x.kind === 'rest') && (splits.some((x) => x.kind === 'amount') || Math.abs(pct - 100) > 0.001))
        throw httpError(400, 'Add a "rest" line (or make the percentages add up to 100) so every statement amount is covered');
    }
    const single = b.account_id ? (await lineAccount(b.account_id)).id : splits.length ? splits[0].account_id : null;
    if (!single) throw httpError(400, 'Choose the account');
    return { contains, mode, splits, account_id: single, payee: String(b.payee || '').trim().slice(0, 80) || null };
  }
  async function saveRule(c, id, x, userId) {
    let rid = id;
    if (id) await c.query(`UPDATE bank_rules SET contains = $2, gl_account_id = $3, payee = $4, mode = $5 WHERE id = $1`, [id, x.contains, x.account_id, x.payee, x.mode]);
    else rid = (await c.query(`INSERT INTO bank_rules (contains, gl_account_id, payee, mode, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [x.contains, x.account_id, x.payee, x.mode, userId])).rows[0].id;
    await c.query(`DELETE FROM bank_rule_splits WHERE rule_id = $1`, [rid]);
    for (const sp of x.splits) await c.query(`INSERT INTO bank_rule_splits (rule_id, sort, account_id, class_id, kind, value, memo) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [rid, sp.sort, sp.account_id, sp.class_id, sp.kind, sp.value, sp.memo]);
    return rid;
  }
  app.get('/api/bank/rules', ...BK, async (req, res) => {
    try { res.json({ rules: await rulesWithSplits() }); } catch (e) { fail(res, e); }
  });
  app.post('/api/bank/rules', ...BK, async (req, res) => {
    try { const x = await ruleInput(req.body || {}); const id = await tx((c) => saveRule(c, null, x, req.session.userId)); res.json({ ok: true, id }); } catch (e) { fail(res, e); }
  });
  // Try a split on an amount (the rules screen previews it). Registered before /:id.
  app.post('/api/bank/rules/preview', ...BK, async (req, res) => {
    try { const x = await ruleInput(Object.assign({}, req.body, { mode: 'split' })); res.json({ lines: splitAmount(x.splits, Math.abs(r2((req.body || {}).amount)) || 100000) }); } catch (e) { fail(res, e); }
  });
  app.put('/api/bank/rules/:id', ...BK, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!(await rulesWithSplits('', id)).length) throw httpError(404, 'Rule not found');
      const x = await ruleInput(req.body || {});
      await tx((c) => saveRule(c, id, x, req.session.userId));
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.delete('/api/bank/rules/:id', ...BK, async (req, res) => {
    try { await query(`DELETE FROM bank_rules WHERE id = $1`, [parseInt(req.params.id, 10)]); res.json({ ok: true }); } catch (e) { fail(res, e); }
  });

  // --------------------------------------------------- QuickBooks import --
  // Bringing payables and banking over from QuickBooks (Desktop or Online):
  //   Supplier list  the Vendor List as IIF (!VEND) or CSV: adds suppliers not
  //                  here yet and fills blank phone, email, address and terms.
  //   Unpaid bills   the Unpaid Bills Detail report as CSV: each open bill or
  //                  bill credit becomes a bill here for what is still owed.
  //                  QuickBooks already counted its cost, so it is booked
  //                  against Opening Balance Equity unless another account is
  //                  chosen: only the amount owed reaches the books.
  //   Bank register  one account's register or Transaction Detail report as
  //                  CSV: each line from a date on (the ledger start) joins the
  //                  Bank statement review list, with QuickBooks's own account
  //                  (the Split column) and payee suggested, to match or add.
  // Each is previewed first against what is here: a later file updates what
  // changed (or, with "replace", makes what came from QuickBooks match it).
  const qnorm = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/\b(ltd|limited|co|company|inc|incorporated|the)\b\.?/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
  // The heading row: QuickBooks puts the report title and dates above it.
  function headingRow(rows, need) {
    for (let i = 0; i < Math.min(rows.length, 15); i++) {
      const h = rows[i].map((c) => c.trim().toLowerCase());
      if (need.every((alts) => h.some((x) => alts.includes(x)))) return { i, h };
    }
    return null;
  }
  const colOf = (h, ...names) => { for (const nm of names) { const k = h.indexOf(nm); if (k >= 0) return k; } return -1; };
  // "Net 30" -> 30, "Due on receipt" -> 0, "1% 10 Net 30" -> 30.
  function termsDays(t) {
    t = String(t || '').toLowerCase();
    if (!t) return null;
    if (/receipt|c\.?o\.?d|on delivery|cash/.test(t)) return 0;
    const m = /(\d{1,3})/.exec(t.replace(/\d+(\.\d+)?\s*%\s*\d+/, ''));
    return m && +m[1] <= 365 ? +m[1] : null;
  }
  function iifRows(text, kind) {
    const out = []; let head = null;
    for (const line of String(text).split(/\r?\n/)) {
      const c = line.split('\t').map((x) => x.replace(/^"|"$/g, '').trim());
      if (c[0] === '!' + kind) head = c.map((x) => x.toUpperCase());
      else if (c[0] === kind && head) out.push(Object.fromEntries(head.map((h, i) => [h, c[i] || ''])));
    }
    return out;
  }
  // The group a QuickBooks report row sits under (a vendor, or an account): the
  // text of a row with no date that is not a "Total ..." row.
  function groupLabel(r, dateCol) {
    if (String(r[dateCol] || '').trim()) return null;
    const t = r.map((c) => c.trim()).find(Boolean);
    return t && !/^total\b/i.test(t) ? t : null;
  }
  async function supplierMatcher() {
    const { rows } = await query(`SELECT id, name, phone, email, address, contact_name, payment_terms, payment_terms_days, account_number, tax_id FROM suppliers WHERE name IS NOT NULL AND name <> ''`);
    const exact = new Map(), loose = new Map();
    for (const s of rows) { exact.set(s.name.trim().toLowerCase(), s); if (!loose.has(qnorm(s.name))) loose.set(qnorm(s.name), s); }
    return (name) => {
      const e = exact.get(String(name || '').trim().toLowerCase());
      if (e) return { s: e, how: 'exact' };
      const l = qnorm(name) && loose.get(qnorm(name));
      return l ? { s: l, how: 'similar' } : null;
    };
  }
  const ledgerStart = async () => {
    const { rows } = await query(`SELECT to_char((value::timestamptz AT TIME ZONE 'America/Jamaica')::date, 'YYYY-MM-DD') AS d FROM warehouse_settings WHERE key = 'gl_start_at' AND value IS NOT NULL AND value <> ''`);
    return rows.length ? rows[0].d : null;
  };

  // Each import compares the file with what is here. Rows come back as new,
  // changed (with each difference), same, gone (here from an earlier import
  // but no longer in the file) or locked (changed in QuickBooks but already
  // used here, so left for a person). Two modes: "update" changes only what
  // the file changes; "replace" makes what came from QuickBooks match the file
  // exactly, blanks and removals included. Nothing that staff have used here
  // (a paid bill, a statement line already matched or added) is ever changed.
  const IMPORT_MODES = ['update', 'replace'];
  const sameText = (a, b) => String(a == null ? '' : a).trim().replace(/\s+/g, ' ').toLowerCase() === String(b == null ? '' : b).trim().replace(/\s+/g, ' ').toLowerCase();

  // ---- Supplier list
  function parseVendors(text) {
    const s = String(text || '');
    if (/^!VEND\t/m.test(s)) {
      return iifRows(s, 'VEND').map((v) => ({
        name: v.NAME, phone: v.PHONE1 || v.PHONE2 || '', email: v.EMAIL || '', contact: v.CONT1 || '', terms: v.TERMS || '', tax_id: v.TAXID || '', account_number: v.ACCNUM || '',
        address: ['ADDR1', 'ADDR2', 'ADDR3', 'ADDR4', 'ADDR5'].map((k) => v[k]).filter(Boolean).join(', '),
      }));
    }
    const rows = parseCsv(s);
    const hr = headingRow(rows, [['vendor', 'name', 'vendor name', 'supplier', 'company', 'company name', 'display name']]);
    if (!hr) throw httpError(400, 'This does not look like a QuickBooks vendor list: no Vendor or Name heading. Export it as IIF, or as CSV from the Vendor Contact List.');
    const h = hr.h, c = {
      name: colOf(h, 'vendor', 'vendor name', 'supplier', 'display name', 'name', 'company', 'company name'), phone: colOf(h, 'main phone', 'phone', 'phone numbers', 'work phone'),
      email: colOf(h, 'main email', 'email', 'e-mail'), address: colOf(h, 'bill from', 'billing address', 'address', 'street'), contact: colOf(h, 'primary contact', 'contact', 'full name'),
      terms: colOf(h, 'terms'), account_number: colOf(h, 'account no.', 'account #', 'account number', 'account no'), tax_id: colOf(h, 'tax id', 'tax id.', 'trn', 'business id no.'),
    };
    const get = (r, k) => (c[k] >= 0 ? String(r[c[k]] || '').trim() : '');
    return rows.slice(hr.i + 1).map((r) => ({ name: get(r, 'name'), phone: get(r, 'phone'), email: get(r, 'email'), address: get(r, 'address'), contact: get(r, 'contact'), terms: get(r, 'terms'), account_number: get(r, 'account_number'), tax_id: get(r, 'tax_id') }))
      .filter((v) => v.name && !/^total\b/i.test(v.name));
  }
  // Supplier column <- file field, with its label and limit.
  const VEND_FIELDS = [['phone', 'phone', 'Phone', 40], ['email', 'email', 'Email', 120], ['address', 'address', 'Address', 300], ['contact_name', 'contact', 'Contact', 80],
    ['payment_terms', 'terms', 'Terms', 40], ['payment_terms_days', 'terms_days', 'Terms (days)', 0], ['account_number', 'account_number', 'Account no.', 40], ['tax_id', 'tax_id', 'Tax ID', 40]];
  // The changes a file row makes to a supplier: in "update" only fields the file fills in;
  // in "replace" every field, so a blank in QuickBooks blanks it here, and the name too.
  function vendorChanges(s, v, mode) {
    const out = [];
    if (mode === 'replace' && s.name !== v.name) out.push({ field: 'name', label: 'Name', from: s.name, to: v.name });
    for (const [colName, key, label, max] of VEND_FIELDS) {
      const to = key === 'terms_days' ? v.terms_days : (max ? String(v[key] || '').slice(0, max) : v[key]) || null, from = s[colName];
      if (mode === 'update' && (to == null || to === '')) continue;
      if (key === 'terms_days' ? (from == null ? null : +from) !== to : !sameText(from, to)) out.push({ field: colName, label, from: from == null ? '' : from, to: to == null ? '' : to });
    }
    return out;
  }
  async function vendorPreview(text, mode) {
    const list = parseVendors(text), match = await supplierMatcher(), seen = new Set();
    return list.map((v, i) => {
      const key = v.name.toLowerCase(), m = match(v.name);
      const row = Object.assign({ i, terms_days: termsDays(v.terms) }, v, { name: v.name.slice(0, 120) });
      if (seen.has(key)) return Object.assign(row, { status: 'duplicate', reason: 'Twice in the file' });
      seen.add(key);
      if (!m) return Object.assign(row, { status: 'new' });
      const changes = vendorChanges(m.s, row, mode);
      return Object.assign(row, { status: changes.length ? 'changed' : 'same', supplier_id: m.s.id, supplier: m.s.name, how: m.how, changes });
    });
  }
  app.post('/api/ap/import/suppliers', ...AP, async (req, res) => {
    try {
      const b = req.body || {}, mode = IMPORT_MODES.includes(b.mode) ? b.mode : 'update';
      const rows = await vendorPreview(String(b.file || '').slice(0, 5000000), mode);
      if (!rows.length) throw httpError(400, 'No suppliers found in the file');
      if (b.preview) return res.json({ rows, mode });
      const take = new Set((Array.isArray(b.include) ? b.include : []).map(Number));
      const out = { added: 0, updated: 0 };
      await tx(async (c) => {
        for (const v of rows.filter((x) => take.has(x.i))) {
          if (v.status === 'new') {
            const f = VEND_FIELDS.map(([, key, , max]) => (key === 'terms_days' ? v.terms_days : String(v[key] || '').slice(0, max) || null));
            await c.query(`INSERT INTO suppliers (name, phone, email, address, contact_name, payment_terms, payment_terms_days, account_number, tax_id, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'From QuickBooks')`, [v.name].concat(f));
            out.added++;
          } else if (v.status === 'changed') {
            const sets = v.changes.map((x, k) => x.field + ' = $' + (k + 2)), vals = v.changes.map((x) => (x.to === '' ? null : x.to));
            await c.query(`UPDATE suppliers SET ${sets.join(', ')} WHERE id = $1`, [v.supplier_id].concat(vals));
            out.updated++;
          }
        }
      });
      res.json(Object.assign({ ok: true }, out));
    } catch (e) { fail(res, e); }
  });

  // ---- Unpaid bills
  function parseUnpaid(text, order) {
    const rows = parseCsv(text);
    const hr = headingRow(rows, [['date', 'trans date', 'transaction date', 'bill date'], ['open balance', 'open bal', 'open', 'balance due', 'amount', 'balance']]);
    if (!hr) throw httpError(400, 'This does not look like an Unpaid Bills report: it needs Date and Open Balance headings. In QuickBooks run Unpaid Bills Detail and save it as CSV.');
    const h = hr.h, c = {
      date: colOf(h, 'date', 'bill date', 'transaction date', 'trans date'), type: colOf(h, 'type', 'transaction type'), num: colOf(h, 'num', 'no.', 'ref no.', 'bill no.', 'number', 'ref no'),
      due: colOf(h, 'due date', 'due'), open: colOf(h, 'open balance', 'open bal', 'open', 'balance due', 'balance'), amount: colOf(h, 'amount', 'original amount', 'total'), vendor: colOf(h, 'vendor', 'name', 'supplier', 'payee'),
    };
    const out = []; let group = null;
    for (const r of rows.slice(hr.i + 1)) {
      const g = groupLabel(r, c.date);
      if (g) { group = g; continue; }
      const date = parseDate(r[c.date], order);
      if (!date) continue;
      const type = c.type >= 0 ? String(r[c.type] || '').trim() : 'Bill';
      if (/pmt|payment|check|cheque|deposit|journal/i.test(type)) continue;
      let amt = c.open >= 0 ? num(r[c.open]) : null;
      if (amt == null && c.amount >= 0) amt = num(r[c.amount]);
      if (!amt) continue;
      const vendor = (c.vendor >= 0 ? String(r[c.vendor] || '').trim() : '') || group || '';
      out.push({ vendor: vendor.slice(0, 120), type: type || 'Bill', kind: /credit/i.test(type) || amt < 0 ? 'credit' : 'bill', number: c.num >= 0 ? String(r[c.num] || '').trim().slice(0, 60) : '',
        date, due: c.due >= 0 ? parseDate(r[c.due], order) : null, amount: r2(Math.abs(amt)) });
    }
    return out;
  }
  // Bills brought over from QuickBooks before, still open here, with what has been paid on them here.
  async function importedBills() {
    const { rows } = await query(
      `SELECT b.id, b.kind, b.supplier_id, s.name AS supplier, b.number, to_char(b.bill_date, 'YYYY-MM-DD') AS date, to_char(b.due_date, 'YYYY-MM-DD') AS due, b.total::float AS amount,
              COALESCE((SELECT SUM(a.amount) FROM ap_applications a JOIN ap_payments p ON p.id = a.payment_id WHERE p.voided_at IS NULL AND a.bill_kind IN ('bill', 'credit') AND a.bill_id = b.id), 0)::float AS used
         FROM ap_bills b JOIN suppliers s ON s.id = b.supplier_id WHERE b.voided_at IS NULL AND b.source = 'quickbooks'`);
    return rows;
  }
  async function billPreview(text, order) {
    const list = parseUnpaid(text, order), match = await supplierMatcher(), seen = new Set(), prior = await importedBills(), claimed = new Set();
    const docsBy = {};
    const docsOf = async (sid) => (docsBy[sid] = docsBy[sid] || (await apDocs(sid)));
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const b = Object.assign({ i }, list[i]), m = b.vendor ? match(b.vendor) : null;
      if (m) { b.supplier_id = m.s.id; b.supplier = m.s.name; b.how = m.how; }
      const key = [qnorm(b.vendor), b.kind, b.number.toLowerCase() || b.date + '|' + b.amount].join('|');
      if (!b.vendor) { b.status = 'error'; b.reason = 'No supplier name'; }
      else if (seen.has(key)) { b.status = 'duplicate'; b.reason = 'Twice in the file'; }
      else if (m) {
        // The same bill from an earlier import: by number, or with no number by date (then amount).
        const was = prior.find((p) => !claimed.has(p.id) && p.supplier_id === m.s.id && p.kind === b.kind && (b.number ? sameText(p.number, b.number) : !p.number && p.date === b.date && Math.abs(p.amount - b.amount) < 0.005))
          || (!b.number && prior.find((p) => !claimed.has(p.id) && p.supplier_id === m.s.id && p.kind === b.kind && !p.number && p.date === b.date));
        if (was) {
          claimed.add(was.id);
          b.bill_id = was.id;
          const changes = [];
          if (Math.abs(was.amount - b.amount) > 0.005) changes.push({ field: 'amount', label: 'Owed', from: was.amount, to: b.amount });
          if (was.date !== b.date) changes.push({ field: 'date', label: 'Date', from: was.date, to: b.date });
          if (b.kind === 'bill' && b.due && was.due !== b.due) changes.push({ field: 'due', label: 'Due', from: was.due, to: b.due });
          b.changes = changes;
          if (!changes.length) { b.status = 'same'; b.reason = 'Already brought over, unchanged'; }
          else if (was.used > 0.005) { b.status = 'locked'; b.reason = money(was.used) + ' of it has been paid here: change it by hand if QuickBooks is right'; }
          else { b.status = 'changed'; b.reason = 'Changed in QuickBooks since the last import'; }
        } else {
          const { rows: dup } = await query(
            `SELECT COALESCE(number, '#' || id) AS number FROM ap_bills WHERE supplier_id = $1 AND kind = $2 AND voided_at IS NULL
                AND (($3 <> '' AND lower(number) = lower($3)) OR ($3 = '' AND bill_date = $4 AND total = $5)) LIMIT 1`, [m.s.id, b.kind, b.number, b.date, b.amount]);
          if (dup.length) { b.status = 'duplicate'; b.reason = 'Already entered here as ' + (b.kind === 'credit' ? 'credit ' : 'bill ') + dup[0].number + ' (not from QuickBooks, so left alone)'; }
          else {
            const same = (await docsOf(m.s.id)).find((d) => (d.kind === 'receipt' || d.kind === 'po') && d.open > 0.005 && ((b.number && String(d.number || '').toLowerCase() === b.number.toLowerCase()) || Math.abs(d.open - b.amount) < 0.005));
            if (same) { b.status = 'in_system'; b.reason = 'Already owed here from purchasing: ' + (same.kind === 'receipt' ? 'goods receipt ' : 'PO ') + same.number + ' (' + money(same.open) + ')'; }
            else b.status = 'new';
          }
        }
      } else b.status = 'new';
      seen.add(key);
      out.push(b);
    }
    // Brought over before but not in this file: paid or removed in QuickBooks.
    let k = list.length;
    for (const p of prior.filter((x) => !claimed.has(x.id))) {
      out.push({ i: k++, gone: true, bill_id: p.id, vendor: p.supplier, supplier: p.supplier, supplier_id: p.supplier_id, kind: p.kind, number: p.number || '', date: p.date, due: p.due, amount: p.amount,
        status: p.used > 0.005 ? 'locked' : 'gone', reason: p.used > 0.005 ? 'Not in the file any more, but ' + money(p.used) + ' has been paid here: left alone' : 'Not in QuickBooks\' unpaid list any more (paid or removed there): void it here' });
    }
    return out;
  }
  app.post('/api/ap/import/bills', ...AP, async (req, res) => {
    try {
      const b = req.body || {}, order = b.date_order === 'dmy' ? 'dmy' : 'mdy';
      const rows = await billPreview(String(b.file || '').slice(0, 5000000), order);
      if (!rows.length) throw httpError(400, 'No unpaid bills found in the file');
      const { rows: oe } = await query(`SELECT id, code, name FROM gl_accounts WHERE system_key = 'opening_equity'`);
      if (b.preview) return res.json({ rows, ledger_start: await ledgerStart(), opening_equity: oe[0] || null });
      const take = new Set((Array.isArray(b.include) ? b.include : []).map(Number));
      const chosen = rows.filter((x) => take.has(x.i));
      if (!chosen.length) throw httpError(400, 'Tick what to import');
      if (chosen.some((x) => ['duplicate', 'error', 'same', 'locked'].includes(x.status))) throw httpError(400, 'A ticked row cannot be imported (a duplicate, unchanged, already paid here, or with no supplier)');
      const adding = chosen.filter((x) => x.status !== 'gone');
      const acct = adding.length ? await lineAccount(b.account_id) : null, cls = adding.length ? await classId(b.class_id) : null;
      if (!b.create_suppliers && adding.some((x) => !x.supplier_id)) throw httpError(400, 'Some suppliers are not here yet: tick "Add suppliers that are not here yet" or untick those bills');
      const reason = 'Replaced by QuickBooks import ' + today();
      const out = await tx(async (c) => {
        const made = {}, res2 = { bills: 0, credits: 0, suppliers: 0, total: 0, updated: 0, voided: 0 };
        // A changed or gone bill is voided (the ledger reverses it); a changed one is then entered again as it is now.
        const unpaid = async (id) => (await c.query(`SELECT 1 FROM ap_applications a JOIN ap_payments p ON p.id = a.payment_id WHERE p.voided_at IS NULL AND a.bill_kind IN ('bill', 'credit') AND a.bill_id = $1 LIMIT 1`, [id])).rows.length === 0;
        for (const x of chosen.filter((y) => y.status === 'changed' || y.status === 'gone')) {
          if (!(await unpaid(x.bill_id))) throw httpError(409, 'Bill ' + (x.number || '#' + x.bill_id) + ' has just been paid here: preview again');
          await c.query(`UPDATE ap_bills SET voided_at = NOW(), voided_by = $2, void_reason = $3 WHERE id = $1 AND voided_at IS NULL`, [x.bill_id, req.session.userId, x.status === 'gone' ? 'No longer unpaid in QuickBooks (' + today() + ')' : reason]);
          if (x.status === 'gone') res2.voided++; else res2.updated++;
        }
        for (const x of adding) {
          let sid = x.supplier_id;
          if (!sid) {
            const key = x.vendor.toLowerCase();
            if (!made[key]) { made[key] = (await c.query(`INSERT INTO suppliers (name, notes) VALUES ($1, 'From QuickBooks') RETURNING id`, [x.vendor])).rows[0].id; res2.suppliers++; }
            sid = made[key];
          }
          let due = x.kind === 'bill' ? x.due : null;
          if (x.kind === 'bill' && !due) {
            const { rows: t } = await c.query(`SELECT payment_terms_days FROM suppliers WHERE id = $1`, [sid]);
            due = new Date(Date.parse(x.date) + ((t[0] && t[0].payment_terms_days) || 0) * 86400000).toISOString().slice(0, 10);
          }
          const { rows: ins } = await c.query(
            `INSERT INTO ap_bills (kind, supplier_id, number, bill_date, due_date, memo, gct_amount, total, created_by, source) VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8,'quickbooks') RETURNING id`,
            [x.kind, sid, x.number || null, x.date, due, 'Imported from QuickBooks (' + x.type + ')', x.amount, req.session.userId]);
          await c.query(`INSERT INTO ap_bill_lines (bill_id, account_id, description, amount, class_id) VALUES ($1,$2,$3,$4,$5)`,
            [ins[0].id, acct.id, ('QuickBooks ' + x.type + ' ' + (x.number || '')).trim(), x.amount, cls]);
          if (x.status === 'new' || x.status === 'in_system') { if (x.kind === 'credit') res2.credits++; else res2.bills++; }
          res2.total = r2(res2.total + (x.kind === 'credit' ? -x.amount : x.amount));
        }
        return res2;
      });
      post();
      res.json(Object.assign({ ok: true }, out));
    } catch (e) { fail(res, e); }
  });

  // ---- Bank register
  function parseRegister(text, order) {
    const rows = parseCsv(text);
    const hr = headingRow(rows, [['date', 'trans date', 'transaction date']]);
    if (!hr) throw httpError(400, 'This does not look like a QuickBooks register or transaction report: no Date heading.');
    const h = hr.h, c = {
      date: colOf(h, 'date', 'transaction date', 'trans date'), type: colOf(h, 'type', 'transaction type'), num: colOf(h, 'num', 'number', 'no.', 'ref no.', 'ref no', 'check no.', 'ref'),
      name: colOf(h, 'name', 'payee', 'vendor', 'customer'), memo: colOf(h, 'memo', 'memo/description', 'description'), split: colOf(h, 'split', 'split account'),
      amount: colOf(h, 'amount'), debit: colOf(h, 'debit'), credit: colOf(h, 'credit'), pay: colOf(h, 'payment', 'payments', 'withdrawal'), dep: colOf(h, 'deposit', 'deposits'),
    };
    // A register export (Payment / Deposit columns) names the other side in its Account column.
    if (c.split < 0 && c.pay >= 0) c.split = colOf(h, 'account');
    if (c.amount < 0 && (c.debit < 0 || c.credit < 0) && (c.pay < 0 || c.dep < 0)) throw httpError(400, 'The report needs an Amount column, or Debit and Credit, or Payment and Deposit.');
    const out = []; let group = null; const groups = [];
    for (const r of rows.slice(hr.i + 1)) {
      const g = groupLabel(r, c.date);
      if (g) { group = g; if (!groups.includes(g)) groups.push(g); continue; }
      const date = parseDate(r[c.date], order);
      if (!date) continue;
      let amt;
      if (c.amount >= 0) amt = num(r[c.amount]);
      else if (c.debit >= 0 && c.credit >= 0) { const d = num(r[c.debit]), cr = num(r[c.credit]); amt = d || cr ? Math.abs(d || 0) - Math.abs(cr || 0) : null; }   // for a bank account a debit is money in
      else { const p = num(r[c.pay]), d = num(r[c.dep]); amt = p || d ? Math.abs(d || 0) - Math.abs(p || 0) : null; }
      if (!amt) continue;
      const get = (k) => (c[k] >= 0 ? String(r[c[k]] || '').trim() : '');
      out.push({ group, date, type: get('type'), num: get('num').slice(0, 40), name: get('name').slice(0, 80), memo: get('memo').slice(0, 200), split: get('split').slice(0, 160), amount: r2(amt) });
    }
    return { lines: out, groups };
  }
  app.post('/api/bank/import-qb/:accountId', ...BK, async (req, res) => {
    try {
      const a = await bankAccount(req.params.accountId);
      a.qb_name = (await query(`SELECT qb_name FROM gl_accounts WHERE id = $1`, [a.id])).rows[0].qb_name;
      const b = req.body || {}, order = b.date_order === 'dmy' ? 'dmy' : 'mdy', mode = IMPORT_MODES.includes(b.mode) ? b.mode : 'update';
      let { lines, groups } = parseRegister(String(b.file || '').slice(0, 5000000), order);
      // A report for several accounts: keep this account's section only.
      if (groups.length) {
        const mine = groups.filter((g) => { const x = g.toLowerCase(); return [a.name, a.qb_name].filter(Boolean).some((nm) => { const y = nm.toLowerCase(); return x === y || x.split(':').pop().trim() === y.split(':').pop().trim(); }); });
        if (mine.length) lines = lines.filter((l) => mine.includes(l.group));
        else if (groups.length > 1) throw httpError(400, 'The report has several accounts (' + groups.slice(0, 6).join(', ') + ') and none is ' + a.name + '. Export only this account, or give it its QuickBooks name in Accounting.');
      }
      const start = await ledgerStart(), from = isDate(b.from) ? b.from : start;
      const before = from ? lines.filter((l) => l.date < from).length : 0;
      if (from) lines = lines.filter((l) => l.date >= from);
      // QuickBooks's other-side account -> an account here, by QuickBooks name or name.
      const { rows: accts } = await query(`SELECT id, code, name, qb_name, qb_type, system_key FROM gl_accounts WHERE is_active`);
      const byName = new Map(), byId = new Map(accts.map((x) => [x.id, x]));
      for (const x of accts) for (const k of [x.qb_name, x.name, x.qb_name && x.qb_name.split(':').pop()]) if (k && !byName.has(k.trim().toLowerCase())) byName.set(k.trim().toLowerCase(), x);
      const seen = {};
      for (const l of lines) {
        const s = l.split.toLowerCase(), x = byName.get(s) || byName.get(s.split(':').pop().trim());
        if (/^-?split-?$/i.test(l.split)) l.note = 'Split across several accounts in QuickBooks';
        else if (x && (x.qb_type === 'AP' || x.system_key === 'ap')) l.note = 'A bill payment in QuickBooks: record it with Pay Bills, then match it here';
        else if (x && (x.qb_type === 'AR' || x.system_key === 'ar')) l.note = 'A customer payment in QuickBooks: record it with Receive Payment, then match it here';
        else if (x && x.id !== a.id) { l.account_id = x.id; l.account = x.code + ' ' + x.name; }
        else if (l.split) l.note = 'QuickBooks account "' + l.split + '" is not in the chart here';
        l.description = [l.type, l.name, l.memo].filter(Boolean).join(' · ').slice(0, 200) || 'QuickBooks';
        const base = 'qb|' + l.date + '|' + l.amount + '|' + l.num.toLowerCase() + '|' + l.name.toLowerCase() + '|' + l.memo.toLowerCase();
        seen[base] = (seen[base] || 0) + 1;
        l.hash = crypto.createHash('sha256').update(base + '|' + seen[base]).digest('hex').slice(0, 32);
      }
      // What earlier QuickBooks imports put in the review list for the same dates.
      const last = lines.reduce((m, l) => (l.date > m ? l.date : m), from || '0000-00-00');
      const { rows: prior } = lines.length ? await query(
        `SELECT id, to_char(txn_date, 'YYYY-MM-DD') AS date, description, amount::float AS amount, status, line_hash, payee, reference, suggest_account_id
           FROM bank_feed_lines WHERE account_id = $1 AND source = 'quickbooks' AND txn_date BETWEEN $2::date AND $3::date`, [a.id, from || '0001-01-01', last]) : { rows: [] };
      const byHash = new Map(prior.map((p) => [p.line_hash, p])), claimed = new Set();
      for (const l of lines) { const p = byHash.get(l.hash); if (p) { claimed.add(p.id); l.status = 'same'; l.feed_id = p.id; } }
      for (const l of lines.filter((x) => !x.status)) {
        // The same transaction changed in QuickBooks: same date and number (or, with no number, payee).
        const p = prior.find((q) => !claimed.has(q.id) && q.date === l.date && (l.num ? sameText(q.reference, l.num) : !q.reference && sameText(q.payee, l.name)));
        if (!p) { l.status = 'new'; continue; }
        claimed.add(p.id); l.feed_id = p.id;
        l.changes = [];
        if (Math.abs(p.amount - l.amount) > 0.005) l.changes.push({ label: 'Amount', from: p.amount, to: l.amount });
        if (!sameText(p.description, l.description)) l.changes.push({ label: 'Description', from: p.description, to: l.description });
        if ((p.suggest_account_id || null) !== (l.account_id || null)) l.changes.push({ label: 'Account', from: p.suggest_account_id && byId.get(p.suggest_account_id) ? byId.get(p.suggest_account_id).code + ' ' + byId.get(p.suggest_account_id).name : '', to: l.account || '' });
        if (!l.changes.length) l.status = 'same';
        else if (p.status === 'new') l.status = 'changed';
        else { l.status = 'locked'; l.reason = 'Already ' + p.status + ' here; check it against QuickBooks'; }
      }
      const gone = prior.filter((p) => !claimed.has(p.id)).map((p) => ({ date: p.date, description: p.description, amount: p.amount, feed_id: p.id, status: p.status === 'new' ? 'gone' : 'locked',
        reason: p.status === 'new' ? 'Not in the file any more: taken off the review list when replacing' : 'Not in the file any more, but already ' + p.status + ' here: left alone' }));
      const cnt = (st) => lines.filter((l) => l.status === st).length;
      const summary = { found: lines.length + before, from, ledger_start: start, before, mode, new: cnt('new'), changed: cnt('changed'), same: cnt('same'), locked: cnt('locked') + gone.filter((g) => g.status === 'locked').length,
        gone: gone.filter((g) => g.status === 'gone').length, with_account: lines.filter((l) => l.status === 'new' && l.account_id).length,
        unknown: [...new Set(lines.filter((l) => l.status !== 'same' && l.note && /not in the chart/.test(l.note)).map((l) => l.split))].slice(0, 20) };
      if (b.preview) {
        return res.json({ summary, lines: lines.slice(0, 300).map((l) => ({ date: l.date, type: l.type, num: l.num, name: l.name, memo: l.memo, split: l.split, amount: l.amount, account: l.account || null, note: l.note || null, status: l.status, changes: l.changes || null, reason: l.reason || null }))
          .concat(gone.map((g) => ({ date: g.date, type: '', num: '', name: g.description, memo: '', amount: g.amount, status: g.status, reason: g.reason }))) });
      }
      const ref = 'QuickBooks ' + new Date().toISOString().slice(0, 16);
      const out = { added: 0, updated: 0, removed: 0 };
      await tx(async (c) => {
        for (const l of lines.filter((x) => x.status === 'changed')) {
          const { rowCount } = await c.query(
            `UPDATE bank_feed_lines SET description = $2, amount = $3, line_hash = $4, payee = $5, reference = $6, suggest_account_id = $7, note = $8, import_ref = $9
              WHERE id = $1 AND status = 'new' AND NOT EXISTS (SELECT 1 FROM bank_feed_lines x WHERE x.account_id = $10 AND x.line_hash = $4)`,
            [l.feed_id, l.description, l.amount, l.hash, l.name || null, l.num || null, l.account_id || null, l.note || null, ref, a.id]);
          out.updated += rowCount;
        }
        if (mode === 'replace') {
          const ids = gone.filter((g) => g.status === 'gone').map((g) => g.feed_id);
          if (ids.length) out.removed = (await c.query(`DELETE FROM bank_feed_lines WHERE id = ANY($1) AND status = 'new' AND source = 'quickbooks'`, [ids])).rowCount;
        }
        for (const l of lines.filter((x) => x.status === 'new')) {
          const { rowCount } = await c.query(
            `INSERT INTO bank_feed_lines (account_id, import_ref, txn_date, description, amount, line_hash, created_by, source, payee, reference, suggest_account_id, note)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'quickbooks',$8,$9,$10,$11) ON CONFLICT (account_id, line_hash) DO NOTHING`,
            [a.id, ref, l.date, l.description, l.amount, l.hash, req.session.userId, l.name || null, l.num || null, l.account_id || null, l.note || null]);
          out.added += rowCount;
        }
      });
      res.json(Object.assign({ ok: true, before, same: summary.same }, out));
    } catch (e) { fail(res, e); }
  });

  // For billing.js: the same open items, reminder email and supplier bills these screens use.
  // Every open customer item (sales on account and invoices), for the cash forecast (budget.js).
  const arOpenItems = async () => (await query(`SELECT o.doc, o.id, o.customer_id, o.open::float AS open, to_char(COALESCE(o.due_date, o.created_at::date), 'YYYY-MM-DD') AS due FROM (${OPEN_SQL}) o`)).rows;
  return { openInvoices, reminderEmail, canEmail, apDocs, arOpenItems, makeTxn, lineAccount, bankAccount, classId, post };
}

module.exports = { register };
