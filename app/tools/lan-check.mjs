// Is this machine actually ready to serve the shop over the local network?
//
//   node app/tools/lan-check.mjs
//   node app/tools/lan-check.mjs --json
//
// Every check is read-only and none of them needs administrator rights, so
// this is safe to run on a live till. It reports PASS / WARN / FAIL per item
// and ends with the specific things left to do.
//
// Why a tool rather than a checklist in a README: all but one of the ways this
// deploy fails are invisible from the server itself. The admin panel works
// perfectly in a browser ON the host while every other machine times out,
// because the thing that is wrong is a firewall rule, a port that moved, or --
// the one that actually bit this install -- a server advertising a VPN address
// that no till can route to.

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import url from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const ROOT = path.resolve(APP, '..');
const JSON_OUT = process.argv.includes('--json');

const results = [];
const todo = [];
const add = (level, name, detail) => results.push({ level, name, detail });
const pass = (n, d) => add('PASS', n, d);
const warn = (n, d) => add('WARN', n, d);
const fail = (n, d) => add('FAIL', n, d);

const readJson = (p, dflt = {}) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); }
  catch { return dflt; }
};
const readEnv = (p) => {
  const out = {};
  try {
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) out[m[1]] = m[2];
    }
  } catch { /* no .env is itself reported below */ }
  return out;
};
const ps = (cmd) => {
  try {
    return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 25000 });
  } catch (e) { return (e.stdout || '') + (e.stderr || ''); }
};
const httpStatus = (host, port, pathname, timeout = 6000) => new Promise((resolve) => {
  const req = http.get({ host, port, path: pathname, timeout }, (res) => {
    res.resume();
    resolve(res.statusCode);
  });
  req.on('timeout', () => { req.destroy(); resolve(0); });
  req.on('error', () => resolve(0));
});
const tcpOpen = (host, port, timeout = 4000) => new Promise((resolve) => {
  const s = net.connect({ host, port });
  const done = (v) => { s.destroy(); resolve(v); };
  s.setTimeout(timeout);
  s.on('connect', () => done(true));
  s.on('timeout', () => done(false));
  s.on('error', () => done(false));
});

// ---------------------------------------------------------------- 1. address
const { lanAddressDetail } = await import(url.pathToFileURL(path.join(APP, 'lan-address.js')).href);
const me = lanAddressDetail(APP);
const mc = readJson(path.join(APP, 'machine-config.json'));

if (!me) {
  fail('LAN address', 'this machine has no usable IPv4 address - is it on the network?');
  todo.push('Connect this PC to the shop network, then run this check again.');
} else {
  const others = (me.candidates || []).filter((c) => c.address !== me.address);
  pass('LAN address', `${me.address} on "${me.name}"${me.cidr ? ' (' + me.cidr + ')' : ''}`
    + (me.pinned ? ' [pinned]' : ''));
  if (others.length) {
    const virt = others.filter((c) => c.virtual).length;
    warn('Other adapters present',
      `${others.length} other address(es)${virt ? ', ' + virt + ' virtual/VPN' : ''}: `
      + others.map((c) => c.address + ' (' + c.name + ')').join(', '));
    todo.push(`Confirm ${me.address} is the address the tills can reach. If not, set `
      + `"lan_ip": "<right one>" and "lan_ip_pinned": true in app/machine-config.json.`);
  }
  if (mc.lan_ip && mc.lan_ip !== me.address) {
    fail('machine-config.json agrees', `file says ${mc.lan_ip}, this machine is ${me.address}`);
    todo.push('Run: node app/boot.js --refresh-ip   (rewrites machine-config.json)');
  } else if (mc.lan_ip) {
    pass('machine-config.json agrees', `lan_ip = ${mc.lan_ip}`);
  } else {
    warn('machine-config.json agrees', 'lan_ip is not recorded yet');
    todo.push('Run: node app/boot.js --refresh-ip');
  }
}

// ---------------------------------------------------------------- 2. port
const srvCfg = readJson(path.join(APP, 'server-config.json'));
const env = readEnv(path.join(APP, '.env'));
const portable = readJson(path.join(APP, 'portable.json'));
// server.js: SERVER_CFG.port || process.env.PORT || 3057
const PORT = parseInt(srvCfg.port || env.PORT || '3057', 10);
pass('Server port', `${PORT} (server-config.json${srvCfg.port ? '' : ' absent, from .env/default'})`);

const envPort = env.PORT ? parseInt(env.PORT, 10) : null;
if (envPort && srvCfg.port && envPort !== parseInt(srvCfg.port, 10)) {
  warn('Port config agrees', `.env PORT=${envPort} but server-config.json port=${srvCfg.port};`
    + ` server-config.json wins, so .env is misleading`);
  todo.push(`Set PORT=${srvCfg.port} in app/.env so both files say the same thing.`);
} else {
  pass('Port config agrees', 'server-config.json and .env do not disagree');
}
if (portable.appPort && parseInt(portable.appPort, 10) !== PORT) {
  warn('portable.json appPort', `says ${portable.appPort}, server runs on ${PORT}`
    + ' (Allow Network Access.vbs falls back to this only if server-config.json is unreadable)');
}

// ---------------------------------------------------------------- 3. running
const listen = ps(`Get-NetTCPConnection -State Listen -LocalPort ${PORT} -ErrorAction SilentlyContinue `
  + `| Select-Object -ExpandProperty LocalAddress`);
const addrs = listen.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const allIfaces = addrs.some((a) => a === '::' || a === '0.0.0.0');
if (!addrs.length) {
  fail('Server listening', `nothing is listening on TCP ${PORT}`);
  todo.push('Start the server ("Morty\'s Auto Parts Admin" shortcut, or Start Morty\'s Auto Parts.bat).');
} else if (!allIfaces) {
  fail('Server listening', `bound only to ${addrs.join(', ')} - loopback only, no LAN client can connect`);
  todo.push('The server must listen on all interfaces (0.0.0.0 / ::), not just localhost.');
} else {
  pass('Server listening', `TCP ${PORT} on all interfaces (${addrs.join(', ')})`);
}

// ---------------------------------------------------------------- 4. firewall
const fwAdmin = ps(`netsh advfirewall firewall show rule name="Morty's Auto Parts Admin"`);
const fwDisc = ps(`netsh advfirewall firewall show rule name="Morty's Auto Parts Discovery"`);
const haveAdmin = /Enabled:\s*Yes/i.test(fwAdmin);
const haveDisc = /Enabled:\s*Yes/i.test(fwDisc);
if (haveAdmin) {
  const onPort = new RegExp(`LocalPort:\\s*${PORT}\\b`, 'i').test(fwAdmin);
  const pub = /Profiles:.*Public/i.test(fwAdmin);
  if (!onPort) {
    fail('Firewall: admin port', `rule exists but not for port ${PORT}`);
    todo.push('Re-run "Allow Network Access.vbs" - it replaces the rule with the current port.');
  } else if (pub) {
    warn('Firewall: admin port', `open on port ${PORT}, but the rule includes the Public profile`);
  } else {
    pass('Firewall: admin port', `inbound TCP ${PORT} allowed (private/domain)`);
  }
} else {
  fail('Firewall: admin port', `no enabled inbound rule - Windows Firewall will drop every LAN connection`);
  todo.push('Run "Allow Network Access.vbs" once on this PC (it asks for administrator permission).');
}
if (haveDisc) pass('Firewall: discovery', 'inbound UDP 41235 allowed');
else warn('Firewall: discovery', 'no UDP 41235 rule - tills must be given the address by hand');

// ---------------------------------------------------------------- 5. discovery
const udp = ps(`Get-NetUDPEndpoint -LocalPort 41235 -ErrorAction SilentlyContinue `
  + `| Select-Object -ExpandProperty LocalAddress`);
if (udp.trim()) pass('Discovery listener', `UDP 41235 bound (${udp.trim().split(/\r?\n/)[0]})`);
else warn('Discovery listener', 'nothing bound to UDP 41235 - "find server on the network" will not work');

// ---------------------------------------------------------------- 6. reachable
if (me && addrs.length) {
  const viaLan = await httpStatus(me.address, PORT, '/admin.html');
  if (viaLan >= 200 && viaLan < 500) {
    pass('Reachable on the LAN address', `http://${me.address}:${PORT}/admin.html -> HTTP ${viaLan}`);
  } else {
    fail('Reachable on the LAN address', `http://${me.address}:${PORT}/admin.html did not answer`);
    todo.push('The server is up but not answering on its LAN address - check the firewall rule above.');
  }
}

// ---------------------------------------------------------------- 7. secrets
if (addrs.length) {
  const host = me ? me.address : '127.0.0.1';
  const leaky = [];
  for (const f of ['db-config.json', '.env', 'server-config.json', 'machine-config.json',
    'terminal-id.json', 'portable.json', 'schema.sql', 'server.js']) {
    const code = await httpStatus(host, PORT, '/' + f);
    if (code >= 200 && code < 300) leaky.push(f);
  }
  if (leaky.length) {
    fail('Config files not served', `${leaky.join(', ')} downloadable over the LAN - these hold the DB password`);
    todo.push('Do not expose this install on the LAN until the static-file guard in server.js is fixed.');
  } else {
    pass('Config files not served', 'db-config.json, .env and friends all refused');
  }
}

// ---------------------------------------------------------------- 8. postgres
const dbCfg = (readJson(path.join(APP, 'db-config.json')).local) || {};
const pgPort = parseInt(dbCfg.port, 10) || 5432;
const pgListen = ps(`Get-NetTCPConnection -State Listen -LocalPort ${pgPort} -ErrorAction SilentlyContinue `
  + `| Select-Object -ExpandProperty LocalAddress`);
const pgAddrs = pgListen.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
if (!pgAddrs.length) {
  fail('PostgreSQL', `nothing listening on ${pgPort} - the app has no database`);
  todo.push('Start the bundled PostgreSQL (Start Morty\'s Auto Parts.bat does both).');
} else if (pgAddrs.some((a) => a === '::' || a === '0.0.0.0')) {
  warn('PostgreSQL exposure', `listening on all interfaces (port ${pgPort})`
    + ' - tills reach the database through the app, so this does not need to be open');
  todo.push('Consider restricting PostgreSQL to localhost unless a client build connects to it directly.');
} else {
  pass('PostgreSQL', `listening on ${pgAddrs.join(', ')}:${pgPort} (loopback only - correct)`);
}

// ---------------------------------------------------------------- 9. env sanity
const dbUrl = env.DATABASE_URL || '';
const wantDb = dbCfg.database || 'mortysautoparts';
if (dbUrl && !dbUrl.includes('/' + wantDb)) {
  warn('.env DATABASE_URL', `points at "${(dbUrl.split('/').pop() || '?')}" but db-config.json uses "${wantDb}"`
    + ' - the server prefers db-config.json, but tools that read DATABASE_URL would use the wrong database');
  todo.push(`Set DATABASE_URL to .../${wantDb} in app/.env.`);
} else if (dbUrl) {
  pass('.env DATABASE_URL', `matches db-config.json (${wantDb})`);
}
if ((env.COOKIE_SECURE || '').toLowerCase() === 'true') {
  fail('.env COOKIE_SECURE', 'true, but the LAN is served over plain http - nobody will stay signed in');
  todo.push('Set COOKIE_SECURE=false in app/.env for an http LAN deploy.');
} else {
  pass('.env COOKIE_SECURE', 'false - correct for http on the LAN');
}

// ---------------------------------------------------------------- report
if (JSON_OUT) {
  console.log(JSON.stringify({ port: PORT, address: me ? me.address : null, results, todo }, null, 2));
  process.exit(results.some((r) => r.level === 'FAIL') ? 1 : 0);
}

const mark = { PASS: '  ok  ', WARN: ' warn ', FAIL: ' FAIL ' };
console.log('\nMorty\'s Auto Parts - local network readiness\n' + '='.repeat(62));
for (const r of results) console.log(`[${mark[r.level]}] ${r.name}\n          ${r.detail}`);

const fails = results.filter((r) => r.level === 'FAIL').length;
const warns = results.filter((r) => r.level === 'WARN').length;
console.log('\n' + '='.repeat(62));
console.log(`${results.length - fails - warns} ok, ${warns} warning(s), ${fails} failure(s)`);
if (me) {
  console.log(`\nTills should open:  http://${me.address}:${PORT}/admin.html`);
  console.log(`              or:  http://${process.env.COMPUTERNAME || 'this-pc'}:${PORT}/admin.html`);
}
if (todo.length) {
  console.log('\nStill to do:');
  todo.forEach((t, i) => console.log(`  ${i + 1}. ${t}`));
} else {
  console.log('\nNothing outstanding - this machine is ready to serve the shop LAN.');
}
process.exit(fails ? 1 : 0);
