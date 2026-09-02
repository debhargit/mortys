-- ============================================================================
--  Morty's Auto Parts — Postgres Schema
--  Run once on a fresh database, e.g.
--    createdb mortysautoparts
--    psql -d mortysautoparts -f schema.sql
--
--  Safe to re-run: every statement uses CREATE TABLE IF NOT EXISTS.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
-- Trigram matching -- lets a plain `LIKE '%term%'` (leading wildcard, so a
-- normal B-tree index can never help it) use a GIN index instead. Needed for
-- product search to stay fast as the catalogue grows past a few thousand
-- rows; see the idx_products_*_trgm indexes below.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- USERS ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  name          TEXT,
  password_hash TEXT,
  phone         TEXT,
  via           TEXT,                       -- 'local' | 'google' | 'facebook'
  is_admin      BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users (lower(email));

-- Safe to re-run: adds is_admin to an older users table without one.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;

-- PRODUCTS -------------------------------------------------------------------
-- The image filename is the natural primary key — it's stable and ties the
-- product to the photo already on disk.
CREATE TABLE IF NOT EXISTS products (
  img            TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  make_model     TEXT NOT NULL,
  category       TEXT NOT NULL,
  condition      TEXT NOT NULL,             -- 'NEW' | 'USED'
  price_usd      NUMERIC(10,2),
  stock_count    INTEGER NOT NULL DEFAULT 5,
  low_threshold  INTEGER NOT NULL DEFAULT 0,
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_products_category ON products (category);
CREATE INDEX IF NOT EXISTS idx_products_active   ON products (is_active);

-- CART -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cart_items (
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  product_img TEXT    REFERENCES products(img) ON DELETE CASCADE,
  qty         INTEGER NOT NULL CHECK (qty > 0),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, product_img)
);

-- ORDERS ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  total_usd       NUMERIC(10,2),
  status          TEXT NOT NULL DEFAULT 'pending',   -- pending | confirmed | ready | completed | cancelled
  notes           TEXT,
  payment_method  TEXT NOT NULL DEFAULT 'cash_pickup', -- cash_pickup | bank_transfer | stripe
  payment_status  TEXT NOT NULL DEFAULT 'unpaid',      -- unpaid | paid | refunded | failed
  payment_ref     TEXT,                                 -- e.g. Stripe session/payment_intent id
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders (user_id);

-- Safe to re-run: adds payment columns to older orders tables.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT 'cash_pickup';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'unpaid';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_ref TEXT;

CREATE TABLE IF NOT EXISTS order_items (
  order_id    INTEGER REFERENCES orders(id) ON DELETE CASCADE,
  product_img TEXT    NOT NULL,
  qty         INTEGER NOT NULL,
  price_usd   NUMERIC(10,2) NOT NULL,
  PRIMARY KEY (order_id, product_img)
);

-- REVIEWS --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reviews (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  city        TEXT,
  vehicle     TEXT,
  rating      SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body        TEXT NOT NULL,
  approved    BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reviews_approved ON reviews (approved, created_at DESC);

-- NOTIFY-WHEN-BACK-IN-STOCK --------------------------------------------------
CREATE TABLE IF NOT EXISTS notify_subscriptions (
  id           SERIAL PRIMARY KEY,
  product_img  TEXT REFERENCES products(img) ON DELETE CASCADE,
  email        TEXT NOT NULL,
  phone        TEXT,
  notified_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (product_img, email)
);

-- SERVICE & REPAIR APPOINTMENTS ----------------------------------------------
CREATE TABLE IF NOT EXISTS service_appointments (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name            TEXT NOT NULL,
  phone           TEXT NOT NULL,
  email           TEXT,
  vehicle_make    TEXT,
  vehicle_model   TEXT,
  vehicle_year    SMALLINT,
  service_type    TEXT,
  preferred_date  DATE,
  time_slot       TEXT,
  notes           TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',   -- pending | confirmed | completed | cancelled
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_service_status ON service_appointments (status, preferred_date);

-- PARTS INQUIRIES (Quote Requests) -------------------------------------------
CREATE TABLE IF NOT EXISTS parts_inquiries (
  id                SERIAL PRIMARY KEY,
  user_id           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name              TEXT NOT NULL,
  phone             TEXT NOT NULL,
  vehicle_make      TEXT,
  vehicle_model     TEXT,
  vehicle_year      SMALLINT,
  condition         TEXT,
  part_description  TEXT NOT NULL,
  photo_path        TEXT,
  status            TEXT NOT NULL DEFAULT 'new',   -- new | quoted | won | lost
  created_at        TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE parts_inquiries ADD COLUMN IF NOT EXISTS photo_path TEXT;

-- NEWSLETTER SUBSCRIBERS -----------------------------------------------------
CREATE TABLE IF NOT EXISTS newsletter_subscribers (
  id             SERIAL PRIMARY KEY,
  email          TEXT UNIQUE NOT NULL,
  source         TEXT,
  subscribed_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_newsletter_email ON newsletter_subscribers (lower(email));

-- LOYALTY POINTS -------------------------------------------------------------
-- Append-only ledger of point changes. Each row earns (delta > 0) or burns
-- (delta < 0) points for a user with a reason and optional reference id.
CREATE TABLE IF NOT EXISTS points_transactions (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta         INTEGER NOT NULL,
  reason        TEXT NOT NULL,        -- signup_bonus | purchase | review | redemption | admin_adjust
  reference_id  INTEGER,              -- order_id, review_id, etc.
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_points_user ON points_transactions (user_id, created_at DESC);

-- Prevent double-awarding the same earn-event (one purchase = one points row,
-- one review approval = one points row, etc.)
CREATE UNIQUE INDEX IF NOT EXISTS uq_points_earn
  ON points_transactions (user_id, reason, reference_id)
  WHERE reason IN ('purchase', 'review', 'signup_bonus');

-- Computed balance per user (sum the ledger).
CREATE OR REPLACE VIEW user_points AS
  SELECT user_id, COALESCE(SUM(delta), 0)::integer AS balance
  FROM points_transactions
  GROUP BY user_id;

-- TRADE-IN OFFERS ------------------------------------------------------------
-- Customers offering their vehicle to Morty's Auto Parts as trade-in or outright sale.
CREATE TABLE IF NOT EXISTS trade_in_offers (
  id               SERIAL PRIMARY KEY,
  user_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name             TEXT NOT NULL,
  phone            TEXT NOT NULL,
  email            TEXT,
  vehicle_year     SMALLINT,
  vehicle_make     TEXT,
  vehicle_model    TEXT,
  mileage          INTEGER,
  condition        TEXT,           -- 'excellent' | 'good' | 'fair' | 'poor'
  transmission     TEXT,           -- 'auto' | 'manual'
  asking_price_usd NUMERIC(10,2),
  vin              TEXT,
  notes            TEXT,
  photo_path       TEXT,
  intent           TEXT NOT NULL DEFAULT 'trade_in',  -- 'trade_in' | 'sell'
  status           TEXT NOT NULL DEFAULT 'new',       -- new | reviewing | offered | accepted | declined
  staff_offer_usd  NUMERIC(10,2),
  created_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_trade_in_status ON trade_in_offers (status, created_at DESC);

-- INSPECTIONS -----------------------------------------------------------------
-- Multi-point vehicle inspection — used for both used-car intake (trade-ins,
-- pre-sale check) and service-center diagnostic visits. Photos with annotation
-- markup are stored separately so multiple photos can attach to one inspection.
CREATE TABLE IF NOT EXISTS inspections (
  id                    SERIAL PRIMARY KEY,
  inspector_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  inspector_name        TEXT,
  kind                  TEXT NOT NULL DEFAULT 'used_car',  -- 'used_car' | 'service' | 'trade_in'
  vehicle_year          SMALLINT,
  vehicle_make          TEXT,
  vehicle_model         TEXT,
  vin                   TEXT,
  mileage               INTEGER,
  license_plate         TEXT,
  customer_name         TEXT,
  customer_phone        TEXT,
  trade_in_offer_id     INTEGER REFERENCES trade_in_offers(id) ON DELETE SET NULL,
  service_appointment_id INTEGER REFERENCES service_appointments(id) ON DELETE SET NULL,
  status                TEXT NOT NULL DEFAULT 'in_progress',
  overall_notes         TEXT,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  completed_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_inspections_kind ON inspections (kind, created_at DESC);

CREATE TABLE IF NOT EXISTS inspection_items (
  id             SERIAL PRIMARY KEY,
  inspection_id  INTEGER NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  category       TEXT NOT NULL,
  item           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending',  -- pending | pass | attention | fail | n_a
  severity       TEXT,
  notes          TEXT,
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_inspection_items_insp ON inspection_items (inspection_id);

CREATE TABLE IF NOT EXISTS inspection_photos (
  id            SERIAL PRIMARY KEY,
  inspection_id INTEGER NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  photo_path    TEXT NOT NULL,
  caption       TEXT,
  annotations   JSONB DEFAULT '[]'::jsonb,
  area          TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_inspection_photos_insp ON inspection_photos (inspection_id);

-- MECHANICS -------------------------------------------------------------------
-- Staff who perform service work. Optionally linked to a user account if the
-- mechanic also signs in to the admin (e.g. updates their own work orders).
CREATE TABLE IF NOT EXISTS mechanics (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name            TEXT NOT NULL,
  phone           TEXT,
  email           TEXT,
  specialty       TEXT,        -- 'Engine', 'Brakes', 'Body', 'General', 'Wheel Alignment', 'Electrical'
  certifications  TEXT,
  hourly_rate_usd NUMERIC(8,2) NOT NULL DEFAULT 25.00,
  hire_date       DATE,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  notes           TEXT,
  role            TEXT NOT NULL DEFAULT 'mechanic',   -- 'mechanic' | 'advisor' | 'both'
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mechanics_active ON mechanics (is_active);
-- Safe re-run: add the role column on existing installs.
ALTER TABLE mechanics ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'mechanic';

-- WORK ORDERS -----------------------------------------------------------------
-- The service-center repair ticket. One work order per visit per vehicle.
CREATE TABLE IF NOT EXISTS work_orders (
  id                     SERIAL PRIMARY KEY,
  wo_number              TEXT UNIQUE,                  -- auto-generated WO-YYYY-NNNN
  customer_user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  customer_name          TEXT NOT NULL,
  customer_phone         TEXT NOT NULL,
  customer_email         TEXT,
  vehicle_year           SMALLINT,
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
  status                 TEXT NOT NULL DEFAULT 'open', -- open|in_progress|awaiting_parts|completed|billed|paid|cancelled
  priority               TEXT NOT NULL DEFAULT 'normal',
  intake_date            TIMESTAMPTZ DEFAULT NOW(),
  promised_date          DATE,
  completed_at           TIMESTAMPTZ,
  paid_at                TIMESTAMPTZ,
  labor_total_usd        NUMERIC(10,2) NOT NULL DEFAULT 0,
  parts_total_usd        NUMERIC(10,2) NOT NULL DEFAULT 0,
  tax_usd                NUMERIC(10,2) NOT NULL DEFAULT 0,
  total_usd              NUMERIC(10,2) NOT NULL DEFAULT 0,
  customer_signature     TEXT,                          -- data:image/png;base64 from canvas
  customer_signed_at     TIMESTAMPTZ,
  payment_method         TEXT,
  internal_notes         TEXT,
  created_by             INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_work_orders_status ON work_orders (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_work_orders_mech ON work_orders (assigned_mechanic_id);
-- Service advisor is the staff member who handles customer intake / approvals / hand-off.
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS service_advisor_id INTEGER REFERENCES mechanics(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_work_orders_advisor ON work_orders (service_advisor_id);

-- Labor lines (one per task the mechanic did)
CREATE TABLE IF NOT EXISTS work_order_labor (
  id              SERIAL PRIMARY KEY,
  work_order_id   INTEGER NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  mechanic_id     INTEGER REFERENCES mechanics(id) ON DELETE SET NULL,
  description     TEXT NOT NULL,
  hours           NUMERIC(5,2) NOT NULL CHECK (hours > 0),
  rate_usd        NUMERIC(8,2) NOT NULL,
  total_usd       NUMERIC(10,2) NOT NULL,
  performed_date  DATE DEFAULT CURRENT_DATE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wo_labor_order ON work_order_labor (work_order_id);

-- Parts lines (either from inventory via product_img, or a free-text custom item)
CREATE TABLE IF NOT EXISTS work_order_parts (
  id              SERIAL PRIMARY KEY,
  work_order_id   INTEGER NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  product_img     TEXT REFERENCES products(img) ON DELETE SET NULL,
  description     TEXT NOT NULL,
  qty             INTEGER NOT NULL DEFAULT 1 CHECK (qty > 0),
  unit_price_usd  NUMERIC(10,2) NOT NULL,
  total_usd       NUMERIC(10,2) NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wo_parts_order ON work_order_parts (work_order_id);

-- =============================================================================
--  P1 FIX (admin/POS audit follow-up, 2026-08-18): server.js has referenced
--  work_order_payments and cash_drawer_sessions since the payments/dashboard/
--  cash-report/cash-drawer endpoints were added, but neither table was ever
--  created here -- every one of those endpoints (GET /api/admin/dashboard,
--  GET /api/admin/cash-report, GET+POST /api/admin/cash-drawer/*,
--  GET+POST+DELETE /api/admin/work-orders/:id/payments, GET /api/invoice/:wo)
--  has been throwing `relation does not exist` since day one. Adding both
--  tables now so the Dashboard and Cash Report admin tabs (and invoices) work.
-- =============================================================================
CREATE TABLE IF NOT EXISTS work_order_payments (
  id              SERIAL PRIMARY KEY,
  work_order_id   INTEGER NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  method          TEXT NOT NULL,     -- 'cash' | 'card' | 'bank_transfer' | 'cheque' | 'mobile'
  amount_usd      NUMERIC(10,2) NOT NULL CHECK (amount_usd > 0),
  reference       TEXT,
  received_by     INTEGER REFERENCES mechanics(id) ON DELETE SET NULL,
  notes           TEXT,
  received_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wo_payments_order ON work_order_payments (work_order_id);
CREATE INDEX IF NOT EXISTS idx_wo_payments_received_at ON work_order_payments (received_at);

CREATE TABLE IF NOT EXISTS cash_drawer_sessions (
  id              SERIAL PRIMARY KEY,
  opened_by       INTEGER REFERENCES mechanics(id) ON DELETE SET NULL,
  opening_float   NUMERIC(10,2) NOT NULL DEFAULT 0,
  notes           TEXT,
  opened_at       TIMESTAMPTZ DEFAULT NOW(),
  closed_by       INTEGER REFERENCES mechanics(id) ON DELETE SET NULL,
  closing_amount  NUMERIC(10,2),
  expected_cash   NUMERIC(10,2),
  variance        NUMERIC(10,2),
  closed_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_cash_drawer_open ON cash_drawer_sessions (closed_at);

-- SERVICES CATALOG ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS services (
  id                  SERIAL PRIMARY KEY,
  code                TEXT UNIQUE,
  name                TEXT NOT NULL,
  category            TEXT,
  description         TEXT,
  default_hours       NUMERIC(5,2) DEFAULT 1.00,
  default_price_usd   NUMERIC(10,2),
  is_active           BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- SERVICE REQUISITIONS (estimates that can convert to work orders) -----------
CREATE TABLE IF NOT EXISTS service_requisitions (
  id                SERIAL PRIMARY KEY,
  customer_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  customer_name     TEXT,
  customer_phone    TEXT,
  vehicle_info      TEXT,
  notes             TEXT,
  status            TEXT NOT NULL DEFAULT 'draft',
  total_usd         NUMERIC(10,2) DEFAULT 0,
  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  converted_wo_id   INTEGER REFERENCES work_orders(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS service_requisition_items (
  id              SERIAL PRIMARY KEY,
  req_id          INTEGER NOT NULL REFERENCES service_requisitions(id) ON DELETE CASCADE,
  service_id      INTEGER REFERENCES services(id) ON DELETE SET NULL,
  description     TEXT NOT NULL,
  hours           NUMERIC(5,2),
  price_usd       NUMERIC(10,2)
);

-- TIME CLOCK ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS time_punches (
  id            SERIAL PRIMARY KEY,
  mechanic_id   INTEGER NOT NULL REFERENCES mechanics(id) ON DELETE CASCADE,
  work_order_id INTEGER REFERENCES work_orders(id) ON DELETE SET NULL,
  punch_in_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  punch_out_at  TIMESTAMPTZ,
  labor_id      INTEGER
);

-- WAREHOUSE / ACTIVITY --------------------------------------------------------
CREATE TABLE IF NOT EXISTS warehouse_activity (
  id            SERIAL PRIMARY KEY,
  action        TEXT NOT NULL,
  ref_kind      TEXT,
  ref_id        INTEGER,
  product_img   TEXT,
  performed_by  TEXT,
  notes         TEXT,
  meta_json     JSONB,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wact_created ON warehouse_activity(created_at DESC);

-- SUPPLIERS / PURCHASE ORDERS -------------------------------------------------
CREATE TABLE IF NOT EXISTS suppliers (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  contact_name TEXT,
  phone        TEXT,
  email        TEXT,
  address      TEXT,
  notes        TEXT,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS purchase_orders (
  id           SERIAL PRIMARY KEY,
  po_number    TEXT UNIQUE,
  supplier_id  INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  status       TEXT NOT NULL DEFAULT 'draft',
  total_usd    NUMERIC(10,2) DEFAULT 0,
  notes        TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  received_at  TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS purchase_order_items (
  id            SERIAL PRIMARY KEY,
  po_id         INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_img   TEXT,
  description   TEXT NOT NULL,
  qty           INTEGER NOT NULL DEFAULT 1,
  unit_cost_usd NUMERIC(10,2),
  qty_received  INTEGER DEFAULT 0
);

-- POS ------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pos_sales (
  id              SERIAL PRIMARY KEY,
  receipt_number  TEXT UNIQUE,
  cashier_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  cashier_name    TEXT,
  customer_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  customer_name   TEXT,
  customer_phone  TEXT,
  vehicle_info    TEXT,
  subtotal_usd    NUMERIC(10,2) DEFAULT 0,
  discount_usd    NUMERIC(10,2) DEFAULT 0,
  tax_usd         NUMERIC(10,2) DEFAULT 0,
  total_usd       NUMERIC(10,2) DEFAULT 0,
  payment_method  TEXT,
  reference       TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS pos_sale_items (
  id               SERIAL PRIMARY KEY,
  sale_id          INTEGER NOT NULL REFERENCES pos_sales(id) ON DELETE CASCADE,
  product_img      TEXT,
  description      TEXT NOT NULL,
  qty              INTEGER NOT NULL DEFAULT 1,
  unit_price_usd   NUMERIC(10,2),
  core_charge_usd  NUMERIC(10,2) DEFAULT 0,
  env_fee_usd      NUMERIC(10,2) DEFAULT 0,
  total_usd        NUMERIC(10,2),
  serial_number    TEXT,
  warranty_until   DATE
);
CREATE TABLE IF NOT EXISTS pos_quotes (
  id              SERIAL PRIMARY KEY,
  quote_number    TEXT UNIQUE,
  customer_name   TEXT,
  customer_phone  TEXT,
  vehicle_info    TEXT,
  items_json      JSONB,
  subtotal_usd    NUMERIC(10,2) DEFAULT 0,
  discount_usd    NUMERIC(10,2) DEFAULT 0,
  tax_usd         NUMERIC(10,2) DEFAULT 0,
  total_usd       NUMERIC(10,2) DEFAULT 0,
  valid_until     DATE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS pos_favourites (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  items_json    JSONB,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================================================
--  TASK #65: product location, vehicle photo gallery, marketing
-- =============================================================================
ALTER TABLE products ADD COLUMN IF NOT EXISTS location TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS bin_location TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS sku TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS cost_usd NUMERIC(10,2);

-- =============================================================================
--  P0 FIX (admin/POS audit, 2026-08-18): server.js has referenced these
--  products columns since the products-ext / bin-lookup / barcode-scan
--  endpoints were added (see products-ext PATCH allow-list, GET
--  /api/admin/lookup, GET /api/admin/bin/:bin), but they were never created
--  here — every request to those endpoints threw `column does not exist` and
--  (before the app.<method> auto-wrap + error handler added in server.js)
--  crashed the entire process. Adding them now.
-- =============================================================================
ALTER TABLE products ADD COLUMN IF NOT EXISTS barcode         TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS supplier_id     INTEGER REFERENCES suppliers(id);
ALTER TABLE products ADD COLUMN IF NOT EXISTS core_charge_usd NUMERIC(10,2) DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS env_fee_usd     NUMERIC(10,2) DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS warranty_days   INTEGER;
ALTER TABLE products ADD COLUMN IF NOT EXISTS serial_required BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE products ADD COLUMN IF NOT EXISTS weight_kg       NUMERIC(8,3);
ALTER TABLE products ADD COLUMN IF NOT EXISTS dim_cm          TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS min_stock       INTEGER;
ALTER TABLE products ADD COLUMN IF NOT EXISTS markup_pct      NUMERIC(6,2);
CREATE INDEX IF NOT EXISTS idx_products_barcode ON products (barcode);
CREATE INDEX IF NOT EXISTS idx_products_sku     ON products (sku);

-- =============================================================================
--  PRODUCT SEARCH PERFORMANCE (P2, 2026-08-18)
--
--  GET /api/products matches search terms with lower(col) LIKE '%term%' --
--  a leading wildcard, which a plain B-tree index (like the two just above)
--  can never use. At a few dozen rows that doesn't matter; at real inventory
--  scale (tens of thousands of parts and up) it means a full sequential scan
--  on every keystroke. GIN trigram indexes let Postgres use an index for
--  substring matching instead. The (category, name) index covers the other
--  common case -- browsing/paging a category with no search text -- where
--  the query only filters + sorts, no LIKE involved.
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_products_category_name   ON products (category, name) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_products_stock_count     ON products (stock_count) WHERE is_active = true;

-- ----- Search column consolidation (2026-08-18, load-tested at 100k rows) ---
-- The four per-column trigram indexes above (name/make_model/sku/barcode,
-- combined with OR in buildProductWhere()) were the original approach and
-- were *believed* fast on the strength of "trigram indexes exist" -- never
-- actually measured at real inventory scale. Seeded 100,000 synthetic
-- products and ran EXPLAIN ANALYZE on the real query: the planner ignored
-- all four trigram indexes (an OR across 4 separate GIN indexes on top of
-- an ORDER BY it could already satisfy from idx_products_category_name
-- confused it into a plain filtered index scan) and took 1.5 SECONDS per
-- search -- effectively a full-table scan on every keystroke, the exact
-- failure mode this block's own comment warned about.
--
-- Fix: one generated column concatenating all four searchable fields, one
-- trigram index on it. A single indexed condition instead of an OR across
-- four indexes reliably gets picked up by the planner. Re-measured at the
-- same 100k rows: ~1500ms -> low tens of ms for a common/generic term,
-- and ~10ms for a realistic specific search (a part number/SKU-like term,
-- which is what POS staff mostly type). The four single-column trigram
-- indexes are dropped -- buildProductWhere() no longer queries those
-- columns directly with LIKE, so they were pure write overhead (every
-- product insert/update was maintaining 4 GIN indexes for zero read
-- benefit) with nothing left reading them.
ALTER TABLE products ADD COLUMN IF NOT EXISTS search_text TEXT GENERATED ALWAYS AS (
  lower(coalesce(name,'') || ' ' || coalesce(make_model,'') || ' ' || coalesce(sku,'') || ' ' || coalesce(barcode,''))
) STORED;
CREATE INDEX IF NOT EXISTS idx_products_search_trgm ON products USING gin (search_text gin_trgm_ops);
DROP INDEX IF EXISTS idx_products_name_trgm;
DROP INDEX IF EXISTS idx_products_make_model_trgm;
DROP INDEX IF EXISTS idx_products_sku_trgm;
DROP INDEX IF EXISTS idx_products_barcode_trgm;

-- POS filter bar: Vehicle (make_model, exact match) and Price range filters,
-- added alongside the existing category/condition/stock ones. Both are
-- equality/range predicates on plain columns -- ordinary B-tree indexes,
-- no trigram needed (that's only for the leading-wildcard LIKE search).
CREATE INDEX IF NOT EXISTS idx_products_make_model    ON products (make_model) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_products_price         ON products (price_usd) WHERE is_active = true;

ALTER TABLE users ADD COLUMN IF NOT EXISTS email_opt_in BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS price_tier TEXT;

CREATE TABLE IF NOT EXISTS vehicles_for_sale (
  id SERIAL PRIMARY KEY,
  vin TEXT,
  stock_number TEXT,
  year INTEGER,
  make TEXT NOT NULL,
  model TEXT NOT NULL,
  trim TEXT,
  color_exterior TEXT,
  color_interior TEXT,
  body_style TEXT,
  transmission TEXT,
  fuel_type TEXT,
  engine TEXT,
  drivetrain TEXT,
  mileage_km INTEGER,
  features TEXT,
  condition TEXT,
  asking_price_usd NUMERIC(10,2),
  cost_usd NUMERIC(10,2),
  sold_price_usd NUMERIC(10,2),
  status TEXT NOT NULL DEFAULT 'available',
  hero_photo TEXT,
  notes TEXT,
  trade_in_id INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vehicle_photos (
  id SERIAL PRIMARY KEY,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles_for_sale(id) ON DELETE CASCADE,
  photo_path TEXT NOT NULL,
  caption TEXT,
  sort_order INTEGER DEFAULT 0,
  is_hero BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_vehicle_photos_vehicle ON vehicle_photos(vehicle_id, sort_order);

CREATE TABLE IF NOT EXISTS marketing_campaigns (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject TEXT,
  body TEXT NOT NULL,
  segment TEXT,
  scheduled_for TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'draft',
  sent_at TIMESTAMPTZ,
  recipients_count INTEGER DEFAULT 0,
  sent_count INTEGER DEFAULT 0,
  failed_count INTEGER DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_campaigns_status ON marketing_campaigns(status, created_at DESC);

-- =============================================================================
--  TASK #68b: Tender Modal Phase 2 — split tender, loyalty redemption, customer lookup
-- =============================================================================
-- Backfill pos_sales columns referenced by the server but not declared above.
ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS amount_tendered         NUMERIC(10,2);
ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS change_due              NUMERIC(10,2);
ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS notes                   TEXT;
ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS voided                  BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS voided_at               TIMESTAMPTZ;
ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS voided_by               INTEGER REFERENCES users(id) ON DELETE SET NULL;
-- Phase 2 additions: loyalty redemption stored at the sale level.
ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS loyalty_points_redeemed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS loyalty_discount_usd    NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS loyalty_points_earned   INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_pos_sales_customer ON pos_sales (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pos_sales_phone    ON pos_sales (customer_phone);

-- One row per tender. A single sale can have many rows (e.g. $50 cash + $X card).
-- payment_method on pos_sales is still populated for back-compat (set to the
-- first method, or 'split' if there are >1 methods).
CREATE TABLE IF NOT EXISTS sale_payments (
  id              SERIAL PRIMARY KEY,
  sale_id         INTEGER NOT NULL REFERENCES pos_sales(id) ON DELETE CASCADE,
  method          TEXT NOT NULL,            -- cash | card | cheque | bank | loyalty | gift_card
  amount_usd      NUMERIC(10,2) NOT NULL,
  amount_tendered NUMERIC(10,2),            -- only meaningful for cash (drives change_due)
  reference       TEXT,                     -- card last 4 / cheque # / txn id
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sale_payments_sale ON sale_payments (sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_payments_method ON sale_payments (method);

-- =============================================================================
--  COMPREHENSIVE SCHEMA-DRIFT FIX (admin/POS audit, 2026-08-18)
--
--  A systematic sweep hit every admin GET endpoint against the live server and
--  found 15 of ~40 returning 500s -- server.js has referenced these tables and
--  columns since the relevant features were written, but they were never
--  created here. This block adds everything found missing. See
--  ADMIN-POS-AUDIT.md for the full investigation and per-endpoint findings.
-- =============================================================================

-- ----- Customer CRM: extended profile fields on users -----------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS company_name    TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS customer_type   TEXT;              -- 'retail' | 'trade' | 'fleet' | 'dealer'
ALTER TABLE users ADD COLUMN IF NOT EXISTS tax_id          TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS credit_limit_usd NUMERIC(10,2);
ALTER TABLE users ADD COLUMN IF NOT EXISTS discount_pct    NUMERIC(5,2);
ALTER TABLE users ADD COLUMN IF NOT EXISTS sales_rep_id    INTEGER REFERENCES mechanics(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS how_heard       TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS rating          SMALLINT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS internal_notes  TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS sms_opt_in      BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_contact TEXT;           -- 'email' | 'phone' | 'sms' | 'whatsapp'

-- ----- Customer accounts: account number, terms, discount ceiling (P3) ------
-- account_number is the human-facing id staff search/quote by (mirrors the
-- account_number pattern already used on suppliers). payment_terms_days is
-- "how long they have to pay" (0/null = pay now; 30 = Net 30, etc.) and is
-- checked against credit_limit_usd at sale time. discount_limit_pct caps how
-- much line/ticket discount a cashier can give this customer, independent of
-- discount_pct (their standing price-tier discount) -- one is what they get
-- by default, the other is the ceiling on top of that a cashier may add.
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_number    TEXT UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS payment_terms_days INTEGER;
ALTER TABLE users ADD COLUMN IF NOT EXISTS discount_limit_pct NUMERIC(5,2);
-- tax_exempt: GCT is skipped entirely on this customer's POS sales (server-
-- enforced in POST /api/admin/pos/sale, not just a UI display flag). Default
-- false so every existing/new customer stays taxable unless a staff member
-- explicitly flips it on the profile.
ALTER TABLE users ADD COLUMN IF NOT EXISTS tax_exempt BOOLEAN NOT NULL DEFAULT false;
-- Also recorded on the sale itself (not just derived from the current
-- customer.tax_exempt at read time) so a receipt/invoice reprint stays
-- accurate even if the customer's tax status is changed later.
ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS tax_exempt BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_users_account_number ON users (account_number);
-- Backfill account numbers for rows that existed before this column did.
--
-- Numbering continues from the highest C-nnnnnn already issued. The original
-- version restarted ROW_NUMBER() at 1 over just the NULL rows, which is only
-- safe the very first time it runs. On a second run it is not: initDb() seeds
-- the admin user with no account number and the walk-in customer with
-- C-000001, so the next boot handed the admin C-000001 as well and tripped
-- users_account_number_key.
--
-- That was never just a noisy log line. server.js applies this file as one
-- multi-statement query, which Postgres runs in a single implicit
-- transaction, so the unique violation rolled the ENTIRE file back -- every
-- CREATE TABLE and ADD COLUMN in it, silently. Any schema change added below
-- this point would never have reached an existing installation.
--
-- Genuinely idempotent now: it only touches rows still NULL, and the numbers
-- it assigns start above everything already in use, so repeat runs converge
-- and never collide.
UPDATE users u SET account_number = sub.acct
  FROM (
    SELECT id,
           'C-' || LPAD((
             COALESCE((SELECT MAX(substring(account_number from 3)::bigint)
                         FROM users
                        WHERE account_number ~ '^C-[0-9]+$'), 0)
             + ROW_NUMBER() OVER (ORDER BY id)
           )::text, 6, '0') AS acct
      FROM users
     WHERE account_number IS NULL
  ) sub
  WHERE u.id = sub.id;

-- ----- Customer CRM: addresses / contacts / reminders / messages ------------
CREATE TABLE IF NOT EXISTS customer_addresses (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label        TEXT,
  kind         TEXT DEFAULT 'shipping',    -- 'shipping' | 'billing'
  recipient    TEXT,
  line1        TEXT NOT NULL,
  line2        TEXT,
  city         TEXT,
  parish       TEXT,
  postal_code  TEXT,
  country      TEXT DEFAULT 'Jamaica',
  phone        TEXT,
  is_default   BOOLEAN NOT NULL DEFAULT false,
  notes        TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cust_addresses_user ON customer_addresses (user_id);

CREATE TABLE IF NOT EXISTS customer_contacts (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  title        TEXT,
  phone        TEXT,
  email        TEXT,
  is_primary   BOOLEAN NOT NULL DEFAULT false,
  notes        TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cust_contacts_user ON customer_contacts (user_id);

CREATE TABLE IF NOT EXISTS customer_reminders (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  due_date     DATE NOT NULL,
  subject      TEXT NOT NULL,
  body         TEXT,
  assigned_to  INTEGER REFERENCES mechanics(id) ON DELETE SET NULL,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status       TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'done'
  done_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cust_reminders_user ON customer_reminders (user_id);
CREATE INDEX IF NOT EXISTS idx_cust_reminders_due ON customer_reminders (status, due_date);

CREATE TABLE IF NOT EXISTS customer_messages (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender       TEXT NOT NULL,             -- 'staff' | 'customer'
  staff_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body         TEXT NOT NULL,
  read_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cust_messages_user ON customer_messages (user_id, created_at);

CREATE TABLE IF NOT EXISTS customer_notifications (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         TEXT,
  body         TEXT,
  sent_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cust_notifications_user ON customer_notifications (user_id);

-- ----- Coupons ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS coupons (
  code            TEXT PRIMARY KEY,
  kind            TEXT NOT NULL DEFAULT 'flat',   -- 'flat' | 'percent'
  amount          NUMERIC(10,2) NOT NULL,
  min_subtotal    NUMERIC(10,2) DEFAULT 0,
  max_redemptions INTEGER,
  redeemed_count  INTEGER NOT NULL DEFAULT 0,
  expires_at      TIMESTAMPTZ,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  description     TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ----- Schedule blocks (mechanic calendar time-off / non-customer time) -----
CREATE TABLE IF NOT EXISTS schedule_blocks (
  id           SERIAL PRIMARY KEY,
  mechanic_id  INTEGER REFERENCES mechanics(id) ON DELETE CASCADE,
  block_date   DATE NOT NULL,
  time_slot    TEXT,
  reason       TEXT,
  notes        TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_schedule_blocks_date ON schedule_blocks (block_date);
CREATE INDEX IF NOT EXISTS idx_schedule_blocks_mechanic ON schedule_blocks (mechanic_id);

-- ----- Labor standards: vehicle classes / rate tiers / flat-rate ops --------
CREATE TABLE IF NOT EXISTS vehicle_classes (
  code             TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  labor_multiplier NUMERIC(4,2) NOT NULL DEFAULT 1.0,
  description      TEXT
);
CREATE TABLE IF NOT EXISTS labor_rate_tiers (
  id          SERIAL PRIMARY KEY,
  name        TEXT UNIQUE NOT NULL,
  rate_usd    NUMERIC(8,2) NOT NULL,
  description TEXT,
  is_default  BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS labor_rates (
  id          SERIAL PRIMARY KEY,
  code        TEXT UNIQUE NOT NULL,
  category    TEXT,
  operation   TEXT NOT NULL,
  base_hours  NUMERIC(5,2) NOT NULL,
  notes       TEXT,
  source      TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT true
);

-- ----- Stock counts (physical inventory count sessions) ---------------------
CREATE TABLE IF NOT EXISTS stock_counts (
  id             SERIAL PRIMARY KEY,
  count_number   TEXT UNIQUE,
  scope          TEXT NOT NULL DEFAULT 'full',   -- 'full' | 'bin' | 'category'
  scope_value    TEXT,
  status         TEXT NOT NULL DEFAULT 'open',   -- 'open' | 'posted'
  counted_by     INTEGER REFERENCES mechanics(id) ON DELETE SET NULL,
  total_items    INTEGER DEFAULT 0,
  total_variance INTEGER,
  notes          TEXT,
  started_at     TIMESTAMPTZ DEFAULT NOW(),
  posted_at      TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS stock_count_items (
  id            SERIAL PRIMARY KEY,
  count_id      INTEGER NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE,
  product_img   TEXT REFERENCES products(img) ON DELETE SET NULL,
  bin_location  TEXT,
  system_qty    INTEGER NOT NULL DEFAULT 0,
  counted_qty   INTEGER,
  notes         TEXT,
  counted_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_stock_count_items_count ON stock_count_items (count_id);

-- ----- Deliveries -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deliveries (
  id                    SERIAL PRIMARY KEY,
  delivery_number       TEXT UNIQUE,
  related_kind          TEXT,             -- 'order' | 'pos_sale' | 'work_order' | ...
  related_id            INTEGER,
  recipient_name        TEXT NOT NULL,
  recipient_phone       TEXT,
  address               TEXT,
  driver_id             INTEGER REFERENCES mechanics(id) ON DELETE SET NULL,
  vehicle               TEXT,
  status                TEXT NOT NULL DEFAULT 'scheduled',  -- scheduled | dispatched | delivered | cancelled
  scheduled_for         TIMESTAMPTZ,
  dispatched_at         TIMESTAMPTZ,
  delivered_at          TIMESTAMPTZ,
  proof_photo           TEXT,
  proof_signature       TEXT,
  recipient_received_by TEXT,
  notes                 TEXT,
  created_by            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_deliveries_status ON deliveries (status);

-- ----- Parts requisitions (mechanic pulls parts against a work order) -------
CREATE TABLE IF NOT EXISTS parts_requisitions (
  id             SERIAL PRIMARY KEY,
  pr_number      TEXT UNIQUE,
  work_order_id  INTEGER REFERENCES work_orders(id) ON DELETE CASCADE,
  requested_by   INTEGER REFERENCES mechanics(id) ON DELETE SET NULL,
  fulfilled_by   INTEGER REFERENCES mechanics(id) ON DELETE SET NULL,
  status         TEXT NOT NULL DEFAULT 'pending',   -- pending | partial | fulfilled | backordered
  notes          TEXT,
  fulfilled_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS parts_requisition_items (
  id              SERIAL PRIMARY KEY,
  requisition_id  INTEGER NOT NULL REFERENCES parts_requisitions(id) ON DELETE CASCADE,
  product_img     TEXT REFERENCES products(img) ON DELETE SET NULL,
  description     TEXT NOT NULL,
  qty_requested   INTEGER NOT NULL,
  qty_fulfilled   INTEGER NOT NULL DEFAULT 0,
  unit_price_usd  NUMERIC(10,2),
  status          TEXT NOT NULL DEFAULT 'pending'    -- pending | backordered | fulfilled | cancelled
);
CREATE INDEX IF NOT EXISTS idx_parts_req_items_req ON parts_requisition_items (requisition_id);

-- ----- Time clock -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS time_entries (
  id             SERIAL PRIMARY KEY,
  mechanic_id    INTEGER NOT NULL REFERENCES mechanics(id) ON DELETE CASCADE,
  work_order_id  INTEGER REFERENCES work_orders(id) ON DELETE SET NULL,
  description    TEXT,
  clocked_in_at  TIMESTAMPTZ DEFAULT NOW(),
  clocked_out_at TIMESTAMPTZ,
  hours          NUMERIC(5,2),
  labor_entry_id INTEGER REFERENCES work_order_labor(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_time_entries_mechanic ON time_entries (mechanic_id, clocked_in_at);
CREATE INDEX IF NOT EXISTS idx_time_entries_open ON time_entries (clocked_out_at);

-- ----- Saved vehicles (customer account: "my garage") ------------------------
CREATE TABLE IF NOT EXISTS saved_vehicles (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label      TEXT,
  make       TEXT,
  model      TEXT,
  year       INTEGER,
  vin        TEXT,
  nickname   TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, vin)
);

-- ----- Existing-table column fixes -------------------------------------------
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS code             TEXT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS website          TEXT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS payment_terms    TEXT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS account_number   TEXT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS lead_time_days   INTEGER DEFAULT 7;

ALTER TABLE services ADD COLUMN IF NOT EXISTS default_labor_usd NUMERIC(10,2);
ALTER TABLE services ADD COLUMN IF NOT EXISTS default_parts_usd NUMERIC(10,2);

ALTER TABLE pos_quotes ADD COLUMN IF NOT EXISTS status        TEXT NOT NULL DEFAULT 'open';
ALTER TABLE pos_quotes ADD COLUMN IF NOT EXISTS cashier_id    INTEGER REFERENCES mechanics(id) ON DELETE SET NULL;
ALTER TABLE pos_quotes ADD COLUMN IF NOT EXISTS customer_email TEXT;
ALTER TABLE pos_quotes ADD COLUMN IF NOT EXISTS notes         TEXT;

-- service_requisitions / service_requisition_items exist with an older, much
-- simpler column set (req_id, customer_id, price_usd, converted_wo_id, ...)
-- that nothing in server.js references any more -- server.js was rewritten
-- against a richer model and these columns were never added. Leaving the old
-- ones in place (unused, harmless) rather than dropping/renaming.
ALTER TABLE service_requisitions ADD COLUMN IF NOT EXISTS req_number       TEXT;
ALTER TABLE service_requisitions ADD COLUMN IF NOT EXISTS customer_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE service_requisitions ADD COLUMN IF NOT EXISTS customer_email   TEXT;
ALTER TABLE service_requisitions ADD COLUMN IF NOT EXISTS vehicle_year     INTEGER;
ALTER TABLE service_requisitions ADD COLUMN IF NOT EXISTS vehicle_make     TEXT;
ALTER TABLE service_requisitions ADD COLUMN IF NOT EXISTS vehicle_model    TEXT;
ALTER TABLE service_requisitions ADD COLUMN IF NOT EXISTS vehicle_vin      TEXT;
ALTER TABLE service_requisitions ADD COLUMN IF NOT EXISTS license_plate    TEXT;
ALTER TABLE service_requisitions ADD COLUMN IF NOT EXISTS mileage_in       INTEGER;
ALTER TABLE service_requisitions ADD COLUMN IF NOT EXISTS service_advisor_id INTEGER REFERENCES mechanics(id) ON DELETE SET NULL;
ALTER TABLE service_requisitions ADD COLUMN IF NOT EXISTS inspection_id    INTEGER;
ALTER TABLE service_requisitions ADD COLUMN IF NOT EXISTS complaint        TEXT;
ALTER TABLE service_requisitions ADD COLUMN IF NOT EXISTS recommended      TEXT;
ALTER TABLE service_requisitions ADD COLUMN IF NOT EXISTS valid_until      DATE;
ALTER TABLE service_requisitions ADD COLUMN IF NOT EXISTS approved_at      TIMESTAMPTZ;
ALTER TABLE service_requisitions ADD COLUMN IF NOT EXISTS converted_to_work_order_id INTEGER REFERENCES work_orders(id) ON DELETE SET NULL;
ALTER TABLE service_requisitions ADD COLUMN IF NOT EXISTS estimate_total_usd NUMERIC(10,2);
CREATE UNIQUE INDEX IF NOT EXISTS uq_service_requisitions_req_number ON service_requisitions (req_number) WHERE req_number IS NOT NULL;

ALTER TABLE service_requisition_items ADD COLUMN IF NOT EXISTS requisition_id INTEGER REFERENCES service_requisitions(id) ON DELETE CASCADE;
ALTER TABLE service_requisition_items ADD COLUMN IF NOT EXISTS labor_usd      NUMERIC(10,2) DEFAULT 0;
ALTER TABLE service_requisition_items ADD COLUMN IF NOT EXISTS parts_usd      NUMERIC(10,2) DEFAULT 0;
ALTER TABLE service_requisition_items ADD COLUMN IF NOT EXISTS total_usd      NUMERIC(10,2) DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_sri_requisition ON service_requisition_items (requisition_id);

-- warehouse_activity: server.js inserts/reads a `kind` column (table has
-- `action`) and joins mechanics.id (INTEGER) to performed_by (TEXT) -- every
-- activity-log write and the whole warehouse-activity feed has been silently
-- failing (logActivity() swallows its own errors) or 500ing since day one.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='warehouse_activity' AND column_name='action')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='warehouse_activity' AND column_name='kind') THEN
    ALTER TABLE warehouse_activity RENAME COLUMN action TO kind;
  END IF;
END $$;
ALTER TABLE warehouse_activity ADD COLUMN IF NOT EXISTS qty_before   INTEGER;
ALTER TABLE warehouse_activity ADD COLUMN IF NOT EXISTS qty_after    INTEGER;
ALTER TABLE warehouse_activity ADD COLUMN IF NOT EXISTS qty_delta    INTEGER;
ALTER TABLE warehouse_activity ADD COLUMN IF NOT EXISTS bin_location TEXT;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='warehouse_activity' AND column_name='performed_by' AND data_type <> 'integer') THEN
    ALTER TABLE warehouse_activity ALTER COLUMN performed_by TYPE INTEGER USING NULLIF(performed_by, '')::integer;
  END IF;
END $$;

-- =============================================================================
--  SCHEMA-DRIFT FIX, ROUND 2 ("do all improvements" pass, 2026-08-18)
--
--  The endpoint sweep above only tested GET routes. Building the Purchase
--  Orders admin tab surfaced that purchase_orders/purchase_order_items have
--  the exact same "table exists with an older, simpler column set" pattern
--  as service_requisitions did -- POST/PATCH/receive all reference columns
--  that were never added. Since only GETs were swept, this only shows up on
--  writes. Recommend treating any table with this history as suspect for
--  writes even after a clean GET sweep.
-- =============================================================================
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS expected_date  DATE;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS received_date  TIMESTAMPTZ;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS shipping_usd   NUMERIC(10,2) DEFAULT 0;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS tax_usd        NUMERIC(10,2) DEFAULT 0;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS invoice_number TEXT;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS subtotal_usd   NUMERIC(10,2) DEFAULT 0;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- purchase_order_items had `qty` (unused by current code); code uses
-- `qty_ordered` throughout. Leaving `qty` in place, unused, same as the
-- service_requisitions vestigial-column precedent above.
ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS sku         TEXT;
ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS qty_ordered INTEGER;
ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS total_usd   NUMERIC(10,2) DEFAULT 0;
ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS condition   TEXT DEFAULT 'NEW';
ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS notes       TEXT;

-- service_requisition_items.req_id (the old vestigial column, superseded by
-- requisition_id above) still carried its original NOT NULL constraint --
-- current code never populates it, so every insert failed with "null value
-- in column req_id violates not-null constraint". Confirmed via
-- information_schema that this is the ONLY vestigial column across
-- service_requisitions/service_requisition_items/purchase_order_items with
-- this trap (everything else nullable or a currently-used column).
ALTER TABLE service_requisition_items ALTER COLUMN req_id DROP NOT NULL;

-- =============================================================================
--  PRODUCTS PRIMARY-KEY MIGRATION (P2, 2026-08-18)
--
--  products.img (the photo FILENAME) was the primary key every other table
--  joined against -- replacing/renaming a product's photo meant deleting and
--  recreating the product's identity, and every downstream reference was a
--  plain string match rather than a real foreign key to a stable id.
--
--  This adds a real numeric id as the primary key. `img` is KEPT (not
--  dropped or renamed) as a UNIQUE NOT NULL column -- it's still the actual
--  photo filename every frontend page needs for `<img src="...">`, and the
--  storefront/admin/POS/account pages all talk to the backend purely through
--  the JSON REST API (confirmed: no frontend file requires('pg') or touches
--  SQL directly), which stays keyed by `img` as its external contract.
--  Nothing about the API request/response shape changes -- this is a
--  backend/schema-only migration. Every downstream table gets a new
--  `product_id` column (FK to the new products.id), backfilled from the
--  existing product_img matches, and every JOIN in server.js that used to
--  match on `p.img = x.product_img` now matches on `p.id = x.product_id`
--  (see server.js changes in the same commit). `product_img` columns are
--  LEFT IN PLACE everywhere (not dropped) -- still useful for display/
--  debugging and as a safety net; they're just no longer what anything
--  joins on.
-- =============================================================================
ALTER TABLE products ADD COLUMN IF NOT EXISTS id SERIAL;
-- Give every existing row an id if this is the first time this runs (SERIAL
-- default only fires for NEW rows added after the column exists -- backfill
-- explicitly so pre-existing products get one too).
UPDATE products SET id = nextval(pg_get_serial_sequence('products','id')) WHERE id IS NULL;
-- Swap the primary key from img -> id. products_pkey is the default name
-- Postgres gives the original `img TEXT PRIMARY KEY` constraint.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_pkey' AND conrelid = 'products'::regclass) THEN
    -- CASCADE drops the 5 old FK constraints from cart_items/notify_subscriptions/
    -- work_order_parts/stock_count_items/parts_requisition_items that depended
    -- on this specific constraint object (Postgres FKs bind to the constraint,
    -- not dynamically to "whatever unique constraint exists now"). That's fine
    -- here: those tables get new product_id-based FKs to products(id) below in
    -- this same migration, so referential integrity is never actually lost.
    ALTER TABLE products DROP CONSTRAINT products_pkey CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_id_pkey') THEN
    ALTER TABLE products ADD CONSTRAINT products_id_pkey PRIMARY KEY (id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_img_key') THEN
    ALTER TABLE products ADD CONSTRAINT products_img_key UNIQUE (img);
  END IF;
END $$;
ALTER TABLE products ALTER COLUMN img SET NOT NULL;

-- ----- product_id columns on every downstream table, backfilled ------------
ALTER TABLE cart_items ADD COLUMN IF NOT EXISTS product_id INTEGER REFERENCES products(id) ON DELETE CASCADE;
UPDATE cart_items c SET product_id = p.id FROM products p WHERE p.img = c.product_img AND c.product_id IS NULL;

ALTER TABLE order_items ADD COLUMN IF NOT EXISTS product_id INTEGER REFERENCES products(id) ON DELETE SET NULL;
UPDATE order_items oi SET product_id = p.id FROM products p WHERE p.img = oi.product_img AND oi.product_id IS NULL;

ALTER TABLE notify_subscriptions ADD COLUMN IF NOT EXISTS product_id INTEGER REFERENCES products(id) ON DELETE CASCADE;
UPDATE notify_subscriptions n SET product_id = p.id FROM products p WHERE p.img = n.product_img AND n.product_id IS NULL;

ALTER TABLE work_order_parts ADD COLUMN IF NOT EXISTS product_id INTEGER REFERENCES products(id) ON DELETE SET NULL;
UPDATE work_order_parts w SET product_id = p.id FROM products p WHERE p.img = w.product_img AND w.product_id IS NULL;

ALTER TABLE warehouse_activity ADD COLUMN IF NOT EXISTS product_id INTEGER REFERENCES products(id) ON DELETE SET NULL;
UPDATE warehouse_activity wa SET product_id = p.id FROM products p WHERE p.img = wa.product_img AND wa.product_id IS NULL;

ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS product_id INTEGER REFERENCES products(id) ON DELETE SET NULL;
UPDATE purchase_order_items poi SET product_id = p.id FROM products p WHERE p.img = poi.product_img AND poi.product_id IS NULL;

ALTER TABLE pos_sale_items ADD COLUMN IF NOT EXISTS product_id INTEGER REFERENCES products(id) ON DELETE SET NULL;
UPDATE pos_sale_items psi SET product_id = p.id FROM products p WHERE p.img = psi.product_img AND psi.product_id IS NULL;

ALTER TABLE stock_count_items ADD COLUMN IF NOT EXISTS product_id INTEGER REFERENCES products(id) ON DELETE SET NULL;
UPDATE stock_count_items sci SET product_id = p.id FROM products p WHERE p.img = sci.product_img AND sci.product_id IS NULL;

ALTER TABLE parts_requisition_items ADD COLUMN IF NOT EXISTS product_id INTEGER REFERENCES products(id) ON DELETE SET NULL;
UPDATE parts_requisition_items pi SET product_id = p.id FROM products p WHERE p.img = pi.product_img AND pi.product_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_cart_items_product_id ON cart_items (product_id);
CREATE INDEX IF NOT EXISTS idx_order_items_product_id ON order_items (product_id);
CREATE INDEX IF NOT EXISTS idx_notify_subs_product_id ON notify_subscriptions (product_id);
CREATE INDEX IF NOT EXISTS idx_wo_parts_product_id ON work_order_parts (product_id);
CREATE INDEX IF NOT EXISTS idx_wh_activity_product_id ON warehouse_activity (product_id);
CREATE INDEX IF NOT EXISTS idx_po_items_product_id ON purchase_order_items (product_id);
CREATE INDEX IF NOT EXISTS idx_pos_items_product_id ON pos_sale_items (product_id);
CREATE INDEX IF NOT EXISTS idx_stock_items_product_id ON stock_count_items (product_id);
CREATE INDEX IF NOT EXISTS idx_pr_items_product_id ON parts_requisition_items (product_id);

-- ----- wishlist (found missing entirely while doing the PK migration --------
-- GET/POST/DELETE /api/wishlist have referenced this table since that
-- feature was written; it was never created here. Built with product_id
-- from the start so it doesn't need its own follow-up migration.
CREATE TABLE IF NOT EXISTS wishlist (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_img TEXT NOT NULL,
  product_id  INTEGER REFERENCES products(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, product_img)
);
CREATE INDEX IF NOT EXISTS idx_wishlist_product_id ON wishlist (product_id);

-- ----- coupons + orders: found missing while functionally testing checkout --
-- (unrelated to the PK migration -- pre-existing schema drift, found because
-- checkout was actually exercised end-to-end rather than just GET-swept).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS coupon_code TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS coupon_discount_usd NUMERIC(10,2) DEFAULT 0;
CREATE TABLE IF NOT EXISTS coupon_redemptions (
  id           SERIAL PRIMARY KEY,
  coupon_code  TEXT NOT NULL,
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  order_id     INTEGER REFERENCES orders(id) ON DELETE CASCADE,
  discount_usd NUMERIC(10,2) NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (coupon_code, order_id)
);

-- =============================================================================
--  ADMIN ROLE SPLIT (P2, 2026-08-18)
--
--  Every admin login previously had identical, unrestricted access
--  (users.is_admin was the only gate, all-or-nothing). Adds a finer-grained
--  role for accounts that already have is_admin=true: 'owner' | 'manager'
--  (both keep today's full access) or 'cashier' (day-to-day counter work
--  only -- see requireManager() in server.js for exactly which endpoints
--  are now manager-only). is_admin still controls whether an account can
--  reach the admin panel at all; admin_role controls what they can do once
--  inside it.
-- =============================================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_role TEXT NOT NULL DEFAULT 'manager';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_admin_role_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_admin_role_check CHECK (admin_role IN ('owner','manager','cashier'));
  END IF;
END $$;
-- Rebrand (2026): the default admin address moved from melthahonda.com to
-- mortysautoparts.com. Rename the existing row on installs that predate
-- the change so the seed's ON CONFLICT (email) still matches and no second
-- admin account is created. No-op on fresh databases, and skipped if the
-- new address is already present (email is UNIQUE -- a blind UPDATE would
-- abort the whole schema apply).
UPDATE users SET email = 'admin@mortysautoparts.com'
  WHERE email = 'admin@melthahonda.com'
    AND NOT EXISTS (SELECT 1 FROM users u2 WHERE u2.email = 'admin@mortysautoparts.com');

-- The default seeded admin account is the shop owner.
UPDATE users SET admin_role = 'owner' WHERE email = 'admin@mortysautoparts.com';

-- =============================================================================
--  GIFT CARDS (P2, 2026-08-18)
--
--  `gift_card` was already a valid POS tender method (see sale_payments.method
--  comment / the payment-method validation list in POST /api/admin/pos/sale),
--  but nothing backed it -- selecting it just logged an arbitrary payment row
--  with no real balance to check or deduct. This adds a real table + ledger
--  and wires actual validation/deduction into the POS sale endpoint.
-- =============================================================================
CREATE TABLE IF NOT EXISTS gift_cards (
  id               SERIAL PRIMARY KEY,
  code             TEXT UNIQUE NOT NULL,
  initial_balance_usd NUMERIC(10,2) NOT NULL CHECK (initial_balance_usd > 0),
  balance_usd      NUMERIC(10,2) NOT NULL,
  is_active        BOOLEAN NOT NULL DEFAULT true,
  issued_to_name   TEXT,
  issued_to_phone  TEXT,
  issued_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  notes            TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  last_used_at     TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS gift_card_transactions (
  id             SERIAL PRIMARY KEY,
  gift_card_id   INTEGER NOT NULL REFERENCES gift_cards(id) ON DELETE CASCADE,
  delta_usd      NUMERIC(10,2) NOT NULL,   -- positive = issue/reload, negative = redemption
  reason         TEXT NOT NULL,            -- 'issue' | 'reload' | 'redemption'
  reference      TEXT,                     -- e.g. POS receipt number
  performed_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_gift_card_tx_card ON gift_card_transactions (gift_card_id);

-- =============================================================================
--  POS ITEMIZED RETURNS (P2, 2026-08-18)
--
--  Only a full-sale void existed (posSaleDetail's "Void sale" button --
--  restocks everything, no partial). This adds a real itemized return: pick
--  specific lines + quantities off a prior sale, refund a prorated share of
--  discount/tax along with the line amount, restock just those units, and
--  (when the sale had a customer attached) roll back loyalty proportionally --
--  claw back a share of points earned on the sale, re-credit a share of any
--  points redeemed. One sale can be returned against multiple times (partial
--  returns over several visits); pos_sale_return_items.qty is checked against
--  qty already returned so the same unit can't be returned twice.
-- =============================================================================
CREATE TABLE IF NOT EXISTS pos_sale_returns (
  id                    SERIAL PRIMARY KEY,
  sale_id               INTEGER NOT NULL REFERENCES pos_sales(id) ON DELETE CASCADE,
  return_number         TEXT UNIQUE,
  reason                TEXT,
  refund_method         TEXT NOT NULL,   -- cash | card | cheque | bank | store_credit
  refund_subtotal_usd   NUMERIC(10,2) NOT NULL DEFAULT 0,
  refund_discount_usd   NUMERIC(10,2) NOT NULL DEFAULT 0,
  refund_tax_usd        NUMERIC(10,2) NOT NULL DEFAULT 0,
  refund_total_usd      NUMERIC(10,2) NOT NULL DEFAULT 0,
  store_credit_code     TEXT,             -- gift_cards.code, when refund_method = 'store_credit'
  loyalty_points_clawed_back INTEGER NOT NULL DEFAULT 0,
  loyalty_points_recredited  INTEGER NOT NULL DEFAULT 0,
  notes                 TEXT,
  processed_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS pos_sale_return_items (
  id             SERIAL PRIMARY KEY,
  return_id      INTEGER NOT NULL REFERENCES pos_sale_returns(id) ON DELETE CASCADE,
  sale_item_id   INTEGER NOT NULL REFERENCES pos_sale_items(id) ON DELETE CASCADE,
  qty            INTEGER NOT NULL CHECK (qty > 0),
  refund_usd     NUMERIC(10,2) NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pos_returns_sale ON pos_sale_returns (sale_id);
CREATE INDEX IF NOT EXISTS idx_pos_return_items_return ON pos_sale_return_items (return_id);
CREATE INDEX IF NOT EXISTS idx_pos_return_items_sale_item ON pos_sale_return_items (sale_item_id);

-- =============================================================================
--  ACCOUNT PAYMENTS -- settling a balance due (P3, 2026-08-18)
--
--  Charging a sale to 'account' (see the credit-limit check in POST
--  /api/admin/pos/sale) has always only been able to go up -- there was no
--  way to record a customer paying down what they owe, so "current balance"
--  was really just "everything ever charged." This table is the missing
--  other side of that ledger: a real cash/card/cheque/bank payment received
--  against a customer's account, netted against the account-tender charges
--  to get the actual current balance (see getAccountBalance() in server.js,
--  used by the credit-limit check, the customer profile, and this table's
--  own endpoints so all three can never disagree).
-- =============================================================================
CREATE TABLE IF NOT EXISTS account_payments (
  id            SERIAL PRIMARY KEY,
  customer_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_usd    NUMERIC(10,2) NOT NULL CHECK (amount_usd > 0),
  method        TEXT NOT NULL,     -- cash | card | cheque | bank
  reference     TEXT,
  notes         TEXT,
  received_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_account_payments_customer ON account_payments (customer_id);

-- =============================================================================
--  SHOP SETTINGS (2026-08-19) -- single-row shop configuration: company
--  info, logo, print preferences, quote validity, and the notice/footer
--  text that shows on invoices/receipts/statements. Was previously three
--  independent hardcoded copies of the same company info scattered across
--  server.js (the quotes/:id endpoint, the pickslip endpoint, the work-
--  order-invoice endpoint) plus a fourth, separate hardcoded copy in
--  admin.html's POS_SHOP -- none of which agreed on every field (only the
--  work-order one had a website; none had an email or logo). One row,
--  one source of truth; see getShopSettings()/shopSettingsToShop() in
--  server.js.
-- =============================================================================
CREATE TABLE IF NOT EXISTS shop_settings (
  id                     SERIAL PRIMARY KEY,
  company_name           TEXT NOT NULL DEFAULT 'Morty''s Auto Parts Ltd',
  address                TEXT NOT NULL DEFAULT '112C Waltham Park Road, Kingston',
  country                TEXT NOT NULL DEFAULT 'Jamaica',
  phone                  TEXT NOT NULL DEFAULT '(876) 758-5590',
  email                  TEXT,
  website                TEXT,
  logo_url               TEXT,
  print_logo_on_invoice  BOOLEAN NOT NULL DEFAULT true,
  -- Which document a completed sale auto-prints as the default, in addition
  -- to the full document rack (receipt/invoice/pickslip/packing/label/gift)
  -- still being available for any other format on demand.
  default_print_template TEXT NOT NULL DEFAULT 'receipt', -- 'receipt' | 'invoice'
  quote_valid_days       INTEGER NOT NULL DEFAULT 14,
  invoice_notice         TEXT NOT NULL DEFAULT 'Goods remain the property of the company until paid in full. Returns accepted within 14 days with the original invoice, in original condition. Electrical parts are non-returnable.',
  receipt_notice         TEXT NOT NULL DEFAULT 'Returns within 14 days with this receipt. Electrical parts non-returnable.',
  statement_notice       TEXT NOT NULL DEFAULT 'Please settle any outstanding balance promptly. Contact us with any questions about this statement.',
  updated_at             TIMESTAMPTZ DEFAULT NOW()
);
-- Singleton: exactly one settings row. Seeded only if the table is empty,
-- so re-running this file never overwrites an owner's saved settings.
INSERT INTO shop_settings (id, website)
  SELECT 1, 'https://mortysautoparts.com'
  WHERE NOT EXISTS (SELECT 1 FROM shop_settings);

-- Rebrand (2026): move the singleton row off the old brand ONLY where it
-- still holds the pre-rebrand default -- i.e. the operator never edited it
-- in Settings. A customised name/site is left alone.
UPDATE shop_settings SET company_name = 'Morty''s Auto Parts Ltd'
  WHERE company_name = 'Meltha Honda Sales & Servs Ltd';
UPDATE shop_settings SET website = 'https://mortysautoparts.com'
  WHERE website IN ('https://melthahonda.miamimistress.com', 'https://melthahonda.com');
UPDATE shop_settings SET address = '112C Waltham Park Road, Kingston'
  WHERE address = '127 Hagley Park Road, Kingston 11';
UPDATE shop_settings SET phone = '(876) 758-5590'
  WHERE phone = '(876) 758-8503';

-- Rebrand (2026): the synthetic walk-in / no-email customer domain moved from
-- @walkin.melthahonda.local to @walkin.mortysautoparts.local. Rename the
-- existing rows (the singleton "walkin@" record and every counter-created
-- customer minted without a real email) so the code that looks them up by the
-- new address keeps matching. Guarded so it is a no-op once migrated, and so
-- the singleton rename is skipped if the new address somehow already exists
-- (email is UNIQUE).
UPDATE users SET email = regexp_replace(email, '@walkin\.melthahonda\.local$', '@walkin.mortysautoparts.local')
  WHERE email LIKE '%@walkin.melthahonda.local';
UPDATE users SET email = 'walkin@mortysautoparts.local'
  WHERE email = 'walkin@melthahonda.local'
    AND NOT EXISTS (SELECT 1 FROM users u2 WHERE u2.email = 'walkin@mortysautoparts.local');

-- =============================================================================
--  POS HOLDS (2026-08-19) -- "Held tickets" (F7 Hold / F8 Recall -> Held tab).
--  admin.html has referenced /api/admin/pos/hold(s) since the split-tender
--  feature shipped (posHoldCart/posRecallModal), but the table and every
--  endpoint for it never existed -- every hold/recall silently 404'd,
--  caught by admin.html's own try/catch (posHoldCart shows a generic error
--  alert; the recall list showed "Could not load held tickets"; the F7/F8
--  shortcut legend advertised a feature that had never once worked). Found
--  while wiring the Recall modal's new Quote/Invoice tabs alongside it.
--  items_json here matches posCartPayload()'s shape exactly
--  (unit_price_usd/discount_usd in dollars, not cents) -- same convention
--  pos_quotes.items_json already uses.
-- =============================================================================
CREATE TABLE IF NOT EXISTS pos_holds (
  id              SERIAL PRIMARY KEY,
  hold_number     TEXT UNIQUE NOT NULL,
  label           TEXT,
  items_json      JSONB NOT NULL DEFAULT '[]',
  subtotal_usd    NUMERIC(10,2) NOT NULL DEFAULT 0,
  customer_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  customer_name   TEXT,
  customer_phone  TEXT,
  vehicle_info    TEXT,
  sales_rep_id    INTEGER REFERENCES mechanics(id) ON DELETE SET NULL,
  sales_rep_name  TEXT,
  notes           TEXT,
  held_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  held_by_name    TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pos_holds_created ON pos_holds (created_at);

-- =============================================================================
--  PER-USER UI PREFERENCES
--  The POS terminal's view density, font size, legacy-key mode and column
--  choices. Lived in localStorage, which made them per browser: the same
--  cashier moving from the counter till to the back-office PC started from
--  defaults again, and a shared till handed one person's settings to the next.
--  Storing them on the user row makes them follow the account instead.
--
--  JSONB, not a column per setting, because this is opaque UI state the client
--  owns -- nothing in SQL ever filters or aggregates on it, and adding the next
--  toggle should not need a migration. Defaults to '{}' so a row that has never
--  saved reads as "use the built-in defaults" rather than NULL.
-- =============================================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS ui_prefs JSONB NOT NULL DEFAULT '{}'::jsonb;

-- =============================================================================
--  TERMINALS -- which machines are allowed to run this system
--
--  A "client" here is another PC running its own copy of the portable package.
--  Those copies talk STRAIGHT TO POSTGRES, not through the server's HTTP API,
--  so the server has no traffic of theirs to intercept. Control is therefore
--  cooperative: every instance runs this same server.js, registers itself here
--  on boot, re-checks its own row on a heartbeat, and shuts its own admin UI
--  down if this table says it is pending or blocked.
--
--  That is a workable operational control -- it decides which tills the shop
--  actually uses, and it revokes one instantly from the counter. It is NOT a
--  security boundary: anyone holding the database password could bypass it by
--  not running our code at all. The real network-level control is pg_hba.conf
--  on the database host (see INSTALL-SERVER.md section 7.2).
--
--  terminal_uid is nullable ON PURPOSE so a row can be pre-registered by name
--  before that machine has ever connected; the first instance whose name
--  matches adopts the row and its already-approved status.
-- =============================================================================
CREATE TABLE IF NOT EXISTS terminals (
  id                     SERIAL PRIMARY KEY,
  terminal_uid           TEXT,                             -- stable per install (app/terminal-id.json)
  name                   TEXT,
  hostname               TEXT,
  address                TEXT,
  port                   INTEGER,
  is_db_host             BOOLEAN NOT NULL DEFAULT false,   -- reaches the database over loopback => it IS the server
  status                 TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'approved' | 'blocked'
  note                   TEXT,
  app_version            TEXT,
  first_seen             TIMESTAMPTZ DEFAULT NOW(),
  last_seen              TIMESTAMPTZ DEFAULT NOW(),
  approved_at            TIMESTAMPTZ,
  approved_by            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  blocked_at             TIMESTAMPTZ,
  terminate_requested_at TIMESTAMPTZ
);
-- Partial: many pre-registered rows may sit with a NULL uid, but a real uid
-- must only ever map to one row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_terminals_uid ON terminals (terminal_uid) WHERE terminal_uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_terminals_last_seen ON terminals (last_seen DESC);

-- Small key/value bag for app-wide switches that are not shop-branding
-- settings (which live in shop_settings).
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
-- 'approve' = a new machine arrives pending and cannot be used until someone
-- allows it. 'open'  = new machines are approved the moment they appear.
-- Defaults to 'approve': a shop that has not thought about this should not be
-- silently accepting any copy of the folder that turns up on the network.
INSERT INTO app_settings (key, value) VALUES ('terminal_access_mode', 'approve')
  ON CONFLICT (key) DO NOTHING;

-- =============================================================================
--  TERMINAL ENROLMENT LINKS
--
--  How a new till gets its database settings without anyone typing a password.
--
--  The link carries a RANDOM TOKEN, never the credentials. The client redeems
--  it against the server, once, inside a short window, and the server answers
--  with the connection settings over that request. A link that has been used,
--  revoked or has expired is worth nothing, so it is safe to send over
--  WhatsApp or write on paper -- which a link containing the Postgres password
--  would emphatically not be.
--
--  Only the hash is stored. Someone who can read this table cannot enrol a
--  machine with what they find in it; they would need the token itself, which
--  exists only in the one response that created it.
-- =============================================================================
CREATE TABLE IF NOT EXISTS terminal_enrolments (
  id            SERIAL PRIMARY KEY,
  token_hash    TEXT NOT NULL,
  label         TEXT,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,
  used_at       TIMESTAMPTZ,
  used_by_uid   TEXT,
  used_from_ip  TEXT,
  revoked_at    TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_enrol_token ON terminal_enrolments (token_hash);
CREATE INDEX IF NOT EXISTS idx_enrol_created ON terminal_enrolments (created_at DESC);

-- =============================================================================
--  PER-TERMINAL DATABASE ROLES
--
--  Until now every till connected as the `postgres` SUPERUSER, with that
--  password sitting in plain text in db-config.json on each machine. Blocking a
--  terminal only asked its own software to stop; the credentials it held could
--  still do anything to the database.
--
--  Now each enrolled terminal gets its own login role, member of the group
--  `mh_terminal`, which holds exactly the rights a till needs: read/write the
--  data, and nothing else -- no DDL, no ownership, no superuser. Blocking a
--  terminal sets its role NOLOGIN, which PostgreSQL itself enforces at connect
--  time. That is the difference between asking a till to stop and stopping it.
--
--  Privileges live on the GROUP, never on individual roles, so a new table
--  needs one grant rather than one per terminal, and nothing can drift.
--  ALTER DEFAULT PRIVILEGES covers tables added by later schema changes; the
--  server also re-syncs grants on every boot, which repairs anything created
--  before the default privileges were in place.
-- =============================================================================
ALTER TABLE terminals ADD COLUMN IF NOT EXISTS db_role TEXT;

DO $mh$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mh_terminal') THEN
    CREATE ROLE mh_terminal NOLOGIN;
  END IF;
END
$mh$;

-- CONNECT has to name the database, which varies by install, so it goes
-- through format() rather than being hardcoded.
DO $mh$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO mh_terminal', current_database());
END
$mh$;

GRANT USAGE ON SCHEMA public TO mh_terminal;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO mh_terminal;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO mh_terminal;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mh_terminal;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO mh_terminal;

-- A till never reads this table, and it holds the enrolment token hashes.
REVOKE ALL ON terminal_enrolments FROM mh_terminal;

-- =============================================================================
--  TERMINALS MUST NOT READ PASSWORD HASHES
--
--  A till's role could read every column of `users`, including password_hash.
--  Anyone who walked off with a till could harvest every bcrypt hash in the
--  shop and grind them offline at leisure -- the staff passwords AND the
--  customer ones, which people reuse elsewhere.
--
--  `users` also holds customers, so the table cannot simply be taken away: the
--  POS looks up customers constantly. PostgreSQL's column-level privileges are
--  exactly the right tool. Tills keep every column they legitimately need and
--  lose the one they do not.
--
--  Built from information_schema rather than a hardcoded list so a column added
--  later is granted automatically. A list written out by hand here would go
--  stale the first time someone adds a field, and the failure -- a till that
--  cannot read a column it needs -- would surface as a baffling runtime error.
--
--  UPDATE loses password_hash, is_admin and admin_role as well: being able to
--  set an existing admin's password, or flag yourself as one, is the same
--  escalation by a different door.
-- =============================================================================
DO $mh$
DECLARE
  sel_cols text;
  upd_cols text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mh_terminal') THEN RETURN; END IF;

  SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position)
    INTO sel_cols
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'users'
     AND column_name <> 'password_hash';

  SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position)
    INTO upd_cols
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'users'
     AND column_name NOT IN ('password_hash', 'is_admin', 'admin_role');

  -- The blanket GRANT ... ON ALL TABLES earlier in this file re-grants the
  -- whole table on every boot, so this has to revoke before re-granting or the
  -- restriction would quietly disappear on the next restart.
  EXECUTE 'REVOKE SELECT, UPDATE ON users FROM mh_terminal';
  EXECUTE format('GRANT SELECT (%s) ON users TO mh_terminal', sel_cols);
  EXECUTE format('GRANT UPDATE (%s) ON users TO mh_terminal', upd_cols);
END
$mh$;

-- The token a terminal presents when it asks the server to check a password on
-- its behalf. Hashed, like the enrolment tokens -- reading this table must not
-- yield anything usable.
ALTER TABLE terminals ADD COLUMN IF NOT EXISTS api_token_hash TEXT;

-- =============================================================================
--  low_threshold default
--
--  CREATE TABLE IF NOT EXISTS above cannot change a column default on a
--  database that already exists, and this file is re-run on every boot -- so
--  an install created before this change would keep the old default forever
--  without an explicit ALTER. This is that ALTER.
--
--  0 means "only warn when the shelf is actually empty". The old default of 4
--  flagged anything with four or fewer in stock, which on a catalogue where
--  most lines are held in ones and twos meant almost every part sat in the low
--  stock list permanently -- a warning that fires on everything is not a
--  warning. Set a real reorder point per part where one is wanted.
-- =============================================================================
ALTER TABLE products ALTER COLUMN low_threshold SET DEFAULT 0;

-- =============================================================================
--  PEOPLE: one user file, with categories
--
--  Every person the shop deals with -- customer, cashier, mechanic, sales rep
--  -- is a row in `users`. What someone *is* is expressed as one or more
--  categories rather than a column per job, because the list is not fixed:
--  the shop adds new kinds of staff over time and should not need a schema
--  change to do it.
--
--  This replaces the previous arrangement, where a staff member could exist
--  twice: once in `users` (their login, is_admin/admin_role) and once in
--  `mechanics` (their sales-rep identity), with nothing tying the two
--  together. mechanics.user_id existed but the Staff form never set it, so in
--  practice the two records never met -- which is why the till could not work
--  out which rep was the person signed in.
--
--  `mechanics` is NOT dropped. Eighteen foreign keys point at mechanics(id)
--  -- work orders, labour lines, the time clock, requisitions, stock counts,
--  POS quotes -- and repointing all of them is a separate refactor. It is now
--  a service-department profile hanging off a user, kept in step by the
--  application, rather than a second identity for the same person.
-- =============================================================================

CREATE TABLE IF NOT EXISTS user_categories (
  id          SERIAL PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,          -- stable key used by code
  label       TEXT NOT NULL,                 -- what staff see
  department  TEXT,                          -- 'service' | 'counter' | free text
  is_staff    BOOLEAN NOT NULL DEFAULT TRUE, -- false for customer-side groupings
  sort_order  INTEGER NOT NULL DEFAULT 100,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  -- is_system marks the categories application code looks up by code. They can
  -- be renamed and reordered but not deleted, because deleting one would break
  -- the feature that depends on it rather than merely tidying a list.
  is_system   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Many-to-many on purpose: the old mechanics.role had to invent a 'both' value
-- to cover someone who turns a spanner and sells over the counter. With a join
-- table that person simply holds two categories, and a third kind of staff
-- added next year needs no new enum value.
CREATE TABLE IF NOT EXISTS user_category_members (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES user_categories(id) ON DELETE CASCADE,
  assigned_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, category_id)
);
CREATE INDEX IF NOT EXISTS idx_user_cat_members_cat ON user_category_members(category_id);

INSERT INTO user_categories (code, label, department, is_staff, sort_order, is_system) VALUES
  ('sales_rep',       'Sales rep',       'counter', TRUE, 10, TRUE),
  ('cashier',         'Cashier',         'counter', TRUE, 20, TRUE),
  ('mechanic',        'Mechanic',        'service', TRUE, 30, TRUE),
  ('service_advisor', 'Service advisor', 'service', TRUE, 40, TRUE),
  ('driver',          'Driver',          'service', TRUE, 50, FALSE),
  ('parts_clerk',     'Parts clerk',     'counter', TRUE, 60, FALSE)
ON CONFLICT (code) DO NOTHING;

-- ---- staff fields on users ---------------------------------------------------
-- is_staff is deliberately separate from is_admin: is_admin means "may open the
-- admin panel", is_staff means "works here". A mechanic who clocks in and is
-- credited on work orders but never opens the admin panel is staff and not an
-- admin, and conflating the two is how someone ends up granted the panel just
-- to appear in a dropdown.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_staff BOOLEAN NOT NULL DEFAULT FALSE;

-- PIN for the shared till: quick sign-in, authorising overrides, and the time
-- clock. Hashed with bcrypt exactly like password_hash -- a PIN is short enough
-- to brute force offline, so storing it in clear because "it is only four
-- digits" would hand over every staff identity in one SELECT.
ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_hash   TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_set_at TIMESTAMPTZ;

-- Shop-assigned employee number, used on payroll and rosters.
ALTER TABLE users ADD COLUMN IF NOT EXISTS employee_no TEXT;
-- Partial unique index rather than a UNIQUE constraint: most users are
-- customers and have no employee number, and a plain UNIQUE would allow only
-- one NULL in some engines and complicate the customer side for no gain.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_employee_no
  ON users(employee_no) WHERE employee_no IS NOT NULL;

-- National ID (TRN). Statutory payroll data, not day-to-day information: the
-- API only returns this to owner/manager, and it is never sent to a till.
ALTER TABLE users ADD COLUMN IF NOT EXISTS national_id TEXT;

-- ---- customer credit presets -------------------------------------------------
-- credit_limit_usd and payment_terms_days already existed; these complete the
-- set the counter actually quotes from.
--   credit_type          how the account settles
--   credit_length_months how long the line runs before it is reviewed
ALTER TABLE users ADD COLUMN IF NOT EXISTS credit_type TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS credit_length_months INTEGER;

DO $mh$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_credit_type_ck') THEN
    ALTER TABLE users ADD CONSTRAINT users_credit_type_ck
      CHECK (credit_type IS NULL OR credit_type IN ('cash','open','revolving','cod'));
  END IF;
END
$mh$;

CREATE INDEX IF NOT EXISTS idx_users_is_staff ON users(is_staff) WHERE is_staff = TRUE;
-- The online/counter split the Customers screen filters on: `via` records how
-- the record came into being ('pos' at the counter, NULL/other from a
-- storefront signup), and nothing indexed it.
CREATE INDEX IF NOT EXISTS idx_users_via ON users(via);

-- =============================================================================
--  ROLES
--
--  admin_role used to be three strings hardcoded in two places: a list inside
--  requireManager() on the server, and MANAGER_ONLY_TABS in admin.html. Adding
--  a fourth kind of staff -- a supervisor who may receive stock but not touch
--  pricing -- meant editing code in both, so in practice nobody did, and
--  everyone who needed anything beyond a till got made a manager.
--
--  Roles live here instead. `can_manage` is what requireManager() actually
--  checks, and `hidden_tabs` drives what the sidebar shows. Sixty endpoints
--  are gated on requireManager and a hundred and sixty on requireAdmin, so the
--  two levels stay as they are -- what changes is that which roles clear the
--  bar is now data rather than a literal in a function.
-- =============================================================================
CREATE TABLE IF NOT EXISTS roles (
  code        TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  -- Lower is more senior. Used to stop someone editing a role at or above
  -- their own level, which is how a "manage roles" screen becomes a
  -- privilege-escalation button.
  rank        INTEGER NOT NULL DEFAULT 50,
  can_manage  BOOLEAN NOT NULL DEFAULT FALSE,
  -- Tabs this role does NOT see. A deny list rather than an allow list so a
  -- newly added screen is visible by default -- the opposite would hide every
  -- new feature from everyone until someone remembered to grant it.
  hidden_tabs JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_system   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO roles (code, label, rank, can_manage, hidden_tabs, is_system) VALUES
  ('owner',   'Owner',   0,  TRUE,  '[]'::jsonb, TRUE),
  ('manager', 'Manager', 10, TRUE,  '[]'::jsonb, TRUE),
  ('cashier', 'Cashier', 50, FALSE,
     '["mechanics","suppliers","purchaseorders","coupons","giftcards","marketing","settings","staff","staffcategories","roles"]'::jsonb,
     TRUE)
ON CONFLICT (code) DO NOTHING;

-- users.admin_role is the role code. No foreign key on purpose: a role that
-- gets deleted must not cascade into deleting or nulling staff, and the API
-- refuses to delete a role anyone still holds.
CREATE INDEX IF NOT EXISTS idx_users_admin_role ON users(admin_role);

-- =============================================================================
--  PER-USER PERMISSIONS
--
--  admin_role / roles.hidden_tabs decide which SCREENS a role sees. This is
--  finer: which FUNCTIONS a specific user may perform -- give a discount, take
--  a charge sale, add a customer, edit a price, and so on.
--
--  Deny-list, same as hidden_tabs: a capability is allowed unless this map
--  says {"<cap>": false}. An empty map (the default) means "everything this
--  user's role allows". Only false values are stored; true / unknown keys are
--  dropped on write. The capability catalogue lives in server.js (CAPABILITIES)
--  so a new one is available everywhere the moment it is added there.
--
--  Users whose ROLE has can_manage = true (owner, manager, custom manager
--  roles) are never restricted by this -- userCan() short-circuits to true for
--  them -- so the editor only shows the toggles for non-manager staff.
-- =============================================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS perms JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Category-level function permissions. A staff member's effective rights are:
--   role.can_manage         -> full access, nothing below applies
--   else, per capability:    allowed
--     minus  any active category they hold that has {"<cap>": false}
--     then   their own users.perms override -- {"<cap>": true} re-grants a
--            capability a category took away; {"<cap>": false} denies it
--            outright. Absent = inherit the category outcome.
-- Same deny-list shape as users.perms; only false values are stored on a
-- category, true/unknown are dropped on write.
ALTER TABLE user_categories ADD COLUMN IF NOT EXISTS perms JSONB NOT NULL DEFAULT '{}'::jsonb;

-- =============================================================================
--  admin_role is no longer a fixed set
--
--  users_admin_role_check (added above) pinned admin_role to the three literal
--  values 'owner' / 'manager' / 'cashier'. That was correct while those were
--  the only roles; with the `roles` table it is the thing that makes a custom
--  role impossible to assign -- the API accepts it and the INSERT then fails
--  with a constraint violation.
--
--  Dropped rather than widened: the valid set now lives in `roles`, and a CHECK
--  cannot reference another table. Validation moved to roleExists() in
--  server.js, which is checked before every write of this column.
-- =============================================================================
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_admin_role_check;

-- =============================================================================
--  Archived customers
--
--  A customer with sales behind them cannot be deleted: orders, pos_sales and
--  account_payments all reference users with ON DELETE SET NULL, so the delete
--  would succeed and quietly detach their history -- including any balance they
--  owe, which would become rows belonging to nobody. Archiving hides them from
--  the customer list and the POS lookup while leaving every reference intact.
-- =============================================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_archived BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_users_archived ON users(is_archived) WHERE is_archived = TRUE;

-- =============================================================================
--  Full parts-counter POS  (port of migrations/0010_pos_full.sql)
--
--  migrations/0010_pos_full.sql turned the counter POS from "ring up a cash
--  sale" into a full parts-counter terminal: a sales rep + commission on every
--  ticket, a fulfilment decision (pickup / local delivery / courier shipment),
--  sales that can be charged wholly or partly to a customer account, a distinct
--  invoice number, per-line discounts, and a link back to the quote a sale was
--  rung from. That file is the SQLite / D1 dialect the separate migration-
--  package tool consumes; it is never executed by this server, which applies
--  ONLY this file (initDb, every boot). So none of it reached Postgres -- the
--  sale INSERT in server.js died on the very first missing column
--  (sales_rep_id), and the rest would have followed.
--
--  Everything below is additive and idempotent. Money is NUMERIC(10,2) *_usd
--  here (0010's *_cents is a D1-only convention). Existing pos_sales rows are
--  correct under the defaults: a pickup, paid in full, with no rep.
-- =============================================================================

-- WHO SOLD IT --------------------------------------------------------------
-- sales_rep_id points at `mechanics` (this schema's staff table); the name is
-- denormalised alongside it so a receipt reprinted years later still shows who
-- sold it even if the staff row is gone. Matches pos_holds / pos_quotes.
ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS sales_rep_id   INTEGER REFERENCES mechanics(id) ON DELETE SET NULL;
ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS sales_rep_name TEXT;

-- HOW IT LEAVES THE BUILDING ---------------------------------------------------
-- fulfilment drives which counter documents apply: 'pickup' has nothing to
-- pack or label; 'delivery' (own van) and 'shipping' (third-party courier)
-- both produce a packing slip, and only 'shipping' needs a carrier label with
-- a tracking number. ship_fee_usd is taxed alongside the goods (see the client
-- posTotals() and the sale endpoint in server.js).
ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS fulfilment        TEXT NOT NULL DEFAULT 'pickup';  -- pickup|delivery|shipping
ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS ship_method       TEXT;      -- carrier / service name, or 'Own van'
ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS ship_fee_usd      NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS ship_name         TEXT;
ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS ship_phone        TEXT;
ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS ship_line1        TEXT;
ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS ship_line2        TEXT;
ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS ship_city         TEXT;
ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS ship_parish       TEXT;
ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS ship_country      TEXT DEFAULT 'Jamaica';
ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS ship_instructions TEXT;
ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS tracking_number   TEXT;
-- Stamped once the packing slip / label has actually been run, so the shipping
-- desk can tell a picked-and-packed order from one still in the queue. No
-- endpoint writes these yet; they are here so the shipping-queue view can.
ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS packed_at         TIMESTAMPTZ;
ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS shipped_at        TIMESTAMPTZ;

-- CHARGE SALES (accounts receivable) -----------------------------------------
-- A charge sale is rung up in full but tendered wholly or partly to the
-- customer's account. payment_status is derived by the server from what was
-- actually tendered: paid (no account), partial (some money + some account),
-- unpaid (the whole ticket on account). balance_due_usd is what the customer
-- still owes and is what the invoice prints as BALANCE DUE.
ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS payment_status    TEXT NOT NULL DEFAULT 'paid';   -- paid|partial|unpaid
ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS amount_paid_usd   NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS balance_due_usd   NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS due_date          DATE;    -- when a charge sale falls due
ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS po_number         TEXT;    -- trade customer's own PO reference

-- An invoice number distinct from the receipt number: trade customers file by
-- invoice, and a sale later partly refunded still keeps one invoice. The
-- server assigns one to every sale (nextInvoiceNumber()).
ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS invoice_number    TEXT;

-- Where a sale came from when it was rung up off a saved quote. Lets the quote
-- list show "converted" instead of leaving an accepted quote sitting open.
ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS quote_id          INTEGER REFERENCES pos_quotes(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_pos_sales_rep     ON pos_sales (sales_rep_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pos_sales_status  ON pos_sales (payment_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pos_sales_created ON pos_sales (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pos_sales_invoice ON pos_sales (invoice_number);

-- LINE-LEVEL DISCOUNT -------------------------------------------------------
-- The order-level discount already existed. A per-line discount is the one the
-- counter actually reaches for ("ten percent off the strut, full price on the
-- rest"); it has to be stored per line or the invoice can't show what was
-- taken off what. Until this landed, server.js computed it for a permission
-- check and then dropped it -- the customer was charged the full line.
ALTER TABLE pos_sale_items ADD COLUMN IF NOT EXISTS discount_usd  NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE pos_sale_items ADD COLUMN IF NOT EXISTS discount_note TEXT;

-- QUOTES --------------------------------------------------------------------
-- Quotes gain the same customer / rep identity as sales so a quote can be
-- turned into a sale without re-keying who it was for, plus converted_sale_id
-- so an accepted quote stops showing as open work. (status / cashier_id /
-- customer_email / notes were already added above.)
ALTER TABLE pos_quotes ADD COLUMN IF NOT EXISTS customer_id       INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE pos_quotes ADD COLUMN IF NOT EXISTS sales_rep_id      INTEGER REFERENCES mechanics(id) ON DELETE SET NULL;
ALTER TABLE pos_quotes ADD COLUMN IF NOT EXISTS sales_rep_name    TEXT;
ALTER TABLE pos_quotes ADD COLUMN IF NOT EXISTS converted_sale_id INTEGER REFERENCES pos_sales(id) ON DELETE SET NULL;
ALTER TABLE pos_quotes ADD COLUMN IF NOT EXISTS created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- =============================================================================
--  Disabled accounts
--
--  is_staff / is_admin say what a person *is*; `disabled` is a hard off switch
--  a manager can flip when someone leaves or an account is compromised. A
--  disabled user cannot sign in by password OR PIN, and an already-open
--  session is rejected on its next admin request (requireAdmin/requireManager
--  re-read the row every time). Distinct from customers.is_archived, which
--  only hides a customer from lists and the POS lookup.
-- =============================================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled BOOLEAN NOT NULL DEFAULT false;

-- =============================================================================
--  Manager-preset pinned screens
--
--  A user pins their own favourite screens (users.ui_prefs.favs). A manager
--  can also preset a list on the user's row and lock it: while favs_locked is
--  true the client shows exactly forced_favs and hides the pin/unpin controls.
--  Unlocked, forced_favs is just a starting set used when the user has pinned
--  nothing of their own yet.
-- =============================================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS forced_favs  JSONB;
ALTER TABLE users ADD COLUMN IF NOT EXISTS favs_locked  BOOLEAN NOT NULL DEFAULT false;

-- =============================================================================
--  Off-site backup log
--
--  One row per backup attempt, both directions: 'out' on the shop server that
--  ships a pg_dump to its online copy, 'in' on the online copy that receives
--  one. Drives the "last backup / recent backups" panel in Settings and the
--  "catch up when the internet returns" logic (was the last out-bound attempt
--  a network failure?).
-- =============================================================================
CREATE TABLE IF NOT EXISTS backup_log (
  id         SERIAL PRIMARY KEY,
  direction  TEXT NOT NULL,                 -- 'out' | 'in'
  origin     TEXT,                          -- which shop the dump belongs to (receiver side)
  filename   TEXT,
  bytes      BIGINT,
  ok         BOOLEAN NOT NULL DEFAULT false,
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_backup_log_at ON backup_log (created_at DESC);
