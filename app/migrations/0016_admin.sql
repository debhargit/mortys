-- 0016_admin.sql  (D1 / SQLite)  — Phase 3 of the Cloudflare port (see app/PORT.md)
--
-- Tables/columns the admin read paths (dashboard, orders, staff, roles,
-- settings, products) need that the earlier D1 conversion left behind.
--
--   wrangler d1 migrations apply meltahonda-db --local
--   wrangler d1 migrations apply meltahonda-db

-- ---- shop settings (single row, id = 1) ---------------------------------
CREATE TABLE IF NOT EXISTS shop_settings (
  id                     INTEGER PRIMARY KEY,
  company_name           TEXT NOT NULL DEFAULT 'Meltha Honda Sales & Servs Ltd',
  address                TEXT NOT NULL DEFAULT '127 Hagley Park Road, Kingston 11',
  country                TEXT NOT NULL DEFAULT 'Jamaica',
  phone                  TEXT NOT NULL DEFAULT '(876) 758-8503',
  email                  TEXT,
  website                TEXT,
  logo_url               TEXT,
  print_logo_on_invoice  INTEGER NOT NULL DEFAULT 1,
  default_print_template TEXT NOT NULL DEFAULT 'receipt',
  quote_valid_days       INTEGER NOT NULL DEFAULT 14,
  invoice_notice         TEXT NOT NULL DEFAULT 'Goods remain the property of the company until paid in full. Returns accepted within 14 days with the original invoice, in original condition. Electrical parts are non-returnable.',
  receipt_notice         TEXT NOT NULL DEFAULT 'Returns within 14 days with this receipt. Electrical parts non-returnable.',
  statement_notice       TEXT NOT NULL DEFAULT 'Please settle any outstanding balance promptly. Contact us with any questions about this statement.',
  updated_at             TEXT DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO shop_settings (id) VALUES (1);

-- ---- orders: coupon fields (payment_method/status/ref are already on the
-- base D1 table; Postgres also carries the coupon pair) -----------------
ALTER TABLE orders ADD COLUMN coupon_code           TEXT;
ALTER TABLE orders ADD COLUMN coupon_discount_cents INTEGER DEFAULT 0;

-- ---- customer account payments (settlements against a charge-sale balance)
CREATE TABLE IF NOT EXISTS account_payments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL,
  method       TEXT,
  reference    TEXT,
  notes        TEXT,
  received_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_account_payments_cust ON account_payments (customer_id);

-- ---- products: supplier link + barcode --------------------------------
ALTER TABLE products ADD COLUMN supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL;
ALTER TABLE products ADD COLUMN barcode     TEXT;

-- ---- function-permission deny maps (Postgres jsonb; TEXT here) -------
ALTER TABLE users           ADD COLUMN perms TEXT NOT NULL DEFAULT '{}';
ALTER TABLE user_categories ADD COLUMN perms TEXT NOT NULL DEFAULT '{}';
