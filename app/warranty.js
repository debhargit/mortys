'use strict';
// =============================================================================
//  Morty's Auto Parts -- warranty: rules (plans), the register, and claims
//  with photos, tied to the inventory item and the sale line it was sold on.
//
//  Mounted from posaddons.js (which used to hold the register and a bare
//  claims list): require('./warranty').register(app, deps). server.js calls
//  stampLine() as each sale line is written, so the line keeps a copy of the
//  warranty terms it was sold under; changing a plan later never changes what
//  a customer already bought.
//
//  A plan says how much of a replacement the shop covers as the warranty runs:
//    full      the shop covers it all, the whole period
//    prorated  free for the first N days, then the customer pays the share of
//              the period already used (60% of the period gone = pays 60%)
//    tiered    steps: "up to 50% of the period, pays 0%; up to 100%, pays 50%"
//  A product gets its plan from the product, else its category, else the
//  default plan. The period is the product's warranty days, else the plan's.
//
//  Tables (schema.sql, WARRANTY RULES AND CLAIM PHOTOS): warranty_plans,
//  warranty_plan_categories, warranty_claim_photos; new columns on products,
//  pos_sale_items and warranty_claims. ensure() makes them on first use too, so
//  this works before the next schema apply. No DDL runs at startup.
//  Posts nothing to the ledger: a refund or a replacement sale still goes
//  through the ordinary return / sale.
// =============================================================================
const fs = require('fs');
const path = require('path');
const agree = require('./warranty-agree');

const CLAIM_STATUS = ['open', 'repair', 'replace', 'refund', 'denied', 'closed'];
const METHODS = ['full', 'prorated', 'tiered'];
const PHOTO_KINDS = ['photo', 'scan', 'receipt', 'other'];
const MAKER_STATUS = ['to_send', 'sent', 'approved', 'rejected', 'credited'];
const ID_TYPES = ['National ID', "Driver's licence", 'Passport', 'TRN', 'Other'];
const DISPOSITIONS = ['back to supplier', 'back to maker', 'scrap', 'keep for testing', 'returned to customer'];
const DAY = 86400000;
const r2 = (n) => Math.round(Number(n) * 100) / 100;
const ymd = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const today = () => new Date().toISOString().slice(0, 10);

const DDL = `
CREATE TABLE IF NOT EXISTS warranty_plans (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  method        TEXT NOT NULL DEFAULT 'full' CHECK (method IN ('full', 'prorated', 'tiered')),
  period_days   INTEGER,
  free_days     INTEGER NOT NULL DEFAULT 0,
  tiers         JSONB NOT NULL DEFAULT '[]'::jsonb,
  price_basis   TEXT NOT NULL DEFAULT 'current' CHECK (price_basis IN ('current', 'original')),
  remedy        TEXT NOT NULL DEFAULT 'replace' CHECK (remedy IN ('replace', 'refund', 'either')),
  labour_covered BOOLEAN NOT NULL DEFAULT false,
  max_claims    INTEGER,
  needs_photo   BOOLEAN NOT NULL DEFAULT false,
  notes         TEXT,
  is_default    BOOLEAN NOT NULL DEFAULT false,
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS warranty_plan_categories (
  category  TEXT PRIMARY KEY,
  plan_id   INTEGER NOT NULL REFERENCES warranty_plans(id) ON DELETE CASCADE
);
ALTER TABLE products ADD COLUMN IF NOT EXISTS warranty_plan_id INTEGER REFERENCES warranty_plans(id) ON DELETE SET NULL;
ALTER TABLE pos_sale_items ADD COLUMN IF NOT EXISTS warranty_plan_id INTEGER;
ALTER TABLE pos_sale_items ADD COLUMN IF NOT EXISTS warranty_terms JSONB;
ALTER TABLE warranty_claims ADD COLUMN IF NOT EXISTS product_id INTEGER;
ALTER TABLE warranty_claims ADD COLUMN IF NOT EXISTS qty INTEGER NOT NULL DEFAULT 1;
ALTER TABLE warranty_claims ADD COLUMN IF NOT EXISTS sold_on DATE;
ALTER TABLE warranty_claims ADD COLUMN IF NOT EXISTS warranty_until DATE;
ALTER TABLE warranty_claims ADD COLUMN IF NOT EXISTS plan_id INTEGER;
ALTER TABLE warranty_claims ADD COLUMN IF NOT EXISTS terms JSONB;
ALTER TABLE warranty_claims ADD COLUMN IF NOT EXISTS used_days INTEGER;
ALTER TABLE warranty_claims ADD COLUMN IF NOT EXISTS period_days INTEGER;
ALTER TABLE warranty_claims ADD COLUMN IF NOT EXISTS pays_pct NUMERIC(6,2);
ALTER TABLE warranty_claims ADD COLUMN IF NOT EXISTS replacement_img TEXT;
ALTER TABLE warranty_claims ADD COLUMN IF NOT EXISTS replacement_price_usd NUMERIC(10,2);
ALTER TABLE warranty_claims ADD COLUMN IF NOT EXISTS customer_pays_usd NUMERIC(10,2);
ALTER TABLE warranty_claims ADD COLUMN IF NOT EXISTS covered_usd NUMERIC(10,2);
ALTER TABLE warranty_claims ADD COLUMN IF NOT EXISTS vehicle TEXT;
ALTER TABLE warranty_claims ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
CREATE TABLE IF NOT EXISTS warranty_claim_photos (
  id           SERIAL PRIMARY KEY,
  claim_id     INTEGER NOT NULL REFERENCES warranty_claims(id) ON DELETE CASCADE,
  url          TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'photo' CHECK (kind IN ('photo', 'scan', 'receipt', 'other')),
  caption      TEXT,
  uploaded_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_warranty_claim_photos ON warranty_claim_photos (claim_id);
-- WARRANTY-RULES-2: what a plan needs before a claim is settled, the maker's warranty, the old part.
ALTER TABLE warranty_plans ADD COLUMN IF NOT EXISTS needs_id BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE warranty_plans ADD COLUMN IF NOT EXISTS needs_serial BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE warranty_plans ADD COLUMN IF NOT EXISTS needs_model BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE warranty_plans ADD COLUMN IF NOT EXISTS return_old BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE warranty_plans ADD COLUMN IF NOT EXISTS maker_warranty BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE warranty_plans ADD COLUMN IF NOT EXISTS maker_name TEXT;
ALTER TABLE warranty_claims ADD COLUMN IF NOT EXISTS customer_email TEXT;
ALTER TABLE warranty_claims ADD COLUMN IF NOT EXISTS id_type TEXT;
ALTER TABLE warranty_claims ADD COLUMN IF NOT EXISTS id_number TEXT;
ALTER TABLE warranty_claims ADD COLUMN IF NOT EXISTS id_checked_by INTEGER;
ALTER TABLE warranty_claims ADD COLUMN IF NOT EXISTS id_checked_at TIMESTAMPTZ;
ALTER TABLE warranty_claims ADD COLUMN IF NOT EXISTS model_number TEXT;
ALTER TABLE warranty_claims ADD COLUMN IF NOT EXISTS maker_name TEXT;
ALTER TABLE warranty_claims ADD COLUMN IF NOT EXISTS maker_claim_no TEXT;
ALTER TABLE warranty_claims ADD COLUMN IF NOT EXISTS maker_status TEXT;
ALTER TABLE warranty_claims ADD COLUMN IF NOT EXISTS maker_note TEXT;
ALTER TABLE warranty_claims ADD COLUMN IF NOT EXISTS old_returned BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE warranty_claims ADD COLUMN IF NOT EXISTS old_returned_at TIMESTAMPTZ;
ALTER TABLE warranty_claims ADD COLUMN IF NOT EXISTS old_returned_by INTEGER;
ALTER TABLE warranty_claims ADD COLUMN IF NOT EXISTS old_disposition TEXT;
CREATE INDEX IF NOT EXISTS idx_warranty_claims_product ON warranty_claims (product_img);
CREATE INDEX IF NOT EXISTS idx_warranty_claims_sale ON warranty_claims (sale_id);
-- WARRANTY-NOTIFY: who a claim is assigned to, who gets told, and a log of every message sent.
ALTER TABLE warranty_plans ADD COLUMN IF NOT EXISTS assign_to INTEGER;
ALTER TABLE warranty_claims ADD COLUMN IF NOT EXISTS assigned_to INTEGER;
CREATE TABLE IF NOT EXISTS warranty_settings (
  key    TEXT PRIMARY KEY,
  value  JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS warranty_claim_messages (
  id          SERIAL PRIMARY KEY,
  claim_id    INTEGER NOT NULL REFERENCES warranty_claims(id) ON DELETE CASCADE,
  event       TEXT NOT NULL,
  audience    TEXT NOT NULL,
  channel     TEXT NOT NULL,
  sent_to     TEXT,
  subject     TEXT,
  body        TEXT,
  outcome     TEXT NOT NULL,
  error       TEXT,
  sent_by     INTEGER,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_warranty_claim_messages ON warranty_claim_messages (claim_id, id);
-- WARRANTY-AGREE: the warranty agreement (wording per plan, a signed copy per sale line or claim, e-signing).
ALTER TABLE warranty_plans ADD COLUMN IF NOT EXISTS needs_signature BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE warranty_plans ADD COLUMN IF NOT EXISTS agreement_text TEXT;
ALTER TABLE warranty_plans ADD COLUMN IF NOT EXISTS agreement_file TEXT;
ALTER TABLE warranty_plans ADD COLUMN IF NOT EXISTS agreement_file_name TEXT;
CREATE TABLE IF NOT EXISTS warranty_agreements (
  id             SERIAL PRIMARY KEY,
  sale_item_id   INTEGER,
  sale_id        INTEGER,
  claim_id       INTEGER REFERENCES warranty_claims(id) ON DELETE SET NULL,
  plan_id        INTEGER,
  title          TEXT NOT NULL,
  body           TEXT NOT NULL,
  doc_url        TEXT,
  doc_name       TEXT,
  customer_name  TEXT,
  customer_email TEXT,
  customer_phone TEXT,
  status         TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'signed', 'uploaded', 'void')),
  token_hash     TEXT,
  token_expires  TIMESTAMPTZ,
  link_sent_to   TEXT,
  signed_name    TEXT,
  signature_url  TEXT,
  signed_at      TIMESTAMPTZ,
  signed_ip      TEXT,
  signed_device  TEXT,
  signed_via     TEXT,
  witness_by     INTEGER,
  doc_hash       TEXT,
  file_url       TEXT,
  file_name      TEXT,
  file_by        INTEGER,
  file_at        TIMESTAMPTZ,
  void_reason    TEXT,
  history        JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by     INTEGER,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_warranty_agreements_line ON warranty_agreements (sale_item_id);
CREATE INDEX IF NOT EXISTS idx_warranty_agreements_claim ON warranty_agreements (claim_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_warranty_agreements_token ON warranty_agreements (token_hash) WHERE token_hash IS NOT NULL;
-- Three example plans to start from, only when there are none yet.
INSERT INTO warranty_plans (name, method, period_days, free_days, tiers, is_default, notes)
SELECT * FROM (VALUES
  ('Full replacement', 'full', NULL::int, 0, '[]'::jsonb, true, 'Free replacement for the whole warranty period.'),
  ('Prorated', 'prorated', NULL::int, 30, '[]'::jsonb, false, 'Free for the first 30 days, then the customer pays the share of the period used.'),
  ('Half period, then 50% off', 'tiered', NULL::int, 0, '[{"upto_pct":50,"pays_pct":0},{"upto_pct":100,"pays_pct":50}]'::jsonb, false, 'Free replacement in the first half of the period, 50% off a replacement in the second half.')
) v(name, method, period_days, free_days, tiers, is_default, notes)
WHERE NOT EXISTS (SELECT 1 FROM warranty_plans);
`;

// ---- the rule maths (same function runs in warranty.html and admin.html) ----
function cleanTiers(t) {
  let a = Array.isArray(t) ? t : [];
  a = a.map((x) => ({ upto_pct: Math.max(0, Math.min(100, Number(x.upto_pct))), pays_pct: Math.max(0, Math.min(100, Number(x.pays_pct))) }))
    .filter((x) => Number.isFinite(x.upto_pct) && Number.isFinite(x.pays_pct) && x.upto_pct > 0)
    .sort((x, y) => x.upto_pct - y.upto_pct);
  return a.slice(0, 12);
}
// terms: the plan as copied onto a sale line. soldOn / until: dates. on: claim date.
function coverage(terms, soldOn, until, on) {
  terms = terms || { method: 'full' };
  const s = soldOn ? new Date(ymd(soldOn)) : null;
  const o = new Date(ymd(on || new Date()));
  let u = until ? new Date(ymd(until)) : null;
  if (!u && s && terms.period_days) u = new Date(s.getTime() + terms.period_days * DAY);
  if (!s || !u) return { known: false, pays_pct: null, covered_pct: null, rule: ruleText(terms) };
  const total = Math.max(1, Math.round((u - s) / DAY));
  const used = Math.max(0, Math.round((o - s) / DAY));
  const usedPct = Math.min(1000, Math.round((used / total) * 1000) / 10);
  const out = { known: true, period_days: total, used_days: used, left_days: Math.max(0, total - used), used_pct: usedPct,
    sold_on: ymd(s), until: ymd(u), expired: o > u, rule: ruleText(terms), step: null };
  let pays;
  if (out.expired) pays = 100;
  else if (terms.method === 'prorated') pays = used <= (Number(terms.free_days) || 0) ? 0 : Math.min(100, Math.round(usedPct));
  else if (terms.method === 'tiered') {
    const tiers = cleanTiers(terms.tiers);
    const t = tiers.find((x) => usedPct <= x.upto_pct);
    pays = t ? t.pays_pct : 100;
    out.step = t || null;
  } else pays = 0;
  out.pays_pct = pays;
  out.covered_pct = 100 - pays;
  return out;
}
function ruleText(t) {
  if (!t) return 'No warranty';
  const days = t.period_days ? t.period_days + ' days' : 'the warranty period';
  if (t.method === 'prorated') {
    return (t.free_days ? 'Free replacement for the first ' + t.free_days + ' days, then the' : 'The') +
      ' customer pays the share of ' + days + ' already used';
  }
  if (t.method === 'tiered') {
    const tiers = cleanTiers(t.tiers);
    if (!tiers.length) return 'Full replacement for ' + days;
    let from = 0;
    const say = (p) => (p === 0 ? 'free replacement' : p >= 100 ? 'not covered' : (100 - p) + '% off a replacement');
    const parts = tiers.map((x) => { const s = from + '–' + x.upto_pct + '%: ' + say(x.pays_pct); from = x.upto_pct; return s; });
    if (from < 100) parts.push(from + '–100%: not covered');
    return 'Through ' + days + ' — ' + parts.join('; ');
  }
  return 'Full replacement for ' + days;
}
// What a claim needs before it can be settled (repair / replace / refund), from its plan.
function requirements(terms, c, photos) {
  const t = terms || {}, out = [];
  if (t.needs_id) out.push({ key: 'id', label: 'the customer\'s ID checked', met: !!(c.id_number && String(c.id_number).trim()) });
  if (t.needs_serial) out.push({ key: 'serial', label: 'the serial number', met: !!(c.serial && String(c.serial).trim()) });
  if (t.needs_model) out.push({ key: 'model', label: 'the model number', met: !!(c.model_number && String(c.model_number).trim()) });
  if (t.needs_photo) out.push({ key: 'photo', label: 'a photo of the part', met: photos > 0 });
  if (t.return_old) out.push({ key: 'old', label: 'the old part handed back', met: !!c.old_returned });
  if (t.needs_signature) out.push({ key: 'signed', label: 'the warranty agreement signed', met: !!c.agreement_signed });
  return out;
}
function termsOf(plan, periodDays) {
  if (!plan) return { plan_id: null, name: 'Standard (full replacement)', method: 'full', period_days: periodDays || null, free_days: 0, tiers: [], price_basis: 'current', remedy: 'replace', labour_covered: false, max_claims: null };
  return { plan_id: plan.id, name: plan.name, method: plan.method, period_days: periodDays || plan.period_days || null, free_days: plan.free_days || 0,
    tiers: cleanTiers(plan.tiers), price_basis: plan.price_basis, remedy: plan.remedy, labour_covered: !!plan.labour_covered, max_claims: plan.max_claims, needs_photo: !!plan.needs_photo, notes: plan.notes || null,
    needs_id: !!plan.needs_id, needs_serial: !!plan.needs_serial, needs_model: !!plan.needs_model, return_old: !!plan.return_old,
    maker_warranty: !!plan.maker_warranty, maker_name: plan.maker_name || null, assign_to: plan.assign_to || null, needs_signature: !!plan.needs_signature };
}

// ---- module state --------------------------------------------------------
let _ready = null;
let _deps = null;
function ensure(query) {
  if (!_ready) _ready = query(DDL).then(() => true).catch((e) => { _ready = null; throw e; });
  return _ready;
}

// The plan a product sells under: its own, else its category's, else the default.
async function planFor(q, productImg) {
  const { rows } = await q(
    `SELECT p.img, p.warranty_days, p.category,
            COALESCE(pp.id, cp.id, dp.id) AS plan_id
       FROM (SELECT $1::text AS img) x
       LEFT JOIN products p ON p.img = x.img
       LEFT JOIN warranty_plans pp ON pp.id = p.warranty_plan_id AND pp.active
       LEFT JOIN warranty_plan_categories wpc ON wpc.category = p.category
       LEFT JOIN warranty_plans cp ON cp.id = wpc.plan_id AND cp.active
       LEFT JOIN LATERAL (SELECT id FROM warranty_plans WHERE is_default AND active ORDER BY id LIMIT 1) dp ON true`, [productImg]);
  const r = rows[0] || {};
  const plan = r.plan_id ? (await q('SELECT * FROM warranty_plans WHERE id = $1', [r.plan_id])).rows[0] : null;
  return { plan, warranty_days: r.warranty_days || null, category: r.category || null };
}

// Called by server.js inside the sale transaction, right after a line is
// written. A savepoint keeps any failure here (say the tables are not made
// yet) from spoiling the sale.
async function stampLine(client, saleItemId, productImg, warrantyDays) {
  if (!productImg || !saleItemId) return;
  await client.query('SAVEPOINT wr_stamp');
  try {
    const q = (t, p) => client.query(t, p);
    const { plan, warranty_days } = await planFor(q, productImg);
    const days = Number(warrantyDays) || warranty_days || (plan && plan.period_days) || null;
    if (!days) { await client.query('RELEASE SAVEPOINT wr_stamp'); return; }
    const terms = termsOf(plan, days);
    await client.query(
      `UPDATE pos_sale_items SET warranty_plan_id = $2, warranty_terms = $3::jsonb,
              warranty_until = COALESCE(warranty_until, CURRENT_DATE + $4::int) WHERE id = $1`,
      [saleItemId, plan ? plan.id : null, JSON.stringify(terms), days]);
    await client.query('RELEASE SAVEPOINT wr_stamp');
  } catch (e) {
    try { await client.query('ROLLBACK TO SAVEPOINT wr_stamp'); } catch (_) {}
    console.warn('[warranty] could not stamp sale line', saleItemId, e.message);
  }
}

function register(app, deps) {
  const { query, requireAdmin, requireManager, userCan, upload } = deps;
  const mailer = deps.mailer || null, sms = deps.sms || null, notice = deps.notice || null, getShop = deps.getShop || (async () => ({}));
  _deps = deps;
  const UP = path.join(__dirname, 'uploads');
  // multer's own errors (not a picture, too big) come back as JSON, not the HTML error page.
  const multi = upload && upload.array ? upload.array('photos', 12) : null;
  const photoUpload = (req, res, next) => (multi ? multi(req, res, (err) => (err ? res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'A picture is over 8 MB.' : err.message }) : next())) : next());

  function fail(res, e) {
    const s = e.status || 500;
    if (s >= 500) console.error('[warranty]', e);
    res.status(s).json({ error: e.publicMessage || e.message });
  }
  function httpError(status, msg) { const e = new Error(msg); e.status = status; e.publicMessage = msg; return e; }
  const one = async (sql, p) => (await query(sql, p)).rows[0] || null;
  const ready = (req, res, next) => ensure(query).then(() => next(), (e) => fail(res, e));
  const W = '/api/admin/warranty';
  app.use(W, ready);

  // ------------------------------------------------------- notifications --
  // Who is told what. Customer: email and / or SMS. Company: the shop's email
  // address, plus a notice under the bell for the claim's assigned person and
  // the people picked in the settings. Every message is logged on the claim;
  // a failure to send never stops the claim being saved.
  const NOTIFY_DEFAULTS = {
    customer_email: true, customer_sms: false,
    customer_events: ['opened', 'replace', 'repair', 'refund', 'denied'],
    company_email: '', company_events: ['opened', 'replace', 'repair', 'refund', 'denied', 'closed', 'maker'],
    staff: [], default_assign_to: null,
  };
  const EVENTS = ['opened', 'assigned', 'replace', 'repair', 'refund', 'denied', 'closed', 'maker', 'message'];
  async function settings() {
    const r = await one(`SELECT value FROM warranty_settings WHERE key = 'notify'`);
    return Object.assign({}, NOTIFY_DEFAULTS, r ? r.value : {});
  }
  const money$ = (n) => (n == null ? '' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const wcNo = (id) => 'WC-' + String(id).padStart(5, '0');
  async function claimFull(id) {
    return one(`SELECT wc.*, COALESCE(p.name, psi.description, wc.product_img) AS product_name, ps.receipt_number, au.name AS assigned_name
                  FROM warranty_claims wc LEFT JOIN products p ON p.img = wc.product_img LEFT JOIN pos_sale_items psi ON psi.id = wc.sale_item_id
                  LEFT JOIN pos_sales ps ON ps.id = wc.sale_id LEFT JOIN users au ON au.id = wc.assigned_to WHERE wc.id = $1`, [id]);
  }
  // The words for each event, for the customer and for the shop.
  function words(ev, c, shop, extra) {
    const part = c.product_name || 'your part', no = wcNo(c.id), first = String(c.customer_name || '').split(' ')[0] || 'there';
    const sign = (shop.name || 'Morty\'s Auto Parts') + (shop.phone ? ' · ' + shop.phone : '');
    const pays = Number(c.customer_pays_usd) > 0 ? ' Your share is ' + money$(c.customer_pays_usd) + '.' : '';
    const cust = {
      opened: ['We have your warranty claim ' + no, 'Hi ' + first + ', we have received your warranty claim ' + no + ' for ' + part + (c.receipt_number ? ' (receipt ' + c.receipt_number + ')' : '') + '. We will let you know as soon as it is settled.'],
      replace: ['Your replacement is ready: ' + no, 'Hi ' + first + ', your warranty claim ' + no + ' for ' + part + ' is approved and the replacement is ready.' + pays],
      repair: ['Your part has been repaired: ' + no, 'Hi ' + first + ', ' + part + ' (claim ' + no + ') has been repaired under warranty and is ready to collect.'],
      refund: ['Your warranty refund: ' + no, 'Hi ' + first + ', your warranty claim ' + no + ' for ' + part + ' has been settled with a refund.'],
      denied: ['About your warranty claim ' + no, 'Hi ' + first + ', we are sorry, your warranty claim ' + no + ' for ' + part + ' could not be covered.' + (c.resolution_note ? ' Reason: ' + c.resolution_note : '') + ' Please call us if you have questions.'],
      closed: ['Warranty claim ' + no + ' closed', 'Hi ' + first + ', your warranty claim ' + no + ' for ' + part + ' is now closed.'],
      message: [(extra && extra.subject) || ('About your warranty claim ' + no), (extra && extra.text) || ''],
    }[ev];
    const who = c.customer_name || 'a customer';
    const co = {
      opened: ['🛡 New warranty claim ' + no, part + ' · ' + who + (c.fault ? ' · ' + c.fault : '')],
      assigned: ['🛡 ' + no + ' is yours', part + ' · ' + who + ' (assigned by ' + ((extra && extra.by) || 'the system') + ')'],
      replace: ['🛡 ' + no + ' replaced', part + ' · ' + who + (Number(c.customer_pays_usd) > 0 ? ' · customer pays ' + money$(c.customer_pays_usd) : ' · free')],
      repair: ['🛡 ' + no + ' repaired', part + ' · ' + who],
      refund: ['🛡 ' + no + ' refunded', part + ' · ' + who],
      denied: ['🛡 ' + no + ' turned down', part + ' · ' + who + (c.resolution_note ? ' · ' + c.resolution_note : '')],
      closed: ['🛡 ' + no + ' closed', part + ' · ' + who],
      maker: ['🏭 ' + no + ': ' + ((extra && extra.makerLabel) || 'maker update'), part + (c.maker_name ? ' · ' + c.maker_name : '') + (c.maker_claim_no ? ' · ' + c.maker_claim_no : '') + (c.maker_note ? ' · ' + c.maker_note : '')],
    }[ev];
    return { cust: cust ? { subject: cust[0], text: cust[1] + '\n\n' + sign, sms: (cust[1] + ' ' + sign).slice(0, 300) } : null, co: co ? { title: co[0], body: co[1] } : null };
  }
  async function logMsg(c, ev, audience, channel, to, subject, body, outcome, error, by) {
    try {
      await query(`INSERT INTO warranty_claim_messages (claim_id, event, audience, channel, sent_to, subject, body, outcome, error, sent_by)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [c.id, ev, audience, channel, to ? String(to).slice(0, 300) : null, subject ? String(subject).slice(0, 200) : null,
        body ? String(body).slice(0, 2000) : null, outcome, error ? String(error).slice(0, 300) : null, by || null]);
    } catch (e) { console.warn('[warranty] could not log a message', e.message); }
  }
  const htmlOf = (text) => '<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#0f1720">' +
    String(text).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch])).replace(/\n/g, '<br>') + '</div>';
  async function sendEmail(c, ev, audience, to, subject, text, by) {
    if (!mailer || !mailer.sendEmail) return logMsg(c, ev, audience, 'email', to, subject, text, 'skipped', 'Email is not available on this server', by);
    try {
      const r = await mailer.sendEmail({ to, subject, text, html: htmlOf(text) });
      await logMsg(c, ev, audience, 'email', to, subject, text, r && r.stubbed ? 'not set up' : 'sent', r && r.stubbed ? 'Email (SMTP) is not set up yet, so it was not sent' : null, by);
    } catch (e) { await logMsg(c, ev, audience, 'email', to, subject, text, 'failed', e.message, by); }
  }
  // ev: opened | assigned | replace | repair | refund | denied | closed | maker | message
  // opt: { tellCustomer (default true), by (user id), extra, only: 'customer' | 'company' }
  async function notify(claimId, ev, opt = {}) {
    try {
      const c = await claimFull(claimId);
      if (!c) return;
      const st = await settings();
      const shop = await getShop().catch(() => ({})) || {};
      const byName = opt.by ? ((await one('SELECT name FROM users WHERE id = $1', [opt.by])) || {}).name : null;
      const w = words(ev, c, shop, Object.assign({ by: byName }, opt.extra || {}));
      // the customer
      const custWanted = opt.only !== 'company' && opt.tellCustomer !== false && w.cust && (ev === 'message' || (st.customer_events || []).includes(ev));
      if (custWanted) {
        const viaEmail = opt.channels ? opt.channels.includes('email') : st.customer_email;
        const viaSms = opt.channels ? opt.channels.includes('sms') : st.customer_sms;
        if (viaEmail && c.customer_email) await sendEmail(c, ev, 'customer', c.customer_email, w.cust.subject, w.cust.text, opt.by);
        if (viaSms && c.customer_phone) {
          if (!sms || !sms.sendSMS) await logMsg(c, ev, 'customer', 'sms', c.customer_phone, null, w.cust.sms, 'skipped', 'SMS is not available on this server', opt.by);
          else {
            try { const r = await sms.sendSMS({ to: c.customer_phone, body: w.cust.sms });
              await logMsg(c, ev, 'customer', 'sms', c.customer_phone, null, w.cust.sms, r && r.stubbed ? 'not set up' : 'sent', r && r.stubbed ? 'SMS (Twilio) is not set up yet, so it was not sent' : null, opt.by);
            } catch (e) { await logMsg(c, ev, 'customer', 'sms', c.customer_phone, null, w.cust.sms, 'failed', e.message, opt.by); }
          }
        }
        if ((viaEmail && !c.customer_email) && (!viaSms || !c.customer_phone)) await logMsg(c, ev, 'customer', 'email', null, w.cust.subject, null, 'skipped', 'No email for this customer', opt.by);
      }
      // the company
      if (opt.only !== 'customer' && w.co) {
        const coEvents = st.company_events || [];
        const people = new Set();
        if (ev === 'assigned') { if (c.assigned_to && c.assigned_to !== opt.by) people.add(c.assigned_to); }
        else if (coEvents.includes(ev)) {
          if (c.assigned_to && c.assigned_to !== opt.by) people.add(c.assigned_to);
          for (const u of st.staff || []) if (Number(u) && Number(u) !== opt.by) people.add(Number(u));
        }
        if (people.size) {
          const ids = [...people];
          if (notice) {
            try { await notice(ids, { kind: 'memo', title: w.co.title, body: w.co.body, link: '/warranty.html#claim/' + c.id, urgent: ev === 'opened' });
              const names = (await query('SELECT string_agg(name, \', \' ORDER BY name) AS n FROM users WHERE id = ANY($1::int[])', [ids])).rows[0].n;
              await logMsg(c, ev, 'staff', 'notice', names, w.co.title, w.co.body, 'sent', null, opt.by);
            } catch (e) { await logMsg(c, ev, 'staff', 'notice', null, w.co.title, w.co.body, 'failed', e.message, opt.by); }
          } else await logMsg(c, ev, 'staff', 'notice', null, w.co.title, w.co.body, 'skipped', 'Staff notices are not available', opt.by);
        }
        const coEmail = String(st.company_email || '').trim() || (ev !== 'assigned' && shop.email) || '';
        if (coEmail && ev !== 'assigned' && coEvents.includes(ev)) {
          await sendEmail(c, ev, 'company', coEmail, w.co.title.replace(/^\S+ /, '') + ' (' + (shop.name || 'warranty') + ')', w.co.body + '\n\nOpen it: /warranty.html#claim/' + c.id, opt.by);
        }
      }
    } catch (e) { console.warn('[warranty] notify failed', claimId, ev, e.message); }
  }

  app.get(W + '/notify-settings', requireAdmin, async (req, res) => {
    try {
      const staff = (await query(`SELECT id, name, admin_role FROM users WHERE is_admin AND NOT COALESCE(disabled, false) ORDER BY name`)).rows;
      const shop = await getShop().catch(() => ({})) || {};
      res.json({ settings: await settings(), staff, shop_email: shop.email || null,
        email_ready: !!(mailer && mailer.isActive && mailer.isActive()), sms_ready: !!(sms && sms.isActive && sms.isActive()) });
    } catch (e) { fail(res, e); }
  });
  app.put(W + '/notify-settings', requireAdmin, (req, res, next) => requireManager(req, res, next), async (req, res) => {
    try {
      const b = req.body || {}, okEv = (a) => (Array.isArray(a) ? a.filter((x) => EVENTS.includes(x)) : []);
      const em = String(b.company_email || '').trim().slice(0, 300);
      if (em && !em.split(/[,;]\s*/).every((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x))) throw httpError(400, 'The company email does not look right');
      const v = { customer_email: !!b.customer_email, customer_sms: !!b.customer_sms, customer_events: okEv(b.customer_events), company_email: em,
        company_events: okEv(b.company_events), staff: (Array.isArray(b.staff) ? b.staff : []).map((x) => parseInt(x, 10)).filter(Boolean).slice(0, 50),
        default_assign_to: parseInt(b.default_assign_to, 10) || null };
      await query(`INSERT INTO warranty_settings (key, value) VALUES ('notify', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(v)]);
      res.json({ ok: true, settings: v });
    } catch (e) { fail(res, e); }
  });

  // The terms a line was sold under; an older line (before plans) borrows the
  // product's plan today, so it still gets a figure.
  async function lineTerms(line) {
    if (line.warranty_terms) return line.warranty_terms;
    const { plan, warranty_days } = await planFor(query, line.product_img);
    const days = line.warranty_until && line.sold_on ? Math.round((new Date(line.warranty_until) - new Date(line.sold_on)) / DAY) : warranty_days;
    return Object.assign(termsOf(plan, days), { borrowed: true });
  }
  const LINE_SQL = `
    SELECT psi.id AS sale_item_id, psi.sale_id, psi.product_img, psi.description, psi.qty, psi.serial_number,
           psi.unit_price_usd::float AS unit_price_usd, psi.total_usd::float AS line_total_usd,
           to_char(psi.warranty_until, 'YYYY-MM-DD') AS warranty_until, psi.warranty_terms,
           to_char(ps.created_at AT TIME ZONE 'America/Jamaica', 'YYYY-MM-DD') AS sold_on,
           ps.receipt_number, ps.customer_name, ps.customer_phone, ps.vehicle_info, ps.customer_id, cu.email AS customer_email,
           p.id AS product_id, p.name AS product_name, p.sku, p.price_usd::float AS price_now_usd, p.stock_count, p.bin_location, p.category,
           p.photo_url, p.supplier_id, s.name AS supplier_name,
           COALESCE((SELECT SUM(pri.qty)::int FROM pos_sale_return_items pri JOIN pos_sale_returns pr ON pr.id = pri.return_id WHERE pri.sale_item_id = psi.id), 0) AS returned_qty,
           (SELECT COUNT(*)::int FROM warranty_claims wc WHERE wc.sale_item_id = psi.id AND wc.status <> 'denied') AS claims
      FROM pos_sale_items psi
      JOIN pos_sales ps ON ps.id = psi.sale_id AND NOT COALESCE(ps.voided, false)
      LEFT JOIN products p ON p.img = psi.product_img
      LEFT JOIN suppliers s ON s.id = p.supplier_id
      LEFT JOIN users cu ON cu.id = ps.customer_id`;
  async function withCover(line, on) {
    const terms = await lineTerms(line);
    line.terms = terms;
    line.cover = coverage(terms, line.sold_on, line.warranty_until, on);
    if (!line.warranty_until && !terms.period_days) line.cover = { known: false, none: true, rule: 'No warranty on this part' };
    const price = terms.price_basis === 'original' ? (line.qty ? line.line_total_usd / line.qty : line.unit_price_usd) : (line.price_now_usd != null ? line.price_now_usd : line.unit_price_usd);
    line.replacement_price_usd = r2(price || 0);
    if (line.cover.known) {
      line.customer_pays_usd = r2(line.replacement_price_usd * line.cover.pays_pct / 100);
      line.covered_usd = r2(line.replacement_price_usd - line.customer_pays_usd);
    }
    if (terms.max_claims && line.claims >= terms.max_claims) line.claims_used_up = true;
    return line;
  }

  // ---------------------------------------------------------------- meta --
  app.get(W + '/meta', requireAdmin, async (req, res) => {
    try {
      const plans = (await query(`SELECT wp.*, (SELECT COUNT(*)::int FROM products p WHERE p.warranty_plan_id = wp.id) AS products,
                                         (SELECT COUNT(*)::int FROM warranty_plan_categories c WHERE c.plan_id = wp.id) AS categories
                                    FROM warranty_plans wp ORDER BY wp.active DESC, wp.is_default DESC, wp.name`)).rows;
      plans.forEach((p) => { p.rule = ruleText(termsOf(p, p.period_days)); });
      const cats = (await query(`SELECT p.category, COUNT(*)::int AS products, COUNT(*) FILTER (WHERE p.warranty_days > 0)::int AS with_days,
                                        COUNT(*) FILTER (WHERE p.warranty_plan_id IS NOT NULL)::int AS own_plan, MAX(c.plan_id) AS plan_id
                                   FROM products p LEFT JOIN warranty_plan_categories c ON c.category = p.category
                                  WHERE p.is_active GROUP BY p.category ORDER BY p.category`)).rows;
      const counts = (await query(`SELECT status, COUNT(*)::int AS n FROM warranty_claims GROUP BY status`)).rows;
      const staff = (await query(`SELECT id, name FROM users WHERE is_admin AND NOT COALESCE(disabled, false) ORDER BY name`)).rows;
      res.json({ plans, categories: cats, counts, staff, me: req.session.userId, can_resolve: await userCan(req, 'pos.refund'),
        can_rules: await canRules(req), today: today() });
    } catch (e) { fail(res, e); }
  });
  // Rules are for managers (the same bar as requireManager); asked quietly for the screen.
  const rulesGate = requireManager;
  const canRules = (req) => new Promise((resolve) => {
    const res = { status: () => res, json: () => resolve(false) };
    Promise.resolve(requireManager(req, res, () => resolve(true))).catch(() => resolve(false));
  });

  // --------------------------------------------------------------- plans --
  const PLAN_COLS = ['name', 'method', 'period_days', 'free_days', 'tiers', 'price_basis', 'remedy', 'labour_covered', 'max_claims', 'needs_photo', 'notes', 'is_default', 'active',
    'needs_id', 'needs_serial', 'needs_model', 'return_old', 'maker_warranty', 'maker_name', 'assign_to', 'needs_signature', 'agreement_text'];
  function planBody(b) {
    const name = String(b.name || '').trim().slice(0, 80);
    if (!name) throw httpError(400, 'Give the plan a name');
    const method = METHODS.includes(b.method) ? b.method : 'full';
    const tiers = cleanTiers(b.tiers);
    if (method === 'tiered' && !tiers.length) throw httpError(400, 'Add at least one step');
    const intOr = (v) => { const n = parseInt(v, 10); return n > 0 ? n : null; };
    const o = { name, method, period_days: intOr(b.period_days), free_days: Math.max(0, parseInt(b.free_days, 10) || 0), tiers: JSON.stringify(tiers),
      price_basis: b.price_basis === 'original' ? 'original' : 'current', remedy: ['replace', 'refund', 'either'].includes(b.remedy) ? b.remedy : 'replace',
      labour_covered: !!b.labour_covered, max_claims: intOr(b.max_claims), needs_photo: !!b.needs_photo, notes: b.notes ? String(b.notes).slice(0, 500) : null,
      is_default: !!b.is_default, active: b.active !== false, needs_id: !!b.needs_id, needs_serial: !!b.needs_serial, needs_model: !!b.needs_model,
      return_old: !!b.return_old, maker_warranty: !!b.maker_warranty, maker_name: b.maker_warranty && b.maker_name ? String(b.maker_name).trim().slice(0, 120) : null, assign_to: parseInt(b.assign_to, 10) || null,
      needs_signature: !!b.needs_signature, agreement_text: b.agreement_text && String(b.agreement_text).trim() ? String(b.agreement_text).trim().slice(0, 20000) : null };
    return PLAN_COLS.map((k) => o[k]);
  }
  const IS_DEFAULT = PLAN_COLS.indexOf('is_default');
  app.post(W + '/plans', requireAdmin, rulesGate, async (req, res) => {
    try {
      const v = planBody(req.body || {});
      if (v[IS_DEFAULT]) await query('UPDATE warranty_plans SET is_default = false WHERE is_default');
      const r = await one(`INSERT INTO warranty_plans (${PLAN_COLS.join(', ')}) VALUES (${PLAN_COLS.map((k, i) => '$' + (i + 1) + (k === 'tiers' ? '::jsonb' : '')).join(',')}) RETURNING id`, v);
      res.json({ ok: true, id: r.id });
    } catch (e) { fail(res, e); }
  });
  app.put(W + '/plans/:id', requireAdmin, rulesGate, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10) || 0;
      if (!(await one('SELECT id FROM warranty_plans WHERE id = $1', [id]))) throw httpError(404, 'Plan not found');
      const v = planBody(req.body || {});
      if (v[IS_DEFAULT]) await query('UPDATE warranty_plans SET is_default = false WHERE is_default AND id <> $1', [id]);
      await query(`UPDATE warranty_plans SET ${PLAN_COLS.map((k, i) => k + ' = $' + (i + 1) + (k === 'tiers' ? '::jsonb' : '')).join(', ')}, updated_at = NOW() WHERE id = $${PLAN_COLS.length + 1}`, [...v, id]);
      res.json({ ok: true, id });
    } catch (e) { fail(res, e); }
  });
  // A plan for a whole category (plan_id null takes it off).
  app.put(W + '/categories', requireAdmin, rulesGate, async (req, res) => {
    try {
      const b = req.body || {};
      const cats = (Array.isArray(b.categories) ? b.categories : [b.category]).map((c) => String(c || '').trim()).filter(Boolean);
      if (!cats.length) throw httpError(400, 'Pick a category');
      const pid = parseInt(b.plan_id, 10) || null;
      for (const c of cats) {
        if (pid) await query(`INSERT INTO warranty_plan_categories (category, plan_id) VALUES ($1,$2) ON CONFLICT (category) DO UPDATE SET plan_id = EXCLUDED.plan_id`, [c, pid]);
        else await query('DELETE FROM warranty_plan_categories WHERE category = $1', [c]);
      }
      if (b.days !== undefined && b.days !== '' && b.days !== null) {
        const d = parseInt(b.days, 10);
        await query(`UPDATE products SET warranty_days = $2, updated_at = NOW() WHERE category = ANY($1::text[])`, [cats, d > 0 ? d : null]);
      }
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.get(W + '/products', requireAdmin, async (req, res) => {
    try {
      const q = String(req.query.q || '').trim().slice(0, 60);
      const cat = String(req.query.category || '');
      const { rows } = await query(
        `SELECT p.img, p.id, p.name, p.sku, p.category, p.make_model, p.price_usd::float AS price_usd, p.stock_count, p.bin_location,
                p.warranty_days, p.warranty_plan_id, p.photo_url, c.plan_id AS category_plan_id
           FROM products p LEFT JOIN warranty_plan_categories c ON c.category = p.category
          WHERE p.is_active AND ($2 = '' OR p.category = $2)
            AND ($1 = '' OR p.name ILIKE '%' || $1 || '%' OR p.sku ILIKE $1 || '%' OR p.img ILIKE $1 || '%' OR p.barcode = $1 OR p.supplier_part_no ILIKE $1 || '%')
          ORDER BY (p.sku ILIKE $1) DESC, p.name LIMIT 200`, [q, cat]);
      res.json({ products: rows });
    } catch (e) { fail(res, e); }
  });
  // Set the plan and / or days on parts (one or many).
  app.put(W + '/products', requireAdmin, rulesGate, async (req, res) => {
    try {
      const b = req.body || {};
      const imgs = (Array.isArray(b.imgs) ? b.imgs : [b.img]).map(String).filter(Boolean).slice(0, 5000);
      if (!imgs.length) throw httpError(400, 'Pick at least one part');
      const sets = [], vals = [imgs];
      if (b.plan_id !== undefined) { vals.push(parseInt(b.plan_id, 10) || null); sets.push('warranty_plan_id = $' + vals.length); }
      if (b.days !== undefined) { const d = parseInt(b.days, 10); vals.push(d > 0 ? d : null); sets.push('warranty_days = $' + vals.length); }
      if (!sets.length) throw httpError(400, 'Nothing to change');
      const r = await query(`UPDATE products SET ${sets.join(', ')}, updated_at = NOW() WHERE img = ANY($1::text[])`, vals);
      res.json({ ok: true, updated: r.rowCount });
    } catch (e) { fail(res, e); }
  });
  // What a plan would charge at points through its period (the rules screen preview).
  app.post(W + '/preview', requireAdmin, (req, res) => {
    const b = req.body || {};
    const terms = termsOf(Object.assign({ id: null, name: '', price_basis: 'current' }, b, { tiers: cleanTiers(b.tiers) }), parseInt(b.period_days, 10) || 365);
    const s = '2026-01-01', u = ymd(new Date(new Date(s).getTime() + terms.period_days * DAY));
    const pts = [0, 10, 25, 40, 50, 60, 75, 90, 100].map((pct) => {
      const on = new Date(new Date(s).getTime() + Math.round(terms.period_days * pct / 100) * DAY);
      const c = coverage(terms, s, u, on);
      return { pct, day: c.used_days, pays_pct: c.pays_pct };
    });
    res.json({ rule: ruleText(terms), points: pts });
  });

  // ------------------------------------------------------------ register --
  app.get(W + '/register', requireAdmin, async (req, res) => {
    try {
      const filter = req.query.filter || 'active';
      const q = String(req.query.q || '').trim().slice(0, 60);
      const { rows } = await query(
        `SELECT 'line' AS kind, psi.id AS ref_id, psi.serial_number AS serial, psi.product_img, COALESCE(p.name, psi.description) AS product_name, p.sku,
                to_char(psi.warranty_until, 'YYYY-MM-DD') AS warranty_until, NULL AS unit_status, psi.sale_id, psi.warranty_terms,
                ps.receipt_number, ps.customer_name, ps.customer_phone, ps.created_at AS sold_at,
                to_char(ps.created_at AT TIME ZONE 'America/Jamaica', 'YYYY-MM-DD') AS sold_on,
                (SELECT wa.status FROM warranty_agreements wa WHERE wa.sale_item_id = psi.id AND wa.status <> 'void' ORDER BY wa.id DESC LIMIT 1) AS agreement_status
           FROM pos_sale_items psi
           JOIN pos_sales ps ON ps.id = psi.sale_id AND NOT COALESCE(ps.voided, false)
           LEFT JOIN products p ON p.img = psi.product_img
          WHERE psi.warranty_until IS NOT NULL
            AND ($1 = '' OR ps.receipt_number ILIKE '%' || $1 || '%' OR psi.serial_number ILIKE '%' || $1 || '%' OR ps.customer_name ILIKE '%' || $1 || '%'
                 OR ps.customer_phone ILIKE '%' || $1 || '%' OR psi.description ILIKE '%' || $1 || '%' OR p.sku ILIKE $1 || '%')
          ORDER BY psi.warranty_until ASC LIMIT 2000`, [q]);
      const { rows: claims } = await query(`SELECT sale_item_id FROM warranty_claims WHERE status NOT IN ('closed', 'denied') AND sale_item_id IS NOT NULL`);
      const open = new Set(claims.map((x) => x.sale_item_id));
      const t = today(), in30 = ymd(new Date(Date.now() + 30 * DAY));
      const out = [];
      for (const r of rows) {
        r.warranty_state = r.warranty_until < t ? 'expired' : r.warranty_until <= in30 ? 'expiring' : 'active';
        r.has_open_claim = open.has(r.ref_id);
        if (filter === 'claimed' ? !r.has_open_claim : ['active', 'expiring', 'expired'].includes(filter) && r.warranty_state !== filter) continue;
        const terms = r.warranty_terms || termsOf(null, null);
        r.plan_name = r.warranty_terms ? terms.name : null;
        r.cover = coverage(terms, r.sold_on, r.warranty_until, t);
        delete r.warranty_terms;
        out.push(r);
      }
      res.json({ register: out, as_of: t });
    } catch (e) { fail(res, e); }
  });

  // ---------------------------------------------------- find the sale line --
  // Receipt number, serial, phone, customer name, or part: the sold lines it
  // matches, newest first, each with what the warranty covers today.
  app.get(W + '/find', requireAdmin, async (req, res) => {
    try {
      const q = String(req.query.q || '').trim().slice(0, 80);
      if (q.length < 2) return res.json({ lines: [] });
      const digits = q.replace(/\D/g, '');
      const { rows } = await query(LINE_SQL + `
        WHERE ps.receipt_number ILIKE $1 OR ps.invoice_number ILIKE $1 OR psi.serial_number ILIKE $1
           OR ($2 <> '' AND length($2) >= 4 AND regexp_replace(COALESCE(ps.customer_phone, ''), '\\D', '', 'g') LIKE '%' || $2 || '%')
           OR ps.customer_name ILIKE '%' || $3 || '%' OR p.sku ILIKE $1 OR p.barcode = $3 OR psi.description ILIKE '%' || $3 || '%'
        ORDER BY ps.created_at DESC, psi.id LIMIT 60`, [q, digits, q]);
      const on = req.query.on || today();
      for (const l of rows) await withCover(l, on);
      res.json({ lines: rows });
    } catch (e) { fail(res, e); }
  });
  app.get(W + '/sale-items/:id', requireAdmin, async (req, res) => {
    try {
      const l = (await query(LINE_SQL + ' WHERE psi.id = $1', [parseInt(req.params.id, 10) || 0])).rows[0];
      if (!l) throw httpError(404, 'Sale line not found');
      res.json({ line: await withCover(l, req.query.on || today()) });
    } catch (e) { fail(res, e); }
  });
  // A part bought with no receipt to hand: what its plan would cover if bought on a date.
  app.get(W + '/product-cover', requireAdmin, async (req, res) => {
    try {
      const img = String(req.query.img || '');
      const p = await one(`SELECT p.img, p.id AS product_id, p.name AS product_name, p.sku, p.price_usd::float AS price_now_usd, p.stock_count, p.bin_location, p.category, p.photo_url,
                                  s.name AS supplier_name FROM products p LEFT JOIN suppliers s ON s.id = p.supplier_id WHERE p.img = $1`, [img]);
      if (!p) throw httpError(404, 'Part not found');
      const { plan, warranty_days } = await planFor(query, img);
      const terms = termsOf(plan, warranty_days || (plan && plan.period_days));
      p.terms = terms;
      p.cover = req.query.sold_on && terms.period_days ? coverage(terms, req.query.sold_on, null, req.query.on || today()) : { known: false, rule: terms.period_days ? ruleText(terms) : 'No warranty on this part' };
      p.replacement_price_usd = r2(p.price_now_usd || 0);
      if (p.cover.known) { p.customer_pays_usd = r2(p.replacement_price_usd * p.cover.pays_pct / 100); p.covered_usd = r2(p.replacement_price_usd - p.customer_pays_usd); }
      res.json({ product: p });
    } catch (e) { fail(res, e); }
  });

  // -------------------------------------------------------------- claims --
  const CLAIM_SQL = `
    SELECT wc.*, to_char(wc.sold_on, 'YYYY-MM-DD') AS sold_on, to_char(wc.warranty_until, 'YYYY-MM-DD') AS warranty_until,
           wc.replacement_price_usd::float AS replacement_price_usd, wc.customer_pays_usd::float AS customer_pays_usd, wc.covered_usd::float AS covered_usd,
           wc.pays_pct::float AS pays_pct,
           COALESCE(p.name, psi.description) AS product_name, p.sku, p.stock_count, p.bin_location, p.photo_url AS product_photo,
           ob.name AS opened_by_name, rb.name AS resolved_by_name, ps.receipt_number, asg.name AS assigned_name,
           (SELECT COUNT(*)::int FROM warranty_claim_photos ph WHERE ph.claim_id = wc.id) AS photos,
           (SELECT ph.url FROM warranty_claim_photos ph WHERE ph.claim_id = wc.id ORDER BY ph.id LIMIT 1) AS first_photo
      FROM warranty_claims wc
      LEFT JOIN products p ON p.img = wc.product_img
      LEFT JOIN pos_sale_items psi ON psi.id = wc.sale_item_id
      LEFT JOIN users ob ON ob.id = wc.opened_by
      LEFT JOIN users rb ON rb.id = wc.resolved_by
      LEFT JOIN users asg ON asg.id = wc.assigned_to
      LEFT JOIN pos_sales ps ON ps.id = wc.sale_id`;
  app.get(W + '/claims', requireAdmin, async (req, res) => {
    try {
      const status = CLAIM_STATUS.includes(req.query.status) ? req.query.status : '';
      const q = String(req.query.q || '').trim().slice(0, 60);
      const { rows } = await query(CLAIM_SQL + `
        WHERE ($1 = '' OR wc.status = $1) AND ($3::int IS NULL OR wc.assigned_to = $3)
          AND ($2 = '' OR wc.id::text = regexp_replace($2, '^WC-?0*', '', 'i') OR wc.serial ILIKE '%' || $2 || '%' OR wc.customer_name ILIKE '%' || $2 || '%'
               OR wc.customer_phone ILIKE '%' || $2 || '%' OR wc.customer_email ILIKE '%' || $2 || '%' OR wc.maker_claim_no ILIKE '%' || $2 || '%' OR ps.receipt_number ILIKE '%' || $2 || '%' OR COALESCE(p.name, psi.description) ILIKE '%' || $2 || '%' OR p.sku ILIKE $2 || '%')
        ORDER BY wc.opened_at DESC LIMIT 500`, [status, q, req.query.mine === '1' ? req.session.userId : null]);
      res.json({ claims: rows });
    } catch (e) { fail(res, e); }
  });
  app.get(W + '/claims/:id', requireAdmin, async (req, res) => {
    try {
      const c = (await query(CLAIM_SQL + ' WHERE wc.id = $1', [parseInt(req.params.id, 10) || 0])).rows[0];
      if (!c) throw httpError(404, 'Claim not found');
      c.photos = (await query(`SELECT ph.id, ph.url, ph.kind, ph.caption, ph.created_at, u.name AS by_name
                                 FROM warranty_claim_photos ph LEFT JOIN users u ON u.id = ph.uploaded_by WHERE ph.claim_id = $1 ORDER BY ph.id`, [c.id])).rows;
      c.line = c.sale_item_id ? (await query(LINE_SQL + ' WHERE psi.id = $1', [c.sale_item_id])).rows[0] || null : null;
      c.cover = c.terms ? coverage(c.terms, c.sold_on, c.warranty_until, ymd(c.opened_at)) : null;
      c.cover_today = c.terms ? coverage(c.terms, c.sold_on, c.warranty_until, today()) : null;
      if (c.replacement_img && c.replacement_img !== c.product_img) {
        c.replacement = await one('SELECT img, name, sku, price_usd::float AS price_usd, stock_count, bin_location FROM products WHERE img = $1', [c.replacement_img]);
      }
      c.other_claims = c.sale_item_id ? (await query(`SELECT id, status, opened_at FROM warranty_claims WHERE sale_item_id = $1 AND id <> $2 ORDER BY id`, [c.sale_item_id, c.id])).rows : [];
      c.agreement_signed = await agree.signedFor(query, c);
      c.agreements = (await query(`SELECT id, status, signed_name, signed_at, signed_via, file_url, created_at FROM warranty_agreements
                                    WHERE (sale_item_id IS NOT NULL AND sale_item_id = $1) OR claim_id = $2 ORDER BY (status = 'void'), id DESC`, [c.sale_item_id || null, c.id]).catch(() => ({ rows: [] }))).rows;
      c.requirements = requirements(c.terms, c, c.photos.length);
      c.assigned_name = c.assigned_to ? ((await one('SELECT name FROM users WHERE id = $1', [c.assigned_to])) || {}).name : null;
      c.messages = (await query(`SELECT m.id, m.event, m.audience, m.channel, m.sent_to, m.subject, m.body, m.outcome, m.error, m.created_at, u.name AS by_name
                                   FROM warranty_claim_messages m LEFT JOIN users u ON u.id = m.sent_by WHERE m.claim_id = $1 ORDER BY m.id DESC LIMIT 100`, [c.id])).rows;
      c.id_checked_by_name = c.id_checked_by ? ((await one('SELECT name FROM users WHERE id = $1', [c.id_checked_by])) || {}).name : null;
      c.old_returned_by_name = c.old_returned_by ? ((await one('SELECT name FROM users WHERE id = $1', [c.old_returned_by])) || {}).name : null;
      c.replacement_sale = c.replacement_sale_id ? await one('SELECT id, receipt_number, total_usd::float AS total_usd, created_at FROM pos_sales WHERE id = $1', [c.replacement_sale_id]) : null;
      res.json({ claim: c, can_resolve: await userCan(req, 'pos.refund'), id_types: ID_TYPES, dispositions: DISPOSITIONS, maker_statuses: MAKER_STATUS });
    } catch (e) { fail(res, e); }
  });

  app.post(W + '/claims', requireAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      let productImg = b.product_img ? String(b.product_img) : null;
      let serial = b.serial ? String(b.serial).trim().slice(0, 120) : null;
      let saleId = parseInt(b.sale_id, 10) || null, saleItemId = parseInt(b.sale_item_id, 10) || null;
      let customerName = b.customer_name || null, customerPhone = b.customer_phone || null, vehicle = b.vehicle || null, customerEmail = b.customer_email ? String(b.customer_email).trim().slice(0, 200) : null;
      if (customerEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(customerEmail)) throw httpError(400, 'That email address does not look right');
      // A serial alone finds the line it was sold on (newest first).
      if (serial && !saleItemId) {
        const li = await one(`SELECT id, serial_number FROM pos_sale_items WHERE lower(serial_number) = lower($1) ORDER BY id DESC LIMIT 1`, [serial]);
        if (li) { saleItemId = li.id; serial = li.serial_number; }
      }
      // A receipt number with one warranty line on it picks that line.
      if (!saleItemId && b.receipt_number) {
        const ls = (await query(`SELECT psi.id FROM pos_sale_items psi JOIN pos_sales ps ON ps.id = psi.sale_id WHERE ps.receipt_number = $1
                                 AND ($2::text IS NULL OR psi.product_img = $2) ORDER BY psi.id`, [String(b.receipt_number).trim(), productImg])).rows;
        if (ls.length === 1) saleItemId = ls[0].id;
      }
      const on = today();
      let line = null, terms = null, cover = null, soldOn = b.sold_on || null, until = null, price = null;
      if (saleItemId) {
        line = (await query(LINE_SQL + ' WHERE psi.id = $1', [saleItemId])).rows[0] || null;
        if (!line) saleItemId = null;
      }
      if (line) {
        await withCover(line, on);
        productImg = productImg || line.product_img; saleId = line.sale_id; serial = serial || line.serial_number;
        customerName = customerName || line.customer_name; customerPhone = customerPhone || line.customer_phone; vehicle = vehicle || line.vehicle_info; customerEmail = customerEmail || line.customer_email || null;
        terms = line.terms; cover = line.cover; soldOn = line.sold_on; until = line.warranty_until || (cover && cover.until); price = line.replacement_price_usd;
        if (line.claims_used_up && !truthy(b.override)) throw httpError(409, 'This item has had ' + line.claims + ' claim(s); its plan allows ' + terms.max_claims + '. Tick "claim anyway" to open it.');
      } else if (productImg) {
        const { plan, warranty_days } = await planFor(query, productImg);
        terms = termsOf(plan, warranty_days || (plan && plan.period_days));
        if (soldOn && terms.period_days) { cover = coverage(terms, soldOn, null, on); until = cover.until; }
        const p = await one('SELECT price_usd::float AS p FROM products WHERE img = $1', [productImg]);
        price = p ? p.p : null;
      }
      if (!productImg && !serial && !saleItemId) throw httpError(400, 'Find the sale, or pick the part, to open a claim against');
      const qty = Math.max(1, parseInt(b.qty, 10) || 1);
      const pays = cover && cover.known ? cover.pays_pct : null;
      const rp = price != null ? r2(price * qty) : null;
      const cp = rp != null && pays != null ? r2(rp * pays / 100) : null;
      const prod = productImg ? await one('SELECT id FROM products WHERE img = $1', [productImg]) : null;
      const idNo = b.id_number ? String(b.id_number).trim().slice(0, 60) : null;
      const { rows } = await query(
        `INSERT INTO warranty_claims (product_img, product_id, serial, sale_id, sale_item_id, customer_name, customer_phone, vehicle, fault, opened_by,
                                      qty, sold_on, warranty_until, plan_id, terms, used_days, period_days, pays_pct, replacement_img, replacement_price_usd, customer_pays_usd, covered_usd)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18,$1,$19,$20,$21) RETURNING id`,
        [productImg, prod ? prod.id : null, serial, saleId, saleItemId, customerName, customerPhone, vehicle ? String(vehicle).slice(0, 200) : null,
          b.fault ? String(b.fault).slice(0, 1000) : null, req.session.userId, qty, soldOn || null, until || null,
          terms ? terms.plan_id : null, terms ? JSON.stringify(terms) : null, cover && cover.known ? cover.used_days : null, cover && cover.known ? cover.period_days : null,
          pays, rp, cp, rp != null && cp != null ? r2(rp - cp) : null]);
      await query(`UPDATE warranty_claims SET customer_email = $2, id_type = $3, id_number = $4, id_checked_by = CASE WHEN $4::text IS NULL THEN NULL ELSE $5::int END,
                     id_checked_at = CASE WHEN $4::text IS NULL THEN NULL ELSE NOW() END, model_number = $6, maker_name = $7, maker_status = $8 WHERE id = $1`,
        [rows[0].id, customerEmail, idNo ? (ID_TYPES.includes(b.id_type) ? b.id_type : 'Other') : null, idNo, req.session.userId,
          b.model_number ? String(b.model_number).trim().slice(0, 80) : null, terms && terms.maker_warranty ? terms.maker_name || null : null,
          terms && terms.maker_warranty ? 'to_send' : null]);
      const c2 = await one('SELECT * FROM warranty_claims WHERE id = $1', [rows[0].id]);
      // Assigned to: who the person opening it picked, else the plan's person, else the default.
      const st = await settings();
      const assignee = parseInt(b.assigned_to, 10) || (terms && terms.assign_to) || st.default_assign_to || null;
      if (assignee) await query('UPDATE warranty_claims SET assigned_to = $2 WHERE id = $1', [rows[0].id, assignee]);
      await notify(rows[0].id, 'opened', { by: req.session.userId, tellCustomer: b.tell_customer !== false });
      res.json({ ok: true, id: rows[0].id, cover, needs_photo: !!(terms && terms.needs_photo), requirements: requirements(terms, c2, 0) });
    } catch (e) { fail(res, e); }
  });

  app.patch(W + '/claims/:id', requireAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      const claim = await one('SELECT * FROM warranty_claims WHERE id = $1', [parseInt(req.params.id, 10) || 0]);
      if (!claim) throw httpError(404, 'Not found');
      const resolving = b.status !== undefined && b.status !== claim.status && b.status !== 'open';
      const money = b.replacement_img !== undefined || b.customer_pays_usd !== undefined || b.replacement_price_usd !== undefined || b.qty !== undefined;
      if ((resolving || money || b.replacement_sale_id !== undefined) && !(await userCan(req, 'pos.refund'))) throw httpError(403, 'Not allowed to resolve a warranty claim.');
      const sets = [], vals = [];
      const set = (col, v) => { vals.push(v); sets.push(col + ' = $' + vals.length); };
      if (b.status !== undefined) {
        if (!CLAIM_STATUS.includes(b.status)) throw httpError(400, 'Bad status');
        if (b.status === 'denied' && !String(b.resolution_note || claim.resolution_note || '').trim()) throw httpError(400, 'Say why the claim is turned down');
        set('status', b.status);
      }
      if (b.resolution_note !== undefined) set('resolution_note', b.resolution_note ? String(b.resolution_note).slice(0, 1000) : null);
      if (b.return_id !== undefined) set('return_id', parseInt(b.return_id, 10) || null);
      if (b.replacement_sale_id !== undefined || b.replacement_receipt !== undefined) {
        let sid = parseInt(b.replacement_sale_id, 10) || null;
        if (!sid && b.replacement_receipt) {
          const s = await one('SELECT id FROM pos_sales WHERE receipt_number = $1', [String(b.replacement_receipt).trim()]);
          if (!s) throw httpError(400, 'No sale with receipt ' + b.replacement_receipt);
          sid = s.id;
        }
        set('replacement_sale_id', sid);
      }
      for (const k of ['fault', 'customer_name', 'customer_phone', 'vehicle', 'serial', 'model_number', 'maker_name', 'maker_claim_no', 'maker_note']) if (b[k] !== undefined) set(k, b[k] ? String(b[k]).trim().slice(0, 1000) : null);
      if (b.customer_email !== undefined) {
        const em = b.customer_email ? String(b.customer_email).trim().slice(0, 200) : null;
        if (em && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) throw httpError(400, 'That email address does not look right');
        set('customer_email', em);
      }
      if (b.id_number !== undefined) {
        const idNo = b.id_number ? String(b.id_number).trim().slice(0, 60) : null;
        set('id_number', idNo); set('id_type', idNo ? (ID_TYPES.includes(b.id_type) ? b.id_type : 'Other') : null);
        set('id_checked_by', idNo ? req.session.userId : null); sets.push(idNo ? 'id_checked_at = NOW()' : 'id_checked_at = NULL');
      }
      if (b.assigned_to !== undefined) set('assigned_to', parseInt(b.assigned_to, 10) || null);
      if (b.maker_status !== undefined) {
        if (b.maker_status && !MAKER_STATUS.includes(b.maker_status)) throw httpError(400, 'Bad maker status');
        set('maker_status', b.maker_status || null);
      }
      if (b.old_returned !== undefined) {
        const on = truthy(b.old_returned);
        set('old_returned', on); set('old_returned_by', on ? req.session.userId : null); sets.push(on ? 'old_returned_at = NOW()' : 'old_returned_at = NULL');
      }
      if (b.old_disposition !== undefined) {
        if (b.old_disposition && !DISPOSITIONS.includes(b.old_disposition)) throw httpError(400, 'Bad choice for the old part');
        set('old_disposition', b.old_disposition || null);
      }
      // Money: a different replacement part, qty, or a figure the manager types in.
      if (money) {
        const qty = b.qty !== undefined ? Math.max(1, parseInt(b.qty, 10) || 1) : claim.qty || 1;
        const img = b.replacement_img !== undefined ? (b.replacement_img || claim.product_img) : (claim.replacement_img || claim.product_img);
        let price = b.replacement_price_usd !== undefined && b.replacement_price_usd !== '' && b.replacement_price_usd !== null ? Number(b.replacement_price_usd) : null;
        if (price == null) {
          const terms = claim.terms || {};
          if (img === claim.product_img && terms.price_basis === 'original' && claim.sale_item_id) {
            const l = await one('SELECT total_usd::float / NULLIF(qty, 0) AS u FROM pos_sale_items WHERE id = $1', [claim.sale_item_id]);
            price = l && l.u != null ? r2(l.u * qty) : null;
          } else {
            const p = await one('SELECT price_usd::float AS p FROM products WHERE img = $1', [img]);
            price = p && p.p != null ? r2(p.p * qty) : null;
          }
        }
        const pays = claim.pays_pct != null ? Number(claim.pays_pct) : 0;
        let cpays = b.customer_pays_usd !== undefined && b.customer_pays_usd !== '' && b.customer_pays_usd !== null ? r2(b.customer_pays_usd) : (price != null ? r2(price * pays / 100) : null);
        if (price != null && cpays != null) cpays = Math.max(0, Math.min(price, cpays));
        set('qty', qty); set('replacement_img', img); set('replacement_price_usd', price); set('customer_pays_usd', cpays);
        set('covered_usd', price != null && cpays != null ? r2(price - cpays) : null);
      }
      // The plan's checks (ID, serial, model, photo, old part back) must all be done first;
      // values sent in this same request count.
      if (resolving && ['replace', 'refund', 'repair'].includes(b.status) && claim.terms) {
        const n = await one('SELECT COUNT(*)::int AS n FROM warranty_claim_photos WHERE claim_id = $1', [claim.id]);
        const merged = Object.assign({}, claim);
        for (const k of ['serial', 'model_number', 'id_number']) if (b[k] !== undefined) merged[k] = b[k];
        if (b.old_returned !== undefined) merged.old_returned = truthy(b.old_returned);
        merged.agreement_signed = await agree.signedFor(query, claim);
        const missing = requirements(claim.terms, merged, n.n).filter((x) => !x.met).map((x) => x.label);
        if (missing.length) throw httpError(400, 'This warranty plan needs ' + missing.join(', ') + ' before the claim is settled.');
      }
      if (resolving && b.status !== 'open') { set('resolved_by', req.session.userId); sets.push('resolved_at = NOW()'); }
      if (b.status === 'open') sets.push('resolved_by = NULL', 'resolved_at = NULL');
      if (!sets.length) throw httpError(400, 'Nothing to update');
      sets.push('updated_at = NOW()');
      vals.push(claim.id);
      await query(`UPDATE warranty_claims SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
      const by = req.session.userId;
      if (b.assigned_to !== undefined && (parseInt(b.assigned_to, 10) || null) !== claim.assigned_to && parseInt(b.assigned_to, 10)) await notify(claim.id, 'assigned', { by });
      if (b.status !== undefined && b.status !== claim.status && b.status !== 'open') await notify(claim.id, b.status, { by, tellCustomer: b.tell_customer !== false });
      if (b.maker_status !== undefined && (b.maker_status || null) !== claim.maker_status && b.maker_status) {
        const ML = { to_send: 'to send to the maker', sent: 'sent to the maker', approved: 'the maker approved it', rejected: 'the maker turned it down', credited: 'the maker credited us' };
        await notify(claim.id, 'maker', { by, extra: { makerLabel: ML[b.maker_status] } });
      }
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // A message to the customer from the claim (email and / or SMS).
  app.post(W + '/claims/:id/message', requireAdmin, async (req, res) => {
    try {
      const c = await one('SELECT id, customer_email, customer_phone FROM warranty_claims WHERE id = $1', [parseInt(req.params.id, 10) || 0]);
      if (!c) throw httpError(404, 'Claim not found');
      const b = req.body || {}, text = String(b.text || '').trim().slice(0, 1500);
      if (!text) throw httpError(400, 'Write the message');
      const ch = (Array.isArray(b.channels) ? b.channels : ['email']).filter((x) => x === 'email' || x === 'sms');
      if (!ch.length) throw httpError(400, 'Pick email or SMS');
      if (ch.includes('email') && !c.customer_email && !(ch.includes('sms') && c.customer_phone)) throw httpError(400, 'This claim has no customer email. Add one first.');
      if (ch.includes('sms') && !c.customer_phone && !(ch.includes('email') && c.customer_email)) throw httpError(400, 'This claim has no customer phone.');
      const before = (await one('SELECT COALESCE(MAX(id), 0) AS m FROM warranty_claim_messages WHERE claim_id = $1', [c.id])).m;
      await notify(c.id, 'message', { by: req.session.userId, only: 'customer', channels: ch, extra: { subject: b.subject ? String(b.subject).slice(0, 150) : null, text } });
      const log = (await query('SELECT channel, outcome, error FROM warranty_claim_messages WHERE claim_id = $1 AND id > $2 ORDER BY id', [c.id, before])).rows;
      res.json({ ok: true, results: log });
    } catch (e) { fail(res, e); }
  });

  // -------------------------------------------------------------- photos --
  // Up to 12 at a time (camera, scanner or files); kept as
  // uploads/warranty/WC<claim>-<n>.<ext>.
  app.post(W + '/claims/:id/photos', requireAdmin, photoUpload, async (req, res) => {
    const files = req.files || (req.file ? [req.file] : []);
    try {
      const claim = await one('SELECT id FROM warranty_claims WHERE id = $1', [parseInt(req.params.id, 10) || 0]);
      if (!claim) throw httpError(404, 'Claim not found');
      if (!files.length) throw httpError(400, 'No picture came through. Pictures only (JPG, PNG, HEIC), up to 8 MB each.');
      const kind = PHOTO_KINDS.includes(req.body && req.body.kind) ? req.body.kind : 'photo';
      const caption = req.body && req.body.caption ? String(req.body.caption).slice(0, 200) : null;
      const dir = path.join(UP, 'warranty');
      fs.mkdirSync(dir, { recursive: true });
      const n0 = (await one('SELECT COUNT(*)::int AS n FROM warranty_claim_photos WHERE claim_id = $1', [claim.id])).n;
      const added = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const ext = (path.extname(f.originalname || f.filename || '').toLowerCase() || '.jpg').replace(/[^.a-z0-9]/g, '').slice(0, 6) || '.jpg';
        let name = 'WC' + String(claim.id).padStart(5, '0') + '-' + (n0 + i + 1) + ext, k = 1;
        while (fs.existsSync(path.join(dir, name))) name = 'WC' + String(claim.id).padStart(5, '0') + '-' + (n0 + i + 1) + '-' + (++k) + ext;
        let url = '/uploads/' + f.filename;
        try { fs.renameSync(f.path, path.join(dir, name)); url = '/uploads/warranty/' + name; } catch (_) { /* keep where multer put it */ }
        const r = await one(`INSERT INTO warranty_claim_photos (claim_id, url, kind, caption, uploaded_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, url, kind`,
          [claim.id, url, kind, caption, req.session.userId]);
        added.push(r);
      }
      await query('UPDATE warranty_claims SET updated_at = NOW() WHERE id = $1', [claim.id]);
      res.json({ ok: true, photos: added });
    } catch (e) {
      for (const f of files) { try { fs.unlinkSync(f.path); } catch (_) {} }
      fail(res, e);
    }
  });
  app.delete(W + '/claims/:id/photos/:pid', requireAdmin, async (req, res) => {
    try {
      const ph = await one('SELECT * FROM warranty_claim_photos WHERE id = $1 AND claim_id = $2', [parseInt(req.params.pid, 10) || 0, parseInt(req.params.id, 10) || 0]);
      if (!ph) throw httpError(404, 'Photo not found');
      if (ph.uploaded_by !== req.session.userId && !(await userCan(req, 'pos.refund'))) throw httpError(403, 'Only the person who added it, or a manager, can remove a photo.');
      await query('DELETE FROM warranty_claim_photos WHERE id = $1', [ph.id]);
      // The file stays on disk (kept with the claim's evidence); only the link goes.
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // WARRANTY-AGREE: the warranty agreement, e-signing and signed copies (warranty-agree.js).
  agree.register(app, { query, requireAdmin, requireManager, userCan, mailer, notice, getShop, ensure, lineTerms, ruleText });
}
const truthy = (v) => v === true || v === 'true' || v === '1' || v === 1;

module.exports = { register, stampLine, coverage, ruleText, termsOf, cleanTiers, requirements, DDL };
