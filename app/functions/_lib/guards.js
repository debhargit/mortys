// Auth guards, mirroring requireAdmin / requireManager / userCan in server.js.
// Each re-reads the users row per request so a disabled or demoted account is
// locked out on its next call. Return { user } on success or { error, status }.
import { readSession } from './session.js';
import { d1 } from './db.js';

export async function sessionEpoch(db) {
  const r = await db.one("SELECT value FROM app_config WHERE key = 'session_epoch'");
  return r ? Number(r.value) || 0 : 0;
}

export async function currentUser(request, env) {
  const s = await readSession(request, env);
  if (!s || !s.userId) return null;
  const db = d1(env);
  if ((s.epoch || 0) !== (await sessionEpoch(db))) return null;
  return db.one(
    'SELECT id, email, name, phone, is_admin, admin_role, is_staff, disabled, perms, show_prices FROM users WHERE id = ?',
    s.userId
  );
}

export async function requireAuth(request, env) {
  const u = await currentUser(request, env);
  if (!u) return { error: 'Sign in required', status: 401 };
  if (u.disabled) return { error: 'This account has been disabled.', status: 403 };
  return { user: u };
}

export async function requireAdmin(request, env) {
  const g = await requireAuth(request, env);
  if (g.error) return g;
  if (!g.user.is_admin) return { error: 'Admin access required', status: 403 };
  return g;
}

// server.js roleCanManage(): 'owner' always; else the roles row; unknown = no.
export async function roleCanManage(env, code) {
  if (code === 'owner') return true;
  if (!code) return false;
  const r = await d1(env).one('SELECT can_manage FROM roles WHERE code = ?', code);
  return !!(r && r.can_manage);
}

export async function requireManager(request, env) {
  const g = await requireAdmin(request, env);
  if (g.error) return g;
  if (!(await roleCanManage(env, g.user.admin_role))) {
    return { error: 'Manager access required for this action', status: 403 };
  }
  return g;
}

// Hono middleware wrappers: run a guard, 401/403 on failure, else stash the
// user row at c.get('user'). Shared by every route module.
export function mw(guard) {
  return async (c, next) => {
    const g = await guard(c.req.raw, c.env);
    if (g.error) return c.json({ error: g.error }, g.status);
    c.set('user', g.user);
    await next();
  };
}
export const authMw = mw(requireAuth);
export const adminMw = mw(requireAdmin);
export const managerMw = mw(requireManager);

// Deny-list capability check. A cap is allowed unless users.perms says
// {"key": false}; a manager role is never restricted. (server.js also folds in
// category-level denies — port that in Phase 3 with the staff endpoints.)
export function userCan(user, key) {
  if (!user || !user.is_admin) return false;
  if (user.admin_role === 'owner') return true;
  let perms = {};
  try { perms = user.perms ? JSON.parse(user.perms) : {}; } catch { perms = {}; }
  return perms[key] !== false;
}
