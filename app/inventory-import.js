// ============================================================================
//  inventory-import.js — turn a CSV / spreadsheet into product rows
//
//  Pure parsing and mapping only: nothing here touches the database or knows
//  what an Express request is. server.js owns the routes and the SQL; this
//  file owns the messy part, which is that real inventory files are never in
//  the shape a programmer would have picked.
//
//  Handles, because the shop's own "Stock Listing" export needs all of it:
//    * two repeated title rows before the real header row
//    * columns called "Item" / "Description" / "Bin 1" / "Bin 2" / "Quantity"
//      rather than sku / name / bin / stock_count
//    * every value padded with spaces
//    * comma, semicolon or tab separators
//    * .xlsx straight out of Excel or Google Sheets
//    * prices written as "$1,234.56"
// ============================================================================

'use strict';

// ---------------------------------------------------------------- columns --
// Canonical field -> every header spelling seen in the wild that means it.
// Compared after lower-casing and collapsing non-alphanumerics to "_", so
// "Bin 1", "BIN-1" and "bin_1" all arrive here as "bin_1".
const FIELD_SYNONYMS = {
  sku: ['sku', 'item', 'item_no', 'item_number', 'itemno', 'part', 'part_no',
        'part_number', 'partno', 'partnumber', 'code', 'part_code', 'stock_code'],
  name: ['name', 'description', 'desc', 'part_name', 'item_description',
         'item_name', 'product', 'product_name', 'details'],
  make_model: ['make_model', 'makemodel', 'vehicle', 'fitment', 'application',
               'fits', 'model', 'make', 'vehicle_model'],
  category: ['category', 'cat', 'type', 'group', 'department', 'class'],
  condition: ['condition', 'cond', 'state', 'grade'],
  price_usd: ['price_usd', 'price', 'retail', 'retail_price', 'selling_price',
              'sale_price', 'unit_price', 'sell', 'sell_price', 'list_price'],
  cost_usd: ['cost_usd', 'cost', 'unit_cost', 'buy_price', 'wholesale',
             'wholesale_price', 'landed_cost'],
  stock_count: ['stock_count', 'stock', 'qty', 'quantity', 'on_hand', 'onhand',
                'qty_on_hand', 'count', 'balance', 'available', 'in_stock'],
  low_threshold: ['low_threshold', 'reorder', 'reorder_point', 'reorder_level',
                  'min_stock', 'minimum', 'min_qty', 'low_stock'],
  bin_location: ['bin', 'bin_1', 'bin1', 'bin_location', 'rack', 'shelf',
                 'bin_no', 'binlocation'],
  bin_2: ['bin_2', 'bin2', 'secondary_bin', 'alt_bin'],
  location: ['location', 'warehouse', 'branch', 'store', 'site', 'depot'],
  barcode: ['barcode', 'upc', 'ean', 'scan_code'],
  img: ['img', 'image', 'photo', 'picture', 'image_url', 'photo_url'],
};

const CANONICAL_FIELDS = Object.keys(FIELD_SYNONYMS);

const HEADER_LOOKUP = (() => {
  const m = new Map();
  for (const field of CANONICAL_FIELDS) {
    for (const syn of FIELD_SYNONYMS[field]) {
      // First declaration wins, so the canonical name never loses to a
      // synonym another field also claims.
      if (!m.has(syn)) m.set(syn, field);
    }
  }
  return m;
})();

function normaliseHeader(h) {
  return String(h == null ? '' : h)
    .replace(/﻿/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// ------------------------------------------------------------------ values --
function cellText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  // ExcelJS hands back objects for formulas, hyperlinks and rich text.
  if (typeof v === 'object') {
    if (v.text != null) return cellText(v.text);
    if (v.result != null) return cellText(v.result);
    if (v.hyperlink != null) return cellText(v.hyperlink);
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('').trim();
    if (v.formula != null) return '';
  }
  return String(v).trim();
}

// "$1,234.56" -> 1234.56, "" -> null. Returns null rather than 0 for blanks:
// a missing price means "call for price", and a missing cost means unknown --
// writing 0 into either would be a claim the file never made.
function toMoney(raw) {
  const t = cellText(raw).replace(/[^0-9.\-]/g, '');
  if (!t || t === '-' || t === '.') return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function toInt(raw, fallback) {
  const t = cellText(raw).replace(/[^0-9\-]/g, '');
  if (!t || t === '-') return fallback;
  const n = parseInt(t, 10);
  return Number.isFinite(n) ? n : fallback;
}

// ------------------------------------------------------------- CSV parsing --
// Picks the separator by counting candidates outside quoted spans in the first
// few lines. Guessing wrong turns a whole file into one column, and a European
// export using ';' is common enough to be worth handling rather than blaming
// the user for.
function sniffDelimiter(text) {
  const sample = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 10).join('\n');
  const candidates = [',', ';', '\t', '|'];
  let best = ',';
  let bestCount = -1;
  for (const d of candidates) {
    let count = 0;
    let inQ = false;
    for (let i = 0; i < sample.length; i++) {
      const c = sample[i];
      if (c === '"') inQ = !inQ;
      else if (!inQ && c === d) count++;
    }
    if (count > bestCount) { bestCount = count; best = d; }
  }
  return best;
}

function parseDelimited(text, delim) {
  const out = [];
  let row = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') {
      inQ = true;
    } else if (c === delim) {
      row.push(cur); cur = '';
    } else if (c === '\n') {
      row.push(cur); out.push(row); row = []; cur = '';
    } else if (c !== '\r') {
      cur += c;
    }
  }
  if (cur.length || row.length) { row.push(cur); out.push(row); }
  return out;
}

function isBlankRow(row) {
  return !row || row.every((c) => cellText(c) === '');
}

// ------------------------------------------------------------ spreadsheets --
async function readWorkbook(buffer) {
  let ExcelJS;
  try {
    ExcelJS = require('exceljs');
  } catch (_) {
    const err = new Error(
      'Spreadsheet support is not installed on this server. Save the file as CSV and import that instead.');
    err.userFacing = true;
    throw err;
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets.find((s) => s.rowCount > 0) || wb.worksheets[0];
  if (!ws) {
    const err = new Error('That spreadsheet has no sheets in it.');
    err.userFacing = true;
    throw err;
  }
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    // Place each row at its true sheet position instead of just appending.
    // eachRow skips blank rows, so appending would shift everything below a
    // gap upwards -- and then every "line 47" in the report would point at a
    // different row than the one the operator sees when they open the file.
    const idx = row.number - 1;
    while (rows.length < idx) rows.push([]);
    const values = row.values || [];
    // ExcelJS row.values is 1-based with a hole at index 0.
    const cells = [];
    for (let i = 1; i < values.length; i++) cells.push(cellText(values[i]));
    rows[idx] = cells;
  });
  return { rows, sheetName: ws.name };
}

// Reads whatever was uploaded into a plain grid of strings.
async function readTabular(buffer, filename) {
  const ext = String(filename || '').toLowerCase().match(/\.[a-z0-9]+$/);
  const kind = ext ? ext[0] : '';

  if (kind === '.xls') {
    const err = new Error(
      'That is the old Excel .xls format, which cannot be read directly. ' +
      'Open it in Excel and use File -> Save As to save it as .xlsx or .csv, then import that.');
    err.userFacing = true;
    throw err;
  }

  // Sniff the real content rather than trusting the extension: a ZIP magic
  // number means it is genuinely an xlsx even if someone renamed it .csv, and
  // vice versa. Getting this wrong produces a wall of binary "rows".
  const looksZip = buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4B;

  if (kind === '.xlsx' || kind === '.xlsm' || looksZip) {
    const { rows, sheetName } = await readWorkbook(buffer);
    return { rows, format: 'xlsx', detail: sheetName };
  }

  let text = buffer.toString('utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const delim = sniffDelimiter(text);
  const rows = parseDelimited(text, delim);
  const delimName = delim === '\t' ? 'tab' : delim;
  return { rows, format: 'csv', detail: 'separator "' + delimName + '"' };
}

// ------------------------------------------------------------ header sniff --
// Scores every row in the first stretch of the file by how many of its cells
// are recognisable column names, and takes the best. Assuming row 0 is the
// header is what breaks the shop's own export, which repeats a title banner
// across two full rows before the real "Item,Description,..." line.
function detectHeader(rows, maxScan) {
  const limit = Math.min(rows.length, maxScan || 25);
  let best = { index: -1, score: 0, mapping: null };

  for (let i = 0; i < limit; i++) {
    if (isBlankRow(rows[i])) continue;
    const mapping = {};
    const seen = new Set();
    let score = 0;
    rows[i].forEach((cell, col) => {
      const key = normaliseHeader(cell);
      if (!key) return;
      const field = HEADER_LOOKUP.get(key);
      // One spreadsheet column per field: with "Bin 1" and "Bin 2" both
      // mapping through, first match wins and the rest are left unmapped.
      if (field && !seen.has(field)) {
        seen.add(field);
        mapping[field] = col;
        score++;
      }
    });
    if (score > best.score) best = { index: i, score, mapping };
  }

  if (best.index === -1 || best.score < 2) {
    return { headerIndex: -1, headers: [], mapping: {}, unmapped: [], score: best.score };
  }

  const headerRow = rows[best.index];
  const mappedCols = new Set(Object.values(best.mapping));
  const unmapped = headerRow
    .map((c, i) => ({ label: cellText(c), i }))
    .filter((h) => h.label && !mappedCols.has(h.i))
    .map((h) => h.label);

  return {
    headerIndex: best.index,
    headers: headerRow.map(cellText),
    mapping: best.mapping,
    unmapped,
    score: best.score,
  };
}

// --------------------------------------------------------------- row build --
const VALID_CONDITIONS = ['NEW', 'USED', 'REBUILT', 'REFURBISHED'];

function normaliseCondition(raw) {
  const t = cellText(raw).toUpperCase().replace(/[^A-Z]/g, '');
  if (!t) return 'USED';
  if (t.startsWith('NEW')) return 'NEW';
  if (t.startsWith('REB')) return 'REBUILT';
  if (t.startsWith('REF') || t.startsWith('RECON')) return 'REFURBISHED';
  return 'USED';
}

// Turns the grid below the header into product rows, collecting per-row
// problems instead of throwing, so the operator gets one report naming every
// bad line rather than discovering them one failed import at a time.
function buildItems(rows, headerIndex, mapping) {
  const items = [];
  const issues = [];
  const seenKeys = new Map();

  const get = (row, field) => {
    const col = mapping[field];
    return col == null ? '' : cellText(row[col]);
  };

  for (let i = headerIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    if (isBlankRow(row)) continue;
    const lineNo = i + 1; // 1-based, matches what the spreadsheet shows

    const sku = get(row, 'sku');
    const name = get(row, 'name');
    const imgCol = get(row, 'img');

    // Identity is the part number. The storefront keys products on `img`, so
    // a file with no photo column reuses the part number there too -- the same
    // thing the original Stock.csv seed script did, which keeps re-importing
    // the same file an update rather than a pile of duplicates.
    const key = imgCol || sku;
    if (!key) {
      issues.push({ line: lineNo, level: 'skipped', message: 'no part number, SKU or image to identify this row by' });
      continue;
    }
    if (!name && !sku) {
      issues.push({ line: lineNo, level: 'skipped', message: 'no name and no part number' });
      continue;
    }

    if (seenKeys.has(key)) {
      issues.push({
        line: lineNo, level: 'duplicate',
        message: 'part "' + key + '" also appears on line ' + seenKeys.get(key) + ' - the later row wins',
      });
    }
    seenKeys.set(key, lineNo);

    const bin1 = get(row, 'bin_location');
    const bin2 = get(row, 'bin_2');
    const bin = [bin1, bin2].filter(Boolean).join(' / ') || null;

    const price = toMoney(get(row, 'price_usd'));
    const cost = toMoney(get(row, 'cost_usd'));
    // Default 0, not some arbitrary positive number: an import that invents
    // stock the shop does not have will be believed by the POS and sold.
    const stock = toInt(get(row, 'stock_count'), 0);

    if (stock < 0) {
      issues.push({ line: lineNo, level: 'warning', message: 'negative quantity (' + stock + ') treated as 0' });
    }
    if (mapping.price_usd != null && get(row, 'price_usd') && price == null) {
      issues.push({ line: lineNo, level: 'warning', message: 'price "' + get(row, 'price_usd') + '" is not a number - left unpriced' });
    }

    items.push({
      img: key,
      sku: sku || null,
      name: name || sku,
      make_model: get(row, 'make_model') || '',
      category: get(row, 'category') || 'Other',
      condition: normaliseCondition(get(row, 'condition')),
      price_usd: price,
      cost_usd: cost,
      stock_count: Math.max(0, stock),
      low_threshold: toInt(get(row, 'low_threshold'), 0),
      bin_location: bin,
      location: get(row, 'location') || null,
      barcode: get(row, 'barcode') || null,
      line: lineNo,
    });
  }

  return { items, issues };
}

// One call: bytes in, ready-to-upsert rows out.
async function parseInventoryFile(buffer, filename) {
  const { rows, format, detail } = await readTabular(buffer, filename);
  if (!rows.length) {
    const err = new Error('That file has no rows in it.');
    err.userFacing = true;
    throw err;
  }

  const header = detectHeader(rows);
  if (header.headerIndex === -1) {
    const err = new Error(
      'Could not find a header row. The file needs a row naming the columns - ' +
      'at least a part number and a description. Recognised names include: ' +
      'Item, Part No, SKU, Description, Name, Quantity, Qty, Price, Cost, Bin, Category.');
    err.userFacing = true;
    throw err;
  }

  const { items, issues } = buildItems(rows, header.headerIndex, header.mapping);
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
    items,
    issues,
  };
}

// Offered as a download from the admin panel so there is a known-good shape
// to start from.
const TEMPLATE_CSV = [
  'sku,name,make_model,category,condition,price_usd,cost_usd,stock_count,bin,location',
  '18215-TA0-A01,MUFFLER RUBBER (FRT),Honda Accord 2003-2022,Exhaust,NEW,12.50,7.00,9,D-30A,Main Warehouse',
  'BMP-001,Front Bumper Cover,Honda Accord 2018-2022,Body,USED,180,120,3,A-12,Main Warehouse',
  'ALT-889,Alternator 130A,Honda CR-V 2015-2019,Electrical,REBUILT,145,95,2,C-04,Main Warehouse',
].join('\r\n') + '\r\n';

module.exports = {
  parseInventoryFile,
  readTabular,
  detectHeader,
  buildItems,
  normaliseHeader,
  toMoney,
  toInt,
  normaliseCondition,
  sniffDelimiter,
  FIELD_SYNONYMS,
  CANONICAL_FIELDS,
  TEMPLATE_CSV,
};
