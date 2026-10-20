// =============================================================================
//  Vision Auto Solutions -- Customer notifications (Phase 6)
//
//  Mounted by server.js:  const notify = require('./notify').register(app, deps)
//  Other modules call notify.send(event, ctx, opts); staff screens use /api/notify.
//
//  One message per (event, channel) from notify_templates, which staff can
//  edit. Channels:
//    sms       Twilio (sms.js). Held during quiet hours until the morning.
//    email     SMTP (mailer.js). Any time.
//    whatsapp  no API: logged as a click-to-chat link staff send by hand.
//  When SMS or email is not set up (and always in dev mode) the wrappers only
//  log; the row is marked 'stubbed' so nobody thinks the customer was told.
//
//  Customer choices: sms_opt_in / email_opt_in record MARKETING consent (the
//  legacy import set both false for every customer), so they only gate events
//  listed in MARKETING. Service messages about the customer's own order, and
//  the in-stock call-back they asked for, still go. A customer who prefers
//  email gets no SMS when there is an email address. Walk-in / shared till
//  accounts are never messaged.
//
//  Every attempt is a notifications row: queued, sent, stubbed, link,
//  skipped (with the reason) or failed. A worker sends queued rows when due
//  and retries failures three times, 5 / 10 / 15 minutes apart.
// =============================================================================
'use strict';

const TZ = 'America/Jamaica';
const EVENTS = {
  order_received: 'Order received',
  ready_pickup: 'Ready for pickup',
  ready_delivery: 'Packed for delivery',
  out_for_delivery: 'Out for delivery',
  shipped: 'Handed to courier',
  delivered: 'Delivered',
  collected: 'Collected at the counter',
  part_in_stock: 'Part asked for is in stock',
  share_link: 'Link sent by staff or a rep',
};
const CHANNELS = ['sms', 'email', 'whatsapp'];
const MARKETING = [];   // promotions, when added: need the customer's opt-in
const SAMPLE = { shop: 'Vision Auto Solutions', name: 'Damion', number: 'F-000123', code: '482913', link: 'https://example.com/track-order?t=abc',
  carrier: 'Knutsford Express', tracking: 'KE123456', part: 'Brake pads (front) for 2015 Corolla', received_by: 'Damion Morgan', phone: '876-728-4735',
  url: 'https://example.com/l/ab12cd', message: 'Here are the brake pads for your Corolla, in stock now.', title: 'Brake pads for your Corolla' };

function register(app, deps) {
  const { query, getPool, requireAdmin, requireCap, sms, mailer, getShopName } = deps;
  const can = (k) => [requireAdmin, requireCap(k)];

  function httpError(status, msg) { const e = new Error(msg); e.status = status; e.publicMessage = msg; return e; }
  function fail(res, e) { const s = e.status || 500; if (s >= 500) console.error('[notify]', e); res.status(s).json({ error: e.publicMessage || e.message }); }
  async function settings() {
    const { rows } = await query(`SELECT key, value FROM warehouse_settings WHERE key LIKE 'notify\\_%' OR key IN ('track_base_url')`);
    const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    return { enabled: (s.notify_enabled || 'on') === 'on', quiet_from: s.notify_quiet_from || '21:00', quiet_to: s.notify_quiet_to || '07:30',
      shop_phone: s.notify_shop_phone || '', track_base_url: s.track_base_url || '' };
  }
  const isWalkIn = (n) => /^(walk-?in( customer)?|cash( sale| customer)?|counter|customer|online customer)$/i.test(String(n || '').trim());
  const firstName = (n) => { const p = String(n || '').trim().split(/\s+/)[0] || ''; return p ? p[0].toUpperCase() + p.slice(1).toLowerCase() : 'there'; };
  // Imported customers without an email were given placeholder addresses
  // (...@customer.visionautosolutions.local): never mail those.
  const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim()) && !/\.(local|invalid|test|example)$/i.test(String(e || '').trim());
  const digits = (p) => String(p || '').replace(/\D/g, '');
  const validPhone = (p) => digits(p).length >= 7;
  function waLink(phone, text) {
    let d = digits(phone);
    if (d.length === 7) d = '1876' + d; else if (d.length === 10) d = '1' + d;
    return 'https://wa.me/' + d + '?text=' + encodeURIComponent(text);
  }
  function render(tpl, vars) {
    return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => {
      if (k === 'link') return vars.link ? ' Track: ' + vars.link : '';
      if (k === 'message' && !vars.message) return '';
      return vars[k] == null ? '' : String(vars[k]);
    }).replace(/[ \t]+\n/g, '\n').trim();
  }
  const htmlOf = (text) => '<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.5">' +
    String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>').replace(/\n/g, '<br>') + '</div>';

  // When an SMS asked for now should go: now, or the end of quiet hours (Jamaica time).
  async function dueAt(s) {
    const { rows } = await query(
      `WITH t AS (SELECT (NOW() AT TIME ZONE '${TZ}') AS lt, $1::time AS qf, $2::time AS qt)
       SELECT CASE
                WHEN qf > qt AND (lt::time >= qf OR lt::time < qt) OR qf < qt AND lt::time >= qf AND lt::time < qt
                THEN ((lt::date + CASE WHEN lt::time >= qt THEN 1 ELSE 0 END) + qt) AT TIME ZONE '${TZ}'
                ELSE NOW() END AS at
         FROM t`, [s.quiet_from, s.quiet_to]);
    return rows[0].at;
  }

  async function customerPrefs(customerId) {
    if (!customerId) return null;
    const { rows } = await query(`SELECT sms_opt_in, email_opt_in, preferred_contact FROM users WHERE id = $1`, [customerId]);
    return rows[0] || null;
  }

  async function log(row) {
    const { rows } = await query(
      `INSERT INTO notifications (event, channel, to_addr, subject, body, status, reason, send_after, related_kind, related_id, customer_id, by_user)
       VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8, NOW()),$9,$10,$11,$12) RETURNING *`,
      [row.event, row.channel, row.to_addr || null, row.subject || null, row.body || null, row.status, row.reason || null, row.send_after || null,
       row.related_kind || null, row.related_id || null, row.customer_id || null, row.by_user || null]);
    return rows[0];
  }

  // Send one queued row now. Claims it first so the worker and a request never both send it.
  async function deliver(id) {
    const { rows } = await query(
      `UPDATE notifications SET status = 'sending', attempts = attempts + 1
        WHERE id = $1 AND status IN ('queued', 'failed') AND send_after <= NOW() RETURNING *`, [id]);
    if (!rows.length) return null;
    const n = rows[0];
    try {
      let r;
      if (n.channel === 'sms') r = await sms.sendSMS({ to: n.to_addr, body: n.body });
      else if (n.channel === 'email') r = await mailer.sendEmail({ to: n.to_addr, subject: n.subject || 'Message from us', text: n.body, html: htmlOf(n.body) });
      else throw new Error('Unknown channel');
      const st = r && r.stubbed ? 'stubbed' : 'sent';
      const { rows: u } = await query(`UPDATE notifications SET status = $2, sent_at = NOW(), reason = $3 WHERE id = $1 RETURNING *`,
        [n.id, st, st === 'stubbed' ? (n.channel === 'sms' ? 'SMS is not set up: logged only' : 'Email is not set up: logged only') : null]);
      return u[0];
    } catch (e) {
      const retry = n.attempts < 3;
      const { rows: u } = await query(
        `UPDATE notifications SET status = 'failed', reason = $2, send_after = NOW() + make_interval(mins => $3) WHERE id = $1 RETURNING *`,
        [n.id, String(e.message || e).slice(0, 300), retry ? 5 * n.attempts : 0]);
      if (!retry) await query(`UPDATE notifications SET status = 'failed', reason = reason || ' (gave up after 3 tries)' WHERE id = $1`, [n.id]);
      return u[0];
    }
  }

  // send(event, ctx, opts)
  //   ctx:  { name, phone, email, customer_id, number, code, carrier, tracking, part, received_by, track_token }
  //   opts: { related_kind, related_id, by_user, channels, force }
  // Never throws: a failed message must not undo the warehouse step that caused it.
  async function send(event, ctx, opts) {
    ctx = ctx || {}; opts = opts || {};
    const out = [];
    try {
      if (!EVENTS[event]) throw new Error('Unknown event ' + event);
      const s = await settings();
      const base = { event, related_kind: opts.related_kind, related_id: opts.related_id, customer_id: ctx.customer_id, by_user: opts.by_user };
      const { rows: tpls } = await query(`SELECT * FROM notify_templates WHERE event = $1 AND enabled ORDER BY channel`, [event]);
      const wanted = tpls.filter((t) => !opts.channels || opts.channels.includes(t.channel));
      if (!wanted.length) return out;
      const skip = async (t, reason, to) => out.push(await log(Object.assign({}, base, { channel: t.channel, to_addr: to, status: 'skipped', reason })));
      if (!s.enabled) { for (const t of wanted) await skip(t, 'Customer messages are switched off'); return out; }
      if (isWalkIn(ctx.name)) { for (const t of wanted) await skip(t, 'Walk-in / shared account'); return out; }
      const prefs = await customerPrefs(ctx.customer_id);
      const shop = (getShopName && (await getShopName())) || 'Vision Auto Solutions';
      const link = ctx.track_token && s.track_base_url ? s.track_base_url.replace(/\/$/, '') + '/track-order?t=' + ctx.track_token : '';
      const vars = Object.assign({}, ctx, { shop, name: firstName(ctx.name), phone: s.shop_phone, link });
      const hasEmail = validEmail(ctx.email), hasPhone = validPhone(ctx.phone);
      for (const t of wanted) {
        const to = t.channel === 'email' ? (ctx.email || '').trim() : (ctx.phone || '').trim();
        if (t.channel === 'email' ? !hasEmail : !hasPhone) { await skip(t, t.channel === 'email' ? 'No email address' : 'No phone number', to); continue; }
        if (t.channel !== 'email' && MARKETING.includes(event) && !(prefs && prefs.sms_opt_in)) { await skip(t, 'No consent to marketing texts', to); continue; }
        if (t.channel === 'email' && MARKETING.includes(event) && !(prefs && prefs.email_opt_in)) { await skip(t, 'No consent to marketing email', to); continue; }
        if (t.channel === 'sms' && prefs && prefs.preferred_contact === 'email' && hasEmail) { await skip(t, 'Customer prefers email', to); continue; }
        if (!opts.force && opts.related_kind) {
          const { rows: dup } = await query(
            `SELECT 1 FROM notifications WHERE event = $1 AND channel = $2 AND related_kind = $3 AND related_id = $4
                AND status IN ('queued', 'sent', 'stubbed', 'link', 'sending') AND created_at > NOW() - INTERVAL '10 minutes' LIMIT 1`,
            [event, t.channel, opts.related_kind, opts.related_id]);
          if (dup.length) continue;
        }
        const body = render(t.body, vars);
        if (t.channel === 'whatsapp') {
          out.push(await log(Object.assign({}, base, { channel: 'whatsapp', to_addr: to, body, status: 'link', reason: 'Send from the log: WhatsApp opens with the message ready' })));
          continue;
        }
        const row = await log(Object.assign({}, base, { channel: t.channel, to_addr: to, subject: t.channel === 'email' ? render(t.subject, vars) : null, body,
          status: 'queued', send_after: t.channel === 'sms' ? await dueAt(s) : null }));
        out.push((await deliver(row.id)) || row);
      }
    } catch (e) { console.error('[notify]', event, e.message); }
    return out;
  }

  // Worker: queued rows that became due (quiet hours over) and failures to retry.
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const { rows } = await query(`SELECT id FROM notifications WHERE status IN ('queued', 'failed') AND attempts < 3 AND send_after <= NOW() ORDER BY id LIMIT 20`);
      for (const r of rows) await deliver(r.id);
      // A row stuck in 'sending' (server stopped mid-send) goes back to the queue.
      await query(`UPDATE notifications SET status = 'failed', reason = 'Interrupted' WHERE status = 'sending' AND created_at < NOW() - INTERVAL '10 minutes' AND sent_at IS NULL`);
    } catch (e) { console.warn('[notify] worker', e.message); }
    finally { busy = false; }
  }, 30000);
  if (timer.unref) timer.unref();

  // ----------------------------------------------------------- staff API --
  const view = (r) => Object.assign({}, r, { wa_link: r.channel === 'whatsapp' && r.to_addr ? waLink(r.to_addr, r.body || '') : undefined });

  app.get('/api/notify/log', ...can('notify.view'), async (req, res) => {
    try {
      const where = [], vals = [];
      const add = (sql, v) => { vals.push(v); where.push(sql.split('?').join('$' + vals.length)); };
      if (req.query.status) add('n.status = ?', String(req.query.status));
      if (req.query.event) add('n.event = ?', String(req.query.event));
      if (req.query.channel) add('n.channel = ?', String(req.query.channel));
      if (req.query.q) add(`(n.to_addr ILIKE '%' || ? || '%' OR n.body ILIKE '%' || ? || '%')`, String(req.query.q).slice(0, 60));
      if (req.query.related_kind && req.query.related_id) { add('n.related_kind = ?', String(req.query.related_kind)); add('n.related_id = ?', parseInt(req.query.related_id, 10) || 0); }
      const { rows } = await query(
        `SELECT n.*, u.name AS by_name, f.number AS order_number FROM notifications n
           LEFT JOIN users u ON u.id = n.by_user
           LEFT JOIN fulfilments f ON n.related_kind = 'fulfilment' AND f.id = n.related_id
          ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY n.id DESC LIMIT 300`, vals);
      const { rows: c } = await query(
        `SELECT status, COUNT(*)::int AS n FROM notifications WHERE created_at > NOW() - INTERVAL '7 days' GROUP BY status`);
      res.json({ rows: rows.map(view), last7: Object.fromEntries(c.map((x) => [x.status, x.n])),
        channels: { sms: !!(sms && sms.isActive && sms.isActive()), email: !!(mailer && mailer.isActive && mailer.isActive()) } });
    } catch (e) { fail(res, e); }
  });

  // Resend: a fresh row with the same text to the same address (now, ignoring quiet hours).
  app.post('/api/notify/log/:id/resend', ...can('notify.send'), async (req, res) => {
    try {
      const { rows } = await query(`SELECT * FROM notifications WHERE id = $1`, [parseInt(req.params.id, 10) || 0]);
      if (!rows.length) throw httpError(404, 'Not found');
      const n = rows[0];
      if (!n.to_addr || !n.body) throw httpError(409, 'Nothing to resend: ' + (n.reason || 'no address'));
      if (n.channel === 'whatsapp') throw httpError(409, 'WhatsApp messages are sent from the link');
      const row = await log({ event: n.event, channel: n.channel, to_addr: n.to_addr, subject: n.subject, body: n.body, status: 'queued',
        related_kind: n.related_kind, related_id: n.related_id, customer_id: n.customer_id, by_user: req.session.userId });
      res.json({ row: view((await deliver(row.id)) || row) });
    } catch (e) { fail(res, e); }
  });

  // WhatsApp: staff opened the link; record that it went.
  app.post('/api/notify/log/:id/whatsapp-sent', ...can('notify.send'), async (req, res) => {
    try {
      const { rowCount } = await query(`UPDATE notifications SET status = 'sent', sent_at = NOW(), by_user = COALESCE(by_user, $2), reason = 'Sent by hand on WhatsApp' WHERE id = $1 AND channel = 'whatsapp' AND status = 'link'`,
        [parseInt(req.params.id, 10) || 0, req.session.userId]);
      if (!rowCount) throw httpError(404, 'Not found or already marked');
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/notify/templates', ...can('notify.view'), async (req, res) => {
    try {
      const { rows } = await query(`SELECT t.*, u.name AS updated_by_name FROM notify_templates t LEFT JOIN users u ON u.id = t.updated_by`);
      const list = [];
      for (const ev of Object.keys(EVENTS)) for (const ch of CHANNELS) {
        const t = rows.find((r) => r.event === ev && r.channel === ch);
        list.push(t ? Object.assign({ label: EVENTS[ev], exists: true }, t) : { event: ev, channel: ch, label: EVENTS[ev], enabled: false, subject: null, body: '', exists: false });
      }
      res.json({ templates: list, events: EVENTS, sample: SAMPLE });
    } catch (e) { fail(res, e); }
  });

  app.put('/api/notify/templates/:event/:channel', ...can('notify.manage'), async (req, res) => {
    try {
      const { event, channel } = req.params;
      if (!EVENTS[event] || !CHANNELS.includes(channel)) throw httpError(404, 'Unknown message');
      const b = req.body || {};
      const body = String(b.body || '').trim();
      if (!body) throw httpError(400, 'The message is empty');
      if (body.length > (channel === 'email' ? 4000 : 480)) throw httpError(400, channel === 'email' ? 'Keep emails under 4,000 characters' : 'Keep texts under 480 characters (3 SMS)');
      const bad = (body + ' ' + (b.subject || '')).match(/\{(\w+)\}/g)?.filter((x) => !Object.prototype.hasOwnProperty.call(SAMPLE, x.slice(1, -1)));
      if (bad && bad.length) throw httpError(400, 'Unknown field ' + bad[0] + '. Use: ' + Object.keys(SAMPLE).map((k) => '{' + k + '}').join(' '));
      if (event === 'ready_pickup' && b.enabled !== false && !/\{code\}/.test(body) && channel !== 'email') throw httpError(400, 'The pickup message must include {code}');
      await query(
        `INSERT INTO notify_templates (event, channel, enabled, subject, body, updated_by, updated_at) VALUES ($1,$2,$3,$4,$5,$6,NOW())
         ON CONFLICT (event, channel) DO UPDATE SET enabled = EXCLUDED.enabled, subject = EXCLUDED.subject, body = EXCLUDED.body, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
        [event, channel, b.enabled !== false, channel === 'email' ? String(b.subject || '').trim().slice(0, 200) || null : null, body, req.session.userId]);
      res.json({ ok: true, preview: render(body, SAMPLE) });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/notify/settings', ...can('notify.view'), async (req, res) => {
    try { res.json(await settings()); } catch (e) { fail(res, e); }
  });
  app.put('/api/notify/settings', ...can('notify.manage'), async (req, res) => {
    try {
      const b = req.body || {};
      const put = (k, v) => query(`INSERT INTO warehouse_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [k, v]);
      const hhmm = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || ''));
      if (b.enabled !== undefined) await put('notify_enabled', b.enabled ? 'on' : 'off');
      if (b.quiet_from !== undefined) { if (!hhmm(b.quiet_from)) throw httpError(400, 'Quiet hours: use HH:MM'); await put('notify_quiet_from', b.quiet_from); }
      if (b.quiet_to !== undefined) { if (!hhmm(b.quiet_to)) throw httpError(400, 'Quiet hours: use HH:MM'); await put('notify_quiet_to', b.quiet_to); }
      if (b.shop_phone !== undefined) await put('notify_shop_phone', String(b.shop_phone || '').trim().slice(0, 40));
      res.json(await settings());
    } catch (e) { fail(res, e); }
  });

  // Test message to a staff member's own phone or email, using the sample order.
  app.post('/api/notify/test', ...can('notify.manage'), async (req, res) => {
    try {
      const b = req.body || {};
      const ch = b.channel === 'email' ? 'email' : 'sms';
      const to = String(b.to || '').trim();
      if (ch === 'email' ? !validEmail(to) : !validPhone(to)) throw httpError(400, ch === 'email' ? 'Give an email address' : 'Give a phone number');
      const { rows: t } = await query(`SELECT * FROM notify_templates WHERE event = 'ready_pickup' AND channel = $1`, [ch]);
      const body = render(t.length ? t[0].body : 'Test message from {shop}.', SAMPLE);
      const row = await log({ event: 'ready_pickup', channel: ch, to_addr: to, subject: ch === 'email' ? '[Test] ' + render((t[0] && t[0].subject) || 'Test', SAMPLE) : null,
        body: '[Test] ' + body, status: 'queued', by_user: req.session.userId, related_kind: 'test' });
      res.json({ row: view((await deliver(row.id)) || row) });
    } catch (e) { fail(res, e); }
  });

  // A one-off message whose text the caller wrote (a statement, invoice or
  // receipt from the Loans & Rent page, billing.js) rather than a template.
  // Same log, quiet hours and delivery as send(); WhatsApp comes back as a
  // click-to-chat link. msg: { channel, to, subject, text, event, related_kind,
  // related_id, customer_id, by_user }. Returns the notifications row.
  async function message(msg) {
    const s = await settings();
    const base = { event: msg.event || 'billing_document', channel: msg.channel, to_addr: String(msg.to || '').trim(), subject: msg.subject || null, body: msg.text,
      related_kind: msg.related_kind, related_id: msg.related_id, customer_id: msg.customer_id, by_user: msg.by_user };
    if (!CHANNELS.includes(msg.channel)) throw httpError(400, 'Email, SMS or WhatsApp?');
    if (msg.channel === 'email' ? !validEmail(base.to_addr) : !validPhone(base.to_addr)) return log(Object.assign(base, { status: 'skipped', reason: msg.channel === 'email' ? 'No email address' : 'No phone number' }));
    if (!s.enabled) return log(Object.assign(base, { status: 'skipped', reason: 'Customer messages are switched off' }));
    if (msg.channel === 'whatsapp') { const row = await log(Object.assign(base, { status: 'link', reason: 'Sent by hand: WhatsApp opens with the message ready' })); return Object.assign(row, { wa_link: waLink(row.to_addr, row.body) }); }
    const row = await log(Object.assign(base, { status: 'queued', send_after: msg.channel === 'sms' ? await dueAt(s) : null }));
    return (await deliver(row.id)) || row;
  }

  return { send, message, EVENTS, waLink };
}

module.exports = { register };
