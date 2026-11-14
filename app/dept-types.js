// =============================================================================
//  dept-types.js -- Department TYPES and their billing / stock / customer rules
//  (2026-11-05)
//
//  A department (terminal.js, table `departments`) has a `kind`: its TYPE.
//  Each type carries default rules; a department may override any rule in
//  departments.rules (JSONB: {billing:{}, stock:{}, customer:{}}). The rules a
//  sale obeys = the type's defaults with the department's overrides on top.
//
//  Kept as plain data so the setup screen (terminal.html) can draw the rules
//  panel from FIELDS, and the sale route can read effective() at sale time.
//  'parts' keeps its old key (shown as Auto Parts) so existing departments and
//  code that tests kind = 'general' / 'parts' are unaffected.
// =============================================================================
'use strict';

const ALL_PAY = ['cash', 'card', 'transfer', 'account', 'cheque'];

// The rule fields, grouped. type: bool | num | pct | money | choice | multi | list
const FIELDS = {
  billing: [
    { key: 'price_basis', label: 'Price basis', type: 'choice', options: [
      ['customer_tier', "Customer's own price tier"], ['retail', 'Retail price'], ['trade', 'Trade price (forced)'],
      ['fleet', 'Fleet price (forced)'], ['dealer', 'Dealer price (forced)'], ['cost_plus', 'Cost plus %']] },
    { key: 'cost_plus_pct', label: 'Cost plus (%)', type: 'pct', when: ['price_basis', 'cost_plus'] },
    { key: 'gct', label: 'GCT', type: 'choice', options: [['standard', 'Standard rate'], ['custom', 'Different rate'], ['off', 'No GCT in this department']] },
    { key: 'gct_rate', label: 'GCT rate (%)', type: 'pct', when: ['gct', 'custom'] },
    { key: 'service_charge_pct', label: 'Service charge (%)', type: 'pct' },
    { key: 'payments', label: 'Payment methods allowed', type: 'multi', options: [
      ['cash', 'Cash'], ['card', 'Card'], ['transfer', 'Bank transfer'], ['account', 'On account (credit)'], ['cheque', 'Cheque']] },
    { key: 'deposit_pct', label: 'Deposit required (%)', type: 'pct' },
    { key: 'min_sale', label: 'Minimum sale (J$)', type: 'money' },
    { key: 'min_line_qty', label: 'Minimum quantity per line', type: 'num' },
    { key: 'max_discount_pct', label: 'Most discount without a manager PIN (%)', type: 'pct' },
    { key: 'document', label: 'Printed document', type: 'choice', options: [
      ['receipt', 'Receipt'], ['tax_invoice', 'Tax invoice'], ['work_order', 'Work order'], ['sales_agreement', 'Sales agreement'], ['bill', 'Bill']] },
    { key: 'returns_allowed', label: 'Returns allowed', type: 'bool' },
    { key: 'returns_days', label: 'Returns within (days)', type: 'num', when: ['returns_allowed', true] },
    { key: 'exchange_only', label: 'Exchange only (no cash back)', type: 'bool', when: ['returns_allowed', true] },
    { key: 'restocking_pct', label: 'Restocking fee (%)', type: 'pct', when: ['returns_allowed', true] },
    { key: 'warranty_days', label: 'Warranty printed on the bill (days)', type: 'num' },
    { key: 'labour_lines', label: 'Labour lines on the bill', type: 'bool' },
  ],
  stock: [
    { key: 'track', label: 'Track stock', type: 'bool' },
    { key: 'allow_negative', label: 'Allow selling below zero', type: 'bool', when: ['track', true] },
    { key: 'serial_required', label: 'Serial / VIN required on each line', type: 'bool' },
    { key: 'condition_required', label: 'Condition grade required (A / B / C)', type: 'bool' },
    { key: 'core_charges', label: 'Add core charges', type: 'bool' },
    { key: 'weighed_barcodes', label: 'Sell by weight / price barcodes', type: 'bool' },
    { key: 'unique_items', label: 'Each item is one-off (qty 1)', type: 'bool' },
    { key: 'zones', label: 'Warehouse zones it picks from', type: 'list' },
    { key: 'bin_prefixes', label: 'Bins it picks from (codes or starts of codes)', type: 'list' },
  ],
  customer: [
    { key: 'walkin_allowed', label: 'Walk-in (no named customer) allowed', type: 'bool' },
    { key: 'phone_required', label: 'Phone number required', type: 'bool' },
    { key: 'trn_required', label: 'TRN required', type: 'bool' },
    { key: 'id_required', label: 'Photo ID number required', type: 'bool' },
    { key: 'vehicle_required', label: 'Vehicle required (plate or VIN)', type: 'bool' },
    { key: 'trade_account_required', label: 'Trade account required', type: 'bool' },
  ],
};

// Baseline every type starts from; each type below changes only what differs.
const BASE = {
  billing: { price_basis: 'customer_tier', cost_plus_pct: 0, gct: 'standard', gct_rate: 15, service_charge_pct: 0, payments: ALL_PAY.slice(),
    deposit_pct: 0, min_sale: 0, min_line_qty: 0, max_discount_pct: 10, document: 'tax_invoice', returns_allowed: true, returns_days: 30,
    exchange_only: false, restocking_pct: 0, warranty_days: 0, labour_lines: false },
  stock: { track: true, allow_negative: false, serial_required: false, condition_required: false, core_charges: false, weighed_barcodes: false,
    unique_items: false, zones: [], bin_prefixes: [] },
  customer: { walkin_allowed: true, phone_required: false, trn_required: false, id_required: false, vehicle_required: false, trade_account_required: false },
};

const TYPES = [
  { key: 'parts', label: 'Auto Parts', icon: '🔧', blurb: 'Counter parts sales: customer price tiers, core charges, 30-day returns.',
    billing: { restocking_pct: 10 }, stock: { core_charges: true } },
  { key: 'used_parts', label: 'Used Parts', icon: '♻️', blurb: 'One-off salvaged parts: graded, short warranty, exchange-only returns.',
    billing: { price_basis: 'retail', payments: ['cash', 'card', 'transfer'], returns_days: 7, exchange_only: true, warranty_days: 30 },
    stock: { condition_required: true, unique_items: true }, customer: { phone_required: true } },
  { key: 'service', label: 'Service', icon: '🛠️', blurb: 'Workshop jobs: work order with labour, customer and vehicle required.',
    billing: { document: 'work_order', labour_lines: true, returns_allowed: false },
    customer: { walkin_allowed: false, phone_required: true, vehicle_required: true } },
  { key: 'carsales', label: 'Car Sales', icon: '🚗', blurb: 'Vehicle sales: VIN, deposit, buyer TRN and ID, sales agreement.',
    billing: { price_basis: 'retail', payments: ['transfer', 'cheque', 'card'], deposit_pct: 10, max_discount_pct: 0, document: 'sales_agreement', returns_allowed: false },
    stock: { serial_required: true, unique_items: true },
    customer: { walkin_allowed: false, phone_required: true, trn_required: true, id_required: true } },
  { key: 'supermarket', label: 'Supermarket', icon: '🛒', blurb: 'Fast checkout: receipts, scale barcodes, cash and card.',
    billing: { price_basis: 'retail', payments: ['cash', 'card'], max_discount_pct: 5, document: 'receipt', returns_days: 7 },
    stock: { allow_negative: true, weighed_barcodes: true } },
  { key: 'hardware', label: 'Hardware', icon: '🔨', blurb: 'Tools and building supplies: customer tiers, trade credit, 30-day returns.',
    billing: {}, stock: {} },
  { key: 'wholesale', label: 'Wholesale', icon: '📦', blurb: 'Trade only: trade price, minimum order, TRN and trade account.',
    billing: { price_basis: 'trade', payments: ['transfer', 'cheque', 'account'], min_sale: 20000, min_line_qty: 1, max_discount_pct: 5 },
    customer: { walkin_allowed: false, trn_required: true, trade_account_required: true } },
  { key: 'restaurant', label: 'Restaurant', icon: '🍽️', blurb: 'Menu sales: bill with service charge, stock not tracked.',
    billing: { price_basis: 'retail', payments: ['cash', 'card'], service_charge_pct: 10, document: 'bill', returns_allowed: false, max_discount_pct: 0 },
    stock: { track: false } },
  { key: 'general', label: 'General (managers: all departments)', icon: '🏬', blurb: 'Managers selling from every department at once. Follows Auto Parts rules.',
    billing: {}, stock: {} },
];
const BY_KEY = Object.fromEntries(TYPES.map((t) => [t.key, t]));

const clone = (o) => JSON.parse(JSON.stringify(o));
function defaults(kind) {
  const t = BY_KEY[kind] || BY_KEY.parts;
  const out = clone(BASE);
  for (const g of ['billing', 'stock', 'customer']) Object.assign(out[g], clone(t[g] || {}));
  return out;
}

// Validate a department's overrides against FIELDS; unknown keys dropped.
function cleanRules(input) {
  const src = input && typeof input === 'object' ? input : {};
  const out = { billing: {}, stock: {}, customer: {} };
  for (const g of Object.keys(FIELDS)) {
    const s = src[g] && typeof src[g] === 'object' ? src[g] : {};
    for (const f of FIELDS[g]) {
      if (!(f.key in s) || s[f.key] === undefined) continue;
      const v = s[f.key];
      if (v === null) continue;                     // null = back to the type default
      if (f.type === 'bool') out[g][f.key] = v === true || v === 'true' || v === 'on' || v === 1;
      else if (f.type === 'num' || f.type === 'money' || f.type === 'pct') {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) { const e = new Error(f.label + ': numbers only'); e.status = 400; e.publicMessage = e.message; throw e; }
        if (f.type === 'pct' && n > 100) { const e = new Error(f.label + ': 0 to 100'); e.status = 400; e.publicMessage = e.message; throw e; }
        out[g][f.key] = Math.round(n * 100) / 100;
      } else if (f.type === 'choice') {
        if (f.options.some((o) => o[0] === v)) out[g][f.key] = v;
      } else if (f.type === 'multi') {
        const ok = f.options.map((o) => o[0]);
        out[g][f.key] = [...new Set((Array.isArray(v) ? v : String(v).split(',')).map((x) => String(x).trim()).filter((x) => ok.includes(x)))];
      } else if (f.type === 'list') {
        out[g][f.key] = [...new Set((Array.isArray(v) ? v : String(v).split(',')).map((x) => String(x).trim().toUpperCase()).filter(Boolean))].slice(0, 100);
      }
    }
  }
  return out;
}

// Only the values that differ from the type's default are kept as overrides.
function diffRules(kind, rules) {
  const d = defaults(kind), r = cleanRules(rules), out = { billing: {}, stock: {}, customer: {} };
  for (const g of Object.keys(out)) for (const k of Object.keys(r[g])) {
    const norm = (v) => JSON.stringify(Array.isArray(v) ? v.slice().sort() : v);   // order of ticked boxes doesn't matter
    if (norm(r[g][k]) !== norm(d[g][k])) out[g][k] = r[g][k];
  }
  return out;
}

function effective(kind, rules) {
  const d = defaults(kind), r = cleanRules(rules);
  for (const g of Object.keys(d)) Object.assign(d[g], r[g]);
  if (d.billing.gct === 'standard') d.billing.gct_rate = null;   // the app's own TAX_RATE applies
  if (d.billing.gct === 'off') d.billing.gct_rate = 0;
  return d;
}

const isType = (k) => !!BY_KEY[k];

module.exports = { FIELDS, TYPES, defaults, cleanRules, diffRules, effective, isType,
  catalogue: () => ({ fields: FIELDS, types: TYPES.map((t) => ({ key: t.key, label: t.label, icon: t.icon, blurb: t.blurb, defaults: defaults(t.key) })) }) };
