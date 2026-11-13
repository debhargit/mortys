// =============================================================================
//  Vision Auto Solutions -- Shared resources: things every Vision user can use
//
//    require('./shared-resources').register(app, { query, requireAdmin, requireCap,
//      userCan, mailer, devMode, sysops })                  (after sysops.js)
//
//  One app-wide list of shared resources. Each has a type:
//
//    printer   a printer plugged into (or installed on) any shop PC
//    scanner   a scanner on any shop PC: scan from any Vision screen, the
//              picture comes back into Vision
//    folder    a folder on a shop PC that documents are saved into, as one
//              file each or as a running daily log ("shared output / logs")
//    email     a route that "prints" to email addresses (sent by the server)
//
//  Printers, scanners and folders live on a PC that runs the small "Vision
//  Share Agent" (tools/Vision-Share-Agent.ps1, downloaded from Shared
//  resources with a one-time pairing code filled in). The server keeps one
//  queue; the agent picks up the jobs for its PC. Email routes need no PC.
//
//    rules   automatic copies: every sale receipt and/or credit note goes to a
//            resource too (MANAGER COPY on the office printer, a copy emailed
//            to the accountant, a daily receipts log in a folder), and the
//            activity log (audit trail) can be written to a folder log.
//    jobs    the queue: who sent what where, and whether it worked. Jobs wait
//            while a PC is off (24 hours), then expire. Failed jobs are tried
//            3 times and can be sent again.
//
//  Agents authenticate with their own key (X-Share-Agent-Key), never a staff
//  session, so the device gate does not apply to them.
//  Tables are created on first use (never at startup: see the boot deadlock note).
// =============================================================================
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const { EventEmitter } = require('events');

const CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PAIR_HOURS = 24;
const JOB_HOURS = 24;
const ONLINE_SECONDS = 90;
const MAX_ATTEMPTS = 3;
const KINDS = ['printer', 'scanner', 'folder', 'email'];
const AGENT_KINDS = ['printer', 'scanner', 'folder'];
const KIND_LABEL = { printer: 'Printer', scanner: 'Scanner', folder: 'Shared folder / log', email: 'Email route' };
const DOCS = ['sales', 'credit_notes', 'both', 'activity'];
const FOLDER_FORMATS = ['text', 'html', 'log'];
const VIRTUAL = /(microsoft print to pdf|xps document writer|onenote|^fax$|send to onenote|adobe pdf|pdf24|cutepdf|snagit|foxit pdf|nitro pdf)/i;
const TZ = process.env.VISION_TZ || 'America/Jamaica';
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const WIN_PATH_RE = /^([A-Za-z]:\\|\\\\[^\\\/:*?"<>|]+\\[^\\\/:*?"<>|]+)[^:*?"<>|]*$/;

const DDL = `
CREATE TABLE IF NOT EXISTS sys_share_agents (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,                       -- "Manager's office PC"
  computer      TEXT,                                -- Windows computer name, reported by the agent
  key_hash      TEXT UNIQUE,                         -- sha256 of the agent key (set when paired)
  pair_code     TEXT UNIQUE,                         -- one-time code, wiped once used
  pair_expires  TIMESTAMPTZ,
  status        TEXT NOT NULL DEFAULT 'pairing' CHECK (status IN ('pairing', 'active', 'revoked')),
  version       TEXT,
  ip            TEXT,
  windows_user  TEXT,
  last_seen     TIMESTAMPTZ,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS sys_resources (
  id            SERIAL PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('printer', 'scanner', 'folder', 'email')),
  agent_id      INTEGER REFERENCES sys_share_agents(id) ON DELETE CASCADE,   -- NULL for email routes
  sys_name      TEXT,                                -- printer / scanner name in Windows; folder path
  name          TEXT,                                -- what Vision users see; NULL = sys_name
  location      TEXT,
  shared        BOOLEAN NOT NULL DEFAULT TRUE,       -- everyone can use it
  config        JSONB NOT NULL DEFAULT '{}',         -- email: to, subject; folder: format; scanner: device_id, dpi, color
  is_default    BOOLEAN NOT NULL DEFAULT FALSE,
  is_network    BOOLEAN NOT NULL DEFAULT FALSE,
  paper         TEXT,
  win_status    TEXT,
  present       BOOLEAN NOT NULL DEFAULT TRUE,       -- still on that PC at its last report
  last_seen     TIMESTAMPTZ,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sys_resources_agent ON sys_resources (agent_id, kind, sys_name) WHERE agent_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS sys_share_rules (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  resource_id   INTEGER NOT NULL REFERENCES sys_resources(id) ON DELETE CASCADE,
  docs          TEXT NOT NULL DEFAULT 'sales' CHECK (docs IN ('sales', 'credit_notes', 'both', 'activity')),
  copies        INTEGER NOT NULL DEFAULT 1 CHECK (copies BETWEEN 1 AND 5),
  label         TEXT NOT NULL DEFAULT 'MANAGER COPY',
  location_id   INTEGER,                             -- only this store's sales; NULL = every store
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  active_from   TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- from this moment on (never the history)
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS sys_share_jobs (
  id            SERIAL PRIMARY KEY,
  resource_id   INTEGER REFERENCES sys_resources(id) ON DELETE SET NULL,
  kind          TEXT NOT NULL,                       -- receipt | copy | test | scan | activity
  ref_id        BIGINT,                              -- pos_sales.id, or the last audit_log.id of an activity batch
  rule_id       INTEGER REFERENCES sys_share_rules(id) ON DELETE SET NULL,
  title         TEXT,
  doc           JSONB NOT NULL DEFAULT '{}',
  copies        INTEGER NOT NULL DEFAULT 1,
  status        TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'working', 'done', 'failed', 'cancelled', 'expired')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  note          TEXT,                                -- e.g. where a file was saved
  file_path     TEXT,                                -- a scan, kept in runtime/scans (never a public folder)
  file_type     TEXT,
  file_size     INTEGER,
  requested_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  claimed_at    TIMESTAMPTZ,
  done_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_sys_share_jobs_queue ON sys_share_jobs (resource_id, status, id);
CREATE INDEX IF NOT EXISTS idx_sys_share_jobs_recent ON sys_share_jobs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sys_share_jobs_mine ON sys_share_jobs (requested_by, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sys_share_jobs_rule_ref ON sys_share_jobs (rule_id, ref_id) WHERE rule_id IS NOT NULL;`;

function register(app, deps) {
  const { query, requireAdmin, requireCap, userCan, mailer } = deps;
  let sysops = deps.sysops || null;
  const SUP = [requireAdmin, requireCap('sys.support')];
  const wake = new EventEmitter(); wake.setMaxListeners(200);
  const SCAN_DIR = deps.scanDir || path.join(__dirname, 'runtime', 'scans');   // runtime/ is never served

  let readyP = null;
  const ready = () => (readyP = readyP || query(DDL).catch((e) => { readyP = null; throw e; }));

  const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
  const txt = (v, max) => { const s = String(v == null ? '' : v).trim(); return s ? s.slice(0, max || 120) : null; };
  const int = (v) => parseInt(v, 10) || 0;
  const ipOf = (req) => String(req.headers['cf-connecting-ip'] || req.ip || (req.socket && req.socket.remoteAddress) || '').split(',')[0].trim().replace(/^::ffff:/, '').slice(0, 64);
  function httpError(status, msg) { const e = new Error(msg); e.status = status; e.publicMessage = msg; return e; }
  function fail(res, e) { const s = e.status || 500; if (s >= 500) console.error('[shared-resources]', e); if (!res.headersSent) res.status(s).json({ error: e.publicMessage || e.message }); }
  const audit = (req, action, detail) => (sysops && sysops.audit ? sysops.audit(req, action, detail).catch(() => {}) : Promise.resolve());
  const newCode = () => { const b = crypto.randomBytes(8); let s = ''; for (let i = 0; i < 8; i++) s += CODE_ABC[b[i] % CODE_ABC.length]; return s.slice(0, 4) + '-' + s.slice(4); };
  const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const when = (d) => { try { return new Date(d).toLocaleString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (_) { return new Date(d).toISOString().slice(0, 16).replace('T', ' '); } };
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const tablesExist = async () => { const { rows } = await query(`SELECT to_regclass('sys_share_jobs') AS t`); return !!rows[0].t; };
  const canUse = async (req, kind) => {
    if (await userCan(req, 'sys.support')) return true;
    if (kind === 'scanner') return true;                                   // any staff member may scan
    return (await userCan(req, 'pos.access')) || (await userCan(req, 'pos.reprint_receipt'));
  };

  // ------------------------------------------------------------- documents --
  // A document is a list of simple lines: text, two-column rows, rules, banners.
  // The agent lays them out with Windows printing (any printer, no browser); the
  // same lines become plain text for folders/logs and HTML for email.
  async function shop() {
    try { const { rows } = await query('SELECT * FROM shop_settings ORDER BY id LIMIT 1'); if (rows[0]) return rows[0]; } catch (_) {}
    return { company_name: 'Vision Auto Solutions', address: '112C Waltham Park Road, Kingston', country: 'Jamaica', phone: '(876) 728-4735', receipt_notice: null };
  }
  const METHOD = { cash: 'Cash', card: 'Card', cheque: 'Cheque', bank: 'Bank transfer', loyalty: 'Loyalty points', gift_card: 'Gift card', account: 'On account', charge: 'On account' };
  async function receiptDoc(saleId, label) {
    const { rows: s } = await query(`SELECT s.*, COALESCE(s.cashier_name, u.name, u.email) AS cashier FROM pos_sales s LEFT JOIN users u ON u.id = s.cashier_id WHERE s.id = $1`, [saleId]);
    if (!s.length) throw httpError(404, 'Sale not found');
    const sale = s[0];
    const { rows: items } = await query(`SELECT description, qty, unit_price_usd, total_usd, core_charge_usd, env_fee_usd, serial_number FROM pos_sale_items WHERE sale_id = $1 ORDER BY id`, [saleId]);
    let pays = [];
    try { pays = (await query(`SELECT method, amount_usd, reference FROM sale_payments WHERE sale_id = $1 ORDER BY id`, [saleId])).rows; } catch (_) {}
    const sh = await shop();
    const cn = /^CN/i.test(String(sale.receipt_number || ''));
    const L = [];
    L.push({ t: 'text', s: sh.company_name || 'Vision Auto Solutions', align: 'center', bold: true, size: 1.35 });
    if (sh.address) L.push({ t: 'text', s: [sh.address, sh.country].filter(Boolean).join(', '), align: 'center', size: 0.85 });
    if (sh.phone) L.push({ t: 'text', s: sh.phone, align: 'center', size: 0.85 });
    if (label) L.push({ t: 'banner', s: label });
    L.push({ t: 'text', s: cn ? 'CREDIT NOTE' : 'RECEIPT', align: 'center', bold: true });
    L.push({ t: 'rule' });
    L.push({ t: 'row', l: cn ? 'Credit note' : 'Receipt', r: sale.receipt_number || ('#' + sale.id), bold: true });
    if (sale.invoice_number && sale.invoice_number !== sale.receipt_number) L.push({ t: 'row', l: 'Invoice', r: sale.invoice_number });
    L.push({ t: 'row', l: 'Date', r: when(sale.created_at) });
    if (sale.cashier) L.push({ t: 'row', l: 'Cashier', r: sale.cashier });
    L.push({ t: 'row', l: 'Customer', r: sale.customer_name || 'Walk-in customer' });
    if (sale.vehicle_info) L.push({ t: 'row', l: 'Vehicle', r: sale.vehicle_info });
    if (sale.po_number) L.push({ t: 'row', l: 'PO', r: sale.po_number });
    L.push({ t: 'rule' });
    for (const i of items) {
      L.push({ t: 'text', s: i.description || 'Item' });
      L.push({ t: 'row', l: '   ' + i.qty + ' x ' + money(i.unit_price_usd), r: money(i.total_usd) });
      if (Number(i.core_charge_usd) > 0) L.push({ t: 'row', l: '   + core charge', r: money(i.core_charge_usd), size: 0.85 });
      if (Number(i.env_fee_usd) > 0) L.push({ t: 'row', l: '   + environmental fee', r: money(i.env_fee_usd), size: 0.85 });
      if (i.serial_number) L.push({ t: 'text', s: '   S/N ' + i.serial_number, size: 0.85 });
    }
    if (!items.length) L.push({ t: 'text', s: '(no lines)', align: 'center' });
    L.push({ t: 'rule' });
    L.push({ t: 'row', l: 'Subtotal', r: money(sale.subtotal_usd) });
    if (Number(sale.discount_usd) > 0) L.push({ t: 'row', l: 'Discount', r: '-' + money(sale.discount_usd) });
    if (Number(sale.ship_fee_usd) > 0) L.push({ t: 'row', l: 'Delivery', r: money(sale.ship_fee_usd) });
    L.push({ t: 'row', l: sale.tax_exempt ? 'GCT (exempt)' : 'GCT', r: money(sale.tax_usd) });
    L.push({ t: 'row', l: 'TOTAL', r: money(sale.total_usd), bold: true, size: 1.25 });
    for (const p of pays) L.push({ t: 'row', l: (METHOD[p.method] || p.method) + (p.reference ? ' ' + p.reference : ''), r: money(p.amount_usd), size: 0.9 });
    if (!pays.length && sale.payment_method) L.push({ t: 'row', l: 'Paid by', r: METHOD[sale.payment_method] || sale.payment_method, size: 0.9 });
    if (Number(sale.change_due) > 0) L.push({ t: 'row', l: 'Change', r: money(sale.change_due) });
    if (Number(sale.balance_due_usd) > 0) L.push({ t: 'row', l: 'BALANCE DUE', r: money(sale.balance_due_usd), bold: true });
    if (sale.voided) L.push({ t: 'banner', s: 'VOIDED' });
    L.push({ t: 'rule' });
    if (sh.receipt_notice) L.push({ t: 'text', s: sh.receipt_notice, align: 'center', size: 0.8 });
    L.push({ t: 'text', s: 'Thank you for your business!', align: 'center', size: 0.9 });
    return { title: (cn ? 'Credit note ' : 'Receipt ') + (sale.receipt_number || sale.id), doc: { lines: L, footer: 'Sent by Vision · {resource} · {time}' }, sale };
  }
  function testDoc(r, who) {
    return { lines: [
      { t: 'text', s: 'Vision test', align: 'center', bold: true, size: 1.35 },
      { t: 'banner', s: KIND_LABEL[r.kind].toUpperCase() + ' WORKS' },
      { t: 'row', l: 'Resource', r: r.name || r.sys_name || '' },
      r.sys_name ? { t: 'row', l: r.kind === 'folder' ? 'Folder' : 'Windows name', r: r.sys_name } : null,
      r.agent_name ? { t: 'row', l: 'On computer', r: r.agent_name } : null,
      { t: 'row', l: 'Sent by', r: who || '' },
      { t: 'row', l: 'Sent at', r: when(new Date()) },
      { t: 'rule' },
      { t: 'text', s: 'Every Vision user can now use this shared resource.', align: 'center', size: 0.85 },
      { t: 'row', l: 'Left', r: 'Right' },
    ].filter(Boolean), footer: 'Sent by Vision · {resource} · {time}' };
  }
  // The same lines as fixed-width text (folders, logs, email text part) and HTML (email).
  function docText(doc, name, width) {
    const W = width || 46, out = [];
    const wrap = (s, w) => { const words = String(s || '').split(/\s+/); const lines = []; let cur = ''; for (const wd of words) { if ((cur + ' ' + wd).trim().length > w) { if (cur) lines.push(cur); cur = wd; } else cur = (cur + ' ' + wd).trim(); } lines.push(cur); return lines; };
    const center = (s) => { const p = Math.max(0, Math.floor((W - s.length) / 2)); return ' '.repeat(p) + s; };
    for (const l of (doc.lines || [])) {
      if (l.t === 'rule') out.push('-'.repeat(W));
      else if (l.t === 'banner') { out.push('='.repeat(W)); out.push(center('** ' + l.s + ' **')); out.push('='.repeat(W)); }
      else if (l.t === 'row') { const r = String(l.r || ''); const left = wrap(l.l, Math.max(8, W - r.length - 1)); left.forEach((x, i) => out.push(i === left.length - 1 ? x + ' '.repeat(Math.max(1, W - x.length - r.length)) + r : x)); }
      else wrap(l.s, W).forEach((x) => out.push(l.align === 'center' ? center(x) : x));
    }
    if (doc.footer) out.push('', center(String(doc.footer).replace('{resource}', name || '').replace('{time}', when(new Date()))));
    return out.join('\n');
  }
  function docHtml(doc, name) {
    const rows = (doc.lines || []).map((l) => {
      const st = (l.bold ? 'font-weight:700;' : '') + (l.size ? 'font-size:' + Math.round(14 * l.size) + 'px;' : '');
      if (l.t === 'rule') return '<tr><td colspan="2" style="border-top:1px dashed #999;padding:0;height:6px"></td></tr>';
      if (l.t === 'banner') return '<tr><td colspan="2" style="border:2px solid #111;text-align:center;font-weight:800;padding:6px;letter-spacing:1px">' + esc(l.s) + '</td></tr>';
      if (l.t === 'row') return '<tr><td style="padding:2px 0;' + st + '">' + esc(l.l) + '</td><td style="padding:2px 0;text-align:right;white-space:nowrap;' + st + '">' + esc(l.r) + '</td></tr>';
      return '<tr><td colspan="2" style="padding:2px 0;text-align:' + (l.align === 'center' ? 'center' : 'left') + ';' + st + '">' + esc(l.s) + '</td></tr>';
    }).join('');
    const foot = doc.footer ? '<p style="color:#888;font-size:11px;text-align:center">' + esc(String(doc.footer).replace('{resource}', name || '').replace('{time}', when(new Date()))) + '</p>' : '';
    return '<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="/favicon.svg?v=vision2" type="image/svg+xml"><link rel="icon" href="/favicon.ico?v=vision2" sizes="any"><link rel="apple-touch-icon" href="/apple-touch-icon.png?v=vision2"></head><body style="font-family:Arial,sans-serif;background:#f4f4f5;padding:20px"><div style="max-width:380px;margin:0 auto;background:#fff;padding:18px 20px;border:1px solid #ddd;border-radius:8px"><table style="width:100%;border-collapse:collapse;font-size:14px;color:#111">' + rows + '</table>' + foot + '</div></body></html>';
  }
  const safeName = (s) => String(s || 'Vision').replace(/[\\/:*?"<>|\r\n\t]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80);
  const stamp = () => { const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(new Date()); const g = (t) => (p.find((x) => x.type === t) || {}).value; return { day: g('year') + '-' + g('month') + '-' + g('day'), time: g('hour').replace('24', '00') + g('minute') + g('second') }; };

  // ------------------------------------------------------------------ queue --
  const RES_SELECT = `r.id, r.kind, COALESCE(r.name, r.sys_name) AS name, r.sys_name, r.location, r.shared, r.config, r.is_default, r.is_network, r.paper, r.win_status, r.present, r.last_seen,
      a.id AS agent_id, a.name AS agent_name, a.computer, a.last_seen AS agent_seen, a.status AS agent_status,
      CASE WHEN r.kind = 'email' THEN TRUE ELSE (a.status = 'active' AND a.last_seen > NOW() - INTERVAL '${ONLINE_SECONDS} seconds' AND r.present) END AS online,
      (SELECT COUNT(*)::int FROM sys_share_jobs j WHERE j.resource_id = r.id AND j.status IN ('queued', 'working')) AS waiting
     FROM sys_resources r LEFT JOIN sys_share_agents a ON a.id = r.agent_id`;
  const LIVE = `(r.kind = 'email' OR a.status = 'active')`;
  async function resource(id) {
    const { rows } = await query(`SELECT ${RES_SELECT} WHERE r.id = $1 AND ${LIVE}`, [id]);
    return rows[0] || null;
  }

  async function enqueue({ res, kind, refId, ruleId, title, doc, copies, by }) {
    // Folders get ready-made text / HTML, so the agent only has to write the file.
    if (res.kind === 'folder' && kind !== 'scan') {
      const fmt = (res.config && res.config.format) || 'text';
      doc = Object.assign({}, doc, { format: fmt, text: docText(doc, res.name), html: fmt === 'html' ? docHtml(doc, res.name) : undefined });
    }
    const { rows } = await query(
      `INSERT INTO sys_share_jobs (resource_id, kind, ref_id, rule_id, title, doc, copies, requested_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT DO NOTHING RETURNING id`,
      [res.id, kind, refId || null, ruleId || null, txt(title, 160), JSON.stringify(doc), Math.max(1, Math.min(5, int(copies) || 1)), by || null]);
    if (!rows[0]) return null;
    if (res.kind === 'email') deliverEmail(rows[0].id).catch((e) => console.warn('[shared-resources] email', e.message));
    else wake.emit('job');
    return rows[0].id;
  }

  // Email routes are delivered by the server itself.
  async function deliverEmail(jobId) {
    const { rows } = await query(`UPDATE sys_share_jobs j SET status = 'working', claimed_at = NOW(), attempts = attempts + 1
                                    FROM sys_resources r WHERE j.id = $1 AND j.resource_id = r.id AND r.kind = 'email' AND j.status = 'queued'
                                  RETURNING j.id, j.title, j.doc, j.attempts, r.config, COALESCE(r.name, 'Email') AS rname`, [jobId]);
    if (!rows.length) return;
    const j = rows[0], cfg = j.config || {};
    try {
      const to = String(cfg.to || '').split(/[,;\s]+/).filter((x) => EMAIL_RE.test(x));
      if (!to.length) throw new Error('This email route has no valid address');
      if (!mailer || !mailer.sendEmail) throw new Error('Email is not set up on this server');
      const subject = ((cfg.subject ? cfg.subject + ' ' : '') + (j.title || 'Vision document')).slice(0, 200);
      const r = await mailer.sendEmail({ to: to.join(', '), subject, text: docText(j.doc, j.rname), html: docHtml(j.doc, j.rname) });
      const note = r && r.stubbed ? 'Email is not set up on this server (SMTP): it was only written to the server log' : 'Emailed to ' + to.join(', ');
      await query(`UPDATE sys_share_jobs SET status = $2, note = $3, error = $4, done_at = NOW() WHERE id = $1`,
        [j.id, r && r.stubbed ? 'failed' : 'done', note, r && r.stubbed ? note : null]);
    } catch (e) {
      await query(`UPDATE sys_share_jobs SET status = CASE WHEN attempts >= $3 THEN 'failed' ELSE 'queued' END, error = $2, done_at = CASE WHEN attempts >= $3 THEN NOW() END WHERE id = $1`,
        [j.id, String(e.message).slice(0, 300), MAX_ATTEMPTS]);
    }
  }

  async function sweep() {
    await query(`UPDATE sys_share_jobs SET status = CASE WHEN attempts >= $1 THEN 'failed' ELSE 'queued' END,
                        error = CASE WHEN attempts >= $1 THEN COALESCE(error, 'The computer never confirmed this job') ELSE error END,
                        done_at = CASE WHEN attempts >= $1 THEN NOW() ELSE NULL END
                  WHERE status = 'working' AND claimed_at < NOW() - INTERVAL '3 minutes'`, [MAX_ATTEMPTS]);
    await query(`UPDATE sys_share_jobs SET status = 'expired', done_at = NOW(), error = 'Not done within ${JOB_HOURS} hours (computer off?)'
                  WHERE status = 'queued' AND created_at < NOW() - INTERVAL '${JOB_HOURS} hours'`);
    await query(`UPDATE sys_share_agents SET status = 'revoked', pair_code = NULL WHERE status = 'pairing' AND pair_expires < NOW() - INTERVAL '7 days'`);
    // Email jobs that failed for a passing reason: try again (each run of the sweep, up to 3 times).
    const { rows } = await query(`SELECT j.id FROM sys_share_jobs j JOIN sys_resources r ON r.id = j.resource_id WHERE r.kind = 'email' AND j.status = 'queued' AND j.attempts > 0 LIMIT 20`);
    for (const r of rows) await deliverEmail(r.id).catch(() => {});
  }

  // Rules: sale receipts / credit notes to any resource, and the activity log to a folder.
  // Idempotent per (rule, ref) thanks to the unique index: never twice, never skipped.
  let copying = false;
  async function runCopies() {
    if (copying) return 0;
    copying = true;
    let made = 0;
    try {
      if (!(await tablesExist())) return 0;
      const { rows: rules } = await query(`SELECT ru.* FROM sys_share_rules ru JOIN sys_resources r ON r.id = ru.resource_id LEFT JOIN sys_share_agents a ON a.id = r.agent_id
                                            WHERE ru.enabled AND ${LIVE} AND r.kind <> 'scanner'`);
      for (const ru of rules) {
        const res = await resource(ru.resource_id);
        if (!res) continue;
        if (ru.docs === 'activity') { made += await activityBatch(ru, res); continue; }
        const { rows: sales } = await query(
          `SELECT s.id FROM pos_sales s
            WHERE s.created_at >= GREATEST($2::timestamptz, NOW() - INTERVAL '6 hours')
              AND ($3::text = 'both' OR ($3 = 'sales' AND COALESCE(s.receipt_number, '') NOT ILIKE 'CN%') OR ($3 = 'credit_notes' AND s.receipt_number ILIKE 'CN%'))
              AND ($4::int IS NULL OR s.location_id = $4)
              AND NOT EXISTS (SELECT 1 FROM sys_share_jobs j WHERE j.rule_id = $1 AND j.ref_id = s.id)
            ORDER BY s.id LIMIT 50`, [ru.id, ru.active_from, ru.docs, ru.location_id]);
        for (const s of sales) {
          try {
            const d = await receiptDoc(s.id, ru.label);
            if (await enqueue({ res, kind: 'copy', refId: s.id, ruleId: ru.id, title: d.title + ' (' + ru.label.toLowerCase() + ')', doc: d.doc, copies: ru.copies })) made++;
          } catch (e) { console.warn('[shared-resources] copy of sale', s.id, e.message); }
        }
      }
    } catch (e) {
      if (!/does not exist/.test(e.message)) console.warn('[shared-resources] copies', e.message);
    } finally { copying = false; }
    return made;
  }
  async function activityBatch(ru, res) {
    const { rows: last } = await query(`SELECT COALESCE((SELECT MAX(ref_id) FROM sys_share_jobs WHERE rule_id = $1),
                                                        (SELECT COALESCE(MAX(id), 0) FROM audit_log WHERE at < $2)) AS id`, [ru.id, ru.active_from]);
    const { rows } = await query(`SELECT id, at, user_name, action, target, status, ip, remote, station FROM audit_log WHERE id > $1 AND at < NOW() - INTERVAL '3 seconds' ORDER BY id LIMIT 500`, [last[0].id]);
    if (!rows.length) return 0;
    const lines = rows.map((a) => ({ t: 'text', s: [when(a.at), a.user_name || '-', a.action, a.target ? '#' + a.target : '', a.status || '', a.ip || '', a.remote ? 'remote' : '', a.station || ''].filter(Boolean).join('  ') }));
    const id = await enqueue({ res, kind: 'activity', refId: rows[rows.length - 1].id, ruleId: ru.id, title: 'Activity log ' + rows.length + ' entr' + (rows.length === 1 ? 'y' : 'ies'), doc: { lines } });
    return id ? 1 : 0;
  }
  if (!deps.noTimers) {
    setTimeout(function tick() { runCopies().catch(() => {}).then(() => { setTimeout(tick, 4000).unref(); }); }, deps.firstCopyDelayMs || 60000).unref();
    setInterval(() => { tablesExist().then((t) => t && sweep()).catch(() => {}); }, 60000).unref();
  }

  // ------------------------------------------------------- agent endpoints --
  async function agentOf(req) {
    const k = String(req.get('x-share-agent-key') || '');
    if (k.length < 20) throw httpError(401, 'Missing agent key');
    await ready();
    const { rows } = await query(`SELECT * FROM sys_share_agents WHERE key_hash = $1`, [sha(k)]);
    if (!rows.length) throw httpError(401, 'Unknown agent: set it up again from Shared resources');
    if (rows[0].status !== 'active') throw httpError(403, 'This computer was removed from Vision');
    query(`UPDATE sys_share_agents SET last_seen = NOW(), ip = $2 WHERE id = $1`, [rows[0].id, ipOf(req)]).catch(() => {});
    return rows[0];
  }

  app.post('/api/share-agent/pair', async (req, res) => {
    try {
      await ready();
      const b = req.body || {};
      const code = String(b.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (code.length !== 8) throw httpError(400, 'The pairing code is 8 letters and numbers (like K7QM-3XRA)');
      const key = crypto.randomBytes(32).toString('base64url');
      const { rows } = await query(
        `UPDATE sys_share_agents SET key_hash = $2, pair_code = NULL, status = 'active', computer = $3, version = $4, windows_user = $5, ip = $6, last_seen = NOW()
          WHERE pair_code = $1 AND status = 'pairing' AND pair_expires > NOW() RETURNING id, name`,
        [code.slice(0, 4) + '-' + code.slice(4), sha(key), txt(b.computer, 80), txt(b.version, 20), txt(b.windows_user, 80), ipOf(req)]);
      if (!rows.length) throw httpError(400, 'That pairing code is wrong, already used or expired. Make a new one in Vision: Shared resources.');
      await audit(req, 'share.agent_paired', { agent: rows[0].id, name: rows[0].name, computer: txt(b.computer, 80) });
      res.json({ key, agent_id: rows[0].id, name: rows[0].name });
    } catch (e) { fail(res, e); }
  });

  // The agent reports this PC's printers and scanners (at start and every minute),
  // and gets back the folders it should keep.
  app.post('/api/share-agent/hello', async (req, res) => {
    try {
      const a = await agentOf(req);
      const b = req.body || {};
      await query(`UPDATE sys_share_agents SET computer = COALESCE($2, computer), version = COALESCE($3, version), windows_user = COALESCE($4, windows_user) WHERE id = $1`,
        [a.id, txt(b.computer, 80), txt(b.version, 20), txt(b.windows_user, 80)]);
      for (const [kind, list] of [['printer', b.printers], ['scanner', b.scanners]]) {
        if (!Array.isArray(list)) continue;
        const seen = [];
        for (const p of list.slice(0, 60)) {
          const sys = txt(p && p.name, 200);
          if (!sys) continue;
          seen.push(sys);
          await query(
            `INSERT INTO sys_resources (kind, agent_id, sys_name, shared, config, is_default, is_network, paper, win_status, present, last_seen)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE,NOW())
             ON CONFLICT (agent_id, kind, sys_name) WHERE agent_id IS NOT NULL DO UPDATE SET is_default = EXCLUDED.is_default, is_network = EXCLUDED.is_network, paper = EXCLUDED.paper,
               win_status = EXCLUDED.win_status, present = TRUE, last_seen = NOW(),
               config = CASE WHEN EXCLUDED.kind = 'scanner' THEN sys_resources.config || jsonb_build_object('device_id', EXCLUDED.config->>'device_id') ELSE sys_resources.config END`,
            [kind, a.id, sys, kind === 'printer' ? !VIRTUAL.test(sys) : true, JSON.stringify(kind === 'scanner' ? { device_id: txt(p.device_id, 200), dpi: 200, color: 'color' } : {}),
              !!p.is_default, !!p.is_network, txt(p.paper, 40), txt(p.status, 60)]);
        }
        await query(`UPDATE sys_resources SET present = FALSE WHERE agent_id = $1 AND kind = $2 AND NOT (sys_name = ANY($3))`, [a.id, kind, seen]);
      }
      // Folders: the agent reports whether each one it was given exists / can be written.
      if (Array.isArray(b.folders)) for (const f of b.folders.slice(0, 60)) {
        await query(`UPDATE sys_resources SET present = $3, win_status = $4, last_seen = NOW() WHERE id = $2 AND agent_id = $1 AND kind = 'folder'`,
          [a.id, int(f && f.id), !!(f && f.ok), txt(f && f.status, 60) || (f && f.ok ? 'Ready' : 'Cannot write')]);
      }
      const { rows: folders } = await query(`SELECT id, sys_name AS path FROM sys_resources WHERE agent_id = $1 AND kind = 'folder'`, [a.id]);
      res.json({ ok: true, name: a.name, folders });
    } catch (e) { fail(res, e); }
  });

  // Long poll: answers at once when jobs are waiting, else waits up to ~20 s.
  app.get('/api/share-agent/jobs', async (req, res) => {
    let done = false, timer = null, onJob = null;
    const cleanup = () => { done = true; clearTimeout(timer); if (onJob) wake.removeListener('job', onJob); };
    const finish = (jobs) => { if (done) return; cleanup(); res.json({ jobs }); };
    try {
      const a = await agentOf(req);
      const claim = async () => {
        const { rows } = await query(
          `UPDATE sys_share_jobs j SET status = 'working', claimed_at = NOW(), attempts = attempts + 1
             FROM sys_resources r
            WHERE j.resource_id = r.id AND r.agent_id = $1 AND j.status = 'queued'
              AND j.id IN (SELECT j2.id FROM sys_share_jobs j2 JOIN sys_resources r2 ON r2.id = j2.resource_id
                            WHERE r2.agent_id = $1 AND j2.status = 'queued' ORDER BY j2.id LIMIT 10 FOR UPDATE OF j2 SKIP LOCKED)
          RETURNING j.id, j.kind AS job_kind, j.title, j.doc, j.copies, r.kind, r.sys_name AS target, r.config, COALESCE(r.name, r.sys_name) AS label`, [a.id]);
        return rows.sort((x, y) => x.id - y.id);
      };
      const jobs = await claim();
      const wait = Math.max(0, Math.min(25, int(req.query.wait)));
      if (jobs.length || !wait) return finish(jobs);
      timer = setTimeout(() => finish([]), wait * 1000);
      onJob = () => { claim().then((j) => { if (j.length) finish(j); else if (done) {} }).catch(() => {}); };
      wake.on('job', onJob);
      req.on('close', () => { if (!done) cleanup(); });
    } catch (e) { if (!done) { cleanup(); fail(res, e); } }
  });

  async function finishJob(a, id, ok, error, note, file) {
    const { rows } = await query(
      `UPDATE sys_share_jobs j SET status = CASE WHEN $3 THEN 'done' WHEN j.attempts >= $5 THEN 'failed' ELSE 'queued' END,
              error = CASE WHEN $3 THEN NULL ELSE $4 END, note = COALESCE($6, j.note), file_path = COALESCE($7, j.file_path), file_type = COALESCE($8, j.file_type), file_size = COALESCE($9, j.file_size),
              done_at = CASE WHEN $3 OR j.attempts >= $5 THEN NOW() ELSE NULL END
         FROM sys_resources r WHERE j.id = $1 AND j.resource_id = r.id AND r.agent_id = $2 AND j.status = 'working' RETURNING j.status`,
      [id, a.id, ok, txt(error, 300) || 'Failed', MAX_ATTEMPTS, txt(note, 300), file ? file.path : null, file ? file.type : null, file ? file.size : null]);
    return rows[0] ? rows[0].status : null;
  }
  app.post('/api/share-agent/jobs/:id/result', async (req, res) => {
    try {
      const a = await agentOf(req);
      const b = req.body || {};
      res.json({ ok: true, status: await finishJob(a, int(req.params.id), !!b.ok, b.error, b.note) });
    } catch (e) { fail(res, e); }
  });
  // A scan comes back as the raw picture (JPEG/PNG/PDF), too big for a JSON body.
  app.post('/api/share-agent/jobs/:id/file', express.raw({ type: () => true, limit: '30mb' }), async (req, res) => {
    try {
      const a = await agentOf(req);
      const id = int(req.params.id);
      const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!buf.length) throw httpError(400, 'No file');
      const sig = buf.slice(0, 4).toString('hex');
      const type = sig.startsWith('ffd8') ? 'image/jpeg' : sig === '89504e47' ? 'image/png' : sig === '25504446' ? 'application/pdf' : sig.startsWith('4949') || sig.startsWith('4d4d') ? 'image/tiff' : sig.startsWith('424d') ? 'image/bmp' : null;
      if (!type) throw httpError(415, 'Only JPEG, PNG, TIFF, BMP or PDF scans are kept');
      const { rows } = await query(`SELECT j.id FROM sys_share_jobs j JOIN sys_resources r ON r.id = j.resource_id WHERE j.id = $1 AND r.agent_id = $2 AND j.status = 'working' AND j.kind = 'scan'`, [id, a.id]);
      if (!rows.length) throw httpError(409, 'That scan job is not waiting for a file');
      fs.mkdirSync(SCAN_DIR, { recursive: true });
      const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'application/pdf': '.pdf', 'image/tiff': '.tif', 'image/bmp': '.bmp' }[type];
      const name = 'scan-' + id + '-' + crypto.randomBytes(6).toString('hex') + ext;
      fs.writeFileSync(path.join(SCAN_DIR, name), buf);
      const status = await finishJob(a, id, true, null, 'Scanned (' + Math.round(buf.length / 1024) + ' KB)', { path: name, type, size: buf.length });
      res.json({ ok: true, status });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------- every staff member --
  const publicRes = (r) => ({ id: r.id, kind: r.kind, name: r.name, location: r.location, computer: r.agent_name, online: r.online, waiting: r.waiting,
    paper: r.paper, status: r.win_status, format: r.kind === 'folder' ? (r.config.format || 'text') : undefined,
    to: r.kind === 'email' ? r.config.to : undefined, dpi: r.kind === 'scanner' ? r.config.dpi : undefined, color: r.kind === 'scanner' ? r.config.color : undefined });
  const JOB_SELECT = `j.id, j.kind, j.title, j.copies, j.status, j.attempts, j.error, j.note, j.created_at, j.done_at, j.file_type, j.file_size, (j.file_path IS NOT NULL) AS has_file,
      j.resource_id, COALESCE(r.name, r.sys_name) AS resource_name, r.kind AS resource_kind, u.name AS by_name, j.requested_by
     FROM sys_share_jobs j LEFT JOIN sys_resources r ON r.id = j.resource_id LEFT JOIN users u ON u.id = j.requested_by`;

  app.get('/api/resources', requireAdmin, async (req, res) => {
    try {
      await ready();
      const manage = !req.query.lite && await userCan(req, 'sys.support');
      const { rows } = await query(`SELECT ${RES_SELECT} WHERE ${LIVE} AND r.shared AND r.present ORDER BY CASE r.kind WHEN 'printer' THEN 1 WHEN 'scanner' THEN 2 WHEN 'email' THEN 3 ELSE 4 END, COALESCE(r.name, r.sys_name)`);
      const { rows: mine } = await query(`SELECT ${JOB_SELECT} WHERE j.requested_by = $1 ORDER BY j.id DESC LIMIT 25`, [req.session.userId]);
      const out = { resources: rows.map(publicRes), mine, manage, can_send: await canUse(req, 'printer') };
      if (manage) {
        await sweep();
        const [agents, all, rules, jobs, stores] = await Promise.all([
          query(`SELECT id, name, computer, status, version, ip, windows_user, last_seen, created_at,
                        CASE WHEN status = 'pairing' AND pair_expires > NOW() THEN pair_code END AS pair_code, pair_expires,
                        (status = 'active' AND last_seen > NOW() - INTERVAL '${ONLINE_SECONDS} seconds') AS online
                   FROM sys_share_agents WHERE status <> 'revoked' ORDER BY status, name`),
          query(`SELECT ${RES_SELECT} WHERE ${LIVE} ORDER BY CASE r.kind WHEN 'printer' THEN 1 WHEN 'scanner' THEN 2 WHEN 'email' THEN 3 ELSE 4 END, a.name NULLS FIRST, r.present DESC, COALESCE(r.name, r.sys_name)`),
          query(`SELECT ru.*, COALESCE(r.name, r.sys_name) AS resource_name, r.kind AS resource_kind, l.name AS store_name,
                        (SELECT COUNT(*)::int FROM sys_share_jobs j WHERE j.rule_id = ru.id AND j.status = 'done' AND j.created_at > NOW() - INTERVAL '1 day') AS done_today
                   FROM sys_share_rules ru JOIN sys_resources r ON r.id = ru.resource_id LEFT JOIN store_locations l ON l.id = ru.location_id ORDER BY ru.id`)
            .catch(() => query(`SELECT ru.*, COALESCE(r.name, r.sys_name) AS resource_name, r.kind AS resource_kind, NULL AS store_name, 0 AS done_today FROM sys_share_rules ru JOIN sys_resources r ON r.id = ru.resource_id ORDER BY ru.id`)),
          query(`SELECT ${JOB_SELECT} ORDER BY j.id DESC LIMIT 60`),
          query(`SELECT id, name FROM store_locations WHERE is_active ORDER BY name`).catch(() => ({ rows: [] })),
        ]);
        Object.assign(out, { agents: agents.rows, all: all.rows, rules: rules.rows, jobs: jobs.rows, stores: stores.rows });
      }
      res.json(out);
    } catch (e) { fail(res, e); }
  });

  // Send a sale's receipt to any shared resource (printer, email route, folder).
  app.post('/api/resources/:id/send', requireAdmin, async (req, res) => {
    try {
      await ready();
      const r = await resource(int(req.params.id));
      if (!r || !r.shared || r.kind === 'scanner') throw httpError(404, 'That is not a shared printer, email route or folder');
      if (!(await canUse(req, r.kind))) throw httpError(403, 'Not allowed to send receipts');
      const b = req.body || {};
      let saleId = int(b.sale_id);
      if (!saleId && b.receipt_number) {
        const { rows } = await query(`SELECT id FROM pos_sales WHERE receipt_number = $1 OR invoice_number = $1 ORDER BY id DESC LIMIT 1`, [String(b.receipt_number).trim()]);
        if (!rows.length) throw httpError(404, 'No sale with that receipt number');
        saleId = rows[0].id;
      }
      if (!saleId) throw httpError(400, 'Which sale? (receipt number)');
      const d = await receiptDoc(saleId, txt(b.label, 40));
      const id = await enqueue({ res: r, kind: 'receipt', refId: saleId, title: d.title, doc: d.doc, copies: r.kind === 'printer' ? b.copies : 1, by: req.session.userId });
      await audit(req, 'share.receipt_sent', { job: id, sale: saleId, resource: r.name, kind: r.kind });
      res.json({ ok: true, job_id: id, online: r.online, name: r.name, kind: r.kind });
    } catch (e) { fail(res, e); }
  });

  // Scan on a shared scanner; the picture comes back to the person who asked.
  app.post('/api/resources/:id/scan', requireAdmin, async (req, res) => {
    try {
      await ready();
      const r = await resource(int(req.params.id));
      if (!r || !r.shared || r.kind !== 'scanner') throw httpError(404, 'That is not a shared scanner');
      const b = req.body || {};
      const dpi = [100, 150, 200, 300, 600].includes(int(b.dpi)) ? int(b.dpi) : (r.config.dpi || 200);
      const color = ['color', 'gray', 'bw'].includes(b.color) ? b.color : (r.config.color || 'color');
      const id = await enqueue({ res: r, kind: 'scan', title: txt(b.title, 80) || 'Scan', doc: { dpi, color, device_id: r.config.device_id || null }, by: req.session.userId });
      await audit(req, 'share.scan', { job: id, resource: r.name });
      res.json({ ok: true, job_id: id, online: r.online, name: r.name });
    } catch (e) { fail(res, e); }
  });

  async function myJob(req, id) {
    const { rows } = await query(`SELECT j.*, COALESCE(r.name, r.sys_name) AS resource_name FROM sys_share_jobs j LEFT JOIN sys_resources r ON r.id = j.resource_id WHERE j.id = $1`, [id]);
    if (!rows.length || (rows[0].requested_by !== req.session.userId && !(await userCan(req, 'sys.support')))) throw httpError(404, 'No such job');
    return rows[0];
  }
  app.get('/api/resources/jobs/:id', requireAdmin, async (req, res) => {
    try {
      await ready();
      const j = await myJob(req, int(req.params.id));
      res.json({ id: j.id, status: j.status, error: j.error, note: j.note, has_file: !!j.file_path, file_type: j.file_type });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/resources/jobs/:id/file', requireAdmin, async (req, res) => {
    try {
      await ready();
      const j = await myJob(req, int(req.params.id));
      if (!j.file_path) throw httpError(404, 'No file for this job');
      const p = path.join(SCAN_DIR, path.basename(j.file_path));
      if (!fs.existsSync(p)) throw httpError(410, 'The scanned file is no longer on the server');
      res.setHeader('Content-Type', j.file_type || 'application/octet-stream');
      res.setHeader('Content-Disposition', (req.query.download ? 'attachment' : 'inline') + '; filename="' + safeName(j.title || 'Scan') + '-' + j.id + path.extname(p) + '"');
      res.setHeader('Cache-Control', 'private, no-store');
      fs.createReadStream(p).pipe(res);
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------- manage (IT) --
  app.post('/api/sys/share-agents', ...SUP, async (req, res) => {
    try {
      await ready();
      const name = txt((req.body || {}).name, 80);
      if (!name) throw httpError(400, 'Name the computer (for example "Manager\'s office PC")');
      let row = null;
      for (let i = 0; i < 5 && !row; i++) {
        try {
          row = (await query(`INSERT INTO sys_share_agents (name, pair_code, pair_expires, created_by) VALUES ($1, $2, NOW() + INTERVAL '${PAIR_HOURS} hours', $3) RETURNING id, name, pair_code, pair_expires`,
            [name, newCode(), req.session.userId])).rows[0];
        } catch (e) { if (!/unique/i.test(e.message)) throw e; }
      }
      await audit(req, 'share.agent_added', { agent: row.id, name });
      res.json(row);
    } catch (e) { fail(res, e); }
  });
  app.post('/api/sys/share-agents/:id/new-code', ...SUP, async (req, res) => {
    try {
      await ready();
      const { rows } = await query(`UPDATE sys_share_agents SET pair_code = $2, pair_expires = NOW() + INTERVAL '${PAIR_HOURS} hours', status = 'pairing', key_hash = NULL
                                     WHERE id = $1 AND status <> 'revoked' RETURNING id, name, pair_code, pair_expires`, [int(req.params.id), newCode()]);
      if (!rows.length) throw httpError(404, 'No such computer');
      await audit(req, 'share.agent_repair', { agent: rows[0].id });
      res.json(rows[0]);
    } catch (e) { fail(res, e); }
  });
  app.post('/api/sys/share-agents/:id/remove', ...SUP, async (req, res) => {
    try {
      await ready();
      const id = int(req.params.id);
      const { rows } = await query(`UPDATE sys_share_agents SET status = 'revoked', key_hash = NULL, pair_code = NULL WHERE id = $1 RETURNING name`, [id]);
      if (!rows.length) throw httpError(404, 'No such computer');
      await query(`UPDATE sys_share_rules SET enabled = FALSE WHERE resource_id IN (SELECT id FROM sys_resources WHERE agent_id = $1)`, [id]);
      await query(`UPDATE sys_share_jobs SET status = 'cancelled', done_at = NOW(), error = 'Computer removed' WHERE status IN ('queued', 'working') AND resource_id IN (SELECT id FROM sys_resources WHERE agent_id = $1)`, [id]);
      await audit(req, 'share.agent_removed', { agent: id, name: rows[0].name });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  // The agent script, with this server's address and the pairing code filled in.
  app.get('/api/sys/share-agents/:id/installer', ...SUP, async (req, res) => {
    try {
      await ready();
      const { rows } = await query(`SELECT id, name, pair_code FROM sys_share_agents WHERE id = $1 AND status = 'pairing' AND pair_expires > NOW()`, [int(req.params.id)]);
      if (!rows.length) throw httpError(409, 'Make a new pairing code first');
      let host = String(req.headers.host || '');
      if (!host || /^(localhost|127\.|\[::1\])/i.test(host)) {
        const port = (req.socket && req.socket.localPort) || 3056;
        let ip = null;
        for (const list of Object.values(os.networkInterfaces())) for (const x of list || []) if (!ip && x.family === 'IPv4' && !x.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(x.address)) ip = x.address;
        host = (ip || os.hostname()) + ':' + port;
      }
      const url = (req.secure ? 'https://' : 'http://') + host.replace(/[^A-Za-z0-9.:\-\[\]]/g, '');
      let body = fs.readFileSync(path.join(__dirname, 'tools', 'Vision-Share-Agent.ps1'), 'utf8');
      body = body.replace(/^\$DefaultServer = .*$/m, "$DefaultServer = '" + url + "'").replace(/^\$DefaultCode = .*$/m, "$DefaultCode = '" + rows[0].pair_code + "'");
      await audit(req, 'share.agent_installer', { agent: rows[0].id, server: url });
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="Vision-Share-Agent.ps1"');
      res.send(body.replace(/\r?\n/g, '\r\n'));
    } catch (e) { fail(res, e); }
  });

  // Email routes and folders are made here; printers and scanners arrive from the agents.
  function resourceBody(b, kind, existing) {
    const out = { name: txt(b.name, 80), location: txt(b.location, 80), shared: b.shared !== false, config: Object.assign({}, existing ? existing.config : {}) };
    if (kind === 'email') {
      const to = String(b.to || '').split(/[,;\s]+/).filter(Boolean);
      if (!to.length || to.some((x) => !EMAIL_RE.test(x))) throw httpError(400, 'Give one or more valid email addresses');
      if (to.length > 10) throw httpError(400, 'At most 10 addresses');
      out.config.to = to.join(', ');
      out.config.subject = txt(b.subject, 60) || '';
      if (!out.name) out.name = 'Email to ' + to[0];
    } else if (kind === 'folder') {
      out.config.format = FOLDER_FORMATS.includes(b.format) ? b.format : (out.config.format || 'text');
    } else if (kind === 'scanner') {
      if (b.dpi) out.config.dpi = [100, 150, 200, 300, 600].includes(int(b.dpi)) ? int(b.dpi) : 200;
      if (b.color) out.config.color = ['color', 'gray', 'bw'].includes(b.color) ? b.color : 'color';
    }
    return out;
  }
  app.post('/api/sys/resources', ...SUP, async (req, res) => {
    try {
      await ready();
      const b = req.body || {};
      const kind = b.kind;
      if (kind !== 'email' && kind !== 'folder') throw httpError(400, 'Printers and scanners appear by themselves once their computer runs the agent');
      const r = resourceBody(b, kind);
      let agentId = null, sys = null;
      if (kind === 'folder') {
        agentId = int(b.agent_id);
        const { rows: ag } = await query(`SELECT id FROM sys_share_agents WHERE id = $1 AND status <> 'revoked'`, [agentId]);
        if (!ag.length) throw httpError(400, 'Pick the computer the folder is on');
        sys = String(b.path || '').trim().replace(/\//g, '\\').replace(/\\+$/, '');
        if (!WIN_PATH_RE.test(sys + '\\') || /\\\.\.(\\|$)/.test(sys)) throw httpError(400, 'Give the folder as a full Windows path, like D:\\Vision\\Receipts or \\\\OFFICE-PC\\Share\\Receipts');
        if (!r.name) r.name = path.win32.basename(sys) || sys;
      }
      const { rows } = await query(`INSERT INTO sys_resources (kind, agent_id, sys_name, name, location, shared, config, present, created_by, last_seen) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW()) RETURNING id`,
        [kind, agentId, sys, r.name, r.location, r.shared, JSON.stringify(r.config), kind === 'email', req.session.userId]);
      wake.emit('job');
      await audit(req, 'share.resource_added', { resource: rows[0].id, kind, name: r.name });
      res.json({ ok: true, id: rows[0].id });
    } catch (e) { if (/uq_sys_resources_agent/.test(e.message)) e = httpError(409, 'That folder is already shared'); fail(res, e); }
  });
  app.put('/api/sys/resources/:id', ...SUP, async (req, res) => {
    try {
      await ready();
      const ex = await resource(int(req.params.id));
      if (!ex) throw httpError(404, 'No such resource');
      const r = resourceBody(req.body || {}, ex.kind, ex);
      await query(`UPDATE sys_resources SET name = $2, location = $3, shared = $4, config = $5 WHERE id = $1`, [ex.id, r.name, r.location, r.shared, JSON.stringify(r.config)]);
      await audit(req, 'share.resource_changed', { resource: ex.id, name: r.name, shared: r.shared });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.delete('/api/sys/resources/:id', ...SUP, async (req, res) => {
    try {
      await ready();
      const ex = await resource(int(req.params.id));
      if (!ex) throw httpError(404, 'No such resource');
      if (ex.kind !== 'email' && ex.kind !== 'folder') throw httpError(400, 'Printers and scanners come from their computer: switch off "everyone can use it", or remove the computer');
      await query(`DELETE FROM sys_resources WHERE id = $1`, [ex.id]);
      await audit(req, 'share.resource_removed', { resource: ex.id, name: ex.name });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/sys/resources/:id/test', ...SUP, async (req, res) => {
    try {
      await ready();
      const r = await resource(int(req.params.id));
      if (!r) throw httpError(404, 'No such resource');
      const { rows: u } = await query(`SELECT name FROM users WHERE id = $1`, [req.session.userId]);
      if (r.kind === 'scanner') {
        const id = await enqueue({ res: r, kind: 'scan', title: 'Test scan', doc: { dpi: 100, color: 'gray', device_id: r.config.device_id || null }, by: req.session.userId });
        return res.json({ ok: true, job_id: id, online: r.online });
      }
      const id = await enqueue({ res: r, kind: 'test', title: 'Test', doc: testDoc(r, u[0] && u[0].name), by: req.session.userId });
      res.json({ ok: true, job_id: id, online: r.online });
    } catch (e) { fail(res, e); }
  });

  function ruleBody(b, kind) {
    const docs = DOCS.includes(b.docs) ? b.docs : 'sales';
    const resourceId = int(b.resource_id);
    if (!resourceId) throw httpError(400, 'Pick where the copies go');
    if (docs === 'activity' && kind !== 'folder') throw httpError(400, 'The activity log can only go to a shared folder (as a log file)');
    if (kind === 'scanner') throw httpError(400, 'Copies cannot go to a scanner');
    return { name: txt(b.name, 80) || (docs === 'activity' ? 'Activity log' : 'Copy of every receipt'), resourceId, docs, copies: kind === 'printer' ? Math.max(1, Math.min(5, int(b.copies) || 1)) : 1,
      label: (txt(b.label, 40) || (docs === 'activity' ? 'ACTIVITY' : kind === 'printer' ? 'MANAGER COPY' : 'COPY')).toUpperCase(), locationId: int(b.location_id) || null, enabled: b.enabled !== false };
  }
  async function kindOf(id) { const r = await resource(id); if (!r) throw httpError(400, 'That resource is not available'); return r.kind; }
  app.post('/api/sys/share-rules', ...SUP, async (req, res) => {
    try {
      await ready();
      const b = req.body || {};
      const r = ruleBody(b, await kindOf(int(b.resource_id)));
      const { rows } = await query(`INSERT INTO sys_share_rules (name, resource_id, docs, copies, label, location_id, enabled, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [r.name, r.resourceId, r.docs, r.copies, r.label, r.locationId, r.enabled, req.session.userId]);
      await audit(req, 'share.rule_added', { rule: rows[0].id, name: r.name, resource: r.resourceId, docs: r.docs });
      res.json({ ok: true, id: rows[0].id });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/sys/share-rules/:id', ...SUP, async (req, res) => {
    try {
      await ready();
      const b = req.body || {};
      const r = ruleBody(b, await kindOf(int(b.resource_id)));
      const { rows } = await query(
        `UPDATE sys_share_rules SET name = $2, resource_id = $3, docs = $4, copies = $5, label = $6, location_id = $7,
                active_from = CASE WHEN $8 AND NOT enabled THEN NOW() ELSE active_from END, enabled = $8, updated_at = NOW() WHERE id = $1 RETURNING id`,
        [int(req.params.id), r.name, r.resourceId, r.docs, r.copies, r.label, r.locationId, r.enabled]);
      if (!rows.length) throw httpError(404, 'No such rule');
      await audit(req, 'share.rule_changed', { rule: rows[0].id, enabled: r.enabled });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.delete('/api/sys/share-rules/:id', ...SUP, async (req, res) => {
    try {
      await ready();
      await query(`DELETE FROM sys_share_rules WHERE id = $1`, [int(req.params.id)]);
      await audit(req, 'share.rule_removed', { rule: int(req.params.id) });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/sys/share-jobs/:id/:action(retry|cancel)', ...SUP, async (req, res) => {
    try {
      await ready();
      const id = int(req.params.id);
      const sql = req.params.action === 'retry'
        ? `UPDATE sys_share_jobs SET status = 'queued', attempts = 0, error = NULL, done_at = NULL, created_at = NOW() WHERE id = $1 AND status IN ('failed', 'expired', 'cancelled') RETURNING id, resource_id`
        : `UPDATE sys_share_jobs SET status = 'cancelled', done_at = NOW() WHERE id = $1 AND status IN ('queued', 'working') RETURNING id, resource_id`;
      const { rows } = await query(sql, [id]);
      if (!rows.length) throw httpError(409, req.params.action === 'retry' ? 'Only a failed, expired or cancelled job can be sent again' : 'That job has already finished');
      if (req.params.action === 'retry') {
        const r = await resource(rows[0].resource_id);
        if (r && r.kind === 'email') await deliverEmail(id); else wake.emit('job');
      }
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------- system overview --
  function attach(s) {
    sysops = s;
    if (s && s.addOverview) s.addOverview(async (req, caps) => {
      if (!caps.support) return {};
      try {
        if (!(await tablesExist())) return {};
        const { rows } = await query(`SELECT
            (SELECT COUNT(*)::int FROM sys_share_jobs WHERE status = 'failed' AND done_at > NOW() - INTERVAL '1 day') AS failed,
            (SELECT COUNT(*)::int FROM sys_share_agents WHERE status = 'active' AND (last_seen IS NULL OR last_seen < NOW() - INTERVAL '${ONLINE_SECONDS} seconds')) AS offline`);
        return { sharing: rows[0] };
      } catch (_) { return {}; }
    });
  }
  if (sysops) attach(sysops);

  return { attach, runCopies, receiptDoc, sweep, docText, docHtml };
}

module.exports = { register };
