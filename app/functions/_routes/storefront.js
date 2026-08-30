// Phase 2 — storefront / catalogue read paths. Ports server.js:
//   GET  /api/products              GET /api/products/count   GET /api/products/:img
//   GET  /api/cart  POST /api/cart  PATCH/DELETE /api/cart/:img   (requireAuth)
//   GET  /api/reviews   POST /api/reviews
//   GET  /api/wishlist  POST /api/wishlist  DELETE /api/wishlist/:img   (requireAuth)
//   POST /api/notify
//   GET  /api/filters   (new — categories + makes for storefront dropdowns)
//
// D1 notes (see PORT.md):
//  * products has no `id` — children key on `product_img`; no `barcode`,
//    no generated `search_text`.
//  * money is `*_cents` in D1 -> convert to `*_usd` at the SELECT boundary.
import { d1 } from '../_lib/db.js';
import { authMw } from '../_lib/guards.js';
import { currentUser } from '../_lib/guards.js';

// server.js buildProductWhere(), for SQLite.
function productWhere(q) {
  const where = ['is_active = 1'];
  const binds = [];
  if (q.category)  { where.push('category = ?');  binds.push(q.category); }
  if (q.condition) { where.push('condition = ?'); binds.push(q.condition); }
  const stock = q.stock_status || (String(q.in_stock) === '1' ? 'in' : '');
  if (stock === 'out') where.push('stock_count <= 0');
  else if (stock === 'low') where.push('stock_count > 0 AND stock_count <= low_threshold');
  else if (stock === 'in') where.push('stock_count > 0');
  if (q.make_model) { where.push('make_model = ?'); binds.push(q.make_model); }
  if (q.location)   { where.push('location = ?');   binds.push(q.location); }
  const pMin = Number(q.price_min);
  if (Number.isFinite(pMin) && pMin > 0) { where.push('price_cents >= ?'); binds.push(Math.round(pMin * 100)); }
  const pMax = Number(q.price_max);
  if (Number.isFinite(pMax) && pMax > 0) { where.push('price_cents <= ?'); binds.push(Math.round(pMax * 100)); }
  if (q.q) {
    const terms = String(q.q).split(',').map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 4);
    for (const t of terms) {
      where.push("(lower(name) LIKE ? OR lower(make_model) LIKE ? OR lower(coalesce(sku,'')) LIKE ?)");
      const s = '%' + t + '%';
      binds.push(s, s, s);
    }
  }
  return { where: where.join(' AND '), binds };
}

const SORTS = {
  name: 'category, name',
  name_asc: 'name ASC',
  name_desc: 'name DESC',
  price_asc: 'price_cents ASC NULLS LAST, name',
  price_desc: 'price_cents DESC NULLS LAST, name',
  stock_asc: 'stock_count ASC, name',
  stock_desc: 'stock_count DESC, name',
};

const LIST_COLS = `
  img, name, make_model, category, condition,
  price_cents / 100.0 AS price_usd,
  stock_count, low_threshold, sku, NULL AS barcode, bin_location, location,
  CASE WHEN stock_count <= 0 THEN 'out'
       WHEN stock_count <= low_threshold THEN 'low' ELSE 'in' END AS stock_level`;

const COUNT_CAP = 5000;

export default function mount(app) {
  app.get('/api/products', async (c) => {
    try {
      const db = d1(c.env);
      const q = c.req.query();
      const { where, binds } = productWhere(q);
      const orderBy = SORTS[q.sort] || SORTS.name;
      const limit = Math.min(200, Math.max(1, parseInt(q.limit, 10) || 60));
      const offset = Math.max(0, parseInt(q.offset, 10) || 0);

      const [rows, cnt] = await Promise.all([
        db.many(`SELECT ${LIST_COLS} FROM products WHERE ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
          ...binds, limit, offset),
        // Capped like server.js so a huge search shows "5,000+" not a full scan.
        db.one(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM products WHERE ${where} LIMIT ${COUNT_CAP + 1}) t`, ...binds),
      ]);
      const counted = (cnt && cnt.n) || 0;
      const capped = counted > COUNT_CAP;
      const total = Math.max(capped ? COUNT_CAP : counted, offset + rows.length);
      return c.json({ products: rows, total, limit, offset, approximate: capped, count_mode: capped ? 'capped' : 'exact' });
    } catch (e) {
      return c.json({ error: 'Server error' }, 500);
    }
  });

  app.get('/api/products/count', async (c) => {
    try {
      const { where, binds } = productWhere(c.req.query());
      const row = await d1(c.env).one(`SELECT COUNT(*) AS count FROM products WHERE ${where}`, ...binds);
      return c.json({ count: (row && row.count) || 0 });
    } catch (e) {
      return c.json({ error: 'Server error' }, 500);
    }
  });

  app.get('/api/products/:img', async (c) => {
    const row = await d1(c.env).one(
      'SELECT *, price_cents / 100.0 AS price_usd, cost_cents / 100.0 AS cost_usd FROM products WHERE img = ? AND is_active = 1',
      c.req.param('img')
    );
    if (!row) return c.json({ error: 'Not found' }, 404);
    return c.json({ product: row });
  });

  app.get('/api/filters', async (c) => {
    const db = d1(c.env);
    const [cats, makes] = await Promise.all([
      db.many("SELECT DISTINCT category FROM products WHERE is_active = 1 AND category <> '' ORDER BY category"),
      db.many("SELECT DISTINCT make_model FROM products WHERE is_active = 1 AND make_model <> '' ORDER BY make_model"),
    ]);
    return c.json({ categories: cats.map((r) => r.category), makes: makes.map((r) => r.make_model) });
  });

  // ---- cart (D1 cart_items has no product_id; key on product_img) ----------
  app.get('/api/cart', authMw, async (c) => {
    const rows = await d1(c.env).many(
      `SELECT c.product_img AS img, c.qty, p.name, p.make_model, p.price_cents / 100.0 AS price_usd, p.condition
         FROM cart_items c JOIN products p ON p.img = c.product_img
        WHERE c.user_id = ? ORDER BY c.updated_at DESC`,
      c.get('user').id
    );
    const total = rows.reduce((s, r) => s + Number(r.price_usd || 0) * r.qty, 0);
    return c.json({ cart: rows, total_usd: total });
  });

  app.post('/api/cart', authMw, async (c) => {
    const { img, qty = 1 } = await c.req.json().catch(() => ({}));
    if (!img) return c.json({ error: 'img is required' }, 400);
    try {
      await d1(c.env).run(
        `INSERT INTO cart_items (user_id, product_img, qty) VALUES (?, ?, ?)
           ON CONFLICT(user_id, product_img) DO UPDATE SET qty = qty + excluded.qty, updated_at = CURRENT_TIMESTAMP`,
        c.get('user').id, img, Math.max(1, parseInt(qty, 10) || 1)
      );
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: 'That product is no longer available' }, 400);
    }
  });

  app.patch('/api/cart/:img', authMw, async (c) => {
    const qty = parseInt((await c.req.json().catch(() => ({}))).qty, 10);
    if (!Number.isFinite(qty)) return c.json({ error: 'qty required' }, 400);
    const db = d1(c.env);
    const uid = c.get('user').id;
    if (qty <= 0) await db.run('DELETE FROM cart_items WHERE user_id = ? AND product_img = ?', uid, c.req.param('img'));
    else await db.run('UPDATE cart_items SET qty = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND product_img = ?', qty, uid, c.req.param('img'));
    return c.json({ ok: true });
  });

  app.delete('/api/cart/:img', authMw, async (c) => {
    await d1(c.env).run('DELETE FROM cart_items WHERE user_id = ? AND product_img = ?', c.get('user').id, c.req.param('img'));
    return c.json({ ok: true });
  });

  // ---- reviews ----------------------------------------------------------
  app.get('/api/reviews', async (c) => {
    const db = d1(c.env);
    const [rows, agg] = await Promise.all([
      db.many('SELECT id, name, city, vehicle, rating, body, created_at FROM reviews WHERE approved = 1 ORDER BY created_at DESC LIMIT 50'),
      db.one('SELECT ROUND(AVG(rating), 2) AS avg, COUNT(*) AS n FROM reviews WHERE approved = 1'),
    ]);
    return c.json({ reviews: rows, average: Number((agg && agg.avg) || 0), count: Number((agg && agg.n) || 0) });
  });

  app.post('/api/reviews', async (c) => {
    const b = await c.req.json().catch(() => ({}));
    if (!b.name || !b.rating || !b.body) return c.json({ error: 'name, rating and body are required' }, 400);
    const me = await currentUser(c.req.raw, c.env);
    const r = await d1(c.env).run(
      'INSERT INTO reviews (user_id, name, city, vehicle, rating, body) VALUES (?,?,?,?,?,?)',
      me ? me.id : null, b.name, b.city || null, b.vehicle || null,
      Math.max(1, Math.min(5, parseInt(b.rating, 10))), b.body
    );
    return c.json({ id: r.meta.last_row_id, status: 'pending_approval' });
  });

  // ---- wishlist (D1 table added in 0015_storefront.sql) ------------------
  app.get('/api/wishlist', authMw, async (c) => {
    const rows = await d1(c.env).many(
      `SELECT w.product_img, w.created_at,
              p.name, p.make_model, p.category, p.condition,
              p.price_cents / 100.0 AS price_usd, p.stock_count
         FROM wishlist w LEFT JOIN products p ON p.img = w.product_img
        WHERE w.user_id = ? ORDER BY w.created_at DESC`,
      c.get('user').id
    );
    return c.json({ items: rows });
  });

  app.post('/api/wishlist', authMw, async (c) => {
    const img = (await c.req.json().catch(() => ({}))).product_img || '';
    if (!img) return c.json({ error: 'product_img required' }, 400);
    try {
      await d1(c.env).run('INSERT INTO wishlist (user_id, product_img) VALUES (?, ?) ON CONFLICT DO NOTHING', c.get('user').id, img);
    } catch (e) { /* bad img / FK — ignore, matches Postgres ON CONFLICT DO NOTHING intent */ }
    return c.json({ ok: true });
  });

  app.delete('/api/wishlist/:img', authMw, async (c) => {
    await d1(c.env).run('DELETE FROM wishlist WHERE user_id = ? AND product_img = ?', c.get('user').id, c.req.param('img'));
    return c.json({ ok: true });
  });

  // ---- notify-when-back-in-stock --------------------------------------
  app.post('/api/notify', async (c) => {
    const b = await c.req.json().catch(() => ({}));
    if (!b.img || !b.email) return c.json({ error: 'img and email are required' }, 400);
    await d1(c.env).run(
      `INSERT INTO notify_subscriptions (product_img, email, phone) VALUES (?, ?, ?)
         ON CONFLICT(product_img, email) DO UPDATE SET phone = excluded.phone`,
      b.img, b.email, b.phone || null
    );
    return c.json({ ok: true });
  });
}
