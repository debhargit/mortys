// ============================================================================
//  seed-from-csv.mjs -- load the shop's legacy exports into the database
//
//    node app/tools/seed-from-csv.mjs [--dry-run] [--only=a,b,c] [--csv-dir=PATH]
//
//  Stages, in dependency order (--only picks a subset, but a stage still needs
//  whatever ran before it to already be in the database):
//
//    suppliers   INVENTRY-dedup.csv SUPPLIER      -> suppliers
//    products    INVENTRY*.csv                    -> products, product_suppliers
//    staff       AUTPASS.csv + INVOICE SALESPERSN -> users (is_staff)
//    customers   INVOICE.csv CL_*                 -> users, customer_addresses
//    sales       INVOICE.csv + INVDETAI.csv       -> pos_sales, pos_sale_items
//    payments    INVPAY.csv / Payments.csv        -> sale_payments, account_payments
//    rebuild     INVDETAI.csv (headerless invoices) -> pos_sales, pos_sale_items, users
//    receivals   "ibventory received.csv"         -> warehouse_activity
//
//  Re-runnable. Every row this script owns is either keyed (suppliers.name,
//  products.img, users.email, pos_sales.receipt_number) or tagged with SEED_TAG
//  in `notes` and deleted before being rewritten, so a second run updates
//  rather than duplicates.
//
//  ---- three judgement calls worth knowing about ---------------------------
//
//  1. Receivals do NOT move stock. INVENTRY*.csv QUANTITY is the shop's
//     *current* on-hand; the receival file is a 2014-2026 log of deliveries
//     that those counts already reflect, minus everything sold since. Replaying
//     it onto stock_count would roughly double the inventory. It is seeded as
//     warehouse_activity history, and products.stock_count comes from the
//     master file alone.
//
//  2. No credentials are imported. AUTPASS.csv's PC1..PC7 columns are the old
//     system's login codes; they are not bcrypt hashes, and a six-digit number
//     is not a password. Staff arrive with no password and no till PIN, and
//     must_change_password set -- an owner sets them up in Users & Staff.
//
//  3. WHOLEPRICE is ignored, as it is in load-inventry.mjs. products has no
//     wholesale column, and list_price_usd means list price, not trade price.
//
//  Money note: the *_usd columns on this schema hold Jamaican dollars, and the
//  CSVs are in JMD too, so values cross over unchanged -- no rate is applied.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { categorise } from './_categorise.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const DRY = process.argv.includes('--dry-run');
const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : null;
};
const CSV_DIR = arg('csv-dir') || path.resolve(APP, '..');
const ONLY = arg('only') ? new Set(arg('only').split(',').map((s) => s.trim())) : null;
// The shop exported its payment history twice, as INVPAY.csv and Payments.csv.
// They are the same 288,119 rows and differ only in formatting -- zero-padded
// hours and transaction numbers, "1900" against "1900.00" -- all of which this
// script's parsers already flatten, so either name produces identical rows.
// --payments-file exists to prove that rather than to assert it.
const PAY_FILE = arg('payments-file') || 'INVPAY.csv';
const wants = (stage) => !ONLY || ONLY.has(stage);

const SEED_TAG = '[csv-seed]';
const STAFF_DOMAIN = 'staff.mortysautoparts.local';
const CUST_DOMAIN = 'customers.mortysautoparts.local';
const WALKIN_EMAIL = 'walkin@mortysautoparts.local';

// ---------------------------------------------------------------- csv ------
// Quotes, "" escaping, CRLF, embedded newlines. Row-at-a-time via callback:
// INVDETAI.csv is 469k rows, and holding them all as objects at once is the
// difference between a 300MB heap and a 2GB one.
function eachRow(file, onRow) {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  let row = [], cur = '', q = false, header = null, n = 0;
  const flush = () => {
    row.push(cur); cur = '';
    if (header === null) { header = row.map((h) => h.trim()); row = []; return; }
    if (row.length === 1 && !row[0].trim()) { row = []; return; }
    const o = {};
    for (let j = 0; j < header.length; j++) o[header[j]] = (row[j] || '').trim();
    row = []; n++;
    onRow(o, n);
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') flush();
    else if (c !== '\r') cur += c;
  }
  if (cur.length || row.length) flush();
  return n;
}
function readAll(file) {
  const out = [];
  eachRow(file, (o) => out.push(o));
  return out;
}

// ------------------------------------------------------------- helpers -----
const clean = (v) => String(v == null ? '' : v).trim();
const norm = (v) => clean(v).toUpperCase().replace(/\s+/g, ' ');
function money(v) {
  const n = parseFloat(String(v == null ? '' : v).replace(/[$,]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}
function qty(v) {
  const n = Math.round(parseFloat(v));
  return Number.isFinite(n) ? n : 0;
}
// MM/DD/YYYY -> YYYY-MM-DD. Anything else is unusable, and returns null rather
// than quietly becoming 1970 or today.
function isoDate(v) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(clean(v));
  if (!m) return null;
  const [, mo, d, y] = m;
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31) return null;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}
// "1447" -> 14:47, "935" -> 09:35. Junk (a bare "1", "50") means the time was
// never recorded, so the row lands at noon rather than at a wrong minute.
function isoTime(v) {
  const t = clean(v).replace(/:/g, '');
  if (/^\d{4}$/.test(t)) {
    const h = +t.slice(0, 2), mi = +t.slice(2);
    if (h < 24 && mi < 60) return `${t.slice(0, 2)}:${t.slice(2)}:00`;
  }
  if (/^\d{3}$/.test(t)) {
    const mi = +t.slice(1);
    if (mi < 60) return `0${t.slice(0, 1)}:${t.slice(1)}:00`;
  }
  return '12:00:00';
}
const stamp = (d, t) => (d ? d + ' ' + isoTime(t) : null);
function slug(s) {
  return norm(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'x';
}
function makeModel(vehicle, model) {
  const v = clean(vehicle), m = clean(model);
  if (!v && !m) return '';
  if (!v) return m;
  if (!m || m.toUpperCase() === v.toUpperCase()) return v;
  return v + ' / ' + m;
}
// A name is a customer only if something in it is a letter or a digit. The file
// has rows whose CL_NAME is a stray backtick.
const isRealName = (s) => /[A-Za-z0-9]/.test(clean(s));

// Old tender words -> the methods the rest of the app groups money by, plus
// 'account' for a charge. Refunds and credit notes are not tenders at all.
function tenderOf(desc) {
  const d = norm(desc);
  if (/REFUND|CR NOTE|CREDIT NOTE/.test(d)) return null;
  if (d === 'CASH') return 'cash';
  if (d === 'CARD') return 'card';
  if (d === 'CHEQUE' || d.startsWith('C#')) return 'cheque';
  if (d === 'CHARGE') return 'account';
  return 'bank';
}
// "7 DAYS" -> 7, "N14" -> 14, "NEXT DAY" -> 1.
function termDays(v) {
  const t = norm(v);
  if (!t) return null;
  if (t === 'NEXT DAY') return 1;
  if (t === 'COD' || t === 'CASH' || t === 'CHEQUE') return 0;
  const m = /^N?(\d+)/.exec(t);
  return m ? +m[1] : null;
}

// ------------------------------------------------------------------ db -----
const cfg = JSON.parse(fs.readFileSync(path.join(APP, 'db-config.json'), 'utf8')).local;
const pool = new pg.Pool({
  host: cfg.host, port: cfg.port, database: cfg.database,
  user: cfg.user, password: cfg.password, max: 4,
});

// Chunked multi-row INSERT. Postgres caps a statement at 65535 parameters, so
// the chunk size is derived from the column count rather than guessed at.
async function insertMany(client, table, cols, rows, conflict = '', returning = '') {
  if (!rows.length) return [];
  const per = Math.max(1, Math.floor(60000 / cols.length));
  const out = [];
  for (let i = 0; i < rows.length; i += per) {
    const slice = rows.slice(i, i + per);
    const vals = [];
    const tuples = slice.map((row, n) => {
      const b = n * cols.length;
      for (const c of cols) vals.push(row[c] === undefined ? null : row[c]);
      return '(' + cols.map((_, k) => '$' + (b + k + 1)).join(',') + ')';
    });
    const r = await client.query(
      `INSERT INTO ${table} (${cols.join(',')}) VALUES ${tuples.join(',')} ${conflict} ${returning}`,
      vals);
    if (returning) out.push(...r.rows);
  }
  return out;
}
const setFrom = (cols) => cols.map((c) => `${c}=EXCLUDED.${c}`).join(', ');
const say = (...a) => console.log(...a);

// ============================================================================
const client = await pool.connect();
try {
  await client.query('BEGIN');
  const t0 = Date.now();

  // ------------------------------------------------------- 1. suppliers ----
  // The only vendor names anywhere in the export are the SUPPLIER column of
  // INVENTRY-dedup.csv. ("ibventory received.csv" has a SUPPLIER column too,
  // but every row of it reads "1" -- it carries no vendor information.)
  // Two of the 193 are not vendors: STOCK TAKING and MISCELLANEOUS are the old
  // system's placeholders for "no supplier". They are created inactive rather
  // than dropped, so the parts filed under them keep their provenance without
  // cluttering the vendor list.
  const NOT_REALLY_VENDORS = new Set(['STOCK TAKING', 'MISCELLANEOUS', 'UNKNOWN', 'N/A']);
  const dedupRows = readAll(path.join(CSV_DIR, 'INVENTRY-dedup.csv'));
  const vendorNames = new Map();              // NORMALISED -> as first spelled
  for (const r of dedupRows) {
    const n = norm(r.SUPPLIER);
    if (n && !vendorNames.has(n)) vendorNames.set(n, clean(r.SUPPLIER));
  }
  if (wants('suppliers')) {
    // suppliers.name has no unique constraint in schema.sql, and ON CONFLICT
    // needs one for this to be re-runnable.
    await client.query('CREATE UNIQUE INDEX IF NOT EXISTS uq_suppliers_name ON suppliers (name)');
    const rows = [...vendorNames.entries()].map(([n, name]) => ({
      name,
      is_active: !NOT_REALLY_VENDORS.has(n),
      notes: NOT_REALLY_VENDORS.has(n)
        ? SEED_TAG + ' placeholder from the old system, not a real vendor'
        : SEED_TAG + ' imported from INVENTRY-dedup.csv',
    }));
    await insertMany(client, 'suppliers', ['name', 'is_active', 'notes'], rows,
      'ON CONFLICT (name) DO UPDATE SET ' + setFrom(['is_active', 'notes']));
    say(`suppliers   : ${rows.length} vendors (${rows.filter((r) => !r.is_active).length} inactive placeholders)`);
  }
  const supplierId = new Map();               // NORMALISED name -> id
  for (const r of (await client.query('SELECT id, name FROM suppliers')).rows) {
    supplierId.set(norm(r.name), r.id);
  }

  // -------------------------------------------------------- 2. products ----
  // Two master exports with almost no overlap: INVENTRY.csv (17.8k rows) and
  // INVENTRY-dedup.csv (36.1k rows) share only 2,320 SKUs, so the catalogue is
  // the union of both, not one or the other. Where they do collide the dedup
  // file wins, because it is the only one carrying a supplier.
  if (wants('products')) {
    const byImg = new Map();
    let blank = 0, dupes = 0;
    const take = (r, withSupplier) => {
      const sku = clean(r.SKU);
      if (!sku) { blank++; return; }
      if (byImg.has(sku)) dupes++;
      const price = money(r.PRICE);
      byImg.set(sku, {
        img: sku, sku,
        name: clean(r.DESCRIPTION) || sku,
        make_model: makeModel(r.VEHICLE, r.MODEL),
        category: categorise(r.DESCRIPTION),
        condition: 'NEW',
        price_usd: price != null && price > 0 ? price : null,
        cost_usd: money(r.COST),
        stock_count: Math.max(0, qty(r.QUANTITY)),
        bin_location: clean(r.LOCATION) || null,
        supplier_id: withSupplier ? (supplierId.get(norm(r.SUPPLIER)) ?? null) : null,
      });
    };
    for (const r of readAll(path.join(CSV_DIR, 'INVENTRY.csv'))) take(r, false);
    for (const r of dedupRows) take(r, true);

    const rows = [...byImg.values()];
    const COLS = ['img', 'sku', 'name', 'make_model', 'category', 'condition',
                  'price_usd', 'cost_usd', 'stock_count', 'bin_location', 'supplier_id'];
    await insertMany(client, 'products', COLS, rows,
      'ON CONFLICT (img) DO UPDATE SET ' + setFrom(COLS.slice(1)) + ', updated_at=now()');

    // product_suppliers is what the purchasing planner reads; products.supplier_id
    // on its own is only the "default vendor" shortcut.
    const ps = rows.filter((r) => r.supplier_id).map((r) => ({
      product_img: r.img, supplier_id: r.supplier_id, unit_cost_usd: r.cost_usd,
      is_preferred: true, notes: SEED_TAG + ' from INVENTRY-dedup.csv',
    }));
    await insertMany(client, 'product_suppliers',
      ['product_img', 'supplier_id', 'unit_cost_usd', 'is_preferred', 'notes'], ps,
      'ON CONFLICT (product_img, supplier_id) DO UPDATE SET '
      + setFrom(['unit_cost_usd', 'is_preferred', 'notes']) + ', updated_at=now()');

    const onHand = rows.reduce((s, r) => s + r.stock_count, 0);
    say(`products    : ${rows.length} parts (${blank} blank SKU skipped, ${dupes} duplicate SKU collapsed), `
      + `${ps.length} supplier links, ${onHand.toLocaleString()} units on hand`);
  }

  // SKU -> img, for matching sale lines and receivals to the catalogue.
  const skuToImg = new Map();
  for (const r of (await client.query('SELECT img, sku FROM products')).rows) {
    skuToImg.set(norm(r.img), r.img);
    if (r.sku) skuToImg.set(norm(r.sku), r.img);
  }

  // --------------------------------------------------- 3. staff / reps -----
  const invoices = readAll(path.join(CSV_DIR, 'INVOICE.csv')).filter((r) => clean(r.INV_NUMBER));
  const repNames = new Map();                 // NORMALISED -> as spelled
  const noteRep = (v) => { const n = norm(v); if (n && !repNames.has(n)) repNames.set(n, clean(v)); };
  for (const r of readAll(path.join(CSV_DIR, 'AUTPASS.csv'))) noteRep(r.USERL);
  for (const r of invoices) { noteRep(r.SALESPERSN); noteRep(r.USER); }

  if (wants('staff')) {
    const rows = [...repNames.values()].map((name) => ({
      email: slug(name) + '@' + STAFF_DOMAIN,
      name,
      is_staff: true, is_admin: false, admin_role: 'cashier',
      must_change_password: true, via: 'pos',
      internal_notes: SEED_TAG + ' sales rep imported from AUTPASS.csv / INVOICE.csv. '
        + 'No password or till PIN was imported -- set one in Users & Staff.',
    }));
    await insertMany(client, 'users',
      ['email', 'name', 'is_staff', 'is_admin', 'admin_role', 'must_change_password', 'via', 'internal_notes'],
      rows, 'ON CONFLICT (email) DO UPDATE SET ' + setFrom(['name', 'is_staff', 'admin_role', 'internal_notes']));
    say(`staff       : ${rows.length} sales reps (${rows.map((r) => r.name).join(', ')})`);
  }
  const staffId = new Map();                  // NORMALISED rep name -> user id
  for (const r of (await client.query('SELECT id, name FROM users WHERE is_staff = true')).rows) {
    if (r.name) staffId.set(norm(r.name), r.id);
  }

  // ------------------------------------------------------- 4. customers ----
  // CASH is not a customer -- it is the walk-in counter, and this database
  // already has a user for it.
  const custRows = new Map();                 // NORMALISED CL_NAME -> shape
  for (const r of invoices) {
    const n = norm(r.CL_NAME);
    if (!n || n === 'CASH' || !isRealName(n)) continue;
    const prev = custRows.get(n) || {
      name: clean(r.CL_NAME), phone: null, account_number: null,
      line1: null, line2: null, terms: null, sawCredit: false, count: 0,
    };
    prev.count++;
    prev.phone = prev.phone || clean(r.CL_PHONE) || null;
    prev.account_number = prev.account_number || clean(r.CL_NUMBER) || null;
    prev.line1 = prev.line1 || clean(r.CL_ADDR1) || null;
    prev.line2 = prev.line2 || clean(r.CL_ADDR2) || null;
    if (clean(r.CRED_TERMS)) { prev.terms = prev.terms || clean(r.CRED_TERMS); prev.sawCredit = true; }
    custRows.set(n, prev);
  }
  if (wants('customers')) {
    // Emails are synthesised (the old system never held one) and users.email is
    // UNIQUE, so two customers whose names slug the same get -2, -3...
    const used = new Set((await client.query('SELECT email FROM users')).rows.map((r) => r.email));
    const rows = [];
    for (const c of custRows.values()) {
      let e = slug(c.name) + '@' + CUST_DOMAIN, k = 1;
      while (used.has(e)) e = slug(c.name) + '-' + (++k) + '@' + CUST_DOMAIN;
      used.add(e);
      const trade = c.sawCredit;
      rows.push({
        email: e, name: c.name, phone: c.phone, via: 'pos',
        is_staff: false, is_admin: false,
        company_name: c.name,
        customer_type: trade ? 'trade' : 'retail',
        price_tier: trade ? 'trade' : 'retail',
        account_number: c.account_number,
        payment_terms_days: termDays(c.terms),
        credit_type: trade ? (norm(c.terms) === 'COD' ? 'cod' : 'open') : null,
        internal_notes: SEED_TAG + ` imported from INVOICE.csv (${c.count} invoice${c.count === 1 ? '' : 's'})`,
        _addr: c,
      });
    }
    // account_number is UNIQUE; the old file reuses the odd number across
    // customers, so only the first claim on a value keeps it.
    const seenAcct = new Set();
    for (const r of rows) {
      if (!r.account_number) continue;
      if (seenAcct.has(r.account_number)) r.account_number = null;
      else seenAcct.add(r.account_number);
    }
    const COLS = ['email', 'name', 'phone', 'via', 'is_staff', 'is_admin', 'company_name',
                  'customer_type', 'price_tier', 'account_number', 'payment_terms_days',
                  'credit_type', 'internal_notes'];
    await insertMany(client, 'users', COLS, rows,
      'ON CONFLICT (email) DO UPDATE SET ' + setFrom(COLS.slice(1)));

    const idByEmail = new Map();
    for (const r of (await client.query('SELECT id, email FROM users WHERE email LIKE $1', ['%@' + CUST_DOMAIN])).rows) {
      idByEmail.set(r.email, r.id);
    }
    const addrs = rows.filter((r) => r._addr.line1).map((r) => ({
      user_id: idByEmail.get(r.email), label: 'Billing', kind: 'billing',
      recipient: r.name, line1: r._addr.line1, line2: r._addr.line2,
      phone: r.phone, is_default: true, notes: SEED_TAG,
    })).filter((a) => a.user_id);
    await client.query('DELETE FROM customer_addresses WHERE notes = $1', [SEED_TAG]);
    await insertMany(client, 'customer_addresses',
      ['user_id', 'label', 'kind', 'recipient', 'line1', 'line2', 'phone', 'is_default', 'notes'], addrs);
    say(`customers   : ${rows.length} accounts (${rows.filter((r) => r.customer_type === 'trade').length} trade), `
      + `${addrs.length} addresses; CASH mapped to the existing walk-in user`);
  }
  const customerId = new Map();               // NORMALISED CL_NAME -> user id
  for (const r of (await client.query('SELECT id, name FROM users WHERE email LIKE $1', ['%@' + CUST_DOMAIN])).rows) {
    if (r.name && !customerId.has(norm(r.name))) customerId.set(norm(r.name), r.id);
  }
  {
    const w = (await client.query('SELECT id FROM users WHERE email = $1', [WALKIN_EMAIL])).rows[0];
    if (w) customerId.set('CASH', w.id);
  }

  // ----------------------------------------------------------- 5. sales ----
  // One pos_sales row per invoice header, keyed on receipt_number = INV_NUMBER.
  const saleIdOf = new Map();                 // receipt number -> pos_sales.id
  const invMeta = new Map();                  // receipt number -> { date, total, paid, custId, repId, cname }
  // 26 invoice numbers appear on two different sales in INVOICE.csv (all on
  // 25 Aug 2021, with different totals) -- the old system handed the same
  // number out twice. receipt_number is UNIQUE, so keying on it alone would
  // throw one of each pair away. The later one is suffixed instead, the same
  // repair migration 0063 makes for duplicates already in the database.
  // Its payment rows in INVPAY.csv cannot be told apart from the first sale's,
  // so they stay with the original number and the suffixed row keeps whatever
  // its own header says it was paid.
  const dupCount = new Map();
  let renumbered = 0;
  for (const r of invoices) {
    const orig = clean(r.INV_NUMBER), d = isoDate(r.INV_DATE);
    if (!d) continue;
    const seen = (dupCount.get(orig) || 0) + 1;
    dupCount.set(orig, seen);
    const num = seen === 1 ? orig : `${orig}-DUP${seen}`;
    if (seen > 1) renumbered++;
    const cname = clean(r.CL_NAME) || 'CASH';
    const rep = clean(r.SALESPERSN) || clean(r.USER) || null;
    invMeta.set(num, {
      date: d, time: r.INV_TIME,
      total: money(r.TOTAL) ?? 0,
      paid: money(r.TOTAL_PAID) ?? 0,
      custId: customerId.get(norm(cname)) ?? customerId.get('CASH') ?? null,
      repId: rep ? (staffId.get(norm(rep)) ?? null) : null,
      cname, rep, row: r, orig,
    });
  }

  if (wants('sales')) {
    const rows = [];
    for (const [num, m] of invMeta) {
      const r = m.row;
      const bal = Math.round((m.total - m.paid) * 100) / 100;
      const voided = norm(r.STATUS) === 'C';
      rows.push({
        receipt_number: num,
        invoice_number: num,
        cashier_id: m.repId,
        cashier_name: m.rep,
        sales_rep_name: m.rep,
        customer_id: m.custId,
        customer_name: m.cname,
        customer_phone: clean(r.CL_PHONE) || null,
        subtotal_usd: money(r.SUB_TOTAL) ?? 0,
        discount_usd: 0,
        tax_usd: money(r.TAX) ?? 0,
        total_usd: m.total,
        amount_paid_usd: m.paid,
        balance_due_usd: bal > 0 ? bal : 0,
        payment_status: bal > 0.005 ? (m.paid > 0.005 ? 'partial' : 'unpaid') : 'paid',
        tax_exempt: norm(r.TAXABLE) === 'N',
        reference: clean(r.REFERENCE) || null,
        payment_method: 'cash',               // refined by the payments stage
        voided,
        voided_at: voided ? stamp(m.date, m.time) : null,
        notes: SEED_TAG + ' imported from INVOICE.csv'
          + (clean(r.CRED_TERMS) ? ' · terms: ' + clean(r.CRED_TERMS) : ''),
        created_at: stamp(m.date, m.time),
      });
    }

    const COLS = Object.keys(rows[0]);
    const back = await insertMany(client, 'pos_sales', COLS, rows,
      'ON CONFLICT (receipt_number) DO UPDATE SET ' + setFrom(COLS.filter((c) => c !== 'receipt_number')),
      'RETURNING id, receipt_number');
    for (const r of back) saleIdOf.set(r.receipt_number, r.id);
    say(`sales       : ${rows.length} invoices, ${rows.filter((r) => r.voided).length} cancelled, `
      + `${renumbered} given a -DUP suffix because the file reused their invoice number`);

    // ---- line items ----
    // INVDETAI.csv covers 287k invoice numbers going back to 2008; only the
    // ones with a header row in INVOICE.csv are in scope here.
    const ids = [...saleIdOf.values()];
    await client.query('DELETE FROM pos_sale_items WHERE sale_id = ANY($1::int[])', [ids]);
    const items = [];
    let orphan = 0, unmatched = 0;
    const missingSku = new Set();
    eachRow(path.join(CSV_DIR, 'INVDETAI.csv'), (r) => {
      const sid = saleIdOf.get(clean(r.INV_NUMBER));
      if (!sid) { orphan++; return; }
      const img = skuToImg.get(norm(r.SKU)) ?? null;
      if (!img && clean(r.SKU)) { unmatched++; missingSku.add(clean(r.SKU)); }
      const q = qty(r.QUANTITY) || 1;
      const unit = money(r.UNIT);
      const amount = money(r.AMOUNT);
      items.push({
        sale_id: sid, product_img: img,
        description: clean(r.DESC) || clean(r.SKU) || '(no description)',
        qty: q,
        unit_price_usd: unit ?? (amount != null && q ? Math.round((amount / q) * 100) / 100 : null),
        total_usd: amount ?? (unit != null ? Math.round(unit * q * 100) / 100 : null),
      });
    });
    await insertMany(client, 'pos_sale_items',
      ['sale_id', 'product_img', 'description', 'qty', 'unit_price_usd', 'total_usd'], items);
    say(`  line items: ${items.length} on ${new Set(items.map((i) => i.sale_id)).size} invoices `
      + `(${orphan.toLocaleString()} lines belong to pre-2021 invoices with no header and were skipped; `
      + `${unmatched} lines name ${missingSku.size} parts not in the catalogue -- kept, description only)`);
  } else {
    for (const r of (await client.query('SELECT id, receipt_number FROM pos_sales WHERE receipt_number IS NOT NULL')).rows) {
      saleIdOf.set(r.receipt_number, r.id);
    }
  }

  // -------------------------------------------------------- 6. payments ----
  // Two different things live in INVPAY.csv, and they land in two tables:
  //
  //   sale_payments     what was tendered at the counter for that invoice.
  //   account_payments  a settlement against a charge customer's ledger.
  //
  // The invoice header is the authority on money, not INVPAY.AMOUNT. 1,562 of
  // the 17,175 invoices with payment rows have a CASH row for a fraction of the
  // total while the header's TOTAL_PAID says the invoice was settled in full --
  // the old system clearly did not write a complete tender breakdown every
  // time. Summing INVPAY instead would invent a receivable on 470 paid cash
  // sales. So TOTAL_PAID decides how much was paid and TOTAL - TOTAL_PAID is
  // what is still owed; INVPAY only decides *how* it was paid, and its split is
  // used verbatim only when it reconciles with TOTAL_PAID.
  //
  // A CHARGE row is a marker, not a payment -- its AMOUNT is always 0. An
  // invoice carrying one was sold on credit, so the whole total is a
  // method='account' row (the debit side of getAccountBalance() in server.js)
  // and whatever came in against it is an account_payments row (the credit
  // side). Everything else is a counter sale, where only an unpaid remainder
  // becomes an 'account' row.
  const RECONCILE = (a, b) => Math.abs(a - b) <= Math.max(1, Math.abs(b) * 0.01);

  // Works out how one invoice's money is recorded: what was tendered at the
  // counter, what was charged to an account, and what later settled it. Pushes
  // onto the caller's `tenders`/`settlements` arrays and returns the headline
  // method for the sale. Shared by the real headers and the rebuilt ones so
  // both foot to their invoice total the same way.
  function recordMoney(sid, num, meta, payRows, out) {
    const { tenders, settlements, stats } = out;
    let isCharge = false;
    const paid = [];                                    // real tenders, any date
    for (const r of payRows) {
      const m = tenderOf(r.PAY_DESC);
      if (m === null) { stats.refunds++; continue; }      // refund / credit note
      if (m === 'account') { isCharge = true; continue; } // CHARGE marker, amount 0
      const amt = money(r.AMOUNT) ?? 0;
      if (amt <= 0) continue;
      paid.push({ m, amt, r, at: (isoDate(r.PAY_DATE) || meta.date) + ' ' + isoTime(r.PAY_TIME) });
    }
    if (!payRows.length) stats.noRows++;
    const settledAmt = Math.min(meta.paid, meta.total);
    const unpaid = Math.round((meta.total - settledAmt) * 100) / 100;

    // How it was paid: keep the file's split when it reconciles with the
    // invoice total, otherwise fall back to one row for the amount the invoice
    // says, carrying the method that moved the most money.
    const sum = paid.reduce((s, x) => s + x.amt, 0);
    const dominant = paid.length ? paid.reduce((a, b) => (b.amt > a.amt ? b : a)) : null;
    let breakdown;
    if (settledAmt <= 0.005) breakdown = [];
    else if (paid.length && RECONCILE(sum, settledAmt)) {
      stats.splitKept++;
      breakdown = paid.map((p) => ({
        method: p.m, amount_usd: p.amt,
        reference: clean(p.r.PAY_NUMBER) || clean(p.r.TRANNO) || null,
        notes: SEED_TAG + ' ' + (clean(p.r.PAY_DESC) || p.m), at: p.at,
      }));
      // "Reconciles" is within a dollar or a percent, which is close enough to
      // believe the file's method split but not close enough to leave in the
      // books: a cent out on 15,613 invoices is a real number. The difference
      // goes on the largest row, so the tenders foot exactly while the mix
      // stays as the file recorded it.
      const drift = Math.round((settledAmt - sum) * 100) / 100;
      if (drift !== 0) {
        const big = breakdown.reduce((a, b) => (b.amount_usd > a.amount_usd ? b : a));
        big.amount_usd = Math.round((big.amount_usd + drift) * 100) / 100;
        big.notes += ' (+' + drift.toFixed(2) + ' to foot to the invoice total)';
      }
      breakdown = breakdown.filter((b) => b.amount_usd > 0);
    } else {
      if (paid.length) stats.splitRebuilt++;
      breakdown = [{
        method: dominant ? dominant.m : 'cash', amount_usd: settledAmt, reference: null,
        notes: SEED_TAG + (dominant
          ? ' tender rebuilt from the invoice total (the INVPAY split did not reconcile)'
          : ' no payment row in ' + PAY_FILE + '; amount from the invoice total'),
        at: (dominant ? dominant.at : meta.date + ' 12:00:00'),
      }];
    }

    const mine = [];
    // A charge needs a ledger to sit on. Some were rung up against the walk-in
    // counter, which has none -- treated as credit they would put a six-figure
    // receivable on a customer who does not exist, so they take the counter
    // path below and show only what was paid and what is owed.
    const cid = meta.custId && norm(meta.cname) !== 'CASH' ? meta.custId : null;
    if (isCharge && cid) {
      // Sold on credit: the whole invoice is the debit, and anything that came
      // in against it credits the customer's ledger.
      stats.onCredit++;
      mine.push({
        sale_id: sid, method: 'account', amount_usd: meta.total, reference: null,
        notes: SEED_TAG + ' charged to account', created_at: meta.date + ' 12:00:00',
      });
      for (const b of breakdown) {
        settlements.push({
          customer_id: cid, amount_usd: b.amount_usd, method: b.method,
          reference: num, received_by: meta.repId,
          notes: SEED_TAG + ' settlement of ' + num + ' from ' + PAY_FILE,
          created_at: b.at,
        });
      }
    } else {
      if (isCharge) stats.chargeNoLedger++;
      for (const b of breakdown) {
        mine.push({ sale_id: sid, method: b.method, amount_usd: b.amount_usd, reference: b.reference, notes: b.notes, created_at: b.at });
      }
      // An unpaid counter sale is still a receivable.
      if (unpaid > 0.005) {
        stats.owing++;
        mine.push({
          sale_id: sid, method: 'account', amount_usd: unpaid, reference: null,
          notes: SEED_TAG + ' unpaid balance on the invoice',
          created_at: meta.date + ' 12:00:00',
        });
      }
    }
    for (const t of mine) tenders.push(t);
    // The headline method on the sale is whichever tender carried the most.
    return mine.length
      ? mine.reduce((a, b) => (Number(b.amount_usd) > Number(a.amount_usd) ? b : a)).method
      : 'cash';
  }
  const newStats = () => ({ refunds: 0, onCredit: 0, owing: 0, splitKept: 0, splitRebuilt: 0, noRows: 0, chargeNoLedger: 0 });

  if (wants('payments')) {
    const byInv = new Map();
    eachRow(path.join(CSV_DIR, PAY_FILE), (r) => {
      const num = clean(r.INV_NUMBER);
      if (!saleIdOf.has(num)) return;
      let list = byInv.get(num);
      if (!list) { list = []; byInv.set(num, list); }
      list.push(r);
    });

    const ids = [...saleIdOf.values()];
    await client.query('DELETE FROM sale_payments WHERE sale_id = ANY($1::int[])', [ids]);
    await client.query('DELETE FROM account_payments WHERE notes LIKE $1', [SEED_TAG + '%']);

    const out = { tenders: [], settlements: [], stats: newStats() };
    const methodOf = new Map();
    for (const [num, meta] of invMeta) {
      const sid = saleIdOf.get(num);
      if (!sid) continue;
      methodOf.set(num, recordMoney(sid, num, meta, byInv.get(num) || [], out));
    }
    const { tenders, settlements, stats } = out;
    const { refunds, onCredit, owing, splitKept, splitRebuilt, noRows, chargeNoLedger } = stats;

    await insertMany(client, 'sale_payments',
      ['sale_id', 'method', 'amount_usd', 'reference', 'notes', 'created_at'], tenders);
    await insertMany(client, 'account_payments',
      ['customer_id', 'amount_usd', 'method', 'reference', 'received_by', 'notes', 'created_at'], settlements);

    // Push the headline method back onto pos_sales, 5k rows per statement.
    const pairs = [...methodOf.entries()].filter(([n]) => saleIdOf.has(n));
    for (let i = 0; i < pairs.length; i += 5000) {
      const s = pairs.slice(i, i + 5000);
      await client.query(
        `UPDATE pos_sales p SET payment_method = v.m
           FROM (SELECT * FROM unnest($1::int[], $2::text[]) AS t(id, m)) v
          WHERE p.id = v.id`,
        [s.map(([n]) => saleIdOf.get(n)), s.map(([, m]) => m)]);
    }
    const settled = settlements.reduce((s, x) => s + x.amount_usd, 0);
    say(`payments    : ${tenders.length} counter tenders, ${settlements.length} account settlements `
      + `(J$${settled.toLocaleString(undefined, { minimumFractionDigits: 2 })})`);
    say(`              ${onCredit} invoices sold on credit (${chargeNoLedger} more charged to the walk-in counter, which has no ledger), `
      + `${owing} counter sales left part-paid; `
      + `${splitKept} kept the file's tender split, ${splitRebuilt} were rebuilt from TOTAL_PAID, `
      + `${noRows} had no payment row at all; ${refunds} refund/credit-note rows noted, not tendered`);
  }

  // ------------------------------------------- 6b. rebuilt invoices --------
  // INVDETAI.csv carries line items for 286,813 invoice numbers; INVOICE.csv
  // only has a header row for 19,637 of them. The other 267,175 -- all of
  // 2008-2017, plus 2022 and part of 2023 -- are real sales whose header was
  // never exported. This stage rebuilds those headers from the lines.
  //
  // What the lines can and cannot tell us:
  //   date, time, rep, customer   every line of an invoice agrees on these
  //                               (checked: 0 invoices disagree on date or rep)
  //   subtotal                    sum of AMOUNT, which is the line extension
  //   tax                         sum of AMOUNT x TXRATE, per line
  //   total                       subtotal + tax
  //   status                      nothing usable, so none are marked cancelled
  //
  // The reconstruction is cross-checked against a completely independent
  // source: what INVPAY.csv says was paid. 213,577 of the 236,608 that have a
  // payment row agree to the cent or within 1% (90.3%). The rest are quirks of
  // the payment file, not the lines -- one payment row covering several
  // invoices, or a part payment -- so the lines decide the invoice total and
  // INVPAY only decides what was paid against it, exactly as for real headers.
  //
  // The line-level TAX flag is not trustworthy on its own: it reads 'Y' on
  // 438,769 of 440,304 lines and the remainder are mostly stray characters
  // ('C', '3', '.', a NUL byte), so a line counts as taxable unless it says 'N'
  // outright or carries a zero rate.
  if (wants('rebuild')) {
    // ---- pass 1: one header per invoice, from its lines ----
    const agg = new Map();
    let noNumber = 0;
    eachRow(path.join(CSV_DIR, 'INVDETAI.csv'), (r) => {
      const num = clean(r.INV_NUMBER);
      if (!num) { noNumber++; return; }
      if (invMeta.has(num)) return;             // already has a real header
      let a = agg.get(num);
      if (!a) {
        a = { date: isoDate(r.DDATE), time: clean(r.DET_TIME), rep: clean(r.SALESPERSN) || null,
              cname: clean(r.CL_NAME) || null, sub: 0, tax: 0, lines: 0 };
        agg.set(num, a);
      }
      a.lines++;
      const amt = money(r.AMOUNT) ?? 0;
      a.sub += amt;
      const rate = money(r.TXRATE) ?? 0;
      if (norm(r.TAX) !== 'N' && rate > 0) a.tax += amt * rate / 100;
    });
    for (const [num, a] of agg) if (!a.date) agg.delete(num);   // 1 invoice, no usable date

    // ---- the reps and customers these older invoices bring with them ----
    const newReps = new Map();
    const newCusts = new Map();
    for (const a of agg.values()) {
      if (a.rep && !staffId.has(norm(a.rep)) && !newReps.has(norm(a.rep))) newReps.set(norm(a.rep), a.rep);
      const cn = a.cname;
      if (cn && isRealName(cn) && norm(cn) !== 'CASH'
          && !customerId.has(norm(cn)) && !newCusts.has(norm(cn))) newCusts.set(norm(cn), cn);
    }
    if (newReps.size) {
      const rows = [...newReps.values()].map((name) => ({
        email: slug(name) + '@' + STAFF_DOMAIN, name,
        is_staff: true, is_admin: false, admin_role: 'cashier',
        must_change_password: true, via: 'pos',
        internal_notes: SEED_TAG + ' sales rep recovered from INVDETAI.csv line items. '
          + 'No password or till PIN was imported -- set one in Users & Staff.',
      }));
      await insertMany(client, 'users',
        ['email', 'name', 'is_staff', 'is_admin', 'admin_role', 'must_change_password', 'via', 'internal_notes'],
        rows, 'ON CONFLICT (email) DO UPDATE SET ' + setFrom(['name', 'is_staff', 'admin_role']));
    }
    if (newCusts.size) {
      // Line items carry only a name -- no address, phone, account number or
      // terms -- so these are deliberately thin records, not half-guessed ones.
      const used = new Set((await client.query('SELECT email FROM users')).rows.map((r) => r.email));
      const rows = [];
      for (const name of newCusts.values()) {
        let e = slug(name) + '@' + CUST_DOMAIN, k = 1;
        while (used.has(e)) e = slug(name) + '-' + (++k) + '@' + CUST_DOMAIN;
        used.add(e);
        rows.push({
          email: e, name, via: 'pos', is_staff: false, is_admin: false,
          company_name: name, customer_type: 'retail', price_tier: 'retail',
          internal_notes: SEED_TAG + ' recovered from INVDETAI.csv line items; name only, '
            + 'the old system never exported a header for these invoices',
        });
      }
      const COLS = ['email', 'name', 'via', 'is_staff', 'is_admin', 'company_name',
                    'customer_type', 'price_tier', 'internal_notes'];
      await insertMany(client, 'users', COLS, rows, 'ON CONFLICT (email) DO UPDATE SET ' + setFrom(COLS.slice(1)));
    }
    // Refresh the lookups so the sales below can point at the new rows.
    for (const r of (await client.query('SELECT id, name FROM users WHERE is_staff = true')).rows) {
      if (r.name) staffId.set(norm(r.name), r.id);
    }
    for (const r of (await client.query('SELECT id, name FROM users WHERE email LIKE $1', ['%@' + CUST_DOMAIN])).rows) {
      if (r.name && !customerId.has(norm(r.name))) customerId.set(norm(r.name), r.id);
    }

    // ---- what INVPAY says was paid against each of them ----
    const payRows = new Map();
    eachRow(path.join(CSV_DIR, PAY_FILE), (r) => {
      const num = clean(r.INV_NUMBER);
      if (!agg.has(num)) return;
      let list = payRows.get(num);
      if (!list) { list = []; payRows.set(num, list); }
      list.push(r);
    });

    // ---- the headers ----
    const rebuiltMeta = new Map();
    const rows = [];
    let assumedSettled = 0;
    for (const [num, a] of agg) {
      const sub = Math.round(a.sub * 100) / 100;
      const tax = Math.round(a.tax * 100) / 100;
      const total = Math.round((sub + tax) * 100) / 100;
      const cname = a.cname || 'CASH';
      const cid = customerId.get(norm(cname)) ?? customerId.get('CASH') ?? null;
      const repId = a.rep ? (staffId.get(norm(a.rep)) ?? null) : null;
      // What INVPAY recorded against it, capped at the invoice: a payment row
      // that covers several invoices must not make this one look overpaid.
      let payTotal = 0, isCharge = false;
      for (const p of (payRows.get(num) || [])) {
        const m = tenderOf(p.PAY_DESC);
        if (m === null) continue;
        if (m === 'account') { isCharge = true; continue; }
        payTotal += money(p.AMOUNT) ?? 0;
      }
      // A rebuilt invoice is treated as settled unless INVPAY explicitly marks
      // it CHARGE. Reading a balance out of INVPAY's silence would be wrong
      // here: its coverage of these invoices is 100% for 2008-2011 and then
      // falls to ~80% from 2012 on, which is a gap in the export, not a decade
      // of unpaid bills. Believing it would put J$179m of receivables -- J$160m
      // of it on invoices with no payment row at all -- onto customers who
      // mostly paid cash over the counter ten years ago. A CHARGE marker is
      // positive evidence of credit, so those keep their real balance.
      const paid = isCharge ? Math.min(Math.round(payTotal * 100) / 100, total) : total;
      if (!isCharge && Math.round(payTotal * 100) / 100 < total - 0.005) assumedSettled++;
      const bal = Math.round((total - paid) * 100) / 100;
      rows.push({
        receipt_number: num, invoice_number: num,
        cashier_id: repId, cashier_name: a.rep, sales_rep_name: a.rep,
        customer_id: cid, customer_name: cname, customer_phone: null,
        subtotal_usd: sub, discount_usd: 0, tax_usd: tax, total_usd: total,
        amount_paid_usd: paid, balance_due_usd: bal > 0 ? bal : 0,
        payment_status: bal > 0.005 ? (paid > 0.005 ? 'partial' : 'unpaid') : 'paid',
        tax_exempt: tax <= 0.005,
        reference: null, payment_method: 'cash', voided: false, voided_at: null,
        notes: SEED_TAG + ' header rebuilt from INVDETAI.csv line items '
          + '(INVOICE.csv has no header row for this invoice)',
        created_at: a.date + ' ' + isoTime(a.time),
      });
      rebuiltMeta.set(num, { date: a.date, total, paid, custId: cid, repId, cname });
    }
    const COLS = Object.keys(rows[0]);
    const back = await insertMany(client, 'pos_sales', COLS, rows,
      'ON CONFLICT (receipt_number) DO UPDATE SET ' + setFrom(COLS.filter((c) => c !== 'receipt_number')),
      'RETURNING id, receipt_number');
    const rebuiltId = new Map();
    for (const r of back) rebuiltId.set(r.receipt_number, r.id);
    const revenue = rows.reduce((s, r) => s + r.total_usd, 0);
    say(`rebuild     : ${rows.length} invoice headers rebuilt from line items, `
      + `J$${revenue.toLocaleString(undefined, { maximumFractionDigits: 0 })} of sales `
      + `(${noNumber} detail rows carry no invoice number and were skipped)`);
    say(`              + ${newReps.size} sales reps and ${newCusts.size} customers recovered from those lines; `
      + `${assumedSettled} taken as settled where ${PAY_FILE} recorded less than the invoice (see note above)`);

    // ---- pass 2: the line items ----
    const ids = [...rebuiltId.values()];
    for (let i = 0; i < ids.length; i += 20000) {
      await client.query('DELETE FROM pos_sale_items WHERE sale_id = ANY($1::int[])', [ids.slice(i, i + 20000)]);
    }
    const items = [];
    let unmatched = 0;
    const missingSku = new Set();
    eachRow(path.join(CSV_DIR, 'INVDETAI.csv'), (r) => {
      const sid = rebuiltId.get(clean(r.INV_NUMBER));
      if (!sid) return;
      const img = skuToImg.get(norm(r.SKU)) ?? null;
      if (!img && clean(r.SKU)) { unmatched++; missingSku.add(clean(r.SKU)); }
      const q = qty(r.QUANTITY) || 1;
      const unit = money(r.UNIT);
      const amount = money(r.AMOUNT);
      items.push({
        sale_id: sid, product_img: img,
        description: clean(r.DESC) || clean(r.SKU) || '(no description)',
        qty: q,
        unit_price_usd: unit ?? (amount != null && q ? Math.round((amount / q) * 100) / 100 : null),
        total_usd: amount ?? (unit != null ? Math.round(unit * q * 100) / 100 : null),
      });
    });
    await insertMany(client, 'pos_sale_items',
      ['sale_id', 'product_img', 'description', 'qty', 'unit_price_usd', 'total_usd'], items);
    say(`  line items: ${items.length} (${unmatched} name ${missingSku.size} parts no longer in the `
      + `catalogue -- kept, description only)`);

    // ---- and their money, through the same path as the real headers ----
    for (let i = 0; i < ids.length; i += 20000) {
      await client.query('DELETE FROM sale_payments WHERE sale_id = ANY($1::int[])', [ids.slice(i, i + 20000)]);
    }
    const out = { tenders: [], settlements: [], stats: newStats() };
    const methodOf = new Map();
    for (const [num, meta] of rebuiltMeta) {
      const sid = rebuiltId.get(num);
      if (!sid) continue;
      methodOf.set(num, recordMoney(sid, num, meta, payRows.get(num) || [], out));
    }
    await insertMany(client, 'sale_payments',
      ['sale_id', 'method', 'amount_usd', 'reference', 'notes', 'created_at'], out.tenders);
    await insertMany(client, 'account_payments',
      ['customer_id', 'amount_usd', 'method', 'reference', 'received_by', 'notes', 'created_at'], out.settlements);
    const pairs = [...methodOf.entries()];
    for (let i = 0; i < pairs.length; i += 5000) {
      const s = pairs.slice(i, i + 5000);
      await client.query(
        `UPDATE pos_sales p SET payment_method = v.m
           FROM (SELECT * FROM unnest($1::int[], $2::text[]) AS t(id, m)) v
          WHERE p.id = v.id`,
        [s.map(([n]) => rebuiltId.get(n)), s.map(([, m]) => m)]);
    }
    say(`  payments  : ${out.tenders.length} counter tenders, ${out.settlements.length} account settlements; `
      + `${out.stats.onCredit} sold on credit, ${out.stats.owing} left part-paid, `
      + `${out.stats.noRows} with no payment row; ${out.stats.refunds} refund/credit-note rows noted`);
  }

  // ------------------------------------------------------- 7. receivals ----
  // History only -- see the note at the top of this file. qty_before/qty_after
  // are left null because the on-hand count at the time is not recoverable.
  if (wants('receivals')) {
    await client.query('DELETE FROM warehouse_activity WHERE kind = $1 AND notes LIKE $2',
      ['receive', SEED_TAG + '%']);
    await client.query('DELETE FROM warehouse_activity WHERE kind = $1 AND notes LIKE $2',
      ['adjust', SEED_TAG + '%']);
    const rows = [];
    let unmatched = 0, noDate = 0, zero = 0, returns = 0;
    const missing = new Set();
    eachRow(path.join(CSV_DIR, 'ibventory received.csv'), (r) => {
      const d = isoDate(r.REC_DATE);
      if (!d) { noDate++; return; }
      const img = skuToImg.get(norm(r.SKU)) ?? null;
      if (!img) { unmatched++; missing.add(clean(r.SKU)); return; }
      const q = qty(r.QTY);
      // 2,072 rows carry QTY 0 -- a price or cost revision with no stock
      // movement. 2,744 are negative: goods sent back, or a miscount being
      // corrected. Those are real history and are logged as 'adjust', which is
      // the kind the warehouse log already uses for a correction.
      if (q === 0) { zero++; return; }
      if (q < 0) returns++;
      rows.push({
        kind: q > 0 ? 'receive' : 'adjust', ref_kind: 'import', product_img: img,
        qty_delta: q, performed_by: null,
        notes: SEED_TAG + (q > 0
          ? ' historical receival from "ibventory received.csv" (stock not adjusted)'
          : ' historical return/correction from "ibventory received.csv" (stock not adjusted)'),
        meta_json: JSON.stringify({
          unit_cost_usd: money(r.LCOST), price_usd: money(r.LPRICE),
          wholesale_usd: money(r.LWPRICE), currency: clean(r.LPRICECURR) || null,
          bill_no: clean(r.BILL_NO) || null, order_no: clean(r.ORDERNO) || null,
          reference: clean(r.REFERENCE) || null, uom: clean(r.UNIT1) || null,
        }),
        created_at: d + ' 12:00:00',
      });
    });
    await insertMany(client, 'warehouse_activity',
      ['kind', 'ref_kind', 'product_img', 'qty_delta', 'performed_by', 'notes', 'meta_json', 'created_at'], rows);
    const units = rows.filter((r) => r.qty_delta > 0).reduce((s, r) => s + r.qty_delta, 0);
    const back = -rows.filter((r) => r.qty_delta < 0).reduce((s, r) => s + r.qty_delta, 0);
    say(`receivals   : ${rows.length - returns} receipts (${units.toLocaleString()} units in) and `
      + `${returns} returns/corrections (${back.toLocaleString()} units out), 2014-2026`);
    say(`              ${zero} price-only rows with no stock movement were skipped, as were `
      + `${unmatched} rows naming ${missing.size} parts not in the catalogue (${noDate} unreadable dates). `
      + `Stock counts were NOT changed -- these are history.`);
  }

  if (DRY) {
    await client.query('ROLLBACK');
    say(`\n--dry-run: everything above was rolled back. (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } else {
    await client.query('COMMIT');
    say(`\ncommitted in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
} catch (e) {
  await client.query('ROLLBACK');
  console.error('\nFAILED -- nothing was changed:', e.message);
  console.error(e.stack);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
