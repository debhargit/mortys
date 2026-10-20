-- 0065_shop_phone.sql  (D1 / SQLite)
--
-- The shop's phone number changed in October 2026, and WhatsApp moved to a
-- line of its own:
--     phone     (876) 728-4735        (was (876) 758-5590)
--     WhatsApp  (876) 553-4458        (new; the pages link it directly)
--
-- The WhatsApp number is not stored -- the storefront's wa.me links carry it --
-- so only the phone is migrated here. Each statement names the old value in its
-- WHERE, so a row an operator has since edited in Settings is left alone, and
-- the whole file is a no-op on a database seeded after the change (0016's
-- DEFAULT and 0002's seed both carry the new number now).

UPDATE shop_settings SET phone = '(876) 728-4735'
 WHERE phone IN ('(876) 758-5590', '876-758-5590');

UPDATE warehouse_settings SET value = '876-728-4735'
 WHERE key = 'notify_shop_phone'
   AND value IN ('876-758-5590', '(876) 758-5590');

-- The seeded admin account carries the shop's own number as its contact
-- (0002_seed_data.sql). A real staff member's mobile never matches these.
UPDATE users SET phone = '(876) 728-4735'
 WHERE phone IN ('(876) 758-5590', '876-758-5590', '+18767585590', '8767585590');
