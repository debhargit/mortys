-- ============================================================================
--  Tables referenced by Phase 4 (customer-account) routes that were never
--  actually created in the live Postgres database: customer_addresses,
--  customer_messages, saved_vehicles, wishlist, work_order_payments.
--  Same conversion rules as 0001_init.sql (money -> *_cents integers,
--  booleans -> integers, timestamps -> TEXT).
-- ============================================================================

CREATE TABLE customer_addresses (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label         TEXT,
  kind          TEXT NOT NULL DEFAULT 'shipping',
  recipient     TEXT,
  line1         TEXT NOT NULL,
  line2         TEXT,
  city          TEXT,
  parish        TEXT,
  postal_code   TEXT,
  country       TEXT NOT NULL DEFAULT 'Jamaica',
  phone         TEXT,
  is_default    INTEGER NOT NULL DEFAULT 0,
  notes         TEXT,
  created_at    TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_customer_addresses_user ON customer_addresses (user_id);

CREATE TABLE customer_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender      TEXT NOT NULL,          -- 'customer' | 'staff'
  body        TEXT NOT NULL,
  read_at     TEXT,
  created_at  TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_customer_messages_user ON customer_messages (user_id, created_at);

CREATE TABLE saved_vehicles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label       TEXT,
  make        TEXT,
  model       TEXT,
  year        INTEGER,
  vin         TEXT,
  nickname    TEXT,
  created_at  TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, vin)
);

CREATE TABLE wishlist (
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_img  TEXT NOT NULL REFERENCES products(img) ON DELETE CASCADE,
  created_at   TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, product_img)
);

CREATE TABLE work_order_payments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  work_order_id  INTEGER NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  method         TEXT NOT NULL,
  amount_cents   INTEGER NOT NULL,
  reference      TEXT,
  received_by    INTEGER REFERENCES mechanics(id) ON DELETE SET NULL,
  notes          TEXT,
  received_at    TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_wo_payments_wo ON work_order_payments (work_order_id);
