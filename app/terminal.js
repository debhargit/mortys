// =============================================================================
//  Morty's Auto Parts -- Departments and terminal journal (Phase 8.2)
//
//  Mounted by server.js BEFORE the POS sale / order routes:
//    require('./terminal').register(app, deps)
//  Routes under /api/dept and /api/tj. Capabilities: dept.manage (departments,
//  assignments, rules), tj.view (journal and exceptions).
//
//  Departments: a department is a set of product categories. When the rule is
//  on, a counter agent with departments (or, if they have none, the cashier
//  station they work at) can only sell those categories. A manager approves
//  anything else with their PIN on the till; the approval covers that part for
//  30 minutes on that session and is logged. Owners and managers (roles that
//  can manage) are never restricted. Enforced on the server when a sale or a
//  cashier order is made, not only on the screen.
//
//  Terminal journal: the till sends what happens on screen (pos_events); the
//  feed joins that with sales, voids, refunds, holds and drawer events read
//  from their own tables. Exceptions pick out what a manager should look at.
// =============================================================================
'use strict';

const crypto = require('crypto');
const pins = require('./pins');
const DT = require('./dept-types');   // department TYPES + billing/stock/customer rules
const TZ = 'America/Jamaica';
const KINDS = ['item_added', 'item_removed', 'qty_changed', 'price_changed', 'discount_changed', 'cart_cleared', 'hold_recalled', 'dept_blocked'];

function register(app, deps) {
  const { query, requireAdmin, requireCap, bcrypt, roleCanManage } = deps;
  const can = (k) => [requireAdmin, requireCap(k)];
  const n = (v) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
  const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
  function httpError(status, msg) { const e = new Error(msg); e.status = status; e.publicMessage = msg; return e; }
  function fail(res, e) { const s = e.status || 500; if (s >= 500) console.error('[tj]', e); res.status(s).json({ error: e.publicMessage || e.message, ...(e.extra || {}) }); }
  async function setting(key, dflt) {
    const { rows } = await query('SELECT value FROM warehouse_settings WHERE key = $1', [key]);
    return rows.length && rows[0].value != null ? rows[0].value : dflt;
  }
  // Department rules column (types and rules, 2026-11-05). Self-creating, like
  // the other modules, so it needs no separate migration step.
  // departments.rules is added by schema.sql (department types, 2026-11-05).
  // Not run here: DDL at startup can deadlock the boot-time schema apply.
  const hashKey = (k) => crypto.createHash('sha256').update(String(k)).digest('hex');
  async function stationOf(req) {
    const key = req.get('x-station-key');
    if (!key || key.length < 20) return null;
    const { rows } = await query('SELECT id, name FROM pos_stations WHERE device_key_hash = $1 AND is_active', [hashKey(key)]);
    return rows[0] || null;
  }
  async function me(req) {
    const { rows } = await query('SELECT id, name, email, admin_role FROM users WHERE id = $1', [req.session.userId]);
    return rows[0];
  }

  // ------------------------------------------------------- departments --
  // What this request may sell: {restricted, categories:Set, departments:[], source}
  async function allowedFor(req) {
    if ((await setting('dept_enforce', 'off')) !== 'on') return { restricted: false, enforce: false };
    const u = await me(req);
    if (!u || (await roleCanManage(u.admin_role))) return { restricted: false, enforce: true, manager: true };
    let { rows } = await query(
      `SELECT d.name, d.categories FROM user_departments ud JOIN departments d ON d.id = ud.department_id WHERE ud.user_id = $1 AND d.is_active`, [u.id]);
    let source = 'user';
    if (!rows.length) {
      const st = await stationOf(req);
      if (st) ({ rows } = await query(
        `SELECT d.name, d.categories FROM station_departments sd JOIN departments d ON d.id = sd.department_id WHERE sd.station_id = $1 AND d.is_active`, [st.id]));
      source = 'station';
    }
    if (!rows.length) return { restricted: false, enforce: true };
    const cats = new Set();
    rows.forEach((r) => (r.categories || []).forEach((c) => cats.add(String(c).toLowerCase())));
    return { restricted: true, enforce: true, categories: cats, departments: rows.map((r) => r.name), source };
  }

  // Server-side check on POST /api/admin/pos/sale and POST /api/admin/pos/order.
  async function guard(req, res, next) {
    try {
      if (req.method !== 'POST' || !(req.path === '/' || req.path === '')) return next();
      const items = Array.isArray((req.body || {}).items) ? req.body.items : [];
      if (!items.length) return next();
      const a = await allowedFor(req);
      if (!a.restricted) return next();
      const imgs = [...new Set(items.map((i) => i.product_img).filter(Boolean))];
      if (!imgs.length) return next();
      const { rows } = await query(`SELECT img, name, lower(category) AS category FROM products WHERE img = ANY($1)`, [imgs]);
      const ok = (req.session.deptOk || {});
      const now = Date.now();
      const out = rows.filter((p) => !a.categories.has(p.category) && !(ok[p.img] && ok[p.img].until > now));
      if (!out.length) return next();
      const u = await me(req), st = await stationOf(req);
      for (const p of out) {
        await query(`INSERT INTO pos_events (user_id, user_name, station_id, kind, product_img, name, note) VALUES ($1,$2,$3,'dept_blocked',$4,$5,$6)`,
          [u.id, u.name, st && st.id, p.img, p.name, 'Sale refused: ' + p.category + ' is outside ' + a.departments.join(', ')]);
      }
      res.status(403).json({ error: 'Outside your department' + (a.departments.length > 1 ? 's' : '') + ' (' + a.departments.join(', ') + '): ' + out.map((p) => p.name).join(', ') + '. A manager must approve these on the till.',
        out_of_department: out });
    } catch (e) { fail(res, e); }
  }
  app.use('/api/admin/pos/sale', requireAdmin, guard);
  app.use('/api/admin/pos/order', requireAdmin, guard);

  // ------------------------------------- department rules at sale time --
  // Phase 2 of department types (2026-11-05). Only when "Sell only your
  // department" (dept_enforce) is on, and only for the department the till is
  // working in (the POS department picker; General / All = no rules). Owners
  // and managers are held to the rules too, but can clear a refusal with
  // their own PIN like anyone else (POST /api/dept/rule-override), which is
  // logged in the terminal journal. Checks what the server can see on the
  // sale: customer, payments, quantities, serials, stock, minimum, discount,
  // deposit. Price basis, GCT rate and service charge are applied by the till
  // and the sale route (Phase 3).
  const PAY_MAP = { cash: 'cash', card: 'card', bank: 'transfer', cheque: 'cheque', account: 'account' };   // sale method -> rule option
  async function currentDept(req) {
    if ((await setting('dept_enforce', 'off')) !== 'on') return null;
    const c = await deptChoice(req);
    if (!c.current || c.current.kind === 'general') return null;
    return { id: c.current.id, name: c.current.name, kind: c.current.kind, rules: DT.effective(c.current.kind, c.current.rules) };
  }
  async function ruleProblems(req, d) {
    const b = req.body || {}, R = d.rules, out = [];
    const items = Array.isArray(b.items) ? b.items : [];
    // customer
    let walkinId = -1;
    try { const w = await query(`SELECT id FROM users WHERE email = 'walkin@mortysautoparts.local' LIMIT 1`); if (w.rows[0]) walkinId = w.rows[0].id; } catch (_) {}
    const cid = b.customer_id ? Number(b.customer_id) : null;
    const named = cid && cid !== walkinId;
    let cust = null;
    if (named) {
      const { rows } = await query(`SELECT id, name, phone, tax_id, national_id, customer_type, price_tier FROM users WHERE id = $1`, [cid]).catch(() => ({ rows: [] }));
      cust = rows[0] || null;
    }
    const C = R.customer;
    if (!C.walkin_allowed && !named) out.push('pick a named customer (no walk-in sales)');
    if (C.phone_required && !String(b.customer_phone || (cust && cust.phone) || '').trim()) out.push("the customer's phone number");
    if (C.trn_required && !(cust && String(cust.tax_id || '').trim())) out.push("the customer's TRN (on their account)");
    if (C.id_required && !(cust && String(cust.national_id || '').trim())) out.push("the customer's photo ID number (on their account)");
    if (C.vehicle_required && !String(b.vehicle_info || '').trim()) out.push('the vehicle (plate or VIN)');
    if (C.trade_account_required && !(cust && ['trade', 'fleet', 'dealer'].includes(String(cust.customer_type || cust.price_tier || '').toLowerCase()))) out.push('a trade account customer');
    // payments
    const pays = Array.isArray(b.payments) && b.payments.length ? b.payments : (b.payment_method ? [{ method: b.payment_method, amount_usd: null }] : []);
    const bad = [...new Set(pays.map((x) => x.method).filter((m) => PAY_MAP[m] && !R.billing.payments.includes(PAY_MAP[m])))];
    if (bad.length) out.push('a payment method this department takes (not ' + bad.join(', ') + ')');
    // lines
    const qtyBy = {};
    items.forEach((it) => { if (it.product_img) qtyBy[it.product_img] = (qtyBy[it.product_img] || 0) + Number(it.qty || 0); });
    if (R.billing.min_line_qty > 0 && items.some((it) => Number(it.qty || 0) < R.billing.min_line_qty)) out.push('at least ' + R.billing.min_line_qty + ' of each line');
    if (R.stock.unique_items && items.some((it) => Number(it.qty || 0) > 1)) out.push('one of each item (each is one-off)');
    if (R.stock.serial_required && items.some((it) => !String(it.serial_number || '').trim())) out.push('a serial / VIN on every line');
    if (R.stock.track && !R.stock.allow_negative) {
      const imgs = Object.keys(qtyBy);
      if (imgs.length) {
        const { rows } = await query(`SELECT img, name, COALESCE(stock_count, 0)::int AS stock FROM products WHERE img = ANY($1)`, [imgs]).catch(() => ({ rows: [] }));
        const short = rows.filter((r) => r.stock < qtyBy[r.img]);
        if (short.length) out.push('enough stock (' + short.map((r) => r.name + ': ' + r.stock + ' on hand').join('; ') + ')');
      }
    }
    // money
    const gross = items.reduce((t, it) => t + Number(it.unit_price_usd || 0) * Number(it.qty || 0), 0);
    const disc = items.reduce((t, it) => t + Math.max(0, Number(it.discount_usd || 0)), 0) + Math.max(0, Number(b.discount_usd || 0));
    const net = Math.max(0, gross - disc);
    if (R.billing.min_sale > 0 && net < R.billing.min_sale) out.push('a sale of at least J$' + R.billing.min_sale.toLocaleString('en-JM') + ' (this one is J$' + net.toFixed(2) + ')');
    if (gross > 0 && disc > 0 && (disc / gross) * 100 > R.billing.max_discount_pct + 0.001) out.push('a discount of no more than ' + R.billing.max_discount_pct + '% (this one is ' + ((disc / gross) * 100).toFixed(1) + '%)');
    if (R.billing.deposit_pct > 0) {
      const onAcct = pays.filter((x) => x.method === 'account');
      if (onAcct.length && onAcct.every((x) => x.amount_usd != null && x.amount_usd !== '')) {
        const paidNow = net - onAcct.reduce((t, x) => t + Number(x.amount_usd || 0), 0);
        if (paidNow + 0.005 < net * R.billing.deposit_pct / 100) out.push('a deposit of at least ' + R.billing.deposit_pct + '% paid now (J$' + (net * R.billing.deposit_pct / 100).toFixed(2) + ')');
      } else if (onAcct.length) out.push('a deposit of at least ' + R.billing.deposit_pct + '% paid now (put the balance on account as a set amount)');
    }
    return out;
  }
  async function rulesGuard(req, res, next) {
    try {
      if (req.method !== 'POST' || !(req.path === '/' || req.path === '')) return next();
      const d = await currentDept(req);
      if (!d) return next();
      const probs = await ruleProblems(req, d);
      if (!probs.length) return next();
      const ok = req.session.deptRuleOk;
      if (ok && ok.dept === d.id && ok.until > Date.now() && ok.sig === JSON.stringify(probs)) { if (req.body.dry_run !== true) delete req.session.deptRuleOk; return next(); }
      if (req.body.dry_run !== true) {
        const u = await me(req), st = await stationOf(req);
        await query(`INSERT INTO pos_events (user_id, user_name, station_id, kind, name, note) VALUES ($1,$2,$3,'dept_blocked',$4,$5)`,
          [u && u.id, u && u.name, st && st.id, d.name + ' rules', 'Sale refused: needs ' + probs.join('; ')]).catch(() => {});
      }
      res.status(403).json({ error: d.name + ' needs ' + probs.join('; ') + '. A manager can approve with their PIN.', department_rules: { department: d.name, problems: probs } });
    } catch (e) { fail(res, e); }
  }
  app.use('/api/admin/pos/sale', requireAdmin, rulesGuard);
  app.use('/api/admin/pos/order', requireAdmin, rulesGuard);

  // A manager clears the current refusal with their PIN. Body {pin, items,...}
  // = the same sale body; the approval covers exactly those problems, for this
  // department, once, within 10 minutes.
  app.post('/api/dept/rule-override', requireAdmin, async (req, res) => {
    try {
      const key = 'r' + req.session.userId;
      const t = PIN_TRIES.get(key) || { n: 0, first: Date.now() };
      if (Date.now() - t.first > 10 * 60000) { t.n = 0; t.first = Date.now(); }
      if (t.n >= 5) throw httpError(429, 'Too many wrong PINs. Wait a few minutes.');
      const d = await currentDept(req);
      if (!d) return res.json({ ok: true, nothing: true });
      const probs = await ruleProblems(req, d);
      if (!probs.length) return res.json({ ok: true, nothing: true });
      const pin = String((req.body || {}).pin || '').trim();
      if (!/^\d{4,8}$/.test(pin)) throw httpError(400, 'Enter the manager PIN');
      const picked = pins.pickedId(req.body);
      const { rows: staff } = await query(`SELECT id, name, admin_role, pin_hash FROM users WHERE pin_hash IS NOT NULL AND is_staff AND NOT disabled` + (picked ? ' AND id = $1' : ''), picked ? [picked] : []);
      const hit = await pins.pick(staff, pin);
      if (!hit) { t.n++; PIN_TRIES.set(key, t); throw httpError(401, 'PIN not recognised'); }
      if (!(await roleCanManage(hit.admin_role))) { t.n++; PIN_TRIES.set(key, t); throw httpError(403, (hit.name || 'That person') + ' cannot approve this: a manager is needed.'); }
      PIN_TRIES.delete(key);
      req.session.deptRuleOk = { dept: d.id, sig: JSON.stringify(probs), by: hit.id, until: Date.now() + 10 * 60000 };
      const u = await me(req), st = await stationOf(req);
      await query(`INSERT INTO pos_events (user_id, user_name, station_id, terminal, kind, name, approved_by, note) VALUES ($1,$2,$3,$4,'dept_override',$5,$6,$7)`,
        [u.id, u.name, st && st.id, String(req.get('x-terminal') || '').slice(0, 80) || null, d.name + ' rules', hit.id, 'Approved by ' + hit.name + ': ' + probs.join('; ')]);
      res.json({ ok: true, id: hit.id, name: hit.name, user: { id: hit.id, name: hit.name }, approved: probs });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------- current department (POS) --
  // The department shown next to the cart. Owners and managers may pick any
  // active department, or GENERAL: sell from every department as one stock and
  // choose which cashier collects. Staff pick among their own departments
  // (or their till's). The choice lives in the session.
  async function deptChoice(req) {
    const u = await me(req);
    const manager = !!(u && (await roleCanManage(u.admin_role)));
    let options = [];
    if (manager) {
      ({ rows: options } = await query(`SELECT id, code, name, kind, rules FROM departments WHERE is_active ORDER BY (kind = 'general') DESC, sort, name`));
    } else if (u) {
      ({ rows: options } = await query(`SELECT d.id, d.code, d.name, d.kind, d.rules FROM user_departments ud JOIN departments d ON d.id = ud.department_id
          WHERE ud.user_id = $1 AND d.is_active AND d.kind <> 'general' ORDER BY d.sort, d.name`, [u.id]));
      if (!options.length) {
        const st = await stationOf(req);
        if (st) ({ rows: options } = await query(`SELECT d.id, d.code, d.name, d.kind, d.rules FROM station_departments sd JOIN departments d ON d.id = sd.department_id
            WHERE sd.station_id = $1 AND d.is_active AND d.kind <> 'general' ORDER BY d.sort, d.name`, [st.id]));
      }
    }
    const want = Number(req.session.posDeptId) || null;
    const current = options.find((d) => d.id === want) || (manager ? options.find((d) => d.kind === 'general') : null) || options[0] || null;
    req.session.posDeptGeneral = !!(manager && current && current.kind === 'general');
    return { manager, options, current };
  }

  app.get('/api/dept/mine', requireAdmin, async (req, res) => {
    try {
      const a = await allowedFor(req);
      const c = await deptChoice(req);
      res.json({ enforce: !!a.enforce, restricted: !!a.restricted, categories: a.categories ? [...a.categories] : null, departments: a.departments || [], source: a.source || null,
        current: c.current || { id: null, code: null, name: 'All departments', kind: 'all' },
        rules: DT.effective(c.current ? c.current.kind : 'parts', c.current ? c.current.rules : {}),
        type: (DT.TYPES.find((t) => t.key === (c.current && c.current.kind)) || { label: null }).label,
        options: c.options.map((o) => ({ id: o.id, code: o.code, name: o.name, kind: o.kind })), general: req.session.posDeptGeneral === true, can_choose_collector: req.session.posDeptGeneral === true });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/dept/mine', requireAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      const id = b.department_id == null || b.department_id === '' ? null : Number(b.department_id);
      const c0 = await deptChoice(req);
      if (id && !c0.options.some((d) => d.id === id)) throw httpError(403, 'You cannot work in that department.');
      req.session.posDeptId = id;
      const c = await deptChoice(req);
      res.json({ ok: true, current: c.current, rules: DT.effective(c.current ? c.current.kind : 'parts', c.current ? c.current.rules : {}), general: req.session.posDeptGeneral === true });
    } catch (e) { fail(res, e); }
  });

  // Manager approves one out-of-department part with their PIN. Called by the
  // till's PIN keypad (endpoint mode): body {pin}, ?item=<product img>.
  const PIN_TRIES = new Map();
  app.post('/api/dept/override', requireAdmin, async (req, res) => {
    try {
      const key = req.session.userId + '';
      const t = PIN_TRIES.get(key) || { n: 0, first: Date.now() };
      if (Date.now() - t.first > 10 * 60000) { t.n = 0; t.first = Date.now(); }
      if (t.n >= 5) throw httpError(429, 'Too many wrong PINs. Wait a few minutes.');
      const img = String(req.query.item || (req.body || {}).item || '');
      const { rows: p } = await query(`SELECT img, sku, name, category, price_usd FROM products WHERE img = $1`, [img]);
      if (!p.length) throw httpError(404, 'Part not found');
      const pin = String((req.body || {}).pin || '').trim();
      if (!/^\d{4,8}$/.test(pin)) throw httpError(400, 'Enter the manager PIN');
      // The manager picked on the keypad's staff list, when the till sends one.
      const picked = pins.pickedId(req.body);
      const { rows: staff } = await query(`SELECT id, name, admin_role, pin_hash FROM users WHERE pin_hash IS NOT NULL AND is_staff AND NOT disabled` + (picked ? ' AND id = $1' : ''), picked ? [picked] : []);
      const hit = await pins.pick(staff, pin);
      if (!hit) { t.n++; PIN_TRIES.set(key, t); throw httpError(401, 'PIN not recognised'); }
      if (!(await roleCanManage(hit.admin_role))) { t.n++; PIN_TRIES.set(key, t); throw httpError(403, (hit.name || 'That person') + ' cannot approve this: a manager is needed.'); }
      PIN_TRIES.delete(key);
      req.session.deptOk = Object.assign({}, req.session.deptOk || {}, { [img]: { by: hit.id, until: Date.now() + 30 * 60000 } });
      const u = await me(req), st = await stationOf(req);
      await query(`INSERT INTO pos_events (user_id, user_name, station_id, terminal, kind, product_img, sku, name, amount, approved_by, note)
                   VALUES ($1,$2,$3,$4,'dept_override',$5,$6,$7,$8,$9,$10)`,
        [u.id, u.name, st && st.id, String(req.get('x-terminal') || '').slice(0, 80) || null, p[0].img, p[0].sku, p[0].name, n(p[0].price_usd), hit.id,
         'Approved by ' + hit.name + ' (' + p[0].category + ')']);
      res.json({ ok: true, id: hit.id, name: hit.name, user: { id: hit.id, name: hit.name } });   // user: what the till's PIN keypad reads
    } catch (e) { fail(res, e); }
  });

  app.get('/api/dept', ...can('dept.manage'), async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT d.*, COALESCE((SELECT json_agg(json_build_object('id', u.id, 'name', u.name)) FROM user_departments ud JOIN users u ON u.id = ud.user_id WHERE ud.department_id = d.id), '[]') AS users,
                COALESCE((SELECT json_agg(json_build_object('id', s.id, 'name', s.name)) FROM station_departments sd JOIN pos_stations s ON s.id = sd.station_id WHERE sd.department_id = d.id), '[]') AS stations
           FROM departments d ORDER BY d.name`);
      const { rows: cats } = await query(`SELECT lower(category) AS category, COUNT(*)::int AS parts FROM products WHERE is_active AND category IS NOT NULL AND category <> '' GROUP BY 1 ORDER BY 1`);
      const { rows: staff } = await query(`SELECT id, name, admin_role FROM users WHERE (is_staff OR is_admin) AND NOT disabled AND NOT COALESCE(is_archived, false) ORDER BY name`);
      const { rows: stations } = await query(`SELECT id, name, kind FROM pos_stations WHERE is_active ORDER BY name`);
      const { rows: locations } = await query(`SELECT id, name, kind, is_default FROM store_locations WHERE is_active ORDER BY sort, id`).catch(() => ({ rows: [] }));
      const s = {};
      for (const k of ['dept_enforce', 'tj_void_alert', 'tj_discount_pct_alert', 'tj_nosale_per_day', 'tj_removed_per_day']) s[k] = await setting(k, null);
      res.json({ departments: rows, categories: cats, staff, stations, locations, settings: s });
    } catch (e) { fail(res, e); }
  });
  // The type list and the rule fields, for the setup screen and the till.
  app.get('/api/dept/types', requireAdmin, (req, res) => res.json(DT.catalogue()));
  // Effective rules for one department (type defaults + its overrides).
  app.get('/api/dept/:id(\\d+)/rules', requireAdmin, async (req, res) => {
    try {
      const { rows } = await query('SELECT id, name, kind, rules FROM departments WHERE id = $1', [req.params.id]);
      if (!rows.length) throw httpError(404, 'Department not found');
      res.json({ department: { id: rows[0].id, name: rows[0].name, kind: rows[0].kind }, defaults: DT.defaults(rows[0].kind), overrides: DT.cleanRules(rows[0].rules), rules: DT.effective(rows[0].kind, rows[0].rules) });
    } catch (e) { fail(res, e); }
  });
  function cleanDept(b) {
    const out = {};
    if (b.kind !== undefined) { if (!DT.isType(b.kind)) throw httpError(400, 'Pick a department type'); out.kind = b.kind; }
    if (b.rules !== undefined) out.rules = DT.cleanRules(b.rules);   // stored as the diff from the type in the routes below
    if (b.name !== undefined) { out.name = String(b.name || '').trim().slice(0, 60); if (!out.name) throw httpError(400, 'Name the department'); }
    if (b.code !== undefined) { out.code = String(b.code || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 20); if (!out.code) throw httpError(400, 'Give it a short code'); }
    if (b.categories !== undefined) out.categories = (Array.isArray(b.categories) ? b.categories : []).map((c) => String(c).toLowerCase().trim()).filter(Boolean).slice(0, 100);
    if (b.is_active !== undefined) out.is_active = !!b.is_active;
    if (b.location_id !== undefined) out.location_id = b.location_id === null ? null : (parseInt(b.location_id, 10) || null);
    return out;
  }
  app.post('/api/dept', ...can('dept.manage'), async (req, res) => {
    try {
      const d = cleanDept(Object.assign({ code: (req.body || {}).code || (req.body || {}).name }, req.body || {}));
      if (!d.name) throw httpError(400, 'Name the department');
      const { rows } = await query(
        `INSERT INTO departments (code, name, categories, location_id, kind, rules)
         VALUES ($1,$2,$3, COALESCE($4, (SELECT id FROM store_locations WHERE is_default LIMIT 1)), $5, $6) RETURNING *`,
        [d.code, d.name, d.categories || [], d.location_id || null, d.kind || 'parts', JSON.stringify(DT.diffRules(d.kind || 'parts', d.rules || {}))]);
      res.json({ department: rows[0] });
    } catch (e) { if (e.code === '23505') e = httpError(409, 'That code is already used'); fail(res, e); }
  });
  app.patch('/api/dept/:id', ...can('dept.manage'), async (req, res) => {
    try {
      const d = cleanDept(req.body || {});
      if (d.rules !== undefined || d.kind !== undefined) {
        const { rows: cur } = await query('SELECT kind, rules FROM departments WHERE id = $1', [req.params.id]);
        if (!cur.length) throw httpError(404, 'Department not found');
        if (cur[0].kind === 'general' && d.kind && d.kind !== 'general') throw httpError(400, 'The General department stays General');
        const kind = d.kind || cur[0].kind;
        // Changing the type alone resets the rules to the new type's defaults.
        d.rules = JSON.stringify(DT.diffRules(kind, d.rules !== undefined ? d.rules : (d.kind && d.kind !== cur[0].kind ? {} : cur[0].rules)));
      }
      const keys = Object.keys(d);
      if (!keys.length) throw httpError(400, 'Nothing to change');
      const { rows } = await query(`UPDATE departments SET ${keys.map((k, i) => k + ' = $' + (i + 2)).join(', ')} WHERE id = $1 RETURNING *`, [req.params.id, ...keys.map((k) => d[k])]);
      if (!rows.length) throw httpError(404, 'Department not found');
      res.json({ department: rows[0] });
    } catch (e) { if (e.code === '23505') e = httpError(409, 'That code is already used'); fail(res, e); }
  });
  // Remove a department. Never used -> deleted. Has staff, tills, HR records or
  // till history -> switched off instead, so nothing that points at it breaks.
  app.delete('/api/dept/:id(\\d+)', ...can('dept.manage'), async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const { rows } = await query('SELECT id, name, kind FROM departments WHERE id = $1', [id]);
      if (!rows.length) throw httpError(404, 'Department not found');
      if (rows[0].kind === 'general') throw httpError(400, 'The General department cannot be removed');
      const used = [];
      const count = async (label, sql) => { try { const r = await query(sql, [id]); if (r.rows[0] && Number(r.rows[0].n) > 0) used.push(label); } catch (_) { /* table may not exist on this install */ } };
      await count('staff', 'SELECT COUNT(*) n FROM user_departments WHERE department_id = $1');
      await count('tills', 'SELECT COUNT(*) n FROM station_departments WHERE department_id = $1');
      await count('HR records', 'SELECT (SELECT COUNT(*) FROM hr_employees WHERE department_id = $1) + (SELECT COUNT(*) FROM hr_job_history WHERE department_id = $1) + (SELECT COUNT(*) FROM hr_offers WHERE department_id = $1) AS n');
      await count('requisitions', 'SELECT COUNT(*) n FROM dept_requisitions WHERE from_department = (SELECT name FROM departments WHERE id = $1) OR to_department = (SELECT name FROM departments WHERE id = $1)');
      if (used.length) {
        await query('UPDATE departments SET is_active = false WHERE id = $1', [id]);
        return res.json({ ok: true, removed: false, deactivated: true, reason: 'It has ' + used.join(', ') + ', so it was switched off instead. Switch it back on any time.' });
      }
      await query('DELETE FROM departments WHERE id = $1', [id]);
      res.json({ ok: true, removed: true });
    } catch (e) { fail(res, e); }
  });
  async function setMembers(table, col, deptId, ids) {
    const clean = [...new Set((Array.isArray(ids) ? ids : []).map((x) => parseInt(x, 10)).filter(Boolean))];
    await query(`DELETE FROM ${table} WHERE department_id = $1`, [deptId]);
    for (const id of clean) await query(`INSERT INTO ${table} (${col}, department_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, deptId]);
    return clean.length;
  }
  app.put('/api/dept/:id/users', ...can('dept.manage'), async (req, res) => {
    try { res.json({ users: await setMembers('user_departments', 'user_id', parseInt(req.params.id, 10), (req.body || {}).user_ids) }); } catch (e) { fail(res, e); }
  });
  app.put('/api/dept/:id/stations', ...can('dept.manage'), async (req, res) => {
    try { res.json({ stations: await setMembers('station_departments', 'station_id', parseInt(req.params.id, 10), (req.body || {}).station_ids) }); } catch (e) { fail(res, e); }
  });
  app.put('/api/dept/settings', ...can('dept.manage'), async (req, res) => {
    try {
      const b = req.body || {};
      const put = (k, v) => query(`INSERT INTO warehouse_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [k, String(v)]);
      if (b.dept_enforce !== undefined) await put('dept_enforce', b.dept_enforce === 'on' || b.dept_enforce === true ? 'on' : 'off');
      for (const k of ['tj_void_alert', 'tj_discount_pct_alert', 'tj_nosale_per_day', 'tj_removed_per_day']) {
        if (b[k] === undefined) continue;
        const v = Number(b[k]);
        if (!(v >= 0) || v > 100000000) throw httpError(400, 'Numbers only');
        await put(k, v);
      }
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------ till events --
  app.post('/api/tj/events', requireAdmin, async (req, res) => {
    try {
      const list = Array.isArray((req.body || {}).events) ? req.body.events.slice(0, 200) : [];
      if (!list.length) return res.json({ saved: 0 });
      const u = await me(req), st = await stationOf(req);
      const term = String(req.get('x-terminal') || '').slice(0, 80) || null;
      let saved = 0;
      for (const e of list) {
        if (!KINDS.includes(e.kind)) continue;
        const at = e.at && !isNaN(Date.parse(e.at)) ? new Date(e.at) : null;
        const t = (v, m) => (v == null || v === '' ? null : String(v).slice(0, m));
        await query(
          `INSERT INTO pos_events (client_at, user_id, user_name, station_id, terminal, ticket, kind, product_img, sku, name, qty, value_before, value_after, amount, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [at, u.id, u.name, st && st.id, term, t(e.ticket, 40), e.kind, t(e.img, 200), t(e.sku, 80), t(e.name, 200), n(e.qty), n(e.before), n(e.after), n(e.amount), t(e.note, 300)]);
        saved++;
      }
      res.json({ saved });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------------- feed --
  function period(q) {
    const iso = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s || '') ? s : null);
    const from = iso(q.from), to = iso(q.to);
    return { from, to };
  }
  const RANGE = (col) => `${col} >= ($1::date)::timestamp AT TIME ZONE '${TZ}' AND ${col} < ($2::date + 1)::timestamp AT TIME ZONE '${TZ}'`;
  app.get('/api/tj/feed', ...can('tj.view'), async (req, res) => {
    try {
      const p = period(req.query);
      if (!p.from || !p.to) throw httpError(400, 'Choose the dates');
      const user = parseInt(req.query.user, 10) || null;
      const kinds = req.query.kind ? String(req.query.kind).split(',') : null;
      const { rows } = await query(
        `SELECT * FROM (
           SELECT e.at, e.kind, e.user_id, e.user_name, s.name AS station, e.ticket AS ref, e.name AS item, e.qty, e.value_before, e.value_after, e.amount, e.note
             FROM pos_events e LEFT JOIN pos_stations s ON s.id = e.station_id WHERE ${RANGE('e.at')}
           UNION ALL
           SELECT ps.created_at, CASE WHEN ps.receipt_number LIKE 'CN%' THEN 'credit_note' ELSE 'sale' END, ps.cashier_id, COALESCE(ps.cashier_name, u.name), NULL, ps.receipt_number, ps.customer_name,
                  NULL, NULL, NULL, ps.total_usd, CASE WHEN COALESCE(ps.discount_usd, 0) > 0 THEN 'discount ' || ps.discount_usd END
             FROM pos_sales ps LEFT JOIN users u ON u.id = ps.cashier_id WHERE ${RANGE('ps.created_at')}
           UNION ALL
           SELECT ps.voided_at, 'void', ps.voided_by, u.name, NULL, ps.receipt_number, ps.customer_name, NULL, NULL, NULL, ps.total_usd, NULL
             FROM pos_sales ps LEFT JOIN users u ON u.id = ps.voided_by WHERE ps.voided AND ps.voided_at IS NOT NULL AND ${RANGE('ps.voided_at')}
           UNION ALL
           SELECT r.created_at, 'refund', r.processed_by, u.name, NULL, r.return_number, s.receipt_number, NULL, NULL, NULL, r.refund_total_usd, r.refund_method || COALESCE(': ' || r.reason, '')
             FROM pos_sale_returns r LEFT JOIN pos_sales s ON s.id = r.sale_id LEFT JOIN users u ON u.id = r.processed_by WHERE ${RANGE('r.created_at')}
           UNION ALL
           SELECT m.created_at, 'drawer_' || m.kind, m.by_user, u.name, st.name, 'Shift ' || m.session_id, NULL, NULL, NULL, NULL, m.amount, m.reason
             FROM till_movements m JOIN till_sessions t ON t.id = m.session_id LEFT JOIN pos_stations st ON st.id = t.station_id LEFT JOIN users u ON u.id = m.by_user WHERE ${RANGE('m.created_at')}
           UNION ALL
           SELECT t.opened_at, 'drawer_open', t.user_id, u.name, st.name, 'Shift ' || t.id, NULL, NULL, NULL, NULL, t.opening_float, NULL
             FROM till_sessions t LEFT JOIN pos_stations st ON st.id = t.station_id LEFT JOIN users u ON u.id = t.user_id WHERE ${RANGE('t.opened_at')}
           UNION ALL
           SELECT t.closed_at, 'drawer_close', t.closed_by, u.name, st.name, 'Shift ' || t.id, NULL, NULL, t.expected_cash, t.counted_cash, t.variance, t.close_notes
             FROM till_sessions t LEFT JOIN pos_stations st ON st.id = t.station_id LEFT JOIN users u ON u.id = t.closed_by WHERE t.closed_at IS NOT NULL AND ${RANGE('t.closed_at')}
           UNION ALL
           SELECT a.at, 'hold', a.user_id, a.user_name, a.station, NULL, NULL, NULL, NULL, NULL, NULL, NULL
             FROM audit_log a WHERE a.action = 'POST /api/admin/pos/hold' AND ${RANGE('a.at')}
         ) x WHERE ($3::int IS NULL OR x.user_id = $3) AND ($4::text[] IS NULL OR x.kind = ANY($4))
         ORDER BY x.at DESC LIMIT 1000`, [p.from, p.to, user, kinds]);
      res.json({ rows: rows.map((r) => ({ ...r, amount: r.amount == null ? null : r2(r.amount) })) });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------- exceptions --
  app.get('/api/tj/exceptions', ...can('tj.view'), async (req, res) => {
    try {
      const p = period(req.query);
      if (!p.from || !p.to) throw httpError(400, 'Choose the dates');
      const P = [p.from, p.to];
      const big = Number(await setting('tj_void_alert', '20000')) || 20000;
      const discPct = Number(await setting('tj_discount_pct_alert', '20')) || 20;
      const nosale = Number(await setting('tj_nosale_per_day', '5')) || 5;
      const removed = Number(await setting('tj_removed_per_day', '15')) || 15;
      const out = { thresholds: { big, discPct, nosale, removed } };
      out.voids = (await query(
        `SELECT ps.id, ps.receipt_number AS ref, ps.voided_at AS at, u.name AS by_name, ps.cashier_name, ps.total_usd AS amount, ps.customer_name,
                (ps.voided_by IS NOT NULL AND ps.voided_by = ps.cashier_id) AS own_sale
           FROM pos_sales ps LEFT JOIN users u ON u.id = ps.voided_by
          WHERE ps.voided AND ${RANGE('ps.voided_at')} AND (ps.total_usd >= $3 OR ps.voided_by = ps.cashier_id) ORDER BY ps.total_usd DESC LIMIT 200`, [...P, big])).rows;
      out.refunds = (await query(
        `SELECT r.id, r.return_number AS ref, r.created_at AS at, u.name AS by_name, s.receipt_number, s.cashier_name, r.refund_total_usd AS amount, r.refund_method, r.reason,
                (r.processed_by = s.cashier_id) AS own_sale, (r.created_at::date = s.created_at::date) AS same_day
           FROM pos_sale_returns r LEFT JOIN pos_sales s ON s.id = r.sale_id LEFT JOIN users u ON u.id = r.processed_by
          WHERE ${RANGE('r.created_at')} AND (r.refund_total_usd >= $3 OR (r.processed_by = s.cashier_id AND r.refund_method = 'cash'))
          ORDER BY r.refund_total_usd DESC LIMIT 200`, [...P, big])).rows;
      out.discounts = (await query(
        `SELECT * FROM (
           SELECT s.id, s.receipt_number AS ref, s.created_at AS at, COALESCE(s.cashier_name, u.name) AS by_name, s.customer_name,
                  COALESCE(s.discount_usd, 0) + COALESCE((SELECT SUM(discount_usd) FROM pos_sale_items i WHERE i.sale_id = s.id), 0) AS discount,
                  s.subtotal_usd + COALESCE((SELECT SUM(discount_usd) FROM pos_sale_items i WHERE i.sale_id = s.id), 0) AS gross
             FROM pos_sales s LEFT JOIN users u ON u.id = s.cashier_id WHERE ${RANGE('s.created_at')} AND NOT COALESCE(s.voided, false) AND s.receipt_number NOT LIKE 'CN%') x
          WHERE gross > 0 AND discount / gross * 100 >= $3 ORDER BY discount DESC LIMIT 200`, [...P, discPct])).rows
        .map((r) => ({ ...r, pct: Math.round(r.discount / r.gross * 1000) / 10 }));
      out.below_cost = (await query(
        `SELECT s.receipt_number AS ref, s.created_at AS at, COALESCE(s.cashier_name, u.name) AS by_name, i.description AS item, i.qty, i.unit_price_usd AS price, i.unit_cost AS cost,
                (i.unit_cost - i.unit_price_usd) * i.qty AS amount
           FROM pos_sale_items i JOIN pos_sales s ON s.id = i.sale_id LEFT JOIN users u ON u.id = s.cashier_id
          WHERE ${RANGE('s.created_at')} AND NOT COALESCE(s.voided, false) AND i.qty > 0 AND i.unit_cost > 0 AND i.unit_price_usd - COALESCE(i.discount_usd, 0) / NULLIF(i.qty, 0) < i.unit_cost
          ORDER BY amount DESC LIMIT 200`, P)).rows;
      out.price_cuts = (await query(
        `SELECT e.at, e.user_name AS by_name, e.name AS item, e.value_before AS before, e.value_after AS after, e.qty, (e.value_before - e.value_after) * COALESCE(e.qty, 1) AS amount
           FROM pos_events e WHERE e.kind = 'price_changed' AND e.value_after < e.value_before AND ${RANGE('e.at')} ORDER BY amount DESC LIMIT 200`, P)).rows;
      out.overrides = (await query(
        `SELECT e.at, e.user_name AS by_name, e.kind, e.name AS item, e.note, a.name AS approved_by
           FROM pos_events e LEFT JOIN users a ON a.id = e.approved_by WHERE e.kind IN ('dept_override', 'dept_blocked') AND ${RANGE('e.at')} ORDER BY e.at DESC LIMIT 200`, P)).rows;
      out.no_sales = (await query(
        `SELECT u.name AS by_name, to_char(m.created_at AT TIME ZONE '${TZ}', 'YYYY-MM-DD') AS day, COUNT(*)::int AS n, string_agg(DISTINCT m.reason, '; ') AS reasons
           FROM till_movements m LEFT JOIN users u ON u.id = m.by_user WHERE m.kind = 'no_sale' AND ${RANGE('m.created_at')}
          GROUP BY 1, 2 HAVING COUNT(*) > $3 ORDER BY 3 DESC`, [...P, nosale])).rows;
      out.removals = (await query(
        `SELECT e.user_name AS by_name, to_char(e.at AT TIME ZONE '${TZ}', 'YYYY-MM-DD') AS day, COUNT(*) FILTER (WHERE e.kind = 'item_removed')::int AS removed,
                COUNT(*) FILTER (WHERE e.kind = 'cart_cleared')::int AS cleared, COALESCE(SUM(e.amount), 0) AS amount
           FROM pos_events e WHERE e.kind IN ('item_removed', 'cart_cleared') AND ${RANGE('e.at')}
          GROUP BY 1, 2 HAVING COUNT(*) FILTER (WHERE e.kind = 'item_removed') > $3 OR COUNT(*) FILTER (WHERE e.kind = 'cart_cleared') > 3 ORDER BY 3 DESC`, [...P, removed])).rows;
      // Per person: how many exceptions each one has, to see patterns.
      const tally = {};
      const add = (name, k) => { const x = (tally[name || '–'] = tally[name || '–'] || { voids: 0, refunds: 0, discounts: 0, below_cost: 0, price_cuts: 0, overrides: 0, no_sales: 0, removals: 0 }); x[k]++; };
      out.voids.forEach((r) => add(r.by_name, 'voids')); out.refunds.forEach((r) => add(r.by_name, 'refunds')); out.discounts.forEach((r) => add(r.by_name, 'discounts'));
      out.below_cost.forEach((r) => add(r.by_name, 'below_cost')); out.price_cuts.forEach((r) => add(r.by_name, 'price_cuts')); out.overrides.forEach((r) => add(r.by_name, 'overrides'));
      out.no_sales.forEach((r) => add(r.by_name, 'no_sales')); out.removals.forEach((r) => add(r.by_name, 'removals'));
      out.by_person = Object.entries(tally).map(([name, t]) => ({ name, ...t, total: Object.values(t).reduce((s, v) => s + v, 0) })).sort((a, b) => b.total - a.total);
      res.json(out);
    } catch (e) { fail(res, e); }
  });

  return { allowedFor };
}

module.exports = { register };
