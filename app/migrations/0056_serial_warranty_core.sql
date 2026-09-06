-- Serial register, warranty register + claims, core deposit workflow, and
-- pre-loadable redemption instruments. Serials / warranty / core charges were
-- half-modelled already (products.serial_required / warranty_days /
-- core_charge_cents, pos_sale_items.serial_number / warranty_until /
-- core_charge_cents, a serial-lookup + core-charges report, prorated
-- warranty-claim returns) -- this adds the missing per-unit tracking.

-- ---- serial register -----------------------------------------------------
-- Serials on hand for a part: loaded in as 'in_stock', assigned to a sale
-- line at the counter, and tracked through its life. 'claimed' is the
-- terminal state for a unit swapped out under a warranty claim.
CREATE TABLE product_serials (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  product_img   TEXT NOT NULL REFERENCES products(img) ON DELETE CASCADE,
  serial        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'in_stock'
                CHECK (status IN ('in_stock','sold','returned','void','claimed')),
  sale_id       INTEGER REFERENCES pos_sales(id),
  sale_item_id  INTEGER REFERENCES pos_sale_items(id),
  sold_at       TEXT,
  sold_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  warranty_until TEXT,
  returned_at   TEXT,
  received_at   TEXT DEFAULT CURRENT_TIMESTAMP,
  received_note TEXT,
  notes         TEXT,
  UNIQUE (product_img, serial)
);
CREATE INDEX idx_product_serials_product ON product_serials (product_img, status);
CREATE INDEX idx_product_serials_serial  ON product_serials (serial);
CREATE INDEX idx_product_serials_sale    ON product_serials (sale_id);

-- ---- warranty claims ---------------------------------------------------
CREATE TABLE warranty_claims (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  product_img         TEXT REFERENCES products(img),
  serial              TEXT,
  serial_id           INTEGER REFERENCES product_serials(id),
  sale_id             INTEGER REFERENCES pos_sales(id),
  sale_item_id        INTEGER REFERENCES pos_sale_items(id),
  customer_name       TEXT,
  customer_phone      TEXT,
  status              TEXT NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open','repair','replace','refund','denied','closed')),
  fault               TEXT,
  resolution_note     TEXT,
  return_id           INTEGER REFERENCES pos_returns(id),
  replacement_sale_id INTEGER REFERENCES pos_sales(id),
  opened_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolved_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  opened_at           TEXT DEFAULT CURRENT_TIMESTAMP,
  resolved_at         TEXT
);
CREATE INDEX idx_warranty_claims_serial ON warranty_claims (serial);
CREATE INDEX idx_warranty_claims_sale   ON warranty_claims (sale_id);
CREATE INDEX idx_warranty_claims_status ON warranty_claims (status);

-- ---- core deposit workflow -------------------------------------------
-- 1 = the customer handed the old core over at the time of sale, so the
-- deposit was never charged on this line (the report must not treat it as
-- outstanding).
ALTER TABLE pos_sale_items ADD COLUMN core_returned INTEGER NOT NULL DEFAULT 0;

-- The customer brings the old core back later: refund the deposit; the part
-- itself stays sold (no restock).
CREATE TABLE core_returns (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  return_number TEXT UNIQUE,
  sale_id       INTEGER NOT NULL REFERENCES pos_sales(id),
  sale_item_id  INTEGER NOT NULL REFERENCES pos_sale_items(id),
  qty           INTEGER NOT NULL,
  refund_cents  INTEGER NOT NULL,
  refund_method TEXT NOT NULL,
  processed_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  notes         TEXT,
  created_at    TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_core_returns_sale ON core_returns (sale_id);

-- ---- redeemable instruments: pre-loadable ---------------------------
-- redemption_instruments.status (0047) has no CHECK constraint, so the new
-- 'in_stock' value needs no schema change to the constraint -- just the two
-- receiving columns.
ALTER TABLE redemption_instruments ADD COLUMN received_at   TEXT;
ALTER TABLE redemption_instruments ADD COLUMN received_note TEXT;
