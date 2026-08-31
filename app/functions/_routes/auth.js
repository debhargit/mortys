// Phase 1 — auth flow. Ports server.js /api/auth/* and /api/me.
import bcrypt from 'bcryptjs';
import { d1 } from '../_lib/db.js';
import { sessionCookie } from '../_lib/session.js';
import { currentUser, sessionEpoch } from '../_lib/guards.js';

// Matches server.js publicUser()
export function publicUser(row) {
  if (!row) return null;
  return { id: row.id, email: row.email, name: row.name, is_admin: !!row.is_admin, admin_role: row.admin_role || null };
}

export default function mount(app) {
  app.post('/api/auth/signin', async (c) => {
    const { email, password } = await c.req.json().catch(() => ({}));
    if (!email || !password) return c.json({ error: 'email and password are required' }, 400);
    const db = d1(c.env);
    const u = await db.one(
      'SELECT id, email, name, password_hash, is_admin, admin_role, disabled FROM users WHERE lower(email) = lower(?) LIMIT 1',
      email
    );
    if (!u || !(await bcrypt.compare(password, u.password_hash || ''))) {
      return c.json({ error: 'Invalid credentials' }, 401);
    }
    if (u.disabled) return c.json({ error: 'This account has been disabled. Ask a manager.' }, 403);
    c.header('Set-Cookie', await sessionCookie(c.env, { userId: u.id, epoch: await sessionEpoch(db) }));
    return c.json({ user: publicUser(u) });
  });

  // PIN sign-in: match against every staff PIN (no username to look up first).
  app.post('/api/auth/pin-signin', async (c) => {
    const { pin } = await c.req.json().catch(() => ({}));
    const p = String(pin || '').trim();
    if (!p) return c.json({ error: 'PIN required' }, 400);
    const db = d1(c.env);
    const rows = await db.many(
      "SELECT id, email, name, is_admin, admin_role, pin_hash FROM users WHERE pin_hash IS NOT NULL AND is_staff = 1 AND COALESCE(disabled, 0) = 0"
    );
    let hit = null;
    for (const r of rows) {
      if (await bcrypt.compare(p, r.pin_hash)) { hit = r; break; }
    }
    if (!hit) return c.json({ error: 'PIN not recognised' }, 401);
    if (!hit.is_admin) {
      return c.json({ error: (hit.name || 'That staff member') + ' does not have admin panel access.' }, 403);
    }
    c.header('Set-Cookie', await sessionCookie(c.env, { userId: hit.id, epoch: await sessionEpoch(db) }));
    return c.json({ user: publicUser(hit) });
  });

  app.post('/api/auth/signout', async (c) => {
    c.header('Set-Cookie', await sessionCookie(c.env, {}, { clear: true }));
    return c.json({ ok: true });
  });

  app.get('/api/me', async (c) => {
    const u = await currentUser(c.req.raw, c.env);
    if (!u) return c.json({ user: null });
    let perms = {}, perms_full = false;
    if (u.is_admin) {
      try { perms = u.perms ? JSON.parse(u.perms) : {}; } catch { perms = {}; }
      const role = await d1(c.env).one('SELECT can_manage FROM roles WHERE code = ?', u.admin_role);
      perms_full = u.admin_role === 'owner' || !!(role && role.can_manage);
    }
    return c.json({ user: { ...publicUser(u), phone: u.phone || null, show_prices: !!u.show_prices, perms, perms_full } });
  });
}
