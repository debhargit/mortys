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
//
//  The punch log (clock_events) keeps every punch and every refused try with
//  the device id, IP, browser, till station, the location the device gave and
//  its distance from the shop. Late on N days in a month issues a lateness
//  letter (filed in the staff file, sent as a notice and by email) that the
//  person acknowledges on My time. After the shift ends there is a leaving
//  window before the automatic clock out; extra time worked after that is
//  logged afterwards and approved like overtime.
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const wa = require('./webauthn');
const pins = require('./pins');

const TZ = 'America/Jamaica';
const OFFSET = '-05:00';   // Jamaica keeps no daylight saving
const BILLING = [/^\/api\/admin\/pos\/sale$/, /^\/api\/admin\/pos\/orders\/\d+\/invoice$/, /^\/api\/cash\/till\/(open|movement)$/, /^\/api\/admin\/pos\/sales\/\d+\/(return|void)$/];

function register(app, deps) {
  const { query, getPool, requireAdmin, requireCap, bcrypt, mailer, isLocal, getShopName, publicUser, docs } = deps;
  let notify = null;   // team.js notice(userIds, {kind, title, body, link, urgent}), once it is mounted
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
      base: s.public_base_url || '',
      lateWarn: ['letter', 'notice', 'off'].includes(s.clock_late_warn) ? s.clock_late_warn : 'letter', lateCount: parseInt(s.clock_late_warn_count, 10) || 3,
      leave: s.clock_leave_minutes == null ? 15 : (parseInt(s.clock_leave_minutes, 10) || 0),
      location: ['off', 'ask', 'required'].includes(s.clock_location) ? s.clock_location : 'ask',
      shopLat: s.clock_shop_lat === '' || s.clock_shop_lat == null ? null : Number(s.clock_shop_lat), shopLng: s.clock_shop_lng === '' || s.clock_shop_lng == null ? null : Number(s.clock_shop_lng),
      radius: parseInt(s.clock_shop_radius_m, 10) || 200 };
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

  // ------------------------------------------------------- punch log --
  function platformOf(ua) {
    const os = /Android/.test(ua) ? 'Android' : /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /CrOS/.test(ua) ? 'Chromebook' : /Linux/.test(ua) ? 'Linux' : '';
    const br = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
    return [os, br].filter(Boolean).join(' · ') || null;
  }
  function metresBetween(lat1, lng1, lat2, lng2) {
    const rad = Math.PI / 180, dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  // Where a punch came from: the request itself, and what the page sends as
  // body.ctx {device_id, device_name, lat, lng, acc, loc_status, client_time, tz}.
  async function ctxOf(req, b) {
    const s = await settings();
    const c = (b && b.ctx && typeof b.ctx === 'object') ? b.ctx : {};
    const num = (v, lo, hi) => { if (v == null || v === '') return null; const x = Number(v); return isFinite(x) && x >= lo && x <= hi ? x : null; };
    const lat = num(c.lat, -90, 90), lng = num(c.lng, -180, 180), has = lat != null && lng != null && s.location !== 'off';
    const ua = String(req.get('user-agent') || '').slice(0, 300);
    let station = null;
    const key = req.get('x-station-key');
    if (key) { try { const { rows } = await query(`SELECT name FROM pos_stations WHERE device_key_hash = $1 AND is_active`, [sha(key)]); station = rows[0] ? rows[0].name : null; } catch (_) {} }
    return {
      ip: ipOf(req), forwarded_for: String(req.headers['x-forwarded-for'] || '').slice(0, 200) || null,
      device_id: /^[A-Za-z0-9-]{8,64}$/.test(String(c.device_id || '')) ? String(c.device_id) : null,
      device_name: String(c.device_name || '').trim().slice(0, 60) || null,
      user_agent: ua || null, platform: platformOf(ua),
      station: station || String(req.get('x-terminal') || '').slice(0, 60) || null,
      lat: has ? lat : null, lng: has ? lng : null, accuracy_m: has && num(c.acc, 0, 1e7) != null ? Math.round(num(c.acc, 0, 1e7)) : null,
      distance_m: has && s.shopLat != null && s.shopLng != null ? Math.round(metresBetween(s.shopLat, s.shopLng, lat, lng)) : null,
      location_status: s.location === 'off' ? 'off' : has ? 'given' : (c.loc_status === 'denied' ? 'denied' : 'unavailable'),
      client_time: c.client_time && !isNaN(Date.parse(c.client_time)) ? new Date(c.client_time) : null,
      client_tz: String(c.tz || '').slice(0, 60) || null,
      on_site: await onSite(req),
    };
  }
  const locOf = (x) => (x && x.lat != null ? { lat: x.lat, lng: x.lng, acc: x.accuracy_m, dist: x.distance_m } : null);
  function logEvent(q, x) {
    return q(`INSERT INTO clock_events (user_id, attendance_id, action, result, message, method, mode, on_site, ip, forwarded_for, device_id, device_name, user_agent, platform, station,
                lat, lng, accuracy_m, distance_m, location_status, client_time, client_tz, shift_start, shift_end, late_minutes, photo)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)`,
      [x.user_id || null, x.attendance_id || null, String(x.action || '?').slice(0, 20), x.result || 'ok', x.message ? String(x.message).slice(0, 300) : null, x.method || null, x.mode || null,
        x.on_site == null ? null : !!x.on_site, x.ip || null, x.forwarded_for || null, x.device_id || null, x.device_name || null, x.user_agent || null, x.platform || null, x.station || null,
        x.lat == null ? null : x.lat, x.lng == null ? null : x.lng, x.accuracy_m == null ? null : x.accuracy_m, x.distance_m == null ? null : x.distance_m, x.location_status || null,
        x.client_time || null, x.client_tz || null, x.shift_start || null, x.shift_end || null, x.late_minutes == null ? null : x.late_minutes, x.photo || null]);
  }
  // A refused punch is logged too (not the questions the page answers itself).
  function logRefusal(req, b, ctx, uid, e) {
    if (e.extra && (e.extra.need_overtime || e.extra.need_photo || e.extra.need_location || e.extra.need_extra || e.extra.drawer_open)) return;
    logEvent(query, Object.assign({}, ctx, { user_id: uid, action: String((b && b.action) || '?'), result: 'refused', message: e.publicMessage || 'Error', method: (b && b.method) || null })).catch(() => {});
  }

  // The shift for a person on a day: {start, end, break_minutes} or {off: reason}.
  // Order: leave, then the work roster for that date (roster.js), then a
  // public holiday, then the weekly pattern.
  let rosterOn = false, rosterAt = 0;
  async function rosterTable() {
    if (rosterOn || Date.now() - rosterAt < 60000) return rosterOn;
    rosterAt = Date.now();
    try { const { rows } = await query(`SELECT to_regclass('public.roster_entries') IS NOT NULL AS ok`); rosterOn = !!rows[0].ok; } catch (_) {}
    return rosterOn;
  }
  async function shiftFor(uid, day, q = query) {
    const { rows: lv } = await q(`SELECT kind FROM staff_leave WHERE user_id = $1 AND $2::date BETWEEN from_date AND to_date LIMIT 1`, [uid, day]);
    if (lv.length) return { off: 'On ' + lv[0].kind + ' leave' };
    if (await rosterTable()) {
      const { rows: re } = await q(`SELECT kind, reason, to_char(start_time, 'HH24:MI') AS s, to_char(end_time, 'HH24:MI') AS e, break_minutes FROM roster_entries WHERE user_id = $1 AND day = $2`, [uid, day]);
      if (re.length && re[0].kind === 'off') return { off: 'Day off (roster)' };
      if (re.length && re[0].kind === 'away') return { off: 'Away (roster): ' + String(re[0].reason || 'other').replace('_', ' ') };
      if (re.length && re[0].kind === 'shift') {
        const start = at(day, re[0].s);
        let end = at(day, re[0].e);
        if (end <= start) end = new Date(end.getTime() + 86400000);
        return { start, end, break_minutes: re[0].break_minutes, roster: true };
      }
    }
    const { rows: hol } = await q(`SELECT name FROM public_holidays WHERE day = $1`, [day]);
    if (hol.length) return { off: 'Holiday: ' + hol[0].name };
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
      // Emptied, not set to null: a sign-in arriving on the old cookie then starts afresh.
      if (f && req.session.since < f) for (const k of Object.keys(req.session)) delete req.session[k];
    }
    next();
  });

  // ------------------------------------------------------------- email --
  async function approvers(uid, anyEmail) {
    const { rows } = await query(
      `SELECT DISTINCT u.id, u.name, u.email FROM users u
        WHERE NOT u.disabled AND (u.email NOT ILIKE '%.local' OR $2::boolean) AND (
              u.admin_role = 'owner'
           OR u.id = (SELECT approver_user_id FROM staff_clock WHERE user_id = $1)
           OR u.id IN (SELECT d.manager_user_id FROM user_departments ud JOIN departments d ON d.id = ud.department_id WHERE ud.user_id = $1))`, [uid, !!anyEmail]);
    return rows;
  }
  async function baseUrl(req) {
    const s = await settings();
    if (s.base) return s.base.replace(/\/$/, '');
    return req ? (req.headers['x-forwarded-proto'] || req.protocol || 'http') + '://' + req.get('host') : '';
  }
  const KIND = { extension: 'Extra time', overtime: 'Overtime (outside the shift)', correction: 'Time correction', extra: 'Extra time after the shift' };
  async function mailRequest(req, r, u, links) {
    if (!mailer) return;
    const base = await baseUrl(req);
    const what = r.kind === 'extension' ? r.minutes + ' more minutes today' : r.kind === 'overtime' ? 'clocked in outside the shift'
      : r.kind === 'extra' ? 'worked ' + r.minutes + ' minutes after being clocked out, until ' + new Date(r.wanted.clock_out_at).toLocaleString('en-JM', { timeZone: TZ }) : 'change of times: ' + JSON.stringify(r.wanted || {});
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
    if (notify) {
      const ids = (await approvers(u.id, true)).map((a) => a.id).filter((id) => id !== u.id);
      notify(ids, { kind: 'clock', title: '⏱ ' + KIND[row.kind] + ': ' + u.name, body: row.reason, link: '/attendance.html#req' }).catch(() => {});
    }
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
    if (r.kind === 'extra' && approve) {
      await c.query(`UPDATE attendance SET clock_out_at = $2, edited = true, closed_note = 'Extra time approved' WHERE id = $1`, [r.attendance_id, (r.wanted || {}).clock_out_at]);
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
      // The keypad sends the name picked from its staff list; the PIN is then checked against that person only.
      const picked = pins.pickedId(b);
      const { rows } = await query(`SELECT id, pin_hash FROM users WHERE pin_hash IS NOT NULL AND is_staff AND NOT disabled` + (picked ? ' AND id = $1' : ''), picked ? [picked] : []);
      const hit = await pins.pick(rows, pin);
      if (!hit) { bump(); throw httpError(401, picked ? 'That PIN is not right for the name picked' : 'PIN not recognised'); }
      uid = hit.id;
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
  async function doPunch(req, u, method, b, ctx) {
    const s = await settings();
    let action = String(b.action || '');
    if (action === 'toggle') action = (await openEntry(u.id)) ? 'out' : 'in';   // a badge scan: in if out, out if in
    if (action === 'extra') return logExtra(req, u, method, b, ctx);
    const here = ctx.on_site;
    const where = ctx.station || ctx.ip;
    if ((action === 'in' || action === 'out') && s.location === 'required' && !here && ctx.location_status !== 'given') {
      throw httpError(400, 'Away from the shop, this device must share its location to clock ' + action + '. Allow location for this page and try again.', { need_location: true });
    }
    const ev = (c, x) => logEvent(c.query.bind(c), Object.assign({}, ctx, { user_id: u.id, action, method }, x));
    const out = await tx(async (c) => {
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
        // Late: the first clock in of the day, past the start plus the allowance.
        let late = null;
        if (inside && now > sh.start.getTime() + s.late * 60000) {
          const { rows: before } = await c.query(`SELECT 1 FROM attendance WHERE user_id = $1 AND work_day = $2 LIMIT 1`, [u.id, day]);
          if (!before.length) late = Math.round((now - sh.start.getTime()) / 60000);
        }
        const photo = b.photo ? savePhoto(b.photo) : null;
        const { rows } = await c.query(
          `INSERT INTO attendance (user_id, work_day, mode, method_in, where_in, photo_in, shift_start, shift_end, outside_shift, ot_reason, ot_status, ip_in, device_in, loc_in, late_minutes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
          [u.id, day, mode, method, where, photo, sh.start || null, sh.end || null, !inside, inside ? null : reason, inside ? 'none' : 'pending', ctx.ip, ctx.device_id, locOf(ctx), late]);
        if (!inside) await makeRequest(req, c, { kind: 'overtime', attendance_id: rows[0].id, reason }, u);
        const message = 'Clocked in ' + fmtT(rows[0].clock_in_at) + (mode === 'remote' ? ' (Remote: no payments)' : '') + (late ? ' · ' + late + ' minutes late' : '') + (inside ? '' : ' · overtime sent for approval');
        await ev(c, { attendance_id: rows[0].id, mode, shift_start: sh.start || null, shift_end: sh.end || null, late_minutes: late, photo, message });
        return { done: 'in', entry: rows[0], message, late_minutes: late, day };
      }
      if (!open) throw httpError(409, 'You are not clocked in');
      if (action === 'out') {
        const { rows: drawer } = await c.query(`SELECT st.name FROM till_sessions t JOIN pos_stations st ON st.id = t.station_id WHERE t.user_id = $1 AND t.status = 'open' LIMIT 1`, [u.id]);
        if (drawer.length && !b.force) throw httpError(409, 'Your cash drawer at ' + drawer[0].name + ' is still open: close it or hand it over first.', { drawer_open: true });
        await c.query(`UPDATE attendance_breaks SET end_at = NOW() WHERE attendance_id = $1 AND end_at IS NULL`, [open.id]);
        const photo = b.photo ? savePhoto(b.photo) : null;
        const { rows } = await c.query(`UPDATE attendance SET clock_out_at = NOW(), method_out = $2, photo_out = $3, ip_out = $4, device_out = $5, loc_out = $6 WHERE id = $1 RETURNING *`,
          [open.id, method, photo, ctx.ip, ctx.device_id, locOf(ctx)]);
        const message = 'Clocked out ' + fmtT(rows[0].clock_out_at);
        await ev(c, { attendance_id: open.id, mode: open.mode, shift_start: open.shift_start, shift_end: open.shift_end, photo, message });
        return { done: 'out', entry: rows[0], message };
      }
      if (action === 'break_start' || action === 'lunch_start') {
        const { rows: br } = await c.query(`SELECT 1 FROM attendance_breaks WHERE attendance_id = $1 AND end_at IS NULL`, [open.id]);
        if (br.length) throw httpError(409, 'You are already on a break');
        await c.query(`INSERT INTO attendance_breaks (attendance_id, kind) VALUES ($1, $2)`, [open.id, action === 'lunch_start' ? 'lunch' : 'break']);
        const message = (action === 'lunch_start' ? 'Lunch' : 'Break') + ' started ' + fmtT(new Date());
        await ev(c, { attendance_id: open.id, mode: open.mode, message });
        return { done: action, message };
      }
      if (action === 'break_end') {
        const { rowCount } = await c.query(`UPDATE attendance_breaks SET end_at = NOW() WHERE attendance_id = $1 AND end_at IS NULL`, [open.id]);
        if (!rowCount) throw httpError(409, 'You are not on a break');
        const message = 'Back from break ' + fmtT(new Date());
        await ev(c, { attendance_id: open.id, mode: open.mode, message });
        return { done: 'break_end', message };
      }
      throw httpError(400, 'Clock in, clock out, or a break?');
    });
    if (out.done === 'in' && out.late_minutes) checkLateness(out.entry.user_id, out.day, null).catch((e) => console.warn('[clock] lateness', e.message));
    return out;
  }
  // Worked on after the automatic clock out: log the time, a manager approves it.
  async function logExtra(req, u, method, b, ctx) {
    const reason = String(b.reason || '').trim().slice(0, 300);
    const until = b.until && !isNaN(Date.parse(b.until)) ? new Date(b.until) : null;
    if (!until) throw httpError(400, 'Give the time you finished work', { need_extra: true });
    if (reason.length < 3) throw httpError(400, 'Say what you were working on', { need_extra: true });
    const { rows } = b.attendance_id
      ? await query(`SELECT * FROM attendance WHERE id = $1 AND user_id = $2`, [parseInt(b.attendance_id, 10) || 0, u.id])
      : await query(`SELECT * FROM attendance WHERE user_id = $1 AND clock_out_at IS NOT NULL ORDER BY clock_out_at DESC LIMIT 1`, [u.id]);
    const a = rows[0];
    if (!a) throw httpError(404, 'No finished shift to add the time to');
    if (!a.clock_out_at) throw httpError(409, 'You are still clocked in: ask for more time instead');
    const outAt = new Date(a.clock_out_at);
    if (until <= outAt) throw httpError(400, 'You were clocked out at ' + fmtT(outAt) + ': give a later time');
    if (until.getTime() > Date.now() + 60000) throw httpError(400, 'That time has not come yet');
    if (until - outAt > 12 * 3600000 || Date.now() - outAt > 7 * 86400000) throw httpError(400, 'Too long ago or too long: ask for a time correction instead');
    const minutes = Math.round((until - outAt) / 60000);
    const r = await tx(async (c) => {
      const { rows: p } = await c.query(`SELECT 1 FROM clock_requests WHERE attendance_id = $1 AND kind = 'extra' AND status = 'pending'`, [a.id]);
      if (p.length) throw httpError(409, 'You already logged extra time for that shift; wait for the answer');
      const r0 = await makeRequest(req, c, { kind: 'extra', attendance_id: a.id, minutes, reason, wanted: { clock_out_at: until.toISOString() }, original: { clock_in_at: a.clock_in_at, clock_out_at: a.clock_out_at } }, u);
      await logEvent(c.query.bind(c), Object.assign({}, ctx, { user_id: u.id, attendance_id: a.id, action: 'extra_time', method, mode: a.mode, message: minutes + ' min after ' + fmtT(outAt) + ': ' + reason }));
      return r0;
    });
    return { done: 'extra', request_id: r.id, message: minutes + ' minutes of extra time sent to the manager for approval' };
  }

  app.post('/api/clock/punch', async (req, res) => {
    const b = req.body || {};
    let ctx = {}, who = null;
    try {
      ctx = await ctxOf(req, b);
      who = await identify(req, b);
      const out = await doPunch(req, who.user, who.method, b, ctx);
      res.json(Object.assign({ name: who.user.name }, out));
    } catch (e) { logRefusal(req, b, ctx, who && who.user.id, e); fail(res, e); }
  });
  // What the clock page needs before a punch (no sign-in).
  app.get('/api/clock/kiosk', async (req, res) => {
    try { const s = await settings(); res.json({ location: s.location, photo: s.photo }); } catch (e) { fail(res, e); }
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
      // Clocked out by the system in the last day, with no extra time logged for it yet.
      const { rows: auto } = a ? { rows: [] } : await query(
        `SELECT a.id, a.clock_out_at FROM attendance a WHERE a.user_id = $1 AND a.auto_closed AND a.clock_out_at > NOW() - INTERVAL '1 day'
            AND NOT EXISTS (SELECT 1 FROM clock_requests r WHERE r.attendance_id = a.id AND r.kind = 'extra') ORDER BY a.clock_out_at DESC LIMIT 1`, [uid]);
      const { rows: wl } = await query(`SELECT COUNT(*)::int AS n FROM clock_warnings WHERE user_id = $1 AND status = 'issued'`, [uid]);
      res.json({ enforce: s.enforce, exempt: s.exempt.includes(u.admin_role), clocked_in: !!a, entry: a ? { since: a.clock_in_at, mode: a.mode, outside_shift: a.outside_shift, ot_status: a.ot_status } : null,
        ends_at: end, minutes_left, warn: minutes_left != null && minutes_left <= 15 ? (minutes_left <= 5 ? 5 : 15) : null, pending, on_break,
        leave_minutes: s.leave, auto_out_at: end ? new Date(end.getTime() + s.leave * 60000) : null, last_auto: auto[0] || null, letters: wl[0].n,
        can_bill: p.ok, reason: p.ok ? null : p.reason, remote_allowed: u.remote_allowed });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/clock/me/punch', requireAdmin, async (req, res) => {
    const b = req.body || {};
    let ctx = {};
    try {
      ctx = await ctxOf(req, b);
      const u = await staffRow(req.session.userId);
      const out = await doPunch(req, u, 'session', b, ctx);
      res.json(out);
    } catch (e) { logRefusal(req, Object.assign({ method: 'session' }, b), ctx, req.session.userId, e); fail(res, e); }
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
        `SELECT a.id, to_char(a.work_day, 'YYYY-MM-DD') AS work_day, a.clock_in_at, a.clock_out_at, a.mode, a.outside_shift, a.ot_status, a.auto_closed, a.edited, a.shift_start, a.shift_end,
                a.late_minutes, a.late_excused, a.ip_in, a.ip_out, a.loc_in, a.loc_out, a.method_in, a.method_out,
                (SELECT json_agg(json_build_object('kind', b.kind, 'start', b.start_at, 'end', b.end_at)) FROM attendance_breaks b WHERE b.attendance_id = a.id) AS breaks
           FROM attendance a WHERE a.user_id = $1 ORDER BY a.clock_in_at DESC LIMIT 60`, [req.session.userId]);
      const { rows: reqs } = await query(`SELECT id, attendance_id, kind, minutes, reason, status, created_at, decided_at, decision_note FROM clock_requests WHERE user_id = $1 ORDER BY id DESC LIMIT 30`, [req.session.userId]);
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
        if (Date.now() <= end.getTime() + s.leave * 60000) continue;   // time to finish up and leave
        const { rows: ext } = await query(`SELECT created_at FROM clock_requests WHERE attendance_id = $1 AND kind = 'extension' AND status = 'pending' ORDER BY id DESC LIMIT 1`, [a.id]);
        if (ext.length && Date.now() - new Date(ext[0].created_at).getTime() <= s.grace * 60000) continue;
        const { rows: drawer } = await query(`SELECT 1 FROM till_sessions WHERE user_id = $1 AND status = 'open' LIMIT 1`, [a.user_id]);
        if (drawer.length) { await query(`UPDATE attendance SET closed_note = 'Shift over; cash drawer still open' WHERE id = $1 AND closed_note IS DISTINCT FROM 'Shift over; cash drawer still open'`, [a.id]); continue; }
        await query(`UPDATE attendance_breaks SET end_at = LEAST(NOW(), $2) WHERE attendance_id = $1 AND end_at IS NULL`, [a.id, end]);
        const { rowCount } = await query(`UPDATE attendance SET clock_out_at = GREATEST($2, clock_in_at), method_out = 'auto', auto_closed = true, closed_note = 'Clocked out at the end of the shift' WHERE id = $1 AND clock_out_at IS NULL`, [a.id, end]);
        forcedOut.set(a.user_id, Date.now());
        if (!rowCount) continue;
        await logEvent(query, { user_id: a.user_id, attendance_id: a.id, action: 'auto_out', method: 'auto', mode: a.mode, shift_start: a.shift_start, shift_end: a.shift_end, message: 'Clocked out at the end of the shift (' + fmtT(end) + ')' });
        if (notify) notify([a.user_id], { kind: 'clock', title: '⏰ You were clocked out at ' + fmtT(end), body: 'Your shift ended. If you kept working after that, log the extra time on My time and your manager will approve it.', link: '/my-time.html#extra' }).catch(() => {});
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
      days.push({ day, shift: sh.off ? sh.off : fmtT(sh.start) + '–' + fmtT(sh.end), entries: att.map((a) => ({ id: a.id, in: a.clock_in_at, out: a.clock_out_at, mode: a.mode, outside: a.outside_shift, ot: a.ot_status, auto: a.auto_closed, edited: a.edited, photo_in: a.photo_in, photo_out: a.photo_out,
          late: a.late_minutes, late_excused: a.late_excused, ip_in: a.ip_in, ip_out: a.ip_out, device_in: a.device_in, device_out: a.device_out, loc_in: a.loc_in, loc_out: a.loc_out })),
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
      res.json({ staff: rows, managers, settings: { enforce: s.enforce, exempt: s.exempt.join(','), early: s.early, late: s.late, grace: s.grace, photo: s.photo, paid_break: s.paidBreak, shop_ips: s.shopIps.join(','),
        late_warn: s.lateWarn, late_count: s.lateCount, leave: s.leave, location: s.location, shop_lat: s.shopLat, shop_lng: s.shopLng, radius: s.radius } });
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
      if (b.late_warn !== undefined) await put('clock_late_warn', ['letter', 'notice', 'off'].includes(b.late_warn) ? b.late_warn : 'letter');
      if (b.location !== undefined) await put('clock_location', ['off', 'ask', 'required'].includes(b.location) ? b.location : 'ask');
      if (b.shop_lat !== undefined || b.shop_lng !== undefined) {
        const la = b.shop_lat === '' || b.shop_lat == null ? '' : Number(b.shop_lat), lo = b.shop_lng === '' || b.shop_lng == null ? '' : Number(b.shop_lng);
        if ((la === '') !== (lo === '') || (la !== '' && !(la >= -90 && la <= 90 && lo >= -180 && lo <= 180))) throw httpError(400, 'The shop location needs both latitude and longitude');
        await put('clock_shop_lat', la); await put('clock_shop_lng', lo);
      }
      for (const [k, key, lo, hi] of [['late_count', 'clock_late_warn_count', 1, 31], ['leave', 'clock_leave_minutes', 0, 120], ['radius', 'clock_shop_radius_m', 20, 50000]]) {
        if (b[k] === undefined) continue;
        const v = parseInt(b[k], 10);
        if (!(v >= lo && v <= hi)) throw httpError(400, k + ' must be ' + lo + ' to ' + hi);
        await put(key, v);
      }
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
  // ------------------------------------------------- lateness letters --
  const monthOf = (day) => String(day).slice(0, 7) + '-01';
  const monthName = (m) => new Date(m + 'T12:00:00Z').toLocaleDateString('en-JM', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const LEVEL = (l) => (l === 1 ? 'First written warning' : l === 2 ? 'Second written warning' : 'Final written warning');
  const h = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // Each day's first clock in that was late (excused ones included, flagged).
  async function lateDays(uid, month) {
    const { rows } = await query(
      `SELECT DISTINCT ON (a.work_day) a.id, to_char(a.work_day, 'YYYY-MM-DD') AS day, a.late_minutes, a.late_excused, a.late_excuse, a.clock_in_at, a.shift_start
         FROM attendance a WHERE a.user_id = $1 AND a.work_day >= $2::date AND a.work_day < ($2::date + INTERVAL '1 month')
        ORDER BY a.work_day, a.clock_in_at`, [uid, month]);
    return rows.filter((r) => r.late_minutes > 0);
  }
  function letterHtml(o) {
    const rows = o.days.map((d) => '<tr><td>' + h(new Date(d.day + 'T12:00:00Z').toLocaleDateString('en-JM', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })) + '</td><td>' + h(d.shift_start ? fmtT(d.shift_start) : '') + '</td><td>' + h(fmtT(d.clock_in_at)) + '</td><td>' + h(d.late_minutes) + '</td></tr>').join('');
    const close = o.level === 1 ? 'This letter is a first written warning and is kept in your staff file.'
      : o.level === 2 ? 'This is a second written warning this month. Further lateness may lead to disciplinary action.'
        : 'This is a final written warning. Further lateness will lead to disciplinary action.';
    return '<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="/favicon.svg?v=vision2" type="image/svg+xml"><link rel="icon" href="/favicon.ico?v=vision2" sizes="any"><link rel="apple-touch-icon" href="/apple-touch-icon.png?v=vision2"><title>' + h(LEVEL(o.level)) + ' - lateness</title><style>body{font:15px/1.55 Georgia,"Times New Roman",serif;color:#111;max-width:720px;margin:30px auto;padding:0 20px;background:#fff}h1{font-size:20px;margin:18px 0 10px}table{border-collapse:collapse;width:100%;margin:10px 0 14px}th,td{border:1px solid #bbb;padding:5px 8px;text-align:left;font-size:14px}th{background:#f2f2f2}.sig{margin-top:34px}.small{font-size:12px;color:#555;margin-top:26px}</style></head><body>' +
      '<p><b>' + h(o.shop) + '</b></p><p>' + h(new Date().toLocaleDateString('en-JM', { day: 'numeric', month: 'long', year: 'numeric', timeZone: TZ })) + '</p>' +
      '<p>To: <b>' + h(o.name) + '</b></p><h1>' + h(LEVEL(o.level)) + ': lateness in ' + h(monthName(o.month)) + '</h1>' +
      '<p>The time clock shows that you clocked in late on <b>' + o.days.length + '</b> working days in ' + h(monthName(o.month)) + (o.level > 1 ? ', after an earlier warning this month' : '') + ':</p>' +
      '<table><tr><th>Day</th><th>Shift started</th><th>You clocked in</th><th>Minutes late</th></tr>' + rows + '</table>' +
      '<p>Being on time matters to the customers and colleagues who count on you. Please be at work and clocked in by the start of your shift. If something is making it hard to be on time, talk to your manager: a late day with a good reason can be excused.</p>' +
      '<p>' + close + ' Please acknowledge that you have received it. You may reply in writing within 7 days.</p>' +
      '<p class="sig">Manager: ______________________________ &nbsp; Date: ____________</p>' +
      '<p class="sig">Employee (received): ______________________________ &nbsp; Date: ____________</p>' +
      '<p class="small">Issued ' + (o.by ? 'by ' + h(o.by) : 'automatically by the time clock') + '. Late means clocking in more than ' + o.lateAllowance + ' minutes after the start of the shift; days a manager excused are not counted.</p></body></html>';
  }
  async function issueWarning(uid, month, level, days, byUser, letter) {
    const s = await settings();
    const { rows: ur } = await query(`SELECT id, name, email FROM users WHERE id = $1`, [uid]);
    const u = ur[0];
    if (!u) return null;
    const shop = (getShopName && await getShopName()) || 'Vision Auto Solutions';
    const by = byUser ? ((await query(`SELECT name FROM users WHERE id = $1`, [byUser])).rows[0] || {}).name : null;
    const html = letter ? letterHtml({ shop, name: u.name, month, level, days, by, lateAllowance: s.late }) : null;
    let w;
    try {
      ({ rows: [w] } = await query(`INSERT INTO clock_warnings (user_id, month, level, late_count, late_days, letter_html, issued_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [uid, month, level, days.length, JSON.stringify(days.map((d) => ({ day: d.day, minutes: d.late_minutes, clock_in_at: d.clock_in_at, shift_start: d.shift_start }))), html, byUser || null]));
    } catch (e) { if (e.code === '23505') return null; throw e; }
    if (html && docs) {
      try {
        const doc = await docs.fileHtml(null, { title: 'Lateness - ' + LEVEL(level) + ' - ' + u.name + ' - ' + monthName(month), category: 'staff', confidentiality: 'restricted', owner_id: uid,
          uploaded_by: byUser || null, html, file_name: 'Lateness warning ' + u.name, links: [{ type: 'staff', id: uid }], issue_date: jmDay(), source: 'module',
          description: 'Late on ' + days.length + ' days in ' + monthName(month) + '. Issued ' + (by ? 'by ' + by : 'by the time clock') + '.', note: 'Issued by the time clock' });
        await query(`UPDATE clock_warnings SET document_id = $2 WHERE id = $1`, [w.id, doc.id]);
      } catch (e) { console.warn('[clock] filing the lateness letter', e.message); }
    }
    const title = (letter ? '⏰ Lateness letter: ' : '⏰ ') + 'late ' + days.length + ' times in ' + monthName(month);
    if (notify) {
      notify([uid], { kind: 'clock', title, body: letter ? 'You have a written warning to read and acknowledge. Open My time.' : 'Please be on time. Your manager has been told.', link: '/my-time.html#letter=' + w.id, urgent: true }).catch(() => {});
      const ids = (await approvers(uid, true)).map((a) => a.id).filter((id) => id !== uid && id !== byUser);
      notify(ids, { kind: 'clock', title: '⏰ ' + u.name + ' was late ' + days.length + ' times in ' + monthName(month), body: letter ? LEVEL(level) + ' issued and filed in the staff file.' : 'A lateness notice was sent to them.', link: '/attendance.html#late' }).catch(() => {});
    }
    if (mailer) {
      if (u.email && !/\.local$/i.test(u.email)) mailer.sendEmail({ to: u.email, subject: '[' + shop + '] ' + (letter ? LEVEL(level) + ': lateness' : 'Lateness'), text: title.replace('⏰ ', '') + '. ' + (letter ? 'Please read the letter and acknowledge it on My time.' : 'Please be on time.'), html: html || undefined }).catch(() => {});
      for (const a of await approvers(uid)) if (a.id !== uid) mailer.sendEmail({ to: a.email, subject: '[' + shop + '] ' + u.name + ' late ' + days.length + ' times in ' + monthName(month), text: (letter ? LEVEL(level) + ' issued and filed in their staff file.' : 'A lateness notice was sent to them.') + ' See Attendance > Lateness.' }).catch(() => {});
    }
    return w;
  }
  // After a late clock in: N late days this month (not excused) and no letter yet at that level.
  async function checkLateness(uid, day) {
    const s = await settings();
    if (s.lateWarn === 'off') return null;
    const month = monthOf(day);
    const days = (await lateDays(uid, month)).filter((d) => !d.late_excused);
    const level = Math.floor(days.length / s.lateCount);
    if (level < 1) return null;
    const { rows } = await query(`SELECT 1 FROM clock_warnings WHERE user_id = $1 AND month = $2 AND level >= $3`, [uid, month, level]);
    if (rows.length) return null;
    return issueWarning(uid, month, level, days, null, s.lateWarn === 'letter');
  }
  const warnOut = (w) => ({ id: w.id, user_id: w.user_id, month: typeof w.month === 'string' ? w.month : jmDay(w.month), level: w.level, title: LEVEL(w.level), late_count: w.late_count, late_days: w.late_days,
    status: w.status, has_letter: !!w.letter_html, document_id: w.document_id, issued_at: w.issued_at, issued_by_name: w.issued_by_name || null, acknowledged_at: w.acknowledged_at, ack_note: w.ack_note,
    withdrawn_at: w.withdrawn_at, withdrawn_reason: w.withdrawn_reason, name: w.name });

  // Staff: their own letters.
  app.get('/api/clock/me/warnings', requireAdmin, async (req, res) => {
    try {
      const { rows } = await query(`SELECT w.*, to_char(w.month, 'YYYY-MM-DD') AS month FROM clock_warnings w WHERE w.user_id = $1 AND w.status <> 'withdrawn' ORDER BY w.id DESC LIMIT 24`, [req.session.userId]);
      res.json({ warnings: rows.map(warnOut) });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/clock/me/warnings/:id', requireAdmin, async (req, res) => {
    try {
      const { rows } = await query(`SELECT w.*, to_char(w.month, 'YYYY-MM-DD') AS month FROM clock_warnings w WHERE w.id = $1 AND w.user_id = $2 AND w.status <> 'withdrawn'`, [parseInt(req.params.id, 10) || 0, req.session.userId]);
      if (!rows.length) throw httpError(404, 'Letter not found');
      res.set('Cache-Control', 'no-store');
      res.json({ warning: warnOut(rows[0]), html: rows[0].letter_html });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/clock/me/warnings/:id/ack', requireAdmin, async (req, res) => {
    try {
      const note = String((req.body || {}).note || '').trim().slice(0, 1000) || null;
      const { rows } = await query(`UPDATE clock_warnings SET status = 'acknowledged', acknowledged_at = NOW(), ack_note = $3 WHERE id = $1 AND user_id = $2 AND status = 'issued' RETURNING *`,
        [parseInt(req.params.id, 10) || 0, req.session.userId, note]);
      if (!rows.length) throw httpError(409, 'Already acknowledged, or not your letter');
      if (notify) {
        const { rows: u } = await query(`SELECT name FROM users WHERE id = $1`, [req.session.userId]);
        const ids = (await approvers(req.session.userId, true)).map((a) => a.id).filter((id) => id !== req.session.userId);
        notify(ids, { kind: 'clock', title: '✓ ' + (u[0] ? u[0].name : 'Staff') + ' acknowledged the lateness letter', body: note ? 'Their reply: ' + note : null, link: '/attendance.html#late' }).catch(() => {});
      }
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // Managers: lateness for a month, per person.
  app.get('/api/clock/lateness', ...can('clock.approve'), async (req, res) => {
    try {
      const s = await settings();
      const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month + '-01' : monthOf(jmDay());
      const { rows: staff } = await query(
        `SELECT u.id, u.name FROM users u WHERE u.is_staff AND u.admin_role <> 'rep'
            AND ((NOT u.disabled AND EXISTS (SELECT 1 FROM staff_shifts sh WHERE sh.user_id = u.id))
              OR EXISTS (SELECT 1 FROM attendance a WHERE a.user_id = u.id AND a.work_day >= $1::date AND a.work_day < ($1::date + INTERVAL '1 month')))
          ORDER BY u.name`, [month]);
      const today = jmDay(), out = [];
      const { rows: allW } = await query(`SELECT w.*, to_char(w.month, 'YYYY-MM-DD') AS month, ib.name AS issued_by_name FROM clock_warnings w LEFT JOIN users ib ON ib.id = w.issued_by WHERE w.month = $1 ORDER BY w.level`, [month]);
      for (const u of staff) {
        const days = await lateDays(u.id, month);
        const { rows: x } = await query(
          `SELECT COUNT(*) FILTER (WHERE auto_closed)::int AS auto_out,
                  COUNT(*) FILTER (WHERE NOT auto_closed AND clock_out_at IS NOT NULL AND shift_end IS NOT NULL AND NOT outside_shift AND clock_out_at < shift_end - make_interval(mins => $3))::int AS early
             FROM attendance WHERE user_id = $1 AND work_day >= $2::date AND work_day < ($2::date + INTERVAL '1 month')`, [u.id, month, s.late]);
        const { rows: ex } = await query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(r.minutes) FILTER (WHERE r.status = 'approved'), 0)::int AS approved_min FROM clock_requests r JOIN attendance a ON a.id = r.attendance_id
             WHERE r.user_id = $1 AND r.kind = 'extra' AND a.work_day >= $2::date AND a.work_day < ($2::date + INTERVAL '1 month')`, [u.id, month]);
        let absent = 0;
        const { rows: worked } = await query(`SELECT DISTINCT to_char(work_day, 'YYYY-MM-DD') AS d FROM attendance WHERE user_id = $1 AND work_day >= $2::date AND work_day < ($2::date + INTERVAL '1 month')`, [u.id, month]);
        const seen = new Set(worked.map((r) => r.d));
        for (let d = new Date(month + 'T12:00:00Z'); d.toISOString().slice(0, 7) === month.slice(0, 7); d = new Date(d.getTime() + 86400000)) {
          const day = d.toISOString().slice(0, 10);
          if (day > today || seen.has(day)) continue;
          const sh = await shiftFor(u.id, day);
          if (!sh.off && sh.start.getTime() < Date.now()) absent++;
        }
        const counted = days.filter((d) => !d.late_excused);
        const warnings = allW.filter((w) => w.user_id === u.id).map(warnOut);
        if (!days.length && !x[0].auto_out && !x[0].early && !absent && !ex[0].n && !warnings.length) continue;
        out.push({ user_id: u.id, name: u.name, late: counted.length, late_excused: days.length - counted.length, late_minutes: counted.reduce((t, d) => t + d.late_minutes, 0),
          days: days.map((d) => ({ attendance_id: d.id, day: d.day, minutes: d.late_minutes, clock_in_at: d.clock_in_at, shift_start: d.shift_start, excused: d.late_excused, excuse: d.late_excuse })),
          early: x[0].early, auto_out: x[0].auto_out, absent, extra_requests: ex[0].n, extra_approved_min: ex[0].approved_min, warnings });
      }
      out.sort((a, b) => b.late - a.late || b.late_minutes - a.late_minutes || a.name.localeCompare(b.name));
      res.json({ month, threshold: s.lateCount, action: s.lateWarn, late_allowance: s.late, staff: out });
    } catch (e) { fail(res, e); }
  });
  // Excuse a late day (it stops counting towards a letter), or undo that.
  app.post('/api/clock/attendance/:id/excuse', ...can('clock.approve'), async (req, res) => {
    try {
      const b = req.body || {};
      const reason = String(b.reason || '').trim().slice(0, 300);
      if (!b.undo && reason.length < 3) throw httpError(400, 'Say why the late day is excused');
      const id = parseInt(req.params.id, 10) || 0;
      const { rows: a } = await query(`SELECT user_id FROM attendance WHERE id = $1 AND late_minutes > 0`, [id]);
      if (!a.length) throw httpError(404, 'Not a late clock in');
      if (a[0].user_id === req.session.userId) throw httpError(403, 'Someone else must excuse your own late day');
      const { rows } = await query(`UPDATE attendance SET late_excused = $2, late_excuse = $3, late_excused_by = $4 WHERE id = $1 RETURNING user_id, to_char(work_day, 'YYYY-MM-DD') AS day`,
        [id, !b.undo, b.undo ? null : reason, b.undo ? null : req.session.userId]);
      if (b.undo) await checkLateness(rows[0].user_id, rows[0].day);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  // Issue a letter now (fewer late days than the rule, or the rule is off).
  app.post('/api/clock/lateness/issue', ...can('clock.manage'), async (req, res) => {
    try {
      const b = req.body || {};
      const uid = parseInt(b.user_id, 10) || 0;
      const month = /^\d{4}-\d{2}(-01)?$/.test(b.month || '') ? String(b.month).slice(0, 7) + '-01' : monthOf(jmDay());
      if (uid === req.session.userId) throw httpError(403, 'Someone else must issue a letter to you');
      const days = (await lateDays(uid, month)).filter((d) => !d.late_excused);
      if (!days.length) throw httpError(400, 'No late days (not excused) in ' + monthName(month));
      const { rows } = await query(`SELECT COALESCE(MAX(level), 0) AS l FROM clock_warnings WHERE user_id = $1 AND month = $2`, [uid, month]);
      const w = await issueWarning(uid, month, Number(rows[0].l) + 1, days, req.session.userId, true);
      if (!w) throw httpError(409, 'A letter was just issued');
      res.json({ ok: true, id: w.id });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/clock/warnings/:id', ...can('clock.approve'), async (req, res) => {
    try {
      const { rows } = await query(`SELECT w.*, to_char(w.month, 'YYYY-MM-DD') AS month, u.name, ib.name AS issued_by_name FROM clock_warnings w JOIN users u ON u.id = w.user_id LEFT JOIN users ib ON ib.id = w.issued_by WHERE w.id = $1`, [parseInt(req.params.id, 10) || 0]);
      if (!rows.length) throw httpError(404, 'Letter not found');
      res.set('Cache-Control', 'no-store');
      res.json({ warning: warnOut(rows[0]), html: rows[0].letter_html });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/clock/warnings/:id/withdraw', ...can('clock.manage'), async (req, res) => {
    try {
      const reason = String((req.body || {}).reason || '').trim().slice(0, 300);
      if (reason.length < 3) throw httpError(400, 'Say why the letter is withdrawn');
      const { rows } = await query(`UPDATE clock_warnings SET status = 'withdrawn', withdrawn_at = NOW(), withdrawn_by = $2, withdrawn_reason = $3 WHERE id = $1 AND status <> 'withdrawn' RETURNING *, to_char(month, 'YYYY-MM-DD') AS m`,
        [parseInt(req.params.id, 10) || 0, req.session.userId, reason]);
      if (!rows.length) throw httpError(409, 'Already withdrawn');
      if (rows[0].document_id) await query(`UPDATE documents SET status = 'archived', description = COALESCE(description, '') || $2 WHERE id = $1`, [rows[0].document_id, ' Withdrawn: ' + reason]).catch(() => {});
      if (notify) notify([rows[0].user_id], { kind: 'clock', title: 'Your lateness letter for ' + monthName(rows[0].m) + ' was withdrawn', body: reason, link: '/my-time.html' }).catch(() => {});
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // The punch log: every clock in / out / break and refused try, with where it came from.
  app.get('/api/clock/events', ...can('clock.approve'), async (req, res) => {
    try {
      const iso = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);
      const to = iso(req.query.to) || jmDay(), from = iso(req.query.from) || jmDay(Date.now() - 6 * 86400000);
      const csv = req.query.format === 'csv';
      const { rows } = await query(
        `SELECT e.*, u.name FROM clock_events e LEFT JOIN users u ON u.id = e.user_id
          WHERE e.at >= ($1::date)::timestamp AT TIME ZONE '${TZ}' AND e.at < ($2::date + 1)::timestamp AT TIME ZONE '${TZ}'
            AND ($3::int IS NULL OR e.user_id = $3) AND ($4::text IS NULL OR e.action = $4) AND ($5::text IS NULL OR e.result = $5) AND ($6::text IS NULL OR e.device_id = $6 OR e.ip = $6)
          ORDER BY e.at DESC LIMIT ${csv ? 20000 : 1000}`,
        [from, to, parseInt(req.query.user, 10) || null, req.query.action || null, req.query.result || null, req.query.q || null]);
      for (const r of rows) r.id = Number(r.id);
      if (!csv) return res.json({ from, to, events: rows, more: rows.length === 1000, radius: (await settings()).radius });
      const cols = ['at', 'name', 'action', 'result', 'message', 'method', 'mode', 'on_site', 'ip', 'forwarded_for', 'device_id', 'device_name', 'platform', 'user_agent', 'station', 'lat', 'lng', 'accuracy_m', 'distance_m', 'location_status', 'client_time', 'client_tz', 'shift_start', 'shift_end', 'late_minutes', 'attendance_id'];
      const q = (v) => { v = v == null ? '' : v instanceof Date ? v.toISOString() : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="clock-log-${from}-to-${to}.csv"`);
      res.send([cols.join(',')].concat(rows.map((r) => cols.map((c) => q(r[c])).join(','))).join('\n'));
    } catch (e) { fail(res, e); }
  });

  // The client's own address (for setting up the shop Wi-Fi rule from a phone on it).
  app.get('/api/clock/my-address', ...can('clock.manage'), (req, res) => res.json({ address: ipOf(req), on_shop_network: isLocal(req) }));

  // For clocklink.js: starting work elsewhere (a till, a driver shift, devotion)
  // clocks the signed-in person in, with the same rules as My time.
  const link = {
    openEntry: (uid) => openEntry(uid),
    exempt: async (uid) => { const s = await settings(); const u = await staffRow(uid); return !u || s.exempt.includes(u.admin_role); },
    punch: async (req, b) => {
      b = b || {};
      let ctx = {};
      ctx = await ctxOf(req, b);
      const u = await staffRow(req.session.userId);
      if (!u || u.disabled) throw httpError(403, 'Unknown user');
      try { return await doPunch(req, u, 'session', b, ctx); }
      catch (e) { logRefusal(req, Object.assign({ method: 'session' }, b), ctx, u.id, e); throw e; }
    },
  };
  return { presence, weekFor, useNotices(fn) { notify = fn; }, link };
}

module.exports = { register };
