-- 0063: indexes that let the catalogue list queries walk rows in ORDER BY
-- order and stop at LIMIT, instead of scanning + sorting all ~36k products.
--
-- Without these, every GET /api/products page (storefront chunk, homepage
-- featured strip, POS grid page) read ~73k rows (a full scan plus the sort)
-- no matter how few rows it returned. On 2026-10-17 that alone was ~8M rows,
-- over the account-wide free-tier D1 daily read cap, which took down D1 for
-- every site on the account.
--
-- (is_active, ...) leads so the `WHERE is_active = 1` equality is satisfied by
-- the index; the price_cents > 0 / category filters are checked per row.

-- sort=stock_desc (storefront shop.html chunks, index.html featured strip)
CREATE INDEX IF NOT EXISTS idx_products_active_stock_name
  ON products (is_active, stock_count DESC, name);

-- sort=name / default (POS + admin product grid: ORDER BY category, name)
CREATE INDEX IF NOT EXISTS idx_products_active_cat_name
  ON products (is_active, category, name);
