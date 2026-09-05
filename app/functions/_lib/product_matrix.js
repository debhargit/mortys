// Shared vocabulary for matrix items (one parent, many child products.img
// rows across attribute axes) — used by both functions/_routes/product_matrix.js
// and the small override-bookkeeping hook in inventory.js's product PATCH, so
// the two never drift on what "shared" means or how to compare a value.
//
// `key` is the request-body field name (identical to what admin.html's
// productEditModal.peSave already sends for every product edit), `col` the
// matching column on both `products` and `product_matrices`, `kind` drives
// toColumnValue()/valuesEqual() below. Deliberately excludes name/sku/
// barcode/img/stock_count/low_threshold/location/bin_location — those are
// per-child by nature, not shared defaults.
import { usdToCents } from './money.js';

export const PUSHABLE_FIELDS = [
  { key: 'price_usd', col: 'price_cents', kind: 'usd' },
  { key: 'cost_usd', col: 'cost_cents', kind: 'usd' },
  { key: 'list_price_usd', col: 'list_price_cents', kind: 'usd' },
  { key: 'markup_pct', col: 'markup_pct', kind: 'num' },
  { key: 'category', col: 'category', kind: 'str' },
  { key: 'condition', col: 'condition', kind: 'str' },
  { key: 'make_model', col: 'make_model', kind: 'str' },
  { key: 'warranty_days', col: 'warranty_days', kind: 'int' },
  { key: 'serial_required', col: 'serial_required', kind: 'bit' },
  { key: 'core_charge_usd', col: 'core_charge_cents', kind: 'usd' },
  { key: 'env_fee_usd', col: 'env_fee_cents', kind: 'usd' },
  { key: 'supplier_id', col: 'supplier_id', kind: 'int' },
  { key: 'supplier_part_no', col: 'supplier_part_no', kind: 'str' },
  { key: 'costing_method', col: 'costing_method', kind: 'str' },
  { key: 'stock_uom', col: 'stock_uom', kind: 'str' },
  { key: 'purchase_uom', col: 'purchase_uom', kind: 'str' },
  { key: 'units_per_purchase', col: 'units_per_purchase', kind: 'num' },
];

// core_charge_cents/env_fee_cents are NOT NULL DEFAULT 0 on both tables — a
// blank value means "zero", not "unknown" (mirrors inventory.js's existing
// `usdToCents(b.core_charge_usd) || 0` rule for the plain per-product PATCH).
const ZERO_NOT_NULL_COLS = new Set(['core_charge_cents', 'env_fee_cents']);

// raw (request-body string/number/bool) -> the value actually stored in the column.
export function toColumnValue(kind, col, raw) {
  if (kind === 'usd') {
    const c = usdToCents(raw === '' ? null : raw);
    return c == null ? (ZERO_NOT_NULL_COLS.has(col) ? 0 : null) : c;
  }
  if (kind === 'int') return raw === '' || raw == null ? null : parseInt(raw, 10);
  if (kind === 'num') return raw === '' || raw == null || !Number.isFinite(Number(raw)) ? null : Number(raw);
  if (kind === 'bit') return raw === false || raw === 0 || raw === '0' || raw === 'false' || raw == null ? 0 : 1;
  // str
  return raw == null ? null : (String(raw).trim() || null);
}

export function valuesEqual(kind, a, b) {
  if (kind === 'num' || kind === 'usd') {
    const na = a == null ? null : Number(a), nb = b == null ? null : Number(b);
    if (na == null || nb == null) return na === nb;
    return Math.abs(na - nb) < 0.0001;
  }
  return (a == null ? null : a) === (b == null ? null : b);
}

// Build "<base name> — <axis1>[ / <axis2>]" and a URL/SKU-safe slug.
export function slugify(s) {
  return String(s || '').trim().toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'X';
}

export function childName(baseName, axis1Value, axis2Value) {
  return baseName + ' — ' + axis1Value + (axis2Value ? ' / ' + axis2Value : '');
}

export function childSkuBase(baseSkuOrName, axis1Value, axis2Value) {
  return slugify(baseSkuOrName) + '-' + slugify(axis1Value) + (axis2Value ? '-' + slugify(axis2Value) : '');
}
