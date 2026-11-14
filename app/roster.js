// =============================================================================
//  Morty's Auto Parts -- Work roster
//
//    require('./roster').register(app, { query, getPool, requireAdmin, requireCap, userCan, notice })
//
//  Who should be at work, who is, and who is missing and why.
//
//  The plan for a person on a day comes from, in this order:
//    1. leave (staff_leave: vacation, sick, unpaid, other)  -- always wins
//    2. a roster entry for that date (roster_entries): a shift, a day off,
//       or a planned absence (training, off-site, appointment ...)
//    3. a public holiday (public_holidays)
//    4. the weekly pattern (staff_shifts, set on Attendance > Staff & shifts)
//  timeclock.js shiftFor() follows the same order, so clock-in rules,
//  lateness and timesheets agree with the roster.
//
//  What happened comes from the time clock (attendance, attendance_breaks).
//
//  Capabilities: roster.view (see the board, the week and absences),
//  roster.plan (change the roster, add leave from the roster). Anyone with
//  clock.approve / clock.manage can also see it; clock.manage can also plan.
//  Every staff member sees their own roster (/api/roster/me).
//
//  Tables are made on first use (no DDL at server start) and are also in
//  schema.sql.
// =============================================================================
'use strict';

const OFFSET = '-05:00';                       // Jamaica keeps no daylight saving
const REASONS = { training: 'Training', off_site: 'Working off site', appointment: 'Appointment', day_off: 'Day off in lieu', suspended: 'Suspended', other: 'Other' };
const LEAVE = { vacation: 'Vacation leave', sick: 'Sick leave', unpaid: 'Unpaid leave', other: 'Other leave' };
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/, TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const DDL = `
CREATE TABLE IF NOT EXISTS roster_entries (
  id             SERIAL PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day            DATE NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('shift', 'off', 'away')),
  start_time     TIME,
  end_time       TIME,
  break_minutes  INTEGER NOT NULL DEFAULT 60,
  post           TEXT,               -- where / what: "Till 2", "Counter", "Warehouse"
  reason         TEXT,               -- away: training | off_site | appointment | day_off | suspended | other
  note           TEXT,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, day)
);
CREATE INDEX IF NOT EXISTS idx_roster_entries_day ON roster_entries (day);
CREATE TABLE IF NOT EXISTS roster_log (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  day         DATE,
  action      TEXT NOT NULL,
  before      JSONB,
  after       JSONB,
  by_user     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_roster_log_day ON roster_log (day);
`;

function register(app, deps) {
  const { query, getPool, requireAdmin, userCan } = deps;
  const notice = deps.notice || null;

  // ------------------------------------------------------------ helpers --
  function httpError(status, msg) { const e = new Error(msg); e.status = status; e.publicMessage = msg; return e; }
  function fail(res, e) { const s = e.status || 500; if (s >= 500) console.error('[roster]', e); res.status(s).json({ error: e.publicMessage || e.message }); }
  let readyP = null;
  function ready() {
    if (!readyP) readyP = (async () => {
      const c = await getPool().connect();
      try {
        await c.query(`SELECT pg_advisory_lock(hashtext('vision.roster.ddl'))`);
        try { await c.query(DDL); } finally { await c.query(`SELECT pg_advisory_unlock(hashtext('vision.roster.ddl'))`); }
      } finally { c.release(); }
    })().catch((e) => { readyP = null; throw e; });
    return readyP;
  }
  const jmDay = (d) => new Date(new Date(d || Date.now()).getTime() - 5 * 3600000).toISOString().slice(0, 10);
  const at = (day, hhmm) => new Date(day + 'T' + String(hhmm).slice(0, 5) + ':00' + OFFSET);
  const addDays = (day, n) => new Date(new Date(day + 'T12:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);
  const weekday = (day) => new Date(day + 'T12:00:00Z').getUTCDay();
  const mondayOf = (day) => addDays(day, -((weekday(day) + 6) % 7));
  const hhmm = (d) => new Date(new Date(d).getTime() - 5 * 3600000).toISOString().slice(11, 16);
  const mins = (s, e) => { let a = Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5)), b = Number(e.slice(0, 2)) * 60 + Number(e.slice(3, 5)); if (b <= a) b += 1440; return b - a; };
  const uidOf = (req) => req.session && req.session.userId;

  async function caps(req) {
    const c = async (k) => !!(userCan && await userCan(req, k));
    const [view, plan, cap, cman] = await Promise.all([c('roster.view'), c('roster.plan'), c('clock.approve'), c('clock.manage')]);
    return { view: view || plan || cap || cman, plan: plan || cman };
  }
  const canView = [requireAdmin, async (req, res, next) => { try { if ((await caps(req)).view) return next(); res.status(403).json({ error: 'Your account is not allowed to see the work roster.' }); } catch (e) { fail(res, e); } }];
  const canPlan = [requireAdmin, async (req, res, next) => { try { if ((await caps(req)).plan) return next(); res.status(403).json({ error: 'Your account is not allowed to plan the work roster.' }); } catch (e) { fail(res, e); } }];

  async function lateMinutes() {
    const { rows } = await query(`SELECT value FROM warehouse_settings WHERE key = 'clock_late_minutes'`);
    return (rows[0] && parseInt(rows[0].value, 10)) || 5;
  }

  // Staff who are rostered: the same people the time clock looks at.
  async function staffList(ids) {
    const { rows } = await query(
      `SELECT u.id, COALESCE(NULLIF(u.name, ''), u.email) AS name, u.admin_role AS role, h.department_id, d.name AS department
         FROM users u LEFT JOIN hr_employees h ON h.user_id = u.id LEFT JOIN departments d ON d.id = h.department_id
        WHERE u.is_staff AND NOT u.disabled AND COALESCE(u.admin_role, '') <> 'rep' ${ids ? 'AND u.id = ANY($1::int[])' : ''}
        ORDER BY d.name NULLS LAST, 2`, ids ? [ids] : []);
    return rows;
  }

  // The plan for every person and day in [from, to]: plan[uid][day] =
  //   { kind: 'shift'|'off'|'away'|'leave'|'holiday'|'none', source, start, end, break, hours, post, reason, label, note, entry_id, leave_id, clash }
  async function planFor(uids, from, to) {
    await ready();
    const [pat, lv, hol, ent] = await Promise.all([
      query(`SELECT user_id, weekday, to_char(start_time, 'HH24:MI') AS s, to_char(end_time, 'HH24:MI') AS e, break_minutes FROM staff_shifts WHERE user_id = ANY($1::int[])`, [uids]),
      query(`SELECT id, user_id, to_char(from_date, 'YYYY-MM-DD') AS f, to_char(to_date, 'YYYY-MM-DD') AS t, kind, note FROM staff_leave WHERE user_id = ANY($1::int[]) AND to_date >= $2::date AND from_date <= $3::date ORDER BY from_date`, [uids, from, to]),
      query(`SELECT to_char(day, 'YYYY-MM-DD') AS day, name FROM public_holidays WHERE day BETWEEN $1::date AND $2::date`, [from, to]),
      query(`SELECT id, user_id, to_char(day, 'YYYY-MM-DD') AS day, kind, to_char(start_time, 'HH24:MI') AS s, to_char(end_time, 'HH24:MI') AS e, break_minutes, post, reason, note FROM roster_entries WHERE user_id = ANY($1::int[]) AND day BETWEEN $2::date AND $3::date`, [uids, from, to]),
    ]);
    const holidays = Object.fromEntries(hol.rows.map((h) => [h.day, h.name]));
    const out = {};
    for (const uid of uids) {
      out[uid] = {};
      for (let day = from; day <= to; day = addDays(day, 1)) {
        const l = lv.rows.find((x) => x.user_id === uid && day >= x.f && day <= x.t);
        const e = ent.rows.find((x) => x.user_id === uid && x.day === day);
        const p = pat.rows.find((x) => x.user_id === uid && x.weekday === weekday(day));
        let v;
        if (l) v = { kind: 'leave', source: 'leave', reason: l.kind, label: LEAVE[l.kind] || 'Leave', note: l.note, leave_id: l.id, leave_from: l.f, leave_to: l.t,
          clash: e && e.kind === 'shift' ? 'A shift is planned but leave wins' : null };
        else if (e && e.kind === 'shift') v = { kind: 'shift', source: 'roster', start: e.s, end: e.e, break: e.break_minutes, post: e.post, note: e.note,
          label: holidays[day] ? 'Working the holiday (' + holidays[day] + ')' : null };
        else if (e && e.kind === 'off') v = { kind: 'off', source: 'roster', label: 'Day off', note: e.note };
        else if (e && e.kind === 'away') v = { kind: 'away', source: 'roster', reason: e.reason, label: REASONS[e.reason] || 'Away', note: e.note };
        else if (holidays[day]) v = { kind: 'holiday', source: 'holiday', label: 'Holiday: ' + holidays[day] };
        else if (p) v = { kind: 'shift', source: 'pattern', start: p.s, end: p.e, break: p.break_minutes };
        else v = { kind: 'none', source: 'pattern', label: 'Not working' };
        if (e) v.entry_id = e.id;
        if (v.kind === 'shift') v.hours = Math.round(Math.max(0, mins(v.start, v.end) - (v.break || 0)) / 6) / 10;
        out[uid][day] = v;
      }
    }
    return out;
  }

  async function attendanceFor(uids, from, to) {
    const { rows } = await query(
      `SELECT a.id, a.user_id, to_char(a.work_day, 'YYYY-MM-DD') AS day, a.clock_in_at, a.clock_out_at, a.mode, a.auto_closed, a.outside_shift, a.ot_status,
              (SELECT b.kind FROM attendance_breaks b WHERE b.attendance_id = a.id AND b.end_at IS NULL LIMIT 1) AS on_break
         FROM attendance a WHERE a.user_id = ANY($1::int[]) AND a.work_day BETWEEN $2::date AND $3::date ORDER BY a.clock_in_at`, [uids, from, to]);
    return rows;
  }

  // One person on one day: what was planned against what happened.
  function statusOf(p, att, day, today, late) {
    const nowMs = Date.now();
    const first = att[0], last = att[att.length - 1];
    const r = { first_in: first ? first.clock_in_at : null, last_out: last && last.clock_out_at ? last.clock_out_at : null, mode: last ? last.mode : null, notes: [] };
    if (att.length) {
      r.status = !last.clock_out_at ? (last.on_break ? 'break' : 'in') : 'gone';
      if (last.on_break) r.notes.push('on ' + last.on_break);
      if (last.mode === 'remote') r.notes.push('remote');
      if (p.kind === 'shift') {
        const st = at(day, p.start).getTime();
        const lm = Math.round((new Date(first.clock_in_at).getTime() - st) / 60000);
        if (lm > late) { r.late = lm; r.notes.push('late ' + lm + ' min'); }
        let en = at(day, p.end).getTime(); if (en <= st) en += 86400000;
        if (last.clock_out_at && !last.auto_closed && new Date(last.clock_out_at).getTime() < en - late * 60000) r.notes.push('left ' + Math.round((en - new Date(last.clock_out_at).getTime()) / 60000) + ' min early');
      } else {
        r.unplanned = true;
        r.notes.push(p.kind === 'none' || p.kind === 'off' ? 'not on the roster today' : 'came in while ' + (p.label || p.kind).toLowerCase());
      }
      if (att.some((a) => a.outside_shift)) r.notes.push('overtime ' + att.find((a) => a.outside_shift).ot_status);
      r.at_work = r.status !== 'gone';
      return r;
    }
    if (p.kind === 'shift') {
      const st = at(day, p.start).getTime();
      let en = at(day, p.end).getTime(); if (en <= st) en += 86400000;
      if (day > today) r.status = 'planned';
      else if (day < today || nowMs > en) r.status = 'absent';
      else if (nowMs <= st) r.status = 'due';
      else if (nowMs <= st + late * 60000) r.status = 'due';
      else { r.status = 'missing'; r.late = Math.round((nowMs - st) / 60000); r.notes.push(r.late + ' min after start, not clocked in'); }
      r.should_be_in = day === today && nowMs >= st && nowMs < en;
      return r;
    }
    r.status = (p.kind === 'none' || p.kind === 'off') ? 'off' : 'away';
    return r;
  }

  // ---------------------------------------------------------- endpoints --
  app.get('/api/roster/config', requireAdmin, async (req, res) => {
    try {
      const c = await caps(req);
      const staff = c.view ? await staffList() : [];
      res.json({ can_view: c.view, can_plan: c.plan, reasons: REASONS, leave_kinds: LEAVE, today: jmDay(), staff: staff.map((s) => ({ id: s.id, name: s.name, department: s.department })) });
    } catch (e) { fail(res, e); }
  });

  // The board: who should be at work on a day, who is, who is missing and why.
  app.get('/api/roster/board', ...canView, async (req, res) => {
    try {
      const today = jmDay();
      const day = DAY_RE.test(req.query.day || '') ? req.query.day : today;
      const staff = await staffList();
      const ids = staff.map((s) => s.id);
      const [plan, att, late] = await Promise.all([planFor(ids, day, day), attendanceFor(ids, day, day), lateMinutes()]);
      const people = staff.map((s) => {
        const p = plan[s.id][day];
        const a = att.filter((x) => x.user_id === s.id);
        return Object.assign({ user_id: s.id, name: s.name, department: s.department || 'No department', role: s.role, plan: p }, statusOf(p, a, day, today, late));
      });
      const count = (f) => people.filter(f).length;
      const summary = {
        rostered: count((x) => x.plan.kind === 'shift'),
        should_be_in_now: count((x) => x.should_be_in || (x.plan.kind === 'shift' && x.at_work)),
        at_work: count((x) => x.at_work),
        missing: count((x) => x.status === 'missing' || x.status === 'absent'),
        late: count((x) => x.late && x.status !== 'missing'),
        away: count((x) => x.status === 'away'),
        unplanned: count((x) => x.unplanned && x.at_work),
      };
      res.json({ day, today, is_today: day === today, now: new Date().toISOString(), late_minutes: late, summary, people });
    } catch (e) { fail(res, e); }
  });

  // A week: one row a person, Monday to Sunday.
  app.get('/api/roster/week', ...canView, async (req, res) => {
    try {
      const today = jmDay();
      const start = mondayOf(DAY_RE.test(req.query.start || '') ? req.query.start : today);
      const end = addDays(start, 6);
      const staff = await staffList();
      const ids = staff.map((s) => s.id);
      const [plan, att, late] = await Promise.all([planFor(ids, start, end), attendanceFor(ids, start, end), lateMinutes()]);
      const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
      const rows = staff.map((s) => {
        const cells = days.map((d) => {
          const p = plan[s.id][d];
          const st = d <= today ? statusOf(p, att.filter((x) => x.user_id === s.id && x.day === d), d, today, late) : null;
          return Object.assign({ day: d }, p, st ? { status: st.status, late: st.late || null, unplanned: !!st.unplanned } : {});
        });
        return { user_id: s.id, name: s.name, department: s.department || 'No department', hours: Math.round(cells.reduce((t, c) => t + (c.hours || 0), 0) * 10) / 10, cells };
      });
      const cover = days.map((d, i) => {
        const on = rows.filter((r) => r.cells[i].kind === 'shift');
        const byDept = {};
        on.forEach((r) => { byDept[r.department] = (byDept[r.department] || 0) + 1; });
        return { day: d, working: on.length, away: rows.filter((r) => ['leave', 'away'].includes(r.cells[i].kind)).length, by_department: byDept };
      });
      res.json({ start, end, today, days, rows, cover });
    } catch (e) { fail(res, e); }
  });

  // Absences in a range: leave, planned absences, holidays, and (for past days) unexplained no-shows.
  app.get('/api/roster/absences', ...canView, async (req, res) => {
    try {
      const today = jmDay();
      const from = DAY_RE.test(req.query.from || '') ? req.query.from : addDays(today, -7);
      let to = DAY_RE.test(req.query.to || '') ? req.query.to : addDays(today, 28);
      if (to < from) throw httpError(400, 'The "to" date is before the "from" date');
      if (addDays(from, 92) < to) to = addDays(from, 92);
      const staff = await staffList();
      const ids = staff.map((s) => s.id);
      const [plan, att, late] = await Promise.all([planFor(ids, from, to), attendanceFor(ids, from, addDays(today, 0) < to ? today : to), lateMinutes()]);
      const list = [];
      for (const s of staff) {
        let run = null;
        for (let d = from; d <= to; d = addDays(d, 1)) {
          const p = plan[s.id][d];
          let item = null;
          if (p.kind === 'leave' || p.kind === 'away') item = { kind: p.kind, reason: p.reason, label: p.label, note: p.note || null, leave_id: p.leave_id || null };
          else if (p.kind === 'shift' && d <= today) {
            const st = statusOf(p, att.filter((x) => x.user_id === s.id && x.day === d), d, today, late);
            if (st.status === 'absent' || st.status === 'missing') item = { kind: 'no_show', label: d === today ? 'Not in yet, no reason given' : 'Did not come in, no reason given' };
          }
          const key = item && [item.kind, item.reason, item.label, item.note, item.leave_id].join('|');
          if (item && run && run.key === key && run.to === addDays(d, -1)) { run.to = d; run.days++; continue; }
          if (run) { list.push(run); run = null; }
          if (item) run = Object.assign({ user_id: s.id, name: s.name, department: s.department || 'No department', from: d, to: d, days: 1, key }, item);
        }
        if (run) list.push(run);
      }
      list.forEach((x) => { delete x.key; });
      list.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.name.localeCompare(b.name)));
      const { rows: hol } = await query(`SELECT to_char(day, 'YYYY-MM-DD') AS day, name FROM public_holidays WHERE day BETWEEN $1::date AND $2::date ORDER BY day`, [from, to]);
      res.json({ from, to, absences: list, holidays: hol });
    } catch (e) { fail(res, e); }
  });

  // My roster: the next two weeks (and this week so far).
  app.get('/api/roster/me', requireAdmin, async (req, res) => {
    try {
      const uid = uidOf(req);
      const today = jmDay();
      const from = mondayOf(today), to = addDays(from, 20);
      const plan = (await planFor([uid], from, to))[uid];
      res.json({ today, days: Object.keys(plan).map((d) => Object.assign({ day: d }, plan[d])) });
    } catch (e) { fail(res, e); }
  });

  async function log(c, uid, day, action, before, after, by) {
    await c.query(`INSERT INTO roster_log (user_id, day, action, before, after, by_user) VALUES ($1,$2,$3,$4,$5,$6)`, [uid, day, action, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, by]);
  }
  async function tx(fn) {
    await ready();
    const c = await getPool().connect();
    try { await c.query('BEGIN'); const out = await fn(c); await c.query('COMMIT'); return out; }
    catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} throw e; }
    finally { c.release(); }
  }
  function cleanEntry(b) {
    const kind = String(b.kind || '');
    if (!['shift', 'off', 'away'].includes(kind)) throw httpError(400, 'Pick a shift, a day off or away');
    const e = { kind, start: null, end: null, break: 0, post: String(b.post || '').trim().slice(0, 60) || null, reason: null, note: String(b.note || '').trim().slice(0, 200) || null };
    if (kind === 'shift') {
      if (!TIME_RE.test(b.start || '') || !TIME_RE.test(b.end || '')) throw httpError(400, 'Start and end times as HH:MM');
      if (b.start === b.end) throw httpError(400, 'The shift starts and ends at the same time');
      e.start = b.start; e.end = b.end;
      e.break = Math.max(0, Math.min(240, parseInt(b.break, 10) || 0));
      if (e.break >= mins(e.start, e.end)) throw httpError(400, 'The break is longer than the shift');
    }
    if (kind === 'away') {
      if (!REASONS[b.reason]) throw httpError(400, 'Say why they are away');
      e.reason = b.reason;
      if (b.reason === 'other' && !e.note) throw httpError(400, 'Add a note for "Other"');
    }
    if (kind !== 'shift') e.post = null;
    return e;
  }
  async function upsert(c, uid, day, e, by) {
    const { rows: was } = await c.query(`SELECT kind, to_char(start_time, 'HH24:MI') AS start, to_char(end_time, 'HH24:MI') AS end, break_minutes AS break, post, reason, note FROM roster_entries WHERE user_id = $1 AND day = $2`, [uid, day]);
    await c.query(
      `INSERT INTO roster_entries (user_id, day, kind, start_time, end_time, break_minutes, post, reason, note, created_by, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,NOW())
       ON CONFLICT (user_id, day) DO UPDATE SET kind = EXCLUDED.kind, start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time, break_minutes = EXCLUDED.break_minutes,
         post = EXCLUDED.post, reason = EXCLUDED.reason, note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [uid, day, e.kind, e.start, e.end, e.break, e.post, e.reason, e.note, by]);
    await log(c, uid, day, was.length ? 'change' : 'add', was[0] || null, e, by);
  }
  async function checkStaff(ids) {
    const s = await staffList(ids);
    if (s.length !== new Set(ids).size) throw httpError(404, 'Staff member not found');
    return s;
  }

  // Set one or more days for one or more people.
  //   { user_ids: [..] | user_id, days: [..] | day, kind, start, end, break, post, reason, note }
  app.put('/api/roster/entry', ...canPlan, async (req, res) => {
    try {
      const b = req.body || {};
      const uids = [...new Set((Array.isArray(b.user_ids) ? b.user_ids : [b.user_id]).map((x) => parseInt(x, 10)).filter(Boolean))];
      const days = [...new Set(Array.isArray(b.days) ? b.days : [b.day])].filter((d) => DAY_RE.test(d || ''));
      if (!uids.length || !days.length) throw httpError(400, 'Pick who and which days');
      if (uids.length * days.length > 400) throw httpError(400, 'Too many at once');
      await checkStaff(uids);
      const e = cleanEntry(b);
      await tx(async (c) => { for (const u of uids) for (const d of days) await upsert(c, u, d, e, uidOf(req)); });
      const plan = await planFor(uids, days.slice().sort()[0], days.slice().sort().pop());
      const clashes = [];
      uids.forEach((u) => days.forEach((d) => { if (plan[u][d].clash) clashes.push({ user_id: u, day: d, label: plan[u][d].label }); }));
      res.json({ ok: true, saved: uids.length * days.length, clashes });
    } catch (e) { fail(res, e); }
  });
  // Back to the weekly pattern for a day.
  app.delete('/api/roster/entry', ...canPlan, async (req, res) => {
    try {
      const uid = parseInt(req.query.user_id, 10), day = String(req.query.day || '');
      if (!uid || !DAY_RE.test(day)) throw httpError(400, 'Who and which day');
      const n = await tx(async (c) => {
        const { rows } = await c.query(`DELETE FROM roster_entries WHERE user_id = $1 AND day = $2 RETURNING kind, to_char(start_time, 'HH24:MI') AS start, to_char(end_time, 'HH24:MI') AS end, reason, note`, [uid, day]);
        if (rows.length) await log(c, uid, day, 'reset', rows[0], null, uidOf(req));
        return rows.length;
      });
      res.json({ ok: true, removed: n });
    } catch (e) { fail(res, e); }
  });

  // Copy one week's roster onto another. Leave and holidays are not copied
  // (they come from their own lists); planned absences are not copied either.
  app.post('/api/roster/copy-week', ...canPlan, async (req, res) => {
    try {
      const b = req.body || {};
      if (!DAY_RE.test(b.from || '') || !DAY_RE.test(b.to || '')) throw httpError(400, 'Which week to copy from and to');
      const src = mondayOf(b.from), dst = mondayOf(b.to);
      if (src === dst) throw httpError(400, 'Pick two different weeks');
      const overwrite = !!b.overwrite;
      const staff = await staffList();
      const ids = staff.map((s) => s.id);
      const sp = await planFor(ids, src, addDays(src, 6));
      const { rows: have } = await query(`SELECT user_id, to_char(day, 'YYYY-MM-DD') AS day FROM roster_entries WHERE day BETWEEN $1::date AND $2::date`, [dst, addDays(dst, 6)]);
      let copied = 0, kept = 0;
      await tx(async (c) => {
        for (const u of ids) for (let i = 0; i < 7; i++) {
          const p = sp[u][addDays(src, i)], d = addDays(dst, i);
          if (p.source !== 'roster' || !['shift', 'off'].includes(p.kind)) continue;     // only changes made on the roster
          if (!overwrite && have.some((h) => h.user_id === u && h.day === d)) { kept++; continue; }
          await upsert(c, u, d, { kind: p.kind, start: p.start || null, end: p.end || null, break: p.break || 0, post: p.post || null, reason: null, note: p.note || null }, uidOf(req));
          copied++;
        }
      });
      res.json({ ok: true, copied, kept });
    } catch (e) { fail(res, e); }
  });
  // Take a week's roster changes off (everyone back to their weekly pattern).
  app.post('/api/roster/clear-week', ...canPlan, async (req, res) => {
    try {
      const b = req.body || {};
      if (!DAY_RE.test(b.start || '')) throw httpError(400, 'Which week');
      const s = mondayOf(b.start);
      const n = await tx(async (c) => {
        const { rows } = await c.query(`DELETE FROM roster_entries WHERE day BETWEEN $1::date AND $2::date ${b.keep_away ? "AND kind <> 'away'" : ''} RETURNING user_id`, [s, addDays(s, 6)]);
        await log(c, null, s, 'clear-week', null, { removed: rows.length, keep_away: !!b.keep_away }, uidOf(req));
        return rows.length;
      });
      res.json({ ok: true, removed: n });
    } catch (e) { fail(res, e); }
  });

  // Leave, from the roster. Same list as Attendance > Leave & holidays (and payroll).
  app.post('/api/roster/leave', ...canPlan, async (req, res) => {
    try {
      const b = req.body || {};
      const uid = parseInt(b.user_id, 10);
      if (!DAY_RE.test(b.from || '') || !DAY_RE.test(b.to || '') || b.to < b.from) throw httpError(400, 'From and to dates');
      if (!LEAVE[b.kind]) throw httpError(400, 'Which kind of leave');
      await checkStaff([uid]);
      const { rows: ov } = await query(`SELECT 1 FROM staff_leave WHERE user_id = $1 AND to_date >= $2::date AND from_date <= $3::date LIMIT 1`, [uid, b.from, b.to]);
      if (ov.length) throw httpError(409, 'They already have leave on some of those days');
      const { rows } = await query(`INSERT INTO staff_leave (user_id, from_date, to_date, kind, note, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [uid, b.from, b.to, b.kind, String(b.note || '').trim().slice(0, 200) || null, uidOf(req)]);
      await ready();
      await query(`INSERT INTO roster_log (user_id, day, action, after, by_user) VALUES ($1,$2,'leave',$3,$4)`, [uid, b.from, JSON.stringify({ id: rows[0].id, kind: b.kind, from: b.from, to: b.to }), uidOf(req)]);
      res.json({ ok: true, id: rows[0].id });
    } catch (e) { fail(res, e); }
  });
  app.delete('/api/roster/leave/:id', ...canPlan, async (req, res) => {
    try {
      const { rows } = await query(`DELETE FROM staff_leave WHERE id = $1 RETURNING user_id, kind, to_char(from_date, 'YYYY-MM-DD') AS f, to_char(to_date, 'YYYY-MM-DD') AS t`, [parseInt(req.params.id, 10)]);
      if (!rows.length) throw httpError(404, 'Leave not found');
      await ready();
      await query(`INSERT INTO roster_log (user_id, day, action, before, by_user) VALUES ($1,$2,'leave-removed',$3,$4)`, [rows[0].user_id, rows[0].f, JSON.stringify(rows[0]), uidOf(req)]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // Send each person their week as a team notice.
  app.post('/api/roster/send-week', ...canPlan, async (req, res) => {
    try {
      if (!notice) throw httpError(503, 'Team notices are not available');
      const b = req.body || {};
      const start = mondayOf(DAY_RE.test(b.start || '') ? b.start : jmDay());
      const staff = await staffList();
      const plan = await planFor(staff.map((s) => s.id), start, addDays(start, 6));
      const DN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      let sent = 0;
      for (const s of staff) {
        const lines = Object.keys(plan[s.id]).map((d) => { const p = plan[s.id][d]; return DN[weekday(d)] + ' ' + d.slice(5) + ': ' + (p.kind === 'shift' ? p.start + '–' + p.end + (p.post ? ' (' + p.post + ')' : '') : (p.label || 'Off')); });
        await notice([s.id], { kind: 'roster', title: '🗓 Your roster for the week of ' + start, body: lines.join('\n'), link: '/roster.html#me' });
        sent++;
      }
      await ready();
      await query(`INSERT INTO roster_log (day, action, after, by_user) VALUES ($1,'sent',$2,$3)`, [start, JSON.stringify({ people: sent }), uidOf(req)]);
      res.json({ ok: true, sent });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/roster/log', ...canView, async (req, res) => {
    try {
      await ready();
      const { rows } = await query(
        `SELECT l.id, l.action, to_char(l.day, 'YYYY-MM-DD') AS day, l.before, l.after, l.at, u.name AS who, b.name AS by_name
           FROM roster_log l LEFT JOIN users u ON u.id = l.user_id LEFT JOIN users b ON b.id = l.by_user ORDER BY l.id DESC LIMIT 200`);
      res.json({ log: rows });
    } catch (e) { fail(res, e); }
  });

  return { planFor, ready };
}

module.exports = { register, DDL };
