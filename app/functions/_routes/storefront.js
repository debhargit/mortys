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
import { sendEmail } from '../_lib/mailer.js';
import { readUploadBody } from '../_lib/uploads.js';
import { safeJson } from '../_lib/util.js';
import { getShopSettings } from '../_lib/shop.js';
import { bestUnitPriceCents, loadBreaksByImg, ACTIVE_SALE_PRICE_SQL, effectiveBaseCents } from '../_lib/price_breaks.js';
import { centsToUsd } from '../_lib/money.js';

// Attach each row's price_breaks (ascending by min_qty, in USD) and its
// active sale price (null when there's no sale or it's outside its window)
// from a pre-fetched img -> breaks Map -- shared by the list and
// single-product endpoints below so both expose pricing the same way.
// price_cents/active_sale_cents ride along on the row purely to compute this
// and are stripped before the row goes out.
function withPricing(row, breaksByImg) {
  const b = breaksByImg.get(row.img) || [];
  row.price_breaks = b.map((x) => ({ min_qty: x.min_qty, price_usd: centsToUsd(x.price_cents) }));
  row.sale_price_usd = row.active_sale_cents != null ? centsToUsd(row.active_sale_cents) : null;
  delete row.price_cents; delete row.active_sale_cents;
  return row;
}

// Who may see prices on the storefront endpoints:
//   * any admin / staff account — ALWAYS (the POS grid uses these endpoints)
//   * a customer with users.show_prices = 1 (per-account B2B override)
//   * everyone, when the global shop_settings.storefront_prices switch is on
// Otherwise prices are stripped and the front-end shows "Call for price" and
// routes checkout to a quote request. See migrations 0027 / 0028.
async function canSeePrices(c) {
  try {
    const u = await currentUser(c.req.raw, c.env);
    if (u && (u.is_admin || u.is_staff || u.show_prices)) return true;
  } catch { /* guest */ }
  try {
    const s = await getShopSettings(c.env);
    return !!(s && s.storefront_prices);
  } catch { return false; }
}

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
  price_cents, price_cents / 100.0 AS price_usd,
  stock_count, low_threshold, sku, NULL AS barcode, bin_location, location,
  CASE WHEN item_type = 'service' THEN 'in'
       WHEN stock_count <= 0 THEN 'out'
       WHEN stock_count <= low_threshold THEN 'low' ELSE 'in' END AS stock_level,
  serial_required, warranty_days, item_type,
  core_charge_cents / 100.0 AS core_charge_usd, env_fee_cents / 100.0 AS env_fee_usd,
  matrix_id, ${ACTIVE_SALE_PRICE_SQL} AS active_sale_cents,
  max_discount_pct, is_redeemable,
  restricted_instore_only, restricted_manager_approval, restricted_id_required, restricted_tax_id_required`;

const COUNT_CAP = 5000;

export default function mount(app) {
  app.get('/api/products', async (c) => {
    try {
      const db = d1(c.env);
      const q = c.req.query();
      const showPrices = await canSeePrices(c);
      // With prices hidden, a price filter or price sort would leak the very
      // numbers we're withholding (binary-search the catalogue by price_max).
      // Drop them for un-approved callers.
      const qEff = showPrices ? q : { ...q, price_min: undefined, price_max: undefined };
      const { where, binds } = productWhere(qEff);
      let sortKey = q.sort;
      if (!showPrices && (sortKey === 'price_asc' || sortKey === 'price_desc')) sortKey = 'name';
      const orderBy = SORTS[sortKey] || SORTS.name;
      // The storefront (?compact=1) streams the whole ~23k-row catalogue in
      // large chunks (shop.html pulls in 4,000s), so it needs a much higher
      // ceiling than the 200 the POS/admin grid ever asks for. Compact rows
      // are tiny positional arrays, so a 5k-row page is still a small response.
      const isCompact = !!q.compact;
      const maxLimit = isCompact ? 5000 : 200;
      const limit = Math.min(maxLimit, Math.max(1, parseInt(q.limit, 10) || (isCompact ? 1000 : 60)));
      const offset = Math.max(0, parseInt(q.offset, 10) || 0);

      const [rows, cnt] = await Promise.all([
        db.many(`SELECT ${LIST_COLS} FROM products WHERE ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
          ...binds, limit, offset),
        // Compact = full-catalogue load: give it the true count (a COUNT(*)
        // over ~23k rows is trivial). Everything else keeps the server.js cap
        // so a huge search shows "5,000+" instead of forcing a full scan.
        isCompact
          ? db.one(`SELECT COUNT(*) AS n FROM products WHERE ${where}`, ...binds)
          : db.one(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM products WHERE ${where} LIMIT ${COUNT_CAP + 1}) t`, ...binds),
      ]);
      const counted = (cnt && cnt.n) || 0;
      const capped = !isCompact && counted > COUNT_CAP;
      const total = Math.max(capped ? COUNT_CAP : counted, offset + rows.length);

      // The storefront (index.html / shop.html) asks with ?compact=1 and reads
      // a positional-array format: { cats, rows:[[img,name,make_model,catIdx,
      // condIdx,price_cents,stock_count,bin], ...] }. price_cents is null when
      // this caller may not see prices, which is what flips a cart into a
      // quote request client-side.
      if (q.compact) {
        const catIndex = {};
        const cats = [];
        const packed = rows.map((r) => {
          const cat = r.category || '';
          if (!(cat in catIndex)) { catIndex[cat] = cats.length; cats.push(cat); }
          const priceCents = showPrices && r.price_usd != null ? Math.round(r.price_usd * 100) : null;
          const condIdx = String(r.condition || '').toUpperCase() === 'USED' ? 1 : 0;
          return [r.img, r.name, r.make_model || '', catIndex[cat], condIdx, priceCents, r.stock_count, r.bin_location || ''];
        });
        return c.json({ cats, rows: packed, total, limit, offset, prices_visible: showPrices });
      }

      let list = showPrices ? rows : rows.map((r) => ({ ...r, price_usd: null }));
      if (showPrices) {
        const breaksByImg = await loadBreaksByImg(db, list.map((r) => r.img));
        list = list.map((r) => withPricing(r, breaksByImg));
      } else {
        list = list.map((r) => { delete r.price_cents; delete r.active_sale_cents; return r; });
      }
      return c.json({ products: list, total, limit, offset, prices_visible: showPrices, approximate: capped, count_mode: capped ? 'capped' : 'exact' });
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
      `SELECT *, price_cents / 100.0 AS price_usd, cost_cents / 100.0 AS cost_usd,
              ${ACTIVE_SALE_PRICE_SQL} AS active_sale_cents
         FROM products WHERE img = ? AND is_active = 1`,
      c.req.param('img')
    );
    if (!row) return c.json({ error: 'Not found' }, 404);
    const showPrices = await canSeePrices(c);
    if (!showPrices) {
      row.price_usd = null; row.price_cents = null;
      row.active_sale_cents = null; row.sale_price_usd = null;
      row.cost_usd = null; row.cost_cents = null;
    } else {
      withPricing(row, await loadBreaksByImg(d1(c.env), [row.img]));
    }
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
    const db = d1(c.env);
    const rows = await db.many(
      `SELECT c.product_img AS img, c.qty, p.name, p.make_model, p.price_cents, p.price_cents / 100.0 AS price_usd, p.condition,
              ${ACTIVE_SALE_PRICE_SQL} AS active_sale_cents
         FROM cart_items c JOIN products p ON p.img = c.product_img
        WHERE c.user_id = ? ORDER BY c.updated_at DESC`,
      c.get('user').id
    );
    const showPrices = await canSeePrices(c);
    let total = null;
    if (showPrices) {
      const breaksByImg = await loadBreaksByImg(db, rows.map((r) => r.img));
      total = 0;
      rows.forEach((r) => {
        const breaks = breaksByImg.get(r.img) || [];
        r.sale_price_usd = r.active_sale_cents != null ? centsToUsd(r.active_sale_cents) : null;
        const baseCents = effectiveBaseCents(r.price_cents, r.active_sale_cents);
        const effCents = bestUnitPriceCents(baseCents, breaks, r.qty);
        r.effective_price_usd = centsToUsd(effCents);
        r.price_breaks = breaks.map((x) => ({ min_qty: x.min_qty, price_usd: centsToUsd(x.price_cents) }));
        delete r.active_sale_cents;
        total += Number(r.effective_price_usd || 0) * r.qty;
        delete r.price_cents;
      });
      total = Math.round(total * 100) / 100;
    } else {
      rows.forEach((r) => { r.price_usd = null; delete r.price_cents; });
    }
    return c.json({ cart: rows, total_usd: total, prices_visible: showPrices });
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
    if (!(await canSeePrices(c))) rows.forEach((r) => { r.price_usd = null; });
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

  // ---- quote request / parts inquiry --------------------------------
  // The storefront's "Request a Quote" (cart checkout) and the free-text
  // "Request a Part" form both post here. A cart request carries `items`
  // (part numbers + quantities) and lands as source='cart' with the line
  // items in items_json, unpriced -- the admin Parts Inquiries editor prices
  // it. Guests allowed; a signed-in shopper is linked via user_id.
  app.post('/api/inquiry', async (c) => {
    const db = d1(c.env);
    let file = null, body = {};
    try { ({ file, body } = await readUploadBody(c, ['photo_part', 'photo_vehicle', 'photo'])); }
    catch { body = await c.req.json().catch(() => ({})); }
    const payload = (body && typeof body.data === 'string') ? safeJson(body.data, {}) : (body || {});

    const name = String(payload.name || '').trim();
    const phone = String(payload.phone || '').trim();
    const email = String(payload.email || '').trim();
    if (!name) return c.json({ error: 'Please enter your name.' }, 400);
    if (!phone && !email) return c.json({ error: 'Add a phone number or email so we can reply.' }, 400);

    const yearNum = parseInt(payload.vehicle_year, 10);
    const vehicle_year = Number.isFinite(yearNum) ? yearNum : null;
    const vehicle_make = String(payload.vehicle_make || '').trim() || null;
    const vehicle_model = String(payload.vehicle_model || '').trim() || null;
    const condition = String(payload.condition || '').trim() || null;
    const notes = String(payload.notes || '').trim();

    const rawItems = Array.isArray(payload.items) ? payload.items : [];
    let source = 'form';
    let itemsJson = null;
    let partDescription = String(payload.part_description || '').trim();

    if (rawItems.length) {
      source = 'cart';
      const imgs = [...new Set(rawItems.map((it) => String(it.img || '').trim()).filter(Boolean))].slice(0, 100);
      const prodRows = imgs.length
        ? await db.many(
            `SELECT img, name, make_model, price_cents FROM products WHERE img IN (${imgs.map(() => '?').join(',')})`, ...imgs)
        : [];
      const prod = Object.fromEntries(prodRows.map((r) => [r.img, r]));
      const items = rawItems.map((it) => {
        const img = String(it.img || '').trim();
        const p = prod[img] || {};
        return {
          img,
          name: p.name || String(it.name || '').trim() || img,
          make_model: p.make_model || String(it.make_model || '').trim() || '',
          qty: Math.min(999, Math.max(1, parseInt(it.qty, 10) || 1)),
          list_price_cents: p.price_cents != null ? p.price_cents : null,
          unit_price_cents: null,
          line_total_cents: null,
        };
      }).filter((it) => it.img);
      if (!items.length) return c.json({ error: 'Your quote request had no valid parts.' }, 400);
      itemsJson = JSON.stringify(items);
      const summary = items.slice(0, 6).map((it) => `${it.qty}x ${it.name}${it.img && it.img !== it.name ? ' (' + it.img + ')' : ''}`).join('; ');
      partDescription = (summary + (items.length > 6 ? `; +${items.length - 6} more` : '') + (notes ? ` -- ${notes}` : '')).slice(0, 800);
    } else {
      if (!partDescription) return c.json({ error: 'Tell us which part you need.' }, 400);
      if (notes) partDescription = (partDescription + ' -- ' + notes).slice(0, 800);
    }

    let photoData = null, photoType = null;
    if (file && typeof file.arrayBuffer === 'function') {
      const buf = new Uint8Array(await file.arrayBuffer());
      if (buf.byteLength > 0 && buf.byteLength <= 2 * 1024 * 1024) {
        photoData = buf;
        photoType = file.type || 'image/jpeg';
      }
    }

    let userId = null;
    try { const u = await currentUser(c.req.raw, c.env); if (u) userId = u.id; } catch { /* guest */ }

    const res = await db.run(
      `INSERT INTO parts_inquiries
         (user_id, name, phone, email, vehicle_make, vehicle_model, vehicle_year, condition,
          part_description, items_json, source, status, photo_data, photo_type)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,'new',?,?)`,
      userId, name, phone || '', email || null, vehicle_make, vehicle_model, vehicle_year, condition,
      partDescription, itemsJson, source, photoData, photoType
    );
    const id = res.meta.last_row_id;

    // Tell the counter, and confirm to the customer if we have their email.
    const notifyTo = c.env.ORDER_NOTIFY_TO;
    if (notifyTo) {
      c.executionCtx?.waitUntil?.(sendEmail(c.env, {
        to: notifyTo,
        subject: `New quote request #${id}${source === 'cart' ? ' (cart)' : ''}`,
        text: `${name} <${email || 'no email'}> ${phone || ''}\n\n${partDescription}\n\nOpen Admin -> Parts Inquiries.`,
      }).catch(() => {}));
    }
    if (email) {
      c.executionCtx?.waitUntil?.(sendEmail(c.env, {
        to: email,
        subject: `We got your quote request #${id}`,
        text: `Hi ${name},\n\nThanks -- our parts desk is checking availability and pricing and will get back to you.\n\nYour request:\n${partDescription}\n\n-- Morty's Auto Parts`,
      }).catch(() => {}));
    }

    return c.json({ ok: true, id, status: 'new' });
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
