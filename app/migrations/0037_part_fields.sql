-- 0037_part_fields.sql  (D1 / SQLite)   [upstream Vision Auto Solutions 0034_part_fields; renumbered +3]
--
-- Extra part attributes surfaced in the admin "Edit part" / "Add part" forms.
-- On this (Vision) line four of the six columns already exist:
--   * list_price_cents  -- added by Vision's 0035_product_pricing_ext
--   * costing_method / supplier_part_no / stock_uom
--                       -- renamed into place from Vision's cost_method /
--                          supplier_sku / stock_unit by 0036_pricing_schema_reconcile
-- so only the two Vision Auto Solutions-only fields are added here:
--   purchase_uom        unit the part is bought in       ('each','box','case',…)
--   units_per_purchase  how many stock_uom make up one purchase_uom
--
-- Money stays *_cents; the route layer converts at the SELECT boundary and
-- with _lib/money.js. Mirrors the columns added to schema.sql (Postgres).

ALTER TABLE products ADD COLUMN purchase_uom       TEXT;
ALTER TABLE products ADD COLUMN units_per_purchase REAL;
