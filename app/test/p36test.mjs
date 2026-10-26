// Supplier record tabs (QuickBooks-style vendor screen): the D1 routes behind
// the Bills and Items purchased tabs, and the new vendor fields (TRN, remit-to
// address, terms in days) saving through POST / PATCH.
import { fileURLToPath } from 'node:url';
const APP = new URL('../', import.meta.url).href;
const APP_DIR = fileURLToPath(APP);

import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
process.chdir(APP_DIR);
const sdb = new DatabaseSync(':memory:');
sdb.exec('PRAGMA foreign_keys=ON;');
for (const f of fs.readdirSync('migrations').filter((x) => /^\d+.*\.sql$/.test(x)).sort()) {
  try { sdb.exec(fs.readFileSync('migrations/' + f, 'utf8')); }
  catch (e) { console.log('MIGRATION FAIL', f, e.message.split('\n')[0]); process.exit(1); }
}
function makeDB(db) {
  return { prepare(sql) { return { _sql: sql, _b: [], bind(...b) { this._b = b; return this; },
      all() { return { results: db.prepare(this._sql).all(...this._b) }; },
      first() { const r = db.prepare(this._sql).get(...this._b); return r === undefined ? null : r; },
      run() { const r = db.prepare(this._sql).run(...this._b); return { success: true, meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } }; } }; },
    async batch(s) { const o = []; for (const x of s) o.push(x.run()); return o; } };
}
const ENV = { DB: makeDB(sdb) };

const routes = [];
const rec = (m) => (p, ...h) => routes.push({ m, p, h: h[h.length - 1] });
const app = { get: rec('GET'), post: rec('POST'), patch: rec('PATCH'), delete: rec('DELETE'), put: rec('PUT'), all: rec('ALL') };
(await import(APP + 'functions/_routes/inventory.js')).default(app);
const route = (m, p) => routes.find((r) => r.m === m && r.p === p).h;

let st = 200;
async function call(m, p, { params = {}, query = {}, body } = {}) {
  st = 200;
  const c = {
    env: ENV,
    get: (k) => (k === 'user' ? { id: 1 } : undefined),
    req: { param: (k) => params[k], query: (k) => query[k], json: async () => body || {} },
    json: (o, s) => { if (s) st = s; return o; },
  };
  return route(m, p)(c);
}
const A = (l, ok) => console.log((ok ? 'PASS  ' : 'FAIL  ') + l);

// ---- vendor fields save ----
let r = await call('POST', '/api/admin/suppliers', { body: { name: 'Toyota Tsusho', tax_id: '123-456-789', remit_address: 'PO Box 9, Kingston', payment_terms_days: '30' } });
const sid = r.id;
let s = sdb.prepare('SELECT tax_id, remit_address, payment_terms_days FROM suppliers WHERE id = ?').get(sid);
A('POST saves tax_id, remit_address, payment_terms_days', s.tax_id === '123-456-789' && s.remit_address === 'PO Box 9, Kingston' && s.payment_terms_days === 30);

await call('PATCH', '/api/admin/suppliers/:id', { params: { id: String(sid) }, body: { payment_terms_days: '', tax_id: '999' } });
s = sdb.prepare('SELECT tax_id, payment_terms_days FROM suppliers WHERE id = ?').get(sid);
A('PATCH: cleared terms box -> NULL, tax_id updated', s.payment_terms_days === null && s.tax_id === '999');

r = await call('GET', '/api/admin/suppliers');
A('GET /suppliers returns the new fields', r.suppliers.some((x) => x.id === sid && x.tax_id === '999' && 'remit_address' in x));

// ---- bills + items ----
const other = (await call('POST', '/api/admin/suppliers', { body: { name: 'Other Parts Ltd' } })).id;
sdb.exec(`INSERT INTO purchase_orders (id, po_number, supplier_id, status, total_cents, invoice_number, received_date, created_at) VALUES
  (901, 'PO-901', ${sid}, 'received', 25000, 'INV-77', '2026-09-02 10:00:00', '2026-09-01 09:00:00'),
  (902, 'PO-902', ${sid}, 'draft',    4000,  NULL,     NULL,                  '2026-10-01 09:00:00'),
  (903, 'PO-903', ${sid}, 'cancelled', 9000, 'INV-X',  NULL,                  '2026-08-01 09:00:00'),
  (904, 'PO-904', ${other}, 'received', 7000, 'INV-O', '2026-09-05 10:00:00', '2026-09-05 09:00:00');`);
sdb.exec(`INSERT INTO purchase_order_items (po_id, description, qty_ordered, unit_cost_cents, total_cents, qty_received, sku) VALUES
  (901, 'Brake pads', 10, 1500, 15000, 10, 'BP-1'),
  (901, 'Oil filter', 20, 500, 10000, 18, 'OF-2'),
  (902, 'Wiper blade', 4, 1000, 4000, 0, 'WB-3'),
  (903, 'Cancelled thing', 1, 9000, 9000, 0, NULL),
  (904, 'Not ours', 7, 1000, 7000, 7, NULL);`);

r = await call('GET', '/api/admin/suppliers/:id/bills', { params: { id: String(sid) } });
A('bills: only invoiced/received, not draft or cancelled, not other supplier', r.bills.length === 1 && r.bills[0].number === 'INV-77');
A('bills: amount, date and totals', r.bills[0].amount === 250 && r.bills[0].day === '2026-09-02' && r.totals.billed === 250);
A('bills: paid/open unknown on the website (null, not 0)', r.bills[0].paid === null && r.bills[0].open === null && r.payments_tracked === false);

r = await call('GET', '/api/admin/suppliers/:id/items', { params: { id: String(sid) } });
const names = r.items.map((x) => x.item);
A('items: PO lines for this supplier, not draft or cancelled POs', r.items.length === 2 && !names.includes('Wiper blade') && !names.includes('Cancelled thing') && !names.includes('Not ours'));
const oil = r.items.find((x) => x.item === 'Oil filter');
A('items: qty, received, unit cost, total, PO number', oil.qty === 20 && oil.qty_received === 18 && oil.unit_cost === 5 && oil.total === 100 && oil.ref === 'PO-901' && oil.po_id === 901);
sdb.exec(`INSERT INTO purchase_orders (id, po_number, supplier_id, status, total_cents, created_at) VALUES (905, 'PO-905', ${sid}, 'ordered', 3000, '2026-10-10 09:00:00');
  INSERT INTO purchase_order_items (po_id, description, qty_ordered, unit_cost_cents, total_cents, qty_received) VALUES (905, 'Air filter', 3, 1000, 3000, 0);`);
r = await call('GET', '/api/admin/suppliers/:id/items', { params: { id: String(sid) } });
A('items: newest first', r.items[0].item === 'Air filter' && r.items.length === 3);

r = await call('GET', '/api/admin/suppliers/:id/items', { params: { id: 'x' } });
A('bad id -> 400', st === 400);
