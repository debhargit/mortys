-- 0030_rebrand_admin_email.sql  (D1 / SQLite)
--
-- Rebrand (2026): the default admin account address moved from
-- melthahonda.com to mortysautoparts.com. Rename the row on databases
-- provisioned before the change so the app's seed (which upserts on the
-- email) keeps matching it and does not create a second admin account.
-- No-op on databases seeded after the rename; skipped if the new address is
-- already present, since email is UNIQUE.
UPDATE users SET email = 'admin@mortysautoparts.com'
  WHERE email = 'admin@melthahonda.com'
    AND NOT EXISTS (SELECT 1 FROM users u2 WHERE u2.email = 'admin@mortysautoparts.com');
