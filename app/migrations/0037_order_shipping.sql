-- 0037_order_shipping.sql  (D1 / SQLite)
--
-- Storefront checkout gains a fulfilment choice: counter pickup (default),
-- local delivery, or courier/shipping. A delivery/courier order carries a
-- recipient address, the chosen carrier + service, the shipping fee (folded
-- into orders.total_cents), and — once a carrier books it — a tracking number
-- and the raw label bytes.
--
-- orders.ship_instructions already exists (migration 0035) and is reused for
-- the free-text delivery note.

ALTER TABLE orders ADD COLUMN fulfilment      TEXT NOT NULL DEFAULT 'pickup'; -- pickup | delivery | shipping
ALTER TABLE orders ADD COLUMN ship_name       TEXT;
ALTER TABLE orders ADD COLUMN ship_phone      TEXT;
ALTER TABLE orders ADD COLUMN ship_line1      TEXT;
ALTER TABLE orders ADD COLUMN ship_line2      TEXT;
ALTER TABLE orders ADD COLUMN ship_city       TEXT;
ALTER TABLE orders ADD COLUMN ship_parish     TEXT;
ALTER TABLE orders ADD COLUMN ship_carrier    TEXT;      -- dhl | fedex | knutsford | manual
ALTER TABLE orders ADD COLUMN ship_service    TEXT;      -- carrier service code / name
ALTER TABLE orders ADD COLUMN ship_fee_cents  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN ship_status     TEXT;      -- NULL | booked | label_failed | in_transit | delivered
ALTER TABLE orders ADD COLUMN tracking_number TEXT;
ALTER TABLE orders ADD COLUMN carrier_ref     TEXT;      -- carrier's own shipment id
ALTER TABLE orders ADD COLUMN label_format    TEXT;      -- pdf | png | zpl | html
ALTER TABLE orders ADD COLUMN label_data      TEXT;      -- base64 label bytes (R2 key once UPLOADS is enabled)

CREATE INDEX IF NOT EXISTS idx_orders_tracking ON orders (tracking_number);

-- Shipper origin + per-carrier config. API keys live in wrangler secrets;
-- only the non-secret bits (origin address, account numbers, on/off) sit here.
ALTER TABLE shop_settings ADD COLUMN ship_origin_name   TEXT;
ALTER TABLE shop_settings ADD COLUMN ship_origin_phone  TEXT;
ALTER TABLE shop_settings ADD COLUMN ship_origin_line1  TEXT;
ALTER TABLE shop_settings ADD COLUMN ship_origin_line2  TEXT;
ALTER TABLE shop_settings ADD COLUMN ship_origin_city   TEXT;
ALTER TABLE shop_settings ADD COLUMN ship_origin_parish TEXT;
ALTER TABLE shop_settings ADD COLUMN ship_origin_country TEXT NOT NULL DEFAULT 'JM';
ALTER TABLE shop_settings ADD COLUMN carrier_dhl_enabled       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE shop_settings ADD COLUMN carrier_dhl_account       TEXT;
ALTER TABLE shop_settings ADD COLUMN carrier_fedex_enabled     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE shop_settings ADD COLUMN carrier_fedex_account     TEXT;
ALTER TABLE shop_settings ADD COLUMN carrier_knutsford_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE shop_settings ADD COLUMN carrier_manual_enabled    INTEGER NOT NULL DEFAULT 1;
-- Fallback parcel weight (kg) when no line has products.weight_kg set, and a
-- flat local-delivery fee (USD) used by the manual/knutsford adapters.
ALTER TABLE shop_settings ADD COLUMN ship_default_weight_kg REAL NOT NULL DEFAULT 2.0;
ALTER TABLE shop_settings ADD COLUMN ship_local_flat_usd    REAL NOT NULL DEFAULT 0;
