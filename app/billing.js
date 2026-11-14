'use strict';
// =============================================================================
//  Morty's Auto Parts -- loans, invoices on the books, recurring billing,
//  scheduled reminders and late fees
//
//  Mounted by server.js:  require('./billing').register(app, deps)
//  Tables in schema.sql ("LOANS, RECURRING BILLING, REMINDERS AND LATE FEES").
//
//  Loans        the company as borrower. The lender is a supplier; the
//               repayment schedule is worked out when the loan is registered
//               (annuity, equal principal or interest only) and each
//               instalment becomes an ordinary A/P bill on its due date:
//               principal to Loans Payable, interest to Interest Expense. The
//               bill is paid with Pay Bills like any other -- a standing order
//               is only a label (the owner's decision, 2026-10-19: the bank
//               takes it, staff record the payment when it is on the
//               statement), and keeps the instalment off the "pay this soon"
//               email. The money received is a Banking deposit, Dr bank / Cr
//               Loans Payable, so it reconciles like any other.
//  Invoices     receivables raised on the books, not at the till: rent,
//               recharges, late fees. Posted by gl.js (ar_invoice); open in
//               A/R beside POS sales through AR_OPEN_SQL; paid with Receive
//               Payment (books.js applies to either kind).
//  Plans        recurring invoices (side 'ar', e.g. a tenant's monthly rent)
//               and recurring bills (side 'ap', standing orders and fixed
//               monthly costs). Each period is billed once: billing_runs is
//               keyed (plan, period) and written in the same transaction as
//               the document, so a restart, a second worker or "Run now"
//               twice can never bill a period twice.
//  Reminders    per-customer settings: N days before due, on the due date,
//               and on days 1 / 7 / 14 after (SOP-09's reminder stage). From
//               day 15 it is a phone call, so no more emails. A promise to pay
//               not yet passed stops the after-due reminders; a credit hold
//               stops the "coming due" ones. Logged once per (document, stage)
//               in ar_reminder_log and in the customer's collections notes.
//  Late fees    a rule on the plan (agreement) or customer-wide: grace days,
//               flat or % of the open balance, min / max, once per invoice or
//               monthly while unpaid. The fee is its own invoice (Late Fee
//               Income), unique per (late invoice, period); waiving it voids
//               that invoice and keeps the key, so the next run does not
//               charge it again. A promise to pay not yet passed holds the fee
//               (the owner's decision); once the promise date passes unpaid it
//               is charged. Fees are only charged on invoices raised here --
//               never on POS sales, so switching a rule on cannot fine years
//               of imported history -- and never on fees.
//
//  The worker runs every 10 minutes under an advisory lock: loan instalments
//  due, plan periods due, late fees, then reminders (08:00-18:00 Jamaica time)
//  and the accounts-email notice of bills to pay by hand. A plan more than
//  three periods behind (the till was off, or the plan was back-dated) is
//  paused instead of billing a burst; staff resume it and choose whether to
//  bill the missed periods. Switch: setting billing_auto (on unless 'off').
// =============================================================================

const FREQ = { weekly: { days: 7, ppy: 52 }, fortnightly: { days: 14, ppy: 26 }, monthly: { months: 1, ppy: 12 }, quarterly: { months: 3, ppy: 4 }, yearly: { months: 12, ppy: 1 } };
const MAX_BEHIND = 3;

// ------------------------------------------------------------ dates --
// Plain YYYY-MM-DD strings throughout; Jamaica keeps UTC-5 all year.
// BILLING_TODAY (YYYY-MM-DD) pins the date for testing on a scratch copy.
const jaNow = () => new Date(Date.now() - 5 * 3600000);
const today = () => (/^\d{4}-\d{2}-\d{2}$/.test(process.env.BILLING_TODAY || '') ? process.env.BILLING_TODAY : jaNow().toISOString().slice(0, 10));
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !isNaN(Date.parse(v));
const ymd = (v) => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
function addDays(d, k) { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + k); return t.toISOString().slice(0, 10); }
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
// The k-th period from an anchor date (k = 0 is the anchor). Months are counted
// from the anchor, not from the previous period, and the day is kept where the
// month has it: a plan anchored on the 31st runs on the 30th in April and the
// 28th / 29th in February, and is back on the 31st in May (adding a month at a
// time drifts: 31 Jan + 1 month = 3 Mar).
function addPeriod(anchor, freq, k) {
  const f = FREQ[freq];
  if (!f) throw new Error('Unknown frequency ' + freq);
  if (f.days) return addDays(anchor, f.days * k);
  const [y, m, d] = anchor.split('-').map(Number);
  const mi = (m - 1) + f.months * k, yy = y + Math.floor(mi / 12), mm = ((mi % 12) + 12) % 12;
  const last = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
  return yy + '-' + String(mm + 1).padStart(2, '0') + '-' + String(Math.min(d, last)).padStart(2, '0');
}
// The first period date after `date` for a schedule anchored at `anchor`.
function nextPeriod(anchor, freq, date) {
  const f = FREQ[freq];
  let k;
  if (f.days) k = Math.floor(daysBetween(anchor, date) / f.days);
  else { const [y1, m1] = anchor.split('-').map(Number), [y2, m2] = date.split('-').map(Number); k = Math.floor(((y2 - y1) * 12 + (m2 - m1)) / f.months); }
  k = Math.max(k - 1, 0);
  let p = addPeriod(anchor, freq, k);
  while (p <= date) p = addPeriod(anchor, freq, ++k);
  return p;
}
// The latest period date on or before `date` (the period running on that day).
function currentPeriod(anchor, freq, date) {
  if (date < anchor) return anchor;
  let k = 0;
  while (addPeriod(anchor, freq, k + 1) <= date) k++;
  return addPeriod(anchor, freq, k);
}
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function periodLabel(date, freq) {
  const [y, m] = date.split('-').map(Number);
  if (freq === 'monthly') return MONTHS[m - 1] + ' ' + y;
  if (freq === 'quarterly') return MONTHS[m - 1].slice(0, 3) + '-' + MONTHS[(m + 1) % 12].slice(0, 3) + ' ' + y;
  if (freq === 'yearly') return date.slice(0, 7) + ' to ' + addDays(addPeriod(date, 'yearly', 1), -1).slice(0, 7);
  return (freq === 'weekly' ? 'week of ' : 'two weeks from ') + date;
}

// ------------------------------------------------------ loan schedule --
// Interest each period on the opening balance at the annual rate divided by
// the periods in a year. Cents are rounded each period and the last instalment
// takes whatever is left, so the schedule always ends at exactly 0.00.
function schedule({ principal, annual_rate, instalments, frequency, method, first_due, start_n = 1 }) {
  const r2 = (v) => Math.round(v * 100) / 100;
  const i = Number(annual_rate) / 100 / FREQ[frequency].ppy, n = instalments;
  let bal = r2(principal);
  const pmt = method === 'annuity' ? (i === 0 ? r2(bal / n) : r2(bal * i / (1 - Math.pow(1 + i, -n)))) : 0;
  const even = r2(bal / n), out = [];
  for (let k = 1; k <= n; k++) {
    const interest = r2(bal * i), last = k === n;
    let principalPart = method === 'annuity' ? r2(pmt - interest) : method === 'equal_principal' ? even : 0;
    if (last || principalPart > bal) principalPart = bal;
    if (principalPart < 0) principalPart = 0;   // a payment below the interest would never repay it: refused when the loan is saved
    const closing = r2(bal - principalPart);
    out.push({ n: start_n + k - 1, due_date: addPeriod(first_due, frequency, k - 1), opening: bal, principal: principalPart, interest, payment: r2(principalPart + interest), closing });
    bal = closing;
  }
  return out;
}

function register(app, deps) {
  const { query, getPool, requireAdmin, requireCap, mailer, books, getShop } = deps;
  const can = (k) => [requireAdmin, requireCap(k)];
  const AR = can('ar.manage'), AP = can('ap.manage');
  const n = (v) => (v == null || v === '' ? 0 : Number(v));
  const r2 = (v) => Math.round(n(v) * 100) / 100;
  const money = (v) => (r2(v) < 0 ? '-' : '') + 'J$' + Math.abs(r2(v)).toLocaleString('en-JM', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  function httpError(status, msg) { const e = new Error(msg); e.status = status; e.publicMessage = msg; return e; }
  function fail(res, e) { const s = e.status || 500; if (s >= 500) console.error('[billing]', e); res.status(s).json({ error: e.publicMessage || e.message }); }
  async function tx(fn) {
    const c = await getPool().connect();
    try { await c.query('BEGIN'); const out = await fn(c); await c.query('COMMIT'); return out; }
    catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} throw e; }
    finally { c.release(); }
  }
  async function setting(key, dflt) {
    const { rows } = await query('SELECT value FROM warehouse_settings WHERE key = $1', [key]);
    return rows.length && rows[0].value != null ? rows[0].value : dflt;
  }
  async function systemAccount(key) {
    const { rows } = await query(`SELECT id FROM gl_accounts WHERE system_key = $1 AND is_active`, [key]);
    if (!rows.length) throw httpError(409, 'No account is set up for ' + key.replace(/_/g, ' ') + ' (Accounting > Chart of accounts)');
    return rows[0].id;
  }
  async function customer(id, q = query) {
    const { rows } = await q(`SELECT id, COALESCE(NULLIF(name, ''), email) AS name, email, credit_hold, payment_terms_days FROM users WHERE id = $1 AND NOT is_staff`, [parseInt(id, 10) || 0]);
    if (!rows.length) throw httpError(404, 'Customer not found');
    return rows[0];
  }
  async function supplier(id) {
    const { rows } = await query(`SELECT id, name FROM suppliers WHERE id = $1`, [parseInt(id, 10) || 0]);
    if (!rows.length) throw httpError(400, 'Choose the supplier');
    return rows[0];
  }
  // Lines [{account_id, description, amount, class_id}] checked against the chart (not A/R or A/P) and the classes.
  async function cleanLines(raw) {
    const lines = (Array.isArray(raw) ? raw : []).map((l) => ({ account_id: parseInt(l.account_id, 10), description: String(l.description || '').trim().slice(0, 200) || null, amount: r2(l.amount), class_id: l.class_id })).filter((l) => l.amount > 0);
    if (!lines.length) throw httpError(400, 'Add at least one line with an account and amount');
    for (const l of lines) { await books.lineAccount(l.account_id); l.class_id = await books.classId(l.class_id); }
    return lines;
  }
  const lateFee = (b) => {
    const type = ['flat', 'percent', 'none'].includes(b.late_fee_type) ? b.late_fee_type : null;
    const out = { late_fee_type: type, late_fee_amount: type && type !== 'none' ? r2(b.late_fee_amount) : null, late_fee_grace_days: Math.max(0, parseInt(b.late_fee_grace_days, 10) || 0),
      late_fee_repeat: b.late_fee_repeat === 'monthly' ? 'monthly' : 'once', late_fee_min: b.late_fee_min === '' || b.late_fee_min == null ? null : r2(b.late_fee_min), late_fee_max: b.late_fee_max === '' || b.late_fee_max == null ? null : r2(b.late_fee_max) };
    if (out.late_fee_amount != null && !(out.late_fee_amount > 0)) throw httpError(400, 'Late fee amount');
    if (type === 'percent' && out.late_fee_amount > 50) throw httpError(400, 'A late fee over 50% is not allowed');
    if (out.late_fee_grace_days > 90) throw httpError(400, 'Grace period 0 to 90 days');
    if (out.late_fee_min != null && out.late_fee_max != null && out.late_fee_min > out.late_fee_max) throw httpError(400, 'The minimum fee is more than the maximum');
    return out;
  };

  // ---------------------------------------------------------- documents --
  // An invoice raised on the books. Returns null when a late fee for that
  // (invoice, period) already exists -- the unique key decides, not a lookup.
  async function createInvoice(c, d) {
    const total = r2(d.lines.reduce((t, l) => t + l.amount, 0) + r2(d.gct_amount));
    if (!(total > 0)) throw httpError(400, 'The invoice total must be more than zero');
    const { rows } = await c.query(
      `INSERT INTO ar_invoices (kind, customer_id, invoice_date, due_date, memo, gct_amount, total, plan_id, source_invoice_id, fee_period, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING RETURNING id`,
      [d.kind || 'invoice', d.customer_id, d.invoice_date, d.due_date || d.invoice_date, d.memo || null, r2(d.gct_amount), total, d.plan_id || null, d.source_invoice_id || null, d.fee_period || null, d.userId || null]);
    if (!rows.length) return null;
    const id = rows[0].id, number = 'INV-' + String(id).padStart(6, '0');
    await c.query(`UPDATE ar_invoices SET number = $2 WHERE id = $1`, [id, number]);
    for (const l of d.lines) await c.query(`INSERT INTO ar_invoice_lines (invoice_id, account_id, description, amount, class_id) VALUES ($1,$2,$3,$4,$5)`, [id, l.account_id, l.description, l.amount, l.class_id || null]);
    return { id, number, total };
  }
  async function createBill(c, d) {
    const total = r2(d.lines.reduce((t, l) => t + l.amount, 0) + r2(d.gct_amount));
    const { rows } = await c.query(`INSERT INTO ap_bills (kind, supplier_id, number, bill_date, due_date, memo, gct_amount, total, created_by) VALUES ('bill',$1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [d.supplier_id, d.number || null, d.bill_date, d.due_date || d.bill_date, d.memo || null, r2(d.gct_amount), total, d.userId || null]);
    for (const l of d.lines) await c.query(`INSERT INTO ap_bill_lines (bill_id, account_id, description, amount, class_id) VALUES ($1,$2,$3,$4,$5)`, [rows[0].id, l.account_id, l.description, l.amount, l.class_id || null]);
    return { id: rows[0].id, total };
  }
  // Applied payments on an invoice (voided payments do not count: the view excludes them).
  async function invoicePaid(id, q = query) {
    const { rows } = await q(`SELECT COALESCE(SUM(x.amount), 0)::float AS paid FROM ar_applications x JOIN account_payments ap ON ap.id = x.payment_id WHERE x.invoice_id = $1`, [id]);
    return r2(rows[0].paid);
  }
  // The latest promise to pay recorded for a customer (its date), as SQL on u.id / i.customer_id.
  const PROMISE_SQL = (col) => `(SELECT nn.promise_date FROM ar_notes nn WHERE nn.customer_id = ${col} AND nn.kind = 'promise' ORDER BY nn.created_at DESC, nn.id DESC LIMIT 1)`;

  // ================================================================ LOANS ==
  function loanInput(b) {
    const out = {
      principal: r2(b.principal), annual_rate: Math.round(n(b.annual_rate) * 10000) / 10000, instalments: parseInt(b.instalments, 10),
      frequency: FREQ[b.frequency] ? b.frequency : null, method: ['annuity', 'equal_principal', 'interest_only'].includes(b.method) ? b.method : 'annuity',
      first_due: isDate(b.first_due) ? b.first_due : null,
    };
    if (!(out.principal > 0)) throw httpError(400, 'How much was borrowed?');
    if (!(out.annual_rate >= 0 && out.annual_rate < 100)) throw httpError(400, 'Interest rate (% a year), 0 to 99');
    if (!(out.instalments >= 1 && out.instalments <= 600)) throw httpError(400, 'Number of instalments, 1 to 600');
    if (!out.frequency) throw httpError(400, 'How often is it repaid?');
    if (!out.first_due) throw httpError(400, 'When is the first instalment due?');
    if (out.method === 'interest_only' && !(out.annual_rate > 0)) throw httpError(400, 'Interest only needs an interest rate');
    return out;
  }
  const coversInterest = (x, rows) => !(x.method === 'annuity' && rows.slice(0, -1).some((r) => r.principal === 0));
  // Balance owed: principal less the principal of every instalment billed on a bill that is not voided.
  const LOAN_SUMS = `
    SELECT l.id,
           COALESCE(SUM(li.principal) FILTER (WHERE li.status = 'billed' AND b.voided_at IS NULL), 0)::float AS principal_billed,
           COALESCE(SUM(li.interest)  FILTER (WHERE li.status = 'billed' AND b.voided_at IS NULL), 0)::float AS interest_billed,
           MIN(li.due_date) FILTER (WHERE li.status = 'scheduled') AS next_due,
           COUNT(li.id) FILTER (WHERE li.status = 'scheduled')::int AS left_count
      FROM loans l LEFT JOIN loan_instalments li ON li.loan_id = l.id LEFT JOIN ap_bills b ON b.id = li.ap_bill_id
     GROUP BY l.id`;

  app.post('/api/loans/preview', ...AP, async (req, res) => {
    try {
      const x = loanInput(req.body || {});
      const rows = schedule(x);
      if (!coversInterest(x, rows)) throw httpError(400, 'The payment does not cover the interest');
      res.json({ schedule: rows, totals: { payments: r2(rows.reduce((t, r) => t + r.payment, 0)), interest: r2(rows.reduce((t, r) => t + r.interest, 0)) } });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/loans', ...AP, async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT l.id, l.name, l.reference, l.principal::float AS principal, l.annual_rate::float AS annual_rate, l.instalments, l.frequency, l.method, l.pay_mode, l.status,
                to_char(l.start_date, 'YYYY-MM-DD') AS start_date, s.name AS lender, x.principal_billed, x.interest_billed, to_char(x.next_due, 'YYYY-MM-DD') AS next_due, x.left_count,
                (SELECT li.payment::float FROM loan_instalments li WHERE li.loan_id = l.id AND li.status = 'scheduled' ORDER BY li.due_date, li.n LIMIT 1) AS next_payment
           FROM loans l JOIN suppliers s ON s.id = l.supplier_id JOIN (${LOAN_SUMS}) x ON x.id = l.id
          ORDER BY (l.status = 'active') DESC, x.next_due NULLS LAST, l.id`);
      for (const r of rows) r.balance = r.status === 'cancelled' ? 0 : r2(r.principal - r.principal_billed);
      const { rows: gl } = await query(`SELECT COALESCE(SUM(-ln.amount), 0)::float AS v FROM gl_lines ln JOIN gl_accounts a ON a.id = ln.account_id WHERE a.system_key = 'loans_payable'`);
      res.json({ loans: rows, ledger_balance: r2(gl[0].v), owed: r2(rows.reduce((t, r) => t + r.balance, 0)) });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/loans/:id', ...AP, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const { rows } = await query(
        `SELECT l.*, l.principal::float AS principal, l.annual_rate::float AS annual_rate, to_char(l.start_date, 'YYYY-MM-DD') AS start_date, to_char(l.first_due, 'YYYY-MM-DD') AS first_due,
                s.name AS lender, la.code || ' ' || la.name AS liability_account, ia.code || ' ' || ia.name AS interest_account, x.principal_billed, x.interest_billed
           FROM loans l JOIN suppliers s ON s.id = l.supplier_id JOIN gl_accounts la ON la.id = l.liability_account_id JOIN gl_accounts ia ON ia.id = l.interest_account_id
           JOIN (${LOAN_SUMS}) x ON x.id = l.id WHERE l.id = $1`, [id]);
      if (!rows.length) throw httpError(404, 'Loan not found');
      const loan = rows[0];
      loan.balance = loan.status === 'cancelled' ? 0 : r2(loan.principal - loan.principal_billed);
      const { rows: inst } = await query(
        `SELECT li.id, li.n, li.kind, to_char(li.due_date, 'YYYY-MM-DD') AS due_date, li.opening::float AS opening, li.principal::float AS principal, li.interest::float AS interest,
                li.payment::float AS payment, li.closing::float AS closing, li.status, li.ap_bill_id, b.number AS bill_number, b.voided_at AS bill_voided
           FROM loan_instalments li LEFT JOIN ap_bills b ON b.id = li.ap_bill_id WHERE li.loan_id = $1 ORDER BY li.due_date, li.n`, [id]);
      const docs = await books.apDocs(loan.supplier_id);
      for (const r of inst) {
        const d = r.ap_bill_id && docs.find((x) => x.kind === 'bill' && x.id === r.ap_bill_id);
        r.paid = d ? d.paid : 0;
        r.state = r.status === 'scheduled' ? 'upcoming' : r.bill_voided ? 'bill voided' : !r.ap_bill_id || (d && d.open <= 0.005) ? 'paid' : 'billed';
      }
      res.json({ loan, instalments: inst });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/loans', ...AP, async (req, res) => {
    try {
      const b = req.body || {};
      const x = loanInput(b);
      const name = String(b.name || '').trim().slice(0, 80);
      if (name.length < 2) throw httpError(400, 'Give the loan a name (e.g. "NCB business loan")');
      const lender = await supplier(b.supplier_id);
      const startDate = isDate(b.start_date) ? b.start_date : today();
      if (x.first_due < startDate) throw httpError(400, 'The first instalment is due before the money was received');
      // A loan already running is entered from today: its balance now, the instalments left and the next due date.
      if (x.first_due < addDays(today(), -7)) throw httpError(400, 'The first due date is in the past. For a loan already running, enter today\'s balance as the amount, the instalments left, and the next due date.');
      const rows = schedule(x);
      if (!coversInterest(x, rows)) throw httpError(400, 'The payment does not cover the interest');
      const liability = b.liability_account_id ? (await books.lineAccount(b.liability_account_id)).id : await systemAccount('loans_payable');
      const interest = b.interest_account_id ? (await books.lineAccount(b.interest_account_id)).id : await systemAccount('interest_expense');
      const received = b.received === 'existing' ? 'existing' : 'deposit';
      const dep = received === 'deposit' ? await books.bankAccount(b.deposit_account_id) : null;
      const id = await tx(async (c) => {
        let txnId = null;
        if (dep) {
          txnId = (await books.makeTxn(c, { kind: 'deposit', accountId: dep.id, date: startDate, payee: lender.name.slice(0, 80), supplierId: lender.id, cheque: null,
            reference: String(b.reference || '').slice(0, 60) || null, memo: 'Loan received: ' + name, lines: [{ account_id: liability, amount: x.principal, memo: 'Loan from ' + lender.name }], userId: req.session.userId })).id;
        }
        const { rows: l } = await c.query(
          `INSERT INTO loans (name, supplier_id, reference, principal, annual_rate, instalments, frequency, method, start_date, first_due, pay_mode, liability_account_id, interest_account_id, received, deposit_txn_id, notes, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
          [name, lender.id, String(b.reference || '').trim().slice(0, 60) || null, x.principal, x.annual_rate, x.instalments, x.frequency, x.method, startDate, x.first_due,
            b.pay_mode === 'standing_order' ? 'standing_order' : 'manual', liability, interest, received, txnId, String(b.notes || '').slice(0, 500) || null, req.session.userId]);
        for (const r of rows) {
          await c.query(`INSERT INTO loan_instalments (loan_id, n, due_date, opening, principal, interest, payment, closing) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [l[0].id, r.n, r.due_date, r.opening, r.principal, r.interest, r.payment, r.closing]);
        }
        return l[0].id;
      });
      if (dep) books.post();
      res.json({ ok: true, id });
      runSoon();   // an instalment due today is billed straight away
    } catch (e) { fail(res, e); }
  });

  // Instalments not billed yet are worked out again from the balance after the
  // last billed one: a new rate, a different number left, or after a lump sum.
  async function rescheduleLoan(c, loanId, opts) {
    const { rows: l } = await c.query(`SELECT * FROM loans WHERE id = $1 AND status = 'active' FOR UPDATE`, [loanId]);
    if (!l.length) throw httpError(409, 'Only an active loan can be changed');
    const loan = l[0];
    const { rows: done } = await c.query(
      `SELECT COALESCE(SUM(li.principal), 0)::float AS p FROM loan_instalments li LEFT JOIN ap_bills b ON b.id = li.ap_bill_id
        WHERE li.loan_id = $1 AND li.status = 'billed' AND b.voided_at IS NULL`, [loanId]);
    const { rows: left } = await c.query(`SELECT COUNT(*)::int AS k, to_char(MIN(due_date), 'YYYY-MM-DD') AS next FROM loan_instalments WHERE loan_id = $1 AND status = 'scheduled'`, [loanId]);
    const balance = r2(n(loan.principal) - done[0].p);
    if (!(balance > 0)) throw httpError(409, 'Nothing is left to repay on this loan');
    const x = loanInput({ principal: balance, annual_rate: opts.annual_rate != null && opts.annual_rate !== '' ? opts.annual_rate : loan.annual_rate, instalments: opts.instalments || left[0].k,
      frequency: loan.frequency, method: loan.method, first_due: opts.first_due || left[0].next });
    const { rows: mx } = await c.query(`SELECT COALESCE(MAX(n), 0) AS m FROM loan_instalments WHERE loan_id = $1 AND status = 'billed' AND kind = 'regular'`, [loanId]);
    await c.query(`DELETE FROM loan_instalments WHERE loan_id = $1 AND status = 'scheduled'`, [loanId]);
    const rows = schedule(Object.assign(x, { start_n: mx[0].m + 1 }));
    if (!coversInterest(x, rows)) throw httpError(400, 'The payment does not cover the interest');
    for (const r of rows) await c.query(`INSERT INTO loan_instalments (loan_id, n, due_date, opening, principal, interest, payment, closing) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [loanId, r.n, r.due_date, r.opening, r.principal, r.interest, r.payment, r.closing]);
    if (opts.annual_rate != null && opts.annual_rate !== '') await c.query(`UPDATE loans SET annual_rate = $2 WHERE id = $1`, [loanId, x.annual_rate]);
    return rows.length;
  }
  app.post('/api/loans/:id/reschedule', ...AP, async (req, res) => {
    try {
      const b = req.body || {};
      if (b.first_due && !isDate(b.first_due)) throw httpError(400, 'Next due date');
      const k = await tx((c) => rescheduleLoan(c, parseInt(req.params.id, 10), { annual_rate: b.annual_rate, instalments: parseInt(b.instalments, 10) || null, first_due: b.first_due || null }));
      res.json({ ok: true, instalments: k });
    } catch (e) { fail(res, e); }
  });
  // A lump sum off the principal: billed now (principal only), then the rest
  // re-worked over the instalments left, so each payment is smaller.
  app.post('/api/loans/:id/extra', ...AP, async (req, res) => {
    try {
      const b = req.body || {}, id = parseInt(req.params.id, 10), amount = r2(b.amount);
      const date = isDate(b.date) ? b.date : today();
      if (!(amount > 0)) throw httpError(400, 'How much extra is being paid?');
      const out = await tx(async (c) => {
        const { rows: l } = await c.query(`SELECT * FROM loans WHERE id = $1 AND status = 'active' FOR UPDATE`, [id]);
        if (!l.length) throw httpError(409, 'Only an active loan can be paid down');
        const loan = l[0];
        const { rows: done } = await c.query(`SELECT COALESCE(SUM(li.principal), 0)::float AS p FROM loan_instalments li LEFT JOIN ap_bills b ON b.id = li.ap_bill_id WHERE li.loan_id = $1 AND li.status = 'billed' AND b.voided_at IS NULL`, [id]);
        const balance = r2(n(loan.principal) - done[0].p);
        if (amount > balance + 0.005) throw httpError(400, 'Only ' + money(balance) + ' is left on this loan');
        // Extra repayments are numbered -1, -2 ... (shown as "extra") so the regular
        // instalments keep the lender's numbering: the re-worked ones carry on from the last billed.
        const { rows: mx } = await c.query(`SELECT LEAST(COALESCE(MIN(n), 0), 0) - 1 AS m FROM loan_instalments WHERE loan_id = $1`, [id]);
        const bill = await createBill(c, { supplier_id: loan.supplier_id, number: (loan.reference || 'LOAN-' + loan.id) + '/X' + date, bill_date: date, due_date: date,
          memo: 'Extra repayment · ' + loan.name, lines: [{ account_id: loan.liability_account_id, description: 'Loan principal (extra repayment)', amount }], userId: req.session.userId });
        await c.query(`INSERT INTO loan_instalments (loan_id, n, kind, due_date, opening, principal, interest, payment, closing, status, ap_bill_id) VALUES ($1,$2,'extra',$3,$4,$5,0,$5,$6,'billed',$7)`,
          [id, mx[0].m, date, balance, amount, r2(balance - amount), bill.id]);
        if (r2(balance - amount) > 0) await rescheduleLoan(c, id, {});
        else { await c.query(`DELETE FROM loan_instalments WHERE loan_id = $1 AND status = 'scheduled'`, [id]); await c.query(`UPDATE loans SET status = 'paid' WHERE id = $1`, [id]); }
        return bill;
      });
      books.post();
      res.json({ ok: true, bill_id: out.id });
    } catch (e) { fail(res, e); }
  });
  // An instalment whose bill was voided (a mistake on it) goes back on the schedule to be billed again.
  app.post('/api/loans/:id/instalments/:iid/rebill', ...AP, async (req, res) => {
    try {
      const { rowCount } = await query(
        `UPDATE loan_instalments li SET status = 'scheduled', ap_bill_id = NULL FROM ap_bills b
          WHERE li.id = $1 AND li.loan_id = $2 AND li.kind = 'regular' AND b.id = li.ap_bill_id AND b.voided_at IS NOT NULL`, [parseInt(req.params.iid, 10), parseInt(req.params.id, 10)]);
      if (!rowCount) throw httpError(409, 'Only an instalment whose bill was voided can be billed again');
      await query(`UPDATE loans SET status = 'active' WHERE id = $1 AND status = 'paid'`, [parseInt(req.params.id, 10)]);
      res.json({ ok: true });
      runSoon();
    } catch (e) { fail(res, e); }
  });
  app.post('/api/loans/:id/cancel', ...AP, async (req, res) => {
    try {
      const reason = String((req.body || {}).reason || '').trim().slice(0, 200), id = parseInt(req.params.id, 10);
      if (reason.length < 3) throw httpError(400, 'Say why the loan is cancelled');
      const out = await tx(async (c) => {
        const { rows: billed } = await c.query(`SELECT COUNT(*)::int AS k FROM loan_instalments li JOIN ap_bills b ON b.id = li.ap_bill_id WHERE li.loan_id = $1 AND b.voided_at IS NULL`, [id]);
        if (billed[0].k) throw httpError(409, 'Instalments of this loan have been billed: void those bills first, or pay the loan off');
        const { rows } = await c.query(`UPDATE loans SET status = 'cancelled', cancelled_at = NOW(), cancel_reason = $2 WHERE id = $1 AND status <> 'cancelled' RETURNING deposit_txn_id`, [id, reason]);
        if (!rows.length) throw httpError(409, 'Not found or already cancelled');
        await c.query(`DELETE FROM loan_instalments WHERE loan_id = $1 AND status = 'scheduled'`, [id]);
        return rows[0];
      });
      res.json({ ok: true, deposit_txn_id: out.deposit_txn_id, note: out.deposit_txn_id ? 'The deposit of the loan money is still in Banking: void it there if the money never came in.' : null });
    } catch (e) { fail(res, e); }
  });

  // Bill one instalment (the worker, or "Bill now" for an early payment).
  async function billInstalment(instId, userId) {
    return tx(async (c) => {
      const { rows } = await c.query(
        `SELECT li.*, to_char(li.due_date, 'YYYY-MM-DD') AS due, l.name, l.reference, l.supplier_id, l.liability_account_id, l.interest_account_id, l.id AS lid
           FROM loan_instalments li JOIN loans l ON l.id = li.loan_id WHERE li.id = $1 AND li.status = 'scheduled' AND l.status = 'active' FOR UPDATE OF li`, [instId]);
      if (!rows.length) return null;   // billed by another run already
      const i = rows[0], lines = [];
      if (n(i.principal) > 0) lines.push({ account_id: i.liability_account_id, description: 'Loan principal', amount: r2(i.principal) });
      if (n(i.interest) > 0) lines.push({ account_id: i.interest_account_id, description: 'Interest', amount: r2(i.interest) });
      let billId = null;
      if (lines.length) {
        billId = (await createBill(c, { supplier_id: i.supplier_id, number: (i.reference || 'LOAN-' + i.lid) + '/' + i.n, bill_date: i.due, due_date: i.due,
          memo: 'Loan instalment ' + i.n + ' · ' + i.name, lines, userId })).id;
      }
      await c.query(`UPDATE loan_instalments SET status = 'billed', ap_bill_id = $2 WHERE id = $1`, [i.id, billId]);
      await c.query(`UPDATE loans SET status = 'paid' WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM loan_instalments WHERE loan_id = $1 AND status = 'scheduled')`, [i.lid]);
      return billId || true;
    });
  }
  app.post('/api/loans/:id/instalments/:iid/bill', ...AP, async (req, res) => {
    try {
      const { rows } = await query(`SELECT 1 FROM loan_instalments WHERE id = $1 AND loan_id = $2 AND status = 'scheduled'`, [parseInt(req.params.iid, 10), parseInt(req.params.id, 10)]);
      if (!rows.length) throw httpError(409, 'Already billed');
      const billId = await billInstalment(parseInt(req.params.iid, 10), req.session.userId);
      books.post();
      res.json({ ok: true, bill_id: billId });
    } catch (e) { fail(res, e); }
  });

  // ======================================================== AR INVOICES ==
  app.get('/api/ar/invoices', ...AR, async (req, res) => {
    try {
      const cid = parseInt(req.query.customer_id, 10) || null;
      const { rows } = await query(
        `SELECT i.id, i.number, i.kind, to_char(i.invoice_date, 'YYYY-MM-DD') AS day, to_char(i.due_date, 'YYYY-MM-DD') AS due, i.total::float AS total, i.memo, i.plan_id, i.voided_at, i.void_reason,
                COALESCE(NULLIF(u.name, ''), u.email) AS customer, src.number AS fee_on, p.name AS plan,
                COALESCE((SELECT SUM(x.amount) FROM ar_applications x JOIN account_payments ap ON ap.id = x.payment_id WHERE x.invoice_id = i.id), 0)::float AS paid
           FROM ar_invoices i JOIN users u ON u.id = i.customer_id LEFT JOIN ar_invoices src ON src.id = i.source_invoice_id LEFT JOIN billing_plans p ON p.id = i.plan_id
          WHERE ($1::int IS NULL OR i.customer_id = $1) ORDER BY i.invoice_date DESC, i.id DESC LIMIT 300`, [cid]);
      for (const r of rows) r.open = r.voided_at ? 0 : r2(r.total - r.paid);
      res.json({ invoices: rows });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/ar/invoices/:id', ...AR, async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT i.*, i.total::float AS total, i.gct_amount::float AS gct_amount, to_char(i.invoice_date, 'YYYY-MM-DD') AS day, to_char(i.due_date, 'YYYY-MM-DD') AS due,
                COALESCE(NULLIF(u.name, ''), u.email) AS customer, u.account_number, src.number AS fee_on
           FROM ar_invoices i JOIN users u ON u.id = i.customer_id LEFT JOIN ar_invoices src ON src.id = i.source_invoice_id WHERE i.id = $1`, [parseInt(req.params.id, 10)]);
      if (!rows.length) throw httpError(404, 'Invoice not found');
      const { rows: lines } = await query(`SELECT l.description, l.amount::float AS amount, a.code, a.name AS account FROM ar_invoice_lines l JOIN gl_accounts a ON a.id = l.account_id WHERE l.invoice_id = $1 ORDER BY l.id`, [rows[0].id]);
      const { rows: fees } = await query(`SELECT id, number, total::float AS total, to_char(invoice_date, 'YYYY-MM-DD') AS day, voided_at, void_reason FROM ar_invoices WHERE source_invoice_id = $1 ORDER BY id`, [rows[0].id]);
      const paid = await invoicePaid(rows[0].id);
      res.json({ invoice: rows[0], lines, fees, paid, open: rows[0].voided_at ? 0 : r2(rows[0].total - paid), shop: (await getShop()) || {} });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/ar/invoices', ...AR, async (req, res) => {
    try {
      const b = req.body || {};
      const cu = await customer(b.customer_id);
      if (!isDate(b.invoice_date)) throw httpError(400, 'Invoice date');
      const lines = await cleanLines(b.lines);
      const gct = r2(b.gct_amount);
      if (gct < 0) throw httpError(400, 'GCT cannot be negative');
      const due = isDate(b.due_date) ? b.due_date : addDays(b.invoice_date, cu.payment_terms_days || 0);
      if (due < b.invoice_date) throw httpError(400, 'The due date is before the invoice date');
      const inv = await tx((c) => createInvoice(c, { customer_id: cu.id, invoice_date: b.invoice_date, due_date: due, memo: String(b.memo || '').slice(0, 300), gct_amount: gct, lines, userId: req.session.userId }));
      books.post();
      res.json(Object.assign({ ok: true, due_date: due }, inv));
    } catch (e) { fail(res, e); }
  });
  // Void an invoice, or waive a late fee (the same thing: the fee invoice is voided and reversed in the ledger).
  app.post('/api/ar/invoices/:id/void', ...AR, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10), reason = String((req.body || {}).reason || '').trim().slice(0, 200);
      if (reason.length < 3) throw httpError(400, 'Say why');
      await tx(async (c) => {
        const { rows } = await c.query(`SELECT * FROM ar_invoices WHERE id = $1 AND voided_at IS NULL FOR UPDATE`, [id]);
        if (!rows.length) throw httpError(409, 'Not found or already voided');
        if (await invoicePaid(id, c.query.bind(c)) > 0) throw httpError(409, 'Payments are applied to this ' + (rows[0].kind === 'late_fee' ? 'fee' : 'invoice') + ': void those payments first');
        const { rows: fees } = await c.query(`SELECT number FROM ar_invoices WHERE source_invoice_id = $1 AND voided_at IS NULL`, [id]);
        if (fees.length) throw httpError(409, 'Waive the late fee ' + fees.map((f) => f.number).join(', ') + ' first');
        await c.query(`UPDATE ar_invoices SET voided_at = NOW(), voided_by = $2, void_reason = $3 WHERE id = $1`, [id, req.session.userId, reason]);
        await c.query(`INSERT INTO ar_notes (customer_id, kind, note, created_by) VALUES ($1, 'note', $2, $3)`,
          [rows[0].customer_id, (rows[0].kind === 'late_fee' ? 'Late fee ' + rows[0].number + ' waived (' : 'Invoice ' + rows[0].number + ' voided (') + money(rows[0].total) + '): ' + reason, req.session.userId]);
      });
      books.post();
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ============================================================= PLANS ==
  async function planInput(b, side) {
    const out = { name: String(b.name || '').trim().slice(0, 80), frequency: FREQ[b.frequency] ? b.frequency : null, due_days: b.due_days === '' || b.due_days == null ? 0 : parseInt(b.due_days, 10),
      end_date: isDate(b.end_date) ? b.end_date : null, max_runs: parseInt(b.max_runs, 10) || null, memo: String(b.memo || '').slice(0, 300) || null,
      gct_amount: r2(b.gct_amount), pay_mode: b.pay_mode === 'standing_order' ? 'standing_order' : 'manual' };
    if (out.name.length < 2) throw httpError(400, 'Give the plan a name (e.g. "Unit 2 rent")');
    if (!out.frequency) throw httpError(400, 'How often?');
    if (!(out.due_days >= 0 && out.due_days <= 365)) throw httpError(400, 'Days until due, 0 to 365');
    if (out.gct_amount < 0) throw httpError(400, 'GCT cannot be negative');
    out.lines = await cleanLines(b.lines);
    Object.assign(out, side === 'ar' ? lateFee(b) : {});
    return out;
  }
  const PLAN_COLS = ['name', 'frequency', 'due_days', 'end_date', 'max_runs', 'memo', 'gct_amount', 'pay_mode', 'lines', 'late_fee_type', 'late_fee_amount', 'late_fee_grace_days', 'late_fee_repeat', 'late_fee_min', 'late_fee_max'];
  // A plan's routes need ar.manage for invoices and ap.manage for bills.
  const sideCap = (side) => requireCap(side === 'ap' ? 'ap.manage' : 'ar.manage');
  const planCap = async (req, res, next) => {
    try {
      const { rows } = await query(`SELECT *, to_char(start_date, 'YYYY-MM-DD') AS start, to_char(next_run, 'YYYY-MM-DD') AS next FROM billing_plans WHERE id = $1`, [parseInt(req.params.id, 10) || 0]);
      if (!rows.length) throw httpError(404, 'Plan not found');
      req.plan = rows[0];
      return sideCap(rows[0].side)(req, res, next);
    } catch (e) { fail(res, e); }
  };
  app.get('/api/billing/plans', requireAdmin, (req, res, next) => sideCap(req.query.side)(req, res, next), async (req, res) => {
    try {
      const side = req.query.side === 'ap' ? 'ap' : 'ar';
      const { rows } = await query(
        `SELECT p.id, p.side, p.name, p.frequency, p.status, p.status_reason, p.pay_mode, p.due_days, p.memo, p.lines, p.gct_amount::float AS gct_amount,
                to_char(p.start_date, 'YYYY-MM-DD') AS start_date, to_char(p.end_date, 'YYYY-MM-DD') AS end_date, p.max_runs, to_char(p.next_run, 'YYYY-MM-DD') AS next_run,
                p.late_fee_type, p.late_fee_amount::float AS late_fee_amount, p.late_fee_grace_days, p.late_fee_repeat, p.late_fee_min::float AS late_fee_min, p.late_fee_max::float AS late_fee_max,
                p.customer_id, p.supplier_id, COALESCE(NULLIF(u.name, ''), u.email, s.name) AS party,
                (SELECT COUNT(*)::int FROM billing_runs r WHERE r.plan_id = p.id) AS runs, (SELECT to_char(MAX(period_date), 'YYYY-MM-DD') FROM billing_runs r WHERE r.plan_id = p.id) AS last_run
           FROM billing_plans p LEFT JOIN users u ON u.id = p.customer_id LEFT JOIN suppliers s ON s.id = p.supplier_id
          WHERE p.side = $1 AND ($2::int IS NULL OR p.customer_id = $2) AND ($3::int IS NULL OR p.supplier_id = $3)
          ORDER BY (p.status = 'active') DESC, p.next_run NULLS LAST, p.id`, [side, parseInt(req.query.customer_id, 10) || null, parseInt(req.query.supplier_id, 10) || null]);
      for (const r of rows) r.amount = r2(r.lines.reduce((t, l) => t + n(l.amount), 0) + r.gct_amount);
      res.json({ plans: rows });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/billing/plans/:id', requireAdmin, planCap, async (req, res) => {
    try {
      const { rows: runs } = await query(
        `SELECT to_char(r.period_date, 'YYYY-MM-DD') AS period, r.created_at, r.ar_invoice_id, r.ap_bill_id, COALESCE(i.number, b.number, '#' || b.id) AS number,
                COALESCE(i.total, b.total)::float AS total, COALESCE(i.voided_at, b.voided_at) AS voided_at, u.name AS by_name
           FROM billing_runs r LEFT JOIN ar_invoices i ON i.id = r.ar_invoice_id LEFT JOIN ap_bills b ON b.id = r.ap_bill_id LEFT JOIN users u ON u.id = r.created_by
          WHERE r.plan_id = $1 ORDER BY r.period_date DESC LIMIT 60`, [req.plan.id]);
      res.json({ plan: req.plan, runs });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/billing/plans', requireAdmin, (req, res, next) => sideCap((req.body || {}).side)(req, res, next), async (req, res) => {
    try {
      const b = req.body || {}, side = b.side === 'ap' ? 'ap' : 'ar';
      const x = await planInput(b, side);
      if (!isDate(b.start_date)) throw httpError(400, 'First period date');
      if (x.end_date && x.end_date < b.start_date) throw httpError(400, 'The end date is before the start');
      // Back-dating past the catch-up limit would bill a burst of periods at once: start from a recent period instead.
      if (addPeriod(b.start_date, x.frequency, MAX_BEHIND) <= today()) throw httpError(400, 'The first period is ' + MAX_BEHIND + ' or more periods ago. Start the plan from the current period and enter older ones as single invoices or bills.');
      const party = side === 'ar' ? await customer(b.customer_id) : await supplier(b.supplier_id);
      const { rows } = await query(
        `INSERT INTO billing_plans (side, name, customer_id, supplier_id, frequency, start_date, end_date, max_runs, next_run, due_days, lines, gct_amount, memo, pay_mode,
                                    late_fee_type, late_fee_amount, late_fee_grace_days, late_fee_repeat, late_fee_min, late_fee_max, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$6,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id`,
        [side, x.name, side === 'ar' ? party.id : null, side === 'ap' ? party.id : null, x.frequency, b.start_date, x.end_date, x.max_runs, x.due_days, JSON.stringify(x.lines), x.gct_amount, x.memo, x.pay_mode,
          x.late_fee_type || null, x.late_fee_amount || null, x.late_fee_grace_days || 0, x.late_fee_repeat || 'once', x.late_fee_min == null ? null : x.late_fee_min, x.late_fee_max == null ? null : x.late_fee_max, req.session.userId]);
      res.json({ ok: true, id: rows[0].id });
      runSoon();
    } catch (e) { fail(res, e); }
  });
  // Changes apply from the next period; documents already raised are not touched.
  app.put('/api/billing/plans/:id', requireAdmin, planCap, async (req, res) => {
    try {
      const p = req.plan, x = await planInput(req.body || {}, p.side);
      if (x.end_date && x.end_date < p.start) throw httpError(400, 'The end date is before the start');
      x.lines = JSON.stringify(x.lines);
      const cols = PLAN_COLS.filter((k) => p.side === 'ar' || !/^late_fee/.test(k));
      await query(`UPDATE billing_plans SET ${cols.map((k, i) => k + ' = $' + (i + 2)).join(', ')}, updated_at = NOW() WHERE id = $1`, [p.id].concat(cols.map((k) => (x[k] === undefined ? null : x[k]))));
      await endIfDone(query, p.id);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  // Pause, resume or end a plan. Resuming with skip_missed drops the periods
  // missed while paused but not the one running today: billing restarts from it.
  app.post('/api/billing/plans/:id/status', requireAdmin, planCap, async (req, res) => {
    try {
      const p = req.plan, b = req.body || {}, to = ['active', 'paused', 'ended'].includes(b.status) ? b.status : null;
      if (!to) throw httpError(400, 'Active, paused or ended?');
      if (p.status === 'ended') throw httpError(409, 'This plan has ended: set up a new one');
      const reason = String(b.reason || '').trim().slice(0, 200) || null;
      let next = p.next;
      if (to === 'active' && b.skip_missed && next && next < today()) { const cur = currentPeriod(p.start, p.frequency, today()); if (cur > next) next = cur; }
      await query(`UPDATE billing_plans SET status = $2, status_reason = $3, next_run = $4, updated_at = NOW() WHERE id = $1`, [p.id, to, to === 'active' ? null : reason, to === 'ended' ? null : next]);
      res.json({ ok: true, next_run: to === 'ended' ? null : next });
      if (to === 'active') runSoon();
    } catch (e) { fail(res, e); }
  });
  // "Run now": bill every period due, however many (the worker pauses a plan that far behind instead).
  app.post('/api/billing/plans/:id/run', requireAdmin, planCap, async (req, res) => {
    try {
      if (req.plan.status !== 'active') throw httpError(409, 'Resume the plan first');
      const made = await runPlan(req.plan.id, req.session.userId, true);
      books.post();
      res.json({ ok: true, created: made });
    } catch (e) { fail(res, e); }
  });

  // A plan with no more periods to bill (past its end date or number of runs) ends.
  async function endIfDone(q, planId) {
    await q(`UPDATE billing_plans p SET status = 'ended', next_run = NULL, updated_at = NOW()
              WHERE p.id = $1 AND p.status <> 'ended' AND ((p.end_date IS NOT NULL AND p.next_run > p.end_date)
                 OR (p.max_runs IS NOT NULL AND (SELECT COUNT(*) FROM billing_runs r WHERE r.plan_id = p.id) >= p.max_runs))`, [planId]);
  }
  // Bill every period of one plan that is due, one transaction per period.
  async function runPlan(planId, userId, manual) {
    let made = 0;
    for (let guard = 0; guard < 120; guard++) {
      const done = await tx(async (c) => {
        const { rows } = await c.query(`SELECT p.*, to_char(p.start_date, 'YYYY-MM-DD') AS start, to_char(p.next_run, 'YYYY-MM-DD') AS period, to_char(p.end_date, 'YYYY-MM-DD') AS ends
                                          FROM billing_plans p WHERE p.id = $1 AND p.status = 'active' FOR UPDATE`, [planId]);
        if (!rows.length || !rows[0].period || rows[0].period > today()) return true;
        const p = rows[0];
        if (!manual && guard === 0 && addPeriod(p.period, p.frequency, MAX_BEHIND) <= today()) {
          await c.query(`UPDATE billing_plans SET status = 'paused', status_reason = $2, updated_at = NOW() WHERE id = $1`,
            [p.id, 'More than ' + MAX_BEHIND + ' periods behind (next ' + p.period + '): resume to bill the missed periods, or resume and skip them']);
          return true;
        }
        if (p.ends && p.period > p.ends) { await endIfDone(c.query.bind(c), p.id); return true; }
        const ins = await c.query(`INSERT INTO billing_runs (plan_id, period_date, created_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING plan_id`, [p.id, p.period, userId || null]);
        if (ins.rows.length) {
          const label = periodLabel(p.period, p.frequency), due = addDays(p.period, p.due_days);
          const lines = p.lines.map((l) => ({ account_id: l.account_id, class_id: l.class_id || null, amount: r2(l.amount), description: (l.description ? String(l.description).replace(/\{period\}/g, label) : p.name + ' · ' + label).slice(0, 200) }));
          if (p.side === 'ar') {
            const inv = await createInvoice(c, { customer_id: p.customer_id, invoice_date: p.period, due_date: due, memo: (p.memo || p.name) + ' · ' + label, gct_amount: p.gct_amount, lines, plan_id: p.id, userId });
            await c.query(`UPDATE billing_runs SET ar_invoice_id = $3 WHERE plan_id = $1 AND period_date = $2`, [p.id, p.period, inv.id]);
          } else {
            const bill = await createBill(c, { supplier_id: p.supplier_id, number: null, bill_date: p.period, due_date: due, memo: (p.memo || p.name) + ' · ' + label, gct_amount: p.gct_amount, lines, userId });
            await c.query(`UPDATE billing_runs SET ap_bill_id = $3 WHERE plan_id = $1 AND period_date = $2`, [p.id, p.period, bill.id]);
          }
          made++;
        }
        await c.query(`UPDATE billing_plans SET next_run = $2 WHERE id = $1`, [p.id, nextPeriod(p.start, p.frequency, p.period)]);
        await endIfDone(c.query.bind(c), p.id);
        return false;
      });
      if (done) break;
    }
    return made;
  }

  // ========================================================= LATE FEES ==
  // Invoices raised here that are past due and open, with the rule that
  // applies: the plan's (unless 'none'), else the customer's for invoices dated
  // from when it was set. Never on POS sales, never on fees.
  async function chargeLateFees(userId) {
    const pick = (k) => `CASE WHEN p.late_fee_type IS NOT NULL THEN p.${k} ELSE s.${k} END`;
    const { rows } = await query(
      `SELECT i.id, i.number, i.customer_id, to_char(i.due_date, 'YYYY-MM-DD') AS due, i.total::float AS total, (SELECT l.class_id FROM ar_invoice_lines l WHERE l.invoice_id = i.id ORDER BY l.id LIMIT 1) AS class_id,
              COALESCE((SELECT SUM(x.amount) FROM ar_applications x JOIN account_payments ap ON ap.id = x.payment_id WHERE x.invoice_id = i.id), 0)::float AS paid,
              ${pick('late_fee_type')} AS type, ${pick('late_fee_amount')}::float AS amount, ${pick('late_fee_grace_days')} AS grace, ${pick('late_fee_repeat')} AS repeat,
              ${pick('late_fee_min')}::float AS min, ${pick('late_fee_max')}::float AS max, to_char(${PROMISE_SQL('i.customer_id')}, 'YYYY-MM-DD') AS promise
         FROM ar_invoices i LEFT JOIN billing_plans p ON p.id = i.plan_id LEFT JOIN ar_billing_settings s ON s.customer_id = i.customer_id
        WHERE i.kind = 'invoice' AND i.voided_at IS NULL AND i.due_date < $1::date
          AND (p.late_fee_type IN ('flat', 'percent') OR (p.late_fee_type IS NULL AND s.late_fee_type IS NOT NULL AND (s.late_fee_from IS NULL OR i.invoice_date >= s.late_fee_from)))`,
      [today()]);
    let made = 0;
    const acct = rows.length ? await systemAccount('late_fee_income') : null;
    for (const r of rows) {
      const open = r2(r.total - r.paid), start = addDays(r.due, r.grace || 0);   // late once today is past due + grace
      if (open <= 0.005 || today() <= start) continue;
      if (r.promise && r.promise >= today()) continue;   // a promise to pay not yet passed holds the fee
      // Monthly: fee 1 the day after the grace period, fee 2 a month later, and so on.
      let k = 1;
      if (r.repeat === 'monthly') while (addPeriod(addDays(start, 1), 'monthly', k) <= today()) k++;
      let fee = r.type === 'percent' ? r2(open * n(r.amount) / 100) : r2(r.amount);
      if (r.min != null) fee = Math.max(fee, r2(r.min));
      if (r.max != null) fee = Math.min(fee, r2(r.max));
      if (!(fee > 0)) continue;
      const period = r.repeat === 'monthly' ? String(k) : 'once';
      const inv = await tx(async (c) => {
        const out = await createInvoice(c, { kind: 'late_fee', customer_id: r.customer_id, invoice_date: today(), due_date: today(), source_invoice_id: r.id, fee_period: period,
          memo: 'Late fee on ' + r.number, lines: [{ account_id: acct, class_id: r.class_id, description: 'Late fee on ' + r.number + ' (due ' + r.due + ')' + (period !== 'once' ? ', month ' + period : ''), amount: fee }], userId });
        if (out) await c.query(`INSERT INTO ar_notes (customer_id, kind, note, created_by) VALUES ($1, 'fee', $2, $3)`,
          [r.customer_id, 'Late fee ' + out.number + ' of ' + money(fee) + ' charged on ' + r.number + ' (' + money(open) + ' open, due ' + r.due + ')', userId || null]);
        return out;
      });
      if (inv) made++;
    }
    return made;
  }

  // ========================================================= REMINDERS ==
  const DEFAULTS = { reminders: false, days_before: 3, on_due: true, days_after: [1, 7, 14], late_fee_type: null, late_fee_amount: null, late_fee_grace_days: 0, late_fee_repeat: 'once', late_fee_min: null, late_fee_max: null, late_fee_from: null };
  app.get('/api/ar/customers/:id/billing', ...AR, async (req, res) => {
    try {
      const cu = await customer(req.params.id);
      const { rows } = await query(`SELECT reminders, days_before, on_due, days_after, late_fee_type, late_fee_amount::float AS late_fee_amount, late_fee_grace_days, late_fee_repeat,
                                           late_fee_min::float AS late_fee_min, late_fee_max::float AS late_fee_max, to_char(late_fee_from, 'YYYY-MM-DD') AS late_fee_from
                                      FROM ar_billing_settings WHERE customer_id = $1`, [cu.id]);
      const { rows: log } = await query(
        `SELECT l.doc, l.doc_id, l.stage, l.status, l.created_at, COALESCE(s.receipt_number, i.number) AS number FROM ar_reminder_log l
           LEFT JOIN pos_sales s ON l.doc = 'sale' AND s.id = l.doc_id LEFT JOIN ar_invoices i ON l.doc = 'invoice' AND i.id = l.doc_id
          WHERE l.customer_id = $1 ORDER BY l.created_at DESC LIMIT 30`, [cu.id]);
      res.json({ settings: rows[0] || DEFAULTS, log, can_email: books.canEmail(cu.email), credit_hold: cu.credit_hold });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/ar/customers/:id/billing', ...AR, async (req, res) => {
    try {
      const cu = await customer(req.params.id), b = req.body || {};
      const before = b.days_before === '' || b.days_before == null ? null : parseInt(b.days_before, 10);
      if (before != null && !(before >= 1 && before <= 30)) throw httpError(400, 'Days before due, 1 to 30 (or blank for none)');
      const after = (Array.isArray(b.days_after) ? b.days_after : String(b.days_after || '').split(/[ ,]+/)).map((x) => parseInt(x, 10)).filter((x) => x >= 1);
      if (after.some((x) => x > 14)) throw httpError(400, 'Reminders after due stop at day 14: from day 15 the procedure is a phone call');
      const lf = lateFee(b);
      if (lf.late_fee_type === 'none') lf.late_fee_type = null;
      const { rows: old } = await query(`SELECT late_fee_type, to_char(late_fee_from, 'YYYY-MM-DD') AS late_fee_from FROM ar_billing_settings WHERE customer_id = $1`, [cu.id]);
      // A customer-wide rule applies to invoices dated from the day it is first switched on.
      const from = lf.late_fee_type ? (isDate(b.late_fee_from) ? b.late_fee_from : old.length && old[0].late_fee_type && old[0].late_fee_from ? old[0].late_fee_from : today()) : null;
      await query(
        `INSERT INTO ar_billing_settings (customer_id, reminders, days_before, on_due, days_after, late_fee_type, late_fee_amount, late_fee_grace_days, late_fee_repeat, late_fee_min, late_fee_max, late_fee_from, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
         ON CONFLICT (customer_id) DO UPDATE SET reminders = EXCLUDED.reminders, days_before = EXCLUDED.days_before, on_due = EXCLUDED.on_due, days_after = EXCLUDED.days_after,
           late_fee_type = EXCLUDED.late_fee_type, late_fee_amount = EXCLUDED.late_fee_amount, late_fee_grace_days = EXCLUDED.late_fee_grace_days, late_fee_repeat = EXCLUDED.late_fee_repeat,
           late_fee_min = EXCLUDED.late_fee_min, late_fee_max = EXCLUDED.late_fee_max, late_fee_from = EXCLUDED.late_fee_from, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
        [cu.id, !!b.reminders, before, b.on_due !== false, [...new Set(after)].sort((a, c) => a - c), lf.late_fee_type, lf.late_fee_amount, lf.late_fee_grace_days, lf.late_fee_repeat, lf.late_fee_min, lf.late_fee_max, from, req.session.userId]);
      res.json({ ok: true, late_fee_from: from });
    } catch (e) { fail(res, e); }
  });

  // Which reminder stage, if any, a document is at today. A stage is only sent
  // within a few days of its date (the till may have been off), never later, so
  // switching reminders on for a customer does not email their whole history.
  function stageFor(doc, st, promised, onHold) {
    const due = doc.due || doc.day, over = daysBetween(due, today());
    if (doc.open <= 0.005 || over >= 15) return null;
    if (over < 0) return !onHold && st.days_before && -over <= st.days_before && -over >= Math.max(st.days_before - 2, 1) ? 'before' : null;
    if (over === 0) return st.on_due ? 'due' : null;
    if (promised) return null;
    const d = (st.days_after || []).filter((x) => x <= 14 && over >= x && over <= x + 2).pop();
    return d ? 'after:' + d : null;
  }
  async function sendReminders(sh) {
    const { rows: custs } = await query(
      `SELECT s.days_before, s.on_due, s.days_after, u.id, COALESCE(NULLIF(u.name, ''), u.email) AS name, u.email, u.credit_hold, to_char(${PROMISE_SQL('u.id')}, 'YYYY-MM-DD') AS promise
         FROM ar_billing_settings s JOIN users u ON u.id = s.customer_id WHERE s.reminders AND NOT u.is_staff`);
    let sent = 0;
    for (const cu of custs) {
      try {
        const promised = !!(cu.promise && cu.promise >= today());
        // Open items as of today (BILLING_TODAY in tests): days overdue from the due date.
        const open = (await books.openInvoices(cu.id)).map((d) => Object.assign(d, { days_overdue: Math.max(daysBetween(d.due || d.day, today()), 0) }));
        const hits = open.map((d) => ({ d, stage: stageFor(d, cu, promised, cu.credit_hold) })).filter((x) => x.stage);
        if (!hits.length) continue;
        // Claim the (document, stage) rows first: whatever another run already claimed is not sent again.
        const noEmail = !books.canEmail(cu.email);
        const claimed = await tx(async (c) => {
          const got = [];
          for (const h of hits) {
            const { rows } = await c.query(`INSERT INTO ar_reminder_log (doc, doc_id, stage, customer_id, status) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING doc`,
              [h.d.doc, h.d.id, h.stage, cu.id, noEmail ? 'no_email' : 'sending']);
            if (rows.length) got.push(h);
          }
          return got;
        });
        if (!claimed.length) continue;
        const what = claimed.map((h) => h.d.receipt_number + ' (' + (h.stage === 'before' ? 'due ' + h.d.due : h.stage === 'due' ? 'due today' : h.d.days_overdue + ' days overdue') + ')').join(', ');
        if (noEmail) {
          await query(`INSERT INTO ar_notes (customer_id, kind, note) VALUES ($1, 'reminder', $2)`, [cu.id, 'Automatic reminder not sent, no email address: phone them about ' + what]);
          continue;
        }
        // The email lists everything past due (as the manual reminder does) and what is coming due today or soon.
        const overdue = open.filter((d) => d.days_overdue > 0 && d.open > 0.005);
        const soon = claimed.filter((h) => h.stage === 'before' || h.stage === 'due').map((h) => h.d);
        const mail = books.reminderEmail(cu.name, overdue, sh, soon);
        let ok = true;
        try { await mailer.sendEmail({ to: cu.email, subject: mail.subject, text: mail.text }); } catch (e) { ok = false; console.warn('[billing] reminder', cu.id, e.message); }
        for (const h of claimed) await query(`UPDATE ar_reminder_log SET status = $4 WHERE doc = $1 AND doc_id = $2 AND stage = $3`, [h.d.doc, h.d.id, h.stage, ok ? 'sent' : 'failed']);
        await query(`INSERT INTO ar_notes (customer_id, kind, note) VALUES ($1, 'reminder', $2)`,
          [cu.id, (ok ? 'Automatic reminder emailed' : 'Automatic reminder FAILED to send') + ': ' + what + (overdue.length ? '; ' + money(mail.total) + ' past due' : '')]);
        if (ok) sent++;
      } catch (e) { note('reminders for customer ' + cu.id, e); }
    }
    return sent;
  }
  // The accounts email: loan instalments and recurring bills paid by hand, a few days before they are due.
  async function apNotices(sh) {
    const days = Math.max(1, parseInt(await setting('billing_ap_notice_days', '3'), 10) || 3), until = addDays(today(), days);
    if (!books.canEmail(sh.email)) return 0;
    const { rows: inst } = await query(
      `SELECT 'loan:' || li.id AS key, to_char(li.due_date, 'YYYY-MM-DD') AS due, li.payment::float AS amount, l.name, s.name AS party
         FROM loan_instalments li JOIN loans l ON l.id = li.loan_id JOIN suppliers s ON s.id = l.supplier_id
        WHERE l.status = 'active' AND l.pay_mode = 'manual' AND li.status = 'scheduled' AND li.due_date BETWEEN $1::date AND $2::date`, [today(), until]);
    const { rows: plans } = await query(
      `SELECT 'plan:' || p.id || ':' || to_char(p.next_run, 'YYYY-MM-DD') AS key, to_char(p.next_run + p.due_days, 'YYYY-MM-DD') AS due, p.lines, p.gct_amount::float AS gct, p.name, s.name AS party
         FROM billing_plans p JOIN suppliers s ON s.id = p.supplier_id
        WHERE p.side = 'ap' AND p.status = 'active' AND p.pay_mode = 'manual' AND p.next_run + p.due_days BETWEEN $1::date AND $2::date`, [today(), until]);
    for (const p of plans) p.amount = r2(p.lines.reduce((t, l) => t + n(l.amount), 0) + p.gct);
    const items = [];
    for (const x of inst.concat(plans)) {
      const { rows } = await query(`INSERT INTO billing_notices (key) VALUES ($1) ON CONFLICT DO NOTHING RETURNING key`, [x.key]);
      if (rows.length) items.push(x);
    }
    if (!items.length) return 0;
    items.sort((a, b) => a.due.localeCompare(b.due));
    const text = 'These payments are due soon and are paid by hand (not by standing order):\n\n' +
      items.map((x) => x.due + '  ' + x.party + '  ' + x.name + '  ' + money(x.amount)).join('\n') +
      '\n\nThe bill appears in Payables on its date; pay it with Pay Bills.\n\n' + (sh.name || 'Morty\'s Auto Parts') + ' till';
    try { await mailer.sendEmail({ to: sh.email, subject: 'Payments due in the next ' + days + ' days: ' + money(items.reduce((t, x) => t + x.amount, 0)), text }); }
    catch (e) { note('payables notice email', e); }
    return items.length;
  }

  // ============================================================ WORKER ==
  let busy = false, lastRun = null;
  const errors = [];
  function note(where, e) { errors.unshift({ at: new Date().toISOString(), where, error: String(e.message || e).slice(0, 300) }); errors.length = Math.min(errors.length, 30); console.warn('[billing]', where, e.message); }
  async function runAll(userId, opts = {}) {
    if (busy) return { busy: true };
    busy = true;
    const out = { at: new Date().toISOString(), today: today(), loan_bills: 0, invoices_and_bills: 0, late_fees: 0, reminders: 0, ap_notices: 0, paused: 0 };
    let lockClient = null;
    try {
      lockClient = await getPool().connect();
      const { rows: lk } = await lockClient.query(`SELECT pg_try_advisory_lock(hashtext('billing_worker')) AS ok`);
      if (!lk[0].ok) return { busy: true };
      try {
        const { rows: due } = await query(`SELECT li.id FROM loan_instalments li JOIN loans l ON l.id = li.loan_id WHERE li.status = 'scheduled' AND l.status = 'active' AND li.due_date <= $1::date ORDER BY li.due_date, li.id`, [today()]);
        for (const r of due) { try { if (await billInstalment(r.id, userId)) out.loan_bills++; } catch (e) { note('loan instalment ' + r.id, e); } }
        const { rows: plans } = await query(`SELECT id FROM billing_plans WHERE status = 'active' AND next_run <= $1::date ORDER BY next_run, id`, [today()]);
        for (const p of plans) { try { out.invoices_and_bills += await runPlan(p.id, userId, false); } catch (e) { note('plan ' + p.id, e); } }
        const { rows: ps } = await query(`SELECT COUNT(*)::int AS k FROM billing_plans WHERE status = 'paused' AND status_reason LIKE 'More than%'`);
        out.paused = ps[0].k;
        try { out.late_fees = await chargeLateFees(userId); } catch (e) { note('late fees', e); }
        const h = jaNow().getUTCHours();
        if (opts.reminders || (h >= 8 && h < 18)) {
          const sh = (await getShop()) || {};
          try { out.reminders = await sendReminders(sh); } catch (e) { note('reminders', e); }
          try { out.ap_notices = await apNotices(sh); } catch (e) { note('payables notice', e); }
        }
      } finally { await lockClient.query(`SELECT pg_advisory_unlock(hashtext('billing_worker'))`); }
      if (out.loan_bills || out.invoices_and_bills || out.late_fees) await books.post();
    } finally { if (lockClient) lockClient.release(); busy = false; lastRun = out; }
    return out;
  }
  let soon = null;
  function runSoon() { if (soon) return; soon = setTimeout(() => { soon = null; tick(); }, 1500); if (soon.unref) soon.unref(); }
  async function tick() {
    try { if ((await setting('billing_auto', 'on')) !== 'off') await runAll(null); } catch (e) { note('worker', e); }
  }
  const timer = setInterval(tick, 10 * 60000);
  if (timer.unref) timer.unref();
  const first = setTimeout(tick, 60000);
  if (first.unref) first.unref();

  app.get('/api/billing/status', requireAdmin, async (req, res) => {
    try {
      const { rows: ps } = await query(`SELECT id, side, name, status_reason FROM billing_plans WHERE status = 'paused' ORDER BY id`);
      res.json({ auto: (await setting('billing_auto', 'on')) !== 'off', ap_notice_days: parseInt(await setting('billing_ap_notice_days', '3'), 10) || 3, last_run: lastRun, errors, paused: ps, today: today() });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/billing/settings', ...can('acct.setup'), async (req, res) => {
    try {
      const b = req.body || {};
      const put = (k, v) => query(`INSERT INTO warehouse_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [k, v]);
      if (b.auto !== undefined) await put('billing_auto', b.auto ? 'on' : 'off');
      if (b.ap_notice_days !== undefined) { const d = parseInt(b.ap_notice_days, 10); if (!(d >= 1 && d <= 30)) throw httpError(400, 'Notice days 1 to 30'); await put('billing_ap_notice_days', String(d)); }
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/billing/run-now', requireAdmin, requireCap('ar.manage'), requireCap('ap.manage'), async (req, res) => {
    try { res.json(await runAll(req.session.userId, { reminders: !!(req.body || {}).reminders })); } catch (e) { fail(res, e); }
  });
  // What is coming up: loan instalments and recurring bills and invoices in the next N days.
  app.get('/api/billing/upcoming', requireAdmin, async (req, res) => {
    try {
      const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 120), until = addDays(today(), days);
      const { rows: inst } = await query(
        `SELECT 'loan' AS kind, l.id AS ref_id, li.id AS item_id, to_char(li.due_date, 'YYYY-MM-DD') AS due, li.payment::float AS amount, l.name, s.name AS party, l.pay_mode
           FROM loan_instalments li JOIN loans l ON l.id = li.loan_id JOIN suppliers s ON s.id = l.supplier_id
          WHERE l.status = 'active' AND li.status = 'scheduled' AND li.due_date <= $1::date ORDER BY li.due_date`, [until]);
      const { rows: plans } = await query(
        `SELECT p.side AS kind, p.id AS ref_id, to_char(p.next_run, 'YYYY-MM-DD') AS due, p.lines, p.gct_amount::float AS gct, p.name, COALESCE(NULLIF(u.name, ''), u.email, s.name) AS party, p.pay_mode
           FROM billing_plans p LEFT JOIN users u ON u.id = p.customer_id LEFT JOIN suppliers s ON s.id = p.supplier_id
          WHERE p.status = 'active' AND p.next_run <= $1::date ORDER BY p.next_run`, [until]);
      for (const p of plans) { p.amount = r2(p.lines.reduce((t, l) => t + n(l.amount), 0) + p.gct); delete p.lines; delete p.gct; }
      res.json({ items: inst.concat(plans).sort((a, b) => a.due.localeCompare(b.due)), until });
    } catch (e) { fail(res, e); }
  });

  // ================================================== LOANS & RENT PAGE ==
  // One register for loans-rent.html: every loan, rental agreement (recurring
  // invoice) and recurring bill, with what is owed and overdue on it now; and
  // the documents they raised. Filtering, printing and export happen in the
  // page. Rows the signed-in person may not see (no ar.manage / ap.manage) are left out.
  async function sides(req) {
    const can2 = deps.userCan || (async () => true);
    return { ar: await can2(req, 'ar.manage'), ap: await can2(req, 'ap.manage') };
  }
  // Open and overdue per A/R invoice raised on the books.
  const AR_DOCS = `
    SELECT i.id, i.number, i.kind, i.customer_id, i.plan_id, i.source_invoice_id, to_char(i.invoice_date, 'YYYY-MM-DD') AS day, to_char(i.due_date, 'YYYY-MM-DD') AS due,
           i.total::float AS total, i.memo, i.voided_at IS NOT NULL AS void,
           COALESCE((SELECT SUM(x.amount) FROM ar_applications x JOIN account_payments ap ON ap.id = x.payment_id WHERE x.invoice_id = i.id), 0)::float AS paid
      FROM ar_invoices i`;
  app.get('/api/billing/register', requireAdmin, async (req, res) => {
    try {
      const sd = await sides(req), t = today(), out = [];
      if (!sd.ar && !sd.ap) throw httpError(403, 'Your account cannot see receivables or payables');
      const { rows: inv } = sd.ar ? await query(AR_DOCS) : { rows: [] };
      for (const i of inv) i.open = i.void ? 0 : r2(i.total - i.paid);
      const ap = sd.ap ? (await books.apDocs(null)).filter((d) => d.kind === 'bill') : [];
      const apById = new Map(ap.map((d) => [d.id, d]));
      if (sd.ap) {
        const { rows } = await query(
          `SELECT l.id, l.name, l.reference, l.status, l.pay_mode, l.principal::float AS principal, l.annual_rate::float AS rate, l.frequency, l.supplier_id, s.name AS party,
                  to_char(l.start_date, 'YYYY-MM-DD') AS start, x.principal_billed, x.interest_billed, to_char(x.next_due, 'YYYY-MM-DD') AS next_due,
                  (SELECT li.payment::float FROM loan_instalments li WHERE li.loan_id = l.id AND li.status = 'scheduled' ORDER BY li.due_date LIMIT 1) AS next_amount,
                  COALESCE((SELECT array_agg(li.ap_bill_id) FROM loan_instalments li WHERE li.loan_id = l.id AND li.ap_bill_id IS NOT NULL), '{}') AS bills
             FROM loans l JOIN suppliers s ON s.id = l.supplier_id JOIN (${LOAN_SUMS}) x ON x.id = l.id`);
        for (const l of rows) {
          const bills = l.bills.map((b) => apById.get(b)).filter(Boolean);
          const open = r2(bills.reduce((s, b) => s + b.open, 0)), overdue = r2(bills.filter((b) => b.due && b.due < t).reduce((s, b) => s + b.open, 0));
          const balance = l.status === 'cancelled' ? 0 : r2(l.principal - l.principal_billed);
          out.push({ type: 'loan', id: l.id, name: l.name, reference: l.reference, party: l.party, party_id: l.supplier_id, frequency: l.frequency, start: l.start, pay_mode: l.pay_mode,
            amount: l.next_amount, next_due: l.next_due, principal: l.principal, rate: l.rate, interest_billed: l.interest_billed, balance, open, overdue,
            status: l.status === 'cancelled' ? 'cancelled' : overdue > 0.005 ? 'overdue' : l.status === 'paid' && open <= 0.005 ? 'paid' : 'active' });
        }
      }
      const { rows: plans } = await query(
        `SELECT p.id, p.side, p.name, p.status, p.status_reason, p.frequency, p.pay_mode, p.lines, p.gct_amount::float AS gct, to_char(p.start_date, 'YYYY-MM-DD') AS start, to_char(p.next_run, 'YYYY-MM-DD') AS next_run,
                p.customer_id, p.supplier_id, COALESCE(NULLIF(u.name, ''), u.email, s.name) AS party, p.late_fee_type, p.late_fee_amount::float AS late_fee_amount,
                COALESCE((SELECT array_agg(r.ap_bill_id) FROM billing_runs r WHERE r.plan_id = p.id AND r.ap_bill_id IS NOT NULL), '{}') AS bills
           FROM billing_plans p LEFT JOIN users u ON u.id = p.customer_id LEFT JOIN suppliers s ON s.id = p.supplier_id`);
      for (const p of plans) {
        if (p.side === 'ar' ? !sd.ar : !sd.ap) continue;
        let docs;
        if (p.side === 'ar') { const own = inv.filter((i) => i.plan_id === p.id); const ids = new Set(own.map((i) => i.id)); docs = own.concat(inv.filter((i) => ids.has(i.source_invoice_id))).filter((i) => !i.void); }
        else docs = p.bills.map((b) => apById.get(b)).filter(Boolean);
        const open = r2(docs.reduce((s, d) => s + d.open, 0)), overdue = r2(docs.filter((d) => d.due && d.due < t).reduce((s, d) => s + d.open, 0));
        out.push({ type: p.side === 'ar' ? 'rent' : 'bill', id: p.id, name: p.name, party: p.party, party_id: p.customer_id || p.supplier_id, frequency: p.frequency, start: p.start, pay_mode: p.pay_mode,
          amount: r2(p.lines.reduce((s, l) => s + n(l.amount), 0) + p.gct), next_due: p.next_run, balance: open, open, overdue, status_reason: p.status_reason,
          fees: p.side === 'ar' ? r2(docs.filter((d) => d.kind === 'late_fee').reduce((s, d) => s + d.total, 0)) : null,
          status: p.status === 'ended' ? (open > 0.005 ? (overdue > 0.005 ? 'overdue' : 'active') : 'ended') : p.status === 'paused' ? 'paused' : overdue > 0.005 ? 'overdue' : 'active' });
      }
      res.json({ rows: out, today: t, can: sd });
    } catch (e) { fail(res, e); }
  });
  // Everything raised: invoices, late fees and payments received on them; loan and plan bills; reminders.
  app.get('/api/billing/documents', requireAdmin, async (req, res) => {
    try {
      const sd = await sides(req), t = today(), out = [];
      if (sd.ar) {
        const { rows: inv } = await query(`SELECT d.*, COALESCE(NULLIF(u.name, ''), u.email) AS party, p.name AS plan, src.number AS fee_on FROM (${AR_DOCS}) d JOIN users u ON u.id = d.customer_id
                                             LEFT JOIN billing_plans p ON p.id = d.plan_id LEFT JOIN ar_invoices src ON src.id = d.source_invoice_id`);
        for (const i of inv) {
          const open = i.void ? 0 : r2(i.total - i.paid);
          out.push({ type: i.kind === 'late_fee' ? 'late_fee' : 'invoice', id: i.id, number: i.number, day: i.day, due: i.due, party: i.party, party_id: i.customer_id, agreement: i.plan || (i.fee_on ? 'Fee on ' + i.fee_on : 'One-off'),
            amount: i.total, open, status: i.void ? 'void' : open <= 0.005 ? 'paid' : i.due < t ? 'overdue' : 'open', memo: i.memo });
        }
        const { rows: pays } = await query(
          `SELECT ap.id, to_char(COALESCE(ap.paid_on, ap.created_at::date), 'YYYY-MM-DD') AS day, ap.amount_usd::float AS amount, ap.method, ap.reference, ap.customer_id, COALESCE(NULLIF(u.name, ''), u.email) AS party,
                  (SELECT string_agg(i.number, ', ' ORDER BY i.number) FROM ar_applications x JOIN ar_invoices i ON i.id = x.invoice_id WHERE x.payment_id = ap.id) AS applied
             FROM account_payments ap JOIN users u ON u.id = ap.customer_id
            WHERE EXISTS (SELECT 1 FROM ar_applications x WHERE x.payment_id = ap.id AND x.invoice_id IS NOT NULL)`);
        for (const p of pays) out.push({ type: 'payment', id: p.id, number: p.reference || 'Payment ' + p.id, day: p.day, party: p.party, party_id: p.customer_id, agreement: 'Paid ' + p.applied, amount: p.amount, open: 0, status: p.method });
        const { rows: rem } = await query(
          `SELECT l.doc, l.doc_id, l.stage, l.status, to_char(l.created_at AT TIME ZONE 'America/Jamaica', 'YYYY-MM-DD') AS day, l.customer_id, COALESCE(NULLIF(u.name, ''), u.email) AS party,
                  COALESCE(s.receipt_number, i.number) AS number
             FROM ar_reminder_log l JOIN users u ON u.id = l.customer_id LEFT JOIN pos_sales s ON l.doc = 'sale' AND s.id = l.doc_id LEFT JOIN ar_invoices i ON l.doc = 'invoice' AND i.id = l.doc_id`);
        for (const r of rem) out.push({ type: 'reminder', id: r.doc + ':' + r.doc_id + ':' + r.stage, number: r.number, day: r.day, party: r.party, party_id: r.customer_id, agreement: 'Reminder: ' + r.stage, amount: null, open: null, status: r.status });
      }
      if (sd.ap) {
        const ap = new Map((await books.apDocs(null)).filter((d) => d.kind === 'bill').map((d) => [d.id, d]));
        const { rows: lb } = await query(`SELECT li.ap_bill_id AS id, l.name, l.id AS loan_id FROM loan_instalments li JOIN loans l ON l.id = li.loan_id WHERE li.ap_bill_id IS NOT NULL
                                           UNION ALL SELECT r.ap_bill_id, p.name, NULL FROM billing_runs r JOIN billing_plans p ON p.id = r.plan_id WHERE r.ap_bill_id IS NOT NULL`);
        const { rows: vb } = await query(`SELECT id FROM ap_bills WHERE voided_at IS NOT NULL`);
        const voided = new Set(vb.map((v) => v.id));
        for (const b of lb) {
          const d = ap.get(b.id);
          if (!d && !voided.has(b.id)) continue;
          out.push({ type: b.loan_id ? 'loan_bill' : 'bill', id: b.id, number: d ? d.number : '#' + b.id, day: d ? d.day : null, due: d ? d.due : null, party: d ? d.supplier : '', party_id: d ? d.supplier_id : null, agreement: b.name,
            amount: d ? d.amount : 0, open: d ? d.open : 0, status: voided.has(b.id) ? 'void' : d.open <= 0.005 ? 'paid' : d.due && d.due < t ? 'overdue' : 'open' });
        }
      }
      out.sort((a, b) => String(b.day || '').localeCompare(String(a.day || '')));
      res.json({ rows: out, today: t });
    } catch (e) { fail(res, e); }
  });
  // A payment receipt (money received on account), for printing or sending.
  app.get('/api/billing/receipts/:id', ...AR, async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT ap.id, to_char(COALESCE(ap.paid_on, ap.created_at::date), 'YYYY-MM-DD') AS day, ap.amount_usd::float AS amount, ap.method, ap.reference, ap.notes, ap.customer_id,
                COALESCE(NULLIF(u.name, ''), u.email) AS customer, u.account_number, u.email, u.phone, ga.name AS deposit_to
           FROM account_payments ap JOIN users u ON u.id = ap.customer_id LEFT JOIN gl_accounts ga ON ga.id = ap.deposit_account_id WHERE ap.id = $1`, [parseInt(req.params.id, 10)]);
      if (!rows.length) throw httpError(404, 'Payment not found (or voided)');
      const { rows: apps } = await query(
        `SELECT COALESCE(s.receipt_number, i.number) AS number, x.amount::float AS amount FROM ar_applications x LEFT JOIN pos_sales s ON s.id = x.sale_id LEFT JOIN ar_invoices i ON i.id = x.invoice_id WHERE x.payment_id = $1 ORDER BY x.id`, [rows[0].id]);
      const bal = (await books.openInvoices(rows[0].customer_id)).reduce((t, i) => t + i.open, 0);
      res.json({ receipt: rows[0], applied: apps, balance_after: r2(bal), shop: (await getShop()) || {} });
    } catch (e) { fail(res, e); }
  });
  // Send a document the page composed (statement, invoice, receipt, loan schedule)
  // by email, SMS or WhatsApp, to the address on the customer's or supplier's
  // record (never one typed in), through the notifications log.
  app.post('/api/billing/send', requireAdmin, async (req, res) => {
    try {
      const b = req.body || {}, sd = await sides(req);
      const channel = ['email', 'sms', 'whatsapp'].includes(b.channel) ? b.channel : null;
      if (!channel) throw httpError(400, 'Email, SMS or WhatsApp?');
      if (!deps.notify || !deps.notify.message) throw httpError(501, 'Messaging is not available on this server');
      const text = String(b.text || '').trim().slice(0, channel === 'email' ? 20000 : 1500);
      if (text.length < 5) throw httpError(400, 'Nothing to send');
      let who;
      if (b.customer_id) {
        if (!sd.ar) throw httpError(403, 'Your account cannot send to customers');
        const { rows } = await query(`SELECT id, COALESCE(NULLIF(name, ''), email) AS name, email, phone FROM users WHERE id = $1 AND NOT is_staff`, [parseInt(b.customer_id, 10) || 0]);
        if (!rows.length) throw httpError(404, 'Customer not found');
        who = rows[0];
      } else if (b.supplier_id) {
        if (!sd.ap) throw httpError(403, 'Your account cannot send to suppliers');
        const { rows } = await query(`SELECT id, name, email, phone FROM suppliers WHERE id = $1`, [parseInt(b.supplier_id, 10) || 0]);
        if (!rows.length) throw httpError(404, 'Supplier not found');
        who = rows[0];
      } else throw httpError(400, 'Send to which customer or supplier?');
      const what = String(b.what || 'Document').slice(0, 80);
      const row = await deps.notify.message({ channel, to: channel === 'email' ? who.email : who.phone, subject: String(b.subject || what).slice(0, 150), text,
        related_kind: 'billing_' + String(b.kind || 'document').replace(/[^a-z_]/g, '').slice(0, 20), related_id: parseInt(b.ref, 10) || null,
        customer_id: b.customer_id ? who.id : null, by_user: req.session.userId });
      if (b.customer_id && ['sent', 'stubbed', 'link', 'queued'].includes(row.status)) {
        await query(`INSERT INTO ar_notes (customer_id, kind, note, created_by) VALUES ($1, $2, $3, $4)`,
          [who.id, channel === 'email' ? 'email' : 'note', what + ' ' + (channel === 'whatsapp' ? 'prepared for WhatsApp' : 'sent by ' + (channel === 'sms' ? 'SMS' : 'email')) + ' to ' + row.to_addr, req.session.userId]);
      }
      res.json({ ok: ['sent', 'stubbed', 'link', 'queued'].includes(row.status), status: row.status, reason: row.reason, to: row.to_addr, wa_link: row.wa_link || null });
    } catch (e) { fail(res, e); }
  });

  return { runAll };
}

module.exports = { register, schedule, addPeriod, nextPeriod, currentPeriod };
