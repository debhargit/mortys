// People & HR part 2 against a REAL server and a throwaway Postgres: hiring
// managers and interviewers, adding staff, contracts, documents sent to staff
// to sign (in My HR file and from the private link with an access code), and
// the QuickBooks employee and payroll item imports.
//
//   HR_TEST_URL=http://localhost:3398 HR_TEST_PSQL="psql -h 127.0.0.1 -p 5499 -U postgres -d hrtest" node test/hr2-pg-test.mjs
//
// Refuses the live till's ports. Signs in as the default admin (password123).
import { execSync } from 'node:child_process';
import zlib from 'node:zlib';

const BASE = process.env.HR_TEST_URL || 'http://localhost:3398';
if (/:(3057|3058)\b/.test(BASE)) { console.log('FAIL refusing to run against the live till port'); process.exit(1); }
const PSQL = process.env.HR_TEST_PSQL;
let pass = 0, fails = 0;
const ok = (c, m) => { if (c) { pass++; console.log('PASS ' + m); } else { fails++; console.log('FAIL ' + m); } };
const sql = (q) => (PSQL ? execSync(PSQL + ' -tA', { input: q, encoding: 'utf8' }).trim() : '');
function client() {
  const jar = {};
  return async function call(method, url, body, raw, headers) {
    const r = await fetch(BASE + url, { method, headers: Object.assign({ Accept: 'application/json', Cookie: Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ') }, body ? { 'Content-Type': 'application/json' } : {}, headers || {}), body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
    for (const c of r.headers.getSetCookie ? r.headers.getSetCookie() : []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
    if (raw) return { status: r.status, text: await r.text(), headers: r.headers };
    return Object.assign({ _status: r.status }, await r.json().catch(() => ({})));
  };
}
// A real PNG the size of a drawn signature (200x80): a wavy line.
function png() {
  const w = 200, h = 80, raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; for (let x = 0; x < w; x++) { const o = y * (w * 4 + 1) + 1 + x * 4; const on = Math.abs(Math.sin(x / 9) * 30 + 40 - y) < 2 || (x * 7 + y * 13) % 97 === 0; raw[o] = raw[o + 1] = raw[o + 2] = on ? 0 : 255; raw[o + 3] = 255; } }
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const buf = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  return 'data:image/png;base64,' + buf.toString('base64');
}

const admin = client();
const stamp = Date.now().toString(36);
ok((await admin('POST', '/api/auth/signin', { email: 'admin@mortysautoparts.com', password: 'password123' }))._status === 200, 'admin signs in');
const mk = async (name, role) => { const r = await admin('POST', '/api/admin/staff', { email: name.toLowerCase().replace(/\W+/g, '.') + '.' + stamp + '@example.test', password: 'Passw0rd!' + stamp, name, admin_role: role }); return (r.user || r).id; };
const hmId = await mk('Hal Manager', 'cashier'), ivId = await mk('Ivy Interviewer', 'cashier'), emId = await mk('Emma Employee', 'cashier');
const signIn = async (name) => { const c = client(); await c('POST', '/api/auth/signin', { email: name.toLowerCase().replace(/\W+/g, '.') + '.' + stamp + '@example.test', password: 'Passw0rd!' + stamp }); return c; };
const hal = await signIn('Hal Manager'), ivy = await signIn('Ivy Interviewer'), emma = await signIn('Emma Employee');

// ---------------------------------------------- hiring managers, interviewers
let r = await admin('POST', '/api/hr/requisitions', { title: 'Parts driver ' + stamp, justification: 'Deliveries', hiring_manager_id: hmId, interviewer_ids: [ivId, 'x', ivId], submit: true });
const reqId = r.id;
await admin('POST', `/api/hr/requisitions/${reqId}/decide`, { decision: 'approve' });
r = await admin('POST', `/api/hr/requisitions/${reqId}/post`);
ok(r.job && r.job.hiring_manager_id === hmId && JSON.stringify(r.job.interviewer_ids) === JSON.stringify([ivId]), 'posting takes the hiring manager and interviewers from the requisition');
const job = r.job;
await admin('PUT', `/api/hr/jobs/${job.id}`, Object.assign({}, job, { is_open: true }));
const fd = new FormData(); fd.append('name', 'Dean Driver'); fd.append('email', 'dean.' + stamp + '@example.test'); fd.append('phone', '876-555-0444'); fd.append('consent', 'yes');
const ap = await (await fetch(BASE + '/api/public/jobs/' + job.id + '/apply', { method: 'POST', body: fd })).json();
ok(ap.ok, 'someone applies');
await new Promise((x) => setTimeout(x, 300));
if (PSQL) ok(sql(`SELECT COUNT(*) FROM team_notices WHERE user_id = ${hmId} AND title LIKE '%New applicant%'`) === '1', 'the hiring manager is told about the new applicant');
const mj = await hal('GET', '/api/hr/my-jobs');
ok(mj.jobs.length === 1 && mj.jobs[0].is_manager && mj.applications.length === 1, 'My jobs: Hal sees his job and its applicant');
const appId = mj.applications[0].id;
r = await hal('GET', `/api/hr/applications/${appId}`);
ok(r._status === 200 && r.role === 'manager' && r.application.name === 'Dean Driver', 'the hiring manager can read the application');
r = await hal('POST', `/api/hr/applications/${appId}/notes`, { note: 'Good driving record' });
ok(r._status === 200, 'the hiring manager adds a note');
r = await hal('PATCH', `/api/hr/applications/${appId}`, { stage: 'shortlist' });
ok(r._status === 403, 'but cannot move the stage (hiring staff do that)');
r = await hal('GET', `/api/hr/jobs/${job.id}/compare`);
ok(r._status === 200, 'the hiring manager can compare candidates');
const ivm = await ivy('GET', '/api/hr/my-jobs');
ok(ivm.jobs.length === 1 && !ivm.jobs[0].is_manager && ivm.applications.length === 0, 'the interviewer sees the job, not the applicants');
r = await ivy('GET', `/api/hr/applications/${appId}`);
ok(r._status === 403, 'the interviewer cannot open the full application');
r = await emma('GET', `/api/hr/applications/${appId}`);
ok(r._status === 403, 'other staff cannot open it');
r = await admin('POST', `/api/hr/applications/${appId}/interviews`, { starts_at: new Date(Date.now() + 86400000).toISOString(), panel: [ivId] });
const iv = r.id;
r = await hal('GET', `/api/hr/interviews/${iv}`);
ok(r._status === 200, 'the hiring manager can open the interview scorecard');

// ---------------------------------------------------------- adding staff
r = await admin('POST', '/api/people/staff', { name: 'Paul No-Email', job_title: 'Yard hand', start_date: '2026-11-02', probation_months: 3 });
ok(r._status === 200 && r.id, 'HR adds a staff member with no email');
let f = await admin('GET', `/api/people/staff/${r.id}`);
ok(/@staff\.local$/.test(f.user.email) && f.profile.status === 'probation' && f.profile.probation_end === '2027-02-02' && f.history[0].kind === 'start', 'placeholder login, HR file on probation, start in the history');
if (PSQL) ok(sql(`SELECT disabled FROM users WHERE id = ${r.id}`) === 't', 'their login is off');
r = await admin('POST', '/api/people/staff', { name: 'Hal Again', email: 'hal.manager.' + stamp + '@example.test' });
ok(r._status === 409, 'an email already on the system is refused');
r = await admin('PUT', `/api/people/staff/${emId}/profile`, { gender: 'female', employee_type: 'regular', mobile: '876-555-0909', job_title: 'Counter clerk', start_date: '2026-06-01' });
f = await admin('GET', `/api/people/staff/${emId}`);
ok(f.profile.gender === 'female' && f.profile.mobile === '876-555-0909', 'new employee fields save');
r = await admin('POST', '/api/people/start-files');
ok(r._status === 200 && r.started >= 0, 'start a file for everyone');

// ------------------------------------------------- contract, signed by link
r = await admin('POST', `/api/people/staff/${emId}/contracts`, { kind: 'employment', job_title: 'Counter clerk', start_date: '2026-06-01', salary_annual: '960,000', probation_months: 3, notice_weeks: 2, vacation_days: 10 });
ok(r._status === 200, 'contract drafted');
const cId = r.id;
const prev = await admin('GET', `/api/people/contracts/${cId}/preview`, null, true);
ok(/J\$960,000\.00 a year/.test(prev.text) && /PAYE income tax, NIS, NHT and Education Tax/.test(prev.text), 'the contract shows J$ pay before the statutory deductions');
r = await admin('POST', `/api/people/staff/${emId}/signatures`, { contract_id: cId, code: true, days: 7 });
ok(r._status === 200 && /sign-staff\.html\?t=/.test(r.link) && /^\d{6}$/.test(r.code), 'sent to sign with a private link and an access code');
const token = r.link.split('t=')[1], code = r.code, sigId = r.id;
const pub = client();
let p = await pub('GET', '/api/public/staff-sign/' + token);
ok(p._status === 200 && p.needs_code && !p.staff_name && p.title, 'the link shows only the title until the code is typed');
p = await pub('GET', '/api/public/staff-sign/' + token + '/content', null, true);
ok(p.status === 401, 'the document does not open without the code');
p = await pub('GET', '/api/public/staff-sign/' + token + '/content?code=000000', null, true);
ok(p.status === 401, 'a wrong code is refused');
p = await pub('GET', '/api/public/staff-sign/' + token + '/content?code=' + code, null, true);
ok(p.status === 200 && /Counter clerk/.test(p.text) && /sandbox/.test(p.headers.get('content-security-policy') || ''), 'with the code the contract opens, locked down');
p = await pub('POST', '/api/public/staff-sign/' + token + '/sign', { name: 'Emma Employee', image: png(), agree: false }, false, { 'X-Access-Code': code });
ok(p._status === 400, 'must tick that they read it');
p = await pub('POST', '/api/public/staff-sign/' + token + '/sign', { name: 'Emma Employee', image: 'data:image/png;base64,AAAA', agree: true }, false, { 'X-Access-Code': code });
ok(p._status === 400, 'an empty signature is refused');
p = await pub('POST', '/api/public/staff-sign/' + token + '/sign', { name: 'Emma Employee', image: png(), agree: true }, false, { 'X-Access-Code': code });
ok(p._status === 200 && p.document && /^DOC-/.test(p.document.number), 'signed from the link; signed copy filed (' + (p.document && p.document.number) + ')');
p = await pub('POST', '/api/public/staff-sign/' + token + '/sign', { name: 'Emma Employee', image: png(), agree: true }, false, { 'X-Access-Code': code });
ok(p._status === 410, 'cannot sign twice');
p = await pub('GET', '/api/public/staff-sign/' + token + '/copy?code=' + code, null, true);
ok(p.status === 200 && /Certificate/.test(p.text) && /Seal/.test(p.text) && /Emma Employee/.test(p.text), 'the employee downloads the signed copy with its certificate');
const cl = await admin('GET', `/api/people/staff/${emId}/contracts`);
ok(cl.contracts[0].status === 'signed' && cl.contracts[0].document_number, 'the contract is marked signed, with the filed copy');
const sl = await admin('GET', `/api/people/staff/${emId}/signatures`);
ok(sl.signatures[0].status === 'signed' && sl.signatures[0].sealed === true && sl.signatures[0].viewed_at, 'HR sees it signed, opened, and the seal checks out');
if (PSQL) {
  sql(`UPDATE hr_signatures SET signer_name = 'Someone Else' WHERE id = ${sigId}`);
  const s2 = await admin('GET', `/api/people/staff/${emId}/signatures`);
  ok(s2.signatures[0].sealed === false, 'changing the record afterwards breaks the seal');
  sql(`UPDATE hr_signatures SET signer_name = 'Emma Employee' WHERE id = ${sigId}`);
  ok(sql(`SELECT confidentiality FROM documents d JOIN hr_signatures s ON s.signed_document_id = d.id WHERE s.id = ${sigId}`) === 'restricted', 'the signed copy is filed as restricted');
}
const docsFor = await admin('GET', `/api/docs/for/staff/${emId}`);
ok((docsFor.documents || []).some((x) => /^Signed: /.test(x.title)), 'the signed copy is in their staff file in the Document centre');

// --------------------------------------- a letter, signed in My HR file
r = await admin('POST', `/api/people/staff/${emId}/cases`, { kind: 'verbal_warning', summary: 'Till short J$500', incident_date: '2026-10-30' });
const caseId = r.id;
r = await admin('POST', `/api/people/staff/${emId}/signatures`, { case_id: caseId });
ok(r._status === 200 && !r.code, 'the warning letter is sent to sign (no code)');
const lettId = r.id, letterToken = r.link.split('t=')[1];
let mine = await emma('GET', '/api/people/me/signatures');
ok(mine.signatures.some((s) => s.id === lettId && s.status === 'sent'), 'it waits in Emma’s My HR file');
r = await hal('GET', `/api/people/me/signatures/${lettId}/content`, null, true);
ok(r.status === 404, 'nobody else can open it from My HR file');
r = await emma('GET', `/api/people/me/signatures/${lettId}/content`, null, true);
ok(r.status === 200 && /Till short/.test(r.text), 'Emma reads the letter (the filed file itself)');
if (PSQL) ok(Number(sql(`SELECT COUNT(*) FROM document_access a JOIN hr_signatures s ON s.source_document_id = a.document_id WHERE s.id = ${lettId} AND a.action = 'view_to_sign'`)) >= 1, 'opening it is logged in the Document centre');
r = await emma('POST', `/api/people/me/signatures/${lettId}/sign`, { name: 'Emma Employee', image: png(), agree: true });
ok(r._status === 200, 'Emma signs it in My HR file');
f = await admin('GET', `/api/people/staff/${emId}`);
ok(f.cases.find((c) => c.id === caseId).acknowledged_at, 'signing the letter marks it received');
r = await pub('GET', '/api/public/staff-sign/' + letterToken);
ok(r._status === 200 && r.status === 'signed', 'the link now shows it signed');
r = await emma('GET', `/api/people/me/signatures/${lettId}/copy`, null, true);
ok(r.status === 200 && /signed in to the staff system/.test(r.text), 'her copy says it was signed in the staff system');

// ------------------------------------------- tampering, decline, resend, withdraw
r = await admin('POST', `/api/people/staff/${emId}/cases`, { kind: 'counselling', summary: 'Uniform', incident_date: '2026-10-31' });
r = await admin('POST', `/api/people/staff/${emId}/signatures`, { case_id: r.id });
const tamperId = r.id;
if (PSQL) {
  sql(`UPDATE hr_signatures SET content_sha256 = 'x' || content_sha256 WHERE id = ${tamperId}`);
  r = await emma('POST', `/api/people/me/signatures/${tamperId}/sign`, { name: 'Emma Employee', image: png(), agree: true });
  ok(r._status === 409, 'a document changed after sending cannot be signed');
}
r = await emma('POST', `/api/people/me/signatures/${tamperId}/decline`, { reason: '' });
ok(r._status === 400, 'declining needs a reason');
r = await emma('POST', `/api/people/me/signatures/${tamperId}/decline`, { reason: 'I was not told about it' });
ok(r._status === 200, 'Emma declines, with the reason');
r = await admin('POST', `/api/people/staff/${emId}/contracts`, { kind: 'confidentiality', terms: 'Keep customer details private.' });
const c2 = r.id;
r = await admin('POST', `/api/people/staff/${emId}/signatures`, { contract_id: c2, code: true });
const oldTok = r.link.split('t=')[1], s3 = r.id;
for (let i = 0; i < 5; i++) await pub('POST', '/api/public/staff-sign/' + oldTok + '/check', {}, false, { 'X-Access-Code': '111111' });
r = await pub('POST', '/api/public/staff-sign/' + oldTok + '/check', {}, false, { 'X-Access-Code': '111111' });
ok(r._status === 423, 'five wrong codes lock the link');
r = await admin('POST', `/api/people/signatures/${s3}/resend`, {});
ok(r._status === 200 && r.code && r.link.split('t=')[1] !== oldTok, 'HR makes a new link and code');
ok((await pub('GET', '/api/public/staff-sign/' + oldTok))._status === 404, 'the old link stops working');
r = await pub('POST', '/api/public/staff-sign/' + r.link.split('t=')[1] + '/check', {}, false, { 'X-Access-Code': r.code });
ok(r._status === 200 && r.staff_name === 'Emma Employee', 'the new link and code open it');
r = await admin('POST', `/api/people/signatures/${s3}/cancel`);
ok(r._status === 200, 'HR withdraws it');
ok((await admin('GET', `/api/people/staff/${emId}/contracts`)).contracts.find((c) => c.id === c2).status === 'draft', 'the contract goes back to draft');

// ------------------------------------------------- QuickBooks employees
const csv = 'Employee Contact List\r\nOctober 31, 2026\r\n\r\n,Employee,Main Phone,Mobile,Main Email,Address,SS No.,Hire Date,Release Date,Birth Date,Gender,Employee Type\r\n' +
  ',Emma Employee,876-555-1111,876-555-2222,,"5 Hope Road, Kingston",123-456-789,06/01/2026,,03/15/1995,Female,Regular\r\n' +
  ',Quentin Books ' + stamp + ',876-555-3333,,quentin.' + stamp + '@example.test,,987-654-321,01/10/2020,,,Male,Officer\r\n' +
  ',Old Timer ' + stamp + ',,,,,,02/01/2015,03/31/2019,,,\r\n' +
  ',Quentin Books ' + stamp + ',,,,,,,,,,\r\n';
// Emma is already in Payroll, so her TRN from QuickBooks has somewhere to go.
if (PSQL) sql(`INSERT INTO payroll_employees (user_id, name, pay_type, salary_annual) VALUES (${emId}, 'Emma Employee', 'salary', 960000)`);
r = await admin('POST', '/api/people/import/employees', { file: csv, preview: true });
const byName = (n) => r.rows.find((x) => x.name === n && x.status !== 'duplicate');
ok(r._status === 200 && byName('Emma Employee').status === 'changed' && byName('Quentin Books ' + stamp).status === 'new' && r.rows.some((x) => x.status === 'duplicate'), 'preview: Emma changed, Quentin new, a duplicate flagged');
ok(byName('Emma Employee').changes.some((c) => c.field === 'address') && (!PSQL || byName('Emma Employee').changes.some((c) => c.field === 'trn')), 'Emma’s changes include the address and the TRN (to Payroll)');
r = await admin('POST', '/api/people/import/employees', { file: csv, include: r.rows.filter((x) => ['new', 'changed'].includes(x.status)).map((x) => x.i) });
ok(r._status === 200 && r.added === 2 && r.updated === 1 && r.left === 1, 'imported: 2 added (1 already released), 1 updated');
if (PSQL) {
  ok(sql(`SELECT is_archived FROM users WHERE name = 'Old Timer ${stamp}'`) === 't', 'the released employee is archived');
  ok(sql(`SELECT h.employee_type || '|' || h.start_date FROM hr_employees h JOIN users u ON u.id = h.user_id WHERE u.name = 'Quentin Books ${stamp}'`) === 'officer|2020-01-10', 'Quentin: officer, hired 10 Jan 2020');
  ok(sql(`SELECT trn || '|' || is_active FROM payroll_employees p JOIN users u ON u.id = p.user_id WHERE u.name = 'Quentin Books ${stamp}'`) === '987-654-321|false', 'Quentin is in Payroll, switched off, with his TRN');
  ok(sql(`SELECT address || '|' || date_of_birth FROM hr_employees WHERE user_id = ${emId}`) === '5 Hope Road, Kingston|1995-03-15', 'Emma’s address and birth date updated');
}
const iif = '!EMP\tNAME\tADDR1\tSSNO\tPHONE1\tHIREDATE\r\nEMP\tIris Iif ' + stamp + '\t1 Duke St\t111-222-333\t876-555-7777\t05/02/2024\r\n';
r = await admin('POST', '/api/people/import/employees', { file: iif, preview: true });
ok(r.rows.length === 1 && r.rows[0].status === 'new' && r.rows[0].hired === '2024-05-02', 'an IIF employee list is read too');
r = await admin('POST', '/api/people/import/employees', { file: 'just,some,columns\n1,2,3', preview: true });
ok(r._status === 400, 'a file that is not an employee list is refused with a hint');
r = await emma('POST', '/api/people/import/employees', { file: csv, preview: true });
ok(r._status === 403, 'staff without HR rights cannot import');

// ------------------------------------------------- QuickBooks payroll items
const items = 'Payroll Item Listing\r\n\r\n,Payroll Item,Type,Amount\r\n,Salary,Yearly Salary,\r\n,Lunch Allowance ' + stamp + ',Addition,2000\r\n,Staff Loan ' + stamp + ',Deduction,\r\n,NIS Employee,Other Tax,\r\n,Pension Co. ' + stamp + ',Company Contribution,\r\n';
r = await admin('POST', '/api/people/import/payroll-items', { file: items, preview: true });
const it = (n) => r.rows.find((x) => x.label === n);
ok(it('Lunch Allowance ' + stamp).kind === 'earning' && it('Staff Loan ' + stamp).kind === 'deduction' && it('Pension Co. ' + stamp).kind === 'employer' && it('NIS Employee').status === 'skip', 'payroll items: earning, deduction, employer; NIS left to Payroll');
r = await admin('POST', '/api/people/import/payroll-items', { file: items, include: r.rows.filter((x) => x.status === 'new').map((x) => x.i) });
ok(r._status === 200 && r.added >= 3, 'payroll items added (' + r.added + ')');
if (PSQL) ok(sql(`SELECT kind || '|' || paye FROM payroll_items WHERE label = 'Staff Loan ${stamp}'`) === 'deduction|false', 'a deduction is added after tax until someone ticks otherwise');
r = await emma('POST', '/api/people/import/payroll-items', { file: items, preview: true });
ok(r._status === 403, 'payroll items need the pay permission');

console.log(`\n${pass + fails} checks, ${fails} failed`);
process.exit(fails ? 1 : 0);
