-- Quantity-break (bulk) pricing: an absolute per-unit price that kicks in once
-- a line's quantity reaches min_qty. The effective unit price for a given qty
-- is the lowest of {products.price_cents, every break whose min_qty <= qty} --
-- see _lib/price_breaks.js -- so an out-of-order or overlapping set of rows
-- can never produce a worse price than the base one.
CREATE TABLE product_price_breaks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  product_img  TEXT NOT NULL REFERENCES products(img) ON DELETE CASCADE,
  min_qty      INTEGER NOT NULL CHECK (min_qty >= 2),
  price_cents  INTEGER NOT NULL,
  created_at   TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (product_img, min_qty)
);
CREATE INDEX idx_price_breaks_product ON product_price_breaks (product_img);
