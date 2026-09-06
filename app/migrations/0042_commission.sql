-- 0039_commission.sql  (D1 / SQLite)
--
-- Sales rep commission. Computed at report time from what's already stored
-- (pos_sale_items + the rep credited on the sale), never stored per-sale, so
-- changing a rate retroactively recalculates history the same way the
-- Gross Margin / Sales by Rep reports already do off products.cost_cents.
--
-- A rep has a default commission rate (% of a line's net revenue). A product
-- can override that per line:
--   commission_type = NULL      -> use the crediting rep's default %
--   commission_type = 'percent' -> commission_value is that line's own %
--   commission_type = 'amount'  -> commission_value is a flat J$ per unit
--   commission_type = 'none'    -> the line earns nothing (skip it) --
--                                  core charges, clearance, etc.

ALTER TABLE mechanics ADD COLUMN commission_pct REAL;  -- NULL/0 = no commission by default

ALTER TABLE products ADD COLUMN commission_type  TEXT;  -- NULL | 'percent' | 'amount' | 'none'
ALTER TABLE products ADD COLUMN commission_value REAL;

-- Recorded commission payouts, so "earned" and "already paid" can be told
-- apart per rep -- same shape as account_payments / work_order_payments.
CREATE TABLE IF NOT EXISTS commission_payouts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  mechanic_id  INTEGER NOT NULL REFERENCES mechanics(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL,
  period_from  TEXT,
  period_to    TEXT,
  notes        TEXT,
  paid_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_commission_payouts_mech ON commission_payouts (mechanic_id);
