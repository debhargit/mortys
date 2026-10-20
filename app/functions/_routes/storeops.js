// Department store + cashier, ported from the till (terminal.js departments,
// deptstore.js, cashier.js) to D1. Same routes and reply shapes, so admin.html,
// deptstore.html and cashier.html work unchanged on the website.
//
//   /api/dept, /api/dept/:id[/users|/stations], /api/dept/settings, /api/dept/mine
//   /api/deptstore/*          stores, inventory & sales by department, transfers
//   /api/cash/*               stations, till shifts, ensure, collectors, paid
//
// Money: till amounts are J$ numbers; D1 sales keep *_cents, so reports divide
// by 100. Arrays (departments.categories) are JSON text. Stock per store uses
// the location_stock_v view (branches stored, main store = total - branches).
import { d1 } from '../_lib/db.js';
import { adminMw, roleCanManage } from '../_lib/guards.js';
import { readSession, sessionCookie } from '../_lib/session.js';

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const cats = (v) => { try { const a = typeof v === 'string' ? JSON.parse(v || '[]') : v; return Array.isArray(a) ? a.map((x) => String(x).toLowerCase()) : []; } catch { return []; } };
const yes = (v) => v === true || v === 1 || v === '1';
const DENOMS = [5000, 1000, 500, 100, 50, 20, 10, 5, 1];
function countTotal(count) {
  if (!count || typeof count !== 'object') return 0;
  let t = 0;
  for (const d of DENOMS) { const q = parseInt(count[d], 10); if (q > 0) t += q * d; }
  return r2(t);
}
async function sha256hex(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s)));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
const err = (status, message) => Object.assign(new Error(message), { status });

export default function mount(app) {
  // ------------------------------------------------------------ helpers --
  const DB = (c) => d1(c.env);
  async function setting(db, key, dflt) {
    const r = await db.one('SELECT value FROM warehouse_settings WHERE key = ?', key);
    return r && r.value != null ? r.value : dflt;
  }
  async function putSetting(db, key, value) {
    await db.run('INSERT INTO warehouse_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
  }
  // Supervisory capabilities are OFF unless the role manages or the person was
  // granted them by name (the till's RESTRICTED_CAPS rule).
  async function isManager(c, u) { return !!(u && (u.admin_role === 'owner' || (await roleCanManage(c.env, u.admin_role)))); }
  async function capR(c, u, key) {
    if (await isManager(c, u)) return true;
    let p = {}; try { p = u && u.perms ? JSON.parse(u.perms) : {}; } catch { p = {}; }
    return p[key] === true;
  }
  function capOpen(u, key) {   // ordinary caps: on unless denied
    if (!u || !u.is_admin) return false;
    if (u.admin_role === 'owner') return true;
    let p = {}; try { p = u.perms ? JSON.parse(u.perms) : {}; } catch { p = {}; }
    return p[key] !== false;
  }
  const need = (key, restricted) => async (c, next) => {
    const u = c.get('user');
    const ok = restricted ? await capR(c, u, key) : capOpen(u, key);
    if (!ok) return c.json({ error: 'Your account is not allowed to do that.' }, 403);
    await next();
  };
  const fail = (c, e) => {
    if (e && e.status) return c.json({ error: e.message }, e.status);
    if (/UNIQUE constraint/i.test(String(e && e.message))) return c.json({ error: 'That is already used' }, 409);
    console.error('[storeops]', e);
    return c.json({ error: 'Server error' }, 500);
  };
  const body = async (c) => c.req.json().catch(() => ({}));

  async function stationOf(c) {
    const key = c.req.header('x-station-key');
    if (!key || key.length < 20) return null;
    return DB(c).one('SELECT * FROM pos_stations WHERE device_key_hash = ? AND is_active = 1', await sha256hex(key));
  }
  async function defaultLocationId(db) {
    const r = await db.one('SELECT id FROM store_locations WHERE is_default = 1 ORDER BY sort, id LIMIT 1');
    return r ? r.id : null;
  }
  // The default till (shared counter PC). Created as "Main Till" on first use.
  async function defaultStation(db) {
    const id = parseInt(await setting(db, 'cash_default_station_id', ''), 10);
    if (id) { const s = await db.one('SELECT * FROM pos_stations WHERE id = ? AND is_active = 1', id); if (s) return s; }
    let s = await db.one("SELECT * FROM pos_stations WHERE name = 'Main Till' COLLATE NOCASE AND is_active = 1 LIMIT 1");
    if (!s) {
      await db.run("INSERT OR IGNORE INTO pos_stations (name, kind, is_active, location_id) VALUES ('Main Till', 'integrated', 1, ?)", await defaultLocationId(db));
      s = await db.one("SELECT * FROM pos_stations WHERE name = 'Main Till' COLLATE NOCASE LIMIT 1");
    }
    if (s) await putSetting(db, 'cash_default_station_id', s.id);
    return s || null;
  }
  async function terminalStation(c) { return (await stationOf(c)) || (await defaultStation(DB(c))); }
  async function openSession(db, stationId) {
    return db.one("SELECT * FROM till_sessions WHERE station_id = ? AND status = 'open'", stationId);
  }
  async function autoOpen(db, stationId, userId) {
    const float = r2(parseFloat(await setting(db, 'cash_default_float', '0')) || 0);
    try {
      await db.run("INSERT INTO till_sessions (station_id, user_id, status, opening_float, opening_count, opened_at) VALUES (?, ?, 'open', ?, '{}', CURRENT_TIMESTAMP)", stationId, userId, float);
    } catch (e) { if (!/UNIQUE/i.test(e.message)) throw e; }
    return openSession(db, stationId);
  }
  const autoOpenOn = async (db) => (await setting(db, 'cash_auto_open', 'on')) === 'on';

  // ======================================================= departments --
  async function allowedFor(c) {
    const db = DB(c), u = c.get('user');
    if ((await setting(db, 'dept_enforce', 'off')) !== 'on') return { restricted: false, enforce: false };
    if (await isManager(c, u)) return { restricted: false, enforce: true, manager: true };
    let rows = await db.many('SELECT d.name, d.categories FROM user_departments ud JOIN departments d ON d.id = ud.department_id WHERE ud.user_id = ? AND d.is_active = 1', u.id);
    let source = 'user';
    if (!rows.length) {
      const st = await stationOf(c);
      if (st) rows = await db.many('SELECT d.name, d.categories FROM station_departments sd JOIN departments d ON d.id = sd.department_id WHERE sd.station_id = ? AND d.is_active = 1', st.id);
      source = 'station';
    }
    if (!rows.length) return { restricted: false, enforce: true };
    const set = new Set(); rows.forEach((r) => cats(r.categories).forEach((x) => set.add(x)));
    return { restricted: true, enforce: true, categories: set, departments: rows.map((r) => r.name), source };
  }
  // Exposed for the sale/order hooks in pos_txn.
  app.__deptGuard = async (c, items) => {
    const a = await allowedFor(c);
    if (!a.restricted) return null;
    const imgs = [...new Set((items || []).map((i) => i.product_img).filter(Boolean))];
    if (!imgs.length) return null;
    const rows = await DB(c).many(`SELECT img, name, lower(category) AS category FROM products WHERE img IN (SELECT value FROM json_each(?))`, JSON.stringify(imgs));
    const out = rows.filter((p) => !a.categories.has(p.category));
    if (!out.length) return null;
    return { status: 403, body: { error: 'Outside your department' + (a.departments.length > 1 ? 's' : '') + ' (' + a.departments.join(', ') + '): ' + out.map((p) => p.name).join(', ') + '. A manager must approve these on the till.', out_of_department: out } };
  };

  async function deptChoice(c) {
    const db = DB(c), u = c.get('user');
    const manager = await isManager(c, u);
    let options = [];
    if (manager) options = await db.many("SELECT id, code, name, kind FROM departments WHERE is_active = 1 ORDER BY (kind = 'general') DESC, sort, name");
    else if (u) {
      options = await db.many(`SELECT d.id, d.code, d.name, d.kind FROM user_departments ud JOIN departments d ON d.id = ud.department_id
         WHERE ud.user_id = ? AND d.is_active = 1 AND d.kind <> 'general' ORDER BY d.sort, d.name`, u.id);
      if (!options.length) {
        const st = await stationOf(c);
        if (st) options = await db.many(`SELECT d.id, d.code, d.name, d.kind FROM station_departments sd JOIN departments d ON d.id = sd.department_id
            WHERE sd.station_id = ? AND d.is_active = 1 AND d.kind <> 'general' ORDER BY d.sort, d.name`, st.id);
      }
    }
    const s = (await readSession(c.req.raw, c.env)) || {};
    const want = Number(s.posDeptId) || null;
    const current = options.find((d) => d.id === want) || (manager ? options.find((d) => d.kind === 'general') : null) || options[0] || null;
    return { manager, options, current, general: !!(manager && current && current.kind === 'general'), session: s };
  }
  app.__isGeneral = async (c) => (await deptChoice(c)).general;

  app.get('/api/dept/mine', adminMw, async (c) => {
    try {
      const a = await allowedFor(c), d = await deptChoice(c);
      return c.json({ enforce: !!a.enforce, restricted: !!a.restricted, categories: a.categories ? [...a.categories] : null, departments: a.departments || [], source: a.source || null,
        current: d.current || { id: null, code: null, name: 'All departments', kind: 'all' }, options: d.options, general: d.general, can_choose_collector: d.general });
    } catch (e) { return fail(c, e); }
  });
  app.post('/api/dept/mine', adminMw, async (c) => {
    try {
      const b = await body(c);
      const id = b.department_id == null || b.department_id === '' ? null : Number(b.department_id);
      const d0 = await deptChoice(c);
      if (id && !d0.options.some((x) => x.id === id)) throw err(403, 'You cannot work in that department.');
      // The session is a signed cookie: re-issue it with the choice in it.
      c.header('Set-Cookie', await sessionCookie(c.env, { userId: d0.session.userId, epoch: d0.session.epoch || 0, posDeptId: id }));
      const cur = d0.options.find((x) => x.id === id) || (d0.manager ? d0.options.find((x) => x.kind === 'general') : null) || d0.options[0] || null;
      return c.json({ ok: true, current: cur, general: !!(d0.manager && cur && cur.kind === 'general') });
    } catch (e) { return fail(c, e); }
  });

  app.get('/api/dept', adminMw, need('dept.manage', true), async (c) => {
    try {
      const db = DB(c);
      const depts = await db.many('SELECT * FROM departments ORDER BY name');
      const ud = await db.many('SELECT ud.department_id, u.id, u.name FROM user_departments ud JOIN users u ON u.id = ud.user_id');
      const sd = await db.many('SELECT sd.department_id, s.id, s.name FROM station_departments sd JOIN pos_stations s ON s.id = sd.station_id');
      const departments = depts.map((d) => ({ ...d, categories: cats(d.categories), is_active: yes(d.is_active),
        users: ud.filter((x) => x.department_id === d.id).map((x) => ({ id: x.id, name: x.name })),
        stations: sd.filter((x) => x.department_id === d.id).map((x) => ({ id: x.id, name: x.name })) }));
      const categories = await db.many("SELECT lower(category) AS category, COUNT(*) AS parts FROM products WHERE is_active = 1 AND category IS NOT NULL AND category <> '' GROUP BY 1 ORDER BY 1");
      const staff = await db.many('SELECT id, name, admin_role FROM users WHERE (is_staff = 1 OR is_admin = 1) AND COALESCE(disabled, 0) = 0 AND COALESCE(is_archived, 0) = 0 ORDER BY name');
      const stations = await db.many('SELECT id, name, kind FROM pos_stations WHERE is_active = 1 ORDER BY name');
      const locations = await db.many('SELECT id, name, kind, is_default FROM store_locations WHERE is_active = 1 ORDER BY sort, id');
      const settings = {};
      for (const k of ['dept_enforce', 'tj_void_alert', 'tj_discount_pct_alert', 'tj_nosale_per_day', 'tj_removed_per_day']) settings[k] = await setting(db, k, null);
      return c.json({ departments, categories, staff, stations, locations, settings });
    } catch (e) { return fail(c, e); }
  });
  function cleanDept(b) {
    const out = {};
    if (b.name !== undefined) { out.name = String(b.name || '').trim().slice(0, 60); if (!out.name) throw err(400, 'Name the department'); }
    if (b.code !== undefined) { out.code = String(b.code || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 20); if (!out.code) throw err(400, 'Give it a short code'); }
    if (b.categories !== undefined) out.categories = JSON.stringify((Array.isArray(b.categories) ? b.categories : []).map((x) => String(x).toLowerCase().trim()).filter(Boolean).slice(0, 100));
    if (b.is_active !== undefined) out.is_active = b.is_active === true || yes(b.is_active) ? 1 : 0;
    if (b.location_id !== undefined) out.location_id = b.location_id === null ? null : (parseInt(b.location_id, 10) || null);
    return out;
  }
  app.post('/api/dept', adminMw, need('dept.manage', true), async (c) => {
    try {
      const db = DB(c), b = await body(c);
      const d = cleanDept(Object.assign({ code: b.code || b.name }, b));
      if (!d.name) throw err(400, 'Name the department');
      const r = await db.run('INSERT INTO departments (code, name, categories, location_id) VALUES (?, ?, ?, ?)', d.code, d.name, d.categories || '[]', d.location_id || (await defaultLocationId(db)));
      return c.json({ department: await db.one('SELECT * FROM departments WHERE id = ?', r.meta.last_row_id) });
    } catch (e) { return fail(c, e); }
  });
  app.patch('/api/dept/:id', adminMw, need('dept.manage', true), async (c) => {
    try {
      const db = DB(c), d = cleanDept(await body(c));
      const keys = Object.keys(d);
      if (!keys.length) throw err(400, 'Nothing to change');
      const r = await db.run(`UPDATE departments SET ${keys.map((k) => k + ' = ?').join(', ')} WHERE id = ?`, ...keys.map((k) => d[k]), c.req.param('id'));
      if (!r.meta.changes) throw err(404, 'Department not found');
      return c.json({ department: await db.one('SELECT * FROM departments WHERE id = ?', c.req.param('id')) });
    } catch (e) { return fail(c, e); }
  });
  async function setMembers(db, table, col, deptId, ids) {
    const clean = [...new Set((Array.isArray(ids) ? ids : []).map((x) => parseInt(x, 10)).filter(Boolean))];
    await db.batch([{ sql: `DELETE FROM ${table} WHERE department_id = ?`, binds: [deptId] },
      ...clean.map((id) => ({ sql: `INSERT OR IGNORE INTO ${table} (${col}, department_id) VALUES (?, ?)`, binds: [id, deptId] }))]);
    return clean.length;
  }
  app.put('/api/dept/:id/users', adminMw, need('dept.manage', true), async (c) => {
    try { return c.json({ users: await setMembers(DB(c), 'user_departments', 'user_id', parseInt(c.req.param('id'), 10), (await body(c)).user_ids) }); } catch (e) { return fail(c, e); }
  });
  app.put('/api/dept/:id/stations', adminMw, need('dept.manage', true), async (c) => {
    try { return c.json({ stations: await setMembers(DB(c), 'station_departments', 'station_id', parseInt(c.req.param('id'), 10), (await body(c)).station_ids) }); } catch (e) { return fail(c, e); }
  });
  app.put('/api/dept/settings', adminMw, need('dept.manage', true), async (c) => {
    try {
      const db = DB(c), b = await body(c);
      if (b.dept_enforce !== undefined) await putSetting(db, 'dept_enforce', b.dept_enforce === 'on' || b.dept_enforce === true ? 'on' : 'off');
      for (const k of ['tj_void_alert', 'tj_discount_pct_alert', 'tj_nosale_per_day', 'tj_removed_per_day']) {
        if (b[k] === undefined) continue;
        const v = Number(b[k]);
        if (!(v >= 0) || v > 100000000) throw err(400, 'Numbers only');
        await putSetting(db, k, v);
      }
      return c.json({ ok: true });
    } catch (e) { return fail(c, e); }
  });

  // ====================================================== department store --
  const view = need('reports.view', false), manage = need('dept.manage', true);
  const CAT = "lower(COALESCE(NULLIF(TRIM(p.category), ''), '(uncategorised)'))";
  function bucketize(depts, rows, init, add) {
    const catMap = new Map();
    for (const d of depts) for (const x of cats(d.categories)) if (!catMap.has(x)) catMap.set(x, d);
    const b = new Map();
    for (const d of depts) b.set(d.id, { id: d.id, code: d.code, name: d.name, kind: d.kind, categories: cats(d.categories), ...init() });
    b.set('un', { id: null, code: null, name: 'Unassigned', kind: 'unassigned', categories: [], ...init() });
    for (const r of rows) { const d = catMap.get(r.category); add(b.get(d ? d.id : 'un'), r); }
    return [...b.values()];
  }

  app.get('/api/deptstore/locations', adminMw, view, async (c) => {
    try {
      const rows = await DB(c).many(`
        SELECT l.*,
          (SELECT COUNT(*) FROM departments d WHERE d.location_id = l.id AND d.is_active = 1 AND d.kind <> 'general') AS departments,
          (SELECT COUNT(*) FROM pos_stations s WHERE s.location_id = l.id AND s.is_active = 1) AS tills,
          COALESCE((SELECT SUM(v.qty) FROM location_stock_v v WHERE v.location_id = l.id), 0) AS units,
          COALESCE((SELECT SUM(v.qty * COALESCE(p.cost_cents, 0)) FROM location_stock_v v JOIN products p ON p.img = v.product_img WHERE v.location_id = l.id), 0) / 100.0 AS cost_value,
          COALESCE((SELECT SUM(v.qty * COALESCE(p.price_cents, 0)) FROM location_stock_v v JOIN products p ON p.img = v.product_img WHERE v.location_id = l.id), 0) / 100.0 AS retail_value
        FROM store_locations l ORDER BY l.sort, l.id`);
      return c.json({ locations: rows.map((r) => ({ ...r, is_active: yes(r.is_active), is_default: yes(r.is_default) })) });
    } catch (e) { return fail(c, e); }
  });
  const KINDS = ['store', 'supermarket', 'wholesale', 'warehouse', 'branch'];
  app.post('/api/deptstore/locations', adminMw, manage, async (c) => {
    try {
      const db = DB(c), b = await body(c);
      const code = String(b.code || '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '');
      const name = String(b.name || '').trim();
      if (!code || !name) throw err(400, 'Code and name are required');
      const kind = KINDS.includes(b.kind) ? b.kind : 'store';
      let r;
      try { r = await db.run('INSERT INTO store_locations (code, name, kind, address, phone, sort) VALUES (?, ?, ?, ?, ?, ?)', code, name, kind, b.address || null, b.phone || null, num(b.sort, 0)); }
      catch (e) { if (/UNIQUE/i.test(e.message)) throw err(409, 'That code is already used'); throw e; }
      return c.json({ location: await db.one('SELECT * FROM store_locations WHERE id = ?', r.meta.last_row_id) });
    } catch (e) { return fail(c, e); }
  });
  app.patch('/api/deptstore/locations/:id', adminMw, manage, async (c) => {
    try {
      const db = DB(c), id = Number(c.req.param('id')), b = await body(c);
      const sets = [], vals = [];
      const set = (k, v) => { sets.push(k + ' = ?'); vals.push(v); };
      if (b.name != null) set('name', String(b.name).trim());
      if (b.kind != null && KINDS.includes(b.kind)) set('kind', b.kind);
      if (b.address !== undefined) set('address', b.address || null);
      if (b.phone !== undefined) set('phone', b.phone || null);
      if (b.is_active != null) set('is_active', b.is_active ? 1 : 0);
      if (b.sort != null) set('sort', num(b.sort));
      if (sets.length) await db.run(`UPDATE store_locations SET ${sets.join(', ')} WHERE id = ?`, ...vals, id);
      if (b.is_default === true) {
        const held = await db.one('SELECT COUNT(*) AS c FROM location_stock ls JOIN store_locations l ON l.id = ls.location_id AND l.is_default = 0 WHERE ls.qty > 0');
        if (num(held.c) > 0) throw err(400, 'Move all branch stock back to the main store before changing which store is the main one.');
        await db.run('UPDATE store_locations SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END', id);
      }
      const row = await db.one('SELECT * FROM store_locations WHERE id = ?', id);
      if (!row) throw err(404, 'Not found');
      return c.json({ location: { ...row, is_active: yes(row.is_active), is_default: yes(row.is_default) } });
    } catch (e) { return fail(c, e); }
  });
  app.delete('/api/deptstore/locations/:id', adminMw, manage, async (c) => {
    try {
      const db = DB(c), id = Number(c.req.param('id'));
      const d = await db.one('SELECT is_default FROM store_locations WHERE id = ?', id);
      if (!d) throw err(404, 'Not found');
      if (yes(d.is_default)) throw err(400, 'Cannot delete the default location. Make another the default first.');
      const st = await db.one('SELECT COALESCE(SUM(qty), 0) AS q FROM location_stock WHERE location_id = ?', id);
      if (num(st.q) > 0) throw err(400, 'This location still holds stock. Transfer it out first.');
      const tr = await db.one('SELECT COUNT(*) AS c FROM stock_transfers WHERE from_location_id = ? OR to_location_id = ?', id, id);
      if (num(tr.c) > 0) throw err(400, 'This location has transfer history and cannot be deleted. Switch it off (Active) instead to keep the records.');
      await db.batch([{ sql: 'DELETE FROM location_stock WHERE location_id = ?', binds: [id] }, { sql: 'DELETE FROM departments WHERE location_id = ?', binds: [id] },
        { sql: 'DELETE FROM store_locations WHERE id = ?', binds: [id] }]);
      return c.json({ ok: true });
    } catch (e) { return fail(c, e); }
  });

  app.get('/api/deptstore/inventory', adminMw, view, async (c) => {
    try {
      const db = DB(c);
      const locId = Number(c.req.query('location')) || await defaultLocationId(db);
      if (!locId) return c.json({ location_id: null, departments: [] });
      const rows = await db.many(`SELECT ${CAT} AS category, COUNT(DISTINCT p.img) AS skus, COALESCE(SUM(v.qty), 0) AS units,
             COALESCE(SUM(v.qty * COALESCE(p.cost_cents, 0)), 0) / 100.0 AS cost_value, COALESCE(SUM(v.qty * COALESCE(p.price_cents, 0)), 0) / 100.0 AS retail_value
        FROM products p JOIN location_stock_v v ON v.product_img = p.img AND v.location_id = ? GROUP BY 1`, locId);
      const depts = await db.many("SELECT id, code, name, kind, categories FROM departments WHERE location_id = ? AND is_active = 1 AND kind <> 'general' ORDER BY sort, name", locId);
      const out = bucketize(depts, rows, () => ({ skus: 0, units: 0, cost_value: 0, retail_value: 0 }), (t, r) => {
        t.skus += num(r.skus); t.units += num(r.units); t.cost_value = r2(t.cost_value + num(r.cost_value)); t.retail_value = r2(t.retail_value + num(r.retail_value));
      }).filter((t) => t.id !== null || t.units > 0 || t.skus > 0);
      return c.json({ location_id: locId, departments: out });
    } catch (e) { return fail(c, e); }
  });
  app.get('/api/deptstore/inventory/items', adminMw, view, async (c) => {
    try {
      const db = DB(c);
      const locId = Number(c.req.query('location')) || await defaultLocationId(db);
      const q = c.req.query('department');
      let list;
      if (q === 'un') {
        const all = await db.many('SELECT categories FROM departments WHERE location_id = ?', locId);
        const assigned = [...new Set(all.flatMap((r) => cats(r.categories)))];
        list = { sql: 'NOT IN (SELECT value FROM json_each(?))', arg: JSON.stringify(assigned.length ? assigned : ['']) };
      } else {
        const d = await db.one('SELECT categories FROM departments WHERE id = ?', Number(q) || 0);
        const cs = d ? cats(d.categories) : [];
        if (!cs.length) return c.json({ items: [] });
        list = { sql: 'IN (SELECT value FROM json_each(?))', arg: JSON.stringify(cs) };
      }
      const items = await db.many(`SELECT p.img, p.name, p.sku, p.category, v.qty, p.cost_cents / 100.0 AS cost_usd, p.price_cents / 100.0 AS price_usd
          FROM products p JOIN location_stock_v v ON v.product_img = p.img AND v.location_id = ?
         WHERE ${CAT} ${list.sql} ORDER BY p.name LIMIT 500`, locId, list.arg);
      return c.json({ items });
    } catch (e) { return fail(c, e); }
  });
  app.get('/api/deptstore/sales', adminMw, view, async (c) => {
    try {
      const db = DB(c);
      const locId = Number(c.req.query('location')) || await defaultLocationId(db);
      const defId = await defaultLocationId(db);
      const from = c.req.query('from') || '1900-01-01', to = c.req.query('to') || '2999-12-31';
      const rows = await db.many(`SELECT ${CAT} AS category, COALESCE(SUM(i.qty), 0) AS units,
             COALESCE(SUM(i.total_cents), 0) / 100.0 AS revenue, COALESCE(SUM(i.qty * COALESCE(p.cost_cents, 0)), 0) / 100.0 AS cost
        FROM pos_sale_items i JOIN pos_sales s ON s.id = i.sale_id LEFT JOIN products p ON p.img = i.product_img
       WHERE COALESCE(s.voided, 0) = 0 AND date(s.created_at) BETWEEN ? AND ?
         AND (s.location_id = ? OR (s.location_id IS NULL AND ? = ?)) GROUP BY 1`, from, to, locId, locId, defId);
      const depts = await db.many("SELECT id, code, name, kind, categories FROM departments WHERE location_id = ? AND kind <> 'general' ORDER BY sort, name", locId);
      const out = bucketize(depts, rows, () => ({ units: 0, revenue: 0, cost: 0 }), (t, r) => { t.units += num(r.units); t.revenue = r2(t.revenue + num(r.revenue)); t.cost = r2(t.cost + num(r.cost)); })
        .filter((t) => t.revenue || t.units || t.id !== null).map((t) => ({ ...t, margin: r2(t.revenue - t.cost) }));
      return c.json({ location_id: locId, from, to, departments: out });
    } catch (e) { return fail(c, e); }
  });
  app.get('/api/deptstore/products', adminMw, view, async (c) => {
    try {
      const db = DB(c);
      const locId = Number(c.req.query('location')) || await defaultLocationId(db);
      const q = String(c.req.query('q') || '').trim();
      if (q.length < 2) return c.json({ products: [] });
      const like = '%' + q.replace(/[%_]/g, '') + '%';
      const rows = await db.many(`SELECT p.img, p.name, p.sku, p.category, COALESCE(v.qty, 0) AS at_location
          FROM products p LEFT JOIN location_stock_v v ON v.product_img = p.img AND v.location_id = ?
         WHERE p.name LIKE ? OR p.sku LIKE ? OR p.img LIKE ? OR p.barcode LIKE ?
         ORDER BY (COALESCE(v.qty, 0) > 0) DESC, p.name LIMIT 25`, locId, like, like, like, like);
      return c.json({ products: rows });
    } catch (e) { return fail(c, e); }
  });
  app.get('/api/deptstore/transfers', adminMw, view, async (c) => {
    try {
      const status = c.req.query('status');
      const rows = await DB(c).many(`SELECT t.*, f.name AS from_name, d.name AS to_name,
             (SELECT COUNT(*) FROM stock_transfer_lines l WHERE l.transfer_id = t.id) AS lines,
             (SELECT COALESCE(SUM(qty), 0) FROM stock_transfer_lines l WHERE l.transfer_id = t.id) AS units
        FROM stock_transfers t JOIN store_locations f ON f.id = t.from_location_id JOIN store_locations d ON d.id = t.to_location_id
        ${status ? 'WHERE t.status = ?' : ''} ORDER BY t.created_at DESC LIMIT 200`, ...(status ? [status] : []));
      return c.json({ transfers: rows });
    } catch (e) { return fail(c, e); }
  });
  app.get('/api/deptstore/transfers/:id', adminMw, view, async (c) => {
    try {
      const db = DB(c), id = Number(c.req.param('id'));
      const t = await db.one(`SELECT t.*, f.name AS from_name, d.name AS to_name FROM stock_transfers t
          JOIN store_locations f ON f.id = t.from_location_id JOIN store_locations d ON d.id = t.to_location_id WHERE t.id = ?`, id);
      if (!t) throw err(404, 'Not found');
      const lines = await db.many(`SELECT l.*, COALESCE(v.qty, 0) AS from_on_hand FROM stock_transfer_lines l
          LEFT JOIN location_stock_v v ON v.product_img = l.product_img AND v.location_id = ? WHERE l.transfer_id = ? ORDER BY l.id`, t.from_location_id, id);
      return c.json({ transfer: t, lines });
    } catch (e) { return fail(c, e); }
  });
  app.post('/api/deptstore/transfers', adminMw, manage, async (c) => {
    try {
      const db = DB(c), b = await body(c), u = c.get('user');
      const fromId = Number(b.from_location_id), toId = Number(b.to_location_id);
      const lines = (Array.isArray(b.lines) ? b.lines : []).map((l) => ({ img: String(l.product_img || '').trim(), qty: Math.floor(num(l.qty)), d: l.description || null })).filter((l) => l.img && l.qty > 0);
      if (!fromId || !toId) throw err(400, 'Pick both a source and a destination');
      if (fromId === toId) throw err(400, 'Source and destination must differ');
      if (!lines.length) throw err(400, 'Add at least one item');
      const r = await db.run("INSERT INTO stock_transfers (from_location_id, to_location_id, note, created_by, status, created_at) VALUES (?, ?, ?, ?, 'draft', CURRENT_TIMESTAMP)", fromId, toId, b.note || null, u.id);
      const id = r.meta.last_row_id;
      await db.batch([{ sql: 'UPDATE stock_transfers SET number = ? WHERE id = ?', binds: ['TRF-' + String(id).padStart(6, '0'), id] },
        ...lines.map((l) => ({ sql: 'INSERT INTO stock_transfer_lines (transfer_id, product_img, description, qty) VALUES (?, ?, ?, ?)', binds: [id, l.img, l.d, l.qty] }))]);
      return c.json({ transfer: await db.one('SELECT * FROM stock_transfers WHERE id = ?', id) });
    } catch (e) { return fail(c, e); }
  });
  // Post: move stock. Only branch rows are stored; the main store is derived.
  app.post('/api/deptstore/transfers/:id/post', adminMw, manage, async (c) => {
    try {
      const db = DB(c), id = Number(c.req.param('id')), u = c.get('user');
      const t = await db.one('SELECT * FROM stock_transfers WHERE id = ?', id);
      if (!t) throw err(404, 'Not found');
      if (t.status !== 'draft') throw err(400, 'Only a draft can be posted');
      const lines = await db.many('SELECT * FROM stock_transfer_lines WHERE transfer_id = ?', id);
      if (!lines.length) throw err(400, 'Transfer has no items');
      const defId = await defaultLocationId(db);
      for (const l of lines) {
        const v = await db.one('SELECT qty FROM location_stock_v WHERE product_img = ? AND location_id = ?', l.product_img, t.from_location_id);
        const have = v ? num(v.qty) : 0;
        if (have < l.qty) throw err(400, `Not enough stock of ${l.description || l.product_img} at source (${have} on hand, ${l.qty} needed)`);
      }
      const stmts = [];
      for (const l of lines) {
        if (t.from_location_id !== defId) stmts.push({ sql: 'UPDATE location_stock SET qty = MAX(0, qty - ?), updated_at = CURRENT_TIMESTAMP WHERE product_img = ? AND location_id = ?', binds: [l.qty, l.product_img, t.from_location_id] });
        if (t.to_location_id !== defId) stmts.push({ sql: `INSERT INTO location_stock (product_img, location_id, qty, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(product_img, location_id) DO UPDATE SET qty = location_stock.qty + excluded.qty, updated_at = CURRENT_TIMESTAMP`, binds: [l.product_img, t.to_location_id, l.qty] });
      }
      stmts.push({ sql: "UPDATE stock_transfers SET status = 'posted', posted_at = CURRENT_TIMESTAMP, posted_by = ? WHERE id = ? AND status = 'draft'", binds: [u.id, id] });
      await db.batch(stmts);   // one D1 transaction
      return c.json({ ok: true });
    } catch (e) { return fail(c, e); }
  });
  app.post('/api/deptstore/transfers/:id/cancel', adminMw, manage, async (c) => {
    try {
      const r = await DB(c).run("UPDATE stock_transfers SET status = 'cancelled' WHERE id = ? AND status = 'draft'", Number(c.req.param('id')));
      if (!r.meta.changes) throw err(400, 'Only a draft can be cancelled');
      return c.json({ ok: true });
    } catch (e) { return fail(c, e); }
  });

  // ============================================================ cashier --
  const cashManage = need('cashier.manage', true);
  const canTake = (u) => capOpen(u, 'cashier.access') || capOpen(u, 'pos.finalise_invoice');

  app.get('/api/cash/me', adminMw, async (c) => {
    try {
      const db = DB(c), u = c.get('user'), st = await terminalStation(c);
      const s = st ? await openSession(db, st.id) : null;
      return c.json({
        station: st ? { id: st.id, name: st.name, kind: st.kind, cashier_station_id: st.cashier_station_id, backup_station_id: st.backup_station_id } : null,
        session: s ? { id: s.id, user_id: s.user_id, opened_at: s.opened_at, mine: s.user_id === u.id } : null,
        can: { take: canTake(u), manage: await capR(c, u, 'cashier.manage') }, denominations: DENOMS,
      });
    } catch (e) { return fail(c, e); }
  });
  app.get('/api/cash/stations', adminMw, async (c) => {
    try {
      const rows = await DB(c).many(`SELECT s.id, s.name, s.kind, s.cashier_station_id, cs.name AS cashier_station, s.backup_station_id, bk.name AS backup_station,
             s.is_active, (s.device_key_hash IS NOT NULL) AS bound, s.bound_at, s.location_id, t.id AS session_id, u.name AS session_user, t.opened_at AS session_opened
        FROM pos_stations s LEFT JOIN pos_stations cs ON cs.id = s.cashier_station_id LEFT JOIN pos_stations bk ON bk.id = s.backup_station_id
        LEFT JOIN till_sessions t ON t.station_id = s.id AND t.status = 'open' LEFT JOIN users u ON u.id = t.user_id ORDER BY s.kind, s.name`);
      return c.json({ stations: rows.map((r) => ({ ...r, is_active: yes(r.is_active), bound: yes(r.bound) })) });
    } catch (e) { return fail(c, e); }
  });
  async function checkStationBody(db, b, selfId) {
    if (b.kind !== undefined && !['order', 'cashier', 'integrated'].includes(b.kind)) throw err(400, 'Kind is order, cashier or integrated');
    for (const k of ['cashier_station_id', 'backup_station_id']) {
      if (b[k] == null || b[k] === '') continue;
      if (selfId && Number(b[k]) === Number(selfId)) throw err(400, 'A station cannot point at itself');
      const r = await db.one('SELECT kind FROM pos_stations WHERE id = ? AND is_active = 1', b[k]);
      if (!r || r.kind !== 'cashier') throw err(400, 'That must be an active cashier station');
    }
  }
  app.post('/api/cash/stations', adminMw, cashManage, async (c) => {
    try {
      const db = DB(c), b = await body(c);
      const name = String(b.name || '').trim();
      if (name.length < 2 || name.length > 60) throw err(400, 'Give the station a name (2 to 60 characters)');
      await checkStationBody(db, b);
      let r;
      try { r = await db.run('INSERT INTO pos_stations (name, kind, cashier_station_id, backup_station_id, location_id) VALUES (?, ?, ?, ?, ?)', name, b.kind || 'order', b.cashier_station_id || null, b.backup_station_id || null, b.location_id || (await defaultLocationId(db))); }
      catch (e) { if (/UNIQUE/i.test(e.message)) throw err(409, 'A station with that name already exists'); throw e; }
      return c.json({ ok: true, id: r.meta.last_row_id });
    } catch (e) { return fail(c, e); }
  });
  app.patch('/api/cash/stations/:id', adminMw, cashManage, async (c) => {
    try {
      const db = DB(c), b = await body(c), id = c.req.param('id');
      await checkStationBody(db, b, id);
      const sets = [], vals = [];
      const put = (k, v) => { sets.push(k + ' = ?'); vals.push(v); };
      if (b.name !== undefined) put('name', String(b.name).trim());
      if (b.kind !== undefined) put('kind', b.kind);
      if (b.cashier_station_id !== undefined) put('cashier_station_id', b.cashier_station_id || null);
      if (b.backup_station_id !== undefined) put('backup_station_id', b.backup_station_id || null);
      if (b.location_id !== undefined) put('location_id', b.location_id || null);
      if (b.is_active !== undefined) {
        if (!b.is_active && (await openSession(db, id))) throw err(409, 'Close the drawer at this station first');
        put('is_active', b.is_active ? 1 : 0);
      }
      if (!sets.length) throw err(400, 'Nothing to change');
      const r = await db.run(`UPDATE pos_stations SET ${sets.join(', ')} WHERE id = ?`, ...vals, id);
      if (!r.meta.changes) throw err(404, 'Station not found');
      return c.json({ ok: true });
    } catch (e) { return fail(c, e); }
  });
  app.post('/api/cash/stations/:id/bind', adminMw, cashManage, async (c) => {
    try {
      const raw = crypto.getRandomValues(new Uint8Array(24));
      const key = btoa(String.fromCharCode(...raw)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const r = await DB(c).run('UPDATE pos_stations SET device_key_hash = ?, bound_at = CURRENT_TIMESTAMP, bound_by = ? WHERE id = ? AND is_active = 1', await sha256hex(key), c.get('user').id, c.req.param('id'));
      if (!r.meta.changes) throw err(404, 'Station not found');
      return c.json({ ok: true, key });
    } catch (e) { return fail(c, e); }
  });

  async function sessionReport(db, sessionId) {
    const s = await db.one(`SELECT t.*, st.name AS station, u.name AS cashier, cb.name AS closed_by_name, rv.name AS reviewed_by_name
        FROM till_sessions t JOIN pos_stations st ON st.id = t.station_id JOIN users u ON u.id = t.user_id
        LEFT JOIN users cb ON cb.id = t.closed_by LEFT JOIN users rv ON rv.id = t.reviewed_by WHERE t.id = ?`, sessionId);
    if (!s) throw err(404, 'Shift not found');
    const tenders = (await db.many(`SELECT lower(p.method) AS method, COUNT(*) AS n, COALESCE(SUM(p.amount_cents), 0) / 100.0 AS amount
        FROM till_sales ts JOIN pos_sales ps ON ps.id = ts.sale_id JOIN sale_payments p ON p.sale_id = ts.sale_id
       WHERE ts.session_id = ? AND COALESCE(ps.voided, 0) = 0 GROUP BY 1 ORDER BY 3 DESC`, sessionId)).map((x) => ({ ...x, amount: r2(x.amount) }));
    const sales = await db.one(`SELECT COUNT(*) AS n,
          COALESCE(SUM(CASE WHEN COALESCE(ps.voided, 0) = 0 THEN ps.total_cents END), 0) / 100.0 AS total,
          COALESCE(SUM(CASE WHEN COALESCE(ps.voided, 0) = 0 THEN ps.tax_cents END), 0) / 100.0 AS tax,
          COALESCE(SUM(CASE WHEN COALESCE(ps.voided, 0) = 0 THEN ps.discount_cents END), 0) / 100.0 AS discounts,
          SUM(CASE WHEN COALESCE(ps.voided, 0) = 1 THEN 1 ELSE 0 END) AS voided,
          COALESCE(SUM(CASE WHEN COALESCE(ps.voided, 0) = 0 THEN ps.change_due_cents END), 0) / 100.0 AS change_given
        FROM till_sales ts JOIN pos_sales ps ON ps.id = ts.sale_id WHERE ts.session_id = ?`, sessionId);
    const mv = await db.many(`SELECT m.kind, m.amount, m.reason, m.created_at, u.name AS by_name, a.name AS approved_by_name
        FROM till_movements m LEFT JOIN users u ON u.id = m.by_user LEFT JOIN users a ON a.id = m.approved_by WHERE m.session_id = ? ORDER BY m.created_at`, sessionId);
    const cashSales = tenders.filter((x) => x.method === 'cash').reduce((a, x) => a + x.amount, 0);
    const sum = (k) => mv.filter((x) => x.kind === k).reduce((a, x) => a + num(x.amount), 0);
    const expected = r2(num(s.opening_float) + cashSales + sum('float_in') - sum('drop') - sum('payout'));
    return { session: s, tenders, sales, movements: mv,
      cash: { opening_float: num(s.opening_float), cash_sales: r2(cashSales), float_in: r2(sum('float_in')), drops: r2(sum('drop')), payouts: r2(sum('payout')), expected } };
  }
  async function myStationSession(c, mustOwn) {
    const db = DB(c), st = await terminalStation(c);
    if (!st) throw err(400, 'This device is not set up as a station. A manager can set it up on the Stations tab.');
    if (st.kind === 'order') throw err(403, 'An order station has no cash drawer');
    const s = await openSession(db, st.id);
    if (mustOwn && (!s || s.user_id !== c.get('user').id)) throw err(409, s ? 'The drawer here is open under another cashier' : 'The drawer is not open');
    return { st, s };
  }

  app.post('/api/cash/till/ensure', adminMw, async (c) => {
    try {
      const db = DB(c), u = c.get('user'), st = await terminalStation(c);
      if (!st || st.kind === 'order') return c.json({ station: st ? { id: st.id, name: st.name, kind: st.kind } : null, session: null, opened: false });
      let drawerOpened = false;
      if ((await autoOpenOn(db)) && (capOpen(u, 'pos.open_close_shift') || capOpen(u, 'pos.access'))) {
        const od = await db.one('SELECT id FROM cash_drawer_sessions WHERE closed_at IS NULL LIMIT 1');
        if (!od) {
          await db.run("INSERT INTO cash_drawer_sessions (opened_by, opening_float_cents, notes, opened_at) VALUES (NULL, ?, 'Opened automatically when the POS started', CURRENT_TIMESTAMP)",
            Math.round((parseFloat(await setting(db, 'cash_default_float', '0')) || 0) * 100));
          drawerOpened = true;
        }
      }
      let s = await openSession(db, st.id), opened = false;
      if (!s && (await autoOpenOn(db)) && (canTake(u) || capOpen(u, 'pos.access'))) { s = await autoOpen(db, st.id, u.id); opened = !!s; }
      return c.json({ station: { id: st.id, name: st.name, kind: st.kind },
        session: s ? { id: s.id, user_id: s.user_id, opened_at: s.opened_at, opening_float: s.opening_float, mine: s.user_id === u.id } : null, opened: opened || drawerOpened });
    } catch (e) { return fail(c, e); }
  });
  app.get('/api/cash/collectors', adminMw, async (c) => {
    try {
      const db = DB(c);
      await defaultStation(db);
      const rows = await db.many(`SELECT s.id, s.name, s.kind, l.name AS location, t.id AS session_id, u.name AS cashier
          FROM pos_stations s LEFT JOIN store_locations l ON l.id = s.location_id
          LEFT JOIN till_sessions t ON t.station_id = s.id AND t.status = 'open' LEFT JOIN users u ON u.id = t.user_id
         WHERE s.is_active = 1 AND s.kind IN ('cashier', 'integrated') ORDER BY (t.id IS NULL), s.name`);
      return c.json({ collectors: rows });
    } catch (e) { return fail(c, e); }
  });
  app.get('/api/cash/paid', adminMw, async (c) => {
    try {
      const db = DB(c), u = c.get('user'), st = await terminalStation(c);
      const s = st && st.kind !== 'order' ? await openSession(db, st.id) : null;
      const cols = `ps.id, ps.receipt_number, ps.invoice_number, ps.customer_name, ps.total_cents / 100.0 AS total_usd,
                    ps.payment_method, ps.created_at, ps.cashier_name, COALESCE(ps.voided, 0) AS voided`;
      const rows = s
        ? await db.many(`SELECT ${cols} FROM till_sales ts JOIN pos_sales ps ON ps.id = ts.sale_id WHERE ts.session_id = ? ORDER BY ps.created_at DESC LIMIT 200`, s.id)
        : await db.many(`SELECT ${cols} FROM pos_sales ps WHERE date(ps.created_at, '-5 hours') = date('now', '-5 hours') ORDER BY ps.created_at DESC LIMIT 200`);
      let cashier = null;
      if (s) { const x = await db.one('SELECT name FROM users WHERE id = ?', s.user_id); cashier = x ? x.name : null; }
      const sales = rows.map((r) => ({ ...r, voided: yes(r.voided) }));
      const live = sales.filter((r) => !r.voided);
      return c.json({ scope: s ? 'shift' : 'today', station: st ? { id: st.id, name: st.name, kind: st.kind } : null,
        shift: s ? { id: s.id, opened_at: s.opened_at, cashier, opening_float: num(s.opening_float), mine: s.user_id === u.id } : null,
        totals: { count: live.length, total: r2(live.reduce((a, r) => a + num(r.total_usd), 0)) }, sales });
    } catch (e) { return fail(c, e); }
  });
  app.post('/api/cash/till/open', adminMw, async (c) => {
    try {
      const db = DB(c), u = c.get('user');
      if (!canTake(u)) throw err(403, 'Your account is not allowed to open a cash drawer.');
      const { st, s } = await myStationSession(c, false);
      if (s) throw err(409, 'The drawer at ' + st.name + ' is already open');
      const count = (await body(c)).count || {};
      const float = countTotal(count);
      let r;
      try { r = await db.run("INSERT INTO till_sessions (station_id, user_id, status, opening_float, opening_count, opened_at) VALUES (?, ?, 'open', ?, ?, CURRENT_TIMESTAMP)", st.id, u.id, float, JSON.stringify(count)); }
      catch (e) { if (/UNIQUE/i.test(e.message)) throw err(409, 'The drawer here was just opened by someone else'); throw e; }
      return c.json({ ok: true, session_id: r.meta.last_row_id, opening_float: float });
    } catch (e) { return fail(c, e); }
  });
  app.get('/api/cash/till/current', adminMw, async (c) => {
    try {
      const u = c.get('user'), { st, s } = await myStationSession(c, false);
      if (!s) return c.json({ station: { id: st.id, name: st.name, kind: st.kind }, session: null });
      const rep = await sessionReport(DB(c), s.id);
      if (!(await capR(c, u, 'cashier.manage'))) delete rep.cash.expected;
      return c.json({ station: { id: st.id, name: st.name, kind: st.kind }, mine: s.user_id === u.id, ...rep });
    } catch (e) { return fail(c, e); }
  });
  app.post('/api/cash/till/movement', adminMw, async (c) => {
    try {
      const db = DB(c), u = c.get('user'), { s } = await myStationSession(c, true), b = await body(c);
      if (!['drop', 'payout', 'float_in', 'no_sale'].includes(b.kind)) throw err(400, 'Unknown drawer movement');
      const amount = b.kind === 'no_sale' ? 0 : r2(b.amount);
      if (b.kind !== 'no_sale' && !(amount > 0)) throw err(400, 'Enter an amount');
      const reason = String(b.reason || '').trim();
      if ((b.kind === 'payout' || b.kind === 'no_sale') && reason.length < 3) throw err(400, 'Give a reason');
      const limit = Number(await setting(db, 'cash_payout_limit', '5000')) || 5000;
      if (b.kind === 'payout' && amount > limit && !(await capR(c, u, 'cashier.manage')))
        throw err(403, 'Payouts over J$' + limit + ' need a manager (sign in as one, or do it on the till with a manager PIN)');
      await db.run('INSERT INTO till_movements (session_id, kind, amount, reason, by_user, created_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)', s.id, b.kind, amount, reason || null, u.id);
      return c.json({ ok: true });
    } catch (e) { return fail(c, e); }
  });
  app.post('/api/cash/till/close', adminMw, async (c) => {
    try {
      const db = DB(c), u = c.get('user'), { s } = await myStationSession(c, true), b = await body(c);
      const counted = countTotal(b.count);
      const rep = await sessionReport(db, s.id);
      const variance = r2(counted - rep.cash.expected);
      await db.run(`UPDATE till_sessions SET status = 'closed', counted_cash = ?, closing_count = ?, expected_cash = ?, variance = ?,
             closed_at = CURRENT_TIMESTAMP, closed_by = ?, close_notes = ? WHERE id = ? AND status = 'open'`,
        counted, JSON.stringify(b.count || {}), rep.cash.expected, variance, u.id, String(b.notes || '').slice(0, 500) || null, s.id);
      return c.json((await capR(c, u, 'cashier.manage')) ? { ok: true, session_id: s.id, counted, expected: rep.cash.expected, variance }
        : { ok: true, session_id: s.id, counted, message: 'Count saved. A manager will review the drawer.' });
    } catch (e) { return fail(c, e); }
  });
  app.get('/api/cash/till/sessions', adminMw, cashManage, async (c) => {
    try {
      const rows = await DB(c).many(`SELECT t.id, t.status, st.name AS station, u.name AS cashier, t.opened_at, t.closed_at, t.opening_float, t.counted_cash, t.expected_cash, t.variance,
             t.reviewed_at, rv.name AS reviewed_by_name, (SELECT COUNT(*) FROM till_sales x WHERE x.session_id = t.id) AS sales
        FROM till_sessions t JOIN pos_stations st ON st.id = t.station_id JOIN users u ON u.id = t.user_id LEFT JOIN users rv ON rv.id = t.reviewed_by
        ORDER BY t.opened_at DESC LIMIT 100`);
      return c.json({ sessions: rows });
    } catch (e) { return fail(c, e); }
  });
  app.get('/api/cash/till/sessions/:id', adminMw, async (c) => {
    try {
      const u = c.get('user'), rep = await sessionReport(DB(c), c.req.param('id'));
      const manager = await capR(c, u, 'cashier.manage');
      if (!manager && rep.session.user_id !== u.id) throw err(403, 'Not your shift');
      if (!manager) { delete rep.cash.expected; delete rep.session.expected_cash; delete rep.session.variance; }
      return c.json(rep);
    } catch (e) { return fail(c, e); }
  });
  app.post('/api/cash/till/sessions/:id/review', adminMw, cashManage, async (c) => {
    try {
      const r = await DB(c).run("UPDATE till_sessions SET reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, review_note = ? WHERE id = ? AND status = 'closed'",
        c.get('user').id, String((await body(c)).note || '').slice(0, 500) || null, c.req.param('id'));
      if (!r.meta.changes) throw err(409, 'Only a closed shift can be reviewed');
      return c.json({ ok: true });
    } catch (e) { return fail(c, e); }
  });
  app.post('/api/cash/till/sessions/:id/force-close', adminMw, cashManage, async (c) => {
    try {
      const db = DB(c), id = c.req.param('id'), b = await body(c);
      const rep = await sessionReport(db, id);
      if (rep.session.status !== 'open') throw err(409, 'Already closed');
      const counted = countTotal(b.count);
      await db.run(`UPDATE till_sessions SET status = 'closed', counted_cash = ?, closing_count = ?, expected_cash = ?, variance = ?,
             closed_at = CURRENT_TIMESTAMP, closed_by = ?, close_notes = ? WHERE id = ?`,
        counted, JSON.stringify(b.count || {}), rep.cash.expected, r2(counted - rep.cash.expected), c.get('user').id,
        'Closed by manager' + (b.notes ? ': ' + String(b.notes).slice(0, 400) : ''), id);
      return c.json({ ok: true, expected: rep.cash.expected, counted, variance: r2(counted - rep.cash.expected) });
    } catch (e) { return fail(c, e); }
  });

  // ============================================ hooks used by pos_txn.js --
  // After a sale: which store, take a branch's stock, link it to the till shift.
  app.__afterSale = async (c, saleId, items) => {
    const db = DB(c), u = c.get('user');
    const st = await stationOf(c);
    const defId = await defaultLocationId(db);
    const loc = st && st.location_id ? st.location_id : null;
    const stmts = [];
    if (loc && loc !== defId) {
      stmts.push({ sql: 'UPDATE pos_sales SET location_id = ? WHERE id = ?', binds: [loc, saleId] });
      for (const it of items || []) if (it.product_img && num(it.qty) > 0)
        stmts.push({ sql: 'UPDATE location_stock SET qty = MAX(0, qty - ?), updated_at = CURRENT_TIMESTAMP WHERE product_img = ? AND location_id = ?', binds: [Math.floor(num(it.qty)), it.product_img, loc] });
    }
    const station = st || (await defaultStation(db));
    if (station && station.kind !== 'order') {
      let s = await openSession(db, station.id);
      if (!s && (await autoOpenOn(db))) s = await autoOpen(db, station.id, u.id);
      if (s) stmts.push({ sql: 'INSERT OR IGNORE INTO till_sales (session_id, sale_id) VALUES (?, ?)', binds: [s.id, saleId] });
    }
    if (stmts.length) await db.batch(stmts);
  };
  // After a void: put a branch's stock back where the sale came from.
  app.__afterVoid = async (c, saleId) => {
    const db = DB(c);
    const sale = await db.one('SELECT location_id FROM pos_sales WHERE id = ?', saleId);
    if (!sale || !sale.location_id || sale.location_id === (await defaultLocationId(db))) return;
    const items = await db.many('SELECT product_img, qty FROM pos_sale_items WHERE sale_id = ? AND product_img IS NOT NULL', saleId);
    if (!items.length) return;
    await db.batch(items.map((it) => ({ sql: `INSERT INTO location_stock (product_img, location_id, qty, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(product_img, location_id) DO UPDATE SET qty = location_stock.qty + excluded.qty, updated_at = CURRENT_TIMESTAMP`, binds: [it.product_img, sale.location_id, num(it.qty)] })));
  };
  // Order routing: the station that took it, and who collects (GENERAL may pick).
  app.__orderRouting = async (c, b) => {
    const db = DB(c);
    const st = await stationOf(c);
    let target = st ? st.cashier_station_id : null;
    const pick = parseInt(b.collect_station_id, 10);
    if (pick && ((await app.__isGeneral(c)) || (await capR(c, c.get('user'), 'cashier.manage')))) {
      const cs = await db.one("SELECT id FROM pos_stations WHERE id = ? AND is_active = 1 AND kind IN ('cashier', 'integrated')", pick);
      if (!cs) throw err(400, 'That cashier station is not available.');
      target = pick;
    } else if (target && !(await openSession(db, target))) {
      const bk = await db.one('SELECT backup_station_id FROM pos_stations WHERE id = ?', target);
      if (bk && bk.backup_station_id && (await openSession(db, bk.backup_station_id))) target = bk.backup_station_id;
    }
    return { order_station_id: st ? st.id : null, cashier_station_id: target || null };
  };
}
