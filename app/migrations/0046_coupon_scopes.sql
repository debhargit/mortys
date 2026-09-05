-- Coupons targeted at products/categories: a coupon with zero rows here
-- behaves exactly as before (discount applies to the whole cart) -- this
-- keeps every existing coupon working unchanged. A coupon with rows applies
-- (and is capped by) only the subtotal of matching lines; min_subtotal still
-- gates off the whole cart's subtotal ("spend $50 storewide to unlock this").
CREATE TABLE coupon_scopes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  coupon_code TEXT NOT NULL REFERENCES coupons(code) ON DELETE CASCADE,
  category    TEXT,
  product_img TEXT REFERENCES products(img) ON DELETE CASCADE
);
CREATE INDEX idx_coupon_scopes_code ON coupon_scopes (coupon_code);
