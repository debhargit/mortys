// =============================================================================
//  Morty's Auto Parts -- Team chat, calls and staff calendar
//
//  Mounted by server.js:  require('./team').register(app, deps)
//  Every staff screen loads /assets/team-chat.js (through staff-assist.js),
//  which talks to /api/team/*. All of it is staff only (requireAdmin).
//
//  Chat: one-to-one chats, groups (with group admins, "only admins can post"),
//  and the "All staff" group, which every active staff login belongs to and
//  which is kept in step automatically. Messages are text, files (photos, PDF,
//  Office, voice notes, short clips: checked by their first bytes, 15 MB at
//  most, saved under data/team-files with a random name, never served
//  directly), replies, reactions, edits and deletes. A memo is a message with
//  a subject that can ask everyone to acknowledge it; posting one, or posting
//  in the All staff group, needs team.announce.
//
//  Live updates: /api/team/stream is a Server-Sent Events stream per browser
//  tab; /api/team/poll is the fallback when a proxy breaks the stream. Who is
//  online is whoever has a stream open (or polled in the last 40 seconds).
//
//  Calls: voice and video between the browsers themselves (WebRTC, every
//  participant connected to every other, so small groups). This server only
//  rings people and passes the connection messages between them; no audio or
//  video passes through it or is recorded. STUN/TURN servers come from the
//  team_ice_servers setting.
//
//  Calendar: meetings, training, deadlines and the like, for invited staff or
//  (team.announce) the whole company, with RSVP, repeats and reminders. Staff
//  leave, public holidays, your own shifts and (hr.manage) interviews are
//  shown alongside.
//
//  Emergency alarm: any staff member can raise one (fire, medical, robbery,
//  evacuate); it sounds on every staff screen until each person answers, with
//  a live roll call, until the all clear.
//
//  Management (team.oversee): every conversation including one-to-one chats,
//  deleted messages, search, memo acknowledgements, call log, export. Each
//  time a manager opens a conversation they are not in, it is logged.
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mailer = require('./mailer');
const sms = require('./sms');

const FILE_RE = /^[0-9a-f]{32}\.[a-z0-9]{2,5}$/;
const TYPES = {
  '.jpg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.zip': 'application/zip',
  '.doc': 'application/msword', '.xls': 'application/vnd.ms-excel', '.webm': 'audio/webm', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
};
const INLINE = new Set(['.jpg', '.png', '.gif', '.webp', '.pdf', '.webm', '.ogg', '.m4a', '.mp4', '.mp3']);
const EMOJI = ['👍', '❤️', '😂', '😮', '🙏', '✅'];
const EVENT_KINDS = ['meeting', 'training', 'shift', 'deadline', 'leave', 'holiday', 'social', 'other'];
const STATUSES = ['available', 'busy', 'away', 'dnd'];
const DEFAULT_ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

function register(app, deps) {
  const { query, requireAdmin, requireCap, userCan } = deps;
  const can = (k) => [requireAdmin, requireCap(k)];
  const DIR = path.join(__dirname, '..', 'data', 'team-files');
  fs.mkdirSync(DIR, { recursive: true });
  function httpError(status, msg) { const e = new Error(msg); e.status = status; e.publicMessage = msg; return e; }
  function fail(res, e) { const s = e.status || 500; if (s >= 500) console.error('[team]', e); res.status(s).json({ error: e.publicMessage || e.message }); }
  const me = (req) => req.session.userId;
  const n = (v) => { const x = parseInt(v, 10); return Number.isFinite(x) ? x : null; };
  const t = (v, m) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, m));
  async function setting(key, dflt) {
    const { rows } = await query('SELECT value FROM warehouse_settings WHERE key = $1', [key]);
    return rows.length && rows[0].value != null ? rows[0].value : dflt;
  }
  async function putSetting(key, value) {
    await query('INSERT INTO warehouse_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, value]);
  }
  const ACTIVE = `u.is_admin AND NOT COALESCE(u.disabled, false) AND u.archived_at IS NULL`;

  // ------------------------------------------------------------- live bus --
  // Per user: the open streams and a short ring of recent events, so a stream
  // that reconnects (Last-Event-ID) or the poll fallback misses nothing.
  let seq = Date.now();
  const streams = new Map();   // userId -> Set(res)
  const rings = new Map();     // userId -> [{ id, type, data, at }]
  const polled = new Map();    // userId -> last poll time
  function online(uid) { return (streams.get(uid) && streams.get(uid).size > 0) || (Date.now() - (polled.get(uid) || 0) < 40000); }
  function emit(userIds, type, data) {
    const ids = [...new Set((userIds || []).map(Number).filter(Boolean))];
    for (const uid of ids) {
      const ev = { id: ++seq, type, data, at: Date.now() };
      let r = rings.get(uid); if (!r) rings.set(uid, (r = []));
      r.push(ev); while (r.length > 300 || (r.length && Date.now() - r[0].at > 180000)) r.shift();
      const set = streams.get(uid);
      if (set) for (const res of set) { try { res.write('id: ' + ev.id + '\nevent: ' + type + '\ndata: ' + JSON.stringify(data) + '\n\n'); } catch (_) {} }
    }
  }
  const everyoneOnline = () => [...new Set([...streams.keys(), ...polled.keys()])].filter(online);
  async function membersOf(convId) {
    const { rows } = await query('SELECT user_id FROM team_members WHERE conversation_id = $1 AND left_at IS NULL', [convId]);
    return rows.map((r) => r.user_id);
  }
  async function touchPresence(uid) {
    await query(`INSERT INTO team_presence (user_id, last_seen) VALUES ($1, NOW()) ON CONFLICT (user_id) DO UPDATE SET last_seen = NOW()`, [uid]).catch(() => {});
  }
  async function presenceOf(uid) {
    const { rows } = await query(`SELECT status, status_text, to_char(last_seen AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_seen FROM team_presence WHERE user_id = $1`, [uid]);
    return Object.assign({ user_id: uid, online: online(uid), status: 'available', status_text: null, last_seen: null }, rows[0] || {}, { online: online(uid) });
  }
  async function wentOnline(uid) { await touchPresence(uid); emit(everyoneOnline(), 'presence', await presenceOf(uid)); }
  async function maybeOffline(uid) {
    if (online(uid)) return;
    await touchPresence(uid);
    emit(everyoneOnline(), 'presence', await presenceOf(uid));
    for (const c of calls.values()) if (c.participants.has(uid)) leaveCall(c, uid).catch(() => {});
  }

  app.get('/api/team/stream', requireAdmin, async (req, res) => {
    const uid = me(req);
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
    res.write('retry: 4000\n\n');
    const last = n(req.get('last-event-id') || req.query.after);
    if (last) for (const ev of rings.get(uid) || []) if (ev.id > last) res.write('id: ' + ev.id + '\nevent: ' + ev.type + '\ndata: ' + JSON.stringify(ev.data) + '\n\n');
    const was = online(uid);
    let set = streams.get(uid); if (!set) streams.set(uid, (set = new Set()));
    set.add(res);
    res.write('event: hello\ndata: ' + JSON.stringify({ seq }) + '\n\n');
    if (!was) wentOnline(uid).catch(() => {});
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 25000);
    // Closed now and then so a session that was signed out (idle, disabled,
    // terminal terminated) stops receiving; the browser reconnects at once.
    const cap = setTimeout(() => { try { res.end(); } catch (_) {} }, 10 * 60000);
    req.on('close', () => {
      clearInterval(ping); clearTimeout(cap);
      set.delete(res); if (!set.size) streams.delete(uid);
      setTimeout(() => maybeOffline(uid).catch(() => {}), 8000);
    });
  });
  // Fallback when the stream cannot get through: the same events, by polling.
  app.get('/api/team/poll', requireAdmin, async (req, res) => {
    const uid = me(req), after = n(req.query.after) || 0;
    const was = online(uid);
    polled.set(uid, Date.now());
    if (!was) wentOnline(uid).catch(() => {});
    res.json({ seq, events: (rings.get(uid) || []).filter((e) => e.id > after).map((e) => ({ id: e.id, type: e.type, data: e.data })) });
  });
  // Presence housekeeping: last-seen for everyone connected, drop anyone who
  // stopped polling, and close the streams of logins that were switched off.
  setInterval(async () => {
    try {
      for (const [uid, at] of polled) if (Date.now() - at > 40000) { polled.delete(uid); maybeOffline(uid).catch(() => {}); }
      const ids = [...streams.keys()];
      if (!ids.length) return;
      await query('UPDATE team_presence SET last_seen = NOW() WHERE user_id = ANY($1::int[])', [ids]);
      const { rows } = await query(`SELECT u.id FROM users u WHERE u.id = ANY($1::int[]) AND NOT (${ACTIVE})`, [ids]);
      for (const r of rows) for (const res of streams.get(r.id) || []) { try { res.end(); } catch (_) {} }
    } catch (_) {}
  }, 30000).unref();

  // -------------------------------------------------------------- config --
  async function caps(req) {
    const [announce, oversee, hr, clock] = await Promise.all(['team.announce', 'team.oversee', 'hr.manage', 'clock.manage'].map((c) => userCan(req, c)));
    return { announce, oversee, hr, clock };
  }
  async function iceServers() {
    try { const v = JSON.parse(await setting('team_ice_servers', '')); if (Array.isArray(v) && v.length) return v; } catch (_) {}
    return DEFAULT_ICE;
  }
  app.get('/api/team/config', requireAdmin, async (req, res) => {
    try {
      const { rows } = await query('SELECT id, name, email FROM users WHERE id = $1', [me(req)]);
      res.json({ me: rows[0], caps: await caps(req), ice_servers: await iceServers(), emoji: EMOJI, event_kinds: EVENT_KINDS, mail_on: !!(mailer.isActive && mailer.isActive()), presence: await presenceOf(me(req)) });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/team/settings', ...can('team.oversee'), async (req, res) => {
    try { res.json({ ice_servers: await iceServers(), custom: !!(await setting('team_ice_servers', '')), retention_days: parseInt(await setting('team_retention_days', '0'), 10) || 0 }); } catch (e) { fail(res, e); }
  });
  app.put('/api/team/settings', ...can('team.oversee'), async (req, res) => {
    try {
      const b = req.body || {};
      if ('ice_servers' in b) {
        if (b.ice_servers == null || b.ice_servers === '') await putSetting('team_ice_servers', '');
        else {
          const list = Array.isArray(b.ice_servers) ? b.ice_servers : null;
          if (!list || !list.length || list.length > 6 || !list.every((s) => s && (typeof s.urls === 'string' || Array.isArray(s.urls)) && /^(stun|turns?):/i.test([].concat(s.urls)[0] || '')))
            throw httpError(400, 'Each server needs urls starting stun: or turn:');
          await putSetting('team_ice_servers', JSON.stringify(list.map((s) => ({ urls: s.urls, username: t(s.username, 200) || undefined, credential: t(s.credential, 200) || undefined }))));
        }
      }
      if ('retention_days' in b) {
        const d = n(b.retention_days) || 0;
        if (d && (d < 30 || d > 3650)) throw httpError(400, 'Keep messages for 30 to 3650 days, or 0 for always');
        await putSetting('team_retention_days', String(d));
      }
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // -------------------------------------------------------------- people --
  app.get('/api/team/people', requireAdmin, async (req, res) => {
    try {
      const { rows } = await query(`SELECT u.id, u.name, u.email, COALESCE(r.label, u.admin_role) AS role,
          p.status, p.status_text, to_char(p.last_seen AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_seen,
          (SELECT a.mode FROM attendance a WHERE a.user_id = u.id AND a.clock_out_at IS NULL AND a.clock_in_at > NOW() - INTERVAL '16 hours' ORDER BY a.clock_in_at DESC LIMIT 1) AS clocked_in,
          EXISTS (SELECT 1 FROM staff_leave l WHERE l.user_id = u.id AND CURRENT_DATE BETWEEN l.from_date AND l.to_date) AS on_leave
        FROM users u LEFT JOIN roles r ON r.code = u.admin_role LEFT JOIN team_presence p ON p.user_id = u.id
        WHERE ${ACTIVE} ORDER BY u.name`);
      for (const r of rows) { r.online = online(r.id); r.status = r.status || 'available'; }
      res.json({ people: rows });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/team/presence', requireAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      const status = STATUSES.includes(b.status) ? b.status : 'available';
      await query(`INSERT INTO team_presence (user_id, status, status_text, last_seen) VALUES ($1, $2, $3, NOW())
        ON CONFLICT (user_id) DO UPDATE SET status = EXCLUDED.status, status_text = EXCLUDED.status_text`, [me(req), status, t(b.status_text, 80)]);
      const p = await presenceOf(me(req));
      emit(everyoneOnline(), 'presence', p);
      res.json({ presence: p });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------- conversations --
  // The All staff group: created on first use, membership follows who is an
  // active staff login (new staff join, archived or disabled staff drop off).
  let companyId = null, companySynced = 0;
  async function company() {
    if (!companyId) {
      const find = () => query(`SELECT id FROM team_conversations WHERE kind = 'company' LIMIT 1`);
      let { rows } = await find();
      if (!rows.length) {
        await query(`INSERT INTO team_conversations (kind, title, description, only_admins_post)
          VALUES ('company', 'All staff', 'Everyone at Morty''s Auto Parts. Announcements and memos land here.', true) ON CONFLICT DO NOTHING`);
        rows = (await find()).rows;
      }
      companyId = rows[0].id;
    }
    if (Date.now() - companySynced > 60000) {
      companySynced = Date.now();
      await query(`INSERT INTO team_members (conversation_id, user_id, last_read_id)
          SELECT $1, u.id, COALESCE((SELECT MAX(id) FROM team_messages WHERE conversation_id = $1), 0) FROM users u WHERE ${ACTIVE}
        ON CONFLICT (conversation_id, user_id) DO UPDATE SET left_at = NULL WHERE team_members.left_at IS NOT NULL`, [companyId]);
      await query(`UPDATE team_members m SET left_at = NOW() FROM users u WHERE m.conversation_id = $1 AND m.user_id = u.id AND m.left_at IS NULL AND NOT (${ACTIVE})`, [companyId]);
    }
    return companyId;
  }
  // The conversation and this user's place in it. Managers with team.oversee
  // may act on any conversation; `need` says what the caller wants to do.
  async function convFor(req, id, need) {
    const { rows } = await query(`SELECT c.*, m.role AS my_role, m.left_at AS my_left, m.last_read_id, (m.user_id IS NOT NULL AND m.left_at IS NULL) AS is_member
      FROM team_conversations c LEFT JOIN team_members m ON m.conversation_id = c.id AND m.user_id = $2 WHERE c.id = $1`, [id, me(req)]);
    const c = rows[0];
    if (!c) throw httpError(404, 'Conversation not found');
    c.oversee = await userCan(req, 'team.oversee');
    if (need === 'read' && !c.is_member && !c.oversee) throw httpError(403, 'You are not in this conversation');
    if (need === 'post') {
      if (!c.is_member) throw httpError(403, 'You are not in this conversation');
      if (c.archived_at) throw httpError(409, 'This group has been closed');
      if (c.only_admins_post && c.my_role !== 'admin' && !(await userCan(req, 'team.announce')))
        throw httpError(403, c.kind === 'company' ? 'Only managers can post to All staff. Message a manager or a group instead.' : 'Only group admins can post here');
    }
    if (need === 'admin' && c.my_role !== 'admin' && !c.oversee) throw httpError(403, 'Only group admins can change this');
    return c;
  }
  async function systemMsg(convId, by, body) {
    const { rows } = await query(`INSERT INTO team_messages (conversation_id, sender_id, kind, body) VALUES ($1, $2, 'system', $3) RETURNING id`, [convId, by, body]);
    await query('UPDATE team_conversations SET last_message_at = NOW() WHERE id = $1', [convId]);
    const msg = await oneMessage(rows[0].id, by);
    emit(await membersOf(convId), 'msg', msg);
  }
  const nameOf = async (id) => ((await query('SELECT name FROM users WHERE id = $1', [id])).rows[0] || {}).name || 'Someone';

  app.get('/api/team/conversations', requireAdmin, async (req, res) => {
    try {
      await company();
      const { rows } = await query(`SELECT c.id, c.kind, c.title, c.description, c.only_admins_post, c.archived_at, c.event_id,
          to_char(COALESCE(c.last_message_at, c.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_at,
          m.role AS my_role, m.muted, m.pinned, m.last_read_id,
          (SELECT COUNT(*)::int FROM team_members mm WHERE mm.conversation_id = c.id AND mm.left_at IS NULL) AS member_count,
          (SELECT COUNT(*)::int FROM team_messages x WHERE x.conversation_id = c.id AND x.id > m.last_read_id AND x.sender_id IS DISTINCT FROM $1 AND x.deleted_at IS NULL AND x.kind <> 'system') AS unread,
          lm.id AS last_id, lm.kind AS last_kind, lm.body AS last_body, lm.subject AS last_subject, lm.file_name AS last_file, lm.deleted_at IS NOT NULL AS last_deleted, lm.sender_id AS last_sender, ls.name AS last_sender_name,
          o.id AS other_id, o.name AS other_name
        FROM team_members m JOIN team_conversations c ON c.id = m.conversation_id
        LEFT JOIN LATERAL (SELECT * FROM team_messages x WHERE x.conversation_id = c.id ORDER BY x.id DESC LIMIT 1) lm ON true
        LEFT JOIN users ls ON ls.id = lm.sender_id
        LEFT JOIN LATERAL (SELECT u.id, u.name FROM team_members om JOIN users u ON u.id = om.user_id WHERE c.kind = 'direct' AND om.conversation_id = c.id AND om.user_id <> $1 LIMIT 1) o ON true
        WHERE m.user_id = $1 AND m.left_at IS NULL AND (c.kind <> 'direct' OR c.last_message_at IS NOT NULL)
        ORDER BY (c.archived_at IS NOT NULL), m.pinned DESC, COALESCE(c.last_message_at, c.created_at) DESC`, [me(req)]);
      for (const r of rows) {
        r.last_id = r.last_id == null ? null : Number(r.last_id); r.last_read_id = Number(r.last_read_id);
        if (r.kind === 'direct') { r.title = r.other_name || 'Former staff'; r.other_online = r.other_id ? online(r.other_id) : false; }
        r.last_preview = r.last_deleted ? 'Message deleted' : r.last_kind === 'memo' ? '📢 ' + (r.last_subject || 'Memo') : r.last_kind === 'call' ? '📞 ' + (r.last_body || 'Call')
          : r.last_file && !r.last_body ? '📎 ' + r.last_file : (r.last_body || '');
        r.last_preview = String(r.last_preview).slice(0, 120);
        r.call = activeCallFor(r.id);
        delete r.last_body;
      }
      res.json({ conversations: rows, unread_total: rows.reduce((s, r) => s + (r.muted ? 0 : r.unread), 0) });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/team/direct', requireAdmin, async (req, res) => {
    try {
      const other = n((req.body || {}).user_id), mine = me(req);
      if (!other || other === mine) throw httpError(400, 'Choose someone to message');
      const { rows: ok } = await query(`SELECT u.id FROM users u WHERE u.id = $1 AND ${ACTIVE}`, [other]);
      if (!ok.length) throw httpError(404, 'That person is not an active staff member');
      const key = Math.min(mine, other) + ':' + Math.max(mine, other);
      let { rows } = await query(`SELECT id FROM team_conversations WHERE direct_key = $1`, [key]);
      if (!rows.length) {
        rows = (await query(`INSERT INTO team_conversations (kind, direct_key, created_by) VALUES ('direct', $1, $2) ON CONFLICT (direct_key) WHERE direct_key IS NOT NULL DO NOTHING RETURNING id`, [key, mine])).rows;
        if (!rows.length) rows = (await query(`SELECT id FROM team_conversations WHERE direct_key = $1`, [key])).rows;
      }
      const id = rows[0].id;
      await query(`INSERT INTO team_members (conversation_id, user_id) VALUES ($1, $2), ($1, $3) ON CONFLICT (conversation_id, user_id) DO UPDATE SET left_at = NULL`, [id, mine, other]);
      res.json({ id });
    } catch (e) { fail(res, e); }
  });
  async function addMembers(convId, ids, by) {
    const { rows } = await query(`SELECT u.id, u.name FROM users u WHERE u.id = ANY($1::int[]) AND ${ACTIVE}`, [ids]);
    const added = [];
    for (const u of rows) {
      const r = await query(`INSERT INTO team_members (conversation_id, user_id, last_read_id) VALUES ($1, $2, COALESCE((SELECT MAX(id) FROM team_messages WHERE conversation_id = $1), 0))
        ON CONFLICT (conversation_id, user_id) DO UPDATE SET left_at = NULL, joined_at = NOW() WHERE team_members.left_at IS NOT NULL RETURNING user_id`, [convId, u.id]);
      if (r.rows.length && u.id !== by) added.push(u);
    }
    return added;
  }
  app.post('/api/team/groups', requireAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      const title = t(b.title, 80);
      if (!title) throw httpError(400, 'Give the group a name');
      const ids = (Array.isArray(b.member_ids) ? b.member_ids : []).map(n).filter(Boolean).slice(0, 300);
      const { rows } = await query(`INSERT INTO team_conversations (kind, title, description, only_admins_post, created_by) VALUES ('group', $1, $2, $3, $4) RETURNING id`,
        [title, t(b.description, 400), !!b.only_admins_post, me(req)]);
      const id = rows[0].id;
      await query(`INSERT INTO team_members (conversation_id, user_id, role) VALUES ($1, $2, 'admin')`, [id, me(req)]);
      const added = await addMembers(id, ids.filter((x) => x !== me(req)), me(req));
      await systemMsg(id, me(req), (await nameOf(me(req))) + ' created the group' + (added.length ? ' and added ' + added.map((u) => u.name).join(', ') : ''));
      emit(added.map((u) => u.id), 'conv', { id });
      res.json({ id });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/team/conversations/:id', requireAdmin, async (req, res) => {
    try {
      const c = await convFor(req, n(req.params.id), 'read');
      const { rows: members } = await query(`SELECT m.user_id, u.name, m.role, m.last_read_id, COALESCE(r.label, u.admin_role) AS job,
          to_char(m.joined_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS joined_at
        FROM team_members m JOIN users u ON u.id = m.user_id LEFT JOIN roles r ON r.code = u.admin_role WHERE m.conversation_id = $1 AND m.left_at IS NULL ORDER BY m.role, u.name`, [c.id]);
      for (const m of members) { m.online = online(m.user_id); m.last_read_id = Number(m.last_read_id); }
      const other = c.kind === 'direct' ? members.find((m) => m.user_id !== me(req)) : null;
      res.json({ conversation: { id: c.id, kind: c.kind, title: other ? other.name : c.title, description: c.description, only_admins_post: c.only_admins_post, archived_at: c.archived_at,
        my_role: c.my_role, is_member: c.is_member, other_id: other ? other.user_id : null, event_id: c.event_id, call: activeCallFor(c.id),
        can_post: c.is_member && !c.archived_at && (!c.only_admins_post || c.my_role === 'admin' || await userCan(req, 'team.announce')) }, members });
    } catch (e) { fail(res, e); }
  });
  app.patch('/api/team/conversations/:id', requireAdmin, async (req, res) => {
    try {
      const c = await convFor(req, n(req.params.id), 'admin');
      if (c.kind === 'direct') throw httpError(400, 'One-to-one chats have no settings');
      const b = req.body || {}, sets = [], vals = [c.id], notes = [];
      if (b.title !== undefined && c.kind !== 'company') { const v = t(b.title, 80); if (!v) throw httpError(400, 'Give the group a name'); vals.push(v); sets.push('title = $' + vals.length); if (v !== c.title) notes.push('renamed the group to “' + v + '”'); }
      if (b.description !== undefined) { vals.push(t(b.description, 400)); sets.push('description = $' + vals.length); }
      if (b.only_admins_post !== undefined) { vals.push(!!b.only_admins_post); sets.push('only_admins_post = $' + vals.length); if (!!b.only_admins_post !== c.only_admins_post) notes.push(b.only_admins_post ? 'set the group so only admins can post' : 'let everyone post'); }
      if (b.archived !== undefined && c.kind !== 'company') {
        if (!c.oversee && c.my_role !== 'admin') throw httpError(403, 'Only group admins can close a group');
        sets.push(b.archived ? 'archived_at = COALESCE(archived_at, NOW())' : 'archived_at = NULL'); notes.push(b.archived ? 'closed the group' : 'reopened the group');
      }
      if (!sets.length) return res.json({ ok: true });
      await query(`UPDATE team_conversations SET ${sets.join(', ')} WHERE id = $1`, vals);
      if (notes.length) await systemMsg(c.id, me(req), (await nameOf(me(req))) + ' ' + notes.join(' and '));
      emit(await membersOf(c.id), 'conv', { id: c.id });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/team/conversations/:id/members', requireAdmin, async (req, res) => {
    try {
      const c = await convFor(req, n(req.params.id), 'admin');
      if (c.kind !== 'group') throw httpError(400, c.kind === 'company' ? 'Everyone on the staff list is in All staff automatically' : 'Start a group to chat with more people');
      const ids = (Array.isArray((req.body || {}).user_ids) ? req.body.user_ids : []).map(n).filter(Boolean).slice(0, 300);
      const added = await addMembers(c.id, ids, null);
      if (added.length) {
        await systemMsg(c.id, me(req), (await nameOf(me(req))) + ' added ' + added.map((u) => u.name).join(', '));
        emit(added.map((u) => u.id), 'conv', { id: c.id });
      }
      res.json({ added: added.length });
    } catch (e) { fail(res, e); }
  });
  app.delete('/api/team/conversations/:id/members/:uid', requireAdmin, async (req, res) => {
    try {
      const uid = n(req.params.uid), self = uid === me(req);
      const c = await convFor(req, n(req.params.id), self ? 'read' : 'admin');
      if (c.kind !== 'group') throw httpError(400, c.kind === 'company' ? 'Everyone on the staff list stays in All staff' : 'You cannot leave a one-to-one chat; you can mute it');
      const r = await query(`UPDATE team_members SET left_at = NOW(), role = 'member' WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL RETURNING user_id`, [c.id, uid]);
      if (!r.rows.length) throw httpError(404, 'Not in this group');
      // A group is never left without an admin: the longest-standing member takes over.
      await query(`UPDATE team_members SET role = 'admin' WHERE conversation_id = $1 AND user_id = (SELECT user_id FROM team_members WHERE conversation_id = $1 AND left_at IS NULL ORDER BY joined_at LIMIT 1)
        AND NOT EXISTS (SELECT 1 FROM team_members WHERE conversation_id = $1 AND left_at IS NULL AND role = 'admin')`, [c.id]);
      const who = await nameOf(uid);
      await systemMsg(c.id, me(req), self ? who + ' left' : (await nameOf(me(req))) + ' removed ' + who);
      emit([uid], 'conv', { id: c.id, removed: true });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.patch('/api/team/conversations/:id/members/:uid', requireAdmin, async (req, res) => {
    try {
      const c = await convFor(req, n(req.params.id), 'admin');
      if (c.kind !== 'group') throw httpError(400, 'Only groups have admins');
      const role = (req.body || {}).role === 'admin' ? 'admin' : 'member', uid = n(req.params.uid);
      if (role === 'member') {
        const { rows } = await query(`SELECT COUNT(*)::int AS n FROM team_members WHERE conversation_id = $1 AND left_at IS NULL AND role = 'admin' AND user_id <> $2`, [c.id, uid]);
        if (!rows[0].n) throw httpError(409, 'A group needs at least one admin');
      }
      const r = await query(`UPDATE team_members SET role = $3 WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL RETURNING user_id`, [c.id, uid, role]);
      if (!r.rows.length) throw httpError(404, 'Not in this group');
      await systemMsg(c.id, me(req), (await nameOf(me(req))) + (role === 'admin' ? ' made ' + (await nameOf(uid)) + ' a group admin' : ' removed ' + (await nameOf(uid)) + ' as a group admin'));
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.patch('/api/team/conversations/:id/me', requireAdmin, async (req, res) => {
    try {
      const b = req.body || {}, sets = [], vals = [n(req.params.id), me(req)];
      if (b.muted !== undefined) { vals.push(!!b.muted); sets.push('muted = $' + vals.length); }
      if (b.pinned !== undefined) { vals.push(!!b.pinned); sets.push('pinned = $' + vals.length); }
      if (sets.length) await query(`UPDATE team_members SET ${sets.join(', ')} WHERE conversation_id = $1 AND user_id = $2`, vals);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------------ messages --
  const MSG_SQL = `SELECT x.id, x.conversation_id, x.sender_id, x.kind, x.body, x.subject, x.require_ack, x.meta, x.file_name, x.file_type, x.file_size, x.reply_to,
      to_char(x.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at, x.edited_at IS NOT NULL AS edited,
      x.deleted_at IS NOT NULL AS deleted, du.name AS deleted_by_name, u.name AS sender_name,
      r.id AS r_id, r.kind AS r_kind, r.body AS r_body, r.subject AS r_subject, r.file_name AS r_file, r.deleted_at IS NOT NULL AS r_deleted, ru.name AS r_sender,
      COALESCE((SELECT json_agg(json_build_object('emoji', e.emoji, 'user_id', e.user_id, 'name', eu.name)) FROM team_reactions e JOIN users eu ON eu.id = e.user_id WHERE e.message_id = x.id), '[]') AS reactions,
      (SELECT COUNT(*)::int FROM team_acks a WHERE a.message_id = x.id) AS ack_count,
      EXISTS (SELECT 1 FROM team_acks a WHERE a.message_id = x.id AND a.user_id = $ME) AS acked
    FROM team_messages x LEFT JOIN users u ON u.id = x.sender_id LEFT JOIN users du ON du.id = x.deleted_by
      LEFT JOIN team_messages r ON r.id = x.reply_to LEFT JOIN users ru ON ru.id = r.sender_id`;
  function shape(r, full) {
    const m = { id: Number(r.id), conversation_id: r.conversation_id, sender_id: r.sender_id, sender_name: r.sender_name || 'Former staff', kind: r.kind,
      body: r.body, subject: r.subject, require_ack: r.require_ack, meta: r.meta || null, created_at: r.created_at, edited: r.edited, deleted: r.deleted,
      reactions: r.reactions || [], ack_count: r.ack_count, acked: r.acked,
      file: r.file_name ? { name: r.file_name, type: r.file_type, size: r.file_size, url: '/api/team/files/' + r.id } : null,
      reply: r.r_id ? { id: Number(r.r_id), sender_name: r.r_sender || 'Former staff', text: r.r_deleted ? 'Message deleted' : String(r.r_kind === 'memo' ? r.r_subject : r.r_body || (r.r_file ? '📎 ' + r.r_file : '')).slice(0, 140) } : null };
    if (r.deleted) {
      m.deleted_by_name = r.deleted_by_name;
      // Members see that something was deleted; management sees what it was.
      if (!full) { m.body = null; m.subject = null; m.file = null; m.reactions = []; }
    }
    return m;
  }
  async function oneMessage(id, viewer, full) {
    const { rows } = await query(MSG_SQL.replace(/\$ME/g, '$2') + ' WHERE x.id = $1', [id, viewer || 0]);
    return rows.length ? shape(rows[0], full) : null;
  }
  async function pushUpdate(id) {
    const m = await oneMessage(id, 0);
    if (m) emit(await membersOf(m.conversation_id), 'msg-update', m);
  }
  app.get('/api/team/conversations/:id/messages', requireAdmin, async (req, res) => {
    try {
      const c = await convFor(req, n(req.params.id), 'read');
      const before = n(req.query.before), lim = Math.min(200, n(req.query.limit) || 60);
      const q = t(req.query.q, 100);
      const args = [c.id, me(req)]; let where = ' WHERE x.conversation_id = $1';
      if (before) { args.push(before); where += ' AND x.id < $' + args.length; }
      if (q) { args.push('%' + q + '%'); where += ` AND x.deleted_at IS NULL AND (x.body ILIKE $${args.length} OR x.subject ILIKE $${args.length} OR x.file_name ILIKE $${args.length})`; }
      const { rows } = await query(MSG_SQL.replace(/\$ME/g, '$2') + where + ' ORDER BY x.id DESC LIMIT ' + lim, args);
      const full = !c.is_member && c.oversee;
      if (full) await query(`INSERT INTO team_audit (user_id, action, conversation_id, detail) VALUES ($1, 'viewed', $2, $3)`, [me(req), c.id, before ? 'older messages' : q ? 'searched: ' + q : null]).catch(() => {});
      res.json({ messages: rows.reverse().map((r) => shape(r, full)), more: rows.length === lim });
    } catch (e) { fail(res, e); }
  });

  let upload = null;
  try {
    const multer = require('multer');
    upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1, fields: 20 } });
  } catch (e) { console.warn('[team] multer missing: text messages only'); }
  const uploadMw = upload ? (req, res, next) => upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Files must be 15 MB or smaller' : 'Could not read the upload' });
    next();
  }) : (req, res, next) => next();
  // What the file really is, from its first bytes; the name only picks between
  // formats that share a container (Word / Excel / PowerPoint are all zips).
  function sniff(buf, name) {
    if (!buf || buf.length < 4) return null;
    const ext = path.extname(String(name || '')).toLowerCase();
    const b = (i, v) => buf[i] === v;
    if (buf.slice(0, 5).toString('latin1') === '%PDF-') return '.pdf';
    if (b(0, 0xff) && b(1, 0xd8) && b(2, 0xff)) return '.jpg';
    if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
    if (buf.slice(0, 4).toString('latin1') === 'GIF8') return '.gif';
    if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return '.webp';
    if (b(0, 0x50) && b(1, 0x4b) && b(2, 0x03) && b(3, 0x04)) return ['.docx', '.xlsx', '.pptx'].includes(ext) ? ext : '.zip';
    if (buf.slice(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return ext === '.xls' ? '.xls' : '.doc';
    if (b(0, 0x1a) && b(1, 0x45) && b(2, 0xdf) && b(3, 0xa3)) return '.webm';
    if (buf.slice(0, 4).toString('latin1') === 'OggS') return '.ogg';
    if (buf.length > 12 && buf.slice(4, 8).toString('latin1') === 'ftyp') return /^M4A/.test(buf.slice(8, 11).toString('latin1') + ' ') || ext === '.m4a' ? '.m4a' : '.mp4';
    if (buf.slice(0, 3).toString('latin1') === 'ID3' || (b(0, 0xff) && (buf[1] & 0xe0) === 0xe0)) return '.mp3';
    if ((ext === '.txt' || ext === '.csv') && !buf.includes(0)) return ext;
    return null;
  }
  const cleanName = (name, ext) => String(name || 'file' + ext).replace(/[^\w.\- ()]/g, '_').slice(0, 120) || 'file' + ext;

  app.post('/api/team/conversations/:id/messages', requireAdmin, uploadMw, async (req, res) => {
    let saved = null;
    try {
      const c = await convFor(req, n(req.params.id), 'post');
      const b = req.body || {};
      const memo = b.kind === 'memo';
      if (memo && !(await userCan(req, 'team.announce'))) throw httpError(403, 'Your account is not allowed to send memos');
      const body = t(b.body, 8000), subject = memo ? t(b.subject, 160) : null;
      if (memo && !subject) throw httpError(400, 'Give the memo a subject');
      const f = req.file;
      if (!body && !f && !memo) throw httpError(400, 'Type a message');
      let fileName = null, fileType = null, fileSize = null;
      if (f) {
        const ext = sniff(f.buffer, f.originalname);
        if (!ext) throw httpError(400, '“' + String(f.originalname || 'That file').slice(0, 60) + '” is not a type that can be sent: photos, PDF, Word, Excel, PowerPoint, voice notes, MP4 clips, text or CSV');
        saved = crypto.randomBytes(16).toString('hex') + ext;
        fs.writeFileSync(path.join(DIR, saved), f.buffer, { flag: 'wx' });
        fileName = cleanName(f.originalname && path.extname(f.originalname) ? f.originalname : 'file' + ext, ext); fileType = ext.slice(1); fileSize = f.size;
      }
      let reply = n(b.reply_to);
      if (reply) { const { rows } = await query('SELECT 1 FROM team_messages WHERE id = $1 AND conversation_id = $2', [reply, c.id]); if (!rows.length) reply = null; }
      const voice = f && b.voice === '1';
      const { rows } = await query(`INSERT INTO team_messages (conversation_id, sender_id, kind, body, subject, require_ack, file_path, file_name, file_type, file_size, reply_to, meta)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [c.id, me(req), memo ? 'memo' : f ? 'file' : 'text', body, subject, memo && b.require_ack !== false && b.require_ack !== 'false', saved, fileName, fileType, fileSize, reply,
          voice ? JSON.stringify({ voice: true, seconds: Math.min(3600, n(b.seconds) || 0) }) : null]);
      saved = null;
      const id = rows[0].id;
      await query('UPDATE team_conversations SET last_message_at = NOW() WHERE id = $1', [c.id]);
      await query('UPDATE team_members SET last_read_id = GREATEST(last_read_id, $3) WHERE conversation_id = $1 AND user_id = $2', [c.id, me(req), id]);
      const msg = await oneMessage(id, 0);
      const members = await membersOf(c.id);
      emit(members, 'msg', msg);
      if (memo) {
        const others = members.filter((u) => u !== me(req));
        await notice(others, { kind: 'memo', title: '📢 ' + subject, body: (body || '').slice(0, 300), conversation_id: c.id, message_id: id, urgent: b.urgent === true || b.urgent === '1' });
      }
      res.json({ message: msg });
    } catch (e) {
      if (saved) { try { fs.unlinkSync(path.join(DIR, saved)); } catch (_) {} }
      fail(res, e);
    }
  });
  async function msgFor(req, id) {
    const { rows } = await query('SELECT * FROM team_messages WHERE id = $1', [id]);
    if (!rows.length) throw httpError(404, 'Message not found');
    const m = rows[0];
    const c = await convFor(req, m.conversation_id, 'read');
    return { m, c };
  }
  app.patch('/api/team/messages/:id', requireAdmin, async (req, res) => {
    try {
      const { m } = await msgFor(req, n(req.params.id));
      if (m.sender_id !== me(req)) throw httpError(403, 'You can only edit your own messages');
      if (m.deleted_at || !['text', 'memo', 'file'].includes(m.kind)) throw httpError(400, 'This message cannot be edited');
      if (Date.now() - new Date(m.created_at).getTime() > 24 * 3600000) throw httpError(409, 'Messages can be edited for 24 hours');
      const body = t((req.body || {}).body, 8000);
      if (!body && m.kind === 'text') throw httpError(400, 'Type a message, or delete it instead');
      // The first wording is kept for management.
      await query(`UPDATE team_messages SET body = $2, edited_at = NOW(), original_body = COALESCE(original_body, body) WHERE id = $1`, [m.id, body]);
      await pushUpdate(m.id);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.delete('/api/team/messages/:id', requireAdmin, async (req, res) => {
    try {
      const { m, c } = await msgFor(req, n(req.params.id));
      if (m.sender_id !== me(req) && !c.oversee) throw httpError(403, 'You can only delete your own messages');
      if (m.kind === 'system' || m.kind === 'call') throw httpError(400, 'This cannot be deleted');
      await query(`UPDATE team_messages SET deleted_at = COALESCE(deleted_at, NOW()), deleted_by = $2 WHERE id = $1`, [m.id, me(req)]);
      if (m.sender_id !== me(req)) await query(`INSERT INTO team_audit (user_id, action, conversation_id, message_id, detail) VALUES ($1, 'deleted', $2, $3, $4)`, [me(req), m.conversation_id, m.id, t((req.body || {}).reason, 200)]);
      await pushUpdate(m.id);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/team/messages/:id/restore', ...can('team.oversee'), async (req, res) => {
    try {
      const { m } = await msgFor(req, n(req.params.id));
      await query(`UPDATE team_messages SET deleted_at = NULL, deleted_by = NULL WHERE id = $1`, [m.id]);
      await query(`INSERT INTO team_audit (user_id, action, conversation_id, message_id) VALUES ($1, 'restored', $2, $3)`, [me(req), m.conversation_id, m.id]);
      await pushUpdate(m.id);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/team/messages/:id/react', requireAdmin, async (req, res) => {
    try {
      const { m, c } = await msgFor(req, n(req.params.id));
      if (!c.is_member) throw httpError(403, 'You are not in this conversation');
      const emoji = String((req.body || {}).emoji || '');
      if (!EMOJI.includes(emoji)) throw httpError(400, 'Unknown reaction');
      const del = await query('DELETE FROM team_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3 RETURNING 1', [m.id, me(req), emoji]);
      if (!del.rows.length) {
        await query('DELETE FROM team_reactions WHERE message_id = $1 AND user_id = $2', [m.id, me(req)]);
        await query('INSERT INTO team_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)', [m.id, me(req), emoji]);
      }
      await pushUpdate(m.id);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/team/messages/:id/ack', requireAdmin, async (req, res) => {
    try {
      const { m, c } = await msgFor(req, n(req.params.id));
      if (!c.is_member || m.kind !== 'memo') throw httpError(400, 'Nothing to acknowledge');
      await query('INSERT INTO team_acks (message_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [m.id, me(req)]);
      await query(`UPDATE team_notices SET read_at = COALESCE(read_at, NOW()) WHERE user_id = $1 AND message_id = $2`, [me(req), m.id]);
      await pushUpdate(m.id);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/team/conversations/:id/read', requireAdmin, async (req, res) => {
    try {
      const id = n(req.params.id), last = n((req.body || {}).last_id) || 0;
      const r = await query(`UPDATE team_members SET last_read_id = $3 WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL AND last_read_id < $3
        AND $3 <= (SELECT COALESCE(MAX(id), 0) FROM team_messages WHERE conversation_id = $1) RETURNING 1`, [id, me(req), last]);
      if (r.rows.length) emit(await membersOf(id), 'read', { conversation_id: id, user_id: me(req), last_id: last });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/team/conversations/:id/typing', requireAdmin, async (req, res) => {
    try {
      const id = n(req.params.id);
      const members = await membersOf(id);
      if (members.includes(me(req))) emit(members.filter((u) => u !== me(req) && online(u)), 'typing', { conversation_id: id, user_id: me(req), name: await nameOf(me(req)), recording: !!(req.body || {}).recording });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/team/files/:id', requireAdmin, async (req, res) => {
    try {
      const { m, c } = await msgFor(req, n(req.params.id));
      if ((m.deleted_at && !c.oversee) || !m.file_path || !FILE_RE.test(m.file_path)) throw httpError(404, 'File not found');
      const ext = path.extname(m.file_path);
      const p = path.join(DIR, m.file_path);
      if (!fs.existsSync(p)) throw httpError(404, 'The file is no longer on this till');
      if (!c.is_member) await query(`INSERT INTO team_audit (user_id, action, conversation_id, message_id) VALUES ($1, 'opened file', $2, $3)`, [me(req), c.id, m.id]).catch(() => {});
      res.setHeader('Content-Type', TYPES[ext] || 'application/octet-stream');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      // Not on PDFs: the browser's own PDF viewer will not run under it.
      if (ext !== '.pdf') res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'");
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.setHeader('Content-Disposition', (INLINE.has(ext) && req.query.download !== '1' ? 'inline' : 'attachment') + '; filename="' + String(m.file_name || 'file' + ext).replace(/["\\\r\n]/g, '_') + '"');
      fs.createReadStream(p).pipe(res);
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------------- notices --
  // Things to tell a person even if they were away: memos, calendar invites,
  // reminders, missed calls. Shown under the bell and, while they are online,
  // as a pop-up.
  async function notice(userIds, n0) {
    const ids = [...new Set(userIds)].filter(Boolean);
    if (!ids.length) return;
    const link = /^\/[^/\\]/.test(String(n0.link || '')) ? String(n0.link).slice(0, 300) : null;   // a page of this system only
    const { rows } = await query(`INSERT INTO team_notices (user_id, kind, title, body, conversation_id, message_id, event_id, urgent, link)
      SELECT u, $2, $3, $4, $5, $6, $7, $8, $9 FROM unnest($1::int[]) u RETURNING id, user_id`,
      [ids, n0.kind, String(n0.title).slice(0, 200), n0.body ? String(n0.body).slice(0, 600) : null, n0.conversation_id || null, n0.message_id || null, n0.event_id || null, !!n0.urgent, link]);
    for (const r of rows) emit([r.user_id], 'notice', { id: r.id, kind: n0.kind, title: n0.title, body: n0.body || null, conversation_id: n0.conversation_id || null, message_id: n0.message_id ? Number(n0.message_id) : null, event_id: n0.event_id || null, urgent: !!n0.urgent, link, created_at: new Date().toISOString() });
  }
  app.get('/api/team/notices', requireAdmin, async (req, res) => {
    try {
      const { rows } = await query(`SELECT id, kind, title, body, conversation_id, message_id, event_id, urgent, link, read_at IS NOT NULL AS read,
          to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
        FROM team_notices WHERE user_id = $1 ORDER BY id DESC LIMIT 60`, [me(req)]);
      // Memos still waiting for this person's acknowledgement.
      const { rows: pend } = await query(`SELECT x.id, x.conversation_id, x.subject, u.name AS sender_name FROM team_messages x JOIN team_members m ON m.conversation_id = x.conversation_id AND m.user_id = $1 AND m.left_at IS NULL
          LEFT JOIN users u ON u.id = x.sender_id
        WHERE x.kind = 'memo' AND x.require_ack AND x.deleted_at IS NULL AND x.sender_id <> $1 AND x.created_at > NOW() - INTERVAL '60 days'
          AND NOT EXISTS (SELECT 1 FROM team_acks a WHERE a.message_id = x.id AND a.user_id = $1) ORDER BY x.id DESC LIMIT 20`, [me(req)]);
      for (const r of rows) r.message_id = r.message_id == null ? null : Number(r.message_id);
      for (const r of pend) r.id = Number(r.id);
      res.json({ notices: rows, unread: rows.filter((r) => !r.read).length, to_acknowledge: pend });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/team/notices/read', requireAdmin, async (req, res) => {
    try {
      const ids = (Array.isArray((req.body || {}).ids) ? req.body.ids : []).map(n).filter(Boolean);
      if (ids.length) await query('UPDATE team_notices SET read_at = COALESCE(read_at, NOW()) WHERE user_id = $1 AND id = ANY($2::int[])', [me(req), ids]);
      else await query('UPDATE team_notices SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL', [me(req)]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  // Announcement to every staff member: a memo in the All staff group.
  app.post('/api/team/announce', ...can('team.announce'), async (req, res) => {
    try {
      const b = req.body || {};
      const subject = t(b.subject, 160), body = t(b.body, 8000);
      if (!subject) throw httpError(400, 'Give the announcement a subject');
      const cid = await company();
      const { rows } = await query(`INSERT INTO team_messages (conversation_id, sender_id, kind, body, subject, require_ack) VALUES ($1, $2, 'memo', $3, $4, $5) RETURNING id`,
        [cid, me(req), body, subject, b.require_ack !== false]);
      await query('UPDATE team_conversations SET last_message_at = NOW() WHERE id = $1', [cid]);
      await query('UPDATE team_members SET last_read_id = GREATEST(last_read_id, $3) WHERE conversation_id = $1 AND user_id = $2', [cid, me(req), rows[0].id]);
      const members = await membersOf(cid);
      emit(members, 'msg', await oneMessage(rows[0].id, 0));
      await notice(members.filter((u) => u !== me(req)), { kind: 'memo', title: '📢 ' + subject, body: (body || '').slice(0, 300), conversation_id: cid, message_id: rows[0].id, urgent: !!b.urgent });
      res.json({ id: Number(rows[0].id), conversation_id: cid, sent_to: members.length - 1 });
    } catch (e) { fail(res, e); }
  });

  // --------------------------------------------------------------- calls --
  // Kept in memory: a call only exists while people are in it. The log and
  // the "Video call · 4 min" line in the chat are written when it ends.
  const calls = new Map();
  let callSeq = 0;
  function activeCallFor(convId) {
    for (const c of calls.values()) if (c.conversation_id === convId) return { id: c.id, media: c.media, participants: [...c.participants], started_by: c.started_by };
    return null;
  }
  const callView = (c) => ({ id: c.id, conversation_id: c.conversation_id, media: c.media, started_by: c.started_by, started_by_name: c.started_by_name, title: c.title, kind: c.kind, participants: [...c.participants] });
  async function endCall(c) {
    if (!calls.has(c.id)) return;
    calls.delete(c.id);
    clearTimeout(c.ringTimer);
    const secs = c.answered_at ? Math.round((Date.now() - c.answered_at) / 1000) : 0;
    const label = (c.media === 'video' ? 'Video call' : 'Voice call');
    const body = c.answered_at ? label + ' · ' + (secs < 60 ? secs + ' s' : Math.round(secs / 60) + ' min') : 'Missed ' + label.toLowerCase();
    await query(`UPDATE team_calls SET ended_at = NOW(), answered = $2, seconds = $3, joined = $4 WHERE id = $1`, [c.db_id, !!c.answered_at, secs, JSON.stringify([...c.everyone])]).catch(() => {});
    const { rows } = await query(`INSERT INTO team_messages (conversation_id, sender_id, kind, body, meta) VALUES ($1, $2, 'call', $3, $4) RETURNING id`,
      [c.conversation_id, c.started_by, body, JSON.stringify({ media: c.media, seconds: secs, missed: !c.answered_at, joined: [...c.everyone] })]);
    await query('UPDATE team_conversations SET last_message_at = NOW() WHERE id = $1', [c.conversation_id]);
    const members = await membersOf(c.conversation_id);
    emit(members, 'call', { type: 'ended', call: callView(c) });
    emit(members, 'msg', await oneMessage(rows[0].id, 0));
    if (!c.answered_at) await notice(members.filter((u) => u !== c.started_by && !c.declined.has(u)), { kind: 'call', title: '📞 Missed ' + label.toLowerCase() + ' from ' + c.started_by_name, conversation_id: c.conversation_id });
  }
  async function leaveCall(c, uid) {
    if (!c.participants.delete(uid)) return;
    emit([...c.participants], 'call', { type: 'left', call: callView(c), user_id: uid });
    // A one-to-one call ends when either side hangs up; a group call when the last person leaves.
    if (!c.participants.size || (c.kind === 'direct' && c.answered_at && c.participants.size < 2) || (!c.answered_at && uid === c.started_by)) await endCall(c);
  }
  async function callFor(req, id) {
    const c = calls.get(n(id));
    if (!c) throw httpError(404, 'That call has ended');
    if (!(await membersOf(c.conversation_id)).includes(me(req))) throw httpError(403, 'You are not in this conversation');
    return c;
  }
  app.post('/api/team/conversations/:id/call', requireAdmin, async (req, res) => {
    try {
      const conv = await convFor(req, n(req.params.id), 'read');
      if (!conv.is_member) throw httpError(403, 'You are not in this conversation');
      if (conv.archived_at) throw httpError(409, 'This group has been closed');
      const existing = [...calls.values()].find((x) => x.conversation_id === conv.id);
      if (existing) return res.json({ call: callView(existing), existing: true });
      const members = await membersOf(conv.id);
      const media = (req.body || {}).media === 'video' ? 'video' : 'audio';
      const myName = await nameOf(me(req));
      const title = conv.kind === 'direct' ? myName : conv.title;
      const { rows } = await query(`INSERT INTO team_calls (conversation_id, started_by, media) VALUES ($1, $2, $3) RETURNING id`, [conv.id, me(req), media]);
      const c = { id: ++callSeq, db_id: rows[0].id, conversation_id: conv.id, kind: conv.kind, media, started_by: me(req), started_by_name: myName, title,
        participants: new Set([me(req)]), everyone: new Set([me(req)]), declined: new Set(), started_at: Date.now(), answered_at: null };
      calls.set(c.id, c);
      // Nobody answers in 45 seconds: a missed call.
      c.ringTimer = setTimeout(() => { if (!c.answered_at) endCall(c).catch(() => {}); }, 45000);
      emit(members.filter((u) => u !== me(req)), 'call', { type: 'ring', call: callView(c) });
      res.json({ call: callView(c) });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/team/calls/:id/join', requireAdmin, async (req, res) => {
    try {
      const c = await callFor(req, req.params.id);
      if (!c.participants.has(me(req)) && c.participants.size >= 8) throw httpError(409, 'This call is full (8 people)');
      const others = [...c.participants].filter((u) => u !== me(req));
      c.participants.add(me(req)); c.everyone.add(me(req));
      if (!c.answered_at && others.length) { c.answered_at = Date.now(); clearTimeout(c.ringTimer); }
      emit(others, 'call', { type: 'joined', call: callView(c), user_id: me(req), name: await nameOf(me(req)) });
      // Other devices of the same person stop ringing.
      emit([me(req)], 'call', { type: 'answered-elsewhere', call: callView(c) });
      res.json({ call: callView(c), peers: others });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/team/calls/:id/leave', requireAdmin, async (req, res) => {
    try { const c = calls.get(n(req.params.id)); if (c) await leaveCall(c, me(req)); res.json({ ok: true }); } catch (e) { fail(res, e); }
  });
  app.post('/api/team/calls/:id/decline', requireAdmin, async (req, res) => {
    try {
      const c = await callFor(req, req.params.id);
      c.declined.add(me(req));
      emit([...c.participants], 'call', { type: 'declined', call: callView(c), user_id: me(req), name: await nameOf(me(req)) });
      emit([me(req)], 'call', { type: 'answered-elsewhere', call: callView(c) });
      if (c.kind === 'direct' && !c.answered_at) await endCall(c);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  // WebRTC offers, answers and network candidates between two people in the call.
  app.post('/api/team/calls/:id/signal', requireAdmin, async (req, res) => {
    try {
      const c = calls.get(n(req.params.id));
      const to = n((req.body || {}).to), data = (req.body || {}).data;
      if (!c || !c.participants.has(me(req)) || !c.participants.has(to)) throw httpError(409, 'Not in this call');
      if (!data || typeof data !== 'object' || JSON.stringify(data).length > 20000) throw httpError(400, 'Bad signal');
      emit([to], 'signal', { call_id: c.id, from: me(req), data });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/team/calls/:id/state', requireAdmin, async (req, res) => {
    try {
      const c = calls.get(n(req.params.id));
      if (!c || !c.participants.has(me(req))) throw httpError(409, 'Not in this call');
      const b = req.body || {};
      emit([...c.participants].filter((u) => u !== me(req)), 'call', { type: 'state', call: callView(c), user_id: me(req), muted: !!b.muted, camera: !!b.camera, sharing: !!b.sharing });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/team/calls/active', requireAdmin, async (req, res) => {
    try {
      const { rows } = await query('SELECT conversation_id FROM team_members WHERE user_id = $1 AND left_at IS NULL', [me(req)]);
      const mine = new Set(rows.map((r) => r.conversation_id));
      res.json({ calls: [...calls.values()].filter((c) => mine.has(c.conversation_id)).map(callView) });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------------ calendar --
  const iso = (d) => (d ? new Date(d).toISOString() : null);
  async function visibleEvent(req, id) {
    const { rows } = await query(`SELECT e.*, u.name AS created_by_name FROM team_events e LEFT JOIN users u ON u.id = e.created_by WHERE e.id = $1`, [id]);
    const e = rows[0];
    if (!e) throw httpError(404, 'Event not found');
    const att = (await query(`SELECT a.user_id, a.response, u.name FROM team_event_attendees a JOIN users u ON u.id = a.user_id WHERE a.event_id = $1 ORDER BY u.name`, [id])).rows;
    e.attendees = att;
    e.mine = e.created_by === me(req);
    const invited = att.some((a) => a.user_id === me(req));
    if (e.visibility !== 'company' && !e.mine && !invited && !(await userCan(req, 'team.oversee'))) throw httpError(404, 'Event not found');
    e.can_edit = e.mine || (await userCan(req, 'team.oversee')) || (e.visibility === 'company' && (await userCan(req, 'team.announce')));
    return e;
  }
  // Repeating events are stored once and spread over the asked-for range here.
  function occurrences(e, from, to) {
    const out = [], len = new Date(e.ends_at) - new Date(e.starts_at);
    const until = e.recur_until ? new Date(new Date(e.recur_until).getTime() + 86400000) : null;
    let s = new Date(e.starts_at), i = 0;
    while (s < to && i < 800) {
      if (until && s >= until) break;
      if (s.getTime() + len >= from.getTime()) out.push({ start: new Date(s), end: new Date(s.getTime() + len) });
      if (e.recurrence === 'daily') s = new Date(s.getTime() + 86400000);
      else if (e.recurrence === 'weekdays') { do { s = new Date(s.getTime() + 86400000); } while ([0, 6].includes(new Date(s.getTime() - 5 * 3600000).getUTCDay())); }
      else if (e.recurrence === 'weekly') s = new Date(s.getTime() + 7 * 86400000);
      else if (e.recurrence === 'monthly') { const x = new Date(e.starts_at); x.setUTCMonth(x.getUTCMonth() + (++i)); s = x; continue; }
      else break;
      i++;
    }
    return out;
  }
  // Other modules (dayplan.js) add their own items to a person's calendar.
  const extraSources = [];
  app.get('/api/team/events', requireAdmin, async (req, res) => {
    try {
      const from = new Date(String(req.query.from || '')), to = new Date(String(req.query.to || ''));
      if (isNaN(from) || isNaN(to) || to <= from || to - from > 100 * 86400000) throw httpError(400, 'Choose a date range of up to 100 days');
      const cp = await caps(req);
      const { rows } = await query(`SELECT e.*, u.name AS created_by_name,
          (SELECT a.response FROM team_event_attendees a WHERE a.event_id = e.id AND a.user_id = $1) AS my_response,
          (SELECT COUNT(*)::int FROM team_event_attendees a WHERE a.event_id = e.id) AS invited,
          (SELECT COUNT(*)::int FROM team_event_attendees a WHERE a.event_id = e.id AND a.response = 'yes') AS going
        FROM team_events e LEFT JOIN users u ON u.id = e.created_by
        WHERE e.cancelled_at IS NULL AND e.starts_at < $3 AND (e.recurrence <> 'none' OR e.ends_at >= $2) AND (e.recur_until IS NULL OR e.recur_until >= $2::date - 1)
          AND (e.visibility = 'company' OR e.created_by = $1 OR EXISTS (SELECT 1 FROM team_event_attendees a WHERE a.event_id = e.id AND a.user_id = $1) OR ($4 AND e.visibility <> 'private'))`,
        [me(req), from, to, cp.oversee]);
      const events = [];
      for (const e of rows) for (const o of occurrences(e, from, to)) {
        events.push({ id: e.id, title: e.title, kind: e.kind, location: e.location, description: e.description, all_day: e.all_day, start: o.start.toISOString(), end: o.end.toISOString(),
          visibility: e.visibility, recurrence: e.recurrence, video: e.video, conversation_id: e.conversation_id, created_by: e.created_by, created_by_name: e.created_by_name,
          my_response: e.my_response, invited: e.invited, going: e.going, mine: e.created_by === me(req) });
      }
      // Alongside: who is off, public holidays, my shifts, interviews (hiring staff).
      const extra = [];
      const { rows: lv } = await query(`SELECT l.id, u.name, l.kind, to_char(l.from_date, 'YYYY-MM-DD') AS f, to_char(l.to_date, 'YYYY-MM-DD') AS t2 FROM staff_leave l JOIN users u ON u.id = l.user_id
        WHERE l.to_date >= $1::date AND l.from_date <= $2::date`, [from, to]);
      for (const l of lv) extra.push({ source: 'leave', id: 'leave-' + l.id, title: l.name + (cp.clock || cp.hr ? ': ' + l.kind : ': off'), all_day: true, start: l.f, end: l.t2, kind: 'leave' });
      const { rows: ph } = await query(`SELECT to_char(day, 'YYYY-MM-DD') AS d, name FROM public_holidays WHERE day BETWEEN $1::date AND $2::date`, [from, to]);
      for (const h of ph) extra.push({ source: 'holiday', id: 'hol-' + h.d, title: h.name, all_day: true, start: h.d, end: h.d, kind: 'holiday' });
      const { rows: sh } = await query(`SELECT weekday, to_char(start_time, 'HH24:MI') AS s, to_char(end_time, 'HH24:MI') AS e FROM staff_shifts WHERE user_id = $1`, [me(req)]);
      if (sh.length) extra.push({ source: 'shifts', pattern: sh });
      if (cp.hr) {
        const { rows: iv } = await query(`SELECT a.id, a.name, j.title, a.interview_at FROM job_applications a LEFT JOIN job_posts j ON j.id = a.job_id
          WHERE a.interview_at BETWEEN $1 AND $2 AND a.stage = 'interview'
            AND NOT EXISTS (SELECT 1 FROM hr_interviews x JOIN team_event_attendees v ON v.event_id = x.event_id AND v.user_id = $3
              WHERE x.application_id = a.id AND x.status = 'scheduled')`, [from, to, me(req)]).catch(() => ({ rows: [] }));   // already on my calendar as the interview's event
        for (const i of iv) extra.push({ source: 'interview', id: 'iv-' + i.id, title: 'Interview: ' + (i.name || 'applicant') + (i.title ? ' (' + i.title + ')' : ''), start: iso(i.interview_at), end: iso(new Date(new Date(i.interview_at).getTime() + 45 * 60000)), kind: 'meeting', link: '/hiring.html' });
      }
      for (const f of extraSources) { try { extra.push(...(await f(req, from, to))); } catch (_) {} }
      res.json({ events, extra });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/team/events/:id', requireAdmin, async (req, res) => {
    try { const e = await visibleEvent(req, n(req.params.id)); res.json({ event: Object.assign(e, { starts_at: iso(e.starts_at), ends_at: iso(e.ends_at) }) }); } catch (e) { fail(res, e); }
  });
  function readEvent(b) {
    const title = t(b.title, 140);
    if (!title) throw httpError(400, 'Give the event a title');
    const s = new Date(b.starts_at), e = new Date(b.ends_at || b.starts_at);
    if (isNaN(s) || isNaN(e)) throw httpError(400, 'Choose when it starts and ends');
    if (e < s) throw httpError(400, 'It cannot end before it starts');
    if (e - s > 31 * 86400000) throw httpError(400, 'An event can last up to 31 days');
    const recurrence = ['none', 'daily', 'weekdays', 'weekly', 'monthly'].includes(b.recurrence) ? b.recurrence : 'none';
    const until = recurrence !== 'none' && b.recur_until && /^\d{4}-\d{2}-\d{2}$/.test(b.recur_until) ? b.recur_until : null;
    if (until && new Date(until) < new Date(s.toISOString().slice(0, 10))) throw httpError(400, 'The repeat must end after the first one');
    return { title, description: t(b.description, 4000), location: t(b.location, 160), kind: EVENT_KINDS.includes(b.kind) ? b.kind : 'meeting', all_day: !!b.all_day, starts_at: s, ends_at: e,
      visibility: ['company', 'invitees', 'private'].includes(b.visibility) ? b.visibility : 'invitees', recurrence, recur_until: until,
      remind_minutes: Math.max(0, Math.min(10080, n(b.remind_minutes) == null ? 15 : n(b.remind_minutes))), video: !!b.video,
      attendee_ids: (Array.isArray(b.attendee_ids) ? b.attendee_ids : []).map(n).filter(Boolean).slice(0, 300) };
  }
  const whenText = (ev) => {
    const o = { timeZone: 'America/Jamaica', weekday: 'short', day: 'numeric', month: 'short' };
    return new Date(ev.starts_at).toLocaleDateString('en-JM', o) + (ev.all_day ? '' : ' ' + new Date(ev.starts_at).toLocaleTimeString('en-JM', { timeZone: 'America/Jamaica', hour: 'numeric', minute: '2-digit' }));
  };
  async function inviteMail(ids, ev, verb) {
    if (!(mailer.isActive && mailer.isActive()) || !ids.length) return;
    const { rows } = await query(`SELECT email FROM users WHERE id = ANY($1::int[]) AND email IS NOT NULL AND email NOT ILIKE '%.local'`, [ids]);
    const text = ev.title + '\n' + whenText(ev) + (ev.location ? '\n' + ev.location : '') + (ev.video ? '\nOnline: join the call from the team chat.' : '') + (ev.description ? '\n\n' + ev.description : '') + '\n\nOpen the staff calendar to reply.';
    for (const r of rows) await mailer.sendEmail({ to: r.email, subject: verb + ': ' + ev.title + ' (' + whenText(ev) + ')', text }).catch(() => {});
  }
  // An online meeting gets a chat group of its own (or uses All staff), so
  // "Join" is a call in that group.
  async function eventChat(evId, ev, ids, by) {
    if (!ev.video) return null;
    if (ev.visibility === 'company') return company();
    const { rows } = await query(`SELECT conversation_id FROM team_events WHERE id = $1`, [evId]);
    let cid = rows[0] && rows[0].conversation_id;
    if (!cid) {
      cid = (await query(`INSERT INTO team_conversations (kind, title, description, created_by, event_id) VALUES ('group', $1, 'Chat and call for the calendar event', $2, $3) RETURNING id`, ['📅 ' + ev.title, by, evId])).rows[0].id;
      await query(`INSERT INTO team_members (conversation_id, user_id, role) VALUES ($1, $2, 'admin') ON CONFLICT DO NOTHING`, [cid, by]);
    }
    await addMembers(cid, ids, by);
    return cid;
  }
  async function attendeesFor(ev, by) {
    if (ev.visibility === 'company') return (await query(`SELECT u.id FROM users u WHERE ${ACTIVE}`)).rows.map((r) => r.id);
    return [...new Set(ev.attendee_ids.concat(by))];
  }
  app.post('/api/team/events', requireAdmin, async (req, res) => {
    try {
      const ev = readEvent(req.body || {});
      if (ev.visibility === 'company' && !(await userCan(req, 'team.announce'))) throw httpError(403, 'Only managers can put events on everyone’s calendar. Invite people instead.');
      const { rows } = await query(`INSERT INTO team_events (title, description, location, kind, all_day, starts_at, ends_at, visibility, recurrence, recur_until, remind_minutes, video, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [ev.title, ev.description, ev.location, ev.kind, ev.all_day, ev.starts_at, ev.ends_at, ev.visibility, ev.recurrence, ev.recur_until, ev.remind_minutes, ev.video, me(req)]);
      const id = rows[0].id;
      const ids = await attendeesFor(ev, me(req));
      if (ev.visibility !== 'company') await query(`INSERT INTO team_event_attendees (event_id, user_id, response) SELECT $1, u, CASE WHEN u = $3 THEN 'yes' ELSE 'pending' END FROM unnest($2::int[]) u ON CONFLICT DO NOTHING`, [id, ids, me(req)]);
      const cid = await eventChat(id, ev, ids, me(req));
      if (cid) await query('UPDATE team_events SET conversation_id = $2 WHERE id = $1', [id, cid]);
      const others = ids.filter((u) => u !== me(req));
      await notice(others, { kind: 'event', title: '📅 ' + (ev.visibility === 'company' ? 'New on the calendar: ' : 'Invitation: ') + ev.title, body: whenText(ev) + (ev.location ? ' · ' + ev.location : ''), event_id: id });
      emit(others, 'event', { id });
      inviteMail(others, ev, ev.visibility === 'company' ? 'Staff calendar' : 'Invitation').catch(() => {});
      res.json({ id, conversation_id: cid });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/team/events/:id', requireAdmin, async (req, res) => {
    try {
      const old = await visibleEvent(req, n(req.params.id));
      if (!old.can_edit) throw httpError(403, 'Only the person who made this event (or a manager) can change it');
      const ev = readEvent(req.body || {});
      if (ev.visibility === 'company' && old.visibility !== 'company' && !(await userCan(req, 'team.announce'))) throw httpError(403, 'Only managers can put events on everyone’s calendar');
      await query(`UPDATE team_events SET title=$2, description=$3, location=$4, kind=$5, all_day=$6, starts_at=$7, ends_at=$8, visibility=$9, recurrence=$10, recur_until=$11, remind_minutes=$12, video=$13, updated_at=NOW() WHERE id=$1`,
        [old.id, ev.title, ev.description, ev.location, ev.kind, ev.all_day, ev.starts_at, ev.ends_at, ev.visibility, ev.recurrence, ev.recur_until, ev.remind_minutes, ev.video]);
      const ids = await attendeesFor(ev, old.created_by);
      if (ev.visibility === 'company') await query('DELETE FROM team_event_attendees WHERE event_id = $1', [old.id]);
      else {
        await query('DELETE FROM team_event_attendees WHERE event_id = $1 AND NOT (user_id = ANY($2::int[]))', [old.id, ids]);
        await query(`INSERT INTO team_event_attendees (event_id, user_id) SELECT $1, u FROM unnest($2::int[]) u ON CONFLICT DO NOTHING`, [old.id, ids]);
      }
      const cid = await eventChat(old.id, ev, ids, old.created_by);
      if (cid) await query('UPDATE team_events SET conversation_id = $2 WHERE id = $1', [old.id, cid]);
      const moved = new Date(old.starts_at).getTime() !== ev.starts_at.getTime();
      if (moved) await query('DELETE FROM team_event_reminders WHERE event_id = $1', [old.id]);
      const others = ids.filter((u) => u !== me(req));
      const isNew = (u) => !old.attendees.some((a) => a.user_id === u);
      await notice(others.filter((u) => moved || isNew(u)), { kind: 'event', title: '📅 ' + (moved ? 'Moved: ' : 'Invitation: ') + ev.title, body: whenText(ev), event_id: old.id });
      emit(others, 'event', { id: old.id });
      if (moved) inviteMail(others, ev, 'Changed').catch(() => {});
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.delete('/api/team/events/:id', requireAdmin, async (req, res) => {
    try {
      const old = await visibleEvent(req, n(req.params.id));
      if (!old.can_edit) throw httpError(403, 'Only the person who made this event (or a manager) can cancel it');
      await query('UPDATE team_events SET cancelled_at = NOW() WHERE id = $1', [old.id]);
      const ids = old.visibility === 'company' ? (await query(`SELECT u.id FROM users u WHERE ${ACTIVE}`)).rows.map((r) => r.id) : old.attendees.map((a) => a.user_id);
      const others = ids.filter((u) => u !== me(req));
      if (new Date(old.ends_at) > new Date() || old.recurrence !== 'none') await notice(others, { kind: 'event', title: '📅 Cancelled: ' + old.title, body: whenText(old), event_id: old.id });
      emit(others, 'event', { id: old.id });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/team/events/:id/rsvp', requireAdmin, async (req, res) => {
    try {
      const e = await visibleEvent(req, n(req.params.id));
      const r = (req.body || {}).response;
      if (!['yes', 'no', 'maybe'].includes(r)) throw httpError(400, 'Choose yes, no or maybe');
      if (e.visibility === 'company') await query(`INSERT INTO team_event_attendees (event_id, user_id, response) VALUES ($1, $2, $3) ON CONFLICT (event_id, user_id) DO UPDATE SET response = EXCLUDED.response`, [e.id, me(req), r]);
      else {
        const u = await query(`UPDATE team_event_attendees SET response = $3 WHERE event_id = $1 AND user_id = $2 RETURNING 1`, [e.id, me(req), r]);
        if (!u.rows.length) throw httpError(403, 'You were not invited to this');
      }
      if (e.created_by && e.created_by !== me(req) && r !== 'yes') await notice([e.created_by], { kind: 'event', title: (await nameOf(me(req))) + (r === 'no' ? ' can’t make ' : ' might make ') + e.title, event_id: e.id });
      emit([e.created_by], 'event', { id: e.id });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  // Reminders, once a minute: each occurrence that starts within its reminder
  // window, once per person.
  async function reminders() {
    try {
      const now = new Date(), ahead = new Date(now.getTime() + 7 * 86400000);
      const { rows } = await query(`SELECT * FROM team_events WHERE cancelled_at IS NULL AND remind_minutes > 0 AND starts_at < $1 AND (recurrence <> 'none' OR starts_at > NOW() - INTERVAL '1 hour')
        AND (recur_until IS NULL OR recur_until >= CURRENT_DATE - 1)`, [ahead]);
      for (const e of rows) for (const o of occurrences(e, now, ahead)) {
        if (o.start <= now || o.start - now > e.remind_minutes * 60000) continue;
        const ins = await query(`INSERT INTO team_event_reminders (event_id, occurs_at) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING 1`, [e.id, o.start]);
        if (!ins.rows.length) continue;
        const ids = e.visibility === 'company' ? (await query(`SELECT u.id FROM users u WHERE ${ACTIVE}`)).rows.map((r) => r.id)
          : (await query(`SELECT user_id FROM team_event_attendees WHERE event_id = $1 AND response <> 'no'`, [e.id])).rows.map((r) => r.user_id);
        const mins = Math.round((o.start - now) / 60000);
        await notice(ids, { kind: 'reminder', title: '⏰ ' + e.title + (e.all_day ? ' today' : ' in ' + (mins >= 120 ? Math.round(mins / 60) + ' hours' : mins + ' min')), body: e.location || (e.video ? 'Online: join from the team chat' : null), event_id: e.id, conversation_id: e.conversation_id, urgent: true });
      }
      await query(`DELETE FROM team_event_reminders WHERE occurs_at < NOW() - INTERVAL '2 days'`);
    } catch (e) { if (!/does not exist/.test(e.message)) console.warn('[team] reminders', e.message); }
  }
  setInterval(reminders, 60000).unref();

  // ----------------------------------------------------------- emergency --
  // The staff 911: anyone signed in can raise one. It sounds on every staff
  // screen until each person answers (safe, on my way, need help), shows who
  // has answered, goes into All staff and everyone's alerts, and by text and
  // email when those are set up. It stays up until the person who raised it
  // or a manager (team.announce) gives the all clear or calls it a false alarm.
  // A silent one (a robbery) shows a small banner with no siren.
  const EMERGENCY = { fire: '🔥 Fire', medical: '🚑 Medical emergency', robbery: '🚨 Robbery / armed threat', evacuate: '🚪 Evacuate now', other: '⚠️ Emergency' };
  const REPLIES = ['safe', 'responding', 'help'];
  const raisedBy = new Map();   // userId -> recent raise times, to stop a stuck button flooding everyone
  const staffIds = async () => (await query(`SELECT u.id FROM users u WHERE ${ACTIVE}`)).rows.map((r) => r.id);
  async function emergencyView(id) {
    const { rows } = await query(`SELECT e.id, e.kind, e.location, e.details, e.silent, e.raised_by, e.outcome, e.end_note, u.name AS raised_by_name, eu.name AS ended_by_name,
        to_char(e.raised_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS raised_at, to_char(e.ended_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ended_at
      FROM team_emergencies e LEFT JOIN users u ON u.id = e.raised_by LEFT JOIN users eu ON eu.id = e.ended_by WHERE e.id = $1`, [id]);
    const e = rows[0];
    if (!e) return null;
    // Everyone on the staff list (and anyone who answered since leaving it), the
    // ones who need help first, then those clocked in who have not answered.
    const { rows: people } = await query(`SELECT u.id, u.name, COALESCE(ro.label, u.admin_role) AS role, r.status, r.note,
        to_char(r.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at,
        EXISTS (SELECT 1 FROM attendance a WHERE a.user_id = u.id AND a.clock_out_at IS NULL AND a.clock_in_at > NOW() - INTERVAL '16 hours') AS clocked_in
      FROM users u LEFT JOIN roles ro ON ro.code = u.admin_role LEFT JOIN team_emergency_replies r ON r.emergency_id = $1 AND r.user_id = u.id
      WHERE (${ACTIVE}) OR r.user_id IS NOT NULL
      ORDER BY CASE r.status WHEN 'help' THEN 0 WHEN 'responding' THEN 3 WHEN 'safe' THEN 4 ELSE 1 END, (r.status IS NULL AND EXISTS (SELECT 1 FROM attendance a WHERE a.user_id = u.id AND a.clock_out_at IS NULL AND a.clock_in_at > NOW() - INTERVAL '16 hours')) DESC, u.name`, [id]);
    for (const p of people) p.online = online(p.id);
    const count = (s) => people.filter((p) => p.status === s).length;
    return Object.assign(e, { label: EMERGENCY[e.kind] || EMERGENCY.other, people,
      counts: { safe: count('safe'), responding: count('responding'), help: count('help'), none: people.filter((p) => !p.status).length } });
  }
  async function emergencyFor(req, id) {
    const e = await emergencyView(id);
    if (!e) throw httpError(404, 'Emergency not found');
    e.can_end = e.raised_by === me(req) || (await userCan(req, 'team.announce'));
    return e;
  }
  // Text and email go to staff who are not at a screen. Neither is waited for.
  function emergencyOut(ids, subject, text) {
    (async () => {
      const { rows } = await query(`SELECT phone, email FROM users WHERE id = ANY($1::int[])`, [ids]);
      if (sms.isActive()) for (const r of rows) if (r.phone && String(r.phone).replace(/\D/g, '').length >= 7) sms.sendSMS({ to: r.phone, body: (subject + ': ' + text).slice(0, 300) }).catch(() => {});
      if (mailer.isActive && mailer.isActive()) for (const r of rows) if (r.email && !/\.local$/i.test(r.email)) mailer.sendEmail({ to: r.email, subject, text: text + '\n\nOpen the staff screens to answer.' }).catch(() => {});
    })().catch((e) => console.warn('[team] emergency text/email', e.message));
  }
  app.get('/api/team/emergency', requireAdmin, async (req, res) => {
    try {
      const { rows } = await query(`SELECT id FROM team_emergencies WHERE ended_at IS NULL ORDER BY id`);
      const list = [];
      for (const r of rows) list.push(await emergencyFor(req, r.id));
      res.json({ emergencies: list });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/team/emergency', requireAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      const kind = EMERGENCY[b.kind] ? b.kind : null;
      if (!kind) throw httpError(400, 'Choose what kind of emergency it is');
      // Several people pressing it for the same thing: they all join the first one.
      const { rows: same } = await query(`SELECT id FROM team_emergencies WHERE ended_at IS NULL AND kind = $1 AND raised_at > NOW() - INTERVAL '10 minutes' ORDER BY id DESC LIMIT 1`, [kind]);
      if (same.length) return res.json({ emergency: await emergencyFor(req, same[0].id), existing: true });
      const recent = (raisedBy.get(me(req)) || []).filter((x) => Date.now() - x < 10 * 60000);
      if (recent.length >= 3) throw httpError(429, 'You have raised 3 emergencies in 10 minutes. Ask a manager to give the all clear first.');
      raisedBy.set(me(req), recent.concat(Date.now()));
      const location = t(b.location, 120), details = t(b.details, 600);
      const { rows } = await query(`INSERT INTO team_emergencies (kind, location, details, silent, raised_by, raised_ip) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [kind, location, details, !!b.silent, me(req), String(req.ip || '').slice(0, 60)]);
      const id = rows[0].id;
      const ev = await emergencyFor(req, id);
      const ids = await staffIds();
      emit(ids, 'emergency', { type: 'raised', emergency: ev });
      const where = [location, details].filter(Boolean).join(' · ');
      const others = ids.filter((u) => u !== me(req));
      await notice(others, { kind: 'emergency', title: ev.label + ' (raised by ' + ev.raised_by_name + ')', body: where || null, urgent: true });
      await systemMsg(await company(), me(req), '🚨 EMERGENCY: ' + ev.label + (where ? ' · ' + where : '') + '. Raised by ' + ev.raised_by_name + '.').catch(() => {});
      await query(`INSERT INTO team_audit (user_id, action, detail) VALUES ($1, 'raised emergency', $2)`, [me(req), ev.label + (where ? ': ' + where : '')]).catch(() => {});
      emergencyOut(others, 'EMERGENCY at Morty\'s Auto: ' + ev.label.replace(/^\S+\s/, ''), (where ? where + '. ' : '') + 'Raised by ' + ev.raised_by_name + '.');
      res.json({ emergency: ev });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/team/emergency/:id/reply', requireAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      if (!REPLIES.includes(b.status)) throw httpError(400, 'Choose safe, on my way or need help');
      const { rows } = await query(`SELECT id FROM team_emergencies WHERE id = $1 AND ended_at IS NULL`, [n(req.params.id)]);
      if (!rows.length) throw httpError(409, 'This emergency is over');
      await query(`INSERT INTO team_emergency_replies (emergency_id, user_id, status, note) VALUES ($1, $2, $3, $4)
        ON CONFLICT (emergency_id, user_id) DO UPDATE SET status = EXCLUDED.status, note = EXCLUDED.note, at = NOW()`, [rows[0].id, me(req), b.status, t(b.note, 300)]);
      const ev = await emergencyFor(req, rows[0].id);
      emit(await staffIds(), 'emergency', { type: 'update', emergency: ev });
      res.json({ emergency: ev });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/team/emergency/:id/end', requireAdmin, async (req, res) => {
    try {
      const ev = await emergencyFor(req, n(req.params.id));
      if (ev.ended_at) throw httpError(409, 'This emergency is already over');
      if (!ev.can_end) throw httpError(403, 'Only the person who raised it or a manager can give the all clear');
      const b = req.body || {}, outcome = b.outcome === 'false_alarm' ? 'false_alarm' : 'all_clear';
      await query(`UPDATE team_emergencies SET ended_at = NOW(), ended_by = $2, outcome = $3, end_note = $4 WHERE id = $1 AND ended_at IS NULL`, [ev.id, me(req), outcome, t(b.note, 300)]);
      const done = await emergencyFor(req, ev.id);
      const ids = await staffIds();
      emit(ids, 'emergency', { type: 'ended', emergency: done });
      const line = (outcome === 'false_alarm' ? 'False alarm: ' : 'All clear: ') + done.label.replace(/^\S+\s/, '') + (done.end_note ? ' · ' + done.end_note : '') + ' (' + done.ended_by_name + ')';
      const others = ids.filter((u) => u !== me(req));
      await notice(others, { kind: 'emergency', title: '✅ ' + line });
      await systemMsg(await company(), me(req), '✅ ' + line).catch(() => {});
      emergencyOut(others, 'Morty\'s Auto: ' + (outcome === 'false_alarm' ? 'false alarm' : 'all clear'), line);
      res.json({ emergency: done });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/team/admin/emergencies', ...can('team.oversee'), async (req, res) => {
    try {
      const { rows } = await query(`SELECT e.id, e.kind, e.location, e.details, e.silent, e.outcome, e.end_note, e.raised_ip, u.name AS raised_by_name, eu.name AS ended_by_name,
          to_char(e.raised_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS raised_at, to_char(e.ended_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ended_at,
          (SELECT COUNT(*)::int FROM team_emergency_replies r WHERE r.emergency_id = e.id AND r.status = 'safe') AS safe,
          (SELECT COUNT(*)::int FROM team_emergency_replies r WHERE r.emergency_id = e.id AND r.status = 'responding') AS responding,
          (SELECT COUNT(*)::int FROM team_emergency_replies r WHERE r.emergency_id = e.id AND r.status = 'help') AS help,
          (SELECT string_agg(ru.name || ': ' || r.status || COALESCE(' (' || r.note || ')', ''), ', ' ORDER BY r.at) FROM team_emergency_replies r JOIN users ru ON ru.id = r.user_id WHERE r.emergency_id = e.id) AS replies
        FROM team_emergencies e LEFT JOIN users u ON u.id = e.raised_by LEFT JOIN users eu ON eu.id = e.ended_by ORDER BY e.id DESC LIMIT 200`);
      for (const r of rows) r.label = EMERGENCY[r.kind] || EMERGENCY.other;
      res.json({ emergencies: rows });
    } catch (e) { fail(res, e); }
  });

  // ---------------------------------------------------------- management --
  app.get('/api/team/admin/overview', ...can('team.oversee'), async (req, res) => {
    try {
      await company();
      const { rows: s } = await query(`SELECT
          (SELECT COUNT(*)::int FROM team_messages WHERE created_at > CURRENT_DATE AND kind IN ('text','file','memo')) AS msgs_today,
          (SELECT COUNT(*)::int FROM team_messages WHERE created_at > NOW() - INTERVAL '7 days' AND kind IN ('text','file','memo')) AS msgs_week,
          (SELECT COUNT(*)::int FROM team_conversations WHERE kind = 'group' AND archived_at IS NULL) AS groups,
          (SELECT COUNT(*)::int FROM team_conversations WHERE kind = 'direct' AND last_message_at IS NOT NULL) AS directs,
          (SELECT COUNT(*)::int FROM team_calls WHERE started_at > CURRENT_DATE) AS calls_today,
          (SELECT COUNT(*)::int FROM team_messages WHERE deleted_at > NOW() - INTERVAL '7 days') AS deleted_week,
          (SELECT COUNT(*)::int FROM users u WHERE ${ACTIVE}) AS staff`);
      res.json(Object.assign(s[0], { online: [...new Set([...streams.keys(), ...polled.keys()])].filter(online).length, live_calls: [...calls.values()].map(callView) }));
    } catch (e) { fail(res, e); }
  });
  app.get('/api/team/admin/conversations', ...can('team.oversee'), async (req, res) => {
    try {
      const q = t(req.query.q, 80), kind = ['direct', 'group', 'company'].includes(req.query.kind) ? req.query.kind : null;
      const args = []; const where = [];
      if (kind) { args.push(kind); where.push('c.kind = $' + args.length); }
      if (q) { args.push('%' + q + '%'); where.push(`(c.title ILIKE $${args.length} OR EXISTS (SELECT 1 FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.conversation_id = c.id AND u.name ILIKE $${args.length}))`); }
      where.push(`(c.kind <> 'direct' OR c.last_message_at IS NOT NULL)`);
      const { rows } = await query(`SELECT c.id, c.kind, c.title, c.archived_at IS NOT NULL AS archived, c.only_admins_post,
          to_char(COALESCE(c.last_message_at, c.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_at,
          (SELECT COUNT(*)::int FROM team_messages x WHERE x.conversation_id = c.id AND x.kind IN ('text','file','memo')) AS messages,
          (SELECT COUNT(*)::int FROM team_messages x WHERE x.conversation_id = c.id AND x.deleted_at IS NOT NULL) AS deleted,
          (SELECT string_agg(u.name, ', ' ORDER BY u.name) FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.conversation_id = c.id AND m.left_at IS NULL) AS members,
          (SELECT COUNT(*)::int FROM team_members m WHERE m.conversation_id = c.id AND m.left_at IS NULL) AS member_count
        FROM team_conversations c ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY COALESCE(c.last_message_at, c.created_at) DESC LIMIT 300`, args);
      for (const r of rows) { if (r.kind === 'direct') r.title = r.members || 'One-to-one'; if (r.kind === 'company') r.members = r.member_count + ' staff'; r.call = activeCallFor(r.id); }
      res.json({ conversations: rows });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/team/admin/search', ...can('team.oversee'), async (req, res) => {
    try {
      const q = t(req.query.q, 100), from = t(req.query.from, 10), to = t(req.query.to, 10), who = n(req.query.user);
      if (!q && !who) throw httpError(400, 'Type something to search for, or choose a person');
      const args = [], where = [`x.kind IN ('text','file','memo')`];
      if (q) { args.push('%' + q + '%'); where.push(`(x.body ILIKE $${args.length} OR x.subject ILIKE $${args.length} OR x.original_body ILIKE $${args.length} OR x.file_name ILIKE $${args.length})`); }
      if (who) { args.push(who); where.push('x.sender_id = $' + args.length); }
      if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) { args.push(from); where.push('x.created_at >= $' + args.length + '::date'); }
      if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) { args.push(to); where.push('x.created_at < $' + args.length + '::date + 1'); }
      const { rows } = await query(`SELECT x.id, x.conversation_id, x.kind, x.body, x.subject, x.file_name, x.original_body, x.deleted_at IS NOT NULL AS deleted, x.edited_at IS NOT NULL AS edited,
          to_char(x.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at, u.name AS sender_name, c.kind AS conv_kind,
          CASE WHEN c.kind = 'direct' THEN (SELECT string_agg(mu.name, ' ↔ ' ORDER BY mu.name) FROM team_members m JOIN users mu ON mu.id = m.user_id WHERE m.conversation_id = c.id) ELSE c.title END AS conv_title
        FROM team_messages x JOIN team_conversations c ON c.id = x.conversation_id LEFT JOIN users u ON u.id = x.sender_id
        WHERE ${where.join(' AND ')} ORDER BY x.id DESC LIMIT 200`, args);
      await query(`INSERT INTO team_audit (user_id, action, detail) VALUES ($1, 'searched', $2)`, [me(req), [q, who ? 'person #' + who : null, from, to].filter(Boolean).join(' · ')]).catch(() => {});
      for (const r of rows) r.id = Number(r.id);
      res.json({ results: rows });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/team/admin/memos', ...can('team.oversee'), async (req, res) => {
    try {
      const { rows } = await query(`SELECT x.id, x.conversation_id, x.subject, x.require_ack, u.name AS sender_name, c.title AS conv_title,
          to_char(x.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
          (SELECT COUNT(*)::int FROM team_members m WHERE m.conversation_id = x.conversation_id AND m.left_at IS NULL AND m.user_id <> x.sender_id) AS recipients,
          (SELECT COUNT(*)::int FROM team_acks a WHERE a.message_id = x.id) AS acks,
          (SELECT COUNT(*)::int FROM team_members m WHERE m.conversation_id = x.conversation_id AND m.left_at IS NULL AND m.user_id <> x.sender_id
             AND (m.last_read_id >= x.id OR EXISTS (SELECT 1 FROM team_acks a WHERE a.message_id = x.id AND a.user_id = m.user_id))) AS seen,
          (SELECT string_agg(mu.name, ', ' ORDER BY mu.name) FROM team_members m JOIN users mu ON mu.id = m.user_id WHERE m.conversation_id = x.conversation_id AND m.left_at IS NULL AND m.user_id <> x.sender_id
             AND NOT EXISTS (SELECT 1 FROM team_acks a WHERE a.message_id = x.id AND a.user_id = m.user_id)) AS waiting
        FROM team_messages x JOIN team_conversations c ON c.id = x.conversation_id LEFT JOIN users u ON u.id = x.sender_id
        WHERE x.kind = 'memo' AND x.deleted_at IS NULL ORDER BY x.id DESC LIMIT 100`);
      for (const r of rows) r.id = Number(r.id);
      res.json({ memos: rows });
    } catch (e) { fail(res, e); }
  });
  // Remind everyone who has not acknowledged a memo yet.
  app.post('/api/team/admin/memos/:id/nudge', ...can('team.oversee'), async (req, res) => {
    try {
      const { rows } = await query(`SELECT x.id, x.subject, x.conversation_id FROM team_messages x WHERE x.id = $1 AND x.kind = 'memo' AND x.deleted_at IS NULL`, [n(req.params.id)]);
      if (!rows.length) throw httpError(404, 'Memo not found');
      const x = rows[0];
      const { rows: w } = await query(`SELECT m.user_id FROM team_members m JOIN team_messages x ON x.id = $1 WHERE m.conversation_id = x.conversation_id AND m.left_at IS NULL AND m.user_id <> x.sender_id
        AND NOT EXISTS (SELECT 1 FROM team_acks a WHERE a.message_id = x.id AND a.user_id = m.user_id)`, [x.id]);
      await notice(w.map((r) => r.user_id), { kind: 'memo', title: '📢 Please read and acknowledge: ' + x.subject, conversation_id: x.conversation_id, message_id: x.id, urgent: true });
      res.json({ reminded: w.length });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/team/admin/calls', ...can('team.oversee'), async (req, res) => {
    try {
      const { rows } = await query(`SELECT k.id, k.media, k.answered, k.seconds, k.joined, u.name AS started_by_name, k.conversation_id,
          to_char(k.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS started_at, k.ended_at IS NULL AS live,
          CASE WHEN c.kind = 'direct' THEN (SELECT string_agg(mu.name, ' ↔ ' ORDER BY mu.name) FROM team_members m JOIN users mu ON mu.id = m.user_id WHERE m.conversation_id = c.id) ELSE c.title END AS conv_title
        FROM team_calls k JOIN team_conversations c ON c.id = k.conversation_id LEFT JOIN users u ON u.id = k.started_by ORDER BY k.id DESC LIMIT 200`);
      const { rows: names } = await query(`SELECT id, name FROM users WHERE id = ANY($1::int[])`, [[...new Set(rows.flatMap((r) => r.joined || []))]]);
      const nm = new Map(names.map((r) => [r.id, r.name]));
      for (const r of rows) r.joined_names = (r.joined || []).map((id) => nm.get(id) || '#' + id).join(', ');
      res.json({ calls: rows });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/team/admin/audit', ...can('team.oversee'), async (req, res) => {
    try {
      const { rows } = await query(`SELECT a.id, a.action, a.detail, a.conversation_id, a.message_id, u.name, to_char(a.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at,
          CASE WHEN c.kind = 'direct' THEN (SELECT string_agg(mu.name, ' ↔ ' ORDER BY mu.name) FROM team_members m JOIN users mu ON mu.id = m.user_id WHERE m.conversation_id = c.id) ELSE c.title END AS conv_title
        FROM team_audit a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN team_conversations c ON c.id = a.conversation_id ORDER BY a.id DESC LIMIT 300`);
      for (const r of rows) r.message_id = r.message_id == null ? null : Number(r.message_id);
      res.json({ entries: rows });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/team/admin/conversations/:id/export', ...can('team.oversee'), async (req, res) => {
    try {
      const id = n(req.params.id);
      const { rows: c } = await query('SELECT kind, title FROM team_conversations WHERE id = $1', [id]);
      if (!c.length) throw httpError(404, 'Conversation not found');
      const { rows } = await query(`SELECT to_char(x.created_at AT TIME ZONE 'America/Jamaica', 'YYYY-MM-DD HH24:MI') AS at, u.name, x.kind, x.subject, COALESCE(x.body, '') AS body, x.original_body, x.file_name,
          x.edited_at IS NOT NULL AS edited, x.deleted_at IS NOT NULL AS deleted FROM team_messages x LEFT JOIN users u ON u.id = x.sender_id WHERE x.conversation_id = $1 ORDER BY x.id`, [id]);
      const cell = (v) => { const s = String(v == null ? '' : v); return /[",\n\r]|^[=+\-@]/.test(s) ? '"' + (/^[=+\-@]/.test(s) ? "'" : '') + s.replace(/"/g, '""') + '"' : s; };
      const csv = ['When (Jamaica),From,Type,Subject,Message,Original wording,File,Edited,Deleted']
        .concat(rows.map((r) => [r.at, r.name, r.kind, r.subject, r.body, r.edited ? r.original_body : '', r.file_name, r.edited ? 'yes' : '', r.deleted ? 'yes' : ''].map(cell).join(','))).join('\r\n');
      await query(`INSERT INTO team_audit (user_id, action, conversation_id) VALUES ($1, 'exported', $2)`, [me(req), id]).catch(() => {});
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="chat-' + id + '.csv"');
      res.send('﻿' + csv);
    } catch (e) { fail(res, e); }
  });

  // Messages older than the retention setting (when one is set) are removed,
  // with their files. Memos are kept.
  async function retention() {
    try {
      const d = parseInt(await setting('team_retention_days', '0'), 10) || 0;
      if (!d) return;
      const { rows } = await query(`DELETE FROM team_messages WHERE created_at < NOW() - make_interval(days => $1) AND kind <> 'memo' RETURNING file_path`, [d]);
      for (const r of rows) if (r.file_path && FILE_RE.test(r.file_path)) { try { fs.unlinkSync(path.join(DIR, r.file_path)); } catch (_) {} }
      await query(`DELETE FROM team_notices WHERE created_at < NOW() - make_interval(days => $1)`, [d]);
    } catch (e) { if (!/does not exist/.test(e.message)) console.warn('[team] retention', e.message); }
  }
  setTimeout(retention, 90000).unref(); setInterval(retention, 6 * 3600000).unref();

  return { notice, emit, online, useExtra(fn) { extraSources.push(fn); } };
}

module.exports = { register };
