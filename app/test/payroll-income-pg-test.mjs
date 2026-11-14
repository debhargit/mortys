// Payroll income types against a REAL server and a throwaway Postgres:
// commission, tips, service charge, gratuity and your own kinds of pay, each
// taxed as chosen (like pay / income tax only / not taxed / pick each), and
// "already received" pay (cash tips kept): taxed as chosen, in gross, not paid
// again in net pay, and no wages for it in the ledger.
//
//   PAY_TEST_URL=http://localhost:3394 PAY_TEST_PSQL="psql -h 127.0.0.1 -p 5497 -U postgres -d pay" node test/payroll-income-pg-test.mjs
//
// Refuses the live till's ports, and stops unless the server is writing to
// the database PAY_TEST_PSQL points at. Signs in as the default admin.
import { execSync } from 'node:child_process';

const BASE = process.env.PAY_TEST_URL || 'http://localhost:3394';
if (/:(3057|3058)\b/.test(BASE)) { console.log('FAIL refusing to run against the live till port'); process.exit(1); }
const PSQL = process.env.PAY_TEST_PSQL;
if (!PSQL || /-p\s*5435\b/.test(PSQL)) { console.log('FAIL PAY_TEST_PSQL must point at the throwaway database (never port 5435)'); process.exit(1); }
let pass = 0, fails = 0;
const ok = (c, m) => { if (c) { pass++; console.log('PASS ' + m); } else { fails++; console.log('FAIL ' + m); } };
const sql = (q) => execSync(PSQL + ' -tA', { input: q, encoding: 'utf8' }).trim();
const jar = {};
async function api(method, url, body) {
  const r = await fetch(BASE + url, { method, headers: Object.assign({ Accept: 'application/json', Cookie: Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ') }, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
  for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
  return Object.assign({ _status: r.status }, await r.json().catch(() => ({})));
}
const n = (v) => Number(v || 0), r2 = (v) => Math.round(v * 100) / 100, near = (a, b) => Math.abs(n(a) - n(b)) < 0.02;
const stamp = Date.now().toString(36);

ok((await api('POST', '/api/auth/signin', { email: 'admin@mortysautoparts.com', password: 'password123' }))._status === 200, 'admin signs in');
await api('POST', '/api/payroll/module', { on: true });
await api('POST', '/api/gl/setup', {});   // start the ledger (409 when already started)

// ---- The income types
let items = (await api('GET', '/api/payroll/items')).items || [];
const it = (code) => items.find((i) => i.code === code) || {};
ok(it('commission').kind === 'earning' && it('gratuity').kind === 'earning', 'commission and gratuity are there');
ok(it('commission_manual').paye && it('commission_manual').nis && !it('commission_manual').paid_outside, 'commission entered by hand: taxed like pay');
ok(it('tips').paye && it('tips').nis && !it('tips').paid_outside, 'tips (through the business): taxed like pay, paid in net');
ok(it('service_charge').paye && it('service_charge').heart, 'service charge share: taxed like pay');
ok(it('tips_cash').paid_outside && it('tips_cash').paye, 'cash tips kept: already received, taxed like pay');

let r = await api('POST', '/api/payroll/items', { label: 'Function gratuity ' + stamp, kind: 'earning', paye: true, nis: false, nht: false, ed: false, heart: false });
const payeOnly = r.code;
if (sql(`SELECT COUNT(*) FROM payroll_items WHERE code = '${payeOnly}'`) !== '1') { console.log('FAIL the server is not writing to the PAY_TEST_PSQL database: stopping'); process.exit(1); }
ok(true, 'the server is writing to the throwaway database');
r = await api('POST', '/api/payroll/items', { label: 'Bar tips kept ' + stamp, kind: 'earning', paye: false, nis: false, nht: false, ed: false, heart: false, paid_outside: true });
const freeKept = r.code;
r = await api('POST', '/api/payroll/items', { label: 'Union refund ' + stamp, kind: 'deduction', paid_outside: true });
items = (await api('GET', '/api/payroll/items')).items;
ok(it(payeOnly).paye && !it(payeOnly).nis && !it(payeOnly).heart && !it(payeOnly).paid_outside, 'a new earning taxed for income tax only');
ok(!it(freeKept).paye && !it(freeKept).nis && it(freeKept).paid_outside, 'a new earning not taxed and already received');
ok(!it(r.code).paid_outside, 'a deduction cannot be "already received"');
await api('PUT', '/api/payroll/items/basic', { paid_outside: true });
await api('PUT', '/api/payroll/items/tips', { paid_outside: true, paye: true, nis: false });
items = (await api('GET', '/api/payroll/items')).items;
ok(!it('basic').paid_outside, 'basic pay (worked out) is always paid through payroll');
ok(it('tips').paid_outside && it('tips').paye && !it('tips').nis, 'an item can be changed to already received and its taxes picked');
await api('PUT', '/api/payroll/items/tips', { paid_outside: false, nis: true });

// ---- A payslip with all of them
const emp = await api('POST', '/api/payroll/employees', { name: 'Tip Tester ' + stamp, pay_type: 'salary', frequency: 'monthly', salary_annual: 1200000, is_active: true, trn: '123-456-789', nis_no: 'A123456', hire_date: '2025-01-01', pay_method: 'cash' });
ok(emp.id > 0, 'employee added');
const ld = new Date(Date.now() - 5 * 3600000), y = ld.getUTCFullYear(), m = ld.getUTCMonth();
const ps = new Date(Date.UTC(y, m - 1, 1)).toISOString().slice(0, 10), pe = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
const run = await api('POST', '/api/payroll/runs', { frequency: 'monthly', period_start: ps, period_end: pe, pay_date: pe, employee_ids: [emp.id] });
ok(run.id > 0, 'monthly run made');
let view = await api('GET', '/api/payroll/runs/' + run.id);
let slip = view.slips.find((s) => s.employee_id === emp.id);
const basic = slip.lines.filter((l) => l.kind === 'earning');
const add = [['commission_manual', 20000], ['tips', 10000], ['service_charge', 6000], ['tips_cash', 15000], [payeOnly, 5000], [freeKept, 3000], ['gratuity', 4000]];
r = await api('PUT', '/api/payroll/runs/' + run.id + '/slips/' + slip.id, { lines: basic.concat(add.map(([code, amount]) => ({ code, amount, qty: '' }))) });
ok(r._status === 200, 'commission, tips, service charge, cash tips, gratuity and own types added to the payslip' + (r._status === 200 ? '' : ' (' + r._status + ' ' + r.error + ')'));
view = await api('GET', '/api/payroll/runs/' + run.id);
slip = view.slips.find((s) => s.employee_id === emp.id);
const basicAmt = basic.reduce((t, l) => t + n(l.amount), 0);
const rt = (await api('GET', '/api/payroll/rates')).current;
ok(near(slip.gross, basicAmt + 63000), 'gross pay has everything, already received too');
const nisBase = basicAmt + 20000 + 10000 + 6000 + 15000 + 4000;           // not the PAYE-only or untaxed items
ok(near(slip.nis_ee, r2(Math.min(nisBase, n(rt.nis_ceiling) / 12) * n(rt.nis_ee))), 'NIS: on pay, commission, tips, service charge, cash tips and gratuity only');
ok(near(slip.nht_ee, r2(nisBase * n(rt.nht_ee))), 'NHT: the same base');
const payeBase = nisBase + 5000;                                         // the PAYE-only gratuity joins income tax
ok(near(slip.statutory, r2(payeBase - n(slip.nis_ee) - n(slip.pension_ee))), 'income tax base adds the "income tax only" item, not the untaxed one');
ok(near(slip.net, r2(n(slip.gross) - n(slip.nis_ee) - n(slip.nht_ee) - n(slip.ed_ee) - n(slip.paye) - n(slip.pension_ee) - n(slip.other_ded) - 18000)), 'net pay leaves out the J$18,000 already received');
const rec = slip.lines.filter((l) => l.received).map((l) => l.code).sort();
ok(rec.join() === [freeKept, 'tips_cash'].sort().join(), 'the payslip marks the already-received lines');

// ---- The ledger: no wages for money the person already has; still balanced
await api('POST', '/api/payroll/runs/' + run.id + '/approve', {});
await api('POST', '/api/gl/post-now', {});
const entry = sql(`SELECT id FROM gl_entries WHERE source_kind = 'payroll_run' AND source_id = ${run.id}`);
ok(!!entry, 'the approved run is in the ledger');
ok(sql(`SELECT ROUND(SUM(amount), 2) FROM gl_lines WHERE entry_id = ${entry}`) === '0.00', 'the journal balances');
ok(sql(`SELECT COUNT(*) FROM gl_lines WHERE entry_id = ${entry} AND memo IN ('Cash tips kept (already received)', 'Bar tips kept ${stamp}')`) === '0', 'no wages posted for cash tips kept');
ok(sql(`SELECT COUNT(*) FROM gl_lines WHERE entry_id = ${entry} AND memo = 'Tips (paid through the business)'`) === '1', 'tips paid through the business are posted');
ok(near(sql(`SELECT -SUM(amount) FROM gl_lines WHERE entry_id = ${entry} AND memo = 'Net pay'`), slip.net), 'net wages owed is the net pay');

console.log('\n' + pass + ' passed, ' + fails + ' failed');
process.exit(fails ? 1 : 0);
