-- Petty cash + payouts: a cash payout can be recorded straight out of the
-- open till session (subtracted from its expected-cash figure at close), or
-- against a standing petty-cash fund that's replenished independently.
-- Replenishing a fund from the drawer is itself a drawer payout (so the
-- transfer still shows up in that till's reconciliation) plus a fund credit.
CREATE TABLE petty_cash_funds (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  balance_cents INTEGER NOT NULL DEFAULT 0,
  custodian_id  INTEGER REFERENCES users(id),
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE cash_payouts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  amount_cents      INTEGER NOT NULL,
  reason            TEXT NOT NULL,
  paid_to           TEXT,
  notes             TEXT,
  source_type       TEXT NOT NULL CHECK (source_type IN ('drawer', 'fund')),
  drawer_session_id INTEGER REFERENCES cash_drawer_sessions(id),
  fund_id           INTEGER REFERENCES petty_cash_funds(id),
  authorized_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at        TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_cash_payouts_drawer ON cash_payouts (drawer_session_id);
CREATE INDEX idx_cash_payouts_fund ON cash_payouts (fund_id);
