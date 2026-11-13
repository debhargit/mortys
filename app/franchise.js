// =============================================================================
//  Vision Auto Solutions -- Franchise (the franchise system, end to end)
//
//  Mounted by server.js:  require('./franchise').register(app, deps)
//  Screens: franchise.html (staff, cap franchise.manage) and franchisee.html
//  (no sign-in: the enquiry form, signing from a link, and each franchisee's
//  own page for monthly sales reports, statement and the manual).
//  Tables in schema.sql ("FRANCHISE"); templates in franchise-templates.js.
//
//  The life of a franchise, as industry practice runs it:
//    enquiry -> qualified (capital, net worth, experience, territory, interview)
//    -> NDA signed (before anything confidential is shown) -> disclosure
//    document received and signed for -> application -> approved -> franchisee
//    record with an opening checklist -> franchise agreement signed (no sooner
//    than the waiting period, 14 days by default, after the disclosure
//    document was received) -> open -> monthly sales report -> royalty,
//    brand-fund and technology invoices (A/R invoices, so they show in
//    Receivables and post to the ledger) -> field audits -> renewal,
//    transfer, notice of default, suspension or termination.
//
//  Documents: each franchise document is made from its template in the
//  Document centre (editable there), filled from the records, and sent for
//  signing. The signature works like signed invoices (invoice-docs.js): a
//  drawn signature, a SHA-256 of the page signed, and an HMAC seal
//  (SESSION_SECRET) over the hash, the signer, the time, the picture and where
//  it came from. The signed copy is filed in the Document centre. Until a
//  manager records that a Jamaican attorney has reviewed a template, every
//  copy made from it keeps the "starting point only" notice.
// =============================================================================
'use strict';
const crypto = require('crypto');
const { TEMPLATES, ONBOARDING, PHASES, AUDIT_ITEMS, SYSTEMS, STORE_TYPES } = require('./franchise-templates');

const STAGES = ['enquiry', 'qualified', 'nda', 'disclosed', 'application', 'approved', 'agreement', 'signed'];
const STAGE_LABEL = { enquiry: 'Enquiry', qualified: 'Qualified', nda: 'NDA signed', disclosed: 'Disclosure received', application: 'Applied', approved: 'Approved',
  agreement: 'Agreement stage', signed: 'Agreement signed', declined: 'Declined', withdrawn: 'Withdrawn' };
const FR_STATUSES = ['onboarding', 'open', 'suspended', 'terminated', 'expired', 'transferred'];
// Documents both sides sign; the rest are signed by the franchisee alone.
const COUNTER = new Set(['nda', 'agreement', 'renewal', 'transfer', 'affiliate', 'supply', 'hub_service']);
// A month counts as invoiced once any of its monthly fees is (affiliates pay a membership fee, not a royalty).
const MONTHLY = "('royalty', 'member', 'marketing', 'tech')";
const ONE_OFF = ['initial', 'renewal', 'transfer', 'training', 'audit', 'late', 'other'];
const CHARGE_LABEL = { initial: 'Initial franchise fee', royalty: 'Royalty', marketing: 'Brand marketing fund', tech: 'Technology fee', renewal: 'Renewal fee',
  transfer: 'Transfer fee', training: 'Extra training', audit: 'Re-audit fee', late: 'Late payment fee', other: 'Other charge' };
const ACTION_KINDS = ['renewal', 'transfer', 'default', 'suspension', 'termination'];
const AUDIT_KINDS = ['pre_opening', 'routine', 'mystery_shop', 'follow_up'];
const EXIT_TASKS = [
  'Stop using the Vision Auto Solutions name, logo and system',
  'Final statement sent and all money owed paid',
  'Operations manual and confidential material returned',
  'Signs removed and shop look changed',
  'Shop phone numbers, website and social media handed over',
  'Till logins switched off',
  'Option to buy stock and equipment decided (within 30 days)',
];
// Placeholders a manager sets under Settings; each franchisee can differ.
const DEFAULTS = {
  initial_fee: 2500000, royalty_pct: 6, marketing_pct: 2, tech_fee: 25000, min_royalty: 50000, renewal_fee: 500000, transfer_fee: 750000,
  term_years: 10, gct_rate: 15, wait_days: 14, report_day: 5, royalty_due_day: 10, local_marketing_pct: 1, opening_months: 9,
  min_capital: 8000000, min_net_worth: 20000000, renewal_notice_months: 12, pass_pct: 85, conditional_pct: 70, qualify_score: 60, link_days: 14,
  // The store network (franchise-network.js).
  member_fee: 40000, affiliate_marketing_pct: 1, commit_pct: 80, coop_pct: 1, coop_claim_pct: 50, loyalty_points_per_100: 1, loyalty_point_value: 1,
  hot_shot_minutes: 120, delivery_promise_minutes: 45, spend_per_vehicle: 60000, spend_per_garage: 2400000,
  target_commercial_pct: 40, target_fill_rate: 95, target_turns: 4, max_shrink_pct: 1, target_margin_pct: 38, target_cert_pct: 100,
};

function register(app, deps) {
  const { query, getPool, requireAdmin, requireCap, mailer, docs, devMode, nextAccountNumber } = deps;
  const M = [requireAdmin, requireCap('franchise.manage')];
  const me = (req) => (req && req.session ? req.session.userId : null) || null;
  function httpError(status, msg) { const e = new Error(msg); e.status = status; return e; }
  const fail = (res, e) => { if (!e.status) console.error('[franchise]', e); res.status(e.status || 500).json({ error: e.status ? e.message : 'Server error' }); };
  const t = (v, m) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, m || 500));
  const d = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !isNaN(Date.parse(v)) ? String(v) : null);
  const n = (v) => { const x = parseInt(v, 10); return Number.isFinite(x) && x > 0 ? x : null; };
  const r2 = (v) => Math.round(Number(v || 0) * 100) / 100;
  const amt = (v) => { if (v == null || v === '') return null; const x = Number(String(v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(x) && x >= 0 ? r2(x) : null; };
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (v) => 'J$' + r2(v).toLocaleString('en-JM', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const today = () => new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10);   // Jamaica (no daylight saving)
  const longDate = (s) => new Date((s || today()) + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const addMonths = (s, k) => { const x = new Date(s + 'T12:00:00Z'); x.setUTCMonth(x.getUTCMonth() + k); return x.toISOString().slice(0, 10); };
  const addDays = (s, k) => new Date(Date.parse(s + 'T12:00:00Z') + k * 86400000).toISOString().slice(0, 10);
  const monthOf = (v) => { const m = /^(\d{4})-(\d{2})/.exec(String(v || '')); return m && +m[2] >= 1 && +m[2] <= 12 ? m[1] + '-' + m[2] + '-01' : null; };
  const monthName = (p) => new Date(p + 'T12:00:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const DATE = (c) => `to_char(${c}, 'YYYY-MM-DD')`;
  const ipOf = (req) => String(req.ip || '').replace(/^::ffff:/, '').slice(0, 64);
  const TILL = (process.env.TILL_PUBLIC_URL || 'https://till.visionautosolutions.com').replace(/\/$/, '');
  // As for signed invoices: no published fallback key outside development.
  const SECRET = process.env.SESSION_SECRET || (devMode ? 'vision-dev-secret' : null);
  const TPL = Object.fromEntries(TEMPLATES.map((x) => [x.key, x]));

  async function log(f, req) {
    await query(`INSERT INTO fr_log (lead_id, franchisee_id, action, detail, by_user) VALUES ($1,$2,$3,$4,$5)`,
      [f.lead_id || null, f.franchisee_id || null, f.action, f.detail || null, me(req)]).catch((e) => console.error('[franchise] log', e.message));
  }

  // ------------------------------------------------------------- settings --
  async function settings() {
    const { rows } = await query(`SELECT key, value FROM fr_settings`);
    const s = Object.assign({}, DEFAULTS);
    for (const r of rows) if (r.key in DEFAULTS && r.value != null && r.value !== '' && Number.isFinite(Number(r.value))) s[r.key] = Number(r.value);
    return s;
  }
  async function companyInfo() {
    const { rows } = await query(`SELECT key, value FROM warehouse_settings WHERE key IN ('company_name', 'shop_name', 'company_phone', 'company_address')`).catch(() => ({ rows: [] }));
    const s = {}; rows.forEach((r) => { s[r.key] = r.value; });
    return { company: s.company_name || s.shop_name || 'Vision Auto Solutions Ltd', company_phone: s.company_phone || '876-728-4735', company_address: s.company_address || '112C Waltham Park Road, Kingston' };
  }

  // ------------------------------------------------------------ templates --
  // Added to the Document centre once it has its own starter templates (it
  // only adds those while it has none, so going first would stop them).
  let tplReady = false, tplRun = null;
  const ensureTemplates = () => (tplReady ? Promise.resolve() : (tplRun || (tplRun = (async () => {
    try {
      const { rows: c } = await query(`SELECT COUNT(*)::int AS c FROM documents WHERE category = 'template' AND NOT ('franchise' = ANY(tags))`);
      if (!c[0].c || !docs || !docs.createDoc) return;
      const { rows: have } = await query(`SELECT key FROM fr_templates`);
      const got = new Set(have.map((r) => r.key));
      for (const tp of TEMPLATES) {
        if (got.has(tp.key)) continue;
        const doc = await docs.createDoc(null, { title: tp.title, category: 'template', template_body: tp.body, template_fields: tp.fields, needs_approval: false,
          text_content: tp.body.replace(/<[^>]+>/g, ' '), source: 'import', uploaded_by: null, tags: 'franchise',
          description: 'Franchise template (franchise module). A starting point from common franchise practice: have a Jamaican attorney review it before use, then record the review under Franchise > Templates.' });
        await query(`INSERT INTO fr_templates (key, document_id) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`, [tp.key, doc.id]);
      }
      tplReady = true;
    } catch (e) { console.warn('[franchise] templates', e.message); } finally { tplRun = null; }
  })())));
  async function templateOf(key) {
    const tp = TPL[key];
    if (!tp) throw httpError(400, 'Unknown franchise document');
    await ensureTemplates();
    const { rows } = await query(`SELECT f.document_id, f.reviewed_at, f.reviewer, d.template_body, d.template_fields, d.deleted_at, d.number
      FROM fr_templates f LEFT JOIN documents d ON d.id = f.document_id WHERE f.key = $1`, [key]);
    const r = rows[0] || {};
    const live = r.document_id && !r.deleted_at && r.template_body;
    return { tp, body: live ? r.template_body : tp.body, fields: (live && Array.isArray(r.template_fields) && r.template_fields.length ? r.template_fields : tp.fields),
      document_id: live ? r.document_id : null, reviewed: !!r.reviewed_at };
  }

  // ------------------------------------------------------------- records --
  async function leadRow(id) {
    const { rows } = await query(`SELECT l.*, ${DATE('l.created_at')} AS created_day, t.name AS territory_name, t.description AS territory_desc, t.status AS territory_status,
        COALESCE(NULLIF(o.name, ''), o.email) AS owner_name
      FROM fr_leads l LEFT JOIN fr_territories t ON t.id = l.territory_id LEFT JOIN users o ON o.id = l.owner_id WHERE l.id = $1`, [n(id)]);
    if (!rows.length) throw httpError(404, 'Lead not found');
    return rows[0];
  }
  async function frRow(id) {
    const { rows } = await query(`SELECT f.*, ${DATE('f.signed_on')} AS signed_on, ${DATE('f.opened_on')} AS opened_on, ${DATE('f.term_start')} AS term_start,
        ${DATE('f.term_end')} AS term_end, ${DATE('f.ended_on')} AS ended_on, t.name AS territory_name, t.code AS territory_code, t.description AS territory_desc,
        COALESCE(NULLIF(u.name, ''), u.email) AS customer_name, u.account_number, dc.name AS dc_name, dc.code AS dc_code, COALESCE(h.trading_name, h.legal_name) AS hub_name, fm.name AS format_name
      FROM fr_franchisees f LEFT JOIN fr_territories t ON t.id = f.territory_id LEFT JOIN users u ON u.id = f.customer_id
        LEFT JOIN fr_dcs dc ON dc.id = f.dc_id LEFT JOIN fr_franchisees h ON h.id = f.hub_id LEFT JOIN fr_formats fm ON fm.key = f.format_key WHERE f.id = $1`, [n(id)]);
    if (!rows.length) throw httpError(404, 'Franchisee not found');
    const f = rows[0];
    delete f.portal_token_sha256;
    return f;
  }
  // A franchisee's own terms, falling back to the current defaults.
  function terms(f, s) {
    const pick = (k) => (f && f[k] != null ? Number(f[k]) : s[k]);
    return { initial_fee: pick('initial_fee'), royalty_pct: pick('royalty_pct'), marketing_pct: pick('marketing_pct'), tech_fee: pick('tech_fee'),
      min_royalty: pick('min_royalty'), renewal_fee: pick('renewal_fee'), transfer_fee: pick('transfer_fee'), term_years: f && f.term_years ? Number(f.term_years) : s.term_years,
      member_fee: pick('member_fee'), commit_pct: pick('commit_pct'), coop_pct: pick('coop_pct'), store_type: (f && f.store_type) || 'franchise' };
  }
  function advance(stage, to) {
    if (stage === 'declined' || stage === 'withdrawn') return stage;
    return STAGES.indexOf(to) > STAGES.indexOf(stage) ? to : stage;
  }
  async function setStage(leadId, to, extra, req) {
    const l = await leadRow(leadId);
    const next = advance(l.stage, to);
    await query(`UPDATE fr_leads SET stage = $2, updated_at = NOW() WHERE id = $1`, [l.id, next]);
    if (next !== l.stage) await log({ lead_id: l.id, action: 'stage', detail: STAGE_LABEL[l.stage] + ' → ' + STAGE_LABEL[next] + (extra ? ' (' + extra + ')' : '') }, req);
    return next;
  }
  // Their account in Receivables: an existing customer with the same email, or a new one.
  async function ensureCustomer(f, q = query) {
    if (f.customer_id) return f.customer_id;
    let id = null;
    const email = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(String(f.email || '')) ? String(f.email).toLowerCase() : null;
    if (email) {
      const { rows } = await q(`SELECT id, COALESCE(is_staff, false) AS staff FROM users WHERE lower(email) = $1`, [email]);
      if (rows[0] && !rows[0].staff) id = rows[0].id;
    }
    if (!id) {
      const acct = nextAccountNumber ? await nextAccountNumber() : null;
      const useEmail = email && !(await q(`SELECT 1 FROM users WHERE lower(email) = $1`, [email])).rows.length ? email : ((acct || 'fr-' + f.id) + '@franchise.visionautosolutions.local').toLowerCase();
      const { rows } = await q(`INSERT INTO users (email, name, phone, company_name, account_number, via) VALUES ($1,$2,$3,$4,$5,'franchise') RETURNING id`,
        [useEmail, f.principal || f.legal_name, f.phone || null, f.legal_name, acct]);
      id = rows[0].id;
    }
    await q(`UPDATE fr_franchisees SET customer_id = $2 WHERE id = $1`, [f.id, id]);
    return id;
  }
  async function addTasks(frId, list, base, q = query) {
    const { rows } = await q(`SELECT COALESCE(MAX(sort), 0)::int AS s FROM fr_tasks WHERE franchisee_id = $1`, [frId]);
    let i = rows[0].s;
    for (const [phase, title, days] of list) await q(`INSERT INTO fr_tasks (franchisee_id, phase, title, due_on, sort) VALUES ($1,$2,$3,$4,$5)`, [frId, phase, title, days == null ? null : addDays(base, days), (i += 10)]);
  }
  function frInput(b, s, partial) {
    const out = {};
    const txt = { legal_name: 200, trading_name: 200, principal: 200, email: 200, phone: 60, address: 500, trn: 30, notes: 4000 };
    for (const k of Object.keys(txt)) if (!partial || k in b) out[k] = t(b[k], txt[k]);
    if (!partial || 'territory_id' in b) out.territory_id = n(b.territory_id);
    if (!partial || 'store_type' in b) out.store_type = STORE_TYPES[b.store_type] ? b.store_type : 'franchise';
    if (!partial || 'network_role' in b) out.network_role = ['hub', 'spoke', 'standalone'].includes(b.network_role) ? b.network_role : 'standalone';
    if (!partial || 'format_key' in b) out.format_key = t(b.format_key, 40);
    for (const k of ['dc_id', 'hub_id', 'sq_ft']) if (!partial || k in b) out[k] = n(b[k]);
    if (!partial || 'member_fee' in b) out.member_fee = b.member_fee == null || b.member_fee === '' ? null : amt(b.member_fee);
    for (const k of ['commit_pct', 'coop_pct']) if (!partial || k in b) {
      const v = b[k] == null || b[k] === '' ? null : Number(b[k]);
      if (v != null && !(v >= 0 && v <= 100)) throw httpError(400, 'Percentages must be 0 to 100');
      out[k] = v;
    }
    if (out.network_role && out.network_role !== 'spoke') out.hub_id = null;
    for (const k of ['initial_fee', 'tech_fee', 'min_royalty', 'renewal_fee', 'transfer_fee']) if (!partial || k in b) out[k] = b[k] == null || b[k] === '' ? (partial ? null : s[k]) : amt(b[k]);
    for (const k of ['royalty_pct', 'marketing_pct']) if (!partial || k in b) {
      // A new affiliate pays the network marketing rate, not the franchise brand fund.
      const def = k === 'marketing_pct' && out.store_type === 'affiliate' ? s.affiliate_marketing_pct : s[k];
      const v = b[k] == null || b[k] === '' ? (partial ? null : def) : Number(b[k]);
      if (v != null && !(v >= 0 && v <= 30)) throw httpError(400, 'Percentages must be 0 to 30');
      out[k] = v;
    }
    if (!partial || 'term_years' in b) { const y = b.term_years == null || b.term_years === '' ? s.term_years : parseInt(b.term_years, 10); if (!(y >= 1 && y <= 30)) throw httpError(400, 'Term: 1 to 30 years'); out.term_years = y; }
    if ('email' in out && out.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(out.email)) throw httpError(400, 'That email address does not look right');
    if (!partial && !out.legal_name) throw httpError(400, 'The franchisee\'s legal name (the company or person signing)');
    return out;
  }
  // Affiliates already trade (no site, fit-out or opening); only franchisees pay an initial fee.
  function onboardingFor(type, role) {
    return ONBOARDING.filter((o) => {
      if (type !== 'franchise' && /Initial franchise fee/.test(o[1])) return false;
      if (type === 'affiliate' && (['site'].includes(o[0]) || /layout|permits|Fit-out finished|Opening stock|Grand-opening|Soft opening|Opening day|Company registered/.test(o[1]))) return false;
      return true;
    }).map((o) => (role !== 'spoke' && /hub store assigned/.test(o[1]) ? [o[0], o[1].replace('; hub store assigned (spoke stores)', ''), o[2]] : o));
  }
  async function createFranchisee(req, b, leadId) {
    const s = await settings();
    const f = frInput(b, s, false);
    const pool = getPool(); const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const cols = Object.keys(f);
      const { rows } = await c.query(`INSERT INTO fr_franchisees (${cols.join(', ')}, lead_id, status, created_by) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(', ')}, $${cols.length + 1}, 'onboarding', $${cols.length + 2}) RETURNING id`,
        cols.map((k) => f[k]).concat([leadId || null, me(req)]));
      const id = rows[0].id;
      await c.query(`UPDATE fr_franchisees SET number = 'FR-' || lpad(id::text, 3, '0') WHERE id = $1`, [id]);
      if (f.store_type !== 'company') await ensureCustomer(Object.assign({ id }, f), (sql, a) => c.query(sql, a));
      await addTasks(id, onboardingFor(f.store_type, f.network_role), today(), (sql, a) => c.query(sql, a));
      if (f.territory_id) await c.query(`UPDATE fr_territories SET status = 'reserved' WHERE id = $1 AND status = 'open'`, [f.territory_id]);
      if (leadId) await c.query(`UPDATE fr_leads SET franchisee_id = $2, updated_at = NOW() WHERE id = $1`, [leadId, id]);
      await c.query('COMMIT');
      await log({ franchisee_id: id, lead_id: leadId, action: 'franchisee created', detail: f.legal_name }, req);
      return id;
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  }

  // ------------------------------------------------------------ documents --
  async function autoValues(lead, f) {
    const s = await settings();
    const tr = terms(f, s);
    const ci = await companyInfo();
    const territory = f ? f.territory_name : lead && lead.territory_name;
    const tdesc = f ? f.territory_desc : lead && lead.territory_desc;
    const start = (f && (f.term_start || f.signed_on)) || today();
    const tid = (f && f.territory_id) || (lead && lead.territory_id);
    const [{ rows: rebates }, { rows: tr2 }] = await Promise.all([query(`SELECT min_quarter::float AS min_quarter, rebate_pct FROM fr_rebate_tiers ORDER BY min_quarter`).catch(() => ({ rows: [] })),
      tid ? query(`SELECT t.population, t.vehicles, t.garages, t.dc_minutes, d.name AS dc_name FROM fr_territories t LEFT JOIN fr_dcs d ON d.id = t.dc_id WHERE t.id = $1`, [tid]).catch(() => ({ rows: [] })) : { rows: [] }]);
    const terr = tr2[0] || null;
    const num = (v) => Number(v).toLocaleString('en-JM');
    return Object.assign(ci, {
      today: longDate(),
      recipient: (f && (f.principal || f.legal_name)) || (lead && (lead.company ? lead.name + ' (' + lead.company + ')' : lead.name)) || '',
      recipient_address: (f && f.address) || (lead && [lead.address, lead.parish].filter(Boolean).join(', ')) || '',
      recipient_email: (f && f.email) || (lead && lead.email) || '', recipient_phone: (f && f.phone) || (lead && lead.phone) || '',
      franchisee: (f && f.legal_name) || (lead && (lead.company || lead.name)) || '', trading_name: (f && (f.trading_name || f.legal_name)) || '',
      principal: (f && f.principal) || (lead && lead.name) || '', franchisee_address: (f && f.address) || (lead && lead.address) || '', franchisee_trn: (f && f.trn) || '',
      territory: territory || (lead && lead.area_wanted) || '', territory_desc: tdesc || '',
      effective_date: longDate(start), term_years: String(tr.term_years), term_end: (f && f.term_end) ? longDate(f.term_end) : longDate(addMonths(start, 12 * tr.term_years)),
      initial_fee: money(tr.initial_fee), royalty_pct: String(tr.royalty_pct), marketing_pct: String(tr.marketing_pct), tech_fee: money(tr.tech_fee),
      min_royalty: money(tr.min_royalty), renewal_fee: money(tr.renewal_fee), transfer_fee: money(tr.transfer_fee),
      report_day: String(s.report_day), royalty_due_day: String(s.royalty_due_day), local_marketing_pct: String(s.local_marketing_pct),
      gct_rate: String(s.gct_rate), wait_days: String(s.wait_days), opening_months: String(s.opening_months),
      store_type_label: STORE_TYPES[(f && f.store_type) || (lead && lead.programme) || 'franchise'] || STORE_TYPES.franchise,
      member_fee: money(tr.member_fee), commit_pct: String(tr.commit_pct), coop_pct: String(tr.coop_pct), coop_claim_pct: String(s.coop_claim_pct),
      loyalty_points_per_100: String(s.loyalty_points_per_100), loyalty_point_value: money(s.loyalty_point_value), hot_shot_minutes: String(s.hot_shot_minutes),
      target_fill_rate: String(s.target_fill_rate), dc_name: (f && f.dc_name) || 'the distribution centre', hub_name: (f && f.hub_name) || 'the hub store for your area',
      rebate_scale: rebates.length ? rebates.map((r) => 'DC purchases of ' + money(r.min_quarter) + ' or more in the quarter: ' + Number(r.rebate_pct) + '%').join('\n') : 'No rebate scale is set yet.',
      territory_market: terr ? [terr.population && num(terr.population) + ' people', terr.vehicles && num(terr.vehicles) + ' vehicles', terr.garages && num(terr.garages) + ' garages and fleets',
        terr.vehicles || terr.garages ? 'about ' + money((terr.vehicles || 0) * s.spend_per_vehicle + (terr.garages || 0) * s.spend_per_garage) + ' a year of parts spending' : null].filter(Boolean).join(', ') : '',
      territory_supply: terr && terr.dc_name ? terr.dc_name + (terr.dc_minutes ? ', ' + terr.dc_minutes + ' minutes away' : '') : '',
    });
  }
  function page(title, number, body, auto) {
    return '<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="/favicon.svg?v=vision2" type="image/svg+xml"><link rel="icon" href="/favicon.ico?v=vision2" sizes="any"><link rel="apple-touch-icon" href="/apple-touch-icon.png?v=vision2"><title>' + esc(title) + ' ' + esc(number) + '</title><style>' +
      'body{font-family:Arial,Helvetica,sans-serif;color:#111;max-width:780px;margin:24px auto;padding:0 24px;line-height:1.5}' +
      '.hd{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid #d61f2b;padding-bottom:8px;margin-bottom:18px}.hd b{font-size:18px}.hd small{color:#555}' +
      'h1{font-size:20px;margin:10px 0}h2{font-size:15px;margin:16px 0 4px}table{border-collapse:collapse;width:100%;margin:10px 0}th,td{border:1px solid #ccc;padding:7px 9px;text-align:left;vertical-align:top}th{background:#f4f4f5}' +
      '.sigs td{border:0;width:50%;padding:14px 8px}.sig{margin-top:30px}.blank{display:inline-block;min-width:140px;border-bottom:1px solid #999}.box{border:1px solid #999;padding:10px;margin:10px 0;background:#fafafa}' +
      '.draft-note{border:2px solid #b45309;background:#fff7ed;padding:10px;margin:0 0 14px;color:#7c2d12}.signed{margin-top:24px;border:1px solid #333;padding:12px;page-break-inside:avoid}.signed img{max-width:340px;height:auto;border-bottom:1px solid #333;display:block}' +
      '.small{color:#555;font-size:11.5px;word-break:break-all}.ft{margin-top:30px;border-top:1px solid #ddd;padding-top:6px;color:#777;font-size:11px}@media print{body{margin:0}}' +
      '</style></head><body><div class="hd"><div><b>' + esc(auto.company) + '</b><br><small>' + esc(auto.company_address) + ' · ' + esc(auto.company_phone) + '</small></div><small>' +
      esc(number) + '<br>' + esc(auto.today) + '</small></div>' + body + '<div class="ft">' + esc(title) + ' · ' + esc(number) + '</div></body></html>';
  }
  function fill(body, values, reviewed) {
    let b = String(body || '');
    if (reviewed) b = b.replace(/<div class="draft-note">[\s\S]*?<\/div>/g, '');
    return b.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (m, k) => {
      const v = values[k]; if (v == null || v === '') return '<span class="blank">&nbsp;</span>';
      return esc(v).replace(/\n/g, '<br>');
    });
  }
  async function signedNda(lead, f) {
    if (lead && lead.nda_signed_at) return true;
    const { rows } = await query(`SELECT 1 FROM fr_documents WHERE kind = 'nda' AND status IN ('signed', 'countersigned') AND (lead_id = $1 OR franchisee_id = $2) LIMIT 1`, [lead ? lead.id : 0, f ? f.id : 0]);
    return rows.length > 0;
  }
  async function fddReceived(lead, f) {
    if (!lead && f && f.lead_id) lead = await leadRow(f.lead_id).catch(() => null);
    if (lead && lead.fdd_received_at) return new Date(lead.fdd_received_at);
    const { rows } = await query(`SELECT MIN(signed_at) AS at FROM fr_documents WHERE kind = 'fdd' AND status IN ('signed', 'countersigned') AND (lead_id = $1 OR franchisee_id = $2)`, [lead ? lead.id : 0, f ? f.id : 0]);
    return rows[0].at ? new Date(rows[0].at) : null;
  }
  // The waiting period: the agreement is signed no sooner than wait_days after the disclosure document was received.
  async function agreementReady(doc) {
    const f = doc.franchisee_id ? await frRow(doc.franchisee_id) : null;
    const lead = doc.lead_id ? await leadRow(doc.lead_id) : null;
    const got = await fddReceived(lead, f);
    if (!got) throw httpError(409, 'The franchisee must receive and sign for the disclosure document before the agreement can be signed');
    const s = await settings();
    const from = new Date(got.getTime() + s.wait_days * 86400000);
    if (from > new Date()) throw httpError(409, 'The agreement can be signed from ' + from.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) + ', ' + s.wait_days + ' days after the disclosure document was received');
  }
  async function makeDocument(req, b) {
    const kind = String(b.kind || '');
    const lead = n(b.lead_id) ? await leadRow(b.lead_id) : null;
    let f = n(b.franchisee_id) ? await frRow(b.franchisee_id) : null;
    if (!lead && !f) throw httpError(400, 'Choose the lead or franchisee');
    if (!f && lead && lead.franchisee_id) f = await frRow(lead.franchisee_id);
    const tpl = await templateOf(kind);
    if (kind === 'fdd' && !(await signedNda(lead, f))) throw httpError(409, 'The confidentiality agreement (NDA) must be signed before the disclosure document is given');
    if (['agreement', 'manual', 'renewal', 'transfer', 'default_notice', 'termination', 'affiliate', 'supply', 'hub_service', 'systems', 'loyalty', 'certification', 'commercial_app', 'coop'].includes(kind) && !f) throw httpError(409, 'Make the franchisee record first (approve the lead and convert it)');
    const auto = await autoValues(lead, f);
    const given = {};
    for (const fl of tpl.fields || []) {
      let v = b.values && b.values[fl.key] != null ? String(b.values[fl.key]).slice(0, 8000) : (fl.default != null ? String(fl.default) : '');
      if (fl.type === 'date' && d(v)) v = longDate(v);
      if (fl.required && !String(v).trim()) throw httpError(400, '"' + fl.label + '" is needed');
      given[fl.key] = v;
    }
    const values = Object.assign({}, auto, given);
    const { rows } = await query(`INSERT INTO fr_documents (lead_id, franchisee_id, kind, title, template_doc_id, form_values, html, content_sha256, needs_signature, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,'','',$7,$8) RETURNING id`, [lead ? lead.id : null, f ? f.id : null, kind, tpl.tp.title, tpl.document_id, JSON.stringify(given), !!tpl.tp.sign, me(req)]);
    const id = rows[0].id, number = 'FD-' + String(id).padStart(5, '0');
    const html = page(tpl.tp.title, number, fill(tpl.body, Object.assign(values, { number }), tpl.reviewed), auto);
    await query(`UPDATE fr_documents SET html = $2, content_sha256 = $3 WHERE id = $1`, [id, html, sha(html)]);
    await log({ lead_id: lead && lead.id, franchisee_id: f && f.id, action: 'document made', detail: tpl.tp.title + ' ' + number + (tpl.reviewed ? '' : ' (template not yet reviewed by an attorney)') }, req);
    return { id, number, reviewed: tpl.reviewed };
  }
  async function docRow(id) {
    const { rows } = await query(`SELECT * FROM fr_documents WHERE id = $1`, [n(id)]);
    if (!rows.length) throw httpError(404, 'Document not found');
    return rows[0];
  }
  const numberOf = (doc) => 'FD-' + String(doc.id).padStart(5, '0');
  const sealOf = (x) => (SECRET ? crypto.createHmac('sha256', SECRET).update(JSON.stringify([x.id, x.content_sha256, x.method, x.signer_name, new Date(x.signed_at).toISOString(), sha(x.image),
    x.signer_email || null, x.ip || null, x.witnessed_by || null])).digest('hex') : null);
  const counterSealOf = (x) => (SECRET ? crypto.createHmac('sha256', SECRET).update(JSON.stringify([x.id, x.content_sha256, x.seal, x.counter_name, new Date(x.counter_at).toISOString(), sha(x.counter_image), x.counter_by || null])).digest('hex') : null);
  function signedHtml(doc, witness) {
    let block = '';
    if (doc.signed_at) block += '<div class="signed"><p style="margin-top:0">Signed by <b>' + esc(doc.signer_name) + '</b>' + (doc.franchisee_id || doc.lead_id ? '' : '') + '</p><img alt="Signature" src="' + doc.image + '">' +
      '<p class="small">' + esc(new Date(doc.signed_at).toISOString().replace('T', ' ').slice(0, 19)) + ' UTC · ' + (doc.method === 'in_person' ? 'signed in person' + (witness ? ', witnessed by ' + esc(witness) : '') : 'signed from a link sent' + (doc.signer_email ? ' to ' + esc(doc.signer_email) : '') + ', from ' + esc(doc.ip || 'unknown address')) +
      '<br>Document fingerprint (SHA-256): ' + esc(doc.content_sha256) + '<br>Seal: ' + esc(doc.seal || '') + '</p></div>';
    if (doc.counter_at) block += '<div class="signed"><p style="margin-top:0">Signed for the franchisor by <b>' + esc(doc.counter_name) + '</b></p><img alt="Signature" src="' + doc.counter_image + '">' +
      '<p class="small">' + esc(new Date(doc.counter_at).toISOString().replace('T', ' ').slice(0, 19)) + ' UTC<br>Seal: ' + esc(doc.counter_seal || '') + '</p></div>';
    return doc.html.replace(/<div class="ft">/, block + '<div class="ft">');
  }
  function pngOf(image) {
    const s = String(image || '');
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(s);
    if (!m || m[1].length > 400000) throw httpError(400, 'Sign in the box first');
    const png = Buffer.from(m[1], 'base64');
    if (png.length < 200 || png.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') throw httpError(400, 'Sign in the box first');
    return s;
  }
  const CAT = (kind) => (['training', 'opening', 'audit', 'certification', 'commercial_app', 'coop', 'site_report'].includes(kind) ? 'form' : ['default_notice', 'termination'].includes(kind) ? 'correspondence' : 'contract');
  async function fileCopy(req, doc, note) {
    if (!docs || !docs.fileHtml) return null;
    try {
      const f = doc.franchisee_id ? await frRow(doc.franchisee_id) : null;
      const lead = !f && doc.lead_id ? await leadRow(doc.lead_id) : null;
      const who = (f && f.legal_name) || (lead && (lead.company || lead.name)) || '';
      let witness = null;
      if (doc.witnessed_by) witness = ((await query(`SELECT COALESCE(NULLIF(name, ''), email) AS n FROM users WHERE id = $1`, [doc.witnessed_by])).rows[0] || {}).n;
      const html = doc.signed_at ? signedHtml(doc, witness) : doc.html;
      const filed = await docs.fileHtml(req, { title: doc.title + (doc.signed_at ? ' (signed)' : '') + ' - ' + who, category: CAT(doc.kind), reference: numberOf(doc), issuer: doc.signer_name || null,
        issue_date: today(), tags: 'franchise', html, file_name: doc.title + ' ' + numberOf(doc), note, confidentiality: 'confidential',
        links: f && f.customer_id ? [{ type: 'customer', id: f.customer_id }] : [] });
      await query(`UPDATE fr_documents SET signed_document_id = $2 WHERE id = $1`, [doc.id, filed.id]);
      return filed;
    } catch (e) { console.error('[franchise] filing', e.message); return null; }
  }
  // What a signature sets in motion.
  async function afterSigned(req, doc) {
    const at = doc.signed_at;
    if (doc.lead_id) {
      if (doc.kind === 'nda') { await query(`UPDATE fr_leads SET nda_signed_at = COALESCE(nda_signed_at, $2) WHERE id = $1`, [doc.lead_id, at]); await setStage(doc.lead_id, 'nda', null, req); }
      if (doc.kind === 'fdd') { await query(`UPDATE fr_leads SET fdd_received_at = COALESCE(fdd_received_at, $2) WHERE id = $1`, [doc.lead_id, at]); await setStage(doc.lead_id, 'disclosed', null, req); }
      if (doc.kind === 'application') { await query(`UPDATE fr_leads SET applied_at = COALESCE(applied_at, $2) WHERE id = $1`, [doc.lead_id, at]); await setStage(doc.lead_id, 'application', null, req); }
    }
    if (doc.franchisee_id && (doc.kind === 'agreement' || doc.kind === 'affiliate')) {
      const f = await frRow(doc.franchisee_id);
      const day = new Date(new Date(at).getTime() - 5 * 3600000).toISOString().slice(0, 10);
      const start = f.term_start || day;
      await query(`UPDATE fr_franchisees SET signed_on = COALESCE(signed_on, $2), term_start = $3, term_end = COALESCE(term_end, ($3::date + (term_years || ' years')::interval)::date), updated_at = NOW() WHERE id = $1`, [f.id, day, start]);
      if (f.territory_id) await query(`UPDATE fr_territories SET status = 'sold' WHERE id = $1 AND status IN ('open', 'reserved')`, [f.territory_id]);
      if (f.lead_id) await setStage(f.lead_id, 'signed', null, req);
    }
    if (doc.franchisee_id && doc.kind === 'manual') await query(`UPDATE fr_tasks SET done_at = NOW(), done_by = $2, note = COALESCE(note, 'Acknowledged on ' || $3) WHERE franchisee_id = $1 AND done_at IS NULL AND title ILIKE 'Operations manual%'`, [doc.franchisee_id, me(req), numberOf(doc)]);
  }
  async function saveSignature(req, doc, s) {
    if (!doc.needs_signature) throw httpError(409, 'This document is not signed; file it instead');
    if (!['draft', 'sent'].includes(doc.status)) throw httpError(409, doc.status === 'cancelled' ? 'This document was cancelled' : 'This document has already been signed');
    if (!SECRET) throw httpError(503, 'Signing is not set up on this till (SESSION_SECRET is missing)');
    if (sha(doc.html) !== doc.content_sha256) throw httpError(409, 'This document was changed after it was made. Make a new one.');
    if (doc.kind === 'agreement' || doc.kind === 'affiliate') await agreementReady(doc);
    const name = String(s.name || '').trim().slice(0, 100);
    if (name.length < 2) throw httpError(400, 'Type the name of the person signing');
    const image = pngOf(s.image);
    const row = { id: doc.id, content_sha256: doc.content_sha256, method: s.method, signer_name: name, signed_at: new Date(), image, signer_email: s.email || null, ip: ipOf(req), witnessed_by: s.witness_id || null };
    row.seal = sealOf(row);
    const { rowCount } = await query(`UPDATE fr_documents SET status = 'signed', method = $2, signer_name = $3, signer_email = $4, image = $5, ip = $6, user_agent = $7, witnessed_by = $8, signed_at = $9, seal = $10
      WHERE id = $1 AND status IN ('draft', 'sent')`, [doc.id, row.method, name, row.signer_email, image, row.ip, String(req.headers['user-agent'] || '').slice(0, 300), row.witnessed_by, row.signed_at, row.seal]);
    if (!rowCount) throw httpError(409, 'This document has already been signed');
    const signed = await docRow(doc.id);
    await afterSigned(req, signed);
    const filed = await fileCopy(req, signed, s.method === 'in_person' ? 'Signed in person' : 'Signed from a link');
    await log({ lead_id: doc.lead_id, franchisee_id: doc.franchisee_id, action: 'document signed', detail: doc.title + ' ' + numberOf(doc) + ' by ' + name + (s.method === 'in_person' ? ' (in person)' : ' (from the link)') + (filed ? ', filed as ' + filed.number : '') }, req);
    return { document: filed };
  }
  function docState(x) {
    return { id: x.id, number: numberOf(x), kind: x.kind, title: x.title, status: x.status, needs_signature: x.needs_signature, countersign: COUNTER.has(x.kind),
      lead_id: x.lead_id, franchisee_id: x.franchisee_id, sent_to: x.sent_to, sent_at: x.sent_at, expires_at: x.expires_at, viewed_at: x.viewed_at,
      signer_name: x.signer_name, signed_at: x.signed_at, method: x.method, counter_name: x.counter_name, counter_at: x.counter_at, created_at: x.created_at,
      signed_document_id: x.signed_document_id, decline_reason: x.decline_reason,
      unchanged: sha(x.html) === x.content_sha256, sealed: x.signed_at ? !!x.seal && sealOf(x) === x.seal : null,
      counter_sealed: x.counter_at ? !!x.counter_seal && counterSealOf(x) === x.counter_seal : null };
  }

  // ===================================================== staff: meta, dash ==
  app.get('/api/franchise/meta', ...M, async (req, res) => {
    try {
      await ensureTemplates();
      const [s, terr, tpls, staff] = await Promise.all([settings(),
        query(`SELECT t.*, f.id AS franchisee_id, f.trading_name, f.legal_name FROM fr_territories t LEFT JOIN fr_franchisees f ON f.territory_id = t.id AND f.status IN ('onboarding', 'open', 'suspended') ORDER BY t.code`),
        query(`SELECT f.key, f.document_id, f.reviewed_at, f.reviewer, COALESCE(NULLIF(u.name, ''), u.email) AS reviewed_by_name, d.number, d.deleted_at, d.updated_at
          FROM fr_templates f LEFT JOIN users u ON u.id = f.reviewed_by LEFT JOIN documents d ON d.id = f.document_id`),
        query(`SELECT id, COALESCE(NULLIF(name, ''), email) AS name FROM users WHERE (is_staff OR is_admin) AND NOT COALESCE(disabled, false) ORDER BY 2`)]);
      const tmap = Object.fromEntries(tpls.rows.map((r) => [r.key, r]));
      res.json({ settings: s, defaults: DEFAULTS, territories: terr.rows, staff: staff.rows, stages: STAGES.concat(['declined', 'withdrawn']).map((k) => ({ key: k, label: STAGE_LABEL[k] })),
        statuses: FR_STATUSES, phases: PHASES, audit_items: AUDIT_ITEMS, audit_kinds: AUDIT_KINDS, charge_kinds: ONE_OFF.map((k) => ({ key: k, label: CHARGE_LABEL[k] })),
        templates: TEMPLATES.map((x) => Object.assign({ key: x.key, title: x.title, sign: !!x.sign, countersign: COUNTER.has(x.key), fields: x.fields },
          tmap[x.key] ? { document_id: tmap[x.key].deleted_at ? null : tmap[x.key].document_id, doc_number: tmap[x.key].number, reviewed_at: tmap[x.key].reviewed_at, reviewer: tmap[x.key].reviewer, reviewed_by_name: tmap[x.key].reviewed_by_name } : {})),
        templates_in_docs: tplReady, store_types: STORE_TYPES, systems: SYSTEMS });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/franchise/settings', ...M, async (req, res) => {
    try {
      const b = req.body || {};
      const changed = [];
      for (const k of Object.keys(DEFAULTS)) {
        if (!(k in b)) continue;
        const raw = b[k] == null ? '' : String(b[k]).replace(/[\s,]|J\$/g, '');
        const v = raw === '' ? null : Number(raw);
        if (v != null && !(Number.isFinite(v) && v >= 0)) throw httpError(400, 'Check "' + k.replace(/_/g, ' ') + '"');
        await query(`INSERT INTO fr_settings (key, value, updated_by, updated_at) VALUES ($1,$2,$3,NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`, [k, v == null ? null : String(v), me(req)]);
        changed.push(k);
      }
      await log({ action: 'settings changed', detail: changed.join(', ') }, req);
      res.json({ ok: true, settings: await settings() });
    } catch (e) { fail(res, e); }
  });
  // An attorney has reviewed a template: copies made from it no longer carry the notice.
  app.post('/api/franchise/templates/:key/review', ...M, async (req, res) => {
    try {
      const key = String(req.params.key);
      if (!TPL[key]) throw httpError(404, 'Unknown template');
      const b = req.body || {};
      const undo = b.reviewed === false;
      const reviewer = t(b.reviewer, 200);
      if (!undo && !reviewer) throw httpError(400, 'Who reviewed it (the attorney or firm)?');
      await query(`INSERT INTO fr_templates (key, reviewed_by, reviewed_at, reviewer, updated_at) VALUES ($1,$2,$3,$4,NOW())
        ON CONFLICT (key) DO UPDATE SET reviewed_by = EXCLUDED.reviewed_by, reviewed_at = EXCLUDED.reviewed_at, reviewer = EXCLUDED.reviewer, updated_at = NOW()`,
        [key, undo ? null : me(req), undo ? null : new Date(), undo ? null : reviewer]);
      await log({ action: undo ? 'template review withdrawn' : 'template reviewed', detail: TPL[key].title + (reviewer ? ' by ' + reviewer : '') }, req);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/franchise/templates/:key/preview', ...M, async (req, res) => {
    try {
      const tpl = await templateOf(String(req.params.key));
      const auto = await autoValues(null, null);
      const values = Object.assign({}, auto, Object.fromEntries((tpl.fields || []).map((f) => [f.key, f.default || ''])), { number: 'PREVIEW' });
      res.type('html').set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:").send(page(tpl.tp.title, 'PREVIEW', fill(tpl.body, values, tpl.reviewed), auto));
    } catch (e) { fail(res, e); }
  });

  app.get('/api/franchise/dashboard', ...M, async (req, res) => {
    try {
      const s = await settings();
      const last = monthOf(addMonths(today().slice(0, 8) + '01', -1));
      const [stages, statuses, tasks, missing, unbilled, owed, renew, actions, audits, waiting, recent] = await Promise.all([
        query(`SELECT stage, COUNT(*)::int AS c FROM fr_leads GROUP BY stage`),
        query(`SELECT status, COUNT(*)::int AS c FROM fr_franchisees GROUP BY status`),
        query(`SELECT COUNT(*) FILTER (WHERE due_on < CURRENT_DATE)::int AS overdue, COUNT(*)::int AS open FROM fr_tasks k JOIN fr_franchisees f ON f.id = k.franchisee_id WHERE k.done_at IS NULL AND f.status IN ('onboarding', 'open')`),
        query(`SELECT f.id, f.number, COALESCE(f.trading_name, f.legal_name) AS name FROM fr_franchisees f WHERE f.status = 'open' AND COALESCE(f.opened_on, CURRENT_DATE) < $1::date + interval '1 month'
          AND NOT EXISTS (SELECT 1 FROM fr_reports r WHERE r.franchisee_id = f.id AND r.period = $1) ORDER BY 2`, [last]),
        query(`SELECT r.id, r.franchisee_id, ${DATE('r.period')} AS period, COALESCE(f.trading_name, f.legal_name) AS name, r.net_sales::float AS net_sales FROM fr_reports r JOIN fr_franchisees f ON f.id = r.franchisee_id
          WHERE NOT EXISTS (SELECT 1 FROM fr_charges c WHERE c.franchisee_id = r.franchisee_id AND c.kind IN ${MONTHLY} AND c.period = r.period) ORDER BY r.period, 4`),
        query(`SELECT COALESCE(SUM(i.total - ${PAID('i.id')}), 0)::float AS owed,
                 COALESCE(SUM(i.total - ${PAID('i.id')}) FILTER (WHERE i.due_date < CURRENT_DATE), 0)::float AS overdue
            FROM ar_invoices i WHERE i.voided_at IS NULL AND i.id IN (SELECT ar_invoice_id FROM fr_charges WHERE ar_invoice_id IS NOT NULL)`),
        query(`SELECT f.id, f.number, COALESCE(f.trading_name, f.legal_name) AS name, ${DATE('f.term_end')} AS term_end FROM fr_franchisees f
          WHERE f.status IN ('open', 'suspended', 'expired') AND f.term_end IS NOT NULL AND f.term_end <= CURRENT_DATE + ($1 || ' months')::interval
            AND NOT EXISTS (SELECT 1 FROM fr_actions a WHERE a.franchisee_id = f.id AND a.kind = 'renewal' AND a.status = 'open') ORDER BY f.term_end`, [String(s.renewal_notice_months)]),
        query(`SELECT a.id, a.kind, a.franchisee_id, ${DATE('a.cure_by')} AS cure_by, ${DATE('a.effective_date')} AS effective_date, COALESCE(f.trading_name, f.legal_name) AS name
          FROM fr_actions a JOIN fr_franchisees f ON f.id = a.franchisee_id WHERE a.status = 'open' ORDER BY COALESCE(a.cure_by, a.effective_date) NULLS LAST`),
        query(`SELECT f.id, f.number, COALESCE(f.trading_name, f.legal_name) AS name, (SELECT ${DATE('MAX(audit_date)')} FROM fr_audits a WHERE a.franchisee_id = f.id) AS last_audit
          FROM fr_franchisees f WHERE f.status = 'open' AND NOT EXISTS (SELECT 1 FROM fr_audits a WHERE a.franchisee_id = f.id AND a.audit_date > CURRENT_DATE - 100) ORDER BY 4 NULLS FIRST`),
        query(`SELECT COUNT(*) FILTER (WHERE status = 'sent')::int AS out, COUNT(*) FILTER (WHERE status = 'signed' AND kind IN ('nda', 'agreement', 'renewal', 'transfer'))::int AS countersign FROM fr_documents`),
        query(`SELECT l.action, l.detail, l.at, COALESCE(NULLIF(u.name, ''), u.email) AS by_name, l.lead_id, l.franchisee_id FROM fr_log l LEFT JOIN users u ON u.id = l.by_user ORDER BY l.id DESC LIMIT 15`)]);
      res.json({ stages: Object.fromEntries(stages.rows.map((r) => [r.stage, r.c])), statuses: Object.fromEntries(statuses.rows.map((r) => [r.status, r.c])),
        tasks: tasks.rows[0], last_period: last, missing_reports: missing.rows, unbilled: unbilled.rows, owed: owed.rows[0], renewals_due: renew.rows,
        open_actions: actions.rows, audits_due: audits.rows, signatures: waiting.rows[0], recent: recent.rows });
    } catch (e) { fail(res, e); }
  });
  // The scorecard figures on a report row.
  function REPORT_EXTRA(a) {
    return ['diy_sales', 'commercial_sales', 'cogs', 'inventory_value', 'shrink', 'purchases_total', 'delivery_minutes'].map((k) => a + '.' + k + '::float AS ' + k)
      .concat(['loyalty_issued', 'loyalty_redeemed', 'loyalty_members', 'deliveries'].map((k) => a + '.' + k)).join(', ');
  }
  // Payments applied to an invoice (voided payments do not count: the view leaves them out).
  function PAID(col) { return `(SELECT COALESCE(SUM(x.amount), 0) FROM ar_applications x JOIN account_payments ap ON ap.id = x.payment_id WHERE x.invoice_id = ${col})`; }

  // ========================================================== territories ==
  function terrInput(b) {
    const code = t(b.code, 30), name = t(b.name, 120);
    if (!code || !name) throw httpError(400, 'A code and a name for the territory');
    const status = ['open', 'reserved', 'sold', 'company'].includes(b.status) ? b.status : 'open';
    return [code.toUpperCase(), name, t(b.description, 2000), n(b.population), b.exclusive !== false, status, t(b.notes, 2000)];
  }
  app.post('/api/franchise/territories', ...M, async (req, res) => {
    try {
      const { rows } = await query(`INSERT INTO fr_territories (code, name, description, population, exclusive, status, notes) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, terrInput(req.body || {}))
        .catch((e) => { if (e.code === '23505') throw httpError(409, 'That territory code is already used'); throw e; });
      await log({ action: 'territory added', detail: req.body.code + ' ' + req.body.name }, req);
      res.json({ ok: true, id: rows[0].id });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/franchise/territories/:id(\\d+)', ...M, async (req, res) => {
    try {
      const { rowCount } = await query(`UPDATE fr_territories SET code = $2, name = $3, description = $4, population = $5, exclusive = $6, status = $7, notes = $8 WHERE id = $1`, [n(req.params.id)].concat(terrInput(req.body || {})))
        .catch((e) => { if (e.code === '23505') throw httpError(409, 'That territory code is already used'); throw e; });
      if (!rowCount) throw httpError(404, 'Territory not found');
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ================================================================ leads ==
  function leadInput(b, partial) {
    const out = {};
    const txt = { name: 200, company: 200, email: 200, phone: 60, address: 500, parish: 60, area_wanted: 200, source: 60, experience: 4000, timeline: 200, message: 4000, notes: 4000, current_store: 300 };
    for (const k of Object.keys(txt)) if (!partial || k in b) out[k] = t(b[k], txt[k]);
    if (!partial || 'programme' in b) out.programme = b.programme === 'affiliate' ? 'affiliate' : 'franchise';
    for (const k of ['capital', 'net_worth']) if (!partial || k in b) out[k] = amt(b[k]);
    if (!partial || 'territory_id' in b) out.territory_id = n(b.territory_id);
    if (!partial || 'owner_id' in b) out.owner_id = n(b.owner_id);
    if ((!partial || 'name' in b) && !out.name) throw httpError(400, 'The name of the person enquiring');
    if (out.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(out.email)) throw httpError(400, 'That email address does not look right');
    if (!partial && !out.email && !out.phone) throw httpError(400, 'An email address or phone number');
    return out;
  }
  app.get('/api/franchise/leads', ...M, async (req, res) => {
    try {
      const where = [], args = [];
      if (req.query.stage === 'active') where.push(`l.stage NOT IN ('declined', 'withdrawn', 'signed')`);
      else if (req.query.stage) { args.push(String(req.query.stage)); where.push(`l.stage = $${args.length}`); }
      if (req.query.q) { args.push('%' + String(req.query.q).trim() + '%'); where.push(`(l.name ILIKE $${args.length} OR l.company ILIKE $${args.length} OR l.email ILIKE $${args.length} OR l.phone ILIKE $${args.length} OR l.area_wanted ILIKE $${args.length})`); }
      const { rows } = await query(`SELECT l.id, l.name, l.company, l.email, l.phone, l.parish, l.area_wanted, l.source, l.stage, l.score, l.capital::float AS capital, l.franchisee_id, l.programme,
          ${DATE('l.created_at')} AS created_day, l.nda_signed_at, l.fdd_received_at, l.applied_at, t.name AS territory_name, COALESCE(NULLIF(o.name, ''), o.email) AS owner_name
        FROM fr_leads l LEFT JOIN fr_territories t ON t.id = l.territory_id LEFT JOIN users o ON o.id = l.owner_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY l.created_at DESC LIMIT 500`, args);
      res.json({ leads: rows });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/franchise/leads', ...M, async (req, res) => {
    try {
      const l = leadInput(req.body || {}, false);
      const cols = Object.keys(l);
      const { rows } = await query(`INSERT INTO fr_leads (${cols.join(', ')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(', ')}) RETURNING id`, cols.map((k) => l[k]));
      await log({ lead_id: rows[0].id, action: 'enquiry recorded', detail: l.name + (l.source ? ' (' + l.source + ')' : '') }, req);
      res.json({ ok: true, id: rows[0].id });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/franchise/leads/:id(\\d+)', ...M, async (req, res) => {
    try {
      const l = await leadRow(req.params.id);
      const [docsR, logR] = await Promise.all([
        query(`SELECT * FROM fr_documents WHERE lead_id = $1 ORDER BY id DESC`, [l.id]),
        query(`SELECT l.action, l.detail, l.at, COALESCE(NULLIF(u.name, ''), u.email) AS by_name FROM fr_log l LEFT JOIN users u ON u.id = l.by_user WHERE l.lead_id = $1 ORDER BY l.id DESC LIMIT 200`, [l.id])]);
      const s = await settings();
      const fdd = await fddReceived(l, null);
      res.json({ lead: l, documents: docsR.rows.map(docState), log: logR.rows, stage_label: STAGE_LABEL,
        agreement_from: fdd ? new Date(fdd.getTime() + s.wait_days * 86400000) : null });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/franchise/leads/:id(\\d+)', ...M, async (req, res) => {
    try {
      const l0 = await leadRow(req.params.id);
      const l = leadInput(req.body || {}, true);
      const cols = Object.keys(l);
      if (cols.length) await query(`UPDATE fr_leads SET ${cols.map((k, i) => k + ' = $' + (i + 2)).join(', ')}, updated_at = NOW() WHERE id = $1`, [l0.id].concat(cols.map((k) => l[k])));
      await log({ lead_id: l0.id, action: 'details changed', detail: cols.join(', ') }, req);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  // Qualifying: the usual screens, scored out of 100.
  app.post('/api/franchise/leads/:id(\\d+)/qualify', ...M, async (req, res) => {
    try {
      const l = await leadRow(req.params.id);
      if (['declined', 'withdrawn'].includes(l.stage)) throw httpError(409, 'This lead is closed');
      const b = req.body || {}, c = b.checks || {}, s = await settings();
      const checks = [
        { key: 'capital', label: 'Cash to invest at least ' + money(s.min_capital), points: 30, ok: Number(l.capital || 0) >= s.min_capital },
        { key: 'net_worth', label: 'Net worth at least ' + money(s.min_net_worth), points: 20, ok: Number(l.net_worth || 0) >= s.min_net_worth },
        { key: 'experience', label: 'Business, retail or motor-trade experience', points: 15, ok: c.experience === true },
        { key: 'territory', label: 'The area wanted is available', points: 15, ok: c.territory === true || (l.territory_id && l.territory_status === 'open') },
        { key: 'timeline', label: 'Ready to open within 12 months', points: 10, ok: c.timeline === true },
        { key: 'interview', label: 'First interview held and went well', points: 10, ok: c.interview === true },
      ];
      const score = checks.reduce((x, k) => x + (k.ok ? k.points : 0), 0);
      const passed = score >= s.qualify_score;
      await query(`UPDATE fr_leads SET score = $2, qualification = $3, updated_at = NOW() WHERE id = $1`, [l.id, score, JSON.stringify({ checks, score, notes: t(b.notes, 2000), at: new Date() })]);
      await log({ lead_id: l.id, action: 'qualified', detail: 'Score ' + score + '/100' + (passed ? ' (passes)' : ' (below ' + s.qualify_score + ')') }, req);
      if (passed) await setStage(l.id, 'qualified', null, req);
      res.json({ ok: true, score, passed, checks });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/franchise/leads/:id(\\d+)/application', ...M, async (req, res) => {
    try {
      const l = await leadRow(req.params.id);
      const a = (req.body || {}).answers || {};
      const answers = {};
      for (const fl of TPL.application.fields) answers[fl.key] = t(a[fl.key], 4000);
      if (!answers.capital || !answers.experience || !answers.area) throw httpError(400, 'Cash available, experience and the area wanted are needed');
      await query(`UPDATE fr_leads SET application = $2, applied_at = COALESCE(applied_at, NOW()), updated_at = NOW() WHERE id = $1`, [l.id, JSON.stringify(answers)]);
      await log({ lead_id: l.id, action: 'application recorded' }, req);
      res.json({ ok: true, stage: await setStage(l.id, 'application', null, req) });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/franchise/leads/:id(\\d+)/decide', ...M, async (req, res) => {
    try {
      const l = await leadRow(req.params.id);
      const b = req.body || {};
      const decision = ['approve', 'decline', 'withdrawn', 'reopen'].includes(b.decision) ? b.decision : null;
      if (!decision) throw httpError(400, 'Approve, decline or withdrawn');
      if (decision === 'approve') {
        if (!l.applied_at) throw httpError(409, 'Record their application first');
        if (!(await fddReceived(l, null))) throw httpError(409, 'They must receive and sign for the disclosure document first');
        await query(`UPDATE fr_leads SET decided_by = $2, decided_at = NOW(), decline_reason = NULL WHERE id = $1`, [l.id, me(req)]);
        return res.json({ ok: true, stage: await setStage(l.id, 'approved', null, req) });
      }
      if (decision === 'reopen') {
        if (!['declined', 'withdrawn'].includes(l.stage)) throw httpError(409, 'This lead is not closed');
        const back = l.fdd_received_at ? 'disclosed' : l.nda_signed_at ? 'nda' : l.score != null ? 'qualified' : 'enquiry';
        await query(`UPDATE fr_leads SET stage = $2, updated_at = NOW() WHERE id = $1`, [l.id, back]);
        await log({ lead_id: l.id, action: 'reopened' }, req);
        return res.json({ ok: true, stage: back });
      }
      const reason = t(b.reason, 1000);
      if (decision === 'decline' && !reason) throw httpError(400, 'Give the reason (kept on file; be fair and consistent)');
      const stage = decision === 'decline' ? 'declined' : 'withdrawn';
      await query(`UPDATE fr_leads SET stage = $2, decline_reason = $3, decided_by = $4, decided_at = NOW(), updated_at = NOW() WHERE id = $1`, [l.id, stage, reason, me(req)]);
      await query(`UPDATE fr_documents SET status = 'cancelled' WHERE lead_id = $1 AND status IN ('draft', 'sent')`, [l.id]);
      await log({ lead_id: l.id, action: stage, detail: reason }, req);
      res.json({ ok: true, stage });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/franchise/leads/:id(\\d+)/convert', ...M, async (req, res) => {
    try {
      const l = await leadRow(req.params.id);
      if (l.franchisee_id) throw httpError(409, 'This lead already has a franchisee record');
      if (l.stage !== 'approved') throw httpError(409, 'Approve the lead first');
      const b = Object.assign({ legal_name: l.company || l.name, principal: l.name, email: l.email, phone: l.phone, address: l.address, territory_id: l.territory_id, store_type: l.programme }, req.body || {});
      const id = await createFranchisee(req, b, l.id);
      await setStage(l.id, 'agreement', null, req);
      // The documents made for the lead belong to the franchisee too.
      await query(`UPDATE fr_documents SET franchisee_id = $2 WHERE lead_id = $1 AND franchisee_id IS NULL`, [l.id, id]);
      res.json({ ok: true, franchisee_id: id });
    } catch (e) { fail(res, e); }
  });

  // =========================================================== franchisees ==
  app.get('/api/franchise/franchisees', ...M, async (req, res) => {
    try {
      const { rows } = await query(`SELECT f.id, f.number, f.legal_name, f.trading_name, f.principal, f.phone, f.email, f.status, ${DATE('f.signed_on')} AS signed_on, ${DATE('f.opened_on')} AS opened_on,
          ${DATE('f.term_end')} AS term_end, t.name AS territory_name, f.customer_id, f.store_type, f.network_role, f.format_key, f.dc_id, f.hub_id, f.sq_ft,
          (SELECT COUNT(*)::int FROM fr_tasks k WHERE k.franchisee_id = f.id AND k.done_at IS NULL) AS tasks_open,
          (SELECT COUNT(*)::int FROM fr_tasks k WHERE k.franchisee_id = f.id) AS tasks_all,
          (SELECT score_pct::float FROM fr_audits a WHERE a.franchisee_id = f.id ORDER BY audit_date DESC, id DESC LIMIT 1) AS last_audit
        FROM fr_franchisees f LEFT JOIN fr_territories t ON t.id = f.territory_id ORDER BY f.status = 'open' DESC, f.number`);
      res.json({ franchisees: rows });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/franchise/franchisees', ...M, async (req, res) => {
    try { res.json({ ok: true, id: await createFranchisee(req, req.body || {}, null) }); } catch (e) { fail(res, e); }
  });
  app.get('/api/franchise/franchisees/:id(\\d+)', ...M, async (req, res) => {
    try {
      const f = await frRow(req.params.id);
      const s = await settings();
      const [tasks, docsR, reports, charges, audits, actions, logR, lead] = await Promise.all([
        query(`SELECT k.id, k.phase, k.title, ${DATE('k.due_on')} AS due_on, k.done_at, k.note, COALESCE(NULLIF(u.name, ''), u.email) AS done_by_name FROM fr_tasks k LEFT JOIN users u ON u.id = k.done_by WHERE k.franchisee_id = $1 ORDER BY k.sort, k.id`, [f.id]),
        query(`SELECT * FROM fr_documents WHERE franchisee_id = $1 ORDER BY id DESC`, [f.id]),
        query(`SELECT r.id, ${DATE('r.period')} AS period, r.gross_sales::float AS gross_sales, r.refunds::float AS refunds, r.gct_collected::float AS gct_collected, r.net_sales::float AS net_sales,
            r.transactions, r.local_marketing::float AS local_marketing, r.notes, r.source, r.submitted_at, ${REPORT_EXTRA('r')},
            EXISTS (SELECT 1 FROM fr_charges c WHERE c.franchisee_id = r.franchisee_id AND c.kind IN ${MONTHLY} AND c.period = r.period) AS billed
          FROM fr_reports r WHERE r.franchisee_id = $1 ORDER BY r.period DESC`, [f.id]),
        query(`SELECT c.id, c.kind, ${DATE('c.period')} AS period, c.description, c.base::float AS base, c.rate::float AS rate, c.amount::float AS amount, c.gct::float AS gct, c.ar_invoice_id, i.number AS invoice_number, c.created_at
          FROM fr_charges c LEFT JOIN ar_invoices i ON i.id = c.ar_invoice_id WHERE c.franchisee_id = $1 ORDER BY c.id DESC`, [f.id]),
        query(`SELECT a.id, a.kind, ${DATE('a.audit_date')} AS audit_date, a.score_pct::float AS score_pct, a.result, a.findings, a.actions, ${DATE('a.follow_up_on')} AS follow_up_on, a.closed_at,
            COALESCE(NULLIF(u.name, ''), u.email) AS auditor FROM fr_audits a LEFT JOIN users u ON u.id = a.auditor_id WHERE a.franchisee_id = $1 ORDER BY a.audit_date DESC, a.id DESC`, [f.id]),
        query(`SELECT a.id, a.kind, a.status, ${DATE('a.effective_date')} AS effective_date, ${DATE('a.cure_by')} AS cure_by, a.details, a.created_at, a.closed_at, a.close_note,
            COALESCE(NULLIF(u.name, ''), u.email) AS created_by_name FROM fr_actions a LEFT JOIN users u ON u.id = a.created_by WHERE a.franchisee_id = $1 ORDER BY a.id DESC`, [f.id]),
        query(`SELECT l.action, l.detail, l.at, COALESCE(NULLIF(u.name, ''), u.email) AS by_name FROM fr_log l LEFT JOIN users u ON u.id = l.by_user WHERE l.franchisee_id = $1 ORDER BY l.id DESC LIMIT 300`, [f.id]),
        f.lead_id ? leadRow(f.lead_id).catch(() => null) : null]);
      res.json({ franchisee: f, terms: terms(f, s), tasks: tasks.rows, documents: docsR.rows.map(docState), reports: reports.rows, charges: charges.rows, audits: audits.rows,
        actions: actions.rows, log: logR.rows, lead: lead ? { id: lead.id, stage: lead.stage, fdd_received_at: lead.fdd_received_at, nda_signed_at: lead.nda_signed_at } : null,
        statement: await statement(f) });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/franchise/franchisees/:id(\\d+)', ...M, async (req, res) => {
    try {
      const f0 = await frRow(req.params.id);
      const f = frInput(req.body || {}, await settings(), true);
      if ('legal_name' in f && !f.legal_name) throw httpError(400, 'The legal name cannot be blank');
      const cols = Object.keys(f);
      if (cols.length) await query(`UPDATE fr_franchisees SET ${cols.map((k, i) => k + ' = $' + (i + 2)).join(', ')}, updated_at = NOW() WHERE id = $1`, [f0.id].concat(cols.map((k) => f[k])));
      if ('term_years' in f && f0.term_start && !(req.body || {}).keep_term_end) await query(`UPDATE fr_franchisees SET term_end = (term_start + (term_years || ' years')::interval)::date WHERE id = $1`, [f0.id]);
      await log({ franchisee_id: f0.id, action: 'details changed', detail: cols.join(', ') }, req);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  // Opening day (or marking a franchise expired at the end of its term).
  app.post('/api/franchise/franchisees/:id(\\d+)/status', ...M, async (req, res) => {
    try {
      const f = await frRow(req.params.id);
      const b = req.body || {};
      if (b.status === 'open') {
        if (!['onboarding', 'expired'].includes(f.status)) throw httpError(409, 'Only a franchise being set up can be opened');
        if (f.status === 'onboarding' && !f.signed_on && f.store_type !== 'company') throw httpError(409, (f.store_type === 'affiliate' ? 'The affiliate store agreement' : 'The franchise agreement') + ' must be signed before the shop opens');
        const day = d(b.opened_on) || today();
        await query(`UPDATE fr_franchisees SET status = 'open', opened_on = COALESCE(opened_on, $2), updated_at = NOW() WHERE id = $1`, [f.id, day]);
        await log({ franchisee_id: f.id, action: 'opened', detail: day }, req);
      } else if (b.status === 'expired') {
        if (!f.term_end || f.term_end > today()) throw httpError(409, 'The term has not ended yet');
        await query(`UPDATE fr_franchisees SET status = 'expired', ended_on = term_end, end_reason = 'Term ended without renewal', updated_at = NOW() WHERE id = $1`, [f.id]);
        if (f.territory_id) await query(`UPDATE fr_territories SET status = 'open' WHERE id = $1`, [f.territory_id]);
        await addTasks(f.id, EXIT_TASKS.map((x) => ['exit', x, 30]), today());
        await log({ franchisee_id: f.id, action: 'expired' }, req);
      } else throw httpError(400, 'Open or expired');
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  // The franchisee's own link: monthly sales report, statement, the manual. Shown once.
  app.post('/api/franchise/franchisees/:id(\\d+)/portal-link', ...M, async (req, res) => {
    try {
      const f = await frRow(req.params.id);
      const token = crypto.randomBytes(24).toString('base64url');
      await query(`UPDATE fr_franchisees SET portal_token_sha256 = $2 WHERE id = $1`, [f.id, (req.body || {}).revoke ? null : sha(token)]);
      await log({ franchisee_id: f.id, action: (req.body || {}).revoke ? 'franchisee link switched off' : 'franchisee link made (any earlier link stops working)' }, req);
      res.json({ ok: true, link: (req.body || {}).revoke ? null : TILL + '/franchisee.html?p=' + token });
    } catch (e) { fail(res, e); }
  });

  // --------------------------------------------------------------- tasks --
  app.post('/api/franchise/franchisees/:id(\\d+)/tasks', ...M, async (req, res) => {
    try {
      const f = await frRow(req.params.id);
      const b = req.body || {};
      const title = t(b.title, 300); if (!title) throw httpError(400, 'What needs doing?');
      const phase = Object.keys(PHASES).concat(['exit']).includes(b.phase) ? b.phase : 'setup';
      const { rows } = await query(`INSERT INTO fr_tasks (franchisee_id, phase, title, due_on, sort) VALUES ($1,$2,$3,$4,(SELECT COALESCE(MAX(sort), 0) + 10 FROM fr_tasks WHERE franchisee_id = $1)) RETURNING id`, [f.id, phase, title, d(b.due_on)]);
      res.json({ ok: true, id: rows[0].id });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/franchise/tasks/:id(\\d+)', ...M, async (req, res) => {
    try {
      const b = req.body || {};
      const { rows } = await query(`UPDATE fr_tasks SET done_at = CASE WHEN $2::boolean IS NULL THEN done_at WHEN $2 THEN COALESCE(done_at, NOW()) ELSE NULL END,
          done_by = CASE WHEN $2::boolean IS NULL THEN done_by WHEN $2 THEN $3 ELSE NULL END, note = CASE WHEN $4 THEN $5 ELSE note END, due_on = CASE WHEN $6 THEN $7::date ELSE due_on END
        WHERE id = $1 RETURNING franchisee_id, title, done_at`, [n(req.params.id), 'done' in b ? !!b.done : null, me(req), 'note' in b, t(b.note, 1000), 'due_on' in b, d(b.due_on)]);
      if (!rows.length) throw httpError(404, 'Task not found');
      if ('done' in b) await log({ franchisee_id: rows[0].franchisee_id, action: b.done ? 'checklist item done' : 'checklist item reopened', detail: rows[0].title }, req);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ----------------------------------------------------------- documents --
  app.post('/api/franchise/documents', ...M, async (req, res) => {
    try { res.json(Object.assign({ ok: true }, await makeDocument(req, req.body || {}))); } catch (e) { fail(res, e); }
  });
  app.get('/api/franchise/documents/:id(\\d+)', ...M, async (req, res) => {
    try { const x = await docRow(req.params.id); res.json({ document: docState(x) }); } catch (e) { fail(res, e); }
  });
  // The page itself (printable), with the signatures once signed. No scripts may run in it.
  app.get('/api/franchise/documents/:id(\\d+)/view', ...M, async (req, res) => {
    try {
      const x = await docRow(req.params.id);
      let witness = null;
      if (x.witnessed_by) witness = ((await query(`SELECT COALESCE(NULLIF(name, ''), email) AS n FROM users WHERE id = $1`, [x.witnessed_by])).rows[0] || {}).n;
      res.type('html').set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:").send(x.signed_at ? signedHtml(x, witness) : x.html);
    } catch (e) { fail(res, e); }
  });
  app.post('/api/franchise/documents/:id(\\d+)/send', ...M, async (req, res) => {
    try {
      const x = await docRow(req.params.id);
      if (!x.needs_signature) throw httpError(409, 'This document is not signed; file it instead');
      if (!['draft', 'sent'].includes(x.status)) throw httpError(409, 'This document is ' + x.status);
      const b = req.body || {}, s = await settings();
      const email = t(b.email, 200);
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw httpError(400, 'That email address does not look right');
      const days = Math.max(1, Math.min(60, parseInt(b.days, 10) || s.link_days));
      const token = crypto.randomBytes(24).toString('base64url');
      await query(`UPDATE fr_documents SET status = 'sent', token_sha256 = $2, sent_to = $3, sent_by = $4, sent_at = NOW(), expires_at = NOW() + ($5 || ' days')::interval WHERE id = $1`, [x.id, sha(token), email, me(req), String(days)]);
      const link = TILL + '/franchisee.html?s=' + token;
      let emailed = false;
      if (email && mailer && !devMode) {
        const ci = await companyInfo();
        try {
          await mailer.sendEmail({ to: email, subject: 'Please read and sign: ' + x.title + ' (' + ci.company + ')',
            text: 'Hello,\n\nPlease read and sign ' + x.title + ' (' + numberOf(x) + ') here:\n\n' + link + '\n\nThe link works once and expires in ' + days + ' days. Take advice from your own attorney before you sign. If you have questions, call us on ' + ci.company_phone + '.\n\n' + ci.company });
          emailed = true;
        } catch (e) { console.error('[franchise] send email', e.message); }
      }
      await log({ lead_id: x.lead_id, franchisee_id: x.franchisee_id, action: 'sent for signing', detail: x.title + ' ' + numberOf(x) + (email ? ' to ' + email : '') + (emailed ? ' (emailed)' : ' (link copied)') }, req);
      res.json({ ok: true, link, emailed, expires_in_days: days });
    } catch (e) { fail(res, e); }
  });
  // In person: they sign on this screen; whoever is signed in is the witness.
  app.post('/api/franchise/documents/:id(\\d+)/sign', ...M, async (req, res) => {
    try {
      const x = await docRow(req.params.id);
      const r = await saveSignature(req, x, { method: 'in_person', name: (req.body || {}).name, image: (req.body || {}).image, witness_id: me(req) });
      res.json({ ok: true, document: r.document });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/franchise/documents/:id(\\d+)/countersign', ...M, async (req, res) => {
    try {
      const x = await docRow(req.params.id);
      if (!COUNTER.has(x.kind)) throw httpError(409, 'Only the franchisee signs this document');
      if (x.status !== 'signed') throw httpError(409, x.status === 'countersigned' ? 'Already signed for the franchisor' : 'The other side signs first');
      if (!SECRET) throw httpError(503, 'Signing is not set up on this till (SESSION_SECRET is missing)');
      const name = String((req.body || {}).name || '').trim().slice(0, 100);
      if (name.length < 2) throw httpError(400, 'Type the name of the person signing for the franchisor');
      const row = Object.assign({}, x, { counter_name: name, counter_image: pngOf((req.body || {}).image), counter_by: me(req), counter_at: new Date() });
      row.counter_seal = counterSealOf(row);
      const { rowCount } = await query(`UPDATE fr_documents SET status = 'countersigned', counter_name = $2, counter_image = $3, counter_by = $4, counter_at = $5, counter_seal = $6 WHERE id = $1 AND status = 'signed'`,
        [x.id, name, row.counter_image, row.counter_by, row.counter_at, row.counter_seal]);
      if (!rowCount) throw httpError(409, 'Already signed for the franchisor');
      const filed = await fileCopy(req, await docRow(x.id), 'Signed by both sides');
      await log({ lead_id: x.lead_id, franchisee_id: x.franchisee_id, action: 'signed for the franchisor', detail: x.title + ' ' + numberOf(x) + ' by ' + name + (filed ? ', filed as ' + filed.number : '') }, req);
      res.json({ ok: true, document: filed });
    } catch (e) { fail(res, e); }
  });
  // Letters, checklists and forms that are not signed here: file them in the Document centre.
  app.post('/api/franchise/documents/:id(\\d+)/file', ...M, async (req, res) => {
    try {
      const x = await docRow(req.params.id);
      if (x.needs_signature) throw httpError(409, 'This document is signed; it is filed when it is signed');
      if (x.status !== 'draft') throw httpError(409, 'Already filed');
      const filed = await fileCopy(req, x, 'Made in the franchise module');
      await query(`UPDATE fr_documents SET status = 'filed' WHERE id = $1`, [x.id]);
      await log({ lead_id: x.lead_id, franchisee_id: x.franchisee_id, action: 'document filed', detail: x.title + ' ' + numberOf(x) + (filed ? ' as ' + filed.number : '') }, req);
      res.json({ ok: true, document: filed });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/franchise/documents/:id(\\d+)/cancel', ...M, async (req, res) => {
    try {
      const x = await docRow(req.params.id);
      const { rowCount } = await query(`UPDATE fr_documents SET status = 'cancelled', token_sha256 = NULL WHERE id = $1 AND status IN ('draft', 'sent')`, [x.id]);
      if (!rowCount) throw httpError(409, 'Only a document not yet signed can be cancelled');
      await log({ lead_id: x.lead_id, franchisee_id: x.franchisee_id, action: 'document cancelled', detail: x.title + ' ' + numberOf(x) }, req);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ============================================== sales reports and fees ==
  async function saveReport(f, b, source, userId) {
    const period = monthOf(b.period);
    if (!period) throw httpError(400, 'Which month (YYYY-MM)?');
    if (period > today().slice(0, 8) + '01') throw httpError(400, 'That month has not started yet');
    const gross = amt(b.gross_sales), refunds = amt(b.refunds) || 0, gct = amt(b.gct_collected) || 0;
    if (gross == null) throw httpError(400, 'Gross sales for the month (J$, including GCT)');
    const net = r2(gross - refunds - gct);
    if (net < 0) throw httpError(400, 'Refunds and GCT are more than the gross sales');
    const { rows: billed } = await query(`SELECT 1 FROM fr_charges WHERE franchisee_id = $1 AND kind IN ${MONTHLY} AND period = $2`, [f.id, period]);
    if (billed.length) throw httpError(409, monthName(period) + ' has already been invoiced. Ask the franchisor to correct it with a credit.');
    // The figures the store scorecard needs (all optional).
    const x = {};
    for (const k of ['diy_sales', 'commercial_sales', 'cogs', 'inventory_value', 'shrink', 'purchases_total']) x[k] = amt(b[k]);
    for (const k of ['loyalty_issued', 'loyalty_redeemed', 'loyalty_members', 'deliveries']) { const v = parseInt(b[k], 10); x[k] = Number.isFinite(v) && v >= 0 ? v : null; }
    { const v = Number(b.delivery_minutes); x.delivery_minutes = b.delivery_minutes != null && b.delivery_minutes !== '' && Number.isFinite(v) && v >= 0 ? r2(v) : null; }
    if (x.diy_sales != null && x.commercial_sales != null && Math.abs(x.diy_sales + x.commercial_sales - net) > Math.max(1, net * 0.02)) throw httpError(400, 'DIY and commercial sales should add up to the net sales (' + money(net) + ')');
    const xk = Object.keys(x);
    const { rows } = await query(`INSERT INTO fr_reports (franchisee_id, period, gross_sales, refunds, gct_collected, net_sales, transactions, local_marketing, notes, source, submitted_by, ${xk.join(', ')}, submitted_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,${xk.map((_, i) => '$' + (i + 12)).join(',')},NOW())
      ON CONFLICT (franchisee_id, period) DO UPDATE SET gross_sales = EXCLUDED.gross_sales, refunds = EXCLUDED.refunds, gct_collected = EXCLUDED.gct_collected, net_sales = EXCLUDED.net_sales,
        transactions = EXCLUDED.transactions, local_marketing = EXCLUDED.local_marketing, notes = EXCLUDED.notes, source = EXCLUDED.source, submitted_by = EXCLUDED.submitted_by,
        ${xk.map((k) => k + ' = EXCLUDED.' + k).join(', ')}, submitted_at = NOW() RETURNING id`,
      [f.id, period, gross, refunds, gct, net, n(b.transactions), amt(b.local_marketing), t(b.notes, 2000), source, userId || null].concat(xk.map((k) => x[k])));
    return { id: rows[0].id, period, net_sales: net };
  }
  app.post('/api/franchise/franchisees/:id(\\d+)/reports', ...M, async (req, res) => {
    try {
      const f = await frRow(req.params.id);
      const r = await saveReport(f, req.body || {}, 'staff', me(req));
      await log({ franchisee_id: f.id, action: 'sales report', detail: monthName(r.period) + ': net ' + money(r.net_sales) }, req);
      res.json(Object.assign({ ok: true }, r));
    } catch (e) { fail(res, e); }
  });
  async function accountFor(key) {
    const { rows } = await query(`SELECT id FROM gl_accounts WHERE system_key = $1 AND is_active`, [key]);
    if (!rows.length) throw httpError(409, 'No account is set up for ' + key.replace(/_/g, ' ') + ' (Accounting > Chart of accounts)');
    return rows[0].id;
  }
  // One A/R invoice for the charges, inside the caller's transaction.
  async function invoice(c, f, lines, o) {
    const s = await settings();
    const sub = r2(lines.reduce((x, l) => x + l.amount, 0));
    const gct = o.gct === false ? 0 : r2(sub * s.gct_rate / 100);
    const total = r2(sub + gct);
    const { rows } = await c.query(`INSERT INTO ar_invoices (kind, customer_id, invoice_date, due_date, memo, gct_amount, total, created_by) VALUES ('invoice',$1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [f.customer_id, today(), o.due || today(), o.memo, gct, total, o.userId || null]);
    const id = rows[0].id, number = 'INV-' + String(id).padStart(6, '0');
    await c.query(`UPDATE ar_invoices SET number = $2 WHERE id = $1`, [id, number]);
    for (const l of lines) await c.query(`INSERT INTO ar_invoice_lines (invoice_id, account_id, description, amount) VALUES ($1,$2,$3,$4)`, [id, l.account_id, l.description, l.amount]);
    return { id, number, total, gct, share: (a) => (sub ? r2(gct * a / sub) : 0) };
  }
  // The month's fees from the month's sales report.
  app.post('/api/franchise/franchisees/:id(\\d+)/bill', ...M, async (req, res) => {
    let c = null;
    try {
      const f = await frRow(req.params.id);
      if (!['open', 'suspended'].includes(f.status)) throw httpError(409, 'Only an open franchise is billed monthly');
      if (f.store_type === 'company') throw httpError(409, 'Company-owned stores are not billed fees');
      const period = monthOf((req.body || {}).period);
      if (!period) throw httpError(400, 'Which month (YYYY-MM)?');
      const { rows: rep } = await query(`SELECT id, net_sales::float AS net, loyalty_issued, loyalty_redeemed FROM fr_reports WHERE franchisee_id = $1 AND period = $2`, [f.id, period]);
      if (!rep.length) throw httpError(409, 'There is no sales report for ' + monthName(period) + ' yet');
      const s = await settings(), tr = terms(f, s), net = rep[0].net;
      if (!f.customer_id) f.customer_id = await ensureCustomer(f);
      // The minimum royalty applies from the 4th month after opening.
      const minFrom = f.opened_on ? addMonths(f.opened_on.slice(0, 8) + '01', 3) : null;
      let royalty = r2(net * tr.royalty_pct / 100), minNote = '';
      if (minFrom && period >= minFrom && royalty < tr.min_royalty) { royalty = r2(tr.min_royalty); minNote = ' (monthly minimum)'; }
      // Affiliates pay a membership fee instead of the royalty, and the network marketing rate.
      const affiliate = f.store_type === 'affiliate';
      const mktPct = affiliate && f.marketing_pct == null ? s.affiliate_marketing_pct : tr.marketing_pct;
      const mkt = r2(net * mktPct / 100), tech = r2(tr.tech_fee);
      const [inc, fund] = [await accountFor('franchise_income'), await accountFor('franchise_fund')];
      const parts = [
        affiliate ? { kind: 'member', amount: r2(tr.member_fee), base: null, rate: null, account_id: inc, description: 'Affiliate membership fee, ' + monthName(period) }
          : { kind: 'royalty', amount: royalty, base: net, rate: tr.royalty_pct, account_id: inc, description: 'Royalty ' + tr.royalty_pct + '% of net sales ' + money(net) + ', ' + monthName(period) + minNote },
        { kind: 'marketing', amount: mkt, base: net, rate: mktPct, account_id: fund, description: (affiliate ? 'Network marketing ' : 'Brand marketing fund ') + mktPct + '% of net sales, ' + monthName(period) },
        { kind: 'tech', amount: tech, base: null, rate: null, account_id: inc, description: 'Technology and system fee, ' + monthName(period) },
      ].filter((p) => p.amount > 0);
      // Loyalty: the store pays into the network fund for the points it gave, and is paid back for the points redeemed with it.
      const pv = s.loyalty_point_value, issued = Number(rep[0].loyalty_issued || 0), redeemed = Number(rep[0].loyalty_redeemed || 0);
      if (issued > 0 && pv > 0) parts.push({ kind: 'loyalty', amount: r2(issued * pv), base: issued, rate: pv, account_id: await accountFor('franchise_loyalty'), description: 'Loyalty points given: ' + issued.toLocaleString('en-JM') + ' at ' + money(pv) + ', ' + monthName(period) });
      if (!parts.length) throw httpError(409, 'Nothing to bill for ' + monthName(period));
      const next = addMonths(period, 1);
      const due = next.slice(0, 8) + String(Math.min(28, s.royalty_due_day)).padStart(2, '0');
      c = await getPool().connect();
      await c.query('BEGIN');
      const inv = await invoice(c, f, parts, { due, memo: 'Franchise fees for ' + monthName(period) + ' - ' + (f.trading_name || f.legal_name) + ' (' + f.number + ')', userId: me(req) });
      for (const p of parts) await c.query(`INSERT INTO fr_charges (franchisee_id, kind, period, description, base, rate, amount, gct, ar_invoice_id, report_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [f.id, p.kind, period, p.description, p.base, p.rate, p.amount, inv.share(p.amount), inv.id, rep[0].id, me(req)]);
      let credit = null;
      if (redeemed > 0 && pv > 0) {
        const { rows: cr } = await c.query(`INSERT INTO fr_credits (franchisee_id, kind, period, description, amount, created_by) VALUES ($1,'loyalty',$2,$3,$4,$5) RETURNING id, amount::float AS amount`,
          [f.id, period.slice(0, 7), 'Loyalty points redeemed at the store: ' + redeemed.toLocaleString('en-JM') + ' at ' + money(pv) + ', ' + monthName(period), r2(redeemed * pv), me(req)]);
        credit = cr[0];
      }
      await c.query('COMMIT');
      await log({ franchisee_id: f.id, action: 'invoiced', detail: monthName(period) + ': ' + inv.number + ' ' + money(inv.total) }, req);
      res.json({ ok: true, invoice: { id: inv.id, number: inv.number, total: inv.total, gct: inv.gct, due }, lines: parts.map((p) => ({ kind: p.kind, amount: p.amount, description: p.description })), loyalty_credit: credit });
    } catch (e) {
      if (c) await c.query('ROLLBACK').catch(() => {});
      if (e.code === '23505') e = httpError(409, 'That month has already been invoiced');
      fail(res, e);
    } finally { if (c) c.release(); }
  });
  // A one-off charge: initial fee, renewal, transfer, extra training, re-audit, late fee.
  app.post('/api/franchise/franchisees/:id(\\d+)/charge', ...M, async (req, res) => {
    let c = null;
    try {
      const f = await frRow(req.params.id);
      const b = req.body || {}, s = await settings(), tr = terms(f, s);
      const kind = ONE_OFF.includes(b.kind) ? b.kind : null;
      if (!kind) throw httpError(400, 'What is the charge for?');
      const amount = amt(b.amount) || ({ initial: tr.initial_fee, renewal: tr.renewal_fee, transfer: tr.transfer_fee }[kind]) || null;
      if (!(amount > 0)) throw httpError(400, 'The amount (J$, before GCT)');
      if (kind === 'initial') { const { rows } = await query(`SELECT 1 FROM fr_charges WHERE franchisee_id = $1 AND kind = 'initial'`, [f.id]); if (rows.length && !b.again) throw httpError(409, 'The initial fee has already been invoiced'); }
      if (!f.customer_id) f.customer_id = await ensureCustomer(f);
      const description = t(b.description, 200) || CHARGE_LABEL[kind] + ' - ' + (f.trading_name || f.legal_name);
      const line = { amount, account_id: await accountFor('franchise_income'), description };
      c = await getPool().connect();
      await c.query('BEGIN');
      const inv = await invoice(c, f, [line], { due: d(b.due_date) || addDays(today(), 14), memo: description + ' (' + f.number + ')', gct: b.gct !== false, userId: me(req) });
      await c.query(`INSERT INTO fr_charges (franchisee_id, kind, description, amount, gct, ar_invoice_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [f.id, kind, description, amount, inv.gct, inv.id, me(req)]);
      await c.query('COMMIT');
      if (kind === 'initial') await query(`UPDATE fr_tasks SET note = COALESCE(note, 'Invoiced on ' || $2) WHERE franchisee_id = $1 AND title = 'Initial franchise fee paid'`, [f.id, inv.number]);
      await log({ franchisee_id: f.id, action: 'invoiced', detail: description + ': ' + inv.number + ' ' + money(inv.total) }, req);
      res.json({ ok: true, invoice: { id: inv.id, number: inv.number, total: inv.total, gct: inv.gct } });
    } catch (e) { if (c) await c.query('ROLLBACK').catch(() => {}); fail(res, e); } finally { if (c) c.release(); }
  });
  // Every invoice on their account, what was paid and what is owed.
  async function statement(f) {
    if (!f.customer_id) return { invoices: [], billed: 0, paid: 0, balance: 0, overdue: 0 };
    const { rows } = await query(`SELECT i.id, i.number, ${DATE('i.invoice_date')} AS invoice_date, ${DATE('i.due_date')} AS due_date, i.memo, i.total::float AS total, i.gct_amount::float AS gct,
        ${PAID('i.id')}::float AS paid, i.voided_at FROM ar_invoices i WHERE i.customer_id = $1 ORDER BY i.invoice_date DESC, i.id DESC LIMIT 200`, [f.customer_id]);
    const live = rows.filter((r) => !r.voided_at);
    const sum = (a, k) => r2(a.reduce((x, r) => x + Number(r[k] || 0), 0));
    const open = live.filter((r) => r.total - r.paid > 0.004);
    return { invoices: rows.map((r) => Object.assign(r, { balance: r2(r.total - r.paid) })), billed: sum(live, 'total'), paid: sum(live, 'paid'),
      balance: r2(sum(live, 'total') - sum(live, 'paid')), overdue: r2(open.filter((r) => r.due_date < today()).reduce((x, r) => x + r.total - r.paid, 0)) };
  }
  app.get('/api/franchise/franchisees/:id(\\d+)/statement', ...M, async (req, res) => {
    try { const f = await frRow(req.params.id); res.json(Object.assign({ franchisee: { id: f.id, number: f.number, legal_name: f.legal_name, trading_name: f.trading_name, customer_id: f.customer_id } }, await statement(f))); } catch (e) { fail(res, e); }
  });

  // ========================================================= performance ==
  app.get('/api/franchise/performance', ...M, async (req, res) => {
    try {
      const months = Math.max(1, Math.min(36, parseInt(req.query.months, 10) || 12));
      const end = today().slice(0, 8) + '01';
      const from = addMonths(end, -months), prevFrom = addMonths(end, -2 * months);
      const { rows } = await query(`SELECT f.id, f.number, COALESCE(f.trading_name, f.legal_name) AS name, f.status, t.name AS territory_name, ${DATE('f.opened_on')} AS opened_on,
          COALESCE((SELECT SUM(net_sales) FROM fr_reports r WHERE r.franchisee_id = f.id AND r.period >= $1 AND r.period < $2), 0)::float AS net_sales,
          COALESCE((SELECT SUM(net_sales) FROM fr_reports r WHERE r.franchisee_id = f.id AND r.period >= $3 AND r.period < $1), 0)::float AS prev_sales,
          (SELECT COUNT(*)::int FROM fr_reports r WHERE r.franchisee_id = f.id AND r.period >= $1 AND r.period < $2) AS reports,
          (SELECT COUNT(*)::int FROM fr_reports r WHERE r.franchisee_id = f.id AND r.period >= $1 AND r.period < $2 AND r.submitted_at > (r.period + interval '1 month' + ($4 || ' days')::interval)) AS late_reports,
          COALESCE((SELECT SUM(amount) FROM fr_charges c WHERE c.franchisee_id = f.id AND c.kind = 'royalty' AND c.period >= $1 AND c.period < $2), 0)::float AS royalty,
          COALESCE((SELECT SUM(amount) FROM fr_charges c WHERE c.franchisee_id = f.id AND c.kind = 'marketing' AND c.period >= $1 AND c.period < $2), 0)::float AS fund,
          COALESCE((SELECT SUM(i.total - ${PAID('i.id')}) FROM ar_invoices i WHERE i.voided_at IS NULL AND i.customer_id = f.customer_id), 0)::float AS balance,
          COALESCE((SELECT SUM(i.total - ${PAID('i.id')}) FROM ar_invoices i WHERE i.voided_at IS NULL AND i.customer_id = f.customer_id AND i.due_date < CURRENT_DATE), 0)::float AS overdue,
          (SELECT score_pct::float FROM fr_audits a WHERE a.franchisee_id = f.id ORDER BY audit_date DESC, id DESC LIMIT 1) AS last_audit,
          (SELECT result FROM fr_audits a WHERE a.franchisee_id = f.id ORDER BY audit_date DESC, id DESC LIMIT 1) AS last_result,
          (SELECT AVG(score_pct)::float FROM fr_audits a WHERE a.franchisee_id = f.id AND a.audit_date >= $1) AS avg_audit,
          (SELECT COUNT(*)::int FROM fr_actions a WHERE a.franchisee_id = f.id AND a.kind = 'default' AND a.status = 'open') AS open_defaults
        FROM fr_franchisees f LEFT JOIN fr_territories t ON t.id = f.territory_id WHERE f.status IN ('open', 'suspended') OR f.opened_on IS NOT NULL ORDER BY 7 DESC`,
        [from, end, prevFrom, String((await settings()).report_day)]);
      const { rows: series } = await query(`SELECT ${DATE('period')} AS period, SUM(net_sales)::float AS net_sales, COUNT(*)::int AS reports FROM fr_reports WHERE period >= $1 AND period < $2 GROUP BY period ORDER BY period`, [from, end]);
      const out = rows.map((r) => Object.assign(r, { growth_pct: r.prev_sales > 0 ? Math.round((r.net_sales - r.prev_sales) / r.prev_sales * 1000) / 10 : null,
        avg_month: r.reports ? r2(r.net_sales / r.reports) : 0 }));
      const net = r2(out.reduce((x, r) => x + r.net_sales, 0));
      out.forEach((r) => { r.share_pct = net ? Math.round(r.net_sales / net * 1000) / 10 : 0; });
      res.json({ from, to: end, months, franchisees: out, series, totals: { net_sales: net, royalty: r2(out.reduce((x, r) => x + r.royalty, 0)), fund: r2(out.reduce((x, r) => x + r.fund, 0)), balance: r2(out.reduce((x, r) => x + r.balance, 0)) } });
    } catch (e) { fail(res, e); }
  });

  // ============================================================== audits ==
  async function auditScore(items) {
    const s = await settings();
    const scored = items.filter((i) => i.score === 0 || i.score === 1 || i.score === 2);
    if (!scored.length) throw httpError(400, 'Score at least one item');
    const pct = Math.round(scored.reduce((x, i) => x + i.score, 0) / (scored.length * 2) * 1000) / 10;
    return { pct, result: pct >= s.pass_pct ? 'pass' : pct >= s.conditional_pct ? 'conditional' : 'fail' };
  }
  app.get('/api/franchise/audits', ...M, async (req, res) => {
    try {
      const args = [], where = [];
      if (n(req.query.franchisee_id)) { args.push(n(req.query.franchisee_id)); where.push(`a.franchisee_id = $1`); }
      const { rows } = await query(`SELECT a.id, a.franchisee_id, a.kind, ${DATE('a.audit_date')} AS audit_date, a.score_pct::float AS score_pct, a.result, ${DATE('a.follow_up_on')} AS follow_up_on, a.closed_at,
          COALESCE(f.trading_name, f.legal_name) AS name, f.number, COALESCE(NULLIF(u.name, ''), u.email) AS auditor
        FROM fr_audits a JOIN fr_franchisees f ON f.id = a.franchisee_id LEFT JOIN users u ON u.id = a.auditor_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.audit_date DESC, a.id DESC LIMIT 500`, args);
      res.json({ audits: rows });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/franchise/audits/:id(\\d+)', ...M, async (req, res) => {
    try {
      const { rows } = await query(`SELECT a.*, ${DATE('a.audit_date')} AS audit_date, ${DATE('a.follow_up_on')} AS follow_up_on, COALESCE(f.trading_name, f.legal_name) AS name, f.number,
          COALESCE(NULLIF(u.name, ''), u.email) AS auditor FROM fr_audits a JOIN fr_franchisees f ON f.id = a.franchisee_id LEFT JOIN users u ON u.id = a.auditor_id WHERE a.id = $1`, [n(req.params.id)]);
      if (!rows.length) throw httpError(404, 'Audit not found');
      res.json({ audit: rows[0] });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/franchise/audits', ...M, async (req, res) => {
    try {
      const b = req.body || {};
      const f = await frRow(b.franchisee_id);
      const day = d(b.audit_date) || today();
      const items = (Array.isArray(b.items) ? b.items : []).slice(0, 200).map((i) => ({ section: t(i.section, 100) || 'Other', item: t(i.item, 300) || '', note: t(i.note, 1000),
        score: i.score === '' || i.score == null ? null : [0, 1, 2].includes(Number(i.score)) ? Number(i.score) : null })).filter((i) => i.item);
      const sc = await auditScore(items);
      const s = await settings();
      const follow = d(b.follow_up_on) || (sc.result === 'pass' ? null : addDays(day, 30));
      const { rows } = await query(`INSERT INTO fr_audits (franchisee_id, kind, audit_date, auditor_id, items, score_pct, result, findings, actions, follow_up_on) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [f.id, AUDIT_KINDS.includes(b.kind) ? b.kind : 'routine', day, n(b.auditor_id) || me(req), JSON.stringify(items), sc.pct, sc.result, t(b.findings, 4000), t(b.actions, 4000), follow]);
      if (b.kind === 'pre_opening' && sc.result === 'pass') await query(`UPDATE fr_tasks SET done_at = NOW(), done_by = $2 WHERE franchisee_id = $1 AND done_at IS NULL AND title = 'Pre-opening audit passed'`, [f.id, me(req)]);
      // Two failed audits in 12 months are a ground for termination (agreement section 13).
      const { rows: fails } = await query(`SELECT COUNT(*)::int AS c FROM fr_audits WHERE franchisee_id = $1 AND result = 'fail' AND audit_date > $2::date - 365`, [f.id, day]);
      await log({ franchisee_id: f.id, action: 'audit', detail: day + ': ' + sc.pct + '% (' + sc.result + ')' }, req);
      res.json({ ok: true, id: rows[0].id, score_pct: sc.pct, result: sc.result, follow_up_on: follow, fails_12m: fails[0].c, pass_pct: s.pass_pct });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/franchise/audits/:id(\\d+)/close', ...M, async (req, res) => {
    try {
      const { rows } = await query(`UPDATE fr_audits SET closed_at = NOW(), actions = COALESCE($2, actions) WHERE id = $1 AND closed_at IS NULL RETURNING franchisee_id`, [n(req.params.id), t((req.body || {}).note, 4000)]);
      if (!rows.length) throw httpError(409, 'Already closed');
      await log({ franchisee_id: rows[0].franchisee_id, action: 'audit actions closed' }, req);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ============================== renewals, transfers, defaults, endings ==
  app.post('/api/franchise/franchisees/:id(\\d+)/actions', ...M, async (req, res) => {
    try {
      const f = await frRow(req.params.id);
      const b = req.body || {};
      const kind = ACTION_KINDS.includes(b.kind) ? b.kind : null;
      if (!kind) throw httpError(400, 'Renewal, transfer, default, suspension or termination');
      if (['terminated', 'transferred'].includes(f.status)) throw httpError(409, 'This franchise has ended');
      const { rows: dup } = await query(`SELECT 1 FROM fr_actions WHERE franchisee_id = $1 AND kind = $2 AND status = 'open'`, [f.id, kind]);
      if (dup.length) throw httpError(409, 'There is already an open ' + kind + ' for this franchisee');
      const x = b.details || {}, details = {};
      let eff = d(b.effective_date), cure = d(b.cure_by);
      if (kind === 'renewal') { const y = parseInt(x.new_term_years, 10); if (!(y >= 1 && y <= 30)) throw httpError(400, 'Renewal term: 1 to 30 years'); details.new_term_years = y; details.conditions = t(x.conditions, 2000); }
      if (kind === 'transfer') {
        details.buyer_name = t(x.buyer_name, 200); if (!details.buyer_name) throw httpError(400, 'Who is buying?');
        Object.assign(details, { buyer_principal: t(x.buyer_principal, 200), buyer_email: t(x.buyer_email, 200), buyer_phone: t(x.buyer_phone, 60), buyer_trn: t(x.buyer_trn, 30), price: amt(x.price), conditions: t(x.conditions, 2000) });
        if (!eff) throw httpError(400, 'The transfer date');
      }
      if (kind === 'default') {
        details.breach = t(x.breach, 2000); details.remedy = t(x.remedy, 2000); details.clause = t(x.clause, 40);
        if (!details.breach || !details.remedy) throw httpError(400, 'What is wrong and what must be done');
        if (!cure) throw httpError(400, 'The date it must be put right by');
      }
      if (kind === 'suspension' || kind === 'termination') { details.reason = t(x.reason, 2000); if (!details.reason) throw httpError(400, 'The reason'); }
      if (kind === 'termination' && !eff) throw httpError(400, 'The date the termination takes effect');
      if (kind === 'suspension') { if (f.status !== 'open') throw httpError(409, 'Only an open franchise can be suspended'); eff = eff || today(); }
      const { rows } = await query(`INSERT INTO fr_actions (franchisee_id, kind, effective_date, cure_by, details, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [f.id, kind, eff, cure, JSON.stringify(details), me(req)]);
      if (kind === 'suspension') await query(`UPDATE fr_franchisees SET status = 'suspended', updated_at = NOW() WHERE id = $1`, [f.id]);
      await log({ franchisee_id: f.id, action: kind + ' opened', detail: details.reason || details.breach || details.buyer_name || (details.new_term_years ? details.new_term_years + ' years' : '') }, req);
      res.json({ ok: true, id: rows[0].id });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/franchise/actions/:id(\\d+)/close', ...M, async (req, res) => {
    let c = null;
    try {
      const { rows } = await query(`SELECT *, ${DATE('effective_date')} AS effective_date FROM fr_actions WHERE id = $1`, [n(req.params.id)]);
      const a = rows[0]; if (!a) throw httpError(404, 'Not found');
      if (a.status !== 'open') throw httpError(409, 'Already closed');
      const b = req.body || {};
      const status = ['done', 'cured', 'cancelled'].includes(b.status) ? b.status : null;
      if (!status) throw httpError(400, 'Done, put right or cancelled');
      if (status === 'cured' && a.kind !== 'default') throw httpError(400, 'Only a notice of default is put right');
      const f = await frRow(a.franchisee_id);
      const x = a.details || {};
      let out = {};
      c = await getPool().connect();
      await c.query('BEGIN');
      if (status === 'done' && a.kind === 'renewal') {
        if (!f.term_end) throw httpError(409, 'The franchise has no term end date yet');
        await c.query(`UPDATE fr_franchisees SET term_end = (term_end + ($2 || ' years')::interval)::date, term_years = COALESCE(term_years, 0) + $2::int,
            status = CASE WHEN status = 'expired' THEN 'open' ELSE status END, ended_on = NULL, end_reason = NULL, updated_at = NOW() WHERE id = $1`, [f.id, String(x.new_term_years)]);
      }
      if (status === 'done' && a.kind === 'transfer') {
        const s = await settings();
        const nb = { legal_name: x.buyer_name, trading_name: f.trading_name, principal: x.buyer_principal || x.buyer_name, email: x.buyer_email, phone: x.buyer_phone, trn: x.buyer_trn, address: f.address,
          territory_id: f.territory_id, term_years: f.term_years, initial_fee: 0 };
        for (const k of ['royalty_pct', 'marketing_pct', 'tech_fee', 'min_royalty', 'renewal_fee', 'transfer_fee']) nb[k] = f[k];
        const v = frInput(nb, s, false);
        const cols = Object.keys(v);
        const { rows: ins } = await c.query(`INSERT INTO fr_franchisees (${cols.join(', ')}, status, signed_on, opened_on, term_start, term_end, created_by)
          VALUES (${cols.map((_, i) => '$' + (i + 1)).join(', ')}, $${cols.length + 1}, $${cols.length + 2}, $${cols.length + 3}, $${cols.length + 4}, $${cols.length + 5}, $${cols.length + 6}) RETURNING id`,
          cols.map((k) => v[k]).concat([f.status === 'onboarding' ? 'onboarding' : 'open', a.effective_date, f.opened_on, a.effective_date, f.term_end, me(req)]));
        const nid = ins[0].id;
        await c.query(`UPDATE fr_franchisees SET number = 'FR-' || lpad(id::text, 3, '0') WHERE id = $1`, [nid]);
        await ensureCustomer(Object.assign({ id: nid }, v), (sql, args) => c.query(sql, args));
        await addTasks(nid, ONBOARDING.filter((o) => o[0] === 'training').concat([['setup', 'Buyer signed the current franchise agreement', 0], ['setup', 'Seller signed the general release', 0]]), today(), (sql, args) => c.query(sql, args));
        await c.query(`UPDATE fr_franchisees SET status = 'transferred', transferred_to_id = $2, ended_on = $3, end_reason = 'Transferred to ' || $4, updated_at = NOW() WHERE id = $1`, [f.id, nid, a.effective_date, x.buyer_name]);
        out.new_franchisee_id = nid;
      }
      if (a.kind === 'suspension') {   // lifted, or withdrawn: either way the shop trades again
        await c.query(`UPDATE fr_franchisees SET status = 'open', updated_at = NOW() WHERE id = $1 AND status = 'suspended'`, [f.id]);
      }
      if (status === 'done' && a.kind === 'termination') {
        await c.query(`UPDATE fr_franchisees SET status = 'terminated', ended_on = $2, end_reason = $3, portal_token_sha256 = NULL, updated_at = NOW() WHERE id = $1`, [f.id, a.effective_date, x.reason]);
        if (f.territory_id) await c.query(`UPDATE fr_territories SET status = 'open' WHERE id = $1`, [f.territory_id]);
        await addTasks(f.id, EXIT_TASKS.map((e) => ['exit', e, 30]), a.effective_date, (sql, args) => c.query(sql, args));
        await c.query(`UPDATE fr_actions SET status = 'cancelled', closed_at = NOW(), closed_by = $2, close_note = 'Franchise terminated' WHERE franchisee_id = $1 AND status = 'open' AND id <> $3`, [f.id, me(req), a.id]);
      }
      await c.query(`UPDATE fr_actions SET status = $2, closed_by = $3, closed_at = NOW(), close_note = $4 WHERE id = $1`, [a.id, status, me(req), t(b.note, 2000)]);
      await c.query('COMMIT');
      await log({ franchisee_id: f.id, action: a.kind + ' ' + (status === 'done' ? 'completed' : status === 'cured' ? 'put right' : 'cancelled'), detail: t(b.note, 300) }, req);
      if (out.new_franchisee_id) await log({ franchisee_id: out.new_franchisee_id, action: 'franchisee created', detail: 'By transfer from ' + f.number + ' ' + f.legal_name }, req);
      res.json(Object.assign({ ok: true }, out));
    } catch (e) { if (c) await c.query('ROLLBACK').catch(() => {}); fail(res, e); } finally { if (c) c.release(); }
  });

  // ============================================ public: no sign-in needed ==
  const tries = new Map();
  function limited(req, max) {
    const k = ipOf(req) + '|' + max, now = Date.now(), list = (tries.get(k) || []).filter((x) => now - x < 600000);
    list.push(now); tries.set(k, list);
    if (tries.size > 5000) tries.clear();
    return list.length > max;
  }
  const noStore = (res) => res.set('Cache-Control', 'no-store');
  async function byToken(req) {
    if (limited(req, 40)) throw httpError(429, 'Too many tries. Wait a few minutes.');
    const tok = String(req.params.token || '');
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(tok)) throw httpError(404, 'This link is not valid');
    const { rows } = await query(`SELECT * FROM fr_documents WHERE token_sha256 = $1`, [sha(tok)]);
    const x = rows[0];
    if (!x) throw httpError(404, 'This link is not valid');
    if (['signed', 'countersigned'].includes(x.status)) throw httpError(410, 'This document has already been signed. Thank you.');
    if (x.status !== 'sent' || !x.expires_at || new Date(x.expires_at) <= new Date()) throw httpError(410, 'This link has expired or was cancelled. Please ask us for a new one.');
    return x;
  }
  app.get('/api/public/franchise-sign/:token', async (req, res) => {
    noStore(res);
    try {
      const x = await byToken(req);
      if (!x.viewed_at) await query(`UPDATE fr_documents SET viewed_at = NOW() WHERE id = $1`, [x.id]);
      let notYet = null;
      if (x.kind === 'agreement' || x.kind === 'affiliate') { try { await agreementReady(x); } catch (e) { notYet = e.message; } }
      res.json({ title: x.title, number: numberOf(x), html: x.html, company: await companyInfo(), not_yet: notYet });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/public/franchise-sign/:token', async (req, res) => {
    noStore(res);
    try {
      const b = req.body || {};
      const x = await byToken(req);
      if (b.decline === true) {
        await query(`UPDATE fr_documents SET status = 'declined', decline_reason = $2, token_sha256 = NULL WHERE id = $1 AND status = 'sent'`, [x.id, t(b.reason, 1000)]);
        await log({ lead_id: x.lead_id, franchisee_id: x.franchisee_id, action: 'declined to sign', detail: x.title + ' ' + numberOf(x) + (b.reason ? ': ' + t(b.reason, 300) : '') }, req);
        return res.json({ ok: true, declined: true });
      }
      if (b.agree !== true) throw httpError(400, 'Tick the box to confirm you have read it');
      await saveSignature(req, x, { method: 'link', name: b.name, image: b.image, email: x.sent_to });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  // The franchise enquiry form (franchisee.html with no link).
  app.post('/api/public/franchise-enquiry', async (req, res) => {
    noStore(res);
    try {
      if (limited(req, 5)) throw httpError(429, 'Thank you. We already have your enquiry; we will be in touch.');
      const b = req.body || {};
      if (b.website) return res.json({ ok: true });   // a robot filled the hidden box
      if (b.consent !== true) throw httpError(400, 'Tick the box to let us contact you about your enquiry');
      const l = leadInput({ name: b.name, company: b.company, email: b.email, phone: b.phone, parish: b.parish, area_wanted: b.area_wanted, capital: b.capital, net_worth: b.net_worth,
        experience: b.experience, timeline: b.timeline, message: b.message, source: 'website', programme: b.programme, current_store: b.current_store }, false);
      const cols = Object.keys(l);
      const { rows } = await query(`INSERT INTO fr_leads (${cols.join(', ')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(', ')}) RETURNING id`, cols.map((k) => l[k]));
      await log({ lead_id: rows[0].id, action: 'enquiry from the website', detail: l.name + (l.area_wanted ? ' - ' + l.area_wanted : '') }, req);
      // Staff owners and managers only: customer accounts can carry admin_role too.
      if (deps.notice) {
        const { rows: mgr } = await query(`SELECT id FROM users WHERE (COALESCE(is_admin, false) OR COALESCE(is_staff, false)) AND admin_role IN ('owner', 'manager') AND NOT COALESCE(disabled, false) LIMIT 50`).catch(() => ({ rows: [] }));
        if (mgr.length) deps.notice(mgr.map((m) => m.id), { kind: 'memo', title: (l.programme === 'affiliate' ? '🏪 New affiliate store enquiry: ' : '🏪 New franchise enquiry: ') + l.name, body: (l.area_wanted || '') + (l.phone ? ' · ' + l.phone : ''), link: '/franchise.html#lead=' + rows[0].id }).catch(() => {});
      }
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  // The franchisee's own page.
  async function byPortal(req) {
    if (limited(req, 60)) throw httpError(429, 'Too many tries. Wait a few minutes.');
    const tok = String(req.params.token || '');
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(tok)) throw httpError(404, 'This link is not valid');
    const { rows } = await query(`SELECT id FROM fr_franchisees WHERE portal_token_sha256 = $1 AND status IN ('onboarding', 'open', 'suspended')`, [sha(tok)]);
    if (!rows.length) throw httpError(404, 'This link is not valid or has been switched off. Ask the franchise office for a new one.');
    return frRow(rows[0].id);
  }
  app.get('/api/public/franchisee/:token', async (req, res) => {
    noStore(res);
    try {
      const f = await byPortal(req);
      const s = await settings();
      const [reps, audits, man, tasks] = await Promise.all([
        query(`SELECT ${DATE('period')} AS period, gross_sales::float AS gross_sales, refunds::float AS refunds, gct_collected::float AS gct_collected, net_sales::float AS net_sales, transactions, submitted_at, ${REPORT_EXTRA('r')},
            EXISTS (SELECT 1 FROM fr_charges c WHERE c.franchisee_id = r.franchisee_id AND c.kind IN ${MONTHLY} AND c.period = r.period) AS billed FROM fr_reports r WHERE franchisee_id = $1 ORDER BY period DESC LIMIT 24`, [f.id]),
        query(`SELECT ${DATE('audit_date')} AS audit_date, kind, score_pct::float AS score_pct, result, findings, actions, ${DATE('follow_up_on')} AS follow_up_on FROM fr_audits WHERE franchisee_id = $1 ORDER BY audit_date DESC LIMIT 10`, [f.id]),
        query(`SELECT id FROM fr_documents WHERE franchisee_id = $1 AND kind = 'manual' AND status IN ('signed', 'countersigned', 'sent', 'draft') ORDER BY id DESC LIMIT 1`, [f.id]),
        query(`SELECT phase, title, ${DATE('due_on')} AS due_on, done_at FROM fr_tasks WHERE franchisee_id = $1 ORDER BY sort, id`, [f.id])]);
      const st = await statement(f);
      res.json({ franchisee: { number: f.number, legal_name: f.legal_name, trading_name: f.trading_name, status: f.status, territory: f.territory_name, opened_on: f.opened_on, term_end: f.term_end },
        terms: Object.assign(terms(f, s), { report_day: s.report_day, royalty_due_day: s.royalty_due_day, gct_rate: s.gct_rate }), company: await companyInfo(),
        reports: reps.rows, audits: audits.rows, statement: { billed: st.billed, paid: st.paid, balance: st.balance, overdue: st.overdue, invoices: st.invoices.filter((i) => !i.voided_at).slice(0, 36).map((i) => ({ number: i.number, invoice_date: i.invoice_date, due_date: i.due_date, memo: i.memo, total: i.total, paid: i.paid, balance: i.balance })) },
        manual: man.rows.length ? (await docRow(man.rows[0].id)).html : null, tasks: f.status === 'onboarding' ? tasks.rows : [], phases: PHASES,
        store: { store_type: f.store_type, store_type_label: STORE_TYPES[f.store_type], format: f.format_name, role: f.network_role, dc: f.dc_name, hub: f.hub_name },
        network: await net.portal(f) });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/public/franchisee/:token/report', async (req, res) => {
    noStore(res);
    try {
      const f = await byPortal(req);
      const r = await saveReport(f, req.body || {}, 'portal', null);
      await log({ franchisee_id: f.id, action: 'sales report (from their link)', detail: monthName(r.period) + ': net ' + money(r.net_sales) }, req);
      res.json(Object.assign({ ok: true }, r));
    } catch (e) { fail(res, e); }
  });

  const net = require('./franchise-network').register(app, deps, { M, me, fail, httpError, t, d, n, r2, amt, money, today, addDays, addMonths, monthOf, monthName, DATE, PAID,
    settings, frRow, terms, log, invoice, accountFor, ensureCustomer, byPortal, noStore, limited, STORE_TYPES, SYSTEMS });

  return { ensureTemplates };
}

module.exports = { register, STAGES, DEFAULTS, MONTHLY };
