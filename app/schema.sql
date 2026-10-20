-- ============================================================================
--  Vision Auto Solutions — Postgres Schema
--  Run once on a fresh database, e.g.
--    createdb visionautosolutions
--    psql -d visionautosolutions -f schema.sql
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
-- Customers offering their vehicle to Vision Auto Solutions as trade-in or outright sale.
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
-- 0034: reference list price, per-part costing-method label, supplier's own
-- part number, and stocking vs. purchasing unit of measure.
ALTER TABLE products ADD COLUMN IF NOT EXISTS list_price_usd     NUMERIC(10,2);
ALTER TABLE products ADD COLUMN IF NOT EXISTS costing_method     TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS supplier_part_no   TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS stock_uom          TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS purchase_uom       TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS units_per_purchase NUMERIC(10,3);
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
-- visionautosolutions.com. Rename the existing row on installs that predate
-- the change so the seed's ON CONFLICT (email) still matches and no second
-- admin account is created. No-op on fresh databases, and skipped if the
-- new address is already present (email is UNIQUE -- a blind UPDATE would
-- abort the whole schema apply).
UPDATE users SET email = 'admin@visionautosolutions.com'
  WHERE email = 'admin@melthahonda.com'
    AND NOT EXISTS (SELECT 1 FROM users u2 WHERE u2.email = 'admin@visionautosolutions.com');

-- The default seeded admin account is the shop owner.
UPDATE users SET admin_role = 'owner' WHERE email = 'admin@visionautosolutions.com';

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
  company_name           TEXT NOT NULL DEFAULT 'Vision Auto Solutions',
  address                TEXT NOT NULL DEFAULT '112C Waltham Park Road, Kingston',
  country                TEXT NOT NULL DEFAULT 'Jamaica',
  phone                  TEXT NOT NULL DEFAULT '(876) 728-4735',
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
  SELECT 1, 'https://visionautosolutions.com'
  WHERE NOT EXISTS (SELECT 1 FROM shop_settings);

-- Rebrand (2026): move the singleton row off the old brand ONLY where it
-- still holds the pre-rebrand default -- i.e. the operator never edited it
-- in Settings. A customised name/site is left alone.
UPDATE shop_settings SET company_name = 'Vision Auto Solutions'
  WHERE company_name = 'Meltha Honda Sales & Servs Ltd';
UPDATE shop_settings SET website = 'https://visionautosolutions.com'
  WHERE website IN ('https://melthahonda.miamimistress.com', 'https://melthahonda.com');
UPDATE shop_settings SET address = '112C Waltham Park Road, Kingston'
  WHERE address = '127 Hagley Park Road, Kingston 11';
UPDATE shop_settings SET phone = '(876) 728-4735'
  WHERE phone = '(876) 758-8503';

-- Rebrand (2026): the synthetic walk-in / no-email customer domain moved from
-- @walkin.melthahonda.local to @walkin.visionautosolutions.local. Rename the
-- existing rows (the singleton "walkin@" record and every counter-created
-- customer minted without a real email) so the code that looks them up by the
-- new address keeps matching. Guarded so it is a no-op once migrated, and so
-- the singleton rename is skipped if the new address somehow already exists
-- (email is UNIQUE).
UPDATE users SET email = regexp_replace(email, '@walkin\.melthahonda\.local$', '@walkin.visionautosolutions.local')
  WHERE email LIKE '%@walkin.melthahonda.local';
UPDATE users SET email = 'walkin@visionautosolutions.local'
  WHERE email = 'walkin@melthahonda.local'
    AND NOT EXISTS (SELECT 1 FROM users u2 WHERE u2.email = 'walkin@visionautosolutions.local');

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
-- The number changed again in Oct 2026. Same rule as above: only a till still
-- holding the previous number is moved, so an operator-edited phone stays.
UPDATE shop_settings SET phone = '(876) 728-4735'
  WHERE phone IN ('(876) 758-5590', '876-758-5590');
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

-- ---------------------------------------------------------------------------
-- Missing foreign-key indexes on the two biggest child tables.
--
-- Postgres does not index the referencing side of a FK automatically. These
-- went unnoticed while the tables were small, but every receipt/invoice view
-- filters pos_sale_items by sale_id and every purchase-order view filters
-- purchase_order_items by po_id, so without them each lookup is a full
-- sequential scan. The legacy import (app/tools/seed-legacy.mjs) takes those
-- tables to ~1.05M and ~178k rows, which makes the difference stark.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS pos_sale_items_sale_idx     ON pos_sale_items (sale_id);
CREATE INDEX IF NOT EXISTS purchase_order_items_po_idx ON purchase_order_items (po_id);


-- =============================================================================
--  PETTY CASH  (ported from the D1 backend: functions/_routes/ops.js +
--  functions/_lib/petty_cash.js, D1 migrations 0049 + 0058.)
--
--  server.js never had any of this -- the admin "Petty Cash" tab and the Cash
--  Report tab's payout form both 404'd against the Postgres backend. Money is
--  stored in integer cents here, exactly as the D1 tables do, so the ledger /
--  balance cross-check arithmetic ports across verbatim; every endpoint divides
--  by 100 to honour the *_usd float contract the admin UI speaks.
-- =============================================================================
CREATE TABLE IF NOT EXISTS petty_cash_categories (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  is_active  BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
INSERT INTO petty_cash_categories (name, sort_order) VALUES
 ('Fuel', 1), ('Office supplies', 2), ('Cleaning', 3), ('Refreshments / staff welfare', 4),
 ('Postage / courier', 5), ('Repairs & maintenance', 6), ('Transport / taxi', 7),
 ('Bank charges', 8), ('Sundry / misc', 9)
ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS petty_cash_funds (
  id                      SERIAL PRIMARY KEY,
  name                    TEXT NOT NULL,
  balance_cents           BIGINT NOT NULL DEFAULT 0,
  custodian_id            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  is_active               BOOLEAN NOT NULL DEFAULT true,
  float_cents             BIGINT NOT NULL DEFAULT 0,
  receipt_threshold_cents BIGINT NOT NULL DEFAULT 0,
  location                TEXT,
  notes                   TEXT,
  closed_at               TIMESTAMPTZ,
  last_reconciled_at      TIMESTAMPTZ,
  created_at              TIMESTAMPTZ DEFAULT NOW()
);

-- "cash physically disbursed" -- straight from an open till (source_type
-- 'drawer', netted off that session's expected cash at close) or from a
-- standing fund (source_type 'fund', which the fund balance absorbs directly).
CREATE TABLE IF NOT EXISTS cash_payouts (
  id                 SERIAL PRIMARY KEY,
  amount_cents       BIGINT NOT NULL,
  reason             TEXT NOT NULL,
  paid_to            TEXT,
  notes              TEXT,
  source_type        TEXT NOT NULL CHECK (source_type IN ('drawer', 'fund')),
  drawer_session_id  INTEGER REFERENCES cash_drawer_sessions(id),
  fund_id            INTEGER REFERENCES petty_cash_funds(id),
  authorized_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  category_id        INTEGER REFERENCES petty_cash_categories(id),
  receipt_ref        TEXT,
  receipt_url        TEXT,
  is_advance         BOOLEAN NOT NULL DEFAULT false,
  advance_to         TEXT,
  advance_status     TEXT,              -- NULL | open | repaid | expensed
  advance_settled_at TIMESTAMPTZ,
  voided             BOOLEAN NOT NULL DEFAULT false,
  voided_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  voided_at          TIMESTAMPTZ,
  created_at         TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cash_payouts_drawer ON cash_payouts (drawer_session_id);
CREATE INDEX IF NOT EXISTS idx_cash_payouts_fund   ON cash_payouts (fund_id);

-- Every non-disbursement fund movement, signed: + adds to the fund.
CREATE TABLE IF NOT EXISTS petty_cash_movements (
  id                SERIAL PRIMARY KEY,
  fund_id           INTEGER NOT NULL REFERENCES petty_cash_funds(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL CHECK (kind IN
    ('opening','replenishment','reconcile_adjust','transfer_in','transfer_out','void_reversal','advance_repay')),
  delta_cents       BIGINT NOT NULL,
  source            TEXT,              -- 'bank' | 'drawer' | 'fund' | NULL
  drawer_session_id INTEGER REFERENCES cash_drawer_sessions(id),
  ref               TEXT,
  notes             TEXT,
  related_payout_id INTEGER REFERENCES cash_payouts(id),
  related_fund_id   INTEGER REFERENCES petty_cash_funds(id),
  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pc_movements_fund ON petty_cash_movements (fund_id, created_at);

CREATE TABLE IF NOT EXISTS petty_cash_counts (
  id             SERIAL PRIMARY KEY,
  fund_id        INTEGER NOT NULL REFERENCES petty_cash_funds(id) ON DELETE CASCADE,
  counted_cents  BIGINT NOT NULL,
  expected_cents BIGINT NOT NULL,
  variance_cents BIGINT NOT NULL,
  notes          TEXT,
  counted_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pc_counts_fund ON petty_cash_counts (fund_id, created_at);


-- =============================================================================
--  SUPPLIER PAYMENTS (accounts payable) -- logs money paid out against a
--  purchase order. Scoped to one PO, not a running per-supplier ledger: the
--  customer side settles a whole account at once (account_payments) because
--  a charge sale has no per-invoice balance to track, but a PO already is the
--  natural unit of "what's owed" here, so a payment applies against one.
-- =============================================================================
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS amount_paid_usd NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS balance_due_usd NUMERIC(10,2) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS purchase_order_payments (
  id           SERIAL PRIMARY KEY,
  po_id        INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  amount_usd   NUMERIC(10,2) NOT NULL CHECK (amount_usd > 0),
  method       TEXT,
  reference    TEXT,
  notes        TEXT,
  received_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_po_payments_po ON purchase_order_payments (po_id);

-- Existing POs start owing their full total -- nothing paid yet.
--
-- Except the ones imported from the legacy INVREC export (app/tools/
-- load-invrec.mjs stamps those with legacy_key). Those are 25,235 historical
-- goods-receipt batches going back to 2009, and INVREC carries no accounts-
-- payable data whatsoever: SUB_TOTAL, TOTAL, TOTAL_PAID and PAY_DATE are empty
-- on all 206,956 rows. Defaulting them to "owes the full total" asserted
-- J$1,566,709,559 of outstanding supplier debt on stock that was received and
-- sold years ago, which then flowed into payables, cash-flow and the executive
-- summary. Nothing is known about what was paid, so nothing is claimed: the
-- balance stays 0 and the payables report simply has no AP history before the
-- first PO raised in this system.
--
-- Guarded, because legacy_key is added by app/tools/lib/legacy-schema.sql when
-- the seeder runs, not by this file -- on a database that has never imported,
-- the column does not exist and the plain form is correct.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'purchase_orders' AND column_name = 'legacy_key') THEN
    UPDATE purchase_orders SET balance_due_usd = total_usd
     WHERE amount_paid_usd = 0 AND legacy_key IS NULL;
    UPDATE purchase_orders SET balance_due_usd = 0
     WHERE amount_paid_usd = 0 AND legacy_key IS NOT NULL AND balance_due_usd <> 0;
  ELSE
    UPDATE purchase_orders SET balance_due_usd = total_usd WHERE amount_paid_usd = 0;
  END IF;
END $$;


-- =============================================================================
--  REPORT INDEXES — the lookups the reporting module cannot work without.
--
--  Postgres does not index the referencing side of a foreign key, and these
--  were all absent. The cost is not academic: the Orders list spent 26,915ms
--  without pos_sale_items(sale_id) and 49ms with it, the order-quality report
--  10,696ms without pos_sale_items(product_img) and 349ms with it, and the
--  supplier report 4,640ms without the two supplier_id indexes and 26ms with
--  them. Everything here is a plain btree on the column a report filters by.
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_pos_sale_items_product_img ON pos_sale_items (product_img);
CREATE INDEX IF NOT EXISTS idx_products_supplier          ON products (supplier_id);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_supplier   ON purchase_orders (supplier_id);
CREATE INDEX IF NOT EXISTS idx_account_payments_reference ON account_payments (reference);
CREATE INDEX IF NOT EXISTS idx_warehouse_activity_kind    ON warehouse_activity (kind, created_at);
-- sku is not the primary key (img is), but both the receival and sales
-- importers match existing stock with "img IN (...) OR sku IN (...)"; an
-- unindexed sku forces a full scan for that half of the OR. Partial, because
-- most rows may carry no sku.
CREATE INDEX IF NOT EXISTS idx_products_sku ON products (sku) WHERE sku IS NOT NULL;

-- =============================================================================
--  COLUMNS THE REPORTING MODULE READS
--
--  Three columns the ported reports reference that this schema never declared.
--  Without them `reorder` fails on "column pr.reorder_point does not exist" and
--  both `exceptions` and `users-staff` on "column must_change_password does not
--  exist" -- a 500 on the report rather than a missing figure, because the
--  column is named in the SELECT list.
-- =============================================================================

-- Set while an account is still on a seeded/reset default password. The guards
-- refuse to authorise anything except changing it, so a default credential
-- grants a session and nothing else. Cleared when the password is changed.
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false;

-- Optional manual overrides of the computed reorder point / order quantity.
-- scoreItems() derives both from demand when these are NULL, which is the
-- normal case; a buyer sets them to pin a part to their own numbers.
ALTER TABLE products ADD COLUMN IF NOT EXISTS reorder_point INTEGER;
ALTER TABLE products ADD COLUMN IF NOT EXISTS reorder_qty   INTEGER;

-- =============================================================================
--  SALES COMMISSION
--
--  A line's commission is resolved per line, never stored on the sale, so that
--  changing a rate recalculates history the same way the margin report already
--  recalculates off products.cost_usd. Resolution order:
--
--    products.commission_type = 'none'     -> nothing on this part, ever
--                             = 'amount'   -> commission_value per unit sold
--                             = 'percent'  -> commission_value % of the line
--    no override on the part               -> mechanics.commission_pct, the
--                                             crediting rep's default rate
--
--  The rep is pos_sales.sales_rep_id (a mechanics row -- see syncStaffProfile,
--  which mirrors any staff user in the 'sales_rep' category into mechanics).
--  A sale with no rep earns nobody anything and is left out of the report.
-- =============================================================================

-- The rep's default rate, applied to any line whose part carries no override.
-- NULL means "no default", which earns nothing rather than zero-by-accident.
ALTER TABLE mechanics ADD COLUMN IF NOT EXISTS commission_pct NUMERIC(5,2);

-- Per-part override. NULL type = fall through to the rep's default.
ALTER TABLE products ADD COLUMN IF NOT EXISTS commission_type  TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS commission_value NUMERIC(10,2);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_commission_type_chk') THEN
    ALTER TABLE products ADD CONSTRAINT products_commission_type_chk
      CHECK (commission_type IS NULL OR commission_type IN ('percent', 'amount', 'none'));
  END IF;
END $$;

-- What has actually been handed over. Commission earned is computed from the
-- sale lines; this is the other side of the ledger, so "owed" is earned minus
-- paid. Money is *_usd to match the rest of the Postgres side (the D1 port
-- stores amount_cents and divides by 100).
CREATE TABLE IF NOT EXISTS commission_payouts (
  id           SERIAL PRIMARY KEY,
  mechanic_id  INTEGER NOT NULL REFERENCES mechanics(id) ON DELETE CASCADE,
  amount_usd   NUMERIC(10,2) NOT NULL CHECK (amount_usd > 0),
  notes        TEXT,
  paid_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_commission_payouts_mech ON commission_payouts (mechanic_id, created_at);

-- =============================================================================
--  SUPPLIER INVOICE DETAIL ON A RECEIPT
--
--  Receiving stock and being billed for it are two different events on two
--  different dates, and the paperwork that arrives with the goods carries
--  figures of its own. Before this the only dates a PO had were expected_date
--  and received_date, and the only totals were the ones this system computed
--  from the lines -- so a supplier invoice dated the 3rd, entered on the 11th,
--  on 30-day terms, billing a total that disagreed with the lines by a freight
--  rounding, had nowhere to be recorded.
--
--    invoice_date       what the supplier's invoice is dated. The clock for
--                       payment terms starts here, NOT at received_date.
--    received_date      when the stock was entered here (already existed)
--    invoice_total_usd  what the supplier actually billed. Deliberately
--                       separate from total_usd, which recalcPoTotals() derives
--                       from the lines plus shipping and tax: when the two
--                       disagree that is a discrepancy to look at, and
--                       overwriting one with the other would hide it.
--    payment_terms_days net days from invoice_date
--    due_date           invoice_date + payment_terms_days, stored so ageing can
--                       sort and filter on it without recomputing per row
-- =============================================================================
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS invoice_date        DATE;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS invoice_total_usd   NUMERIC(10,2);
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS payment_terms_days  INTEGER;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS due_date            DATE;

CREATE INDEX IF NOT EXISTS idx_purchase_orders_invoice_date ON purchase_orders (invoice_date);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_due_date     ON purchase_orders (due_date) WHERE due_date IS NOT NULL;

-- Supplier payments already have a home (purchase_order_payments, added with
-- the reports module) but nothing could write to it: the payables report read
-- a table no endpoint ever inserted into, so "paid" was always zero. A method
-- vocabulary matching the POS side keeps the two reconcilable.
ALTER TABLE purchase_order_payments ADD COLUMN IF NOT EXISTS paid_on DATE;
UPDATE purchase_order_payments SET paid_on = created_at::date WHERE paid_on IS NULL;
CREATE INDEX IF NOT EXISTS idx_po_payments_paid_on ON purchase_order_payments (paid_on);
-- =============================================================================
--  WAREHOUSE FOUNDATION (Phase 1, 2026-10): bins, stock per bin, scan log
--
--  products.stock_count stays the single total every existing screen reads and
--  writes (POS sales, returns, PO receiving, manual adjust). stock_by_bin says
--  WHERE that total sits. The trigger below keeps the two equal without
--  touching any of those code paths: a total that drops is taken out of the
--  item's bins (primary bin first), a total that rises lands in the primary bin
--  (or UNASSIGNED). Bin-aware code (moves, putaway, bin counts) maintains
--  stock_by_bin itself and switches the trigger off for its own transaction
--  with  SELECT set_config('vision.bin_sync_off','on',true).
-- =============================================================================
CREATE TABLE IF NOT EXISTS warehouse_settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS bins (
  id            SERIAL PRIMARY KEY,
  code          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'storage', -- storage | display | receiving | staging | damaged | returns | unassigned
  zone          TEXT,
  aisle         TEXT,
  rack          TEXT,
  shelf         TEXT,
  pick_sequence INTEGER,                         -- walk order for route-sorted pick lists (Phase 3)
  is_active     BOOLEAN NOT NULL DEFAULT true,
  notes         TEXT,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_bins_code ON bins (upper(code));

CREATE TABLE IF NOT EXISTS stock_by_bin (
  product_img TEXT    NOT NULL REFERENCES products(img) ON DELETE CASCADE ON UPDATE CASCADE,
  bin_id      INTEGER NOT NULL REFERENCES bins(id) ON DELETE RESTRICT,
  qty         INTEGER NOT NULL DEFAULT 0 CHECK (qty >= 0),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (product_img, bin_id)
);
CREATE INDEX IF NOT EXISTS idx_stock_by_bin_bin ON stock_by_bin (bin_id);

ALTER TABLE warehouse_activity ADD COLUMN IF NOT EXISTS bin_id    INTEGER;
ALTER TABLE warehouse_activity ADD COLUMN IF NOT EXISTS to_bin_id INTEGER;
ALTER TABLE warehouse_activity ADD COLUMN IF NOT EXISTS terminal  TEXT;
ALTER TABLE warehouse_activity ADD COLUMN IF NOT EXISTS photo     TEXT;
CREATE INDEX IF NOT EXISTS idx_warehouse_activity_created ON warehouse_activity (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_warehouse_activity_product ON warehouse_activity (product_img, created_at DESC);

-- Legacy DOS locations carry a trailing marker after '*' ("J14*C", "OIL ROOM*",
-- "OIL ROOM*CC"); the shelf itself is the part before it. The original text is
-- left untouched in products.bin_location.
CREATE OR REPLACE FUNCTION wh_norm_bin(t TEXT) RETURNS TEXT
  LANGUAGE sql IMMUTABLE AS
$$ SELECT NULLIF(upper(btrim(regexp_replace(COALESCE(t, ''), '\*[A-Za-z]*\s*$', ''))), '') $$;

CREATE OR REPLACE FUNCTION wh_unassigned_bin() RETURNS INTEGER
  LANGUAGE plpgsql AS
$$
DECLARE bid INTEGER;
BEGIN
  SELECT id INTO bid FROM bins WHERE upper(code) = 'UNASSIGNED';
  IF bid IS NULL THEN
    INSERT INTO bins (code, kind, notes)
      VALUES ('UNASSIGNED', 'unassigned', 'Stock whose shelf is not known yet. Put it away to a real bin.')
      RETURNING id INTO bid;
  END IF;
  RETURN bid;
END $$;

CREATE OR REPLACE FUNCTION products_sync_bins() RETURNS trigger
  LANGUAGE plpgsql AS
$$
DECLARE
  delta   INTEGER;
  need    INTEGER;
  take    INTEGER;
  primary_id INTEGER;
  r       RECORD;
BEGIN
  IF COALESCE(current_setting('vision.bin_sync_off', true), '') = 'on' THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM warehouse_settings WHERE key = 'bins_enabled' AND value = 'on') THEN RETURN NEW; END IF;

  delta := COALESCE(NEW.stock_count, 0) - (CASE WHEN TG_OP = 'INSERT' THEN 0 ELSE COALESCE(OLD.stock_count, 0) END);
  IF delta = 0 THEN RETURN NEW; END IF;

  SELECT id INTO primary_id FROM bins WHERE upper(code) = wh_norm_bin(NEW.bin_location);

  IF delta > 0 THEN
    INSERT INTO stock_by_bin (product_img, bin_id, qty, updated_at)
      VALUES (NEW.img, COALESCE(primary_id, wh_unassigned_bin()), delta, NOW())
    ON CONFLICT (product_img, bin_id) DO UPDATE
      SET qty = stock_by_bin.qty + EXCLUDED.qty, updated_at = NOW();
  ELSE
    need := -delta;
    FOR r IN
      SELECT s.bin_id, s.qty FROM stock_by_bin s JOIN bins b ON b.id = s.bin_id
       WHERE s.product_img = NEW.img AND s.qty > 0
       ORDER BY (s.bin_id = primary_id) DESC NULLS LAST,
                (b.kind = 'unassigned') DESC,
                b.pick_sequence NULLS LAST, s.qty
       FOR UPDATE OF s
    LOOP
      EXIT WHEN need <= 0;
      take := LEAST(r.qty, need);
      UPDATE stock_by_bin SET qty = qty - take, updated_at = NOW()
       WHERE product_img = NEW.img AND bin_id = r.bin_id;
      need := need - take;
    END LOOP;
    -- Keep the primary bin's row (a known home, even at zero); drop other empties.
    DELETE FROM stock_by_bin
     WHERE product_img = NEW.img AND qty = 0 AND bin_id IS DISTINCT FROM primary_id;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_products_sync_bins ON products;
CREATE TRIGGER trg_products_sync_bins
  AFTER INSERT OR UPDATE OF stock_count ON products
  FOR EACH ROW EXECUTE FUNCTION products_sync_bins();

-- One-time load from the legacy bin_location text. Guarded by a settings row so
-- it never runs twice; bins_enabled switches the trigger on only after it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM warehouse_settings WHERE key = 'bins_loaded') THEN
    PERFORM wh_unassigned_bin();
    INSERT INTO bins (code, kind, notes)
    SELECT n.code,
           CASE WHEN n.code LIKE 'DISPLAY%' THEN 'display' ELSE 'storage' END,
           'Imported from legacy locations'
      FROM (SELECT DISTINCT wh_norm_bin(bin_location) AS code FROM products) n
     WHERE n.code IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM bins b WHERE upper(b.code) = n.code);

    INSERT INTO stock_by_bin (product_img, bin_id, qty)
    SELECT p.img, COALESCE(b.id, wh_unassigned_bin()), p.stock_count
      FROM products p
      LEFT JOIN bins b ON upper(b.code) = wh_norm_bin(p.bin_location)
     WHERE p.stock_count > 0 AND p.img IS NOT NULL
    ON CONFLICT (product_img, bin_id) DO NOTHING;

    INSERT INTO warehouse_settings (key, value) VALUES ('bins_loaded', NOW()::text), ('bins_enabled', 'on')
    ON CONFLICT (key) DO NOTHING;
  END IF;
END $$;

-- =============================================================================
--  INBOUND (Phase 2, 2026-10): exchange rates, receipts with batches, landed
--  cost, average cost, pricing rules, supplier bills, backorders.
--
--  Base currency is J$. The product money columns are named *_usd for
--  historical reasons but hold J$ (the legacy import kept the names), so
--  cost_usd / price_usd stay as the J$ figures every screen already shows.
--  A PO and its lines are in the SUPPLIER's currency (purchase_orders.currency);
--  receipts convert to J$ at the receipt's fx_rate.
-- =============================================================================
CREATE TABLE IF NOT EXISTS exchange_rates (
  id         SERIAL PRIMARY KEY,
  currency   TEXT NOT NULL,                 -- USD, CAD, ...  (J$ per 1 unit)
  rate_date  DATE NOT NULL,
  buy        NUMERIC(14,5),
  sell       NUMERIC(14,5),
  rate       NUMERIC(14,5) NOT NULL,        -- the figure used for costing
  source     TEXT NOT NULL DEFAULT 'boj',   -- boj | manual
  set_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  note       TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (currency, rate_date, source)
);

ALTER TABLE suppliers            ADD COLUMN IF NOT EXISTS currency      TEXT NOT NULL DEFAULT 'JMD';
ALTER TABLE purchase_orders      ADD COLUMN IF NOT EXISTS currency      TEXT NOT NULL DEFAULT 'JMD';
ALTER TABLE purchase_orders      ADD COLUMN IF NOT EXISTS ordered_at    TIMESTAMPTZ;   -- sent to supplier: start of the real lead time
ALTER TABLE purchase_orders      ADD COLUMN IF NOT EXISTS origin        TEXT;          -- reorder = drafted from suggestions
ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS qty_cancelled INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS receipts (
  id                      SERIAL PRIMARY KEY,
  receipt_number          TEXT UNIQUE,
  po_id                   INTEGER REFERENCES purchase_orders(id) ON DELETE SET NULL,
  supplier_id             INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  status                  TEXT NOT NULL DEFAULT 'open',      -- open | posted | void
  currency                TEXT NOT NULL DEFAULT 'JMD',
  fx_rate                 NUMERIC(14,5) NOT NULL DEFAULT 1,  -- J$ per 1 unit of currency
  fx_source               TEXT,
  freight                 NUMERIC(14,2) NOT NULL DEFAULT 0,  -- landed-cost extras, all in J$
  duty                    NUMERIC(14,2) NOT NULL DEFAULT 0,
  customs                 NUMERIC(14,2) NOT NULL DEFAULT 0,
  brokerage               NUMERIC(14,2) NOT NULL DEFAULT 0,
  other_costs             NUMERIC(14,2) NOT NULL DEFAULT 0,
  allocation_method       TEXT NOT NULL DEFAULT 'value',     -- value | qty
  supplier_invoice_number TEXT,
  supplier_invoice_date   DATE,
  supplier_invoice_total  NUMERIC(14,2),                     -- in the receipt currency
  payment_terms_days      INTEGER,
  bill_status             TEXT NOT NULL DEFAULT 'pending',   -- pending | confirmed | disputed
  bill_amount_jmd         NUMERIC(14,2),
  bill_variance_note      TEXT,
  bill_confirmed_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  bill_confirmed_at       TIMESTAMPTZ,
  due_date                DATE,
  receiving_bin_id        INTEGER REFERENCES bins(id),
  received_by             INTEGER REFERENCES users(id) ON DELETE SET NULL,
  received_at             TIMESTAMPTZ DEFAULT NOW(),
  posted_by               INTEGER REFERENCES users(id) ON DELETE SET NULL,
  posted_at               TIMESTAMPTZ,
  notes                   TEXT
);
CREATE INDEX IF NOT EXISTS idx_receipts_po     ON receipts (po_id);
CREATE INDEX IF NOT EXISTS idx_receipts_status ON receipts (status, bill_status);

CREATE TABLE IF NOT EXISTS receipt_lines (
  id               SERIAL PRIMARY KEY,
  receipt_id       INTEGER NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  po_item_id       INTEGER REFERENCES purchase_order_items(id) ON DELETE SET NULL,
  product_img      TEXT REFERENCES products(img) ON DELETE SET NULL ON UPDATE CASCADE,
  batch_code       TEXT UNIQUE,                     -- printed as BATCH:<code>
  qty_received     INTEGER NOT NULL DEFAULT 0,      -- good units
  qty_damaged      INTEGER NOT NULL DEFAULT 0,      -- arrived damaged: not stocked, claim from supplier
  unit_cost        NUMERIC(14,4),                   -- receipt currency
  landed_unit_cost NUMERIC(14,4),                   -- J$, incl. allocated extras
  old_avg_cost     NUMERIC(14,4),
  new_avg_cost     NUMERIC(14,4),
  old_price        NUMERIC(14,2),
  suggested_price  NUMERIC(14,2),
  new_price        NUMERIC(14,2),
  price_action     TEXT,                            -- kept | updated
  qty_putaway      INTEGER NOT NULL DEFAULT 0,
  notes            TEXT
);
CREATE INDEX IF NOT EXISTS idx_receipt_lines_receipt ON receipt_lines (receipt_id);
CREATE INDEX IF NOT EXISTS idx_receipt_lines_product ON receipt_lines (product_img);

CREATE TABLE IF NOT EXISTS pricing_rules (
  id             SERIAL PRIMARY KEY,
  category       TEXT,                              -- NULL = default for every category without its own rule
  markup_pct     NUMERIC(8,2) NOT NULL,             -- on cost
  round_to       NUMERIC(10,2) NOT NULL DEFAULT 10, -- round the price UP to a multiple of this (J$)
  min_margin_pct NUMERIC(8,2),                      -- never suggest below this gross margin
  never_lower    BOOLEAN NOT NULL DEFAULT true,     -- keep the current price if the rule would cut it
  is_active      BOOLEAN NOT NULL DEFAULT true,
  updated_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pricing_rules_category ON pricing_rules (COALESCE(lower(category), ''));

-- Sales-history lookups for reorder suggestions.
CREATE INDEX IF NOT EXISTS idx_pos_sales_created      ON pos_sales (created_at);
CREATE INDEX IF NOT EXISTS idx_pos_sale_items_sale    ON pos_sale_items (sale_id);
CREATE INDEX IF NOT EXISTS idx_pos_sale_items_product ON pos_sale_items (product_img);
CREATE INDEX IF NOT EXISTS idx_po_items_product       ON purchase_order_items (product_img);

-- Receiving and damaged areas; reorder settings; starting pricing rules taken
-- from the shop's own current markups (median price/cost per category).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM bins WHERE upper(code) = 'RECEIVING') THEN
    INSERT INTO bins (code, kind, notes) VALUES ('RECEIVING', 'receiving', 'Goods received, waiting to be put away');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM bins WHERE upper(code) = 'DAMAGED') THEN
    INSERT INTO bins (code, kind, notes) VALUES ('DAMAGED', 'damaged', 'Damaged stock, not for sale');
  END IF;
  INSERT INTO warehouse_settings (key, value) VALUES
    ('reorder_review_days', '14'), ('reorder_service_z', '1.65'), ('fx_use', 'sell'), ('bill_tolerance_pct', '1')
  ON CONFLICT (key) DO NOTHING;

  IF NOT EXISTS (SELECT 1 FROM warehouse_settings WHERE key = 'pricing_rules_seeded') THEN
    INSERT INTO pricing_rules (category, markup_pct, round_to)
    SELECT NULL, ROUND(((percentile_cont(0.5) WITHIN GROUP (ORDER BY price_usd / cost_usd)) - 1)::numeric * 100, 1), 10
      FROM products WHERE cost_usd > 0 AND price_usd > cost_usd;
    INSERT INTO pricing_rules (category, markup_pct, round_to)
    SELECT category, ROUND(((percentile_cont(0.5) WITHIN GROUP (ORDER BY price_usd / cost_usd)) - 1)::numeric * 100, 1), 10
      FROM products WHERE cost_usd > 0 AND price_usd > cost_usd AND COALESCE(category, '') <> ''
     GROUP BY category HAVING COUNT(*) >= 20;
    INSERT INTO warehouse_settings (key, value) VALUES ('pricing_rules_seeded', NOW()::text);
  END IF;
END $$;

-- =============================================================================
--  OUTBOUND (Phase 3, 2026-10): fulfilment orders, picking, packing,
--  manifests, pickup codes, holds, tracking events.
--
--  A fulfilment is the warehouse's job for one sale: pick it, pack it, then
--  hand it over (counter pickup) or send it (delivery / shipping). It sits
--  beside the POS: sales are made exactly as before, and a sweep in
--  outbound.js creates the fulfilment from new pos_sales / web orders.
--  Stock was already taken off at the sale (trigger), so picking moves no
--  stock; it records who took what from which bin, and shortages.
-- =============================================================================
CREATE TABLE IF NOT EXISTS fulfilments (
  id              SERIAL PRIMARY KEY,
  number          TEXT UNIQUE,                          -- F-000123
  source_kind     TEXT NOT NULL,                        -- pos_sale | web_order | manual
  source_id       INTEGER,
  source_ref      TEXT,                                 -- receipt / order number shown to staff
  customer_name   TEXT,
  customer_phone  TEXT,
  customer_email  TEXT,
  method          TEXT NOT NULL DEFAULT 'pickup',       -- pickup | delivery | shipping
  ship_to         JSONB,                                -- {name, phone, line1, line2, city, parish, country}
  status          TEXT NOT NULL DEFAULT 'new',          -- new | picking | picked | packed | ready | dispatched | delivered | collected | cancelled
  priority        INTEGER NOT NULL DEFAULT 0,           -- higher first
  on_hold         BOOLEAN NOT NULL DEFAULT false,
  hold_reason     TEXT,
  held_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  held_at         TIMESTAMPTZ,
  picker_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  pick_started_at TIMESTAMPTZ,
  picked_at       TIMESTAMPTZ,
  packer_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  packed_at       TIMESTAMPTZ,
  ready_at        TIMESTAMPTZ,
  pickup_code     TEXT,                                 -- 6 digits, given to the customer only
  pickup_attempts INTEGER NOT NULL DEFAULT 0,
  manifest_id     INTEGER,
  carrier         TEXT,
  tracking_number TEXT,
  dispatched_at   TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,                          -- delivered or collected
  completed_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  received_by_name TEXT,                                -- who signed / collected
  track_token     TEXT UNIQUE,                          -- random, for the customer's tracking page
  notes           TEXT,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (source_kind, source_id)
);
CREATE INDEX IF NOT EXISTS idx_fulfilments_status ON fulfilments (status, created_at);

CREATE TABLE IF NOT EXISTS fulfilment_lines (
  id             SERIAL PRIMARY KEY,
  fulfilment_id  INTEGER NOT NULL REFERENCES fulfilments(id) ON DELETE CASCADE,
  product_img    TEXT REFERENCES products(img) ON DELETE SET NULL ON UPDATE CASCADE,
  sku            TEXT,
  description    TEXT,
  qty            INTEGER NOT NULL,
  qty_picked     INTEGER NOT NULL DEFAULT 0,
  qty_short      INTEGER NOT NULL DEFAULT 0,
  short_reason   TEXT,                                 -- not_found | damaged | wrong_part | other
  bin_id         INTEGER REFERENCES bins(id),           -- where the picker took it from
  picked_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  picked_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_fulfilment_lines_f ON fulfilment_lines (fulfilment_id);

CREATE TABLE IF NOT EXISTS fulfilment_packages (
  id             SERIAL PRIMARY KEY,
  fulfilment_id  INTEGER NOT NULL REFERENCES fulfilments(id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,                     -- 1, 2, 3 ... of this order
  kind           TEXT NOT NULL DEFAULT 'box',           -- bag | box | tyre | pallet | envelope
  weight_kg      NUMERIC(8,2),
  contents       TEXT,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (fulfilment_id, seq)
);

CREATE TABLE IF NOT EXISTS manifests (
  id           SERIAL PRIMARY KEY,
  number       TEXT UNIQUE,                            -- M-000045
  kind         TEXT NOT NULL DEFAULT 'delivery',       -- delivery (own driver) | carrier
  carrier      TEXT,
  driver_name  TEXT,
  vehicle      TEXT,
  status       TEXT NOT NULL DEFAULT 'open',           -- open | dispatched | closed
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  dispatched_at TIMESTAMPTZ,
  closed_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS fulfilment_events (
  id             SERIAL PRIMARY KEY,
  fulfilment_id  INTEGER NOT NULL REFERENCES fulfilments(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL,                        -- created | hold | release | pick_start | picked | short | packed | ready | notified | dispatched | delivered | collected | pickup_failed | cancelled
  note           TEXT,
  by_user        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  terminal       TEXT,
  public         BOOLEAN NOT NULL DEFAULT false,       -- shown on the customer's tracking page
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fulfilment_events_f ON fulfilment_events (fulfilment_id, created_at);

DO $$
BEGIN
  INSERT INTO warehouse_settings (key, value) VALUES
    ('fulfil_auto', 'off'),          -- off | delivery | all : which new POS sales become pick orders
    ('fulfil_sweep_from', NULL),     -- pos_sales.id to start the sweep after (set when auto is switched on)
    ('fulfil_sla_minutes', '15'),    -- counter orders older than this turn red on the board
    ('fulfil_notify', 'on')          -- send SMS/email when an order is ready
  ON CONFLICT (key) DO NOTHING;
END $$;

-- =============================================================================
--  STOCK LEDGER + COST AT SALE (balancing report, 2026-10)
--
--  Stock changes in many places (POS sale, credit note, PO receive, Receive
--  screen, stock adjust, count posting, product edit, voids). None of them
--  kept a history, so no past opening stock or variance could be proven.
--  This trigger records EVERY change to products.stock_count, whatever code
--  made it, with the cost and price at that moment. From the day it starts,
--  opening / closing stock at any date is exact, and changes that are not a
--  sale, return or receipt show up as adjustments.
--
--  Code may label a change: SELECT set_config('vision.stock_reason','count',true).
-- =============================================================================
CREATE TABLE IF NOT EXISTS stock_ledger (
  id          BIGSERIAL PRIMARY KEY,
  product_img TEXT NOT NULL,
  delta       INTEGER NOT NULL,
  qty_after   INTEGER,
  unit_cost   NUMERIC(14,4),
  unit_price  NUMERIC(14,2),
  reason      TEXT,
  db_user     TEXT DEFAULT current_user,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_stock_ledger_created ON stock_ledger (created_at);
CREATE INDEX IF NOT EXISTS idx_stock_ledger_product ON stock_ledger (product_img, created_at);

CREATE OR REPLACE FUNCTION products_stock_ledger() RETURNS trigger
  LANGUAGE plpgsql AS
$$
DECLARE d INTEGER;
BEGIN
  d := COALESCE(NEW.stock_count, 0) - (CASE WHEN TG_OP = 'INSERT' THEN 0 ELSE COALESCE(OLD.stock_count, 0) END);
  IF d <> 0 AND NEW.img IS NOT NULL THEN
    INSERT INTO stock_ledger (product_img, delta, qty_after, unit_cost, unit_price, reason)
    VALUES (NEW.img, d, NEW.stock_count, NEW.cost_usd, NEW.price_usd, NULLIF(current_setting('vision.stock_reason', true), ''));
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_products_stock_ledger ON products;
CREATE TRIGGER trg_products_stock_ledger
  AFTER INSERT OR UPDATE OF stock_count ON products
  FOR EACH ROW EXECUTE FUNCTION products_stock_ledger();

-- Cost of the part at the moment it was sold, so cost of sales stops moving
-- when the average cost changes later. Old lines keep NULL (the report then
-- uses today's cost and says so).
ALTER TABLE pos_sale_items ADD COLUMN IF NOT EXISTS unit_cost NUMERIC(14,4);

CREATE OR REPLACE FUNCTION pos_sale_items_cost() RETURNS trigger
  LANGUAGE plpgsql AS
$$
BEGIN
  IF NEW.unit_cost IS NULL AND NEW.product_img IS NOT NULL THEN
    SELECT cost_usd INTO NEW.unit_cost FROM products WHERE img = NEW.product_img;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_pos_sale_items_cost ON pos_sale_items;
CREATE TRIGGER trg_pos_sale_items_cost
  BEFORE INSERT ON pos_sale_items
  FOR EACH ROW EXECUTE FUNCTION pos_sale_items_cost();

INSERT INTO warehouse_settings (key, value) VALUES ('stock_ledger_started', NOW()::text)
ON CONFLICT (key) DO NOTHING;

-- =============================================================================
--  CASHIER MODULE (2026-10): stations, POS orders awaiting payment, drawer
--  (till) sessions.
--
--  pos_stations   a counter position, bound to one device by a key. Kinds:
--                 order       builds carts; checkout sends them to a cashier
--                 cashier     takes payment for the order stations it serves
--                 integrated  single-user: rings and takes payment itself
--  pos_orders     a cart saved without payment ('Save as order' in the POS),
--                 routed to the order station's cashier (or its backup, or
--                 any cashier). Paying it replays the cart through the normal
--                 sale code (posSaleHandler), so stock and the invoice are
--                 made exactly as for a counter sale.
--  till_sessions  one cash drawer shift: one station, one cashier, opening
--                 float by denomination, blind close, expected vs counted.
--  till_sales     which sales belong to which shift (cash expected).
--  The older single cash_drawer_sessions table is left as it is.
-- =============================================================================
CREATE TABLE IF NOT EXISTS pos_stations (
  id                 SERIAL PRIMARY KEY,
  name               TEXT NOT NULL,
  kind               TEXT NOT NULL DEFAULT 'order',   -- order | cashier | integrated
  cashier_station_id INTEGER REFERENCES pos_stations(id) ON DELETE SET NULL,  -- order stations: who takes their payments
  backup_station_id  INTEGER REFERENCES pos_stations(id) ON DELETE SET NULL,  -- cashier stations: who covers when closed
  device_key_hash    TEXT,
  bound_at           TIMESTAMPTZ,
  bound_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  is_active          BOOLEAN NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pos_stations_name ON pos_stations (lower(name));

CREATE TABLE IF NOT EXISTS pos_orders (
  id                 SERIAL PRIMARY KEY,
  status             TEXT NOT NULL DEFAULT 'pending', -- pending | invoicing | completed | cancelled | expired
  payload            JSONB NOT NULL,                  -- the POS sale body, without payments
  total_usd          NUMERIC(14,2),                   -- exact, from a dry run of the sale code (J$)
  preview            JSONB,
  customer_id        INTEGER,
  customer_name      TEXT,
  customer_phone     TEXT,
  sales_rep_id       INTEGER,
  sales_rep_name     TEXT,
  ship_instructions  TEXT,
  taken_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  order_station_id   INTEGER REFERENCES pos_stations(id) ON DELETE SET NULL,
  cashier_station_id INTEGER REFERENCES pos_stations(id) ON DELETE SET NULL,
  claimed_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  claimed_at         TIMESTAMPTZ,
  converted_sale_id  INTEGER,
  till_session_id    INTEGER,
  cancel_reason      TEXT,
  cancelled_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  completed_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_pos_orders_status ON pos_orders (status, created_at);

CREATE TABLE IF NOT EXISTS till_sessions (
  id              SERIAL PRIMARY KEY,
  station_id      INTEGER NOT NULL REFERENCES pos_stations(id),
  user_id         INTEGER NOT NULL REFERENCES users(id),
  status          TEXT NOT NULL DEFAULT 'open',       -- open | closed
  opening_float   NUMERIC(14,2) NOT NULL DEFAULT 0,
  opening_count   JSONB,                              -- {"5000": 2, "1000": 5, ...}
  opened_at       TIMESTAMPTZ DEFAULT NOW(),
  counted_cash    NUMERIC(14,2),
  closing_count   JSONB,
  expected_cash   NUMERIC(14,2),
  variance        NUMERIC(14,2),
  closed_at       TIMESTAMPTZ,
  closed_by       INTEGER REFERENCES users(id),
  close_notes     TEXT,
  reviewed_by     INTEGER REFERENCES users(id),
  reviewed_at     TIMESTAMPTZ,
  review_note     TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_till_sessions_open ON till_sessions (station_id) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS till_movements (
  id          SERIAL PRIMARY KEY,
  session_id  INTEGER NOT NULL REFERENCES till_sessions(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,                          -- drop (to safe) | payout (petty) | float_in | no_sale
  amount      NUMERIC(14,2) NOT NULL DEFAULT 0,
  reason      TEXT,
  by_user     INTEGER REFERENCES users(id),
  approved_by INTEGER REFERENCES users(id),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS till_sales (
  session_id  INTEGER NOT NULL REFERENCES till_sessions(id) ON DELETE CASCADE,
  sale_id     INTEGER NOT NULL,
  PRIMARY KEY (session_id, sale_id)
);

INSERT INTO warehouse_settings (key, value) VALUES
  ('cash_order_expiry_min', '240'),   -- unpaid POS orders expire after this many minutes
  ('cash_payout_limit', '5000')       -- payouts above this need a manager PIN
ON CONFLICT (key) DO NOTHING;

-- =============================================================================
--  STOCK COUNTS (Phase 4, 2026-10): bin counts by scan, blind, recount on
--  variance by a second person, photos, manager approval, ABC cycle schedule.
--
--  A count covers a list of bins. Each bin is counted by scanning what is on
--  the shelf; the expected quantity is never shown to the counter (blind).
--  When a bin is finished, its lines are compared with stock_by_bin AT THAT
--  MOMENT (sales keep running during a count). Differences over the tolerance
--  need a recount by someone else; then a manager approves and posting moves
--  stock_by_bin and products.stock_count by the difference (labelled 'count'
--  in the stock ledger).
-- =============================================================================
CREATE TABLE IF NOT EXISTS bin_counts (
  id          SERIAL PRIMARY KEY,
  number      TEXT UNIQUE,                       -- CNT-000012
  kind        TEXT NOT NULL DEFAULT 'adhoc',     -- adhoc | cycle | full
  status      TEXT NOT NULL DEFAULT 'counting',  -- counting | review | posted | cancelled
  note        TEXT,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  posted_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  posted_at   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS bin_count_bins (
  count_id    INTEGER NOT NULL REFERENCES bin_counts(id) ON DELETE CASCADE,
  bin_id      INTEGER NOT NULL REFERENCES bins(id),
  status      TEXT NOT NULL DEFAULT 'open',      -- open | counted | recount | approved
  counted_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  counted_at  TIMESTAMPTZ,
  recount_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  recount_at  TIMESTAMPTZ,
  photo       TEXT,
  PRIMARY KEY (count_id, bin_id)
);

CREATE TABLE IF NOT EXISTS bin_count_lines (
  id           SERIAL PRIMARY KEY,
  count_id     INTEGER NOT NULL REFERENCES bin_counts(id) ON DELETE CASCADE,
  bin_id       INTEGER NOT NULL REFERENCES bins(id),
  product_img  TEXT NOT NULL REFERENCES products(img) ON UPDATE CASCADE ON DELETE CASCADE,
  counted_qty  INTEGER NOT NULL DEFAULT 0,       -- first count
  recount_qty  INTEGER,                          -- second person's count, when asked
  system_qty   INTEGER,                          -- what the system held when the bin was finished
  unit_cost    NUMERIC(14,4),
  photo        TEXT,
  note         TEXT,
  UNIQUE (count_id, bin_id, product_img)
);
CREATE INDEX IF NOT EXISTS idx_bin_count_lines_count ON bin_count_lines (count_id, bin_id);

ALTER TABLE products ADD COLUMN IF NOT EXISTS last_counted_at TIMESTAMPTZ;

INSERT INTO warehouse_settings (key, value) VALUES
  ('count_tolerance_units', '0'),     -- a difference above this many units needs a recount
  ('count_tolerance_value', '5000'),  -- ...or above this J$ value at cost
  ('count_cycle_days_a', '30'), ('count_cycle_days_b', '90'), ('count_cycle_days_c', '365')
ON CONFLICT (key) DO NOTHING;

-- =============================================================================
--  Phase 5: lost sales and planning
--  lost_sales holds sales staff could not make (recorded at the counter, on the
--  phone or in the warehouse). Short picks and expired / cancelled POS orders
--  are not copied here: the planning report reads them where they live.
-- =============================================================================
CREATE TABLE IF NOT EXISTS lost_sales (
  id              SERIAL PRIMARY KEY,
  product_img     TEXT REFERENCES products(img) ON DELETE SET NULL ON UPDATE CASCADE,
  description     TEXT NOT NULL,                     -- the part asked for, as the customer put it
  vehicle         TEXT,
  qty             INTEGER NOT NULL DEFAULT 1 CHECK (qty > 0),
  unit_price      NUMERIC(14,2),                     -- J$ quoted or list price, when known
  reason          TEXT NOT NULL DEFAULT 'out_of_stock', -- out_of_stock | not_stocked | price | lead_time | quality | other
  channel         TEXT NOT NULL DEFAULT 'counter',   -- counter | phone | online | warehouse
  competitor      TEXT,
  customer_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  customer_name   TEXT,
  customer_phone  TEXT,
  follow_up       BOOLEAN NOT NULL DEFAULT false,    -- call the customer when it comes in
  followed_up_at  TIMESTAMPTZ,
  note            TEXT,
  recorded_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lost_sales_created ON lost_sales (created_at);
CREATE INDEX IF NOT EXISTS idx_lost_sales_product ON lost_sales (product_img);

INSERT INTO warehouse_settings (key, value) VALUES
  ('plan_dead_days', '365'),        -- no sale in this many days = dead stock
  ('plan_slow_days', '180'),        -- no sale in this many days = slow
  ('plan_target_days_cover', '90'), -- inventory days the business aims for
  ('plan_target_fill_rate', '95')   -- % of units asked for that were supplied
ON CONFLICT (key) DO NOTHING;

-- =============================================================================
--  Phase 6: customer notifications, pickup by someone else, delivery report
--  notify_templates: one message per event and channel, editable by staff.
--  notifications: every message the system tried to send (sent, stubbed when
--  SMS/email are not set up, skipped with the reason, failed and retried).
-- =============================================================================
CREATE TABLE IF NOT EXISTS notify_templates (
  event       TEXT NOT NULL,                 -- order_received | ready_pickup | ready_delivery | out_for_delivery | shipped | delivered | collected | part_in_stock
  channel     TEXT NOT NULL,                 -- sms | email | whatsapp
  enabled     BOOLEAN NOT NULL DEFAULT true,
  subject     TEXT,                          -- email only
  body        TEXT NOT NULL,                 -- {shop} {name} {number} {code} {link} {carrier} {tracking} {part} {received_by} {phone}
  updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (event, channel)
);

CREATE TABLE IF NOT EXISTS notifications (
  id            BIGSERIAL PRIMARY KEY,
  event         TEXT NOT NULL,
  channel       TEXT NOT NULL,
  to_addr       TEXT,
  subject       TEXT,
  body          TEXT,
  status        TEXT NOT NULL DEFAULT 'queued', -- queued | sent | stubbed | link | skipped | failed
  reason        TEXT,                           -- why skipped / the error
  attempts      INTEGER NOT NULL DEFAULT 0,
  send_after    TIMESTAMPTZ DEFAULT NOW(),      -- quiet hours push SMS to the morning
  related_kind  TEXT,                           -- fulfilment | lost_sale
  related_id    INTEGER,
  customer_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  by_user       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  sent_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_due ON notifications (send_after) WHERE status IN ('queued', 'failed');
CREATE INDEX IF NOT EXISTS idx_notifications_related ON notifications (related_kind, related_id);

-- Pickup by someone other than the customer, and the ID shown at the counter.
ALTER TABLE fulfilments ADD COLUMN IF NOT EXISTS authorised_collector TEXT;   -- named by the customer in advance
ALTER TABLE fulfilments ADD COLUMN IF NOT EXISTS collected_by_other   BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE fulfilments ADD COLUMN IF NOT EXISTS id_checked           TEXT;   -- e.g. "Driver's licence ...1234"

INSERT INTO warehouse_settings (key, value) VALUES
  ('notify_enabled', 'on'),
  ('notify_quiet_from', '21:00'),   -- SMS / WhatsApp held overnight; email goes any time
  ('notify_quiet_to', '07:30'),
  ('notify_shop_phone', '876-728-4735'),
  ('pickup_uncollected_days', '7')
ON CONFLICT (key) DO NOTHING;

-- The shop's phone number changed in Oct 2026 (the WhatsApp line is separate
-- now). The INSERT above only seeds a fresh till, so move a till that still
-- holds the previous number. An operator-edited value is left alone.
UPDATE warehouse_settings SET value = '876-728-4735'
  WHERE key = 'notify_shop_phone' AND value IN ('876-758-5590', '(876) 758-5590');

INSERT INTO notify_templates (event, channel, enabled, subject, body) VALUES
  ('order_received',   'sms',      false, NULL, '{shop}: we have your order {number}. We will text you when it is ready.{link}'),
  ('order_received',   'email',    true,  'We have your order {number}', E'Hi {name},\n\nThanks for your order {number}. We are getting it ready and will let you know as soon as it is.{link}\n\n{shop} · {phone}'),
  ('ready_pickup',     'sms',      true,  NULL, '{shop}: order {number} is ready. Pickup code {code}. Anyone collecting for you needs this code and ID.{link}'),
  ('ready_pickup',     'email',    true,  'Order {number} is ready for pickup', E'Hi {name},\n\nYour order {number} is ready for pickup.\n\nPickup code: {code}\n\nBring this code with you. If someone else is collecting, give them the code; they will need ID.{link}\n\n{shop} · {phone}'),
  ('ready_pickup',     'whatsapp', true,  NULL, '{shop}: order {number} is ready for pickup. Pickup code {code}.'),
  ('ready_delivery',   'sms',      false, NULL, '{shop}: order {number} is packed and will go out soon.{link}'),
  ('ready_delivery',   'email',    true,  'Order {number} is packed', E'Hi {name},\n\nYour order {number} is packed and will be sent out soon.{link}\n\n{shop} · {phone}'),
  ('out_for_delivery', 'sms',      true,  NULL, '{shop}: order {number} is out for delivery today.{link}'),
  ('out_for_delivery', 'email',    true,  'Order {number} is on the way', E'Hi {name},\n\nYour order {number} is out for delivery.{link}\n\n{shop} · {phone}'),
  ('shipped',          'sms',      true,  NULL, '{shop}: order {number} was handed to {carrier}. Tracking {tracking}.{link}'),
  ('shipped',          'email',    true,  'Order {number} has shipped', E'Hi {name},\n\nYour order {number} was handed to {carrier}. Tracking number: {tracking}.{link}\n\n{shop} · {phone}'),
  ('delivered',        'sms',      false, NULL, '{shop}: order {number} was delivered and signed for by {received_by}. Thank you!'),
  ('delivered',        'email',    true,  'Order {number} was delivered', E'Hi {name},\n\nYour order {number} was delivered and received by {received_by}. Thank you for your business.\n\n{shop} · {phone}'),
  ('collected',        'sms',      false, NULL, '{shop}: order {number} was collected by {received_by}. Thank you!'),
  ('collected',        'email',    true,  'Order {number} was collected', E'Hi {name},\n\nYour order {number} was collected by {received_by}. If that was not you or someone you sent, call us on {phone}.\n\n{shop}'),
  ('part_in_stock',    'sms',      true,  NULL, '{shop}: good news, {part} is in stock now. Call {phone} or come in and we will put it aside.'),
  ('part_in_stock',    'whatsapp', true,  NULL, 'Hi {name}, {shop} here: {part} is in stock now. Shall we put it aside for you?')
ON CONFLICT (event, channel) DO NOTHING;

-- =============================================================================
--  Phase 7: accounting backbone (general ledger)
--  gl.js posts finished documents (sales, payments, returns, receipts, bills,
--  supplier payments, drawer shifts, stock adjustments) as balanced journal
--  entries from the ledger start date on. Entries never change: corrections
--  are reversing entries, and a closed month takes no new entries.
--  Amounts are J$; a line's amount is + for a debit and - for a credit.
-- =============================================================================
CREATE TABLE IF NOT EXISTS gl_accounts (
  id          SERIAL PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('asset','liability','equity','income','cogs','expense','other_income','other_expense')),
  qb_name     TEXT,                       -- the account's exact name in QuickBooks (Parent:Child), used in the IIF export
  qb_type     TEXT,                       -- BANK | AR | OCASSET | FIXASSET | AP | OCLIAB | LTLIAB | EQUITY | INC | COGS | EXP | EXINC | EXEXP
  system_key  TEXT UNIQUE,                -- what the posting rules look for
  is_active   BOOLEAN NOT NULL DEFAULT true,
  notes       TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Mapping rules: which account a payment method, product category or stock
-- reason posts to. Missing rules fall back to the system default account.
CREATE TABLE IF NOT EXISTS gl_map (
  kind        TEXT NOT NULL,              -- pay_method | revenue_category | cogs_category | stock_reason | till_payout
  key         TEXT NOT NULL,
  account_id  INTEGER NOT NULL REFERENCES gl_accounts(id),
  PRIMARY KEY (kind, key)
);

CREATE TABLE IF NOT EXISTS gl_entries (
  id           BIGSERIAL PRIMARY KEY,
  number       TEXT UNIQUE,                -- JE-000001
  entry_date   DATE NOT NULL,              -- Jamaica date the books show it
  book         TEXT NOT NULL,              -- sales | purchases | cash | stock | opening | manual
  source_kind  TEXT NOT NULL,              -- sale | sale_payment | sale_void | return | account_payment | receipt | bill | po_payment | po_invoice | till_open | till_movement | till_close | stock_day | gift_card | commission | opening | manual | reversal
  source_id    BIGINT NOT NULL,
  source_ref   TEXT,                       -- receipt / document number shown to people
  memo         TEXT,
  reverses_id  BIGINT REFERENCES gl_entries(id),
  reversed_by  BIGINT REFERENCES gl_entries(id),
  posted_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  posted_at    TIMESTAMPTZ DEFAULT NOW(),
  export_id    INTEGER,
  UNIQUE (source_kind, source_id)
);
CREATE INDEX IF NOT EXISTS idx_gl_entries_date ON gl_entries (entry_date);

CREATE TABLE IF NOT EXISTS gl_lines (
  id          BIGSERIAL PRIMARY KEY,
  entry_id    BIGINT NOT NULL REFERENCES gl_entries(id),
  account_id  INTEGER NOT NULL REFERENCES gl_accounts(id),
  amount      NUMERIC(14,2) NOT NULL,     -- + debit, - credit
  party       TEXT,                       -- customer / supplier name (QuickBooks needs it on A/R and A/P lines)
  memo        TEXT
);
CREATE INDEX IF NOT EXISTS idx_gl_lines_entry ON gl_lines (entry_id);
CREATE INDEX IF NOT EXISTS idx_gl_lines_account ON gl_lines (account_id);

CREATE TABLE IF NOT EXISTS gl_periods (
  month      DATE PRIMARY KEY,            -- first day of the month
  closed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  note       TEXT
);

CREATE TABLE IF NOT EXISTS gl_exports (
  id          SERIAL PRIMARY KEY,
  kind        TEXT NOT NULL,              -- iif | csv
  from_date   DATE NOT NULL,
  to_date     DATE NOT NULL,
  entries     INTEGER NOT NULL DEFAULT 0,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Guards: lines never change; entries change only to record a reversal or an export.
CREATE OR REPLACE FUNCTION gl_lines_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Journal lines cannot be changed or deleted: post a reversing entry'; END $$;
DROP TRIGGER IF EXISTS gl_lines_no_change ON gl_lines;
CREATE TRIGGER gl_lines_no_change BEFORE UPDATE OR DELETE ON gl_lines FOR EACH ROW EXECUTE FUNCTION gl_lines_immutable();

CREATE OR REPLACE FUNCTION gl_entries_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Journal entries cannot be deleted: post a reversing entry'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.entry_date, NEW.book, NEW.source_kind, NEW.source_id, NEW.memo, NEW.reverses_id, NEW.posted_at)
       IS DISTINCT FROM (OLD.entry_date, OLD.book, OLD.source_kind, OLD.source_id, OLD.memo, OLD.reverses_id, OLD.posted_at)
       OR (OLD.number IS NOT NULL AND NEW.number IS DISTINCT FROM OLD.number) THEN
      RAISE EXCEPTION 'Journal entries cannot be changed: post a reversing entry';
    END IF;
    RETURN NEW;
  END IF;
  -- INSERT: not into a closed month
  IF EXISTS (SELECT 1 FROM gl_periods WHERE month = date_trunc('month', NEW.entry_date)::date) THEN
    RAISE EXCEPTION 'The books for % are closed', to_char(NEW.entry_date, 'Mon YYYY');
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS gl_entries_guard ON gl_entries;
CREATE TRIGGER gl_entries_guard BEFORE INSERT OR UPDATE OR DELETE ON gl_entries FOR EACH ROW EXECUTE FUNCTION gl_entries_guard();

-- Every entry must balance, checked when the transaction commits.
CREATE OR REPLACE FUNCTION gl_check_balance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d NUMERIC; n INTEGER;
BEGIN
  SELECT COALESCE(SUM(amount), 0), COUNT(*) INTO d, n FROM gl_lines WHERE entry_id = NEW.entry_id;
  IF d <> 0 THEN RAISE EXCEPTION 'Journal entry % does not balance (off by %)', NEW.entry_id, d; END IF;
  IF n < 2 THEN RAISE EXCEPTION 'Journal entry % needs at least two lines', NEW.entry_id; END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS gl_lines_balance ON gl_lines;
CREATE CONSTRAINT TRIGGER gl_lines_balance AFTER INSERT ON gl_lines DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION gl_check_balance();

-- Starting chart. Names follow common QuickBooks naming; set qb_name to your
-- own QuickBooks account names (or import your chart) before exporting.
INSERT INTO gl_accounts (code, name, type, qb_name, qb_type, system_key) VALUES
  ('1000', 'Cash Drawers',                       'asset',     'Cash Drawers',                       'OCASSET', 'cash_drawers'),
  ('1010', 'Undeposited Funds (Safe)',           'asset',     'Undeposited Funds',                  'OCASSET', 'cash_safe'),
  ('1020', 'Bank - Operating',                   'asset',     'Bank - Operating',                   'BANK',    'bank'),
  ('1030', 'Cheques to Deposit',                 'asset',     'Cheques to Deposit',                 'OCASSET', 'cheques'),
  ('1040', 'Card Settlements Clearing',          'asset',     'Card Settlements Clearing',          'OCASSET', 'card_clearing'),
  ('1100', 'Accounts Receivable',                'asset',     'Accounts Receivable',                'AR',      'ar'),
  ('1150', 'Supplier Claims Receivable',         'asset',     'Supplier Claims Receivable',         'OCASSET', 'supplier_claims'),
  ('1200', 'Inventory Asset',                    'asset',     'Inventory Asset',                    'OCASSET', 'inventory'),
  ('2000', 'Accounts Payable',                   'liability', 'Accounts Payable',                   'AP',      'ap'),
  ('2050', 'Goods Received Not Invoiced',        'liability', 'Goods Received Not Invoiced',        'OCLIAB',  'grni'),
  ('2060', 'Landed Cost Accrual',                'liability', 'Landed Cost Accrual',                'OCLIAB',  'landed_accrual'),
  ('2100', 'GCT Payable',                        'liability', 'GCT Payable',                        'OCLIAB',  'gct'),
  ('2150', 'Gift Cards and Store Credit',        'liability', 'Gift Cards and Store Credit',        'OCLIAB',  'gift_cards'),
  ('3000', 'Opening Balance Equity',             'equity',    'Opening Balance Equity',             'EQUITY',  'opening_equity'),
  ('4000', 'Sales - Parts',                      'income',    'Sales - Parts',                      'INC',     'sales'),
  ('4050', 'Sales - Labour and Services',        'income',    'Sales - Labour and Services',        'INC',     'sales_services'),
  ('4090', 'Sales Returns',                      'income',    'Sales Returns',                      'INC',     'sales_returns'),
  ('4100', 'Sales Discounts',                    'income',    'Sales Discounts',                    'INC',     'sales_discounts'),
  ('4200', 'Delivery and Shipping Income',       'income',    'Delivery and Shipping Income',       'INC',     'delivery_income'),
  ('5000', 'Cost of Goods Sold',                 'cogs',      'Cost of Goods Sold',                 'COGS',    'cogs'),
  ('5050', 'Purchase Price Variance',            'cogs',      'Purchase Price Variance',            'COGS',    'ppv'),
  ('5100', 'Inventory Adjustments and Shrinkage','cogs',      'Inventory Adjustments and Shrinkage','COGS',    'inv_adjust'),
  ('5150', 'Parts Used in Workshop',             'cogs',      'Parts Used in Workshop',             'COGS',    'workshop_parts'),
  ('6000', 'Cash Over and Short',                'expense',   'Cash Over and Short',                'EXP',     'cash_over_short'),
  ('6100', 'Till Payouts and Petty Expenses',    'expense',   'Petty Cash Expenses',                'EXP',     'petty_expense'),
  ('6200', 'Commissions',                        'expense',   'Commissions',                        'EXP',     'commissions'),
  ('6300', 'Loyalty Rewards',                    'expense',   'Loyalty Rewards',                    'EXP',     'loyalty'),
  ('6900', 'Suspense (to be reviewed)',          'expense',   'Ask My Accountant',                  'EXP',     'suspense')
ON CONFLICT (code) DO NOTHING;

INSERT INTO gl_map (kind, key, account_id)
SELECT m.kind, m.key, a.id FROM (VALUES
  ('pay_method', 'cash', 'cash_drawers'), ('pay_method', 'cheque', 'cheques'), ('pay_method', 'card', 'card_clearing'),
  ('pay_method', 'bank', 'bank'), ('pay_method', 'transfer', 'bank'), ('pay_method', 'gift_card', 'gift_cards'),
  ('pay_method', 'store_credit', 'gift_cards'), ('pay_method', 'loyalty', 'loyalty'), ('pay_method', 'credit_note', 'ar'),
  ('pay_method', 'charge', 'ar'), ('pay_method', 'account', 'ar'),
  ('stock_reason', 'count', 'inv_adjust'), ('stock_reason', 'requisition', 'workshop_parts'), ('stock_reason', 'other', 'inv_adjust'),
  ('stock_reason', 'po_quick_receive', 'grni')
) m(kind, key, sk) JOIN gl_accounts a ON a.system_key = m.sk
ON CONFLICT (kind, key) DO NOTHING;

INSERT INTO warehouse_settings (key, value) VALUES ('gl_auto_post', 'on') ON CONFLICT (key) DO NOTHING;

-- =============================================================================
--  Phase 8.2: departments and the terminal journal (terminal.js)
--  A department is a set of product categories. Staff and cashier stations
--  are given departments; a counter agent can only sell their departments'
--  parts unless a manager approves with a PIN (logged). pos_events records
--  what happens on the till screen (items added / removed, price, quantity
--  and discount changes, carts emptied, holds recalled, overrides); sales,
--  voids, refunds and drawer events are read from their own tables.
-- =============================================================================
CREATE TABLE IF NOT EXISTS departments (
  id          SERIAL PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  categories  TEXT[] NOT NULL DEFAULT '{}',   -- lower-case product categories in this department
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS user_departments (
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  department_id  INTEGER NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, department_id)
);
CREATE TABLE IF NOT EXISTS station_departments (
  station_id     INTEGER NOT NULL REFERENCES pos_stations(id) ON DELETE CASCADE,
  department_id  INTEGER NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  PRIMARY KEY (station_id, department_id)
);

CREATE TABLE IF NOT EXISTS pos_events (
  id            BIGSERIAL PRIMARY KEY,
  at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),   -- when the server received it
  client_at     TIMESTAMPTZ,                          -- when it happened on the till
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  user_name     TEXT,
  station_id    INTEGER,
  terminal      TEXT,
  ticket        TEXT,                                 -- the till's id for this cart, ties events together
  kind          TEXT NOT NULL,                        -- item_added | item_removed | qty_changed | price_changed | discount_changed | cart_cleared | hold_recalled | dept_override | dept_blocked
  product_img   TEXT,
  sku           TEXT,
  name          TEXT,
  qty           NUMERIC(12,3),
  value_before  NUMERIC(14,2),
  value_after   NUMERIC(14,2),
  amount        NUMERIC(14,2),                        -- J$ at stake (line value, removed value, price drop x qty ...)
  note          TEXT,
  approved_by   INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_pos_events_at ON pos_events (at DESC);
CREATE INDEX IF NOT EXISTS idx_pos_events_user ON pos_events (user_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_pos_events_kind ON pos_events (kind, at DESC);

INSERT INTO warehouse_settings (key, value) VALUES
  ('dept_enforce', 'off'),            -- on: staff with departments can only sell those parts without a manager PIN
  ('tj_void_alert', '20000'),         -- J$: voids and refunds at or above this are exceptions
  ('tj_discount_pct_alert', '20'),    -- % off a sale at or above this is an exception
  ('tj_nosale_per_day', '5'),         -- no-sale drawer opens per person per day above this
  ('tj_removed_per_day', '15')        -- items taken back off carts per person per day above this
ON CONFLICT (key) DO NOTHING;

-- =============================================================================
--  Receivables, payables and banking (QuickBooks-style)
--
--  Receivables: a payment is applied to the invoices it pays (ar_applications);
--  what is not applied stays as a credit on the account. Payments can be
--  voided: every payment lives in account_payments_all, and account_payments
--  becomes a view of the ones not voided, so every existing balance, statement
--  and report leaves voided payments out without being rewritten.
--  NOTE: the view is SELECT * -- after adding a column to account_payments_all,
--  re-create the view (this block does it on every boot).
--
--  Payables: bills are confirmed goods receipts, PO invoices, and expense bills
--  entered here (ap_bills, coded to accounts, with GCT); vendor credits are
--  ap_bills of kind 'credit'. One payment can pay several bills and use credits
--  (ap_applications).
--
--  Banking: cheques / spend money, receive money, transfers and deposits of
--  undeposited funds (bank_txns); reconciliations tick off ledger lines on a
--  bank account (bank_cleared); imported statement lines are matched to the
--  ledger or added as transactions (bank_feed_lines, bank_rules).
--  Everything posts to the general ledger (gl.js); voids post a reversal.
-- =============================================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relname = 'account_payments' AND c.relkind = 'r' AND n.nspname = current_schema()) THEN
    ALTER TABLE account_payments RENAME TO account_payments_all;
  END IF;
END $$;
ALTER TABLE account_payments_all ADD COLUMN IF NOT EXISTS paid_on            DATE;
ALTER TABLE account_payments_all ADD COLUMN IF NOT EXISTS deposit_account_id INTEGER REFERENCES gl_accounts(id);
ALTER TABLE account_payments_all ADD COLUMN IF NOT EXISTS voided_at          TIMESTAMPTZ;
ALTER TABLE account_payments_all ADD COLUMN IF NOT EXISTS voided_by          INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE account_payments_all ADD COLUMN IF NOT EXISTS void_reason        TEXT;
CREATE OR REPLACE VIEW account_payments AS SELECT * FROM account_payments_all WHERE voided_at IS NULL;

CREATE TABLE IF NOT EXISTS ar_applications (
  id          SERIAL PRIMARY KEY,
  payment_id  INTEGER NOT NULL REFERENCES account_payments_all(id) ON DELETE CASCADE,
  sale_id     INTEGER NOT NULL REFERENCES pos_sales(id) ON DELETE CASCADE,
  amount      NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  applied_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  applied_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ar_app_payment ON ar_applications (payment_id);
CREATE INDEX IF NOT EXISTS idx_ar_app_sale    ON ar_applications (sale_id);

ALTER TABLE users ADD COLUMN IF NOT EXISTS credit_hold        BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS credit_hold_reason TEXT;

CREATE TABLE IF NOT EXISTS ar_notes (
  id             SERIAL PRIMARY KEY,
  customer_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL DEFAULT 'note',      -- note | call | email | promise | reminder | hold
  note           TEXT NOT NULL,
  promise_date   DATE,
  promise_amount NUMERIC(14,2),
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ar_notes_customer ON ar_notes (customer_id, created_at DESC);

-- ----------------------------------------------------------------- payables --
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS payment_terms_days INTEGER;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS default_account_id INTEGER REFERENCES gl_accounts(id);

CREATE TABLE IF NOT EXISTS ap_bills (
  id           SERIAL PRIMARY KEY,
  kind         TEXT NOT NULL DEFAULT 'bill',       -- bill | credit
  supplier_id  INTEGER NOT NULL REFERENCES suppliers(id),
  number       TEXT,                               -- the supplier's invoice / credit note number
  bill_date    DATE NOT NULL,
  due_date     DATE,
  memo         TEXT,
  gct_amount   NUMERIC(14,2) NOT NULL DEFAULT 0,    -- GCT on the bill (claimable input tax)
  total        NUMERIC(14,2) NOT NULL CHECK (total > 0),
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  voided_at    TIMESTAMPTZ,
  voided_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  void_reason  TEXT
);
CREATE INDEX IF NOT EXISTS idx_ap_bills_supplier ON ap_bills (supplier_id, bill_date DESC);
CREATE TABLE IF NOT EXISTS ap_bill_lines (
  id          SERIAL PRIMARY KEY,
  bill_id     INTEGER NOT NULL REFERENCES ap_bills(id) ON DELETE CASCADE,
  account_id  INTEGER NOT NULL REFERENCES gl_accounts(id),
  description TEXT,
  amount      NUMERIC(14,2) NOT NULL CHECK (amount > 0)
);

CREATE TABLE IF NOT EXISTS ap_payments (
  id             SERIAL PRIMARY KEY,
  supplier_id    INTEGER NOT NULL REFERENCES suppliers(id),
  pay_date       DATE NOT NULL,
  method         TEXT NOT NULL,                    -- cheque | transfer | cash | card
  account_id     INTEGER NOT NULL REFERENCES gl_accounts(id),   -- paid from
  cheque_number  TEXT,
  reference      TEXT,
  amount         NUMERIC(14,2) NOT NULL CHECK (amount >= 0),     -- 0 when credits cover the bills
  memo           TEXT,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  voided_at      TIMESTAMPTZ,
  voided_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  void_reason    TEXT
);
CREATE INDEX IF NOT EXISTS idx_ap_payments_supplier ON ap_payments (supplier_id, pay_date DESC);
CREATE TABLE IF NOT EXISTS ap_applications (
  id          SERIAL PRIMARY KEY,
  payment_id  INTEGER NOT NULL REFERENCES ap_payments(id) ON DELETE CASCADE,
  bill_kind   TEXT NOT NULL,                       -- receipt | po | bill | credit
  bill_id     INTEGER NOT NULL,
  amount      NUMERIC(14,2) NOT NULL CHECK (amount > 0)
);
CREATE INDEX IF NOT EXISTS idx_ap_app_bill ON ap_applications (bill_kind, bill_id);

-- ------------------------------------------------------------------ banking --
CREATE TABLE IF NOT EXISTS bank_txns (
  id             SERIAL PRIMARY KEY,
  kind           TEXT NOT NULL,                    -- expense | deposit | transfer
  account_id     INTEGER NOT NULL REFERENCES gl_accounts(id),   -- the bank / cash account
  txn_date       DATE NOT NULL,
  payee          TEXT,
  supplier_id    INTEGER REFERENCES suppliers(id),
  cheque_number  TEXT,
  reference      TEXT,
  memo           TEXT,
  amount         NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  voided_at      TIMESTAMPTZ,
  voided_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  void_reason    TEXT
);
CREATE INDEX IF NOT EXISTS idx_bank_txns_account ON bank_txns (account_id, txn_date DESC);
CREATE TABLE IF NOT EXISTS bank_txn_lines (
  id          SERIAL PRIMARY KEY,
  txn_id      INTEGER NOT NULL REFERENCES bank_txns(id) ON DELETE CASCADE,
  account_id  INTEGER NOT NULL REFERENCES gl_accounts(id),
  amount      NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  memo        TEXT,
  gl_line_id  BIGINT REFERENCES gl_lines(id)          -- a deposit: the undeposited item it banks
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_txn_lines_glline ON bank_txn_lines (gl_line_id) WHERE gl_line_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS bank_recons (
  id                SERIAL PRIMARY KEY,
  account_id        INTEGER NOT NULL REFERENCES gl_accounts(id),
  statement_date    DATE NOT NULL,
  statement_balance NUMERIC(14,2) NOT NULL,
  opening_balance   NUMERIC(14,2) NOT NULL,
  status            TEXT NOT NULL DEFAULT 'open',   -- open | done
  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  finished_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  finished_at       TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_recons_open ON bank_recons (account_id) WHERE status = 'open';
CREATE TABLE IF NOT EXISTS bank_cleared (
  gl_line_id  BIGINT PRIMARY KEY REFERENCES gl_lines(id),
  recon_id    INTEGER NOT NULL REFERENCES bank_recons(id) ON DELETE CASCADE,
  cleared_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  cleared_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bank_feed_lines (
  id           SERIAL PRIMARY KEY,
  account_id   INTEGER NOT NULL REFERENCES gl_accounts(id),
  import_ref   TEXT,
  txn_date     DATE NOT NULL,
  description  TEXT NOT NULL,
  amount       NUMERIC(14,2) NOT NULL,             -- + money in, - money out
  line_hash    TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'new',        -- new | matched | added | ignored
  gl_line_id   BIGINT REFERENCES gl_lines(id),
  bank_txn_id  INTEGER REFERENCES bank_txns(id),
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (account_id, line_hash)
);
CREATE TABLE IF NOT EXISTS bank_rules (
  id             SERIAL PRIMARY KEY,
  contains       TEXT NOT NULL,                    -- text in the statement description
  gl_account_id  INTEGER NOT NULL REFERENCES gl_accounts(id),
  payee          TEXT,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- Accounts the new screens need, and the usual expense accounts for a shop in Jamaica.
INSERT INTO gl_accounts (code, name, type, qb_name, qb_type, system_key) VALUES
  ('1160', 'GCT Recoverable (Input Tax)', 'asset',   'GCT Recoverable',             'OCASSET', 'gct_input'),
  ('6950', 'Bank Charges and Interest',   'expense', 'Bank Service Charges',        'EXP',     'bank_charges'),
  ('6960', 'Reconciliation Discrepancies','expense', 'Reconciliation Discrepancies','EXP',     'recon_diff')
ON CONFLICT (code) DO NOTHING;
INSERT INTO gl_accounts (code, name, type, qb_name, qb_type) VALUES
  ('6400', 'Rent',                                  'expense', 'Rent',                        'EXP'),
  ('6410', 'Electricity',                           'expense', 'Electricity',                 'EXP'),
  ('6420', 'Water',                                 'expense', 'Water',                       'EXP'),
  ('6430', 'Telephone and Internet',                'expense', 'Telephone and Internet',      'EXP'),
  ('6500', 'Salaries and Wages',                    'expense', 'Salaries and Wages',          'EXP'),
  ('6510', 'Statutory Contributions (NIS, NHT, Education Tax, HEART)', 'expense', 'Statutory Contributions', 'EXP'),
  ('6600', 'Repairs and Maintenance',               'expense', 'Repairs and Maintenance',     'EXP'),
  ('6700', 'Insurance',                             'expense', 'Insurance',                   'EXP'),
  ('6800', 'Professional Fees',                     'expense', 'Professional Fees',           'EXP'),
  ('6850', 'Fuel and Motor Vehicle',                'expense', 'Fuel and Motor Vehicle',      'EXP'),
  ('6870', 'Advertising and Promotion',             'expense', 'Advertising and Promotion',   'EXP'),
  ('6880', 'Office Supplies and Stationery',        'expense', 'Office Supplies',             'EXP'),
  ('6890', 'Security',                              'expense', 'Security',                    'EXP')
ON CONFLICT (code) DO NOTHING;

-- =============================================================================
--  Payroll (payroll.js) -- an optional module, OFF until switched on
--
--  Jamaican payroll: PAYE (income tax), NIS, NHT, Education Tax and HEART/NSTA,
--  approved pension, recurring earnings and deductions (loans, advances,
--  union dues, insurance), pay runs (weekly / fortnightly / monthly) built from
--  salaries or the time clock's approved timesheets, commission statements,
--  leave and public holidays; payslips, bank file, S01 monthly return and
--  remittance, S02 / P24 year end, P45 on leaving. Approved runs post to the
--  ledger (when it is started and the setting is on).
--
--  Statutory rates are effective-dated rows in payroll_rates: when the
--  government changes a rate or the tax-free threshold, add a row -- old pay
--  runs keep the rates they were worked out with (a copy is kept on the run).
-- =============================================================================
INSERT INTO warehouse_settings (key, value) VALUES
  ('payroll_module', 'off'),              -- on: the module is in use (screens, routes, posting)
  ('payroll_use_timeclock', 'on'),        -- hourly staff are paid from approved time clock weeks
  ('payroll_include_commission', 'on'),   -- approved commission statements are paid through payroll
  ('payroll_post_ledger', 'on'),          -- approved runs post to the general ledger
  ('payroll_self_service', 'on'),         -- staff see their own payslips
  ('payroll_two_person', 'off'),          -- on: the person who prepared a run cannot approve it
  ('payroll_heart', 'on'),                -- employer pays HEART/NSTA 3%
  ('payroll_vacation_days', '10'),        -- statutory: 2 weeks after 220 days worked in the year
  ('payroll_sick_days', '10'),            -- statutory: 10 days after 110 days worked
  ('payroll_employer_trn', ''),
  ('payroll_employer_nis', '')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS payroll_rates (
  id               SERIAL PRIMARY KEY,
  effective_from   DATE NOT NULL UNIQUE,              -- by pay date
  paye_threshold   NUMERIC(14,2) NOT NULL,            -- annual tax-free income
  paye_rate1       NUMERIC(6,4) NOT NULL DEFAULT 0.25,
  paye_band2_from  NUMERIC(14,2) NOT NULL DEFAULT 6000000,   -- annual statutory income taxed at rate 2 above this
  paye_rate2       NUMERIC(6,4) NOT NULL DEFAULT 0.30,
  nis_ee           NUMERIC(6,4) NOT NULL DEFAULT 0.03,
  nis_er           NUMERIC(6,4) NOT NULL DEFAULT 0.03,
  nis_ceiling      NUMERIC(14,2) NOT NULL DEFAULT 5000000,   -- annual insurable wage ceiling
  nht_ee           NUMERIC(6,4) NOT NULL DEFAULT 0.02,
  nht_er           NUMERIC(6,4) NOT NULL DEFAULT 0.03,
  ed_ee            NUMERIC(6,4) NOT NULL DEFAULT 0.0225,
  ed_er            NUMERIC(6,4) NOT NULL DEFAULT 0.035,
  heart_er         NUMERIC(6,4) NOT NULL DEFAULT 0.03,
  pension_cap      NUMERIC(6,4) NOT NULL DEFAULT 0.20,       -- approved pension deductible up to this share of pay
  min_wage_week    NUMERIC(10,2),                            -- national minimum wage per 40-hour week
  min_wage_hours   NUMERIC(5,2) NOT NULL DEFAULT 40,
  note             TEXT,
  updated_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);
INSERT INTO payroll_rates (effective_from, paye_threshold, min_wage_week, note) VALUES
  ('2026-04-01', 1902360, 16000, 'Threshold J$1,902,360 from 1 April 2026; minimum wage J$16,000 a 40-hour week. Check against TAJ / MLSS notices.'),
  ('2026-07-01', 1902360, 17000, 'Minimum wage J$17,000 a 40-hour week from 1 July 2026.')
ON CONFLICT (effective_from) DO NOTHING;

-- Earning and deduction types. Flags say which contributions an earning attracts.
CREATE TABLE IF NOT EXISTS payroll_items (
  code           TEXT PRIMARY KEY,
  label          TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('earning', 'deduction')),
  paye           BOOLEAN NOT NULL DEFAULT true,
  nis            BOOLEAN NOT NULL DEFAULT true,
  nht            BOOLEAN NOT NULL DEFAULT true,
  ed             BOOLEAN NOT NULL DEFAULT true,
  heart          BOOLEAN NOT NULL DEFAULT true,
  gl_account_id  INTEGER REFERENCES gl_accounts(id),       -- blank: wages (earnings) / deductions payable
  is_system      BOOLEAN NOT NULL DEFAULT false,           -- worked out by the system (cannot be removed)
  is_active      BOOLEAN NOT NULL DEFAULT true,
  sort           INTEGER NOT NULL DEFAULT 100
);
INSERT INTO payroll_items (code, label, kind, paye, nis, nht, ed, heart, is_system, sort) VALUES
  ('basic',          'Basic pay',                     'earning',   true,  true,  true,  true,  true,  true,  10),
  ('overtime',       'Overtime',                      'earning',   true,  true,  true,  true,  true,  true,  20),
  ('holiday_work',   'Public holiday worked (extra)', 'earning',   true,  true,  true,  true,  true,  true,  25),
  ('holiday_pay',    'Public holiday pay',            'earning',   true,  true,  true,  true,  true,  true,  26),
  ('vacation_pay',   'Vacation pay',                  'earning',   true,  true,  true,  true,  true,  true,  30),
  ('sick_pay',       'Sick pay',                      'earning',   true,  true,  true,  true,  true,  true,  31),
  ('unpaid_leave',   'Unpaid leave',                  'earning',   true,  true,  true,  true,  true,  true,  32),
  ('commission',     'Commission',                    'earning',   true,  true,  true,  true,  true,  true,  40),
  ('bonus',          'Bonus',                         'earning',   true,  true,  true,  true,  true,  false, 50),
  ('back_pay',       'Back pay / retroactive',        'earning',   true,  true,  true,  true,  true,  false, 55),
  ('travel_allow',   'Travelling allowance',          'earning',   true,  true,  true,  true,  true,  false, 60),
  ('meal_allow',     'Meal allowance',                'earning',   true,  true,  true,  true,  true,  false, 61),
  ('other_allow',    'Other allowance',               'earning',   true,  true,  true,  true,  true,  false, 62),
  ('reimbursement',  'Reimbursement (not pay)',       'earning',   false, false, false, false, false, false, 90),
  ('loan',           'Loan repayment',                'deduction', false, false, false, false, false, false, 110),
  ('advance',        'Salary advance recovered',      'deduction', false, false, false, false, false, false, 111),
  ('union_dues',     'Union dues',                    'deduction', false, false, false, false, false, false, 120),
  ('health_ins',     'Health insurance',              'deduction', false, false, false, false, false, false, 121),
  ('credit_union',   'Credit union / savings',        'deduction', false, false, false, false, false, false, 122),
  ('court_order',    'Court order / garnishment',     'deduction', false, false, false, false, false, false, 123),
  ('other_ded',      'Other deduction',               'deduction', false, false, false, false, false, false, 130)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS payroll_employees (
  id                  SERIAL PRIMARY KEY,
  user_id             INTEGER UNIQUE REFERENCES users(id) ON DELETE SET NULL,   -- blank: not a system user
  employee_no         TEXT,
  name                TEXT NOT NULL,
  email               TEXT,
  phone               TEXT,
  address             TEXT,
  trn                 TEXT,
  nis_no              TEXT,
  date_of_birth       DATE,
  hire_date           DATE,
  termination_date    DATE,
  termination_reason  TEXT,
  job_title           TEXT,
  department          TEXT,
  pay_type            TEXT NOT NULL DEFAULT 'salary' CHECK (pay_type IN ('salary', 'hourly')),
  frequency           TEXT NOT NULL DEFAULT 'monthly' CHECK (frequency IN ('weekly', 'fortnightly', 'monthly')),
  salary_annual       NUMERIC(14,2),
  hourly_rate         NUMERIC(10,2),
  ot_rate             NUMERIC(4,2) NOT NULL DEFAULT 1.5,
  hours_per_period    NUMERIC(6,2),            -- hourly staff not on the time clock
  hours_per_day       NUMERIC(4,2) NOT NULL DEFAULT 8,
  use_timeclock       BOOLEAN NOT NULL DEFAULT true,
  pay_method          TEXT NOT NULL DEFAULT 'bank' CHECK (pay_method IN ('bank', 'cheque', 'cash')),
  bank_name           TEXT,
  bank_branch         TEXT,
  bank_account        TEXT,
  bank_account_type   TEXT,
  pension_ee_pct      NUMERIC(6,3) NOT NULL DEFAULT 0,
  pension_er_pct      NUMERIC(6,3) NOT NULL DEFAULT 0,
  pension_scheme      TEXT,
  extra_threshold     NUMERIC(14,2) NOT NULL DEFAULT 0,    -- annual: e.g. a pensioner's extra allowance
  paye_exempt         BOOLEAN NOT NULL DEFAULT false,
  nis_exempt          BOOLEAN NOT NULL DEFAULT false,
  nht_exempt          BOOLEAN NOT NULL DEFAULT false,
  ed_exempt           BOOLEAN NOT NULL DEFAULT false,
  vacation_days       NUMERIC(5,2),            -- blank: the shop's setting
  sick_days           NUMERIC(5,2),
  is_active           BOOLEAN NOT NULL DEFAULT true,
  notes               TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Recurring earnings / deductions per person. A loan stops when its balance is paid.
CREATE TABLE IF NOT EXISTS payroll_employee_items (
  id           SERIAL PRIMARY KEY,
  employee_id  INTEGER NOT NULL REFERENCES payroll_employees(id) ON DELETE CASCADE,
  code         TEXT NOT NULL REFERENCES payroll_items(code),
  amount       NUMERIC(14,2) NOT NULL,           -- per pay period
  balance      NUMERIC(14,2),                    -- loans / advances: still owed
  note         TEXT,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payroll_emp_items ON payroll_employee_items (employee_id);

CREATE TABLE IF NOT EXISTS payroll_runs (
  id            SERIAL PRIMARY KEY,
  number        TEXT UNIQUE,                     -- PR-000001
  frequency     TEXT NOT NULL CHECK (frequency IN ('weekly', 'fortnightly', 'monthly')),
  period_start  DATE NOT NULL,
  period_end    DATE NOT NULL,
  pay_date      DATE NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'paid', 'void')),
  note          TEXT,
  rates         JSONB,                           -- the statutory rates used (copy)
  totals        JSONB,
  post_gl       BOOLEAN NOT NULL DEFAULT true,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  approved_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  approved_at   TIMESTAMPTZ,
  voided_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  voided_at     TIMESTAMPTZ,
  void_reason   TEXT
);
CREATE INDEX IF NOT EXISTS idx_payroll_runs_pay ON payroll_runs (pay_date);

CREATE TABLE IF NOT EXISTS payroll_slips (
  id             SERIAL PRIMARY KEY,
  run_id         INTEGER NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  employee_id    INTEGER NOT NULL REFERENCES payroll_employees(id),
  snapshot       JSONB NOT NULL,                 -- name, TRN, NIS no., title, pay type and rate as at the run
  lines          JSONB NOT NULL DEFAULT '[]',    -- [{code, label, kind, qty, rate, amount, source}]
  warnings       JSONB NOT NULL DEFAULT '[]',
  edited         BOOLEAN NOT NULL DEFAULT false, -- lines changed by hand: a recalculation keeps them
  gross          NUMERIC(14,2) NOT NULL DEFAULT 0,
  statutory      NUMERIC(14,2) NOT NULL DEFAULT 0,   -- statutory income (PAYE base after NIS and pension)
  nis_ee         NUMERIC(14,2) NOT NULL DEFAULT 0,
  nis_er         NUMERIC(14,2) NOT NULL DEFAULT 0,
  nht_ee         NUMERIC(14,2) NOT NULL DEFAULT 0,
  nht_er         NUMERIC(14,2) NOT NULL DEFAULT 0,
  ed_ee          NUMERIC(14,2) NOT NULL DEFAULT 0,
  ed_er          NUMERIC(14,2) NOT NULL DEFAULT 0,
  heart_er       NUMERIC(14,2) NOT NULL DEFAULT 0,
  paye           NUMERIC(14,2) NOT NULL DEFAULT 0,
  pension_ee     NUMERIC(14,2) NOT NULL DEFAULT 0,
  pension_er     NUMERIC(14,2) NOT NULL DEFAULT 0,
  other_ded      NUMERIC(14,2) NOT NULL DEFAULT 0,
  net            NUMERIC(14,2) NOT NULL DEFAULT 0,
  cheque_number  TEXT,
  commission_ids INTEGER[] NOT NULL DEFAULT '{}',    -- commission statements paid on this slip
  UNIQUE (run_id, employee_id)
);
CREATE INDEX IF NOT EXISTS idx_payroll_slips_emp ON payroll_slips (employee_id);

CREATE TABLE IF NOT EXISTS payroll_payments (
  id           SERIAL PRIMARY KEY,
  run_id       INTEGER NOT NULL REFERENCES payroll_runs(id),
  account_id   INTEGER NOT NULL REFERENCES gl_accounts(id),
  pay_date     DATE NOT NULL,
  per_person   BOOLEAN NOT NULL DEFAULT true,     -- one bank line per person (cheques) or one for the batch
  reference    TEXT,
  amount       NUMERIC(14,2) NOT NULL,
  post_gl      BOOLEAN NOT NULL DEFAULT true,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  voided_at    TIMESTAMPTZ,
  voided_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  void_reason  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_payroll_payment_live ON payroll_payments (run_id) WHERE voided_at IS NULL;

-- Statutory deductions paid to TAJ (S01, due the 14th of the next month).
CREATE TABLE IF NOT EXISTS payroll_remittances (
  id           SERIAL PRIMARY KEY,
  month        DATE NOT NULL,                     -- first day of the month remitted for
  paye         NUMERIC(14,2) NOT NULL DEFAULT 0,
  nis          NUMERIC(14,2) NOT NULL DEFAULT 0,
  nht          NUMERIC(14,2) NOT NULL DEFAULT 0,
  ed           NUMERIC(14,2) NOT NULL DEFAULT 0,
  heart        NUMERIC(14,2) NOT NULL DEFAULT 0,
  pension      NUMERIC(14,2) NOT NULL DEFAULT 0,  -- to the pension scheme (not TAJ), optional
  total        NUMERIC(14,2) NOT NULL,
  account_id   INTEGER NOT NULL REFERENCES gl_accounts(id),
  pay_date     DATE NOT NULL,
  reference    TEXT,
  post_gl      BOOLEAN NOT NULL DEFAULT true,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  voided_at    TIMESTAMPTZ,
  voided_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  void_reason  TEXT
);
CREATE INDEX IF NOT EXISTS idx_payroll_remit_month ON payroll_remittances (month);

ALTER TABLE commission_statements ADD COLUMN IF NOT EXISTS payroll_run_id INTEGER;

-- Ledger accounts for payroll.
INSERT INTO gl_accounts (code, name, type, qb_name, qb_type, system_key) VALUES
  ('1170', 'Staff Loans and Advances',          'asset',     'Staff Loans and Advances',  'OCASSET', 'staff_loans'),
  ('2310', 'Net Wages Payable',                 'liability', 'Net Wages Payable',         'OCLIAB',  'net_wages_payable'),
  ('2320', 'PAYE Income Tax Payable',           'liability', 'PAYE Payable',              'OCLIAB',  'paye_payable'),
  ('2330', 'NIS Payable',                       'liability', 'NIS Payable',               'OCLIAB',  'nis_payable'),
  ('2340', 'NHT Payable',                       'liability', 'NHT Payable',               'OCLIAB',  'nht_payable'),
  ('2350', 'Education Tax Payable',             'liability', 'Education Tax Payable',     'OCLIAB',  'edtax_payable'),
  ('2360', 'HEART/NSTA Payable',                'liability', 'HEART NSTA Payable',        'OCLIAB',  'heart_payable'),
  ('2370', 'Pension Contributions Payable',     'liability', 'Pension Payable',           'OCLIAB',  'pension_payable'),
  ('2380', 'Other Payroll Deductions Payable',  'liability', 'Payroll Deductions Payable','OCLIAB',  'payroll_deductions_payable'),
  ('6520', 'Employer Pension Contributions',    'expense',   'Employer Pension',          'EXP',     'pension_expense')
ON CONFLICT (code) DO NOTHING;
UPDATE gl_accounts SET system_key = 'wages' WHERE code = '6500' AND system_key IS NULL AND NOT EXISTS (SELECT 1 FROM gl_accounts WHERE system_key = 'wages');
UPDATE gl_accounts SET system_key = 'payroll_taxes' WHERE code = '6510' AND system_key IS NULL AND NOT EXISTS (SELECT 1 FROM gl_accounts WHERE system_key = 'payroll_taxes');
UPDATE payroll_items SET gl_account_id = (SELECT id FROM gl_accounts WHERE system_key = 'staff_loans') WHERE code IN ('loan', 'advance') AND gl_account_id IS NULL;

-- =============================================================================
--  Payroll (cont.) -- contractors, day workers, work / invoice pay, contracts,
--  loans and advances, third-party deductions, contractor levy, withholding tax
--
--  Worker types: employee (statutory deductions), day_worker (an employee paid
--  by the day: statutory deductions apply), contractor (self-employed: no PAYE,
--  NIS, NHT, Education Tax or HEART; contractor levy 2% on construction,
--  haulage and tillage work; withholding tax 3% on specified services when the
--  business is a withholding agent -- per invoice of J$50,000 or more, or
--  smaller invoices adding to J$100,000 in 30 days). Levy and WHT are paid to
--  TAJ by the 14th of the next month with the payroll deductions.
--  Pay by the work: payroll_work holds days worked, piece work, hours and
--  invoices; a pay run picks up everything not yet paid up to its end date.
-- =============================================================================
ALTER TABLE payroll_employees ADD COLUMN IF NOT EXISTS worker_type     TEXT NOT NULL DEFAULT 'employee';
ALTER TABLE payroll_employees ADD COLUMN IF NOT EXISTS day_rate        NUMERIC(12,2);
ALTER TABLE payroll_employees ADD COLUMN IF NOT EXISTS fee_per_period  NUMERIC(14,2);    -- contractor retainer each pay
ALTER TABLE payroll_employees ADD COLUMN IF NOT EXISTS business_name   TEXT;
ALTER TABLE payroll_employees ADD COLUMN IF NOT EXISTS tcc_no          TEXT;             -- tax compliance certificate
ALTER TABLE payroll_employees ADD COLUMN IF NOT EXISTS tcc_expiry      DATE;
ALTER TABLE payroll_employees ADD COLUMN IF NOT EXISTS levy_applies    BOOLEAN NOT NULL DEFAULT false;   -- construction / haulage / tillage
ALTER TABLE payroll_employees ADD COLUMN IF NOT EXISTS wht_applies     BOOLEAN NOT NULL DEFAULT false;   -- a specified service
DO $$ BEGIN
  ALTER TABLE payroll_employees DROP CONSTRAINT IF EXISTS payroll_employees_pay_type_check;
  ALTER TABLE payroll_employees ADD CONSTRAINT payroll_employees_pay_type_check CHECK (pay_type IN ('salary', 'hourly', 'daily', 'piece', 'contract'));
  ALTER TABLE payroll_employees DROP CONSTRAINT IF EXISTS payroll_employees_worker_type_check;
  ALTER TABLE payroll_employees ADD CONSTRAINT payroll_employees_worker_type_check CHECK (worker_type IN ('employee', 'day_worker', 'contractor'));
END $$;

ALTER TABLE payroll_employee_items ADD COLUMN IF NOT EXISTS payee      TEXT;   -- who the deduction is paid to (court, insurer, union...)
ALTER TABLE payroll_employee_items ADD COLUMN IF NOT EXISTS reference  TEXT;   -- policy / order / account number
ALTER TABLE payroll_employee_items ADD COLUMN IF NOT EXISTS end_date   DATE;   -- stops after this date

ALTER TABLE payroll_slips ADD COLUMN IF NOT EXISTS levy NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE payroll_slips ADD COLUMN IF NOT EXISTS wht  NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE payroll_remittances ADD COLUMN IF NOT EXISTS levy NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE payroll_remittances ADD COLUMN IF NOT EXISTS wht  NUMERIC(14,2) NOT NULL DEFAULT 0;

ALTER TABLE payroll_rates ADD COLUMN IF NOT EXISTS levy_rate      NUMERIC(6,4)  NOT NULL DEFAULT 0.02;
ALTER TABLE payroll_rates ADD COLUMN IF NOT EXISTS wht_rate       NUMERIC(6,4)  NOT NULL DEFAULT 0.03;
ALTER TABLE payroll_rates ADD COLUMN IF NOT EXISTS wht_threshold  NUMERIC(14,2) NOT NULL DEFAULT 50000;    -- per invoice
ALTER TABLE payroll_rates ADD COLUMN IF NOT EXISTS wht_aggregate  NUMERIC(14,2) NOT NULL DEFAULT 100000;   -- smaller invoices in 30 days

INSERT INTO warehouse_settings (key, value) VALUES
  ('payroll_wht_agent', 'off')            -- on: the business is a withholding agent for specified services
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS payroll_contracts (
  id           SERIAL PRIMARY KEY,
  employee_id  INTEGER NOT NULL REFERENCES payroll_employees(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  value        NUMERIC(14,2),                    -- agreed price (blank: open-ended)
  start_date   DATE,
  end_date     DATE,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  notes        TEXT,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Work to be paid: days, piece work, extra hours, invoices / contract stages.
CREATE TABLE IF NOT EXISTS payroll_work (
  id           SERIAL PRIMARY KEY,
  employee_id  INTEGER NOT NULL REFERENCES payroll_employees(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('days', 'piece', 'hours', 'invoice')),
  work_date    DATE NOT NULL,
  description  TEXT NOT NULL,
  qty          NUMERIC(12,2) NOT NULL DEFAULT 1,
  rate         NUMERIC(14,2) NOT NULL DEFAULT 0,
  amount       NUMERIC(14,2) NOT NULL,
  invoice_no   TEXT,
  contract_id  INTEGER REFERENCES payroll_contracts(id) ON DELETE SET NULL,
  slip_id      INTEGER REFERENCES payroll_slips(id) ON DELETE SET NULL,   -- the payslip paying it
  wht          NUMERIC(14,2) NOT NULL DEFAULT 0,                         -- withholding tax taken on it
  voided_at    TIMESTAMPTZ,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payroll_work_emp ON payroll_work (employee_id, work_date);

-- Loans and salary advances handed out (repaid through payroll_employee_items).
CREATE TABLE IF NOT EXISTS payroll_loans (
  id           SERIAL PRIMARY KEY,
  employee_id  INTEGER NOT NULL REFERENCES payroll_employees(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('loan', 'advance')),
  amount       NUMERIC(14,2) NOT NULL,
  issue_date   DATE NOT NULL,
  method       TEXT NOT NULL CHECK (method IN ('bank', 'payslip')),   -- paid out now from an account, or on the next payslip
  account_id   INTEGER REFERENCES gl_accounts(id),
  item_id      INTEGER REFERENCES payroll_employee_items(id) ON DELETE SET NULL,
  slip_id      INTEGER REFERENCES payroll_slips(id) ON DELETE SET NULL,
  reference    TEXT,
  note         TEXT,
  post_gl      BOOLEAN NOT NULL DEFAULT true,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  voided_at    TIMESTAMPTZ,
  voided_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  void_reason  TEXT
);

-- Deductions paid over to whoever they are for (insurer, union, court, credit union, NHT, SLB...).
CREATE TABLE IF NOT EXISTS payroll_ded_payments (
  id           SERIAL PRIMARY KEY,
  month        DATE NOT NULL,
  code         TEXT NOT NULL REFERENCES payroll_items(code),
  payee        TEXT NOT NULL,
  amount       NUMERIC(14,2) NOT NULL,
  account_id   INTEGER NOT NULL REFERENCES gl_accounts(id),
  pay_date     DATE NOT NULL,
  reference    TEXT,
  post_gl      BOOLEAN NOT NULL DEFAULT true,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  voided_at    TIMESTAMPTZ,
  voided_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  void_reason  TEXT
);

UPDATE payroll_items SET label = 'Medical / health insurance' WHERE code = 'health_ins' AND label = 'Health insurance';
INSERT INTO payroll_items (code, label, kind, paye, nis, nht, ed, heart, is_system, sort) VALUES
  ('day_work',        'Days worked',                         'earning',   true,  true,  true,  true,  true,  true,  12),
  ('piece_work',      'Piece / job work',                    'earning',   true,  true,  true,  true,  true,  true,  14),
  ('extra_hours',     'Extra hours',                         'earning',   true,  true,  true,  true,  true,  true,  16),
  ('contract_work',   'Contract work / invoice',             'earning',   true,  true,  true,  true,  true,  true,  17),
  ('advance_paid',    'Loan / advance paid out (not pay)',   'earning',   false, false, false, false, false, true,  95),
  ('gratuity',        'Gratuity / honorarium',               'earning',   true,  true,  true,  true,  true,  false, 56),
  ('redundancy',      'Redundancy / severance (check tax)',  'earning',   false, false, false, false, false, false, 57),
  ('salary_deduction','Salary deduction (agreed in writing)','deduction', false, false, false, false, false, false, 112),
  ('child_maint',     'Child maintenance (court order)',     'deduction', false, false, false, false, false, false, 124),
  ('life_ins',        'Life insurance',                      'deduction', false, false, false, false, false, false, 125),
  ('pension_avc',     'Extra pension (voluntary)',           'deduction', false, false, false, false, false, false, 126),
  ('nht_mortgage',    'NHT mortgage repayment',              'deduction', false, false, false, false, false, false, 127),
  ('slb_loan',        'Student Loan Bureau',                 'deduction', false, false, false, false, false, false, 128),
  ('staff_purchase',  'Staff purchase',                      'deduction', false, false, false, false, false, false, 129),
  ('cash_shortage',   'Cash shortage (agreed in writing)',   'deduction', false, false, false, false, false, false, 131),
  ('uniform',         'Uniform / tools',                     'deduction', false, false, false, false, false, false, 132)
ON CONFLICT (code) DO NOTHING;

INSERT INTO gl_accounts (code, name, type, qb_name, qb_type, system_key) VALUES
  ('2390', 'Contractor Levy Payable',  'liability', 'Contractor Levy Payable',  'OCLIAB', 'contractor_levy_payable'),
  ('2395', 'Withholding Tax Payable',  'liability', 'Withholding Tax Payable',  'OCLIAB', 'wht_payable'),
  ('6530', 'Contract Labour',          'expense',   'Contract Labour',          'EXP',    'contract_labour')
ON CONFLICT (code) DO NOTHING;
UPDATE payroll_items SET gl_account_id = (SELECT id FROM gl_accounts WHERE system_key = 'staff_loans') WHERE code = 'advance_paid' AND gl_account_id IS NULL;

-- =============================================================================
--  Payroll (cont.) -- employer contributions to insurance, pensions and other
--  benefits, and percentage-of-pay items
--
--  payroll_items.kind 'employer': paid by the business for the person (group
--  health, group life, extra pension, other). Not cash in hand: it does not
--  change gross or net pay. Its PAYE / NIS / NHT / Ed / HEART ticks make it a
--  taxable benefit (added to those bases) -- off by default; tick on advice.
--  pension_relief: an employee deduction that counts toward the approved
--  pension relief (with the employee pension %, up to the cap).
--  payroll_employee_items.pct: the item is a percentage of the person's pay
--  (pensionable / taxable pay) instead of a fixed amount.
-- =============================================================================
DO $$ BEGIN
  ALTER TABLE payroll_items DROP CONSTRAINT IF EXISTS payroll_items_kind_check;
  ALTER TABLE payroll_items ADD CONSTRAINT payroll_items_kind_check CHECK (kind IN ('earning', 'deduction', 'employer'));
END $$;
ALTER TABLE payroll_items ADD COLUMN IF NOT EXISTS pension_relief BOOLEAN NOT NULL DEFAULT false;
UPDATE payroll_items SET pension_relief = true WHERE code = 'pension_avc';
UPDATE payroll_items SET label = 'Extra pension (voluntary, approved scheme)' WHERE code = 'pension_avc' AND label = 'Extra pension (voluntary)';
ALTER TABLE payroll_employee_items ADD COLUMN IF NOT EXISTS pct NUMERIC(6,3);
ALTER TABLE payroll_slips ADD COLUMN IF NOT EXISTS er_benefits      NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE payroll_slips ADD COLUMN IF NOT EXISTS taxable_benefits NUMERIC(14,2) NOT NULL DEFAULT 0;

INSERT INTO payroll_items (code, label, kind, paye, nis, nht, ed, heart, is_system, sort) VALUES
  ('er_health',  'Health insurance (employer share)',        'employer', false, false, false, false, false, false, 200),
  ('er_life',    'Group life insurance (employer)',          'employer', false, false, false, false, false, false, 201),
  ('er_pension', 'Pension (extra employer contribution)',    'employer', false, false, false, false, false, false, 202),
  ('er_dental',  'Dental / vision (employer share)',         'employer', false, false, false, false, false, false, 203),
  ('er_other',   'Other employer contribution',              'employer', false, false, false, false, false, false, 209),
  ('life_ins_ee','Group life insurance (employee share)',    'deduction', false, false, false, false, false, false, 125),
  ('pension_ee2','Pension (second scheme, employee)',        'deduction', false, false, false, false, false, false, 126)
ON CONFLICT (code) DO NOTHING;
UPDATE payroll_items SET pension_relief = true WHERE code = 'pension_ee2';

INSERT INTO gl_accounts (code, name, type, qb_name, qb_type, system_key) VALUES
  ('6540', 'Employee Benefits (Insurance)', 'expense', 'Employee Benefits', 'EXP', 'benefits_expense')
ON CONFLICT (code) DO NOTHING;

-- =============================================================================
--  DEPARTMENT STORE (Phase 3, 2026-10): store locations containing departments.
--
--  The business already has DEPARTMENTS (terminal.js): a department is a set of
--  product categories, with staff (user_departments) and tills
--  (station_departments) assigned, and an optional "sell only your department"
--  rule. This migration adds the layer ABOVE departments -- physical STORE
--  LOCATIONS (branches) -- plus Supermarket and Wholesale departments, per
--  location stock on hand, and stock transfers between locations.
--
--  Everything is additive and defaults to one "Main Store" so the existing
--  single-till setup is unchanged: existing departments and tills move under
--  Main, and Main's stock mirrors products.stock_count. New locations start
--  empty and receive stock by transfer.
-- =============================================================================

-- --- Store locations (branches) ---------------------------------------------
CREATE TABLE IF NOT EXISTS store_locations (
  id          SERIAL PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'store'
                CHECK (kind IN ('store','supermarket','wholesale','warehouse','branch')),
  address     TEXT,
  phone       TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  is_default  BOOLEAN NOT NULL DEFAULT false,
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Seed the Main Store as the default location (only when none exist yet).
INSERT INTO store_locations (code, name, kind, is_default, sort)
  SELECT 'MAIN', 'Main Store', 'store', true, 0
  WHERE NOT EXISTS (SELECT 1 FROM store_locations);

-- Guarantee exactly one default location.
UPDATE store_locations SET is_default = true
  WHERE id = (SELECT id FROM store_locations ORDER BY sort, id LIMIT 1)
  AND NOT EXISTS (SELECT 1 FROM store_locations WHERE is_default);

-- --- Departments: place each under a location, add kind + sort --------------
ALTER TABLE departments ADD COLUMN IF NOT EXISTS location_id INTEGER REFERENCES store_locations(id) ON DELETE CASCADE;
ALTER TABLE departments ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'parts';
ALTER TABLE departments ADD COLUMN IF NOT EXISTS sort INTEGER NOT NULL DEFAULT 0;

UPDATE departments SET location_id = (SELECT id FROM store_locations WHERE is_default LIMIT 1)
  WHERE location_id IS NULL;

-- Department codes were globally unique; make them unique per location instead,
-- so two branches can each have a "Supermarket" department.
DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint
    WHERE conrelid = 'departments'::regclass AND contype = 'u'
      AND pg_get_constraintdef(oid) ILIKE '%(code)%';
  IF c IS NOT NULL THEN EXECUTE 'ALTER TABLE departments DROP CONSTRAINT ' || quote_ident(c); END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_departments_loc_code ON departments (location_id, code);

-- Supermarket and Wholesale departments under the default store (once).
INSERT INTO departments (code, name, categories, kind, location_id, sort)
  SELECT v.code, v.name, '{}'::text[], v.kind,
         (SELECT id FROM store_locations WHERE is_default LIMIT 1), v.sort
    FROM (VALUES ('SUPERMARKET', 'Supermarket', 'supermarket', 90),
                 ('WHOLESALE',   'Wholesale',   'wholesale',   91)) AS v(code, name, kind, sort)
   WHERE NOT EXISTS (SELECT 1 FROM departments d WHERE d.code = v.code);

-- --- Tills belong to a location ---------------------------------------------
ALTER TABLE pos_stations ADD COLUMN IF NOT EXISTS location_id INTEGER REFERENCES store_locations(id) ON DELETE SET NULL;
UPDATE pos_stations SET location_id = (SELECT id FROM store_locations WHERE is_default LIMIT 1)
  WHERE location_id IS NULL;

-- --- Per-location stock on hand ---------------------------------------------
CREATE TABLE IF NOT EXISTS location_stock (
  product_img TEXT    NOT NULL REFERENCES products(img) ON DELETE CASCADE ON UPDATE CASCADE,
  location_id INTEGER NOT NULL REFERENCES store_locations(id) ON DELETE CASCADE,
  qty         INTEGER NOT NULL DEFAULT 0 CHECK (qty >= 0),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (product_img, location_id)
);
CREATE INDEX IF NOT EXISTS idx_location_stock_loc ON location_stock (location_id);

-- (The default store's stock is derived -- see Phase 3b below; it is not seeded.)

-- --- Sales location attribution (set by the POS later; NULL = default store) -
ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS location_id INTEGER REFERENCES store_locations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_pos_sales_location ON pos_sales (location_id, created_at);

-- --- Stock transfers between locations --------------------------------------
CREATE SEQUENCE IF NOT EXISTS stock_transfer_seq START 1;
CREATE TABLE IF NOT EXISTS stock_transfers (
  id               SERIAL PRIMARY KEY,
  number           TEXT UNIQUE,                       -- TRF-000012
  from_location_id INTEGER NOT NULL REFERENCES store_locations(id),
  to_location_id   INTEGER NOT NULL REFERENCES store_locations(id),
  status           TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','cancelled')),
  note             TEXT,
  created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  posted_at        TIMESTAMPTZ,
  posted_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  CHECK (from_location_id <> to_location_id)
);
CREATE INDEX IF NOT EXISTS idx_stock_transfers_status ON stock_transfers (status, created_at DESC);
CREATE TABLE IF NOT EXISTS stock_transfer_lines (
  id          SERIAL PRIMARY KEY,
  transfer_id INTEGER NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
  product_img TEXT NOT NULL,
  description TEXT,
  qty         INTEGER NOT NULL CHECK (qty > 0)
);
CREATE INDEX IF NOT EXISTS idx_stock_transfer_lines_t ON stock_transfer_lines (transfer_id);

INSERT INTO warehouse_settings (key, value) VALUES
  ('deptstore_enabled', 'on')          -- show the department-store hub
ON CONFLICT (key) DO NOTHING;

-- Refresh planner statistics for products after migrations. Newly added filter
-- columns (discontinued, superseded_by, variant_of) otherwise have NO stats, which
-- made the reorder query (inbound.js) mis-plan into a ~49-minute nested loop.
ANALYZE products;

-- =============================================================================
--  DEPARTMENT STORE (Phase 3b, 2026-10): location-aware POS stock.
--
--  Residual model: each BRANCH keeps an explicit quantity in location_stock;
--  the DEFAULT store's quantity is derived as products.stock_count minus all
--  branch quantities. Receiving, counts and adjustments keep moving the total,
--  so the main store stays right without changes to those paths.
--
--  The POS tags a sale / void / return transaction with its store via
--  set_config('vision.location_id', <id>, true). When products.stock_count moves
--  inside such a transaction and the store is a branch, the trigger applies the
--  same delta to that branch's row. Untagged moves (or main-store moves) touch
--  only the total, i.e. the main store.
-- =============================================================================

-- The default store's rows are now derived, never stored.
DELETE FROM location_stock
 WHERE location_id IN (SELECT id FROM store_locations WHERE is_default);

-- Effective on-hand per (product, store): explicit branch rows + derived main.
CREATE OR REPLACE VIEW location_stock_v AS
  SELECT ls.product_img, ls.location_id, ls.qty
    FROM location_stock ls
    JOIN store_locations l ON l.id = ls.location_id AND NOT l.is_default
  UNION ALL
  SELECT p.img AS product_img, d.id AS location_id,
         GREATEST(0, COALESCE(p.stock_count, 0) - COALESCE(b.q, 0))::int AS qty
    FROM products p
   CROSS JOIN (SELECT id FROM store_locations WHERE is_default ORDER BY sort, id LIMIT 1) d
    LEFT JOIN (SELECT x.product_img, SUM(x.qty) AS q
                 FROM location_stock x
                 JOIN store_locations xl ON xl.id = x.location_id AND NOT xl.is_default
                GROUP BY x.product_img) b ON b.product_img = p.img;

CREATE OR REPLACE FUNCTION products_location_delta() RETURNS trigger AS $$
DECLARE
  loc INTEGER;
  d   INTEGER;
BEGIN
  IF NEW.stock_count IS NOT DISTINCT FROM OLD.stock_count THEN RETURN NEW; END IF;
  loc := NULLIF(current_setting('vision.location_id', true), '')::int;
  IF loc IS NULL THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM store_locations WHERE id = loc AND is_default) THEN RETURN NEW; END IF;
  d := COALESCE(NEW.stock_count, 0) - COALESCE(OLD.stock_count, 0);
  INSERT INTO location_stock (product_img, location_id, qty)
       VALUES (NEW.img, loc, GREATEST(0, d))
  ON CONFLICT (product_img, location_id)
       DO UPDATE SET qty = GREATEST(0, location_stock.qty + d), updated_at = NOW();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_products_location_delta ON products;
CREATE TRIGGER trg_products_location_delta
  AFTER UPDATE OF stock_count ON products
  FOR EACH ROW EXECUTE FUNCTION products_location_delta();

-- =============================================================================
--  DEPARTMENT STORE (Phase 3c, 2026-10): GENERAL department + default till.
--
--  GENERAL is a mode, not a category set: owners and managers working in it
--  sell from every department as one stock and choose which cashier collects
--  (terminal.js deptChoice, cashier.js /api/admin/pos/order collect_station_id).
--  It has no categories and is left out of the department roll-ups.
--
--  cash_auto_open: the POS opens its till's shift as soon as it loads.
--  cash_default_float: J$ float that auto-opened shift starts with.
--  (cash_default_station_id is written on first use by cashier.js.)
-- =============================================================================
INSERT INTO departments (code, name, categories, kind, location_id, sort)
  SELECT 'GENERAL', 'General', '{}'::text[], 'general',
         (SELECT id FROM store_locations WHERE is_default ORDER BY sort, id LIMIT 1), 0
   WHERE NOT EXISTS (SELECT 1 FROM departments WHERE code = 'GENERAL');

INSERT INTO warehouse_settings (key, value) VALUES
  ('cash_auto_open', 'on'),
  ('cash_default_float', '0')
ON CONFLICT (key) DO NOTHING;

-- =============================================================================
--  DEPARTMENT STORE (Phase 3e, 2026-10): the Auto Parts department.
--
--  The shop's whole catalogue is auto parts, but no department held it, so
--  every part fell into "Unassigned" and the POS department list had no Auto
--  Parts. Created once, owning every product category not already claimed by
--  another department (Supermarket / Wholesale start empty). Categories added
--  later are assigned on the Departments screen.
-- =============================================================================
INSERT INTO departments (code, name, categories, kind, location_id, sort)
  SELECT 'AUTOPARTS', 'Auto Parts',
         COALESCE((SELECT array_agg(c ORDER BY c) FROM (
                     SELECT DISTINCT lower(trim(p.category)) AS c FROM products p
                      WHERE COALESCE(trim(p.category), '') <> ''
                        AND lower(trim(p.category)) NOT IN (
                              SELECT unnest(d.categories) FROM departments d WHERE d.kind <> 'general')) t), '{}'::text[]),
         'parts', (SELECT id FROM store_locations WHERE is_default ORDER BY sort, id LIMIT 1), 10
   WHERE NOT EXISTS (SELECT 1 FROM departments WHERE code = 'AUTOPARTS');

-- =============================================================================
--  CHART OF ACCOUNTS: sub-accounts (2026-10).
--  A sub-account hangs off a parent account (parent_id). Its code is the
--  parent's code + "-" + a 1-4 digit number (6400-1, 6400-0012), its type is
--  the parent's, and its QuickBooks name is Parent:Child. Sub-accounts can
--  have sub-accounts. A parent with sub-accounts keeps its code and type.
-- =============================================================================
ALTER TABLE gl_accounts ADD COLUMN IF NOT EXISTS parent_id INTEGER REFERENCES gl_accounts(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_gl_accounts_parent ON gl_accounts (parent_id);

-- =============================================================================
--  CATEGORIES AND CLASSES, QuickBooks style (gl.js, books.js, billing.js, 2026-10)
--
--  A "category" is an account in the chart (sub-accounts for detail), as in
--  QuickBooks, so the IIF export needs nothing new for it. What this adds:
--    products     their own income / cost account, before their category's rule
--    customers    a default income category and class for new invoice lines
--    suppliers    a default class (they already have a default account)
--    classes      QuickBooks classes: one per store location (kept in step by a
--                 trigger) plus custom ones; every ledger line can carry one
--    bank rules   one account (as before) or a split across several categories
--  The product-category posting rules are filled with the current defaults
--  (Sales / Cost of sales) for every category, so the Posting rules screen
--  lists them ready to change; a rule already set is left alone.
-- =============================================================================
CREATE TABLE IF NOT EXISTS gl_classes (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  location_id INTEGER UNIQUE REFERENCES store_locations(id) ON DELETE SET NULL,   -- NULL: a custom class
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
INSERT INTO gl_classes (name, location_id)
  SELECT sl.name, sl.id FROM store_locations sl
   WHERE NOT EXISTS (SELECT 1 FROM gl_classes c WHERE c.location_id = sl.id)
     AND NOT EXISTS (SELECT 1 FROM gl_classes c WHERE lower(c.name) = lower(sl.name))
ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION gl_class_for_location() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM gl_classes WHERE location_id = NEW.id) THEN
    INSERT INTO gl_classes (name, location_id)
      VALUES (CASE WHEN EXISTS (SELECT 1 FROM gl_classes WHERE lower(name) = lower(NEW.name)) THEN NEW.name || ' (' || NEW.code || ')' ELSE NEW.name END, NEW.id)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS store_locations_class ON store_locations;
CREATE TRIGGER store_locations_class AFTER INSERT ON store_locations FOR EACH ROW EXECUTE FUNCTION gl_class_for_location();

ALTER TABLE gl_lines         ADD COLUMN IF NOT EXISTS class_id INTEGER REFERENCES gl_classes(id);
ALTER TABLE ap_bill_lines    ADD COLUMN IF NOT EXISTS class_id INTEGER REFERENCES gl_classes(id);
ALTER TABLE ar_invoice_lines ADD COLUMN IF NOT EXISTS class_id INTEGER REFERENCES gl_classes(id);
ALTER TABLE bank_txn_lines   ADD COLUMN IF NOT EXISTS class_id INTEGER REFERENCES gl_classes(id);
CREATE INDEX IF NOT EXISTS idx_gl_lines_class ON gl_lines (class_id) WHERE class_id IS NOT NULL;

ALTER TABLE users     ADD COLUMN IF NOT EXISTS default_income_account_id INTEGER REFERENCES gl_accounts(id);
ALTER TABLE users     ADD COLUMN IF NOT EXISTS default_class_id          INTEGER REFERENCES gl_classes(id);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS default_class_id          INTEGER REFERENCES gl_classes(id);
ALTER TABLE products  ADD COLUMN IF NOT EXISTS income_account_id         INTEGER REFERENCES gl_accounts(id);
ALTER TABLE products  ADD COLUMN IF NOT EXISTS cogs_account_id           INTEGER REFERENCES gl_accounts(id);

ALTER TABLE bank_rules ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'single';   -- single | split
CREATE TABLE IF NOT EXISTS bank_rule_splits (
  id         SERIAL PRIMARY KEY,
  rule_id    INTEGER NOT NULL REFERENCES bank_rules(id) ON DELETE CASCADE,
  sort       INTEGER NOT NULL DEFAULT 0,
  account_id INTEGER NOT NULL REFERENCES gl_accounts(id),
  class_id   INTEGER REFERENCES gl_classes(id),
  kind       TEXT NOT NULL CHECK (kind IN ('amount', 'percent', 'rest')),   -- rest: whatever the others leave
  value      NUMERIC(14,4),
  memo       TEXT
);
CREATE INDEX IF NOT EXISTS idx_bank_rule_splits_rule ON bank_rule_splits (rule_id, sort);

INSERT INTO gl_map (kind, key, account_id)
  SELECT k.kind, k.key, a.id
    FROM (SELECT DISTINCT 'revenue_category' AS kind, lower(category) AS key, 'sales' AS sk FROM products WHERE COALESCE(category, '') <> ''
          UNION SELECT DISTINCT 'cogs_category', lower(category), 'cogs' FROM products WHERE COALESCE(category, '') <> '') k
    JOIN gl_accounts a ON a.system_key = k.sk
ON CONFLICT (kind, key) DO NOTHING;

-- =============================================================================
--  RECEIVE STOCK WITH THE SUPPLIER'S BILL (server.js /api/admin/receive-stock, 2026-10)
--
--  One screen receives a delivery (against a PO or without one) and, when the
--  bill came with it, records that bill in Payables in the same step: Dr Goods
--  Received Not Invoiced for what arrived, Dr GCT Recoverable, Dr Freight and
--  Duty In, Cr Accounts Payable. When the bill's subtotal and the value received
--  differ, staff say why and the difference goes to: back order (stays in Goods
--  Received Not Invoiced until the rest arrives; with no PO a back-order PO is
--  opened), bill adjustment (Purchase Price Variance), supplier credit due
--  (Supplier Claims Receivable) or another account with a reason. ap_bills.po_id
--  ties the bill to its PO; such a PO is not also billed through its own invoice
--  total (that would count it twice in Payables).
--  A bill line may now be negative (a price adjustment in our favour); every
--  other screen still enters positive lines.
-- =============================================================================
INSERT INTO gl_accounts (code, name, type, qb_name, qb_type, system_key) VALUES
  ('5060', 'Freight and Duty In', 'cogs', 'Freight and Duty In', 'COGS', 'freight_in')
ON CONFLICT DO NOTHING;
ALTER TABLE ap_bills ADD COLUMN IF NOT EXISTS po_id           INTEGER REFERENCES purchase_orders(id);
ALTER TABLE ap_bills ADD COLUMN IF NOT EXISTS variance_kind   TEXT;            -- rounding | back_order | adjustment | credit | other
ALTER TABLE ap_bills ADD COLUMN IF NOT EXISTS variance_amount NUMERIC(14,2);   -- bill subtotal less the value received
ALTER TABLE ap_bills ADD COLUMN IF NOT EXISTS variance_reason TEXT;
CREATE INDEX IF NOT EXISTS idx_ap_bills_po ON ap_bills (po_id) WHERE po_id IS NOT NULL;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ap_bill_lines_amount_check') THEN
    ALTER TABLE ap_bill_lines DROP CONSTRAINT ap_bill_lines_amount_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ap_bill_lines_amount_nonzero') THEN
    ALTER TABLE ap_bill_lines ADD CONSTRAINT ap_bill_lines_amount_nonzero CHECK (amount <> 0);
  END IF;
END $$;


-- =============================================================================
--  POS ADD-ONS ON THE TILL: warranty claims, redeemable instruments, terminal
--  presence, and the ledger accounts petty cash and redeemables post to.
--  (Ported from the D1 backend: functions/_routes/warranty.js, redemptions.js,
--  admin_misc.js presence; migrations 0056, 0057. Routes in posaddons.js; the
--  petty cash tables themselves are further up, under PETTY CASH.)
--
--  Warranty   the register is a read model over pos_sale_items.warranty_until
--             (the till has no product_serials table: a line's serial_number
--             is the unit). Claims are their own small workflow; a refund or a
--             replacement still goes through the ordinary return / sale, which
--             post to the ledger, so a claim posts nothing itself.
--  Redeemables lottery / scratch cards sold as agent for the operator (the
--             owner's decision, 2026-10-20): the sale line is money held for
--             the operator (2160), not our income, and carries no cost of
--             sales; a winning card paid out of the drawer reduces that
--             liability. Our commission arrives when the operator settles.
--  Presence   one heartbeat row per admin browser (terminal_id from its
--             localStorage); a row counts as online for ~2.5 min.
-- =============================================================================
CREATE TABLE IF NOT EXISTS warranty_claims (
  id                  SERIAL PRIMARY KEY,
  product_img         TEXT,
  serial              TEXT,
  serial_id           INTEGER,                       -- D1 product_serials id; unused on the till
  sale_id             INTEGER REFERENCES pos_sales(id) ON DELETE SET NULL,
  sale_item_id        INTEGER REFERENCES pos_sale_items(id) ON DELETE SET NULL,
  customer_name       TEXT,
  customer_phone      TEXT,
  fault               TEXT,
  status              TEXT NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open', 'repair', 'replace', 'refund', 'denied', 'closed')),
  resolution_note     TEXT,
  return_id           INTEGER,
  replacement_sale_id INTEGER,
  opened_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  opened_at           TIMESTAMPTZ DEFAULT NOW(),
  resolved_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolved_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_warranty_claims_item ON warranty_claims (sale_item_id);
CREATE INDEX IF NOT EXISTS idx_warranty_claims_status ON warranty_claims (status, opened_at);
CREATE INDEX IF NOT EXISTS idx_pos_sale_items_warranty ON pos_sale_items (warranty_until) WHERE warranty_until IS NOT NULL;

ALTER TABLE products ADD COLUMN IF NOT EXISTS is_redeemable BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS redemption_instruments (
  id               SERIAL PRIMARY KEY,
  code             TEXT NOT NULL UNIQUE,
  product_img      TEXT NOT NULL,
  sale_id          INTEGER REFERENCES pos_sales(id) ON DELETE SET NULL,
  sale_item_id     INTEGER REFERENCES pos_sale_items(id) ON DELETE SET NULL,
  status           TEXT NOT NULL DEFAULT 'sold' CHECK (status IN ('in_stock', 'sold', 'redeemed', 'void')),
  face_value_cents BIGINT NOT NULL DEFAULT 0,
  payout_cents     BIGINT,
  sold_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  redeemed_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  redeemed_at      TIMESTAMPTZ,
  notes            TEXT,
  received_at      TIMESTAMPTZ,                      -- set when pre-loaded; NULL when minted at sale
  received_note    TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_redemption_product ON redemption_instruments (product_img, status);
CREATE INDEX IF NOT EXISTS idx_redemption_sale ON redemption_instruments (sale_id);

CREATE TABLE IF NOT EXISTS admin_presence (
  terminal_id TEXT PRIMARY KEY,
  label       TEXT,
  user_id     INTEGER,
  user_name   TEXT,
  ip          TEXT,
  user_agent  TEXT,
  first_seen  TIMESTAMPTZ DEFAULT NOW(),
  last_seen   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_admin_presence_seen ON admin_presence (last_seen);

INSERT INTO gl_accounts (code, name, type, qb_name, qb_type, system_key) VALUES
  ('1015', 'Petty Cash',                          'asset',     'Petty Cash',                          'BANK',   'petty_cash'),
  ('2160', 'Redeemables Held for Operator',       'liability', 'Redeemables Held for Operator',       'OCLIAB', 'redeemables_payable')
ON CONFLICT DO NOTHING;
