-- Coupons usable at the POS counter, not just online checkout -- same
-- coupons/coupon_scopes tables (0021, 0046), same discount math
-- (_lib/coupons.js), just a second place it can be redeemed from.
ALTER TABLE pos_sales ADD COLUMN coupon_code           TEXT;
ALTER TABLE pos_sales ADD COLUMN coupon_discount_cents INTEGER NOT NULL DEFAULT 0;

-- order_id was always nullable and coupon_redemptions never had a NOT NULL
-- constraint on it; add the POS-side counterpart so a redemption can point
-- at whichever channel actually used it (each is null for the other).
ALTER TABLE coupon_redemptions ADD COLUMN sale_id INTEGER REFERENCES pos_sales(id);
