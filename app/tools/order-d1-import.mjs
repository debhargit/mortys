// Reorder a pg2d1 export so parents load before the children that reference
// them, and rewrite _import.sh / _import.ps1 in that order.
//
//   node app/tools/order-d1-import.mjs --dir dist/d1-2026 [--check]
//   node app/tools/order-d1-import.mjs --selftest
//
// Why. pg2d1 numbers its output in the order the D1 migrations happen to
// define the tables, which is NOT foreign-key order: `products` is file 02 but
// its supplier_id references `suppliers`, file 22. D1 enforces foreign keys
// during `wrangler d1 execute --file` -- each file is its own transaction, so
// deferring inside a file cannot help -- and 33,850 of 36,519 products carry a
// supplier_id, so file 02 fails before file 22 ever runs.
//
// The failure is easy to misread. A small offending file returns the real
// `FOREIGN KEY constraint failed`, but a multi-megabyte one dies as an opaque
// `{"D1_RESET_DO":true}` instead, which looks like a size limit and sends you
// off splitting files that were never too big.
//
// This reads the FK graph out of migrations/*.sql, topologically sorts the
// tables that the export actually contains, and rewrites the runner scripts.
// File names are untouched, so `--check` can report the inversions without
// changing anything. Multi-part files (NN_table.001.sql) stay in part order
// within their table. A parent absent from the export imposes no constraint.
// A true cycle (users <-> mechanics) cannot be ordered at all; the sort breaks
// it and prints the edge it had to ignore, which is only safe because the
// referencing column is NULL throughout the data.

import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const SELFTEST = argv.includes('--selftest');
const CHECK = argv.includes('--check');

// table -> Set(referenced tables), from CREATE TABLE bodies and ALTER ... ADD COLUMN.
export function parseFks(sqlByFile) {
  const deps = new Map();
  const add = (t, ref) => {
    if (!t || !ref || t === ref) return;            // self-reference needs no ordering
    if (!deps.has(t)) deps.set(t, new Set());
    deps.get(t).add(ref);
  };
  for (const sql of sqlByFile) {
    const clean = sql.replace(/--[^\n]*/g, '');
    const createRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?\s*\(/gi;
    let m;
    while ((m = createRe.exec(clean))) {
      let depth = 1, i = createRe.lastIndex;
      for (; i < clean.length && depth; i++) {
        if (clean[i] === '(') depth++;
        else if (clean[i] === ')') depth--;
      }
      const body = clean.slice(createRe.lastIndex, i - 1);
      const refRe = /REFERENCES\s+["`]?(\w+)["`]?/gi;
      let r;
      while ((r = refRe.exec(body))) add(m[1], r[1]);
    }
    const alterRe = /ALTER\s+TABLE\s+["`]?(\w+)["`]?\s+ADD\s+COLUMN\s+[^;]*?REFERENCES\s+["`]?(\w+)["`]?/gi;
    while ((m = alterRe.exec(clean))) add(m[1], m[2]);
  }
  return deps;
}

// Kahn's algorithm, stable: among ready nodes keep the caller's original order.
//
// The schema contains at least one real cycle (users references mechanics and
// mechanics references users), so a sort that refuses to proceed on a cycle
// would leave most of the export unordered and fix nothing. Instead, when no
// node is ready but nodes remain, the earliest one in the caller's order is
// released and the edges that were still holding it back are reported as
// `broken`. Such an edge can only load cleanly if the referencing column is
// NULL in the data -- which is the case for the cycles here -- so the caller
// prints them and the operator can confirm.
//
// Returns { order, broken } with order covering every node.
export function toposort(nodes, deps) {
  const present = new Set(nodes);
  const unmet = new Map(nodes.map((n) => [n, new Set()]));
  const children = new Map(nodes.map((n) => [n, []]));
  for (const n of nodes) {
    for (const parent of deps.get(n) || []) {
      if (!present.has(parent)) continue;           // parent not in this export
      unmet.get(n).add(parent);
      children.get(parent).push(n);
    }
  }
  const order = [];
  const broken = [];
  const left = [...nodes];
  const release = (n) => {
    order.push(n);
    left.splice(left.indexOf(n), 1);
    for (const c of children.get(n)) unmet.get(c).delete(n);
  };
  while (left.length) {
    const ready = left.find((n) => unmet.get(n).size === 0);
    if (ready !== undefined) { release(ready); continue; }
    // Cycle: force the earliest remaining node and record what it still wants.
    const forced = left[0];
    for (const parent of unmet.get(forced)) broken.push([forced, parent]);
    unmet.get(forced).clear();
    release(forced);
  }
  return { order, broken };
}

if (SELFTEST) {
  const A = (l, ok) => console.log((ok ? 'PASS  ' : 'FAIL  ') + l);
  const d = parseFks([`CREATE TABLE products (
      img TEXT PRIMARY KEY,
      supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL
    );
    ALTER TABLE pos_sales ADD COLUMN sales_rep_id INTEGER REFERENCES mechanics(id);`]);
  A('finds an inline REFERENCES', d.get('products')?.has('suppliers') === true);
  A('finds an ALTER ADD COLUMN REFERENCES', d.get('pos_sales')?.has('mechanics') === true);
  const d2 = parseFks(['CREATE TABLE t (id INTEGER PRIMARY KEY, p INTEGER REFERENCES t(id));']);
  A('ignores a self-reference', !d2.has('t'));
  const d3 = parseFks(['-- REFERENCES suppliers(id)\nCREATE TABLE x (id INTEGER);']);
  A('ignores a commented-out reference', !d3.has('x'));

  const deps = new Map([['products', new Set(['suppliers'])]]);
  const { order, broken } = toposort(["products", "suppliers"], deps);
  A('parent sorts before child', order.indexOf('suppliers') < order.indexOf('products'));
  A('nothing broken', broken.length === 0);
  const stable = toposort(['a', 'b', 'c'], new Map());
  A('independent tables keep their original order', stable.order.join(',') === 'a,b,c');
  const cyc = toposort(['x', 'y'], new Map([['x', new Set(['y'])], ['y', new Set(['x'])]]));
  A('a cycle is broken, reported, and still fully ordered', cyc.broken.length === 1 && cyc.order.length === 2);
  A('a missing parent does not block the child',
    toposort(['products'], new Map([['products', new Set(['suppliers'])]])).order.length === 1);
  process.exit(0);
}

const DIR = path.resolve(opt('dir', 'dist/d1-2026'));
const MIG = path.resolve(path.dirname(DIR), '..', 'migrations');
const migDir = fs.existsSync(MIG) ? MIG : path.resolve('migrations');
const deps = parseFks(fs.readdirSync(migDir).filter((f) => /\.sql$/.test(f)).sort()
  .map((f) => fs.readFileSync(path.join(migDir, f), 'utf8')));

// Group the export's files by table, preserving numeric then part order.
const files = fs.readdirSync(DIR).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
const tables = [];
const byTable = new Map();
for (const f of files) {
  const t = f.replace(/^\d+_/, '').replace(/(\.\d+)?\.sql$/, '');
  if (!byTable.has(t)) { byTable.set(t, []); tables.push(t); }
  byTable.get(t).push(f);
}

const { order, broken } = toposort(tables, deps);
const final = order;

// Report every place a child currently precedes a parent.
const inversions = [];
for (const t of tables) {
  for (const parent of deps.get(t) || []) {
    if (!byTable.has(parent)) continue;
    if (tables.indexOf(parent) > tables.indexOf(t)) inversions.push([t, parent]);
  }
}
if (inversions.length) {
  console.log('foreign-key inversions in the generated order (child loads before parent):');
  for (const [child, parent] of inversions) {
    console.log(`  ${byTable.get(child)[0].padEnd(30)} references ${parent}`
      + `  (${byTable.get(parent)[0]})`);
  }
} else {
  console.log('no foreign-key inversions: the generated order already loads parents first.');
}
if (broken.length) {
  console.log('\nFK edges the order cannot satisfy (a cycle) -- these load only because the'
    + ' referencing column is NULL in the data:');
  for (const [child, parent] of broken) console.log(`  ${child} -> ${parent}`);
}

if (CHECK) process.exit(inversions.length ? 1 : 0);

const ordered = final.flatMap((t) => byTable.get(t));
const sh = ['#!/usr/bin/env bash', 'set -euo pipefail',
  'DB=${1:-visionautosolutions-db}', 'FLAGS=${2:---remote}', '',
  '# Foreign-key dependency order (see app/tools/order-d1-import.mjs), not file-number order.',
  ...ordered.map((f) => `npx wrangler d1 execute "$DB" $FLAGS --file "$(dirname "$0")/${f}"`), ''].join('\n');
fs.writeFileSync(path.join(DIR, '_import.sh'), sh);
const ps = ['param([string]$Db = "visionautosolutions-db", [string]$Flags = "--remote")',
  '$ErrorActionPreference = "Stop"',
  ...ordered.map((f) => `npx wrangler d1 execute $Db $Flags.Split(" ") --file "$PSScriptRoot/${f}"`), ''].join('\n');
fs.writeFileSync(path.join(DIR, '_import.ps1'), ps);

console.log(`\nrewrote _import.sh / _import.ps1 with ${ordered.length} file(s) in dependency order`);
console.log(`first five tables: ${final.slice(0, 5).join(', ')}`);
