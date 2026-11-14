// People & HR and the hiring pipeline, end to end, against a REAL server and
// Postgres. Not in the offline suite: it needs a throwaway database.
//
//   HR_TEST_URL=http://localhost:3398 HR_TEST_PSQL="psql -h 127.0.0.1 -p 5499 -U postgres -d hrtest" node test/hr-pg-test.mjs
//
// It refuses the live till's ports (3057 / 3058). It signs in as the default
// admin (admin@mortysautoparts.com / password123), so run it only on a
// fresh database where that account still has its first password.
import { execSync } from 'node:child_process';

const BASE = process.env.HR_TEST_URL || 'http://localhost:3398';
if (/:(3057|3058)\b/.test(BASE)) { console.log('FAIL refusing to run against the live till port'); process.exit(1); }
const PSQL = process.env.HR_TEST_PSQL;
let pass = 0, fails = 0;
const ok = (c, m) => { if (c) { pass++; console.log('PASS ' + m); } else { fails++; console.log('FAIL ' + m); } };
const sql = (q) => (PSQL ? execSync(PSQL + ' -tA', { input: q, encoding: 'utf8' }).trim() : '');

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
const admin = client();
const stamp = Date.now().toString(36);

const si = await admin('POST', '/api/auth/signin', { email: 'admin@mortysautoparts.com', password: 'password123' });
ok(si._status === 200, 'admin signs in');

// ---------------------------------------------------------------- setup --
const mk = async (name, role) => admin('POST', '/api/admin/staff', { email: name.toLowerCase().replace(/\W+/g, '.') + '.' + stamp + '@example.test', password: 'Passw0rd!' + stamp, name, admin_role: role });
const boss = await mk('Bea Boss', 'manager'), clerk = await mk('Carl Clerk', 'cashier'), tech = await mk('Tina Tech', 'cashier');
const bossId = (boss.user || boss).id, clerkId = (clerk.user || clerk).id, techId = (tech.user || tech).id;
ok(bossId && clerkId && techId, 'three staff created');
if (PSQL) sql(`INSERT INTO departments (code, name) VALUES ('parts-${stamp}', 'Parts ${stamp}') ON CONFLICT DO NOTHING;`);
const meta = await admin('GET', '/api/people/meta');
const dept = (meta.departments || []).find((d) => d.name === 'Parts ' + stamp) || (meta.departments || [])[0];
ok(meta._status === 200 && Array.isArray(meta.people), 'HR meta loads');

// --------------------------------------------------------------- the file --
let r = await admin('PUT', `/api/people/staff/${clerkId}/profile`, { job_title: 'Parts clerk', department_id: dept && dept.id, manager_user_id: bossId, start_date: '2026-08-01', status: 'probation', probation_months: 3, contract_type: 'permanent', personal_phone: '876-555-0101', parish: 'St Andrew' });
ok(r._status === 200 && r.changed.includes('job_title'), 'profile saved');
let f = await admin('GET', `/api/people/staff/${clerkId}`);
ok(f.profile && f.profile.probation_end === '2026-11-01', 'probation end worked out from the start date (' + (f.profile && f.profile.probation_end) + ')');
r = await admin('PUT', `/api/people/staff/${bossId}/profile`, { manager_user_id: clerkId });
ok(r._status === 400 && /loop/.test(r.error), 'manager loop refused');
r = await admin('PUT', `/api/people/staff/${clerkId}/profile`, { manager_user_id: clerkId });
ok(r._status === 400, 'own manager refused');
r = await admin('POST', `/api/people/staff/${clerkId}/contacts`, { name: 'Mary Clerk', relationship: 'Mother', phone: '876-555-0199', is_primary: true });
ok(r._status === 200 && r.id, 'emergency contact added');
const cid = r.id;
r = await admin('POST', `/api/people/staff/${clerkId}/contacts`, { name: 'No Phone' });
ok(r._status === 400, 'contact without a phone refused');
r = await admin('PUT', `/api/people/staff/${clerkId}/contacts/${cid}`, { name: 'Mary Clerk', relationship: 'Mother', phone: '876-555-0198' });
ok(r._status === 200, 'contact changed');

// Job and pay history
r = await admin('POST', `/api/people/staff/${clerkId}/job`, { kind: 'pay_change', effective_date: '2026-09-01', salary_annual: '1,200,000', apply_payroll: true, reason: 'Good start' });
ok(r._status === 400 && /Payroll/.test(r.error), 'pay change refuses to pass on to Payroll when they are not in it');
r = await admin('POST', `/api/people/staff/${clerkId}/job`, { kind: 'pay_change', effective_date: '2026-09-01', salary_annual: '1,200,000', reason: 'Good start' });
ok(r._status === 200 && !r.payroll_updated, 'pay change recorded (not passed on)');
if (PSQL) sql(`INSERT INTO payroll_employees (user_id, name, pay_type, salary_annual) VALUES (${clerkId}, 'Carl Clerk', 'salary', 1000000);`);
r = await admin('POST', `/api/people/staff/${clerkId}/job`, { kind: 'promotion', effective_date: '2026-10-01', job_title: 'Senior parts clerk', salary_annual: 1500000, apply_payroll: true, reason: 'Promotion' });
ok(r._status === 200 && r.payroll_updated, 'promotion passed on to Payroll');
if (PSQL) ok(sql(`SELECT salary_annual::int || '|' || job_title FROM payroll_employees WHERE user_id = ${clerkId}`) === '1500000|Senior parts clerk', 'Payroll has the new salary and title');
f = await admin('GET', `/api/people/staff/${clerkId}`);
ok(f.profile.job_title === 'Senior parts clerk' && f.history.length === 2, 'the promotion is the current job; two history lines');

// Probation, warnings, reviews, goals
r = await admin('POST', `/api/people/staff/${clerkId}/cases`, { kind: 'written_warning', incident_date: '2026-10-20', summary: 'Late three times in October', action: 'Be on time for every shift', expires_on: '2027-04-20', tell: true });
ok(r._status === 200 && r.document && /^DOC-/.test(r.document.number), 'written warning recorded and the letter filed (' + (r.document && r.document.number) + ')');
const caseId = r.id;
const docsFor = await admin('GET', `/api/docs/for/staff/${clerkId}`);
ok((docsFor.documents || []).some((d) => /Written warning/.test(d.title)), 'the letter is in the staff file in the Document centre');
r = await admin('POST', `/api/people/staff/${clerkId}/reviews`, { kind: 'probation', due_on: '2026-11-01', reviewer_id: bossId });
ok(r._status === 200, 'probation review set up');
const revId = r.id;
r = await admin('PUT', `/api/people/staff/${clerkId}/reviews/${revId}`, { finish: true, ratings: [{ key: 'quality', score: 4 }] });
ok(r._status === 400 && /outcome/.test(r.error), 'a probation review needs an outcome');
r = await admin('PUT', `/api/people/staff/${clerkId}/reviews/${revId}`, { finish: true, outcome: 'confirm', ratings: [{ key: 'quality', score: 4 }, { key: 'customer', score: 5 }], strengths: 'Customers like him' });
ok(r._status === 200 && r.overall === 5, 'probation review finished (overall ' + r.overall + ')');
f = await admin('GET', `/api/people/staff/${clerkId}`);
ok(f.profile.status === 'active' && f.profile.confirmed_on, 'confirmed in post by the review');
r = await admin('POST', `/api/people/staff/${clerkId}/goals`, { title: 'Learn the Toyota catalogue', due_on: '2027-01-31', review_id: revId });
ok(r._status === 200, 'goal set');
r = await admin('PUT', `/api/people/staff/${clerkId}/goals/${r.id}`, { title: 'Learn the Toyota catalogue', status: 'done' });
ok(r._status === 200, 'goal done');

// Leave
r = await admin('POST', `/api/people/staff/${clerkId}/leave-adjustments`, { days: 3, reason: 'Carried over from 2025', kind: 'vacation' });
ok(r._status === 200, 'leave allowance adjusted');
if (PSQL) sql(`INSERT INTO staff_leave (user_id, from_date, to_date, kind) VALUES (${clerkId}, '${new Date().getFullYear()}-03-02', '${new Date().getFullYear()}-03-04', 'vacation');`);
const lv = await admin('GET', '/api/people/leave');
const mine = (lv.staff || []).find((x) => x.id === clerkId);
ok(mine && mine.vacation_entitled === 13 && (!PSQL || mine.vacation_taken === 3) && (!PSQL || mine.vacation_left === 10), 'leave balance: 10 + 3 carried over, 3 taken, 10 left');

// Self-service: Carl sees his file, replies to the letter, signs the review
const carl = client();
await carl('POST', '/api/auth/signin', { email: 'carl.clerk.' + stamp + '@example.test', password: 'Passw0rd!' + stamp });
const mef = await carl('GET', '/api/people/me');
ok(mef._status === 200 && mef.hr === false && mef.cases.length === 1 && !mef.history, 'My HR file: own warnings shown, no audit or pay history');
r = await carl('GET', `/api/people/staff/${clerkId}`);
ok(r._status === 403, 'staff without hr.people cannot open HR files');
r = await carl('POST', `/api/people/me/cases/${caseId}/ack`, { response: 'Bus problems; sorted now' });
ok(r._status === 200, 'employee acknowledges the letter with a reply');
r = await carl('POST', `/api/people/me/reviews/${revId}/ack`, { comments: 'Thank you' });
ok(r._status === 200, 'employee signs off the review');
r = await carl('POST', '/api/people/me/contacts', { name: 'Joe Clerk', relationship: 'Brother', phone: '876-555-0177' });
ok(r._status === 200, 'employee adds their own emergency contact');

// Exit
r = await admin('POST', `/api/people/staff/${techId}/exits`, { kind: 'resignation', last_day: '2026-11-30', reason: 'Moving abroad' });
ok(r._status === 200, 'resignation recorded');
const exitId = r.id;
f = await admin('GET', `/api/people/staff/${techId}`);
ok(f.profile.status === 'notice' && f.tasks.filter((k) => k.kind === 'offboarding').length >= 6, 'on notice, with the offboarding checklist');
for (const k of f.tasks) await admin('PATCH', `/api/people/tasks/${k.id}`, { done: true });
r = await admin('PATCH', `/api/people/exits/${exitId}`, { exit_interview: 'Liked the team', rehire: true, complete: true });
ok(r._status === 200 && r.tasks_left === 0, 'exit completed with every task ticked');

const org = await admin('GET', '/api/people/org');
ok((org.people || []).find((p) => p.id === clerkId).manager_id === bossId, 'org chart: Carl reports to Bea');
const rep = await admin('GET', '/api/people/reports');
ok(rep._status === 200 && rep.headcount >= 3 && Array.isArray(rep.moves) && rep.moves.length === 12, 'HR reports load (headcount ' + rep.headcount + ', turnover ' + rep.turnover_pct + '%)');
const aud = await admin('GET', '/api/people/audit');
ok((aud.log || []).some((x) => /promotion/.test(x.action)) && (aud.log || []).some((x) => /signed off by the employee/.test(x.action)), 'HR audit has the promotion and the sign-off');

// ================================================================= hiring ==
r = await admin('POST', '/api/hr/settings', {});
await admin('PUT', '/api/hr/settings', { require_requisition: true });
r = await admin('POST', '/api/hr/jobs', { title: 'Counter sales ' + stamp, is_open: true });
ok(r._status === 409, 'posting refused without an approved requisition when the rule is on');
r = await admin('POST', '/api/hr/requisitions', { title: 'Counter sales ' + stamp, openings: 1, justification: 'Saturday queues', salary_min: 900000, salary_max: 1100000, hiring_manager_id: bossId, submit: true });
ok(r._status === 200, 'requisition raised and sent for approval');
const reqId = r.id;
r = await carl('POST', `/api/hr/requisitions/${reqId}/decide`, { decision: 'approve' });
ok(r._status === 403, 'a cashier cannot approve a requisition');
r = await admin('POST', `/api/hr/requisitions/${reqId}/decide`, { decision: 'reject' });
ok(r._status === 400, 'turning down needs a reason');
r = await admin('POST', `/api/hr/requisitions/${reqId}/decide`, { decision: 'approve', note: 'Within budget' });
ok(r._status === 200, 'requisition approved');
r = await admin('POST', `/api/hr/requisitions/${reqId}/post`);
ok(r._status === 200 && r.job && r.job.requisition_id === reqId && !r.job.is_open, 'posting made from the requisition (closed)');
const job = r.job;
r = await admin('PUT', `/api/hr/jobs/${job.id}`, Object.assign({}, job, { is_open: true, documents: [{ label: 'Police record', required: true }], scorecard: [{ label: 'Parts knowledge' }, { label: 'Customer service' }, { label: 'Honesty' }] }));
ok(r._status === 200 && r.job.is_open && r.job.scorecard.length === 3, 'posting opened with its own scorecard');
await admin('PUT', '/api/hr/settings', { require_requisition: false });

// Two applicants apply on the public careers page
const pub = client();
const apply = async (name, email) => {
  const fd = new FormData();
  fd.append('name', name); fd.append('email', email); fd.append('phone', '876-555-0' + Math.floor(100 + Math.random() * 899)); fd.append('consent', 'yes');
  const x = await fetch(BASE + '/api/public/jobs/' + job.id + '/apply', { method: 'POST', body: fd });
  return x.json();
};
const a1 = await apply('Andre Applicant', 'andre.' + stamp + '@example.test'), a2 = await apply('Brenda Bright', 'brenda.' + stamp + '@example.test');
ok(a1.ok && a2.ok, 'two people apply');
const list = await admin('GET', '/api/hr/applications?job=' + job.id);
ok(list.stages.includes('shortlist') && list.stages.includes('references'), 'stages include shortlist and references');
const A = list.applications.find((x) => x.name === 'Andre Applicant'), B = list.applications.find((x) => x.name === 'Brenda Bright');

r = await admin('PATCH', `/api/hr/applications/${A.id}`, { screen_result: 'pass', screen_notes: 'Five years at a parts store', stage: 'shortlist' });
ok(r._status === 200, 'Andre screened (pass) and shortlisted');
r = await admin('PATCH', `/api/hr/applications/${B.id}`, { screen_result: 'maybe', stage: 'shortlist' });
ok(r._status === 200, 'Brenda shortlisted');
r = await admin('PATCH', `/api/hr/applications/${B.id}`, { stage: 'rejected' });
ok(r._status === 400, 'rejecting needs a reason');

// Interviews with a panel, on the calendar
const when = new Date(Date.now() + 2 * 86400000); when.setUTCHours(15, 0, 0, 0);
r = await admin('POST', `/api/hr/applications/${A.id}/interviews`, { starts_at: when.toISOString(), minutes: 45, mode: 'in_person', location: 'Back office', panel: [bossId, clerkId] });
ok(r._status === 200, 'interview booked with a panel of two');
const ivA = r.id;
r = await admin('POST', `/api/hr/applications/${B.id}/interviews`, { starts_at: new Date(when.getTime() + 3600000).toISOString(), panel: [bossId, clerkId] });
const ivB = r.id;
if (PSQL) ok(sql(`SELECT COUNT(*) FROM team_event_attendees v JOIN hr_interviews i ON i.event_id = v.event_id WHERE i.id = ${ivA}`) === '3', 'on the staff calendar for the panel and the person booking it');
if (PSQL) ok(Number(sql(`SELECT COUNT(*) FROM team_notices WHERE user_id = ${clerkId} AND kind = 'event'`)) >= 2, 'the panel got calendar notices');
const cal = await carl('GET', `/api/team/events?from=${new Date(Date.now() - 86400000).toISOString()}&to=${new Date(Date.now() + 5 * 86400000).toISOString()}`);
ok((cal.events || []).some((e) => /Interview: Andre/.test(e.title)), 'Carl (panel, no hiring rights) sees the interview on his calendar');

// Carl, on the panel, scores without hr.manage
const my = await carl('GET', '/api/hr/my-interviews');
ok((my.interviews || []).length === 2, 'My interviews lists both for the panel member');
const ivd = await carl('GET', `/api/hr/interviews/${ivA}`);
ok(ivd.criteria && ivd.criteria.length === 3 && !('email' in ivd.candidate), 'the panel sees the job’s scorecard and no contact details');
r = await carl('POST', `/api/hr/interviews/${ivA}/score`, { scores: [{ key: ivd.criteria[0].key, score: 5 }], recommend: 'yes' });
ok(r._status === 400, 'a scorecard with too few scores is refused');
const sc = (vals) => ivd.criteria.map((c, i) => ({ key: c.key, score: vals[i] }));
r = await carl('POST', `/api/hr/interviews/${ivA}/score`, { scores: sc([5, 4, 5]), recommend: 'strong_yes', strengths: 'Knows Honda parts' });
ok(r._status === 200 && r.overall === 5, 'Carl scores Andre');
await admin('POST', `/api/hr/interviews/${ivA}/score`, { scores: sc([4, 4, 4]), recommend: 'yes' });
await admin('POST', `/api/hr/interviews/${ivB}/score`, { scores: sc([3, 2, 3]), recommend: 'no' });
r = await client()('GET', `/api/hr/interviews/${ivA}`);
ok(r._status === 401 || r._status === 404, 'signed-out people cannot read the interview');
r = await admin('PATCH', `/api/hr/interviews/${ivB}`, { starts_at: new Date(when.getTime() + 7200000).toISOString() });
ok(r._status === 200 && r.moved, 'interview moved; panel told');

const cmp = await admin('GET', `/api/hr/jobs/${job.id}/compare`);
ok(cmp.candidates && cmp.candidates[0].id === A.id && cmp.candidates[0].avg_overall === 4.5 && cmp.candidates[0].n_scores === 2, 'comparison ranks Andre first (4.5 from two scorecards)');
r = await admin('POST', `/api/hr/applications/${A.id}/select`, { to: 'references' });
ok(r._status === 400, 'selecting needs a reason');
r = await admin('POST', `/api/hr/applications/${A.id}/select`, { to: 'references', reason: 'Best scores and parts experience' });
ok(r._status === 200, 'Andre selected for reference checks');
r = await admin('PATCH', `/api/hr/applications/${B.id}`, { stage: 'rejected', reason: 'Less experience than the chosen candidate' });
ok(r._status === 200, 'Brenda not taken forward, with the reason');

// References
r = await admin('POST', `/api/hr/applications/${A.id}/references`, { referee_name: 'Paul Former', company: 'Old Parts Ltd', email: 'paul.' + stamp + '@example.test' });
ok(r._status === 200, 'referee added');
const refId = r.id;
const draft = await admin('GET', `/api/hr/references/${refId}/email-draft`);
ok(/Andre Applicant/.test(draft.body), 'reference request drafted');
r = await admin('POST', `/api/hr/references/${refId}/email`, { subject: draft.subject, body: draft.body });
ok(r._status === 200, 'reference request recorded (' + r.note + ')');
r = await admin('PATCH', `/api/hr/references/${refId}`, { status: 'done' });
ok(r._status === 400, 'a finished reference needs what they said');
r = await admin('PATCH', `/api/hr/references/${refId}`, { status: 'done', rating: 'good', summary: 'Honest and on time; would rehire', would_rehire: true });
ok(r._status === 200, 'reference done');

// Offer, approval, sending, acceptance
r = await admin('POST', `/api/hr/applications/${A.id}/offers`, { job_title: 'Counter sales', start_date: '2026-12-01', salary_annual: '' });
ok(r._status === 400, 'an offer needs the pay');
r = await admin('POST', `/api/hr/applications/${A.id}/offers`, { job_title: 'Counter sales', department_id: dept && dept.id, manager_user_id: bossId, start_date: '2026-12-01', salary_annual: '1,000,000', frequency: 'monthly', probation_months: 3, hours: 'Mon to Sat, 8 to 5', submit: true });
ok(r._status === 200, 'offer drafted and sent for approval');
const offerId = r.id;
r = await admin('POST', `/api/hr/offers/${offerId}/send`);
ok(r._status === 409, 'an offer waiting for approval cannot be sent');
r = await admin('POST', `/api/hr/applications/${A.id}/hire`);
ok(r._status === 409 && /not been accepted/.test(r.error), 'cannot hire before the offer is accepted');
r = await carl('POST', `/api/hr/offers/${offerId}/decide`, { decision: 'approve' });
ok(r._status === 403, 'a cashier cannot approve an offer');
r = await admin('POST', `/api/hr/offers/${offerId}/decide`, { decision: 'approve' });
ok(r._status === 200, 'offer approved');
const letter = await admin('GET', `/api/hr/offers/${offerId}/letter`, null, true);
ok(letter.status === 200 && /J\$1,000,000\.00 a year/.test(letter.text), 'offer letter shows the pay in J$');
r = await admin('POST', `/api/hr/offers/${offerId}/send`);
ok(r._status === 200 && /careers\.html\?offer=[0-9a-f]{32}/.test(r.link), 'offer sent with a private link');
const token = r.link.split('offer=')[1];
let po = await pub('GET', '/api/public/offers/' + token);
ok(po._status === 200 && po.status === 'sent' && /Counter sales/.test(po.letter), 'the candidate opens the offer');
r = await pub('POST', '/api/public/offers/' + token + '/respond', { decision: 'accept', name: '' });
ok(r._status === 400, 'accepting needs the typed name');
r = await pub('POST', '/api/public/offers/' + token + '/respond', { decision: 'accept', name: 'Andre Applicant' });
ok(r._status === 200, 'the candidate accepts online');
r = await pub('POST', '/api/public/offers/' + token + '/respond', { decision: 'decline' });
ok(r._status === 409, 'cannot answer twice');
r = await pub('GET', '/api/public/offers/' + '0'.repeat(32));
ok(r._status === 404, 'a made-up offer link is refused');

// Hire: the staff file opens
r = await admin('POST', `/api/hr/applications/${A.id}/hire`);
ok(r._status === 200 && r.user_id && r.payroll_id, 'hired: login, HR file and Payroll (switched off)');
const newId = r.user_id;
f = await admin('GET', `/api/people/staff/${newId}`);
ok(f.profile && f.profile.job_title === 'Counter sales' && f.profile.start_date === '2026-12-01' && f.profile.status === 'probation' && f.profile.probation_end === '2027-03-01' && f.profile.manager_user_id === bossId, 'staff file from the offer: title, start, probation to 2027-03-01, manager');
ok(f.payroll && f.payroll.is_active === false && f.payroll.salary_annual === 1000000, 'in Payroll with the offered salary, switched off');
ok(f.tasks.filter((k) => k.kind === 'onboarding').length >= 10 && f.history[0].kind === 'start', 'onboarding checklist and the start in the job history');
const sd = await admin('GET', `/api/docs/for/staff/${newId}`);
ok((sd.documents || []).some((d) => /Offer accepted/.test(d.title)), 'the accepted offer is in their staff file in the Document centre');
const reqs = await admin('GET', '/api/hr/requisitions');
ok(reqs.requisitions.find((x) => x.id === reqId).status === 'filled', 'requisition marked filled');
const det = await admin('GET', `/api/hr/applications/${A.id}`);
const acts = (det.decisions || []).map((x) => x.action).join(' | ');
ok(['screened: pass', 'interview booked', 'scorecard in', 'selected for reference checks', 'reference done', 'offer approved', 'offer sent', 'offer accepted', 'hired'].every((s) => acts.includes(s)), 'every decision is in the audit');
const ha = await admin('GET', '/api/hr/audit');
ok((ha.log || []).some((x) => x.action === 'requisition approved'), 'the hiring audit has the requisition approval');

console.log(`\n${pass + fails} checks, ${fails} failed`);
process.exit(fails ? 1 : 0);
