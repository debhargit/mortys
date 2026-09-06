-- Sale pricing with auto-expiry: a per-product sale price that only applies
-- while "now" falls inside [sale_starts_at, sale_ends_at] (either bound may
-- be null -- see _lib/price_breaks.js's ACTIVE_SALE_PRICE_SQL, which is the
-- one place that window is evaluated). No cron/expiry job needed: every read
-- re-checks the window, so a sale simply stops applying itself once it ends.
ALTER TABLE products ADD COLUMN sale_price_cents INTEGER;
ALTER TABLE products ADD COLUMN sale_starts_at    TEXT;
ALTER TABLE products ADD COLUMN sale_ends_at      TEXT;
