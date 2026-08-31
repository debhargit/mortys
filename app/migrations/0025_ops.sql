-- 0025_ops.sql  (D1 / SQLite)  — Phase 14 of the Cloudflare port
--
-- Ops: parts requisitions, service requisitions (estimates), stock counts,
-- stock adjust, deliveries, cash drawer. The only structural work is
-- rebuilding service_requisitions / _items — the D1 copies (migration 0004)
-- are the old draft shape; every current column lives on the Postgres side.
-- No data exists in the fresh D1, so a clean recreate is simplest.
--
--   wrangler d1 migrations apply meltahonda-db --remote

DROP TABLE IF EXISTS service_requisition_items;
DROP TABLE IF EXISTS service_requisitions;

CREATE TABLE service_requisitions (
  id                         INTEGER PRIMARY KEY AUTOINCREMENT,
  req_number                 TEXT,
  customer_user_id           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  customer_name              TEXT,
  customer_phone             TEXT,
  customer_email             TEXT,
  vehicle_year               INTEGER,
  vehicle_make               TEXT,
  vehicle_model              TEXT,
  vehicle_vin                TEXT,
  license_plate              TEXT,
  mileage_in                 INTEGER,
  service_advisor_id         INTEGER REFERENCES mechanics(id) ON DELETE SET NULL,
  inspection_id              INTEGER,
  complaint                  TEXT,
  recommended                TEXT,
  status                     TEXT NOT NULL DEFAULT 'draft',
  valid_until                TEXT,
  approved_at                TEXT,
  notes                      TEXT,
  estimate_total_cents       INTEGER DEFAULT 0,
  converted_to_work_order_id INTEGER REFERENCES work_orders(id) ON DELETE SET NULL,
  created_by                 INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at                 TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE service_requisition_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  requisition_id INTEGER NOT NULL REFERENCES service_requisitions(id) ON DELETE CASCADE,
  service_id     INTEGER REFERENCES services(id) ON DELETE SET NULL,
  description    TEXT NOT NULL,
  hours          REAL,
  labor_cents    INTEGER DEFAULT 0,
  parts_cents    INTEGER DEFAULT 0,
  total_cents    INTEGER DEFAULT 0
);
CREATE INDEX idx_sri_req ON service_requisition_items (requisition_id);
