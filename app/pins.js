// =============================================================================
//  pins.js -- how staff PINs are kept and checked
//
//  A PIN is four to eight digits, so a plain bcrypt hash of one is only ten
//  thousand guesses away from being read back out of a copy of the database:
//  a backup file, a dump handed to someone, a stolen disk. So the PIN is first
//  sealed with a secret key (HMAC-SHA256) and only then hashed. The key lives
//  in a file on the main PC (data/keys/pin.key), never in the database, so the
//  database or any of its backups on their own are not enough to recover one.
//
//  Stored form:   v2$<bcrypt of the keyed PIN>
//  Older hashes (plain bcrypt of the PIN) still work, and are re-sealed with
//  the key the first time that person's PIN is typed correctly.
//
//  A till that is not the main PC has no key. It asks the main PC to check
//  (or seal) the PIN for it, the same way it already asks it to check
//  passwords -- see /api/terminal/pin in server.js.
//
//  Losing the key file means every PIN has to be set again (passwords are not
//  affected). Keep a copy of data/keys somewhere safe, apart from the backups.
// =============================================================================
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const KEY_FILE = process.env.MH_PIN_KEY_FILE || path.join(__dirname, '..', 'data', 'keys', 'pin.key');
const PREFIX = 'v2$';

let cfg = { query: null, isMain: () => true, remote: null };
let key = null;

function configure(o) { cfg = Object.assign(cfg, o || {}); }

// Made on the main PC the first time it is needed; read on every later start.
function loadKey() {
  if (key) return key;
  try {
    const k = Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'base64');
    if (k.length >= 32) return (key = k);
  } catch (_) {}
  if (!cfg.isMain()) return null;
  const k = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
  fs.writeFileSync(KEY_FILE, k.toString('base64') + '\n', { mode: 0o600, flag: 'wx' });
  console.log('[pins] new PIN key written to ' + KEY_FILE + ' -- keep a copy of it apart from the backups');
  return (key = k);
}

const seal = (k, pin) => crypto.createHmac('sha256', k).update('pin:' + pin).digest('hex');

function remoteOrThrow() {
  if (cfg.remote && cfg.remote.enabled()) return cfg.remote;
  const e = new Error('This till cannot check PINs: it has no PIN key and no link to the main PC. Reconnect it with a new connection link.');
  e.userFacing = true; throw e;
}

async function hash(pin) {
  const clean = String(pin);
  const k = loadKey();
  if (k) return PREFIX + await bcrypt.hash(seal(k, clean), 10);
  const r = await remoteOrThrow().post({ op: 'hash', pin: clean });
  if (!r.hash) throw new Error(r.error || 'The main PC did not seal the PIN');
  return r.hash;
}

// Does this PIN belong to this row ({id, pin_hash})? An old-style hash that
// matches is re-sealed with the key on the spot.
async function matches(row, pin) {
  if (!row || !row.pin_hash) return false;
  const clean = String(pin);
  const stored = String(row.pin_hash);
  const k = loadKey();
  if (!k) {
    const r = await remoteOrThrow().post({ op: 'check', user_id: row.id, pin: clean });
    return !!r.ok;
  }
  if (stored.startsWith(PREFIX)) return bcrypt.compare(seal(k, clean), stored.slice(PREFIX.length));
  if (!(await bcrypt.compare(clean, stored))) return false;
  if (cfg.query && row.id) {
    const fresh = PREFIX + await bcrypt.hash(seal(k, clean), 10);
    await cfg.query('UPDATE users SET pin_hash = $1 WHERE id = $2 AND pin_hash = $3', [fresh, row.id, stored])
      .catch((e) => console.warn('[pins] re-seal', e.message));
  }
  return true;
}

// The first row whose PIN this is. With a picked person there is one row.
async function pick(rows, pin) {
  for (const r of rows) if (await matches(r, pin)) return r;
  return null;
}

// The person picked on the keypad's staff list, as a positive id or null.
const pickedId = (b) => { const n = parseInt(b && b.user_id, 10); return n > 0 ? n : null; };

const isSealed = (h) => String(h || '').startsWith(PREFIX);

module.exports = { configure, hash, matches, pick, pickedId, isSealed, KEY_FILE };
