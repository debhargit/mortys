-- ============================================================================
--  Tables for the "designed but never migrated" admin features the user
--  asked to have built out properly: purchase orders (extended), stock
--  counts, warehouse activity (corrected shape), deliveries, cash drawer,
--  parts requisitions, time entries, schedule blocks, and the labor-standards
--  estimator (with its seed data, ported from server.js's seedLaborStandards()).
--  Same conversion rules as 0001/0003 (money -> *_cents, booleans -> 0/1,
--  timestamps -> TEXT).
-- ============================================================================

-- PURCHASE ORDERS -- extend to match what the code actually reads/writes ----
ALTER TABLE purchase_orders RENAME COLUMN received_at TO received_date;
ALTER TABLE purchase_orders ADD COLUMN expected_date TEXT;
ALTER TABLE purchase_orders ADD COLUMN shipping_cents INTEGER DEFAULT 0;
ALTER TABLE purchase_orders ADD COLUMN tax_cents INTEGER DEFAULT 0;
ALTER TABLE purchase_orders ADD COLUMN invoice_number TEXT;
ALTER TABLE purchase_orders ADD COLUMN subtotal_cents INTEGER DEFAULT 0;

ALTER TABLE purchase_order_items RENAME COLUMN qty TO qty_ordered;
ALTER TABLE purchase_order_items RENAME COLUMN unit_cost_cents TO unit_cost_cents_old;
ALTER TABLE purchase_order_items ADD COLUMN unit_cost_cents INTEGER;
UPDATE purchase_order_items SET unit_cost_cents = unit_cost_cents_old;
ALTER TABLE purchase_order_items DROP COLUMN unit_cost_cents_old;
ALTER TABLE purchase_order_items ADD COLUMN sku TEXT;
ALTER TABLE purchase_order_items ADD COLUMN condition TEXT DEFAULT 'NEW';
ALTER TABLE purchase_order_items ADD COLUMN notes TEXT;
ALTER TABLE purchase_order_items ADD COLUMN total_cents INTEGER;

-- WAREHOUSE ACTIVITY -- the live table's columns (action/meta_json) don't
-- match what the warehouse routes actually read/write (kind/qty_before/
-- qty_after/qty_delta/bin_location); nothing has been ported against the old
-- shape yet, so it's safe to redefine rather than carry two conventions.
DROP TABLE warehouse_activity;
CREATE TABLE warehouse_activity (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL,
  product_img   TEXT,
  qty_before    INTEGER,
  qty_after     INTEGER,
  qty_delta     INTEGER,
  bin_location  TEXT,
  performed_by  INTEGER REFERENCES mechanics(id) ON DELETE SET NULL,
  ref_kind      TEXT,
  ref_id        INTEGER,
  notes         TEXT,
  created_at    TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_wact_created2 ON warehouse_activity(created_at DESC);
CREATE INDEX idx_wact_product ON warehouse_activity(product_img);

-- STOCK COUNTS (cycle counting) ----------------------------------------------
CREATE TABLE stock_counts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  count_number    TEXT UNIQUE,
  scope           TEXT NOT NULL DEFAULT 'full',   -- full | bin | category
  scope_value     TEXT,
  counted_by      INTEGER REFERENCES mechanics(id) ON DELETE SET NULL,
  notes           TEXT,
  status          TEXT NOT NULL DEFAULT 'open',   -- open | posted
  started_at      TEXT DEFAULT CURRENT_TIMESTAMP,
  posted_at       TEXT,
  total_items     INTEGER DEFAULT 0,
  total_variance  INTEGER DEFAULT 0
);

CREATE TABLE stock_count_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  count_id      INTEGER NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE,
  product_img   TEXT REFERENCES products(img) ON DELETE SET NULL,
  bin_location  TEXT,
  system_qty    INTEGER NOT NULL DEFAULT 0,
  counted_qty   INTEGER,
  notes         TEXT,
  counted_at    TEXT
);
CREATE INDEX idx_stock_count_items_count ON stock_count_items(count_id);

-- DELIVERIES ------------------------------------------------------------------
CREATE TABLE deliveries (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_number        TEXT UNIQUE,
  related_kind           TEXT,       -- e.g. 'order' | 'pos_sale' | 'work_order'
  related_id             INTEGER,
  recipient_name         TEXT NOT NULL,
  recipient_phone        TEXT,
  address                TEXT,
  driver_id              INTEGER REFERENCES mechanics(id) ON DELETE SET NULL,
  vehicle                TEXT,
  status                 TEXT NOT NULL DEFAULT 'pending', -- pending|dispatched|delivered|cancelled
  scheduled_for          TEXT,
  dispatched_at          TEXT,
  delivered_at           TEXT,
  proof_photo            TEXT,
  proof_signature        TEXT,
  recipient_received_by  TEXT,
  notes                  TEXT,
  created_by             INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at             TEXT DEFAULT CURRENT_TIMESTAMP
);

-- CASH DRAWER SESSIONS --------------------------------------------------------
CREATE TABLE cash_drawer_sessions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  opened_by         INTEGER REFERENCES mechanics(id) ON DELETE SET NULL,
  opening_float_cents INTEGER NOT NULL DEFAULT 0,
  closed_by         INTEGER REFERENCES mechanics(id) ON DELETE SET NULL,
  closing_amount_cents INTEGER,
  expected_cash_cents  INTEGER,
  variance_cents    INTEGER,
  notes             TEXT,
  opened_at         TEXT DEFAULT CURRENT_TIMESTAMP,
  closed_at         TEXT
);

-- PARTS REQUISITIONS (warehouse fulfillment queue for work orders) -----------
-- Distinct from service_requisitions (customer-facing estimates).
CREATE TABLE parts_requisitions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_number     TEXT UNIQUE,
  work_order_id INTEGER REFERENCES work_orders(id) ON DELETE SET NULL,
  requested_by  INTEGER REFERENCES mechanics(id) ON DELETE SET NULL,
  fulfilled_by  INTEGER REFERENCES mechanics(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'pending', -- pending|partial|fulfilled
  notes         TEXT,
  created_at    TEXT DEFAULT CURRENT_TIMESTAMP,
  fulfilled_at  TEXT
);

CREATE TABLE parts_requisition_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  requisition_id  INTEGER NOT NULL REFERENCES parts_requisitions(id) ON DELETE CASCADE,
  product_img     TEXT REFERENCES products(img) ON DELETE SET NULL,
  description     TEXT NOT NULL,
  qty_requested   INTEGER NOT NULL,
  qty_fulfilled   INTEGER NOT NULL DEFAULT 0,
  unit_price_cents INTEGER,
  status          TEXT NOT NULL DEFAULT 'pending' -- pending|backordered|fulfilled|cancelled
);
CREATE INDEX idx_parts_req_items_req ON parts_requisition_items(requisition_id);

-- TIME ENTRIES (mechanic clock-in/out, distinct from the unused time_punches) -
CREATE TABLE time_entries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  mechanic_id     INTEGER NOT NULL REFERENCES mechanics(id) ON DELETE CASCADE,
  work_order_id   INTEGER REFERENCES work_orders(id) ON DELETE SET NULL,
  description     TEXT,
  clocked_in_at   TEXT DEFAULT CURRENT_TIMESTAMP,
  clocked_out_at  TEXT,
  hours           REAL,
  labor_entry_id  INTEGER REFERENCES work_order_labor(id) ON DELETE SET NULL
);
CREATE INDEX idx_time_entries_mechanic ON time_entries(mechanic_id);

-- SCHEDULE BLOCKS (non-customer time on a mechanic's calendar) ---------------
CREATE TABLE schedule_blocks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  mechanic_id  INTEGER REFERENCES mechanics(id) ON DELETE CASCADE,
  block_date   TEXT NOT NULL,
  time_slot    TEXT,
  reason       TEXT,
  notes        TEXT,
  created_at   TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_schedule_blocks_date ON schedule_blocks(block_date);

-- LABOR STANDARDS -- flat-rate catalog + vehicle-class multipliers + tiered
-- rates + estimator. Seed data ported from server.js's seedLaborStandards().
CREATE TABLE vehicle_classes (
  code              TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  labor_multiplier  REAL NOT NULL DEFAULT 1.0,
  description       TEXT
);

CREATE TABLE labor_rate_tiers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT UNIQUE NOT NULL,
  rate_cents   INTEGER NOT NULL,
  description  TEXT,
  is_default   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE labor_rates (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT UNIQUE NOT NULL,
  category     TEXT NOT NULL,
  operation    TEXT NOT NULL,
  base_hours   REAL NOT NULL,
  notes        TEXT,
  source       TEXT,
  is_active    INTEGER NOT NULL DEFAULT 1
);

INSERT INTO vehicle_classes (code, name, labor_multiplier) VALUES
  ('compact', 'Compact car (Civic, Corolla, Sentra)', 1.00),
  ('midsize', 'Midsize car (Camry, Accord, Altima)', 1.10),
  ('full_size', 'Full-size car (Avalon, Maxima)', 1.15),
  ('suv_small', 'Small SUV (CR-V, RAV4, Rogue)', 1.20),
  ('suv_large', 'Large SUV (Highlander, Pilot, Pathfinder)', 1.30),
  ('truck', 'Pickup truck (Tacoma, Frontier, Ridgeline)', 1.30),
  ('luxury', 'Luxury (Acura)', 1.25),
  ('european', 'European (BMW, Mercedes, Audi, VW)', 1.45),
  ('hybrid', 'Hybrid (Prius, Camry Hybrid)', 1.20),
  ('ev', 'Electric vehicle', 1.40);

INSERT INTO labor_rate_tiers (name, rate_cents, description, is_default) VALUES
  ('Standard', 3500, 'General repair and maintenance', 1),
  ('Diagnostic', 5000, 'Diagnostic scans, troubleshooting', 0),
  ('After-hours', 5500, 'Outside Mon-Sat 8:00-5:30', 0),
  ('Warranty', 2500, 'Manufacturer warranty work', 0),
  ('Internal', 0, 'Shop-internal vehicle work', 0);

INSERT INTO labor_rates (code, category, operation, base_hours, notes) VALUES
  ('OIL-001', 'Oil Change', 'Engine oil & filter — conventional', 0.4, 'Includes disposal'),
  ('OIL-002', 'Oil Change', 'Engine oil & filter — synthetic', 0.5, 'Includes disposal'),
  ('OIL-003', 'Oil Change', 'Engine oil & filter — diesel', 0.7, 'Includes disposal'),
  ('BRK-001', 'Brakes', 'Front brake pads — replace', 1.0, 'Includes clean & lube'),
  ('BRK-002', 'Brakes', 'Rear brake pads — replace', 1.2, ''),
  ('BRK-003', 'Brakes', 'Front rotors — replace (pair)', 1.5, 'Includes pad re-bed'),
  ('BRK-004', 'Brakes', 'Rear rotors — replace (pair)', 1.7, ''),
  ('BRK-005', 'Brakes', 'Brake fluid flush & bleed', 0.8, '4-wheel system'),
  ('BRK-006', 'Brakes', 'Caliper replacement (single)', 1.5, ''),
  ('SUSP-001', 'Suspension', 'Front struts — replace (pair)', 3.0, 'Alignment recommended after'),
  ('SUSP-002', 'Suspension', 'Rear shocks — replace (pair)', 1.8, ''),
  ('SUSP-003', 'Suspension', 'Control arm — replace (single)', 1.5, ''),
  ('SUSP-004', 'Suspension', 'Sway bar links — replace (pair)', 0.8, ''),
  ('STR-001', 'Steering', 'Wheel alignment — 4-wheel', 1.0, 'Includes road test'),
  ('STR-002', 'Steering', 'Wheel alignment — 2-wheel', 0.6, ''),
  ('STR-003', 'Steering', 'Tie rod end — replace (single)', 0.8, 'Alignment required after'),
  ('STR-004', 'Steering', 'Power steering fluid flush', 0.6, ''),
  ('TIRE-001', 'Tires', 'Tire rotation', 0.4, ''),
  ('TIRE-002', 'Tires', 'Mount & balance single tire', 0.3, ''),
  ('TIRE-003', 'Tires', 'Mount & balance set of 4', 1.0, ''),
  ('TIRE-004', 'Tires', 'Tire patch / plug repair', 0.5, ''),
  ('ENG-001', 'Engine', 'Spark plugs — 4-cylinder', 1.0, ''),
  ('ENG-002', 'Engine', 'Spark plugs — 6-cylinder', 1.5, ''),
  ('ENG-003', 'Engine', 'Spark plugs — 8-cylinder', 2.0, ''),
  ('ENG-004', 'Engine', 'Coolant flush & refill', 1.0, ''),
  ('ENG-005', 'Engine', 'Timing belt — replace', 5.0, 'Includes water pump if applicable'),
  ('ENG-006', 'Engine', 'Serpentine belt — replace', 0.6, ''),
  ('ENG-007', 'Engine', 'Drive belt tensioner — replace', 0.8, ''),
  ('ENG-008', 'Engine', 'Air filter — replace', 0.2, ''),
  ('ENG-009', 'Engine', 'Cabin filter — replace', 0.3, ''),
  ('TRN-001', 'Transmission', 'Transmission fluid & filter — replace', 1.5, 'Automatic'),
  ('TRN-002', 'Transmission', 'Transmission fluid — drain & refill', 0.8, 'Manual'),
  ('TRN-003', 'Transmission', 'Clutch replacement', 6.0, 'Includes pressure plate & release bearing'),
  ('ELEC-001', 'Electrical', 'Battery — test & replace', 0.4, ''),
  ('ELEC-002', 'Electrical', 'Alternator — replace', 1.5, ''),
  ('ELEC-003', 'Electrical', 'Starter motor — replace', 1.5, ''),
  ('ELEC-004', 'Electrical', 'Headlight bulb — replace (single)', 0.4, ''),
  ('DIAG-001', 'Diagnostics', 'Check engine light scan & report', 0.5, 'Diagnostic tier rate'),
  ('DIAG-002', 'Diagnostics', 'Electrical fault diagnosis', 1.5, 'Diagnostic tier rate'),
  ('DIAG-003', 'Diagnostics', 'Driveability complaint diagnosis', 1.5, 'Diagnostic tier rate'),
  ('AC-001', 'A/C & HVAC', 'A/C performance check', 0.5, 'Includes pressure read'),
  ('AC-002', 'A/C & HVAC', 'A/C recharge (R134a)', 1.0, 'Refrigerant extra'),
  ('AC-003', 'A/C & HVAC', 'A/C compressor — replace', 3.0, ''),
  ('AC-004', 'A/C & HVAC', 'Heater core — replace', 5.0, 'Dash removal'),
  ('EXH-001', 'Exhaust', 'Muffler — replace', 1.0, ''),
  ('EXH-002', 'Exhaust', 'Catalytic converter — replace', 1.5, ''),
  ('EXH-003', 'Exhaust', 'O2 sensor — replace (single)', 0.5, ''),
  ('BODY-001', 'Body', 'Front bumper — remove & refit', 1.0, ''),
  ('BODY-002', 'Body', 'Door panel — remove & refit', 0.8, ''),
  ('MAINT-001', 'Maintenance', '30,000 km service inspection', 1.5, 'Multi-point inspection + filters'),
  ('MAINT-002', 'Maintenance', '60,000 km service inspection', 2.5, 'Multi-point + fluids'),
  ('MAINT-003', 'Maintenance', '100,000 km major service', 4.0, 'Full inspection + tune-up');

-- INSPECTION PHOTOS: add the item link the code expects.
ALTER TABLE inspection_photos ADD COLUMN inspection_item_id INTEGER REFERENCES inspection_items(id) ON DELETE SET NULL;
