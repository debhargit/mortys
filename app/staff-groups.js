// =============================================================================
//  Vision Auto Solutions -- staff groups and selling limits
//
//  Mounted by server.js:  require('./staff-groups').register(app, deps)
//
//  Groups are the staff categories (user_categories) the shop already has --
//  Sales rep, Cashier, Mechanic and any it adds -- so the till, the service
//  module and commission keep finding people the way they always did. A group
//  now carries:
//    perms             yes (true) or no (false) per function; a person can do
//                      what any of their groups allows, else not what one of
//                      them refuses, else the standard (userPermState in
//                      server.js); then their own overrides. A group never
//                      saved here is {} and changes nothing.
//    max_discount_pct  the most a member may take off a ticket on their own
//
//  Discount limit for one person, first that applies:
//    owner / manager role             no limit
//    users.staff_discount_limit_pct   their own limit
//    their groups' max_discount_pct   the highest one (groups add up)
//    nothing set                      no limit (as before this existed)
//  users.discount_limit_pct is a CUSTOMER's ceiling and is not used here.
//  Past the limit, a manager's PIN approves up to a % for 15 minutes on that
//  till session (POST /api/admin/pos/discount-override); checkDiscount() is
//  called by the POS sale (and so by orders saved for a cashier) and quotes.
//
//  Routes (manager only unless noted):
//    GET    /api/admin/groups                 groups, members, functions, staff
//    POST   /api/admin/groups                 {label, copy_from}
//    PUT    /api/admin/groups/:id             {label, allowed:{key:bool}, max_discount_pct}
//    POST   /api/admin/groups/:id/members     {user_ids}
//    DELETE /api/admin/groups/:id/members/:uid
//    GET|PUT /api/admin/staff/:id/selling     {discount_limit_pct, commission_pct}
//    GET    /api/admin/me/selling             (any staff) own limit and rate
//    POST   /api/admin/pos/discount-override  (any staff; a manager's PIN)
// =============================================================================
'use strict';

const OVERRIDE_MS = 15 * 60000;

function register(app, deps) {
  const { query, requireAdmin, requireManager, permState, getCapabilities, getRestricted, roleCanManage, pins, syncStaffProfile } = deps;
  function httpError(status, msg) { const e = new Error(msg); e.status = status; e.publicMessage = msg; return e; }
  function fail(res, e) { const s = e.status || 500; if (s >= 500) console.error('[groups]', e); res.status(s).json({ error: e.publicMessage || e.message }); }
  const pct = (v) => (v === '' || v == null ? null : Number(v));
  function cleanPct(v, what) {
    const x = pct(v);
    if (x == null) return null;
    if (!(x >= 0 && x <= 100)) throw httpError(400, what + ' must be from 0 to 100%');
    return Math.round(x * 100) / 100;
  }
  // A column this file adds may be missing until schema.sql is applied: read it as "not set".
  const missingCol = (e) => e && e.code === '42703';

  // ------------------------------------------------------------ limits --
  async function limitFor(userId) {
    const { rows } = await query('SELECT admin_role FROM users WHERE id = $1', [userId]);
    if (!rows.length) return { limit_pct: null, source: null, manager: false };
    if (await roleCanManage(rows[0].admin_role)) return { limit_pct: null, source: 'manager', manager: true };
    try {
      const { rows: own } = await query('SELECT staff_discount_limit_pct::float AS v FROM users WHERE id = $1', [userId]);
      if (own[0] && own[0].v != null) return { limit_pct: own[0].v, source: 'own', manager: false };
      const { rows: g } = await query(
        `SELECT c.label, c.max_discount_pct::float AS v FROM user_category_members m
           JOIN user_categories c ON c.id = m.category_id AND c.is_active
          WHERE m.user_id = $1 AND c.max_discount_pct IS NOT NULL ORDER BY c.max_discount_pct DESC LIMIT 1`, [userId]);
      if (g.length) return { limit_pct: g[0].v, source: 'group', group: g[0].label, manager: false };
    } catch (e) { if (!missingCol(e)) throw e; }
    return { limit_pct: null, source: null, manager: false };
  }

  // The discount the operator is giving on a ticket, as a % of the goods
  // before discounts: per-line discounts plus the whole-ticket one. Loyalty
  // points and the account's own standing rate are not the operator's doing.
  function ticketDiscount(items, ticketDisc) {
    let gross = 0, disc = 0;
    for (const it of Array.isArray(items) ? items : []) {
      const g = (Number(it.unit_price_usd) || 0) * (Number(it.qty) || 0) + (Number(it.core_charge_usd) || 0) + (Number(it.env_fee_usd) || 0);
      gross += g;
      disc += Math.min(Math.max(0, g), Math.max(0, Number(it.discount_usd) || 0));
    }
    disc += Math.max(0, Number(ticketDisc) || 0);
    return { gross, disc, pct: gross > 0 ? (disc / gross) * 100 : 0 };
  }

  // null when the ticket's discount is within the operator's limit (or a
  // manager approved it); otherwise the 403 reply for the till to act on.
  // consume: a real sale or quote uses the approval up; a dry run does not.
  async function checkDiscount(req, items, ticketDisc, consume) {
    const t = ticketDiscount(items, ticketDisc);
    if (!(t.disc > 0.004) || !(t.gross > 0)) return null;
    const lim = await limitFor(req.session.userId);
    if (lim.limit_pct == null || t.pct <= lim.limit_pct + 0.01) return null;
    const ok = req.session.discountOk;
    if (ok && ok.until > Date.now() && t.pct <= Number(ok.pct) + 0.01) {
      if (consume) req.session.discountOk = null;
      return null;
    }
    const asked = Math.round(t.pct * 10) / 10;
    return { status: 403, body: {
      error: 'Your discount limit is ' + lim.limit_pct + '%. This ticket has ' + asked + '% off. A manager can approve it with their PIN.',
      discount_limit: true, limit_pct: lim.limit_pct, asked_pct: asked } };
  }

  app.get('/api/admin/me/selling', requireAdmin, async (req, res) => {
    try {
      const lim = await limitFor(req.session.userId);
      const { rows: m } = await query('SELECT id, commission_pct::float AS commission_pct FROM mechanics WHERE user_id = $1 AND is_active LIMIT 1', [req.session.userId]);
      res.json(Object.assign(lim, { rep: m[0] || null }));
    } catch (e) { fail(res, e); }
  });

  // A manager approves a discount above the operator's limit with their PIN.
  // Called by the till's PIN keypad (endpoint mode): body {pin, user_id}, ?pct=.
  const PIN_TRIES = new Map();
  app.post('/api/admin/pos/discount-override', requireAdmin, async (req, res) => {
    try {
      const key = req.session.userId + '';
      const t = PIN_TRIES.get(key) || { n: 0, first: Date.now() };
      if (Date.now() - t.first > 10 * 60000) { t.n = 0; t.first = Date.now(); }
      if (t.n >= 5) throw httpError(429, 'Too many wrong PINs. Wait a few minutes.');
      const want = Number(req.query.pct != null ? req.query.pct : (req.body || {}).pct);
      if (!(want > 0 && want <= 100)) throw httpError(400, 'Which discount % is being approved?');
      const pin = String((req.body || {}).pin || '').trim();
      if (!/^\d{4,8}$/.test(pin)) throw httpError(400, 'Enter the manager PIN');
      const picked = pins.pickedId(req.body);
      const { rows: staff } = await query(`SELECT id, name, admin_role, pin_hash FROM users WHERE pin_hash IS NOT NULL AND is_staff AND NOT disabled` + (picked ? ' AND id = $1' : ''), picked ? [picked] : []);
      const hit = await pins.pick(staff, pin);
      if (!hit) { t.n++; PIN_TRIES.set(key, t); throw httpError(401, 'PIN not recognised'); }
      if (!(await roleCanManage(hit.admin_role))) { t.n++; PIN_TRIES.set(key, t); throw httpError(403, (hit.name || 'That person') + ' cannot approve this: a manager is needed.'); }
      PIN_TRIES.delete(key);
      const p = Math.ceil(want * 10) / 10;
      req.session.discountOk = { by: hit.id, name: hit.name, pct: p, until: Date.now() + OVERRIDE_MS };
      const lim = await limitFor(req.session.userId);
      const { rows: u } = await query('SELECT name FROM users WHERE id = $1', [req.session.userId]);
      await query(`INSERT INTO pos_events (user_id, user_name, terminal, kind, value_before, value_after, approved_by, note)
                   VALUES ($1, $2, $3, 'discount_override', $4, $5, $6, $7)`,
        [req.session.userId, u[0] && u[0].name, String(req.get('x-terminal') || '').slice(0, 80) || null, lim.limit_pct, p, hit.id,
         'Discount up to ' + p + '% approved by ' + hit.name + (lim.limit_pct != null ? ' (limit ' + lim.limit_pct + '%)' : '')]).catch(() => {});
      res.json({ ok: true, pct: p, user: { id: hit.id, name: hit.name } });   // user: what the till's PIN keypad reads
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------------ groups --
  // A saved group says yes or no to every function it was shown, so a
  // person in two groups gets whatever either allows. A function added to
  // the app later is absent: the standard applies until the group is saved.
  function permsFromAllowed(allowed) {
    const out = {};
    for (const c of getCapabilities()) {
      if (Object.prototype.hasOwnProperty.call(allowed, c.key)) out[c.key] = allowed[c.key] === true;
    }
    return out;
  }

  app.get('/api/admin/groups', requireManager, async (req, res) => {
    try {
      let groups;
      try {
        ({ rows: groups } = await query(
          `SELECT c.id, c.code, c.label, c.department, c.is_staff, c.is_active, c.is_system, c.sort_order, c.perms, c.max_discount_pct::float AS max_discount_pct
             FROM user_categories c ORDER BY c.is_active DESC, c.sort_order, c.label`));
      } catch (e) {
        if (!missingCol(e)) throw e;
        ({ rows: groups } = await query(
          `SELECT c.id, c.code, c.label, c.department, c.is_staff, c.is_active, c.is_system, c.sort_order, c.perms, NULL::float AS max_discount_pct
             FROM user_categories c ORDER BY c.is_active DESC, c.sort_order, c.label`));
      }
      const { rows: mem } = await query(
        `SELECT m.category_id, u.id, u.name, u.email, u.admin_role FROM user_category_members m JOIN users u ON u.id = m.user_id
          WHERE NOT COALESCE(u.is_archived, false) ORDER BY u.name NULLS LAST, u.email`);
      const { rows: staff } = await query(
        `SELECT u.id, u.name, u.email, u.admin_role, COALESCE(r.can_manage, false) OR u.admin_role = 'owner' AS full
           FROM users u LEFT JOIN roles r ON r.code = u.admin_role
          WHERE (u.is_staff OR u.is_admin) AND NOT COALESCE(u.is_archived, false) AND NOT COALESCE(u.disabled, false)
          ORDER BY u.name NULLS LAST, u.email`);
      const fullIds = new Set(staff.filter((s) => s.full).map((s) => s.id));
      for (const g of groups) g.members = mem.filter((m) => m.category_id === g.id).map((m) => ({ id: m.id, name: m.name, email: m.email, admin_role: m.admin_role, full: fullIds.has(m.id) }));
      const restricted = getRestricted();
      res.json({ groups, staff, capabilities: getCapabilities().map((c) => Object.assign({ restricted: restricted.has(c.key) }, c)) });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/admin/groups', requireManager, async (req, res) => {
    try {
      const b = req.body || {};
      const label = String(b.label || '').trim().slice(0, 60);
      if (!label) throw httpError(400, 'Give the group a name');
      const code = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
      if (!code) throw httpError(400, 'The name needs a letter or a number');
      let perms = {}, maxDisc = null;
      const from = parseInt(b.copy_from, 10);
      if (from) {
        const { rows } = await query('SELECT * FROM user_categories WHERE id = $1', [from]);
        if (!rows.length) throw httpError(404, 'The group to copy was not found');
        perms = rows[0].perms || {}; maxDisc = rows[0].max_discount_pct != null ? rows[0].max_discount_pct : null;
      }
      const { rows } = await query(
        `INSERT INTO user_categories (code, label, department, is_staff, sort_order, is_system, perms) VALUES ($1, $2, $3, true, 100, false, $4::jsonb) RETURNING id`,
        [code, label, b.department ? String(b.department).slice(0, 60) : null, JSON.stringify(perms)]);
      if (maxDisc != null) await query('UPDATE user_categories SET max_discount_pct = $2 WHERE id = $1', [rows[0].id, maxDisc]).catch(() => {});
      res.json({ ok: true, id: rows[0].id });
    } catch (e) { if (e.code === '23505') e = httpError(409, 'There is already a group with that name'); fail(res, e); }
  });

  app.put('/api/admin/groups/:id', requireManager, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const b = req.body || {};
      const { rows } = await query('SELECT id FROM user_categories WHERE id = $1', [id]);
      if (!rows.length) throw httpError(404, 'Group not found');
      if (b.label !== undefined) {
        const label = String(b.label || '').trim().slice(0, 60);
        if (!label) throw httpError(400, 'Give the group a name');
        await query('UPDATE user_categories SET label = $2 WHERE id = $1', [id, label]);
      }
      if (b.allowed && typeof b.allowed === 'object') {
        await query('UPDATE user_categories SET perms = $2::jsonb WHERE id = $1', [id, JSON.stringify(permsFromAllowed(b.allowed))]);
      }
      if (b.max_discount_pct !== undefined) {
        await query('UPDATE user_categories SET max_discount_pct = $2 WHERE id = $1', [id, cleanPct(b.max_discount_pct, 'The discount limit')]);
      }
      if (b.is_active !== undefined) await query('UPDATE user_categories SET is_active = $2 WHERE id = $1', [id, !!b.is_active]);
      const { rows: out } = await query('SELECT perms FROM user_categories WHERE id = $1', [id]);
      res.json({ ok: true, perms: out[0].perms });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/admin/groups/:id/members', requireManager, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const ids = [...new Set((Array.isArray((req.body || {}).user_ids) ? req.body.user_ids : []).map((x) => parseInt(x, 10)).filter(Boolean))];
      if (!ids.length) throw httpError(400, 'Choose who to add');
      const { rows: g } = await query('SELECT id FROM user_categories WHERE id = $1', [id]);
      if (!g.length) throw httpError(404, 'Group not found');
      const { rows: ok } = await query(`SELECT id FROM users WHERE id = ANY($1::int[]) AND (is_staff OR is_admin)`, [ids]);
      for (const u of ok) {
        await query('INSERT INTO user_category_members (user_id, category_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [u.id, id]);
        await syncStaffProfile(u.id);
      }
      res.json({ ok: true, added: ok.length });
    } catch (e) { fail(res, e); }
  });

  app.delete('/api/admin/groups/:id/members/:uid', requireManager, async (req, res) => {
    try {
      const uid = parseInt(req.params.uid, 10);
      const { rowCount } = await query('DELETE FROM user_category_members WHERE category_id = $1 AND user_id = $2', [parseInt(req.params.id, 10), uid]);
      if (!rowCount) throw httpError(404, 'That person is not in this group');
      await syncStaffProfile(uid);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ---------------------------------------------- one person's selling --
  async function sellingOf(id) {
    const { rows: u } = await query('SELECT id, admin_role FROM users WHERE id = $1 AND (is_staff OR is_admin)', [id]);
    if (!u.length) throw httpError(404, 'Staff member not found');
    let own = null;
    try { own = (await query('SELECT staff_discount_limit_pct::float AS v FROM users WHERE id = $1', [id])).rows[0].v; } catch (e) { if (!missingCol(e)) throw e; }
    const lim = await limitFor(id);
    const { rows: m } = await query('SELECT id, commission_pct::float AS commission_pct FROM mechanics WHERE user_id = $1 AND is_active LIMIT 1', [id]);
    const st = await permState(id);
    return { discount_limit_pct: own, effective: lim, rep: m[0] || null, groups_give: st.cat_grants || [], groups_block: st.cat_denies || [] };
  }
  app.get('/api/admin/staff/:id/selling', requireManager, async (req, res) => {
    try { res.json(await sellingOf(parseInt(req.params.id, 10))); } catch (e) { fail(res, e); }
  });
  app.put('/api/admin/staff/:id/selling', requireManager, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const b = req.body || {};
      await sellingOf(id);
      if (b.discount_limit_pct !== undefined) {
        await query('UPDATE users SET staff_discount_limit_pct = $2 WHERE id = $1', [id, cleanPct(b.discount_limit_pct, 'The discount limit')]);
      }
      if (b.commission_pct !== undefined) {
        const rate = cleanPct(b.commission_pct, 'The commission rate');
        const { rowCount } = await query('UPDATE mechanics SET commission_pct = $2 WHERE user_id = $1 AND is_active', [id, rate]);
        if (!rowCount) throw httpError(400, 'Only a sales rep earns commission. Add them to the Sales rep group first.');
      }
      res.json(Object.assign({ ok: true }, await sellingOf(id)));
    } catch (e) { fail(res, e); }
  });

  return { limitFor, checkDiscount, ticketDiscount };
}

module.exports = { register };
