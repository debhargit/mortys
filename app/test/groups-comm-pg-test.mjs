// Staff groups, each person's discount limit, and a rep's own commission,
// against a REAL server and a throwaway Postgres: groups that turn functions
// on and off and add up, adding and removing people, the discount limit from
// a group or the person (sale, order dry run, quote) with a manager's PIN past
// it, each rep's commission rate, and "My commission" from the rep's own sales.
//
//   GC_TEST_URL=http://localhost:3392 GC_TEST_PSQL="psql -h 127.0.0.1 -p 5492 -U postgres -d commtest" node test/groups-comm-pg-test.mjs
//
// Refuses the live till's ports, and stops unless the server is writing to
// the database GC_TEST_PSQL points at. Signs in as the default admin.
import { execSync } from 'node:child_process';

const BASE = process.env.GC_TEST_URL || 'http://localhost:3392';
if (/:(3057|3058)\b/.test(BASE)) { console.log('FAIL refusing to run against the live till port'); process.exit(1); }
const PSQL = process.env.GC_TEST_PSQL;
if (!PSQL || /-p\s*5435\b/.test(PSQL)) { console.log('FAIL GC_TEST_PSQL must point at the throwaway database (never port 5435)'); process.exit(1); }
let pass = 0, fails = 0;
const ok = (c, m) => { if (c) { pass++; console.log('PASS ' + m); } else { fails++; console.log('FAIL ' + m); } };
const sql = (q) => execSync(PSQL + ' -tA', { input: q, encoding: 'utf8' }).trim();
function client() {
  const jar = {};
  return async function call(method, url, body) {
    const r = await fetch(BASE + url, { method, headers: Object.assign({ Accept: 'application/json', Cookie: Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ') }, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
    for (const c of r.headers.getSetCookie ? r.headers.getSetCookie() : []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
    return Object.assign({ _status: r.status }, await r.json().catch(() => ({})));
  };
}
const stamp = Date.now().toString(36);
// PINs are unique per staff member: fresh ones each run.
const PIN_ANN = String(100000 + Math.floor(Math.random() * 400000)), PIN_MGR = String(500000 + Math.floor(Math.random() * 400000));
const admin = client();
ok((await admin('POST', '/api/auth/signin', { email: 'admin@mortysautoparts.com', password: 'password123' }))._status === 200, 'admin signs in');

// The server must be on the throwaway database: what it writes shows up there.
let r = await admin('POST', '/api/admin/groups', { label: 'Accounts ' + stamp });
const accounts = r.id;
if (sql(`SELECT COUNT(*) FROM user_categories WHERE label = 'Accounts ${stamp}'`) !== '1') { console.log('FAIL the server is not writing to the GC_TEST_PSQL database: stopping'); process.exit(1); }
ok(true, 'the server is writing to the throwaway database');

const mk = async (name, role, extra) => {
  const email = name.toLowerCase().replace(/\W+/g, '.') + '.' + stamp + '@example.test';
  const res = await admin('POST', '/api/admin/staff', Object.assign({ email, password: 'Passw0rd!' + stamp, name, admin_role: role }, extra || {}));
  const id = (res.user || res).id;
  const c = client(); await c('POST', '/api/auth/signin', { email, password: 'Passw0rd!' + stamp });
  return { id, c };
};
const rita = await mk('Rita Rep ' + stamp, 'cashier');
const ann = await mk('Ann Accounts ' + stamp, 'cashier', { pin: PIN_ANN });
const mgr = await mk('Max Manager ' + stamp, 'manager', { pin: PIN_MGR });
ok(rita.id && ann.id && mgr.id, 'three staff made (two cashiers, one manager)');

// ---------------------------------------------------------------- groups
r = await admin('GET', '/api/admin/groups');
ok(r._status === 200 && r.groups.some((g) => g.code === 'sales_rep') && r.groups.some((g) => g.code === 'cashier'), 'the groups list has the built-in Sales rep and Cashier groups');
ok(r.capabilities.find((c) => c.key === 'comm.view').restricted === true && r.capabilities.find((c) => c.key === 'pos.refund').restricted === false, 'each function says whether it is off as standard');
ok(r.staff.some((s) => s.id === rita.id) && r.staff.find((s) => s.id === mgr.id).full === true, 'the people to add are listed; a manager shows as full access');
const salesRep = r.groups.find((g) => g.code === 'sales_rep').id;
const allOn = (r2, extra) => Object.assign(Object.fromEntries(r2.capabilities.map((c) => [c.key, !c.restricted])), extra);
const caps = r;

ok((await rita.c('GET', '/api/admin/groups'))._status === 403, 'a cashier cannot open the groups screen');
ok((await rita.c('PUT', '/api/admin/groups/' + accounts, { allowed: { 'comm.view': true } }))._status === 403, '… or change a group');
ok((await ann.c('GET', '/api/comm/summary?from=2026-01-01&to=2026-12-31'))._status === 403, 'before any group: Ann cannot see everyone\'s commission (off as standard)');

r = await admin('PUT', '/api/admin/groups/' + accounts, { allowed: allOn(caps, { 'comm.view': true, 'acct.view': true, 'pos.void_sale': false }) });
ok(r._status === 200 && r.perms['comm.view'] === true && r.perms['pos.void_sale'] === false && r.perms['pos.refund'] === true && r.perms['payroll.run'] === false, 'a group saves yes or no for every function');
r = await admin('POST', '/api/admin/groups/' + accounts + '/members', { user_ids: [ann.id, 999999] });
ok(r._status === 200 && r.added === 1, 'Ann added to Accounts (an unknown id is skipped)');
ok((await ann.c('GET', '/api/comm/summary?from=2026-01-01&to=2026-12-31'))._status === 200, 'in Accounts, Ann can see everyone\'s commission');
ok((await ann.c('GET', '/api/me'))._status === 200, 'Ann still signs in normally');
r = await admin('GET', '/api/admin/staff/' + ann.id + '/selling');
ok(r.groups_give.includes('comm.view') && r.groups_give.includes('acct.view'), 'her record shows what her groups give');

// Two groups add up: one refuses refunds, the other allows them.
const cashierGrp = caps.groups.find((g) => g.code === 'cashier').id;
await admin('PUT', '/api/admin/groups/' + cashierGrp, { allowed: allOn(caps, { 'pos.refund': false }) });
await admin('POST', '/api/admin/groups/' + cashierGrp + '/members', { user_ids: [rita.id] });
r = await admin('GET', '/api/admin/staff/' + rita.id + '/selling');
ok(r.groups_block.includes('pos.refund'), 'Rita in Cashier: refunds refused by her group');
const sup = (await admin('POST', '/api/admin/groups', { label: 'Supervisors ' + stamp, copy_from: cashierGrp })).id;
r = await admin('GET', '/api/admin/groups');
ok(r.groups.find((g) => g.id === sup).perms['pos.refund'] === false, 'a new group can start as a copy of another');
await admin('PUT', '/api/admin/groups/' + sup, { allowed: allOn(caps, { 'pos.refund': true }) });
await admin('POST', '/api/admin/groups/' + sup + '/members', { user_ids: [rita.id] });
r = await admin('GET', '/api/admin/staff/' + rita.id + '/selling');
ok(!r.groups_block.includes('pos.refund'), 'also in Supervisors, which allows refunds: she can refund (groups add up)');
await admin('PATCH', '/api/admin/users/' + rita.id + '/perms', { perms: { 'pos.refund': false } });
const ritaPerms = await (async () => { const s = sql(`SELECT perms->>'pos.refund' FROM users WHERE id = ${rita.id}`); return s; })();
ok(ritaPerms === 'false', 'a person\'s own Deny still beats their groups');
await admin('PATCH', '/api/admin/users/' + rita.id + '/perms', { perms: {} });
r = await admin('DELETE', '/api/admin/groups/' + sup + '/members/' + rita.id);
ok(r._status === 200, 'Rita taken out of Supervisors');
r = await admin('GET', '/api/admin/staff/' + rita.id + '/selling');
ok(r.groups_block.includes('pos.refund'), '… and refunds are refused again');
ok((await admin('DELETE', '/api/admin/groups/' + sup + '/members/' + rita.id))._status === 404, 'taking out someone not in the group says so');

// The old category screen (old page on a new server) keeps what a group turns on.
await admin('PATCH', '/api/admin/user-categories/' + accounts + '/perms', { perms: { 'pos.hold_recall': false } });
r = await admin('GET', '/api/admin/groups');
const acc = r.groups.find((g) => g.id === accounts);
ok(acc.perms['comm.view'] === true && acc.perms['pos.hold_recall'] === false, 'the old category permission save keeps what the group allows');
ok(acc.members.some((m) => m.id === ann.id), 'the groups list shows who is in each group');

// --------------------------------------------------------- discount limit
const img = sql(`SELECT img FROM products WHERE is_active AND price_usd > 0 AND NOT COALESCE(serial_required, false) ORDER BY img LIMIT 1`);
// A rerun on the same database starts from no limit on the Cashier group.
await admin('PUT', '/api/admin/groups/' + cashierGrp, { max_discount_pct: null });
const line = (disc) => [{ product_img: img, description: 'Test part', qty: 1, unit_price_usd: 1000, discount_usd: disc || 0 }];
r = await rita.c('GET', '/api/admin/me/selling');
ok(r._status === 200 && r.limit_pct == null, 'no limit set anywhere: no limit (as before)');
await admin('PUT', '/api/admin/groups/' + cashierGrp, { max_discount_pct: 5 });
r = await rita.c('GET', '/api/admin/me/selling');
ok(r.limit_pct === 5 && r.source === 'group', 'Cashier group limit 5%: Rita\'s limit is 5%');
await admin('PUT', '/api/admin/groups/' + accounts, { max_discount_pct: 8 });
await admin('POST', '/api/admin/groups/' + accounts + '/members', { user_ids: [rita.id] });
r = await rita.c('GET', '/api/admin/me/selling');
ok(r.limit_pct === 8 && r.group === 'Accounts ' + stamp, 'also in Accounts (8%): the higher group limit counts');
await admin('DELETE', '/api/admin/groups/' + accounts + '/members/' + rita.id);
ok((await admin('PUT', '/api/admin/staff/' + rita.id + '/selling', { discount_limit_pct: 120 }))._status === 400, 'a limit over 100% is refused');
r = await admin('PUT', '/api/admin/staff/' + rita.id + '/selling', { discount_limit_pct: 3 });
ok(r._status === 200 && r.effective.limit_pct === 3 && r.effective.source === 'own', 'her own limit (3%) beats her groups');
ok((await rita.c('PUT', '/api/admin/staff/' + rita.id + '/selling', { discount_limit_pct: 50 }))._status === 403, 'she cannot change her own limit');

const sale = (c, items, disc, extra) => c('POST', '/api/admin/pos/sale', Object.assign({ items, discount_usd: disc || 0, payment_method: 'cash', amount_tendered: 5000 }, extra || {}));
r = await sale(rita.c, line(0), 50, { dry_run: true });
ok(r._status === 403 && r.discount_limit === true && r.limit_pct === 3 && r.asked_pct === 5, '5% off the ticket with a 3% limit is stopped, and the till is told why');
ok(/limit is 3%/.test(r.error) && /manager/i.test(r.error), '… in plain words');
r = await sale(rita.c, line(40), 20, { dry_run: true });
ok(r._status === 403 && r.asked_pct === 6, 'line discounts and the ticket discount count together');
r = await sale(rita.c, line(20), 10, { dry_run: true });
ok(r._status === 200 && r.ok, '3% is allowed');
r = await rita.c('POST', '/api/admin/pos/order', { items: line(0), discount_usd: 100 });
ok(r._status === 403 && r.discount_limit, 'an order saved for a cashier is checked against whoever saved it')
r = await rita.c('POST', '/api/admin/pos/quote', { items: line(0), discount_usd: 100 });
ok(r._status === 403 && r.discount_limit, 'a quote over the limit is stopped too');
r = await rita.c('POST', '/api/admin/pos/quote', { items: line(0), discount_usd: 20 });
ok(r._status === 200 && r.quote_number, 'a quote within the limit saves');

// A manager's PIN approves it.
r = await rita.c('POST', '/api/admin/pos/discount-override?pct=10', { pin: PIN_ANN, user_id: ann.id });
ok(r._status === 403 && /manager/i.test(r.error), 'a cashier\'s PIN cannot approve a discount');
r = await rita.c('POST', '/api/admin/pos/discount-override?pct=10', { pin: '0000', user_id: mgr.id });
ok(r._status === 401, 'a wrong PIN is refused');
r = await rita.c('POST', '/api/admin/pos/discount-override?pct=10', { pin: PIN_MGR, user_id: mgr.id });
ok(r._status === 200 && r.user && r.user.name === 'Max Manager ' + stamp, 'the manager\'s PIN approves up to 10%');
ok(sql(`SELECT COUNT(*) FROM pos_events WHERE kind = 'discount_override' AND user_id = ${rita.id} AND approved_by = ${mgr.id}`) === '1', 'the approval is in the terminal journal');
r = await sale(rita.c, line(0), 120, { dry_run: true });
ok(r._status === 403, '12% is more than was approved');
r = await sale(rita.c, line(0), 100, { dry_run: true });
ok(r._status === 200, '10% now goes through (a dry run does not use the approval up)');
r = await rita.c('POST', '/api/admin/pos/quote', { items: line(0), discount_usd: 100 });
ok(r._status === 200, 'the approved quote saves');
r = await rita.c('POST', '/api/admin/pos/quote', { items: line(0), discount_usd: 100 });
ok(r._status === 403, 'the approval was for that one ticket: the next one needs a manager again');
r = await mgr.c('POST', '/api/admin/pos/quote', { items: line(0), discount_usd: 500 });
ok(r._status === 200, 'a manager has no discount limit');

// ---------------------------------------------------- commission per rep
ok((await admin('PUT', '/api/admin/staff/' + rita.id + '/selling', { commission_pct: 4 }))._status === 400, 'a commission rate needs the person to be a sales rep');
await admin('POST', '/api/admin/groups/' + salesRep + '/members', { user_ids: [rita.id] });
r = await admin('PUT', '/api/admin/staff/' + rita.id + '/selling', { commission_pct: 4 });
ok(r._status === 200 && r.rep && r.rep.commission_pct === 4, 'in the Sales rep group she becomes a rep; her rate is set to 4%');
const repId = r.rep.id;
r = await admin('PUT', '/api/comm/reps/' + repId + '/rate', { commission_pct: 5 });
ok(r._status === 200 && r.rep.commission_pct === 5, 'the Commission page can set each rep\'s rate too (5%)');
ok((await rita.c('PUT', '/api/comm/reps/' + repId + '/rate', { commission_pct: 50 }))._status === 403, 'a rep cannot set her own rate');
ok((await admin('PUT', '/api/comm/reps/' + repId + '/rate', { commission_pct: 101 }))._status === 400, 'a rate over 100% is refused');

// A sale credited to Rita before tracking is switched on.
const started = sql(`SELECT value FROM warehouse_settings WHERE key = 'comm_start_at'`);
r = await sale(rita.c, line(0), 0, { sales_rep_id: repId, sales_rep_name: 'Rita' });
ok(r._status === 200 && r.ok, 'Rita sells a J$1,000 part');
const s0 = r.id;
r = await rita.c('GET', '/api/comm/me');
ok(r._status === 200 && r.rep && r.rep.commission_pct === 5 && r.can && r.can.view === false, 'My commission: her rate shows, and the page knows she cannot see everyone\'s');
if (!started) ok(r.started === false && r.sales.total === 1000 && r.sales.estimate === 50, 'before tracking starts: her sales and what her rate comes to (J$50)')
if (!started) ok((await admin('POST', '/api/comm/start'))._status === 200, 'commission tracking switched on');
ok((await rita.c('GET', '/api/comm/summary?from=2026-01-01&to=2026-12-31'))._status === 403, 'Rita cannot see other reps\' commission');

// Two sales after the start, credited to Rita (put 1 minute back: the sweep waits 30 s for a sale to settle).
const s1 = await sale(rita.c, line(0), 0, { sales_rep_id: repId, sales_rep_name: 'Rita' });
const s2 = await sale(rita.c, [{ product_img: img, description: 'Test part', qty: 2, unit_price_usd: 1500 }], 0, { sales_rep_id: repId, sales_rep_name: 'Rita' });
ok(s1.ok && s2.ok, 'two more sales credited to Rita');
// Tracking counts from 5 minutes ago, after the sale made before it was switched on.
sql(`UPDATE warehouse_settings SET value = to_char((NOW() - INTERVAL '5 minutes') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') WHERE key = 'comm_start_at';
     UPDATE warehouse_settings SET value = '${s0}' WHERE key = 'comm_last_sale_id' AND value::int < ${s0};
     UPDATE pos_sales SET created_at = NOW() - INTERVAL '1 minute' WHERE id IN (${s1.id}, ${s2.id})`);
r = await admin('POST', '/api/comm/run');
ok(r._status === 200 && r.entries >= 2, 'commission worked out for the new sales');
r = await rita.c('GET', '/api/comm/me');
ok(r.started === true && r.this_month.earned === 200, 'this month: 5% of J$4,000 = J$200');
ok(r.totals.unpaid === 200 && r.totals.paid === 0, 'owed to her and not yet paid: J$200');
ok(r.summary.earned === 200 && r.entries.length >= 2 && r.entries.every((e) => e.rule_name === 'rep default'), 'the lines show each sale at her own rate');
ok(r.sales.receipts >= 2, 'her receipts are counted');

// Rules for her show on her page.
await admin('POST', '/api/comm/rules', { name: 'Batteries ' + stamp, scope: 'category', scope_value: 'batteries', basis: 'sale', rate: 7, rep_id: repId });
r = await rita.c('GET', '/api/comm/me');
ok(r.rules.some((x) => x.name === 'Batteries ' + stamp && x.just_you), 'a rule just for her shows on her page');

// Statement, approval and payment: history.
r = await admin('POST', '/api/comm/statements', { rep_id: repId, period_to: new Date(Date.now() + 86400000).toISOString().slice(0, 10) });
ok(r._status === 200 && r.id, 'statement made');
const stId = r.id;
ok((await admin('POST', '/api/comm/statements/' + stId + '/approve'))._status === 200, 'statement approved');
ok((await admin('POST', '/api/comm/statements/' + stId + '/pay'))._status === 200, 'statement paid');
r = await rita.c('GET', '/api/comm/me');
ok(r.totals.paid === 200 && r.totals.unpaid === 0, 'after payment: J$200 paid, nothing owed');
ok(r.statements.some((x) => x.status === 'paid') && r.payouts.length >= 1 && r.payouts[0].amount === 200, 'her history shows the paid statement and the payment');

// ---------------------------- which rate: the part's own setting, else the rep's own
// A rule for every rep (like "Standard Commission" 1%) no longer beats a rep's rate.
const [img2, img3] = sql(`SELECT string_agg(img, ',' ORDER BY img) FROM (SELECT img FROM products WHERE is_active AND price_usd > 0 AND NOT COALESCE(serial_required, false) AND img <> '${img}' ORDER BY img LIMIT 2) x`).split(',');
sql(`UPDATE products SET commission_type = 'percent', commission_value = 10 WHERE img = '${img2}'; UPDATE products SET commission_type = 'none', commission_value = NULL WHERE img = '${img3}';
     UPDATE products SET commission_type = NULL, commission_value = NULL WHERE img = '${img}'`);
r = await admin('POST', '/api/comm/rules', { name: 'Everyone 1% ' + stamp, scope: 'all', basis: 'sale', rate: 1 });
const allRule = r.rule.id;
const entriesOf = (saleId) => sql(`SELECT string_agg(i.product_img || '=' || e.rate::float || '/' || e.rule_name, ';' ORDER BY i.product_img) FROM commission_entries e JOIN pos_sale_items i ON i.id = e.sale_item_id WHERE e.sale_id = ${saleId} AND e.kind = 'earned'`);
const runFor = async (s) => { sql(`UPDATE pos_sales SET created_at = NOW() - INTERVAL '1 minute' WHERE id = ${s.id}`); await admin('POST', '/api/comm/run'); return entriesOf(s.id); };
const s3 = await sale(rita.c, [{ product_img: img, description: 'Plain part', qty: 1, unit_price_usd: 1000 }, { product_img: img2, description: 'Part with its own 10%', qty: 1, unit_price_usd: 2000 }, { product_img: img3, description: 'No-commission part', qty: 1, unit_price_usd: 500 }], 0, { sales_rep_id: repId, sales_rep_name: 'Rita' });
const e3 = await runFor(s3);
ok(e3.includes(img + '=5/rep default'), 'a plain part earns her own 5%, not the 1% rule for every rep');
ok(e3.includes(img2 + '=10/part override'), 'a part with its own 10% earns 10%');
ok(!e3.includes(img3 + '='), 'a part set to no commission earns nothing');
await admin('PUT', '/api/comm/reps/' + repId + '/rate', { commission_pct: null });
const s4 = await sale(rita.c, line(0), 0, { sales_rep_id: repId, sales_rep_name: 'Rita' });
ok((await runFor(s4)).includes(img + '=1/Everyone 1% ' + stamp), 'a rep with no rate of her own falls back to the rule');
await admin('PUT', '/api/comm/reps/' + repId + '/rate', { commission_pct: 5 });

// Deleting a rule.
ok((await rita.c('DELETE', '/api/comm/rules/' + allRule))._status === 403, 'a rep cannot delete a rule');
r = await admin('DELETE', '/api/comm/rules/' + allRule);
ok(r._status === 200 && r.deleted && r.deleted.id === allRule, 'a manager deletes the rule');
ok(!(await admin('GET', '/api/comm/rules')).rules.some((x) => x.id === allRule), 'it is gone from the list');
ok((await admin('DELETE', '/api/comm/rules/' + allRule))._status === 404, 'deleting it again: not found');
ok(sql(`SELECT COUNT(*) FROM commission_entries WHERE sale_id = ${s4.id} AND rule_name = 'Everyone 1% ${stamp}'`) === '1', 'commission worked out with it stays');
sql(`UPDATE products SET commission_type = NULL, commission_value = NULL WHERE img IN ('${img2}', '${img3}')`);

r = await ann.c('GET', '/api/comm/me');
ok(r._status === 200 && r.rep === null && r.can.view === true, 'Ann (not a rep) gets no rep page, and the page knows she may see everyone\'s');

console.log(`\n${pass} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
