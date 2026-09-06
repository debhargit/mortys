-- 0019_inventory.sql  (D1 / SQLite)  — Phase 6 of the Cloudflare port
--
-- Inventory + purchasing writes and the CSV importer. Fills the structural
-- gaps between the D1 tables and what schema.sql (Postgres) now carries for
-- products / suppliers, so functions/_routes/inventory.js can write the same
-- columns the Express handlers do.
--
--   wrangler d1 migrations apply mortysautoparts-db --local
--   wrangler d1 migrations apply mortysautoparts-db
--
-- Money stays *_cents (see migration 0004 header); the route layer converts
-- at the SELECT boundary and with _lib/money.js.

-- ---- products: the part-department columns the extended PATCH writes -------
--   (server.js /api/admin/products-ext and the receive path)
ALTER TABLE products ADD COLUMN core_charge_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN env_fee_cents     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN warranty_days     INTEGER;
ALTER TABLE products ADD COLUMN serial_required   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN weight_kg         REAL;
ALTER TABLE products ADD COLUMN dim_cm            TEXT;
ALTER TABLE products ADD COLUMN min_stock         INTEGER;
ALTER TABLE products ADD COLUMN markup_pct        REAL;

-- ---- suppliers: the vendor-card columns the CRUD endpoints write ----------
ALTER TABLE suppliers ADD COLUMN code           TEXT;
ALTER TABLE suppliers ADD COLUMN website        TEXT;
ALTER TABLE suppliers ADD COLUMN payment_terms  TEXT;
ALTER TABLE suppliers ADD COLUMN account_number TEXT;
ALTER TABLE suppliers ADD COLUMN lead_time_days INTEGER DEFAULT 7;

-- suppliers.code is a natural key in the Express layer ("code already in use")
CREATE UNIQUE INDEX IF NOT EXISTS idx_suppliers_code
  ON suppliers (code) WHERE code IS NOT NULL;

-- ---- purchase_orders: total_cents already exists (0001); nothing to add ---
-- ---- purchase_order_items: qty_ordered / unit_cost_cents / total_cents /
--       sku / condition / notes all added in 0004; product_img is the link
--       (D1 products has no id), so no product_id column here.
