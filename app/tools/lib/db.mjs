// Shared DB plumbing for the legacy CSV seeders.
//
// Two ways in:
//   sql()        -- a pooled pg client for DDL, transforms and reporting
//   copyInto()   -- bulk load, by piping TSV into `psql \copy`
//
// The seed volumes (931k invoices, 1.05M sale lines, 717k payments) make
// parameterised INSERTs too slow, and pg-copy-streams is not a dependency of
// this project, so COPY is driven through the bundled psql binary instead.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..', '..');   // repo root
const APP = path.resolve(HERE, '..', '..');                 // app/

// db-config.json is operator-edited and often saved with a UTF-8 BOM (Notepad,
// PowerShell Set-Content) -- JSON.parse chokes on it, so strip it like
// server.js's stripBom() does.
export function dbConfig() {
  const raw = fs.readFileSync(path.join(APP, 'db-config.json'), 'utf8').replace(/^﻿/, '');
  const cfg = JSON.parse(raw).local;
  if (!cfg) throw new Error('db-config.json has no "local" section');
  return cfg;
}

// The import page (legacy-import.js) runs these tools as child processes and
// passes the server's own DATABASE_URL, so they always write to the database
// the till is running on. Run by hand, they use db-config.json as before.
export function pool(max = 4) {
  if (process.env.DATABASE_URL) return new pg.Pool({ connectionString: process.env.DATABASE_URL, max });
  const c = dbConfig();
  return new pg.Pool({ host: c.host, port: c.port, database: c.database, user: c.user, password: c.password, max });
}

// psql.exe ships in runtime/pgsql/bin on the Windows deployments; fall back to
// whatever is on PATH elsewhere.
export function psqlPath() {
  const bundled = path.join(ROOT, 'runtime', 'pgsql', 'bin', process.platform === 'win32' ? 'psql.exe' : 'psql');
  return fs.existsSync(bundled) ? bundled : 'psql';
}

const BACKSLASH = String.fromCharCode(92);
const TSV_ESC = new RegExp('[' + BACKSLASH + BACKSLASH + '\\t\\n\\r]');
// COPY ... FROM STDIN text format: \N is NULL, and backslash/tab/CR/LF must be
// escaped. Everything else goes through verbatim.
function tsvCell(v) {
  if (v === null || v === undefined) return BACKSLASH + 'N';
  let s = typeof v === 'string' ? v : (v instanceof Date ? v.toISOString() : String(v));
  if (s === '') return '';
  if (TSV_ESC.test(s)) {
    s = s.split(BACKSLASH).join(BACKSLASH + BACKSLASH)
         .split('\t').join(BACKSLASH + 't')
         .split('\r').join(BACKSLASH + 'r')
         .split('\n').join(BACKSLASH + 'n');
  }
  return s;
}

// Stream rows (arrays, in `cols` order) into `table` via COPY FROM STDIN.
// `rows` may be any sync/async iterable, so callers can pipe straight from a
// CSV reader without materialising a million objects.
export async function copyInto(table, cols, rows, { onProgress, progressEvery = 100000 } = {}) {
  const url = process.env.DATABASE_URL;
  const c = url ? null : dbConfig();
  const args = [...(url ? ['-d', url] : ['-h', c.host, '-p', String(c.port), '-U', c.user, '-d', c.database]),
    '-q', '-v', 'ON_ERROR_STOP=1',
    '-c', `\copy ${table} (${cols.join(',')}) FROM STDIN`];
  const child = spawn(psqlPath(), args, {
    env: url ? process.env : { ...process.env, PGPASSWORD: c.password },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderr = '', stdout = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });

  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => code === 0
      ? resolve()
      : reject(new Error(`psql \copy ${table} exited ${code}\n${stderr.trim() || stdout.trim()}`)));
  });
  // A psql failure (bad column, constraint violation) closes stdin early; the
  // EPIPE that follows is noise next to the real error on stderr.
  child.stdin.on('error', (e) => { if (e.code !== 'EPIPE') throw e; });

  let n = 0;
  const BUF = [];
  for await (const row of rows) {
    BUF.push(cols.map((_, i) => tsvCell(row[i])).join('\t'));
    n++;
    if (BUF.length >= 4096) {
      if (!child.stdin.write(BUF.join('\n') + '\n')) {
        await new Promise((r) => child.stdin.once('drain', r));
      }
      BUF.length = 0;
      if (onProgress && n % progressEvery < 4096) onProgress(n);
    }
  }
  if (BUF.length) child.stdin.write(BUF.join('\n') + '\n');
  child.stdin.end();
  await done;
  return n;
}

// Small helper so loaders can log consistent one-line summaries.
export const fmt = (n) => Number(n).toLocaleString('en-US');

// Apply the Postgres-only import scaffolding (staging tables, the rejects
// table, the legacy_* coercion functions, the two tracking columns and the
// missing FK indexes). Lives in tools/lib/legacy-schema.sql rather than
// migrations/ because migrations/ is the Cloudflare D1 (SQLite) directory --
// see the header of that file. Idempotent, so every seeder can just call it.
let ensured = false;
export async function ensureLegacySchema(client) {
  if (ensured) return;
  const sql = fs.readFileSync(path.join(HERE, 'legacy-schema.sql'), 'utf8');
  await client.query(sql);
  ensured = true;
}
