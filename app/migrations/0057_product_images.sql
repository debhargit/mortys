-- Multiple photos per product. products.img stays the identity + the
-- fallback photo; product_images holds the extra shots (same shape as
-- inspection_photos / vehicle_photos / order_photos). primary_image_override
-- lets any photo become the one shown in lists / the grid / shop cards
-- without repointing the primary key.
CREATE TABLE product_images (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  product_img  TEXT NOT NULL REFERENCES products(img) ON DELETE CASCADE,
  url          TEXT NOT NULL,            -- a /uploads/... path or an external URL
  caption      TEXT,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_product_images_product ON product_images (product_img, sort_order);

ALTER TABLE products ADD COLUMN primary_image_override TEXT;  -- NULL = use img
