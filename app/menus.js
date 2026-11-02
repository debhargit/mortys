// =============================================================================
//  STAFF MENUS -- who sees which tiles on the "All modules" screen.
//
//  Two layers, both on one row per person (user_module_menus):
//    layout      set by a manager on the kanban board: the groups (columns)
//                and the modules (cards) in each, in order. NULL means the
//                standard menu for their role.
//    favourites  the person's own starred modules, pinned to a row at the top.
//
//  Neither can widen access. Every module below names the permissions its
//  page needs (any one of them is enough); a module a person may not use is
//  never sent to them, whatever a layout or a favourite says. The pages
//  themselves still check again when they open.
//
//  The tiles' names and icons live in MODULE_GROUPS in admin.html; this file
//  only knows each tile by its link. test/menus-pg-test.mjs checks the two
//  lists match.
// =============================================================================

// link -> permissions that open it (any one). null: every staff member.
const MODULES = {
  '/supplier-admin.html': ['suppliers.manage'],
  '/supplier.html': ['suppliers.manage'],
  '/team.html': null,
  '/team.html#calendar': null,
  '/team.html#manage': ['team.oversee'],
  '/my-time.html': null,
  '/documents.html': ['docs.view'],
  '/documents.html#comms': ['comms.journal'],
  '/documents.html#forms': ['docs.upload'],
  '/accounting.html': ['acct.view'],
  '/budget.html': ['acct.budget', 'acct.view'],
  '/receivables.html': ['ar.manage'],
  '/payables.html': ['ap.manage'],
  '/banking.html': ['bank.manage'],
  '/loans-rent.html': ['ar.manage', 'ap.manage'],
  '/report-balancing.html': ['reports.view'],
  '/people.html': ['hr.people'],
  '/payroll.html': ['payroll.view', 'payroll.run'],
  '/clock.html': null,
  '/attendance.html': ['clock.approve', 'clock.manage'],
  '/commission.html': null,
  '/training.html': null,
  '/hiring.html': ['hr.manage', 'hr.approve'],
  '/franchise.html': ['franchise.manage'],
  '/franchisee.html': ['franchise.manage'],
  '/dispatch.html': ['fleet.view', 'fleet.dispatch'],
  '/fleet-wall.html': ['fleet.view'],
  '/mobile.html': null,
  '/driver.html': ['fleet.drive'],
  '/cashier.html': ['cashier.access'],
  '/warehouse.html': ['warehouse.access'],
  '/stockcash.html': ['mkt.manage', 'stock.grade_returns'],
  '/report-planning.html': ['planning.view', 'sales.lost_record'],
  '/terminal.html': ['tj.view', 'dept.manage'],
  '/deptstore.html': ['reports.view'],
  '/messages.html': ['notify.view'],
  '/ai.html': ['ai.manage'],
  '/': null,
  '/system.html': ['sys.audit', 'sys.security', 'sys.support', 'sys.network', 'support.raise'],
  '/security.html': ['sec.manage', 'audit.view'],
  '/legacy-import.html': ['import.legacy'],
};
const MAX_GROUPS = 30, MAX_TITLE = 60, MAX_FAVS = 40;

function register(app, { query, requireAdmin, requireCap, permState }) {
  const manage = [requireAdmin, requireCap('menu.manage')];

  // The links this person may see, in catalogue order.
  async function allowedFor(userId) {
    const { full, perms } = await permState(userId);
    return Object.keys(MODULES).filter((href) => {
      const caps = MODULES[href];
      return full || !caps || caps.some((c) => perms[c] !== false);
    });
  }

  // Keep only real, allowed links, each once, in a sane shape. Returns the
  // clean groups and the links that were taken out.
  function cleanLayout(groups, allowed) {
    if (!Array.isArray(groups)) return null;
    const ok = new Set(allowed), seen = new Set(), dropped = [];
    const out = [];
    for (const g of groups.slice(0, MAX_GROUPS)) {
      if (!g || typeof g !== 'object') continue;
      const title = String(g.title || '').trim().slice(0, MAX_TITLE) || 'Menu';
      const items = [];
      for (const h of Array.isArray(g.items) ? g.items : []) {
        if (typeof h !== 'string' || seen.has(h)) continue;
        if (!Object.prototype.hasOwnProperty.call(MODULES, h) || !ok.has(h)) { dropped.push(h); continue; }
        seen.add(h); items.push(h);
      }
      out.push({ title, items });
    }
    return { groups: out, dropped };
  }

  function cleanFavs(list, allowed, layout) {
    const ok = new Set(allowed);
    // With a manager's layout, only what is on their menu can be starred.
    if (layout) { const on = new Set(); layout.forEach((g) => g.items.forEach((h) => on.add(h))); for (const h of [...ok]) if (!on.has(h)) ok.delete(h); }
    const out = [];
    for (const h of Array.isArray(list) ? list : []) if (typeof h === 'string' && ok.has(h) && !out.includes(h)) out.push(h);
    return out.slice(0, MAX_FAVS);
  }

  async function menuOf(userId) {
    const allowed = await allowedFor(userId);
    const { rows } = await query(
      `SELECT m.layout, m.favourites, m.updated_at, u.name AS updated_by_name
         FROM user_module_menus m LEFT JOIN users u ON u.id = m.updated_by
        WHERE m.user_id = $1`, [userId]);
    const row = rows[0] || {};
    const layout = row.layout ? cleanLayout(row.layout, allowed).groups : null;
    return {
      allowed,
      layout,
      favourites: cleanFavs(row.favourites, allowed, layout),
      updated_at: row.layout ? row.updated_at : null,
      updated_by: row.layout ? row.updated_by_name || null : null,
    };
  }

  async function staffRow(id) {
    const { rows } = await query(
      `SELECT id, name, email, admin_role FROM users
        WHERE id = $1 AND is_admin = true AND COALESCE(disabled, false) = false`, [id]);
    return rows[0] || null;
  }

  async function saveLayout(userId, groups, by) {
    await query(
      `INSERT INTO user_module_menus (user_id, layout, updated_by, updated_at)
            VALUES ($1, $2::jsonb, $3, NOW())
       ON CONFLICT (user_id) DO UPDATE SET layout = EXCLUDED.layout, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [userId, groups ? JSON.stringify(groups) : null, by]);
  }

  // ---- the signed-in person's own menu ------------------------------------
  app.get('/api/menu/me', requireAdmin, async (req, res) => {
    try { res.json(Object.assign({ ok: true }, await menuOf(req.session.userId))); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/menu/me/favourites', requireAdmin, async (req, res) => {
    try {
      const me = await menuOf(req.session.userId);
      const favs = cleanFavs((req.body || {}).items, me.allowed, me.layout);
      await query(
        `INSERT INTO user_module_menus (user_id, favourites) VALUES ($1, $2::jsonb)
         ON CONFLICT (user_id) DO UPDATE SET favourites = EXCLUDED.favourites`,
        [req.session.userId, JSON.stringify(favs)]);
      res.json({ ok: true, favourites: favs });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---- managers: set up someone else's menu --------------------------------
  app.get('/api/menu/staff', ...manage, async (_req, res) => {
    try {
      const { rows } = await query(
        `SELECT u.id, u.name, u.email, u.admin_role, (m.layout IS NOT NULL) AS custom
           FROM users u LEFT JOIN user_module_menus m ON m.user_id = u.id
          WHERE u.is_admin = true AND COALESCE(u.disabled, false) = false
          ORDER BY lower(COALESCE(u.name, u.email))`);
      res.json({ staff: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/menu/staff/:id', ...manage, async (req, res) => {
    try {
      const u = await staffRow(Number(req.params.id));
      if (!u) return res.status(404).json({ error: 'No staff member with that number.' });
      res.json(Object.assign({ ok: true, user: u }, await menuOf(u.id)));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/menu/staff/:id', ...manage, async (req, res) => {
    try {
      const u = await staffRow(Number(req.params.id));
      if (!u) return res.status(404).json({ error: 'No staff member with that number.' });
      const allowed = await allowedFor(u.id);
      const c = cleanLayout((req.body || {}).groups, allowed);
      if (!c) return res.status(400).json({ error: 'Send the menu as a list of groups.' });
      if (!c.groups.length) return res.status(400).json({ error: 'The menu needs at least one group. To go back to the standard menu, use "Reset to role default".' });
      await saveLayout(u.id, c.groups, req.session.userId);
      res.json(Object.assign({ ok: true, dropped: c.dropped }, await menuOf(u.id)));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/menu/staff/:id', ...manage, async (req, res) => {
    try {
      const u = await staffRow(Number(req.params.id));
      if (!u) return res.status(404).json({ error: 'No staff member with that number.' });
      await saveLayout(u.id, null, req.session.userId);
      res.json(Object.assign({ ok: true }, await menuOf(u.id)));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Copy another person's layout. Modules the target may not use are left
  // out (and listed), never carried across.
  app.post('/api/menu/staff/:id/copy', ...manage, async (req, res) => {
    try {
      const u = await staffRow(Number(req.params.id));
      const from = await staffRow(Number((req.body || {}).from_user_id));
      if (!u || !from) return res.status(404).json({ error: 'Pick a staff member to copy from.' });
      if (u.id === from.id) return res.status(400).json({ error: 'That is the same person.' });
      const { rows } = await query('SELECT layout FROM user_module_menus WHERE user_id = $1', [from.id]);
      if (!rows[0] || !rows[0].layout) {
        await saveLayout(u.id, null, req.session.userId);
        return res.json(Object.assign({ ok: true, dropped: [], note: (from.name || from.email) + ' has the standard menu, so this person now has it too.' }, await menuOf(u.id)));
      }
      const c = cleanLayout(rows[0].layout, await allowedFor(u.id));
      await saveLayout(u.id, c.groups, req.session.userId);
      res.json(Object.assign({ ok: true, dropped: c.dropped }, await menuOf(u.id)));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return { MODULES, allowedFor };
}

module.exports = { register, MODULES };
