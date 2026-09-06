-- Two pricing mechanisms, both resolved through _lib/price_breaks.js alongside
-- the existing absolute product_price_breaks (0042). "Cheapest wins": the
-- charged unit price is the lowest of { retail, active sale, the customer's
-- tier price, the best qualifying quantity discount }.

-- Percentage quantity discounts: once a line reaches min_qty, take
-- discount_pct off the RETAIL price. A misordered / overlapping set can never
-- charge more than retail because the resolver only ever takes the minimum.
CREATE TABLE product_qty_discounts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  product_img  TEXT NOT NULL REFERENCES products(img) ON DELETE CASCADE,
  min_qty      INTEGER NOT NULL CHECK (min_qty >= 2),
  discount_pct REAL NOT NULL CHECK (discount_pct > 0 AND discount_pct <= 100),
  created_at   TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (product_img, min_qty)
);
CREATE INDEX idx_qty_discounts_product ON product_qty_discounts (product_img);

-- Per-item price for a non-retail customer tier (users.price_tier). No row
-- for a tier means that tier pays retail (still subject to sale / qty
-- discount). 'retail' is never stored -- it is products.price_cents.
CREATE TABLE product_tier_prices (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  product_img  TEXT NOT NULL REFERENCES products(img) ON DELETE CASCADE,
  tier         TEXT NOT NULL CHECK (tier IN ('trade','fleet','dealer')),
  price_cents  INTEGER NOT NULL CHECK (price_cents >= 0),
  created_at   TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (product_img, tier)
);
CREATE INDEX idx_tier_prices_product ON product_tier_prices (product_img);
