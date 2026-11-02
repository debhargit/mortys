// =============================================================================
//  Vision Auto Solutions -- General ledger (Phase 7)
//
//  Mounted by server.js:  require('./gl').register(app, deps)
//  Routes under /api/gl. Capabilities: acct.view (journal, trial balance,
//  tie-out), acct.post (post now, manual journals, reversals), acct.setup
//  (accounts, mapping, ledger start), acct.close (close / reopen months),
//  acct.export (QuickBooks IIF and CSV).
//
//  How it works: the till keeps doing its own work; this module reads the
//  finished documents and posts each one ONCE as a balanced journal entry,
//  keyed by (source_kind, source_id). Only documents dated on or after the
//  ledger start are posted; everything before is in QuickBooks already and
//  arrives as one opening entry built from the system on the start day.
//
//    sale            Dr A/R total; Cr sales by category, GCT, delivery income;
//                    Dr sales discounts; Dr COGS / Cr inventory at cost-at-sale
//    sale_payment    Dr cash / cheques / card clearing / gift cards; Cr A/R
//    sale_void       reverses the sale and its payments
//    return          Dr sales returns, GCT; Cr discounts, refund account;
//                    Dr inventory / Cr COGS for the units that came back
//    account_payment Dr payment account; Cr A/R
//    receipt         Dr inventory (landed); Cr GRNI (goods), landed-cost
//                    accrual (freight, duty, ...); Dr supplier claims (damaged)
//    bill            Dr GRNI; Cr A/P (supplier); difference to price variance
//    po_invoice      old purchase screens: Dr GRNI; Cr A/P
//    po_payment      Dr A/P; Cr bank / safe
//    till_open/close drawer float from and counted cash to the safe; over/short
//    till_movement   drops, payouts, float top-ups
//    petty_payout    petty cash / Cash Report payouts: Dr expense by category
//                    (or Staff Loans for an advance); Cr Petty Cash or Cash
//                    Drawers; a voided one is reversed (petty_payout_void)
//    petty_movement  petty cash opened / topped up from the bank, count
//                    differences, advances repaid; petty_advance_expensed
//    redemption_payout  a winning scratch card paid from the drawer: Dr
//                    Redeemables Held for Operator (the sale credited it)
//    stock_day       one entry per day for stock changes that are not sales,
//                    returns or receipts (counts, workshop parts, other edits),
//                    valued at the cost at the time, from the stock ledger
//    gift_card       gift cards sold at the counter (assumed paid in cash)
//    commission      commission paid out
//    ar_invoice      invoices raised on the books (rent, late fees): Dr A/R;
//                    Cr the lines' income accounts, GCT
//  Classes (QuickBooks class tracking, gl_classes): each line may carry one.
//  Till documents take their store location's class; bills, invoices, bank
//  and journal lines carry the class picked on the line; reversals keep theirs.
//  A product's own income / cost account comes before its category's rule.
//  Anything that does not add up goes to Suspense, which the tie-out shows.
//  Entries are immutable (database triggers); corrections are reversals.
// =============================================================================
'use strict';

const TZ = 'America/Jamaica';
const SKIP_PAY = ['charge', 'account', 'credit_note'];   // moves within A/R: nothing to post
const QB_TYPES = { BANK: 'asset', AR: 'asset', OCASSET: 'asset', FIXASSET: 'asset', OASSET: 'asset', AP: 'liability', CCARD: 'liability', OCLIAB: 'liability',
  LTLIAB: 'liability', EQUITY: 'equity', INC: 'income', COGS: 'cogs', EXP: 'expense', EXINC: 'other_income', EXEXP: 'other_expense' };

function register(app, deps) {
  const { query, getPool, requireAdmin, requireCap, userCan } = deps;
  const can = (k) => [requireAdmin, requireCap(k)];
  const n = (v) => (v == null ? 0 : Number(v));
  const r2 = (v) => Math.round(n(v) * 100) / 100;

  function httpError(status, msg) { const e = new Error(msg); e.status = status; e.publicMessage = msg; return e; }
  function fail(res, e) { const s = e.status || 500; if (s >= 500) console.error('[gl]', e); res.status(s).json({ error: e.publicMessage || e.message }); }
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
  const putSetting = (k, v, q = query) => q(`INSERT INTO warehouse_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [k, v]);
  const isWalkIn = (s) => !s || /^(walk-?in( customer)?|cash( sale| sales| customer)?|counter|customer)$/i.test(String(s).trim());
  const custParty = (name, id) => (id && !isWalkIn(name) ? String(name).trim().slice(0, 41) : 'Cash Sales');

  // ---------------------------------------------------------- the chart --
  async function chart(q) {
    const { rows: a } = await q(`SELECT * FROM gl_accounts`);
    const { rows: m } = await q(`SELECT * FROM gl_map`);
    const byKey = {}, byId = {}, map = {};
    for (const x of a) { byId[x.id] = x; if (x.system_key) byKey[x.system_key] = x.id; }
    for (const x of m) (map[x.kind] = map[x.kind] || {})[x.key] = x.account_id;
    const acct = (k) => { if (!byKey[k]) throw new Error('No account set up for ' + k); return byKey[k]; };
    const mapped = (kind, key, fallback) => (map[kind] && key != null && map[kind][String(key).toLowerCase()]) || acct(fallback);
    // Classes: a till's store location carries its class; a sale or shift with
    // no location is the default store's (there is one store today).
    const { rows: cl } = await q(`SELECT c.id, c.location_id, sl.is_default FROM gl_classes c LEFT JOIN store_locations sl ON sl.id = c.location_id`);
    const classByLoc = {};
    let defaultClass = null;
    for (const x of cl) { if (x.location_id) classByLoc[x.location_id] = x.id; if (x.is_default) defaultClass = x.id; }
    const locClass = (locationId) => (locationId && classByLoc[locationId]) || defaultClass;
    return { byKey, byId, map, acct, mapped, locClass };
  }

  // The date an entry carries: the event's Jamaica date, or the first day of
  // the first open month when the books for that month are already closed.
  async function bookDate(q, ts) {
    const { rows } = await q(`SELECT to_char(($1::timestamptz AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS d`, [ts]);
    let d = rows[0].d;
    const { rows: closed } = await q(`SELECT to_char(month, 'YYYY-MM') AS m FROM gl_periods`);
    const shut = new Set(closed.map((x) => x.m));
    let moved = false;
    while (shut.has(d.slice(0, 7))) {
      const [y, mo] = d.slice(0, 7).split('-').map(Number);
      d = mo === 12 ? (y + 1) + '-01-01' : y + '-' + String(mo + 1).padStart(2, '0') + '-01';
      moved = true;
    }
    return { date: d, moved, original: rows[0].d };
  }

  // Insert one entry. Lines: [{a: accountId, amt: +debit/-credit, party, memo, cls}]
  // `cls` is the line's class; e.cls is the class for lines that give none.
  // Zero lines are dropped; anything left over goes to Suspense so the entry
  // always balances (and the tie-out shows it).
  async function insertEntry(c, ch, e) {
    let lines = e.lines.map((l) => ({ ...l, amt: r2(l.amt) })).filter((l) => l.amt !== 0);
    const off = r2(lines.reduce((s, l) => s + l.amt, 0));
    if (off !== 0) lines.push({ a: e.residual || ch.acct('suspense'), amt: -off, memo: 'Does not add up: ' + off.toFixed(2) + ' to review' });
    if (lines.length < 2) return null;
    const bd = e.dateFixed ? { date: e.dateFixed, moved: false } : await bookDate(c.query.bind(c), e.at);
    const { rows } = await c.query(
      `INSERT INTO gl_entries (entry_date, book, source_kind, source_id, source_ref, memo, reverses_id, posted_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (source_kind, source_id) DO NOTHING RETURNING id`,
      [bd.date, e.book, e.kind, e.id, e.ref || null, (e.memo || '') + (bd.moved ? ' (dated ' + bd.original + '; that month was closed)' : ''), e.reverses || null, e.userId || null]);
    if (!rows.length) return null;   // already posted by another run
    const id = rows[0].id;
    await c.query(`UPDATE gl_entries SET number = 'JE-' || lpad(id::text, 6, '0') WHERE id = $1`, [id]);
    for (const l of lines) {
      await c.query(`INSERT INTO gl_lines (entry_id, account_id, amount, party, memo, class_id) VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, l.a, l.amt, l.party || null, l.memo ? String(l.memo).slice(0, 200) : null, (l.cls === undefined ? e.cls : l.cls) || null]);
    }
    return id;
  }

  // ------------------------------------------------------------ posters --
  // Each returns the entry to insert (or null) for one document, read inside c.
  const POSTERS = {
    async sale(c, ch, id) {
      const { rows: s } = await c.query(`SELECT * FROM pos_sales WHERE id = $1`, [id]);
      if (!s.length) return null;
      const x = s[0], party = custParty(x.customer_name, x.customer_id);
      // Income and cost per line: the product's own account, else its category's rule, else Sales / COGS.
      const { rows: items } = await c.query(
        `SELECT i.*, p.category, p.img AS p_img, p.income_account_id, p.cogs_account_id, p.is_redeemable, COALESCE(i.unit_cost, p.cost_usd, 0) AS cost
           FROM pos_sale_items i LEFT JOIN products p ON p.img = i.product_img WHERE i.sale_id = $1`, [id]);
      const lines = [{ a: ch.acct('ar'), amt: n(x.total_usd), party, memo: x.receipt_number }];
      for (const it of items) {
        // Scratch cards are sold as agent: the money is the operator's (2160) and
        // the cards were never our stock, so no cost of sales (owner, 2026-10-20).
        if (it.is_redeemable) { lines.push({ a: it.income_account_id || ch.acct('redeemables_payable'), amt: -n(it.total_usd), party, memo: 'Redeemable held for operator' }); continue; }
        lines.push({ a: it.p_img ? (it.income_account_id || ch.mapped('revenue_category', it.category, 'sales')) : ch.acct('sales_services'), amt: -n(it.total_usd), party });
        const cost = r2(n(it.qty) * n(it.cost));
        if (it.p_img && cost) {
          lines.push({ a: it.cogs_account_id || ch.mapped('cogs_category', it.category, 'cogs'), amt: cost });
          lines.push({ a: ch.acct('inventory'), amt: -cost });
        }
      }
      if (!items.length) lines.push({ a: ch.acct('sales_services'), amt: -n(x.subtotal_usd), memo: 'Sale without lines' });
      lines.push({ a: ch.acct('sales_discounts'), amt: n(x.discount_usd) });
      lines.push({ a: ch.acct('gct'), amt: -n(x.tax_usd) });
      lines.push({ a: ch.acct('delivery_income'), amt: -n(x.ship_fee_usd) });
      return { book: 'sales', at: x.created_at, ref: x.receipt_number, memo: 'Sale ' + x.receipt_number + (party !== 'Cash Sales' ? ' · ' + party : ''), lines, cls: ch.locClass(x.location_id) };
    },

    async sale_payment(c, ch, id) {
      const { rows } = await c.query(
        `SELECT p.*, s.receipt_number, s.customer_name, s.customer_id, s.location_id FROM sale_payments p JOIN pos_sales s ON s.id = p.sale_id WHERE p.id = $1`, [id]);
      if (!rows.length) return null;
      const p = rows[0], party = custParty(p.customer_name, p.customer_id);
      return { book: 'sales', at: p.created_at, ref: p.receipt_number, memo: 'Payment ' + p.method + ' on ' + p.receipt_number, cls: ch.locClass(p.location_id),
        lines: [{ a: ch.mapped('pay_method', p.method, 'suspense'), amt: n(p.amount_usd), memo: p.method },
                { a: ch.acct('ar'), amt: -n(p.amount_usd), party, memo: p.receipt_number }] };
    },

    // A sale voided after it was posted: reverse its entry and its payments' entries.
    async sale_void(c, ch, id) {
      const { rows: s } = await c.query(`SELECT receipt_number, voided_at FROM pos_sales WHERE id = $1`, [id]);
      const { rows: orig } = await c.query(
        `SELECT e.id FROM gl_entries e WHERE e.reversed_by IS NULL AND ((e.source_kind = 'sale' AND e.source_id = $1)
            OR (e.source_kind = 'sale_payment' AND e.source_id IN (SELECT id FROM sale_payments WHERE sale_id = $1)))`, [id]);
      if (!orig.length) return null;
      const { rows: ls } = await c.query(`SELECT account_id, amount, party, memo, class_id FROM gl_lines WHERE entry_id = ANY($1::bigint[])`, [orig.map((o) => o.id)]);
      return { book: 'sales', at: s[0].voided_at || new Date(), ref: s[0].receipt_number, memo: 'Void of sale ' + s[0].receipt_number,
        lines: ls.map((l) => ({ a: l.account_id, amt: -n(l.amount), party: l.party, memo: l.memo, cls: l.class_id })), reversesAll: orig.map((o) => o.id) };
    },

    async return(c, ch, id) {
      const { rows } = await c.query(
        `SELECT r.*, s.receipt_number, s.customer_name, s.customer_id, s.location_id FROM pos_sale_returns r JOIN pos_sales s ON s.id = r.sale_id WHERE r.id = $1`, [id]);
      if (!rows.length) return null;
      const r = rows[0], party = custParty(r.customer_name, r.customer_id);
      const refundAcct = ['account', 'charge'].includes(r.refund_method) ? ch.acct('ar') : ch.mapped('pay_method', r.refund_method, 'suspense');
      const lines = [
        { a: ch.acct('sales_returns'), amt: n(r.refund_subtotal_usd), memo: r.return_number },
        { a: ch.acct('sales_discounts'), amt: -n(r.refund_discount_usd) },
        { a: ch.acct('gct'), amt: n(r.refund_tax_usd) },
        { a: refundAcct, amt: -n(r.refund_total_usd), party: refundAcct === ch.acct('ar') ? party : null, memo: 'Refund ' + r.refund_method },
      ];
      const { rows: items } = await c.query(
        `SELECT ri.qty, p.category, p.img AS p_img, p.cogs_account_id, COALESCE(si.unit_cost, p.cost_usd, 0) AS cost
           FROM pos_sale_return_items ri JOIN pos_sale_items si ON si.id = ri.sale_item_id LEFT JOIN products p ON p.img = si.product_img
          WHERE ri.return_id = $1`, [id]);
      for (const it of items) {
        const cost = r2(n(it.qty) * n(it.cost));
        if (it.p_img && cost) {
          lines.push({ a: ch.acct('inventory'), amt: cost });
          lines.push({ a: it.cogs_account_id || ch.mapped('cogs_category', it.category, 'cogs'), amt: -cost });
        }
      }
      return { book: 'sales', at: r.created_at, ref: r.return_number, memo: 'Return ' + r.return_number + ' on ' + r.receipt_number, lines, cls: ch.locClass(r.location_id) };
    },

    async account_payment(c, ch, id) {
      const { rows } = await c.query(`SELECT a.*, to_char(a.paid_on, 'YYYY-MM-DD') AS paid_day, u.name, u.default_class_id FROM account_payments a LEFT JOIN users u ON u.id = a.customer_id WHERE a.id = $1`, [id]);
      if (!rows.length) return null;
      const p = rows[0], party = custParty(p.name, p.customer_id);
      return { book: 'sales', at: p.paid_day ? p.paid_day + 'T12:00:00-05:00' : p.created_at, ref: p.reference, memo: 'Account payment · ' + party, cls: p.default_class_id,
        lines: [{ a: p.deposit_account_id || ch.mapped('pay_method', p.method, 'suspense'), amt: n(p.amount_usd) }, { a: ch.acct('ar'), amt: -n(p.amount_usd), party }] };
    },

    async receipt(c, ch, id) {
      const { rows } = await c.query(`SELECT r.*, s.name AS supplier FROM receipts r LEFT JOIN suppliers s ON s.id = r.supplier_id WHERE r.id = $1`, [id]);
      if (!rows.length) return null;
      const r = rows[0];
      const { rows: t } = await c.query(
        `SELECT COALESCE(SUM(qty_received * COALESCE(landed_unit_cost, 0)), 0) AS landed,
                COALESCE(SUM((qty_received + qty_damaged) * COALESCE(unit_cost, 0)), 0) * $2::numeric AS goods,
                COALESCE(SUM(qty_damaged * COALESCE(unit_cost, 0)), 0) * $2::numeric AS damaged
           FROM receipt_lines WHERE receipt_id = $1`, [id, n(r.fx_rate) || 1]);
      const extras = n(r.freight) + n(r.duty) + n(r.customs) + n(r.brokerage) + n(r.other_costs);
      return { book: 'purchases', at: r.posted_at, ref: r.receipt_number, memo: 'Goods received ' + r.receipt_number + (r.supplier ? ' · ' + r.supplier : ''), residual: ch.acct('ppv'),
        lines: [{ a: ch.acct('inventory'), amt: n(t[0].landed) },
                { a: ch.acct('grni'), amt: -n(t[0].goods), memo: r.supplier },
                { a: ch.acct('supplier_claims'), amt: n(t[0].damaged), party: r.supplier, memo: 'Arrived damaged' },
                { a: ch.acct('landed_accrual'), amt: -extras, memo: 'Freight, duty, customs, brokerage' }] };
    },

    async bill(c, ch, id) {
      const { rows } = await c.query(`SELECT r.*, s.name AS supplier FROM receipts r LEFT JOIN suppliers s ON s.id = r.supplier_id WHERE r.id = $1`, [id]);
      if (!rows.length) return null;
      const r = rows[0];
      const { rows: t } = await c.query(
        `SELECT COALESCE(SUM((qty_received + qty_damaged) * COALESCE(unit_cost, 0)), 0) * $2::numeric AS goods FROM receipt_lines WHERE receipt_id = $1`, [id, n(r.fx_rate) || 1]);
      const party = (r.supplier || 'Supplier').slice(0, 41);
      return { book: 'purchases', at: r.bill_confirmed_at, ref: r.supplier_invoice_number || r.receipt_number, memo: 'Supplier bill ' + (r.supplier_invoice_number || '') + ' · ' + party, residual: ch.acct('ppv'),
        lines: [{ a: ch.acct('grni'), amt: n(t[0].goods) }, { a: ch.acct('ap'), amt: -n(r.bill_amount_jmd), party, memo: r.supplier_invoice_number }] };
    },

    async po_invoice(c, ch, id) {
      const { rows } = await c.query(`SELECT po.*, s.name AS supplier FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id WHERE po.id = $1`, [id]);
      if (!rows.length) return null;
      const po = rows[0], party = (po.supplier || 'Supplier').slice(0, 41), amt = n(po.invoice_total_usd || po.total_usd);
      return { book: 'purchases', at: po.received_date || po.received_at || po.created_at, ref: po.po_number, memo: 'Purchase ' + po.po_number + ' · ' + party,
        lines: [{ a: ch.acct('grni'), amt }, { a: ch.acct('ap'), amt: -amt, party, memo: po.invoice_number }] };
    },

    async po_payment(c, ch, id) {
      const { rows } = await c.query(
        `SELECT p.*, to_char(p.paid_on, 'YYYY-MM-DD') AS paid_day, po.po_number, s.name AS supplier FROM purchase_order_payments p JOIN purchase_orders po ON po.id = p.po_id
           LEFT JOIN suppliers s ON s.id = po.supplier_id WHERE p.id = $1`, [id]);
      if (!rows.length) return null;
      const p = rows[0], party = (p.supplier || 'Supplier').slice(0, 41);
      return { book: 'purchases', at: p.paid_day ? p.paid_day + 'T12:00:00-05:00' : p.created_at, ref: p.reference || p.po_number, memo: 'Paid ' + party + ' · ' + p.po_number,
        lines: [{ a: ch.acct('ap'), amt: n(p.amount_usd), party }, { a: ch.mapped('pay_out_method', p.method, 'bank'), amt: -n(p.amount_usd), memo: p.method }] };
    },

    async till_open(c, ch, id) {
      const { rows } = await c.query(`SELECT t.*, ps.location_id FROM till_sessions t LEFT JOIN pos_stations ps ON ps.id = t.station_id WHERE t.id = $1`, [id]);
      if (!rows.length) return null;
      const t = rows[0];
      return { book: 'cash', at: t.opened_at, ref: 'Shift ' + t.id, cls: ch.locClass(t.location_id), memo: 'Drawer float out of the safe, shift ' + t.id,
        lines: [{ a: ch.acct('cash_drawers'), amt: n(t.opening_float) }, { a: ch.acct('cash_safe'), amt: -n(t.opening_float) }] };
    },

    async till_movement(c, ch, id) {
      const { rows } = await c.query(`SELECT m.*, ps.location_id FROM till_movements m LEFT JOIN till_sessions t ON t.id = m.session_id LEFT JOIN pos_stations ps ON ps.id = t.station_id WHERE m.id = $1`, [id]);
      if (!rows.length) return null;
      const m = rows[0], amt = n(m.amount);
      const pair = m.kind === 'drop' ? [ch.acct('cash_safe'), ch.acct('cash_drawers')]
        : m.kind === 'payout' ? [ch.mapped('till_payout', m.reason, 'petty_expense'), ch.acct('cash_drawers')]
        : m.kind === 'float_in' ? [ch.acct('cash_drawers'), ch.acct('cash_safe')] : null;
      if (!pair) return null;
      return { book: 'cash', at: m.created_at, ref: 'Shift ' + m.session_id, cls: ch.locClass(m.location_id), memo: { drop: 'Cash drop to safe', payout: 'Paid out of drawer', float_in: 'Float added' }[m.kind] + (m.reason ? ': ' + m.reason : ''),
        lines: [{ a: pair[0], amt }, { a: pair[1], amt: -amt }] };
    },

    // Shift closed: counted cash goes to the safe; the gap to what should have
    // been there is over/short. Leaves the drawer account at zero for the shift.
    async till_close(c, ch, id) {
      const { rows } = await c.query(`SELECT t.*, ps.location_id FROM till_sessions t LEFT JOIN pos_stations ps ON ps.id = t.station_id WHERE t.id = $1`, [id]);
      if (!rows.length) return null;
      const t = rows[0], counted = n(t.counted_cash), expected = t.expected_cash == null ? counted : n(t.expected_cash);
      return { book: 'cash', at: t.closed_at, ref: 'Shift ' + t.id, cls: ch.locClass(t.location_id), memo: 'Drawer closed, shift ' + t.id + (r2(counted - expected) ? ' (over/short ' + r2(counted - expected).toFixed(2) + ')' : ''),
        lines: [{ a: ch.acct('cash_safe'), amt: counted }, { a: ch.acct('cash_drawers'), amt: -expected }, { a: ch.acct('cash_over_short'), amt: expected - counted }] };
    },

    // Petty cash and drawer payouts (posaddons.js). Paid from a fund: Cr Petty
    // Cash; from a drawer session: Cr Cash Drawers. Dr the expense for the
    // category (or a drawer payout's reason) per Posting rules > payouts, a
    // staff advance to Staff Loans and Advances, and a drawer's top-up of a fund
    // (fund set, no category) to Petty Cash.
    async petty_payout(c, ch, id) {
      const { rows } = await c.query(`SELECT cp.*, cat.name AS category, f.name AS fund FROM cash_payouts cp
          LEFT JOIN petty_cash_categories cat ON cat.id = cp.category_id LEFT JOIN petty_cash_funds f ON f.id = cp.fund_id WHERE cp.id = $1`, [id]);
      if (!rows.length) return null;
      const p = rows[0], amt = n(p.amount_cents) / 100;
      const topUp = p.source_type === 'drawer' && p.fund_id && !p.category_id && !p.is_advance;
      const dr = topUp ? ch.acct('petty_cash') : p.is_advance ? ch.acct('staff_loans') : ch.mapped('till_payout', p.category || p.reason, 'petty_expense');
      const cr = p.source_type === 'fund' ? ch.acct('petty_cash') : ch.acct('cash_drawers');
      const who = String((p.is_advance ? p.advance_to : p.paid_to) || '').slice(0, 41) || null;
      const memo = topUp ? 'Petty cash top-up from the drawer' + (p.fund ? ' (' + p.fund + ')' : '')
        : (p.is_advance ? 'Staff advance' : 'Paid out of ' + (p.source_type === 'fund' ? 'petty cash' + (p.fund ? ' (' + p.fund + ')' : '') : 'the drawer')) + ': ' + (p.category ? p.category + ' - ' : '') + p.reason;
      return { book: 'cash', at: p.created_at, ref: 'Payout ' + p.id, memo, lines: [{ a: dr, amt, party: who }, { a: cr, amt: -amt }] };
    },
    async petty_payout_void(c, ch, id) {
      return reversal(c, 'petty_payout', id, `SELECT voided_at AS at, NULL AS void_reason FROM cash_payouts WHERE id = $1`);
    },
    // An advance settled with receipts instead of cash: Dr the expense, Cr Staff Loans.
    async petty_advance_expensed(c, ch, id) {
      const { rows } = await c.query(`SELECT cp.*, cat.name AS category FROM cash_payouts cp LEFT JOIN petty_cash_categories cat ON cat.id = cp.category_id WHERE cp.id = $1`, [id]);
      if (!rows.length) return null;
      const p = rows[0], amt = n(p.amount_cents) / 100, who = String(p.advance_to || '').slice(0, 41) || null;
      return { book: 'cash', at: p.advance_settled_at, ref: 'Payout ' + p.id, memo: 'Staff advance spent: ' + (p.category || '') + (p.advance_to ? ' (' + p.advance_to + ')' : ''),
        lines: [{ a: ch.mapped('till_payout', p.category, 'petty_expense'), amt }, { a: ch.acct('staff_loans'), amt: -amt, party: who }] };
    },
    // Money into or out of a fund that is not a payout: opening and bank top-ups
    // (Cr Bank), count differences (Cash Over and Short), advances repaid (Cr
    // Staff Loans). Transfers between funds stay inside Petty Cash; a drawer
    // top-up posts as its payout; a voided payout posts as its reversal.
    async petty_movement(c, ch, id) {
      const { rows } = await c.query(`SELECT m.*, f.name AS fund FROM petty_cash_movements m JOIN petty_cash_funds f ON f.id = m.fund_id WHERE m.id = $1`, [id]);
      if (!rows.length) return null;
      const m = rows[0], amt = n(m.delta_cents) / 100;
      const other = m.kind === 'opening' || m.kind === 'replenishment' ? ch.acct('bank')
        : m.kind === 'reconcile_adjust' ? ch.acct('cash_over_short') : m.kind === 'advance_repay' ? ch.acct('staff_loans') : null;
      if (!other) return null;
      const label = { opening: 'Petty cash opened', replenishment: 'Petty cash topped up from the bank', reconcile_adjust: 'Petty cash count difference', advance_repay: 'Staff advance repaid to petty cash' }[m.kind];
      return { book: 'cash', at: m.created_at, ref: m.fund.slice(0, 40), memo: label + ' (' + m.fund + ')' + (m.notes ? ': ' + m.notes : ''),
        lines: [{ a: ch.acct('petty_cash'), amt }, { a: other, amt: -amt }] };
    },
    // A winning redeemable paid out of the drawer comes off the operator's money.
    async redemption_payout(c, ch, id) {
      const { rows } = await c.query(`SELECT * FROM redemption_instruments WHERE id = $1`, [id]);
      if (!rows.length) return null;
      const r = rows[0], amt = n(r.payout_cents) / 100;
      return { book: 'cash', at: r.redeemed_at, ref: r.code, memo: 'Redeemable paid out: ' + r.code,
        lines: [{ a: ch.acct('redeemables_payable'), amt }, { a: ch.acct('cash_drawers'), amt: -amt }] };
    },

    async gift_card(c, ch, id) {
      const { rows } = await c.query(`SELECT t.*, g.code FROM gift_card_transactions t JOIN gift_cards g ON g.id = t.gift_card_id WHERE t.id = $1`, [id]);
      if (!rows.length) return null;
      const t = rows[0];
      return { book: 'sales', at: t.created_at, ref: t.code, memo: 'Gift card ' + t.reason + ' (taken as cash at the counter)',
        lines: [{ a: ch.mapped('pay_method', 'gift_card_issue', 'cash_drawers'), amt: n(t.delta_usd) }, { a: ch.acct('gift_cards'), amt: -n(t.delta_usd) }] };
    },

    async commission(c, ch, id) {
      const { rows } = await c.query(`SELECT cp.*, m.name FROM commission_payouts cp LEFT JOIN mechanics m ON m.id = cp.mechanic_id WHERE cp.id = $1`, [id]);
      if (!rows.length) return null;
      const p = rows[0];
      // A payout against an approved statement clears Commissions Payable (the
      // statement accrued it); an old-style payout goes straight to expense.
      return { book: 'cash', at: p.created_at, ref: 'Commission ' + p.id, memo: 'Commission paid' + (p.name ? ' to ' + p.name : ''),
        lines: [{ a: p.statement_id ? ch.acct('commissions_payable') : ch.acct('commissions'), amt: n(p.amount_usd), memo: p.name },
                { a: ch.mapped('pay_out_method', 'commission', 'cash_safe'), amt: -n(p.amount_usd) }] };
    },

    // Statement approved: the commission is an expense now and owed to the rep.
    async commission_accrual(c, ch, id) {
      const { rows } = await c.query(`SELECT cs.*, m.name FROM commission_statements cs JOIN mechanics m ON m.id = cs.rep_id WHERE cs.id = $1`, [id]);
      if (!rows.length) return null;
      const st = rows[0];
      return { book: 'cash', at: st.approved_at, ref: st.number, memo: 'Commission approved for ' + st.name + ' (' + st.number + ')',
        lines: [{ a: ch.acct('commissions'), amt: n(st.total), memo: st.name }, { a: ch.acct('commissions_payable'), amt: -n(st.total), memo: st.number }] };
    },

    // Expense bill (Dr the coded accounts and GCT recoverable, Cr Accounts Payable) or vendor credit (the reverse).
    async ap_bill(c, ch, id) {
      const { rows } = await c.query(`SELECT b.*, to_char(b.bill_date, 'YYYY-MM-DD') AS day, s.name AS supplier FROM ap_bills b JOIN suppliers s ON s.id = b.supplier_id WHERE b.id = $1`, [id]);
      if (!rows.length) return null;
      const b = rows[0], party = (b.supplier || 'Supplier').slice(0, 41), sign = b.kind === 'credit' ? -1 : 1;
      const { rows: ls } = await c.query(`SELECT account_id, amount, description, class_id FROM ap_bill_lines WHERE bill_id = $1 ORDER BY id`, [id]);
      const lines = ls.map((l) => ({ a: l.account_id, amt: sign * n(l.amount), memo: l.description, party, cls: l.class_id }));
      if (n(b.gct_amount)) lines.push({ a: ch.acct('gct_input'), amt: sign * n(b.gct_amount), memo: 'GCT' });
      lines.push({ a: ch.acct('ap'), amt: -sign * n(b.total), party, memo: b.number });
      return { book: 'purchases', at: b.day + 'T12:00:00-05:00', ref: b.number || ((b.kind === 'credit' ? 'Credit ' : 'Bill ') + b.id), memo: (b.kind === 'credit' ? 'Supplier credit ' : 'Supplier bill ') + (b.number || '') + ' · ' + party, lines };
    },
    // Bills paid: Dr Accounts Payable, Cr the bank / cash account paid from.
    async ap_payment(c, ch, id) {
      const { rows } = await c.query(`SELECT p.*, to_char(p.pay_date, 'YYYY-MM-DD') AS day, s.name AS supplier FROM ap_payments p JOIN suppliers s ON s.id = p.supplier_id WHERE p.id = $1`, [id]);
      if (!rows.length || !(n(rows[0].amount) > 0)) return null;
      const p = rows[0], party = (p.supplier || 'Supplier').slice(0, 41);
      return { book: 'purchases', at: p.day + 'T12:00:00-05:00', ref: p.cheque_number ? 'Chq ' + p.cheque_number : (p.reference || 'Payment ' + p.id), memo: 'Bill payment · ' + party,
        lines: [{ a: ch.acct('ap'), amt: n(p.amount), party }, { a: p.account_id, amt: -n(p.amount), party, memo: p.method + (p.cheque_number ? ' ' + p.cheque_number : '') }] };
    },
    // Banking: spend money / cheque (Dr lines, Cr bank), receive money and deposits (Dr bank, Cr lines), transfers (Dr the other account, Cr bank).
    async bank_txn(c, ch, id) {
      const { rows } = await c.query(`SELECT t.*, to_char(t.txn_date, 'YYYY-MM-DD') AS day FROM bank_txns t WHERE t.id = $1`, [id]);
      if (!rows.length) return null;
      const t = rows[0], payee = t.payee ? String(t.payee).slice(0, 41) : null;
      const { rows: ls } = await c.query(`SELECT account_id, amount, memo, class_id FROM bank_txn_lines WHERE txn_id = $1 ORDER BY id`, [id]);
      const out = t.kind === 'deposit' ? 1 : -1;   // the bank side: + money in, - money out
      const lines = [{ a: t.account_id, amt: out * n(t.amount), party: payee, memo: t.cheque_number ? 'Chq ' + t.cheque_number : t.memo }]
        .concat(ls.map((l) => ({ a: l.account_id, amt: -out * n(l.amount), party: payee, memo: l.memo, cls: l.class_id })));
      const what = { expense: 'Payment', deposit: 'Deposit', transfer: 'Transfer' }[t.kind] || t.kind;
      return { book: 'cash', at: t.day + 'T12:00:00-05:00', ref: t.cheque_number ? 'Chq ' + t.cheque_number : (t.reference || what + ' ' + t.id), memo: what + (payee ? ' · ' + payee : '') + (t.memo ? ' · ' + t.memo : ''), lines };
    },
    // Receivables invoice raised on the books, not at the till (rent, recharges,
    // late fees -- billing.js): Dr A/R with the customer as party; Cr each line's
    // income account (Rental Income, Late Fee Income, ...); Cr GCT Payable.
    async ar_invoice(c, ch, id) {
      const { rows } = await c.query(`SELECT i.*, to_char(i.invoice_date, 'YYYY-MM-DD') AS day, u.name FROM ar_invoices i LEFT JOIN users u ON u.id = i.customer_id WHERE i.id = $1`, [id]);
      if (!rows.length) return null;
      const i = rows[0], party = custParty(i.name, i.customer_id);
      const { rows: ls } = await c.query(`SELECT account_id, amount, description, class_id FROM ar_invoice_lines WHERE invoice_id = $1 ORDER BY id`, [id]);
      const lines = [{ a: ch.acct('ar'), amt: n(i.total), party, memo: i.number }]
        .concat(ls.map((l) => ({ a: l.account_id, amt: -n(l.amount), memo: l.description, party, cls: l.class_id })));
      if (n(i.gct_amount)) lines.push({ a: ch.acct('gct'), amt: -n(i.gct_amount), memo: 'GCT' });
      return { book: 'sales', at: i.day + 'T12:00:00-05:00', ref: i.number, memo: (i.kind === 'late_fee' ? 'Late fee ' : 'Invoice ') + i.number + ' · ' + party, lines };
    },
    // A void: the original entry reversed, dated when it was voided.
    async ar_invoice_void(c, ch, id) { return reversal(c, 'ar_invoice', id, `SELECT voided_at AS at, void_reason FROM ar_invoices WHERE id = $1`); },
    async account_payment_void(c, ch, id) { return reversal(c, 'account_payment', id, `SELECT voided_at AS at, void_reason FROM account_payments_all WHERE id = $1`); },
    async ap_bill_void(c, ch, id) { return reversal(c, 'ap_bill', id, `SELECT voided_at AS at, void_reason FROM ap_bills WHERE id = $1`); },
    async ap_payment_void(c, ch, id) { return reversal(c, 'ap_payment', id, `SELECT voided_at AS at, void_reason FROM ap_payments WHERE id = $1`); },
    async bank_txn_void(c, ch, id) { return reversal(c, 'bank_txn', id, `SELECT voided_at AS at, void_reason FROM bank_txns WHERE id = $1`); },

    // Payroll run approved (payroll.js): Dr wages / commission payable / the
    // earning's account, Dr employer contributions; Cr each statutory payable,
    // pension and other deductions, and net wages owed to each person.
    async payroll_run(c, ch, id) {
      const { rows } = await c.query(`SELECT r.*, to_char(r.pay_date, 'YYYY-MM-DD') AS day FROM payroll_runs r WHERE r.id = $1`, [id]);
      if (!rows.length) return null;
      const r = rows[0];
      const { rows: items } = await c.query(`SELECT code, gl_account_id FROM payroll_items`);
      const acctOf = {}; for (const i of items) acctOf[i.code] = i.gl_account_id;
      const { rows: slips } = await c.query(`SELECT * FROM payroll_slips WHERE run_id = $1`, [id]);
      const lines = [], sum = (k) => slips.reduce((t, s) => t + n(s[k]), 0);
      for (const s of slips) {
        const who = String((s.snapshot && s.snapshot.name) || 'Employee').slice(0, 41);
        for (const l of s.lines || []) {
          const contractor = s.snapshot && s.snapshot.worker_type === 'contractor';
          if (l.kind === 'employer') {
            // Paid by the business for the person: an expense, owed to the insurer / scheme until paid over.
            const pension = /^er_pension/.test(l.code);
            lines.push({ a: acctOf[l.code] || (pension ? ch.acct('pension_expense') : ch.acct('benefits_expense')), amt: n(l.amount), party: who, memo: l.label });
            lines.push({ a: pension ? ch.acct('pension_payable') : ch.acct('payroll_deductions_payable'), amt: -n(l.amount), party: (l.payee || who).slice(0, 41), memo: l.label });
            continue;
          }
          // Already in the person's hand (cash tips kept): not the business's money, so no
          // wages for it; net pay already leaves it out, and the tax on it is posted below.
          if (l.kind === 'earning' && l.received) continue;
          if (l.kind === 'earning') lines.push({ a: acctOf[l.code] || (l.code === 'commission' ? ch.acct('commissions_payable') : contractor ? ch.acct('contract_labour') : ch.acct('wages')), amt: n(l.amount), party: who, memo: l.label });
          else lines.push({ a: acctOf[l.code] || ch.acct('payroll_deductions_payable'), amt: -n(l.amount), party: who, memo: l.label });
        }
        lines.push({ a: ch.acct('net_wages_payable'), amt: -n(s.net), party: who, memo: 'Net pay' });
      }
      lines.push({ a: ch.acct('payroll_taxes'), amt: sum('nis_er') + sum('nht_er') + sum('ed_er') + sum('heart_er'), memo: 'Employer NIS, NHT, Education Tax, HEART' });
      lines.push({ a: ch.acct('pension_expense'), amt: sum('pension_er'), memo: 'Employer pension' });
      lines.push({ a: ch.acct('paye_payable'), amt: -sum('paye'), memo: 'PAYE' });
      lines.push({ a: ch.acct('nis_payable'), amt: -(sum('nis_ee') + sum('nis_er')), memo: 'NIS' });
      lines.push({ a: ch.acct('nht_payable'), amt: -(sum('nht_ee') + sum('nht_er')), memo: 'NHT' });
      lines.push({ a: ch.acct('edtax_payable'), amt: -(sum('ed_ee') + sum('ed_er')), memo: 'Education Tax' });
      lines.push({ a: ch.acct('heart_payable'), amt: -sum('heart_er'), memo: 'HEART/NSTA' });
      lines.push({ a: ch.acct('pension_payable'), amt: -(sum('pension_ee') + sum('pension_er')), memo: 'Pension' });
      lines.push({ a: ch.acct('contractor_levy_payable'), amt: -sum('levy'), memo: 'Contractor levy' });
      lines.push({ a: ch.acct('wht_payable'), amt: -sum('wht'), memo: 'Withholding tax' });
      return { book: 'cash', at: r.day + 'T12:00:00-05:00', ref: r.number, memo: 'Payroll ' + r.number + ' (' + slips.length + ' people)', lines };
    },
    // Net wages paid: Dr Net Wages Payable, Cr the bank (a line per person, or one for the batch).
    async payroll_payment(c, ch, id) {
      const { rows } = await c.query(`SELECT p.*, to_char(p.pay_date, 'YYYY-MM-DD') AS day, r.number FROM payroll_payments p JOIN payroll_runs r ON r.id = p.run_id WHERE p.id = $1`, [id]);
      if (!rows.length) return null;
      const p = rows[0];
      const { rows: slips } = await c.query(`SELECT snapshot, net, cheque_number FROM payroll_slips WHERE run_id = $1 AND net <> 0`, [p.run_id]);
      const lines = [];
      for (const s of slips) {
        const who = String((s.snapshot && s.snapshot.name) || 'Employee').slice(0, 41);
        lines.push({ a: ch.acct('net_wages_payable'), amt: n(s.net), party: who });
        if (p.per_person) lines.push({ a: p.account_id, amt: -n(s.net), party: who, memo: s.cheque_number ? 'Chq ' + s.cheque_number : 'Wages ' + p.number });
      }
      if (!p.per_person) lines.push({ a: p.account_id, amt: -n(p.amount), memo: 'Wages ' + p.number + (p.reference ? ' · ' + p.reference : '') });
      return { book: 'cash', at: p.day + 'T12:00:00-05:00', ref: p.reference || p.number, memo: 'Wages paid · ' + p.number, lines };
    },
    // Statutory deductions paid to TAJ (and the pension scheme).
    async payroll_remit(c, ch, id) {
      const { rows } = await c.query(`SELECT r.*, to_char(r.pay_date, 'YYYY-MM-DD') AS day, to_char(r.month, 'YYYY-MM') AS m FROM payroll_remittances r WHERE r.id = $1`, [id]);
      if (!rows.length) return null;
      const r = rows[0];
      return { book: 'cash', at: r.day + 'T12:00:00-05:00', ref: r.reference || 'S01 ' + r.m, memo: 'Payroll deductions paid for ' + r.m,
        lines: [{ a: ch.acct('paye_payable'), amt: n(r.paye), memo: 'PAYE' }, { a: ch.acct('nis_payable'), amt: n(r.nis), memo: 'NIS' }, { a: ch.acct('nht_payable'), amt: n(r.nht), memo: 'NHT' },
          { a: ch.acct('edtax_payable'), amt: n(r.ed), memo: 'Education Tax' }, { a: ch.acct('heart_payable'), amt: n(r.heart), memo: 'HEART/NSTA' }, { a: ch.acct('pension_payable'), amt: n(r.pension), memo: 'Pension' },
          { a: ch.acct('contractor_levy_payable'), amt: n(r.levy), memo: 'Contractor levy' }, { a: ch.acct('wht_payable'), amt: n(r.wht), memo: 'Withholding tax' },
          { a: r.account_id, amt: -n(r.total), party: 'Tax Administration Jamaica', memo: 'S01 ' + r.m }] };
    },
    // A loan or salary advance handed out from the bank / cash (Dr Staff Loans, Cr the account).
    async payroll_loan(c, ch, id) {
      const { rows } = await c.query(`SELECT l.*, to_char(l.issue_date, 'YYYY-MM-DD') AS day, e.name FROM payroll_loans l JOIN payroll_employees e ON e.id = l.employee_id WHERE l.id = $1`, [id]);
      if (!rows.length || rows[0].method !== 'bank') return null;
      const l = rows[0], who = String(l.name).slice(0, 41);
      return { book: 'cash', at: l.day + 'T12:00:00-05:00', ref: l.reference || (l.kind === 'loan' ? 'Loan ' : 'Advance ') + l.id, memo: (l.kind === 'loan' ? 'Staff loan to ' : 'Salary advance to ') + who,
        lines: [{ a: ch.acct('staff_loans'), amt: n(l.amount), party: who }, { a: l.account_id, amt: -n(l.amount), party: who }] };
    },
    // Deductions held for someone else paid over to them (insurer, union, court, NHT, SLB...).
    async payroll_dedpay(c, ch, id) {
      const { rows } = await c.query(`SELECT p.*, to_char(p.pay_date, 'YYYY-MM-DD') AS day, to_char(p.month, 'YYYY-MM') AS m, i.gl_account_id, i.label, i.kind FROM payroll_ded_payments p JOIN payroll_items i ON i.code = p.code WHERE p.id = $1`, [id]);
      if (!rows.length) return null;
      const p = rows[0], who = String(p.payee).slice(0, 41);
      // An employer contribution was owed in Pension / Deductions Payable (its own account is the expense).
      const owedIn = p.kind === 'employer' ? (/^er_pension/.test(p.code) ? ch.acct('pension_payable') : ch.acct('payroll_deductions_payable')) : (p.gl_account_id || ch.acct('payroll_deductions_payable'));
      return { book: 'cash', at: p.day + 'T12:00:00-05:00', ref: p.reference || p.label + ' ' + p.m, memo: p.label + (p.kind === 'employer' ? ' for ' : ' deducted in ') + p.m + ' paid to ' + who,
        lines: [{ a: owedIn, amt: n(p.amount), party: who }, { a: p.account_id, amt: -n(p.amount), party: who }] };
    },
    async payroll_loan_void(c, ch, id) { return reversal(c, 'payroll_loan', id, `SELECT voided_at AS at, void_reason FROM payroll_loans WHERE id = $1`); },
    async payroll_dedpay_void(c, ch, id) { return reversal(c, 'payroll_dedpay', id, `SELECT voided_at AS at, void_reason FROM payroll_ded_payments WHERE id = $1`); },
    async payroll_run_void(c, ch, id) { return reversal(c, 'payroll_run', id, `SELECT voided_at AS at, void_reason FROM payroll_runs WHERE id = $1`); },
    async payroll_payment_void(c, ch, id) { return reversal(c, 'payroll_payment', id, `SELECT voided_at AS at, void_reason FROM payroll_payments WHERE id = $1`); },
    async payroll_remit_void(c, ch, id) { return reversal(c, 'payroll_remit', id, `SELECT voided_at AS at, void_reason FROM payroll_remittances WHERE id = $1`); },

    // A supplier claim settled: the stock left inventory into Supplier Claims
    // Receivable when it was claimed (stock ledger, reason vendor_claim). A credit
    // note clears it against what is owed to the supplier; any shortfall, or a
    // rejected claim, is a stock loss.
    async vendor_claim(c, ch, id) {
      const { rows } = await c.query(`SELECT d.*, s.name AS supplier FROM stock_dispositions d LEFT JOIN suppliers s ON s.id = d.supplier_id WHERE d.id = $1`, [id]);
      if (!rows.length) return null;
      const d = rows[0], value = r2(n(d.qty) * n(d.unit_cost)), credit = d.claim_status === 'credited' ? Math.min(r2(d.claim_amount), value) : 0;
      const lines = [{ a: ch.acct('supplier_claims'), amt: -value, memo: d.product_img + ' x' + d.qty }];
      if (credit) lines.push({ a: ch.acct('ap'), amt: credit, memo: 'Credit from ' + (d.supplier || 'supplier') });
      if (value - credit) lines.push({ a: ch.acct('inv_adjust'), amt: r2(value - credit), memo: d.claim_status === 'credited' ? 'Credit short of cost' : 'Claim rejected' });
      return { book: 'stock', at: d.resolved_at, ref: 'Claim ' + d.id, memo: 'Supplier claim ' + d.claim_status + ': ' + d.product_img + (d.supplier ? ' (' + d.supplier + ')' : ''), lines };
    },
  };

  async function reversal(c, kind, id, sql) {
    const { rows: e } = await c.query(`SELECT id, number, source_ref, memo FROM gl_entries WHERE source_kind = $1 AND source_id = $2`, [kind, id]);
    if (!e.length) return null;
    const { rows: v } = await c.query(sql, [id]);
    const { rows: ls } = await c.query(`SELECT account_id, amount, party, memo, class_id FROM gl_lines WHERE entry_id = $1`, [e[0].id]);
    return { book: 'cash', at: v[0].at, ref: e[0].source_ref, reverses: e[0].id, reversesAll: [e[0].id], memo: 'VOID of ' + e[0].number + ' (' + (e[0].memo || '') + ')' + (v[0].void_reason ? ' - ' + v[0].void_reason : ''),
      lines: ls.map((l) => ({ a: l.account_id, amt: -n(l.amount), party: l.party, memo: l.memo, cls: l.class_id })) };
  }

  // What is waiting to be posted, per source, from the ledger start.
  function pendingSql(kind) {
    const notPosted = (k, col) => `NOT EXISTS (SELECT 1 FROM gl_entries e WHERE e.source_kind = '${k}' AND e.source_id = ${col})`;
    switch (kind) {
      case 'sale': return `SELECT s.id FROM pos_sales s WHERE s.created_at >= $1 AND NOT COALESCE(s.voided, false) AND ${notPosted('sale', 's.id')}`;
      case 'sale_payment': return `SELECT p.id FROM sale_payments p JOIN pos_sales s ON s.id = p.sale_id
          WHERE p.created_at >= $1 AND p.amount_usd <> 0 AND lower(p.method) <> ALL(ARRAY['${SKIP_PAY.join("','")}'])
            AND NOT COALESCE(s.voided, false) AND ${notPosted('sale_payment', 'p.id')}`;
      case 'sale_void': return `SELECT s.id FROM pos_sales s WHERE COALESCE(s.voided, false) AND s.created_at >= $1
            AND EXISTS (SELECT 1 FROM gl_entries e WHERE e.source_kind = 'sale' AND e.source_id = s.id) AND ${notPosted('sale_void', 's.id')}`;
      case 'return': return `SELECT r.id FROM pos_sale_returns r WHERE r.created_at >= $1 AND ${notPosted('return', 'r.id')}`;
      case 'account_payment': return `SELECT a.id FROM account_payments a WHERE a.created_at >= $1 AND ${notPosted('account_payment', 'a.id')}`;
      case 'receipt': return `SELECT r.id FROM receipts r WHERE r.status = 'posted' AND r.posted_at >= $1 AND ${notPosted('receipt', 'r.id')}`;
      case 'bill': return `SELECT r.id FROM receipts r WHERE r.bill_status = 'confirmed' AND r.bill_confirmed_at >= $1 AND r.status = 'posted' AND ${notPosted('bill', 'r.id')}`;
      case 'po_invoice': return `SELECT po.id FROM purchase_orders po WHERE COALESCE(po.invoice_total_usd, 0) > 0 AND COALESCE(po.received_date, po.received_at, po.created_at) >= $1
            AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.po_id = po.id) AND ${notPosted('po_invoice', 'po.id')}`;
      case 'po_payment': return `SELECT p.id FROM purchase_order_payments p WHERE p.created_at >= $1 AND ${notPosted('po_payment', 'p.id')}`;
      case 'till_open': return `SELECT t.id FROM till_sessions t WHERE t.opened_at >= $1 AND t.opening_float > 0 AND ${notPosted('till_open', 't.id')}`;
      case 'till_movement': return `SELECT m.id FROM till_movements m WHERE m.created_at >= $1 AND m.kind IN ('drop', 'payout', 'float_in') AND m.amount > 0 AND ${notPosted('till_movement', 'm.id')}`;
      case 'till_close': return `SELECT t.id FROM till_sessions t WHERE t.status = 'closed' AND t.closed_at >= $1 AND t.opened_at >= $1 AND ${notPosted('till_close', 't.id')}`;
      case 'petty_payout': return `SELECT p.id FROM cash_payouts p WHERE p.created_at >= $1 AND NOT p.voided AND p.amount_cents > 0 AND ${notPosted('petty_payout', 'p.id')}`;
      case 'petty_payout_void': return `SELECT p.id FROM cash_payouts p WHERE p.voided AND p.voided_at >= $1
            AND EXISTS (SELECT 1 FROM gl_entries g WHERE g.source_kind = 'petty_payout' AND g.source_id = p.id) AND ${notPosted('petty_payout_void', 'p.id')}`;
      case 'petty_advance_expensed': return `SELECT p.id FROM cash_payouts p WHERE p.is_advance AND p.advance_status = 'expensed' AND NOT p.voided AND p.advance_settled_at >= $1
            AND ${notPosted('petty_advance_expensed', 'p.id')}`;
      case 'petty_movement': return `SELECT m.id FROM petty_cash_movements m WHERE m.created_at >= $1 AND m.delta_cents <> 0
            AND (m.kind IN ('opening', 'reconcile_adjust', 'advance_repay') OR (m.kind = 'replenishment' AND COALESCE(m.source, 'bank') <> 'drawer'))
            AND ${notPosted('petty_movement', 'm.id')}`;
      case 'redemption_payout': return `SELECT r.id FROM redemption_instruments r WHERE r.status = 'redeemed' AND r.payout_cents > 0 AND r.redeemed_at >= $1 AND ${notPosted('redemption_payout', 'r.id')}`;
      case 'gift_card': return `SELECT t.id FROM gift_card_transactions t WHERE t.created_at >= $1 AND t.reason IN ('issue', 'reload') AND t.reference IS NULL AND t.delta_usd > 0 AND ${notPosted('gift_card', 't.id')}`;
      case 'commission': return `SELECT p.id FROM commission_payouts p WHERE p.created_at >= $1
            AND (p.statement_id IS NULL OR EXISTS (SELECT 1 FROM gl_entries e WHERE e.source_kind = 'commission_accrual' AND e.source_id = p.statement_id))
            AND ${notPosted('commission', 'p.id')}`;
      case 'commission_accrual': return `SELECT cs.id FROM commission_statements cs WHERE cs.status IN ('approved', 'paid') AND cs.approved_at >= $1 AND ${notPosted('commission_accrual', 'cs.id')}`;
      case 'ar_invoice': return `SELECT i.id FROM ar_invoices i WHERE i.voided_at IS NULL AND i.created_at >= $1 AND ${notPosted('ar_invoice', 'i.id')}`;
      case 'ar_invoice_void': return `SELECT i.id FROM ar_invoices i WHERE i.voided_at IS NOT NULL AND i.voided_at >= $1 AND EXISTS (SELECT 1 FROM gl_entries g WHERE g.source_kind = 'ar_invoice' AND g.source_id = i.id) AND ${notPosted('ar_invoice_void', 'i.id')}`;
      case 'ap_bill': return `SELECT b.id FROM ap_bills b WHERE b.voided_at IS NULL AND b.created_at >= $1 AND ${notPosted('ap_bill', 'b.id')}`;
      case 'ap_payment': return `SELECT p.id FROM ap_payments p WHERE p.voided_at IS NULL AND p.amount > 0 AND p.created_at >= $1 AND ${notPosted('ap_payment', 'p.id')}`;
      case 'bank_txn': return `SELECT t.id FROM bank_txns t WHERE t.voided_at IS NULL AND t.created_at >= $1 AND ${notPosted('bank_txn', 't.id')}`;
      case 'account_payment_void': return `SELECT a.id FROM account_payments_all a WHERE a.voided_at IS NOT NULL AND a.voided_at >= $1 AND EXISTS (SELECT 1 FROM gl_entries g WHERE g.source_kind = 'account_payment' AND g.source_id = a.id) AND ${notPosted('account_payment_void', 'a.id')}`;
      case 'ap_bill_void': return `SELECT b.id FROM ap_bills b WHERE b.voided_at IS NOT NULL AND b.voided_at >= $1 AND EXISTS (SELECT 1 FROM gl_entries g WHERE g.source_kind = 'ap_bill' AND g.source_id = b.id) AND ${notPosted('ap_bill_void', 'b.id')}`;
      case 'ap_payment_void': return `SELECT p.id FROM ap_payments p WHERE p.voided_at IS NOT NULL AND p.voided_at >= $1 AND EXISTS (SELECT 1 FROM gl_entries g WHERE g.source_kind = 'ap_payment' AND g.source_id = p.id) AND ${notPosted('ap_payment_void', 'p.id')}`;
      case 'bank_txn_void': return `SELECT t.id FROM bank_txns t WHERE t.voided_at IS NOT NULL AND t.voided_at >= $1 AND EXISTS (SELECT 1 FROM gl_entries g WHERE g.source_kind = 'bank_txn' AND g.source_id = t.id) AND ${notPosted('bank_txn_void', 't.id')}`;
      case 'vendor_claim': return `SELECT d.id FROM stock_dispositions d WHERE d.kind = 'vendor_claim' AND d.claim_status IN ('credited', 'rejected') AND d.resolved_at >= $1 AND ${notPosted('vendor_claim', 'd.id')}`;
      // Payroll (an optional module): only runs approved with ledger posting on.
      case 'payroll_run': return `SELECT r.id FROM payroll_runs r WHERE r.post_gl AND r.approved_at IS NOT NULL AND r.approved_at >= $1 AND ${notPosted('payroll_run', 'r.id')}`;
      case 'payroll_payment': return `SELECT p.id FROM payroll_payments p WHERE p.voided_at IS NULL AND p.post_gl AND p.created_at >= $1
            AND EXISTS (SELECT 1 FROM gl_entries g WHERE g.source_kind = 'payroll_run' AND g.source_id = p.run_id) AND ${notPosted('payroll_payment', 'p.id')}`;
      case 'payroll_remit': return `SELECT r.id FROM payroll_remittances r WHERE r.voided_at IS NULL AND r.post_gl AND r.created_at >= $1 AND ${notPosted('payroll_remit', 'r.id')}`;
      case 'payroll_run_void': return `SELECT r.id FROM payroll_runs r WHERE r.voided_at IS NOT NULL AND r.voided_at >= $1 AND EXISTS (SELECT 1 FROM gl_entries g WHERE g.source_kind = 'payroll_run' AND g.source_id = r.id) AND ${notPosted('payroll_run_void', 'r.id')}`;
      case 'payroll_payment_void': return `SELECT p.id FROM payroll_payments p WHERE p.voided_at IS NOT NULL AND p.voided_at >= $1 AND EXISTS (SELECT 1 FROM gl_entries g WHERE g.source_kind = 'payroll_payment' AND g.source_id = p.id) AND ${notPosted('payroll_payment_void', 'p.id')}`;
      case 'payroll_loan': return `SELECT l.id FROM payroll_loans l WHERE l.method = 'bank' AND l.voided_at IS NULL AND l.post_gl AND l.created_at >= $1 AND ${notPosted('payroll_loan', 'l.id')}`;
      case 'payroll_dedpay': return `SELECT p.id FROM payroll_ded_payments p WHERE p.voided_at IS NULL AND p.post_gl AND p.created_at >= $1 AND ${notPosted('payroll_dedpay', 'p.id')}`;
      case 'payroll_loan_void': return `SELECT l.id FROM payroll_loans l WHERE l.voided_at IS NOT NULL AND l.voided_at >= $1 AND EXISTS (SELECT 1 FROM gl_entries g WHERE g.source_kind = 'payroll_loan' AND g.source_id = l.id) AND ${notPosted('payroll_loan_void', 'l.id')}`;
      case 'payroll_dedpay_void': return `SELECT p.id FROM payroll_ded_payments p WHERE p.voided_at IS NOT NULL AND p.voided_at >= $1 AND EXISTS (SELECT 1 FROM gl_entries g WHERE g.source_kind = 'payroll_dedpay' AND g.source_id = p.id) AND ${notPosted('payroll_dedpay_void', 'p.id')}`;
      case 'payroll_remit_void': return `SELECT r.id FROM payroll_remittances r WHERE r.voided_at IS NOT NULL AND r.voided_at >= $1 AND EXISTS (SELECT 1 FROM gl_entries g WHERE g.source_kind = 'payroll_remit' AND g.source_id = r.id) AND ${notPosted('payroll_remit_void', 'r.id')}`;
    }
    return null;
  }
  const ORDER = ['sale', 'sale_payment', 'sale_void', 'return', 'account_payment', 'receipt', 'bill', 'po_invoice', 'po_payment', 'till_open', 'till_movement', 'till_close', 'petty_payout', 'petty_advance_expensed', 'petty_movement', 'redemption_payout', 'gift_card', 'commission_accrual', 'commission', 'vendor_claim', 'ar_invoice', 'ap_bill', 'ap_payment', 'bank_txn',
    'payroll_loan', 'payroll_run', 'payroll_payment', 'payroll_remit', 'payroll_dedpay', 'account_payment_void', 'ar_invoice_void', 'ap_bill_void', 'ap_payment_void', 'bank_txn_void',
    'payroll_payment_void', 'payroll_run_void', 'payroll_remit_void', 'payroll_dedpay_void', 'payroll_loan_void', 'petty_payout_void'];

  // Daily stock adjustments from the stock ledger (complete days only).
  async function postStockDays(startAt, ch, userId) {
    const last = await setting('gl_stock_day_done', null);
    const { rows: days } = await query(
      `SELECT to_char(d, 'YYYY-MM-DD') AS d FROM generate_series(
          GREATEST(COALESCE($2::date + 1, ($1::timestamptz AT TIME ZONE '${TZ}')::date), ($1::timestamptz AT TIME ZONE '${TZ}')::date),
          (NOW() AT TIME ZONE '${TZ}')::date - 1, '1 day') d`, [startAt, last]);
    let posted = 0;
    for (const { d } of days) {
      await tx(async (c) => {
        const { rows } = await c.query(
          `SELECT COALESCE(reason, 'other') AS reason, SUM(delta * COALESCE(unit_cost, 0)) AS value, SUM(delta)::int AS units, COUNT(*)::int AS changes
             FROM stock_ledger
            WHERE created_at >= ($1::date)::timestamp AT TIME ZONE '${TZ}' AND created_at < ($1::date + 1)::timestamp AT TIME ZONE '${TZ}'
              AND created_at >= $2 AND COALESCE(reason, 'other') NOT IN ('sale', 'return', 'receipt')
            GROUP BY 1`, [d, startAt]);
        const lines = [];
        for (const r of rows) {
          const v = r2(r.value);
          if (!v) continue;
          lines.push({ a: ch.acct('inventory'), amt: v, memo: r.reason + ': ' + r.units + ' units in ' + r.changes + ' changes' });
          lines.push({ a: ch.mapped('stock_reason', r.reason, 'inv_adjust'), amt: -v, memo: r.reason });
        }
        if (lines.length && await insertEntry(c, ch, { book: 'stock', kind: 'stock_day', id: Number(d.replace(/-/g, '')), at: d + 'T12:00:00-05:00', ref: d,
          memo: 'Stock adjustments ' + d + ' (counts, workshop parts, edits)', lines, userId })) posted++;
        await putSetting('gl_stock_day_done', d, c.query.bind(c));
      });
    }
    return posted;
  }

  // Post everything waiting. One document per transaction, so one bad
  // document never holds up the rest; its error is kept for the status page.
  let running = false, lastRun = null;
  const errors = new Map();   // "kind:id" -> message
  async function postAll(userId) {
    if (running) return { busy: true };
    running = true;
    const out = { posted: 0, failed: 0, by: {} };
    try {
      const start = await setting('gl_start_at', null);
      if (!start) return { not_started: true };
      const ch = await chart(query);
      for (const kind of ORDER) {
        const { rows } = await query(pendingSql(kind) + ' ORDER BY 1 LIMIT 2000', [start]);
        for (const { id } of rows) {
          const key = kind + ':' + id;
          try {
            await tx(async (c) => {
              const e = await POSTERS[kind](c, ch, id);
              if (!e) return;
              const newId = await insertEntry(c, ch, Object.assign({ kind, id, userId }, e));
              if (newId && e.reversesAll) await c.query(`UPDATE gl_entries SET reversed_by = $1 WHERE id = ANY($2::bigint[]) AND reversed_by IS NULL`, [newId, e.reversesAll]);
              if (newId) { out.posted++; out.by[kind] = (out.by[kind] || 0) + 1; }
            });
            errors.delete(key);
          } catch (err) {
            out.failed++;
            errors.set(key, String(err.message || err).slice(0, 300));
            if (errors.size > 200) errors.delete(errors.keys().next().value);
          }
        }
      }
      const sd = await postStockDays(start, ch, userId);
      if (sd) { out.posted += sd; out.by.stock_day = sd; }
    } finally { running = false; lastRun = { at: new Date().toISOString(), ...out }; }
    return out;
  }
  const timer = setInterval(async () => {
    try { if ((await setting('gl_auto_post', 'on')) === 'on') await postAll(null); } catch (e) { console.warn('[gl] auto post', e.message); }
  }, 60000);
  if (timer.unref) timer.unref();

  // ------------------------------------------------------------- setup --
  app.get('/api/gl/status', ...can('acct.view'), async (req, res) => {
    try {
      const start = await setting('gl_start_at', null);
      const pending = {};
      if (start) for (const k of ORDER) { const { rows } = await query(`SELECT COUNT(*)::int AS n FROM (${pendingSql(k)}) x`, [start]); if (rows[0].n) pending[k] = rows[0].n; }
      const { rows: c } = await query(`SELECT COUNT(*)::int AS entries, to_char(MAX(entry_date), 'YYYY-MM-DD') AS last_date FROM gl_entries`);
      const { rows: sus } = await query(`SELECT COALESCE(SUM(l.amount), 0) AS bal FROM gl_lines l JOIN gl_accounts a ON a.id = l.account_id WHERE a.system_key = 'suspense'`);
      const { rows: unnamed } = await query(`SELECT COUNT(*)::int AS n FROM gl_accounts WHERE is_active AND (qb_name IS NULL OR qb_name = '')`);
      const { rows: closed } = await query(`SELECT to_char(month, 'YYYY-MM') AS month, closed_at FROM gl_periods ORDER BY month DESC LIMIT 24`);
      res.json({ started: !!start, start_at: start, start_date: start ? (await query(`SELECT to_char(($1::timestamptz AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS d`, [start])).rows[0].d : null,
        auto_post: (await setting('gl_auto_post', 'on')) === 'on', pending, entries: c[0].entries, last_date: c[0].last_date, last_run: lastRun,
        errors: [...errors.entries()].slice(-30).map(([k, m]) => ({ source: k, error: m })), suspense: r2(sus[0].bal), accounts_without_qb_name: unnamed[0].n,
        closed, stock_days_done: await setting('gl_stock_day_done', null) });
    } catch (e) { fail(res, e); }
  });

  // Start the ledger NOW, with an opening entry dated today built from the
  // system's own balances at this moment: stock at cost, what customers owe,
  // what is owed to suppliers, goods received but not billed, gift-card
  // balances. Everything after this moment posts as it happens. It cannot be
  // back-dated: the opening balances are today's, so documents between a past
  // date and now would be counted twice. Do it before opening or after closing.
  // Cash and bank are not known here: add them as a manual journal from the
  // bank statement and the safe count.
  app.post('/api/gl/setup', ...can('acct.setup'), async (req, res) => {
    try {
      if (await setting('gl_start_at', null)) throw httpError(409, 'The ledger has already started');
      const { rows: any } = await query(`SELECT COUNT(*)::int AS n FROM gl_entries`);
      if (any[0].n) throw httpError(409, 'There are already journal entries');
      const { rows: d } = await query(`SELECT to_char((NOW() AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS today`);
      const day = d[0].today;
      const out = await tx(async (c) => {
        const ch = await chart(c.query.bind(c));
        const { rows: st } = await c.query(`SELECT NOW() AS at, to_char((NOW() AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS eve, to_char((NOW() AT TIME ZONE '${TZ}')::date - 1, 'YYYY-MM-DD') AS yday`);
        const lines = [];
        const { rows: inv } = await c.query(`SELECT COALESCE(SUM(stock_count * COALESCE(cost_usd, 0)), 0) AS v FROM products WHERE stock_count > 0`);
        lines.push({ a: ch.acct('inventory'), amt: n(inv[0].v), memo: 'Stock on hand at cost' });
        const { rows: ar } = await c.query(
          `SELECT COALESCE(NULLIF(trim(customer_name), ''), 'Cash Sales') AS party, customer_id IS NOT NULL AS named, SUM(balance_due_usd) AS v FROM pos_sales
            WHERE NOT COALESCE(voided, false) AND COALESCE(balance_due_usd, 0) <> 0 AND created_at < $1 GROUP BY 1, 2`, [st[0].at]);
        for (const r of ar) lines.push({ a: ch.acct('ar'), amt: n(r.v), party: r.named ? custParty(r.party, 1) : 'Cash Sales', memo: 'Owed on sales' });
        // Payments on account are not allocated to sales: take them off by customer.
        const { rows: pa } = await c.query(
          `SELECT u.name AS party, SUM(a.amount_usd) AS v FROM account_payments a JOIN users u ON u.id = a.customer_id WHERE a.created_at < $1 GROUP BY 1`, [st[0].at]);
        for (const r of pa) lines.push({ a: ch.acct('ar'), amt: -n(r.v), party: custParty(r.party, 1), memo: 'Paid on account' });
        const { rows: ap } = await c.query(
          `SELECT COALESCE(s.name, 'Supplier') AS party, SUM(po.balance_due_usd) AS v FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id
            WHERE COALESCE(po.balance_due_usd, 0) > 0 AND po.status <> 'cancelled' GROUP BY 1`);
        for (const r of ap) lines.push({ a: ch.acct('ap'), amt: -n(r.v), party: r.party.slice(0, 41), memo: 'Owed to supplier' });
        const { rows: gr } = await c.query(
          `SELECT COALESCE(SUM((l.qty_received + l.qty_damaged) * COALESCE(l.unit_cost, 0) * COALESCE(r.fx_rate, 1)), 0) AS v
             FROM receipts r JOIN receipt_lines l ON l.receipt_id = r.id WHERE r.status = 'posted' AND r.bill_status <> 'confirmed'`);
        lines.push({ a: ch.acct('grni'), amt: -n(gr[0].v), memo: 'Received, not yet billed' });
        const { rows: gc } = await c.query(`SELECT COALESCE(SUM(balance_usd), 0) AS v FROM gift_cards WHERE is_active AND balance_usd > 0`);
        lines.push({ a: ch.acct('gift_cards'), amt: -n(gc[0].v), memo: 'Gift card and store credit balances' });
        const { rows: pc } = await c.query(`SELECT COALESCE(SUM(balance_cents), 0) / 100.0 AS v FROM petty_cash_funds WHERE is_active`);
        lines.push({ a: ch.acct('petty_cash'), amt: n(pc[0].v), memo: 'Petty cash funds on hand' });
        const id = await insertEntry(c, ch, { book: 'opening', kind: 'opening', id: 1, dateFixed: st[0].eve, ref: 'Opening', residual: ch.acct('opening_equity'),
          memo: 'Opening balances from the system at the ledger start', lines, userId: req.session.userId });
        await putSetting('gl_start_at', new Date(st[0].at).toISOString(), c.query.bind(c));
        await putSetting('gl_stock_day_done', st[0].yday, c.query.bind(c));
        return id;
      });
      postAll(req.session.userId).catch(() => {});
      res.json({ ok: true, opening_entry: out, start_date: day });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/gl/post-now', ...can('acct.post'), async (req, res) => {
    try { res.json(await postAll(req.session.userId)); } catch (e) { fail(res, e); }
  });
  app.put('/api/gl/settings', ...can('acct.setup'), async (req, res) => {
    try {
      if ((req.body || {}).auto_post !== undefined) await putSetting('gl_auto_post', req.body.auto_post ? 'on' : 'off');
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ---------------------------------------------------- chart & mapping --
  app.get('/api/gl/accounts', ...can('acct.view'), async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT a.*, COALESCE(SUM(l.amount), 0) AS balance, COUNT(l.id)::int AS lines
           FROM gl_accounts a LEFT JOIN gl_lines l ON l.account_id = a.id GROUP BY a.id ORDER BY a.code`);
      // Sub-accounts: depth from the parent chain, and each account's total
      // including everything beneath it (the "rolled up" balance a parent shows).
      const byId = new Map(rows.map((r) => [r.id, r]));
      const depth = (r) => { let d = 0, p = r; while (p && p.parent_id && d < 20) { p = byId.get(p.parent_id); d++; } return d; };
      const roll = new Map(rows.map((r) => [r.id, Number(r.balance) || 0]));
      for (const r of rows) { let p = r.parent_id ? byId.get(r.parent_id) : null, g = 0; while (p && g++ < 20) { roll.set(p.id, roll.get(p.id) + (Number(r.balance) || 0)); p = p.parent_id ? byId.get(p.parent_id) : null; } }
      const kids = new Map(); for (const r of rows) if (r.parent_id) kids.set(r.parent_id, (kids.get(r.parent_id) || 0) + 1);
      res.json({ accounts: rows.map((r) => ({ ...r, balance: r2(r.balance), depth: depth(r), rollup: r2(roll.get(r.id)), sub_count: kids.get(r.id) || 0,
        parent_code: r.parent_id && byId.get(r.parent_id) ? byId.get(r.parent_id).code : null })), qb_types: Object.keys(QB_TYPES) });
    } catch (e) { fail(res, e); }
  });
  function cleanAccount(b, partial) {
    const out = {};
    if (!partial || b.code !== undefined) { out.code = String(b.code || '').trim().slice(0, 20); if (!out.code) throw httpError(400, 'Give the account a code'); }
    if (!partial || b.name !== undefined) { out.name = String(b.name || '').trim().slice(0, 120); if (!out.name) throw httpError(400, 'Give the account a name'); }
    if (b.qb_type !== undefined || !partial) {
      out.qb_type = String(b.qb_type || '').toUpperCase();
      if (!QB_TYPES[out.qb_type]) throw httpError(400, 'Choose the QuickBooks account type');
      out.type = QB_TYPES[out.qb_type];
    }
    if (b.qb_name !== undefined) out.qb_name = String(b.qb_name || '').replace(/[\t\r\n]/g, ' ').trim().slice(0, 159) || null;
    if (b.is_active !== undefined) out.is_active = !!b.is_active;
    if (b.notes !== undefined) out.notes = String(b.notes || '').slice(0, 300) || null;
    return out;
  }
  app.post('/api/gl/accounts', ...can('acct.setup'), async (req, res) => {
    try {
      const b = req.body || {};
      const parentId = parseInt(b.parent_id, 10) || null;
      let a, parent = null;
      if (parentId) {
        // Sub-account: code = parent code + "-" + 1 to 4 digits; type and QuickBooks
        // type come from the parent; QuickBooks name is Parent:Child.
        const { rows: pr } = await query(`SELECT * FROM gl_accounts WHERE id = $1`, [parentId]);
        if (!pr.length) throw httpError(404, 'Parent account not found');
        parent = pr[0];
        const sub = String(b.sub_no == null ? '' : b.sub_no).trim();
        if (!/^\d{1,4}$/.test(sub)) throw httpError(400, 'The sub-account number must be 1 to 4 digits');
        a = cleanAccount(Object.assign({}, b, { code: parent.code + '-' + sub, qb_type: parent.qb_type || 'EXP' }), false);
        a.type = parent.type;
        if (!a.qb_name) a.qb_name = (parent.qb_name || parent.name) + ':' + a.name;
      } else {
        a = cleanAccount(b, false);
      }
      const { rows } = await query(`INSERT INTO gl_accounts (code, name, type, qb_type, qb_name, notes, parent_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [a.code, a.name, a.type, a.qb_type, a.qb_name || a.name, a.notes || null, parent ? parent.id : null]);
      res.json({ account: rows[0] });
    } catch (e) { if (e.code === '23505') e = httpError(409, 'That code is already used'); fail(res, e); }
  });
  app.patch('/api/gl/accounts/:id', ...can('acct.setup'), async (req, res) => {
    try {
      const a = cleanAccount(req.body || {}, true);
      const { rows: cur } = await query(`SELECT a.*, EXISTS (SELECT 1 FROM gl_lines l WHERE l.account_id = a.id) AS used FROM gl_accounts a WHERE a.id = $1`, [req.params.id]);
      if (!cur.length) throw httpError(404, 'Account not found');
      if (cur[0].used && a.type && a.type !== cur[0].type) throw httpError(409, 'This account has entries: its type cannot change from ' + cur[0].type);
      if (cur[0].system_key && a.is_active === false) throw httpError(409, 'The posting rules use this account; point the rule elsewhere first');
      if (cur[0].parent_id) { delete a.code; delete a.type; delete a.qb_type; }   // fixed by the parent
      const { rows: kidRows } = await query(`SELECT 1 FROM gl_accounts WHERE parent_id = $1 LIMIT 1`, [req.params.id]);
      if (kidRows.length && ((a.code && a.code !== cur[0].code) || (a.type && a.type !== cur[0].type)))
        throw httpError(409, 'This account has sub-accounts: their codes and type come from it, so its code and type cannot change');
      const keys = Object.keys(a);
      if (!keys.length) throw httpError(400, 'Nothing to change');
      const { rows } = await query(`UPDATE gl_accounts SET ${keys.map((k, i) => k + ' = $' + (i + 2)).join(', ')} WHERE id = $1 RETURNING *`, [req.params.id, ...keys.map((k) => a[k])]);
      res.json({ account: rows[0] });
    } catch (e) { if (e.code === '23505') e = httpError(409, 'That code is already used'); fail(res, e); }
  });

  // Import QuickBooks' chart: Lists > Chart of Accounts > File > Export > Lists
  // to IIF. Each !ACCNT row either matches an account here by QuickBooks name
  // or becomes a new account. Nothing is deleted.
  app.post('/api/gl/accounts/import-iif', ...can('acct.setup'), async (req, res) => {
    try {
      const text = String((req.body || {}).text || '');
      if (text.length > 2000000) throw httpError(400, 'File too large');
      const lines = text.split(/\r?\n/);
      let head = null; const found = [];
      for (const ln of lines) {
        const cols = ln.split('\t');
        if (cols[0] === '!ACCNT') { head = cols.map((x) => x.toUpperCase()); continue; }
        if (cols[0] === 'ACCNT' && head) {
          const get = (k) => { const i = head.indexOf(k); return i >= 0 ? (cols[i] || '').trim() : ''; };
          const name = get('NAME').replace(/^"|"$/g, ''), type = get('ACCNTTYPE').toUpperCase();
          if (name && QB_TYPES[type]) found.push({ name, type, num: get('ACCNUM'), desc: get('DESC') });
        }
      }
      if (!found.length) throw httpError(400, 'No accounts found: export the chart of accounts from QuickBooks as an IIF file');
      let added = 0, matched = 0;
      await tx(async (c) => {
        for (const f of found) {
          const { rows } = await c.query(`SELECT id FROM gl_accounts WHERE lower(qb_name) = lower($1) OR lower(name) = lower($1) LIMIT 1`, [f.name]);
          if (rows.length) { await c.query(`UPDATE gl_accounts SET qb_name = $2, qb_type = $3 WHERE id = $1`, [rows[0].id, f.name, f.type]); matched++; continue; }
          let code = f.num || 'QB' + String(added + 1).padStart(3, '0');
          const { rows: dup } = await c.query(`SELECT 1 FROM gl_accounts WHERE code = $1`, [code]);
          if (dup.length) code = code + '-QB';
          await c.query(`INSERT INTO gl_accounts (code, name, type, qb_name, qb_type, notes) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (code) DO NOTHING`,
            [code, f.name.split(':').pop().slice(0, 120), QB_TYPES[f.type], f.name, f.type, f.desc || 'From QuickBooks']);
          added++;
        }
      });
      res.json({ found: found.length, matched, added });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/gl/map', ...can('acct.view'), async (req, res) => {
    try {
      const { rows: m } = await query(`SELECT m.*, a.code, a.name FROM gl_map m JOIN gl_accounts a ON a.id = m.account_id ORDER BY m.kind, m.key`);
      const { rows: cats } = await query(`SELECT DISTINCT lower(category) AS k FROM products WHERE category IS NOT NULL AND category <> '' ORDER BY 1`);
      const { rows: pm } = await query(`SELECT DISTINCT lower(method) AS k FROM sale_payments WHERE method IS NOT NULL UNION SELECT DISTINCT lower(method) FROM account_payments UNION SELECT DISTINCT lower(refund_method) FROM pos_sale_returns ORDER BY 1`);
      const { rows: po } = await query(`SELECT DISTINCT lower(method) AS k FROM purchase_order_payments WHERE method IS NOT NULL ORDER BY 1`);
      // Payout reasons at the till, plus petty cash categories and Cash Report payout reasons.
      const { rows: tp } = await query(`SELECT k FROM (SELECT DISTINCT lower(reason) AS k FROM till_movements WHERE kind = 'payout' AND reason IS NOT NULL
          UNION SELECT lower(name) FROM petty_cash_categories WHERE is_active
          UNION SELECT DISTINCT lower(reason) FROM cash_payouts WHERE source_type = 'drawer' AND category_id IS NULL AND fund_id IS NULL) x ORDER BY 1 LIMIT 80`);
      const keys = {
        pay_method: [...new Set(['cash', 'cheque', 'card', 'bank', 'gift_card', 'store_credit', 'loyalty', 'gift_card_issue', ...pm.map((x) => x.k)])].filter((k) => !SKIP_PAY.includes(k)),
        pay_out_method: [...new Set(['cash', 'cheque', 'bank', 'card', 'commission', ...po.map((x) => x.k)])],
        revenue_category: cats.map((x) => x.k), cogs_category: cats.map((x) => x.k),
        stock_reason: ['count', 'requisition', 'po_quick_receive', 'regrade', 'writeoff', 'vendor_claim', 'other'], till_payout: tp.map((x) => x.k),
      };
      const fallback = { pay_method: 'suspense', pay_out_method: 'bank', revenue_category: 'sales', cogs_category: 'cogs', stock_reason: 'inv_adjust', till_payout: 'petty_expense' };
      res.json({ map: m, keys, fallback });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/gl/map', ...can('acct.setup'), async (req, res) => {
    try {
      const b = req.body || {};
      const kinds = ['pay_method', 'pay_out_method', 'revenue_category', 'cogs_category', 'stock_reason', 'till_payout'];
      if (!kinds.includes(b.kind)) throw httpError(400, 'Unknown rule');
      const key = String(b.key || '').trim().toLowerCase().slice(0, 80);
      if (!key) throw httpError(400, 'Which one?');
      if (b.account_id == null || b.account_id === '') {
        await query(`DELETE FROM gl_map WHERE kind = $1 AND key = $2`, [b.kind, key]);
      } else {
        const { rows } = await query(`SELECT id FROM gl_accounts WHERE id = $1 AND is_active`, [b.account_id]);
        if (!rows.length) throw httpError(400, 'Choose an active account');
        await query(`INSERT INTO gl_map (kind, key, account_id) VALUES ($1,$2,$3) ON CONFLICT (kind, key) DO UPDATE SET account_id = EXCLUDED.account_id`, [b.kind, key, b.account_id]);
      }
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ---------------------------------------------------------- journal --
  const dateArg = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s || '') ? s : null);
  app.get('/api/gl/entries', ...can('acct.view'), async (req, res) => {
    try {
      const vals = [], where = [];
      const add = (sql, v) => { vals.push(v); where.push(sql.split('?').join('$' + vals.length)); };
      if (dateArg(req.query.from)) add('e.entry_date >= ?', req.query.from);
      if (dateArg(req.query.to)) add('e.entry_date <= ?', req.query.to);
      if (req.query.book) add('e.book = ?', String(req.query.book));
      if (req.query.source) add('e.source_kind = ?', String(req.query.source));
      if (req.query.account) add('EXISTS (SELECT 1 FROM gl_lines x WHERE x.entry_id = e.id AND x.account_id = ?)', parseInt(req.query.account, 10) || 0);
      if (req.query.q) add(`(e.number ILIKE '%' || ? || '%' OR e.source_ref ILIKE '%' || ? || '%' OR e.memo ILIKE '%' || ? || '%')`, String(req.query.q).slice(0, 60));
      const { rows } = await query(
        `SELECT e.*, to_char(e.entry_date, 'YYYY-MM-DD') AS entry_date, u.name AS posted_by_name,
                (SELECT COALESCE(SUM(amount), 0) FROM gl_lines l WHERE l.entry_id = e.id AND l.amount > 0) AS total
           FROM gl_entries e LEFT JOIN users u ON u.id = e.posted_by
          ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY e.entry_date DESC, e.id DESC LIMIT 500`, vals);
      res.json({ entries: rows.map((r) => ({ ...r, total: r2(r.total) })) });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/gl/entries/:id', ...can('acct.view'), async (req, res) => {
    try {
      const { rows } = await query(`SELECT e.*, to_char(e.entry_date, 'YYYY-MM-DD') AS entry_date, u.name AS posted_by_name FROM gl_entries e LEFT JOIN users u ON u.id = e.posted_by WHERE e.id = $1`, [req.params.id]);
      if (!rows.length) throw httpError(404, 'Entry not found');
      const { rows: lines } = await query(
        `SELECT l.*, a.code, a.name, a.type FROM gl_lines l JOIN gl_accounts a ON a.id = l.account_id WHERE l.entry_id = $1 ORDER BY l.amount DESC, l.id`, [req.params.id]);
      res.json({ entry: rows[0], lines: lines.map((l) => ({ ...l, amount: r2(l.amount) })) });
    } catch (e) { fail(res, e); }
  });

  // Manual journal: {date, memo, lines:[{account_id, debit, credit, party, memo}]}
  app.post('/api/gl/journal', ...can('acct.post'), async (req, res) => {
    try {
      if (!(await setting('gl_start_at', null))) throw httpError(409, 'Start the ledger first');
      const b = req.body || {};
      const date = dateArg(b.date);
      if (!date) throw httpError(400, 'Give the date');
      const memo = String(b.memo || '').trim().slice(0, 300);
      if (memo.length < 3) throw httpError(400, 'Say what the entry is for');
      const raw = Array.isArray(b.lines) ? b.lines : [];
      const lines = raw.map((l) => ({ a: parseInt(l.account_id, 10), amt: r2(n(l.debit) - n(l.credit)), party: l.party ? String(l.party).trim().slice(0, 41) : null, memo: l.memo ? String(l.memo).slice(0, 200) : null, cls: parseInt(l.class_id, 10) || null }))
        .filter((l) => l.a && l.amt);
      if (lines.length < 2) throw httpError(400, 'An entry needs at least two lines with amounts');
      const off = r2(lines.reduce((s, l) => s + l.amt, 0));
      if (off) throw httpError(400, 'Debits and credits differ by ' + off.toFixed(2));
      const id = await tx(async (c) => {
        const ch = await chart(c.query.bind(c));
        for (const l of lines) {
          if (!ch.byId[l.a] || !ch.byId[l.a].is_active) throw httpError(400, 'Unknown or inactive account');
          if (l.cls && !(await c.query(`SELECT 1 FROM gl_classes WHERE id = $1 AND is_active`, [l.cls])).rows.length) throw httpError(400, 'Unknown or retired class');
          if (['ar', 'ap'].includes(ch.byId[l.a].system_key) && !l.party) throw httpError(400, 'Lines on ' + ch.byId[l.a].name + ' need a customer or supplier name');
        }
        const { rows } = await c.query(`SELECT COALESCE(MAX(source_id), 0) + 1 AS n FROM gl_entries WHERE source_kind = 'manual'`);
        const { rows: cl } = await c.query(`SELECT 1 FROM gl_periods WHERE month = date_trunc('month', $1::date)::date`, [date]);
        if (cl.length) throw httpError(409, 'The books for that month are closed');
        return insertEntry(c, ch, { book: 'manual', kind: 'manual', id: rows[0].n, dateFixed: date, ref: b.ref ? String(b.ref).slice(0, 40) : null, memo, lines, userId: req.session.userId });
      });
      res.json({ id });
    } catch (e) { fail(res, e); }
  });

  // Reverse any entry: a mirror entry dated today (or the date given).
  app.post('/api/gl/entries/:id/reverse', ...can('acct.post'), async (req, res) => {
    try {
      const b = req.body || {};
      const memo = String(b.memo || '').trim();
      if (memo.length < 3) throw httpError(400, 'Say why it is being reversed');
      const id = await tx(async (c) => {
        const { rows } = await c.query(`SELECT * FROM gl_entries WHERE id = $1 FOR UPDATE`, [req.params.id]);
        if (!rows.length) throw httpError(404, 'Entry not found');
        const e = rows[0];
        if (e.reversed_by) throw httpError(409, 'Already reversed');
        if (e.reverses_id || e.source_kind === 'reversal') throw httpError(409, 'This is itself a reversal');
        const ch = await chart(c.query.bind(c));
        const { rows: ls } = await c.query(`SELECT * FROM gl_lines WHERE entry_id = $1`, [e.id]);
        const { rows: today } = await c.query(`SELECT to_char((NOW() AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS d`);
        const date = dateArg(b.date) || today[0].d;
        const { rows: cl } = await c.query(`SELECT 1 FROM gl_periods WHERE month = date_trunc('month', $1::date)::date`, [date]);
        if (cl.length) throw httpError(409, 'The books for that month are closed: reverse into an open month');
        const newId = await insertEntry(c, ch, { book: e.book, kind: 'reversal', id: e.id, dateFixed: date, ref: e.number, reverses: e.id,
          memo: 'Reversal of ' + e.number + ': ' + memo.slice(0, 200), lines: ls.map((l) => ({ a: l.account_id, amt: -n(l.amount), party: l.party, memo: l.memo, cls: l.class_id })), userId: req.session.userId });
        await c.query(`UPDATE gl_entries SET reversed_by = $2 WHERE id = $1`, [e.id, newId]);
        return newId;
      });
      res.json({ id });
    } catch (e) { fail(res, e); }
  });

  // ----------------------------------------------------------- classes --
  // QuickBooks classes: one per store location (schema.sql keeps them in step)
  // and custom ones. Retired rather than deleted once lines carry them. Any
  // admin can list them (the bill and invoice screens pick from it).
  app.get('/api/gl/classes', requireAdmin, async (req, res) => {
    try {
      const { rows } = await query(`SELECT c.id, c.name, c.location_id, c.is_active, sl.name AS location, (SELECT COUNT(*)::int FROM gl_lines l WHERE l.class_id = c.id) AS lines
                                      FROM gl_classes c LEFT JOIN store_locations sl ON sl.id = c.location_id ORDER BY c.location_id IS NULL, c.name`);
      res.json({ classes: rows });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/gl/classes', ...can('acct.setup'), async (req, res) => {
    try {
      const name = String((req.body || {}).name || '').trim().slice(0, 60);
      if (name.length < 2) throw httpError(400, 'Name the class (e.g. Rentals, Workshop)');
      if ((await query(`SELECT 1 FROM gl_classes WHERE lower(name) = lower($1)`, [name])).rows.length) throw httpError(409, 'There is already a class with that name');
      const { rows } = await query(`INSERT INTO gl_classes (name) VALUES ($1) RETURNING id`, [name]);
      res.json({ ok: true, id: rows[0].id });
    } catch (e) { if (e.code === '23505') e = httpError(409, 'There is already a class with that name'); fail(res, e); }
  });
  app.put('/api/gl/classes/:id', ...can('acct.setup'), async (req, res) => {
    try {
      const b = req.body || {}, name = b.name === undefined ? null : String(b.name).trim().slice(0, 60);
      if (name !== null && name.length < 2) throw httpError(400, 'Name the class');
      if (name !== null && (await query(`SELECT 1 FROM gl_classes WHERE lower(name) = lower($1) AND id <> $2`, [name, parseInt(req.params.id, 10) || 0])).rows.length) throw httpError(409, 'There is already a class with that name');
      const { rowCount } = await query(`UPDATE gl_classes SET name = COALESCE($2, name), is_active = COALESCE($3, is_active) WHERE id = $1`,
        [parseInt(req.params.id, 10), name, b.is_active === undefined ? null : !!b.is_active]);
      if (!rowCount) throw httpError(404, 'Class not found');
      res.json({ ok: true });
    } catch (e) { if (e.code === '23505') e = httpError(409, 'There is already a class with that name'); fail(res, e); }
  });

  // -------------------------------------------- products with their own accounts --
  // A product's own income / cost account comes before its category's rule (sale and return posters).
  app.get('/api/gl/products', ...can('acct.view'), async (req, res) => {
    try {
      const q = String(req.query.q || '').trim().slice(0, 60);
      const { rows } = await query(
        `SELECT p.id, p.img, p.name, p.sku, p.category, p.income_account_id, p.cogs_account_id, ia.code || ' ' || ia.name AS income_account, ca.code || ' ' || ca.name AS cogs_account
           FROM products p LEFT JOIN gl_accounts ia ON ia.id = p.income_account_id LEFT JOIN gl_accounts ca ON ca.id = p.cogs_account_id
          WHERE ($1 = '' AND (p.income_account_id IS NOT NULL OR p.cogs_account_id IS NOT NULL))
             OR ($1 <> '' AND (p.name ILIKE '%' || $1 || '%' OR p.sku ILIKE $1 || '%' OR p.img ILIKE $1 || '%'))
          ORDER BY (p.income_account_id IS NULL AND p.cogs_account_id IS NULL), p.name LIMIT 60`, [q]);
      res.json({ products: rows });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/gl/products/:id', ...can('acct.setup'), async (req, res) => {
    try {
      const b = req.body || {};
      const pick = async (v, types, what) => {
        if (v == null || v === '') return null;
        const { rows } = await query(`SELECT id, type FROM gl_accounts WHERE id = $1 AND is_active`, [parseInt(v, 10) || 0]);
        if (!rows.length || !types.includes(rows[0].type)) throw httpError(400, 'Choose ' + what);
        return rows[0].id;
      };
      const inc = await pick(b.income_account_id, ['income', 'other_income'], 'an income account');
      const cogs = await pick(b.cogs_account_id, ['cogs', 'expense'], 'a cost of sales or expense account');
      const { rowCount } = await query(`UPDATE products SET income_account_id = $2, cogs_account_id = $3 WHERE id = $1`, [parseInt(req.params.id, 10), inc, cogs]);
      if (!rowCount) throw httpError(404, 'Product not found');
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // -------------------------------------------------- category reports --
  // Profit & loss by category (account, with sub-accounts under their parent),
  // for a period; a class filter ('none' = unclassified), or a column per class.
  // Income is shown positive, costs positive; net = income - costs.
  const PL_TYPES = ['income', 'cogs', 'expense', 'other_income', 'other_expense'];   // the order QuickBooks shows them in
  const classFilter = (v, idx) => (v === 'none' ? ` AND l.class_id IS NULL` : parseInt(v, 10) ? ` AND l.class_id = $${idx}` : '');
  app.get('/api/gl/reports/pl', ...can('acct.view'), async (req, res) => {
    try {
      const from = dateArg(req.query.from), to = dateArg(req.query.to);
      if (!from || !to || from > to) throw httpError(400, 'Choose a from and to date');
      const cf = classFilter(req.query.class_id, 3), args = [from, to].concat(parseInt(req.query.class_id, 10) ? [parseInt(req.query.class_id, 10)] : []);
      const { rows } = await query(
        `SELECT a.id, a.code, a.name, a.type, a.parent_id, l.class_id, SUM(l.amount)::float AS amount
           FROM gl_lines l JOIN gl_entries e ON e.id = l.entry_id JOIN gl_accounts a ON a.id = l.account_id
          WHERE e.entry_date BETWEEN $1 AND $2 AND a.type = ANY('{income,other_income,cogs,expense,other_expense}')${cf}
          GROUP BY a.id, l.class_id`, args);
      const { rows: cls } = await query(`SELECT id, name FROM gl_classes ORDER BY location_id IS NULL, name`);
      const byClass = req.query.by_class === '1';
      const cols = byClass ? cls.filter((c) => rows.some((r) => r.class_id === c.id)).map((c) => ({ id: c.id, name: c.name })).concat(rows.some((r) => !r.class_id) ? [{ id: null, name: 'Unclassified' }] : []) : [];
      const acc = new Map();
      for (const r of rows) {
        const sign = ['income', 'other_income'].includes(r.type) ? -1 : 1;
        const x = acc.get(r.id) || { id: r.id, code: r.code, name: r.name, type: r.type, parent_id: r.parent_id, total: 0, by: {} };
        x.total = r2(x.total + sign * r.amount);
        if (byClass) { const k = r.class_id || 'none'; x.by[k] = r2((x.by[k] || 0) + sign * r.amount); }
        acc.set(r.id, x);
      }
      const list = [...acc.values()].filter((x) => x.total !== 0 || Object.values(x.by).some((v) => v !== 0)).sort((a, b) => PL_TYPES.indexOf(a.type) - PL_TYPES.indexOf(b.type) || String(a.code).localeCompare(String(b.code)));
      const sum = (types, k) => r2(list.filter((x) => types.includes(x.type)).reduce((s, x) => s + (k === undefined ? x.total : (x.by[k] || 0)), 0));
      const totals = (k) => { const inc = sum(['income'], k), cogs = sum(['cogs'], k), exp = sum(['expense'], k), oi = sum(['other_income'], k), oe = sum(['other_expense'], k);
        return { income: inc, cogs, gross_profit: r2(inc - cogs), expenses: exp, other_income: oi, other_expenses: oe, net: r2(inc - cogs - exp + oi - oe) }; };
      res.json({ from, to, accounts: list, columns: cols, totals: totals(), by_class: byClass ? Object.fromEntries(cols.map((c) => [c.id || 'none', totals(c.id || 'none')])) : null });
    } catch (e) { fail(res, e); }
  });
  // Drill-down: every ledger line behind one account (and class) in a period.
  app.get('/api/gl/reports/lines', ...can('acct.view'), async (req, res) => {
    try {
      const from = dateArg(req.query.from), to = dateArg(req.query.to), acct = parseInt(req.query.account_id, 10);
      if (!from || !to || !acct) throw httpError(400, 'Account and dates');
      const cf = classFilter(req.query.class_id, 4), args = [acct, from, to].concat(parseInt(req.query.class_id, 10) ? [parseInt(req.query.class_id, 10)] : []);
      const { rows } = await query(
        `SELECT to_char(e.entry_date, 'YYYY-MM-DD') AS day, e.number, e.source_kind, e.source_ref AS ref, e.memo, l.party, l.memo AS line_memo, l.amount::float AS amount, c.name AS class
           FROM gl_lines l JOIN gl_entries e ON e.id = l.entry_id LEFT JOIN gl_classes c ON c.id = l.class_id
          WHERE l.account_id = $1 AND e.entry_date BETWEEN $2 AND $3${cf} ORDER BY e.entry_date, e.id LIMIT 2000`, args);
      const { rows: a } = await query(`SELECT code, name, type FROM gl_accounts WHERE id = $1`, [acct]);
      res.json({ account: a[0] || null, lines: rows });
    } catch (e) { fail(res, e); }
  });
  // Expenses by supplier and category, or sales by customer and income category.
  // The party is the name on the line (bills, cheques, invoices and till sales carry it
  // from 2026-10-19); lines without one are grouped as "(no name)".
  app.get('/api/gl/reports/by-party', ...can('acct.view'), async (req, res) => {
    try {
      const from = dateArg(req.query.from), to = dateArg(req.query.to), sales = req.query.kind === 'sales';
      if (!from || !to || from > to) throw httpError(400, 'Choose a from and to date');
      const types = sales ? '{income,other_income}' : '{cogs,expense,other_expense}';
      const cf = classFilter(req.query.class_id, 3), args = [from, to].concat(parseInt(req.query.class_id, 10) ? [parseInt(req.query.class_id, 10)] : []);
      const { rows } = await query(
        `SELECT COALESCE(NULLIF(l.party, ''), '(no name)') AS party, a.id, a.code, a.name, SUM(l.amount)::float AS amount
           FROM gl_lines l JOIN gl_entries e ON e.id = l.entry_id JOIN gl_accounts a ON a.id = l.account_id
          WHERE e.entry_date BETWEEN $1 AND $2 AND a.type = ANY('${types}') AND a.system_key IS DISTINCT FROM 'inventory'${cf}
          GROUP BY 1, a.id ORDER BY 1, a.code`, args);
      const parties = new Map(), accounts = new Map();
      for (const r of rows) {
        const v = r2(sales ? -r.amount : r.amount);
        if (!v) continue;
        accounts.set(r.id, { id: r.id, code: r.code, name: r.name });
        const p = parties.get(r.party) || { party: r.party, total: 0, by: {} };
        p.by[r.id] = r2((p.by[r.id] || 0) + v); p.total = r2(p.total + v);
        parties.set(r.party, p);
      }
      res.json({ from, to, kind: sales ? 'sales' : 'expenses', accounts: [...accounts.values()].sort((a, b) => String(a.code).localeCompare(String(b.code))), rows: [...parties.values()].sort((a, b) => b.total - a.total) });
    } catch (e) { fail(res, e); }
  });

  // ----------------------------------------------------------- reports --
  // Trial balance for a period: opening, debits, credits, closing per account;
  // income statement for the period; balance sheet at the end.
  app.get('/api/gl/trial-balance', ...can('acct.view'), async (req, res) => {
    try {
      const from = dateArg(req.query.from), to = dateArg(req.query.to);
      if (!from || !to || from > to) throw httpError(400, 'Choose a from and to date');
      const { rows } = await query(
        `SELECT a.id, a.code, a.name, a.type, a.qb_name, a.system_key,
                COALESCE(SUM(l.amount) FILTER (WHERE e.entry_date < $1), 0) AS opening,
                COALESCE(SUM(l.amount) FILTER (WHERE e.entry_date BETWEEN $1 AND $2 AND l.amount > 0), 0) AS debits,
                COALESCE(-SUM(l.amount) FILTER (WHERE e.entry_date BETWEEN $1 AND $2 AND l.amount < 0), 0) AS credits,
                COALESCE(SUM(l.amount) FILTER (WHERE e.entry_date <= $2), 0) AS closing
           FROM gl_accounts a LEFT JOIN gl_lines l ON l.account_id = a.id LEFT JOIN gl_entries e ON e.id = l.entry_id
          GROUP BY a.id HAVING COUNT(l.id) > 0 OR a.is_active ORDER BY a.code`, [from, to]);
      const acc = rows.map((r) => ({ ...r, opening: r2(r.opening), debits: r2(r.debits), credits: r2(r.credits), closing: r2(r.closing) }));
      const tot = acc.reduce((s, r) => ({ debits: s.debits + r.debits, credits: s.credits + r.credits }), { debits: 0, credits: 0 });
      const period = (types) => -acc.filter((r) => types.includes(r.type)).reduce((s, r) => s + (r.debits - r.credits), 0);
      const income = r2(period(['income'])), cogs = r2(-period(['cogs'])), expense = r2(-period(['expense'])), otherNet = r2(period(['other_income', 'other_expense']));
      const bs = (t) => r2(acc.filter((r) => r.type === t).reduce((s, r) => s + r.closing, 0));
      // Profit not yet closed to equity: everything in income/expense accounts to date.
      const earningsToDate = r2(-acc.filter((r) => ['income', 'cogs', 'expense', 'other_income', 'other_expense'].includes(r.type)).reduce((s, r) => s + r.closing, 0));
      res.json({
        from, to, accounts: acc, totals: { debits: r2(tot.debits), credits: r2(tot.credits), balanced: r2(tot.debits - tot.credits) === 0 },
        income_statement: { income, cogs, gross_profit: r2(income - cogs), expenses: expense, other: otherNet, net: r2(income - cogs - expense + otherNet) },
        balance_sheet: { assets: bs('asset'), liabilities: r2(-bs('liability')), equity: r2(-bs('equity')), earnings_to_date: earningsToDate,
          check: r2(bs('asset') + bs('liability') + bs('equity') - earningsToDate) },
      });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/gl/accounts/:id/ledger', ...can('acct.view'), async (req, res) => {
    try {
      const from = dateArg(req.query.from), to = dateArg(req.query.to);
      if (!from || !to) throw httpError(400, 'Choose a from and to date');
      const { rows: a } = await query(`SELECT * FROM gl_accounts WHERE id = $1`, [req.params.id]);
      if (!a.length) throw httpError(404, 'Account not found');
      const { rows: op } = await query(`SELECT COALESCE(SUM(l.amount), 0) AS b FROM gl_lines l JOIN gl_entries e ON e.id = l.entry_id WHERE l.account_id = $1 AND e.entry_date < $2`, [req.params.id, from]);
      const { rows } = await query(
        `SELECT e.id AS entry_id, e.number, to_char(e.entry_date, 'YYYY-MM-DD') AS entry_date, e.source_kind, e.source_ref, e.memo AS entry_memo, l.amount, l.party, l.memo
           FROM gl_lines l JOIN gl_entries e ON e.id = l.entry_id WHERE l.account_id = $1 AND e.entry_date BETWEEN $2 AND $3
          ORDER BY e.entry_date, e.id LIMIT 5000`, [req.params.id, from, to]);
      let bal = r2(op[0].b);
      res.json({ account: a[0], opening: bal, lines: rows.map((r) => { bal = r2(bal + n(r.amount)); return { ...r, amount: r2(r.amount), balance: bal }; }), closing: bal });
    } catch (e) { fail(res, e); }
  });

  // Tie-out: each control account against the system's own record.
  app.get('/api/gl/tieout', ...can('acct.view'), async (req, res) => {
    try {
      const { rows: bal } = await query(`SELECT a.system_key, COALESCE(SUM(l.amount), 0) AS b FROM gl_accounts a LEFT JOIN gl_lines l ON l.account_id = a.id WHERE a.system_key IS NOT NULL GROUP BY a.system_key`);
      const gl = Object.fromEntries(bal.map((r) => [r.system_key, r2(r.b)]));
      const one = async (sql) => r2((await query(sql)).rows[0].v);
      const checks = [
        { key: 'inventory', label: 'Inventory', gl: gl.inventory, system: await one(`SELECT COALESCE(SUM(stock_count * COALESCE(cost_usd, 0)), 0) AS v FROM products WHERE stock_count > 0`),
          note: 'Stock on hand at average cost. Differences come from cost changes on stock already held, sales of stock not on hand, and receiving outside the Receive screen.' },
        { key: 'ar', label: 'Accounts receivable', gl: gl.ar, system: await one(`SELECT (SELECT COALESCE(SUM(balance_due_usd), 0) FROM pos_sales WHERE NOT COALESCE(voided, false))
                                   + (SELECT COALESCE(SUM(total), 0) FROM ar_invoices WHERE voided_at IS NULL)
                                   - (SELECT COALESCE(SUM(amount_usd), 0) FROM account_payments) AS v`),
          note: 'Balances due on sales and invoices raised on the books (rent, late fees), less payments received on account.' },
        { key: 'ap', label: 'Accounts payable', gl: -gl.ap, system: await one(`SELECT COALESCE(SUM(balance_due_usd), 0) AS v FROM purchase_orders WHERE status <> 'cancelled' AND COALESCE(balance_due_usd, 0) > 0`),
          note: 'Balances due on purchase orders.' },
        { key: 'grni', label: 'Goods received, not billed', gl: -gl.grni, system: await one(
            `SELECT COALESCE(SUM((l.qty_received + l.qty_damaged) * COALESCE(l.unit_cost, 0) * COALESCE(r.fx_rate, 1)), 0) AS v
               FROM receipts r JOIN receipt_lines l ON l.receipt_id = r.id WHERE r.status = 'posted' AND r.bill_status <> 'confirmed'`),
          note: 'Receipts whose supplier bill is not confirmed. Goods received on the old purchase screens also sit here until their invoice is entered.' },
        { key: 'gift_cards', label: 'Gift cards and store credit', gl: -gl.gift_cards, system: await one(`SELECT COALESCE(SUM(balance_usd), 0) AS v FROM gift_cards WHERE is_active`),
          note: 'Unspent balances.' },
        { key: 'cash_drawers', label: 'Cash in drawers', gl: gl.cash_drawers, system: null,
          note: 'Should be the floats and takings of drawers open now; zero when every drawer is closed through the cashier module.' },
        { key: 'suspense', label: 'Suspense', gl: gl.suspense, system: 0, note: 'Postings that did not add up. Should be zero: open the account to see what landed here.' },
      ].map((x) => ({ ...x, gl: r2(x.gl), difference: x.system == null ? null : r2(n(x.gl) - n(x.system)) }));
      res.json({ checks });
    } catch (e) { fail(res, e); }
  });

  // -------------------------------------------------------- periods --
  app.post('/api/gl/periods', ...can('acct.close'), async (req, res) => {
    try {
      const m = String((req.body || {}).month || '');
      if (!/^\d{4}-\d{2}$/.test(m)) throw httpError(400, 'Which month (YYYY-MM)?');
      const { rows } = await query(`SELECT ($1 || '-01')::date + INTERVAL '1 month' <= (NOW() AT TIME ZONE '${TZ}')::date AS ended`, [m]);
      if (!rows[0].ended) throw httpError(409, 'That month has not ended yet');
      await postAll(req.session.userId);
      await query(`INSERT INTO gl_periods (month, closed_by, note) VALUES (($1 || '-01')::date, $2, $3) ON CONFLICT (month) DO NOTHING`,
        [m, req.session.userId, String((req.body || {}).note || '').slice(0, 200) || null]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.delete('/api/gl/periods/:month', ...can('acct.close'), async (req, res) => {
    try {
      const m = String(req.params.month || '');
      if (!/^\d{4}-\d{2}$/.test(m)) throw httpError(400, 'Which month?');
      const { rows: ex } = await query(`SELECT COUNT(*)::int AS n FROM gl_exports WHERE kind = 'iif' AND from_date <= ($1 || '-01')::date + INTERVAL '1 month' - INTERVAL '1 day' AND to_date >= ($1 || '-01')::date`, [m]);
      if (ex[0].n && !(req.body && req.body.confirm_exported)) throw httpError(409, 'This month was already sent to QuickBooks. Reopen only if you will correct QuickBooks too.');
      const { rowCount } = await query(`DELETE FROM gl_periods WHERE month = ($1 || '-01')::date`, [m]);
      if (!rowCount) throw httpError(404, 'That month is not closed');
      console.log('[gl] month', m, 'reopened by user', req.session.userId);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // --------------------------------------------------------- exports --
  const iifText = (s) => String(s == null ? '' : s).replace(/[\t\r\n"]/g, ' ').trim();
  const usDate = (d) => { const [y, m, dd] = String(d).slice(0, 10).split('-'); return m + '/' + dd + '/' + y; };

  // QuickBooks Desktop IIF: one general journal per day and book, lines
  // summed by account (and by customer / supplier on A/R and A/P lines).
  // A journal may not mix A/R and A/P, so such a day is split in two through
  // the suspense account, which nets to zero.
  app.get('/api/gl/export/iif', ...can('acct.export'), async (req, res) => {
    try {
      const from = dateArg(req.query.from), to = dateArg(req.query.to);
      if (!from || !to || from > to) throw httpError(400, 'Choose a from and to date');
      const { rows: done } = await query(`SELECT COUNT(*)::int AS n FROM gl_entries WHERE entry_date BETWEEN $1 AND $2 AND export_id IS NOT NULL`, [from, to]);
      if (done[0].n && req.query.again !== '1') throw httpError(409, done[0].n + ' entries in these dates were already exported. Importing them again would double them in QuickBooks. Add again=1 only if QuickBooks does not have them.');
      const { rows } = await query(
        `SELECT to_char(e.entry_date, 'YYYY-MM-DD') AS entry_date, e.book, a.id AS account_id, a.qb_name, a.qb_type, a.system_key,
                CASE WHEN a.qb_type IN ('AR', 'AP') THEN COALESCE(l.party, CASE WHEN a.qb_type = 'AR' THEN 'Cash Sales' ELSE 'Supplier' END) END AS party,
                c.name AS class, SUM(l.amount) AS amount, COUNT(DISTINCT e.id) AS entries
           FROM gl_entries e JOIN gl_lines l ON l.entry_id = e.id JOIN gl_accounts a ON a.id = l.account_id LEFT JOIN gl_classes c ON c.id = l.class_id
          WHERE e.entry_date BETWEEN $1 AND $2
          GROUP BY 1, 2, 3, 4, 5, 6, 7, 8 HAVING ROUND(SUM(l.amount), 2) <> 0 ORDER BY 1, 2, 5`, [from, to]);
      const missing = [...new Set(rows.filter((r) => !r.qb_name).map((r) => r.account_id))];
      if (missing.length) throw httpError(409, 'Give these accounts their QuickBooks name first (Accounts tab): ' + missing.join(', '));
      const { rows: sus } = await query(`SELECT qb_name FROM gl_accounts WHERE system_key = 'suspense'`);
      const clearing = sus[0].qb_name;
      const out = ['!ACCNT\tNAME\tACCNTTYPE\tDESC'];
      const accts = new Map(rows.map((r) => [r.qb_name, r.qb_type]));
      accts.set(clearing, 'EXP');
      for (const [nm, ty] of accts) out.push(['ACCNT', iifText(nm), ty, 'Vision Auto Solutions'].join('\t'));
      const custs = [...new Set(rows.filter((r) => r.qb_type === 'AR').map((r) => r.party))], vends = [...new Set(rows.filter((r) => r.qb_type === 'AP').map((r) => r.party))];
      if (custs.length) { out.push('!CUST\tNAME'); for (const c of custs) out.push('CUST\t' + iifText(c)); }
      if (vends.length) { out.push('!VEND\tNAME'); for (const v of vends) out.push('VEND\t' + iifText(v)); }
      // Classes (QuickBooks class tracking): listed first so QuickBooks knows them, then on each line.
      const classes = [...new Set(rows.filter((r) => r.class).map((r) => r.class))];
      if (classes.length) { out.push('!CLASS\tNAME'); for (const cn of classes) out.push('CLASS\t' + iifText(cn)); }
      out.push('!TRNS\tTRNSID\tTRNSTYPE\tDATE\tACCNT\tNAME\tCLASS\tAMOUNT\tDOCNUM\tMEMO');
      out.push('!SPL\tSPLID\tTRNSTYPE\tDATE\tACCNT\tNAME\tCLASS\tAMOUNT\tDOCNUM\tMEMO');
      out.push('!ENDTRNS');
      const groups = new Map();
      for (const r of rows) { const k = String(r.entry_date).slice(0, 10) + '|' + r.book; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
      let journals = 0;
      const emit = (date, doc, memo, lines) => {
        if (lines.length < 2) return;
        lines.forEach((l, i) => out.push([i === 0 ? 'TRNS' : 'SPL', '', 'GENERAL JOURNAL', usDate(date), iifText(l.qb_name), iifText(l.party || ''), iifText(l.class || ''),
          r2(l.amount).toFixed(2), doc, iifText(memo)].join('\t')));
        out.push('ENDTRNS');
        journals++;
      };
      for (const [k, ls] of groups) {
        const [date, book] = k.split('|');
        const doc = 'VAS-' + date.replace(/-/g, '') + '-' + book.slice(0, 3).toUpperCase();
        const memo = 'Vision ' + book + ' summary ' + date;
        const ar = ls.filter((l) => l.qb_type === 'AR'), ap = ls.filter((l) => l.qb_type === 'AP');
        if (ar.length && ap.length) {
          const apSum = r2(ap.reduce((s, l) => s + n(l.amount), 0));
          emit(date, doc + 'P', memo + ' (payables)', [...ap, { qb_name: clearing, amount: -apSum }]);
          emit(date, doc, memo, [...ls.filter((l) => l.qb_type !== 'AP'), { qb_name: clearing, amount: apSum }]);
        } else emit(date, doc, memo, ls);
      }
      const { rows: ex } = await query(`INSERT INTO gl_exports (kind, from_date, to_date, entries, created_by) VALUES ('iif', $1, $2, $3, $4) RETURNING id`,
        [from, to, rows.reduce((s, r) => s + Number(r.entries), 0), req.session.userId]);
      await query(`UPDATE gl_entries SET export_id = $3 WHERE entry_date BETWEEN $1 AND $2 AND export_id IS NULL`, [from, to, ex[0].id]);
      res.set('Content-Type', 'text/plain; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="vision-quickbooks-${from}-to-${to}.iif"`);
      res.set('X-Journals', String(journals));
      res.send(out.join('\r\n') + '\r\n');
    } catch (e) { fail(res, e); }
  });

  app.get('/api/gl/export/csv', ...can('acct.export'), async (req, res) => {
    try {
      const from = dateArg(req.query.from), to = dateArg(req.query.to);
      if (!from || !to || from > to) throw httpError(400, 'Choose a from and to date');
      const { rows } = await query(
        `SELECT e.number, to_char(e.entry_date, 'YYYY-MM-DD') AS date, e.book, e.source_kind, e.source_ref, e.memo AS entry_memo,
                a.code, a.name AS account, a.qb_name, GREATEST(l.amount, 0) AS debit, GREATEST(-l.amount, 0) AS credit, l.party, l.memo
           FROM gl_entries e JOIN gl_lines l ON l.entry_id = e.id JOIN gl_accounts a ON a.id = l.account_id
          WHERE e.entry_date BETWEEN $1 AND $2 ORDER BY e.entry_date, e.id, l.id`, [from, to]);
      const q = (v) => { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
      const cols = ['number', 'date', 'book', 'source_kind', 'source_ref', 'entry_memo', 'code', 'account', 'qb_name', 'debit', 'credit', 'party', 'memo'];
      await query(`INSERT INTO gl_exports (kind, from_date, to_date, entries, created_by) VALUES ('csv', $1, $2, $3, $4)`, [from, to, rows.length, req.session.userId]);
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="vision-journal-${from}-to-${to}.csv"`);
      res.send([cols.join(',')].concat(rows.map((r) => cols.map((c) => q(r[c])).join(','))).join('\n'));
    } catch (e) { fail(res, e); }
  });

  app.get('/api/gl/exports', ...can('acct.view'), async (req, res) => {
    try {
      const { rows } = await query(`SELECT x.*, to_char(x.from_date, 'YYYY-MM-DD') AS from_date, to_char(x.to_date, 'YYYY-MM-DD') AS to_date, u.name AS by_name FROM gl_exports x LEFT JOIN users u ON u.id = x.created_by ORDER BY x.id DESC LIMIT 50`);
      res.json({ exports: rows });
    } catch (e) { fail(res, e); }
  });

  return { postAll };
}

module.exports = { register };
