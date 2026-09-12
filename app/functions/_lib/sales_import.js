// CSV/TSV importer for seeding historical sales — backfilling a new shop's
// past sales so reports and the reorder-analysis demand calc (which reads
// pos_sales + pos_sale_items) have history to work from, instead of assuming
// zero demand on day one. Shares the low-level tabular-file plumbing with
// inventory_import.js (header sniffing, delimiter detection, cell coercion).
//
// One CSV row = one historical sale of one line item (not a multi-line
// invoice) — the simplest shape that still feeds demand analysis correctly,
// since that reads qty per product per day regardless of which receipt it
// was rung up under. A free-form "receipt" column is kept as a reference,
// never as the row's actual receipt_number (which must be unique and is
// always generated fresh, so a colliding or duplicated value in the file
// can't break the import).
//
// Row shape (per line): { key, qty, unit_price_usd|null, date, customer|null,
//   payment_method|null, receipt|null, line }. key is matched against
// products.sku or products.img by the route, same as the receival importer.
// date is required — an unknown sale date would silently distort the demand
// window, so (unlike receival's date) a missing or unparseable one skips the
// row instead of defaulting to "today".

import {
  readTabular, detectHeader, cellText, toMoney, toInt, isBlankRow,
} from './inventory_import.js';

const FIELD_SYNONYMS = {
  sku: ['sku', 'item', 'item_no', 'item_number', 'itemno', 'part', 'part_no',
        'part_number', 'partno', 'partnumber', 'code', 'part_code', 'stock_code', 'img'],
  qty: ['qty', 'quantity', 'qty_sold', 'units', 'count', 'units_sold'],
  unit_price_usd: ['unit_price_usd', 'price_usd', 'price', 'unit_price', 'sale_price',
                    'sell_price', 'amount', 'line_total'],
  date: ['date', 'sale_date', 'date_sold', 'sold_on', 'sold_date',
         'transaction_date', 'receipt_date', 'invoice_date'],
  customer: ['customer', 'customer_name', 'client', 'buyer', 'sold_to'],
  payment_method: ['payment_method', 'payment', 'method', 'tender', 'tender_type'],
  receipt: ['receipt', 'receipt_number', 'invoice', 'invoice_number', 'reference',
            'ref', 'order_number', 'transaction_id', 'transaction_no'],
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
// anything else -- ambiguous or unrecognisable dates are left for the caller
// to skip rather than guessed at.
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

    const dateRaw = get(row, 'date');
    const date = toDateStr(dateRaw);
    if (date == null) {
      issues.push({ line: lineNo, level: 'skipped', message: dateRaw ? ('date "' + dateRaw + '" was not recognised') : 'no sale date given' });
      continue;
    }

    const priceRaw = get(row, 'unit_price_usd');
    const price = toMoney(priceRaw);
    if (priceRaw && price == null)
      issues.push({ line: lineNo, level: 'warning', message: 'price "' + priceRaw + '" is not a number - the part\'s current price will be used instead' });

    lines.push({
      key,
      qty,
      unit_price_usd: price,
      date,
      customer: get(row, 'customer') || null,
      payment_method: get(row, 'payment_method') || null,
      receipt: get(row, 'receipt') || null,
      line: lineNo,
    });
  }

  return { lines, issues };
}

export function parseSalesFile(buffer, filename) {
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
      'at least a part number, a quantity and a sale date. Recognised names include: ' +
      'Item, Part No, SKU, Qty, Quantity, Date, Sale Date, Price.');
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

// Offered as a download from the admin panel so there is a known-good shape
// to start from. Prices are left blank on two rows on purpose, to show that
// the part's current price fills in when the file doesn't have one.
export const SALES_TEMPLATE_CSV = [
  'date,sku,qty,unit_price_usd,customer,payment_method,receipt',
  '2026-08-01,18215-TA0-A01,2,12.50,,cash,',
  '2026-08-03,BMP-001,1,180,Jane Doe,card,INV-0417',
  '2026-08-05,ALT-889,1,,,cash,',
].join('\r\n') + '\r\n';

export { FIELD_SYNONYMS as SALES_FIELD_SYNONYMS };
