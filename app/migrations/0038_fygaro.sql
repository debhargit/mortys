-- 0038_fygaro.sql  (D1 / SQLite)
--
-- Fygaro hosted card checkout for the storefront. The JWT signing secret is a
-- wrangler secret (FYGARO_JWT_SECRET); the non-secret button id + display
-- currency live here. Off unless fygaro_enabled = 1 AND the secret is set.

ALTER TABLE shop_settings ADD COLUMN fygaro_enabled   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE shop_settings ADD COLUMN fygaro_button_id TEXT;      -- the Payment Button UUID from the Fygaro dashboard
ALTER TABLE shop_settings ADD COLUMN fygaro_currency  TEXT NOT NULL DEFAULT 'JMD';

-- Fygaro's transaction id once a webhook confirms payment (orders.payment_ref
-- already exists from 0001; this is just a lookup for reconciliation).
CREATE INDEX IF NOT EXISTS idx_orders_payment_ref ON orders (payment_ref);
