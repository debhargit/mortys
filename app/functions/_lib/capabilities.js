// Copied verbatim from server.js — the single source of truth for what a
// "function permission" is. GET /api/admin/capabilities serves this; userCan()
// (guards.js) enforces it as a deny-list.
export const CAPABILITIES = [
  { key: 'pos.access',             group: 'POS',       label: 'Open the POS terminal' },
  { key: 'pos.finalise_invoice',   group: 'POS',       label: 'Ring a sale / invoice at checkout (off = checkout saves an order for a cashier)' },
  { key: 'cashier.access',         group: 'POS',       label: 'Open the Cashier module (take payment on POS orders)' },
  { key: 'pos.line_discount',      group: 'POS',       label: 'Give a per-line discount' },
  { key: 'pos.ticket_discount',    group: 'POS',       label: 'Give a whole-ticket discount' },
  { key: 'pos.price_override',     group: 'POS',       label: 'Change a line’s unit price' },
  { key: 'pos.qty_update',         group: 'POS',       label: 'Change a line’s quantity' },
  { key: 'pos.charge_to_account',  group: 'POS',       label: 'Take a charge / account sale' },
  { key: 'pos.no_tax',            group: 'POS',        label: 'Switch GCT off on a ticket' },
  { key: 'pos.add_customer',       group: 'POS',       label: 'Add a new customer' },
  { key: 'pos.edit_customer',      group: 'POS',       label: 'Edit customer details' },
  { key: 'pos.void_sale',          group: 'POS',       label: 'Void a sale' },
  { key: 'pos.refund',             group: 'POS',       label: 'Process a return / refund' },
  { key: 'pos.hold_recall',        group: 'POS',       label: 'Hold and recall tickets' },
  { key: 'pos.open_close_shift',   group: 'POS',       label: 'Open / close a cash-drawer shift' },
  { key: 'pos.reprint_receipt',    group: 'POS',       label: 'Reprint a receipt' },
  { key: 'inventory.edit_price',   group: 'Inventory', label: 'Edit a product price' },
  { key: 'inventory.adjust_stock', group: 'Inventory', label: 'Adjust stock counts' },
  { key: 'customers.view_balances', group: 'Customers', label: 'See customer account balances' },
  { key: 'reports.view',           group: 'Reports',   label: 'View reports' },
];
export const CAPABILITY_KEYS = new Set(CAPABILITIES.map((c) => c.key));
