-- 0020_cron.sql  (D1 / SQLite)  — Phase 8 of the Cloudflare port
--
-- Scheduled jobs (functions/_lib/jobs.js, run via /api/cron/* + the companion
-- cron-worker). Adds the customer_reminders table (never carried over from
-- schema.sql) and a job_runs audit log. Throttle state lives in app_config.
--
--   wrangler d1 migrations apply meltahonda-db --local
--   wrangler d1 migrations apply meltahonda-db

-- ---- customer reminders (CRM follow-ups; feeds the reminders-digest job) ---
CREATE TABLE IF NOT EXISTS customer_reminders (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  due_date     TEXT NOT NULL,                     -- 'YYYY-MM-DD'
  subject      TEXT NOT NULL,
  body         TEXT,
  assigned_to  INTEGER REFERENCES mechanics(id) ON DELETE SET NULL,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status       TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'done'
  done_at      TEXT,
  created_at   TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_cust_reminders_user ON customer_reminders (user_id);
CREATE INDEX IF NOT EXISTS idx_cust_reminders_due  ON customer_reminders (status, due_date);

-- ---- job run log (observability for the cron endpoints) -------------------
CREATE TABLE IF NOT EXISTS job_runs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  job        TEXT NOT NULL,
  ok         INTEGER NOT NULL DEFAULT 1,
  detail     TEXT,                                -- JSON
  ms         INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_job_runs_job ON job_runs (job, created_at DESC);
