// CSV/TSV importer for bulk supplier payments (accounts payable) — logs a
// payment against a specific purchase order and reduces its balance due.
// Unlike the customer side (one running ledger per account, because a
// charge sale has no per-invoice balance), a PO already is the natural unit
// of "what's owed" here, so each row matches exactly one PO by its number.
//
// Row shape (per line): { po_number, amount_usd, method, reference|null,
//   notes|null, date, line }.

import {
  readTabular, detectHeader, cellText, toMoney, isBlankRow,
} from './inventory_import.js';

const FIELD_SYNONYMS = {
  po_number: ['po_number', 'po', 'po_no', 'purchase_order', 'purchase_order_number', 'order_number'],
  amount_usd: ['amount_usd', 'amount', 'payment_amount', 'amt', 'payment'],
  method: ['method', 'payment_method', 'tender', 'type'],
  reference: ['reference', 'ref', 'cheque_no', 'check_no', 'transaction_id', 'txn', 'txn_id'],
  notes: ['notes', 'note', 'memo', 'comment', 'comments'],
  date: ['date', 'payment_date', 'date_paid', 'paid_on', 'received_date', 'payment_received'],
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

const METHODS = ['cash', 'card', 'cheque', 'bank'];
// purchase_order_payments.method is free-form-ish TEXT but an import
// normalises to the same four spellings the rest of the app groups money by,
// rather than adding a fifth ("check", "wire", "eft"...) reports don't know.
function normaliseMethod(raw) {
  const t = cellText(raw).toLowerCase().replace(/[^a-z]/g, '');
  if (!t) return { method: 'bank', guessed: true };
  if (METHODS.includes(t)) return { method: t, guessed: false };
  if (t.startsWith('check')) return { method: 'cheque', guessed: false };
  if (t.startsWith('wire') || t.startsWith('eft') || t.startsWith('transfer') || t.startsWith('ach')) return { method: 'bank', guessed: false };
  if (t.startsWith('credit') || t.startsWith('debit') || t.startsWith('visa') || t.startsWith('master')) return { method: 'card', guessed: false };
  return { method: 'bank', guessed: true };
}

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

    const poNumber = get(row, 'po_number');
    if (!poNumber) {
      issues.push({ line: lineNo, level: 'skipped', message: 'no PO number to match against a purchase order' });
      continue;
    }

    const amountRaw = get(row, 'amount_usd');
    const amount = toMoney(amountRaw);
    if (amount == null || amount <= 0) {
      issues.push({ line: lineNo, level: 'skipped', message: amountRaw ? ('amount "' + amountRaw + '" is not a positive number') : 'no payment amount given' });
      continue;
    }

    const dateRaw = get(row, 'date');
    const date = toDateStr(dateRaw);
    if (date == null) {
      issues.push({ line: lineNo, level: 'skipped', message: dateRaw ? ('date "' + dateRaw + '" was not recognised') : 'no payment date given' });
      continue;
    }

    const methodRaw = get(row, 'method');
    const { method, guessed } = normaliseMethod(methodRaw);
    if (methodRaw && guessed)
      issues.push({ line: lineNo, level: 'warning', message: 'method "' + methodRaw + '" was not recognised - recorded as "bank"' });

    lines.push({
      po_number: poNumber,
      amount_usd: amount,
      method,
      reference: get(row, 'reference') || null,
      notes: get(row, 'notes') || null,
      date,
      line: lineNo,
    });
  }

  return { lines, issues };
}

export function parseSupplierPaymentsFile(buffer, filename) {
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
      'at least a PO number, a payment amount and a date. Recognised names include: ' +
      'PO Number, PO, Amount, Method, Reference, Date.');
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
// to start from. Swap the PO numbers for real ones before uploading — these
// are just placeholders.
export const SUPPLIER_PAYMENTS_TEMPLATE_CSV = [
  'date,po_number,amount_usd,method,reference,notes',
  '2026-08-01,PO-2026-00042,250.00,bank,TXN-88213,',
  '2026-08-10,PO-2026-00051,600.00,cheque,CHQ-1042,',
].join('\r\n') + '\r\n';

export { FIELD_SYNONYMS as SUPPLIER_PAYMENTS_FIELD_SYNONYMS };
