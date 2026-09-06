// Phase 9 - one-shot data export: live PostgreSQL  ->  D1 (SQLite) seed files.
//
//   node tools/pg2d1.mjs --url "$DATABASE_URL" --out dist/d1-data
//   node tools/pg2d1.mjs --selftest      # parser + transforms, no DB needed
//
// For every table the D1 migrations define, it reads the matching Postgres
// table, applies the same dialect conversions the route port uses
// (money *_usd -> *_cents, boolean -> 0/1, json/jsonb -> TEXT, timestamps ->
// ISO strings) and writes numbered `INSERT OR REPLACE` files plus an ordered
// import script. Postgres-only columns (generated `search_text`, the `*_id`
// FK columns D1 dropped in favour of `product_img`, etc.) are left out.
//
// Apply after `wrangler d1 migrations apply`:
//   bash dist/d1-data/_import.sh          (or _import.ps1 on Windows)

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const MIG = path.join(APP, 'migrations');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const SELFTEST = args.includes('--selftest');
const PG_URL = opt('--url', process.env.DATABASE_URL);
const OUT = path.resolve(APP, opt('--out', 'dist/d1-data'));
const ROW_LIMIT = parseInt(opt('--limit', '0'), 10) || 0;
const BATCH = 100;

// Tables that live only in D1 (config/logs/seeds) or only make sense fresh.
const SKIP = new Set(['d1_migrations', 'sqlite_sequence', 'app_config', 'job_runs']);

// ---------------------------------------------------------------- D1 schema
// Parse migrations/*.sql into { table -> { order, cols:Set } }, following
// CREATE TABLE, ALTER TABLE ADD/DROP/RENAME COLUMN and DROP TABLE.
function parseD1Schema() {
  const tables = new Map();
  let seq = 0;
  const ensure = (t) => {
    if (!tables.has(t)) tables.set(t, { order: seq++, cols: new Set() });
    return tables.get(t);
  };
  const files = fs.readdirSync(MIG).filter((f) => /^\d+.*\.sql$/.test(f)).sort();
  for (const f of files) {
    const sql = fs.readFileSync(path.join(MIG, f), 'utf8').replace(/--[^\n]*/g, '');
    // Collect every DDL event with its offset, then apply in textual order so
    // a DROP+CREATE of the same table in one file resolves correctly.
    const events = [];
    let m;

    const createRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?\s*\(/gi;
    while ((m = createRe.exec(sql))) {
      let depth = 1, i = createRe.lastIndex;
      for (; i < sql.length && depth; i++) {
        if (sql[i] === '(') depth++;
        else if (sql[i] === ')') depth--;
      }
      events.push({ at: m.index, kind: 'create', t: m[1], body: sql.slice(createRe.lastIndex, i - 1) });
    }
    const addRe = /ALTER\s+TABLE\s+["`]?(\w+)["`]?\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?/gi;
    while ((m = addRe.exec(sql))) events.push({ at: m.index, kind: 'add', t: m[1], c: m[2] });
    const dropColRe = /ALTER\s+TABLE\s+["`]?(\w+)["`]?\s+DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?["`]?(\w+)["`]?/gi;
    while ((m = dropColRe.exec(sql))) events.push({ at: m.index, kind: 'dropcol', t: m[1], c: m[2] });
    const renRe = /ALTER\s+TABLE\s+["`]?(\w+)["`]?\s+RENAME\s+COLUMN\s+["`]?(\w+)["`]?\s+TO\s+["`]?(\w+)["`]?/gi;
    while ((m = renRe.exec(sql))) events.push({ at: m.index, kind: 'rename', t: m[1], from: m[2], to: m[3] });
    const dropTblRe = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["`]?(\w+)["`]?/gi;
    while ((m = dropTblRe.exec(sql))) events.push({ at: m.index, kind: 'droptbl', t: m[1] });

    events.sort((a, b) => a.at - b.at);
    for (const e of events) {
      if (e.kind === 'create') {
        const rec = ensure(e.t);
        rec.cols = new Set();
        for (const raw of splitTopLevel(e.body)) {
          const item = raw.trim();
          if (!item || /^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i.test(item)) continue;
          const col = (item.match(/^["`]?(\w+)["`]?/) || [])[1];
          if (col) rec.cols.add(col);
        }
      } else if (e.kind === 'add') ensure(e.t).cols.add(e.c);
      else if (e.kind === 'dropcol') ensure(e.t).cols.delete(e.c);
      else if (e.kind === 'rename') { const r = ensure(e.t); if (r.cols.delete(e.from)) r.cols.add(e.to); }
      else if (e.kind === 'droptbl') tables.delete(e.t);
    }
  }
  return tables;
}

function splitTopLevel(s) {
  const out = []; let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') { depth++; cur += ch; }
    else if (ch === ')') { depth--; cur += ch; }
    else if (ch === ',' && depth === 0) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

// ---------------------------------------------------------------- transforms
const toCents = (v) => (v == null || v === '' ? null : Math.round(Number(v) * 100));
const toBit = (v) => (v == null ? null : (v ? 1 : 0));
const toJsonText = (v) => (v == null ? null : (typeof v === 'string' ? v : JSON.stringify(v)));
const toIso = (v) => (v == null ? null : (v instanceof Date ? v.toISOString() : String(v)));

function sqlLiteral(v) {
  if (v == null) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'bigint') return String(v);
  if (v instanceof Date) return "'" + v.toISOString() + "'";
  if (v instanceof Uint8Array || Buffer.isBuffer(v)) return "X'" + Buffer.from(v).toString('hex') + "'";
  if (typeof v === 'object') v = JSON.stringify(v);
  const s = String(v).replace(/\0/g, '').replace(/'/g, "''");
  return "'" + s + "'";
}

// PG column -> { target, fn } against a D1 column set, or null to drop it.
function planColumn(name, dataType, d1cols) {
  const dt = String(dataType || '').toLowerCase();
  if (d1cols.has(name)) {
    if (dt === 'boolean') return { target: name, fn: toBit };
    if (dt === 'json' || dt === 'jsonb') return { target: name, fn: toJsonText };
    if (dt.includes('timestamp') || dt === 'date') return { target: name, fn: toIso };
    return { target: name, fn: (x) => x };
  }
  if (/_usd$/.test(name)) {
    const cents = name.replace(/_usd$/, '_cents');
    if (d1cols.has(cents)) return { target: cents, fn: toCents };
  }
  return null;
}

// ---------------------------------------------------------------- selftest
if (SELFTEST) {
  const t = parseD1Schema();
  const A = (l, ok) => console.log((ok ? 'PASS  ' : 'FAIL  ') + l);
  A('parsed a plausible table count', t.size > 40);
  A('products: img col, price_cents not price_usd', t.get('products').cols.has('img') && t.get('products').cols.has('price_cents') && !t.get('products').cols.has('price_usd'));
  A('products: phase-6 core_charge_cents present', t.get('products').cols.has('core_charge_cents'));
  A('purchase_order_items: renamed qty -> qty_ordered', t.get('purchase_order_items').cols.has('qty_ordered') && !t.get('purchase_order_items').cols.has('qty'));
  A('warehouse_activity: 0004 redefined shape (qty_delta)', t.get('warehouse_activity').cols.has('qty_delta'));
  A('customer_reminders present (0020)', t.has('customer_reminders'));
  A('toCents(12.34) === 1234', toCents(12.34) === 1234);
  A('toCents(null) === null', toCents(null) === null);
  A('toBit(true/false/null)', toBit(true) === 1 && toBit(false) === 0 && toBit(null) === null);
  A('toJsonText object -> string', toJsonText({ a: 1 }) === '{"a":1}');
  A('sqlLiteral escapes quotes', sqlLiteral("O'Brien") === "'O''Brien'");
  A('sqlLiteral keeps spaces', sqlLiteral('front bumper') === "'front bumper'");
  const plan = planColumn('price_usd', 'numeric', t.get('products').cols);
  A('planColumn maps price_usd -> price_cents', plan && plan.target === 'price_cents' && plan.fn(1.5) === 150);
  A('planColumn drops PG-only search_text', planColumn('search_text', 'text', t.get('products').cols) === null);
  process.exit(0);
}

// ---------------------------------------------------------------- run
if (!PG_URL) {
  console.error('No Postgres URL. Pass --url or set DATABASE_URL.');
  process.exit(1);
}

const { default: pg } = await import('pg');
const client = new pg.Client({ connectionString: PG_URL });
await client.connect();

fs.mkdirSync(OUT, { recursive: true });
const d1 = parseD1Schema();
const ordered = [...d1.entries()].filter(([t]) => !SKIP.has(t)).sort((a, b) => a[1].order - b[1].order);

const summary = [];
const written = [];
let fileNo = 0;

for (const [table, { cols }] of ordered) {
  const reg = await client.query('SELECT to_regclass($1) AS r', [`public."${table}"`]);
  if (!reg.rows[0].r) { summary.push([table, '-', 'no PG table, skipped']); continue; }

  const colRows = (await client.query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [table])).rows;

  const plans = [];
  const dropped = [];
  for (const { column_name, data_type } of colRows) {
    const p = planColumn(column_name, data_type, cols);
    if (p) plans.push({ src: column_name, ...p });
    else dropped.push(column_name);
  }
  if (!plans.length) { summary.push([table, '0', 'no mappable columns, skipped']); continue; }

  const selectList = plans.map((p) => `"${p.src}"`).join(', ');
  const q = `SELECT ${selectList} FROM "${table}"` + (ROW_LIMIT ? ` LIMIT ${ROW_LIMIT}` : '');
  const rows = (await client.query(q)).rows;

  fileNo++;
  const fname = `${String(fileNo).padStart(2, '0')}_${table}.sql`;
  const targets = plans.map((p) => `"${p.target}"`).join(', ');
  const parts = [
    `-- ${table}: ${rows.length} row(s) from Postgres (wholesale replace)`,
    dropped.length ? `-- dropped PG-only columns: ${dropped.join(', ')}` : '',
    // No BEGIN/COMMIT: D1's `execute --file` manages its own transaction and
    // rejects explicit BEGIN. Wipe first so the table is an exact copy of
    // Postgres — no leftover migration-seed rows, no duplicates.
    `DELETE FROM "${table}";`,
  ].filter(Boolean);

  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const values = chunk.map((r) =>
      '(' + plans.map((p) => sqlLiteral(p.fn(r[p.src]))).join(', ') + ')').join(',\n  ');
    parts.push(`INSERT OR REPLACE INTO "${table}" (${targets}) VALUES\n  ${values};`);
  }
  parts.push('');
  fs.writeFileSync(path.join(OUT, fname), parts.join('\n'));
  written.push(fname);
  summary.push([table, String(rows.length), dropped.length ? `dropped: ${dropped.join(', ')}` : 'ok']);
}

const sh = ['#!/usr/bin/env bash', 'set -euo pipefail',
  'DB=${1:-mortysautoparts-db}', 'FLAGS=${2:---remote}', '',
  ...written.map((f) => `npx wrangler d1 execute "$DB" $FLAGS --file "$(dirname "$0")/${f}"`), ''].join('\n');
fs.writeFileSync(path.join(OUT, '_import.sh'), sh);
const ps = ['param([string]$Db = "mortysautoparts-db", [string]$Flags = "--remote")',
  '$ErrorActionPreference = "Stop"',
  ...written.map((f) => `npx wrangler d1 execute $Db $Flags.Split(" ") --file "$PSScriptRoot/${f}"`), ''].join('\n');
fs.writeFileSync(path.join(OUT, '_import.ps1'), ps);

await client.end();

console.log('\n' + 'Table'.padEnd(34) + 'Rows'.padEnd(10) + 'Notes');
console.log('-'.repeat(80));
for (const [t, n, note] of summary) console.log(String(t).padEnd(34) + String(n).padEnd(10) + note);
console.log(`\n${written.length} file(s) in ${path.relative(APP, OUT)}/  - then: bash ${path.relative(APP, OUT)}/_import.sh`);
