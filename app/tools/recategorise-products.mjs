// ============================================================================
//  recategorise-products.mjs -- file products into the storefront's categories
//
//    node app/tools/recategorise-products.mjs [--dry-run] [--all]
//
//  By default this only touches products whose category is not one the
//  storefront knows about. shop.html recognises exactly eight
//  (engine, body, suspension, electrical, brakes, wheels, fluids, accessories)
//  and silently lumps anything else into Accessories, so a product filed as
//  'Other' is not missing from the shop -- it is in the wrong drawer, which is
//  harder to notice. 21,324 rows arrived that way with an early parts-price
//  import.
//
//  Pass --all to re-file the whole catalogue. That is the one to use after
//  editing the keyword rules in _categorise.mjs, because a rule change that is
//  only applied to some rows leaves the catalogue inconsistent -- two identical
//  descriptions in different categories depending on when they were loaded.
//
//  The rules live in _categorise.mjs and are shared with load-inventry.mjs and
//  seed-from-csv.mjs, so every path into `products` files parts the same way.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { categorise } from './_categorise.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const DRY = process.argv.includes('--dry-run');
const ALL = process.argv.includes('--all');

// Must stay in step with VALID_CATS in shop.html's catalogue loader.
const STOREFRONT_CATS = ['engine', 'body', 'suspension', 'electrical', 'brakes', 'wheels', 'fluids', 'accessories'];

const cfg = JSON.parse(fs.readFileSync(path.join(APP, 'db-config.json'), 'utf8')).local;
const pool = new pg.Pool({
  host: cfg.host, port: cfg.port, database: cfg.database,
  user: cfg.user, password: cfg.password, max: 4,
});

const client = await pool.connect();
try {
  await client.query('BEGIN');
  const { rows } = await client.query(
    ALL ? 'SELECT img, name, category FROM products'
        : 'SELECT img, name, category FROM products WHERE category IS NULL OR NOT (category = ANY($1::text[]))',
    ALL ? [] : [STOREFRONT_CATS]
  );
  console.log((ALL ? 'whole catalogue: ' : 'mis-filed rows: ') + rows.length + ' product(s) examined');
  if (!rows.length) {
    console.log('nothing to do — every product is already in a storefront category');
  } else {
    // Categorise on `name`, which is where the source description lands, and
    // nothing else: load-inventry.mjs and seed-from-csv.mjs both do it that
    // way, and feeding make_model in here as well would file these rows by a
    // rule the other 51,564 never saw.
    const changes = [];
    const dist = {};
    for (const r of rows) {
      const cat = categorise(r.name);
      dist[cat] = (dist[cat] || 0) + 1;
      if (cat !== r.category) changes.push({ img: r.img, category: cat });
    }
    console.log('resulting distribution:');
    for (const [c, n] of Object.entries(dist).sort((a, b) => b[1] - a[1])) {
      console.log('  ' + c.padEnd(12) + String(n).padStart(7));
    }
    console.log('rows whose category actually changes: ' + changes.length);

    // One statement per 5000 rows, joined against an unnested pair of arrays --
    // 21k individual UPDATEs is 21k round trips for a job that is one pass.
    for (let i = 0; i < changes.length; i += 5000) {
      const s = changes.slice(i, i + 5000);
      await client.query(
        `UPDATE products p SET category = v.c, updated_at = now()
           FROM (SELECT * FROM unnest($1::text[], $2::text[]) AS t(img, c)) v
          WHERE p.img = v.img`,
        [s.map((x) => x.img), s.map((x) => x.category)]
      );
    }
  }

  if (DRY) {
    await client.query('ROLLBACK');
    console.log('\n--dry-run: rolled back, nothing changed');
  } else {
    await client.query('COMMIT');
    console.log('\ncommitted');
  }
} catch (e) {
  await client.query('ROLLBACK');
  console.error('\nFAILED -- nothing was changed:', e.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
