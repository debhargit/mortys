'use strict';
// =============================================================================
//  Morty's Auto Parts -- supplier invoices in, signed customer invoices out
//
//  Mounted by server.js:  require('./invoice-docs').register(app, deps)
//  Tables in schema.sql ("INVOICE SCANNING AND SIGNATURES").
//
//  Reading a supplier invoice
//    POST /api/invoice-scan  (a photo, scan or PDF of the supplier's invoice)
//    Claude reads it into supplier, number, dates, lines, GCT, freight and
//    total, and the till matches what it can: the supplier (name or TRN), parts
//    by SKU, and the supplier's open purchase orders. Nothing is saved here:
//    Payables -> Enter a bill and Receive stock fill their own forms from it,
//    the person checks them, and the original is filed in the document centre
//    against the bill once that is saved. Needs ANTHROPIC_API_KEY (the same key
//    as the assistant); without one the screens say so and are typed by hand.
//
//  Signatures on customer invoices (A/R invoices raised on the books)
//    In person   the customer signs on the screen (tablet or touch till), with
//                the staff member signed in as witness.
//    Remote      a one-time link (14 days by default) emailed to the customer,
//                or copied into WhatsApp; they read the invoice and sign it on
//                their phone at till.mortsautoparts.com/sign-invoice.html.
//    Either way the signature is sealed: a SHA-256 of the invoice's contents
//    (number, dates, customer, lines, GCT, total) is kept with it, and an HMAC
//    (SESSION_SECRET) over that hash, the signer, the time, the picture, and
//    where it came from (email, address, witness, link). SESSION_SECRET must
//    never change once signatures exist, or every seal reads as broken. The
//    invoice's signing panel re-checks both, so a changed invoice or an edited
//    signature row shows as broken. A signed copy (invoice, signature, seal and
//    audit line) is filed in the document centre against the invoice and the
//    customer. POS charge sales are not covered here: they are signed at the till.
// =============================================================================
const crypto = require('crypto');
const path = require('path');

function loadSdk() {
  for (const p of ['@anthropic-ai/sdk', path.join(__dirname, '..', 'data', 'ai-deps', 'node_modules', '@anthropic-ai', 'sdk')]) {
    try { return require(p); } catch (_) {}
  }
  return null;
}

// What the model fills in. Unknown text is '', unknown amounts are null.
const num = { anyOf: [{ type: 'number' }, { type: 'null' }] };
const SCAN_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['is_invoice', 'supplier_name', 'supplier_tax_id', 'invoice_number', 'invoice_date', 'due_date', 'currency', 'subtotal', 'tax', 'freight', 'total', 'lines', 'notes'],
  properties: {
    is_invoice: { type: 'boolean' },
    supplier_name: { type: 'string' }, supplier_tax_id: { type: 'string' },
    invoice_number: { type: 'string' }, invoice_date: { type: 'string' }, due_date: { type: 'string' },
    currency: { type: 'string' }, subtotal: num, tax: num, freight: num, total: num,
    lines: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['sku', 'description', 'qty', 'unit_cost', 'amount'],
      properties: { sku: { type: 'string' }, description: { type: 'string' }, qty: num, unit_cost: num, amount: num } } },
    notes: { type: 'string' },
  },
};
const SCAN_PROMPT = [
  'This is a supplier\'s invoice (or bill, or delivery note with prices) received by Morty\'s Auto Parts, an auto-parts shop in Jamaica.',
  'Read it into the JSON fields. Rules:',
  '- is_invoice: false if the picture is not an invoice, bill or priced delivery note; then leave the rest empty.',
  '- supplier_name: the company that issued it (not Morty\'s Auto Parts). supplier_tax_id: their TRN or tax number if printed.',
  '- Dates as YYYY-MM-DD; "" if not printed. Read day/month order the way the document does (Jamaica normally writes DD/MM/YYYY).',
  '- currency: the 3-letter code (JMD for J$ or JA$, USD for US$); "" if unclear.',
  '- subtotal: goods before tax and freight. tax: GCT / VAT / sales tax. freight: freight, delivery, shipping or duty charged. total: the amount due at the bottom. null when not printed.',
  '- lines: one per item line, in order. sku: the part / item / catalogue number as printed ("" if none). qty: quantity supplied (shipped, not back-ordered). unit_cost: price per unit before tax. amount: the line total. Leave out freight, tax and discount summary lines.',
  '- Copy numbers exactly as printed, without currency signs or thousands separators. Never guess a value you cannot read: use "" or null.',
  '- notes: anything a person should check (illegible parts, back-ordered lines, a credit note rather than an invoice), in one or two short sentences; "" if nothing.',
].join('\n');
const MEDIA = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };

function register(app, deps) {
  const { query, requireAdmin, requireManager, requireCap, userCan, mailer, getShop, docs, devMode } = deps;
  const n = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const r2 = (v) => Math.round(Number(v || 0) * 100) / 100;
  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !isNaN(Date.parse(v));
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (v) => 'J$' + r2(v).toLocaleString('en-JM', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  function httpError(status, msg) { const e = new Error(msg); e.status = status; return e; }
  const fail = (res, e) => { if (!e.status) console.error('[invoice-docs]', e); res.status(e.status || 500).json({ error: e.status ? e.message : 'Server error' }); };
  // req.ip, resolved through trust proxy: a raw cf-connecting-ip read could be
  // set to anything by a caller reaching the till directly on the LAN.
  const ipOf = (req) => String(req.ip || '').replace(/^::ffff:/, '').slice(0, 64);
  const TILL = (process.env.TILL_PUBLIC_URL || 'https://till.mortsautoparts.com').replace(/\/$/, '');
  // No published fallback key outside development: without SESSION_SECRET,
  // signing is refused rather than sealed with a key anyone can read.
  const SECRET = process.env.SESSION_SECRET || (devMode ? 'vision-dev-secret' : null);
  const AR = [requireAdmin, requireCap('ar.manage')];
  // Payables staff, or a manager receiving stock.
  const SCAN = [requireAdmin, async (req, res, next) => ((await userCan(req, 'ap.manage')) ? next() : requireManager(req, res, next))];

  let upload = null;
  try {
    const multer = require('multer');
    upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } }).single('file');
  } catch (_) { console.warn('[invoice-docs] multer missing: invoice reading disabled'); }
  const one = (req, res) => new Promise((resolve, reject) => {
    if (!upload) return reject(httpError(503, 'Uploads are not available on this server'));
    upload(req, res, (err) => (err ? reject(httpError(400, err.code === 'LIMIT_FILE_SIZE' ? 'The file must be 20 MB or smaller' : 'Could not read the upload')) : resolve(req.file)));
  });

  // ============================================================ READ AN INVOICE ==
  let client = null;
  function getClient() {
    if (client) return client;
    if (!process.env.ANTHROPIC_API_KEY) return null;
    const sdk = loadSdk(); if (!sdk) return null;
    const Anthropic = sdk.Anthropic || sdk.default || sdk;
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 2, timeout: 180000 });
    return client;
  }
  // Development only: VISION_DEV=1 and VISION_INVOICE_FAKE=1 take a .json file of the
  // fields above as "what the model read" (or, for a picture or PDF, the .json file
  // named by VISION_INVOICE_FAKE_FILE), so the screens can be tested at no cost.
  const FAKE = devMode && process.env.VISION_INVOICE_FAKE === '1';

  async function readInvoice(f) {
    const ext = path.extname(f.originalname || '').slice(1).toLowerCase();
    if (FAKE && ext === 'json') return JSON.parse(f.buffer.toString('utf8'));
    if (FAKE && process.env.VISION_INVOICE_FAKE_FILE) return JSON.parse(require('fs').readFileSync(process.env.VISION_INVOICE_FAKE_FILE, 'utf8'));
    const media = MEDIA[ext] || (Object.values(MEDIA).includes(f.mimetype) ? f.mimetype : null);
    if (!media) throw httpError(400, 'Send a photo (JPG, PNG, WebP) or a PDF of the invoice');
    const c = getClient();
    if (!c) throw httpError(503, 'Invoice reading is not set up on this till (no Claude API key). Type the invoice in instead.');
    const { rows: st } = await query(`SELECT value FROM warehouse_settings WHERE key = 'ai_model'`).catch(() => ({ rows: [] }));
    const data = f.buffer.toString('base64');
    const block = media === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: media, data } }
      : { type: 'image', source: { type: 'base64', media_type: media, data } };
    let resp;
    try {
      resp = await c.beta.messages.create({
        model: (st[0] && st[0].value) || 'claude-opus-5-5', max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
        output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCAN_SCHEMA } },
        messages: [{ role: 'user', content: [block, { type: 'text', text: SCAN_PROMPT }] }],
      });
    } catch (e) {
      console.error('[invoice-scan]', e.status || '', e.message);
      throw httpError(502, e.status === 400 ? 'The file could not be read (is it a clear photo or a normal PDF?)' : 'The invoice reader is not answering. Try again, or type it in.');
    }
    if (resp.stop_reason === 'refusal') throw httpError(422, 'The invoice could not be read. Type it in instead.');
    if (resp.stop_reason === 'max_tokens') throw httpError(422, 'The invoice is too long to read in one go. Type it in, or send fewer pages.');
    const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    try { return JSON.parse(text); } catch (_) { throw httpError(502, 'The invoice reader gave an unreadable answer. Try again.'); }
  }

  function clean(x) {
    const s = (v, len) => String(v == null ? '' : v).trim().slice(0, len || 200);
    const d = (v) => (isDate(v) ? v : '');
    return {
      is_invoice: x.is_invoice !== false, supplier_name: s(x.supplier_name), supplier_tax_id: s(x.supplier_tax_id, 40), invoice_number: s(x.invoice_number, 60),
      invoice_date: d(x.invoice_date), due_date: d(x.due_date), currency: s(x.currency, 3).toUpperCase(),
      subtotal: n(x.subtotal), tax: n(x.tax), freight: n(x.freight), total: n(x.total), notes: s(x.notes, 500),
      lines: (Array.isArray(x.lines) ? x.lines : []).slice(0, 200).map((l) => ({ sku: s(l.sku, 60), description: s(l.description), qty: n(l.qty), unit_cost: n(l.unit_cost), amount: n(l.amount) }))
        .filter((l) => l.description || l.sku),
    };
  }

  app.post('/api/invoice-scan', ...SCAN, async (req, res) => {
    try {
      const f = await one(req, res); if (!f) throw httpError(400, 'Choose the invoice picture or PDF');
      const inv = clean(await readInvoice(f));
      // The supplier: TRN first, then the name (exact, then contained either way).
      let supplier = null;
      const tid = inv.supplier_tax_id.replace(/\D/g, '');
      if (tid.length >= 6) supplier = (await query(`SELECT id, name FROM suppliers WHERE regexp_replace(COALESCE(tax_id, ''), '\\D', '', 'g') = $1 LIMIT 1`, [tid]).catch(() => ({ rows: [] }))).rows[0] || null;
      if (!supplier && inv.supplier_name) {
        const nm = inv.supplier_name.toLowerCase().replace(/\b(ltd|limited|inc|co|company|jamaica)\b\.?/g, '').replace(/[^a-z0-9 ]+/g, ' ').trim();
        const { rows } = await query(`SELECT id, name FROM suppliers WHERE COALESCE(is_active, true) AND (lower(name) = $1 OR ($2 <> '' AND (lower(name) LIKE '%' || $2 || '%' OR $1 LIKE '%' || lower(name) || '%'))) ORDER BY (lower(name) = $1) DESC, length(name) LIMIT 1`,
          [inv.supplier_name.toLowerCase(), nm.length >= 3 ? nm : '']);
        supplier = rows[0] || null;
      }
      // Parts by SKU (case and spacing ignored).
      const key = (v) => String(v || '').toLowerCase().replace(/[\s-]+/g, '');
      const skus = [...new Set(inv.lines.map((l) => key(l.sku)).filter(Boolean))];
      const products = {};
      if (skus.length) {
        const { rows } = await query(`SELECT img, name, sku, cost_usd::float AS cost_usd, bin_location, stock_count FROM products WHERE lower(regexp_replace(sku, '[\\s-]+', '', 'g')) = ANY($1::text[])`, [skus]);
        for (const p of rows) products[key(p.sku)] = p;
      }
      for (const l of inv.lines) l.product = products[key(l.sku)] || null;
      const openPos = supplier ? (await query(`SELECT id, po_number, status, to_char(created_at, 'YYYY-MM-DD') AS day FROM purchase_orders WHERE supplier_id = $1 AND status NOT IN ('received', 'cancelled') ORDER BY id DESC LIMIT 20`, [supplier.id])).rows : [];
      res.json({ ok: true, invoice: inv, supplier, open_pos: openPos });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/invoice-scan/status', ...SCAN, (req, res) => res.json({ ready: FAKE || !!(process.env.ANTHROPIC_API_KEY && loadSdk()), fake: FAKE }));

  // ========================================================= SIGNED INVOICES ==
  // What a signature vouches for. Any change to these after signing breaks the seal.
  async function invoiceContent(id) {
    const { rows } = await query(
      `SELECT i.id, i.number, i.kind, to_char(i.invoice_date, 'YYYY-MM-DD') AS day, to_char(i.due_date, 'YYYY-MM-DD') AS due, i.memo, i.gct_amount::float AS gct, i.total::float AS total,
              i.voided_at, i.customer_id, COALESCE(NULLIF(u.name, ''), u.email) AS customer, u.account_number, u.email, u.company_name
         FROM ar_invoices i JOIN users u ON u.id = i.customer_id WHERE i.id = $1`, [id]);
    if (!rows.length) throw httpError(404, 'Invoice not found');
    const { rows: lines } = await query(`SELECT description, amount::float AS amount FROM ar_invoice_lines WHERE invoice_id = $1 ORDER BY id`, [id]);
    const i = rows[0];
    const hash = sha(JSON.stringify({ number: i.number, date: i.day, due: i.due, customer_id: i.customer_id, customer: i.customer, memo: i.memo || '',
      lines: lines.map((l) => [l.description || '', r2(l.amount)]), gct: r2(i.gct), total: r2(i.total) }));
    return { invoice: i, lines, hash };
  }
  // JSON, not a joined string, so no field can bleed into the next.
  const sealOf = (s) => (SECRET ? crypto.createHmac('sha256', SECRET).update(JSON.stringify([s.invoice_id, s.content_sha256, s.method, s.signer_name, new Date(s.signed_at).toISOString(), sha(s.image),
    s.signer_email || null, s.ip || null, s.witnessed_by || null, s.request_id || null])).digest('hex') : null);

  function invoiceHtml(shop, c, sig) {
    const i = c.invoice;
    return '<!doctype html><html><head><meta charset="utf-8"><title>Invoice ' + esc(i.number) + (sig ? ' (signed)' : '') + '</title><style>body{font:14px system-ui,sans-serif;margin:28px;max-width:760px;color:#111}table{width:100%;border-collapse:collapse}td,th{border-bottom:1px solid #ddd;padding:6px;text-align:left}td.n,th.n{text-align:right}.sig{margin-top:22px;border:1px solid #999;padding:12px}.sig img{max-width:360px;height:auto;border-bottom:1px solid #333;display:block}.small{color:#555;font-size:11.5px;word-break:break-all}</style></head><body>' +
      '<h2 style="margin:0">' + esc(shop.name || 'Morty\'s Auto Parts') + '</h2><div class="small">' + esc([shop.address, shop.phone, shop.email].filter(Boolean).join(' · ')) + '</div>' +
      '<h3>Invoice ' + esc(i.number) + '</h3><p>Bill to: <b>' + esc(i.company_name || i.customer) + '</b>' + (i.account_number ? ' (' + esc(i.account_number) + ')' : '') + '<br>Date: ' + esc(i.day) + (i.due ? ' · Due: ' + esc(i.due) : '') + '</p>' +
      (i.memo ? '<p>' + esc(i.memo) + '</p>' : '') +
      '<table><thead><tr><th>Description</th><th class="n">Amount</th></tr></thead><tbody>' + c.lines.map((l) => '<tr><td>' + esc(l.description || '') + '</td><td class="n">' + money(l.amount) + '</td></tr>').join('') +
      (i.gct ? '<tr><td>GCT</td><td class="n">' + money(i.gct) + '</td></tr>' : '') + '<tr><td><b>Total</b></td><td class="n"><b>' + money(i.total) + '</b></td></tr></tbody></table>' +
      (sig ? '<div class="sig"><p style="margin-top:0">I confirm I received the goods or services above and agree to pay ' + money(i.total) + (i.due ? ' by ' + esc(i.due) : '') + '.</p><img alt="Signature" src="' + sig.image + '"><p><b>' + esc(sig.signer_name) + '</b> · ' + esc(new Date(sig.signed_at).toISOString().replace('T', ' ').slice(0, 19)) + ' UTC</p>' +
        '<p class="small">' + (sig.method === 'in_person' ? 'Signed in person' + (sig.witness ? ', witnessed by ' + esc(sig.witness) : '') : 'Signed remotely from a link sent' + (sig.signer_email ? ' to ' + esc(sig.signer_email) : '') + ', from ' + esc(sig.ip || 'unknown address')) +
        '.<br>Invoice fingerprint (SHA-256): ' + esc(sig.content_sha256) + '<br>Seal: ' + esc(sig.seal) + '</p></div>' : '') +
      '</body></html>';
  }

  async function saveSignature(req, c, s) {
    const i = c.invoice;
    if (i.voided_at) throw httpError(409, 'This invoice is voided');
    if (!SECRET) throw httpError(503, 'Signing is not set up on this till (SESSION_SECRET is missing)');
    const name = String(s.name || '').trim().slice(0, 100);
    if (name.length < 2) throw httpError(400, 'Type the name of the person signing');
    const image = String(s.image || '');
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(image);
    if (!m || m[1].length > 400000) throw httpError(400, 'Sign in the box first');
    const png = Buffer.from(m[1], 'base64');
    if (png.length < 200 || png.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') throw httpError(400, 'Sign in the box first');
    const row = { invoice_id: i.id, content_sha256: c.hash, method: s.method, signer_name: name, signed_at: new Date(), image,
      signer_email: s.email || null, ip: ipOf(req), witnessed_by: s.witness_id || null, request_id: s.request_id || null };
    row.seal = sealOf(row);
    const { rows } = await query(
      `INSERT INTO invoice_signatures (invoice_id, method, signer_name, signer_email, image, content_sha256, seal, ip, user_agent, witnessed_by, request_id, signed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [i.id, s.method, name, row.signer_email, image, c.hash, row.seal, row.ip, String(req.headers['user-agent'] || '').slice(0, 300), row.witnessed_by, row.request_id, row.signed_at]);
    const id = rows[0].id;
    // The signed copy, filed against the invoice and the customer.
    let doc = null;
    if (docs && docs.fileHtml) {
      try {
        let witness = null;
        if (s.witness_id) witness = ((await query(`SELECT COALESCE(NULLIF(name, ''), email) AS n FROM users WHERE id = $1`, [s.witness_id])).rows[0] || {}).n;
        const html = invoiceHtml((await getShop()) || {}, c, Object.assign({}, row, { witness }));
        doc = await docs.fileHtml(req, { title: 'Signed invoice ' + i.number + ' - ' + i.customer, category: 'receivables', reference: i.number, issuer: name, issue_date: row.signed_at.toISOString().slice(0, 10),
          tags: 'signed invoice', html, file_name: 'Signed invoice ' + i.number, note: s.method === 'in_person' ? 'Signed in person' : 'Signed from a link',
          links: [{ type: 'invoice', id: i.id }, { type: 'customer', id: i.customer_id }] });
        await query(`UPDATE invoice_signatures SET document_id = $2 WHERE id = $1`, [id, doc.id]);
      } catch (e) { console.error('[invoice-docs] filing the signed copy', e.message); }
    }
    await query(`INSERT INTO ar_notes (customer_id, kind, note, created_by) VALUES ($1, 'note', $2, $3)`,
      [i.customer_id, 'Invoice ' + i.number + ' signed by ' + name + (s.method === 'in_person' ? ' in person' : ' from a link') + (doc ? ' (' + doc.number + ')' : ''), s.witness_id || null]).catch(() => {});
    return { id, document: doc };
  }

  async function signingState(c) {
    const { rows: sigs } = await query(
      `SELECT s.id, s.invoice_id, s.method, s.signer_name, s.signer_email, s.image, s.content_sha256, s.seal, s.ip, s.witnessed_by, s.request_id, s.signed_at, s.document_id, d.number AS document_number,
              COALESCE(NULLIF(w.name, ''), w.email) AS witness
         FROM invoice_signatures s LEFT JOIN documents d ON d.id = s.document_id LEFT JOIN users w ON w.id = s.witnessed_by WHERE s.invoice_id = $1 ORDER BY s.id`, [c.invoice.id]);
    const { rows: reqs } = await query(
      `SELECT r.id, r.sent_to, r.created_at, r.expires_at, r.used_at, r.cancelled_at, COALESCE(NULLIF(u.name, ''), u.email) AS sent_by
         FROM invoice_sign_requests r LEFT JOIN users u ON u.id = r.sent_by WHERE r.invoice_id = $1 ORDER BY r.id DESC LIMIT 10`, [c.invoice.id]);
    return {
      signatures: sigs.map((s) => ({ id: s.id, method: s.method, signer_name: s.signer_name, signer_email: s.signer_email, image: s.image, ip: s.ip, signed_at: s.signed_at, witness: s.witness,
        document_id: s.document_id, document_number: s.document_number, content_sha256: s.content_sha256,
        unchanged: s.content_sha256 === c.hash, sealed: !!s.seal && sealOf(s) === s.seal })),
      requests: reqs.map((r) => Object.assign(r, { open: !r.used_at && !r.cancelled_at && new Date(r.expires_at) > new Date() })),
    };
  }

  app.get('/api/ar/invoices/:id(\\d+)/signing', ...AR, async (req, res) => {
    try {
      const c = await invoiceContent(parseInt(req.params.id, 10));
      res.json(Object.assign({ invoice: c.invoice, lines: c.lines, fingerprint: c.hash }, await signingState(c)));
    } catch (e) { fail(res, e); }
  });
  // In person: the customer signs on this screen; whoever is signed in is the witness.
  app.post('/api/ar/invoices/:id(\\d+)/sign', ...AR, async (req, res) => {
    try {
      const b = req.body || {};
      const c = await invoiceContent(parseInt(req.params.id, 10));
      const r = await saveSignature(req, c, { method: 'in_person', name: b.name, image: b.image, witness_id: req.session.userId });
      res.json({ ok: true, id: r.id, document: r.document });
    } catch (e) { fail(res, e); }
  });
  // Remote: a one-time link. Only its SHA-256 is stored; the link itself is shown once.
  app.post('/api/ar/invoices/:id(\\d+)/sign-request', ...AR, async (req, res) => {
    try {
      const b = req.body || {};
      const c = await invoiceContent(parseInt(req.params.id, 10));
      if (c.invoice.voided_at) throw httpError(409, 'This invoice is voided');
      const email = String(b.email || '').trim().slice(0, 200);
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw httpError(400, 'That email address does not look right');
      const days = Math.max(1, Math.min(60, parseInt(b.days, 10) || 14));
      const token = crypto.randomBytes(24).toString('base64url');
      await query(`INSERT INTO invoice_sign_requests (invoice_id, token_sha256, sent_to, sent_by, expires_at) VALUES ($1, $2, $3, $4, NOW() + ($5 || ' days')::interval)`,
        [c.invoice.id, sha(token), email || null, req.session.userId, String(days)]);
      const link = TILL + '/sign-invoice.html?t=' + token;
      let emailed = false;
      if (email && mailer && !devMode) {
        const shop = (await getShop()) || {};
        try {
          await mailer.sendEmail({ to: email, subject: 'Please sign invoice ' + c.invoice.number + ' from ' + (shop.name || 'Morty\'s Auto Parts'),
            text: 'Hello ' + c.invoice.customer + ',\n\nPlease read and sign invoice ' + c.invoice.number + ' (' + money(c.invoice.total) + (c.invoice.due ? ', due ' + c.invoice.due : '') + ') here:\n\n' + link +
              '\n\nThe link works once and expires in ' + days + ' days. If you have questions, call us on ' + (shop.phone || 'the shop number') + '.\n\n' + (shop.name || 'Morty\'s Auto Parts') });
          emailed = true;
        } catch (e) { console.error('[invoice-docs] sign-request email', e.message); }
      }
      res.json({ ok: true, link, emailed, expires_in_days: days });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/ar/sign-requests/:rid(\\d+)/cancel', ...AR, async (req, res) => {
    try {
      const { rowCount } = await query(`UPDATE invoice_sign_requests SET cancelled_at = NOW() WHERE id = $1 AND used_at IS NULL AND cancelled_at IS NULL`, [parseInt(req.params.rid, 10)]);
      if (!rowCount) throw httpError(409, 'Already used or cancelled');
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ---- the customer's side (no sign-in: the link is the key) ----
  const tries = new Map();
  function limited(req) {
    const k = ipOf(req), now = Date.now(), t = (tries.get(k) || []).filter((x) => now - x < 600000);
    t.push(now); tries.set(k, t);
    if (tries.size > 5000) tries.clear();
    return t.length > 30;
  }
  async function byToken(req) {
    if (limited(req)) throw httpError(429, 'Too many tries. Wait a few minutes.');
    const t = String(req.params.token || '');
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(t)) throw httpError(404, 'This link is not valid');
    const { rows } = await query(`SELECT id, invoice_id, sent_to, expires_at, used_at, cancelled_at FROM invoice_sign_requests WHERE token_sha256 = $1`, [sha(t)]);
    const r = rows[0];
    if (!r) throw httpError(404, 'This link is not valid');
    if (r.used_at) throw httpError(410, 'This invoice has already been signed from this link. Thank you.');
    if (r.cancelled_at || new Date(r.expires_at) <= new Date()) throw httpError(410, 'This link has expired. Please ask us for a new one.');
    return r;
  }
  app.get('/api/public/invoice-sign/:token', async (req, res) => {
    try {
      const r = await byToken(req);
      const c = await invoiceContent(r.invoice_id);
      if (c.invoice.voided_at) throw httpError(410, 'This invoice has been cancelled.');
      const shop = (await getShop()) || {};
      const i = c.invoice;
      res.json({ shop: { name: shop.name, phone: shop.phone, address: shop.address },
        invoice: { number: i.number, day: i.day, due: i.due, memo: i.memo, gct: i.gct, total: i.total, customer: i.company_name || i.customer }, lines: c.lines });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/public/invoice-sign/:token', async (req, res) => {
    try {
      const b = req.body || {};
      if (b.agree !== true) throw httpError(400, 'Tick the box to confirm');
      const r = await byToken(req);
      // Claim the link first, so two taps cannot sign twice.
      const { rowCount } = await query(`UPDATE invoice_sign_requests SET used_at = NOW() WHERE id = $1 AND used_at IS NULL`, [r.id]);
      if (!rowCount) throw httpError(410, 'This invoice has already been signed from this link. Thank you.');
      try {
        const c = await invoiceContent(r.invoice_id);
        await saveSignature(req, c, { method: 'remote', name: b.name, image: b.image, email: r.sent_to, request_id: r.id });
      } catch (e) { await query(`UPDATE invoice_sign_requests SET used_at = NULL WHERE id = $1`, [r.id]); throw e; }
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  return { invoiceContent, sealOf };
}

module.exports = { register, SCAN_SCHEMA };
