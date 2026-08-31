-- 0023_users_admin.sql  (D1 / SQLite)  — Phase 12 of the Cloudflare port
--
-- Users / staff / roles / categories admin. Gaps vs Postgres:
--   users.company_name / customer_type / tax_id   (customer-card fields)
--   customer_messages.staff_id                    (who replied)
--   customer_notifications                        (dunning / manual notices)
--
--   wrangler d1 migrations apply meltahonda-db --remote

ALTER TABLE users ADD COLUMN company_name  TEXT;
ALTER TABLE users ADD COLUMN customer_type TEXT;
ALTER TABLE users ADD COLUMN tax_id        TEXT;

ALTER TABLE customer_messages ADD COLUMN staff_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS customer_notifications (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind     TEXT,
  body     TEXT,
  sent_at  TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_customer_notifications_user ON customer_notifications (user_id);
