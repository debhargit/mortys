-- Recurring charges: a plan generates a real charge on a schedule, targeting
-- either a storefront order (invoiced by email) or a POS account sale. Runs
-- through the same scheduled-job engine as every other digest (_lib/jobs.js,
-- /api/cron/:job) -- no new scheduling infrastructure, just a new job.
CREATE TABLE recurring_plans (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id       INTEGER NOT NULL REFERENCES users(id),
  target            TEXT NOT NULL CHECK (target IN ('order', 'pos_account_sale')),
  description       TEXT NOT NULL,
  items_json        TEXT NOT NULL,   -- [{description, qty, unit_price_usd, product_img?}]
  frequency         TEXT NOT NULL CHECK (frequency IN ('weekly', 'monthly', 'quarterly', 'yearly')),
  next_run_date     TEXT NOT NULL,
  end_date          TEXT,
  occurrences_left  INTEGER,
  is_active         INTEGER NOT NULL DEFAULT 1,
  notes             TEXT,
  created_by        INTEGER REFERENCES users(id),
  created_at        TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_recurring_plans_next_run ON recurring_plans (next_run_date) WHERE is_active = 1;

CREATE TABLE recurring_plan_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id     INTEGER NOT NULL REFERENCES recurring_plans(id) ON DELETE CASCADE,
  run_date    TEXT NOT NULL,
  order_id    INTEGER,
  sale_id     INTEGER,
  status      TEXT NOT NULL CHECK (status IN ('ok', 'failed')),
  error       TEXT,
  created_at  TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_recurring_plan_runs_plan ON recurring_plan_runs (plan_id);
