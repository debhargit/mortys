// Cloudflare Pages Functions entry — one Hono app catches every request that
// isn't a static file under public/. This is Phase 1 of the port (see
// app/PORT.md): the auth flow and one storefront read endpoint, as the pattern
// every other route follows. Everything not yet ported returns 501.
//
// NOT RUNTIME-TESTED — there is no wrangler/D1 in the build environment.
// Verify with `npm run cf:dev` before relying on it.

import { Hono } from 'hono';
import bcrypt from 'bcryptjs';
import { d1 } from './_lib/db.js';
import { sessionCookie } from './_lib/session.js';
import { currentUser, sessionEpoch } from './_lib/guards.js';

const app = new Hono();

// Matches server.js publicUser()
function publicUser(row) {
  if (!row) return null;
  return { id: row.id, email: row.email, name: row.name, is_admin: !!row.is_admin, admin_role: row.admin_role || null };
}

// ---------------------------------------------------------------------------
//  AUTH
// ---------------------------------------------------------------------------
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

// PIN sign-in: match against every staff PIN (there is no username to look up
// first). PINs are unique across staff, enforced when set.
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
  return c.json({ user: { ...publicUser(u), phone: u.phone || null, perms, perms_full } });
});

// ---------------------------------------------------------------------------
//  STOREFRONT READ — template for a Postgres->SQLite SELECT port
// ---------------------------------------------------------------------------
app.get('/api/products', async (c) => {
  const db = d1(c.env);
  const q = c.req.query();
  const where = ['is_active = 1'];
  const binds = [];
  if (q.category)  { where.push('category = ?');  binds.push(q.category); }
  if (q.condition) { where.push('condition = ?'); binds.push(q.condition); }
  if (q.q) {
    const s = '%' + String(q.q).toLowerCase() + '%';
    where.push('(lower(name) LIKE ? OR lower(coalesce(sku, \'\')) LIKE ? OR lower(coalesce(make_model, \'\')) LIKE ?)');
    binds.push(s, s, s);
  }
  const limit = Math.min(200, Math.max(1, parseInt(q.limit, 10) || 50));
  const offset = Math.max(0, parseInt(q.offset, 10) || 0);
  const cols = `img, name, make_model, category, condition, price_usd, stock_count, low_threshold,
                sku, barcode, bin_location, location,
                CASE WHEN stock_count <= 0 THEN 'out'
                     WHEN stock_count <= low_threshold THEN 'low' ELSE 'in' END AS stock_level`;
  const rows = await db.many(
    `SELECT ${cols} FROM products WHERE ${where.join(' AND ')} ORDER BY name LIMIT ? OFFSET ?`,
    ...binds, limit, offset
  );
  const tot = await db.one(`SELECT COUNT(*) AS n FROM products WHERE ${where.join(' AND ')}`, ...binds);
  return c.json({ products: rows, total: tot ? tot.n : rows.length, limit, offset, count_mode: 'exact' });
});

app.get('/api/products/:img', async (c) => {
  const row = await d1(c.env).one('SELECT * FROM products WHERE img = ? AND is_active = 1', c.req.param('img'));
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json({ product: row });
});

// ---------------------------------------------------------------------------
app.get('/api/health', (c) => c.json({ ok: true, runtime: 'cloudflare-pages', phase: 1 }));

app.all('/api/*', (c) => c.json({ error: 'This endpoint is not ported to Cloudflare yet — see app/PORT.md' }, 501));

export const onRequest = (context) => app.fetch(context.request, context.env, context);
