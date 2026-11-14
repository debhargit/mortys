// =============================================================================
//  Vision Auto Solutions -- the website, managed from System management
//
//    require('./site-manage').register(app, deps)
//
//  visionautosolutions.com keeps its own accounts and its visitor log in
//  Cloudflare D1, so System management -> Website asks it, signing each call
//  with the gateway secret the two already share (server-config.json
//  gateway.secret here, TILL_GATEWAY_SECRET there). The signature covers a
//  "sitemgmt" label, time, method, path, this manager's email and the body;
//  functions/_routes/sitemgmt.js checks it and keeps the email with each change.
//
//    GET  /api/sys/website/summary|visitors|visits|users   (sys.security or sys.audit)
//    POST /api/sys/website/users/:id  {action}             (manager with sys.security)
//    POST /api/sys/website/signout-all                     (manager with sys.security)
// =============================================================================
'use strict';

const crypto = require('crypto');

const TIMEOUT_MS = 20000;

function siteSignature(secret, ts, method, pathAndQuery, email, body) {
  const bh = crypto.createHash('sha256').update(body || '').digest('hex');
  return crypto.createHmac('sha256', secret).update(['sitemgmt', ts, method, pathAndQuery, email, bh].join('\n')).digest('hex');
}

function register(app, d) {
  const { query, requireAdmin, requireManager, userCan, secret, origin } = d;
  const bad = (status, message) => Object.assign(new Error(message), { status });
  function fail(res, e) { const s = e.status || 500; if (s >= 500) console.error('[site-manage]', e.message); res.status(s).json({ error: e.message }); }

  async function emailOf(req) {
    const { rows } = await query('SELECT email FROM users WHERE id = $1', [req.session.userId]);
    return String((rows[0] && rows[0].email) || '').trim().toLowerCase();
  }

  async function site(req, method, pathAndQuery, bodyObj) {
    const key = secret();
    if (!key) throw bad(503, 'The till and the website do not share a gateway secret yet (server-config.json gateway.secret and the website’s TILL_GATEWAY_SECRET).');
    const email = await emailOf(req);
    const body = method === 'GET' ? '' : JSON.stringify(bodyObj || {});
    const ts = String(Date.now());
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    let r;
    try {
      r = await fetch(origin() + pathAndQuery, {
        method, signal: ctl.signal,
        headers: Object.assign({ accept: 'application/json', 'x-vision-site-ts': ts, 'x-vision-site-user': email,
          'x-vision-site-sig': siteSignature(key, ts, method, pathAndQuery, email, body) }, body ? { 'content-type': 'application/json' } : {}),
        body: body || undefined,
      });
    } catch (e) {
      throw bad(502, 'The website did not answer (' + (e.name === 'AbortError' ? 'timed out' : e.message) + ').');
    } finally { clearTimeout(timer); }
    const j = await r.json().catch(() => null);
    if (r.status === 404 && !j) throw bad(502, 'The website does not have website management yet: it needs the latest website release.');
    if (!r.ok) throw bad(r.status === 401 ? 502 : r.status, (j && j.error) || ('The website answered ' + r.status));
    return j;
  }

  async function canRead(req, res, next) {
    try {
      if ((await userCan(req, 'sys.security')) || (await userCan(req, 'sys.audit'))) return next();
      res.status(403).json({ error: 'You need system security or audit access for the website.' });
    } catch (e) { fail(res, e); }
  }
  async function canChange(req, res, next) {
    try {
      if (await userCan(req, 'sys.security')) return next();
      res.status(403).json({ error: 'You need system security access to change the website.' });
    } catch (e) { fail(res, e); }
  }
  const qs = (req) => { const i = req.originalUrl.indexOf('?'); return i < 0 ? '' : req.originalUrl.slice(i); };

  for (const what of ['summary', 'visitors', 'visits', 'users']) {
    app.get('/api/sys/website/' + what, requireAdmin, canRead, async (req, res) => {
      try { res.json(await site(req, 'GET', '/api/sitemgmt/' + what + qs(req))); } catch (e) { fail(res, e); }
    });
  }
  app.get('/api/sys/website/info', requireAdmin, canRead, (req, res) => {
    res.json({ origin: origin(), linked: !!secret() });
  });
  app.post('/api/sys/website/users/:id', requireManager, canChange, async (req, res) => {
    try {
      const action = String((req.body || {}).action || '');
      if (!['disable', 'enable', 'remove_admin'].includes(action)) throw bad(400, 'Unknown action');
      res.json(await site(req, 'POST', '/api/sitemgmt/users/' + (parseInt(req.params.id, 10) || 0), { action }));
    } catch (e) { fail(res, e); }
  });
  app.post('/api/sys/website/signout-all', requireManager, canChange, async (req, res) => {
    try { res.json(await site(req, 'POST', '/api/sitemgmt/signout-all', {})); } catch (e) { fail(res, e); }
  });
}

module.exports = { register, siteSignature };
