// =============================================================================
//  Morty's Auto Parts -- Trade account applications (scaling roadmap, Phase 2)
//
//  Mounted by server.js:
//    require('./trade-apply').register(app, { query, requireAdmin, requireCap, notify, nextAccountNumber, bcrypt })
//  Pages: trade-apply.html (public, no sign-in: the application form) and the
//  "Applications" tab of trade-accounts.html (staff).
//
//  A garage, fleet or dealer applies online in two minutes: business, contact,
//  TRN, what they expect to spend, whether they want credit, two trade
//  references. Staff see the queue, check references, and approve with a
//  price tier, a credit limit and terms (or cash only), or decline with a
//  reason. Approving opens the customer account, or updates the one that
//  already has that email or phone, and can tell the applicant by email/SMS.
//
//  Routes:
//    POST /api/public/trade-apply              the form (rate limited, honeypot)
//    GET  /api/trade/applications?status=      staff list   (planning.view)
//    POST /api/trade/applications/:id/approve  (ar.manage: sets credit)
//    POST /api/trade/applications/:id/decline  (ar.manage)
// =============================================================================
'use strict';

const TYPES = ['garage', 'fleet', 'dealer', 'body_shop', 'other'];
const TIERS = ['retail', 'trade', 'fleet', 'dealer'];
const PARISHES = ['Kingston', 'St. Andrew', 'St. Catherine', 'Clarendon', 'Manchester', 'St. Elizabeth', 'Westmoreland', 'Hanover',
  'St. James', 'Trelawny', 'St. Ann', 'St. Mary', 'Portland', 'St. Thomas'];

function register(app, deps) {
  const { query, requireAdmin, requireCap, notify, nextAccountNumber, bcrypt } = deps;
  const can = (k) => [requireAdmin, requireCap(k)];
  function httpError(status, msg) { const e = new Error(msg); e.status = status; e.publicMessage = msg; return e; }
  function fail(res, e) { const s = e.status || 500; if (s >= 500) console.error('[trade-apply]', e); res.status(s).json({ error: e.publicMessage || e.message }); }
  const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n || 200);
  const digits = (p) => String(p || '').replace(/\D/g, '');
  const okPhone = (p) => { const d = digits(p); return d.length === 7 || d.length === 10 || (d.length === 11 && d[0] === '1'); };
  const okEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
  const uid = (req) => (req.user && req.user.id) || (req.session && req.session.userId) || null;

  // Created on first use, not at startup: DDL during the boot-time schema.sql
  // apply can deadlock it (it did on 2026-11-05).
  let readyP = null;
  const ready = () => readyP || (readyP = query(
    `CREATE TABLE IF NOT EXISTS trade_applications (
       id               SERIAL PRIMARY KEY,
       business_name    TEXT NOT NULL,
       business_type    TEXT NOT NULL,
       contact_name     TEXT NOT NULL,
       phone            TEXT NOT NULL,
       email            TEXT,
       trn              TEXT,
       address          TEXT,
       parish           TEXT,
       years_trading    INTEGER,
       monthly_spend    NUMERIC(14,2),
       wants_credit     BOOLEAN NOT NULL DEFAULT false,
       credit_requested NUMERIC(14,2),
       references_text  TEXT,
       notes            TEXT,
       how_heard        TEXT,
       status           TEXT NOT NULL DEFAULT 'new',      -- new | approved | declined
       price_tier       TEXT,
       credit_limit     NUMERIC(14,2),
       terms_days       INTEGER,
       decision_note    TEXT,
       customer_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
       decided_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
       decided_at       TIMESTAMPTZ,
       ip               TEXT,
       created_at       TIMESTAMPTZ DEFAULT NOW())`).catch((e) => { readyP = null; console.error('[trade-apply] table', e.message); }));

  // At most 5 applications an hour from one address.
  const hits = new Map();
  function limited(ip) {
    const now = Date.now(), list = (hits.get(ip) || []).filter((t) => now - t < 3600e3);
    list.push(now); hits.set(ip, list);
    if (hits.size > 5000) for (const k of hits.keys()) { hits.delete(k); if (hits.size < 2500) break; }
    return list.length > 5;
  }

  app.post('/api/public/trade-apply', async (req, res) => {
    try {
      await ready();
      const b = req.body || {};
      if (b.website) return res.json({ ok: true });   // honeypot: bots fill every field
      if (limited(req.ip || 'x')) throw httpError(429, 'Too many applications from here. Please call us instead.');
      const a = {
        business_name: str(b.business_name, 160), business_type: TYPES.includes(b.business_type) ? b.business_type : '',
        contact_name: str(b.contact_name, 120), phone: str(b.phone, 40), email: str(b.email, 160).toLowerCase(),
        trn: str(b.trn, 30), address: str(b.address, 300), parish: PARISHES.includes(b.parish) ? b.parish : null,
        years_trading: Number.isFinite(Number(b.years_trading)) && b.years_trading !== '' ? Math.max(0, Math.min(100, Math.round(Number(b.years_trading)))) : null,
        monthly_spend: Number(b.monthly_spend) > 0 ? Math.min(1e9, Number(b.monthly_spend)) : null,
        wants_credit: b.wants_credit === true || b.wants_credit === 'yes',
        credit_requested: Number(b.credit_requested) > 0 ? Math.min(1e9, Number(b.credit_requested)) : null,
        references_text: str(b.references_text, 800), notes: str(b.notes, 800), how_heard: str(b.how_heard, 120),
      };
      if (!a.business_name) throw httpError(400, 'Please enter the business name');
      if (!a.business_type) throw httpError(400, 'What kind of business is it?');
      if (!a.contact_name) throw httpError(400, 'Who should we speak to?');
      if (!okPhone(a.phone)) throw httpError(400, 'Please enter a phone number we can reach you on');
      if (a.email && !okEmail(a.email)) throw httpError(400, 'That email address does not look right');
      if (a.wants_credit && !a.references_text) throw httpError(400, 'For credit, please give two trade references');
      if (b.consent !== true && b.consent !== 'yes') throw httpError(400, 'Please tick the box to let us check your details');
      const cols = Object.keys(a);
      const { rows } = await query(
        `INSERT INTO trade_applications (${cols.join(', ')}, ip) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(', ')}, $${cols.length + 1}) RETURNING id`,
        [...cols.map((k) => a[k]), str(req.ip, 60)]);
      res.json({ ok: true, id: rows[0].id });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/trade/applications', ...can('planning.view'), async (req, res) => {
    try {
      await ready();
      const st = ['new', 'approved', 'declined'].includes(req.query.status) ? req.query.status : 'new';
      const { rows } = await query(
        `SELECT a.*, u.name AS decided_by_name,
                (SELECT json_agg(json_build_object('id', x.id, 'name', COALESCE(NULLIF(x.company_name, ''), x.name), 'account_number', x.account_number))
                   FROM users x
                  WHERE NOT COALESCE(x.is_staff, false)
                    AND ((a.email IS NOT NULL AND a.email <> '' AND LOWER(x.email) = a.email)
                      OR right(regexp_replace(COALESCE(x.phone, ''), '\\D', '', 'g'), 7) = right(regexp_replace(a.phone, '\\D', '', 'g'), 7))) AS matches
           FROM trade_applications a LEFT JOIN users u ON u.id = a.decided_by
          WHERE a.status = $1 ORDER BY a.created_at DESC LIMIT 200`, [st]);
      const { rows: c } = await query(`SELECT COUNT(*)::int AS n FROM trade_applications WHERE status = 'new'`);
      res.json({ applications: rows, new_count: c[0].n });
    } catch (e) { fail(res, e); }
  });

  async function tell(a, text, byUser) {
    const out = [];
    try {
      if (a.email) out.push(await notify.message({ channel: 'email', to: a.email, subject: 'Your trade account application', text, event: 'trade_application', customer_id: a.customer_id, by_user: byUser }));
      else if (a.phone) out.push(await notify.message({ channel: 'sms', to: a.phone, text, event: 'trade_application', customer_id: a.customer_id, by_user: byUser }));
    } catch (e) { console.error('[trade-apply] tell', e.message); }
    return out.map((r) => ({ channel: r.channel, status: r.status, reason: r.reason }));
  }

  app.post('/api/trade/applications/:id/approve', ...can('ar.manage'), async (req, res) => {
    try {
      await ready();
      const b = req.body || {};
      const { rows } = await query(`SELECT * FROM trade_applications WHERE id = $1`, [Number(req.params.id) || 0]);
      const a = rows[0];
      if (!a) throw httpError(404, 'Application not found');
      if (a.status !== 'new') throw httpError(409, 'Already ' + a.status);
      const tier = TIERS.includes(b.price_tier) ? b.price_tier : 'trade';
      const limit = Number(b.credit_limit) > 0 ? Math.round(Number(b.credit_limit) * 100) / 100 : 0;
      const terms = limit > 0 ? Math.max(1, Math.min(120, Math.round(Number(b.terms_days) || 30))) : null;
      const type = ['fleet', 'dealer'].includes(a.business_type) ? a.business_type : 'trade';
      let custId = Number(b.customer_id) > 0 ? Number(b.customer_id) : null;
      if (custId) {
        await query(
          `UPDATE users SET company_name = COALESCE(NULLIF(company_name, ''), $2), customer_type = $3, price_tier = $4,
                  credit_limit_usd = $5, payment_terms_days = $6, tax_id = COALESCE(NULLIF($7, ''), tax_id),
                  sales_rep_id = COALESCE($8, sales_rep_id), phone = COALESCE(NULLIF(phone, ''), $9)
            WHERE id = $1`,
          [custId, a.business_name, type, tier, limit || null, terms, a.trn || '', Number(b.rep_id) > 0 ? Number(b.rep_id) : null, a.phone]);
      } else {
        const acct = await nextAccountNumber();
        const email = a.email || `${acct.toLowerCase()}@walkin.mortysautoparts.local`;
        const hash = await bcrypt.hash(require('crypto').randomBytes(24).toString('hex'), 10);
        const { rows: made } = await query(
          `INSERT INTO users (email, name, password_hash, phone, via, is_admin, price_tier, account_number, company_name, customer_type,
                              tax_id, credit_limit_usd, payment_terms_days, sales_rep_id, how_heard, internal_notes)
             VALUES ($1,$2,$3,$4,'trade_apply',false,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
          [email, a.contact_name, hash, a.phone, tier, acct, a.business_name, type, a.trn || null, limit || null, terms,
           Number(b.rep_id) > 0 ? Number(b.rep_id) : null, a.how_heard || null, 'Trade application #' + a.id]);
        custId = made[0].id;
      }
      await query(
        `UPDATE trade_applications SET status = 'approved', price_tier = $2, credit_limit = $3, terms_days = $4, decision_note = $5,
                customer_id = $6, decided_by = $7, decided_at = NOW() WHERE id = $1`,
        [a.id, tier, limit || null, terms, str(b.note, 500) || null, custId, uid(req)]);
      let told = [];
      if (b.notify) {
        const text = `Hi ${a.contact_name.split(/\s+/)[0]}, your trade account for ${a.business_name} is approved` +
          (limit > 0 ? ` with credit of J$${Math.round(limit).toLocaleString('en-US')} on ${terms}-day terms` : ' (cash account)') +
          `. Give your business name at the counter or when you call to order. Thank you!`;
        told = await tell(Object.assign({}, a, { customer_id: custId }), text, uid(req));
      }
      res.json({ ok: true, customer_id: custId, told });
    } catch (e) {
      if (e.code === '23505') return fail(res, httpError(409, 'A customer with that email already exists: pick them from the matches'));
      fail(res, e);
    }
  });

  app.post('/api/trade/applications/:id/decline', ...can('ar.manage'), async (req, res) => {
    try {
      await ready();
      const b = req.body || {};
      const { rows } = await query(
        `UPDATE trade_applications SET status = 'declined', decision_note = $2, decided_by = $3, decided_at = NOW()
          WHERE id = $1 AND status = 'new' RETURNING *`, [Number(req.params.id) || 0, str(b.note, 500) || null, uid(req)]);
      if (!rows[0]) throw httpError(409, 'Not found, or already decided');
      let told = [];
      if (b.notify) told = await tell(rows[0], `Hi ${rows[0].contact_name.split(/\s+/)[0]}, thank you for applying for a trade account with us. We can't open credit for ${rows[0].business_name} right now, but you're welcome to buy at the counter any time.`, uid(req));
      res.json({ ok: true, told });
    } catch (e) { fail(res, e); }
  });

  return {};
}

module.exports = { register, PARISHES };
