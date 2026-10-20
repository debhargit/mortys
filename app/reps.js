// =============================================================================
//  Vision Auto Solutions -- Freelance reps, send-a-link, referrals (Phase 8.4)
//
//  Mounted by server.js:  const reps = require('./reps').register(app, deps)
//  Staff routes /api/reps (cap reps.manage) and /api/links (cap links.send);
//  rep portal routes /api/rep/* (a signed-in rep); public /l/<token>,
//  /r/<code>, /api/public/q/<token>.
//
//  Reps: a staff login with role 'rep' -- no admin panel -- tied to a rep
//  record (mechanics). A manager adds them and sends a one-time invite link;
//  the rep sets a password and 2-step sign-in there (it is then always
//  required). In the portal (rep.html) a rep sees prices and stock but never
//  cost, works only with their own customers, makes quotes and orders (which
//  go to the shop's cashier queue and wait N days for payment), sends tracked
//  links and sees their sales and commission.
//
//  Links: /l/<token> counts the open and goes to a part search, a quote the
//  customer can accept (which places the order), a page of this site, or an
//  allowed video site. Links expire. Referral: /r/<code> marks the visitor
//  as the rep's, and a customer who then signs up becomes the rep's customer.
// =============================================================================
'use strict';

const crypto = require('crypto');
const TZ = 'America/Jamaica';
const VIDEO_HOSTS = /^https:\/\/((www|m)\.)?(youtube\.com|youtu\.be|facebook\.com|instagram\.com|tiktok\.com|vimeo\.com)\//i;

function register(app, deps) {
  const { query, getPool, requireAdmin, requireCap, bcrypt, posSaleHandler, nextQuoteNumber, notify, getEpoch, totp, getShopName } = deps;
  const can = (k) => [requireAdmin, requireCap(k)];
  const n = (v) => (v == null ? 0 : Number(v));
  const r2 = (v) => Math.round(n(v) * 100) / 100;
  const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
  const tok = (bytes) => crypto.randomBytes(bytes || 18).toString('base64url');
  function httpError(status, msg) { const e = new Error(msg); e.status = status; e.publicMessage = msg; return e; }
  function fail(res, e) { const s = e.status || 500; if (s >= 500) console.error('[reps]', e); res.status(s).json({ error: e.publicMessage || e.message }); }
  async function tx(fn) {
    const c = await getPool().connect();
    try { await c.query('BEGIN'); const out = await fn(c); await c.query('COMMIT'); return out; }
    catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} throw e; }
    finally { c.release(); }
  }
  async function setting(key, dflt) {
    const { rows } = await query('SELECT value FROM warehouse_settings WHERE key = $1', [key]);
    return rows.length && rows[0].value != null && rows[0].value !== '' ? rows[0].value : dflt;
  }
  async function baseUrl(req) {
    const b = await setting('public_base_url', '');
    if (b) return b.replace(/\/$/, '');
    return (req.headers['x-forwarded-proto'] || req.protocol || 'http') + '://' + req.get('host');
  }
  function cookie(req, name) {
    const m = String(req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
    return m ? decodeURIComponent(m[1]) : null;
  }
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Run a body through the real POS sale code (dry run = price it, save nothing).
  function runSale(req, body, asUser) {
    const sreq = Object.create(req);
    sreq.body = body;
    sreq.session = Object.assign({}, req.session || {}, { userId: asUser });
    return new Promise((resolve) => {
      const fake = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(d) { resolve({ status: this.statusCode, body: d }); return this; },
        send(d) { resolve({ status: this.statusCode, body: d }); return this; }, set() { return this; }, setHeader() { return this; } };
      Promise.resolve(posSaleHandler(sreq, fake)).catch((e) => resolve({ status: 500, body: { error: e.message } }));
    });
  }
  // Catalogue lines for a list of {product_img, qty}: always the catalogue price.
  async function priceLines(items) {
    const list = (Array.isArray(items) ? items : []).map((i) => ({ img: String(i.product_img || ''), qty: Math.max(1, Math.min(999, parseInt(i.qty, 10) || 1)) })).filter((i) => i.img).slice(0, 60);
    if (!list.length) throw httpError(400, 'Add at least one part');
    const { rows } = await query(`SELECT img, name, sku, price_usd, is_active FROM products WHERE img = ANY($1)`, [list.map((i) => i.img)]);
    return list.map((i) => {
      const p = rows.find((r) => r.img === i.img);
      if (!p || !p.is_active) throw httpError(400, 'A part is no longer sold: ' + i.img);
      if (!(n(p.price_usd) > 0)) throw httpError(400, (p.name || i.img) + ' has no price: ask the shop');
      return { product_img: p.img, description: p.name, qty: i.qty, unit_price_usd: n(p.price_usd), discount_usd: 0 };
    });
  }
  async function makeOrder(req, { lines, customer, repId, repName, takenBy, notes, source }) {
    const body = { items: lines, customer_id: customer ? customer.id : null, customer_name: customer ? customer.name : null, customer_phone: customer ? customer.phone : null,
      sales_rep_id: repId || null, sales_rep_name: repName || null, ship_instructions: notes || null };
    const dry = await runSale(req, Object.assign({}, body, { dry_run: true, payments: [{ method: 'cash', amount_usd: null }] }), takenBy);
    if (dry.status !== 200 || !dry.body || !dry.body.ok) throw httpError(dry.status || 400, (dry.body && dry.body.error) || 'Could not price this order');
    const days = parseInt(await setting('rep_order_days', '7'), 10) || 7;
    const { rows } = await query(
      `INSERT INTO pos_orders (payload, total_usd, preview, customer_id, customer_name, customer_phone, sales_rep_id, sales_rep_name, ship_instructions, taken_by, expires_at, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW() + make_interval(days => $11), $12) RETURNING id`,
      [JSON.stringify(body), dry.body.total_usd, JSON.stringify(dry.body), body.customer_id, body.customer_name, body.customer_phone, body.sales_rep_id, body.sales_rep_name,
       body.ship_instructions, takenBy, days, source]);
    return { id: rows[0].id, total: r2(dry.body.total_usd), days };
  }

  // ---------------------------------------------------------- the rep --
  async function requireRep(req, res, next) {
    try {
      if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Sign in required' });
      const { rows } = await query(
        `SELECT m.id, m.name, m.referral_code, m.commission_pct, u.name AS user_name, u.email
           FROM users u JOIN mechanics m ON m.user_id = u.id AND m.is_active AND m.is_freelance
          WHERE u.id = $1 AND u.admin_role = 'rep' AND NOT u.disabled LIMIT 1`, [req.session.userId]);
      if (!rows.length) return res.status(403).json({ error: 'This is the rep portal: your account is not a rep account.' });
      req.rep = rows[0];
      next();
    } catch (e) { fail(res, e); }
  }
  async function ownCustomer(rep, id) {
    const { rows } = await query(`SELECT id, name, phone, email FROM users WHERE id = $1 AND sales_rep_id = $2`, [parseInt(id, 10) || 0, rep.id]);
    if (!rows.length) throw httpError(404, 'Not one of your customers');
    return rows[0];
  }

  app.get('/api/rep/me', requireRep, async (req, res) => {
    try {
      const r = req.rep;
      const { rows: c } = await query(
        `SELECT COALESCE(SUM(amount) FILTER (WHERE status IN ('earned', 'on_statement', 'approved')), 0) AS owed,
                COALESCE(SUM(amount) FILTER (WHERE status = 'pending'), 0) AS pending,
                COALESCE(SUM(amount) FILTER (WHERE status <> 'void' AND status <> 'pending' AND earned_at >= date_trunc('month', NOW() AT TIME ZONE '${TZ}') AT TIME ZONE '${TZ}'), 0) AS month,
                COALESCE(SUM(amount) FILTER (WHERE status = 'paid'), 0) AS paid
           FROM commission_entries WHERE rep_id = $1`, [r.id]);
      const { rows: k } = await query(
        `SELECT (SELECT COUNT(*) FROM users WHERE sales_rep_id = $1)::int AS customers,
                (SELECT COUNT(*) FROM pos_quotes WHERE sales_rep_id = $1 AND status = 'open')::int AS open_quotes,
                (SELECT COUNT(*) FROM pos_orders WHERE sales_rep_id = $1 AND status = 'pending')::int AS waiting_orders,
                (SELECT COALESCE(SUM(total_usd), 0) FROM pos_sales WHERE sales_rep_id = $1 AND NOT COALESCE(voided, false)
                   AND created_at >= date_trunc('month', NOW() AT TIME ZONE '${TZ}') AT TIME ZONE '${TZ}') AS sales_month`, [r.id]);
      const base = await baseUrl(req);
      res.json({ rep: { id: r.id, name: r.name, email: r.email, referral_code: r.referral_code, referral_link: r.referral_code ? base + '/r/' + r.referral_code : null },
        commission: { owed: r2(c[0].owed), pending: r2(c[0].pending), this_month: r2(c[0].month), paid: r2(c[0].paid) },
        counts: { ...k[0], sales_month: r2(k[0].sales_month) }, shop: (getShopName && await getShopName()) || 'Vision Auto Solutions' });
    } catch (e) { fail(res, e); }
  });

  // Catalogue: price and stock, never cost.
  app.get('/api/rep/products', requireRep, async (req, res) => {
    try {
      const q = String(req.query.q || '').trim().slice(0, 80);
      if (q.length < 2) return res.json({ products: [] });
      const words = q.split(/[\s,]+/).filter(Boolean).slice(0, 5);
      const where = words.map((_, i) => `(p.name || ' ' || COALESCE(p.sku, '') || ' ' || COALESCE(p.make_model, '') || ' ' || COALESCE(p.category, '')) ILIKE '%' || $${i + 1} || '%'`).join(' AND ');
      const { rows } = await query(
        `SELECT p.img, p.sku, p.name, p.make_model, p.category, p.price_usd,
                CASE WHEN p.stock_count > 5 THEN 'in stock' WHEN p.stock_count > 0 THEN 'only ' || p.stock_count || ' left' ELSE 'out of stock' END AS stock
           FROM products p WHERE p.is_active AND ${where} ORDER BY (p.stock_count > 0) DESC, p.name LIMIT 40`, words);
      res.json({ products: rows.map((p) => ({ ...p, price_usd: n(p.price_usd) })) });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/rep/customers', requireRep, async (req, res) => {
    try {
      const q = String(req.query.q || '').trim().slice(0, 60);
      const { rows } = await query(
        `SELECT u.id, u.name, u.phone, CASE WHEN u.email ILIKE '%.local' THEN NULL ELSE u.email END AS email, u.created_at,
                (SELECT MAX(created_at) FROM pos_sales s WHERE s.customer_id = u.id) AS last_bought,
                (SELECT COALESCE(SUM(total_usd), 0) FROM pos_sales s WHERE s.customer_id = u.id AND NOT COALESCE(s.voided, false) AND s.created_at > NOW() - INTERVAL '365 days') AS spent_year
           FROM users u WHERE u.sales_rep_id = $1 AND ($2 = '' OR u.name ILIKE '%' || $2 || '%' OR u.phone ILIKE '%' || $2 || '%')
          ORDER BY u.name LIMIT 300`, [req.rep.id, q]);
      res.json({ customers: rows.map((c) => ({ ...c, spent_year: r2(c.spent_year) })) });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/rep/customers', requireRep, async (req, res) => {
    try {
      const b = req.body || {};
      const name = String(b.name || '').trim().slice(0, 120), phone = String(b.phone || '').trim().slice(0, 40);
      let email = String(b.email || '').trim().toLowerCase().slice(0, 160);
      if (name.length < 2) throw httpError(400, 'Customer name');
      if (phone.replace(/\D/g, '').length < 7) throw httpError(400, 'A phone number, so the shop can reach them');
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, 'That email does not look right');
      const { rows: dup } = await query(`SELECT id, name, sales_rep_id FROM users WHERE regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') = regexp_replace($1, '\\D', '', 'g') OR (lower(email) = $2 AND $2 <> '') LIMIT 1`, [phone, email]);
      if (dup.length) {
        if (dup[0].sales_rep_id === req.rep.id) return res.json({ customer: { id: dup[0].id, name: dup[0].name }, existed: true });
        throw httpError(409, 'This customer is already with the shop' + (dup[0].sales_rep_id ? ' (another rep)' : '') + '. Ask the shop to move them to you.');
      }
      if (!email) email = 'rep' + req.rep.id + '-' + tok(6).toLowerCase() + '@customer.visionautosolutions.local';
      const { rows } = await query(`INSERT INTO users (email, name, phone, via, is_admin, sales_rep_id, how_heard) VALUES ($1,$2,$3,'rep',false,$4,$5) RETURNING id, name, phone`,
        [email, name, phone, req.rep.id, 'Rep: ' + req.rep.name]);
      res.json({ customer: rows[0] });
    } catch (e) { if (e.code === '23505') e = httpError(409, 'That email is already registered with the shop'); fail(res, e); }
  });

  app.post('/api/rep/quotes', requireRep, async (req, res) => {
    try {
      const b = req.body || {};
      const cust = await ownCustomer(req.rep, b.customer_id);
      const lines = await priceLines(b.items);
      const dry = await runSale(req, { items: lines, customer_id: cust.id, dry_run: true, payments: [{ method: 'cash', amount_usd: null }] }, req.session.userId);
      if (dry.status !== 200 || !dry.body || !dry.body.ok) throw httpError(dry.status || 400, (dry.body && dry.body.error) || 'Could not price this quote');
      const num = await nextQuoteNumber();
      const { rows } = await query(
        `INSERT INTO pos_quotes (quote_number, customer_id, customer_name, customer_phone, vehicle_info, subtotal_usd, tax_usd, discount_usd, total_usd, items_json,
                                 valid_until, notes, sales_rep_id, sales_rep_name, created_by, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb, CURRENT_DATE + 14, $11, $12, $13, $14, 'open') RETURNING id`,
        [num, cust.id, cust.name, cust.phone, b.vehicle ? String(b.vehicle).slice(0, 120) : null, r2(dry.body.subtotal_usd), r2(dry.body.tax_usd), r2(dry.body.discount_usd),
         r2(dry.body.total_usd), JSON.stringify(lines), b.notes ? String(b.notes).slice(0, 500) : null, req.rep.id, req.rep.name, req.session.userId]);
      res.json({ id: rows[0].id, quote_number: num, total_usd: r2(dry.body.total_usd) });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/rep/orders', requireRep, async (req, res) => {
    try {
      const b = req.body || {};
      const cust = await ownCustomer(req.rep, b.customer_id);
      const o = await makeOrder(req, { lines: await priceLines(b.items), customer: cust, repId: req.rep.id, repName: req.rep.name, takenBy: req.session.userId,
        notes: b.notes ? String(b.notes).slice(0, 500) : null, source: 'rep' });
      res.json({ order_id: o.id, total_usd: o.total, message: 'Sent to the shop. It waits ' + o.days + ' days for payment at the cashier.' });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/rep/quotes/:id/order', requireRep, async (req, res) => {
    try {
      const { rows } = await query(`SELECT * FROM pos_quotes WHERE id = $1 AND sales_rep_id = $2`, [parseInt(req.params.id, 10) || 0, req.rep.id]);
      if (!rows.length) throw httpError(404, 'Not your quote');
      const qt = rows[0];
      if (qt.status !== 'open') throw httpError(409, 'This quote is ' + qt.status);
      const cust = await ownCustomer(req.rep, qt.customer_id);
      const items = Array.isArray(qt.items_json) ? qt.items_json : JSON.parse(qt.items_json || '[]');
      const o = await makeOrder(req, { lines: await priceLines(items), customer: cust, repId: req.rep.id, repName: req.rep.name, takenBy: req.session.userId,
        notes: 'From quote ' + qt.quote_number, source: 'rep' });
      await query(`UPDATE pos_quotes SET status = 'ordered' WHERE id = $1`, [qt.id]);
      res.json({ order_id: o.id, total_usd: o.total });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/rep/pipeline', requireRep, async (req, res) => {
    try {
      const id = req.rep.id;
      const { rows: quotes } = await query(`SELECT id, quote_number, customer_name, total_usd, status, valid_until, created_at FROM pos_quotes WHERE sales_rep_id = $1 ORDER BY id DESC LIMIT 100`, [id]);
      const { rows: orders } = await query(`SELECT id, customer_name, total_usd, status, created_at, expires_at, converted_sale_id, source FROM pos_orders WHERE sales_rep_id = $1 ORDER BY id DESC LIMIT 100`, [id]);
      const { rows: sales } = await query(`SELECT receipt_number, customer_name, total_usd, payment_status, created_at FROM pos_sales WHERE sales_rep_id = $1 AND NOT COALESCE(voided, false) ORDER BY id DESC LIMIT 100`, [id]);
      res.json({ quotes, orders, sales });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/rep/earnings', requireRep, async (req, res) => {
    try {
      const { rows: entries } = await query(
        `SELECT e.kind, e.amount, e.status, e.earned_at, e.rule_name, e.note, s.receipt_number, i.description AS item
           FROM commission_entries e LEFT JOIN pos_sales s ON s.id = e.sale_id LEFT JOIN pos_sale_items i ON i.id = e.sale_item_id
          WHERE e.rep_id = $1 AND e.earned_at > NOW() - INTERVAL '120 days' ORDER BY e.earned_at DESC LIMIT 500`, [req.rep.id]);
      const { rows: statements } = await query(`SELECT number, period_to, total, status, paid_at FROM commission_statements WHERE rep_id = $1 ORDER BY id DESC LIMIT 24`, [req.rep.id]);
      res.json({ entries: entries.map((e) => ({ ...e, amount: r2(e.amount) })), statements });
    } catch (e) { fail(res, e); }
  });

  // ----------------------------------------------------------- links --
  async function createLink(req, b, who) {
    const kind = ['product', 'quote', 'search', 'page', 'video'].includes(b.kind) ? b.kind : null;
    if (!kind) throw httpError(400, 'What are you sending: a part, a quote, a search, a page or a video?');
    let target = String(b.target || '').trim().slice(0, 500), title = String(b.title || '').trim().slice(0, 120);
    if (kind === 'product') {
      const { rows } = await query(`SELECT img, name FROM products WHERE img = $1 AND is_active`, [target]);
      if (!rows.length) throw httpError(400, 'Choose a part');
      title = title || rows[0].name;
    } else if (kind === 'quote') {
      const { rows } = await query(`SELECT id, quote_number, sales_rep_id, status FROM pos_quotes WHERE id = $1`, [parseInt(target, 10) || 0]);
      if (!rows.length) throw httpError(400, 'Choose a quote');
      if (who.repId && rows[0].sales_rep_id !== who.repId) throw httpError(403, 'Not your quote');
      if (rows[0].status !== 'open') throw httpError(409, 'That quote is ' + rows[0].status);
      target = String(rows[0].id); title = title || 'Quote ' + rows[0].quote_number;
    } else if (kind === 'search') {
      if (target.length < 2) throw httpError(400, 'What should it search for?');
      title = title || target;
    } else if (kind === 'page') {
      if (!/^\/[A-Za-z0-9_\-./?=&%#]*$/.test(target) || target.startsWith('//')) throw httpError(400, 'A page of this site, starting with /');
    } else if (kind === 'video') {
      if (!VIDEO_HOSTS.test(target)) throw httpError(400, 'Videos from YouTube, Facebook, Instagram, TikTok or Vimeo only');
    }
    let customer = null;
    if (b.customer_id) {
      const { rows } = await query(`SELECT id, name, phone, email, sales_rep_id FROM users WHERE id = $1`, [parseInt(b.customer_id, 10) || 0]);
      if (!rows.length) throw httpError(404, 'Customer not found');
      if (who.repId && rows[0].sales_rep_id !== who.repId) throw httpError(403, 'Not one of your customers');
      customer = rows[0];
    }
    const days = Math.max(1, Math.min(90, parseInt(b.days, 10) || parseInt(await setting('link_days', '14'), 10) || 14));
    const channel = ['sms', 'whatsapp', 'email', 'copy'].includes(b.channel) ? b.channel : 'copy';
    const phone = String(b.phone || (customer && customer.phone) || '').trim(), email = String(b.email || (customer && customer.email) || '').trim();
    const token = tok(9);
    const message = String(b.message || '').trim().slice(0, 300);
    await query(
      `INSERT INTO share_links (token, kind, target, title, message, rep_id, created_by, customer_id, sent_to, channel, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW() + make_interval(days => $11))`,
      [token, kind, target, title || null, message || null, who.repId || null, req.session.userId, customer ? customer.id : null,
       channel === 'email' ? email : channel === 'copy' ? null : phone, channel, days]);
    const url = (await baseUrl(req)) + '/l/' + token;
    let sent = null;
    if (channel !== 'copy' && notify) {
      const out = await notify.send('share_link', { name: customer ? customer.name : b.name, phone, email, customer_id: customer ? customer.id : null, url, message: message || title, title: title || 'From Vision Auto Solutions' },
        { related_kind: 'share_link', by_user: req.session.userId, channels: [channel], force: true });
      sent = out.map((x) => ({ channel: x.channel, status: x.status, reason: x.reason, wa_link: x.channel === 'whatsapp' && x.status === 'link' && notify.waLink ? notify.waLink(x.to_addr, x.body || '') : undefined }));
    }
    return { token, url, expires_days: days, sent };
  }
  async function listLinks(where, vals) {
    const { rows } = await query(
      `SELECT l.*, m.name AS rep, u.name AS created_by_name, c.name AS customer FROM share_links l
         LEFT JOIN mechanics m ON m.id = l.rep_id LEFT JOIN users u ON u.id = l.created_by LEFT JOIN users c ON c.id = l.customer_id
        WHERE ${where} ORDER BY l.id DESC LIMIT 300`, vals);
    return rows.map((l) => ({ ...l, expired: new Date(l.expires_at) < new Date() }));
  }
  app.post('/api/rep/links', requireRep, async (req, res) => {
    try { res.json(await createLink(req, req.body || {}, { repId: req.rep.id })); } catch (e) { fail(res, e); }
  });
  app.get('/api/rep/links', requireRep, async (req, res) => {
    try { res.json({ links: await listLinks('l.rep_id = $1', [req.rep.id]) }); } catch (e) { fail(res, e); }
  });
  app.post('/api/links', ...can('links.send'), async (req, res) => {
    try { res.json(await createLink(req, req.body || {}, {})); } catch (e) { fail(res, e); }
  });
  app.get('/api/links', ...can('links.send'), async (req, res) => {
    try { res.json({ links: await listLinks('TRUE', []) }); } catch (e) { fail(res, e); }
  });

  // Public: open a link.
  app.get('/l/:token', async (req, res) => {
    try {
      const { rows } = await query(`SELECT l.*, m.referral_code FROM share_links l LEFT JOIN mechanics m ON m.id = l.rep_id WHERE l.token = $1`, [String(req.params.token).slice(0, 40)]);
      if (!rows.length) return res.status(404).type('html').send(page('Link not found', 'This link is not valid. Please contact the shop.'));
      const l = rows[0];
      if (new Date(l.expires_at) < new Date()) return res.status(410).type('html').send(page('This link has expired', 'Please contact the shop or your rep for a new one.'));
      await query(`UPDATE share_links SET opens = opens + 1, first_opened_at = COALESCE(first_opened_at, NOW()), last_opened_at = NOW() WHERE id = $1`, [l.id]);
      if (l.referral_code) res.append('Set-Cookie', `vas_ref=${encodeURIComponent(l.referral_code)}; Path=/; Max-Age=${30 * 86400}; SameSite=Lax`);
      res.append('Set-Cookie', `vas_link=${l.token}; Path=/; Max-Age=${14 * 86400}; SameSite=Lax`);
      let to = '/';
      if (l.kind === 'product') {
        const { rows: p } = await query(`SELECT sku, name FROM products WHERE img = $1`, [l.target]);
        to = '/shop.html?q=' + encodeURIComponent(p.length ? (p[0].sku || p[0].name) : l.target);
      } else if (l.kind === 'search') to = '/shop.html?q=' + encodeURIComponent(l.target);
      else if (l.kind === 'quote') to = '/q.html?t=' + encodeURIComponent(l.token);
      else if (l.kind === 'page' && /^\/[^/]/.test(l.target)) to = l.target;
      else if (l.kind === 'video' && VIDEO_HOSTS.test(l.target)) to = l.target;
      res.redirect(302, to);
    } catch (e) { res.status(500).type('html').send(page('Something went wrong', 'Please try again later.')); }
  });
  function page(title, text) {
    return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<body style="font:16px system-ui,sans-serif;max-width:520px;margin:12vh auto;padding:0 16px;color:#0f1720"><h1 style="font-size:22px">${esc(title)}</h1><p>${esc(text)}</p><p><a href="/">Vision Auto Solutions</a></p></body>`;
  }

  // Public: referral link.
  app.get('/r/:code', async (req, res) => {
    try {
      const code = String(req.params.code || '').trim().slice(0, 20);
      const { rows } = await query(`SELECT referral_code FROM mechanics WHERE upper(referral_code) = upper($1) AND is_active`, [code]);
      if (rows.length) res.append('Set-Cookie', `vas_ref=${encodeURIComponent(rows[0].referral_code)}; Path=/; Max-Age=${30 * 86400}; SameSite=Lax`);
      res.redirect(302, '/');
    } catch (e) { res.redirect(302, '/'); }
  });
  // Called by sign-up: a new customer who came through a rep's link becomes theirs.
  async function attributeReferral(req, userId) {
    try {
      const code = cookie(req, 'vas_ref');
      if (!code) return;
      await query(`UPDATE users SET sales_rep_id = (SELECT id FROM mechanics WHERE upper(referral_code) = upper($2) AND is_active LIMIT 1), how_heard = COALESCE(how_heard, 'Referral ' || $2)
                    WHERE id = $1 AND sales_rep_id IS NULL`, [userId, code]);
    } catch (e) { console.warn('[reps] referral', e.message); }
  }

  // Public: a quote sent by link -- view and accept.
  async function linkQuote(token) {
    const { rows } = await query(
      `SELECT l.id AS link_id, l.expires_at, l.converted_at, l.created_by, l.rep_id, q.* FROM share_links l JOIN pos_quotes q ON q.id = l.target::int
        WHERE l.token = $1 AND l.kind = 'quote'`, [String(token).slice(0, 40)]);
    if (!rows.length) throw httpError(404, 'Quote not found');
    if (new Date(rows[0].expires_at) < new Date()) throw httpError(410, 'This link has expired. Please contact the shop.');
    return rows[0];
  }
  app.get('/api/public/q/:token', async (req, res) => {
    try {
      const q = await linkQuote(req.params.token);
      const items = (Array.isArray(q.items_json) ? q.items_json : JSON.parse(q.items_json || '[]')).map((i) => ({ description: i.description, qty: i.qty, unit_price: n(i.unit_price_usd), total: r2(n(i.unit_price_usd) * n(i.qty) - n(i.discount_usd)) }));
      const first = String(q.customer_name || '').split(/\s+/)[0];
      res.set('Cache-Control', 'no-store');
      res.json({ number: q.quote_number, date: q.created_at, valid_until: q.valid_until, name: first, items, subtotal: r2(q.subtotal_usd), discount: r2(q.discount_usd), tax: r2(q.tax_usd), total: r2(q.total_usd),
        status: q.status, accepted: !!q.converted_at, rep: q.sales_rep_name, shop: (getShopName && await getShopName()) || 'Vision Auto Solutions', phone: await setting('notify_shop_phone', '') });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/public/q/:token/accept', async (req, res) => {
    try {
      const q = await linkQuote(req.params.token);
      if (q.converted_at || q.status !== 'open') throw httpError(409, 'This quote has already been accepted or closed.');
      if (q.valid_until && new Date(q.valid_until) < new Date(new Date().toDateString())) throw httpError(410, 'This quote has expired. Please contact the shop for a new one.');
      const items = Array.isArray(q.items_json) ? q.items_json : JSON.parse(q.items_json || '[]');
      const cust = q.customer_id ? (await query(`SELECT id, name, phone FROM users WHERE id = $1`, [q.customer_id])).rows[0] : null;
      const o = await makeOrder(req, { lines: await priceLines(items), customer: cust, repId: q.sales_rep_id, repName: q.sales_rep_name, takenBy: q.created_by,
        notes: 'Accepted online from quote ' + q.quote_number, source: 'link' });
      await query(`UPDATE pos_quotes SET status = 'ordered' WHERE id = $1`, [q.id]);
      await query(`UPDATE share_links SET converted_at = NOW(), conversion_ref = $2 WHERE id = $1`, [q.link_id, 'ORD-' + o.id]);
      res.json({ ok: true, order: 'ORD-' + o.id, total: o.total, days: o.days });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------- manage reps --
  async function newInvite(c, rep, userId, by) {
    const token = tok(24);
    await c.query(`UPDATE rep_invites SET revoked_at = NOW() WHERE mechanic_id = $1 AND used_at IS NULL AND revoked_at IS NULL`, [rep]);
    await c.query(`INSERT INTO rep_invites (token_hash, mechanic_id, user_id, expires_at, created_by) VALUES ($1,$2,$3, NOW() + INTERVAL '7 days', $4)`, [sha(token), rep, userId, by]);
    return token;
  }
  app.get('/api/reps', ...can('reps.manage'), async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT m.id, m.name, m.phone, m.email, m.is_active, m.commission_pct, m.referral_code, u.id AS user_id, u.last_login_at, (u.totp_enabled_at IS NOT NULL) AS two_step, u.disabled,
                (SELECT COUNT(*) FROM users c WHERE c.sales_rep_id = m.id)::int AS customers,
                (SELECT COALESCE(SUM(total_usd), 0) FROM pos_sales s WHERE s.sales_rep_id = m.id AND NOT COALESCE(s.voided, false) AND s.created_at > NOW() - INTERVAL '30 days') AS sales_30d,
                (SELECT COUNT(*) FROM pos_orders o WHERE o.sales_rep_id = m.id AND o.status = 'pending')::int AS waiting_orders,
                (SELECT MAX(expires_at) FROM rep_invites i WHERE i.mechanic_id = m.id AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > NOW()) AS invite_open_until
           FROM mechanics m JOIN users u ON u.id = m.user_id WHERE m.is_freelance ORDER BY m.is_active DESC, m.name`);
      res.json({ reps: rows.map((r) => ({ ...r, sales_30d: r2(r.sales_30d) })) });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/reps', ...can('reps.manage'), async (req, res) => {
    try {
      const b = req.body || {};
      const name = String(b.name || '').trim().slice(0, 120), email = String(b.email || '').trim().toLowerCase(), phone = String(b.phone || '').trim().slice(0, 40);
      if (name.length < 2) throw httpError(400, 'Name');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, 'The rep\'s email (they sign in with it)');
      const pct = b.commission_pct === '' || b.commission_pct == null ? null : Number(b.commission_pct);
      if (pct != null && !(pct >= 0 && pct <= 50)) throw httpError(400, 'Commission % must be 0 to 50');
      const base = await baseUrl(req);
      const out = await tx(async (c) => {
        const { rows: u } = await c.query(
          `INSERT INTO users (email, name, phone, password_hash, via, is_admin, is_staff, admin_role) VALUES ($1,$2,$3,$4,'rep',false,true,'rep') RETURNING id`,
          [email, name, phone || null, await bcrypt.hash(tok(24), 10)]);
        let code = name.replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 6) || 'REP';
        const { rows: taken } = await c.query(`SELECT 1 FROM mechanics WHERE upper(referral_code) = $1`, [code]);
        if (taken.length) code = code.slice(0, 4) + crypto.randomInt(100, 999);
        const { rows: m } = await c.query(
          `INSERT INTO mechanics (user_id, name, phone, email, role, is_active, is_freelance, commission_pct, referral_code) VALUES ($1,$2,$3,$4,'advisor',true,true,$5,$6) RETURNING id`,
          [u[0].id, name, phone || null, email, pct, code]);
        const token = await newInvite(c, m[0].id, u[0].id, req.session.userId);
        return { rep_id: m[0].id, referral_code: code, invite_url: base + '/rep.html?invite=' + token };
      });
      res.json(out);
    } catch (e) { if (e.code === '23505') e = httpError(409, 'That email already has an account'); fail(res, e); }
  });
  app.post('/api/reps/:id/invite', ...can('reps.manage'), async (req, res) => {
    try {
      const base = await baseUrl(req);
      const out = await tx(async (c) => {
        const { rows } = await c.query(`SELECT m.id, m.user_id FROM mechanics m WHERE m.id = $1 AND m.is_freelance`, [parseInt(req.params.id, 10) || 0]);
        if (!rows.length) throw httpError(404, 'Rep not found');
        // A new invite sets up sign-in from scratch: the old 2-step stops working.
        await c.query(`UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_enabled_at = NULL, totp_recovery = NULL, totp_last_step = NULL, disabled = false WHERE id = $1`, [rows[0].user_id]);
        return base + '/rep.html?invite=' + (await newInvite(c, rows[0].id, rows[0].user_id, req.session.userId));
      });
      res.json({ invite_url: out });
    } catch (e) { fail(res, e); }
  });
  app.patch('/api/reps/:id', ...can('reps.manage'), async (req, res) => {
    try {
      const b = req.body || {};
      const { rows } = await query(`SELECT id, user_id FROM mechanics WHERE id = $1 AND is_freelance`, [parseInt(req.params.id, 10) || 0]);
      if (!rows.length) throw httpError(404, 'Rep not found');
      if (b.commission_pct !== undefined) {
        const pct = b.commission_pct === '' || b.commission_pct == null ? null : Number(b.commission_pct);
        if (pct != null && !(pct >= 0 && pct <= 50)) throw httpError(400, 'Commission % must be 0 to 50');
        await query(`UPDATE mechanics SET commission_pct = $2 WHERE id = $1`, [rows[0].id, pct]);
      }
      if (b.is_active !== undefined) {
        await query(`UPDATE mechanics SET is_active = $2 WHERE id = $1`, [rows[0].id, !!b.is_active]);
        await query(`UPDATE users SET disabled = $2 WHERE id = $1`, [rows[0].user_id, !b.is_active]);
      }
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // --------------------------------------------------- invite (public) --
  async function invite(token) {
    const { rows } = await query(
      `SELECT i.*, u.email, u.name FROM rep_invites i JOIN users u ON u.id = i.user_id
        WHERE i.token_hash = $1 AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > NOW()`, [sha(String(token || ''))]);
    if (!rows.length) throw httpError(404, 'This invite link is not valid or has expired. Ask the shop for a new one.');
    return rows[0];
  }
  app.get('/api/rep/invite/:token', async (req, res) => {
    try { const i = await invite(req.params.token); res.json({ name: i.name, email: i.email }); } catch (e) { fail(res, e); }
  });
  app.post('/api/rep/invite/:token/start', async (req, res) => {
    try {
      const i = await invite(req.params.token);
      const pw = String((req.body || {}).password || '');
      if (pw.length < 10) throw httpError(400, 'Choose a password of at least 10 characters');
      const secret = totp.b32encode(crypto.randomBytes(20));
      await query(`UPDATE users SET password_hash = $2, totp_pending = $3 WHERE id = $1`, [i.user_id, await bcrypt.hash(pw, 10), secret]);
      const label = encodeURIComponent('Vision Auto Solutions:' + i.email);
      res.json({ secret: secret.replace(/(.{4})/g, '$1 ').trim(), uri: `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent('Vision Auto Solutions')}&algorithm=SHA1&digits=6&period=30` });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/rep/invite/:token/finish', async (req, res) => {
    try {
      const i = await invite(req.params.token);
      const { rows } = await query(`SELECT totp_pending FROM users WHERE id = $1`, [i.user_id]);
      if (!rows[0].totp_pending) throw httpError(409, 'Set your password first');
      const step = totp.totpStep(rows[0].totp_pending, (req.body || {}).code, null);
      if (step == null) throw httpError(400, 'That code is not right. Check the phone\'s clock is set automatically.');
      const codes = Array.from({ length: 10 }, () => crypto.randomBytes(5).toString('hex').replace(/(.{5})/, '$1-'));
      await query(`UPDATE users SET totp_secret = totp_pending, totp_pending = NULL, totp_enabled_at = NOW(), totp_last_step = $2, totp_recovery = $3, failed_logins = 0, locked_until = NULL WHERE id = $1`,
        [i.user_id, step, JSON.stringify(codes.map(sha))]);
      await query(`UPDATE rep_invites SET used_at = NOW() WHERE id = $1`, [i.id]);
      req.session.userId = i.user_id;
      req.session.epoch = getEpoch();
      req.session.at = Date.now();
      res.json({ ok: true, recovery_codes: codes });
    } catch (e) { fail(res, e); }
  });

  return { attributeReferral };
}

module.exports = { register };
