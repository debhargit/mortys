-- 0033_admin_default_pin.sql  (D1 / SQLite)
--
-- Give the seeded admin a till PIN so keypad sign-in works out of the box on
-- the hosted build (the Postgres path does this in server.js initDb; D1 had
-- no equivalent, so pin-signin always answered "PIN not recognised").
--
-- PIN is 2240. The hash below is bcryptjs cost-10 of "2240" -- the same
-- algorithm functions/_lib/password.js verifies against. is_staff is set
-- alongside it because pin-signin only considers staff rows.
--
-- Guarded: only fills a blank PIN, so a shop that set its own in
-- Settings -> Users & Staff keeps it. No-op once applied.
UPDATE users
   SET pin_hash   = '$2a$10$BjyOVVpXi.GZxkit6RoazOPMDgCI2Y9ltg2W/VyKu3jEUZxIZXZue',
       pin_set_at = datetime('now'),
       is_staff   = 1
 WHERE email = 'admin@mortysautoparts.com'
   AND (pin_hash IS NULL OR pin_hash = '');
