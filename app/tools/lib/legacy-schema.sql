-- Postgres-side scaffolding for the legacy CSV import.
--
-- NOT a migration. migrations/*.sql are Cloudflare D1 (SQLite) migrations --
-- wrangler applies them to D1 and app/test/*.mjs replays them into an in-memory
-- node:sqlite database, so everything in that directory has to parse as SQLite.
-- This file is Postgres-only (plpgsql functions, jsonb, bigserial) and exists
-- purely to support a one-off import, so it lives with the tools instead and is
-- applied by ensureLegacySchema() in tools/lib/db.mjs on every seeder run.
--
-- Everything here is idempotent: CREATE TABLE IF NOT EXISTS, CREATE OR REPLACE
-- FUNCTION, and ADD COLUMN IF NOT EXISTS.
--
-- Staging tables for the legacy DOS/FoxPro CSV exports
-- (INVENTRY, INVOICE, INVDETAI, INVPAY, INVREC).
--
-- The seeders in app/tools/load-*.mjs COPY each export into the matching
-- legacy_* table verbatim (text columns, no coercion), then transform into the
-- live tables with set-based SQL. They are kept after loading, not dropped, so
-- that:
--   * reconcile-invoices.mjs can re-check live totals against the source,
--   * the 23% of historic sale lines whose SKU no longer exists in INVENTRY
--     stay traceable,
--   * a re-run is idempotent -- each loader truncates its own staging table.
--
-- Columns are only the subset the seeders consume; the exports carry up to 108
-- columns each, most of them unused price-break / warehouse scratch fields.

CREATE TABLE IF NOT EXISTS legacy_inventry (
  sku          text,
  location     text,
  part_name    text,
  descr2       text,
  quantity     text,
  min_lev      text,
  max_lev      text,
  cost         text,
  price        text,
  wholeprice   text,
  margin       text,
  unit         text,
  brand        text,
  model        text,
  supplier     text,
  taxcode      text,
  txrate       text,
  active       text,
  type         text,
  receiveqty   text,
  soldqty      text,
  ini_date     text,
  commish      text,
  discount     text,
  src_line     bigint
);

CREATE TABLE IF NOT EXISTS legacy_invoice (
  inv_number   text,
  inv_date     text,
  inv_time     text,
  salespersn   text,
  customer     text,
  address1     text,
  address2     text,
  phone        text,
  reference    text,
  sub_total    text,
  tax          text,
  total        text,
  total_paid   text,
  status       text,
  taxable      text,
  pricing      text,
  cred_terms   text,
  labour       text,
  tranno       text,
  cl_number    text,
  cr_number    text,
  credit       text,
  app_user     text,
  change_due   text,
  reason       text,
  receipt      text,
  tend         text,
  src_line     bigint
);

CREATE TABLE IF NOT EXISTS legacy_invdetai (
  inv_number   text,
  lin_number   text,
  sku          text,
  part_name    text,
  quantity     text,
  unit_price   text,
  disc         text,
  tax          text,
  amount       text,
  ddate        text,
  salespersn   text,
  det_time     text,
  taxamt       text,
  status       text,
  cost         text,
  customer     text,
  txrate       text,
  tranno       text,
  cr_number    text,
  sprice       text,
  app_user     text,
  src_line     bigint
);

CREATE TABLE IF NOT EXISTS legacy_invpay (
  inv_number   text,
  cl_name      text,
  pay_date     text,
  pay_desc     text,
  pay_desc2    text,
  amount       text,
  pay_number   text,
  pay_time     text,
  salespersn   text,
  tranno       text,
  cr_number    text,
  app_user     text,
  src_line     bigint
);

CREATE TABLE IF NOT EXISTS legacy_invrec (
  sku          text,
  supplier     text,
  rec_date     text,
  qty          text,
  cost         text,
  lcost        text,
  price        text,
  reference    text,
  sub_total    text,
  txrate       text,
  total        text,
  total_paid   text,
  pay_date     text,
  orderby      text,
  lin_number   text,
  descr        text,
  unit         text,
  disc         text,
  tax          text,
  det_time     text,
  salespersn   text,
  app_user     text,
  src_line     bigint
);

CREATE INDEX IF NOT EXISTS legacy_invoice_num_idx   ON legacy_invoice (inv_number);
CREATE INDEX IF NOT EXISTS legacy_invdetai_num_idx  ON legacy_invdetai (inv_number);
CREATE INDEX IF NOT EXISTS legacy_invdetai_sku_idx  ON legacy_invdetai (sku);
CREATE INDEX IF NOT EXISTS legacy_invpay_num_idx    ON legacy_invpay (inv_number);
CREATE INDEX IF NOT EXISTS legacy_invrec_sku_idx    ON legacy_invrec (sku);
CREATE INDEX IF NOT EXISTS legacy_inventry_sku_idx  ON legacy_inventry (sku);

-- pos_sales.receipt_number is UNIQUE, and the legacy export has 1,179 rows
-- whose INV_NUMBER repeats. The seeder keeps the first and parks the rest here
-- so nothing is silently dropped.
CREATE TABLE IF NOT EXISTS legacy_import_rejects (
  id          bigserial PRIMARY KEY,
  source      text NOT NULL,          -- 'INVOICE' | 'INVDETAI' | 'INVPAY' | 'INVREC' | 'INVENTRY'
  reason      text NOT NULL,
  key1        text,
  key2        text,
  payload     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS legacy_rejects_src_idx ON legacy_import_rejects (source, reason);

-- Links a live sale back to its legacy invoice, and a live PO back to the
-- legacy receipt batch, so re-runs can update in place instead of duplicating.
ALTER TABLE pos_sales       ADD COLUMN IF NOT EXISTS legacy_tranno text;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS legacy_key    text;

CREATE INDEX IF NOT EXISTS pos_sales_legacy_tranno_idx ON pos_sales (legacy_tranno);

-- Postgres does not index the referencing side of a FK automatically, and these
-- two were missing. They only mattered once the legacy import took the child
-- tables to 1.05M and 178k rows: every receipt/invoice view and every PO view
-- filters on exactly these columns, and without the index each one is a full
-- sequential scan of the child table.
CREATE INDEX IF NOT EXISTS pos_sale_items_sale_idx       ON pos_sale_items (sale_id);
CREATE INDEX IF NOT EXISTS purchase_order_items_po_idx   ON purchase_order_items (po_id);
-- Not a partial index: ON CONFLICT (legacy_key) cannot infer a partial one, and
-- it does not need to be partial -- orders created in the app leave legacy_key
-- NULL, and NULLs never collide in a unique index.
CREATE UNIQUE INDEX IF NOT EXISTS purchase_orders_legacy_key_idx
  ON purchase_orders (legacy_key);

-- ---------------------------------------------------------------------------
-- Coercion helpers for the staged text columns.
--
-- The exports come out of a DOS-era system: money may carry $ or thousands
-- separators, dates are M/D/YYYY and may be blank, '/  /', or carry a typo'd
-- year (4201, 6202 both occur in INVREC). These return NULL instead of raising,
-- so one bad cell cannot abort a 1M-row transform.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION legacy_num(v text) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE s text;
BEGIN
  IF v IS NULL THEN RETURN NULL; END IF;
  s := regexp_replace(btrim(v), '[$,[:space:]]', '', 'g');
  IF s = '' OR s !~ '^-?[0-9]*\.?[0-9]+$' THEN RETURN NULL; END IF;
  RETURN s::numeric;
END $$;

CREATE OR REPLACE FUNCTION legacy_num0(v text) RETURNS numeric
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT coalesce(legacy_num(v), 0) $$;

-- M/D/YYYY -> date. Rejects anything outside 1990..2100 so that typo'd years
-- land as NULL rather than as a year-4201 row in a date column.
--
-- The day is range-checked against the month's real length rather than caught
-- with an EXCEPTION block: an exception handler opens a subtransaction, which
-- Postgres forbids inside a parallel worker, and these run over 1M-row scans.
CREATE OR REPLACE FUNCTION legacy_date(v text) RETURNS date
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE m text[]; mo int; dy int; yr int; maxd int;
BEGIN
  IF v IS NULL THEN RETURN NULL; END IF;
  m := regexp_match(btrim(v), '^([0-9]{1,2})\s*/\s*([0-9]{1,2})\s*/\s*([0-9]{2,4})$');
  IF m IS NULL THEN RETURN NULL; END IF;
  mo := m[1]::int; dy := m[2]::int; yr := m[3]::int;
  IF yr < 100 THEN yr := yr + CASE WHEN yr < 70 THEN 2000 ELSE 1900 END; END IF;
  IF yr < 1990 OR yr > 2100 OR mo < 1 OR mo > 12 OR dy < 1 THEN RETURN NULL; END IF;
  maxd := CASE mo
            WHEN 2 THEN CASE WHEN (yr % 4 = 0 AND yr % 100 <> 0) OR yr % 400 = 0 THEN 29 ELSE 28 END
            WHEN 4 THEN 30 WHEN 6 THEN 30 WHEN 9 THEN 30 WHEN 11 THEN 30
            ELSE 31 END;
  IF dy > maxd THEN RETURN NULL; END IF;
  RETURN make_date(yr, mo, dy);
END $$;

-- 'HH:MM:SS' / 'HH:MM:' / 'HHMM' / '1337' -> interval since midnight.
CREATE OR REPLACE FUNCTION legacy_time(v text) RETURNS interval
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE s text; m text[]; hh int; mi int; ss int;
BEGIN
  IF v IS NULL THEN RETURN NULL; END IF;
  s := btrim(v);
  m := regexp_match(s, '^([0-9]{1,2}):([0-9]{2}):?([0-9]{2})?$');
  IF m IS NOT NULL THEN
    hh := m[1]::int; mi := m[2]::int; ss := coalesce(m[3], '0')::int;
  ELSE
    m := regexp_match(s, '^([0-9]{3,4})$');
    IF m IS NULL THEN RETURN NULL; END IF;
    hh := (lpad(m[1], 4, '0'))::int / 100;
    mi := (lpad(m[1], 4, '0'))::int % 100;
    ss := 0;
  END IF;
  IF hh > 23 OR mi > 59 OR ss > 59 THEN RETURN NULL; END IF;
  RETURN make_interval(hours => hh, mins => mi, secs => ss);
END $$;

-- date + time text -> timestamptz, midnight when the time is missing/garbage.
CREATE OR REPLACE FUNCTION legacy_ts(d text, t text) RETURNS timestamptz
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN legacy_date(d) IS NULL THEN NULL
              ELSE legacy_date(d)::timestamp + coalesce(legacy_time(t), interval '0') END
$$;

-- Staff / customer name hygiene. The legacy fields hold stray dates, single
-- punctuation marks and blanks; this returns NULL for anything that is not
-- plausibly a name so callers can filter in one place.
CREATE OR REPLACE FUNCTION legacy_name(v text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN v IS NULL THEN NULL
    WHEN regexp_replace(btrim(v), '\s+', ' ', 'g') = '' THEN NULL
    -- a date, or anything with no letter in it at all, is not a name
    WHEN btrim(v) ~ '^[0-9]{1,2}\s*/\s*[0-9]{1,2}\s*/\s*[0-9]{2,4}$' THEN NULL
    WHEN btrim(v) !~ '[A-Za-z]' THEN NULL
    ELSE regexp_replace(btrim(v), '\s+', ' ', 'g')
  END
$$;
