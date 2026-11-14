// =============================================================================
//  fleet.js -- dispatch, the driver app and vehicle tracking
//
//  Dispatch queue: every customer delivery (one job per row in deliveries,
//  created automatically, so outbound and the admin Deliveries screen feed it)
//  plus admin runs -- bank drops, parts pick-ups, documents / letters /
//  cheques, collections, errands. Addresses are put on the map (OpenStreetMap
//  lookup, cached; or a pin set by dispatch or by the driver on arrival).
//  Dispatch assigns jobs to drivers; each driver's open jobs are put in route
//  order (urgent first, then nearest-next, then 2-opt), starting from where the
//  driver is or from the shop.
//
//  Driver app (driver.html): sign in, start a shift (tracking on), the route
//  and its map, navigate (Google Maps does the turn-by-turn), arrive, complete
//  with recipient + signature + photo, or say why not; SOS button.
//
//  Tracking: while on shift the phone sends its position every few seconds.
//  Alerts: SOS, phone gone quiet, stopped too long away from any stop,
//  speeding. The live board (dispatch.html) and a read-only security monitor
//  (fleet-wall.html, opened with a screen link, no sign-in) show it all.
//  Drivers are only tracked while on shift.
// =============================================================================
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const PROOF = path.join(__dirname, '..', 'data', 'fleet-proof');
const KINDS = {
  delivery: 'Customer delivery', parts_pickup: 'Parts pick-up', bank_drop: 'Bank drop', document: 'Documents / letters',
  cheque: 'Cheque delivery', collection: 'Collection (money or items)', errand: 'Errand', other: 'Other',
};
const OPEN = ['queued', 'assigned', 'en_route', 'arrived'];
const ACTIVE = ['assigned', 'en_route', 'arrived'];

function httpError(status, msg) { const e = new Error(msg); e.status = status; return e; }
const n = (v) => { if (v === '' || v == null) return null; const x = Number(v); return Number.isFinite(x) ? x : null; };
const int = (v) => { const x = parseInt(v, 10); return Number.isFinite(x) ? x : null; };
const dateOrNull = (v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : null);
const timeOrNull = (v) => (v && /^\d{1,2}:\d{2}$/.test(String(v)) ? String(v) : null);
const okLat = (v) => v != null && v >= 17.5 && v <= 18.7;          // Jamaica, with a margin
const okLng = (v) => v != null && v >= -78.6 && v <= -76.0;
// Distance in metres between two points.
function metres(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
// Roads are not straight lines: Kingston driving is about 1.35x the crow-flies distance.
const ROAD = 1.35, KMH = 28, STOP_MIN = 7;

// Route order: urgent jobs first (nearest-next among them), then the rest
// (nearest-next, improved by 2-opt). Jobs with no map position go last.
function orderRoute(start, jobs) {
  const placed = jobs.filter((j) => j.lat != null && j.lng != null);
  const unplaced = jobs.filter((j) => j.lat == null || j.lng == null);
  const nearestNext = (from, list) => {
    const out = []; const left = list.slice(); let cur = from;
    while (left.length) {
      let bi = 0, bd = Infinity;
      left.forEach((j, i) => { const d = metres(cur, j); if (d < bd) { bd = d; bi = i; } });
      cur = left[bi]; out.push(left.splice(bi, 1)[0]);
    }
    return out;
  };
  const urgent = nearestNext(start, placed.filter((j) => j.priority === 1));
  const after = urgent.length ? urgent[urgent.length - 1] : start;
  let rest = nearestNext(after, placed.filter((j) => j.priority !== 1));
  // 2-opt on the non-urgent part: reverse any segment that shortens the route.
  const len = (seq) => seq.reduce((s, j, i) => s + metres(i ? seq[i - 1] : after, j), 0);
  for (let improved = true, guard = 0; improved && guard < 50; guard++) {
    improved = false;
    for (let i = 0; i < rest.length - 1; i++) {
      for (let k = i + 1; k < rest.length; k++) {
        const cand = rest.slice(0, i).concat(rest.slice(i, k + 1).reverse(), rest.slice(k + 1));
        if (len(cand) + 1 < len(rest)) { rest = cand; improved = true; }
      }
    }
  }
  return urgent.concat(rest, unplaced);
}
function routeStats(start, ordered, shop) {
  let m = 0, prev = start, stops = 0;
  for (const j of ordered) { if (j.lat == null) continue; m += metres(prev, j); prev = j; stops++; }
  const back = stops ? metres(prev, shop) : 0;
  const km = (m * ROAD) / 1000, kmBack = (back * ROAD) / 1000;
  return { stops, unplaced: ordered.filter((j) => j.lat == null).length, km: Math.round(km * 10) / 10, km_with_return: Math.round((km + kmBack) * 10) / 10,
    minutes: Math.round(((km + kmBack) / KMH) * 60 + ordered.length * STOP_MIN) };
}

exports.register = function register(app, deps) {
  const { query, requireCap, userCan, permState, mailer, devMode } = deps;
  fs.mkdirSync(PROOF, { recursive: true });
  const fail = (res, e) => { if (!e.status) console.error('[fleet]', e); res.status(e.status || 500).json({ error: e.status ? e.message : 'Server error' }); };
  const me = (req) => (req.session && req.session.userId) || null;
  const ipOf = (req) => String(req.headers['cf-connecting-ip'] || (req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '').slice(0, 64);
  const today = `date_trunc('day', NOW() AT TIME ZONE 'America/Jamaica') AT TIME ZONE 'America/Jamaica'`;

  async function settings() {
    const { rows } = await query(`SELECT key, value FROM warehouse_settings WHERE key LIKE 'fleet\\_%'`);
    const s = {}; rows.forEach((r) => { s[r.key.slice(6)] = r.value; });
    return { shop: { lat: n(s.shop_lat) || 18.0089, lng: n(s.shop_lng) || -76.8207 }, ping_seconds: int(s.ping_seconds) || 20, quiet_minutes: int(s.quiet_minutes) || 5,
      stop_minutes: int(s.stop_minutes) || 25, speed_kmh: int(s.speed_kmh) || 100, arrive_metres: int(s.arrive_metres) || 120 };
  }
  const putSetting = (k, v) => query(`INSERT INTO warehouse_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, ['fleet_' + k, String(v)]);

  // ------------------------------------------------------------- geocoding --
  // OpenStreetMap's free address lookup: one request a second at most, cached.
  let lastLookup = 0;
  function nominatim(q) {
    return new Promise((resolve) => {
      const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=jm&q=' + encodeURIComponent(q);
      const req = https.get(url, { headers: { 'User-Agent': 'MortysAutoParts-dispatch/1.0 (info@mortsautoparts.com)', 'Accept-Language': 'en' }, timeout: 8000 }, (res) => {
        let body = ''; res.on('data', (d) => { body += d; if (body.length > 200000) req.destroy(); });
        res.on('end', () => { try { const j = JSON.parse(body)[0]; resolve(j ? { lat: Number(j.lat), lng: Number(j.lon), label: j.display_name } : null); } catch (_) { resolve(null); } });
      });
      req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
    });
  }
  async function geocode(address) {
    const q = String(address || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (q.length < 4) return null;
    const { rows } = await query(`SELECT lat, lng, label FROM geocode_cache WHERE q = $1`, [q]);
    if (rows.length) return rows[0].lat == null ? null : rows[0];
    if (devMode) return null;                               // the test copy does not call out
    const pause = async () => { const wait = 1100 - (Date.now() - lastLookup); if (wait > 0) await new Promise((r) => setTimeout(r, wait)); lastLookup = Date.now(); };
    // Jamaican addresses: try the full line, then without the house / lot number.
    await pause();
    let hit = await nominatim(q + ', jamaica');
    const simpler = q.replace(/^(lot\s*)?\d+[a-z]?\s*,?\s*/i, '');
    if (!hit && simpler !== q) { await pause(); hit = await nominatim(simpler + ', jamaica'); }
    if (hit && !(okLat(hit.lat) && okLng(hit.lng))) hit = null;
    await query(`INSERT INTO geocode_cache (q, lat, lng, label) VALUES ($1, $2, $3, $4) ON CONFLICT (q) DO UPDATE SET lat = EXCLUDED.lat, lng = EXCLUDED.lng, label = EXCLUDED.label, at = NOW()`,
      [q, hit ? hit.lat : null, hit ? hit.lng : null, hit ? hit.label : null]);
    return hit;
  }
  let geocoding = false;
  async function geocodePending() {
    if (geocoding || devMode) return; geocoding = true;
    try {
      const { rows } = await query(`SELECT id, address FROM dispatch_jobs WHERE lat IS NULL AND COALESCE(geo_source, '') = '' AND address IS NOT NULL AND status = ANY($1) ORDER BY id LIMIT 5`, [OPEN]);
      for (const j of rows) {
        const g = await geocode(j.address);
        await query(`UPDATE dispatch_jobs SET lat = $2, lng = $3, geo_source = $4 WHERE id = $1 AND lat IS NULL`, [j.id, g ? g.lat : null, g ? g.lng : null, g ? 'geocoded' : 'none']);
      }
    } catch (e) { console.warn('[fleet] geocode', e.message); } finally { geocoding = false; }
  }

  // -------------------------------------------- deliveries feed the queue --
  async function syncDeliveries() {
    await query(`INSERT INTO dispatch_jobs (number, kind, title, details, delivery_id, contact_name, contact_phone, address, due_date, status, created_by, created_at)
      SELECT 'JOB-' || lpad(nextval('dispatch_job_seq')::text, 6, '0'), 'delivery',
             'Delivery ' || COALESCE(d.delivery_number, '#' || d.id) || ' - ' || d.recipient_name, d.notes, d.id, d.recipient_name, d.recipient_phone, d.address,
             (d.scheduled_for AT TIME ZONE 'America/Jamaica')::date, 'queued', d.created_by, COALESCE(d.created_at, NOW())
        FROM deliveries d
       WHERE d.status IN ('scheduled', 'dispatched') AND NOT EXISTS (SELECT 1 FROM dispatch_jobs j WHERE j.delivery_id = d.id)
       ON CONFLICT (delivery_id) DO NOTHING`);
    // Delivered or cancelled from the Deliveries screen: close the job too.
    await query(`UPDATE dispatch_jobs j SET status = CASE WHEN d.status = 'delivered' THEN 'done' ELSE 'cancelled' END, done_at = COALESCE(j.done_at, d.delivered_at, NOW()), updated_at = NOW()
      FROM deliveries d WHERE d.id = j.delivery_id AND d.status IN ('delivered', 'cancelled') AND j.status = ANY($1)`, [OPEN]);
  }

  async function nextNumber() { return (await query(`SELECT 'JOB-' || lpad(nextval('dispatch_job_seq')::text, 6, '0') AS n`)).rows[0].n; }
  async function jobRow(id) {
    const { rows } = await query(`SELECT j.*, u.name AS driver_name, c.name AS created_by_name FROM dispatch_jobs j LEFT JOIN users u ON u.id = j.driver_id LEFT JOIN users c ON c.id = j.created_by WHERE j.id = $1`, [int(id)]);
    if (!rows.length) throw httpError(404, 'Job not found');
    return rows[0];
  }
  const publicJob = (j) => {
    const o = Object.assign({}, j, { kind_label: KINDS[j.kind] || j.kind, has_signature: !!j.signature_file, has_photo: !!j.photo_file });
    delete o.signature_file; delete o.photo_file;
    return o;
  };

  // Drivers: active staff allowed to use the driver app (permission "fleet.drive").
  async function drivers() {
    const { rows } = await query(`SELECT id, name, email, phone FROM users WHERE (COALESCE(is_staff, false) OR COALESCE(is_admin, false)) AND NOT COALESCE(disabled, false) ORDER BY name`);
    // Owners and managers can do everything, so they only count as drivers once they have driven.
    const { rows: drove } = await query(`SELECT DISTINCT user_id FROM driver_shifts`);
    const hasDriven = new Set(drove.map((r) => r.user_id));
    const out = [];
    for (const u of rows) {
      try { const s = await permState(u.id); if (s.full ? hasDriven.has(u.id) : s.perms['fleet.drive'] !== false) out.push(u); } catch (_) {}
    }
    return out;
  }
  async function lastPositions(ids) {
    if (!ids.length) return {};
    const { rows } = await query(`SELECT DISTINCT ON (user_id) user_id, lat, lng, accuracy, speed, heading, battery, at FROM driver_positions WHERE user_id = ANY($1) ORDER BY user_id, at DESC`, [ids]);
    const m = {}; rows.forEach((r) => { m[r.user_id] = r; }); return m;
  }
  const fresh = (p) => p && Date.now() - new Date(p.at).getTime() < 30 * 60000;

  async function optimise(driverId) {
    const s = await settings();
    const { rows: jobs } = await query(`SELECT id, lat, lng, priority, status FROM dispatch_jobs WHERE driver_id = $1 AND status = ANY($2) ORDER BY seq NULLS LAST, id`, [driverId, ACTIVE]);
    const pos = (await lastPositions([driverId]))[driverId];
    const start = fresh(pos) ? { lat: pos.lat, lng: pos.lng } : s.shop;
    // A job the driver is already on stays first.
    const current = jobs.filter((j) => j.status === 'en_route' || j.status === 'arrived');
    const from = current.length && current[current.length - 1].lat != null ? current[current.length - 1] : start;
    const ordered = current.concat(orderRoute(from, jobs.filter((j) => current.indexOf(j) < 0)));
    for (let i = 0; i < ordered.length; i++) await query(`UPDATE dispatch_jobs SET seq = $2 WHERE id = $1`, [ordered[i].id, i + 1]);
    return Object.assign({ from: fresh(pos) ? 'driver' : 'shop' }, routeStats(start, ordered, s.shop));
  }
  async function routeFor(driverId) {
    const s = await settings();
    const { rows } = await query(`SELECT j.* FROM dispatch_jobs j WHERE j.driver_id = $1 AND j.status = ANY($2) ORDER BY j.seq NULLS LAST, j.priority, j.id`, [driverId, ACTIVE]);
    const pos = (await lastPositions([driverId]))[driverId];
    const start = fresh(pos) ? { lat: pos.lat, lng: pos.lng } : s.shop;
    return { jobs: rows.map(publicJob), stats: routeStats(start, rows, s.shop), start: fresh(pos) ? 'driver' : 'shop', shop: s.shop, position: pos || null };
  }
  async function openShift(uid) { return (await query(`SELECT * FROM driver_shifts WHERE user_id = $1 AND ended_at IS NULL`, [uid])).rows[0] || null; }

  // ---------------------------------------------------------------- alerts --
  async function raise(uid, kind, message, at, jobId) {
    const { rows } = await query(`INSERT INTO fleet_alerts (user_id, kind, message, lat, lng, job_id) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (user_id, kind) WHERE cleared_at IS NULL DO NOTHING RETURNING id`, [uid, kind, message, at ? at.lat : null, at ? at.lng : null, jobId || null]);
    return rows.length ? rows[0].id : null;
  }
  const clearAuto = (uid, kind) => query(`UPDATE fleet_alerts SET cleared_at = NOW() WHERE user_id = $1 AND kind = $2 AND cleared_at IS NULL`, [uid, kind]);
  async function managersMail(subject, text) {
    if (devMode || !mailer) return;
    const { rows } = await query(`SELECT email FROM users WHERE admin_role IN ('owner', 'manager') AND NOT COALESCE(disabled, false) AND email IS NOT NULL AND email NOT ILIKE '%.local'`);
    for (const m of rows) mailer.sendEmail({ to: m.email, subject, text }).catch(() => {});
  }
  // Every minute: phones gone quiet, drivers stopped a long time away from any stop.
  async function checkFleet() {
    const s = await settings();
    const { rows: sh } = await query(`SELECT ds.user_id, ds.started_at, u.name FROM driver_shifts ds JOIN users u ON u.id = ds.user_id WHERE ds.ended_at IS NULL`);
    for (const d of sh) {
      const last = (await lastPositions([d.user_id]))[d.user_id];
      const lastAt = last ? new Date(last.at).getTime() : new Date(d.started_at).getTime();
      if (Date.now() - lastAt > s.quiet_minutes * 60000) await raise(d.user_id, 'quiet', d.name + ': no position for ' + Math.round((Date.now() - lastAt) / 60000) + ' min (phone off, app closed or no signal)', last);
      // Stopped: every position in the last stop_minutes, and the last one before that, within 150 m of where the driver is now.
      const { rows: pts } = await query(`SELECT lat, lng, at FROM driver_positions WHERE user_id = $1 AND at > NOW() - make_interval(mins => $2) ORDER BY at`, [d.user_id, s.stop_minutes + 15]);
      if (!pts.length) continue;
      const cutoff = Date.now() - s.stop_minutes * 60000;
      const before = pts.filter((p) => new Date(p.at).getTime() <= cutoff), recent = pts.filter((p) => new Date(p.at).getTime() > cutoff);
      const c = pts[pts.length - 1];
      const span = before.length ? [before[before.length - 1]].concat(recent) : [];
      if (span.length >= 3 && span.every((p) => metres(p, c) < 150)) {
        const { rows: stops } = await query(`SELECT lat, lng FROM dispatch_jobs WHERE driver_id = $1 AND status = ANY($2) AND lat IS NOT NULL`, [d.user_id, OPEN]);
        const atStop = metres(c, s.shop) < 250 || stops.some((j) => metres(c, j) < 250);
        if (!atStop) await raise(d.user_id, 'stopped', d.name + ': stopped ' + s.stop_minutes + '+ min away from the shop and any stop', c);
      } else if (recent.some((p) => metres(p, c) >= 150)) await clearAuto(d.user_id, 'stopped');
    }
    await query(`DELETE FROM driver_positions WHERE at < NOW() - INTERVAL '90 days'`);
  }
  if (!devMode) setInterval(() => { checkFleet().catch((e) => console.warn('[fleet] check', e.message)); }, 60000).unref();

  // ============================================================ driver app ==
  app.get('/api/fleet/me', requireCap('fleet.drive'), async (req, res) => {
    try {
      const s = await settings();
      const { rows: u } = await query(`SELECT id, name FROM users WHERE id = $1`, [me(req)]);
      const { rows: al } = await query(`SELECT id, kind, message, created_at FROM fleet_alerts WHERE user_id = $1 AND cleared_at IS NULL`, [me(req)]);
      res.json({ user: u[0], shift: await openShift(me(req)), ping_seconds: s.ping_seconds, shop: s.shop, kinds: KINDS, alerts: al });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/fleet/shift/start', requireCap('fleet.drive'), async (req, res) => {
    try {
      const b = req.body || {};
      if (await openShift(me(req))) throw httpError(409, 'Your shift is already started');
      const { rows } = await query(`INSERT INTO driver_shifts (user_id, vehicle, start_odometer) VALUES ($1, $2, $3) RETURNING *`, [me(req), String(b.vehicle || '').trim().slice(0, 60) || null, int(b.odometer)]);
      res.json({ ok: true, shift: rows[0] });
    } catch (e) { fail(res, e.code === '23505' ? httpError(409, 'Your shift is already started') : e); }
  });
  app.post('/api/fleet/shift/end', requireCap('fleet.drive'), async (req, res) => {
    try {
      const sh = await openShift(me(req)); if (!sh) throw httpError(409, 'No shift to end');
      const odo = int((req.body || {}).odometer);
      if (odo != null && sh.start_odometer != null && odo < sh.start_odometer) throw httpError(400, 'The odometer cannot go backwards (started at ' + sh.start_odometer + ')');
      await query(`UPDATE driver_shifts SET ended_at = NOW(), end_odometer = $2 WHERE id = $1`, [sh.id, odo]);
      await query(`UPDATE fleet_alerts SET cleared_at = NOW() WHERE user_id = $1 AND kind IN ('quiet', 'stopped', 'speeding') AND cleared_at IS NULL`, [me(req)]);
      const { rows } = await query(`SELECT COUNT(*)::int AS open FROM dispatch_jobs WHERE driver_id = $1 AND status = ANY($2)`, [me(req), ACTIVE]);
      res.json({ ok: true, open_jobs: rows[0].open, km: odo != null && sh.start_odometer != null ? odo - sh.start_odometer : null });
    } catch (e) { fail(res, e); }
  });
  // Position from the phone. Only while on shift.
  app.post('/api/fleet/ping', requireCap('fleet.drive'), async (req, res) => {
    try {
      const b = req.body || {}; const lat = n(b.lat), lng = n(b.lng), speed = n(b.speed);
      if (lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw httpError(400, 'Bad position');
      const sh = await openShift(me(req)); if (!sh) return res.json({ ok: false, off_shift: true });
      const s = await settings();
      await query(`INSERT INTO driver_positions (user_id, shift_id, lat, lng, accuracy, speed, heading, battery) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [me(req), sh.id, lat, lng, n(b.accuracy), speed, n(b.heading), n(b.battery)]);
      await clearAuto(me(req), 'quiet');
      const at = { lat, lng };
      if (speed != null && speed * 3.6 > s.speed_kmh) {
        const { rows: u } = await query(`SELECT name FROM users WHERE id = $1`, [me(req)]);
        await raise(me(req), 'speeding', (u[0] && u[0].name) + ': ' + Math.round(speed * 3.6) + ' km/h', at);
      } else if (speed != null && speed * 3.6 < s.speed_kmh - 20) await clearAuto(me(req), 'speeding');
      // On the way to a job and now close to it: arrived.
      const { rows: cur } = await query(`SELECT id, lat, lng FROM dispatch_jobs WHERE driver_id = $1 AND status = 'en_route' AND lat IS NOT NULL`, [me(req)]);
      const arrived = [];
      for (const j of cur) if (metres(at, j) <= s.arrive_metres) { await query(`UPDATE dispatch_jobs SET status = 'arrived', arrived_at = NOW(), updated_at = NOW() WHERE id = $1`, [j.id]); arrived.push(j.id); }
      const { rows: q } = await query(`SELECT COUNT(*)::int AS c, MAX(assigned_at) AS latest FROM dispatch_jobs WHERE driver_id = $1 AND status = ANY($2)`, [me(req), ACTIVE]);
      res.json({ ok: true, arrived, open: q[0].c, latest_assignment: q[0].latest });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/fleet/my-route', requireCap('fleet.drive'), async (req, res) => {
    try {
      await syncDeliveries();
      const r = await routeFor(me(req));
      const { rows: done } = await query(`SELECT id, number, kind, title, status, done_at FROM dispatch_jobs WHERE driver_id = $1 AND status IN ('done', 'failed') AND done_at > ${today} ORDER BY done_at DESC`, [me(req)]);
      res.json(Object.assign(r, { done_today: done, shift: await openShift(me(req)) }));
    } catch (e) { fail(res, e); }
  });
  app.post('/api/fleet/my-route/optimise', requireCap('fleet.drive'), async (req, res) => {
    try { res.json(Object.assign({ ok: true }, await optimise(me(req)))); } catch (e) { fail(res, e); }
  });
  async function myJob(req) {
    const j = await jobRow(req.params.id);
    if (j.driver_id !== me(req)) throw httpError(403, 'This job is not assigned to you');
    return j;
  }
  app.post('/api/fleet/jobs/:id(\\d+)/start', requireCap('fleet.drive'), async (req, res) => {
    try {
      const j = await myJob(req);
      if (!['assigned', 'arrived'].includes(j.status)) throw httpError(409, 'This job is ' + j.status);
      await query(`UPDATE dispatch_jobs SET status = 'en_route', started_at = COALESCE(started_at, NOW()), updated_at = NOW() WHERE id = $1`, [j.id]);
      if (j.delivery_id) await query(`UPDATE deliveries SET status = 'dispatched', dispatched_at = COALESCE(dispatched_at, NOW()) WHERE id = $1 AND status = 'scheduled'`, [j.delivery_id]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/fleet/jobs/:id(\\d+)/arrived', requireCap('fleet.drive'), async (req, res) => {
    try {
      const j = await myJob(req);
      if (!['assigned', 'en_route'].includes(j.status)) throw httpError(409, 'This job is ' + j.status);
      await query(`UPDATE dispatch_jobs SET status = 'arrived', started_at = COALESCE(started_at, NOW()), arrived_at = NOW(), updated_at = NOW() WHERE id = $1`, [j.id]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  // The driver at the door: "this is where it really is" -- used for this job and next time.
  app.post('/api/fleet/jobs/:id(\\d+)/pin', requireCap('fleet.drive'), async (req, res) => {
    try {
      const j = await myJob(req); const lat = n((req.body || {}).lat), lng = n((req.body || {}).lng);
      if (!okLat(lat) || !okLng(lng)) throw httpError(400, 'That position is not in Jamaica');
      await query(`UPDATE dispatch_jobs SET lat = $2, lng = $3, geo_source = 'driver', updated_at = NOW() WHERE id = $1`, [j.id, lat, lng]);
      if (j.address) await query(`INSERT INTO geocode_cache (q, lat, lng, label) VALUES ($1, $2, $3, 'pinned by driver') ON CONFLICT (q) DO UPDATE SET lat = EXCLUDED.lat, lng = EXCLUDED.lng, label = EXCLUDED.label, at = NOW()`,
        [String(j.address).replace(/\s+/g, ' ').trim().toLowerCase(), lat, lng]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  function saveImage(dataUrl, jobId, what) {
    const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
    if (!m) throw httpError(400, 'The ' + what + ' did not come through; try again');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length < 100) throw httpError(400, 'The ' + what + ' is empty');
    if (buf.length > 900 * 1024) throw httpError(400, 'The ' + what + ' is too large');
    const sub = new Date().toISOString().slice(0, 7);
    fs.mkdirSync(path.join(PROOF, sub), { recursive: true });
    const name = sub + '/' + jobId + '-' + what + '-' + crypto.randomBytes(6).toString('hex') + (m[1] === 'png' ? '.png' : '.jpg');
    fs.writeFileSync(path.join(PROOF, name), buf);
    return name;
  }
  app.post('/api/fleet/jobs/:id(\\d+)/complete', requireCap('fleet.drive'), async (req, res) => {
    try {
      const j = await myJob(req); const b = req.body || {};
      if (!ACTIVE.includes(j.status)) throw httpError(409, 'This job is ' + j.status);
      const who = String(b.recipient_name || '').trim();
      if (j.needs_signature && !who) throw httpError(400, 'Who received it?');
      if (j.needs_signature && !b.signature) throw httpError(400, 'Get a signature');
      if (j.needs_photo && !b.photo) throw httpError(400, j.kind === 'bank_drop' ? 'Take a photo of the stamped deposit slip' : 'Take a photo');
      const sig = b.signature ? saveImage(b.signature, j.id, 'signature') : null;
      const photo = b.photo ? saveImage(b.photo, j.id, 'photo') : null;
      await query(`UPDATE dispatch_jobs SET status = 'done', done_at = NOW(), arrived_at = COALESCE(arrived_at, NOW()), recipient_name = $2, signature_file = $3, photo_file = $4,
          done_lat = $5, done_lng = $6, done_note = $7, updated_at = NOW() WHERE id = $1`,
        [j.id, who || null, sig, photo, n(b.lat), n(b.lng), String(b.note || '').slice(0, 1000) || null]);
      if (j.delivery_id) await query(`UPDATE deliveries SET status = 'delivered', delivered_at = NOW(), recipient_received_by = $2, proof_signature = $3, proof_photo = $4 WHERE id = $1`,
        [j.delivery_id, who || null, sig ? '/api/fleet/jobs/' + j.id + '/proof/signature' : null, photo ? '/api/fleet/jobs/' + j.id + '/proof/photo' : null]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/fleet/jobs/:id(\\d+)/fail', requireCap('fleet.drive'), async (req, res) => {
    try {
      const j = await myJob(req); const b = req.body || {}; const why = String(b.reason || '').trim();
      if (!why) throw httpError(400, 'Say why it could not be done');
      if (!ACTIVE.includes(j.status)) throw httpError(409, 'This job is ' + j.status);
      await query(`UPDATE dispatch_jobs SET status = 'failed', done_at = NOW(), fail_reason = $2, done_lat = $3, done_lng = $4, updated_at = NOW() WHERE id = $1`, [j.id, why.slice(0, 500), n(b.lat), n(b.lng)]);
      if (j.delivery_id) await query(`UPDATE deliveries SET notes = CONCAT_WS(' | ', notes, $2::text) WHERE id = $1`, [j.delivery_id, 'Attempt failed ' + new Date().toISOString().slice(0, 10) + ': ' + why]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/fleet/sos', requireCap('fleet.drive'), async (req, res) => {
    try {
      const b = req.body || {}; const at = n(b.lat) != null ? { lat: n(b.lat), lng: n(b.lng) } : (await lastPositions([me(req)]))[me(req)];
      const { rows: u } = await query(`SELECT name, phone FROM users WHERE id = $1`, [me(req)]);
      const msg = 'SOS from ' + (u[0] && u[0].name) + (b.message ? ': ' + String(b.message).slice(0, 200) : '');
      await query(`UPDATE fleet_alerts SET cleared_at = NOW() WHERE user_id = $1 AND kind = 'sos' AND cleared_at IS NULL`, [me(req)]);
      const id = await raise(me(req), 'sos', msg, at);
      await managersMail('SOS: ' + (u[0] && u[0].name), msg + '\n\nPhone: ' + ((u[0] && u[0].phone) || '-') + (at ? '\nLocation: https://maps.google.com/?q=' + at.lat + ',' + at.lng : '') + '\n\nSee Dispatch / the security screen.');
      res.json({ ok: true, id });
    } catch (e) { fail(res, e); }
  });

  // ============================================================== dispatch ==
  app.get('/api/fleet/board', requireCap('fleet.view'), async (req, res) => {
    try {
      await syncDeliveries();
      geocodePending().catch(() => {});
      const s = await settings();
      const { rows: jobs } = await query(`SELECT j.*, u.name AS driver_name FROM dispatch_jobs j LEFT JOIN users u ON u.id = j.driver_id WHERE j.status = ANY($1) ORDER BY j.driver_id NULLS FIRST, j.seq NULLS LAST, j.priority, j.due_date NULLS LAST, j.id`, [OPEN]);
      const ds = await drivers();
      const ids = ds.map((d) => d.id);
      const pos = await lastPositions(ids);
      const { rows: shifts } = await query(`SELECT * FROM driver_shifts WHERE ended_at IS NULL AND user_id = ANY($1)`, [ids]);
      const { rows: done } = await query(`SELECT driver_id, COUNT(*) FILTER (WHERE status = 'done')::int AS done, COUNT(*) FILTER (WHERE status = 'failed')::int AS failed FROM dispatch_jobs WHERE done_at > ${today} GROUP BY driver_id`);
      const { rows: alerts } = await query(`SELECT a.*, u.name FROM fleet_alerts a LEFT JOIN users u ON u.id = a.user_id WHERE a.cleared_at IS NULL ORDER BY a.kind = 'sos' DESC, a.created_at DESC`);
      const driverList = ds.map((d) => {
        const mine = jobs.filter((j) => j.driver_id === d.id);
        const p = pos[d.id] || null; const sh = shifts.find((x) => x.user_id === d.id) || null;
        const dn = done.find((x) => x.driver_id === d.id) || {};
        return Object.assign({}, d, { shift: sh, position: p, stale: !!(sh && (!p || Date.now() - new Date(p.at).getTime() > s.quiet_minutes * 60000)),
          open: mine.length, current: (mine.find((j) => j.status === 'en_route' || j.status === 'arrived') || null), done_today: dn.done || 0, failed_today: dn.failed || 0,
          route: routeStats(sh && fresh(p) ? p : s.shop, mine, s.shop) });
      });
      res.json({ jobs: jobs.map(publicJob), drivers: driverList, alerts, shop: s.shop, kinds: KINDS, settings: s, perms: { dispatch: await userCan(req, 'fleet.dispatch') } });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/fleet/jobs/:id(\\d+)', requireCap('fleet.view'), async (req, res) => {
    try { res.json({ job: publicJob(await jobRow(req.params.id)) }); } catch (e) { fail(res, e); }
  });
  function jobFields(b, partial) {
    const f = {};
    if (!partial || 'kind' in b) { if (!KINDS[b.kind || 'delivery']) throw httpError(400, 'Unknown kind of job'); f.kind = b.kind || 'delivery'; }
    if (!partial || 'title' in b) { const t = String(b.title || '').trim(); if (!t) throw httpError(400, 'Say what the job is'); f.title = t.slice(0, 200); }
    for (const k of ['details', 'contact_name', 'contact_phone', 'address']) if (!partial || k in b) f[k] = String(b[k] || '').trim().slice(0, k === 'details' ? 2000 : 300) || null;
    if (!partial || 'priority' in b) f.priority = [1, 2, 3].includes(int(b.priority)) ? int(b.priority) : 2;
    if (!partial || 'due_date' in b) f.due_date = dateOrNull(b.due_date);
    if (!partial || 'window_from' in b) f.window_from = timeOrNull(b.window_from);
    if (!partial || 'window_to' in b) f.window_to = timeOrNull(b.window_to);
    if (!partial || 'amount' in b) { f.amount = n(b.amount); if (f.amount != null && f.amount < 0) throw httpError(400, 'The amount cannot be negative'); }
    if (!partial || 'needs_signature' in b) f.needs_signature = b.needs_signature === undefined ? true : !!b.needs_signature;
    if (!partial || 'needs_photo' in b) f.needs_photo = b.needs_photo === undefined ? ['bank_drop', 'cheque', 'collection'].includes(f.kind) : !!b.needs_photo;
    if (f.kind === 'bank_drop' && f.amount == null && !partial) throw httpError(400, 'How much is going to the bank?');
    if ('lat' in b || 'lng' in b) {
      const lat = n(b.lat), lng = n(b.lng);
      if (lat == null && lng == null) { f.lat = null; f.lng = null; f.geo_source = null; }
      else { if (!okLat(lat) || !okLng(lng)) throw httpError(400, 'That map position is not in Jamaica'); f.lat = lat; f.lng = lng; f.geo_source = 'map'; }
    }
    return f;
  }
  app.post('/api/fleet/jobs', requireCap('fleet.dispatch'), async (req, res) => {
    try {
      const b = req.body || {}; const f = jobFields(b, false);
      if (f.lat == null && f.address) { const g = await geocode(f.address); if (g) { f.lat = g.lat; f.lng = g.lng; f.geo_source = 'geocoded'; } }
      f.number = await nextNumber(); f.created_by = me(req);
      const driver = int(b.driver_id);
      if (driver && !(await drivers()).some((d) => d.id === driver)) throw httpError(400, 'That person is not a driver (give them the "Driver app" permission)');
      if (driver) { f.driver_id = driver; f.status = 'assigned'; f.assigned_at = new Date(); }
      const cols = Object.keys(f);
      const { rows } = await query(`INSERT INTO dispatch_jobs (${cols.join(', ')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(', ')}) RETURNING id, number, lat`, cols.map((k) => f[k]));
      if (driver) await optimise(driver);
      res.json({ ok: true, id: rows[0].id, number: rows[0].number, placed: rows[0].lat != null });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/fleet/jobs/:id(\\d+)', requireCap('fleet.dispatch'), async (req, res) => {
    try {
      const j = await jobRow(req.params.id); const b = req.body || {};
      if (!OPEN.includes(j.status)) throw httpError(409, 'This job is ' + j.status);
      const f = jobFields(Object.assign({}, b, { kind: b.kind || j.kind }), true);
      if ('address' in b && !('lat' in b) && f.address !== j.address) { f.lat = null; f.lng = null; f.geo_source = null; const g = f.address ? await geocode(f.address) : null; if (g) { f.lat = g.lat; f.lng = g.lng; f.geo_source = 'geocoded'; } }
      const cols = Object.keys(f); if (!cols.length) return res.json({ ok: true });
      await query(`UPDATE dispatch_jobs SET ${cols.map((k, i) => k + ' = $' + (i + 2)).join(', ')}, updated_at = NOW() WHERE id = $1`, [j.id].concat(cols.map((k) => f[k])));
      if (j.driver_id) await optimise(j.driver_id);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  async function assign(jobIds, driverId) {
    if (driverId && !(await drivers()).some((d) => d.id === driverId)) throw httpError(400, 'That person is not a driver (give them the "Driver app" permission)');
    const { rows } = await query(`SELECT id, driver_id, status FROM dispatch_jobs WHERE id = ANY($1)`, [jobIds]);
    const touched = new Set(rows.map((r) => r.driver_id).filter(Boolean));
    for (const r of rows) {
      if (!OPEN.includes(r.status)) continue;
      if (driverId) await query(`UPDATE dispatch_jobs SET status = CASE WHEN status = 'queued' OR driver_id IS DISTINCT FROM $2 THEN 'assigned' ELSE status END, driver_id = $2,
        assigned_at = NOW(), seq = NULL, updated_at = NOW() WHERE id = $1`, [r.id, driverId]);
      else await query(`UPDATE dispatch_jobs SET driver_id = NULL, status = 'queued', seq = NULL, assigned_at = NULL, updated_at = NOW() WHERE id = $1`, [r.id]);
    }
    if (driverId) touched.add(driverId);
    for (const d of touched) await optimise(d);
  }
  app.post('/api/fleet/jobs/:id(\\d+)/assign', requireCap('fleet.dispatch'), async (req, res) => {
    try { await jobRow(req.params.id); await assign([int(req.params.id)], int((req.body || {}).driver_id)); res.json({ ok: true }); } catch (e) { fail(res, e); }
  });
  app.post('/api/fleet/assign', requireCap('fleet.dispatch'), async (req, res) => {
    try {
      const ids = (Array.isArray((req.body || {}).job_ids) ? req.body.job_ids : []).map(int).filter(Boolean);
      if (!ids.length) throw httpError(400, 'Choose jobs');
      await assign(ids, int(req.body.driver_id));
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/fleet/jobs/:id(\\d+)/cancel', requireCap('fleet.dispatch'), async (req, res) => {
    try {
      const j = await jobRow(req.params.id); const why = String((req.body || {}).reason || '').trim();
      if (!OPEN.includes(j.status)) throw httpError(409, 'This job is ' + j.status);
      if (!why) throw httpError(400, 'Say why it is cancelled');
      await query(`UPDATE dispatch_jobs SET status = 'cancelled', fail_reason = $2, done_at = NOW(), updated_at = NOW() WHERE id = $1`, [j.id, why.slice(0, 500)]);
      if (j.delivery_id) await query(`UPDATE deliveries SET status = 'cancelled', notes = CONCAT_WS(' | ', notes, $2::text) WHERE id = $1 AND status <> 'delivered'`, [j.delivery_id, 'Cancelled in dispatch: ' + why]);
      if (j.driver_id) await optimise(j.driver_id);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/fleet/drivers/:id(\\d+)/optimise', requireCap('fleet.dispatch'), async (req, res) => {
    try { res.json(Object.assign({ ok: true }, await optimise(int(req.params.id)))); } catch (e) { fail(res, e); }
  });
  app.get('/api/fleet/drivers/:id(\\d+)/route', requireCap('fleet.view'), async (req, res) => {
    try { res.json(await routeFor(int(req.params.id))); } catch (e) { fail(res, e); }
  });
  app.post('/api/fleet/geocode', requireCap('fleet.dispatch'), async (req, res) => {
    try { const g = await geocode((req.body || {}).address); res.json({ found: !!g, lat: g && g.lat, lng: g && g.lng, label: g && g.label }); } catch (e) { fail(res, e); }
  });
  // Where a driver went on a day (the trail on the map) and how far.
  app.get('/api/fleet/track/:id(\\d+)', requireCap('fleet.view'), async (req, res) => {
    try {
      const day = dateOrNull(req.query.date) || new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10);
      const { rows } = await query(`SELECT lat, lng, speed, at FROM driver_positions WHERE user_id = $1 AND (at AT TIME ZONE 'America/Jamaica')::date = $2::date ORDER BY at`, [int(req.params.id), day]);
      let m = 0; for (let i = 1; i < rows.length; i++) { const d = metres(rows[i - 1], rows[i]); if (d < 5000) m += d; }
      res.json({ date: day, points: rows, km: Math.round(m / 100) / 10 });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/fleet/history', requireCap('fleet.view'), async (req, res) => {
    try {
      const day = dateOrNull(req.query.date) || new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10);
      const { rows } = await query(`SELECT j.*, u.name AS driver_name FROM dispatch_jobs j LEFT JOIN users u ON u.id = j.driver_id
        WHERE j.status IN ('done', 'failed', 'cancelled') AND (j.done_at AT TIME ZONE 'America/Jamaica')::date = $1::date ORDER BY j.done_at DESC`, [day]);
      const { rows: sh } = await query(`SELECT s.*, u.name FROM driver_shifts s JOIN users u ON u.id = s.user_id WHERE (s.started_at AT TIME ZONE 'America/Jamaica')::date = $1::date ORDER BY s.started_at`, [day]);
      res.json({ date: day, jobs: rows.map(publicJob), shifts: sh });
    } catch (e) { fail(res, e); }
  });
  // Proof of delivery: the driver who did it, or anyone allowed to see the fleet.
  app.get('/api/fleet/jobs/:id(\\d+)/proof/:what(signature|photo)', async (req, res) => {
    try {
      if (!me(req)) throw httpError(401, 'Sign in');
      const j = await jobRow(req.params.id);
      if (j.driver_id !== me(req) && !(await userCan(req, 'fleet.view'))) throw httpError(403, 'Not allowed');
      const f = req.params.what === 'signature' ? j.signature_file : j.photo_file;
      if (!f || !/^\d{4}-\d{2}\/\d+-(signature|photo)-[0-9a-f]+\.(png|jpg)$/.test(f)) throw httpError(404, 'No ' + req.params.what);
      res.setHeader('Content-Type', f.endsWith('.png') ? 'image/png' : 'image/jpeg');
      res.setHeader('Cache-Control', 'private, max-age=300');
      fs.createReadStream(path.join(PROOF, f)).pipe(res);
    } catch (e) { fail(res, e); }
  });
  app.post('/api/fleet/alerts/:id(\\d+)/clear', requireCap('fleet.dispatch'), async (req, res) => {
    try { await query(`UPDATE fleet_alerts SET cleared_at = NOW(), cleared_by = $2 WHERE id = $1 AND cleared_at IS NULL`, [int(req.params.id), me(req)]); res.json({ ok: true }); } catch (e) { fail(res, e); }
  });
  app.post('/api/fleet/check', requireCap('fleet.dispatch'), async (req, res) => {
    try { await checkFleet(); res.json({ ok: true }); } catch (e) { fail(res, e); }
  });
  app.get('/api/fleet/settings', requireCap('fleet.view'), async (req, res) => { try { res.json(await settings()); } catch (e) { fail(res, e); } });
  app.put('/api/fleet/settings', requireCap('fleet.dispatch'), async (req, res) => {
    try {
      const b = req.body || {};
      if ('shop_lat' in b || 'shop_lng' in b) { if (!okLat(n(b.shop_lat)) || !okLng(n(b.shop_lng))) throw httpError(400, 'The shop must be in Jamaica'); await putSetting('shop_lat', n(b.shop_lat)); await putSetting('shop_lng', n(b.shop_lng)); }
      const lim = { ping_seconds: [5, 120], quiet_minutes: [2, 60], stop_minutes: [5, 180], speed_kmh: [40, 200], arrive_metres: [30, 1000] };
      for (const k in lim) if (k in b) { const v = int(b[k]); if (v == null || v < lim[k][0] || v > lim[k][1]) throw httpError(400, k.replace(/_/g, ' ') + ' must be ' + lim[k][0] + '-' + lim[k][1]); await putSetting(k, v); }
      res.json(Object.assign({ ok: true }, await settings()));
    } catch (e) { fail(res, e); }
  });

  // ---------------------------------------------------- security monitor --
  const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
  app.get('/api/fleet/screens', requireCap('fleet.dispatch'), async (req, res) => {
    try { const { rows } = await query(`SELECT s.id, s.name, s.created_at, s.last_seen_at, s.last_ip, s.revoked_at, u.name AS created_by_name FROM fleet_screens s LEFT JOIN users u ON u.id = s.created_by ORDER BY s.created_at DESC`); res.json({ screens: rows }); } catch (e) { fail(res, e); }
  });
  app.post('/api/fleet/screens', requireCap('fleet.dispatch'), async (req, res) => {
    try {
      const name = String((req.body || {}).name || '').trim(); if (!name) throw httpError(400, 'Name the screen (e.g. Security desk)');
      const token = crypto.randomBytes(24).toString('hex');
      await query(`INSERT INTO fleet_screens (name, token_hash, created_by) VALUES ($1, $2, $3)`, [name.slice(0, 80), hash(token), me(req)]);
      res.json({ ok: true, link: '/fleet-wall.html#key=' + token });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/fleet/screens/:id(\\d+)/revoke', requireCap('fleet.dispatch'), async (req, res) => {
    try { await query(`UPDATE fleet_screens SET revoked_at = NOW() WHERE id = $1`, [int(req.params.id)]); res.json({ ok: true }); } catch (e) { fail(res, e); }
  });
  // Read-only live picture: a signed-in user with fleet.view, or a screen key (sent as a header, never in the URL query).
  app.get('/api/fleet/wall', async (req, res) => {
    try {
      let ok = false, screen = null;
      const key = String(req.headers['x-screen-key'] || '');
      if (key) {
        const { rows } = await query(`UPDATE fleet_screens SET last_seen_at = NOW(), last_ip = $2 WHERE token_hash = $1 AND revoked_at IS NULL RETURNING name`, [hash(key), ipOf(req)]);
        if (rows.length) { ok = true; screen = rows[0].name; }
      } else if (me(req)) ok = await userCan(req, 'fleet.view');
      if (!ok) throw httpError(key ? 403 : 401, key ? 'This screen link has been switched off. Ask a manager for a new one.' : 'Sign in');
      await syncDeliveries();
      const s = await settings();
      const ds = await drivers();
      const pos = await lastPositions(ds.map((d) => d.id));
      const { rows: shifts } = await query(`SELECT user_id, vehicle, started_at FROM driver_shifts WHERE ended_at IS NULL`);
      const { rows: jobs } = await query(`SELECT id, number, kind, title, address, lat, lng, status, driver_id, seq, priority, amount FROM dispatch_jobs WHERE status = ANY($1) ORDER BY driver_id, seq NULLS LAST`, [OPEN]);
      const { rows: alerts } = await query(`SELECT a.id, a.kind, a.message, a.lat, a.lng, a.created_at, u.name FROM fleet_alerts a LEFT JOIN users u ON u.id = a.user_id WHERE a.cleared_at IS NULL ORDER BY a.kind = 'sos' DESC, a.created_at DESC`);
      const { rows: done } = await query(`SELECT COUNT(*) FILTER (WHERE status = 'done')::int AS done, COUNT(*) FILTER (WHERE status = 'failed')::int AS failed FROM dispatch_jobs WHERE done_at > ${today}`);
      // The last 30 minutes of each driver's trail.
      const { rows: trail } = await query(`SELECT user_id, lat, lng FROM driver_positions WHERE at > NOW() - INTERVAL '30 minutes' AND user_id = ANY($1) ORDER BY user_id, at`, [shifts.map((x) => x.user_id)]);
      const onShift = ds.filter((d) => shifts.some((x) => x.user_id === d.id)).map((d) => {
        const p = pos[d.id] || null; const sh = shifts.find((x) => x.user_id === d.id);
        const mine = jobs.filter((j) => j.driver_id === d.id);
        return { id: d.id, name: d.name, vehicle: sh.vehicle, since: sh.started_at, position: p, stale: !p || Date.now() - new Date(p.at).getTime() > s.quiet_minutes * 60000,
          current: mine.find((j) => j.status === 'en_route' || j.status === 'arrived') || null, next: mine.filter((j) => j.status === 'assigned').slice(0, 3),
          open: mine.length, cash: mine.filter((j) => ['bank_drop', 'collection', 'cheque'].includes(j.kind)).reduce((t, j) => t + Number(j.amount || 0), 0),
          trail: trail.filter((t) => t.user_id === d.id).map((t) => [t.lat, t.lng]) };
      });
      res.json({ screen, at: new Date().toISOString(), shop: s.shop, quiet_minutes: s.quiet_minutes, drivers: onShift, jobs: jobs.map((j) => Object.assign(j, { kind_label: KINDS[j.kind] })),
        alerts, today: done[0], queued: jobs.filter((j) => !j.driver_id).length });
    } catch (e) { fail(res, e); }
  });

  // --------------------------------------------------- the mobile app shell --
  // Install as an app (home-screen icon, full screen). Served from here because
  // the website folder refuses to serve .js files at its top level.
  app.get('/mobile.webmanifest', (req, res) => {
    res.type('application/manifest+json').send(JSON.stringify({
      name: 'Morty\'s Auto Parts Mobile', short_name: 'Morty\'s Auto', start_url: '/mobile.html', scope: '/', display: 'standalone', orientation: 'portrait',
      background_color: '#0a0a0c', theme_color: '#d61f2b', description: 'Stock counts, picking and put-away, deliveries, time clock and cashier',
      icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }, { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' }],
    }));
  });
  app.get('/mobile-sw.js', (req, res) => {
    res.type('application/javascript').set('Cache-Control', 'no-cache').set('Service-Worker-Allowed', '/').send(
      "// Network first, always: the till's data must be live. Offline, pages say so instead of a browser error.\n" +
      "self.addEventListener('install', function (e) { self.skipWaiting(); });\n" +
      "self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });\n" +
      "self.addEventListener('fetch', function (e) {\n" +
      "  if (e.request.mode !== 'navigate') return;\n" +
      "  e.respondWith(fetch(e.request).catch(function () { return new Response('<!doctype html><meta name=viewport content=\"width=device-width\"><body style=\"font-family:sans-serif;padding:24px;background:#0a0a0c;color:#fff\"><h2>No connection to the shop</h2><p>Check Wi-Fi or mobile data (and Tailscale if you are out on the road), then pull down to try again.</p>', { headers: { 'Content-Type': 'text/html' } }); }));\n" +
      "});\n");
  });

  return { syncDeliveries, orderRoute, metres };
};
