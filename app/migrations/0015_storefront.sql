-- 0015_storefront.sql  (D1 / SQLite)
--
-- Tables the storefront read paths need that the earlier D1 conversion left
-- out (0001_init.sql's header lists `wishlist` among the ones "referenced by
-- server.js ... that were never migrated"). See app/PORT.md, Phase 2.
--
--   wrangler d1 migrations apply mortysautoparts-db --local
--   wrangler d1 migrations apply mortysautoparts-db

CREATE TABLE IF NOT EXISTS wishlist (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_img TEXT    NOT NULL REFERENCES products(img) ON DELETE CASCADE,
  created_at  TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, product_img)
);
CREATE INDEX IF NOT EXISTS idx_wishlist_user ON wishlist (user_id);
