// ensure-db.js
//
// Connects to the Postgres server (not a specific database) and creates the
// Meltha Honda database if it doesn't exist. Used by start-melthahonda.bat so we don't
// depend on a working psql.exe / libpq.dll install on the host machine.
//
// Reads DATABASE_URL from .env. If unset, falls back to the host/user/password
// envvars (PGUSER, PGPASSWORD, PGHOST, PGPORT, PGDATABASE) that the batch file
// exports.

'use strict';

require('dotenv').config();
const { Client } = require('pg');

function parseDbUrl(url) {
  // postgresql://user:pass@host:port/db
  try {
    const u = new URL(url);
    return {
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      host: u.hostname,
      port: parseInt(u.port, 10) || 5432,
      database: u.pathname.replace(/^\//, '') || 'postgres',
    };
  } catch (e) {
    return null;
  }
}

async function main() {
  let cfg;
  if (process.env.DATABASE_URL) {
    cfg = parseDbUrl(process.env.DATABASE_URL);
  }
  if (!cfg) {
    cfg = {
      user: process.env.PGUSER || 'postgres',
      password: process.env.PGPASSWORD || 'postgres',
      host: process.env.PGHOST || 'localhost',
      port: parseInt(process.env.PGPORT || '5432', 10),
      database: process.env.PGDATABASE || 'melthahonda',
    };
  }

  const target = cfg.database;
  // Connect to the maintenance "postgres" database to run CREATE DATABASE.
  const adminCfg = Object.assign({}, cfg, { database: 'postgres' });

  const client = new Client(adminCfg);
  try {
    await client.connect();
  } catch (e) {
    console.error('       ERROR: cannot connect as ' + adminCfg.user +
                  '@' + adminCfg.host + ':' + adminCfg.port + ' -- ' + e.message);
    console.error('       Check your .env DATABASE_URL and that the Postgres ' +
                  'password matches.');
    process.exit(1);
  }

  try {
    const { rows } = await client.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [target]
    );
    if (rows.length) {
      console.log('       Database "' + target + '" exists');
    } else {
      console.log('       Creating database "' + target + '"...');
      // pg-node doesn't support parameterised CREATE DATABASE; escape manually.
      // Only alphanumerics and underscores are expected for our DB name.
      const safe = String(target).replace(/[^a-zA-Z0-9_]/g, '');
      if (!safe) throw new Error('refusing to create database with empty name');
      await client.query('CREATE DATABASE "' + safe + '"');
      console.log('       Database created.');
    }
  } catch (e) {
    console.error('       ERROR creating database -- ' + e.message);
    process.exit(1);
  } finally {
    await client.end().catch(function () {});
  }
}

main().catch(function (e) {
  console.error('       Unexpected error: ' + (e && e.message));
  process.exit(1);
});
