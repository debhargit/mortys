-- Matrix items: one parent (shared price/cost/warranty/etc.) fanning out into
-- N child products.img rows across one or two attribute axes (e.g. Position:
-- Front/Rear). Children store their own real values (copied down from the
-- parent at creation) rather than living joins, so every existing query over
-- products is unaffected; matrix_overrides is the only new bookkeeping, and
-- it's diff-based (see product_matrix.js) so a plain product-editor save
-- never accidentally locks a field away from future pushes.
CREATE TABLE product_matrices (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT NOT NULL,           -- base/display name, e.g. "Brake Pad Set"
  make_model         TEXT,
  category           TEXT NOT NULL,
  condition          TEXT NOT NULL DEFAULT 'NEW',
  price_cents        INTEGER,
  cost_cents         INTEGER,
  list_price_cents   INTEGER,
  markup_pct         REAL,
  supplier_id        INTEGER REFERENCES suppliers(id),
  supplier_part_no   TEXT,
  costing_method     TEXT,
  stock_uom          TEXT,
  purchase_uom       TEXT,
  units_per_purchase REAL,
  warranty_days      INTEGER,
  serial_required    INTEGER NOT NULL DEFAULT 0,
  core_charge_cents  INTEGER NOT NULL DEFAULT 0,
  env_fee_cents      INTEGER NOT NULL DEFAULT 0,
  axis1_label        TEXT NOT NULL,           -- e.g. "Position"
  axis2_label        TEXT,                    -- e.g. "Side" (optional 2nd axis)
  photo_key          TEXT,                    -- R2 key duplicated for every child's own image
  created_at         TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at         TEXT DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE products ADD COLUMN matrix_id INTEGER REFERENCES product_matrices(id);
ALTER TABLE products ADD COLUMN matrix_axis1_value TEXT;
ALTER TABLE products ADD COLUMN matrix_axis2_value TEXT;
ALTER TABLE products ADD COLUMN matrix_overrides TEXT;  -- JSON array of field keys this child no longer inherits

CREATE INDEX idx_products_matrix ON products (matrix_id);
