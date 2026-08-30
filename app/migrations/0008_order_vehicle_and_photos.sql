-- 0008_order_vehicle_and_photos.sql
-- Lets a customer say which vehicle the parts are for, and attach photos of
-- the vehicle or the part they need, at checkout.
--
-- The vehicle columns deliberately mirror parts_inquiries (vehicle_make /
-- vehicle_model / vehicle_year) so the counter reads the same shape it already
-- knows from quote requests, plus a VIN.

ALTER TABLE orders ADD COLUMN vin           TEXT;
ALTER TABLE orders ADD COLUMN vehicle_make  TEXT;
ALTER TABLE orders ADD COLUMN vehicle_model TEXT;
ALTER TABLE orders ADD COLUMN vehicle_year  INTEGER;

-- Photos live in R2 when the UPLOADS binding exists (photo_path set, data
-- NULL). R2 is not enabled on this account yet, so the fallback stores the
-- bytes inline in D1 instead (data set, photo_path NULL). Exactly one of the
-- two is populated; the read path checks photo_path first.
--
-- The client downscales before upload, so inline rows stay well under D1's
-- row limit. Keep it that way if you change the upload path.
CREATE TABLE order_photos (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id     INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL DEFAULT 'part',   -- 'vehicle' | 'part'
  photo_path   TEXT,                           -- R2-backed URL, e.g. /uploads/orders/12/ab.jpg
  data         BLOB,                           -- inline bytes when R2 is unavailable
  content_type TEXT,
  byte_size    INTEGER,
  created_at   TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_order_photos_order ON order_photos (order_id);
