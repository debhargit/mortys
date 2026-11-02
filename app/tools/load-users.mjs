// Seed `users` from the staged INVOICE export: the counter staff who rang sales
// up, and the account customers they rang them up for.
//
//   node app/tools/load-users.mjs
//
// Staff  -- the union of INVOICE.SALESPERSN, INVOICE.USER and
//           INVDETAI.SALESPERSN. Loaded as is_staff = true, admin_role
//           'cashier', and placed in the 'sales_rep' user category, which is
//           what server.js's syncStaffProfile()/mechanicsRoleFor() read to
//           mirror a person into `mechanics` (see load-salesreps.mjs).
//
// Customers -- INVOICE.CUSTOMER. 899,385 of 931,078 invoices are to "CASH",
//           which is the walk-in counter rather than a person; those are mapped
//           onto the existing walk-in user instead of creating an account.
//
// Identity: the legacy system has no customer key worth using (CL_NUMBER is
// populated on 2.9% of invoices), so the upper-cased name is the identity and
// a synthetic email carries it, since users.email is UNIQUE and NOT NULL:
//     staff     <slug>@visionautosolutions.com
//     customers <slug>@customer.visionautosolutions.local
// Collisions get a -2, -3 suffix. Re-running matches on that same email, so
// the loader is idempotent and never duplicates a person.
//
// Staff name spellings are collapsed on "letters only, no spaces", which merges
// 'K BLAIR'/'KBLAIR' while correctly keeping 'K MORRISON' and 'F MORRISON'
// apart. The most frequently used spelling wins as the display name.

import { pool, fmt, ensureLegacySchema } from './lib/db.mjs';

// Tokens that appear in SALESPERSN/USER but are not people: workstation and
// branch names the legacy till wrote into the operator field, plus the
// logged-out placeholder. RAV4 and ARCO together account for 78k invoices.
const NOT_A_PERSON = new Set(['RAV4', 'ARCO', 'COUNTER', '[LOGGED OUT]', 'LOGGED OUT', 'NONE', 'N/A']);

const STAFF_DOMAIN = 'visionautosolutions.com';
const CUST_DOMAIN = 'customer.visionautosolutions.local';

function slug(name) {
  const s = String(name || '').toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .replace(/\.{2,}/g, '.');
  return s || 'unknown';
}

// Assign unique emails within `domain`, honouring addresses already in the DB.
function emailer(domain, taken) {
  return (name) => {
    const base = slug(name);
    let addr = `${base}@${domain}`;
    for (let i = 2; taken.has(addr); i++) addr = `${base}-${i}@${domain}`;
    taken.add(addr);
    return addr;
  };
}

// --new-only (the import page): add people the system does not have yet, and
// put only those new staff in the Sales rep group. Existing people -- their
// names, notes and groups, which may have been changed in the new system --
// are left alone.
const NEW_ONLY = process.argv.includes('--new-only');

const db = pool(2);
const c = await db.connect();
try {
  await ensureLegacySchema(c);
  const { rows: [{ staged }] } = await c.query('SELECT count(*)::int AS staged FROM legacy_invoice');
  if (!staged) {
    console.error('legacy_invoice is empty -- run: node app/tools/stage-legacy.mjs');
    process.exit(1);
  }

  // ---- staff ---------------------------------------------------------------
  // Canonical key = upper-cased letters/digits only, so spacing variants merge.
  const { rows: staffRows } = await c.query(`
    WITH src AS (
      SELECT legacy_name(salespersn) AS n FROM legacy_invoice
      UNION ALL SELECT legacy_name(app_user)  AS n FROM legacy_invoice
      UNION ALL SELECT legacy_name(salespersn) AS n FROM legacy_invdetai
    ), named AS (
      SELECT upper(regexp_replace(n, '[^A-Za-z0-9]', '', 'g')) AS key, n
        FROM src WHERE n IS NOT NULL
    ), counted AS (
      SELECT key, n, count(*)::int AS uses FROM named WHERE key <> '' GROUP BY key, n
    )
    SELECT key,
           (array_agg(n ORDER BY uses DESC, n))[1] AS display,
           sum(uses)::int                          AS uses
      FROM counted
     GROUP BY key
     HAVING sum(uses) >= 5          -- below this it is a typo, not a person
     ORDER BY sum(uses) DESC
  `);

  const staff = staffRows.filter((r) => !NOT_A_PERSON.has(r.display.toUpperCase())
    && !NOT_A_PERSON.has(r.key)
    && r.key.length >= 2);
  const droppedStaff = staffRows.filter((r) => !staff.includes(r));

  // ---- customers -----------------------------------------------------------
  // Most recent non-blank contact detail wins; CASH is excluded (walk-in).
  const { rows: custRows } = await c.query(`
    WITH inv AS (
      SELECT legacy_name(customer)                   AS name,
             nullif(btrim(coalesce(phone, '')), '')   AS phone,
             nullif(btrim(coalesce(address1, '')), '') AS addr1,
             nullif(btrim(coalesce(address2, '')), '') AS addr2,
             nullif(btrim(coalesce(cl_number, '')), '') AS cl_number,
             nullif(btrim(coalesce(cred_terms, '')), '') AS terms,
             legacy_date(inv_date)                   AS d,
             legacy_num0(total)                      AS total
        FROM legacy_invoice
       WHERE legacy_name(customer) IS NOT NULL
         AND upper(btrim(customer)) <> 'CASH'
    ), agg AS (
      SELECT upper(name) AS key,
             count(*)::int AS invoices,
             sum(total)    AS spend,
             min(d)        AS first_seen,
             max(d)        AS last_seen
        FROM inv GROUP BY upper(name)
    ), latest AS (
      SELECT DISTINCT ON (upper(name)) upper(name) AS key, name, phone, addr1, addr2, cl_number, terms
        FROM inv
       ORDER BY upper(name), (phone IS NOT NULL) DESC, d DESC NULLS LAST
    )
    SELECT a.key, l.name AS display, l.phone, l.addr1, l.addr2, l.cl_number, l.terms,
           a.invoices, a.spend, a.first_seen, a.last_seen
      FROM agg a JOIN latest l USING (key)
     ORDER BY a.invoices DESC
  `);

  const { rows: [cashCount] } = await c.query(`
    SELECT count(*)::int AS n FROM legacy_invoice WHERE upper(btrim(coalesce(customer, ''))) = 'CASH'`);

  console.log(`staged invoices: ${fmt(staged)}`);
  console.log(`staff names: ${fmt(staff.length)} kept, ${fmt(droppedStaff.length)} dropped`
    + (droppedStaff.length ? ` (${droppedStaff.map((d) => d.display).join(', ')})` : ''));
  console.log(`account customers: ${fmt(custRows.length)}  |  CASH walk-in invoices: ${fmt(cashCount.n)}`);

  // ---- write ---------------------------------------------------------------
  await c.query('BEGIN');

  const { rows: existing } = await c.query('SELECT lower(email) AS email FROM users');
  const taken = new Set(existing.map((r) => r.email));
  const staffEmail = emailer(STAFF_DOMAIN, taken);
  const custEmail = emailer(CUST_DOMAIN, taken);

  // Match an already-loaded person by name so a re-run updates rather than
  // inserting a second row under a -2 email.
  const { rows: byName } = await c.query(
    `SELECT id, lower(email) AS email, upper(btrim(name)) AS uname, is_staff FROM users WHERE name IS NOT NULL`);
  const staffByName = new Map(byName.filter((r) => r.is_staff).map((r) => [r.uname, r.email]));
  const custByName = new Map(byName.filter((r) => !r.is_staff).map((r) => [r.uname, r.email]));

  await c.query(`
    CREATE TEMP TABLE _u (
      email text, name text, phone text, is_staff boolean, admin_role text,
      customer_type text, account_number text, internal_notes text,
      payment_terms_days int
    ) ON COMMIT DROP`);

  const rows = [];
  for (const s of staff) {
    const email = staffByName.get(s.display.toUpperCase()) || staffEmail(s.display);
    rows.push([email, s.display, null, true, 'cashier', null, null,
      `Legacy counter staff; ${fmt(s.uses)} invoice references in the 2009-2026 export.`, null]);
  }
  for (const u of custRows) {
    const email = custByName.get(u.display.toUpperCase()) || custEmail(u.display);
    const addr = [u.addr1, u.addr2].filter(Boolean).join(', ') || null;
    const notes = [
      `Legacy account customer. ${fmt(u.invoices)} invoices`,
      u.first_seen ? `${u.first_seen.toISOString().slice(0, 10)} to ${u.last_seen.toISOString().slice(0, 10)}` : null,
      u.spend != null ? `total billed ${fmt(Number(u.spend).toFixed(2))}` : null,
      addr ? `address: ${addr}` : null,
      u.cl_number ? `legacy CL_NUMBER ${u.cl_number}` : null,
    ].filter(Boolean).join('; ') + '.';
    // CRED_TERMS 'N14'/'N30' is net-days; 'COD' is pay-on-delivery (0 days).
    const m = /^N(\d{1,3})$/.exec(String(u.terms || '').toUpperCase());
    const termDays = m ? Number(m[1]) : (String(u.terms || '').toUpperCase() === 'COD' ? 0 : null);
    rows.push([email, u.display, u.phone, false, 'manager',
      'business', u.cl_number, notes, termDays]);
  }

  const COLS = ['email', 'name', 'phone', 'is_staff', 'admin_role', 'customer_type',
    'account_number', 'internal_notes', 'payment_terms_days'];
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const vals = [];
    const tuples = slice.map((row, n) => {
      const b = n * COLS.length;
      row.forEach((v) => vals.push(v));
      return '(' + COLS.map((_, k) => `$${b + k + 1}`).join(',') + ')';
    });
    await c.query(`INSERT INTO _u (${COLS.join(',')}) VALUES ${tuples.join(',')}`, vals);
  }

  // account_number is UNIQUE; the legacy CL_NUMBER is not, so only carry it
  // across where it is unambiguous.
  await c.query(`
    UPDATE _u SET account_number = NULL
     WHERE account_number IS NOT NULL
       AND (account_number IN (SELECT account_number FROM _u
                                WHERE account_number IS NOT NULL
                                GROUP BY account_number HAVING count(*) > 1)
            OR EXISTS (SELECT 1 FROM users x WHERE x.account_number = _u.account_number))`);

  const ins = await c.query(`
    INSERT INTO users (email, name, phone, is_staff, admin_role, customer_type,
                       account_number, internal_notes, payment_terms_days,
                       email_opt_in, sms_opt_in)
    SELECT email, name, phone, is_staff, admin_role, customer_type,
           account_number, internal_notes, payment_terms_days,
           false, false           -- legacy records carry no marketing consent
      FROM _u
    ` + (NEW_ONLY ? `ON CONFLICT (email) DO NOTHING RETURNING id` : `ON CONFLICT (email) DO UPDATE SET
      name               = EXCLUDED.name,
      phone              = COALESCE(EXCLUDED.phone, users.phone),
      is_staff           = EXCLUDED.is_staff,
      customer_type      = COALESCE(EXCLUDED.customer_type, users.customer_type),
      internal_notes     = EXCLUDED.internal_notes,
      payment_terms_days = COALESCE(EXCLUDED.payment_terms_days, users.payment_terms_days)`));

  // Staff belong to the 'sales_rep' category; that is what makes them show up
  // as a rep in the POS and what load-salesreps.mjs mirrors into `mechanics`.
  const cat = await c.query(`
    INSERT INTO user_category_members (user_id, category_id)
    SELECT u.id, (SELECT id FROM user_categories WHERE code = 'sales_rep')
      FROM users u JOIN _u s ON lower(s.email) = lower(u.email) AND s.is_staff
     WHERE ` + (NEW_ONLY ? `u.id = ANY($1::int[]) AND ` : '') + `NOT EXISTS (
       SELECT 1 FROM user_category_members m
        WHERE m.user_id = u.id
          AND m.category_id = (SELECT id FROM user_categories WHERE code = 'sales_rep'))`,
    NEW_ONLY ? [ins.rows.map((r) => r.id)] : []);

  await c.query('COMMIT');
  if (NEW_ONLY) console.log('@@result ' + JSON.stringify({ step: 'users', added: ins.rowCount, to_sales_rep: cat.rowCount }));

  const { rows: [t] } = await c.query(`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE is_staff)::int      AS staff,
           count(*) FILTER (WHERE NOT is_staff)::int  AS customers,
           count(*) FILTER (WHERE phone IS NOT NULL)::int AS with_phone
      FROM users`);
  console.log(`\nupserted ${fmt(ins.rowCount)} users  |  sales_rep category rows added: ${fmt(cat.rowCount)}`);
  console.log(`users now: ${fmt(t.total)}  (staff ${fmt(t.staff)}, customers ${fmt(t.customers)}, with phone ${fmt(t.with_phone)})`);
} catch (e) {
  await c.query('ROLLBACK').catch(() => {});
  console.error('FAILED, rolled back:', e.message);
  process.exitCode = 1;
} finally {
  c.release();
  await db.end();
}
