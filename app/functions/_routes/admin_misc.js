// Phase 15 — the remaining admin surface. Ports server.js:
//   PATCH /api/admin/settings   GET/PATCH /api/admin/settings/{machine,server}
//   GET/POST/DELETE /api/admin/marketing/campaigns[/:id]  + /:id/send
//   GET /api/admin/marketing/segments/count
//   GET /api/admin/schedule   GET/POST/DELETE /api/admin/schedule-blocks[/:id]
//   GET /api/admin/time-entries  POST /api/admin/time-entries/{clock-in,/:id/clock-out}
//   POST /api/admin/pos/customer   GET /api/admin/pos/scan   GET /api/admin/lookup
//   GET /api/admin/external-refs   PATCH /api/admin/orders/:id
//   GET /api/invoice/:wo_number   GET /api/pickslip   POST /api/admin/import/services
import bcrypt from 'bcryptjs';
import { d1 } from '../_lib/db.js';
import { adminMw, managerMw, currentUser } from '../_lib/guards.js';
import { getShopSettings, shopSettingsToShop } from '../_lib/shop.js';
import { sendEmail } from '../_lib/mailer.js';
import { readUploadBody } from '../_lib/uploads.js';

const u2c = (u) => (u == null || u === '' ? null : Math.round(Number(u) * 100));
const r2 = (n) => Math.round(n * 100) / 100;
const TAX_RATE = 0.15, TAX_LABEL = 'GCT (15%)';
const enc = encodeURIComponent;

async function nextAccountNumber(db) {
  const rows = await db.many("SELECT account_number AS a FROM users WHERE account_number LIKE 'C-%'");
  let mx = 0; for (const r of rows) { const m = String(r.a || '').match(/(\d+)\s*$/); if (m) mx = Math.max(mx, +m[1]); }
  return 'C-' + String(mx + 1).padStart(6, '0');
}
function csvRows(text) {
  const out = []; let row = []; let cur = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur); out.push(row); row = []; cur = ''; }
    else if (ch !== '\r') cur += ch;
  }
  if (cur.length || row.length) { row.push(cur); out.push(row); }
  return out;
}

async function recipientsForSegment(db, seg) {
  let where = "email IS NOT NULL AND email <> '' AND email_opt_in = 1";
  if (seg === 'retail') where += " AND (price_tier IS NULL OR price_tier = 'retail')";
  else if (['trade', 'fleet', 'dealer'].includes(seg)) where += ` AND price_tier = '${seg}'`;
  else if (seg === 'inactive_60d') where += " AND id IN (SELECT user_id FROM orders WHERE created_at < datetime('now','-60 days') EXCEPT SELECT user_id FROM orders WHERE created_at >= datetime('now','-60 days'))";
  else if (seg === 'loyalty_high') where += ' AND id IN (SELECT user_id FROM user_points WHERE balance >= 500)';
  return db.many(`SELECT id, name, email, phone FROM users WHERE ${where} LIMIT 5000`);
}

export default function mount(app) {
  // ============ SETTINGS ============
  app.patch('/api/admin/settings', managerMw, async (c) => {
    const db = d1(c.env);
    const b = await c.req.json().catch(() => ({}));
    const fields = ['company_name', 'address', 'country', 'phone', 'email', 'website',
      'print_logo_on_invoice', 'default_print_template', 'quote_valid_days',
      'invoice_notice', 'receipt_notice', 'statement_notice', 'storefront_prices',
      'pos_enforce_login', 'pos_enforce_customer', 'pos_default_fulfilment'];
    const BITS = ['print_logo_on_invoice', 'storefront_prices', 'pos_enforce_login', 'pos_enforce_customer'];
    const sets = []; const vals = [];
    for (const f of fields) if (b[f] !== undefined) { sets.push(`${f} = ?`); vals.push(BITS.includes(f) ? (b[f] ? 1 : 0) : b[f]); }
    if (!sets.length) return c.json({ error: 'Nothing to update' }, 400);
    sets.push('updated_at = CURRENT_TIMESTAMP');
    const row = await db.one('SELECT id FROM shop_settings ORDER BY id LIMIT 1');
    if (!row) await db.run('INSERT INTO shop_settings (id) VALUES (1)');
    vals.push(row ? row.id : 1);
    await db.run(`UPDATE shop_settings SET ${sets.join(', ')} WHERE id = ?`, ...vals);
    return c.json({ ok: true, settings: await getShopSettings(c.env) });
  });

  // No "machine" or "server" on a hosted Worker — return static stubs so the
  // Settings screen renders instead of 501ing, and accept the PATCH as a no-op.
  app.get('/api/admin/settings/machine', adminMw, (c) => {
    const host = new URL(c.req.url).hostname;
    return c.json({ ok: true, name: host, host, port: 443, local_db: null, cloud: true, mode: 'internet' });
  });
  app.patch('/api/admin/settings/machine', managerMw, (c) => c.json({ ok: true, name: new URL(c.req.url).hostname, cloud: true, mode: 'internet' }));
  app.get('/api/admin/settings/server', managerMw, (c) => c.json({ ok: true, running_port: 443, configured_port: null, restart_required: false, cloud: true }));
  app.patch('/api/admin/settings/server', managerMw, (c) => c.json({ ok: true, running_port: 443, configured_port: null, restart_required: false, cloud: true }));

  // ============ TERMINAL PRESENCE ============
  // Every admin / POS browser heartbeats here (~60s) with a stable client id
  // it keeps in localStorage. The POS ticket bar shows owners and managers a
  // live count of connected tills. A row counts as online for ~2.5 min after
  // its last beat; rows older than a day are pruned on write so the table
  // cannot grow without bound. There is no persistent connection on a hosted
  // Worker, so "connected" == "heartbeat seen recently".
  const PRESENCE_ONLINE = "-150 seconds";
  async function presenceSnapshot(db, selfId) {
    const rows = await db.many(
      `SELECT terminal_id, label, user_name, last_seen
         FROM admin_presence
        WHERE last_seen >= datetime('now', ?)
        ORDER BY last_seen DESC`, PRESENCE_ONLINE);
    return {
      online: rows.length,
      terminals: rows.map((r) => ({
        terminal_id: r.terminal_id,
        label: r.label || 'Terminal',
        user_name: r.user_name || null,
        last_seen: r.last_seen,
        is_self: selfId != null && r.terminal_id === selfId,
      })),
    };
  }
  app.post('/api/admin/presence', adminMw, async (c) => {
    const db = d1(c.env);
    const u = c.get('user') || {};
    const b = await c.req.json().catch(() => ({}));
    const tid = String(b.terminal_id || '').trim().slice(0, 64);
    if (!tid) return c.json({ error: 'terminal_id required' }, 400);
    const label = String(b.label || '').trim().slice(0, 60) || null;
    const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || null;
    const ua = String(c.req.header('User-Agent') || '').slice(0, 200) || null;
    await db.run(
      `INSERT INTO admin_presence (terminal_id, label, user_id, user_name, ip, user_agent, first_seen, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(terminal_id) DO UPDATE SET
         label      = COALESCE(excluded.label, admin_presence.label),
         user_id    = excluded.user_id,
         user_name  = excluded.user_name,
         ip         = excluded.ip,
         user_agent = excluded.user_agent,
         last_seen  = datetime('now')`,
      tid, label, u.id || null, u.name || u.email || null, ip, ua);
    await db.run("DELETE FROM admin_presence WHERE last_seen < datetime('now', '-1 day')");
    return c.json({ ok: true, ...(await presenceSnapshot(db, tid)) });
  });
  app.get('/api/admin/presence', adminMw, async (c) => {
    const db = d1(c.env);
    return c.json(await presenceSnapshot(db, c.req.query('terminal_id') || null));
  });

  // ============ MARKETING ============
  app.get('/api/admin/marketing/segments/count', adminMw, async (c) => {
    const db = d1(c.env);
    const segs = ['all', 'retail', 'trade', 'fleet', 'dealer', 'inactive_60d', 'loyalty_high'];
    const counts = {};
    for (const s of segs) {
      try { counts[s] = (await recipientsForSegment(db, s === 'all' ? '' : s)).length; }
      catch { counts[s] = 0; }
    }
    return c.json({ counts });
  });
  app.get('/api/admin/marketing/campaigns', adminMw, async (c) => {
    const campaigns = await d1(c.env).many('SELECT * FROM marketing_campaigns ORDER BY created_at DESC LIMIT 100');
    return c.json({ campaigns });
  });
  app.post('/api/admin/marketing/campaigns', managerMw, async (c) => {
    const b = await c.req.json().catch(() => ({}));
    if (!b.name || !b.body) return c.json({ error: 'name and body required' }, 400);
    const kind = ['email', 'sms', 'whatsapp', 'social'].includes(b.kind) ? b.kind : 'email';
    const r = await d1(c.env).run(
      `INSERT INTO marketing_campaigns (name, kind, subject, body, segment, scheduled_for, status, created_by)
         VALUES (?,?,?,?,?,?,?,?)`,
      b.name, kind, b.subject || null, b.body, b.segment || 'all', b.scheduled_for || null,
      b.scheduled_for ? 'scheduled' : 'draft', c.get('user').id);
    return c.json({ ok: true, id: r.meta.last_row_id });
  });
  app.post('/api/admin/marketing/campaigns/:id/send', managerMw, async (c) => {
    const db = d1(c.env);
    const id = c.req.param('id');
    const camp = await db.one('SELECT * FROM marketing_campaigns WHERE id = ?', id);
    if (!camp) return c.json({ error: 'Campaign not found' }, 404);
    if (camp.status === 'sent') return c.json({ error: 'Already sent' }, 400);
    const recipients = await recipientsForSegment(db, camp.segment === 'all' ? '' : camp.segment);
    let sent = 0, failed = 0;
    for (const r of recipients) {
      try {
        if (camp.kind === 'email' && r.email) {
          await sendEmail(c.env, { to: r.email, subject: camp.subject || camp.name, text: camp.body, html: '<p>' + camp.body.replace(/\n/g, '<br/>') + '</p>' });
          sent++;
        } else if (camp.kind === 'email') { /* no email on file */ }
        else sent++; // sms/whatsapp/social: counted as attempt (SMS dropped)
      } catch { failed++; }
    }
    await db.run(
      "UPDATE marketing_campaigns SET status = 'sent', sent_at = CURRENT_TIMESTAMP, recipients_count = ?, sent_count = ?, failed_count = ? WHERE id = ?",
      recipients.length, sent, failed, id);
    return c.json({ ok: true, recipients: recipients.length, sent, failed });
  });
  app.delete('/api/admin/marketing/campaigns/:id', managerMw, async (c) => {
    await d1(c.env).run('DELETE FROM marketing_campaigns WHERE id = ?', c.req.param('id'));
    return c.json({ ok: true });
  });

  // ============ SCHEDULE + BLOCKS ============
  app.get('/api/admin/schedule-blocks', adminMw, async (c) => {
    const where = []; const vals = [];
    if (c.req.query('from')) { where.push('block_date >= ?'); vals.push(c.req.query('from')); }
    if (c.req.query('to')) { where.push('block_date <= ?'); vals.push(c.req.query('to')); }
    const blocks = await d1(c.env).many(
      `SELECT sb.*, m.name AS mechanic_name FROM schedule_blocks sb LEFT JOIN mechanics m ON m.id = sb.mechanic_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY block_date ASC, time_slot ASC`, ...vals);
    return c.json({ blocks });
  });
  app.post('/api/admin/schedule-blocks', adminMw, async (c) => {
    const b = await c.req.json().catch(() => ({}));
    if (!b.block_date) return c.json({ error: 'block_date required' }, 400);
    const r = await d1(c.env).run(
      'INSERT INTO schedule_blocks (mechanic_id, block_date, time_slot, reason, notes) VALUES (?,?,?,?,?)',
      b.mechanic_id || null, b.block_date, b.time_slot || null, b.reason || null, b.notes || null);
    return c.json({ ok: true, id: r.meta.last_row_id });
  });
  app.delete('/api/admin/schedule-blocks/:id', adminMw, async (c) => {
    await d1(c.env).run('DELETE FROM schedule_blocks WHERE id = ?', c.req.param('id'));
    return c.json({ ok: true });
  });
  app.get('/api/admin/schedule', adminMw, async (c) => {
    const db = d1(c.env);
    const anchor = c.req.query('week') ? new Date(c.req.query('week')) : new Date();
    const day = anchor.getUTCDay();
    const diff = day === 0 ? -6 : 1 - day;
    const mon = new Date(anchor); mon.setUTCDate(anchor.getUTCDate() + diff); mon.setUTCHours(0, 0, 0, 0);
    const sat = new Date(mon); sat.setUTCDate(mon.getUTCDate() + 6);
    const start = mon.toISOString().slice(0, 10), end = sat.toISOString().slice(0, 10);
    const [appointments, work_orders, blocks, mechanics] = await Promise.all([
      db.many("SELECT id, name, phone, vehicle_make, vehicle_model, vehicle_year, service_type, preferred_date, time_slot, status FROM service_appointments WHERE date(preferred_date) BETWEEN ? AND ? ORDER BY preferred_date ASC, time_slot ASC", start, end),
      db.many("SELECT w.id, w.wo_number, w.customer_name, w.vehicle_year, w.vehicle_make, w.vehicle_model, w.status, w.priority, w.promised_date, w.assigned_mechanic_id, m.name AS mechanic_name FROM work_orders w LEFT JOIN mechanics m ON m.id = w.assigned_mechanic_id WHERE date(w.promised_date) BETWEEN ? AND ? OR (w.status IN ('open','in_progress','awaiting_parts') AND date(w.created_at) BETWEEN ? AND ?) ORDER BY w.promised_date ASC", start, end, start, end),
      db.many("SELECT sb.*, m.name AS mechanic_name FROM schedule_blocks sb LEFT JOIN mechanics m ON m.id = sb.mechanic_id WHERE block_date BETWEEN ? AND ?", start, end),
      db.many("SELECT id, name, role, specialty FROM mechanics WHERE is_active = 1 ORDER BY name"),
    ]);
    return c.json({ week_start: start, week_end: end, appointments, work_orders, blocks, mechanics });
  });

  // ============ TIME ENTRIES ============
  app.get('/api/admin/time-entries', adminMw, async (c) => {
    const where = []; const vals = [];
    if (c.req.query('mechanic_id')) { where.push('te.mechanic_id = ?'); vals.push(c.req.query('mechanic_id')); }
    if (c.req.query('work_order_id')) { where.push('te.work_order_id = ?'); vals.push(c.req.query('work_order_id')); }
    if (c.req.query('open') === 'true') where.push('te.clocked_out_at IS NULL');
    const entries = await d1(c.env).many(
      `SELECT te.*, m.name AS mechanic_name, w.wo_number FROM time_entries te
         LEFT JOIN mechanics m ON m.id = te.mechanic_id LEFT JOIN work_orders w ON w.id = te.work_order_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY te.clocked_in_at DESC LIMIT 200`, ...vals);
    return c.json({ entries });
  });
  app.post('/api/admin/time-entries/clock-in', adminMw, async (c) => {
    const db = d1(c.env);
    const b = await c.req.json().catch(() => ({}));
    if (!b.mechanic_id) return c.json({ error: 'mechanic_id required' }, 400);
    const open = await db.one('SELECT id FROM time_entries WHERE mechanic_id = ? AND clocked_out_at IS NULL', b.mechanic_id);
    if (open) return c.json({ error: 'Mechanic already clocked in (entry #' + open.id + ')' }, 400);
    const r = await db.run('INSERT INTO time_entries (mechanic_id, work_order_id, description) VALUES (?,?,?)',
      b.mechanic_id, b.work_order_id || null, b.description || null);
    return c.json({ ok: true, id: r.meta.last_row_id });
  });
  app.post('/api/admin/time-entries/:id/clock-out', adminMw, async (c) => {
    const db = d1(c.env);
    const id = c.req.param('id');
    const te = await db.one('SELECT * FROM time_entries WHERE id = ?', id);
    if (!te) return c.json({ error: 'Entry not found' }, 404);
    if (te.clocked_out_at) return c.json({ error: 'Already clocked out' }, 400);
    const out = Date.now();
    const inAt = new Date(te.clocked_in_at + 'Z').getTime() || new Date(te.clocked_in_at).getTime();
    const hours = Math.max(0.01, Math.round((out - inAt) / 36000) / 100);
    let laborId = null;
    const stmts = [];
    if (te.work_order_id) {
      const m = await db.one('SELECT name, hourly_rate_cents FROM mechanics WHERE id = ?', te.mechanic_id);
      const rateC = (m && m.hourly_rate_cents) || 2500;
      const totalC = Math.round(hours * rateC);
      const lab = await db.run(
        `INSERT INTO work_order_labor (work_order_id, mechanic_id, description, hours, rate_cents, total_cents, performed_date)
           VALUES (?,?,?,?,?,?, date('now'))`,
        te.work_order_id, te.mechanic_id, te.description || ((m && m.name) || 'Mechanic') + ' time-clock', hours, rateC, totalC);
      laborId = lab.meta.last_row_id;
      const l = await db.one('SELECT COALESCE(SUM(total_cents),0) AS s FROM work_order_labor WHERE work_order_id = ?', te.work_order_id);
      const pp = await db.one('SELECT COALESCE(SUM(total_cents),0) AS s FROM work_order_parts WHERE work_order_id = ?', te.work_order_id);
      await db.run('UPDATE work_orders SET labor_total_cents = ?, parts_total_cents = ?, total_cents = ? WHERE id = ?',
        l.s || 0, pp.s || 0, (l.s || 0) + (pp.s || 0), te.work_order_id);
    }
    await db.run('UPDATE time_entries SET clocked_out_at = CURRENT_TIMESTAMP, hours = ?, labor_entry_id = ? WHERE id = ?', hours, laborId, id);
    return c.json({ ok: true, hours, labor_entry_id: laborId });
  });

  // ============ POS HELPERS ============
  app.post('/api/admin/pos/customer', managerMw, async (c) => {
    const db = d1(c.env);
    const b = await c.req.json().catch(() => ({}));
    const name = (b.name || '').trim();
    if (!name) return c.json({ error: 'name is required' }, 400);
    const acctNo = await nextAccountNumber(db);
    const email = (b.email || '').trim().toLowerCase() || `${acctNo.toLowerCase()}@walkin.mortysautoparts.local`;
    if (await db.one('SELECT id FROM users WHERE lower(email) = lower(?)', email))
      return c.json({ error: 'A customer with that email already exists' }, 409);
    const hash = await bcrypt.hash(crypto.randomUUID(), 10);
    const tier = ['retail', 'trade', 'fleet', 'dealer'].includes(b.price_tier) ? b.price_tier : 'retail';
    const r = await db.run(
      `INSERT INTO users (email, name, password_hash, phone, via, is_admin, price_tier, account_number)
         VALUES (?,?,?,?, 'pos', 0, ?, ?)`,
      email, name, hash, (b.phone || '').trim() || null, tier, acctNo);
    return c.json({ ok: true, id: r.meta.last_row_id, email, account_number: acctNo });
  });
  app.get('/api/admin/pos/scan', adminMw, async (c) => {
    const code = (c.req.query('code') || '').trim();
    if (!code) return c.json({ error: 'code required' }, 400);
    const product = await d1(c.env).one(
      `SELECT img, name, make_model, category, condition, price_cents / 100.0 AS price_usd, stock_count, low_threshold,
              sku, barcode, bin_location, location,
              CASE WHEN stock_count <= 0 THEN 'out' WHEN stock_count <= low_threshold THEN 'low' ELSE 'in' END AS stock_level
         FROM products WHERE is_active = 1 AND (lower(sku) = lower(?) OR lower(barcode) = lower(?) OR img = ?) LIMIT 1`,
      code, code, code);
    if (!product) return c.json({ error: 'No product matches that code' }, 404);
    return c.json({ product });
  });
  app.get('/api/admin/lookup', adminMw, async (c) => {
    const q = (c.req.query('q') || '').trim();
    if (!q) return c.json({ error: 'q required' }, 400);
    const products = await d1(c.env).many(
      `SELECT img, name, sku, barcode, category, condition, price_cents / 100.0 AS price_usd, cost_cents / 100.0 AS cost_usd, stock_count, bin_location
         FROM products WHERE sku = ? OR barcode = ? OR name LIKE '%' || ? || '%' LIMIT 30`, q, q, q);
    return c.json({ products });
  });

  // ============ LOCAL / OFFLINE SERVER DOWNLOAD ============
  // The hosted build can't install anything on a shop PC, but it can hand out
  // the portable-edition bundle + the setup steps. URL/version/hash come from
  // wrangler.toml [vars] (LOCAL_SERVER_URL etc.) so the shop points it at
  // wherever they publish the zip (GitHub release, R2, a share…).
  app.get('/api/admin/local-server', adminMw, async (c) => {
    const env = c.env || {};
    let shopName = 'Morty\'s Auto Parts', shopEmail = '';
    try { const s = await getShopSettings(c.env); shopName = s.company_name || shopName; shopEmail = s.email || ''; }
    catch { /* fallback names */ }
    return c.json({
      url: env.LOCAL_SERVER_URL || null,
      version: env.LOCAL_SERVER_VERSION || null,
      sha256: env.LOCAL_SERVER_SHA256 || null,
      size: env.LOCAL_SERVER_SIZE || null,
      docs: 'app/CUTOVER.md#offline--on-premise-use-after-cutover',
      // sensible defaults for the install wizard
      defaults: {
        shop_name: shopName,
        install_dir: 'C:\\MortysAutoParts',
        port: 3057,
        admin_email: shopEmail || 'admin@mortysautoparts.com',
        open_firewall: true,
        install_service: true,
      },
    });
  });

  // Build a one-double-click Windows installer with the shop's answers baked
  // in. The .cmd self-elevates, writes an embedded PowerShell script and runs
  // it: download the published bundle, verify its hash, extract, write the
  // machine / server / offline-setup config, open the firewall, then launch
  // the bundle's own first-run (which does the PostgreSQL initdb + schema load
  // + admin seed from offline-setup.json). See app/CUTOVER.md.
  app.post('/api/admin/local-server/installer', adminMw, async (c) => {
    const env = c.env || {};
    const bundleUrl = env.LOCAL_SERVER_URL || '';
    if (!bundleUrl) {
      return c.json({ error: 'No offline bundle is published yet. Build the portable edition and set LOCAL_SERVER_URL in wrangler.toml first — see app/CUTOVER.md.' }, 400);
    }
    const b = await c.req.json().catch(() => ({}));
    const shop = String(b.shop_name || 'Morty\'s Auto Parts').trim().slice(0, 80) || 'Morty\'s Auto Parts';
    let dir = String(b.install_dir || 'C:\\MortysAutoParts').trim();
    if (!/^[A-Za-z]:\\[\w .\-\\]{0,120}$/.test(dir)) dir = 'C:\\MortysAutoParts';
    dir = dir.replace(/\\+$/, '');
    const port = Math.min(65535, Math.max(1024, parseInt(b.port, 10) || 3057));
    const email = String(b.admin_email || '').trim().slice(0, 120);
    const pass = String(b.admin_password || '');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return c.json({ error: 'A valid admin email is required.' }, 400);
    if (pass.length < 6 || pass.length > 100 || /[\r\n]/.test(pass)) return c.json({ error: 'Admin password must be 6–100 characters, no line breaks.' }, 400);
    const doFw = b.open_firewall !== false;
    const doSvc = b.install_service !== false;
    const sha = String(env.LOCAL_SERVER_SHA256 || '').trim();

    const q = (s) => String(s).replace(/'/g, "''");             // PowerShell single-quote
    const ps = [
      "$ErrorActionPreference = 'Stop'",
      `$Shop      = '${q(shop)}'`,
      `$Dir       = '${q(dir)}'`,
      `$Port      = ${port}`,
      `$Email     = '${q(email)}'`,
      `$Pass      = '${q(pass)}'`,
      `$BundleUrl = '${q(bundleUrl)}'`,
      `$Sha256    = '${q(sha)}'`,
      `$DoFirewall = $${doFw ? 'true' : 'false'}`,
      `$DoService  = $${doSvc ? 'true' : 'false'}`,
      '',
      'Write-Host "== Morty\'s Auto Parts offline setup for $Shop ==" -ForegroundColor Cyan',
      'New-Item -ItemType Directory -Force -Path $Dir | Out-Null',
      "$zip = Join-Path $Dir 'bundle.zip'",
      'Write-Host "Downloading the offline bundle..."',
      '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12',
      'Invoke-WebRequest -Uri $BundleUrl -OutFile $zip -UseBasicParsing',
      'if ($Sha256) {',
      '  $h = (Get-FileHash $zip -Algorithm SHA256).Hash',
      '  if ($h -ne $Sha256.ToUpper()) { throw "Downloaded file hash $h does not match the published $Sha256" }',
      '  Write-Host "Hash verified." -ForegroundColor Green',
      '}',
      'Write-Host "Extracting to $Dir ..."',
      'Expand-Archive -Path $zip -DestinationPath $Dir -Force',
      'Remove-Item $zip -Force',
      "$srv = Get-ChildItem -Path $Dir -Recurse -Filter 'server.js' -File -ErrorAction SilentlyContinue | Select-Object -First 1",
      '$Root = if ($srv) { $srv.DirectoryName } else { $Dir }',
      'Write-Host "App folder: $Root"',
      '',
      "[IO.File]::WriteAllText((Join-Path $Root 'machine-config.json'), (@{ name = $Shop } | ConvertTo-Json))",
      "[IO.File]::WriteAllText((Join-Path $Root 'server-config.json'),  (@{ port = $Port } | ConvertTo-Json))",
      "[IO.File]::WriteAllText((Join-Path $Root 'offline-setup.json'), (@{",
      '  shop_name = $Shop; port = $Port; admin_email = $Email; admin_password = $Pass;',
      '  install_service = $DoService; open_firewall = $DoFirewall; created = (Get-Date -Format o)',
      '} | ConvertTo-Json))',
      'Write-Host "Wrote configuration." -ForegroundColor Green',
      '',
      'if ($DoFirewall) {',
      '  Write-Host "Opening the firewall (TCP $Port, UDP 41235)..."',
      '  cmd /c "netsh advfirewall firewall add rule name=""Morty\'s Auto Parts Admin $Port"" dir=in action=allow protocol=TCP localport=$Port" | Out-Null',
      '  cmd /c "netsh advfirewall firewall add rule name=""Morty\'s Auto Parts Discovery"" dir=in action=allow protocol=UDP localport=41235" | Out-Null',
      '}',
      '',
      'Write-Host "Starting the local server — first run sets up PostgreSQL and loads the database..." -ForegroundColor Cyan',
      "$vbs = Join-Path $Root 'Morty''s Auto Parts Admin.vbs'",
      "$setup = Join-Path $Root 'setup.cmd'",
      'if (Test-Path $vbs) { Start-Process wscript.exe -ArgumentList ("""" + $vbs + """") -WorkingDirectory $Root }',
      'elseif (Test-Path $setup) { Start-Process $setup -WorkingDirectory $Root }',
      "else { Start-Process node -ArgumentList 'server.js' -WorkingDirectory $Root }",
      '',
      "$startWin = Join-Path $Root 'Start With Windows.vbs'",
      'if ($DoService -and (Test-Path $startWin)) { Start-Process wscript.exe -ArgumentList ("""" + $startWin + """") }',
      '',
      'Start-Sleep -Seconds 8',
      'Start-Process "http://localhost:$Port/admin.html"',
      'Write-Host ""',
      'Write-Host "Setup finished. Sign in at http://localhost:$Port/admin.html with $Email" -ForegroundColor Green',
      'Read-Host "Press Enter to close"',
      '',
    ].join('\r\n');

    // base64 the PS so no quoting survives into the .cmd; the .cmd self-elevates.
    const psBytes = new TextEncoder().encode(ps);
    let psBin = '';
    for (let i = 0; i < psBytes.length; i++) psBin += String.fromCharCode(psBytes[i]);
    const psB64 = btoa(psBin);
    const cmd = [
      '@echo off',
      'setlocal',
      'net session >nul 2>&1',
      'if %errorlevel% NEQ 0 (',
      '  echo Requesting administrator rights...',
      '  powershell -NoProfile -Command "Start-Process -FilePath \'%~f0\' -Verb RunAs" >nul 2>&1',
      '  exit /b',
      ')',
      `set "MHPS=${psB64}"`,
      'powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=Join-Path $env:TEMP \'mh-offline-install.ps1\'; [IO.File]::WriteAllText($p,[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:MHPS))); & powershell -NoProfile -ExecutionPolicy Bypass -File $p"',
      'endlocal',
      '',
    ].join('\r\n');

    return new Response(cmd, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="Install Morty\'s Auto Parts Offline.cmd"',
        'Cache-Control': 'no-store',
      },
    });
  });

  // ============ EXTERNAL REFS ============
  app.get('/api/admin/external-refs', adminMw, (c) => {
    const vin = (c.req.query('vin') || '').trim().toUpperCase();
    const year = c.req.query('year') || '';
    const make = (c.req.query('make') || '').trim();
    const model = (c.req.query('model') || '').trim();
    const q = (s) => enc((year + ' ' + make + ' ' + model + ' ' + s).trim());
    return c.json({
      links: [
        { name: 'AllData Repair', icon: '🔧', url: vin ? `https://www.alldatadiy.com/alldatadiy/index.html?vin=${enc(vin)}` : `https://www.alldata.com/us/en/auto-repair-software?make=${enc(make)}&model=${enc(model)}&year=${enc(year)}`, note: 'Requires AllData subscription' },
        { name: 'Mitchell 1 ProDemand', icon: '📖', url: 'https://prodemand.mitchell1.com/', note: 'Sign in; search the VIN there' },
        { name: 'Identifix Direct-Hit', icon: '🎯', url: 'https://www.identifix.com/', note: 'Confirmed fixes by VIN — sign in required' },
        { name: 'NHTSA Recalls (free)', icon: '⚠', url: vin ? `https://www.nhtsa.gov/recalls?vin=${enc(vin)}` : 'https://www.nhtsa.gov/recalls', note: 'Free recall lookup by VIN' },
        { name: 'Google: TSBs', icon: '🔍', url: `https://www.google.com/search?q=${q('TSB technical service bulletin')}`, note: 'Public-facing TSB search' },
        { name: 'Google: Repair forum', icon: '💬', url: `https://www.google.com/search?q=${q('repair forum')}`, note: 'Owner-community fixes' },
        { name: 'YouTube: How-to', icon: '📺', url: `https://www.youtube.com/results?search_query=${q('repair')}`, note: 'Video walkthroughs' },
      ],
    });
  });

  // ============ ORDERS STATUS ============
  app.patch('/api/admin/orders/:id', adminMw, async (c) => {
    const { status } = await c.req.json().catch(() => ({}));
    if (!['pending', 'confirmed', 'ready', 'completed', 'cancelled'].includes(status)) return c.json({ error: 'Invalid status' }, 400);
    await d1(c.env).run('UPDATE orders SET status = ? WHERE id = ?', status, c.req.param('id'));
    return c.json({ ok: true });
  });

  // ============ INVOICE (WO — public with WO# + phone, or any signed-in staff) ============
  app.get('/api/invoice/:wo_number', async (c) => {
    const db = d1(c.env);
    const woNumber = (c.req.param('wo_number') || '').toUpperCase();
    const me = await currentUser(c.req.raw, c.env).catch(() => null);
    const allowed = !!me;
    const phone = String(c.req.query('phone') || '').replace(/[^\d]/g, '').slice(-7);
    if (!allowed && !phone) return c.json({ error: 'Phone required for customer access' }, 401);
    const digitsSql = "replace(replace(replace(replace(replace(replace(customer_phone,'-',''),' ',''),'(',''),')',''),'+',''),'.','')";
    const w = allowed
      ? await db.one(`SELECT w.*, m.name AS mechanic_name, sa.name AS advisor_name FROM work_orders w
           LEFT JOIN mechanics m ON m.id = w.assigned_mechanic_id LEFT JOIN mechanics sa ON sa.id = w.service_advisor_id
          WHERE wo_number = ?`, woNumber)
      : await db.one(`SELECT w.*, m.name AS mechanic_name, sa.name AS advisor_name FROM work_orders w
           LEFT JOIN mechanics m ON m.id = w.assigned_mechanic_id LEFT JOIN mechanics sa ON sa.id = w.service_advisor_id
          WHERE wo_number = ? AND ${digitsSql} LIKE '%' || ?`, woNumber, phone);
    if (!w) return c.json({ error: 'Invoice not found' }, 404);
    const labor = await db.many('SELECT description, hours, rate_cents/100.0 AS rate, total_cents/100.0 AS total FROM work_order_labor WHERE work_order_id = ? ORDER BY id', w.id);
    const parts = await db.many('SELECT description, qty, unit_price_cents/100.0 AS unit, total_cents/100.0 AS total FROM work_order_parts WHERE work_order_id = ? ORDER BY id', w.id);
    const payments = await db.many('SELECT method, amount_cents/100.0 AS amt, reference, received_at FROM work_order_payments WHERE work_order_id = ? ORDER BY received_at', w.id);
    const s = await getShopSettings(c.env);
    return c.json({
      work_order: w, labor, parts, payments, tax_label: TAX_LABEL, tax_rate: TAX_RATE,
      shop: { name: s.company_name, address: s.address + (s.country ? ', ' + s.country : ''), phone: s.phone, website: s.website || 'https://mortsautoparts.com' },
    });
  });

  // ============ PICKSLIP ============
  app.get('/api/pickslip', adminMw, async (c) => {
    const db = d1(c.env);
    const wo = c.req.query('wo'), pr = c.req.query('pr'), order = c.req.query('order'), pos = c.req.query('pos');
    if (!wo && !pr && !order && !pos) return c.json({ error: 'wo, pr, order, or pos required' }, 400);
    const shop = shopSettingsToShop(await getShopSettings(c.env));
    if (pos) {
      const s = await db.one('SELECT * FROM pos_sales WHERE id = ?', pos);
      if (!s) return c.json({ error: 'Sale not found' }, 404);
      const items = await db.many(
        `SELECT psi.description, psi.qty, psi.product_img, psi.unit_price_cents/100.0 AS unit_price_usd,
                p.name AS product_name, p.sku, p.bin_location, p.stock_count
           FROM pos_sale_items psi LEFT JOIN products p ON p.img = psi.product_img WHERE psi.sale_id = ? ORDER BY p.bin_location`, pos);
      return c.json({ kind: 'pos_sale', header: { number: s.receipt_number, customer: s.customer_name || 'Walk-in', vehicle: s.vehicle_info, intake: s.created_at }, items, shop });
    }
    if (wo) {
      const w = await db.one('SELECT w.*, m.name AS mechanic_name FROM work_orders w LEFT JOIN mechanics m ON m.id = w.assigned_mechanic_id WHERE w.wo_number = ?', wo.toUpperCase());
      if (!w) return c.json({ error: 'Work order not found' }, 404);
      const items = await db.many(
        `SELECT wp.*, wp.unit_price_cents/100.0 AS unit_price_usd, p.name AS product_name, p.sku, p.bin_location, p.stock_count
           FROM work_order_parts wp LEFT JOIN products p ON p.img = wp.product_img WHERE wp.work_order_id = ? ORDER BY p.bin_location, wp.id`, w.id);
      return c.json({ kind: 'work_order', header: { number: w.wo_number, customer: w.customer_name, vehicle: [w.vehicle_year, w.vehicle_make, w.vehicle_model].filter(Boolean).join(' '), mechanic: w.mechanic_name, intake: w.intake_date }, items, shop });
    }
    if (pr) {
      const prr = await db.one('SELECT pr.*, w.wo_number, w.customer_name, rb.name AS requester_name FROM parts_requisitions pr LEFT JOIN work_orders w ON w.id = pr.work_order_id LEFT JOIN mechanics rb ON rb.id = pr.requested_by WHERE pr.id = ?', pr);
      if (!prr) return c.json({ error: 'Requisition not found' }, 404);
      const items = await db.many(
        `SELECT pi.description, pi.qty_requested AS qty, pi.product_img, pi.unit_price_cents/100.0 AS unit_price_usd,
                p.name AS product_name, p.sku, p.bin_location, p.stock_count
           FROM parts_requisition_items pi LEFT JOIN products p ON p.img = pi.product_img WHERE pi.requisition_id = ? ORDER BY p.bin_location, pi.id`, pr);
      return c.json({ kind: 'parts_requisition', header: { number: prr.pr_number, customer: prr.customer_name, mechanic: prr.requester_name, wo: prr.wo_number, intake: prr.created_at }, items, shop });
    }
    const o = await db.one('SELECT * FROM orders WHERE id = ?', order);
    if (!o) return c.json({ error: 'Order not found' }, 404);
    const items = await db.many(
      `SELECT oi.product_img, oi.qty, oi.price_cents/100.0 AS unit_price_usd, oi.qty * oi.price_cents/100.0 AS total_usd,
              p.name AS product_name, p.sku, p.bin_location, p.stock_count
         FROM order_items oi LEFT JOIN products p ON p.img = oi.product_img WHERE oi.order_id = ? ORDER BY p.bin_location`, order);
    return c.json({ kind: 'order', header: { number: '#' + o.id, customer: o.user_id ? 'Registered customer' : 'Walk-in', intake: o.created_at }, items, shop });
  });

  // ============ IMPORT SERVICES (CSV) ============
  app.post('/api/admin/import/services', managerMw, async (c) => {
    const { file } = await readUploadBody(c, ['csv', 'file']);
    if (!file) return c.json({ error: 'CSV file required' }, 400);
    const text = new TextDecoder('utf-8').decode(new Uint8Array(await file.arrayBuffer()));
    const rows = csvRows(text);
    if (rows.length < 2) return c.json({ error: 'CSV has no data rows' }, 400);
    const head = rows[0].map((h) => h.trim().toLowerCase());
    const col = (names) => { for (const n of names) { const i = head.indexOf(n); if (i >= 0) return i; } return -1; };
    const ix = {
      code: col(['code']), name: col(['name', 'service', 'description']), category: col(['category']),
      description: col(['description', 'notes']), hours: col(['default_hours', 'hours']),
      price: col(['default_price_usd', 'price']), labor: col(['default_labor_usd', 'labor']), parts: col(['default_parts_usd', 'parts']),
    };
    const db = d1(c.env);
    let inserted = 0, skipped = 0;
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const name = ((ix.name >= 0 && r[ix.name]) || '').trim();
      if (!name) { skipped++; continue; }
      try {
        await db.run(
          `INSERT INTO services (code, name, category, description, default_hours, default_price_cents, default_labor_cents, default_parts_cents)
             VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(code) DO NOTHING`,
          ix.code >= 0 ? (r[ix.code] || null) : null, name,
          ix.category >= 0 ? (r[ix.category] || null) : null, ix.description >= 0 ? (r[ix.description] || null) : null,
          ix.hours >= 0 ? (parseFloat(r[ix.hours]) || 1.0) : 1.0,
          u2c(ix.price >= 0 ? r[ix.price] : null), u2c(ix.labor >= 0 ? r[ix.labor] : null), u2c(ix.parts >= 0 ? r[ix.parts] : null));
        inserted++;
      } catch { skipped++; }
    }
    return c.json({ ok: true, total: rows.length - 1, inserted, skipped });
  });
}
