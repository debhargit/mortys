// POS helpers shared by _routes/pos.js (Phase 4) and the sale/void/return
// write path (Phase 5).
import { d1 } from './db.js';

export const TAX_RATE = 0.15;          // server.js: process.env.TAX_RATE || 0.15
export const POINTS_USD_RATE = 0.05;

// server.js money is *_usd; D1 pos_sales / pos_sale_items are *_cents. This is
// the alias list that makes a pos_sales row look like the Postgres one to the
// client (admin.html reads s.total_usd, s.balance_due_usd, s.ship_fee_usd, …).
export const POS_SALE_USD = `
  s.subtotal_cents        / 100.0 AS subtotal_usd,
  s.discount_cents        / 100.0 AS discount_usd,
  s.tax_cents             / 100.0 AS tax_usd,
  s.total_cents           / 100.0 AS total_usd,
  s.amount_tendered_cents / 100.0 AS amount_tendered,
  s.change_due_cents      / 100.0 AS change_due,
  s.loyalty_discount_cents/ 100.0 AS loyalty_discount_usd,
  s.ship_fee_cents        / 100.0 AS ship_fee_usd,
  s.amount_paid_cents     / 100.0 AS amount_paid_usd,
  s.balance_due_cents     / 100.0 AS balance_due_usd`;

export const POS_ITEM_USD = `
  psi.unit_price_cents  / 100.0 AS unit_price_usd,
  psi.core_charge_cents / 100.0 AS core_charge_usd,
  psi.env_fee_cents     / 100.0 AS env_fee_usd,
  psi.discount_cents    / 100.0 AS discount_usd,
  psi.total_cents       / 100.0 AS total_usd`;

// MAX(numeric suffix)+1 style, matching server.js. SQLite has no
// substring(x from '…') regex, so pull the trailing digits with rtrim tricks:
// the numbers are always the last 4-5 chars after the final '-'.
async function nextSeq(env, table, col, prefix, pad) {
  const rows = await d1(env).many(
    `SELECT ${col} AS v FROM ${table} WHERE ${col} LIKE ?`, prefix + '%'
  );
  let max = 0;
  for (const r of rows) {
    const m = String(r.v || '').match(/(\d+)\s*$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return prefix + String(max + 1).padStart(pad, '0');
}

const yr = () => new Date().getFullYear();
export const nextReceiptNumber = (env) => nextSeq(env, 'pos_sales', 'receipt_number', `R-${yr()}-`, 5);
export const nextInvoiceNumber = (env) => nextSeq(env, 'pos_sales', 'invoice_number', `INV-${yr()}-`, 5);
export const nextQuoteNumber   = (env) => nextSeq(env, 'pos_quotes', 'quote_number',  `Q-${yr()}-`, 4);
export const nextHoldNumber    = (env) => nextSeq(env, 'pos_holds', 'hold_number',    `H-${yr()}-`, 4);
export const nextReturnNumber  = (env) => nextSeq(env, 'pos_returns', 'return_number', `RET-${yr()}-`, 5);

// Strip common phone separators for a digits-only LIKE (no regexp_replace on D1).
export const PHONE_DIGITS_SQL = (col) =>
  `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(${col},''),'-',''),' ',''),'(',''),')',''),'+',''),'.','')`;

// server.js genGiftCardCode() — GC-XXXX-XXXX, no ambiguous chars (0/O, 1/I).
export function genGiftCardCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const part = () => Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join('');
  return `GC-${part()}-${part()}`;
}

// Same shape as genGiftCardCode() but a different prefix, so a redemption
// instrument's code (e.g. a lottery scratch card sold through the regular
// sale flow) reads as visibly distinct from a gift card on a receipt.
export function genRedemptionCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const part = () => Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join('');
  return `RD-${part()}-${part()}`;
}

// Next id for a table whose PK is INTEGER PRIMARY KEY AUTOINCREMENT. D1 batches
// can't feed one statement's last_row_id into the next, so pre-assign the id
// and bind it as a literal in the child inserts. SQLite keeps sqlite_sequence
// in step with an explicit id, so a later auto-insert won't collide.
export async function nextId(env, table) {
  const r = await d1(env).one(`SELECT COALESCE(MAX(id), 0) + 1 AS n FROM ${table}`);
  return r ? r.n : 1;
}
