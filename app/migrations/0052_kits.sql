-- Kit / bundle items: one sellable product composed of other products.
-- "Phantom kit" model -- the kit itself carries no stock; selling it draws
-- its components down, voiding/returning it restocks them. A kit's own
-- stock_count / low_threshold are ignored everywhere; availability is
-- derived from the components (see _lib/kits.js).
--
--   kit_price_mode  fixed  -> the kit is priced like any product
--                   rollup -> price = sum of component effective prices x qty
--   kit_line_mode   single   -> one receipt/cart line for the kit
--                   exploded -> the kit expands into one line per component
ALTER TABLE products ADD COLUMN is_kit         INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN kit_price_mode TEXT NOT NULL DEFAULT 'fixed'
  CHECK (kit_price_mode IN ('fixed','rollup'));
ALTER TABLE products ADD COLUMN kit_line_mode  TEXT NOT NULL DEFAULT 'single'
  CHECK (kit_line_mode  IN ('single','exploded'));

-- Same shape/precedent as product_price_breaks (0042): keyed on img, FK with
-- ON DELETE CASCADE, replace-the-whole-set from one PUT.
CREATE TABLE kit_components (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kit_img       TEXT NOT NULL REFERENCES products(img) ON DELETE CASCADE,
  component_img TEXT NOT NULL REFERENCES products(img) ON DELETE CASCADE,
  qty_each      INTEGER NOT NULL CHECK (qty_each >= 1),
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (kit_img, component_img)
);
CREATE INDEX idx_kit_components_kit ON kit_components (kit_img);

-- Snapshot of what a 'single'-mode kit line actually consumed, so a later
-- void/return restocks the right components even if the kit's recipe has
-- changed since. JSON text, same idiom as products.matrix_overrides.
ALTER TABLE pos_sale_items ADD COLUMN kit_components_json TEXT;
