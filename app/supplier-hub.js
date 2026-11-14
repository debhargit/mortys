'use strict';
// =============================================================================
//  Morty's Auto Parts -- one supplier centre
//
//  Payables' Suppliers tab is the one place for suppliers: it brings together
//  what used to be three screens (the Payables supplier centre, Supplier
//  management, and the Admin Suppliers record). All three always read the
//  same suppliers table; this file adds what the merged screen needs:
//
//    GET  /api/ap/supplier-centre        every supplier with what we owe them,
//                                        portal and credit, terms and contact
//    GET  /api/ap/suppliers/:id/record   one supplier's full record
//    GET  /api/ap/supplier-duplicates    suppliers that look like the same one
//                                        (same name once "Ltd", punctuation and
//                                        spacing are ignored, same TRN, same
//                                        email or same phone)
//    GET  /api/ap/suppliers/:id/merge-preview?from=4,9
//    POST /api/ap/suppliers/:id/merge    {from:[4,9]} moves everything from the
//                                        duplicates onto this supplier: bills,
//                                        payments, POs, receipts, parts, portal
//                                        logins, documents... (every column that
//                                        points at a supplier, found from the
//                                        database itself), fills this record's
//                                        blanks from theirs, and leaves each
//                                        duplicate inactive, marked "merged into"
//    GET  /api/ap/supplier-merges        merge history
//    POST /api/ap/supplier-merges/:id/undo   puts a merge back as it was
//
//  Nothing is deleted. A merged supplier stays in the table (inactive, with
//  merged_into_id) so old ledger lines and documents that name it still read,
//  and so an undo can move its rows back.
// =============================================================================

function register(app, deps) {
  const { query, getPool, requireAdmin, requireCap, userCan, books } = deps;
  const AP = [requireAdmin, requireCap('ap.manage')];
  const n = (v) => (v == null || v === '' ? 0 : Number(v));
  const r2 = (v) => Math.round(n(v) * 100) / 100;
  const int = (v) => parseInt(v, 10) || 0;
  function httpError(status, msg) { const e = new Error(msg); e.status = status; e.publicMessage = msg; return e; }
  function fail(res, e) { const s = e.status || 500; if (s >= 500) console.error('[supplier-hub]', e); res.status(s).json({ error: e.publicMessage || e.message }); }
  async function tx(fn) {
    const c = await getPool().connect();
    try { await c.query('BEGIN'); const out = await fn(c); await c.query('COMMIT'); return out; }
    catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} throw e; }
    finally { c.release(); }
  }

  // The columns this needs (also in schema.sql; added here too so the screen
  // works on a database that has not had the schema run since).
  let ready = null;
  function ensure() {
    if (!ready) ready = (async () => {
      await query(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS merged_into_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL`);
      await query(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS merged_at TIMESTAMPTZ`);
      await query(`CREATE TABLE IF NOT EXISTS supplier_merges (
        id          SERIAL PRIMARY KEY,
        kept_id     INTEGER NOT NULL REFERENCES suppliers(id),
        merged_id   INTEGER NOT NULL REFERENCES suppliers(id),
        kept_name   TEXT,
        merged_name TEXT,
        moved       JSONB NOT NULL DEFAULT '[]',
        kept_before JSONB,
        merged_before JSONB,
        merged_by   INTEGER,
        merged_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        undone_at   TIMESTAMPTZ,
        undone_by   INTEGER
      )`);
    })().catch((e) => { ready = null; throw e; });
    return ready;
  }

  // Name as a person would compare it: "NAPA Auto Parts Ltd." = "napa auto parts".
  const SUFFIX = /\b(ltd|limited|co|company|inc|incorporated|llc|corp|corporation|the|ja|jamaica|plc)\b/g;
  function normName(s) {
    return String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(SUFFIX, ' ').replace(/\s+/g, '').trim();
  }
  const digits = (s) => String(s || '').replace(/\D+/g, '');

  // ------------------------------------------------------------ the list --
  app.get('/api/ap/supplier-centre', ...AP, async (req, res) => {
    try {
      await ensure();
      const withInactive = req.query.inactive === '1' || req.query.inactive === 'true';
      const { rows } = await query(
        `SELECT s.id, s.name, s.code, s.contact_name, s.phone, s.email, s.is_active, s.portal_enabled, s.web_retail_enabled,
                s.credit_limit::float AS credit_limit, s.payment_terms, s.payment_terms_days, s.lead_time_days,
                s.merged_into_id, m.name AS merged_into
           FROM suppliers s LEFT JOIN suppliers m ON m.id = s.merged_into_id
          WHERE s.name IS NOT NULL AND s.name <> '' ${withInactive ? '' : 'AND s.is_active'}
          ORDER BY s.name`);
      const by = {};
      for (const s of rows) by[s.id] = Object.assign(s, { open: 0, overdue: 0, credits: 0, bills: 0, next_due: null });
      const docs = books && books.apDocs ? (await books.apDocs(null)).filter((d) => d.open > 0.005) : [];
      const totals = { open: 0, overdue: 0, credits: 0 };
      for (const d of docs) {
        const s = by[d.supplier_id];
        if (d.kind === 'credit') totals.credits = r2(totals.credits + d.open); else { totals.open = r2(totals.open + d.open); if (d.days_overdue > 0) totals.overdue = r2(totals.overdue + d.open); }
        if (!s) continue;   // an inactive supplier still owed money is counted above; shown with "Show inactive"
        if (d.kind === 'credit') s.credits = r2(s.credits + d.open);
        else { s.open = r2(s.open + d.open); s.bills++; if (d.days_overdue > 0) s.overdue = r2(s.overdue + d.open); if (d.due && (!s.next_due || d.due < s.next_due)) s.next_due = d.due; }
      }
      // Inactive suppliers we still owe: listed even when inactive ones are hidden, so nothing owed is out of sight.
      const owedHidden = new Set(docs.map((d) => d.supplier_id).filter((id) => !by[id]));
      if (owedHidden.size) {
        const { rows: extra } = await query(`SELECT id, name, code, contact_name, phone, email, is_active, portal_enabled, web_retail_enabled, credit_limit::float AS credit_limit, payment_terms, payment_terms_days, lead_time_days, merged_into_id FROM suppliers WHERE id = ANY($1::int[])`, [[...owedHidden]]);
        for (const s of extra) {
          by[s.id] = Object.assign(s, { open: 0, overdue: 0, credits: 0, bills: 0, next_due: null });
          for (const d of docs.filter((x) => x.supplier_id === s.id)) {
            if (d.kind === 'credit') s.credits = r2(s.credits + d.open);
            else { s.open = r2(s.open + d.open); s.bills++; if (d.days_overdue > 0) s.overdue = r2(s.overdue + d.open); if (d.due && (!s.next_due || d.due < s.next_due)) s.next_due = d.due; }
          }
        }
      }
      const list = Object.values(by).sort((a, b) => (b.overdue - a.overdue) || (b.open - a.open) || String(a.name).localeCompare(String(b.name)));
      const dup = await duplicateGroups();
      res.json({ suppliers: list, totals, duplicates: dup.length });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------------ one record --
  app.get('/api/ap/suppliers/:id(\\d+)/record', ...AP, async (req, res) => {
    try {
      await ensure();
      const id = int(req.params.id);
      const { rows } = await query(`SELECT s.*, s.credit_limit::float AS credit_limit, m.name AS merged_into FROM suppliers s LEFT JOIN suppliers m ON m.id = s.merged_into_id WHERE s.id = $1`, [id]);
      if (!rows.length) throw httpError(404, 'Supplier not found');
      const { rows: also } = await query(`SELECT id, name, to_char(merged_at, 'YYYY-MM-DD') AS day FROM suppliers WHERE merged_into_id = $1 ORDER BY name`, [id]);
      const portal = await userCan(req, 'suppliers.manage');
      res.json({ supplier: rows[0], merged_from: also, can: { portal } });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------------ duplicates --
  async function duplicateGroups() {
    await ensure();
    const { rows } = await query(
      `SELECT s.id, s.name, s.code, s.phone, s.email, s.tax_id, s.is_active, to_char(s.created_at, 'YYYY-MM-DD') AS created,
              (SELECT COUNT(*)::int FROM ap_bills b WHERE b.supplier_id = s.id) +
              (SELECT COUNT(*)::int FROM purchase_orders p WHERE p.supplier_id = s.id) +
              (SELECT COUNT(*)::int FROM receipts r WHERE r.supplier_id = s.id) AS docs,
              (SELECT COUNT(*)::int FROM products p WHERE p.supplier_id = s.id) AS parts
         FROM suppliers s WHERE s.merged_into_id IS NULL AND s.name IS NOT NULL AND s.name <> ''`);
    // Union-find over the things that say two rows are one supplier.
    const parent = new Map(rows.map((r) => [r.id, r.id]));
    const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    const join = (a, b) => { a = find(a); b = find(b); if (a !== b) parent.set(Math.max(a, b), Math.min(a, b)); };
    const why = new Map();   // "a-b" -> reasons
    const keyed = (label, keyOf) => {
      const seen = new Map();
      for (const r of rows) {
        const k = keyOf(r); if (!k) continue;
        if (seen.has(k)) { const first = seen.get(k); join(first, r.id); const p = Math.min(first, r.id) + '-' + Math.max(first, r.id); (why.get(p) || why.set(p, new Set()).get(p)).add(label); } else seen.set(k, r.id);
      }
    };
    keyed('same name', (r) => { const k = normName(r.name); return k.length >= 3 ? k : null; });
    keyed('same TRN', (r) => { const k = digits(r.tax_id); return k.length >= 6 ? k : null; });
    keyed('same email', (r) => { const k = String(r.email || '').trim().toLowerCase(); return /@/.test(k) ? k : null; });
    keyed('same phone', (r) => { const k = digits(r.phone); return k.length >= 7 ? k.slice(-7) : null; });
    const groups = new Map();
    for (const r of rows) { const g = find(r.id); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(r); }
    const out = [];
    for (const members of groups.values()) {
      if (members.length < 2) continue;
      const ids = new Set(members.map((m) => m.id)), reasons = new Set();
      for (const [p, set] of why) { const [a, b] = p.split('-').map(Number); if (ids.has(a) && ids.has(b)) set.forEach((x) => reasons.add(x)); }
      // Suggest keeping the one with the most history, then the active one, then the oldest.
      members.sort((a, b) => (b.docs + b.parts) - (a.docs + a.parts) || (b.is_active - a.is_active) || a.id - b.id);
      out.push({ keep: members[0].id, reasons: [...reasons], members });
    }
    return out.sort((a, b) => String(a.members[0].name).localeCompare(String(b.members[0].name)));
  }
  app.get('/api/ap/supplier-duplicates', ...AP, async (req, res) => {
    try { res.json({ groups: await duplicateGroups() }); } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------------ merging --
  // Every column that points at a supplier: foreign keys to suppliers(id), plus
  // any integer supplier_id column without one (tables a module made itself).
  async function refColumns(c) {
    const { rows } = await c.query(
      `SELECT DISTINCT cl.relname AS t, a.attname AS col
         FROM pg_constraint k JOIN pg_class cl ON cl.oid = k.conrelid JOIN pg_namespace ns ON ns.oid = cl.relnamespace
         JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = ANY(k.conkey)
        WHERE k.contype = 'f' AND k.confrelid = 'suppliers'::regclass AND ns.nspname = current_schema() AND cl.relname <> 'supplier_merges'
          AND NOT (cl.relname = 'suppliers' AND a.attname = 'merged_into_id')
       UNION
       SELECT c.table_name, c.column_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
        WHERE c.table_schema = current_schema() AND c.column_name = 'supplier_id' AND c.data_type IN ('integer', 'bigint', 'smallint')
          AND c.table_name NOT IN ('suppliers', 'supplier_merges')
        ORDER BY 1, 2`);
    const hasId = new Set((await c.query(`SELECT table_name FROM information_schema.columns WHERE table_schema = current_schema() AND column_name = 'id'`)).rows.map((r) => r.table_name));
    const list = rows.map((r) => ({ t: r.t, col: r.col, where: `${q(r.col)} = $1`, set: `${q(r.col)} = $2`, back: `${q(r.col)} = $1`, hasId: hasId.has(r.t) }));
    // Places that keep a supplier's id as text.
    const textual = [
      ['document_links', `entity_type = 'supplier' AND entity_id = $1::text`, `entity_id = $2::text`],
      ['comm_log', `entity_type = 'supplier' AND entity_id = $1::text`, `entity_id = $2::text`],
      ['commission_rules', `scope = 'supplier' AND scope_value = $1::text`, `scope_value = $2::text`],
    ];
    for (const [t, where, set] of textual) {
      if ((await c.query(`SELECT to_regclass($1) AS r`, [t])).rows[0].r) list.push({ t, col: null, where, set, hasId: hasId.has(t), text: true });
    }
    return list;
  }
  const q = (ident) => '"' + String(ident).replace(/"/g, '""') + '"';

  // How many rows each duplicate would bring across.
  async function preview(c, keepId, fromIds) {
    const refs = await refColumns(c), out = [];
    for (const from of fromIds) {
      const per = [];
      for (const r of refs) {
        const { rows } = await c.query(`SELECT COUNT(*)::int AS k FROM ${q(r.t)} WHERE ${r.where}`, [from]);
        if (rows[0].k) per.push({ table: r.t, column: r.col, rows: rows[0].k });
      }
      out.push({ id: from, moves: per });
    }
    return out;
  }
  const FILL = ['contact_name', 'phone', 'email', 'address', 'website', 'payment_terms', 'payment_terms_days', 'account_number', 'tax_id', 'remit_address', 'default_account_id', 'default_class_id', 'credit_limit', 'credit_set_by', 'lead_time_days'];

  async function loadSuppliers(c, ids) {
    const { rows } = await c.query(`SELECT * FROM suppliers WHERE id = ANY($1::int[]) FOR UPDATE`, [ids]);
    return rows;
  }
  function checkMerge(keepId, fromIds, found) {
    if (!keepId) throw httpError(400, 'Choose the supplier to keep');
    if (!fromIds.length) throw httpError(400, 'Choose the duplicates to merge into it');
    if (fromIds.includes(keepId)) throw httpError(400, 'A supplier cannot be merged into itself');
    const keep = found.find((s) => s.id === keepId);
    if (!keep) throw httpError(404, 'Supplier not found');
    if (keep.merged_into_id) throw httpError(400, keep.name + ' was itself merged into another supplier: keep that one instead');
    for (const id of fromIds) {
      const s = found.find((x) => x.id === id);
      if (!s) throw httpError(404, 'Supplier #' + id + ' not found');
      if (s.merged_into_id) throw httpError(400, s.name + ' is already merged');
    }
    return keep;
  }
  const idsOf = (v) => [...new Set(String(Array.isArray(v) ? v.join(',') : v || '').split(',').map(int).filter(Boolean))];

  app.get('/api/ap/suppliers/:id(\\d+)/merge-preview', ...AP, async (req, res) => {
    try {
      await ensure();
      const keepId = int(req.params.id), fromIds = idsOf(req.query.from);
      const c = await getPool().connect();
      try {
        await c.query('BEGIN READ ONLY');
        const found = (await c.query(`SELECT * FROM suppliers WHERE id = ANY($1::int[])`, [[keepId].concat(fromIds)])).rows;
        const keep = checkMerge(keepId, fromIds, found);
        const moves = await preview(c, keepId, fromIds);
        const fills = [];
        for (const f of FILL) if (f in keep && (keep[f] == null || keep[f] === '')) { const src = found.find((s) => fromIds.includes(s.id) && s[f] != null && s[f] !== ''); if (src) fills.push({ field: f, value: src[f], from: src.name }); }
        res.json({ keep: { id: keep.id, name: keep.name }, from: found.filter((s) => fromIds.includes(s.id)).map((s) => ({ id: s.id, name: s.name, moves: (moves.find((m) => m.id === s.id) || {}).moves || [] })), fills });
      } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
    } catch (e) { fail(res, e); }
  });

  app.post('/api/ap/suppliers/:id(\\d+)/merge', ...AP, async (req, res) => {
    try {
      await ensure();
      if (!(await userCan(req, 'suppliers.manage'))) throw httpError(403, 'Your account is not allowed to manage suppliers, so it cannot merge them.');
      const keepId = int(req.params.id), fromIds = idsOf((req.body || {}).from);
      const out = await tx(async (c) => {
        const found = await loadSuppliers(c, [keepId].concat(fromIds));
        const keep = checkMerge(keepId, fromIds, found);
        const refs = await refColumns(c), done = [];
        for (const fromId of fromIds) {
          const dupe = found.find((s) => s.id === fromId);
          const keptBefore = (await c.query(`SELECT * FROM suppliers WHERE id = $1`, [keepId])).rows[0];
          const moved = [];
          for (const r of refs) {
            await c.query('SAVEPOINT mv');
            try {
              const sql = `UPDATE ${q(r.t)} SET ${r.set} WHERE ${r.where}` + (r.hasId ? ' RETURNING id' : '');
              const u = await c.query(sql, [fromId, keepId]);
              await c.query('RELEASE SAVEPOINT mv');
              if (u.rowCount) moved.push({ table: r.t, column: r.col, text: !!r.text, rows: u.rowCount, ids: r.hasId ? u.rows.map((x) => x.id) : null, kept_back: 0 });
            } catch (e) {
              await c.query('ROLLBACK TO SAVEPOINT mv');
              if (e.code !== '23505') throw e;
              // A unique rule (one catalogue SKU per supplier, one link per document) stops some
              // rows: move them one at a time and leave the ones the kept supplier already has.
              const { rows: each } = await c.query(`SELECT ctid::text AS ct${r.hasId ? ', id' : ''} FROM ${q(r.t)} WHERE ${r.where}`, [fromId]);
              const m = { table: r.t, column: r.col, text: !!r.text, rows: 0, ids: r.hasId ? [] : null, kept_back: 0 };
              for (const row of each) {
                await c.query('SAVEPOINT one');
                try { await c.query(`UPDATE ${q(r.t)} SET ${r.set} WHERE ctid = $3::tid AND ${r.where}`, [fromId, keepId, row.ct]); await c.query('RELEASE SAVEPOINT one'); m.rows++; if (m.ids) m.ids.push(row.id); }
                catch (e2) { await c.query('ROLLBACK TO SAVEPOINT one'); if (e2.code !== '23505') throw e2; m.kept_back++; }
              }
              if (m.rows || m.kept_back) moved.push(m);
            }
          }
          // Fill the kept record's blanks from the duplicate.
          const sets = [], vals = [keepId];
          for (const f of FILL) {
            if (!(f in keptBefore)) continue;
            if ((keptBefore[f] == null || keptBefore[f] === '') && dupe[f] != null && dupe[f] !== '') { vals.push(dupe[f]); sets.push(`${q(f)} = $${vals.length}`); }
          }
          if (dupe.portal_enabled && !keptBefore.portal_enabled) sets.push('portal_enabled = true');
          if (dupe.web_retail_enabled && !keptBefore.web_retail_enabled) sets.push('web_retail_enabled = true');
          let code = null;
          if (!keptBefore.code && dupe.code) { code = dupe.code; await c.query(`UPDATE suppliers SET code = NULL WHERE id = $1`, [fromId]); vals.push(code); sets.push(`code = $${vals.length}`); }
          const aka = 'Also known as ' + dupe.name + ' (merged ' + new Date().toISOString().slice(0, 10) + ')' + (dupe.notes ? ': ' + dupe.notes : '');
          vals.push(aka); sets.push(`notes = CASE WHEN COALESCE(notes, '') = '' THEN $${vals.length} ELSE notes || E'\\n' || $${vals.length} END`);
          await c.query(`UPDATE suppliers SET ${sets.join(', ')} WHERE id = $1`, vals);
          await c.query(`UPDATE suppliers SET is_active = false, merged_into_id = $2, merged_at = NOW(),
                           notes = 'Merged into ' || $3 || ' on ' || to_char(NOW(), 'YYYY-MM-DD') || CASE WHEN COALESCE(notes, '') = '' THEN '' ELSE E'\\n' || notes END
                         WHERE id = $1`, [fromId, keepId, keep.name]);
          const { rows: log } = await c.query(
            `INSERT INTO supplier_merges (kept_id, merged_id, kept_name, merged_name, moved, kept_before, merged_before, merged_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
            [keepId, fromId, keep.name, dupe.name, JSON.stringify(moved), JSON.stringify(keptBefore), JSON.stringify(Object.assign({}, dupe, { code: dupe.code })), (req.session && req.session.userId) || null]);
          done.push({ merge_id: log[0].id, id: fromId, name: dupe.name, moved });
        }
        return { kept: { id: keep.id, name: keep.name }, merged: done };
      });
      res.json(Object.assign({ ok: true }, out));
    } catch (e) { fail(res, e); }
  });

  app.get('/api/ap/supplier-merges', ...AP, async (req, res) => {
    try {
      await ensure();
      const { rows } = await query(
        `SELECT m.id, m.kept_id, m.merged_id, m.kept_name, m.merged_name, m.moved, to_char(m.merged_at, 'YYYY-MM-DD HH24:MI') AS at, to_char(m.undone_at, 'YYYY-MM-DD HH24:MI') AS undone,
                u.name AS by_name
           FROM supplier_merges m LEFT JOIN users u ON u.id = m.merged_by ORDER BY m.merged_at DESC LIMIT 100`);
      res.json({ merges: rows.map((r) => Object.assign(r, { rows: (r.moved || []).reduce((t, x) => t + (x.rows || 0), 0) })) });
    } catch (e) { fail(res, e); }
  });

  // Undo: rows that were moved go back (by their ids, where the table has
  // one), the duplicate is active again as it was, and the blanks filled on the
  // kept record are blank again unless someone has changed them since.
  app.post('/api/ap/supplier-merges/:id(\\d+)/undo', ...AP, async (req, res) => {
    try {
      await ensure();
      if (!(await userCan(req, 'suppliers.manage'))) throw httpError(403, 'Your account is not allowed to manage suppliers.');
      const out = await tx(async (c) => {
        const { rows } = await c.query(`SELECT * FROM supplier_merges WHERE id = $1 FOR UPDATE`, [int(req.params.id)]);
        const m = rows[0];
        if (!m) throw httpError(404, 'Merge not found');
        if (m.undone_at) throw httpError(400, 'That merge was already undone');
        const later = await c.query(`SELECT 1 FROM supplier_merges WHERE undone_at IS NULL AND id > $1 AND ($2 IN (kept_id, merged_id) OR $3 IN (kept_id, merged_id)) LIMIT 1`, [m.id, m.kept_id, m.merged_id]);
        if (later.rows.length) throw httpError(400, 'A later merge involves these suppliers: undo that one first');
        let back = 0, unmovable = [];
        for (const x of m.moved || []) {
          if (!x.ids) { unmovable.push(x.table); continue; }
          if (!x.ids.length) continue;
          const reg = (await c.query(`SELECT to_regclass($1) AS r`, [x.table])).rows[0].r;
          if (!reg) continue;
          const set = x.text ? (x.table === 'commission_rules' ? `scope_value = $1::text` : `entity_id = $1::text`) : `${q(x.column)} = $1`;
          const cur = x.text ? (x.table === 'commission_rules' ? `scope_value = $3::text` : `entity_id = $3::text`) : `${q(x.column)} = $3`;
          const u = await c.query(`UPDATE ${q(x.table)} SET ${set} WHERE id = ANY($2::int[]) AND ${cur}`, [m.merged_id, x.ids, m.kept_id]);
          back += u.rowCount;
        }
        const before = m.merged_before || {}, kb = m.kept_before || {};
        await c.query(`UPDATE suppliers SET merged_into_id = NULL, merged_at = NULL, is_active = $2, notes = $3 WHERE id = $1`, [m.merged_id, before.is_active !== false, before.notes || null]);
        // Blanks filled on the kept record go back to blank if still what the merge put there.
        const kept = (await c.query(`SELECT * FROM suppliers WHERE id = $1`, [m.kept_id])).rows[0];
        const sets = [];
        for (const f of FILL) {
          if (!(f in kept)) continue;
          if ((kb[f] == null || kb[f] === '') && before[f] != null && String(kept[f]) === String(before[f])) sets.push(`${q(f)} = NULL`);
        }
        if (!kb.code && before.code && kept.code === before.code) { sets.push('code = NULL'); }
        if (kb.portal_enabled === false && before.portal_enabled && kept.portal_enabled) sets.push('portal_enabled = false');
        if (kb.web_retail_enabled === false && before.web_retail_enabled && kept.web_retail_enabled) sets.push('web_retail_enabled = false');
        sets.push(`notes = CASE WHEN COALESCE(notes, '') LIKE '%Also known as ' || $3 || '%' THEN $2 ELSE notes END`);
        await c.query(`UPDATE suppliers SET ${sets.join(', ')} WHERE id = $1`, [m.kept_id, kb.notes == null ? null : kb.notes, m.merged_name]);
        if (before.code) await c.query(`UPDATE suppliers SET code = $2 WHERE id = $1 AND code IS NULL AND NOT EXISTS (SELECT 1 FROM suppliers WHERE code = $2)`, [m.merged_id, before.code]);
        await c.query(`UPDATE supplier_merges SET undone_at = NOW(), undone_by = $2 WHERE id = $1`, [m.id, (req.session && req.session.userId) || null]);
        return { moved_back: back, not_moved_back: unmovable };
      });
      res.json(Object.assign({ ok: true }, out));
    } catch (e) { fail(res, e); }
  });

  return { duplicateGroups, normName };
}

module.exports = { register };
