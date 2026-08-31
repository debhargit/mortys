import { fileURLToPath } from 'node:url';
// Portable base: this file lives in app/test/, so app/ is one level up.
const APP = new URL('../', import.meta.url).href;            // file:///.../app/
const APP_DIR = fileURLToPath(APP);                          // native path

// Phase 6 — mount the REAL functions/_routes/inventory.js against a fake Hono
// app + a D1 shim over node:sqlite, and drive each endpoint. Guards are passed
// as middleware args; the fake app.<verb>() ignores them, so no session needed.
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
process.chdir(APP_DIR);

const sdb = new DatabaseSync(':memory:');
sdb.exec('PRAGMA foreign_keys=ON;');
for (const f of fs.readdirSync('migrations').filter((x) => /^\d+.*\.sql$/.test(x)).sort()) {
  try { sdb.exec(fs.readFileSync('migrations/' + f, 'utf8')); }
  catch (e) { console.log('MIGRATION FAIL', f, e.message.split('\n')[0]); process.exit(1); }
}
console.log('migrations 0001-0019 OK');

// ---- D1 shim -------------------------------------------------------------
function makeDB(db) {
  return {
    prepare(sql) {
      return {
        _sql: sql, _b: [],
        bind(...b) { this._b = b; return this; },
        all() { return { results: db.prepare(this._sql).all(...this._b) }; },
        first() { const r = db.prepare(this._sql).get(...this._b); return r === undefined ? null : r; },
        run() { const r = db.prepare(this._sql).run(...this._b); return { success: true, meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } }; },
      };
    },
    async batch(stmts) { const out = []; for (const s of stmts) out.push(s.run()); return out; },
  };
}
const ENV = { DB: makeDB(sdb) };

// ---- fake Hono app -----------------------------------------------------
const routes = [];
const app = {};
for (const verb of ['get', 'post', 'patch', 'delete', 'put']) {
  app[verb] = (path, ...rest) => { routes.push({ verb, path, handler: rest[rest.length - 1] }); };
}
const mod = await import(APP + 'functions/_routes/inventory.js');
mod.default(app);
console.log('mounted', routes.length, 'routes');

function match(verb, url) {
  const [pathOnly, qs] = url.split('?');
  const query = Object.fromEntries(new URLSearchParams(qs || ''));
  for (const r of routes) {
    if (r.verb !== verb) continue;
    const rp = r.path.split('/'); const up = pathOnly.split('/');
    if (rp.length !== up.length) continue;
    const params = {}; let ok = true;
    for (let i = 0; i < rp.length; i++) {
      if (rp[i].startsWith(':')) params[rp[i].slice(1)] = decodeURIComponent(up[i]);
      else if (rp[i] !== up[i]) { ok = false; break; }
    }
    if (ok) return { r, params, query };
  }
  return null;
}

const USER = { id: 301, is_admin: 1, admin_role: 'owner', perms: '{}' };
let lastStatus = 200;
async function call(verb, url, { body, form, headers } = {}) {
  const m = match(verb, url);
  if (!m) throw new Error('no route for ' + verb + ' ' + url);
  lastStatus = 200;
  const c = {
    env: ENV,
    get: (k) => (k === 'user' ? USER : undefined),
    req: {
      param: (n) => m.params[n],
      query: (n) => (n == null ? m.query : m.query[n]),
      header: (n) => (headers || {})[n.toLowerCase()],
      json: async () => body || {},
      parseBody: async () => form || {},
    },
    json: (obj, status) => { if (status) lastStatus = status; return { _json: obj, status: status || 200 }; },
    body: (data, status, hdrs) => { if (status) lastStatus = status; return { _body: data, status: status || 200, hdrs }; },
  };
  const res = await m.r.handler(c);
  return res._json !== undefined ? res._json : res;
}

const A = (label, cond) => console.log((cond ? 'PASS  ' : 'FAIL  ') + label);
const q1 = (sql, ...p) => sdb.prepare(sql).get(...p);

// ===== seed =====
// distinctive names/skus so searches don't collide with the 22977 seeded parts
sdb.exec(`
INSERT INTO users (id,email,name,password_hash,is_admin,admin_role) VALUES (301,'boss@x.com','Boss','h',1,'owner');
INSERT INTO products (img,name,make_model,category,condition,price_cents,cost_cents,stock_count,low_threshold,sku,is_active) VALUES
 ('ZZT-45022','ZZTEST Brake Pad Set','ZZTEST Civic','Brakes','NEW',3800,2000,5,4,'ZZT-45022',1),
 ('ZZT-15400','ZZTEST Oil Filter','ZZTEST Accord','Filters','NEW',900,400,2,4,'ZZT-15400',1);
`);

// ===== suppliers =====
let r = await call('post', '/api/admin/suppliers', { body: { name: 'Kingston Parts', code: 'KP', lead_time_days: 5, payment_terms: 'NET30' } });
A('supplier created', r.ok && r.id);
const supId = r.id;
r = await call('post', '/api/admin/suppliers', { body: { name: 'Dup', code: 'KP' } });
A('duplicate supplier code rejected', lastStatus === 400 && /already in use/.test(r.error || ''));
r = await call('get', '/api/admin/suppliers?active=true');
A('supplier list returns row w/ bool is_active', Array.isArray(r.suppliers) && r.suppliers[0].is_active === true && r.suppliers.some((s) => s.code === 'KP'));
await call('patch', '/api/admin/suppliers/' + supId, { body: { phone: '876-555-1000', lead_time_days: 7 } });
A('supplier patched', q1('SELECT phone,lead_time_days FROM suppliers WHERE id=?', supId).phone === '876-555-1000');

// ===== product quick edit =====
await call('patch', '/api/admin/products/ZZT-45022', { body: { price_usd: 42.5, stock_count: 6, supplier_id: supId } });
let p = q1('SELECT price_cents,stock_count,supplier_id FROM products WHERE img=?', 'ZZT-45022');
A('product patch: usd->cents, stock, supplier', p.price_cents === 4250 && p.stock_count === 6 && p.supplier_id === supId);

// ===== products-ext =====
await call('patch', '/api/admin/products-ext/ZZT-15400', { body: { core_charge_usd: 10, env_fee_usd: 1.5, warranty_days: 90, serial_required: true, markup_pct: 35 } });
p = q1('SELECT core_charge_cents,env_fee_cents,warranty_days,serial_required,markup_pct FROM products WHERE img=?', 'ZZT-15400');
A('products-ext patch', p.core_charge_cents === 1000 && p.env_fee_cents === 150 && p.warranty_days === 90 && p.serial_required === 1 && p.markup_pct === 35);
r = await call('get', '/api/admin/products-ext?q=' + encodeURIComponent('zztest,brake'));
A('products-ext search AND-matches terms', r.products.length === 1 && r.products[0].img === 'ZZT-45022' && r.products[0].core_charge_usd === 0);
r = await call('get', '/api/admin/products-ext?low=true&q=' + encodeURIComponent('zztest'));
A('products-ext low filter', r.products.length === 1 && r.products[0].img === 'ZZT-15400');

// ===== purchase orders =====
r = await call('post', '/api/admin/purchase-orders', { body: { supplier_id: supId, expected_date: '2026-09-15', notes: 'restock' } });
A('PO created w/ number', r.ok && /^PO-\d{4}-0001$/.test(r.po_number));
const poId = r.id;
await call('post', '/api/admin/purchase-orders/' + poId + '/items', { body: { product_img: 'ZZT-45022', description: 'Brake pad set', qty_ordered: 10, unit_cost_usd: 21, condition: 'NEW' } });
await call('post', '/api/admin/purchase-orders/' + poId + '/items', { body: { product_img: 'ZZT-15400', description: 'Oil filter', qty_ordered: 20, unit_cost_usd: 4 } });
let po = q1('SELECT subtotal_cents,total_cents FROM purchase_orders WHERE id=?', poId);
A('PO totals recalc after items (2100+... = 10*2100 + 20*400 = 29000)', po.subtotal_cents === 29000 && po.total_cents === 29000);
await call('patch', '/api/admin/purchase-orders/' + poId, { body: { shipping_usd: 50, tax_usd: 0 } });
po = q1('SELECT shipping_cents,total_cents FROM purchase_orders WHERE id=?', poId);
A('PO patch shipping + total recalcs', po.shipping_cents === 5000 && po.total_cents === 34000);
r = await call('get', '/api/admin/purchase-orders/' + poId);
A('PO detail: usd aliases + items joined', r.purchase_order.total_usd === 340 && r.items.length === 2 && r.items[0].description === 'Brake pad set' && r.items[0].unit_cost_usd === 21);
r = await call('get', '/api/admin/purchase-orders?status=draft');
A('PO list filter by status', r.purchase_orders.length === 1 && r.purchase_orders[0].supplier_name === 'Kingston Parts');

// receive PO: partial on line 1 (6 of 10), full on line 2 (20 of 20)
const poItems = sdb.prepare('SELECT id, product_img FROM purchase_order_items WHERE po_id=?').all(poId);
const line1 = poItems.find((x) => x.product_img === 'ZZT-45022').id;
const line2 = poItems.find((x) => x.product_img === 'ZZT-15400').id;
r = await call('post', '/api/admin/purchase-orders/' + poId + '/receive', { body: { items: [
  { id: line1, qty_now: 6, price_now: 45 },
  { id: line2, qty_now: 20, bin_now: 'D-12' },
] } });
A('PO receive -> partial status', r.ok && r.status === 'partial');
p = q1('SELECT stock_count,cost_cents,price_cents FROM products WHERE img=?', 'ZZT-45022');
A('receive bumped stock 6->12, cost 20->21, price->45', p.stock_count === 12 && p.cost_cents === 2100 && p.price_cents === 4500);
p = q1('SELECT stock_count,cost_cents,bin_location FROM products WHERE img=?', 'ZZT-15400');
A('receive line2 stock 2->22, cost->4, bin set', p.stock_count === 22 && p.cost_cents === 400 && p.bin_location === 'D-12');
A('poi qty_received tracked', q1('SELECT qty_received FROM purchase_order_items WHERE id=?', line1).qty_received === 6);

// receive remaining 4 -> received
r = await call('post', '/api/admin/purchase-orders/' + poId + '/receive', { body: { items: [{ id: line1, qty_now: 99 }] } });
A('over-receive clamps to remaining, status -> received', r.status === 'received' && q1('SELECT stock_count FROM products WHERE img=?', 'ZZT-45022').stock_count === 16);

// delete a PO item -> recalc
await call('delete', '/api/admin/purchase-orders/' + poId + '/items/' + line2);
po = q1('SELECT subtotal_cents FROM purchase_orders WHERE id=?', poId);
A('PO item delete recalcs subtotal (10*2100)', po.subtotal_cents === 21000);

// ===== receive without a PO =====
r = await call('post', '/api/admin/receive', { body: { supplier_id: supId, invoice: 'INV-9', items: [
  { sku: 'ZZT-15400', qty: 5, unit_cost_usd: 4.25 },
  { product_img: 'nope.jpg', qty: 1 },
] } });
A('no-PO receive: one ok, one unmatched', r.received === 1 && r.results.find((x) => !x.ok).error.includes('nope.jpg'));
A('no-PO receive bumped p2 stock 22->27', q1('SELECT stock_count FROM products WHERE img=?', 'ZZT-15400').stock_count === 27);
A('no-PO receive logged to warehouse_activity', q1("SELECT COUNT(*) n FROM warehouse_activity WHERE kind='receive' AND product_img='ZZT-15400'").n === 1);

// ===== CSV import =====
r = await call('get', '/api/admin/inventory/import/columns');
A('import columns endpoint', r.fields && Array.isArray(r.fields.sku));

const csv = [
  'Part No,Description,Category,Qty,Price,Bin',
  'ZZT-45022,ZZTEST Brake Pad PREMIUM,Brakes,3,,A-1',        // existing -> update (blank price -> FILL keeps 4500)
  'ZZT-NEW-001,ZZTEST Cabin Air Filter,Filters,12,15.00,B-2',// new -> insert
  'ZZT-NEW-001,ZZTEST Cabin Air Filter DUP,Filters,4,15,B-2',// dup key -> later wins
].join('\r\n');
const buf = Buffer.from(csv, 'utf8');
const fakeFile = { name: 'stock.csv', size: buf.length, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };

r = await call('post', '/api/admin/inventory/import', { form: { file: fakeFile } });
A('import preview: 1 add, 1 update, no commit', r.mode === 'preview' && r.will_add === 1 && r.will_update === 1 && r.committed === false && r.unique_parts === 2);

r = await call('post', '/api/admin/inventory/import?mode=commit', { form: { file: fakeFile } });
A('import commit ok', r.committed === true && r.inserted === 1 && r.updated === 1);
p = q1('SELECT name,stock_count,price_cents FROM products WHERE img=?', 'ZZT-45022');
A('import updated existing: name overwritten, stock overwritten, price is FILL (kept 4500)', p.name === 'ZZTEST Brake Pad PREMIUM' && p.stock_count === 3 && p.price_cents === 4500);
p = q1('SELECT name,category,stock_count,price_cents,sku,is_active FROM products WHERE img=?', 'ZZT-NEW-001');
A('import inserted new row w/ price on insert (1500c), dup later-wins name', p && p.name === 'ZZTEST Cabin Air Filter DUP' && p.stock_count === 4 && p.price_cents === 1500 && p.sku === 'ZZT-NEW-001' && p.is_active === 1);

// deactivate_missing
r = await call('post', '/api/admin/inventory/import?mode=commit&deactivate_missing=true', { form: { file: fakeFile } });
A('deactivate_missing turns off products not in file, keeps ones in it',
  r.deactivated >= 1 &&
  q1('SELECT is_active FROM products WHERE img=?', 'ZZT-15400').is_active === 0 &&
  q1('SELECT is_active FROM products WHERE img=?', 'ZZT-45022').is_active === 1 &&
  q1('SELECT is_active FROM products WHERE img=?', 'ZZT-NEW-001').is_active === 1);

// xlsx refusal
const zip = { name: 'x.xlsx', size: 4, arrayBuffer: async () => new Uint8Array([0x50, 0x4b, 3, 4]).buffer };
r = await call('post', '/api/admin/inventory/import', { form: { file: zip } });
A('xlsx upload refused with guidance', lastStatus === 400 && /csv/i.test(r.error || ''));

console.log('\ndone');
