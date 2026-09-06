-- 0040_serial_core_warranty.sql  (D1 / SQLite)
--
-- Serial numbers, core charges and warranty were all already modeled on
-- pos_sale_items (serial_number, core_charge_cents, env_fee_cents,
-- warranty_until) and products (serial_required, core_charge_cents,
-- env_fee_cents, warranty_days) — this migration only adds what's missing:
-- recording a warranty-claim return as prorated by time remaining, rather
-- than refused outright past the normal window or refunded in full
-- regardless of age.

ALTER TABLE pos_return_items ADD COLUMN prorate_pct    INTEGER;             -- NULL/100 = full refund; less = prorated
ALTER TABLE pos_return_items ADD COLUMN warranty_claim INTEGER NOT NULL DEFAULT 0;
