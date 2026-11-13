// Payroll end to end for Jamaica against a REAL server and a throwaway
// Postgres: allowances (travelling, housing, child care, uniform) taxed as set,
// a company vehicle as a benefit in kind, loans paid out and repaid, staff
// savings built up and paid out, someone starting in the middle of a period,
// year-to-date (cumulative) income tax with pay from an earlier employer,
// age relief, a final pay, the payslip a member of staff sees and prints, and
// the year end (close, lock, vacation carried forward, reopen).
//
//   PAY_TEST_URL=http://localhost:3394 PAY_TEST_PSQL="psql -h 127.0.0.1 -p 5497 -U postgres -d pay" node test/payroll-jamaica-pg-test.mjs
//
// Refuses the live till's ports, and stops unless the server is writing to
// the database PAY_TEST_PSQL points at. Signs in as the default admin.
import { execSync } from 'node:child_process';

const BASE = process.env.PAY_TEST_URL || 'http://localhost:3394';
if (/:(3056|3059)\b/.test(BASE)) { console.log('FAIL refusing to run against the live till port'); process.exit(1); }
const PSQL = process.env.PAY_TEST_PSQL;
if (!PSQL || /-p\s*5435\b/.test(PSQL)) { console.log('FAIL PAY_TEST_PSQL must point at the throwaway database (never port 5435)'); process.exit(1); }
let pass = 0, fails = 0;
const ok = (c, m) => { if (c) { pass++; console.log('PASS ' + m); } else { fails++; console.log('FAIL ' + m); } };
const sql = (q) => execSync(PSQL + ' -tA', { input: q, encoding: 'utf8' }).trim();
function client() {
  const jar = {};
  return async function api(method, url, body) {
    const r = await fetch(BASE + url, { method, headers: Object.assign({ Accept: 'application/json', Cookie: Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ') }, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
    for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
    return Object.assign({ _status: r.status }, await r.json().catch(() => ({})));
  };
}
const api = client();
const n = (v) => Number(v || 0), r2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100, near = (a, b) => Math.abs(n(a) - n(b)) < 0.02;
const stamp = Date.now().toString(36);

// The last two whole months, and the year before this one.
const ld = new Date(Date.now() - 5 * 3600000), Y = ld.getUTCFullYear(), M = ld.getUTCMonth();
const day = (y, m, d) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
const L = { start: day(Y, M - 1, 1), end: day(Y, M, 0) }, L1 = { start: day(Y, M - 2, 1), end: day(Y, M - 1, 0) };
const payYear = Number(L.end.slice(0, 4)), k = Number(L.end.slice(5, 7)), prevY = Y - 1;

ok((await api('POST', '/api/auth/signin', { email: 'admin@visionautosolutions.com', password: 'password123' }))._status === 200, 'admin signs in');
await api('POST', '/api/payroll/module', { on: true });
await api('POST', '/api/gl/setup', {});
await api('PUT', '/api/payroll/settings', { payroll_two_person: 'off', payroll_post_ledger: 'on' });

// ---- Allowances, benefits and savings are there, taxed as they should be
const items = (await api('GET', '/api/payroll/items')).items || [];
const it = (code) => items.find((i) => i.code === code) || {};
if (sql(`SELECT COUNT(*) FROM payroll_items WHERE code = 'mv_benefit'`) !== '1') { console.log('FAIL the throwaway database has no mv_benefit item: is schema.sql applied?'); process.exit(1); }
ok(it('travel_allow').paye && it('travel_allow').nis, 'travelling allowance: taxed like pay');
ok(it('travel_allow_ok').kind === 'earning' && !it('travel_allow_ok').paye && !it('travel_allow_ok').nis, 'TAJ-approved travelling allowance: not taxed');
ok(it('mv_upkeep').paye && it('housing_allow').paye && it('living_allow').paye && it('childcare_allow').paye && it('uniform_allow').paye && it('laundry_allow').paye, 'motor vehicle upkeep, housing, living, child care, uniform and laundry allowances: taxed');
ok(!it('uniform_allow_ok').paye && !it('mileage').paye, 'approved uniform allowance and mileage repaid: not taxed');
ok(it('mv_benefit').kind === 'employer' && it('mv_benefit').notional && it('mv_benefit').paye && !it('mv_benefit').nis, 'company vehicle: a benefit in kind, taxed for income tax, no NIS');
ok(it('housing_benefit').notional && it('staff_savings').is_savings && it('credit_union').is_savings, 'housing benefit in kind; staff savings and credit union build up savings');
const mv = await api('GET', '/api/payroll/mv-schedule');
ok(mv._status === 200 && mv.rows.length >= 4 && mv.rows.every((r) => r.length === 5) && !mv.custom, 'the company vehicle schedule is there (built-in figures)');
let r = await api('PUT', '/api/payroll/mv-schedule', { rows: [[500000, 1, 2, 3, 4], ['', 5, 6, 7, 8]] });
ok(r.custom && r.rows.length === 2 && r.rows[1][0] === null, 'the schedule can be changed');
r = await api('PUT', '/api/payroll/mv-schedule', { reset: true });
ok(!r.custom, 'and put back to the built-in figures');

// ---- People
const staffEmail = 'amy.allow.' + stamp + '@example.test', staffPw = 'Passw0rd!' + stamp;
const su = await api('POST', '/api/admin/staff', { email: staffEmail, password: staffPw, name: 'Amy Allowance ' + stamp, admin_role: 'cashier' });
const staffId = (su.user || su).id;
ok(staffId > 0, 'a member of staff is created for self-service');
const mk = async (name, extra) => (await api('POST', '/api/payroll/employees', Object.assign({ name: name + ' ' + stamp, pay_type: 'salary', frequency: 'monthly', salary_annual: 3600000, is_active: true, trn: '123-456-789', nis_no: 'A123456', hire_date: (prevY - 1) + '-01-01', pay_method: 'cash', use_timeclock: false }, extra)));
const A = await mk('Amy Allowance', { user_id: staffId });
const B = await mk('Ben Begins', { hire_date: L.start.slice(0, 8) + '16' });
const C = await mk('Cara Cumulative', { paye_method: 'cumulative', hire_date: L.start, prior_year: payYear, prior_employer: 'Old Firm Ltd', prior_gross: 1000000, prior_statutory: 970000, prior_paye: 50000, prior_nis: 30000 });
const D = await mk('Dan Declared', { paye_method: 'cumulative', hire_date: L.start, salary_annual: 3000000 });
const E = await mk('Eve Elder', { date_of_birth: (Y - 70) + '-01-01' });
const F = await mk('Fay Final', { termination_date: L.start.slice(0, 8) + '20', termination_reason: 'Resigned' });
ok([A, B, C, D, E, F].every((e) => e.id > 0), 'six employees added' + ([A, B, C, D, E, F].find((e) => !e.id) ? ' (' + JSON.stringify([A, B, C, D, E, F].find((e) => !e.id)) + ')' : ''));
const cd = await api('GET', '/api/payroll/employees/' + C.id);
ok(cd.employee.paye_method === 'cumulative' && n(cd.employee.prior_paye) === 50000 && cd.employee.age_relief === true, 'income tax method, earlier-employer figures and age relief are kept on the employee');
const nostat = await mk('No Statutory', { paye_method: 'cumulative', prior_gross: 500000, prior_nis: 15000, is_active: false });
ok(near((await api('GET', '/api/payroll/employees/' + nostat.id)).employee.prior_statutory, 485000), 'statutory income with the earlier employer defaults to gross less NIS and pension');

const add = async (id, code, amount, extra) => api('POST', '/api/payroll/employees/' + id + '/items', Object.assign({ code, amount }, extra));
for (const [code, amount] of [['travel_allow', 20000], ['travel_allow_ok', 10000], ['childcare_allow', 5000], ['uniform_allow_ok', 3000], ['housing_allow', 15000], ['mv_benefit', 5000]]) r = await add(A.id, code, amount);
ok(r._status === 200, 'allowances and a company vehicle benefit set for every pay');
const sv = await add(A.id, 'staff_savings', 10000);
ok(sv.id > 0, 'staff savings of J$10,000 a pay set up');
r = await api('POST', '/api/payroll/employees/' + A.id + '/loans', { kind: 'loan', amount: 60000, repay_per_pay: 20000, method: 'payslip', issue_date: L1.start });
ok(r._status === 200, 'a J$60,000 loan to be paid on the next payslip, J$20,000 back each pay');
await add(F.id, 'loan', 5000, { balance: 30000 });

// ---- Run 1 (two months ago): allowances, the benefit in kind, the loan paid out, savings
const run1 = await api('POST', '/api/payroll/runs', { frequency: 'monthly', period_start: L1.start, period_end: L1.end, pay_date: L1.end, employee_ids: [A.id] });
ok(run1.id > 0, 'run 1 made');
let view = await api('GET', '/api/payroll/runs/' + run1.id);
const rt = view.run.rates;
let s = view.slips.find((x) => x.employee_id === A.id);
const thr = n(rt.paye_threshold) / 12, band = n(rt.paye_band2_from) / 12;
const taxOn = (st, t, b) => n(rt.paye_rate1) * Math.max(0, Math.min(st, b) - t) + n(rt.paye_rate2) * Math.max(0, st - Math.max(b, t));
ok(near(s.gross, 300000 + 20000 + 10000 + 5000 + 3000 + 15000), 'gross pay: salary and the allowances; not the loan paid out (not pay) or the vehicle benefit (not cash)');
const nisBase = 300000 + 20000 + 5000 + 15000, nis = r2(Math.min(nisBase, n(rt.nis_ceiling) / 12) * n(rt.nis_ee));
ok(near(s.nis_ee, nis), 'NIS: on salary and the taxed allowances only (not the approved allowances, the loan or the vehicle)');
ok(near(s.nht_ee, r2((nisBase + 5000) * n(rt.nht_ee))), 'NHT: the same plus the vehicle benefit');
ok(near(s.statutory, nisBase + 5000 - nis), 'statutory income: taxed pay plus the vehicle benefit, less NIS');
ok(near(s.paye, r2(taxOn(nisBase + 5000 - nis, thr, band))), 'income tax on it at the usual (non-cumulative) rate');
ok(near(s.taxable_benefits, 5000) && near(s.er_benefits, 0), 'the benefit in kind is taxable, and no cost to pay over');
ok(near(s.net, r2(n(s.gross) + 60000 - n(s.nis_ee) - n(s.nht_ee) - n(s.ed_ee) - n(s.paye) - 10000)), 'net pay: gross less statutory deductions and savings, plus the loan paid out');
ok(s.lines.some((l) => l.code === 'mv_benefit' && l.notional) && s.tax && s.tax.method === 'non_cumulative' && near(s.tax.free_period, thr), 'the payslip records the benefit as in kind and how the tax was worked');
ok((await api('POST', '/api/payroll/runs/' + run1.id + '/approve', {}))._status === 200, 'run 1 approved');
await api('POST', '/api/gl/post-now', {});
const entry = sql(`SELECT id FROM gl_entries WHERE source_kind = 'payroll_run' AND source_id = ${run1.id}`);
ok(!!entry && sql(`SELECT ROUND(SUM(amount), 2) FROM gl_lines WHERE entry_id = ${entry}`) === '0.00', 'run 1 is in the ledger and balances');
ok(sql(`SELECT COUNT(*) FROM gl_lines WHERE entry_id = ${entry} AND memo ILIKE 'Company vehicle%'`) === '0', 'nothing is posted for the benefit in kind');
ok(sql(`SELECT saved FROM payroll_employee_items WHERE id = ${sv.id}`) === '10000.00', 'J$10,000 saved after the first pay');
const tp = await api('GET', '/api/payroll/deductions?month=' + L1.end.slice(0, 7));
ok(!tp.lines.some((l) => l.code === 'mv_benefit' || l.code === 'staff_savings'), 'the benefit in kind and staff savings are not listed as owed to someone else');

// ---- Savings paid out
r = await api('POST', '/api/payroll/employee-items/' + sv.id + '/payout', { amount: 50000 });
ok(r._status === 400, 'cannot pay out more than is saved');
r = await api('POST', '/api/payroll/employee-items/' + sv.id + '/payout', { amount: 6000 });
ok(r._status === 200 && r.amount === 6000, 'J$6,000 of savings to be paid out on the next payslip');

// ---- Run 2 (last month): everyone
const everyone = [A.id, B.id, C.id, D.id, E.id, F.id];
const mkRun2 = () => api('POST', '/api/payroll/runs', { frequency: 'monthly', period_start: L.start, period_end: L.end, pay_date: L.end, employee_ids: everyone });
let run2 = await mkRun2();
ok(run2.id > 0, 'run 2 made');
view = await api('GET', '/api/payroll/runs/' + run2.id);
const slip = (e) => view.slips.find((x) => x.employee_id === e.id);
s = slip(A);
ok(s.lines.some((l) => l.code === 'loan' && near(l.amount, 20000)) && !s.lines.some((l) => l.code === 'advance_paid'), 'the loan repayment of J$20,000 starts on the pay after it was paid out');
ok(s.lines.some((l) => l.code === 'savings_payout' && near(l.amount, 6000) && l.savings_id === sv.id), 'the savings payout is on the payslip');
ok(near(s.statutory, nisBase + 5000 - nis) && near(s.gross, 353000) && near(s.net, r2(353000 + 6000 - n(s.nis_ee) - n(s.nht_ee) - n(s.ed_ee) - n(s.paye) - 20000 - 10000)), 'the savings payout is not pay and not taxed: added to net pay only');
r = await api('PUT', '/api/payroll/runs/' + run2.id + '/slips/' + s.id, { lines: s.lines.map((l) => (l.code === 'savings_payout' ? Object.assign({}, l, { qty: '', amount: 9000 }) : l)) });
ok(r._status === 400, 'a savings payout cannot be changed on the payslip');

s = slip(B);
const basicB = s.lines.find((l) => l.code === 'basic');
ok(/working days/.test(basicB.label) && n(basicB.amount) > 0 && n(basicB.amount) < 300000, 'someone who starts in the middle of the period is paid for the days from the start date (' + basicB.label + ')');
ok(s.warnings.some((w) => /^Started /.test(w)), 'and the payslip says it is their first pay');

s = slip(C);
const nisC = r2(Math.min(300000, n(rt.nis_ceiling) / 12) * n(rt.nis_ee)), statC = 300000 - nisC;
const dueC = taxOn(970000 + statC, k * thr, k * band);
ok(s.tax.method === 'cumulative' && s.tax.period === k && near(s.tax.statutory_to_date, 970000 + statC) && near(s.tax.paid_before, 50000), 'year-to-date income tax counts the pay and tax from the earlier employer');
ok(near(s.paye, Math.max(0, r2(dueC - 50000))), 'income tax = tax due on the year so far less what was already paid (' + s.paye + ')');

s = slip(D);
const nisD = r2(250000 * n(rt.nis_ee)), statD = 250000 - nisD;
ok(near(s.paye, Math.max(0, r2(taxOn(statD, k * thr, k * band)))), 'a starter with no earlier pay this year gets the tax-free pay not used earlier in the year (' + s.paye + ' against ' + r2(taxOn(statD, thr, band)) + ' on the usual method)');

s = slip(E);
const thrE = (n(rt.paye_threshold) + n(rt.age_relief)) / 12, nisE = r2(Math.min(300000, n(rt.nis_ceiling) / 12) * n(rt.nis_ee));
ok(n(rt.age_relief) > 0 && near(s.tax.age_relief, n(rt.age_relief)), 'age relief is given by itself from 65');
ok(near(s.paye, r2(taxOn(300000 - nisE, thrE, band))), 'and lowers the income tax');

s = slip(F);
ok(s.warnings.some((w) => /^Final pay/.test(w) && /still owed 30000\.00/.test(w)), 'a final pay is flagged with the loan still owed');
ok(/working days/.test(s.lines.find((l) => l.code === 'basic').label), 'and is for the days up to the leaving date');

ok((await api('POST', '/api/payroll/runs/' + run2.id + '/approve', {}))._status === 200, 'run 2 approved');
const bal = () => sql(`SELECT saved || '|' || payout_pending FROM payroll_employee_items WHERE id = ${sv.id}`);
ok(bal() === '14000.00|0.00', 'savings after the second pay and the payout: J$14,000');
const loanBal = () => sql(`SELECT i.balance FROM payroll_loans l JOIN payroll_employee_items i ON i.id = l.item_id WHERE l.employee_id = ${A.id}`);
ok(loanBal() === '40000.00', 'the loan is down to J$40,000');
r = await api('POST', '/api/payroll/runs/' + run2.id + '/void', { reason: 'test' });
ok(r._status === 200 && bal() === '10000.00|6000.00' && loanBal() === '60000.00', 'voiding the run puts the savings, the payout and the loan back');
run2 = await mkRun2();
ok(run2.id > 0 && (await api('POST', '/api/payroll/runs/' + run2.id + '/approve', {}))._status === 200, 'the run is made and approved again');
ok(bal() === '14000.00|0.00' && loanBal() === '40000.00', 'and the balances are right again');
await api('POST', '/api/gl/post-now', {});
const e2 = sql(`SELECT id FROM gl_entries WHERE source_kind = 'payroll_run' AND source_id = ${run2.id}`);
ok(!!e2 && sql(`SELECT ROUND(SUM(amount), 2) FROM gl_lines WHERE entry_id = ${e2}`) === '0.00', 'run 2 (with the savings payout and loan repayment) balances in the ledger');

// A later run for someone on year-to-date tax must be current when approved.
view = await api('GET', '/api/payroll/runs/' + run2.id);

// ---- The payslip: payroll sees it, the person sees their own, nobody else's
const slipA = view.slips.find((x) => x.employee_id === A.id), slipC = view.slips.find((x) => x.employee_id === C.id);
let pv = await api('GET', '/api/payroll/slips/' + slipA.id);
ok(pv._status === 200 && pv.loans.length === 1 && near(pv.loans[0].balance, 40000) && pv.savings.some((x) => near(x.saved, 14000)), 'the payslip shows the loan still owed and the savings');
ok(pv.slip.tax && pv.ytd && near(pv.ytd.paye, n(slipA.paye) + (L1.end.slice(0, 4) === L.end.slice(0, 4) ? n(sql(`SELECT paye FROM payroll_slips WHERE run_id = ${run1.id}`)) : 0)), 'and the year to date up to its pay date');
pv = await api('GET', '/api/payroll/slips/' + slipC.id);
ok(pv.prior && near(pv.prior.gross, 1000000), 'a payslip for someone with an earlier job this year shows those figures');
const amy = client();
ok((await amy('POST', '/api/auth/signin', { email: staffEmail, password: staffPw }))._status === 200, 'the member of staff signs in');
const mine = await amy('GET', '/api/payroll/me');
ok(mine._status === 200 && mine.employee && mine.slips.length === 2 && mine.loans.length === 1 && mine.savings.length === 1 && mine.items.length >= 6, 'My pay: their payslips, loan, savings and what comes every pay');
ok((await amy('GET', '/api/payroll/slips/' + slipA.id))._status === 200, 'they can open their own payslip');
ok((await amy('GET', '/api/payroll/slips/' + slipC.id))._status === 403, 'but not someone else\'s');
ok((await amy('GET', '/api/payroll/employees'))._status === 403 && (await amy('GET', '/api/payroll/year-end'))._status === 403, 'and nothing else in payroll');
const page = await fetch(BASE + '/payslip.html'), js = await fetch(BASE + '/assets/payslip.js');
ok(page.status === 200 && /My pay/.test(await page.text()) && js.status === 200 && /window\.Payslip/.test(await js.text()), 'the My pay page and the payslip drawing are served');

// ---- Year end
let ye = await api('GET', '/api/payroll/year-end?year=' + Y);
ok(ye._status === 200 && ye.year === String(Y) && !ye.closed && ye.loans.n >= 1 && ye.savings.held >= 14000, 'year end shows the year, the loans and the savings that carry on');
const draftRun = await api('POST', '/api/payroll/runs', { frequency: 'monthly', period_start: prevY + '-11-01', period_end: prevY + '-11-30', pay_date: prevY + '-11-30', employee_ids: [E.id] });
ok(draftRun.id > 0, 'a pay run dated in ' + prevY + ' is made');
r = await api('POST', '/api/payroll/year-end/close', { year: prevY, carry_max: 5 });
ok(r._status === 409 && /draft/.test(r.error), 'a year with a draft run in it cannot be closed');
ok((await api('POST', '/api/payroll/runs/' + draftRun.id + '/approve', {}))._status === 200, 'the run is approved');
ye = await api('GET', '/api/payroll/year-end?year=' + prevY);
const lv = ye.leave.find((l) => l.id === A.id);
ok(ye.can_close && lv && lv.left >= 5 && lv.carry === 5, 'vacation days not taken, up to the limit of 5, are set to carry forward');
r = await api('POST', '/api/payroll/year-end/close', { year: prevY });
ok(r._status === 200 && r.carried >= 1, prevY + ' is closed' + (r._status === 200 ? '' : ' (' + r.error + ')'));
ok(sql(`SELECT days FROM hr_leave_adjustments WHERE user_id = ${staffId} AND year = ${Y} AND kind = 'vacation'`) === '5.00', 'five vacation days are carried into ' + Y);
r = await api('POST', '/api/payroll/runs', { frequency: 'monthly', period_start: prevY + '-10-01', period_end: prevY + '-10-31', pay_date: prevY + '-10-31', employee_ids: [E.id] });
ok(r._status === 409 && /closed/.test(r.error), 'no new pay run can be dated in a closed year');
r = await api('POST', '/api/payroll/runs/' + draftRun.id + '/void', { reason: 'test' });
ok(r._status === 409 && /closed/.test(r.error), 'and a run in it cannot be voided');
ok((await api('POST', '/api/payroll/year-end/close', { year: prevY }))._status === 409, 'a closed year cannot be closed twice');
const me2 = await amy('GET', '/api/payroll/me');
ok(String(me2.year) === String(Y) && me2.leave.vacation_adjusted === 5, 'the carried days show in the person\'s leave for ' + Y);
const eE = await api('GET', '/api/payroll/employees/' + E.id);
ok(eE.ytd.slips === (payYear === Y ? 1 : 0), 'the year to date starts again: pay dated in ' + prevY + ' is not in ' + Y + '\'s figures');
ok((await amy('POST', '/api/payroll/year-end/reopen', { year: prevY, reason: 'x' }))._status === 403, 'staff cannot reopen a year');
ok((await api('POST', '/api/payroll/year-end/reopen', { year: prevY }))._status === 400, 'reopening needs a reason');
ok((await api('POST', '/api/payroll/year-end/reopen', { year: prevY, reason: 'correct a payslip' }))._status === 200, 'someone who may approve reopens it');
ok((await api('POST', '/api/payroll/runs/' + draftRun.id + '/void', { reason: 'test' }))._status === 200, 'then the run can be voided');
r = await api('POST', '/api/payroll/year-end/close', { year: prevY, carry_max: 3 });
ok(r._status === 200 && sql(`SELECT string_agg(days::text, ',') FROM hr_leave_adjustments WHERE user_id = ${staffId} AND year = ${Y} AND kind = 'vacation'`) === '3.00', 'closing again writes the carried days afresh (3 this time, not 5 + 3)');
if (ld.getUTCMonth() < 11) {
  r = await api('POST', '/api/payroll/year-end/close', { year: Y });
  ok(r._status === 409 && /1 December/.test(r.error), 'this year cannot be closed before December');
}
const sum = await api('GET', '/api/payroll/summary');
ok(sum._status === 200 && 'year_end' in sum, 'the overview knows whether a year end is waiting');

console.log('\n' + pass + ' passed, ' + fails + ' failed');
process.exit(fails ? 1 : 0);
