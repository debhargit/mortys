// ============================================================================
//  Meltha Honda Sales & Servs — Express + Postgres backend
//  Serves the static site from this same folder and exposes /api/* endpoints.
//
//  Boot:
//    npm install                    (first time only)
//    cp .env.example .env           (edit DATABASE_URL etc.)
//    psql -d melthahonda -f schema.sql  (first time only — or let the server run it)
//    node server.js
// ============================================================================

'use strict';

// ---- Crash safety net -------------------------------------------------------
// Without these, ANY unhandled rejection or thrown error anywhere in the
// process (a bad DB column, a third-party API hiccup, a stray bug) takes the
// entire server down — every register, every customer, all at once. These
// handlers log the error and keep the process alive instead. They're a
// backstop, not a substitute for real error handling in each route (see the
// app.<method> auto-wrap below), but they mean a bug in one request can never
// again silently kill the whole POS.
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err && err.stack || err);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.stack || err);
});

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const { execFile } = require('child_process');
const os = require('os');
const dgram = require('dgram');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const cookieSession = require('cookie-session');
const mailer = require('./mailer');
const payments = require('./payments');
const sms = require('./sms');

// ---- Multer (file uploads) ------------------------------------------------
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

let upload;
try {
  const multer = require('multer');
  upload = multer({
    storage: multer.diskStorage({
      destination: UPLOAD_DIR,
      filename(_req, file, cb) {
        const ts = Date.now();
        const rnd = Math.random().toString(36).slice(2, 8);
        const ext = (path.extname(file.originalname || '').toLowerCase() || '.jpg').slice(0, 6);
        cb(null, `inq-${ts}-${rnd}${ext}`);
      },
    }),
    limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB
    fileFilter(_req, file, cb) {
      if (!/^image\/(jpe?g|png|webp|heic|heif|gif)$/i.test(file.mimetype)) {
        return cb(new Error('Only image uploads are allowed'));
      }
      cb(null, true);
    },
  });
  console.log('[upload] multer ready, dir:', UPLOAD_DIR);
} catch (e) {
  console.warn('[upload] multer not installed — photo uploads disabled');
  // No-op middleware so the route still works (without file support)
  upload = { single: () => (req, _res, next) => next() };
}

// ---- Multer (data files: CSV / spreadsheet imports) ------------------------
// Deliberately a second instance rather than a relaxed filter on the first.
// `upload` above is image-only on purpose -- it backs photo fields, and
// widening it so the inventory importer could work would also let anyone POST
// a .csv at every product-photo endpoint. Two narrow filters beat one loose
// one. The 25 MB ceiling comfortably covers the shop's own 2 MB / 23,000-line
// stock export with room for a spreadsheet carrying formatting.
let uploadData;
try {
  const multer = require('multer');
  uploadData = multer({
    storage: multer.diskStorage({
      destination: UPLOAD_DIR,
      filename(_req, file, cb) {
        const ext = (path.extname(file.originalname || '').toLowerCase() || '.csv').slice(0, 6);
        cb(null, `import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
      },
    }),
    limits: { fileSize: 25 * 1024 * 1024 },
    fileFilter(_req, file, cb) {
      // Browsers are wildly inconsistent about the MIME type they attach to a
      // .csv (text/csv, application/vnd.ms-excel, application/octet-stream,
      // or nothing at all), so the extension is the reliable signal and the
      // parser sniffs the actual bytes afterwards regardless.
      if (!/\.(csv|tsv|txt|xlsx|xlsm|xls)$/i.test(file.originalname || '')) {
        return cb(new Error('Upload a .csv, .tsv or .xlsx file'));
      }
      cb(null, true);
    },
  });
} catch (e) {
  uploadData = { single: () => (req, _res, next) => next() };
}

const ROOT = __dirname;

// ---- Server connection settings ---------------------------------------------
// Editable from Admin Setup -> Server connection (port only -- there's no
// "fallback" concept here the way local/online applies to the database; this
// process either listens on a port or it doesn't). Saving writes
// server-config.json but can NOT take effect until the process restarts --
// unlike the DB pools, you can't rebind the HTTP listener to a new port
// mid-request without dropping the very connection that requested the
// change, so this is deliberately "save, then tell the operator to restart",
// not a hot-swap.
// Notepad and PowerShell's Set-Content both write a UTF-8 byte order mark by
// default, and JSON.parse throws on one. Since server-config.json,
// db-config.json and machine-config.json are all files an operator might
// reasonably open in Notepad -- and all three are read inside a try/catch
// that falls back to defaults -- a BOM would silently discard the real
// settings and present as a connection failure rather than a parse failure.
function stripBom(text) {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}
const SERVER_CONFIG_PATH = path.join(__dirname, 'server-config.json');
function loadServerConfig() {
  try { return JSON.parse(stripBom(fs.readFileSync(SERVER_CONFIG_PATH, 'utf8'))); }
  catch (_) { return {}; }
}
function saveServerConfig(cfg) {
  fs.writeFileSync(SERVER_CONFIG_PATH, JSON.stringify(cfg, null, 2));
}
const SERVER_CFG = loadServerConfig();
const PORT = parseInt(SERVER_CFG.port || process.env.PORT || '3040', 10);

// ---- Postgres pool(s) --------------------------------------------------------
// Two independent connections, configurable from Admin Setup -> Database
// (falls back to DATABASE_URL / the hardcoded local default if never
// configured there, so nothing changes for an install that hasn't touched
// this). `pool` (local) is what almost everything in this file uses --
// admin/POS routes ALWAYS use it, no failover, on purpose: silently
// accepting a POS sale or an admin write into a different, unreconciled
// database during an outage is worse than the write just failing loudly.
// `onlinePool` only exists to serve as a read-only fallback for a small,
// explicit set of PUBLIC storefront browsing routes via queryWithFallback()
// below, so a customer can still see the catalogue if the local database
// is briefly unreachable. The two databases are never synced with each
// other -- accepted trade-off, not an oversight (see ADMIN-POS-AUDIT.md).
const DB_CONFIG_PATH = path.join(__dirname, 'db-config.json');
function loadDbConfig() {
  try { return JSON.parse(stripBom(fs.readFileSync(DB_CONFIG_PATH, 'utf8'))); }
  catch (_) { return {}; }
}
function saveDbConfig(cfg) {
  fs.writeFileSync(DB_CONFIG_PATH, JSON.stringify(cfg, null, 2));
}
function buildPoolConfig(c) {
  if (!c || !c.host) return null;
  const cfg = { host: c.host, port: parseInt(c.port, 10) || 5432, database: c.database, user: c.user, password: c.password, max: 10 };
  const mode = String(c.sslmode || '').trim().toLowerCase();
  if (mode && mode !== 'disable') {
    if (c.ca) {
      // Pinned to the shop's own certificate, handed over at enrolment.
      //
      // checkServerIdentity is stubbed out deliberately: the certificate is
      // self-signed for a machine reached by a DHCP address, so hostname
      // matching would fail on the first day the router hands out a different
      // one. Verifying the chain against this exact pinned certificate is the
      // stronger check -- an impostor would need the private key, which never
      // leaves the server -- and it is not weakened by ignoring the name.
      cfg.ssl = { ca: c.ca, rejectUnauthorized: true, checkServerIdentity: () => undefined };
    } else {
      // Encrypt-only: stops passive capture on the shop wifi, but cannot tell
      // the real server from an impostor. This is what `sslmode=require` means
      // everywhere else, and why enrolment always sends the certificate.
      cfg.ssl = { rejectUnauthorized: false };
    }
  }
  return cfg;
}

// Where a till sends the things it is no longer trusted to do itself. Written
// into db-config.json at enrolment; absent on the server, and on any till
// enrolled before this existed (which simply keeps checking passwords locally,
// because its role can still read the hash).
function loadUpstream() {
  const u = (loadDbConfig() || {}).upstream;
  return (u && u.url && u.token) ? u : null;
}

// Deliberately hand-rolled on http/https rather than pulling in a client: this
// runs on a shop till over a LAN, and the only thing it ever calls is our own
// server. Short timeout because a cashier is standing there waiting.
function upstreamPost(up, urlPath, body) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(up.url); } catch (_) { return reject(new Error('Bad upstream URL')); }
    const lib = u.protocol === 'https:' ? require('https') : require('http');
    const payload = Buffer.from(JSON.stringify(body));
    const req = lib.request({
      host: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: urlPath, method: 'POST', timeout: 8000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
        'x-terminal-token': up.token,
      },
    }, (r) => {
      let data = '';
      r.on('data', (c) => { data += c; });
      r.on('end', () => {
        let j = null;
        try { j = JSON.parse(data); } catch (_) {}
        if (!j) return reject(new Error('Bad response from the shop server (HTTP ' + r.statusCode + ')'));
        // 401 is a real answer here ("wrong password"), not a transport
        // failure, so it resolves rather than rejects -- the caller decides.
        if (r.statusCode >= 500) return reject(new Error(j.error || ('HTTP ' + r.statusCode)));
        resolve(Object.assign({ _status: r.statusCode }, j));
      });
    });
    req.on('timeout', () => { req.destroy(new Error('The shop server did not answer in time.')); });
    req.on('error', reject);
    req.end(payload);
  });
}

// This server's own PostgreSQL certificate, to hand to a till at enrolment so
// it can pin it. Looks where the portable layout puts it, then at an explicit
// override for an operator-managed Postgres.
function serverDbCertPem() {
  const candidates = [
    process.env.PG_SSL_CERT_FILE,
    path.join(__dirname, '..', 'data', 'pgdata', 'server.crt'),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      const pem = fs.readFileSync(p, 'utf8');
      if (/BEGIN CERTIFICATE/.test(pem)) return pem;
    } catch (_) {}
  }
  return null;
}

let pool;       // local -- admin/POS/everything else, always
let onlinePool; // online -- public storefront fallback only, or null if never configured
function applyDbConfig(cfg) {
  const localCfg = buildPoolConfig(cfg.local) || {
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/melthahonda',
    max: 10,
  };
  const oldPool = pool, oldOnline = onlinePool;
  pool = new Pool(localCfg);
  pool.on('error', (err) => console.error('[pg local] idle client error:', err.message));
  const onlineCfg = buildPoolConfig(cfg.online);
  onlinePool = onlineCfg ? new Pool(onlineCfg) : null;
  if (onlinePool) onlinePool.on('error', (err) => console.error('[pg online] idle client error:', err.message));
  // Close the previous pools once the new ones are in (best-effort -- an
  // in-flight query already checked out of the old pool still finishes
  // against it; this just stops handing out new connections from it).
  if (oldPool) oldPool.end().catch(() => {});
  if (oldOnline) oldOnline.end().catch(() => {});
}
applyDbConfig(loadDbConfig());

// Connects with a short timeout and doesn't touch the live pools -- used by
// the "Test connection" button in Setup so a typo doesn't have to be
// discovered by breaking the app to find out.
async function testDbConnection(c) {
  const cfg = buildPoolConfig(c);
  if (!cfg) return { ok: false, error: 'Host is required' };
  const testPool = new Pool(Object.assign({}, cfg, { max: 1, connectionTimeoutMillis: 5000 }));
  try {
    await testPool.query('SELECT 1');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    testPool.end().catch(() => {});
  }
}

async function query(text, params) {
  const t0 = Date.now();
  const res = await pool.query(text, params);
  if (process.env.SQL_LOG === '1') {
    console.log(`[sql ${Date.now() - t0}ms]`, text.split('\n')[0].slice(0, 80));
  }
  return res;
}

// For the small, explicit set of public storefront browsing routes that
// should stay usable even if the local database is briefly down (see the
// GET /api/products family). Falls back to onlinePool only when the local
// query itself fails (unreachable, connection refused, etc.) -- if
// onlinePool isn't configured, the real error still surfaces normally, and
// this is never used for anything that writes (see the big comment above).
async function queryWithFallback(text, params) {
  try {
    return await pool.query(text, params);
  } catch (e) {
    if (!onlinePool) throw e;
    console.warn('[db] local query failed, falling back to the online database:', e.message);
    return onlinePool.query(text, params);
  }
}

// ---- This machine's identity + LAN recognition ------------------------------
// Lets Setup (and the POS Terminal badge) automatically "recognize" the
// machine they're running on the moment the local server is installed and
// running, instead of the operator having to type in a hostname or IP by
// hand: this process detects its own local Postgres on boot and re-checks it
// periodically (LOCAL_SERVER_STATUS below), and broadcasts a small UDP
// announcement that other Meltha Honda instances on the same LAN can pick up
// passively, or query on demand -- so a second terminal machine can find an
// already-installed local server without typing its IP. Read-only, LAN-only
// (UDP broadcast doesn't cross a router/subnet), and every piece of it is
// wrapped so a blocked port or a network without broadcast support just
// disables discovery quietly rather than taking the app down.
const MACHINE_CONFIG_PATH = path.join(__dirname, 'machine-config.json');
function loadMachineConfig() {
  try { return JSON.parse(stripBom(fs.readFileSync(MACHINE_CONFIG_PATH, 'utf8'))); }
  catch (_) { return {}; }
}
function saveMachineConfig(cfg) {
  fs.writeFileSync(MACHINE_CONFIG_PATH, JSON.stringify(cfg, null, 2));
}
let MACHINE_CFG = loadMachineConfig();
function machineName() {
  return (MACHINE_CFG.name && MACHINE_CFG.name.trim()) || os.hostname();
}
function primaryLocalIPv4() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

// Re-detected on boot and every 30s so Setup and the POS bar can show "local
// server detected" the instant the page loads -- no "Test connection" click
// needed. Separate from the (near-identical) probe GET /db-server-status
// already does inline, kept independent so this background loop can never
// interfere with that route's own on-demand result.
let LOCAL_SERVER_STATUS = { reachable: false, db_exists: false, checked_at: null };
async function detectLocalServer() {
  const cfg = loadDbConfig();
  const localCfg = buildPoolConfig(cfg.local) || { host: 'localhost', port: 5432, user: 'postgres', password: process.env.PGPASSWORD || 'postgres' };
  const dbName = localCfg.database || 'melthahonda';
  const probe = new Pool(Object.assign({}, localCfg, { database: 'postgres', max: 1, connectionTimeoutMillis: 3000 }));
  try {
    const r = await probe.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    LOCAL_SERVER_STATUS = { reachable: true, db_exists: r.rows.length > 0, checked_at: new Date().toISOString() };
  } catch (_) {
    LOCAL_SERVER_STATUS = { reachable: false, db_exists: false, checked_at: new Date().toISOString() };
  } finally {
    probe.end().catch(() => {});
  }
}
detectLocalServer();
setInterval(detectLocalServer, 30000).unref();

// =============================================================================
//  TERMINAL REGISTRY & ACCESS CONTROL
//
//  Client machines run their own copy of THIS file and talk straight to
//  Postgres; none of their traffic passes through the server, so there is
//  nothing for the server to intercept. Enforcement is therefore cooperative:
//  every instance registers itself in `terminals`, re-reads its own row on a
//  heartbeat, and closes its own admin UI if the row says pending or blocked.
//
//  Effective as an operational control, and instant from the counter. Not a
//  security boundary -- see the comment on the table in schema.sql.
// =============================================================================
const TERMINAL_ID_PATH = path.join(__dirname, 'terminal-id.json');
const APP_VERSION = (() => {
  try { return require('./package.json').version || ''; } catch (_) { return ''; }
})();

// Stable across reboots and rebuilds of app\ -- it is the identity the server
// approves, so regenerating it would silently turn an approved till into a new
// pending one every time the package was updated.
function loadTerminalUid() {
  try {
    const j = JSON.parse(stripBom(fs.readFileSync(TERMINAL_ID_PATH, 'utf8')));
    if (j && j.uid) return String(j.uid);
  } catch (_) {}
  const crypto = require('crypto');
  const uid = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
  try {
    fs.writeFileSync(TERMINAL_ID_PATH, JSON.stringify({ uid, created_at: new Date().toISOString() }, null, 2));
  } catch (e) {
    console.warn('[terminal] could not persist terminal id:', e.message);
  }
  return uid;
}
const TERMINAL_UID = loadTerminalUid();
const BOOT_AT = new Date();

// Is the database on THIS machine? If so this instance is the server: exempt
// from the gate and impossible to block, because a server that locked itself
// out could not be let back in from anywhere.
//
// Checking for the literal string "localhost" is not enough. A perfectly
// ordinary setup is to type the machine's own LAN address into Setup ->
// Database rather than "localhost" -- and that server would then look like a
// client, be blockable, and take the whole shop down with it. So compare
// against every address this machine actually answers on, plus the whole
// 127.0.0.0/8 loopback range and the hostname.
function isLoopbackDbHost() {
  const h = String(((loadDbConfig().local) || {}).host || '').trim().toLowerCase();
  if (!h) return true;                                   // unset => the built-in localhost default
  if (h === 'localhost' || h === '::1' || h === '[::1]') return true;
  if (/^127\./.test(h)) return true;                     // all of 127.0.0.0/8, not just 127.0.0.1
  if (h === String(os.hostname()).toLowerCase()) return true;
  try {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const ifc of ifaces[name] || []) {
        if (ifc && String(ifc.address).toLowerCase() === h) return true;
      }
    }
  } catch (_) {}
  return false;
}

// Whether this instance is the one that creates and migrates the schema.
//
// "the database is on loopback" is a good proxy on a shop LAN, where the PC
// holding PostgreSQL is the one that owns it. It is the wrong test anywhere the
// database is a separate host that this instance nonetheless owns -- a Docker
// Compose stack being the obvious case, where the app reaches PostgreSQL at
// `db:5432` and the proxy says "not mine". initDb would then be skipped and the
// container would start with no tables, no admin and no catalogue, refusing
// every sign-in: the same symptom this codebase has produced three other ways.
//
// MH_SCHEMA_OWNER=1 states it outright. Unset, the old behaviour stands, so
// nothing about the shop LAN changes.
function ownsSchema() {
  const flag = String(process.env.MH_SCHEMA_OWNER || '').trim().toLowerCase();
  if (flag === '1' || flag === 'true' || flag === 'yes') return true;
  if (flag === '0' || flag === 'false' || flag === 'no') return false;
  return isLoopbackDbHost();
}

// 'unknown' until the first successful read. Everything fails OPEN on unknown:
// a database hiccup must not brick every till in the shop, and an instance that
// cannot reach the database is already useless without any help from us.
let TERMINAL = { id: null, status: 'unknown', is_db_host: isLoopbackDbHost(), checked_at: null, error: null };
// Bumped when the server terminates this instance; sessions carry the epoch
// they were signed in under, so bumping it signs everyone here out at once.
let SESSION_EPOCH = Date.now();
let LAST_TERMINATE_HANDLED = null;

async function getAccessMode() {
  try {
    const { rows } = await query("SELECT value FROM app_settings WHERE key = 'terminal_access_mode'");
    return (rows[0] && rows[0].value) === 'open' ? 'open' : 'approve';
  } catch (_) { return 'approve'; }
}

async function registerTerminal() {
  const name = machineName();
  const dbHost = isLoopbackDbHost();
  let { rows } = await query('SELECT * FROM terminals WHERE terminal_uid = $1', [TERMINAL_UID]);
  let row = rows[0];

  // Adopt a row pre-registered by name, so an admin can approve a till before
  // it has ever been switched on.
  if (!row) {
    const pre = await query(
      'SELECT * FROM terminals WHERE terminal_uid IS NULL AND lower(name) = lower($1) ORDER BY id LIMIT 1',
      [name]
    );
    if (pre.rows.length) {
      const up = await query('UPDATE terminals SET terminal_uid = $1 WHERE id = $2 RETURNING *', [TERMINAL_UID, pre.rows[0].id]);
      row = up.rows[0];
    }
  }

  if (!row) {
    const mode = await getAccessMode();
    const anyYet = await query('SELECT 1 FROM terminals LIMIT 1');
    // Auto-approve the database host, and the very first terminal on a fresh
    // install -- with nobody approved yet there would be no one able to approve.
    const auto = dbHost || anyYet.rows.length === 0 || mode === 'open';
    const ins = await query(
      `INSERT INTO terminals (terminal_uid, name, hostname, address, port, is_db_host, status, app_version, approved_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [TERMINAL_UID, name, os.hostname(), primaryLocalIPv4(), PORT, dbHost,
       auto ? 'approved' : 'pending', APP_VERSION, auto ? new Date() : null]
    );
    row = ins.rows[0];
    console.log('[terminal] registered "' + name + '" as ' + row.status);
  } else {
    const up = await query(
      `UPDATE terminals SET name=$2, hostname=$3, address=$4, port=$5, is_db_host=$6,
              app_version=$7, last_seen=NOW()
       WHERE id=$1 RETURNING *`,
      [row.id, name, os.hostname(), primaryLocalIPv4(), PORT, dbHost, APP_VERSION]
    );
    row = up.rows[0];
  }

  // The db host can never be left blocked, however the row got that way.
  if (dbHost && row.status !== 'approved') {
    const fix = await query("UPDATE terminals SET status='approved', approved_at=NOW(), blocked_at=NULL WHERE id=$1 RETURNING *", [row.id]);
    row = fix.rows[0];
    console.warn('[terminal] this machine holds the database -- forced back to approved');
  }

  TERMINAL = { id: row.id, status: row.status, is_db_host: !!row.is_db_host, checked_at: new Date().toISOString(), error: null };

  // A terminate raised since we last acted on one signs this instance out.
  const t = row.terminate_requested_at ? new Date(row.terminate_requested_at) : null;
  if (t && t > BOOT_AT && (!LAST_TERMINATE_HANDLED || t > LAST_TERMINATE_HANDLED)) {
    LAST_TERMINATE_HANDLED = t;
    SESSION_EPOCH = Date.now();
    console.warn('[terminal] terminate requested by the server -- all sessions on this machine signed out');
  }
  return row;
}

async function terminalHeartbeat() {
  try {
    await registerTerminal();
  } catch (e) {
    // Almost always "relation terminals does not exist" on a database that has
    // not run the new schema yet. Stay open and keep trying.
    TERMINAL = Object.assign({}, TERMINAL, { checked_at: new Date().toISOString(), error: e.message });
  }
}
// Fast enough that revoking a till from the counter feels immediate, slow
// enough to be nothing on a LAN.
setInterval(terminalHeartbeat, 15000).unref();

// Random per-boot id so this process can tell its own broadcast/replies
// apart from a genuinely different machine's on the wire -- otherwise every
// instance would "discover" itself and list itself as a network server.
const DISCOVERY_PORT = 41235;
const INSTANCE_ID = Math.random().toString(36).slice(2);
const SEEN_SERVERS = new Map(); // "host:port" -> { name, host, port, has_local_db, db_exists, last_seen }
let discoverySocket = null;

function announcePayload() {
  return {
    type: 'MELTHAHONDA_ANNOUNCE', instanceId: INSTANCE_ID, name: machineName(),
    host: primaryLocalIPv4(), port: PORT,
    has_local_db: LOCAL_SERVER_STATUS.reachable, db_exists: LOCAL_SERVER_STATUS.db_exists,
    time: Date.now(),
  };
}

function startDiscoveryService() {
  try {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('error', (err) => {
      console.warn('[discovery] socket error, disabling network discovery:', err.message);
      try { sock.close(); } catch (_) {}
      discoverySocket = null;
    });
    sock.on('message', (msg, rinfo) => {
      let data;
      try { data = JSON.parse(msg.toString()); } catch (_) { return; }
      if (!data || data.instanceId === INSTANCE_ID) return; // ignore our own traffic
      if (data.type === 'MELTHAHONDA_DISCOVER') {
        try { sock.send(Buffer.from(JSON.stringify(announcePayload())), rinfo.port, rinfo.address); } catch (_) {}
      } else if (data.type === 'MELTHAHONDA_ANNOUNCE' && data.host && data.port) {
        SEEN_SERVERS.set(data.host + ':' + data.port, {
          name: data.name || data.host, host: data.host, port: data.port,
          has_local_db: !!data.has_local_db, db_exists: !!data.db_exists,
          last_seen: new Date().toISOString(),
        });
      }
    });
    sock.on('listening', () => { sock.setBroadcast(true); });
    sock.bind(DISCOVERY_PORT);
    discoverySocket = sock;
    // Proactive announce so passive listeners build a list without ever
    // sending a query -- best-effort; some networks/routers block broadcast
    // traffic and that's fine, on-demand scanning below still works via the
    // direct reply above.
    setInterval(() => {
      if (!discoverySocket) return;
      try { discoverySocket.send(Buffer.from(JSON.stringify(announcePayload())), DISCOVERY_PORT, '255.255.255.255'); } catch (_) {}
    }, 5000).unref();
  } catch (e) {
    console.warn('[discovery] could not start, network discovery disabled:', e.message);
  }
}
startDiscoveryService();

function sendDiscoveryQuery() {
  if (!discoverySocket) return;
  try {
    discoverySocket.send(Buffer.from(JSON.stringify({ type: 'MELTHAHONDA_DISCOVER', instanceId: INSTANCE_ID })), DISCOVERY_PORT, '255.255.255.255');
  } catch (_) {}
}

function seenServersList() {
  // Drop anything not heard from in the last 2 minutes -- a machine that's
  // been switched off shouldn't linger in the list forever.
  const cutoff = Date.now() - 2 * 60 * 1000;
  const out = [];
  for (const [key, v] of SEEN_SERVERS) {
    if (new Date(v.last_seen).getTime() < cutoff) { SEEN_SERVERS.delete(key); continue; }
    out.push(v);
  }
  return out;
}

// ---- App -------------------------------------------------------------------
const app = express();
app.set('trust proxy', 1); // we sit behind a Cloudflare tunnel

// ---- Auto-wrap every route handler in try/catch -----------------------------
// Only 48 of this file's ~160 async route handlers had their own try/catch.
// An unhandled rejection in any of the rest previously took the whole process
// down (see the process.on(...) handlers above) instead of just failing that
// one request. Rather than hand-edit every route, patch app.get/post/etc so
// EVERY handler and middleware registered from this point on — including
// requireAuth/requireAdmin and all routes below — automatically forwards
// thrown/rejected errors to Express's error-handling middleware (registered
// near the bottom of this file) instead of crashing. This must run before any
// app.get/post/put/patch/delete call, so it sits directly after `const app`.
['get', 'post', 'put', 'patch', 'delete'].forEach((method) => {
  const original = app[method].bind(app);
  app[method] = (routePath, ...handlers) => {
    const wrapped = handlers.map((fn) => {
      if (typeof fn !== 'function') return fn;
      return (req, res, next) => {
        try {
          const result = fn(req, res, next);
          if (result && typeof result.catch === 'function') result.catch(next);
        } catch (err) {
          next(err);
        }
      };
    });
    return original(routePath, ...wrapped);
  };
});

// Stripe webhook MUST receive the raw body before express.json() consumes it.
app.post(
  '/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    if (!payments.isActive()) return res.status(503).json({ error: 'Stripe disabled' });
    let event;
    try {
      event = payments.verifyWebhook(req.body, req.headers['stripe-signature']);
    } catch (e) {
      console.warn('[stripe] webhook signature failed:', e.message);
      return res.status(400).send('Webhook signature failed: ' + e.message);
    }
    try {
      if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
        const session = event.data.object;
        const orderId = session.metadata && session.metadata.order_id;
        if (orderId) {
          await query(
            `UPDATE orders SET payment_status = 'paid', payment_ref = $1, status = 'confirmed' WHERE id = $2`,
            [session.payment_intent || session.id, orderId]
          );
          console.log('[stripe] order #' + orderId + ' marked paid');
        }
      } else if (event.type === 'checkout.session.expired' || event.type === 'checkout.session.async_payment_failed') {
        const session = event.data.object;
        const orderId = session.metadata && session.metadata.order_id;
        if (orderId) {
          await query(`UPDATE orders SET payment_status = 'failed' WHERE id = $1`, [orderId]);
        }
      }
      res.json({ received: true });
    } catch (e) {
      console.error('[stripe] webhook handler error:', e.message);
      res.status(500).send('Webhook handler error');
    }
  }
);

app.use(express.json({ limit: '1mb' }));
app.use(
  cookieSession({
    name: 'mh_session',
    secret:
      process.env.SESSION_SECRET ||
      'dev-secret-change-me-' + Math.random().toString(36).slice(2),
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true',
  })
);

// Sessions carry the epoch they were signed in under. "Terminate this
// terminal" bumps SESSION_EPOCH, which invalidates every session on this
// machine at once -- cookie-session is stateless, so there is no server-side
// store to delete from and this is what stands in for one.
app.use((req, res, next) => {
  if (req.session && req.session.userId && req.session.epoch !== SESSION_EPOCH) req.session = null;
  next();
});

// -----------------------------------------------------------------------------
//  Terminal access gate. Fails OPEN while the status is unknown (see TERMINAL).
//  The storefront is deliberately left alone -- blocking a till should stop the
//  admin panel and POS on that machine, not take a customer-facing page down.
// -----------------------------------------------------------------------------
const TERMINAL_GATE_EXEMPT = /^\/api\/(health|terminal-status)\b/;
function terminalBlockedPage(status) {
  const pending = status === 'pending';
  return '<!doctype html><meta charset="utf-8"><title>Terminal not allowed</title>' +
    '<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1b2b;color:#e6e9ee;' +
    "font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;padding:24px}" +
    '.c{max-width:520px;text-align:center}h1{font-size:20px;margin:0 0 10px}' +
    'p{color:#94a3b8;font-size:14px;line-height:1.6;margin:0 0 8px}' +
    'code{background:rgba(255,255,255,.1);padding:2px 6px;border-radius:4px;font-size:12.5px}</style>' +
    '<div class="c"><div style="font-size:44px;margin-bottom:10px">' + (pending ? '⏳' : '⛔') + '</div>' +
    '<h1>' + (pending ? 'This terminal is waiting to be allowed' : 'This terminal has been blocked') + '</h1>' +
    '<p>' + (pending
      ? 'It has registered with the shop’s server and needs to be approved before it can be used.'
      : 'An administrator has revoked this machine’s access.') +
    '</p><p>On the main PC, open <b>Admin → Setup → Terminals &amp; access</b> and ' +
    (pending ? 'allow' : 'unblock') + ' <code>' + String(machineName()).replace(/[<>&]/g, '') + '</code>.</p>' +
    '<p style="margin-top:14px;font-size:12px">This page refreshes by itself once access is granted.</p></div>' +
    '<script>setInterval(function(){fetch("/api/terminal-status").then(function(r){return r.json()})' +
    '.then(function(d){if(d&&d.status==="approved")location.reload();}).catch(function(){});},5000);<\/script>';
}
app.get('/api/terminal-status', (req, res) => {
  res.json({ ok: true, status: TERMINAL.status, name: machineName(), is_db_host: TERMINAL.is_db_host });
});
app.use((req, res, next) => {
  if (TERMINAL.status === 'approved' || TERMINAL.status === 'unknown') return next();
  if (TERMINAL.is_db_host) return next();               // the server can never gate itself out
  if (TERMINAL_GATE_EXEMPT.test(req.path)) return next();
  const wantsAdmin = req.path === '/admin.html' || req.path.startsWith('/api/admin');
  if (req.path.startsWith('/api/')) {
    if (!wantsAdmin && !req.path.startsWith('/api/auth')) return next();  // storefront APIs stay up
    return res.status(403).json({ ok: false, error: 'This terminal is not allowed to connect.', terminal_status: TERMINAL.status });
  }
  if (req.path === '/admin.html') return res.status(403).send(terminalBlockedPage(TERMINAL.status));
  next();
});

// Tiny request logger
app.use((req, _res, next) => {
  if (req.url.startsWith('/api/')) {
    console.log(`${new Date().toISOString()}  ${req.method}  ${req.url}`);
  }
  next();
});

// =============================================================================
//  STATIC FILES — serve admin.html, account.html, *.webp / *.jpg product
//  images, and uploaded photos. Without these, /admin.html falls through to
//  the SPA catch-all and gets served as index.html, and product images
//  return the HTML shell instead of binary data.
// =============================================================================
// ---- PRIVATE FILE GUARD ----------------------------------------------------
// express.static(__dirname) below serves EVERY file sitting in this folder. On
// a single laptop reachable only from localhost that was survivable; on a shop
// LAN -- and in the portable build, where this same folder also holds the
// launcher, its logs and (optionally) the bundled Postgres data directory --
// it means http://<this-pc>:3040/db-config.json hands the Postgres password to
// anyone who asks for it, and /server.js hands over the whole backend source.
// Deny the sensitive + executable set before express.static ever sees the
// request. Dotfiles (.env) are already skipped by express.static's default
// dotfiles:'ignore', but they're listed here too so the whole rule reads in
// one place. /api/* is exempt: those routes have their own auth guards and
// some of them legitimately end in .json-looking paths.
const PRIVATE_FILE_RE =
  /(^|\/)(\.env.*|db-config\.json|server-config\.json|machine-config\.json|terminal-id\.json|portable\.json|package(-lock)?\.json|[^\/]*\.(js|mjs|cjs|sql|csv|bat|cmd|ps1|vbs|log|md))$/i;
const PRIVATE_DIR_RE = /^\/(node_modules|migrations|logs|runtime|pgdata|scripts|functions)(\/|$)/i;
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  if (PRIVATE_DIR_RE.test(req.path) || PRIVATE_FILE_RE.test(req.path)) {
    return res.status(404).type('text/plain').send('Not found');
  }
  next();
});

app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d', fallthrough: true }));
app.use(express.static(__dirname, {
  index: false,                 // don't auto-serve index.html — the GET '/' below handles that
  extensions: ['html'],         // /admin → /admin.html
  maxAge: '1h',
  fallthrough: true,
  // The blanket 1h maxAge above is fine (good, even) for product photos and
  // other assets that rarely change -- but it also caught admin.html,
  // index.html, and every other page shell for a full hour. On an actively-
  // edited admin/POS panel that meant a staff member's browser could keep
  // serving yesterday's JS for up to an hour after a fix shipped, with a
  // plain reload not necessarily re-fetching (this is exactly what made a
  // real, already-fixed bug look unfixed: reported here as "payment options
  // did not show on checkout" -- the served file was verified correct, the
  // browser just hadn't re-fetched it). HTML entry points get 'no-cache'
  // instead: the browser still gets ETag/Last-Modified revalidation (a cheap
  // 304 when nothing changed), but it's required to check on every load
  // rather than trusting a stale copy for up to an hour.
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId)
    return res.status(401).json({ error: 'Sign in required' });
  next();
}

async function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId)
    return res.status(401).json({ error: 'Sign in required' });
  const { rows } = await query(
    'SELECT is_admin, disabled FROM users WHERE id = $1',
    [req.session.userId]
  );
  if (rows.length && rows[0].disabled) {
    req.session = null;
    return res.status(403).json({ error: 'This account has been disabled.' });
  }
  if (!rows.length || !rows[0].is_admin)
    return res.status(403).json({ error: 'Admin access required' });
  next();
}

// Stricter than requireAdmin: owner/manager only, not cashier. Use this on
// endpoints a counter cashier shouldn't reach -- staff/supplier/pricing
// management, purchase orders, coupons, marketing, voids, and anything that
// changes who has admin access at all. requireAdmin still gates whether an
// account can reach the admin panel in the first place; this gates what it
// can do once inside.
async function requireManager(req, res, next) {
  if (!req.session || !req.session.userId)
    return res.status(401).json({ error: 'Sign in required' });
  const { rows } = await query(
    'SELECT is_admin, admin_role, disabled FROM users WHERE id = $1',
    [req.session.userId]
  );
  if (rows.length && rows[0].disabled) {
    req.session = null;
    return res.status(403).json({ error: 'This account has been disabled.' });
  }
  if (!rows.length || !rows[0].is_admin)
    return res.status(403).json({ error: 'Admin access required' });
  if (!(await roleCanManage(rows[0].admin_role)))
    return res.status(403).json({ error: 'Manager access required for this action' });
  next();
}

// Which roles clear the requireManager bar is data now, not a literal.
//
// 'owner' is answered without consulting the table at all. This gate protects
// the screen that edits the table, so a role row that is wrong -- cleared by
// accident, or deleted -- would otherwise lock every remaining person out of
// the only place it could be put right. The owner is the way back in.
async function roleExists(code) {
  if (!code) return false;
  const { rows } = await query('SELECT 1 FROM roles WHERE code = $1', [code]);
  return rows.length > 0;
}

async function roleCanManage(code) {
  if (code === 'owner') return true;
  if (!code) return false;
  const { rows } = await query('SELECT can_manage FROM roles WHERE code = $1', [code]);
  // A role that no longer exists grants nothing rather than everything.
  return rows.length ? !!rows[0].can_manage : false;
}

function publicUser(row) {
  if (!row) return null;
  return { id: row.id, email: row.email, name: row.name, is_admin: !!row.is_admin, admin_role: row.admin_role || null };
}

// =============================================================================
//  PER-USER CAPABILITIES
//
//  The single source of truth for what a "function permission" is. The admin
//  UI builds its toggle list from GET /api/admin/capabilities; the enforcement
//  points below call userCan(req, 'key'). Deny-list: a cap is allowed unless
//  users.perms says {"key": false}, and users on a can_manage role are never
//  restricted (userCan short-circuits true).
// =============================================================================
const CAPABILITIES = [
  { key: 'pos.access',            group: 'POS',        label: 'Open the POS terminal' },
  { key: 'pos.line_discount',     group: 'POS',        label: 'Give a per-line discount' },
  { key: 'pos.ticket_discount',   group: 'POS',        label: 'Give a whole-ticket discount' },
  { key: 'pos.price_override',    group: 'POS',        label: 'Change a line’s unit price' },
  { key: 'pos.qty_update',        group: 'POS',        label: 'Change a line’s quantity' },
  { key: 'pos.charge_to_account', group: 'POS',        label: 'Take a charge / account sale' },
  { key: 'pos.no_tax',            group: 'POS',        label: 'Switch GCT off on a ticket' },
  { key: 'pos.add_customer',      group: 'POS',        label: 'Add a new customer' },
  { key: 'pos.edit_customer',     group: 'POS',        label: 'Edit customer details' },
  { key: 'pos.void_sale',         group: 'POS',        label: 'Void a sale' },
  { key: 'pos.refund',            group: 'POS',        label: 'Process a return / refund' },
  { key: 'pos.hold_recall',       group: 'POS',        label: 'Hold and recall tickets' },
  { key: 'pos.open_close_shift',  group: 'POS',        label: 'Open / close a cash-drawer shift' },
  { key: 'pos.reprint_receipt',   group: 'POS',        label: 'Reprint a receipt' },
  { key: 'inventory.edit_price',  group: 'Inventory',  label: 'Edit a product price' },
  { key: 'inventory.adjust_stock',group: 'Inventory',  label: 'Adjust stock counts' },
  { key: 'customers.view_balances',group: 'Customers', label: 'See customer account balances' },
  { key: 'reports.view',          group: 'Reports',    label: 'View reports' },
];
const CAPABILITY_KEYS = new Set(CAPABILITIES.map((c) => c.key));

// Resolve a user's effective capability map across all three layers:
//   role.can_manage -> full access (nothing below applies)
//   else per cap:    allowed, minus any active category deny, then the
//                    user's own {true = re-grant / false = deny} override.
async function userPermState(userId) {
  const { rows } = await query('SELECT admin_role, perms FROM users WHERE id = $1', [userId]);
  if (!rows.length) return { full: false, perms: {} };
  const full = await roleCanManage(rows[0].admin_role);
  const userOv = (rows[0].perms && typeof rows[0].perms === 'object') ? rows[0].perms : {};

  // Denies inherited from the staff member's active categories.
  const catDeny = {};
  if (!full) {
    const { rows: cr } = await query(
      `SELECT c.perms FROM user_category_members m
         JOIN user_categories c ON c.id = m.category_id AND c.is_active = true
        WHERE m.user_id = $1`, [userId]);
    for (const row of cr) {
      const p = (row.perms && typeof row.perms === 'object') ? row.perms : {};
      for (const [k, v] of Object.entries(p)) if (v === false) catDeny[k] = true;
    }
  }

  const perms = {};
  for (const c of CAPABILITIES) {
    if (full) { perms[c.key] = true; continue; }
    let allowed = !catDeny[c.key];
    if (userOv[c.key] === true) allowed = true;
    if (userOv[c.key] === false) allowed = false;
    perms[c.key] = allowed;
  }
  return { full, perms, cat_denies: Object.keys(catDeny) };
}

// Enforcement helper. `req` must carry an authenticated session.
async function userCan(req, cap) {
  if (!req.session || !req.session.userId) return false;
  const { full, perms } = await userPermState(req.session.userId);
  return full || perms[cap] !== false;
}

// Whole-endpoint gate. For finer checks (a discount only when one is present)
// call userCan() inline instead.
function requireCap(cap) {
  return async function (req, res, next) {
    if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Sign in required' });
    if (await userCan(req, cap)) return next();
    const c = CAPABILITIES.find((x) => x.key === cap);
    return res.status(403).json({ error: 'Your account is not allowed to ' + ((c && c.label.toLowerCase()) || cap) + '.' });
  };
}

// ---- LOYALTY POINTS HELPERS ----------------------------------------------
// Append-only. Earning is idempotent via the uq_points_earn unique index, so
// double-firing this for the same (user, reason, reference) is a safe no-op.
async function addPoints(userId, delta, reason, refId) {
  if (!userId || !delta) return;
  try {
    await query(
      `INSERT INTO points_transactions (user_id, delta, reason, reference_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
      [userId, delta, reason, refId || null]
    );
  } catch (e) {
    console.warn('[points] addPoints failed:', e.message);
  }
}
async function pointsBalance(userId) {
  const { rows } = await query(
    'SELECT balance FROM user_points WHERE user_id = $1',
    [userId]
  );
  return (rows[0] && rows[0].balance) || 0;
}
// 100 points = $5 → $0.05 per point
const POINTS_USD_RATE = 0.05;

// =============================================================================
//  AUTH
// =============================================================================
// Every customer/staff account gets a human-facing account number (staff
// search/quote by this, not the internal numeric id) -- format C-000123,
// same "count + pad" convention as nextReceiptNumber()/nextReturnNumber()
// elsewhere in this file. Not year-scoped like those, since an account
// number should stay the same for as long as the account exists.
// Highest-issued + 1, not count + 1. Counting assumes the numbers are a
// contiguous run with nothing ever removed, and the moment that stops being
// true -- one customer deleted, one number issued out of band -- the count
// points back at a number already in use and the next signup dies on
// users_account_number_key. Same defect that broke the schema.sql backfill;
// fixing one without the other would just move the collision.
async function nextAccountNumber() {
  const { rows } = await query(
    `SELECT COALESCE(MAX(substring(account_number from 3)::bigint), 0) AS n
       FROM users
      WHERE account_number ~ '^C-[0-9]+$'`
  );
  // MAX() over bigint comes back as a string from pg; Number() it before
  // adding, or this returns "C-01" style nonsense from string concatenation.
  return `C-${String(Number(rows[0].n) + 1).padStart(6, '0')}`;
}

// Cached after the first lookup -- this row's id never changes once seeded,
// so there's no reason to hit the DB for it on every single sale.
let walkinCustomerIdCache = null;
async function getWalkinCustomerId() {
  if (walkinCustomerIdCache !== null) return walkinCustomerIdCache;
  const { rows } = await query(`SELECT id FROM users WHERE email = 'walkin@melthahonda.local' LIMIT 1`);
  walkinCustomerIdCache = rows.length ? rows[0].id : -1;
  return walkinCustomerIdCache;
}

// A customer's real current balance: every dollar ever charged to 'account'
// (non-voided sales) minus every payment recorded against it in
// account_payments. Shared by the credit-limit check in POST
// /api/admin/pos/sale, the customer profile, and the settle-balance
// endpoints below so none of them can disagree about what's owed.
// `exec` lets a caller inside a transaction pass its client instead of the
// module-level pool (same (sql, params) => {rows} shape either way).
async function getAccountBalance(customerId, exec) {
  const run = exec || query;
  const { rows } = await run(
    `SELECT
        COALESCE((SELECT SUM(sp.amount_usd) FROM sale_payments sp JOIN pos_sales s ON s.id = sp.sale_id
                   WHERE sp.method = 'account' AND s.customer_id = $1 AND s.voided = false), 0)
      - COALESCE((SELECT SUM(amount_usd) FROM account_payments WHERE customer_id = $1), 0) AS balance`,
    [customerId]
  );
  return Number(rows[0].balance) || 0;
}

// Single source of truth for company info -- used to be three independent
// hardcoded copies (quotes/:id, /api/pickslip, the work-order-invoice
// endpoint) plus a fourth on the client (admin.html's POS_SHOP), none of
// which agreed on every field. Not cached: this is an admin-editable
// setting, not a boot-time constant, and it's read rarely enough (a print
// or a settings-page load) that a stale cache isn't worth the risk of an
// owner's saved change not showing up.
async function getShopSettings() {
  const { rows } = await query('SELECT * FROM shop_settings ORDER BY id LIMIT 1');
  if (rows.length) return rows[0];
  // Table not migrated yet on this DB (shouldn't happen once schema.sql has
  // run, but a null-safe fallback here beats a 500 on every print in the
  // meantime) -- mirrors the old hardcoded values so nothing looks different
  // until the table exists.
  return {
    company_name: 'Meltha Honda Sales & Servs Ltd', address: '127 Hagley Park Road, Kingston 11',
    country: 'Jamaica', phone: '(876) 758-8503', email: null, website: null, logo_url: null,
    print_logo_on_invoice: true, default_print_template: 'receipt', quote_valid_days: 14,
    invoice_notice: 'Goods remain the property of the company until paid in full. Returns accepted within 14 days with the original invoice, in original condition. Electrical parts are non-returnable.',
    receipt_notice: 'Returns within 14 days with this receipt. Electrical parts non-returnable.',
    statement_notice: 'Please settle any outstanding balance promptly. Contact us with any questions about this statement.',
  };
}
// Maps a shop_settings row onto the {name, address, ...} shape every print-
// document builder in admin.html already expects (name, not company_name --
// that shape predates this table and touching every call site's field name
// wasn't worth it for a rename).
function shopSettingsToShop(s) {
  return {
    name: s.company_name, address: s.address, country: s.country, phone: s.phone,
    email: s.email, website: s.website, logo_url: s.logo_url,
    print_logo: !!s.print_logo_on_invoice,
    default_print_template: s.default_print_template,
    invoice_notice: s.invoice_notice, receipt_notice: s.receipt_notice, statement_notice: s.statement_notice,
  };
}

// =============================================================================
//  SHOP SETTINGS -- company info, logo, print defaults, quote validity,
//  invoice/receipt/statement notice text. Read by any signed-in staff
//  account (every POS print needs it); changed only by a manager/owner --
//  same tier as the other financial/business-config actions in this file
//  (accepting an account payment, voiding a sale).
// =============================================================================
app.get('/api/admin/settings', requireAdmin, async (req, res) => {
  res.json({ settings: await getShopSettings() });
});

app.patch('/api/admin/settings', requireManager, async (req, res) => {
  const fields = ['company_name', 'address', 'country', 'phone', 'email', 'website',
    'print_logo_on_invoice', 'default_print_template', 'quote_valid_days',
    'invoice_notice', 'receipt_notice', 'statement_notice'];
  const sets = []; const vals = [];
  for (const f of fields) if (req.body && req.body[f] !== undefined) { sets.push(`${f} = $${sets.length + 1}`); vals.push(req.body[f]); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  sets.push('updated_at = NOW()');
  const { rows } = await query('SELECT id FROM shop_settings ORDER BY id LIMIT 1');
  if (!rows.length) {
    // Table exists (schema.sql seeds it) but defensively handle a DB that
    // somehow has no row yet rather than silently updating zero rows.
    await query('INSERT INTO shop_settings (id) VALUES (1)');
    rows.push({ id: 1 });
  }
  vals.push(rows[0].id);
  await query(`UPDATE shop_settings SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
  res.json({ ok: true, settings: await getShopSettings() });
});

app.post('/api/admin/settings/logo', requireManager, upload.single('logo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'logo file required' });
  const logoDir = path.join(UPLOAD_DIR, 'logo');
  fs.mkdirSync(logoDir, { recursive: true });
  const destPath = path.join(logoDir, req.file.filename);
  try { fs.renameSync(req.file.path, destPath); } catch (_) {}
  const logoUrl = '/uploads/logo/' + req.file.filename;
  const { rows } = await query('SELECT id FROM shop_settings ORDER BY id LIMIT 1');
  if (!rows.length) await query('INSERT INTO shop_settings (id, logo_url) VALUES (1, $1)', [logoUrl]);
  else await query('UPDATE shop_settings SET logo_url = $1, updated_at = NOW() WHERE id = $2', [logoUrl, rows[0].id]);
  res.json({ ok: true, logo_url: logoUrl });
});

// =============================================================================
//  DATABASE SETTINGS -- local (admin/POS, always) + online (public storefront
//  fallback only) connection config. Lives in db-config.json, not a DB table
//  -- can't store "which database to use" inside the database you're trying
//  to decide whether to use. See the big comment on the pool setup near the
//  top of this file for the local-always / online-fallback-for-reads-only
//  reasoning. Manager/owner only -- this is more sensitive than the rest of
//  Setup (it's credentials for a second database, not just business info).
// =============================================================================
function maskDbConfig(cfg) {
  function mask(c) {
    if (!c) return null;
    return { host: c.host || '', port: c.port || 5432, database: c.database || '', user: c.user || '', has_password: !!c.password };
  }
  return { local: mask(cfg.local), online: mask(cfg.online) };
}
app.get('/api/admin/settings/database', requireManager, async (req, res) => {
  res.json(Object.assign({ ok: true }, maskDbConfig(loadDbConfig()), {
    online_active: !!onlinePool,
  }));
});

app.post('/api/admin/settings/database/test', requireManager, async (req, res) => {
  const b = req.body || {};
  const result = await testDbConnection({ host: b.host, port: b.port, database: b.database, user: b.user, password: b.password });
  res.json(result);
});

app.patch('/api/admin/settings/database', requireManager, async (req, res) => {
  const b = req.body || {};
  const existing = loadDbConfig();
  // A blank/omitted password on save means "keep what's already stored" --
  // otherwise every save that only touched, say, the host would silently
  // wipe the password and break the connection until it's retyped.
  function merge(existingSide, incoming) {
    if (!incoming || !incoming.host) return null;
    return {
      host: incoming.host, port: incoming.port || 5432, database: incoming.database || '', user: incoming.user || '',
      password: (incoming.password !== undefined && incoming.password !== '')
        ? incoming.password
        : ((existingSide && existingSide.password) || ''),
    };
  }
  const next = { local: merge(existing.local, b.local), online: merge(existing.online, b.online) };
  saveDbConfig(next);
  applyDbConfig(next);
  res.json(Object.assign({ ok: true }, maskDbConfig(next), { online_active: !!onlinePool }));
});

// =============================================================================
//  DATABASE SERVER -- status, one-click "create the app database" (a single
//  known-safe SQL statement against an *already-reachable* Postgres), and an
//  actual "install PostgreSQL for me" action. That last one is a deliberate,
//  higher-risk feature the owner explicitly asked for after being shown the
//  trade-off (a web panel that can trigger a system-level installer is a
//  meaningfully bigger attack surface than the rest of this app, especially
//  since this panel is reachable through the Cloudflare tunnel) -- kept as
//  narrow as it can be while still doing that: no shell, no string-built
//  command, no request-body input reaches the child process at all. It runs
//  exactly one fixed executable with one fixed argument list, nothing else,
//  ever. Manager/owner only, logged with who/when on every trigger.
// =============================================================================
let dbServerInstall = { running: false, ok: null, error: null, startedAt: null, finishedAt: null };

app.get('/api/admin/settings/db-server-status', requireManager, async (req, res) => {
  const cfg = loadDbConfig();
  const localCfg = buildPoolConfig(cfg.local) || { host: 'localhost', port: 5432, user: 'postgres', password: process.env.PGPASSWORD || 'postgres' };
  const dbName = (localCfg.database || 'melthahonda');
  let reachable = false, dbExists = false, error = null;
  // Connect to the always-present `postgres` maintenance database, not the
  // app's own -- that's the one thing guaranteed to exist on any running
  // Postgres server, so this can tell "server not reachable at all" apart
  // from "server's fine, our database just isn't created yet".
  const probe = new Pool(Object.assign({}, localCfg, { database: 'postgres', max: 1, connectionTimeoutMillis: 4000 }));
  try {
    const r = await probe.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    reachable = true;
    dbExists = r.rows.length > 0;
  } catch (e) {
    error = e.message;
  } finally {
    probe.end().catch(() => {});
  }
  res.json({ reachable, db_exists: dbExists, db_name: dbName, error, platform: process.platform, install: dbServerInstall });
});

app.post('/api/admin/settings/db-server/create-database', requireManager, async (req, res) => {
  const cfg = loadDbConfig();
  const localCfg = buildPoolConfig(cfg.local) || { host: 'localhost', port: 5432, user: 'postgres', password: process.env.PGPASSWORD || 'postgres' };
  // Identifier, not a value -- can't be parameterized. Whitelisted to
  // word characters only before it ever touches the query string.
  const dbName = (localCfg.database || 'melthahonda').replace(/[^a-zA-Z0-9_]/g, '');
  if (!dbName) return res.status(400).json({ ok: false, error: 'No database name configured' });
  const admin = new Pool(Object.assign({}, localCfg, { database: 'postgres', max: 1, connectionTimeoutMillis: 5000 }));
  try {
    await admin.query('CREATE DATABASE "' + dbName + '"');
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  } finally {
    admin.end().catch(() => {});
  }
});

app.post('/api/admin/settings/db-server/install', requireManager, async (req, res) => {
  if (dbServerInstall.running) return res.status(409).json({ ok: false, error: 'An install is already running.' });
  if (process.platform !== 'win32') {
    return res.status(400).json({ ok: false, error: 'Automatic install is only wired up for Windows in this build. Install PostgreSQL for your OS manually, then use "Test connection" above.' });
  }
  console.warn(`[db-install] PostgreSQL install triggered by user id ${req.session.userId} at ${new Date().toISOString()}`);
  dbServerInstall = { running: true, ok: null, error: null, startedAt: new Date().toISOString(), finishedAt: null };
  // Fixed executable, fixed args, nothing from the request reaches this --
  // see the section comment above. winget is Windows's built-in package
  // manager (Windows 10 2004+/11); a per-machine MSI install like this
  // normally needs elevation, which a non-elevated Node process can't grant
  // itself -- winget will either prompt for UAC on the server's own screen
  // or fail with a clear permissions error, surfaced below either way.
  execFile('winget', [
    'install', '-e', '--id', 'PostgreSQL.PostgreSQL',
    '--accept-package-agreements', '--accept-source-agreements', '--silent',
  ], { timeout: 15 * 60 * 1000 }, (err, stdout, stderr) => {
    dbServerInstall = {
      running: false,
      ok: !err,
      error: err ? ((stderr || '').trim() || err.message) : null,
      startedAt: dbServerInstall.startedAt,
      finishedAt: new Date().toISOString(),
    };
    console.warn('[db-install] finished:', dbServerInstall.ok ? 'ok' : dbServerInstall.error);
  });
  res.json({ ok: true, message: 'Install started -- this can take several minutes. If Windows shows a UAC prompt, it needs approving on the server machine itself; check status below.' });
});

// =============================================================================
//  SERVER CONNECTION -- the app server's own listening port. See the big
//  comment on SERVER_CONFIG_PATH near the top of this file for why this
//  can't hot-swap the way the database pools do.
// =============================================================================
app.get('/api/admin/settings/server', requireManager, async (req, res) => {
  const cfg = loadServerConfig();
  res.json({ ok: true, running_port: PORT, configured_port: cfg.port || null, restart_required: !!cfg.port && cfg.port !== PORT });
});

app.patch('/api/admin/settings/server', requireManager, async (req, res) => {
  const port = parseInt((req.body || {}).port, 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    return res.status(400).json({ ok: false, error: 'Port must be a number between 1 and 65535.' });
  }
  saveServerConfig({ port });
  res.json({ ok: true, running_port: PORT, configured_port: port, restart_required: port !== PORT });
});

// =============================================================================
//  THIS MACHINE -- identity + local/LAN server recognition (see the big
//  comment near MACHINE_CONFIG_PATH/DISCOVERY_PORT above the pool setup for
//  how detection and discovery actually work). Read-only for any signed-in
//  staff account, same as the rest of what the POS Terminal bar needs to
//  show -- renaming this machine is a Setup/manager action like the rest of
//  this file's settings writes.
// =============================================================================
app.get('/api/admin/settings/machine', requireAdmin, async (req, res) => {
  res.json({ ok: true, name: machineName(), host: primaryLocalIPv4(), port: PORT, local_db: LOCAL_SERVER_STATUS });
});

app.patch('/api/admin/settings/machine', requireManager, async (req, res) => {
  const name = ((req.body || {}).name || '').trim();
  MACHINE_CFG = { name };
  saveMachineConfig(MACHINE_CFG);
  res.json({ ok: true, name: machineName() });
});

app.get('/api/admin/settings/network-servers', requireAdmin, async (req, res) => {
  res.json({ ok: true, servers: seenServersList() });
});

app.post('/api/admin/settings/network-servers/scan', requireAdmin, async (req, res) => {
  sendDiscoveryQuery();
  // Give replies (and anyone who just heard the query and announces back)
  // a moment to arrive before answering -- this is a LAN round trip, not a
  // real request, so a short fixed wait is fine rather than open-ended.
  await new Promise((r) => setTimeout(r, 1500));
  res.json({ ok: true, servers: seenServersList() });
});

// =============================================================================
//  TERMINALS -- monitor, allow, block, terminate. Manager/owner only: deciding
//  which machines may run the shop's system is not a cashier's call.
// =============================================================================
app.get('/api/admin/terminals', requireManager, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT t.*, u.name AS approved_by_name,
              (NOW() - t.last_seen < INTERVAL '45 seconds') AS online
         FROM terminals t
         LEFT JOIN users u ON u.id = t.approved_by
        ORDER BY t.is_db_host DESC, t.last_seen DESC`
    );
    res.json({
      ok: true,
      terminals: rows,
      mode: await getAccessMode(),
      this_terminal_id: TERMINAL.id,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, terminals: [], mode: 'approve' });
  }
});

app.patch('/api/admin/terminals/mode', requireManager, async (req, res) => {
  const mode = (req.body || {}).mode === 'open' ? 'open' : 'approve';
  try {
    await query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('terminal_access_mode', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [mode]);
    // Switching to open is a decision about everything already waiting, not
    // just about machines that turn up later -- leaving a queue of pending
    // tills sitting there after "allow everything" would read as a bug.
    if (mode === 'open') await query("UPDATE terminals SET status='approved', approved_at=NOW() WHERE status='pending'");
    res.json({ ok: true, mode });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Pre-register a machine by name so it is approved before it first connects.
// terminal_uid stays NULL until the real machine turns up and adopts the row.
app.post('/api/admin/terminals', requireManager, async (req, res) => {
  const name = String(((req.body || {}).name) || '').trim();
  if (!name) return res.status(400).json({ ok: false, error: 'A machine name is required.' });
  try {
    const dupe = await query('SELECT 1 FROM terminals WHERE lower(name) = lower($1)', [name]);
    if (dupe.rows.length) return res.status(409).json({ ok: false, error: 'A terminal with that name already exists.' });
    const { rows } = await query(
      `INSERT INTO terminals (name, status, note, approved_at, approved_by)
       VALUES ($1, 'approved', $2, NOW(), $3) RETURNING *`,
      [name, String(((req.body || {}).note) || '').trim() || null, req.session.userId]);
    res.json({ ok: true, terminal: rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.patch('/api/admin/terminals/:id', requireManager, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'Bad id.' });
  try {
    const cur = await query('SELECT * FROM terminals WHERE id = $1', [id]);
    if (!cur.rows.length) return res.status(404).json({ ok: false, error: 'No such terminal.' });
    const row = cur.rows[0];

    if (b.status !== undefined) {
      const status = ['pending', 'approved', 'blocked'].indexOf(b.status) !== -1 ? b.status : null;
      if (!status) return res.status(400).json({ ok: false, error: 'status must be pending, approved or blocked.' });
      // Refusing this is the difference between a mistake and an unrecoverable
      // one: block the database host and nothing anywhere can approve it back.
      if (row.is_db_host && status !== 'approved') {
        return res.status(400).json({ ok: false, error: 'This machine holds the database — blocking it would lock everyone out, including this screen.' });
      }
      await query(
        `UPDATE terminals SET status=$2,
                approved_at = CASE WHEN $2='approved' THEN NOW() ELSE approved_at END,
                approved_by = CASE WHEN $2='approved' THEN $3 ELSE approved_by END,
                blocked_at  = CASE WHEN $2='blocked'  THEN NOW() ELSE NULL END
         WHERE id=$1`, [id, status, req.session.userId]);
      // The part PostgreSQL enforces. Without this, blocking only asks the
      // till's own software to stop while its credentials still work.
      if (row.db_role) await setTerminalRoleLogin(row.db_role, status === 'approved');
    }
    if (b.name !== undefined)  await query('UPDATE terminals SET name=$2 WHERE id=$1', [id, String(b.name).trim() || null]);
    if (b.note !== undefined)  await query('UPDATE terminals SET note=$2 WHERE id=$1', [id, String(b.note).trim() || null]);

    const out = await query('SELECT * FROM terminals WHERE id = $1', [id]);
    res.json({ ok: true, terminal: out.rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Signs everyone out on that machine within a heartbeat. Deliberately does NOT
// stop the process: a terminated till that is later re-approved comes straight
// back without anyone walking over to restart it.
app.post('/api/admin/terminals/:id/terminate', requireManager, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'Bad id.' });
  try {
    const cur = await query('SELECT * FROM terminals WHERE id = $1', [id]);
    if (!cur.rows.length) return res.status(404).json({ ok: false, error: 'No such terminal.' });
    await query('UPDATE terminals SET terminate_requested_at = NOW() WHERE id = $1', [id]);
    if (cur.rows[0].id === TERMINAL.id) { SESSION_EPOCH = Date.now(); LAST_TERMINATE_HANDLED = new Date(); }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete('/api/admin/terminals/:id', requireManager, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'Bad id.' });
  try {
    const cur = await query('SELECT is_db_host, db_role FROM terminals WHERE id = $1', [id]);
    if (cur.rows.length && cur.rows[0].is_db_host) {
      return res.status(400).json({ ok: false, error: 'The database host cannot be removed.' });
    }
    // Drop the login role too, or forgetting a machine would leave working
    // credentials behind on it with no row left to show they exist.
    if (cur.rows.length && cur.rows[0].db_role) await dropTerminalRole(cur.rows[0].db_role);
    await query('DELETE FROM terminals WHERE id = $1', [id]);
    // Forgetting a machine that is still switched on only re-registers it on
    // its next heartbeat -- as pending, which is the point.
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =============================================================================
//  TERMINAL ENROLMENT LINKS
//
//  The link contains a random token and nothing else. Encrypting a link that
//  carried the credentials would be theatre: the client has to be able to
//  decrypt it to use it, so the key would have to travel with it or live in
//  the package. A token that is single-use, expiring and server-validated is
//  strictly stronger, because a copy of it is worthless the moment it is
//  redeemed. See schema.sql for the storage rationale.
// =============================================================================
const nodeCrypto = require('crypto');
const ENROL_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 -- these get read aloud and copied by hand
function newEnrolToken() {
  const bytes = nodeCrypto.randomBytes(20);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += ENROL_ALPHABET[bytes[i] % ENROL_ALPHABET.length];
  return out;                                    // 20 chars over a 32-char alphabet = 100 bits
}
function hashEnrolToken(tok) {
  return nodeCrypto.createHash('sha256').update(String(tok).trim().toUpperCase().replace(/-/g, '')).digest('hex');
}
function formatEnrolToken(tok) {
  return String(tok).replace(/(.{4})/g, '$1-').replace(/-$/, '');
}

// What the server is ACTUALLY connected with, which is not always what is in
// db-config.json. The portable package writes that file, but a plain
// `npm start` install is configured entirely through DATABASE_URL in .env (see
// BACKEND-README.md) -- and reading only db-config.json there yields an empty
// object, so enrolment would silently hand every till port 5432 and a blank
// password. Prefer the file, fall back to parsing the URL.
function effectiveLocalDbSettings() {
  const local = (loadDbConfig().local) || {};
  if (local.host) {
    return {
      port: parseInt(local.port, 10) || 5432,
      database: local.database || 'melthahonda',
      user: local.user || 'postgres',
      password: local.password || '',
    };
  }
  try {
    const u = new URL(process.env.DATABASE_URL || '');
    return {
      port: parseInt(u.port, 10) || 5432,
      database: decodeURIComponent((u.pathname || '/melthahonda').replace(/^\//, '')) || 'melthahonda',
      user: decodeURIComponent(u.username || 'postgres'),
      password: decodeURIComponent(u.password || ''),
    };
  } catch (_) {
    return { port: 5432, database: 'melthahonda', user: 'postgres', password: '' };
  }
}

// ---- per-terminal database roles -------------------------------------------
// Identifier, never a value, so it can't be parameterised -- built only from
// hex out of a uuid and quoted with %I at the call site. Length-capped because
// PostgreSQL truncates identifiers at 63 bytes and a silent truncation would
// let two terminals collide on one role.
function terminalRoleName(uid) {
  const clean = String(uid).replace(/[^a-zA-Z0-9]/g, '').toLowerCase().slice(0, 24);
  return 'mh_term_' + (clean || nodeCrypto.randomBytes(8).toString('hex'));
}
function newRolePassword() {
  // base64url: no quote, backslash, colon or slash, so it needs no escaping in
  // a connection string, a JSON config file or a shell command line.
  return nodeCrypto.randomBytes(24).toString('base64url');
}

// CREATE ROLE / ALTER ROLE take an identifier and a literal, neither of which
// can be a bind parameter, and a DO block cannot take parameters either. Both
// values here are generated by this file from a fixed alphabet, so they cannot
// carry anything hostile -- these quote them anyway, so the safety does not
// depend on that staying true.
function quoteIdent(s) { return '"' + String(s).replace(/"/g, '""') + '"'; }
function quoteLit(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }

// Creates (or re-passwords) the login role for one terminal. Returns null if
// this database user cannot manage roles -- a managed Postgres, or a hardened
// install -- in which case enrolment falls back to the shared credentials and
// says so, rather than failing outright.
async function ensureTerminalRole(uid) {
  const role = terminalRoleName(uid);
  const password = newRolePassword();
  try {
    const exists = await query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
    if (exists.rows.length) {
      // Re-enrolling rotates the password, which also kills the credentials on
      // whatever machine held them before -- the point of re-issuing a link.
      await query('ALTER ROLE ' + quoteIdent(role) + ' LOGIN PASSWORD ' + quoteLit(password));
      await query('GRANT mh_terminal TO ' + quoteIdent(role));
    } else {
      await query('CREATE ROLE ' + quoteIdent(role) + ' LOGIN PASSWORD ' + quoteLit(password) + ' IN ROLE mh_terminal');
    }
    return { role, password };
  } catch (e) {
    console.warn('[enrol] could not create a per-terminal role (' + (e.code || '') + ' ' + (e.message || '') + ')');
    return null;
  }
}

// Blocking a terminal takes its LOGIN away, so PostgreSQL refuses the
// connection itself rather than relying on that machine's own software to
// co-operate. Allowing it again puts LOGIN back.
async function setTerminalRoleLogin(role, canLogin) {
  if (!role) return false;
  try {
    await query('ALTER ROLE ' + quoteIdent(role) + (canLogin ? ' LOGIN' : ' NOLOGIN'));
    console.log('[terminal] role ' + role + ' -> ' + (canLogin ? 'LOGIN' : 'NOLOGIN'));
    return true;
  } catch (e) {
    console.warn('[terminal] could not change role ' + role + ': ' + (e.message || ''));
    return false;
  }
}

async function dropTerminalRole(role) {
  if (!role) return;
  try {
    // A terminal role owns nothing -- it has never been able to create
    // anything -- so there is no REASSIGN OWNED step to do first.
    await query('DROP ROLE IF EXISTS ' + quoteIdent(role));
    console.log('[terminal] dropped role ' + role);
  } catch (e) {
    console.warn('[terminal] could not drop role ' + role + ': ' + (e.message || ''));
  }
}

// Brute force against 100 bits is not a threat; this exists so a broken script
// pointed at the endpoint cannot fill the logs or hammer the database.
const ENROL_ATTEMPTS = new Map();
function enrolRateLimited(ip) {
  const now = Date.now();
  const rec = ENROL_ATTEMPTS.get(ip) || { n: 0, reset: now + 60000 };
  if (now > rec.reset) { rec.n = 0; rec.reset = now + 60000; }
  rec.n += 1;
  ENROL_ATTEMPTS.set(ip, rec);
  if (ENROL_ATTEMPTS.size > 500) ENROL_ATTEMPTS.clear();   // crude, bounded
  return rec.n > 20;
}

app.post('/api/admin/terminals/enrol-link', requireManager, async (req, res) => {
  // Only the machine holding the database hands out access to it. A till has
  // the credentials too, but letting every till mint enrolments turns one
  // compromised counter PC into a way to enrol the whole street.
  if (!TERMINAL.is_db_host) {
    return res.status(400).json({ ok: false, error: 'Connection links can only be created on the machine that holds the database.' });
  }
  const minutes = Math.min(1440, Math.max(5, parseInt((req.body || {}).minutes, 10) || 30));
  const label = String(((req.body || {}).label) || '').trim() || null;
  const token = newEnrolToken();
  try {
    const { rows } = await query(
      `INSERT INTO terminal_enrolments (token_hash, label, created_by, expires_at)
       VALUES ($1,$2,$3, NOW() + ($4 || ' minutes')::interval) RETURNING id, expires_at`,
      [hashEnrolToken(token), label, req.session.userId, String(minutes)]
    );
    const host = primaryLocalIPv4();
    // The token rides in the fragment so it never reaches a server log or a
    // proxy: fragments are not sent with the request.
    res.json({
      ok: true,
      id: rows[0].id,
      link: 'http://' + host + ':' + PORT + '/join#' + token,
      code: formatEnrolToken(token),          // shown once, never recoverable
      host, port: PORT,
      expires_at: rows[0].expires_at,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/admin/terminals/enrol-links', requireManager, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT e.id, e.label, e.created_at, e.expires_at, e.used_at, e.used_by_uid, e.used_from_ip, e.revoked_at,
              u.name AS created_by_name,
              (e.used_at IS NULL AND e.revoked_at IS NULL AND e.expires_at > NOW()) AS active
         FROM terminal_enrolments e LEFT JOIN users u ON u.id = e.created_by
        ORDER BY e.created_at DESC LIMIT 20`);
    res.json({ ok: true, links: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, links: [] });
  }
});

app.delete('/api/admin/terminals/enrol-links/:id', requireManager, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'Bad id.' });
  try {
    await query('UPDATE terminal_enrolments SET revoked_at = NOW() WHERE id = $1 AND used_at IS NULL', [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Unauthenticated ON PURPOSE -- the machine redeeming this has no account yet
// and no credentials; the token IS the authentication. Everything that makes
// that safe is below: single use, short expiry, hashed at rest, rate limited,
// and it only ever discloses this server's own database settings.
app.post('/api/enrol/redeem', async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
  if (enrolRateLimited(ip)) return res.status(429).json({ ok: false, error: 'Too many attempts. Wait a minute and try again.' });
  if (!TERMINAL.is_db_host) return res.status(400).json({ ok: false, error: 'This machine does not hold the database.' });

  const b = req.body || {};
  const token = String(b.token || '').trim();
  const uid = String(b.uid || '').trim();
  const name = String(b.name || '').trim();
  if (!token || !uid) return res.status(400).json({ ok: false, error: 'token and uid are required.' });

  try {
    // Claim atomically: the WHERE clause is the lock. Two machines racing the
    // same link means exactly one UPDATE matches a row and the other gets none,
    // rather than both being handed the credentials.
    const claim = await query(
      `UPDATE terminal_enrolments SET used_at = NOW(), used_by_uid = $2, used_from_ip = $3
        WHERE token_hash = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()
        RETURNING id, label`,
      [hashEnrolToken(token), uid, ip || null]);
    if (!claim.rows.length) {
      console.warn('[enrol] rejected redeem from ' + (ip || 'unknown'));
      return res.status(403).json({ ok: false, error: 'That connection link is not valid — it may have been used already, been revoked, or expired.' });
    }

    // Register the machine as an approved terminal in the same breath: someone
    // holding a valid one-time link has already been authorised by a manager,
    // so making them go and approve it a second time is a step with no meaning.
    const termName = name || claim.rows[0].label || ('Terminal ' + uid.slice(0, 6));

    // Its own login role, so this till never holds the superuser password and
    // blocking it later is enforced by PostgreSQL rather than by its own code.
    const cred = await ensureTerminalRole(uid);

    // The token this till presents when it asks the server to check a password
    // for it. New on every enrolment, so re-issuing a link retires the old one.
    const apiToken = newEnrolToken() + newEnrolToken();       // 200 bits
    await query(
      `INSERT INTO terminals (terminal_uid, name, status, approved_at, note, db_role, api_token_hash)
       VALUES ($1,$2,'approved',NOW(),$3,$4,$5)
       ON CONFLICT (terminal_uid) WHERE terminal_uid IS NOT NULL
       DO UPDATE SET status='approved', approved_at=NOW(), blocked_at=NULL,
                     db_role=EXCLUDED.db_role, api_token_hash=EXCLUDED.api_token_hash`,
      [uid, termName, 'Enrolled via connection link #' + claim.rows[0].id, cred ? cred.role : null,
       hashEnrolToken(apiToken)]);

    const local = effectiveLocalDbSettings();
    if (!local.password) {
      // Handing over a blank password produces a till that fails to connect
      // with an error naming neither cause. Say so here instead.
      console.warn('[enrol] refusing: this server has no database password configured');
      return res.status(500).json({ ok: false, error: 'The server could not determine its own database password. Set it in Admin → Setup → Database, then create a new link.' });
    }
    const dbCert = serverDbCertPem();
    console.log('[enrol] link #' + claim.rows[0].id + ' redeemed by "' + termName + '" from ' + (ip || 'unknown') +
      (cred ? ' as role ' + cred.role : ' with SHARED credentials (no role created)') +
      (dbCert ? ', TLS pinned' : ', NO TLS (no server certificate found)'));
    res.json({
      ok: true,
      name: termName,
      // Falls back to the shared account only when role creation was not
      // possible; the client is told which it got so the operator can see it.
      scoped: !!cred,
      encrypted: !!dbCert,
      database: {
        // Never the configured host: on the server that is "localhost", which
        // means "itself" on the till and would send it looking for a database
        // that is not there.
        host: primaryLocalIPv4(),
        port: local.port,
        database: local.database,
        user: cred ? cred.role : local.user,
        password: cred ? cred.password : local.password,
        // The trust bootstrap. Sending the certificate here is what lets the
        // till verify the server later instead of accepting any certificate it
        // is offered -- which is the whole difference between encrypted and
        // encrypted-and-authenticated.
        sslmode: dbCert ? 'verify-ca' : 'disable',
        ca: dbCert || null,
      },
      // Where to send the things a till is no longer trusted to do locally --
      // currently checking a password, since it can no longer read the hash.
      upstream: { url: 'http://' + primaryLocalIPv4() + ':' + PORT, token: apiToken },
      app_port: PORT,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// A human-friendly landing page for the link. It deliberately does NOT redeem
// anything -- a browser cannot write the till's config file, and a link that
// burned itself simply by being previewed would be a trap.
app.get('/join', (req, res) => {
  res.type('html').send(
    '<!doctype html><meta charset="utf-8"><title>Connect this computer</title>' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1b2b;color:#e6e9ee;' +
    "font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;padding:24px}.c{max-width:560px}" +
    'h1{font-size:20px;margin:0 0 12px}p{color:#94a3b8;font-size:14px;line-height:1.65;margin:0 0 10px}' +
    'code{background:rgba(255,255,255,.1);padding:2px 6px;border-radius:4px;font-size:12.5px}' +
    'b.code{display:block;font-family:ui-monospace,Consolas,monospace;font-size:19px;letter-spacing:2px;' +
    'background:rgba(255,255,255,.1);padding:12px;border-radius:8px;margin:14px 0;text-align:center;word-break:break-all}</style>' +
    '<div class="c"><h1>Connect this computer to the shop</h1>' +
    '<p>On the computer you want to connect, open its Meltha Honda folder and double-click ' +
    '<code>Connect To Shop Server.vbs</code>, then paste this code when it asks:</p>' +
    '<b class="code" id="c">(open the full link, including the part after #)</b>' +
    '<p>This code works <b>once</b> and expires shortly. If it stops working, ask for a new one from ' +
    '<b>Admin → Setup → Terminals &amp; access</b>.</p></div>' +
    '<script>var t=location.hash.slice(1);if(t)document.getElementById("c").textContent=' +
    't.replace(/(.{4})/g,"$1-").replace(/-$/,"");<\/script>'
  );
});

// =============================================================================
//  OFF-SITE BACKUP
//
//  The machine that owns the database ships a full pg_dump to a hosted copy of
//  this same app, on a schedule and/or the next time the internet comes back.
//  Config lives in server-config.json under `backup`:
//    { enabled, url, key, name, every_hours, catch_up, keep,   // this end sends
//      receive_key, receive_keep,                              // this end receives
//      last: { at, ok, bytes, filename, error, network } }
//  The receiver writes files under data/received-backups/<origin>/.
// =============================================================================
const BACKUP_DIR      = path.join(__dirname, '..', 'data', 'backups');
const BACKUP_RECV_DIR = path.join(__dirname, '..', 'data', 'received-backups');
let backupRunning = false;

function loadBackupCfg() { return loadServerConfig().backup || {}; }
function saveBackupCfg(patch) {
  const cfg = loadServerConfig();
  cfg.backup = Object.assign({}, cfg.backup || {}, patch);
  saveServerConfig(cfg);
  return cfg.backup;
}
function backupBin(name) {
  const ext = process.platform === 'win32' ? '.exe' : '';
  const bundled = path.join(__dirname, '..', 'runtime', 'pgsql', 'bin', name + ext);
  return fs.existsSync(bundled) ? bundled : (name + ext);   // else trust PATH
}
function safeName(s, fallback) {
  const clean = String(s == null ? '' : s).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^_+/, '').slice(0, 120);
  return clean || fallback;
}
function backupKeyOk(given, expected) {
  if (!expected || !given) return false;
  const a = Buffer.from(String(given)), b = Buffer.from(String(expected));
  return a.length === b.length && nodeCrypto.timingSafeEqual(a, b);
}
function backupOrigin() {
  return safeName(process.env.MH_BACKUP_ORIGIN || os.hostname() || 'shop', 'shop');
}
async function shopName() {
  try { const { rows } = await query('SELECT company_name FROM shop_settings ORDER BY id LIMIT 1'); return (rows[0] && rows[0].company_name) || 'Meltha Honda'; }
  catch (_) { return 'Meltha Honda'; }
}

// One small JSON call to the receiver (ping / latest).
function backupApi(method, base, pathname, key, jsonBody) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(base.replace(/\/+$/, '') + pathname); } catch (_) { return reject(new Error('Bad backup URL')); }
    const lib = u.protocol === 'https:' ? require('https') : require('http');
    const payload = jsonBody ? Buffer.from(JSON.stringify(jsonBody)) : null;
    const req = lib.request({
      host: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method, timeout: 15000,
      headers: Object.assign({ 'x-backup-key': key || '' },
        payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
    }, (r) => {
      let data = ''; r.on('data', (c) => { data += c; });
      r.on('end', () => { let j = null; try { j = JSON.parse(data); } catch (_) {} resolve({ status: r.statusCode, json: j }); });
    });
    req.on('timeout', () => req.destroy(new Error('The backup server did not answer in time.')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
// Stream a local file to the receiver as the request body.
function backupUpload(base, pathname, key, headers, filePath) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(base.replace(/\/+$/, '') + pathname); } catch (_) { return reject(new Error('Bad backup URL')); }
    const lib = u.protocol === 'https:' ? require('https') : require('http');
    const size = fs.statSync(filePath).size;
    const req = lib.request({
      host: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method: 'POST', timeout: 180000,
      headers: Object.assign({ 'x-backup-key': key || '', 'Content-Type': 'application/octet-stream', 'Content-Length': size }, headers || {}),
    }, (r) => {
      let data = ''; r.on('data', (c) => { data += c; });
      r.on('end', () => { let j = null; try { j = JSON.parse(data); } catch (_) {} resolve({ status: r.statusCode, json: j }); });
    });
    req.on('timeout', () => req.destroy(new Error('Upload timed out.')));
    req.on('error', reject);
    fs.createReadStream(filePath).on('error', reject).pipe(req);
  });
}
// Stream a file back from the receiver to disk.
function backupDownloadTo(base, pathname, key, destPath) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(base.replace(/\/+$/, '') + pathname); } catch (_) { return reject(new Error('Bad backup URL')); }
    const lib = u.protocol === 'https:' ? require('https') : require('http');
    const req = lib.request({
      host: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method: 'GET', timeout: 180000, headers: { 'x-backup-key': key || '' },
    }, (r) => {
      if (r.statusCode !== 200) { let d = ''; r.on('data', (c) => d += c); r.on('end', () => reject(new Error('Download failed (HTTP ' + r.statusCode + ') ' + d.slice(0, 200)))); return; }
      const out = fs.createWriteStream(destPath);
      let bytes = 0; r.on('data', (c) => bytes += c.length);
      r.pipe(out);
      out.on('finish', () => resolve({ bytes }));
      out.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Download timed out.')));
    req.on('error', reject);
    req.end();
  });
}

function rotateBackups(dir, keep) {
  try {
    const files = fs.readdirSync(dir).filter((f) => /\.dump$/.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const x of files.slice(Math.max(1, parseInt(keep, 10) || 14))) {
      try { fs.unlinkSync(path.join(dir, x.f)); } catch (_) {}
    }
  } catch (_) {}
}

async function logBackup(direction, origin, filename, bytes, ok, note) {
  try {
    await query(
      `INSERT INTO backup_log (direction, origin, filename, bytes, ok, note) VALUES ($1,$2,$3,$4,$5,$6)`,
      [direction, origin || null, filename || null, bytes || null, !!ok, note ? String(note).slice(0, 500) : null]
    );
  } catch (_) {}
}

// Take a fresh pg_dump of the local database and push it to the configured
// receiver. Returns { ok, bytes, filename, error }.
async function runBackup(opts) {
  opts = opts || {};
  if (backupRunning) return { ok: false, error: 'A backup is already running.' };
  const cfg = loadBackupCfg();
  if (!ownsSchema()) return { ok: false, error: 'Only the machine that holds the database can back it up.' };
  if (!cfg.url || !cfg.key) return { ok: false, error: 'Off-site backup is not set up (needs a server URL and key).' };

  backupRunning = true;
  const started = new Date();
  const stamp = started.toISOString().replace(/[:.]/g, '-').replace('Z', 'Z');
  const filename = 'melthahonda-' + stamp + '.dump';
  const filePath = path.join(BACKUP_DIR, filename);
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const db = effectiveLocalDbSettings();
    await new Promise((resolve, reject) => {
      const child = require('child_process').spawn(backupBin('pg_dump'), [
        '-h', '127.0.0.1', '-p', String(db.port), '-U', db.user, '-d', db.database,
        '-Fc', '--no-owner', '--no-privileges', '-f', filePath,
      ], { windowsHide: true, env: Object.assign({}, process.env, { PGPASSWORD: db.password || '' }) });
      let err = '';
      child.stderr.on('data', (c) => { err += c; });
      child.on('error', reject);
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error('pg_dump exited ' + code + ': ' + err.slice(0, 300))));
    });
    const bytes = fs.statSync(filePath).size;

    const res = await backupUpload(cfg.url, '/api/backup/ingest', cfg.key, {
      'x-backup-origin': backupOrigin(),
      'x-backup-filename': filename,
      'x-backup-shop': encodeURIComponent(await shopName()),
    }, filePath);
    if (res.status === 401 || res.status === 403) throw Object.assign(new Error('The backup server rejected the key.'), { authFail: true });
    if (res.status !== 200 || !res.json || !res.json.ok) throw new Error((res.json && res.json.error) || ('Upload failed (HTTP ' + res.status + ')'));

    rotateBackups(BACKUP_DIR, cfg.keep);
    const last = { at: started.toISOString(), ok: true, bytes, filename, error: null, network: false };
    saveBackupCfg({ last });
    await logBackup('out', backupOrigin(), filename, bytes, true, opts.manual ? 'manual' : 'scheduled');
    return { ok: true, bytes, filename };
  } catch (e) {
    const network = !e.authFail && /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|did not answer|timed out/i.test(e.message || '');
    saveBackupCfg({ last: { at: started.toISOString(), ok: false, bytes: 0, filename, error: e.message, network } });
    await logBackup('out', backupOrigin(), filename, 0, false, e.message);
    try { fs.unlinkSync(filePath); } catch (_) {}
    return { ok: false, error: e.message, network };
  } finally {
    backupRunning = false;
  }
}

// Fires on an interval: run a backup when it is due, or when the last attempt
// failed on the network and the receiver is reachable again.
async function backupTick() {
  try {
    if (!ownsSchema()) return;
    const cfg = loadBackupCfg();
    if (!cfg.enabled || !cfg.url || !cfg.key) return;
    const everyMs = Math.max(1, parseInt(cfg.every_hours, 10) || 6) * 3600000;
    const last = cfg.last || {};
    const dueByInterval = !last.at || (Date.now() - Date.parse(last.at)) >= everyMs;
    if (dueByInterval) { await runBackup({}); return; }
    const wantCatchUp = cfg.catch_up !== false && last.ok === false && last.network;
    if (wantCatchUp) {
      const ping = await backupApi('GET', cfg.url, '/api/backup/ping', cfg.key).catch(() => null);
      if (ping && ping.status === 200) await runBackup({});
    }
  } catch (e) { console.warn('[backup] tick:', e.message); }
}

// ---- receiver side: the hosted copy that stores other shops' dumps ----------
app.get('/api/backup/ping', async (req, res) => {
  const cfg = loadBackupCfg();
  if (!backupKeyOk(req.headers['x-backup-key'], cfg.receive_key)) return res.status(401).json({ ok: false, error: 'Bad backup key' });
  res.json({ ok: true, server: await shopName() });
});

app.post('/api/backup/ingest', (req, res) => {
  const cfg = loadBackupCfg();
  if (!backupKeyOk(req.headers['x-backup-key'], cfg.receive_key)) return res.status(401).json({ ok: false, error: 'Bad backup key' });
  const origin = safeName(req.headers['x-backup-origin'], 'shop');
  const filename = safeName(req.headers['x-backup-filename'], 'backup-' + Date.now() + '.dump');
  const dir = path.join(BACKUP_RECV_DIR, origin);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  const dest = path.join(dir, filename);
  const out = fs.createWriteStream(dest);
  let bytes = 0;
  req.on('data', (c) => { bytes += c.length; });
  req.on('error', () => { try { out.destroy(); fs.unlinkSync(dest); } catch (_) {} res.status(400).json({ ok: false, error: 'Upload interrupted' }); });
  req.pipe(out);
  out.on('error', (e) => res.status(500).json({ ok: false, error: e.message }));
  out.on('finish', async () => {
    rotateBackups(dir, cfg.receive_keep || 30);
    await logBackup('in', origin, filename, bytes, true,
      req.headers['x-backup-shop'] ? decodeURIComponent(String(req.headers['x-backup-shop'])).slice(0, 120) : null);
    const total = (() => { try { return fs.readdirSync(dir).filter((f) => /\.dump$/.test(f)).length; } catch (_) { return 1; } })();
    res.json({ ok: true, bytes, stored: filename, total });
  });
});

app.get('/api/backup/latest', (req, res) => {
  const cfg = loadBackupCfg();
  if (!backupKeyOk(req.headers['x-backup-key'], cfg.receive_key)) return res.status(401).json({ ok: false, error: 'Bad backup key' });
  const origin = safeName(req.query.origin || req.headers['x-backup-origin'], 'shop');
  const dir = path.join(BACKUP_RECV_DIR, origin);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /\.dump$/.test(f)).map((f) => ({ f, s: fs.statSync(path.join(dir, f)) })).sort((a, b) => b.s.mtimeMs - a.s.mtimeMs); } catch (_) {}
  if (!files.length) return res.status(404).json({ ok: false, error: 'No backups stored for ' + origin });
  res.json({ ok: true, origin, filename: files[0].f, bytes: files[0].s.size, at: files[0].s.mtime.toISOString(), count: files.length });
});

app.get('/api/backup/download/:origin/:filename', (req, res) => {
  const cfg = loadBackupCfg();
  if (!backupKeyOk(req.headers['x-backup-key'], cfg.receive_key)) return res.status(401).json({ ok: false, error: 'Bad backup key' });
  const p = path.join(BACKUP_RECV_DIR, safeName(req.params.origin, 'shop'), safeName(req.params.filename, ''));
  if (!p.startsWith(BACKUP_RECV_DIR) || !fs.existsSync(p)) return res.status(404).json({ ok: false, error: 'Not found' });
  res.setHeader('Content-Type', 'application/octet-stream');
  fs.createReadStream(p).pipe(res);
});

// ---- admin side: the Settings panel ----------------------------------------
app.get('/api/admin/backup', requireManager, async (req, res) => {
  const cfg = loadBackupCfg();
  let recent = [];
  try { const { rows } = await query('SELECT direction, origin, filename, bytes, ok, note, created_at FROM backup_log ORDER BY created_at DESC LIMIT 12'); recent = rows; } catch (_) {}
  res.json({
    ok: true,
    is_db_host: ownsSchema(),
    pg_dump: fs.existsSync(backupBin('pg_dump')) || backupBin('pg_dump') === 'pg_dump' + (process.platform === 'win32' ? '.exe' : ''),
    config: {
      enabled: !!cfg.enabled, url: cfg.url || '', name: cfg.name || '',
      every_hours: cfg.every_hours || 6, catch_up: cfg.catch_up !== false, keep: cfg.keep || 14,
      key_set: !!cfg.key,
    },
    receive_key_set: !!cfg.receive_key,
    last: cfg.last || null,
    recent,
  });
});

app.post('/api/admin/backup', requireManager, (req, res) => {
  const b = req.body || {};
  const patch = {};
  if (b.enabled !== undefined) patch.enabled = !!b.enabled;
  if (b.url !== undefined) {
    const url = String(b.url || '').trim();
    if (url && !/^https?:\/\//i.test(url)) return res.status(400).json({ ok: false, error: 'URL must start with http:// or https://' });
    patch.url = url;
  }
  if (b.name !== undefined) patch.name = String(b.name || '').slice(0, 80);
  if (b.every_hours !== undefined) patch.every_hours = Math.min(168, Math.max(1, parseInt(b.every_hours, 10) || 6));
  if (b.catch_up !== undefined) patch.catch_up = !!b.catch_up;
  if (b.keep !== undefined) patch.keep = Math.min(365, Math.max(1, parseInt(b.keep, 10) || 14));
  // A blank key leaves the stored one alone; an explicit "" clears it.
  if (typeof b.key === 'string' && b.key.trim()) patch.key = b.key.trim();
  else if (b.key === '') patch.key = '';
  const saved = saveBackupCfg(patch);
  res.json({ ok: true, config: { enabled: !!saved.enabled, url: saved.url || '', key_set: !!saved.key } });
});

app.post('/api/admin/backup/test', requireManager, async (req, res) => {
  const cfg = loadBackupCfg();
  const url = String((req.body && req.body.url) || cfg.url || '').trim();
  const key = (req.body && req.body.key && String(req.body.key).trim()) || cfg.key || '';
  if (!url || !key) return res.status(400).json({ ok: false, error: 'Enter the server URL and key first.' });
  try {
    const r = await backupApi('GET', url, '/api/backup/ping', key);
    if (r.status === 200 && r.json && r.json.ok) return res.json({ ok: true, reachable: true, authorized: true, server: r.json.server || null });
    if (r.status === 401 || r.status === 403) return res.json({ ok: false, reachable: true, authorized: false, error: 'The server is reachable but rejected the key.' });
    return res.json({ ok: false, reachable: true, authorized: false, error: 'Unexpected response (HTTP ' + r.status + '). Is that a Meltha Honda server?' });
  } catch (e) {
    return res.json({ ok: false, reachable: false, authorized: false, error: e.message });
  }
});

app.post('/api/admin/backup/run', requireManager, async (req, res) => {
  const r = await runBackup({ manual: true });
  res.status(r.ok ? 200 : 500).json(r);
});

app.get('/api/admin/backup/receive-key', requireManager, (req, res) => {
  const cfg = loadBackupCfg();
  res.json({ ok: true, key: cfg.receive_key || null, receive_keep: cfg.receive_keep || 30 });
});

app.post('/api/admin/backup/receive-key', requireManager, (req, res) => {
  const patch = {};
  if (req.body && req.body.regenerate !== false) {
    patch.receive_key = (nodeCrypto.randomBytes(20).toString('base64').replace(/[^A-Za-z0-9]/g, '')
      .slice(0, 24).toUpperCase().match(/.{1,4}/g) || []).join('-');
  }
  if (req.body && req.body.receive_keep !== undefined) patch.receive_keep = Math.min(365, Math.max(1, parseInt(req.body.receive_keep, 10) || 30));
  const saved = saveBackupCfg(patch);
  res.json({ ok: true, key: saved.receive_key || null, receive_keep: saved.receive_keep || 30 });
});

// Disaster recovery: pull the newest dump back from the receiver and load it
// over this database. Destructive -- gated on an explicit typed confirmation.
app.post('/api/admin/backup/restore', requireManager, async (req, res) => {
  if (!ownsSchema()) return res.status(400).json({ ok: false, error: 'Only the database-owning machine can restore.' });
  if (!req.body || req.body.confirm !== 'RESTORE') return res.status(400).json({ ok: false, error: 'Type RESTORE to confirm.' });
  const cfg = loadBackupCfg();
  if (!cfg.url || !cfg.key) return res.status(400).json({ ok: false, error: 'Off-site backup is not set up.' });
  try {
    const meta = await backupApi('GET', cfg.url, '/api/backup/latest?origin=' + encodeURIComponent(backupOrigin()), cfg.key);
    if (meta.status !== 200 || !meta.json || !meta.json.filename) throw new Error((meta.json && meta.json.error) || 'No backup found on the server.');
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const local = path.join(BACKUP_DIR, 'restore-' + meta.json.filename);
    await backupDownloadTo(cfg.url, '/api/backup/download/' + encodeURIComponent(backupOrigin()) + '/' + encodeURIComponent(meta.json.filename), cfg.key, local);
    const db = effectiveLocalDbSettings();
    await new Promise((resolve, reject) => {
      const child = require('child_process').spawn(backupBin('pg_restore'), [
        '-h', '127.0.0.1', '-p', String(db.port), '-U', db.user, '-d', db.database,
        '--clean', '--if-exists', '--no-owner', '--no-privileges', '--single-transaction', local,
      ], { windowsHide: true, env: Object.assign({}, process.env, { PGPASSWORD: db.password || '' }) });
      let err = ''; child.stderr.on('data', (c) => { err += c; });
      child.on('error', reject);
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error('pg_restore exited ' + code + ': ' + err.slice(0, 400))));
    });
    await logBackup('in', backupOrigin(), meta.json.filename, meta.json.bytes || null, true, 'restored from off-site');
    res.json({ ok: true, restored: meta.json.filename, restarting: true });
    // Let boot.js respawn a clean process against the freshly loaded database.
    setTimeout(() => process.exit(0), 800);
  } catch (e) {
    console.error('[backup restore]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =============================================================================
//  PER-USER UI PREFERENCES -- the POS terminal's view density, font size,
//  legacy-key mode and column choices (see users.ui_prefs in schema.sql).
//
//  Scoped to the caller's own row on purpose: there is no user id in the path
//  or the body, so a cashier cannot read or overwrite a colleague's settings
//  even by hand-crafting the request. requireAdmin, not requireManager --
//  cashiers are the people who actually live in the POS.
//
//  POST rather than PATCH for the write because navigator.sendBeacon() is the
//  only send that reliably survives the tab being closed, and it can issue
//  nothing but POST.
// =============================================================================
app.get('/api/admin/me/ui-prefs', requireAdmin, async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT ui_prefs, forced_favs, favs_locked FROM users WHERE id = $1',
      [req.session.userId]
    );
    res.json({
      ok: true,
      prefs: (rows[0] && rows[0].ui_prefs) || {},
      // Manager-preset pinned screens (see the users table notes): the client
      // pins forced_favs and, when locked, hides its own pin controls.
      forced_favs: (rows[0] && Array.isArray(rows[0].forced_favs)) ? rows[0].forced_favs : null,
      favs_locked: !!(rows[0] && rows[0].favs_locked),
    });
  } catch (e) {
    // Never fatal: the client keeps a local copy and carries on with it. An
    // older database that has not run the ALTER yet lands here too.
    res.status(500).json({ ok: false, error: e.message, prefs: {} });
  }
});

app.post('/api/admin/me/ui-prefs', requireAdmin, async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return res.status(400).json({ ok: false, error: 'Expected an object of preferences.' });
  // Opaque to the server, but not unbounded -- this column sits on a row that
  // is read on every sign-in, and nothing legitimate in here is more than a
  // few hundred bytes. 8 KB leaves generous room for settings not invented yet.
  const json = JSON.stringify(body);
  if (json.length > 8192)
    return res.status(413).json({ ok: false, error: 'Preferences too large.' });
  try {
    await query('UPDATE users SET ui_prefs = $1::jsonb WHERE id = $2', [json, req.session.userId]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password, name, phone } = req.body || {};
    if (!email || !password)
      return res.status(400).json({ error: 'email and password are required' });
    const hash = await bcrypt.hash(password, 10);
    // First user on a fresh install auto-promotes to admin so the system can
    // self-bootstrap without SQL or a setup script.
    const { rows: cnt } = await query('SELECT COUNT(*)::int AS n FROM users');
    const isFirst = cnt[0].n === 0;
    const acctNo = await nextAccountNumber();
    const { rows } = await query(
      `INSERT INTO users (email, name, password_hash, phone, via, is_admin, account_number)
         VALUES (lower($1), $2, $3, $4, 'local', $5, $6)
         RETURNING id, email, name, is_admin`,
      [email, name || null, hash, phone || null, isFirst, acctNo]
    );
    req.session.userId = rows[0].id;
    req.session.epoch = SESSION_EPOCH;   // see the epoch middleware -- terminate signs these out
    if (isFirst) console.log('[ok] first user "' + rows[0].email + '" auto-promoted to admin');
    res.json({ user: publicUser(rows[0]), first_admin: isFirst });
    // 100-point welcome bonus
    addPoints(rows[0].id, 100, 'signup_bonus', rows[0].id);
    // best-effort welcome email
    const t = mailer.templates.welcomeEmail({ name: rows[0].name, email: rows[0].email });
    mailer.sendEmail({ to: rows[0].email, ...t }).catch((e) =>
      console.warn('[mailer] welcome failed:', e.message)
    );
  } catch (e) {
    if (e.code === '23505')
      return res.status(409).json({ error: 'Email already registered' });
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Emergency reset for admin@melthahonda.com → password123. Always works.
// Restricted to JUST this one well-known email so it can never be used to
// hijack a real customer/staff account.
app.post('/api/auth/reset-default-admin', async (_req, res) => {
  try {
    const hash = await bcrypt.hash('password123', 10);
    const { rows } = await query(
      `INSERT INTO users (email, name, password_hash, via, is_admin)
         VALUES ('admin@melthahonda.com', 'Meltha Honda Admin', $1, 'local', true)
         ON CONFLICT (email) DO UPDATE
           SET is_admin = true, password_hash = EXCLUDED.password_hash
         RETURNING id`,
      [hash]
    );
    console.log('[ok] admin@melthahonda.com password reset to default (via /api/auth/reset-default-admin)');
    res.json({ ok: true, email: 'admin@melthahonda.com', password: 'password123' });
  } catch (e) {
    // Same distinction sign-in makes. This is the recovery link someone clicks
    // *because* they cannot get in, so it is the second thing they try on a
    // till whose database never started -- and it answered with the raw driver
    // text, "Reset failed connect ECONNREFUSED 127.0.0.1:5433", which says
    // nothing about what to do next.
    if (isDbUnreachable(e)) {
      console.error('[reset admin] database unreachable:', e.message);
      return res.status(503).json({
        error: 'The database is not running, so the password cannot be reset. ' +
               'Start the database first — run Test-Database.ps1 in the Meltha Honda folder to find out why it will not start.',
        db_down: true,
      });
    }
    console.error('[reset admin]', e);
    res.status(500).json({ error: e.message });
  }
});

// =============================================================================
//  Checking a password needs the bcrypt hash, and a till is no longer allowed
//  to read one (see schema.sql). So a till asks the server to do the check.
//
//  Authenticated by the terminal's own API token, issued at enrolment and held
//  only as a hash here. This endpoint is a password oracle by nature, so it is
//  deliberately narrow: it needs a valid terminal token, that terminal must
//  still be approved, it returns nothing but the public user record, and it
//  never says whether it was the address or the password that was wrong.
// =============================================================================
app.post('/api/terminal/auth/verify', async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
  if (enrolRateLimited('verify:' + ip)) return res.status(429).json({ error: 'Too many attempts.' });
  const token = String(req.headers['x-terminal-token'] || '').trim();
  const { email, password } = req.body || {};
  if (!token) return res.status(401).json({ error: 'Terminal token required' });
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });
  try {
    const t = await query(
      "SELECT id, name, status FROM terminals WHERE api_token_hash = $1", [hashEnrolToken(token)]);
    if (!t.rows.length) return res.status(401).json({ error: 'Unknown terminal' });
    if (t.rows[0].status !== 'approved') {
      return res.status(403).json({ error: 'This terminal is not allowed to connect.' });
    }
    const { rows } = await query(
      `SELECT id, email, name, password_hash, is_admin, admin_role, disabled FROM users WHERE lower(email) = lower($1) LIMIT 1`,
      [email]);
    if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' });
    const ok = await bcrypt.compare(password, rows[0].password_hash || '');
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
    if (rows[0].disabled) return res.status(403).json({ error: 'This account has been disabled.' });
    res.json({ ok: true, user: publicUser(rows[0]) });
  } catch (e) {
    console.error('[terminal-verify]', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/auth/signin', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password)
      return res.status(400).json({ error: 'email and password are required' });

    // On a till, the hash is unreadable by design -- ask the server instead.
    const up = loadUpstream();
    if (!isLoopbackDbHost() && up && up.url && up.token) {
      let r;
      try {
        r = await upstreamPost(up, '/api/terminal/auth/verify', { email, password });
      } catch (e) {
        // Distinguishable on purpose: "the shop server is unreachable" is a
        // different problem for the person at the counter than "wrong password",
        // and telling them the wrong one sends them hunting in the wrong place.
        console.warn('[signin] upstream verify failed:', e.message);
        return res.status(503).json({ error: 'Cannot reach the shop server to check your sign-in. Is the main PC on?' });
      }
      if (!r.ok || !r.user) return res.status(401).json({ error: 'Invalid credentials' });
      req.session.userId = r.user.id;
      req.session.epoch = SESSION_EPOCH;
      return res.json({ user: r.user });
    }

    const { rows } = await query(
      `SELECT id, email, name, password_hash, is_admin, admin_role, disabled FROM users WHERE lower(email) = lower($1) LIMIT 1`,
      [email]
    );
    if (!rows.length)
      return res.status(401).json({ error: 'Invalid credentials' });
    const ok = await bcrypt.compare(password, rows[0].password_hash || '');
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
    if (rows[0].disabled) return res.status(403).json({ error: 'This account has been disabled. Ask a manager.' });
    req.session.userId = rows[0].id;
    req.session.epoch = SESSION_EPOCH;   // see the epoch middleware -- terminate signs these out
    res.json({ user: publicUser(rows[0]) });
  } catch (e) {
    // A database that is not running is the single most common reason sign-in
    // fails on a freshly copied till, and "Server error" reads exactly like a
    // rejected password -- so people retype the password instead of looking at
    // the database. Say which it is.
    //
    // The server deliberately starts even when the database is unreachable so
    // the admin page can load and explain itself (see boot.js), which is what
    // makes this distinction necessary rather than academic.
    if (isDbUnreachable(e)) {
      console.error('[signin] database unreachable:', e.message);
      return res.status(503).json({
        error: 'The database is not running, so nobody can sign in yet. This is not a password problem.',
        db_down: true,
      });
    }
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Connection-level failures, as opposed to a query that ran and said no. Shares
// its list with waitForDatabase()'s transient set, plus the codes that mean the
// address or credentials are wrong -- from the counter's point of view those
// are all "the database is not answering".
function isDbUnreachable(e) {
  if (!e) return false;
  if (isDbStarting(e)) return true;
  return ['28P01', '28000', '3D000', '08004', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN']
    .includes(e.code);
}

// =============================================================================
//  PIN SIGN-IN
//
//  Signing in to the panel with a PIN alone, for the counter: a shared till
//  changes hands all day, and typing an email and password each time is how
//  people end up leaving one account signed in for the whole shift.
//
//  Unauthenticated by necessity -- it IS the sign-in -- which makes it the most
//  exposed endpoint in the app, so:
//
//    * It is throttled by source with the same counter the override keypad
//      uses. Four digits is ten thousand possibilities; without a throttle a
//      script walks the whole space in minutes.
//    * Only staff with a PIN are considered. A customer account cannot be
//      reached this way however the PIN is guessed.
//    * PINs are unique across staff (enforced when set), so a match identifies
//      exactly one person -- there is no "first bcrypt hit wins".
//    * The terminal gate above applies to /api/auth/*, so a till that has not
//      been approved cannot PIN its way in either.
//
//  It is deliberately weaker than a password, and that is a trade the counter
//  makes knowingly. Anyone who should not be able to open the panel from a
//  keypad should simply not have a PIN set.
// =============================================================================
app.post('/api/auth/pin-signin', async (req, res) => {
  const key = req.ip || 'local';
  const gate = pinGate(key);
  if (gate.blocked) {
    return res.status(429).json({ error: 'Too many wrong PINs. Try again in ' + gate.waitS + 's.' });
  }
  const pin = String((req.body && req.body.pin) || '').trim();
  if (!pin) return res.status(400).json({ error: 'PIN required' });

  try {
    const { rows } = await query(
      `SELECT id, email, name, is_admin, admin_role, pin_hash
         FROM users
        WHERE pin_hash IS NOT NULL AND is_staff = true AND NOT disabled`
    );
    let hit = null;
    for (const r of rows) {
      if (await bcrypt.compare(pin, r.pin_hash)) { hit = r; break; }
    }
    if (!hit) {
      pinFail(key, gate.rec);
      return res.status(401).json({ error: 'PIN not recognised' });
    }
    if (!hit.is_admin) {
      // Staff who are not admins hold PINs for the till keypad and the time
      // clock; that is not the same permission as opening the panel.
      return res.status(403).json({ error: (hit.name || 'That staff member') + ' does not have admin panel access.' });
    }
    PIN_ATTEMPTS.delete(key);
    req.session.userId = hit.id;
    req.session.epoch = SESSION_EPOCH;
    console.log('[signin] PIN sign-in:', hit.email);
    res.json({ user: publicUser(hit) });
  } catch (e) {
    if (isDbUnreachable(e)) {
      return res.status(503).json({
        error: 'The database is not running, so nobody can sign in yet. This is not a password problem.',
        db_down: true,
      });
    }
    console.error('[pin-signin]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/auth/signout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

app.get('/api/me', async (req, res) => {
  if (!req.session || !req.session.userId) return res.json({ user: null });
  const { rows } = await query(
    'SELECT id, email, name, phone, is_admin, admin_role FROM users WHERE id = $1',
    [req.session.userId]
  );
  if (!rows[0]) return res.json({ user: null });
  // Effective capability map for the signed-in user, so the admin UI can hide
  // or disable what it may not do. The server still re-checks on write.
  let perms = {}, permsFull = false;
  if (rows[0].is_admin) {
    const st = await userPermState(rows[0].id);
    perms = st.perms; permsFull = st.full;
  }
  res.json({ user: { ...publicUser(rows[0]), phone: rows[0].phone || null, perms, perms_full: permsFull } });
});

// Catalogue for the per-user permission editor.
app.get('/api/admin/capabilities', requireAdmin, (_req, res) => {
  res.json({ capabilities: CAPABILITIES });
});

// Self-serve profile edit
app.patch('/api/me', requireAuth, async (req, res) => {
  const b = req.body || {};
  const sets = []; const params = [];
  if (b.name !== undefined){ params.push((b.name || '').trim() || null); sets.push(`name = $${params.length}`); }
  if (b.phone !== undefined){ params.push((b.phone || '').trim() || null); sets.push(`phone = $${params.length}`); }
  if (b.password){
    if (String(b.password).length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
    // A till cannot write password_hash either -- being able to set an
    // existing admin's password is the same escalation as reading the hashes,
    // by a different door. Say where to do it rather than letting the UPDATE
    // fail with a raw "permission denied for column password_hash".
    if (!isLoopbackDbHost() && loadUpstream()) {
      return res.status(400).json({ error: 'Password changes have to be made on the shop\'s main PC, not from a till.' });
    }
    const hash = await bcrypt.hash(String(b.password), 10);
    params.push(hash); sets.push(`password_hash = $${params.length}`);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  params.push(req.session.userId);
  await query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
  const { rows } = await query(
    'SELECT id, email, name, phone, is_admin FROM users WHERE id = $1',
    [req.session.userId]
  );
  res.json({ user: { ...publicUser(rows[0]), phone: rows[0].phone || null } });
});

// =============================================================================
//  ADMIN ENDPOINTS (require is_admin = true)
// =============================================================================
app.get('/api/admin/summary', requireAdmin, async (_req, res) => {
  const [inq, app, notif, rev, ord, lowStock] = await Promise.all([
    query('SELECT COUNT(*)::int AS n FROM parts_inquiries WHERE status = $1', ['new']),
    query('SELECT COUNT(*)::int AS n FROM service_appointments WHERE status = $1', ['pending']),
    query('SELECT COUNT(*)::int AS n FROM notify_subscriptions WHERE notified_at IS NULL'),
    query('SELECT COUNT(*)::int AS n FROM reviews WHERE approved = false'),
    query('SELECT COUNT(*)::int AS n FROM orders WHERE status = $1', ['pending']),
    query('SELECT COUNT(*)::int AS n FROM products WHERE stock_count <= low_threshold'),
  ]);
  res.json({
    new_inquiries: inq.rows[0].n,
    pending_appointments: app.rows[0].n,
    pending_notifications: notif.rows[0].n,
    pending_reviews: rev.rows[0].n,
    pending_orders: ord.rows[0].n,
    low_stock_count: lowStock.rows[0].n,
  });
});

app.get('/api/admin/inquiries', requireAdmin, async (_req, res) => {
  const { rows } = await query(
    `SELECT id, name, phone, vehicle_make, vehicle_model, vehicle_year,
            condition, part_description, photo_path, status, created_at
       FROM parts_inquiries ORDER BY created_at DESC LIMIT 200`
  );
  res.json({ inquiries: rows });
});

app.patch('/api/admin/inquiries/:id', requireAdmin, async (req, res) => {
  const { status } = req.body || {};
  if (!['new','quoted','won','lost'].includes(status))
    return res.status(400).json({ error: 'Invalid status' });
  await query('UPDATE parts_inquiries SET status = $1 WHERE id = $2', [status, req.params.id]);
  res.json({ ok: true });
});

app.get('/api/admin/appointments', requireAdmin, async (_req, res) => {
  const { rows } = await query(
    `SELECT id, name, phone, email, vehicle_make, vehicle_model, vehicle_year,
            service_type, preferred_date, time_slot, notes, status, created_at
       FROM service_appointments ORDER BY created_at DESC LIMIT 200`
  );
  res.json({ appointments: rows });
});

app.patch('/api/admin/appointments/:id', requireAdmin, async (req, res) => {
  const { status } = req.body || {};
  if (!['pending','confirmed','completed','cancelled'].includes(status))
    return res.status(400).json({ error: 'Invalid status' });
  await query('UPDATE service_appointments SET status = $1 WHERE id = $2', [status, req.params.id]);
  res.json({ ok: true });
});

// Calendar view: returns appointments grouped by date for a given week (or this
// week if `week` not supplied). The `week` query is any date in the target
// week, e.g. /api/admin/appointments/calendar?week=2026-05-25
app.get('/api/admin/appointments/calendar', requireAdmin, async (req, res) => {
  const anchor = req.query.week ? new Date(req.query.week) : new Date();
  // Snap to Monday (Mon-Sat business week)
  const day = anchor.getUTCDay(); // 0 = Sun, 1 = Mon, ... 6 = Sat
  const diff = (day === 0 ? -6 : 1 - day);
  const mon = new Date(anchor); mon.setUTCDate(anchor.getUTCDate() + diff);
  mon.setUTCHours(0,0,0,0);
  const sat = new Date(mon); sat.setUTCDate(mon.getUTCDate() + 6);
  const { rows } = await query(
    `SELECT id, name, phone, vehicle_make, vehicle_model, vehicle_year,
            service_type, preferred_date, time_slot, status, notes
       FROM service_appointments
       WHERE preferred_date BETWEEN $1::date AND $2::date
       ORDER BY preferred_date ASC, time_slot ASC`,
    [mon.toISOString().slice(0,10), sat.toISOString().slice(0,10)]
  );
  res.json({
    week_start: mon.toISOString().slice(0,10),
    week_end: sat.toISOString().slice(0,10),
    appointments: rows,
  });
});

app.get('/api/admin/notifications', requireAdmin, async (_req, res) => {
  const { rows } = await query(
    `SELECT n.id, n.product_img, n.email, n.phone, n.notified_at, n.created_at,
            p.name AS product_name, p.stock_count
       FROM notify_subscriptions n
       LEFT JOIN products p ON p.id = n.product_id
       ORDER BY n.created_at DESC LIMIT 200`
  );
  res.json({ notifications: rows });
});

app.get('/api/admin/reviews', requireAdmin, async (_req, res) => {
  const { rows } = await query(
    `SELECT id, name, city, vehicle, rating, body, approved, created_at
       FROM reviews ORDER BY created_at DESC LIMIT 200`
  );
  res.json({ reviews: rows });
});

app.patch('/api/admin/reviews/:id', requireAdmin, async (req, res) => {
  const { approved } = req.body || {};
  await query('UPDATE reviews SET approved = $1 WHERE id = $2', [!!approved, req.params.id]);
  // Award 50 points to the reviewer on first approval (idempotent via unique idx).
  if (approved) {
    const { rows } = await query('SELECT user_id FROM reviews WHERE id = $1', [req.params.id]);
    if (rows[0] && rows[0].user_id) {
      addPoints(rows[0].user_id, 50, 'review', parseInt(req.params.id, 10));
    }
  }
  res.json({ ok: true });
});

// ---- LOYALTY POINTS ----------------------------------------------------------
app.get('/api/points', requireAuth, async (req, res) => {
  const balance = await pointsBalance(req.session.userId);
  const { rows: txs } = await query(
    `SELECT delta, reason, reference_id, created_at
       FROM points_transactions WHERE user_id = $1
       ORDER BY created_at DESC LIMIT 30`,
    [req.session.userId]
  );
  res.json({
    balance,
    transactions: txs,
    rate_usd_per_point: POINTS_USD_RATE,
  });
});

// =============================================================================
//  ADMIN: CUSTOMER SEARCH + DETAIL
// =============================================================================
// =============================================================================
//  CUSTOMER CRM — extended profile + addresses + contacts + reminders + messages
// =============================================================================
app.patch('/api/admin/users/:id', requireAdmin, requireCap('pos.edit_customer'), async (req, res) => {
  // credit_type / credit_length_months complete the credit preset the counter
  // quotes from: limit (credit_limit_usd), type, length, term
  // (payment_terms_days). account_number is here so a customer created at the
  // counter can be given the shop's own number rather than only the generated
  // one.
  const fields = ['name','phone','company_name','customer_type','tax_id','credit_limit_usd','discount_pct','price_tier','sales_rep_id','how_heard','rating','internal_notes','email_opt_in','sms_opt_in','preferred_contact','payment_terms_days','discount_limit_pct','tax_exempt','credit_type','credit_length_months','account_number',
    // Restoring an archived customer goes through here. Without it the Restore
    // button would report success and change nothing.
    'is_archived'];
  const sets = []; const vals = [];
  for (const f of fields) if (req.body && req.body[f] !== undefined) { sets.push(`${f} = $${sets.length+1}`); vals.push(req.body[f]); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(req.params.id);
  await query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
  res.json({ ok: true });
});

// Addresses
// ---- create a customer from the admin screen ---------------------------------
//  The POS has been able to do this all along (POST /api/admin/pos/customer);
//  the Customers screen could only ever edit people who already existed. Same
//  rules as the till so the two produce identical records:
//
//  users.email is NOT NULL UNIQUE, but a counter customer usually has no email
//  to give. Rather than refuse them, mint one from their account number --
//  <acct>@walkin.melthahonda.local -- which is unique, obviously synthetic, and
//  never mailed. The password is random and discarded: this is a record of a
//  person, not a login they will ever use.
app.post('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Name is required' });

    const acctNo = b.account_number ? String(b.account_number).trim() : await nextAccountNumber();
    const email = String(b.email || '').trim().toLowerCase() || `${acctNo.toLowerCase()}@walkin.melthahonda.local`;
    const hash = await bcrypt.hash(require('crypto').randomBytes(24).toString('hex'), 10);

    const { rows } = await query(
      `INSERT INTO users (email, name, password_hash, phone, via, is_admin, is_staff,
                          price_tier, account_number, company_name, customer_type,
                          credit_type, credit_limit_usd, credit_length_months,
                          payment_terms_days, discount_pct, tax_exempt, tax_id, internal_notes)
         VALUES ($1,$2,$3,$4,'pos',false,false,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING id, email, name, phone, account_number`,
      [email, name, hash, b.phone || null,
       ['retail','trade','fleet','dealer'].includes(b.price_tier) ? b.price_tier : 'retail',
       acctNo, b.company_name || null, b.customer_type || null,
       b.credit_type || null, b.credit_limit_usd || null, b.credit_length_months || null,
       b.payment_terms_days || null, b.discount_pct || null, !!b.tax_exempt,
       b.tax_id || null, b.internal_notes || null]
    );
    res.json({ ok: true, customer: rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'A customer with that email or account number already exists' });
    if (e.code === '23514') return res.status(400).json({ error: 'Credit type must be one of: cash, open, revolving, cod' });
    console.error('[customer create]', e);
    res.status(500).json({ error: e.message });
  }
});

// ---- delete a customer -------------------------------------------------------
//  Refused outright once there is history behind them, and this is not
//  cautiousness for its own sake: orders, pos_sales and account_payments all
//  reference users with ON DELETE SET NULL, so removing a customer does not
//  fail -- it silently detaches their sales and, worse, their outstanding
//  account payments, turning a balance owed into anonymous rows nobody can
//  chase. Deleting is therefore only offered for a record with nothing behind
//  it, which is the case that actually comes up: a duplicate typed twice.
//
//  Everyone else is archived. is_staff/is_admin are refused too -- staff are
//  managed on their own screen, where deactivating keeps their work-order
//  history intact.
app.delete('/api/admin/users/:id', requireManager, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { rows: u } = await query('SELECT id, name, email, is_admin, is_staff FROM users WHERE id = $1', [id]);
  if (!u.length) return res.status(404).json({ error: 'No such customer' });
  if (u[0].is_admin || u[0].is_staff) {
    return res.status(400).json({ error: 'That is a staff account — manage it under Settings → Users & Staff.' });
  }
  if (u[0].email === 'walkin@melthahonda.local') {
    return res.status(400).json({ error: 'The walk-in customer is used by every counter sale and cannot be removed.' });
  }

  const { rows: hist } = await query(
    // Column names checked against the schema, not assumed: orders keys on
    // user_id while pos_sales and account_payments both key on customer_id.
    `SELECT (SELECT COUNT(*)::int FROM orders WHERE user_id = $1)               AS orders,
            (SELECT COUNT(*)::int FROM pos_sales WHERE customer_id = $1)        AS sales,
            (SELECT COUNT(*)::int FROM account_payments WHERE customer_id = $1) AS payments`,
    [id]
  );
  const h = hist[0];
  const total = h.orders + h.sales + h.payments;

  if (total > 0 && String(req.query.mode || '') !== 'archive') {
    return res.status(409).json({
      error: 'This customer has ' + h.orders + ' order(s), ' + h.sales + ' counter sale(s) and ' +
             h.payments + ' account payment(s). Deleting would detach that history from them. Archive instead.',
      has_history: true, counts: h,
    });
  }

  if (String(req.query.mode || '') === 'archive') {
    await query('UPDATE users SET is_archived = true WHERE id = $1', [id]);
    return res.json({ ok: true, archived: true });
  }
  await query('DELETE FROM users WHERE id = $1', [id]);
  console.log('[customer delete]', u[0].email, 'by user', req.session.userId);
  res.json({ ok: true, deleted: true });
});

app.get('/api/admin/users/:id/addresses', requireAdmin, async (req, res) => {
  const { rows } = await query('SELECT * FROM customer_addresses WHERE user_id = $1 ORDER BY is_default DESC, created_at DESC', [req.params.id]);
  res.json({ addresses: rows });
});
app.post('/api/admin/users/:id/addresses', requireAdmin, async (req, res) => {
  const b = req.body || {};
  if (!b.line1) return res.status(400).json({ error: 'line1 required' });
  // Scoped to the same kind. A customer needs a default shipping address AND a
  // default billing address at the same time; clearing across both -- which is
  // what this did -- meant marking a billing address as default silently
  // unset the shipping one the storefront picks at checkout.
  const kind = b.kind || 'shipping';
  if (b.is_default) {
    await query(
      `UPDATE customer_addresses SET is_default = false
        WHERE user_id = $1 AND COALESCE(kind,'shipping') = $2`,
      [req.params.id, kind]
    );
  }
  const { rows } = await query(
    `INSERT INTO customer_addresses (user_id, label, kind, recipient, line1, line2, city, parish, postal_code, country, phone, is_default, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [req.params.id, b.label || null, b.kind || 'shipping', b.recipient || null, b.line1, b.line2 || null,
     b.city || null, b.parish || null, b.postal_code || null, b.country || 'Jamaica', b.phone || null,
     !!b.is_default, b.notes || null]
  );
  res.json({ ok: true, id: rows[0].id });
});

app.patch('/api/admin/addresses/:id', requireAdmin, async (req, res) => {
  const fields = ['label','kind','recipient','line1','line2','city','parish','postal_code','country','phone','is_default','notes'];
  const sets = []; const vals = [];
  for (const f of fields) if (req.body && req.body[f] !== undefined) { sets.push(`${f} = $${sets.length+1}`); vals.push(req.body[f]); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });

  // Promoting an address to default has to demote the previous one, within the
  // same kind. Only the POST did this, so editing an address and ticking
  // "default" left the customer with two -- and whichever the storefront's
  // ORDER BY happened to reach first won.
  if (req.body.is_default) {
    const { rows: cur } = await query(
      `SELECT user_id, COALESCE(kind,'shipping') AS kind FROM customer_addresses WHERE id = $1`,
      [req.params.id]
    );
    if (cur.length) {
      const kind = req.body.kind || cur[0].kind;
      await query(
        `UPDATE customer_addresses SET is_default = false
          WHERE user_id = $1 AND COALESCE(kind,'shipping') = $2 AND id <> $3`,
        [cur[0].user_id, kind, req.params.id]
      );
    }
  }

  vals.push(req.params.id);
  await query(`UPDATE customer_addresses SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
  res.json({ ok: true });
});
app.delete('/api/admin/addresses/:id', requireAdmin, async (req, res) => {
  await query('DELETE FROM customer_addresses WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// Contacts (for business customers)
app.get('/api/admin/users/:id/contacts', requireAdmin, async (req, res) => {
  const { rows } = await query('SELECT * FROM customer_contacts WHERE user_id = $1 ORDER BY is_primary DESC, name ASC', [req.params.id]);
  res.json({ contacts: rows });
});
app.post('/api/admin/users/:id/contacts', requireAdmin, async (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'name required' });
  if (b.is_primary) await query('UPDATE customer_contacts SET is_primary = false WHERE user_id = $1', [req.params.id]);
  const { rows } = await query(
    `INSERT INTO customer_contacts (user_id, name, title, phone, email, is_primary, notes) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [req.params.id, b.name, b.title || null, b.phone || null, b.email || null, !!b.is_primary, b.notes || null]
  );
  res.json({ ok: true, id: rows[0].id });
});
app.patch('/api/admin/contacts/:id', requireAdmin, async (req, res) => {
  const fields = ['name','title','phone','email','is_primary','notes'];
  const sets = []; const vals = [];
  for (const f of fields) if (req.body && req.body[f] !== undefined) { sets.push(`${f} = $${sets.length+1}`); vals.push(req.body[f]); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(req.params.id);
  await query(`UPDATE customer_contacts SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
  res.json({ ok: true });
});
app.delete('/api/admin/contacts/:id', requireAdmin, async (req, res) => {
  await query('DELETE FROM customer_contacts WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// Reminders
app.get('/api/admin/users/:id/reminders', requireAdmin, async (req, res) => {
  const { rows } = await query(
    `SELECT cr.*, m.name AS assignee_name FROM customer_reminders cr
       LEFT JOIN mechanics m ON m.id = cr.assigned_to
       WHERE cr.user_id = $1 ORDER BY cr.status ASC, cr.due_date ASC`,
    [req.params.id]
  );
  res.json({ reminders: rows });
});
app.post('/api/admin/users/:id/reminders', requireAdmin, async (req, res) => {
  const b = req.body || {};
  if (!b.subject || !b.due_date) return res.status(400).json({ error: 'subject and due_date required' });
  const { rows } = await query(
    `INSERT INTO customer_reminders (user_id, due_date, subject, body, assigned_to, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [req.params.id, b.due_date, b.subject, b.body || null, b.assigned_to || null, req.session.userId]
  );
  res.json({ ok: true, id: rows[0].id });
});
app.patch('/api/admin/reminders/:id', requireAdmin, async (req, res) => {
  const fields = ['due_date','subject','body','assigned_to','status'];
  const sets = []; const vals = [];
  for (const f of fields) if (req.body && req.body[f] !== undefined) { sets.push(`${f} = $${sets.length+1}`); vals.push(req.body[f]); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(req.params.id);
  await query(`UPDATE customer_reminders SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
  if (req.body && req.body.status === 'done') {
    await query('UPDATE customer_reminders SET done_at = NOW() WHERE id = $1', [req.params.id]);
  }
  res.json({ ok: true });
});
app.delete('/api/admin/reminders/:id', requireAdmin, async (req, res) => {
  await query('DELETE FROM customer_reminders WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// Reminders due today (for dashboard)
app.get('/api/admin/reminders/due', requireAdmin, async (_req, res) => {
  const { rows } = await query(
    `SELECT cr.*, u.name AS customer_name, u.phone AS customer_phone, m.name AS assignee_name
       FROM customer_reminders cr
       LEFT JOIN users u ON u.id = cr.user_id
       LEFT JOIN mechanics m ON m.id = cr.assigned_to
       WHERE cr.status = 'pending' AND cr.due_date <= CURRENT_DATE
       ORDER BY cr.due_date ASC LIMIT 100`
  );
  res.json({ reminders: rows });
});

// Notifications log
app.get('/api/admin/users/:id/notifications', requireAdmin, async (req, res) => {
  const { rows } = await query(
    'SELECT * FROM customer_notifications WHERE user_id = $1 ORDER BY sent_at DESC LIMIT 200',
    [req.params.id]
  );
  res.json({ notifications: rows });
});

// Send a notice to a customer -- dunning (overdue account balance) or any
// other kind of manual notice. Logs to customer_notifications either way;
// best-effort emails it too when the customer has an address on file (same
// "log first, send best-effort" pattern as the welcome email in /auth/signup
// -- a failed send never blocks the notice from being recorded).
app.post('/api/admin/users/:id/notifications', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const kind = ['dunning', 'reminder', 'general', 'other'].includes(b.kind) ? b.kind : 'general';
  const body = (b.body || '').trim();
  if (!body) return res.status(400).json({ error: 'body is required' });
  const { rows: u } = await query('SELECT name, email FROM users WHERE id = $1', [req.params.id]);
  if (!u.length) return res.status(404).json({ error: 'Customer not found' });
  const { rows } = await query(
    `INSERT INTO customer_notifications (user_id, kind, body) VALUES ($1,$2,$3) RETURNING id, sent_at`,
    [req.params.id, kind, body]
  );
  if (u[0].email) {
    const subject = kind === 'dunning' ? 'Payment reminder — Meltha Honda Sales & Servs' : 'A note from Meltha Honda Sales & Servs';
    mailer.sendEmail({ to: u[0].email, subject, text: body, html: `<p>${body.replace(/\n/g, '<br>')}</p>` })
      .catch((e) => console.warn('[notice email]', e.message));
  }
  res.json({ ok: true, id: rows[0].id, sent_at: rows[0].sent_at, emailed: !!u[0].email });
});

// =============================================================================
//  SETTLE A BALANCE DUE -- the other side of the 'account' tender ledger.
//  A charge to account only ever went up until now (see getAccountBalance());
//  this records an actual payment received against it. requireManager, same
//  tier as voiding a sale or issuing a gift card -- accepting money against a
//  customer's account is a financial action, not a day-to-day counter task.
// =============================================================================
app.get('/api/admin/users/:id/account-payments', requireAdmin, async (req, res) => {
  const { rows } = await query(
    `SELECT ap.*, COALESCE(u.name, u.email) AS received_by_name FROM account_payments ap
       LEFT JOIN users u ON u.id = ap.received_by
      WHERE ap.customer_id = $1 ORDER BY ap.created_at DESC LIMIT 200`,
    [req.params.id]
  );
  res.json({ payments: rows, balance_usd: await getAccountBalance(req.params.id) });
});
app.post('/api/admin/users/:id/account-payments', requireManager, async (req, res) => {
  const b = req.body || {};
  const amount = Number(b.amount_usd);
  if (!(amount > 0)) return res.status(400).json({ error: 'amount_usd must be positive' });
  if (!['cash', 'card', 'cheque', 'bank'].includes(b.method))
    return res.status(400).json({ error: 'method must be cash, card, cheque, or bank' });
  const { rows: u } = await query('SELECT id FROM users WHERE id = $1', [req.params.id]);
  if (!u.length) return res.status(404).json({ error: 'Customer not found' });
  const balanceBefore = await getAccountBalance(req.params.id);
  const { rows } = await query(
    `INSERT INTO account_payments (customer_id, amount_usd, method, reference, notes, received_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, created_at`,
    [req.params.id, amount, b.method, b.reference || null, b.notes || null, req.session.userId]
  );
  const balanceAfter = balanceBefore - amount;
  res.json({
    ok: true, id: rows[0].id, created_at: rows[0].created_at,
    balance_before_usd: balanceBefore, balance_after_usd: balanceAfter,
    // A payment bigger than what was owed isn't an error -- it just leaves
    // the account in credit (a negative balance) rather than at zero.
    overpaid: balanceAfter < 0,
  });
});

// In-app messages (admin side: list + reply)
app.get('/api/admin/users/:id/messages', requireAdmin, async (req, res) => {
  const { rows } = await query(
    'SELECT * FROM customer_messages WHERE user_id = $1 ORDER BY created_at ASC LIMIT 500',
    [req.params.id]
  );
  // Mark customer messages as read
  await query("UPDATE customer_messages SET read_at = NOW() WHERE user_id = $1 AND sender = 'customer' AND read_at IS NULL", [req.params.id]);
  res.json({ messages: rows });
});
app.post('/api/admin/users/:id/messages', requireAdmin, async (req, res) => {
  const body = (req.body && req.body.body) || '';
  if (!body.trim()) return res.status(400).json({ error: 'body required' });
  const { rows } = await query(
    `INSERT INTO customer_messages (user_id, sender, staff_id, body) VALUES ($1, 'staff', $2, $3) RETURNING id, created_at`,
    [req.params.id, req.session.userId, body.trim()]
  );
  res.json({ ok: true, id: rows[0].id, created_at: rows[0].created_at });
});

// Counts of unread customer messages — for an inbox badge in admin
app.get('/api/admin/messages/inbox', requireAdmin, async (_req, res) => {
  const { rows } = await query(
    `SELECT cm.user_id, u.name AS customer_name, u.email AS customer_email, u.phone AS customer_phone,
            COUNT(*) FILTER (WHERE cm.read_at IS NULL AND cm.sender = 'customer')::int AS unread,
            MAX(cm.created_at) AS last_message_at,
            (SELECT body FROM customer_messages m2 WHERE m2.user_id = cm.user_id ORDER BY created_at DESC LIMIT 1) AS last_message
       FROM customer_messages cm
       LEFT JOIN users u ON u.id = cm.user_id
       GROUP BY cm.user_id, u.name, u.email, u.phone
       ORDER BY unread DESC, last_message_at DESC LIMIT 100`
  );
  res.json({ threads: rows });
});

// ===== CUSTOMER-SIDE endpoints (signed in) =====
app.get('/api/my-addresses', requireAuth, async (req, res) => {
  const { rows } = await query('SELECT * FROM customer_addresses WHERE user_id = $1 ORDER BY is_default DESC, created_at DESC', [req.session.userId]);
  res.json({ addresses: rows });
});
app.post('/api/my-addresses', requireAuth, async (req, res) => {
  const b = req.body || {};
  if (!b.line1) return res.status(400).json({ error: 'line1 required' });
  if (b.is_default) await query('UPDATE customer_addresses SET is_default = false WHERE user_id = $1', [req.session.userId]);
  const { rows } = await query(
    `INSERT INTO customer_addresses (user_id, label, kind, line1, line2, city, parish, postal_code, country, phone, is_default)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [req.session.userId, b.label || null, b.kind || 'shipping', b.line1, b.line2 || null,
     b.city || null, b.parish || null, b.postal_code || null, b.country || 'Jamaica', b.phone || null, !!b.is_default]
  );
  res.json({ ok: true, id: rows[0].id });
});
app.delete('/api/my-addresses/:id', requireAuth, async (req, res) => {
  await query('DELETE FROM customer_addresses WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId]);
  res.json({ ok: true });
});

app.get('/api/my-messages', requireAuth, async (req, res) => {
  const { rows } = await query('SELECT * FROM customer_messages WHERE user_id = $1 ORDER BY created_at ASC LIMIT 500', [req.session.userId]);
  await query("UPDATE customer_messages SET read_at = NOW() WHERE user_id = $1 AND sender = 'staff' AND read_at IS NULL", [req.session.userId]);
  res.json({ messages: rows });
});
app.post('/api/my-messages', requireAuth, async (req, res) => {
  const body = (req.body && req.body.body) || '';
  if (!body.trim()) return res.status(400).json({ error: 'Message required' });
  const { rows } = await query(
    `INSERT INTO customer_messages (user_id, sender, body) VALUES ($1, 'customer', $2) RETURNING id, created_at`,
    [req.session.userId, body.trim()]
  );
  res.json({ ok: true, id: rows[0].id, created_at: rows[0].created_at });
});

// The customer list. Staff are excluded by default and have their own screen:
// a roster of a dozen people is not findable inside thousands of customers,
// and the two are edited in completely different ways.
//
// `origin` separates customers who signed themselves up on the storefront from
// the ones the counter created for them. They behave differently -- an online
// customer has an email they chose and a password they know, a counter one
// often has neither -- and the shop deals with them separately.
//   online   signed up through the storefront
//   counter  created at the till (via = 'pos')
//   staff    the roster, for when someone really does want to see it here
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  const origin = String(req.query.origin || '').toLowerCase();
  const type = String(req.query.customer_type || '').trim();
  const params = [];
  const clauses = [];

  if (q) {
    params.push('%' + q + '%');
    clauses.push(`(lower(email) LIKE $${params.length} OR lower(coalesce(name,'')) LIKE $${params.length} OR coalesce(phone,'') LIKE $${params.length} OR lower(coalesce(company_name,'')) LIKE $${params.length} OR lower(coalesce(account_number,'')) LIKE $${params.length})`);
  }
  if (type) { params.push(type); clauses.push(`u.customer_type = $${params.length}`); }

  if (origin === 'archived') {
    // Deliberately reachable: an archive nobody can look in is a delete with
    // extra steps, and restoring is the whole reason for archiving.
    clauses.push(`u.is_archived = true`);
  } else if (origin === 'staff') {
    clauses.push(`(u.is_staff = true OR u.is_admin = true)`);
  } else {
    clauses.push(`u.is_archived = false`);
    // is_admin as well as is_staff: accounts that predate is_staff -- the
    // seeded owner among them -- have a panel login and no staff flag, and
    // filtering on is_staff alone left them sitting in the customer list
    // labelled as online sign-ups.
    clauses.push(`u.is_staff = false AND u.is_admin = false`);
    // 'local' is what staff creation stamps, so it is never a customer origin.
    if (origin === 'online') clauses.push(`(u.via IS NULL OR u.via NOT IN ('pos','local'))`);
    else if (origin === 'counter') clauses.push(`u.via = 'pos'`);
  }

  const where = clauses.length ? clauses.join(' AND ') : '1=1';
  const { rows } = await query(
    `SELECT u.id, u.email, u.name, u.phone, u.is_admin, u.is_staff, u.created_at,
            u.via, u.company_name, u.customer_type, u.account_number,
            u.credit_limit_usd::float AS credit_limit_usd, u.credit_type,
            (SELECT COUNT(*)::int FROM orders WHERE user_id = u.id) AS orders,
            (SELECT COALESCE(SUM(total_usd),0)::numeric(10,2) FROM orders WHERE user_id = u.id) AS lifetime_usd,
            COALESCE((SELECT balance FROM user_points WHERE user_id = u.id), 0) AS points
       FROM users u WHERE ${where}
       ORDER BY u.created_at DESC LIMIT 100`,
    params
  );

  // Counts for the filter tabs, so the shop can see at a glance how many of
  // each it has without clicking through.
  const { rows: tallies } = await query(
    `SELECT
       COUNT(*) FILTER (WHERE is_staff = false AND is_admin = false AND is_archived = false AND (via IS NULL OR via NOT IN ('pos','local')))::int AS online,
       COUNT(*) FILTER (WHERE is_staff = false AND is_admin = false AND is_archived = false AND via = 'pos')::int AS counter,
       COUNT(*) FILTER (WHERE is_staff = true OR is_admin = true)::int AS staff,
       COUNT(*) FILTER (WHERE is_archived = true)::int AS archived
     FROM users`
  );
  res.json({ users: rows, counts: tallies[0] });
});

app.get('/api/admin/users/:id', requireAdmin, async (req, res) => {
  const { rows: u } = await query(
    `SELECT id, email, name, phone, is_admin, created_at, account_number,
            company_name, customer_type, tax_id, credit_limit_usd::float AS credit_limit_usd,
            discount_pct::float AS discount_pct, price_tier, sales_rep_id, how_heard, rating,
            internal_notes, email_opt_in, sms_opt_in, preferred_contact,
            payment_terms_days, discount_limit_pct::float AS discount_limit_pct, tax_exempt,
            -- The rest of the credit preset. Without these two the detail form
            -- renders them blank on every open, so a saved credit type looks
            -- like it never took.
            credit_type, credit_length_months,
            is_staff, via, admin_role, perms
       FROM users WHERE id = $1`,
    [req.params.id]
  );
  if (!u.length) return res.status(404).json({ error: 'Not found' });
  const [orders, inquiries, appts, points, account] = await Promise.all([
    query(
      `SELECT id, total_usd, status, payment_method, payment_status, created_at
         FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.params.id]
    ),
    query(
      `SELECT id, vehicle_make, vehicle_model, part_description, status, created_at
         FROM parts_inquiries WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30`,
      [req.params.id]
    ),
    query(
      `SELECT id, service_type, preferred_date, time_slot, status, created_at
         FROM service_appointments WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30`,
      [req.params.id]
    ),
    pointsBalance(req.params.id),
    getAccountBalance(req.params.id),
  ]);
  res.json({
    user: u[0],
    orders: orders.rows,
    inquiries: inquiries.rows,
    appointments: appts.rows,
    points_balance: points,
    account_balance_usd: account,
  });
});

app.post('/api/admin/points/:userId', requireAdmin, async (req, res) => {
  const delta = parseInt(req.body && req.body.delta, 10);
  const reason = (req.body && req.body.reason) || 'admin_adjust';
  if (!Number.isInteger(delta) || delta === 0)
    return res.status(400).json({ error: 'delta (non-zero integer) required' });
  await query(
    `INSERT INTO points_transactions (user_id, delta, reason) VALUES ($1, $2, $3)`,
    [req.params.userId, delta, reason]
  );
  res.json({ ok: true, balance: await pointsBalance(req.params.userId) });
});

// Promote / demote a user to/from staff (admin access). The acting admin
// can't demote themselves — guards against accidentally locking out the
// only admin.
app.patch('/api/admin/users/:id/role', requireManager, async (req, res) => {
  const body = req.body || {};
  const wantsAdmin = body.is_admin !== undefined ? !!body.is_admin : null;
  const wantsRole = (await roleExists(body.admin_role)) ? body.admin_role : null;
  const targetId = parseInt(req.params.id, 10);
  if (!targetId) return res.status(400).json({ error: 'Invalid user id' });
  if (wantsAdmin === null && !wantsRole) return res.status(400).json({ error: 'is_admin or admin_role required' });
  if (targetId === req.session.userId && wantsAdmin === false)
    return res.status(400).json({ error: "You can't revoke your own admin access" });
  // Granting 'owner' is owner-only -- otherwise a manager could promote
  // themselves (or anyone) to owner through this same endpoint they're
  // already allowed to call for ordinary manager/cashier role changes.
  if (wantsRole === 'owner') {
    const { rows: acting } = await query('SELECT admin_role FROM users WHERE id = $1', [req.session.userId]);
    if (!acting.length || acting[0].admin_role !== 'owner')
      return res.status(403).json({ error: 'Only an owner can grant owner access' });
  }
  if (wantsAdmin === false) {
    // Prevent removing the last admin
    const { rows } = await query(
      'SELECT COUNT(*)::int AS n FROM users WHERE is_admin = true AND id <> $1',
      [targetId]
    );
    if (rows[0].n === 0)
      return res.status(400).json({ error: 'Cannot demote the last remaining admin' });
  }
  const sets = []; const vals = [];
  if (wantsAdmin !== null) { vals.push(wantsAdmin); sets.push(`is_admin = $${vals.length}`); }
  if (wantsRole) { vals.push(wantsRole); sets.push(`admin_role = $${vals.length}`); }
  vals.push(targetId);
  const { rows: u } = await query(
    `UPDATE users SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING id, email, name, is_admin, admin_role`,
    vals
  );
  if (!u.length) return res.status(404).json({ error: 'User not found' });
  res.json({ ok: true, user: u[0] });
});

// Per-user function permissions (deny-list into users.perms). Manager+ only,
// and an owner account can only be edited by another owner -- same rule the
// staff PATCH uses.
app.patch('/api/admin/users/:id/perms', requireManager, async (req, res) => {
  const targetId = parseInt(req.params.id, 10);
  if (!targetId) return res.status(400).json({ error: 'Invalid user id' });
  const incoming = (req.body && typeof req.body.perms === 'object' && req.body.perms) || {};

  const { rows: tgt } = await query('SELECT admin_role FROM users WHERE id = $1', [targetId]);
  if (!tgt.length) return res.status(404).json({ error: 'User not found' });
  const { rows: me } = await query('SELECT admin_role FROM users WHERE id = $1', [req.session.userId]);
  const actingRoleCode = me.length ? me[0].admin_role : null;
  if (tgt[0].admin_role === 'owner' && actingRoleCode !== 'owner')
    return res.status(403).json({ error: 'Only an owner can change an owner account.' });
  // Editing a manager's function permissions has no effect (userCan short-
  // circuits for can_manage roles); block it so the UI and the data agree.
  if (await roleCanManage(tgt[0].admin_role))
    return res.status(400).json({ error: 'That role already has full access — per-user permissions only apply to non-manager staff.' });

  // Tri-state: false = deny outright, true = re-grant a capability a category
  // took away. Absent = inherit the category outcome. Anything else is dropped.
  const clean = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (CAPABILITY_KEYS.has(k) && (v === false || v === true)) clean[k] = v;
  }
  await query('UPDATE users SET perms = $1::jsonb WHERE id = $2', [JSON.stringify(clean), targetId]);
  const st = await userPermState(targetId);
  res.json({ ok: true, perms: st.perms, denied: clean });
});

// Create a brand-new staff account directly (admin-only). Useful when the
// staff member shouldn't sign up through the public form first.
// =============================================================================
//  STAFF + USER CATEGORIES
//
//  One people file. A staff member is a `users` row with is_staff = true, and
//  what they do is expressed as categories (sales rep, cashier, mechanic,
//  service advisor, ...) rather than a column per job, so the shop can add a
//  new kind of staff without a schema change.
//
//  is_staff and is_admin are separate. is_admin means "may open the admin
//  panel"; is_staff means "works here". A mechanic who clocks in and is
//  credited on work orders need not be an admin, and granting the panel just
//  to make someone appear in a dropdown is how a shop ends up with six owners.
//
//  `mechanics` survives as a service-department profile rather than a second
//  identity. Eighteen foreign keys point at mechanics(id) -- work orders,
//  labour lines, the time clock, requisitions, stock counts, POS quotes -- so
//  it cannot simply be dropped, and syncStaffProfile() below keeps exactly one
//  row per staff member in step with their categories. That row's user_id is
//  always set, which is what finally makes "which rep is the person signed in"
//  answerable; before this it was never populated by any screen.
// =============================================================================

// Which categories imply a service-department record, and what mechanics.role
// that maps to. mechanics.role predates categories and only understands three
// values, so it is derived rather than stored twice.
function mechanicsRoleFor(codes) {
  const turnsSpanner = codes.includes('mechanic');
  const worksCounter = codes.includes('service_advisor') || codes.includes('sales_rep');
  if (turnsSpanner && worksCounter) return 'both';
  if (turnsSpanner) return 'mechanic';
  if (worksCounter) return 'advisor';
  return null;
}

// Mirrors a user's staff identity into `mechanics`. Called after any change to
// a staff member's categories or contact details.
//
// Never deletes: a mechanics row may be referenced by a work order or a POS
// sale from last year, and deleting it would either fail on the foreign key or
// blank the record of who did the work. Staff who stop being staff have their
// row deactivated, which is what the rest of the app already checks.
async function syncStaffProfile(userId) {
  const { rows: urows } = await query(
    `SELECT u.id, u.name, u.email, u.phone, u.is_staff,
            COALESCE(ARRAY_AGG(c.code) FILTER (WHERE c.code IS NOT NULL), '{}') AS codes
       FROM users u
       LEFT JOIN user_category_members m ON m.user_id = u.id
       LEFT JOIN user_categories c ON c.id = m.category_id AND c.is_active = true
      WHERE u.id = $1
      GROUP BY u.id`,
    [userId]
  );
  if (!urows.length) return null;
  const u = urows[0];
  const role = u.is_staff ? mechanicsRoleFor(u.codes) : null;

  const { rows: existing } = await query('SELECT id FROM mechanics WHERE user_id = $1 LIMIT 1', [userId]);

  if (!role) {
    if (existing.length) await query('UPDATE mechanics SET is_active = false WHERE id = $1', [existing[0].id]);
    return null;
  }
  if (existing.length) {
    await query(
      `UPDATE mechanics SET name = $1, email = $2, phone = $3, role = $4, is_active = true WHERE id = $5`,
      [u.name || u.email, u.email, u.phone, role, existing[0].id]
    );
    return existing[0].id;
  }
  // hourly_rate_usd is NOT NULL with no default the app can rely on; 0 is the
  // honest starting value for someone whose rate has not been set yet.
  const { rows: made } = await query(
    `INSERT INTO mechanics (user_id, name, email, phone, role, hourly_rate_usd, is_active)
       VALUES ($1,$2,$3,$4,$5,0,true) RETURNING id`,
    [userId, u.name || u.email, u.email, u.phone, role]
  );
  return made[0].id;
}

async function actingRole(req) {
  const { rows } = await query('SELECT admin_role FROM users WHERE id = $1', [req.session.userId]);
  return rows.length ? rows[0].admin_role : null;
}
// National ID is statutory payroll data, not counter information.
async function canSeeNationalId(req) {
  return ['owner', 'manager'].includes(await actingRole(req));
}

async function setUserCategories(userId, ids) {
  await query('DELETE FROM user_category_members WHERE user_id = $1', [userId]);
  const clean = (Array.isArray(ids) ? ids : []).map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n));
  if (clean.length) {
    await query(
      `INSERT INTO user_category_members (user_id, category_id)
         SELECT $1, id FROM user_categories WHERE id = ANY($2::int[])
       ON CONFLICT DO NOTHING`,
      [userId, clean]
    );
  }
}

// ---- categories --------------------------------------------------------------
app.get('/api/admin/user-categories', requireAdmin, async (_req, res) => {
  const { rows } = await query(
    `SELECT c.id, c.code, c.label, c.department, c.is_staff, c.sort_order, c.is_active, c.is_system, c.perms,
            (SELECT COUNT(*)::int FROM user_category_members m WHERE m.category_id = c.id) AS member_count
       FROM user_categories c ORDER BY c.sort_order, c.label`
  );
  res.json({ categories: rows });
});

// Category-level function permissions (deny-list into user_categories.perms).
app.patch('/api/admin/user-categories/:id/perms', requireManager, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  const incoming = (req.body && typeof req.body.perms === 'object' && req.body.perms) || {};
  const clean = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (CAPABILITY_KEYS.has(k) && v === false) clean[k] = false;
  }
  const { rowCount } = await query('UPDATE user_categories SET perms = $1::jsonb WHERE id = $2', [JSON.stringify(clean), id]);
  if (!rowCount) return res.status(404).json({ error: 'No such category' });
  res.json({ ok: true, perms: clean });
});

app.post('/api/admin/user-categories', requireManager, async (req, res) => {
  const b = req.body || {};
  const label = String(b.label || '').trim();
  if (!label) return res.status(400).json({ error: 'label required' });
  // Derived from the label when not given, so whoever adds "Tyre fitter" does
  // not have to invent a machine key as well.
  const code = String(b.code || label).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!code) return res.status(400).json({ error: 'label must contain a letter or digit' });
  try {
    const { rows } = await query(
      `INSERT INTO user_categories (code, label, department, is_staff, sort_order, is_system)
         VALUES ($1,$2,$3,$4,$5,false) RETURNING *`,
      [code, label, b.department || null, b.is_staff !== false, b.sort_order != null ? parseInt(b.sort_order, 10) : 100]
    );
    res.json({ ok: true, category: rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'A category with that code already exists' });
    console.error('[user-categories create]', e);
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/admin/user-categories/:id', requireManager, async (req, res) => {
  // `code` is deliberately absent: application code looks categories up by it,
  // so renaming one would silently detach whatever depends on it. The label is
  // what people read and can be changed freely.
  const fields = ['label', 'department', 'is_staff', 'sort_order', 'is_active'];
  const sets = []; const vals = [];
  for (const f of fields) if (req.body && req.body[f] !== undefined) { sets.push(`${f} = $${sets.length + 1}`); vals.push(req.body[f]); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(req.params.id);
  await query(`UPDATE user_categories SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
  res.json({ ok: true });
});

app.delete('/api/admin/user-categories/:id', requireManager, async (req, res) => {
  const { rows } = await query('SELECT is_system, label FROM user_categories WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'No such category' });
  if (rows[0].is_system) {
    return res.status(400).json({
      error: '"' + rows[0].label + '" is built in and is used by the till and the service module. ' +
             'Deactivate it instead of deleting it.',
    });
  }
  await query('DELETE FROM user_categories WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ---- staff -------------------------------------------------------------------
app.get('/api/admin/staff', requireAdmin, async (req, res) => {
  const showNid = await canSeeNationalId(req);
  const { rows } = await query(
    `SELECT u.id, u.name, u.email, u.phone, u.is_admin, u.admin_role, u.employee_no,
            u.is_staff, u.disabled, u.created_at, u.perms, u.forced_favs, u.favs_locked,
            (u.pin_hash IS NOT NULL) AS has_pin, u.pin_set_at,
            ${showNid ? 'u.national_id' : 'NULL::text AS national_id'},
            COALESCE(JSON_AGG(JSON_BUILD_OBJECT('id', c.id, 'code', c.code, 'label', c.label)
                     ORDER BY c.sort_order) FILTER (WHERE c.id IS NOT NULL), '[]') AS categories
       FROM users u
       LEFT JOIN user_category_members m ON m.user_id = u.id
       LEFT JOIN user_categories c ON c.id = m.category_id
      WHERE u.is_staff = true OR u.is_admin = true
      GROUP BY u.id
      ORDER BY u.name NULLS LAST, u.email`
  );
  res.json({ staff: rows, national_id_visible: showNid });
});

app.post('/api/admin/staff', requireManager, async (req, res) => {
  try {
    const b = req.body || {};
    const { email, password, name, phone } = b;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });
    // Validated against the roles table, not a literal, so a role the shop
    // added itself is assignable. Anything unknown falls back to cashier
    // rather than being accepted blindly.
    let role = (await roleExists(b.admin_role)) ? b.admin_role : 'cashier';
    if (role === 'owner') {
      // Same owner-only guard as the role-change endpoint -- creating a new
      // staff account is another path to the same privilege escalation.
      if (await actingRole(req) !== 'owner') role = 'manager';
    }
    // A staff member who should not reach the admin panel can still be staff:
    // they hold categories, clock in and get credited on tickets.
    const isAdmin = b.is_admin !== false;

    // Both hashes computed before anything is written, so a rejected PIN or a
    // malformed one fails with nothing created.
    const hash = await bcrypt.hash(password, 10);
    const pinHash = b.pin ? await validateAndHashPin(b.pin, null) : null;

    // One transaction: a staff member half-created -- a login with no
    // categories, or an account whose PIN never landed -- is worse than a
    // failed request, because nothing on screen says it is incomplete.
    const client = await pool.connect();
    let created;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO users (email, name, password_hash, phone, via, is_admin, admin_role,
                            is_staff, employee_no, national_id, pin_hash, pin_set_at)
           VALUES (lower($1), $2, $3, $4, 'local', $5, $6, true, $7, $8, $9,
                   CASE WHEN $9::text IS NULL THEN NULL ELSE NOW() END)
           RETURNING id, email, name, is_admin, admin_role, employee_no`,
        [email, name || null, hash, phone || null, isAdmin, role,
         b.employee_no || null, b.national_id || null, pinHash]
      );
      created = rows[0];
      const wanted = (Array.isArray(b.categories) ? b.categories : [])
        .map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n));
      if (wanted.length) {
        await client.query(
          `INSERT INTO user_category_members (user_id, category_id)
             SELECT $1, id FROM user_categories WHERE id = ANY($2::int[])
           ON CONFLICT DO NOTHING`,
          [created.id, wanted]
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    // After the commit: it reads the categories that were just stored, and a
    // failure here leaves a valid staff member rather than a broken one.
    await syncStaffProfile(created.id);
    res.json({ ok: true, user: created });
  } catch (e) {
    if (e.userFacing) return res.status(400).json({ error: e.message });
    if (e.code === '23505') {
      const which = String(e.detail || '').includes('employee_no')
        ? 'That employee number is already in use'
        : 'Email already registered — use the promote button on the existing user instead';
      return res.status(409).json({ error: which });
    }
    console.error('[staff create]', e); res.status(500).json({ error: 'Could not create staff account' });
  }
});

app.patch('/api/admin/staff/:id', requireManager, async (req, res) => {
  const b = req.body || {};
  const id = parseInt(req.params.id, 10);

  // Disabling an account is a hard lockout, so it carries the same two guards
  // as a password reset: not yourself, and not an owner unless you are one.
  if (b.disabled === true) {
    if (id === req.session.userId) {
      return res.status(400).json({ error: 'You cannot disable your own account.' });
    }
    const { rows: tgt } = await query('SELECT admin_role FROM users WHERE id = $1', [id]);
    if (tgt.length && tgt[0].admin_role === 'owner' && await actingRole(req) !== 'owner') {
      return res.status(403).json({ error: 'Only an owner can disable an owner account.' });
    }
  }

  const fields = ['name', 'phone', 'employee_no', 'national_id', 'is_staff', 'is_admin', 'disabled', 'favs_locked'];
  const sets = []; const vals = [];
  for (const f of fields) if (b[f] !== undefined) { sets.push(`${f} = $${sets.length + 1}`); vals.push(b[f]); }

  // Manager-preset pinned screens: an array of sidebar tab keys, or null/[] to
  // clear. Stored as jsonb; content is opaque here beyond "array of strings".
  if (b.forced_favs !== undefined) {
    const arr = Array.isArray(b.forced_favs)
      ? b.forced_favs.filter((t) => typeof t === 'string').slice(0, 40)
      : [];
    sets.push(`forced_favs = $${sets.length + 1}::jsonb`);
    vals.push(JSON.stringify(arr));
  }

  if (b.admin_role !== undefined && await roleExists(b.admin_role)) {
    // Only an owner may mint another owner, and nobody may demote themselves
    // out of the last owner seat by accident.
    let role = b.admin_role;
    if (role === 'owner' && await actingRole(req) !== 'owner') role = 'manager';
    sets.push(`admin_role = $${sets.length + 1}`); vals.push(role);
  }

  try {
    if (sets.length) {
      vals.push(id);
      await query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    }
    if (b.categories !== undefined) await setUserCategories(id, b.categories);
    await syncStaffProfile(id);
    res.json({ ok: true });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'That employee number is already in use' });
    console.error('[staff update]', e); res.status(500).json({ error: e.message });
  }
});

// ---- password reset ----------------------------------------------------------
//  A manager setting someone else's password, for the everyday case: a staff
//  member is locked out and standing at the counter. Deliberately not a
//  "send a reset link" flow -- half the roster has no working email, and the
//  person is right there.
//
//  Two guards. Only an owner may reset an owner's password, because otherwise
//  a manager could take the owner's account and with it the one role that can
//  always reach the roles screen. And the actor's own password is not
//  resettable here -- that is /account.html, which asks for the current one
//  first; this endpoint deliberately does not.
app.post('/api/admin/staff/:id/password', requireManager, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const pw = String((req.body && req.body.password) || '');
  if (pw.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const { rows } = await query('SELECT id, name, email, admin_role FROM users WHERE id = $1', [id]);
  if (!rows.length) return res.status(404).json({ error: 'No such staff member' });

  const acting = await actingRole(req);
  if (rows[0].admin_role === 'owner' && acting !== 'owner') {
    return res.status(403).json({ error: 'Only an owner can reset an owner’s password.' });
  }
  if (id === req.session.userId) {
    return res.status(400).json({ error: 'Change your own password from your account page, which checks your current one first.' });
  }

  const hash = await bcrypt.hash(pw, 10);
  await query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, id]);
  console.log('[staff] password reset for', rows[0].email, 'by user', req.session.userId);
  res.json({ ok: true, user: { id: rows[0].id, name: rows[0].name, email: rows[0].email } });
});

// ---- roles -------------------------------------------------------------------
app.get('/api/admin/roles', requireAdmin, async (_req, res) => {
  const { rows } = await query(
    `SELECT r.code, r.label, r.rank, r.can_manage, r.hidden_tabs, r.is_system,
            (SELECT COUNT(*)::int FROM users u WHERE u.admin_role = r.code) AS member_count
       FROM roles r ORDER BY r.rank, r.label`
  );
  res.json({ roles: rows });
});

// What the signed-in user's own role allows. The sidebar asks for this instead
// of carrying its own copy of the rules, which is how the server and the UI
// used to disagree about who could see what.
app.get('/api/admin/roles/mine', requireAdmin, async (req, res) => {
  const { rows: u } = await query('SELECT admin_role FROM users WHERE id = $1', [req.session.userId]);
  const code = u.length ? u[0].admin_role : null;
  const { rows } = await query('SELECT code, label, can_manage, hidden_tabs, rank FROM roles WHERE code = $1', [code]);
  if (!rows.length) {
    // Unknown role: show the least, not the most.
    return res.json({ role: { code: code, label: code || 'unknown', can_manage: code === 'owner', hidden_tabs: [], rank: 99 } });
  }
  const r = rows[0];
  if (code === 'owner') r.can_manage = true;   // matches roleCanManage()
  res.json({ role: r });
});

app.post('/api/admin/roles', requireManager, async (req, res) => {
  const b = req.body || {};
  const label = String(b.label || '').trim();
  if (!label) return res.status(400).json({ error: 'label required' });
  const code = String(b.code || label).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!code) return res.status(400).json({ error: 'label must contain a letter or digit' });

  // You cannot create a role more senior than your own, nor one that can
  // manage if you cannot. Both are the same escalation wearing different hats.
  const acting = await actingRole(req);
  const { rows: mine } = await query('SELECT rank FROM roles WHERE code = $1', [acting]);
  const myRank = acting === 'owner' ? 0 : (mine.length ? mine[0].rank : 99);
  const rank = Math.max(myRank + 1, parseInt(b.rank, 10) || 50);
  const canManage = acting === 'owner' ? !!b.can_manage : (!!b.can_manage && await roleCanManage(acting));

  try {
    const { rows } = await query(
      `INSERT INTO roles (code, label, rank, can_manage, hidden_tabs, is_system)
         VALUES ($1,$2,$3,$4,$5::jsonb,false) RETURNING *`,
      [code, label, rank, canManage, JSON.stringify(Array.isArray(b.hidden_tabs) ? b.hidden_tabs : [])]
    );
    res.json({ ok: true, role: rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'A role with that code already exists' });
    console.error('[roles create]', e); res.status(500).json({ error: e.message });
  }
});

app.patch('/api/admin/roles/:code', requireManager, async (req, res) => {
  const code = req.params.code;
  const b = req.body || {};
  const { rows: target } = await query('SELECT * FROM roles WHERE code = $1', [code]);
  if (!target.length) return res.status(404).json({ error: 'No such role' });

  const acting = await actingRole(req);
  // Nobody edits a role at or above their own rank. Without this, a manager
  // could tick can_manage on their way to owner, or untick the owner's.
  const { rows: mine } = await query('SELECT rank FROM roles WHERE code = $1', [acting]);
  const myRank = acting === 'owner' ? 0 : (mine.length ? mine[0].rank : 99);
  if (acting !== 'owner' && target[0].rank <= myRank) {
    return res.status(403).json({ error: 'You cannot change a role at or above your own level.' });
  }
  if (target[0].code === 'owner') {
    return res.status(400).json({ error: 'The Owner role cannot be edited — it is the way back in if a permission is set wrong.' });
  }

  const sets = []; const vals = [];
  if (b.label !== undefined)       { sets.push(`label = $${sets.length + 1}`); vals.push(String(b.label).trim()); }
  if (b.can_manage !== undefined)  { sets.push(`can_manage = $${sets.length + 1}`); vals.push(!!b.can_manage); }
  if (b.hidden_tabs !== undefined) { sets.push(`hidden_tabs = $${sets.length + 1}::jsonb`); vals.push(JSON.stringify(Array.isArray(b.hidden_tabs) ? b.hidden_tabs : [])); }
  if (b.rank !== undefined && !target[0].is_system) {
    sets.push(`rank = $${sets.length + 1}`); vals.push(Math.max(myRank + 1, parseInt(b.rank, 10) || 50));
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(code);
  await query(`UPDATE roles SET ${sets.join(', ')} WHERE code = $${vals.length}`, vals);
  res.json({ ok: true });
});

app.delete('/api/admin/roles/:code', requireManager, async (req, res) => {
  const { rows } = await query('SELECT is_system, label FROM roles WHERE code = $1', [req.params.code]);
  if (!rows.length) return res.status(404).json({ error: 'No such role' });
  if (rows[0].is_system) return res.status(400).json({ error: '"' + rows[0].label + '" is a built-in role and cannot be deleted.' });
  // No foreign key from users.admin_role, so deleting a role in use would
  // silently leave those staff holding a code that grants nothing.
  const { rows: held } = await query('SELECT COUNT(*)::int AS n FROM users WHERE admin_role = $1', [req.params.code]);
  if (held[0].n > 0) {
    return res.status(400).json({ error: held[0].n + ' staff still have this role. Move them to another role first.' });
  }
  await query('DELETE FROM roles WHERE code = $1', [req.params.code]);
  res.json({ ok: true });
});

// ---- staff PIN ---------------------------------------------------------------
//  Used for three things at the counter: signing in on a shared till,
//  authorising an override (a discount past the cap, a void, a refund) without
//  signing the cashier out, and clocking in and out.
//
//  Hashed with bcrypt like a password. A four-digit PIN has ten thousand
//  possibilities, so the hash is not what protects it -- the throttle below and
//  the fact it only works on the shop's own LAN are. Storing it in clear
//  "because it is only a PIN" would hand over every staff identity in one
//  SELECT, which is exactly the identity the till trusts.
const PIN_MIN = 4, PIN_MAX = 8;

// The PIN a brand-new install gives its default admin, so the keypad works the
// moment a till is set up. Set once, on an account that has none -- never reset
// on later boots, or a shop that changed it would find the factory PIN back
// every morning. Change it in Settings -> Users & Staff.
const DEFAULT_ADMIN_PIN = String(process.env.MH_DEFAULT_ADMIN_PIN || '1010').trim();

// Verification has to compare against every staff PIN, because the whole point
// is that the person types a PIN and nothing else -- there is no user name to
// look up first. That makes a duplicate PIN genuinely ambiguous: two people
// would both match and the till would credit whichever bcrypt reached first.
// Rejected at the point of setting, which is the only place it can be resolved.
async function pinCollides(pin, exceptUserId) {
  const { rows } = await query(
    `SELECT id, pin_hash FROM users WHERE pin_hash IS NOT NULL AND id <> $1`,
    [exceptUserId || 0]
  );
  for (const r of rows) {
    if (await bcrypt.compare(pin, r.pin_hash)) return true;
  }
  return false;
}

// Split from setStaffPin so a create can check the PIN before writing anything.
// Validating after the INSERT left a half-made staff account behind every time
// someone picked a PIN that was already taken -- the request failed, and the
// person existed anyway with no PIN and no way to sign in.
async function validateAndHashPin(pin, exceptUserId) {
  const clean = String(pin == null ? '' : pin).trim();
  if (!/^[0-9]+$/.test(clean) || clean.length < PIN_MIN || clean.length > PIN_MAX) {
    const e = new Error('PIN must be ' + PIN_MIN + ' to ' + PIN_MAX + ' digits');
    e.userFacing = true; throw e;
  }
  if (await pinCollides(clean, exceptUserId)) {
    const e = new Error('Another staff member already uses that PIN. PINs identify the person on their own, so each has to be different.');
    e.userFacing = true; throw e;
  }
  return bcrypt.hash(clean, 10);
}

async function setStaffPin(userId, pin) {
  const hash = await validateAndHashPin(pin, userId);
  await query('UPDATE users SET pin_hash = $1, pin_set_at = NOW() WHERE id = $2', [hash, userId]);
}

app.post('/api/admin/staff/:id/pin', requireManager, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (req.body && req.body.clear) {
      await query('UPDATE users SET pin_hash = NULL, pin_set_at = NULL WHERE id = $1', [id]);
      return res.json({ ok: true, cleared: true });
    }
    await setStaffPin(id, req.body && req.body.pin);
    res.json({ ok: true });
  } catch (e) {
    if (e.userFacing) return res.status(400).json({ error: e.message });
    console.error('[staff pin]', e); res.status(500).json({ error: e.message });
  }
});

// Reset to a fresh random 4-digit PIN and hand it back once so a manager can
// read it out. The everyday "they forgot their PIN" case -- no typing, no
// collision to resolve by hand. Obvious sequences are skipped.
app.post('/api/admin/staff/:id/pin/reset', requireManager, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rows } = await query('SELECT id, name FROM users WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'No such staff member' });
    const banned = new Set(['0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999', '1234', '4321', '1010']);
    let pin = null;
    for (let i = 0; i < 40 && !pin; i++) {
      const cand = String(nodeCrypto.randomInt(0, 10000)).padStart(4, '0');
      if (banned.has(cand)) continue;
      if (!(await pinCollides(cand, id))) pin = cand;
    }
    if (!pin) return res.status(409).json({ error: 'Could not find a free PIN — clear some unused ones and try again.' });
    await setStaffPin(id, pin);
    console.log('[staff] PIN reset for', rows[0].name || id, 'by user', req.session.userId);
    res.json({ ok: true, pin, name: rows[0].name });
  } catch (e) {
    if (e.userFacing) return res.status(400).json({ error: e.message });
    console.error('[staff pin reset]', e); res.status(500).json({ error: e.message });
  }
});

// Brute force is the real threat to four digits, so failures are counted per
// source and the door shuts for a minute after ten. In memory on purpose: this
// is a till on a shop LAN, the counter resets when the server restarts, and a
// table would turn every keypad tap into a write.
const PIN_ATTEMPTS = new Map();
const PIN_MAX_TRIES = 10, PIN_LOCK_MS = 60000;

function pinGate(key) {
  const now = Date.now();
  const rec = PIN_ATTEMPTS.get(key) || { fails: 0, until: 0 };
  if (rec.until > now) return { blocked: true, waitS: Math.ceil((rec.until - now) / 1000) };
  return { blocked: false, rec };
}
function pinFail(key, rec) {
  rec.fails++;
  if (rec.fails >= PIN_MAX_TRIES) { rec.until = Date.now() + PIN_LOCK_MS; rec.fails = 0; }
  PIN_ATTEMPTS.set(key, rec);
}

app.post('/api/admin/staff/pin-verify', requireAdmin, async (req, res) => {
  const purpose = String((req.body && req.body.purpose) || 'signin');
  const key = req.ip || 'local';
  const gate = pinGate(key);
  if (gate.blocked) {
    return res.status(429).json({ error: 'Too many wrong PINs. Try again in ' + gate.waitS + 's.' });
  }
  const pin = String((req.body && req.body.pin) || '').trim();
  if (!pin) return res.status(400).json({ error: 'PIN required' });

  const { rows } = await query(
    `SELECT u.id, u.name, u.email, u.admin_role, u.pin_hash, u.is_staff,
            COALESCE(ARRAY_AGG(c.code) FILTER (WHERE c.code IS NOT NULL), '{}') AS codes
       FROM users u
       LEFT JOIN user_category_members m ON m.user_id = u.id
       LEFT JOIN user_categories c ON c.id = m.category_id AND c.is_active = true
      WHERE u.pin_hash IS NOT NULL AND u.is_staff = true
      GROUP BY u.id`
  );
  let hit = null;
  for (const r of rows) {
    if (await bcrypt.compare(pin, r.pin_hash)) { hit = r; break; }
  }
  if (!hit) {
    pinFail(key, gate.rec);
    return res.status(401).json({ error: 'PIN not recognised' });
  }
  PIN_ATTEMPTS.delete(key);

  // An override is a manager decision. Recognising the PIN proves who it is,
  // not that they are allowed to approve the thing being asked.
  if (purpose === 'override' && !['owner', 'manager'].includes(hit.admin_role)) {
    return res.status(403).json({ error: (hit.name || 'That staff member') + ' cannot authorise this — a manager is needed.' });
  }

  const { rows: mech } = await query('SELECT id FROM mechanics WHERE user_id = $1 AND is_active = true LIMIT 1', [hit.id]);
  res.json({
    ok: true,
    purpose,
    user: {
      id: hit.id, name: hit.name, email: hit.email,
      admin_role: hit.admin_role, categories: hit.codes,
      rep_id: mech.length ? mech[0].id : null,
    },
  });
});

app.delete('/api/admin/reviews/:id', requireAdmin, async (req, res) => {
  await query('DELETE FROM reviews WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// One list covering every way a sale leaves the building: storefront orders
// (`orders`) and counter sales (`pos_sales`), normalised to a shared shape and
// filterable by source / status / payment / fulfilment / date / customer.
// The old version was storefront-only and hard-coded to 200 newest rows.
app.get('/api/admin/orders', requireAdmin, async (req, res) => {
  const q = req.query || {};
  const source     = ['online', 'counter'].includes(q.source) ? q.source : null;
  const status     = q.status ? String(q.status) : null;
  const payment    = q.payment ? String(q.payment) : null;
  const fulfilment = ['pickup', 'delivery', 'shipping'].includes(q.fulfilment) ? q.fulfilment : null;
  const custType   = ['guest', 'account'].includes(q.type) ? q.type : null;
  const from       = q.from ? String(q.from) : null;
  const to         = q.to ? String(q.to) : null;
  const search     = q.q ? String(q.q).trim() : null;
  const limit      = Math.min(1000, Math.max(1, parseInt(q.limit, 10) || 300));

  const unionSql = `
    SELECT 'online'::text AS source, o.id,
           ('#' || o.id) AS ref, o.created_at,
           u.name AS customer_name, u.email AS customer_email, u.phone AS customer_phone,
           (o.user_id IS NULL) AS is_guest,
           (SELECT COUNT(*)::int FROM order_items oi WHERE oi.order_id = o.id) AS item_count,
           o.total_usd::float AS total_usd,
           o.status, o.payment_method, o.payment_status,
           NULL::text AS fulfilment, false AS voided
      FROM orders o LEFT JOIN users u ON u.id = o.user_id
    UNION ALL
    SELECT 'counter'::text AS source, s.id,
           s.receipt_number AS ref, s.created_at,
           s.customer_name, NULL::text AS customer_email, s.customer_phone,
           (s.customer_id IS NULL) AS is_guest,
           (SELECT COUNT(*)::int FROM pos_sale_items psi WHERE psi.sale_id = s.id) AS item_count,
           s.total_usd::float AS total_usd,
           (CASE WHEN s.voided THEN 'voided' ELSE 'completed' END) AS status,
           s.payment_method, s.payment_status, s.fulfilment, s.voided
      FROM pos_sales s`;

  const params = [source, status, payment, fulfilment, custType, from, to, search];
  const where = `
    WHERE ($1::text IS NULL OR x.source = $1)
      AND ($2::text IS NULL OR x.status = $2)
      AND ($3::text IS NULL OR x.payment_status = $3)
      AND ($4::text IS NULL OR x.fulfilment = $4)
      AND ($5::text IS NULL OR ($5 = 'guest' AND x.is_guest) OR ($5 = 'account' AND NOT x.is_guest))
      AND ($6::date IS NULL OR x.created_at::date >= $6::date)
      AND ($7::date IS NULL OR x.created_at::date <= $7::date)
      AND ($8::text IS NULL OR x.customer_name ILIKE '%'||$8||'%' OR x.customer_email ILIKE '%'||$8||'%'
                            OR x.customer_phone ILIKE '%'||$8||'%' OR x.ref ILIKE '%'||$8||'%')`;

  try {
    const [page, agg] = await Promise.all([
      query(`WITH x AS (${unionSql}) SELECT x.* FROM x ${where} ORDER BY x.created_at DESC LIMIT $9`,
        [...params, limit]),
      query(`WITH x AS (${unionSql}) SELECT COUNT(*)::int AS n, COALESCE(SUM(x.total_usd),0)::float AS total FROM x ${where}`,
        params),
    ]);
    res.json({ orders: page.rows, summary: agg.rows[0], limit });
  } catch (e) {
    console.error('[orders list]', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/orders/:id', requireAdmin, async (req, res) => {
  const { rows: orderRows } = await query(
    `SELECT o.*, u.email AS user_email, u.name AS user_name
       FROM orders o LEFT JOIN users u ON u.id = o.user_id WHERE o.id = $1`,
    [req.params.id]
  );
  if (!orderRows.length) return res.status(404).json({ error: 'Not found' });
  const { rows: items } = await query(
    `SELECT oi.product_img, oi.qty, oi.price_usd, p.name, p.make_model
       FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
       WHERE oi.order_id = $1`,
    [req.params.id]
  );
  res.json({ order: orderRows[0], items: items });
});

app.patch('/api/admin/orders/:id', requireAdmin, async (req, res) => {
  const { status } = req.body || {};
  if (!['pending','confirmed','ready','completed','cancelled'].includes(status))
    return res.status(400).json({ error: 'Invalid status' });
  await query('UPDATE orders SET status = $1 WHERE id = $2', [status, req.params.id]);
  res.json({ ok: true });
});

app.post('/api/admin/notify-back-in-stock', requireAdmin, async (_req, res) => {
  const { rows } = await query(
    `SELECT n.id, n.email, n.phone, p.img AS product_img, p.name AS product_name, p.price_usd
       FROM notify_subscriptions n
       JOIN products p ON p.id = n.product_id
       WHERE n.notified_at IS NULL AND p.stock_count > 0`
  );
  let emails_sent = 0, sms_sent = 0;
  for (const sub of rows) {
    let ok = false;
    try {
      const t = mailer.templates.backInStockEmail(sub);
      await mailer.sendEmail({ to: sub.email, ...t });
      emails_sent++;
      ok = true;
    } catch (e) {
      console.warn('[mailer] back-in-stock email failed for', sub.email, e.message);
    }
    if (sub.phone) {
      try {
        await sms.sendSMS({
          to: sub.phone,
          body: sms.templates.backInStock({ product: sub.product_name }),
        });
        sms_sent++;
        ok = true;
      } catch (e) {
        console.warn('[sms] back-in-stock SMS failed for', sub.phone, e.message);
      }
    }
    if (ok) {
      await query('UPDATE notify_subscriptions SET notified_at = NOW() WHERE id = $1', [sub.id]);
    }
  }
  res.json({ candidates: rows.length, emails_sent, sms_sent });
});

// Admin product list (includes inactive items so they can be toggled back on)
app.get('/api/admin/products', requireAdmin, async (_req, res) => {
  const { rows } = await query(
    `SELECT img, name, make_model, category, condition, price_usd::float AS price_usd,
            stock_count, low_threshold, is_active, created_at
       FROM products ORDER BY created_at DESC, name ASC`
  );
  res.json({ products: rows });
});

// One product, full admin row (includes cost_usd / supplier, which the public
// /api/products deliberately omits). Used by the Products/Stock edit modal.
app.get('/api/admin/products/:img', requireAdmin, async (req, res) => {
  const { rows } = await query(
    `SELECT p.img, p.name, p.make_model, p.category, p.condition,
            p.price_usd::float AS price_usd, p.cost_usd::float AS cost_usd,
            p.stock_count, p.low_threshold, p.is_active, p.sku, p.barcode,
            p.location, p.bin_location, p.supplier_id, s.name AS supplier_name
       FROM products p LEFT JOIN suppliers s ON s.id = p.supplier_id
      WHERE p.img = $1`, [req.params.img]);
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  res.json({ product: rows[0] });
});

app.patch('/api/admin/products/:img', requireAdmin, async (req, res) => {
  const b = req.body || {};
  if ((b.price_usd != null || b.cost_usd != null) && !(await userCan(req, 'inventory.edit_price')))
    return res.status(403).json({ error: 'Your account is not allowed to edit product pricing.' });
  if (b.stock_count != null && !(await userCan(req, 'inventory.adjust_stock')))
    return res.status(403).json({ error: 'Your account is not allowed to adjust stock counts.' });
  const sets = []; const params = [];
  if (b.stock_count != null){ params.push(parseInt(b.stock_count, 10)); sets.push(`stock_count = $${params.length}`); }
  if (b.price_usd != null){ params.push(Number(b.price_usd)); sets.push(`price_usd = $${params.length}`); }
  if (b.cost_usd != null){ params.push(b.cost_usd === '' ? null : Number(b.cost_usd)); sets.push(`cost_usd = $${params.length}`); }
  if (b.supplier_id !== undefined){ params.push(b.supplier_id ? parseInt(b.supplier_id, 10) : null); sets.push(`supplier_id = $${params.length}`); }
  if (b.low_threshold != null){ params.push(Math.max(0, parseInt(b.low_threshold, 10) || 0)); sets.push(`low_threshold = $${params.length}`); }
  if (b.is_active != null){ params.push(!!b.is_active); sets.push(`is_active = $${params.length}`); }
  if (b.name != null){ params.push(String(b.name)); sets.push(`name = $${params.length}`); }
  if (b.sku != null){ params.push(String(b.sku).trim() || null); sets.push(`sku = $${params.length}`); }
  if (b.barcode != null){ params.push(String(b.barcode).trim() || null); sets.push(`barcode = $${params.length}`); }
  if (b.make_model != null){ params.push(String(b.make_model)); sets.push(`make_model = $${params.length}`); }
  if (b.category != null){ params.push(String(b.category)); sets.push(`category = $${params.length}`); }
  if (b.condition != null){ params.push(String(b.condition)); sets.push(`condition = $${params.length}`); }
  if (b.location != null){ params.push(String(b.location)); sets.push(`location = $${params.length}`); }
  if (b.bin_location != null){ params.push(String(b.bin_location)); sets.push(`bin_location = $${params.length}`); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  params.push(req.params.img);
  try {
    await query(`UPDATE products SET ${sets.join(', ')} WHERE img = $${params.length}`, params);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'That SKU or barcode is already used by another part.' });
    throw e;
  }
  res.json({ ok: true });
});

// Create a new product (with photo upload). Photo can come from a mobile
// camera (the front-end form uses <input accept="image/*" capture="environment">).
// The uploaded file is stored under /uploads/products/<id>.<ext>, and the
// product's img field is set to that relative URL so <img src=…> resolves.
app.post('/api/admin/products', requireAdmin, upload.single('photo'), async (req, res) => {
  try {
    const b = req.body || {};
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'Photo is required' });
    if (!b.name || !b.category) return res.status(400).json({ error: 'name and category are required' });
    const condition = ['NEW','USED'].includes((b.condition||'').toUpperCase()) ? b.condition.toUpperCase() : 'USED';
    // Move the uploaded file into /uploads/products/ so admin product photos
    // are separated from inquiry photos.
    const productsDir = path.join(UPLOAD_DIR, 'products');
    fs.mkdirSync(productsDir, { recursive: true });
    const ext = (path.extname(file.originalname || '').toLowerCase() || '.jpg').slice(0, 6);
    const newName = `prod-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
    const destPath = path.join(productsDir, newName);
    fs.renameSync(file.path, destPath);
    const imgUrl = `/uploads/products/${newName}`;
    await query(
      `INSERT INTO products (img, name, make_model, category, condition, price_usd, stock_count, low_threshold, location, bin_location)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [imgUrl, b.name, b.make_model || '', b.category, condition,
       b.price_usd ? Number(b.price_usd) : null,
       b.stock_count != null ? parseInt(b.stock_count,10) : 1,
       b.low_threshold != null ? parseInt(b.low_threshold,10) : 0,
       b.location || null, b.bin_location || null]
    );
    res.json({ ok: true, img: imgUrl });
  } catch (e) {
    console.error('[admin product create]', e);
    res.status(500).json({ error: e.message || 'Could not create product' });
  }
});

// Delete (deactivate) a product. We soft-delete by flipping is_active so
// existing order_items / cart_items aren't broken.
app.delete('/api/admin/products/:img', requireManager, async (req, res) => {
  await query('UPDATE products SET is_active = false WHERE img = $1', [req.params.img]);
  res.json({ ok: true });
});

// =============================================================================
//  VIN DECODER (proxies NHTSA's free DecodeVinValues API)
// =============================================================================
app.get('/api/vin/:vin', async (req, res) => {
  const vin = (req.params.vin || '').trim().toUpperCase();
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) {
    return res.status(400).json({ error: 'VIN must be 17 letters/numbers (no I, O, Q)' });
  }
  try {
    const r = await fetch(
      `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${vin}?format=json`,
      { headers: { 'Accept': 'application/json' } }
    );
    if (!r.ok) throw new Error('NHTSA returned ' + r.status);
    const data = await r.json();
    const v = (data.Results && data.Results[0]) || {};
    res.json({
      vin,
      make: v.Make || null,
      model: v.Model || null,
      year: v.ModelYear || null,
      manufacturer: v.Manufacturer || null,
      body: v.BodyClass || null,
      engine: v.DisplacementL ? v.DisplacementL + 'L' : null,
      cylinders: v.EngineCylinders || null,
      fuel: v.FuelTypePrimary || null,
      drive: v.DriveType || null,
      trim: v.Trim || null,
      plant: v.PlantCountry || null,
    });
  } catch (e) {
    console.warn('[vin] decode failed:', e.message);
    res.status(502).json({ error: 'VIN decoder unavailable. Try again shortly.' });
  }
});

// =============================================================================
//  PUBLIC CONFIG
// =============================================================================
// ---- HEALTH ---------------------------------------------------------------
// Unauthenticated readiness probe. start-melthahonda.bat has advertised this
// URL since day one but nothing ever implemented it, so anything watching it
// (the portable launcher's "is it up yet?" poll, a second till waiting for
// the counter PC to finish booting, an uptime monitor) was watching a 404.
// Deliberately says nothing a stranger on the LAN shouldn't know: no host,
// no credentials, no version -- just whether the process answers and whether
// its database round-trips.
app.get('/api/health', async (_req, res) => {
  let db = 'down';
  try {
    await pool.query('SELECT 1');
    db = 'up';
  } catch (_) {}
  res.json({ ok: true, db, uptime_s: Math.round(process.uptime()) });
});

app.get('/api/config', (_req, res) => {
  res.json({
    payments: {
      stripe_enabled: payments.isActive(),
      stripe_publishable_key: payments.publishableKey(),
      methods: payments.isActive()
        ? ['cash_pickup', 'bank_transfer', 'stripe']
        : ['cash_pickup', 'bank_transfer'],
    },
  });
});

// =============================================================================
//  PRODUCTS
//
//  buildProductWhere() is shared by /api/products and /api/products/count so
//  the two can never drift on what "matches" means. Search matches against
//  `search_text` -- a generated column (schema.sql) concatenating
//  name/make_model/sku/barcode into one lowercased string -- with a plain
//  LIKE '%term%'. This used to be a 4-column OR (lower(name) LIKE ... OR
//  lower(make_model) LIKE ... OR ...), one trigram index per column; that
//  was load-tested at 100,000 rows and took 1.5 SECONDS per search -- the
//  planner wasn't using any of the four trigram indexes (see schema.sql's
//  "Search column consolidation" note for the measured EXPLAIN ANALYZE).
//  One combined column + one trigram index is what the planner actually
//  picks up: same measurement re-run afterward came back at low tens of ms
//  for a generic term and ~10ms for a specific one (a part number/SKU,
//  which is most real POS searches). See schema.sql's "SEARCH PERFORMANCE"
//  block.
// =============================================================================
function buildProductWhere(q) {
  const params = [];
  let where = 'is_active = true';
  if (q.category) { params.push(q.category); where += ` AND category = $${params.length}`; }
  if (q.condition) { params.push(q.condition); where += ` AND condition = $${params.length}`; }
  // stock_status supersedes the older in_stock=1 flag (kept for the storefront
  // call sites that already send it) -- both map onto the same stock_count/
  // low_threshold comparison the SELECT's stock_level column uses, so the
  // filter and the badge shown for a row can never disagree.
  const stockStatus = q.stock_status || (String(q.in_stock) === '1' ? 'in' : '');
  if (stockStatus === 'out') where += ' AND stock_count <= 0';
  else if (stockStatus === 'low') where += ' AND stock_count > 0 AND stock_count <= low_threshold';
  else if (stockStatus === 'in') where += ' AND stock_count > 0';
  if (q.make_model) { params.push(q.make_model); where += ` AND make_model = $${params.length}`; }
  if (q.location)   { params.push(q.location);   where += ` AND location = $${params.length}`; }
  const priceMin = Number(q.price_min);
  if (Number.isFinite(priceMin) && priceMin > 0) { params.push(priceMin); where += ` AND price_usd >= $${params.length}`; }
  const priceMax = Number(q.price_max);
  if (Number.isFinite(priceMax) && priceMax > 0) { params.push(priceMax); where += ` AND price_usd <= $${params.length}`; }
  // Multi-pass comma-separated search: every term (up to 4) must match somewhere
  // in search_text (name/make_model/sku/barcode). e.g. "oil, bung, toyo, corolla"
  // narrows the result to e.g. a Honda Civic oil drain bung.
  if (q.q) {
    const terms = String(q.q).split(',').map(t => t.trim().toLowerCase()).filter(Boolean).slice(0, 4);
    for (const t of terms) {
      params.push('%' + t + '%');
      where += ` AND search_text LIKE $${params.length}`;
    }
  }
  return { where, params };
}

const PRODUCT_SORTS = {
  name: 'category, name',
  name_asc: 'name ASC',
  name_desc: 'name DESC',
  price_asc: 'price_usd ASC NULLS LAST, name',
  price_desc: 'price_usd DESC NULLS LAST, name',
  stock_asc: 'stock_count ASC, name',
  stock_desc: 'stock_count DESC, name',
};

app.get('/api/products', async (req, res) => {
  try {
    // The storefront (public, unauthenticated) sends compact=1 on every
    // call it makes; the POS terminal's own query builder (posQueryString())
    // never does. That's a free, zero-cost signal for "is this a public
    // storefront browse" -- exactly the one case queryWithFallback() exists
    // for. POS/admin calls (and anything else hitting this shared endpoint)
    // stay on the plain, local-only `query`, on purpose -- see the big
    // comment on queryWithFallback() near the pool setup.
    const q = req.query.compact ? queryWithFallback : query;
    const { where, params } = buildProductWhere(req.query);
    const orderBy = PRODUCT_SORTS[req.query.sort] || PRODUCT_SORTS.name;
    // Hard cap on limit -- an unbounded page size is exactly the kind of
    // request that used to pull the entire catalogue (23k+ cards) into one
    // response and one DOM paint. 200 is generous for a single screen at any
    // of the POS's grid/list/compact densities.
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 60));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

    // The plain "just opened the POS terminal, nothing typed yet" case --
    // no search, no category/condition/stock filter -- is the single most
    // common request this endpoint gets, and COUNT(*) OVER() below forces
    // Postgres to walk *every* matching row (up to the whole table) just to
    // attach a total to the page it returns, even though only `limit` rows
    // are ever used. Measured at 100,000 rows: 550-1100ms, repeatably, not
    // a cold-cache artifact -- every POS tab open would pay that. For this
    // one unfiltered case, skip the exact count and use Postgres's own
    // planner statistic (pg_class.reltuples) instead: a metadata lookup,
    // not a scan, so it's near-instant. It can lag behind the last ANALYZE,
    // which is fine -- pagination needs "about how many pages", not an
    // exact figure (the same trade-off "about 100,000 results" search UIs
    // everywhere make). Any real filter (search, category, condition,
    // stock) falls through to the exact windowed count, which stays fast
    // on its own because a real filter narrows the row count the same way
    // the search itself got faster -- see buildProductWhere().
    if (where === 'is_active = true') {
      const [{ rows }, { rows: estRows }] = await Promise.all([
        q(
          `SELECT img, name, make_model, category, condition, price_usd, stock_count, low_threshold,
                  sku, barcode, bin_location, location,
                  CASE WHEN stock_count <= 0 THEN 'out'
                       WHEN stock_count <= low_threshold THEN 'low'
                       ELSE 'in' END AS stock_level
             FROM products WHERE ${where} ORDER BY ${orderBy} LIMIT $1 OFFSET $2`,
          [limit, offset]
        ),
        q(`SELECT reltuples::bigint AS estimate FROM pg_class WHERE relname = 'products'`),
      ]);
      const estimate = (estRows[0] && Number(estRows[0].estimate)) || 0;
      // reltuples counts inactive rows too and can be stale right after a
      // bulk load (before autovacuum's next ANALYZE) -- never show a total
      // smaller than the page already being returned.
      const total = Math.max(estimate, offset + rows.length);
      // count_mode tells the UI how to phrase this: reltuples is a planner
      // estimate that can land either side of the truth, so "about 25,000" --
      // not "25,000+", which would claim a floor it cannot promise.
      return res.json({ products: rows, total, limit, offset, approximate: true, count_mode: 'estimate' });
    }

    // The page and the count are two queries on purpose, run in parallel.
    //
    // COUNT(*) OVER() looks free -- one round trip, no second query -- and it
    // is anything but. The window function has to see every matching row, so
    // the planner cannot use the LIMIT to stop early, and it abandons the
    // trigram index in favour of walking the ORDER BY index over the whole
    // match set. Measured at 25,000 rows: 81-87ms for an ordinary search term.
    //
    // Split apart, each half gets the plan it wants: the page walks
    // idx_products_category_name and stops after `limit` (3-7ms), the count
    // uses the trigram GIN index as a bitmap scan (4-6ms). Same two round
    // trips overlapped, 12-15ms total -- about six times faster.
    const countParams = params.slice();
    params.push(limit, offset);

    // Counting is the one part that cannot use the trigram index when a term
    // is shorter than three characters (pg_trgm has no trigrams to look up),
    // and a cashier types exactly those characters on the way to a real word.
    // An unbounded count there is a full scan on every keystroke -- 31ms at
    // 25k rows, and linear in catalogue size after that. Stop counting past
    // the cap and say "5,000+", which is all a pagination control can use
    // anyway.
    const COUNT_CAP = 5000;

    const [pageRes, cntRes] = await Promise.all([
      q(
        `SELECT img, name, make_model, category, condition, price_usd, stock_count, low_threshold,
                sku, barcode, bin_location, location,
                CASE WHEN stock_count <= 0 THEN 'out'
                     WHEN stock_count <= low_threshold THEN 'low'
                     ELSE 'in' END AS stock_level
           FROM products WHERE ${where} ORDER BY ${orderBy} LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      ),
      q(
        `SELECT count(*)::int AS total FROM (
           SELECT 1 FROM products WHERE ${where} LIMIT ${COUNT_CAP + 1}) t`,
        countParams
      ),
    ]);

    const rows = pageRes.rows;
    const counted = (cntRes.rows[0] && cntRes.rows[0].total) || 0;
    const capped = counted > COUNT_CAP;
    // Never report fewer than the page already shows -- at a deep offset the
    // capped count would otherwise be smaller than the rows in hand.
    const total = Math.max(capped ? COUNT_CAP : counted, offset + rows.length);
    res.json({ products: rows, total, limit, offset, approximate: capped, count_mode: capped ? 'capped' : 'exact' });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Companion to the above -- lets a caller get an accurate count without
// paying for a row payload (used by tabs that only need "X results" text).
// Shares buildProductWhere() so it can't disagree with what /api/products
// actually returns, including when `q` is set (the old caller-side version
// of this endpoint didn't exist at all, so every call silently failed and
// callers never got a total while searching).
app.get('/api/products/count', async (req, res) => {
  try {
    const { where, params } = buildProductWhere(req.query);
    const { rows } = await query(`SELECT COUNT(*)::int AS count FROM products WHERE ${where}`, params);
    res.json({ count: rows[0].count });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/products/:img', async (req, res) => {
  const { rows } = await query(
    'SELECT * FROM products WHERE img = $1 AND is_active = true',
    [req.params.img]
  );
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  res.json({ product: rows[0] });
});

// =============================================================================
//  CART
// =============================================================================
app.get('/api/cart', requireAuth, async (req, res) => {
  const { rows } = await query(
    `SELECT c.product_img AS img, c.qty, p.name, p.make_model, p.price_usd, p.condition
       FROM cart_items c JOIN products p ON p.id = c.product_id
       WHERE c.user_id = $1 ORDER BY c.updated_at DESC`,
    [req.session.userId]
  );
  const total = rows.reduce((s, r) => s + Number(r.price_usd || 0) * r.qty, 0);
  res.json({ cart: rows, total_usd: total });
});

app.post('/api/cart', requireAuth, async (req, res) => {
  const { img, qty = 1 } = req.body || {};
  if (!img) return res.status(400).json({ error: 'img is required' });
  await query(
    `INSERT INTO cart_items (user_id, product_img, product_id, qty) VALUES ($1, $2, (SELECT id FROM products WHERE img = $2), $3)
       ON CONFLICT (user_id, product_img)
         DO UPDATE SET qty = cart_items.qty + EXCLUDED.qty, updated_at = NOW()`,
    [req.session.userId, img, qty]
  );
  res.json({ ok: true });
});

app.patch('/api/cart/:img', requireAuth, async (req, res) => {
  const qty = parseInt(req.body && req.body.qty, 10);
  if (!Number.isFinite(qty)) return res.status(400).json({ error: 'qty required' });
  if (qty <= 0) {
    await query('DELETE FROM cart_items WHERE user_id = $1 AND product_img = $2', [req.session.userId, req.params.img]);
  } else {
    await query('UPDATE cart_items SET qty = $3, updated_at = NOW() WHERE user_id = $1 AND product_img = $2', [req.session.userId, req.params.img, qty]);
  }
  res.json({ ok: true });
});

app.delete('/api/cart/:img', requireAuth, async (req, res) => {
  await query('DELETE FROM cart_items WHERE user_id = $1 AND product_img = $2', [req.session.userId, req.params.img]);
  res.json({ ok: true });
});

// =============================================================================
//  COUPONS
//  Codes stack on top of loyalty-point redemption. Order of application:
//    subtotal → minus coupon → minus loyalty points → final total.
// =============================================================================
async function loadCoupon(rawCode) {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!code) return { ok: false, error: 'Coupon code required' };
  const { rows } = await query(
    `SELECT code, kind, amount::float AS amount, min_subtotal::float AS min_subtotal,
            max_redemptions, redeemed_count, expires_at, is_active, description
       FROM coupons WHERE code = $1`,
    [code]
  );
  const c = rows[0];
  if (!c) return { ok: false, error: 'Invalid coupon code' };
  if (!c.is_active) return { ok: false, error: 'This coupon is no longer active' };
  if (c.expires_at && new Date(c.expires_at) < new Date()) return { ok: false, error: 'This coupon has expired' };
  if (c.max_redemptions != null && c.redeemed_count >= c.max_redemptions)
    return { ok: false, error: 'This coupon has reached its redemption limit' };
  return { ok: true, coupon: c };
}

function computeCouponDiscount(coupon, subtotal) {
  if (subtotal < Number(coupon.min_subtotal || 0))
    return { discount: 0, reason: `Minimum subtotal $${Number(coupon.min_subtotal).toFixed(2)} not met` };
  const raw =
    coupon.kind === 'percent'
      ? Math.round(subtotal * (Number(coupon.amount) / 100) * 100) / 100
      : Number(coupon.amount);
  const discount = Math.min(raw, subtotal);
  return { discount, reason: null };
}

// Pre-checkout validation — returns the discount the user *would* receive on
// their current cart so the UI can show "you save $X".
app.post('/api/coupon/validate', requireAuth, async (req, res) => {
  const r = await loadCoupon(req.body && req.body.code);
  if (!r.ok) return res.status(400).json({ error: r.error });
  const { rows: items } = await query(
    `SELECT c.qty, p.price_usd FROM cart_items c JOIN products p ON p.id = c.product_id WHERE c.user_id = $1`,
    [req.session.userId]
  );
  const subtotal = items.reduce((s, it) => s + Number(it.price_usd || 0) * it.qty, 0);
  const { discount, reason } = computeCouponDiscount(r.coupon, subtotal);
  if (discount === 0 && reason) return res.status(400).json({ error: reason });
  res.json({
    code: r.coupon.code,
    kind: r.coupon.kind,
    amount: r.coupon.amount,
    description: r.coupon.description,
    subtotal,
    discount_usd: discount,
  });
});

// Admin coupon CRUD
app.get('/api/admin/coupons', requireAdmin, async (_req, res) => {
  const { rows } = await query(
    `SELECT code, kind, amount::float AS amount, min_subtotal::float AS min_subtotal,
            max_redemptions, redeemed_count, expires_at, is_active, description, created_at
       FROM coupons ORDER BY created_at DESC`
  );
  res.json({ coupons: rows });
});

app.post('/api/admin/coupons', requireManager, async (req, res) => {
  const b = req.body || {};
  const code = String(b.code || '').trim().toUpperCase();
  const kind = b.kind === 'percent' ? 'percent' : 'flat';
  const amount = Number(b.amount || 0);
  if (!code || !amount || amount <= 0) return res.status(400).json({ error: 'code and positive amount required' });
  if (kind === 'percent' && amount > 100) return res.status(400).json({ error: 'percent cannot exceed 100' });
  try {
    await query(
      `INSERT INTO coupons (code, kind, amount, min_subtotal, max_redemptions, expires_at, description, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [code, kind, amount, Number(b.min_subtotal || 0), b.max_redemptions || null,
       b.expires_at || null, b.description || null, b.is_active !== false]
    );
    res.json({ ok: true, code });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Coupon code already exists' });
    console.error(e); res.status(500).json({ error: 'Failed to create coupon' });
  }
});

app.patch('/api/admin/coupons/:code', requireManager, async (req, res) => {
  const fields = ['amount','min_subtotal','max_redemptions','expires_at','is_active','description'];
  const sets = []; const vals = [];
  for (const f of fields) if (req.body && req.body[f] !== undefined) {
    sets.push(`${f} = $${sets.length + 1}`); vals.push(req.body[f]);
  }
  if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
  vals.push(String(req.params.code).toUpperCase());
  await query(`UPDATE coupons SET ${sets.join(', ')} WHERE code = $${vals.length}`, vals);
  res.json({ ok: true });
});

app.delete('/api/admin/coupons/:code', requireManager, async (req, res) => {
  await query('DELETE FROM coupons WHERE code = $1', [String(req.params.code).toUpperCase()]);
  res.json({ ok: true });
});

// =============================================================================
//  GIFT CARDS — issue, view, reload. Redemption happens inside
//  POST /api/admin/pos/sale when a payment row has method:'gift_card' (see
//  step 3b/5 there for the real balance check + deduction).
// =============================================================================
function genGiftCardCode() {
  // Human-typeable at the register: GC-XXXX-XXXX, excludes ambiguous chars (0/O, 1/I).
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const part = () => Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  return `GC-${part()}-${part()}`;
}
app.get('/api/admin/gift-cards', requireAdmin, async (req, res) => {
  const { rows } = await query(
    `SELECT gc.*, u.name AS issued_by_name FROM gift_cards gc
       LEFT JOIN users u ON u.id = gc.issued_by
       ORDER BY gc.created_at DESC LIMIT 200`
  );
  res.json({ gift_cards: rows });
});
app.get('/api/admin/gift-cards/:code', requireAdmin, async (req, res) => {
  const code = String(req.params.code).toUpperCase();
  const { rows: gc } = await query('SELECT * FROM gift_cards WHERE code = $1', [code]);
  if (!gc.length) return res.status(404).json({ error: 'Gift card not found' });
  const { rows: tx } = await query('SELECT * FROM gift_card_transactions WHERE gift_card_id = $1 ORDER BY created_at DESC', [gc[0].id]);
  res.json({ gift_card: gc[0], transactions: tx });
});
app.post('/api/admin/gift-cards', requireManager, async (req, res) => {
  const b = req.body || {};
  const amount = Number(b.amount_usd);
  if (!(amount > 0)) return res.status(400).json({ error: 'amount_usd must be positive' });
  const code = (b.code ? String(b.code).toUpperCase() : genGiftCardCode());
  try {
    const { rows } = await query(
      `INSERT INTO gift_cards (code, initial_balance_usd, balance_usd, issued_to_name, issued_to_phone, issued_by, notes)
         VALUES ($1,$2,$2,$3,$4,$5,$6) RETURNING id`,
      [code, amount, b.issued_to_name || null, b.issued_to_phone || null, req.session.userId, b.notes || null]
    );
    await query(
      `INSERT INTO gift_card_transactions (gift_card_id, delta_usd, reason, performed_by) VALUES ($1,$2,'issue',$3)`,
      [rows[0].id, amount, req.session.userId]
    );
    res.json({ ok: true, id: rows[0].id, code });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'That gift card code is already in use' });
    console.error(e); res.status(500).json({ error: e.message });
  }
});
app.post('/api/admin/gift-cards/:code/reload', requireManager, async (req, res) => {
  const code = String(req.params.code).toUpperCase();
  const amount = Number(req.body && req.body.amount_usd);
  if (!(amount > 0)) return res.status(400).json({ error: 'amount_usd must be positive' });
  const { rows } = await query(
    `UPDATE gift_cards SET balance_usd = balance_usd + $1 WHERE code = $2 AND is_active = true RETURNING id, balance_usd`,
    [amount, code]
  );
  if (!rows.length) return res.status(404).json({ error: 'Gift card not found or inactive' });
  await query(
    `INSERT INTO gift_card_transactions (gift_card_id, delta_usd, reason, performed_by) VALUES ($1,$2,'reload',$3)`,
    [rows[0].id, amount, req.session.userId]
  );
  res.json({ ok: true, balance_usd: rows[0].balance_usd });
});
app.patch('/api/admin/gift-cards/:code', requireManager, async (req, res) => {
  const code = String(req.params.code).toUpperCase();
  if (req.body && req.body.is_active === undefined) return res.status(400).json({ error: 'is_active required' });
  const { rows } = await query('UPDATE gift_cards SET is_active = $1 WHERE code = $2 RETURNING id', [!!req.body.is_active, code]);
  if (!rows.length) return res.status(404).json({ error: 'Gift card not found' });
  res.json({ ok: true });
});

// =============================================================================
//  SAVED VEHICLES (per-user)
// =============================================================================
app.get('/api/vehicles', requireAuth, async (req, res) => {
  const { rows } = await query(
    `SELECT id, label, make, model, year, vin, nickname, created_at
       FROM saved_vehicles WHERE user_id = $1 ORDER BY created_at DESC`,
    [req.session.userId]
  );
  res.json({ vehicles: rows });
});

app.post('/api/vehicles', requireAuth, async (req, res) => {
  const b = req.body || {};
  const make = (b.make || '').trim() || null;
  const model = (b.model || '').trim() || null;
  const year = parseInt(b.year, 10) || null;
  const vin = (b.vin || '').trim().toUpperCase() || null;
  const label = (b.label || b.nickname || '').trim() || null;
  if (!make && !model && !vin) return res.status(400).json({ error: 'make/model or VIN required' });
  try {
    const { rows } = await query(
      `INSERT INTO saved_vehicles (user_id, label, make, model, year, vin, nickname)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (user_id, vin) DO UPDATE SET
           label = EXCLUDED.label, make = EXCLUDED.make, model = EXCLUDED.model,
           year = EXCLUDED.year, nickname = EXCLUDED.nickname
         RETURNING id`,
      [req.session.userId, label, make, model, year, vin, label]
    );
    res.json({ ok: true, id: rows[0] && rows[0].id });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Save failed' }); }
});

app.delete('/api/vehicles/:id', requireAuth, async (req, res) => {
  await query('DELETE FROM saved_vehicles WHERE id = $1 AND user_id = $2',
    [req.params.id, req.session.userId]);
  res.json({ ok: true });
});

// =============================================================================
//  WISHLIST (per-user save-for-later)
// =============================================================================
app.get('/api/wishlist', requireAuth, async (req, res) => {
  const { rows } = await query(
    `SELECT w.product_img, w.created_at,
            p.name, p.make_model, p.category, p.condition, p.price_usd::float AS price_usd, p.stock_count
       FROM wishlist w
       LEFT JOIN products p ON p.id = w.product_id
       WHERE w.user_id = $1
       ORDER BY w.created_at DESC`,
    [req.session.userId]
  );
  res.json({ items: rows });
});

app.post('/api/wishlist', requireAuth, async (req, res) => {
  const img = (req.body && req.body.product_img) || '';
  if (!img) return res.status(400).json({ error: 'product_img required' });
  await query(
    `INSERT INTO wishlist (user_id, product_img, product_id)
       VALUES ($1, $2, (SELECT id FROM products WHERE img = $2))
       ON CONFLICT DO NOTHING`,
    [req.session.userId, img]
  );
  res.json({ ok: true });
});

app.delete('/api/wishlist/:img', requireAuth, async (req, res) => {
  await query('DELETE FROM wishlist WHERE user_id = $1 AND product_img = $2',
    [req.session.userId, req.params.img]);
  res.json({ ok: true });
});

// =============================================================================
//  CHECKOUT (cart → order, Stripe optional, loyalty points)
// =============================================================================
app.post('/api/checkout', requireAuth, async (req, res) => {
  const wantsStripe = req.body && req.body.payment_method === 'stripe';
  const method = (req.body && req.body.payment_method) || 'cash_pickup';
  if (!['cash_pickup','bank_transfer','stripe'].includes(method)) return res.status(400).json({ error: 'Invalid payment_method' });
  if (wantsStripe && !payments.isActive()) return res.status(400).json({ error: 'Online card payment not available' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: items } = await client.query(
      `SELECT c.product_img, c.qty, p.price_usd, p.name, p.make_model
         FROM cart_items c JOIN products p ON p.id = c.product_id
         WHERE c.user_id = $1`,
      [req.session.userId]
    );
    if (!items.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Cart is empty' }); }
    const subtotal = items.reduce((s, r) => s + Number(r.price_usd || 0) * r.qty, 0);
    let total = subtotal;

    // Step 1: apply coupon code (if any). Coupons run before loyalty points so
    // a percent coupon hits the full subtotal.
    let couponCode = null, couponDiscount = 0;
    if (req.body && req.body.coupon_code) {
      const cr = await loadCoupon(req.body.coupon_code);
      if (cr.ok) {
        const cd = computeCouponDiscount(cr.coupon, total);
        if (cd.discount > 0) { couponCode = cr.coupon.code; couponDiscount = cd.discount; total -= couponDiscount; }
      }
    }

    // Step 2: apply loyalty point redemption.
    let redeemPts = Math.max(0, parseInt((req.body && req.body.redeem_points) || 0, 10));
    let pointsDiscount = 0;
    if (redeemPts > 0) {
      const balance = await pointsBalance(req.session.userId);
      redeemPts = Math.min(redeemPts, balance, Math.floor(total / POINTS_USD_RATE));
      pointsDiscount = redeemPts * POINTS_USD_RATE;
      total = Math.max(0, total - pointsDiscount);
    }
    const { rows: order } = await client.query(
      `INSERT INTO orders (user_id, total_usd, notes, payment_method, coupon_code, coupon_discount_usd)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [req.session.userId, total, (req.body && req.body.notes) || null, method, couponCode, couponDiscount]
    );
    const orderId = order[0].id;
    if (couponCode) {
      await client.query(
        `INSERT INTO coupon_redemptions (coupon_code, user_id, order_id, discount_usd)
           VALUES ($1, $2, $3, $4) ON CONFLICT (coupon_code, order_id) DO NOTHING`,
        [couponCode, req.session.userId, orderId, couponDiscount]
      );
      await client.query(`UPDATE coupons SET redeemed_count = redeemed_count + 1 WHERE code = $1`, [couponCode]);
    }
    if (redeemPts > 0) {
      await client.query(
        `INSERT INTO points_transactions (user_id, delta, reason, reference_id) VALUES ($1, $2, 'redemption', $3)`,
        [req.session.userId, -redeemPts, orderId]
      );
    }
    for (const it of items) {
      await client.query(
        `INSERT INTO order_items (order_id, product_img, product_id, qty, price_usd) VALUES ($1, $2, (SELECT id FROM products WHERE img = $2), $3, $4)`,
        [orderId, it.product_img, it.qty, it.price_usd || 0]
      );
    }
    await client.query('DELETE FROM cart_items WHERE user_id = $1', [req.session.userId]);
    await client.query('COMMIT');
    const earnedPoints = Math.floor(total);
    if (earnedPoints > 0) addPoints(req.session.userId, earnedPoints, 'purchase', orderId);
    let checkoutUrl = null;
    if (wantsStripe) {
      try {
        const { rows: u } = await query('SELECT email FROM users WHERE id = $1', [req.session.userId]);
        const session = await payments.createCheckoutSession({ orderId, items, customerEmail: u[0] && u[0].email });
        checkoutUrl = session.url;
        await query('UPDATE orders SET payment_ref = $1 WHERE id = $2', [session.id, orderId]);
      } catch (e) { console.warn('[stripe] checkout session failed:', e.message); }
    }
    res.json({
      order_id: orderId, subtotal_usd: subtotal, total_usd: total, status: 'pending', payment_method: method,
      checkout_url: checkoutUrl, points_redeemed: redeemPts, points_discount_usd: pointsDiscount, points_earned: earnedPoints,
      coupon_code: couponCode, coupon_discount_usd: couponDiscount,
    });
    try {
      const { rows: u } = await query('SELECT email, name, phone FROM users WHERE id = $1', [req.session.userId]);
      const usr = u[0];
      if (usr && usr.email) {
        const { rows: li } = await query(
          `SELECT oi.product_img, oi.qty, oi.price_usd, p.name, p.make_model FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = $1`,
          [orderId]
        );
        const t = mailer.templates.orderEmail({ name: usr.name, orderId, items: li, total });
        mailer.sendEmail({ to: usr.email, ...t }).catch((e) => console.warn('[mailer] order email failed:', e.message));
      }
      if (usr && usr.phone) sms.sendSMS({ to: usr.phone, body: sms.templates.order({ orderId, total }) }).catch((e) => console.warn('[sms] order SMS failed:', e.message));
    } catch (e) { console.warn('[mailer/sms] order notify lookup failed:', e.message); }
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: 'Checkout failed' });
  } finally { client.release(); }
});

app.get('/api/orders', requireAuth, async (req, res) => {
  const { rows } = await query(
    `SELECT id, total_usd, status, payment_method, payment_status, created_at
       FROM orders WHERE user_id = $1 ORDER BY created_at DESC`,
    [req.session.userId]
  );
  res.json({ orders: rows });
});

// Single order with line items (user-scoped: can only see their own orders)
app.get('/api/orders/:id', requireAuth, async (req, res) => {
  const { rows: ord } = await query(
    `SELECT id, total_usd, status, payment_method, payment_status, notes, created_at
       FROM orders WHERE id = $1 AND user_id = $2`,
    [req.params.id, req.session.userId]
  );
  if (!ord.length) return res.status(404).json({ error: 'Order not found' });
  const { rows: items } = await query(
    `SELECT oi.product_img, oi.qty, oi.price_usd, p.name, p.make_model
       FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
       WHERE oi.order_id = $1`,
    [req.params.id]
  );
  res.json({ order: ord[0], items });
});

// Newsletter signup (open endpoint)
app.post('/api/newsletter', async (req, res) => {
  const email = ((req.body && req.body.email) || '').trim().toLowerCase();
  const source = (req.body && req.body.source) || null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: 'Valid email required' });
  await query(
    `INSERT INTO newsletter_subscribers (email, source) VALUES ($1, $2)
       ON CONFLICT (email) DO NOTHING`,
    [email, source]
  );
  res.json({ ok: true });
});

// Admin: snapshot analytics for the Reports tab
app.get('/api/admin/analytics', requireAdmin, async (_req, res) => {
  const [rev7, rev30, ord7, ord30, newU7, topCats, topProds, slots, subs] = await Promise.all([
    query(`SELECT COALESCE(SUM(total_usd),0)::numeric(12,2) AS s FROM orders WHERE created_at > NOW() - INTERVAL '7 days'`),
    query(`SELECT COALESCE(SUM(total_usd),0)::numeric(12,2) AS s FROM orders WHERE created_at > NOW() - INTERVAL '30 days'`),
    query(`SELECT COUNT(*)::int AS n FROM orders WHERE created_at > NOW() - INTERVAL '7 days'`),
    query(`SELECT COUNT(*)::int AS n FROM orders WHERE created_at > NOW() - INTERVAL '30 days'`),
    query(`SELECT COUNT(*)::int AS n FROM users WHERE created_at > NOW() - INTERVAL '7 days'`),
    query(`SELECT p.category, COUNT(*)::int AS n FROM order_items oi JOIN products p ON p.id = oi.product_id GROUP BY p.category ORDER BY n DESC LIMIT 5`),
    query(`SELECT oi.product_img AS img, p.name, SUM(oi.qty)::int AS units FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id GROUP BY oi.product_img, p.name ORDER BY units DESC LIMIT 5`),
    query(`SELECT time_slot, COUNT(*)::int AS n FROM service_appointments WHERE time_slot IS NOT NULL GROUP BY time_slot ORDER BY n DESC LIMIT 5`),
    query(`SELECT COUNT(*)::int AS n FROM newsletter_subscribers`),
  ]);
  res.json({
    revenue_7d: Number(rev7.rows[0].s),
    revenue_30d: Number(rev30.rows[0].s),
    orders_7d: ord7.rows[0].n,
    orders_30d: ord30.rows[0].n,
    new_users_7d: newU7.rows[0].n,
    newsletter_subs: subs.rows[0].n,
    top_categories: topCats.rows,
    top_products: topProds.rows,
    busy_slots: slots.rows,
  });
});

// =============================================================================
//  REVIEWS
// =============================================================================
app.get('/api/reviews', async (_req, res) => {
  const { rows } = await query(
    `SELECT id, name, city, vehicle, rating, body, created_at FROM reviews WHERE approved = true ORDER BY created_at DESC LIMIT 50`
  );
  const { rows: agg } = await query(`SELECT AVG(rating)::numeric(3,2) AS avg, COUNT(*) AS n FROM reviews WHERE approved = true`);
  res.json({ reviews: rows, average: Number(agg[0].avg || 0), count: Number(agg[0].n || 0) });
});

app.post('/api/reviews', async (req, res) => {
  const { name, city, vehicle, rating, body } = req.body || {};
  if (!name || !rating || !body) return res.status(400).json({ error: 'name, rating and body are required' });
  const { rows } = await query(
    `INSERT INTO reviews (user_id, name, city, vehicle, rating, body) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [(req.session && req.session.userId) || null, name, city || null, vehicle || null, Math.max(1, Math.min(5, parseInt(rating, 10))), body]
  );
  res.json({ id: rows[0].id, status: 'pending_approval' });
});

// =============================================================================
//  NOTIFY-WHEN-BACK
// =============================================================================
app.post('/api/notify', async (req, res) => {
  const { img, email, phone } = req.body || {};
  if (!img || !email) return res.status(400).json({ error: 'img and email are required' });
  await query(
    `INSERT INTO notify_subscriptions (product_img, product_id, email, phone) VALUES ($1, (SELECT id FROM products WHERE img = $1), $2, $3)
       ON CONFLICT (product_img, email) DO UPDATE SET phone = EXCLUDED.phone`,
    [img, email, phone || null]
  );
  res.json({ ok: true });
});

// =============================================================================
//  SERVICE APPOINTMENTS
app.post('/api/service', async (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.phone) return res.status(400).json({ error: 'name and phone are required' });
  const { rows } = await query(
    `INSERT INTO service_appointments
       (user_id, name, phone, email, vehicle_make, vehicle_model, vehicle_year, service_type, preferred_date, time_slot, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, created_at`,
    [
      (req.session && req.session.userId) || null,
      b.name, b.phone, b.email || null,
      b.make || null, b.model || null, b.year ? parseInt(b.year, 10) : null,
      b.service_type || null, b.preferred_date || null, b.time_slot || null, b.notes || null,
    ]
  );
  res.json({ id: rows[0].id, created_at: rows[0].created_at });
  if (b.phone) {
    sms.sendSMS({
      to: b.phone,
      body: sms.templates.service({ apptId: rows[0].id, date: b.preferred_date, slot: b.time_slot }),
    }).catch((e) => console.warn('[sms] service SMS failed:', e.message));
  }
});

// =============================================================================
//  PARTS INQUIRIES (with optional photo upload)
// =============================================================================
// =============================================================================
//  MECHANICS (staff registry)
// =============================================================================
app.get('/api/admin/mechanics', requireAdmin, async (req, res) => {
  const conditions = [];
  const params = [];
  if (req.query.active === 'true') conditions.push('is_active = true');
  // ?role=advisor returns advisors or "both"; ?role=mechanic returns mechanics or "both"
  if (req.query.role === 'advisor') conditions.push("role IN ('advisor','both')");
  else if (req.query.role === 'mechanic') conditions.push("role IN ('mechanic','both')");
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const { rows } = await query(
    `SELECT id, user_id, name, phone, email, specialty, certifications,
            hourly_rate_usd::float AS hourly_rate_usd, hire_date, is_active, notes, role, created_at
       FROM mechanics ${where} ORDER BY is_active DESC, name ASC`
  );
  res.json({ mechanics: rows });
});

app.post('/api/admin/mechanics', requireManager, async (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'name required' });
  const role = ['mechanic','advisor','both'].includes(b.role) ? b.role : 'mechanic';
  try {
    const { rows } = await query(
      `INSERT INTO mechanics (user_id, name, phone, email, specialty, certifications, hourly_rate_usd, hire_date, is_active, notes, role)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [
        b.user_id || null, b.name, b.phone || null, b.email || null,
        b.specialty || null, b.certifications || null,
        b.hourly_rate_usd != null ? Number(b.hourly_rate_usd) : 25.00,
        b.hire_date || null, b.is_active !== false, b.notes || null, role,
      ]
    );
    res.json({ ok: true, id: rows[0].id });
  } catch (e) { console.error('[mechanic create]', e); res.status(500).json({ error: e.message }); }
});

app.patch('/api/admin/mechanics/:id', requireManager, async (req, res) => {
  const fields = ['name','phone','email','specialty','certifications','hourly_rate_usd','hire_date','is_active','notes','user_id','role'];
  const sets = []; const vals = [];
  for (const f of fields) if (req.body && req.body[f] !== undefined) {
    sets.push(`${f} = $${sets.length + 1}`); vals.push(req.body[f]);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(req.params.id);
  await query(`UPDATE mechanics SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
  res.json({ ok: true });
});

app.delete('/api/admin/mechanics/:id', requireManager, async (req, res) => {
  // Soft-delete by deactivating so existing work order references remain intact.
  await query('UPDATE mechanics SET is_active = false WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// =============================================================================
//  WORK ORDERS (service-center repair tickets)
// =============================================================================
// Highest-issued + 1 within the year, not count + 1. work_orders.wo_number is
// UNIQUE and work orders do get deleted (DELETE FROM work_orders below), so
// counting is wrong the moment one is: with WO-2026-0001 and WO-2026-0002 on
// file, deleting either leaves a count of 1 and the next work order tries to
// claim WO-2026-0002 again. Same defect as the old nextAccountNumber().
// The regex takes the trailing digit run, so the year prefix is irrelevant.
async function nextWoNumber() {
  const year = new Date().getFullYear();
  const { rows } = await query(
    `SELECT COALESCE(MAX(substring(wo_number from '[0-9]+$')::bigint), 0) AS n
       FROM work_orders WHERE wo_number LIKE $1`,
    [`WO-${year}-%`]
  );
  const seq = String(Number(rows[0].n) + 1).padStart(4, '0');
  return `WO-${year}-${seq}`;
}

// GCT rate (Jamaica's General Consumption Tax). Override via env if needed.
const TAX_RATE = Number(process.env.TAX_RATE || 0.15);
const TAX_LABEL = process.env.TAX_LABEL || 'GCT (15%)';
async function recalcWoTotals(workOrderId) {
  const { rows: l } = await query(
    'SELECT COALESCE(SUM(total_usd),0)::float AS s FROM work_order_labor WHERE work_order_id = $1',
    [workOrderId]
  );
  const { rows: p } = await query(
    'SELECT COALESCE(SUM(total_usd),0)::float AS s FROM work_order_parts WHERE work_order_id = $1',
    [workOrderId]
  );
  const labor = l[0].s, parts = p[0].s;
  const subtotal = labor + parts;
  // Auto-calc GCT unless the work order has tax_usd explicitly set to non-default
  const { rows: w } = await query('SELECT tax_usd::float AS t FROM work_orders WHERE id = $1', [workOrderId]);
  // Always rewrite tax on each recalc so it tracks subtotal changes
  const tax = Math.round(subtotal * TAX_RATE * 100) / 100;
  const total = Math.round((subtotal + tax) * 100) / 100;
  await query(
    'UPDATE work_orders SET labor_total_usd = $1, parts_total_usd = $2, tax_usd = $3, total_usd = $4 WHERE id = $5',
    [labor, parts, tax, total, workOrderId]
  );
  return { labor, parts, tax, total };
}

app.get('/api/admin/work-orders', requireAdmin, async (req, res) => {
  const status = req.query.status || null;
  const sql = status
    ? `SELECT w.*, m.name AS mechanic_name, sa.name AS advisor_name FROM work_orders w
         LEFT JOIN mechanics m ON m.id = w.assigned_mechanic_id
         LEFT JOIN mechanics sa ON sa.id = w.service_advisor_id
         WHERE w.status = $1 ORDER BY w.created_at DESC LIMIT 200`
    : `SELECT w.*, m.name AS mechanic_name, sa.name AS advisor_name FROM work_orders w
         LEFT JOIN mechanics m ON m.id = w.assigned_mechanic_id
         LEFT JOIN mechanics sa ON sa.id = w.service_advisor_id
         ORDER BY w.created_at DESC LIMIT 200`;
  const { rows } = status ? await query(sql, [status]) : await query(sql);
  res.json({ work_orders: rows });
});

app.get('/api/admin/work-orders/:id', requireAdmin, async (req, res) => {
  const { rows: wo } = await query(
    `SELECT w.*, m.name AS mechanic_name, m.hourly_rate_usd::float AS mechanic_rate,
            sa.name AS advisor_name, sa.phone AS advisor_phone
       FROM work_orders w
       LEFT JOIN mechanics m ON m.id = w.assigned_mechanic_id
       LEFT JOIN mechanics sa ON sa.id = w.service_advisor_id
       WHERE w.id = $1`, [req.params.id]
  );
  if (!wo.length) return res.status(404).json({ error: 'Work order not found' });
  const [labor, parts] = await Promise.all([
    query(
      `SELECT l.*, m.name AS mechanic_name FROM work_order_labor l
         LEFT JOIN mechanics m ON m.id = l.mechanic_id
         WHERE l.work_order_id = $1 ORDER BY l.id`,
      [req.params.id]
    ),
    query(
      `SELECT p.*, pr.name AS product_name FROM work_order_parts p
         LEFT JOIN products pr ON pr.id = p.product_id
         WHERE p.work_order_id = $1 ORDER BY p.id`,
      [req.params.id]
    ),
  ]);
  res.json({ work_order: wo[0], labor: labor.rows, parts: parts.rows });
});

app.post('/api/admin/work-orders', requireAdmin, async (req, res) => {
  const b = req.body || {};
  if (!b.customer_name || !b.customer_phone) return res.status(400).json({ error: 'customer_name and customer_phone required' });
  try {
    const woNum = await nextWoNumber();
    const { rows } = await query(
      `INSERT INTO work_orders
         (wo_number, customer_user_id, customer_name, customer_phone, customer_email,
          vehicle_year, vehicle_make, vehicle_model, vehicle_vin, license_plate, mileage_in,
          assigned_mechanic_id, service_advisor_id, service_appointment_id, inspection_id,
          complaint, priority, promised_date, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         RETURNING id`,
      [
        woNum, b.customer_user_id || null, b.customer_name, b.customer_phone, b.customer_email || null,
        b.vehicle_year || null, b.vehicle_make || null, b.vehicle_model || null,
        (b.vehicle_vin || '').toUpperCase() || null, b.license_plate || null,
        b.mileage_in ? parseInt(b.mileage_in, 10) : null,
        b.assigned_mechanic_id || null, b.service_advisor_id || null,
        b.service_appointment_id || null, b.inspection_id || null,
        b.complaint || null,
        ['low','normal','rush'].includes(b.priority) ? b.priority : 'normal',
        b.promised_date || null, req.session.userId,
      ]
    );
    res.json({ ok: true, id: rows[0].id, wo_number: woNum });
  } catch (e) { console.error('[wo create]', e); res.status(500).json({ error: e.message }); }
});

app.patch('/api/admin/work-orders/:id', requireAdmin, async (req, res) => {
  // Capture the previous status so we know if it changed for SMS notification
  let prevStatus = null;
  if (req.body && req.body.status) {
    const { rows: prev } = await query('SELECT status FROM work_orders WHERE id = $1', [req.params.id]);
    prevStatus = prev[0] && prev[0].status;
  }
  const fields = ['status','priority','assigned_mechanic_id','service_advisor_id','complaint','diagnosis','work_performed','promised_date','completed_at','paid_at','tax_usd','payment_method','internal_notes','customer_name','customer_phone','customer_email','vehicle_year','vehicle_make','vehicle_model','vehicle_vin','license_plate','mileage_in'];
  const sets = []; const vals = [];
  for (const f of fields) if (req.body && req.body[f] !== undefined) {
    sets.push(`${f} = $${sets.length + 1}`); vals.push(req.body[f]);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(req.params.id);
  await query(`UPDATE work_orders SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
  if (req.body && req.body.status === 'completed') {
    await query(`UPDATE work_orders SET completed_at = COALESCE(completed_at, NOW()) WHERE id = $1`, [req.params.id]);
  }
  if (req.body && req.body.status === 'paid') {
    await query(`UPDATE work_orders SET paid_at = COALESCE(paid_at, NOW()) WHERE id = $1`, [req.params.id]);
  }
  res.json({ ok: true });
  // Fire-and-forget SMS notification on status change (best-effort).
  if (req.body && req.body.status && req.body.status !== prevStatus) {
    setImmediate(async () => {
      try {
        const { rows: w } = await query('SELECT wo_number, customer_name, customer_phone, vehicle_make, vehicle_model FROM work_orders WHERE id = $1', [req.params.id]);
        if (!w.length || !w[0].customer_phone) return;
        const base = (process.env.PUBLIC_BASE_URL || 'https://melthahonda.miamimistress.com').replace(/\/$/, '');
        const trackUrl = `${base}/track.html?wo=${encodeURIComponent(w[0].wo_number)}&phone=${encodeURIComponent(w[0].customer_phone.replace(/[^\d]/g,'').slice(-7))}`;
        const vehicle = [w[0].vehicle_make, w[0].vehicle_model].filter(Boolean).join(' ');
        const msgs = {
          in_progress: `Meltha Honda: Your ${vehicle} (${w[0].wo_number}) is now in the bay. Track: ${trackUrl}`,
          awaiting_parts: `Meltha Honda: We're sourcing parts for your ${vehicle} (${w[0].wo_number}). We'll text when work resumes. ${trackUrl}`,
          completed: `Meltha Honda: ✓ Your ${vehicle} is ready for pickup! ${w[0].wo_number}. Open Mon-Sat 8:00-5:30. ${trackUrl}`,
          billed: `Meltha Honda: Invoice ready for ${vehicle} (${w[0].wo_number}). Come by to settle and collect. ${trackUrl}`,
          paid: `Meltha Honda: Thanks for your business, ${w[0].customer_name.split(' ')[0]}! Receipt: ${trackUrl}`,
        };
        const body = msgs[req.body.status];
        if (body && sms.sendSMS) {
          sms.sendSMS({ to: w[0].customer_phone, body }).catch((e) => console.warn('[wo-sms] send failed:', e.message));
        }
      } catch (e) { console.warn('[wo-sms] hook failed:', e.message); }
    });
  }
});

app.delete('/api/admin/work-orders/:id', requireManager, async (req, res) => {
  await query('DELETE FROM work_orders WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// Add a labor line item
app.post('/api/admin/work-orders/:id/labor', requireAdmin, async (req, res) => {
  const b = req.body || {};
  if (!b.description || !b.hours || !b.rate_usd) return res.status(400).json({ error: 'description, hours, rate_usd required' });
  const hours = Number(b.hours); const rate = Number(b.rate_usd);
  const total = Math.round(hours * rate * 100) / 100;
  await query(
    `INSERT INTO work_order_labor (work_order_id, mechanic_id, description, hours, rate_usd, total_usd, performed_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [req.params.id, b.mechanic_id || null, b.description, hours, rate, total, b.performed_date || null]
  );
  const totals = await recalcWoTotals(req.params.id);
  res.json({ ok: true, totals });
});

app.delete('/api/admin/work-orders/:woId/labor/:id', requireAdmin, async (req, res) => {
  await query('DELETE FROM work_order_labor WHERE id = $1 AND work_order_id = $2', [req.params.id, req.params.woId]);
  const totals = await recalcWoTotals(req.params.woId);
  res.json({ ok: true, totals });
});

// Add a parts line item (custom or from inventory)
app.post('/api/admin/work-orders/:id/parts', requireAdmin, async (req, res) => {
  const b = req.body || {};
  if (!b.description || !b.qty || b.unit_price_usd == null) return res.status(400).json({ error: 'description, qty, unit_price_usd required' });
  const qty = parseInt(b.qty, 10); const unit = Number(b.unit_price_usd);
  const total = Math.round(qty * unit * 100) / 100;
  await query(
    `INSERT INTO work_order_parts (work_order_id, product_img, product_id, description, qty, unit_price_usd, total_usd)
       VALUES ($1,$2,(SELECT id FROM products WHERE img = $2),$3,$4,$5,$6)`,
    [req.params.id, b.product_img || null, b.description, qty, unit, total]
  );
  const totals = await recalcWoTotals(req.params.id);
  res.json({ ok: true, totals });
});

app.delete('/api/admin/work-orders/:woId/parts/:id', requireAdmin, async (req, res) => {
  await query('DELETE FROM work_order_parts WHERE id = $1 AND work_order_id = $2', [req.params.id, req.params.woId]);
  const totals = await recalcWoTotals(req.params.woId);
  res.json({ ok: true, totals });
});

// Capture customer signature (data: URL from a canvas)
app.post('/api/admin/work-orders/:id/signature', requireAdmin, async (req, res) => {
  const sig = (req.body && req.body.signature) || '';
  if (!sig.startsWith('data:image/')) return res.status(400).json({ error: 'signature must be a data: URL' });
  await query(
    `UPDATE work_orders SET customer_signature = $1, customer_signed_at = NOW() WHERE id = $2`,
    [sig, req.params.id]
  );
  res.json({ ok: true });
});

// =============================================================================
//  SERVICES CATALOG — published price list
// =============================================================================
app.get('/api/admin/services', requireAdmin, async (req, res) => {
  const where = req.query.active === 'true' ? 'WHERE is_active = true' : '';
  const { rows } = await query(
    `SELECT id, code, name, category, description,
            default_hours::float AS default_hours,
            default_price_usd::float AS default_price_usd,
            default_labor_usd::float AS default_labor_usd,
            default_parts_usd::float AS default_parts_usd,
            is_active, created_at
       FROM services ${where} ORDER BY is_active DESC, category NULLS LAST, name ASC`
  );
  res.json({ services: rows });
});

app.post('/api/admin/services', requireAdmin, async (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'name required' });
  try {
    const { rows } = await query(
      `INSERT INTO services (code, name, category, description, default_hours, default_price_usd, default_labor_usd, default_parts_usd, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [
        b.code || null, b.name, b.category || null, b.description || null,
        b.default_hours != null ? Number(b.default_hours) : 1.0,
        b.default_price_usd != null ? Number(b.default_price_usd) : null,
        b.default_labor_usd != null ? Number(b.default_labor_usd) : null,
        b.default_parts_usd != null ? Number(b.default_parts_usd) : null,
        b.is_active !== false,
      ]
    );
    res.json({ ok: true, id: rows[0].id });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Service code already exists' });
    console.error(e); res.status(500).json({ error: e.message });
  }
});

app.patch('/api/admin/services/:id', requireAdmin, async (req, res) => {
  const fields = ['code','name','category','description','default_hours','default_price_usd','default_labor_usd','default_parts_usd','is_active'];
  const sets = []; const vals = [];
  for (const f of fields) if (req.body && req.body[f] !== undefined) {
    sets.push(`${f} = $${sets.length + 1}`); vals.push(req.body[f]);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(req.params.id);
  await query(`UPDATE services SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
  res.json({ ok: true });
});

app.delete('/api/admin/services/:id', requireManager, async (req, res) => {
  await query('UPDATE services SET is_active = false WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// =============================================================================
//  SERVICE REQUISITIONS — estimates/quotes that can become work orders
// =============================================================================
// MAX + 1, not COUNT + 1 -- req_number is UNIQUE and requisitions are deleted
// (DELETE FROM service_requisitions below), so a count points back at a
// number still in use. See nextWoNumber() above.
async function nextReqNumber() {
  const year = new Date().getFullYear();
  const { rows } = await query(
    `SELECT COALESCE(MAX(substring(req_number from '[0-9]+$')::bigint), 0) AS n
       FROM service_requisitions WHERE req_number LIKE $1`,
    [`REQ-${year}-%`]
  );
  return `REQ-${year}-${String(Number(rows[0].n) + 1).padStart(4, '0')}`;
}

async function recalcReqTotal(requisitionId) {
  const { rows } = await query(
    'SELECT COALESCE(SUM(total_usd),0)::float AS s FROM service_requisition_items WHERE requisition_id = $1',
    [requisitionId]
  );
  await query('UPDATE service_requisitions SET estimate_total_usd = $1 WHERE id = $2', [rows[0].s, requisitionId]);
  return rows[0].s;
}

app.get('/api/admin/requisitions', requireAdmin, async (req, res) => {
  const status = req.query.status || null;
  const sql = status
    ? `SELECT r.*, sa.name AS advisor_name FROM service_requisitions r
         LEFT JOIN mechanics sa ON sa.id = r.service_advisor_id
         WHERE r.status = $1 ORDER BY r.created_at DESC LIMIT 200`
    : `SELECT r.*, sa.name AS advisor_name FROM service_requisitions r
         LEFT JOIN mechanics sa ON sa.id = r.service_advisor_id
         ORDER BY r.created_at DESC LIMIT 200`;
  const { rows } = status ? await query(sql, [status]) : await query(sql);
  res.json({ requisitions: rows });
});

app.get('/api/admin/requisitions/:id', requireAdmin, async (req, res) => {
  const { rows: req_ } = await query(
    `SELECT r.*, sa.name AS advisor_name FROM service_requisitions r
       LEFT JOIN mechanics sa ON sa.id = r.service_advisor_id
       WHERE r.id = $1`, [req.params.id]
  );
  if (!req_.length) return res.status(404).json({ error: 'Requisition not found' });
  const { rows: items } = await query(
    `SELECT ri.*, s.name AS service_name, s.code AS service_code FROM service_requisition_items ri
       LEFT JOIN services s ON s.id = ri.service_id
       WHERE ri.requisition_id = $1 ORDER BY ri.id`,
    [req.params.id]
  );
  res.json({ requisition: req_[0], items });
});

app.post('/api/admin/requisitions', requireAdmin, async (req, res) => {
  const b = req.body || {};
  if (!b.customer_name || !b.customer_phone) return res.status(400).json({ error: 'customer_name and customer_phone required' });
  try {
    const reqNum = await nextReqNumber();
    const { rows } = await query(
      `INSERT INTO service_requisitions
         (req_number, customer_user_id, customer_name, customer_phone, customer_email,
          vehicle_year, vehicle_make, vehicle_model, vehicle_vin, license_plate, mileage_in,
          service_advisor_id, inspection_id, complaint, recommended, valid_until, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
      [
        reqNum, b.customer_user_id || null, b.customer_name, b.customer_phone, b.customer_email || null,
        b.vehicle_year || null, b.vehicle_make || null, b.vehicle_model || null,
        (b.vehicle_vin || '').toUpperCase() || null, b.license_plate || null,
        b.mileage_in ? parseInt(b.mileage_in, 10) : null,
        b.service_advisor_id || null, b.inspection_id || null,
        b.complaint || null, b.recommended || null, b.valid_until || null, b.notes || null,
        req.session.userId,
      ]
    );
    res.json({ ok: true, id: rows[0].id, req_number: reqNum });
  } catch (e) { console.error('[req create]', e); res.status(500).json({ error: e.message }); }
});

app.patch('/api/admin/requisitions/:id', requireAdmin, async (req, res) => {
  const fields = ['status','customer_name','customer_phone','customer_email','vehicle_year','vehicle_make','vehicle_model','vehicle_vin','license_plate','mileage_in','service_advisor_id','complaint','recommended','valid_until','notes','approved_at'];
  const sets = []; const vals = [];
  for (const f of fields) if (req.body && req.body[f] !== undefined) {
    sets.push(`${f} = $${sets.length + 1}`); vals.push(req.body[f]);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(req.params.id);
  await query(`UPDATE service_requisitions SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
  if (req.body && req.body.status === 'approved') {
    await query(`UPDATE service_requisitions SET approved_at = COALESCE(approved_at, NOW()) WHERE id = $1`, [req.params.id]);
  }
  res.json({ ok: true });
});

app.delete('/api/admin/requisitions/:id', requireManager, async (req, res) => {
  await query('DELETE FROM service_requisitions WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

app.post('/api/admin/requisitions/:id/items', requireAdmin, async (req, res) => {
  const b = req.body || {};
  if (!b.description) return res.status(400).json({ error: 'description required' });
  const labor = Number(b.labor_usd || 0);
  const parts = Number(b.parts_usd || 0);
  const total = labor + parts;
  await query(
    `INSERT INTO service_requisition_items (requisition_id, service_id, description, hours, labor_usd, parts_usd, total_usd)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [req.params.id, b.service_id || null, b.description, Number(b.hours || 0), labor, parts, total]
  );
  const tot = await recalcReqTotal(req.params.id);
  res.json({ ok: true, total: tot });
});

app.delete('/api/admin/requisitions/:reqId/items/:id', requireAdmin, async (req, res) => {
  await query('DELETE FROM service_requisition_items WHERE id = $1 AND requisition_id = $2', [req.params.id, req.params.reqId]);
  const tot = await recalcReqTotal(req.params.reqId);
  res.json({ ok: true, total: tot });
});

// Convert an approved requisition into an actual work order (copies header + items)
app.post('/api/admin/requisitions/:id/convert', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: rr } = await client.query('SELECT * FROM service_requisitions WHERE id = $1', [req.params.id]);
    if (!rr.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Requisition not found' }); }
    const r = rr[0];
    if (r.converted_to_work_order_id) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Already converted to WO #' + r.converted_to_work_order_id }); }
    const year = new Date().getFullYear();
    const { rows: cnt } = await client.query(`SELECT COUNT(*)::int AS n FROM work_orders WHERE wo_number LIKE $1`, [`WO-${year}-%`]);
    const woNum = `WO-${year}-${String(cnt[0].n + 1).padStart(4, '0')}`;
    const { rows: wo } = await client.query(
      `INSERT INTO work_orders
         (wo_number, customer_user_id, customer_name, customer_phone, customer_email,
          vehicle_year, vehicle_make, vehicle_model, vehicle_vin, license_plate, mileage_in,
          service_advisor_id, inspection_id, complaint, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'open',$15) RETURNING id`,
      [woNum, r.customer_user_id, r.customer_name, r.customer_phone, r.customer_email,
       r.vehicle_year, r.vehicle_make, r.vehicle_model, r.vehicle_vin, r.license_plate, r.mileage_in,
       r.service_advisor_id, r.inspection_id, r.complaint, req.session.userId]
    );
    const woId = wo[0].id;
    // Copy line items: each requisition item becomes a labor row (labor portion)
    // plus a parts row (parts portion) when applicable.
    const { rows: items } = await client.query('SELECT * FROM service_requisition_items WHERE requisition_id = $1', [req.params.id]);
    for (const it of items) {
      if (Number(it.labor_usd) > 0) {
        const hrs = Number(it.hours) > 0 ? Number(it.hours) : 1.0;
        const rate = hrs > 0 ? Math.round((Number(it.labor_usd) / hrs) * 100) / 100 : Number(it.labor_usd);
        await client.query(
          `INSERT INTO work_order_labor (work_order_id, description, hours, rate_usd, total_usd) VALUES ($1,$2,$3,$4,$5)`,
          [woId, it.description, hrs, rate, Number(it.labor_usd)]
        );
      }
      if (Number(it.parts_usd) > 0) {
        await client.query(
          `INSERT INTO work_order_parts (work_order_id, description, qty, unit_price_usd, total_usd) VALUES ($1,$2,$3,$4,$5)`,
          [woId, it.description + ' (parts)', 1, Number(it.parts_usd), Number(it.parts_usd)]
        );
      }
    }
    // Roll up totals on the WO
    const lr = await client.query('SELECT COALESCE(SUM(total_usd),0)::float AS s FROM work_order_labor WHERE work_order_id = $1', [woId]);
    const pr = await client.query('SELECT COALESCE(SUM(total_usd),0)::float AS s FROM work_order_parts WHERE work_order_id = $1', [woId]);
    await client.query(
      'UPDATE work_orders SET labor_total_usd = $1, parts_total_usd = $2, total_usd = $3 WHERE id = $4',
      [lr.rows[0].s, pr.rows[0].s, lr.rows[0].s + pr.rows[0].s, woId]
    );
    // Mark requisition as converted
    await client.query(
      `UPDATE service_requisitions SET status = 'converted', converted_to_work_order_id = $1 WHERE id = $2`,
      [woId, req.params.id]
    );
    await client.query('COMMIT');
    res.json({ ok: true, work_order_id: woId, wo_number: woNum });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[req convert]', e);
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// =============================================================================
//  SCHEDULE BLOCKS — block out non-customer time on a mechanic's calendar
// =============================================================================
app.get('/api/admin/schedule-blocks', requireAdmin, async (req, res) => {
  const where = []; const vals = [];
  if (req.query.from) { vals.push(req.query.from); where.push(`block_date >= $${vals.length}`); }
  if (req.query.to) { vals.push(req.query.to); where.push(`block_date <= $${vals.length}`); }
  const sql = `SELECT sb.*, m.name AS mechanic_name FROM schedule_blocks sb
                 LEFT JOIN mechanics m ON m.id = sb.mechanic_id
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY block_date ASC, time_slot ASC`;
  const { rows } = vals.length ? await query(sql, vals) : await query(sql);
  res.json({ blocks: rows });
});

app.post('/api/admin/schedule-blocks', requireAdmin, async (req, res) => {
  const b = req.body || {};
  if (!b.block_date) return res.status(400).json({ error: 'block_date required' });
  const { rows } = await query(
    `INSERT INTO schedule_blocks (mechanic_id, block_date, time_slot, reason, notes)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [b.mechanic_id || null, b.block_date, b.time_slot || null, b.reason || null, b.notes || null]
  );
  res.json({ ok: true, id: rows[0].id });
});

app.delete('/api/admin/schedule-blocks/:id', requireAdmin, async (req, res) => {
  await query('DELETE FROM schedule_blocks WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

app.get('/api/admin/schedule', requireAdmin, async (req, res) => {
  const anchor = req.query.week ? new Date(req.query.week) : new Date();
  const day = anchor.getUTCDay();
  const diff = (day === 0 ? -6 : 1 - day);
  const mon = new Date(anchor); mon.setUTCDate(anchor.getUTCDate() + diff); mon.setUTCHours(0,0,0,0);
  const sat = new Date(mon); sat.setUTCDate(mon.getUTCDate() + 6);
  const start = mon.toISOString().slice(0,10);
  const end = sat.toISOString().slice(0,10);
  const [appts, works, blocks, mechs] = await Promise.all([
    query("SELECT id, name, phone, vehicle_make, vehicle_model, vehicle_year, service_type, preferred_date, time_slot, status FROM service_appointments WHERE preferred_date BETWEEN $1::date AND $2::date ORDER BY preferred_date ASC, time_slot ASC", [start, end]),
    query("SELECT w.id, w.wo_number, w.customer_name, w.vehicle_year, w.vehicle_make, w.vehicle_model, w.status, w.priority, w.promised_date, w.assigned_mechanic_id, m.name AS mechanic_name FROM work_orders w LEFT JOIN mechanics m ON m.id = w.assigned_mechanic_id WHERE w.promised_date BETWEEN $1::date AND $2::date OR (w.status IN ('open','in_progress','awaiting_parts') AND w.created_at::date BETWEEN $1::date AND $2::date) ORDER BY w.promised_date ASC", [start, end]),
    query("SELECT sb.*, m.name AS mechanic_name FROM schedule_blocks sb LEFT JOIN mechanics m ON m.id = sb.mechanic_id WHERE block_date BETWEEN $1::date AND $2::date", [start, end]),
    query("SELECT id, name, role, specialty FROM mechanics WHERE is_active = true ORDER BY name"),
  ]);
  res.json({ week_start: start, week_end: end, appointments: appts.rows, work_orders: works.rows, blocks: blocks.rows, mechanics: mechs.rows });
});

// =============================================================================
//  LABOR STANDARDS — flat-rate catalog + tiered rates + estimator
//  Times track AllData / Mitchell / ProDemand industry references.
// =============================================================================
async function seedLaborStandards() {
  const { rows: cnt } = await query('SELECT COUNT(*)::int AS n FROM vehicle_classes');
  if (cnt[0].n === 0) {
    const classes = [
      ['compact', 'Compact car (Civic, Corolla, Sentra)', 1.00],
      ['midsize', 'Midsize car (Camry, Accord, Altima)', 1.10],
      ['full_size', 'Full-size car (Avalon, Maxima)', 1.15],
      ['suv_small', 'Small SUV (CR-V, RAV4, Rogue)', 1.20],
      ['suv_large', 'Large SUV (Highlander, Pilot, Pathfinder)', 1.30],
      ['truck', 'Pickup truck (Tacoma, Frontier, Ridgeline)', 1.30],
      ['luxury', 'Luxury (Acura)', 1.25],
      ['european', 'European (BMW, Mercedes, Audi, VW)', 1.45],
      ['hybrid', 'Hybrid (Prius, Camry Hybrid)', 1.20],
      ['ev', 'Electric vehicle', 1.40],
    ];
    for (const [code, name, mult] of classes) {
      await query('INSERT INTO vehicle_classes (code, name, labor_multiplier) VALUES ($1, $2, $3) ON CONFLICT (code) DO NOTHING', [code, name, mult]);
    }
    console.log('[ok] seeded 10 vehicle classes');
  }
  const { rows: tcnt } = await query('SELECT COUNT(*)::int AS n FROM labor_rate_tiers');
  if (tcnt[0].n === 0) {
    const tiers = [
      ['Standard', 35.00, 'General repair and maintenance', true],
      ['Diagnostic', 50.00, 'Diagnostic scans, troubleshooting', false],
      ['After-hours', 55.00, 'Outside Mon-Sat 8:00-5:30', false],
      ['Warranty', 25.00, 'Manufacturer warranty work', false],
      ['Internal', 0.00, 'Shop-internal vehicle work', false],
    ];
    for (const [name, rate, desc, def] of tiers) {
      await query('INSERT INTO labor_rate_tiers (name, rate_usd, description, is_default) VALUES ($1, $2, $3, $4) ON CONFLICT (name) DO NOTHING', [name, rate, desc, def]);
    }
    console.log('[ok] seeded 5 labor rate tiers');
  }
  const { rows: lcnt } = await query('SELECT COUNT(*)::int AS n FROM labor_rates');
  if (lcnt[0].n === 0) {
    const ops = [
      // [code, category, operation, base_hours, notes]
      ['OIL-001', 'Oil Change', 'Engine oil & filter — conventional', 0.4, 'Includes disposal'],
      ['OIL-002', 'Oil Change', 'Engine oil & filter — synthetic', 0.5, 'Includes disposal'],
      ['OIL-003', 'Oil Change', 'Engine oil & filter — diesel', 0.7, 'Includes disposal'],
      ['BRK-001', 'Brakes', 'Front brake pads — replace', 1.0, 'Includes clean & lube'],
      ['BRK-002', 'Brakes', 'Rear brake pads — replace', 1.2, ''],
      ['BRK-003', 'Brakes', 'Front rotors — replace (pair)', 1.5, 'Includes pad re-bed'],
      ['BRK-004', 'Brakes', 'Rear rotors — replace (pair)', 1.7, ''],
      ['BRK-005', 'Brakes', 'Brake fluid flush & bleed', 0.8, '4-wheel system'],
      ['BRK-006', 'Brakes', 'Caliper replacement (single)', 1.5, ''],
      ['SUSP-001', 'Suspension', 'Front struts — replace (pair)', 3.0, 'Alignment recommended after'],
      ['SUSP-002', 'Suspension', 'Rear shocks — replace (pair)', 1.8, ''],
      ['SUSP-003', 'Suspension', 'Control arm — replace (single)', 1.5, ''],
      ['SUSP-004', 'Suspension', 'Sway bar links — replace (pair)', 0.8, ''],
      ['STR-001', 'Steering', 'Wheel alignment — 4-wheel', 1.0, 'Includes road test'],
      ['STR-002', 'Steering', 'Wheel alignment — 2-wheel', 0.6, ''],
      ['STR-003', 'Steering', 'Tie rod end — replace (single)', 0.8, 'Alignment required after'],
      ['STR-004', 'Steering', 'Power steering fluid flush', 0.6, ''],
      ['TIRE-001', 'Tires', 'Tire rotation', 0.4, ''],
      ['TIRE-002', 'Tires', 'Mount & balance single tire', 0.3, ''],
      ['TIRE-003', 'Tires', 'Mount & balance set of 4', 1.0, ''],
      ['TIRE-004', 'Tires', 'Tire patch / plug repair', 0.5, ''],
      ['ENG-001', 'Engine', 'Spark plugs — 4-cylinder', 1.0, ''],
      ['ENG-002', 'Engine', 'Spark plugs — 6-cylinder', 1.5, ''],
      ['ENG-003', 'Engine', 'Spark plugs — 8-cylinder', 2.0, ''],
      ['ENG-004', 'Engine', 'Coolant flush & refill', 1.0, ''],
      ['ENG-005', 'Engine', 'Timing belt — replace', 5.0, 'Includes water pump if applicable'],
      ['ENG-006', 'Engine', 'Serpentine belt — replace', 0.6, ''],
      ['ENG-007', 'Engine', 'Drive belt tensioner — replace', 0.8, ''],
      ['ENG-008', 'Engine', 'Air filter — replace', 0.2, ''],
      ['ENG-009', 'Engine', 'Cabin filter — replace', 0.3, ''],
      ['TRN-001', 'Transmission', 'Transmission fluid & filter — replace', 1.5, 'Automatic'],
      ['TRN-002', 'Transmission', 'Transmission fluid — drain & refill', 0.8, 'Manual'],
      ['TRN-003', 'Transmission', 'Clutch replacement', 6.0, 'Includes pressure plate & release bearing'],
      ['ELEC-001', 'Electrical', 'Battery — test & replace', 0.4, ''],
      ['ELEC-002', 'Electrical', 'Alternator — replace', 1.5, ''],
      ['ELEC-003', 'Electrical', 'Starter motor — replace', 1.5, ''],
      ['ELEC-004', 'Electrical', 'Headlight bulb — replace (single)', 0.4, ''],
      ['DIAG-001', 'Diagnostics', 'Check engine light scan & report', 0.5, 'Diagnostic tier rate'],
      ['DIAG-002', 'Diagnostics', 'Electrical fault diagnosis', 1.5, 'Diagnostic tier rate'],
      ['DIAG-003', 'Diagnostics', 'Driveability complaint diagnosis', 1.5, 'Diagnostic tier rate'],
      ['AC-001', 'A/C & HVAC', 'A/C performance check', 0.5, 'Includes pressure read'],
      ['AC-002', 'A/C & HVAC', 'A/C recharge (R134a)', 1.0, 'Refrigerant extra'],
      ['AC-003', 'A/C & HVAC', 'A/C compressor — replace', 3.0, ''],
      ['AC-004', 'A/C & HVAC', 'Heater core — replace', 5.0, 'Dash removal'],
      ['EXH-001', 'Exhaust', 'Muffler — replace', 1.0, ''],
      ['EXH-002', 'Exhaust', 'Catalytic converter — replace', 1.5, ''],
      ['EXH-003', 'Exhaust', 'O2 sensor — replace (single)', 0.5, ''],
      ['BODY-001', 'Body', 'Front bumper — remove & refit', 1.0, ''],
      ['BODY-002', 'Body', 'Door panel — remove & refit', 0.8, ''],
      ['MAINT-001', 'Maintenance', '30,000 km service inspection', 1.5, 'Multi-point inspection + filters'],
      ['MAINT-002', 'Maintenance', '60,000 km service inspection', 2.5, 'Multi-point + fluids'],
      ['MAINT-003', 'Maintenance', '100,000 km major service', 4.0, 'Full inspection + tune-up'],
    ];
    for (const [code, cat, op, hrs, notes] of ops) {
      await query('INSERT INTO labor_rates (code, category, operation, base_hours, notes) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (code) DO NOTHING', [code, cat, op, hrs, notes]);
    }
    console.log('[ok] seeded ' + ops.length + ' standard labor operations');
  }
}

app.get('/api/admin/labor-standards', requireAdmin, async (req, res) => {
  const [classes, tiers, ops] = await Promise.all([
    query('SELECT code, name, labor_multiplier::float AS labor_multiplier, description FROM vehicle_classes ORDER BY labor_multiplier ASC'),
    query('SELECT id, name, rate_usd::float AS rate_usd, description, is_default FROM labor_rate_tiers ORDER BY rate_usd ASC'),
    query("SELECT id, code, category, operation, base_hours::float AS base_hours, notes, source, is_active FROM labor_rates WHERE is_active = true ORDER BY category, code"),
  ]);
  res.json({ vehicle_classes: classes.rows, rate_tiers: tiers.rows, operations: ops.rows });
});

// Compute an estimate for a given operation + vehicle class + rate tier
app.get('/api/admin/labor-estimate', requireAdmin, async (req, res) => {
  const code = (req.query.code || '').trim();
  const klass = (req.query.class || 'compact').trim();
  const tier = (req.query.tier || 'Standard').trim();
  if (!code) return res.status(400).json({ error: 'code required' });
  const [op, vc, rt] = await Promise.all([
    query('SELECT * FROM labor_rates WHERE code = $1', [code]),
    query('SELECT labor_multiplier::float AS m FROM vehicle_classes WHERE code = $1', [klass]),
    query('SELECT rate_usd::float AS r FROM labor_rate_tiers WHERE name = $1', [tier]),
  ]);
  if (!op.rows.length) return res.status(404).json({ error: 'operation not found' });
  const mult = (vc.rows[0] && vc.rows[0].m) || 1.0;
  const rate = (rt.rows[0] && rt.rows[0].r) || 35.0;
  const hours = Math.round(Number(op.rows[0].base_hours) * mult * 100) / 100;
  const total = Math.round(hours * rate * 100) / 100;
  res.json({
    operation: op.rows[0], hours, rate_usd: rate, total_usd: total,
    vehicle_class: klass, multiplier: mult, tier,
  });
});

// External catalog deep-links — opens AllData / Mitchell / Identifix with VIN
// pre-filled. We don't pay for an API, but their search URLs accept query
// params, so the technician's existing login picks it up.
app.get('/api/admin/external-refs', requireAdmin, (req, res) => {
  const vin = (req.query.vin || '').trim().toUpperCase();
  const year = req.query.year || '';
  const make = (req.query.make || '').trim();
  const model = (req.query.model || '').trim();
  res.json({
    links: [
      { name: 'AllData Repair', icon: '🔧', url: vin ? `https://www.alldatadiy.com/alldatadiy/index.html?vin=${encodeURIComponent(vin)}` : `https://www.alldata.com/us/en/auto-repair-software?make=${encodeURIComponent(make)}&model=${encodeURIComponent(model)}&year=${encodeURIComponent(year)}`, note: 'Requires AllData subscription' },
      { name: 'Mitchell 1 ProDemand', icon: '📖', url: 'https://prodemand.mitchell1.com/', note: 'Sign in to your ProDemand account; search for the VIN there' },
      { name: 'Identifix Direct-Hit', icon: '🎯', url: 'https://www.identifix.com/', note: 'Confirmed fixes by VIN — sign in required' },
      { name: 'NHTSA Recalls (free)', icon: '⚠', url: vin ? `https://www.nhtsa.gov/recalls?vin=${encodeURIComponent(vin)}` : 'https://www.nhtsa.gov/recalls', note: 'Free recall lookup by VIN' },
      { name: 'Google: TSBs', icon: '🔍', url: `https://www.google.com/search?q=${encodeURIComponent((year + ' ' + make + ' ' + model + ' TSB technical service bulletin').trim())}`, note: 'Public-facing TSB search' },
      { name: 'Google: Repair forum', icon: '💬', url: `https://www.google.com/search?q=${encodeURIComponent((year + ' ' + make + ' ' + model + ' repair forum').trim())}`, note: 'Owner-community fixes' },
      { name: 'YouTube: How-to', icon: '📺', url: `https://www.youtube.com/results?search_query=${encodeURIComponent((year + ' ' + make + ' ' + model + ' repair').trim())}`, note: 'Video walkthroughs' },
    ],
  });
});

// =============================================================================
//  WAREHOUSE — stock counts, bin checks, deliveries, activity audit
// =============================================================================
async function logActivity(kind, opts) {
  try {
    await query(
      `INSERT INTO warehouse_activity (kind, product_img, product_id, qty_before, qty_after, qty_delta, bin_location, performed_by, ref_kind, ref_id, notes)
         VALUES ($1,$2,(SELECT id FROM products WHERE img = $2),$3,$4,$5,$6,$7,$8,$9,$10)`,
      [kind, opts.product_img || null, opts.qty_before || null, opts.qty_after || null,
       opts.qty_delta || null, opts.bin_location || null, opts.performed_by || null,
       opts.ref_kind || null, opts.ref_id || null, opts.notes || null]
    );
  } catch (e) { console.warn('[activity]', e.message); }
}

async function nextStockCountNumber() {
  const year = new Date().getFullYear();
  const { rows } = await query(`SELECT COUNT(*)::int AS n FROM stock_counts WHERE count_number LIKE $1`, [`SC-${year}-%`]);
  return `SC-${year}-${String(rows[0].n + 1).padStart(4, '0')}`;
}

// Create a new stock count session (full inventory or scoped to a bin/category)
app.post('/api/admin/stock-counts', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const scope = ['full','bin','category'].includes(b.scope) ? b.scope : 'full';
  try {
    const num = await nextStockCountNumber();
    const { rows: c } = await query(
      `INSERT INTO stock_counts (count_number, scope, scope_value, counted_by, notes) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [num, scope, b.scope_value || null, b.counted_by || null, b.notes || null]
    );
    const countId = c[0].id;
    // Seed count-items snapshot of current product stock matching scope
    let where = 'is_active = true';
    const params = [];
    if (scope === 'bin') { params.push(b.scope_value || ''); where += ` AND bin_location = $${params.length}`; }
    else if (scope === 'category') { params.push(b.scope_value || ''); where += ` AND category = $${params.length}`; }
    const { rows: prods } = await query(`SELECT id, img, bin_location, stock_count FROM products WHERE ${where} ORDER BY bin_location NULLS LAST, name`, params);
    for (const p of prods) {
      await query(
        `INSERT INTO stock_count_items (count_id, product_img, product_id, bin_location, system_qty) VALUES ($1,$2,$3,$4,$5)`,
        [countId, p.img, p.id, p.bin_location, p.stock_count]
      );
    }
    await query(`UPDATE stock_counts SET total_items = $1 WHERE id = $2`, [prods.length, countId]);
    res.json({ ok: true, id: countId, count_number: num, total_items: prods.length });
  } catch (e) { console.error('[stock count create]', e); res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/stock-counts', requireAdmin, async (_req, res) => {
  const { rows } = await query(
    `SELECT sc.*, m.name AS counter_name FROM stock_counts sc
       LEFT JOIN mechanics m ON m.id = sc.counted_by
       ORDER BY sc.started_at DESC LIMIT 100`
  );
  res.json({ counts: rows });
});

app.get('/api/admin/stock-counts/:id', requireAdmin, async (req, res) => {
  const { rows: c } = await query(
    `SELECT sc.*, m.name AS counter_name FROM stock_counts sc LEFT JOIN mechanics m ON m.id = sc.counted_by WHERE sc.id = $1`,
    [req.params.id]
  );
  if (!c.length) return res.status(404).json({ error: 'Count not found' });
  const { rows: items } = await query(
    `SELECT sci.*, p.name AS product_name, p.sku FROM stock_count_items sci
       LEFT JOIN products p ON p.id = sci.product_id
       WHERE sci.count_id = $1 ORDER BY sci.bin_location NULLS LAST, p.name`,
    [req.params.id]
  );
  res.json({ count: c[0], items });
});

// Update a single count item (record the physical count)
app.patch('/api/admin/stock-count-items/:id', requireAdmin, async (req, res) => {
  const b = req.body || {};
  if (b.counted_qty == null) return res.status(400).json({ error: 'counted_qty required' });
  await query(
    `UPDATE stock_count_items SET counted_qty = $1, notes = COALESCE($2, notes), counted_at = NOW() WHERE id = $3`,
    [parseInt(b.counted_qty, 10), b.notes || null, req.params.id]
  );
  res.json({ ok: true });
});

// Post a stock count — applies all counted_qty values to products, logs activity, closes the session
app.post('/api/admin/stock-counts/:id/post', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: c } = await client.query('SELECT * FROM stock_counts WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!c.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Count not found' }); }
    if (c[0].status === 'posted') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Already posted' }); }
    const { rows: items } = await client.query('SELECT * FROM stock_count_items WHERE count_id = $1 AND counted_qty IS NOT NULL', [req.params.id]);
    let totalVar = 0;
    for (const it of items) {
      const delta = (it.counted_qty || 0) - it.system_qty;
      if (delta !== 0 && it.product_img) {
        await client.query('UPDATE products SET stock_count = $1 WHERE img = $2', [it.counted_qty, it.product_img]);
        // Activity log
        await client.query(
          `INSERT INTO warehouse_activity (kind, product_img, product_id, qty_before, qty_after, qty_delta, performed_by, ref_kind, ref_id, notes)
             VALUES ('count_post', $1, (SELECT id FROM products WHERE img = $1), $2, $3, $4, $5, 'stock_count', $6, $7)`,
          [it.product_img, it.system_qty, it.counted_qty, delta, c[0].counted_by, c[0].id, 'Adjusted from stock count ' + c[0].count_number]
        );
        totalVar += Math.abs(delta);
      }
    }
    await client.query(`UPDATE stock_counts SET status='posted', posted_at=NOW(), total_variance=$1 WHERE id=$2`, [totalVar, req.params.id]);
    await client.query('COMMIT');
    res.json({ ok: true, total_variance: totalVar, items_adjusted: items.length });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[stock count post]', e); res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// Bin check — quick lookup of every product expected in a given bin
app.get('/api/admin/bin/:bin', requireAdmin, async (req, res) => {
  const { rows } = await query(
    `SELECT img, name, sku, barcode, category, stock_count, low_threshold FROM products WHERE bin_location = $1 ORDER BY name`,
    [req.params.bin]
  );
  res.json({ bin: req.params.bin, products: rows });
});

// POS barcode-gun scan: the counter's #posScan input calls this on every
// Enter. A scanner always sends the complete code, so this is a plain exact
// match (case-insensitive) on sku/barcode/img -- no ILIKE, no ranking, just
// the fastest possible indexed lookup (idx_products_sku / idx_products_barcode
// / the products_img_key unique constraint). Falls back to the free-text
// search box in the UI when nothing matches, so this only needs to handle
// the exact-hit case well. Was referenced by admin.html but never existed
// server-side -- every scan silently degraded to a text search before this.
// Every /api/admin/pos/* endpoint requires the pos.access capability -- the
// whole terminal, not just individual actions. Finer caps (discount, charge
// sale, ...) are checked at their own endpoints on top of this.
app.use('/api/admin/pos', requireCap('pos.access'));

app.get('/api/admin/pos/scan', requireAdmin, async (req, res) => {
  const code = (req.query.code || '').trim();
  if (!code) return res.status(400).json({ error: 'code required' });
  const { rows } = await query(
    `SELECT img, name, make_model, category, condition, price_usd, stock_count, low_threshold,
            sku, barcode, bin_location, location,
            CASE WHEN stock_count <= 0 THEN 'out'
                 WHEN stock_count <= low_threshold THEN 'low'
                 ELSE 'in' END AS stock_level
       FROM products
      WHERE is_active = true AND (lower(sku) = lower($1) OR lower(barcode) = lower($1) OR img = $1)
      LIMIT 1`,
    [code]
  );
  if (!rows.length) return res.status(404).json({ error: 'No product matches that code' });
  res.json({ product: rows[0] });
});

// Search a product by SKU or barcode (mobile-scan friendly)
app.get('/api/admin/lookup', requireAdmin, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'q required' });
  const { rows } = await query(
    `SELECT img, name, sku, barcode, category, condition, price_usd::float AS price_usd, cost_usd::float AS cost_usd, stock_count, bin_location FROM products
       WHERE sku = $1 OR barcode = $1 OR name ILIKE '%' || $2 || '%' LIMIT 30`,
    [q, q]
  );
  res.json({ products: rows });
});

// Quick stock adjustment endpoint (audit-logged)
app.post('/api/admin/stock-adjust', requireAdmin, requireCap('inventory.adjust_stock'), async (req, res) => {
  const b = req.body || {};
  if (!b.product_img || b.new_qty == null) return res.status(400).json({ error: 'product_img and new_qty required' });
  const { rows: before } = await query('SELECT stock_count FROM products WHERE img = $1', [b.product_img]);
  if (!before.length) return res.status(404).json({ error: 'Product not found' });
  const newQty = Math.max(0, parseInt(b.new_qty, 10));
  await query('UPDATE products SET stock_count = $1 WHERE img = $2', [newQty, b.product_img]);
  await logActivity('adjust', { product_img: b.product_img, qty_before: before[0].stock_count, qty_after: newQty, qty_delta: newQty - before[0].stock_count, performed_by: b.performed_by, ref_kind: 'manual', notes: b.reason || 'Manual adjustment' });
  res.json({ ok: true, qty_before: before[0].stock_count, qty_after: newQty });
});

// Activity log
app.get('/api/admin/warehouse-activity', requireAdmin, async (req, res) => {
  const limit = Math.min(500, parseInt(req.query.limit, 10) || 100);
  const productImg = req.query.product || null;
  const sql = productImg
    ? `SELECT wa.*, p.name AS product_name, m.name AS performer_name FROM warehouse_activity wa
         LEFT JOIN products p ON p.id = wa.product_id
         LEFT JOIN mechanics m ON m.id = wa.performed_by
         WHERE wa.product_img = $1 ORDER BY wa.created_at DESC LIMIT $2`
    : `SELECT wa.*, p.name AS product_name, m.name AS performer_name FROM warehouse_activity wa
         LEFT JOIN products p ON p.id = wa.product_id
         LEFT JOIN mechanics m ON m.id = wa.performed_by
         ORDER BY wa.created_at DESC LIMIT $1`;
  const { rows } = productImg ? await query(sql, [productImg, limit]) : await query(sql, [limit]);
  res.json({ activity: rows });
});

// ===== DELIVERIES =====
async function nextDeliveryNumber() {
  const year = new Date().getFullYear();
  const { rows } = await query(`SELECT COUNT(*)::int AS n FROM deliveries WHERE delivery_number LIKE $1`, [`DEL-${year}-%`]);
  return `DEL-${year}-${String(rows[0].n + 1).padStart(4, '0')}`;
}

app.get('/api/admin/deliveries', requireAdmin, async (req, res) => {
  const status = req.query.status || null;
  const sql = status
    ? `SELECT d.*, m.name AS driver_name FROM deliveries d LEFT JOIN mechanics m ON m.id = d.driver_id WHERE d.status = $1 ORDER BY COALESCE(d.scheduled_for, d.created_at) DESC LIMIT 100`
    : `SELECT d.*, m.name AS driver_name FROM deliveries d LEFT JOIN mechanics m ON m.id = d.driver_id ORDER BY COALESCE(d.scheduled_for, d.created_at) DESC LIMIT 100`;
  const { rows } = status ? await query(sql, [status]) : await query(sql);
  res.json({ deliveries: rows });
});

app.post('/api/admin/deliveries', requireAdmin, async (req, res) => {
  const b = req.body || {};
  if (!b.recipient_name) return res.status(400).json({ error: 'recipient_name required' });
  const num = await nextDeliveryNumber();
  const { rows } = await query(
    `INSERT INTO deliveries (delivery_number, related_kind, related_id, recipient_name, recipient_phone, address, driver_id, vehicle, scheduled_for, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [num, b.related_kind || null, b.related_id || null, b.recipient_name, b.recipient_phone || null,
     b.address || null, b.driver_id || null, b.vehicle || null, b.scheduled_for || null, b.notes || null, req.session.userId]
  );
  res.json({ ok: true, id: rows[0].id, delivery_number: num });
});

app.patch('/api/admin/deliveries/:id', requireAdmin, async (req, res) => {
  const fields = ['status','driver_id','vehicle','scheduled_for','dispatched_at','delivered_at','proof_photo','proof_signature','recipient_received_by','notes','recipient_name','recipient_phone','address'];
  const sets = []; const vals = [];
  for (const f of fields) if (req.body && req.body[f] !== undefined) { sets.push(`${f} = $${sets.length+1}`); vals.push(req.body[f]); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(req.params.id);
  await query(`UPDATE deliveries SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
  if (req.body && req.body.status === 'dispatched') await query(`UPDATE deliveries SET dispatched_at = COALESCE(dispatched_at, NOW()) WHERE id = $1`, [req.params.id]);
  if (req.body && req.body.status === 'delivered') {
    await query(`UPDATE deliveries SET delivered_at = COALESCE(delivered_at, NOW()) WHERE id = $1`, [req.params.id]);
    await logActivity('delivery', { ref_kind:'delivery', ref_id: req.params.id, notes: 'Marked delivered' });
  }
  res.json({ ok: true });
});

// Update a product's hero photo via upload (camera/file) OR URL
app.post('/api/admin/products-photo', requireAdmin, upload.single('photo'), async (req, res) => {
  const b = req.body || {};
  const productImg = b.product_img;
  if (!productImg) return res.status(400).json({ error: 'product_img required' });
  let newImgPath = null;
  if (req.file) newImgPath = '/uploads/products/' + req.file.filename;
  else if (b.url) newImgPath = b.url;
  else return res.status(400).json({ error: 'photo file or url required' });
  // Move file from default upload dir into /uploads/products/ if it came from multer
  if (req.file) {
    const productsDir = path.join(UPLOAD_DIR, 'products');
    fs.mkdirSync(productsDir, { recursive: true });
    const finalName = req.file.filename;
    const destPath = path.join(productsDir, finalName);
    try { fs.renameSync(req.file.path, destPath); } catch (_) {}
  }
  // We're updating photo URL — products use img as primary key, so we keep the original img
  // and store the new photo path in a separate column (re-use bin_location? no, add hero_photo)
  // For simplicity, update the product's img if it's also a /uploads path; otherwise just log.
  await logActivity('photo_update', { product_img: productImg, performed_by: b.performed_by, notes: 'Photo updated to ' + newImgPath, ref_kind: 'manual' });
  res.json({ ok: true, photo_url: newImgPath });
});

// =============================================================================
//  MARKETING — campaigns, segmentation
// =============================================================================
async function recipientsForSegment(seg) {
  let where = "email IS NOT NULL AND email <> '' AND email_opt_in = true";
  if (seg === 'retail') where += " AND (price_tier IS NULL OR price_tier = 'retail')";
  else if (seg === 'trade') where += " AND price_tier = 'trade'";
  else if (seg === 'fleet') where += " AND price_tier = 'fleet'";
  else if (seg === 'dealer') where += " AND price_tier = 'dealer'";
  else if (seg === 'inactive_60d') where += " AND id IN (SELECT user_id FROM orders WHERE created_at < NOW() - INTERVAL '60 days' EXCEPT SELECT user_id FROM orders WHERE created_at >= NOW() - INTERVAL '60 days')";
  else if (seg === 'loyalty_high') where += " AND id IN (SELECT user_id FROM user_points WHERE balance >= 500)";
  const { rows } = await query(`SELECT id, name, email, phone FROM users WHERE ${where} LIMIT 5000`);
  return rows;
}

app.get('/api/admin/marketing/segments/count', requireAdmin, async (_req, res) => {
  const segs = ['all','retail','trade','fleet','dealer','inactive_60d','loyalty_high'];
  const counts = {};
  for (const s of segs) {
    try { counts[s] = (await recipientsForSegment(s === 'all' ? '' : s)).length; }
    catch (_) { counts[s] = 0; }
  }
  res.json({ counts });
});

app.get('/api/admin/marketing/campaigns', requireAdmin, async (_req, res) => {
  const { rows } = await query('SELECT * FROM marketing_campaigns ORDER BY created_at DESC LIMIT 100');
  res.json({ campaigns: rows });
});

app.post('/api/admin/marketing/campaigns', requireManager, async (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.body) return res.status(400).json({ error: 'name and body required' });
  const kind = ['email','sms','whatsapp','social'].includes(b.kind) ? b.kind : 'email';
  const { rows } = await query(
    `INSERT INTO marketing_campaigns (name, kind, subject, body, segment, scheduled_for, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [b.name, kind, b.subject || null, b.body, b.segment || 'all', b.scheduled_for || null, b.scheduled_for ? 'scheduled' : 'draft', req.session.userId]
  );
  res.json({ ok: true, id: rows[0].id });
});

app.post('/api/admin/marketing/campaigns/:id/send', requireManager, async (req, res) => {
  const { rows: c } = await query('SELECT * FROM marketing_campaigns WHERE id = $1', [req.params.id]);
  if (!c.length) return res.status(404).json({ error: 'Campaign not found' });
  if (c[0].status === 'sent') return res.status(400).json({ error: 'Already sent' });
  const recipients = await recipientsForSegment(c[0].segment === 'all' ? '' : c[0].segment);
  let sent = 0, failed = 0;
  // Best-effort send via existing mailer / sms; if unavailable, just log
  for (const r of recipients) {
    try {
      if (c[0].kind === 'email' && r.email) {
        await mailer.sendEmail({ to: r.email, subject: c[0].subject || c[0].name, text: c[0].body, html: '<p>' + c[0].body.replace(/\n/g, '<br/>') + '</p>' });
        sent++;
      } else if (c[0].kind === 'sms' && r.phone) {
        await sms.sendSMS({ to: r.phone, body: c[0].body });
        sent++;
      } else {
        // 'whatsapp' and 'social' are manual share — just count as attempt
        sent++;
      }
    } catch (e) { failed++; console.warn('[campaign send]', e.message); }
  }
  await query(
    `UPDATE marketing_campaigns SET status = 'sent', sent_at = NOW(), recipients_count = $1, sent_count = $2, failed_count = $3 WHERE id = $4`,
    [recipients.length, sent, failed, req.params.id]
  );
  res.json({ ok: true, recipients: recipients.length, sent, failed });
});

app.delete('/api/admin/marketing/campaigns/:id', requireManager, async (req, res) => {
  await query('DELETE FROM marketing_campaigns WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// =============================================================================
//  CSV IMPORT — parts / vehicles / services
//  CSV format: first row is header; common synonyms accepted (e.g. 'price' or 'price_usd').
// =============================================================================
function parseCSV(text) {
  const out = []; let row = []; let cur = ''; let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i+1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n') { row.push(cur); out.push(row); row = []; cur = ''; }
      else if (c === '\r') { /* skip */ }
      else cur += c;
    }
  }
  if (cur.length || row.length) { row.push(cur); out.push(row); }
  return out.filter(r => r.length > 1 || (r.length === 1 && r[0].trim() !== ''));
}
function csvToObjects(text) {
  const rows = parseCSV(text);
  if (!rows.length) return [];
  const headers = rows[0].map(h => String(h || '').trim().toLowerCase().replace(/\s+/g, '_'));
  return rows.slice(1).map(r => {
    const o = {};
    headers.forEach((h, i) => { o[h] = String(r[i] == null ? '' : r[i]).trim(); });
    return o;
  });
}

// ---- INVENTORY IMPORT ------------------------------------------------------
// Accepts the shop's own "Stock Listing" export, a spreadsheet, or anything
// close to either, and upserts it into products. See inventory-import.js for
// the parsing; this half is the database half.
//
// Two-step by design: mode=preview parses and reports without writing
// anything, mode=commit does the work. An inventory file is the whole
// catalogue -- letting one wrong upload silently overwrite 23,000 rows with
// no chance to look first is not a risk worth taking for one saved click.
const inventoryImport = require('./inventory-import');

// Which product columns an uploaded file is allowed to write, and how each
// behaves on a row that already exists.
//   overwrite : the file is authoritative (quantities, condition)
//   fill      : only fills a blank -- never erases what is already there
// price/cost are "fill" on purpose: the stock export carries no pricing at
// all, so treating it as authoritative would wipe every price the counter
// staff had entered by hand.
const IMPORT_COLUMN_RULES = {
  sku:           'fill',
  name:          'overwrite',
  make_model:    'overwrite',
  category:      'overwrite',
  condition:     'overwrite',
  price_usd:     'fill',
  cost_usd:      'fill',
  stock_count:   'overwrite',
  low_threshold: 'overwrite',
  bin_location:  'overwrite',
  location:      'overwrite',
  barcode:       'fill',
};
const IMPORT_COLUMNS = Object.keys(IMPORT_COLUMN_RULES);

function readUploadedFile(req) {
  const file = req.file;
  if (!file) {
    const e = new Error('Choose a .csv, .tsv or .xlsx file to import.');
    e.userFacing = true;
    throw e;
  }
  const buf = fs.readFileSync(file.path);
  fs.unlink(file.path, () => {});
  return { buf, name: file.originalname || file.filename };
}

async function handleInventoryImport(req, res) {
  const mode = (req.query.mode || req.body.mode || 'preview').toLowerCase();
  const deactivateMissing =
    String(req.query.deactivate_missing || req.body.deactivate_missing || '') === 'true';

  let parsed, sourceName;
  try {
    const { buf, name } = readUploadedFile(req);
    sourceName = name;
    parsed = await inventoryImport.parseInventoryFile(buf, name);
  } catch (e) {
    if (e.userFacing) return res.status(400).json({ error: e.message });
    console.error('[inventory import] parse failed:', e);
    return res.status(400).json({ error: 'Could not read that file: ' + e.message });
  }

  const { items, issues, mapped, ignoredColumns, headerLine, format, detail, totalDataRows } = parsed;

  // A file we can read but recognise nothing in is more dangerous than one we
  // reject: committing it would blank out names across the catalogue.
  if (!items.length) {
    return res.status(400).json({
      error: 'No usable rows found. The header row was line ' + headerLine +
             ' and none of the rows under it had a part number.',
      mapped, ignoredColumns, issues: issues.slice(0, 50),
    });
  }
  if (mapped.sku == null && mapped.img == null) {
    return res.status(400).json({
      error: 'No part-number column found. One column must hold the part number ' +
             '(named Item, Part No, SKU or similar) so rows can be matched to existing stock.',
      mapped, ignoredColumns,
    });
  }

  const keys = items.map((it) => it.img);

  // Which of these already exist? Drives the preview counts, and afterwards
  // the "not in the file" set when deactivate_missing is on.
  const { rows: existingRows } = await query(
    'SELECT img FROM products WHERE img = ANY($1::text[])', [keys]
  );
  const existing = new Set(existingRows.map((r) => r.img));
  const uniqueKeys = new Set(keys);
  const willUpdate = [...uniqueKeys].filter((k) => existing.has(k)).length;
  const willInsert = uniqueKeys.size - willUpdate;

  let deactivateCount = 0;
  if (deactivateMissing) {
    const { rows } = await query(
      'SELECT COUNT(*)::int AS n FROM products WHERE is_active = true AND NOT (img = ANY($1::text[]))',
      [keys]
    );
    deactivateCount = rows[0].n;
  }

  const summary = {
    file: sourceName,
    format,
    detail,
    header_line: headerLine,
    mapped_columns: mapped,
    ignored_columns: ignoredColumns,
    rows_in_file: totalDataRows,
    rows_usable: items.length,
    unique_parts: uniqueKeys.size,
    will_add: willInsert,
    will_update: willUpdate,
    will_deactivate: deactivateCount,
    issues: issues.slice(0, 200),
    issue_count: issues.length,
    sample: items.slice(0, 15),
  };

  if (mode !== 'commit') {
    return res.json(Object.assign({ ok: true, mode: 'preview', committed: false }, summary));
  }

  // ---- commit ----
  // Only columns the file actually supplied are updated. A stock count sheet
  // with no category column must not stamp "Other" over every category, and
  // that is exactly what updating a fixed column list would do.
  const present = IMPORT_COLUMNS.filter((c) => mapped[c] != null);
  // The part number is written into img for identity; keep sku in step with it
  // even when the header was called something else.
  if (!present.includes('sku')) present.push('sku');

  const setClause = present.map((c) => {
    if (IMPORT_COLUMN_RULES[c] === 'fill') {
      return c + ' = COALESCE(EXCLUDED.' + c + ', products.' + c + ')';
    }
    if (c === 'name' || c === 'make_model') {
      return c + ' = COALESCE(NULLIF(EXCLUDED.' + c + ', \'\'), products.' + c + ')';
    }
    return c + ' = EXCLUDED.' + c;
  }).concat(['is_active = true', 'updated_at = NOW()']).join(', ');

  const cols = ['img'].concat(IMPORT_COLUMNS);
  const CHUNK = 400;
  const client = await pool.connect();
  let inserted = 0, updated = 0;
  try {
    await client.query('BEGIN');

    for (let start = 0; start < items.length; start += CHUNK) {
      const slice = items.slice(start, start + CHUNK);
      const params = [];
      const tuples = slice.map((it) => {
        const vals = [
          it.img, it.sku, it.name, it.make_model,
          it.category || 'Other', it.condition,
          it.price_usd, it.cost_usd, it.stock_count, it.low_threshold,
          it.bin_location, it.location, it.barcode,
        ];
        const ph = vals.map((v) => { params.push(v); return '$' + params.length; });
        return '(' + ph.join(',') + ')';
      });

      const { rows } = await client.query(
        'INSERT INTO products (' + cols.join(', ') + ') VALUES ' + tuples.join(',') +
        ' ON CONFLICT (img) DO UPDATE SET ' + setClause +
        ' RETURNING (xmax = 0) AS inserted',
        params
      );
      for (const r of rows) { if (r.inserted) inserted++; else updated++; }
    }

    if (deactivateMissing) {
      await client.query(
        'UPDATE products SET is_active = false, updated_at = NOW() ' +
        'WHERE is_active = true AND NOT (img = ANY($1::text[]))',
        [keys]
      );
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[inventory import] commit failed:', e);
    return res.status(500).json({
      error: 'Import failed and nothing was changed: ' + e.message,
    });
  } finally {
    client.release();
  }

  console.log('[inventory import]', sourceName, '->', inserted, 'added,', updated, 'updated');
  res.json(Object.assign({ ok: true, mode: 'commit', committed: true, inserted, updated }, summary));
}

app.post('/api/admin/inventory/import', requireManager, uploadData.single('file'), handleInventoryImport);
// Kept so anything already pointed at the old path keeps working; the field
// name differs (`csv`), which is the only reason this is a separate line.
app.post('/api/admin/import/parts', requireManager, uploadData.single('csv'), handleInventoryImport);

// A known-good starting file, so nobody has to reverse-engineer the columns.
app.get('/api/admin/inventory/import/template.csv', requireAdmin, (_req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="meltha-inventory-template.csv"');
  res.send(inventoryImport.TEMPLATE_CSV);
});

// Every column name the importer understands, so the admin screen can show
// them instead of hard-coding a list that drifts out of date.
app.get('/api/admin/inventory/import/columns', requireAdmin, (_req, res) => {
  res.json({ fields: inventoryImport.FIELD_SYNONYMS });
});


// uploadData, not upload: the shared `upload` instance only accepts images, so
// this endpoint rejected every CSV sent to it before the handler ever ran --
// the same bug the parts importer had.
app.post('/api/admin/import/services', requireManager, uploadData.single('csv'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'CSV file required' });
  try {
    const text = fs.readFileSync(req.file.path, 'utf8');
    fs.unlink(req.file.path, () => {});
    const rows = csvToObjects(text);
    let inserted = 0, skipped = 0;
    for (const r of rows) {
      const name = (r.name || r.service || r.description || '').trim();
      if (!name) { skipped++; continue; }
      await query(
        `INSERT INTO services (code, name, category, description, default_hours, default_price_usd, default_labor_usd, default_parts_usd)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (code) DO NOTHING`,
        [
          r.code || null, name, r.category || null, r.description || null,
          parseFloat(r.default_hours || r.hours) || 1.0,
          parseFloat(r.default_price_usd || r.price) || null,
          parseFloat(r.default_labor_usd || r.labor) || null,
          parseFloat(r.default_parts_usd || r.parts) || null,
        ]
      );
      inserted++;
    }
    res.json({ ok: true, total: rows.length, inserted, skipped });
  } catch (e) { console.error('[import services]', e); res.status(500).json({ error: e.message }); }
});

// =============================================================================
//  SUPPLIERS / VENDORS
// =============================================================================
app.get('/api/admin/suppliers', requireAdmin, async (req, res) => {
  const where = req.query.active === 'true' ? 'WHERE is_active = true' : '';
  const { rows } = await query(
    `SELECT id, code, name, contact_name, phone, email, address, website,
            payment_terms, account_number, lead_time_days, notes, is_active, created_at
       FROM suppliers ${where} ORDER BY is_active DESC, name ASC`
  );
  res.json({ suppliers: rows });
});

app.post('/api/admin/suppliers', requireManager, async (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'name required' });
  try {
    const { rows } = await query(
      `INSERT INTO suppliers (code, name, contact_name, phone, email, address, website, payment_terms, account_number, lead_time_days, notes, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [b.code || null, b.name, b.contact_name || null, b.phone || null, b.email || null,
       b.address || null, b.website || null, b.payment_terms || null, b.account_number || null,
       b.lead_time_days ? parseInt(b.lead_time_days, 10) : 7, b.notes || null, b.is_active !== false]
    );
    res.json({ ok: true, id: rows[0].id });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Supplier code already in use' });
    console.error(e); res.status(500).json({ error: e.message });
  }
});

app.patch('/api/admin/suppliers/:id', requireManager, async (req, res) => {
  const fields = ['code','name','contact_name','phone','email','address','website','payment_terms','account_number','lead_time_days','notes','is_active'];
  const sets = []; const vals = [];
  for (const f of fields) if (req.body && req.body[f] !== undefined) { sets.push(`${f} = $${sets.length+1}`); vals.push(req.body[f]); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(req.params.id);
  await query(`UPDATE suppliers SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
  res.json({ ok: true });
});

app.delete('/api/admin/suppliers/:id', requireManager, async (req, res) => {
  await query('UPDATE suppliers SET is_active = false WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// Extended product PATCH (the existing endpoint only handles a few fields)
app.patch('/api/admin/products-ext/:img', requireAdmin, async (req, res) => {
  const fields = ['name','make_model','category','condition','price_usd','stock_count','low_threshold','is_active',
    'sku','barcode','supplier_id','cost_usd','core_charge_usd','env_fee_usd','warranty_days','serial_required',
    'weight_kg','dim_cm','bin_location','min_stock','markup_pct'];
  const sets = []; const vals = [];
  for (const f of fields) if (req.body && req.body[f] !== undefined) { sets.push(`${f} = $${sets.length+1}`); vals.push(req.body[f]); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(req.params.img);
  await query(`UPDATE products SET ${sets.join(', ')} WHERE img = $${vals.length}`, vals);
  res.json({ ok: true });
});

// Extended product list with all part-dept fields and supplier name
app.get('/api/admin/products-ext', requireAdmin, async (req, res) => {
  const search = (req.query.q || '').trim();
  const lowOnly = req.query.low === 'true';
  const where = []; const vals = [];
  if (search) {
    // Multi-pass comma-separated search (up to 4 terms, AND-matched).
    const terms = search.split(',').map(t => t.trim()).filter(Boolean).slice(0, 4);
    for (const t of terms) {
      vals.push('%' + t + '%');
      where.push(`(p.name ILIKE $${vals.length} OR p.sku ILIKE $${vals.length} OR p.barcode ILIKE $${vals.length} OR p.make_model ILIKE $${vals.length} OR p.category ILIKE $${vals.length})`);
    }
  }
  if (lowOnly) where.push('p.stock_count <= COALESCE(p.low_threshold, 4)');
  const { rows } = await query(
    `SELECT p.img, p.name, p.make_model, p.category, p.condition,
            p.price_usd::float AS price_usd, p.cost_usd::float AS cost_usd,
            p.stock_count, p.low_threshold, p.min_stock, p.is_active,
            p.sku, p.barcode, p.core_charge_usd::float AS core_charge_usd,
            p.env_fee_usd::float AS env_fee_usd, p.warranty_days, p.serial_required,
            p.weight_kg::float AS weight_kg, p.dim_cm, p.bin_location, p.markup_pct::float AS markup_pct,
            p.supplier_id, s.name AS supplier_name
       FROM products p LEFT JOIN suppliers s ON s.id = p.supplier_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY p.is_active DESC, p.name ASC LIMIT 300`,
    vals
  );
  res.json({ products: rows });
});

// =============================================================================
//  PURCHASE ORDERS — order from suppliers, receive into inventory
// =============================================================================
async function nextPoNumber() {
  const year = new Date().getFullYear();
  const { rows } = await query(`SELECT COUNT(*)::int AS n FROM purchase_orders WHERE po_number LIKE $1`, [`PO-${year}-%`]);
  return `PO-${year}-${String(rows[0].n + 1).padStart(4, '0')}`;
}

app.get('/api/admin/purchase-orders', requireAdmin, async (req, res) => {
  const status = req.query.status || null;
  const sql = status
    ? `SELECT po.*, s.name AS supplier_name FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id WHERE po.status = $1 ORDER BY po.created_at DESC LIMIT 200`
    : `SELECT po.*, s.name AS supplier_name FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id ORDER BY po.created_at DESC LIMIT 200`;
  const { rows } = status ? await query(sql, [status]) : await query(sql);
  res.json({ purchase_orders: rows });
});

app.get('/api/admin/purchase-orders/:id', requireAdmin, async (req, res) => {
  const { rows: po } = await query(`SELECT po.*, s.name AS supplier_name, s.phone AS supplier_phone, s.email AS supplier_email FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id WHERE po.id = $1`, [req.params.id]);
  if (!po.length) return res.status(404).json({ error: 'PO not found' });
  const { rows: items } = await query(`SELECT poi.*, p.name AS product_name, p.stock_count AS current_stock FROM purchase_order_items poi LEFT JOIN products p ON p.id = poi.product_id WHERE poi.po_id = $1 ORDER BY poi.id`, [req.params.id]);
  res.json({ purchase_order: po[0], items });
});

app.post('/api/admin/purchase-orders', requireManager, async (req, res) => {
  const b = req.body || {};
  if (!b.supplier_id) return res.status(400).json({ error: 'supplier_id required' });
  try {
    const poNum = await nextPoNumber();
    const { rows } = await query(
      `INSERT INTO purchase_orders (po_number, supplier_id, expected_date, notes, created_by)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [poNum, b.supplier_id, b.expected_date || null, b.notes || null, req.session.userId]
    );
    res.json({ ok: true, id: rows[0].id, po_number: poNum });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.patch('/api/admin/purchase-orders/:id', requireManager, async (req, res) => {
  const fields = ['status','expected_date','received_date','shipping_usd','tax_usd','invoice_number','notes'];
  const sets = []; const vals = [];
  for (const f of fields) if (req.body && req.body[f] !== undefined) { sets.push(`${f} = $${sets.length+1}`); vals.push(req.body[f]); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(req.params.id);
  await query(`UPDATE purchase_orders SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
  res.json({ ok: true });
});

async function recalcPoTotals(poId) {
  const { rows: it } = await query('SELECT COALESCE(SUM(total_usd),0)::float AS s FROM purchase_order_items WHERE po_id = $1', [poId]);
  const { rows: po } = await query('SELECT shipping_usd::float AS sh, tax_usd::float AS tx FROM purchase_orders WHERE id = $1', [poId]);
  const sub = it[0].s; const tot = sub + (po[0].sh || 0) + (po[0].tx || 0);
  await query('UPDATE purchase_orders SET subtotal_usd = $1, total_usd = $2 WHERE id = $3', [sub, tot, poId]);
}

app.post('/api/admin/purchase-orders/:id/items', requireManager, async (req, res) => {
  const b = req.body || {};
  if (!b.description || !b.qty_ordered || b.unit_cost_usd == null) return res.status(400).json({ error: 'description, qty_ordered, unit_cost_usd required' });
  const qty = parseInt(b.qty_ordered, 10); const cost = Number(b.unit_cost_usd);
  const total = Math.round(qty * cost * 100) / 100;
  await query(`INSERT INTO purchase_order_items (po_id, product_img, product_id, sku, description, qty_ordered, unit_cost_usd, total_usd, condition, notes) VALUES ($1,$2,(SELECT id FROM products WHERE img = $2),$3,$4,$5,$6,$7,$8,$9)`,
    [req.params.id, b.product_img || null, b.sku || null, b.description, qty, cost, total, b.condition || 'NEW', b.notes || null]);
  await recalcPoTotals(req.params.id);
  res.json({ ok: true });
});

app.delete('/api/admin/purchase-orders/:poId/items/:id', requireManager, async (req, res) => {
  await query('DELETE FROM purchase_order_items WHERE id = $1 AND po_id = $2', [req.params.id, req.params.poId]);
  await recalcPoTotals(req.params.poId);
  res.json({ ok: true });
});

// Receive a PO (full or partial): bumps inventory + updates last cost.
// Body: { items: [{ id: <po_item_id>, qty_now: <number> }, ...] }
app.post('/api/admin/purchase-orders/:id/receive', requireManager, async (req, res) => {
  const items = (req.body && req.body.items) || [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let anyOutstanding = false;
    for (const r of items) {
      const qty = parseInt(r.qty_now, 10);
      if (!qty || qty < 1) continue;
      const { rows: poi } = await client.query('SELECT * FROM purchase_order_items WHERE id = $1', [r.id]);
      if (!poi.length) continue;
      const it = poi[0];
      const max = it.qty_ordered - it.qty_received;
      const got = Math.min(qty, max);
      if (got <= 0) continue;
      // Bump inventory if linked to a product. Cost tracks the PO line's unit
      // cost; a sell price and/or bin can be set on the same action.
      if (it.product_img) {
        await client.query('UPDATE products SET stock_count = stock_count + $1, cost_usd = $2 WHERE img = $3', [got, it.unit_cost_usd, it.product_img]);
        const pn = (r.price_now != null && r.price_now !== '' && Number.isFinite(Number(r.price_now))) ? Number(r.price_now) : null;
        if (pn != null) await client.query('UPDATE products SET price_usd = $1 WHERE img = $2', [pn, it.product_img]);
        if (r.bin_now != null && String(r.bin_now).trim()) await client.query('UPDATE products SET bin_location = $1 WHERE img = $2', [String(r.bin_now).trim(), it.product_img]);
      }
      await client.query('UPDATE purchase_order_items SET qty_received = qty_received + $1 WHERE id = $2', [got, it.id]);
      if (got < max) anyOutstanding = true;
    }
    // Also check items not in this batch but still outstanding
    const { rows: rem } = await client.query('SELECT SUM(qty_ordered - qty_received)::int AS r FROM purchase_order_items WHERE po_id = $1', [req.params.id]);
    const newStatus = (rem[0].r || 0) > 0 ? (anyOutstanding ? 'partial' : 'partial') : 'received';
    await client.query(`UPDATE purchase_orders SET status = $1, received_date = COALESCE(received_date, NOW()) WHERE id = $2`, [newStatus, req.params.id]);
    await client.query('COMMIT');
    res.json({ ok: true, status: newStatus });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[po receive]', e);
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// Receive stock straight into inventory without a purchase order -- a one-off
// delivery, a walk-in buy, a correction. Same effect as receiving a PO line:
// stock_count goes up, cost_usd is refreshed when a unit cost is given, and it
// lands in warehouse_activity so the movement is auditable. Each item must
// match an existing product by img (exact) or sku.
app.post('/api/admin/receive', requireManager, requireCap('inventory.adjust_stock'), async (req, res) => {
  const b = req.body || {};
  const rows = Array.isArray(b.items) ? b.items : [];
  if (!rows.length) return res.status(400).json({ error: 'items[] required' });
  const supplierId = b.supplier_id ? parseInt(b.supplier_id, 10) : null;
  const invoice = String(b.invoice || b.reference || '').trim();
  const note = String(b.notes || '').trim();
  let supplierName = null;
  if (supplierId) {
    const { rows: sr } = await query('SELECT name FROM suppliers WHERE id = $1', [supplierId]);
    supplierName = sr.length ? sr[0].name : null;
  }
  const activityNote = [
    supplierName ? 'supplier: ' + supplierName : '',
    invoice ? 'invoice ' + invoice : '',
    note,
  ].filter(Boolean).join(' · ') || 'Received without a PO';

  const client = await pool.connect();
  const results = [];
  try {
    await client.query('BEGIN');
    for (const r of rows) {
      const qty = parseInt(r.qty, 10);
      if (!qty || qty < 1) { results.push({ ok: false, error: 'qty must be a positive whole number', item: r }); continue; }
      const key = String(r.product_img || r.sku || '').trim();
      if (!key) { results.push({ ok: false, error: 'product_img or sku required', item: r }); continue; }
      const { rows: pr } = await client.query(
        'SELECT img, name, stock_count FROM products WHERE img = $1 OR (sku IS NOT NULL AND sku = $1) LIMIT 1', [key]);
      if (!pr.length) { results.push({ ok: false, error: 'no product matches "' + key + '"', item: r }); continue; }
      const p = pr[0];
      await client.query('UPDATE products SET stock_count = stock_count + $1 WHERE img = $2', [qty, p.img]);
      const num = function (v) { return (v != null && v !== '') && Number.isFinite(Number(v)) ? Number(v) : null; };
      const cost = num(r.unit_cost_usd);
      const price = num(r.price_usd);
      if (cost != null)  await client.query('UPDATE products SET cost_usd  = $1 WHERE img = $2', [cost, p.img]);
      if (price != null) await client.query('UPDATE products SET price_usd = $1 WHERE img = $2', [price, p.img]);
      if (r.name != null && String(r.name).trim()) await client.query('UPDATE products SET name = $1 WHERE img = $2', [String(r.name).trim(), p.img]);
      if (r.location != null) await client.query('UPDATE products SET location = $1 WHERE img = $2', [String(r.location), p.img]);
      if (r.bin_location != null) await client.query('UPDATE products SET bin_location = $1 WHERE img = $2', [String(r.bin_location), p.img]);
      if (supplierId) await client.query('UPDATE products SET supplier_id = COALESCE(supplier_id, $1) WHERE img = $2', [supplierId, p.img]);
      await logActivity('receive', {
        product_img: p.img, qty_before: p.stock_count, qty_after: p.stock_count + qty, qty_delta: qty,
        bin_location: r.bin_location != null ? String(r.bin_location) : null,
        ref_kind: 'no_po', ref_id: supplierId, notes: activityNote,
      });
      results.push({ ok: true, product_img: p.img, name: p.name, qty_added: qty, stock_after: p.stock_count + qty });
    }
    await client.query('COMMIT');
    res.json({ ok: results.every((x) => x.ok), received: results });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[receive no-po]', e);
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// =============================================================================
//  POS — counter sales
// =============================================================================
async function nextReceiptNumber() {
  const year = new Date().getFullYear();
  const { rows } = await query(`SELECT COUNT(*)::int AS n FROM pos_sales WHERE receipt_number LIKE $1`, [`R-${year}-%`]);
  return `R-${year}-${String(rows[0].n + 1).padStart(5, '0')}`;
}

// A sale's invoice number, distinct from its receipt number (0010). Trade
// customers file by invoice, and it is what the invoice document prints as the
// document number. Same count-based scheme as nextReceiptNumber(); no UNIQUE
// constraint backs invoice_number, so a rare concurrent collision is harmless.
async function nextInvoiceNumber() {
  const year = new Date().getFullYear();
  const { rows } = await query(`SELECT COUNT(*)::int AS n FROM pos_sales WHERE invoice_number LIKE $1`, [`INV-${year}-%`]);
  return `INV-${year}-${String(rows[0].n + 1).padStart(5, '0')}`;
}

// Save the current cart as a quote (no inventory deduction, no payment captured)
async function nextQuoteNumber() {
  const year = new Date().getFullYear();
  const { rows } = await query(`SELECT COUNT(*)::int AS n FROM pos_quotes WHERE quote_number LIKE $1`, [`Q-${year}-%`]);
  return `Q-${year}-${String(rows[0].n + 1).padStart(4, '0')}`;
}

// =============================================================================
//  POS HOLDS -- park a cart mid-sale (F7), pick it back up later (F8 ->
//  Recall -> Held tickets). See schema.sql's note on this table for why
//  this whole section is new: the client has called these routes since the
//  split-tender feature shipped, and none of them existed.
// =============================================================================
// MAX + 1, not COUNT + 1. This is the one that bites in ordinary counter work:
// hold_number is UNIQUE NOT NULL, and discarding a parked ticket really does
// DELETE the row (DELETE FROM pos_holds below). Park two, discard one, park
// again -- the count says 1, so the next hold claims H-YYYY-0002, which the
// surviving ticket already owns, and parking the sale fails. See
// nextWoNumber() for the general shape of the bug.
async function nextHoldNumber() {
  const year = new Date().getFullYear();
  const { rows } = await query(
    `SELECT COALESCE(MAX(substring(hold_number from '[0-9]+$')::bigint), 0) AS n
       FROM pos_holds WHERE hold_number LIKE $1`,
    [`H-${year}-%`]
  );
  return `H-${year}-${String(Number(rows[0].n) + 1).padStart(4, '0')}`;
}

app.post('/api/admin/pos/hold', requireAdmin, requireCap('pos.hold_recall'), async (req, res) => {
  const b = req.body || {};
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) return res.status(400).json({ error: 'Cart is empty' });
  // Server-computed, not trusted from the client -- same reasoning as the
  // quote/sale totals elsewhere in this file. Not taxed/discounted here
  // (a hold isn't a transaction, just a parked cart) -- that math happens
  // again, for real, whenever it's recalled and actually checked out.
  let subtotal = 0;
  for (const it of items) subtotal += (Number(it.unit_price_usd) || 0) * (Number(it.qty) || 0);
  subtotal = Math.round(subtotal * 100) / 100;
  const num = await nextHoldNumber();
  const { rows } = await query(
    `INSERT INTO pos_holds (hold_number, label, items_json, subtotal_usd, customer_id, customer_name, customer_phone,
                            vehicle_info, sales_rep_id, sales_rep_name, notes, held_by, held_by_name)
       VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10,$11,$12,
               (SELECT COALESCE(name, email) FROM users WHERE id = $12))
       RETURNING id, hold_number, created_at`,
    [num, b.label || null, JSON.stringify(items), subtotal, b.customer_id || null, b.customer_name || null,
     b.customer_phone || null, b.vehicle_info || null, b.sales_rep_id || null, b.sales_rep_name || null,
     b.notes || null, req.session.userId || null]
  );
  res.json({ ok: true, id: rows[0].id, hold_number: rows[0].hold_number, created_at: rows[0].created_at });
});

app.get('/api/admin/pos/holds', requireAdmin, async (req, res) => {
  const { rows } = await query(
    `SELECT id, hold_number, label, items_json, ROUND(subtotal_usd * 100)::int AS subtotal_cents,
            customer_id, customer_name, customer_phone, vehicle_info, sales_rep_id, sales_rep_name,
            notes, held_by_name, created_at
       FROM pos_holds ORDER BY created_at DESC LIMIT 100`
  );
  res.json({ holds: rows });
});

app.get('/api/admin/pos/holds/:id', requireAdmin, async (req, res) => {
  const { rows } = await query(
    `SELECT id, hold_number, label, items_json, ROUND(subtotal_usd * 100)::int AS subtotal_cents,
            customer_id, customer_name, customer_phone, vehicle_info, sales_rep_id, sales_rep_name,
            notes, held_by_name, created_at
       FROM pos_holds WHERE id = $1`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Hold not found' });
  res.json({ hold: rows[0] });
});

app.delete('/api/admin/pos/holds/:id', requireAdmin, async (req, res) => {
  await query('DELETE FROM pos_holds WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

app.post('/api/admin/pos/quote', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) return res.status(400).json({ error: 'At least one item required' });
  try {
    let subtotal = 0;
    for (const it of items) subtotal += (Number(it.unit_price_usd) * Number(it.qty)) + Number(it.core_charge_usd || 0) + Number(it.env_fee_usd || 0);
    subtotal = Math.round(subtotal * 100) / 100;
    const discount = Number(b.discount_usd || 0);
    const taxable = Math.max(0, subtotal - discount);
    const tax = Math.round(taxable * TAX_RATE * 100) / 100;
    const total = Math.round((taxable + tax) * 100) / 100;
    const num = await nextQuoteNumber();
    const shopSettings = await getShopSettings();
    const validDays = Number(shopSettings.quote_valid_days) || 14;
    const validUntil = b.valid_until || (function(){ var d = new Date(); d.setDate(d.getDate() + validDays); return d.toISOString().slice(0,10); })();
    const { rows } = await query(
      `INSERT INTO pos_quotes (quote_number, cashier_id, customer_id, customer_name, customer_phone, customer_email, vehicle_info,
                               subtotal_usd, tax_usd, discount_usd, total_usd, items_json, valid_until, notes,
                               sales_rep_id, sales_rep_name, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17) RETURNING id`,
      [num, b.cashier_id || null, Number.isInteger(b.customer_id) ? b.customer_id : null,
       b.customer_name || null, b.customer_phone || null, b.customer_email || null,
       b.vehicle_info || null, subtotal, tax, discount, total, JSON.stringify(items), validUntil, b.notes || null,
       // sales_rep_id is a mechanics FK -- integer id only; the name is free text (see the sale endpoint).
       Number.isInteger(b.sales_rep_id) ? b.sales_rep_id : null,
       b.sales_rep_name ? String(b.sales_rep_name).slice(0, 200) : null,
       req.session.userId || null]
    );
    res.json({ ok: true, id: rows[0].id, quote_number: num, total_usd: total, total_cents: Math.round(total * 100) });
  } catch (e) { console.error('[quote create]', e); res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/pos/quotes', requireAdmin, async (_req, res) => {
  const { rows } = await query(`SELECT id, quote_number, customer_name, customer_phone, total_usd::float AS total_usd, status, valid_until, created_at FROM pos_quotes ORDER BY created_at DESC LIMIT 200`);
  res.json({ quotes: rows });
});

app.get('/api/admin/pos/quotes/:id', requireAdmin, async (req, res) => {
  const { rows } = await query('SELECT * FROM pos_quotes WHERE id = $1 OR quote_number = $2', [parseInt(req.params.id, 10) || 0, (req.params.id || '').toUpperCase()]);
  if (!rows.length) return res.status(404).json({ error: 'Quote not found' });
  res.json({ quote: rows[0], shop: shopSettingsToShop(await getShopSettings()) });
});

// =============================================================================
//  Tender Modal Phase 2 — split tender, loyalty redemption, customer lookup
// =============================================================================
// Request body shape (back-compat):
//   {
//     items: [...],
//     // EITHER (split tender — preferred):
//     payments: [{ method, amount_usd, amount_tendered?, reference?, notes? }, ...],
//     // OR (single tender — legacy / phase 1):
//     payment_method, amount_tendered, reference,
//     discount_usd,
//     customer_id?, customer_name, customer_phone, vehicle_info, notes,
//     loyalty_points_redeemed?  // integer points to burn for discount
//   }
app.post('/api/admin/pos/sale', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) return res.status(400).json({ error: 'At least one item required' });

  // Normalise payments. If `payments` array is missing, build a 1-row list
  // from the legacy single-method fields so Phase-1 clients keep working.
  let payments = Array.isArray(b.payments) ? b.payments.slice() : null;
  if (!payments || !payments.length) {
    if (!b.payment_method) return res.status(400).json({ error: 'payment_method or payments[] required' });
    payments = [{
      method: b.payment_method,
      amount_usd: null,            // filled in below to total - other tenders
      amount_tendered: b.amount_tendered != null ? Number(b.amount_tendered) : null,
      reference: b.reference || null,
      notes: null,
    }];
  }
  for (const p of payments) {
    if (!p.method) return res.status(400).json({ error: 'Each payment row needs a method' });
    if (!['cash','card','cheque','bank','loyalty','gift_card','account'].includes(p.method))
      return res.status(400).json({ error: 'Unknown payment method: ' + p.method });
  }

  // ----- Per-user permission gate ------------------------------------------
  // Re-checked here, not just hidden in the POS: a denied cashier posting the
  // sale straight to the API is exactly what UI-only enforcement would miss.
  {
    const lineDisc = items.reduce((s, it) => s + Math.max(0, Number(it.discount_usd || 0)), 0);
    if (lineDisc > 0 && !(await userCan(req, 'pos.line_discount')))
      return res.status(403).json({ error: 'Your account is not allowed to give a per-line discount.' });
    if (Number(b.discount_usd || 0) > 0 && !(await userCan(req, 'pos.ticket_discount')))
      return res.status(403).json({ error: 'Your account is not allowed to give a whole-ticket discount.' });
    if (payments.some((p) => p.method === 'account') && !(await userCan(req, 'pos.charge_to_account')))
      return res.status(403).json({ error: 'Your account is not allowed to take a charge / account sale.' });
    if (b.no_tax === true && !(await userCan(req, 'pos.no_tax')))
      return res.status(403).json({ error: 'Your account is not allowed to switch GCT off.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ----- 1. Compute totals -----------------------------------------------
    // Per line: gross, then a per-line discount (0010) capped at the line
    // gross, then the net. `subtotal` is the sum of the NETs -- the client's
    // posTotals() already removes the per-line discount before it gets here,
    // and until 0010 the server did not, so any per-line discount was silently
    // charged straight back to the customer. lineCalc is reused when the line
    // items are inserted below so the arithmetic happens exactly once.
    const lineCalc = items.map((it) => {
      const gross = Math.round((Number(it.unit_price_usd) * Number(it.qty)
        + Number(it.core_charge_usd || 0) + Number(it.env_fee_usd || 0)) * 100) / 100;
      const disc = Math.min(gross, Math.max(0, Number(it.discount_usd || 0)));
      return { gross, disc, net: Math.round((gross - disc) * 100) / 100 };
    });
    let subtotal = Math.round(lineCalc.reduce((s, l) => s + l.net, 0) * 100) / 100;
    const manualDiscount = Math.max(0, Number(b.discount_usd || 0));

    // ----- 2. Loyalty redemption (server-validated) --------------------------
    // The POS ticket bar defaults every new ticket to the shared "Cash
    // Customer - Walk-in" account (see getWalkinCustomerId()) so counter
    // sales always have a real customer_id to attach to. That account must
    // never earn or redeem points -- it's one row shared by every walk-in
    // sale, so points on it would be meaningless (and redemption would let
    // one walk-in spend points a different walk-in "earned").
    const walkinId = await getWalkinCustomerId();
    const isWalkinCustomer = b.customer_id && Number(b.customer_id) === walkinId;
    const redeemPts = isWalkinCustomer ? 0 : Math.max(0, parseInt(b.loyalty_points_redeemed || 0, 10) || 0);
    let loyaltyDiscount = 0;
    if (redeemPts > 0) {
      if (!b.customer_id) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'customer_id required to redeem loyalty points' });
      }
      const { rows: balRows } = await client.query('SELECT balance FROM user_points WHERE user_id = $1', [b.customer_id]);
      const balance = (balRows[0] && balRows[0].balance) || 0;
      if (redeemPts > balance) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Customer only has ' + balance + ' points (tried to redeem ' + redeemPts + ')' });
      }
      loyaltyDiscount = Math.round(redeemPts * POINTS_USD_RATE * 100) / 100;
    }

    // ----- 2b. Customer terms: discount ceiling, tax exemption + (later, step
    // 3c) credit limit. Fetched before the tax calc below since tax_exempt
    // has to affect it. Always checked when a real customer is attached --
    // not just enforced in the UI, so a sale can't slip past these by going
    // straight to the API.
    let customerLimits = null;
    if (b.customer_id && !isWalkinCustomer) {
      const { rows: cl } = await client.query(
        `SELECT credit_limit_usd, discount_limit_pct, payment_terms_days, tax_exempt FROM users WHERE id = $1`,
        [b.customer_id]
      );
      customerLimits = cl[0] || null;
      if (customerLimits && customerLimits.discount_limit_pct != null && subtotal > 0) {
        const discountPct = (manualDiscount / subtotal) * 100;
        if (discountPct > Number(customerLimits.discount_limit_pct) + 0.01) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: `Discount of ${discountPct.toFixed(1)}% exceeds this customer's limit of ${Number(customerLimits.discount_limit_pct)}%`,
          });
        }
      }
    }
    // Either the customer is flagged tax-exempt, or the operator switched GCT
    // off for this one ticket (POS cart toggle -> body.no_tax). Both land in the
    // same stored tax_exempt flag: no GCT was charged, whatever the reason.
    const taxExempt = !!(customerLimits && customerLimits.tax_exempt) || req.body.no_tax === true;

    const totalDiscount = Math.round((manualDiscount + loyaltyDiscount) * 100) / 100;

    // Fulfilment + shipping (0010). A pickup never carries a delivery fee; for
    // 'delivery' (own van) / 'shipping' (courier) the fee is taxed alongside
    // the goods, matching the client's posTotals().
    const fulfilment = ['pickup', 'delivery', 'shipping'].includes(b.fulfilment) ? b.fulfilment : 'pickup';
    const shipFee = fulfilment === 'pickup'
      ? 0
      : Math.max(0, Math.round((Number(b.ship_fee_usd) || 0) * 100) / 100);

    const goods = Math.max(0, Math.round((subtotal - totalDiscount) * 100) / 100);
    const taxable = Math.round((goods + shipFee) * 100) / 100;
    const tax = taxExempt ? 0 : Math.round(taxable * TAX_RATE * 100) / 100;
    const total = Math.round((taxable + tax) * 100) / 100;

    // ----- 3. Distribute payment amounts -------------------------------------
    // For any row with amount_usd == null/blank, treat it as "the rest".
    // Validate total tendered >= total (cash overpay is fine — drives change).
    let allocated = 0;
    const filledPayments = payments.map(function(p){
      var amt = p.amount_usd != null && p.amount_usd !== '' ? Number(p.amount_usd) : null;
      if (amt != null) allocated += amt;
      return Object.assign({}, p, { amount_usd: amt });
    });
    const remaining = Math.round((total - allocated) * 100) / 100;
    // Apply the remainder to the first unspecified row (typical "cash for the rest" flow).
    const blank = filledPayments.findIndex(function(p){ return p.amount_usd == null; });
    if (blank >= 0) {
      filledPayments[blank].amount_usd = Math.max(0, remaining);
    } else if (Math.abs(remaining) > 0.01) {
      // All rows have explicit amounts — they must sum to the total.
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Sum of payment amounts ($' + allocated.toFixed(2) + ') does not match total ($' + total.toFixed(2) + ')' });
    }

    // Sum of "actual money in" — cash uses amount_tendered when present, else amount_usd.
    let moneyIn = 0;
    for (const p of filledPayments) {
      if (p.method === 'cash' && p.amount_tendered != null) moneyIn += Number(p.amount_tendered);
      else moneyIn += Number(p.amount_usd);
    }
    if (moneyIn + 0.001 < total) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Tendered ($' + moneyIn.toFixed(2) + ') is less than total ($' + total.toFixed(2) + ')' });
    }
    const changeDue = Math.round((moneyIn - total) * 100) / 100;

    // ----- 3b. Gift card validation (server-validated balance, real deduction
    // happens in step 5 below) -- gift_card has been a valid tender method
    // since the split-tender feature shipped, but nothing backed it until now.
    for (const p of filledPayments) {
      if (p.method !== 'gift_card') continue;
      if (!p.reference) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Gift card payments need the card code in "reference"' });
      }
      const { rows: gc } = await client.query(
        'SELECT id, balance_usd, is_active FROM gift_cards WHERE code = $1 FOR UPDATE',
        [p.reference.toUpperCase()]
      );
      if (!gc.length || !gc[0].is_active) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Gift card ' + p.reference + ' not found or inactive' });
      }
      if (Number(gc[0].balance_usd) < Number(p.amount_usd) - 0.001) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Gift card ' + p.reference + ' has insufficient balance ($' + Number(gc[0].balance_usd).toFixed(2) + ')' });
      }
    }

    // ----- 3c. Credit-limit check -- only when some part of this sale is
    // actually going "on account". No AR receipts/payments-against-balance
    // feature exists yet, so "current balance" here is every dollar ever
    // charged to the account (not yet netted against payments made toward
    // it) -- an honest, if conservative, ceiling until that's built.
    const accountAmount = filledPayments.filter(p => p.method === 'account').reduce((s, p) => s + Number(p.amount_usd), 0);
    if (accountAmount > 0.001) {
      if (!b.customer_id || isWalkinCustomer) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'A real customer account is required to charge a sale to account' });
      }
      if (!customerLimits || customerLimits.payment_terms_days == null) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'This customer has no payment terms set up -- cannot sell on account' });
      }
      if (customerLimits.credit_limit_usd != null) {
        const currentBalance = await getAccountBalance(b.customer_id, client.query.bind(client));
        const projected = currentBalance + accountAmount;
        if (projected > Number(customerLimits.credit_limit_usd) + 0.01) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: `This sale would put the account at $${projected.toFixed(2)}, over its $${Number(customerLimits.credit_limit_usd).toFixed(2)} credit limit`,
          });
        }
      }
    }

    // ----- 3d. Payment status (0010) --------------------------------------
    // amount_paid_usd is every dollar that came in as real money (cash / card /
    // cheque / bank / gift card / loyalty); balance_due_usd is the part that
    // left on the customer's account and is what the invoice prints as BALANCE
    // DUE. It falls to zero later as settlement payments are recorded.
    const balanceDue = Math.round(Math.min(accountAmount, total) * 100) / 100;
    const amountPaid = Math.round((total - balanceDue) * 100) / 100;
    const paymentStatus = balanceDue <= 0.001 ? 'paid'
                        : balanceDue + 0.001 >= total ? 'unpaid'
                        : 'partial';
    // due_date is free text off the account tender row -- keep it only if it
    // parses as a date, otherwise the customer's payment terms decide it.
    let dueDate = null;
    if (balanceDue > 0.001) {
      if (b.due_date && !isNaN(Date.parse(b.due_date))) {
        dueDate = new Date(b.due_date).toISOString().slice(0, 10);
      } else if (customerLimits && customerLimits.payment_terms_days != null) {
        dueDate = new Date(Date.now() + Number(customerLimits.payment_terms_days) * 86400000).toISOString().slice(0, 10);
      }
    }

    // ----- 4. Insert the sale ------------------------------------------------
    const headerMethod = filledPayments.length === 1 ? filledPayments[0].method : 'split';
    const headerRef = filledPayments.length === 1 ? (filledPayments[0].reference || null)
                       : filledPayments.map(function(p){ return p.method + (p.reference ? ':' + p.reference : ''); }).join(' + ');
    const headerTendered = filledPayments.length === 1 && filledPayments[0].method === 'cash'
        ? filledPayments[0].amount_tendered : null;
    const earnedPoints = (b.customer_id && !isWalkinCustomer) ? Math.floor(total) : 0;

    const receipt = await nextReceiptNumber();
    const invoiceNumber = await nextInvoiceNumber();
    const { rows: sale } = await client.query(
      `INSERT INTO pos_sales (receipt_number, invoice_number, cashier_id, customer_id, customer_name, customer_phone, vehicle_info,
                              subtotal_usd, tax_usd, tax_exempt, discount_usd, total_usd, amount_tendered, change_due,
                              payment_method, reference, notes,
                              loyalty_points_redeemed, loyalty_discount_usd, loyalty_points_earned,
                              sales_rep_id, sales_rep_name,
                              fulfilment, ship_method, ship_fee_usd, ship_name, ship_phone,
                              ship_line1, ship_line2, ship_city, ship_parish, ship_instructions,
                              payment_status, amount_paid_usd, balance_due_usd, due_date, po_number, quote_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
                 $23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38) RETURNING id`,
      [receipt, invoiceNumber, b.cashier_id || req.session.userId, b.customer_id || null,
       b.customer_name || null, b.customer_phone || null, b.vehicle_info || null,
       subtotal, tax, taxExempt, totalDiscount, total, headerTendered, changeDue,
       headerMethod, headerRef, b.notes || null,
       redeemPts, loyaltyDiscount, earnedPoints,
       // sales_rep_id is a mechanics FK -- take it only when it is a real
       // integer id. The client sends null for a signed-in user with no staff
       // row and passes just the name, which the free-text column below keeps.
       Number.isInteger(b.sales_rep_id) ? b.sales_rep_id : null,
       b.sales_rep_name ? String(b.sales_rep_name).slice(0, 200) : null,
       fulfilment,
       fulfilment === 'pickup' ? null : (b.ship_method ? String(b.ship_method).slice(0, 120) : null),
       shipFee,
       fulfilment === 'pickup' ? null : (b.ship_name || null),
       fulfilment === 'pickup' ? null : (b.ship_phone || null),
       fulfilment === 'pickup' ? null : (b.ship_line1 || null),
       fulfilment === 'pickup' ? null : (b.ship_line2 || null),
       fulfilment === 'pickup' ? null : (b.ship_city || null),
       fulfilment === 'pickup' ? null : (b.ship_parish || null),
       fulfilment === 'pickup' ? null : (b.ship_instructions || null),
       paymentStatus, amountPaid, balanceDue, dueDate,
       b.po_number ? String(b.po_number).slice(0, 60) : null,
       Number.isInteger(b.quote_id) ? b.quote_id : null]
    );
    const saleId = sale[0].id;

    // ----- 5. Insert payments (split tender ledger) --------------------------
    for (const p of filledPayments) {
      const amt = Math.round(Number(p.amount_usd) * 100) / 100;
      await client.query(
        `INSERT INTO sale_payments (sale_id, method, amount_usd, amount_tendered, reference, notes)
           VALUES ($1,$2,$3,$4,$5,$6)`,
        [saleId, p.method, amt,
         p.amount_tendered != null ? Number(p.amount_tendered) : null,
         p.reference || null, p.notes || null]
      );
      if (p.method === 'gift_card') {
        const { rows: gcRow } = await client.query(
          `UPDATE gift_cards SET balance_usd = balance_usd - $1, last_used_at = NOW() WHERE code = $2 RETURNING id`,
          [amt, p.reference.toUpperCase()]
        );
        if (gcRow.length) {
          await client.query(
            `INSERT INTO gift_card_transactions (gift_card_id, delta_usd, reason, reference, performed_by) VALUES ($1,$2,'redemption',$3,$4)`,
            [gcRow[0].id, -amt, receipt, req.session.userId]
          );
        }
      }
    }

    // ----- 6. Line items + inventory deduction -------------------------------
    for (let li = 0; li < items.length; li++) {
      const it = items[li];
      const lc = lineCalc[li];   // { gross, disc, net } computed once in step 1
      let warrantyUntil = null;
      if (it.warranty_days) warrantyUntil = new Date(Date.now() + Number(it.warranty_days) * 86400000).toISOString().slice(0,10);
      await client.query(
        `INSERT INTO pos_sale_items (sale_id, product_img, product_id, description, qty, unit_price_usd, core_charge_usd, env_fee_usd, discount_usd, discount_note, serial_number, warranty_until, total_usd)
           VALUES ($1,$2,(SELECT id FROM products WHERE img = $2),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [saleId, it.product_img || null, it.description, Number(it.qty), Number(it.unit_price_usd),
         Number(it.core_charge_usd || 0), Number(it.env_fee_usd || 0),
         lc.disc, lc.disc > 0 && it.discount_note ? String(it.discount_note).slice(0, 300) : null,
         it.serial_number || null, warrantyUntil, lc.net]
      );
      if (it.product_img) {
        await client.query('UPDATE products SET stock_count = GREATEST(0, stock_count - $1) WHERE img = $2', [Number(it.qty), it.product_img]);
      }
    }

    // ----- 7. Loyalty: deduct redeemed + award earned (same txn) -------------
    if (b.customer_id && redeemPts > 0) {
      await client.query(
        `INSERT INTO points_transactions (user_id, delta, reason, reference_id) VALUES ($1, $2, 'redemption', $3)`,
        [b.customer_id, -redeemPts, saleId]
      );
    }
    if (b.customer_id && earnedPoints > 0) {
      // ON CONFLICT DO NOTHING via the uq_points_earn unique index — safe on retry.
      await client.query(
        `INSERT INTO points_transactions (user_id, delta, reason, reference_id)
           VALUES ($1, $2, 'purchase', $3)
         ON CONFLICT DO NOTHING`,
        [b.customer_id, earnedPoints, saleId]
      );
    }

    // ----- 8. Close out the quote / hold this sale came from (0010) ---------
    // A sale rung off a saved quote marks that quote converted so it drops off
    // the open-work list; a sale rung from a recalled hold discards the hold
    // (nothing was ever tendered against it -- see the pos_holds note).
    if (Number.isInteger(b.quote_id)) {
      await client.query(
        `UPDATE pos_quotes SET status = 'converted', converted_sale_id = $1
           WHERE id = $2 AND converted_sale_id IS NULL`,
        [saleId, b.quote_id]
      );
    }
    if (Number.isInteger(b.hold_id)) {
      await client.query('DELETE FROM pos_holds WHERE id = $1', [b.hold_id]);
    }

    await client.query('COMMIT');
    let newBalance = null;
    if (b.customer_id) {
      const { rows: balRows } = await query('SELECT balance FROM user_points WHERE user_id = $1', [b.customer_id]);
      newBalance = (balRows[0] && balRows[0].balance) || 0;
    }
    res.json({
      ok: true,
      id: saleId,
      receipt_number: receipt,
      invoice_number: invoiceNumber,
      subtotal_usd: subtotal,
      discount_usd: totalDiscount,
      loyalty_discount_usd: loyaltyDiscount,
      tax_usd: tax,
      tax_exempt: taxExempt,
      ship_fee_usd: shipFee,
      fulfilment: fulfilment,
      total_usd: total,
      money_in: moneyIn,
      change_due: changeDue,
      amount_paid_usd: amountPaid,
      balance_due_usd: balanceDue,
      payment_status: paymentStatus,
      due_date: dueDate,
      payments: filledPayments,
      loyalty: b.customer_id ? { points_redeemed: redeemPts, points_earned: earnedPoints, balance: newBalance } : null,
    });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[pos sale]', e);
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// -----------------------------------------------------------------------------
// Customer lookup for the POS tender modal.
// GET /api/admin/pos/customer-lookup?phone=...
// Returns id, name, phone, vehicle (most recent), price_tier, loyalty balance.
// -----------------------------------------------------------------------------
app.get('/api/admin/pos/customer-lookup', requireAdmin, async (req, res) => {
  const phone = (req.query.phone || '').toString().trim();
  const q     = (req.query.q     || '').toString().trim();
  if (!phone && !q) return res.json({ matches: [] });
  // Phone match: strip non-digits and compare last 7+ digits.
  const digits = phone.replace(/\D/g, '');
  const params = [];
  let where = '1=0';
  if (digits.length >= 4) {
    params.push('%' + digits.slice(-7) + '%');
    where = "regexp_replace(COALESCE(phone,''), '\\D', '', 'g') LIKE $" + params.length;
  }
  if (q) {
    params.push('%' + q.toLowerCase() + '%');
    where = (where === '1=0' ? '' : where + ' OR ') +
      '(LOWER(COALESCE(name,\'\')) LIKE $' + params.length + ' OR LOWER(COALESCE(email,\'\')) LIKE $' + params.length +
      ' OR LOWER(COALESCE(account_number,\'\')) LIKE $' + params.length + ')';
  }
  const sql =
    'SELECT u.id, u.name, u.email, u.phone, u.price_tier, u.discount_pct, u.account_number, ' +
    '       u.credit_limit_usd, u.payment_terms_days, u.discount_limit_pct, u.tax_exempt, ' +
    '       COALESCE(p.balance, 0) AS points_balance, ' +
    // Real balance owed (charged to 'account' minus payments recorded
    // against it -- see getAccountBalance()), in cents to match the field
    // name customerChip()/posCustomerModal on the client already expect.
    '       ROUND((COALESCE((SELECT SUM(sp.amount_usd) FROM sale_payments sp JOIN pos_sales s ON s.id = sp.sale_id ' +
    '                          WHERE sp.method = \'account\' AND s.customer_id = u.id AND s.voided = false), 0) ' +
    '            - COALESCE((SELECT SUM(amount_usd) FROM account_payments WHERE customer_id = u.id), 0)) * 100) AS open_balance_cents, ' +
    '       (SELECT vehicle_info FROM pos_sales WHERE customer_id = u.id AND vehicle_info IS NOT NULL ' +
    '          ORDER BY created_at DESC LIMIT 1) AS last_vehicle ' +
    '  FROM users u LEFT JOIN user_points p ON p.user_id = u.id ' +
    '  WHERE ' + where + ' ORDER BY u.name LIMIT 10';
  try {
    const { rows } = await query(sql, params);
    res.json({ matches: rows });
  } catch (e) {
    console.error('[customer-lookup]', e);
    res.status(500).json({ error: e.message });
  }
});

// Quick-add a customer mid-sale (posNewCustomerModal in admin.html). Referenced
// by that modal since the split-tender feature shipped but never existed here
// -- every "Create & attach" click failed. A counter sale shouldn't stall on
// a full sign-up flow, so email/password aren't required: a synthetic unique
// email and a random (unshared, unusable-to-sign-in-with) password fill the
// NOT NULL/UNIQUE columns the row still needs. The customer can be given real
// login credentials later (password reset) if they ever want online access.
app.post('/api/admin/pos/customer', requireAdmin, requireCap('pos.add_customer'), async (req, res) => {
  try {
    const b = req.body || {};
    const name = (b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    const phone = (b.phone || '').trim() || null;
    const priceTier = ['retail', 'trade', 'fleet', 'dealer'].includes(b.price_tier) ? b.price_tier : 'retail';
    const acctNo = await nextAccountNumber();
    const email = (b.email || '').trim().toLowerCase() || `${acctNo.toLowerCase()}@walkin.melthahonda.local`;
    const randomPassword = require('crypto').randomBytes(24).toString('hex');
    const hash = await bcrypt.hash(randomPassword, 10);
    const { rows } = await query(
      `INSERT INTO users (email, name, password_hash, phone, via, is_admin, price_tier, account_number)
         VALUES ($1, $2, $3, $4, 'pos', false, $5, $6)
         RETURNING id, email, name, phone, account_number`,
      [email, name, hash, phone, priceTier, acctNo]
    );
    res.json({ ok: true, id: rows[0].id, email: rows[0].email, account_number: rows[0].account_number });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'A customer with that email already exists' });
    console.error('[pos customer]', e);
    res.status(500).json({ error: e.message });
  }
});

// Sales-rep picker for the POS ticket bar. Referenced by admin.html
// (renderPOS's `reps` load) since the split-tender feature shipped but never
// existed here -- wrapped in a try/catch there, so it failed silently and
// the "sales rep" dropdown has always rendered with nothing to pick.
// Counter staff who can be picked as the sales rep, plus me_rep_id: which of
// them is the person currently signed in, so the till can default the rep to
// them instead of leaving a ticket crediting nobody.
//
// Resolved here rather than in the browser because it is not the id comparison
// it looks like. mechanics.id and users.id are separate id spaces, so matching
// a session's user id against a rep's id would credit whichever unrelated staff
// member happened to hold that number -- the same trap the D1 port already
// documents against parts_requisitions.fulfilled_by.
//
// mechanics.user_id is the correct link but is nullable and, in practice,
// always null: the Staff form collects name, role, phone, email, specialty and
// rate, and has never offered a way to set it. At this shop the counter staff
// and the sales reps are the same people, so fall back to the identity they do
// share -- their email -- and then to an unambiguous name match, so this works
// on the roster the shop actually has rather than one it would have to go back
// and re-link by hand.
app.get('/api/admin/pos/reps', requireAdmin, async (req, res) => {
  // Categories decide who is a sales rep now. The row returned is still the
  // mechanics one, because pos_sales.sales_rep_id and its seventeen sibling
  // foreign keys point there -- syncStaffProfile() keeps it in step with the
  // user. Staff carrying no category at all are still offered, so a shop that
  // has not sorted its roster yet is not left with an empty picker.
  const { rows } = await query(
    `SELECT m.id, m.user_id, m.name, m.role, m.email
       FROM mechanics m
      WHERE m.is_active = true
        AND (
          m.user_id IS NULL
          OR EXISTS (
            SELECT 1 FROM user_category_members mem
              JOIN user_categories c ON c.id = mem.category_id
             WHERE mem.user_id = m.user_id AND c.is_active = true
               AND c.code IN ('sales_rep','cashier','service_advisor','mechanic')
          )
          OR NOT EXISTS (SELECT 1 FROM user_category_members mem WHERE mem.user_id = m.user_id)
        )
      ORDER BY m.name`
  );

  const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();
  let meRepId = null;
  const { rows: meRows } = await query(
    'SELECT email, name FROM users WHERE id = $1', [req.session.userId]
  );
  const me = meRows[0];
  if (me) {
    let hit = rows.find((r) => r.user_id != null && r.user_id === req.session.userId);
    if (!hit && norm(me.email)) {
      hit = rows.find((r) => norm(r.email) && norm(r.email) === norm(me.email));
    }
    if (!hit && norm(me.name)) {
      // Only when it is unambiguous. Two active staff sharing a name is not
      // something to settle by guessing which of them earns the commission.
      const byName = rows.filter((r) => norm(r.name) === norm(me.name));
      if (byName.length === 1) hit = byName[0];
    }
    meRepId = hit ? hit.id : null;
  }

  // email was only needed for the match above; it is not part of this
  // endpoint's contract and the picker has no use for it.
  res.json({
    reps: rows.map((r) => ({ id: r.id, user_id: r.user_id, name: r.name, role: r.role })),
    me_rep_id: meRepId,
  });
});

// Distinct vehicle models actually in the catalogue, for the POS "Vehicle"
// filter dropdown. Derived from the live data rather than a hardcoded list
// so it can't drift out of sync with what's actually stocked (the exact
// failure this codebase has hit more than once with parallel/duplicated
// lists -- see ADMIN-POS-AUDIT.md). idx_products_make_model backs this.
app.get('/api/admin/pos/locations', requireAdmin, async (req, res) => {
  const { rows } = await query(
    `SELECT DISTINCT location FROM products WHERE is_active = true AND location IS NOT NULL AND location <> '' ORDER BY location`
  );
  res.json({ locations: rows.map((r) => r.location) });
});

app.get('/api/admin/pos/vehicle-models', requireAdmin, async (req, res) => {
  const { rows } = await query(
    `SELECT DISTINCT make_model FROM products WHERE is_active = true AND make_model IS NOT NULL AND make_model <> '' ORDER BY make_model`
  );
  res.json({ models: rows.map((r) => r.make_model) });
});

// The seeded "Cash Customer - Walk-in" account's id, so the POS ticket bar
// can default a new ticket to a real customer record instead of a bare text
// fallback. Cached client-side for the session -- this row's id never changes.
app.get('/api/admin/pos/walkin-customer', requireAdmin, async (req, res) => {
  const { rows } = await query(
    `SELECT id, name, account_number FROM users WHERE email = 'walkin@melthahonda.local' LIMIT 1`
  );
  if (!rows.length) return res.status(404).json({ error: 'Walk-in account not seeded yet' });
  res.json({ customer: rows[0] });
});

app.get('/api/admin/pos/sales', requireAdmin, async (req, res) => {
  const from = req.query.from || new Date().toISOString().slice(0,10);
  const to = req.query.to || from;
  const includeVoided = req.query.include_voided === '1' || req.query.include_voided === 'true';
  const { rows } = await query(
    `SELECT s.*, COALESCE(u.name, u.email) AS cashier_name FROM pos_sales s
       LEFT JOIN users u ON u.id = s.cashier_id
       WHERE s.created_at::date BETWEEN $1::date AND $2::date ${includeVoided ? '' : 'AND s.voided = false'}
       ORDER BY s.created_at DESC LIMIT 200`,
    [from, to]
  );
  res.json({ sales: rows });
});

app.get('/api/admin/pos/sales/:id', requireAdmin, async (req, res) => {
  const { rows: s } = await query(`SELECT s.*, COALESCE(u.name, u.email) AS cashier_name FROM pos_sales s LEFT JOIN users u ON u.id = s.cashier_id WHERE s.id = $1`, [req.params.id]);
  if (!s.length) return res.status(404).json({ error: 'Sale not found' });
  const { rows: items } = await query(
    `SELECT psi.*, p.name AS product_name, p.bin_location, p.location, p.stock_count, p.sku,
            COALESCE((SELECT SUM(pri.qty)::int FROM pos_sale_return_items pri WHERE pri.sale_item_id = psi.id), 0) AS returned_qty
       FROM pos_sale_items psi LEFT JOIN products p ON p.id = psi.product_id
       WHERE psi.sale_id = $1 ORDER BY psi.id`,
    [req.params.id]
  );
  const { rows: payments } = await query('SELECT * FROM sale_payments WHERE sale_id = $1 ORDER BY id', [req.params.id]);
  const { rows: returns } = await query(
    `SELECT r.*, COALESCE(u.name, u.email) AS processed_by_name FROM pos_sale_returns r
       LEFT JOIN users u ON u.id = r.processed_by WHERE r.sale_id = $1 ORDER BY r.created_at DESC`,
    [req.params.id]
  );
  // The lines behind each return, so a credit note / refund receipt can be
  // printed with the same per-item detail the original invoice carried.
  if (returns.length) {
    const { rows: retItems } = await query(
      `SELECT pri.return_id, pri.qty, pri.refund_usd,
              psi.description, psi.product_img, psi.unit_price_usd, p.sku
         FROM pos_sale_return_items pri
         JOIN pos_sale_items psi ON psi.id = pri.sale_item_id
         LEFT JOIN products p ON p.id = psi.product_id
        WHERE pri.return_id = ANY($1::int[])
        ORDER BY pri.id`,
      [returns.map((r) => r.id)]
    );
    const byRet = {};
    retItems.forEach((it) => { (byRet[it.return_id] = byRet[it.return_id] || []).push(it); });
    returns.forEach((r) => { r.items = byRet[r.id] || []; });
  }
  res.json({ sale: s[0], items, payments, returns });
});

app.post('/api/admin/pos/sales/:id/void', requireAdmin, requireCap('pos.void_sale'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: s } = await client.query('SELECT * FROM pos_sales WHERE id = $1', [req.params.id]);
    if (!s.length || s[0].voided) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Not voidable' }); }
    const { rows: items } = await client.query('SELECT * FROM pos_sale_items WHERE sale_id = $1', [req.params.id]);
    // Only restock what hasn't already come back through an itemized return
    // (POST .../return above) -- otherwise voiding a sale that already had a
    // partial return would restock those units a second time.
    const { rows: returnedRows } = await client.query(
      `SELECT sale_item_id, COALESCE(SUM(qty),0)::int AS qty FROM pos_sale_return_items
        WHERE sale_item_id IN (SELECT id FROM pos_sale_items WHERE sale_id = $1) GROUP BY sale_item_id`,
      [req.params.id]
    );
    const returnedById = {};
    returnedRows.forEach((r) => { returnedById[r.sale_item_id] = r.qty; });
    for (const it of items) {
      const restockQty = it.qty - (returnedById[it.id] || 0);
      if (it.product_img && restockQty > 0) await client.query('UPDATE products SET stock_count = stock_count + $1 WHERE img = $2', [restockQty, it.product_img]);
    }
    await client.query(`UPDATE pos_sales SET voided = true, voided_at = NOW(), voided_by = $1 WHERE id = $2`, [req.session.userId, req.params.id]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) { await client.query('ROLLBACK'); console.error(e); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

// =============================================================================
//  POS ITEMIZED RETURNS (P2, 2026-08-18) -- pick specific lines + quantities
//  off a prior sale (not the whole sale, that's /void above), refund a
//  prorated share of discount/tax, restock just those units, optionally issue
//  store credit as a new gift card, and roll back loyalty proportionally.
//  Can be called more than once against the same sale (partial returns over
//  multiple visits) -- qty already returned per line is tracked and checked.
// =============================================================================
async function nextReturnNumber() {
  const year = new Date().getFullYear();
  const { rows } = await query(`SELECT COUNT(*)::int AS n FROM pos_sale_returns WHERE return_number LIKE $1`, [`RET-${year}-%`]);
  return `RET-${year}-${String(rows[0].n + 1).padStart(5, '0')}`;
}
app.post('/api/admin/pos/sales/:id/return', requireAdmin, requireCap('pos.refund'), async (req, res) => {
  const b = req.body || {};
  const reqItems = Array.isArray(b.items) ? b.items : [];
  if (!reqItems.length) return res.status(400).json({ error: 'At least one line item required' });
  if (!['cash', 'card', 'cheque', 'bank', 'store_credit'].includes(b.refund_method))
    return res.status(400).json({ error: 'refund_method must be cash, card, cheque, bank, or store_credit' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: saleRows } = await client.query('SELECT * FROM pos_sales WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!saleRows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Sale not found' }); }
    const sale = saleRows[0];
    if (sale.voided) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Cannot return items from a voided sale' }); }

    const { rows: saleItems } = await client.query('SELECT * FROM pos_sale_items WHERE sale_id = $1', [req.params.id]);
    const itemById = {};
    saleItems.forEach((it) => { itemById[it.id] = it; });

    const { rows: alreadyReturned } = await client.query(
      `SELECT pri.sale_item_id, COALESCE(SUM(pri.qty), 0)::int AS qty
         FROM pos_sale_return_items pri JOIN pos_sale_items psi ON psi.id = pri.sale_item_id
        WHERE psi.sale_id = $1 GROUP BY pri.sale_item_id`,
      [req.params.id]
    );
    const returnedById = {};
    alreadyReturned.forEach((r) => { returnedById[r.sale_item_id] = r.qty; });

    let refundSubtotal = 0;
    const lineWork = [];
    for (const reqIt of reqItems) {
      const saleItemId = parseInt(reqIt.sale_item_id, 10);
      const qty = parseInt(reqIt.qty, 10);
      const item = itemById[saleItemId];
      if (!item) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'sale_item_id ' + saleItemId + ' is not on this sale' }); }
      if (!(qty > 0)) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'qty must be positive for "' + item.description + '"' }); }
      const remaining = item.qty - (returnedById[saleItemId] || 0);
      if (qty > remaining) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Only ' + remaining + ' unit(s) of "' + item.description + '" remain returnable' });
      }
      // Per-unit refund = unit price plus this line's share of any flat
      // core-charge/environmental fee (those are stored once per line, not
      // per unit, so spread them evenly across the line's original qty).
      const perUnit = Number(item.unit_price_usd) + (Number(item.core_charge_usd || 0) + Number(item.env_fee_usd || 0)) / item.qty;
      const refundLine = Math.round(perUnit * qty * 100) / 100;
      refundSubtotal += refundLine;
      lineWork.push({ item, qty, refundLine });
    }
    refundSubtotal = Math.round(refundSubtotal * 100) / 100;

    // Prorate the sale's order-level discount/tax by this return's share of
    // the original subtotal -- ties refundTotal exactly to that same share
    // of what the customer actually paid (refundTotal == proportion * total).
    const proportion = Number(sale.subtotal_usd) > 0 ? Math.min(1, refundSubtotal / Number(sale.subtotal_usd)) : 0;
    const refundDiscount = Math.round(Number(sale.discount_usd) * proportion * 100) / 100;
    const refundTax = Math.round(Number(sale.tax_usd) * proportion * 100) / 100;
    const refundTotal = Math.round((refundSubtotal - refundDiscount + refundTax) * 100) / 100;

    // ----- Store credit refunds issue a brand-new gift card ------------------
    let storeCreditCode = null;
    if (b.refund_method === 'store_credit') {
      storeCreditCode = genGiftCardCode();
      const { rows: gcRows } = await client.query(
        `INSERT INTO gift_cards (code, initial_balance_usd, balance_usd, issued_to_name, issued_to_phone, issued_by, notes)
           VALUES ($1,$2,$2,$3,$4,$5,$6) RETURNING id`,
        [storeCreditCode, refundTotal, sale.customer_name || null, sale.customer_phone || null, req.session.userId,
         'Store credit for return against sale ' + (sale.receipt_number || sale.id)]
      );
      await client.query(
        `INSERT INTO gift_card_transactions (gift_card_id, delta_usd, reason, reference, performed_by) VALUES ($1,$2,'issue',$3,$4)`,
        [gcRows[0].id, refundTotal, sale.receipt_number, req.session.userId]
      );
    }

    // ----- Loyalty rollback, proportional to the returned share --------------
    let pointsClawedBack = 0, pointsRecredited = 0;
    if (sale.customer_id) {
      pointsClawedBack = Math.floor(Number(sale.loyalty_points_earned || 0) * proportion);
      pointsRecredited = Math.round(Number(sale.loyalty_points_redeemed || 0) * proportion);
    }

    const returnNumber = await nextReturnNumber();
    const { rows: retRow } = await client.query(
      `INSERT INTO pos_sale_returns (sale_id, return_number, reason, refund_method, refund_subtotal_usd, refund_discount_usd, refund_tax_usd, refund_total_usd, store_credit_code, loyalty_points_clawed_back, loyalty_points_recredited, notes, processed_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [req.params.id, returnNumber, b.reason || null, b.refund_method, refundSubtotal, refundDiscount, refundTax,
       refundTotal, storeCreditCode, pointsClawedBack, pointsRecredited, b.notes || null, req.session.userId]
    );
    const returnId = retRow[0].id;

    for (const lw of lineWork) {
      await client.query(
        `INSERT INTO pos_sale_return_items (return_id, sale_item_id, qty, refund_usd) VALUES ($1,$2,$3,$4)`,
        [returnId, lw.item.id, lw.qty, lw.refundLine]
      );
      if (lw.item.product_img) {
        await client.query('UPDATE products SET stock_count = stock_count + $1 WHERE img = $2', [lw.qty, lw.item.product_img]);
      }
    }
    if (sale.customer_id && pointsClawedBack > 0) {
      await client.query(
        `INSERT INTO points_transactions (user_id, delta, reason, reference_id) VALUES ($1,$2,'return_clawback',$3)`,
        [sale.customer_id, -pointsClawedBack, returnId]
      );
    }
    if (sale.customer_id && pointsRecredited > 0) {
      await client.query(
        `INSERT INTO points_transactions (user_id, delta, reason, reference_id) VALUES ($1,$2,'return_recredit',$3)`,
        [sale.customer_id, pointsRecredited, returnId]
      );
    }

    await client.query('COMMIT');
    res.json({
      ok: true, id: returnId, return_number: returnNumber,
      refund_subtotal_usd: refundSubtotal, refund_discount_usd: refundDiscount,
      refund_tax_usd: refundTax, refund_total_usd: refundTotal,
      store_credit_code: storeCreditCode,
      loyalty_points_clawed_back: pointsClawedBack, loyalty_points_recredited: pointsRecredited,
    });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[pos return]', e);
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// Cash drawer sessions
app.get('/api/admin/cash-drawer/open', requireAdmin, async (_req, res) => {
  const { rows } = await query('SELECT cds.*, m.name AS opener_name FROM cash_drawer_sessions cds LEFT JOIN mechanics m ON m.id = cds.opened_by WHERE closed_at IS NULL ORDER BY opened_at DESC LIMIT 1');
  res.json({ session: rows[0] || null });
});

app.post('/api/admin/cash-drawer/open', requireAdmin, requireCap('pos.open_close_shift'), async (req, res) => {
  const b = req.body || {};
  const { rows: open } = await query('SELECT id FROM cash_drawer_sessions WHERE closed_at IS NULL');
  if (open.length) return res.status(400).json({ error: 'A cash drawer session is already open (#' + open[0].id + ')' });
  const { rows } = await query(`INSERT INTO cash_drawer_sessions (opened_by, opening_float, notes) VALUES ($1, $2, $3) RETURNING id, opened_at`,
    [b.opened_by || null, b.opening_float || 0, b.notes || null]);
  res.json({ ok: true, id: rows[0].id, opened_at: rows[0].opened_at });
});

app.post('/api/admin/cash-drawer/:id/close', requireAdmin, requireCap('pos.open_close_shift'), async (req, res) => {
  const b = req.body || {};
  const { rows: sess } = await query('SELECT * FROM cash_drawer_sessions WHERE id = $1', [req.params.id]);
  if (!sess.length || sess[0].closed_at) return res.status(400).json({ error: 'Session not open' });
  // Expected cash = opening_float + sum(cash sales since opened_at)
  const { rows: cs } = await query(
    `SELECT COALESCE(SUM(total_usd),0)::float AS s FROM pos_sales WHERE payment_method = 'cash' AND voided = false AND created_at >= $1`,
    [sess[0].opened_at]
  );
  const expected = Number(sess[0].opening_float) + cs[0].s;
  const closing = Number(b.closing_amount || 0);
  const variance = Math.round((closing - expected) * 100) / 100;
  await query(`UPDATE cash_drawer_sessions SET closed_by = $1, closing_amount = $2, expected_cash = $3, variance = $4, notes = $5, closed_at = NOW() WHERE id = $6`,
    [b.closed_by || null, closing, expected, variance, b.notes || sess[0].notes, req.params.id]);
  res.json({ ok: true, expected_cash: expected, closing_amount: closing, variance });
});

// =============================================================================
//  PICKSLIP — what to pull from the shelf for a work order, parts requisition,
//  or online order. Includes bin locations and SKUs so the parts clerk can
//  walk the aisles efficiently.
// =============================================================================
app.get('/api/pickslip', requireAdmin, async (req, res) => {
  const wo = req.query.wo;            // work order number
  const pr = req.query.pr;            // parts requisition id
  const order = req.query.order;      // online order id
  const pos = req.query.pos;          // pos sale id
  if (!wo && !pr && !order && !pos) return res.status(400).json({ error: 'wo, pr, order, or pos required' });
  const shop = shopSettingsToShop(await getShopSettings());
  if (pos) {
    const { rows: s } = await query('SELECT * FROM pos_sales WHERE id = $1', [pos]);
    if (!s.length) return res.status(404).json({ error: 'Sale not found' });
    const { rows: items } = await query(
      `SELECT psi.description, psi.qty, psi.product_img, psi.unit_price_usd::float AS unit_price_usd,
              p.name AS product_name, p.sku, p.bin_location, p.stock_count
         FROM pos_sale_items psi LEFT JOIN products p ON p.id = psi.product_id
         WHERE psi.sale_id = $1 ORDER BY p.bin_location NULLS LAST`,
      [pos]
    );
    return res.json({
      kind: 'pos_sale',
      header: { number: s[0].receipt_number, customer: s[0].customer_name || 'Walk-in', vehicle: s[0].vehicle_info, intake: s[0].created_at },
      items, shop,
    });
  }
  if (wo) {
    const { rows: w } = await query(
      `SELECT w.*, m.name AS mechanic_name FROM work_orders w
         LEFT JOIN mechanics m ON m.id = w.assigned_mechanic_id
         WHERE w.wo_number = $1`, [wo.toUpperCase()]
    );
    if (!w.length) return res.status(404).json({ error: 'Work order not found' });
    const { rows: items } = await query(
      `SELECT wp.*, p.name AS product_name, p.sku, p.bin_location, p.stock_count
         FROM work_order_parts wp
         LEFT JOIN products p ON p.id = wp.product_id
         WHERE wp.work_order_id = $1 ORDER BY p.bin_location NULLS LAST, wp.id`,
      [w[0].id]
    );
    return res.json({ kind: 'work_order', header: { number: w[0].wo_number, customer: w[0].customer_name, vehicle: [w[0].vehicle_year, w[0].vehicle_make, w[0].vehicle_model].filter(Boolean).join(' '), mechanic: w[0].mechanic_name, intake: w[0].intake_date }, items, shop });
  }
  if (pr) {
    const { rows: prr } = await query(
      `SELECT pr.*, w.wo_number, w.customer_name, rb.name AS requester_name FROM parts_requisitions pr
         LEFT JOIN work_orders w ON w.id = pr.work_order_id
         LEFT JOIN mechanics rb ON rb.id = pr.requested_by
         WHERE pr.id = $1`, [pr]
    );
    if (!prr.length) return res.status(404).json({ error: 'Requisition not found' });
    const { rows: items } = await query(
      `SELECT pi.description, pi.qty_requested AS qty, pi.product_img,
              p.name AS product_name, p.sku, p.bin_location, p.stock_count, pi.unit_price_usd AS unit_price_usd
         FROM parts_requisition_items pi
         LEFT JOIN products p ON p.id = pi.product_id
         WHERE pi.requisition_id = $1 ORDER BY p.bin_location NULLS LAST, pi.id`,
      [pr]
    );
    return res.json({ kind: 'parts_requisition', header: { number: prr[0].pr_number, customer: prr[0].customer_name, mechanic: prr[0].requester_name, wo: prr[0].wo_number, intake: prr[0].created_at }, items, shop });
  }
  if (order) {
    const { rows: o } = await query('SELECT * FROM orders WHERE id = $1', [order]);
    if (!o.length) return res.status(404).json({ error: 'Order not found' });
    const { rows: items } = await query(
      `SELECT oi.product_img, oi.qty, oi.price_usd AS unit_price_usd, oi.qty * oi.price_usd AS total_usd,
              p.name AS product_name, p.sku, p.bin_location, p.stock_count
         FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
         WHERE oi.order_id = $1 ORDER BY p.bin_location NULLS LAST`,
      [order]
    );
    return res.json({ kind: 'order', header: { number: '#' + o[0].id, customer: o[0].customer_user_id ? 'Registered customer' : 'Walk-in', intake: o[0].created_at }, items, shop });
  }
});

// =============================================================================
//  INVOICE — generate a printable, branded invoice for any work order
//  (Public if the customer has the WO number + matching phone — uses the same
//  match logic as /api/work-order-lookup)
// =============================================================================
app.get('/api/invoice/:wo_number', async (req, res) => {
  const woNumber = (req.params.wo_number || '').toUpperCase();
  const phone = ((req.query.phone || '').replace(/[^\d]/g, '')).slice(-7);
  const adminBypass = req.session && req.session.userId;
  let allowed = !!adminBypass;
  if (!allowed) {
    if (!phone) return res.status(401).json({ error: 'Phone required for customer access' });
  }
  const phoneClause = !allowed ? ` AND regexp_replace(customer_phone, '[^0-9]', '', 'g') LIKE '%' || $2` : '';
  const params = [woNumber];
  if (!allowed) params.push(phone);
  const { rows: ws } = await query(
    `SELECT w.*, m.name AS mechanic_name, sa.name AS advisor_name
       FROM work_orders w
       LEFT JOIN mechanics m ON m.id = w.assigned_mechanic_id
       LEFT JOIN mechanics sa ON sa.id = w.service_advisor_id
       WHERE wo_number = $1 ${phoneClause}`, params
  );
  if (!ws.length) return res.status(404).json({ error: 'Invoice not found' });
  const w = ws[0];
  const [labor, parts, payments] = await Promise.all([
    query('SELECT description, hours::float AS hours, rate_usd::float AS rate, total_usd::float AS total FROM work_order_labor WHERE work_order_id = $1 ORDER BY id', [w.id]),
    query('SELECT description, qty, unit_price_usd::float AS unit, total_usd::float AS total FROM work_order_parts WHERE work_order_id = $1 ORDER BY id', [w.id]),
    query('SELECT method, amount_usd::float AS amt, reference, received_at FROM work_order_payments WHERE work_order_id = $1 ORDER BY received_at', [w.id]),
  ]);
  const shopSettings = await getShopSettings();
  res.json({
    work_order: w, labor: labor.rows, parts: parts.rows, payments: payments.rows,
    tax_label: TAX_LABEL, tax_rate: TAX_RATE,
    shop: {
      name: shopSettings.company_name,
      // This endpoint's one client (invoice.html) prints address as a
      // single line with no separate country field, so country is folded
      // in here rather than changing that page's markup.
      address: shopSettings.address + (shopSettings.country ? ', ' + shopSettings.country : ''),
      phone: shopSettings.phone,
      website: shopSettings.website || (process.env.PUBLIC_BASE_URL || 'https://melthahonda.miamimistress.com'),
    },
  });
});

// =============================================================================
//  MAINTENANCE REMINDERS — flag vehicles overdue for service
//  Rules (mileage-based): oil change every 8,000 km, tire rotation every 12,000 km,
//  brake inspection every 20,000 km, transmission every 50,000 km.
//  Time-based: any vehicle not seen in 180 days gets a "we miss you" flag.
// =============================================================================
const MAINT_INTERVALS_KM = {
  'Oil Change': 8000,
  'Tire Rotation': 12000,
  'Brake Inspection': 20000,
  'Transmission Service': 50000,
};

app.get('/api/admin/maintenance-due', requireAdmin, async (_req, res) => {
  // For each unique vehicle (matched by VIN or plate), find the most recent
  // work order and the last mileage reading + last visit date.
  const { rows: vehicles } = await query(`
    WITH latest AS (
      SELECT DISTINCT ON (COALESCE(NULLIF(vehicle_vin,''), NULLIF(license_plate,''), customer_phone))
        COALESCE(NULLIF(vehicle_vin,''), NULLIF(license_plate,''), customer_phone) AS key,
        customer_name, customer_phone, vehicle_year, vehicle_make, vehicle_model,
        vehicle_vin, license_plate, mileage_in, intake_date, work_performed
      FROM work_orders
      WHERE customer_phone IS NOT NULL
      ORDER BY key, intake_date DESC
    )
    SELECT * FROM latest
    WHERE intake_date < NOW() - INTERVAL '90 days' OR mileage_in IS NOT NULL
    ORDER BY intake_date ASC
    LIMIT 200
  `);
  const today = new Date();
  const dueList = vehicles.map(v => {
    const daysSince = Math.floor((today - new Date(v.intake_date)) / 86400000);
    // Estimate current mileage (rough: 1500 km/month avg in Kingston traffic)
    const estCurrentKm = v.mileage_in ? (Number(v.mileage_in) + Math.round((daysSince / 30) * 1500)) : null;
    const flags = [];
    if (daysSince >= 180) flags.push({ type: 'overdue_visit', label: `Haven't seen this customer in ${daysSince} days` });
    if (estCurrentKm) {
      Object.entries(MAINT_INTERVALS_KM).forEach(([svc, interval]) => {
        // If estimated current km is >= 1 full interval since last visit, flag
        const sinceLast = estCurrentKm - Number(v.mileage_in);
        if (sinceLast >= interval) flags.push({ type: 'mileage_due', label: `${svc} likely due (~${Math.round(sinceLast/1000)}k km since last visit)` });
      });
    }
    return { ...v, days_since: daysSince, est_current_km: estCurrentKm, flags };
  }).filter(v => v.flags.length > 0);
  res.json({ vehicles: dueList, count: dueList.length });
});

// =============================================================================
//  VEHICLE HISTORY — every WO + appointment + inspection for a VIN or plate
// =============================================================================
app.get('/api/admin/vehicle-history', requireAdmin, async (req, res) => {
  const vin = (req.query.vin || '').trim().toUpperCase();
  const plate = (req.query.plate || '').trim().toUpperCase();
  if (!vin && !plate) return res.status(400).json({ error: 'vin or plate required' });
  const conds = []; const params = [];
  if (vin) { params.push(vin); conds.push('UPPER(vehicle_vin) = $' + params.length); }
  if (plate) { params.push(plate); conds.push('UPPER(license_plate) = $' + params.length); }
  const where = conds.join(' OR ');
  const [wos, appts, insps] = await Promise.all([
    query(
      `SELECT id, wo_number, customer_name, customer_phone, vehicle_year, vehicle_make, vehicle_model,
              vehicle_vin, license_plate, status, complaint, work_performed,
              total_usd::float AS total_usd, intake_date, completed_at, paid_at, mileage_in
         FROM work_orders WHERE ${where} ORDER BY intake_date DESC LIMIT 100`,
      params
    ),
    // Service appointments don't store VIN; match by name + vehicle make/model if a WO exists
    vin || plate
      ? query(
          `SELECT DISTINCT sa.id, sa.name, sa.phone, sa.vehicle_year, sa.vehicle_make, sa.vehicle_model,
                  sa.service_type, sa.preferred_date, sa.time_slot, sa.status, sa.created_at
             FROM service_appointments sa
            WHERE EXISTS (
              SELECT 1 FROM work_orders w
              WHERE (${where.replace(/vehicle_vin/g, 'w.vehicle_vin').replace(/license_plate/g, 'w.license_plate')})
                AND w.customer_phone = sa.phone
            )
            ORDER BY sa.preferred_date DESC NULLS LAST, sa.created_at DESC LIMIT 50`,
          params
        )
      : { rows: [] },
    query(
      `SELECT id, kind, vehicle_year, vehicle_make, vehicle_model, vin, mileage,
              status, inspector_name, overall_notes, created_at, completed_at
         FROM inspections WHERE UPPER(vin) = ANY($1::text[]) ORDER BY created_at DESC LIMIT 50`,
      [[vin, plate].filter(Boolean)]
    ),
  ]);
  // Build a summary header from the most recent WO
  const summary = wos.rows[0] || null;
  res.json({
    vehicle: summary ? {
      year: summary.vehicle_year, make: summary.vehicle_make, model: summary.vehicle_model,
      vin: summary.vehicle_vin, plate: summary.license_plate,
      last_seen: summary.intake_date, last_mileage: summary.mileage_in,
      last_customer: summary.customer_name,
    } : null,
    work_orders: wos.rows,
    appointments: appts.rows || [],
    inspections: insps.rows,
    stats: {
      total_wos: wos.rows.length,
      lifetime_spend: wos.rows.reduce((s, w) => s + (Number(w.total_usd) || 0), 0),
    },
  });
});

// =============================================================================
//  OWNER DASHBOARD — extended KPIs with 14-day sparklines
// =============================================================================
// Parts-counter first: the headline numbers are combined sales (counter POS +
// storefront orders), then the things that need someone to act, then trend /
// tender mix / top sellers / recent activity. The service-centre block (work
// orders + mechanic utilisation) is still returned but the client only shows
// it when there is service activity, since those menus are hidden by default.
app.get('/api/admin/dashboard', requireAdmin, async (_req, res) => {
  const salesUnion = `
    SELECT created_at, total_usd::float AS total FROM pos_sales WHERE voided = false
    UNION ALL
    SELECT created_at, total_usd::float AS total FROM orders WHERE status <> 'cancelled'`;

  const [
    sales, spark, tender, topSellers, ar, attention, recent,
    revToday, revWeek, revMonth, wosOpen, mechUtil, svcDaily, woByStatus, openInspections,
  ] = await Promise.all([
    query(`SELECT
        COALESCE(SUM(total) FILTER (WHERE created_at::date = CURRENT_DATE),0)::float           AS today,
        COUNT(*) FILTER (WHERE created_at::date = CURRENT_DATE)::int                            AS today_n,
        COALESCE(SUM(total) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days'),0)::float    AS week,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::int                    AS week_n,
        COALESCE(SUM(total) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days'),0)::float   AS month,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::int                   AS month_n
      FROM (${salesUnion}) s`),
    query(`SELECT created_at::date AS day, COALESCE(SUM(total),0)::float AS total
        FROM (${salesUnion}) s
       WHERE created_at >= CURRENT_DATE - INTERVAL '13 days'
       GROUP BY day ORDER BY day`),
    query(`SELECT sp.method, COUNT(*)::int AS n, COALESCE(SUM(sp.amount_usd),0)::float AS total
        FROM sale_payments sp JOIN pos_sales s ON s.id = sp.sale_id
       WHERE s.voided = false AND s.created_at >= NOW() - INTERVAL '7 days'
       GROUP BY sp.method ORDER BY total DESC`),
    query(`SELECT COALESCE(p.name, psi.description) AS name, p.sku,
              SUM(psi.qty)::int AS qty, SUM(psi.total_usd)::float AS revenue
        FROM pos_sale_items psi
        JOIN pos_sales s ON s.id = psi.sale_id
        LEFT JOIN products p ON p.id = psi.product_id
       WHERE s.voided = false AND s.created_at >= NOW() - INTERVAL '7 days'
       GROUP BY COALESCE(p.name, psi.description), p.sku
       ORDER BY revenue DESC NULLS LAST LIMIT 8`),
    query(`SELECT COUNT(*)::int AS customers_owing, COALESCE(SUM(bal),0)::float AS total_owed FROM (
        SELECT u.id,
          COALESCE((SELECT SUM(sp.amount_usd) FROM sale_payments sp JOIN pos_sales s ON s.id = sp.sale_id
                     WHERE sp.method = 'account' AND s.customer_id = u.id AND s.voided = false),0)
          - COALESCE((SELECT SUM(amount_usd) FROM account_payments ap WHERE ap.customer_id = u.id),0) AS bal
        FROM users u) t WHERE bal > 0.01`),
    query(`SELECT
        (SELECT COUNT(*)::int FROM orders WHERE status IN ('pending','confirmed'))                         AS orders_pending,
        (SELECT COUNT(*)::int FROM products WHERE is_active AND stock_count > 0 AND stock_count <= low_threshold) AS low_stock,
        (SELECT COUNT(*)::int FROM products WHERE is_active AND stock_count <= 0)                           AS out_of_stock,
        (SELECT COUNT(*)::int FROM parts_requisitions WHERE status IN ('pending','partial','backordered'))  AS parts_pulls_open,
        (SELECT COUNT(*)::int FROM pos_quotes WHERE status = 'open')                                        AS quotes_open,
        (SELECT COUNT(*)::int FROM pos_holds)                                                               AS holds`),
    query(`SELECT * FROM (
        SELECT 'counter'::text AS source, s.id, s.receipt_number AS ref, s.created_at,
               COALESCE(NULLIF(s.customer_name,''),'Walk-in') AS customer, s.total_usd::float AS total, s.voided
          FROM pos_sales s
        UNION ALL
        SELECT 'online'::text, o.id, ('#'||o.id), o.created_at,
               COALESCE(u.name,'Guest'), o.total_usd::float, (o.status = 'cancelled')
          FROM orders o LEFT JOIN users u ON u.id = o.user_id
      ) x ORDER BY created_at DESC LIMIT 8`),
    // ---- service-centre block (unchanged queries) ----
    query(`SELECT COALESCE(SUM(amount_usd),0)::float AS s FROM work_order_payments WHERE received_at::date = CURRENT_DATE`),
    query(`SELECT COALESCE(SUM(amount_usd),0)::float AS s FROM work_order_payments WHERE received_at >= NOW() - INTERVAL '7 days'`),
    query(`SELECT COALESCE(SUM(amount_usd),0)::float AS s FROM work_order_payments WHERE received_at >= NOW() - INTERVAL '30 days'`),
    query(`SELECT status, COUNT(*)::int AS n FROM work_orders WHERE status NOT IN ('paid','cancelled') GROUP BY status`),
    query(`SELECT m.name, COUNT(l.id)::int AS jobs, COALESCE(SUM(l.hours),0)::float AS hours, COALESCE(SUM(l.total_usd),0)::float AS revenue
             FROM mechanics m LEFT JOIN work_order_labor l ON l.mechanic_id = m.id AND l.created_at >= NOW() - INTERVAL '7 days'
             WHERE m.is_active = true AND m.role IN ('mechanic','both')
             GROUP BY m.name ORDER BY revenue DESC NULLS LAST LIMIT 8`),
    query(`SELECT received_at::date AS day, COALESCE(SUM(amount_usd),0)::float AS s
             FROM work_order_payments WHERE received_at >= CURRENT_DATE - INTERVAL '13 days'
             GROUP BY day ORDER BY day ASC`),
    query(`SELECT status, COUNT(*)::int AS n FROM work_orders GROUP BY status`),
    query(`SELECT COUNT(*)::int AS n FROM inspections WHERE status = 'in_progress'`),
  ]);

  const fill = (rows, key) => {
    const map = {};
    rows.forEach(r => { map[r.day.toISOString().slice(0, 10)] = Number(r[key]); });
    const out = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      out.push({ day: d, total: map[d] || 0 });
    }
    return out;
  };

  const s = sales.rows[0];
  const svcActive = woByStatus.rows.some(r => !['paid', 'cancelled'].includes(r.status) && r.n > 0)
    || Number(revMonth.rows[0].s) > 0;

  res.json({
    // NEW — parts-counter first
    sales: {
      today: s.today, today_n: s.today_n, week: s.week, week_n: s.week_n,
      month: s.month, month_n: s.month_n,
      avg_today: s.today_n ? s.today / s.today_n : 0,
    },
    sales_sparkline: fill(spark.rows, 'total'),
    tender_mix: tender.rows,
    top_sellers: topSellers.rows,
    ar: ar.rows[0],
    attention: attention.rows[0],
    recent: recent.rows,
    has_service: svcActive,
    // OLD keys kept for back-compat
    revenue: { today: revToday.rows[0].s, week: revWeek.rows[0].s, month: revMonth.rows[0].s, sparkline: fill(svcDaily.rows, 's') },
    work_orders_open: wosOpen.rows,
    mechanic_utilization: mechUtil.rows,
    work_orders_by_status: woByStatus.rows,
    low_stock_count: attention.rows[0].low_stock,
    open_inspections: openInspections.rows[0].n,
  });
});

// =============================================================================
//  WORK ORDER PAYMENTS — capture partial/split payments + daily reconciliation
// =============================================================================
app.get('/api/admin/work-orders/:id/payments', requireAdmin, async (req, res) => {
  const { rows } = await query(
    `SELECT p.*, m.name AS receiver_name FROM work_order_payments p
       LEFT JOIN mechanics m ON m.id = p.received_by
       WHERE p.work_order_id = $1 ORDER BY p.received_at DESC`,
    [req.params.id]
  );
  res.json({ payments: rows });
});

app.post('/api/admin/work-orders/:id/payments', requireAdmin, async (req, res) => {
  const b = req.body || {};
  if (!b.method || !b.amount_usd) return res.status(400).json({ error: 'method and amount_usd required' });
  if (!['cash','card','bank_transfer','cheque','mobile'].includes(b.method)) return res.status(400).json({ error: 'Invalid payment method' });
  const amt = Number(b.amount_usd);
  if (!(amt > 0)) return res.status(400).json({ error: 'amount must be positive' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO work_order_payments (work_order_id, method, amount_usd, reference, received_by, notes) VALUES ($1,$2,$3,$4,$5,$6)`,
      [req.params.id, b.method, amt, b.reference || null, b.received_by || null, b.notes || null]
    );
    // If total paid >= total_usd, auto-mark the WO paid
    const { rows: w } = await client.query('SELECT total_usd::float AS total FROM work_orders WHERE id = $1', [req.params.id]);
    const { rows: p } = await client.query('SELECT COALESCE(SUM(amount_usd),0)::float AS paid FROM work_order_payments WHERE work_order_id = $1', [req.params.id]);
    if (w[0] && p[0] && p[0].paid >= w[0].total && w[0].total > 0) {
      await client.query(`UPDATE work_orders SET status = 'paid', paid_at = COALESCE(paid_at, NOW()) WHERE id = $1`, [req.params.id]);
    }
    await client.query('COMMIT');
    res.json({ ok: true, total_paid: p[0].paid, fully_paid: p[0].paid >= w[0].total });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[wo payment]', e); res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

app.delete('/api/admin/work-orders/:woId/payments/:id', requireAdmin, async (req, res) => {
  await query('DELETE FROM work_order_payments WHERE id = $1 AND work_order_id = $2', [req.params.id, req.params.woId]);
  // Revert paid status if needed
  const { rows: w } = await query('SELECT total_usd::float AS total FROM work_orders WHERE id = $1', [req.params.woId]);
  const { rows: p } = await query('SELECT COALESCE(SUM(amount_usd),0)::float AS paid FROM work_order_payments WHERE work_order_id = $1', [req.params.woId]);
  if (w[0] && p[0] && p[0].paid < w[0].total) {
    await query(`UPDATE work_orders SET status = 'completed', paid_at = NULL WHERE id = $1 AND status = 'paid'`, [req.params.woId]);
  }
  res.json({ ok: true });
});

// Daily / period cash report — payments grouped by method
app.get('/api/admin/cash-report', requireAdmin, async (req, res) => {
  const from = req.query.from || new Date().toISOString().slice(0,10);
  const to = req.query.to || from;
  const [byMethod, byMechanic, perDay, totals, recent] = await Promise.all([
    query(`SELECT method, COUNT(*)::int AS n, COALESCE(SUM(amount_usd),0)::float AS s
             FROM work_order_payments
             WHERE received_at::date BETWEEN $1::date AND $2::date
             GROUP BY method ORDER BY s DESC`, [from, to]),
    query(`SELECT m.name AS mechanic_name, COUNT(*)::int AS n, COALESCE(SUM(p.amount_usd),0)::float AS s
             FROM work_order_payments p LEFT JOIN mechanics m ON m.id = p.received_by
             WHERE p.received_at::date BETWEEN $1::date AND $2::date
             GROUP BY m.name ORDER BY s DESC`, [from, to]),
    query(`SELECT received_at::date AS day, COALESCE(SUM(amount_usd),0)::float AS s, COUNT(*)::int AS n
             FROM work_order_payments WHERE received_at::date BETWEEN $1::date AND $2::date
             GROUP BY day ORDER BY day DESC`, [from, to]),
    query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(amount_usd),0)::float AS s
             FROM work_order_payments WHERE received_at::date BETWEEN $1::date AND $2::date`, [from, to]),
    query(`SELECT p.*, w.wo_number, w.customer_name, m.name AS receiver_name
             FROM work_order_payments p
             LEFT JOIN work_orders w ON w.id = p.work_order_id
             LEFT JOIN mechanics m ON m.id = p.received_by
             WHERE p.received_at::date BETWEEN $1::date AND $2::date
             ORDER BY p.received_at DESC LIMIT 100`, [from, to]),
  ]);
  res.json({
    from, to,
    by_method: byMethod.rows, by_mechanic: byMechanic.rows, per_day: perDay.rows,
    totals: totals.rows[0], recent: recent.rows,
  });
});

// Customer's own work orders — looked up by their account email + phone match,
// or by the user_id link if we stored one at intake.
app.get('/api/my-work-orders', requireAuth, async (req, res) => {
  // Match either explicit customer_user_id link, or phone match against the
  // signed-in user's stored phone number.
  const { rows: u } = await query('SELECT phone, email FROM users WHERE id = $1', [req.session.userId]);
  if (!u.length) return res.status(404).json({ error: 'User not found' });
  const phone = (u[0].phone || '').replace(/[^\d]/g, '').slice(-7);
  const params = [req.session.userId];
  let phoneClause = '';
  if (phone) { params.push('%' + phone); phoneClause = ` OR regexp_replace(customer_phone, '[^0-9]', '', 'g') LIKE $${params.length}`; }
  const { rows } = await query(
    `SELECT id, wo_number, customer_name, vehicle_year, vehicle_make, vehicle_model,
            status, priority, intake_date, promised_date, completed_at, paid_at,
            total_usd::float AS total_usd, complaint, work_performed
       FROM work_orders WHERE (customer_user_id = $1${phoneClause}) ORDER BY intake_date DESC LIMIT 100`,
    params
  );
  res.json({ work_orders: rows });
});

// Low-stock alert — products at or below their low_threshold
app.get('/api/admin/low-stock', requireAdmin, async (_req, res) => {
  const { rows } = await query(
    `SELECT img, name, make_model, category, condition,
            price_usd::float AS price_usd, stock_count, low_threshold
       FROM products
       WHERE is_active = true AND stock_count <= low_threshold
       ORDER BY stock_count ASC, name ASC LIMIT 100`
  );
  res.json({ products: rows, count: rows.length });
});

// =============================================================================
//  PARTS REQUISITIONS — mechanic requests parts → clerk fulfils → inventory deducts
// =============================================================================
async function nextPartsReqNumber() {
  const year = new Date().getFullYear();
  const { rows } = await query(`SELECT COUNT(*)::int AS n FROM parts_requisitions WHERE pr_number LIKE $1`, [`PR-${year}-%`]);
  return `PR-${year}-${String(rows[0].n + 1).padStart(4, '0')}`;
}

app.get('/api/admin/parts-requisitions', requireAdmin, async (req, res) => {
  const status = req.query.status || null;
  const base = `SELECT pr.*, w.wo_number, w.customer_name, w.vehicle_make, w.vehicle_model,
                       rb.name AS requester_name, fb.name AS fulfiller_name,
                       (SELECT COUNT(*)::int FROM parts_requisition_items pi WHERE pi.requisition_id = pr.id) AS item_count
                  FROM parts_requisitions pr
                  LEFT JOIN work_orders w ON w.id = pr.work_order_id
                  LEFT JOIN mechanics rb ON rb.id = pr.requested_by
                  LEFT JOIN mechanics fb ON fb.id = pr.fulfilled_by`;
  const sql = status
    ? `${base} WHERE pr.status = $1 ORDER BY pr.created_at DESC LIMIT 200`
    : `${base} ORDER BY pr.created_at DESC LIMIT 200`;
  const { rows } = status ? await query(sql, [status]) : await query(sql);
  res.json({ requisitions: rows });
});

app.get('/api/admin/parts-requisitions/:id', requireAdmin, async (req, res) => {
  const { rows: pr } = await query(`SELECT pr.*, w.wo_number, w.customer_name FROM parts_requisitions pr LEFT JOIN work_orders w ON w.id = pr.work_order_id WHERE pr.id = $1`, [req.params.id]);
  if (!pr.length) return res.status(404).json({ error: 'Requisition not found' });
  const { rows: items } = await query(`SELECT pi.*, p.name AS product_name, p.stock_count AS in_stock FROM parts_requisition_items pi LEFT JOIN products p ON p.id = pi.product_id WHERE pi.requisition_id = $1 ORDER BY pi.id`, [req.params.id]);
  res.json({ requisition: pr[0], items });
});

app.post('/api/admin/parts-requisitions', requireAdmin, async (req, res) => {
  const b = req.body || {};
  // work_order_id is optional now: a pull can feed a job, or it can be a
  // standalone counter / internal / stock-transfer pull (work_order_id NULL).
  const workOrderId = b.work_order_id ? parseInt(b.work_order_id, 10) : null;
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) return res.status(400).json({ error: 'At least one item required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (workOrderId) {
      const { rows: wo } = await client.query('SELECT id FROM work_orders WHERE id = $1', [workOrderId]);
      if (!wo.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'No work order #' + workOrderId }); }
    }
    const prNum = await nextPartsReqNumber();
    const { rows: pr } = await client.query(
      `INSERT INTO parts_requisitions (pr_number, work_order_id, requested_by, notes) VALUES ($1,$2,$3,$4) RETURNING id`,
      [prNum, workOrderId, b.requested_by || null, b.notes || null]
    );
    for (const it of items) {
      if (!it.description || !it.qty_requested) continue;
      // Prefer an explicit product_id from the catalogue search; fall back to
      // resolving it from the image path the way the old form did.
      const pid = Number.isInteger(it.product_id) ? it.product_id : null;
      await client.query(
        `INSERT INTO parts_requisition_items (requisition_id, product_img, product_id, description, qty_requested, unit_price_usd)
           VALUES ($1,$2,COALESCE($3,(SELECT id FROM products WHERE img = $2)),$4,$5,$6)`,
        [pr[0].id, it.product_img || null, pid, it.description, parseInt(it.qty_requested, 10),
         it.unit_price_usd != null && it.unit_price_usd !== '' ? Number(it.unit_price_usd) : null]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true, id: pr[0].id, pr_number: prNum });
  } catch (e) { await client.query('ROLLBACK'); console.error('[parts-req create]', e); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

app.post('/api/admin/parts-requisitions/:id/fulfill', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: pr } = await client.query('SELECT * FROM parts_requisitions WHERE id = $1', [req.params.id]);
    if (!pr.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Requisition not found' }); }
    if (pr[0].status === 'fulfilled') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Already fulfilled' }); }
    const { rows: items } = await client.query('SELECT * FROM parts_requisition_items WHERE requisition_id = $1', [req.params.id]);
    let anyBack = false;
    for (const it of items) {
      if (it.status === 'fulfilled' || it.status === 'cancelled') continue;
      const want = it.qty_requested - it.qty_fulfilled;
      let avail = Infinity;
      if (it.product_img) {
        const { rows: p } = await client.query('SELECT stock_count FROM products WHERE img = $1', [it.product_img]);
        if (p.length) avail = p[0].stock_count;
      }
      const got = Math.max(0, Math.min(want, avail));
      if (got < want) anyBack = true;
      if (got > 0) {
        if (it.product_img) await client.query('UPDATE products SET stock_count = GREATEST(0, stock_count - $1) WHERE img = $2', [got, it.product_img]);
        const unit = Number(it.unit_price_usd || 0);
        const total = Math.round(got * unit * 100) / 100;
        // Only a work-order pull posts the parts onto a job. A standalone
        // counter / internal pull just moves the stock off the shelf.
        if (pr[0].work_order_id) {
          await client.query(`INSERT INTO work_order_parts (work_order_id, product_img, product_id, description, qty, unit_price_usd, total_usd) VALUES ($1,$2,(SELECT id FROM products WHERE img = $2),$3,$4,$5,$6)`,
            [pr[0].work_order_id, it.product_img || null, it.description, got, unit, total]);
        }
        await client.query(`UPDATE parts_requisition_items SET qty_fulfilled = qty_fulfilled + $1, status = CASE WHEN qty_fulfilled + $1 >= qty_requested THEN 'fulfilled' ELSE 'backordered' END WHERE id = $2`, [got, it.id]);
      } else {
        await client.query(`UPDATE parts_requisition_items SET status = 'backordered' WHERE id = $1`, [it.id]);
      }
    }
    if (pr[0].work_order_id) {
      const lr = await client.query('SELECT COALESCE(SUM(total_usd),0)::float AS s FROM work_order_labor WHERE work_order_id = $1', [pr[0].work_order_id]);
      const ppr = await client.query('SELECT COALESCE(SUM(total_usd),0)::float AS s FROM work_order_parts WHERE work_order_id = $1', [pr[0].work_order_id]);
      await client.query('UPDATE work_orders SET labor_total_usd = $1, parts_total_usd = $2, total_usd = $3 WHERE id = $4',
        [lr.rows[0].s, ppr.rows[0].s, lr.rows[0].s + ppr.rows[0].s, pr[0].work_order_id]);
    }
    await client.query(`UPDATE parts_requisitions SET status = $1, fulfilled_by = $2, fulfilled_at = NOW() WHERE id = $3`,
      [anyBack ? 'partial' : 'fulfilled', req.session.userId, req.params.id]);
    await client.query('COMMIT');
    res.json({ ok: true, status: anyBack ? 'partial' : 'fulfilled' });
  } catch (e) { await client.query('ROLLBACK'); console.error('[parts-req fulfill]', e); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

app.get('/api/admin/time-entries', requireAdmin, async (req, res) => {
  const where = []; const vals = [];
  if (req.query.mechanic_id) { vals.push(req.query.mechanic_id); where.push(`te.mechanic_id = $${vals.length}`); }
  if (req.query.work_order_id) { vals.push(req.query.work_order_id); where.push(`te.work_order_id = $${vals.length}`); }
  if (req.query.open === 'true') where.push('te.clocked_out_at IS NULL');
  const sql = `SELECT te.*, m.name AS mechanic_name, w.wo_number FROM time_entries te LEFT JOIN mechanics m ON m.id = te.mechanic_id LEFT JOIN work_orders w ON w.id = te.work_order_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY te.clocked_in_at DESC LIMIT 200`;
  const { rows } = vals.length ? await query(sql, vals) : await query(sql);
  res.json({ entries: rows });
});

app.post('/api/admin/time-entries/clock-in', requireAdmin, async (req, res) => {
  const b = req.body || {};
  if (!b.mechanic_id) return res.status(400).json({ error: 'mechanic_id required' });
  const { rows: open } = await query('SELECT id FROM time_entries WHERE mechanic_id = $1 AND clocked_out_at IS NULL', [b.mechanic_id]);
  if (open.length) return res.status(400).json({ error: 'Mechanic already clocked in (entry #' + open[0].id + ')' });
  const { rows } = await query(`INSERT INTO time_entries (mechanic_id, work_order_id, description) VALUES ($1,$2,$3) RETURNING id, clocked_in_at`,
    [b.mechanic_id, b.work_order_id || null, b.description || null]);
  res.json({ ok: true, id: rows[0].id, clocked_in_at: rows[0].clocked_in_at });
});

app.post('/api/admin/time-entries/:id/clock-out', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: te } = await client.query('SELECT * FROM time_entries WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!te.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Entry not found' }); }
    if (te[0].clocked_out_at) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Already clocked out' }); }
    const out = new Date(); const inAt = new Date(te[0].clocked_in_at);
    const hours = Math.max(0.01, Math.round((out - inAt) / 36000) / 100);
    let laborId = null;
    if (te[0].work_order_id) {
      const { rows: m } = await client.query('SELECT name, hourly_rate_usd::float AS rate FROM mechanics WHERE id = $1', [te[0].mechanic_id]);
      const rate = (m[0] && m[0].rate) || 25;
      const total = Math.round(hours * rate * 100) / 100;
      const { rows: lab } = await client.query(`INSERT INTO work_order_labor (work_order_id, mechanic_id, description, hours, rate_usd, total_usd, performed_date) VALUES ($1,$2,$3,$4,$5,$6,CURRENT_DATE) RETURNING id`,
        [te[0].work_order_id, te[0].mechanic_id, te[0].description || ((m[0] && m[0].name) || 'Mechanic') + ' time-clock', hours, rate, total]);
      laborId = lab[0].id;
      const lr = await client.query('SELECT COALESCE(SUM(total_usd),0)::float AS s FROM work_order_labor WHERE work_order_id = $1', [te[0].work_order_id]);
      const pr = await client.query('SELECT COALESCE(SUM(total_usd),0)::float AS s FROM work_order_parts WHERE work_order_id = $1', [te[0].work_order_id]);
      await client.query('UPDATE work_orders SET labor_total_usd = $1, parts_total_usd = $2, total_usd = $3 WHERE id = $4',
        [lr.rows[0].s, pr.rows[0].s, lr.rows[0].s + pr.rows[0].s, te[0].work_order_id]);
    }
    await client.query(`UPDATE time_entries SET clocked_out_at = NOW(), hours = $1, labor_entry_id = $2 WHERE id = $3`, [hours, laborId, req.params.id]);
    await client.query('COMMIT');
    res.json({ ok: true, hours: hours, labor_entry_id: laborId });
  } catch (e) { await client.query('ROLLBACK'); console.error('[clock-out]', e); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

app.post('/api/work-order-lookup', async (req, res) => {
  const wo_number = ((req.body && req.body.wo_number) || '').trim().toUpperCase();
  const phone = ((req.body && req.body.phone) || '').replace(/[^\d]/g, '').slice(-7);
  if (!wo_number || !phone) return res.status(400).json({ error: 'WO number and phone required' });
  const { rows } = await query(`SELECT id, wo_number, customer_name, vehicle_year, vehicle_make, vehicle_model, status, priority, intake_date, promised_date, completed_at, paid_at, labor_total_usd::float AS labor_total_usd, parts_total_usd::float AS parts_total_usd, tax_usd::float AS tax_usd, total_usd::float AS total_usd, complaint, work_performed FROM work_orders WHERE wo_number = $1 AND regexp_replace(customer_phone, '[^0-9]', '', 'g') LIKE $2`, [wo_number, '%' + phone]);
  if (!rows.length) return res.status(404).json({ error: 'No work order found.' });
  res.json({ work_order: rows[0] });
});

app.get('/api/admin/inspections', requireAdmin, async (req, res) => {
  const kind = req.query.kind || null;
  const sql = kind
    ? `SELECT i.id, i.kind, i.status, i.vehicle_year, i.vehicle_make, i.vehicle_model,
              i.vin, i.mileage, i.customer_name, i.inspector_name, i.created_at, i.completed_at,
              (SELECT COUNT(*) FROM inspection_items WHERE inspection_id = i.id)::int AS items_count,
              (SELECT COUNT(*) FROM inspection_photos WHERE inspection_id = i.id)::int AS photos_count
         FROM inspections i WHERE i.kind = $1 ORDER BY i.created_at DESC LIMIT 200`
    : `SELECT i.id, i.kind, i.status, i.vehicle_year, i.vehicle_make, i.vehicle_model,
              i.vin, i.mileage, i.customer_name, i.inspector_name, i.created_at, i.completed_at,
              (SELECT COUNT(*) FROM inspection_items WHERE inspection_id = i.id)::int AS items_count,
              (SELECT COUNT(*) FROM inspection_photos WHERE inspection_id = i.id)::int AS photos_count
         FROM inspections i ORDER BY i.created_at DESC LIMIT 200`;
  const { rows } = kind ? await query(sql, [kind]) : await query(sql);
  res.json({ inspections: rows });
});

app.get('/api/admin/inspections/:id', requireAdmin, async (req, res) => {
  const { rows: insp } = await query(`SELECT * FROM inspections WHERE id = $1`, [req.params.id]);
  if (!insp.length) return res.status(404).json({ error: 'Inspection not found' });
  const [items, photos] = await Promise.all([
    query(`SELECT id, category, item, status, severity, notes FROM inspection_items WHERE inspection_id = $1 ORDER BY id`, [req.params.id]),
    query(`SELECT id, photo_path, caption, annotations, area, created_at FROM inspection_photos WHERE inspection_id = $1 ORDER BY id`, [req.params.id]),
  ]);
  res.json({ inspection: insp[0], items: items.rows, photos: photos.rows });
});

app.post('/api/admin/inspections', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: u } = await client.query('SELECT name FROM users WHERE id = $1', [req.session.userId]);
    const inspectorName = (u[0] && u[0].name) || b.inspector_name || null;
    const { rows: insp } = await client.query(
      `INSERT INTO inspections
         (inspector_id, inspector_name, kind, vehicle_year, vehicle_make, vehicle_model,
          vin, mileage, license_plate, customer_name, customer_phone, service_appointment_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [req.session.userId, inspectorName,
       b.kind === 'service' ? 'service' : 'inspection',
       b.vehicle_year || null, b.vehicle_make || null, b.vehicle_model || null,
       (b.vin || '').toUpperCase() || null,
       b.mileage ? parseInt(b.mileage,10) : null,
       b.license_plate || null, b.customer_name || null, b.customer_phone || null,
       b.service_appointment_id || null]
    );
    const inspectionId = insp[0].id;
    const items = Array.isArray(b.items) ? b.items : [];
    for (const it of items) {
      if (!it.category || !it.item) continue;
      await client.query(`INSERT INTO inspection_items (inspection_id, category, item) VALUES ($1, $2, $3)`, [inspectionId, it.category, it.item]);
    }
    await client.query('COMMIT');
    res.json({ ok: true, id: inspectionId });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[inspection create]', e);
    res.status(500).json({ error: e.message || 'Could not create inspection' });
  } finally { client.release(); }
});

app.patch('/api/admin/inspections/:id', requireAdmin, async (req, res) => {
  const fields = ['status','overall_notes','vehicle_year','vehicle_make','vehicle_model','vin','mileage','license_plate','customer_name','customer_phone','completed_at'];
  const sets = []; const vals = [];
  for (const f of fields) if (req.body && req.body[f] !== undefined) {
    sets.push(`${f} = $${sets.length + 1}`); vals.push(req.body[f]);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(req.params.id);
  await query(`UPDATE inspections SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
  res.json({ ok: true });
});

app.delete('/api/admin/inspections/:id', requireAdmin, async (req, res) => {
  await query('DELETE FROM inspections WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

app.patch('/api/admin/inspection-items/:id', requireAdmin, async (req, res) => {
  const fields = ['status','severity','notes'];
  const sets = []; const vals = [];
  for (const f of fields) if (req.body && req.body[f] !== undefined) { sets.push(`${f} = $${sets.length + 1}`); vals.push(req.body[f]); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  sets.push(`updated_at = NOW()`); vals.push(req.params.id);
  await query(`UPDATE inspection_items SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
  res.json({ ok: true });
});

app.post('/api/admin/inspections/:id/photos', requireAdmin, upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Photo file required' });
  const b = req.body || {};
  const photoPath = '/uploads/' + req.file.filename;
  let annotations = '[]';
  if (b.annotations) { try { JSON.parse(b.annotations); annotations = b.annotations; } catch (_) {} }
  await query(
    `INSERT INTO inspection_photos (inspection_id, inspection_item_id, photo_path, caption, annotations_json) VALUES ($1,$2,$3,$4,$5::jsonb)`,
    [req.params.id, b.inspection_item_id || null, photoPath, b.caption || null, annotations]
  );
  res.json({ ok: true, photo_path: photoPath });
});

// =============================================================================
//  CATCH-ALL — serve index.html for SPA-style routes (only after static files)
// =============================================================================
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'index.html'));
});

// =============================================================================
//  ERROR HANDLER — must be registered after every other app.use/route. Catches
//  whatever the app.<method> auto-wrap above forwards via next(err), so a bug
//  in any single request returns a 500 to that one client instead of crashing
//  the whole server for everyone else.
// =============================================================================
app.use((err, req, res, _next) => {
  console.error(`[error] ${req.method} ${req.url} —`, err && err.stack || err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Internal server error' });
});

// =============================================================================
//  waitForDatabase — block until Postgres will actually answer a query.
//
//  Postgres opens its listening socket well before it will serve anything.
//  While it is starting up -- and crash recovery counts, which is every boot
//  after the machine was switched off without stopping the server -- each
//  query comes straight back with 57P03, "the database system is starting up".
//  A bundled PostgreSQL on a first run stays in that state for a long time:
//  initdb plus the fsync of a brand-new data directory has been measured on a
//  shop PC at over 200 seconds, while boot.js gives up after 3 short retries
//  and starts this process anyway.
//
//  That is how a boot could log "schema apply failed", "admin seed failed",
//  "walk-in customer seed failed" and "labor standards seed failed" one after
//  another and still finish with "[boot] DB initialised": every step caught
//  its own error and moved on, and nothing was asking whether the database was
//  merely not ready yet. On an established install it went unnoticed because
//  the tables were already there from an earlier boot. On a genuinely fresh
//  one it leaves no schema and no admin account, with a success line in the
//  log saying otherwise.
//
//  Only transient conditions are worth waiting on. A wrong password, a missing
//  database or a pg_hba rejection is never going to fix itself, so those are
//  rethrown immediately rather than stalling the boot for three minutes first.
// =============================================================================
const DB_STARTING_SQLSTATES = new Set([
  '57P03', // cannot_connect_now -- "the database system is starting up"
  '57P02', // crash_shutdown -- it is on its way back
  '08000', // connection_exception
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '08003', // connection_does_not_exist
  '08006', // connection_failure
]);

function isDbStarting(e) {
  if (!e || !e.code) return false;
  // Deliberately NOT here: 3D000 (no such database), 28P01 (bad password),
  // 08004 (rejected by pg_hba) and ENOTFOUND (no such host) are all settled
  // answers -- waiting on them just delays the real error.
  return DB_STARTING_SQLSTATES.has(e.code) ||
         e.code === 'ECONNREFUSED' ||   // socket not open yet
         e.code === 'ETIMEDOUT';
}

async function waitForDatabase(timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  for (;;) {
    try {
      await pool.query('SELECT 1');
      if (attempts) console.log('[initDb] database ready after ' + attempts + ' retries');
      return;
    } catch (e) {
      if (!isDbStarting(e)) throw e;
      if (Date.now() >= deadline) {
        throw new Error('database still not ready after ' +
                        Math.round(timeoutMs / 1000) + 's — ' + e.message);
      }
      if (!attempts) console.log('[initDb] waiting for the database:', e.message);
      attempts++;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// =============================================================================
//  initDb — runs schema.sql, applies missing columns, seeds default admin,
//  and seeds products from seed-products.json if the table is empty.
//  Idempotent: safe to call on every boot.
//
//  Returns the names of the steps that did not apply. Each step still catches
//  its own error so one bad seed cannot stop the server coming up, but the
//  caller has to be told which ones failed -- silently returning as though
//  everything worked is the bug described above waitForDatabase().
// =============================================================================
async function initDb() {
  // Nothing below can succeed while Postgres is still starting, and every step
  // would report its own separate "failure" for the one shared reason.
  await waitForDatabase();

  const failed = [];

  // 1) Schema (CREATE TABLE IF NOT EXISTS / ALTER TABLE ... IF NOT EXISTS)
  try {
    const schemaPath = path.join(__dirname, 'schema.sql');
    if (fs.existsSync(schemaPath)) {
      const sql = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(sql);
      console.log('[initDb] schema applied');
    } else {
      failed.push('schema (schema.sql not found)');
      console.warn('[initDb] schema.sql not found at', schemaPath);
    }
  } catch (e) {
    failed.push('schema');
    console.error('[initDb] schema apply failed:', e.message);
  }

  // 2) Seed default admin (admin@melthahonda.com / password123) — always reset password
  try {
    const hash = await bcrypt.hash('password123', 10);
    await query(
      `INSERT INTO users (email, name, phone, password_hash, is_admin)
         VALUES ($1, $2, $3, $4, true)
       ON CONFLICT (email) DO UPDATE
         SET is_admin = true, password_hash = EXCLUDED.password_hash`,
      ['admin@melthahonda.com', 'Admin', '(876) 758-8503', hash]
    );
    console.log('[initDb] default admin seeded (admin@melthahonda.com / password123)');

    // A default till PIN for that same account, so PIN sign-in works out of
    // the box on a new machine.
    //
    // Unlike the password above, this is NOT reset on every boot. The password
    // is a documented recovery route -- if you can reach the server you can
    // always get back in -- but silently putting a staff member's PIN back to
    // the factory one every restart would hand the counter to anyone who has
    // read the manual. Set once, on an account that has none.
    //
    // is_staff is set alongside it: PIN sign-in only considers staff, and the
    // seeded admin would otherwise be an admin who cannot use the keypad.
    const { rows: pinRow } = await query(
      `SELECT id, (pin_hash IS NOT NULL) AS has_pin FROM users WHERE email = 'admin@melthahonda.com'`
    );
    if (pinRow.length && !pinRow[0].has_pin) {
      const taken = await pinCollides(DEFAULT_ADMIN_PIN, pinRow[0].id);
      if (taken) {
        console.warn('[initDb] default PIN ' + DEFAULT_ADMIN_PIN + ' is already used by another staff member — admin left without one');
      } else {
        const pinHash = await bcrypt.hash(DEFAULT_ADMIN_PIN, 10);
        await query(
          `UPDATE users SET pin_hash = $1, pin_set_at = NOW(), is_staff = true WHERE id = $2`,
          [pinHash, pinRow[0].id]
        );
        console.log('[initDb] default admin PIN set to ' + DEFAULT_ADMIN_PIN + ' — change it in Settings → Users & Staff');
      }
    }
  } catch (e) {
    failed.push('default admin');
    console.warn('[initDb] admin seed failed:', e.message);
  }

  // 2b) Seed the "Cash Customer - Walk-in" account -- the POS ticket bar
  // defaults every new ticket to this real customer record instead of a bare
  // text fallback (see WALKIN_CUSTOMER_ID / GET /api/admin/pos/walkin-customer
  // below). ON CONFLICT DO NOTHING, unlike the admin seed above -- this
  // account has no password anyone needs to keep working, so there's nothing
  // to force-reset, and doing so would be pointless churn on every boot.
  try {
    const { rows: existing } = await query(`SELECT id FROM users WHERE email = 'walkin@melthahonda.local'`);
    if (!existing.length) {
      const hash = await bcrypt.hash(require('crypto').randomBytes(24).toString('hex'), 10);
      const acctNo = await nextAccountNumber();
      await query(
        `INSERT INTO users (email, name, password_hash, via, is_admin, price_tier, account_number)
           VALUES ('walkin@melthahonda.local', 'Cash Customer - Walk-in', $1, 'pos', false, 'retail', $2)`,
        [hash, acctNo]
      );
      console.log('[initDb] seeded "Cash Customer - Walk-in" account (' + acctNo + ')');
    }
  } catch (e) {
    failed.push('walk-in customer');
    console.warn('[initDb] walk-in customer seed failed:', e.message);
  }

  // 3) Remove the demo catalogue.
  //
  // This used to seed 26 sample products from seed-products.json whenever the
  // products table was empty. That made migration 0011_drop_sample_products.sql
  // useless: delete the demo rows, restart, table is empty again, 26 fake parts
  // reappear. They are stock photos and invented prices, and because the real
  // stock import carries no pricing they were the only priced rows in the
  // catalogue -- so they were the first thing a customer saw and the only thing
  // the POS could ring up at face value, for parts the shop does not own.
  //
  // Matched on the exact img values from seed-products.json AND sku IS NULL,
  // not on sku IS NULL alone. That distinction matters: migration 0011 could
  // use the looser rule because at the time nothing else had a null sku, but
  // parts added since through Admin -> Inventory -> "Add new part" also have no
  // sku, and deleting the shop's own hand-entered parts on every boot would be
  // a catastrophe. The img list is the precise identifier.
  //
  // Runs on every boot rather than once: it is a single indexed delete that
  // normally removes nothing, and it means restoring an older backup cannot
  // quietly bring the demo catalogue back.
  try {
    const seedPath = path.join(__dirname, 'seed-products.json');
    if (fs.existsSync(seedPath)) {
      const demoImgs = JSON.parse(fs.readFileSync(seedPath, 'utf8'))
        .map((p) => p && p.img)
        .filter(Boolean);
      if (demoImgs.length) {
        const { rowCount } = await query(
          'DELETE FROM products WHERE img = ANY($1::text[]) AND sku IS NULL',
          [demoImgs]
        );
        if (rowCount) console.log('[initDb] removed', rowCount, 'sample products');
      }
    }
  } catch (e) {
    failed.push('sample product cleanup');
    console.warn('[initDb] sample product cleanup failed:', e.message);
  }

  // 4) Labor standards (vehicle classes, rate tiers, flat-rate operations).
  // seedLaborStandards() was fully written but never actually called from
  // anywhere -- the Labor Standards tab's tables existed with zero rows.
  try {
    await seedLaborStandards();
  } catch (e) {
    failed.push('labor standards');
    console.warn('[initDb] labor standards seed failed:', e.message);
  }

  // 5) Inventory, on a brand-new install only.
  //
  // This is what makes a fresh machine usable straight out of the zip. The
  // package used to ship a copy of this machine's PostgreSQL data directory
  // instead, which is a fragile thing to move: it carries absolute paths from
  // the machine that made it, loses the empty folders PostgreSQL requires if
  // any tool declines to store them, and is inconsistent if the source was
  // running when the copy was taken. Every one of those failed the same way --
  // the database refused to start and the admin page looked like it was
  // rejecting the password.
  //
  // Building the database locally on first run avoids all of it: initdb makes
  // a data directory correct for THIS machine, schema.sql builds the tables,
  // the seed above creates the default admin, and this loads the catalogue.
  //
  // Guarded on the table being empty, so it never touches a shop's real stock.
  // A shop that has traded for a week and deleted every product on purpose is
  // not re-seeded behind their back -- the marker row settles that.
  try {
    const seedPath = path.join(__dirname, 'seed-inventory.csv');
    if (fs.existsSync(seedPath)) {
      const { rows: have } = await query('SELECT COUNT(*)::int AS n FROM products');
      const { rows: mark } = await query(
        `SELECT COUNT(*)::int AS n FROM app_settings WHERE key = 'inventory_seeded'`
      ).catch(() => ({ rows: [{ n: 0 }] }));
      if (have[0].n === 0 && mark[0].n === 0) {
        const parsed = await inventoryImport.parseInventoryFile(fs.readFileSync(seedPath), 'seed-inventory.csv');
        let loaded = 0;
        const CHUNK = 400;
        for (let s = 0; s < parsed.items.length; s += CHUNK) {
          const slice = parsed.items.slice(s, s + CHUNK);
          const params = [];
          const tuples = slice.map((it) => {
            const vals = [it.img, it.sku, it.name, it.make_model, it.category || 'Other',
                          it.condition, it.price_usd, it.cost_usd, it.stock_count,
                          it.low_threshold, it.bin_location, it.location, it.barcode];
            return '(' + vals.map((v) => { params.push(v); return '$' + params.length; }).join(',') + ')';
          });
          const { rowCount } = await query(
            `INSERT INTO products (img, sku, name, make_model, category, condition,
                                   price_usd, cost_usd, stock_count, low_threshold,
                                   bin_location, location, barcode)
               VALUES ${tuples.join(',')} ON CONFLICT (img) DO NOTHING`,
            params
          );
          loaded += rowCount;
        }
        await query(
          `INSERT INTO app_settings (key, value) VALUES ('inventory_seeded', NOW()::text)
             ON CONFLICT (key) DO NOTHING`
        ).catch(() => {});
        console.log('[initDb] seeded', loaded, 'products from seed-inventory.csv (first run)');
      }
    }
  } catch (e) {
    failed.push('inventory seed');
    console.warn('[initDb] inventory seed failed:', e.message);
  }

  return { failed };
}


// =============================================================================
//  REPORTS MODULE — every transaction area, plus till reads (X / Z).
//
//  Money is returned as USD floats throughout so the admin UI can hand any
//  figure straight to fmtMoney(). The D1 port in functions/api/[[path]].js
//  divides its *_cents columns by 100 to match this contract -- without that
//  the two backends drift and the UI silently renders blanks, which is exactly
//  what already happened to /admin/dashboard: it returns revenue_cents while
//  renderDashboard reads d.revenue.today.
//
//  Every range is inclusive and expressed as YYYY-MM-DD.
// =============================================================================

function reportRange(req) {
  const today = new Date().toISOString().slice(0, 10);
  const from = String(req.query.from || today).slice(0, 10);
  const to = String(req.query.to || from).slice(0, 10);
  return { from, to };
}

// Till read shared by X (mid-shift, drawer still open) and Z (end of day).
// The window runs from the session's open time to its close time, or to "now"
// while it is still open -- a till read is always session-scoped, never
// calendar-scoped, because a shift can straddle midnight.
async function buildTillReport(session) {
  const from = session.opened_at;
  const to = session.closed_at || new Date();
  const p = [from, to];

  const [sales, voids, tenders, refunds, units, grand, hourly, byCashier] = await Promise.all([
    query(
      `SELECT COUNT(*)::int AS n,
              COALESCE(SUM(subtotal_usd),0)::float AS subtotal,
              COALESCE(SUM(discount_usd),0)::float AS discount,
              COALESCE(SUM(tax_usd),0)::float  AS tax,
              COALESCE(SUM(total_usd),0)::float AS total
         FROM pos_sales
        WHERE voided = false AND created_at BETWEEN $1 AND $2`, p),
    query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(total_usd),0)::float AS total
         FROM pos_sales
        WHERE voided = true AND created_at BETWEEN $1 AND $2`, p),
    query(
      `SELECT sp.method, COUNT(*)::int AS n, COALESCE(SUM(sp.amount_usd),0)::float AS total
         FROM sale_payments sp
         JOIN pos_sales ps ON ps.id = sp.sale_id
        WHERE ps.voided = false AND sp.created_at BETWEEN $1 AND $2
        GROUP BY sp.method ORDER BY total DESC`, p),
    query(
      `SELECT refund_method AS method, COUNT(*)::int AS n,
              COALESCE(SUM(refund_total_usd),0)::float AS total
         FROM pos_sale_returns
        WHERE created_at BETWEEN $1 AND $2
        GROUP BY refund_method ORDER BY total DESC`, p),
    query(
      `SELECT COALESCE(SUM(i.qty),0)::int AS units
         FROM pos_sale_items i JOIN pos_sales ps ON ps.id = i.sale_id
        WHERE ps.voided = false AND ps.created_at BETWEEN $1 AND $2`, p),
    // The running total is deliberately open-ended at the start: a Z report's
    // grand total is cumulative and never resets, which is what lets one Z be
    // reconciled against the previous one.
    query(
      `SELECT COALESCE(SUM(total_usd),0)::float AS total, COUNT(*)::int AS n
         FROM pos_sales WHERE voided = false AND created_at <= $1`, [to]),
    query(
      `SELECT EXTRACT(HOUR FROM created_at)::int AS hour, COUNT(*)::int AS n,
              COALESCE(SUM(total_usd),0)::float AS total
         FROM pos_sales
        WHERE voided = false AND created_at BETWEEN $1 AND $2
        GROUP BY hour ORDER BY hour ASC`, p),
    query(
      `SELECT COALESCE(cashier_name,'-') AS cashier, COUNT(*)::int AS n,
              COALESCE(SUM(total_usd),0)::float AS total
         FROM pos_sales
        WHERE voided = false AND created_at BETWEEN $1 AND $2
        GROUP BY cashier_name ORDER BY total DESC`, p),
  ]);

  const s = sales.rows[0];
  const tenderRows = tenders.rows;
  const refundRows = refunds.rows;
  const cashIn = Number((tenderRows.find((r) => r.method === 'cash') || {}).total || 0);
  const cashOut = Number((refundRows.find((r) => r.method === 'cash') || {}).total || 0);
  const openingFloat = Number(session.opening_float || 0);
  const expectedCash = openingFloat + cashIn - cashOut;
  const counted = session.closing_amount == null ? null : Number(session.closing_amount);
  const refundTotal = refundRows.reduce((a, r) => a + Number(r.total), 0);

  return {
    session: {
      id: session.id,
      opened_at: session.opened_at,
      closed_at: session.closed_at,
      opener_name: session.opener_name || null,
      closer_name: session.closer_name || null,
      opening_float: openingFloat,
      notes: session.notes || null,
    },
    window: { from, to },
    sales: {
      count: s.n,
      subtotal: s.subtotal,
      discount: s.discount,
      tax: s.tax,
      total: s.total,
      units: units.rows[0].units,
      avg_ticket: s.n ? s.total / s.n : 0,
    },
    voids: voids.rows[0],
    tenders: tenderRows,
    refunds: refundRows,
    refund_total: refundTotal,
    net_total: Number(s.total) - refundTotal,
    cash: {
      opening_float: openingFloat,
      cash_sales: cashIn,
      cash_refunds: cashOut,
      expected: expectedCash,
      counted,
      // Recomputed rather than reading the stored variance, so re-running a Z
      // after the fact still reconciles if payments were edited post-close.
      variance: counted == null ? null : counted - expectedCash,
    },
    by_cashier: byCashier.rows,
    hourly: hourly.rows,
    grand_total: grand.rows[0],
  };
}

async function loadSessionRow(where, params) {
  const { rows } = await query(
    `SELECT s.*, s.opening_float::float AS opening_float,
            s.closing_amount::float AS closing_amount,
            o.name AS opener_name, c.name AS closer_name
       FROM cash_drawer_sessions s
       LEFT JOIN mechanics o ON o.id = s.opened_by
       LEFT JOIN mechanics c ON c.id = s.closed_by
      ${where}`, params);
  return rows[0] || null;
}

// Every /api/admin/reports/* endpoint needs the reports.view capability. One
// prefix gate rather than a flag on each of the ~15 routes below.
app.use('/api/admin/reports', requireCap('reports.view'));

// Drawer sessions in a range -- the picker that feeds the Z report.
app.get('/api/admin/reports/drawer-sessions', requireAdmin, async (req, res) => {
  const { from, to } = reportRange(req);
  const { rows } = await query(
    `SELECT s.id, s.opened_at, s.closed_at,
            s.opening_float::float  AS opening_float,
            s.closing_amount::float AS closing_amount,
            s.expected_cash::float  AS expected_cash,
            s.variance::float       AS variance,
            o.name AS opener_name, c.name AS closer_name
       FROM cash_drawer_sessions s
       LEFT JOIN mechanics o ON o.id = s.opened_by
       LEFT JOIN mechanics c ON c.id = s.closed_by
      WHERE s.opened_at::date BETWEEN $1::date AND $2::date
      ORDER BY s.opened_at DESC`, [from, to]);
  res.json({ from, to, sessions: rows });
});

// Z report -- end-of-day read of a closed session. Defaults to the most
// recently closed session so "run today's Z" needs no arguments.
app.get('/api/admin/reports/z', requireAdmin, async (req, res) => {
  const id = req.query.session_id;
  const session = id
    ? await loadSessionRow('WHERE s.id = $1', [id])
    : await loadSessionRow('WHERE s.closed_at IS NOT NULL ORDER BY s.closed_at DESC LIMIT 1', []);
  if (!session) return res.status(404).json({ error: 'No closed drawer session found to report on.' });
  const report = await buildTillReport(session);
  res.json(Object.assign({ kind: 'Z', final: !!session.closed_at }, report));
});

// X report -- mid-shift read of the currently open drawer. Non-resetting.
app.get('/api/admin/reports/x', requireAdmin, async (_req, res) => {
  const session = await loadSessionRow('WHERE s.closed_at IS NULL ORDER BY s.opened_at DESC LIMIT 1', []);
  if (!session) return res.status(404).json({ error: 'No cash drawer session is currently open.' });
  const report = await buildTillReport(session);
  res.json(Object.assign({ kind: 'X', final: false }, report));
});

// POS counter sales across a date range.
app.get('/api/admin/reports/sales', requireAdmin, async (req, res) => {
  const { from, to } = reportRange(req);
  const p = [from, to];
  const [totals, byDay, byCashier, byTender, byHour, voids, refunds, units] = await Promise.all([
    query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(subtotal_usd),0)::float AS subtotal,
                  COALESCE(SUM(discount_usd),0)::float AS discount,
                  COALESCE(SUM(tax_usd),0)::float AS tax,
                  COALESCE(SUM(total_usd),0)::float AS total
             FROM pos_sales WHERE voided = false AND created_at::date BETWEEN $1::date AND $2::date`, p),
    query(`SELECT created_at::date AS day, COUNT(*)::int AS n,
                  COALESCE(SUM(discount_usd),0)::float AS discount,
                  COALESCE(SUM(tax_usd),0)::float AS tax,
                  COALESCE(SUM(total_usd),0)::float AS total
             FROM pos_sales WHERE voided = false AND created_at::date BETWEEN $1::date AND $2::date
            GROUP BY day ORDER BY day DESC`, p),
    query(`SELECT COALESCE(cashier_name,'-') AS cashier, COUNT(*)::int AS n,
                  COALESCE(SUM(total_usd),0)::float AS total
             FROM pos_sales WHERE voided = false AND created_at::date BETWEEN $1::date AND $2::date
            GROUP BY cashier_name ORDER BY total DESC`, p),
    query(`SELECT sp.method, COUNT(*)::int AS n, COALESCE(SUM(sp.amount_usd),0)::float AS total
             FROM sale_payments sp JOIN pos_sales ps ON ps.id = sp.sale_id
            WHERE ps.voided = false AND sp.created_at::date BETWEEN $1::date AND $2::date
            GROUP BY sp.method ORDER BY total DESC`, p),
    query(`SELECT EXTRACT(HOUR FROM created_at)::int AS hour, COUNT(*)::int AS n,
                  COALESCE(SUM(total_usd),0)::float AS total
             FROM pos_sales WHERE voided = false AND created_at::date BETWEEN $1::date AND $2::date
            GROUP BY hour ORDER BY hour ASC`, p),
    query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(total_usd),0)::float AS total
             FROM pos_sales WHERE voided = true AND created_at::date BETWEEN $1::date AND $2::date`, p),
    query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(refund_total_usd),0)::float AS total
             FROM pos_sale_returns WHERE created_at::date BETWEEN $1::date AND $2::date`, p),
    query(`SELECT COALESCE(SUM(i.qty),0)::int AS units
             FROM pos_sale_items i JOIN pos_sales ps ON ps.id = i.sale_id
            WHERE ps.voided = false AND ps.created_at::date BETWEEN $1::date AND $2::date`, p),
  ]);
  const t = totals.rows[0];
  res.json({
    from, to,
    totals: Object.assign({}, t, {
      units: units.rows[0].units,
      avg_ticket: t.n ? t.total / t.n : 0,
      net_total: t.total - refunds.rows[0].total,
    }),
    by_day: byDay.rows, by_cashier: byCashier.rows, by_tender: byTender.rows,
    by_hour: byHour.rows, voids: voids.rows[0], refunds: refunds.rows[0],
  });
});

// Product / category movement for the range.
app.get('/api/admin/reports/products', requireAdmin, async (req, res) => {
  const { from, to } = reportRange(req);
  const p = [from, to];
  const [top, byCategory, slow] = await Promise.all([
    query(`SELECT i.description AS name, i.product_img,
                  COALESCE(SUM(i.qty),0)::int AS units,
                  COALESCE(SUM(i.total_usd),0)::float AS revenue
             FROM pos_sale_items i JOIN pos_sales ps ON ps.id = i.sale_id
            WHERE ps.voided = false AND ps.created_at::date BETWEEN $1::date AND $2::date
            GROUP BY i.description, i.product_img
            ORDER BY revenue DESC LIMIT 50`, p),
    query(`SELECT COALESCE(pr.category,'-') AS category,
                  COALESCE(SUM(i.qty),0)::int AS units,
                  COALESCE(SUM(i.total_usd),0)::float AS revenue
             FROM pos_sale_items i
             JOIN pos_sales ps ON ps.id = i.sale_id
             LEFT JOIN products pr ON pr.img = i.product_img
            WHERE ps.voided = false AND ps.created_at::date BETWEEN $1::date AND $2::date
            GROUP BY pr.category ORDER BY revenue DESC`, p),
    // Stocked lines that did not move at all in the window -- the reorder
    // conversation usually starts here rather than with the best sellers.
    query(`SELECT pr.img, pr.name, pr.category, pr.stock_count,
                  pr.price_usd::float AS price_usd
             FROM products pr
            WHERE pr.is_active = true AND pr.stock_count > 0
              AND NOT EXISTS (
                SELECT 1 FROM pos_sale_items i JOIN pos_sales ps ON ps.id = i.sale_id
                 WHERE i.product_img = pr.img AND ps.voided = false
                   AND ps.created_at::date BETWEEN $1::date AND $2::date)
            ORDER BY pr.stock_count DESC LIMIT 50`, p),
  ]);
  res.json({ from, to, top_products: top.rows, by_category: byCategory.rows, no_movement: slow.rows });
});

// Refunds / returns.
app.get('/api/admin/reports/returns', requireAdmin, async (req, res) => {
  const { from, to } = reportRange(req);
  const p = [from, to];
  const [totals, byMethod, byReason, recent] = await Promise.all([
    query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(refund_total_usd),0)::float AS total,
                  COALESCE(SUM(refund_tax_usd),0)::float AS tax
             FROM pos_sale_returns WHERE created_at::date BETWEEN $1::date AND $2::date`, p),
    query(`SELECT refund_method AS method, COUNT(*)::int AS n,
                  COALESCE(SUM(refund_total_usd),0)::float AS total
             FROM pos_sale_returns WHERE created_at::date BETWEEN $1::date AND $2::date
            GROUP BY refund_method ORDER BY total DESC`, p),
    query(`SELECT COALESCE(NULLIF(reason,''),'-') AS reason, COUNT(*)::int AS n,
                  COALESCE(SUM(refund_total_usd),0)::float AS total
             FROM pos_sale_returns WHERE created_at::date BETWEEN $1::date AND $2::date
            GROUP BY reason ORDER BY total DESC LIMIT 25`, p),
    query(`SELECT r.return_number, r.created_at, r.refund_method,
                  r.refund_total_usd::float AS refund_total_usd, r.reason,
                  ps.receipt_number, ps.customer_name
             FROM pos_sale_returns r LEFT JOIN pos_sales ps ON ps.id = r.sale_id
            WHERE r.created_at::date BETWEEN $1::date AND $2::date
            ORDER BY r.created_at DESC LIMIT 100`, p),
  ]);
  res.json({ from, to, totals: totals.rows[0], by_method: byMethod.rows, by_reason: byReason.rows, recent: recent.rows });
});

// Tax collected across both revenue streams.
app.get('/api/admin/reports/tax', requireAdmin, async (req, res) => {
  const { from, to } = reportRange(req);
  const p = [from, to];
  const [pos, wo, refunded, byDay] = await Promise.all([
    query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(tax_usd),0)::float AS tax,
                  COALESCE(SUM(subtotal_usd - discount_usd),0)::float AS taxable
             FROM pos_sales WHERE voided = false AND created_at::date BETWEEN $1::date AND $2::date`, p),
    query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(tax_usd),0)::float AS tax
             FROM work_orders WHERE status = 'paid' AND paid_at::date BETWEEN $1::date AND $2::date`, p),
    query(`SELECT COALESCE(SUM(refund_tax_usd),0)::float AS tax
             FROM pos_sale_returns WHERE created_at::date BETWEEN $1::date AND $2::date`, p),
    query(`SELECT created_at::date AS day, COALESCE(SUM(tax_usd),0)::float AS tax
             FROM pos_sales WHERE voided = false AND created_at::date BETWEEN $1::date AND $2::date
            GROUP BY day ORDER BY day DESC`, p),
  ]);
  const net = pos.rows[0].tax + wo.rows[0].tax - refunded.rows[0].tax;
  res.json({ from, to, pos: pos.rows[0], work_orders: wo.rows[0],
    refunded_tax: refunded.rows[0].tax, net_tax: net, by_day: byDay.rows });
});

// Storefront online orders.
app.get('/api/admin/reports/orders', requireAdmin, async (req, res) => {
  const { from, to } = reportRange(req);
  const p = [from, to];
  const [totals, byStatus, byPayment, byDay, top] = await Promise.all([
    query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(total_usd),0)::float AS total
             FROM orders WHERE created_at::date BETWEEN $1::date AND $2::date`, p),
    query(`SELECT status, COUNT(*)::int AS n, COALESCE(SUM(total_usd),0)::float AS total
             FROM orders WHERE created_at::date BETWEEN $1::date AND $2::date
            GROUP BY status ORDER BY total DESC`, p),
    query(`SELECT payment_method, payment_status, COUNT(*)::int AS n,
                  COALESCE(SUM(total_usd),0)::float AS total
             FROM orders WHERE created_at::date BETWEEN $1::date AND $2::date
            GROUP BY payment_method, payment_status ORDER BY total DESC`, p),
    query(`SELECT created_at::date AS day, COUNT(*)::int AS n,
                  COALESCE(SUM(total_usd),0)::float AS total
             FROM orders WHERE created_at::date BETWEEN $1::date AND $2::date
            GROUP BY day ORDER BY day DESC`, p),
    query(`SELECT COALESCE(pr.name, oi.product_img) AS name,
                  COALESCE(SUM(oi.qty),0)::int AS units,
                  COALESCE(SUM(oi.qty * oi.price_usd),0)::float AS revenue
             FROM order_items oi
             JOIN orders o ON o.id = oi.order_id
             LEFT JOIN products pr ON pr.img = oi.product_img
            WHERE o.created_at::date BETWEEN $1::date AND $2::date
            GROUP BY COALESCE(pr.name, oi.product_img)
            ORDER BY revenue DESC LIMIT 25`, p),
  ]);
  const t = totals.rows[0];
  res.json({ from, to, totals: Object.assign({}, t, { avg_order: t.n ? t.total / t.n : 0 }),
    by_status: byStatus.rows, by_payment: byPayment.rows, by_day: byDay.rows, top_products: top.rows });
});

// Service centre: work orders, labour, parts and what was actually collected.
app.get('/api/admin/reports/workorders', requireAdmin, async (req, res) => {
  const { from, to } = reportRange(req);
  const p = [from, to];
  const [totals, byStatus, payments, byMechanic, parts] = await Promise.all([
    query(`SELECT COUNT(*)::int AS n,
                  COALESCE(SUM(labor_total_usd),0)::float AS labour,
                  COALESCE(SUM(parts_total_usd),0)::float AS parts,
                  COALESCE(SUM(tax_usd),0)::float AS tax,
                  COALESCE(SUM(total_usd),0)::float AS total
             FROM work_orders WHERE intake_date::date BETWEEN $1::date AND $2::date`, p),
    query(`SELECT status, COUNT(*)::int AS n, COALESCE(SUM(total_usd),0)::float AS total
             FROM work_orders WHERE intake_date::date BETWEEN $1::date AND $2::date
            GROUP BY status ORDER BY n DESC`, p),
    query(`SELECT method, COUNT(*)::int AS n, COALESCE(SUM(amount_usd),0)::float AS total
             FROM work_order_payments WHERE received_at::date BETWEEN $1::date AND $2::date
            GROUP BY method ORDER BY total DESC`, p),
    query(`SELECT COALESCE(m.name,'-') AS mechanic, COUNT(l.id)::int AS jobs,
                  COALESCE(SUM(l.hours),0)::float AS hours,
                  COALESCE(SUM(l.total_usd),0)::float AS revenue
             FROM work_order_labor l LEFT JOIN mechanics m ON m.id = l.mechanic_id
            WHERE l.created_at::date BETWEEN $1::date AND $2::date
            GROUP BY m.name ORDER BY revenue DESC`, p),
    query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(wp.total_usd),0)::float AS total
             FROM work_order_parts wp JOIN work_orders w ON w.id = wp.work_order_id
            WHERE w.intake_date::date BETWEEN $1::date AND $2::date`, p),
  ]);
  res.json({ from, to, totals: totals.rows[0], by_status: byStatus.rows,
    payments: payments.rows, by_mechanic: byMechanic.rows, parts: parts.rows[0] });
});

// Purchasing / receiving.
app.get('/api/admin/reports/purchasing', requireAdmin, async (req, res) => {
  const { from, to } = reportRange(req);
  const p = [from, to];
  const [totals, byStatus, bySupplier, received] = await Promise.all([
    query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(total_usd),0)::float AS total
             FROM purchase_orders WHERE created_at::date BETWEEN $1::date AND $2::date`, p),
    query(`SELECT status, COUNT(*)::int AS n, COALESCE(SUM(total_usd),0)::float AS total
             FROM purchase_orders WHERE created_at::date BETWEEN $1::date AND $2::date
            GROUP BY status ORDER BY total DESC`, p),
    query(`SELECT COALESCE(s.name,'-') AS supplier, COUNT(*)::int AS n,
                  COALESCE(SUM(po.total_usd),0)::float AS total
             FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id
            WHERE po.created_at::date BETWEEN $1::date AND $2::date
            GROUP BY s.name ORDER BY total DESC`, p),
    query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(total_usd),0)::float AS total
             FROM purchase_orders WHERE received_date IS NOT NULL
              AND received_date::date BETWEEN $1::date AND $2::date`, p),
  ]);
  res.json({ from, to, totals: totals.rows[0], by_status: byStatus.rows,
    by_supplier: bySupplier.rows, received: received.rows[0] });
});

// Inventory position -- a snapshot, so it ignores the date range by design.
app.get('/api/admin/reports/inventory', requireAdmin, async (_req, res) => {
  const [valuation, byCategory, low, out] = await Promise.all([
    query(`SELECT COUNT(*)::int AS lines,
                  COALESCE(SUM(stock_count),0)::int AS units,
                  COALESCE(SUM(stock_count * price_usd),0)::float AS retail_value,
                  COALESCE(SUM(stock_count * COALESCE(cost_usd, 0)),0)::float AS cost_value
             FROM products WHERE is_active = true`),
    query(`SELECT COALESCE(category,'-') AS category, COUNT(*)::int AS lines,
                  COALESCE(SUM(stock_count),0)::int AS units,
                  COALESCE(SUM(stock_count * price_usd),0)::float AS retail_value
             FROM products WHERE is_active = true GROUP BY category ORDER BY retail_value DESC`),
    query(`SELECT img, name, category, stock_count, low_threshold,
                  price_usd::float AS price_usd
             FROM products WHERE is_active = true AND stock_count <= low_threshold
            ORDER BY stock_count ASC LIMIT 100`),
    query(`SELECT COUNT(*)::int AS n FROM products WHERE is_active = true AND stock_count <= 0`),
  ]);
  const v = valuation.rows[0];
  res.json({
    valuation: Object.assign({}, v, { margin_value: v.retail_value - v.cost_value }),
    by_category: byCategory.rows, low_stock: low.rows, out_of_stock: out.rows[0].n,
  });
});

// Labour hours off the time clock.
app.get('/api/admin/reports/labour', requireAdmin, async (req, res) => {
  const { from, to } = reportRange(req);
  const p = [from, to];
  const [byMechanic, byDay, totals] = await Promise.all([
    query(`SELECT COALESCE(m.name,'-') AS mechanic, COUNT(*)::int AS entries,
                  COALESCE(SUM(t.hours),0)::float AS hours
             FROM time_entries t LEFT JOIN mechanics m ON m.id = t.mechanic_id
            WHERE t.clocked_in_at::date BETWEEN $1::date AND $2::date
            GROUP BY m.name ORDER BY hours DESC`, p),
    query(`SELECT clocked_in_at::date AS day, COALESCE(SUM(hours),0)::float AS hours
             FROM time_entries WHERE clocked_in_at::date BETWEEN $1::date AND $2::date
            GROUP BY day ORDER BY day DESC`, p),
    query(`SELECT COUNT(*)::int AS entries, COALESCE(SUM(hours),0)::float AS hours
             FROM time_entries WHERE clocked_in_at::date BETWEEN $1::date AND $2::date`, p),
  ]);
  res.json({ from, to, totals: totals.rows[0], by_mechanic: byMechanic.rows, by_day: byDay.rows });
});

// Customers + loyalty.
app.get('/api/admin/reports/customers', requireAdmin, async (req, res) => {
  const { from, to } = reportRange(req);
  const p = [from, to];
  const [newUsers, topPos, loyalty, newsletter] = await Promise.all([
    query(`SELECT COUNT(*)::int AS n FROM users WHERE created_at::date BETWEEN $1::date AND $2::date`, p),
    query(`SELECT COALESCE(customer_name,'Walk-in') AS customer, COUNT(*)::int AS visits,
                  COALESCE(SUM(total_usd),0)::float AS spend
             FROM pos_sales WHERE voided = false AND created_at::date BETWEEN $1::date AND $2::date
            GROUP BY customer_name ORDER BY spend DESC LIMIT 25`, p),
    query(`SELECT COALESCE(SUM(CASE WHEN delta > 0 THEN delta ELSE 0 END),0)::int AS earned,
                  COALESCE(SUM(CASE WHEN delta < 0 THEN -delta ELSE 0 END),0)::int AS redeemed
             FROM points_transactions WHERE created_at::date BETWEEN $1::date AND $2::date`, p),
    query(`SELECT COUNT(*)::int AS n FROM newsletter_subscribers
            WHERE subscribed_at::date BETWEEN $1::date AND $2::date`, p),
  ]);
  res.json({ from, to, new_customers: newUsers.rows[0].n, top_customers: topPos.rows,
    loyalty: loyalty.rows[0], newsletter_signups: newsletter.rows[0].n });
});
// =============================================================================
//  BOOT
// =============================================================================
async function start() {
  try {
    // Only the machine holding the database owns the schema.
    //
    // Every instance used to run this, which was harmless while they all
    // connected as the superuser. It stopped being harmless the moment tills
    // got their own least-privilege roles: a terminal role has no CREATE
    // right, so schema.sql would fail on every till boot and fill the log with
    // permission errors that look like a broken install. It is also simply
    // wrong for a till to be applying DDL to the shop's database.
    if (ownsSchema()) {
      // "DB initialised" used to print whether or not anything had been
      // initialised, because initDb swallowed every step's error and returned
      // normally regardless. Say what actually happened.
      const { failed } = await initDb();
      if (failed.length) {
        console.error('[boot] DB init INCOMPLETE — did not apply: ' + failed.join(', ') +
                      ' (see the [initDb] lines above)');
      } else {
        console.log('[boot] DB initialised');
      }
    } else {
      console.log('[boot] client terminal — schema is owned by the database host, skipping initDb');
    }
  } catch (e) {
    console.error('[boot] DB init failed:', e.message);
  }
  // After initDb, so the terminals table exists on a fresh install. Awaited so
  // the gate knows this machine's status before the first request arrives --
  // otherwise a blocked till would serve its admin panel for one heartbeat.
  await terminalHeartbeat();
  app.listen(PORT, () => {
    console.log('[boot] Meltha Honda server listening on http://localhost:' + PORT);
  });

  // Off-site backup: only the database-owning machine runs the schedule.
  // First check shortly after boot (catch-up for an overnight outage), then
  // every 10 minutes -- backupTick() itself decides whether anything is due.
  if (ownsSchema()) {
    setTimeout(() => { backupTick(); }, 45000);
    setInterval(() => { backupTick(); }, 10 * 60 * 1000);
  }
}
start();

// EOF
