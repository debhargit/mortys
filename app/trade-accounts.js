// =============================================================================
//  Morty's Auto Parts -- Trade accounts: who is slipping, and the rep call
//  list (scaling roadmap, Phase 2)
//
//  Mounted by server.js:
//    require('./trade-accounts').register(app, { query, requireAdmin, requireCap, arOpenSql: AR_OPEN_SQL })
//  Page: trade-accounts.html. Routes under /api/trade (cap planning.view).
//
//  Every named customer (not walk-in, not staff) who bought in the last two
//  years, with their buying compared period on period:
//    last 90 days  vs  the 90 days before  vs  the same 90 days last year
//  and a status worked out from it:
//    dormant    a regular (3+ purchases in the year before) with nothing in
//               the last 60 days
//    declining  last 90 days below 70% of the 90 before (and the 90 before
//               was worth at least J$20,000)
//    growing    last 90 days above 130% of the 90 before
//    new        first purchase in the last 90 days
//    steady     everything else
//
//  Contacts: trade_contacts records each call, visit or WhatsApp by a rep
//  (mechanics row) with the outcome and the next date to follow up. The call
//  list is: follow-ups due today or earlier, plus dormant and declining
//  accounts nobody has contacted in 14 days, biggest first. Each account's rep
//  is users.sales_rep_id; the list can be filtered to one rep, and a signed-in
//  rep sees their own accounts by default.
// =============================================================================
'use strict';

const TZ = 'America/Jamaica';
const WALKIN_RE = '^(cash|cash sale|cash customer|walk-?in( customer)?|counter|customer)$';
const KINDS = ['call', 'visit', 'whatsapp', 'email'];
const OUTCOMES = ['ordered', 'will_order', 'no_answer', 'not_interested', 'price', 'complaint', 'other'];

function register(app, deps) {
  const { query, requireAdmin, requireCap, arOpenSql } = deps;
  const can = (k) => [requireAdmin, requireCap(k)];
  function httpError(status, msg) { const e = new Error(msg); e.status = status; e.publicMessage = msg; return e; }
  function fail(res, e) { const s = e.status || 500; if (s >= 500) console.error('[trade]', e); res.status(s).json({ error: e.publicMessage || e.message }); }

  // Created on first use, not at startup: DDL during the boot-time schema.sql
  // apply can deadlock it (it did on 2026-11-05).
  let readyP = null;
  const ready = () => readyP || (readyP = query(
    `CREATE TABLE IF NOT EXISTS trade_contacts (
       id          SERIAL PRIMARY KEY,
       customer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       rep_id      INTEGER REFERENCES mechanics(id) ON DELETE SET NULL,
       kind        TEXT NOT NULL,
       outcome     TEXT NOT NULL,
       note        TEXT,
       next_date   DATE,
       created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
       created_at  TIMESTAMPTZ DEFAULT NOW());
     CREATE INDEX IF NOT EXISTS idx_trade_contacts_customer ON trade_contacts (customer_id, created_at DESC);`)
    .catch((e) => { readyP = null; console.error('[trade] table', e.message); }));

  async function accounts() {
    await ready();
    const { rows } = await query(
      `WITH s AS (
         SELECT customer_id, created_at, (total_usd - COALESCE(tax_usd, 0)) AS net
           FROM pos_sales
          WHERE NOT COALESCE(voided, false) AND customer_id IS NOT NULL
            AND COALESCE(customer_name, '') !~* '${WALKIN_RE}'
            AND created_at >= NOW() - INTERVAL '730 days'),
       agg AS (
         SELECT customer_id,
                SUM(net) FILTER (WHERE created_at >= NOW() - INTERVAL '90 days') AS last90,
                SUM(net) FILTER (WHERE created_at >= NOW() - INTERVAL '180 days' AND created_at < NOW() - INTERVAL '90 days') AS prev90,
                SUM(net) FILTER (WHERE created_at >= NOW() - INTERVAL '455 days' AND created_at < NOW() - INTERVAL '365 days') AS ly90,
                SUM(net) FILTER (WHERE created_at >= NOW() - INTERVAL '365 days') AS last365,
                COUNT(*) FILTER (WHERE net > 0 AND created_at >= NOW() - INTERVAL '425 days' AND created_at < NOW() - INTERVAL '60 days') AS regular_n,
                COUNT(*) FILTER (WHERE net > 0 AND created_at >= NOW() - INTERVAL '90 days') AS last90_n,
                MAX(created_at) FILTER (WHERE net > 0) AS last_buy,
                MIN(created_at) AS first_buy
           FROM s GROUP BY customer_id),
       lastc AS (
         SELECT DISTINCT ON (customer_id) customer_id, created_at AS last_contact, kind AS last_kind, outcome AS last_outcome, next_date, rep_id AS contact_rep
           FROM trade_contacts ORDER BY customer_id, created_at DESC)
       SELECT u.id, COALESCE(NULLIF(u.company_name, ''), NULLIF(u.name, ''), u.email) AS name, u.phone, u.account_number,
              COALESCE(u.price_tier, 'retail') AS price_tier, u.payment_terms_days, u.sales_rep_id, m.name AS rep_name,
              COALESCE(a.last90, 0)::float AS last90, COALESCE(a.prev90, 0)::float AS prev90, COALESCE(a.ly90, 0)::float AS ly90,
              COALESCE(a.last365, 0)::float AS last365, a.regular_n::int AS regular_n, a.last90_n::int AS last90_n,
              a.last_buy, a.first_buy,
              (CURRENT_DATE - (a.last_buy AT TIME ZONE '${TZ}')::date) AS days_since,
              c.last_contact, c.last_kind, c.last_outcome, c.next_date
         FROM agg a
         JOIN users u ON u.id = a.customer_id
         LEFT JOIN mechanics m ON m.id = u.sales_rep_id
         LEFT JOIN lastc c ON c.customer_id = u.id
        WHERE NOT COALESCE(u.is_staff, false) AND NOT COALESCE(u.disabled, false)
          AND u.email <> 'walkin@mortysautoparts.local'`);
    let open = new Map();
    if (arOpenSql) {
      const { rows: o } = await query(
        `SELECT customer_id, SUM(GREATEST(charged - settled, 0))::float AS open,
                SUM(GREATEST(charged - settled, 0)) FILTER (WHERE COALESCE(due_date, created_at::date) < CURRENT_DATE)::float AS overdue
           FROM (${arOpenSql}) z WHERE customer_id IS NOT NULL AND charged - settled > 0.005 GROUP BY customer_id`);
      open = new Map(o.map((r) => [r.customer_id, r]));
    }
    return rows.map((r) => {
      const days = r.days_since == null ? null : Number(r.days_since);
      const firstDays = r.first_buy ? Math.round((Date.now() - Date.parse(r.first_buy)) / 86400000) : null;
      let status = 'steady';
      if (firstDays != null && firstDays <= 90) status = 'new';
      else if (r.regular_n >= 3 && days != null && days >= 60) status = 'dormant';
      else if (r.prev90 >= 20000 && r.last90 < 0.7 * r.prev90) status = 'declining';
      else if (r.prev90 > 0 && r.last90 > 1.3 * r.prev90) status = 'growing';
      const ob = open.get(r.id) || {};
      return Object.assign(r, { days_since: days, status, open: ob.open || 0, overdue: ob.overdue || 0,
        change_pct: r.prev90 ? Math.round(((r.last90 - r.prev90) / r.prev90) * 1000) / 10 : null,
        // What the slip costs a quarter: the gap to the 90 days before.
        at_risk: Math.max(0, Math.round(r.prev90 - r.last90)) });
    });
  }

  async function myRepId(req) {
    const uid = req.user && req.user.id || (req.session && req.session.userId);
    if (!uid) return null;
    const { rows } = await query(`SELECT id FROM mechanics WHERE user_id = $1 AND is_active LIMIT 1`, [uid]);
    return rows[0] ? rows[0].id : null;
  }

  app.get('/api/trade/accounts', ...can('planning.view'), async (req, res) => {
    try {
      const all = await accounts();
      let list = all.slice();
      const st = String(req.query.status || '');
      if (st) list = list.filter((a) => a.status === st);
      if (req.query.rep) list = list.filter((a) => String(a.sales_rep_id || '') === String(req.query.rep === 'none' ? '' : req.query.rep));
      list.sort((a, b) => b.last365 - a.last365);
      const summary = {};
      for (const a of all) { summary[a.status] = summary[a.status] || { n: 0, at_risk: 0, last365: 0 }; summary[a.status].n++; summary[a.status].at_risk += a.at_risk; summary[a.status].last365 += a.last365; }
      res.json({ accounts: list.slice(0, 1000), total: list.length, summary });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/trade/call-list', ...can('planning.view'), async (req, res) => {
    try {
      const list = await accounts();
      const today = new Date(new Date().toLocaleString('en-US', { timeZone: TZ })).toISOString().slice(0, 10);
      let rep = req.query.rep;
      if (rep == null) { const mine = await myRepId(req); rep = mine ? String(mine) : ''; }
      const stale = (a) => !a.last_contact || (Date.now() - Date.parse(a.last_contact)) > 14 * 86400000;
      const out = list.filter((a) => (a.next_date && String(a.next_date instanceof Date ? a.next_date.toISOString().slice(0, 10) : a.next_date).slice(0, 10) <= today)
          || ((a.status === 'dormant' || a.status === 'declining') && stale(a)))
        .filter((a) => !rep || String(a.sales_rep_id || '') === rep)
        .map((a) => Object.assign(a, { reason: a.next_date && String(a.next_date).slice(0, 10) <= today ? 'Follow-up due' : a.status === 'dormant' ? `No purchase in ${a.days_since} days` : `Down ${Math.abs(a.change_pct)}% on the 90 days before` }))
        .sort((a, b) => (b.at_risk || b.last365 / 4) - (a.at_risk || a.last365 / 4));
      const { rows: reps } = await query(`SELECT id, name FROM mechanics WHERE is_active ORDER BY name`);
      res.json({ calls: out.slice(0, 200), total: out.length, rep: rep || '', reps });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/trade/contacts/:customerId', ...can('planning.view'), async (req, res) => {
    try {
      await ready();
      const { rows } = await query(
        `SELECT c.*, m.name AS rep_name FROM trade_contacts c LEFT JOIN mechanics m ON m.id = c.rep_id
          WHERE c.customer_id = $1 ORDER BY c.created_at DESC LIMIT 50`, [Number(req.params.customerId) || 0]);
      res.json({ contacts: rows });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/trade/contacts', ...can('planning.view'), async (req, res) => {
    try {
      await ready();
      const b = req.body || {};
      const cid = Number(b.customer_id);
      if (!Number.isInteger(cid) || cid <= 0) throw httpError(400, 'Which customer?');
      if (!KINDS.includes(b.kind)) throw httpError(400, 'Call, visit, WhatsApp or email?');
      if (!OUTCOMES.includes(b.outcome)) throw httpError(400, 'Pick an outcome');
      const next = b.next_date && /^\d{4}-\d{2}-\d{2}$/.test(b.next_date) ? b.next_date : null;
      let rep = Number.isInteger(Number(b.rep_id)) && Number(b.rep_id) > 0 ? Number(b.rep_id) : await myRepId(req);
      const { rows } = await query(
        `INSERT INTO trade_contacts (customer_id, rep_id, kind, outcome, note, next_date, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [cid, rep || null, b.kind, b.outcome, b.note ? String(b.note).slice(0, 1000) : null, next, (req.user && req.user.id) || (req.session && req.session.userId) || null]);
      res.json({ ok: true, id: rows[0].id });
    } catch (e) { fail(res, e); }
  });

  app.put('/api/trade/accounts/:id/rep', ...can('planning.view'), async (req, res) => {
    try {
      const rep = req.body && req.body.rep_id ? Number(req.body.rep_id) : null;
      if (rep != null && !Number.isInteger(rep)) throw httpError(400, 'Bad rep');
      await query(`UPDATE users SET sales_rep_id = $1 WHERE id = $2`, [rep, Number(req.params.id) || 0]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  return { accounts };
}

module.exports = { register };
