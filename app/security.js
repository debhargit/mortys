// =============================================================================
//  Vision Auto Solutions -- Sign-in security and audit log (Phase 8.1)
//
//  Mounted early by server.js (before any route):
//    const security = require('./security').register(app, deps)
//  (it mounts its idle-timeout and audit middleware itself, before its routes)
//  and the password sign-in calls security.checkLocked / failed / passed.
//  Routes under /api/sec (and /api/auth/2fa). Capabilities: sec.manage (policy,
//  unlock, reset 2-step), audit.view (the audit log).
//
//  Lockout     N wrong passwords in a row lock the account for M minutes;
//              any one address making many failures is slowed down too.
//  Idle        a signed-in session with no request for X minutes is ended.
//  2-step      authenticator-app codes (RFC 6238, 30 s, 6 digits; a code is
//              accepted once) plus ten one-time recovery codes. Policy:
//                off       nobody is asked (anyone who set it up still is)
//                remote    staff signing in over the internet must use it
//                managers  owners and managers always, everyone else remotely
//                staff     every staff member, everywhere
//              Someone the policy requires but who has not set it up can sign
//              in on the shop network (to set it up) but not from outside.
//  Audit       every POST / PUT / PATCH / DELETE a staff member makes under
//              /api, with who, when, where from and the fields sent (passwords,
//              PINs, codes and tokens removed), plus sign-ins and lockouts.
// =============================================================================
'use strict';

const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function b32decode(s) {
  const clean = String(s || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) { value = (value << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
function hotp(secret, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', b32decode(secret)).update(buf).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1000000).padStart(6, '0');
}
// The time-step the code matches (one step either side for clock drift), or null.
function totpStep(secret, code, lastStep) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c) || !secret) return null;
  const now = Math.floor(Date.now() / 30000);
  for (const s of [now, now - 1, now + 1]) {
    if (lastStep != null && s <= Number(lastStep)) continue;
    const a = Buffer.from(hotp(secret, s)), b = Buffer.from(c);
    if (crypto.timingSafeEqual(a, b)) return s;
  }
  return null;
}
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const newRecovery = () => Array.from({ length: 10 }, () => crypto.randomBytes(5).toString('hex').replace(/(.{5})/, '$1-'));

function register(app, deps) {
  const { query, requireAdmin, requireCap, bcrypt, publicUser, getEpoch } = deps;
  const can = (k) => [requireAdmin, requireCap(k)];
  // Mounted first, so every route registered after this (here and in server.js) is covered.
  app.use(idle);
  app.use(auditMw);
  function httpError(status, msg) { const e = new Error(msg); e.status = status; e.publicMessage = msg; return e; }
  function fail(res, e) { const s = e.status || 500; if (s >= 500) console.error('[sec]', e); res.status(s).json({ error: e.publicMessage || e.message }); }

  // Settings, cached for a minute (the idle check runs on every request).
  let cache = null;
  async function settings() {
    if (cache && cache.at > Date.now() - 60000) return cache.v;
    const { rows } = await query(`SELECT key, value FROM warehouse_settings WHERE key LIKE 'sec\\_%'`);
    const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    const v = { attempts: Math.max(3, parseInt(s.sec_lockout_attempts, 10) || 5), lockMinutes: Math.max(1, parseInt(s.sec_lockout_minutes, 10) || 15),
      idleMinutes: Math.max(0, parseInt(s.sec_idle_minutes, 10) || 0), policy: ['off', 'remote', 'managers', 'staff'].includes(s.sec_2fa_policy) ? s.sec_2fa_policy : 'off',
      auditDays: Math.max(30, parseInt(s.sec_audit_days, 10) || 730) };
    cache = { at: Date.now(), v };
    return v;
  }

  // Shop network = the server itself or a private LAN address, not through the tunnel.
  function isLocal(req) {
    if (req.headers['cf-connecting-ip'] || req.headers['cf-ray'] || req.headers['x-forwarded-for']) return false;
    const a = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
    return a === '127.0.0.1' || a === '::1' || /^10\./.test(a) || /^192\.168\./.test(a) || /^172\.(1[6-9]|2\d|3[01])\./.test(a) || /^fe80:/i.test(a);
  }
  const ipOf = (req) => String(req.headers['cf-connecting-ip'] || (req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '').slice(0, 64);

  async function audit(req, action, extra) {
    try {
      await query(`INSERT INTO audit_log (user_id, user_name, action, target, status, ip, remote, station, detail) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [extra.user_id || null, extra.user_name || null, action, extra.target || null, extra.status || null, ipOf(req), !isLocal(req),
         String(req.get('x-terminal') || '').slice(0, 80) || null, extra.detail ? JSON.stringify(extra.detail) : null]);
    } catch (e) { console.warn('[sec] audit', e.message); }
  }

  // ------------------------------------------------------------ lockout --
  const IP_FAILS = new Map();   // ip -> {n, first}
  function ipBlocked(req) {
    const r = IP_FAILS.get(ipOf(req));
    if (!r) return false;
    if (Date.now() - r.first > 15 * 60000) { IP_FAILS.delete(ipOf(req)); return false; }
    return r.n >= 20;
  }
  function ipFail(req) {
    const k = ipOf(req), r = IP_FAILS.get(k);
    if (!r || Date.now() - r.first > 15 * 60000) IP_FAILS.set(k, { n: 1, first: Date.now() }); else r.n++;
    if (IP_FAILS.size > 5000) IP_FAILS.delete(IP_FAILS.keys().next().value);
  }

  // Before checking the password. Returns an error message, or null.
  async function checkLocked(req, user) {
    if (ipBlocked(req)) return 'Too many failed sign-ins from this address. Wait 15 minutes.';
    if (user && user.id) {
      const { rows } = await query(`SELECT locked_until > NOW() AS locked, CEIL(EXTRACT(EPOCH FROM (locked_until - NOW())) / 60)::int AS mins FROM users WHERE id = $1`, [user.id]);
      if (rows.length && rows[0].locked) return 'This account is locked after too many wrong passwords. Try again in ' + rows[0].mins + ' minute' + (rows[0].mins === 1 ? '' : 's') + ', or ask a manager to unlock it.';
    }
    return null;
  }
  // Wrong password (user may be null for an unknown email). Returns the message to show.
  async function failed(req, user, email) {
    ipFail(req);
    const s = await settings();
    if (!user) { await audit(req, 'signin_failed', { detail: { email: String(email || '').slice(0, 120), reason: 'unknown email' } }); return null; }
    const { rows } = await query(
      `UPDATE users SET failed_logins = failed_logins + 1,
              locked_until = CASE WHEN failed_logins + 1 >= $2 THEN NOW() + make_interval(mins => $3) ELSE locked_until END
        WHERE id = $1 RETURNING failed_logins, locked_until > NOW() AS locked`, [user.id, s.attempts, s.lockMinutes]);
    const r = rows[0] || {};
    await audit(req, r.locked ? 'locked' : 'signin_failed', { user_id: user.id, user_name: user.name, detail: { failed_in_a_row: r.failed_logins } });
    if (r.locked) return 'Too many wrong passwords: the account is locked for ' + s.lockMinutes + ' minutes.';
    const left = s.attempts - (r.failed_logins || 0);
    return left <= 2 ? 'Invalid credentials. ' + left + ' more wrong attempt' + (left === 1 ? '' : 's') + ' will lock the account.' : null;
  }

  function twoStepRequired(s, user, req) {
    if (user.admin_role === 'rep') return true;   // freelance reps sign in from anywhere: always
    const staff = !!(user.is_admin || user.is_staff);
    if (!staff || s.policy === 'off') return false;
    if (s.policy === 'staff') return true;
    if (s.policy === 'managers' && ['owner', 'manager'].includes(user.admin_role)) return true;
    return !isLocal(req);
  }
  // Right password. Returns {need2fa} | {error} | {ok}.
  async function passed(req, user) {
    const s = await settings();
    const { rows } = await query(`SELECT id, name, is_admin, is_staff, admin_role, totp_secret FROM users WHERE id = $1`, [user.id]);
    const u = rows[0];
    if (u.totp_secret) {
      req.session.pending2fa = { uid: u.id, exp: Date.now() + 5 * 60000, tries: 0, epoch: getEpoch() };
      return { need2fa: true };
    }
    if (u.admin_role === 'rep') {
      await audit(req, 'signin_refused', { user_id: u.id, user_name: u.name, detail: { reason: 'rep without 2-step' } });
      return { error: 'Your 2-step sign-in is not set up. Ask the shop for a new invite link.' };
    }
    if (twoStepRequired(s, u, req)) {
      if (!isLocal(req)) {
        await audit(req, 'signin_refused', { user_id: u.id, user_name: u.name, detail: { reason: '2-step not set up' } });
        return { error: '2-step sign-in is required for this account from outside the shop. Set it up on a computer in the shop first (Security page).' };
      }
    }
    await loginDone(req, u);
    return { ok: true };
  }
  async function loginDone(req, u) {
    await query(`UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = NOW(), last_login_ip = $2 WHERE id = $1`, [u.id, ipOf(req)]);
    await audit(req, 'signin', { user_id: u.id, user_name: u.name });
  }

  app.post('/api/auth/2fa', async (req, res) => {
    try {
      const p = req.session && req.session.pending2fa;
      if (!p || p.exp < Date.now() || p.epoch !== getEpoch()) { if (req.session) req.session.pending2fa = null; throw httpError(401, 'Sign in again: the 2-step check timed out'); }
      if (p.tries >= 5) { req.session.pending2fa = null; throw httpError(429, 'Too many wrong codes. Sign in again.'); }
      const { rows } = await query(`SELECT id, email, name, is_admin, is_staff, admin_role, totp_secret, totp_recovery, totp_last_step, disabled FROM users WHERE id = $1`, [p.uid]);
      const u = rows[0];
      if (!u || u.disabled || !u.totp_secret) { req.session.pending2fa = null; throw httpError(401, 'Sign in again'); }
      const code = String((req.body || {}).code || '').trim();
      let okHow = null;
      const step = totpStep(u.totp_secret, code, u.totp_last_step);
      if (step != null) { okHow = 'code'; await query(`UPDATE users SET totp_last_step = $2 WHERE id = $1`, [u.id, step]); }
      else if (/^[0-9a-f]{5}-?[0-9a-f]{5}$/i.test(code)) {
        const h = sha(code.toLowerCase().replace('-', '').replace(/(.{5})/, '$1-'));
        const list = Array.isArray(u.totp_recovery) ? u.totp_recovery : [];
        if (list.includes(h)) { okHow = 'recovery'; await query(`UPDATE users SET totp_recovery = $2 WHERE id = $1`, [u.id, JSON.stringify(list.filter((x) => x !== h))]); }
      }
      if (!okHow) {
        req.session.pending2fa = Object.assign({}, p, { tries: p.tries + 1 });
        ipFail(req);
        await audit(req, '2fa_failed', { user_id: u.id, user_name: u.name });
        throw httpError(401, 'That code is not right. ' + (4 - p.tries) + ' tries left.');
      }
      req.session.pending2fa = null;
      req.session.userId = u.id;
      req.session.epoch = getEpoch();
      req.session.at = Date.now();
      await loginDone(req, u);
      if (okHow === 'recovery') await audit(req, '2fa_recovery_used', { user_id: u.id, user_name: u.name });
      res.json({ user: publicUser(u), used_recovery: okHow === 'recovery' });
    } catch (e) { fail(res, e); }
  });

  // --------------------------------------------------------------- idle --
  function idle(req, res, next) {
    if (!req.session || !req.session.userId) return next();
    settings().then((s) => {
      const now = Date.now(), seen = req.session.seen || 0;
      if (s.idleMinutes && seen && now - seen > s.idleMinutes * 60000) { req.session = null; return next(); }
      // The team chat's live stream and poll run in the background on every
      // screen; they must not count as someone using the till.
      if (/^\/api\/team\/(stream|poll)$/.test(req.path)) return next();
      if (!seen || now - seen > 60000) req.session.seen = now;   // rewrite the cookie at most once a minute
      next();
    }).catch(() => next());
  }

  // -------------------------------------------------------------- audit --
  // Team chat traffic (messages, typing, read receipts, call set-up) has its own
  // record in team.js; only its management actions and settings come here.
  const SKIP = /\/(heartbeat|ping|presence|ui-prefs|prefs|telemetry)(\/|$)|^\/api\/(auth|public)\/|^\/api\/team\/(?!admin\/|settings$)/;
  const SECRET = /pass|pin|code|token|secret|otp|cvv|card_?number|signature/i;
  const staffCache = new Map();
  async function staffName(uid) {
    const c = staffCache.get(uid);
    if (c && c.at > Date.now() - 300000) return c.v;
    const { rows } = await query(`SELECT name, email, (is_admin OR is_staff) AS staff FROM users WHERE id = $1`, [uid]);
    const v = rows.length && rows[0].staff ? (rows[0].name || rows[0].email) : null;
    staffCache.set(uid, { at: Date.now(), v });
    if (staffCache.size > 2000) staffCache.delete(staffCache.keys().next().value);
    return v;
  }
  function clean(v, depth) {
    if (v == null || typeof v === 'number' || typeof v === 'boolean') return v;
    if (typeof v === 'string') return v.length > 200 ? v.slice(0, 200) + '…' : v;
    if (Array.isArray(v)) return depth > 1 ? '[' + v.length + ' items]' : v.slice(0, 5).map((x) => clean(x, depth + 1)).concat(v.length > 5 ? ['…' + (v.length - 5) + ' more'] : []);
    if (typeof v === 'object') {
      if (depth > 2) return '{…}';
      const o = {};
      for (const k of Object.keys(v).slice(0, 40)) o[k] = SECRET.test(k) ? '[removed]' : clean(v[k], depth + 1);
      return o;
    }
    return String(v).slice(0, 100);
  }
  function auditMw(req, res, next) {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) || !req.path.startsWith('/api/') || SKIP.test(req.path)) return next();
    const uidAtStart = req.session && req.session.userId;
    res.on('finish', () => {
      const uid = uidAtStart || (req.session && req.session.userId);
      if (!uid) return;
      staffName(uid).then((name) => {
        if (!name) return;   // customers using the shop website are not audited here
        const path = req.path.replace(/\/\d+(?=\/|$)/g, '/:id').replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}(?=\/|$)/gi, '/:id');
        const target = (req.path.match(/\/(\d+)(?=\/|$)/) || [])[1] || null;
        const body = req.body && Object.keys(req.body).length ? clean(req.body, 0) : null;
        return audit(req, req.method + ' ' + path, { user_id: uid, user_name: name, target, status: res.statusCode, detail: body });
      }).catch(() => {});
    });
    next();
  }

  // Old audit rows go after the retention period (checked hourly).
  const purge = setInterval(async () => {
    try { const s = await settings(); await query(`DELETE FROM audit_log WHERE at < NOW() - make_interval(days => $1)`, [s.auditDays]); } catch (_) {}
  }, 3600000);
  if (purge.unref) purge.unref();

  // ------------------------------------------------------- my 2-step --
  const me = [requireAdmin];
  async function checkPassword(uid, password) {
    const { rows } = await query(`SELECT password_hash FROM users WHERE id = $1`, [uid]);
    if (!rows.length || !(await bcrypt.compare(String(password || ''), rows[0].password_hash || ''))) throw httpError(403, 'Your password is not right');
  }
  app.get('/api/sec/me', ...me, async (req, res) => {
    try {
      const s = await settings();
      const { rows } = await query(`SELECT id, name, email, admin_role, is_admin, is_staff, totp_enabled_at, COALESCE(jsonb_array_length(totp_recovery), 0) AS recovery_left, last_login_at FROM users WHERE id = $1`, [req.session.userId]);
      const u = rows[0];
      res.json({ two_step: !!u.totp_enabled_at, enabled_at: u.totp_enabled_at, recovery_left: u.recovery_left, policy: s.policy,
        required_here: twoStepRequired(s, u, req), required_from_outside: !!(u.is_admin || u.is_staff) && s.policy !== 'off',
        on_shop_network: isLocal(req), name: u.name, email: u.email });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/sec/me/2fa/start', ...me, async (req, res) => {
    try {
      await checkPassword(req.session.userId, (req.body || {}).password);
      const secret = b32encode(crypto.randomBytes(20));
      const { rows } = await query(`UPDATE users SET totp_pending = $2 WHERE id = $1 RETURNING email`, [req.session.userId, secret]);
      const label = encodeURIComponent('Vision Auto Solutions:' + rows[0].email);
      res.json({ secret: secret.replace(/(.{4})/g, '$1 ').trim(), uri: `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent('Vision Auto Solutions')}&algorithm=SHA1&digits=6&period=30` });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/sec/me/2fa/confirm', ...me, async (req, res) => {
    try {
      const { rows } = await query(`SELECT name, totp_pending FROM users WHERE id = $1`, [req.session.userId]);
      if (!rows[0].totp_pending) throw httpError(409, 'Start the set-up again');
      const step = totpStep(rows[0].totp_pending, (req.body || {}).code, null);
      if (step == null) throw httpError(400, 'That code is not right. Check the phone\'s clock is set automatically.');
      const codes = newRecovery();
      await query(`UPDATE users SET totp_secret = totp_pending, totp_pending = NULL, totp_enabled_at = NOW(), totp_last_step = $2, totp_recovery = $3 WHERE id = $1`,
        [req.session.userId, step, JSON.stringify(codes.map(sha))]);
      await audit(req, '2fa_on', { user_id: req.session.userId, user_name: rows[0].name });
      res.json({ ok: true, recovery_codes: codes });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/sec/me/2fa/off', ...me, async (req, res) => {
    try {
      const b = req.body || {};
      await checkPassword(req.session.userId, b.password);
      const { rows } = await query(`SELECT name, totp_secret FROM users WHERE id = $1`, [req.session.userId]);
      if (!rows[0].totp_secret) throw httpError(409, '2-step is not on');
      if (totpStep(rows[0].totp_secret, b.code, null) == null) throw httpError(400, 'Enter a current code from the app to turn it off');
      await query(`UPDATE users SET totp_secret = NULL, totp_enabled_at = NULL, totp_recovery = NULL, totp_last_step = NULL WHERE id = $1`, [req.session.userId]);
      await audit(req, '2fa_off', { user_id: req.session.userId, user_name: rows[0].name });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/sec/me/2fa/recovery', ...me, async (req, res) => {
    try {
      await checkPassword(req.session.userId, (req.body || {}).password);
      const { rows } = await query(`SELECT name, totp_secret FROM users WHERE id = $1`, [req.session.userId]);
      if (!rows[0].totp_secret) throw httpError(409, '2-step is not on');
      const codes = newRecovery();
      await query(`UPDATE users SET totp_recovery = $2 WHERE id = $1`, [req.session.userId, JSON.stringify(codes.map(sha))]);
      await audit(req, '2fa_recovery_new', { user_id: req.session.userId, user_name: rows[0].name });
      res.json({ recovery_codes: codes });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------------ manage --
  app.get('/api/sec/staff', ...can('sec.manage'), async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT id, name, email, admin_role, (totp_enabled_at IS NOT NULL) AS two_step, last_login_at, last_login_ip, failed_logins,
                (locked_until > NOW()) AS locked, locked_until, disabled
           FROM users WHERE (is_admin OR is_staff) AND NOT COALESCE(is_archived, false) ORDER BY disabled, name`);
      res.json({ staff: rows });
    } catch (e) { fail(res, e); }
  });
  async function target(req) {
    const { rows } = await query(`SELECT id, name, admin_role FROM users WHERE id = $1 AND (is_admin OR is_staff)`, [parseInt(req.params.id, 10) || 0]);
    if (!rows.length) throw httpError(404, 'Staff member not found');
    const { rows: meRow } = await query(`SELECT admin_role FROM users WHERE id = $1`, [req.session.userId]);
    if (rows[0].admin_role === 'owner' && meRow[0].admin_role !== 'owner') throw httpError(403, 'Only an owner can change an owner\'s sign-in');
    return rows[0];
  }
  app.post('/api/sec/staff/:id/unlock', ...can('sec.manage'), async (req, res) => {
    try {
      const t = await target(req);
      await query(`UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1`, [t.id]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/sec/staff/:id/reset-2fa', ...can('sec.manage'), async (req, res) => {
    try {
      const t = await target(req);
      if (t.id === req.session.userId) throw httpError(400, 'Turn your own 2-step off from your own settings');
      await query(`UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_enabled_at = NULL, totp_recovery = NULL, totp_last_step = NULL WHERE id = $1`, [t.id]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/sec/settings', ...can('sec.manage'), async (req, res) => {
    try { cache = null; res.json(await settings()); } catch (e) { fail(res, e); }
  });
  app.put('/api/sec/settings', ...can('sec.manage'), async (req, res) => {
    try {
      const b = req.body || {};
      const put = (k, v) => query(`INSERT INTO warehouse_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [k, String(v)]);
      const int = (v, lo, hi, what) => { const n = parseInt(v, 10); if (!(n >= lo && n <= hi)) throw httpError(400, what + ' must be ' + lo + ' to ' + hi); return n; };
      if (b.policy !== undefined) {
        if (!['off', 'remote', 'managers', 'staff'].includes(b.policy)) throw httpError(400, 'Unknown 2-step policy');
        if (b.policy !== 'off') {
          const { rows } = await query(`SELECT totp_enabled_at FROM users WHERE id = $1`, [req.session.userId]);
          if (!rows[0].totp_enabled_at) throw httpError(409, 'Set up 2-step on your own account first, so you cannot lock yourself out');
        }
        await put('sec_2fa_policy', b.policy);
      }
      if (b.attempts !== undefined) await put('sec_lockout_attempts', int(b.attempts, 3, 20, 'Attempts'));
      if (b.lockMinutes !== undefined) await put('sec_lockout_minutes', int(b.lockMinutes, 1, 1440, 'Lock minutes'));
      if (b.idleMinutes !== undefined) await put('sec_idle_minutes', int(b.idleMinutes, 0, 10080, 'Idle minutes'));
      if (b.auditDays !== undefined) await put('sec_audit_days', int(b.auditDays, 30, 3650, 'Audit days'));
      cache = null;
      res.json(await settings());
    } catch (e) { fail(res, e); }
  });

  app.get('/api/sec/audit', ...can('audit.view'), async (req, res) => {
    try {
      const vals = [], where = [];
      const add = (sql, v) => { vals.push(v); where.push(sql.split('?').join('$' + vals.length)); };
      const iso = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s || '') ? s : null);
      if (iso(req.query.from)) add(`at >= (?::date)::timestamp AT TIME ZONE 'America/Jamaica'`, req.query.from);
      if (iso(req.query.to)) add(`at < (?::date + 1)::timestamp AT TIME ZONE 'America/Jamaica'`, req.query.to);
      if (req.query.user) add('user_id = ?', parseInt(req.query.user, 10) || 0);
      if (req.query.q) add(`(action ILIKE '%' || ? || '%' OR detail::text ILIKE '%' || ? || '%' OR target = ?)`, String(req.query.q).slice(0, 80));
      if (req.query.kind === 'security') where.push(`action IN ('signin','signin_failed','locked','signin_refused','2fa_on','2fa_off','2fa_failed','2fa_recovery_used','2fa_recovery_new')`);
      if (req.query.kind === 'changes') where.push(`action LIKE '% /api/%'`);
      if (req.query.remote === '1') where.push('remote');
      const { rows } = await query(`SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 500`, vals);
      res.json({ rows });
    } catch (e) { fail(res, e); }
  });

  return { checkLocked, failed, passed, idle, audit: auditMw, isLocal };
}

module.exports = { register, _totp: { hotp, totpStep, b32encode, b32decode } };
