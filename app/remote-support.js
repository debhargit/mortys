// =============================================================================
//  Vision Auto Solutions -- Remote support with Chrome Remote Desktop
//
//    require('./remote-support').register(app, { query, requireAdmin, requireCap,
//      userCan, mailer, devMode, sysops, permState })      (after sysops.js)
//
//  Part of the IT help desk in System management (system.html, "Remote help").
//  Google's Chrome Remote Desktop does the actual screen sharing; Vision keeps
//  it controlled and on the record:
//
//    one-time help   a staff member (support.raise) opens remotedesktop.google.com/
//                    support on their PC, makes a 12-digit code and shares it HERE
//                    on a ticket (never by phone). Only people with sys.support see
//                    the code; it is wiped when used or after 5 minutes.
//    unattended      a PC / till / server set up with the shop's Google account so
//                    IT can reach it with a PIN when nobody is there. Turning that
//                    on for a device needs sys.security, and the shop must allow it.
//    colleagues      any back-office user can pick a colleague to help them, or offer
//                    to help a colleague; only that colleague sees the code (IT does not).
//                    The owner can switch this off (Settings: staff help each other).
//    log             every session: ticket, device, who asked, who connected,
//                    start / end, what was done. Also written to the audit trail.
//
//  Tables are created on first use (never at startup: see the boot deadlock note).
// =============================================================================
'use strict';

const path = require('path');
const fs = require('fs');

const CODE_MINUTES = 5;                                 // Google's support codes die after 5 minutes unused
const MODES = ['off', 'on_request', 'unattended'];
const S_STATUS = ['offered', 'waiting', 'connected', 'ended', 'expired', 'cancelled'];
const DEVICE_KINDS = ['pc', 'till', 'server', 'tablet'];
const SETTINGS = {                                      // warehouse_settings key -> default
  remote_enabled: '1',
  remote_unattended_allowed: '0',
  remote_file_transfer: '1',
  remote_provider_name: '',
  remote_provider_phone: '',
  remote_provider_email: '',
  remote_note: '',
  remote_peer_help: '1',
};

const DDL = `
CREATE TABLE IF NOT EXISTS sys_remote_sessions (
  id               SERIAL PRIMARY KEY,
  ticket_id        INTEGER REFERENCES sys_tickets(id) ON DELETE SET NULL,
  asset_id         INTEGER REFERENCES sys_assets(id) ON DELETE SET NULL,
  computer         TEXT,                              -- what the person called the PC, if no device picked
  kind             TEXT NOT NULL DEFAULT 'code' CHECK (kind IN ('code', 'unattended')),
  requester_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  technician_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  helper_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,   -- a colleague asked (or offering) to help; NULL = IT
  code             TEXT,                              -- 12-digit one-time code; wiped once used or expired
  code_expires_at  TIMESTAMPTZ,
  status           TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('offered', 'waiting', 'connected', 'ended', 'expired', 'cancelled')),
  reason           TEXT,
  outcome          TEXT,
  ended_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ip               TEXT,
  started_at       TIMESTAMPTZ,
  ended_at         TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sys_remote_sessions_status ON sys_remote_sessions (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sys_remote_sessions_helper ON sys_remote_sessions (helper_id, status);
CREATE TABLE IF NOT EXISTS sys_remote_devices (
  asset_id         INTEGER PRIMARY KEY REFERENCES sys_assets(id) ON DELETE CASCADE,
  mode             TEXT NOT NULL DEFAULT 'on_request' CHECK (mode IN ('off', 'on_request', 'unattended')),
  host_name        TEXT,                              -- the name it shows in remotedesktop.google.com/access
  google_account   TEXT,                              -- the Google account that owns the unattended host
  installed        BOOLEAN NOT NULL DEFAULT FALSE,
  notes            TEXT,
  updated_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);`;

function register(app, deps) {
  const { query, requireAdmin, requireCap, userCan, mailer, devMode, sysops, permState } = deps;
  const SUP = [requireAdmin, requireCap('sys.support')];
  const SEC = [requireAdmin, requireCap('sys.security')];

  let readyP = null;                                     // lazy DDL, retried if it failed
  const ready = () => (readyP = readyP || query(DDL).catch((e) => { readyP = null; throw e; }));

  const txt = (v, max) => { const s = String(v == null ? '' : v).trim(); return s ? s.slice(0, max || 200) : null; };
  const ipOf = (req) => String((req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.ip || '')).split(',')[0].trim().slice(0, 60);
  function httpError(status, msg) { const e = new Error(msg); e.status = status; e.publicMessage = msg; return e; }
  function fail(res, e) { const s = e.status || 500; if (s >= 500) console.error('[remote-support]', e); res.status(s).json({ error: e.publicMessage || e.message }); }
  const audit = (req, action, detail) => (sysops && sysops.audit ? sysops.audit(req, action, detail) : Promise.resolve());
  const send = (to, subject, text) => { if (!devMode && mailer && mailer.sendEmail && to && !/\.local$/i.test(to)) mailer.sendEmail({ to, subject, text }).catch(() => {}); };
  async function userCanId(uid, cap) { try { const st = await permState(uid); return st.full || !!st.perms[cap]; } catch (_) { return false; } }
  async function nameOf(uid) { const { rows } = await query(`SELECT name FROM users WHERE id = $1`, [uid]); return (rows[0] && rows[0].name) || 'Someone'; }

  async function settings() {
    const { rows } = await query(`SELECT key, value FROM warehouse_settings WHERE key = ANY($1)`, [Object.keys(SETTINGS)]);
    const s = Object.assign({}, SETTINGS);
    for (const r of rows) if (r.value != null) s[r.key] = r.value;
    return {
      enabled: s.remote_enabled !== '0', unattended_allowed: s.remote_unattended_allowed === '1', file_transfer: s.remote_file_transfer !== '0',
      provider_name: s.remote_provider_name, provider_phone: s.remote_provider_phone, provider_email: s.remote_provider_email, note: s.remote_note, peer_help: s.remote_peer_help !== '0',
    };
  }
  const putSetting = (k, v) => query(`INSERT INTO warehouse_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [k, String(v)]);

  // Codes nobody used in time are dead at Google's end too: expire them and wipe the digits.
  async function sweep() {
    await query(`UPDATE sys_remote_sessions SET status = 'expired', code = NULL, ended_at = NOW() WHERE status = 'waiting' AND code_expires_at < NOW()`);
    await query(`UPDATE sys_remote_sessions SET status = 'expired', ended_at = NOW() WHERE status = 'offered' AND created_at < NOW() - INTERVAL '30 minutes'`);
    // A session left "connected" for 12 hours was surely forgotten: close it on the record.
    await query(`UPDATE sys_remote_sessions SET status = 'ended', code = NULL, ended_at = NOW(), outcome = COALESCE(outcome, 'Closed automatically after 12 hours') WHERE status = 'connected' AND started_at < NOW() - INTERVAL '12 hours'`);
  }
  async function techEmails() {
    const { rows } = await query(`SELECT id, email FROM users WHERE NOT disabled AND is_admin AND email IS NOT NULL`);
    const out = [];
    for (const t of rows) if (await userCanId(t.id, 'sys.support')) out.push(t.email);
    const s = await settings();
    if (s.provider_email) out.push(s.provider_email);
    return [...new Set(out)];
  }
  async function ticketNote(ticketId, uid, body, internal) {
    if (!ticketId) return;
    await query(`INSERT INTO sys_ticket_notes (ticket_id, user_id, body, internal) VALUES ($1,$2,$3,$4)`, [ticketId, uid, body, !!internal]);
    await query(`UPDATE sys_tickets SET updated_at = NOW() WHERE id = $1`, [ticketId]);
  }
  const SESSION_SELECT = `s.id, s.ticket_id, s.asset_id, s.computer, s.kind, s.requester_id, s.technician_id, s.code_expires_at, s.status, s.reason, s.outcome, s.started_at, s.ended_at, s.created_at,
       r.name AS requester_name, tc.name AS technician_name, hp.name AS helper_name, s.helper_id, a.tag AS asset_tag, a.name AS asset_name, t.number AS ticket_number, t.title AS ticket_title,
       GREATEST(0, EXTRACT(EPOCH FROM (s.code_expires_at - NOW())))::int AS seconds_left
     FROM sys_remote_sessions s LEFT JOIN users r ON r.id = s.requester_id LEFT JOIN users tc ON tc.id = s.technician_id LEFT JOIN users hp ON hp.id = s.helper_id
       LEFT JOIN sys_assets a ON a.id = s.asset_id LEFT JOIN sys_tickets t ON t.id = s.ticket_id`;

  // ------------------------------------------------------------------ read --
  app.get('/api/sys/remote', requireAdmin, async (req, res) => {
    try {
      await ready();
      const [support, raise, security] = await Promise.all(['sys.support', 'support.raise', 'sys.security'].map((k) => userCan(req, k)));
      if (!support && !raise) throw httpError(403, 'Not allowed');
      await sweep();
      const s = await settings();
      const uid = req.session.userId;
      const out = { support, raise, security, settings: s, code_minutes: CODE_MINUTES };
      const { rows: mine } = await query(`SELECT ${SESSION_SELECT} WHERE s.requester_id = $1 ORDER BY s.id DESC LIMIT 20`, [uid]);
      out.mine = mine;
      const { rows: tickets } = await query(`SELECT id, number, title FROM sys_tickets WHERE status NOT IN ('resolved', 'closed') AND (requester_id = $1 OR $2) ORDER BY id DESC LIMIT 60`, [uid, support]);
      out.tickets = tickets;
      const { rows: assets } = await query(`SELECT a.id, a.tag, a.name, a.kind, a.location, a.ip, d.mode, d.host_name, d.google_account, d.installed, d.notes, d.updated_at
                                             FROM sys_assets a LEFT JOIN sys_remote_devices d ON d.asset_id = a.id
                                            WHERE a.status <> 'retired' AND (a.kind = ANY($1) OR d.asset_id IS NOT NULL) ORDER BY a.tag NULLS LAST, a.name`, [DEVICE_KINDS]);
      out.devices = assets.map((a) => Object.assign(a, { mode: a.mode || 'on_request' }));
      // Helping colleagues: the sessions where I am the chosen helper (with the code while it is usable).
      const { rows: helping } = await query(`SELECT CASE WHEN s.status = 'waiting' THEN s.code END AS code, ${SESSION_SELECT} WHERE s.helper_id = $1 AND s.status IN ('offered', 'waiting', 'connected') ORDER BY s.id`, [uid]);
      out.helping = helping;
      out.offers = mine.filter((x) => x.status === 'offered');
      if (s.peer_help) {
        const { rows: people } = await query(`SELECT id, name FROM users WHERE is_admin AND NOT disabled AND id <> $1 ORDER BY name`, [uid]);
        out.colleagues = people;
      } else out.colleagues = [];
      if (support) {
        // IT sees the digits of help-desk codes only (not codes shared with a colleague), and only while usable.
        const { rows: live } = await query(`SELECT s.code, ${SESSION_SELECT} WHERE s.status IN ('waiting', 'connected') AND s.helper_id IS NULL ORDER BY s.id`);
        out.live = live;
        const { rows: log } = await query(`SELECT ${SESSION_SELECT} ORDER BY s.id DESC LIMIT 150`);
        out.log = log;
      }
      res.json(out);
    } catch (e) { fail(res, e); }
  });

  // ---------------------------------------------- staff: share a help code --
  app.post('/api/sys/remote/share', requireAdmin, async (req, res) => {
    try {
      await ready();
      const uid = req.session.userId;
      if (!(await userCan(req, 'support.raise')) && !(await userCan(req, 'sys.support'))) throw httpError(403, 'Not allowed to ask for help');
      const s = await settings();
      if (!s.enabled) throw httpError(409, 'Remote help is switched off for this shop');
      const b = req.body || {};
      const code = String(b.code || '').replace(/\D/g, '');
      if (code.length !== 12) throw httpError(400, 'The code from Chrome Remote Desktop is 12 digits');
      await sweep();

      // Who helps: IT (no helper), a colleague picked now, or a colleague who offered.
      let helperId = parseInt(b.helper_id, 10) || null, offer = null;
      const offerId = parseInt(b.offer_id, 10) || 0;
      if (offerId) {
        const { rows } = await query(`SELECT * FROM sys_remote_sessions WHERE id = $1 AND requester_id = $2 AND status = 'offered'`, [offerId, uid]);
        if (!rows.length) throw httpError(409, 'That offer of help has expired or was withdrawn');
        offer = rows[0]; helperId = offer.helper_id;
      }
      if (helperId) {
        if (!s.peer_help) throw httpError(409, 'Staff helping each other is switched off for this shop');
        if (helperId === uid) throw httpError(400, 'Pick someone else to help you');
        const { rows } = await query(`SELECT id FROM users WHERE id = $1 AND is_admin AND NOT disabled`, [helperId]);
        if (!rows.length) throw httpError(400, 'That colleague cannot help (not an active system user)');
      }
      const { rows: open } = await query(`SELECT id FROM sys_remote_sessions WHERE requester_id = $1 AND status = 'waiting'`, [uid]);
      if (open.length) await query(`UPDATE sys_remote_sessions SET status = 'cancelled', code = NULL, ended_at = NOW(), outcome = 'Replaced by a new code' WHERE id = ANY($1)`, [open.map((x) => x.id)]);

      let ticketId = parseInt(b.ticket_id, 10) || (offer && offer.ticket_id) || null;
      const reason = txt(b.reason, 160) || (offer && offer.reason);
      if (ticketId) {
        const { rows } = await query(`SELECT id, requester_id FROM sys_tickets WHERE id = $1`, [ticketId]);
        if (!rows.length) throw httpError(404, 'Ticket not found');
        if (rows[0].requester_id !== uid && !(await userCan(req, 'sys.support')) && !offer) throw httpError(403, 'Not your ticket');
      } else if (!helperId) {
        // Help from IT goes on a ticket (same numbering / SLA as the help desk). Help between colleagues needs none.
        if (!reason) throw httpError(400, 'Say in a few words what you need help with');
        const { rows: n } = await query(`SELECT COALESCE(MAX(id), 0) + 1 AS n FROM sys_tickets`);
        const num = 'TCK-' + String(n[0].n).padStart(4, '0');
        const { rows: h } = await query(`SELECT value FROM warehouse_settings WHERE key = 'sys_sla_high_hours'`);
        const { rows } = await query(`INSERT INTO sys_tickets (number, title, description, category, priority, requester_id, asset_id, location, due_at)
                                      VALUES ($1,$2,$3,'other','high',$4,$5,$6, NOW() + make_interval(hours => $7)) RETURNING id`,
          [num, reason, 'Asked for remote help (Chrome Remote Desktop).', uid, parseInt(b.asset_id, 10) || null, txt(b.computer, 120), Number(h[0] && h[0].value) || 24]);
        ticketId = rows[0].id;
      } else if (!reason) throw httpError(400, 'Say in a few words what you need help with');

      let id;
      if (offer) {
        await query(`UPDATE sys_remote_sessions SET status = 'waiting', code = $2, code_expires_at = NOW() + make_interval(mins => $3), asset_id = COALESCE($4, asset_id), computer = COALESCE($5, computer), ticket_id = $6, ip = $7 WHERE id = $1`,
          [offer.id, code, CODE_MINUTES, parseInt(b.asset_id, 10) || null, txt(b.computer, 120), ticketId, ipOf(req)]);
        id = offer.id;
      } else {
        const { rows } = await query(`INSERT INTO sys_remote_sessions (ticket_id, asset_id, computer, kind, requester_id, helper_id, code, code_expires_at, reason, ip)
                                      VALUES ($1,$2,$3,'code',$4,$5,$6, NOW() + make_interval(mins => $7), $8, $9) RETURNING id`,
          [ticketId, parseInt(b.asset_id, 10) || null, txt(b.computer, 120), uid, helperId, code, CODE_MINUTES, reason, ipOf(req)]);
        id = rows[0].id;
      }
      const who = await nameOf(uid);
      await ticketNote(ticketId, uid, 'Shared a Chrome Remote Desktop code so ' + (helperId ? await nameOf(helperId) : 'IT') + ' can connect (valid ' + CODE_MINUTES + ' minutes).', false);
      await audit(req, 'remote.code_shared', { session: id, ticket: ticketId, helper: helperId });   // never the digits
      const { rows: tk } = await query(`SELECT number, title FROM sys_tickets WHERE id = $1`, [ticketId]);
      const msg = who + ' is waiting for your remote help' + (reason ? ': ' + reason : '') + '. Open System management > Remote help in Vision to see the code (it works for ' + CODE_MINUTES + ' minutes).';
      if (helperId) { const { rows: hp } = await query(`SELECT email FROM users WHERE id = $1`, [helperId]); send(hp[0] && hp[0].email, '[Vision] ' + who + ' needs your help now', msg); }
      else for (const to of await techEmails()) send(to, '[IT] Remote help wanted now: ' + (tk[0] ? tk[0].number + ' ' + tk[0].title : ''), msg);
      res.json({ ok: true, id, ticket_id: ticketId, ticket_number: tk[0] && tk[0].number, helper_id: helperId });
    } catch (e) { fail(res, e); }
  });

  // A user offers to help a colleague: the colleague sees the offer and shares a code with them only.
  app.post('/api/sys/remote/offer', requireAdmin, async (req, res) => {
    try {
      await ready();
      const uid = req.session.userId, b = req.body || {};
      const s = await settings();
      if (!s.enabled || !s.peer_help) throw httpError(409, 'Staff helping each other is switched off for this shop');
      const target = parseInt(b.user_id, 10) || 0;
      if (!target || target === uid) throw httpError(400, 'Pick the colleague you want to help');
      const { rows: t } = await query(`SELECT id, name, email FROM users WHERE id = $1 AND is_admin AND NOT disabled`, [target]);
      if (!t.length) throw httpError(400, 'That person is not an active system user');
      const reason = txt(b.reason, 160);
      if (!reason) throw httpError(400, 'Say what you are helping with');
      await sweep();
      await query(`UPDATE sys_remote_sessions SET status = 'cancelled', ended_at = NOW(), outcome = 'Replaced by a new offer' WHERE status = 'offered' AND requester_id = $1 AND helper_id = $2`, [target, uid]);
      const { rows } = await query(`INSERT INTO sys_remote_sessions (kind, requester_id, helper_id, status, reason, ticket_id, ip) VALUES ('code', $1, $2, 'offered', $3, $4, $5) RETURNING id`,
        [target, uid, reason, parseInt(b.ticket_id, 10) || null, ipOf(req)]);
      const me = await nameOf(uid);
      send(t[0].email, '[Vision] ' + me + ' offers to help you on your computer', me + ' wants to connect to your computer to help with: ' + reason + '. If you agree, open System management > Remote help in Vision and share a code there. If you did not expect this, decline it.');
      await audit(req, 'remote.offered', { session: rows[0].id, to: target });
      res.json({ ok: true, id: rows[0].id });
    } catch (e) { fail(res, e); }
  });

  async function sessionFor(req, id) {
    await ready();
    const { rows } = await query(`SELECT * FROM sys_remote_sessions WHERE id = $1`, [id]);
    if (!rows.length) throw httpError(404, 'Session not found');
    const support = await userCan(req, 'sys.support');
    const helper = rows[0].helper_id === req.session.userId;
    // IT handles help-desk sessions; a session between colleagues belongs to the two of them (IT can still end it).
    if (!support && !helper && rows[0].requester_id !== req.session.userId) throw httpError(403, 'Not your session');
    return { s: rows[0], support, helper };
  }

  // Staff take back a code they shared, or anyone in it ends the session.
  app.post('/api/sys/remote/:id/cancel', requireAdmin, async (req, res) => {
    try {
      const { s } = await sessionFor(req, parseInt(req.params.id, 10) || 0);
      if (!['waiting', 'offered'].includes(s.status)) throw httpError(409, 'That code is no longer waiting');
      await query(`UPDATE sys_remote_sessions SET status = 'cancelled', code = NULL, ended_at = NOW(), ended_by = $2 WHERE id = $1`, [s.id, req.session.userId]);
      await ticketNote(s.ticket_id, req.session.userId, s.status === 'offered' ? 'Offer of remote help withdrawn / declined.' : 'Remote help code withdrawn.', false);
      await audit(req, 'remote.code_cancelled', { session: s.id });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/sys/remote/:id/end', requireAdmin, async (req, res) => {
    try {
      const { s } = await sessionFor(req, parseInt(req.params.id, 10) || 0);
      if (!['waiting', 'connected'].includes(s.status)) throw httpError(409, 'That session is already over');
      const outcome = txt(req.body && req.body.outcome, 2000);
      const byStaff = req.session.userId === s.requester_id;
      await query(`UPDATE sys_remote_sessions SET status = 'ended', code = NULL, ended_at = NOW(), ended_by = $2, outcome = COALESCE($3, outcome) WHERE id = $1`, [s.id, req.session.userId, outcome]);
      await ticketNote(s.ticket_id, req.session.userId, (byStaff ? 'Ended the remote session.' : 'Remote session finished.') + (outcome ? ' ' + outcome : ''), false);
      await audit(req, 'remote.ended', { session: s.id, by_requester: byStaff });
      if (byStaff && s.technician_id) { const { rows } = await query(`SELECT email FROM users WHERE id = $1`, [s.technician_id]); send(rows[0] && rows[0].email, '[IT] Remote session ended by staff', (await nameOf(req.session.userId)) + ' ended the remote session.'); }
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------- technician side --
  // Technician took the code and is connected: wipe the code, start the clock.
  app.post('/api/sys/remote/:id/connected', requireAdmin, async (req, res) => {
    try {
      const { s, support, helper } = await sessionFor(req, parseInt(req.params.id, 10) || 0);
      // The chosen colleague connects to their own session; IT connects to help-desk ones.
      if (!(helper || (support && !s.helper_id))) throw httpError(403, s.helper_id ? 'This code was shared with a colleague, not with IT' : 'Only IT can take this one');
      if (s.status !== 'waiting') throw httpError(409, 'That code is no longer waiting');
      const uid = req.session.userId;
      await query(`UPDATE sys_remote_sessions SET status = 'connected', code = NULL, technician_id = $2, started_at = NOW() WHERE id = $1`, [s.id, uid]);
      if (s.ticket_id) {
        await query(`UPDATE sys_tickets SET status = CASE WHEN status IN ('new', 'assigned', 'waiting') THEN 'in_progress' ELSE status END, assignee_id = COALESCE(assignee_id, $2),
                       first_response_at = COALESCE(first_response_at, NOW()), updated_at = NOW() WHERE id = $1`, [s.ticket_id, uid]);
        await ticketNote(s.ticket_id, uid, (await nameOf(uid)) + ' connected remotely.', false);
      }
      if (helper) { const { rows } = await query(`SELECT email FROM users WHERE id = $1`, [s.requester_id]); send(rows[0] && rows[0].email, '[Vision] ' + (await nameOf(uid)) + ' is connected to your computer', 'You can stop it any time: Stop sharing in Chrome Remote Desktop, or System management > Remote help.'); }
      await audit(req, 'remote.connected', { session: s.id, ticket: s.ticket_id });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  // Record a connection to an unattended device (no code involved).
  app.post('/api/sys/remote/unattended', ...SUP, async (req, res) => {
    try {
      await ready();
      const b = req.body || {}, uid = req.session.userId;
      const assetId = parseInt(b.asset_id, 10) || 0;
      const { rows: d } = await query(`SELECT d.mode, a.name FROM sys_remote_devices d JOIN sys_assets a ON a.id = d.asset_id WHERE d.asset_id = $1`, [assetId]);
      if (!d.length || d[0].mode !== 'unattended') throw httpError(409, 'That device is not set up for unattended access');
      if (!(await settings()).unattended_allowed) throw httpError(409, 'Unattended access is switched off for this shop');
      const reason = txt(b.reason, 300);
      if (!reason) throw httpError(400, 'Say why you are connecting');
      const ticketId = parseInt(b.ticket_id, 10) || null;
      const { rows } = await query(`INSERT INTO sys_remote_sessions (ticket_id, asset_id, kind, technician_id, status, reason, started_at, ip) VALUES ($1,$2,'unattended',$3,'connected',$4,NOW(),$5) RETURNING id`,
        [ticketId, assetId, uid, reason, ipOf(req)]);
      await ticketNote(ticketId, uid, (await nameOf(uid)) + ' connected to ' + d[0].name + ' (unattended): ' + reason, false);
      await audit(req, 'remote.unattended_connected', { session: rows[0].id, asset: assetId, reason });
      res.json({ ok: true, id: rows[0].id });
    } catch (e) { fail(res, e); }
  });
  // Ask the person on a ticket to share their screen.
  app.post('/api/sys/tickets/:id/remote-request', ...SUP, async (req, res) => {
    try {
      await ready();
      const id = parseInt(req.params.id, 10) || 0, uid = req.session.userId;
      const { rows } = await query(`SELECT t.id, t.number, t.title, u.email FROM sys_tickets t LEFT JOIN users u ON u.id = t.requester_id WHERE t.id = $1`, [id]);
      if (!rows.length) throw httpError(404, 'Ticket not found');
      const msg = (await nameOf(uid)) + ' would like to connect to your computer to fix this. In Vision open System management > Remote help, follow the steps and share the code there. Do not read the code out over the phone.';
      await ticketNote(id, uid, msg, false);
      await query(`UPDATE sys_tickets SET status = 'waiting', assignee_id = COALESCE(assignee_id, $2), first_response_at = COALESCE(first_response_at, NOW()), updated_at = NOW() WHERE id = $1`, [id, uid]);
      send(rows[0].email, '[IT] ' + rows[0].number + ': IT wants to connect to your computer', msg);
      await audit(req, 'remote.requested', { ticket: id });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // --------------------------------------------------------------- devices --
  app.put('/api/sys/remote/devices/:assetId', ...SUP, async (req, res) => {
    try {
      await ready();
      const id = parseInt(req.params.assetId, 10) || 0, b = req.body || {};
      const { rows: a } = await query(`SELECT id, name FROM sys_assets WHERE id = $1`, [id]);
      if (!a.length) throw httpError(404, 'Device not found');
      const { rows: cur } = await query(`SELECT mode FROM sys_remote_devices WHERE asset_id = $1`, [id]);
      const mode = MODES.includes(b.mode) ? b.mode : (cur[0] ? cur[0].mode : 'on_request');
      if (mode === 'unattended' && (!cur[0] || cur[0].mode !== 'unattended')) {
        // Permanent access to a PC is an owner-level decision.
        if (!(await userCan(req, 'sys.security'))) throw httpError(403, 'Only someone with security access can turn on unattended access');
        if (!(await settings()).unattended_allowed) throw httpError(409, 'Allow unattended access in Remote help settings first');
        if (!txt(b.google_account)) throw httpError(400, 'Which Google account owns the unattended access? (needed to know who can get in)');
      }
      await query(`INSERT INTO sys_remote_devices (asset_id, mode, host_name, google_account, installed, notes, updated_by, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
                   ON CONFLICT (asset_id) DO UPDATE SET mode = EXCLUDED.mode, host_name = EXCLUDED.host_name, google_account = EXCLUDED.google_account, installed = EXCLUDED.installed,
                     notes = EXCLUDED.notes, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
        [id, mode, txt(b.host_name, 120), txt(b.google_account, 160), !!b.installed, txt(b.notes, 1000), req.session.userId]);
      await audit(req, 'remote.device_set', { asset: id, name: a[0].name, mode, from: cur[0] ? cur[0].mode : null });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // -------------------------------------------------------------- settings --
  app.put('/api/sys/remote/settings', ...SEC, async (req, res) => {
    try {
      const b = req.body || {};
      const before = await settings();
      if ('enabled' in b) await putSetting('remote_enabled', b.enabled ? '1' : '0');
      if ('unattended_allowed' in b) await putSetting('remote_unattended_allowed', b.unattended_allowed ? '1' : '0');
      if ('file_transfer' in b) await putSetting('remote_file_transfer', b.file_transfer ? '1' : '0');
      if ('peer_help' in b) await putSetting('remote_peer_help', b.peer_help ? '1' : '0');
      for (const k of ['provider_name', 'provider_phone', 'provider_email', 'note']) if (k in b) await putSetting('remote_' + k, txt(b[k], k === 'note' ? 1000 : 160) || '');
      await audit(req, 'remote.settings', { before, after: await settings() });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // The setup script for a shop PC, with this shop's choices filled in.
  app.get('/api/sys/remote/setup-script', ...SUP, async (req, res) => {
    try {
      const f = path.join(__dirname, 'tools', 'Setup-Remote-Support.ps1');
      let body = fs.readFileSync(f, 'utf8');
      const s = await settings();
      body = body.replace(/^\$ShopAllowsUnattended = .*$/m, '$ShopAllowsUnattended = $' + (s.unattended_allowed ? 'true' : 'false'))
                 .replace(/^\$ShopAllowsFileTransfer = .*$/m, '$ShopAllowsFileTransfer = $' + (s.file_transfer ? 'true' : 'false'));
      await audit(req, 'remote.script_downloaded', {});
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="Setup-Remote-Support.ps1"');
      res.send(body.replace(/\r?\n/g, '\r\n'));
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------ system management hooks --
  if (sysops && sysops.addOverview) sysops.addOverview(async (req, caps) => {
    if (!caps.support) return {};
    await ready(); await sweep();
    const { rows } = await query(`SELECT COUNT(*) FILTER (WHERE status = 'waiting')::int AS waiting, COUNT(*) FILTER (WHERE status = 'connected')::int AS connected FROM sys_remote_sessions WHERE helper_id IS NULL`);
    return { remote: rows[0] };
  });
  if (sysops && sysops.addChecks) sysops.addChecks(async () => {
    await ready();
    const s = await settings();
    const { rows } = await query(`SELECT a.name, d.google_account FROM sys_remote_devices d JOIN sys_assets a ON a.id = d.asset_id WHERE d.mode = 'unattended'`);
    const out = [];
    if (rows.length && !s.unattended_allowed) out.push({ key: 'remote_unattended', label: 'Unattended remote access matches shop policy', state: 'fail', detail: rows.length + ' device(s) still marked unattended although the shop does not allow it', fix: 'Remove the access on those PCs (run Setup-Remote-Support.ps1 -Remove) and set them to "on request".' });
    else out.push({ key: 'remote_unattended', label: 'Unattended remote access is known and owned', state: rows.some((r) => !r.google_account) ? 'warn' : 'pass',
      detail: rows.length ? rows.length + ' device(s): ' + rows.map((r) => r.name + (r.google_account ? ' (' + r.google_account + ')' : ' (owner unknown)')).join(', ') : 'No PC can be reached without someone there', fix: 'System management > Remote help > Devices: record the Google account for each unattended PC, protect that account with 2-step verification.' });
    return out;
  });

  return { ready };
}

module.exports = { register, S_STATUS };
