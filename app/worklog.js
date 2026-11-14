// =============================================================================
//  Morty's Auto Parts -- Work log: what each person actually did, from the
//  transactions they made, on the calendar and against the plan
//
//    const worklog = require('./worklog').register(app, { query, getPool, requireAdmin, userCan, notice, dayplan })
//
//  Nothing new is typed in. Each transaction a person makes becomes a slot of
//  work on their calendar at the time it happened:
//    sale       a sale rung at the till (the cashier; the rep too, when a rep is on it)
//    order      a counter order taken for the cashier (pos_orders)
//    quote      a quote written
//    pick       a pick accepted and picked (fulfilments: pick start -> picked)
//    pack       an order packed;  handover: a pickup handed to the customer
//    delivery   a driver out on a job (dispatch_jobs: started -> done) or an
//               older delivery (deliveries: dispatched -> delivered)
//    receiving  stock received; count: a bin counted; transfer: a transfer posted
//    activity   a day-plan activity the person started and finished
//    labour     workshop labour booked on a work order (hours only, no clock time)
//  A transaction with a start and an end (a pick, a delivery) is the time
//  between them; one that is a moment (a sale) is a few minutes before it
//  (set per kind in the settings). Overlapping slots are counted once.
//
//  Productive hours = the time covered by work slots in the day. Matched
//  against the plan: work that falls inside a planned activity of the same
//  kind is "on plan", the rest is "unplanned"; planned activities show how
//  much of their time had matching work. The minute tick starts a planned
//  activity by itself when matching work turns up in its time.
//
//  Duties: the job description on each person's HR record (or written here)
//  becomes timed duties (day-plan templates for that person or job title),
//  which go onto their calendar every working day and are sent to them.
//
//  It only reads the transaction tables. No new tables: settings are in
//  warehouse_settings (worklog_*), duties are dayplan_templates rows with
//  is_duty (and job_title for "everyone with this job title").
// =============================================================================
'use strict';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const KINDS = {
  sale: { label: 'Sale', color: '#16a34a', cats: ['sales'] },
  order: { label: 'Order taken', color: '#22c55e', cats: ['sales'] },
  quote: { label: 'Quote', color: '#84cc16', cats: ['sales'] },
  pick: { label: 'Picking', color: '#f59e0b', cats: ['stock', 'delivery'] },
  pack: { label: 'Packing', color: '#d97706', cats: ['stock', 'delivery'] },
  handover: { label: 'Pickup handed over', color: '#eab308', cats: ['sales', 'stock'] },
  delivery: { label: 'Delivery', color: '#2563eb', cats: ['delivery'] },
  receiving: { label: 'Receiving', color: '#9333ea', cats: ['stock'] },
  count: { label: 'Stock count', color: '#a855f7', cats: ['stock'] },
  transfer: { label: 'Stock transfer', color: '#c084fc', cats: ['stock'] },
  activity: { label: 'Planned activity', color: '#0ea5e9', cats: [] },
  labour: { label: 'Workshop labour', color: '#64748b', cats: ['work'] },
};
const DEFAULTS = { sale_min: '5', order_min: '5', quote_min: '5', pick_min: '10', pack_min: '5', handover_min: '3', receive_min: '15', count_min: '5', transfer_min: '10',
  max_open_hours: '8', auto_track: 'on', duties_notify: 'on' };
const CAT_WORDS = [[/sale|sell|customer|counter|quote|cash|till|phone|take orders?|\bcall/i, 'sales'], [/deliver|driv|route|dispatch|errand|bank/i, 'delivery'],
  [/stock|pick|pack|receiv|count|shelf|bin|warehouse|inventory|transfer/i, 'stock'], [/clean|sweep|tidy|wash/i, 'cleaning'],
  [/train|learn/i, 'training'], [/meet|brief/i, 'meeting'], [/report|file|admin|email|paper|account|invoice|payroll/i, 'admin']];

function register(app, deps) {
  const { query, requireAdmin, userCan } = deps;
  const notice = deps.notice || null;
  const dp = deps.dayplan;

  function httpError(status, msg) { const e = new Error(msg); e.status = status; e.publicMessage = msg; return e; }
  function fail(res, e) { const s = e.status || 500; if (s >= 500) console.error('[worklog]', e); res.status(s).json({ error: e.publicMessage || e.message }); }
  const at = (day, hhmm) => new Date(day + 'T' + String(hhmm).slice(0, 5) + ':00-05:00');
  const jmDay = (d) => new Date(new Date(d || Date.now()).getTime() - 5 * 3600000).toISOString().slice(0, 10);
  const hhmm = (d) => new Date(new Date(d).getTime() - 5 * 3600000).toISOString().slice(11, 16);
  const addDays = (day, n) => new Date(new Date(day + 'T12:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);
  const weekday = (day) => new Date(day + 'T12:00:00Z').getUTCDay();
  const uid = (req) => req.session && req.session.userId;
  const str = (v, m) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, m));
  const iso = (d) => (d ? new Date(d).toISOString() : null);
  const ms = (d) => new Date(d).getTime();

  let readyP = null;
  function ready() {
    if (!readyP) readyP = (async () => {
      await dp.ready();
      const c = await deps.getPool().connect();
      try {
        await c.query(`SELECT pg_advisory_lock(hashtext('vision.dayplan.ddl'))`);
        try { await c.query(DDL); } finally { await c.query(`SELECT pg_advisory_unlock(hashtext('vision.dayplan.ddl'))`); }
      } finally { c.release(); }
    })().catch((e) => { readyP = null; throw e; });
    return readyP;
  }

  async function caps(req) {
    const c = async (k) => !!(userCan && await userCan(req, k));
    const [m, rv, rp, ca, cm] = await Promise.all([c('dayplan.manage'), c('roster.view'), c('roster.plan'), c('clock.approve'), c('clock.manage')]);
    return { manage: m, all: m || rv || rp || ca || cm };
  }
  const canManage = [requireAdmin, async (req, res, next) => { try { if ((await caps(req)).manage) return next(); res.status(403).json({ error: 'Your account is not allowed to manage the day plan.' }); } catch (e) { fail(res, e); } }];

  let sCache = null;
  async function settings() {
    if (sCache && sCache.at > Date.now() - 20000) return sCache.v;
    const { rows } = await query(`SELECT key, value FROM warehouse_settings WHERE key LIKE 'worklog\\_%'`);
    const v = Object.assign({}, DEFAULTS);
    for (const r of rows) v[r.key.slice(8)] = r.value;
    sCache = { at: Date.now(), v };
    return v;
  }

  // Which source tables this database has (some modules may not be installed).
  let tCache = null;
  async function tables() {
    if (tCache && tCache.at > Date.now() - 60000) return tCache.v;
    const names = ['pos_sales', 'pos_orders', 'pos_quotes', 'mechanics', 'fulfilments', 'dispatch_jobs', 'deliveries', 'receipts', 'bin_count_bins', 'stock_transfers', 'work_order_labor'];
    const { rows } = await query(`SELECT n, to_regclass(n) IS NOT NULL AS ok FROM unnest($1::text[]) AS n`, [names]);
    const v = {}; for (const r of rows) v[r.n] = r.ok;
    if (v.pos_sales) {
      const { rows: c } = await query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'pos_sales' AND column_name IN ('sales_rep_id', 'voided')`);
      v.rep_col = c.some((x) => x.column_name === 'sales_rep_id'); v.voided_col = c.some((x) => x.column_name === 'voided');
    }
    if (v.pos_quotes) v.quote_col = (await query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'pos_quotes' AND column_name = 'cashier_id'`)).rows.length > 0;
    tCache = { at: Date.now(), v };
    return v;
  }
  const warned = new Set();
  const safe = (name, p) => p.catch((e) => { if (!warned.has(name)) { warned.add(name); console.warn('[worklog] ' + name + ': ' + e.message); } return { rows: [] }; });

  // ------------------------------------------------- the work slots --
  // Every slot between two moments (ms), for some people (null = everyone).
  async function slots(fromMs, toMs, ids) {
    await ready();
    const t = await tables(), s = await settings();
    const from = new Date(fromMs), to = new Date(toMs), now = Date.now();
    const M = (k) => Math.max(1, parseInt(s[k], 10) || parseInt(DEFAULTS[k], 10)) * 60000;
    const maxOpen = Math.max(1, Number(s.max_open_hours) || 8) * 3600000;
    const out = [];
    const add = (user_id, kind, start, end, label, ref, link) => {
      if (!user_id || !start) return;
      let a = ms(start), b = end ? ms(end) : Math.min(now, a + maxOpen);
      if (!(b > a)) b = a + 60000;
      if (b - a > maxOpen) b = a + maxOpen;
      if (b <= fromMs || a >= toMs) return;
      if (ids && !ids.includes(user_id)) return;
      out.push({ user_id, kind, start: a, end: b, label, ref: ref || null, link: link || null });
    };
    const q = [];
    // sales: the cashier (from the moment they took the order, when it came from one), and the rep
    if (t.pos_sales) q.push(safe('sales', query(
      `SELECT s.id, s.receipt_number, s.cashier_id, s.created_at, s.total_usd::float AS total, o.claimed_at, o.claimed_by,
              ${t.rep_col && t.mechanics ? 'm.user_id' : 'NULL::int'} AS rep_user
         FROM pos_sales s
         ${t.pos_orders ? 'LEFT JOIN pos_orders o ON o.converted_sale_id = s.id' : 'LEFT JOIN (SELECT NULL::int AS converted_sale_id, NULL::timestamptz AS claimed_at, NULL::int AS claimed_by) o ON false'}
         ${t.rep_col && t.mechanics ? 'LEFT JOIN mechanics m ON m.id = s.sales_rep_id' : ''}
        WHERE s.created_at >= $1 AND s.created_at < $2 ${t.voided_col ? 'AND NOT COALESCE(s.voided, false)' : ''}`, [new Date(fromMs - 3600000), to])).then(({ rows }) => {
      for (const r of rows) {
        const cn = /^CN/i.test(r.receipt_number || '');
        const lbl = (cn ? 'Return ' : 'Sale ') + (r.receipt_number || '#' + r.id) + (r.total != null ? ' · J$' + Math.round(r.total).toLocaleString('en-US') : '');
        const start = r.claimed_at && r.claimed_by === r.cashier_id && ms(r.created_at) - ms(r.claimed_at) < 3 * 3600000 ? r.claimed_at : new Date(ms(r.created_at) - M('sale_min'));
        add(r.cashier_id, 'sale', start, r.created_at, lbl, 'sale:' + r.id, '/admin.html#sales');
        if (r.rep_user && r.rep_user !== r.cashier_id) add(r.rep_user, 'sale', new Date(ms(r.created_at) - M('sale_min')), r.created_at, lbl + ' (rep)', 'sale-rep:' + r.id, '/admin.html#sales');
      }
    }));
    if (t.pos_orders) q.push(safe('orders', query(
      `SELECT o.id, o.taken_by, o.created_at, o.total_usd::float AS total, o.status, o.customer_name FROM pos_orders o WHERE o.created_at >= $1 AND o.created_at < $2 AND o.taken_by IS NOT NULL`, [from, new Date(toMs + 3600000)])).then(({ rows }) => {
      for (const r of rows) add(r.taken_by, 'order', new Date(ms(r.created_at) - M('order_min')), r.created_at, 'Order taken' + (r.customer_name ? ' for ' + r.customer_name : '') + (r.total != null ? ' · J$' + Math.round(r.total).toLocaleString('en-US') : ''), 'order:' + r.id);
    }));
    if (t.pos_quotes && t.quote_col && t.mechanics) q.push(safe('quotes', query(
      `SELECT q.id, q.quote_number, q.created_at, m.user_id FROM pos_quotes q JOIN mechanics m ON m.id = q.cashier_id WHERE q.created_at >= $1 AND q.created_at < $2 AND m.user_id IS NOT NULL`, [from, new Date(toMs + 3600000)])).then(({ rows }) => {
      for (const r of rows) add(r.user_id, 'quote', new Date(ms(r.created_at) - M('quote_min')), r.created_at, 'Quote ' + (r.quote_number || '#' + r.id), 'quote:' + r.id);
    }));
    if (t.fulfilments) q.push(safe('fulfilments', query(
      `SELECT id, number, source_ref, status, picker_id, pick_started_at, picked_at, packer_id, packed_at, completed_by, completed_at, method
         FROM fulfilments WHERE (pick_started_at < $2 AND COALESCE(picked_at, NOW()) >= $1) OR (picked_at >= $1 AND picked_at < $2) OR (packed_at >= $1 AND packed_at < $2) OR (completed_at >= $1 AND completed_at < $2)`, [from, new Date(toMs + 3600000)])).then(({ rows }) => {
      for (const r of rows) {
        const nm = (r.number || '#' + r.id) + (r.source_ref ? ' (' + r.source_ref + ')' : '');
        if (r.picker_id && (r.pick_started_at || r.picked_at)) {
          const st = r.pick_started_at || new Date(ms(r.picked_at) - M('pick_min'));
          const en = r.picked_at || (r.status === 'picking' ? null : new Date(ms(st) + M('pick_min')));
          add(r.picker_id, 'pick', st, en, (r.picked_at ? 'Picked ' : 'Picking ') + nm, 'pick:' + r.id, '/outbound.html');
        }
        if (r.packer_id && r.packed_at) add(r.packer_id, 'pack', new Date(ms(r.packed_at) - M('pack_min')), r.packed_at, 'Packed ' + nm, 'pack:' + r.id, '/outbound.html');
        if (r.completed_by && r.completed_at && r.method === 'pickup') add(r.completed_by, 'handover', new Date(ms(r.completed_at) - M('handover_min')), r.completed_at, 'Handed over ' + nm, 'handover:' + r.id, '/outbound.html');
      }
    }));
    if (t.dispatch_jobs) q.push(safe('dispatch', query(
      `SELECT id, number, kind, title, address, driver_id, status, started_at, arrived_at, done_at FROM dispatch_jobs
        WHERE driver_id IS NOT NULL AND started_at IS NOT NULL AND started_at < $2 AND COALESCE(done_at, NOW()) >= $1`, [from, to])).then(({ rows }) => {
      for (const r of rows) {
        const end = r.done_at || (['en_route', 'arrived'].includes(r.status) ? null : (r.arrived_at || r.started_at));
        add(r.driver_id, 'delivery', r.started_at, end, (r.kind === 'delivery' ? 'Delivery ' : 'Run ') + (r.number || '#' + r.id) + ': ' + (r.title || '') + (r.address ? ' · ' + r.address : ''), 'job:' + r.id, '/driver.html');
      }
    }));
    if (t.deliveries && t.mechanics) q.push(safe('deliveries', query(
      `SELECT d.id, d.delivery_number, d.recipient_name, d.address, d.status, d.dispatched_at, d.delivered_at, m.user_id FROM deliveries d JOIN mechanics m ON m.id = d.driver_id
        WHERE m.user_id IS NOT NULL AND d.dispatched_at IS NOT NULL AND d.dispatched_at < $2 AND COALESCE(d.delivered_at, NOW()) >= $1
          ${t.dispatch_jobs ? 'AND NOT EXISTS (SELECT 1 FROM dispatch_jobs j WHERE j.delivery_id = d.id AND j.started_at IS NOT NULL)' : ''}`, [from, to])).then(({ rows }) => {
      for (const r of rows) add(r.user_id, 'delivery', r.dispatched_at, r.delivered_at || (r.status === 'dispatched' ? null : r.dispatched_at), 'Delivery ' + (r.delivery_number || '#' + r.id) + ' to ' + r.recipient_name, 'delivery:' + r.id);
    }));
    if (t.receipts) q.push(safe('receipts', query(
      `SELECT id, received_by, received_at FROM receipts WHERE received_by IS NOT NULL AND received_at >= $1 AND received_at < $2 AND COALESCE(status, '') <> 'void'`, [from, new Date(toMs + 3600000)])).then(({ rows }) => {
      for (const r of rows) add(r.received_by, 'receiving', new Date(ms(r.received_at) - M('receive_min')), r.received_at, 'Received stock (receipt #' + r.id + ')', 'receipt:' + r.id, '/inbound.html');
    }));
    if (t.bin_count_bins) q.push(safe('counts', query(
      `SELECT count_id, bin_id, counted_by, counted_at, recount_by, recount_at FROM bin_count_bins WHERE (counted_at >= $1 AND counted_at < $2) OR (recount_at >= $1 AND recount_at < $2)`, [from, new Date(toMs + 3600000)])).then(({ rows }) => {
      for (const r of rows) {
        if (r.counted_by && r.counted_at) add(r.counted_by, 'count', new Date(ms(r.counted_at) - M('count_min')), r.counted_at, 'Counted bin ' + r.bin_id, 'count:' + r.count_id + ':' + r.bin_id);
        if (r.recount_by && r.recount_at) add(r.recount_by, 'count', new Date(ms(r.recount_at) - M('count_min')), r.recount_at, 'Recounted bin ' + r.bin_id, 'recount:' + r.count_id + ':' + r.bin_id);
      }
    }));
    if (t.stock_transfers) q.push(safe('transfers', query(
      `SELECT id, posted_by, posted_at FROM stock_transfers WHERE posted_by IS NOT NULL AND posted_at >= $1 AND posted_at < $2`, [from, new Date(toMs + 3600000)])).then(({ rows }) => {
      for (const r of rows) add(r.posted_by, 'transfer', new Date(ms(r.posted_at) - M('transfer_min')), r.posted_at, 'Stock transfer #' + r.id, 'transfer:' + r.id);
    }));
    q.push(safe('activities', query(
      `SELECT id, user_id, title, category, status, actual_start, actual_end, planned_start, planned_end, result FROM dayplan_activities
        WHERE actual_start IS NOT NULL AND status IN ('in_progress', 'done') AND category NOT IN ('break', 'devotion') AND actual_start < $2 AND COALESCE(actual_end, NOW()) >= $1`, [from, to])).then(({ rows }) => {
      for (const r of rows) {
        // Started by itself from a transaction and not finished: the transactions already count.
        if (!r.actual_end && /^Started by itself/.test(r.result || '')) continue;
        // Started and never marked done: count it up to its planned end at most.
        let end = r.actual_end;
        if (!end && r.planned_end && ms(r.planned_end) > ms(r.actual_start)) end = new Date(Math.min(now, ms(r.planned_end)));
        add(r.user_id, 'activity', r.actual_start, end, r.title, 'act:' + r.id, '/day.html#me');
      }
    }));
    await Promise.all(q);
    out.sort((a, b) => a.start - b.start || a.end - b.end);
    return out;
  }

  // Workshop labour: hours booked per person per day, no clock time.
  async function labour(fromDay, toDay, ids) {
    const t = await tables();
    if (!t.work_order_labor || !t.mechanics) return [];
    const { rows } = await safe('labour', query(
      `SELECT m.user_id, to_char(l.performed_date, 'YYYY-MM-DD') AS day, SUM(l.hours)::float AS hours, COUNT(*)::int AS n FROM work_order_labor l JOIN mechanics m ON m.id = l.mechanic_id
        WHERE m.user_id IS NOT NULL AND l.performed_date BETWEEN $1 AND $2 GROUP BY 1, 2`, [fromDay, toDay]));
    return rows.filter((r) => !ids || ids.includes(r.user_id));
  }

  // Merge [start,end] intervals; total minutes covered.
  function union(list) {
    const iv = list.map((x) => [x.start, x.end]).sort((a, b) => a[0] - b[0]);
    const m = [];
    for (const [a, b] of iv) { if (m.length && a <= m[m.length - 1][1]) m[m.length - 1][1] = Math.max(m[m.length - 1][1], b); else m.push([a, b]); }
    return m;
  }
  const minutes = (iv) => iv.reduce((t, [a, b]) => t + (b - a), 0) / 60000;
  const clip = (iv, a, b) => iv.map(([x, y]) => [Math.max(x, a), Math.min(y, b)]).filter(([x, y]) => y > x);
  const overlap = (iv, a, b) => minutes(clip(iv, a, b));

  // Slots shown on a calendar: neighbours of the same kind within 10 minutes are one block ("6 sales").
  function blocks(list) {
    const out = [];
    for (const s of list.slice().sort((a, b) => a.user_id - b.user_id || a.start - b.start)) {
      const last = out.length ? out[out.length - 1] : null;
      if (last && last.user_id === s.user_id && last.kind === s.kind && s.start <= last.end + 10 * 60000 && s.kind !== 'delivery' && s.kind !== 'activity') {
        last.end = Math.max(last.end, s.end); last.n++; last.items.push(s.label);
      } else out.push({ user_id: s.user_id, kind: s.kind, start: s.start, end: s.end, n: 1, items: [s.label], link: s.link });
    }
    return out.map((b) => ({ user_id: b.user_id, kind: b.kind, color: KINDS[b.kind].color, start: iso(b.start), end: iso(b.end), n: b.n,
      title: b.n > 1 ? b.n + ' × ' + KINDS[b.kind].label.toLowerCase() : b.items[0], items: b.items.slice(0, 30), link: b.link }));
  }

  // One person, one day: productive time, by kind, against the plan and the clock.
  function dayFigures(day, list, acts, clockedMin, labourHours) {
    const d0 = at(day, '00:00').getTime(), d1 = d0 + 86400000;
    const mine = list.map((s) => ({ ...s, start: Math.max(s.start, d0), end: Math.min(s.end, d1) })).filter((s) => s.end > s.start);
    const all = union(mine);
    const byKind = {};
    for (const k of Object.keys(KINDS)) { const u = union(mine.filter((s) => s.kind === k)); if (u.length) byKind[k] = Math.round(minutes(u)); }
    // against the plan
    const planned = acts.filter((a) => a.planned_start && a.planned_end && !['break', 'devotion'].includes(a.category)).sort((x, y) => ms(x.planned_start) - ms(y.planned_start));
    const planWins = [];
    const actOut = planned.map((a) => {
      const ps = ms(a.planned_start), pe = ms(a.planned_end);
      const fits = mine.filter((s) => matches(s, a));
      const u = union(fits);
      const w = overlap(u, ps, pe);
      planWins.push(...clip(u, ps, pe));
      return { id: a.id, title: a.title, category: a.category, status: a.status, start: iso(ps), end: iso(pe), planned_min: Math.round((pe - ps) / 60000),
        work_min: Math.round(w), coverage: pe > ps ? Math.min(100, Math.round(w / ((pe - ps) / 60000) * 100)) : 0, transactions: fits.filter((s) => s.end > ps && s.start < pe && s.kind !== 'activity').length };
    });
    const onPlan = minutes(union(planWins.map(([a, b]) => ({ start: a, end: b }))));
    const total = minutes(all) + (labourHours || 0) * 60;
    if (labourHours) byKind.labour = Math.round(labourHours * 60);
    return { productive_min: Math.round(total), timed_min: Math.round(minutes(all)), labour_min: Math.round((labourHours || 0) * 60), by_kind: byKind,
      on_plan_min: Math.round(onPlan), unplanned_min: Math.round(Math.max(0, minutes(all) - onPlan)), transactions: mine.filter((s) => s.kind !== 'activity').length,
      clocked_min: Math.round(clockedMin || 0), utilisation: clockedMin > 0 ? Math.min(100, Math.round(minutes(all) / clockedMin * 100)) : null,
      first: all.length ? iso(all[0][0]) : null, last: all.length ? iso(all[all.length - 1][1]) : null, activities: actOut };
  }
  // A slot fits a planned activity when its kind suits the activity's category
  // (a sale in "Sales", a pick in "Stock", a delivery in "Delivery"), or it is
  // that activity itself; anything fits "Work" / "Other".
  function matches(s, a) {
    if (s.kind === 'activity') return s.ref === 'act:' + a.id;
    if (a.category === 'work' || a.category === 'other') return true;
    return KINDS[s.kind].cats.includes(a.category);
  }

  // Minutes clocked in (less breaks), per person per day.
  async function clocked(fromDay, toDay, ids) {
    const now = Date.now();
    const { rows } = await safe('clock', query(
      `SELECT a.user_id, to_char(a.work_day, 'YYYY-MM-DD') AS day,
              SUM(EXTRACT(EPOCH FROM (COALESCE(a.clock_out_at, $3) - a.clock_in_at)) / 60)::float
              - COALESCE((SELECT SUM(EXTRACT(EPOCH FROM (COALESCE(b.end_at, $3) - b.start_at)) / 60) FROM attendance_breaks b JOIN attendance a2 ON a2.id = b.attendance_id
                           WHERE a2.user_id = a.user_id AND a2.work_day = a.work_day), 0)::float AS mins
         FROM attendance a WHERE a.work_day BETWEEN $1 AND $2 GROUP BY a.user_id, a.work_day`, [fromDay, toDay, new Date(now)]));
    const o = {};
    for (const r of rows) if (!ids || ids.includes(r.user_id)) o[r.user_id + '|' + r.day] = Math.max(0, r.mins);
    return o;
  }

  // Everything for a range of days (at most 92).
  async function report(fromDay, toDay, ids) {
    await ready();
    const staff = await dp.staffList();
    const people = ids ? staff.filter((s) => ids.includes(s.id)) : staff;
    const pid = people.map((p) => p.id);
    const days = []; for (let d = fromDay; d <= toDay; d = addDays(d, 1)) days.push(d);
    const fromMs = at(fromDay, '00:00').getTime(), toMs = at(addDays(toDay, 1), '00:00').getTime();
    const [list, lab, clk, actsR] = await Promise.all([slots(fromMs, toMs, pid), labour(fromDay, toDay, pid), clocked(fromDay, toDay, pid),
      query(`SELECT id, user_id, to_char(day, 'YYYY-MM-DD') AS day, title, category, status, planned_start, planned_end FROM dayplan_activities WHERE day BETWEEN $1 AND $2 AND user_id = ANY($3::int[])`, [fromDay, toDay, pid])]);
    const rows = [];
    for (const p of people) for (const d of days) {
      const mine = list.filter((s) => s.user_id === p.id);
      const l = lab.find((x) => x.user_id === p.id && x.day === d);
      const f = dayFigures(d, mine, actsR.rows.filter((a) => a.user_id === p.id && a.day === d), clk[p.id + '|' + d] || 0, l ? l.hours : 0);
      if (f.productive_min || f.clocked_min || f.activities.length) rows.push({ user_id: p.id, name: p.name, department: p.department || 'No department', day: d, ...f });
    }
    // per person
    const per = people.map((p) => {
      const r = rows.filter((x) => x.user_id === p.id);
      const sum = (k) => r.reduce((t, x) => t + (x[k] || 0), 0);
      const byKind = {}; r.forEach((x) => Object.entries(x.by_kind).forEach(([k, v]) => { byKind[k] = (byKind[k] || 0) + v; }));
      const clockedMin = sum('clocked_min');
      return { user_id: p.id, name: p.name, department: p.department || 'No department', productive_min: sum('productive_min'), clocked_min: clockedMin, on_plan_min: sum('on_plan_min'), unplanned_min: sum('unplanned_min'),
        transactions: sum('transactions'), labour_min: sum('labour_min'), by_kind: byKind, days_worked: r.filter((x) => x.clocked_min > 0 || x.productive_min > 0).length,
        utilisation: clockedMin > 0 ? Math.min(100, Math.round(sum('timed_min') / clockedMin * 100)) : null };
    }).filter((x) => x.productive_min || x.clocked_min).sort((a, b) => b.productive_min - a.productive_min);
    const perDay = days.map((d) => {
      const r = rows.filter((x) => x.day === d);
      const byKind = {}; r.forEach((x) => Object.entries(x.by_kind).forEach(([k, v]) => { byKind[k] = (byKind[k] || 0) + v; }));
      return { day: d, productive_min: r.reduce((t, x) => t + x.productive_min, 0), clocked_min: r.reduce((t, x) => t + x.clocked_min, 0), on_plan_min: r.reduce((t, x) => t + x.on_plan_min, 0), people: r.filter((x) => x.productive_min > 0).length, by_kind: byKind };
    });
    // by hour of the day (Jamaica), minutes of work in each hour, all days together
    const byHour = Array(24).fill(0);
    for (const p of pid) {
      for (const [a, b] of union(list.filter((s) => s.user_id === p))) {
        for (let t = a; t < b;) { const h = new Date(t - 5 * 3600000).getUTCHours(); const next = Math.min(b, Math.floor((t - 5 * 3600000) / 3600000 + 1) * 3600000 + 5 * 3600000); byHour[h] += (next - t) / 60000; t = next; }
      }
    }
    const tot = (k) => per.reduce((t, x) => t + x[k], 0);
    return { from: fromDay, to: toDay, kinds: Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, { label: v.label, color: v.color }])),
      totals: { productive_min: tot('productive_min'), clocked_min: tot('clocked_min'), on_plan_min: tot('on_plan_min'), unplanned_min: tot('unplanned_min'), transactions: tot('transactions'), people: per.filter((x) => x.productive_min > 0).length,
        utilisation: tot('clocked_min') > 0 ? Math.min(100, Math.round((tot('productive_min') - tot('labour_min')) / tot('clocked_min') * 100)) : null, top: per[0] && per[0].productive_min ? { user_id: per[0].user_id, name: per[0].name, productive_min: per[0].productive_min } : null },
      people: per, days: perDay, by_hour: byHour.map((m) => Math.round(m)), rows };
  }

  // ------------------------------------------------- endpoints --
  function range(q) {
    const today = jmDay();
    let from = DAY_RE.test(q.from || '') ? q.from : DAY_RE.test(q.day || '') ? q.day : today;
    let to = DAY_RE.test(q.to || '') ? q.to : from;
    if (to < from) [from, to] = [to, from];
    if ((new Date(to) - new Date(from)) / 86400000 > 92) throw httpError(400, 'Pick 93 days or fewer');
    return { from, to };
  }
  // The work slots for a day, as blocks for the timeline / calendar.
  app.get('/api/dayplan/work', requireAdmin, async (req, res) => {
    try {
      const { from, to } = range(req.query);
      const c = await caps(req);
      const ids = c.all && req.query.mine !== '1' ? (req.query.user_id ? [parseInt(req.query.user_id, 10)] : null) : [uid(req)];
      const list = await slots(at(from, '00:00').getTime(), at(addDays(to, 1), '00:00').getTime(), ids);
      res.json({ from, to, kinds: Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, { label: v.label, color: v.color }])), blocks: blocks(list),
        slots: list.map((s) => ({ ...s, start: iso(s.start), end: iso(s.end) })) });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/dayplan/productive', requireAdmin, async (req, res) => {
    try {
      const { from, to } = range(req.query);
      const c = await caps(req);
      const ids = c.all && req.query.mine !== '1' ? null : [uid(req)];
      const r = await report(from, to, ids);
      if (req.query.format === 'csv') {
        const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v));
        const kinds = Object.keys(KINDS);
        const lines = [['Day', 'Person', 'Department', 'Productive hours', 'Clocked hours', 'Busy % of clocked', 'On plan hours', 'Unplanned hours', 'Transactions', ...kinds.map((k) => KINDS[k].label + ' (h)')].join(',')];
        for (const x of r.rows) lines.push([x.day, x.name, x.department, (x.productive_min / 60).toFixed(2), (x.clocked_min / 60).toFixed(2), x.utilisation == null ? '' : x.utilisation, (x.on_plan_min / 60).toFixed(2), (x.unplanned_min / 60).toFixed(2), x.transactions, ...kinds.map((k) => ((x.by_kind[k] || 0) / 60).toFixed(2))].map(esc).join(','));
        res.set('content-type', 'text/csv; charset=utf-8').set('content-disposition', `attachment; filename="productive-hours-${from}-to-${to}.csv"`).send(lines.join('\r\n'));
        return;
      }
      res.json({ ...r, can_see_all: c.all });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/dayplan/worklog/settings', ...canManage, async (req, res) => { try { await ready(); res.json({ settings: await settings(), kinds: KINDS }); } catch (e) { fail(res, e); } });
  app.put('/api/dayplan/worklog/settings', ...canManage, async (req, res) => {
    try {
      await ready();
      const b = req.body || {};
      for (const k of Object.keys(DEFAULTS)) {
        if (b[k] === undefined) continue;
        let v;
        if (k === 'auto_track' || k === 'duties_notify') v = b[k] === true || b[k] === 'on' ? 'on' : 'off';
        else if (k === 'max_open_hours') { v = Number(b[k]); if (!(v >= 1 && v <= 24)) throw httpError(400, 'Longest open slot: 1 to 24 hours'); }
        else { v = parseInt(b[k], 10); if (!(v >= 1 && v <= 240)) throw httpError(400, 'Minutes must be 1 to 240'); }
        await query(`INSERT INTO warehouse_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, ['worklog_' + k, String(v)]);
      }
      sCache = null;
      res.json({ ok: true, settings: await settings() });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------- duties --
  function guessCategory(text) { for (const [re, c] of CAT_WORDS) if (re.test(text)) return c; return 'work'; }
  function dutyLines(desc) {
    return String(desc || '').split(/\r?\n|;|•|·/).map((l) => l.replace(/^\s*([-*–]|\d+[.)])\s*/, '').trim()).filter((l) => l.length > 2 && l.length <= 200).slice(0, 20);
  }
  app.get('/api/dayplan/duties', ...canManage, async (req, res) => {
    try {
      await ready();
      const staff = await dp.staffList();
      const ids = staff.map((s) => s.id);
      const { rows: hr } = await safe('hr', query(`SELECT user_id, job_title, job_description FROM hr_employees WHERE user_id = ANY($1::int[])`, [ids]));
      const { rows: tpl } = await query(`SELECT id, title, category, to_char(start_time, 'HH24:MI') AS start, minutes, weekdays, user_id, department_id, job_title, everyone, notes, active, is_duty FROM dayplan_templates ORDER BY start_time, title`);
      const plans = await dp.planFor(ids, jmDay());
      const titles = [...new Set(hr.map((h) => h.job_title).filter(Boolean))].sort();
      res.json({ titles, people: staff.map((s) => {
        const h = hr.find((x) => x.user_id === s.id) || {};
        const mine = tpl.filter((t) => t.user_id === s.id || (t.department_id && t.department_id === s.department_id) || (t.job_title && h.job_title && t.job_title.toLowerCase() === h.job_title.toLowerCase()) || t.everyone);
        return { user_id: s.id, name: s.name, department: s.department || null, job_title: h.job_title || null, job_description: h.job_description || null,
          suggested: dutyLines(h.job_description).map((l) => ({ title: l, category: guessCategory(l) })), shift: plans[s.id] && plans[s.id].kind === 'shift' ? plans[s.id] : null,
          duties: mine.map((t) => ({ ...t, from: t.user_id ? 'person' : t.job_title ? 'job title' : t.department_id ? 'department' : 'everyone' })) };
      }) });
    } catch (e) { fail(res, e); }
  });
  // Save a list of timed duties for one person, or for everyone with a job title. Replaces that person's / title's duties.
  app.put('/api/dayplan/duties', ...canManage, async (req, res) => {
    try {
      await ready();
      const b = req.body || {};
      const userId = parseInt(b.user_id, 10) || null, title = str(b.job_title, 120);
      if (!userId === !title) throw httpError(400, 'Give a person or a job title');
      const list = Array.isArray(b.duties) ? b.duties.slice(0, 40) : [];
      const wd = Array.isArray(b.weekdays) && b.weekdays.length ? [...new Set(b.weekdays.map(Number).filter((x) => x >= 0 && x <= 6))] : [1, 2, 3, 4, 5, 6];
      const clean = list.map((d) => {
        const t = str(d.title, 140); if (!t) throw httpError(400, 'Each duty needs a name');
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(d.start || '')) throw httpError(400, 'Give a start time for "' + t + '"');
        return { title: t, category: KINDS[d.category] || ['work', 'sales', 'stock', 'cleaning', 'admin', 'delivery', 'training', 'meeting', 'other'].includes(d.category) ? d.category : guessCategory(t),
          start: d.start, minutes: Math.max(5, Math.min(720, parseInt(d.minutes, 10) || 30)), notes: str(d.notes, 500) };
      });
      const c = await deps.getPool().connect();
      try {
        await c.query('BEGIN');
        if (userId) await c.query(`DELETE FROM dayplan_templates WHERE user_id = $1 AND is_duty`, [userId]);
        else await c.query(`DELETE FROM dayplan_templates WHERE lower(job_title) = lower($1) AND is_duty`, [title]);
        for (const d of clean) await c.query(`INSERT INTO dayplan_templates (title, category, start_time, minutes, weekdays, user_id, job_title, notes, active, created_by, is_duty) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9,true)`,
          [d.title, d.category, d.start, d.minutes, wd, userId, userId ? null : title, d.notes, uid(req)]);
        await c.query('COMMIT');
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
      res.json({ ok: true, saved: clean.length });
    } catch (e) { fail(res, e); }
  });
  // Put the day's duties on everyone's calendar now and send each person their list.
  async function sendDuties(day, by) {
    const made = await dp.makeSchedule(day, by);
    let sent = 0;
    if (notice) {
      const { rows } = await query(`SELECT user_id, title, planned_start FROM dayplan_activities WHERE day = $1 AND source = 'template' AND template_id IS NOT NULL ORDER BY planned_start`, [day]);
      const by = {}; rows.forEach((r) => { (by[r.user_id] = by[r.user_id] || []).push(r); });
      for (const [u, list] of Object.entries(by)) {
        await notice([Number(u)], { kind: 'dayplan', title: '📋 Your duties for ' + (day === jmDay() ? 'today' : day) + ' (' + list.length + ')',
          body: list.slice(0, 12).map((r) => (r.planned_start ? hhmm(r.planned_start) + ' ' : '') + r.title).join(' · ') + (list.length > 12 ? ' …' : ''), link: '/day.html#me' });
        sent++;
      }
    }
    return { made: made.made, working: made.working, sent };
  }
  app.post('/api/dayplan/duties/send', ...canManage, async (req, res) => {
    try { await ready(); const day = DAY_RE.test((req.body || {}).day || '') ? req.body.day : jmDay(); res.json({ ok: true, day, ...(await sendDuties(day, uid(req))) }); } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------- the minute tick --
  // Start a planned activity when matching work turns up in its time; send duties once each morning.
  let ticking = false;
  async function tick(nowMs) {
    if (ticking) return; ticking = true;
    try {
      await ready();
      const now = nowMs || Date.now(), today = jmDay(now), s = await settings();
      if (s.duties_notify === 'on' && now >= at(today, '05:00').getTime()) {
        const { rows } = await query(`INSERT INTO dayplan_alerts (kind, ref, day) VALUES ('duties', 'all', $1) ON CONFLICT DO NOTHING RETURNING 1`, [today]);
        if (rows.length) await sendDuties(today, null);
      }
      if (s.auto_track === 'on') {
        const { rows: acts } = await query(`SELECT id, user_id, category, planned_start, planned_end FROM dayplan_activities
          WHERE day = $1 AND status = 'planned' AND planned_start <= $2 AND category NOT IN ('break', 'devotion', 'meeting', 'training')`, [today, new Date(now)]);
        if (acts.length) {
          const list = await slots(at(today, '00:00').getTime(), now + 60000, [...new Set(acts.map((a) => a.user_id))]);
          for (const a of acts) {
            const ps = ms(a.planned_start), pe = ms(a.planned_end);
            const hit = list.find((x) => x.user_id === a.user_id && x.kind !== 'activity' && x.end > ps && x.start < pe && matches(x, a));
            if (hit) await query(`UPDATE dayplan_activities SET status = 'in_progress', actual_start = $2, result = COALESCE(result, $3), updated_at = NOW() WHERE id = $1 AND status = 'planned'`,
              [a.id, new Date(Math.max(ps, hit.start)), 'Started by itself: ' + hit.label]);
          }
        }
      }
    } catch (e) { if (!/does not exist/.test(e.message)) console.warn('[worklog] tick', e.message); }
    finally { ticking = false; }
  }
  if (!deps.noTimer) setInterval(() => tick(), 60000).unref();

  // Work done, for the team calendar (team.js "extra"): the signed-in person's blocks.
  async function calendarExtra(req, from, to) {
    try {
      const f = ms(from), t = ms(to);
      if (!(t > f) || t - f > 62 * 86400000) return [];
      const list = await slots(f, t, [uid(req)]);
      return blocks(list.filter((s) => s.kind !== 'activity')).map((b, i) => ({ source: 'worklog', id: 'wl-' + i + '-' + b.start, title: '⚙ ' + b.title, kind: 'other', all_day: false, start: b.start, end: b.end, link: '/day.html#work' }));
    } catch (_) { return []; }
  }

  return { slots, report, blocks, union, tick, calendarExtra, sendDuties, ready, KINDS };
}

const DDL = `
ALTER TABLE dayplan_templates ADD COLUMN IF NOT EXISTS job_title TEXT;   -- everyone with this job title (hr_employees.job_title)
ALTER TABLE dayplan_templates ADD COLUMN IF NOT EXISTS is_duty BOOLEAN NOT NULL DEFAULT false;   -- one of a person's / job's duties (Duties tab)
`;

module.exports = { register, DDL, KINDS };
