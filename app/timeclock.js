// =============================================================================
//  Vision Auto Solutions -- Time clock and attendance (Phase 8b)
//
//  Mounted early by server.js (its middleware must run before the money routes):
//    const clock = require('./timeclock').register(app, deps)
//  Routes under /api/clock. Capabilities: clock.manage (schedules, staff
//  settings, badges, passkeys, timesheets, payroll), clock.approve (overtime,
//  extensions, corrections). Kiosk punches (/api/clock/punch) need no session:
//  the PIN, password, badge or passkey says who it is.
//
//  Who is "present": clocked in ON SITE (the shop network, a bound station, or
//  a phone on the shop's Wi-Fi -- its public address), inside their shift or
//  approved / requested overtime or extension. With the rule switched on, only
//  present staff can take a sale's payment, open or use a drawer, refund or
//  void. Remote staff (allowed per person) clock in as Remote: they can quote
//  and build orders, never take money. Roles in clock_exempt_roles are never
//  checked.
//
//  Clocking in outside the shift (early, late, day off) needs a confirmation
//  and a reason, and becomes an overtime request. Near the end of the shift the
//  screens warn at 15 and 5 minutes; at the end the person is clocked out and
//  signed out, unless an extension is waiting (a grace period) or approved, or
//  their cash drawer is still open (they are asked to close it first).
//  Requests are emailed to the admin(s) and the department manager with a
//  signed, single-use, expiring link, and a copy goes to the staff member; the
//  decision is emailed back to them.
//
//  Timesheets: worked time per day less unpaid breaks (lunch, and breaks past
//  the paid allowance; a shift's break is deducted when none was punched on a
//  day over 6 hours), per-person daily / weekly overtime thresholds and rate,
//  late, early leave, absent; weekly approval freezes the figures; the payroll
//  CSV puts hours, overtime and commission side by side.
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const wa = require('./webauthn');

const TZ = 'America/Jamaica';
const OFFSET = '-05:00';   // Jamaica keeps no daylight saving
const BILLING = [/^\/api\/admin\/pos\/sale$/, /^\/api\/admin\/pos\/orders\/\d+\/invoice$/, /^\/api\/cash\/till\/(open|movement)$/, /^\/api\/admin\/pos\/sales\/\d+\/(return|void)$/];

function register(app, deps) {
  const { query, getPool, requireAdmin, requireCap, bcrypt, mailer, isLocal, getShopName, publicUser } = deps;
  const can = (k) => [requireAdmin, requireCap(k)];
  const n = (v) => (v == null ? 0 : Number(v));
  const r2 = (v) => Math.round(n(v) * 100) / 100;
  const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
  const PHOTO_DIR = path.join(__dirname, '..', 'data', 'clock-photos');
  fs.mkdirSync(PHOTO_DIR, { recursive: true });
  function httpError(status, msg, extra) { const e = new Error(msg); e.status = status; e.publicMessage = msg; e.extra = extra; return e; }
  function fail(res, e) { const s = e.status || 500; if (s >= 500) console.error('[clock]', e); res.status(s).json(Object.assign({ error: e.publicMessage || e.message }, e.extra || {})); }
  async function tx(fn) {
    const c = await getPool().connect();
    try { await c.query('BEGIN'); const out = await fn(c); await c.query('COMMIT'); return out; }
    catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} throw e; }
    finally { c.release(); }
  }
  let sCache = null;
  async function settings() {
    if (sCache && sCache.at > Date.now() - 30000) return sCache.v;
    const { rows } = await query(`SELECT key, value FROM warehouse_settings WHERE key LIKE 'clock\\_%' OR key IN ('public_base_url')`);
    const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    const v = { enforce: s.clock_enforce === 'on', exempt: String(s.clock_exempt_roles || 'owner').split(',').map((x) => x.trim()).filter(Boolean),
      early: parseInt(s.clock_early_minutes, 10) || 15, late: parseInt(s.clock_late_minutes, 10) || 5, grace: parseInt(s.clock_grace_minutes, 10) || 15,
      photo: s.clock_photo === 'on', paidBreak: parseInt(s.clock_break_paid_minutes, 10) || 0, shopIps: String(s.clock_shop_ips || '').split(',').map((x) => x.trim()).filter(Boolean),
      base: s.public_base_url || '' };
    sCache = { at: Date.now(), v };
    return v;
  }
  const put = (k, v) => query(`INSERT INTO warehouse_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [k, String(v)]);
  const jmDay = (d) => new Date(new Date(d || Date.now()).getTime() - 5 * 3600000).toISOString().slice(0, 10);
  const jmTime = (d) => new Date(new Date(d).getTime() - 5 * 3600000).toISOString().slice(11, 16);
  const at = (day, hhmm) => new Date(day + 'T' + String(hhmm).slice(0, 5) + ':00' + OFFSET);
  const weekday = (day) => new Date(day + 'T12:00:00' + OFFSET).getUTCDay();
  const fmtT = (d) => (d ? jmTime(d) : '');
  const ipOf = (req) => String(req.headers['cf-connecting-ip'] || (req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');

  async function onSite(req) {
    if (isLocal(req)) return true;
    const s = await settings();
    if (s.shopIps.length && s.shopIps.includes(ipOf(req))) return true;
    return false;
  }

  // The shift for a person on a day: {start, end, break_minutes} or {off: reason}.
  async function shiftFor(uid, day, q = query) {
    const { rows: hol } = await q(`SELECT name FROM public_holidays WHERE day = $1`, [day]);
    if (hol.length) return { off: 'Holiday: ' + hol[0].name };
    const { rows: lv } = await q(`SELECT kind FROM staff_leave WHERE user_id = $1 AND $2::date BETWEEN from_date AND to_date LIMIT 1`, [uid, day]);
    if (lv.length) return { off: 'On ' + lv[0].kind + ' leave' };
    const { rows } = await q(`SELECT to_char(start_time, 'HH24:MI') AS s, to_char(end_time, 'HH24:MI') AS e, break_minutes FROM staff_shifts WHERE user_id = $1 AND weekday = $2`, [uid, weekday(day)]);
    if (!rows.length) return { off: 'No shift today' };
    const start = at(day, rows[0].s);
    let end = at(day, rows[0].e);
    if (end <= start) end = new Date(end.getTime() + 86400000);   // overnight
    return { start, end, break_minutes: rows[0].break_minutes };
  }
  async function staffRow(uid) {
    const { rows } = await query(
      `SELECT u.id, u.name, u.email, u.admin_role, u.is_staff, u.is_admin, u.disabled, u.pin_hash, u.password_hash,
              COALESCE(c.methods, ARRAY['pin','password','badge','biometric']) AS methods, COALESCE(c.require_biometric, false) AS require_biometric,
              COALESCE(c.remote_allowed, false) AS remote_allowed, c.approver_user_id
         FROM users u LEFT JOIN staff_clock c ON c.user_id = u.id WHERE u.id = $1`, [uid]);
    return rows[0];
  }
  async function openEntry(uid, q = query) {
    const { rows } = await q(`SELECT * FROM attendance WHERE user_id = $1 AND clock_out_at IS NULL`, [uid]);
    return rows[0] || null;
  }
  // When this attendance may run to: approved extension, else the shift end
  // (no shift: 12 hours after clocking in, as a backstop).
  function endOf(a) {
    if (a.ext_until) return new Date(a.ext_until);
    if (a.shift_end) return new Date(a.shift_end);
    return new Date(new Date(a.clock_in_at).getTime() + 12 * 3600000);
  }

  // ------------------------------------------------- present (billing) --
  async function presence(req) {
    const s = await settings();
    const uid = req.session && req.session.userId;
    if (!uid) return { ok: false, reason: 'Sign in first' };
    const u = await staffRow(uid);
    if (!u) return { ok: false, reason: 'Unknown user' };
    if (s.exempt.includes(u.admin_role)) return { ok: true, exempt: true };
    const a = await openEntry(uid);
    if (!a) return { ok: false, reason: 'Clock in to start selling.' };
    if (a.mode !== 'onsite') return { ok: false, reason: 'You are clocked in as Remote: take payment at the shop, or send the order to a cashier.' };
    if (!(await onSite(req))) return { ok: false, reason: 'Money can only be taken on a shop device.' };
    if (a.outside_shift && a.ot_status === 'rejected') return { ok: false, reason: 'Your overtime today was not approved.' };
    const end = endOf(a);
    if (Date.now() <= end.getTime()) return { ok: true, entry: a };
    const { rows: ext } = await query(`SELECT created_at FROM clock_requests WHERE attendance_id = $1 AND kind = 'extension' AND status = 'pending' ORDER BY id DESC LIMIT 1`, [a.id]);
    if (ext.length && Date.now() - new Date(ext[0].created_at).getTime() <= s.grace * 60000) return { ok: true, entry: a, grace: true };
    return { ok: false, reason: 'Your shift has ended. Ask for an extension to keep working.' };
  }
  // Mounted on every request; only POSTs to the money routes are checked.
  async function billingGate(req, res, next) {
    try {
      if (req.method !== 'POST' || !BILLING.some((re) => re.test(req.path))) return next();
      if (req.path === '/api/admin/pos/sale' && req.body && req.body.dry_run === true) return next();
      if (!(await settings()).enforce) return next();
      const p = await presence(req);
      if (p.ok) return next();
      res.status(403).json({ error: p.reason, code: 'clock' });
    } catch (e) { next(e); }
  }
  app.use(billingGate);

  // Clocked out by the system: sessions started before this are ended.
  const forcedOut = new Map();
  app.use((req, res, next) => {
    if (req.session && req.session.userId) {
      if (!req.session.since) req.session.since = Date.now();
      const f = forcedOut.get(req.session.userId);
      if (f && req.session.since < f) req.session = null;
    }
    next();
  });

  // ------------------------------------------------------------- email --
  async function approvers(uid) {
    const { rows } = await query(
      `SELECT DISTINCT u.id, u.name, u.email FROM users u
        WHERE NOT u.disabled AND u.email NOT ILIKE '%.local' AND (
              u.admin_role = 'owner'
           OR u.id = (SELECT approver_user_id FROM staff_clock WHERE user_id = $1)
           OR u.id IN (SELECT d.manager_user_id FROM user_departments ud JOIN departments d ON d.id = ud.department_id WHERE ud.user_id = $1))`, [uid]);
    return rows;
  }
  async function baseUrl(req) {
    const s = await settings();
    if (s.base) return s.base.replace(/\/$/, '');
    return req ? (req.headers['x-forwarded-proto'] || req.protocol || 'http') + '://' + req.get('host') : '';
  }
  const KIND = { extension: 'Extra time', overtime: 'Overtime (outside the shift)', correction: 'Time correction' };
  async function mailRequest(req, r, u, links) {
    if (!mailer) return;
    const base = await baseUrl(req);
    const what = r.kind === 'extension' ? r.minutes + ' more minutes today' : r.kind === 'overtime' ? 'clocked in outside the shift' : 'change of times: ' + JSON.stringify(r.wanted || {});
    const shop = (getShopName && await getShopName()) || 'Vision Auto Solutions';
    for (const a of links) {
      const link = base + '/clock-decide.html?t=' + a.token;
      const text = `${u.name} asks for: ${KIND[r.kind]}\n${what}\nReason: ${r.reason}\n\nApprove or reject (this link is yours, works once, expires ${new Date(r.expires_at).toLocaleString('en-JM', { timeZone: TZ })}):\n${link}`;
      mailer.sendEmail({ to: a.email, subject: `[${shop}] ${KIND[r.kind]}: ${u.name}`, text, html: '<p>' + text.replace(/[<>&]/g, '').replace(/\n/g, '<br>').replace(link, '<a href="' + link + '">' + link + '</a>') + '</p>' }).catch(() => {});
    }
    if (u.email && !/\.local$/i.test(u.email)) mailer.sendEmail({ to: u.email, subject: `[${shop}] Your request: ${KIND[r.kind]}`, text: `We sent your request to the manager.\n${what}\nReason: ${r.reason}` }).catch(() => {});
  }
  async function mailDecision(r, status, by) {
    if (!mailer) return;
    const { rows } = await query(`SELECT name, email FROM users WHERE id = $1`, [r.user_id]);
    if (!rows.length || !rows[0].email || /\.local$/i.test(rows[0].email)) return;
    mailer.sendEmail({ to: rows[0].email, subject: 'Your request was ' + status, text: `${KIND[r.kind]}: ${status}${by ? ' by ' + by : ''}.${r.decision_note ? '\nNote: ' + r.decision_note : ''}` }).catch(() => {});
  }
  async function makeRequest(req, c, row, u) {
    const hours = row.kind === 'extension' ? 2 : 24 * 7;
    const { rows } = await c.query(
      `INSERT INTO clock_requests (user_id, attendance_id, kind, minutes, reason, wanted, original, token_hash, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, NOW() + make_interval(hours => $9)) RETURNING *`,
      [u.id, row.attendance_id || null, row.kind, row.minutes || null, row.reason, row.wanted ? JSON.stringify(row.wanted) : null, row.original ? JSON.stringify(row.original) : null, null, hours]);
    // One single-use link per approver, so an emailed decision names who made it.
    const links = [];
    for (const a of await approvers(u.id)) {
      if (a.id === u.id) continue;
      const token = crypto.randomBytes(24).toString('base64url');
      await c.query(`INSERT INTO clock_request_links (token_hash, request_id, user_id) VALUES ($1,$2,$3)`, [sha(token), rows[0].id, a.id]);
      links.push({ id: a.id, name: a.name, email: a.email, token });
    }
    mailRequest(req, rows[0], u, links).catch(() => {});
    return rows[0];
  }
  async function decide(c, r, approve, byUser, via, note) {
    if (r.status !== 'pending') throw httpError(409, 'Already ' + r.status);
    if (new Date(r.expires_at) < new Date()) { await c.query(`UPDATE clock_requests SET status = 'expired' WHERE id = $1`, [r.id]); throw httpError(410, 'This request has expired'); }
    if (byUser && byUser === r.user_id) throw httpError(403, 'Someone else must decide your own request');
    const status = approve ? 'approved' : 'rejected';
    await c.query(`UPDATE clock_requests SET status = $2, decided_by = $3, decided_at = NOW(), decided_via = $4, decision_note = $5, token_hash = NULL WHERE id = $1`, [r.id, status, byUser || null, via, note || null]);
    await c.query(`DELETE FROM clock_request_links WHERE request_id = $1`, [r.id]);
    if (r.kind === 'overtime') await c.query(`UPDATE attendance SET ot_status = $2 WHERE id = $1`, [r.attendance_id, status]);
    if (r.kind === 'extension' && approve) {
      const { rows } = await c.query(`SELECT * FROM attendance WHERE id = $1`, [r.attendance_id]);
      if (rows.length) {
        const base = Math.max(endOf(rows[0]).getTime(), Date.now());
        await c.query(`UPDATE attendance SET ext_until = $2 WHERE id = $1`, [r.attendance_id, new Date(base + r.minutes * 60000)]);
        if (rows[0].clock_out_at && rows[0].auto_closed) await c.query(`UPDATE attendance SET clock_out_at = NULL, auto_closed = false, closed_note = 'reopened: extension approved' WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM attendance x WHERE x.user_id = $2 AND x.clock_out_at IS NULL)`, [r.attendance_id, r.user_id]);
      }
    }
    if (r.kind === 'correction' && approve) {
      const w = r.wanted || {};
      if (r.attendance_id) {
        await c.query(`UPDATE attendance SET clock_in_at = COALESCE($2, clock_in_at), clock_out_at = COALESCE($3, clock_out_at), edited = true, work_day = (COALESCE($2, clock_in_at) AT TIME ZONE '${TZ}')::date WHERE id = $1`,
          [r.attendance_id, w.clock_in_at || null, w.clock_out_at || null]);
      } else {
        await c.query(`INSERT INTO attendance (user_id, work_day, clock_in_at, clock_out_at, method_in, method_out, edited, closed_note) VALUES ($1, ($2::timestamptz AT TIME ZONE '${TZ}')::date, $2, $3, 'manager', 'manager', true, 'added by an approved correction')`,
          [r.user_id, w.clock_in_at, w.clock_out_at]);
      }
    }
    const { rows: by } = byUser ? await c.query(`SELECT name FROM users WHERE id = $1`, [byUser]) : { rows: [] };
    mailDecision(Object.assign({}, r, { decision_note: note }), status, by[0] && by[0].name).catch(() => {});
    return status;
  }

  // -------------------------------------------------------------- punch --
  const PIN_TRIES = new Map();
  function throttle(req) {
    const k = ipOf(req), r = PIN_TRIES.get(k) || { n: 0, first: Date.now() };
    if (Date.now() - r.first > 10 * 60000) { r.n = 0; r.first = Date.now(); }
    if (r.n >= 8) throw httpError(429, 'Too many wrong tries. Wait a few minutes.');
    return () => { r.n++; PIN_TRIES.set(k, r); };
  }
  function rpOf(req, base) {
    const host = (base ? new URL(base).hostname : null) || String(req.get('host') || 'localhost').split(':')[0];
    const origins = [(req.headers['x-forwarded-proto'] || req.protocol || 'http') + '://' + req.get('host')];
    if (base) origins.push(base.replace(/\/$/, ''));
    return { rpId: host, origins };
  }
  // Who is punching. Returns {user, method}.
  async function identify(req, b) {
    const bump = throttle(req);
    const method = String(b.method || '');
    let uid = null;
    if (method === 'pin') {
      const pin = String(b.pin || '').trim();
      if (!/^\d{4,8}$/.test(pin)) throw httpError(400, 'Type your PIN');
      const { rows } = await query(`SELECT id, pin_hash FROM users WHERE pin_hash IS NOT NULL AND is_staff AND NOT disabled`);
      for (const r of rows) if (await bcrypt.compare(pin, r.pin_hash)) { uid = r.id; break; }
      if (!uid) { bump(); throw httpError(401, 'PIN not recognised'); }
    } else if (method === 'password') {
      const { rows } = await query(`SELECT id, password_hash, locked_until > NOW() AS locked FROM users WHERE lower(email) = lower($1) AND NOT disabled AND (is_staff OR is_admin)`, [String(b.email || '')]);
      if (!rows.length || rows[0].locked || !(await bcrypt.compare(String(b.password || ''), rows[0].password_hash || ''))) { bump(); throw httpError(401, 'Email or password not right'); }
      uid = rows[0].id;
    } else if (method === 'badge') {
      const code = String(b.badge || '').trim().replace(/^BADGE:/i, '');
      if (code.length < 10) throw httpError(400, 'Scan your badge');
      const { rows } = await query(`SELECT user_id FROM staff_clock WHERE badge_hash = $1`, [sha(code)]);
      if (!rows.length) { bump(); throw httpError(401, 'Badge not recognised (lost badges are switched off)'); }
      uid = rows[0].user_id;
    } else if (method === 'biometric') {
      const ch = req.session && req.session.waAuth;
      if (!ch || ch.exp < Date.now()) throw httpError(400, 'Start the fingerprint / face check again');
      req.session.waAuth = null;
      const cred = b.credential || {};
      const { rows } = await query(`SELECT * FROM passkeys WHERE credential_id = $1`, [String(cred.id || '')]);
      if (!rows.length) { bump(); throw httpError(401, 'This fingerprint / face key is not enrolled'); }
      const v = wa.verifyAssertion(cred, { jwk: rows[0].public_key, sign_count: rows[0].sign_count }, Object.assign({ challenge: ch.challenge }, rpOf(req, (await settings()).base)));
      await query(`UPDATE passkeys SET sign_count = $2, last_used_at = NOW() WHERE id = $1`, [rows[0].id, v.signCount]);
      uid = rows[0].user_id;
    } else throw httpError(400, 'Choose how to clock in');
    const u = await staffRow(uid);
    if (!u || u.disabled || !(u.is_staff || u.is_admin)) throw httpError(403, 'This account cannot use the time clock');
    if (!u.methods.includes(method)) throw httpError(403, 'You cannot clock in with ' + method + ': ask a manager');
    return { user: u, method };
  }
  function savePhoto(dataUrl) {
    const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
    if (!m) return null;
    const buf = Buffer.from(m[1], 'base64');
    if (buf.length > 400000 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
    const name = crypto.randomBytes(16).toString('hex') + '.jpg';
    fs.writeFileSync(path.join(PHOTO_DIR, name), buf, { flag: 'wx' });
    return name;
  }
  async function doPunch(req, u, method, b) {
    const s = await settings();
    let action = String(b.action || '');
    if (action === 'toggle') action = (await openEntry(u.id)) ? 'out' : 'in';   // a badge scan: in if out, out if in
    const here = await onSite(req);
    const where = String(req.get('x-terminal') || '').slice(0, 60) || ipOf(req);
    return tx(async (c) => {
      const open = await openEntry(u.id, c.query.bind(c));
      if (action === 'in') {
        if (open) throw httpError(409, 'You are already clocked in since ' + fmtT(open.clock_in_at));
        if (u.require_biometric && method !== 'biometric') throw httpError(403, 'You must clock in with your fingerprint / face, at the time clock');
        let mode = 'onsite';
        if (!here) { if (!u.remote_allowed) throw httpError(403, 'Clock in at the shop (on a shop device or the shop Wi-Fi).'); mode = 'remote'; }
        if (s.photo && !b.photo && method !== 'session') throw httpError(400, 'A photo is needed to clock in', { need_photo: true });
        const now = Date.now();
        let day = jmDay();
        let sh = await shiftFor(u.id, day, c.query.bind(c));
        let inside = !sh.off && now >= sh.start.getTime() - s.early * 60000 && now < sh.end.getTime();
        if (!inside) {   // after midnight on an overnight shift that began yesterday
          const yday = jmDay(now - 86400000), ysh = await shiftFor(u.id, yday, c.query.bind(c));
          if (!ysh.off && now >= ysh.start.getTime() && now < ysh.end.getTime()) { day = yday; sh = ysh; inside = true; }
        }
        if (!inside && !b.confirm_overtime) {
          throw httpError(409, sh.off ? sh.off + '. Clocking in now is overtime: confirm and give the reason.' : now < sh.start.getTime() ? 'Your shift starts at ' + fmtT(sh.start) + '. Clocking in now is overtime: confirm and give the reason.' : 'Your shift ended at ' + fmtT(sh.end) + '. Clocking in now is overtime: confirm and give the reason.', { need_overtime: true });
        }
        const reason = String(b.ot_reason || '').trim().slice(0, 300);
        if (!inside && reason.length < 3) throw httpError(400, 'Say why you are working outside your shift', { need_overtime: true });
        const { rows } = await c.query(
          `INSERT INTO attendance (user_id, work_day, mode, method_in, where_in, photo_in, shift_start, shift_end, outside_shift, ot_reason, ot_status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
          [u.id, day, mode, method, where, b.photo ? savePhoto(b.photo) : null, sh.start || null, sh.end || null, !inside, inside ? null : reason, inside ? 'none' : 'pending']);
        if (!inside) await makeRequest(req, c, { kind: 'overtime', attendance_id: rows[0].id, reason }, u);
        return { done: 'in', entry: rows[0], message: 'Clocked in ' + fmtT(rows[0].clock_in_at) + (mode === 'remote' ? ' (Remote: no payments)' : '') + (inside ? '' : ' · overtime sent for approval') };
      }
      if (!open) throw httpError(409, 'You are not clocked in');
      if (action === 'out') {
        const { rows: drawer } = await c.query(`SELECT st.name FROM till_sessions t JOIN pos_stations st ON st.id = t.station_id WHERE t.user_id = $1 AND t.status = 'open' LIMIT 1`, [u.id]);
        if (drawer.length && !b.force) throw httpError(409, 'Your cash drawer at ' + drawer[0].name + ' is still open: close it or hand it over first.', { drawer_open: true });
        await c.query(`UPDATE attendance_breaks SET end_at = NOW() WHERE attendance_id = $1 AND end_at IS NULL`, [open.id]);
        const { rows } = await c.query(`UPDATE attendance SET clock_out_at = NOW(), method_out = $2, photo_out = $3 WHERE id = $1 RETURNING *`, [open.id, method, b.photo ? savePhoto(b.photo) : null]);
        return { done: 'out', entry: rows[0], message: 'Clocked out ' + fmtT(rows[0].clock_out_at) };
      }
      if (action === 'break_start' || action === 'lunch_start') {
        const { rows: br } = await c.query(`SELECT 1 FROM attendance_breaks WHERE attendance_id = $1 AND end_at IS NULL`, [open.id]);
        if (br.length) throw httpError(409, 'You are already on a break');
        await c.query(`INSERT INTO attendance_breaks (attendance_id, kind) VALUES ($1, $2)`, [open.id, action === 'lunch_start' ? 'lunch' : 'break']);
        return { done: action, message: (action === 'lunch_start' ? 'Lunch' : 'Break') + ' started ' + fmtT(new Date()) };
      }
      if (action === 'break_end') {
        const { rowCount } = await c.query(`UPDATE attendance_breaks SET end_at = NOW() WHERE attendance_id = $1 AND end_at IS NULL`, [open.id]);
        if (!rowCount) throw httpError(409, 'You are not on a break');
        return { done: 'break_end', message: 'Back from break ' + fmtT(new Date()) };
      }
      throw httpError(400, 'Clock in, clock out, or a break?');
    });
  }

  app.post('/api/clock/punch', async (req, res) => {
    try {
      const b = req.body || {};
      const who = await identify(req, b);
      const out = await doPunch(req, who.user, who.method, b);
      res.json(Object.assign({ name: who.user.name }, out));
    } catch (e) { fail(res, e); }
  });
  // Fingerprint / face: challenge first, then /punch with the signed answer.
  app.post('/api/clock/passkeys/auth-options', async (req, res) => {
    try {
      const s = await settings();
      const challenge = wa.newChallenge();
      req.session.waAuth = { challenge, exp: Date.now() + 120000 };
      const rp = rpOf(req, s.base);
      res.json({ challenge, rpId: rp.rpId, timeout: 60000, userVerification: 'required', allowCredentials: [] });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------- me (signed in) --
  app.get('/api/clock/me', requireAdmin, async (req, res) => {
    try {
      const s = await settings();
      const uid = req.session.userId;
      const a = await openEntry(uid);
      const u = await staffRow(uid);
      const p = await presence(req);
      let end = null, minutes_left = null, pending = null, on_break = null;
      if (a) {
        end = endOf(a); minutes_left = Math.floor((end.getTime() - Date.now()) / 60000);
        const { rows } = await query(`SELECT id, kind, minutes, created_at FROM clock_requests WHERE attendance_id = $1 AND status = 'pending' ORDER BY id DESC LIMIT 1`, [a.id]);
        pending = rows[0] || null;
        const { rows: br } = await query(`SELECT kind, start_at FROM attendance_breaks WHERE attendance_id = $1 AND end_at IS NULL`, [a.id]);
        on_break = br[0] || null;
      }
      res.json({ enforce: s.enforce, exempt: s.exempt.includes(u.admin_role), clocked_in: !!a, entry: a ? { since: a.clock_in_at, mode: a.mode, outside_shift: a.outside_shift, ot_status: a.ot_status } : null,
        ends_at: end, minutes_left, warn: minutes_left != null && minutes_left <= 15 ? (minutes_left <= 5 ? 5 : 15) : null, pending, on_break,
        can_bill: p.ok, reason: p.ok ? null : p.reason, remote_allowed: u.remote_allowed });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/clock/me/punch', requireAdmin, async (req, res) => {
    try {
      const u = await staffRow(req.session.userId);
      const out = await doPunch(req, u, 'session', req.body || {});
      res.json(out);
    } catch (e) { fail(res, e); }
  });
  app.post('/api/clock/me/extension', requireAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      const minutes = parseInt(b.minutes, 10);
      if (!(minutes >= 15 && minutes <= 240)) throw httpError(400, 'Between 15 minutes and 4 hours');
      const reason = String(b.reason || '').trim().slice(0, 300);
      if (reason.length < 3) throw httpError(400, 'Say why you need more time');
      const u = await staffRow(req.session.userId);
      const a = await openEntry(u.id);
      if (!a) throw httpError(409, 'You are not clocked in');
      const r = await tx(async (c) => {
        const { rows } = await c.query(`SELECT 1 FROM clock_requests WHERE attendance_id = $1 AND kind = 'extension' AND status = 'pending'`, [a.id]);
        if (rows.length) throw httpError(409, 'You already asked; wait for the answer');
        return makeRequest(req, c, { kind: 'extension', attendance_id: a.id, minutes, reason }, u);
      });
      res.json({ ok: true, id: r.id, grace_minutes: (await settings()).grace });
    } catch (e) { fail(res, e); }
  });
  // Missed punch: ask for a change, a manager approves; the original is kept.
  app.post('/api/clock/me/correction', requireAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      const reason = String(b.reason || '').trim().slice(0, 300);
      if (reason.length < 3) throw httpError(400, 'Say what happened');
      const iso = (v) => (v && !isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
      const wanted = { clock_in_at: iso(b.clock_in_at), clock_out_at: iso(b.clock_out_at) };
      if (!wanted.clock_in_at && !wanted.clock_out_at) throw httpError(400, 'Give the right time in and / or out');
      if (wanted.clock_in_at && wanted.clock_out_at && wanted.clock_out_at <= wanted.clock_in_at) throw httpError(400, 'Out must be after in');
      const u = await staffRow(req.session.userId);
      let original = null, attId = null;
      if (b.attendance_id) {
        const { rows } = await query(`SELECT id, clock_in_at, clock_out_at FROM attendance WHERE id = $1 AND user_id = $2`, [b.attendance_id, u.id]);
        if (!rows.length) throw httpError(404, 'Not your entry');
        original = rows[0]; attId = rows[0].id;
      } else if (!wanted.clock_in_at || !wanted.clock_out_at) throw httpError(400, 'For a missed day give both the time in and the time out');
      const r = await tx((c) => makeRequest(req, c, { kind: 'correction', attendance_id: attId, reason, wanted, original }, u));
      res.json({ ok: true, id: r.id });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/clock/me/history', requireAdmin, async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT a.id, a.work_day, a.clock_in_at, a.clock_out_at, a.mode, a.outside_shift, a.ot_status, a.auto_closed, a.edited,
                (SELECT json_agg(json_build_object('kind', b.kind, 'start', b.start_at, 'end', b.end_at)) FROM attendance_breaks b WHERE b.attendance_id = a.id) AS breaks
           FROM attendance a WHERE a.user_id = $1 ORDER BY a.clock_in_at DESC LIMIT 60`, [req.session.userId]);
      const { rows: reqs } = await query(`SELECT id, kind, minutes, reason, status, created_at, decided_at, decision_note FROM clock_requests WHERE user_id = $1 ORDER BY id DESC LIMIT 30`, [req.session.userId]);
      res.json({ entries: rows, requests: reqs });
    } catch (e) { fail(res, e); }
  });

  // ----------------------------------------------------- end of shift --
  const sweep = setInterval(async () => {
    try {
      const s = await settings();
      // Extension requests not answered in time.
      await query(`UPDATE clock_requests SET status = 'expired', token_hash = NULL WHERE status = 'pending' AND expires_at < NOW()`);
      await query(`DELETE FROM clock_request_links l USING clock_requests r WHERE r.id = l.request_id AND r.status <> 'pending'`);
      const { rows } = await query(`SELECT a.* FROM attendance a WHERE a.clock_out_at IS NULL`);
      for (const a of rows) {
        const end = endOf(a);
        if (Date.now() <= end.getTime()) continue;
        const { rows: ext } = await query(`SELECT created_at FROM clock_requests WHERE attendance_id = $1 AND kind = 'extension' AND status = 'pending' ORDER BY id DESC LIMIT 1`, [a.id]);
        if (ext.length && Date.now() - new Date(ext[0].created_at).getTime() <= s.grace * 60000) continue;
        const { rows: drawer } = await query(`SELECT 1 FROM till_sessions WHERE user_id = $1 AND status = 'open' LIMIT 1`, [a.user_id]);
        if (drawer.length) { await query(`UPDATE attendance SET closed_note = 'Shift over; cash drawer still open' WHERE id = $1 AND closed_note IS DISTINCT FROM 'Shift over; cash drawer still open'`, [a.id]); continue; }
        await query(`UPDATE attendance_breaks SET end_at = LEAST(NOW(), $2) WHERE attendance_id = $1 AND end_at IS NULL`, [a.id, end]);
        await query(`UPDATE attendance SET clock_out_at = GREATEST($2, clock_in_at), method_out = 'auto', auto_closed = true, closed_note = 'Clocked out at the end of the shift' WHERE id = $1 AND clock_out_at IS NULL`, [a.id, end]);
        forcedOut.set(a.user_id, Date.now());
      }
    } catch (e) { console.warn('[clock] sweep', e.message); }
  }, 60000);
  if (sweep.unref) sweep.unref();

  // --------------------------------------------------------- decisions --
  app.get('/api/clock/decide/:token', async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT r.id, r.kind, r.minutes, r.reason, r.wanted, r.original, r.status, r.expires_at, r.created_at, u.name, a.clock_in_at, a.shift_end, ap.name AS approver
           FROM clock_request_links l JOIN clock_requests r ON r.id = l.request_id JOIN users u ON u.id = r.user_id JOIN users ap ON ap.id = l.user_id
           LEFT JOIN attendance a ON a.id = r.attendance_id WHERE l.token_hash = $1`, [sha(req.params.token)]);
      if (!rows.length) throw httpError(404, 'This link has been used or is not valid');
      res.set('Cache-Control', 'no-store');
      res.json(Object.assign({ what: KIND[rows[0].kind] }, rows[0]));
    } catch (e) { fail(res, e); }
  });
  // A POST, so an email scanner opening the link cannot decide it.
  app.post('/api/clock/decide/:token', async (req, res) => {
    try {
      const b = req.body || {};
      const out = await tx(async (c) => {
        const { rows: l } = await c.query(`SELECT request_id, user_id FROM clock_request_links WHERE token_hash = $1`, [sha(req.params.token)]);
        if (!l.length) throw httpError(404, 'This link has been used or is not valid');
        const { rows } = await c.query(`SELECT * FROM clock_requests WHERE id = $1 FOR UPDATE`, [l[0].request_id]);
        return decide(c, rows[0], b.decision === 'approve', l[0].user_id, 'email', String(b.note || '').slice(0, 300));
      });
      res.json({ ok: true, status: out });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/clock/requests', ...can('clock.approve'), async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT r.*, u.name, d.name AS decided_by_name, a.clock_in_at, a.shift_end, a.work_day FROM clock_requests r JOIN users u ON u.id = r.user_id
           LEFT JOIN users d ON d.id = r.decided_by LEFT JOIN attendance a ON a.id = r.attendance_id
          WHERE r.status = 'pending' OR r.created_at > NOW() - INTERVAL '14 days' ORDER BY (r.status = 'pending') DESC, r.id DESC LIMIT 200`);
      res.json({ requests: rows.map((r) => { delete r.token_hash; return r; }) });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/clock/requests/:id/decide', ...can('clock.approve'), async (req, res) => {
    try {
      const b = req.body || {};
      const out = await tx(async (c) => {
        const { rows } = await c.query(`SELECT * FROM clock_requests WHERE id = $1 FOR UPDATE`, [req.params.id]);
        if (!rows.length) throw httpError(404, 'Request not found');
        return decide(c, rows[0], b.decision === 'approve', req.session.userId, 'screen', String(b.note || '').slice(0, 300));
      });
      res.json({ ok: true, status: out });
    } catch (e) { fail(res, e); }
  });

  // ----------------------------------------------------------- reports --
  app.get('/api/clock/now', ...can('clock.approve'), async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT a.id, u.id AS user_id, u.name, a.clock_in_at, a.mode, a.shift_end, a.ext_until, a.outside_shift, a.ot_status, a.closed_note,
                (SELECT kind FROM attendance_breaks b WHERE b.attendance_id = a.id AND b.end_at IS NULL LIMIT 1) AS on_break
           FROM attendance a JOIN users u ON u.id = a.user_id WHERE a.clock_out_at IS NULL ORDER BY u.name`);
      res.json({ in: rows.map((r) => Object.assign(r, { ends_at: endOf(r) })) });
    } catch (e) { fail(res, e); }
  });
  // Today: who should be in, who is late or absent, on leave.
  app.get('/api/clock/today', ...can('clock.approve'), async (req, res) => {
    try {
      const s = await settings();
      const day = /^\d{4}-\d{2}-\d{2}$/.test(req.query.day || '') ? req.query.day : jmDay();
      const { rows: staff } = await query(`SELECT id, name FROM users WHERE is_staff AND NOT disabled AND admin_role <> 'rep' ORDER BY name`);
      const out = [];
      for (const u of staff) {
        const sh = await shiftFor(u.id, day);
        const { rows: att } = await query(`SELECT clock_in_at, clock_out_at, auto_closed, outside_shift, ot_status FROM attendance WHERE user_id = $1 AND work_day = $2 ORDER BY clock_in_at`, [u.id, day]);
        if (sh.off && !att.length) { if (!/No shift/.test(sh.off)) out.push({ user_id: u.id, name: u.name, status: 'off', note: sh.off }); continue; }
        const first = att[0], last = att[att.length - 1];
        let status = 'scheduled', note = '';
        if (!att.length) status = !sh.off && Date.now() > sh.start.getTime() + s.late * 60000 ? 'absent' : 'not in yet';
        else {
          status = last.clock_out_at ? 'gone' : 'in';
          if (!sh.off && new Date(first.clock_in_at).getTime() > sh.start.getTime() + s.late * 60000) note = 'late ' + Math.round((new Date(first.clock_in_at) - sh.start) / 60000) + ' min';
          if (!sh.off && last.clock_out_at && !last.auto_closed && new Date(last.clock_out_at).getTime() < sh.end.getTime() - s.late * 60000) note += (note ? ', ' : '') + 'left ' + Math.round((sh.end - new Date(last.clock_out_at)) / 60000) + ' min early';
          if (att.some((x) => x.outside_shift)) note += (note ? ', ' : '') + 'overtime ' + att.find((x) => x.outside_shift).ot_status;
        }
        out.push({ user_id: u.id, name: u.name, status, note, shift: sh.off ? sh.off : fmtT(sh.start) + '–' + fmtT(sh.end), first_in: first && first.clock_in_at, last_out: last && last.clock_out_at });
      }
      res.json({ day, staff: out });
    } catch (e) { fail(res, e); }
  });

  // Timesheet maths for one person and one week (Monday start).
  async function weekFor(uid, monday) {
    const s = await settings();
    const { rows: cfg } = await query(`SELECT COALESCE(hourly_rate, 0) AS rate, COALESCE(ot_daily_hours, 8) AS d, COALESCE(ot_weekly_hours, 40) AS w, COALESCE(ot_rate, 1.5) AS r FROM staff_clock WHERE user_id = $1`, [uid]);
    const c = cfg[0] || { rate: 0, d: 8, w: 40, r: 1.5 };
    const days = [];
    let regTotal = 0, otTotal = 0, pending = 0, rejected = 0, late = 0, early = 0, absent = 0;
    for (let i = 0; i < 7; i++) {
      const day = new Date(new Date(monday + 'T12:00:00Z').getTime() + i * 86400000).toISOString().slice(0, 10);
      const sh = await shiftFor(uid, day);
      const { rows: att } = await query(
        `SELECT a.*, (SELECT COALESCE(json_agg(json_build_object('kind', b.kind, 'start', b.start_at, 'end', b.end_at)), '[]') FROM attendance_breaks b WHERE b.attendance_id = a.id) AS breaks
           FROM attendance a WHERE a.user_id = $1 AND a.work_day = $2 ORDER BY a.clock_in_at`, [uid, day]);
      let worked = 0, unpaid = 0, lunchPunched = false, dayPending = 0, dayRejected = 0;
      for (const a of att) {
        const outAt = a.clock_out_at ? new Date(a.clock_out_at) : new Date(Math.min(Date.now(), endOf(a).getTime()));
        const mins = Math.max(0, (outAt - new Date(a.clock_in_at)) / 60000);
        let brk = 0;
        for (const b of a.breaks) {
          const bm = Math.max(0, ((b.end ? new Date(b.end) : outAt) - new Date(b.start)) / 60000);
          if (b.kind === 'lunch') { brk += bm; lunchPunched = true; } else brk += Math.max(0, bm - s.paidBreak);
        }
        const net = Math.max(0, mins - brk);
        if (a.outside_shift && a.ot_status === 'pending') dayPending += net;
        else if (a.outside_shift && a.ot_status === 'rejected') dayRejected += net;
        else worked += net;
        unpaid += brk;
      }
      // A shift's break comes off a long day when none was punched.
      let autoBreak = 0;
      if (!lunchPunched && !sh.off && worked >= 360) { autoBreak = n(sh.break_minutes); worked = Math.max(0, worked - autoBreak); }
      const hours = worked / 60;
      const dayOt = Math.max(0, hours - n(c.d));
      const first = att[0], last = att[att.length - 1];
      const isLate = !sh.off && first && new Date(first.clock_in_at).getTime() > sh.start.getTime() + s.late * 60000;
      const isEarly = !sh.off && last && last.clock_out_at && !last.auto_closed && new Date(last.clock_out_at).getTime() < sh.end.getTime() - s.late * 60000;
      const isAbsent = !sh.off && !att.length && sh.start.getTime() < Date.now();
      late += isLate ? 1 : 0; early += isEarly ? 1 : 0; absent += isAbsent ? 1 : 0;
      pending += dayPending / 60; rejected += dayRejected / 60;
      days.push({ day, shift: sh.off ? sh.off : fmtT(sh.start) + '–' + fmtT(sh.end), entries: att.map((a) => ({ id: a.id, in: a.clock_in_at, out: a.clock_out_at, mode: a.mode, outside: a.outside_shift, ot: a.ot_status, auto: a.auto_closed, edited: a.edited, photo_in: a.photo_in, photo_out: a.photo_out })),
        hours: r2(hours), day_ot: r2(dayOt), unpaid_breaks_min: Math.round(unpaid + autoBreak), auto_break_min: autoBreak, late: isLate, early: isEarly, absent: isAbsent,
        ot_pending_h: r2(dayPending / 60), ot_rejected_h: r2(dayRejected / 60) });
      regTotal += hours - dayOt; otTotal += dayOt;
    }
    if (regTotal > n(c.w)) { otTotal += regTotal - n(c.w); regTotal = n(c.w); }
    const pay = { regular: r2(regTotal * n(c.rate)), overtime: r2(otTotal * n(c.rate) * n(c.r)) };
    const { rows: com } = await query(
      `SELECT COALESCE(SUM(e.amount), 0) AS v FROM commission_entries e JOIN mechanics m ON m.id = e.rep_id
        WHERE m.user_id = $1 AND e.status NOT IN ('void', 'pending') AND e.earned_at >= ($2::date)::timestamp AT TIME ZONE '${TZ}' AND e.earned_at < ($2::date + 7)::timestamp AT TIME ZONE '${TZ}'`, [uid, monday]);
    return { days, totals: { regular_h: r2(regTotal), overtime_h: r2(otTotal), ot_pending_h: r2(pending), ot_rejected_h: r2(rejected), late, early, absent,
      rate: n(c.rate), ot_rate: n(c.r), ot_daily: n(c.d), ot_weekly: n(c.w), pay_regular: pay.regular, pay_overtime: pay.overtime, commission: r2(com[0].v),
      gross: r2(pay.regular + pay.overtime + n(com[0].v)) } };
  }
  const mondayOf = (d) => { const x = new Date((d || jmDay()) + 'T12:00:00Z'); const wd = (x.getUTCDay() + 6) % 7; return new Date(x.getTime() - wd * 86400000).toISOString().slice(0, 10); };
  app.get('/api/clock/timesheet', ...can('clock.manage'), async (req, res) => {
    try {
      const monday = mondayOf(/^\d{4}-\d{2}-\d{2}$/.test(req.query.week || '') ? req.query.week : null);
      const uid = parseInt(req.query.user, 10) || null;
      const { rows: staff } = await query(`SELECT id, name FROM users WHERE is_staff AND admin_role <> 'rep' AND ($1::int IS NULL OR id = $1) AND (NOT disabled OR EXISTS (SELECT 1 FROM attendance a WHERE a.user_id = users.id AND a.work_day >= $2::date AND a.work_day < $2::date + 7)) ORDER BY name`, [uid, monday]);
      const out = [];
      for (const u of staff) {
        const { rows: ap } = await query(`SELECT t.totals, t.approved_at, a.name AS approved_by FROM timesheet_weeks t LEFT JOIN users a ON a.id = t.approved_by WHERE t.user_id = $1 AND t.week_start = $2`, [u.id, monday]);
        const w = await weekFor(u.id, monday);
        if (!uid && !w.days.some((d) => d.entries.length || d.absent)) continue;
        out.push({ user_id: u.id, name: u.name, approved: ap[0] || null, ...(uid ? w : { totals: w.totals }) });
      }
      res.json({ week_start: monday, staff: out });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/clock/timesheet/approve', ...can('clock.manage'), async (req, res) => {
    try {
      const b = req.body || {};
      const monday = mondayOf(b.week_start), uid = parseInt(b.user_id, 10);
      if (!uid) throw httpError(400, 'Whose week?');
      if (uid === req.session.userId) throw httpError(403, 'Someone else must approve your own timesheet');
      const { rows: p } = await query(`SELECT COUNT(*)::int AS n FROM clock_requests r JOIN attendance a ON a.id = r.attendance_id WHERE r.user_id = $1 AND r.status = 'pending' AND a.work_day >= $2::date AND a.work_day < $2::date + 7`, [uid, monday]);
      if (p[0].n) throw httpError(409, 'Decide the ' + p[0].n + ' waiting request(s) for this week first');
      const w = await weekFor(uid, monday);
      await query(`INSERT INTO timesheet_weeks (user_id, week_start, totals, approved_by) VALUES ($1,$2,$3,$4)
                   ON CONFLICT (user_id, week_start) DO UPDATE SET totals = EXCLUDED.totals, approved_by = EXCLUDED.approved_by, approved_at = NOW()`, [uid, monday, JSON.stringify(w.totals), req.session.userId]);
      res.json({ ok: true, totals: w.totals });
    } catch (e) { fail(res, e); }
  });
  // Payroll: approved weeks (frozen figures); unapproved ones are listed as such.
  app.get('/api/clock/payroll.csv', ...can('clock.manage'), async (req, res) => {
    try {
      const monday = mondayOf(/^\d{4}-\d{2}-\d{2}$/.test(req.query.week || '') ? req.query.week : null);
      const { rows: staff } = await query(`SELECT u.id, u.name, u.employee_no FROM users u WHERE u.is_staff AND u.admin_role <> 'rep' AND EXISTS (SELECT 1 FROM attendance a WHERE a.user_id = u.id AND a.work_day >= $1::date AND a.work_day < $1::date + 7) ORDER BY u.name`, [monday]);
      const lines = [['week_start', 'employee_no', 'name', 'approved', 'regular_hours', 'overtime_hours', 'overtime_pending_hours', 'hourly_rate', 'ot_rate', 'regular_pay', 'overtime_pay', 'commission', 'gross', 'late_days', 'early_days', 'absent_days']];
      for (const u of staff) {
        const { rows: ap } = await query(`SELECT totals FROM timesheet_weeks WHERE user_id = $1 AND week_start = $2`, [u.id, monday]);
        const t = ap.length ? ap[0].totals : (await weekFor(u.id, monday)).totals;
        lines.push([monday, u.employee_no || '', u.name, ap.length ? 'yes' : 'NO', t.regular_h, t.overtime_h, t.ot_pending_h, t.rate, t.ot_rate, t.pay_regular, t.pay_overtime, t.commission, t.gross, t.late, t.early, t.absent]);
      }
      const q = (v) => { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="payroll-week-${monday}.csv"`);
      res.send(lines.map((l) => l.map(q).join(',')).join('\n'));
    } catch (e) { fail(res, e); }
  });
  // Hours against sales: sales per labour hour per person.
  app.get('/api/clock/sales-per-hour', ...can('clock.manage'), async (req, res) => {
    try {
      const iso = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);
      const from = iso(req.query.from), to = iso(req.query.to);
      if (!from || !to) throw httpError(400, 'Choose the dates');
      const { rows } = await query(
        `WITH h AS (SELECT a.user_id, SUM(EXTRACT(EPOCH FROM (COALESCE(a.clock_out_at, NOW()) - a.clock_in_at)) / 3600) AS hours
                      FROM attendance a WHERE a.work_day BETWEEN $1 AND $2 GROUP BY 1),
              s AS (SELECT COALESCE(m.user_id, ps.cashier_id) AS user_id, SUM(ps.total_usd - COALESCE(ps.tax_usd, 0)) AS sales, COUNT(*) AS n
                      FROM pos_sales ps LEFT JOIN mechanics m ON m.id = ps.sales_rep_id
                     WHERE NOT COALESCE(ps.voided, false) AND ps.receipt_number NOT LIKE 'CN%'
                       AND ps.created_at >= ($1::date)::timestamp AT TIME ZONE '${TZ}' AND ps.created_at < ($2::date + 1)::timestamp AT TIME ZONE '${TZ}' GROUP BY 1)
         SELECT u.name, ROUND(h.hours::numeric, 1) AS hours, COALESCE(s.sales, 0) AS sales, COALESCE(s.n, 0)::int AS sales_count,
                CASE WHEN h.hours > 0 THEN ROUND((COALESCE(s.sales, 0) / h.hours)::numeric, 2) END AS per_hour
           FROM h JOIN users u ON u.id = h.user_id LEFT JOIN s ON s.user_id = h.user_id ORDER BY per_hour DESC NULLS LAST`, [from, to]);
      res.json({ rows });
    } catch (e) { fail(res, e); }
  });

  // -------------------------------------------------------- setup --
  app.get('/api/clock/staff', ...can('clock.manage'), async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT u.id, u.name, u.email, u.admin_role, (u.pin_hash IS NOT NULL) AS has_pin, c.methods, c.require_biometric, c.remote_allowed, c.hourly_rate, c.ot_daily_hours, c.ot_weekly_hours, c.ot_rate,
                c.approver_user_id, c.badge_issued_at, (SELECT COUNT(*) FROM passkeys p WHERE p.user_id = u.id)::int AS passkeys,
                COALESCE((SELECT json_agg(json_build_object('weekday', s.weekday, 'start', to_char(s.start_time, 'HH24:MI'), 'end', to_char(s.end_time, 'HH24:MI'), 'break', s.break_minutes) ORDER BY s.weekday) FROM staff_shifts s WHERE s.user_id = u.id), '[]') AS shifts
           FROM users u LEFT JOIN staff_clock c ON c.user_id = u.id WHERE u.is_staff AND NOT u.disabled AND u.admin_role <> 'rep' ORDER BY u.name`);
      const { rows: managers } = await query(`SELECT id, name FROM users WHERE is_staff AND NOT disabled AND admin_role IN ('owner', 'manager') ORDER BY name`);
      const s = await settings();
      res.json({ staff: rows, managers, settings: { enforce: s.enforce, exempt: s.exempt.join(','), early: s.early, late: s.late, grace: s.grace, photo: s.photo, paid_break: s.paidBreak, shop_ips: s.shopIps.join(',') } });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/clock/staff/:id', ...can('clock.manage'), async (req, res) => {
    try {
      const b = req.body || {};
      const uid = parseInt(req.params.id, 10);
      const methods = (Array.isArray(b.methods) ? b.methods : ['pin', 'password', 'badge', 'biometric']).filter((m) => ['pin', 'password', 'badge', 'biometric'].includes(m));
      if (!methods.length) throw httpError(400, 'Leave at least one way to clock in');
      const num = (v, lo, hi, dflt) => { const x = v === '' || v == null ? dflt : Number(v); if (x != null && !(x >= lo && x <= hi)) throw httpError(400, 'A number is out of range'); return x; };
      await query(
        `INSERT INTO staff_clock (user_id, methods, require_biometric, remote_allowed, hourly_rate, ot_daily_hours, ot_weekly_hours, ot_rate, approver_user_id, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
         ON CONFLICT (user_id) DO UPDATE SET methods = EXCLUDED.methods, require_biometric = EXCLUDED.require_biometric, remote_allowed = EXCLUDED.remote_allowed, hourly_rate = EXCLUDED.hourly_rate,
           ot_daily_hours = EXCLUDED.ot_daily_hours, ot_weekly_hours = EXCLUDED.ot_weekly_hours, ot_rate = EXCLUDED.ot_rate, approver_user_id = EXCLUDED.approver_user_id, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
        [uid, methods, !!b.require_biometric, !!b.remote_allowed, num(b.hourly_rate, 0, 100000, null), num(b.ot_daily_hours, 1, 24, 8), num(b.ot_weekly_hours, 1, 100, 40), num(b.ot_rate, 1, 5, 1.5), parseInt(b.approver_user_id, 10) || null, req.session.userId]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/clock/staff/:id/shifts', ...can('clock.manage'), async (req, res) => {
    try {
      const uid = parseInt(req.params.id, 10);
      const list = (Array.isArray((req.body || {}).shifts) ? req.body.shifts : []).filter((s) => s && s.start && s.end);
      for (const s of list) {
        if (!(s.weekday >= 0 && s.weekday <= 6) || !/^\d{2}:\d{2}$/.test(s.start) || !/^\d{2}:\d{2}$/.test(s.end)) throw httpError(400, 'Times as HH:MM');
      }
      await tx(async (c) => {
        await c.query(`DELETE FROM staff_shifts WHERE user_id = $1`, [uid]);
        for (const s of list) await c.query(`INSERT INTO staff_shifts (user_id, weekday, start_time, end_time, break_minutes) VALUES ($1,$2,$3,$4,$5)`, [uid, s.weekday, s.start, s.end, Math.max(0, Math.min(240, parseInt(s.break, 10) || 0))]);
      });
      res.json({ ok: true, shifts: list.length });
    } catch (e) { fail(res, e); }
  });
  // A new badge code (the old one stops working). Shown once, for printing.
  app.post('/api/clock/staff/:id/badge', ...can('clock.manage'), async (req, res) => {
    try {
      const uid = parseInt(req.params.id, 10);
      const code = crypto.randomBytes(12).toString('base64url');
      await query(`INSERT INTO staff_clock (user_id, badge_hash, badge_issued_at, updated_by) VALUES ($1,$2,NOW(),$3) ON CONFLICT (user_id) DO UPDATE SET badge_hash = EXCLUDED.badge_hash, badge_issued_at = NOW(), updated_by = EXCLUDED.updated_by`, [uid, sha(code), req.session.userId]);
      const { rows } = await query(`SELECT name FROM users WHERE id = $1`, [uid]);
      res.json({ code: 'BADGE:' + code, name: rows[0] && rows[0].name });
    } catch (e) { fail(res, e); }
  });
  app.delete('/api/clock/staff/:id/badge', ...can('clock.manage'), async (req, res) => {
    try { await query(`UPDATE staff_clock SET badge_hash = NULL, badge_issued_at = NULL WHERE user_id = $1`, [parseInt(req.params.id, 10)]); res.json({ ok: true }); } catch (e) { fail(res, e); }
  });
  // Passkey enrolment: done on the device the person will use, with them there.
  app.post('/api/clock/passkeys/register-options', ...can('clock.manage'), async (req, res) => {
    try {
      const uid = parseInt((req.body || {}).user_id, 10);
      const { rows } = await query(`SELECT id, name, email FROM users WHERE id = $1 AND is_staff`, [uid]);
      if (!rows.length) throw httpError(404, 'Staff member not found');
      const s = await settings(), rp = rpOf(req, s.base);
      const challenge = wa.newChallenge();
      req.session.waReg = { challenge, uid, exp: Date.now() + 180000 };
      const { rows: ex } = await query(`SELECT credential_id FROM passkeys WHERE user_id = $1`, [uid]);
      res.json({ challenge, rp: { id: rp.rpId, name: (getShopName && await getShopName()) || 'Vision Auto Solutions' },
        user: { id: wa.b64u(Buffer.from('vas-staff-' + uid)), name: rows[0].email, displayName: rows[0].name },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }], timeout: 120000, attestation: 'none',
        authenticatorSelection: { userVerification: 'required', residentKey: 'required' }, excludeCredentials: ex.map((x) => ({ type: 'public-key', id: x.credential_id })) });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/clock/passkeys/register', ...can('clock.manage'), async (req, res) => {
    try {
      const ch = req.session.waReg;
      if (!ch || ch.exp < Date.now()) throw httpError(400, 'Start the enrolment again');
      req.session.waReg = null;
      const s = await settings();
      const v = wa.verifyRegistration((req.body || {}).credential, Object.assign({ challenge: ch.challenge }, rpOf(req, s.base)));
      await query(`INSERT INTO passkeys (user_id, credential_id, public_key, sign_count, label, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
        [ch.uid, v.credentialId, JSON.stringify(v.jwk), v.signCount, String((req.body || {}).label || '').slice(0, 60) || null, req.session.userId]);
      res.json({ ok: true });
    } catch (e) { if (e.code === '23505') e = httpError(409, 'That key is already enrolled'); fail(res, e); }
  });
  app.get('/api/clock/staff/:id/passkeys', ...can('clock.manage'), async (req, res) => {
    try {
      const { rows } = await query(`SELECT p.id, p.label, p.created_at, p.last_used_at, u.name AS enrolled_by FROM passkeys p LEFT JOIN users u ON u.id = p.created_by WHERE p.user_id = $1 ORDER BY p.id`, [parseInt(req.params.id, 10)]);
      res.json({ passkeys: rows });
    } catch (e) { fail(res, e); }
  });
  app.delete('/api/clock/passkeys/:id', ...can('clock.manage'), async (req, res) => {
    try { await query(`DELETE FROM passkeys WHERE id = $1`, [parseInt(req.params.id, 10)]); res.json({ ok: true }); } catch (e) { fail(res, e); }
  });
  app.get('/api/clock/leave', ...can('clock.manage'), async (req, res) => {
    try {
      const { rows } = await query(`SELECT l.id, l.user_id, to_char(l.from_date, 'YYYY-MM-DD') AS from_date, to_char(l.to_date, 'YYYY-MM-DD') AS to_date, l.kind, l.note, u.name FROM staff_leave l JOIN users u ON u.id = l.user_id WHERE l.to_date >= CURRENT_DATE - 60 ORDER BY l.from_date DESC`);
      const { rows: hol } = await query(`SELECT to_char(day, 'YYYY-MM-DD') AS day, name FROM public_holidays WHERE day >= CURRENT_DATE - 30 ORDER BY day`);
      res.json({ leave: rows, holidays: hol });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/clock/leave', ...can('clock.manage'), async (req, res) => {
    try {
      const b = req.body || {};
      if (!/^\d{4}-\d{2}-\d{2}$/.test(b.from_date || '') || !/^\d{4}-\d{2}-\d{2}$/.test(b.to_date || '') || b.to_date < b.from_date) throw httpError(400, 'From and to dates');
      await query(`INSERT INTO staff_leave (user_id, from_date, to_date, kind, note, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
        [parseInt(b.user_id, 10), b.from_date, b.to_date, ['vacation', 'sick', 'unpaid', 'other'].includes(b.kind) ? b.kind : 'vacation', String(b.note || '').slice(0, 200) || null, req.session.userId]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.delete('/api/clock/leave/:id', ...can('clock.manage'), async (req, res) => {
    try { await query(`DELETE FROM staff_leave WHERE id = $1`, [parseInt(req.params.id, 10)]); res.json({ ok: true }); } catch (e) { fail(res, e); }
  });
  app.post('/api/clock/holidays', ...can('clock.manage'), async (req, res) => {
    try {
      const b = req.body || {};
      if (!/^\d{4}-\d{2}-\d{2}$/.test(b.day || '') || !String(b.name || '').trim()) throw httpError(400, 'Date and name');
      await query(`INSERT INTO public_holidays (day, name) VALUES ($1,$2) ON CONFLICT (day) DO UPDATE SET name = EXCLUDED.name`, [b.day, String(b.name).trim().slice(0, 80)]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.delete('/api/clock/holidays/:day', ...can('clock.manage'), async (req, res) => {
    try { await query(`DELETE FROM public_holidays WHERE day = $1`, [String(req.params.day)]); res.json({ ok: true }); } catch (e) { fail(res, e); }
  });
  app.put('/api/clock/settings', ...can('clock.manage'), async (req, res) => {
    try {
      const b = req.body || {};
      if (b.enforce !== undefined) await put('clock_enforce', b.enforce ? 'on' : 'off');
      if (b.photo !== undefined) await put('clock_photo', b.photo ? 'on' : 'off');
      if (b.exempt !== undefined) await put('clock_exempt_roles', String(b.exempt).replace(/[^a-z_,]/gi, ''));
      for (const [k, key, hi] of [['early', 'clock_early_minutes', 120], ['late', 'clock_late_minutes', 60], ['grace', 'clock_grace_minutes', 60], ['paid_break', 'clock_break_paid_minutes', 60]]) {
        if (b[k] === undefined) continue;
        const v = parseInt(b[k], 10);
        if (!(v >= 0 && v <= hi)) throw httpError(400, k + ' must be 0 to ' + hi);
        await put(key, v);
      }
      if (b.shop_ips !== undefined) {
        const ips = String(b.shop_ips).split(',').map((x) => x.trim()).filter(Boolean);
        if (ips.some((ip) => !/^[0-9a-f.:]+$/i.test(ip))) throw httpError(400, 'Addresses like 190.80.1.2, separated by commas');
        await put('clock_shop_ips', ips.join(','));
      }
      sCache = null;
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  // Punch photos: managers only, from outside the website folder.
  app.get('/api/clock/photo/:name', ...can('clock.approve'), (req, res) => {
    const name = String(req.params.name);
    if (!/^[0-9a-f]{32}\.jpg$/.test(name)) return res.status(404).end();
    res.set('Cache-Control', 'private, no-store');
    res.sendFile(path.join(PHOTO_DIR, name), (err) => { if (err) res.status(404).end(); });
  });
  // The client's own address (for setting up the shop Wi-Fi rule from a phone on it).
  app.get('/api/clock/my-address', ...can('clock.manage'), (req, res) => res.json({ address: ipOf(req), on_shop_network: isLocal(req) }));

  return { presence, weekFor };
}

module.exports = { register };
