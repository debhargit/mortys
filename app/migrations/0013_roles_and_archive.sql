-- =============================================================================
--  0013 — roles, and archived customers (D1 / SQLite side)
--
--  Mirrors the Postgres change in schema.sql.
--
--  roles: admin_role used to be three strings hardcoded in two places. This
--  side had it worse -- there was no manager concept here at all, only the
--  is_admin flag, so the sixty endpoints that server.js gates with
--  requireManager had no counterpart and a cashier reaching this backend
--  directly was simply an admin. can_manage is what the new requireManager
--  checks; hidden_tabs drives the sidebar.
--
--  is_archived: a customer with sales behind them cannot be deleted, because
--  orders, pos_sales and account_payments all reference users with ON DELETE
--  SET NULL -- the delete would succeed and quietly detach their history,
--  including any balance owed. Archiving hides them while leaving every
--  reference intact.
-- =============================================================================

CREATE TABLE IF NOT EXISTS roles (
  code        TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  -- Lower is more senior. Stops someone editing a role at or above their own
  -- level, which is how a "manage roles" screen becomes an escalation button.
  rank        INTEGER NOT NULL DEFAULT 50,
  can_manage  INTEGER NOT NULL DEFAULT 0,
  -- Deny list, not an allow list, so a newly added screen is visible by
  -- default rather than hidden from everyone until somebody grants it.
  hidden_tabs TEXT NOT NULL DEFAULT '[]',
  is_system   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO roles (code, label, rank, can_manage, hidden_tabs, is_system) VALUES
  ('owner',   'Owner',   0,  1, '[]', 1),
  ('manager', 'Manager', 10, 1, '[]', 1),
  ('cashier', 'Cashier', 50, 0,
     '["mechanics","suppliers","purchaseorders","coupons","giftcards","marketing","settings","staff","staffcategories","roles"]',
     1);

-- No foreign key from users.admin_role: deleting a role must not cascade into
-- staff, and the API refuses to delete one anyone still holds.
CREATE INDEX IF NOT EXISTS idx_users_admin_role ON users(admin_role);

ALTER TABLE users ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_users_archived ON users(is_archived);

-- ---- per-user UI preferences -------------------------------------------------
--  Theme, pinned screens, sidebar state, landing screen and the POS layout,
--  saved against the person so they follow them between tills rather than
--  belonging to whichever browser they last used.
--
--  TEXT here, jsonb in Postgres: SQLite has no JSON type, and the API treats
--  the value as an opaque blob either way -- it validates that it is an object
--  and that it is under 8 KB, and otherwise never looks inside. The DEFAULT
--  matches the Postgres '{}'::jsonb so a row that has never saved reads the
--  same on both backends.
ALTER TABLE users ADD COLUMN ui_prefs TEXT NOT NULL DEFAULT '{}';
