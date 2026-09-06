-- 0035_pos_orders.sql  (D1 / SQLite)
--
-- "Order first, invoice on payment" for the POS. A counter operator without
-- the pos.finalise_invoice capability checks out into a PENDING row in `orders`
-- (source = 'pos') carrying the whole cart in pos_payload; a cashier later
-- takes payment in the Cashier module, which replays that payload through the
-- normal /api/admin/pos/sale path to mint the invoice and move stock.
--
-- Nothing here changes existing behaviour: pos.finalise_invoice defaults to
-- granted for every role, so every operator keeps ringing sales directly until
-- a role has that box un-ticked.

ALTER TABLE orders ADD COLUMN source            TEXT NOT NULL DEFAULT 'storefront'; -- 'storefront' | 'pos'
ALTER TABLE orders ADD COLUMN pos_payload       TEXT;      -- JSON: the /api/admin/pos/sale body, minus payments
ALTER TABLE orders ADD COLUMN sales_rep_id      INTEGER;
ALTER TABLE orders ADD COLUMN sales_rep_name    TEXT;
ALTER TABLE orders ADD COLUMN ship_instructions TEXT;
ALTER TABLE orders ADD COLUMN converted_sale_id INTEGER;   -- pos_sales.id once a cashier invoices it
ALTER TABLE orders ADD COLUMN taken_by          INTEGER;   -- users.id of the operator who created the order

CREATE INDEX IF NOT EXISTS idx_orders_source_status ON orders (source, status);
