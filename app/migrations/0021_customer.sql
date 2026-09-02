-- 0021_customer.sql  (D1 / SQLite)  — Phase 10 of the Cloudflare port
--
-- Customer-facing completion: checkout (coupons + loyalty), signup, account
-- pages (addresses / messages / saved vehicles), newsletter, service booking.
--
--   wrangler d1 migrations apply mortysautoparts-db --remote

-- ---- coupons (schema.sql had them; D1 never did) ------------------------
CREATE TABLE IF NOT EXISTS coupons (
  code            TEXT PRIMARY KEY,
  kind            TEXT NOT NULL DEFAULT 'flat',   -- 'flat' | 'percent'
  amount          REAL NOT NULL,                  -- dollars (flat) or percent
  min_subtotal    REAL DEFAULT 0,
  max_redemptions INTEGER,
  redeemed_count  INTEGER NOT NULL DEFAULT 0,
  expires_at      TEXT,
  is_active       INTEGER NOT NULL DEFAULT 1,
  description     TEXT,
  created_at      TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS coupon_redemptions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  coupon_code  TEXT NOT NULL,
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  order_id     INTEGER REFERENCES orders(id) ON DELETE CASCADE,
  discount_usd REAL NOT NULL DEFAULT 0,
  created_at   TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (coupon_code, order_id)
);

-- customer_addresses already carries line1/line2 (migration 0003) — nothing to add.
