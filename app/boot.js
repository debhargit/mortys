// ============================================================================
//  Morty's Auto Parts Admin — portable supervisor
//
//  This is the process that actually runs when someone double-clicks
//  "Morty's Auto Parts Admin.vbs". The .vbs does nothing except launch
//    runtime\node.exe app\boot.js
//  with window style 0, so no console window is ever created visibly. Every
//  piece of real logic lives here instead of in VBScript, because here we
//  have child_process, http and fs to work with.
//
//  Responsibilities, in order:
//    1. Refuse to start twice (lock file + liveness check).
//    2. Start the bundled PostgreSQL, if this build shipped with one
//       (runtime\pgsql). Initialises the data directory on first run. If
//       something already holds the port, confirm it is THIS install's data
//       directory, and refuse to go any further if it is not.
//    3. Seed app\db-config.json / app\server-config.json from portable.json,
//       but ONLY if they don't exist yet -- once an operator has edited the
//       database target from Admin -> Setup, that edit is the source of
//       truth and must survive restarts.
//    4. Supervise server.js: spawn it hidden, pipe its output to a log file,
//       restart it if it dies.
//    5. Hold the lock until told to stop.
//
//  Usage:
//    node boot.js            start and supervise (blocks)
//    node boot.js --stop     stop a running instance and exit
//    node boot.js --status   print one line of JSON about the instance
// ============================================================================

'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const APP_DIR = __dirname;                                  // ...\app
const ROOT_DIR = path.resolve(APP_DIR, '..');               // portable root
const DATA_DIR = path.join(ROOT_DIR, 'data');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const PGDATA_DIR = path.join(DATA_DIR, 'pgdata');
const PG_BIN = path.join(ROOT_DIR, 'runtime', 'pgsql', 'bin');
const LOCK_FILE = path.join(DATA_DIR, 'admin.lock');
const BOOT_LOG = path.join(LOG_DIR, 'boot.log');
const SERVER_LOG = path.join(LOG_DIR, 'server.log');
const MAX_LOG_BYTES = 5 * 1024 * 1024;

fs.mkdirSync(LOG_DIR, { recursive: true });

// ---------------------------------------------------------------- logging --
function log(msg) {
  const line = '[' + new Date().toISOString() + '] ' + msg + os.EOL;
  try { fs.appendFileSync(BOOT_LOG, line); } catch (_) {}
}
function rotateIfBig(file) {
  try {
    if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, file + '.old');
  } catch (_) {}
}

// ---------------------------------------------------------------- config ---
// The BOM strip is not paranoia: Notepad and PowerShell's Set-Content both
// write one by default, and JSON.parse throws on it. Without this, an operator
// who opens db-config.json in Notepad to check the address and hits Save has
// silently reverted the whole config to the fallback -- which then looks like
// a database problem, not an editor problem.
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); }
  catch (_) { return fallback; }
}
function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}

const CFG = Object.assign({
  appPort: 3057,
  openBrowser: true,
  bundledPostgres: false,
  pgPort: 5433,
  pgUser: 'postgres',
  pgPassword: 'postgres',
  database: 'mortysautoparts',
  dbHost: 'localhost',
  dbPort: 5432,
  dbUser: 'postgres',
  dbPassword: 'postgres',
  machineName: '',
}, readJson(path.join(APP_DIR, 'portable.json'), {}));

// SECURITY CHECK 2026-11-13: protected install (Protect-Mortys-Database.ps1). The database
// then runs as its own Windows service under its own account, and this
// supervisor runs as the app's service. Here we only make sure that service is
// started; we never start or stop PostgreSQL ourselves.
const PROTECTED = readJson(path.join(ROOT_DIR, 'protected.json'), null);
const DB_SERVICE = PROTECTED && PROTECTED.dbService ? String(PROTECTED.dbService) : '';

// ------------------------------------------------------------ lock/status --
function readLock() { return readJson(LOCK_FILE, null); }
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function runningInstance() {
  const lock = readLock();
  if (lock && pidAlive(lock.pid)) return lock;
  return null;
}
function clearLock() { try { fs.unlinkSync(LOCK_FILE); } catch (_) {} }

// --------------------------------------------------------------- helpers ---
function tcpOpen(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => { if (done) return; done = true; try { sock.destroy(); } catch (_) {} resolve(ok); };
    sock.setTimeout(timeoutMs || 1500);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, host);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForTcp(host, port, totalMs) {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    if (await tcpOpen(host, port, 1000)) return true;
    await sleep(500);
  }
  return false;
}

function httpOk(port, urlPath, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: urlPath, timeout: timeoutMs || 2000 },
      (res) => { res.resume(); resolve(res.statusCode > 0 && res.statusCode < 500); }
    );
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

// ---------------------------------------------------------- local network --
// The address other machines on the shop LAN reach this PC at. Re-read from the
// OS on every call, never cached: DHCP can hand this machine a different
// address between one boot and the next, and everything downstream here -- the
// address recorded for Setup to display, a client's "which PC is the database"
// pointer, the bundled database's LAN allow-list -- has to follow that change
// or it goes on pointing at nothing.
//
// Returns { name, address, netmask } for the best candidate, or null when the
// machine has no usable IPv4 yet (still acquiring a lease, cable unplugged).
// Which address to advertise, and the subnet it sits on. Both come from the
// shared ranker in lan-address.js, so this file's machine-config.json and
// server.js's discovery announce cannot disagree about where the shop should
// point its tills.
//
// The name-PREFIX list that used to live here (vEthernet|VMware|Tailscale|...)
// matched neither "DuckDuckGo.VPN" nor an OpenVPN TAP adapter showing up as
// plain "Ethernet 2", so on the shop's own machine it ranked the VPN level
// with the real Wi-Fi adapter and the VPN won on list order -- exactly the
// failure the old comment here warned about.
const { lanAddressDetail, networkCidr } = require('./lan-address');

// { address, name, netmask, cidr, pinned, candidates } or null, same shape the
// callers below already expected.
function primaryLocalIPv4() {
  return lanAddressDetail(APP_DIR);
}

// Runs on every boot, and on demand via `node boot.js --refresh-ip` (which is
// what Install.ps1 calls). Three independent jobs, each best-effort: a failure
// in one is logged and stepped over, never allowed to stop the server coming
// up.
//
//   1. Record this PC's current LAN address in machine-config.json, so Admin ->
//      Setup and anything else reading that file shows where the shop should be
//      pointed even after a DHCP change. server.js already derives the live
//      address for discovery and join links; this is the persisted copy
//      catching up so a human reading the file is not misled.
//
//   2. Client build (no bundled database) built with dbHost:"auto": if the
//      server address settled on at first run has gone quiet, ask the LAN
//      again and follow the server to wherever it moved. A build handed a real
//      address is never touched -- someone chose that on purpose.
//
//   3. Server build whose bundled database has been opened to the LAN (a
//      pg_hba.conf line tagged mortys-lan-*, or legacy vision-/meltha-lan-*): rewrite
//      that line's subnet to the current one and reload PostgreSQL. It only
//      maintains a rule that already exists -- it never opens a database that
//      is still loopback-only.
async function refreshNetworkConfig() {
  const me = primaryLocalIPv4();
  if (!me) {
    log('net: no routable IPv4 address on this machine yet - skipping address refresh');
    return;
  }
  const cidr = networkCidr(me.address, me.netmask);
  log('net: this PC is ' + me.address + ' on "' + me.name + '" (' + (cidr || 'subnet unknown') + ')'
    + (me.pinned ? ' [pinned in machine-config.json]' : ''));
  // Name every address that lost, so a wrong choice is one line in the boot log
  // rather than an afternoon of "the till says it cannot reach the server".
  for (const c of (me.candidates || [])) {
    if (c.address === me.address) continue;
    log('net:   not using ' + c.address + ' on "' + c.name + '"'
      + (c.virtual ? ' (virtual/VPN adapter)' : ' (less LAN-like address)'));
  }

  // 1. persisted own address -------------------------------------------------
  try {
    const p = path.join(APP_DIR, 'machine-config.json');
    const mc = readJson(p, {});
    if (mc.name === undefined) mc.name = CFG.machineName || '';   // keep seedAppConfig's field
    // A pinned address is the operator overruling the ranking -- usually
    // because this machine has two real NICs, or a VPN adapter whose name
    // gives nothing away. Never write over that.
    if (mc.lan_ip_pinned === true) {
      log('net: machine-config.json lan_ip is pinned to ' + (mc.lan_ip || '(unset)') + ' - left alone');
    } else if (mc.lan_ip !== me.address) {
      const was = mc.lan_ip || '(unset)';
      mc.lan_ip = me.address;
      mc.lan_ip_checked_at = new Date().toISOString();
      writeJson(p, mc);
      log('net: machine-config.json lan_ip ' + was + ' -> ' + me.address);
    }
  } catch (e) {
    log('net: could not update machine-config.json: ' + e.message);
  }

  // 2. client re-resolve of the shop database ------------------------------
  if (!CFG.bundledPostgres && String(CFG.dbHost).toLowerCase() === 'auto') {
    try {
      const p = path.join(APP_DIR, 'db-config.json');
      const cfg = readJson(p, {});
      const local = cfg.local || {};
      const host = local.host;
      const port = parseInt(local.port, 10) || CFG.dbPort;
      if (host && host !== 'localhost' && host !== '127.0.0.1') {
        if (await tcpOpen(host, port, 2500)) {
          log('net: shop database still answering at ' + host + ':' + port + ' - unchanged');
        } else {
          log('net: shop database at ' + host + ':' + port + ' not answering - asking the LAN again');
          const server = await discoverServer(5000);
          if (server && server.host && server.host !== host) {
            cfg.local = Object.assign({}, local, { host: server.host });
            writeJson(p, cfg);
            log('net: db-config.json host ' + host + ' -> ' + server.host + ' ("' + server.name + '")');
          } else if (server && server.host === host) {
            log('net: LAN still names ' + host + ' - that server is down, not moved; leaving it');
          } else {
            log('net: nothing answered discovery - leaving ' + host + ' in place');
          }
        }
      }
    } catch (e) {
      log('net: client re-resolve failed: ' + e.message);
    }
  }

  // 3. bundled database LAN allow-list ------------------------------------
  if (CFG.bundledPostgres && pgInitialised() && cidr) {
    try {
      const hbaPath = path.join(PGDATA_DIR, 'pg_hba.conf');
      if (fs.existsSync(hbaPath)) {
        const lines = fs.readFileSync(hbaPath, 'utf8').split(/\r?\n/);
        let changed = false;
        const next = lines.map((ln) => {
          if (!/(?:mortys|vision|meltha)-lan-(test|auto)/.test(ln)) return ln;
          // Only the address/CIDR column is rewritten; the connection type
          // (host / hostssl), database, user and auth method the opener chose
          // are left exactly as they are.
          const upd = ln.replace(/\b\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}\b/, cidr);
          if (upd !== ln) { changed = true; }
          return upd;
        });
        if (changed) {
          fs.writeFileSync(hbaPath, next.join('\n'));
          log('net: pg_hba.conf LAN rule subnet -> ' + cidr);
          if (await tcpOpen('127.0.0.1', CFG.pgPort, 800)) {
            const r = pgCtl(['-D', PGDATA_DIR, 'reload']);
            log('net: pg_ctl reload exit=' + r.status);
          } else {
            log('net: database not running - the new subnet takes effect on its next start');
          }
        }
      }
    } catch (e) {
      log('net: could not refresh the database LAN rule: ' + e.message);
    }
  }
}

// ------------------------------------------------------- bundled Postgres --
function hasBundledPostgres() {
  return fs.existsSync(path.join(PG_BIN, 'pg_ctl.exe'));
}

function pgInitialised() {
  return fs.existsSync(path.join(PGDATA_DIR, 'PG_VERSION'));
}

// initdb needs the superuser password on disk for a moment. Written into the
// data dir (not %TEMP%) and deleted immediately, so it never outlives the call
// and never lands somewhere world-readable that we don't control.
function initPostgres() {
  log('initdb: creating ' + PGDATA_DIR);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const pwFile = path.join(DATA_DIR, '.pginit');
  fs.writeFileSync(pwFile, CFG.pgPassword, { mode: 0o600 });
  try {
    const r = spawnSync(path.join(PG_BIN, 'initdb.exe'), [
      '-D', PGDATA_DIR,
      '-U', CFG.pgUser,
      '--pwfile=' + pwFile,
      '-E', 'UTF8',
      '--auth-host=scram-sha-256',
      '--auth-local=trust',
    ], { windowsHide: true, encoding: 'utf8' });
    log('initdb exit=' + r.status + ' ' + String(r.stderr || '').trim().slice(-400));
    if (r.status !== 0) return false;
  } finally {
    try { fs.unlinkSync(pwFile); } catch (_) {}
  }

  // Bind the bundled server to loopback only. The Morty's Auto Parts app
  // server is what the rest of the LAN talks to (port 3057); nothing outside this PC
  // has any business opening a raw Postgres connection, and leaving 5433 open
  // on a shop network would be handing out the whole database.
  const confPath = path.join(PGDATA_DIR, 'postgresql.conf');
  try {
    let conf = fs.readFileSync(confPath, 'utf8');
    conf += [
      '',
      '# --- Morty\'s Auto Parts portable overrides ---',
      "listen_addresses = 'localhost'",
      'port = ' + CFG.pgPort,
      'max_connections = 50',
      'logging_collector = off',
      '',
    ].join('\n');
    fs.writeFileSync(confPath, conf);
  } catch (e) {
    log('initdb: could not append portable overrides: ' + e.message);
  }
  return true;
}

function pgCtl(args, opts) {
  return spawnSync(path.join(PG_BIN, 'pg_ctl.exe'), args, Object.assign({
    windowsHide: true,
    encoding: 'utf8',
    env: Object.assign({}, process.env, { PGPASSWORD: CFG.pgPassword }),
  }, opts || {}));
}

// PostgreSQL keeps several working directories that are normally empty, and it
// refuses to start if any of them is missing -- "FATAL: could not open
// directory \"pg_notify\"" and nothing else to go on.
//
// They go missing whenever the data directory travels through something that
// stores files rather than a tree. A ZIP has no concept of an empty folder
// unless one is written explicitly, and plenty of tools do not bother; this
// package's own zip step did not either, so every copy unpacked on a new PC
// arrived without them. The failure is quiet and misleading: Postgres does not
// start, the server starts anyway so the admin page can load, and the page
// then refuses every sign-in as though the password were wrong.
//
// Re-creating them is safe and cheap. They are working directories: Postgres
// fills them at runtime and their contents are not carried between starts.
const PG_EMPTY_DIRS = [
  'pg_commit_ts', 'pg_dynshmem', 'pg_notify', 'pg_replslot', 'pg_serial',
  'pg_snapshots', 'pg_stat', 'pg_stat_tmp', 'pg_tblspc', 'pg_twophase',
  'pg_logical', 'pg_logical/snapshots', 'pg_logical/mappings',
  'pg_wal/archive_status', 'pg_xact', 'pg_multixact/members', 'pg_multixact/offsets',
];

function repairPgDataDirs() {
  if (!fs.existsSync(path.join(PGDATA_DIR, 'PG_VERSION'))) return;   // nothing to repair yet
  const made = [];
  for (const rel of PG_EMPTY_DIRS) {
    const dir = path.join(PGDATA_DIR, rel.replace(/\//g, path.sep));
    if (!fs.existsSync(dir)) {
      try { fs.mkdirSync(dir, { recursive: true }); made.push(rel); } catch (_) {}
    }
  }
  if (made.length) {
    log('pgdata: re-created ' + made.length + ' missing working folder(s) — ' + made.join(', '));
    log('pgdata: these are dropped by zip tools that do not store empty folders; Postgres will not start without them');
  }
}

// Turns TLS on for the bundled database. Separate from initPostgres() and run
// on EVERY start, not just first init, so an install created before this
// existed picks it up on its next restart instead of staying in clear text
// forever.
//
// Idempotent by the marker line: appending the block twice would leave two
// `ssl = on` lines, which is harmless, but two ssl_cert_file lines pointing
// anywhere different would not be.
async function ensurePostgresTls() {
  const marker = '# --- Morty\'s Auto Parts TLS ---';
  const confPath = path.join(PGDATA_DIR, 'postgresql.conf');
  if (!fs.existsSync(confPath)) return false;
  try {
    const { ensureServerCert } = require(path.join(APP_DIR, 'tls-cert.js'));
    const r = await ensureServerCert(PGDATA_DIR);
    log('tls: certificate ' + (r.created ? 'generated' : 'already present') + ' (' + r.fingerprint + ')');

    let conf = fs.readFileSync(confPath, 'utf8');

    // Bare file names, not absolute paths. PostgreSQL resolves ssl_cert_file
    // against the data directory -- which is why its own commented defaults
    // read 'server.crt' -- and the certificate lives there.
    //
    // Writing the full path baked this machine's folder into a file that
    // travels with the package, so every copy carried something like
    // C:/Users/.../dist/MortysAutoParts-Admin-Portable/data/pgdata/server.crt.
    // On any other PC that path does not exist and the database refuses to
    // start outright:
    //
    //   FATAL: could not load server certificate file "...": No such process
    //
    // The web server then starts anyway so the admin page can load, and the
    // page refuses every sign-in -- which is how a wrong path in a config file
    // presents as a rejected password.
    const certLine = "ssl_cert_file = 'server.crt'";
    const keyLine  = "ssl_key_file = 'server.key'";

    if (conf.indexOf(marker) === -1) {
      conf += ['', marker, 'ssl = on', certLine, keyLine, ''].join('\n');
      fs.writeFileSync(confPath, conf);
      log('tls: enabled ssl in postgresql.conf');
    } else if (/^\s*ssl_(cert|key)_file\s*=\s*'[^']*[\/\\][^']*'/m.test(conf)) {
      // An install written by the older code, or a package copied from another
      // machine. Rewrite the two lines in place rather than appending a second
      // block, which would leave PostgreSQL reading whichever came last.
      conf = conf.replace(/^\s*ssl_cert_file\s*=.*$/m, certLine)
                 .replace(/^\s*ssl_key_file\s*=.*$/m, keyLine);
      fs.writeFileSync(confPath, conf);
      log('tls: rewrote ssl_cert_file/ssl_key_file to paths relative to this data directory');
      log('tls: they pointed at a folder from the machine this copy came from, which stops PostgreSQL starting');
    }
    return true;
  } catch (e) {
    // Never fatal. A shop with an unencrypted LAN connection still works; a
    // shop whose database will not start does not.
    log('tls: could not enable ssl (' + e.message + ') - continuing without it');
    return false;
  }
}

// Whose PostgreSQL is on our port?
//
// "Something answers on 5433" used to be read as "our database is up". It is
// not the same thing. Every portable build ships with pgPort 5433 -- the shop
// PC had nine data directories configured for it -- and whichever install
// starts first owns the port. From 8 Sep to 18 Oct 2026 this till ran against
// the copy in C:\MHsrc\mortys without anyone knowing; when that cluster crashed,
// the next boot found the port free, started this install's own months-old
// data directory instead, and the website came up with no database at all.
//
// So ask the server where its data lives. That answer is authoritative -- it
// is the very server server.js is about to connect to -- but it needs a
// sign-in. When the sign-in fails (another install's password), fall back to
// our own postmaster.pid: if the postgres that wrote it is not alive, whatever
// holds the port is not ours, whatever else it might be.
function samePath(a, b) {
  // Postgres reports C:/MHsrc/... with forward slashes and the case it was
  // started with; __dirname may say C:\mhsrc\... . Same folder, both ways.
  const norm = (p) => {
    let r = path.resolve(String(p));
    try { r = fs.realpathSync.native(r); } catch (_) {}
    return r.replace(/[\\/]+$/, '').toLowerCase();
  };
  return norm(a) === norm(b);
}

function ourPostmasterPid() {
  // postmaster.pid: line 1 is the pid, line 4 the port it listens on.
  try {
    const lines = fs.readFileSync(path.join(PGDATA_DIR, 'postmaster.pid'), 'utf8').split(/\r?\n/);
    const pid = parseInt(lines[0], 10);
    if (pid && pidAlive(pid) && parseInt(lines[3], 10) === CFG.pgPort) return pid;
  } catch (_) {}
  return 0;
}

async function pgPortOwner() {
  let dataDir = null, err = null;
  try {
    const { Client } = require(path.join(APP_DIR, 'node_modules', 'pg'));
    const c = new Client({
      host: '127.0.0.1', port: CFG.pgPort, user: CFG.pgUser,
      password: CFG.pgPassword, database: 'postgres', connectionTimeoutMillis: 5000,
    });
    try {
      await c.connect();
      dataDir = (await c.query('SHOW data_directory')).rows[0].data_directory;
    } finally { try { await c.end(); } catch (_) {} }
  } catch (e) { err = ((e && e.code) ? e.code + ' ' : '') + ((e && e.message) || '(no detail)'); }

  if (dataDir) return { ours: samePath(dataDir, PGDATA_DIR), dataDir, how: 'reported by the server' };
  const pid = ourPostmasterPid();
  return pid
    ? { ours: true, dataDir: null, how: 'could not ask it (' + err + '), but our postmaster.pid ' + pid + ' is alive' }
    : { ours: false, dataDir: null, how: 'could not ask it (' + err + ') and this install\'s postgres is not running' };
}

// Returns true when our database is up, false when it could not be started,
// and 'foreign' when another install's PostgreSQL holds the port -- see the
// caller in runSupervisor for why that one case is different.
async function startBundledPostgres() {
  if (await tcpOpen('127.0.0.1', CFG.pgPort, 800)) {
    const who = await pgPortOwner();
    if (who.ours) {
      log('postgres: already listening on ' + CFG.pgPort + ' - this install\'s data directory (' + who.how + ')');
      return true;
    }
    log('postgres: port ' + CFG.pgPort + ' is held by a DIFFERENT PostgreSQL, not this install\'s');
    log('postgres:   expected ' + PGDATA_DIR);
    log('postgres:   found    ' + (who.dataDir || 'unknown - ' + who.how));
    log('postgres: refusing to start - the till would read and write that other database. Stop the other ' +
        'install' + (who.dataDir ? ' (pg_ctl stop -D "' + who.dataDir + '")' : '') +
        ', then start Morty\'s Auto Parts again.');
    return 'foreign';
  }
  if (DB_SERVICE) {
    log('postgres: runs as the Windows service ' + DB_SERVICE + ' - asking Windows to start it');
    const r = spawnSync('sc.exe', ['start', DB_SERVICE], { windowsHide: true, encoding: 'utf8' });
    log('sc start ' + DB_SERVICE + ' exit=' + r.status);
    const up = await waitForTcp('127.0.0.1', CFG.pgPort, 60000);
    log('postgres listening=' + up);
    return up;
  }
  if (!pgInitialised() && !initPostgres()) return false;
  // Before pg_ctl start, so the setting is in place when it reads the config.
  await ensurePostgresTls();

  // stdio:'ignore' is load-bearing, not tidiness. pg_ctl start passes its own
  // stdout/stderr handles down to the postgres.exe it launches, and postgres
  // holds them open for as long as the database is up. spawnSync waits for
  // those pipes to close, not merely for pg_ctl to exit -- so with the default
  // piped stdio this call NEVER returns: the database comes up perfectly and
  // the supervisor sits blocked behind it forever, having never spawned
  // server.js. Detaching the handles lets pg_ctl's own exit be the signal.
  // The -w flag still makes pg_ctl wait for readiness, and -l already routes
  // the server's own output to data\logs\postgres.log, so nothing is lost.
  // Immediately before the start, so a data directory that arrived through a
  // zip without its empty working folders is put right rather than refusing.
  repairPgDataDirs();

  const r = pgCtl(['-D', PGDATA_DIR, '-l', path.join(LOG_DIR, 'postgres.log'), '-w', '-t', '60', 'start'],
                  { stdio: 'ignore' });
  log('pg_ctl start exit=' + r.status + (r.error ? ' error=' + r.error.message : ''));
  const up = await waitForTcp('127.0.0.1', CFG.pgPort, 30000);
  log('postgres listening=' + up);
  return up;
}

function stopBundledPostgres() {
  if (DB_SERVICE) return;   // the database service keeps running; Windows owns it
  if (!hasBundledPostgres() || !pgInitialised()) return;
  const r = pgCtl(['-D', PGDATA_DIR, '-m', 'fast', '-w', '-t', '30', 'stop']);
  log('pg_ctl stop exit=' + r.status);
}

// Creates the application database if it isn't there yet. Uses the `pg` driver
// bundled in app\node_modules, so no psql.exe or libpq on PATH is required.
//
// Retried, because "the port is open" and "the server will accept a connection"
// are not the same moment. Postgres opens its listening socket before it has
// finished starting up, and on a slow disk -- a spinning drive, a cheap USB
// stick, a PC busy with something else -- the gap between the two ran past ten
// seconds on the machine this was built on. Failing here is not cosmetic: if
// CREATE DATABASE never runs, server.js then connects to a database that does
// not exist and every page comes up empty.
async function ensureDatabaseWithRetry(conn, attempts) {
  for (let i = 1; i <= attempts; i++) {
    if (await ensureDatabase(conn)) return true;
    if (i < attempts) {
      log('ensureDatabase: retry ' + i + '/' + (attempts - 1) + ' in 4s');
      await sleep(4000);
    }
  }
  return false;
}

async function ensureDatabase(conn) {
  let Client;
  try { ({ Client } = require(path.join(APP_DIR, 'node_modules', 'pg'))); }
  catch (e) { log('ensureDatabase: pg driver unavailable: ' + e.message); return false; }

  const admin = new Client({
    host: conn.host, port: conn.port, user: conn.user,
    password: conn.password, database: 'postgres',
    connectionTimeoutMillis: 20000,
  });
  try {
    await admin.connect();
    const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [conn.database]);
    if (!rows.length) {
      // Identifier can't be parameterised; conn.database comes from our own
      // config file, and the quote-doubling keeps a stray quote harmless.
      await admin.query('CREATE DATABASE "' + String(conn.database).replace(/"/g, '""') + '"');
      log('ensureDatabase: created database ' + conn.database);
    } else {
      log('ensureDatabase: database ' + conn.database + ' present');
    }
    return true;
  } catch (e) {
    // The driver's ECONNREFUSED / 28P01 errors often carry an empty .message,
    // so lead with the code -- "ensureDatabase failed:" on its own tells the
    // person reading this log nothing at all.
    log('ensureDatabase failed: ' + (e.code || '') + ' ' + (e.message || '(no detail)'));
    return false;
  } finally {
    try { await admin.end(); } catch (_) {}
  }
}

// ------------------------------------------------------------- discovery --
// server.js already speaks a tiny UDP protocol on port 41235: it broadcasts
// MELTHAHONDA_ANNOUNCE every few seconds and answers MELTHAHONDA_DISCOVER
// queries with the same payload. That exists so Admin -> Setup can list the
// machines on the LAN, and it costs nothing to reuse here: a new till can find
// the shop's server by asking the network instead of by someone reading an IP
// address off the back of the counter PC.
//
// What we get back is the address of the APP server. The database it uses is
// on that same machine, at whatever port/user/password this build was
// configured with -- discovery answers "which machine", not "which password".
//
// Broadcast is LAN-only by design (routers don't forward it), and everything
// here is best-effort: a network that blocks broadcast just means we fall back
// to the configured address.
function discoverServer(timeoutMs) {
  return new Promise((resolve) => {
    let sock;
    const found = [];
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      try { sock.close(); } catch (_) {}
      // Prefer a machine that actually has the database, not just any peer
      // running the app -- another till in client mode would answer too, and
      // pointing at it would be a dead end.
      found.sort((a, b) => (b.db_exists - a.db_exists) || (b.has_local_db - a.has_local_db));
      resolve(found[0] || null);
    };

    try {
      sock = require('dgram').createSocket({ type: 'udp4', reuseAddr: true });
    } catch (e) {
      log('discovery: could not open socket: ' + e.message);
      return resolve(null);
    }

    sock.on('error', (e) => { log('discovery: ' + e.message); finish(); });
    sock.on('message', (msg) => {
      let data;
      try { data = JSON.parse(msg.toString()); } catch (_) { return; }
      if (!data || data.type !== 'MELTHAHONDA_ANNOUNCE' || !data.host) return;
      if (found.some((f) => f.host === data.host)) return;
      found.push({
        host: data.host, port: data.port, name: data.name || data.host,
        has_local_db: data.has_local_db ? 1 : 0, db_exists: data.db_exists ? 1 : 0,
      });
      log('discovery: found "' + (data.name || data.host) + '" at ' + data.host +
          ':' + data.port + ' (has_db=' + !!data.has_local_db + ')');
    });

    // Bind to an ephemeral port, not 41235 -- if this machine ever also runs a
    // server, that port is already taken and binding would fail.
    sock.bind(0, () => {
      try {
        sock.setBroadcast(true);
        const query = Buffer.from(JSON.stringify({
          type: 'MELTHAHONDA_DISCOVER', instanceId: 'portable-boot-' + process.pid,
        }));
        sock.send(query, 41235, '255.255.255.255');
      } catch (e) {
        log('discovery: send failed: ' + e.message);
        return finish();
      }
    });

    setTimeout(finish, timeoutMs || 4000);
  });
}

// -------------------------------------------------------- seed app config --
// Only ever fills in a MISSING file. Admin -> Setup writes these same files at
// runtime; clobbering them on every launch would silently undo the operator's
// own database change every time the machine rebooted.
async function seedAppConfig() {
  const dbCfgPath = path.join(APP_DIR, 'db-config.json');
  if (!fs.existsSync(dbCfgPath)) {
    let local;
    if (CFG.bundledPostgres) {
      local = { host: '127.0.0.1', port: CFG.pgPort, database: CFG.database, user: CFG.pgUser, password: CFG.pgPassword };
    } else {
      let host = CFG.dbHost;
      // "auto" means the person who built this package did not know which PC
      // would be the server. Ask the LAN once, on first run only; whatever we
      // settle on is written to db-config.json and never re-derived, so the
      // till doesn't wander to a different machine later.
      if (!host || String(host).toLowerCase() === 'auto') {
        log('discovery: looking for a Morty\'s Auto Parts server on the network...');
        const server = await discoverServer(5000);
        if (server) {
          host = server.host;
          log('discovery: using "' + server.name + '" at ' + host);
        } else {
          host = 'localhost';
          log('discovery: nothing answered - falling back to localhost. ' +
              'Run "Morty\'s Auto Parts Settings.vbs" to set the server address by hand.');
        }
      }
      local = { host, port: CFG.dbPort, database: CFG.database, user: CFG.dbUser, password: CFG.dbPassword };
    }
    writeJson(dbCfgPath, { local, online: null });
    log('seeded db-config.json -> ' + local.host + ':' + local.port + '/' + local.database);
  }

  const srvCfgPath = path.join(APP_DIR, 'server-config.json');
  if (!fs.existsSync(srvCfgPath)) writeJson(srvCfgPath, { port: CFG.appPort });

  const machinePath = path.join(APP_DIR, 'machine-config.json');
  if (!fs.existsSync(machinePath)) writeJson(machinePath, { name: CFG.machineName || '' });
}

function effectivePort() {
  const srv = readJson(path.join(APP_DIR, 'server-config.json'), {});
  return parseInt(srv.port, 10) || CFG.appPort;
}

// ------------------------------------------------------------- supervision --
let child = null;
let stopping = false;

function startServer(port) {
  rotateIfBig(SERVER_LOG);
  const out = fs.openSync(SERVER_LOG, 'a');
  child = spawn(process.execPath, [path.join(APP_DIR, 'server.js')], {
    cwd: APP_DIR,
    windowsHide: true,           // belt-and-braces; the .vbs already hid us
    stdio: ['ignore', out, out],
    env: Object.assign({}, process.env, { PORT: String(port) }),
  });
  log('server.js spawned pid=' + child.pid + ' port=' + port);
  return child;
}

async function runSupervisor() {
  const existing = runningInstance();
  if (existing) {
    log('already running (pid ' + existing.pid + ', port ' + existing.port + ') - exiting');
    process.exit(0);
  }

  rotateIfBig(BOOT_LOG);
  log('--- boot: ' + os.hostname() + ' node ' + process.version + ' ---');

  if (CFG.bundledPostgres && hasBundledPostgres()) {
    // 'foreign' is the one start result that must not fall through to
    // server.js. Every other failure leaves the database down and the admin
    // page up, which is the right way round. This one leaves a database UP --
    // somebody else's -- and server.js would connect to it and write into it.
    // Exiting before the lock is written, so the next start is not refused.
    if (await startBundledPostgres() === 'foreign') process.exit(1);
  }

  await seedAppConfig();

  // After seedAppConfig (so db-config.json exists to be re-pointed) and before
  // the reachability probe below (so a client that followed the server to a new
  // address probes the right one). Best-effort; never throws.
  await refreshNetworkConfig();

  // Create the database before server.js first connects, so its own initDb()
  // (schema.sql + default admin seed) finds something to run against. Failure
  // here is non-fatal on purpose: server.js must still come up and serve the
  // admin page so the operator can point it somewhere else from Setup.
  const dbCfg = readJson(path.join(APP_DIR, 'db-config.json'), {}).local || {};
  if (dbCfg.host) {
    const dbHost = dbCfg.host;
    const dbPort = parseInt(dbCfg.port, 10) || 5432;
    // Knock on the port first. Handing an unreachable address straight to the
    // pg driver costs ~30 seconds of retries before it gives up -- half a
    // minute of the launcher's "starting..." wait spent on a question a 2s TCP
    // probe answers. It also turns a useless empty driver error into a log
    // line that names the actual problem and the file that fixes it.
    if (await tcpOpen(dbHost, dbPort, 2000)) {
      await ensureDatabaseWithRetry({
        host: dbHost, port: dbPort,
        user: dbCfg.user, password: dbCfg.password, database: dbCfg.database || CFG.database,
      }, 4);
    } else {
      log('database server not reachable at ' + dbHost + ':' + dbPort +
          ' - starting anyway so the admin page loads. Fix the address with ' +
          '"Morty\'s Auto Parts Settings.vbs", or start PostgreSQL on that machine.');
    }
  }

  const port = effectivePort();
  writeJson(LOCK_FILE, {
    pid: process.pid, port, host: os.hostname(),
    bundledPostgres: !!(CFG.bundledPostgres && hasBundledPostgres()),
    startedAt: new Date().toISOString(),
  });

  let restarts = 0;
  const loop = () => {
    if (stopping) return;
    const c = startServer(port);
    c.on('exit', (code, signal) => {
      if (stopping) return;
      restarts += 1;
      const delay = Math.min(30000, 1000 * Math.pow(2, Math.min(restarts, 5)));
      log('server.js exited code=' + code + ' signal=' + signal +
          ' - restart #' + restarts + ' in ' + delay + 'ms');
      setTimeout(loop, delay);
    });
  };
  loop();

  // Reset the backoff once we've been healthy for a while, so a crash next
  // month doesn't inherit a 30-second penalty from one at install time.
  setInterval(async () => {
    if (await httpOk(port, '/api/health', 2000)) restarts = 0;
  }, 60000).unref();

  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    log('shutting down');
    try { if (child && child.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch (_) {}
    if (CFG.bundledPostgres && hasBundledPostgres()) stopBundledPostgres();
    clearLock();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGBREAK', shutdown);
}

// ------------------------------------------------------------------- stop --
function doStop() {
  const lock = readLock();
  if (!lock) { console.log('not running'); return; }
  if (pidAlive(lock.pid)) {
    log('stop requested for pid ' + lock.pid);
    spawnSync('taskkill', ['/PID', String(lock.pid), '/T', '/F'], { windowsHide: true });
  }
  // taskkill /F gives the supervisor no chance to run its own shutdown hook,
  // so stop the bundled Postgres from here instead of relying on it.
  if (lock.bundledPostgres && hasBundledPostgres()) stopBundledPostgres();
  clearLock();
  console.log('stopped');
}

// ----------------------------------------------------------------- status --
async function doStatus() {
  const lock = runningInstance();
  const port = lock ? lock.port : effectivePort();
  const healthy = await httpOk(port, '/api/health', 2000);
  // Who owns the database port, so "healthy but talking to the wrong database"
  // shows up here and not only as missing data on the website.
  let postgres = 'not bundled';
  if (CFG.bundledPostgres && hasBundledPostgres()) {
    if (!(await tcpOpen('127.0.0.1', CFG.pgPort, 800))) postgres = 'not running';
    else {
      const who = await pgPortOwner();
      postgres = who.ours ? 'ours' : 'FOREIGN: ' + (who.dataDir || who.how);
    }
  }
  console.log(JSON.stringify({ running: !!lock, pid: lock ? lock.pid : null, port, healthy, postgres }));
}

// ------------------------------------------------------------------- main --
const arg = (process.argv[2] || '').toLowerCase();
if (arg === '--stop') doStop();
else if (arg === '--status') doStatus();
else if (arg === '--refresh-ip') {
  // Re-derive every IP-bearing config file from this machine's current adapter,
  // without starting anything. Install.ps1 runs this once at install time; the
  // supervisor then does the same on every start. Prints one line so the
  // installer has something to show.
  refreshNetworkConfig()
    .then(() => {
      const mc = readJson(path.join(APP_DIR, 'machine-config.json'), {});
      console.log('lan_ip = ' + (mc.lan_ip || '(none detected)'));
      process.exit(0);
    })
    .catch((e) => { log('FATAL --refresh-ip: ' + (e && e.stack || e)); process.exit(1); });
}
else {
  runSupervisor().catch((e) => {
    log('FATAL: ' + (e && e.stack || e));
    clearLock();
    process.exit(1);
  });
}
