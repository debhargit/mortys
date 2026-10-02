// Seed `suppliers` from the staged legacy exports.
//
//   node app/tools/load-suppliers.mjs [--replace]
//
// Reads legacy_inventry.supplier (the supplier each part is bought from) and
// legacy_invrec.supplier (who goods were actually received from) -- INVREC
// carries ~40 names that never appear in INVENTRY, so both are needed for the
// purchase-order history to resolve.
//
//   default    additive + idempotent: insert names not already present
//              (case-insensitive on name). Existing rows are left untouched.
//   --replace  TRUNCATE suppliers first. Note this clears products.supplier_id
//              and purchase_orders.supplier_id via their FKs, so re-run
//              load-inventry.mjs and load-invrec.mjs afterwards.
//
// Linking products to suppliers is load-inventry.mjs's job (it resolves
// supplier_id by name as it upserts each part).
//
// The source data is dirty: names are truncated to ~22 chars by the legacy
// field width, there are near-duplicates (DANGEL'S vs DANGELS, MACK CHEM vs
// MACKCHEM) and non-supplier tokens (STOCK TAKING, MISCELLANEOUS). They load
// verbatim; de-duping is a separate manual pass.

import { pool, fmt, ensureLegacySchema } from './lib/db.mjs';

const REPLACE = process.argv.includes('--replace');

const db = pool(2);
const c = await db.connect();
try {
  await ensureLegacySchema(c);
  const { rows: [{ staged }] } = await c.query('SELECT count(*)::int AS staged FROM legacy_inventry');
  if (!staged) {
    console.error('legacy_inventry is empty -- run: node app/tools/stage-legacy.mjs');
    process.exit(1);
  }

  await c.query('BEGIN');

  if (REPLACE) {
    await c.query('TRUNCATE suppliers RESTART IDENTITY CASCADE');
    console.log('suppliers truncated (products.supplier_id / purchase_orders.supplier_id cleared by cascade)');
  }

  // One pass over both sources. legacy_name() drops blanks and non-name junk;
  // DISTINCT ON the lower-cased name keeps one spelling per supplier.
  const { rows: [counts] } = await c.query(`
    WITH src AS (
      SELECT legacy_name(supplier) AS name, 'INVENTRY' AS origin FROM legacy_inventry
      UNION ALL
      SELECT legacy_name(supplier) AS name, 'INVREC'   AS origin FROM legacy_invrec
    ), named AS (
      SELECT name, origin FROM src WHERE name IS NOT NULL
    ), uniq AS (
      SELECT DISTINCT ON (lower(name)) name FROM named ORDER BY lower(name), name
    ), ins AS (
      INSERT INTO suppliers (name, is_active)
      SELECT u.name, true FROM uniq u
       WHERE NOT EXISTS (SELECT 1 FROM suppliers s WHERE lower(btrim(s.name)) = lower(u.name))
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM uniq)::int                              AS distinct_names,
           (SELECT count(*) FROM ins)::int                               AS inserted,
           (SELECT count(DISTINCT lower(name)) FROM named
             WHERE origin = 'INVENTRY')::int                             AS from_inventry,
           (SELECT count(DISTINCT lower(name)) FROM named
             WHERE origin = 'INVREC')::int                               AS from_invrec
  `);

  await c.query('COMMIT');

  const { rows: [{ total }] } = await c.query('SELECT count(*)::int AS total FROM suppliers');
  console.log(`distinct supplier names in source: ${fmt(counts.distinct_names)}`
    + `  (INVENTRY ${fmt(counts.from_inventry)}, INVREC ${fmt(counts.from_invrec)})`);
  console.log(`inserted: ${fmt(counts.inserted)}  |  already present: ${fmt(counts.distinct_names - counts.inserted)}`);
  console.log(`suppliers now: ${fmt(total)}`);
} catch (e) {
  await c.query('ROLLBACK').catch(() => {});
  console.error('FAILED, rolled back:', e.message);
  process.exitCode = 1;
} finally {
  c.release();
  await db.end();
}
