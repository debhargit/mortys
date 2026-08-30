-- 0007_guest_orders.sql
-- Lets an order stand on its own without a user account.
--
-- orders.user_id was already nullable, but there was nowhere to record who a
-- guest actually is, so a guest checkout left the shop with no way to contact
-- them. These three columns carry the contact details captured at checkout.
-- For signed-in customers they are filled from the users row as a snapshot, so
-- an order still shows the details as they were when it was placed even if the
-- customer later edits their profile.

ALTER TABLE orders ADD COLUMN customer_name  TEXT;
ALTER TABLE orders ADD COLUMN customer_email TEXT;
ALTER TABLE orders ADD COLUMN customer_phone TEXT;

CREATE INDEX idx_orders_customer_email ON orders (customer_email);
