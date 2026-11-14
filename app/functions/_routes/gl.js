// General ledger, ported from the till (gl.js) to D1. Same routes and reply
// shapes, so accounting.html works unchanged on the website.
//
//   /api/gl/status, accounts (+ sub-accounts, ledger, IIF import), map,
//   entries, journal, reverse, trial-balance, tieout, periods, export/iif|csv,
//   exports
//
// The automatic posting engine (sales, payments, receipts... -> entries) reads
// the till's own documents, so it runs on the till only: /api/gl/setup,
// /api/gl/post-now and /api/gl/settings answer 409 here. Entries reach the
// website with the till's data sync (tools/pg2d1.mjs).
//
// Amounts in gl_lines are J$ numbers (REAL), as on the till. Dates are
// YYYY-MM-DD text; gl_periods.month is the month's first day.
import { d1 } from '../_lib/db.js';
import { adminMw, roleCanManage } from '../_lib/guards.js';

const QB_TYPES = { BANK: 'asset', AR: 'asset', OCASSET: 'asset', FIXASSET: 'asset', OASSET: 'asset', AP: 'liability', CCARD: 'liability', OCLIAB: 'liability',
  LTLIAB: 'liability', EQUITY: 'equity', INC: 'income', COGS: 'cogs', EXP: 'expense', EXINC: 'other_income', EXEXP: 'other_expense' };
const SKIP_PAY = ['charge', 'account', 'credit_note'];
const n = (v) => (v == null ? 0 : Number(v) || 0);
const r2 = (v) => Math.round(n(v) * 100) / 100;
const httpError = (status, message) => Object.assign(new Error(message), { status });
const dateArg = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s || '') ? s : null);
const JM_TODAY = "date('now', '-5 hours')";   // Jamaica has no daylight saving

export default function mount(app) {
  const DB = (c) => d1(c.env);
  const userId = (c) => (c.get('user') || {}).id || null;
  async function setting(db, key, dflt) {
    const r = await db.one('SELECT value FROM warehouse_settings WHERE key = ?', key);
    return r && r.value != null ? r.value : dflt;
  }
  // acct.* are supervisory: managers/owners, or granted by name.
  const can = (key) => async (c, next) => {
    const u = c.get('user');
    let ok = !!(u && (u.admin_role === 'owner' || (await roleCanManage(c.env, u.admin_role))));
    if (!ok && u) { let p = {}; try { p = u.perms ? JSON.parse(u.perms) : {}; } catch { p = {}; } ok = p[key] === true; }
    if (!ok) return c.json({ error: 'Your account is not allowed to do that.' }, 403);
    await next();
  };
  const fail = (c, e) => {
    if (e && e.status) return c.json({ error: e.message }, e.status);
    if (/UNIQUE constraint/i.test(String(e && e.message))) return c.json({ error: 'That code is already used' }, 409);
    console.error('[gl]', e);
    return c.json({ error: 'Server error' }, 500);
  };
  const body = async (c) => c.req.json().catch(() => ({}));
  const tillOnly = (c) => c.json({ error: 'Automatic posting runs on the shop till. Start the ledger and post from the till; entries reach the website with the next data sync.', till_only: true }, 409);

  async function chart(db) {
    const a = await db.many('SELECT * FROM gl_accounts');
    const byKey = {}, byId = {};
    for (const x of a) { byId[x.id] = x; if (x.system_key) byKey[x.system_key] = x.id; }
    const acct = (k) => { if (!byKey[k]) throw httpError(409, 'No account set up for ' + k); return byKey[k]; };
    return { byKey, byId, acct };
  }

  // One entry, atomically (one D1 batch). Lines: [{a, amt (+Dr/-Cr), party, memo}].
  // Anything that does not add up goes to Suspense, as on the till.
  async function insertEntry(db, ch, e) {
    let lines = e.lines.map((l) => ({ ...l, amt: r2(l.amt) })).filter((l) => l.amt !== 0);
    const off = r2(lines.reduce((s, l) => s + l.amt, 0));
    if (off !== 0) lines.push({ a: ch.acct('suspense'), amt: -off, memo: 'Does not add up: ' + off.toFixed(2) + ' to review' });
    if (lines.length < 2) return null;
    const entryOf = '(SELECT id FROM gl_entries WHERE source_kind = ? AND source_id = ?)';
    const stmts = [
      { sql: `INSERT INTO gl_entries (entry_date, book, source_kind, source_id, source_ref, memo, reverses_id, posted_by) VALUES (?,?,?,?,?,?,?,?)`,
        binds: [e.date, e.book, e.kind, e.id, e.ref || null, e.memo || '', e.reverses || null, e.userId || null] },
      { sql: `UPDATE gl_entries SET number = 'JE-' || printf('%06d', id) WHERE id = ${entryOf}`, binds: [e.kind, e.id] },
      ...lines.map((l) => ({ sql: `INSERT INTO gl_lines (entry_id, account_id, amount, party, memo) VALUES (${entryOf},?,?,?,?)`,
        binds: [e.kind, e.id, l.a, l.amt, l.party || null, l.memo ? String(l.memo).slice(0, 200) : null] })),
    ];
    if (e.reverses) stmts.push({ sql: `UPDATE gl_entries SET reversed_by = ${entryOf} WHERE id = ? AND reversed_by IS NULL`, binds: [e.kind, e.id, e.reverses] });
    await db.batch(stmts);
    const r = await db.one('SELECT id FROM gl_entries WHERE source_kind = ? AND source_id = ?', e.kind, e.id);
    return r ? r.id : null;
  }
  const monthClosed = async (db, date) => !!(await db.one('SELECT 1 AS x FROM gl_periods WHERE substr(month, 1, 7) = substr(?, 1, 7)', date));

  // ------------------------------------------------------------ status --
  app.get('/api/gl/status', adminMw, can('acct.view'), async (c) => {
    try {
      const db = DB(c);
      const start = await setting(db, 'gl_start_at', null);
      const cnt = await db.one('SELECT COUNT(*) AS entries, MAX(entry_date) AS last_date FROM gl_entries');
      const sus = await db.one("SELECT COALESCE(SUM(l.amount), 0) AS bal FROM gl_lines l JOIN gl_accounts a ON a.id = l.account_id WHERE a.system_key = 'suspense'");
      const unnamed = await db.one("SELECT COUNT(*) AS n FROM gl_accounts WHERE is_active = 1 AND (qb_name IS NULL OR qb_name = '')");
      const closed = await db.many('SELECT substr(month, 1, 7) AS month, closed_at FROM gl_periods ORDER BY month DESC LIMIT 24');
      let startDate = null;
      if (start) { const d = await db.one("SELECT date(?, '-5 hours') AS d", start); startDate = d && d.d; }
      return c.json({ started: !!start, start_at: start, start_date: startDate,
        auto_post: (await setting(db, 'gl_auto_post', 'on')) === 'on', pending: {}, entries: cnt.entries, last_date: cnt.last_date ? String(cnt.last_date).slice(0, 10) : null,
        last_run: null, errors: [], suspense: r2(sus.bal), accounts_without_qb_name: unnamed.n, closed,
        stock_days_done: await setting(db, 'gl_stock_day_done', null), posting: 'till' });
    } catch (e) { return fail(c, e); }
  });
  app.post('/api/gl/setup', adminMw, can('acct.setup'), tillOnly);
  app.post('/api/gl/post-now', adminMw, can('acct.post'), tillOnly);
  app.put('/api/gl/settings', adminMw, can('acct.setup'), tillOnly);

  // ---------------------------------------------------- chart & mapping --
  app.get('/api/gl/accounts', adminMw, can('acct.view'), async (c) => {
    try {
      const rows = await DB(c).many(
        `SELECT a.*, COALESCE(SUM(l.amount), 0) AS balance, COUNT(l.id) AS lines
           FROM gl_accounts a LEFT JOIN gl_lines l ON l.account_id = a.id GROUP BY a.id ORDER BY a.code`);
      const byId = new Map(rows.map((r) => [r.id, r]));
      const depth = (r) => { let d = 0, p = r; while (p && p.parent_id && d < 20) { p = byId.get(p.parent_id); d++; } return d; };
      const roll = new Map(rows.map((r) => [r.id, n(r.balance)]));
      for (const r of rows) { let p = r.parent_id ? byId.get(r.parent_id) : null, g = 0; while (p && g++ < 20) { roll.set(p.id, roll.get(p.id) + n(r.balance)); p = p.parent_id ? byId.get(p.parent_id) : null; } }
      const kids = new Map(); for (const r of rows) if (r.parent_id) kids.set(r.parent_id, (kids.get(r.parent_id) || 0) + 1);
      return c.json({ accounts: rows.map((r) => ({ ...r, is_active: !!r.is_active, balance: r2(r.balance), depth: depth(r), rollup: r2(roll.get(r.id)), sub_count: kids.get(r.id) || 0,
        parent_code: r.parent_id && byId.get(r.parent_id) ? byId.get(r.parent_id).code : null })), qb_types: Object.keys(QB_TYPES) });
    } catch (e) { return fail(c, e); }
  });
  function cleanAccount(b, partial) {
    const out = {};
    if (!partial || b.code !== undefined) { out.code = String(b.code || '').trim().slice(0, 20); if (!out.code) throw httpError(400, 'Give the account a code'); }
    if (!partial || b.name !== undefined) { out.name = String(b.name || '').trim().slice(0, 120); if (!out.name) throw httpError(400, 'Give the account a name'); }
    if (b.qb_type !== undefined || !partial) {
      out.qb_type = String(b.qb_type || '').toUpperCase();
      if (!QB_TYPES[out.qb_type]) throw httpError(400, 'Choose the QuickBooks account type');
      out.type = QB_TYPES[out.qb_type];
    }
    if (b.qb_name !== undefined) out.qb_name = String(b.qb_name || '').replace(/[\t\r\n]/g, ' ').trim().slice(0, 159) || null;
    if (b.is_active !== undefined) out.is_active = b.is_active ? 1 : 0;
    if (b.notes !== undefined) out.notes = String(b.notes || '').slice(0, 300) || null;
    return out;
  }
  const oneAccount = async (db, id) => { const a = await db.one('SELECT * FROM gl_accounts WHERE id = ?', id); if (a) a.is_active = !!a.is_active; return a; };
  app.post('/api/gl/accounts', adminMw, can('acct.setup'), async (c) => {
    try {
      const db = DB(c), b = await body(c);
      const parentId = parseInt(b.parent_id, 10) || null;
      let a, parent = null;
      if (parentId) {
        // Sub-account: code = parent code + "-" + 1 to 4 digits; type from the parent; QB name Parent:Child.
        parent = await db.one('SELECT * FROM gl_accounts WHERE id = ?', parentId);
        if (!parent) throw httpError(404, 'Parent account not found');
        const sub = String(b.sub_no == null ? '' : b.sub_no).trim();
        if (!/^\d{1,4}$/.test(sub)) throw httpError(400, 'The sub-account number must be 1 to 4 digits');
        a = cleanAccount(Object.assign({}, b, { code: parent.code + '-' + sub, qb_type: parent.qb_type || 'EXP' }), false);
        a.type = parent.type;
        if (!a.qb_name) a.qb_name = (parent.qb_name || parent.name) + ':' + a.name;
      } else a = cleanAccount(b, false);
      const r = await db.run('INSERT INTO gl_accounts (code, name, type, qb_type, qb_name, notes, parent_id) VALUES (?,?,?,?,?,?,?)',
        a.code, a.name, a.type, a.qb_type, a.qb_name || a.name, a.notes || null, parent ? parent.id : null);
      return c.json({ account: await oneAccount(db, r.meta.last_row_id) });
    } catch (e) { return fail(c, e); }
  });
  app.patch('/api/gl/accounts/:id', adminMw, can('acct.setup'), async (c) => {
    try {
      const db = DB(c), id = parseInt(c.req.param('id'), 10) || 0;
      const a = cleanAccount(await body(c), true);
      const cur = await db.one('SELECT a.*, EXISTS (SELECT 1 FROM gl_lines l WHERE l.account_id = a.id) AS used FROM gl_accounts a WHERE a.id = ?', id);
      if (!cur) throw httpError(404, 'Account not found');
      if (cur.used && a.type && a.type !== cur.type) throw httpError(409, 'This account has entries: its type cannot change from ' + cur.type);
      if (cur.system_key && a.is_active === 0) throw httpError(409, 'The posting rules use this account; point the rule elsewhere first');
      if (cur.parent_id) { delete a.code; delete a.type; delete a.qb_type; }   // fixed by the parent
      const kid = await db.one('SELECT 1 AS x FROM gl_accounts WHERE parent_id = ? LIMIT 1', id);
      if (kid && ((a.code && a.code !== cur.code) || (a.type && a.type !== cur.type)))
        throw httpError(409, 'This account has sub-accounts: their codes and type come from it, so its code and type cannot change');
      const keys = Object.keys(a);
      if (!keys.length) throw httpError(400, 'Nothing to change');
      await db.run(`UPDATE gl_accounts SET ${keys.map((k) => k + ' = ?').join(', ')} WHERE id = ?`, ...keys.map((k) => a[k]), id);
      return c.json({ account: await oneAccount(db, id) });
    } catch (e) { return fail(c, e); }
  });

  // QuickBooks chart import (IIF !ACCNT rows): match by QuickBooks name, else add.
  app.post('/api/gl/accounts/import-iif', adminMw, can('acct.setup'), async (c) => {
    try {
      const db = DB(c);
      const text = String((await body(c)).text || '');
      if (text.length > 2000000) throw httpError(400, 'File too large');
      let head = null; const found = [];
      for (const ln of text.split(/\r?\n/)) {
        const cols = ln.split('\t');
        if (cols[0] === '!ACCNT') { head = cols.map((x) => x.toUpperCase()); continue; }
        if (cols[0] === 'ACCNT' && head) {
          const get = (k) => { const i = head.indexOf(k); return i >= 0 ? (cols[i] || '').trim() : ''; };
          const name = get('NAME').replace(/^"|"$/g, ''), type = get('ACCNTTYPE').toUpperCase();
          if (name && QB_TYPES[type]) found.push({ name, type, num: get('ACCNUM'), desc: get('DESC') });
        }
      }
      if (!found.length) throw httpError(400, 'No accounts found: export the chart of accounts from QuickBooks as an IIF file');
      let added = 0, matched = 0;
      for (const f of found) {
        const m = await db.one('SELECT id FROM gl_accounts WHERE lower(qb_name) = lower(?) OR lower(name) = lower(?) LIMIT 1', f.name, f.name);
        if (m) { await db.run('UPDATE gl_accounts SET qb_name = ?, qb_type = ? WHERE id = ?', f.name, f.type, m.id); matched++; continue; }
        let code = f.num || 'QB' + String(added + 1).padStart(3, '0');
        if (await db.one('SELECT 1 AS x FROM gl_accounts WHERE code = ?', code)) code = code + '-QB';
        await db.run('INSERT INTO gl_accounts (code, name, type, qb_name, qb_type, notes) VALUES (?,?,?,?,?,?) ON CONFLICT(code) DO NOTHING',
          code, f.name.split(':').pop().slice(0, 120), QB_TYPES[f.type], f.name, f.type, f.desc || 'From QuickBooks');
        added++;
      }
      return c.json({ found: found.length, matched, added });
    } catch (e) { return fail(c, e); }
  });

  app.get('/api/gl/map', adminMw, can('acct.view'), async (c) => {
    try {
      const db = DB(c);
      const keysOf = async (sql) => { try { return (await db.many(sql)).map((x) => x.k).filter(Boolean); } catch { return []; } };
      const m = await db.many('SELECT m.*, a.code, a.name FROM gl_map m JOIN gl_accounts a ON a.id = m.account_id ORDER BY m.kind, m.key');
      const cats = await keysOf("SELECT DISTINCT lower(category) AS k FROM products WHERE category IS NOT NULL AND category <> '' ORDER BY 1");
      const pm = [...await keysOf('SELECT DISTINCT lower(method) AS k FROM sale_payments WHERE method IS NOT NULL'),
        ...await keysOf('SELECT DISTINCT lower(method) AS k FROM account_payments WHERE method IS NOT NULL'),
        ...await keysOf('SELECT DISTINCT lower(refund_method) AS k FROM pos_returns WHERE refund_method IS NOT NULL')];
      const tp = await keysOf("SELECT DISTINCT lower(reason) AS k FROM till_movements WHERE kind = 'payout' AND reason IS NOT NULL ORDER BY 1 LIMIT 50");
      const keys = {
        pay_method: [...new Set(['cash', 'cheque', 'card', 'bank', 'gift_card', 'store_credit', 'loyalty', 'gift_card_issue', ...pm])].filter((k) => !SKIP_PAY.includes(k)),
        pay_out_method: ['cash', 'cheque', 'bank', 'card', 'commission'],
        revenue_category: cats, cogs_category: cats,
        stock_reason: ['count', 'requisition', 'po_quick_receive', 'regrade', 'writeoff', 'vendor_claim', 'other'], till_payout: tp,
      };
      const fallback = { pay_method: 'suspense', pay_out_method: 'bank', revenue_category: 'sales', cogs_category: 'cogs', stock_reason: 'inv_adjust', till_payout: 'petty_expense' };
      return c.json({ map: m, keys, fallback });
    } catch (e) { return fail(c, e); }
  });
  app.put('/api/gl/map', adminMw, can('acct.setup'), async (c) => {
    try {
      const db = DB(c), b = await body(c);
      const kinds = ['pay_method', 'pay_out_method', 'revenue_category', 'cogs_category', 'stock_reason', 'till_payout'];
      if (!kinds.includes(b.kind)) throw httpError(400, 'Unknown rule');
      const key = String(b.key || '').trim().toLowerCase().slice(0, 80);
      if (!key) throw httpError(400, 'Which one?');
      if (b.account_id == null || b.account_id === '') {
        await db.run('DELETE FROM gl_map WHERE kind = ? AND key = ?', b.kind, key);
      } else {
        if (!(await db.one('SELECT id FROM gl_accounts WHERE id = ? AND is_active = 1', b.account_id))) throw httpError(400, 'Choose an active account');
        await db.run('INSERT INTO gl_map (kind, key, account_id) VALUES (?,?,?) ON CONFLICT(kind, key) DO UPDATE SET account_id = excluded.account_id', b.kind, key, b.account_id);
      }
      return c.json({ ok: true });
    } catch (e) { return fail(c, e); }
  });

  // ---------------------------------------------------------- journal --
  app.get('/api/gl/entries', adminMw, can('acct.view'), async (c) => {
    try {
      const q = c.req.query(), binds = [], where = [];
      const add = (sql, ...v) => { where.push(sql); binds.push(...v); };
      if (dateArg(q.from)) add('e.entry_date >= ?', q.from);
      if (dateArg(q.to)) add('e.entry_date <= ?', q.to);
      if (q.book) add('e.book = ?', String(q.book));
      if (q.source) add('e.source_kind = ?', String(q.source));
      if (q.account) add('EXISTS (SELECT 1 FROM gl_lines x WHERE x.entry_id = e.id AND x.account_id = ?)', parseInt(q.account, 10) || 0);
      if (q.q) { const s = '%' + String(q.q).slice(0, 60) + '%'; add('(e.number LIKE ? OR e.source_ref LIKE ? OR e.memo LIKE ?)', s, s, s); }
      const rows = await DB(c).many(
        `SELECT e.*, substr(e.entry_date, 1, 10) AS entry_date, u.name AS posted_by_name,
                (SELECT COALESCE(SUM(amount), 0) FROM gl_lines l WHERE l.entry_id = e.id AND l.amount > 0) AS total
           FROM gl_entries e LEFT JOIN users u ON u.id = e.posted_by
          ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY e.entry_date DESC, e.id DESC LIMIT 500`, ...binds);
      return c.json({ entries: rows.map((r) => ({ ...r, total: r2(r.total) })) });
    } catch (e) { return fail(c, e); }
  });
  app.get('/api/gl/entries/:id', adminMw, can('acct.view'), async (c) => {
    try {
      const db = DB(c), id = parseInt(c.req.param('id'), 10) || 0;
      const entry = await db.one('SELECT e.*, substr(e.entry_date, 1, 10) AS entry_date, u.name AS posted_by_name FROM gl_entries e LEFT JOIN users u ON u.id = e.posted_by WHERE e.id = ?', id);
      if (!entry) throw httpError(404, 'Entry not found');
      const lines = await db.many('SELECT l.*, a.code, a.name, a.type FROM gl_lines l JOIN gl_accounts a ON a.id = l.account_id WHERE l.entry_id = ? ORDER BY l.amount DESC, l.id', id);
      return c.json({ entry, lines: lines.map((l) => ({ ...l, amount: r2(l.amount) })) });
    } catch (e) { return fail(c, e); }
  });

  // Manual journal: {date, memo, ref, lines:[{account_id, debit, credit, party, memo}]}
  app.post('/api/gl/journal', adminMw, can('acct.post'), async (c) => {
    try {
      const db = DB(c), b = await body(c);
      if (!(await setting(db, 'gl_start_at', null))) throw httpError(409, 'Start the ledger first');
      const date = dateArg(b.date);
      if (!date) throw httpError(400, 'Give the date');
      const memo = String(b.memo || '').trim().slice(0, 300);
      if (memo.length < 3) throw httpError(400, 'Say what the entry is for');
      const lines = (Array.isArray(b.lines) ? b.lines : [])
        .map((l) => ({ a: parseInt(l.account_id, 10), amt: r2(n(l.debit) - n(l.credit)), party: l.party ? String(l.party).trim().slice(0, 41) : null, memo: l.memo ? String(l.memo).slice(0, 200) : null }))
        .filter((l) => l.a && l.amt);
      if (lines.length < 2) throw httpError(400, 'An entry needs at least two lines with amounts');
      const off = r2(lines.reduce((s, l) => s + l.amt, 0));
      if (off) throw httpError(400, 'Debits and credits differ by ' + off.toFixed(2));
      const ch = await chart(db);
      for (const l of lines) {
        if (!ch.byId[l.a] || !ch.byId[l.a].is_active) throw httpError(400, 'Unknown or inactive account');
        if (['ar', 'ap'].includes(ch.byId[l.a].system_key) && !l.party) throw httpError(400, 'Lines on ' + ch.byId[l.a].name + ' need a customer or supplier name');
      }
      if (await monthClosed(db, date)) throw httpError(409, 'The books for that month are closed');
      const nx = await db.one("SELECT COALESCE(MAX(source_id), 0) + 1 AS n FROM gl_entries WHERE source_kind = 'manual'");
      const id = await insertEntry(db, ch, { book: 'manual', kind: 'manual', id: nx.n, date, ref: b.ref ? String(b.ref).slice(0, 40) : null, memo, lines, userId: userId(c) });
      return c.json({ id });
    } catch (e) { return fail(c, e); }
  });

  // Reverse an entry: a mirror entry dated today (or the date given).
  app.post('/api/gl/entries/:id/reverse', adminMw, can('acct.post'), async (c) => {
    try {
      const db = DB(c), b = await body(c), eid = parseInt(c.req.param('id'), 10) || 0;
      const memo = String(b.memo || '').trim();
      if (memo.length < 3) throw httpError(400, 'Say why it is being reversed');
      const e = await db.one('SELECT * FROM gl_entries WHERE id = ?', eid);
      if (!e) throw httpError(404, 'Entry not found');
      if (e.reversed_by) throw httpError(409, 'Already reversed');
      if (e.reverses_id || e.source_kind === 'reversal') throw httpError(409, 'This is itself a reversal');
      const ch = await chart(db);
      const ls = await db.many('SELECT * FROM gl_lines WHERE entry_id = ?', e.id);
      const date = dateArg(b.date) || (await db.one(`SELECT ${JM_TODAY} AS d`)).d;
      if (await monthClosed(db, date)) throw httpError(409, 'The books for that month are closed: reverse into an open month');
      const id = await insertEntry(db, ch, { book: e.book, kind: 'reversal', id: e.id, date, ref: e.number, reverses: e.id,
        memo: 'Reversal of ' + e.number + ': ' + memo.slice(0, 200), lines: ls.map((l) => ({ a: l.account_id, amt: -n(l.amount), party: l.party, memo: l.memo })), userId: userId(c) });
      return c.json({ id });
    } catch (e) { return fail(c, e); }
  });

  // ----------------------------------------------------------- reports --
  app.get('/api/gl/trial-balance', adminMw, can('acct.view'), async (c) => {
    try {
      const from = dateArg(c.req.query('from')), to = dateArg(c.req.query('to'));
      if (!from || !to || from > to) throw httpError(400, 'Choose a from and to date');
      const rows = await DB(c).many(
        `SELECT a.id, a.code, a.name, a.type, a.qb_name, a.system_key,
                COALESCE(SUM(CASE WHEN e.entry_date < ?1 THEN l.amount END), 0) AS opening,
                COALESCE(SUM(CASE WHEN e.entry_date BETWEEN ?1 AND ?2 AND l.amount > 0 THEN l.amount END), 0) AS debits,
                COALESCE(-SUM(CASE WHEN e.entry_date BETWEEN ?1 AND ?2 AND l.amount < 0 THEN l.amount END), 0) AS credits,
                COALESCE(SUM(CASE WHEN e.entry_date <= ?2 THEN l.amount END), 0) AS closing
           FROM gl_accounts a LEFT JOIN gl_lines l ON l.account_id = a.id LEFT JOIN gl_entries e ON e.id = l.entry_id
          GROUP BY a.id HAVING COUNT(l.id) > 0 OR a.is_active = 1 ORDER BY a.code`, from, to);
      const acc = rows.map((r) => ({ ...r, opening: r2(r.opening), debits: r2(r.debits), credits: r2(r.credits), closing: r2(r.closing) }));
      const tot = acc.reduce((s, r) => ({ debits: s.debits + r.debits, credits: s.credits + r.credits }), { debits: 0, credits: 0 });
      const period = (types) => -acc.filter((r) => types.includes(r.type)).reduce((s, r) => s + (r.debits - r.credits), 0);
      const income = r2(period(['income'])), cogs = r2(-period(['cogs'])), expense = r2(-period(['expense'])), otherNet = r2(period(['other_income', 'other_expense']));
      const bs = (t) => r2(acc.filter((r) => r.type === t).reduce((s, r) => s + r.closing, 0));
      const earningsToDate = r2(-acc.filter((r) => ['income', 'cogs', 'expense', 'other_income', 'other_expense'].includes(r.type)).reduce((s, r) => s + r.closing, 0));
      return c.json({
        from, to, accounts: acc, totals: { debits: r2(tot.debits), credits: r2(tot.credits), balanced: r2(tot.debits - tot.credits) === 0 },
        income_statement: { income, cogs, gross_profit: r2(income - cogs), expenses: expense, other: otherNet, net: r2(income - cogs - expense + otherNet) },
        balance_sheet: { assets: bs('asset'), liabilities: r2(-bs('liability')), equity: r2(-bs('equity')), earnings_to_date: earningsToDate,
          check: r2(bs('asset') + bs('liability') + bs('equity') - earningsToDate) },
      });
    } catch (e) { return fail(c, e); }
  });

  app.get('/api/gl/accounts/:id/ledger', adminMw, can('acct.view'), async (c) => {
    try {
      const db = DB(c), id = parseInt(c.req.param('id'), 10) || 0;
      const from = dateArg(c.req.query('from')), to = dateArg(c.req.query('to'));
      if (!from || !to) throw httpError(400, 'Choose a from and to date');
      const a = await oneAccount(db, id);
      if (!a) throw httpError(404, 'Account not found');
      const op = await db.one('SELECT COALESCE(SUM(l.amount), 0) AS b FROM gl_lines l JOIN gl_entries e ON e.id = l.entry_id WHERE l.account_id = ? AND e.entry_date < ?', id, from);
      const rows = await db.many(
        `SELECT e.id AS entry_id, e.number, substr(e.entry_date, 1, 10) AS entry_date, e.source_kind, e.source_ref, e.memo AS entry_memo, l.amount, l.party, l.memo
           FROM gl_lines l JOIN gl_entries e ON e.id = l.entry_id WHERE l.account_id = ? AND e.entry_date BETWEEN ? AND ?
          ORDER BY e.entry_date, e.id LIMIT 5000`, id, from, to);
      let bal = r2(op.b);
      return c.json({ account: a, opening: bal, lines: rows.map((r) => { bal = r2(bal + n(r.amount)); return { ...r, amount: r2(r.amount), balance: bal }; }), closing: bal });
    } catch (e) { return fail(c, e); }
  });

  // Tie-out: control accounts against the website's own records (amounts in
  // cents there). Checks whose source tables live only on the till show no
  // system figure.
  app.get('/api/gl/tieout', adminMw, can('acct.view'), async (c) => {
    try {
      const db = DB(c);
      const bal = await db.many('SELECT a.system_key, COALESCE(SUM(l.amount), 0) AS b FROM gl_accounts a LEFT JOIN gl_lines l ON l.account_id = a.id WHERE a.system_key IS NOT NULL GROUP BY a.system_key');
      const gl = Object.fromEntries(bal.map((r) => [r.system_key, r2(r.b)]));
      const one = async (sql) => { try { const r = await db.one(sql); return r ? r2(r.v) : null; } catch { return null; } };
      const checks = [
        { key: 'inventory', label: 'Inventory', gl: gl.inventory, system: await one('SELECT COALESCE(SUM(stock_count * COALESCE(cost_cents, 0)), 0) / 100.0 AS v FROM products WHERE stock_count > 0'),
          note: 'Stock on hand at average cost. Differences come from cost changes on stock already held, sales of stock not on hand, and receiving outside the Receive screen.' },
        { key: 'ar', label: 'Accounts receivable', gl: gl.ar, system: await one(`SELECT ((SELECT COALESCE(SUM(balance_due_cents), 0) FROM pos_sales WHERE COALESCE(voided, 0) = 0)
                                   - (SELECT COALESCE(SUM(amount_cents), 0) FROM account_payments)) / 100.0 AS v`),
          note: 'Balances due on sales, less payments received on account.' },
        { key: 'ap', label: 'Accounts payable', gl: -n(gl.ap), system: null, note: 'Supplier balances are kept on the till.' },
        { key: 'grni', label: 'Goods received, not billed', gl: -n(gl.grni), system: null, note: 'Receiving is kept on the till.' },
        { key: 'gift_cards', label: 'Gift cards and store credit', gl: -n(gl.gift_cards), system: await one('SELECT COALESCE(SUM(balance_cents), 0) / 100.0 AS v FROM gift_cards WHERE is_active = 1'),
          note: 'Unspent balances.' },
        { key: 'cash_drawers', label: 'Cash in drawers', gl: gl.cash_drawers, system: null,
          note: 'Should be the floats and takings of drawers open now; zero when every drawer is closed through the cashier module.' },
        { key: 'suspense', label: 'Suspense', gl: gl.suspense, system: 0, note: 'Postings that did not add up. Should be zero: open the account to see what landed here.' },
      ].map((x) => ({ ...x, gl: r2(x.gl), difference: x.system == null ? null : r2(n(x.gl) - n(x.system)) }));
      return c.json({ checks });
    } catch (e) { return fail(c, e); }
  });

  // -------------------------------------------------------- periods --
  app.post('/api/gl/periods', adminMw, can('acct.close'), async (c) => {
    try {
      const db = DB(c), b = await body(c);
      const m = String(b.month || '');
      if (!/^\d{4}-\d{2}$/.test(m)) throw httpError(400, 'Which month (YYYY-MM)?');
      const r = await db.one(`SELECT date(? || '-01', '+1 month') <= ${JM_TODAY} AS ended`, m);
      if (!r.ended) throw httpError(409, 'That month has not ended yet');
      await db.run('INSERT INTO gl_periods (month, closed_by, note) VALUES (?, ?, ?) ON CONFLICT(month) DO NOTHING', m + '-01', userId(c), String(b.note || '').slice(0, 200) || null);
      return c.json({ ok: true });
    } catch (e) { return fail(c, e); }
  });
  app.delete('/api/gl/periods/:month', adminMw, can('acct.close'), async (c) => {
    try {
      const db = DB(c), m = String(c.req.param('month') || ''), b = await body(c);
      if (!/^\d{4}-\d{2}$/.test(m)) throw httpError(400, 'Which month?');
      const ex = await db.one(`SELECT COUNT(*) AS n FROM gl_exports WHERE kind = 'iif' AND from_date <= date(? || '-01', '+1 month', '-1 day') AND to_date >= ? || '-01'`, m, m);
      if (ex.n && !(b && b.confirm_exported)) throw httpError(409, 'This month was already sent to QuickBooks. Reopen only if you will correct QuickBooks too.');
      const r = await db.run('DELETE FROM gl_periods WHERE substr(month, 1, 7) = ?', m);
      if (!r.meta.changes) throw httpError(404, 'That month is not closed');
      console.log('[gl] month', m, 'reopened by user', userId(c));
      return c.json({ ok: true });
    } catch (e) { return fail(c, e); }
  });

  // --------------------------------------------------------- exports --
  const iifText = (s) => String(s == null ? '' : s).replace(/[\t\r\n"]/g, ' ').trim();
  const usDate = (d) => { const [y, m, dd] = String(d).slice(0, 10).split('-'); return m + '/' + dd + '/' + y; };

  // QuickBooks Desktop IIF: one general journal per day and book, lines summed by
  // account (and customer / supplier on A/R and A/P). A day mixing A/R and A/P is
  // split in two through Suspense, which nets to zero.
  app.get('/api/gl/export/iif', adminMw, can('acct.export'), async (c) => {
    try {
      const db = DB(c);
      const from = dateArg(c.req.query('from')), to = dateArg(c.req.query('to'));
      if (!from || !to || from > to) throw httpError(400, 'Choose a from and to date');
      const done = await db.one('SELECT COUNT(*) AS n FROM gl_entries WHERE entry_date BETWEEN ? AND ? AND export_id IS NOT NULL', from, to);
      if (done.n && c.req.query('again') !== '1') throw httpError(409, done.n + ' entries in these dates were already exported. Importing them again would double them in QuickBooks. Add again=1 only if QuickBooks does not have them.');
      const rows = await db.many(
        `SELECT substr(e.entry_date, 1, 10) AS entry_date, e.book, a.id AS account_id, a.qb_name, a.qb_type, a.system_key,
                CASE WHEN a.qb_type IN ('AR', 'AP') THEN COALESCE(l.party, CASE WHEN a.qb_type = 'AR' THEN 'Cash Sales' ELSE 'Supplier' END) END AS party,
                SUM(l.amount) AS amount, COUNT(DISTINCT e.id) AS entries
           FROM gl_entries e JOIN gl_lines l ON l.entry_id = e.id JOIN gl_accounts a ON a.id = l.account_id
          WHERE e.entry_date BETWEEN ? AND ?
          GROUP BY 1, 2, 3, 4, 5, 6, 7 HAVING ROUND(SUM(l.amount), 2) <> 0 ORDER BY 1, 2, 5`, from, to);
      const missing = [...new Set(rows.filter((r) => !r.qb_name).map((r) => r.account_id))];
      if (missing.length) throw httpError(409, 'Give these accounts their QuickBooks name first (Accounts tab): ' + missing.join(', '));
      const sus = await db.one("SELECT qb_name FROM gl_accounts WHERE system_key = 'suspense'");
      const clearing = sus ? sus.qb_name : 'Suspense';
      const out = ['!ACCNT\tNAME\tACCNTTYPE\tDESC'];
      const accts = new Map(rows.map((r) => [r.qb_name, r.qb_type]));
      accts.set(clearing, 'EXP');
      for (const [nm, ty] of accts) out.push(['ACCNT', iifText(nm), ty, 'Morty\'s Auto Parts'].join('\t'));
      const custs = [...new Set(rows.filter((r) => r.qb_type === 'AR').map((r) => r.party))], vends = [...new Set(rows.filter((r) => r.qb_type === 'AP').map((r) => r.party))];
      if (custs.length) { out.push('!CUST\tNAME'); for (const x of custs) out.push('CUST\t' + iifText(x)); }
      if (vends.length) { out.push('!VEND\tNAME'); for (const v of vends) out.push('VEND\t' + iifText(v)); }
      out.push('!TRNS\tTRNSID\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM\tMEMO');
      out.push('!SPL\tSPLID\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM\tMEMO');
      out.push('!ENDTRNS');
      const groups = new Map();
      for (const r of rows) { const k = r.entry_date + '|' + r.book; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
      let journals = 0;
      const emit = (date, doc, memo, lines) => {
        if (lines.length < 2) return;
        lines.forEach((l, i) => out.push([i === 0 ? 'TRNS' : 'SPL', '', 'GENERAL JOURNAL', usDate(date), iifText(l.qb_name), iifText(l.party || ''),
          r2(l.amount).toFixed(2), doc, iifText(memo)].join('\t')));
        out.push('ENDTRNS');
        journals++;
      };
      for (const [k, ls] of groups) {
        const [date, book] = k.split('|');
        const doc = 'VAS-' + date.replace(/-/g, '') + '-' + book.slice(0, 3).toUpperCase();
        const memo = 'Morty\'s ' + book + ' summary ' + date;
        const ar = ls.filter((l) => l.qb_type === 'AR'), ap = ls.filter((l) => l.qb_type === 'AP');
        if (ar.length && ap.length) {
          const apSum = r2(ap.reduce((s, l) => s + n(l.amount), 0));
          emit(date, doc + 'P', memo + ' (payables)', [...ap, { qb_name: clearing, amount: -apSum }]);
          emit(date, doc, memo, [...ls.filter((l) => l.qb_type !== 'AP'), { qb_name: clearing, amount: apSum }]);
        } else emit(date, doc, memo, ls);
      }
      const ex = await db.run("INSERT INTO gl_exports (kind, from_date, to_date, entries, created_by) VALUES ('iif', ?, ?, ?, ?)",
        from, to, rows.reduce((s, r) => s + n(r.entries), 0), userId(c));
      await db.run('UPDATE gl_entries SET export_id = ? WHERE entry_date BETWEEN ? AND ? AND export_id IS NULL', ex.meta.last_row_id, from, to);
      return c.body(out.join('\r\n') + '\r\n', 200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="mortys-quickbooks-${from}-to-${to}.iif"`,
        'X-Journals': String(journals),
      });
    } catch (e) { return fail(c, e); }
  });

  app.get('/api/gl/export/csv', adminMw, can('acct.export'), async (c) => {
    try {
      const db = DB(c);
      const from = dateArg(c.req.query('from')), to = dateArg(c.req.query('to'));
      if (!from || !to || from > to) throw httpError(400, 'Choose a from and to date');
      const rows = await db.many(
        `SELECT e.number, substr(e.entry_date, 1, 10) AS date, e.book, e.source_kind, e.source_ref, e.memo AS entry_memo,
                a.code, a.name AS account, a.qb_name, MAX(l.amount, 0) AS debit, MAX(-l.amount, 0) AS credit, l.party, l.memo
           FROM gl_entries e JOIN gl_lines l ON l.entry_id = e.id JOIN gl_accounts a ON a.id = l.account_id
          WHERE e.entry_date BETWEEN ? AND ? ORDER BY e.entry_date, e.id, l.id`, from, to);
      const q = (v) => { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
      const cols = ['number', 'date', 'book', 'source_kind', 'source_ref', 'entry_memo', 'code', 'account', 'qb_name', 'debit', 'credit', 'party', 'memo'];
      await db.run("INSERT INTO gl_exports (kind, from_date, to_date, entries, created_by) VALUES ('csv', ?, ?, ?, ?)", from, to, rows.length, userId(c));
      return c.body([cols.join(',')].concat(rows.map((r) => cols.map((k) => q(r[k])).join(','))).join('\n'), 200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="mortys-journal-${from}-to-${to}.csv"`,
      });
    } catch (e) { return fail(c, e); }
  });

  app.get('/api/gl/exports', adminMw, can('acct.view'), async (c) => {
    try {
      const rows = await DB(c).many('SELECT x.*, substr(x.from_date, 1, 10) AS from_date, substr(x.to_date, 1, 10) AS to_date, u.name AS by_name FROM gl_exports x LEFT JOIN users u ON u.id = x.created_by ORDER BY x.id DESC LIMIT 50');
      return c.json({ exports: rows });
    } catch (e) { return fail(c, e); }
  });
}
