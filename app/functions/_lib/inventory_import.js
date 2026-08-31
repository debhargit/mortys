// Worker-safe port of app/inventory-import.js — the delimited-file half only.
//
// The Express module also reads .xlsx via `exceljs`; that library does not run
// on Workers (Node zlib / streams), so the xlsx branch here throws a
// userFacing error telling the operator to save as CSV. Everything else — the
// header sniffing, column-synonym mapping, per-row validation and the
// ready-to-upsert item shape — is identical to the server, so a file that
// imports on the Node stack imports here.
//
// Item shape (per row): { img, sku, name, make_model, category, condition,
//   price_usd|null, cost_usd|null, stock_count, low_threshold, bin_location,
//   location, barcode, line }.  price/cost are dollars-or-null; the route
// converts to *_cents before it touches D1.

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

function cellText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return String(v).trim();
}

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

function sniffDelimiter(text) {
  const sample = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 10).join('\n');
  const candidates = [',', ';', '\t', '|'];
  let best = ',';
  let bestCount = -1;
  for (const d of candidates) {
    let count = 0;
    let inQ = false;
    for (let i = 0; i < sample.length; i++) {
      const ch = sample[i];
      if (ch === '"') inQ = !inQ;
      else if (!inQ && ch === d) count++;
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
    const ch = text[i];
    if (inQ) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === delim) {
      row.push(cur); cur = '';
    } else if (ch === '\n') {
      row.push(cur); out.push(row); row = []; cur = '';
    } else if (ch !== '\r') {
      cur += ch;
    }
  }
  if (cur.length || row.length) { row.push(cur); out.push(row); }
  return out;
}

function isBlankRow(row) {
  return !row || row.every((c) => cellText(c) === '');
}

// Bytes -> grid of strings. xlsx is refused (no exceljs on Workers).
function readTabular(buffer, filename) {
  const ext = String(filename || '').toLowerCase().match(/\.[a-z0-9]+$/);
  const kind = ext ? ext[0] : '';
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);

  if (kind === '.xls') {
    const err = new Error(
      'That is the old Excel .xls format, which cannot be read here. ' +
      'Open it in Excel and use File -> Save As to save it as .csv, then import that.');
    err.userFacing = true;
    throw err;
  }
  const looksZip = bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4B;
  if (kind === '.xlsx' || kind === '.xlsm' || looksZip) {
    const err = new Error(
      'Spreadsheet (.xlsx) import is not available on this server. ' +
      'Open it in Excel or Google Sheets and save it as .csv, then import that.');
    err.userFacing = true;
    throw err;
  }

  let text = new TextDecoder('utf-8').decode(bytes);
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const delim = sniffDelimiter(text);
  const rows = parseDelimited(text, delim);
  const delimName = delim === '\t' ? 'tab' : delim;
  return { rows, format: 'csv', detail: 'separator "' + delimName + '"' };
}

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

function normaliseCondition(raw) {
  const t = cellText(raw).toUpperCase().replace(/[^A-Z]/g, '');
  if (!t) return 'USED';
  if (t.startsWith('NEW')) return 'NEW';
  if (t.startsWith('REB')) return 'REBUILT';
  if (t.startsWith('REF') || t.startsWith('RECON')) return 'REFURBISHED';
  return 'USED';
}

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
    const lineNo = i + 1;

    const sku = get(row, 'sku');
    const name = get(row, 'name');
    const imgCol = get(row, 'img');

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

export function parseInventoryFile(buffer, filename) {
  const { rows, format, detail } = readTabular(buffer, filename);
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

export const TEMPLATE_CSV = [
  'sku,name,make_model,category,condition,price_usd,cost_usd,stock_count,bin,location',
  '18215-TA0-A01,MUFFLER RUBBER (FRT),Honda Accord 2003-2022,Exhaust,NEW,12.50,7.00,9,D-30A,Main Warehouse',
  'BMP-001,Front Bumper Cover,Honda Accord 2018-2022,Body,USED,180,120,3,A-12,Main Warehouse',
  'ALT-889,Alternator 130A,Honda CR-V 2015-2019,Electrical,REBUILT,145,95,2,C-04,Main Warehouse',
].join('\r\n') + '\r\n';

export { FIELD_SYNONYMS, normaliseCondition, toMoney, toInt };
