-- Supplier payments (accounts payable) -- logs money paid out against a
-- purchase order. Scoped to one PO, not a running per-supplier ledger: the
-- customer side settles a whole account at once (account_payments) because
-- a charge sale has no per-invoice balance to track, but a PO already is
-- the natural unit of "what's owed" here, so a payment applies against one.
ALTER TABLE purchase_orders ADD COLUMN amount_paid_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE purchase_orders ADD COLUMN balance_due_cents INTEGER NOT NULL DEFAULT 0;

CREATE TABLE purchase_order_payments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  po_id        INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL,
  method       TEXT,
  reference    TEXT,
  notes        TEXT,
  received_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_po_payments_po ON purchase_order_payments (po_id);

-- Existing POs start owing their full total -- nothing paid yet.
UPDATE purchase_orders SET balance_due_cents = total_cents;
