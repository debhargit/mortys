// Streaming RFC4180-ish CSV reader for the large legacy exports.
//
//   for await (const rec of readCsv('INVOICE.csv')) { rec.INV_NUMBER ... }
//
// Handles quoted fields (incl. embedded commas/newlines), "" escaping, CRLF,
// a leading UTF-8 BOM, and ragged rows (missing trailing fields -> '').
// Yields plain objects keyed by the UPPERCASED header names.
//
// The legacy files are up to 170 MB, so nothing is ever fully buffered.

import fs from 'node:fs';

// Split a chunk of CSV text into complete rows, returning any trailing
// partial row so the caller can prepend it to the next chunk. Quote state
// has to survive chunk boundaries, hence it is passed in/out.
function* rowsFrom(text, state) {
  let { row, cur, q } = state;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; }
        else if (i === text.length - 1) { q = false; state.pendQuote = true; }
        else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); yield row; row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  state.row = row; state.cur = cur; state.q = q;
}

export async function* readCsv(file, { encoding = 'utf8' } = {}) {
  const stream = fs.createReadStream(file, { encoding, highWaterMark: 1 << 22 });
  const state = { row: [], cur: '', q: false };
  let header = null;
  let first = true;

  for await (let chunk of stream) {
    if (first) { chunk = chunk.replace(/^﻿/, ''); first = false; }
    for (const row of rowsFrom(chunk, state)) {
      if (!header) { header = row.map((h) => h.trim().toUpperCase()); continue; }
      yield toObj(header, row);
    }
  }
  // flush a final row with no trailing newline
  if (state.cur.length || state.row.length) {
    state.row.push(state.cur);
    if (header) yield toObj(header, state.row);
  }
}

function toObj(header, row) {
  const o = {};
  for (let i = 0; i < header.length; i++) o[header[i]] = row[i] === undefined ? '' : row[i];
  return o;
}

// ---- shared field coercion ------------------------------------------------
export const clean = (v) => String(v == null ? '' : v).trim();

export function num(v) {
  const n = parseFloat(String(v == null ? '' : v).replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : null;
}

export const num0 = (v) => num(v) ?? 0;

// Legacy dates are M/D/YYYY, sometimes '/  /' or '  /  /    ' for empty, and
// occasionally carry a typo'd year (4201, 6202). Anything outside a sane
// window is rejected so it lands in the loader's reject bucket instead of
// poisoning a date column.
export function mdy(v, { minYear = 1990, maxYear = 2100 } = {}) {
  const s = clean(v);
  const m = /^(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{2,4})$/.exec(s);
  if (!m) return null;
  let [, mo, d, y] = m;
  mo = +mo; d = +d; y = +y;
  if (y < 100) y += y < 70 ? 2000 : 1900;
  if (y < minYear || y > maxYear) return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

// 'HH:MM:SS' / 'HH:MM:' / '1337' -> 'HH:MM:SS' or null
export function hms(v) {
  const s = clean(v);
  let m = /^(\d{1,2}):(\d{2}):?(\d{2})?$/.exec(s);
  if (m) return pad(m[1]) + ':' + m[2] + ':' + (m[3] || '00');
  m = /^(\d{3,4})$/.exec(s);
  if (m) {
    const t = m[1].padStart(4, '0');
    const h = +t.slice(0, 2), mi = +t.slice(2);
    if (h < 24 && mi < 60) return pad(h) + ':' + pad(mi) + ':00';
  }
  return null;
}
const pad = (n) => String(n).padStart(2, '0');

// date + time -> ISO timestamp string for Postgres
export function stamp(dateStr, timeStr) {
  if (!dateStr) return null;
  return dateStr + ' ' + (hms(timeStr) || '00:00:00');
}
