// =============================================================================
//  Vision Auto Solutions -- Day plan: devotion, staff schedule, activities,
//  tracking and the day's performance
//
//    const dayplan = require('./dayplan').register(app, { query, getPool, requireAdmin, userCan, notice, emit, roster })
//
//  Every working day starts with "Start your day with God": a devotion at a
//  set time (system: a verse, a short reflection and a prayer picked for the
//  day; manual: a leader and the words set by a manager; or off). It is on
//  the team calendar for everyone, staff on the roster are told before it
//  starts and when it starts, and who joined is kept.
//
//  The staff schedule for a day is made from the work roster (roster.js):
//  everyone rostered, their shift, the devotion, and the day's activities.
//  Activities come from templates (made automatically each morning, or with
//  "Create the day's schedule"), from managers, from staff themselves, by
//  voice ("add stock count at 2 pm for 1 hour"), or imported from Google
//  Calendar (an .ics file or the calendar's secret iCal address).
//  Staff start and finish their activities; clock-ins, breaks and sales are
//  put on the same timeline from the time clock and the till.
//
//  Alerts (once a minute, each sent once): devotion soon / starting, staff
//  rostered but not clocked in N minutes after their start (to them and to
//  managers), an activity about to start.
//
//  Performance for the day, per person: activities done against planned,
//  time on them against plan, on-time starts, hours worked against rostered,
//  devotion, sales; and a score out of 100.
//
//  Permissions: dayplan.manage (activities for anyone, templates, devotion,
//  settings, everyone's performance). roster.view / roster.plan / clock.*
//  also see everyone's schedule and performance. Everyone: their own day.
//  Tables are made on first use and are in schema.sql.
// =============================================================================
'use strict';

const https = require('https');
const http = require('http');

const OFFSET = '-05:00';
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/, TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const CATEGORIES = { work: 'Work', sales: 'Sales', stock: 'Stock', cleaning: 'Cleaning', admin: 'Admin', delivery: 'Delivery', training: 'Training', meeting: 'Meeting', devotion: 'Devotion', break: 'Break', other: 'Other' };

const DDL = `
CREATE TABLE IF NOT EXISTS dayplan_devotions (
  day             DATE PRIMARY KEY,
  mode            TEXT NOT NULL DEFAULT 'system',   -- system | manual | off
  start_time      TIME,
  minutes         INTEGER,
  title           TEXT,
  scripture_ref   TEXT,
  scripture_text  TEXT,
  reflection      TEXT,
  prayer          TEXT,
  leader_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  location        TEXT,
  updated_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS dayplan_devotion_attendance (
  day      DATE NOT NULL,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  how      TEXT NOT NULL DEFAULT 'joined',             -- joined | marked
  at       TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (day, user_id)
);
CREATE TABLE IF NOT EXISTS dayplan_templates (
  id             SERIAL PRIMARY KEY,
  title          TEXT NOT NULL,
  category       TEXT NOT NULL DEFAULT 'work',
  start_time     TIME NOT NULL,
  minutes        INTEGER NOT NULL DEFAULT 30,
  weekdays       SMALLINT[] NOT NULL DEFAULT ARRAY[1,2,3,4,5,6]::SMALLINT[],
  user_id        INTEGER REFERENCES users(id) ON DELETE CASCADE,         -- one person, or
  department_id  INTEGER,                                                -- everyone rostered in a department, or
  everyone       BOOLEAN NOT NULL DEFAULT false,                         -- everyone rostered
  notes          TEXT,
  active         BOOLEAN NOT NULL DEFAULT true,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS dayplan_activities (
  id             BIGSERIAL PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day            DATE NOT NULL,
  title          TEXT NOT NULL,
  category       TEXT NOT NULL DEFAULT 'work',
  planned_start  TIMESTAMPTZ,
  planned_end    TIMESTAMPTZ,
  status         TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'in_progress', 'done', 'skipped')),
  actual_start   TIMESTAMPTZ,
  actual_end     TIMESTAMPTZ,
  notes          TEXT,
  result         TEXT,
  source         TEXT NOT NULL DEFAULT 'manual',   -- manual | template | voice | google | system
  template_id    INTEGER REFERENCES dayplan_templates(id) ON DELETE SET NULL,
  ext_uid        TEXT,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dayplan_act_day ON dayplan_activities (day, user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_dayplan_act_tpl ON dayplan_activities (template_id, user_id, day) WHERE template_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_dayplan_act_ext ON dayplan_activities (user_id, ext_uid, day) WHERE ext_uid IS NOT NULL;
CREATE TABLE IF NOT EXISTS dayplan_feeds (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label       TEXT,
  url         TEXT NOT NULL,
  auto        BOOLEAN NOT NULL DEFAULT true,
  last_sync   TIMESTAMPTZ,
  last_count  INTEGER,
  last_error  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS dayplan_alerts (
  kind     TEXT NOT NULL,
  ref      TEXT NOT NULL,
  day      DATE NOT NULL,
  at       TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (kind, ref, day)
);
ALTER TABLE dayplan_templates ADD COLUMN IF NOT EXISTS job_title TEXT;   -- everyone with this job title (hr_employees.job_title)
ALTER TABLE dayplan_templates ADD COLUMN IF NOT EXISTS is_duty BOOLEAN NOT NULL DEFAULT false;   -- one of a person's / job's duties (Duties tab)
ALTER TABLE dayplan_devotion_attendance ADD COLUMN IF NOT EXISTS note TEXT;              -- what they wrote when signing in
ALTER TABLE dayplan_devotion_attendance ADD COLUMN IF NOT EXISTS marked_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
CREATE TABLE IF NOT EXISTS dayplan_devotion_comments (
  id          BIGSERIAL PRIMARY KEY,
  day         DATE NOT NULL,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL DEFAULT 'comment' CHECK (kind IN ('comment', 'prayer', 'praise')),   -- comment | prayer request | praise report
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  removed_at  TIMESTAMPTZ,
  removed_by  INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_dayplan_dev_comments_day ON dayplan_devotion_comments (day, created_at);
`;

// Daily devotions for "system" mode: Scripture (King James Version, public
// domain), a short reflection and a prayer. Picked by the day of the year.
const DEVOTIONS = [
  ['This is the day', 'Psalm 118:24', 'This is the day which the LORD hath made; we will rejoice and be glad in it.', 'Today is a gift. Whatever the counter brings, we can meet it with a glad heart and a good attitude.', 'Lord, thank you for this day. Help us to serve every customer and each other with joy.'],
  ['Commit your work', 'Proverbs 16:3', 'Commit thy works unto the LORD, and thy thoughts shall be established.', 'Before the first sale, hand the day over to God. Plans made in prayer stand firmer.', 'Father, we commit our work today to you. Order our steps and our plans.'],
  ['Work as unto the Lord', 'Colossians 3:23', 'And whatsoever ye do, do it heartily, as to the Lord, and not unto men.', 'Every part found, every shelf packed, every receipt checked is done for God first. That makes ordinary work meaningful.', 'Lord, let our work today be done heartily, as an offering to you.'],
  ['Trust in the Lord', 'Proverbs 3:5-6', 'Trust in the LORD with all thine heart; and lean not unto thine own understanding. In all thy ways acknowledge him, and he shall direct thy paths.', 'We will not have every answer today. We can still trust the One who does.', 'Lord, we trust you with this day. Direct our paths and our decisions.'],
  ['Strength for today', 'Philippians 4:13', 'I can do all things through Christ which strengtheneth me.', 'A busy Saturday, a hard customer, a long count: none of it is bigger than the strength God gives.', 'Lord, give us strength for every task and patience for every person.'],
  ['Be kind', 'Ephesians 4:32', 'And be ye kind one to another, tenderhearted, forgiving one another, even as God for Christ\'s sake hath forgiven you.', 'Kindness between us shows on the shop floor. Customers feel it when a team is at peace.', 'Father, make us kind and forgiving to one another today.'],
  ['Do not worry', 'Philippians 4:6', 'Be careful for nothing; but in every thing by prayer and supplication with thanksgiving let your requests be made known unto God.', 'Whatever is weighing on you this morning, bring it to God in prayer and leave it with Him.', 'Lord, we bring you our worries. Give us your peace as we work.'],
  ['A soft answer', 'Proverbs 15:1', 'A soft answer turneth away wrath: but grievous words stir up anger.', 'When a customer is upset, a calm and gentle word does more than winning the argument.', 'Lord, guard our mouths. Help us answer with gentleness today.'],
  ['The Lord is my shepherd', 'Psalm 23:1', 'The LORD is my shepherd; I shall not want.', 'We are looked after. That frees us to look after others.', 'Good Shepherd, lead us today and provide for every need.'],
  ['Faithful in little', 'Luke 16:10', 'He that is faithful in that which is least is faithful also in much.', 'Honesty with small change, care with small parts, and keeping small promises build a business people trust.', 'Lord, make us faithful in the small things today.'],
  ['Serve one another', 'Galatians 5:13', 'By love serve one another.', 'Help the colleague who is behind. A team that serves each other serves customers well.', 'Lord, show us how to serve one another in love today.'],
  ['His mercies are new', 'Lamentations 3:22-23', 'It is of the LORD\'s mercies that we are not consumed, because his compassions fail not. They are new every morning: great is thy faithfulness.', 'Yesterday is finished. This morning there is fresh mercy and a fresh start.', 'Thank you, Lord, for mercies that are new this morning.'],
  ['Let your light shine', 'Matthew 5:16', 'Let your light so shine before men, that they may see your good works, and glorify your Father which is in heaven.', 'Good service, fair prices and honest advice are a light people notice.', 'Lord, let our work today point people to you.'],
  ['Wisdom', 'James 1:5', 'If any of you lack wisdom, let him ask of God, that giveth to all men liberally, and upbraideth not; and it shall be given him.', 'The right part, the right advice, the right decision: we can ask God for wisdom in all of it.', 'Lord, give us wisdom in every choice we make today.'],
  ['Be strong and courageous', 'Joshua 1:9', 'Be strong and of a good courage; be not afraid, neither be thou dismayed: for the LORD thy God is with thee whithersoever thou goest.', 'Wherever today sends you, on the counter, in the store room or on the road, God goes with you.', 'Lord, give us courage and remind us you are with us.'],
  ['Diligent hands', 'Proverbs 10:4', 'He becometh poor that dealeth with a slack hand: but the hand of the diligent maketh rich.', 'Steady, careful work adds up. Diligence today builds the business tomorrow.', 'Lord, make our hands diligent and our work careful.'],
  ['Peace', 'John 14:27', 'Peace I leave with you, my peace I give unto you: not as the world giveth, give I unto you. Let not your heart be troubled, neither let it be afraid.', 'Busy days can be peaceful hearts. Carry His peace onto the floor.', 'Lord Jesus, fill this shop with your peace today.'],
  ['Give thanks', '1 Thessalonians 5:18', 'In every thing give thanks: for this is the will of God in Christ Jesus concerning you.', 'Count the good: a job, a team, customers who come back. Thankful people work well together.', 'Father, we thank you for this work and this team.'],
  ['Love is patient', '1 Corinthians 13:4', 'Charity suffereth long, and is kind; charity envieth not; charity vaunteth not itself, is not puffed up.', 'Patience with a slow line or a new colleague is love in action.', 'Lord, grow patience and love in us today.'],
  ['Honest scales', 'Proverbs 11:1', 'A false balance is abomination to the LORD: but a just weight is his delight.', 'Every price and every count should be true. Honesty pleases God and keeps customers.', 'Lord, keep us honest in every sale and every count.'],
  ['Rest for the weary', 'Matthew 11:28', 'Come unto me, all ye that labour and are heavy laden, and I will give you rest.', 'If you came in tired, God offers rest for the soul even on a working day.', 'Lord, refresh the tired among us and carry our burdens.'],
  ['God is our refuge', 'Psalm 46:1', 'God is our refuge and strength, a very present help in trouble.', 'Whatever trouble comes today, help is already present.', 'Lord, be our refuge and our help today.'],
  ['Plans for good', 'Jeremiah 29:11', 'For I know the thoughts that I think toward you, saith the LORD, thoughts of peace, and not of evil, to give you an expected end.', 'God has good thoughts toward each of us, at home and at work.', 'Lord, thank you that your thoughts toward us are good.'],
  ['Encourage one another', '1 Thessalonians 5:11', 'Wherefore comfort yourselves together, and edify one another, even as also ye do.', 'Say a good word to someone on the team today. Encouragement is free and it lifts everyone.', 'Lord, help us build each other up today.'],
  ['Seek first', 'Matthew 6:33', 'But seek ye first the kingdom of God, and his righteousness; and all these things shall be added unto you.', 'Putting God first keeps everything else in the right place.', 'Lord, we seek you first this morning.'],
  ['Do good', 'Galatians 6:9', 'And let us not be weary in well doing: for in due season we shall reap, if we faint not.', 'Good work done day after day bears fruit in its time. Keep going.', 'Lord, keep us from growing weary in doing good.'],
  ['The Lord will guide', 'Psalm 32:8', 'I will instruct thee and teach thee in the way which thou shalt go: I will guide thee with mine eye.', 'God teaches and guides. Ask Him about the decisions in front of you today.', 'Lord, teach us and guide us in the way we should go.'],
  ['Humility', 'Philippians 2:3', 'Let nothing be done through strife or vainglory; but in lowliness of mind let each esteem other better than themselves.', 'Putting others first, customers and colleagues, is the way of Christ.', 'Lord, give us humble hearts and a servant spirit.'],
  ['A cheerful heart', 'Proverbs 17:22', 'A merry heart doeth good like a medicine.', 'A smile at the counter is good medicine for the customer and for us.', 'Lord, give us cheerful hearts today.'],
  ['God supplies', 'Philippians 4:19', 'But my God shall supply all your need according to his riches in glory by Christ Jesus.', 'We work hard, and we trust God to supply what we need.', 'Lord, we trust you to supply every need of this business and of each of us.'],
  ['Walk in love', 'John 13:34', 'A new commandment I give unto you, That ye love one another; as I have loved you, that ye also love one another.', 'The way we treat each other today is the clearest sermon we will preach.', 'Lord Jesus, help us love one another as you love us.'],
];

function register(app, deps) {
  const { query, getPool, requireAdmin, userCan } = deps;
  const notice = deps.notice || null, emit = deps.emit || null;
  const roster = deps.roster || null;

  function httpError(status, msg) { const e = new Error(msg); e.status = status; e.publicMessage = msg; return e; }
  function fail(res, e) { const s = e.status || 500; if (s >= 500) console.error('[dayplan]', e); res.status(s).json({ error: e.publicMessage || e.message }); }
  let readyP = null;
  function ready() {
    if (!readyP) readyP = (async () => {
      const c = await getPool().connect();
      try {
        await c.query(`SELECT pg_advisory_lock(hashtext('vision.dayplan.ddl'))`);
        try { await c.query(DDL); } finally { await c.query(`SELECT pg_advisory_unlock(hashtext('vision.dayplan.ddl'))`); }
      } finally { c.release(); }
    })().catch((e) => { readyP = null; throw e; });
    return readyP;
  }
  const jmDay = (d) => new Date(new Date(d || Date.now()).getTime() - 5 * 3600000).toISOString().slice(0, 10);
  const at = (day, hhmm) => new Date(day + 'T' + String(hhmm).slice(0, 5) + ':00' + OFFSET);
  const hhmm = (d) => new Date(new Date(d).getTime() - 5 * 3600000).toISOString().slice(11, 16);
  const addDays = (day, n) => new Date(new Date(day + 'T12:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);
  const weekday = (day) => new Date(day + 'T12:00:00Z').getUTCDay();
  const uid = (req) => req.session && req.session.userId;
  const str = (v, m) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, m));
  const iso = (d) => (d ? new Date(d).toISOString() : null);

  // ------------------------------------------------------------ access --
  async function caps(req) {
    const c = async (k) => !!(userCan && await userCan(req, k));
    const [m, rv, rp, ca, cm] = await Promise.all([c('dayplan.manage'), c('roster.view'), c('roster.plan'), c('clock.approve'), c('clock.manage')]);
    return { manage: m, all: m || rv || rp || ca || cm };
  }
  const canManage = [requireAdmin, async (req, res, next) => { try { if ((await caps(req)).manage) return next(); res.status(403).json({ error: 'Your account is not allowed to manage the day plan.' }); } catch (e) { fail(res, e); } }];

  // ---------------------------------------------------------- settings --
  const DEFAULTS = { devotion_mode: 'system', devotion_time: '07:45', devotion_minutes: '15', devotion_remind: '10', devotion_days: '1,2,3,4,5,6', devotion_location: 'Front counter',
    missing_grace: '10', missing_tell_managers: 'on', activity_remind: '5', auto_schedule: 'on', devotion_event_id: '',
    // opening hours per weekday (0 Sunday … 6 Saturday), "HH:MM-HH:MM" or "closed"; holidays are closed
    hours_0: 'closed', hours_1: '08:00-17:00', hours_2: '08:00-17:00', hours_3: '08:00-17:00', hours_4: '08:00-17:00', hours_5: '08:00-17:00', hours_6: '08:00-17:00',
    fill_auto: 'on', fill_lunch: 'on' };
  let sCache = null;
  async function settings() {
    if (sCache && sCache.at > Date.now() - 20000) return sCache.v;
    const { rows } = await query(`SELECT key, value FROM warehouse_settings WHERE key LIKE 'dayplan\\_%'`);
    const v = Object.assign({}, DEFAULTS);
    for (const r of rows) v[r.key.slice(8)] = r.value;
    v.days = String(v.devotion_days).split(',').map(Number).filter((x) => x >= 0 && x <= 6);
    sCache = { at: Date.now(), v };
    return v;
  }
  const put = (k, v) => query(`INSERT INTO warehouse_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, ['dayplan_' + k, String(v)]);

  // ------------------------------------------------------------ people --
  async function staffList() {
    const { rows } = await query(
      `SELECT u.id, COALESCE(NULLIF(u.name, ''), u.email) AS name, u.admin_role AS role, h.department_id, d.name AS department, h.job_title
         FROM users u LEFT JOIN hr_employees h ON h.user_id = u.id LEFT JOIN departments d ON d.id = h.department_id
        WHERE u.is_staff AND NOT u.disabled AND COALESCE(u.admin_role, '') <> 'rep' ORDER BY d.name NULLS LAST, 2`);
    return rows;
  }
  // The roster for a day: {uid: plan}. Falls back to the weekly pattern alone.
  async function planFor(ids, day) {
    if (roster && roster.planFor) { const p = await roster.planFor(ids, day, day); const o = {}; for (const i of ids) o[i] = p[i][day]; return o; }
    const { rows } = await query(`SELECT user_id, to_char(start_time, 'HH24:MI') AS s, to_char(end_time, 'HH24:MI') AS e, break_minutes FROM staff_shifts WHERE user_id = ANY($1::int[]) AND weekday = $2`, [ids, weekday(day)]);
    const o = {};
    for (const i of ids) { const r = rows.find((x) => x.user_id === i); o[i] = r ? { kind: 'shift', start: r.s, end: r.e, break: r.break_minutes } : { kind: 'none', label: 'Not working' }; }
    return o;
  }
  async function managers() {
    const { rows } = await query(`SELECT id FROM users WHERE is_staff AND NOT disabled AND admin_role IN ('owner', 'manager')`);
    return rows.map((r) => r.id);
  }

  // ---------------------------------------------------------- devotion --
  function systemDevotion(day) {
    const doy = Math.floor((new Date(day + 'T12:00:00Z') - new Date(day.slice(0, 4) + '-01-01T12:00:00Z')) / 86400000);
    const d = DEVOTIONS[doy % DEVOTIONS.length];
    return { title: d[0], scripture_ref: d[1], scripture_text: d[2], reflection: d[3], prayer: d[4] };
  }
  async function devotionFor(day) {
    await ready();
    const s = await settings();
    const { rows } = await query(`SELECT d.*, to_char(d.start_time, 'HH24:MI') AS st, u.name AS leader_name FROM dayplan_devotions d LEFT JOIN users u ON u.id = d.leader_user_id WHERE d.day = $1`, [day]);
    const r = rows[0];
    // no devotion on a public holiday unless a manager set one for that day
    const { rows: hol } = r ? { rows: [] } : await query(`SELECT name FROM public_holidays WHERE day = $1`, [day]).catch(() => ({ rows: [] }));
    const mode = r ? r.mode : (s.devotion_mode === 'off' || !s.days.includes(weekday(day)) || hol.length ? 'off' : s.devotion_mode === 'manual' ? 'manual' : 'system');
    const start = (r && r.st) || s.devotion_time, minutes = (r && r.minutes) || parseInt(s.devotion_minutes, 10) || 15;
    const base = { day, mode, start, minutes, starts_at: iso(at(day, start)), ends_at: iso(new Date(at(day, start).getTime() + minutes * 60000)),
      location: (r && r.location) || s.devotion_location, leader_user_id: r ? r.leader_user_id : null, leader_name: r ? r.leader_name : null, custom: !!r };
    if (mode === 'off') return base;
    const sys = systemDevotion(day);
    const words = mode === 'system' ? sys : { title: (r && r.title) || 'Devotion', scripture_ref: r && r.scripture_ref, scripture_text: r && r.scripture_text, reflection: r && r.reflection, prayer: r && r.prayer };
    if (mode === 'manual' && !words.scripture_ref && !words.reflection) words.suggested = sys;
    return Object.assign(base, words);
  }
  // The devotion as a repeating event on the team calendar.
  // The devotion goes on the team calendar day by day (calendarExtra), so it is left off Sundays,
  // public holidays and any day without one. A repeating team_events row (an earlier version)
  // could not skip those days, so it is cancelled here.
  async function syncCalendarEvent() {
    const s = await settings();
    const id = parseInt(s.devotion_event_id, 10) || null;
    if (!id) return null;
    const { rows: ex } = await query(`SELECT to_regclass('public.team_events') IS NOT NULL AS ok`);
    if (ex[0].ok) await query(`UPDATE team_events SET cancelled_at = NOW() WHERE id = $1 AND cancelled_at IS NULL`, [id]);
    await put('devotion_event_id', ''); sCache = null;
    return null;
  }


  // -------------------------------------------------------- activities --
  async function actsFor(day, ids) {
    await ready();
    const { rows } = await query(
      `SELECT a.id, a.user_id, u.name AS user_name, to_char(a.day, 'YYYY-MM-DD') AS day, a.title, a.category, a.planned_start, a.planned_end, a.status, a.actual_start, a.actual_end,
              a.notes, a.result, a.source, a.created_by, c.name AS created_by_name
         FROM dayplan_activities a JOIN users u ON u.id = a.user_id LEFT JOIN users c ON c.id = a.created_by
        WHERE a.day = $1 ${ids ? 'AND a.user_id = ANY($2::int[])' : ''} ORDER BY a.planned_start NULLS LAST, a.id`, ids ? [day, ids] : [day]);
    return rows.map((a) => Object.assign(a, { id: Number(a.id), planned_start: iso(a.planned_start), planned_end: iso(a.planned_end), actual_start: iso(a.actual_start), actual_end: iso(a.actual_end) }));
  }
  function cleanAct(b, day) {
    const title = str(b.title, 140);
    if (!title) throw httpError(400, 'Say what the activity is');
    let ps = null, pe = null;
    if (b.start) { if (!TIME_RE.test(b.start)) throw httpError(400, 'Start time as HH:MM'); ps = at(day, b.start); }
    if (b.end) { if (!TIME_RE.test(b.end)) throw httpError(400, 'End time as HH:MM'); pe = at(day, b.end); }
    if (ps && !pe) pe = new Date(ps.getTime() + Math.max(5, Math.min(720, parseInt(b.minutes, 10) || 30)) * 60000);
    if (ps && pe && pe <= ps) throw httpError(400, 'It has to end after it starts');
    return { title, category: CATEGORIES[b.category] ? b.category : 'work', ps, pe, notes: str(b.notes, 500) };
  }
  async function canTouch(req, userId) {
    if (Number(userId) === Number(uid(req))) return true;
    return (await caps(req)).manage;
  }
  async function addAct(by, userId, day, a, source, extra) {
    const { rows } = await query(`INSERT INTO dayplan_activities (user_id, day, title, category, planned_start, planned_end, notes, source, template_id, ext_uid, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING RETURNING id`,
      [userId, day, a.title, a.category, a.ps, a.pe, a.notes, source, (extra && extra.template_id) || null, (extra && extra.ext_uid) || null, by]);
    if (rows.length && emit) emit([userId], 'dayplan', { day });
    return rows.length ? Number(rows[0].id) : null;
  }

  // The day's schedule from the templates, for everyone rostered. Safe to run again.
  async function makeSchedule(day, by) {
    await ready();
    const staff = await staffList();
    const plan = await planFor(staff.map((s) => s.id), day);
    const working = staff.filter((s) => plan[s.id] && plan[s.id].kind === 'shift');
    const { rows: tpl } = await query(`SELECT id, title, category, to_char(start_time, 'HH24:MI') AS st, minutes, weekdays, user_id, department_id, job_title, everyone, notes FROM dayplan_templates WHERE active`);
    let made = 0;
    for (const t of tpl) {
      if (!(t.weekdays || []).map(Number).includes(weekday(day))) continue;
      const who = working.filter((s) => (t.user_id && s.id === t.user_id) || (t.department_id && s.department_id === t.department_id) || (t.job_title && s.job_title && t.job_title.toLowerCase() === s.job_title.toLowerCase()) || t.everyone);
      for (const s of who) {
        const ps = at(day, t.st);
        const id = await addAct(by, s.id, day, { title: t.title, category: t.category, ps, pe: new Date(ps.getTime() + t.minutes * 60000), notes: t.notes }, 'template', { template_id: t.id });
        if (id) made++;
      }
    }
    return { made, working: working.length };
  }

  // ------------------------------------------------------ opening hours --
  async function hoursFor(day) {
    const s = await settings();
    const v = String(s['hours_' + weekday(day)] || 'closed');
    const { rows: hol } = await query(`SELECT name FROM public_holidays WHERE day = $1`, [day]).catch(() => ({ rows: [] }));
    const m = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/.exec(v);
    if (hol.length) return { open: false, label: 'Closed: ' + hol[0].name, holiday: hol[0].name };
    if (!m) return { open: false, label: 'Closed' };
    const o = m[1] + ':' + m[2], c = m[3] + ':' + m[4];
    return { open: true, opens: o, closes: c, opens_at: iso(at(day, o)), closes_at: iso(at(day, c)), label: 'Open ' + o + '–' + c };
  }
  // What a person does in open time when nothing else is planned, from their job title / department.
  const FILL = [[/cash|sale|counter|rep|customer|front/i, 'sales', 'Serve customers at the counter'], [/driv|deliver|courier|dispatch/i, 'delivery', 'Deliveries and runs'],
    [/stock|inventory|warehouse|store ?room|pick|clerk|parts/i, 'stock', 'Stock, picking and putaway'], [/mechanic|technician|workshop|service/i, 'work', 'Workshop jobs'],
    [/manag|owner|supervis/i, 'admin', 'Supervise the floor and office work'], [/account|admin|office|clerical|hr|payroll/i, 'admin', 'Office work']];
  function fillerFor(p) {
    const text = [p.job_title, p.department].filter(Boolean).join(' ');
    for (const [re, cat, title] of FILL) if (re.test(text)) return { category: cat, title };
    return { category: 'work', title: (p.job_title ? p.job_title + ' work' : 'General work') };
  }
  // Fill everyone's day: every free stretch of their shift gets something, so the calendar covers the
  // opening hours. Before opening: get ready to open; after closing: close up; lunch in the middle;
  // the rest: their usual work. Planned "fill" items are made again each time; nothing else is touched.
  async function fillDay(day, by, onlyIds) {
    await ready();
    const s = await settings();
    const hrs = await hoursFor(day);
    const staff = (await staffList()).filter((x) => !onlyIds || onlyIds.includes(x.id));
    const plan = await planFor(staff.map((x) => x.id), day);
    const working = staff.filter((x) => plan[x.id] && plan[x.id].kind === 'shift');
    if (!working.length) return { filled: 0, people: 0, hours: hrs };
    const dev = await devotionFor(day);
    const acts = await actsFor(day, working.map((x) => x.id));
    const Q = 15 * 60000, MIN = 15 * 60000;
    const round = (t) => Math.round(t / Q) * Q;
    let made = 0;
    for (const p of working) {
      const pl = plan[p.id];
      let st = at(day, pl.start).getTime(), en = at(day, pl.end).getTime(); if (en <= st) en += 86400000;
      await query(`DELETE FROM dayplan_activities WHERE day = $1 AND user_id = $2 AND source = 'fill' AND status = 'planned'`, [day, p.id]);
      const busy = acts.filter((a) => a.user_id === p.id && a.source !== 'fill' && a.planned_start && a.planned_end && a.status !== 'skipped')
        .map((a) => [new Date(a.planned_start).getTime(), new Date(a.planned_end).getTime(), a.category]);
      // fill items left in place because they were started keep their time
      acts.filter((a) => a.user_id === p.id && a.source === 'fill' && a.status !== 'planned' && a.planned_start).forEach((a) => busy.push([new Date(a.planned_start).getTime(), new Date(a.planned_end).getTime(), a.category]));
      if (dev.mode !== 'off') busy.push([new Date(dev.starts_at).getTime(), new Date(dev.ends_at).getTime(), 'devotion']);
      const free = (a, b) => !busy.some(([x, y]) => a < y && b > x);
      const add = async (a, b, title, category) => {
        const id = await addAct(by, p.id, day, { title, category, ps: new Date(a), pe: new Date(b), notes: null }, 'fill');
        if (id) { made++; busy.push([a, b, category]); }
      };
      // lunch in the middle of the shift, in the first free stretch closest to the middle
      if (s.fill_lunch === 'on' && (pl.break || 0) >= 15 && !busy.some((x) => x[2] === 'break')) {
        const len = pl.break * 60000, mid = round(st + (en - st) / 2 - len / 2);
        for (let k = 0; k <= 16; k++) {
          const a = mid + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * Q;
          if (a >= st + 2 * 3600000 && a + len <= en - 3600000 && free(a, a + len)) { await add(a, a + len, 'Lunch', 'break'); break; }
        }
      }
      // the free stretches, cut at opening and closing time
      const cuts = [st, en];
      if (hrs.open) { const o = at(day, hrs.opens).getTime(), c = at(day, hrs.closes).getTime(); if (o > st && o < en) cuts.push(o); if (c > st && c < en) cuts.push(c); }
      busy.forEach(([x, y]) => { if (x > st && x < en) cuts.push(x); if (y > st && y < en) cuts.push(y); });
      const pts = [...new Set(cuts)].sort((a, b) => a - b);
      const f = fillerFor(p);
      let runA = null, runB = null, runKind = null;
      const flush = async () => { if (runA != null && runB - runA >= MIN) {
        if (runKind === 'before') await add(runA, runB, 'Get ready to open', 'cleaning');
        else if (runKind === 'after') await add(runA, runB, 'Close up: tidy, cash up, lock up', 'cleaning');
        else if (runKind === 'closed') await add(runA, runB, f.title + ' (shop closed)', f.category);
        else await add(runA, runB, f.title, f.category);
      } runA = null; };
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        if (!free(a, b)) { await flush(); continue; }
        const kind = !hrs.open ? 'closed' : b <= at(day, hrs.opens).getTime() ? 'before' : a >= at(day, hrs.closes).getTime() ? 'after' : 'open';
        if (runA != null && runKind === kind && runB === a) runB = b; else { await flush(); runA = a; runB = b; runKind = kind; }
      }
      await flush();
    }
    return { filled: made, people: working.length, hours: hrs };
  }
  // Open hours with nobody rostered, per department and overall.
  function coverage(day, hrs, people) {
    if (!hrs.open) return [];
    const o = at(day, hrs.opens).getTime(), c = at(day, hrs.closes).getTime();
    const gaps = [];
    const scan = (list, label) => {
      let gapA = null;
      for (let t = o; t <= c; t += 15 * 60000) {
        const on = t < c && list.some((p) => { if (p.plan.kind !== 'shift') return false; const a = at(day, p.plan.start).getTime(); let b = at(day, p.plan.end).getTime(); if (b <= a) b += 86400000; return t >= a && t < b; });
        if (!on && t < c) { if (gapA == null) gapA = t; } else if (gapA != null) { gaps.push({ who: label, from: hhmm(gapA), to: hhmm(t) }); gapA = null; }
      }
    };
    scan(people, 'Nobody');
    const depts = [...new Set(people.filter((p) => p.plan.kind === 'shift').map((p) => p.department))];
    for (const d of depts) scan(people.filter((p) => p.department === d), d);
    return gaps;
  }

  // ------------------------------------------------- the day, all of it --
  async function dayView(day, ids) {
    const staffAll = await staffList();
    const staff = ids ? staffAll.filter((s) => ids.includes(s.id)) : staffAll;
    const sid = staff.map((s) => s.id);
    const s = await settings();
    const late = parseInt((await query(`SELECT value FROM warehouse_settings WHERE key = 'clock_late_minutes'`)).rows.map((r) => r.value)[0], 10) || 5;
    const [plan, acts, dev, att, brk, sales, joined] = await Promise.all([
      planFor(sid, day), actsFor(day, sid), devotionFor(day),
      query(`SELECT id, user_id, clock_in_at, clock_out_at, mode FROM attendance WHERE work_day = $1 AND user_id = ANY($2::int[]) ORDER BY clock_in_at`, [day, sid]),
      query(`SELECT b.attendance_id, b.kind, b.start_at, b.end_at, a.user_id FROM attendance_breaks b JOIN attendance a ON a.id = b.attendance_id WHERE a.work_day = $1 AND a.user_id = ANY($2::int[])`, [day, sid]),
      query(`SELECT cashier_id AS user_id, COUNT(*)::int AS n, COALESCE(SUM(total_usd - COALESCE(tax_usd, 0)), 0)::float AS value,
                    json_agg(EXTRACT(HOUR FROM created_at AT TIME ZONE 'America/Jamaica')::int) AS hours
               FROM pos_sales WHERE NOT COALESCE(voided, false) AND COALESCE(receipt_number, '') NOT LIKE 'CN%'
                AND created_at >= ($1::date)::timestamp AT TIME ZONE 'America/Jamaica' AND created_at < ($1::date + 1)::timestamp AT TIME ZONE 'America/Jamaica'
                AND cashier_id = ANY($2::int[]) GROUP BY cashier_id`, [day, sid]).catch(() => ({ rows: [] })),
      query(`SELECT user_id, how, at FROM dayplan_devotion_attendance WHERE day = $1`, [day]),
    ]);
    const now = Date.now();
    const people = staff.map((p) => {
      const pl = plan[p.id] || { kind: 'none' };
      const mine = acts.filter((a) => a.user_id === p.id);
      const a = att.rows.filter((x) => x.user_id === p.id);
      const b = brk.rows.filter((x) => x.user_id === p.id);
      const sl = sales.rows.find((x) => x.user_id === p.id);
      const dj = joined.rows.find((x) => x.user_id === p.id);
      // what happened, as timeline marks
      const track = [];
      a.forEach((x) => { track.push({ kind: 'clock_in', at: iso(x.clock_in_at), label: 'Clocked in' + (x.mode === 'remote' ? ' (remote)' : '') }); if (x.clock_out_at) track.push({ kind: 'clock_out', at: iso(x.clock_out_at), label: 'Clocked out' }); });
      b.forEach((x) => track.push({ kind: 'break', at: iso(x.start_at), end: iso(x.end_at), label: x.kind === 'lunch' ? 'Lunch' : 'Break' }));
      if (dj) track.push({ kind: 'devotion', at: iso(dj.at), label: 'Signed in to devotion' });
      mine.forEach((x) => { if (x.actual_start) track.push({ kind: 'activity', at: x.actual_start, end: x.actual_end, label: x.title, status: x.status }); });
      track.sort((x, y) => (x.at < y.at ? -1 : 1));
      const perf = performance(day, pl, mine.filter((x) => x.source !== 'fill'), a, b, sl, dj, dev, late, now);
      return { user_id: p.id, name: p.name, department: p.department || 'No department', plan: pl, activities: mine, track,
        clocked_in: a.length ? iso(a[0].clock_in_at) : null, at_work: a.some((x) => !x.clock_out_at), sales: sl ? { count: sl.n, value: Math.round(sl.value * 100) / 100, hours: sl.hours } : { count: 0, value: 0, hours: [] },
        devotion: dj ? { at: iso(dj.at), how: dj.how } : null, performance: perf };
    });
    const hrs = await hoursFor(day);
    return { day, today: jmDay(), now: new Date(now).toISOString(), devotion: dev, hours: hrs, coverage: ids ? [] : coverage(day, hrs, people), settings: { devotion_mode: s.devotion_mode, missing_grace: Number(s.missing_grace) }, people };
  }

  // Work done compared with the plan, for one person and one day.
  function performance(day, pl, acts, att, brk, sales, joined, dev, late, now) {
    const endOfDay = Math.min(now, at(addDays(day, 1), '00:00').getTime());
    // Due: should be finished by now (or by the end of a past day), plus anything already started or done.
    const due = acts.filter((a) => a.status === 'done' || a.status === 'in_progress' || (a.planned_end ? new Date(a.planned_end).getTime() <= endOfDay : day < jmDay(now)));
    const done = acts.filter((a) => a.status === 'done');
    const plannedMin = acts.reduce((t, a) => t + (a.planned_start && a.planned_end ? (new Date(a.planned_end) - new Date(a.planned_start)) / 60000 : 0), 0);
    const actualMin = acts.reduce((t, a) => t + (a.actual_start ? Math.max(0, ((a.actual_end ? new Date(a.actual_end) : new Date(Math.min(now, endOfDay))) - new Date(a.actual_start)) / 60000) : 0), 0);
    const withStart = done.concat(acts.filter((a) => a.status === 'in_progress')).filter((a) => a.planned_start && a.actual_start);
    const onTime = withStart.filter((a) => new Date(a.actual_start) - new Date(a.planned_start) <= 10 * 60000).length;
    let rosteredMin = 0, workedMin = 0, lateMin = 0;
    if (pl.kind === 'shift') {
      const st = at(day, pl.start).getTime(); let en = at(day, pl.end).getTime(); if (en <= st) en += 86400000;
      rosteredMin = Math.max(0, (Math.min(en, Math.max(st, now)) - st) / 60000 - ((now >= en) ? (pl.break || 0) : 0));
      if (att.length) { const l = (new Date(att[0].clock_in_at).getTime() - st) / 60000; if (l > late) lateMin = Math.round(l); }
    }
    for (const a of att) workedMin += ((a.clock_out_at ? new Date(a.clock_out_at).getTime() : now) - new Date(a.clock_in_at).getTime()) / 60000;
    for (const b of brk) workedMin -= ((b.end_at ? new Date(b.end_at).getTime() : now) - new Date(b.start_at).getTime()) / 60000;
    workedMin = Math.max(0, workedMin);
    const devDue = dev && dev.mode !== 'off' && pl.kind === 'shift' && new Date(dev.starts_at).getTime() <= now;
    // Score: activities done 50, on time 15, hours 25, devotion 10. Parts that do not apply are left out.
    const parts = [];
    if (due.length) parts.push([50, Math.min(1, done.filter((a) => due.includes(a)).length / due.length)]);
    if (withStart.length) parts.push([15, onTime / withStart.length]);
    if (rosteredMin > 0) parts.push([25, Math.min(1, workedMin / rosteredMin) * (lateMin ? Math.max(0.5, 1 - lateMin / 120) : 1)]);
    if (devDue) parts.push([10, joined ? 1 : 0]);
    const w = parts.reduce((t, p) => t + p[0], 0);
    const score = w ? Math.round(parts.reduce((t, p) => t + p[0] * p[1], 0) / w * 100) : null;
    return { planned: acts.length, due: due.length, done: done.length, in_progress: acts.filter((a) => a.status === 'in_progress').length, skipped: acts.filter((a) => a.status === 'skipped').length,
      completion: due.length ? Math.round(done.filter((a) => due.includes(a)).length / due.length * 100) : null,
      planned_min: Math.round(plannedMin), actual_min: Math.round(actualMin), on_time: onTime, timed: withStart.length,
      rostered_min: Math.round(rosteredMin), worked_min: Math.round(workedMin), late_min: lateMin, devotion: devDue ? !!joined : null,
      sales_count: sales ? sales.n : 0, sales_value: sales ? Math.round(sales.value * 100) / 100 : 0, score };
  }

  // ---------------------------------------------------------- endpoints --
  app.get('/api/dayplan/config', requireAdmin, async (req, res) => {
    try {
      await ready();
      const c = await caps(req), s = await settings();
      const staff = c.all || c.manage ? (await staffList()).map((x) => ({ id: x.id, name: x.name, department: x.department, department_id: x.department_id })) : [];
      const { rows: me } = await query(`SELECT id, name FROM users WHERE id = $1`, [uid(req)]);
      res.json({ me: me[0] || { id: uid(req) }, can_manage: c.manage, can_see_all: c.all, categories: CATEGORIES, today: jmDay(), staff,
        settings: c.manage ? s : { devotion_mode: s.devotion_mode, devotion_time: s.devotion_time } });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/dayplan/day', requireAdmin, async (req, res) => {
    try {
      await ready();
      const day = DAY_RE.test(req.query.day || '') ? req.query.day : jmDay();
      const c = await caps(req);
      const only = c.all && req.query.mine !== '1' ? null : [uid(req)];
      res.json(await dayView(day, only));
    } catch (e) { fail(res, e); }
  });

  app.post('/api/dayplan/activities', requireAdmin, async (req, res) => {
    try {
      await ready();
      const b = req.body || {};
      const day = DAY_RE.test(b.day || '') ? b.day : jmDay();
      const ids = [...new Set((Array.isArray(b.user_ids) && b.user_ids.length ? b.user_ids : [b.user_id || uid(req)]).map(Number).filter(Boolean))];
      for (const u of ids) if (!(await canTouch(req, u))) throw httpError(403, 'You can only add activities to your own day');
      const a = cleanAct(b, day);
      const made = [];
      for (const u of ids) {
        const id = await addAct(uid(req), u, day, a, b.source === 'voice' ? 'voice' : 'manual');
        made.push(id);
        if (u !== uid(req) && notice) notice([u], { kind: 'dayplan', title: '🗓 New on your day: ' + a.title, body: (a.ps ? hhmm(a.ps) + ' · ' : '') + (day === jmDay() ? 'today' : day), link: '/day.html#me' }).catch(() => {});
      }
      res.json({ ok: true, ids: made });
    } catch (e) { fail(res, e); }
  });
  async function oneAct(req, id) {
    await ready();
    const { rows } = await query(`SELECT *, to_char(day, 'YYYY-MM-DD') AS d FROM dayplan_activities WHERE id = $1`, [id]);
    if (!rows.length) throw httpError(404, 'Activity not found');
    if (!(await canTouch(req, rows[0].user_id))) throw httpError(403, 'That is not on your day');
    return rows[0];
  }
  app.put('/api/dayplan/activities/:id', requireAdmin, async (req, res) => {
    try {
      const old = await oneAct(req, parseInt(req.params.id, 10));
      const a = cleanAct(Object.assign({ title: old.title, category: old.category }, req.body || {}), old.d);
      await query(`UPDATE dayplan_activities SET title=$2, category=$3, planned_start=$4, planned_end=$5, notes=$6, updated_at=NOW() WHERE id=$1`, [old.id, a.title, a.category, a.ps, a.pe, a.notes]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  // start | done | skip | reopen
  async function setStatus(id, action, result) {
    const map = {
      start: `status = 'in_progress', actual_start = COALESCE(actual_start, NOW()), actual_end = NULL`,
      done: `status = 'done', actual_start = COALESCE(actual_start, planned_start, NOW()), actual_end = NOW()`,
      skip: `status = 'skipped', actual_end = NULL`,
      reopen: `status = 'planned', actual_start = NULL, actual_end = NULL`,
    };
    if (!map[action]) throw httpError(400, 'Start, done, skip or reopen');
    await query(`UPDATE dayplan_activities SET ${map[action]}, result = COALESCE($2, result), updated_at = NOW() WHERE id = $1`, [id, result]);
  }
  app.post('/api/dayplan/activities/:id/:action(start|done|skip|reopen)', requireAdmin, async (req, res) => {
    try {
      const a = await oneAct(req, parseInt(req.params.id, 10));
      await setStatus(a.id, req.params.action, str((req.body || {}).result, 300));
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.delete('/api/dayplan/activities/:id', requireAdmin, async (req, res) => {
    try { const a = await oneAct(req, parseInt(req.params.id, 10)); await query(`DELETE FROM dayplan_activities WHERE id = $1`, [a.id]); res.json({ ok: true }); } catch (e) { fail(res, e); }
  });

  // Create the day's schedule from the templates (managers).
  app.post('/api/dayplan/schedule', ...canManage, async (req, res) => {
    try {
      const day = DAY_RE.test((req.body || {}).day || '') ? req.body.day : jmDay();
      res.json(Object.assign({ ok: true, day }, await makeSchedule(day, uid(req))));
    } catch (e) { fail(res, e); }
  });

  app.post('/api/dayplan/fill', ...canManage, async (req, res) => {
    try {
      const b = req.body || {};
      const day = DAY_RE.test(b.day || '') ? b.day : jmDay();
      const ids = Array.isArray(b.user_ids) && b.user_ids.length ? b.user_ids.map(Number).filter(Boolean) : null;
      const made = await makeSchedule(day, uid(req));
      res.json({ ok: true, day, from_templates: made.made, ...(await fillDay(day, uid(req), ids)) });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/dayplan/hours', requireAdmin, async (req, res) => {
    try { await ready(); const day = DAY_RE.test(req.query.day || '') ? req.query.day : jmDay(); res.json(await hoursFor(day)); } catch (e) { fail(res, e); }
  });

  app.get('/api/dayplan/templates', ...canManage, async (req, res) => {
    try {
      await ready();
      const { rows } = await query(`SELECT t.id, t.title, t.category, to_char(t.start_time, 'HH24:MI') AS start, t.minutes, t.weekdays, t.user_id, u.name AS user_name, t.department_id, d.name AS department, t.job_title, t.everyone, t.notes, t.active, t.is_duty
        FROM dayplan_templates t LEFT JOIN users u ON u.id = t.user_id LEFT JOIN departments d ON d.id = t.department_id ORDER BY t.start_time, t.title`);
      const { rows: depts } = await query(`SELECT id, name FROM departments ORDER BY name`).catch(() => ({ rows: [] }));
      const { rows: jt } = await query(`SELECT DISTINCT job_title FROM hr_employees WHERE job_title IS NOT NULL AND job_title <> '' ORDER BY 1`).catch(() => ({ rows: [] }));
      res.json({ templates: rows, departments: depts, job_titles: jt.map((x) => x.job_title) });
    } catch (e) { fail(res, e); }
  });
  function cleanTpl(b) {
    const title = str(b.title, 140);
    if (!title) throw httpError(400, 'Name the activity');
    if (!TIME_RE.test(b.start || '')) throw httpError(400, 'Start time as HH:MM');
    const wd = (Array.isArray(b.weekdays) ? b.weekdays : []).map(Number).filter((x) => x >= 0 && x <= 6);
    if (!wd.length) throw httpError(400, 'Pick the days it happens');
    const who = b.who === 'everyone' ? 'everyone' : b.who === 'department' ? 'department' : b.who === 'job_title' ? 'job_title' : 'person';
    const t = { title, category: CATEGORIES[b.category] ? b.category : 'work', start: b.start, minutes: Math.max(5, Math.min(720, parseInt(b.minutes, 10) || 30)), weekdays: [...new Set(wd)],
      user_id: who === 'person' ? parseInt(b.user_id, 10) || null : null, department_id: who === 'department' ? parseInt(b.department_id, 10) || null : null, job_title: who === 'job_title' ? str(b.job_title, 120) : null, everyone: who === 'everyone', notes: str(b.notes, 500), active: b.active !== false };
    if (who === 'person' && !t.user_id) throw httpError(400, 'Pick who does it');
    if (who === 'department' && !t.department_id) throw httpError(400, 'Pick the department');
    if (who === 'job_title' && !t.job_title) throw httpError(400, 'Pick the job title');
    return t;
  }
  app.post('/api/dayplan/templates', ...canManage, async (req, res) => {
    try {
      await ready();
      const t = cleanTpl(req.body || {});
      const { rows } = await query(`INSERT INTO dayplan_templates (title, category, start_time, minutes, weekdays, user_id, department_id, everyone, notes, active, created_by, job_title) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [t.title, t.category, t.start, t.minutes, t.weekdays, t.user_id, t.department_id, t.everyone, t.notes, t.active, uid(req), t.job_title]);
      res.json({ ok: true, id: rows[0].id });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/dayplan/templates/:id', ...canManage, async (req, res) => {
    try {
      await ready();
      const t = cleanTpl(req.body || {});
      await query(`UPDATE dayplan_templates SET title=$2, category=$3, start_time=$4, minutes=$5, weekdays=$6, user_id=$7, department_id=$8, everyone=$9, notes=$10, active=$11, job_title=$12 WHERE id=$1`,
        [parseInt(req.params.id, 10), t.title, t.category, t.start, t.minutes, t.weekdays, t.user_id, t.department_id, t.everyone, t.notes, t.active, t.job_title]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.delete('/api/dayplan/templates/:id', ...canManage, async (req, res) => {
    try { await ready(); await query(`DELETE FROM dayplan_templates WHERE id = $1`, [parseInt(req.params.id, 10)]); res.json({ ok: true }); } catch (e) { fail(res, e); }
  });

  // ----------------------------------------------------- devotion routes --
  app.get('/api/dayplan/devotion', requireAdmin, async (req, res) => {
    try {
      const day = DAY_RE.test(req.query.day || '') ? req.query.day : jmDay();
      const d = await devotionFor(day);
      await ready();
      const c = await caps(req);
      const { rows } = await query(`SELECT a.user_id, u.name, a.how, a.at, a.note, mb.name AS marked_by_name FROM dayplan_devotion_attendance a JOIN users u ON u.id = a.user_id LEFT JOIN users mb ON mb.id = a.marked_by WHERE a.day = $1 ORDER BY a.at`, [day]);
      const endAt = d.ends_at ? new Date(d.ends_at).getTime() : null;
      d.joined = rows.map((r) => ({ user_id: r.user_id, name: r.name, how: r.how, at: iso(r.at), note: r.note, marked_by: r.marked_by_name || null, late: !!(endAt && r.how === 'joined' && new Date(r.at).getTime() > endAt) }));
      d.i_joined = rows.some((r) => r.user_id === uid(req));
      d.can_edit = c.manage || (d.leader_user_id && d.leader_user_id === uid(req));
      d.can_mark = c.manage || (d.leader_user_id && d.leader_user_id === uid(req));
      // the sign-in sheet: everyone on the roster that day, signed in or not
      if (c.all || d.can_mark) {
        const staff = await staffList();
        const plan = await planFor(staff.map((x) => x.id), day);
        const anyOn = staff.some((x) => plan[x.id] && plan[x.id].kind === 'shift');
        d.sheet = staff.filter((x) => !anyOn || (plan[x.id] && plan[x.id].kind === 'shift') || rows.some((r) => r.user_id === x.id)).map((x) => {
          const j = d.joined.find((r) => r.user_id === x.id);
          const pl = plan[x.id] || {};
          return { user_id: x.id, name: x.name, department: x.department || null, shift: pl.kind === 'shift' ? pl.start + '–' + pl.end : (pl.label || null), signed_in: j ? j.at : null, how: j ? j.how : null, late: j ? j.late : false, note: j ? j.note : null };
        });
      }
      const { rows: cm } = await query(`SELECT c.id, c.user_id, u.name, c.kind, c.body, c.created_at FROM dayplan_devotion_comments c JOIN users u ON u.id = c.user_id WHERE c.day = $1 AND c.removed_at IS NULL ORDER BY c.created_at`, [day]);
      d.comments = cm.map((x) => ({ id: Number(x.id), user_id: x.user_id, name: x.name, kind: x.kind, body: x.body, at: iso(x.created_at), can_remove: x.user_id === uid(req) || !!d.can_mark }));
      d.me = uid(req);
      res.json(d);
    } catch (e) { fail(res, e); }
  });
  // A day's devotion: mode, time, leader and words (managers, or that day's leader for the words).
  app.put('/api/dayplan/devotion/:day', requireAdmin, async (req, res) => {
    try {
      await ready();
      const day = String(req.params.day);
      if (!DAY_RE.test(day)) throw httpError(400, 'Which day');
      const b = req.body || {};
      const cur = await devotionFor(day);
      const mgr = (await caps(req)).manage;
      if (!mgr && !(cur.leader_user_id && cur.leader_user_id === uid(req))) throw httpError(403, 'Only a manager or the day\'s leader can change the devotion');
      const mode = mgr ? (['system', 'manual', 'off'].includes(b.mode) ? b.mode : cur.mode) : cur.mode;
      const start = mgr && TIME_RE.test(b.start || '') ? b.start : cur.start;
      const minutes = mgr ? Math.max(5, Math.min(120, parseInt(b.minutes, 10) || cur.minutes)) : cur.minutes;
      const leader = mgr ? (b.leader_user_id === '' || b.leader_user_id == null ? null : parseInt(b.leader_user_id, 10) || null) : cur.leader_user_id;
      await query(`INSERT INTO dayplan_devotions (day, mode, start_time, minutes, title, scripture_ref, scripture_text, reflection, prayer, leader_user_id, location, updated_by, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
        ON CONFLICT (day) DO UPDATE SET mode=EXCLUDED.mode, start_time=EXCLUDED.start_time, minutes=EXCLUDED.minutes, title=EXCLUDED.title, scripture_ref=EXCLUDED.scripture_ref, scripture_text=EXCLUDED.scripture_text,
          reflection=EXCLUDED.reflection, prayer=EXCLUDED.prayer, leader_user_id=EXCLUDED.leader_user_id, location=EXCLUDED.location, updated_by=EXCLUDED.updated_by, updated_at=NOW()`,
        [day, mode, start, minutes, str(b.title, 140), str(b.scripture_ref, 80), str(b.scripture_text, 2000), str(b.reflection, 3000), str(b.prayer, 1500), leader, str(b.location, 120) || cur.location, uid(req)]);
      if (mgr && leader && leader !== cur.leader_user_id && notice) notice([leader], { kind: 'dayplan', title: '🙏 You are leading devotion on ' + day + ' at ' + start, body: 'Open the Day plan to add the scripture and words.', link: '/day.html#devotion=' + day }).catch(() => {});
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.delete('/api/dayplan/devotion/:day', ...canManage, async (req, res) => {
    try { await ready(); await query(`DELETE FROM dayplan_devotions WHERE day = $1`, [String(req.params.day)]); res.json({ ok: true }); } catch (e) { fail(res, e); }
  });
  app.post('/api/dayplan/devotion/join', requireAdmin, async (req, res) => {
    try {
      await ready();
      const b = req.body || {};
      const day = DAY_RE.test(b.day || '') ? b.day : jmDay();
      let who = uid(req), how = 'joined';
      const dev = await devotionFor(day);
      if (dev.mode === 'off') throw httpError(400, 'There is no devotion on ' + day);
      if (b.user_id && Number(b.user_id) !== uid(req)) {
        // a manager, or that day's leader, signs people in from the sheet
        if (!((await caps(req)).manage || (dev.leader_user_id && dev.leader_user_id === uid(req)))) throw httpError(403, 'Only a manager or the leader can sign others in');
        who = Number(b.user_id); how = 'marked';
      } else if (!b.remove) {
        // you sign yourself in on the day, from shortly before it starts
        if (day !== jmDay()) throw httpError(400, 'You can only sign in on the day');
        if (Date.now() < new Date(dev.starts_at).getTime() - 30 * 60000) throw httpError(400, 'Sign-in opens 30 minutes before the devotion (' + hhmm(dev.starts_at) + ')');
      }
      const note = str(b.note, 500);
      if (b.remove) await query(`DELETE FROM dayplan_devotion_attendance WHERE day = $1 AND user_id = $2`, [day, who]);
      else await query(`INSERT INTO dayplan_devotion_attendance (day, user_id, how, note, marked_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (day, user_id) DO UPDATE SET note = COALESCE(EXCLUDED.note, dayplan_devotion_attendance.note)`,
        [day, who, how, note, how === 'marked' ? uid(req) : null]);
      if (emit) emit([who], 'dayplan', { day });
      res.json({ ok: true, late: !b.remove && how === 'joined' && Date.now() > new Date(dev.ends_at).getTime() });
    } catch (e) { fail(res, e); }
  });
  // Comments on the day's devotion: a comment, a prayer request or a praise report. Everyone at work sees them.
  app.post('/api/dayplan/devotion/comments', requireAdmin, async (req, res) => {
    try {
      await ready();
      const b = req.body || {};
      const day = DAY_RE.test(b.day || '') ? b.day : jmDay();
      if (day > jmDay()) throw httpError(400, 'You can comment on today\'s devotion or an earlier one');
      const body = str(b.body, 1000);
      if (!body) throw httpError(400, 'Write something first');
      const kind = ['comment', 'prayer', 'praise'].includes(b.kind) ? b.kind : 'comment';
      const recent = await query(`SELECT COUNT(*)::int AS n FROM dayplan_devotion_comments WHERE user_id = $1 AND created_at > NOW() - interval '1 minute'`, [uid(req)]);
      if (recent.rows[0].n >= 5) throw httpError(429, 'Slow down a little, then try again');
      const { rows } = await query(`INSERT INTO dayplan_devotion_comments (day, user_id, kind, body) VALUES ($1,$2,$3,$4) RETURNING id`, [day, uid(req), kind, body]);
      const dev = await devotionFor(day);
      if (notice && dev.leader_user_id && dev.leader_user_id !== uid(req)) {
        const { rows: me } = await query(`SELECT name FROM users WHERE id = $1`, [uid(req)]);
        notice([dev.leader_user_id], { kind: 'devotion', title: '🙏 ' + ((me[0] && me[0].name) || 'Someone') + (kind === 'prayer' ? ' asked for prayer' : kind === 'praise' ? ' shared a praise report' : ' commented on the devotion'), body: body.slice(0, 140), link: '/day.html#devotion' }).catch(() => {});
      }
      res.json({ ok: true, id: Number(rows[0].id) });
    } catch (e) { fail(res, e); }
  });
  app.delete('/api/dayplan/devotion/comments/:id', requireAdmin, async (req, res) => {
    try {
      await ready();
      const { rows } = await query(`SELECT id, user_id, to_char(day, 'YYYY-MM-DD') AS day FROM dayplan_devotion_comments WHERE id = $1 AND removed_at IS NULL`, [parseInt(req.params.id, 10)]);
      if (!rows.length) throw httpError(404, 'Comment not found');
      if (rows[0].user_id !== uid(req)) {
        const dev = await devotionFor(rows[0].day);
        if (!((await caps(req)).manage || (dev.leader_user_id && dev.leader_user_id === uid(req)))) throw httpError(403, 'You can only remove your own comment');
      }
      await query(`UPDATE dayplan_devotion_comments SET removed_at = NOW(), removed_by = $2 WHERE id = $1`, [rows[0].id, uid(req)]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  app.put('/api/dayplan/settings', ...canManage, async (req, res) => {
    try {
      await ready();
      const b = req.body || {};
      if (b.devotion_mode != null) { if (!['system', 'manual', 'off'].includes(b.devotion_mode)) throw httpError(400, 'Devotion: system, manual or off'); await put('devotion_mode', b.devotion_mode); }
      if (b.devotion_time != null) { if (!TIME_RE.test(b.devotion_time)) throw httpError(400, 'Devotion time as HH:MM'); await put('devotion_time', b.devotion_time); }
      const num = async (k, lo, hi) => { if (b[k] == null) return; const x = parseInt(b[k], 10); if (!(x >= lo && x <= hi)) throw httpError(400, 'A number is out of range'); await put(k, x); };
      await num('devotion_minutes', 5, 120); await num('devotion_remind', 0, 120); await num('missing_grace', 1, 240); await num('activity_remind', 0, 120);
      if (Array.isArray(b.devotion_days)) await put('devotion_days', b.devotion_days.map(Number).filter((x) => x >= 0 && x <= 6).join(','));
      if (b.devotion_location != null) await put('devotion_location', String(b.devotion_location).slice(0, 120));
      if (b.missing_tell_managers != null) await put('missing_tell_managers', b.missing_tell_managers ? 'on' : 'off');
      if (b.auto_schedule != null) await put('auto_schedule', b.auto_schedule ? 'on' : 'off');
      if (b.fill_auto != null) await put('fill_auto', b.fill_auto ? 'on' : 'off');
      if (b.fill_lunch != null) await put('fill_lunch', b.fill_lunch ? 'on' : 'off');
      if (b.hours && typeof b.hours === 'object') {
        for (let w = 0; w <= 6; w++) {
          const h = b.hours[w] || b.hours[String(w)];
          if (h === undefined) continue;
          if (!h || h === 'closed' || h.closed) { await put('hours_' + w, 'closed'); continue; }
          if (!TIME_RE.test(h.opens || '') || !TIME_RE.test(h.closes || '')) throw httpError(400, 'Opening hours as HH:MM');
          if (h.closes <= h.opens) throw httpError(400, 'Closing time has to be after opening time (' + ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][w] + ')');
          await put('hours_' + w, h.opens + '-' + h.closes);
        }
      }
      sCache = null;
      await syncCalendarEvent().catch((e) => console.warn('[dayplan] calendar', e.message));
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // --------------------------------------------------------------- voice --
  // Spoken (or typed) commands, e.g.
  //   "add stock count at 2 pm for 1 hour"      "schedule clean the shop at 4:30 for Ben"
  //   "start stock count"   "done stock count"   "finished cleaning"   "skip delivery"
  //   "add call suppliers tomorrow at 9"
  function parseTime(s) {
    const m = /\b(\d{1,2})(?::|\.)?(\d{2})?\s*(a\.?m\.?|p\.?m\.?)?\b/i.exec(s);
    if (!m) return null;
    let h = parseInt(m[1], 10); const mi = m[2] ? parseInt(m[2], 10) : 0; const ap = (m[3] || '').toLowerCase().replace(/\./g, '');
    if (h > 23 || mi > 59) return null;
    if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0;
    if (!ap && h >= 1 && h <= 6) h += 12;                         // "at 3" during shop hours means 3 pm
    return String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0');
  }
  function words(s) { return String(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2); }
  function bestMatch(list, text) {
    const w = words(text); let best = null, sc = 0;
    for (const a of list) { const t = words(a.title); const s = w.filter((x) => t.some((y) => y.startsWith(x) || x.startsWith(y))).length / Math.max(1, Math.min(w.length, t.length)); if (s > sc) { sc = s; best = a; } }
    return sc >= 0.5 ? best : null;
  }
  async function voice(req, text, day) {
    const raw = String(text || '').trim();
    if (!raw) throw httpError(400, 'Nothing was heard');
    const s = raw.replace(/[.!?]+$/, '');
    const staff = await staffList();
    let m = /^(start|starting|begin|done|finished|finish|completed|complete|skip|skipping|cancel)\s+(?:with\s+|the\s+)?(.+)$/i.exec(s);
    if (m) {
      const verb = m[1].toLowerCase(), action = /^(start|starting|begin)$/.test(verb) ? 'start' : /^(skip|skipping|cancel)$/.test(verb) ? 'skip' : 'done';
      const mine = (await actsFor(day, [uid(req)])).filter((a) => a.status !== 'done');
      const a = bestMatch(mine, m[2]);
      if (!a) {
        if (action === 'skip') throw httpError(404, 'Could not find "' + m[2] + '" on your day');
        const id = await addAct(uid(req), uid(req), day, { title: m[2].replace(/^\w/, (c) => c.toUpperCase()).slice(0, 140), category: 'work', ps: null, pe: null, notes: null }, 'voice');
        await setStatus(id, action, null);
        return { did: action === 'start' ? 'started' : 'done', title: m[2], new: true, id };
      }
      await setStatus(a.id, action, null);
      return { did: action === 'start' ? 'started' : action === 'skip' ? 'skipped' : 'done', title: a.title, id: a.id };
    }
    m = /^(?:add|schedule|plan|put|book|remind me to)\s+(.+)$/i.exec(s);
    if (!m) throw httpError(400, 'Say "add … at 2 pm", "start …" or "done …"');
    let rest = ' ' + m[1] + ' ';
    let d = day;
    if (/\btomorrow\b/i.test(rest)) { d = addDays(day, 1); rest = rest.replace(/\btomorrow\b/i, ' '); }
    if (/\btoday\b/i.test(rest)) rest = rest.replace(/\btoday\b/i, ' ');
    let who = uid(req);
    const fm = /\bfor\s+([a-z][a-z' -]*?)(?=\s+(?:at|from|for|until|till|to)\b|\s*$)/i.exec(rest);
    if (fm && !/^\d|^(an?|one|two|three|half)\b/i.test(fm[1].trim())) {
      const nm = fm[1].trim().toLowerCase();
      const p = staff.find((x) => x.name.toLowerCase() === nm) || staff.find((x) => x.name.toLowerCase().split(' ')[0] === nm.split(' ')[0]);
      if (p) { if (!(await canTouch(req, p.id))) throw httpError(403, 'You can only add to your own day'); who = p.id; rest = rest.replace(fm[0], ' '); }
    }
    let minutes = null;
    const dm = /\bfor\s+(an?|one|two|three|half an?|\d+(?:\.\d+)?)\s*(hours?|hrs?|minutes?|mins?)\b/i.exec(rest);
    if (dm) {
      const nmap = { a: 1, an: 1, one: 1, two: 2, three: 3 };
      let q = /^half/i.test(dm[1]) ? 0.5 : nmap[dm[1].toLowerCase()] || parseFloat(dm[1]);
      minutes = Math.round(/^h/i.test(dm[2]) ? q * 60 : q);
      rest = rest.replace(dm[0], ' ');
    }
    let start = null, end = null;
    const um = /\b(?:until|till|to)\s+(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?)/i.exec(rest);
    if (um) { end = parseTime(um[1]); rest = rest.replace(um[0], ' '); }
    const am = /\b(?:at|from)\s+(\d{1,2}(?:[:.]\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?|noon)/i.exec(rest);
    if (am) { start = /noon/i.test(am[1]) ? '12:00' : parseTime(am[1]); rest = rest.replace(am[0], ' '); }
    const title = rest.replace(/\s+/g, ' ').trim().replace(/^(to|a|an|the)\s+/i, '');
    if (!title) throw httpError(400, 'Say what to add');
    const a = cleanAct({ title: title.replace(/^\w/, (c) => c.toUpperCase()), start, end, minutes: minutes || 30 }, d);
    const id = await addAct(uid(req), who, d, a, 'voice');
    if (who !== uid(req) && notice) notice([who], { kind: 'dayplan', title: '🗓 New on your day: ' + a.title, body: (a.ps ? hhmm(a.ps) + ' · ' : '') + d, link: '/day.html#me' }).catch(() => {});
    return { did: 'added', title: a.title, day: d, start: a.ps ? hhmm(a.ps) : null, end: a.pe ? hhmm(a.pe) : null, user_id: who, user_name: (staff.find((x) => x.id === who) || {}).name, id };
  }
  app.post('/api/dayplan/voice', requireAdmin, async (req, res) => {
    try {
      await ready();
      const b = req.body || {};
      res.json(Object.assign({ ok: true, heard: b.text }, await voice(req, b.text, DAY_RE.test(b.day || '') ? b.day : jmDay())));
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------- Google Calendar --
  // Google Calendar > Settings > (the calendar) > "Secret address in iCal
  // format", or an exported .ics file. Each event becomes an activity on the
  // person's day; importing again updates rather than duplicates.
  function unfold(text) { return String(text).replace(/\r\n/g, '\n').replace(/\n[ \t]/g, ''); }
  function icsVal(v) { return String(v || '').replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\'); }
  // A wall-clock time in a time zone, as a Date.
  function zoned(day, time, tzid) {
    const base = day + 'T' + time;
    if (!tzid || /Jamaica|Bogota|Panama|Cayman|^EST$|-05/i.test(tzid)) return new Date(base + OFFSET);
    const guess = new Date(base + 'Z');
    try {
      const f = new Intl.DateTimeFormat('en-US', { timeZone: tzid, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const p = Object.fromEntries(f.formatToParts(guess).map((x) => [x.type, x.value]));
      const asIf = new Date(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
      return new Date(guess.getTime() - (asIf - guess));
    } catch (_) { return new Date(base + OFFSET); }
  }
  function icsDate(prop, val) {
    const tzid = (/TZID=([^;:]+)/.exec(prop) || [])[1];
    let m = /^(\d{4})(\d{2})(\d{2})$/.exec(val);
    if (m || /VALUE=DATE(?!-)/.test(prop)) { m = m || /^(\d{4})(\d{2})(\d{2})/.exec(val); return { allDay: true, day: m[1] + '-' + m[2] + '-' + m[3] }; }
    m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(val);
    if (!m) return null;
    const day = m[1] + '-' + m[2] + '-' + m[3], time = m[4] + ':' + m[5] + ':' + m[6];
    if (m[7] === 'Z') return { allDay: false, at: new Date(day + 'T' + time + 'Z') };
    return { allDay: false, at: zoned(day, time, tzid), wall: time, tz: tzid || null };
  }
  function parseIcs(text) {
    const out = [];
    const lines = unfold(text).split('\n');
    let ev = null;
    for (const line of lines) {
      if (line === 'BEGIN:VEVENT') { ev = {}; continue; }
      if (line === 'END:VEVENT') { if (ev) out.push(ev); ev = null; continue; }
      if (!ev) continue;
      const i = line.indexOf(':'); if (i < 0) continue;
      const prop = line.slice(0, i), val = line.slice(i + 1), name = prop.split(';')[0].toUpperCase();
      if (name === 'UID') ev.uid = val;
      else if (name === 'SUMMARY') ev.summary = icsVal(val);
      else if (name === 'DESCRIPTION') ev.description = icsVal(val);
      else if (name === 'LOCATION') ev.location = icsVal(val);
      else if (name === 'DTSTART') ev.start = icsDate(prop, val);
      else if (name === 'DTEND') ev.end = icsDate(prop, val);
      else if (name === 'RRULE') ev.rrule = val;
      else if (name === 'STATUS') ev.status = val;
      else if (name === 'RECURRENCE-ID') ev.recurrence_id = val;
    }
    return out;
  }
  // Occurrences of an event within [from, to] (days). Simple RRULEs: DAILY / WEEKLY (BYDAY) / MONTHLY, INTERVAL, COUNT, UNTIL.
  function expand(ev, from, to) {
    if (!ev.start) return [];
    const first = ev.start.allDay ? ev.start.day : jmDay(ev.start.at);
    const dur = ev.end && !ev.end.allDay && !ev.start.allDay ? ev.end.at - ev.start.at : 0;
    // each repeat keeps the wall-clock time of its own zone (summer time and all)
    const make = (day) => ({ day, start: ev.start.allDay ? null : ev.start.wall ? zoned(day, ev.start.wall, ev.start.tz) : new Date(at(day, hhmm(ev.start.at)).getTime()), dur, allDay: ev.start.allDay });
    if (!ev.rrule) return first >= from && first <= to ? [make(first)] : [];
    const r = Object.fromEntries(ev.rrule.split(';').map((p) => p.split('=')));
    const interval = parseInt(r.INTERVAL, 10) || 1, count = parseInt(r.COUNT, 10) || 0;
    const until = r.UNTIL ? r.UNTIL.slice(0, 4) + '-' + r.UNTIL.slice(4, 6) + '-' + r.UNTIL.slice(6, 8) : null;
    const BY = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
    const byday = r.BYDAY ? r.BYDAY.split(',').map((x) => BY[x.slice(-2)]).filter((x) => x != null) : null;
    const out = []; let n = 0;
    for (let d = first, i = 0; i < 800 && d <= to; d = addDays(d, 1), i++) {
      if (until && d > until) break;
      const diff = Math.round((new Date(d + 'T12:00:00Z') - new Date(first + 'T12:00:00Z')) / 86400000);
      let hit = false;
      if (r.FREQ === 'DAILY') hit = diff % interval === 0;
      else if (r.FREQ === 'WEEKLY') hit = Math.floor(diff / 7) % interval === 0 && (byday ? byday.includes(weekday(d)) : weekday(d) === weekday(first));
      else if (r.FREQ === 'MONTHLY') hit = d.slice(8) === first.slice(8) && ((Number(d.slice(0, 4)) - Number(first.slice(0, 4))) * 12 + Number(d.slice(5, 7)) - Number(first.slice(5, 7))) % interval === 0;
      else if (r.FREQ === 'YEARLY') hit = d.slice(5) === first.slice(5);
      if (!hit) continue;
      n++;
      if (count && n > count) break;
      if (d >= from) out.push(make(d));
    }
    return out;
  }
  async function importIcs(by, userId, text, from, to) {
    const evs = parseIcs(text);
    if (!evs.length && !/BEGIN:VCALENDAR/.test(text)) throw httpError(400, 'That is not a calendar file (.ics)');
    let added = 0, updated = 0;
    for (const ev of evs) {
      if (!ev.start || ev.status === 'CANCELLED' || ev.recurrence_id) continue;
      for (const o of expand(ev, from, to)) {
        const ext = String(ev.uid || ev.summary || 'event').slice(0, 200);
        const title = (ev.summary || 'Calendar event').slice(0, 140);
        const ps = o.allDay ? null : o.start, pe = o.allDay ? null : new Date(o.start.getTime() + (o.dur || 30 * 60000));
        const notes = [ev.location, ev.description].filter(Boolean).join(' · ').slice(0, 500) || null;
        const { rows } = await query(`UPDATE dayplan_activities SET title=$4, planned_start=$5, planned_end=$6, notes=$7, updated_at=NOW() WHERE user_id=$1 AND day=$2 AND ext_uid=$3 RETURNING id`, [userId, o.day, ext, title, ps, pe, notes]);
        if (rows.length) { updated++; continue; }
        const id = await addAct(by, userId, o.day, { title, category: 'meeting', ps, pe, notes }, 'google', { ext_uid: ext });
        if (id) added++;
      }
    }
    return { events: evs.length, added, updated };
  }
  function fetchText(url, hops = 0) {
    return new Promise((resolve, reject) => {
      let u;
      try { u = new URL(url.replace(/^webcal:/i, 'https:')); } catch (_) { return reject(httpError(400, 'That address is not a web address')); }
      if (!/^https?:$/.test(u.protocol)) return reject(httpError(400, 'Use the https address of the calendar'));
      if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[?::1)/i.test(u.hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(u.hostname)) return reject(httpError(400, 'Only calendars on the internet can be imported'));
      const lib = u.protocol === 'https:' ? https : http;
      const rq = lib.get(u, { timeout: 15000, headers: { 'User-Agent': 'VisionAuto-DayPlan/1.0', Accept: 'text/calendar,*/*' } }, (r) => {
        if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && hops < 4) { r.resume(); return resolve(fetchText(new URL(r.headers.location, u).toString(), hops + 1)); }
        if (r.statusCode !== 200) { r.resume(); return reject(httpError(502, 'The calendar address answered ' + r.statusCode + '. Check it is the secret iCal address.')); }
        let size = 0; const chunks = [];
        r.on('data', (c) => { size += c.length; if (size > 5e6) { rq.destroy(); reject(httpError(413, 'That calendar is too big')); } else chunks.push(c); });
        r.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });
      rq.on('timeout', () => { rq.destroy(); reject(httpError(504, 'The calendar did not answer in time')); });
      rq.on('error', (e) => reject(httpError(502, 'Could not reach the calendar: ' + e.message)));
    });
  }
  async function syncFeed(f, by) {
    const today = jmDay();
    try {
      const text = await fetchText(f.url);
      const r = await importIcs(by || f.user_id, f.user_id, text, addDays(today, -1), addDays(today, 30));
      await query(`UPDATE dayplan_feeds SET last_sync = NOW(), last_count = $2, last_error = NULL WHERE id = $1`, [f.id, r.added + r.updated]);
      return r;
    } catch (e) {
      await query(`UPDATE dayplan_feeds SET last_sync = NOW(), last_error = $2 WHERE id = $1`, [f.id, String(e.publicMessage || e.message).slice(0, 300)]);
      throw e;
    }
  }
  app.post('/api/dayplan/import', requireAdmin, async (req, res) => {
    try {
      await ready();
      const b = req.body || {};
      const who = parseInt(b.user_id, 10) || uid(req);
      if (!(await canTouch(req, who))) throw httpError(403, 'You can only import into your own day');
      const today = jmDay();
      const from = DAY_RE.test(b.from || '') ? b.from : today, to = DAY_RE.test(b.to || '') ? b.to : addDays(today, 30);
      if (b.ics) {
        if (String(b.ics).length > 5e6) throw httpError(413, 'That file is too big');
        return res.json(Object.assign({ ok: true }, await importIcs(uid(req), who, String(b.ics), from, to)));
      }
      const url = str(b.url, 1000);
      if (!url) throw httpError(400, 'Choose an .ics file or paste the calendar\'s iCal address');
      let feed = (await query(`SELECT * FROM dayplan_feeds WHERE user_id = $1 AND url = $2`, [who, url])).rows[0];
      if (!feed) feed = (await query(`INSERT INTO dayplan_feeds (user_id, label, url, auto) VALUES ($1,$2,$3,$4) RETURNING *`, [who, str(b.label, 80) || 'Google Calendar', url, b.auto !== false])).rows[0];
      else await query(`UPDATE dayplan_feeds SET auto = $2 WHERE id = $1`, [feed.id, b.auto !== false]);
      res.json(Object.assign({ ok: true, feed_id: feed.id }, await syncFeed(feed, uid(req))));
    } catch (e) { fail(res, e); }
  });
  app.get('/api/dayplan/feeds', requireAdmin, async (req, res) => {
    try {
      await ready();
      const c = await caps(req);
      const { rows } = await query(`SELECT f.id, f.user_id, u.name, f.label, regexp_replace(f.url, '(private-)[^/]+', '\\1•••') AS url, f.auto, f.last_sync, f.last_count, f.last_error FROM dayplan_feeds f JOIN users u ON u.id = f.user_id
        WHERE ($2 OR f.user_id = $1) ORDER BY u.name, f.id`, [uid(req), c.manage]);
      res.json({ feeds: rows });
    } catch (e) { fail(res, e); }
  });
  app.delete('/api/dayplan/feeds/:id', requireAdmin, async (req, res) => {
    try {
      await ready();
      const { rows } = await query(`SELECT user_id FROM dayplan_feeds WHERE id = $1`, [parseInt(req.params.id, 10)]);
      if (!rows.length) throw httpError(404, 'Not found');
      if (!(await canTouch(req, rows[0].user_id))) throw httpError(403, 'Not yours');
      await query(`DELETE FROM dayplan_feeds WHERE id = $1`, [parseInt(req.params.id, 10)]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ---------------------------------------------------- the minute tick --
  async function once(kind, ref, day) {
    const { rows } = await query(`INSERT INTO dayplan_alerts (kind, ref, day) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING 1`, [kind, String(ref), day]);
    return rows.length > 0;
  }
  let ticking = false, lastFeeds = 0;
  async function tick(nowMs) {
    if (ticking) return; ticking = true;
    try {
      await ready();
      const now = nowMs || Date.now(), today = jmDay(now), s = await settings();
      const staff = await staffList();
      const ids = staff.map((x) => x.id);
      const plan = await planFor(ids, today);
      const working = staff.filter((x) => plan[x.id] && plan[x.id].kind === 'shift');
      // the day's schedule, made once in the morning (from 05:00)
      if (s.auto_schedule === 'on' && now >= at(today, '05:00').getTime() && await once('schedule', 'all', today)) {
        await makeSchedule(today, null);
        if (s.fill_auto === 'on') await fillDay(today, null).catch((e) => console.warn('[dayplan] fill', e.message));
      }
      // the devotion on the team calendar, the first time round
      if (s.devotion_event_id) await syncCalendarEvent().catch(() => {});
      // devotion
      const dev = await devotionFor(today);
      if (dev.mode !== 'off' && notice) {
        const st = new Date(dev.starts_at).getTime(), remind = parseInt(s.devotion_remind, 10) || 0;
        // on a day the shop is closed (Sunday, a holiday) nobody is rostered: tell all staff
        const to = (working.length ? working : staff).map((x) => x.id);
        const what = dev.title ? dev.title + (dev.scripture_ref ? ' · ' + dev.scripture_ref : '') : 'Devotion';
        if (remind && now >= st - remind * 60000 && now < st && await once('devotion_soon', 'all', today))
          await notice(to, { kind: 'devotion', title: '🙏 Devotion in ' + Math.max(1, Math.round((st - now) / 60000)) + ' min: Start your day with God', body: what + (dev.location ? ' · ' + dev.location : ''), link: '/day.html#devotion' });
        if (now >= st && now < st + 15 * 60000 && await once('devotion_start', 'all', today))
          await notice(to, { kind: 'devotion', title: '🙏 Devotion is starting now', body: what + (dev.leader_name ? ' · led by ' + dev.leader_name : ''), link: '/day.html#devotion', urgent: true });
      }
      // rostered but not clocked in
      const grace = parseInt(s.missing_grace, 10) || 10;
      const { rows: inNow } = await query(`SELECT DISTINCT user_id FROM attendance WHERE work_day = $1`, [today]);
      const missing = [];
      for (const p of working) {
        const st = at(today, plan[p.id].start).getTime();
        let en = at(today, plan[p.id].end).getTime(); if (en <= st) en += 86400000;
        if (now < st + grace * 60000 || now > en) continue;
        if (inNow.some((r) => r.user_id === p.id)) continue;
        if (await once('missing', p.id, today)) {
          missing.push(p);
          if (notice) await notice([p.id], { kind: 'dayplan', title: '⏰ You are not clocked in', body: 'Your shift started at ' + plan[p.id].start + '. Clock in, or tell your manager if you are away today.', link: '/clock.html', urgent: true });
        }
      }
      if (missing.length && s.missing_tell_managers === 'on' && notice) {
        const mg = (await managers()).filter((m) => !missing.some((x) => x.id === m));
        if (mg.length) await notice(mg, { kind: 'dayplan', title: '⏰ Not clocked in: ' + missing.map((x) => x.name).join(', '), body: missing.map((x) => x.name + ' (from ' + plan[x.id].start + ')').join(', '), link: '/roster.html#today' });
      }
      // activities about to start
      const ar = parseInt(s.activity_remind, 10) || 0;
      if (ar && notice) {
        const { rows: soon } = await query(`SELECT id, user_id, title, planned_start FROM dayplan_activities WHERE day = $1 AND status = 'planned' AND source <> 'fill' AND planned_start BETWEEN $2 AND $3`, [today, new Date(now), new Date(now + ar * 60000)]);
        for (const a of soon) if (await once('activity', a.id, today)) await notice([a.user_id], { kind: 'dayplan', title: '🗓 ' + a.title + ' at ' + hhmm(a.planned_start), body: 'Tap Start on your day when you begin.', link: '/day.html#me' });
      }
      // Google Calendar feeds, hourly
      if (now - lastFeeds > 3600000) {
        lastFeeds = now;
        const { rows: feeds } = await query(`SELECT * FROM dayplan_feeds WHERE auto`);
        for (const f of feeds) await syncFeed(f, null).catch(() => {});
      }
      await query(`DELETE FROM dayplan_alerts WHERE day < $1`, [addDays(today, -7)]);
    } catch (e) { if (!/does not exist/.test(e.message)) console.warn('[dayplan] tick', e.message); }
    finally { ticking = false; }
  }
  if (!deps.noTimer) setInterval(() => tick(), 60000).unref();

  // Activities and the devotion for the team calendar (team.js /api/team/events "extra").
  async function calendarExtra(req, from, to) {
    try {
      await ready();
      const { rows } = await query(`SELECT id, title, status, planned_start, planned_end, to_char(day, 'YYYY-MM-DD') AS d FROM dayplan_activities WHERE user_id = $1 AND day BETWEEN $2::date AND $3::date ORDER BY planned_start NULLS LAST`,
        [uid(req), jmDay(from), jmDay(to)]);
      // the devotion on each day that has one (not Sundays, holidays or days switched off)
      const out = [];
      const d0 = jmDay(from), d1 = jmDay(to);
      if (d0 <= d1 && (new Date(d1) - new Date(d0)) / 86400000 <= 62) {
        for (let d = d0; d <= d1; d = addDays(d, 1)) {
          const dv = await devotionFor(d);
          if (dv.mode === 'off') continue;
          out.push({ source: 'dayplan', id: 'dev-' + d, title: '🙏 Start your day with God' + (dv.title ? ': ' + dv.title : ''), kind: 'meeting', all_day: false, start: dv.starts_at, end: dv.ends_at,
            location: dv.location || null, link: '/day.html#devotion' });
        }
      }
      return out.concat(rows.map((a) => ({ source: 'dayplan', id: 'dp-' + a.id, title: (a.status === 'done' ? '✓ ' : a.status === 'in_progress' ? '▶ ' : '') + a.title, kind: 'other',
        all_day: !a.planned_start, start: a.planned_start ? iso(a.planned_start) : a.d, end: a.planned_start ? iso(a.planned_end || a.planned_start) : a.d, link: '/day.html#me' })));
    } catch (_) { return []; }
  }

  return { tick, makeSchedule, fillDay, hoursFor, devotionFor, calendarExtra, parseIcs, expand, ready, syncCalendarEvent, staffList, planFor, caps };
}

module.exports = { register, DDL };
