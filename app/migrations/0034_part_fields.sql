-- 0034_part_fields.sql  (D1 / SQLite)
--
-- Extra part attributes surfaced in the admin "Edit part" / "Add part" forms:
--   list_price_cents    reference list / MSRP price (retail is still price_cents)
--   costing_method      per-part costing label — 'average' | 'fifo' | 'standard' | 'last'
--                       (a label only; there is no cost-layer engine)
--   supplier_part_no    the supplier's own catalogue number for this part
--   stock_uom           unit the stock_count is kept in  ('each','pair','set','litre',…)
--   purchase_uom        unit the part is bought in       ('each','box','case',…)
--   units_per_purchase  how many stock_uom make up one purchase_uom
--
-- Money stays *_cents; the route layer converts at the SELECT boundary and
-- with _lib/money.js. Mirrors the columns added to schema.sql (Postgres).

ALTER TABLE products ADD COLUMN list_price_cents   INTEGER;
ALTER TABLE products ADD COLUMN costing_method     TEXT;
ALTER TABLE products ADD COLUMN supplier_part_no   TEXT;
ALTER TABLE products ADD COLUMN stock_uom          TEXT;
ALTER TABLE products ADD COLUMN purchase_uom       TEXT;
ALTER TABLE products ADD COLUMN units_per_purchase REAL;
