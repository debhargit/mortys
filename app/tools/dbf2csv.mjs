// Export a legacy FoxPro .DBF table to CSV, optionally one year at a time.
//
//   node app/tools/dbf2csv.mjs WORK/INVDETAI.DBF --year 2026 --out INVDETAI-2026.csv
//   node app/tools/dbf2csv.mjs WORK/INVDETAI.DBF --out INVDETAI-full.csv
//   node app/tools/dbf2csv.mjs --selftest
//
// Why this exists. The INVDETAI.csv at the repo root -- the hand-made export
// the stage/load pipeline was built on -- holds exactly 1,048,575 data rows,
// which is Excel's hard sheet limit (2^20 - 1). The real table has 1,412,936
// records, so whoever produced that CSV through Excel silently lost the last
// 364,351 rows: the file stops mid-invoice on 2022-09-05 and every line item
// from 2023 onward is simply absent. The header sales (INVOICE.csv, 931,079
// rows) fit under the ceiling and came across whole, which is why the database
// shows 2023-2026 sales with no lines hanging off them.
//
// Reading the .DBF directly removes Excel from the path. The output is the
// shape stage-legacy.mjs already parses, so nothing downstream changes --
// `--year` just keeps a single year's file small enough to stage and verify
// on its own.
//
// Field spellings. The DBF and the legacy CSVs disagree on two column names,
// and stage-legacy.mjs keys off the CSV spellings, so they are renamed on the
// way out (see RENAME). Everything else is carried across verbatim: character
// fields trimmed, numerics left exactly as stored, and D (date) fields turned
// from the DBF's YYYYMMDD into the M/D/YYYY that legacy_date()/mdy() expect.
// No value is coerced or validated here -- that stays the loaders' job.

import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const SELFTEST = argv.includes('--selftest');

// DBF column name -> the spelling the legacy CSVs (and stage-legacy.mjs) use.
const RENAME = { DESC: 'PART NAME', CL_NAME: 'CUSTOMER' };

// 'YYYYMMDD' -> 'M/D/YYYY'. Blank/garbage becomes '' rather than a bad date;
// the loaders already treat an unparseable date as missing.
export function dbfDate(raw) {
  const s = String(raw).trim();
  if (!/^\d{8}$/.test(s)) return '';
  const y = +s.slice(0, 4), m = +s.slice(4, 6), d = +s.slice(6, 8);
  if (!y || m < 1 || m > 12 || d < 1 || d > 31) return '';
  return `${m}/${d}/${y}`;
}

// RFC4180: quote only when the value contains a delimiter, quote or newline.
export function csvCell(v) {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function parseHeader(fd) {
  const hb = Buffer.alloc(32);
  fs.readSync(fd, hb, 0, 32, 0);
  const records = hb.readUInt32LE(4);
  const headerLen = hb.readUInt16LE(8);
  const recordLen = hb.readUInt16LE(10);
  const fb = Buffer.alloc(headerLen - 32);
  fs.readSync(fd, fb, 0, fb.length, 32);

  const fields = [];
  let off = 1;                                  // byte 0 of a record is the delete flag
  for (let i = 0; i + 32 <= fb.length; i += 32) {
    if (fb[i] === 0x0d) break;                  // field descriptor terminator
    const name = fb.slice(i, i + 11).toString('latin1').replace(/\0.*$/, '').trim();
    fields.push({ name, type: String.fromCharCode(fb[i + 11]), len: fb[i + 16], off });
    off += fb[i + 16];
  }
  if (off !== recordLen) {
    throw new Error(`field widths sum to ${off} but the header declares a ${recordLen}-byte record`);
  }
  return { records, headerLen, recordLen, fields };
}

if (SELFTEST) {
  const A = (l, ok) => console.log((ok ? 'PASS  ' : 'FAIL  ') + l);
  A("dbfDate('20260115') -> 1/15/2026", dbfDate('20260115') === '1/15/2026');
  A("dbfDate('20260905') -> 9/5/2026", dbfDate('20260905') === '9/5/2026');
  A("dbfDate blank -> ''", dbfDate('        ') === '' && dbfDate('') === '');
  A("dbfDate garbage -> ''", dbfDate('0000000') === '' && dbfDate('2026ab01') === '');
  A("dbfDate rejects month 13", dbfDate('20261301') === '');
  A('csvCell passes a plain value', csvCell('ENGINE OIL') === 'ENGINE OIL');
  A('csvCell quotes a comma', csvCell('BRAKE PAD, FRONT') === '"BRAKE PAD, FRONT"');
  A('csvCell doubles a quote', csvCell('HOSE 1"') === '"HOSE 1"""');
  A("csvCell null -> ''", csvCell(null) === '' && csvCell(undefined) === '');
  A('csvCell keeps <> and / untouched', csvCell('OIL<10W/30>QUART') === 'OIL<10W/30>QUART');
  process.exit(0);
}

const SRC = argv.find((a) => !a.startsWith('--') && /\.dbf$/i.test(a));
if (!SRC) {
  console.error('usage: node app/tools/dbf2csv.mjs <table.DBF> [--year YYYY] [--out file.csv]');
  process.exit(1);
}
const YEAR = opt('year', '');
const OUT = path.resolve(opt('out', SRC.replace(/\.dbf$/i, '') + (YEAR ? `-${YEAR}` : '') + '.csv'));

const fd = fs.openSync(SRC, 'r');
const { records, headerLen, recordLen, fields } = parseHeader(fd);
const dateCols = fields.filter((f) => f.type === 'D').map((f) => f.name);
console.log(`${SRC}: ${records.toLocaleString('en-US')} records, ${fields.length} fields, ${recordLen}B each`);
console.log(`date fields: ${dateCols.join(', ') || '(none)'}`);
if (YEAR) console.log(`filtering on DDATE year = ${YEAR}`);

const ddate = fields.find((f) => f.name === 'DDATE');
if (YEAR && !ddate) { console.error('--year needs a DDATE field; this table has none'); process.exit(1); }

const out = fs.createWriteStream(OUT, { encoding: 'utf8' });
const write = (s) => out.write(s) || new Promise((r) => out.once('drain', r));
await write(fields.map((f) => csvCell(RENAME[f.name] || f.name)).join(',') + '\n');

const CH = 4096;                                 // records per read
const buf = Buffer.alloc(recordLen * CH);
let kept = 0, skippedYear = 0, deleted = 0, nonAscii = 0;
const t0 = Date.now();

for (let i = 0; i < records; i += CH) {
  const n = Math.min(CH, records - i);
  fs.readSync(fd, buf, 0, recordLen * n, headerLen + i * recordLen);
  const lines = [];
  for (let r = 0; r < n; r++) {
    const base = r * recordLen;
    if (buf[base] === 0x2a) { deleted++; continue; }         // '*' = deleted
    if (YEAR) {
      const y = buf.slice(base + ddate.off, base + ddate.off + 4).toString('latin1');
      if (y !== YEAR) { skippedYear++; continue; }
    }
    const cells = fields.map((f) => {
      const slice = buf.slice(base + f.off, base + f.off + f.len);
      for (const b of slice) if (b > 0x7f) { nonAscii++; break; }
      const raw = slice.toString('latin1');
      return csvCell(f.type === 'D' ? dbfDate(raw) : raw.trim());
    });
    lines.push(cells.join(','));
    kept++;
  }
  if (lines.length) await write(lines.join('\n') + '\n');
}

await new Promise((r) => out.end(r));
fs.closeSync(fd);

const secs = (Date.now() - t0) / 1000;
console.log(`\nwrote ${kept.toLocaleString('en-US')} rows to ${path.relative(process.cwd(), OUT)}`
  + ` in ${secs.toFixed(1)}s  (${(fs.statSync(OUT).size / 1048576).toFixed(1)} MB)`);
if (skippedYear) console.log(`skipped ${skippedYear.toLocaleString('en-US')} row(s) outside ${YEAR}`);
if (deleted) console.log(`skipped ${deleted.toLocaleString('en-US')} record(s) flagged deleted`);
if (nonAscii) console.log(`note: ${nonAscii} field(s) held a non-ASCII byte, decoded as latin1 -> UTF-8`);
