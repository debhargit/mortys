-- 0024_service_centre.sql  (D1 / SQLite)  — Phase 13 of the Cloudflare port
--
-- Service centre: mechanics, services catalogue, work orders (+ labor / parts
-- / payments), inspections, labor standards. Only gap vs Postgres is the
-- split labour/parts defaults on the services catalogue.
--
--   wrangler d1 migrations apply mortysautoparts-db --remote

ALTER TABLE services ADD COLUMN default_labor_cents INTEGER;
ALTER TABLE services ADD COLUMN default_parts_cents INTEGER;
