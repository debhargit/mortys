// =============================================================================
//  Morty's Auto Parts -- "Time to replace" reminders (scaling roadmap, Phase 1)
//
//  Mounted by server.js:
//    require('./replace-reminders').register(app, { query, requireAdmin, requireCap, notify })
//  Page: replace-reminders.html. Routes under /api/replace (cap planning.view).
//
//  Parts that wear out on a schedule bring the customer back if somebody tells
//  them it is time. Each rule names words in the part's name (or its category)
//  and how many days the part lasts: engine oil 90, brake pads 365, battery
//  1,095 and so on (editable). A customer is due when they bought a part under
//  a rule that long ago and have not bought under that rule since.
//
//  What happens to a due customer:
//    list   always: the page lists who is due, with a WhatsApp link that opens
//           the message ready to send, a call button, and "done".
//    auto   when replace_auto_send is 'on': an SMS (or an email when there is
//           no phone) goes out once, at replace_send_at, only to customers who
//           have not opted out (sms_opt_in / email_opt_in).
//  Every reminder sent or marked done is a replace_reminders row, so nobody is
//  reminded twice for the same purchase. Walk-in / CASH sales are never
//  included: the till's "Phone for points" box is what turns them into
//  customers this can reach.
// =============================================================================
'use strict';

const TZ = 'America/Jamaica';
const DEFAULT_RULES = [
  { key: 'engine_oil', label: 'Oil change', words: 'engine oil|motor oil|oil filter', days: 90 },
  { key: 'brake_pads', label: 'Brake pads', words: 'disc pad|brake pad|brake shoe', days: 365 },
  { key: 'air_filter', label: 'Air filter', words: 'air filter|cabin filter|a/c filter', days: 365 },
  { key: 'wipers', label: 'Wiper blades', words: 'wiper', days: 365 },
  { key: 'spark_plugs', label: 'Spark plugs', words: 'spark plug', days: 730 },
  { key: 'trans_fluid', label: 'Transmission fluid', words: 'transmission|cvt fluid|atf', days: 730 },
  { key: 'coolant', label: 'Coolant', words: 'coolant|antifreeze', days: 730 },
  { key: 'battery', label: 'Battery', words: 'battery', days: 1095 },
];
const SETTINGS = {
  replace_rules: JSON.stringify(DEFAULT_RULES),
  replace_auto_send: 'off',
  replace_send_at: '10:00',
  replace_message: 'Hi {name}, it has been about {age} since your last {part} from {shop}. Time to replace it? We have it in stock. Reply or call us.',
  replace_last_run: '',
};
const WALKIN_RE = '^(cash|cash sale|cash customer|walk-?in( customer)?|counter|customer)$';

function register(app, deps) {
  const { query, requireAdmin, requireCap, notify } = deps;
  const can = (k) => [requireAdmin, requireCap(k)];
  function httpError(status, msg) { const e = new Error(msg); e.status = status; e.publicMessage = msg; return e; }
  function fail(res, e) { const s = e.status || 500; if (s >= 500) console.error('[replace]', e); res.status(s).json({ error: e.publicMessage || e.message }); }

  // Created on first use, not at startup: DDL during the boot-time schema.sql
  // apply can deadlock it (it did on 2026-11-05).
  let readyP = null;
  const ready = () => readyP || (readyP = query(
    `CREATE TABLE IF NOT EXISTS replace_reminders (
       id          SERIAL PRIMARY KEY,
       customer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       rule_key    TEXT NOT NULL,
       sale_id     INTEGER,
       bought_at   TIMESTAMPTZ,
       outcome     TEXT NOT NULL,            -- sms | email | whatsapp | called | done | skipped
       note        TEXT,
       by_user     INTEGER REFERENCES users(id) ON DELETE SET NULL,
       created_at  TIMESTAMPTZ DEFAULT NOW(),
       UNIQUE (customer_id, rule_key, sale_id))`).catch((e) => { readyP = null; console.error('[replace] table', e.message); }));

  async function settings() {
    const { rows } = await query(`SELECT key, value FROM warehouse_settings WHERE key = ANY($1)`, [Object.keys(SETTINGS)]);
    const out = Object.assign({}, SETTINGS);
    for (const r of rows) if (r.value != null && r.value !== '') out[r.key] = r.value;
    let rules;
    try { rules = JSON.parse(out.replace_rules); } catch (_) { rules = DEFAULT_RULES; }
    out.rules = cleanRules(rules);
    return out;
  }
  function cleanRules(list) {
    if (!Array.isArray(list)) throw httpError(400, 'Rules must be a list');
    return list.map((r, i) => {
      const words = String(r.words || '').toLowerCase().split('|').map((w) => w.trim()).filter(Boolean);
      const days = Math.round(Number(r.days));
      if (!words.length) throw httpError(400, `Rule ${i + 1} needs at least one word`);
      if (!(days >= 7 && days <= 3650)) throw httpError(400, `Rule ${i + 1}: days must be between 7 and 3650`);
      const key = String(r.key || r.label || words[0]).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'rule_' + (i + 1);
      return { key, label: String(r.label || words[0]).slice(0, 60), words: words.join('|'), days };
    });
  }
  async function save(key, value) {
    await query(`INSERT INTO warehouse_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, value]);
  }

  // Customers due: their latest purchase under each rule is at least `days`
  // old (and not older than days + window), nothing bought under that rule
  // since, and that purchase not already reminded or marked done.
  async function due(opts) {
    await ready();
    const st = await settings();
    const windowDays = Math.max(7, Math.min(365, Number((opts && opts.window) || 60)));
    const out = [];
    for (const r of st.rules) {
      const pattern = '(' + r.words.split('|').map((w) => w.replace(/[.*+?^${}()[\]\\]/g, '\\$&')).join('|') + ')';
      const { rows } = await query(
        `WITH hits AS (
           SELECT s.customer_id, s.id AS sale_id, s.created_at AS bought_at, i.description,
                  ROW_NUMBER() OVER (PARTITION BY s.customer_id ORDER BY s.created_at DESC) AS rn
             FROM pos_sale_items i
             JOIN pos_sales s ON s.id = i.sale_id
             LEFT JOIN products p ON p.id = i.product_id
            WHERE NOT COALESCE(s.voided, false) AND s.total_usd > 0 AND i.qty > 0 AND s.customer_id IS NOT NULL
              AND COALESCE(s.customer_name, '') !~* '${WALKIN_RE}'
              AND (LOWER(COALESCE(i.description, '')) ~ $1 OR LOWER(COALESCE(p.name, '')) ~ $1 OR LOWER(COALESCE(p.category, '')) ~ $1)
              AND s.created_at >= NOW() - make_interval(days => $2::int + $3::int))
         SELECT h.customer_id, h.sale_id, h.bought_at, h.description,
                (CURRENT_DATE - (h.bought_at AT TIME ZONE '${TZ}')::date) AS age_days,
                u.name, u.phone, u.email, COALESCE(u.sms_opt_in, true) AS sms_ok, COALESCE(u.email_opt_in, true) AS email_ok
           FROM hits h JOIN users u ON u.id = h.customer_id
          WHERE h.rn = 1
            AND h.bought_at < NOW() - make_interval(days => $2::int)
            AND NOT COALESCE(u.is_staff, false) AND NOT COALESCE(u.disabled, false)
            AND u.email <> 'walkin@mortysautoparts.local'
            AND NOT EXISTS (SELECT 1 FROM replace_reminders rr WHERE rr.customer_id = h.customer_id AND rr.rule_key = $4 AND rr.sale_id = h.sale_id)
          ORDER BY h.bought_at`,
        [pattern, r.days, windowDays, r.key]);
      for (const x of rows) out.push(Object.assign({ rule_key: r.key, rule_label: r.label, days: r.days }, x, { age_days: Number(x.age_days) }));
    }
    return out;
  }

  const ageText = (d) => (d >= 330 ? Math.round(d / 365) + (Math.round(d / 365) === 1 ? ' year' : ' years') : Math.round(d / 30) + ' months');
  const firstName = (n) => { const p = String(n || '').trim().split(/\s+/)[0] || ''; return /^customer$/i.test(p) || !p ? 'there' : p[0].toUpperCase() + p.slice(1).toLowerCase(); };
  function text(st, d, shop) {
    return String(st.replace_message).replace(/\{(\w+)\}/g, (m, k) => ({ name: firstName(d.name), age: ageText(d.age_days), part: d.rule_label.toLowerCase(), shop: shop || 'Morty\'s Auto' }[k] || ''));
  }
  async function shopName() {
    try { const { rows } = await query(`SELECT value FROM warehouse_settings WHERE key = 'shop_name'`); return (rows[0] && rows[0].value) || 'Morty\'s Auto'; } catch (_) { return 'Morty\'s Auto'; }
  }
  async function record(d, outcome, byUser, note) {
    await query(`INSERT INTO replace_reminders (customer_id, rule_key, sale_id, bought_at, outcome, note, by_user) VALUES ($1,$2,$3,$4,$5,$6,$7)
                 ON CONFLICT (customer_id, rule_key, sale_id) DO NOTHING`, [d.customer_id, d.rule_key, d.sale_id, d.bought_at, outcome, note || null, byUser || null]);
  }

  async function sendDue(byUser) {
    const st = await settings(); const shop = await shopName();
    const list = await due();
    const res = { sent: 0, skipped: 0 };
    const seen = new Set();   // one message per customer per run
    for (const d of list) {
      if (seen.has(d.customer_id)) continue;
      const msg = text(st, d, shop);
      let r = null;
      if (d.phone && d.sms_ok) r = await notify.message({ channel: 'sms', to: d.phone, text: msg, event: 'replace_reminder', customer_id: d.customer_id, by_user: byUser });
      else if (d.email && !/\.local$/i.test(d.email) && d.email_ok) r = await notify.message({ channel: 'email', to: d.email, subject: `Time to replace your ${d.rule_label.toLowerCase()}?`, text: msg, event: 'replace_reminder', customer_id: d.customer_id, by_user: byUser });
      if (r && ['sent', 'queued', 'stubbed'].includes(r.status)) { await record(d, r.channel, byUser, r.status); res.sent++; seen.add(d.customer_id); }
      else res.skipped++;
    }
    return res;
  }

  // ------------------------------------------------------------- routes --
  app.get('/api/replace/due', ...can('planning.view'), async (req, res) => {
    try {
      const st = await settings(); const shop = await shopName();
      const list = await due({ window: req.query.window });
      res.json({ due: list.map((d) => Object.assign(d, { message: text(st, d, shop), wa_link: d.phone && notify.waLink ? notify.waLink(d.phone, text(st, d, shop)) : null })) });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/replace/mark', ...can('planning.view'), async (req, res) => {
    try {
      const b = req.body || {};
      if (!['whatsapp', 'called', 'done', 'skipped'].includes(b.outcome)) throw httpError(400, 'Outcome must be whatsapp, called, done or skipped');
      const id = Number(b.customer_id), sale = Number(b.sale_id);
      if (!Number.isInteger(id) || !Number.isInteger(sale) || !b.rule_key) throw httpError(400, 'customer_id, sale_id and rule_key are required');
      await ready();
      await record({ customer_id: id, rule_key: String(b.rule_key).slice(0, 40), sale_id: sale, bought_at: b.bought_at || null }, b.outcome, req.user && req.user.id, b.note);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/replace/settings', ...can('planning.view'), async (_req, res) => {
    try { const s = await settings(); delete s.replace_rules; res.json(s); } catch (e) { fail(res, e); }
  });
  app.put('/api/replace/settings', ...can('planning.view'), async (req, res) => {
    try {
      const b = req.body || {};
      if (b.rules != null) await save('replace_rules', JSON.stringify(cleanRules(b.rules)));
      if (b.replace_auto_send != null) await save('replace_auto_send', b.replace_auto_send === 'on' ? 'on' : 'off');
      if (b.replace_send_at != null) {
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(b.replace_send_at))) throw httpError(400, 'Send time must be HH:MM');
        await save('replace_send_at', String(b.replace_send_at));
      }
      if (b.replace_message != null) {
        const m = String(b.replace_message).trim();
        if (m.length < 10 || m.length > 480) throw httpError(400, 'Message must be 10 to 480 characters');
        await save('replace_message', m);
      }
      const s = await settings(); delete s.replace_rules; res.json(s);
    } catch (e) { fail(res, e); }
  });
  app.post('/api/replace/send', ...can('planning.view'), async (req, res) => {
    try { res.json(await sendDue(req.user && req.user.id)); } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------- daily send --
  let busy = false;
  async function tick() {
    if (busy) return; busy = true;
    try {
      const st = await settings();
      if (st.replace_auto_send !== 'on') return;
      const { rows } = await query(`SELECT to_char((NOW() AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS d, to_char(NOW() AT TIME ZONE '${TZ}', 'HH24:MI') AS hm`);
      if (rows[0].hm < st.replace_send_at || st.replace_last_run === rows[0].d) return;
      await save('replace_last_run', rows[0].d);
      const r = await sendDue(null);
      console.log(`[replace] daily reminders: ${r.sent} sent, ${r.skipped} skipped`);
    } catch (e) { console.error('[replace] daily send', e.message || e); } finally { busy = false; }
  }
  if (!deps.noTimer) { const h = setInterval(tick, 60 * 1000); if (h.unref) h.unref(); }

  return { due, sendDue, tick, settings };
}

module.exports = { register };
