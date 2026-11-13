// =============================================================================
//  Vision Auto Solutions -- Approved devices only
//
//    const deviceAccess = require('./device-access').register(app, { query, requireAdmin, requireCap })
//    ...after sysops:  deviceAccess.attach(sysops)
//
//  Mounted EARLY (right after the session middleware, before any sign-in
//  route), so it sees every staff request. Each browser that reaches a staff
//  page gets a device ID (cookie vision_dev, stored here only as a hash). With
//  the gate on, ADMIN accounts (owners, managers, roles with full access) work
//  only on approved devices; on any other device they cannot:
//    - sign in by any route (password, PIN, passkey, 2-step...),
//    - use any page or API with their session (the session is ended).
//  Cashiers and other staff are not affected (Deb, 2026-11-06).
//  Phones and Apple devices: /device-setup.html registers the browser it is
//  opened in (iPhone, iPad, Mac, Android, Windows) and shows how to add a
//  home-screen icon.
//  It sees a "device not approved" page with a short code instead; a manager
//  approves it in System management > Device access.
//
//  Never gated:
//    - the server PC itself (loopback, and not a request relayed by the tunnel),
//      so the owner can always get in at the server to fix things;
//    - tills talking to the server with their own terminal token, and the
//      signed Cloudflare gateway (both are already authenticated another way);
//    - the customer website and customer accounts.
//  Remote help (Chrome Remote Desktop) needs nothing extra: the helper works on
//  the approved PC's own screen, so their own computer never reaches the server.
//
//  Modes (warehouse_settings device_gate_mode): off | learn | enforce.
//  learn  = record every device that is used, block nothing (approve them, then)
//  enforce = only approved devices. Switching to enforce is refused unless the
//            device doing it is approved or is the server PC (no self-lockout).
//  Terminal installer (tools/Install-Vision-Terminal.ps1, downloaded from the
//  Device access tab with this server's address filled in): makes a local
//  settings folder on the PC, a registration ID (VT-XXXX-XXXX-XXXX), registers
//  it here (POST /api/device/register -> a device secret kept in that folder),
//  and a desktop icon that opens Vision through /api/device/claim, which puts
//  the device cookie into the terminal's own browser profile. The terminal then
//  shows up under Device access with its registration ID, waiting for approval.
//  Tables are created on first use (never at startup).
// =============================================================================
'use strict';

const crypto = require('crypto');

const COOKIE = 'vision_dev';
const MODES = ['off', 'learn', 'enforce'];
const CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const EXEMPT = /^\/(api\/(health|terminal-status|device\/(status|request|register|claim))\b|device-setup(\.html)?$|device\.webmanifest$|assets\/|favicon|apple-touch-icon|img\/|uploads\/)/;

const DDL = `
CREATE TABLE IF NOT EXISTS sys_devices (
  id            SERIAL PRIMARY KEY,
  token_hash    TEXT UNIQUE NOT NULL,                 -- sha256 of the vision_dev cookie
  code          TEXT UNIQUE NOT NULL,                 -- short code shown on the device (K7QM-3XRA)
  name          TEXT,                                 -- "Front counter PC", "Deb's phone"
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'blocked')),
  user_agent    TEXT,
  first_ip      TEXT,
  last_ip       TEXT,
  last_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  last_path     TEXT,
  denied_count  INTEGER NOT NULL DEFAULT 0,
  approved_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  approved_at   TIMESTAMPTZ,
  note          TEXT,
  first_seen    TIMESTAMPTZ DEFAULT NOW(),
  last_seen     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sys_devices_status ON sys_devices (status, last_seen DESC);
-- Terminals set up with the terminal installer carry a registration ID (VT-XXXX-XXXX-XXXX).
ALTER TABLE sys_devices ADD COLUMN IF NOT EXISTS reg_id TEXT UNIQUE;
ALTER TABLE sys_devices ADD COLUMN IF NOT EXISTS hostname TEXT;
ALTER TABLE sys_devices ADD COLUMN IF NOT EXISTS os_user TEXT;
ALTER TABLE sys_devices ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'browser';`;
const REG_RE = /^VT-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

function register(app, deps) {
  const { query, requireAdmin, requireCap } = deps;
  const SEC = [requireAdmin, requireCap('sys.security')];
  let sysops = null;

  let readyP = null;
  const ready = () => (readyP = readyP || query(DDL).catch((e) => { readyP = null; throw e; }));

  const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
  const txt = (v, max) => { const s = String(v == null ? '' : v).trim(); return s ? s.slice(0, max || 120) : null; };
  const ipOf = (req) => String(req.headers['cf-connecting-ip'] || req.ip || (req.socket && req.socket.remoteAddress) || '').split(',')[0].trim().replace(/^::ffff:/, '').slice(0, 64);
  function httpError(status, msg) { const e = new Error(msg); e.status = status; e.publicMessage = msg; return e; }
  function fail(res, e) { const s = e.status || 500; if (s >= 500) console.error('[device-access]', e); res.status(s).json({ error: e.publicMessage || e.message }); }
  const audit = (req, action, detail) => (sysops && sysops.audit ? sysops.audit(req, action, detail) : Promise.resolve());
  const newCode = () => { const b = crypto.randomBytes(8); let s = ''; for (let i = 0; i < 8; i++) s += CODE_ABC[b[i] % CODE_ABC.length]; return s.slice(0, 4) + '-' + s.slice(4); };

  // The server PC itself: a loopback connection that was not relayed by the
  // Cloudflare tunnel (cloudflared also connects from 127.0.0.1, so the relay
  // headers are what tell an internet visitor apart from someone at the server).
  function isServerPc(req) {
    if (req.headers['cf-connecting-ip'] || req.headers['cf-ray'] || req.headers['x-forwarded-for'] || req.headers['x-real-ip']) return false;
    const a = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
    return a === '127.0.0.1' || a === '::1';
  }

  // ---------------------------------------------------------------- caches --
  let modeCache = { v: 'off', at: 0 };
  async function mode() {
    if (Date.now() - modeCache.at < 10000) return modeCache.v;
    try {
      const { rows } = await query(`SELECT value FROM warehouse_settings WHERE key = 'device_gate_mode'`);
      modeCache = { v: MODES.includes(rows[0] && rows[0].value) ? rows[0].value : 'off', at: Date.now() };
    } catch (_) { modeCache.at = Date.now(); }
    return modeCache.v;
  }
  // Only ADMIN access is locked to approved devices: owners and managers (and any
  // account whose role has full access). Cashiers and other staff are not affected.
  const staffCache = new Map();
  async function isStaff(uid) {
    const c = staffCache.get(uid);
    if (c && Date.now() - c.at < 30000) return c.v;
    const { rows } = await query(`SELECT is_admin, admin_role, COALESCE(disabled, false) AS disabled FROM users WHERE id = $1`, [uid]);
    let v = !!(rows[0] && rows[0].is_admin && !rows[0].disabled && ['owner', 'manager'].includes(rows[0].admin_role));
    if (!v && rows[0] && rows[0].is_admin && !rows[0].disabled && deps.permState) { try { v = !!(await deps.permState(uid)).full; } catch (_) {} }
    staffCache.set(uid, { v, at: Date.now() });
    if (staffCache.size > 2000) staffCache.clear();
    return v;
  }
  const devCache = new Map();                      // token hash -> { row, at }
  const forget = () => devCache.clear();
  const newPerIp = new Map();                      // throttle anonymous device rows

  function readCookie(req) {
    const m = /(?:^|;\s*)vision_dev=([A-Za-z0-9_-]{20,64})/.exec(String(req.headers.cookie || ''));
    return m ? m[1] : null;
  }
  function setCookie(req, res, tok) {
    const parts = [COOKIE + '=' + tok, 'Path=/', 'Max-Age=' + 5 * 365 * 86400, 'HttpOnly', 'SameSite=Lax'];
    if (req.secure) parts.push('Secure');
    const prev = res.getHeader('Set-Cookie');
    res.setHeader('Set-Cookie', [].concat(prev || [], parts.join('; ')));
  }

  // The device row for this browser; creates one (pending) when asked and allowed.
  async function device(req, res, create) {
    await ready();
    let tok = readCookie(req);
    if (tok) {
      const h = sha(tok), c = devCache.get(h);
      let row = c && Date.now() - c.at < 15000 ? c.row : null;
      if (!row) {
        const { rows } = await query(`SELECT id, code, name, status, reg_id FROM sys_devices WHERE token_hash = $1`, [h]);
        row = rows[0] || null;
        if (row) devCache.set(h, { row, at: Date.now() });
      }
      if (row) {
        // Touch at most once a minute per device.
        if (!c || Date.now() - c.at > 60000 || !c.touched) {
          query(`UPDATE sys_devices SET last_seen = NOW(), last_ip = $2, last_user_id = COALESCE($3, last_user_id), last_path = $4 WHERE id = $1`,
            [row.id, ipOf(req), (req.session && req.session.userId) || null, req.path.slice(0, 120)]).catch(() => {});
          devCache.set(h, { row, at: Date.now(), touched: true });
        }
        return row;
      }
    }
    if (!create) return null;
    const ip = ipOf(req), now = Date.now();
    const w = (newPerIp.get(ip) || []).filter((t) => now - t < 3600000);
    if (w.length >= 20) return { id: null, code: null, status: 'pending', throttled: true };
    w.push(now); newPerIp.set(ip, w); if (newPerIp.size > 5000) newPerIp.clear();
    tok = crypto.randomBytes(24).toString('base64url');
    for (let i = 0; i < 5; i++) {
      try {
        const { rows } = await query(`INSERT INTO sys_devices (token_hash, code, user_agent, first_ip, last_ip, last_user_id, last_path) VALUES ($1,$2,$3,$4,$4,$5,$6) RETURNING id, code, name, status`,
          [sha(tok), newCode(), String(req.headers['user-agent'] || '').slice(0, 300), ip, (req.session && req.session.userId) || null, req.path.slice(0, 120)]);
        setCookie(req, res, tok);
        devCache.set(sha(tok), { row: rows[0], at: Date.now(), touched: true });
        return rows[0];
      } catch (e) { if (e.code !== '23505') throw e; }   // code clash: try another
    }
    throw new Error('could not register device');
  }

  function deniedPage(dev) {
    const code = dev && dev.code ? dev.code : '';
    const esc = (s) => String(s || '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
    return '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Device not approved</title>' +
      '<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1b2b;color:#e6e9ee;font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif;padding:16px}' +
      '.c{max-width:520px;text-align:center}h1{font-size:20px;margin:0 0 10px}p{color:#94a3b8;font-size:14px;line-height:1.6;margin:0 0 10px}' +
      '.code{font:700 34px ui-monospace,Consolas,monospace;letter-spacing:4px;color:#fff;background:rgba(255,255,255,.08);border-radius:10px;padding:12px 18px;display:inline-block;margin:8px 0 14px}' +
      'input{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #334155;background:#0f2438;color:#fff;font-size:15px}button{margin-top:8px;padding:10px 16px;border:0;border-radius:8px;background:#2563eb;color:#fff;font-size:15px;cursor:pointer}</style>' +
      '<div class="c"><div style="font-size:44px">🔒</div><h1>This device is not approved for admin access</h1>' +
      (dev && dev.status === 'blocked' ? '<p>An administrator has blocked this device.</p>' :
        (code ? '<p>Give this code to a manager. They approve it in <b>System management › Device access</b>.</p><div class="code">' + esc(code) + '</div>' +
          '<p>What is this device? (helps the manager recognise it)</p><input id="n" maxlength="60" placeholder="e.g. Back office laptop" value="' + esc(dev.name) + '"><button id="b">Send</button><p id="m" style="margin-top:10px"></p>'
          : '<p>Too many new devices from this address. Try again later or ask a manager.</p>')) +
      '<p style="margin-top:16px;font-size:12px">This page opens Vision by itself once the device is approved. Cashiers and other staff can still sign in here; only admin accounts need an approved device.</p><p style="font-size:12px"><a style="color:#93c5fd" href="/device-setup.html">Set up this device (iPhone, iPad, Mac, Android, Windows)</a></p></div>' +
      '<script>(function(){var b=document.getElementById("b");if(b)b.onclick=function(){fetch("/api/device/request",{method:"POST",headers:{"Content-Type":"application/json"},credentials:"same-origin",body:JSON.stringify({name:document.getElementById("n").value})}).then(function(){document.getElementById("m").textContent="Sent. Waiting for approval…";});};' +
      'setInterval(function(){fetch("/api/device/status",{credentials:"same-origin"}).then(function(r){return r.json()}).then(function(d){if(d&&(d.status==="approved"||d.mode!=="enforce"))location.reload();}).catch(function(){});},5000);})();<\/script></html>';
  }
  function deny(req, res, dev) {
    if (dev && dev.id) query(`UPDATE sys_devices SET denied_count = denied_count + 1 WHERE id = $1`, [dev.id]).catch(() => {});
    const msg = 'This device is not approved for admin access to Vision.' + (dev && dev.code ? ' Device code ' + dev.code + ': ask a manager to approve it in System management > Device access.' : '');
    if (req.path.startsWith('/api/')) return res.status(403).json({ error: msg, device_not_approved: true, device_code: dev && dev.code, device_status: dev && dev.status });
    return res.status(403).type('html').send(deniedPage(dev));
  }

  // ------------------------------------------------------------------ gate --
  app.use(async (req, res, next) => {
    let m;
    try { m = await mode(); } catch (_) { return next(); }
    if (m === 'off') return next();
    if (isServerPc(req) || EXEMPT.test(req.path)) return next();
    if (req.get('x-terminal-token') || req.get('x-vision-gateway-sig')) return next();   // authenticated another way
    try {
      const uid = req.session && req.session.userId;
      const staff = uid ? await isStaff(uid) : false;
      if (!staff) {
        // Not an admin request (yet). If this request signs an admin in,
        // check the device before the answer goes out.
        if (!uid && req.method !== 'GET' && req.path.startsWith('/api/')) guardSignIn(req, res, m);
        return next();
      }
      const dev = await device(req, res, true);
      if (dev.status === 'approved' || (m === 'learn' && dev.status !== 'blocked')) return next();
      if (staff) {
        await audit(req, 'device.denied', { device: dev.id, code: dev.code, path: req.path });
        req.session = null;                                  // strict: an unapproved device keeps no staff session
      }
      return deny(req, res, dev);
    } catch (e) {
      // Fail open on an internal error (e.g. the table cannot be created) rather than lock the shop out.
      console.warn('[device-access] gate', e.message);
      return next();
    }
  });
  // Sign-in by any route: hold the JSON answer until the device is checked.
  function guardSignIn(req, res, m) {
    const json = res.json.bind(res);
    res.json = function (body) {
      const uid = req.session && req.session.userId;
      if (!uid || res.statusCode >= 400 || res.headersSent) return json(body);
      (async () => {
        try {
          if (!(await isStaff(uid))) return json(body);
          const dev = await device(req, res, true);
          if (dev.status === 'approved' || (m === 'learn' && dev.status !== 'blocked')) return json(body);
          req.session = null;
          await audit(req, 'device.signin_refused', { device: dev.id, code: dev.code, user_id: uid });
          res.status(403); json({ error: 'Admin sign-in refused: this device is not approved for admin access.' + (dev.code ? ' Device code ' + dev.code + '.' : ''), device_not_approved: true, device_code: dev.code });
        } catch (e) { console.warn('[device-access] sign-in check', e.message); json(body); }
      })();
      return res;
    };
  }

  // ---------------------------------------------------- the device itself --
  app.get('/api/device/status', async (req, res) => {
    try {
      const m = await mode();
      const dev = await device(req, res, false);
      res.json({ mode: m, server_pc: isServerPc(req), status: dev ? dev.status : (isServerPc(req) ? 'approved' : 'unknown'), code: dev && dev.code, name: dev && dev.name, reg_id: dev && dev.reg_id });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/device/request', async (req, res) => {
    try {
      const dev = await device(req, res, false);
      if (!dev || !dev.id) throw httpError(400, 'Open a Vision page on this device first');
      if (dev.status !== 'pending') throw httpError(409, 'This device is ' + dev.status);
      await query(`UPDATE sys_devices SET name = COALESCE(name, $2), note = $3 WHERE id = $1`, [dev.id, txt(req.body && req.body.name, 60), 'Name given on the device']);
      forget();
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ---------------------------------------------- terminal installer side --
  // The installer registers the PC. A new registration ID gets a device secret
  // (returned once, kept in the PC's settings folder); re-running the installer
  // must present that secret, so nobody can take over another terminal's ID.
  app.post('/api/device/register', async (req, res) => {
    try {
      await ready();
      const b = req.body || {};
      const reg = String(b.reg_id || '').toUpperCase().trim();
      if (!REG_RE.test(reg)) throw httpError(400, 'Registration ID must look like VT-XXXX-XXXX-XXXX');
      const meta = [txt(b.name, 60), txt(b.hostname, 80), txt(b.os_user, 80), ipOf(req), String(req.headers['user-agent'] || 'Vision terminal installer').slice(0, 300)];
      const browser = b.browser === true;                  // from /device-setup.html: this browser becomes the device
      const kind = browser ? (/iPhone|iPad|Android|Mobile/i.test(String(req.headers['user-agent'] || '')) ? 'mobile' : 'browser') : 'terminal';
      if (browser) {
        // Already has a device pass in this browser: give that device the registration ID.
        const here = await device(req, res, false);
        if (here && here.id) {
          const { rows: hr } = await query(`UPDATE sys_devices SET reg_id = COALESCE(reg_id, $2), kind = $3, name = COALESCE($4, name), hostname = COALESCE($5, hostname) WHERE id = $1 RETURNING reg_id, code, status`,
            [here.id, reg, kind, meta[0], meta[1]]);
          forget();
          return res.json({ ok: true, reg_id: hr[0].reg_id, code: hr[0].code, status: hr[0].status });
        }
      }
      const { rows: cur } = await query(`SELECT id, token_hash, code, status FROM sys_devices WHERE reg_id = $1`, [reg]);
      if (cur.length) {
        if (!b.token || sha(b.token) !== cur[0].token_hash) throw httpError(409, 'That registration ID is already in use by another terminal');
        await query(`UPDATE sys_devices SET name = COALESCE(name, $2), hostname = COALESCE($3, hostname), os_user = COALESCE($4, os_user), last_ip = $5, last_seen = NOW() WHERE id = $1`, [cur[0].id, ...meta.slice(0, 4)]);
        forget();
        return res.json({ ok: true, reg_id: reg, code: cur[0].code, status: cur[0].status, token: b.token });
      }
      const ip = meta[3], now = Date.now();
      const w = (newPerIp.get(ip) || []).filter((t) => now - t < 3600000);
      if (w.length >= 20) throw httpError(429, 'Too many new terminals from this address. Try again later.');
      w.push(now); newPerIp.set(ip, w);
      const tok = crypto.randomBytes(24).toString('base64url');
      for (let i = 0; i < 5; i++) {
        try {
          const { rows } = await query(`INSERT INTO sys_devices (token_hash, code, reg_id, kind, name, hostname, os_user, first_ip, last_ip, user_agent, note)
                                        VALUES ($1,$2,$3,$9,$4,$5,$6,$7,$7,$8,$10) RETURNING id, code, status`,
            [sha(tok), newCode(), reg, ...meta, kind, browser ? 'Set up on the device (Set up this device page)' : 'Set up with the terminal installer']);
          if (browser) { setCookie(req, res, tok); return res.json({ ok: true, reg_id: reg, code: rows[0].code, status: rows[0].status }); }
          return res.json({ ok: true, reg_id: reg, code: rows[0].code, status: rows[0].status, token: tok });
        } catch (e) { if (e.code !== '23505' || /reg_id/.test(e.detail || e.constraint || '')) throw e; }
      }
      throw new Error('could not register terminal');
    } catch (e) { fail(res, e); }
  });
  // The terminal's desktop icon opens this: it hands the device cookie to the
  // terminal's own browser profile, then goes on to Vision.
  app.get('/api/device/claim', async (req, res) => {
    try {
      await ready();
      const reg = String(req.query.reg || '').toUpperCase(), t = String(req.query.t || '');
      const to = /^\/[A-Za-z0-9_\-./]*$/.test(String(req.query.to || '')) && !String(req.query.to).startsWith('//') ? String(req.query.to) : '/admin.html';
      const { rows } = await query(`SELECT id, token_hash, status FROM sys_devices WHERE reg_id = $1`, [reg]);
      if (!rows.length || !/^[A-Za-z0-9_-]{20,64}$/.test(t) || sha(t) !== rows[0].token_hash) {
        return res.status(403).type('html').send('<!doctype html><meta charset="utf-8"><title>Terminal not registered</title><body style="font-family:Segoe UI,Arial,sans-serif;padding:24px"><h2>This terminal is not registered with this server</h2><p>Run the Vision terminal installer again on this computer, or ask a manager.</p>');
      }
      setCookie(req, res, t);
      query(`UPDATE sys_devices SET last_seen = NOW(), last_ip = $2 WHERE id = $1`, [rows[0].id, ipOf(req)]).catch(() => {});
      res.setHeader('Cache-Control', 'no-store');
      res.redirect(302, to);
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------ management (SEC) --
  app.get('/api/sys/devices', ...SEC, async (req, res) => {
    try {
      await ready();
      const m = await mode();
      const here = isServerPc(req) ? null : await device(req, res, true);
      const { rows } = await query(`SELECT d.id, d.code, d.reg_id, d.kind, d.hostname, d.os_user, d.name, d.status, d.user_agent, d.first_ip, d.last_ip, d.first_seen, d.last_seen, d.denied_count, d.approved_at, d.note,
                                           u.name AS last_user, a.name AS approved_by_name
                                      FROM sys_devices d LEFT JOIN users u ON u.id = d.last_user_id LEFT JOIN users a ON a.id = d.approved_by
                                     ORDER BY CASE d.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, d.last_seen DESC LIMIT 500`);
      res.json({ mode: m, server_pc: isServerPc(req), this_device: here && here.id ? { id: here.id, code: here.code, status: here.status } : null, devices: rows });
    } catch (e) { fail(res, e); }
  });
  async function setStatus(req, id, status, name) {
    const { rows } = await query(`UPDATE sys_devices SET status = $2, name = COALESCE($3, name),
                                    approved_by = CASE WHEN $2 = 'approved' THEN $4 ELSE approved_by END, approved_at = CASE WHEN $2 = 'approved' THEN NOW() ELSE approved_at END
                                  WHERE id = $1 RETURNING id, code, name`, [id, status, txt(name, 60), req.session.userId]);
    if (!rows.length) throw httpError(404, 'Device not found');
    forget();
    await audit(req, 'device.' + status, { device: id, code: rows[0].code, name: rows[0].name });
    return rows[0];
  }
  app.post('/api/sys/devices/approve-code', ...SEC, async (req, res) => {
    try {
      await ready();
      const raw = String(req.body && req.body.code || '').toUpperCase().trim();
      const code = raw.replace(/[^A-Z0-9]/g, '');
      let rows;
      if (/^VT/.test(code) && code.length === 14) ({ rows } = await query(`SELECT id FROM sys_devices WHERE reg_id = $1`, ['VT-' + code.slice(2, 6) + '-' + code.slice(6, 10) + '-' + code.slice(10)]));
      else if (code.length === 8) ({ rows } = await query(`SELECT id FROM sys_devices WHERE code = $1`, [code.slice(0, 4) + '-' + code.slice(4)]));
      else throw httpError(400, 'Type the device code (like K7QM-3XRA) or the terminal registration ID (like VT-4K7Q-M3XR-A9PZ)');
      if (!rows.length) throw httpError(404, 'No device with that code has been seen');
      res.json({ ok: true, device: await setStatus(req, rows[0].id, 'approved', req.body.name) });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/sys/devices/:id/:action(approve|block)', ...SEC, async (req, res) => {
    try {
      await ready();
      const id = parseInt(req.params.id, 10) || 0;
      if (req.params.action === 'block') {
        const here = await device(req, res, false);
        if (here && here.id === id && (await mode()) === 'enforce' && !isServerPc(req)) throw httpError(409, 'You cannot block the device you are using');
      }
      res.json({ ok: true, device: await setStatus(req, id, req.params.action === 'approve' ? 'approved' : 'blocked', req.body && req.body.name) });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/sys/devices/:id/rename', ...SEC, async (req, res) => {
    try {
      await ready();
      const { rowCount } = await query(`UPDATE sys_devices SET name = $2, note = $3 WHERE id = $1`, [parseInt(req.params.id, 10) || 0, txt(req.body && req.body.name, 60), txt(req.body && req.body.note, 300)]);
      if (!rowCount) throw httpError(404, 'Device not found');
      forget(); res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/sys/devices/approve-all', ...SEC, async (req, res) => {
    try {
      await ready();
      const { rows } = await query(`UPDATE sys_devices SET status = 'approved', approved_by = $1, approved_at = NOW()
                                     WHERE status = 'pending' AND last_user_id IS NOT NULL RETURNING id, code, name`, [req.session.userId]);
      forget();
      await audit(req, 'device.approved_all', { count: rows.length, devices: rows.map((r) => r.code) });
      res.json({ ok: true, approved: rows.length });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/sys/devices/forget-unused', ...SEC, async (req, res) => {
    try {
      await ready();
      const { rowCount } = await query(`DELETE FROM sys_devices WHERE status = 'pending' AND last_seen < NOW() - INTERVAL '14 days'`);
      forget(); res.json({ ok: true, removed: rowCount });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/sys/devices/mode', ...SEC, async (req, res) => {
    try {
      await ready();
      const want = String(req.body && req.body.mode || '');
      if (!MODES.includes(want)) throw httpError(400, 'Mode is off, learn or enforce');
      if (want === 'enforce' && !isServerPc(req)) {
        const here = await device(req, res, true);
        if (here.status !== 'approved') throw httpError(409, 'Approve this device first (code ' + here.code + '), or switch it on at the server PC, so you cannot lock yourself out');
      }
      const before = await mode();
      await query(`INSERT INTO warehouse_settings (key, value) VALUES ('device_gate_mode', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [want]);
      modeCache = { v: want, at: Date.now() };
      await audit(req, 'device.mode', { from: before, to: want });
      res.json({ ok: true, mode: want });
    } catch (e) { fail(res, e); }
  });

  // The terminal installer, with this server's address filled in.
  app.get('/api/sys/devices/terminal-installer', ...SEC, async (req, res) => {
    try {
      const fs = require('fs'), path = require('path'), os = require('os');
      let host = String(req.headers.host || '');
      if (!host || /^(localhost|127\.|\[::1\])/i.test(host)) {
        const port = (req.socket && req.socket.localPort) || 3056;
        let ip = null;
        for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (!ip && a.family === 'IPv4' && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) ip = a.address;
        host = (ip || os.hostname()) + ':' + port;
      }
      const url = (req.secure ? 'https://' : 'http://') + host.replace(/[^A-Za-z0-9.:\-\[\]]/g, '');
      let body = fs.readFileSync(path.join(__dirname, 'tools', 'Install-Vision-Terminal.ps1'), 'utf8');
      body = body.replace(/^\$DefaultServer = .*$/m, "$DefaultServer = '" + url + "'");
      await audit(req, 'device.installer_downloaded', { server: url });
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="Install-Vision-Terminal.ps1"');
      res.send(body.replace(/\r?\n/g, '\r\n'));
    } catch (e) { fail(res, e); }
  });

  function attach(s) {
    sysops = s;
    if (s && s.addChecks) s.addChecks(async () => {
      const m = await mode();
      let pending = 0;
      try { await ready(); const { rows } = await query(`SELECT COUNT(*)::int AS n FROM sys_devices WHERE status = 'pending' AND last_user_id IS NOT NULL`); pending = rows[0].n; } catch (_) {}
      return [{ key: 'device_gate', label: 'Only approved devices can use Vision', state: m === 'enforce' ? 'pass' : m === 'learn' ? 'warn' : 'fail',
        detail: m === 'enforce' ? 'On' : m === 'learn' ? 'Learning: devices are recorded but not blocked' + (pending ? ' (' + pending + ' waiting for approval)' : '') : 'Off: any computer or phone on the network can reach the staff sign-in',
        fix: 'System management > Device access: approve the shop\'s devices, then switch to "Only approved devices".' }];
    });
    if (s && s.addOverview) s.addOverview(async (req, caps) => {
      if (!caps.security) return {};
      try { await ready(); const { rows } = await query(`SELECT COUNT(*)::int AS n FROM sys_devices WHERE status = 'pending' AND last_seen > NOW() - INTERVAL '7 days'`); return { devices_pending: rows[0].n, device_mode: await mode() }; } catch (_) { return {}; }
    });
  }

  return { attach, isServerPc };
}

module.exports = { register };
