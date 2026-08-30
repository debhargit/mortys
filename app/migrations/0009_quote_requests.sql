-- 0009_quote_requests.sql
-- Turns parts_inquiries into the home for customer quote requests.
--
-- Nearly the whole seeded catalogue (22,977 of 23,003 parts) carries no price,
-- so the storefront cannot take an order for them -- it takes a request for a
-- quote instead. Those requests land here rather than in `orders`, because
-- nothing about them is priced yet and they need to be worked before they
-- become a sale.
--
-- Two columns were missing for that:
--   email      -- the table only had a phone, so a request from a customer who
--                 left an email address had nowhere to keep it, and the shop
--                 could not reply by email.
--   items_json -- a cart-based request covers several part numbers with
--                 quantities. part_description alone flattens that into prose
--                 the counter then has to re-read to pick against.
--
-- source distinguishes the two ways one arrives: 'form' from the Request a
-- Part form, 'cart' from the shop cart's Request Quote button.

-- photo_data / photo_type mirror order_photos: the Request a Part form has
-- always offered a photo upload, and R2 is still switched off on this account,
-- so the bytes ride inline in D1 under the same 2 MB cap the order photos use.
-- photo_path stays for the day R2 is enabled and the bytes move out.

ALTER TABLE parts_inquiries ADD COLUMN email      TEXT;
ALTER TABLE parts_inquiries ADD COLUMN items_json TEXT;
ALTER TABLE parts_inquiries ADD COLUMN source     TEXT NOT NULL DEFAULT 'form';
ALTER TABLE parts_inquiries ADD COLUMN photo_data BLOB;
ALTER TABLE parts_inquiries ADD COLUMN photo_type TEXT;

CREATE INDEX idx_parts_inquiries_status  ON parts_inquiries (status, created_at DESC);
CREATE INDEX idx_parts_inquiries_email   ON parts_inquiries (email);

-- pos_quotes.status was missing outright: GET /admin/pos/quotes selects it, so
-- listing counter quotes has always returned a 500 and no saved quote could be
-- read back. Now that the POS can save a cart as a quote, that list has to
-- work. Existing rows default to 'open'.
ALTER TABLE pos_quotes ADD COLUMN status TEXT NOT NULL DEFAULT 'open';

CREATE INDEX idx_pos_quotes_status ON pos_quotes (status, created_at DESC);
