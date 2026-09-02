-- 0014_sync_with_postgres.sql  (D1 / SQLite)
--
-- Brings this schema up to app/schema.sql for the changes made while the
-- Postgres/Express app was the only backend being maintained. See app/PORT.md.
-- SQLite has no `ADD COLUMN IF NOT EXISTS`, so this runs exactly once, in order.
--
-- NOT applied anywhere yet — run with:
--   wrangler d1 execute mortysautoparts-db --local --file migrations/0014_sync_with_postgres.sql
--   wrangler d1 execute mortysautoparts-db          --file migrations/0014_sync_with_postgres.sql

-- ---- key/value config -----------------------------------------------------
-- Replaces the server's *-config.json files, which don't exist on Workers.
-- session_epoch mirrors server.js's in-memory SESSION_EPOCH: bump it to sign
-- every session out at once (functions/_lib/guards.js compares it per request).
CREATE TABLE IF NOT EXISTS app_config (
  key   TEXT PRIMARY KEY,
  value TEXT
);
INSERT OR IGNORE INTO app_config (key, value) VALUES ('session_epoch', '0');

-- ---- disabled accounts + manager-preset / locked favourites --------------
ALTER TABLE users ADD COLUMN disabled    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN forced_favs TEXT;                 -- JSON array of sidebar tab keys, or NULL
ALTER TABLE users ADD COLUMN favs_locked INTEGER NOT NULL DEFAULT 0;

-- ---- backup log ---------------------------------------------------------
-- The off-site-backup *feature* is Postgres-only (needs pg_dump / child_process
-- -- see PORT.md; on D1 use `wrangler d1 export` + Time Travel). The audit
-- table is still worth having for the receiver side.
CREATE TABLE IF NOT EXISTS backup_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  direction  TEXT NOT NULL,
  origin     TEXT,
  filename   TEXT,
  bytes      INTEGER,
  ok         INTEGER NOT NULL DEFAULT 0,
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_backup_log_at ON backup_log (created_at DESC);

-- ---- still to reconcile (do a full structural diff in Phase 1) ----------
-- The D1 0010_pos_full.sql already carries the parts-counter columns, so the
-- big 0010 gap is Postgres-only. Remaining spot checks before Phase 3/4:
--   * pos_sales.tax_exempt / loyalty_* columns present on D1?
--   * pos_quotes.cashier_id vs sales_rep_id naming
--   * users.ui_prefs default matches ('{}' vs NULL)
-- Add follow-up ALTERs here as the diff turns them up.
