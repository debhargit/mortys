-- 0035_product_pricing_ext.sql  (D1 / SQLite)
--
-- Industry-standard part-department pricing / costing / stocking fields for the
-- admin "Edit part" modal, matching the Postgres columns added in schema.sql:
--   list_price_usd  -> list_price_cents   (MSRP / list)
--   trade_price_usd -> trade_price_cents  (wholesale / trade tier)
--   cost_method     TEXT  ('last' | 'average' | 'standard' | 'fifo')
--   stock_unit      TEXT  ('EACH','PAIR','SET','KIT','BOX','CASE',...)
--   supplier_sku    TEXT  (vendor's own part number for the linked supplier_id)
--
-- Money stays *_cents (see migration 0004 header); functions/_routes/inventory.js
-- converts at the boundary with _lib/money.js.
--
--   wrangler d1 migrations apply visionautosolutions-db --local
--   wrangler d1 migrations apply visionautosolutions-db

ALTER TABLE products ADD COLUMN list_price_cents  INTEGER;
ALTER TABLE products ADD COLUMN trade_price_cents INTEGER;
ALTER TABLE products ADD COLUMN cost_method       TEXT;
ALTER TABLE products ADD COLUMN stock_unit        TEXT;
ALTER TABLE products ADD COLUMN supplier_sku      TEXT;
