'use strict';
// =============================================================================
//  Vision Auto Solutions -- Return Merchandise, end to end.
//
//    require('./returns').register(app, { query, getPool, requireAdmin,
//      requireCap, userCan, glPost, arOpenSql, genGiftCardCode, managerByPin,
//      storeTax, commissionSweep, stockDispose })
//
//  ONE return record drives everything. A return is the credit note: it names
//  the sale and the lines that came back, and from it follow
//
//    the credit note    its number, the invoice, the customer, lines, GCT
//    stock              the units go back into stock at the cost they left at;
//                       a line marked open box / damaged / write-off is moved
//                       on at once by the same grading the stock screen uses
//    the money          given back the way the sale was paid, in the same
//                       split: cash from the drawer, card, cheque, bank, store
//                       credit, or credit on the customer's account
//    the receivable     credit on the account comes off the invoice it was
//                       sold on first; what is left is credit the customer can
//                       use on other invoices or be paid out
//    the ledger         gl.js posts the return (the sale's entry backwards)
//                       and each refund, and reverses them when voided
//    commission         commission.js takes back the returned share
//    loyalty            points earned come off, points spent go back
//
//  What can be given back in money is never more than was paid on the invoice.
//  Anything not yet paid for can only come off what the customer owes.
//
//  Tables (schema.sql, RETURN MERCHANDISE): pos_sale_returns_all (and the view
//  pos_sale_returns, which leaves voided ones out), pos_sale_return_items,
//  pos_return_settlements.
// =============================================================================
const nodeCrypto = require('crypto');

const TZ = 'America/Jamaica';
const METHODS = ['cash', 'card', 'cheque', 'bank', 'store_credit', 'account'];
const CONDITIONS = ['restock', 'open_box', 'damaged', 'writeoff'];
const WALKIN = 'walkin@visionautosolutions.local';
// How a tender taken at the sale is given back.
const GIVE_BACK = { cash: 'cash', card: 'card', cheque: 'cheque', bank: 'bank', transfer: 'bank', account: 'account', charge: 'account',
  credit_note: 'account', gift_card: 'store_credit', store_credit: 'store_credit', loyalty: 'store_credit' };

function register(app, deps) {
  const { query, getPool, requireAdmin, requireCap, userCan, glPost, arOpenSql, genGiftCardCode, managerByPin, storeTax, commissionSweep, stockDispose } = deps;
  const n = (v) => (v == null || v === '' ? 0 : Number(v));
  const r2 = (v) => Math.round(n(v) * 100) / 100;
  const money = (v) => 'J$' + r2(v).toLocaleString('en-JM', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  function httpError(status, msg) { const e = new Error(msg); e.status = status; e.publicMessage = msg; return e; }
  function fail(res, e) { const s = e.status || 500; if (s >= 500) console.error('[returns]', e); res.status(s).json({ error: e.publicMessage || e.message }); }
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
  // The ledger and the commission run on their own timers too; this only makes
  // the entries show at once.
  function afterwards() {
    Promise.resolve().then(() => glPost && glPost()).catch((e) => console.warn('[returns] post', e.message))
      .then(() => commissionSweep && commissionSweep()).catch((e) => console.warn('[returns] commission', e.message));
  }

  // The shift whose drawer cash goes out of (or back into): this device's
  // till, else the shop's default till. None open = no drawer to count it in.
  async function tillSession(req) {
    try {
      const key = req.get && req.get('x-station-key');
      let stationId = null;
      if (key && key.length >= 20) {
        const { rows } = await query('SELECT id FROM pos_stations WHERE device_key_hash = $1 AND is_active', [nodeCrypto.createHash('sha256').update(String(key)).digest('hex')]);
        if (rows[0]) stationId = rows[0].id;
      }
      if (!stationId) stationId = parseInt(await setting('cash_default_station_id', ''), 10) || null;
      if (!stationId) return null;
      const { rows } = await query(`SELECT id FROM till_sessions WHERE station_id = $1 AND status = 'open'`, [stationId]);
      return rows[0] ? rows[0].id : null;
    } catch (_) { return null; }
  }
  async function isManager(req) {
    const { rows } = await query('SELECT admin_role FROM users WHERE id = $1', [req.session.userId]);
    return !!rows[0] && ['owner', 'manager'].includes(rows[0].admin_role);
  }
  // A manager's say-so: the person signed in is one, or a manager keys their PIN.
  async function managerApproval(req, pin) {
    if (await isManager(req)) return req.session.userId;
    if (pin && managerByPin) { const m = await managerByPin(pin); if (m) return m.id; }
    return null;
  }
  async function nextNumber(c) {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('pos_return_number'))`);
    const year = new Date().getFullYear();
    const { rows } = await c.query(
      `SELECT COALESCE(MAX(NULLIF(regexp_replace(return_number, '^RET-[0-9]{4}-', ''), '')::int), 0) AS m
         FROM pos_sale_returns_all WHERE return_number ~ $1`, ['^RET-' + year + '-[0-9]+$']);
    return 'RET-' + year + '-' + String(rows[0].m + 1).padStart(5, '0');
  }
  async function realCustomer(c, id) {
    if (!id) return null;
    const { rows } = await c.query(`SELECT id, COALESCE(NULLIF(name, ''), email) AS name, email FROM users WHERE id = $1 AND NOT COALESCE(is_staff, false)`, [id]);
    return rows[0] && rows[0].email !== WALKIN ? rows[0] : null;
  }

  // ------------------------------------------------------ what was paid --
  // Money actually paid on an invoice: tenders at the till plus account
  // payments put against it later. Credit notes and write-offs are not money.
  async function paidOnSale(c, sale) {
    const { rows } = await c.query(
      `SELECT (COALESCE(s.amount_paid_usd, 0)
               + COALESCE((SELECT SUM(x.amount) FROM ar_applications x JOIN account_payments ap ON ap.id = x.payment_id
                            WHERE x.sale_id = s.id AND ap.method NOT IN ('credit_note', 'writeoff')), 0)
               + COALESCE((SELECT SUM(ap.amount_usd) FROM account_payments ap
                            WHERE ap.reference = s.receipt_number AND ap.method NOT IN ('credit_note', 'writeoff')
                              AND NOT EXISTS (SELECT 1 FROM ar_applications x WHERE x.payment_id = ap.id)), 0))::float AS paid
         FROM pos_sales s WHERE s.id = $1`, [sale.id]);
    return r2(Math.min(n(sale.total_usd), rows[0] ? rows[0].paid : 0));
  }
  // Money and store credit already given back on this invoice's returns.
  async function givenBack(c, saleId) {
    const { rows } = await c.query(
      `SELECT COALESCE(SUM(st.amount_usd), 0)::float AS t FROM pos_return_settlements st JOIN pos_sale_returns r ON r.id = st.return_id
        WHERE r.sale_id = $1 AND st.voided_at IS NULL AND st.method <> 'account'`, [saleId]);
    return r2(rows[0].t);
  }
  async function openOnSale(c, saleId) {
    if (!arOpenSql) return 0;
    const { rows } = await c.query(`SELECT GREATEST(o.charged - o.settled, 0)::float AS open FROM (${arOpenSql}) o WHERE o.doc = 'sale' AND o.id = $1`, [saleId]);
    return rows[0] ? r2(rows[0].open) : 0;
  }
  // How the sale was paid, as shares to give back in.
  function tenderShares(sale, payments) {
    const by = {};
    for (const p of payments) { const k = GIVE_BACK[String(p.method || '').toLowerCase()] || 'cash'; by[k] = r2((by[k] || 0) + n(p.amount_usd)); }
    if (!Object.keys(by).length) {
      // An invoice with no tender rows (brought over from the old system).
      const total = n(sale.total_usd), paid = sale.amount_paid_usd == null ? total : Math.min(total, n(sale.amount_paid_usd));
      const k = GIVE_BACK[String(sale.payment_method || '').toLowerCase()] || 'cash';
      if (paid > 0.005) by[k === 'account' ? 'cash' : k] = r2(paid);
      if (total - paid > 0.005) by.account = r2(total - paid);
    }
    return by;
  }
  // Split `amount` the way the sale was paid; money never more than `room`.
  function splitLikeSale(amount, shares, room, canAccount, forceMethod) {
    let out = {};
    if (forceMethod && forceMethod !== 'account') out[forceMethod] = amount;
    else if (forceMethod === 'account') out.account = amount;
    else {
      const keys = Object.keys(shares).filter((k) => shares[k] > 0), tot = keys.reduce((t, k) => t + shares[k], 0);
      if (!keys.length || tot <= 0) out.cash = amount;
      else {
        let left = amount;
        keys.forEach((k, i) => { const a = i === keys.length - 1 ? r2(left) : r2(amount * shares[k] / tot); out[k] = a; left = r2(left - a); });
      }
    }
    let moneyOut = r2(Object.keys(out).filter((k) => k !== 'account').reduce((t, k) => t + out[k], 0));
    let over = r2(moneyOut - Math.max(0, room));
    if (over > 0.005) {
      for (const k of Object.keys(out).filter((x) => x !== 'account').sort((a, b) => out[b] - out[a])) {
        const cut = Math.min(out[k], over); out[k] = r2(out[k] - cut); over = r2(over - cut);
        out.account = r2((out.account || 0) + cut);
        if (over <= 0.005) break;
      }
    }
    if (out.account > 0.005 && !canAccount) {
      throw httpError(400, 'Only ' + money(Math.max(0, room)) + ' has been paid on this invoice and not yet given back, so only that much can be refunded. '
        + 'The rest was never paid; it can only come off a customer account, and this sale has none.');
    }
    return Object.keys(out).filter((k) => out[k] > 0.005).map((k) => ({ method: k, amount: r2(out[k]) }));
  }
  // The split the counter asked for, checked.
  function checkSplit(list, amount, room, canAccount) {
    const by = {};
    for (const x of list) {
      const m = String(x && x.method || '').toLowerCase(), a = r2(x && x.amount);
      if (!METHODS.includes(m)) throw httpError(400, 'Give it back by cash, card, cheque, bank, store credit or on the account');
      if (!(a > 0)) continue;
      by[m] = { method: m, amount: r2(((by[m] || {}).amount || 0) + a), reference: String(x.reference || (by[m] || {}).reference || '').slice(0, 60) || null };
    }
    const out = Object.values(by), total = r2(out.reduce((t, x) => t + x.amount, 0));
    if (Math.abs(total - amount) > 0.01) throw httpError(400, 'The amounts given back add up to ' + money(total) + ' but the return is worth ' + money(amount));
    if (out.length && total !== amount) out[0].amount = r2(out[0].amount + (amount - total));
    const moneyOut = r2(out.filter((x) => x.method !== 'account').reduce((t, x) => t + x.amount, 0));
    if (moneyOut > room + 0.01) {
      throw httpError(400, 'Only ' + money(Math.max(0, room)) + ' has been paid on this invoice and not yet given back, so no more than that can go back as money or store credit. '
        + (canAccount ? 'Put the other ' + money(moneyOut - Math.max(0, room)) + ' on the customer\'s account.' : 'The rest was never paid.'));
    }
    if (out.some((x) => x.method === 'account') && !canAccount) throw httpError(400, 'This sale has no customer account to credit');
    return out;
  }

  // ------------------------------------------------- writing it all down --
  // The part of a return every kind shares: header, lines, stock, how it was
  // given back, loyalty. `w` is the worked-out return.
  async function writeReturn(c, req, w) {
    const number = await nextNumber(c);
    const single = w.settlements.length === 1 ? w.settlements[0].method : (w.settlements.length ? 'split' : 'none');
    const till = w.settlements.some((s) => s.method === 'cash') ? await tillSession(req) : null;
    // Store credit is a new gift card.
    let storeCode = null;
    for (const s of w.settlements) {
      if (s.method !== 'store_credit') continue;
      storeCode = genGiftCardCode();
      const { rows: gc } = await c.query(
        `INSERT INTO gift_cards (code, initial_balance_usd, balance_usd, issued_to_name, issued_to_phone, issued_by, notes) VALUES ($1,$2,$2,$3,$4,$5,$6) RETURNING id`,
        [storeCode, s.amount, w.customerName || null, w.customerPhone || null, req.session.userId, 'Store credit for return ' + number + (w.sale ? ' on sale ' + (w.sale.receipt_number || w.sale.id) : '')]);
      await c.query(`INSERT INTO gift_card_transactions (gift_card_id, delta_usd, reason, reference, performed_by) VALUES ($1,$2,'issue',$3,$4)`,
        [gc[0].id, s.amount, number, req.session.userId]);
      s.gift_card_code = storeCode;
    }
    const { rows: head } = await c.query(
      `INSERT INTO pos_sale_returns_all (sale_id, return_number, reason, refund_method, refund_subtotal_usd, refund_discount_usd, refund_tax_usd, refund_total_usd, store_credit_code,
                                         loyalty_points_clawed_back, loyalty_points_recredited, notes, processed_by, customer_id, customer_name, customer_phone, location_id,
                                         restock_fee_pct, restock_fee_usd, no_receipt, approved_by, is_exchange, till_session_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) RETURNING id, created_at`,
      [w.sale ? w.sale.id : null, number, w.reason, single, w.subtotal, w.discount, w.tax, w.refundTotal, storeCode, w.pointsBack, w.pointsRecredit, w.notes, req.session.userId,
       w.customerId || null, w.customerName || null, w.customerPhone || null, w.locationId || null, w.feePct, w.fee, !!w.noReceipt, w.approvedBy || null, !!w.exchange, till]);
    const id = head[0].id;

    if (w.locationId) await c.query(`SELECT set_config('vision.location_id', $1, true)`, [String(w.locationId)]);   // back into the sale's store
    for (const l of w.lines) {
      const { rows: li } = await c.query(
        `INSERT INTO pos_sale_return_items (return_id, sale_item_id, qty, refund_usd, product_img, description, unit_price_usd, unit_cost, tax_usd, prorate_pct, condition)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [id, l.saleItemId || null, l.qty, l.refund, l.img || null, l.description, l.unitPrice, l.unitCost, l.tax, l.pct, l.condition]);
      if (!l.img || !l.stocked) continue;
      await c.query(`SELECT set_config('vision.stock_reason', 'return', true)`);   // stock ledger: why it moved (the return's own journal carries the value)
      await c.query('UPDATE products SET stock_count = stock_count + $1 WHERE img = $2', [l.qty, l.img]);
      // Not fit to go back on the shelf: moved on by the same grading the stock screen uses.
      if (l.condition !== 'restock' && stockDispose) {
        const d = await stockDispose(c, { img: l.img, qty: l.qty, kind: l.condition, source: 'return', sourceRef: String(li[0].id), note: 'Return ' + number, userId: req.session.userId });
        await c.query(`UPDATE pos_sale_return_items SET grade = $2, graded_by = $3, graded_at = NOW(), disposition_id = $4 WHERE id = $1`,
          [li[0].id, l.condition === 'open_box' ? 'B' : 'C', req.session.userId, d ? d.id : null]);
      }
    }

    // How it was given back.
    let applied = 0, creditLeft = 0;
    for (const s of w.settlements) {
      let payId = null;
      if (s.method === 'account') {
        const { rows: ap } = await c.query(
          `INSERT INTO account_payments_all (customer_id, amount_usd, method, reference, notes, received_by, paid_on, return_id)
           VALUES ($1,$2,'credit_note',$3,$4,$5,(NOW() AT TIME ZONE '${TZ}')::date,$6) RETURNING id`,
          [w.customerId, s.amount, number, 'Credit note ' + number + (w.sale ? ' for ' + (w.sale.invoice_number || w.sale.receipt_number || 'sale ' + w.sale.id) : ''), req.session.userId, id]);
        payId = ap[0].id;
        // Off the invoice it was sold on first; the rest is credit on the account.
        const open = w.sale ? await openOnSale(c, w.sale.id) : 0;
        applied = r2(Math.min(open, s.amount));
        if (applied > 0) await c.query(`INSERT INTO ar_applications (payment_id, sale_id, amount, applied_by) VALUES ($1,$2,$3,$4)`, [payId, w.sale.id, applied, req.session.userId]);
        creditLeft = r2(s.amount - applied);
      }
      const { rows: st } = await c.query(
        `INSERT INTO pos_return_settlements (return_id, method, amount_usd, reference, gift_card_code, account_payment_id, till_session_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [id, s.method, s.amount, s.reference || null, s.gift_card_code || null, payId, s.method === 'cash' ? till : null, req.session.userId]);
      s.id = st[0].id;
    }

    if (w.customerId && w.pointsBack > 0) await c.query(`INSERT INTO points_transactions (user_id, delta, reason, reference_id) VALUES ($1,$2,'return_clawback',$3)`, [w.customerId, -w.pointsBack, id]);
    if (w.customerId && w.pointsRecredit > 0) await c.query(`INSERT INTO points_transactions (user_id, delta, reason, reference_id) VALUES ($1,$2,'return_recredit',$3)`, [w.customerId, w.pointsRecredit, id]);

    return {
      ok: true, id, return_number: number, credit_note_number: number, created_at: head[0].created_at,
      refund_subtotal_usd: w.subtotal, refund_discount_usd: w.discount, refund_tax_usd: w.tax,
      credit_total_usd: r2(w.refundTotal + w.fee), restock_fee_usd: w.fee, refund_total_usd: w.refundTotal,
      refund_method: single, settlements: w.settlements, store_credit_code: storeCode,
      account_credit_applied: applied, account_credit_left: creditLeft, cash_from_till_session: till,
      loyalty_points_clawed_back: w.pointsBack, loyalty_points_recredited: w.pointsRecredit,
    };
  }

  // A restocking fee: a percentage of the goods, or a set amount.
  function feeFor(b, goods, gross, dfltPct) {
    let pct = b.restock_fee_pct != null && b.restock_fee_pct !== '' ? n(b.restock_fee_pct) : (b.restock_fee_usd != null && b.restock_fee_usd !== '' ? 0 : n(dfltPct));
    if (!(pct >= 0 && pct <= 100)) throw httpError(400, 'A restocking fee is 0 to 100%');
    let fee = b.restock_fee_usd != null && b.restock_fee_usd !== '' ? r2(b.restock_fee_usd) : r2(goods * pct / 100);
    if (fee < 0) throw httpError(400, 'A restocking fee cannot be negative');
    if (fee > gross) fee = gross;
    if (fee > 0 && !pct && goods > 0) pct = Math.round(fee / goods * 10000) / 100;
    return { pct: Math.min(pct, 999.99), fee };
  }

  // ---------------------------------------------- return against a sale --
  // POST body: items [{sale_item_id, qty, prorate_pct?, condition?}], and how
  // to give it back: nothing (the way the sale was paid), refund_method (all of
  // it one way), or settlements [{method, amount, reference}]. Also reason,
  // notes, restock_fee_pct | restock_fee_usd, exchange, manager_pin, dry_run.
  app.post('/api/admin/pos/sales/:id/return', requireAdmin, requireCap('pos.refund'), async (req, res) => {
    try {
      const b = req.body || {};
      const reqItems = Array.isArray(b.items) ? b.items : [];
      if (!reqItems.length) throw httpError(400, 'At least one line item required');
      if (b.refund_method != null && b.refund_method !== '' && !METHODS.includes(b.refund_method)) throw httpError(400, 'refund_method must be cash, card, cheque, bank, store_credit or account');
      const dfltFee = await setting('returns_restock_fee_pct', '0'), windowDays = parseInt(await setting('returns_window_days', '0'), 10) || 0;
      const out = await tx(async (c) => {
        const { rows: sr } = await c.query('SELECT * FROM pos_sales WHERE id = $1 FOR UPDATE', [parseInt(req.params.id, 10) || 0]);
        if (!sr.length) throw httpError(404, 'Sale not found');
        const sale = sr[0];
        if (sale.voided) throw httpError(400, 'Cannot return items from a voided sale');
        if (/^CN/i.test(sale.receipt_number || '') || n(sale.total_usd) < 0) throw httpError(400, 'This is itself a credit note');
        let approvedBy = null;
        if (windowDays > 0 && Date.now() - new Date(sale.created_at).getTime() > windowDays * 86400000) {
          approvedBy = await managerApproval(req, b.manager_pin);
          if (!approvedBy) throw httpError(403, 'This sale is more than ' + windowDays + ' days old: a manager must approve the return.');
        }
        const { rows: saleItems } = await c.query(
          `SELECT i.*, COALESCE(i.unit_cost, p.cost_usd, 0) AS cost, (p.img IS NOT NULL) AS stocked FROM pos_sale_items i LEFT JOIN products p ON p.img = i.product_img WHERE i.sale_id = $1`, [sale.id]);
        const itemById = {};
        saleItems.forEach((it) => { itemById[it.id] = it; });
        const { rows: already } = await c.query(
          `SELECT ri.sale_item_id, COALESCE(SUM(ri.qty), 0)::int AS qty FROM pos_sale_return_items ri JOIN pos_sale_returns r ON r.id = ri.return_id
            WHERE r.sale_id = $1 GROUP BY ri.sale_item_id`, [sale.id]);
        const returned = {};
        already.forEach((r) => { returned[r.sale_item_id] = r.qty; });

        // The same line asked for twice counts once, with the quantities added.
        const want = {};
        for (const it of reqItems) {
          const sid = parseInt(it.sale_item_id, 10), q = Number(it.qty);
          if (!Number.isInteger(q) || q < 0) throw httpError(400, 'Return quantities must be whole numbers');
          if (q === 0) continue;
          const pct = it.prorate_pct != null && it.prorate_pct !== '' ? Math.max(0, Math.min(100, n(it.prorate_pct))) : 100;
          const condition = CONDITIONS.includes(it.condition) ? it.condition : 'restock';
          if (want[sid]) want[sid].qty += q; else want[sid] = { qty: q, pct, condition };
        }
        if (!Object.keys(want).length) throw httpError(400, 'Enter a return quantity for at least one item');

        const lines = [];
        let subtotal = 0, lineTax = 0, taxKnown = true;
        for (const [key, x] of Object.entries(want)) {
          const item = itemById[key];
          if (!item) throw httpError(400, 'sale_item_id ' + key + ' is not on this sale');
          const left = item.qty - (returned[item.id] || 0);
          if (x.qty > left) {
            throw httpError(400, left > 0
              ? 'Only ' + left + ' of ' + item.qty + ' unit(s) of "' + item.description + '" can still be returned (' + (returned[item.id] || 0) + ' already returned on this invoice)'
              : 'All ' + item.qty + ' unit(s) of "' + item.description + '" have already been returned on this invoice');
          }
          // What the customer paid for the line (after its own discount, with any
          // core charge or fee spread over its units), for the units coming back.
          const lineNet = item.total_usd != null ? n(item.total_usd) : n(item.unit_price_usd) * item.qty + n(item.core_charge_usd) + n(item.env_fee_usd) - n(item.discount_usd);
          const refund = r2(lineNet / item.qty * x.qty * x.pct / 100);
          let tax = 0;
          if (item.tax_usd != null) tax = r2(n(item.tax_usd) / item.qty * x.qty * x.pct / 100); else taxKnown = false;
          subtotal += refund; lineTax += tax;
          lines.push({ saleItemId: item.id, qty: x.qty, refund, tax, pct: x.pct, condition: x.condition, img: item.product_img, stocked: item.stocked,
            description: item.description, unitPrice: item.unit_price_usd, unitCost: n(item.cost) });
        }
        subtotal = r2(subtotal);

        // The sale's whole-ticket discount and GCT, in the same share as the goods.
        const { rows: prev } = await c.query(
          `SELECT COALESCE(SUM(refund_subtotal_usd), 0)::float AS sub, COALESCE(SUM(refund_discount_usd), 0)::float AS disc, COALESCE(SUM(refund_tax_usd), 0)::float AS tax,
                  COALESCE(SUM(refund_total_usd + restock_fee_usd), 0)::float AS credit FROM pos_sale_returns WHERE sale_id = $1`, [sale.id]);
        const share = n(sale.subtotal_usd) > 0 ? Math.min(1, subtotal / n(sale.subtotal_usd)) : 0;
        const goodsTax = Math.max(0, r2(n(sale.tax_usd) - n(sale.freight_tax_usd)));
        const discount = Math.max(0, Math.min(r2(n(sale.discount_usd) * share), r2(n(sale.discount_usd) - prev[0].disc)));
        let tax = taxKnown ? r2(lineTax) : r2(goodsTax * share);
        tax = Math.max(0, Math.min(tax, r2(goodsTax - prev[0].tax)));
        if (!taxKnown) { let left = tax; lines.forEach((l, i) => { l.tax = i === lines.length - 1 ? r2(left) : r2(tax * (subtotal ? l.refund / subtotal : 0)); left = r2(left - l.tax); }); }
        const gross = r2(subtotal - discount + tax);
        if (gross + prev[0].credit > n(sale.total_usd) + 0.01) throw httpError(400, 'This return (' + money(gross) + ') with what has already been returned (' + money(prev[0].credit) + ') is more than the invoice (' + money(sale.total_usd) + ')');
        const { pct: feePct, fee } = feeFor(b, r2(subtotal - discount), gross, dfltFee);
        const refundTotal = r2(gross - fee);

        // How it goes back: never more money than was paid and not yet given back.
        const cust = await realCustomer(c, sale.customer_id);
        const room = r2((await paidOnSale(c, sale)) - (await givenBack(c, sale.id)));
        const { rows: pays } = await c.query('SELECT method, amount_usd FROM sale_payments WHERE sale_id = $1', [sale.id]);
        let settlements = [];
        if (refundTotal > 0) {
          if (Array.isArray(b.settlements) && b.settlements.length) settlements = checkSplit(b.settlements, refundTotal, room, !!cust);
          else settlements = splitLikeSale(refundTotal, tenderShares(sale, pays), room, !!cust, b.exchange ? 'store_credit' : (b.refund_method || null));
        }
        const w = {
          sale, lines, subtotal, discount, tax, fee, feePct, refundTotal, settlements, reason: b.reason ? String(b.reason).slice(0, 300) : null, notes: b.notes ? String(b.notes).slice(0, 500) : null,
          customerId: sale.customer_id, customerName: sale.customer_name, customerPhone: sale.customer_phone, locationId: sale.location_id, approvedBy, exchange: !!b.exchange,
          pointsBack: sale.customer_id ? Math.floor(n(sale.loyalty_points_earned) * share) : 0, pointsRecredit: sale.customer_id ? Math.round(n(sale.loyalty_points_redeemed) * share) : 0,
        };
        if (b.dry_run === true) {
          return { ok: true, dry_run: true, refund_subtotal_usd: subtotal, refund_discount_usd: discount, refund_tax_usd: tax, credit_total_usd: gross, restock_fee_pct: feePct, restock_fee_usd: fee,
            refund_total_usd: refundTotal, settlements, paid_usd: await paidOnSale(c, sale), refundable_usd: Math.max(0, room), owing_usd: await openOnSale(c, sale.id), has_account: !!cust,
            lines: lines.map((l) => ({ sale_item_id: l.saleItemId, qty: l.qty, refund_usd: l.refund, tax_usd: l.tax })) };
        }
        return writeReturn(c, req, w);
      });
      if (!out.dry_run) afterwards();
      res.json(out);
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------ return, no receipt --
  // No sale to reverse, so a manager approves it and the price is the counter's
  // call (never above today's price). Store credit unless a manager says cash.
  app.post('/api/admin/pos/returns/no-receipt', requireAdmin, requireCap('pos.refund'), async (req, res) => {
    try {
      const b = req.body || {};
      const approvedBy = await managerApproval(req, b.manager_pin);
      if (!approvedBy) throw httpError(403, 'A return with no receipt needs a manager: sign in as one or key a manager PIN.');
      const reason = String(b.reason || '').trim().slice(0, 300);
      if (reason.length < 3) throw httpError(400, 'Say why there is no receipt');
      const method = b.refund_method || 'store_credit';
      if (!['cash', 'card', 'cheque', 'bank', 'store_credit', 'account'].includes(method)) throw httpError(400, 'Give it back by store credit, cash, card, cheque, bank or on the account');
      const items = (Array.isArray(b.items) ? b.items : []).filter((x) => x && x.product_img && Number(x.qty) > 0);
      if (!items.length) throw httpError(400, 'Which part came back, and how many?');
      const out = await tx(async (c) => {
        const cust = await realCustomer(c, parseInt(b.customer_id, 10) || null);
        if (method === 'account' && !cust) throw httpError(400, 'Choose the customer whose account gets the credit');
        const lines = [];
        for (const x of items) {
          const q = Number(x.qty);
          if (!Number.isInteger(q) || q <= 0) throw httpError(400, 'Return quantities must be whole numbers');
          const { rows: p } = await c.query('SELECT img, name, price_usd, cost_usd FROM products WHERE img = $1 OR sku = $1 OR barcode = $1 ORDER BY (img = $1) DESC LIMIT 1', [String(x.product_img).trim()]);
          if (!p.length) throw httpError(404, 'Part ' + x.product_img + ' not found');
          const price = x.unit_price_usd != null && x.unit_price_usd !== '' ? r2(x.unit_price_usd) : r2(p[0].price_usd);
          if (!(price >= 0)) throw httpError(400, 'Price for ' + p[0].name);
          if (price > r2(p[0].price_usd) + 0.005) throw httpError(400, p[0].name + ' sells for ' + money(p[0].price_usd) + ': a return with no receipt cannot be given more than that');
          lines.push({ saleItemId: null, qty: q, refund: r2(price * q), tax: 0, pct: 100, condition: CONDITIONS.includes(x.condition) ? x.condition : 'restock', img: p[0].img, stocked: true,
            description: p[0].name, unitPrice: price, unitCost: n(p[0].cost_usd) });
        }
        // GCT at today's rates (the price is before GCT, as on a sale).
        if (storeTax && b.tax_exempt !== true) {
          try {
            const cfg = await storeTax.config(query), rates = await storeTax.ratesFor(query, lines.map((l) => l.img), cfg);
            const t = storeTax.compute(cfg, rates, lines.map((l) => ({ img: l.img, net: l.refund })), 0, 0, {});
            t.lines.forEach((x, i) => { lines[i].tax = r2(x.tax); });
          } catch (e) { console.warn('[returns] no-receipt GCT', e.message); }
        }
        const subtotal = r2(lines.reduce((t, l) => t + l.refund, 0)), tax = r2(lines.reduce((t, l) => t + l.tax, 0)), gross = r2(subtotal + tax);
        const { pct: feePct, fee } = feeFor(b, subtotal, gross, 0);
        const refundTotal = r2(gross - fee);
        const { rows: loc } = await c.query(`SELECT id FROM store_locations WHERE is_default ORDER BY sort, id LIMIT 1`).catch(() => ({ rows: [] }));
        const w = { sale: null, lines, subtotal, discount: 0, tax, fee, feePct, refundTotal, settlements: refundTotal > 0 ? [{ method, amount: refundTotal, reference: b.reference || null }] : [],
          reason, notes: b.notes ? String(b.notes).slice(0, 500) : null, customerId: cust ? cust.id : null, customerName: cust ? cust.name : (b.customer_name ? String(b.customer_name).slice(0, 120) : null),
          customerPhone: b.customer_phone ? String(b.customer_phone).slice(0, 40) : null, locationId: loc[0] ? loc[0].id : null, approvedBy, noReceipt: true, exchange: !!b.exchange, pointsBack: 0, pointsRecredit: 0 };
        if (b.dry_run === true) return { ok: true, dry_run: true, refund_subtotal_usd: subtotal, refund_tax_usd: tax, credit_total_usd: gross, restock_fee_usd: fee, refund_total_usd: refundTotal, settlements: w.settlements };
        return writeReturn(c, req, w);
      });
      if (!out.dry_run) afterwards();
      res.json(out);
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------- credit notes --
  // Every credit note in one list: returns made here, and the credit notes
  // brought over from the old system (negative CN sales), marked `legacy`.
  const LIST_SQL = `
    SELECT r.id, false AS legacy, r.return_number, r.sale_id, s.receipt_number, s.invoice_number, COALESCE(s.voided, false) AS sale_voided,
           COALESCE(NULLIF(r.customer_name, ''), NULLIF(s.customer_name, ''), 'Walk-in') AS customer_name, COALESCE(r.customer_id, s.customer_id) AS customer_id,
           r.refund_subtotal_usd::float AS refund_subtotal_usd, r.refund_discount_usd::float AS refund_discount_usd, r.refund_tax_usd::float AS refund_tax_usd,
           (r.refund_total_usd + r.restock_fee_usd)::float AS credit_total_usd, r.restock_fee_usd::float AS restock_fee_usd, r.refund_total_usd::float AS refund_total_usd,
           r.refund_method, r.store_credit_code, r.reason, r.notes, r.no_receipt, r.is_exchange, r.created_at, r.voided_at, r.void_reason,
           COALESCE(u.name, u.email) AS processed_by_name,
           COALESCE((SELECT json_agg(json_build_object('id', st.id, 'method', st.method, 'amount', st.amount_usd::float, 'kind', st.kind, 'reference', st.reference,
                                                        'gift_card_code', st.gift_card_code, 'voided', st.voided_at IS NOT NULL) ORDER BY st.id)
                       FROM pos_return_settlements st WHERE st.return_id = r.id), '[]') AS settlements,
           (SELECT COALESCE(SUM(ri.qty), 0)::int FROM pos_sale_return_items ri WHERE ri.return_id = r.id) AS units
      FROM pos_sale_returns_all r LEFT JOIN pos_sales s ON s.id = r.sale_id LEFT JOIN users u ON u.id = r.processed_by`;
  const LEGACY_SQL = `
    SELECT NULL::int AS id, true AS legacy, s.receipt_number AS return_number, s.id AS sale_id, s.receipt_number, s.invoice_number, COALESCE(s.voided, false) AS sale_voided,
           COALESCE(NULLIF(s.customer_name, ''), 'Walk-in') AS customer_name, s.customer_id,
           abs(s.subtotal_usd)::float, abs(COALESCE(s.discount_usd, 0))::float, abs(COALESCE(s.tax_usd, 0))::float,
           abs(s.total_usd)::float, 0::float, abs(s.total_usd)::float,
           s.payment_method, NULL::text, s.notes, NULL::text, false, false, s.created_at, NULL::timestamptz, NULL::text,
           COALESCE(u.name, u.email, s.cashier_name),
           '[]'::json, (SELECT COALESCE(SUM(abs(i.qty)), 0)::int FROM pos_sale_items i WHERE i.sale_id = s.id)
      FROM pos_sales s LEFT JOIN users u ON u.id = s.cashier_id
     WHERE (s.receipt_number LIKE 'CN%' OR s.total_usd < 0)`;
  app.get('/api/admin/pos/returns', requireAdmin, async (req, res) => {
    try {
      const q = String(req.query.q || '').trim().slice(0, 60);
      const cid = parseInt(req.query.customer_id, 10) || null;
      const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
      const today = new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10);
      const from = isDate(req.query.from) ? req.query.from : (q || cid ? '1900-01-01' : today), to = isDate(req.query.to) ? req.query.to : (q || cid ? '2999-12-31' : from);
      const showVoid = req.query.voided !== '0';
      const like = '%' + q.replace(/[%_]/g, '\\$&') + '%';
      const { rows } = await query(
        `SELECT * FROM (
           SELECT * FROM (${LIST_SQL}) a
            WHERE ($1 = '' OR a.return_number ILIKE $2 OR a.receipt_number ILIKE $2 OR a.invoice_number ILIKE $2 OR a.customer_name ILIKE $2 OR a.store_credit_code ILIKE $2)
           UNION ALL
           SELECT * FROM (${LEGACY_SQL}) b
            WHERE ($1 = '' OR b.return_number ILIKE $2 OR b.invoice_number ILIKE $2 OR b.customer_name ILIKE $2)
         ) x
         WHERE (x.created_at AT TIME ZONE '${TZ}')::date BETWEEN $3::date AND $4::date
           AND ($5::int IS NULL OR x.customer_id = $5) AND ($6 OR x.voided_at IS NULL)
         ORDER BY x.created_at DESC LIMIT 300`, [q, like, from, to, cid, showVoid]);
      const live = rows.filter((r) => !r.voided_at);
      res.json({ returns: rows, from, to, totals: { count: live.length, credit: r2(live.reduce((t, r) => t + n(r.credit_total_usd), 0)), tax: r2(live.reduce((t, r) => t + n(r.refund_tax_usd), 0)),
        refunded: r2(live.reduce((t, r) => t + n(r.refund_total_usd), 0)) } });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/admin/pos/returns/settings', requireAdmin, async (req, res) => {
    try { res.json({ restock_fee_pct: n(await setting('returns_restock_fee_pct', '0')), window_days: parseInt(await setting('returns_window_days', '0'), 10) || 0, is_manager: await isManager(req) }); }
    catch (e) { fail(res, e); }
  });
  app.put('/api/admin/pos/returns/settings', requireAdmin, async (req, res) => {
    try {
      if (!(await isManager(req))) throw httpError(403, 'A manager sets the returns policy');
      const b = req.body || {};
      const put = (k, v) => query(`INSERT INTO warehouse_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [k, String(v)]);
      if (b.restock_fee_pct !== undefined) { const p = n(b.restock_fee_pct); if (!(p >= 0 && p <= 100)) throw httpError(400, 'A restocking fee is 0 to 100%'); await put('returns_restock_fee_pct', p); }
      if (b.window_days !== undefined) { const d = parseInt(b.window_days, 10) || 0; if (!(d >= 0 && d <= 3650)) throw httpError(400, 'Days 0 to 3650 (0 = no limit)'); await put('returns_window_days', d); }
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // One credit note in full: lines, how it was given back, its journals.
  async function detail(id) {
    const { rows } = await query(`SELECT * FROM (${LIST_SQL}) a WHERE a.id = $1`, [id]);
    if (!rows.length) throw httpError(404, 'Credit note not found');
    const r = rows[0];
    const { rows: items } = await query(
      `SELECT ri.id, ri.sale_item_id, ri.qty, ri.refund_usd::float AS refund_usd, ri.tax_usd::float AS tax_usd, ri.prorate_pct::float AS prorate_pct, ri.condition, ri.grade,
              COALESCE(ri.description, si.description) AS description, COALESCE(ri.product_img, si.product_img) AS product_img,
              COALESCE(ri.unit_price_usd, si.unit_price_usd)::float AS unit_price_usd, ri.unit_cost::float AS unit_cost, p.sku, p.bin_location, p.location
         FROM pos_sale_return_items ri LEFT JOIN pos_sale_items si ON si.id = ri.sale_item_id LEFT JOIN products p ON p.img = COALESCE(ri.product_img, si.product_img)
        WHERE ri.return_id = $1 ORDER BY ri.id`, [id]);
    const { rows: journals } = await query(
      `SELECT e.id, e.number, e.source_kind, to_char(e.entry_date, 'YYYY-MM-DD') AS entry_date, e.memo FROM gl_entries e
        WHERE (e.source_kind IN ('return', 'return_void') AND e.source_id = $1)
           OR (e.source_kind IN ('return_refund', 'return_refund_void') AND e.source_id IN (SELECT id FROM pos_return_settlements WHERE return_id = $1))
        ORDER BY e.id`, [id]).catch(() => ({ rows: [] }));
    const { rows: comm } = await query(
      `SELECT e.id, e.kind, e.amount::float AS amount, e.status, m.name AS rep, cs.number AS statement FROM commission_entries e
         LEFT JOIN mechanics m ON m.id = e.rep_id LEFT JOIN commission_statements cs ON cs.id = e.statement_id WHERE e.return_id = $1 ORDER BY e.id`, [id]).catch(() => ({ rows: [] }));
    return { credit_note: r, items, journals, commission: comm };
  }
  app.get('/api/admin/pos/returns/:id', requireAdmin, async (req, res) => {
    try { res.json(await detail(parseInt(req.params.id, 10) || 0)); } catch (e) { fail(res, e); }
  });

  // ----------------------------------------------------- void a return --
  // Everything the return did is undone: the units leave stock again, the
  // money comes back (cash into the open drawer), store credit is cancelled,
  // credit on the account is withdrawn, points and commission are restored and
  // the ledger entries are reversed.
  app.post('/api/admin/pos/returns/:id/void', requireAdmin, requireCap('pos.void_sale'), async (req, res) => {
    try {
      const reason = String((req.body || {}).reason || '').trim().slice(0, 200);
      if (reason.length < 3) throw httpError(400, 'Say why the return is voided');
      const till = await tillSession(req);
      await tx(async (c) => {
        const { rows } = await c.query('SELECT * FROM pos_sale_returns_all WHERE id = $1 FOR UPDATE', [parseInt(req.params.id, 10) || 0]);
        if (!rows.length) throw httpError(404, 'Credit note not found');
        const r = rows[0];
        if (r.voided_at) throw httpError(409, 'This return is already voided');
        const { rows: items } = await c.query(
          `SELECT ri.*, COALESCE(ri.product_img, si.product_img) AS img FROM pos_sale_return_items ri LEFT JOIN pos_sale_items si ON si.id = ri.sale_item_id WHERE ri.return_id = $1`, [r.id]);
        if (items.some((i) => i.disposition_id)) throw httpError(409, 'Units on this return were already graded open box, damaged or written off. Undo that on the stock screen first.');
        if (r.location_id) await c.query(`SELECT set_config('vision.location_id', $1, true)`, [String(r.location_id)]);
        for (const it of items) {
          if (!it.img) continue;
          const { rows: p } = await c.query('SELECT stock_count FROM products WHERE img = $1 FOR UPDATE', [it.img]);
          if (!p.length) continue;
          if (p[0].stock_count < it.qty) throw httpError(409, 'Only ' + p[0].stock_count + ' of "' + (it.description || it.img) + '" in stock: the returned units have been sold again, so this return cannot be voided.');
          await c.query(`SELECT set_config('vision.stock_reason', 'return', true)`);
          await c.query('UPDATE products SET stock_count = stock_count - $1 WHERE img = $2', [it.qty, it.img]);
        }
        const { rows: sts } = await c.query('SELECT * FROM pos_return_settlements WHERE return_id = $1 AND voided_at IS NULL FOR UPDATE', [r.id]);
        for (const s of sts) {
          if (s.method === 'store_credit' && s.gift_card_code) {
            const { rows: gc } = await c.query('SELECT id, balance_usd FROM gift_cards WHERE code = $1 FOR UPDATE', [s.gift_card_code]);
            if (gc.length) {
              if (n(gc[0].balance_usd) + 0.005 < n(s.amount_usd)) throw httpError(409, 'Store credit ' + s.gift_card_code + ' has already been spent (' + money(gc[0].balance_usd) + ' left of ' + money(s.amount_usd) + '), so this return cannot be voided.');
              await c.query('UPDATE gift_cards SET balance_usd = balance_usd - $1 WHERE id = $2', [s.amount_usd, gc[0].id]);
              await c.query(`INSERT INTO gift_card_transactions (gift_card_id, delta_usd, reason, reference, performed_by) VALUES ($1,$2,'void',$3,$4)`, [gc[0].id, -n(s.amount_usd), r.return_number, req.session.userId]);
            }
          }
          if (s.account_payment_id) await c.query(`UPDATE account_payments_all SET voided_at = NOW(), voided_by = $2, void_reason = $3 WHERE id = $1 AND voided_at IS NULL`, [s.account_payment_id, req.session.userId, 'Return ' + r.return_number + ' voided: ' + reason]);
          await c.query(`UPDATE pos_return_settlements SET voided_at = NOW(), void_reason = $2, void_till_session_id = $3 WHERE id = $1`, [s.id, reason, s.method === 'cash' ? till : null]);
        }
        // Any credit on the account still tied to this return (one paid out in part).
        await c.query(`UPDATE account_payments_all SET voided_at = NOW(), voided_by = $2, void_reason = $3 WHERE return_id = $1 AND voided_at IS NULL`, [r.id, req.session.userId, 'Return ' + r.return_number + ' voided: ' + reason]);
        if (r.customer_id && r.loyalty_points_clawed_back > 0) await c.query(`INSERT INTO points_transactions (user_id, delta, reason, reference_id) VALUES ($1,$2,'return_void',$3)`, [r.customer_id, r.loyalty_points_clawed_back, r.id]);
        if (r.customer_id && r.loyalty_points_recredited > 0) await c.query(`INSERT INTO points_transactions (user_id, delta, reason, reference_id) VALUES ($1,$2,'return_void_recredit',$3)`, [r.customer_id, -r.loyalty_points_recredited, r.id]);
        await c.query(`UPDATE pos_sale_returns_all SET voided_at = NOW(), voided_by = $2, void_reason = $3 WHERE id = $1`, [r.id, req.session.userId, reason]);
      });
      afterwards();
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------- pay out credit on the account --
  // Credit a return left on the customer's account, not used on any invoice,
  // handed over as money after all.
  app.post('/api/admin/pos/returns/:id/refund-credit', requireAdmin, requireCap('pos.refund'), async (req, res) => {
    try {
      const b = req.body || {}, amount = r2(b.amount), method = String(b.method || '');
      if (!['cash', 'card', 'cheque', 'bank'].includes(method)) throw httpError(400, 'Pay it out by cash, card, cheque or bank transfer');
      if (!(amount > 0)) throw httpError(400, 'How much is paid out?');
      const till = method === 'cash' ? await tillSession(req) : null;
      const out = await tx(async (c) => {
        const { rows } = await c.query('SELECT * FROM pos_sale_returns_all WHERE id = $1 AND voided_at IS NULL FOR UPDATE', [parseInt(req.params.id, 10) || 0]);
        if (!rows.length) throw httpError(404, 'Credit note not found (or voided)');
        const r = rows[0];
        const { rows: st } = await c.query(`SELECT st.* FROM pos_return_settlements st WHERE st.return_id = $1 AND st.method = 'account' AND st.voided_at IS NULL AND st.account_payment_id IS NOT NULL FOR UPDATE`, [r.id]);
        if (!st.length) throw httpError(409, 'This return left no credit on the customer\'s account');
        const s = st[0];
        const { rows: ap } = await c.query(
          `SELECT ap.amount_usd::float AS amount, COALESCE((SELECT SUM(amount) FROM ar_applications WHERE payment_id = ap.id), 0)::float AS applied
             FROM account_payments_all ap WHERE ap.id = $1 AND ap.voided_at IS NULL FOR UPDATE OF ap`, [s.account_payment_id]);
        if (!ap.length) throw httpError(409, 'The credit on the account has been voided');
        const free = r2(ap[0].amount - ap[0].applied);
        if (amount > free + 0.005) throw httpError(400, free > 0.005 ? 'Only ' + money(free) + ' of this credit is unused; the rest has gone against invoices.' : 'All of this credit has gone against invoices; nothing is left to pay out.');
        // The credit on the account shrinks by what is paid out.
        const left = r2(ap[0].amount - amount);
        if (left > 0.005) {
          await c.query('UPDATE account_payments_all SET amount_usd = $2 WHERE id = $1', [s.account_payment_id, left]);
          await c.query('UPDATE pos_return_settlements SET amount_usd = $2 WHERE id = $1', [s.id, left]);
        } else {
          await c.query(`UPDATE account_payments_all SET voided_at = NOW(), voided_by = $2, void_reason = $3 WHERE id = $1`, [s.account_payment_id, req.session.userId, 'Credit note ' + r.return_number + ' paid out']);
          await c.query(`UPDATE pos_return_settlements SET voided_at = NOW(), void_reason = 'Paid out' WHERE id = $1`, [s.id]);
        }
        const { rows: ns } = await c.query(
          `INSERT INTO pos_return_settlements (return_id, method, amount_usd, kind, reference, till_session_id, created_by) VALUES ($1,$2,$3,'credit_refund',$4,$5,$6) RETURNING id`,
          [r.id, method, amount, String(b.reference || '').slice(0, 60) || null, till, req.session.userId]);
        return { ok: true, settlement_id: ns[0].id, paid_out: amount, credit_left: Math.max(0, r2(free - amount)) };
      });
      afterwards();
      res.json(out);
    } catch (e) { fail(res, e); }
  });

  return { detail };
}

module.exports = { register };
