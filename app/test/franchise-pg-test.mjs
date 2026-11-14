// The franchise module end to end, against a REAL server and Postgres. Not in
// the offline suite: it needs a throwaway database.
//
//   FR_TEST_URL=http://localhost:3397 FR_TEST_PSQL="psql -h 127.0.0.1 -p 5497 -U postgres -d frtest" node test/franchise-pg-test.mjs
//
// It refuses the live till's ports (3057 / 3058). It signs in as the default
// admin (admin@mortysautoparts.com / password123), so run it only on a
// fresh database where that account still has its first password. The server
// must run with VISION_DEV=1 (signing links are returned, not emailed).
import { execSync } from 'node:child_process';
import zlib from 'node:zlib';

const BASE = process.env.FR_TEST_URL || 'http://localhost:3397';
if (/:(3057|3058)\b/.test(BASE)) { console.log('FAIL refusing to run against the live till port'); process.exit(1); }
const PSQL = process.env.FR_TEST_PSQL;
if (!PSQL) { console.log('FAIL set FR_TEST_PSQL (the waiting period and seal checks need it)'); process.exit(1); }
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
// A real PNG (noise, so it does not compress below the 200-byte floor).
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
const tokenOf = (link) => new URL(link).searchParams.get('s') || new URL(link).searchParams.get('p');

// The server must be on the database this test reads with psql (a till's db-config.json can point a copied
// app at the live database). A marker written only through psql has to come back through the API.
const marker = String(10 + Math.floor(Math.random() * 40));
sql(`INSERT INTO fr_settings (key, value) VALUES ('link_days', '${marker}') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
let r = await admin('POST', '/api/auth/signin', { email: 'admin@mortysautoparts.com', password: 'password123' });
ok(r._status === 200, 'admin signs in');
r = await admin('GET', '/api/franchise/meta');
if (!r.settings || String(r.settings.link_days) !== marker) { console.log('FAIL the server is not on the FR_TEST_PSQL database; stopping before anything is written'); process.exit(1); }
sql(`DELETE FROM fr_settings WHERE key = 'link_days'`);

// --------------------------------------------------------- permissions --
const clerk = await admin('POST', '/api/admin/staff', { email: 'fr.clerk.' + stamp + '@example.test', password: 'Passw0rd!' + stamp, name: 'Fran Clerk', admin_role: 'cashier' });
const clerkC = client();
await clerkC('POST', '/api/auth/signin', { email: 'fr.clerk.' + stamp + '@example.test', password: 'Passw0rd!' + stamp });
r = await clerkC('GET', '/api/franchise/meta');
ok(r._status === 403, 'a cashier without the franchise permission is refused (' + r._status + ')');
r = await anon('GET', '/api/franchise/leads');
ok(r._status === 401 || r._status === 403, 'signed out is refused');
const caps = await admin('GET', '/api/admin/capabilities');
ok((caps.capabilities || []).some((c) => c.key === 'franchise.manage'), 'franchise.manage is a capability');

// ------------------------------------------------------------ templates --
await admin('GET', '/api/docs/meta');            // the Document centre adds its own starters first
let meta = await admin('GET', '/api/franchise/meta');
ok(meta._status === 200 && meta.templates.length === 21, 'meta loads with 21 franchise templates (' + meta.templates.length + ')');
ok(meta.templates_in_docs && meta.templates.every((t) => t.document_id), 'every template is in the Document centre');
const docTpls = await admin('GET', '/api/docs/templates');
ok((docTpls.templates || []).some((t) => t.title === 'Franchise operations manual') && (docTpls.templates || []).some((t) => t.title === 'Leave application form'), 'Document centre has both its own and the franchise templates');
r = await admin('GET', '/api/franchise/templates/manual/preview', null, true);
ok(r.status === 200 && /Franchise operations manual/.test(r.text) && /Starting point only/.test(r.text), 'manual preview renders with the attorney notice');

// ------------------------------------------------------------- settings --
r = await admin('PUT', '/api/franchise/settings', { royalty_pct: 6, marketing_pct: 2, tech_fee: 25000, min_royalty: 50000, wait_days: 14, gct_rate: 15 });
ok(r._status === 200 && r.settings.royalty_pct === 6, 'settings saved');
r = await admin('PUT', '/api/franchise/settings', { royalty_pct: 'abc' });
ok(r._status === 400, 'a bad setting is refused');

// ---------------------------------------------------------- territories --
r = await admin('POST', '/api/franchise/territories', { code: 'man-' + stamp, name: 'Mandeville', description: 'Manchester parish', population: 50000 });
ok(r._status === 200, 'territory added');
const terrId = r.id;
r = await admin('POST', '/api/franchise/territories', { code: 'MAN-' + stamp, name: 'Again' });
ok(r._status === 409, 'duplicate territory code refused');

// --------------------------------------------------------- enquiries --
sql(`INSERT INTO users (email, name, admin_role, is_admin, is_staff) VALUES ('cust.mgr.${stamp}@example.test', 'Customer With A Role', 'manager', false, false)`);
const custMgr = sql(`SELECT id FROM users WHERE email = 'cust.mgr.${stamp}@example.test'`);
r = await anon('POST', '/api/public/franchise-enquiry', { name: 'Web Person ' + stamp, phone: '876-555-0101', area_wanted: 'Ocho Rios', consent: true });
ok(r._status === 200, 'public enquiry accepted');
ok(sql(`SELECT COUNT(*) FROM team_notices WHERE user_id = ${custMgr} AND title LIKE '%Web Person ${stamp}%'`) === '0', 'the enquiry alert skips a customer account that has admin_role manager');
ok(+sql(`SELECT COUNT(*) FROM team_notices n JOIN users u ON u.id = n.user_id WHERE n.title LIKE '%Web Person ${stamp}%' AND NOT (COALESCE(u.is_admin, false) OR COALESCE(u.is_staff, false))`) === 0, 'the enquiry alert reaches staff only');
r = await anon('POST', '/api/public/franchise-enquiry', { name: 'Robot ' + stamp, phone: '876-555-0102', consent: true, website: 'http://spam' });
r = await anon('POST', '/api/public/franchise-enquiry', { name: 'No Consent ' + stamp, phone: '876-555-0103' });
ok(r._status === 400, 'enquiry without consent refused');
let leads = await admin('GET', '/api/franchise/leads?stage=active&q=' + stamp);
ok(leads.leads.some((l) => l.name === 'Web Person ' + stamp && l.source === 'website') && !leads.leads.some((l) => /Robot/.test(l.name)), 'web enquiry listed; the robot (hidden box) was not');
r = await admin('POST', '/api/franchise/leads', { name: 'No Contact' });
ok(r._status === 400, 'lead without phone or email refused');
r = await admin('POST', '/api/franchise/leads', { name: 'Paula Prospect ' + stamp, company: 'Prospect Ltd', email: 'paula.' + stamp + '@example.test', phone: '876-555-0200', capital: '10,000,000', net_worth: 25000000, territory_id: terrId, source: 'expo' });
ok(r._status === 200, 'lead recorded');
const leadId = r.id;

// ---------------------------------------------------------- qualify --
r = await admin('POST', `/api/franchise/leads/${leadId}/qualify`, { checks: { experience: true, timeline: false, interview: false } });
ok(r._status === 200 && r.score === 80 && r.passed, 'qualified: score ' + r.score);
let L = await admin('GET', `/api/franchise/leads/${leadId}`);
ok(L.lead.stage === 'qualified', 'stage qualified');

// --------------------------------------------------------------- NDA --
r = await admin('POST', '/api/franchise/documents', { kind: 'fdd', lead_id: leadId, values: { issue_date: '2026-10-01', investment_low: '9,000,000', investment_high: '14,000,000', franchisor_history: 'Since 2010.' } });
ok(r._status === 409 && /NDA/.test(r.error), 'disclosure document refused before the NDA');
r = await admin('POST', '/api/franchise/documents', { kind: 'nda', lead_id: leadId, values: { years: '3' } });
ok(r._status === 200 && /^FD-/.test(r.number) && r.reviewed === false, 'NDA made ' + r.number);
const ndaId = r.id;
r = await admin('GET', `/api/franchise/documents/${ndaId}/view`, null, true);
ok(/Paula Prospect/.test(r.text) && /Prospect Ltd/.test(r.text) && /Starting point only/.test(r.text), 'NDA filled from the lead, notice kept');
r = await admin('POST', `/api/franchise/documents/${ndaId}/countersign`, { name: 'Boss', image: SIG });
ok(r._status === 409, 'cannot sign for us before they sign');
r = await admin('POST', `/api/franchise/documents/${ndaId}/sign`, { name: 'Paula Prospect', image: 'data:image/png;base64,AAAA' });
ok(r._status === 400, 'a blank signature is refused');
r = await admin('POST', `/api/franchise/documents/${ndaId}/sign`, { name: 'Paula Prospect', image: SIG });
ok(r._status === 200 && r.document && /^DOC-/.test(r.document.number), 'NDA signed in person and filed ' + (r.document && r.document.number));
r = await admin('POST', `/api/franchise/documents/${ndaId}/sign`, { name: 'Paula Prospect', image: SIG });
ok(r._status === 409, 'cannot be signed twice');
r = await admin('POST', `/api/franchise/documents/${ndaId}/countersign`, { name: 'Bea Boss', image: SIG });
ok(r._status === 200, 'NDA signed for the franchisor');
L = await admin('GET', `/api/franchise/leads/${leadId}`);
ok(L.lead.stage === 'nda' && L.lead.nda_signed_at, 'stage NDA signed');
const nda = L.documents.find((d) => d.id === ndaId);
ok(nda.status === 'countersigned' && nda.sealed && nda.counter_sealed && nda.unchanged, 'NDA seals check out');

// ---------------------------------------------- disclosure from a link --
r = await admin('POST', '/api/franchise/documents', { kind: 'fdd', lead_id: leadId, values: { issue_date: '2026-10-01', investment_low: '9,000,000', investment_high: '14,000,000', franchisor_history: 'Since 2010.' } });
ok(r._status === 200, 'disclosure document made');
const fddId = r.id;
r = await admin('POST', '/api/franchise/documents', { kind: 'fdd', lead_id: leadId, values: { issue_date: '2026-10-01' } });
ok(r._status === 400, 'missing required fields refused');
r = await admin('POST', `/api/franchise/documents/${fddId}/send`, { email: 'paula.' + stamp + '@example.test', days: 7 });
ok(r._status === 200 && /franchisee\.html\?s=/.test(r.link), 'signing link made');
const tok = tokenOf(r.link);
r = await anon('GET', '/api/public/franchise-sign/' + tok);
ok(r._status === 200 && /disclosure document/i.test(r.title) && /Item 23/.test(r.html), 'link opens the document');
r = await anon('POST', '/api/public/franchise-sign/' + tok, { name: 'Paula Prospect', image: SIG });
ok(r._status === 400, 'signing without ticking the box refused');
r = await anon('POST', '/api/public/franchise-sign/' + tok, { name: 'Paula Prospect', image: SIG, agree: true });
ok(r._status === 200, 'signed from the link');
r = await anon('POST', '/api/public/franchise-sign/' + tok, { name: 'Paula Prospect', image: SIG, agree: true });
ok(r._status === 410, 'the link works once');
r = await anon('GET', '/api/public/franchise-sign/abcdefghijklmnopqrstuvwxyz');
ok(r._status === 404, 'a made-up link is refused');
L = await admin('GET', `/api/franchise/leads/${leadId}`);
ok(L.lead.stage === 'disclosed' && L.lead.fdd_received_at && L.agreement_from, 'stage disclosure received; agreement date given');

// ------------------------------------------------ application, decision --
r = await admin('POST', `/api/franchise/leads/${leadId}/decide`, { decision: 'approve' });
ok(r._status === 409, 'approval refused before the application');
r = await admin('POST', `/api/franchise/leads/${leadId}/application`, { answers: { capital: '10,000,000', experience: 'Ran a hardware store 8 years', area: 'Mandeville' } });
ok(r._status === 200 && r.stage === 'application', 'application recorded');
r = await admin('POST', `/api/franchise/leads/${leadId}/convert`, {});
ok(r._status === 409, 'convert refused before approval');
r = await admin('POST', `/api/franchise/leads/${leadId}/decide`, { decision: 'approve' });
ok(r._status === 200 && r.stage === 'approved', 'approved');
r = await admin('POST', `/api/franchise/leads/${leadId}/convert`, { legal_name: 'Prospect Ltd', trading_name: 'Morty\'s Auto Parts Mandeville', trn: '123-456-789', address: '1 Main St, Mandeville' });
ok(r._status === 200 && r.franchisee_id, 'franchisee record made');
const frId = r.franchisee_id;
let F = await admin('GET', `/api/franchise/franchisees/${frId}`);
ok(F.franchisee.number === 'FR-' + String(frId).padStart(3, '0') && F.franchisee.customer_id && F.franchisee.status === 'onboarding', 'numbered, onboarding, with a Receivables account');
ok(F.tasks.length === 26, 'opening checklist made (' + F.tasks.length + ' items)');
ok(F.documents.length === 2, 'the lead\'s NDA and disclosure document belong to the franchisee too');
ok(sql(`SELECT status FROM fr_territories WHERE id = ${terrId}`) === 'reserved', 'territory reserved');

// ------------------------------------------- agreement + waiting period --
r = await admin('POST', '/api/franchise/documents', { kind: 'agreement', franchisee_id: frId, values: { opening_deadline: '2027-06-30', guarantor: 'Paula Prospect' } });
ok(r._status === 200, 'agreement made');
const agrId = r.id;
r = await admin('GET', `/api/franchise/documents/${agrId}/view`, null, true);
ok(/J\$2,500,000\.00/.test(r.text) && /6% of net sales/.test(r.text) && /Mandeville/.test(r.text) && /123-456-789/.test(r.text), 'agreement filled with fees, territory and TRN');
r = await admin('POST', `/api/franchise/documents/${agrId}/sign`, { name: 'Paula Prospect', image: SIG });
ok(r._status === 409 && /days after/.test(r.error), 'agreement refused inside the waiting period: ' + r.error);
r = await admin('POST', `/api/franchise/documents/${agrId}/send`, {});
const agrTok = tokenOf(r.link);
r = await anon('GET', '/api/public/franchise-sign/' + agrTok);
ok(r._status === 200 && r.not_yet, 'the signing page says it cannot be signed yet');
sql(`UPDATE fr_leads SET fdd_received_at = NOW() - interval '15 days' WHERE id = ${leadId}`);
r = await anon('POST', '/api/public/franchise-sign/' + agrTok, { name: 'Paula Prospect', image: SIG, agree: true });
ok(r._status === 200, 'agreement signed from the link after the waiting period');
r = await admin('POST', `/api/franchise/documents/${agrId}/countersign`, { name: 'Bea Boss', image: SIG });
ok(r._status === 200 && r.document, 'agreement signed for us and filed');
F = await admin('GET', `/api/franchise/franchisees/${frId}`);
const termEnd = F.franchisee.term_end;
ok(F.franchisee.signed_on && termEnd && +termEnd.slice(0, 4) === +F.franchisee.term_start.slice(0, 4) + 10, 'signed; 10-year term ' + F.franchisee.term_start + ' to ' + termEnd);
ok(sql(`SELECT status FROM fr_territories WHERE id = ${terrId}`) === 'sold', 'territory sold');
ok(sql(`SELECT stage FROM fr_leads WHERE id = ${leadId}`) === 'signed', 'lead stage agreement signed');
let D = await admin('GET', `/api/franchise/documents/${agrId}`);
ok(D.document.sealed && D.document.unchanged, 'agreement seal checks out');
sql(`UPDATE fr_documents SET signer_name = 'Someone Else' WHERE id = ${agrId}`);
D = await admin('GET', `/api/franchise/documents/${agrId}`);
ok(D.document.sealed === false, 'an edited signature shows as a broken seal');
sql(`UPDATE fr_documents SET signer_name = 'Paula Prospect' WHERE id = ${agrId}`);

// manual: issuing it ticks the checklist
r = await admin('POST', '/api/franchise/documents', { kind: 'manual', franchisee_id: frId, values: { edition: '1st edition' } });
const manId = r.id;
await admin('POST', `/api/franchise/documents/${manId}/sign`, { name: 'Paula Prospect', image: SIG });
F = await admin('GET', `/api/franchise/franchisees/${frId}`);
ok(F.tasks.find((k) => /^Operations manual/.test(k.title)).done_at, 'manual acknowledged: checklist item ticked');
r = await admin('POST', '/api/franchise/documents', { kind: 'opening', franchisee_id: frId, values: {} });
r = await admin('POST', `/api/franchise/documents/${r.id}/file`, {});
ok(r._status === 200 && r.document, 'pre-opening checklist filed (not signed)');

// ----------------------------------------------------------------- open --
r = await admin('POST', `/api/franchise/franchisees/${frId}/status`, { status: 'open', opened_on: '2026-05-04' });
ok(r._status === 200, 'shop marked open');
r = await admin('POST', `/api/franchise/franchisees/${frId}/tasks`, { phase: 'launch', title: 'Ribbon cutting', due_on: '2026-05-04' });
r = await admin('PUT', `/api/franchise/tasks/${r.id}`, { done: true });
ok(r._status === 200, 'checklist item added and ticked');

// ---------------------------------------------- reports from their link --
r = await admin('POST', `/api/franchise/franchisees/${frId}/portal-link`, {});
const pTok = tokenOf(r.link);
r = await anon('GET', '/api/public/franchisee/' + pTok);
ok(r._status === 200 && r.franchisee.trading_name === 'Morty\'s Auto Parts Mandeville' && /operations manual/i.test(r.manual || ''), 'franchisee link opens, with the manual');
r = await anon('POST', '/api/public/franchisee/' + pTok + '/report', { period: '2026-09', gross_sales: '3,450,000', refunds: 50000, gct_collected: 400000, transactions: 900 });
ok(r._status === 200 && r.net_sales === 3000000, 'September report: net ' + r.net_sales);
r = await anon('POST', '/api/public/franchisee/' + pTok + '/report', { period: '2099-01', gross_sales: 1 });
ok(r._status === 400, 'a future month is refused');

// --------------------------------------------------------------- billing --
r = await admin('POST', `/api/franchise/franchisees/${frId}/bill`, { period: '2026-07' });
ok(r._status === 409, 'no report, no invoice');
r = await admin('POST', `/api/franchise/franchisees/${frId}/bill`, { period: '2026-09' });
ok(r._status === 200 && r.invoice.total === 304750 && r.invoice.gct === 39750 && r.invoice.due === '2026-10-10', 'September invoiced: ' + (r.invoice && r.invoice.number) + ' J$' + (r.invoice && r.invoice.total));
const invId = r.invoice.id;
ok(sql(`SELECT string_agg(a.system_key || ':' || l.amount::int, ',' ORDER BY l.id) FROM ar_invoice_lines l JOIN gl_accounts a ON a.id = l.account_id WHERE l.invoice_id = ${invId}`) === 'franchise_income:180000,franchise_fund:60000,franchise_income:25000', 'lines: royalty and tech to 4600, brand fund to 2170');
ok(sql(`SELECT customer_id FROM ar_invoices WHERE id = ${invId}`) === String(F.franchisee.customer_id), 'invoice is on their Receivables account');
r = await admin('POST', `/api/franchise/franchisees/${frId}/bill`, { period: '2026-09' });
ok(r._status === 409, 'a month cannot be invoiced twice');
r = await admin('POST', `/api/franchise/franchisees/${frId}/reports`, { period: '2026-09', gross_sales: 1 });
ok(r._status === 409, 'an invoiced month\'s report cannot be changed');
r = await admin('POST', `/api/franchise/franchisees/${frId}/reports`, { period: '2026-08', gross_sales: 100000 });
r = await admin('POST', `/api/franchise/franchisees/${frId}/bill`, { period: '2026-08' });
ok(r._status === 200 && r.lines.find((l) => l.kind === 'royalty').amount === 50000, 'small month: the minimum royalty applies from the 4th month');
r = await admin('POST', `/api/franchise/franchisees/${frId}/charge`, { kind: 'initial' });
ok(r._status === 200 && r.invoice.total === 2875000, 'initial fee invoiced with GCT: ' + r.invoice.total);
r = await admin('POST', `/api/franchise/franchisees/${frId}/charge`, { kind: 'initial' });
ok(r._status === 409, 'initial fee not twice');
let st = await admin('GET', `/api/franchise/franchisees/${frId}/statement`);
ok(st.invoices.length === 3 && Math.abs(st.balance - (304750 + st.invoices.find((i) => i.memo && /August/.test(i.memo)).total + 2875000)) < 0.01, 'statement: 3 invoices, owed ' + st.balance);

// ---------------------------------------------------------------- audits --
const items = (score) => meta.audit_items.map(([section, item]) => ({ section, item, score }));
r = await admin('POST', '/api/franchise/audits', { franchisee_id: frId, kind: 'routine', audit_date: '2026-10-15', items: items(2) });
ok(r._status === 200 && r.score_pct === 100 && r.result === 'pass' && !r.follow_up_on, 'audit passed 100%');
r = await admin('POST', '/api/franchise/audits', { franchisee_id: frId, audit_date: '2026-10-20', items: items(1).map((i, k) => Object.assign(i, { score: k < 20 ? 1 : 2 })) });
ok(r.result === 'fail' && r.follow_up_on === '2026-11-19', 'audit failed (' + r.score_pct + '%), follow-up in 30 days');
r = await admin('POST', '/api/franchise/audits', { franchisee_id: frId, audit_date: '2026-10-25', items: items(0) });
ok(r.fails_12m === 2, 'two fails in 12 months counted');
const audId = r.id;
r = await admin('POST', `/api/franchise/audits/${audId}/close`, { note: 'Re-trained' });
ok(r._status === 200, 'audit actions closed');
r = await admin('POST', '/api/franchise/audits', { franchisee_id: frId, items: items(null) });
ok(r._status === 400, 'an audit with nothing scored is refused');

// ----------------------------------------------------- reporting views --
const perf = await admin('GET', '/api/franchise/performance?months=12');
const pr = (perf.franchisees || []).find((x) => x.id === frId);
ok(pr && pr.net_sales === 3100000 && pr.royalty === 230000 && pr.reports === 2 && pr.last_result === 'fail', 'performance: net ' + (pr && pr.net_sales) + ', royalty ' + (pr && pr.royalty));
const dash = await admin('GET', '/api/franchise/dashboard');
ok(dash._status === 200 && dash.statuses.open >= 1 && dash.owed.owed > 0, 'dashboard loads (owed ' + dash.owed.owed + ')');

// --------------------------------------------- default, renewal, suspend --
r = await admin('POST', `/api/franchise/franchisees/${frId}/actions`, { kind: 'default', details: { breach: 'Late report', remedy: 'Send it' } });
ok(r._status === 400, 'a default without a cure date is refused');
r = await admin('POST', `/api/franchise/franchisees/${frId}/actions`, { kind: 'default', cure_by: '2026-12-01', details: { breach: 'Failed two audits', remedy: 'Pass the re-audit', clause: '13' } });
ok(r._status === 200, 'notice of default opened');
const defId = r.id;
r = await admin('POST', `/api/franchise/franchisees/${frId}/actions`, { kind: 'default', cure_by: '2026-12-01', details: { breach: 'x', remedy: 'y' } });
ok(r._status === 409, 'only one open default at a time');
r = await admin('POST', '/api/franchise/documents', { kind: 'default_notice', franchisee_id: frId, values: { breach: 'Failed two audits', remedy: 'Pass the re-audit', cure_by: '2026-12-01' } });
r = await admin('POST', `/api/franchise/documents/${r.id}/file`, {});
ok(r._status === 200, 'notice of default letter filed');
r = await admin('POST', `/api/franchise/actions/${defId}/close`, { status: 'cured', note: 'Passed' });
ok(r._status === 200, 'default put right');
r = await admin('POST', `/api/franchise/franchisees/${frId}/actions`, { kind: 'renewal', details: { new_term_years: 5 } });
r = await admin('POST', `/api/franchise/actions/${r.id}/close`, { status: 'done' });
F = await admin('GET', `/api/franchise/franchisees/${frId}`);
ok(r._status === 200 && +F.franchisee.term_end.slice(0, 4) === +termEnd.slice(0, 4) + 5 && F.franchisee.term_years === 15, 'renewed: term now ends ' + F.franchisee.term_end);
r = await admin('POST', `/api/franchise/franchisees/${frId}/actions`, { kind: 'suspension', details: { reason: 'Unpaid royalty' } });
F = await admin('GET', `/api/franchise/franchisees/${frId}`);
ok(F.franchisee.status === 'suspended', 'suspended');
await admin('POST', `/api/franchise/actions/${r.id}/close`, { status: 'done' });
F = await admin('GET', `/api/franchise/franchisees/${frId}`);
ok(F.franchisee.status === 'open', 'suspension lifted');

// -------------------------------------------------- transfer, termination --
r = await admin('POST', `/api/franchise/franchisees/${frId}/actions`, { kind: 'transfer', effective_date: '2026-11-15', details: { buyer_name: 'Buyer Co ' + stamp, buyer_email: 'buyer.' + stamp + '@example.test', price: 20000000 } });
ok(r._status === 200, 'transfer opened');
r = await admin('POST', `/api/franchise/actions/${r.id}/close`, { status: 'done' });
ok(r._status === 200 && r.new_franchisee_id, 'transfer completed');
const newId = r.new_franchisee_id;
F = await admin('GET', `/api/franchise/franchisees/${frId}`);
const N = await admin('GET', `/api/franchise/franchisees/${newId}`);
ok(F.franchisee.status === 'transferred' && F.franchisee.transferred_to_id === newId, 'seller marked transferred');
ok(N.franchisee.status === 'open' && N.franchisee.territory_id === terrId && N.franchisee.term_end === F.franchisee.term_end && N.franchisee.customer_id && N.franchisee.customer_id !== F.franchisee.customer_id, 'buyer: open, same territory and term, own account');
r = await admin('POST', `/api/franchise/franchisees/${frId}/actions`, { kind: 'default', cure_by: '2026-12-01', details: { breach: 'x', remedy: 'y' } });
ok(r._status === 409, 'nothing more on a transferred franchise');
r = await anon('GET', '/api/public/franchisee/' + pTok);
ok(r._status === 404, 'the seller\'s franchisee link stops working');
r = await admin('POST', `/api/franchise/franchisees/${newId}/actions`, { kind: 'termination', effective_date: '2026-12-31', details: { reason: 'Mutual agreement' } });
r = await admin('POST', `/api/franchise/actions/${r.id}/close`, { status: 'done' });
const T = await admin('GET', `/api/franchise/franchisees/${newId}`);
ok(T.franchisee.status === 'terminated' && T.franchisee.ended_on === '2026-12-31' && T.tasks.filter((k) => k.phase === 'exit').length === 7, 'terminated, with the after-termination checklist');
ok(sql(`SELECT status FROM fr_territories WHERE id = ${terrId}`) === 'open', 'territory open again');

// ------------------------------------------------------- attorney review --
r = await admin('POST', '/api/franchise/templates/training/review', {});
ok(r._status === 400, 'a review needs the reviewer');
r = await admin('POST', '/api/franchise/templates/training/review', { reviewer: 'Test & Co., Attorneys-at-Law' });
ok(r._status === 200, 'review recorded');
r = await admin('POST', '/api/franchise/documents', { kind: 'training', franchisee_id: newId, values: { start_date: '2026-11-01', trainees: 'Buyer' } });
const trv = await admin('GET', `/api/franchise/documents/${r.id}/view`, null, true);
ok(!/Starting point only/.test(trv.text) && /Initial training plan/.test(trv.text), 'a reviewed template no longer carries the notice');

// ------------------------------------------------- decline, declined link --
r = await admin('POST', '/api/franchise/leads', { name: 'Second ' + stamp, phone: '876-555-0300' });
const l2 = r.id;
r = await admin('POST', '/api/franchise/documents', { kind: 'nda', lead_id: l2, values: { years: '2' } });
r = await admin('POST', `/api/franchise/documents/${r.id}/send`, {});
const t2 = tokenOf(r.link);
r = await anon('POST', '/api/public/franchise-sign/' + t2, { decline: true, reason: 'Not now' });
ok(r._status === 200 && r.declined, 'they can decline to sign');
r = await admin('POST', `/api/franchise/leads/${l2}/decide`, { decision: 'decline' });
ok(r._status === 400, 'a decline needs a reason');
r = await admin('POST', `/api/franchise/leads/${l2}/decide`, { decision: 'decline', reason: 'Not enough capital' });
ok(r._status === 200 && r.stage === 'declined', 'lead declined');
r = await admin('POST', `/api/franchise/leads/${l2}/decide`, { decision: 'reopen' });
ok(r._status === 200 && r.stage === 'enquiry', 'lead reopened');

// ---------------------------------------------------------------- pages --
for (const p of ['/franchise.html', '/franchisee.html']) { const pg = await anon('GET', p, null, true); ok(pg.status === 200 && /<script>/.test(pg.text), p + ' served'); }

console.log('\n' + pass + ' passed, ' + fails + ' failed');
process.exit(fails ? 1 : 0);
