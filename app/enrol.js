// ============================================================================
//  enrol.js — redeem a connection link on a client machine.
//
//  Run by "Connect To Shop Server.vbs", or by hand:
//      runtime\node.exe app\enrol.js "http://192.168.1.20:3040/join#ABCD..."
//      runtime\node.exe app\enrol.js 192.168.1.20 ABCD-EFGH-...
//
//  What it does: asks the server to trade a one-time token for the database
//  settings, then writes app\db-config.json so this machine can start.
//
//  The token is the only secret involved and it dies on first use, so the
//  worst a leaked link can do is let one machine enrol once -- and the server
//  records which uid and IP claimed it. Compare with the old way, which was to
//  read the Postgres password down the phone and have it typed into every till
//  where it then sat in plain text forever.
// ============================================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const APP_DIR = __dirname;
const DB_CONFIG_PATH = path.join(APP_DIR, 'db-config.json');
const SERVER_CONFIG_PATH = path.join(APP_DIR, 'server-config.json');
const MACHINE_CONFIG_PATH = path.join(APP_DIR, 'machine-config.json');
const TERMINAL_ID_PATH = path.join(APP_DIR, 'terminal-id.json');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); }
  catch (_) { return fallback; }
}
function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}
function fail(msg) { console.error('ERROR: ' + msg); process.exit(1); }

// Same identity server.js registers under, created here if this machine has
// never started yet -- so enrolling and then booting is one terminal, not two.
function terminalUid() {
  const j = readJson(TERMINAL_ID_PATH, null);
  if (j && j.uid) return String(j.uid);
  const crypto = require('crypto');
  const uid = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
  writeJson(TERMINAL_ID_PATH, { uid, created_at: new Date().toISOString() });
  return uid;
}

// Accepts the whole link, or an address and a code typed separately. The code
// is normalised the same way the server hashes it, so the dashes people
// naturally type back in do not matter.
function parseArgs(argv) {
  const a = argv.filter(Boolean);
  if (!a.length) return null;
  if (/^https?:\/\//i.test(a[0])) {
    let u;
    try { u = new URL(a[0]); } catch (_) { return null; }
    const token = (u.hash || '').replace(/^#/, '').trim();
    if (!token) return null;
    return { host: u.hostname, port: parseInt(u.port, 10) || 80, token };
  }
  if (a.length < 2) return null;
  return { host: a[0].replace(/^.*:\/\//, '').split('/')[0].split(':')[0], port: parseInt(a[2], 10) || 3040, token: a[1] };
}

function post(host, port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request(
      { host, port, path: urlPath, method: 'POST', timeout: 15000,
        headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length } },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let j = null;
          try { j = JSON.parse(data); } catch (_) {}
          if (!j) return reject(new Error('The server did not answer with a valid response (HTTP ' + res.statusCode + ').'));
          if (res.statusCode !== 200 || !j.ok) return reject(new Error(j.error || ('HTTP ' + res.statusCode)));
          resolve(j);
        });
      }
    );
    req.on('timeout', () => { req.destroy(new Error('The server did not answer in time.')); });
    req.on('error', reject);
    req.end(payload);
  });
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error('Usage: node enrol.js "http://<server>:<port>/join#<code>"');
    console.error('   or: node enrol.js <server-address> <code> [port]');
    process.exit(2);
  }

  const machine = readJson(MACHINE_CONFIG_PATH, {});
  const name = (machine.name && machine.name.trim()) || os.hostname();
  const uid = terminalUid();

  console.log('Connecting to ' + args.host + ':' + args.port + ' as "' + name + '"...');
  let r;
  try {
    r = await post(args.host, args.port, '/api/enrol/redeem', { token: args.token, uid, name });
  } catch (e) {
    fail(e.message);
  }

  const d = r.database || {};
  if (!d.host) fail('The server did not send any database settings.');

  // Preserve any existing "online" fallback rather than dropping it, and never
  // touch a machine-config the operator has already named.
  const existing = readJson(DB_CONFIG_PATH, {});
  writeJson(DB_CONFIG_PATH, {
    local: {
      host: d.host, port: d.port, database: d.database, user: d.user, password: d.password,
      // Pinning the server's certificate is what makes the encryption worth
      // having: without it the till would accept any certificate offered and
      // an impostor on the same wifi could sit in the middle.
      sslmode: d.sslmode || 'disable',
      ca: d.ca || null,
    },
    online: existing.online || null,
    // Password checks go here: this machine is no longer allowed to read
    // password hashes out of the database, which is the point.
    upstream: r.upstream || null,
  });
  if (!fs.existsSync(SERVER_CONFIG_PATH)) writeJson(SERVER_CONFIG_PATH, { port: r.app_port || 3040 });
  if (!fs.existsSync(MACHINE_CONFIG_PATH)) writeJson(MACHINE_CONFIG_PATH, { name: '' });

  console.log('');
  console.log('Connected. This computer is registered as "' + (r.name || name) + '" and allowed.');
  console.log('  Database : ' + d.user + '@' + d.host + ':' + d.port + '/' + d.database);
  console.log('  Account  : ' + (r.scoped ? 'its own limited login for this machine' : 'the shared database account (no per-machine login available)'));
  console.log('  Encrypted: ' + (d.ca ? 'yes, and this server\'s certificate is pinned' : 'NO - the connection will be in clear text on the network'));
  console.log('  Written  : ' + DB_CONFIG_PATH);
  console.log('');
  console.log('Start it with "Meltha Honda Admin.exe".');
  process.exit(0);
})();
