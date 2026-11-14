// =============================================================================
//  Morty's Auto Parts -- Add part photos (staff photo capture)
//
//  A phone-friendly screen for staff to snap a photo of a part and have it show
//  on the web shop at once.
//
//  * Arrange the parts still needing a photo by category, by bin, by supplier
//    or by best selling (sales in the last 12 months), and open one group.
//  * A manager (cap catalog.photos.assign) picks a group, or ticks parts, and
//    assigns them to a staff member with an optional due date. The person is
//    told under the bell and, when the day plan is installed, the job goes on
//    their day plan. Progress (photos done of the job) is tracked live; the job
//    closes itself when every part has a photo and the manager is told.
//  * Each photo is saved under the part's own item code (sku, else img), e.g.
//    /uploads/products/MD620738.jpg; a retake becomes MD620738-2.jpg so phones
//    and the shop never show a cached old picture.
//  * Scan a part's barcode / QR (or type it with a USB scanner) to jump to it;
//    scan a bin label to list that bin's parts.
//
//  Mounted in server.js:
//    require('./staff-photos').register(app, { query, requireAdmin, requireCap, userCan, upload, notice })
//  Page: staff-photos.html (also a tile in the mobile app). Caps: catalog.photos
//  (open to staff by default), catalog.photos.assign (restricted).
//  Tables (schema.sql): photo_assignments, photo_assignment_items, product_photo_log.
//  No DDL runs here.
// =============================================================================
'use strict';

const path = require('path');
const fs = require('fs');

const BYS = ['best', 'category', 'bin', 'supplier'];
const TIERS = [
  { key: 'top50', label: 'Top 50 sellers', lo: 1, hi: 50 },
  { key: 'top200', label: 'Sellers 51 to 200', lo: 51, hi: 200 },
  { key: 'top500', label: 'Sellers 201 to 500', lo: 201, hi: 500 },
  { key: 'other', label: 'Other sellers', lo: 501, hi: null },
  { key: 'none', label: 'No sales in 12 months', lo: null, hi: null },
];

function parseScan(raw) {
  const s = String(raw || '').trim();
  const m = /^(BIN|ITEM|SKU|BATCH):(.+)$/i.exec(s);
  if (m) return { prefix: m[1].toUpperCase(), code: m[2].trim() };
  return { prefix: null, code: s };
}

// The part's own item code as a safe file name.
function codeFileBase(code) {
  const s = String(code || '').trim().replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._-]+/, '').replace(/[._]+$/, '').slice(0, 80);
  return s || 'part';
}

function register(app, deps) {
  const { query, requireAdmin, requireCap, upload } = deps;
  const userCan = deps.userCan || (async () => false);
  const notice = deps.notice || (async () => {});
  const can = (k) => [requireAdmin, requireCap(k)];
  const PRODUCTS_DIR = deps.productsDir || path.join(__dirname, 'uploads', 'products');
  const me = (req) => Number(req.session && req.session.userId) || null;
  function httpError(status, msg) { const e = new Error(msg); e.status = status; return e; }
  function fail(res, e) {
    if (e && e.status) return res.status(e.status).json({ error: e.message });
    console.error('[staff-photos]', e); res.status(500).json({ error: 'Something went wrong' });
  }
  const canAssign = (req) => userCan(req, 'catalog.photos.assign');
  let dayplanOk = null;   // is the day plan installed? (checked once, on first use)
  async function hasDayplan() {
    if (dayplanOk === null) {
      try { dayplanOk = !!(await query(`SELECT to_regclass('public.dayplan_activities') AS t`)).rows[0].t; } catch (_) { dayplanOk = false; }
    }
    return dayplanOk;
  }

  // ---------------------------------------------------------------- base --
  // Every active part, with the things we arrange by. In-stock parts only
  // unless `all` (an assignment can still list a part that sold out since).
  // Bin = the primary bin, else the bin holding most; supplier = the part's
  // supplier, else the supplier of its latest purchase order.
  const BASE = (where) => `
    WITH sold AS (
      SELECT i.product_img, SUM(i.qty) AS sold
        FROM pos_sale_items i JOIN pos_sales ps ON ps.id = i.sale_id
       WHERE ps.created_at >= NOW() - INTERVAL '365 days' AND NOT COALESCE(ps.voided, false)
       GROUP BY i.product_img),
    binpick AS (
      SELECT DISTINCT ON (x.product_img) x.product_img, b.code, b.pick_sequence
        FROM stock_by_bin x JOIN bins b ON b.id = x.bin_id
       WHERE x.qty > 0 AND b.kind <> 'unassigned'
       ORDER BY x.product_img, x.qty DESC, b.code),
    posup AS (
      SELECT DISTINCT ON (i.product_img) i.product_img, po.supplier_id
        FROM purchase_order_items i JOIN purchase_orders po ON po.id = i.po_id
       WHERE po.supplier_id IS NOT NULL AND i.product_img IS NOT NULL
       ORDER BY i.product_img, po.created_at DESC NULLS LAST, po.id DESC),
    base AS (
      SELECT p.img, p.name, p.sku, p.barcode, p.make_model, p.category, p.stock_count, p.photo_url,
             (p.photo_url IS NOT NULL AND p.photo_url <> '') AS has_photo,
             COALESCE(s.sold, 0)::int AS sold_12m,
             COALESCE(NULLIF(btrim(p.category), ''), 'No category') AS g_category,
             COALESCE(wh_norm_bin(p.bin_location), upper(bp.code), 'No bin') AS g_bin,
             COALESCE(su.name, 'No supplier') AS g_supplier,
             CASE WHEN COALESCE(s.sold, 0) <= 0 THEN NULL
                  ELSE ROW_NUMBER() OVER (ORDER BY COALESCE(s.sold, 0) DESC, p.stock_count DESC, p.name, p.img) END AS sell_rank
        FROM products p
        LEFT JOIN sold s ON s.product_img = p.img
        LEFT JOIN binpick bp ON bp.product_img = p.img
        LEFT JOIN posup ps2 ON ps2.product_img = p.img
        LEFT JOIN suppliers su ON su.id = COALESCE(p.supplier_id, ps2.supplier_id)
       WHERE ${where}),
    b2 AS (
      SELECT base.*,
             CASE WHEN sell_rank IS NULL THEN 'none' WHEN sell_rank <= 50 THEN 'top50' WHEN sell_rank <= 200 THEN 'top200'
                  WHEN sell_rank <= 500 THEN 'top500' ELSE 'other' END AS g_best,
             oa.id AS assignment_id, oa.assigned_to, ou.name AS assigned_to_name
        FROM base
        LEFT JOIN LATERAL (
          SELECT a.id, a.assigned_to FROM photo_assignment_items it JOIN photo_assignments a ON a.id = it.assignment_id
           WHERE it.product_img = base.img AND a.status = 'open' ORDER BY a.id DESC LIMIT 1) oa ON true
        LEFT JOIN users ou ON ou.id = oa.assigned_to)`;
  const IN_STOCK = `p.is_active AND p.stock_count > 0`;
  const groupCol = (by) => ({ best: 'g_best', category: 'g_category', bin: 'g_bin', supplier: 'g_supplier' }[by]);
  const tierLabel = (k) => (TIERS.find((t) => t.key === k) || {}).label || k;

  // ---------------------------------------------------------------- config --
  app.get('/api/staff-photos/config', ...can('catalog.photos'), async (req, res) => {
    try {
      const assign = await canAssign(req);
      let staff = [];
      if (assign) {
        staff = (await query(`SELECT id, COALESCE(NULLIF(name, ''), email) AS name FROM users
                               WHERE is_admin AND NOT COALESCE(disabled, false) ORDER BY 2`)).rows;
      }
      res.json({ me: me(req), can_assign: assign, staff, dayplan: await hasDayplan(), tiers: TIERS.map((t) => ({ key: t.key, label: t.label })) });
    } catch (e) { fail(res, e); }
  });

  // ---------------------------------------------------------------- stats --
  app.get('/api/staff-photos/stats', ...can('catalog.photos'), async (_req, res) => {
    try {
      const { rows } = await query(
        `SELECT COUNT(*) FILTER (WHERE is_active AND stock_count > 0)::int AS in_stock,
                COUNT(*) FILTER (WHERE is_active AND stock_count > 0 AND photo_url IS NOT NULL AND photo_url <> '')::int AS with_photo
           FROM products`);
      const r = rows[0] || { in_stock: 0, with_photo: 0 };
      const t = (await query(`SELECT COUNT(*)::int AS n FROM product_photo_log WHERE action = 'add' AND at >= date_trunc('day', NOW())`)).rows[0];
      res.json({ in_stock: r.in_stock, with_photo: r.with_photo, remaining: Math.max(0, r.in_stock - r.with_photo), today: t.n });
    } catch (e) { fail(res, e); }
  });

  // ---------------------------------------------------------------- groups --
  // The groups for one arrangement, with how many parts still need a photo,
  // how many of those are already given to someone, and how many in total.
  app.get('/api/staff-photos/groups', ...can('catalog.photos'), async (req, res) => {
    try {
      const by = BYS.includes(req.query.by) ? req.query.by : 'best';
      const col = groupCol(by);
      const { rows } = await query(
        `${BASE(IN_STOCK)}
         SELECT ${col} AS key, COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE NOT has_photo)::int AS needed,
                COUNT(*) FILTER (WHERE NOT has_photo AND assignment_id IS NOT NULL)::int AS assigned,
                COALESCE(SUM(sold_12m) FILTER (WHERE NOT has_photo), 0)::int AS sold_needed
           FROM b2 GROUP BY 1`);
      let groups = rows.map((r) => ({ key: r.key, label: by === 'best' ? tierLabel(r.key) : r.key, total: r.total, needed: r.needed, assigned: r.assigned, unassigned: r.needed - r.assigned, sold_needed: r.sold_needed }));
      const lastNo = (g) => /^No /.test(g.key) ? 1 : 0;
      if (by === 'best') groups.sort((a, b) => TIERS.findIndex((t) => t.key === a.key) - TIERS.findIndex((t) => t.key === b.key));
      else if (req.query.sort === 'needed') groups.sort((a, b) => lastNo(a) - lastNo(b) || b.needed - a.needed || a.label.localeCompare(b.label));
      else groups.sort((a, b) => lastNo(a) - lastNo(b) || a.label.localeCompare(b.label, undefined, { numeric: true }));
      if (req.query.only_needed !== '0') groups = groups.filter((g) => g.needed > 0);
      res.json({ by, groups });
    } catch (e) { fail(res, e); }
  });

  // ---------------------------------------------------------------- queue --
  // Parts in a group / a search / a job / my jobs, best sellers first.
  //   by + group, q, assignment=<id>, mine=1, status=needed|done|all, limit, offset
  async function selectParts(req, opts = {}) {
    const qy = Object.assign({}, req.query, opts);
    const by = BYS.includes(qy.by) ? qy.by : null;
    const params = [];
    const where = [];
    const assignment = parseInt(qy.assignment, 10) || null;
    const mine = qy.mine === '1' || qy.mine === true;
    const status = ['needed', 'done', 'all'].includes(qy.status) ? qy.status : (assignment ? 'all' : 'needed');
    if (by && qy.group != null && qy.group !== '') { params.push(String(qy.group)); where.push(`${groupCol(by)} = $${params.length}`); }
    const term = String(qy.q || '').trim();
    if (term) {
      params.push('%' + term.toLowerCase() + '%');
      where.push(`lower(name || ' ' || COALESCE(sku,'') || ' ' || COALESCE(barcode,'') || ' ' || COALESCE(make_model,'') || ' ' || img) LIKE $${params.length}`);
    }
    if (assignment) { params.push(assignment); where.push(`img IN (SELECT product_img FROM photo_assignment_items WHERE assignment_id = $${params.length})`); }
    if (mine) { params.push(me(req)); where.push(`assigned_to = $${params.length}`); }
    if (Array.isArray(qy.imgs)) { params.push(qy.imgs.map(String)); where.push(`img = ANY($${params.length}::text[])`); }
    if (status === 'needed') where.push('NOT has_photo');
    if (status === 'done') where.push('has_photo');
    if (qy.unassigned) where.push('assignment_id IS NULL');
    // A job keeps listing a part that has since sold out; everything else is in-stock parts.
    const baseWhere = assignment || Array.isArray(qy.imgs) ? 'p.is_active' : IN_STOCK;
    const limit = Math.min(qy.max || 200, Math.max(1, parseInt(qy.limit, 10) || 60));
    const offset = Math.max(0, parseInt(qy.offset, 10) || 0);
    params.push(limit, offset);
    const order = by === 'bin' ? 'g_bin, has_photo, sold_12m DESC, name' : 'has_photo, sold_12m DESC, stock_count DESC, name';
    const { rows } = await query(
      `${BASE(baseWhere)}
       SELECT img, name, sku, barcode, make_model, category, stock_count, photo_url, has_photo, sold_12m, sell_rank::int,
              g_category AS category_group, g_bin AS bin, g_supplier AS supplier, g_best AS best_tier,
              assignment_id, assigned_to, assigned_to_name
         FROM b2 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY ${order}, img
        LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    return rows;
  }
  app.get('/api/staff-photos/queue', ...can('catalog.photos'), async (req, res) => {
    try { res.json({ parts: await selectParts(req) }); } catch (e) { fail(res, e); }
  });

  // ---------------------------------------------------------------- scan --
  // A part's barcode / QR / item code, or a bin label.
  app.get('/api/staff-photos/lookup', ...can('catalog.photos'), async (req, res) => {
    try {
      const { prefix, code } = parseScan(req.query.code);
      if (!code) throw httpError(400, 'Nothing scanned');
      if (prefix !== 'BIN') {
        const { rows } = await query(
          `SELECT img FROM products
            WHERE upper(sku) = upper($1) OR upper(barcode) = upper($1) OR img = $1 OR upper(supplier_part_no) = upper($1)
            ORDER BY (upper(sku) = upper($1)) DESC, (upper(barcode) = upper($1)) DESC, is_active DESC LIMIT 1`, [code]);
        if (rows.length) {
          const parts = await selectParts(req, { imgs: [rows[0].img], status: 'all', by: null, group: null, q: '', mine: false, assignment: null, limit: 1, offset: 0 });
          if (parts.length) return res.json({ type: 'product', part: parts[0] });
        }
      }
      if (prefix !== 'ITEM' && prefix !== 'SKU') {
        const b = (await query(`SELECT code FROM bins WHERE upper(code) = upper($1)`, [code])).rows[0];
        const bin = b ? b.code.toUpperCase() : (await query(`SELECT wh_norm_bin($1) AS c FROM products WHERE wh_norm_bin(bin_location) = wh_norm_bin($1) LIMIT 1`, [code])).rows.map((r) => r.c)[0];
        if (bin) return res.json({ type: 'bin', bin });
      }
      res.status(404).json({ error: 'No part or bin matches "' + code + '"' });
    } catch (e) { fail(res, e); }
  });

  // ---------------------------------------------------------------- upload --
  // Save a snapped or chosen photo onto a part, named by its item code.
  async function freeName(code, ext) {
    const base = codeFileBase(code);
    fs.mkdirSync(PRODUCTS_DIR, { recursive: true });
    for (let i = 1; i < 1000; i++) {
      const name = base + (i === 1 ? '' : '-' + i) + ext;
      if (!fs.existsSync(path.join(PRODUCTS_DIR, name))) return name;
    }
    return base + '-' + Date.now() + ext;
  }
  function moveFile(from, to) {
    try { fs.renameSync(from, to); } catch (_) { fs.copyFileSync(from, to); try { fs.unlinkSync(from); } catch (__) {} }
  }

  // After a photo goes on (or comes off) a part: tick it on its jobs, close a
  // job whose every part now has a photo, reopen one that lost a photo.
  async function settleJobs(img, userId) {
    if (userId) {
      await query(`UPDATE photo_assignment_items it SET photo_at = NOW(), photo_by = $2
                     FROM photo_assignments a WHERE a.id = it.assignment_id AND a.status = 'open' AND it.product_img = $1`, [img, userId]);
    }
    const { rows } = await query(
      `SELECT a.id FROM photo_assignments a
        WHERE a.status IN ('open', 'done') AND EXISTS (SELECT 1 FROM photo_assignment_items it WHERE it.assignment_id = a.id AND it.product_img = $1)`, [img]);
    for (const r of rows) await refreshJob(r.id);
  }
  async function refreshJob(id) {
    const { rows } = await query(
      `SELECT a.id, a.status, a.title, a.assigned_to, a.assigned_by, a.dayplan_activity_id, u.name AS assigned_to_name,
              COUNT(it.product_img)::int AS total,
              COUNT(it.product_img) FILTER (WHERE p.photo_url IS NOT NULL AND p.photo_url <> '')::int AS done
         FROM photo_assignments a
         LEFT JOIN users u ON u.id = a.assigned_to
         LEFT JOIN photo_assignment_items it ON it.assignment_id = a.id
         LEFT JOIN products p ON p.img = it.product_img
        WHERE a.id = $1 GROUP BY a.id, u.name`, [id]);
    const a = rows[0];
    if (!a) return;
    if (a.status === 'open' && a.total > 0 && a.done >= a.total) {
      const upd = await query(`UPDATE photo_assignments SET status = 'done', completed_at = NOW() WHERE id = $1 AND status = 'open' RETURNING id`, [id]);
      if (!upd.rows.length) return;
      if (a.dayplan_activity_id && await hasDayplan()) {
        await query(`UPDATE dayplan_activities SET status = 'done', actual_end = COALESCE(actual_end, NOW()), result = COALESCE(result, 'All photos taken'), updated_at = NOW()
                      WHERE id = $1 AND status IN ('planned', 'in_progress')`, [a.dayplan_activity_id]).catch(() => {});
      }
      const tell = [a.assigned_by].filter((u) => u && u !== a.assigned_to);
      if (tell.length) await notice(tell, { kind: 'photos', title: 'Photos done: ' + a.title, body: (a.assigned_to_name || 'Staff') + ' finished all ' + a.total + ' part photos.', link: '/staff-photos.html#jobs' }).catch(() => {});
    } else if (a.status === 'done' && a.done < a.total) {
      await query(`UPDATE photo_assignments SET status = 'open', completed_at = NULL WHERE id = $1`, [id]);
    }
  }

  app.post('/api/staff-photos/upload', ...can('catalog.photos'), upload.single('photo'), async (req, res) => {
    try {
      const productImg = (req.body && req.body.product_img) || '';
      if (!productImg) { if (req.file) try { fs.unlinkSync(req.file.path); } catch (_) {} return res.status(400).json({ error: 'Which part is this?' }); }
      if (!req.file) return res.status(400).json({ error: 'No photo received' });
      const found = await query(`SELECT img, sku, photo_url FROM products WHERE img = $1`, [productImg]);
      if (!found.rows.length) { try { fs.unlinkSync(req.file.path); } catch (_) {} return res.status(404).json({ error: 'Part not found' }); }
      const p = found.rows[0];
      let ext = (path.extname(req.file.filename || req.file.originalname || '').toLowerCase() || '.jpg').slice(0, 6);
      if (!/^\.(jpe?g|png|webp|heic|heif|gif)$/.test(ext)) ext = '.jpg';
      const name = await freeName(p.sku || p.img, ext);
      moveFile(req.file.path, path.join(PRODUCTS_DIR, name));
      const photoUrl = '/uploads/products/' + name;
      await query(`UPDATE products SET photo_url = $1 WHERE img = $2`, [photoUrl, productImg]);
      const job = parseInt(req.body.assignment_id, 10) || null;
      await query(`INSERT INTO product_photo_log (product_img, photo_url, previous_url, user_id, assignment_id, action) VALUES ($1, $2, $3, $4, $5, $6)`,
        [productImg, photoUrl, p.photo_url || null, me(req), job, p.photo_url ? 'replace' : 'add']);
      await settleJobs(productImg, me(req));
      res.json({ ok: true, photo_url: photoUrl, file_name: name });
    } catch (e) { if (req.file) try { fs.unlinkSync(req.file.path); } catch (_) {} fail(res, e); }
  });

  // Remove a photo (e.g. the wrong one went on). Blanks photo_url; the part
  // comes back to the queue. The file stays on disk.
  app.post('/api/staff-photos/clear', ...can('catalog.photos'), async (req, res) => {
    try {
      const productImg = (req.body && req.body.product_img) || '';
      if (!productImg) return res.status(400).json({ error: 'Which part?' });
      const prev = (await query(`SELECT photo_url FROM products WHERE img = $1`, [productImg])).rows[0];
      if (!prev) return res.status(404).json({ error: 'Part not found' });
      await query(`UPDATE products SET photo_url = NULL WHERE img = $1`, [productImg]);
      await query(`UPDATE photo_assignment_items SET photo_at = NULL, photo_by = NULL WHERE product_img = $1`, [productImg]);
      if (prev.photo_url) await query(`INSERT INTO product_photo_log (product_img, photo_url, previous_url, user_id, action) VALUES ($1, NULL, $2, $3, 'clear')`, [productImg, prev.photo_url, me(req)]);
      await settleJobs(productImg, null);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // Give the photos already on the shop their item-code names too. Copies each
  // file to <item code>.<ext> and points the part at the copy; the old file
  // stays, so nothing that links to it breaks.
  app.post('/api/staff-photos/rename-existing', ...can('catalog.photos.assign'), async (req, res) => {
    try {
      const { rows } = await query(`SELECT img, sku, photo_url FROM products WHERE photo_url LIKE '/uploads/products/%' ORDER BY img`);
      let renamed = 0, skipped = 0, missing = 0;
      for (const p of rows) {
        const file = p.photo_url.slice('/uploads/products/'.length);
        if (file.includes('/') || file.includes('\\') || file.includes('..')) { skipped++; continue; }
        const base = codeFileBase(p.sku || p.img);
        const cur = path.basename(file, path.extname(file));
        if (cur.toLowerCase() === base.toLowerCase() || new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-\\d+$', 'i').test(cur)) { skipped++; continue; }
        const src = path.join(PRODUCTS_DIR, file);
        if (!fs.existsSync(src)) { missing++; continue; }
        const name = await freeName(p.sku || p.img, (path.extname(file).toLowerCase() || '.jpg').slice(0, 6));
        fs.copyFileSync(src, path.join(PRODUCTS_DIR, name));
        const url = '/uploads/products/' + name;
        await query(`UPDATE products SET photo_url = $1 WHERE img = $2 AND photo_url = $3`, [url, p.img, p.photo_url]);
        await query(`INSERT INTO product_photo_log (product_img, photo_url, previous_url, user_id, action) VALUES ($1, $2, $3, $4, 'rename')`, [p.img, url, p.photo_url, me(req)]);
        renamed++;
      }
      res.json({ ok: true, renamed, already_named: skipped, file_missing: missing });
    } catch (e) { fail(res, e); }
  });

  // ---------------------------------------------------------------- jobs --
  const JOB_SQL = (where) => `
    SELECT a.id, a.title, a.group_kind, a.group_value, a.assigned_to, u.name AS assigned_to_name,
           a.assigned_by, ub.name AS assigned_by_name, to_char(a.due_date, 'YYYY-MM-DD') AS due_date, a.note, a.status,
           a.created_at, a.completed_at, a.dayplan_activity_id,
           COUNT(it.product_img)::int AS total,
           COUNT(it.product_img) FILTER (WHERE p.photo_url IS NOT NULL AND p.photo_url <> '')::int AS done,
           COUNT(it.product_img) FILTER (WHERE it.photo_by = a.assigned_to)::int AS done_by_them,
           MAX(it.photo_at) AS last_photo_at,
           (a.status = 'open' AND a.due_date IS NOT NULL AND a.due_date < (NOW() AT TIME ZONE 'America/Jamaica')::date) AS overdue
      FROM photo_assignments a
      LEFT JOIN users u ON u.id = a.assigned_to
      LEFT JOIN users ub ON ub.id = a.assigned_by
      LEFT JOIN photo_assignment_items it ON it.assignment_id = a.id
      LEFT JOIN products p ON p.img = it.product_img
     WHERE ${where}
     GROUP BY a.id, u.name, ub.name`;

  // Jobs (everyone's for a manager, own for staff) and photos per person.
  app.get('/api/staff-photos/assignments', ...can('catalog.photos'), async (req, res) => {
    try {
      const assign = await canAssign(req);
      const status = ['open', 'done', 'cancelled', 'all'].includes(req.query.status) ? req.query.status : 'open';
      const params = [];
      const where = [];
      if (status !== 'all') { params.push(status); where.push(`a.status = $${params.length}`); }
      if (!assign || req.query.mine === '1') { params.push(me(req)); where.push(`a.assigned_to = $${params.length}`); }
      else if (parseInt(req.query.user_id, 10)) { params.push(parseInt(req.query.user_id, 10)); where.push(`a.assigned_to = $${params.length}`); }
      if (status === 'done' || status === 'all') where.push(`(a.status = 'open' OR COALESCE(a.completed_at, a.created_at) > NOW() - INTERVAL '60 days')`);
      // Close any job that got its last photo another way (product editor, import).
      const open = await query(`SELECT a.id FROM photo_assignments a WHERE a.status = 'open'
          AND NOT EXISTS (SELECT 1 FROM photo_assignment_items it JOIN products p ON p.img = it.product_img
                           WHERE it.assignment_id = a.id AND (p.photo_url IS NULL OR p.photo_url = ''))
          AND EXISTS (SELECT 1 FROM photo_assignment_items it WHERE it.assignment_id = a.id)`);
      for (const r of open.rows) await refreshJob(r.id);
      const { rows } = await query(`${JOB_SQL(where.length ? where.join(' AND ') : 'true')}
        ORDER BY (a.status = 'open') DESC, a.due_date NULLS LAST, a.id DESC LIMIT 300`, params);
      for (const r of rows) r.pct = r.total ? Math.round((100 * r.done) / r.total) : 0;
      let people = [];
      if (assign) {
        const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 7));
        people = (await query(
          `WITH ph AS (
             SELECT user_id, COUNT(*) FILTER (WHERE at >= date_trunc('day', NOW()))::int AS today,
                    COUNT(*)::int AS period, MAX(at) AS last_at
               FROM product_photo_log WHERE action IN ('add', 'replace') AND at >= NOW() - ($1 || ' days')::interval AND user_id IS NOT NULL GROUP BY user_id),
           jb AS (
             SELECT a.assigned_to AS user_id, COUNT(DISTINCT a.id)::int AS open_jobs,
                    COUNT(it.product_img) FILTER (WHERE p.photo_url IS NULL OR p.photo_url = '')::int AS left_to_do
               FROM photo_assignments a JOIN photo_assignment_items it ON it.assignment_id = a.id LEFT JOIN products p ON p.img = it.product_img
              WHERE a.status = 'open' GROUP BY a.assigned_to)
           SELECT u.id AS user_id, COALESCE(NULLIF(u.name, ''), u.email) AS name, COALESCE(ph.today, 0) AS today, COALESCE(ph.period, 0) AS period,
                  ph.last_at, COALESCE(jb.open_jobs, 0) AS open_jobs, COALESCE(jb.left_to_do, 0) AS left_to_do
             FROM users u LEFT JOIN ph ON ph.user_id = u.id LEFT JOIN jb ON jb.user_id = u.id
            WHERE ph.user_id IS NOT NULL OR jb.user_id IS NOT NULL
            ORDER BY COALESCE(ph.period, 0) DESC, 2`, [String(days)])).rows;
      }
      res.json({ jobs: rows, people, can_assign: assign });
    } catch (e) { fail(res, e); }
  });

  // Give a group (or ticked parts) to someone.
  //   { by, group } or { imgs: [...] } or { q }, user_id, due_date, note, max, dayplan
  // Parts already on someone's open job are left where they are.
  app.post('/api/staff-photos/assignments', ...can('catalog.photos.assign'), async (req, res) => {
    try {
      const b = req.body || {};
      const userId = parseInt(b.user_id, 10);
      const who = userId ? (await query(`SELECT id, COALESCE(NULLIF(name, ''), email) AS name FROM users WHERE id = $1 AND is_admin AND NOT COALESCE(disabled, false)`, [userId])).rows[0] : null;
      if (!who) throw httpError(400, 'Choose who will take the photos');
      const due = b.due_date ? String(b.due_date) : null;
      if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw httpError(400, 'Due date should look like 2026-11-09');
      const max = Math.min(2000, Math.max(1, parseInt(b.max, 10) || 2000));
      const by = BYS.includes(b.by) ? b.by : null;
      const imgs = Array.isArray(b.imgs) ? b.imgs.map(String).filter(Boolean).slice(0, 2000) : null;
      if (!imgs && !(by && b.group != null && b.group !== '') && !String(b.q || '').trim()) throw httpError(400, 'Choose a group or tick some parts');
      const fake = { query: {}, session: req.session };
      const sel = await selectParts(fake, { by: imgs ? null : by, group: imgs ? null : b.group, q: imgs ? '' : (b.q || ''), imgs: imgs || undefined, status: 'needed', limit: max, max, offset: 0 });
      const wanted = sel.filter((p) => !p.assignment_id);
      const skipped = sel.length - wanted.length;
      if (!wanted.length) throw httpError(400, sel.length ? 'Those parts are already on someone\'s photo job' : 'Every part there already has a photo');
      let title = String(b.title || '').trim().slice(0, 120);
      if (!title) {
        if (imgs) title = wanted.length === 1 ? 'Photo: ' + wanted[0].name : 'Picked parts (' + wanted.length + ')';
        else if (by === 'best') title = tierLabel(b.group);
        else if (by) title = { category: 'Category', bin: 'Bin', supplier: 'Supplier' }[by] + ': ' + b.group;
        else title = 'Search: ' + String(b.q).trim().slice(0, 60);
      }
      const ins = await query(
        `INSERT INTO photo_assignments (title, group_kind, group_value, assigned_to, assigned_by, due_date, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [title, imgs ? 'picked' : (by || 'search'), imgs ? null : String(by ? b.group : b.q).slice(0, 200), who.id, me(req), due, b.note ? String(b.note).slice(0, 500) : null]);
      const id = ins.rows[0].id;
      await query(`INSERT INTO photo_assignment_items (assignment_id, product_img) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`, [id, wanted.map((p) => p.img)]);
      let activityId = null;
      if (b.dayplan !== false && await hasDayplan()) {
        try {
          const day = due || (await query(`SELECT to_char((NOW() AT TIME ZONE 'America/Jamaica')::date, 'YYYY-MM-DD') AS d`)).rows[0].d;
          const a = await query(`INSERT INTO dayplan_activities (user_id, day, title, category, notes, source, created_by)
                                 VALUES ($1, $2, $3, 'stock', $4, 'system', $5) RETURNING id`,
            [who.id, day, 'Part photos: ' + title + ' (' + wanted.length + ')', 'Open Add part photos > My jobs.' + (b.note ? ' ' + String(b.note).slice(0, 300) : ''), me(req)]);
          activityId = a.rows[0].id;
          await query(`UPDATE photo_assignments SET dayplan_activity_id = $2 WHERE id = $1`, [id, activityId]);
        } catch (e) { console.warn('[staff-photos] day plan activity not added:', e.message); }
      }
      if (who.id !== me(req)) {
        await notice([who.id], { kind: 'photos', title: 'Part photos for you: ' + title, body: wanted.length + ' part' + (wanted.length === 1 ? '' : 's') + ' to photograph' + (due ? ', by ' + due : '') + (b.note ? '. ' + String(b.note).slice(0, 200) : ''), link: '/staff-photos.html#job=' + id }).catch(() => {});
      }
      res.json({ ok: true, id, title, parts: wanted.length, skipped_already_assigned: skipped, dayplan_activity_id: activityId });
    } catch (e) { fail(res, e); }
  });

  // Hand a job to someone else, change its due date or note, or cancel it.
  app.post('/api/staff-photos/assignments/:id', ...can('catalog.photos.assign'), async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const b = req.body || {};
      const a = (await query(`SELECT * FROM photo_assignments WHERE id = $1`, [id])).rows[0];
      if (!a) throw httpError(404, 'No such job');
      if (b.action === 'cancel') {
        await query(`UPDATE photo_assignments SET status = 'cancelled', completed_at = NOW() WHERE id = $1 AND status = 'open'`, [id]);
        if (a.dayplan_activity_id && await hasDayplan()) await query(`UPDATE dayplan_activities SET status = 'skipped', result = 'Photo job cancelled', updated_at = NOW() WHERE id = $1 AND status IN ('planned', 'in_progress')`, [a.dayplan_activity_id]).catch(() => {});
        return res.json({ ok: true });
      }
      if (a.status !== 'open') throw httpError(400, 'That job is closed');
      if (b.due_date !== undefined && b.due_date && !/^\d{4}-\d{2}-\d{2}$/.test(String(b.due_date))) throw httpError(400, 'Due date should look like 2026-11-09');
      let to = a.assigned_to;
      if (b.user_id !== undefined) {
        const u = (await query(`SELECT id FROM users WHERE id = $1 AND is_admin AND NOT COALESCE(disabled, false)`, [parseInt(b.user_id, 10) || 0])).rows[0];
        if (!u) throw httpError(400, 'Choose who will take the photos');
        to = u.id;
      }
      await query(`UPDATE photo_assignments SET assigned_to = $2, due_date = $3, note = $4 WHERE id = $1`,
        [id, to, b.due_date !== undefined ? (b.due_date || null) : a.due_date, b.note !== undefined ? (String(b.note || '').slice(0, 500) || null) : a.note]);
      if (a.dayplan_activity_id && await hasDayplan()) {
        await query(`UPDATE dayplan_activities SET user_id = $2, day = COALESCE($3::date, day), updated_at = NOW() WHERE id = $1 AND status IN ('planned', 'in_progress')`,
          [a.dayplan_activity_id, to, b.due_date || null]).catch(() => {});
      }
      if (to !== a.assigned_to && to !== me(req)) {
        await notice([to], { kind: 'photos', title: 'Part photos for you: ' + a.title, body: 'A photo job was handed to you.', link: '/staff-photos.html#job=' + id }).catch(() => {});
      }
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  return { refreshJob };
}

module.exports = { register, codeFileBase, parseScan };
