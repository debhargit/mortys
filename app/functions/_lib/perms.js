// Shared: resolve a user's effective capability map across role / category /
// per-user layers. Mirrors server.js userPermState().
import { d1 } from './db.js';
import { CAPABILITIES } from './capabilities.js';
import { safeJson } from './util.js';

export async function roleExists(env, code) {
  if (!code) return false;
  const r = await d1(env).one('SELECT 1 AS x FROM roles WHERE code = ?', code);
  return !!r;
}

export async function roleCanManage(env, code) {
  if (code === 'owner') return true;
  if (!code) return false;
  const r = await d1(env).one('SELECT can_manage FROM roles WHERE code = ?', code);
  return r ? !!r.can_manage : false;
}

export async function userPermState(env, userId) {
  const db = d1(env);
  const u = await db.one('SELECT admin_role, perms FROM users WHERE id = ?', userId);
  if (!u) return { full: false, perms: {}, cat_denies: [] };
  const full = await roleCanManage(env, u.admin_role);
  const userOv = safeJson(u.perms, {});

  const catDeny = {};
  if (!full) {
    const cr = await db.many(
      `SELECT c.perms FROM user_category_members m
         JOIN user_categories c ON c.id = m.category_id AND c.is_active = 1
        WHERE m.user_id = ?`, userId);
    for (const row of cr) {
      const p = safeJson(row.perms, {});
      for (const [k, v] of Object.entries(p)) if (v === false) catDeny[k] = true;
    }
  }

  const perms = {};
  for (const c of CAPABILITIES) {
    if (full) { perms[c.key] = true; continue; }
    let allowed = !catDeny[c.key];
    if (userOv[c.key] === true) allowed = true;
    if (userOv[c.key] === false) allowed = false;
    perms[c.key] = allowed;
  }
  return { full, perms, cat_denies: Object.keys(catDeny) };
}
