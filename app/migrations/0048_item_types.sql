-- Item types: 'inventory' (default, today's behaviour -- stock tracked, bin/
-- location shown, counted in low-stock alerts and warehouse reports),
-- 'tracked' (e.g. tokens -- quantity still counted on sale/restock and still
-- low-stock-alerted, but not warehouse-placed), 'service' (fees, rent,
-- delivery/diagnostic charges -- stock_count irrelevant, always sellable,
-- never low-stock-alerted, no bin/location).
ALTER TABLE products ADD COLUMN item_type TEXT NOT NULL DEFAULT 'inventory'
  CHECK (item_type IN ('inventory', 'tracked', 'service'));
