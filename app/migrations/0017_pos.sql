-- 0017_pos.sql  (D1 / SQLite)  — Phase 4 of the Cloudflare port (see app/PORT.md)
--
-- Columns the POS read paths (holds, quotes, sale list/detail, customer
-- lookup) need that the D1 conversion left off.
--
--   wrangler d1 migrations apply meltahonda-db --local
--   wrangler d1 migrations apply meltahonda-db

-- ---- customer credit / contact fields (Postgres schema.sql added a block;
-- the D1 conversion only kept price_tier + credit_type/length) -----------
ALTER TABLE users ADD COLUMN discount_pct        REAL;
ALTER TABLE users ADD COLUMN credit_limit_cents  INTEGER;
ALTER TABLE users ADD COLUMN payment_terms_days  INTEGER;
ALTER TABLE users ADD COLUMN discount_limit_pct  REAL;
ALTER TABLE users ADD COLUMN tax_exempt          INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN account_number      TEXT;
ALTER TABLE users ADD COLUMN how_heard           TEXT;
ALTER TABLE users ADD COLUMN rating              INTEGER;
ALTER TABLE users ADD COLUMN internal_notes      TEXT;
ALTER TABLE users ADD COLUMN sms_opt_in          INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN preferred_contact   TEXT;
ALTER TABLE users ADD COLUMN sales_rep_id        INTEGER REFERENCES mechanics(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_users_account_number ON users (account_number);

-- ---- pos_sales.tax_exempt (recorded on the sale, not derived at read time)
ALTER TABLE pos_sales ADD COLUMN tax_exempt INTEGER NOT NULL DEFAULT 0;

-- ---- pos_holds.held_by_name (denormalised alongside held_by, so a recalled
-- hold still shows who parked it even if the staff row is gone) ----------
ALTER TABLE pos_holds ADD COLUMN held_by_name TEXT;

-- ---- pos_quotes.cashier_id (Postgres carries it) ---------------------
ALTER TABLE pos_quotes ADD COLUMN cashier_id INTEGER;
