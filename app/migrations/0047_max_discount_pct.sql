-- Per-item discount limit: caps how far ANY discount (POS line discount) may
-- cut into this specific product's price, independent of the customer's own
-- whole-ticket discount_limit_pct (migration 0017) -- whichever is stricter
-- wins. NULL = no item-specific cap; 0 = this item may never be discounted.
ALTER TABLE products ADD COLUMN max_discount_pct REAL;
