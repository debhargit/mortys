-- sku had no index (only products.img, the primary key, does). The
-- receival/sales importers (functions/_routes/inventory.js, pos_txn.js;
-- server.js's equivalents) match existing stock with "img IN (...) OR sku
-- IN (...)", and an unindexed sku forces SQLite to fall back to a full
-- table scan for that half of the OR instead of an index lookup on both
-- sides -- real row-reads against the D1 free-tier's daily quota on a
-- 20k+ row catalogue. Partial (WHERE sku IS NOT NULL) since many rows have
-- no sku at all.
CREATE INDEX idx_products_sku ON products(sku) WHERE sku IS NOT NULL;
