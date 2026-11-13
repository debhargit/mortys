// =============================================================================
//  store-tax.js -- Store GCT setup, tax rates per item, freight by delivery
//  method, and bulk inventory changes (2026-11-05)
//
//  GCT
//    * Store switch (warehouse_settings gct_enabled): off = no GCT on any sale.
//    * Per store (store_locations.gct_enabled): a branch that is not taxable
//      charges no GCT; the sale's store is its till's store, else the main one.
//    * Tax rates (tax_classes): Standard 15%, Zero-rated, Exempt, plus any
//      other rate (e.g. Phones 20%). One is the default.
//    * Rate per category (category_tax) and per item (products.tax_class).
//      Item beats category beats the default.
//    * gct_ticket_toggle: whether the till may switch GCT off for one ticket
//      (off by default now that GCT is set up here).
//    * A tax-exempt customer (users.tax_exempt, set on the account) still pays
//      no GCT; a department type with GCT off or a different rate (dept-types)
//      is applied by the sale route through compute().
//  Freight (freight_rules): per delivery method (delivery / shipping) a flat
//  fee, a fee per parish, free over an amount; freight_taxable says whether
//  GCT is charged on it. The till asks /api/store/freight-quote.
//  Bulk change (/api/inventory/bulk/*): pick items by search + filters, then
//  set or move price, category, quantity, tax rate, location or status, with
//  a preview first, a log of every change and an undo.
// =============================================================================
'use strict';

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const PARISHES = ['Kingston', 'St. Andrew', 'St. Catherine', 'Clarendon', 'Manchester', 'St. Elizabeth', 'Westmoreland',
  'Hanover', 'St. James', 'Trelawny', 'St. Ann', 'St. Mary', 'Portland', 'St. Thomas'];
const DEFAULT_FREIGHT = {
  delivery: { label: 'Delivery', mode: 'flat', flat: 0, parishes: {}, free_over: 0 },
  shipping: { label: 'Freight', mode: 'flat', flat: 0, parishes: {}, free_over: 0 },
};

let ready = null;
function ensure(query) {
  if (!ready) ready = (async () => {
    await query(`CREATE TABLE IF NOT EXISTS tax_classes (
        code TEXT PRIMARY KEY, name TEXT NOT NULL, rate NUMERIC(5,2) NOT NULL DEFAULT 0,
        kind TEXT NOT NULL DEFAULT 'standard' CHECK (kind IN ('standard','zero','exempt')),
        is_default BOOLEAN NOT NULL DEFAULT false, sort INTEGER NOT NULL DEFAULT 0, is_active BOOLEAN NOT NULL DEFAULT true)`);
    await query(`INSERT INTO tax_classes (code, name, rate, kind, is_default, sort) VALUES
        ('STD', 'Standard GCT', 15, 'standard', true, 0), ('ZERO', 'Zero-rated', 0, 'zero', false, 8), ('EXEMPT', 'Exempt', 0, 'exempt', false, 9)
        ON CONFLICT (code) DO NOTHING`);
    await query(`CREATE TABLE IF NOT EXISTS category_tax (category TEXT PRIMARY KEY, tax_class TEXT NOT NULL REFERENCES tax_classes(code) ON UPDATE CASCADE)`);
    await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS tax_class TEXT`);
    await query(`ALTER TABLE pos_sale_items ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(5,2)`);
    await query(`ALTER TABLE pos_sale_items ADD COLUMN IF NOT EXISTS tax_usd NUMERIC(12,2)`);
    await query(`ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS freight_tax_usd NUMERIC(12,2)`);
    await query(`INSERT INTO warehouse_settings (key, value) VALUES ('gct_enabled','on'), ('gct_ticket_toggle','off'), ('freight_taxable','on')
        ON CONFLICT (key) DO NOTHING`);
    await query(`CREATE TABLE IF NOT EXISTS inventory_bulk_batches (
        id SERIAL PRIMARY KEY, created_at TIMESTAMPTZ DEFAULT NOW(), by_user INTEGER, by_name TEXT,
        summary TEXT, filter JSONB, action JSONB, items INTEGER NOT NULL DEFAULT 0, undone_at TIMESTAMPTZ, undone_by TEXT)`);
    await query(`CREATE TABLE IF NOT EXISTS inventory_bulk_lines (
        batch_id INTEGER NOT NULL REFERENCES inventory_bulk_batches(id) ON DELETE CASCADE,
        product_img TEXT NOT NULL, field TEXT NOT NULL, before TEXT, after TEXT)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_inv_bulk_lines ON inventory_bulk_lines (batch_id)`);
    await query(`ALTER TABLE store_locations ADD COLUMN IF NOT EXISTS gct_enabled BOOLEAN NOT NULL DEFAULT true`).catch(() => {});
  })().catch((e) => { ready = null; throw e; });
  return ready;
}

async function setting(query, key, dflt) {
  const { rows } = await query('SELECT value FROM warehouse_settings WHERE key = $1', [key]);
  return rows.length && rows[0].value != null ? rows[0].value : dflt;
}
async function putSetting(query, key, value) {
  await query(`INSERT INTO warehouse_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, String(value)]);
}

// The store a request is selling from: the till's store (X-Station-Key), else null (= main store).
async function stationLoc(query, req) {
  const key = req && req.get && req.get('x-station-key');
  if (!key) return null;
  try {
    const { rows } = await query('SELECT location_id FROM pos_stations WHERE device_key_hash = $1 AND is_active', [require('crypto').createHash('sha256').update(String(key)).digest('hex')]);
    return rows[0] ? rows[0].location_id : null;
  } catch (_) { return null; }
}
// Whether that store charges GCT. null = the main (default) store. Unknown = yes.
async function storeGctOn(query, locId) {
  try {
    await ensure(query);
    const { rows } = await query(`SELECT gct_enabled FROM store_locations WHERE id = COALESCE($1::int, (SELECT id FROM store_locations WHERE is_default ORDER BY id LIMIT 1))`, [locId || null]);
    return rows.length ? rows[0].gct_enabled !== false : true;
  } catch (_) { return true; }
}

// Everything the till and the sale route need to work GCT out. With req, also
// says which store this till is in and whether that store charges GCT.
async function config(query, req) {
  await ensure(query);
  const [{ rows: classes }, { rows: cats }] = await Promise.all([
    query(`SELECT code, name, rate::float AS rate, kind, is_default FROM tax_classes WHERE is_active ORDER BY sort, code`),
    query(`SELECT category, tax_class FROM category_tax`),
  ]);
  const def = classes.find((c) => c.is_default) || classes[0] || { code: 'STD', rate: 15, kind: 'standard' };
  let freight = DEFAULT_FREIGHT;
  try { freight = Object.assign({}, DEFAULT_FREIGHT, JSON.parse(await setting(query, 'freight_rules', '{}'))); } catch (_) {}
  return {
    enabled: (await setting(query, 'gct_enabled', 'on')) === 'on',
    ticket_toggle: (await setting(query, 'gct_ticket_toggle', 'off')) === 'on',
    freight_taxable: (await setting(query, 'freight_taxable', 'on')) === 'on',
    default_class: def.code, default_rate: def.rate,
    classes, categories: Object.fromEntries(cats.map((c) => [c.category, c.tax_class])), freight, parishes: PARISHES,
    stores: await query(`SELECT id, name, is_default, gct_enabled FROM store_locations WHERE is_active ORDER BY sort, id`).then((r) => r.rows).catch(() => []),
    store: req ? await (async () => {
      const loc = await stationLoc(query, req);
      const { rows } = await query(`SELECT id, name, gct_enabled FROM store_locations WHERE id = COALESCE($1::int, (SELECT id FROM store_locations WHERE is_default ORDER BY id LIMIT 1))`, [loc]).catch(() => ({ rows: [] }));
      return rows[0] || null;
    })() : undefined,
  };
}

// Rate (%) for each product: item class, else its category's, else default.
async function ratesFor(query, imgs, cfg) {
  const out = {};
  const uniq = [...new Set((imgs || []).filter(Boolean))];
  if (!uniq.length) return out;
  const byCode = Object.fromEntries(cfg.classes.map((c) => [c.code, c]));
  const { rows } = await query(`SELECT img, tax_class, lower(category) AS category FROM products WHERE img = ANY($1)`, [uniq]);
  for (const p of rows) {
    const code = (p.tax_class && byCode[p.tax_class]) ? p.tax_class : (cfg.categories[p.category] && byCode[cfg.categories[p.category]]) ? cfg.categories[p.category] : cfg.default_class;
    const c = byCode[code] || { code: cfg.default_class, rate: cfg.default_rate, kind: 'standard' };
    out[p.img] = { code: c.code, rate: Number(c.rate), kind: c.kind, standard: c.code === cfg.default_class };
  }
  return out;
}

// GCT for one sale.
//   lines: [{img, net}]  net after line discounts
//   ticketDisc: whole-ticket discounts (operator, loyalty, coupon), spread
//               across lines by value
//   opts: {exempt, deptGct: 'standard'|'custom'|'off', deptRate}
// Returns {tax, goods_tax, freight_tax, lines:[{rate, tax}]}
function compute(cfg, rates, lines, ticketDisc, shipFee, opts) {
  const o = opts || {};
  const sub = lines.reduce((s, l) => s + Math.max(0, Number(l.net) || 0), 0);
  const share = sub > 0 ? Math.max(0, sub - Math.max(0, Number(ticketDisc) || 0)) / sub : 0;
  const off = !cfg.enabled || o.exempt || o.deptGct === 'off';
  const stdRate = o.deptGct === 'custom' && o.deptRate != null ? Number(o.deptRate) : cfg.default_rate;
  const out = lines.map((l) => {
    const r = rates[l.img];
    let rate = r ? r.rate : cfg.default_rate;
    if (r ? r.standard : true) rate = stdRate;       // a department's own rate replaces the standard one only
    if (off) rate = 0;
    return { rate, tax: r2(Math.max(0, Number(l.net) || 0) * share * rate / 100) };
  });
  const goodsTax = r2(out.reduce((s, l) => s + l.tax, 0));
  const freightTax = off || !cfg.freight_taxable ? 0 : r2((Number(shipFee) || 0) * stdRate / 100);
  return { tax: r2(goodsTax + freightTax), goods_tax: goodsTax, freight_tax: freightTax, lines: out };
}

function freightQuote(cfg, method, parish, goods) {
  const m = cfg.freight[method];
  if (!m || method === 'pickup') return { fee: 0, label: null };
  const g = Number(goods) || 0;
  if (Number(m.free_over) > 0 && g >= Number(m.free_over)) return { fee: 0, label: m.label, free: true };
  let fee = Number(m.flat) || 0;
  if (m.mode === 'parish' && parish && m.parishes && m.parishes[parish] != null && m.parishes[parish] !== '') fee = Number(m.parishes[parish]) || 0;
  return { fee: r2(fee), label: m.label || (method === 'shipping' ? 'Freight' : 'Delivery') };
}

// ------------------------------------------------------------- bulk change --
const ACTIONS = {
  price: { cap: 'inventory.edit_price', field: 'price_usd' },
  cost: { cap: 'inventory.edit_price', field: 'cost_usd' },
  category: { cap: 'inventory.bulk_change', field: 'category' },
  qty: { cap: 'inventory.adjust_stock', field: 'stock_count' },
  tax: { cap: 'inventory.bulk_change', field: 'tax_class' },
  location: { cap: 'inventory.bulk_change', field: 'location' },
  bin: { cap: 'inventory.bulk_change', field: 'bin_location' },
  status: { cap: 'inventory.bulk_change', field: 'is_active' },
  supplier: { cap: 'inventory.bulk_change', field: 'supplier_id' },
};

function whereFor(f) {
  const w = [], p = [];
  const add = (sql, v) => { p.push(v); w.push(sql.replace(/\?/g, '$' + p.length)); };
  if (Array.isArray(f.imgs) && f.imgs.length) add('p.img = ANY(?)', f.imgs.map(String).slice(0, 20000));
  if (f.q && String(f.q).trim()) {
    for (const word of String(f.q).trim().split(/\s+/).slice(0, 8)) {
      add(`(p.name ILIKE ? OR p.sku ILIKE ? OR COALESCE(p.barcode,'') ILIKE ? OR COALESCE(p.make_model,'') ILIKE ? OR p.img ILIKE ?)`, '%' + word + '%');
    }
  }
  const list = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((x) => String(x).trim()).filter(Boolean);
  if (list(f.categories).length) add('lower(p.category) = ANY(?)', list(f.categories).map((x) => x.toLowerCase()));
  if (f.location) add(`COALESCE(p.location,'') ILIKE ?`, String(f.location) + '%');
  if (f.bin) add(`COALESCE(p.bin_location,'') ILIKE ?`, String(f.bin) + '%');
  if (f.supplier_id) add('p.supplier_id = ?', parseInt(f.supplier_id, 10) || 0);
  if (f.condition) add('upper(p.condition) = ?', String(f.condition).toUpperCase());
  if (f.tax_class === 'default') w.push('p.tax_class IS NULL'); else if (f.tax_class) add('p.tax_class = ?', String(f.tax_class));
  if (f.price_min !== undefined && f.price_min !== '') add('p.price_usd >= ?', Number(f.price_min));
  if (f.price_max !== undefined && f.price_max !== '') add('p.price_usd <= ?', Number(f.price_max));
  if (f.stock_min !== undefined && f.stock_min !== '') add('p.stock_count >= ?', Number(f.stock_min));
  if (f.stock_max !== undefined && f.stock_max !== '') add('p.stock_count <= ?', Number(f.stock_max));
  if (f.status === 'inactive') w.push('NOT p.is_active'); else if (f.status !== 'all') w.push('p.is_active');
  return { sql: w.length ? 'WHERE ' + w.join(' AND ') : '', params: p };
}

function roundPrice(v, how) {
  if (how === 'whole') return Math.round(v);
  if (how === '10') return Math.round(v / 10) * 10;
  if (how === '100') return Math.round(v / 100) * 100;
  if (how === '99') return Math.max(0, Math.ceil(v) - 0.01);
  return r2(v);
}

// The new value for one product, or undefined for "no change".
function newValue(a, p, cfg) {
  const v = a.value;
  switch (a.kind) {
    case 'price': case 'cost': {
      const cur = Number(a.kind === 'price' ? p.price_usd : p.cost_usd) || 0;
      let n = a.mode === 'set' ? Number(v) : a.mode === 'pct' ? cur * (1 + Number(v) / 100) : cur + Number(v);
      if (a.kind === 'price' && a.mode === 'markup') n = (Number(p.cost_usd) || 0) * (1 + Number(v) / 100);
      if (!Number.isFinite(n)) return undefined;
      n = Math.max(0, a.kind === 'price' ? roundPrice(n, a.round) : r2(n));
      if (a.kind === 'price' && a.not_below_cost && p.cost_usd != null && n < Number(p.cost_usd)) n = r2(Number(p.cost_usd));
      if (a.kind === 'price' && a.mode === 'markup' && !(Number(p.cost_usd) > 0)) return undefined;   // no cost, can't mark up
      return n;
    }
    case 'qty': {
      const cur = Number(p.stock_count) || 0;
      const n = a.mode === 'set' ? parseInt(v, 10) : cur + parseInt(v, 10);
      return Number.isFinite(n) ? Math.max(0, n) : undefined;
    }
    case 'category': return String(v || '').trim().slice(0, 80) || undefined;
    case 'tax': return v === 'default' || v === '' || v == null ? null : (cfg.classes.some((c) => c.code === v) ? v : undefined);
    case 'location': case 'bin': return String(v == null ? '' : v).trim().slice(0, 80) || null;
    case 'status': return v === 'active' || v === true;
    case 'supplier': return v === '' || v == null ? null : parseInt(v, 10) || undefined;
    default: return undefined;
  }
}
const same = (x, y) => (x == null ? '' : String(x)) === (y == null ? '' : String(y)) || (Number.isFinite(Number(x)) && Number.isFinite(Number(y)) && x !== null && y !== null && x !== '' && y !== '' && Number(x) === Number(y));

function describe(a) {
  const n = (x) => Number(x).toLocaleString('en-JM');
  switch (a.kind) {
    case 'price': return a.mode === 'set' ? 'Price set to J$' + n(a.value) : a.mode === 'pct' ? 'Price ' + (a.value >= 0 ? '+' : '') + a.value + '%' : a.mode === 'markup' ? 'Price = cost + ' + a.value + '%' : 'Price ' + (a.value >= 0 ? '+' : '') + 'J$' + n(a.value);
    case 'cost': return a.mode === 'set' ? 'Cost set to J$' + n(a.value) : a.mode === 'pct' ? 'Cost ' + (a.value >= 0 ? '+' : '') + a.value + '%' : 'Cost ' + (a.value >= 0 ? '+' : '') + 'J$' + n(a.value);
    case 'qty': return a.mode === 'set' ? 'Quantity set to ' + a.value : 'Quantity ' + (a.value >= 0 ? '+' : '') + a.value;
    case 'category': return 'Category → ' + a.value;
    case 'tax': return 'Tax rate → ' + (a.value && a.value !== 'default' ? a.value : 'default (by category)');
    case 'location': return 'Location → ' + (a.value || '(none)');
    case 'bin': return 'Bin → ' + (a.value || '(none)');
    case 'status': return a.value === 'active' ? 'Made active' : 'Made inactive (hidden from sale)';
    case 'supplier': return 'Supplier changed';
    default: return a.kind;
  }
}

function register(app, deps) {
  const { query, getPool, requireAdmin, requireManager, userCan } = deps;   // owners and managers only: requireManager
  const fail = (res, e) => { const s = e.status || 500; if (s >= 500) console.error('[store-tax]', e); res.status(s).json({ error: e.publicMessage || e.message }); };
  const httpError = (s, m) => { const e = new Error(m); e.status = s; e.publicMessage = m; return e; };
  // Tables are created on first use (ensure), never at startup.

  // ---- GCT and freight setup ----------------------------------------------
  app.get('/api/store/tax-config', requireAdmin, async (req, res) => { try { res.json(await config(query, req)); } catch (e) { fail(res, e); } });

  app.put('/api/store/tax-config', requireAdmin, requireManager, async (req, res) => {
    try {
      await ensure(query);
      const b = req.body || {};
      if (b.enabled !== undefined) await putSetting(query, 'gct_enabled', b.enabled ? 'on' : 'off');
      if (b.ticket_toggle !== undefined) await putSetting(query, 'gct_ticket_toggle', b.ticket_toggle ? 'on' : 'off');
      if (b.freight_taxable !== undefined) await putSetting(query, 'freight_taxable', b.freight_taxable ? 'on' : 'off');
      if (b.freight) {
        const clean = {};
        for (const m of ['delivery', 'shipping']) {
          const x = b.freight[m] || {};
          const parishes = {};
          for (const p of PARISHES) if (x.parishes && x.parishes[p] !== undefined && x.parishes[p] !== '' && Number(x.parishes[p]) >= 0) parishes[p] = r2(x.parishes[p]);
          clean[m] = { label: String(x.label || DEFAULT_FREIGHT[m].label).slice(0, 40), mode: x.mode === 'parish' ? 'parish' : 'flat',
            flat: Math.max(0, r2(x.flat)), parishes, free_over: Math.max(0, r2(x.free_over)) };
        }
        await putSetting(query, 'freight_rules', JSON.stringify(clean));
      }
      if (Array.isArray(b.classes)) {
        for (const c of b.classes) {
          const code = String(c.code || '').toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 16);
          if (!code) continue;
          const rate = Number(c.rate);
          if (!(rate >= 0 && rate <= 100)) throw httpError(400, 'Tax rates are 0 to 100%');
          const kind = ['standard', 'zero', 'exempt'].includes(c.kind) ? c.kind : 'standard';
          await query(`INSERT INTO tax_classes (code, name, rate, kind, sort, is_active) VALUES ($1,$2,$3,$4,$5,$6)
                       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, rate = EXCLUDED.rate, kind = EXCLUDED.kind, sort = EXCLUDED.sort, is_active = EXCLUDED.is_active`,
            [code, String(c.name || code).slice(0, 60), kind === 'standard' ? r2(rate) : 0, kind, parseInt(c.sort, 10) || 0, c.is_active !== false]);
        }
        const def = b.classes.find((c) => c.is_default);
        if (def) {
          const code = String(def.code).toUpperCase();
          await query(`UPDATE tax_classes SET is_default = (code = $1)`, [code]);
        }
      }
      if (Array.isArray(b.stores)) {
        for (const st of b.stores) {
          const id = parseInt(st && st.id, 10);
          if (id && st.gct_enabled !== undefined) await query('UPDATE store_locations SET gct_enabled = $1 WHERE id = $2', [!!st.gct_enabled, id]);
        }
      }
      if (b.categories && typeof b.categories === 'object') {
        for (const [cat, cls] of Object.entries(b.categories)) {
          const c = String(cat).toLowerCase().trim();
          if (!c) continue;
          if (!cls || cls === 'default') await query('DELETE FROM category_tax WHERE category = $1', [c]);
          else await query(`INSERT INTO category_tax (category, tax_class) VALUES ($1,$2) ON CONFLICT (category) DO UPDATE SET tax_class = EXCLUDED.tax_class`, [c, String(cls).toUpperCase()]);
        }
      }
      res.json(await config(query, req));
    } catch (e) { if (e.code === '23503') e = httpError(400, 'That tax rate does not exist'); fail(res, e); }
  });

  // Rates for the till's cart lines.
  app.get('/api/store/tax-rates', requireAdmin, async (req, res) => {
    try {
      const cfg = await config(query);
      res.json({ rates: await ratesFor(query, String(req.query.imgs || '').split(',').slice(0, 500), cfg) });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/store/freight-quote', requireAdmin, async (req, res) => {
    try { res.json(freightQuote(await config(query), String(req.query.method || ''), String(req.query.parish || ''), req.query.goods)); } catch (e) { fail(res, e); }
  });

  // ---- bulk change ----------------------------------------------------------
  async function checkAction(req, a) {
    const spec = ACTIONS[a && a.kind];
    if (!spec) throw httpError(400, 'Pick what to change');
    if (!(await userCan(req, 'inventory.bulk_change'))) throw httpError(403, 'Your account is not allowed to bulk-change inventory.');
    if (spec.cap !== 'inventory.bulk_change' && !(await userCan(req, spec.cap))) throw httpError(403, 'Your account is not allowed to change ' + (a.kind === 'qty' ? 'stock quantities' : 'prices') + '.');
    if (['price', 'cost', 'qty'].includes(a.kind) && !Number.isFinite(Number(a.value))) throw httpError(400, 'Enter a number');
    if (a.kind === 'category' && !String(a.value || '').trim()) throw httpError(400, 'Enter the new category');
    return spec;
  }
  async function plan(req) {
    const b = req.body || {};
    const a = b.action || {};
    const spec = await checkAction(req, a);
    const cfg = await config(query);
    const w = whereFor(b.filter || {});
    const { rows } = await query(`SELECT p.img, p.name, p.sku, p.category, p.price_usd::float AS price_usd, p.cost_usd::float AS cost_usd, p.stock_count, p.tax_class,
        p.location, p.bin_location, p.is_active, p.supplier_id FROM products p ${w.sql} ORDER BY p.name LIMIT 20001`, w.params);
    if (rows.length > 20000) throw httpError(400, 'More than 20,000 items match. Narrow the search.');
    const changes = [];
    for (const p of rows) {
      const nv = newValue(a, p, cfg);
      if (nv === undefined) continue;
      const before = p[spec.field];
      if (same(before, nv)) continue;
      changes.push({ img: p.img, name: p.name, sku: p.sku, category: p.category, field: spec.field, before, after: nv });
    }
    return { a, spec, matched: rows.length, changes };
  }

  app.post('/api/inventory/bulk/preview', requireAdmin, requireManager, async (req, res) => {
    try {
      const pl = await plan(req);
      res.json({ matched: pl.matched, changing: pl.changes.length, summary: describe(pl.a), rows: pl.changes.slice(0, 300) });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/inventory/bulk/apply', requireAdmin, requireManager, async (req, res) => {
    const pl = await plan(req).catch((e) => { fail(res, e); return null; });
    if (!pl) return;
    if (!pl.changes.length) return res.json({ ok: true, changed: 0 });
    if ((req.body || {}).expect != null && Number(req.body.expect) !== pl.changes.length)
      return res.status(409).json({ error: 'The items changed since the preview (' + pl.changes.length + ' now, ' + req.body.expect + ' before). Preview again.' });
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const { rows: u } = await client.query('SELECT id, name FROM users WHERE id = $1', [req.session.userId]);
      const who = u[0] || { id: null, name: null };
      const { rows: bt } = await client.query(`INSERT INTO inventory_bulk_batches (by_user, by_name, summary, filter, action, items) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [who.id, who.name, describe(pl.a), JSON.stringify((req.body || {}).filter || {}), JSON.stringify(pl.a), pl.changes.length]);
      const id = bt[0].id, f = pl.spec.field;
      for (const c of pl.changes) {
        await client.query(`UPDATE products SET ${f} = $1, updated_at = NOW() WHERE img = $2`, [c.after, c.img]);
        await client.query(`INSERT INTO inventory_bulk_lines (batch_id, product_img, field, before, after) VALUES ($1,$2,$3,$4,$5)`,
          [id, c.img, f, c.before == null ? null : String(c.before), c.after == null ? null : String(c.after)]);
        if (f === 'stock_count') {
          await client.query(`INSERT INTO warehouse_activity (kind, product_img, product_id, qty_before, qty_after, qty_delta, ref_kind, ref_id, notes)
                              VALUES ('adjust', $1, (SELECT id FROM products WHERE img = $1), $2, $3, $4, 'bulk', $5, $6)`,
            [c.img, c.before, c.after, Number(c.after) - Number(c.before || 0), id, 'Bulk change #' + id + ' by ' + (who.name || 'staff')]);
        }
      }
      await client.query('COMMIT');
      res.json({ ok: true, batch_id: id, changed: pl.changes.length, summary: describe(pl.a) });
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); fail(res, e); } finally { client.release(); }
  });

  app.get('/api/inventory/bulk/history', requireAdmin, async (req, res) => {
    try {
      await ensure(query);
      const { rows } = await query(`SELECT id, created_at, by_name, summary, items, undone_at, undone_by, filter FROM inventory_bulk_batches ORDER BY id DESC LIMIT 100`);
      res.json({ batches: rows });
    } catch (e) { fail(res, e); }
  });

  // Undo a batch: puts back the old value on every item still holding the
  // value the batch gave it (an item changed since is left alone and listed).
  app.post('/api/inventory/bulk/:id(\\d+)/undo', requireAdmin, requireManager, async (req, res) => {
    const client = await getPool().connect();
    try {
      if (!(await userCan(req, 'inventory.bulk_change'))) throw httpError(403, 'Your account is not allowed to bulk-change inventory.');
      await client.query('BEGIN');
      const { rows: bt } = await client.query('SELECT * FROM inventory_bulk_batches WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!bt.length) throw httpError(404, 'Not found');
      if (bt[0].undone_at) throw httpError(400, 'Already undone');
      const a = bt[0].action || {};
      const spec = ACTIONS[a.kind];
      if (spec && spec.cap !== 'inventory.bulk_change' && !(await userCan(req, spec.cap))) throw httpError(403, 'Your account cannot undo this change.');
      const { rows: lines } = await client.query('SELECT * FROM inventory_bulk_lines WHERE batch_id = $1', [req.params.id]);
      let undone = 0; const skipped = [];
      const { rows: u } = await client.query('SELECT name FROM users WHERE id = $1', [req.session.userId]);
      for (const l of lines) {
        const { rows: cur } = await client.query(`SELECT ${l.field}::text AS v FROM products WHERE img = $1`, [l.product_img]);
        if (!cur.length) continue;
        if (!same(cur[0].v === 'true' ? 'true' : cur[0].v === 'false' ? 'false' : cur[0].v, l.after)) { skipped.push(l.product_img); continue; }
        await client.query(`UPDATE products SET ${l.field} = $1, updated_at = NOW() WHERE img = $2`, [l.before, l.product_img]);
        if (l.field === 'stock_count') {
          await client.query(`INSERT INTO warehouse_activity (kind, product_img, product_id, qty_before, qty_after, qty_delta, ref_kind, ref_id, notes)
                              VALUES ('adjust', $1, (SELECT id FROM products WHERE img = $1), $2, $3, $4, 'bulk_undo', $5, $6)`,
            [l.product_img, Number(l.after), Number(l.before || 0), Number(l.before || 0) - Number(l.after), bt[0].id, 'Undo bulk change #' + bt[0].id]);
        }
        undone++;
      }
      await client.query('UPDATE inventory_bulk_batches SET undone_at = NOW(), undone_by = $2 WHERE id = $1', [req.params.id, u[0] ? u[0].name : null]);
      await client.query('COMMIT');
      res.json({ ok: true, undone, skipped: skipped.length, skipped_items: skipped.slice(0, 50) });
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); fail(res, e); } finally { client.release(); }
  });

  // Lists for the pickers on the bulk page.
  app.get('/api/inventory/bulk/options', requireAdmin, async (req, res) => {
    try {
      const cfg = await config(query);
      const [cats, locs, sups] = await Promise.all([
        query(`SELECT category, COUNT(*)::int AS n FROM products WHERE category IS NOT NULL AND category <> '' GROUP BY 1 ORDER BY 1`),
        query(`SELECT location, COUNT(*)::int AS n FROM products WHERE COALESCE(location,'') <> '' GROUP BY 1 ORDER BY 1 LIMIT 500`),
        query(`SELECT id, name FROM suppliers ORDER BY name LIMIT 1000`).catch(() => ({ rows: [] })),
      ]);
      res.json({ categories: cats.rows, locations: locs.rows, suppliers: sups.rows, tax_classes: cfg.classes, default_class: cfg.default_class });
    } catch (e) { fail(res, e); }
  });
}

module.exports = { register, config, ratesFor, compute, freightQuote, ensure, whereFor, newValue, storeGctOn };
