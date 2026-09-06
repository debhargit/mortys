-- Purchasing planner: multiple approved suppliers per part + reorder tuning.
-- A part can be bought from more than one vendor, each with its own catalogue
-- number, cost, lead time and minimum order quantity. One row per part is
-- is_preferred and drives the default on the "purchase run" screen and the
-- service-level reorder analysis.

CREATE TABLE product_suppliers (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  product_img       TEXT NOT NULL REFERENCES products(img) ON DELETE CASCADE,
  supplier_id       INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  supplier_part_no  TEXT,
  unit_cost_cents   INTEGER,
  lead_time_days    INTEGER,
  min_order_qty     INTEGER,
  pack_size         INTEGER,
  is_preferred      INTEGER NOT NULL DEFAULT 0,
  notes             TEXT,
  created_at        TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at        TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (product_img, supplier_id)
);
CREATE INDEX idx_product_suppliers_prod ON product_suppliers (product_img);
CREATE INDEX idx_product_suppliers_sup  ON product_suppliers (supplier_id);

ALTER TABLE products ADD COLUMN reorder_point INTEGER;
ALTER TABLE products ADD COLUMN reorder_qty   INTEGER;

-- Seed a preferred row from the single products.supplier_id every part carries.
INSERT INTO product_suppliers (product_img, supplier_id, supplier_part_no, unit_cost_cents, is_preferred)
SELECT p.img, p.supplier_id, p.supplier_part_no, p.cost_cents, 1
  FROM products p
 WHERE p.supplier_id IS NOT NULL;
