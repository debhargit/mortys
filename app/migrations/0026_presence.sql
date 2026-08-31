-- Live admin / POS terminal presence.
--
-- Each browser that opens the admin panel keeps a stable client id in
-- localStorage and heartbeats POST /api/admin/presence roughly every 60s.
-- The POS ticket bar shows owners and managers a live count of how many
-- tills are currently connected. Rows are considered "online" for ~2.5 min
-- after their last heartbeat; anything older than a day is pruned on write.
CREATE TABLE IF NOT EXISTS admin_presence (
  terminal_id TEXT PRIMARY KEY,
  label       TEXT,
  user_id     INTEGER,
  user_name   TEXT,
  ip          TEXT,
  user_agent  TEXT,
  first_seen  TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_admin_presence_last_seen ON admin_presence (last_seen);
