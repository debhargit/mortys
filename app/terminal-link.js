// =============================================================================
//  Vision Auto Solutions -- terminals: keep selling when the server is down,
//  and what every terminal's connection looks like
//
//    require('./terminal-link').register(app, deps)
//
//  A desktop terminal runs its own copy of this server, which reaches the
//  shop's database over the network. When that database stops answering (the
//  main PC is off, the network is down) the terminal's own server is still up,
//  so it can go on selling from a copy of the catalogue it keeps on its disk:
//
//    snapshot   every 10 minutes while the database answers: products, prices,
//               GCT rates, the staff who may use the till and the shop's
//               receipt details, in data/offline/snapshot.json
//    sale       /offline-till.html rings a sale against that copy; it is kept
//               in data/offline/queue.json with an offline receipt number
//               (OFF-<terminal>-<n>), signed with the key the server gave this
//               terminal and chained to the sale before it, and the receipt
//               prints at once
//    upload     when the database answers again each kept sale is uploaded to
//               offline_sales as 'received' -- a holding area -- and nothing
//               else: the terminal never posts a sale itself
//    check      the shop's server checks each one there (offline-check.js:
//               tampering, injection, prices, totals, times). A clean sale goes
//               through the ordinary sale route (posSaleHandler: totals, GCT,
//               stock, GL) under the cashier who rang it, dated when it was
//               rung; anything found holds it for a manager in System
//               management -> Terminals to approve or reject.
//
//  Every terminal also reports how it is connected (terminals.conn) on its
//  heartbeat, so Settings and System management can show each one's database
//  link, speed, address, version and anything still waiting to be sent, next
//  to the server's own view of who is connected (pg_stat_activity).
//
//  The offline routes never touch the database, so they work while it is down.
//  They only accept a session already signed in on this terminal by someone in
//  the snapshot's staff list: staff stay signed in for 30 days, so a till that
//  was in use when the server went down carries on.
// =============================================================================
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const check = require('./offline-check');

const SNAPSHOT_EVERY_MS = 10 * 60 * 1000;
const PROBE_EVERY_MS = 5000;
const REPORT_EVERY_MS = 15000;
const METHODS = ['cash', 'card', 'bank', 'cheque'];

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function register(app, d) {
  // Mounted straight after the session cookie, ahead of the middleware that asks
  // the database about every request, so nothing here waits on a dead server.
  // posSaleHandler and storeTax are defined further down server.js: getters.
  const { query, requireAdmin, requireManager, userCan, userPermState, getShopSettings, probeDb, terminal, machineName, appVersion } = d;
  const storeTax = { config: (...a) => d.storeTax().config(...a), compute: (...a) => d.storeTax().compute(...a), ratesFor: (...a) => d.storeTax().ratesFor(...a) };
  const posSaleHandler = (...a) => d.posSaleHandler()(...a);
  const DIR = d.dataDir || path.join(__dirname, '..', 'data', 'offline');
  const SNAP = path.join(DIR, 'snapshot.json');
  const QUEUE = path.join(DIR, 'queue.json');
  try { fs.mkdirSync(DIR, { recursive: true }); } catch (_) {}

  const STATE = { dbUp: null, dbMs: null, downSince: null, lastDownAt: null, lastUpAt: null, lastSyncAt: null, syncing: false, startedAt: new Date() };
  let snap = readJson(SNAP, null);
  let byImg = indexSnap(snap);
  let queue = readJson(QUEUE, { seq: 0, sales: [] });

  function readJson(f, dflt) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return dflt; } }
  function writeJson(f, v) { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(v)); fs.renameSync(t, f); }
  function saveQueue() { writeJson(QUEUE, queue); }
  function indexSnap(s) { const m = new Map(); if (s && s.products) for (const p of s.products) m.set(p.img, p); return m; }
  // pending: not sent yet; checking: with the server, being checked; held:
  // waiting for a manager there; sent/rejected: finished. failed = held, for
  // older pages that ask for it.
  function counts() {
    const c = { pending: 0, checking: 0, held: 0, sent: 0, rejected: 0 };
    for (const s of queue.sales) {
      if (s.status === 'sent') c.sent++; else if (s.status === 'rejected') c.rejected++;
      else if (s.status === 'uploaded') c.checking++; else if (s.status === 'held') c.held++; else c.pending++;
    }
    c.failed = c.held;
    return c;
  }
  function fail(res, e) { const s = e.status || 500; if (s >= 500) console.error('[terminal-link]', e); res.status(s).json({ error: e.message }); }
  const bad = (status, message) => Object.assign(new Error(message), { status });

  // ------------------------------------------------------------ snapshot --
  async function takeSnapshot() {
    const cfg = await storeTax.config(query);
    const byCode = Object.fromEntries(cfg.classes.map((c) => [c.code, c]));
    const { rows: prods } = await query(
      `SELECT img, name, sku, barcode, price_usd::float AS price, stock_count AS stock, category, make_model, tax_class
         FROM products WHERE is_active ORDER BY name`);
    const products = prods.map((p) => {
      const cat = String(p.category || '').toLowerCase();
      const code = (p.tax_class && byCode[p.tax_class]) ? p.tax_class : (cfg.categories[cat] && byCode[cfg.categories[cat]]) ? cfg.categories[cat] : cfg.default_class;
      const c = byCode[code] || { code: cfg.default_class, rate: cfg.default_rate };
      return { img: p.img, name: p.name, sku: p.sku || '', barcode: p.barcode || '', price: p.price, stock: p.stock, category: p.category || '', make_model: p.make_model || '',
        tax: { code: c.code, rate: Number(c.rate), standard: c.code === cfg.default_class } };
    });
    const { rows: users } = await query(`SELECT id, name, email FROM users WHERE is_admin AND NOT COALESCE(disabled, false) ORDER BY name`);
    const staff = [];
    for (const u of users) {
      const { full, perms } = await userPermState(u.id);
      const can = (k) => full || perms[k] !== false;
      if (!can('pos.access')) continue;
      staff.push({ id: u.id, name: u.name || u.email, discount: can('pos.line_discount'), price: can('pos.price_override') });
    }
    const shop = await getShopSettings();
    // The key this terminal signs offline sales with (offline-check.js). The
    // server keeps it in terminals.offline_key and checks every signature.
    await ensure();
    const t = terminal() || {};
    let key = snap && snap.key;
    if (t.id) {
      const { rows } = await query('UPDATE terminals SET offline_key = COALESCE(offline_key, $2) WHERE id = $1 RETURNING offline_key', [t.id, crypto.randomBytes(32).toString('hex')]);
      if (rows[0]) key = rows[0].offline_key;
    }
    const s = {
      key,
      at: new Date().toISOString(),
      terminal: { id: (terminal() || {}).id || null, name: machineName() },
      tax: { enabled: cfg.enabled, default_class: cfg.default_class, default_rate: cfg.default_rate, classes: cfg.classes, categories: cfg.categories, freight_taxable: cfg.freight_taxable, freight: cfg.freight },
      shop: { name: shop.company_name, address: shop.address, phone: shop.phone, notice: shop.receipt_notice },
      staff, products,
    };
    writeJson(SNAP, s);
    snap = s; byImg = indexSnap(s);
    // Sales rung offline since have already left the shelf.
    for (const q of queue.sales) if (q.status === 'pending' || q.status === 'uploaded' || q.status === 'held') for (const it of q.body.items) { const p = byImg.get(it.product_img); if (p) p.stock -= Number(it.qty) || 0; }
    return s;
  }

  // ---------------------------------------------------------- is it up? --
  async function probe() {
    const t0 = Date.now();
    let up = false;
    try { await probeDb(); up = true; } catch (_) {}
    const now = new Date();
    if (up) {
      STATE.dbMs = Date.now() - t0;
      if (STATE.dbUp === false) { STATE.lastUpAt = now; console.log('[offline] the database answers again -- sending sales kept on this terminal'); }
      STATE.dbUp = true; STATE.downSince = null;
      if (queue.sales.some((s) => s.status === 'pending' || s.status === 'uploaded' || s.status === 'held')) sync().catch((e) => console.error('[offline] send', e.message));
    } else {
      if (STATE.dbUp !== false) { STATE.downSince = now; STATE.lastDownAt = now; console.warn('[offline] the database is not answering -- this terminal can keep selling on /offline-till.html'); }
      STATE.dbUp = false; STATE.dbMs = null;
    }
  }

  // --------------------------------------------------------------- send --
  // The terminal only uploads: each kept sale goes to offline_sales as
  // 'received', the holding area, and is posted by checkWaiting() below once
  // offline-check.js has looked it over.
  let ensured = false;
  async function ensure() {
    if (ensured) return;
    try {
      await query(`CREATE TABLE IF NOT EXISTS offline_sales (
        id SERIAL PRIMARY KEY, uid TEXT NOT NULL UNIQUE, terminal_id INTEGER, terminal_name TEXT, offline_receipt TEXT,
        cashier_id INTEGER, cashier_name TEXT, rung_at TIMESTAMPTZ NOT NULL, total_usd NUMERIC(12,2), status TEXT NOT NULL DEFAULT 'received',
        sale_id INTEGER, receipt_number TEXT, posted_total_usd NUMERIC(12,2), error TEXT, body JSONB, attempts INTEGER NOT NULL DEFAULT 0,
        synced_at TIMESTAMPTZ, posted_by INTEGER, created_at TIMESTAMPTZ DEFAULT NOW())`);
      for (const c of ['seq INTEGER', 'sig TEXT', 'record JSONB', 'findings JSONB', 'uploaded_by_terminal INTEGER', 'checked_at TIMESTAMPTZ',
        'decided_by INTEGER', 'decided_at TIMESTAMPTZ', 'decision_note TEXT'])
        await query('ALTER TABLE offline_sales ADD COLUMN IF NOT EXISTS ' + c);
      for (const c of ['offline_key TEXT', 'offline_seq INTEGER NOT NULL DEFAULT 0', 'offline_head TEXT'])
        await query('ALTER TABLE terminals ADD COLUMN IF NOT EXISTS ' + c);
    } catch (_) { /* a till without schema rights: schema.sql makes them on the server */ }
    ensured = true;
  }

  // What leaves the terminal: the signed sale, without this terminal's own
  // bookkeeping.
  const LOCAL = new Set(['status', 'tries', 'error', 'sent_at', 'sale_id', 'receipt_number', 'posted', 'findings']);
  const sendable = (rec) => Object.fromEntries(Object.entries(rec).filter(([k]) => !LOCAL.has(k)));

  async function upload(rec) {
    await ensure();
    const me = terminal() || {};
    await query(
      `INSERT INTO offline_sales (uid, terminal_id, terminal_name, offline_receipt, cashier_id, cashier_name, rung_at, total_usd, status, body, record, seq, sig, uploaded_by_terminal)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'received',$9,$10,$11,$12,$13)
       ON CONFLICT (uid) DO NOTHING`,
      [rec.uid, rec.terminal_id, rec.terminal_name, rec.receipt, rec.user_id, rec.user_name, rec.at, rec.total,
       JSON.stringify(rec.body), JSON.stringify(sendable(rec)), rec.seq || null, rec.sig || null, me.id || null]);
  }

  // What the server made of the uploaded ones.
  const FROM_SERVER = { posted: 'sent', held: 'held', failed: 'held', rejected: 'rejected', set_aside: 'rejected', received: 'uploaded', posting: 'uploaded' };
  async function pullStatus() {
    const mine = queue.sales.filter((s) => s.status === 'uploaded' || s.status === 'held');
    if (!mine.length) return;
    const { rows } = await query(`SELECT uid, status, sale_id, receipt_number, posted_total_usd::float AS posted, error, findings FROM offline_sales WHERE uid = ANY($1)`, [mine.map((s) => s.uid)]);
    const byUid = new Map(rows.map((r) => [r.uid, r]));
    let changed = false;
    for (const rec of mine) {
      const r = byUid.get(rec.uid);
      if (!r) { rec.status = 'pending'; changed = true; continue; }   // never arrived: send again
      const st = FROM_SERVER[r.status] || 'uploaded';
      const why = r.error || (Array.isArray(r.findings) && r.findings.length ? r.findings.map((x) => x.text).join(' · ') : null);
      if (st !== rec.status || why !== rec.error) {
        Object.assign(rec, { status: st, error: st === 'sent' ? null : why, sale_id: r.sale_id, receipt_number: r.receipt_number, posted: r.posted });
        if (st === 'sent' || st === 'rejected') rec.sent_at = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) saveQueue();
  }

  async function sync() {
    if (STATE.syncing || !STATE.dbUp) return;
    STATE.syncing = true;
    try {
      for (const rec of queue.sales) {
        if (rec.status !== 'pending') continue;
        try { await upload(rec); } catch (e) { rec.error = e.message; saveQueue(); break; }   // the database went again
        rec.status = 'uploaded'; rec.tries = (rec.tries || 0) + 1; rec.error = null;
        saveQueue();
      }
      await pullStatus();
      STATE.lastSyncAt = new Date();
      // Keep a fortnight of finished sales for reprints; the server has them all.
      const cut = Date.now() - 14 * 86400000;
      const before = queue.sales.length;
      queue.sales = queue.sales.filter((s) => (s.status !== 'sent' && s.status !== 'rejected') || new Date(s.sent_at || s.at).getTime() > cut);
      if (queue.sales.length !== before) saveQueue();
    } finally { STATE.syncing = false; }
  }

  // ------------------------------------------------- checking, then posting --
  // posSaleHandler with the cashier who rang the sale (or the manager who
  // approves it as their own). It re-checks permissions and works out totals,
  // GCT and stock as for any sale.
  function postSale(body, userId) {
    return new Promise((resolve) => {
      const req = { body, session: { userId, discountOk: true }, headers: {}, get: () => undefined, ip: '127.0.0.1', offlineReplay: true };
      const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(o) { resolve({ status: this.statusCode, body: o }); return this; }, set() { return this; } };
      Promise.resolve(posSaleHandler(req, res)).catch((e) => resolve({ status: 500, body: { error: e.message } }));
    });
  }

  // Posts one checked sale; 'posting' first, so a post that dies half-way is
  // found again (by the uid in its note) instead of posted twice.
  async function postRow(row, asUser, by, note) {
    const { rowCount } = await query(`UPDATE offline_sales SET status='posting', attempts=attempts+1 WHERE id=$1 AND status IN ('received','checking','held','failed')`, [row.id]);
    if (!rowCount) return { ok: false, error: 'This sale is no longer waiting.' };
    const r = await postSale(row.body, asUser);
    if (r.status >= 400 || !r.body || !r.body.ok) {
      const error = (r.body && r.body.error) || ('HTTP ' + r.status);
      await query(`UPDATE offline_sales SET status='failed', error=$2 WHERE id=$1`, [row.id, error]);
      return { ok: false, error };
    }
    // Dated when it was rung, not when the server came back.
    await query('UPDATE pos_sales SET created_at = $2 WHERE id = $1', [r.body.id, row.rung_at]);
    await query(`UPDATE offline_sales SET status='posted', sale_id=$2, receipt_number=$3, posted_total_usd=$4, error=NULL, synced_at=NOW(),
                        posted_by=$5, decided_by=COALESCE($5, decided_by), decided_at=CASE WHEN $5::int IS NULL THEN decided_at ELSE NOW() END,
                        decision_note=COALESCE($6, decision_note) WHERE id=$1`,
      [row.id, r.body.id, r.body.receipt_number, r.body.total_usd, by || null, note || null]);
    return { ok: true, sale_id: r.body.id, receipt_number: r.body.receipt_number };
  }

  async function setting(key, dflt) {
    try { const { rows } = await query('SELECT value FROM app_settings WHERE key = $1', [key]); return rows[0] ? rows[0].value : dflt; } catch (_) { return dflt; }
  }

  // Everything offline-check.scan needs about one sale, from the server.
  async function scanRow(row) {
    const rec = row.record || {};
    const { rows: tr } = await query('SELECT * FROM terminals WHERE id = $1', [row.terminal_id]);
    const { rows: ur } = await query('SELECT id, disabled, is_admin FROM users WHERE id = $1', [row.cashier_id]);
    let cashier = { exists: false };
    if (ur[0]) {
      const { full, perms } = await userPermState(ur[0].id);
      cashier = { exists: true, disabled: !!ur[0].disabled || !ur[0].is_admin, can: (k) => full || perms[k] !== false };
    }
    const imgs = ((row.body && Array.isArray(row.body.items)) ? row.body.items : []).map((it) => String((it && it.product_img) || ''));
    const { rows: pr } = await query('SELECT img, name, price_usd::float AS price, is_active FROM products WHERE img = ANY($1)', [imgs]);
    const taxCfg = await storeTax.config(query);
    const taxRates = await storeTax.ratesFor(query, imgs, taxCfg);
    const findings = check.scan(row, {
      terminal: tr[0], uploader: row.uploaded_by_terminal, cashier, products: new Map(pr.map((p) => [p.img, p])),
      taxCfg, taxRates, compute: storeTax.compute, reviewOver: Number(await setting('offline_review_over', '0')) || 0,
    });
    // Straight after a sale that was changed on the terminal, the chain breaks
    // because of that sale, not this one: say so, as a warning.
    const ci = findings.findIndex((x) => x.code === 'chain');
    if (ci >= 0 && Number.isInteger(rec.seq) && rec.seq > 1 && !findings.some((x) => x.code === 'signature')) {
      const { rows: pv } = await query('SELECT offline_receipt, findings FROM offline_sales WHERE terminal_id = $1 AND seq = $2', [row.terminal_id, rec.seq - 1]);
      if (pv[0] && (pv[0].findings || []).some((x) => x.code === 'signature'))
        findings[ci] = { level: 'review', code: 'chain-after', text: 'It comes straight after ' + pv[0].offline_receipt + ', which was changed on the terminal; this sale’s own signature is good.' };
    }
    if (!findings.length && (await setting('offline_review_all', 'off')) === 'on')
      findings.push({ level: 'review', code: 'policy', text: 'Every offline sale waits for a manager (System management → Terminals).' });
    // The chain moves on with every sale that claims the next place, so the
    // one after it is judged against it.
    if (tr[0] && Number.isInteger(rec.seq) && rec.seq > (Number(tr[0].offline_seq) || 0))
      await query('UPDATE terminals SET offline_seq = $2, offline_head = $3 WHERE id = $1', [tr[0].id, rec.seq, check.chainHash(rec)]);
    return findings;
  }

  // The shop's server (the database host) checks what has come in; another
  // terminal does only if sales have waited two minutes, in case it is off.
  // One at a time across the shop (advisory lock), in each terminal's order.
  let checking = false;
  async function checkWaiting() {
    if (checking || !STATE.dbUp) return;
    checking = true;
    let client = null;
    try {
      await ensure();
      const { rows: w } = await query(`SELECT COUNT(*)::int AS n, MIN(created_at) AS oldest FROM offline_sales WHERE status IN ('received','posting')`);
      if (!w[0] || !w[0].n) return;
      if (!(terminal() || {}).is_db_host && Date.now() - new Date(w[0].oldest).getTime() < 120000) return;
      client = await d.getPool().connect();
      await client.query('BEGIN');
      const { rows: [lock] } = await client.query('SELECT pg_try_advisory_xact_lock(74120931) AS ok');
      if (!lock.ok) return;
      // A post that died half-way: posted after all, or back to a person.
      const { rows: stuck } = await query(`SELECT * FROM offline_sales WHERE status = 'posting' AND created_at < NOW() - INTERVAL '2 minutes'`);
      for (const o of stuck) {
        const { rows: s } = await query(`SELECT id, receipt_number, total_usd::float AS total FROM pos_sales WHERE notes LIKE $1 ORDER BY id LIMIT 1`, ['%' + o.uid + '%']);
        if (s[0]) await query(`UPDATE offline_sales SET status='posted', sale_id=$2, receipt_number=$3, posted_total_usd=$4, synced_at=NOW() WHERE id=$1`, [o.id, s[0].id, s[0].receipt_number, s[0].total]);
        else await query(`UPDATE offline_sales SET status='held', findings=COALESCE(findings,'[]'::jsonb) || $2::jsonb WHERE id=$1`, [o.id, JSON.stringify([{ level: 'review', code: 'interrupted', text: 'Posting was interrupted; check it is not already on the system, then approve.' }])]);
      }
      const { rows } = await query(`SELECT * FROM offline_sales WHERE status = 'received' ORDER BY terminal_id, seq NULLS FIRST, id LIMIT 50`);
      for (const row of rows) {
        let findings;
        try { findings = await scanRow(row); } catch (e) { findings = [{ level: 'review', code: 'error', text: 'Could not be checked: ' + e.message }]; }
        await query(`UPDATE offline_sales SET findings=$2::jsonb, checked_at=NOW(), status=$3 WHERE id=$1`, [row.id, JSON.stringify(findings), findings.length ? 'held' : 'checking']);
        if (findings.length) { console.warn('[offline] held ' + row.offline_receipt + ' for a manager: ' + findings.map((f) => f.code).join(', ')); continue; }
        const out = await postRow(row, row.cashier_id, null, null);
        if (!out.ok) console.warn('[offline] ' + row.offline_receipt + ' was clean but the sale route refused it: ' + out.error);
      }
    } catch (e) {
      console.error('[offline] check', e.message);
    } finally {
      if (client) { await client.query('COMMIT').catch(() => {}); client.release(); }
      checking = false;
    }
  }

  // ------------------------------------------------------ what we report --
  function connInfo() {
    let db = {};
    try { db = d.dbTarget() || {}; } catch (_) {}
    const ips = [];
    for (const [name, list] of Object.entries(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) ips.push({ adapter: name, address: a.address, mac: a.mac });
    const c = counts();
    return {
      mode: STATE.dbUp === false ? 'offline' : 'online',
      link: db.loopback ? 'this computer' : (/^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(String(db.host || '')) ? 'shop network' : 'internet'),
      db: { host: db.host || null, port: db.port || null, database: db.database || null, user: db.user || null, ssl: !!db.ssl, pinned: !!db.pinned },
      db_ms: STATE.dbMs,
      app: { version: appVersion, http_port: d.port, https_port: d.port + 1, pid: process.pid, node: process.version, started_at: STATE.startedAt.toISOString(), uptime_s: Math.round(process.uptime()) },
      os: { platform: os.platform(), release: os.release(), hostname: os.hostname(), cpus: os.cpus().length, mem_gb: r2(os.totalmem() / 1073741824), free_gb: r2(os.freemem() / 1073741824) },
      ips,
      offline: { pending: c.pending + c.checking, failed: c.held, snapshot_at: snap && snap.at, snapshot_products: snap ? snap.products.length : 0, last_down_at: STATE.lastDownAt, last_up_at: STATE.lastUpAt, last_sync_at: STATE.lastSyncAt },
      reported_at: new Date().toISOString(),
    };
  }
  let colsOk = null;
  async function report() {
    const t = terminal();
    if (!STATE.dbUp || !t || !t.id) return;
    if (colsOk === null) {
      try {
        await query(`ALTER TABLE terminals ADD COLUMN IF NOT EXISTS conn JSONB`);
        await query(`ALTER TABLE terminals ADD COLUMN IF NOT EXISTS offline_pending INTEGER NOT NULL DEFAULT 0`);
        await query(`ALTER TABLE terminals ADD COLUMN IF NOT EXISTS offline_failed INTEGER NOT NULL DEFAULT 0`);
        colsOk = true;
      } catch (_) { colsOk = true; }
    }
    const c = counts();
    try { await query('UPDATE terminals SET conn=$2::jsonb, offline_pending=$3, offline_failed=$4 WHERE id=$1', [t.id, JSON.stringify(connInfo()), c.pending + c.checking, c.held]); } catch (_) {}
  }

  // ------------------------------------------------------ offline routes --
  // No database here: the session must belong to someone in the snapshot.
  function offlineUser(req) {
    const id = req.session && req.session.userId;
    const t = terminal() || {};
    if (t.status === 'blocked' || t.status === 'pending') throw bad(403, 'This terminal is not allowed to connect.');
    if (!id) throw bad(401, 'Nobody is signed in on this terminal. Offline selling carries on for someone already signed in here; sign in once the server is back.');
    if (!snap) throw bad(503, 'This terminal has no copy of the catalogue yet. It takes one within a few minutes of the server answering.');
    const u = snap.staff.find((s) => s.id === id);
    if (!u) throw bad(403, 'Your account is not one of the till staff on this terminal’s copy.');
    return u;
  }

  app.get('/api/offline/state', (req, res) => {
    let me = null;
    try { me = offlineUser(req); } catch (_) {}
    res.json({
      db_up: STATE.dbUp !== false, db_checked: STATE.dbUp !== null, down_since: STATE.downSince, syncing: STATE.syncing, last_sync_at: STATE.lastSyncAt,
      terminal: machineName(), me, counts: counts(),
      snapshot: snap ? { at: snap.at, products: snap.products.length, tax: snap.tax, shop: snap.shop } : null,
    });
  });

  app.get('/api/offline/search', (req, res) => {
    try {
      offlineUser(req);
      const q = String(req.query.q || '').trim().toLowerCase();
      if (!q) return res.json({ items: [] });
      const exact = snap.products.filter((p) => p.barcode.toLowerCase() === q || p.sku.toLowerCase() === q || p.img.toLowerCase() === q);
      const words = q.split(/\s+/).filter(Boolean);
      const hits = exact.length ? exact : snap.products.filter((p) => {
        const s = (p.name + ' ' + p.sku + ' ' + p.barcode + ' ' + p.make_model + ' ' + p.category).toLowerCase();
        return words.every((w) => s.includes(w));
      });
      res.json({ items: hits.slice(0, 40), more: hits.length > 40, exact: !!exact.length });
    } catch (e) { fail(res, e); }
  });

  // Works out the sale exactly as the receipt will show it, with GCT line by
  // line on the snapshot's rates (store-tax.js compute, as the server does).
  function priceSale(b, u) {
    const items = Array.isArray(b.items) ? b.items : [];
    if (!items.length) throw bad(400, 'Add at least one item.');
    const lines = items.map((it) => {
      const p = byImg.get(it.img);
      if (!p) throw bad(400, 'An item is not in this terminal’s catalogue: ' + it.img);
      const qty = Number(it.qty);
      if (!(qty > 0) || qty > 9999) throw bad(400, 'Check the quantity for ' + p.name);
      let price = r2(p.price);
      const manual = it.price != null && r2(it.price) !== price;
      if (manual) { if (!u.price) throw bad(403, 'Your account is not allowed to change a price.'); price = r2(it.price); }
      if (!(price >= 0)) throw bad(400, 'Check the price for ' + p.name);
      const disc = Math.min(r2(qty * price), Math.max(0, r2(it.discount)));
      if (disc > 0 && !u.discount) throw bad(403, 'Your account is not allowed to give a discount.');
      return { p, qty, price, manual, disc, net: r2(qty * price - disc) };
    });
    const rates = Object.fromEntries(lines.map((l) => [l.p.img, l.p.tax]));
    const tax = storeTax.compute(Object.assign({ classes: [] }, snap.tax), rates, lines.map((l) => ({ img: l.p.img, net: l.net })), 0, 0, {});
    const subtotal = r2(lines.reduce((s, l) => s + l.qty * l.price, 0));
    const discount = r2(lines.reduce((s, l) => s + l.disc, 0));
    const total = r2(subtotal - discount + tax.tax);
    return { lines, tax, subtotal, discount, total };
  }

  app.post('/api/offline/quote', (req, res) => {
    try {
      const u = offlineUser(req);
      const t = priceSale(req.body || {}, u);
      res.json({ subtotal: t.subtotal, discount: t.discount, tax: t.tax.tax, total: t.total, lines: t.lines.map((l, i) => ({ img: l.p.img, net: l.net, tax: t.tax.lines[i].tax, rate: t.tax.lines[i].rate })) });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/offline/sale', (req, res) => {
    try {
      const u = offlineUser(req);
      // Only while the server is down: otherwise the till's own checks (clock-in,
      // cashier station, discount limits) would be one page away from skipped.
      if (STATE.dbUp !== false) throw bad(409, 'The server is answering: ring this sale on the till as usual.');
      const b = req.body || {};
      const uid =/^[A-Za-z0-9-]{16,64}$/.test(String(b.uid || '')) ? String(b.uid) : crypto.randomUUID();
      const dup = queue.sales.find((s) => s.uid === uid);
      if (dup) return res.json({ ok: true, sale: dup, duplicate: true });
      const t = priceSale(b, u);
      const pay = b.payment || {};
      const method = METHODS.includes(pay.method) ? pay.method : null;
      if (!method) throw bad(400, 'Offline the till takes cash, card, bank transfer or cheque.');
      const tendered = method === 'cash' ? r2(pay.tendered != null && pay.tendered !== '' ? pay.tendered : t.total) : t.total;
      if (method === 'cash' && tendered + 0.001 < t.total) throw bad(400, 'The cash given is less than the total.');
      const tid = (terminal() || {}).id || (snap.terminal && snap.terminal.id) || 0;
      queue.seq = (queue.seq || 0) + 1;
      const receipt = 'OFF-' + tid + '-' + String(queue.seq).padStart(4, '0');
      const at = new Date().toISOString();
      const note = 'Rung offline as ' + receipt + ' on ' + machineName() + ' (' + uid + ')';
      const rec = {
        uid, receipt, at, status: 'pending', tries: 0,
        terminal_id: tid || null, terminal_name: machineName(), user_id: u.id, user_name: u.name,
        customer_name: String(b.customer_name || '').slice(0, 200), customer_phone: String(b.customer_phone || '').slice(0, 40),
        method, tendered, change: r2(tendered - t.total), reference: String(pay.reference || '').slice(0, 120),
        subtotal: t.subtotal, discount: t.discount, tax: t.tax.tax, total: t.total,
        lines: t.lines.map((l, i) => ({ img: l.p.img, name: l.p.name, sku: l.p.sku, qty: l.qty, price: l.price, disc: l.disc, net: l.net, rate: t.tax.lines[i].rate })),
        body: {
          items: t.lines.map((l) => ({ product_img: l.p.img, description: l.p.name, qty: l.qty, unit_price_usd: l.price, discount_usd: l.disc, price_manual: l.manual })),
          payment_method: method, amount_tendered: tendered, reference: String(pay.reference || '').slice(0, 120) || null,
          customer_name: String(b.customer_name || '').slice(0, 200) || null, customer_phone: String(b.customer_phone || '').slice(0, 40) || null,
          notes: (String(b.notes || '').slice(0, 500) ? String(b.notes).slice(0, 500) + ' · ' : '') + note,
          cashier_id: u.id,
        },
      };
      // Signed, and chained to the sale before it (offline-check.js).
      Object.assign(rec, { seq: queue.seq, prev: queue.head || '', down_since: STATE.downSince ? STATE.downSince.toISOString() : null });
      rec.sig = snap.key ? check.sign(snap.key, rec) : null;
      queue.head = check.chainHash(rec);
      queue.sales.push(rec);
      saveQueue();
      for (const l of t.lines) l.p.stock -= l.qty;
      res.json({ ok: true, sale: rec });
      if (STATE.dbUp) sync().catch(() => {});
    } catch (e) { fail(res, e); }
  });

  app.get('/api/offline/sales', (req, res) => {
    try { offlineUser(req); res.json({ sales: queue.sales.slice().reverse().slice(0, 200), counts: counts() }); } catch (e) { fail(res, e); }
  });

  app.post('/api/offline/send', async (req, res) => {
    try {
      offlineUser(req);
      if (!STATE.dbUp) throw bad(503, 'The server is still not answering. The sales stay here until it does.');
      await sync(true);
      res.json({ ok: true, counts: counts() });
    } catch (e) { fail(res, e); }
  });

  app.get('/offline-till.html', (req, res) => { res.set('Cache-Control', 'no-cache'); res.sendFile(path.join(__dirname, 'offline-till.html')); });

  // --------------------------------------------- terminals and connections --
  // Mounted later (mountSys) so the usual sign-out and terminal checks run first.
  function mountSys() {
    // Settings -> Terminals & access and System management -> Terminals.
    app.get('/api/sys/terminals', requireAdmin, async (req, res) => {
      try {
        if (!(await userCan(req, 'sys.support')) && !(await userCan(req, 'sys.network')) && !(await userCan(req, 'sys.security')))
          return res.status(403).json({ error: 'You need system management access for this.' });
        await ensure();
        const [{ rows: terms }, { rows: conns }, { rows: srv }, { rows: off }] = await Promise.all([
          query(`SELECT t.*, (NOW() - t.last_seen < INTERVAL '45 seconds') AS online, u.name AS approved_by_name
                   FROM terminals t LEFT JOIN users u ON u.id = t.approved_by ORDER BY t.is_db_host DESC, t.last_seen DESC`),
          query(`SELECT CASE WHEN client_addr IS NULL OR host(client_addr) IN ('127.0.0.1', '::1') THEN 'this computer' ELSE host(client_addr) END AS address, application_name AS app, usename AS db_user,
                        COUNT(*)::int AS connections, COUNT(*) FILTER (WHERE state = 'active')::int AS busy,
                        MIN(backend_start) AS since, MAX(state_change) AS last_activity, BOOL_OR(ssl.ssl) AS ssl
                   FROM pg_stat_activity a LEFT JOIN pg_stat_ssl ssl ON ssl.pid = a.pid
                  WHERE a.datname = current_database() AND a.backend_type = 'client backend'
                  GROUP BY 1, 2, 3 ORDER BY 1, 2`).catch(() => ({ rows: [] })),
          query(`SELECT version() AS version, current_database() AS database, pg_size_pretty(pg_database_size(current_database())) AS size,
                        (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS max_connections,
                        pg_postmaster_start_time() AS started_at, host(inet_server_addr()) AS address, inet_server_port() AS port`).catch(() => ({ rows: [{}] })),
          query(`SELECT o.id, o.uid, o.terminal_id, o.terminal_name, o.offline_receipt, o.cashier_name, o.rung_at, o.total_usd::float AS total,
                        o.status, o.sale_id, o.receipt_number, o.posted_total_usd::float AS posted, o.error, o.attempts, o.synced_at,
                        o.findings, o.checked_at, o.decided_at, o.decision_note, d.name AS decided_by_name, o.body
                   FROM offline_sales o LEFT JOIN users d ON d.id = o.decided_by
                  ORDER BY (o.status IN ('held','failed','received','posting','checking')) DESC, o.rung_at DESC LIMIT 200`).catch(() => ({ rows: [] })),
        ]);
        for (const t of terms) delete t.offline_key;   // the signing key never leaves the server
        const review = { all: (await setting('offline_review_all', 'off')) === 'on', over: Number(await setting('offline_review_over', '0')) || 0 };
        res.json({ terminals: terms, connections: conns, server: srv[0] || {}, offline_sales: off, review, this_terminal_id: (terminal() || {}).id, here: connInfo() });
      } catch (e) { fail(res, e); }
    });

    // A sale the check held, or the sale route refused. Approve posts it under
    // the cashier who rang it; "post as me" under the manager (their own
    // permissions decide); reject keeps it off the books. Blocked findings
    // (tampering, injection) need a note saying why it is safe.
    async function decide(req, res, how) {
      try {
        await ensure();
        const { rows } = await query('SELECT * FROM offline_sales WHERE id = $1', [parseInt(req.params.id, 10) || 0]);
        const o = rows[0];
        if (!o) throw bad(404, 'Not found');
        if (o.status === 'posted') return res.json({ ok: true, already: true, sale_id: o.sale_id });
        const note = String((req.body || {}).note || (req.body || {}).reason || '').trim().slice(0, 500);
        if (how === 'reject') {
          if (!note) throw bad(400, 'Give a reason');
          const { rowCount } = await query(`UPDATE offline_sales SET status='rejected', decided_by=$2, decided_at=NOW(), decision_note=$3 WHERE id=$1 AND status IN ('received','held','failed')`, [o.id, req.session.userId, note]);
          if (!rowCount) throw bad(409, 'This sale is being checked or posted right now; try again in a moment.');
          return res.json({ ok: true });
        }
        if (!['held', 'failed'].includes(o.status)) throw bad(409, 'Only a held or refused sale can be approved (this one is ' + o.status + ').');
        const blocked = (o.findings || []).some((f) => f.level === 'block');
        if (blocked && !note) throw bad(400, 'This sale failed the tampering or injection checks. Say why it is safe to post.');
        const out = await postRow(o, how === 'mine' ? req.session.userId : o.cashier_id, req.session.userId, note || (how === 'mine' ? 'Posted as the manager' : 'Approved'));
        if (!out.ok) throw bad(400, out.error);
        res.json({ ok: true, sale_id: out.sale_id, receipt_number: out.receipt_number });
      } catch (e) { fail(res, e); }
    }
    app.post('/api/sys/offline-sales/:id/approve', requireManager, (req, res) => decide(req, res, 'cashier'));
    app.post('/api/sys/offline-sales/:id/post', requireManager, (req, res) => decide(req, res, 'mine'));
    app.post('/api/sys/offline-sales/:id/reject', requireManager, (req, res) => decide(req, res, 'reject'));
    app.post('/api/sys/offline-sales/:id/set-aside', requireManager, (req, res) => decide(req, res, 'reject'));

    // Hold every offline sale for a manager, and/or any over an amount.
    app.post('/api/sys/offline-review', requireManager, async (req, res) => {
      try {
        const b = req.body || {};
        const put = (k, v) => query(`INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [k, v]);
        if (b.all != null) await put('offline_review_all', b.all ? 'on' : 'off');
        if (b.over != null) await put('offline_review_over', String(Math.max(0, Number(b.over) || 0)));
        res.json({ ok: true });
      } catch (e) { fail(res, e); }
    });

  }

  // --------------------------------------------------------------- timers --
  probe();
  setInterval(probe, PROBE_EVERY_MS).unref();
  setInterval(report, REPORT_EVERY_MS).unref();
  setInterval(() => { checkWaiting(); }, 10000).unref();
  const snapTick = () => { if (STATE.dbUp) takeSnapshot().catch((e) => console.warn('[offline] snapshot:', e.message)); };
  setTimeout(snapTick, 20000).unref();
  setInterval(snapTick, SNAPSHOT_EVERY_MS).unref();

  return { mountSys, state: () => Object.assign({}, STATE, { counts: counts() }), takeSnapshot, sync, connInfo };
}

module.exports = { register };
