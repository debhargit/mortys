// Phase 5 — POS transactions: POST /api/admin/pos/sale, /sales/:id/void,
// /sales/:id/return.
//
// D1 has no interactive transactions, so each is: do every read, compute the
// whole result in JS, then one atomic db.batch() of the writes. The sale id
// (and return id) are pre-assigned from MAX(id)+1 so child inserts can bind
// them as literals instead of relying on last_insert_rowid() mid-batch.
import { d1 } from '../_lib/db.js';
import { adminMw, userCan } from '../_lib/guards.js';
import {
  TAX_RATE, POINTS_USD_RATE, POS_SALE_USD,
  nextReceiptNumber, nextInvoiceNumber, nextReturnNumber, nextId, genGiftCardCode, genRedemptionCode,
} from '../_lib/pos.js';

const r2 = (n) => Math.round(n * 100) / 100;
const cts = (usd) => Math.round((Number(usd) || 0) * 100);

const PAYMENT_METHODS = ['cash', 'card', 'cheque', 'bank', 'loyalty', 'gift_card', 'account'];
const REFUND_METHODS = ['cash', 'card', 'cheque', 'bank', 'store_credit'];

export default function mount(app) {
  // =====================================================================
  //  POST /api/admin/pos/sale
  // =====================================================================
  app.post('/api/admin/pos/sale', adminMw, async (c) => {
    const db = d1(c.env);
    const me = c.get('user');
    const b = await c.req.json().catch(() => ({}));
    const items = Array.isArray(b.items) ? b.items : [];
    if (!items.length) return c.json({ error: 'At least one item required' }, 400);

    // ----- normalise payments -----
    let payments = Array.isArray(b.payments) ? b.payments.slice() : null;
    if (!payments || !payments.length) {
      if (!b.payment_method) return c.json({ error: 'payment_method or payments[] required' }, 400);
      payments = [{ method: b.payment_method, amount_usd: null,
        amount_tendered: b.amount_tendered != null ? Number(b.amount_tendered) : null,
        reference: b.reference || null, notes: null }];
    }
    for (const p of payments) {
      if (!p.method) return c.json({ error: 'Each payment row needs a method' }, 400);
      if (!PAYMENT_METHODS.includes(p.method)) return c.json({ error: 'Unknown payment method: ' + p.method }, 400);
    }

    // ----- permission gates -----
    const lineDisc = items.reduce((s, it) => s + Math.max(0, Number(it.discount_usd || 0)), 0);
    if (lineDisc > 0 && !userCan(me, 'pos.line_discount'))
      return c.json({ error: 'Your account is not allowed to give a per-line discount.' }, 403);
    if (Number(b.discount_usd || 0) > 0 && !userCan(me, 'pos.ticket_discount'))
      return c.json({ error: 'Your account is not allowed to give a whole-ticket discount.' }, 403);
    if (payments.some((p) => p.method === 'account') && !userCan(me, 'pos.charge_to_account'))
      return c.json({ error: 'Your account is not allowed to take a charge / account sale.' }, 403);
    if (b.no_tax === true && !userCan(me, 'pos.no_tax'))
      return c.json({ error: 'Your account is not allowed to switch GCT off.' }, 403);

    // ----- per-product server-side rules -----
    // Trust the product record, not the client, for which images actually
    // carry these -- a checkbox client-side is meaningless if a stale/edited
    // cart line can just omit it. One query covers serial-required, the
    // per-item discount cap, and the restricted-item flags.
    const imgs = [...new Set(items.filter((it) => it.product_img).map((it) => it.product_img))];
    const rules = new Map();
    if (imgs.length) {
      const rows = await db.many(
        `SELECT img, serial_required, max_discount_pct, is_redeemable,
                restricted_id_required, restricted_tax_id_required, restricted_manager_approval
           FROM products WHERE img IN (${imgs.map(() => '?').join(',')})`, ...imgs);
      for (const r of rows) rules.set(r.img, r);
    }
    const missingSerial = items.find((it) => { const r = rules.get(it.product_img); return r && r.serial_required && !String(it.serial_number || '').trim(); });
    if (missingSerial) return c.json({ error: `"${missingSerial.description}" requires a serial number to sell.` }, 400);

    for (const it of items) {
      const r = rules.get(it.product_img);
      const disc = Math.max(0, Number(it.discount_usd || 0));
      if (!r || r.max_discount_pct == null || disc <= 0) continue;
      const gross = (Number(it.unit_price_usd) + Number(it.core_charge_usd || 0) + Number(it.env_fee_usd || 0)) * Number(it.qty);
      if (gross > 0 && (disc / gross) * 100 > Number(r.max_discount_pct) + 0.01) {
        return c.json({ error: `"${it.description}" can only be discounted up to ${Number(r.max_discount_pct)}%` }, 400);
      }
    }

    const needsId = items.some((it) => { const r = rules.get(it.product_img); return r && r.restricted_id_required; });
    if (needsId && !String(b.verify_id_number || '').trim())
      return c.json({ error: 'One or more items require an ID to be recorded before this sale can complete.' }, 400);
    const needsTaxId = items.some((it) => { const r = rules.get(it.product_img); return r && r.restricted_tax_id_required; });
    if (needsTaxId && !String(b.verify_tax_id || '').trim())
      return c.json({ error: 'One or more items require a Tax ID to be recorded before this sale can complete.' }, 400);
    const needsApproval = items.some((it) => { const r = rules.get(it.product_img); return r && r.restricted_manager_approval; });
    if (needsApproval && !String(b.restricted_approved_by || '').trim())
      return c.json({ error: 'One or more items require manager approval before this sale can complete.' }, 400);

    // ----- 1. line totals -----
    // core_charge_usd / env_fee_usd travel per unit (what the product record
    // carries); scale by qty so a line of 3 units with a $5 core each
    // collects $15, not $5 -- and so the return endpoint's per-unit refund
    // (which divides the stored line total back down by qty) comes out right.
    const lineCalc = items.map((it) => {
      const gross = r2((Number(it.unit_price_usd) + Number(it.core_charge_usd || 0) + Number(it.env_fee_usd || 0)) * Number(it.qty));
      const disc = Math.min(gross, Math.max(0, Number(it.discount_usd || 0)));
      return { gross, disc, net: r2(gross - disc) };
    });
    const subtotal = r2(lineCalc.reduce((s, l) => s + l.net, 0));
    const manualDiscount = Math.max(0, Number(b.discount_usd || 0));

    // ----- 2. loyalty redemption -----
    const walkinRow = await db.one("SELECT id FROM users WHERE email = 'walkin@mortysautoparts.local' LIMIT 1");
    const walkinId = walkinRow ? walkinRow.id : -1;
    const isWalkin = b.customer_id && Number(b.customer_id) === walkinId;
    const redeemPts = isWalkin ? 0 : Math.max(0, parseInt(b.loyalty_points_redeemed || 0, 10) || 0);
    let loyaltyDiscount = 0;
    if (redeemPts > 0) {
      if (!b.customer_id) return c.json({ error: 'customer_id required to redeem loyalty points' }, 400);
      const bal = await db.one('SELECT COALESCE(SUM(delta), 0) AS balance FROM points_transactions WHERE user_id = ?', b.customer_id);
      const balance = (bal && bal.balance) || 0;
      if (redeemPts > balance) return c.json({ error: 'Customer only has ' + balance + ' points (tried to redeem ' + redeemPts + ')' }, 400);
      loyaltyDiscount = r2(redeemPts * POINTS_USD_RATE);
    }

    // ----- 2b. customer terms -----
    let limits = null;
    if (b.customer_id && !isWalkin) {
      limits = await db.one('SELECT credit_limit_cents, discount_limit_pct, payment_terms_days, tax_exempt FROM users WHERE id = ?', b.customer_id);
      if (limits && limits.discount_limit_pct != null && subtotal > 0) {
        const pct = (manualDiscount / subtotal) * 100;
        if (pct > Number(limits.discount_limit_pct) + 0.01) {
          return c.json({ error: `Discount of ${pct.toFixed(1)}% exceeds this customer's limit of ${Number(limits.discount_limit_pct)}%` }, 400);
        }
      }
    }
    const taxExempt = !!(limits && limits.tax_exempt) || b.no_tax === true;
    const totalDiscount = r2(manualDiscount + loyaltyDiscount);

    // ----- fulfilment + shipping -----
    const fulfilment = ['pickup', 'delivery', 'shipping'].includes(b.fulfilment) ? b.fulfilment : 'pickup';
    const shipFee = fulfilment === 'pickup' ? 0 : Math.max(0, r2(Number(b.ship_fee_usd) || 0));

    const goods = Math.max(0, r2(subtotal - totalDiscount));
    const taxable = r2(goods + shipFee);
    const tax = taxExempt ? 0 : r2(taxable * TAX_RATE);
    const total = r2(taxable + tax);

    // ----- 3. distribute payment amounts -----
    let allocated = 0;
    const filled = payments.map((p) => {
      const amt = p.amount_usd != null && p.amount_usd !== '' ? Number(p.amount_usd) : null;
      if (amt != null) allocated += amt;
      return { ...p, amount_usd: amt };
    });
    const remaining = r2(total - allocated);
    const blank = filled.findIndex((p) => p.amount_usd == null);
    if (blank >= 0) filled[blank].amount_usd = Math.max(0, remaining);
    else if (Math.abs(remaining) > 0.01)
      return c.json({ error: 'Sum of payment amounts ($' + allocated.toFixed(2) + ') does not match total ($' + total.toFixed(2) + ')' }, 400);

    let moneyIn = 0;
    for (const p of filled) {
      moneyIn += (p.method === 'cash' && p.amount_tendered != null) ? Number(p.amount_tendered) : Number(p.amount_usd);
    }
    if (moneyIn + 0.001 < total)
      return c.json({ error: 'Tendered ($' + moneyIn.toFixed(2) + ') is less than total ($' + total.toFixed(2) + ')' }, 400);
    const changeDue = r2(moneyIn - total);

    // ----- 3b. gift card validation -----
    const gcByCode = {};
    for (const p of filled) {
      if (p.method !== 'gift_card') continue;
      if (!p.reference) return c.json({ error: 'Gift card payments need the card code in "reference"' }, 400);
      const code = String(p.reference).toUpperCase();
      const gc = await db.one('SELECT id, balance_cents, is_active FROM gift_cards WHERE code = ?', code);
      if (!gc || !gc.is_active) return c.json({ error: 'Gift card ' + p.reference + ' not found or inactive' }, 400);
      if (gc.balance_cents < cts(p.amount_usd) - 1)
        return c.json({ error: 'Gift card ' + p.reference + ' has insufficient balance ($' + (gc.balance_cents / 100).toFixed(2) + ')' }, 400);
      gcByCode[code] = gc;
    }

    // ----- 3c. credit-limit check -----
    const accountAmount = filled.filter((p) => p.method === 'account').reduce((s, p) => s + Number(p.amount_usd), 0);
    if (accountAmount > 0.001) {
      if (!b.customer_id || isWalkin) return c.json({ error: 'A real customer account is required to charge a sale to account' }, 400);
      if (!limits || limits.payment_terms_days == null) return c.json({ error: 'This customer has no payment terms set up -- cannot sell on account' }, 400);
      if (limits.credit_limit_cents != null) {
        const balRow = await db.one(
          `SELECT (COALESCE((SELECT SUM(sp.amount_cents) FROM sale_payments sp JOIN pos_sales s ON s.id = sp.sale_id
                              WHERE sp.method = 'account' AND s.customer_id = ? AND s.voided = 0), 0)
                   - COALESCE((SELECT SUM(amount_cents) FROM account_payments WHERE customer_id = ?), 0)) AS bal_cents`,
          b.customer_id, b.customer_id
        );
        const currentBalance = (balRow ? balRow.bal_cents : 0) / 100;
        const projected = currentBalance + accountAmount;
        if (projected > Number(limits.credit_limit_cents) / 100 + 0.01) {
          return c.json({ error: `This sale would put the account at $${projected.toFixed(2)}, over its $${(limits.credit_limit_cents / 100).toFixed(2)} credit limit` }, 400);
        }
      }
    }

    // ----- 3d. payment status -----
    const balanceDue = r2(Math.min(accountAmount, total));
    const amountPaid = r2(total - balanceDue);
    const paymentStatus = balanceDue <= 0.001 ? 'paid' : balanceDue + 0.001 >= total ? 'unpaid' : 'partial';
    let dueDate = null;
    if (balanceDue > 0.001) {
      if (b.due_date && !isNaN(Date.parse(b.due_date))) dueDate = new Date(b.due_date).toISOString().slice(0, 10);
      else if (limits && limits.payment_terms_days != null) dueDate = new Date(Date.now() + Number(limits.payment_terms_days) * 86400000).toISOString().slice(0, 10);
    }

    // ----- 4. build the write batch -----
    const headerMethod = filled.length === 1 ? filled[0].method : 'split';
    const headerRef = filled.length === 1 ? (filled[0].reference || null)
      : filled.map((p) => p.method + (p.reference ? ':' + p.reference : '')).join(' + ');
    const headerTendered = filled.length === 1 && filled[0].method === 'cash' ? filled[0].amount_tendered : null;
    const earnedPoints = (b.customer_id && !isWalkin) ? Math.floor(total) : 0;

    const receipt = await nextReceiptNumber(c.env);
    const invoiceNumber = await nextInvoiceNumber(c.env);
    const saleId = await nextId(c.env, 'pos_sales');
    const repId = Number.isInteger(b.sales_rep_id) ? b.sales_rep_id : null;
    const ship = (v) => (fulfilment === 'pickup' ? null : v || null);

    const stmts = [];
    stmts.push({
      sql: `INSERT INTO pos_sales
        (id, receipt_number, invoice_number, cashier_id, customer_id, customer_name, customer_phone, vehicle_info,
         subtotal_cents, tax_cents, tax_exempt, discount_cents, total_cents, amount_tendered_cents, change_due_cents,
         payment_method, reference, notes, loyalty_points_redeemed, loyalty_discount_cents, loyalty_points_earned,
         sales_rep_id, sales_rep_name, fulfilment, ship_method, ship_fee_cents, ship_name, ship_phone,
         ship_line1, ship_line2, ship_city, ship_parish, ship_instructions, tracking_number,
         payment_status, amount_paid_cents, balance_due_cents, due_date, po_number, quote_id,
         verify_id_type, verify_id_number, verify_tax_id, restricted_approved_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      binds: [
        saleId, receipt, invoiceNumber, b.cashier_id || me.id, b.customer_id || null,
        b.customer_name || null, b.customer_phone || null, b.vehicle_info || null,
        cts(subtotal), cts(tax), taxExempt ? 1 : 0, cts(totalDiscount), cts(total),
        headerTendered != null ? cts(headerTendered) : null, cts(changeDue),
        headerMethod, headerRef, b.notes || null,
        redeemPts, cts(loyaltyDiscount), earnedPoints,
        repId, b.sales_rep_name ? String(b.sales_rep_name).slice(0, 200) : null,
        fulfilment, ship(b.ship_method && String(b.ship_method).slice(0, 120)), cts(shipFee),
        ship(b.ship_name), ship(b.ship_phone), ship(b.ship_line1), ship(b.ship_line2),
        ship(b.ship_city), ship(b.ship_parish), ship(b.ship_instructions),
        ship(b.tracking_number && String(b.tracking_number).slice(0, 80)),
        paymentStatus, cts(amountPaid), cts(balanceDue), dueDate,
        b.po_number ? String(b.po_number).slice(0, 60) : null,
        Number.isInteger(b.quote_id) ? b.quote_id : null,
        b.verify_id_type ? String(b.verify_id_type).slice(0, 40) : null,
        b.verify_id_number ? String(b.verify_id_number).slice(0, 80) : null,
        b.verify_tax_id ? String(b.verify_tax_id).slice(0, 40) : null,
        b.restricted_approved_by ? String(b.restricted_approved_by).slice(0, 200) : null,
      ],
    });

    for (const p of filled) {
      const amtC = cts(p.amount_usd);
      stmts.push({
        sql: `INSERT INTO sale_payments (sale_id, method, amount_cents, amount_tendered_cents, reference)
              VALUES (?,?,?,?,?)`,
        binds: [saleId, p.method, amtC, p.amount_tendered != null ? cts(p.amount_tendered) : null, p.reference || null],
      });
      if (p.method === 'gift_card') {
        const code = String(p.reference).toUpperCase();
        stmts.push({ sql: `UPDATE gift_cards SET balance_cents = balance_cents - ?, last_used_at = CURRENT_TIMESTAMP WHERE code = ?`, binds: [amtC, code] });
        stmts.push({
          sql: `INSERT INTO gift_card_transactions (gift_card_id, delta_cents, reason, reference, performed_by)
                VALUES ((SELECT id FROM gift_cards WHERE code = ?), ?, 'redemption', ?, ?)`,
          binds: [code, -amtC, receipt, me.id],
        });
      }
    }

    // Pre-assigned like saleId -- a redemption instrument (below) needs to
    // reference its sale_item_id, and D1 batches can't feed one statement's
    // last_insert_rowid() into a later one.
    const saleItemBaseId = await nextId(c.env, 'pos_sale_items');
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const lc = lineCalc[i];
      const saleItemId = saleItemBaseId + i;
      let warrantyUntil = null;
      if (it.warranty_days) warrantyUntil = new Date(Date.now() + Number(it.warranty_days) * 86400000).toISOString().slice(0, 10);
      stmts.push({
        sql: `INSERT INTO pos_sale_items
          (id, sale_id, product_img, description, qty, unit_price_cents, core_charge_cents, env_fee_cents,
           discount_cents, discount_note, serial_number, warranty_until, total_cents)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        binds: [
          saleItemId, saleId, it.product_img || null, it.description, Number(it.qty), cts(it.unit_price_usd),
          // Stored as the line's total, not per-unit -- see the gross-total
          // comment above; the return endpoint divides this back by qty.
          cts((Number(it.core_charge_usd) || 0) * Number(it.qty)), cts((Number(it.env_fee_usd) || 0) * Number(it.qty)),
          cts(lc.disc), lc.disc > 0 && it.discount_note ? String(it.discount_note).slice(0, 300) : null,
          it.serial_number || null, warrantyUntil, cts(lc.net),
        ],
      });
      // Redeemable items (e.g. lottery scratch cards) mint one instrument per
      // sold unit -- posAddToCart forces qty 1 per line for these, same as
      // serial_required, so this is exactly one instrument per such line.
      const rule = rules.get(it.product_img);
      if (rule && rule.is_redeemable) {
        stmts.push({
          sql: `INSERT INTO redemption_instruments (code, product_img, sale_id, sale_item_id, face_value_cents, sold_by)
                VALUES (?,?,?,?,?,?)`,
          binds: [genRedemptionCode(), it.product_img, saleId, saleItemId, cts(it.unit_price_usd), me.id],
        });
      }
      if (it.product_img) {
        stmts.push({ sql: `UPDATE products SET stock_count = MAX(0, stock_count - ?) WHERE img = ?`, binds: [Number(it.qty), it.product_img] });
      }
    }

    if (b.customer_id && redeemPts > 0) {
      stmts.push({ sql: `INSERT INTO points_transactions (user_id, delta, reason, reference_id) VALUES (?,?,'redemption',?)`, binds: [b.customer_id, -redeemPts, saleId] });
    }
    if (b.customer_id && earnedPoints > 0) {
      stmts.push({ sql: `INSERT INTO points_transactions (user_id, delta, reason, reference_id) VALUES (?,?,'purchase',?)`, binds: [b.customer_id, earnedPoints, saleId] });
    }
    if (Number.isInteger(b.quote_id)) {
      stmts.push({ sql: `UPDATE pos_quotes SET status = 'converted', converted_sale_id = ? WHERE id = ? AND converted_sale_id IS NULL`, binds: [saleId, b.quote_id] });
    }
    if (Number.isInteger(b.hold_id)) {
      stmts.push({ sql: `DELETE FROM pos_holds WHERE id = ?`, binds: [b.hold_id] });
    }

    try {
      await db.batch(stmts);
    } catch (e) {
      return c.json({ error: e.message }, 500);
    }

    let newBalance = null;
    if (b.customer_id) {
      const bal = await db.one('SELECT COALESCE(SUM(delta), 0) AS balance FROM points_transactions WHERE user_id = ?', b.customer_id);
      newBalance = (bal && bal.balance) || 0;
    }
    return c.json({
      ok: true, id: saleId, receipt_number: receipt, invoice_number: invoiceNumber,
      subtotal_usd: subtotal, discount_usd: totalDiscount, loyalty_discount_usd: loyaltyDiscount,
      tax_usd: tax, tax_exempt: taxExempt, ship_fee_usd: shipFee, fulfilment,
      total_usd: total, money_in: moneyIn, change_due: changeDue,
      amount_paid_usd: amountPaid, balance_due_usd: balanceDue, payment_status: paymentStatus, due_date: dueDate,
      payments: filled,
      loyalty: b.customer_id ? { points_redeemed: redeemPts, points_earned: earnedPoints, balance: newBalance } : null,
    });
  });

  // =====================================================================
  //  POS ORDERS — checkout without payment; a cashier invoices them later.
  //  The cart is stored verbatim in orders.pos_payload and replayed through
  //  /api/admin/pos/sale at invoice time, so the sale path stays unchanged
  //  and stock moves only when the invoice is minted.
  // =====================================================================

  app.post('/api/admin/pos/order', adminMw, async (c) => {
    const db = d1(c.env);
    const me = c.get('user');
    const b = await c.req.json().catch(() => ({}));
    const items = Array.isArray(b.items) ? b.items : [];
    if (!items.length) return c.json({ error: 'At least one item required' }, 400);

    const lineDisc = items.reduce((s, it) => s + Math.max(0, Number(it.discount_usd || 0)), 0);
    if (lineDisc > 0 && !userCan(me, 'pos.line_discount'))
      return c.json({ error: 'Your account is not allowed to give a per-line discount.' }, 403);
    if (Number(b.discount_usd || 0) > 0 && !userCan(me, 'pos.ticket_discount'))
      return c.json({ error: 'Your account is not allowed to give a whole-ticket discount.' }, 403);
    if (b.no_tax === true && !userCan(me, 'pos.no_tax'))
      return c.json({ error: 'Your account is not allowed to switch GCT off.' }, 403);

    // Display total only -- the authoritative figures are recomputed by
    // /pos/sale when the cashier invoices it.
    let sub = 0;
    for (const it of items) {
      const gross = (Number(it.unit_price_usd) || 0) * (Number(it.qty) || 0)
        + Number(it.core_charge_usd || 0) + Number(it.env_fee_usd || 0);
      sub += Math.max(0, gross - Math.max(0, Number(it.discount_usd || 0)));
    }
    const shipFee = ['delivery', 'shipping'].includes(b.fulfilment) ? Math.max(0, r2(Number(b.ship_fee_usd) || 0)) : 0;
    const taxable = Math.max(0, r2(sub - Math.max(0, Number(b.discount_usd || 0)) + shipFee));
    const dispTax = b.no_tax === true ? 0 : r2(taxable * TAX_RATE);   // guide only; /pos/sale computes the real figure
    const dispTotal = Math.max(0, r2(taxable + dispTax));

    const payload = { ...b };
    delete payload.payments; delete payload.payment_method; delete payload.amount_tendered;

    let orderId;
    try {
      const ins = await db.run(
        `INSERT INTO orders
           (user_id, customer_name, customer_phone, total_cents, status, notes,
            payment_method, payment_status, source, pos_payload, sales_rep_id, sales_rep_name,
            ship_instructions, taken_by, created_at)
         VALUES (?,?,?,?, 'pending', ?, 'pos_order', 'unpaid', 'pos', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        Number.isInteger(b.customer_id) ? b.customer_id : null,
        b.customer_name || null, b.customer_phone || null, cts(dispTotal), b.notes || null,
        JSON.stringify(payload),
        Number.isInteger(b.sales_rep_id) ? b.sales_rep_id : null,
        b.sales_rep_name ? String(b.sales_rep_name).slice(0, 200) : null,
        b.ship_instructions ? String(b.ship_instructions).slice(0, 600) : null,
        me.id,
      );
      orderId = ins.meta.last_row_id;
      const stmts = items.filter((it) => it.product_img).map((it) => ({
        sql: `INSERT OR REPLACE INTO order_items (order_id, product_img, qty, price_cents) VALUES (?,?,?,?)`,
        binds: [orderId, it.product_img, Number(it.qty) || 1, cts(it.unit_price_usd || 0)],
      }));
      if (stmts.length) await db.batch(stmts);
    } catch (e) {
      return c.json({ error: e.message }, 500);
    }
    return c.json({ ok: true, order_id: orderId });
  });

  app.get('/api/admin/pos/orders', adminMw, async (c) => {
    const status = c.req.query('status') || 'pending';
    const rows = await d1(c.env).many(
      `SELECT o.id, o.created_at, o.customer_name, o.customer_phone, o.total_cents / 100.0 AS total_usd,
              o.status, o.sales_rep_name, o.ship_instructions, o.converted_sale_id, u.name AS taken_by_name,
              (SELECT COUNT(*) FROM order_items WHERE order_id = o.id) AS line_count,
              (SELECT COALESCE(SUM(qty),0) FROM order_items WHERE order_id = o.id) AS unit_count
         FROM orders o LEFT JOIN users u ON u.id = o.taken_by
        WHERE o.source = 'pos' AND o.status = ?
        ORDER BY o.created_at ASC LIMIT 200`, status);
    return c.json({ orders: rows });
  });

  app.get('/api/admin/pos/orders/:id', adminMw, async (c) => {
    const db = d1(c.env);
    const o = await db.one("SELECT * FROM orders WHERE id = ? AND source = 'pos'", c.req.param('id'));
    if (!o) return c.json({ error: 'Order not found' }, 404);
    let payload = {};
    try { payload = JSON.parse(o.pos_payload || '{}'); } catch (_) {}
    const items = await db.many(
      `SELECT oi.product_img, oi.qty, oi.price_cents / 100.0 AS unit_price_usd, p.name, p.sku, p.stock_count
         FROM order_items oi LEFT JOIN products p ON p.img = oi.product_img WHERE oi.order_id = ?`, o.id);
    delete o.pos_payload;
    return c.json({ order: o, payload, items });
  });

  app.post('/api/admin/pos/orders/:id/cancel', adminMw, async (c) => {
    const me = c.get('user');
    if (!userCan(me, 'pos.finalise_invoice') && !userCan(me, 'cashier.access') && !userCan(me, 'pos.access'))
      return c.json({ error: 'Not allowed' }, 403);
    const r = await d1(c.env).run(
      "UPDATE orders SET status = 'cancelled' WHERE id = ? AND source = 'pos' AND status IN ('pending','invoicing')",
      c.req.param('id'));
    if (!r.meta || r.meta.changes !== 1) return c.json({ error: 'Order not found or not cancellable' }, 409);
    return c.json({ ok: true });
  });

  // Take payment: replay the stored cart through /api/admin/pos/sale (the real,
  // unchanged path) with the cashier's payments, then link + close the order.
  app.post('/api/admin/pos/orders/:id/invoice', adminMw, async (c) => {
    const db = d1(c.env);
    const me = c.get('user');
    if (!userCan(me, 'pos.finalise_invoice') && !userCan(me, 'cashier.access'))
      return c.json({ error: 'Your account is not allowed to take payment on POS orders.' }, 403);
    const id = parseInt(c.req.param('id'), 10);
    const b = await c.req.json().catch(() => ({}));

    const claim = await db.run(
      "UPDATE orders SET status = 'invoicing' WHERE id = ? AND source = 'pos' AND status = 'pending'", id);
    if (!claim.meta || claim.meta.changes !== 1) {
      const row = await db.one("SELECT status, converted_sale_id FROM orders WHERE id = ? AND source = 'pos'", id);
      if (!row) return c.json({ error: 'Order not found' }, 404);
      return c.json({ error: 'Order is already ' + row.status }, 409);
    }
    const ord = await db.one('SELECT pos_payload FROM orders WHERE id = ?', id);
    let payload = {};
    try { payload = JSON.parse(ord.pos_payload || '{}'); } catch (_) {}

    const saleBody = { ...payload,
      payments: Array.isArray(b.payments) ? b.payments : payload.payments,
      payment_method: b.payment_method || payload.payment_method,
      amount_tendered: b.amount_tendered != null ? b.amount_tendered : payload.amount_tendered };
    if (b.fulfilment) saleBody.fulfilment = b.fulfilment;
    ['ship_method', 'ship_fee_usd', 'ship_name', 'ship_phone', 'ship_line1', 'ship_line2', 'ship_city', 'ship_parish', 'ship_instructions']
      .forEach((k) => { if (b[k] !== undefined) saleBody[k] = b[k]; });

    let res, sale;
    try {
      res = await fetch(new URL('/api/admin/pos/sale', c.req.url).toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: c.req.header('cookie') || '' },
        body: JSON.stringify(saleBody),
      });
      sale = await res.json().catch(() => ({}));
    } catch (e) {
      await db.run("UPDATE orders SET status = 'pending' WHERE id = ?", id);
      return c.json({ error: 'Could not reach the sale endpoint: ' + e.message }, 502);
    }
    if (!res.ok || !sale.ok) {
      await db.run("UPDATE orders SET status = 'pending' WHERE id = ?", id);
      return c.json({ error: sale.error || ('Sale failed (HTTP ' + res.status + ')') }, res.status && res.status >= 400 ? res.status : 500);
    }
    await db.run(
      "UPDATE orders SET status = 'completed', payment_status = 'paid', converted_sale_id = ? WHERE id = ?",
      sale.id, id);
    return c.json({ ok: true, order_id: id, sale });
  });

  // =====================================================================
  //  POST /api/admin/pos/sales/:id/void
  // =====================================================================
  app.post('/api/admin/pos/sales/:id/void', adminMw, async (c) => {
    if (!userCan(c.get('user'), 'pos.void_sale')) return c.json({ error: 'Not allowed to void a sale.' }, 403);
    const db = d1(c.env);
    const id = c.req.param('id');
    const s = await db.one('SELECT * FROM pos_sales WHERE id = ?', id);
    if (!s || s.voided) return c.json({ error: 'Not voidable' }, 400);
    const items = await db.many('SELECT * FROM pos_sale_items WHERE sale_id = ?', id);
    const returned = await db.many(
      `SELECT pri.sale_item_id, COALESCE(SUM(pri.qty), 0) AS qty
         FROM pos_return_items pri
        WHERE pri.sale_item_id IN (SELECT id FROM pos_sale_items WHERE sale_id = ?)
        GROUP BY pri.sale_item_id`, id
    );
    const retById = {};
    for (const r of returned) retById[r.sale_item_id] = r.qty;

    const stmts = [];
    for (const it of items) {
      const restock = it.qty - (retById[it.id] || 0);
      if (it.product_img && restock > 0) {
        stmts.push({ sql: 'UPDATE products SET stock_count = stock_count + ? WHERE img = ?', binds: [restock, it.product_img] });
      }
    }
    stmts.push({ sql: `UPDATE pos_sales SET voided = 1, voided_at = CURRENT_TIMESTAMP, voided_by = ? WHERE id = ?`, binds: [c.get('user').id, id] });
    try { await db.batch(stmts); } catch (e) { return c.json({ error: e.message }, 500); }
    return c.json({ ok: true });
  });

  // =====================================================================
  //  POST /api/admin/pos/sales/:id/return
  // =====================================================================
  app.post('/api/admin/pos/sales/:id/return', adminMw, async (c) => {
    if (!userCan(c.get('user'), 'pos.refund')) return c.json({ error: 'Not allowed to process a refund.' }, 403);
    const db = d1(c.env);
    const me = c.get('user');
    const id = c.req.param('id');
    const b = await c.req.json().catch(() => ({}));
    const reqItems = Array.isArray(b.items) ? b.items : [];
    if (!reqItems.length) return c.json({ error: 'At least one line item required' }, 400);
    if (!REFUND_METHODS.includes(b.refund_method))
      return c.json({ error: 'refund_method must be cash, card, cheque, bank, or store_credit' }, 400);

    const sale = await db.one(`SELECT s.*, ${POS_SALE_USD} FROM pos_sales s WHERE s.id = ?`, id);
    if (!sale) return c.json({ error: 'Sale not found' }, 404);
    if (sale.voided) return c.json({ error: 'Cannot return items from a voided sale' }, 400);

    const saleItems = await db.many(
      `SELECT psi.*, psi.unit_price_cents / 100.0 AS unit_price_usd,
              psi.core_charge_cents / 100.0 AS core_charge_usd, psi.env_fee_cents / 100.0 AS env_fee_usd
         FROM pos_sale_items psi WHERE psi.sale_id = ?`, id
    );
    const itemById = {};
    for (const it of saleItems) itemById[it.id] = it;
    const already = await db.many(
      `SELECT pri.sale_item_id, COALESCE(SUM(pri.qty), 0) AS qty
         FROM pos_return_items pri JOIN pos_sale_items psi ON psi.id = pri.sale_item_id
        WHERE psi.sale_id = ? GROUP BY pri.sale_item_id`, id
    );
    const retById = {};
    for (const r of already) retById[r.sale_item_id] = r.qty;

    let refundSubtotal = 0;
    const lineWork = [];
    for (const reqIt of reqItems) {
      const sid = parseInt(reqIt.sale_item_id, 10);
      const qty = parseInt(reqIt.qty, 10);
      const item = itemById[sid];
      if (!item) return c.json({ error: 'sale_item_id ' + sid + ' is not on this sale' }, 400);
      if (!(qty > 0)) return c.json({ error: 'qty must be positive for "' + item.description + '"' }, 400);
      const remaining = item.qty - (retById[sid] || 0);
      if (qty > remaining) return c.json({ error: 'Only ' + remaining + ' unit(s) of "' + item.description + '" remain returnable' }, 400);
      const perUnit = Number(item.unit_price_usd) + (Number(item.core_charge_usd || 0) + Number(item.env_fee_usd || 0)) / item.qty;
      // A warranty claim past the normal return window can be prorated by how
      // much of the warranty period is left, rather than refused outright or
      // refunded in full regardless of age. 0-100; omitted/absent = 100 (full).
      const proratePct = reqIt.prorate_pct != null && reqIt.prorate_pct !== ''
        ? Math.max(0, Math.min(100, Number(reqIt.prorate_pct))) : 100;
      const refundLine = r2(perUnit * qty * (proratePct / 100));
      refundSubtotal += refundLine;
      lineWork.push({ item, qty, refundLine, proratePct, warrantyClaim: !!reqIt.warranty_claim });
    }
    refundSubtotal = r2(refundSubtotal);

    const proportion = Number(sale.subtotal_usd) > 0 ? Math.min(1, refundSubtotal / Number(sale.subtotal_usd)) : 0;
    const refundDiscount = r2(Number(sale.discount_usd) * proportion);
    const refundTax = r2(Number(sale.tax_usd) * proportion);
    const refundTotal = r2(refundSubtotal - refundDiscount + refundTax);

    let storeCreditCode = null;
    if (b.refund_method === 'store_credit') storeCreditCode = genGiftCardCode();

    let pointsClawedBack = 0, pointsRecredited = 0;
    if (sale.customer_id) {
      pointsClawedBack = Math.floor(Number(sale.loyalty_points_earned || 0) * proportion);
      pointsRecredited = Math.round(Number(sale.loyalty_points_redeemed || 0) * proportion);
    }

    const returnNumber = await nextReturnNumber(c.env);
    const returnId = await nextId(c.env, 'pos_returns');

    const stmts = [{
      sql: `INSERT INTO pos_returns
        (id, sale_id, return_number, reason, refund_method, refund_cents,
         refund_subtotal_cents, refund_discount_cents, refund_tax_cents,
         store_credit_code, loyalty_points_clawed_back, loyalty_points_recredited, notes, processed_by, restock)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`,
      binds: [
        returnId, id, returnNumber, b.reason || null, b.refund_method, cts(refundTotal),
        cts(refundSubtotal), cts(refundDiscount), cts(refundTax),
        storeCreditCode, pointsClawedBack, pointsRecredited, b.notes || null, me.id,
      ],
    }];

    if (storeCreditCode) {
      stmts.push({
        sql: `INSERT INTO gift_cards (code, initial_balance_cents, balance_cents, issued_to_name, issued_to_phone, issued_by, notes)
              VALUES (?,?,?,?,?,?,?)`,
        binds: [storeCreditCode, cts(refundTotal), cts(refundTotal), sale.customer_name || null, sale.customer_phone || null, me.id,
          'Store credit for return against sale ' + (sale.receipt_number || sale.id)],
      });
      stmts.push({
        sql: `INSERT INTO gift_card_transactions (gift_card_id, delta_cents, reason, reference, performed_by)
              VALUES ((SELECT id FROM gift_cards WHERE code = ?), ?, 'issue', ?, ?)`,
        binds: [storeCreditCode, cts(refundTotal), sale.receipt_number, me.id],
      });
    }

    for (const lw of lineWork) {
      stmts.push({
        sql: `INSERT INTO pos_return_items (return_id, sale_item_id, product_img, description, qty, refund_cents, unit_price_cents, prorate_pct, warranty_claim)
              VALUES (?,?,?,?,?,?,?,?,?)`,
        binds: [returnId, lw.item.id, lw.item.product_img || null, lw.item.description, lw.qty, cts(lw.refundLine), lw.item.unit_price_cents, lw.proratePct, lw.warrantyClaim ? 1 : 0],
      });
      if (lw.item.product_img) {
        stmts.push({ sql: 'UPDATE products SET stock_count = stock_count + ? WHERE img = ?', binds: [lw.qty, lw.item.product_img] });
      }
    }
    if (sale.customer_id && pointsClawedBack > 0) {
      stmts.push({ sql: `INSERT INTO points_transactions (user_id, delta, reason, reference_id) VALUES (?,?,'return_clawback',?)`, binds: [sale.customer_id, -pointsClawedBack, returnId] });
    }
    if (sale.customer_id && pointsRecredited > 0) {
      stmts.push({ sql: `INSERT INTO points_transactions (user_id, delta, reason, reference_id) VALUES (?,?,'return_recredit',?)`, binds: [sale.customer_id, pointsRecredited, returnId] });
    }

    try { await db.batch(stmts); } catch (e) { return c.json({ error: e.message }, 500); }

    return c.json({
      ok: true, id: returnId, return_number: returnNumber,
      refund_subtotal_usd: refundSubtotal, refund_discount_usd: refundDiscount,
      refund_tax_usd: refundTax, refund_total_usd: refundTotal,
      store_credit_code: storeCreditCode,
      loyalty_points_clawed_back: pointsClawedBack, loyalty_points_recredited: pointsRecredited,
    });
  });
}
