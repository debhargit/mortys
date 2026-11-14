// =============================================================================
//  auth-extra.js -- extra ways to sign in, and getting back in
//
//  * Password reset by email: "Forgot your password?" sends a one-time link
//    (token stored only as a hash; the link is only in the email) that opens
//    /reset.html to set a new password. Always answers "if that email exists
//    we sent a link", so it never reveals who has an account.
//  * Passkeys for customers: register Face/Touch ID / Windows Hello / a phone
//    while signed in, then sign in with it next time -- no password typed.
//    Reuses webauthn.js and the passkeys table (shared with the time clock).
//  * Google sign-in: verifies a Google ID token server-side against
//    GOOGLE_CLIENT_ID; signs in an existing account or creates a customer one.
//    Off unless GOOGLE_CLIENT_ID is set (the owner creates the OAuth client).
//  * Changing a password from the sign-in screen, with the current one, or
//    with Google when the current one is forgotten.
//
//  All of this runs on the shop's own server (where the database is). A till
//  pointed at another PC signs in through that PC as it always did.
// =============================================================================
'use strict';
const crypto = require('crypto');
const https = require('https');
const wa = require('./webauthn');

const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const httpError = (s, m) => { const e = new Error(m); e.status = s; return e; };

exports.register = function register(app, deps) {
  const { query, bcrypt, mailer, publicUser, getEpoch, nextAccountNumber, reps, devMode } = deps;
  const fail = (res, e) => { if (!e.status) console.error('[auth-extra]', e); res.status(e.status || 500).json({ error: e.status ? e.message : 'Server error' }); };
  const ipOf = (req) => String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '').split(',')[0].replace(/^::ffff:/, '').trim().slice(0, 64);
  const signInSession = (req, userId) => { req.session.userId = userId; req.session.epoch = getEpoch(); req.session.at = Date.now(); };
  function rpOf(req) {
    const host = String(req.get('host') || 'localhost').split(':')[0];
    const origins = [(req.headers['x-forwarded-proto'] || req.protocol || 'http') + '://' + req.get('host')];
    return { rpId: host, origins };
  }
  async function baseUrl(req) {
    try { const { rows } = await query(`SELECT value FROM warehouse_settings WHERE key = 'public_base_url'`); if (rows[0] && rows[0].value) return rows[0].value.replace(/\/$/, ''); } catch (_) {}
    return (req.headers['x-forwarded-proto'] || req.protocol || 'http') + '://' + req.get('host');
  }

  // Which extra sign-in options the login page should show.
  app.get('/api/auth/providers', (req, res) => {
    res.json({ passkey: true, google: { enabled: !!process.env.GOOGLE_CLIENT_ID, client_id: process.env.GOOGLE_CLIENT_ID || null } });
  });

  // ------------------------------------------------------- password reset --
  const resetTries = new Map();
  function throttle(req, max, windowMs) {
    const k = ipOf(req), r = resetTries.get(k) || { n: 0, first: Date.now() };
    if (Date.now() - r.first > windowMs) { r.n = 0; r.first = Date.now(); }
    r.n++; resetTries.set(k, r);
    return r.n <= max;
  }
  app.post('/api/auth/request-reset', async (req, res) => {
    const email = String((req.body || {}).email || '').trim().toLowerCase();
    // Always the same answer, whether or not the email is on file (no account enumeration).
    const done = () => res.json({ ok: true, message: 'If that email has an account with a password, a reset link is on its way.' });
    try {
      if (!email || !/@/.test(email)) return res.status(400).json({ error: 'Enter your email address' });
      if (!throttle(req, 5, 15 * 60000)) return res.status(429).json({ error: 'Too many reset requests. Wait a few minutes.' });
      const { rows } = await query(`SELECT id, name, email, password_hash, disabled FROM users WHERE lower(email) = lower($1) LIMIT 1`, [email]);
      const u = rows[0];
      // Only email accounts that actually sign in with a password here.
      if (u && u.password_hash && !u.disabled) {
        const token = crypto.randomBytes(32).toString('base64url');
        await query(`DELETE FROM password_resets WHERE user_id = $1 AND used_at IS NULL`, [u.id]);
        await query(`INSERT INTO password_resets (user_id, token_hash, expires_at, requested_ip) VALUES ($1, $2, NOW() + INTERVAL '1 hour', $3)`, [u.id, sha(token), ipOf(req)]);
        const link = (await baseUrl(req)) + '/reset.html?token=' + token;
        if (mailer && mailer.sendEmail) {
          mailer.sendEmail({ to: u.email, subject: 'Reset your Morty\'s Auto password',
            text: 'Hello ' + (u.name || '') + ',\n\nSomeone (hopefully you) asked to reset the password for this account.\n\nOpen this link within one hour to set a new password:\n' + link + '\n\nIf it was not you, ignore this email; your password stays the same.\n\nMorty\'s Auto Parts, 876-905-4111',
            html: '<p>Hello ' + (u.name || '') + ',</p><p>Someone (hopefully you) asked to reset the password for this account.</p><p><a href="' + link + '" style="background:#d61f2b;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Set a new password</a></p><p>Or paste this link (good for one hour):<br>' + link + '</p><p>If it was not you, ignore this email; your password stays the same.</p><p>Morty\'s Auto Parts &middot; 876-905-4111</p>' }).catch((e) => console.warn('[auth-extra] reset email', e.message));
        }
        if (devMode) return res.json({ ok: true, dev_link: link });   // the test copy shows the link instead of emailing
      }
      done();
    } catch (e) { console.error('[auth-extra] request-reset', e); done(); }
  });
  // Check a token is still good (so the page can show the form or an error).
  app.get('/api/auth/reset-check', async (req, res) => {
    try {
      const { rows } = await query(`SELECT u.email FROM password_resets r JOIN users u ON u.id = r.user_id WHERE r.token_hash = $1 AND r.used_at IS NULL AND r.expires_at > NOW()`, [sha(req.query.token || '')]);
      if (!rows.length) return res.status(400).json({ ok: false, error: 'This reset link has expired or was already used. Ask for a new one.' });
      res.json({ ok: true, email: rows[0].email });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/auth/reset', async (req, res) => {
    try {
      const b = req.body || {}; const pw = String(b.password || '');
      if (pw.length < 8) throw httpError(400, 'Use at least 8 characters for your new password');
      const { rows } = await query(`SELECT r.id, r.user_id FROM password_resets r WHERE r.token_hash = $1 AND r.used_at IS NULL AND r.expires_at > NOW()`, [sha(b.token || '')]);
      if (!rows.length) throw httpError(400, 'This reset link has expired or was already used. Ask for a new one.');
      const hash = await bcrypt.hash(pw, 10);
      await query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [rows[0].user_id, hash]);
      await query(`UPDATE password_resets SET used_at = NOW() WHERE id = $1`, [rows[0].id]);
      await query(`DELETE FROM password_resets WHERE user_id = $1 AND used_at IS NULL`, [rows[0].user_id]);
      // New password clears any lockout and signs them in.
      await query(`UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1`, [rows[0].user_id]).catch(() => {});
      signInSession(req, rows[0].user_id);
      const { rows: u } = await query(`SELECT id, email, name, is_admin, admin_role FROM users WHERE id = $1`, [rows[0].user_id]);
      res.json({ ok: true, user: publicUser(u[0]) });
    } catch (e) { fail(res, e); }
  });

  // --------------------------------------------------------------- passkeys --
  // Register a passkey -- must be signed in (you prove who you are with your
  // password / Google first, then add the passkey to that account).
  app.post('/api/auth/passkey/register-options', async (req, res) => {
    try {
      if (!req.session || !req.session.userId) throw httpError(401, 'Sign in first, then add a passkey');
      const uid = req.session.userId;
      const { rows: u } = await query(`SELECT email, name FROM users WHERE id = $1`, [uid]);
      if (!u.length) throw httpError(401, 'Sign in again');
      const rp = rpOf(req);
      const challenge = wa.newChallenge();
      req.session.waCustReg = { challenge, uid, exp: Date.now() + 180000 };
      const { rows: ex } = await query(`SELECT credential_id FROM passkeys WHERE user_id = $1`, [uid]);
      res.json({ challenge, rp: { id: rp.rpId, name: 'Morty\'s Auto Parts' },
        user: { id: wa.b64u(Buffer.from('u' + uid)), name: u[0].email, displayName: u[0].name || u[0].email },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
        excludeCredentials: ex.map((e) => ({ type: 'public-key', id: e.credential_id })), timeout: 120000 });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/auth/passkey/register', async (req, res) => {
    try {
      const ch = req.session && req.session.waCustReg;
      if (!ch || ch.exp < Date.now() || ch.uid !== (req.session && req.session.userId)) throw httpError(400, 'Start adding the passkey again');
      req.session.waCustReg = null;
      const rp = rpOf(req);
      const v = wa.verifyRegistration((req.body || {}).credential, { challenge: ch.challenge, origins: rp.origins, rpId: rp.rpId });
      await query(`INSERT INTO passkeys (user_id, credential_id, public_key, sign_count, label, created_by) VALUES ($1,$2,$3,$4,$5,$1)
        ON CONFLICT (credential_id) DO NOTHING`, [ch.uid, v.credentialId, v.jwk, v.signCount, String((req.body || {}).label || 'Passkey').slice(0, 40)]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  // Sign in with a passkey -- usernameless (the device offers the right one).
  app.post('/api/auth/passkey/auth-options', (req, res) => {
    const challenge = wa.newChallenge();
    req.session.waCustAuth = { challenge, exp: Date.now() + 120000 };
    res.json({ challenge, rpId: rpOf(req).rpId, userVerification: 'required', allowCredentials: [], timeout: 120000 });
  });
  app.post('/api/auth/passkey/signin', async (req, res) => {
    try {
      const ch = req.session && req.session.waCustAuth;
      if (!ch || ch.exp < Date.now()) throw httpError(400, 'Start the passkey sign-in again');
      req.session.waCustAuth = null;
      const cred = (req.body || {}).credential || {};
      const { rows } = await query(`SELECT p.*, u.disabled, u.id AS uid, u.email, u.name, u.is_admin, u.admin_role FROM passkeys p JOIN users u ON u.id = p.user_id WHERE p.credential_id = $1`, [String(cred.id || '')]);
      if (!rows.length) throw httpError(401, 'That passkey is not registered here');
      if (rows[0].disabled) throw httpError(403, 'This account has been disabled.');
      const rp = rpOf(req);
      const v = wa.verifyAssertion(cred, { jwk: rows[0].public_key, sign_count: rows[0].sign_count }, { challenge: ch.challenge, origins: rp.origins, rpId: rp.rpId });
      await query(`UPDATE passkeys SET sign_count = $2, last_used_at = NOW() WHERE id = $1`, [rows[0].id, v.signCount]);
      signInSession(req, rows[0].uid);
      res.json({ ok: true, user: publicUser(rows[0]) });
    } catch (e) { fail(res, e); }
  });
  // Manage your own passkeys.
  app.get('/api/auth/passkeys', async (req, res) => {
    try {
      if (!req.session || !req.session.userId) throw httpError(401, 'Sign in');
      const { rows } = await query(`SELECT id, label, created_at, last_used_at FROM passkeys WHERE user_id = $1 ORDER BY created_at`, [req.session.userId]);
      res.json({ passkeys: rows });
    } catch (e) { fail(res, e); }
  });
  app.delete('/api/auth/passkeys/:id(\\d+)', async (req, res) => {
    try {
      if (!req.session || !req.session.userId) throw httpError(401, 'Sign in');
      await query(`DELETE FROM passkeys WHERE id = $1 AND user_id = $2`, [parseInt(req.params.id, 10), req.session.userId]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // --------------------------------------------------------------- Google --
  function verifyGoogleIdToken(idToken) {
    return new Promise((resolve, reject) => {
      const r = https.get('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken), { timeout: 8000 }, (resp) => {
        let body = ''; resp.on('data', (d) => { body += d; if (body.length > 20000) r.destroy(); });
        resp.on('end', () => { try { resolve(JSON.parse(body)); } catch (_) { reject(new Error('Could not read the Google response')); } });
      });
      r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('Google did not answer')); });
    });
  }
  app.post('/api/auth/google', async (req, res) => {
    try {
      const clientId = process.env.GOOGLE_CLIENT_ID;
      if (!clientId) throw httpError(503, 'Google sign-in is not set up on this shop yet.');
      const idToken = String((req.body || {}).credential || '');
      if (!idToken) throw httpError(400, 'No Google sign-in came through');
      const info = await verifyGoogleIdToken(idToken);
      if (info.aud !== clientId) throw httpError(401, 'This Google sign-in was for a different site');
      if (!info.email || String(info.email_verified) !== 'true') throw httpError(401, 'Google could not confirm your email');
      const email = String(info.email).toLowerCase();
      let { rows } = await query(`SELECT id, email, name, is_admin, admin_role, disabled FROM users WHERE lower(email) = lower($1) LIMIT 1`, [email]);
      if (rows.length && rows[0].disabled) throw httpError(403, 'This account has been disabled.');
      if (!rows.length) {
        // New customer account via Google (no password; they can add one or a passkey later).
        const acctNo = await nextAccountNumber();
        const ins = await query(`INSERT INTO users (email, name, via, is_admin, account_number) VALUES (lower($1), $2, 'google', false, $3) RETURNING id, email, name, is_admin, admin_role`,
          [email, info.name || info.given_name || null, acctNo]);
        rows = ins.rows;
        if (reps && reps.attributeReferral) await reps.attributeReferral(req, rows[0].id).catch(() => {});
      } else if (!rows[0].name && info.name) {
        await query(`UPDATE users SET name = $2, via = COALESCE(via, 'google') WHERE id = $1`, [rows[0].id, info.name]);
      }
      signInSession(req, rows[0].id);
      res.json({ ok: true, user: publicUser(rows[0]) });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------ change your password --
  // From the sign-in screen, before signing in: email, current password, new
  // password. A wrong current password counts towards the same lockout as a
  // wrong sign-in, so this is no softer a door than signing in. Nobody is
  // signed in by it: the next sign-in uses the new password, and 2-step where
  // that is on.
  function newPassword(pw, old) {
    if (pw.length < 8) throw httpError(400, 'Use at least 8 characters for your new password');
    if (pw.length > 200) throw httpError(400, 'That password is too long');
    if (old && pw === old) throw httpError(400, 'The new password has to be different from the old one');
  }
  async function setPassword(userId, pw) {
    const hash = await bcrypt.hash(pw, 10);
    try {
      await query(`UPDATE users SET password_hash = $2, failed_logins = 0, locked_until = NULL WHERE id = $1`, [userId, hash]);
    } catch (e) {
      // A till that is not the main PC may not write passwords (see schema.sql).
      if (e.code === '42501') throw httpError(409, 'Change your password on the main PC, or ask a manager.');
      throw e;
    }
    await query(`DELETE FROM password_resets WHERE user_id = $1 AND used_at IS NULL`, [userId]).catch(() => {});
  }
  app.post('/api/auth/change-password', async (req, res) => {
    try {
      const b = req.body || {};
      const email = String(b.email || '').trim().toLowerCase();
      const cur = String(b.current_password || ''), pw = String(b.new_password || '');
      if (!email || !cur) throw httpError(400, 'Enter your email and your current password');
      newPassword(pw, cur);
      const { rows } = await query(`SELECT id, name, email, password_hash, disabled FROM users WHERE lower(email) = lower($1) LIMIT 1`, [email]);
      const sec = deps.security;
      const locked = sec ? await sec.checkLocked(req, rows[0]) : null;
      if (locked) throw httpError(423, locked);
      if (!rows.length || !(await bcrypt.compare(cur, rows[0].password_hash || ''))) {
        const msg = sec ? await sec.failed(req, rows[0] || null, email) : null;
        throw httpError(401, msg || 'Email or current password not right');
      }
      if (rows[0].disabled) throw httpError(403, 'This account has been disabled. Ask a manager.');
      await setPassword(rows[0].id, pw);
      console.log('[auth-extra] password changed at sign-in:', rows[0].email);
      res.json({ ok: true, email: rows[0].email });
    } catch (e) { fail(res, e); }
  });

  // Set a new password by proving the email with Google instead of a reset
  // email -- for someone who forgot it and whose account email is a Google
  // one. Only for an account that already exists; nobody is created or signed
  // in by it.
  app.post('/api/auth/google/password', async (req, res) => {
    try {
      const clientId = process.env.GOOGLE_CLIENT_ID;
      if (!clientId) throw httpError(503, 'Google is not set up on this shop yet.');
      if (!throttle(req, 10, 15 * 60000)) throw httpError(429, 'Too many tries. Wait a few minutes.');
      const b = req.body || {};
      const pw = String(b.new_password || '');
      newPassword(pw, null);
      const idToken = String(b.credential || '');
      if (!idToken) throw httpError(400, 'No Google sign-in came through');
      const info = await verifyGoogleIdToken(idToken);
      if (info.aud !== clientId) throw httpError(401, 'This Google sign-in was for a different site');
      if (!info.email || String(info.email_verified) !== 'true') throw httpError(401, 'Google could not confirm your email');
      const email = String(info.email).toLowerCase();
      const { rows } = await query(`SELECT id, email, disabled FROM users WHERE lower(email) = lower($1) LIMIT 1`, [email]);
      if (!rows.length) throw httpError(404, 'There is no account here for ' + email + '.');
      if (rows[0].disabled) throw httpError(403, 'This account has been disabled. Ask a manager.');
      await setPassword(rows[0].id, pw);
      console.log('[auth-extra] password set with Google:', email);
      res.json({ ok: true, email });
    } catch (e) { fail(res, e); }
  });

  // Tidy expired reset tokens daily.
  if (!devMode) setInterval(() => { query(`DELETE FROM password_resets WHERE expires_at < NOW() - INTERVAL '1 day'`).catch(() => {}); }, 3600000).unref();
};
