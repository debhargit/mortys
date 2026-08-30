// ensure-pg.js
//
// Brings up the *bundled* PostgreSQL that ships in vendor\, for a machine that
// has no PostgreSQL installed at all -- a fresh Windows box with nothing on it
// but a copy of this folder. start-melthahonda.bat calls this only after it has
// already failed to reach a real server and failed to find a Windows service,
// so getting here means "there is no other database on this PC".
//
// What it does, in order:
//   1. extract vendor\pgsql.zip -> vendor\pgsql\ (first run only)
//   2. initdb -> data\pgdata    (first run only)
//   3. pg_ctl start on port 5433
//   4. create the application database, by handing off to ensure-db.js
//   5. point db-config.json at the bundled cluster so server.js finds it
//
// Port 5433, not 5432, on purpose: if someone later installs a real PostgreSQL
// on this machine it takes 5432, and a bundled cluster squatting on that port
// would break the install in a way nobody would connect back to this script.
//
// The logic here is a trimmed copy of portable\app\boot.js, which does the same
// job inside the portable packages. Kept separate rather than shared because
// boot.js is also the portable supervisor -- it launches and babysits
// server.js, which is the batch file's job here.
//
//   node ensure-pg.js          bring the cluster up
//   node ensure-pg.js --stop   shut it down again

'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const VENDOR = path.join(ROOT, 'vendor');
const PG_ZIP = path.join(VENDOR, 'pgsql.zip');
const PG_DIR = path.join(VENDOR, 'pgsql');
const PG_BIN = path.join(PG_DIR, 'bin');
const DATA_DIR = path.join(ROOT, 'data');
const PGDATA = path.join(DATA_DIR, 'pgdata');
const LOG_DIR = path.join(DATA_DIR, 'logs');

const PG_PORT = parseInt(process.env.MH_PG_PORT || '5433', 10);
const PG_USER = process.env.MH_PG_USER || 'postgres';
const PG_PASS = process.env.MH_PG_PASSWORD || 'postgres';
const PG_DB = process.env.PGDATABASE || 'melthahonda';

function log(msg) {
  console.log('       ' + msg);
}

// \\?\C:\dir for a local path, \\?\UNC\server\share for a network one. The
// prefix lifts the 260-character MAX_PATH limit, and only accepts backslashes
// -- forward slashes are not normalised inside it. Same helper as
// ensure-deps.js; duplicated rather than shared because each of these scripts
// has to be runnable on its own, before node_modules necessarily exists.
function longPath(p) {
  if (p.startsWith('\\\\?\\')) return p;
  if (p.startsWith('\\\\')) return '\\\\?\\UNC\\' + p.slice(2);
  return '\\\\?\\' + p;
}

function tcpOpen(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const finish = (v) => { if (!done) { done = true; s.destroy(); resolve(v); } };
    s.setTimeout(timeoutMs || 1000);
    s.once('connect', () => finish(true));
    s.once('timeout', () => finish(false));
    s.once('error', () => finish(false));
    s.connect(port, host);
  });
}

async function waitForTcp(host, port, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await tcpOpen(host, port, 1000)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// ---------------------------------------------------------------- extraction --
// The archive holds ~20,000 entries and almost all of them are pgAdmin 4, the
// documentation and debug symbols -- none of which a running server needs.
// Pulling only bin, lib and share turns an hour-long unpack into a short one.
// (build-portable.ps1 learned this the hard way; same filter, same reason.)
//
// Shelled out to PowerShell because Node has no zip reader in its standard
// library, and the one dependency that could do it is not guaranteed to be
// installed at the moment this runs -- on a fresh machine node_modules may
// still be being unpacked. PowerShell and .NET are on every Windows install.
function extractPostgres() {
  if (fs.existsSync(path.join(PG_BIN, 'pg_ctl.exe'))) return true;
  if (!fs.existsSync(PG_ZIP)) {
    console.error('       ERROR: no PostgreSQL installed and vendor\\pgsql.zip is missing.');
    console.error('       Restore it from dist\\pgsql-16.4-1.zip, or install PostgreSQL.');
    return false;
  }

  log('first run: extracting bundled PostgreSQL (this takes a minute)...');
  fs.mkdirSync(PG_DIR, { recursive: true });

  // Written to a file rather than passed with -Command: the paths and the
  // quoting get unreadable inline, and a script file is also what we would
  // want to look at if this ever failed on a customer machine.
  const ps = path.join(os.tmpdir(), 'mh-extract-pg-' + process.pid + '.ps1');
  fs.writeFileSync(ps, [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    "$zip = [System.IO.Compression.ZipFile]::OpenRead('" + PG_ZIP + "')",
    // Same \\?\ prefix as ensure-deps.js, for the same reason: these paths are
    // shorter than the node_modules ones, but a project folder deep enough to
    // break them would fail here in the same silent, partial way.
    "$prefix = '" + longPath(PG_DIR) + "\\'",
    "$wanted = @('pgsql/bin/','pgsql/lib/','pgsql/share/')",
    "$ic = [System.StringComparison]::OrdinalIgnoreCase",
    "$n = 0",
    "try {",
    "  foreach ($e in $zip.Entries) {",
    "    if ($e.FullName.EndsWith('/')) { continue }",
    "    $keep = $false",
    "    foreach ($w in $wanted) { if ($e.FullName.StartsWith($w, $ic)) { $keep = $true; break } }",
    "    if (-not $keep) { continue }",
    // Substring(6) strips the archive's leading "pgsql/". [char]47/[char]92
    // rather than quoted separators -- and note the old form here was
    // `-replace '/', '\\'`, which emits TWO backslashes, because -replace
    // takes a .NET replacement string. Windows tolerated the doubled
    // separator, so it went unnoticed.
    "    $dest = $prefix + $e.FullName.Substring(6).Replace([char]47, [char]92)",
    "    $dir = $dest.Substring(0, $dest.LastIndexOf([char]92))",
    "    [void][System.IO.Directory]::CreateDirectory($dir)",
    "    [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, $dest, $true)",
    "    $n++",
    "  }",
    "} finally { $zip.Dispose() }",
    "Write-Output ('extracted ' + $n + ' files')",
  ].join('\r\n'));

  try {
    const r = spawnSync('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps],
      { windowsHide: true, encoding: 'utf8' });
    if (r.status !== 0) {
      console.error('       ERROR: extracting pgsql.zip failed -- ' +
                    String(r.stderr || r.stdout || '').trim().slice(-400));
      return false;
    }
    log(String(r.stdout || '').trim());
  } finally {
    try { fs.unlinkSync(ps); } catch (_) {}
  }

  if (!fs.existsSync(path.join(PG_BIN, 'pg_ctl.exe'))) {
    console.error('       ERROR: vendor\\pgsql.zip does not contain bin\\pg_ctl.exe.');
    return false;
  }
  return true;
}

// -------------------------------------------------------------------- initdb --
function pgInitialised() {
  return fs.existsSync(path.join(PGDATA, 'PG_VERSION'));
}

// initdb needs the superuser password on disk for a moment. Written into the
// data dir (not %TEMP%) and deleted immediately, so it never outlives the call
// and never lands somewhere world-readable that we don't control.
function initPostgres() {
  log('first run: creating the database cluster in data\\pgdata...');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const pwFile = path.join(DATA_DIR, '.pginit');
  fs.writeFileSync(pwFile, PG_PASS, { mode: 0o600 });
  try {
    const r = spawnSync(path.join(PG_BIN, 'initdb.exe'), [
      '-D', PGDATA,
      '-U', PG_USER,
      '--pwfile=' + pwFile,
      '-E', 'UTF8',
      '--auth-host=scram-sha-256',
      '--auth-local=trust',
    ], { windowsHide: true, encoding: 'utf8' });
    if (r.status !== 0) {
      console.error('       ERROR: initdb failed -- ' + String(r.stderr || '').trim().slice(-400));
      return false;
    }
  } finally {
    try { fs.unlinkSync(pwFile); } catch (_) {}
  }

  // Loopback only. Nothing outside this PC has any business opening a raw
  // Postgres connection -- the app server on 3040 is what the LAN talks to --
  // and leaving 5433 open on a shop network would be handing out the database.
  const confPath = path.join(PGDATA, 'postgresql.conf');
  try {
    fs.appendFileSync(confPath, [
      '',
      '# --- Meltha Honda bundled-database overrides ---',
      "listen_addresses = 'localhost'",
      'port = ' + PG_PORT,
      'max_connections = 50',
      'logging_collector = off',
      '',
    ].join('\n'));
  } catch (e) {
    console.error('       [warn] could not append overrides to postgresql.conf: ' + e.message);
  }
  return true;
}

function pgCtl(args, opts) {
  return spawnSync(path.join(PG_BIN, 'pg_ctl.exe'), args, Object.assign({
    windowsHide: true,
    encoding: 'utf8',
    env: Object.assign({}, process.env, { PGPASSWORD: PG_PASS }),
  }, opts || {}));
}

// --------------------------------------------------------------- db-config ----
// server.js reads db-config.json before it falls back to DATABASE_URL, so this
// is the setting that actually decides where the app connects. Only the `local`
// key is touched: `online` and anything enrolment wrote stay exactly as they
// were.
function pointConfigAtBundled() {
  const p = path.join(ROOT, 'db-config.json');
  let cfg = {};
  try {
    const raw = fs.readFileSync(p, 'utf8');
    cfg = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
  } catch (_) { cfg = {}; }

  const local = { host: '127.0.0.1', port: PG_PORT, database: PG_DB, user: PG_USER, password: PG_PASS };
  if (JSON.stringify(cfg.local) === JSON.stringify(local)) return;
  cfg.local = local;
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
  log('db-config.json now points at the bundled database on port ' + PG_PORT);
}

// --------------------------------------------------------------------- main ---
async function stop() {
  if (!fs.existsSync(path.join(PG_BIN, 'pg_ctl.exe')) || !pgInitialised()) {
    log('no bundled database to stop');
    return 0;
  }
  const r = pgCtl(['-D', PGDATA, '-m', 'fast', '-w', '-t', '30', 'stop']);
  log('bundled database stopped (pg_ctl exit=' + r.status + ')');
  return 0;
}

async function start() {
  if (await tcpOpen('127.0.0.1', PG_PORT, 800)) {
    log('bundled database already running on port ' + PG_PORT);
    pointConfigAtBundled();
    return 0;
  }
  if (!extractPostgres()) return 1;
  if (!pgInitialised() && !initPostgres()) return 1;

  fs.mkdirSync(LOG_DIR, { recursive: true });

  // stdio:'ignore' is load-bearing, not tidiness. pg_ctl start passes its own
  // stdout/stderr handles down to the postgres.exe it launches, and postgres
  // holds them open for as long as the database is up. spawnSync waits for
  // those pipes to close, not merely for pg_ctl to exit -- so with the default
  // piped stdio this call NEVER returns: the database comes up perfectly and
  // this script hangs behind it forever. Detaching the handles lets pg_ctl's
  // own exit be the signal. -w still waits for readiness and -l still routes
  // the server's output to data\logs\postgres.log, so nothing is lost.
  const r = pgCtl(['-D', PGDATA, '-l', path.join(LOG_DIR, 'postgres.log'),
                   '-w', '-t', '60', 'start'], { stdio: 'ignore' });
  if (!(await waitForTcp('127.0.0.1', PG_PORT, 30000))) {
    console.error('       ERROR: the bundled database did not start (pg_ctl exit=' + r.status + ').');
    console.error('       See data\\logs\\postgres.log for the reason.');
    return 1;
  }
  log('bundled database listening on 127.0.0.1:' + PG_PORT);

  // Hand off to ensure-db.js rather than repeating CREATE DATABASE here. It
  // prefers DATABASE_URL, and dotenv does not overwrite a variable that is
  // already set, so passing it in the environment steers it at the bundled
  // cluster without touching .env on disk.
  const url = 'postgresql://' + encodeURIComponent(PG_USER) + ':' +
              encodeURIComponent(PG_PASS) + '@127.0.0.1:' + PG_PORT + '/' + PG_DB;
  const d = spawnSync(process.execPath, [path.join(ROOT, 'ensure-db.js')], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'inherit',
    env: Object.assign({}, process.env, { DATABASE_URL: url }),
  });
  if (d.status !== 0) {
    console.error('       ERROR: could not create the "' + PG_DB + '" database.');
    return 1;
  }

  pointConfigAtBundled();
  return 0;
}

const wantStop = process.argv.slice(2).some((a) => a === '--stop' || a === '-stop');
(wantStop ? stop() : start())
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error('       Unexpected error: ' + (e && e.message));
    process.exit(1);
  });
