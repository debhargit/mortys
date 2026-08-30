-- 0010_pos_full.sql
-- Turns the counter POS from "ring up a cash sale" into a full parts-counter
-- terminal: named customer + sales rep on every ticket, a fulfilment decision
-- (pickup / local delivery / courier shipment), sales that can be parked or
-- charged to an account, and enough recorded detail that the five counter
-- documents (invoice, receipt, pick slip, packing slip, shipping label) can all
-- be printed from the stored sale rather than from whatever happened to still
-- be on screen.
--
-- Everything here is additive: existing pos_sales rows keep working because the
-- new columns all carry defaults matching the old behaviour (pickup, paid in
-- full, no rep).

-- WHO SOLD IT ----------------------------------------------------------------
-- cashier_id was already on the table but nothing ever wrote it, so every sale
-- was anonymous. The POST now fills it from the session. sales_rep_id is a
-- separate person on purpose: at a parts counter the rep who worked the
-- customer and the person who happened to run the till are often not the same,
-- and commission follows the rep. It points at `mechanics`, which is this
-- schema's staff table (role 'advisor'/'both' are the counter staff).
--
-- The name is denormalised alongside the id because a receipt reprinted two
-- years later should still say who sold it even if the staff row is gone.
ALTER TABLE pos_sales ADD COLUMN sales_rep_id   INTEGER REFERENCES mechanics(id) ON DELETE SET NULL;
ALTER TABLE pos_sales ADD COLUMN sales_rep_name TEXT;

-- HOW IT LEAVES THE BUILDING -------------------------------------------------
-- fulfilment drives which documents are printable. 'pickup' means the customer
-- is standing there and there is nothing to pack or label, so packing slip and
-- shipping label are not applicable; 'delivery' (own van) and 'shipping'
-- (third-party courier) both produce a packing slip, and only 'shipping' needs
-- a carrier label with a tracking number.
ALTER TABLE pos_sales ADD COLUMN fulfilment        TEXT NOT NULL DEFAULT 'pickup';  -- pickup|delivery|shipping
ALTER TABLE pos_sales ADD COLUMN ship_method       TEXT;      -- carrier / service name, or 'Own van'
ALTER TABLE pos_sales ADD COLUMN ship_fee_cents    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pos_sales ADD COLUMN ship_name         TEXT;
ALTER TABLE pos_sales ADD COLUMN ship_phone        TEXT;
ALTER TABLE pos_sales ADD COLUMN ship_line1        TEXT;
ALTER TABLE pos_sales ADD COLUMN ship_line2        TEXT;
ALTER TABLE pos_sales ADD COLUMN ship_city         TEXT;
ALTER TABLE pos_sales ADD COLUMN ship_parish       TEXT;
ALTER TABLE pos_sales ADD COLUMN ship_country      TEXT DEFAULT 'Jamaica';
ALTER TABLE pos_sales ADD COLUMN ship_instructions TEXT;
ALTER TABLE pos_sales ADD COLUMN tracking_number   TEXT;
-- Set once the packing slip / label has actually been run, so the shipping
-- desk can tell a picked-and-packed order from one still sitting in the queue.
ALTER TABLE pos_sales ADD COLUMN packed_at         TEXT;
ALTER TABLE pos_sales ADD COLUMN shipped_at        TEXT;

-- CHARGE SALES (accounts receivable) -----------------------------------------
-- A charge sale is rung up in full but tendered wholly or partly to the
-- customer's account, so the goods leave against a balance rather than money.
-- payment_status is derived on the server from what was actually tendered:
--   paid    -- money_in >= total
--   partial -- some cash/card plus some on account
--   unpaid  -- the whole ticket went on account
-- balance_due_cents is what the customer still owes and is what the invoice
-- prints as BALANCE DUE; it drops to zero as settlement payments come in.
ALTER TABLE pos_sales ADD COLUMN payment_status    TEXT NOT NULL DEFAULT 'paid';   -- paid|partial|unpaid
ALTER TABLE pos_sales ADD COLUMN amount_paid_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pos_sales ADD COLUMN balance_due_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pos_sales ADD COLUMN due_date          TEXT;    -- when a charge sale falls due
ALTER TABLE pos_sales ADD COLUMN po_number         TEXT;    -- trade customer's own PO reference

-- An invoice number distinct from the receipt number: trade customers file by
-- invoice, and a sale that is later partly refunded still keeps one invoice.
ALTER TABLE pos_sales ADD COLUMN invoice_number    TEXT;

-- Where a sale came from, when it was rung up off a saved quote. Lets the quote
-- list show "converted" instead of leaving an accepted quote sitting open.
ALTER TABLE pos_sales ADD COLUMN quote_id          INTEGER REFERENCES pos_quotes(id) ON DELETE SET NULL;

CREATE INDEX idx_pos_sales_status  ON pos_sales (payment_status, created_at DESC);
CREATE INDEX idx_pos_sales_created ON pos_sales (created_at DESC);
CREATE INDEX idx_pos_sales_rep     ON pos_sales (sales_rep_id, created_at DESC);
CREATE INDEX idx_pos_sales_invoice ON pos_sales (invoice_number);

-- LINE-LEVEL DISCOUNT --------------------------------------------------------
-- The order-level discount already existed. A per-line discount is the one the
-- counter actually reaches for ("give him ten percent off the strut, full price
-- on the rest"), and it has to be stored per line or the invoice can't show the
-- customer what was taken off what.
ALTER TABLE pos_sale_items ADD COLUMN discount_cents INTEGER NOT NULL DEFAULT 0;
-- Free text for why: 'damaged box', 'price match', 'trade'. Prints on the
-- invoice next to the line so a discount is never unexplained on an audit.
ALTER TABLE pos_sale_items ADD COLUMN discount_note  TEXT;

-- PARKED (HELD) SALES --------------------------------------------------------
-- A hold is a cart set aside so the counter can serve the next customer -- the
-- customer went to the car for a wallet, or is deciding on a second part. It is
-- deliberately NOT a pos_sales row: nothing has been tendered, no stock should
-- move, no receipt number should be burned, and it must never appear in a sales
-- report. It is a serialised cart plus who it belongs to, and it either gets
-- recalled or it gets discarded.
CREATE TABLE pos_holds (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  hold_number     TEXT UNIQUE,
  label           TEXT,           -- what the counter will recognise it by
  customer_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  customer_name   TEXT,
  customer_phone  TEXT,
  vehicle_info    TEXT,
  sales_rep_id    INTEGER REFERENCES mechanics(id) ON DELETE SET NULL,
  sales_rep_name  TEXT,
  items_json      TEXT NOT NULL,  -- the cart exactly as it stood
  subtotal_cents  INTEGER NOT NULL DEFAULT 0,
  notes           TEXT,
  held_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_pos_holds_created ON pos_holds (created_at DESC);

-- QUOTES ---------------------------------------------------------------------
-- Quotes gained the same customer/rep identity as sales so a quote can be
-- turned into a sale without re-keying who it was for, and a converted_sale_id
-- so an accepted quote stops showing as open work.
ALTER TABLE pos_quotes ADD COLUMN customer_id       INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE pos_quotes ADD COLUMN customer_email    TEXT;
ALTER TABLE pos_quotes ADD COLUMN sales_rep_id      INTEGER REFERENCES mechanics(id) ON DELETE SET NULL;
ALTER TABLE pos_quotes ADD COLUMN sales_rep_name    TEXT;
ALTER TABLE pos_quotes ADD COLUMN notes             TEXT;
ALTER TABLE pos_quotes ADD COLUMN converted_sale_id INTEGER REFERENCES pos_sales(id) ON DELETE SET NULL;
ALTER TABLE pos_quotes ADD COLUMN created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- RETURNS / REFUNDS ----------------------------------------------------------
-- Voiding reverses a whole sale and only makes sense the same day. A return is
-- the other case: the customer brings back two of the four filters a week
-- later. It is recorded per line so stock goes back accurately and so the
-- original sale still reads as what was actually sold.
CREATE TABLE pos_returns (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  return_number     TEXT UNIQUE,
  sale_id           INTEGER NOT NULL REFERENCES pos_sales(id) ON DELETE CASCADE,
  reason            TEXT,
  refund_method     TEXT,          -- cash|card|account_credit|exchange
  refund_cents      INTEGER NOT NULL DEFAULT 0,
  restock           INTEGER NOT NULL DEFAULT 1,
  processed_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  notes             TEXT,
  created_at        TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_pos_returns_sale ON pos_returns (sale_id);

CREATE TABLE pos_return_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  return_id       INTEGER NOT NULL REFERENCES pos_returns(id) ON DELETE CASCADE,
  sale_item_id    INTEGER REFERENCES pos_sale_items(id) ON DELETE SET NULL,
  product_img     TEXT,
  description     TEXT,
  qty             INTEGER NOT NULL DEFAULT 1,
  refund_cents    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_pos_return_items_ret ON pos_return_items (return_id);
