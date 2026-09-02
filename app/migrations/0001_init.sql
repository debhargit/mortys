-- ============================================================================
--  Morty's Auto Parts — D1 (SQLite) schema, converted from schema.sql (Postgres)
--
--  Conversion rules applied throughout:
--   * SERIAL              -> INTEGER PRIMARY KEY AUTOINCREMENT
--   * BOOLEAN              -> INTEGER (0/1)
--   * TIMESTAMPTZ/NOW()    -> TEXT DEFAULT CURRENT_TIMESTAMP (UTC text, naive)
--   * DATE                 -> TEXT (CURRENT_DATE default kept where present)
--   * JSONB                -> TEXT (JSON-encoded string; use json_extract/json())
--   * All ALTER TABLE ADD COLUMN from the Postgres file are folded into the
--     base CREATE TABLE here (SQLite ADD COLUMN can't add non-constant
--     defaults or IF NOT EXISTS).
--   * Every *_usd money column is renamed *_cents and stored as INTEGER
--     (integer cents, not decimal dollars) to avoid float drift and to make
--     unit mistakes loud during the API rewrite — do not write a dollar
--     float into one of these columns.
--   * Confirmed against the live remote D1 instance that foreign key
--     enforcement is ON by default (unlike vanilla SQLite) — CASCADE/SET
--     NULL below fire correctly with no PRAGMA needed from the Worker code.
--
--  NOTE: this only covers the 35 tables + view that actually exist in the
--  live Postgres database today. Several routes in server.js reference
--  tables that were never migrated into schema.sql and do not exist live
--  (coupons, coupon_redemptions, wishlist, user_vehicles, user_addresses,
--  user_messages, work_order_payments, stock_counts, stock_count_items,
--  stock_movements, parts_requisitions, time_entries, cash_drawers) — those
--  routes are already non-functional in production. They are intentionally
--  left out of this migration and will be added when Phase 5 ports the
--  specific admin routes that need them.
-- ============================================================================

-- USERS ------------------------------------------------------------------
CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT UNIQUE NOT NULL,
  name          TEXT,
  password_hash TEXT,
  phone         TEXT,
  via           TEXT,                          -- 'local' | 'google' | 'facebook'
  is_admin      INTEGER NOT NULL DEFAULT 0,
  email_opt_in  INTEGER NOT NULL DEFAULT 1,
  price_tier    TEXT,
  created_at    TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_users_email ON users (lower(email));

-- PRODUCTS -----------------------------------------------------------------
-- The image filename is the natural primary key -- stable and ties the
-- product to the photo asset (now in R2 / Pages static assets).
CREATE TABLE products (
  img            TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  make_model     TEXT NOT NULL,
  category       TEXT NOT NULL,
  condition      TEXT NOT NULL,                -- 'NEW' | 'USED'
  price_cents    INTEGER,
  stock_count    INTEGER NOT NULL DEFAULT 5,
  low_threshold  INTEGER NOT NULL DEFAULT 4,
  is_active      INTEGER NOT NULL DEFAULT 1,
  location       TEXT,
  bin_location   TEXT,
  sku            TEXT,
  cost_cents     INTEGER,
  created_at     TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at     TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_products_category ON products (category);
CREATE INDEX idx_products_active   ON products (is_active);

-- CART ---------------------------------------------------------------------
CREATE TABLE cart_items (
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  product_img TEXT    REFERENCES products(img) ON DELETE CASCADE,
  qty         INTEGER NOT NULL CHECK (qty > 0),
  updated_at  TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, product_img)
);

-- ORDERS ---------------------------------------------------------------------
CREATE TABLE orders (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  total_cents     INTEGER,
  status          TEXT NOT NULL DEFAULT 'pending',    -- pending|confirmed|ready|completed|cancelled
  notes           TEXT,
  payment_method  TEXT NOT NULL DEFAULT 'cash_pickup', -- cash_pickup|bank_transfer|stripe
  payment_status  TEXT NOT NULL DEFAULT 'unpaid',      -- unpaid|paid|refunded|failed
  payment_ref     TEXT,                                -- e.g. Stripe session/payment_intent id
  created_at      TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_orders_user ON orders (user_id);

CREATE TABLE order_items (
  order_id    INTEGER REFERENCES orders(id) ON DELETE CASCADE,
  product_img TEXT    NOT NULL,
  qty         INTEGER NOT NULL,
  price_cents INTEGER NOT NULL,
  PRIMARY KEY (order_id, product_img)
);

-- REVIEWS --------------------------------------------------------------------
CREATE TABLE reviews (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  city        TEXT,
  vehicle     TEXT,
  rating      INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body        TEXT NOT NULL,
  approved    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_reviews_approved ON reviews (approved, created_at DESC);

-- NOTIFY-WHEN-BACK-IN-STOCK ----------------------------------------------
CREATE TABLE notify_subscriptions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  product_img  TEXT REFERENCES products(img) ON DELETE CASCADE,
  email        TEXT NOT NULL,
  phone        TEXT,
  notified_at  TEXT,
  created_at   TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (product_img, email)
);

-- SERVICE & REPAIR APPOINTMENTS --------------------------------------------
CREATE TABLE service_appointments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name            TEXT NOT NULL,
  phone           TEXT NOT NULL,
  email           TEXT,
  vehicle_make    TEXT,
  vehicle_model   TEXT,
  vehicle_year    INTEGER,
  service_type    TEXT,
  preferred_date  TEXT,
  time_slot       TEXT,
  notes           TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',    -- pending|confirmed|completed|cancelled
  created_at      TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_service_status ON service_appointments (status, preferred_date);

-- PARTS INQUIRIES (Quote Requests) -----------------------------------------
CREATE TABLE parts_inquiries (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name              TEXT NOT NULL,
  phone             TEXT NOT NULL,
  vehicle_make      TEXT,
  vehicle_model     TEXT,
  vehicle_year      INTEGER,
  condition         TEXT,
  part_description  TEXT NOT NULL,
  photo_path        TEXT,
  status            TEXT NOT NULL DEFAULT 'new',       -- new|quoted|won|lost
  created_at        TEXT DEFAULT CURRENT_TIMESTAMP
);

-- NEWSLETTER SUBSCRIBERS -----------------------------------------------------
CREATE TABLE newsletter_subscribers (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  email          TEXT UNIQUE NOT NULL,
  source         TEXT,
  subscribed_at  TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_newsletter_email ON newsletter_subscribers (lower(email));

-- LOYALTY POINTS ---------------------------------------------------------
-- Append-only ledger of point changes. Each row earns (delta > 0) or burns
-- (delta < 0) points for a user with a reason and optional reference id.
CREATE TABLE points_transactions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta         INTEGER NOT NULL,
  reason        TEXT NOT NULL,        -- signup_bonus | purchase | review | redemption | admin_adjust
  reference_id  INTEGER,              -- order_id, review_id, etc.
  created_at    TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_points_user ON points_transactions (user_id, created_at DESC);

-- Prevent double-awarding the same earn-event.
CREATE UNIQUE INDEX uq_points_earn
  ON points_transactions (user_id, reason, reference_id)
  WHERE reason IN ('purchase', 'review', 'signup_bonus');

-- Computed balance per user (sum the ledger).
DROP VIEW IF EXISTS user_points;
CREATE VIEW user_points AS
  SELECT user_id, CAST(COALESCE(SUM(delta), 0) AS INTEGER) AS balance
  FROM points_transactions
  GROUP BY user_id;

-- TRADE-IN OFFERS ------------------------------------------------------------
-- Customers offering their vehicle to Morty's Auto Parts as trade-in or outright sale.
CREATE TABLE trade_in_offers (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name               TEXT NOT NULL,
  phone              TEXT NOT NULL,
  email              TEXT,
  vehicle_year       INTEGER,
  vehicle_make       TEXT,
  vehicle_model      TEXT,
  mileage            INTEGER,
  condition          TEXT,           -- 'excellent' | 'good' | 'fair' | 'poor'
  transmission       TEXT,           -- 'auto' | 'manual'
  asking_price_cents INTEGER,
  vin                TEXT,
  notes              TEXT,
  photo_path         TEXT,
  intent             TEXT NOT NULL DEFAULT 'trade_in',  -- 'trade_in' | 'sell'
  status             TEXT NOT NULL DEFAULT 'new',        -- new|reviewing|offered|accepted|declined
  staff_offer_cents  INTEGER,
  created_at         TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_trade_in_status ON trade_in_offers (status, created_at DESC);

-- INSPECTIONS ------------------------------------------------------------
-- Multi-point vehicle inspection -- used for both used-car intake (trade-ins,
-- pre-sale check) and service-center diagnostic visits. Photos with annotation
-- markup are stored separately so multiple photos can attach to one inspection.
CREATE TABLE inspections (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  inspector_id           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  inspector_name         TEXT,
  kind                   TEXT NOT NULL DEFAULT 'used_car',  -- 'used_car'|'service'|'trade_in'
  vehicle_year           INTEGER,
  vehicle_make           TEXT,
  vehicle_model          TEXT,
  vin                    TEXT,
  mileage                INTEGER,
  license_plate          TEXT,
  customer_name          TEXT,
  customer_phone         TEXT,
  trade_in_offer_id      INTEGER REFERENCES trade_in_offers(id) ON DELETE SET NULL,
  service_appointment_id INTEGER REFERENCES service_appointments(id) ON DELETE SET NULL,
  status                 TEXT NOT NULL DEFAULT 'in_progress',
  overall_notes          TEXT,
  created_at             TEXT DEFAULT CURRENT_TIMESTAMP,
  completed_at           TEXT
);
CREATE INDEX idx_inspections_kind ON inspections (kind, created_at DESC);

CREATE TABLE inspection_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  inspection_id  INTEGER NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  category       TEXT NOT NULL,
  item           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending',  -- pending|pass|attention|fail|n_a
  severity       TEXT,
  notes          TEXT,
  updated_at     TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_inspection_items_insp ON inspection_items (inspection_id);

CREATE TABLE inspection_photos (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  inspection_id INTEGER NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  photo_path    TEXT NOT NULL,
  caption       TEXT,
  annotations   TEXT DEFAULT '[]',   -- JSON-encoded array
  area          TEXT,
  created_at    TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_inspection_photos_insp ON inspection_photos (inspection_id);

-- MECHANICS ------------------------------------------------------------
-- Staff who perform service work. Optionally linked to a user account if the
-- mechanic also signs in to the admin (e.g. updates their own work orders).
CREATE TABLE mechanics (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name              TEXT NOT NULL,
  phone             TEXT,
  email             TEXT,
  specialty         TEXT,        -- 'Engine','Brakes','Body','General','Wheel Alignment','Electrical'
  certifications    TEXT,
  hourly_rate_cents INTEGER NOT NULL DEFAULT 2500,
  hire_date         TEXT,
  is_active         INTEGER NOT NULL DEFAULT 1,
  notes             TEXT,
  role              TEXT NOT NULL DEFAULT 'mechanic',   -- 'mechanic'|'advisor'|'both'
  created_at        TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_mechanics_active ON mechanics (is_active);

-- WORK ORDERS --------------------------------------------------------------
-- The service-center repair ticket. One work order per visit per vehicle.
CREATE TABLE work_orders (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  wo_number              TEXT UNIQUE,                  -- auto-generated WO-YYYY-NNNN
  customer_user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  customer_name          TEXT NOT NULL,
  customer_phone         TEXT NOT NULL,
  customer_email         TEXT,
  vehicle_year           INTEGER,
  vehicle_make           TEXT,
  vehicle_model          TEXT,
  vehicle_vin            TEXT,
  license_plate          TEXT,
  mileage_in             INTEGER,
  assigned_mechanic_id   INTEGER REFERENCES mechanics(id) ON DELETE SET NULL,
  service_appointment_id INTEGER REFERENCES service_appointments(id) ON DELETE SET NULL,
  inspection_id          INTEGER REFERENCES inspections(id) ON DELETE SET NULL,
  complaint              TEXT,                          -- customer's reported issue
  diagnosis              TEXT,                          -- mechanic's findings
  work_performed         TEXT,                          -- summary of repair
  status                 TEXT NOT NULL DEFAULT 'open',  -- open|in_progress|awaiting_parts|completed|billed|paid|cancelled
  priority               TEXT NOT NULL DEFAULT 'normal',
  intake_date            TEXT DEFAULT CURRENT_TIMESTAMP,
  promised_date          TEXT,
  completed_at           TEXT,
  paid_at                TEXT,
  labor_total_cents      INTEGER NOT NULL DEFAULT 0,
  parts_total_cents      INTEGER NOT NULL DEFAULT 0,
  tax_cents              INTEGER NOT NULL DEFAULT 0,
  total_cents            INTEGER NOT NULL DEFAULT 0,
  customer_signature     TEXT,                          -- data:image/png;base64 from canvas
  customer_signed_at     TEXT,
  payment_method         TEXT,
  internal_notes         TEXT,
  created_by             INTEGER REFERENCES users(id) ON DELETE SET NULL,
  service_advisor_id     INTEGER REFERENCES mechanics(id) ON DELETE SET NULL,
  created_at             TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_work_orders_status  ON work_orders (status, created_at DESC);
CREATE INDEX idx_work_orders_mech    ON work_orders (assigned_mechanic_id);
CREATE INDEX idx_work_orders_advisor ON work_orders (service_advisor_id);

-- Labor lines (one per task the mechanic did)
CREATE TABLE work_order_labor (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  work_order_id   INTEGER NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  mechanic_id     INTEGER REFERENCES mechanics(id) ON DELETE SET NULL,
  description     TEXT NOT NULL,
  hours           REAL NOT NULL CHECK (hours > 0),
  rate_cents      INTEGER NOT NULL,
  total_cents     INTEGER NOT NULL,
  performed_date  TEXT DEFAULT CURRENT_DATE,
  created_at      TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_wo_labor_order ON work_order_labor (work_order_id);

-- Parts lines (either from inventory via product_img, or a free-text custom item)
CREATE TABLE work_order_parts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  work_order_id     INTEGER NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  product_img       TEXT REFERENCES products(img) ON DELETE SET NULL,
  description       TEXT NOT NULL,
  qty               INTEGER NOT NULL DEFAULT 1 CHECK (qty > 0),
  unit_price_cents  INTEGER NOT NULL,
  total_cents       INTEGER NOT NULL,
  created_at        TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_wo_parts_order ON work_order_parts (work_order_id);

-- SERVICES CATALOG -----------------------------------------------------------
CREATE TABLE services (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  code                  TEXT UNIQUE,
  name                  TEXT NOT NULL,
  category              TEXT,
  description           TEXT,
  default_hours         REAL DEFAULT 1.00,
  default_price_cents   INTEGER,
  is_active             INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT DEFAULT CURRENT_TIMESTAMP
);

-- SERVICE REQUISITIONS (estimates that can convert to work orders) -----------
CREATE TABLE service_requisitions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  customer_name     TEXT,
  customer_phone    TEXT,
  vehicle_info      TEXT,
  notes             TEXT,
  status            TEXT NOT NULL DEFAULT 'draft',
  total_cents       INTEGER DEFAULT 0,
  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at        TEXT DEFAULT CURRENT_TIMESTAMP,
  converted_wo_id   INTEGER REFERENCES work_orders(id) ON DELETE SET NULL
);
CREATE TABLE service_requisition_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  req_id          INTEGER NOT NULL REFERENCES service_requisitions(id) ON DELETE CASCADE,
  service_id      INTEGER REFERENCES services(id) ON DELETE SET NULL,
  description     TEXT NOT NULL,
  hours           REAL,
  price_cents     INTEGER
);

-- TIME CLOCK -------------------------------------------------------------
CREATE TABLE time_punches (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  mechanic_id   INTEGER NOT NULL REFERENCES mechanics(id) ON DELETE CASCADE,
  work_order_id INTEGER REFERENCES work_orders(id) ON DELETE SET NULL,
  punch_in_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  punch_out_at  TEXT,
  labor_id      INTEGER
);

-- WAREHOUSE / ACTIVITY -------------------------------------------------------
CREATE TABLE warehouse_activity (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  action        TEXT NOT NULL,
  ref_kind      TEXT,
  ref_id        INTEGER,
  product_img   TEXT,
  performed_by  TEXT,
  notes         TEXT,
  meta_json     TEXT,
  created_at    TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_wact_created ON warehouse_activity(created_at DESC);

-- SUPPLIERS / PURCHASE ORDERS -------------------------------------------------
CREATE TABLE suppliers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  contact_name TEXT,
  phone        TEXT,
  email        TEXT,
  address      TEXT,
  notes        TEXT,
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE purchase_orders (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  po_number    TEXT UNIQUE,
  supplier_id  INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  status       TEXT NOT NULL DEFAULT 'draft',
  total_cents  INTEGER DEFAULT 0,
  notes        TEXT,
  created_at   TEXT DEFAULT CURRENT_TIMESTAMP,
  received_at  TEXT
);
CREATE TABLE purchase_order_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  po_id            INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_img      TEXT,
  description      TEXT NOT NULL,
  qty              INTEGER NOT NULL DEFAULT 1,
  unit_cost_cents  INTEGER,
  qty_received     INTEGER DEFAULT 0
);

-- POS ------------------------------------------------------------------------
-- One row per tender is stored in sale_payments (below) to support split
-- tender (e.g. $50 cash + rest on card); payment_method here is back-compat
-- (first method, or 'split' if there's more than one).
CREATE TABLE pos_sales (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_number            TEXT UNIQUE,
  cashier_id                INTEGER REFERENCES users(id) ON DELETE SET NULL,
  cashier_name              TEXT,
  customer_id               INTEGER REFERENCES users(id) ON DELETE SET NULL,
  customer_name             TEXT,
  customer_phone            TEXT,
  vehicle_info              TEXT,
  subtotal_cents            INTEGER DEFAULT 0,
  discount_cents            INTEGER DEFAULT 0,
  tax_cents                 INTEGER DEFAULT 0,
  total_cents               INTEGER DEFAULT 0,
  payment_method             TEXT,
  reference                  TEXT,
  amount_tendered_cents       INTEGER,
  change_due_cents             INTEGER,
  notes                       TEXT,
  voided                      INTEGER NOT NULL DEFAULT 0,
  voided_at                   TEXT,
  voided_by                   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  loyalty_points_redeemed     INTEGER NOT NULL DEFAULT 0,
  loyalty_discount_cents      INTEGER NOT NULL DEFAULT 0,
  loyalty_points_earned       INTEGER NOT NULL DEFAULT 0,
  created_at                  TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_pos_sales_customer ON pos_sales (customer_id, created_at DESC);
CREATE INDEX idx_pos_sales_phone    ON pos_sales (customer_phone);

CREATE TABLE pos_sale_items (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id            INTEGER NOT NULL REFERENCES pos_sales(id) ON DELETE CASCADE,
  product_img        TEXT,
  description        TEXT NOT NULL,
  qty                INTEGER NOT NULL DEFAULT 1,
  unit_price_cents   INTEGER,
  core_charge_cents  INTEGER DEFAULT 0,
  env_fee_cents      INTEGER DEFAULT 0,
  total_cents        INTEGER,
  serial_number      TEXT,
  warranty_until     TEXT
);
CREATE TABLE pos_quotes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_number    TEXT UNIQUE,
  customer_name   TEXT,
  customer_phone  TEXT,
  vehicle_info    TEXT,
  items_json      TEXT,
  subtotal_cents  INTEGER DEFAULT 0,
  discount_cents  INTEGER DEFAULT 0,
  tax_cents       INTEGER DEFAULT 0,
  total_cents     INTEGER DEFAULT 0,
  valid_until     TEXT,
  created_at      TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE pos_favourites (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  items_json    TEXT,
  created_at    TEXT DEFAULT CURRENT_TIMESTAMP
);

-- One row per tender. A single sale can have many rows (e.g. $50 cash + $X card).
CREATE TABLE sale_payments (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id                INTEGER NOT NULL REFERENCES pos_sales(id) ON DELETE CASCADE,
  method                 TEXT NOT NULL,            -- cash|card|cheque|bank|loyalty|gift_card
  amount_cents           INTEGER NOT NULL,
  amount_tendered_cents  INTEGER,                  -- only meaningful for cash (drives change_due)
  reference              TEXT,                      -- card last 4 / cheque # / txn id
  notes                  TEXT,
  created_at             TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_sale_payments_sale   ON sale_payments (sale_id);
CREATE INDEX idx_sale_payments_method ON sale_payments (method);

-- VEHICLES FOR SALE (used-car inventory) -------------------------------------
CREATE TABLE vehicles_for_sale (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  vin                 TEXT,
  stock_number        TEXT,
  year                INTEGER,
  make                TEXT NOT NULL,
  model               TEXT NOT NULL,
  trim                TEXT,
  color_exterior      TEXT,
  color_interior      TEXT,
  body_style          TEXT,
  transmission        TEXT,
  fuel_type           TEXT,
  engine              TEXT,
  drivetrain          TEXT,
  mileage_km          INTEGER,
  features            TEXT,
  condition           TEXT,
  asking_price_cents  INTEGER,
  cost_cents          INTEGER,
  sold_price_cents    INTEGER,
  status              TEXT NOT NULL DEFAULT 'available',
  hero_photo          TEXT,
  notes               TEXT,
  trade_in_id         INTEGER,
  created_at          TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE vehicle_photos (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_id   INTEGER NOT NULL REFERENCES vehicles_for_sale(id) ON DELETE CASCADE,
  photo_path   TEXT NOT NULL,
  caption      TEXT,
  sort_order   INTEGER DEFAULT 0,
  is_hero      INTEGER DEFAULT 0,
  created_at   TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_vehicle_photos_vehicle ON vehicle_photos(vehicle_id, sort_order);

-- MARKETING CAMPAIGNS --------------------------------------------------------
CREATE TABLE marketing_campaigns (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT NOT NULL,
  kind               TEXT NOT NULL,
  subject            TEXT,
  body               TEXT NOT NULL,
  segment            TEXT,
  scheduled_for      TEXT,
  status             TEXT NOT NULL DEFAULT 'draft',
  sent_at            TEXT,
  recipients_count   INTEGER DEFAULT 0,
  sent_count         INTEGER DEFAULT 0,
  failed_count       INTEGER DEFAULT 0,
  created_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at         TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_campaigns_status ON marketing_campaigns(status, created_at DESC);
