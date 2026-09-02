// ============================================================================
//  Morty's Auto Parts — one-shot database bootstrap
//
//  Run once after installing Postgres:    node db-init.js
//
//  It will:
//    1. Connect to the default "postgres" database
//    2. Create the "mortysautoparts" database if it doesn't exist
//    3. Run schema.sql against the new database
//
//  Reads DATABASE_URL from .env to pick up your credentials. If you haven't
//  customised .env yet, the defaults match the .env.example
//  (user=postgres, password=postgres, host=localhost, db=mortysautoparts).
// ============================================================================

'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://postgres:postgres@localhost:5432/mortysautoparts';

// Pull the target database name out of the URL so we can connect to the
// `postgres` system database first to issue CREATE DATABASE.
const url = new URL(DATABASE_URL);
const targetDb = url.pathname.replace(/^\//, '') || 'mortysautoparts';
const adminUrl = new URL(DATABASE_URL);
adminUrl.pathname = '/postgres';

async function main() {
  console.log('Connecting to admin DB to check/create "' + targetDb + '" …');
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    const { rows } = await admin.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [targetDb]
    );
    if (rows.length) {
      console.log('[ok] database "' + targetDb + '" already exists');
    } else {
      await admin.query(`CREATE DATABASE "${targetDb.replace(/"/g, '""')}"`);
      console.log('[ok] database "' + targetDb + '" created');
    }
  } finally {
    await admin.end();
  }

  // Apply schema.sql in the target database.
  console.log('Applying schema.sql to "' + targetDb + '" …');
  const target = new Client({ connectionString: DATABASE_URL });
  await target.connect();
  try {
    const schemaPath = path.join(__dirname, 'schema.sql');
    if (!fs.existsSync(schemaPath)) {
      console.warn('[warn] schema.sql not found — skipping');
    } else {
      const sql = fs.readFileSync(schemaPath, 'utf8');
      await target.query(sql);
      console.log('[ok] schema applied');
    }

    // Promote the first user (or your specified email) to admin so you can
    // sign in to /admin.html right away.
    const adminEmail = (process.argv[2] || process.env.ADMIN_EMAIL || '').toLowerCase().trim();
    if (adminEmail) {
      const r = await target.query(
        'UPDATE users SET is_admin = true WHERE lower(email) = $1 RETURNING id, email',
        [adminEmail]
      );
      if (r.rowCount) console.log('[ok] promoted ' + r.rows[0].email + ' to admin');
      else console.log('[info] no user with email "' + adminEmail + '" yet — sign up at the site first, then re-run with the email');
    }
  } finally {
    await target.end();
  }

  console.log('');
  console.log('Done. You can now start the server:  node server.js');
}

main().catch((e) => {
  console.error('[fatal] db-init failed:', e.message);
  if (e.code === '28P01') {
    console.error('  → Auth failed. Edit .env and set DATABASE_URL with the correct postgres password.');
    console.error('  → Default expected:  postgresql://postgres:postgres@localhost:5432/mortysautoparts');
  }
  if (e.code === 'ECONNREFUSED') {
    console.error('  → Postgres isn\'t listening. Start the Postgres service first.');
  }
  process.exit(1);
});
