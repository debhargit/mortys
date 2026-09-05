-- Redeemable items (e.g. lottery scratch cards): a product sold through the
-- regular POS sale flow that mints a redeemable instrument per unit, modeled
-- on the gift_cards/gift_card_transactions shape (sell a code, redeem it
-- later) but as a product line rather than a payment method.
ALTER TABLE products ADD COLUMN is_redeemable INTEGER NOT NULL DEFAULT 0;

CREATE TABLE redemption_instruments (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  code             TEXT UNIQUE NOT NULL,
  product_img      TEXT NOT NULL REFERENCES products(img),
  sale_id          INTEGER REFERENCES pos_sales(id),
  sale_item_id     INTEGER REFERENCES pos_sale_items(id),
  status           TEXT NOT NULL DEFAULT 'sold',   -- sold | redeemed | void
  face_value_cents INTEGER NOT NULL DEFAULT 0,
  payout_cents     INTEGER,
  sold_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  redeemed_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  redeemed_at      TEXT,
  notes            TEXT,
  created_at       TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_redemption_instruments_product ON redemption_instruments (product_img);
CREATE INDEX idx_redemption_instruments_sale ON redemption_instruments (sale_id);
