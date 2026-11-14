// Split oversized pg2d1 output files so `wrangler d1 execute --file` accepts them.
//
//   node app/tools/split-d1-sql.mjs --dir dist/d1-2026 [--max-mb 4]
//   node app/tools/split-d1-sql.mjs --selftest
//
// Why. D1's remote import rejects a large file with `{"D1_RESET_DO":true}` --
// the Durable Object backing the import resets rather than returning a size
// error, so the failure says nothing about the cause. Observed: a 9.9 MB
// products file imported fine on 2026-09-08, a 10.5 MB one failed on
// 2026-10-04. The export's own 16.5 MB pos_sales file is well past it.
//
// Splitting is safe because of how pg2d1 writes a table: one leading
// `DELETE FROM "<table>";` followed by `INSERT OR REPLACE` batches. The DELETE
// stays in part 1 alone, so the wholesale-replace semantics survive, and the
// INSERTs are OR REPLACE and keyed by id, so re-applying any part is a no-op
// rather than a duplicate. Each part is its own D1 transaction; a failed part
// rolls back on its own and can be retried.
//
// Statement boundaries are found by scanning for a `;` that sits outside a SQL
// string literal, so a semicolon inside a part description ("HOSE 1/2; BLACK")
// never splits a statement.

import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const SELFTEST = argv.includes('--selftest');

// Split SQL text into statements, respecting '...' literals ('' escapes a quote).
export function splitStatements(sql) {
  const out = [];
  let start = 0, inStr = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (inStr) {
      if (c === "'") {
        if (sql[i + 1] === "'") i++;               // '' -> literal quote
        else inStr = false;
      }
    } else if (c === "'") inStr = true;
    else if (c === ';') {
      const s = sql.slice(start, i + 1).trim();
      if (s) out.push(s);
      start = i + 1;
    }
  }
  const tail = sql.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

// Group statements into chunks no bigger than maxBytes (a single statement
// larger than that still gets its own chunk -- it cannot be divided here).
export function chunk(statements, maxBytes) {
  const parts = [];
  let cur = [], size = 0;
  for (const s of statements) {
    const n = Buffer.byteLength(s) + 1;
    if (cur.length && size + n > maxBytes) { parts.push(cur); cur = []; size = 0; }
    cur.push(s); size += n;
  }
  if (cur.length) parts.push(cur);
  return parts;
}

if (SELFTEST) {
  const A = (l, ok) => console.log((ok ? 'PASS  ' : 'FAIL  ') + l);
  A('splits two plain statements', splitStatements('DELETE FROM "t";\nINSERT INTO t VALUES(1);').length === 2);
  A('keeps a semicolon inside a literal',
    splitStatements(`INSERT INTO t VALUES('HOSE 1/2; BLACK');`).length === 1);
  A('handles an escaped quote then a semicolon',
    splitStatements(`INSERT INTO t VALUES('O''BRIEN; CO');INSERT INTO t VALUES(2);`).length === 2);
  A('drops trailing whitespace-only tail', splitStatements('SELECT 1;\n\n  \n').length === 1);
  A('keeps an unterminated final statement', splitStatements('SELECT 1;\nSELECT 2').length === 2);
  const st = ['a;', 'b;', 'c;'];
  A('chunks by size', chunk(st, 5).length === 3 && chunk(st, 100).length === 1);
  A('an oversized single statement still yields one chunk',
    chunk(['x'.repeat(50) + ';'], 10).length === 1);
  A('no statement is lost when chunking',
    chunk(st, 5).flat().join('') === st.join(''));
  process.exit(0);
}

const DIR = path.resolve(opt('dir', 'dist/d1-2026'));
const MAX = Math.round(parseFloat(opt('max-mb', '4')) * 1048576);
if (!fs.existsSync(DIR)) { console.error(`no such directory: ${DIR}`); process.exit(1); }

const files = fs.readdirSync(DIR).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
if (!files.length) { console.error(`no NN_table.sql files in ${DIR}`); process.exit(1); }

const emitted = [];
let splitCount = 0;

for (const f of files) {
  const full = path.join(DIR, f);
  const bytes = fs.statSync(full).size;
  if (bytes <= MAX) { emitted.push(f); continue; }

  const sql = fs.readFileSync(full, 'utf8');
  const parts = chunk(splitStatements(sql), MAX);
  const stem = f.replace(/\.sql$/, '');
  parts.forEach((stmts, i) => {
    const name = `${stem}.${String(i + 1).padStart(3, '0')}.sql`;
    fs.writeFileSync(path.join(DIR, name),
      `-- ${stem} part ${i + 1}/${parts.length} (split from ${f} at <=${(MAX / 1048576).toFixed(1)} MB)\n`
      + stmts.join('\n') + '\n');
    emitted.push(name);
  });
  fs.rmSync(full);                                  // the whole-table file is replaced by its parts
  splitCount++;
  console.log(`${f.padEnd(34)} ${(bytes / 1048576).toFixed(1)} MB -> ${parts.length} part(s)`);
}

// Rewrite the runners so they list exactly what is on disk, in order.
const ordered = emitted.sort();
const sh = ['#!/usr/bin/env bash', 'set -euo pipefail',
  'DB=${1:-mortysautoparts-db}', 'FLAGS=${2:---remote}', '',
  ...ordered.map((f) => `npx wrangler d1 execute "$DB" $FLAGS --file "$(dirname "$0")/${f}"`), ''].join('\n');
fs.writeFileSync(path.join(DIR, '_import.sh'), sh);
const ps = ['param([string]$Db = "mortysautoparts-db", [string]$Flags = "--remote")',
  '$ErrorActionPreference = "Stop"',
  ...ordered.map((f) => `npx wrangler d1 execute $Db $Flags.Split(" ") --file "$PSScriptRoot/${f}"`), ''].join('\n');
fs.writeFileSync(path.join(DIR, '_import.ps1'), ps);

const biggest = ordered.reduce((m, f) => Math.max(m, fs.statSync(path.join(DIR, f)).size), 0);
console.log(`\nsplit ${splitCount} file(s); ${ordered.length} file(s) now listed in _import.sh`);
console.log(`largest file is now ${(biggest / 1048576).toFixed(1)} MB (cap ${(MAX / 1048576).toFixed(1)} MB)`);
