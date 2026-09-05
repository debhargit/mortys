-- Alternate / interchange / cross-reference part numbers. A part can carry
-- many: the OEM number, competitor brands' numbers, superseded-from numbers,
-- etc. The counter can scan or search any of them to pull the part up and add
-- it to a sale; they also feed the storefront search.
--
-- Not globally unique -- one interchange number can legitimately map to
-- several of your SKUs -- only unique per (product, number).
CREATE TABLE product_alt_numbers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  product_img  TEXT NOT NULL REFERENCES products(img) ON DELETE CASCADE,
  number       TEXT NOT NULL,
  kind         TEXT,          -- free-text label, e.g. 'OEM' / 'interchange' / 'superseded'
  note         TEXT,
  created_at   TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (product_img, number)
);
CREATE INDEX idx_alt_numbers_product ON product_alt_numbers (product_img);
CREATE INDEX idx_alt_numbers_lnum    ON product_alt_numbers (lower(number));
