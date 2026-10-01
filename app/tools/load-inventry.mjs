// Load INVENTRY.csv into products.
//
//   node app/tools/load-inventry.mjs [--append] [path/to/INVENTRY.csv]
//
// CSV columns: SKU, DESCRIPTION, VEHICLE, MODEL, LOCATION, QUANTITY, COST, PRICE, WHOLEPRICE
// Mapping:
//   SKU            -> img (unique key) + sku
//   DESCRIPTION    -> name
//   VEHICLE+MODEL  -> make_model  ("VEHICLE / MODEL", de-duped when MODEL == VEHICLE or blank)
//   LOCATION       -> bin_location
//   QUANTITY       -> stock_count
//   COST / PRICE   -> cost_usd / price_usd   (WHOLEPRICE is ignored)
//   category       -> derived from DESCRIPTION keywords
//   condition      -> 'NEW' (no data in the file)
// Replaces the products table unless --append is passed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { categorise } from './_categorise.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const APPEND = process.argv.includes('--append');
const CSV_PATH = process.argv.find((a, i) => i >= 2 && !a.startsWith('--')) || path.join(ROOT, 'INVENTRY.csv');

// ---- tiny CSV parser: quotes, "" escaping, CRLF ----------------------------
function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

// ---- helpers ------------------------------------------------------------
const clean = (v) => String(v == null ? '' : v).trim();
function money(v) {
  const n = parseFloat(String(v).replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : null;
}
function intQty(v) {
  const n = Math.round(parseFloat(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}
function makeModel(vehicle, model) {
  const v = clean(vehicle), m = clean(model);
  if (!v && !m) return '';
  if (!v) return m;
  if (!m || m.toUpperCase() === v.toUpperCase()) return v;
  return v + ' / ' + m;
}

// ---- build rows ------------------------------------------------------------
const raw = parseCsv(fs.readFileSync(CSV_PATH, 'utf8').replace(/^﻿/, ''));
const header = raw.shift().map((h) => clean(h).toUpperCase());
const col = (name) => header.indexOf(name);
const iSku = col('SKU'), iDesc = col('DESCRIPTION'), iVeh = col('VEHICLE'), iMod = col('MODEL'),
      iLoc = col('LOCATION'), iQty = col('QUANTITY'), iCost = col('COST'), iPrice = col('PRICE');
if (iSku < 0 || iDesc < 0) { console.error('Unexpected header:', header.slice(0, 9)); process.exit(1); }

const byImg = new Map();       // last row wins on duplicate SKU
let blank = 0, dupes = 0;
for (const r of raw) {
  const sku = clean(r[iSku]);
  if (!sku) { blank++; continue; }
  if (byImg.has(sku)) dupes++;
  const price = money(r[iPrice]);
  byImg.set(sku, {
    img: sku,
    sku,
    name: clean(r[iDesc]) || sku,
    make_model: makeModel(r[iVeh], r[iMod]),
    category: categorise(r[iDesc]),
    condition: 'NEW',
    price_usd: price != null && price > 0 ? price : null,
    cost_usd: money(r[iCost]),
    stock_count: intQty(r[iQty]),
    bin_location: clean(r[iLoc]) || null,
  });
}
const rows = [...byImg.values()];

const dist = {};
for (const x of rows) dist[x.category] = (dist[x.category] || 0) + 1;
console.log(`CSV rows: ${raw.length}  |  loadable: ${rows.length}  |  blank SKU skipped: ${blank}  |  duplicate SKU collapsed: ${dupes}`);
console.log('category distribution:', dist);

// ---- write to DB --------------------------------------------------------
const cfg = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'db-config.json'), 'utf8')).local;
const pool = new pg.Pool({ host: cfg.host, port: cfg.port, database: cfg.database, user: cfg.user, password: cfg.password, max: 4 });
const client = await pool.connect();
try {
  await client.query('BEGIN');
  if (!APPEND) {
    await client.query('TRUNCATE products RESTART IDENTITY CASCADE');
    console.log('products truncated (pass --append to keep existing rows)');
  }
  const COLS = ['img', 'sku', 'name', 'make_model', 'category', 'condition', 'price_usd', 'cost_usd', 'stock_count', 'bin_location'];
  const CHUNK = 500;
  let done = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const vals = [];
    const tuples = slice.map((row, n) => {
      const b = n * COLS.length;
      COLS.forEach((c) => vals.push(row[c]));
      return '(' + COLS.map((_, k) => `$${b + k + 1}`).join(',') + ')';
    });
    await client.query(
      `INSERT INTO products (${COLS.join(',')}) VALUES ${tuples.join(',')}
       ON CONFLICT (img) DO UPDATE SET
         sku=EXCLUDED.sku, name=EXCLUDED.name, make_model=EXCLUDED.make_model,
         category=EXCLUDED.category, condition=EXCLUDED.condition,
         price_usd=EXCLUDED.price_usd, cost_usd=EXCLUDED.cost_usd,
         stock_count=EXCLUDED.stock_count, bin_location=EXCLUDED.bin_location,
         updated_at=now()`,
      vals
    );
    done += slice.length;
  }
  await client.query('COMMIT');
  const { rows: [{ count }] } = await client.query('SELECT count(*)::int AS count FROM products');
  console.log(`inserted/updated ${done} rows  |  products now: ${count}`);
} catch (e) {
  await client.query('ROLLBACK');
  console.error('FAILED, rolled back:', e.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
