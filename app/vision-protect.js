'use strict';
// =============================================================================
//  vision-protect.js  --  give this PC's Vision database a new random password.
//
//      node vision-protect.js --new-password
//
//  Run by Protect-Vision-Database.ps1 while Vision is stopped (security check
//  2026-11-13; adapted from MINI's mcs-protect.js). It:
//    1. lets this PC's own sign-in through for a moment (one pg_hba.conf line
//       for 127.0.0.1, put back exactly as it was before it finishes),
//    2. starts the bundled PostgreSQL, sets a new random password for the
//       database user, and stops it,
//    3. writes the password into the three files the app reads it from
//       (app\portable.json, app\db-config.json, app\.env).
//
//  It never prints the password. It does not need the old one.
// =============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const APP = __dirname;
const ROOT = path.resolve(APP, '..');
const PGDATA = process.env.VP_PGDATA || path.join(ROOT, 'data', 'pgdata');
const PG_BIN = process.env.VP_PGBIN || path.join(ROOT, 'runtime', 'pgsql', 'bin');
const PG_CTL = path.join(PG_BIN, process.platform === 'win32' ? 'pg_ctl.exe' : 'pg_ctl');
const HBA = path.join(PGDATA, 'pg_hba.conf');
const LOG = path.join(ROOT, 'data', 'logs', 'protect-postgres.log');

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch (_) { return d; } };
// Keep each file's own line endings so a CRLF file stays CRLF.
const writeKeepingEol = (f, text, like) => fs.writeFileSync(f, /\r\n/.test(like || '') ? text.replace(/\r?\n/g, '\r\n') : text);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pgCtl = (args) => spawnSync(PG_CTL, args, { windowsHide: true, encoding: 'utf8', stdio: 'ignore' });

let ORIGINAL_HBA = null;
function restoreHba() { if (ORIGINAL_HBA != null) { try { fs.writeFileSync(HBA, ORIGINAL_HBA); } catch (_) {} } }

async function main() {
  const portablePath = path.join(APP, 'portable.json');
  const portableRaw = fs.existsSync(portablePath) ? fs.readFileSync(portablePath, 'utf8') : '';
  const cfg = readJson(portablePath, {});
  const dbCfgPath = path.join(APP, 'db-config.json');
  const dbRaw = fs.existsSync(dbCfgPath) ? fs.readFileSync(dbCfgPath, 'utf8') : '';
  const db = readJson(dbCfgPath, null);
  const port = Number(process.env.VP_PORT) || Number(cfg.pgPort) || Number(db && db.local && db.local.port) || 5435;
  const user = cfg.pgUser || (db && db.local && db.local.user) || 'postgres';
  if (!/^[A-Za-z0-9_]+$/.test(user)) throw new Error('unexpected database user name');
  if (!fs.existsSync(path.join(PGDATA, 'PG_VERSION'))) throw new Error('there is no database here (' + PGDATA + ')');
  const st = spawnSync(PG_CTL, ['-D', PGDATA, 'status'], { windowsHide: true, encoding: 'utf8' });
  if (st.status === 0) throw new Error('the database is still running -- stop Vision first');

  const hba = fs.readFileSync(HBA, 'utf8');
  ORIGINAL_HBA = hba;
  const nl = /\r\n/.test(hba) ? '\r\n' : '\n';
  fs.writeFileSync(HBA, '# vision-protect: temporary, removed when the password is set' + nl + 'host all ' + user + ' 127.0.0.1/32 trust' + nl + hba);
  const pw = crypto.randomBytes(30).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 28);
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    const r = pgCtl(['-D', PGDATA, '-o', '-p ' + port, '-l', LOG, '-w', '-t', '90', 'start']);
    if (r.status !== 0) throw new Error('the database would not start (pg_ctl exit ' + r.status + ') -- see ' + LOG);
    try {
      const { Client } = require(path.join(APP, 'node_modules', 'pg'));
      let done = false, last = null;
      for (let i = 0; i < 15 && !done; i++) {
        const c = new Client({ host: '127.0.0.1', port, user, database: 'postgres', connectionTimeoutMillis: 5000 });
        try {
          await c.connect();
          await c.query(`ALTER USER "${user}" PASSWORD '${pw}'`);
          done = true;
        } catch (e) { last = e; await sleep(1000); }
        finally { try { await c.end(); } catch (_) {} }
      }
      if (!done) throw new Error('could not set the password: ' + (last && last.message));
    } finally {
      pgCtl(['-D', PGDATA, '-m', 'fast', '-w', '-t', '90', 'stop']);
    }
  } finally {
    restoreHba();
  }

  // The app's copies. Only entries that point at this PC's own database change.
  if (portableRaw) {
    cfg.pgPassword = pw;
    if (cfg.bundledPostgres !== false && (!cfg.dbHost || ['auto', '127.0.0.1', 'localhost'].includes(String(cfg.dbHost)))) cfg.dbPassword = pw;
    writeKeepingEol(portablePath, JSON.stringify(cfg, null, 2) + '\n', portableRaw);
  }
  if (db && db.local && ['127.0.0.1', 'localhost'].includes(String(db.local.host)) && Number(db.local.port) === port) {
    db.local.password = pw;
    writeKeepingEol(dbCfgPath, JSON.stringify(db, null, 2) + '\n', dbRaw);
  }
  const envPath = path.join(APP, '.env');
  if (fs.existsSync(envPath)) {
    const env = fs.readFileSync(envPath, 'utf8');
    const out = env.replace(/^(DATABASE_URL=postgres(?:ql)?:\/\/)([^:@\/\s]+):[^@\s]*@(127\.0\.0\.1|localhost)(:(\d+)\/)/m,
      (m, a, u, h, rest, p) => (Number(p) === port ? a + u + ':' + pw + '@' + h + rest : m));
    if (out !== env) fs.writeFileSync(envPath, out);
  }
  console.log('ok: the database has a new password (not shown)');
}

if ((process.argv[2] || '') === '--new-password') {
  main().then(() => process.exit(0)).catch((e) => { restoreHba(); console.error('FAILED: ' + e.message); process.exit(1); });
} else {
  console.log('usage: node vision-protect.js --new-password');
}
