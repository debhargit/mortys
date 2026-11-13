// =============================================================================
//  Vision Auto Solutions -- One clock-in (clocklink.js, 2026-11-07)
//
//  Mounted in server.js before fleet.js, the time clock and the cashier routes:
//    require('./clocklink').register(app, { query, getPool, requireAdmin, userCan,
//      clock: () => timeclock, dayplan: () => dayplanApi, worklog: () => worklogApi })
//  (clock / dayplan / worklog are read when a request comes in, so they can be
//  mounted later in server.js.)
//
//  Staff start work in several places: the time clock, opening or taking over a
//  till, starting a driver shift, signing in to the morning devotion. With this
//  module those all lead to the one time-clock record:
//    - starting work anywhere clocks the person in (same rules as My time:
//      on site or allowed remote, inside the shift or confirmed overtime), if
//      they are not clocked in already. If the clock refuses, the till / drive /
//      devotion still goes ahead (unless "block" is on) and the answer says why.
//    - clocking out ends an open driver shift; the automatic clock-out at the end
//      of a shift does too.
//    - GET /api/clocklink/day shows, per person, the clock-in next to every other
//      start of work (devotion, till, driver shift, first and last transaction)
//      and flags where they do not agree.
//  Settings: warehouse_settings clocklink_* (see DEFAULTS). Every link is logged
//  in clocklink_events.
// =============================================================================
'use strict';

const OFFSET = '-05:00';   // Jamaica, no daylight saving
const DDL = `
CREATE TABLE IF NOT EXISTS clocklink_events (
  id             BIGSERIAL PRIMARY KEY,
  user_id        INTEGER REFERENCES users(id) ON DELETE CASCADE,
  source         TEXT NOT NULL,              -- till | drive | devotion | clock
  action         TEXT NOT NULL,              -- in | end_drive
  result         TEXT NOT NULL,              -- ok | refused | skipped
  attendance_id  BIGINT,
  message        TEXT,
  at             TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_clocklink_events_at ON clocklink_events (at, user_id);
`;
const SOURCES = [
  // caps: the person must be allowed to do the thing (any one of them), or nobody is clocked in
  { key: 'till', re: /^\/api\/cash\/till\/(open|open-shift|takeover)$/, label: 'opening the till', caps: ['cashier.access', 'pos.finalise_invoice', 'pos.access', 'pos.open_close_shift'] },
  { key: 'drive', re: /^\/api\/fleet\/shift\/start$/, label: 'starting the driver shift', caps: ['fleet.drive'] },
  { key: 'devotion', re: /^\/api\/dayplan\/devotion\/join$/, label: 'signing in to devotion', caps: null },
];
const PUNCH = /^\/api\/clock\/(me\/)?punch$/;
const DEFAULTS = { clocklink_till: 'on', clocklink_drive: 'on', clocklink_devotion: 'on', clocklink_block: 'off', clocklink_out_ends_drive: 'on', clocklink_tolerance: '10' };
const LABELS = {
  clocklink_till: 'Opening or taking over a till clocks the person in',
  clocklink_drive: 'Starting a driver shift clocks the driver in',
  clocklink_devotion: 'Signing yourself in to devotion clocks you in',
  clocklink_block: 'If the clock-in is refused, stop the till / driver shift too (devotion always goes ahead)',
  clocklink_out_ends_drive: 'Clocking out (or the automatic clock-out) ends an open driver shift',
  clocklink_tolerance: 'Minutes of difference allowed before a mismatch is flagged',
};

function register(app, deps) {
  const { query, getPool, requireAdmin, userCan } = deps;
  const lazy = (f) => () => { try { return f ? f() : null; } catch (_) { return null; } };
  const clock = lazy(deps.clock), dayplan = lazy(deps.dayplan), worklog = lazy(deps.worklog);

  function httpError(status, msg) { const e = new Error(msg); e.status = status; e.publicMessage = msg; return e; }
  function fail(res, e) { const s = e.status || 500; if (s >= 500) console.error('[clocklink]', e); res.status(s).json({ error: e.publicMessage || e.message }); }
  const jmDay = (d) => new Date(new Date(d || Date.now()).getTime() - 5 * 3600000).toISOString().slice(0, 10);
  const at = (day, hhmm) => new Date(day + 'T' + String(hhmm).slice(0, 5) + ':00' + OFFSET);
  const addDays = (day, n) => new Date(new Date(day + 'T12:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);
  const ms = (d) => (d ? new Date(d).getTime() : null);
  const iso = (d) => (d ? new Date(d).toISOString() : null);
  const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

  let readyP = null;
  function ready() {
    if (!readyP) readyP = (async () => {
      const c = await getPool().connect();
      try {
        await c.query(`SELECT pg_advisory_lock(hashtext('vision.clocklink.ddl'))`);
        try { await c.query(DDL); } finally { await c.query(`SELECT pg_advisory_unlock(hashtext('vision.clocklink.ddl'))`); }
      } finally { c.release(); }
    })().catch((e) => { readyP = null; throw e; });
    return readyP;
  }
  let sCache = null;
  async function settings() {
    if (sCache && sCache.at > Date.now() - 30000) return sCache.v;
    const { rows } = await query(`SELECT key, value FROM warehouse_settings WHERE key LIKE 'clocklink\\_%'`);
    const v = Object.assign({}, DEFAULTS);
    for (const r of rows) if (r.key in DEFAULTS) v[r.key] = r.value;
    sCache = { at: Date.now(), v };
    return v;
  }
  async function log(uid, source, action, result, attendanceId, message) {
    try {
      await ready();
      await query(`INSERT INTO clocklink_events (user_id, source, action, result, attendance_id, message) VALUES ($1,$2,$3,$4,$5,$6)`,
        [uid, source, action, result, attendanceId || null, message ? String(message).slice(0, 300) : null]);
    } catch (e) { console.error('[clocklink] log', e.message); }
  }
  // Put {clock: ...} on the route's own JSON answer.
  function attach(res, info) {
    const j = res.json.bind(res);
    res.json = (body) => j(body && typeof body === 'object' && !Array.isArray(body) ? Object.assign({ clock: info }, body) : body);
  }
  let tables = null, tablesAt = 0;
  async function has() {
    if (tables && Date.now() - tablesAt < 300000) return tables;
    const names = ['driver_shifts', 'till_turns', 'till_sessions', 'pos_stations', 'dayplan_devotion_attendance', 'attendance', 'staff_leave'];
    const { rows } = await query(`SELECT n, to_regclass('public.' || n) IS NOT NULL AS ok FROM unnest($1::text[]) n`, [names]);
    tables = Object.fromEntries(rows.map((r) => [r.n, r.ok])); tablesAt = Date.now();
    return tables;
  }
  async function endDrive(uid, why) {
    if (!(await has()).driver_shifts) return 0;
    const { rows } = await query(`UPDATE driver_shifts SET ended_at = NOW() WHERE user_id = $1 AND ended_at IS NULL RETURNING id`, [uid]);
    if (rows.length) await log(uid, 'clock', 'end_drive', 'ok', null, 'Driver shift ended: ' + why);
    return rows.length;
  }

  // ------------------------------------------- starting work clocks in --
  app.use(async (req, res, next) => {
    if (req.method !== 'POST') return next();
    const path = req.path;
    if (PUNCH.test(path)) {
      // clocking out ends the driver shift (after the time clock has answered)
      const j = res.json.bind(res);
      res.json = (body) => {
        const out = j(body);
        if (body && body.done === 'out' && body.entry && body.entry.user_id) {
          settings().then((s) => (s.clocklink_out_ends_drive === 'on' ? endDrive(body.entry.user_id, 'clocked out') : 0)).catch((e) => console.error('[clocklink]', e.message));
        }
        return out;
      };
      return next();
    }
    const src = SOURCES.find((x) => x.re.test(path));
    if (!src) return next();
    try {
      const uid = req.session && req.session.userId;
      const tc = clock();
      if (!uid || !tc || !tc.link) return next();
      const s = await settings();
      if (s['clocklink_' + src.key] !== 'on') return next();
      const b = req.body || {};
      if (src.key === 'devotion' && (b.remove || (b.user_id && Number(b.user_id) !== uid))) return next();   // only your own sign-in
      if (await tc.link.openEntry(uid)) return next();                     // already clocked in
      if (await tc.link.exempt(uid)) return next();                        // owner etc. never clock
      if (src.caps && userCan) {
        let ok = false;
        for (const k of src.caps) if (await userCan(req, k)) { ok = true; break; }
        if (!ok) return next();                                            // the route itself will say no
      }
      // The page may send the time-clock answers along: {clock: {confirm_overtime, ot_reason, ctx}}
      const extra = b.clock && typeof b.clock === 'object' ? b.clock : {};
      try {
        const out = await tc.link.punch(req, { action: 'in', confirm_overtime: !!extra.confirm_overtime, ot_reason: extra.ot_reason, ctx: extra.ctx || b.ctx });
        const msg = out.message + ' (by ' + src.label + ')';
        await log(uid, src.key, 'in', 'ok', out.entry && out.entry.id, msg);
        attach(res, { clocked_in: true, message: msg });
        return next();
      } catch (e) {
        if (!e.status || e.status >= 500) console.error('[clocklink] punch', e);
        const why = e.publicMessage || 'the time clock could not be reached';
        const needOt = !!(e.extra && e.extra.need_overtime);
        await log(uid, src.key, 'in', 'refused', null, why);
        if (s.clocklink_block === 'on' && src.key !== 'devotion') {
          return res.status(e.status && e.status < 500 ? e.status : 403).json(Object.assign({ error: 'Clock in first: ' + why, code: 'clock' }, e.extra || {}));
        }
        attach(res, { clocked_in: false, need_overtime: needOt, message: 'You are not clocked in: ' + why + (needOt ? ' Clock in on My time.' : '') });
        return next();
      }
    } catch (e) { console.error('[clocklink]', e); return next(); }   // never stops the till / driver / devotion
  });

  // The automatic clock-out at the end of a shift: end the driver shift too.
  async function tick() {
    try {
      const s = await settings();
      if (s.clocklink_out_ends_drive !== 'on') return;
      const t = await has();
      if (!t.driver_shifts || !t.attendance) return;
      // still driving, no longer clocked in, and clocked out since the drive began
      const { rows } = await query(
        `SELECT DISTINCT d.user_id FROM driver_shifts d
          WHERE d.ended_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM attendance a WHERE a.user_id = d.user_id AND a.clock_out_at IS NULL)
            AND EXISTS (SELECT 1 FROM attendance a WHERE a.user_id = d.user_id AND a.clock_out_at > d.started_at AND a.clock_out_at > NOW() - INTERVAL '1 day')`);
      for (const r of rows) await endDrive(r.user_id, 'clocked out at the end of the shift');
    } catch (e) { console.error('[clocklink] tick', e.message); }
  }
  if (!deps.noTimer) setInterval(() => tick(), 120000).unref();

  // ------------------------------------------------------ one day view --
  async function caps(req) {
    const dp = dayplan();
    if (dp && dp.caps) { const c = await dp.caps(req); return { all: !!c.all, manage: !!c.manage }; }
    const c = async (k) => !!(userCan && await userCan(req, k));
    const [m, a] = await Promise.all([c('clock.manage'), c('clock.approve')]);
    return { all: m || a, manage: m };
  }
  async function staffList() {
    const dp = dayplan();
    if (dp && dp.staffList) return dp.staffList();
    const { rows } = await query(`SELECT id, COALESCE(NULLIF(name, ''), email) AS name, admin_role AS role, NULL AS department FROM users WHERE is_staff AND NOT disabled ORDER BY 2`);
    return rows;
  }
  // Intervals [a, b] in ms; minutes of [x, y] outside all of them (with tolerance).
  function outside(x, y, ivs, tol) {
    let segs = [[x, y]];
    for (const [a, b] of ivs) {
      const A = a - tol, B = b + tol, next = [];
      for (const [p, q] of segs) { if (q <= A || p >= B) next.push([p, q]); else { if (p < A) next.push([p, A]); if (q > B) next.push([B, q]); } }
      segs = next;
    }
    return segs.reduce((t, [p, q]) => t + (q - p), 0) / 60000;
  }

  async function dayView(day, onlyUid) {
    await ready();
    const s = await settings(), t = await has();
    const tol = Math.max(0, parseInt(s.clocklink_tolerance, 10) || 10) * 60000;
    const from = at(day, '00:00'), to = at(addDays(day, 1), '00:00'), now = Date.now();
    const isToday = day === jmDay(), past = to.getTime() <= now;
    let staff = await staffList();
    const P = (sql, args) => query(sql, args).then((r) => r.rows);
    const [att, devRows, turns, drives, links] = await Promise.all([
      t.attendance ? P(`SELECT id, user_id, clock_in_at, clock_out_at, mode, method_in, method_out, auto_closed, outside_shift, ot_status, where_in FROM attendance
                         WHERE clock_in_at < $2 AND COALESCE(clock_out_at, NOW()) > $1 ORDER BY clock_in_at`, [from, to]) : [],
      t.dayplan_devotion_attendance ? P(`SELECT user_id, at, how, note FROM dayplan_devotion_attendance WHERE day = $1`, [day]) : [],
      t.till_turns && t.till_sessions ? P(`SELECT tt.user_id, tt.started_at, tt.ended_at, ${t.pos_stations ? 'st.name' : 'NULL'} AS station FROM till_turns tt JOIN till_sessions ts ON ts.id = tt.session_id
                         ${t.pos_stations ? 'LEFT JOIN pos_stations st ON st.id = ts.station_id' : ''} WHERE tt.started_at < $2 AND COALESCE(tt.ended_at, NOW()) > $1 ORDER BY tt.started_at`, [from, to])
        : t.till_sessions ? P(`SELECT user_id, opened_at AS started_at, closed_at AS ended_at, NULL AS station FROM till_sessions WHERE opened_at < $2 AND COALESCE(closed_at, NOW()) > $1`, [from, to]) : [],
      t.driver_shifts ? P(`SELECT user_id, started_at, ended_at, vehicle FROM driver_shifts WHERE started_at < $2 AND COALESCE(ended_at, NOW()) > $1 ORDER BY started_at`, [from, to]) : [],
      P(`SELECT user_id, source, action, result, message, at FROM clocklink_events WHERE at >= $1 AND at < $2 ORDER BY at`, [from, to]),
    ]);
    // add anyone who did something but is not on the staff list
    const known = new Set(staff.map((x) => x.id));
    const extraIds = [...new Set([].concat(att, devRows, turns, drives).map((r) => r.user_id).filter((i) => i && !known.has(i)))];
    if (extraIds.length) {
      const { rows } = await query(`SELECT id, COALESCE(NULLIF(name, ''), email) AS name, admin_role AS role, NULL AS department FROM users WHERE id = ANY($1::int[])`, [extraIds]);
      staff = staff.concat(rows);
    }
    if (onlyUid) staff = staff.filter((x) => x.id === onlyUid);
    const ids = staff.map((x) => x.id);
    const dp = dayplan(), wl = worklog();
    const plan = dp && dp.planFor && ids.length ? await dp.planFor(ids, day) : {};
    let dev = null;
    try { if (dp && dp.devotionFor) dev = await dp.devotionFor(day); } catch (_) {}
    const devOn = !!(dev && dev.mode && dev.mode !== 'off');
    let work = [];
    try { if (wl && wl.slots && ids.length) work = await wl.slots(from.getTime(), Math.min(to.getTime(), now), ids); } catch (e) { console.error('[clocklink] slots', e.message); }
    let exempt = new Set();
    try {
      const { rows } = await query(`SELECT value FROM warehouse_settings WHERE key = 'clock_exempt_roles'`);
      const roles = String(rows[0] ? rows[0].value : 'owner').split(',').map((x) => x.trim()).filter(Boolean);
      exempt = new Set(staff.filter((x) => roles.includes(x.role)).map((x) => x.id));
    } catch (_) {}

    const people = [];
    for (const u of staff) {
      const by = (arr) => arr.filter((r) => r.user_id === u.id);
      const A = by(att), D = by(devRows)[0] || null, TT = by(turns), DR = by(drives), L = by(links);
      const W = work.filter((w) => w.user_id === u.id && !(w.kind === 'activity'));
      const pl = plan[u.id] || null;
      const ivs = A.map((a) => [ms(a.clock_in_at), a.clock_out_at ? ms(a.clock_out_at) : now]);
      const firstIn = A.length ? ms(A[0].clock_in_at) : null;
      const lastOut = A.length && A.every((a) => a.clock_out_at) ? Math.max(...A.map((a) => ms(a.clock_out_at))) : null;
      const openNow = A.some((a) => !a.clock_out_at);
      const firstWork = W.length ? Math.min(...W.map((w) => ms(w.start))) : null;
      const lastWork = W.length ? Math.max(...W.map((w) => ms(w.end))) : null;
      const starts = [firstWork, TT.length ? ms(TT[0].started_at) : null, DR.length ? ms(DR[0].started_at) : null].filter((x) => x != null);
      const firstStart = starts.length ? Math.min(...starts) : null;
      const flags = [];
      const flag = (code, level, text) => flags.push({ code, level, text });
      const isEx = exempt.has(u.id);
      const rostered = pl && pl.kind === 'shift';
      const did = W.length || TT.length || DR.length || D;
      if (!isEx) {
        if (!A.length && (W.length || TT.length || DR.length)) flag('no_clock', 'bad', 'Worked but never clocked in');
        else if (!A.length && D) flag('dev_no_clock', 'warn', 'Signed in to devotion but never clocked in');
        if (A.length && firstStart != null && firstStart < firstIn - tol) flag('before_clock', 'warn', 'Started work ' + Math.round((firstIn - firstStart) / 60000) + ' min before clocking in');
        if (A.length) {
          // gaps between clock-ins (before the first and after the last are flagged on their own)
          const lo = firstIn, hi = lastOut != null ? lastOut : now;
          const off = W.reduce((m, w) => { const a = Math.max(ms(w.start), lo), b = Math.min(ms(w.end), hi); return b > a ? m + outside(a, b, ivs, tol) : m; }, 0);
          const afterOut = lastOut != null && lastWork != null && lastWork > lastOut + tol;
          if (afterOut) flag('after_clock', 'warn', 'Kept working ' + Math.round((lastWork - lastOut) / 60000) + ' min after clocking out');
          else if (off >= 1) flag('off_clock', 'warn', Math.round(off) + ' min of transactions while clocked out');
        }
        const tillOpen = TT.find((x) => !x.ended_at);
        if (tillOpen && A.length && !openNow && isToday) flag('till_open_out', 'bad', 'Till ' + (tillOpen.station ? tillOpen.station + ' ' : '') + 'still open, but clocked out');
        const driveOpen = DR.find((x) => !x.ended_at);
        if (driveOpen && A.length && !openNow && isToday) flag('drive_open_out', 'bad', 'Driver shift still running, but clocked out');
        if (rostered) {
          const start = at(day, pl.start).getTime();
          if (!A.length && (past || now > start + 30 * 60000) && !did) flag('absent', 'bad', 'Rostered ' + pl.start + '–' + pl.end + ', no clock-in');
          if (devOn && A.length && !D && dev.starts_at && (past || now > ms(dev.ends_at || dev.starts_at))) flag('no_devotion', 'info', 'Clocked in, not signed in to devotion');
        } else if (A.length && pl && pl.kind !== 'shift') flag('not_rostered', 'info', 'Clocked in on a day off the roster' + (pl.label ? ' (' + pl.label + ')' : ''));
      }
      if (!A.length && !did && !rostered && !onlyUid) continue;
      people.push({
        user_id: u.id, name: u.name, department: u.department || null, exempt: isEx,
        plan: pl ? { kind: pl.kind, start: pl.start || null, end: pl.end || null, label: pl.label || null } : null,
        clock: A.map((a) => ({ in: iso(a.clock_in_at), out: iso(a.clock_out_at), mode: a.mode, how_in: a.method_in, how_out: a.method_out, auto_out: a.auto_closed, overtime: a.outside_shift, where: a.where_in })),
        devotion: D ? { at: iso(D.at), how: D.how, note: D.note } : null,
        till: TT.map((x) => ({ start: iso(x.started_at), end: iso(x.ended_at), station: x.station })),
        drive: DR.map((x) => ({ start: iso(x.started_at), end: iso(x.ended_at), vehicle: x.vehicle })),
        work: W.length ? { first: iso(firstWork), last: iso(lastWork), count: W.reduce((n, w) => n + (w.n || 1), 0) } : null,
        links: L.map((x) => ({ source: x.source, action: x.action, result: x.result, message: x.message, at: iso(x.at) })),
        flags,
      });
    }
    const order = { bad: 0, warn: 1, info: 2 };
    people.sort((a, b) => (a.flags.length ? Math.min(...a.flags.map((f) => order[f.level])) : 9) - (b.flags.length ? Math.min(...b.flags.map((f) => order[f.level])) : 9) || String(a.name).localeCompare(String(b.name)));
    const totals = {
      people: people.length,
      clocked_in: people.filter((p) => p.clock.length).length,
      agree: people.filter((p) => !p.flags.some((f) => f.level !== 'info')).length,
      problems: people.filter((p) => p.flags.some((f) => f.level === 'bad')).length,
      warnings: people.filter((p) => p.flags.some((f) => f.level === 'warn')).length,
      linked: links.filter((x) => x.action === 'in' && x.result === 'ok').length,
    };
    return { day, devotion: devOn ? { starts_at: dev.starts_at || null, ends_at: dev.ends_at || null } : null, settings: s, labels: LABELS, totals, people };
  }

  app.get('/api/clocklink/day', requireAdmin, async (req, res) => {
    try {
      const day = DAY_RE.test(req.query.day || '') ? req.query.day : jmDay();
      const c = await caps(req);
      res.json(Object.assign(await dayView(day, c.all ? null : req.session.userId), { can_see_all: c.all, can_manage: c.manage }));
    } catch (e) { fail(res, e); }
  });
  app.get('/api/clocklink/settings', requireAdmin, async (req, res) => {
    try { res.json({ settings: await settings(), labels: LABELS }); } catch (e) { fail(res, e); }
  });
  app.put('/api/clocklink/settings', requireAdmin, async (req, res) => {
    try {
      if (!(await caps(req)).manage) throw httpError(403, 'Your account is not allowed to change this.');
      const b = req.body || {};
      for (const k of Object.keys(DEFAULTS)) {
        if (!(k in b)) continue;
        let v = String(b[k]);
        if (k === 'clocklink_tolerance') { const n = parseInt(v, 10); if (!(n >= 0 && n <= 120)) throw httpError(400, 'The tolerance is 0 to 120 minutes'); v = String(n); }
        else if (!['on', 'off'].includes(v)) throw httpError(400, k + ' is on or off');
        await query(`INSERT INTO warehouse_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [k, v]);
      }
      sCache = null;
      res.json({ settings: await settings() });
    } catch (e) { fail(res, e); }
  });

  return { dayView, tick, settings, ready, DEFAULTS };
}

module.exports = { register, DDL };
