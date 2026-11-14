-- 0064_store_cashier_gl.sql  (D1 / SQLite)
--
-- Department store, cashier and general-ledger tables, ported from the till.
-- Generated from the Postgres schema (same table and column names) so
-- tools/pg2d1.mjs copies the till's rows straight in. Arrays and JSON are
-- TEXT (JSON), booleans 0/1, timestamps ISO text. No foreign keys (D1 does
-- not enforce them by default; the till is the source of truth).

CREATE TABLE IF NOT EXISTS warehouse_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS store_locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'store',
  address TEXT,
  phone TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  is_default INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (CURRENT_TIMESTAMP)
);
CREATE UNIQUE INDEX IF NOT EXISTS store_locations_code_key ON store_locations (code);

CREATE TABLE IF NOT EXISTS departments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  categories TEXT NOT NULL DEFAULT '[]',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (CURRENT_TIMESTAMP),
  manager_user_id INTEGER,
  location_id INTEGER,
  kind TEXT NOT NULL DEFAULT 'parts',
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_departments_loc_code ON departments (location_id, code);

CREATE TABLE IF NOT EXISTS user_departments (
  user_id INTEGER NOT NULL,
  department_id INTEGER NOT NULL,
  PRIMARY KEY (user_id, department_id)
);

CREATE TABLE IF NOT EXISTS station_departments (
  station_id INTEGER NOT NULL,
  department_id INTEGER NOT NULL,
  PRIMARY KEY (station_id, department_id)
);

CREATE TABLE IF NOT EXISTS pos_stations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'order',
  cashier_station_id INTEGER,
  backup_station_id INTEGER,
  device_key_hash TEXT,
  bound_at TEXT,
  bound_by INTEGER,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (CURRENT_TIMESTAMP),
  location_id INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pos_stations_name ON pos_stations (name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS till_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  opening_float REAL NOT NULL DEFAULT 0,
  opening_count TEXT,
  opened_at TEXT DEFAULT (CURRENT_TIMESTAMP),
  counted_cash REAL,
  closing_count TEXT,
  expected_cash REAL,
  variance REAL,
  closed_at TEXT,
  closed_by INTEGER,
  close_notes TEXT,
  reviewed_by INTEGER,
  reviewed_at TEXT,
  review_note TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_till_sessions_open ON till_sessions (station_id) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS till_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  reason TEXT,
  by_user INTEGER,
  approved_by INTEGER,
  created_at TEXT DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TABLE IF NOT EXISTS till_sales (
  session_id INTEGER NOT NULL,
  sale_id INTEGER NOT NULL,
  PRIMARY KEY (session_id, sale_id)
);

CREATE TABLE IF NOT EXISTS location_stock (
  product_img TEXT NOT NULL,
  location_id INTEGER NOT NULL,
  qty INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT DEFAULT (CURRENT_TIMESTAMP),
  PRIMARY KEY (product_img, location_id)
);
CREATE INDEX IF NOT EXISTS idx_location_stock_loc ON location_stock (location_id);

CREATE TABLE IF NOT EXISTS stock_transfers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT,
  from_location_id INTEGER NOT NULL,
  to_location_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  note TEXT,
  created_by INTEGER,
  created_at TEXT DEFAULT (CURRENT_TIMESTAMP),
  posted_at TEXT,
  posted_by INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS stock_transfers_number_key ON stock_transfers (number);
CREATE INDEX IF NOT EXISTS idx_stock_transfers_status ON stock_transfers (status, created_at DESC);

CREATE TABLE IF NOT EXISTS stock_transfer_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transfer_id INTEGER NOT NULL,
  product_img TEXT NOT NULL,
  description TEXT,
  qty INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stock_transfer_lines_t ON stock_transfer_lines (transfer_id);

CREATE TABLE IF NOT EXISTS gl_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  qb_name TEXT,
  qb_type TEXT,
  system_key TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_at TEXT DEFAULT (CURRENT_TIMESTAMP),
  parent_id INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS gl_accounts_code_key ON gl_accounts (code);
CREATE UNIQUE INDEX IF NOT EXISTS gl_accounts_system_key_key ON gl_accounts (system_key);
CREATE INDEX IF NOT EXISTS idx_gl_accounts_parent ON gl_accounts (parent_id);

CREATE TABLE IF NOT EXISTS gl_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT,
  entry_date TEXT NOT NULL,
  book TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_id INTEGER NOT NULL,
  source_ref TEXT,
  memo TEXT,
  reverses_id INTEGER,
  reversed_by INTEGER,
  posted_by INTEGER,
  posted_at TEXT DEFAULT (CURRENT_TIMESTAMP),
  export_id INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS gl_entries_number_key ON gl_entries (number);
CREATE UNIQUE INDEX IF NOT EXISTS gl_entries_source_kind_source_id_key ON gl_entries (source_kind, source_id);
CREATE INDEX IF NOT EXISTS idx_gl_entries_date ON gl_entries (entry_date);

CREATE TABLE IF NOT EXISTS gl_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  amount REAL NOT NULL,
  party TEXT,
  memo TEXT
);
CREATE INDEX IF NOT EXISTS idx_gl_lines_entry ON gl_lines (entry_id);
CREATE INDEX IF NOT EXISTS idx_gl_lines_account ON gl_lines (account_id);

CREATE TABLE IF NOT EXISTS gl_map (
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  account_id INTEGER NOT NULL,
  PRIMARY KEY (kind, key)
);

CREATE TABLE IF NOT EXISTS gl_periods (
  month TEXT PRIMARY KEY,
  closed_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  closed_by INTEGER,
  note TEXT
);

CREATE TABLE IF NOT EXISTS gl_exports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  from_date TEXT NOT NULL,
  to_date TEXT NOT NULL,
  entries INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER,
  created_at TEXT DEFAULT (CURRENT_TIMESTAMP)
);

-- POS sales: which store rang them (NULL = the main store).
ALTER TABLE pos_sales ADD COLUMN location_id INTEGER;
-- POS orders (orders.source = 'pos'): the station that took it and the
-- cashier station that collects (GENERAL can choose it).
ALTER TABLE orders ADD COLUMN order_station_id INTEGER;
ALTER TABLE orders ADD COLUMN cashier_station_id INTEGER;

-- Effective stock per store: branches are stored, the default store is the
-- total (products.stock_count) minus every branch -- same model as the till.
CREATE VIEW IF NOT EXISTS location_stock_v AS
  SELECT ls.product_img, ls.location_id, ls.qty
    FROM location_stock ls
    JOIN store_locations l ON l.id = ls.location_id AND l.is_default = 0
  UNION ALL
  SELECT p.img AS product_img, d.id AS location_id,
         MAX(0, COALESCE(p.stock_count, 0) - COALESCE(b.q, 0)) AS qty
    FROM products p
   CROSS JOIN (SELECT id FROM store_locations WHERE is_default = 1 ORDER BY sort, id LIMIT 1) d
    LEFT JOIN (SELECT x.product_img, SUM(x.qty) AS q FROM location_stock x
                 JOIN store_locations xl ON xl.id = x.location_id AND xl.is_default = 0
                GROUP BY x.product_img) b ON b.product_img = p.img;

-- Baseline rows the till seeds in schema.sql (the data sync replaces them with
-- the till's own): one main store, and GENERAL (owners/managers sell from all
-- departments as one stock and pick the collecting cashier).
INSERT INTO store_locations (code, name, kind, is_default, is_active, sort)
  SELECT 'MAIN', 'Main Store', 'store', 1, 1, 0 WHERE NOT EXISTS (SELECT 1 FROM store_locations);
INSERT INTO departments (code, name, categories, is_active, kind, sort, location_id)
  SELECT 'GENERAL', 'General', '[]', 1, 'general', -1, NULL WHERE NOT EXISTS (SELECT 1 FROM departments WHERE kind = 'general');
