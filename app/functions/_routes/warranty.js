// Warranty register + claim log (migration 0056). The register is a read
// model over serialised units (product_serials, status 'sold'/'claimed' with
// a warranty_until) and non-serialised warrantied sale lines
// (pos_sale_items.warranty_until); claims are their own small workflow.
//   GET   /api/admin/warranty/register?filter=active|expiring|expired|claimed
//   GET   /api/admin/warranty/claims[?status=]
//   POST  /api/admin/warranty/claims
//   PATCH /api/admin/warranty/claims/:id
import { d1 } from '../_lib/db.js';
import { adminMw, userCan } from '../_lib/guards.js';

const CLAIM_STATUS = ['open', 'repair', 'replace', 'refund', 'denied', 'closed'];

export default function mount(app) {
  app.get('/api/admin/warranty/register', adminMw, async (c) => {
    const db = d1(c.env);
    const filter = c.req.query('filter') || 'active';
    // one comparable shape from both sources
    const rows = await db.many(
      `SELECT 'serial' AS kind, s.id AS ref_id, s.serial, s.product_img, p.name AS product_name,
              s.warranty_until, s.status AS unit_status, s.sale_id,
              ps.receipt_number, ps.customer_name, ps.customer_phone, s.sold_at AS sold_at
         FROM product_serials s
         JOIN products p ON p.img = s.product_img
         LEFT JOIN pos_sales ps ON ps.id = s.sale_id
        WHERE s.warranty_until IS NOT NULL AND s.status IN ('sold','claimed')
       UNION ALL
       SELECT 'line' AS kind, psi.id AS ref_id, psi.serial_number AS serial, psi.product_img, psi.description AS product_name,
              psi.warranty_until, NULL AS unit_status, psi.sale_id,
              ps.receipt_number, ps.customer_name, ps.customer_phone, ps.created_at AS sold_at
         FROM pos_sale_items psi
         JOIN pos_sales ps ON ps.id = psi.sale_id AND ps.voided = 0
        WHERE psi.warranty_until IS NOT NULL
          AND (psi.serial_number IS NULL OR psi.serial_number NOT IN (SELECT serial FROM product_serials WHERE product_img = psi.product_img))
       ORDER BY warranty_until ASC LIMIT 1000`);
    const today = new Date().toISOString().slice(0, 10);
    const in30 = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const claims = await db.many(
      `SELECT sale_item_id, serial_id, status FROM warranty_claims WHERE status NOT IN ('closed','denied')`);
    const claimByKey = new Set(claims.map((x) => (x.serial_id ? 's' + x.serial_id : 'l' + x.sale_item_id)));
    const out = [];
    for (const r of rows) {
      r.warranty_state = r.warranty_until < today ? 'expired'
        : r.warranty_until <= in30 ? 'expiring' : 'active';
      r.has_open_claim = claimByKey.has((r.kind === 'serial' ? 's' : 'l') + r.ref_id) || r.unit_status === 'claimed';
      if (filter === 'claimed' && !r.has_open_claim) continue;
      if (filter === 'active' && r.warranty_state !== 'active') continue;
      if (filter === 'expiring' && r.warranty_state !== 'expiring') continue;
      if (filter === 'expired' && r.warranty_state !== 'expired') continue;
      out.push(r);
    }
    return c.json({ register: out, as_of: today });
  });

  app.get('/api/admin/warranty/claims', adminMw, async (c) => {
    const status = c.req.query('status');
    const where = status && CLAIM_STATUS.includes(status) ? 'WHERE wc.status = ?' : '';
    const rows = await d1(c.env).many(
      `SELECT wc.*, p.name AS product_name, ob.name AS opened_by_name, rb.name AS resolved_by_name,
              ps.receipt_number
         FROM warranty_claims wc
         LEFT JOIN products p ON p.img = wc.product_img
         LEFT JOIN users ob ON ob.id = wc.opened_by
         LEFT JOIN users rb ON rb.id = wc.resolved_by
         LEFT JOIN pos_sales ps ON ps.id = wc.sale_id
         ${where}
        ORDER BY wc.opened_at DESC LIMIT 500`,
      ...(where ? [status] : []));
    return c.json({ claims: rows });
  });

  app.post('/api/admin/warranty/claims', adminMw, async (c) => {
    const db = d1(c.env);
    const me = c.get('user');
    const b = await c.req.json().catch(() => ({}));
    let productImg = b.product_img ? String(b.product_img) : null;
    let serial = b.serial ? String(b.serial).trim() : null;
    let serialId = null, saleId = b.sale_id ? parseInt(b.sale_id, 10) : null, saleItemId = b.sale_item_id ? parseInt(b.sale_item_id, 10) : null;
    let customerName = b.customer_name || null, customerPhone = b.customer_phone || null;

    if (serial && !serialId) {
      const s = await db.one('SELECT id, product_img, sale_id, sale_item_id FROM product_serials WHERE lower(serial) = lower(?) ORDER BY id DESC LIMIT 1', serial);
      if (s) { serialId = s.id; productImg = productImg || s.product_img; saleId = saleId || s.sale_id; saleItemId = saleItemId || s.sale_item_id; }
    }
    if (saleItemId && (!productImg || !customerName)) {
      const li = await db.one(
        `SELECT psi.product_img, psi.sale_id, ps.customer_name, ps.customer_phone
           FROM pos_sale_items psi JOIN pos_sales ps ON ps.id = psi.sale_id WHERE psi.id = ?`, saleItemId);
      if (li) { productImg = productImg || li.product_img; saleId = saleId || li.sale_id; customerName = customerName || li.customer_name; customerPhone = customerPhone || li.customer_phone; }
    }
    if (!productImg && !serial && !saleItemId)
      return c.json({ error: 'Give a serial, a sale line, or a product to open a claim against' }, 400);

    const r = await db.run(
      `INSERT INTO warranty_claims (product_img, serial, serial_id, sale_id, sale_item_id, customer_name, customer_phone, fault, opened_by)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      productImg, serial, serialId, saleId, saleItemId, customerName, customerPhone,
      b.fault ? String(b.fault).slice(0, 500) : null, me.id);
    return c.json({ ok: true, id: r.meta ? r.meta.last_row_id : undefined });
  });

  app.patch('/api/admin/warranty/claims/:id', adminMw, async (c) => {
    const db = d1(c.env);
    const me = c.get('user');
    if (!userCan(me, 'pos.refund')) return c.json({ error: 'Not allowed to resolve a warranty claim.' }, 403);
    const b = await c.req.json().catch(() => ({}));
    const claim = await db.one('SELECT * FROM warranty_claims WHERE id = ?', c.req.param('id'));
    if (!claim) return c.json({ error: 'Not found' }, 404);
    const sets = []; const vals = [];
    const resolving = b.status && ['repair', 'replace', 'refund', 'denied', 'closed'].includes(b.status);
    if (b.status !== undefined) {
      if (!CLAIM_STATUS.includes(b.status)) return c.json({ error: 'Bad status' }, 400);
      sets.push('status = ?'); vals.push(b.status);
    }
    if (b.resolution_note !== undefined) { sets.push('resolution_note = ?'); vals.push(b.resolution_note ? String(b.resolution_note).slice(0, 500) : null); }
    if (b.return_id !== undefined) { sets.push('return_id = ?'); vals.push(b.return_id ? parseInt(b.return_id, 10) : null); }
    if (b.replacement_sale_id !== undefined) { sets.push('replacement_sale_id = ?'); vals.push(b.replacement_sale_id ? parseInt(b.replacement_sale_id, 10) : null); }
    if (b.fault !== undefined) { sets.push('fault = ?'); vals.push(b.fault ? String(b.fault).slice(0, 500) : null); }
    if (resolving) { sets.push('resolved_by = ?', "resolved_at = CURRENT_TIMESTAMP"); vals.push(me.id); }
    if (!sets.length) return c.json({ error: 'Nothing to update' }, 400);
    const stmts = [{ sql: `UPDATE warranty_claims SET ${sets.join(', ')} WHERE id = ?`, binds: [...vals, claim.id] }];
    // A replace closes out the physical unit.
    if (b.status === 'replace' && claim.serial_id) {
      stmts.push({ sql: `UPDATE product_serials SET status = 'claimed' WHERE id = ? AND status = 'sold'`, binds: [claim.serial_id] });
    }
    await db.batch(stmts);
    return c.json({ ok: true });
  });
}
