-- 0034_rebrand_mortys.sql  (D1 / SQLite)
--
-- Rebrand (2026), second pass: between the Meltha Honda rename (0030/0031) and
-- the final Vision Auto Solutions name, some installs briefly ran as "Morty's
-- Auto Parts". This carries those the rest of the way, mirroring 0030/0031:
--   * the seeded default admin account   admin@mortysautoparts.com
--   * the singleton walk-in record       walkin@mortysautoparts.local
--   * counter-created no-email customers  *@walkin.mortysautoparts.local
--   * the single shop_settings row, only where it still holds a Morty's default
-- Every statement is a no-op on databases that never saw the Morty's brand
-- (fresh installs seed straight to visionautosolutions.com -- see 0002/0016/
-- 0018) and skipped where the target value already exists (email is UNIQUE).

UPDATE users SET email = 'admin@visionautosolutions.com'
  WHERE email = 'admin@mortysautoparts.com'
    AND NOT EXISTS (SELECT 1 FROM users u2 WHERE u2.email = 'admin@visionautosolutions.com');

UPDATE users
   SET email = replace(email, '@walkin.mortysautoparts.local', '@walkin.visionautosolutions.local')
 WHERE email LIKE '%@walkin.mortysautoparts.local';

UPDATE users SET email = 'walkin@visionautosolutions.local'
 WHERE email = 'walkin@mortysautoparts.local'
   AND NOT EXISTS (SELECT 1 FROM users u2 WHERE u2.email = 'walkin@visionautosolutions.local');

UPDATE shop_settings SET company_name = 'Vision Auto Solutions Ltd'
 WHERE company_name = 'Morty''s Auto Parts Ltd';

UPDATE shop_settings SET website = 'https://visionautosolutions.com'
 WHERE website IN ('https://mortysautoparts.com', 'https://www.mortysautoparts.com');
