// ============================================================================
//  invoice-payments-import.js — turn a CSV / spreadsheet into account-payment
//  rows (bulk "Record a payment" against a trade/charge customer's balance)
//
//  Pure parsing and mapping only, same split as inventory-import.js and the
//  other importers: server.js owns the routes and the SQL, this file owns
//  turning an uploaded file into rows. Reuses inventory-import.js's tabular
//  plumbing (delimiter sniffing, header scoring, xlsx reading, cell coercion).
//
//  This system tracks a charge customer's balance as one running ledger per
//  account (every 'account'-tender sale minus every account_payments row) —
//  there is no separate per-invoice balance to pay down. A "reference" column
//  (invoice #, cheque #, transaction id — whatever the file calls it) is kept
//  on the row for the customer's paper trail, but it settles the account as a
//  whole, same as it would typed in by hand.
// ============================================================================

'use strict';

const {
  readTabular, detectHeader, cellText, isBlankRow, toMoney,
} = require('./inventory-import');

const FIELD_SYNONYMS = {
  account_number: ['account_number', 'account', 'acct', 'acct_no', 'customer_number', 'account_no'],
  email: ['email', 'customer_email', 'e_mail'],
  amount_usd: ['amount_usd', 'amount', 'payment_amount', 'amt', 'payment'],
  method: ['method', 'payment_method', 'tender', 'type'],
  reference: ['reference', 'ref', 'invoice', 'invoice_number', 'receipt', 'receipt_number',
              'cheque_no', 'check_no', 'transaction_id', 'txn', 'txn_id'],
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
// account_payments.method is free-form-ish in practice but the manual
// "Record a payment" form only ever writes one of these four, so an import
// normalises to the same set rather than introducing a fifth spelling
// ("check", "wire", "eft"...) the reports don't know how to group.
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

    const accountNumber = get(row, 'account_number') || null;
    const email = get(row, 'email') || null;
    if (!accountNumber && !email) {
      issues.push({ line: lineNo, level: 'skipped', message: 'no account number or email to identify the customer by' });
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
      account_number: accountNumber,
      email,
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

// One call: bytes in, ready-to-match payment lines out.
async function parseInvoicePaymentsFile(buffer, filename) {
  const { rows, format, detail } = await readTabular(buffer, filename);
  if (!rows.length) {
    const err = new Error('That file has no rows in it.');
    err.userFacing = true;
    throw err;
  }

  const header = detectHeader(rows, 25, HEADER_LOOKUP);
  if (header.headerIndex === -1) {
    const err = new Error(
      'Could not find a header row. The file needs a row naming the columns - ' +
      'at least a customer (account number or email), a payment amount and a date. ' +
      'Recognised names include: Account Number, Email, Amount, Method, Reference, Date.');
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
// to start from. Each row identifies the customer by account number OR
// email — a file only needs to carry whichever one it already has.
const INVOICE_PAYMENTS_TEMPLATE_CSV = [
  'date,account_number,email,amount_usd,method,reference,notes',
  '2026-08-01,C-000123,,150.00,cash,,',
  '2026-08-10,,jane@example.com,75.50,bank,TXN-88213,',
  '2026-08-15,C-000456,,200,cheque,CHQ-1042,',
].join('\r\n') + '\r\n';

module.exports = {
  parseInvoicePaymentsFile,
  FIELD_SYNONYMS,
  CANONICAL_FIELDS,
  INVOICE_PAYMENTS_TEMPLATE_CSV,
};
