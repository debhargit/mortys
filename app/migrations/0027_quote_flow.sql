-- 0027_quote_flow.sql  (D1 / SQLite)
--
-- The storefront is now quote-first: online shoppers browse live stock with
-- NO prices and cannot place an order. A cart "checkout" becomes a quote
-- request in the Parts Inquiries queue; the counter prices it and, per
-- customer, unlocks price display.

-- Per-customer price visibility. Off by default -- guests and brand-new
-- accounts only ever see "Call for price". An admin flips this on once a
-- customer is approved for trade pricing (Admin -> Parts Inquiries editor,
-- or the customer's profile).
ALTER TABLE users ADD COLUMN show_prices INTEGER NOT NULL DEFAULT 0;

-- parts_inquiries already carries email / items_json / source / photo_data /
-- photo_type (0009). These are what the admin quote editor writes back once
-- it has priced a cart request:
--   quote_total_cents  sum of the priced line items
--   quote_notes        free text shown to the counter (lead time, substitutions)
--   priced_at          set the first time the request is priced
--   priced_by          users.id of the staffer who priced it
ALTER TABLE parts_inquiries ADD COLUMN quote_total_cents INTEGER;
ALTER TABLE parts_inquiries ADD COLUMN quote_notes       TEXT;
ALTER TABLE parts_inquiries ADD COLUMN priced_at         TEXT;
ALTER TABLE parts_inquiries ADD COLUMN priced_by         INTEGER;
