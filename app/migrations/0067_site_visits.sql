-- 0067_site_visits.sql  (D1 / SQLite)
--
-- Every page a visitor opens on mortsautoparts.com, for System management
-- -> Website on the till (functions/_lib/visits.js writes, functions/_routes/
-- sitemgmt.js reads). One row per page: the page load is recorded as the page
-- is sent, and moves inside a page (admin.html#tab=...) by a small beacon.
--
--   visitor  a random id in the vv cookie (a year), so one person's pages
--            can be followed without knowing who they are
--   user_id  the signed-in account, read from the session cookie without a
--            database read (NULL for a guest)
--   area     'admin' for the back office (admin.html, till pages, the demo),
--            'public' for the shop front
--   ip_hash  SHA-256 of the address with a secret, never the address itself
--
-- Kept 180 days: sitemgmt prunes older rows when the till asks for the summary.

CREATE TABLE IF NOT EXISTS site_visits (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  visitor   TEXT,
  user_id   INTEGER,
  area      TEXT NOT NULL DEFAULT 'public',
  path      TEXT NOT NULL,
  hash      TEXT,
  kind      TEXT NOT NULL DEFAULT 'load',   -- 'load' | 'nav'
  referrer  TEXT,
  country   TEXT,
  city      TEXT,
  device    TEXT,                           -- 'desktop' | 'mobile' | 'tablet'
  browser   TEXT,
  os        TEXT,
  bot       INTEGER NOT NULL DEFAULT 0,
  ip_hash   TEXT
);
CREATE INDEX IF NOT EXISTS idx_site_visits_at      ON site_visits (at);
CREATE INDEX IF NOT EXISTS idx_site_visits_visitor ON site_visits (visitor, at);
CREATE INDEX IF NOT EXISTS idx_site_visits_user    ON site_visits (user_id, at);
CREATE INDEX IF NOT EXISTS idx_site_visits_area    ON site_visits (area, at);
