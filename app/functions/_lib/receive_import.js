// CSV/TSV importer for bulk stock receival (the "Receive stock without a PO"
// panel). Shares the low-level tabular-file plumbing with inventory_import.js
// (header sniffing, delimiter detection, cell coercion) but keeps its own
// column synonyms and row shape: a receival file only ever *adds* quantity to
// parts that already exist — it never creates new products, so every row
// carries a part number to match against the catalogue rather than a full
// item description.
//
// Row shape (per line): { key, name, qty, unit_cost_usd|null, price_usd|null,
//   bin_location|null, notes, date_received|null, line }. key is whatever the
// file used to name the part (SKU/part# or image id) — matched against
// products.sku or products.img by the route, same as the manual "Receive
// without a PO" form. date_received lets a backfill of past deliveries carry
// its own received date per line instead of stamping every row with today;
// a blank cell falls back to "now" at commit time.

import {
  readTabular, detectHeader, cellText, toMoney, toInt, isBlankRow,
} from './inventory_import.js';

const FIELD_SYNONYMS = {
  sku: ['sku', 'item', 'item_no', 'item_number', 'itemno', 'part', 'part_no',
        'part_number', 'partno', 'partnumber', 'code', 'part_code', 'stock_code', 'img'],
  name: ['name', 'description', 'desc', 'part_name', 'item_description',
         'item_name', 'product', 'product_name', 'details'],
  qty: ['qty', 'quantity', 'qty_received', 'qty_recv', 'qty_rcvd', 'received',
        'received_qty', 'qty_now', 'units', 'count', 'qty_in'],
  unit_cost_usd: ['unit_cost_usd', 'unit_cost', 'cost_usd', 'cost', 'buy_price',
                  'wholesale', 'wholesale_price', 'landed_cost'],
  price_usd: ['price_usd', 'price', 'retail', 'retail_price', 'selling_price',
              'sale_price', 'unit_price', 'sell', 'sell_price', 'list_price'],
  bin_location: ['bin', 'bin_1', 'bin1', 'bin_location', 'rack', 'shelf',
                 'bin_no', 'binlocation'],
  date_received: ['date', 'date_received', 'received_date', 'receipt_date',
                  'received_on', 'delivery_date', 'received_at'],
  notes: ['notes', 'note', 'remark', 'remarks', 'comment', 'comments'],
};
const CANONICAL_FIELDS = Object.keys(FIELD_SYNONYMS);

const HEADER_LOOKUP = (() => {
  const m = new Map();
  for (const field of CANONICAL_FIELDS) {
    for (const syn of FIELD_SYNONYMS[field]) {
      if (!m.has(syn)) m.set(syn, field);
    }
  }
  return m;
})();

function pad2(n) { return String(n).padStart(2, '0'); }

// Accepts an ISO date ("2026-09-11", optionally with a time) or a US-style
// slash date ("9/11/2026", "09/11/26") and returns "YYYY-MM-DD", or null for
// anything else -- ambiguous or unrecognisable dates are left for "now"
// rather than guessed at.
function toDateStr(raw) {
  const t = cellText(raw);
  if (!t) return null;
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) {
    const y = +m[1], mo = +m[2], d = +m[3];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return y + '-' + pad2(mo) + '-' + pad2(d);
    return null;
  }
  m = t.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (m) {
    const mo = +m[1], d = +m[2];
    let y = +m[3];
    if (y < 100) y += y < 70 ? 2000 : 1900;
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return y + '-' + pad2(mo) + '-' + pad2(d);
  }
  return null;
}

function buildLines(rows, headerIndex, mapping) {
  const lines = [];
  const issues = [];

  const get = (row, field) => {
    const col = mapping[field];
    return col == null ? '' : cellText(row[col]);
  };

  for (let i = headerIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    if (isBlankRow(row)) continue;
    const lineNo = i + 1;

    const key = get(row, 'sku');
    if (!key) {
      issues.push({ line: lineNo, level: 'skipped', message: 'no part number to match against existing stock' });
      continue;
    }

    const qtyRaw = get(row, 'qty');
    const qty = toInt(qtyRaw, null);
    if (qty == null || qty < 1) {
      issues.push({ line: lineNo, level: 'skipped', message: qtyRaw ? ('quantity "' + qtyRaw + '" is not a positive whole number') : 'no quantity given' });
      continue;
    }

    const cost = toMoney(get(row, 'unit_cost_usd'));
    if (mapping.unit_cost_usd != null && get(row, 'unit_cost_usd') && cost == null)
      issues.push({ line: lineNo, level: 'warning', message: 'cost "' + get(row, 'unit_cost_usd') + '" is not a number - left unchanged' });

    const price = toMoney(get(row, 'price_usd'));
    if (mapping.price_usd != null && get(row, 'price_usd') && price == null)
      issues.push({ line: lineNo, level: 'warning', message: 'price "' + get(row, 'price_usd') + '" is not a number - left unchanged' });

    const dateRaw = get(row, 'date_received');
    const dateReceived = toDateStr(dateRaw);
    if (dateRaw && dateReceived == null)
      issues.push({ line: lineNo, level: 'warning', message: 'date "' + dateRaw + '" was not recognised - received as of now instead' });

    lines.push({
      key,
      name: get(row, 'name') || null,
      qty,
      unit_cost_usd: cost,
      price_usd: price,
      bin_location: get(row, 'bin_location') || null,
      date_received: dateReceived,
      notes: get(row, 'notes') || null,
      line: lineNo,
    });
  }

  return { lines, issues };
}

export function parseReceivalFile(buffer, filename) {
  const { rows, format, detail } = readTabular(buffer, filename);
  if (!rows.length) {
    const err = new Error('That file has no rows in it.');
    err.userFacing = true;
    throw err;
  }

  const header = detectHeader(rows, 25, HEADER_LOOKUP);
  if (header.headerIndex === -1) {
    const err = new Error(
      'Could not find a header row. The file needs a row naming the columns - ' +
      'at least a part number and a quantity received. Recognised names include: ' +
      'Item, Part No, SKU, Qty, Quantity, Received, Cost, Price, Bin.');
    err.userFacing = true;
    throw err;
  }

  const { lines, issues } = buildLines(rows, header.headerIndex, header.mapping);
  return {
    format,
    detail,
    headerLine: header.headerIndex + 1,
    headers: header.headers,
    mapped: Object.keys(header.mapping).reduce((acc, f) => {
      acc[f] = header.headers[header.mapping[f]];
      return acc;
    }, {}),
    ignoredColumns: header.unmapped,
    totalDataRows: rows.length - header.headerIndex - 1,
    lines,
    issues,
  };
}

export const RECEIVE_TEMPLATE_CSV = [
  'sku,qty,unit_cost_usd,price_usd,bin,date,notes',
  '18215-TA0-A01,10,7.00,12.50,D-30A,2026-09-08,',
  'BMP-001,4,120,180,A-12,2026-09-08,damaged carton - 1 unit set aside',
  'ALT-889,6,95,145,C-04,2026-09-10,',
].join('\r\n') + '\r\n';

export { FIELD_SYNONYMS as RECEIVE_FIELD_SYNONYMS };
