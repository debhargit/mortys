-- 0018_pos_txn.sql  (D1 / SQLite)  — Phase 5 of the Cloudflare port
--
-- What the sale / void / return transactions need: gift cards, the full
-- refund breakdown on pos_returns, and the seeded walk-in customer.
--
--   wrangler d1 migrations apply mortysautoparts-db --local
--   wrangler d1 migrations apply mortysautoparts-db

-- ---- gift cards (store credit + gift-card tender) ---------------------
CREATE TABLE IF NOT EXISTS gift_cards (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  code                  TEXT UNIQUE NOT NULL,
  initial_balance_cents INTEGER NOT NULL DEFAULT 0,
  balance_cents         INTEGER NOT NULL DEFAULT 0,
  is_active             INTEGER NOT NULL DEFAULT 1,
  issued_to_name        TEXT,
  issued_to_phone       TEXT,
  issued_by             INTEGER REFERENCES users(id) ON DELETE SET NULL,
  notes                 TEXT,
  last_used_at          TEXT,
  created_at            TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS gift_card_transactions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  gift_card_id INTEGER NOT NULL REFERENCES gift_cards(id) ON DELETE CASCADE,
  delta_cents  INTEGER NOT NULL,
  reason       TEXT NOT NULL,          -- issue | redemption | reload | adjust
  reference    TEXT,
  performed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_gc_txn_card ON gift_card_transactions (gift_card_id);

-- ---- pos_returns: full refund breakdown (D1 had only refund_cents) -----
ALTER TABLE pos_returns ADD COLUMN refund_subtotal_cents      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pos_returns ADD COLUMN refund_discount_cents      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pos_returns ADD COLUMN refund_tax_cents           INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pos_returns ADD COLUMN store_credit_code          TEXT;
ALTER TABLE pos_returns ADD COLUMN loyalty_points_clawed_back INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pos_returns ADD COLUMN loyalty_points_recredited  INTEGER NOT NULL DEFAULT 0;

-- ---- pos_return_items: unit price snapshot (credit-note detail) --------
ALTER TABLE pos_return_items ADD COLUMN unit_price_cents INTEGER;

-- ---- walk-in customer (getWalkinCustomerId) --------------------------
-- The POS ticket bar attaches every walk-in ticket to this one real row.
INSERT OR IGNORE INTO users (email, name, password_hash, is_admin, admin_role, price_tier, account_number)
VALUES ('walkin@mortysautoparts.local', 'Cash Customer - Walk-in', 'x-not-a-login', 0, 'manager', 'retail', 'C-000001');
