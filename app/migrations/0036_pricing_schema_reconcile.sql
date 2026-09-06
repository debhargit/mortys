-- 0036_pricing_schema_reconcile.sql  (D1 / SQLite)
--
-- Vision's 0035_product_pricing_ext.sql added part-department pricing/costing
-- columns to `products`. The merged-in upstream (Morty's Auto Parts) line added the same concepts
-- under different names (its 0034_part_fields.sql, now 0037). the upstream names win
-- for the merged codebase, so rename Vision's live columns to match. 0037 then
-- adds only the two fields that had no Vision equivalent.
--
--   Vision (0035)        ->  upstream / merged code (this repo)
--   cost_method          ->  costing_method
--   supplier_sku         ->  supplier_part_no
--   stock_unit           ->  stock_uom
--   list_price_cents     ->  list_price_cents   (identical -- unchanged)
--   trade_price_cents    ->  (kept as-is; no upstream equivalent, unused by
--                             merged code, harmless)
--
-- Vision's D1 is at 0035 when this runs, so the columns exist. On a fresh
-- database the same holds: 0035 creates them, this renames them, 0037 tops up.

ALTER TABLE products RENAME COLUMN cost_method  TO costing_method;
ALTER TABLE products RENAME COLUMN supplier_sku TO supplier_part_no;
ALTER TABLE products RENAME COLUMN stock_unit   TO stock_uom;
