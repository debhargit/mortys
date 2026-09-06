-- 0031_rebrand_walkin_email.sql  (D1 / SQLite)
--
-- Rebrand (2026): the synthetic no-email customer domain moved from
-- @walkin.melthahonda.local to @walkin.mortysautoparts.local. Rename the
-- rows on databases provisioned before the change -- the singleton walk-in
-- record (seeded in 0018) and every counter-created customer minted without a
-- real email -- so lookups by the new address keep matching. No-op once
-- migrated; the singleton rename is skipped if the new address already exists
-- (email is UNIQUE).
UPDATE users
   SET email = replace(email, '@walkin.melthahonda.local', '@walkin.mortysautoparts.local')
 WHERE email LIKE '%@walkin.melthahonda.local';

UPDATE users SET email = 'walkin@mortysautoparts.local'
 WHERE email = 'walkin@melthahonda.local'
   AND NOT EXISTS (SELECT 1 FROM users u2 WHERE u2.email = 'walkin@mortysautoparts.local');
