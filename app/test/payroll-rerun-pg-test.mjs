// Payroll: no two employees (or earnings / deductions) with the same name, and
// "Reverse and rerun" on a pay run -- against a REAL server and a throwaway
// Postgres. A run that was approved and paid is reversed in one go (payment,
// then run, each with its reversing ledger entry) and a new draft opens for the
// same people and dates, which can be approved and paid again.
//
//   PAY_TEST_URL=http://localhost:3394 PAY_TEST_PSQL="psql -h 127.0.0.1 -p 5497 -U postgres -d <db>" node test/payroll-rerun-pg-test.mjs
//
// Refuses the live till's ports. Signs in as the default admin. Fresh database.
import { execSync } from 'node:child_process';

const BASE = process.env.PAY_TEST_URL || 'http://localhost:3394';
if (/:(3056|3059)\b/.test(BASE)) { console.log('FAIL refusing to run against the live till port'); process.exit(1); }
const PSQL = process.env.PAY_TEST_PSQL;
if (!PSQL || /-p\s*5435\b/.test(PSQL)) { console.log('FAIL PAY_TEST_PSQL must point at the throwaway database (never port 5435)'); process.exit(1); }
let pass = 0, fails = 0;
const ok = (c, m) => { if (c) { pass++; console.log('PASS ' + m); } else { fails++; console.log('FAIL ' + m); } };
const sql = (q) => execSync(PSQL + ' -tA', { input: q, encoding: 'utf8' }).replace(/\r/g, '').trim();
const jar = {};
async function api(method, url, body) {
  const r = await fetch(BASE + url, { method, headers: Object.assign({ Accept: 'application/json', Cookie: Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ') }, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
  for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
  return Object.assign({ _status: r.status }, await r.json().catch(() => ({})));
}
const n = (v) => Number(v || 0), near = (a, b) => Math.abs(n(a) - n(b)) < 0.02;
const stamp = Date.now().toString(36);
const why = (r) => (r._status === 200 ? '' : ' [' + r._status + ' ' + r.error + ']');

ok((await api('POST', '/api/auth/signin', { email: 'admin@visionautosolutions.com', password: 'password123' }))._status === 200, 'admin signs in');
await api('POST', '/api/payroll/module', { on: true });
await api('POST', '/api/gl/setup', {});
await api('PUT', '/api/payroll/settings', { payroll_post_ledger: 'on' });

// ============================================================ duplicate names
const person = { pay_type: 'salary', frequency: 'monthly', salary_annual: 1200000, is_active: true, trn: '123-456-789', nis_no: 'A123456', hire_date: '2025-01-01' };
const e1 = await api('POST', '/api/payroll/employees', Object.assign({ name: 'Mary Brown ' + stamp }, person));
ok(e1.id > 0, 'employee added' + why(e1));
if (sql(`SELECT COUNT(*) FROM payroll_employees WHERE id = ${e1.id || 0}`) !== '1') { console.log('FAIL the server is not writing to the PAY_TEST_PSQL database: stopping'); process.exit(1); }
let r = await api('POST', '/api/payroll/employees', Object.assign({ name: 'Mary Brown ' + stamp }, person));
ok(r._status === 409 && /already on payroll/.test(r.error || ''), 'the same name again is refused: ' + (r.error || '').slice(0, 60));
r = await api('POST', '/api/payroll/employees', Object.assign({ name: '  mary   BROWN ' + stamp.toUpperCase() + ' ' }, person));
ok(r._status === 409, 'capitals and extra spaces do not make it a different name');
const e2 = await api('POST', '/api/payroll/employees', Object.assign({ name: 'Mary A. Brown ' + stamp }, person));
ok(e2.id > 0, 'a middle initial does');
r = await api('PUT', '/api/payroll/employees/' + e2.id, { name: 'Mary Brown ' + stamp });
ok(r._status === 409, 'an employee cannot be renamed to a name already on payroll');
r = await api('PUT', '/api/payroll/employees/' + e1.id, { phone: '876-555-0100' });
ok(r._status === 200, 'saving a record without changing its name still works' + why(r));
// two records that already share a name (from before the rule): each still opens and saves, but not both active
sql(`UPDATE payroll_employees SET name = 'Mary Brown ${stamp}', is_active = false WHERE id = ${e2.id}`);
r = await api('PUT', '/api/payroll/employees/' + e2.id, { phone: '876-555-0101' });
ok(r._status === 200, 'an old record that already shares a name can still be saved' + why(r));
r = await api('PUT', '/api/payroll/employees/' + e2.id, { is_active: true });
ok(r._status === 409, 'but it cannot be made active again under the shared name');
r = await api('PUT', '/api/payroll/employees/' + e2.id, { name: 'Mary A. Brown ' + stamp, is_active: true });
ok(r._status === 200, 'renamed, it can' + why(r));
// adding staff from the system skips a name already on payroll
const u = Number(sql(`INSERT INTO users (email, name, password_hash, is_staff, admin_role) VALUES ('mb${stamp}@example.test', 'mary brown ${stamp}', 'x', true, 'cashier') RETURNING id`).split('\n')[0]);
r = await api('POST', '/api/payroll/employees/import-staff', { user_ids: [u] });
ok(r._status === 200 && r.added === 0 && (r.skipped || []).length === 1, 'adding staff from the system skips a name already on payroll' + why(r));
// earnings and deductions
r = await api('POST', '/api/payroll/items', { label: 'Uniform ' + stamp, kind: 'deduction' });
const item1 = r.code;
ok(r._status === 200, 'a deduction added');
r = await api('POST', '/api/payroll/items', { label: 'uniform  ' + stamp, kind: 'deduction' });
ok(r._status === 409 && /already/.test(r.error || ''), 'a second deduction with the same name is refused');
r = await api('POST', '/api/payroll/items', { label: 'Boots ' + stamp, kind: 'deduction' });
r = await api('PUT', '/api/payroll/items/' + r.code, { label: 'Uniform ' + stamp });
ok(r._status === 409, 'nor can one be renamed to a name in use');
r = await api('PUT', '/api/payroll/items/' + item1, { label: 'Uniform ' + stamp, is_active: true });
ok(r._status === 200, 'saving an item under its own name still works' + why(r));

// ========================================================= reverse and rerun
const ld = new Date(Date.now() - 5 * 3600000), y = ld.getUTCFullYear(), m = ld.getUTCMonth();
const ps = new Date(Date.UTC(y, m - 1, 1)).toISOString().slice(0, 10), pe = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
const run = await api('POST', '/api/payroll/runs', { frequency: 'monthly', period_start: ps, period_end: pe, pay_date: pe, employee_ids: [e1.id, e2.id] });
ok(run.id > 0, 'monthly run made for two people' + why(run));
r = await api('POST', `/api/payroll/runs/${run.id}/rerun`, { reason: 'Test' });
ok(r._status === 409, 'a draft is not reversed: it is simply changed');
r = await api('POST', `/api/payroll/runs/${run.id}/approve`, {});
ok(r._status === 200, 'approved' + why(r));
const bank = Number(sql(`SELECT id FROM gl_accounts WHERE system_key = 'bank'`));
r = await api('POST', `/api/payroll/runs/${run.id}/pay`, { account_id: bank });
ok(r._status === 200 && r.payment_id > 0, 'wages paid' + why(r));
const payId = r.payment_id;
const net1 = n(sql(`SELECT SUM(net) FROM payroll_slips WHERE run_id = ${run.id}`));
const bal = (key) => n(sql(`SELECT COALESCE(SUM(l.amount), 0) FROM gl_lines l JOIN gl_accounts a ON a.id = l.account_id WHERE a.system_key = '${key}'`));
const bankAfterPay = bal('bank');
r = await api('POST', '/api/payroll/runs', { frequency: 'monthly', period_start: ps, period_end: pe, pay_date: pe, employee_ids: [e1.id] });
ok(r._status === 409, 'the same people cannot be paid twice for the same dates');

// the salary was wrong: put it right, then reverse and rerun
await api('PUT', '/api/payroll/employees/' + e1.id, { salary_annual: 1500000 });
r = await api('POST', `/api/payroll/runs/${run.id}/rerun`, {});
ok(r._status === 400, 'reversing needs a reason');
const rr = await api('POST', `/api/payroll/runs/${run.id}/rerun`, { reason: 'Mary\'s salary was entered wrong' });
ok(rr._status === 200 && rr.id > run.id, 'paid run reversed and a new draft opened: ' + rr.reversed + ' -> ' + rr.number + why(rr));
ok(sql(`SELECT status FROM payroll_runs WHERE id = ${run.id}`) === 'void' && sql(`SELECT (voided_at IS NOT NULL)::text FROM payroll_payments WHERE id = ${payId}`) === 'true', 'the old run is void and its payment voided, both kept on file');
ok(sql(`SELECT COUNT(*) FROM gl_entries WHERE (source_kind = 'payroll_run_void' AND source_id = ${run.id}) OR (source_kind = 'payroll_payment_void' AND source_id = ${payId})`) === '2', 'each has its reversing ledger entry');
ok(near(bal('bank'), bankAfterPay + net1), 'the bank is back up by the wages (' + net1 + ')');
ok(near(sql(`SELECT COALESCE(SUM(l.amount), 0) FROM gl_lines l JOIN gl_entries e ON e.id = l.entry_id WHERE (e.source_kind IN ('payroll_run', 'payroll_run_void') AND e.source_id = ${run.id}) OR (e.source_kind IN ('payroll_payment', 'payroll_payment_void') AND e.source_id = ${payId})`), 0)
  && sql(`SELECT COUNT(*) FROM (SELECT l.account_id FROM gl_lines l JOIN gl_entries e ON e.id = l.entry_id WHERE (e.source_kind IN ('payroll_run', 'payroll_run_void') AND e.source_id = ${run.id}) OR (e.source_kind IN ('payroll_payment', 'payroll_payment_void') AND e.source_id = ${payId}) GROUP BY 1 HAVING abs(SUM(l.amount)) > 0.005) x`) === '0', 'the old run nets to nothing on every account');
let view = await api('GET', '/api/payroll/runs/' + rr.id);
ok(view.run.status === 'draft' && view.slips.length === 2 && view.run.period_start === ps && view.run.period_end === pe && /Rerun of/.test(view.run.note || ''), 'the new draft has the same two people, dates and a note saying what it reruns');
const s1 = view.slips.find((s) => s.employee_id === e1.id);
ok(near(s1.gross, 125000), 'worked out again from the records as they are now: Mary\'s gross is 125,000 (' + s1.gross + ')');
r = await api('POST', `/api/payroll/runs/${rr.id}/approve`, {});
ok(r._status === 200, 'the rerun is approved' + why(r));
r = await api('POST', `/api/payroll/runs/${rr.id}/pay`, { account_id: bank });
ok(r._status === 200, 'and paid' + why(r));
ok(sql(`SELECT COUNT(*) FROM (SELECT entry_id FROM gl_lines GROUP BY 1 HAVING abs(SUM(amount)) > 0.005) x`) === '0', 'every journal balances');
// an approved (not yet paid) run reverses the same way; someone no longer active is left out
await api('PUT', '/api/payroll/employees/' + e2.id, { is_active: false });
r = await api('POST', `/api/payroll/payments/${r.payment_id}/void`, { reason: 'Test' });
const rr2 = await api('POST', `/api/payroll/runs/${rr.id}/rerun`, { reason: 'Second correction' });
ok(rr2._status === 200 && (rr2.left_out || []).length === 1, 'an approved run reverses too; a person no longer active is left out and named' + why(rr2));
r = await api('POST', `/api/payroll/runs/${rr.id}/rerun`, { reason: 'Again' });
ok(r._status === 409, 'a run is reversed once');

console.log(`\n${pass} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
