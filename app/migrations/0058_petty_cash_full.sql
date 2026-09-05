-- Full petty cash: categories, an imprest float, a real per-fund ledger
-- (money in AND out), reconciliation, staff advances, receipts, void, and a
-- report. Builds on 0049 (petty_cash_funds, cash_payouts).

CREATE TABLE petty_cash_categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  is_active  INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO petty_cash_categories (name, sort_order) VALUES
 ('Fuel', 1), ('Office supplies', 2), ('Cleaning', 3), ('Refreshments / staff welfare', 4),
 ('Postage / courier', 5), ('Repairs & maintenance', 6), ('Transport / taxi', 7),
 ('Bank charges', 8), ('Sundry / misc', 9);

ALTER TABLE petty_cash_funds ADD COLUMN float_cents             INTEGER NOT NULL DEFAULT 0;
ALTER TABLE petty_cash_funds ADD COLUMN receipt_threshold_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE petty_cash_funds ADD COLUMN location                TEXT;
ALTER TABLE petty_cash_funds ADD COLUMN notes                   TEXT;
ALTER TABLE petty_cash_funds ADD COLUMN closed_at               TEXT;
ALTER TABLE petty_cash_funds ADD COLUMN last_reconciled_at      TEXT;

-- cash_payouts stays "cash physically disbursed from a drawer or a fund".
ALTER TABLE cash_payouts ADD COLUMN category_id        INTEGER REFERENCES petty_cash_categories(id);
ALTER TABLE cash_payouts ADD COLUMN receipt_ref        TEXT;
ALTER TABLE cash_payouts ADD COLUMN receipt_url        TEXT;
ALTER TABLE cash_payouts ADD COLUMN is_advance         INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cash_payouts ADD COLUMN advance_to         TEXT;
ALTER TABLE cash_payouts ADD COLUMN advance_status     TEXT;   -- NULL | open | repaid | expensed
ALTER TABLE cash_payouts ADD COLUMN advance_settled_at TEXT;
ALTER TABLE cash_payouts ADD COLUMN voided            INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cash_payouts ADD COLUMN voided_by         INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE cash_payouts ADD COLUMN voided_at         TEXT;

-- Every non-disbursement fund movement, signed: + adds to the fund.
CREATE TABLE petty_cash_movements (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  fund_id           INTEGER NOT NULL REFERENCES petty_cash_funds(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL CHECK (kind IN
    ('opening','replenishment','reconcile_adjust','transfer_in','transfer_out','void_reversal','advance_repay')),
  delta_cents       INTEGER NOT NULL,
  source            TEXT,               -- 'bank' | 'drawer' | 'fund' | NULL
  drawer_session_id INTEGER REFERENCES cash_drawer_sessions(id),
  ref               TEXT,
  notes             TEXT,
  related_payout_id INTEGER REFERENCES cash_payouts(id),
  related_fund_id   INTEGER REFERENCES petty_cash_funds(id),
  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at        TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_pc_movements_fund ON petty_cash_movements (fund_id, created_at);

CREATE TABLE petty_cash_counts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  fund_id        INTEGER NOT NULL REFERENCES petty_cash_funds(id) ON DELETE CASCADE,
  counted_cents  INTEGER NOT NULL,
  expected_cents INTEGER NOT NULL,
  variance_cents INTEGER NOT NULL,
  notes          TEXT,
  counted_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_pc_counts_fund ON petty_cash_counts (fund_id, created_at);
