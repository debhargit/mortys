// The franchise store network end to end, against a REAL server and Postgres.
// Not in the offline suite: it needs a throwaway database.
//
//   FR_TEST_URL=http://localhost:3397 FR_TEST_PSQL="psql -h 127.0.0.1 -p 5499 -U postgres -d frtest" node test/franchise-network-pg-test.mjs
//
// It refuses the live till's ports (3057 / 3058), and stops before writing
// anything unless the server is on the same database as FR_TEST_PSQL (a copied
// app's db-config.json can point it at the live database). It signs in as the
// default admin (password123), so run it only on a fresh database. Run
// franchise-pg-test.mjs first or not at all; they do not depend on each other.
import { execSync } from 'node:child_process';
import zlib from 'node:zlib';

const BASE = process.env.FR_TEST_URL || 'http://localhost:3397';
if (/:(3057|3058)\b/.test(BASE)) { console.log('FAIL refusing to run against the live till port'); process.exit(1); }
const PSQL = process.env.FR_TEST_PSQL;
if (!PSQL) { console.log('FAIL set FR_TEST_PSQL'); process.exit(1); }
let pass = 0, fails = 0;
const ok = (c, m) => { if (c) { pass++; console.log('PASS ' + m); } else { fails++; console.log('FAIL ' + m); } };
const sql = (q) => execSync(PSQL + ' -tA', { input: q, encoding: 'utf8' }).trim();
function client() {
  const jar = {};
  return async function call(method, url, body, raw) {
    const r = await fetch(BASE + url, { method, headers: Object.assign({ Accept: 'application/json', Cookie: Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ') }, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
    for (const c of r.headers.getSetCookie ? r.headers.getSetCookie() : []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
    if (raw) return { status: r.status, text: await r.text() };
    const j = await r.json().catch(() => ({}));
    return Object.assign({ _status: r.status }, j);
  };
}
function png() {
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const w = 60, h = 20, ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0;
  const raw = Buffer.alloc((w + 1) * h); for (let i = 0; i < raw.length; i++) raw[i] = i % (w + 1) === 0 ? 0 : (Math.random() * 256) | 0;
  return 'data:image/png;base64,' + Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}
const SIG = png();
const admin = client(), anon = client();
const stamp = Date.now().toString(36);
const S = stamp.toUpperCase();
const NET = '/api/franchise/network';

// -------------------------------------------- the right database, first --
const marker = String(10 + Math.floor(Math.random() * 40));
sql(`INSERT INTO fr_settings (key, value) VALUES ('link_days', '${marker}') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
let r = await admin('POST', '/api/auth/signin', { email: 'admin@mortysautoparts.com', password: 'password123' });
ok(r._status === 200, 'admin signs in');
r = await admin('GET', '/api/franchise/meta');
if (!r.settings || String(r.settings.link_days) !== marker) { console.log('FAIL the server is not on the FR_TEST_PSQL database; stopping before anything is written'); process.exit(1); }
sql(`DELETE FROM fr_settings WHERE key = 'link_days'`);
ok(r.store_types && r.store_types.affiliate && r.systems.length === 9, 'meta has the store types and the 9 required systems');
await admin('PUT', '/api/franchise/settings', { member_fee: 40000, affiliate_marketing_pct: 1, tech_fee: 25000, loyalty_point_value: 1, gct_rate: 15, commit_pct: 80, coop_pct: 1, coop_claim_pct: 50, royalty_pct: 6, marketing_pct: 2 });

r = await anon('GET', NET + '/meta');
ok(r._status === 401 || r._status === 403, 'signed out is refused');
r = await admin('GET', NET + '/meta');
ok(r._status === 200 && r.formats.some((f) => f.key === 'hub') && r.tiers.some((t) => t.code === 'PRO1') && r.programs.some((p) => p.code === 'PS1') && r.rebate_tiers.length === 4, 'network meta: formats, tiers, certificates and the rebate scale are seeded');
const tierId = (code) => r.tiers.find((t) => t.code === code).id;
const PRO1 = tierId('PRO1');

// ------------------------------------------------------------------ DCs --
r = await admin('POST', NET + '/dcs', { code: 'k' + stamp, name: 'Kingston DC', parish: 'St Andrew', cutoff_time: '23:59', delivery_days: 'Mon-Sat', runs_per_day: 2 });
ok(r._status === 200, 'DC added');
const dc = r.id;
r = await admin('POST', NET + '/dcs', { code: 'K' + stamp, name: 'Again' });
ok(r._status === 409, 'duplicate DC code refused');
r = await admin('POST', NET + '/dcs', { code: 'x' + stamp, name: 'Bad', cutoff_time: '2pm' });
ok(r._status === 400, 'a cut-off that is not HH:MM is refused');
r = await admin('PUT', NET + '/formats/superstore', { name: 'Superstore', sq_ft_min: 10000, sq_ft_max: 20000, sku_target: 40000 });
ok(r._status === 200, 'a store format can be added');

// --------------------------------------------------------------- stores --
const mk = async (b) => (await admin('POST', '/api/franchise/franchisees', b)).id;
const hub = await mk({ legal_name: 'Hub Parts ' + stamp + ' Ltd', trading_name: 'Morty\'s Auto Parts Half Way Tree', email: 'hub.' + stamp + '@example.test', store_type: 'franchise' });
const spoke = await mk({ legal_name: 'Spoke Motors ' + stamp + ' Ltd', trading_name: 'Spoke Motors', email: 'spoke.' + stamp + '@example.test', store_type: 'affiliate' });
const co = await mk({ legal_name: 'Morty\'s Auto Parts (company) ' + stamp, trading_name: 'Morty\'s Portmore', store_type: 'company' });
ok(hub && spoke && co, 'a franchised, an affiliate and a company-owned store added');
let F = await admin('GET', `/api/franchise/franchisees/${spoke}`);
const C = await admin('GET', `/api/franchise/franchisees/${co}`);
const H = await admin('GET', `/api/franchise/franchisees/${hub}`);
ok(F.franchisee.store_type === 'affiliate' && F.franchisee.customer_id, 'the affiliate has a Receivables account');
ok(C.franchisee.store_type === 'company' && !C.franchisee.customer_id, 'the company store has no customer account');
ok(H.tasks.length === 26 && F.tasks.length < 26 && !F.tasks.some((k) => /Initial franchise fee|Site found|Opening day/.test(k.title)) && !C.tasks.some((k) => /Initial franchise fee/.test(k.title)),
  'checklists by kind: franchise ' + H.tasks.length + ', affiliate ' + F.tasks.length + ' (no fee, site or opening), company ' + C.tasks.length + ' (no fee)');
ok(F.terms.member_fee === 40000 && F.terms.commit_pct === 80, 'affiliate terms carry the membership fee and the purchasing commitment');

r = await admin('POST', `${NET}/stores/${spoke}/placement`, { network_role: 'spoke', hub_id: hub, dc_id: dc, format_key: 'express' });
ok(r._status === 400 && /not a hub/.test(r.error), 'a spoke cannot use a store that is not a hub');
r = await admin('POST', `${NET}/stores/${hub}/placement`, { network_role: 'hub', dc_id: dc, format_key: 'hub', sq_ft: 8000 });
ok(r._status === 200, 'hub placed');
r = await admin('POST', `${NET}/stores/${spoke}/placement`, { network_role: 'spoke', hub_id: spoke, dc_id: dc });
ok(r._status === 400, 'a store cannot be its own hub');
r = await admin('POST', `${NET}/stores/${spoke}/placement`, { network_role: 'spoke', hub_id: hub, dc_id: dc, format_key: 'express', sq_ft: 2500 });
ok(r._status === 200, 'spoke placed under the hub');
r = await admin('POST', `${NET}/stores/${co}/placement`, { network_role: 'standalone', dc_id: dc, format_key: 'standard', sq_ft: 5000 });
r = await admin('POST', `${NET}/stores/${hub}/placement`, { network_role: 'standalone', dc_id: dc });
ok(r._status === 409, 'a hub with spokes cannot stop being a hub');
F = await admin('GET', `/api/franchise/franchisees/${spoke}`);
ok(F.franchisee.hub_name === 'Morty\'s Auto Parts Half Way Tree' && F.franchisee.dc_name === 'Kingston DC' && F.tasks.find((k) => /^Distribution centre account/.test(k.title)).done_at, 'spoke shows its hub and DC; the DC checklist item is ticked');
r = await admin('GET', NET + '/stores');
ok(r.stores.find((s) => s.id === hub).spokes === 1, 'the hub counts one spoke');

// ------------------------------------------------------------ catalogue --
r = await admin('POST', NET + '/catalogue', { sku: 'bp-' + stamp, part_number: '04465-02220', brand: 'Aisin', description: 'Front brake pads', category: 'Brakes', interchange: 'D1210 MKD1210', dealer_cost: 6000, list_price: 10000, core_charge: 0, warranty_months: 12,
  fitment: [{ make: 'Toyota', model: 'Corolla', year_from: 2009, year_to: 2013, engine: '1.8' }, { make: 'Toyota', model: 'Matrix', year_from: 2009, year_to: 2014 }] });
ok(r._status === 200, 'part added with two vehicles');
const pad = r.id;
r = await admin('POST', NET + '/catalogue', { sku: 'BP-' + stamp, description: 'Again', dealer_cost: 1, list_price: 2 });
ok(r._status === 409, 'duplicate SKU refused');
r = await admin('POST', NET + '/catalogue', { sku: 'lo-' + stamp, description: 'Below cost', dealer_cost: 100, list_price: 50 });
ok(r._status === 400, 'a list price below dealer cost is refused');
r = await admin('POST', NET + '/catalogue', { sku: 'yr-' + stamp, description: 'Bad years', dealer_cost: 1, list_price: 2, fitment: [{ make: 'Honda', year_from: 2015, year_to: 2010 }] });
ok(r._status === 400, 'fitment years the wrong way round are refused');
r = await admin('POST', NET + '/catalogue', { sku: 'bat-' + stamp, description: 'Battery 55D23L', category: 'Electrical', dealer_cost: 14000, list_price: 21000, core_charge: 2500, stocking: 'hub' });
const bat = r.id;
r = await admin('GET', `${NET}/catalogue?make=toyota&model=corolla&year=2011`);
ok(r.items.some((i) => i.id === pad) && !r.items.some((i) => i.id === bat), 'lookup by vehicle finds the pads and not the battery');
r = await admin('GET', `${NET}/catalogue?make=toyota&model=corolla&year=2016`);
ok(!r.items.some((i) => i.id === pad), 'a year outside the fitment is not matched');
r = await admin('GET', `${NET}/catalogue?q=MKD1210`);
ok(r.items.some((i) => i.id === pad), 'an interchange number finds the part');
r = await admin('GET', `${NET}/catalogue?q=bp-${stamp}&tier_id=${PRO1}`);
ok(r.items[0].tier_price === 8800, 'Pro 1 price: 12% off list (J$' + r.items[0].tier_price + ')');
r = await admin('POST', NET + '/tiers', { code: 'deep' + stamp.slice(-3), name: 'Deep test', discount_pct: 50, floor_pct: 10 });
const deep = r.id;
r = await admin('GET', `${NET}/catalogue/${pad}`);
ok(r.prices.find((p) => p.tier_id === deep).price === 6600 && r.fitment.length === 2, 'a big discount stops at dealer cost plus the floor (J$6,600)');
sql(`INSERT INTO products (img, name, make_model, category, condition, price_usd, cost_usd, sku, is_active) VALUES ('fr-net-${stamp}.jpg', 'Oil filter ${stamp}', 'Nissan Tiida 2007-12', 'Filters', 'NEW', 1500, 900, 'OF-${S}', true)`);
for (let i = 0; i < 20; i++) { r = await admin('POST', NET + '/catalogue/import', {}); if (!r.remaining || !r.added) break; }
const imp = sql(`SELECT c.dealer_cost::int || '/' || c.list_price::int || '/' || x.make || '/' || x.model || '/' || x.year_from || '-' || x.year_to FROM fr_catalogue c JOIN fr_fitment x ON x.catalogue_id = c.id WHERE c.sku = 'OF-${S}'`);
ok(r._status === 200 && imp === '900/1500/Nissan/Tiida/2007-2012', 'till products import with cost, price and fitment (' + imp + ')');

// ---------------------------------------------------- stock and availability --
r = await admin('PUT', NET + '/stock', { dc_id: dc, rows: [{ sku: 'bp-' + stamp, on_hand: 1000 }, { sku: 'bat-' + stamp, on_hand: 50 }, { sku: 'nope-' + stamp, on_hand: 1 }] });
ok(r.saved === 2 && r.unknown.length === 1, 'DC stock loaded; an unknown SKU is reported');
r = await admin('PUT', NET + '/stock', { franchisee_id: hub, rows: [{ sku: 'bat-' + stamp, on_hand: 6 }] });
r = await admin('PUT', NET + '/stock', { franchisee_id: spoke, rows: [{ sku: 'bp-' + stamp, on_hand: 1, min_qty: 4, max_qty: 10 }] });
r = await admin('PUT', NET + '/stock', { franchisee_id: spoke, rows: [{ sku: 'bp-' + stamp, min_qty: 8, max_qty: 2 }] });
ok(r._status === 400, 'max below min is refused');
r = await admin('GET', `${NET}/availability?catalogue_id=${bat}&store_id=${spoke}`);
ok(r.options[0].where === 'hub' && /hot shot/.test(r.options[0].eta) && r.options[1].where === 'dc', 'availability: not in the spoke, so its hub first, then the DC');
r = await admin('GET', `${NET}/stores/${spoke}/replenish`);
ok(r.lines.length === 1 && r.lines[0].suggest === 9, 'replenishment: below min 4, order back up to max 10 (9)');
r = await admin('POST', `${NET}/stores/${spoke}/replenish`, {});
ok(r._status === 200 && /^SO-/.test(r.number) && r.total_cost === 54000, 'replenishment order placed: ' + r.number + ' J$' + r.total_cost);
const rep = r.id;
r = await admin('GET', `${NET}/stores/${spoke}/replenish`);
ok(r.lines.length === 0, 'what is on order is not suggested again');

// --------------------------------------------------------- supply orders --
r = await admin('POST', `${NET}/orders/${rep}/ship`, { lines: [{ id: (await admin('GET', `${NET}/orders/${rep}`)).order.lines[0].id, qty_shipped: 6 }] });
ok(r._status === 200 && r.fill_pct === 66.7 && r.invoice && r.total_cost === 36000, 'shipped 6 of 9: fill ' + r.fill_pct + '%, invoice ' + (r.invoice && r.invoice.number));
ok(sql(`SELECT a.system_key || ':' || l.amount::int || '/' || i.gct_amount::int || '/' || i.total::int FROM ar_invoice_lines l JOIN gl_accounts a ON a.id = l.account_id JOIN ar_invoices i ON i.id = l.invoice_id WHERE i.id = ${r.invoice.id}`) === 'franchise_supply:36000/5400/41400', 'supply invoice: 4610 plus GCT, on the store\'s account');
ok(sql(`SELECT on_hand FROM fr_stock WHERE dc_id = ${dc} AND catalogue_id = ${pad}`) === '994', 'DC stock taken out (1000 - 6)');
r = await admin('POST', `${NET}/orders/${rep}/ship`, {});
ok(r._status === 409, 'cannot ship twice');
let O = await admin('GET', `${NET}/orders/${rep}`);
r = await admin('POST', `${NET}/orders/${rep}/receive`, { lines: [{ id: O.order.lines[0].id, qty_received: 5 }], note: 'one box crushed' });
ok(r._status === 200 && r.short.length === 1, 'received one short: ' + r.short.join(', '));
ok(sql(`SELECT on_hand FROM fr_stock WHERE franchisee_id = ${spoke} AND catalogue_id = ${pad}`) === '6', 'spoke stock up by what arrived (1 + 5)');
r = await admin('POST', NET + '/orders', { franchisee_id: spoke, kind: 'hot', lines: [{ sku: 'bat-' + stamp, qty: 2 }] });
const hot = r.id;
r = await admin('POST', `${NET}/orders/${hot}/ship`, {});
ok(r._status === 200 && sql(`SELECT on_hand FROM fr_stock WHERE franchisee_id = ${hub} AND catalogue_id = ${bat}`) === '4', 'hot shot ships from the hub\'s stock (6 - 2)');
ok(sql(`SELECT amount::int FROM fr_credits WHERE franchisee_id = ${hub} AND kind = 'other' AND source_id = ${hot}`) === '28000', 'the hub is owed the parts at dealer cost');
r = await admin('POST', NET + '/orders', { franchisee_id: co, kind: 'stock', lines: [{ catalogue_id: pad, qty: 3 }] });
const coOrder = r.id;
r = await admin('POST', `${NET}/orders/${coOrder}/ship`, {});
ok(r._status === 200 && !r.invoice, 'a company store\'s order ships without an invoice');
r = await admin('POST', NET + '/orders', { franchisee_id: co, lines: [{ catalogue_id: pad, qty: 1 }] });
const cx = r.id;
r = await admin('POST', `${NET}/orders/${cx}/cancel`, { reason: 'test' });
r = await admin('POST', `${NET}/orders/${coOrder}/cancel`, {});
ok(r._status === 409, 'a shipped order cannot be cancelled');
r = await admin('POST', NET + '/orders', { franchisee_id: spoke, lines: [] });
ok(r._status === 400, 'an order with no parts is refused');

// ------------------------------------------------------------ commercial --
r = await admin('POST', NET + '/routes', { franchisee_id: spoke, name: 'Morning west', driver: 'Dwayne', runs: '8:30, 11:00', promise_minutes: 40 });
const route = r.id;
r = await admin('POST', NET + '/routes', { franchisee_id: hub, name: 'Hub run' });
const hubRoute = r.id;
r = await admin('POST', NET + '/commercial', { franchisee_id: spoke, name: 'Best Garage ' + stamp, kind: 'garage', tier_id: PRO1, credit_limit: 500000, route_id: hubRoute });
ok(r._status === 400, 'an account cannot use another store\'s route');
r = await admin('POST', NET + '/commercial', { franchisee_id: spoke, name: 'Best Garage ' + stamp, kind: 'garage', tier_id: PRO1, credit_limit: 500000, terms_days: 30, route_id: route, stop_order: 1, bays: 6 });
ok(r._status === 200, 'commercial account opened on a route');
r = await admin('GET', `${NET}/commercial?store_id=${spoke}`);
ok(r.accounts[0].tier_code === 'PRO1' && r.routes[0].stops === 1, 'account shows its tier; the route has one stop');
F = await admin('GET', `/api/franchise/franchisees/${spoke}`);
ok(F.tasks.find((k) => /^Commercial accounts and first delivery route/.test(k.title)).done_at, 'the commercial checklist item is ticked');

// --------------------------------------------- reports, scorecard, billing --
sql(`UPDATE fr_franchisees SET status = 'open', signed_on = '2026-01-04', opened_on = '2026-01-04' WHERE id IN (${hub}, ${spoke}, ${co})`);
const rpt = (id, b) => admin('POST', `/api/franchise/franchisees/${id}/reports`, b);
r = await rpt(hub, { period: '2026-09', gross_sales: 3450000, refunds: 50000, gct_collected: 400000, diy_sales: 1000000, commercial_sales: 1000000 });
ok(r._status === 400 && /add up/.test(r.error), 'DIY and commercial must add up to net sales');
const full = { gross_sales: 3450000, refunds: 50000, gct_collected: 400000, transactions: 1500, diy_sales: 1800000, commercial_sales: 1200000, cogs: 1860000, inventory_value: 7440000, shrink: 15000, deliveries: 300, delivery_minutes: 35 };
r = await rpt(hub, Object.assign({ period: '2026-08', purchases_total: 10000000 }, full));
r = await rpt(hub, Object.assign({ period: '2026-09' }, full));
ok(r._status === 200 && r.net_sales === 3000000, 'hub reports August and September with the scorecard figures');
r = await rpt(spoke, { period: '2026-09', gross_sales: 1150000, gct_collected: 150000, diy_sales: 600000, commercial_sales: 400000, loyalty_issued: 5000, loyalty_redeemed: 2000 });
r = await admin('POST', `/api/franchise/franchisees/${spoke}/bill`, { period: '2026-09' });
const kinds = r.lines ? r.lines.map((l) => l.kind + ':' + l.amount).join(',') : '';
ok(r._status === 200 && kinds === 'member:40000,marketing:10000,tech:25000,loyalty:5000' && r.invoice.total === 92000, 'affiliate invoice: membership, 1% network marketing, tech fee, loyalty points (' + kinds + ', J$' + (r.invoice && r.invoice.total) + ')');
ok(r.loyalty_credit && r.loyalty_credit.amount === 2000, 'points redeemed at the store are owed back to it (J$2,000)');
ok(sql(`SELECT a.system_key FROM ar_invoice_lines l JOIN gl_accounts a ON a.id = l.account_id WHERE l.invoice_id = ${r.invoice.id} AND l.description LIKE 'Loyalty%'`) === 'franchise_loyalty', 'loyalty goes to 2175');
r = await admin('POST', `/api/franchise/franchisees/${spoke}/bill`, { period: '2026-09' });
ok(r._status === 409, 'the month cannot be invoiced twice');
r = await rpt(spoke, { period: '2026-09', gross_sales: 1 });
ok(r._status === 409, 'an invoiced month\'s report cannot be changed');
r = await rpt(co, { period: '2026-09', gross_sales: 2300000, gct_collected: 300000 });
r = await admin('POST', `/api/franchise/franchisees/${co}/bill`, { period: '2026-09' });
ok(r._status === 409 && /Company-owned/.test(r.error), 'company stores are not billed');

r = await admin('GET', `${NET}/scorecard?months=3&store_id=${hub}`);
const sc = r.stores[0];
ok(sc && sc.net_sales === 6000000 && sc.per_month === 3000000 && sc.commercial_pct === 40 && sc.margin_pct === 38 && sc.turns === 3 && sc.shrink_pct === 0.5 && sc.sales_per_sqft === 4500 && sc.delivery_minutes === 35,
  'hub scorecard: J$6m, 40% commercial, 38% margin, 3 turns, 0.5% shrink, J$4,500 per sq ft, 35 min');
ok(sc.grades.commercial_pct === 'ok' && sc.grades.margin_pct === 'ok' && sc.grades.turns === 'bad' && sc.grades.shrink_pct === 'ok' && sc.grades.delivery_minutes === 'ok', 'grades against the targets (turns 3 against 4: red, under 80% of target)');
sql(`UPDATE fr_supply_orders SET shipped_at = '2026-10-20 12:00-05' WHERE franchisee_id = ${spoke} AND status IN ('shipped', 'received')`);   // a finished month
r = await admin('GET', `${NET}/scorecard?months=3&store_id=${spoke}`);
ok(r.stores[0].fill_pct === 66.7, 'spoke fill rate from its DC orders (hot shots not counted): ' + r.stores[0].fill_pct + '%');

// ------------------------------------------------------------ programmes --
// A large Q3 DC order for the hub, so the rebate and co-op have something to work on.
r = await admin('POST', NET + '/orders', { franchisee_id: hub, lines: [{ catalogue_id: pad, qty: 600 }] });
const big = r.id;
O = await admin('GET', `${NET}/orders/${big}`);
r = await admin('POST', `${NET}/orders/${big}/ship`, { lines: [{ id: O.order.lines[0].id, qty_shipped: 600 }] });
ok(r._status === 200 && r.total_cost === 3600000, 'hub DC order of J$3.6m shipped');
sql(`UPDATE fr_supply_orders SET shipped_at = '2026-08-15 12:00-05' WHERE id = ${big}`);
r = await admin('POST', NET + '/rebates/run', { quarter: '2026-Q4' });
ok(r._status === 409, 'a quarter that has not ended cannot be run');
r = await admin('POST', NET + '/rebates/run', { quarter: '2026-Q3' });
let row = r.stores.find((s) => s.franchisee_id === hub);
ok(row && /held back/.test(row.result) && row.compliance_pct === 36, 'hub rebate held back: 36% through the DC against an 80% commitment');
r = await admin('POST', NET + '/rebates/run', { quarter: '2026-Q3', allow: [hub] });
row = r.stores.find((s) => s.franchisee_id === hub);
ok(row.result === 'credited' && row.amount === 36000 && row.rebate_pct === 1, 'allowed: 1% of J$3.6m credited (J$36,000)');
r = await admin('POST', NET + '/rebates/run', { quarter: '2026-Q3', allow: [hub] });
ok(r.stores.find((s) => s.franchisee_id === hub).result === 'already credited', 'running the quarter again does not pay twice');
r = await admin('POST', NET + '/coop-claims', { franchisee_id: hub, description: 'Radio spots on IRIE FM', media: 'radio', spend_date: '2026-10-10', spend: 100000, proof: 'IRIE inv 5521' });
ok(r._status === 200 && r.claimed === 50000, 'co-op claim: 50% of J$100,000');
const claim = r.id;
r = await admin('GET', NET + '/programmes?year=2026');
const hubP = r.stores.find((s) => s.id === hub);
ok(hubP.coop.earned === 36000 && hubP.coop.balance === 36000 && hubP.dc_purchases === 3600000, 'co-op allowance: 1% of 12 months\' DC purchases (J$36,000)');
r = await admin('POST', `${NET}/coop-claims/${claim}/decide`, { decision: 'approve', amount: 50000 });
ok(r._status === 409, 'a claim above the allowance is refused');
r = await admin('POST', `${NET}/coop-claims/${claim}/decide`, { decision: 'approve', amount: 30000 });
ok(r._status === 200 && r.approved === 30000, 'approved J$30,000');
r = await admin('POST', `${NET}/coop-claims/${claim}/decide`, { decision: 'decline', note: 'x' });
ok(r._status === 409, 'a decided claim cannot be decided again');
r = await admin('GET', NET + '/programmes?year=2026');
ok(r.stores.find((s) => s.id === hub).coop.balance === 6000, 'allowance left: J$6,000');
const owed = r.credits.filter((c) => c.franchisee_id === hub && c.status === 'owed');
ok(owed.length === 3 && owed.reduce((x, c) => x + c.amount, 0) === 94000, 'owed to the hub: rebate, co-op and hot-shot parts (J$94,000)');
r = await admin('POST', `${NET}/credits/${owed[0].id}/settle`, { how: 'transfer', reference: 'NCB 778812' });
ok(r._status === 200, 'a credit is recorded as paid');
r = await admin('POST', `${NET}/credits/${owed[0].id}/settle`, { how: 'transfer' });
ok(r._status === 409, 'and cannot be paid twice');
r = await admin('PUT', NET + '/rebate-tiers', { tiers: [{ min_quarter: 1000000, rebate_pct: 1 }, { min_quarter: 1000000, rebate_pct: 2 }] });
ok(r._status === 400, 'two rebate steps at the same amount are refused');

// -------------------------------------------------- systems and certificates --
for (const s of r.systems || (await admin('GET', '/api/franchise/meta')).systems) {
  r = await admin('PUT', `${NET}/stores/${spoke}/systems/${s[0]}`, { status: s[0] === 'cctv' ? 'not_needed' : 'verified', detail: 'test' });
}
ok(r.all_verified === true, 'every required system verified');
F = await admin('GET', `/api/franchise/franchisees/${spoke}`);
ok(F.tasks.find((k) => /^Required systems installed/.test(k.title)).done_at, 'the systems checklist item is ticked');
r = await admin('PUT', `${NET}/stores/${spoke}/systems/teleporter`, { status: 'verified' });
ok(r._status === 404, 'an unknown system is refused');
r = await admin('POST', NET + '/certs', { franchisee_id: spoke, person: 'Kim Counter', program_code: 'PS1', score: 60 });
ok(r._status === 400 && /pass mark/.test(r.error), 'a score below the pass mark is refused');
r = await admin('POST', NET + '/certs', { franchisee_id: spoke, person: 'Kim Counter', role: 'Counter', program_code: 'PS1', earned_on: '2026-10-01', score: 92 });
ok(r._status === 200 && r.expires_on === '2028-10-01', 'PS1 recorded, valid 24 months to ' + r.expires_on);
await admin('POST', NET + '/certs', { franchisee_id: spoke, person: 'Lee Counter', program_code: 'PS1', score: 85 });
r = await admin('POST', NET + '/certs', { franchisee_id: spoke, person: 'Pat Manager', program_code: 'MGR', score: 90 });
F = await admin('GET', `/api/franchise/franchisees/${spoke}`);
ok(F.tasks.find((k) => /^Counter staff certified/.test(k.title)).done_at, 'two PS1 and a manager: the certification checklist item is ticked');
r = await admin('GET', `${NET}/certs?store_id=${spoke}`);
const comp = r.stores[0].compliance;
ok(comp.pct === 42.9 && comp.short.length === 4, 'requirement met: ' + comp.pct + '% (short of ' + comp.short.length + ')');
const kim = r.certs.find((c) => c.person === 'Kim Counter');
ok(/^PS1-\d{5}$/.test(kim.certificate_no) && kim.state === 'current', 'certificate numbered ' + kim.certificate_no);
r = await admin('POST', `${NET}/certs/${kim.id}/revoke`, { reason: 'left' });
r = await admin('GET', `${NET}/certs?store_id=${spoke}`);
ok(r.stores[0].compliance.pct === 28.6, 'withdrawn: the store falls to 28.6%');

// ------------------------------------------------------ territory planning --
r = await admin('POST', '/api/franchise/territories', { code: 'hwt-' + stamp, name: 'Half Way Tree', population: 120000 });
const terr = r.id;
r = await admin('PUT', `${NET}/territories/${terr}`, { vehicles: 10000, garages: 50, dc_id: dc, dc_minutes: 25, planned_type: 'affiliate', planned_format: 'express', priority: 1 });
r = await admin('GET', NET + '/territories');
const T = r.territories.find((x) => x.id === terr);
ok(T.potential === 720000000 && T.dc_code === 'K' + S && T.planned_type === 'affiliate', 'market: 10,000 vehicles × J$60,000 + 50 garages × J$2.4m = J$720m');

// -------------------------------------------------------------- documents --
r = await admin('POST', '/api/franchise/documents', { kind: 'supply', franchisee_id: spoke, values: { payment_days: 30, credit_limit: '3,000,000' } });
const sup = r.id;
r = await admin('GET', `/api/franchise/documents/${sup}/view`, null, true);
ok(/Kingston DC/.test(r.text) && /at least <b>80%<\/b>/.test(r.text) && /DC purchases of J\$3,000,000\.00 or more in the quarter: 1%/.test(r.text) && /Affiliate \(dealer-member\) store/.test(r.text), 'supply agreement filled: DC, commitment, rebate scale, kind of store');
r = await admin('POST', '/api/franchise/documents', { kind: 'affiliate', franchisee_id: spoke, values: { store_name: 'Spoke Motors', banner: 'Member of the network' } });
const aff = r.id;
r = await admin('POST', `/api/franchise/documents/${aff}/sign`, { name: 'Sam Spoke', image: SIG });
ok(r._status === 409 && /disclosure document/.test(r.error), 'the affiliate agreement also waits for the disclosure document');
r = await admin('POST', '/api/franchise/documents', { kind: 'hub_service', values: { spokes: 'x' } });
ok(r._status === 400, 'a store document needs the store');
r = await admin('POST', '/api/franchise/documents', { kind: 'systems', franchisee_id: hub, values: {} });
r = await admin('POST', `/api/franchise/documents/${r.id}/sign`, { name: 'Hub Owner', image: SIG });
ok(r._status === 200 && r.document, 'systems schedule signed and filed');

// ----------------------------------------------------- the store's own link --
r = await admin('POST', `/api/franchise/franchisees/${spoke}/portal-link`, {});
const pTok = new URL(r.link).searchParams.get('p');
const P = '/api/public/franchisee/' + pTok;
r = await anon('GET', P);
ok(r._status === 200 && r.store.store_type === 'affiliate' && r.store.hub === 'Morty\'s Auto Parts Half Way Tree' && r.network.can_order && r.network.has_hub, 'their page knows the kind of store, hub and DC');
ok(r.network.coop && r.network.scorecard && r.network.compliance.pct === 28.6 && r.network.orders.length >= 2, 'their page has orders, co-op, scorecard and certificates');
ok(r.terms.member_fee === 40000, 'their page shows the membership fee');
r = await anon('GET', P + '/parts?make=Toyota&model=Corolla&year=2010');
const it = r.items.find((i) => i.id === pad);
ok(it && it.in_store === 6 && it.at_dc === 391 && it.dealer_cost === 6000, 'parts lookup from their link: here 6, DC 391, their cost J$6,000');
r = await anon('POST', P + '/orders', { kind: 'hot', lines: [{ catalogue_id: bat, qty: 1 }] });
ok(r._status === 200 && /^SO-/.test(r.number), 'they order a hot shot from their link');
const pOrder = r.id;
await admin('POST', `${NET}/orders/${pOrder}/ship`, {});
r = await anon('POST', P + '/orders/' + coOrder + '/receive', {});
ok(r._status === 404, 'they cannot receive another store\'s order');
r = await anon('POST', P + '/orders/' + pOrder + '/receive', {});
ok(r._status === 200 && sql(`SELECT on_hand FROM fr_stock WHERE franchisee_id = ${spoke} AND catalogue_id = ${bat}`) === '1', 'they mark it received; the battery is in their stock');
r = await anon('POST', P + '/coop', { description: 'Flyers', spend_date: '2026-10-20', spend: 20000 });
ok(r._status === 200 && r.claimed === 10000, 'they claim co-op from their link');
r = await anon('GET', '/api/public/franchisee/' + pTok.slice(0, -2) + 'xx/parts?q=a');
ok(r._status === 404, 'a wrong link sees no parts');

r = await admin('GET', NET + '/meta');
ok(r.attention.claims_waiting >= 1 && r.attention.credits_owed >= 1, 'the network screen shows what needs attention');
r = await admin('GET', `${NET}/scorecard?months=3`);
ok(r._status === 200 && r.network.stores >= 3 && r.by_type.affiliate && r.by_type.company, 'the network scorecard groups stores by kind');
r = await admin('GET', '/franchise.html', null, true);
ok(r.status === 200 && /Store network:/.test(r.text) && /scorecardView/.test(r.text), 'franchise.html carries the store-network tabs');

console.log('\n' + pass + ' passed, ' + fails + ' failed');
process.exit(fails ? 1 : 0);
