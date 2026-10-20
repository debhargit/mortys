// =============================================================================
//  Vision Auto Solutions -- Cyber security, threats and mitigation, network
//  management. Part of System management (system.html), next to sysops.js.
//
//    require('./cyber').register(app, deps)   (early, right after sysops: its
//    door-keeper middleware runs before every other route)
//
//  At the door (every request): blocked addresses are refused; requests are
//  checked against common attack patterns (path traversal, SQL / command
//  injection, script injection, probes for .env / .git / wp-admin / phpMyAdmin
//  and other things this site does not have); one address asking for many
//  missing pages is a scanner. Repeat attackers from the internet are blocked
//  for a while automatically (never local or shop-network addresses).
//  Safe browser headers (nosniff, same-origin framing, referrer policy).
//
//  Behind it (every 5 minutes, from the audit log): password guessing on an
//  account, one address trying many accounts, a manager signing in from a new
//  address, mass deletions, permission changes, big data exports, many voids
//  by one person, audit log tampering. Network: monitored devices / services
//  that stop answering, unknown devices on the shop network.
//
//  Each threat carries a playbook (what to do) and the actions taken on it:
//  acknowledge, block the address, lock the account, sign the person out,
//  open an incident, mark mitigated or a false positive.
//
//  Capabilities: sys.security (threats, blocks, risks, settings),
//  sys.network (network monitoring, devices, ports, firewall, networks).
// =============================================================================
'use strict';

const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const SEVERITY_RANK = { low: 1, medium: 2, high: 3, critical: 4 };

// What to do, per kind of threat.
const PLAYBOOKS = {
  web_attack: ['Look at the samples: are they attacks on this site (paths or values with SQL, scripts, ../)?', 'Block the address (it is usually automatic after repeated attempts).', 'If any attack reached a page that answered normally, open an incident and have the code checked.', 'Keep the server and its software up to date (Software & patches).'],
  scanning: ['Someone is probing for weaknesses by asking for pages that do not exist.', 'Block the address for a day or longer.', 'Check the server exposes only the ports it needs (Network > Server ports).'],
  brute_force: ['Someone is guessing this account\'s password.', 'The account locks itself after the set number of wrong passwords; ask the person if it was them.', 'If not them: change the password, turn on 2-step for them, sign them out everywhere, and block the address.'],
  credential_stuffing: ['One address is trying passwords on several accounts (leaked passwords from other sites).', 'Block the address now.', 'Make every manager use 2-step sign-in; ask staff not to reuse passwords from other sites.', 'Check the audit trail for any successful sign-in from that address.'],
  new_location: ['An owner or manager signed in from an address not seen before for them.', 'Ask them if it was them (new phone, home internet, travelling).', 'If not: sign them out everywhere, change the password, check what they changed (Audit trail), open an incident.'],
  mass_delete: ['Many records were deleted in a short time by one person.', 'Ask them why; check the deletions in the Audit trail.', 'If it was not legitimate: disable the account, restore from the backup, open an incident.'],
  privilege_change: ['Someone\'s role, permissions or the security settings were changed.', 'Confirm the change was agreed (it should be in the Change log).', 'If not: reverse it on the Admin users screen, sign the person out, open an incident.'],
  data_export: ['A large amount of data was exported (audit log, customer or sales lists).', 'Confirm who needed it and why; exports can leak customer data.', 'If not justified: open a privacy incident.'],
  fraud_pattern: ['One person voided or refunded many sales in a day.', 'Check the voided sales and refunds against the receipts and the cash drawer.', 'Take it up with the person and their manager; open a fraud incident if it cannot be explained.'],
  audit_tamper: ['An audit log entry was edited or removed — someone with database access is covering tracks.', 'Open a critical incident now. Do not alter anything else.', 'Change the database password, check who has access to the server, restore the audit log from the backup to compare.'],
  network_down: ['A monitored device or service stopped answering.', 'Check its power and cable / Wi-Fi; restart it.', 'If it is the internet line, call the provider; if a till, raise an IT ticket.'],
  unknown_device: ['A device the shop does not know about is on the network.', 'Find out what it is (a staff phone on the wrong Wi-Fi? a new printer? an intruder).', 'If it should be there, register it as equipment; if not, block it on the router and change the Wi-Fi password.'],
  after_hours: ['Changes were made in the back office outside business hours.', 'Confirm with the person that it was them and expected.'],
};

function register(app, deps) {
  const { query, requireAdmin, requireCap, mailer, devMode, sysops } = deps;
  const can = (k) => [requireAdmin, requireCap(k)];
  const SEC = can('sys.security'), NET = can('sys.network');
  const n = (v) => (v == null || v === '' || isNaN(Number(v)) ? 0 : Number(v));
  const txt = (v, max) => { const s = String(v == null ? '' : v).trim(); return s ? s.slice(0, max || 200) : null; };
  const pick = (v, list, d) => (list.includes(v) ? v : d);
  function httpError(status, msg) { const e = new Error(msg); e.status = status; e.publicMessage = msg; return e; }
  function fail(res, e) { const s = e.status || 500; if (s >= 500) console.error('[cyber]', e); res.status(s).json({ error: e.publicMessage || e.message }); }
  async function setting(key, d) { const { rows } = await query(`SELECT value FROM warehouse_settings WHERE key = $1`, [key]); return rows.length && rows[0].value != null && rows[0].value !== '' ? rows[0].value : d; }
  const putSetting = (k, v) => query(`INSERT INTO warehouse_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [k, String(v)]);

  // ------------------------------------------------------------ addresses --
  // The forwarded-for headers are only believed when the request came through
  // a proxy on this computer (a tunnel); anyone else could forge them to dodge
  // a block or get an innocent address blocked.
  const ipOf = (req) => {
    const peer = String((req.socket && req.socket.remoteAddress) || req.ip || '').replace(/^::ffff:/, '');
    if (!/^(127\.|::1$)/.test(peer)) return peer;
    const fwd = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'];
    return fwd ? String(fwd).split(',')[0].trim().replace(/^::ffff:/, '') : peer;
  };
  const isLoopback = (ip) => /^(127\.|::1$|localhost$)/.test(ip) || ip === '';
  const isPrivate = (ip) => isLoopback(ip) || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|fe80:|fc|fd)/i.test(ip);
  function ip4(ip) { const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip); return m ? ((+m[1] << 24) >>> 0) + (+m[2] << 16) + (+m[3] << 8) + +m[4] : null; }
  function inCidr(ip, cidr) {
    if (!cidr.includes('/')) return ip === cidr;
    const [base, bits] = cidr.split('/'), a = ip4(ip), b = ip4(base), k = parseInt(bits, 10);
    if (a == null || b == null || !(k >= 0 && k <= 32)) return false;
    const mask = k === 0 ? 0 : (~0 << (32 - k)) >>> 0;
    return ((a & mask) >>> 0) === ((b & mask) >>> 0);
  }
  const validCidr = (s) => { const [b, k] = String(s).split('/'); return (ip4(b) != null && (k == null || (+k >= 8 && +k <= 32))) || /^[0-9a-f:]+$/i.test(s); };

  // --------------------------------------------------------- threat store --
  // Repeats of the same kind + source update one open row; writes are batched.
  const pending = new Map();
  function raise(t) {
    const key = [t.kind, t.source_ip || '', t.user_id || 0, t.dedup || ''].join('|');
    const p = pending.get(key) || Object.assign({ count: 0, samples: [] }, t);
    p.count += t.count || 1;
    if (t.sample) { p.samples.push(Object.assign({ at: new Date().toISOString() }, t.sample)); if (p.samples.length > 10) p.samples.shift(); }
    if (SEVERITY_RANK[t.severity] > SEVERITY_RANK[p.severity]) p.severity = t.severity;
    pending.set(key, p);
  }
  async function flush() {
    if (!pending.size) return [];
    const batch = [...pending.values()]; pending.clear();
    const ids = [];
    for (const t of batch) {
      try {
        const { rows } = await query(
          `INSERT INTO sys_threats (kind, severity, title, source_ip, user_id, dedup, samples, count)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (kind, COALESCE(source_ip, ''), COALESCE(user_id, 0), COALESCE(dedup, '')) WHERE status IN ('new', 'acknowledged')
           DO UPDATE SET count = sys_threats.count + EXCLUDED.count, last_seen = NOW(),
                         severity = CASE WHEN array_position(ARRAY['low','medium','high','critical'], EXCLUDED.severity) > array_position(ARRAY['low','medium','high','critical'], sys_threats.severity) THEN EXCLUDED.severity ELSE sys_threats.severity END,
                         samples = (SELECT COALESCE(jsonb_agg(x), '[]') FROM (SELECT x FROM jsonb_array_elements(sys_threats.samples || EXCLUDED.samples) x OFFSET GREATEST(jsonb_array_length(sys_threats.samples || EXCLUDED.samples) - 10, 0)) s)
           RETURNING id, (xmax = 0) AS inserted`,
          [t.kind, t.severity, t.title.slice(0, 200), t.source_ip || null, t.user_id || null, t.dedup || null, JSON.stringify(t.samples), t.count]);
        ids.push(rows[0].id);
        if (rows[0].inserted && SEVERITY_RANK[t.severity] >= 3) alert(t);
      } catch (e) { console.warn('[cyber] threat write', e.message); }
    }
    return ids;
  }
  setInterval(() => { flush().catch(() => {}); }, 15000).unref();
  // High and critical threats are emailed to whoever handles security.
  async function alert(t) {
    if (devMode || !mailer || !mailer.sendEmail) return;
    try {
      const { rows } = await query(`SELECT email FROM users WHERE NOT disabled AND is_admin AND admin_role IN ('owner', 'manager') AND email IS NOT NULL AND email !~* '\\.local$'`);
      for (const r of rows) mailer.sendEmail({ to: r.email, subject: '[Security] ' + t.severity.toUpperCase() + ': ' + t.title, text: t.title + '\n\nWhat to do:\n- ' + (PLAYBOOKS[t.kind] || []).join('\n- ') + '\n\nOpen System management > Threats.' }).catch(() => {});
    } catch (_) {}
  }

  // ------------------------------------------------------------- blocking --
  let blocks = [], blocksAt = 0;
  async function loadBlocks(force) {
    if (!force && Date.now() - blocksAt < 30000) return blocks;
    const { rows } = await query(`SELECT id, cidr FROM sys_ip_blocks WHERE removed_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())`);
    blocks = rows; blocksAt = Date.now();
    return blocks;
  }
  async function block(cidr, reason, opts) {
    const o = opts || {};
    const { rows: ex } = await query(`SELECT id FROM sys_ip_blocks WHERE cidr = $1 AND removed_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())`, [cidr]);
    if (ex.length) return ex[0].id;
    const { rows } = await query(`INSERT INTO sys_ip_blocks (cidr, reason, auto, expires_at, threat_id, created_by) VALUES ($1,$2,$3, CASE WHEN $4::int > 0 THEN NOW() + make_interval(mins => $4::int) END, $5, $6) RETURNING id`,
      [cidr, String(reason).slice(0, 200), !!o.auto, o.minutes || 0, o.threat_id || null, o.by || null]);
    await loadBlocks(true);
    return rows[0].id;
  }

  // ------------------------------------------------------- at the door ---
  const SIGNS = [
    ['path_traversal', 'high', /(\.\.\/|\.\.\\|%2e%2e(%2f|%5c|\/)|%252e%252e)/i],
    ['sensitive_file', 'medium', /\/(\.env|\.git\/|\.svn|\.htaccess|\.DS_Store|wp-admin|wp-login|wp-content|xmlrpc\.php|phpmyadmin|pma\/|server-status|etc\/passwd|cgi-bin|\.aws\/|id_rsa|config\.php|web\.config|backup\.(sql|zip|tar))/i],
    ['php_probe', 'low', /\.(php|asp|aspx|jsp|cgi)(\?|$)/i],
    ['sql_injection', 'high', /(\bunion\b[\s\S]{0,40}\bselect\b|'\s*or\s+'?1'?\s*=\s*'?1|\bselect\b[\s\S]{0,40}\bfrom\b[\s\S]{0,40}\binformation_schema|\bsleep\(\s*\d|\bbenchmark\(|;\s*drop\s+table|xp_cmdshell|\bwaitfor\s+delay)/i],
    ['script_injection', 'medium', /(<script|%3cscript|javascript:|onerror\s*=|onload\s*=|<svg[^>]*on\w+=)/i],
    ['command_injection', 'high', /(;|\||`|\$\()\s*(cat|ls|wget|curl|bash|sh|powershell|cmd)\b/i],
  ];
  const win = new Map();   // ip -> { t0, attacks, missing, denied }
  const counter = (ip) => { let c = win.get(ip); const now = Date.now(); if (!c || now - c.t0 > 600000) { c = { t0: now, attacks: 0, missing: 0, denied: 0 }; win.set(ip, c); } return c; };
  setInterval(() => { const now = Date.now(); for (const [k, c] of win) if (now - c.t0 > 600000) win.delete(k); }, 300000).unref();
  let cfg = { autoblock: true, hits: 10, minutes: 60, scan404: 40, headers: true }, cfgAt = 0;
  async function loadCfg() {
    if (Date.now() - cfgAt < 30000) return cfg;
    cfg = { autoblock: (await setting('sys_autoblock', 'on')) === 'on', hits: n(await setting('sys_autoblock_hits', '10')) || 10, minutes: n(await setting('sys_autoblock_minutes', '60')) || 60,
      scan404: n(await setting('sys_scan_404', '40')) || 40, headers: (await setting('sys_secure_headers', 'on')) === 'on' };
    cfgAt = Date.now();
    return cfg;
  }
  async function autoBlock(ip, why) {
    const c = await loadCfg();
    if (!c.autoblock || isPrivate(ip)) return;
    const id = await block(ip, 'Automatic: ' + why, { auto: true, minutes: c.minutes });
    raise({ kind: 'web_attack', severity: 'high', title: 'Address ' + ip + ' blocked automatically: ' + why, source_ip: ip, sample: { action: 'blocked for ' + c.minutes + ' min', block_id: id } });
  }
  app.use(async (req, res, next) => {
    const ip = ipOf(req);
    try {
      const c = await loadCfg();
      if (c.headers) {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        if (!res.getHeader('X-Frame-Options')) res.setHeader('X-Frame-Options', 'SAMEORIGIN');
        res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      }
      if (!isLoopback(ip)) {
        const bl = await loadBlocks(false);
        const hit = bl.find((b) => inCidr(ip, b.cidr));
        if (hit) {
          query(`UPDATE sys_ip_blocks SET hits = hits + 1, last_hit_at = NOW() WHERE id = $1`, [hit.id]).catch(() => {});
          return res.status(403).type('text/plain').send('Access from your address is blocked. If this is a mistake, call the shop.');
        }
      }
      let target = req.originalUrl || req.url || '';
      try { target = decodeURIComponent(target); } catch (_) {}
      for (const [sub, sev, re] of SIGNS) {
        if (!re.test(target)) continue;
        const cnt = counter(ip); cnt.attacks++;
        raise({ kind: 'web_attack', severity: sev, title: 'Attack attempts from ' + ip + ' (' + sub.replace(/_/g, ' ') + ')', source_ip: ip, sample: { kind: sub, method: req.method, path: target.slice(0, 200), agent: String(req.headers['user-agent'] || '').slice(0, 120) } });
        if (cnt.attacks >= c.hits) autoBlock(ip, cnt.attacks + ' attack attempts in 10 minutes').catch(() => {});
        if (sev === 'high') return res.status(400).type('text/plain').send('Bad request');
        break;
      }
      res.on('finish', () => {
        if (isLoopback(ip)) return;
        const s = res.statusCode;
        if (s !== 404 && s !== 401 && s !== 403) return;
        const cnt = counter(ip);
        if (s === 404) cnt.missing++; else cnt.denied++;
        if (cnt.missing === c.scan404) {
          raise({ kind: 'scanning', severity: 'medium', title: ip + ' asked for ' + c.scan404 + '+ missing pages in 10 minutes (scanning)', source_ip: ip, sample: { last_path: String(req.originalUrl).slice(0, 200) } });
          autoBlock(ip, 'scanning for pages').catch(() => {});
        }
        if (cnt.denied === 60) raise({ kind: 'scanning', severity: 'medium', title: ip + ' was refused access 60 times in 10 minutes', source_ip: ip, sample: { last_path: String(req.originalUrl).slice(0, 200) } });
      });
    } catch (_) { /* the door-keeper never takes the site down */ }
    next();
  });

  // ------------------------------------------------- detector (audit log) --
  let detecting = false;
  async function detect() {
    if (detecting) return { busy: true };
    detecting = true;
    try {
      const last = n(await setting('sys_threat_last_audit_id', '0'));
      const { rows: mx } = await query(`SELECT COALESCE(MAX(id), 0) AS m FROM audit_log`);
      const upto = Number(mx[0].m);
      if (upto <= last) return { checked: 0 };
      const range = [last, upto];
      // Password guessing on one account.
      const { rows: bf } = await query(
        `SELECT user_id, MAX(user_name) AS name, COUNT(*)::int AS n, array_agg(DISTINCT ip) AS ips FROM audit_log
          WHERE id > $1 AND id <= $2 AND action IN ('signin_failed', 'locked') AND user_id IS NOT NULL GROUP BY user_id HAVING COUNT(*) >= 5`, range);
      for (const r of bf) raise({ kind: 'brute_force', severity: r.n >= 10 ? 'high' : 'medium', title: r.n + ' wrong passwords on ' + (r.name || 'an account'), user_id: r.user_id, count: r.n, sample: { from: r.ips } });
      // One address, many accounts.
      const { rows: cs } = await query(
        `SELECT ip, COUNT(*)::int AS n, COUNT(DISTINCT COALESCE(user_id::text, detail->>'email'))::int AS accounts FROM audit_log
          WHERE id > $1 AND id <= $2 AND action IN ('signin_failed', 'locked') AND ip IS NOT NULL GROUP BY ip HAVING COUNT(DISTINCT COALESCE(user_id::text, detail->>'email')) >= 3`, range);
      for (const r of cs) {
        raise({ kind: 'credential_stuffing', severity: 'high', title: ip0(r.ip) + ' tried passwords on ' + r.accounts + ' accounts', source_ip: r.ip, count: r.n, sample: { attempts: r.n, accounts: r.accounts } });
        if (r.accounts >= 3) autoBlock(r.ip, 'tried passwords on ' + r.accounts + ' accounts').catch(() => {});
      }
      // Owners / managers signing in from an address not seen for them in 60 days.
      const { rows: nl } = await query(
        `SELECT a.user_id, a.user_name, a.ip, a.remote, a.at FROM audit_log a JOIN users u ON u.id = a.user_id
          WHERE a.id > $1 AND a.id <= $2 AND a.action = 'signin' AND u.admin_role IN ('owner', 'manager') AND a.ip IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM audit_log b WHERE b.user_id = a.user_id AND b.ip = a.ip AND b.action = 'signin' AND b.id < a.id AND b.at > a.at - INTERVAL '60 days')
            AND EXISTS (SELECT 1 FROM audit_log c WHERE c.user_id = a.user_id AND c.action = 'signin' AND c.id < a.id)`, range);
      for (const r of nl) raise({ kind: 'new_location', severity: r.remote ? 'medium' : 'low', title: (r.user_name || 'A manager') + ' signed in from a new address ' + r.ip, user_id: r.user_id, source_ip: r.ip, sample: { at: r.at, remote: r.remote } });
      // Many deletions by one person in a short time.
      const { rows: md } = await query(
        `SELECT user_id, MAX(user_name) AS name, COUNT(*)::int AS n FROM audit_log WHERE id > $1 AND id <= $2 AND action ~ '^DELETE ' AND user_id IS NOT NULL
          GROUP BY user_id, date_trunc('hour', at) HAVING COUNT(*) >= 20`, range);
      for (const r of md) raise({ kind: 'mass_delete', severity: 'high', title: (r.name || 'Someone') + ' deleted ' + r.n + ' records within an hour', user_id: r.user_id, count: r.n });
      // Permission / role / security-setting changes.
      const { rows: pc } = await query(
        `SELECT id, user_id, user_name, action, target, at FROM audit_log WHERE id > $1 AND id <= $2
            AND action ~ '^(POST|PUT|PATCH|DELETE) /api/(admin/(users/:id/(perms|role|categories)|roles|categories)|sec/settings|sys/(cyber-settings|signout-all))'`, range);
      for (const r of pc) raise({ kind: 'privilege_change', severity: 'medium', title: 'Permissions or security settings changed by ' + (r.user_name || 'someone'), user_id: r.user_id, sample: { action: r.action, target: r.target, at: r.at } });
      // Big exports.
      const { rows: ex } = await query(`SELECT user_id, user_name, detail, at FROM audit_log WHERE id > $1 AND id <= $2 AND action = 'audit_export' AND (detail->>'rows')::int >= 5000`, range);
      for (const r of ex) raise({ kind: 'data_export', severity: 'medium', title: (r.user_name || 'Someone') + ' exported ' + r.detail.rows + ' audit entries', user_id: r.user_id, sample: { at: r.at } });
      // Many voids by one person in a day.
      const { rows: fv } = await query(
        `SELECT s.voided_by AS user_id, u.name, COUNT(*)::int AS n, SUM(s.total_usd)::float AS total FROM pos_sales s LEFT JOIN users u ON u.id = s.voided_by
          WHERE s.voided AND s.voided_at > NOW() - INTERVAL '24 hours' AND s.voided_by IS NOT NULL GROUP BY s.voided_by, u.name HAVING COUNT(*) >= 5`).catch(() => ({ rows: [] }));
      for (const r of fv) raise({ kind: 'fraud_pattern', severity: 'high', title: (r.name || 'Someone') + ' voided ' + r.n + ' sales in a day (J$' + Math.round(r.total).toLocaleString() + ')', user_id: r.user_id, dedup: new Date().toISOString().slice(0, 10), count: r.n });
      // Audit log tampering.
      const v = await sysops.verifyChain();
      if (!v.ok) raise({ kind: 'audit_tamper', severity: 'critical', title: 'Audit log tampered with at entry ' + v.broken.id + ': ' + v.broken.problem, dedup: String(v.broken.id) });
      await putSetting('sys_threat_last_audit_id', upto);
      await flush();
      return { checked: upto - last };
    } finally { detecting = false; }
  }
  const ip0 = (s) => s || 'an address';
  setInterval(() => { detect().catch((e) => console.warn('[cyber] detect', e.message)); }, 300000).unref();

  // ---------------------------------------------------------- threats API --
  app.get('/api/sys/threats', ...SEC, async (req, res) => {
    try {
      await flush();
      const st = req.query.status === 'all' ? null : req.query.status === 'closed' ? ['mitigated', 'false_positive'] : ['new', 'acknowledged'];
      const { rows } = await query(
        `SELECT t.*, u.name AS user_name, h.name AS handled_by_name, i.number AS incident_number FROM sys_threats t LEFT JOIN users u ON u.id = t.user_id LEFT JOIN users h ON h.id = t.handled_by LEFT JOIN sys_incidents i ON i.id = t.incident_id
          WHERE ($1::text[] IS NULL OR t.status = ANY($1)) ORDER BY CASE t.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, t.last_seen DESC LIMIT 300`, [st]);
      for (const t of rows) t.playbook = PLAYBOOKS[t.kind] || [];
      const { rows: sum } = await query(`SELECT severity, COUNT(*)::int AS n FROM sys_threats WHERE status IN ('new', 'acknowledged') GROUP BY severity`);
      res.json({ threats: rows, open_by_severity: Object.fromEntries(sum.map((r) => [r.severity, r.n])) });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/sys/threats/scan', ...SEC, async (req, res) => {
    try { const r = await detect(); res.json(Object.assign({ ok: true }, r)); } catch (e) { fail(res, e); }
  });
  app.post('/api/sys/threats/:id/action', ...SEC, async (req, res) => {
    try {
      const b = req.body || {}, id = parseInt(req.params.id, 10) || 0;
      const { rows } = await query(`SELECT * FROM sys_threats WHERE id = $1`, [id]);
      if (!rows.length) throw httpError(404, 'Not found');
      const t = rows[0], uid = req.session.userId, note = txt(b.note, 500);
      const action = pick(b.action, ['acknowledge', 'block_ip', 'lock_user', 'signout_user', 'incident', 'mitigated', 'false_positive'], null);
      if (!action) throw httpError(400, 'Which action?');
      let done = action, status = null;
      if (action === 'acknowledge') status = 'acknowledged';
      if (action === 'mitigated' || action === 'false_positive') { if (!note) throw httpError(400, action === 'mitigated' ? 'Say what was done' : 'Say why it is not a threat'); status = action; }
      if (action === 'block_ip') {
        const ip = txt(b.cidr, 60) || t.source_ip;
        if (!ip || !validCidr(ip)) throw httpError(400, 'No address to block');
        if (isLoopback(ip)) throw httpError(400, 'The server\'s own address cannot be blocked');
        const mins = Math.max(0, parseInt(b.minutes, 10) || 0);
        await block(ip, 'Threat #' + id + ': ' + (note || t.title), { minutes: mins, threat_id: id, by: uid });
        done = 'blocked ' + ip + (mins ? ' for ' + mins + ' min' : ' until removed');
        if (!status) status = 'acknowledged';
      }
      if (action === 'lock_user' || action === 'signout_user') {
        if (!t.user_id) throw httpError(400, 'This threat is not about one account');
        if (t.user_id === uid) throw httpError(409, 'Not on your own account');
        if (action === 'lock_user') await query(`UPDATE users SET locked_until = NOW() + INTERVAL '24 hours' WHERE id = $1`, [t.user_id]);
        await sysops.revokeSessions(t.user_id);
        done = action === 'lock_user' ? 'account locked for 24 h and signed out' : 'signed out everywhere';
        if (!status) status = 'acknowledged';
      }
      if (action === 'incident') {
        if (t.incident_id) throw httpError(409, 'Already linked to an incident');
        const { rows: c } = await query(`SELECT COALESCE(MAX(id), 0) + 1 AS n FROM sys_incidents`);
        const num = 'INC-' + String(c[0].n).padStart(4, '0');
        const kind = t.kind === 'fraud_pattern' ? 'fraud' : t.kind === 'data_export' ? 'privacy' : t.kind === 'network_down' ? 'outage' : 'security';
        const { rows: inc } = await query(`INSERT INTO sys_incidents (number, title, kind, severity, description, reported_by, timeline) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [num, t.title.slice(0, 160), kind, t.severity, 'From threat #' + id + ' (' + t.kind + ', seen ' + t.count + ' times).' + (note ? '\n' + note : ''), uid, JSON.stringify([{ at: new Date().toISOString(), by: uid, status: 'open', note: 'Opened from threat #' + id }])]);
        await query(`UPDATE sys_threats SET incident_id = $2 WHERE id = $1`, [id, inc[0].id]);
        done = 'incident ' + num;
        if (!status) status = 'acknowledged';
      }
      const actions = (t.actions || []).concat([{ at: new Date().toISOString(), by: uid, action: done, note }]);
      await query(`UPDATE sys_threats SET actions = $2, status = COALESCE($3, status), handled_by = $4, handled_at = NOW() WHERE id = $1`, [id, JSON.stringify(actions), status, uid]);
      await sysops.audit(req, 'threat_' + action, { threat: id, kind: t.kind, done });
      res.json({ ok: true, done });
    } catch (e) { fail(res, e); }
  });

  // Blocked addresses.
  app.get('/api/sys/blocks', ...SEC, async (req, res) => {
    try {
      const { rows } = await query(`SELECT b.*, u.name AS created_by_name, (b.removed_at IS NULL AND (b.expires_at IS NULL OR b.expires_at > NOW())) AS active
                                      FROM sys_ip_blocks b LEFT JOIN users u ON u.id = b.created_by ORDER BY active DESC, b.id DESC LIMIT 300`);
      res.json({ blocks: rows });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/sys/blocks', ...SEC, async (req, res) => {
    try {
      const b = req.body || {};
      const cidr = txt(b.cidr, 60), reason = txt(b.reason, 200);
      if (!cidr || !validCidr(cidr)) throw httpError(400, 'Enter an address (203.0.113.7) or range (203.0.113.0/24)');
      if (isLoopback(cidr)) throw httpError(400, 'The server\'s own address cannot be blocked');
      if (!reason) throw httpError(400, 'Say why');
      const mine = ipOf(req);
      if (inCidr(mine, cidr)) throw httpError(409, 'That would block you (' + mine + ')');
      const id = await block(cidr, reason, { minutes: Math.max(0, parseInt(b.minutes, 10) || 0), by: req.session.userId });
      await sysops.audit(req, 'ip_blocked', { cidr, reason });
      res.json({ ok: true, id });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/sys/blocks/:id/remove', ...SEC, async (req, res) => {
    try {
      const { rows } = await query(`UPDATE sys_ip_blocks SET removed_at = NOW(), removed_by = $2 WHERE id = $1 AND removed_at IS NULL RETURNING cidr`, [parseInt(req.params.id, 10) || 0, req.session.userId]);
      if (!rows.length) throw httpError(404, 'Not found or already removed');
      await loadBlocks(true);
      await sysops.audit(req, 'ip_unblocked', { cidr: rows[0].cidr });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // Settings for the automatic defences.
  app.get('/api/sys/cyber-settings', ...SEC, async (req, res) => {
    try { cfgAt = 0; res.json({ settings: await loadCfg() }); } catch (e) { fail(res, e); }
  });
  app.put('/api/sys/cyber-settings', ...SEC, async (req, res) => {
    try {
      const b = req.body || {};
      if ('autoblock' in b) await putSetting('sys_autoblock', b.autoblock ? 'on' : 'off');
      if ('headers' in b) await putSetting('sys_secure_headers', b.headers ? 'on' : 'off');
      if ('hits' in b) await putSetting('sys_autoblock_hits', Math.max(3, Math.min(100, n(b.hits) || 10)));
      if ('minutes' in b) await putSetting('sys_autoblock_minutes', Math.max(5, Math.min(10080, n(b.minutes) || 60)));
      if ('scan404' in b) await putSetting('sys_scan_404', Math.max(10, Math.min(1000, n(b.scan404) || 40)));
      cfgAt = 0;
      res.json({ ok: true, settings: await loadCfg() });
    } catch (e) { fail(res, e); }
  });

  // --------------------------------------------------------- risk register --
  const R_CATS = ['cyber', 'network', 'people', 'process', 'physical', 'third_party', 'compliance', 'data'];
  const r15 = (v, d) => { const x = parseInt(v, 10); return x >= 1 && x <= 5 ? x : d; };
  app.get('/api/sys/risks', ...SEC, async (req, res) => {
    try {
      const { rows } = await query(`SELECT r.*, to_char(r.review_date, 'YYYY-MM-DD') AS review_date, u.name AS owner_name, r.likelihood * r.impact AS score,
                                           COALESCE(r.residual_likelihood, r.likelihood) * COALESCE(r.residual_impact, r.impact) AS residual_score,
                                           (r.review_date < CURRENT_DATE AND r.status NOT IN ('closed')) AS review_overdue
                                      FROM sys_risks r LEFT JOIN users u ON u.id = r.owner_id ORDER BY r.status = 'closed', r.likelihood * r.impact DESC, r.id`);
      res.json({ risks: rows });
    } catch (e) { fail(res, e); }
  });
  function riskValues(b, cur) {
    const v = {
      title: 'title' in b ? txt(b.title, 160) : cur && cur.title, category: b.category ? pick(b.category, R_CATS, 'cyber') : (cur ? cur.category : 'cyber'),
      description: 'description' in b ? txt(b.description, 2000) : cur && cur.description, mitigation: 'mitigation' in b ? txt(b.mitigation, 2000) : cur && cur.mitigation,
      likelihood: r15(b.likelihood, cur ? cur.likelihood : 3), impact: r15(b.impact, cur ? cur.impact : 3),
      residual_likelihood: 'residual_likelihood' in b ? r15(b.residual_likelihood, null) : cur && cur.residual_likelihood, residual_impact: 'residual_impact' in b ? r15(b.residual_impact, null) : cur && cur.residual_impact,
      owner_id: 'owner_id' in b ? (parseInt(b.owner_id, 10) || null) : cur && cur.owner_id, status: b.status ? pick(b.status, ['open', 'mitigating', 'accepted', 'closed'], 'open') : (cur ? cur.status : 'open'),
      review_date: 'review_date' in b ? (/^\d{4}-\d{2}-\d{2}$/.test(b.review_date || '') ? b.review_date : null) : cur && cur.review_date,
    };
    if (!v.title) throw httpError(400, 'Name the risk');
    if (v.likelihood * v.impact >= 12 && !v.mitigation && v.status !== 'accepted') throw httpError(400, 'A high risk (score 12+) needs a mitigation plan, or to be formally accepted');
    return v;
  }
  const RISK_COLS = ['title', 'category', 'description', 'mitigation', 'likelihood', 'impact', 'residual_likelihood', 'residual_impact', 'owner_id', 'status', 'review_date'];
  app.post('/api/sys/risks', ...SEC, async (req, res) => {
    try {
      const v = riskValues(req.body || {}, null);
      const { rows: c } = await query(`SELECT COALESCE(MAX(id), 0) + 1 AS n FROM sys_risks`);
      const num = 'RSK-' + String(c[0].n).padStart(4, '0');
      const { rows } = await query(`INSERT INTO sys_risks (number, ${RISK_COLS.join(', ')}, created_by) VALUES ($1, ${RISK_COLS.map((_, i) => '$' + (i + 2)).join(', ')}, $${RISK_COLS.length + 2}) RETURNING id`,
        [num, ...RISK_COLS.map((k) => v[k]), req.session.userId]);
      res.json({ ok: true, id: rows[0].id, number: num });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/sys/risks/:id', ...SEC, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10) || 0;
      const { rows } = await query(`SELECT *, to_char(review_date, 'YYYY-MM-DD') AS review_date FROM sys_risks WHERE id = $1`, [id]);
      if (!rows.length) throw httpError(404, 'Not found');
      const v = riskValues(req.body || {}, rows[0]);
      await query(`UPDATE sys_risks SET ${RISK_COLS.map((k, i) => k + ' = $' + (i + 2)).join(', ')}, updated_at = NOW() WHERE id = $1`, [id, ...RISK_COLS.map((k) => v[k])]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ---------------------------------------------------- software & patches --
  const NODE_EOL = { 18: '2025-04-30', 20: '2026-04-30', 22: '2027-04-30', 24: '2028-04-30' };
  function nodeStatus() {
    const major = parseInt(process.versions.node.split('.')[0], 10);
    const eol = NODE_EOL[major] || null, today = new Date().toISOString().slice(0, 10);
    return { version: process.version, major, eol, supported: !!eol && eol > today && major % 2 === 0 };
  }
  app.get('/api/sys/software', ...SEC, async (req, res) => {
    try {
      const appDir = __dirname;
      const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
      const deps = Object.assign({}, pkg.dependencies || {});
      const out = [];
      for (const [name, wanted] of Object.entries(deps)) {
        let version = null;
        for (const base of [path.join(appDir, 'node_modules'), path.join(appDir, '..', 'data', 'ai-deps', 'node_modules')]) {
          try { version = JSON.parse(fs.readFileSync(path.join(base, name, 'package.json'), 'utf8')).version; break; } catch (_) {}
        }
        out.push({ name, wanted, installed: version });
      }
      const { rows: db } = await query(`SELECT version() AS v`);
      res.json({ node: nodeStatus(), os: os.type() + ' ' + os.release(), database: String(db[0].v).split(',')[0], app_version: pkg.version, packages: out.sort((a, b) => a.name.localeCompare(b.name)) });
    } catch (e) { fail(res, e); }
  });

  // =========================================================== NETWORK ====
  function run(cmd, args, ms) {
    return new Promise((resolve) => {
      execFile(cmd, args, { timeout: ms || 8000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => resolve(err && !stdout ? '' : String(stdout || '')));
    });
  }
  const isWin = process.platform === 'win32';
  // Ports this server listens on, with what they are and whether they are exposed.
  const PORT_NAMES = { 135: 'Windows RPC', 139: 'Windows file sharing (NetBIOS)', 445: 'Windows file sharing (SMB)', 3389: 'Remote Desktop', 5433: 'PostgreSQL database (this system)', 5432: 'PostgreSQL database', 3056: 'Vision Auto Solutions (shop system)', 3057: 'Vision Auto Solutions (phones / scanners, HTTPS)', 3099: 'Vision Auto Solutions (test copy)', 3040: 'another web app', 22: 'SSH', 21: 'FTP', 23: 'Telnet', 80: 'Web', 443: 'Web (HTTPS)', 5900: 'VNC remote control', 1433: 'SQL Server', 3306: 'MySQL' };
  const RISKY = { 3389: 'Remote Desktop open to the network: a favourite way in for ransomware. Allow it only through a VPN, or turn it off.', 445: 'File sharing open to the network: keep it on the shop network only, never on the internet.', 139: 'Old file sharing (NetBIOS): turn it off if nothing needs it.', 23: 'Telnet sends passwords in clear text: turn it off.', 21: 'FTP sends passwords in clear text: use something else.', 5900: 'Remote control (VNC) open: use a VPN or turn it off.' };
  async function listeningPorts() {
    const raw = isWin ? await run('netstat', ['-ano', '-p', 'tcp']) : await run('netstat', ['-ltn']);
    const out = new Map();
    for (const line of raw.split(/\r?\n/)) {
      const m = isWin ? /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line) : /^tcp6?\s+\d+\s+\d+\s+(\S+):(\d+)\s+\S+\s+LISTEN/i.exec(line);
      if (!m) continue;
      const addr = m[1], port = parseInt(m[2], 10);
      if (port >= 49152) continue;   // Windows dynamic ports
      const local = /^(127\.|\[?::1\]?$)/.test(addr);
      const key = port;
      const prev = out.get(key);
      const exposed = !local;
      if (!prev || (exposed && !prev.exposed)) out.set(key, { port, address: addr, exposed, name: PORT_NAMES[port] || null, risk: exposed ? RISKY[port] || null : null });
    }
    return [...out.values()].sort((a, b) => a.port - b.port);
  }
  async function firewall() {
    if (!isWin) return null;
    const raw = await run('netsh', ['advfirewall', 'show', 'allprofiles', 'state']);
    const profiles = {};
    let cur = null;
    for (const line of raw.split(/\r?\n/)) {
      const p = /^(\w+) Profile Settings/i.exec(line); if (p) cur = p[1].toLowerCase();
      const s = /^State\s+(ON|OFF)/i.exec(line.trim()); if (s && cur) profiles[cur] = s[1].toUpperCase() === 'ON';
    }
    return Object.keys(profiles).length ? profiles : null;
  }
  const normMac = (m) => String(m || '').toLowerCase().replace(/[^0-9a-f]/g, '').replace(/(..)(?!$)/g, '$1:');
  async function lanDevices() {
    const raw = await run('arp', ['-a']);
    const devices = [];
    for (const line of raw.split(/\r?\n/)) {
      const m = /^\s*(\d+\.\d+\.\d+\.\d+)\s+([0-9a-f]{2}[-:][0-9a-f]{2}[-:][0-9a-f]{2}[-:][0-9a-f]{2}[-:][0-9a-f]{2}[-:][0-9a-f]{2})\s+(\w+)/i.exec(line);
      if (!m) continue;
      const mac = normMac(m[2]);
      if (mac === 'ff:ff:ff:ff:ff:ff' || /^01:00:5e/.test(mac) || /^33:33/.test(mac) || /\.255$/.test(m[1])) continue;
      devices.push({ ip: m[1], mac, type: m[3].toLowerCase() });
    }
    const { rows: known } = await query(`SELECT id, tag, name, kind, lower(regexp_replace(COALESCE(mac, ''), '[^0-9a-fA-F]', '', 'g')) AS m, ip FROM sys_assets WHERE status <> 'retired'`);
    for (const d of devices) {
      const k = known.find((a) => (a.m && a.m === d.mac.replace(/:/g, '')) || (a.ip && a.ip === d.ip));
      d.asset = k ? { id: k.id, tag: k.tag, name: k.name, kind: k.kind } : null;
    }
    return devices;
  }
  function interfaces() {
    const out = [];
    for (const [name, list] of Object.entries(os.networkInterfaces())) for (const a of list || []) if (!a.internal && a.family === 'IPv4') out.push({ name, address: a.address, netmask: a.netmask, mac: a.mac });
    return out;
  }

  // Monitoring: ping, TCP connect or HTTP GET.
  async function checkTarget(t) {
    const t0 = Date.now();
    let ok = false, err = null;
    try {
      if (t.kind === 'tcp') {
        ok = await new Promise((resolve) => {
          const s = net.connect({ host: t.host, port: t.port, timeout: 3000 });
          s.on('connect', () => { s.destroy(); resolve(true); });
          s.on('timeout', () => { s.destroy(); err = 'no answer in 3 s'; resolve(false); });
          s.on('error', (e) => { err = e.code || e.message; resolve(false); });
        });
      } else if (t.kind === 'http') {
        const ctrl = new AbortController(); const tm = setTimeout(() => ctrl.abort(), 6000);
        try { const r = await fetch(t.url, { signal: ctrl.signal, redirect: 'manual' }); ok = r.status < 500; if (!ok) err = 'HTTP ' + r.status; } catch (e) { err = e.name === 'AbortError' ? 'no answer in 6 s' : (e.cause && e.cause.code) || e.message; }
        clearTimeout(tm);
      } else {
        const out = await run('ping', isWin ? ['-n', '1', '-w', '2000', t.host] : ['-c', '1', '-W', '2', t.host], 5000);
        ok = isWin ? /TTL=/i.test(out) : / 0% packet loss/.test(out);
        if (!ok) err = 'no reply';
      }
    } catch (e) { err = e.message; }
    const ms = Date.now() - t0;
    await query(`INSERT INTO sys_net_checks (target_id, ok, ms) VALUES ($1,$2,$3)`, [t.id, ok, ok ? ms : null]);
    const wasDown = t.last_ok === false;
    await query(`UPDATE sys_net_targets SET last_ok = $2, last_ms = $3, last_error = $4, last_checked = NOW(),
                   down_since = CASE WHEN $2 THEN NULL WHEN down_since IS NULL THEN NOW() ELSE down_since END WHERE id = $1`, [t.id, ok, ok ? ms : null, ok ? null : String(err || 'failed').slice(0, 200)]);
    if (!ok && !wasDown) raise({ kind: 'network_down', severity: t.critical ? 'high' : 'medium', title: t.name + ' is not answering', dedup: 'target-' + t.id, sample: { error: err } });
    if (ok && wasDown) {
      await query(`UPDATE sys_threats SET status = 'mitigated', actions = actions || $2::jsonb, handled_at = NOW() WHERE kind = 'network_down' AND dedup = $1 AND status IN ('new', 'acknowledged')`,
        ['target-' + t.id, JSON.stringify([{ at: new Date().toISOString(), action: 'came back up by itself' }])]);
    }
    return { ok, ms, error: err };
  }
  let monitoring = false;
  async function monitorTick() {
    if (monitoring) return; monitoring = true;
    try {
      const { rows } = await query(`SELECT * FROM sys_net_targets WHERE enabled AND (last_checked IS NULL OR last_checked < NOW() - make_interval(secs => interval_s))`);
      for (const t of rows) await checkTarget(t).catch(() => {});
      await query(`DELETE FROM sys_net_checks WHERE at < NOW() - INTERVAL '14 days'`);
      await flush();
    } finally { monitoring = false; }
  }
  // Live only: the test copy does not watch the real network on its own.
  if (!devMode) setInterval(() => { monitorTick().catch((e) => console.warn('[cyber] monitor', e.message)); }, 30000).unref();

  app.get('/api/sys/network', ...NET, async (req, res) => {
    try {
      const { rows: targets } = await query(
        `SELECT t.*, a.tag AS asset_tag,
                (SELECT ROUND(100.0 * AVG(CASE WHEN c.ok THEN 1 ELSE 0 END), 1) FROM sys_net_checks c WHERE c.target_id = t.id AND c.at > NOW() - INTERVAL '24 hours') AS uptime_24h,
                (SELECT ROUND(100.0 * AVG(CASE WHEN c.ok THEN 1 ELSE 0 END), 1) FROM sys_net_checks c WHERE c.target_id = t.id AND c.at > NOW() - INTERVAL '7 days') AS uptime_7d,
                (SELECT ROUND(AVG(c.ms)) FROM sys_net_checks c WHERE c.target_id = t.id AND c.ok AND c.at > NOW() - INTERVAL '24 hours') AS avg_ms_24h
           FROM sys_net_targets t LEFT JOIN sys_assets a ON a.id = t.asset_id ORDER BY t.critical DESC, t.name`);
      const { rows: networks } = await query(`SELECT *, to_char(password_changed_at, 'YYYY-MM-DD') AS password_changed_at FROM sys_networks ORDER BY name`);
      const [ports, fw] = await Promise.all([listeningPorts(), firewall()]);
      res.json({ interfaces: interfaces(), hostname: os.hostname(), ports, firewall: fw, targets, networks, monitoring: !devMode });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/sys/lan-devices', ...NET, async (req, res) => {
    try {
      const devices = await lanDevices();
      // Unknown devices become a (low) threat each, until registered or dismissed.
      for (const d of devices.filter((x) => !x.asset)) raise({ kind: 'unknown_device', severity: 'low', title: 'Unregistered device on the network: ' + d.ip + ' (' + d.mac + ')', source_ip: d.ip, dedup: d.mac, sample: { ip: d.ip, mac: d.mac } });
      await flush();
      res.json({ devices, unknown: devices.filter((x) => !x.asset).length });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/sys/lan-devices/register', ...NET, async (req, res) => {
    try {
      const b = req.body || {};
      const name = txt(b.name, 120), mac = normMac(b.mac);
      if (!name || mac.length !== 17) throw httpError(400, 'Name the device');
      const { rows: c } = await query(`SELECT COALESCE(MAX(id), 0) + 1 AS n FROM sys_assets`);
      const tag = 'IT-' + String(c[0].n).padStart(4, '0');
      const { rows } = await query(`INSERT INTO sys_assets (tag, name, kind, ip, mac, location, notes) VALUES ($1,$2,$3,$4,$5,$6,'Registered from the network scan') RETURNING id`,
        [tag, name, pick(b.kind, ['pc', 'till', 'server', 'printer', 'receipt_printer', 'label_printer', 'scanner', 'phone', 'tablet', 'router', 'switch', 'ups', 'camera', 'other'], 'other'), txt(b.ip, 60), mac, txt(b.location, 120)]);
      await query(`UPDATE sys_threats SET status = 'mitigated', handled_by = $2, handled_at = NOW(), actions = actions || $3::jsonb WHERE kind = 'unknown_device' AND dedup = $1 AND status IN ('new', 'acknowledged')`,
        [mac, req.session.userId, JSON.stringify([{ at: new Date().toISOString(), by: req.session.userId, action: 'registered as ' + tag }])]);
      res.json({ ok: true, id: rows[0].id, tag });
    } catch (e) { fail(res, e); }
  });
  const T_KINDS = ['ping', 'tcp', 'http'];
  function targetValues(b, cur) {
    const v = {
      name: 'name' in b ? txt(b.name, 120) : cur && cur.name, kind: b.kind ? pick(b.kind, T_KINDS, 'ping') : (cur ? cur.kind : 'ping'),
      host: 'host' in b ? txt(b.host, 200) : cur && cur.host, port: 'port' in b ? (parseInt(b.port, 10) || null) : cur && cur.port, url: 'url' in b ? txt(b.url, 300) : cur && cur.url,
      interval_s: 'interval_s' in b ? Math.max(30, Math.min(3600, parseInt(b.interval_s, 10) || 60)) : (cur ? cur.interval_s : 60),
      critical: 'critical' in b ? !!b.critical : (cur ? cur.critical : false), enabled: 'enabled' in b ? !!b.enabled : (cur ? cur.enabled : true),
      asset_id: 'asset_id' in b ? (parseInt(b.asset_id, 10) || null) : cur && cur.asset_id,
    };
    if (!v.name) throw httpError(400, 'Name what is being watched');
    if (v.kind === 'http' && !/^https?:\/\//i.test(v.url || '')) throw httpError(400, 'Enter the web address (http:// or https://)');
    if (v.kind !== 'http' && !/^[a-z0-9.\-:]+$/i.test(v.host || '')) throw httpError(400, 'Enter the device address or name');
    if (v.kind === 'tcp' && !(v.port > 0 && v.port < 65536)) throw httpError(400, 'Enter the port');
    return v;
  }
  const T_COLS = ['name', 'kind', 'host', 'port', 'url', 'interval_s', 'critical', 'enabled', 'asset_id'];
  app.post('/api/sys/net-targets', ...NET, async (req, res) => {
    try {
      const v = targetValues(req.body || {}, null);
      const { rows } = await query(`INSERT INTO sys_net_targets (${T_COLS.join(', ')}) VALUES (${T_COLS.map((_, i) => '$' + (i + 1)).join(', ')}) RETURNING id`, T_COLS.map((k) => v[k]));
      res.json({ ok: true, id: rows[0].id });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/sys/net-targets/:id', ...NET, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10) || 0;
      const { rows } = await query(`SELECT * FROM sys_net_targets WHERE id = $1`, [id]);
      if (!rows.length) throw httpError(404, 'Not found');
      const v = targetValues(req.body || {}, rows[0]);
      await query(`UPDATE sys_net_targets SET ${T_COLS.map((k, i) => k + ' = $' + (i + 2)).join(', ')} WHERE id = $1`, [id, ...T_COLS.map((k) => v[k])]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.delete('/api/sys/net-targets/:id', ...NET, async (req, res) => {
    try { await query(`DELETE FROM sys_net_targets WHERE id = $1`, [parseInt(req.params.id, 10) || 0]); res.json({ ok: true }); } catch (e) { fail(res, e); }
  });
  app.post('/api/sys/net-targets/:id/check', ...NET, async (req, res) => {
    try {
      const { rows } = await query(`SELECT * FROM sys_net_targets WHERE id = $1`, [parseInt(req.params.id, 10) || 0]);
      if (!rows.length) throw httpError(404, 'Not found');
      const r = await checkTarget(rows[0]);
      await flush();
      res.json(Object.assign({ ok: true }, { result: r }));
    } catch (e) { fail(res, e); }
  });
  // The shop's networks (Wi-Fi, wired, VLANs).
  const N_COLS = ['name', 'purpose', 'ssid', 'subnet', 'vlan', 'security', 'isolated_from_pos', 'password_changed_at', 'notes'];
  function networkValues(b, cur) {
    const v = {
      name: 'name' in b ? txt(b.name, 120) : cur && cur.name, purpose: b.purpose ? pick(b.purpose, ['staff', 'pos', 'guest', 'cameras', 'management', 'other'], 'staff') : (cur ? cur.purpose : 'staff'),
      ssid: 'ssid' in b ? txt(b.ssid, 80) : cur && cur.ssid, subnet: 'subnet' in b ? txt(b.subnet, 60) : cur && cur.subnet, vlan: 'vlan' in b ? txt(b.vlan, 20) : cur && cur.vlan,
      security: b.security ? pick(b.security, ['wpa3', 'wpa2', 'wpa', 'wep', 'open', 'wired'], 'wpa2') : (cur ? cur.security : 'wpa2'),
      isolated_from_pos: 'isolated_from_pos' in b ? !!b.isolated_from_pos : (cur ? cur.isolated_from_pos : false),
      password_changed_at: 'password_changed_at' in b ? (/^\d{4}-\d{2}-\d{2}$/.test(b.password_changed_at || '') ? b.password_changed_at : null) : cur && cur.password_changed_at,
      notes: 'notes' in b ? txt(b.notes, 1000) : cur && cur.notes,
    };
    if (!v.name) throw httpError(400, 'Name the network');
    return v;
  }
  app.post('/api/sys/networks', ...NET, async (req, res) => {
    try {
      const v = networkValues(req.body || {}, null);
      const { rows } = await query(`INSERT INTO sys_networks (${N_COLS.join(', ')}) VALUES (${N_COLS.map((_, i) => '$' + (i + 1)).join(', ')}) RETURNING id`, N_COLS.map((k) => v[k]));
      res.json({ ok: true, id: rows[0].id });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/sys/networks/:id', ...NET, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10) || 0;
      const { rows } = await query(`SELECT *, to_char(password_changed_at, 'YYYY-MM-DD') AS password_changed_at FROM sys_networks WHERE id = $1`, [id]);
      if (!rows.length) throw httpError(404, 'Not found');
      const v = networkValues(req.body || {}, rows[0]);
      await query(`UPDATE sys_networks SET ${N_COLS.map((k, i) => k + ' = $' + (i + 2)).join(', ')}, updated_at = NOW() WHERE id = $1`, [id, ...N_COLS.map((k) => v[k])]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------- posture checks and overview --
  sysops.addChecks(async () => {
    const out = [];
    const add = (key, label, state, detail, fix) => out.push({ key, label, state, detail, fix });
    const { rows: th } = await query(`SELECT COUNT(*) FILTER (WHERE severity IN ('high', 'critical'))::int AS hi, COUNT(*)::int AS n FROM sys_threats WHERE status = 'new'`);
    add('threats', 'No unhandled serious threats', th[0].hi ? 'fail' : th[0].n ? 'warn' : 'pass', th[0].n + ' new threats (' + th[0].hi + ' high / critical)', 'Work through System management > Threats: each has a playbook.');
    const c = await (async () => { cfgAt = 0; return loadCfg(); })();
    add('autoblock', 'Attackers blocked automatically', c.autoblock ? 'pass' : 'warn', c.autoblock ? 'On: ' + c.hits + ' attack attempts block an address for ' + c.minutes + ' min' : 'Off', 'Threats > Defences: switch automatic blocking on.');
    add('headers', 'Safe browser headers', c.headers ? 'pass' : 'warn', c.headers ? 'On' : 'Off', 'Threats > Defences: switch safe headers on.');
    const ns = nodeStatus();
    add('node', 'Server software still supported', ns.supported ? 'pass' : 'fail', 'Node ' + ns.version + (ns.eol ? ', security updates until ' + ns.eol : ', not a supported release'), 'Update the bundled Node runtime to a supported LTS release.');
    try {
      const ports = await listeningPorts();
      const risky = ports.filter((p) => p.risk);
      add('ports', 'No risky services open to the network', risky.length ? (risky.some((p) => p.port === 3389) ? 'fail' : 'warn') : 'pass',
        risky.length ? risky.map((p) => p.port + ' ' + (p.name || '')).join(', ') : ports.length + ' listening ports checked', risky.length ? risky[0].risk : '');
      const db = ports.find((p) => p.port === 5433 || p.port === 5432);
      if (db) add('db_exposed', 'Database only reachable where needed', db.exposed ? 'warn' : 'pass', db.exposed ? 'The database listens on ' + db.address + ' (other computers can reach it)' : 'Only this computer can reach it',
        'If no other till connects to the database directly, make it listen on 127.0.0.1 only; otherwise allow only the shop network in pg_hba.conf.');
    } catch (_) {}
    const fw = await firewall().catch(() => null);
    if (fw) add('firewall', 'Windows Firewall on', Object.values(fw).every(Boolean) ? 'pass' : 'fail', Object.entries(fw).map(([k, v]) => k + ' ' + (v ? 'on' : 'OFF')).join(', '), 'Turn Windows Firewall on for every profile.');
    const { rows: nd } = await query(`SELECT name FROM sys_net_targets WHERE enabled AND last_ok = false`);
    add('net_down', 'Monitored devices answering', nd.length ? 'fail' : 'pass', nd.length ? 'Down: ' + nd.map((x) => x.name).join(', ') : 'All up (or none monitored)', 'Network tab: check the device; raise an IT ticket.');
    const { rows: nw } = await query(`SELECT COUNT(*) FILTER (WHERE security IN ('open', 'wep', 'wpa'))::int AS weak, COUNT(*) FILTER (WHERE purpose = 'guest' AND NOT isolated_from_pos)::int AS guest, COUNT(*)::int AS n,
                                             COUNT(*) FILTER (WHERE security <> 'wired' AND (password_changed_at IS NULL OR password_changed_at < CURRENT_DATE - 365))::int AS old FROM sys_networks`);
    if (nw[0].n) add('wifi', 'Wi-Fi secure and guests kept apart', nw[0].weak || nw[0].guest ? 'fail' : nw[0].old ? 'warn' : 'pass',
      (nw[0].weak ? nw[0].weak + ' network(s) with weak or no encryption. ' : '') + (nw[0].guest ? 'Guest Wi-Fi not separated from the tills. ' : '') + (nw[0].old ? nw[0].old + ' Wi-Fi password(s) not changed in a year.' : '') || 'OK',
      'Use WPA2/WPA3, keep guest Wi-Fi on its own network away from the tills, change Wi-Fi passwords yearly and when staff leave.');
    else add('wifi', 'Networks documented', 'warn', 'No networks recorded', 'Network tab: record the shop\'s Wi-Fi and wired networks.');
    const { rows: rk } = await query(`SELECT COUNT(*) FILTER (WHERE likelihood * impact >= 15 AND status = 'open')::int AS hi, COUNT(*) FILTER (WHERE review_date < CURRENT_DATE AND status <> 'closed')::int AS overdue FROM sys_risks`);
    add('risks', 'High risks being dealt with', rk[0].hi ? 'fail' : rk[0].overdue ? 'warn' : 'pass', rk[0].hi + ' high risks with no action, ' + rk[0].overdue + ' reviews overdue', 'Risks tab: give each high risk an owner and a mitigation plan.');
    return out;
  });
  sysops.addOverview(async (req, perms) => {
    const o = {};
    if (perms.security) {
      await flush();
      const { rows } = await query(`SELECT COUNT(*) FILTER (WHERE status = 'new')::int AS new, COUNT(*) FILTER (WHERE status IN ('new', 'acknowledged') AND severity IN ('high', 'critical'))::int AS serious FROM sys_threats`);
      const { rows: b } = await query(`SELECT COUNT(*)::int AS n FROM sys_ip_blocks WHERE removed_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())`);
      o.threats = rows[0]; o.blocked = b[0].n;
    }
    return o;
  });

  return { detect, flush, raise, block, checkTarget, inCidr, PLAYBOOKS };
}

module.exports = { register };
