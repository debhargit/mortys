// Phase 7 — binary uploads (R2) + transactional email. Ports:
//   GET  /uploads/*                              (serve from the R2 bucket)
//   POST /api/admin/settings/logo               (shop logo)
//   POST /api/admin/products-photo              (product hero photo / URL)
//   POST /api/admin/inspections/:id/photos      (inspection photo)
//   POST /api/admin/notify-back-in-stock        (email the waiting list)
//
// server.js used multer -> app/uploads/ + express.static and nodemailer;
// neither exists on Workers. Files go to env.UPLOADS (R2), email to env.EMAIL
// (Cloudflare send_email). Both bindings need a one-time account opt-in — see
// wrangler.toml — and until then uploads return a clean 501 and email logs a
// stub, so nothing else breaks.
import { d1 } from '../_lib/db.js';
import { adminMw, managerMw } from '../_lib/guards.js';
import { putUpload, getUpload, readUploadBody, uploadsEnabled } from '../_lib/uploads.js';
import { sendEmail, templates } from '../_lib/mailer.js';
import { safeJson } from '../_lib/util.js';

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

async function takeImage(c, fields, prefix) {
  const { file, body } = await readUploadBody(c, fields);
  if (!file) return { file: null, body, upload: null };
  if (file.size > MAX_IMAGE_BYTES) {
    const e = new Error(`Image too large — the limit is ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`);
    e.userFacing = true; e.status = 413; throw e;
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const upload = await putUpload(c.env, { prefix, bytes, contentType: file.type, filename: file.name });
  return { file, body, upload };
}

function fail(c, e) {
  if (e && e.userFacing) return c.json({ error: e.message }, e.status || 400);
  throw e;
}

export default function mount(app) {
  // ---- serve an uploaded file from R2 -------------------------------
  app.get('/uploads/:key{.+}', async (c) => {
    const key = c.req.param('key');
    if (!uploadsEnabled(c.env)) return c.json({ error: 'Uploads bucket not configured' }, 404);
    const obj = await getUpload(c.env, key);
    if (!obj || !obj.body) return c.json({ error: 'Not found' }, 404);
    const h = {
      'Content-Type': (obj.httpMetadata && obj.httpMetadata.contentType) || 'application/octet-stream',
      'Cache-Control': 'public, max-age=604800',
    };
    if (obj.httpEtag) h.ETag = obj.httpEtag;
    return c.body(obj.body, 200, h);
  });

  // ---- shop logo --------------------------------------------------
  app.post('/api/admin/settings/logo', managerMw, async (c) => {
    const db = d1(c.env);
    let upload;
    try { ({ upload } = await takeImage(c, ['logo'], 'logo')); }
    catch (e) { return fail(c, e); }
    if (!upload) return c.json({ error: 'logo file required' }, 400);
    const row = await db.one('SELECT id FROM shop_settings ORDER BY id LIMIT 1');
    if (!row) await db.run('INSERT INTO shop_settings (id, logo_url) VALUES (1, ?)', upload.url);
    else await db.run('UPDATE shop_settings SET logo_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', upload.url, row.id);
    return c.json({ ok: true, logo_url: upload.url });
  });

  // ---- product hero photo (upload OR url) ------------------------
  app.post('/api/admin/products-photo', adminMw, async (c) => {
    const db = d1(c.env);
    let file, body, upload;
    try { ({ file, body, upload } = await takeImage(c, ['photo'], 'products')); }
    catch (e) { return fail(c, e); }
    const productImg = body.product_img;
    if (!productImg) return c.json({ error: 'product_img required' }, 400);
    let newImgPath = null;
    if (upload) newImgPath = upload.url;
    else if (body.url) newImgPath = body.url;
    else return c.json({ error: 'photo file or url required' }, 400);
    await db.run(
      `INSERT INTO warehouse_activity (kind, product_img, performed_by, ref_kind, notes)
         VALUES ('photo_update', ?, ?, 'manual', ?)`,
      productImg, body.performed_by || null, 'Photo updated to ' + newImgPath);
    return c.json({ ok: true, photo_url: newImgPath });
  });

  // ---- inspection photo ----------------------------------------
  app.post('/api/admin/inspections/:id/photos', adminMw, async (c) => {
    const db = d1(c.env);
    let upload, body;
    try { ({ upload, body } = await takeImage(c, ['photo'], 'inspections')); }
    catch (e) { return fail(c, e); }
    if (!upload) return c.json({ error: 'Photo file required' }, 400);
    let annotations = '[]';
    if (body.annotations && safeJson(body.annotations, null) != null) annotations = body.annotations;
    await db.run(
      `INSERT INTO inspection_photos (inspection_id, inspection_item_id, photo_path, caption, annotations)
         VALUES (?,?,?,?,?)`,
      c.req.param('id'), body.inspection_item_id || null, upload.url, body.caption || null, annotations);
    return c.json({ ok: true, photo_path: upload.url });
  });

  // ---- email the back-in-stock waiting list --------------------
  app.post('/api/admin/notify-back-in-stock', adminMw, async (c) => {
    const db = d1(c.env);
    const subs = await db.many(
      `SELECT n.id, n.email, n.phone, p.img AS product_img, p.name AS product_name,
              p.price_cents / 100.0 AS price_usd
         FROM notify_subscriptions n
         JOIN products p ON p.img = n.product_img
        WHERE n.notified_at IS NULL AND p.stock_count > 0`);
    let emails_sent = 0, failed = 0;
    for (const sub of subs) {
      try {
        const t = templates.backInStockEmail(sub);
        await sendEmail(c.env, { to: sub.email, ...t });
        await db.run('UPDATE notify_subscriptions SET notified_at = CURRENT_TIMESTAMP WHERE id = ?', sub.id);
        emails_sent++;
      } catch (e) {
        failed++;
        console.warn('[notify-back-in-stock]', sub.email, e.message);
      }
    }
    return c.json({ ok: true, candidates: subs.length, emails_sent, failed });
  });
}
