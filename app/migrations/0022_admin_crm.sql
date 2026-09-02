-- 0022_admin_crm.sql  (D1 / SQLite)  — Phase 11 of the Cloudflare port
--
-- Admin CRM + storefront-admin: parts inquiries, service appointments,
-- reviews moderation, customer addresses/contacts, message inbox, coupons,
-- gift-card admin. Only new structure here is customer_contacts (schema.sql
-- had it; D1 never did).
--
--   wrangler d1 migrations apply mortysautoparts-db --remote

CREATE TABLE IF NOT EXISTS customer_contacts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  title       TEXT,
  phone       TEXT,
  email       TEXT,
  is_primary  INTEGER NOT NULL DEFAULT 0,
  notes       TEXT,
  created_at  TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_customer_contacts_user ON customer_contacts (user_id);
