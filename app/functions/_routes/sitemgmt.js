// Website management for System management -> Website on the till (the till's
// site-manage.js signs every call here): who visits and what they open, the
// shop front's customer accounts and the back office's staff accounts, each
// managed apart, and signing everyone out of the website.
//
// Trust is the reverse of till_gateway.js: the TILL signs (HMAC-SHA256 with the
// same TILL_GATEWAY_SECRET) over a "sitemgmt" label, timestamp, method,
// path+query, the till manager's email and a hash of the body, so a signature
// made for one direction or one request is no use for another. 60 s window.
// The till has already checked the person is a manager there; the email is
// kept with each change for the record. No secret = every call here is 404.
//
// Plus POST /api/visit, the public beacon from visits.js.
import { d1 } from '../_lib/db.js';
import { recordNav } from '../_lib/visits.js';

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const WINDOW_MS = 60000;
const KEEP_DAYS = 180;
const TZ = '-5 hours';   // Jamaica, no daylight saving

export async function siteSignature(secret, ts, method, pathAndQuery, email, body) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bh = hex(await crypto.subtle.digest('SHA-256', enc.encode(body || '')));
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(['sitemgmt', ts, method, pathAndQuery, email, bh].join('\n'))));
}

async function verify(c) {
  const secret = c.env && c.env.TILL_GATEWAY_SECRET;
  if (!secret) return { status: 404, error: 'Not found' };
  const ts = Number(c.req.header('x-vision-site-ts'));
  const email = String(c.req.header('x-vision-site-user') || '').toLowerCase();
  const sig = String(c.req.header('x-vision-site-sig') || '');
  if (!ts || !email || !sig || Math.abs(Date.now() - ts) > WINDOW_MS) return { status: 401, error: 'Not signed by the till' };
  const url = new URL(c.req.url);
  const body = c.req.method === 'GET' ? '' : await c.req.text();
  const want = await siteSignature(secret, ts, c.req.method, url.pathname + url.search, email, body);
  if (want.length !== sig.length) return { status: 401, error: 'Not signed by the till' };
  let d = 0; for (let i = 0; i < want.length; i++) d |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  if (d) return { status: 401, error: 'Not signed by the till' };
  let json = {};
  try { json = body ? JSON.parse(body) : {}; } catch (_) {}
  return { email, body: json };
}
const signed = async (c, next) => {
  const v = await verify(c);
  if (v.error) return c.json({ error: v.error }, v.status);
  c.set('till', v);
  return next();
};

const days = (v, dflt) => Math.min(180, Math.max(1, parseInt(v, 10) || dflt));
const area = (v) => (v === 'admin' || v === 'public' ? v : null);

export default function mountSiteMgmt(app) {
  app.post('/api/visit', (c) => recordNav(c.req.raw, c.env, c.executionCtx));

  app.use('/api/sitemgmt/*', signed);

  // Totals, today, people on the site now, a day-by-day count, and the top
  // pages, referrers, countries and devices -- shop front and back office apart.
  app.get('/api/sitemgmt/summary', async (c) => {
    const db = d1(c.env);
    const n = days(c.req.query('days'), 30);
    const bots = c.req.query('bots') === '1';
    const nb = bots ? '' : ' AND bot = 0';
    const since = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${n} days')`;
    await db.run(`DELETE FROM site_visits WHERE at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${KEEP_DAYS} days')`).catch(() => {});
    const [totals, today, now, daily, pages, refs, countries, devices, browsers, botCount] = await Promise.all([
      db.many(`SELECT area, COUNT(*) AS views, COUNT(DISTINCT visitor) AS visitors, COUNT(DISTINCT user_id) AS accounts FROM site_visits WHERE at >= ${since}${nb} GROUP BY area`),
      db.many(`SELECT area, COUNT(*) AS views, COUNT(DISTINCT visitor) AS visitors FROM site_visits WHERE date(at, '${TZ}') = date('now', '${TZ}')${nb} GROUP BY area`),
      db.many(`SELECT area, COUNT(DISTINCT visitor) AS visitors FROM site_visits WHERE at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-5 minutes')${nb} GROUP BY area`),
      db.many(`SELECT date(at, '${TZ}') AS day, area, COUNT(*) AS views, COUNT(DISTINCT visitor) AS visitors FROM site_visits WHERE at >= ${since}${nb} GROUP BY day, area ORDER BY day`),
      db.many(`SELECT area, path, COUNT(*) AS views, COUNT(DISTINCT visitor) AS visitors FROM site_visits WHERE at >= ${since}${nb} GROUP BY area, path ORDER BY views DESC LIMIT 60`),
      db.many(`SELECT referrer, COUNT(*) AS views, COUNT(DISTINCT visitor) AS visitors FROM site_visits WHERE at >= ${since} AND referrer IS NOT NULL${nb} GROUP BY referrer ORDER BY visitors DESC LIMIT 20`),
      db.many(`SELECT COALESCE(country, '?') AS country, COUNT(DISTINCT visitor) AS visitors FROM site_visits WHERE at >= ${since}${nb} GROUP BY country ORDER BY visitors DESC LIMIT 20`),
      db.many(`SELECT device, COUNT(DISTINCT visitor) AS visitors FROM site_visits WHERE at >= ${since}${nb} GROUP BY device ORDER BY visitors DESC`),
      db.many(`SELECT browser, os, COUNT(DISTINCT visitor) AS visitors FROM site_visits WHERE at >= ${since}${nb} GROUP BY browser, os ORDER BY visitors DESC LIMIT 12`),
      db.one(`SELECT COUNT(*) AS views FROM site_visits WHERE at >= ${since} AND bot = 1`),
    ]);
    return c.json({ days: n, totals, today, now, daily, pages, referrers: refs, countries, devices, browsers, bot_views: (botCount && botCount.views) || 0 });
  });

  // One row per visitor: when they came, how many pages, who they are if
  // signed in. ?area= keeps to the shop front or the back office.
  app.get('/api/sitemgmt/visitors', async (c) => {
    const db = d1(c.env);
    const n = days(c.req.query('days'), 7);
    const a = area(c.req.query('area'));
    const binds = [];
    let w = `v.at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${n} days')`;
    if (c.req.query('bots') !== '1') w += ' AND v.bot = 0';
    if (a) { w += ' AND v.area = ?'; binds.push(a); }
    const rows = await db.many(
      `SELECT v.visitor, MIN(v.at) AS first_at, MAX(v.at) AS last_at, COUNT(*) AS views, COUNT(DISTINCT v.path) AS pages,
              MAX(v.user_id) AS user_id, MAX(u.name) AS name, MAX(u.email) AS email, MAX(u.is_admin) AS is_admin,
              MAX(v.country) AS country, MAX(v.city) AS city, MAX(v.device) AS device, MAX(v.browser) AS browser, MAX(v.os) AS os,
              (SELECT referrer FROM site_visits r WHERE r.visitor = v.visitor AND r.referrer IS NOT NULL ORDER BY r.id LIMIT 1) AS referrer
         FROM site_visits v LEFT JOIN users u ON u.id = v.user_id
        WHERE ${w} GROUP BY v.visitor ORDER BY last_at DESC LIMIT 150`, ...binds);
    return c.json({ visitors: rows });
  });

  // The pages themselves, newest first: for one visitor, one account, or all.
  app.get('/api/sitemgmt/visits', async (c) => {
    const db = d1(c.env);
    const binds = [];
    const w = ['1=1'];
    const a = area(c.req.query('area'));
    if (a) { w.push('v.area = ?'); binds.push(a); }
    if (c.req.query('visitor')) { w.push('v.visitor = ?'); binds.push(String(c.req.query('visitor')).slice(0, 40)); }
    if (parseInt(c.req.query('user_id'), 10)) { w.push('v.user_id = ?'); binds.push(parseInt(c.req.query('user_id'), 10)); }
    if (parseInt(c.req.query('before'), 10)) { w.push('v.id < ?'); binds.push(parseInt(c.req.query('before'), 10)); }
    if (c.req.query('bots') !== '1') w.push('v.bot = 0');
    const limit = Math.min(500, Math.max(1, parseInt(c.req.query('limit'), 10) || 100));
    const rows = await db.many(
      `SELECT v.id, v.at, v.visitor, v.user_id, u.name, u.email, v.area, v.path, v.hash, v.kind, v.referrer, v.country, v.city, v.device, v.browser, v.os, v.bot
         FROM site_visits v LEFT JOIN users u ON u.id = v.user_id
        WHERE ${w.join(' AND ')} ORDER BY v.id DESC LIMIT ${limit}`, ...binds);
    return c.json({ visits: rows });
  });

  // Website accounts: kind=public (customers who signed up on the shop front)
  // or kind=admin (staff who sign in to the back office), with their visits.
  app.get('/api/sitemgmt/users', async (c) => {
    const db = d1(c.env);
    const admin = c.req.query('kind') === 'admin' ? 1 : 0;
    const binds = [admin];
    let w = 'COALESCE(u.is_admin, 0) = ?';
    const q = String(c.req.query('q') || '').trim().toLowerCase();
    if (q) { w += ' AND (lower(u.email) LIKE ? OR lower(COALESCE(u.name, \'\')) LIKE ? OR COALESCE(u.phone, \'\') LIKE ?)'; binds.push('%' + q + '%', '%' + q + '%', '%' + q + '%'); }
    if (c.req.query('status') === 'disabled') w += ' AND u.disabled = 1';
    const limit = Math.min(500, Math.max(1, parseInt(c.req.query('limit'), 10) || 100));
    const [rows, count] = await Promise.all([
      db.many(
        `SELECT u.id, u.email, u.name, u.phone, u.via, u.created_at, u.admin_role, COALESCE(u.disabled, 0) AS disabled,
                s.last_at, COALESCE(s.views, 0) AS views_30d
           FROM users u
           LEFT JOIN (SELECT user_id, MAX(at) AS last_at, COUNT(*) AS views FROM site_visits
                       WHERE user_id IS NOT NULL AND at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days') GROUP BY user_id) s ON s.user_id = u.id
          WHERE ${w} AND COALESCE(u.is_archived, 0) = 0
          ORDER BY s.last_at IS NULL, s.last_at DESC, u.id DESC LIMIT ${limit}`, ...binds),
      db.one(`SELECT COUNT(*) AS n, SUM(CASE WHEN COALESCE(u.disabled,0)=1 THEN 1 ELSE 0 END) AS disabled FROM users u WHERE ${w} AND COALESCE(u.is_archived, 0) = 0`, ...binds),
    ]);
    return c.json({ users: rows, total: (count && count.n) || 0, disabled: (count && count.disabled) || 0 });
  });

  // disable | enable | remove_admin. The owner's account is never changed
  // from here: that is done on the website itself, signed in as the owner.
  app.post('/api/sitemgmt/users/:id', async (c) => {
    const db = d1(c.env);
    const { email, body } = c.get('till');
    const id = parseInt(c.req.param('id'), 10) || 0;
    const u = await db.one('SELECT id, email, is_admin, admin_role FROM users WHERE id = ?', id);
    if (!u) return c.json({ error: 'No such website account' }, 404);
    const action = String((body && body.action) || '');
    if (u.admin_role === 'owner' && u.is_admin && action !== 'enable') return c.json({ error: 'The owner’s website account can only be changed on the website, signed in as the owner.' }, 403);
    if (action === 'disable') await db.run('UPDATE users SET disabled = 1 WHERE id = ?', id);
    else if (action === 'enable') await db.run('UPDATE users SET disabled = 0 WHERE id = ?', id);
    else if (action === 'remove_admin') await db.run('UPDATE users SET is_admin = 0 WHERE id = ?', id);
    else return c.json({ error: 'Unknown action' }, 400);
    console.log('[sitemgmt] ' + email + ' (till): ' + action + ' website account ' + u.email);
    return c.json({ ok: true });
  });

  // Every website session ends on its next request (guards.js compares the
  // epoch in the cookie with this one).
  app.post('/api/sitemgmt/signout-all', async (c) => {
    const db = d1(c.env);
    const { email } = c.get('till');
    await db.run(`INSERT INTO app_config (key, value) VALUES ('session_epoch', '1')
                  ON CONFLICT (key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`);
    console.log('[sitemgmt] ' + email + ' (till): signed everyone out of the website');
    return c.json({ ok: true });
  });
}
