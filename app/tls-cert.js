// ============================================================================
//  tls-cert.js — the shop's own PostgreSQL server certificate.
//
//  Without this, every till's password and every row it reads crosses the shop
//  LAN in clear text. Anyone on the same wifi can read the lot with a packet
//  capture and no special access.
//
//  There is no certificate authority in a parts shop and no openssl.exe in the
//  bundled PostgreSQL (it ships libssl, but not the command-line tool), so the
//  certificate is generated here, in process, and is self-signed. That is not
//  a weakness in this setting BECAUSE the client does not have to trust it
//  blindly: enrolment hands the till a copy of this exact certificate, and the
//  till pins it. An attacker who redirects the connection presents a different
//  certificate and is refused. What is skipped is hostname matching, which is
//  meaningless when the "hostname" is a DHCP address on a private LAN --
//  pinning the chain is the stronger check, not the weaker one.
//
//  Ten-year validity on purpose. Clients pin this certificate, so rotating it
//  means re-enrolling every till; an expiry that quietly breaks the whole shop
//  one morning is a far worse failure than a long-lived key on a private
//  network that never leaves the building.
// ============================================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const CERT_NAME = 'server.crt';
const KEY_NAME = 'server.key';

function localAddresses() {
  const out = [];
  try {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const ifc of ifaces[name] || []) {
        if (ifc && ifc.family === 'IPv4' && !out.includes(ifc.address)) out.push(ifc.address);
      }
    }
  } catch (_) {}
  if (!out.includes('127.0.0.1')) out.push('127.0.0.1');
  return out;
}

// Valid, present, and not about to expire. Returns null when a new one is
// needed rather than throwing, so callers can just regenerate.
function readExistingCert(dir) {
  const certPath = path.join(dir, CERT_NAME);
  const keyPath = path.join(dir, KEY_NAME);
  try {
    if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) return null;
    const cert = fs.readFileSync(certPath, 'utf8');
    const key = fs.readFileSync(keyPath, 'utf8');
    const x = new crypto.X509Certificate(cert);
    if (new Date(x.validTo).getTime() < Date.now() + 30 * 24 * 3600 * 1000) return null;  // expired or nearly
    if (!x.checkPrivateKey(crypto.createPrivateKey(key))) return null;                    // mismatched pair
    return { certPath, keyPath, cert, fingerprint: x.fingerprint256 };
  } catch (_) {
    return null;
  }
}

// Creates the pair if it is missing, expired or mismatched; otherwise leaves
// the existing one alone. Never regenerates just because the machine's IP
// changed -- that would silently invalidate every till that pinned it, and the
// pinning check does not look at the address anyway.
async function ensureServerCert(dir) {
  const existing = readExistingCert(dir);
  if (existing) return Object.assign({ created: false }, existing);

  const selfsigned = require('selfsigned');
  const host = os.hostname();
  const ips = localAddresses();
  const altNames = [{ type: 2, value: host }, { type: 2, value: 'localhost' }]
    .concat(ips.map((ip) => ({ type: 7, ip })));

  const notAfter = new Date();
  notAfter.setFullYear(notAfter.getFullYear() + 10);

  const pems = await selfsigned.generate(
    [{ name: 'commonName', value: host }],
    {
      keySize: 2048,
      algorithm: 'sha256',
      notAfterDate: notAfter,          // NOT `days` -- that option is ignored by selfsigned 5.x
      extensions: [
        { name: 'basicConstraints', cA: true },
        { name: 'keyUsage', keyCertSign: true, digitalSignature: true, keyEncipherment: true },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames },
      ],
    }
  );

  fs.mkdirSync(dir, { recursive: true });
  const certPath = path.join(dir, CERT_NAME);
  const keyPath = path.join(dir, KEY_NAME);
  fs.writeFileSync(certPath, pems.cert, { mode: 0o600 });
  // PostgreSQL refuses to start if the key is group/world readable. Windows
  // ignores the POSIX bits, but this same file runs on the operator's own
  // machine during development too.
  fs.writeFileSync(keyPath, pems.private, { mode: 0o600 });

  const x = new crypto.X509Certificate(pems.cert);
  return { created: true, certPath, keyPath, cert: pems.cert, fingerprint: x.fingerprint256 };
}

module.exports = { ensureServerCert, readExistingCert, CERT_NAME, KEY_NAME };
