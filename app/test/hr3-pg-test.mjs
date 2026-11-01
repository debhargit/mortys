// People & HR part 3 (the employee centre) against a REAL server and a
// throwaway Postgres: the list (Active / Inactive / Released), the side panel,
// what pay each permission sees, the New Employee wizard and Employee
// Defaults, personal and employment details, TRN / NIS, photo, additional
// info, notes and to do's with reminders, payroll info and transactions,
// monthly leave accrual, make inactive, release and rehire, the lists and
// the Excel export.
//
//   HR_TEST_URL=http://localhost:3398 HR_TEST_PSQL="psql -h 127.0.0.1 -p 5499 -U postgres -d hrtest" node test/hr3-pg-test.mjs
//
// Refuses the live till's ports, and stops unless the server is writing to
// the database HR_TEST_PSQL points at. Signs in as the default admin.
import { execSync } from 'node:child_process';
import zlib from 'node:zlib';

const BASE = process.env.HR_TEST_URL || 'http://localhost:3398';
if (/:(3056|3059)\b/.test(BASE)) { console.log('FAIL refusing to run against the live till port'); process.exit(1); }
const PSQL = process.env.HR_TEST_PSQL;
if (!PSQL || /-p\s*5435\b/.test(PSQL)) { console.log('FAIL HR_TEST_PSQL must point at the throwaway database (never port 5435)'); process.exit(1); }
let pass = 0, fails = 0;
const ok = (c, m) => { if (c) { pass++; console.log('PASS ' + m); } else { fails++; console.log('FAIL ' + m); } };
const sql = (q) => execSync(PSQL + ' -tA', { input: q, encoding: 'utf8' }).trim();
function client() {
  const jar = {};
  return async function call(method, url, body, raw) {
    const r = await fetch(BASE + url, { method, headers: Object.assign({ Accept: 'application/json', Cookie: Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ') }, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
    for (const c of r.headers.getSetCookie ? r.headers.getSetCookie() : []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
    if (raw) return { status: r.status, buf: Buffer.from(await r.arrayBuffer()), headers: r.headers };
    return Object.assign({ _status: r.status }, await r.json().catch(() => ({})));
  };
}
function png() {
  const w = 64, h = 64, raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 4 + 1) + 1 + x * 4; raw[o] = x * 4; raw[o + 1] = y * 4; raw[o + 2] = 128; raw[o + 3] = 255; }
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}
const jaToday = () => new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10);
const addDays = (s, n) => new Date(Date.parse(s + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const TODAY = jaToday(), YEAR = Number(TODAY.slice(0, 4));

const admin = client();
const stamp = Date.now().toString(36);
ok((await admin('POST', '/api/auth/signin', { email: 'admin@visionautosolutions.com', password: 'password123' }))._status === 200, 'admin signs in');
// The server must be on the throwaway database: what it writes shows up there.
let r = await admin('POST', '/api/people/custom-fields', { label: 'Uniform size ' + stamp, kind: 'list', options: 'S, M, L' });
const sizeF = r.id;
if (sql(`SELECT COUNT(*) FROM hr_custom_fields WHERE label = 'Uniform size ${stamp}'`) !== '1') { console.log('FAIL the server is not writing to the HR_TEST_PSQL database: stopping'); process.exit(1); }
ok(true, 'the server is writing to the throwaway database');
ok((await admin('POST', '/api/people/custom-fields', { label: 'Size', kind: 'list', options: 'one' }))._status === 400, 'a list field needs two choices');
const licF = (await admin('POST', '/api/people/custom-fields', { label: 'Licence expires ' + stamp, kind: 'date' })).id;
await admin('POST', '/api/payroll/module', { on: true });

// People with less access: HR only, and HR who may see (not change) pay.
const mk = async (name, perms) => {
  const res = await admin('POST', '/api/admin/staff', { email: name.toLowerCase().replace(/\W+/g, '.') + '.' + stamp + '@example.test', password: 'Passw0rd!' + stamp, name, admin_role: 'cashier' });
  const id = (res.user || res).id;
  if (perms) sql(`UPDATE users SET perms = '${JSON.stringify(perms)}'::jsonb WHERE id = ${id}`);
  const c = client(); await c('POST', '/api/auth/signin', { email: name.toLowerCase().replace(/\W+/g, '.') + '.' + stamp + '@example.test', password: 'Passw0rd!' + stamp });
  return { id, c };
};
const hana = await mk('Hana Hr ' + stamp, { 'hr.people': true, 'payroll.view': false, 'payroll.run': false });
const vic = await mk('Vic Viewer ' + stamp, { 'hr.people': true, 'payroll.view': true, 'payroll.run': false });
const cas = await mk('Cass Cashier ' + stamp, null);
ok((await cas.c('GET', '/api/people/centre'))._status === 403, 'staff without hr.people cannot open the employee centre');

// ------------------------------------------------------- employee defaults
r = await admin('PUT', '/api/people/defaults', { probation_months: 2, leave_accrual: 'monthly', parish: 'St. Andrew', payroll: { frequency: 'fortnightly', pay_type: 'hourly', items: [{ code: 'meal_allow', amount: 1500 }, { code: 'nonsense', amount: 5 }, { code: 'basic', amount: 9 }] } });
ok(r._status === 200 && r.defaults.payroll.frequency === 'fortnightly' && r.defaults.payroll.items.length === 1 && r.defaults.payroll.items[0].code === 'meal_allow', 'defaults saved; only real, non-system pay items kept');
r = await hana.c('PUT', '/api/people/defaults', { probation_months: 2, payroll: { frequency: 'weekly' } });
ok(r._status === 403, 'HR without pay rights cannot change the payroll defaults');
r = await hana.c('PUT', '/api/people/defaults', { probation_months: 2, leave_accrual: 'monthly', parish: 'St. Andrew' });
ok(r._status === 200 && r.defaults.payroll.frequency === 'fortnightly', '… but can change the rest, and the payroll part stays');
r = await admin('GET', '/api/people/defaults');
ok(r.catalogue.some((c) => c.code === 'meal_allow') && !r.catalogue.some((c) => c.code === 'basic'), 'the defaults offer the pay items Payroll does not work out itself');

// ---------------------------------------------------- new employee wizard
const NAME = 'Wanda Wizard ' + stamp, START = (YEAR - 2) + '-03-15';
const wiz = (o) => Object.assign({ personal: { salutation: 'Ms', name: NAME, legal_name: 'Wanda Grace Wizard', preferred_name: 'Wanda', gender: 'female', date_of_birth: '1992-02-29', marital_status: 'married' },
  contact: { mobile: '876-555-0101', personal_email: 'wanda@example.test', address: '1 Main Street', town: 'Half Way Tree' },
  employment: { job_title: 'Counter clerk', start_date: START, employee_no: 'E-' + stamp },
  payroll: { add: true, trn: '123-456-789', nis_no: 'a123456', hourly_rate: 600, pay_on: true },
  emergency: { name: 'Walt Wizard', relationship: 'Husband', phone: '876-555-0102' },
  custom: { [sizeF]: 'M' }, onboarding: true }, o || {});
r = await admin('POST', '/api/people/new-employee', wiz({ payroll: { add: true, trn: '12345' } }));
ok(r._status === 400 && /TRN/.test(r.error), 'the wizard checks the TRN before saving anything');
ok(sql(`SELECT COUNT(*) FROM users WHERE name = '${NAME}'`) === '0', '… and nothing was saved');
r = await admin('POST', '/api/people/new-employee', wiz({ custom: { [sizeF]: 'XXL' } }));
ok(r._status === 400 && sql(`SELECT COUNT(*) FROM users WHERE name = '${NAME}'`) === '0', 'a choice not on the list is refused, nothing saved');
r = await hana.c('POST', '/api/people/new-employee', wiz());
ok(r._status === 403, 'HR without pay rights cannot put someone on Payroll in the wizard');
r = await admin('POST', '/api/people/new-employee', wiz());
const wid = r.id, wpid = r.payroll_id;
ok(r._status === 200 && wid && wpid && r.pay_on === true, 'the wizard adds the employee, on Payroll with pay on');
ok(sql(`SELECT disabled FROM users WHERE id = ${wid}`) === 't', 'their login is off until set up');
ok(sql(`SELECT salutation || '|' || legal_name || '|' || preferred_name || '|' || marital_status || '|' || town || '|' || parish || '|' || status || '|' || probation_months || '|' || leave_accrual FROM hr_employees WHERE user_id = ${wid}`) === 'Ms|Wanda Grace Wizard|Wanda|married|Half Way Tree|St. Andrew|probation|2|monthly', 'personal, address and employment saved, with the defaults (parish, probation, accrual)');
ok(sql(`SELECT frequency || '|' || pay_type || '|' || hourly_rate || '|' || trn || '|' || nis_no || '|' || is_active || '|' || to_char(hire_date, 'YYYY-MM-DD') FROM payroll_employees WHERE id = ${wpid}`) === `fortnightly|hourly|600.00|123-456-789|A123456|true|${START}`, 'Payroll gets the TRN, NIS, rate and the default frequency');
ok(sql(`SELECT code || ':' || amount FROM payroll_employee_items WHERE employee_id = ${wpid}`) === 'meal_allow:1500.00', 'the default meal allowance is on their pay');
ok(sql(`SELECT COUNT(*) FROM hr_contacts WHERE user_id = ${wid} AND is_primary`) === '1' && sql(`SELECT value FROM hr_custom_values WHERE user_id = ${wid} AND field_id = ${sizeF}`) === 'M', 'emergency contact and additional info saved');
ok(Number(sql(`SELECT COUNT(*) FROM hr_tasks WHERE user_id = ${wid} AND kind = 'onboarding'`)) >= 10, 'the starter checklist is added');
r = await admin('POST', '/api/people/new-employee', wiz({ payroll: {} }));
ok(r._status === 409 && r.duplicate === wid, 'the same name again asks first (a duplicate)');

// --------------------------------------------------------------- the list
r = await admin('GET', '/api/people/centre?state=active');
let w = r.staff.find((s) => s.id === wid);
ok(r._status === 200 && w && w.trn === '123-456-789' && w.hourly_rate === 600 && w.custom[sizeF] === 'M' && w.state === 'active', 'the list: everything, with the whole TRN for someone who may change pay');
ok(r.fields.some((f) => f.id === sizeF) && r.counts.active >= 1 && r.access.run, 'the list brings the fields, the counts and the access');
r = await hana.c('GET', '/api/people/centre');
w = r.staff.find((s) => s.id === wid);
ok(w && w.trn === null && w.has_trn === true && !('hourly_rate' in w) && !('pay_type' in w), 'HR without pay rights: no pay and no TRN on the list (only that one is recorded)');
r = await vic.c('GET', '/api/people/centre');
w = r.staff.find((s) => s.id === wid);
ok(w && /^•+789$/.test(w.trn) && /^•+456$/.test(w.nis_no) && w.hourly_rate === 600, 'HR who may see pay: the rate, and the TRN / NIS in part');

// ------------------------------------------------ payslips (from Payroll)
sql(`INSERT INTO payroll_runs (number, frequency, period_start, period_end, pay_date, status) VALUES ('PR-T1-${stamp}', 'fortnightly', '${YEAR}-01-01', '${YEAR}-01-14', '${YEAR}-01-16', 'paid'), ('PR-T2-${stamp}', 'fortnightly', '${YEAR}-01-15', '${YEAR}-01-28', '${YEAR}-01-30', 'void'), ('PR-T3-${stamp}', 'fortnightly', '${YEAR}-01-29', '${YEAR}-02-11', '${YEAR}-02-13', 'draft');
  INSERT INTO payroll_slips (run_id, employee_id, snapshot, lines, gross, statutory, paye, nis_ee, nht_ee, ed_ee, net, nis_er, nht_er, ed_er, heart_er)
  SELECT r.id, ${wpid}, '{}'::jsonb, '[{"code":"basic","label":"Basic pay","kind":"earning","qty":80,"rate":600,"amount":48000},{"code":"meal_allow","label":"Meal allowance","kind":"earning","qty":1,"rate":2000,"amount":2000}]'::jsonb,
    50000, 48500, 2000, 1500, 1000, 1100, 44400, 1500, 1500, 1750, 1500 FROM payroll_runs r WHERE r.number IN ('PR-T1-${stamp}', 'PR-T2-${stamp}', 'PR-T3-${stamp}');`);
r = await admin('GET', `/api/people/staff/${wid}/transactions?year=${YEAR}`);
ok(r._status === 200 && r.slips.length === 2 && r.slips.some((s) => s.status === 'void') && !r.slips.some((s) => s.status === 'draft'), 'transactions: paid and void payslips, not drafts');
ok(r.ytd.gross === 50000 && r.ytd.paye === 2000 && r.ytd.slips === 1 && r.ytd.heart_er === 1500, 'year to date counts only the paid one');
const basic = r.summary.find((s) => s.code === 'basic');
ok(basic && basic.qty === 80 && basic.amount === 48000 && r.years.includes(YEAR), 'the employee summary by pay item (hours and amount)');
r = await hana.c('GET', `/api/people/staff/${wid}/transactions?year=${YEAR}`);
ok(r._status === 200 && !('slips' in r) && Array.isArray(r.leave), 'HR without pay rights: leave taken, no payslips');
r = await admin('GET', `/api/people/centre/${wid}`);
ok(r._status === 200 && r.slips.length === 2 && r.ytd.gross === 50000 && r.todos.length === 0 && r.leave.accrual === 'monthly', 'the side panel: payslips, this year, leave');
r = await hana.c('GET', `/api/people/centre/${wid}`);
ok(r._status === 200 && !('slips' in r) && r.person.trn === null, 'the side panel without pay rights shows no pay');

// ---------------------------------------------------------- payroll info
r = await admin('GET', `/api/people/staff/${wid}/payroll`);
ok(r._status === 200 && r.employee.trn === '123-456-789' && r.items.length === 1 && r.rates && r.rates.nis_er > 0 && r.module_on, 'payroll info: read from Payroll, with the company rates');
r = await vic.c('GET', `/api/people/staff/${wid}/payroll`);
ok(r._status === 200 && /^•+789$/.test(r.employee.trn) && r.access.run === false, 'someone who may only see pay gets the numbers in part');
r = await hana.c('GET', `/api/people/staff/${wid}/payroll`);
ok(r._status === 200 && !r.employee && r.leave_accrual === 'monthly', 'HR without pay rights: only the leave part');
r = await admin('PUT', `/api/payroll/employees/${wpid}`, { hourly_rate: 650 });
ok(r._status === 200 && sql(`SELECT hourly_rate FROM payroll_employees WHERE id = ${wpid}`) === '650.00', 'pay is changed through Payroll itself');
r = await vic.c('PUT', `/api/payroll/employees/${wpid}`, { hourly_rate: 9999 });
ok(r._status === 403, '… which someone who may only see pay cannot do');

// ------------------------------------------------- personal, TRN and NIS
r = await admin('PUT', `/api/people/staff/${wid}/profile`, { salutation: 'Mrs', marital_status: 'common_law', name: NAME + ' Jr', adjusted_service_date: (YEAR - 1) + '-01-01', rehire_eligible: 'yes', job_description: 'Serves at the counter' });
ok(r._status === 200 && ['salutation', 'marital_status', 'adjusted_service_date', 'rehire_eligible', 'job_description', 'name'].every((k) => r.changed.includes(k)), 'personal and employment details saved');
ok(sql(`SELECT name FROM users WHERE id = ${wid}`) === NAME + ' Jr' && sql(`SELECT name FROM payroll_employees WHERE id = ${wpid}`) === NAME + ' Jr', 'the name changes on the staff record, and Payroll follows');
r = await admin('PUT', `/api/people/staff/${wid}/profile`, { salutation: 'Lord', leave_accrual: 'weekly' });
ok(sql(`SELECT COALESCE(salutation, '-') || '|' || leave_accrual FROM hr_employees WHERE user_id = ${wid}`) === '-|year', 'values not on the lists are not kept');
await admin('PUT', `/api/people/staff/${wid}/profile`, { salutation: 'Mrs', leave_accrual: 'monthly', name: NAME });
r = await admin('PUT', `/api/people/staff/${wid}/ids`, { trn: '123456789', nis_no: '12' });
ok(r._status === 400 && /NIS/.test(r.error), 'an NIS number has to look like one');
r = await admin('PUT', `/api/people/staff/${wid}/ids`, { trn: '987-654-321', nis_no: 'B765432' });
ok(r._status === 200 && sql(`SELECT trn || nis_no FROM payroll_employees WHERE id = ${wpid}`) === '987-654-321B765432', 'TRN and NIS saved in Payroll');
ok(sql(`SELECT COUNT(*) FROM hr_audit WHERE user_id = ${wid} AND action = 'TRN and NIS number changed' AND detail IS NULL`) === '1', 'the change is logged, without the numbers');
ok((await vic.c('PUT', `/api/people/staff/${wid}/ids`, { trn: '111-111-111' }))._status === 403, 'only someone who may change pay changes a TRN');
const plain = (await admin('POST', '/api/people/staff', { name: 'Paul Plain ' + stamp, start_date: (YEAR - 1) + '-06-01' })).id;
r = await admin('PUT', `/api/people/staff/${plain}/ids`, { trn: '222-333-444' });
ok(r._status === 200 && r.added_to_payroll && sql(`SELECT is_active::text || trn FROM payroll_employees WHERE user_id = ${plain}`) === 'false222-333-444', 'a TRN for someone not on Payroll adds them there, pay off');

// ------------------------------------------------------------------ photo
r = await admin('POST', `/api/people/staff/${wid}/photo`, { data: png() });
ok(r._status === 200, 'a photo is saved');
r = await admin('GET', `/api/people/staff/${wid}/photo`, null, true);
ok(r.status === 200 && r.headers.get('content-type') === 'image/jpeg' && r.buf[0] === 0xff && r.buf[1] === 0xd8, '… made a small JPEG');
r = await admin('GET', `/api/people/staff/${wid}`);
ok(r.profile.has_photo === true && !('photo' in r.profile) && r.profile.adjusted_service_date === (YEAR - 1) + '-01-01', 'the file says there is a photo, without sending it');
ok((await admin('POST', `/api/people/staff/${wid}/photo`, { data: 'data:image/png;base64,AAAA' }))._status === 400, 'something that is not a photo is refused');
ok((await cas.c('GET', `/api/people/staff/${wid}/photo`, null, true)).status === 403, 'the photo is for HR only');

// ------------------------------------------------------- additional info
r = await admin('PUT', `/api/people/staff/${wid}/custom`, { values: { [licF]: 'soon' } });
ok(r._status === 400, 'a date field needs a date');
r = await admin('PUT', `/api/people/staff/${wid}/custom`, { values: { [licF]: (YEAR + 1) + '-05-01', [sizeF]: 'L' } });
ok(r._status === 200 && r.changed.length === 2, 'additional info saved');
r = await admin('GET', `/api/people/staff/${wid}/custom`);
ok(r.fields.find((f) => f.id === sizeF).value === 'L', '… and read back');
ok((await admin('DELETE', `/api/people/custom-fields/${sizeF}`))._status === 409, 'a field in use cannot be removed');
ok((await admin('PUT', `/api/people/custom-fields/${sizeF}`, { is_active: false, kind: 'text' }))._status === 200 && sql(`SELECT kind || is_active::text FROM hr_custom_fields WHERE id = ${sizeF}`) === 'listfalse', '… it is switched off instead (and its kind stays)');

// ------------------------------------------------------ notes and to do's
r = await admin('POST', `/api/people/staff/${wid}/notes`, { kind: 'note', body: 'Asked for Saturdays off', pinned: true });
ok(r._status === 200, 'a note is added');
ok((await admin('POST', `/api/people/staff/${wid}/notes`, { kind: 'todo', body: 'Call', remind_at: 'tomorrow' }))._status === 400, 'a reminder needs a date and a time');
const past = new Date(Date.now() - 5 * 3600000 - 120000).toISOString().slice(0, 16);
r = await admin('POST', `/api/people/staff/${wid}/notes`, { kind: 'todo', todo_type: 'call', body: 'Call about the medical certificate ' + stamp, due_on: TODAY, remind_at: past, priority: 'high', assignee_id: hana.id });
const todoId = r.id;
ok(r._status === 200 && sql(`SELECT COUNT(*) FROM team_notices WHERE user_id = ${hana.id} AND title LIKE '%HR to do for you%'`) === '1', 'a to do for someone else tells them');
r = await hana.c('GET', '/api/people/todos?mine=1');
ok(r.todos.some((x) => x.id === todoId && x.person === NAME), 'it is on their own to do list');
let reminded = false;
for (let i = 0; i < 40 && !reminded; i++) { await new Promise((x) => setTimeout(x, 2000)); reminded = sql(`SELECT reminded_at IS NOT NULL FROM hr_notes WHERE id = ${todoId}`) === 't'; }
ok(reminded && sql(`SELECT COUNT(*) FROM team_notices WHERE user_id = ${hana.id} AND title LIKE '%Reminder: Call about%'`) === '1', 'when the reminder time comes they get a reminder, once');
r = await admin('PATCH', `/api/people/notes/${todoId}`, { done: true });
ok(r._status === 200 && sql(`SELECT done_at IS NOT NULL AND done_by IS NOT NULL FROM hr_notes WHERE id = ${todoId}`) === 't', 'the to do is ticked off');
r = await admin('GET', `/api/people/staff/${wid}/notes`);
ok(r.notes.length === 1 && r.notes[0].pinned && r.todos.length === 1 && r.todos[0].done_at, 'notes and to do\'s read back');

// --------------------------------------------------------- monthly leave
// Started two years ago, so this year it builds up a twelfth for each whole month gone.
sql(`UPDATE hr_employees SET adjusted_service_date = NULL WHERE user_id = ${wid}`);
const months = Number(TODAY.slice(5, 7)) - 1, earned = Math.floor(10 * months / 12 * 2) / 2;
sql(`DELETE FROM warehouse_settings WHERE key = 'payroll_vacation_days'`);
r = await admin('GET', `/api/people/staff/${wid}`);
ok(r.leave.accrual === 'monthly' && r.leave.vacation_entitled === 10 && r.leave.vacation_earned === earned && r.leave.vacation_left === earned, 'monthly: ' + earned + ' of 10 vacation days earned so far this year');
await admin('POST', `/api/people/staff/${wid}/leave-adjustments`, { kind: 'vacation', days: 2, reason: 'Carried over' });
r = await admin('GET', `/api/people/staff/${wid}`);
ok(r.leave.vacation_earned === earned + 2, 'days added count in full');
r = await admin('GET', `/api/people/staff/${plain}`);
ok(r.leave.accrual === 'year' && r.leave.vacation_earned === r.leave.vacation_entitled, 'the usual way: all the days from 1 January');

// --------------------------------------------- inactive, release and rehire
r = await admin('POST', `/api/people/staff/${wid}/inactive`, { reason: 'Maternity leave' });
ok(r._status === 200, 'made inactive');
let act = await admin('GET', '/api/people/centre?state=active'), ina = await admin('GET', '/api/people/centre?state=inactive');
ok(!act.staff.some((s) => s.id === wid) && ina.staff.some((s) => s.id === wid && s.inactive_reason === 'Maternity leave'), 'off the active list, on the inactive one');
ok((await admin('POST', `/api/people/staff/${wid}/rehire`, { rehire_date: TODAY }))._status === 409, 'someone not released cannot be rehired');
await admin('POST', `/api/people/staff/${wid}/inactive`, { inactive: false });
ok((await admin('GET', '/api/people/centre?state=active')).staff.some((s) => s.id === wid), 'made active again');
const LAST = addDays(TODAY, -1);
ok((await admin('POST', `/api/people/staff/${wid}/release`, { release_date: LAST }))._status === 400, 'a release needs the reason');
r = await admin('POST', `/api/people/staff/${wid}/release`, { release_date: LAST, reason: 'Resignation', rehire_eligible: false });
ok(r._status === 200 && /pays up to/.test(r.payroll), 'released: Payroll pays up to the last day');
ok(sql(`SELECT status || '|' || to_char(release_date, 'YYYY-MM-DD') || '|' || rehire_eligible FROM hr_employees WHERE user_id = ${wid}`) === `left|${LAST}|false`, 'the file shows the release date, left, not eligible for rehire');
ok(sql(`SELECT to_char(termination_date, 'YYYY-MM-DD') || '|' || termination_reason FROM payroll_employees WHERE id = ${wpid}`) === `${LAST}|Resignation`, 'Payroll has the termination date');
ok((await admin('GET', '/api/people/centre?state=released')).staff.some((s) => s.id === wid && s.release_date === LAST), 'on the released list');
ok((await admin('POST', `/api/people/staff/${wid}/release`, { release_date: LAST, reason: 'Again' }))._status === 409, 'cannot be released twice');
r = await hana.c('POST', `/api/people/staff/${plain}/release`, { release_date: TODAY, reason: 'End of contract' });
ok(r._status === 200 && /checklist/.test(r.payroll) && sql(`SELECT COUNT(*) FROM hr_tasks WHERE user_id = ${plain} AND title LIKE 'Payroll: set the termination date%'`) === '1', 'HR without pay rights: Payroll is left, with a checklist item for whoever runs it');
r = await admin('POST', `/api/people/staff/${wid}/rehire`, { rehire_date: TODAY });
ok(r._status === 409 && r.needs_override, 'not eligible for rehire: needs a reason to go ahead');
r = await admin('POST', `/api/people/staff/${wid}/rehire`, { rehire_date: TODAY, override_reason: 'Short of counter staff', service: 'restart', probation_months: 1, job_title: 'Senior counter clerk', onboarding: true });
ok(r._status === 200, 'rehired with the reason');
ok(sql(`SELECT status || '|' || to_char(start_date, 'YYYY-MM-DD') || '|' || to_char(adjusted_service_date, 'YYYY-MM-DD') || '|' || COALESCE(release_date::text, '-') || '|' || job_title FROM hr_employees WHERE user_id = ${wid}`) === `probation|${START}|${TODAY}|-|Senior counter clerk`, 'the original hire date stays; service counts from today; on probation in the new job');
ok(sql(`SELECT COALESCE(termination_date::text, '-') || '|' || to_char(hire_date, 'YYYY-MM-DD') || '|' || is_active FROM payroll_employees WHERE id = ${wpid}`) === `-|${TODAY}|false`, 'Payroll: no termination, paid from today, pay off until switched on');
ok(sql(`SELECT COUNT(*) FROM hr_job_history WHERE user_id = ${wid} AND kind = 'rehire' AND reason LIKE '%Short of counter staff%'`) === '1', 'the rehire is in the job history, with the reason');
ok((await admin('GET', '/api/people/centre?state=active')).staff.some((s) => s.id === wid && s.state === 'active'), 'back on the active list');
// An exit completed on the Leaving tab gives the release date too.
const xid = (await admin('POST', '/api/people/staff', { name: 'Xena Exit ' + stamp, start_date: (YEAR - 1) + '-02-01' })).id;
const ex = await admin('POST', `/api/people/staff/${xid}/exits`, { kind: 'end_of_contract', last_day: addDays(TODAY, -2) });
await admin('PATCH', `/api/people/exits/${ex.id}`, { complete: true, rehire: true });
ok(sql(`SELECT to_char(release_date, 'YYYY-MM-DD') || '|' || release_reason || '|' || rehire_eligible FROM hr_employees WHERE user_id = ${xid}`) === `${addDays(TODAY, -2)}|end of contract|true`, 'completing an exit sets the release date, reason and rehire');

// ------------------------------------------------------------------ lists
r = await admin('GET', '/api/people/lists/contacts');
w = r.rows.find((x) => x.id === wid);
ok(r._status === 200 && w && w.emergency && w.emergency.name === 'Walt Wizard' && w.mobile === '876-555-0101', 'contact list, with the emergency contact');
r = await admin('GET', '/api/people/lists/details?state=all');
ok(r.rows.some((x) => x.id === xid) && r.fields.some((f) => f.id === licF), 'employee details (all), with the fields');
r = await admin('GET', `/api/people/lists/withholding?year=${YEAR}`);
w = r.rows.find((x) => x.id === wid);
ok(r._status === 200 && w && w.trn === '987-654-321' && w.tax.gross === 50000 && w.tax.paye === 2000 && w.tax.ed_er === 1750 && w.tax.nht_er === 1500, 'withholding: TRN, NIS and the year\'s PAYE, NIS, NHT, Education Tax');
ok((await hana.c('GET', '/api/people/lists/withholding'))._status === 403, 'withholding needs the pay permission');
w = (await vic.c('GET', `/api/people/lists/withholding?year=${YEAR}`)).rows.find((x) => x.id === wid);
ok(w && /^•+321$/.test(w.trn), '… and shows the TRN in part to someone who may only see pay');
r = await admin('GET', `/api/people/lists/pto?year=${YEAR}`);
w = r.rows.find((x) => x.id === wid);
// Rehired today: service starts again today, so only the 2 days added are earned so far.
ok(w && w.leave_accrual === 'monthly' && w.vacation_earned === 2 && w.vacation_entitled === 12, 'paid time off: earned so far counts from the rehire');
r = await admin('GET', '/api/people/lists/birthdays?days=366');
const bd = r.rows.find((x) => x.id === wid && x.kind === 'birthday');
const leap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const next29 = (() => { for (const y of [YEAR, YEAR + 1]) { const s = y + '-' + (leap(y) ? '02-29' : '02-28'); if (s >= TODAY) return s; } })();
ok(bd && bd.date === next29 && bd.years === Number(next29.slice(0, 4)) - 1992, 'birthdays: a 29 February birthday is kept on the 28th in other years');
r = await admin('GET', '/api/people/lists/birthdays?days=366&state=all');
ok(r.rows.some((x) => x.id === plain && x.kind === 'anniversary' && x.years === (YEAR + '-06-01' >= TODAY ? 1 : 2)), 'work anniversaries in the window (counted in years)');
ok((await admin('GET', '/api/people/lists/nothing'))._status === 404, 'an unknown list');

// ------------------------------------------------------------------ Excel
r = await admin('POST', '/api/people/xlsx', { name: 'staff', sheets: [{ title: 'Active [staff]', header: ['Name', 'Rate'], rows: [['Wanda', 650], ['=cmd', null]] }] }, true);
ok(r.status === 200 && /spreadsheetml/.test(r.headers.get('content-type')) && r.buf.slice(0, 2).toString() === 'PK', 'the Excel file is a real .xlsx');
ok((await admin('POST', '/api/people/xlsx', { sheets: [] }))._status === 400, 'nothing to export');

console.log(`\n${pass} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
