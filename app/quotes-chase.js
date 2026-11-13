// =============================================================================
//  Vision Auto Solutions -- Chase unconverted quotes (scaling roadmap)
//
//  A quote is a price we promised a customer. Many never come back. This gives
//  staff a worklist of open quotes (biggest and freshest first), with the
//  customer's number to call or WhatsApp, and a place to log what happened, so
//  real sales are recovered instead of quietly lost.
//
//  Mounted in server.js:
//    require('./quotes-chase').register(app, { query, requireAdmin, requireCap })
//  Page: quotes-chase.html. Cap: planning.view.
//
//  A quote's status is 'open' until a sale is rung against it (then
//  'converted'). We never change that. The chase outcome is kept separately in
//  quote_chase so marking a quote "won elsewhere" or "lost" drops it off the
//  list without touching the sale link. A quote reappears if it is still open
//  and its last chase was over 7 days ago (unless marked lost/won).
// =============================================================================
'use strict';

function register(app, deps) {
  const { query, requireAdmin, requireCap } = deps;
  const can = (k) => [requireAdmin, requireCap(k)];
  const uid = (req) => (req.session && req.session.userId) || null;
  function httpError(status, msg) { const e = new Error(msg); e.status = status; e.publicMessage = msg; return e; }
  function fail(res, e) { const s = e.status || 500; if (s >= 500) console.error('[quotes-chase]', e); res.status(s).json({ error: e.publicMessage || e.message }); }

  // Created on first use, not at startup: DDL during the boot-time schema.sql
  // apply can deadlock it (it did on 2026-11-05).
  let readyP = null;
  const ready = () => readyP || (readyP = query(
    `CREATE TABLE IF NOT EXISTS quote_chase (
       id         SERIAL PRIMARY KEY,
       quote_id   INTEGER NOT NULL REFERENCES pos_quotes(id) ON DELETE CASCADE,
       outcome    TEXT NOT NULL,              -- called | whatsapp | no_answer | won | lost
       note       TEXT,
       by_user    INTEGER REFERENCES users(id) ON DELETE SET NULL,
       created_at TIMESTAMPTZ DEFAULT NOW());
     CREATE INDEX IF NOT EXISTS idx_quote_chase_quote ON quote_chase (quote_id, created_at DESC);`)
    .catch((e) => { readyP = null; console.error('[quotes-chase] table', e.message); }));

  // quote_chase.outcome values that take a quote off the list for good.
  const CLOSED = "('won', 'lost')";

  // The worklist: open quotes not closed out and either never chased or last
  // chased over 7 days ago. Biggest value first, then oldest, so the money and
  // the quotes about to expire get attention first.
  app.get('/api/quotes/chase', ...can('planning.view'), async (req, res) => {
    try {
      await ready();
      const limit = Math.min(300, Math.max(1, parseInt(req.query.limit, 10) || 100));
      const { rows } = await query(
        `WITH last AS (
           SELECT DISTINCT ON (quote_id) quote_id, outcome, created_at
             FROM quote_chase ORDER BY quote_id, created_at DESC)
         SELECT q.id, q.quote_number, q.customer_name, q.customer_phone, q.vehicle_info,
                q.total_usd::float AS total, q.valid_until, q.created_at, q.sales_rep_name, q.items_json,
                l.outcome AS last_outcome, l.created_at AS last_contacted,
                (q.valid_until IS NOT NULL AND q.valid_until < CURRENT_DATE) AS expired,
                EXTRACT(DAY FROM NOW() - q.created_at)::int AS age_days,
                (SELECT COUNT(*) FROM quote_chase c WHERE c.quote_id = q.id)::int AS contacts
           FROM pos_quotes q
           LEFT JOIN last l ON l.quote_id = q.id
          WHERE q.status = 'open'
            AND (l.outcome IS NULL OR l.outcome NOT IN ('won', 'lost'))
            AND (l.created_at IS NULL OR l.created_at < NOW() - INTERVAL '7 days')
          ORDER BY q.total_usd DESC NULLS LAST, q.created_at ASC
          LIMIT $1`, [limit]);
      res.json({ quotes: rows });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/quotes/chase/stats', ...can('planning.view'), async (_req, res) => {
    try {
      await ready();
      const { rows } = await query(
        `SELECT COUNT(*) FILTER (WHERE status = 'open')::int AS open,
                COALESCE(SUM(total_usd) FILTER (WHERE status = 'open'), 0)::float AS open_value,
                COUNT(*) FILTER (WHERE status = 'open' AND valid_until < CURRENT_DATE)::int AS expired
           FROM pos_quotes`);
      res.json(rows[0] || { open: 0, open_value: 0, expired: 0 });
    } catch (e) { fail(res, e); }
  });

  // One quote with its chase history.
  app.get('/api/quotes/chase/:id', ...can('planning.view'), async (req, res) => {
    try {
      await ready();
      const id = parseInt(req.params.id, 10) || 0;
      const { rows } = await query(
        `SELECT q.*, q.total_usd::float AS total FROM pos_quotes q WHERE q.id = $1`, [id]);
      if (!rows.length) throw httpError(404, 'Quote not found');
      const { rows: hist } = await query(
        `SELECT c.outcome, c.note, c.created_at, u.name AS by_name
           FROM quote_chase c LEFT JOIN users u ON u.id = c.by_user
          WHERE c.quote_id = $1 ORDER BY c.created_at DESC`, [id]);
      res.json({ quote: rows[0], history: hist });
    } catch (e) { fail(res, e); }
  });

  // Log a contact / outcome.
  app.post('/api/quotes/chase/:id/log', ...can('planning.view'), async (req, res) => {
    try {
      await ready();
      const id = parseInt(req.params.id, 10) || 0;
      const outcome = String((req.body || {}).outcome || '').trim();
      if (!['called', 'whatsapp', 'no_answer', 'won', 'lost'].includes(outcome)) throw httpError(400, 'Pick an outcome');
      const found = await query(`SELECT 1 FROM pos_quotes WHERE id = $1`, [id]);
      if (!found.rows.length) throw httpError(404, 'Quote not found');
      await query(`INSERT INTO quote_chase (quote_id, outcome, note, by_user) VALUES ($1, $2, $3, $4)`,
        [id, outcome, String((req.body || {}).note || '').slice(0, 500) || null, uid(req)]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  return {};
}

module.exports = { register };
