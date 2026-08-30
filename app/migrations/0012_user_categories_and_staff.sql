-- =============================================================================
--  0012 — one people file, with categories (D1 / SQLite side)
--
--  Mirrors the Postgres change in schema.sql: every person is a `users` row,
--  and what a staff member does is one or more categories rather than a column
--  per job, so a new kind of staff needs no schema change.
--
--  The two backends drifting apart is a recurring bug in this codebase (the
--  admin Dashboard has already been blanked once by _usd vs _cents), so this
--  lands alongside the Postgres version rather than after it.
--
--  SQLite notes: no SERIAL (INTEGER PRIMARY KEY AUTOINCREMENT), no BOOLEAN
--  (INTEGER 0/1), no TIMESTAMPTZ (TEXT), and ALTER TABLE ADD COLUMN has no
--  IF NOT EXISTS -- which is fine, because migrations run once in order rather
--  than being re-applied on every boot the way schema.sql is.
-- =============================================================================

CREATE TABLE IF NOT EXISTS user_categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,
  label       TEXT NOT NULL,
  department  TEXT,
  is_staff    INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 100,
  is_active   INTEGER NOT NULL DEFAULT 1,
  -- Categories the application looks up by code. Renameable, not deletable:
  -- removing one breaks the feature that depends on it.
  is_system   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_category_members (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES user_categories(id) ON DELETE CASCADE,
  assigned_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, category_id)
);
CREATE INDEX IF NOT EXISTS idx_user_cat_members_cat ON user_category_members(category_id);

INSERT OR IGNORE INTO user_categories (code, label, department, is_staff, sort_order, is_system) VALUES
  ('sales_rep',       'Sales rep',       'counter', 1, 10, 1),
  ('cashier',         'Cashier',         'counter', 1, 20, 1),
  ('mechanic',        'Mechanic',        'service', 1, 30, 1),
  ('service_advisor', 'Service advisor', 'service', 1, 40, 1),
  ('driver',          'Driver',          'service', 1, 50, 0),
  ('parts_clerk',     'Parts clerk',     'counter', 1, 60, 0);

-- ---- staff fields on users ---------------------------------------------------
-- admin_role never existed on this side at all: the Worker only had the
-- is_admin flag, so owner/manager/cashier could not be told apart and the
-- Postgres requireManager() checks had no counterpart here.
ALTER TABLE users ADD COLUMN admin_role TEXT NOT NULL DEFAULT 'manager';

-- is_staff is separate from is_admin on purpose: is_admin means "may open the
-- admin panel", is_staff means "works here".
ALTER TABLE users ADD COLUMN is_staff INTEGER NOT NULL DEFAULT 0;

-- PIN for the shared till: quick sign-in, authorising overrides, clocking in.
-- bcrypt-hashed like the password -- four digits is short enough to brute
-- force offline, so storing it in clear would hand over every staff identity.
ALTER TABLE users ADD COLUMN pin_hash   TEXT;
ALTER TABLE users ADD COLUMN pin_set_at TEXT;

ALTER TABLE users ADD COLUMN employee_no TEXT;
ALTER TABLE users ADD COLUMN national_id TEXT;

-- Partial unique index, not a UNIQUE column: nearly every user is a customer
-- with no employee number.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_employee_no
  ON users(employee_no) WHERE employee_no IS NOT NULL;

-- ---- customer credit presets -------------------------------------------------
-- credit_type is CHECKed in Postgres; SQLite cannot add a CHECK to an existing
-- table without rebuilding it, so the API validates the same four values on
-- the way in. Kept in step with users_credit_type_ck in schema.sql.
ALTER TABLE users ADD COLUMN credit_type TEXT;
ALTER TABLE users ADD COLUMN credit_length_months INTEGER;

CREATE INDEX IF NOT EXISTS idx_users_is_staff ON users(is_staff);
CREATE INDEX IF NOT EXISTS idx_users_via ON users(via);
