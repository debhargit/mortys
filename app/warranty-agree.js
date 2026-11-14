'use strict';
// =============================================================================
//  Morty's Auto Parts -- warranty agreements and e-signing (WARRANTY-AGREE).
//
//  Mounted from warranty.js. A warranty agreement is the wording the customer
//  agrees to for one part they bought (a sale line), or for a claim with no
//  sale. The wording comes from the part's plan (its own wording, else the
//  shop's standard wording) with the sale's details filled in, and is frozen
//  when the agreement is made, so later changes to the wording never change
//  what a customer signed.
//
//  Three ways to get it signed:
//    - at the counter: the customer signs on the screen (till, tablet, phone);
//    - by link: a one-off link (QR code or email) the customer opens on their
//      own phone, no sign-in; it runs out after 14 days;
//    - on paper: print it, have it signed, then upload the scan or photo.
//  A plan can say the agreement must be signed before a claim is settled.
//  Each signature is kept with who, when, where from and a SHA-256 fingerprint
//  of the wording + name + time + signature, printed on the copy.
//
//  Files: uploads/warranty/agreements/<random>.png|pdf|jpg (unguessable names).
//  Tables: warranty_agreements; warranty_plans.needs_signature / agreement_text /
//  agreement_file (DDL lives in warranty.js, section WARRANTY-AGREE).
// =============================================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LINK_DAYS = 14;
const DEFAULT_TEXT = [
  'WARRANTY AGREEMENT',
  '',
  '{shop} gives this warranty on the part below, from the date of sale, on the terms set out here.',
  '',
  'Customer: {customer}',
  'Phone: {phone}',
  'Email: {email}',
  'Part: {part}',
  'Item code: {sku}',
  'Serial number: {serial}',
  'Model number: {model}',
  'Receipt: {receipt}',
  'Date of sale: {sold_on}',
  'Warranty period: {period}, ending {until}',
  'Warranty plan: {plan}',
  '',
  'What is covered',
  '• {rule}.',
  '• {remedy}',
  '• {labour}',
  '• {maker}',
  '',
  'To make a claim',
  '• Bring the part and your receipt (or the receipt number) to {shop} before the warranty ends.',
  '• {needs}',
  '',
  'What is not covered',
  '• Damage from wrong fitting, accident, misuse, neglect, overloading, or changes to the part.',
  '• Normal wear and tear, and parts used for racing or outside what they are made for.',
  '• Loss of use of the vehicle, towing, or other costs, unless the law says otherwise.',
  '',
  '{notes}',
  '',
  'This warranty is in addition to your rights under the law.',
  '',
  'By signing, I confirm I received the part above in good order and I accept these warranty terms.',
].join('\n');
const PLACEHOLDERS = ['shop', 'shop_phone', 'customer', 'phone', 'email', 'part', 'sku', 'serial', 'model', 'receipt', 'sold_on', 'until', 'period',
  'plan', 'rule', 'remedy', 'labour', 'maker', 'needs', 'notes', 'vehicle', 'today'];

const fmtDate = (d) => {
  if (!d) return '';
  const x = new Date(String(d).length === 10 ? d + 'T12:00:00' : d);
  return isNaN(x) ? String(d) : x.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
};
// Fill {placeholders}. A line whose placeholders all came out empty (and that
// has nothing else but a bullet or a label) is dropped, so a part with no
// serial number does not print "Serial number: ".
function fill(text, v) {
  return String(text || '').split('\n').map((line) => {
    const keys = line.match(/\{([a-z_]+)\}/g) || [];
    if (!keys.length) return line;
    let empty = true;
    const out = line.replace(/\{([a-z_]+)\}/g, (m, k) => {
      if (!(k in v)) return m;
      const s = v[k] == null ? '' : String(v[k]);
      if (s.trim()) empty = false;
      return s;
    });
    return empty ? null : out;
  }).filter((l) => l !== null).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');

function register(app, ctx) {
  const { query, requireAdmin, requireManager, userCan, ensure, lineTerms, ruleText, getShop } = ctx;
  const mailer = ctx.mailer || null, notice = ctx.notice || null;
  const W = '/api/admin/warranty';
  const DIR = path.join(__dirname, 'uploads', 'warranty', 'agreements');
  const URL0 = '/uploads/warranty/agreements/';

  function httpError(status, msg) { const e = new Error(msg); e.status = status; e.publicMessage = msg; return e; }
  function fail(res, e) {
    const s = e.status || 500;
    if (s >= 500) console.error('[warranty-agree]', e);
    res.status(s).json({ error: e.publicMessage || e.message });
  }
  const one = async (sql, p) => (await query(sql, p)).rows[0] || null;
  const rnd = () => crypto.randomBytes(16).toString('hex');

  // A paper copy or a plan's own document: PDF or a picture, 15 MB.
  let fileUpload = (req, res, next) => next();
  try {
    const multer = require('multer');
    const up = multer({
      storage: multer.diskStorage({
        destination(_req, _f, cb) { fs.mkdir(DIR, { recursive: true }, (e) => cb(e, DIR)); },
        filename(_req, f, cb) {
          const ext = (path.extname(f.originalname || '').toLowerCase().replace(/[^.a-z0-9]/g, '') || (/pdf/.test(f.mimetype) ? '.pdf' : '.jpg')).slice(0, 6);
          cb(null, rnd() + ext);
        },
      }),
      limits: { fileSize: 15 * 1024 * 1024 },
      fileFilter(_req, f, cb) {
        if (/^(application\/pdf|image\/(jpe?g|png|webp|heic|heif|gif))$/i.test(f.mimetype)) return cb(null, true);
        cb(new Error('Only a PDF or a picture (JPG, PNG, HEIC) can be uploaded.'));
      },
    }).single('file');
    fileUpload = (req, res, next) => up(req, res, (err) => (err ? res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'The file is over 15 MB.' : err.message }) : next()));
  } catch (_) { /* no multer: uploads off, signing still works */ }

  // ---- settings: the shop's standard wording, the address links use ------
  async function settings() {
    const r = await one(`SELECT value FROM warranty_settings WHERE key = 'agreement'`);
    return Object.assign({ text: '', public_base: '' }, r ? r.value : {});
  }
  app.get(W + '/agreement-settings', requireAdmin, async (req, res) => {
    try { res.json({ settings: await settings(), default_text: DEFAULT_TEXT, placeholders: PLACEHOLDERS }); } catch (e) { fail(res, e); }
  });
  app.put(W + '/agreement-settings', requireAdmin, (req, res, next) => requireManager(req, res, next), async (req, res) => {
    try {
      const b = req.body || {};
      let base = String(b.public_base || '').trim().replace(/\/+$/, '').slice(0, 200);
      if (base && !/^https?:\/\/[a-z0-9.\-]+(:\d+)?$/i.test(base)) throw httpError(400, 'The web address should look like https://till.yourshop.com');
      const text = String(b.text || '').trim().slice(0, 20000);
      const v = { text: text && text !== DEFAULT_TEXT.trim() ? text : '', public_base: base };
      await query(`INSERT INTO warranty_settings (key, value) VALUES ('agreement', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(v)]);
      res.json({ ok: true, settings: v });
    } catch (e) { fail(res, e); }
  });

  // ---- a plan's own agreement document (the shop's printed form, a maker's leaflet) --
  app.post(W + '/plans/:id/agreement-file', requireAdmin, (req, res, next) => requireManager(req, res, next), fileUpload, async (req, res) => {
    try {
      const p = await one('SELECT id FROM warranty_plans WHERE id = $1', [parseInt(req.params.id, 10) || 0]);
      if (!p) throw httpError(404, 'Plan not found');
      if (!req.file) throw httpError(400, 'No file came through. A PDF or a picture, up to 15 MB.');
      await query('UPDATE warranty_plans SET agreement_file = $2, agreement_file_name = $3, updated_at = NOW() WHERE id = $1',
        [p.id, URL0 + req.file.filename, String(req.file.originalname || 'agreement').slice(0, 150)]);
      res.json({ ok: true, url: URL0 + req.file.filename });
    } catch (e) { if (req.file) try { fs.unlinkSync(req.file.path); } catch (_) {} fail(res, e); }
  });
  app.delete(W + '/plans/:id/agreement-file', requireAdmin, (req, res, next) => requireManager(req, res, next), async (req, res) => {
    try {
      await query('UPDATE warranty_plans SET agreement_file = NULL, agreement_file_name = NULL, updated_at = NOW() WHERE id = $1', [parseInt(req.params.id, 10) || 0]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ---- what the wording is filled from ----------------------------------
  async function source(saleItemId, claimId) {
    let c = null, l = null;
    if (claimId) {
      c = await one(`SELECT wc.*, to_char(wc.sold_on, 'YYYY-MM-DD') AS sold_on, to_char(wc.warranty_until, 'YYYY-MM-DD') AS warranty_until,
                            COALESCE(p.name, wc.product_img) AS product_name, p.sku, ps.receipt_number
                       FROM warranty_claims wc LEFT JOIN products p ON p.img = wc.product_img LEFT JOIN pos_sales ps ON ps.id = wc.sale_id WHERE wc.id = $1`, [claimId]);
      if (!c) throw httpError(404, 'Claim not found');
      if (c.sale_item_id && !saleItemId) saleItemId = c.sale_item_id;
    }
    if (saleItemId) {
      l = await one(`SELECT psi.id AS sale_item_id, psi.sale_id, psi.product_img, psi.serial_number, psi.warranty_terms,
                            to_char(psi.warranty_until, 'YYYY-MM-DD') AS warranty_until,
                            to_char(ps.created_at AT TIME ZONE 'America/Jamaica', 'YYYY-MM-DD') AS sold_on,
                            ps.receipt_number, ps.customer_name, ps.customer_phone, ps.vehicle_info, cu.email AS customer_email,
                            COALESCE(p.name, psi.description) AS product_name, p.sku
                       FROM pos_sale_items psi JOIN pos_sales ps ON ps.id = psi.sale_id
                       LEFT JOIN products p ON p.img = psi.product_img LEFT JOIN users cu ON cu.id = ps.customer_id
                      WHERE psi.id = $1`, [saleItemId]);
      if (!l) throw httpError(404, 'Sale line not found');
    }
    if (!l && !c) throw httpError(400, 'Pick a sold part or a claim');
    const terms = c && c.terms ? c.terms : l ? await lineTerms(l) : {};
    const s = Object.assign({}, l || {}, c ? {
      customer_name: c.customer_name || (l && l.customer_name), customer_phone: c.customer_phone || (l && l.customer_phone),
      customer_email: c.customer_email || (l && l.customer_email), serial_number: c.serial || (l && l.serial_number), model_number: c.model_number,
      vehicle_info: c.vehicle || (l && l.vehicle_info), product_name: c.product_name || (l && l.product_name), sku: c.sku || (l && l.sku),
      receipt_number: c.receipt_number || (l && l.receipt_number), sold_on: c.sold_on || (l && l.sold_on), warranty_until: c.warranty_until || (l && l.warranty_until),
    } : {});
    return { s, terms, saleItemId: l ? l.sale_item_id : null, saleId: l ? l.sale_id : (c && c.sale_id) || null, claimId: c ? c.id : null };
  }
  function values(s, terms, shop) {
    const t = terms || {}, days = t.period_days;
    const needs = [];
    if (t.needs_id) needs.push('photo ID (ID card, licence, passport or TRN)');
    if (t.needs_serial) needs.push('the serial number on the part');
    if (t.needs_model) needs.push('the model number');
    if (t.return_old) needs.push('the faulty part (it must be handed back)');
    if (t.needs_photo) needs.push('photos of the fault');
    return {
      shop: shop.name || 'Morty\'s Auto Parts', shop_phone: shop.phone || '',
      customer: s.customer_name || '', phone: s.customer_phone || '', email: s.customer_email || '',
      part: s.product_name || '', sku: s.sku || '', serial: s.serial_number || '', model: s.model_number || '',
      receipt: s.receipt_number || '', sold_on: fmtDate(s.sold_on), until: fmtDate(s.warranty_until), vehicle: s.vehicle_info || '',
      period: days ? days + ' days' + (days % 365 === 0 ? ' (' + (days / 365) + ' year' + (days / 365 > 1 ? 's' : '') + ')' : days % 30 === 0 && days < 365 ? ' (' + (days / 30) + ' months)' : '') : '',
      plan: t.name || '', rule: t.method ? ruleText(t) : '',
      remedy: t.remedy === 'refund' ? 'A covered fault is settled with a refund.' : t.remedy === 'either' ? 'A covered fault is settled with a replacement or a refund, at the shop\'s choice.' : t.method ? 'A covered fault is settled with a replacement part.' : '',
      labour: t.method ? (t.labour_covered ? 'Fitting labour for the replacement is covered.' : 'Fitting labour is not covered.') : '',
      maker: t.maker_warranty ? 'The part is also under the maker\'s warranty' + (t.maker_name ? ' (' + t.maker_name + ')' : '') + '; the shop handles the claim with the maker.' : '',
      needs: needs.length ? 'Also bring ' + needs.join(', ') + '.' : '',
      notes: t.notes || '', today: fmtDate(new Date()),
    };
  }
  async function wording(terms) {
    if (terms && terms.plan_id) {
      const p = await one('SELECT agreement_text, agreement_file, agreement_file_name FROM warranty_plans WHERE id = $1', [terms.plan_id]);
      if (p) return { text: p.agreement_text && p.agreement_text.trim() ? p.agreement_text : null, file: p.agreement_file, file_name: p.agreement_file_name };
    }
    return { text: null, file: null, file_name: null };
  }

  // ---- agreements --------------------------------------------------------
  const A_SQL = `SELECT a.*, to_char(a.signed_at AT TIME ZONE 'America/Jamaica', 'YYYY-MM-DD HH24:MI') AS signed_local,
                        cb.name AS created_by_name, wb.name AS witness_name, fb.name AS file_by_name,
                        (a.token_hash IS NOT NULL AND a.token_expires > NOW()) AS link_live
                   FROM warranty_agreements a LEFT JOIN users cb ON cb.id = a.created_by LEFT JOIN users wb ON wb.id = a.witness_by LEFT JOIN users fb ON fb.id = a.file_by`;
  const clean = (a) => { if (!a) return a; delete a.token_hash; return a; };
  const hist = (what, by, extra) => JSON.stringify([Object.assign({ at: new Date().toISOString(), what, by: by || null }, extra || {})]);

  app.get(W + '/agreements', requireAdmin, async (req, res) => {
    try {
      const li = parseInt(req.query.sale_item_id, 10) || null, ci = parseInt(req.query.claim_id, 10) || null;
      if (!li && !ci) throw httpError(400, 'Pick a sold part or a claim');
      const { rows } = await query(A_SQL + ` WHERE ($1::int IS NOT NULL AND a.sale_item_id = $1) OR ($2::int IS NOT NULL AND a.claim_id = $2) ORDER BY (a.status = 'void'), a.id DESC`, [li, ci]);
      res.json({ agreements: rows.map(clean) });
    } catch (e) { fail(res, e); }
  });
  // Make the agreement (or hand back the one already there for this part / claim).
  app.post(W + '/agreements', requireAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      const src = await source(parseInt(b.sale_item_id, 10) || null, parseInt(b.claim_id, 10) || null);
      const have = await one(A_SQL + ` WHERE a.status <> 'void' AND (($1::int IS NOT NULL AND a.sale_item_id = $1) OR ($1::int IS NULL AND a.claim_id = $2)) ORDER BY a.id DESC LIMIT 1`,
        [src.saleItemId, src.claimId]);
      if (have) {
        if (src.claimId && !have.claim_id) await query('UPDATE warranty_agreements SET claim_id = $2 WHERE id = $1', [have.id, src.claimId]);
        return res.json({ agreement: clean(have), existing: true });
      }
      const email = b.customer_email ? String(b.customer_email).trim().slice(0, 200) : src.s.customer_email || null;
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw httpError(400, 'That email address does not look right');
      src.s.customer_email = email;
      const shop = (await getShop().catch(() => ({}))) || {};
      const w = await wording(src.terms);
      const st = await settings();
      const body = fill(w.text || st.text || DEFAULT_TEXT, values(src.s, src.terms, shop));
      const title = 'Warranty agreement · ' + (src.s.product_name || 'part') + (src.s.receipt_number ? ' · ' + src.s.receipt_number : '');
      const r = await one(`INSERT INTO warranty_agreements (sale_item_id, sale_id, claim_id, plan_id, title, body, doc_url, doc_name, customer_name, customer_email, customer_phone, created_by, history)
                           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb) RETURNING id`,
        [src.saleItemId, src.saleId, src.claimId, src.terms.plan_id || null, title.slice(0, 200), body, w.file, w.file_name, src.s.customer_name || null, email, src.s.customer_phone || null,
          req.session.userId, hist('made', req.session.userId)]);
      res.json({ agreement: clean(await one(A_SQL + ' WHERE a.id = $1', [r.id])) });
    } catch (e) { fail(res, e); }
  });
  app.get(W + '/agreements/:id', requireAdmin, async (req, res) => {
    try {
      const a = await one(A_SQL + ' WHERE a.id = $1', [parseInt(req.params.id, 10) || 0]);
      if (!a) throw httpError(404, 'Agreement not found');
      res.json({ agreement: clean(a), base: await baseFor(req) });
    } catch (e) { fail(res, e); }
  });
  async function getOpen(id) {
    const a = await one('SELECT * FROM warranty_agreements WHERE id = $1', [parseInt(id, 10) || 0]);
    if (!a) throw httpError(404, 'Agreement not found');
    if (a.status === 'void') throw httpError(409, 'This agreement was cancelled. Make a new one.');
    return a;
  }

  // The signature: a PNG from the signing pad, as a data URL.
  function readSignature(dataUrl) {
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
    if (!m) throw httpError(400, 'Sign in the box first.');
    const buf = Buffer.from(m[1], 'base64');
    if (buf.length < 200 || buf.length > 600 * 1024 || buf.readUInt32BE(0) !== 0x89504e47) throw httpError(400, 'The signature did not come through. Clear it and sign again.');
    return buf;
  }
  async function sign(a, b, how) {
    if (a.status === 'signed') throw httpError(409, 'This agreement is already signed.');
    const name = String(b.name || '').trim().replace(/\s+/g, ' ').slice(0, 120);
    if (name.length < 2) throw httpError(400, 'Type the full name of the person signing.');
    if (!(b.agree === true || b.agree === 'true')) throw httpError(400, 'Tick the box to say the terms were read and accepted.');
    const png = readSignature(b.signature);
    fs.mkdirSync(DIR, { recursive: true });
    const file = rnd() + '.png';
    fs.writeFileSync(path.join(DIR, file), png);
    const at = new Date();
    const hash = sha([a.body, name, at.toISOString(), sha(png)].join('\n'));
    const r = await query(`UPDATE warranty_agreements SET status = 'signed', signed_name = $2, signature_url = $3, signed_at = $4, signed_ip = $5, signed_device = $6,
                                  signed_via = $7, witness_by = $8, doc_hash = $9, token_expires = CASE WHEN token_hash IS NULL THEN NULL ELSE NOW() + INTERVAL '30 days' END,
                                  updated_at = NOW(), history = history || $10::jsonb
                            WHERE id = $1 AND status <> 'signed' AND status <> 'void' RETURNING id`,
      [a.id, name, URL0 + file, at, how.ip ? String(how.ip).slice(0, 60) : null, how.ua ? String(how.ua).slice(0, 200) : null, how.via, how.by || null, hash,
        hist(how.via === 'link' ? 'signed on their own device' : 'signed at the counter', how.by, { name })]);
    if (!r.rows.length) { try { fs.unlinkSync(path.join(DIR, file)); } catch (_) {} throw httpError(409, 'This agreement is already signed.'); }
    const done = await one(A_SQL + ' WHERE a.id = $1', [a.id]);
    // A copy to the customer, and a note under the bell for whoever made it (link signing only).
    if (done.customer_email && b.email_copy !== false) await emailCopy(done, how.by, how.base).catch(() => {});
    if (how.via === 'link' && notice && done.created_by) {
      try { await notice([done.created_by], { kind: 'memo', title: '📝 Warranty agreement signed', body: (done.signed_name || '') + ' · ' + done.title.replace(/^Warranty agreement · /, ''), link: done.claim_id ? '/warranty.html#claim/' + done.claim_id : '/warranty.html#register' }); } catch (_) {}
    }
    return done;
  }
  app.post(W + '/agreements/:id/sign', requireAdmin, async (req, res) => {
    try {
      const a = await getOpen(req.params.id);
      const done = await sign(a, req.body || {}, { via: 'counter', by: req.session.userId, ip: req.ip, ua: req.get('user-agent'), base: await baseFor(req) });
      res.json({ ok: true, agreement: clean(done) });
    } catch (e) { fail(res, e); }
  });

  async function baseFor(req) {
    const st = await settings();
    return st.public_base || (req.protocol + '://' + req.get('host'));
  }
  // A link for the customer's own phone: shown as a QR code and / or emailed.
  app.post(W + '/agreements/:id/link', requireAdmin, async (req, res) => {
    try {
      const a = await getOpen(req.params.id);
      if (a.status === 'signed') throw httpError(409, 'This agreement is already signed.');
      const b = req.body || {};
      const token = crypto.randomBytes(24).toString('base64url');
      const url = (await baseFor(req)) + '/warranty-sign.html#' + token;
      let email = b.email !== undefined ? String(b.email || '').trim().slice(0, 200) : a.customer_email;
      if (b.send_email && !email) throw httpError(400, 'Type the customer\'s email address.');
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw httpError(400, 'That email address does not look right');
      await query(`UPDATE warranty_agreements SET token_hash = $2, token_expires = NOW() + ($3 || ' days')::interval, customer_email = COALESCE($4, customer_email),
                          updated_at = NOW(), history = history || $5::jsonb WHERE id = $1`,
        [a.id, sha(token), String(LINK_DAYS), email || null, hist(b.send_email ? 'link emailed' : 'link made', req.session.userId, b.send_email ? { to: email } : null)]);
      let sent = null;
      if (b.send_email) {
        const shop = (await getShop().catch(() => ({}))) || {};
        const first = String(a.customer_name || '').split(' ')[0] || 'there';
        const text = 'Hi ' + first + ',\n\nPlease read and sign the warranty agreement for ' + a.title.replace(/^Warranty agreement · /, '') + ':\n\n' + url +
          '\n\nThe link works for ' + LINK_DAYS + ' days. You sign with your finger or mouse; no account is needed.\n\n' + (shop.name || 'Morty\'s Auto Parts') + (shop.phone ? ' · ' + shop.phone : '');
        sent = await mail(email, 'Please sign your warranty agreement · ' + (shop.name || 'Morty\'s Auto Parts'), text);
        await query('UPDATE warranty_agreements SET link_sent_to = $2 WHERE id = $1', [a.id, email]);
      }
      res.json({ ok: true, url, expires_days: LINK_DAYS, email: sent });
    } catch (e) { fail(res, e); }
  });
  async function mail(to, subject, text) {
    if (!mailer || !mailer.sendEmail) return { outcome: 'skipped', error: 'Email is not available on this server' };
    try {
      const html = '<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#0f1720">' +
        String(text).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch])).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>').replace(/\n/g, '<br>') + '</div>';
      const r = await mailer.sendEmail({ to, subject, text, html });
      return r && r.stubbed ? { outcome: 'not set up', error: 'Email (SMTP) is not set up yet, so it was not sent' } : { outcome: 'sent' };
    } catch (e) { return { outcome: 'failed', error: e.message }; }
  }
  async function emailCopy(a, by, base) {
    const shop = (await getShop().catch(() => ({}))) || {};
    const text = a.body + '\n\n— Signed by ' + a.signed_name + ' on ' + fmtDate(a.signed_at) + ' ' + new Date(a.signed_at).toISOString().slice(11, 16) + ' UTC' +
      (a.signed_via === 'link' ? ' (on their own device)' : ' (at the counter)') + '.\nFingerprint: ' + a.doc_hash +
      (a.doc_url && base ? '\nThe plan\'s warranty document: ' + base + a.doc_url : '') + '\n\nKeep this email with your receipt.\n' + (shop.name || 'Morty\'s Auto Parts') + (shop.phone ? ' · ' + shop.phone : '');
    const r = await mail(a.customer_email, 'Your signed warranty agreement · ' + (shop.name || 'Morty\'s Auto Parts'), text);
    await query('UPDATE warranty_agreements SET history = history || $2::jsonb WHERE id = $1', [a.id, hist('copy emailed: ' + r.outcome, by, { to: a.customer_email })]);
    return r;
  }
  app.post(W + '/agreements/:id/email-copy', requireAdmin, async (req, res) => {
    try {
      const a = await one(A_SQL + ' WHERE a.id = $1', [parseInt(req.params.id, 10) || 0]);
      if (!a) throw httpError(404, 'Agreement not found');
      if (a.status !== 'signed') throw httpError(400, 'It is not signed yet.');
      const em = req.body && req.body.email ? String(req.body.email).trim() : a.customer_email;
      if (!em || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) throw httpError(400, 'Type the customer\'s email address.');
      if (em !== a.customer_email) { await query('UPDATE warranty_agreements SET customer_email = $2 WHERE id = $1', [a.id, em]); a.customer_email = em; }
      res.json({ ok: true, email: await emailCopy(a, req.session.userId, await baseFor(req)) });
    } catch (e) { fail(res, e); }
  });
  // A signed paper copy: scan, photo or PDF.
  app.post(W + '/agreements/:id/file', requireAdmin, fileUpload, async (req, res) => {
    try {
      const a = await getOpen(req.params.id);
      if (!req.file) throw httpError(400, 'No file came through. A PDF or a picture, up to 15 MB.');
      const signer = req.body && req.body.signed_name ? String(req.body.signed_name).trim().slice(0, 120) : null;
      await query(`UPDATE warranty_agreements SET file_url = $2, file_name = $3, file_by = $4, file_at = NOW(),
                          status = CASE WHEN status = 'signed' THEN status ELSE 'uploaded' END, signed_name = COALESCE(signed_name, $5),
                          updated_at = NOW(), history = history || $6::jsonb WHERE id = $1`,
        [a.id, URL0 + req.file.filename, String(req.file.originalname || 'signed copy').slice(0, 150), req.session.userId, signer, hist('signed paper copy uploaded', req.session.userId)]);
      res.json({ ok: true, agreement: clean(await one(A_SQL + ' WHERE a.id = $1', [a.id])) });
    } catch (e) { if (req.file) try { fs.unlinkSync(req.file.path); } catch (_) {} fail(res, e); }
  });
  // Cancel (wrong customer, wrong part). A signed one needs a manager / refund right.
  app.post(W + '/agreements/:id/void', requireAdmin, async (req, res) => {
    try {
      const a = await getOpen(req.params.id);
      const why = String((req.body && req.body.reason) || '').trim().slice(0, 300);
      if (!why) throw httpError(400, 'Say why it is being cancelled.');
      if (a.status !== 'waiting' && !(await userCan(req, 'pos.refund'))) throw httpError(403, 'Only a manager can cancel a signed agreement.');
      await query(`UPDATE warranty_agreements SET status = 'void', void_reason = $2, token_hash = NULL, updated_at = NOW(), history = history || $3::jsonb WHERE id = $1`,
        [a.id, why, hist('cancelled', req.session.userId, { why })]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ---- the printable copy ------------------------------------------------
  const escH = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  function copyHtml(a, shop) {
    const signed = a.status === 'signed';
    return '<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="icon" href="/favicon.svg?v=vision2" type="image/svg+xml"><link rel="icon" href="/favicon.ico?v=vision2" sizes="any"><link rel="apple-touch-icon" href="/apple-touch-icon.png?v=vision2"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + escH(a.title) + '</title>' +
      '<style>body{font:14px/1.55 Georgia,"Times New Roman",serif;color:#111;background:#fff;margin:0;padding:24px;max-width:780px;margin:0 auto}' +
      'h1{font:700 18px Arial,sans-serif;margin:0}.top{display:flex;justify-content:space-between;gap:12px;border-bottom:2px solid #111;padding-bottom:8px;margin-bottom:14px;font-family:Arial,sans-serif}' +
      '.body{white-space:pre-wrap}.sig{margin-top:22px;border-top:1px solid #999;padding-top:10px;display:grid;grid-template-columns:1fr 1fr;gap:16px;font-family:Arial,sans-serif;font-size:12.5px}' +
      '.sig img{max-width:300px;max-height:110px;display:block;border-bottom:1px solid #111}.fp{font:11px ui-monospace,Consolas,monospace;word-break:break-all;color:#444;margin-top:10px}' +
      '.line{border-bottom:1px solid #111;height:60px}.bar{font-family:Arial,sans-serif;margin-bottom:14px}button{font:600 14px Arial,sans-serif;padding:8px 14px;border-radius:8px;border:1px solid #ccc;background:#fff;cursor:pointer}' +
      '@media print{.bar{display:none}body{padding:0}}</style></head><body>' +
      '<div class="bar"><button onclick="window.print()">🖨 Print or save as PDF</button></div>' +
      '<div class="top"><div><h1>' + escH(shop.name || 'Morty\'s Auto Parts') + '</h1><div>' + escH([shop.phone, shop.email].filter(Boolean).join(' · ')) + '</div></div><div style="text-align:right">WA-' + String(a.id).padStart(5, '0') + '<br>' + escH(fmtDate(a.created_at)) + '</div></div>' +
      '<div class="body">' + escH(a.body) + '</div>' +
      (a.doc_url ? '<p style="font-family:Arial,sans-serif;font-size:12.5px">The warranty document for this plan: ' + escH(a.doc_name || 'document') + '</p>' : '') +
      '<div class="sig"><div>' + (signed ? '<img src="' + escH(a.signature_url) + '" alt="signature">' : '<div class="line"></div>') +
        'Customer: <b>' + escH(a.signed_name || a.customer_name || '') + '</b><br>' + (signed ? 'Signed ' + escH(fmtDate(a.signed_at)) + ' ' + escH(new Date(a.signed_at).toISOString().slice(11, 16)) + ' UTC, ' + (a.signed_via === 'link' ? 'on their own device' : 'at the counter') : 'Date:') + '</div>' +
        '<div><div class="line">' + '</div>For the shop: <b>' + escH(a.witness_name || a.created_by_name || '') + '</b></div></div>' +
      (signed ? '<div class="fp">Fingerprint (SHA-256 of the wording, name, time and signature): ' + escH(a.doc_hash) + '</div>' : '') +
      '</body></html>';
  }
  app.get(W + '/agreements/:id/copy', requireAdmin, async (req, res) => {
    try {
      const a = await one(A_SQL + ' WHERE a.id = $1', [parseInt(req.params.id, 10) || 0]);
      if (!a) throw httpError(404, 'Agreement not found');
      res.type('html').send(copyHtml(a, (await getShop().catch(() => ({}))) || {}));
    } catch (e) { fail(res, e); }
  });

  // ---- the customer's page (no sign-in: the link is the key) --------------
  const hits = new Map();
  function slow(req) {
    const k = req.ip || 'x', now = Date.now(), h = hits.get(k) || { n: 0, t: now };
    if (now - h.t > 10 * 60 * 1000) { h.n = 0; h.t = now; }
    h.n++; hits.set(k, h);
    if (hits.size > 5000) hits.clear();
    if (h.n > 60) throw httpError(429, 'Too many tries. Wait a few minutes and open the link again.');
  }
  async function byToken(req) {
    slow(req);
    await ensure(query);
    const t = String(req.params.token || '');
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(t)) throw httpError(404, 'This link is not right. Ask the shop for a new one.');
    const a = await one(A_SQL + ' WHERE a.token_hash = $1', [sha(t)]);
    if (!a || a.status === 'void') throw httpError(404, 'This link is not in use any more. Ask the shop for a new one.');
    if (!a.link_live) throw httpError(410, 'This link has run out. Ask the shop for a new one.');
    return a;
  }
  const P = '/api/warranty-sign/:token';
  app.get(P, async (req, res) => {
    try {
      const a = await byToken(req);
      const seen = (a.history || []).some((h) => h.what === 'opened by the customer');
      if (!seen) await query('UPDATE warranty_agreements SET history = history || $2::jsonb WHERE id = $1', [a.id, hist('opened by the customer', null)]);
      const shop = (await getShop().catch(() => ({}))) || {};
      res.json({ shop: { name: shop.name || 'Morty\'s Auto Parts', phone: shop.phone || null }, title: a.title, body: a.body, doc_url: a.doc_url, doc_name: a.doc_name,
        customer_name: a.customer_name, customer_email: a.customer_email, status: a.status, signed_name: a.signed_name, signed_at: a.signed_at,
        signature_url: a.status === 'signed' ? a.signature_url : null, doc_hash: a.status === 'signed' ? a.doc_hash : null, no: 'WA-' + String(a.id).padStart(5, '0') });
    } catch (e) { fail(res, e); }
  });
  app.post(P, async (req, res) => {
    try {
      const a = await byToken(req);
      const st = await settings();
      const done = await sign(a, req.body || {}, { via: 'link', ip: req.ip, ua: req.get('user-agent'), base: st.public_base || (req.protocol + '://' + req.get('host')) });
      res.json({ ok: true, signed_name: done.signed_name, signed_at: done.signed_at, doc_hash: done.doc_hash, emailed: !!done.customer_email });
    } catch (e) { fail(res, e); }
  });
  app.get(P + '/copy', async (req, res) => {
    try {
      const a = await byToken(req);
      res.type('html').send(copyHtml(a, (await getShop().catch(() => ({}))) || {}));
    } catch (e) { res.status(e.status || 500).type('text/plain').send(e.publicMessage || 'Something went wrong.'); }
  });

  return { settings };
}

// Is the agreement for this claim (its sale line, or the claim itself) signed or a signed copy uploaded?
async function signedFor(query, claim) {
  try {
    const r = await query(`SELECT 1 FROM warranty_agreements WHERE status IN ('signed', 'uploaded')
                             AND ((sale_item_id IS NOT NULL AND sale_item_id = $1) OR claim_id = $2) LIMIT 1`, [claim.sale_item_id || null, claim.id]);
    return r.rows.length > 0;
  } catch (_) { return false; }
}

module.exports = { register, signedFor, fill, DEFAULT_TEXT, PLACEHOLDERS };
