'use strict';
// =============================================================================
//  Vision Auto Solutions -- credit cards (built like Banking, books.js)
//
//  Cards        one ledger account (QuickBooks type CCARD, a liability) per card,
//               with its details: issuer, last 4 digits, limit, interest rates,
//               statement and due days, minimum payment rule, who pays it, and
//               the people who hold a card on the account.
//  Register     every ledger line on the card, whichever module made it:
//               charges entered here, supplier bills paid by card (Payables),
//               purchase orders paid by card, payments from the bank, journals.
//  Charges      purchase, refund / credit, fee, interest, cash advance; a line
//               per expense account (with class and asset) and the cardholder.
//  Pay the card from a bank account (statement balance, minimum, other).
//  Statements   the summary from each statement (balances, minimum, due date,
//               points), the statement file itself (PDF / picture / CSV), and
//               its lines imported from CSV to match or add.
//  Reconcile    against a statement, ticking ledger lines (bank_recons /
//               bank_cleared, the same tables Banking uses).
//  Rewards      points / cashback / miles: earned (worked out from spending or
//               taken from the statements), bonuses, redemptions (a statement
//               credit posts to Credit Card Rewards income), expiry.
//  Reports      spending by category, payee, cardholder, module and month;
//               interest and fees; payments; statements; rewards; alerts.
//
//  Money moves are bank_txns on the card account (cc_txn_meta says what kind),
//  so gl.js posts them with the existing bank_txn poster: a charge is Dr the
//  expense lines, Cr the card; a refund or reward credit the reverse; a payment
//  is a bank_txn on the bank account with one line to the card (Dr card, Cr bank).
//  All amounts shown are "owed on the card" (the ledger's credit balance, + = owe).
//  No DDL at start-up: the tables are in schema.sql and made on first use.
// =============================================================================
const crypto = require('crypto');

const DDL = `
CREATE TABLE IF NOT EXISTS cc_cards (
  account_id          INTEGER PRIMARY KEY REFERENCES gl_accounts(id),
  issuer              TEXT,
  network             TEXT,
  last4               TEXT,
  holder_name         TEXT,
  credit_limit        NUMERIC(14,2),
  cash_limit          NUMERIC(14,2),
  apr                 NUMERIC(7,3),
  cash_apr            NUMERIC(7,3),
  statement_day       INTEGER,
  due_day             INTEGER,
  min_pct             NUMERIC(7,3) DEFAULT 5,
  min_floor           NUMERIC(14,2) DEFAULT 0,
  annual_fee          NUMERIC(14,2),
  fee_month           INTEGER,
  pay_from_account_id INTEGER REFERENCES gl_accounts(id),
  autopay             TEXT DEFAULT 'none',
  rewards_kind        TEXT DEFAULT 'none',
  rewards_name        TEXT,
  earn_rate           NUMERIC(12,4) DEFAULT 0,
  point_value         NUMERIC(12,4) DEFAULT 0,
  rewards_mode        TEXT DEFAULT 'calculate',
  rewards_start       DATE,
  expires             TEXT,
  status              TEXT DEFAULT 'active',
  notes               TEXT,
  created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS cc_holders (
  id            SERIAL PRIMARY KEY,
  account_id    INTEGER NOT NULL REFERENCES gl_accounts(id),
  name          TEXT NOT NULL,
  last4         TEXT,
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  monthly_limit NUMERIC(14,2),
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS cc_statements (
  id               SERIAL PRIMARY KEY,
  account_id       INTEGER NOT NULL REFERENCES gl_accounts(id),
  period_start     DATE,
  closing_date     DATE NOT NULL,
  due_date         DATE,
  previous_balance NUMERIC(14,2),
  payments_credits NUMERIC(14,2),
  purchases        NUMERIC(14,2),
  cash_advances    NUMERIC(14,2),
  fees             NUMERIC(14,2),
  interest         NUMERIC(14,2),
  new_balance      NUMERIC(14,2) NOT NULL,
  minimum_due      NUMERIC(14,2),
  credit_limit     NUMERIC(14,2),
  points_earned    NUMERIC(14,2),
  points_redeemed  NUMERIC(14,2),
  points_balance   NUMERIC(14,2),
  file_name        TEXT,
  file_type        TEXT,
  file_size        INTEGER,
  file             BYTEA,
  status           TEXT NOT NULL DEFAULT 'open',
  recon_id         INTEGER REFERENCES bank_recons(id) ON DELETE SET NULL,
  notes            TEXT,
  created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (account_id, closing_date)
);
CREATE TABLE IF NOT EXISTS cc_txn_meta (
  bank_txn_id   INTEGER PRIMARY KEY REFERENCES bank_txns(id) ON DELETE CASCADE,
  card_id       INTEGER NOT NULL REFERENCES gl_accounts(id),
  kind          TEXT NOT NULL,
  holder_id     INTEGER REFERENCES cc_holders(id) ON DELETE SET NULL,
  statement_id  INTEGER REFERENCES cc_statements(id) ON DELETE SET NULL,
  moved_line_id BIGINT,
  receipt_name  TEXT,
  receipt_type  TEXT,
  receipt       BYTEA
);
CREATE INDEX IF NOT EXISTS idx_cc_txn_meta_card ON cc_txn_meta (card_id, kind);
CREATE TABLE IF NOT EXISTS cc_reward_rules (
  id            SERIAL PRIMARY KEY,
  account_id    INTEGER NOT NULL REFERENCES gl_accounts(id),
  gl_account_id INTEGER NOT NULL REFERENCES gl_accounts(id),
  multiplier    NUMERIC(8,3) NOT NULL DEFAULT 1,
  UNIQUE (account_id, gl_account_id)
);
CREATE TABLE IF NOT EXISTS cc_reward_events (
  id           SERIAL PRIMARY KEY,
  account_id   INTEGER NOT NULL REFERENCES gl_accounts(id),
  kind         TEXT NOT NULL,
  event_date   DATE NOT NULL,
  points       NUMERIC(14,2) NOT NULL,
  value        NUMERIC(14,2),
  statement_id INTEGER REFERENCES cc_statements(id) ON DELETE CASCADE,
  bank_txn_id  INTEGER REFERENCES bank_txns(id) ON DELETE SET NULL,
  memo         TEXT,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  voided_at    TIMESTAMPTZ
);
ALTER TABLE purchase_order_payments ADD COLUMN IF NOT EXISTS card_account_id INTEGER REFERENCES gl_accounts(id);
INSERT INTO gl_accounts (code, name, type, qb_name, qb_type, system_key) VALUES
  ('6955', 'Credit Card Interest and Fees', 'expense', 'Credit Card Interest and Fees', 'EXP', 'cc_charges'),
  ('4910', 'Credit Card Rewards and Cashback', 'other_income', 'Credit Card Rewards', 'EXINC', 'cc_rewards')
ON CONFLICT DO NOTHING;
`;

const KINDS = {
  purchase: 'Purchase', refund: 'Refund / credit', fee: 'Fee', interest: 'Interest', cash_advance: 'Cash advance',
  payment: 'Payment', reward: 'Reward credit', moved: 'Moved to card', journal: 'Journal', bill: 'Supplier bill paid', po: 'Purchase order paid', other: 'Other',
};
const SOURCES = { bank_txn: 'Credit cards / Banking', ap_payment: 'Payables', po_payment: 'Purchase orders', manual: 'Journal', opening: 'Opening balance', ap_payment_void: 'Payables (void)', bank_txn_void: 'Void' };

function register(app, deps) {
  const { query, getPool, requireAdmin, requireCap, books } = deps;
  const can = (k) => [requireAdmin, requireCap(k)];
  const CC = can('cards.manage');
  const n = (v) => (v == null || v === '' ? 0 : Number(v));
  const r2 = (v) => Math.round(n(v) * 100) / 100;
  const numOrNull = (v) => (v == null || v === '' || isNaN(Number(v)) ? null : r2(v));
  const money = (v) => (r2(v) < 0 ? '-' : '') + 'J$' + Math.abs(r2(v)).toLocaleString('en-JM', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !isNaN(Date.parse(v));
  const today = () => new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10);
  const str = (v, max) => { const s = String(v == null ? '' : v).trim().slice(0, max || 200); return s || null; };
  function httpError(status, msg) { const e = new Error(msg); e.status = status; e.publicMessage = msg; return e; }
  function fail(res, e) { const s = e.status || 500; if (s >= 500) console.error('[cards]', e); res.status(s).json({ error: e.publicMessage || e.message }); }
  async function tx(fn) {
    const c = await getPool().connect();
    try { await c.query('BEGIN'); const out = await fn(c); await c.query('COMMIT'); return out; }
    catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} throw e; }
    finally { c.release(); }
  }
  let readyP = null;
  const ready = () => (readyP = readyP || query(DDL).catch((e) => { readyP = null; throw e; }));
  const post = () => (books && books.post ? books.post() : null);
  let multer = null; try { multer = require('multer'); } catch (_) {}
  const upload = multer ? multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } }) : null;
  const maybeFile = (field) => (req, res, next) => (upload && /multipart/i.test(req.get('content-type') || '') ? upload.single(field)(req, res, (e) => (e ? res.status(400).json({ error: e.code === 'LIMIT_FILE_SIZE' ? 'The file is bigger than 15 MB' : e.message }) : next())) : next());

  // The two accounts this module posts to; made on first use if schema.sql could not add them (a code was taken).
  const OWN = { cc_charges: ['Credit Card Interest and Fees', 'expense', 'EXP', 6955], cc_rewards: ['Credit Card Rewards and Cashback', 'other_income', 'EXINC', 4910] };
  async function acctByKey(k) {
    await ready();
    const { rows } = await query(`SELECT id FROM gl_accounts WHERE system_key = $1`, [k]);
    if (rows.length) return rows[0].id;
    const o = OWN[k];
    if (!o) throw httpError(500, 'Account ' + k + ' is missing');
    for (let code = o[3]; code < o[3] + 40; code++) {
      const { rows: r } = await query(`INSERT INTO gl_accounts (code, name, type, qb_name, qb_type, system_key) VALUES ($1,$2,$3,$2,$4,$5) ON CONFLICT DO NOTHING RETURNING id`, [String(code), o[0], o[1], o[2], k]);
      if (r.length) return r[0].id;
      const { rows: again } = await query(`SELECT id FROM gl_accounts WHERE system_key = $1`, [k]);
      if (again.length) return again[0].id;
    }
    throw httpError(500, 'Could not add the account ' + o[0]);
  }
  async function cardAccount(id) {
    await ready();
    const { rows } = await query(`SELECT a.id, a.code, a.name, a.qb_type, a.is_active, c.* FROM gl_accounts a LEFT JOIN cc_cards c ON c.account_id = a.id WHERE a.id = $1`, [parseInt(id, 10) || 0]);
    const a = rows[0];
    if (!a || a.qb_type !== 'CCARD' || !a.is_active) throw httpError(400, 'Choose a credit card');
    a.id = Number(a.id);
    return a;
  }
  // A bank or cash account to pay from (Banking's own rule).
  async function bankAcct(id) { return books.bankAccount(id); }
  async function holderId(cardId, v) {
    if (v == null || v === '') return null;
    const { rows } = await query(`SELECT id FROM cc_holders WHERE id = $1 AND account_id = $2`, [parseInt(v, 10) || 0, cardId]);
    if (!rows.length) throw httpError(400, 'That cardholder is not on this card');
    return rows[0].id;
  }

  // ------------------------------------------------------------ dates --
  const pad = (x) => String(x).padStart(2, '0');
  function dayIn(y, m, d) { const last = new Date(Date.UTC(y, m, 0)).getUTCDate(); return y + '-' + pad(m) + '-' + pad(Math.min(d, last)); }
  // The next date on or after `from` that falls on day-of-month d.
  function nextOnDay(d, from) {
    if (!d) return null;
    const [y, m] = from.split('-').map(Number);
    const here = dayIn(y, m, d);
    if (here >= from) return here;
    return m === 12 ? dayIn(y + 1, 1, d) : dayIn(y, m + 1, d);
  }
  const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

  // ------------------------------------------------------------ per-card figures --
  // Ledger balance (owed = minus the debit balance), the latest statement and what has been paid since it.
  async function cardFigures(card, asOf) {
    const t = asOf || today();
    const { rows: [b] } = await query(
      `SELECT COALESCE(-SUM(l.amount), 0)::float AS owed,
              COALESCE(-SUM(l.amount) FILTER (WHERE bc.gl_line_id IS NOT NULL AND br.status = 'done'), 0)::float AS reconciled,
              COUNT(*) FILTER (WHERE bc.gl_line_id IS NULL)::int AS uncleared
         FROM gl_lines l JOIN gl_entries e ON e.id = l.entry_id LEFT JOIN bank_cleared bc ON bc.gl_line_id = l.id LEFT JOIN bank_recons br ON br.id = bc.recon_id
        WHERE l.account_id = $1`, [card.id]);
    const { rows: [pend] } = await query(
      `SELECT COALESCE(SUM(CASE WHEN m.kind IN ('refund','reward') OR (t.account_id <> $1) THEN -t.amount ELSE t.amount END), 0)::float AS v
         FROM bank_txns t LEFT JOIN cc_txn_meta m ON m.bank_txn_id = t.id
        WHERE t.voided_at IS NULL AND (t.account_id = $1 OR m.card_id = $1) AND m.kind IS DISTINCT FROM 'reward_cash'
          AND NOT EXISTS (SELECT 1 FROM gl_entries g WHERE g.source_kind = 'bank_txn' AND g.source_id = t.id)`, [card.id]);
    const owed = r2(b.owed + pend.v);   // + anything saved but not posted yet (ledger not started, or posting behind)
    const { rows: st } = await query(
      `SELECT id, to_char(closing_date, 'YYYY-MM-DD') AS closing_date, to_char(due_date, 'YYYY-MM-DD') AS due_date, new_balance::float AS new_balance, minimum_due::float AS minimum_due, status
         FROM cc_statements WHERE account_id = $1 ORDER BY closing_date DESC LIMIT 1`, [card.id]);
    const last = st[0] || null;
    let paidSince = 0;
    if (last) {
      const { rows: [p] } = await query(
        `SELECT COALESCE(SUM(l.amount) FILTER (WHERE l.amount > 0), 0)::float AS v FROM gl_lines l JOIN gl_entries e ON e.id = l.entry_id
          WHERE l.account_id = $1 AND e.entry_date > $2::date AND e.reversed_by IS NULL AND e.reverses_id IS NULL`, [card.id, last.closing_date]);
      const { rows: [q] } = await query(
        `SELECT COALESCE(SUM(t.amount), 0)::float AS v FROM bank_txns t JOIN cc_txn_meta m ON m.bank_txn_id = t.id
          WHERE m.card_id = $1 AND m.kind IN ('payment','refund','reward') AND t.voided_at IS NULL AND t.txn_date > $2::date
            AND NOT EXISTS (SELECT 1 FROM gl_entries g WHERE g.source_kind = 'bank_txn' AND g.source_id = t.id)`, [card.id, last.closing_date]);
      paidSince = r2(p.v + q.v);
    }
    const limit = card.credit_limit == null ? null : n(card.credit_limit);
    const out = {
      owed, reconciled: r2(b.reconciled), uncleared: b.uncleared,
      available: limit == null ? null : r2(limit - owed), utilization: limit ? Math.round((owed / limit) * 1000) / 10 : null,
      next_statement: nextOnDay(card.statement_day, t), next_due: last && last.due_date && last.due_date >= t ? last.due_date : nextOnDay(card.due_day, t),
      last_statement: last, paid_since_statement: paidSince,
    };
    if (last) {
      const left = r2(Math.max(0, last.new_balance - paidSince)), minLeft = r2(Math.max(0, n(last.minimum_due) - paidSince));
      out.statement_left = left; out.minimum_left = minLeft;
      out.pay_status = last.new_balance <= 0.005 || left <= 0.005 ? 'paid' : minLeft <= 0.005 ? 'minimum_paid' : last.due_date && last.due_date < t ? 'overdue' : 'due';
      out.days_to_due = last.due_date ? daysBetween(t, last.due_date) : null;
    }
    return out;
  }

  // Points earned from spending (rewards_mode = calculate): charges entered here
  // per line (with the account's multiplier), less refunds; supplier bills and
  // purchase orders paid by card at the card's own rate.
  async function rewardsFor(card, upTo) {
    const rate = n(card.earn_rate) / 100;   // earn_rate is per J$100 spent
    const start = card.rewards_start ? (card.rewards_start instanceof Date ? card.rewards_start.toISOString().slice(0, 10) : String(card.rewards_start).slice(0, 10)) : '1900-01-01';
    const end = upTo || '2999-12-31';
    let calc = 0, spend = 0;
    if (card.rewards_kind && card.rewards_kind !== 'none' && card.rewards_mode !== 'statement' && rate > 0) {
      const { rows: [a] } = await query(
        `SELECT COALESCE(SUM(CASE WHEN m.kind = 'refund' THEN -1 ELSE 1 END * l.amount * COALESCE(rr.multiplier, 1)), 0)::float AS pts,
                COALESCE(SUM(CASE WHEN m.kind = 'refund' THEN -1 ELSE 1 END * l.amount), 0)::float AS spend
           FROM bank_txns t JOIN cc_txn_meta m ON m.bank_txn_id = t.id JOIN bank_txn_lines l ON l.txn_id = t.id
           LEFT JOIN cc_reward_rules rr ON rr.account_id = t.account_id AND rr.gl_account_id = l.account_id
          WHERE t.account_id = $1 AND t.voided_at IS NULL AND m.kind IN ('purchase','refund','moved') AND t.txn_date BETWEEN $2::date AND $3::date`, [card.id, start, end]);
      const { rows: [o] } = await query(
        `SELECT COALESCE(-SUM(l.amount), 0)::float AS spend FROM gl_lines l JOIN gl_entries e ON e.id = l.entry_id
          WHERE l.account_id = $1 AND e.source_kind IN ('ap_payment','po_payment') AND e.reversed_by IS NULL AND e.reverses_id IS NULL AND e.entry_date BETWEEN $2::date AND $3::date`, [card.id, start, end]);
      calc = r2(a.pts * rate + o.spend * rate); spend = r2(a.spend + o.spend);
    }
    const { rows: ev } = await query(
      `SELECT kind, COALESCE(SUM(points), 0)::float AS points, COALESCE(SUM(value), 0)::float AS value FROM cc_reward_events
        WHERE account_id = $1 AND voided_at IS NULL AND event_date <= $2::date GROUP BY kind`, [card.id, end]);
    const k = (x) => (ev.find((e) => e.kind === x) || { points: 0, value: 0 });
    const earned = r2(calc + k('earned').points + k('bonus').points), redeemed = r2(k('redeemed').points), expired = r2(k('expired').points), adjust = r2(k('adjust').points);
    const balance = r2(earned - redeemed - expired + adjust);
    return { kind: card.rewards_kind || 'none', name: card.rewards_name || null, mode: card.rewards_mode || 'calculate', earn_rate: n(card.earn_rate), point_value: n(card.point_value),
      calculated: calc, spend, earned, redeemed, redeemed_value: r2(k('redeemed').value), expired, adjust, balance, value: r2(balance * n(card.point_value)) };
  }

  // The ledger memo is "Payment · payee · memo" (gl.js bank_txn poster): show just the memo part.
  function cleanMemo(memo, party) {
    let m = String(memo || '').replace(/^(Payment|Deposit|Transfer)( · |$)/, '');
    if (party && m.startsWith(party)) m = m.slice(party.length).replace(/^ · /, '');
    if (party && m === party) m = '';
    return m;
  }
  function cardOut(a) {
    const d = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v || null);
    return { id: a.id, code: a.code, name: a.name, set_up: !!a.account_id, issuer: a.issuer || null, network: a.network || null, last4: a.last4 || null, holder_name: a.holder_name || null,
      credit_limit: a.credit_limit == null ? null : n(a.credit_limit), cash_limit: a.cash_limit == null ? null : n(a.cash_limit), apr: a.apr == null ? null : n(a.apr), cash_apr: a.cash_apr == null ? null : n(a.cash_apr),
      statement_day: a.statement_day || null, due_day: a.due_day || null, min_pct: a.min_pct == null ? null : n(a.min_pct), min_floor: a.min_floor == null ? null : n(a.min_floor),
      annual_fee: a.annual_fee == null ? null : n(a.annual_fee), fee_month: a.fee_month || null, pay_from_account_id: a.pay_from_account_id || null, autopay: a.autopay || 'none',
      rewards_kind: a.rewards_kind || 'none', rewards_name: a.rewards_name || null, earn_rate: n(a.earn_rate), point_value: n(a.point_value), rewards_mode: a.rewards_mode || 'calculate', rewards_start: d(a.rewards_start),
      expires: a.expires || null, status: a.status || 'active', notes: a.notes || null };
  }
  async function allCards() {
    await ready();
    const { rows } = await query(`SELECT a.id, a.code, a.name, a.qb_type, a.is_active, c.* FROM gl_accounts a LEFT JOIN cc_cards c ON c.account_id = a.id WHERE a.qb_type = 'CCARD' AND a.is_active ORDER BY COALESCE(c.status, 'active') = 'closed', a.code`);
    return rows.map((a) => Object.assign(a, { id: Number(a.id) }));
  }

  // ============================================================ cards ==
  // Small list for pickers in other modules (Payables, purchase orders): any staff who can reach those screens.
  app.get('/api/cards/pick', requireAdmin, async (req, res) => {
    try { res.json({ cards: (await allCards()).filter((a) => (a.status || 'active') !== 'closed').map((a) => ({ id: a.id, code: a.code, name: a.name, last4: a.last4 || null })) }); } catch (e) { fail(res, e); }
  });
  app.get('/api/cards', ...CC, async (req, res) => {
    try {
      const cards = await allCards(), t = today(), out = [], alerts = [];
      for (const a of cards) {
        const c = cardOut(a), f = await cardFigures(a, t), rw = await rewardsFor(a);
        const { rows: [fd] } = await query(`SELECT COUNT(*)::int AS v FROM bank_feed_lines WHERE account_id = $1 AND status = 'new'`, [a.id]);
        const { rows: hs } = await query(
          `SELECT h.id, h.name, h.last4, h.monthly_limit::float AS monthly_limit, h.is_active,
                  COALESCE((SELECT SUM(t.amount) FROM bank_txns t JOIN cc_txn_meta m ON m.bank_txn_id = t.id WHERE m.holder_id = h.id AND t.voided_at IS NULL AND m.kind IN ('purchase','cash_advance')
                              AND date_trunc('month', t.txn_date) = date_trunc('month', $2::date)), 0)::float AS month_spend
             FROM cc_holders h WHERE h.account_id = $1 ORDER BY h.is_active DESC, h.name`, [a.id, t]);
        const label = a.name + (a.last4 ? ' ••' + a.last4 : '');
        if (!a.account_id) alerts.push({ level: 'info', card: a.id, text: label + ': fill in the card details (limit, statement and due days) in Setup.' });
        if (f.pay_status === 'overdue') alerts.push({ level: 'bad', card: a.id, text: label + ': the payment was due ' + f.last_statement.due_date + '; ' + money(f.minimum_left) + ' of the minimum is still unpaid.' });
        else if (f.pay_status === 'due' && f.days_to_due != null && f.days_to_due <= 7) alerts.push({ level: 'warn', card: a.id, text: label + ': ' + money(f.statement_left) + ' due ' + f.last_statement.due_date + ' (' + (f.days_to_due === 0 ? 'today' : 'in ' + f.days_to_due + ' day' + (f.days_to_due === 1 ? '' : 's')) + '); minimum ' + money(f.minimum_left) + '.' });
        if (f.utilization != null && f.utilization >= 100) alerts.push({ level: 'bad', card: a.id, text: label + ': over the limit (' + f.utilization + '% used).' });
        else if (f.utilization != null && f.utilization >= 80) alerts.push({ level: 'warn', card: a.id, text: label + ': ' + f.utilization + '% of the limit used.' });
        if (a.statement_day && f.last_statement) {
          const nextClose = nextOnDay(a.statement_day, new Date(Date.parse(f.last_statement.closing_date) + 86400000).toISOString().slice(0, 10));
          if (nextClose && daysBetween(nextClose, t) > 5) alerts.push({ level: 'warn', card: a.id, text: label + ': the statement that closed about ' + nextClose + ' has not been entered yet.' });
        }
        if (f.last_statement && f.last_statement.status !== 'reconciled' && daysBetween(f.last_statement.closing_date, t) > 10) alerts.push({ level: 'info', card: a.id, text: label + ': the ' + f.last_statement.closing_date + ' statement is not reconciled yet.' });
        if (fd.v) alerts.push({ level: 'info', card: a.id, text: label + ': ' + fd.v + ' statement line' + (fd.v === 1 ? '' : 's') + ' to review.' });
        for (const h of hs) if (h.is_active && h.monthly_limit && h.month_spend > h.monthly_limit) alerts.push({ level: 'warn', card: a.id, text: h.name + ' has spent ' + money(h.month_spend) + ' on ' + label + ' this month (limit ' + money(h.monthly_limit) + ').' });
        out.push(Object.assign(c, f, { rewards: rw, to_review: fd.v, holders: hs }));
      }
      // Card payments made elsewhere that did not go to a card account.
      const off = await offCard();
      if (off.length) alerts.push({ level: 'warn', text: off.length + ' payment' + (off.length === 1 ? '' : 's') + ' marked "card" in other modules went to a bank or clearing account, not a credit card: see Cards › "Paid by card elsewhere".' });
      const { rows: st } = await query(`SELECT value FROM warehouse_settings WHERE key = 'gl_start_at'`);
      const tot = out.reduce((s, c) => ({ owed: s.owed + c.owed, limit: s.limit + (c.credit_limit || 0), rewards: s.rewards + c.rewards.value }), { owed: 0, limit: 0, rewards: 0 });
      res.json({ cards: out, alerts, off_card: off.length, ledger_started: !!(st.length && st[0].value),
        totals: { owed: r2(tot.owed), limit: r2(tot.limit), available: r2(tot.limit - tot.owed), utilization: tot.limit ? Math.round((tot.owed / tot.limit) * 1000) / 10 : null, rewards_value: r2(tot.rewards) } });
    } catch (e) { fail(res, e); }
  });
  // CCARD ledger accounts not yet set up (e.g. brought over from QuickBooks) can be set up instead of adding a new one.
  app.post('/api/cards', ...CC, async (req, res) => {
    try {
      await ready();
      const b = req.body || {};
      const name = str(b.name, 80), code = str(b.code, 10);
      if (!name || !/^\d{4,6}$/.test(code || '')) throw httpError(400, 'Name, and a 4 to 6 digit ledger account number (e.g. 2410)');
      const id = await tx(async (c) => {
        const { rows } = await c.query(`INSERT INTO gl_accounts (code, name, type, qb_name, qb_type) VALUES ($1,$2,'liability',$2,'CCARD') RETURNING id`, [code, name]);
        await c.query(`INSERT INTO cc_cards (account_id, created_by) VALUES ($1,$2)`, [rows[0].id, req.session.userId]);
        return rows[0].id;
      });
      await saveCard(id, b);
      res.json({ ok: true, id });
    } catch (e) { if (e.code === '23505') e = httpError(409, 'That account number is taken'); fail(res, e); }
  });
  async function saveCard(id, b) {
    const intDay = (v) => { const x = parseInt(v, 10); return x >= 1 && x <= 31 ? x : null; };
    const pf = b.pay_from_account_id ? (await bankAcct(b.pay_from_account_id)).id : null;
    const rk = ['none', 'points', 'cashback', 'miles'].includes(b.rewards_kind) ? b.rewards_kind : 'none';
    const last4 = String(b.last4 || '').replace(/\D/g, '').slice(-4) || null;
    await query(
      `INSERT INTO cc_cards (account_id) VALUES ($1) ON CONFLICT (account_id) DO NOTHING`, [id]);
    await query(
      `UPDATE cc_cards SET issuer = $2, network = $3, last4 = $4, holder_name = $5, credit_limit = $6, cash_limit = $7, apr = $8, cash_apr = $9, statement_day = $10, due_day = $11,
              min_pct = $12, min_floor = $13, annual_fee = $14, fee_month = $15, pay_from_account_id = $16, autopay = $17, rewards_kind = $18, rewards_name = $19, earn_rate = $20,
              point_value = $21, rewards_mode = $22, rewards_start = $23, expires = $24, status = $25, notes = $26, updated_at = NOW() WHERE account_id = $1`,
      [id, str(b.issuer, 60), str(b.network, 30), last4, str(b.holder_name, 80), numOrNull(b.credit_limit), numOrNull(b.cash_limit), numOrNull(b.apr), numOrNull(b.cash_apr), intDay(b.statement_day), intDay(b.due_day),
       numOrNull(b.min_pct) == null ? 5 : numOrNull(b.min_pct), numOrNull(b.min_floor) || 0, numOrNull(b.annual_fee), (parseInt(b.fee_month, 10) >= 1 && parseInt(b.fee_month, 10) <= 12) ? parseInt(b.fee_month, 10) : null,
       pf, ['none', 'minimum', 'statement', 'full'].includes(b.autopay) ? b.autopay : 'none', rk, str(b.rewards_name, 60), rk === 'none' ? 0 : n(b.earn_rate), rk === 'cashback' ? 1 : n(b.point_value),
       b.rewards_mode === 'statement' ? 'statement' : 'calculate', isDate(b.rewards_start) ? b.rewards_start : null, str(b.expires, 7), ['active', 'frozen', 'closed'].includes(b.status) ? b.status : 'active', str(b.notes, 1000)]);
  }
  app.get('/api/cards/:id(\\d+)', ...CC, async (req, res) => {
    try {
      const a = await cardAccount(req.params.id);
      const { rows: holders } = await query(`SELECT h.*, h.monthly_limit::float AS monthly_limit, u.name AS user_name FROM cc_holders h LEFT JOIN users u ON u.id = h.user_id WHERE h.account_id = $1 ORDER BY h.is_active DESC, h.name`, [a.id]);
      const { rows: rules } = await query(`SELECT r.id, r.gl_account_id, r.multiplier::float AS multiplier, g.code, g.name FROM cc_reward_rules r JOIN gl_accounts g ON g.id = r.gl_account_id WHERE r.account_id = $1 ORDER BY g.code`, [a.id]);
      res.json({ card: cardOut(a), figures: await cardFigures(a), rewards: await rewardsFor(a), holders, rules });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/cards/:id(\\d+)', ...CC, async (req, res) => {
    try {
      const a = await cardAccount(req.params.id), b = req.body || {};
      if (b.name && str(b.name, 80) !== a.name) await query(`UPDATE gl_accounts SET name = $2 WHERE id = $1`, [a.id, str(b.name, 80)]);
      await saveCard(a.id, b);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/cards/:id(\\d+)/holders', ...CC, async (req, res) => {
    try {
      const a = await cardAccount(req.params.id), b = req.body || {};
      const name = str(b.name, 80);
      if (!name) throw httpError(400, 'The cardholder\'s name');
      const uid = parseInt(b.user_id, 10) || null;
      const vals = [name, String(b.last4 || '').replace(/\D/g, '').slice(-4) || null, uid, numOrNull(b.monthly_limit), b.is_active !== false];
      if (b.id) {
        const { rowCount } = await query(`UPDATE cc_holders SET name = $3, last4 = $4, user_id = $5, monthly_limit = $6, is_active = $7 WHERE id = $1 AND account_id = $2`, [parseInt(b.id, 10), a.id, ...vals]);
        if (!rowCount) throw httpError(404, 'Not found');
      } else await query(`INSERT INTO cc_holders (account_id, name, last4, user_id, monthly_limit, is_active) VALUES ($1,$2,$3,$4,$5,$6)`, [a.id, ...vals]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/cards/:id(\\d+)/reward-rules', ...CC, async (req, res) => {
    try {
      const a = await cardAccount(req.params.id), list = Array.isArray((req.body || {}).rules) ? req.body.rules : [];
      await tx(async (c) => {
        await c.query(`DELETE FROM cc_reward_rules WHERE account_id = $1`, [a.id]);
        for (const r of list) {
          const g = parseInt(r.gl_account_id, 10), m = n(r.multiplier);
          if (!g || !(m >= 0) || m > 100) continue;
          await c.query(`INSERT INTO cc_reward_rules (account_id, gl_account_id, multiplier) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [a.id, g, m]);
        }
      });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/cards/staff', ...CC, async (req, res) => {
    try { const { rows } = await query(`SELECT id, name FROM users WHERE (is_staff OR is_admin) AND COALESCE(name, '') <> '' ORDER BY name LIMIT 500`); res.json({ staff: rows }); } catch (e) { fail(res, e); }
  });

  // ============================================================ register ==
  // Kind of a card line: from cc_txn_meta for the card's own transactions, else from the module that made it.
  const KIND_SQL = `CASE WHEN m.kind IS NOT NULL THEN m.kind
                         WHEN e.source_kind IN ('ap_payment', 'ap_payment_void') THEN 'bill'
                         WHEN e.source_kind = 'po_payment' THEN 'po'
                         WHEN e.source_kind = 'manual' THEN 'journal'
                         WHEN e.source_kind = 'bank_txn' AND l.amount > 0 THEN 'payment'
                         WHEN l.amount < 0 THEN 'purchase' ELSE 'other' END`;
  const LINE_FROM = `FROM gl_lines l JOIN gl_entries e ON e.id = l.entry_id
           LEFT JOIN cc_txn_meta m ON e.source_kind IN ('bank_txn', 'bank_txn_void') AND m.bank_txn_id = e.source_id
           LEFT JOIN cc_holders h ON h.id = m.holder_id`;
  app.get('/api/cards/:id(\\d+)/register', ...CC, async (req, res) => {
    try {
      const a = await cardAccount(req.params.id);
      const from = isDate(req.query.from) ? req.query.from : null, to = isDate(req.query.to) ? req.query.to : null;
      const qs = String(req.query.q || '').trim().slice(0, 60), kind = String(req.query.kind || ''), holder = parseInt(req.query.holder, 10) || null;
      const filtered = !!(qs || kind || holder);
      const { rows: before } = await query(`SELECT COALESCE(-SUM(l.amount), 0)::float AS v FROM gl_lines l JOIN gl_entries e ON e.id = l.entry_id WHERE l.account_id = $1 AND $2::date IS NOT NULL AND e.entry_date < $2::date`, [a.id, from]);
      const { rows } = await query(
        `SELECT l.id::int AS id, to_char(e.entry_date, 'YYYY-MM-DD') AS day, e.number, e.source_kind, e.source_id::int AS source_id, e.source_ref AS ref, e.memo, l.party, l.memo AS line_memo, (-l.amount)::float AS amount,
                (e.reversed_by IS NOT NULL OR e.reverses_id IS NOT NULL) AS voided, ${KIND_SQL} AS kind, h.name AS holder, (m.receipt_name IS NOT NULL) AS has_receipt,
                CASE WHEN bc.gl_line_id IS NULL THEN '' WHEN br.status = 'done' THEN 'R' ELSE 'C' END AS cleared,
                (SELECT string_agg(DISTINCT ga.name, ', ') FROM gl_lines o JOIN gl_accounts ga ON ga.id = o.account_id WHERE o.entry_id = e.id AND o.id <> l.id) AS category
           ${LINE_FROM} LEFT JOIN bank_cleared bc ON bc.gl_line_id = l.id LEFT JOIN bank_recons br ON br.id = bc.recon_id
          WHERE l.account_id = $1 AND ($2::date IS NULL OR e.entry_date >= $2::date) AND ($3::date IS NULL OR e.entry_date <= $3::date)
          ORDER BY e.entry_date, e.id, l.id`, [a.id, from, to]);
      let bal = before[0].v;
      for (const r of rows) { r.memo = cleanMemo(r.memo, r.party); if (/^(Payment|Deposit|Transfer) \d+$/.test(r.ref || '')) r.ref = null; bal = r2(bal + r.amount); r.balance = bal; r.kind_label = KINDS[r.kind] || r.kind; r.from = SOURCES[r.source_kind] || r.source_kind; }
      let list = rows;
      if (filtered) {
        const ql = qs.toLowerCase();
        const hn = holder ? ((await query(`SELECT name FROM cc_holders WHERE id = $1`, [holder])).rows[0] || {}).name : null;
        list = rows.filter((r) => (!kind || r.kind === kind) && (!holder || r.holder === hn) && (!qs || [r.memo, r.party, r.ref, r.number, r.category, r.holder, String(Math.abs(r.amount))].some((x) => String(x || '').toLowerCase().includes(ql))));
        for (const r of list) r.balance = null;
      }
      // Saved here but not in the ledger yet (ledger not started, or the poster has not run).
      const { rows: pending } = await query(
        `SELECT t.id, to_char(t.txn_date, 'YYYY-MM-DD') AS day, t.payee, t.memo, t.amount::float AS amount, t.account_id, COALESCE(m.kind, 'payment') AS kind
           FROM bank_txns t LEFT JOIN cc_txn_meta m ON m.bank_txn_id = t.id
          WHERE t.voided_at IS NULL AND (t.account_id = $1 OR m.card_id = $1) AND m.kind IS DISTINCT FROM 'reward_cash' AND NOT EXISTS (SELECT 1 FROM gl_entries g WHERE g.source_kind = 'bank_txn' AND g.source_id = t.id) ORDER BY t.txn_date, t.id`, [a.id]);
      res.json({ account: cardOut(a), opening: filtered ? null : r2(before[0].v), lines: list.slice(-1000).reverse(), more: list.length > 1000, pending });
    } catch (e) { fail(res, e); }
  });

  // ============================================================ charges ==
  // kind: purchase | refund | fee | interest | cash_advance
  app.post('/api/cards/:id(\\d+)/txns', ...CC, maybeFile('receipt'), async (req, res) => {
    try {
      const a = await cardAccount(req.params.id), b = req.body || {};
      if ((a.status || 'active') === 'closed') throw httpError(400, 'This card is closed');
      const kind = ['purchase', 'refund', 'fee', 'interest', 'cash_advance'].includes(b.kind) ? b.kind : null;
      if (!kind) throw httpError(400, 'Purchase, refund, fee, interest or cash advance?');
      const date = isDate(b.txn_date) ? b.txn_date : today();
      let raw = b.lines; if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch (_) { raw = []; } }
      let lines = (Array.isArray(raw) ? raw : []).map((l) => ({ account_id: parseInt(l.account_id, 10), amount: r2(l.amount), memo: str(l.memo, 200), class_id: l.class_id, asset_id: l.asset_id })).filter((l) => l.amount > 0);
      if (kind === 'fee' || kind === 'interest') lines = [{ account_id: await acctByKey('cc_charges'), amount: r2(b.amount != null && b.amount !== '' ? b.amount : lines.reduce((t, l) => t + l.amount, 0)), memo: str(b.memo, 200) || (kind === 'fee' ? 'Card fee' : 'Card interest') }].filter((l) => l.amount > 0);
      if (kind === 'cash_advance') { const to = await bankAcct(b.to_account_id); lines = [{ account_id: to.id, amount: r2(b.amount), memo: 'Cash advance from ' + a.name }].filter((l) => l.amount > 0); }
      if (!lines.length) throw httpError(400, 'Add at least one line with an account and amount');
      for (const l of lines) {
        const la = await books.lineAccount(l.account_id);
        if (la.id === a.id) throw httpError(400, 'A line cannot use the card itself');
        l.class_id = await books.classId(l.class_id); l.asset_id = await books.assetId(l.asset_id);
      }
      const hid = await holderId(a.id, b.holder_id);
      const f = req.file || null;
      const out = await tx(async (c) => {
        const t = await books.makeTxn(c, { kind: kind === 'refund' ? 'deposit' : 'expense', accountId: a.id, date, payee: str(b.payee, 80), supplierId: parseInt(b.supplier_id, 10) || null, cheque: null,
          reference: str(b.reference, 60), memo: str(b.memo, 300), lines, userId: req.session.userId });
        await c.query(`INSERT INTO cc_txn_meta (bank_txn_id, card_id, kind, holder_id, receipt_name, receipt_type, receipt) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [t.id, a.id, kind, hid, f ? String(f.originalname || 'receipt').slice(0, 120) : null, f ? String(f.mimetype || 'application/octet-stream').slice(0, 80) : null, f ? f.buffer : null]);
        return t;
      });
      await post();
      res.json(Object.assign({ ok: true }, out));
    } catch (e) { fail(res, e); }
  });
  app.get('/api/cards/txns/:id(\\d+)', ...CC, async (req, res) => {
    try {
      await ready();
      const { rows } = await query(
        `SELECT t.*, to_char(t.txn_date, 'YYYY-MM-DD') AS day, t.amount::float AS amount, a.name AS account, m.kind AS cc_kind, m.card_id, h.name AS holder, m.receipt_name, cg.name AS card
           FROM bank_txns t JOIN gl_accounts a ON a.id = t.account_id LEFT JOIN cc_txn_meta m ON m.bank_txn_id = t.id LEFT JOIN cc_holders h ON h.id = m.holder_id LEFT JOIN gl_accounts cg ON cg.id = m.card_id WHERE t.id = $1`, [parseInt(req.params.id, 10)]);
      if (!rows.length) throw httpError(404, 'Not found');
      const { rows: lines } = await query(`SELECT l.amount::float AS amount, l.memo, a.code, a.name AS account FROM bank_txn_lines l JOIN gl_accounts a ON a.id = l.account_id WHERE l.txn_id = $1 ORDER BY l.id`, [rows[0].id]);
      const t = rows[0]; delete t.receipt;
      t.kind_label = KINDS[t.cc_kind] || ({ expense: 'Payment', deposit: 'Deposit', transfer: 'Transfer' }[t.kind]);
      res.json({ txn: t, lines });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/cards/txns/:id(\\d+)/receipt', ...CC, async (req, res) => {
    try {
      await ready();
      const { rows } = await query(`SELECT receipt, receipt_name, receipt_type FROM cc_txn_meta WHERE bank_txn_id = $1 AND receipt IS NOT NULL`, [parseInt(req.params.id, 10)]);
      if (!rows.length) throw httpError(404, 'No receipt');
      res.set('Content-Type', rows[0].receipt_type || 'application/octet-stream');
      res.set('Content-Disposition', 'inline; filename="' + String(rows[0].receipt_name || 'receipt').replace(/[^\w.\- ]/g, '_') + '"');
      res.send(rows[0].receipt);
    } catch (e) { fail(res, e); }
  });
  // Void a card transaction (charge, refund, payment, reward credit, move): a reversing entry, like Banking.
  app.post('/api/cards/txns/:id(\\d+)/void', ...CC, async (req, res) => {
    try {
      await ready();
      const reason = String((req.body || {}).reason || '').trim().slice(0, 200);
      if (reason.length < 3) throw httpError(400, 'Say why it is voided');
      const id = parseInt(req.params.id, 10);
      const { rows: m } = await query(`SELECT * FROM cc_txn_meta WHERE bank_txn_id = $1`, [id]);
      if (!m.length) throw httpError(404, 'That is not a credit card transaction');
      const { rows: cl } = await query(`SELECT 1 FROM bank_cleared bc JOIN gl_lines l ON l.id = bc.gl_line_id JOIN gl_entries e ON e.id = l.entry_id JOIN bank_recons r ON r.id = bc.recon_id WHERE e.source_kind = 'bank_txn' AND e.source_id = $1 AND r.status = 'done'`, [id]);
      if (cl.length) throw httpError(409, 'This is in a finished reconciliation; undo that reconciliation first');
      await tx(async (c) => {
        const { rowCount } = await c.query(`UPDATE bank_txns SET voided_at = NOW(), voided_by = $2, void_reason = $3 WHERE id = $1 AND voided_at IS NULL`, [id, req.session.userId, reason]);
        if (!rowCount) throw httpError(409, 'Not found or already voided');
        await c.query(`UPDATE bank_feed_lines SET status = 'new', bank_txn_id = NULL, gl_line_id = NULL WHERE bank_txn_id = $1`, [id]);
        await c.query(`UPDATE cc_reward_events SET voided_at = NOW() WHERE bank_txn_id = $1 AND voided_at IS NULL`, [id]);
      });
      await post();
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ============================================================ pay the card ==
  app.post('/api/cards/:id(\\d+)/pay', ...CC, async (req, res) => {
    try {
      const a = await cardAccount(req.params.id), b = req.body || {};
      const from = await bankAcct(b.from_account_id);
      const amount = r2(b.amount);
      if (!(amount > 0)) throw httpError(400, 'Enter the amount paid');
      const date = isDate(b.pay_date) ? b.pay_date : today();
      const sid = parseInt(b.statement_id, 10) || null;
      if (sid) { const { rows } = await query(`SELECT 1 FROM cc_statements WHERE id = $1 AND account_id = $2`, [sid, a.id]); if (!rows.length) throw httpError(400, 'That statement is not this card\'s'); }
      const out = await tx(async (c) => {
        const t = await books.makeTxn(c, { kind: 'expense', accountId: from.id, date, payee: a.issuer || a.name, supplierId: null, cheque: str(b.cheque_number, 30), reference: str(b.reference, 60),
          memo: str(b.memo, 300) || ('Payment to ' + a.name + (a.last4 ? ' ••' + a.last4 : '')), lines: [{ account_id: a.id, amount, memo: 'Card payment' }], userId: req.session.userId });
        await c.query(`INSERT INTO cc_txn_meta (bank_txn_id, card_id, kind, statement_id) VALUES ($1,$2,'payment',$3)`, [t.id, a.id, sid]);
        return t;
      });
      await post();
      res.json(Object.assign({ ok: true }, out));
    } catch (e) { fail(res, e); }
  });

  // ============================================================ paid by card elsewhere ==
  // Supplier bill payments and purchase-order payments marked "card" that were booked to a bank / clearing account.
  async function offCard() {
    await ready();
    const { rows } = await query(
      `SELECT 'ap_payment' AS source_kind, p.id, to_char(p.pay_date, 'YYYY-MM-DD') AS day, s.name AS party, p.amount::float AS amount, ga.name AS booked_to, p.reference,
              (SELECT l.id::int FROM gl_lines l JOIN gl_entries e ON e.id = l.entry_id WHERE e.source_kind = 'ap_payment' AND e.source_id = p.id AND l.account_id = p.account_id LIMIT 1) AS gl_line_id
         FROM ap_payments p JOIN suppliers s ON s.id = p.supplier_id JOIN gl_accounts ga ON ga.id = p.account_id
        WHERE p.method = 'card' AND p.voided_at IS NULL AND ga.qb_type <> 'CCARD'
       UNION ALL
       SELECT 'po_payment', p.id, to_char(COALESCE(p.paid_on, p.created_at::date), 'YYYY-MM-DD'), COALESCE(s.name, po.po_number), p.amount_usd::float, NULL, COALESCE(p.reference, po.po_number),
              (SELECT l.id::int FROM gl_lines l JOIN gl_entries e ON e.id = l.entry_id JOIN gl_accounts x ON x.id = l.account_id WHERE e.source_kind = 'po_payment' AND e.source_id = p.id AND l.amount < 0 AND x.system_key IS DISTINCT FROM 'ap' LIMIT 1)
         FROM purchase_order_payments p JOIN purchase_orders po ON po.id = p.po_id LEFT JOIN suppliers s ON s.id = po.supplier_id
        WHERE lower(COALESCE(p.method, '')) = 'card' AND p.card_account_id IS NULL
        ORDER BY 3 DESC LIMIT 300`);
    const lineIds = rows.map((r) => r.gl_line_id).filter(Boolean);
    const moved = lineIds.length ? (await query(`SELECT m.moved_line_id::int AS id FROM cc_txn_meta m JOIN bank_txns t ON t.id = m.bank_txn_id WHERE t.voided_at IS NULL AND m.moved_line_id = ANY($1)`, [lineIds])).rows.map((x) => x.id) : [];
    const out = rows.filter((r) => !moved.includes(r.gl_line_id));
    if (out.some((r) => r.gl_line_id)) {
      const { rows: ac } = await query(`SELECT l.id::int AS id, a.id AS account_id, a.name FROM gl_lines l JOIN gl_accounts a ON a.id = l.account_id WHERE l.id = ANY($1)`, [out.map((r) => r.gl_line_id).filter(Boolean)]);
      for (const r of out) { const x = ac.find((y) => y.id === r.gl_line_id); if (x) { r.booked_to = x.name; r.booked_account_id = x.account_id; } }
    }
    return out;
  }
  app.get('/api/cards/off-card', ...CC, async (req, res) => { try { res.json({ items: await offCard() }); } catch (e) { fail(res, e); } });
  // Move one of those onto a card: Dr the account it was booked to (puts the money back), Cr the card.
  app.post('/api/cards/:id(\\d+)/move-in', ...CC, async (req, res) => {
    try {
      const a = await cardAccount(req.params.id), b = req.body || {};
      const items = await offCard();
      const it = items.find((x) => x.source_kind === b.source_kind && x.id === parseInt(b.id, 10));
      if (!it) throw httpError(409, 'Already moved, voided, or not paid by card');
      if (!it.gl_line_id || !it.booked_account_id) throw httpError(409, 'That payment is not in the ledger yet; wait for it to post (or start the ledger)');
      const hid = await holderId(a.id, b.holder_id);
      const out = await tx(async (c) => {
        const t = await books.makeTxn(c, { kind: 'expense', accountId: a.id, date: it.day, payee: (it.party || '').slice(0, 80) || null, supplierId: null, cheque: null, reference: (it.reference || '').slice(0, 60) || null,
          memo: 'Paid by card: ' + (it.source_kind === 'ap_payment' ? 'supplier bill payment ' : 'purchase order payment ') + it.id + ' (was booked to ' + it.booked_to + ')', lines: [{ account_id: it.booked_account_id, amount: r2(it.amount), memo: 'Moved to ' + a.name }], userId: req.session.userId });
        await c.query(`INSERT INTO cc_txn_meta (bank_txn_id, card_id, kind, holder_id, moved_line_id) VALUES ($1,$2,'moved',$3,$4)`, [t.id, a.id, hid, it.gl_line_id]);
        return t;
      });
      await post();
      res.json(Object.assign({ ok: true }, out));
    } catch (e) { fail(res, e); }
  });

  // ============================================================ statements ==
  const STMT_COLS = `s.id, s.account_id, to_char(s.period_start, 'YYYY-MM-DD') AS period_start, to_char(s.closing_date, 'YYYY-MM-DD') AS closing_date, to_char(s.due_date, 'YYYY-MM-DD') AS due_date,
      s.previous_balance::float AS previous_balance, s.payments_credits::float AS payments_credits, s.purchases::float AS purchases, s.cash_advances::float AS cash_advances, s.fees::float AS fees, s.interest::float AS interest,
      s.new_balance::float AS new_balance, s.minimum_due::float AS minimum_due, s.credit_limit::float AS credit_limit, s.points_earned::float AS points_earned, s.points_redeemed::float AS points_redeemed, s.points_balance::float AS points_balance,
      s.file_name, s.file_type, s.file_size, s.status, s.recon_id, s.notes, s.created_at`;
  async function statementList(cardId) {
    const { rows } = await query(`SELECT ${STMT_COLS} FROM cc_statements s WHERE s.account_id = $1 ORDER BY s.closing_date DESC`, [cardId]);
    // What was paid towards each one: credits to the card after it closed, up to the next statement's close.
    for (let i = 0; i < rows.length; i++) {
      const s = rows[i], nextClose = i > 0 ? rows[i - 1].closing_date : '2999-12-31';
      const { rows: [p] } = await query(
        `SELECT COALESCE(SUM(l.amount) FILTER (WHERE l.amount > 0), 0)::float AS v FROM gl_lines l JOIN gl_entries e ON e.id = l.entry_id
          WHERE l.account_id = $1 AND e.entry_date > $2::date AND e.entry_date <= $3::date AND e.reversed_by IS NULL AND e.reverses_id IS NULL`, [cardId, s.closing_date, nextClose]);
      s.paid = r2(p.v);
      const t = today();
      s.pay_status = s.new_balance <= 0.005 || s.paid >= s.new_balance - 0.005 ? 'paid' : s.paid >= n(s.minimum_due) - 0.005 ? 'minimum_paid' : s.due_date && s.due_date < t ? 'overdue' : 'due';
      s.has_file = !!s.file_name;
    }
    return rows;
  }
  app.get('/api/cards/:id(\\d+)/statements', ...CC, async (req, res) => {
    try { const a = await cardAccount(req.params.id); res.json({ card: cardOut(a), statements: await statementList(a.id) }); } catch (e) { fail(res, e); }
  });
  // Add or update a statement: the summary figures and (optionally) the file. A CSV file's lines also go to the statement lines to review.
  app.post('/api/cards/:id(\\d+)/statements', ...CC, maybeFile('file'), async (req, res) => {
    try {
      const a = await cardAccount(req.params.id), b = req.body || {};
      if (!isDate(b.closing_date)) throw httpError(400, 'The statement closing date');
      if (b.new_balance === '' || b.new_balance == null || isNaN(Number(b.new_balance))) throw httpError(400, 'The new balance on the statement');
      const f = req.file || null;
      const vals = [isDate(b.period_start) ? b.period_start : null, b.closing_date, isDate(b.due_date) ? b.due_date : null, numOrNull(b.previous_balance), numOrNull(b.payments_credits), numOrNull(b.purchases), numOrNull(b.cash_advances),
        numOrNull(b.fees), numOrNull(b.interest), r2(b.new_balance), numOrNull(b.minimum_due), numOrNull(b.credit_limit), numOrNull(b.points_earned), numOrNull(b.points_redeemed), numOrNull(b.points_balance), str(b.notes, 1000)];
      const id = await tx(async (c) => {
        let sid = parseInt(b.id, 10) || null;
        if (sid) {
          const { rows } = await c.query(`SELECT status FROM cc_statements WHERE id = $1 AND account_id = $2`, [sid, a.id]);
          if (!rows.length) throw httpError(404, 'Not found');
          if (rows[0].status === 'reconciled' && b.closing_date) {
            const { rows: same } = await c.query(`SELECT 1 FROM cc_statements WHERE id = $1 AND closing_date = $2 AND new_balance = $3`, [sid, b.closing_date, r2(b.new_balance)]);
            if (!same.length) throw httpError(409, 'This statement is reconciled: undo the reconciliation before changing its date or balance');
          }
          await c.query(`UPDATE cc_statements SET period_start = $3, closing_date = $4, due_date = $5, previous_balance = $6, payments_credits = $7, purchases = $8, cash_advances = $9, fees = $10, interest = $11,
                           new_balance = $12, minimum_due = $13, credit_limit = $14, points_earned = $15, points_redeemed = $16, points_balance = $17, notes = $18 WHERE id = $1 AND account_id = $2`, [sid, a.id, ...vals]);
        } else {
          const { rows } = await c.query(`INSERT INTO cc_statements (account_id, period_start, closing_date, due_date, previous_balance, payments_credits, purchases, cash_advances, fees, interest, new_balance, minimum_due, credit_limit,
                                            points_earned, points_redeemed, points_balance, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`, [a.id, ...vals, req.session.userId]);
          sid = rows[0].id;
        }
        if (f) await c.query(`UPDATE cc_statements SET file = $2, file_name = $3, file_type = $4, file_size = $5 WHERE id = $1`, [sid, f.buffer, String(f.originalname || 'statement').slice(0, 120), String(f.mimetype || 'application/octet-stream').slice(0, 80), f.size]);
        // Points from the statement (cards set to "take points from the statements").
        await c.query(`DELETE FROM cc_reward_events WHERE statement_id = $1 AND kind = 'earned'`, [sid]);
        if (a.rewards_mode === 'statement' && numOrNull(b.points_earned)) await c.query(`INSERT INTO cc_reward_events (account_id, kind, event_date, points, statement_id, memo, created_by) VALUES ($1,'earned',$2,$3,$4,'From the statement',$5)`, [a.id, b.closing_date, r2(b.points_earned), sid, req.session.userId]);
        return sid;
      });
      let imported = null;
      if (f && (/csv|text/i.test(f.mimetype || '') || /\.csv$/i.test(f.originalname || ''))) {
        try { imported = await importCsv(a, f.buffer.toString('utf8'), { date_order: b.date_order, charges: b.charges, userId: req.session.userId, ref: 'statement ' + b.closing_date }); } catch (e) { imported = { error: e.publicMessage || e.message }; }
      }
      res.json({ ok: true, id, imported });
    } catch (e) { if (e.code === '23505') e = httpError(409, 'There is already a statement closing on that date for this card'); fail(res, e); }
  });
  app.get('/api/cards/statements/:sid(\\d+)/file', ...CC, async (req, res) => {
    try {
      await ready();
      const { rows } = await query(`SELECT file, file_name, file_type FROM cc_statements WHERE id = $1 AND file IS NOT NULL`, [parseInt(req.params.sid, 10)]);
      if (!rows.length) throw httpError(404, 'No file');
      res.set('Content-Type', rows[0].file_type || 'application/octet-stream');
      res.set('Content-Disposition', (req.query.download ? 'attachment' : 'inline') + '; filename="' + String(rows[0].file_name || 'statement').replace(/[^\w.\- ]/g, '_') + '"');
      res.send(rows[0].file);
    } catch (e) { fail(res, e); }
  });
  app.delete('/api/cards/statements/:sid(\\d+)', ...CC, async (req, res) => {
    try {
      await ready();
      const { rows } = await query(`SELECT status FROM cc_statements WHERE id = $1`, [parseInt(req.params.sid, 10)]);
      if (!rows.length) throw httpError(404, 'Not found');
      if (rows[0].status === 'reconciled') throw httpError(409, 'This statement is reconciled: undo the reconciliation first');
      await query(`DELETE FROM cc_statements WHERE id = $1`, [parseInt(req.params.sid, 10)]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ---------------------------------------------------- statement lines (CSV) --
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
    const neg = /^\(.*\)$/.test(s) || /-$/.test(s) || /^-/.test(s) || /\bCR\b/i.test(s);
    s = s.replace(/[^0-9.]/g, '');
    if (!s) return null;
    const x = Number(s);
    return isNaN(x) ? null : (neg ? -x : x);
  };
  // Card statements list charges as + (what you owe goes up) and payments / credits as - (or CR).
  // Stored in bank_feed_lines in the ledger's sign (charge = -, payment = +), like Banking.
  async function importCsv(a, text, o) {
    const rows = parseCsv(String(text || '').slice(0, 2000000));
    if (rows.length < 2) throw httpError(400, 'Paste or choose the CSV file from the card company (with a heading row)');
    const head = rows[0].map((h) => h.trim().toLowerCase());
    const find = (...names) => head.findIndex((h) => names.some((x) => h === x || h.includes(x)));
    const ci = { date: find('transaction date', 'trans date', 'date', 'posted'), desc: find('description', 'details', 'merchant', 'narrative', 'memo', 'particulars', 'payee'),
      amount: head.findIndex((h) => /^(amount|amount \(jmd\)|amount \(usd\)|transaction amount|amt|billing amount)$/.test(h)),
      debit: find('debit', 'charge', 'purchases', 'money out'), credit: find('credit', 'payment', 'money in'), card: find('card no', 'card number', 'card ending', 'last 4') };
    if (ci.date < 0 || ci.desc < 0 || (ci.amount < 0 && ci.debit < 0 && ci.credit < 0)) throw httpError(400, 'Could not find the Date, Description and Amount (or Debit / Credit) columns in the heading row: ' + rows[0].join(', '));
    const order = o.date_order === 'mdy' ? 'mdy' : 'dmy';
    const chargesNegative = o.charges === 'negative';
    const seen = {}, out = { added: 0, duplicates: 0, skipped: 0 };
    const ref = o.ref || ('import ' + new Date().toISOString().slice(0, 16));
    for (const r of rows.slice(1)) {
      const date = parseDate(r[ci.date], order);
      let owe = null;   // + = a charge (owed goes up)
      if (ci.amount >= 0) { const x = num(r[ci.amount]); if (x != null) owe = chargesNegative ? -x : x; }
      if (owe == null) { const d = ci.debit >= 0 ? num(r[ci.debit]) : null, c2 = ci.credit >= 0 ? num(r[ci.credit]) : null; owe = d || c2 ? (d ? Math.abs(d) : 0) - (c2 ? Math.abs(c2) : 0) : null; }
      let desc = String(r[ci.desc] || '').trim().slice(0, 190);
      if (ci.card >= 0 && String(r[ci.card] || '').trim()) desc = (desc + ' [' + String(r[ci.card]).replace(/\D/g, '').slice(-4) + ']').slice(0, 200);
      if (!date || owe == null || !owe || !desc) { out.skipped++; continue; }
      const amt = r2(-owe);
      const base = date + '|' + amt + '|' + desc.toLowerCase();
      seen[base] = (seen[base] || 0) + 1;
      const hash = crypto.createHash('sha256').update(base + '|' + seen[base]).digest('hex').slice(0, 32);
      const { rowCount } = await query(`INSERT INTO bank_feed_lines (account_id, import_ref, txn_date, description, amount, line_hash, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (account_id, line_hash) DO NOTHING`,
        [a.id, ref, date, desc, amt, hash, o.userId]);
      if (rowCount) out.added++; else out.duplicates++;
    }
    return out;
  }
  app.post('/api/cards/:id(\\d+)/import', ...CC, async (req, res) => {
    try { const a = await cardAccount(req.params.id), b = req.body || {}; res.json(Object.assign({ ok: true }, await importCsv(a, b.csv, { date_order: b.date_order, charges: b.charges, userId: req.session.userId }))); } catch (e) { fail(res, e); }
  });
  app.get('/api/cards/:id(\\d+)/feed', ...CC, async (req, res) => {
    try {
      const a = await cardAccount(req.params.id);
      const st = ['new', 'matched', 'added', 'ignored'].includes(req.query.status) ? req.query.status : 'new';
      const { rows } = await query(
        `SELECT f.id, to_char(f.txn_date, 'YYYY-MM-DD') AS day, f.description, (-f.amount)::float AS amount, f.status, f.gl_line_id::int AS gl_line_id, f.bank_txn_id
           FROM bank_feed_lines f WHERE f.account_id = $1 AND f.status = $2 ORDER BY f.txn_date DESC, f.id DESC LIMIT 500`, [a.id, st]);
      if (st === 'new') {
        const { rows: rules } = await query(`SELECT r.contains, r.gl_account_id, r.payee FROM bank_rules r JOIN gl_accounts g ON g.id = r.gl_account_id WHERE g.is_active ORDER BY length(r.contains) DESC`);
        for (const f of rows) {
          const { rows: m } = await query(
            `SELECT l.id::int AS id, to_char(e.entry_date, 'YYYY-MM-DD') AS day, e.number, e.source_ref AS ref, COALESCE(l.party, e.memo) AS what, (-l.amount)::float AS amount
               FROM gl_lines l JOIN gl_entries e ON e.id = l.entry_id
              WHERE l.account_id = $1 AND abs(-l.amount - $2) < 0.005 AND e.entry_date BETWEEN $3::date - 10 AND $3::date + 10
                AND NOT EXISTS (SELECT 1 FROM bank_feed_lines f2 WHERE f2.gl_line_id = l.id AND f2.status = 'matched')
              ORDER BY abs(e.entry_date - $3::date), l.id LIMIT 3`, [a.id, f.amount, f.day]);
          f.matches = m;
          // An account to suggest: a rule, else what the same merchant was booked to last time on this card.
          const rule = rules.find((r) => f.description.toLowerCase().includes(String(r.contains).toLowerCase()));
          if (rule) f.suggest = { account_id: rule.gl_account_id, payee: rule.payee, why: 'rule' };
          else {
            const key = f.description.toLowerCase().replace(/[^a-z ]/g, ' ').trim().split(/\s+/).slice(0, 2).join(' ');
            if (key.length >= 3) {
              const { rows: prev } = await query(
                `SELECT bl.account_id, t.payee FROM bank_feed_lines x JOIN bank_txns t ON t.id = x.bank_txn_id JOIN bank_txn_lines bl ON bl.txn_id = t.id
                  WHERE x.account_id = $1 AND x.status IN ('added','matched') AND lower(x.description) LIKE $2 || '%' AND t.voided_at IS NULL ORDER BY x.id DESC LIMIT 1`, [a.id, key]);
              if (prev.length) f.suggest = { account_id: prev[0].account_id, payee: prev[0].payee, why: 'last time' };
            }
          }
        }
      }
      res.json({ lines: rows });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/cards/feed/:fid(\\d+)/match', ...CC, async (req, res) => {
    try {
      await ready();
      const { rows: f } = await query(`SELECT * FROM bank_feed_lines WHERE id = $1 AND status = 'new'`, [parseInt(req.params.fid, 10)]);
      if (!f.length) throw httpError(409, 'Already dealt with');
      await cardAccount(f[0].account_id);
      const gid = parseInt((req.body || {}).gl_line_id, 10);
      const { rows: l } = await query(`SELECT l.amount::float AS amount FROM gl_lines l WHERE l.id = $1 AND l.account_id = $2 AND NOT EXISTS (SELECT 1 FROM bank_feed_lines x WHERE x.gl_line_id = l.id AND x.status = 'matched')`, [gid || 0, f[0].account_id]);
      if (!l.length) throw httpError(400, 'That ledger line is not available');
      if (Math.abs(l[0].amount - Number(f[0].amount)) > 0.005) throw httpError(400, 'The amounts differ');
      await query(`UPDATE bank_feed_lines SET status = 'matched', gl_line_id = $2 WHERE id = $1`, [f[0].id, gid]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  // Add a statement line to the books: a charge / refund / fee / interest on the card, or a payment from a bank account.
  app.post('/api/cards/feed/:fid(\\d+)/add', ...CC, async (req, res) => {
    try {
      await ready();
      const b = req.body || {};
      const { rows: f } = await query(`SELECT *, to_char(txn_date, 'YYYY-MM-DD') AS day, amount::float AS amt FROM bank_feed_lines WHERE id = $1 AND status = 'new'`, [parseInt(req.params.fid, 10)]);
      if (!f.length) throw httpError(409, 'Already dealt with');
      const line = f[0], a = await cardAccount(line.account_id), owe = -line.amt, amt = Math.abs(line.amt);
      let kind = b.kind;
      if (owe > 0 && !['purchase', 'fee', 'interest', 'cash_advance'].includes(kind)) kind = 'purchase';
      if (owe < 0 && !['refund', 'payment', 'reward'].includes(kind)) kind = 'refund';
      const payee = str(b.payee, 80) || line.description.slice(0, 80);
      let t;
      if (kind === 'payment') {
        const from = await bankAcct(b.account_id);
        t = await tx(async (c) => {
          const x = await books.makeTxn(c, { kind: 'expense', accountId: from.id, date: line.day, payee: a.issuer || a.name, supplierId: null, cheque: null, reference: null, memo: 'Payment to ' + a.name + ': ' + line.description.slice(0, 120), lines: [{ account_id: a.id, amount: amt, memo: 'Card payment' }], userId: req.session.userId });
          await c.query(`INSERT INTO cc_txn_meta (bank_txn_id, card_id, kind) VALUES ($1,$2,'payment')`, [x.id, a.id]);
          await c.query(`UPDATE bank_feed_lines SET status = 'added', bank_txn_id = $2 WHERE id = $1`, [line.id, x.id]);
          return x;
        });
      } else {
        let acctId;
        if (kind === 'fee' || kind === 'interest') acctId = await acctByKey('cc_charges');
        else if (kind === 'reward') acctId = await acctByKey('cc_rewards');
        else if (kind === 'cash_advance') acctId = (await bankAcct(b.account_id)).id;
        else acctId = (await books.lineAccount(b.account_id)).id;
        if (acctId === a.id) throw httpError(400, 'Choose the other side of the transaction');
        const hid = await holderId(a.id, b.holder_id);
        const cls = await books.classId(b.class_id);
        t = await tx(async (c) => {
          const x = await books.makeTxn(c, { kind: owe < 0 ? 'deposit' : 'expense', accountId: a.id, date: line.day, payee, supplierId: null, cheque: null, reference: null,
            memo: str(b.memo, 300) || line.description, lines: [{ account_id: acctId, amount: amt, memo: line.description, class_id: cls }], userId: req.session.userId });
          await c.query(`INSERT INTO cc_txn_meta (bank_txn_id, card_id, kind, holder_id) VALUES ($1,$2,$3,$4)`, [x.id, a.id, kind, hid]);
          if (kind === 'reward') await c.query(`INSERT INTO cc_reward_events (account_id, kind, event_date, points, value, bank_txn_id, memo, created_by) VALUES ($1,'redeemed',$2,$3,$4,$5,$6,$7)`,
            [a.id, line.day, n(a.point_value) > 0 ? r2(amt / n(a.point_value)) : amt, amt, x.id, 'Statement credit: ' + line.description.slice(0, 120), req.session.userId]);
          await c.query(`UPDATE bank_feed_lines SET status = 'added', bank_txn_id = $2 WHERE id = $1`, [line.id, x.id]);
          if (b.make_rule && String(b.rule_text || '').trim().length >= 3 && kind === 'purchase') await c.query(`INSERT INTO bank_rules (contains, gl_account_id, payee, created_by) VALUES ($1,$2,$3,$4)`, [String(b.rule_text).trim().slice(0, 80), acctId, payee, req.session.userId]);
          return x;
        });
      }
      await post();
      const { rows: gl } = await query(`SELECT l.id FROM gl_lines l JOIN gl_entries e ON e.id = l.entry_id WHERE e.source_kind = 'bank_txn' AND e.source_id = $1 AND l.account_id = $2`, [t.id, a.id]);
      if (gl.length) await query(`UPDATE bank_feed_lines SET gl_line_id = $2, status = 'matched' WHERE id = $1`, [line.id, gl[0].id]);
      res.json({ ok: true, id: t.id, kind });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/cards/feed/:fid(\\d+)/ignore', ...CC, async (req, res) => {
    try {
      await ready();
      const undo = !!(req.body || {}).undo;
      const { rows: f } = await query(`SELECT account_id FROM bank_feed_lines WHERE id = $1`, [parseInt(req.params.fid, 10)]);
      if (!f.length) throw httpError(404, 'Not found');
      await cardAccount(f[0].account_id);
      const { rowCount } = await query(`UPDATE bank_feed_lines SET status = $2 WHERE id = $1 AND status = $3`, [parseInt(req.params.fid, 10), undo ? 'new' : 'ignored', undo ? 'ignored' : 'new']);
      if (!rowCount) throw httpError(409, 'Already dealt with');
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ============================================================ reconcile ==
  // Same tables as Banking (bank_recons, bank_cleared). The ledger balance of a card is a credit
  // (minus), so statement_balance / opening_balance are stored minus and shown as owed (+).
  async function reconView(card, reconId) {
    const { rows: rr } = await query(`SELECT *, to_char(statement_date, 'YYYY-MM-DD') AS sday, statement_balance::float AS sbal, opening_balance::float AS obal FROM bank_recons WHERE id = $1`, [reconId]);
    const r = rr[0];
    const { rows: lines } = await query(
      `SELECT l.id::int AS id, to_char(e.entry_date, 'YYYY-MM-DD') AS day, e.number, e.source_ref AS ref, e.memo, l.party, (-l.amount)::float AS amount, COALESCE(bc.recon_id = $2, false) AS ticked, ${KIND_SQL} AS kind,
              EXISTS (SELECT 1 FROM bank_feed_lines f WHERE f.gl_line_id = l.id AND f.status = 'matched') AS on_statement
         ${LINE_FROM} LEFT JOIN bank_cleared bc ON bc.gl_line_id = l.id
        WHERE l.account_id = $1 AND e.entry_date <= $3::date AND (bc.gl_line_id IS NULL OR bc.recon_id = $2)
        ORDER BY e.entry_date, l.id`, [card.id, reconId, r.sday]);
    for (const l of lines) { l.kind_label = KINDS[l.kind] || l.kind; l.memo = cleanMemo(l.memo, l.party); }
    const cleared = r2(lines.filter((l) => l.ticked).reduce((t, l) => t + l.amount, 0));
    const { rows: st } = await query(`SELECT id FROM cc_statements WHERE account_id = $1 AND closing_date = $2::date`, [card.id, r.sday]);
    const charges = r2(lines.filter((l) => l.ticked && l.amount > 0).reduce((t, l) => t + l.amount, 0)), credits = r2(-lines.filter((l) => l.ticked && l.amount < 0).reduce((t, l) => t + l.amount, 0));
    return { recon: { id: r.id, statement_date: r.sday, statement_balance: r2(-r.sbal), opening_balance: r2(-r.obal), status: r.status, statement_id: st.length ? st[0].id : null }, lines,
      ticked_charges: charges, ticked_credits: credits, cleared_balance: r2(-r.obal + cleared), difference: r2(-r.sbal - (-r.obal + cleared)) };
  }
  app.get('/api/cards/:id(\\d+)/reconcile', ...CC, async (req, res) => {
    try {
      const a = await cardAccount(req.params.id);
      const { rows: open } = await query(`SELECT id FROM bank_recons WHERE account_id = $1 AND status = 'open'`, [a.id]);
      const { rows: done } = await query(`SELECT r.id, to_char(r.statement_date, 'YYYY-MM-DD') AS statement_date, (-r.statement_balance)::float AS statement_balance, r.finished_at, u.name AS by_name
                                            FROM bank_recons r LEFT JOIN users u ON u.id = r.finished_by WHERE r.account_id = $1 AND r.status = 'done' ORDER BY r.statement_date DESC, r.id DESC LIMIT 24`, [a.id]);
      const { rows: todo } = await query(`SELECT id, to_char(closing_date, 'YYYY-MM-DD') AS closing_date, new_balance::float AS new_balance FROM cc_statements WHERE account_id = $1 AND status <> 'reconciled' ORDER BY closing_date`, [a.id]);
      res.json(Object.assign({ account: cardOut(a), history: done, statements: todo }, open.length ? await reconView(a, open[0].id) : { recon: null }));
    } catch (e) { fail(res, e); }
  });
  app.post('/api/cards/:id(\\d+)/reconcile/start', ...CC, async (req, res) => {
    try {
      const a = await cardAccount(req.params.id), b = req.body || {};
      let date = b.statement_date, owed = b.statement_balance;
      if (b.statement_id) {
        const { rows } = await query(`SELECT to_char(closing_date, 'YYYY-MM-DD') AS d, new_balance::float AS v FROM cc_statements WHERE id = $1 AND account_id = $2`, [parseInt(b.statement_id, 10), a.id]);
        if (!rows.length) throw httpError(404, 'Statement not found');
        date = rows[0].d; owed = rows[0].v;
      }
      if (!isDate(date)) throw httpError(400, 'Statement closing date');
      if (owed === '' || owed == null || isNaN(Number(owed))) throw httpError(400, 'Statement new balance');
      const { rows: last } = await query(`SELECT statement_balance::float AS v, to_char(statement_date, 'YYYY-MM-DD') AS d FROM bank_recons WHERE account_id = $1 AND status = 'done' ORDER BY statement_date DESC, id DESC LIMIT 1`, [a.id]);
      if (last.length && date <= last[0].d) throw httpError(400, 'The last reconciliation was to ' + last[0].d + '; choose a later statement');
      const { rows } = await query(`INSERT INTO bank_recons (account_id, statement_date, statement_balance, opening_balance, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [a.id, date, r2(-n(owed)), last.length ? last[0].v : 0, req.session.userId]);
      res.json(Object.assign({ ok: true }, await reconView(a, rows[0].id)));
    } catch (e) { if (e.code === '23505') e = httpError(409, 'A reconciliation is already open for this card'); fail(res, e); }
  });
  async function openRecon(id) {
    await ready();
    const { rows: rr } = await query(`SELECT *, to_char(statement_date, 'YYYY-MM-DD') AS sday FROM bank_recons WHERE id = $1 AND status = 'open'`, [parseInt(id, 10) || 0]);
    if (!rr.length) throw httpError(409, 'No open reconciliation');
    const card = await cardAccount(rr[0].account_id);
    return { r: rr[0], card };
  }
  app.post('/api/cards/reconcile/:rid(\\d+)/tick', ...CC, async (req, res) => {
    try {
      const { r, card } = await openRecon(req.params.rid), b = req.body || {};
      let ids = (Array.isArray(b.lines) ? b.lines : []).map((x) => parseInt(x, 10)).filter(Boolean);
      if (b.matched) {
        const { rows } = await query(`SELECT f.gl_line_id AS id FROM bank_feed_lines f JOIN gl_lines l ON l.id = f.gl_line_id JOIN gl_entries e ON e.id = l.entry_id
                                       WHERE f.account_id = $1 AND f.status = 'matched' AND e.entry_date <= $2 AND NOT EXISTS (SELECT 1 FROM bank_cleared bc WHERE bc.gl_line_id = f.gl_line_id)`, [card.id, r.sday]);
        ids = rows.map((x) => Number(x.id));
      }
      if (b.clear === false) await query(`DELETE FROM bank_cleared WHERE recon_id = $1 AND gl_line_id = ANY($2)`, [r.id, ids]);
      else await query(`INSERT INTO bank_cleared (gl_line_id, recon_id, cleared_by) SELECT l.id, $1, $4 FROM gl_lines l JOIN gl_entries e ON e.id = l.entry_id
                         WHERE l.id = ANY($2) AND l.account_id = $3 AND e.entry_date <= $5 ON CONFLICT (gl_line_id) DO NOTHING`, [r.id, ids, card.id, req.session.userId, r.sday]);
      res.json(Object.assign({ ok: true }, await reconView(card, r.id)));
    } catch (e) { fail(res, e); }
  });
  // Interest, a fee or a difference found while reconciling: entered on the card and ticked in one go.
  app.post('/api/cards/reconcile/:rid(\\d+)/adjust', ...CC, async (req, res) => {
    try {
      const { r, card } = await openRecon(req.params.rid), b = req.body || {};
      const amt = r2(b.amount);   // + = owed goes up (interest, fee), - = a credit
      if (!amt) throw httpError(400, 'Amount (minus for a credit)');
      const kind = b.kind === 'interest' ? 'interest' : b.kind === 'difference' ? 'other' : amt < 0 ? 'refund' : 'fee';
      const acct = b.kind === 'difference' ? await acctByKey('recon_diff') : await acctByKey('cc_charges');
      const t = await tx(async (c) => {
        const x = await books.makeTxn(c, { kind: amt < 0 ? 'deposit' : 'expense', accountId: card.id, date: r.sday, payee: card.issuer || card.name, supplierId: null, cheque: null, reference: null,
          memo: str(b.memo, 200) || (b.kind === 'difference' ? 'Reconciliation difference' : kind === 'interest' ? 'Interest charged' : amt < 0 ? 'Card credit' : 'Card fee'), lines: [{ account_id: acct, amount: Math.abs(amt), memo: null }], userId: req.session.userId });
        await c.query(`INSERT INTO cc_txn_meta (bank_txn_id, card_id, kind) VALUES ($1,$2,$3)`, [x.id, card.id, kind]);
        return x;
      });
      await post();
      const { rows: gl } = await query(`SELECT l.id FROM gl_lines l JOIN gl_entries e ON e.id = l.entry_id WHERE e.source_kind = 'bank_txn' AND e.source_id = $1 AND l.account_id = $2`, [t.id, card.id]);
      if (gl.length) await query(`INSERT INTO bank_cleared (gl_line_id, recon_id, cleared_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [gl[0].id, r.id, req.session.userId]);
      res.json(Object.assign({ ok: true, posted: !!gl.length }, await reconView(card, r.id)));
    } catch (e) { fail(res, e); }
  });
  app.post('/api/cards/reconcile/:rid(\\d+)/finish', ...CC, async (req, res) => {
    try {
      const { r, card } = await openRecon(req.params.rid);
      const v = await reconView(card, r.id);
      if (Math.abs(v.difference) > 0.005) throw httpError(409, 'The difference is ' + money(v.difference) + '. Tick the items on the statement, or enter interest, a fee or an adjustment.');
      await tx(async (c) => {
        await c.query(`UPDATE bank_recons SET status = 'done', finished_by = $2, finished_at = NOW() WHERE id = $1`, [r.id, req.session.userId]);
        await c.query(`UPDATE cc_statements SET status = 'reconciled', recon_id = $2 WHERE account_id = $1 AND closing_date = $3::date`, [card.id, r.id, r.sday]);
      });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/cards/reconcile/:rid(\\d+)/cancel', ...CC, async (req, res) => {
    try { const { r } = await openRecon(req.params.rid); await query(`DELETE FROM bank_recons WHERE id = $1 AND status = 'open'`, [r.id]); res.json({ ok: true }); } catch (e) { fail(res, e); }
  });
  app.post('/api/cards/:id(\\d+)/reconcile/undo-last', ...CC, async (req, res) => {
    try {
      const a = await cardAccount(req.params.id);
      const { rows: open } = await query(`SELECT 1 FROM bank_recons WHERE account_id = $1 AND status = 'open'`, [a.id]);
      if (open.length) throw httpError(409, 'Finish or cancel the open reconciliation first');
      const { rows } = await query(`SELECT id FROM bank_recons WHERE account_id = $1 AND status = 'done' ORDER BY statement_date DESC, id DESC LIMIT 1`, [a.id]);
      if (!rows.length) throw httpError(409, 'Nothing to undo');
      await tx(async (c) => {
        await c.query(`UPDATE cc_statements SET status = 'open', recon_id = NULL WHERE recon_id = $1`, [rows[0].id]);
        await c.query(`DELETE FROM bank_recons WHERE id = $1`, [rows[0].id]);
      });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ============================================================ rewards ==
  app.get('/api/cards/:id(\\d+)/rewards', ...CC, async (req, res) => {
    try {
      const a = await cardAccount(req.params.id);
      const { rows: events } = await query(
        `SELECT ev.id, ev.kind, to_char(ev.event_date, 'YYYY-MM-DD') AS day, ev.points::float AS points, ev.value::float AS value, ev.memo, ev.bank_txn_id, ev.statement_id, ev.voided_at, u.name AS by_name
           FROM cc_reward_events ev LEFT JOIN users u ON u.id = ev.created_by WHERE ev.account_id = $1 ORDER BY ev.event_date DESC, ev.id DESC LIMIT 500`, [a.id]);
      // Month by month: spending and points worked out (calculate mode).
      const months = [];
      if (a.rewards_kind !== 'none' && a.rewards_mode !== 'statement') {
        const { rows } = await query(
          `SELECT to_char(date_trunc('month', t.txn_date), 'YYYY-MM') AS month,
                  SUM(CASE WHEN m.kind = 'refund' THEN -1 ELSE 1 END * l.amount)::float AS spend,
                  SUM(CASE WHEN m.kind = 'refund' THEN -1 ELSE 1 END * l.amount * COALESCE(rr.multiplier, 1))::float AS weighted
             FROM bank_txns t JOIN cc_txn_meta m ON m.bank_txn_id = t.id JOIN bank_txn_lines l ON l.txn_id = t.id LEFT JOIN cc_reward_rules rr ON rr.account_id = t.account_id AND rr.gl_account_id = l.account_id
            WHERE t.account_id = $1 AND t.voided_at IS NULL AND m.kind IN ('purchase','refund','moved') AND t.txn_date >= COALESCE($2::date, '1900-01-01') GROUP BY 1 ORDER BY 1 DESC LIMIT 24`, [a.id, a.rewards_start || null]);
        for (const r of rows) months.push({ month: r.month, spend: r2(r.spend), points: r2(r.weighted * n(a.earn_rate) / 100) });
      }
      res.json({ card: cardOut(a), rewards: await rewardsFor(a), events, months });
    } catch (e) { fail(res, e); }
  });
  // kind: bonus | adjust | expired | redeemed (redeem_as: statement_credit posts a credit to the card; cash, gift, travel, other just record it)
  app.post('/api/cards/:id(\\d+)/rewards', ...CC, async (req, res) => {
    try {
      const a = await cardAccount(req.params.id), b = req.body || {};
      const kind = ['bonus', 'adjust', 'expired', 'redeemed', 'earned'].includes(b.kind) ? b.kind : null;
      if (!kind) throw httpError(400, 'Bonus, adjustment, expired or redeemed?');
      const points = r2(b.points);
      if (!points || (kind !== 'adjust' && points < 0)) throw httpError(400, 'How many points');
      const date = isDate(b.event_date) ? b.event_date : today();
      const value = numOrNull(b.value) != null ? r2(b.value) : r2(points * n(a.point_value));
      if (kind === 'redeemed') {
        const bal = (await rewardsFor(a)).balance;
        if (points > bal + 0.005) throw httpError(400, 'Only ' + bal + ' points are available');
      }
      const out = await tx(async (c) => {
        let txnId = null;
        if (kind === 'redeemed' && (b.redeem_as === 'statement_credit' || b.redeem_as === 'cash')) {
          if (!(value > 0)) throw httpError(400, 'The value in J$');
          const income = await acctByKey('cc_rewards');
          const x = b.redeem_as === 'statement_credit'
            ? await books.makeTxn(c, { kind: 'deposit', accountId: a.id, date, payee: a.issuer || a.name, supplierId: null, cheque: null, reference: null, memo: 'Rewards redeemed as a statement credit', lines: [{ account_id: income, amount: value, memo: points + ' points' }], userId: req.session.userId })
            : await books.makeTxn(c, { kind: 'deposit', accountId: (await bankAcct(b.to_account_id)).id, date, payee: a.issuer || a.name, supplierId: null, cheque: null, reference: null, memo: 'Rewards cashed out from ' + a.name, lines: [{ account_id: income, amount: value, memo: points + ' points' }], userId: req.session.userId });
          await c.query(`INSERT INTO cc_txn_meta (bank_txn_id, card_id, kind) VALUES ($1,$2,$3)`, [x.id, a.id, b.redeem_as === 'statement_credit' ? 'reward' : 'reward_cash']);
          txnId = x.id;
        }
        const memo = str(b.memo, 200) || (kind === 'redeemed' ? ({ statement_credit: 'Statement credit', cash: 'Cashed out to the bank', gift: 'Gift card / voucher', travel: 'Travel', goods: 'Goods' }[b.redeem_as] || 'Redeemed') : null);
        const { rows } = await c.query(`INSERT INTO cc_reward_events (account_id, kind, event_date, points, value, bank_txn_id, memo, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [a.id, kind, date, points, kind === 'redeemed' ? value : null, txnId, memo, req.session.userId]);
        return { id: rows[0].id, bank_txn_id: txnId };
      });
      if (out.bank_txn_id) await post();
      res.json(Object.assign({ ok: true }, out));
    } catch (e) { fail(res, e); }
  });
  app.post('/api/cards/rewards/:eid(\\d+)/void', ...CC, async (req, res) => {
    try {
      await ready();
      const { rows } = await query(`SELECT * FROM cc_reward_events WHERE id = $1 AND voided_at IS NULL`, [parseInt(req.params.eid, 10)]);
      if (!rows.length) throw httpError(409, 'Not found or already voided');
      if (rows[0].bank_txn_id) throw httpError(409, 'This redemption posted a credit: void that transaction in the register instead');
      if (rows[0].statement_id && rows[0].kind === 'earned') throw httpError(409, 'These points come from a statement: change the statement instead');
      await query(`UPDATE cc_reward_events SET voided_at = NOW() WHERE id = $1`, [rows[0].id]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ============================================================ reports ==
  app.get('/api/cards/report', ...CC, async (req, res) => {
    try {
      await ready();
      const t = today();
      const from = isDate(req.query.from) ? req.query.from : t.slice(0, 4) + '-01-01', to = isDate(req.query.to) ? req.query.to : t;
      const cards = (await allCards()).filter((a) => !req.query.card || String(a.id) === String(req.query.card));
      const ids = cards.map((a) => a.id);
      if (!ids.length) return res.json({ from, to, cards: [], by_category: [], by_payee: [], by_holder: [], by_source: [], monthly: [], charges: [], fees: [], payments: [], statements: [] });   // every list the page reads, even with no card yet
      // Every card line in the period, not voided, with its kind.
      const { rows: lines } = await query(
        `SELECT l.id, l.account_id, to_char(e.entry_date, 'YYYY-MM-DD') AS day, to_char(e.entry_date, 'YYYY-MM') AS month, e.id AS entry_id, e.source_kind, e.number, e.source_ref AS ref, e.memo, l.party,
                (-l.amount)::float AS amount, ${KIND_SQL} AS kind, h.name AS holder
           ${LINE_FROM}
          WHERE l.account_id = ANY($1) AND e.entry_date BETWEEN $2::date AND $3::date AND e.reversed_by IS NULL AND e.reverses_id IS NULL ORDER BY e.entry_date, l.id`, [ids, from, to]);
      const spendKinds = ['purchase', 'bill', 'po', 'moved', 'cash_advance', 'refund'];
      // The category of a charge: the other side of its entry (expense accounts; Accounts Payable for bills paid).
      const entryIds = [...new Set(lines.filter((l) => spendKinds.includes(l.kind)).map((l) => l.entry_id))];
      const { rows: other } = entryIds.length ? await query(
        `SELECT o.entry_id, o.account_id, o.amount::float AS amount, a.code, a.name, a.system_key FROM gl_lines o JOIN gl_accounts a ON a.id = o.account_id WHERE o.entry_id = ANY($1) AND a.qb_type IS DISTINCT FROM 'CCARD'`, [entryIds]) : { rows: [] };
      const add = (map, key, label, amt, extra) => { const x = map.get(key) || Object.assign({ key, label, amount: 0, count: 0 }, extra || {}); x.amount = r2(x.amount + amt); x.count++; map.set(key, x); };
      const cat = new Map(), payee = new Map(), holder = new Map(), source = new Map(), month = new Map();
      const per = new Map(ids.map((id) => [id, { charges: 0, refunds: 0, payments: 0, fees: 0, interest: 0, cash_advances: 0, rewards: 0, other: 0 }]));
      for (const l of lines) {
        l.memo = cleanMemo(l.memo, l.party);
        const p = per.get(l.account_id);
        const k = l.kind;
        if (k === 'payment') p.payments = r2(p.payments - l.amount);
        else if (k === 'refund') p.refunds = r2(p.refunds - l.amount);
        else if (k === 'fee') p.fees = r2(p.fees + l.amount);
        else if (k === 'interest') p.interest = r2(p.interest + l.amount);
        else if (k === 'cash_advance') p.cash_advances = r2(p.cash_advances + l.amount);
        else if (k === 'reward') p.rewards = r2(p.rewards - l.amount);
        else if (['purchase', 'bill', 'po', 'moved'].includes(k)) p.charges = r2(p.charges + l.amount);
        else p.other = r2(p.other + l.amount);
        const m = month.get(l.month) || { month: l.month, charges: 0, payments: 0, fees_interest: 0 };
        if (k === 'payment') m.payments = r2(m.payments - l.amount); else if (k === 'fee' || k === 'interest') m.fees_interest = r2(m.fees_interest + l.amount); else if (spendKinds.includes(k)) m.charges = r2(m.charges + l.amount);
        month.set(l.month, m);
        if (spendKinds.includes(k)) {
          const os = other.filter((o) => o.entry_id === l.entry_id);
          const tot = os.reduce((s, o) => s + Math.abs(o.amount), 0) || 1;
          if (k === 'cash_advance') add(cat, 'cash', 'Cash advances', l.amount);
          else if (k === 'moved') add(cat, 'ap', 'Supplier bills (Payables)', l.amount);
          else for (const o of os) { const share = r2(l.amount * Math.abs(o.amount) / tot); add(cat, o.system_key === 'ap' ? 'ap' : o.account_id, o.system_key === 'ap' ? 'Supplier bills (Payables)' : o.code + ' ' + o.name, share); }
          if (!os.length && k !== 'cash_advance' && k !== 'moved') add(cat, 0, 'Uncategorised', l.amount);
          add(payee, String(l.party || l.memo || '').toLowerCase().slice(0, 60) || '-', l.party || l.memo || '—', l.amount);
          add(holder, l.holder || '-', l.holder || 'Not given', l.amount);
          add(source, l.source_kind, SOURCES[l.source_kind] || l.source_kind, l.amount);
        }
      }
      const out = [];
      for (const a of cards) {
        const { rows: [ob] } = await query(`SELECT COALESCE(-SUM(l.amount), 0)::float AS v FROM gl_lines l JOIN gl_entries e ON e.id = l.entry_id WHERE l.account_id = $1 AND e.entry_date < $2::date`, [a.id, from]);
        const { rows: [cb] } = await query(`SELECT COALESCE(-SUM(l.amount), 0)::float AS v FROM gl_lines l JOIN gl_entries e ON e.id = l.entry_id WHERE l.account_id = $1 AND e.entry_date <= $2::date`, [a.id, to]);
        const rw = await rewardsFor(a, to), rw0 = await rewardsFor(a, (() => { const d = new Date(Date.parse(from) - 86400000); return d.toISOString().slice(0, 10); })());
        out.push(Object.assign({ id: a.id, code: a.code, name: a.name, last4: a.last4 || null, credit_limit: a.credit_limit == null ? null : n(a.credit_limit), opening: r2(ob.v), closing: r2(cb.v),
          rewards_earned: r2(rw.earned - rw0.earned), rewards_redeemed: r2(rw.redeemed - rw0.redeemed), rewards_balance: rw.balance, rewards_value: rw.value }, per.get(a.id)));
      }
      const sorted = (m) => [...m.values()].sort((x, y) => y.amount - x.amount);
      const { rows: statements } = await query(`SELECT ${STMT_COLS}, g.name AS card FROM cc_statements s JOIN gl_accounts g ON g.id = s.account_id WHERE s.account_id = ANY($1) AND s.closing_date BETWEEN $2::date AND $3::date ORDER BY s.closing_date DESC`, [ids, from, to]);
      const cardName = (id) => { const c = cards.find((x) => x.id === Number(id)); return c ? c.name : ''; };
      res.json({ from, to, cards: out, by_category: sorted(cat), by_payee: sorted(payee).slice(0, 50), by_holder: sorted(holder), by_source: sorted(source), monthly: [...month.values()].sort((x, y) => (x.month < y.month ? -1 : 1)),
        charges: lines.filter((l) => k2(l.kind) === 'charge').map((l) => ({ day: l.day, card: cardName(l.account_id), kind: KINDS[l.kind], party: l.party, memo: l.memo, holder: l.holder, ref: l.ref || l.number, amount: l.amount })),
        fees: lines.filter((l) => l.kind === 'fee' || l.kind === 'interest').map((l) => ({ day: l.day, card: cardName(l.account_id), kind: KINDS[l.kind], memo: l.memo, amount: l.amount })),
        payments: lines.filter((l) => l.kind === 'payment').map((l) => ({ day: l.day, card: cardName(l.account_id), memo: l.memo, ref: l.ref || l.number, amount: -l.amount })),
        statements: statements.map((s) => Object.assign(s, { has_file: !!s.file_name })) });
      function k2(k) { return spendKinds.includes(k) ? 'charge' : k; }
    } catch (e) { fail(res, e); }
  });

  return { offCard, cardAccount, ready };
}

module.exports = { register, DDL };
