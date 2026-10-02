// Build the sales-rep roster in `mechanics` from the staged INVDETAI export.
//
//   node app/tools/load-salesreps.mjs
//
// pos_sales.sales_rep_id is a FK to mechanics(id), so "sales rep" in this schema
// is a `mechanics` row. server.js keeps that table as a mirror of staff users
// (see syncStaffProfile / mechanicsRoleFor): a user in the 'sales_rep' category
// maps to mechanics.role = 'advisor' and is linked by mechanics.user_id. This
// loader reproduces exactly that shape, so reps created here behave like reps
// created through the admin UI.
//
// Run load-users.mjs first -- it creates the staff users and their 'sales_rep'
// category membership from the same names.
//
// Each rep's line-level sales from INVDETAI (lines, units, revenue, date span)
// are recorded in mechanics.notes, which is the only free-text field on the
// table and makes the roster self-documenting.
//
// Never deletes: a mechanics row may already be referenced by a POS sale or a
// work order. Reps who no longer appear are deactivated, matching how
// syncStaffProfile() retires staff.

import { pool, fmt, ensureLegacySchema } from './lib/db.mjs';

const db = pool(2);
const c = await db.connect();
try {
  await ensureLegacySchema(c);
  const { rows: [{ staged }] } = await c.query('SELECT count(*)::int AS staged FROM legacy_invdetai');
  if (!staged) {
    console.error('legacy_invdetai is empty -- run: node app/tools/stage-legacy.mjs');
    process.exit(1);
  }
  const { rows: [{ staffusers }] } = await c.query(
    `SELECT count(*)::int AS staffusers FROM users WHERE is_staff`);
  if (staffusers < 2) {
    console.error('no staff users yet -- run: node app/tools/load-users.mjs');
    process.exit(1);
  }

  // Per-rep line stats, keyed the same way load-users.mjs keys staff names
  // (letters/digits only, upper-cased) so they join back to the staff user.
  const { rows: stats } = await c.query(`
    SELECT upper(regexp_replace(legacy_name(salespersn), '[^A-Za-z0-9]', '', 'g')) AS key,
           count(*)::int                                  AS lines,
           coalesce(sum(legacy_num0(quantity)), 0)::numeric AS units,
           coalesce(sum(legacy_num0(amount)), 0)::numeric   AS revenue,
           min(legacy_date(ddate))                        AS first_sale,
           max(legacy_date(ddate))                        AS last_sale
      FROM legacy_invdetai
     WHERE legacy_name(salespersn) IS NOT NULL
     GROUP BY 1
     HAVING upper(regexp_replace(legacy_name(salespersn), '[^A-Za-z0-9]', '', 'g')) <> ''
  `);
  const byKey = new Map(stats.map((s) => [s.key, s]));

  // The roster itself is the staff users in the 'sales_rep' category.
  const { rows: reps } = await c.query(`
    SELECT u.id, u.name, u.email, u.phone,
           upper(regexp_replace(u.name, '[^A-Za-z0-9]', '', 'g')) AS key
      FROM users u
      JOIN user_category_members m ON m.user_id = u.id
      JOIN user_categories cat ON cat.id = m.category_id AND cat.code = 'sales_rep'
     WHERE u.is_staff AND NOT u.is_archived
     ORDER BY u.name`);

  console.log(`staged sale lines: ${fmt(staged)}  |  reps on the staff roster: ${fmt(reps.length)}`);
  const noLines = reps.filter((r) => !byKey.has(r.key));
  const unmatched = stats.filter((s) => !reps.some((r) => r.key === s.key));
  if (noLines.length) {
    console.log(`reps with no INVDETAI lines (header-only attribution): ${noLines.map((r) => r.name).join(', ')}`);
  }
  if (unmatched.length) {
    console.log(`INVDETAI rep names with no staff user: ${fmt(unmatched.length)}`
      + ` (${unmatched.slice(0, 6).map((s) => `${s.key}x${s.lines}`).join(', ')}${unmatched.length > 6 ? ', ...' : ''})`);
  }

  await c.query('BEGIN');

  await c.query(`
    CREATE TEMP TABLE _r (user_id int, name text, email text, phone text, notes text)
    ON COMMIT DROP`);

  const rows = reps.map((r) => {
    const s = byKey.get(r.key);
    const notes = s
      ? `Legacy sales rep. ${fmt(s.lines)} sale lines, ${fmt(Math.round(Number(s.units)))} units, `
        + `${fmt(Number(s.revenue).toFixed(2))} billed`
        + (s.first_sale ? `, ${s.first_sale.toISOString().slice(0, 10)} to ${s.last_sale.toISOString().slice(0, 10)}` : '')
        + ' (from INVDETAI).'
      : 'Legacy counter staff; no line-level attribution in INVDETAI.';
    return [r.id, r.name, r.email, r.phone, notes];
  });

  const COLS = ['user_id', 'name', 'email', 'phone', 'notes'];
  for (let i = 0; i < rows.length; i += 500) {
    const slice = rows.slice(i, i + 500);
    const vals = [];
    const tuples = slice.map((row, n) => {
      const b = n * COLS.length;
      row.forEach((v) => vals.push(v));
      return '(' + COLS.map((_, k) => `$${b + k + 1}`).join(',') + ')';
    });
    await c.query(`INSERT INTO _r (${COLS.join(',')}) VALUES ${tuples.join(',')}`, vals);
  }

  // hourly_rate_usd is NOT NULL with no default; 0 is the honest value for a
  // counter rep who is not billed out by the hour, and is what
  // syncStaffProfile() inserts too.
  const upd = await c.query(`
    UPDATE mechanics m
       SET name = r.name, email = r.email, phone = r.phone,
           role = 'advisor', is_active = true, notes = r.notes
      FROM _r r WHERE m.user_id = r.user_id`);

  const ins = await c.query(`
    INSERT INTO mechanics (user_id, name, email, phone, role, hourly_rate_usd, is_active, notes)
    SELECT r.user_id, r.name, r.email, r.phone, 'advisor', 0, true, r.notes
      FROM _r r
     WHERE NOT EXISTS (SELECT 1 FROM mechanics m WHERE m.user_id = r.user_id)`);

  const off = await c.query(`
    UPDATE mechanics SET is_active = false
     WHERE is_active AND role = 'advisor'
       AND user_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM _r r WHERE r.user_id = mechanics.user_id)`);

  await c.query('COMMIT');

  const { rows: [t] } = await c.query(`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE is_active)::int                        AS active,
           count(*) FILTER (WHERE user_id IS NOT NULL)::int              AS linked
      FROM mechanics`);
  console.log(`\ninserted ${fmt(ins.rowCount)} reps  |  updated ${fmt(upd.rowCount)}  |  deactivated ${fmt(off.rowCount)}`);
  console.log(`mechanics now: ${fmt(t.total)}  (active ${fmt(t.active)}, linked to a user ${fmt(t.linked)})`);

  const { rows: leaders } = await c.query(`
    SELECT m.name, m.notes FROM mechanics m WHERE m.is_active ORDER BY m.name LIMIT 100`);
  console.log('\nroster:');
  for (const l of leaders) console.log(`  ${l.name.padEnd(13)} ${l.notes}`);
} catch (e) {
  await c.query('ROLLBACK').catch(() => {});
  console.error('FAILED, rolled back:', e.message);
  process.exitCode = 1;
} finally {
  c.release();
  await db.end();
}
