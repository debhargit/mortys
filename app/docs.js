// =============================================================================
//  docs.js -- Document and communication centre
//
//  Documents: one library for every paper the business keeps -- templates and
//  forms (leave, warnings, offers...), SOPs and manuals, government and tax
//  papers, IDs, resumes, staff files, security clearances, supplier bills,
//  customer uploads, company and asset documents, product images. Each has a
//  number (DOC-000123), category, folder, tags, confidentiality level, dates
//  (issued / expires / keep until), legal hold, versions, and links to the
//  records it belongs to (supplier, bill, staff member, customer, product,
//  asset, applicant...). Found by full-text search (contents of text, Word,
//  Excel and PowerPoint files are indexed), by folder, category, tag, date,
//  person or record, by number, by expiry, or by checksum (duplicates).
//
//  Files are kept in data/documents, outside the website folder, and only
//  ever streamed through /api/docs/:id/file after a permission check. Every
//  open, download and change is written to document_access.
//
//  Communications: every email and SMS the system sends is captured where it
//  leaves (mailer.sendEmail / sms.sendSMS are wrapped here), and shown in one
//  journal together with customer portal chat, AI / WhatsApp / phone
//  conversations and web inquiries. Calls, letters and visits can be logged
//  by hand. Business channels only: this records what goes through the
//  business system, not anyone's personal phone or mailbox.
// =============================================================================
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');                    // the install folder
const STORE = path.join(ROOT, 'data', 'documents');
const INCOMING = path.join(STORE, '_incoming');
const THUMBS = path.join(STORE, '_thumbs');

// What may be uploaded. No HTML, SVG or scripts: they could run in a browser.
const ALLOWED = /\.(pdf|png|jpe?g|webp|gif|heic|heif|tiff?|bmp|docx?|xlsx?|xlsm|csv|txt|md|rtf|odt|ods|odp|pptx?|eml|msg|zip)$/i;
const INLINE = /^(application\/pdf|image\/(png|jpe?g|webp|gif|bmp))$/i;
const MIME = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp',
  heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
  csv: 'text/csv', txt: 'text/plain', md: 'text/plain', rtf: 'application/rtf', odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet', odp: 'application/vnd.oasis.opendocument.presentation',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  eml: 'message/rfc822', msg: 'application/vnd.ms-outlook', zip: 'application/zip', html: 'text/html' };

// Categories: label, default confidentiality, years to keep (null = no rule).
// Jamaican tax and business records: keep at least 6 years (7 to be safe).
const CATEGORIES = {
  template:           { label: 'Templates & blank forms', conf: 'internal', keep: null, folder: 'Templates & forms' },
  form:               { label: 'Completed forms (leave, requests...)', conf: 'confidential', keep: 7, folder: 'Completed forms' },
  sop:                { label: 'Policies, SOPs & manuals', conf: 'internal', keep: null, folder: 'Policies, SOPs & manuals' },
  company:            { label: 'Company documents', conf: 'confidential', keep: null, folder: 'Company' },
  government:         { label: 'Government & compliance', conf: 'confidential', keep: 7, folder: 'Government & compliance' },
  tax:                { label: 'Tax (TAJ, GCT, PAYE, S01/S02)', conf: 'confidential', keep: 7, folder: 'Tax' },
  id:                 { label: 'IDs (licence, passport, TRN, NIS)', conf: 'restricted', keep: null, folder: 'Staff files' },
  resume:             { label: 'Resumes & applications', conf: 'confidential', keep: 1, folder: 'Recruitment' },
  staff:              { label: 'Staff file (contracts, appraisals, discipline)', conf: 'restricted', keep: 7, folder: 'Staff files' },
  security_clearance: { label: 'Security clearance / police record', conf: 'restricted', keep: 7, folder: 'Staff files' },
  payables:           { label: 'Supplier bills & payables', conf: 'internal', keep: 7, folder: 'Payables' },
  receivables:        { label: 'Customer invoices & statements', conf: 'internal', keep: 7, folder: 'Customers' },
  customer_upload:    { label: 'Customer uploads', conf: 'internal', keep: 2, folder: 'Customers' },
  contract:           { label: 'Contracts & agreements', conf: 'confidential', keep: 7, folder: 'Legal & contracts' },
  legal:              { label: 'Legal', conf: 'restricted', keep: null, folder: 'Legal & contracts' },
  insurance:          { label: 'Insurance', conf: 'confidential', keep: 7, folder: 'Insurance' },
  banking:            { label: 'Banking & finance', conf: 'confidential', keep: 7, folder: 'Banking & finance' },
  asset:              { label: 'Asset documents (warranty, manual, receipt)', conf: 'internal', keep: null, folder: 'Assets & equipment' },
  vehicle:            { label: 'Vehicle documents (registration, fitness)', conf: 'internal', keep: null, folder: 'Assets & equipment' },
  product_image:      { label: 'Product images', conf: 'public', keep: null, folder: 'Product images' },
  health_safety:      { label: 'Health & safety, incidents', conf: 'internal', keep: 7, folder: 'Health & safety' },
  correspondence:     { label: 'Letters & correspondence', conf: 'internal', keep: 7, folder: 'Correspondence' },
  general:            { label: 'General', conf: 'internal', keep: null, folder: 'General' },
};
const FOLDERS = ['Templates & forms', 'Completed forms', 'Policies, SOPs & manuals', 'Company', 'Government & compliance', 'Tax',
  'Staff files', 'Recruitment', 'Payables', 'Customers', 'Legal & contracts', 'Insurance', 'Banking & finance', 'Assets & equipment',
  'Product images', 'Health & safety', 'Correspondence', 'General'];
const CONF = ['public', 'internal', 'confidential', 'restricted'];

// Records a document can belong to, and how to find / name them.
const ENTITIES = {
  supplier:  { label: 'Supplier', search: `SELECT id::text AS id, name AS label FROM suppliers WHERE name ILIKE $1 ORDER BY name LIMIT 20`, one: `SELECT name AS label FROM suppliers WHERE id = $1::int` },
  bill:      { label: 'Supplier bill', search: `SELECT b.id::text AS id, COALESCE(b.number, 'Bill ' || b.id) || ' - ' || s.name || ' (' || to_char(b.bill_date, 'DD Mon YYYY') || ')' AS label FROM ap_bills b JOIN suppliers s ON s.id = b.supplier_id WHERE b.number ILIKE $1 OR s.name ILIKE $1 ORDER BY b.bill_date DESC LIMIT 20`, one: `SELECT COALESCE(b.number, 'Bill ' || b.id) || ' - ' || s.name AS label FROM ap_bills b JOIN suppliers s ON s.id = b.supplier_id WHERE b.id = $1::int` },
  invoice:   { label: 'Customer invoice', search: `SELECT i.id::text AS id, i.number || ' - ' || COALESCE(NULLIF(u.name, ''), u.email) || ' (' || to_char(i.invoice_date, 'DD Mon YYYY') || ')' AS label FROM ar_invoices i JOIN users u ON u.id = i.customer_id WHERE i.number ILIKE $1 OR u.name ILIKE $1 ORDER BY i.invoice_date DESC LIMIT 20`, one: `SELECT i.number || ' - ' || COALESCE(NULLIF(u.name, ''), u.email) AS label FROM ar_invoices i JOIN users u ON u.id = i.customer_id WHERE i.id = $1::int` },
  po:        { label: 'Purchase order', search: `SELECT id::text AS id, 'PO ' || id AS label FROM purchase_orders WHERE id::text ILIKE $1 ORDER BY id DESC LIMIT 20`, one: `SELECT 'PO ' || id AS label FROM purchase_orders WHERE id = $1::int` },
  staff:     { label: 'Staff member', search: `SELECT id::text AS id, COALESCE(name, email) AS label FROM users WHERE (is_staff OR is_admin) AND (name ILIKE $1 OR email ILIKE $1) ORDER BY name LIMIT 20`, one: `SELECT COALESCE(name, email) AS label FROM users WHERE id = $1::int` },
  employee:  { label: 'Payroll employee', search: `SELECT id::text AS id, name || COALESCE(' (' || employee_no || ')', '') AS label FROM payroll_employees WHERE name ILIKE $1 OR employee_no ILIKE $1 ORDER BY name LIMIT 20`, one: `SELECT name AS label FROM payroll_employees WHERE id = $1::int` },
  customer:  { label: 'Customer', search: `SELECT id::text AS id, COALESCE(name, email) || COALESCE(' - ' || phone, '') AS label FROM users WHERE NOT COALESCE(is_staff, false) AND NOT COALESCE(is_admin, false) AND (name ILIKE $1 OR email ILIKE $1 OR phone ILIKE $1) ORDER BY name LIMIT 20`, one: `SELECT COALESCE(name, email) AS label FROM users WHERE id = $1::int` },
  product:   { label: 'Inventory item', search: `SELECT img AS id, name || ' - ' || COALESCE(make_model, '') || COALESCE(' [' || sku || ']', '') AS label FROM products WHERE name ILIKE $1 OR sku ILIKE $1 OR img ILIKE $1 ORDER BY name LIMIT 20`, one: `SELECT name || ' - ' || COALESCE(make_model, '') AS label FROM products WHERE img = $1` },
  asset:     { label: 'Asset / equipment', search: `SELECT id::text AS id, COALESCE(tag || ' ', '') || name AS label FROM sys_assets WHERE name ILIKE $1 OR tag ILIKE $1 OR serial ILIKE $1 ORDER BY tag LIMIT 20`, one: `SELECT COALESCE(tag || ' ', '') || name AS label FROM sys_assets WHERE id = $1::int` },
  applicant: { label: 'Job applicant', search: `SELECT id::text AS id, COALESCE(name, 'Applicant ' || id) AS label FROM job_applications WHERE anonymised_at IS NULL AND (name ILIKE $1 OR email ILIKE $1) ORDER BY id DESC LIMIT 20`, one: `SELECT COALESCE(name, 'Applicant ' || id) AS label FROM job_applications WHERE id = $1::int` },
  inquiry:   { label: 'Parts inquiry', search: `SELECT id::text AS id, '#' || id || ' ' || name || ' - ' || left(part_description, 40) AS label FROM parts_inquiries WHERE name ILIKE $1 OR part_description ILIKE $1 ORDER BY id DESC LIMIT 20`, one: `SELECT '#' || id || ' ' || name AS label FROM parts_inquiries WHERE id = $1::int` },
  order:     { label: 'Web order', search: `SELECT id::text AS id, 'Order #' || id AS label FROM orders WHERE id::text ILIKE $1 ORDER BY id DESC LIMIT 20`, one: `SELECT 'Order #' || id AS label FROM orders WHERE id = $1::int` },
  incident:  { label: 'Security incident', search: `SELECT id::text AS id, number || ' ' || title AS label FROM sys_incidents WHERE number ILIKE $1 OR title ILIKE $1 ORDER BY id DESC LIMIT 20`, one: `SELECT number || ' ' || title AS label FROM sys_incidents WHERE id = $1::int` },
  ticket:    { label: 'IT ticket', search: `SELECT id::text AS id, number || ' ' || title AS label FROM sys_tickets WHERE number ILIKE $1 OR title ILIKE $1 ORDER BY id DESC LIMIT 20`, one: `SELECT number || ' ' || title AS label FROM sys_tickets WHERE id = $1::int` },
  risk:      { label: 'Risk', search: `SELECT id::text AS id, number || ' ' || title AS label FROM sys_risks WHERE number ILIKE $1 OR title ILIKE $1 ORDER BY id DESC LIMIT 20`, one: `SELECT number || ' ' || title AS label FROM sys_risks WHERE id = $1::int` },
};

// Starter templates. {{field}} is filled in; company / today / number / person are automatic.
const TEMPLATES = [
  { title: 'Leave application form', needs_approval: true, fields: [
      { key: 'leave_type', label: 'Type of leave', type: 'select', options: ['Vacation', 'Sick', 'Maternity / paternity', 'Compassionate', 'Study', 'Unpaid', 'Other'], required: true },
      { key: 'start_date', label: 'First day off', type: 'date', required: true },
      { key: 'end_date', label: 'Last day off', type: 'date', required: true },
      { key: 'days', label: 'Working days', type: 'number', required: true },
      { key: 'reason', label: 'Reason / notes', type: 'textarea' },
      { key: 'cover', label: 'Who covers your duties', type: 'text' },
      { key: 'contact', label: 'Contact while away', type: 'text' } ],
    body: '<h1>Leave application</h1><table><tr><th>Employee</th><td>{{person}}</td></tr><tr><th>Type of leave</th><td>{{leave_type}}</td></tr><tr><th>From</th><td>{{start_date}}</td></tr><tr><th>To</th><td>{{end_date}}</td></tr><tr><th>Working days</th><td>{{days}}</td></tr><tr><th>Reason</th><td>{{reason}}</td></tr><tr><th>Cover</th><td>{{cover}}</td></tr><tr><th>Contact while away</th><td>{{contact}}</td></tr></table><p class="sig">Employee signature: ____________________ &nbsp; Date: {{today}}</p><p class="sig">Approved by: ____________________ &nbsp; Date: __________</p>' },
  { title: 'Employment confirmation (job) letter', needs_approval: false, fields: [
      { key: 'addressee', label: 'To (bank, embassy, landlord...)', type: 'text', required: true },
      { key: 'position', label: 'Position', type: 'text', required: true },
      { key: 'start', label: 'Employed since', type: 'date', required: true },
      { key: 'status', label: 'Status', type: 'select', options: ['Permanent, full time', 'Permanent, part time', 'Contract', 'Probation'] },
      { key: 'salary', label: 'Salary (optional)', type: 'text' },
      { key: 'signatory', label: 'Signed by', type: 'text', required: true } ],
    body: '<p>{{today}}</p><p>{{addressee}}</p><h1>To whom it may concern</h1><p>This is to confirm that <b>{{person}}</b> has been employed by {{company}} since {{start}} as <b>{{position}}</b> ({{status}}).</p><p>{{salary}}</p><p>Please contact us at {{company_phone}} if you need anything further.</p><p class="sig">Yours faithfully,<br><br>____________________<br>{{signatory}}<br>{{company}}</p>' },
  { title: 'Disciplinary warning letter', needs_approval: true, fields: [
      { key: 'level', label: 'Warning', type: 'select', options: ['Verbal (recorded)', 'First written', 'Final written'], required: true },
      { key: 'incident_date', label: 'Date of incident', type: 'date', required: true },
      { key: 'details', label: 'What happened', type: 'textarea', required: true },
      { key: 'expected', label: 'What must change', type: 'textarea', required: true },
      { key: 'review', label: 'Review date', type: 'date' } ],
    body: '<p>{{today}}</p><h1>{{level}} warning</h1><p>To: <b>{{person}}</b></p><p><b>Incident on {{incident_date}}:</b> {{details}}</p><p><b>What must change:</b> {{expected}}</p><p>This will be reviewed on {{review}}. You may respond in writing, and you may be accompanied at any meeting about this matter.</p><p class="sig">Manager: ____________________ &nbsp; Employee (received): ____________________</p>' },
  { title: 'Equipment issue and return form', needs_approval: false, fields: [
      { key: 'items', label: 'Items issued (tag, description)', type: 'textarea', required: true },
      { key: 'issued_on', label: 'Issued on', type: 'date', required: true },
      { key: 'condition', label: 'Condition when issued', type: 'text' },
      { key: 'returned_on', label: 'Returned on', type: 'date' } ],
    body: '<h1>Equipment issue / return</h1><p>Issued to: <b>{{person}}</b> on {{issued_on}}</p><p><b>Items:</b><br>{{items}}</p><p>Condition: {{condition}}</p><p>Returned on: {{returned_on}}</p><p>I accept responsibility for the items above while they are in my care.</p><p class="sig">Employee: ____________________ &nbsp; Issued by: ____________________</p>' },
  { title: 'Confidentiality agreement (staff)', needs_approval: false, fields: [
      { key: 'position', label: 'Position', type: 'text', required: true } ],
    body: '<h1>Confidentiality agreement</h1><p>I, <b>{{person}}</b>, employed by {{company}} as {{position}}, agree to keep confidential all customer, supplier, pricing, financial, system and staff information I see in my work, during and after my employment; to use system accounts only for my own work and never share my password or PIN; and to return all company property and records when I leave.</p><p>I understand that the business channels (company email, SMS, WhatsApp and phone lines, and the business system) are recorded.</p><p class="sig">Signed: ____________________ &nbsp; Date: {{today}}</p>' },
  { title: 'Standard operating procedure (SOP)', needs_approval: true, fields: [
      { key: 'sop_title', label: 'Procedure', type: 'text', required: true },
      { key: 'purpose', label: 'Purpose', type: 'textarea', required: true },
      { key: 'scope', label: 'Who / when it applies', type: 'textarea' },
      { key: 'steps', label: 'Steps (one per line)', type: 'textarea', required: true },
      { key: 'owner', label: 'Procedure owner', type: 'text' },
      { key: 'review', label: 'Review date', type: 'date' } ],
    body: '<h1>SOP: {{sop_title}}</h1><table><tr><th>Purpose</th><td>{{purpose}}</td></tr><tr><th>Scope</th><td>{{scope}}</td></tr><tr><th>Owner</th><td>{{owner}}</td></tr><tr><th>Next review</th><td>{{review}}</td></tr></table><h2>Steps</h2><div class="steps">{{steps}}</div><p class="sig">Prepared by {{person}}, {{today}}</p>' },
  { title: 'Incident / accident report', needs_approval: false, fields: [
      { key: 'when', label: 'Date and time', type: 'text', required: true },
      { key: 'where', label: 'Where', type: 'text', required: true },
      { key: 'what', label: 'What happened', type: 'textarea', required: true },
      { key: 'injured', label: 'Anyone hurt / property damaged', type: 'textarea' },
      { key: 'witnesses', label: 'Witnesses', type: 'text' },
      { key: 'action', label: 'Action taken', type: 'textarea' } ],
    body: '<h1>Incident / accident report</h1><table><tr><th>Reported by</th><td>{{person}}</td></tr><tr><th>When</th><td>{{when}}</td></tr><tr><th>Where</th><td>{{where}}</td></tr><tr><th>What happened</th><td>{{what}}</td></tr><tr><th>Injury / damage</th><td>{{injured}}</td></tr><tr><th>Witnesses</th><td>{{witnesses}}</td></tr><tr><th>Action taken</th><td>{{action}}</td></tr></table><p class="sig">Signed: ____________________ &nbsp; {{today}}</p>' },
];

function httpError(status, msg) { const e = new Error(msg); e.status = status; return e; }
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n = (v) => { const x = parseInt(v, 10); return Number.isFinite(x) ? x : null; };
const dateOrNull = (v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : null);
const tagsOf = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((t) => String(t).trim().toLowerCase().slice(0, 40)).filter(Boolean).slice(0, 20);
const plain = (html) => String(html || '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|tr|h1|h2)>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();

exports.register = function register(app, deps) {
  const { query, requireCap, userCan, mailer, sms, devMode } = deps;
  fs.mkdirSync(INCOMING, { recursive: true });
  fs.mkdirSync(THUMBS, { recursive: true });
  const fail = (res, e) => { if (!e.status) console.error('[docs]', e); res.status(e.status || 500).json({ error: e.status ? e.message : 'Server error' }); };
  const ipOf = (req) => String(req.headers['cf-connecting-ip'] || (req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '').slice(0, 64);
  const me = (req) => (req && req.session && req.session.userId) || null;
  const access = (docId, req, action, detail) =>
    query(`INSERT INTO document_access (document_id, user_id, action, detail, ip) VALUES ($1, $2, $3, $4, $5)`,
      [docId, me(req), action, detail ? String(detail).slice(0, 300) : null, req ? ipOf(req) : null]).catch(() => {});

  // -------------------------------------------------------------- uploads --
  let upload = null;
  try {
    const multer = require('multer');
    upload = multer({
      storage: multer.diskStorage({
        destination: INCOMING,
        filename: (_r, f, cb) => cb(null, crypto.randomBytes(16).toString('hex') + path.extname(f.originalname || '').toLowerCase().slice(0, 6)),
      }),
      limits: { fileSize: 25 * 1024 * 1024, files: 1 },
      fileFilter: (_r, f, cb) => (ALLOWED.test(f.originalname || '') ? cb(null, true)
        : cb(httpError(400, 'That kind of file cannot be filed here (allowed: PDF, pictures, Word, Excel, PowerPoint, text, CSV, email, zip).'))),
    });
  } catch (_) { console.warn('[docs] multer missing: uploads disabled'); }
  const one = (req, res) => new Promise((resolve, reject) => {
    if (!upload) return reject(httpError(503, 'Uploads are not available on this server'));
    upload.single('file')(req, res, (err) => (err ? reject(err.status ? err : httpError(400, err.code === 'LIMIT_FILE_SIZE' ? 'The file must be 25 MB or smaller' : 'Could not read the upload')) : resolve(req.file)));
  });
  function sha256File(p) {
    return new Promise((resolve, reject) => { const h = crypto.createHash('sha256'); fs.createReadStream(p).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject); });
  }
  // Move a file into data/documents/YYYY/MM; returns its path relative to the install folder.
  function file(tmpPath, ext) {
    const d = new Date();
    const dir = path.join(STORE, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'));
    fs.mkdirSync(dir, { recursive: true });
    const name = crypto.randomBytes(16).toString('hex') + ext;
    fs.renameSync(tmpPath, path.join(dir, name));
    return path.relative(ROOT, path.join(dir, name)).replace(/\\/g, '/');
  }
  // Only ever open files inside the places documents may live: data/documents,
  // data/careers-cvs, app/uploads, and product photos at the top of app/.
  function resolveStorage(rel) {
    const abs = path.resolve(ROOT, String(rel || ''));
    const inside = (dir) => abs.startsWith(path.resolve(ROOT, dir) + path.sep);
    const appPhoto = path.dirname(abs) === path.resolve(ROOT, 'app') && /\.(png|jpe?g|webp|gif)$/i.test(abs);
    if (!(inside('data/documents') || inside('data/careers-cvs') || inside('app/uploads') || appPhoto)) throw httpError(404, 'File not found');
    return abs;
  }
  // Text to search by: plain text files directly; Word / Excel / PowerPoint from their XML.
  async function extractText(abs, ext) {
    try {
      ext = String(ext || '').toLowerCase();
      if (/^\.(txt|csv|md|eml)$/.test(ext)) return fs.readFileSync(abs, 'utf8').slice(0, 400000);
      if (/^\.(docx|xlsx|xlsm|pptx|odt|ods|odp)$/.test(ext)) {
        const JSZip = require('jszip');
        const zip = await JSZip.loadAsync(fs.readFileSync(abs));
        const parts = Object.keys(zip.files).filter((k) => /^(word\/document|word\/header\d*|word\/footer\d*|xl\/sharedStrings|ppt\/slides\/slide\d+|content)\.xml$/.test(k));
        let out = '';
        for (const k of parts) out += ' ' + (await zip.files[k].async('string')).replace(/<\/(w:p|a:p|text:p)>/g, '\n').replace(/<[^>]+>/g, ' ');
        return out.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/[ \t]+/g, ' ').slice(0, 400000);
      }
    } catch (_) { /* unreadable: the title and details are still searchable */ }
    return null;
  }

  // ---------------------------------------------------------- permissions --
  async function perms(req) {
    const [view, up, manage, conf, restr, approve, comms] = await Promise.all(
      ['docs.view', 'docs.upload', 'docs.manage', 'docs.confidential', 'docs.restricted', 'docs.approve', 'comms.journal'].map((c) => userCan(req, c)));
    const levels = ['public', 'internal'];
    if (conf) levels.push('confidential');
    if (restr) levels.push('restricted');
    return { view, upload: up, manage, confidential: conf, restricted: restr, approve, comms, levels };
  }
  // Visible = at your level, or it is about you, or you filed it.
  const visible = (levels, uid, first) => ({
    sql: `(d.confidentiality = ANY($${first}::text[]) OR d.owner_id = $${first + 1} OR d.uploaded_by = $${first + 1})`, args: [levels, uid] });
  async function loadDoc(req, id, p) {
    const { rows } = await query(`SELECT d.*, u.name AS uploaded_by_name, o.name AS owner_name, f.name AS folder_name, t.title AS template_title, dc.name AS decided_by_name
      FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by LEFT JOIN users o ON o.id = d.owner_id LEFT JOIN users dc ON dc.id = d.decided_by
      LEFT JOIN doc_folders f ON f.id = d.folder_id LEFT JOIN documents t ON t.id = d.template_id WHERE d.id = $1`, [n(id)]);
    const d = rows[0];
    if (!d) throw httpError(404, 'Document not found');
    const uid = me(req);
    if (!(p.levels.includes(d.confidentiality) || (uid && (d.owner_id === uid || d.uploaded_by === uid)))) throw httpError(403, 'This document is ' + d.confidentiality + '. Ask a manager for access.');
    delete d.search;
    return d;
  }
  async function nextNumber() {
    // A sequence, so a number is never handed out twice, even after a document is deleted.
    const { rows } = await query(`SELECT 'DOC-' || lpad(nextval('doc_number_seq')::text, 6, '0') AS n`);
    return rows[0].n;
  }
  async function folderFor(cat) {
    const name = (CATEGORIES[cat] || CATEGORIES.general).folder;
    const { rows } = await query(`SELECT id FROM doc_folders WHERE parent_id IS NULL AND lower(name) = lower($1)`, [name]);
    return rows[0] ? rows[0].id : null;
  }
  const keepFor = (cat, base) => {
    const y = (CATEGORIES[cat] || {}).keep;
    if (!y) return null;
    const d = base ? new Date(base) : new Date();
    d.setFullYear(d.getFullYear() + y);
    return d.toISOString().slice(0, 10);
  };
  async function labelFor(type, id) {
    const E = ENTITIES[type];
    if (!E) throw httpError(400, 'Unknown record type');
    const { rows } = await query(E.one, [String(id)]).catch(() => ({ rows: [] }));
    if (!rows.length) throw httpError(404, E.label + ' not found');
    return rows[0].label;
  }

  // Create a document (+ version 1, links, access entry). Used by upload, templates and the indexer.
  async function createDoc(req, f) {
    const cat = CATEGORIES[f.category] ? f.category : 'general';
    const conf = CONF.includes(f.confidentiality) ? f.confidentiality : CATEGORIES[cat].conf;
    const folder = n(f.folder_id) || (await folderFor(cat));
    const number = await nextNumber();
    const doc = await (async () => {
      const { rows } = await query(
        `INSERT INTO documents (number, title, description, category, folder_id, tags, confidentiality, status, file_name, mime, size, sha256, storage,
           text_content, template_body, template_fields, needs_approval, template_id, form_data, reference, issuer, issue_date, expiry_date, remind_days,
           keep_until, owner_id, uploaded_by, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28) RETURNING id, number`,
        [number, String(f.title || f.file_name || 'Untitled').slice(0, 200), f.description || null, cat, folder, tagsOf(f.tags), conf,
          f.status || 'active', f.file_name || null, f.mime || null, f.size || null, f.sha256 || null, f.storage || null, f.text_content || null,
          f.template_body || null, f.template_fields ? JSON.stringify(f.template_fields) : null, !!f.needs_approval, f.template_id || null,
          f.form_data ? JSON.stringify(f.form_data) : null, f.reference || null, f.issuer || null, dateOrNull(f.issue_date), dateOrNull(f.expiry_date),
          n(f.remind_days) || 30, dateOrNull(f.keep_until) || keepFor(cat, f.issue_date), n(f.owner_id), f.uploaded_by === undefined ? me(req) : f.uploaded_by, f.source || 'upload']);
      return rows[0];
    })();
    if (f.storage) await query(`INSERT INTO document_versions (document_id, version, file_name, mime, size, sha256, storage, note, uploaded_by) VALUES ($1, 1, $2, $3, $4, $5, $6, 'First version', $7)`,
      [doc.id, f.file_name || null, f.mime || null, f.size || null, f.sha256 || null, f.storage, me(req)]);
    for (const l of f.links || []) {
      try { await query(`INSERT INTO document_links (document_id, entity_type, entity_id, label, created_by) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`, [doc.id, l.type, String(l.id), l.label || (await labelFor(l.type, l.id)), me(req)]); } catch (_) {}
    }
    if (req) await access(doc.id, req, f.source === 'template' ? 'create_form' : f.source === 'import' ? 'import' : 'upload', f.file_name || f.title);
    return doc;
  }

  // ------------------------------------------------- one-time setup / seed --
  // Run on first use, not at start-up: at start-up the schema is still being
  // applied, and inserting into documents then deadlocks with it.
  let seeded = null;
  const ensureSeed = () => seeded || (seeded = (async () => {
    try {
      const { rows } = await query(`SELECT COUNT(*)::int AS c FROM doc_folders`);
      if (!rows[0].c) for (let i = 0; i < FOLDERS.length; i++) {
        const cat = Object.keys(CATEGORIES).find((k) => CATEGORIES[k].folder === FOLDERS[i]) || 'general';
        await query(`INSERT INTO doc_folders (name, category, sort) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [FOLDERS[i], cat, i]);
      }
      const { rows: t } = await query(`SELECT COUNT(*)::int AS c FROM documents WHERE category = 'template'`);
      if (!t[0].c) for (const tp of TEMPLATES) {
        await createDoc(null, { title: tp.title, category: 'template', template_body: tp.body, template_fields: tp.fields, needs_approval: tp.needs_approval,
          text_content: plain(tp.body), source: 'import', uploaded_by: null, description: 'Starter template. A document manager can change it under Templates.' });
      }
    } catch (e) { seeded = null; console.warn('[docs] seed', e.message); }
  })());

  // ------------------------------------------------- communication capture --
  // Wrap the two senders every module uses (they all call mailer.sendEmail /
  // sms.sendSMS through the shared module object, so this sees every message).
  // The call site is read off the stack so the journal says which part of the
  // system sent each one.
  function sourceOf(stack) {
    for (const line of String(stack || '').split('\n').slice(2)) {
      if (/node_modules|node:/.test(line)) continue;
      const m = /[\\/]([a-z0-9_-]+)\.js:\d+/i.exec(line);
      if (m && !/^(docs|mailer|sms)$/i.test(m[1])) return m[1];
    }
    return 'system';
  }
  async function logComm(c) {
    try {
      let cid = c.customer_id || null;
      if (!cid && c.to_addr) {
        const digits = String(c.to_addr).replace(/\D/g, '');
        const { rows } = await query(`SELECT id FROM users WHERE lower(email) = lower($1)
            OR (length($2) >= 7 AND length(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g')) >= 7 AND right(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 7) = right($2, 7))
          ORDER BY COALESCE(is_staff, false), id LIMIT 1`, [String(c.to_addr), digits]);
        if (rows[0]) cid = rows[0].id;
      }
      const { rows } = await query(`INSERT INTO comm_log (channel, direction, to_addr, from_addr, subject, body, status, error, source, entity_type, entity_id, customer_id, staff_id, document_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [c.channel, c.direction || 'out', c.to_addr ? String(c.to_addr).slice(0, 300) : null, c.from_addr || null, c.subject ? String(c.subject).slice(0, 300) : null,
          c.body ? String(c.body).slice(0, 20000) : null, c.status || 'sent', c.error ? String(c.error).slice(0, 500) : null, c.source || null,
          c.entity_type || null, c.entity_id ? String(c.entity_id) : null, cid, c.staff_id || null, c.document_id || null]);
      return rows[0].id;
    } catch (e) { console.warn('[docs] comm log', e.message); return null; }
  }
  if (mailer && typeof mailer.sendEmail === 'function' && !mailer.sendEmail.__journaled) {
    const orig = mailer.sendEmail;
    const wrapped = async function (opts) {
      const o = opts || {}; const src = sourceOf(new Error().stack);
      try {
        const r = await orig.apply(this, arguments);
        await logComm({ channel: 'email', to_addr: o.to, subject: o.subject, body: o.text || plain(o.html), status: r && r.stubbed ? 'stubbed' : 'sent', source: src });
        return r;
      } catch (e) { await logComm({ channel: 'email', to_addr: o.to, subject: o.subject, body: o.text || plain(o.html), status: 'failed', error: e.message, source: src }); throw e; }
    };
    wrapped.__journaled = true;
    mailer.sendEmail = wrapped;
  }
  if (sms && typeof sms.sendSMS === 'function' && !sms.sendSMS.__journaled) {
    const orig = sms.sendSMS;
    const wrapped = async function (opts) {
      const o = opts || {}; const src = sourceOf(new Error().stack);
      try {
        const r = await orig.apply(this, arguments);
        await logComm({ channel: 'sms', to_addr: o.to, body: o.body, status: r && r.stubbed ? 'stubbed' : 'sent', source: src });
        return r;
      } catch (e) { await logComm({ channel: 'sms', to_addr: o.to, body: o.body, status: 'failed', error: e.message, source: src }); throw e; }
    };
    wrapped.__journaled = true;
    sms.sendSMS = wrapped;
  }

  // ----------------------------------------------------------------- meta --
  app.get('/api/docs/meta', requireCap('docs.view'), async (req, res) => {
    try {
      await ensureSeed();
      const p = await perms(req); const v = visible(p.levels, me(req), 1);
      const [folders, cats, stats, tags] = await Promise.all([
        query(`SELECT f.id, f.parent_id, f.name, f.category, (SELECT COUNT(*)::int FROM documents d WHERE d.folder_id = f.id AND d.deleted_at IS NULL AND d.category <> 'template' AND ${v.sql}) AS count
               FROM doc_folders f ORDER BY f.sort, f.name`, v.args),
        query(`SELECT category, COUNT(*)::int AS count FROM documents d WHERE d.deleted_at IS NULL AND ${v.sql} GROUP BY 1`, v.args),
        query(`SELECT COUNT(*) FILTER (WHERE deleted_at IS NULL AND category <> 'template')::int AS total, COALESCE(SUM(size) FILTER (WHERE deleted_at IS NULL), 0)::bigint AS bytes,
                 COUNT(*) FILTER (WHERE deleted_at IS NULL AND expiry_date IS NOT NULL AND expiry_date < CURRENT_DATE AND status <> 'archived')::int AS expired,
                 COUNT(*) FILTER (WHERE deleted_at IS NULL AND expiry_date IS NOT NULL AND expiry_date >= CURRENT_DATE AND expiry_date <= CURRENT_DATE + remind_days AND status <> 'archived')::int AS expiring,
                 COUNT(*) FILTER (WHERE deleted_at IS NULL AND status = 'submitted')::int AS awaiting,
                 COUNT(*) FILTER (WHERE deleted_at IS NOT NULL)::int AS binned,
                 COUNT(*) FILTER (WHERE deleted_at IS NULL AND category = 'template')::int AS templates
               FROM documents d WHERE ${v.sql}`, v.args),
        query(`SELECT t AS tag, COUNT(*)::int AS count FROM documents d, unnest(d.tags) t WHERE d.deleted_at IS NULL AND ${v.sql} GROUP BY 1 ORDER BY 2 DESC LIMIT 40`, v.args),
      ]);
      res.json({ perms: p, me: me(req), categories: Object.keys(CATEGORIES).map((k) => Object.assign({ key: k, count: (cats.rows.find((c) => c.category === k) || {}).count || 0 }, CATEGORIES[k])),
        folders: folders.rows, stats: stats.rows[0], tags: tags.rows, entities: Object.keys(ENTITIES).map((k) => ({ key: k, label: ENTITIES[k].label })), confidentiality: CONF });
    } catch (e) { fail(res, e); }
  });

  // --------------------------------------------------------------- search --
  // q: words (full text, prefix-matched), a DOC- number, or a file checksum.
  app.get('/api/docs/search', requireCap('docs.view'), async (req, res) => {
    try {
      const p = await perms(req); const q = req.query; const uid = me(req);
      const args = [p.levels, uid]; const where = [`(d.confidentiality = ANY($1::text[]) OR d.owner_id = $2 OR d.uploaded_by = $2)`];
      const add = (sql, val) => { args.push(val); where.push(sql.replace(/\$\?/g, '$' + args.length)); };
      if (q.deleted === '1') { if (!p.manage) throw httpError(403, 'Only a document manager can open the recycle bin'); where.push('d.deleted_at IS NOT NULL'); }
      else where.push('d.deleted_at IS NULL');
      if (q.category) add('d.category = $?', String(q.category));
      else if (q.include_templates !== '1') where.push(`d.category <> 'template'`);
      if (q.folder) add('d.folder_id = $?', n(q.folder));
      if (q.tag) add('$? = ANY(d.tags)', String(q.tag).toLowerCase());
      if (q.conf) add('d.confidentiality = $?', String(q.conf));
      if (q.status) add('d.status = $?', String(q.status));
      if (q.uploader) add('d.uploaded_by = $?', n(q.uploader));
      if (q.owner) add('d.owner_id = $?', n(q.owner));
      if (q.mine === '1') add('(d.owner_id = $? OR d.uploaded_by = $?)', uid);
      if (q.from) add('d.created_at >= $?::date', dateOrNull(q.from));
      if (q.to) add(`d.created_at < $?::date + 1`, dateOrNull(q.to));
      if (q.expiring) add(`d.expiry_date IS NOT NULL AND d.expiry_date <= CURRENT_DATE + $?::int AND d.status <> 'archived'`, n(q.expiring) || 30);
      if (q.hold === '1') where.push('d.legal_hold');
      if (q.dupes === '1') where.push(`d.sha256 IS NOT NULL AND EXISTS (SELECT 1 FROM documents x WHERE x.sha256 = d.sha256 AND x.id <> d.id AND x.deleted_at IS NULL)`);
      if (q.entity_type && q.entity_id) { args.push(String(q.entity_type), String(q.entity_id)); where.push(`EXISTS (SELECT 1 FROM document_links l WHERE l.document_id = d.id AND l.entity_type = $${args.length - 1} AND l.entity_id = $${args.length})`); }
      else if (q.entity_type) add(`EXISTS (SELECT 1 FROM document_links l WHERE l.document_id = d.id AND l.entity_type = $?)`, String(q.entity_type));
      let rank = '0', head = 'NULL';
      const text = String(q.q || '').trim();
      if (text) {
        if (/^doc-?\d+$/i.test(text)) add('d.number = $?', 'DOC-' + text.replace(/^doc-?/i, '').padStart(6, '0'));
        else if (/^[0-9a-f]{64}$/i.test(text)) add('d.sha256 = $?', text.toLowerCase());
        else {
          const words = text.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean).slice(0, 8);
          args.push(words.length ? words.map((w) => w + ':*').join(' & ') : 'x', '%' + text + '%');
          const a = args.length - 1, b = args.length;
          where.push(`(d.search @@ to_tsquery('simple', $${a}) OR d.search @@ to_tsquery('english', $${a}) OR d.title ILIKE $${b} OR d.reference ILIKE $${b} OR d.file_name ILIKE $${b}
            OR EXISTS (SELECT 1 FROM document_links l WHERE l.document_id = d.id AND l.label ILIKE $${b}))`);
          rank = `(ts_rank(d.search, to_tsquery('english', $${a})) + ts_rank(d.search, to_tsquery('simple', $${a})))`;
          head = `CASE WHEN d.text_content IS NOT NULL THEN ts_headline('english', left(d.text_content, 20000), to_tsquery('english', $${a}), 'MaxWords=24, MinWords=8, StartSel=[[, StopSel=]]') END`;
        }
      }
      const sorts = { new: 'd.created_at DESC', old: 'd.created_at ASC', title: 'lower(d.title)', expiry: 'd.expiry_date NULLS LAST', size: 'd.size DESC NULLS LAST', number: 'd.number' };
      const sort = sorts[q.sort] || (rank !== '0' ? rank + ' DESC, d.created_at DESC' : 'd.created_at DESC');
      const limit = Math.min(200, n(q.limit) || 50), offset = Math.max(0, n(q.offset) || 0);
      const { rows } = await query(`SELECT d.id, d.number, d.title, d.category, d.folder_id, d.tags, d.confidentiality, d.status, d.version, d.file_name, d.mime, d.size,
          d.reference, d.issuer, d.issue_date, d.expiry_date, d.keep_until, d.legal_hold, d.created_at, d.updated_at, d.deleted_at, d.owner_id, d.sha256,
          u.name AS uploaded_by_name, o.name AS owner_name, ${head} AS snippet,
          (SELECT json_agg(json_build_object('type', l.entity_type, 'id', l.entity_id, 'label', l.label)) FROM document_links l WHERE l.document_id = d.id) AS links,
          COUNT(*) OVER()::int AS total
        FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by LEFT JOIN users o ON o.id = d.owner_id
        WHERE ${where.join(' AND ')} ORDER BY ${sort} LIMIT ${limit} OFFSET ${offset}`, args);
      res.json({ total: rows.length ? rows[0].total : 0, documents: rows });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------------ one doc --
  app.get('/api/docs/:id(\\d+)', requireCap('docs.view'), async (req, res) => {
    try {
      const p = await perms(req);
      const d = await loadDoc(req, req.params.id, p);
      const [v, l, a, c] = await Promise.all([
        query(`SELECT v.id, v.version, v.file_name, v.size, v.sha256, v.note, v.created_at, u.name AS by_name FROM document_versions v LEFT JOIN users u ON u.id = v.uploaded_by WHERE v.document_id = $1 ORDER BY v.version DESC`, [d.id]),
        query(`SELECT id, entity_type, entity_id, label, created_at FROM document_links WHERE document_id = $1 ORDER BY created_at`, [d.id]),
        p.manage ? query(`SELECT a.action, a.detail, a.ip, a.at, u.name FROM document_access a LEFT JOIN users u ON u.id = a.user_id WHERE a.document_id = $1 ORDER BY a.at DESC LIMIT 50`, [d.id]) : { rows: [] },
        query(`SELECT id, channel, direction, to_addr, subject, status, created_at FROM comm_log WHERE document_id = $1 ORDER BY created_at DESC LIMIT 20`, [d.id]),
      ]);
      await access(d.id, req, 'view');
      res.json({ document: d, versions: v.rows, links: l.rows, access: a.rows, comms: c.rows, can_edit: p.manage || d.uploaded_by === me(req), perms: p });
    } catch (e) { fail(res, e); }
  });

  // Stream a file: inline for PDFs and pictures (sandboxed), download for the rest.
  app.get('/api/docs/:id(\\d+)/file', requireCap('docs.view'), async (req, res) => {
    try {
      const p = await perms(req);
      const d = await loadDoc(req, req.params.id, p);
      let row = d;
      if (req.query.v) {
        const { rows } = await query(`SELECT * FROM document_versions WHERE document_id = $1 AND version = $2`, [d.id, n(req.query.v)]);
        if (!rows.length) throw httpError(404, 'No such version');
        row = Object.assign({}, rows[0], { mime: rows[0].mime || d.mime });
      }
      if (!row.storage || /\.html$/i.test(row.storage)) {
        if (d.template_body || d.form_data || /\.html$/i.test(row.storage || '')) return res.redirect('/api/docs/' + d.id + '/render');
        throw httpError(404, 'This document has no file');
      }
      const abs = resolveStorage(row.storage);
      if (!fs.existsSync(abs)) throw httpError(404, 'The file is missing from storage');
      const mime = row.mime || 'application/octet-stream';
      const inline = req.query.dl !== '1' && INLINE.test(mime);
      res.setHeader('Content-Type', inline ? mime : 'application/octet-stream');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Content-Disposition', (inline ? 'inline' : 'attachment') + '; filename="' + String(row.file_name || d.number).replace(/[^\w.\- ()]/g, '_') + '"');
      await access(d.id, req, inline ? 'view_file' : 'download', req.query.v ? 'version ' + req.query.v : null);
      fs.createReadStream(abs).pipe(res);
    } catch (e) { fail(res, e); }
  });

  // Small preview of a picture (made once, kept in data/documents/_thumbs).
  app.get('/api/docs/:id(\\d+)/thumb', requireCap('docs.view'), async (req, res) => {
    try {
      const p = await perms(req);
      const d = await loadDoc(req, req.params.id, p);
      if (!d.storage || !/^image\//.test(d.mime || '')) return res.status(404).end();
      const out = path.join(THUMBS, d.id + '-v' + d.version + '.webp');
      if (!fs.existsSync(out)) {
        const sharp = require('sharp');
        await sharp(resolveStorage(d.storage)).rotate().resize(360, 360, { fit: 'inside' }).webp({ quality: 72 }).toFile(out);
      }
      res.setHeader('Content-Type', 'image/webp'); res.setHeader('Cache-Control', 'private, max-age=3600');
      fs.createReadStream(out).pipe(res);
    } catch (_) { res.status(404).end(); }
  });

  // ---------------------------------------------------------------- upload --
  app.post('/api/docs/upload', requireCap('docs.upload'), async (req, res) => {
    let tmp = null;
    try {
      await ensureSeed();
      const f = await one(req, res); if (!f) throw httpError(400, 'Choose a file to upload');
      tmp = f.path;
      const p = await perms(req); const b = req.body || {};
      const ext = path.extname(f.originalname || '').toLowerCase();
      const cat = CATEGORIES[b.category] ? b.category : 'general';
      const conf = CONF.includes(b.confidentiality) ? b.confidentiality : CATEGORIES[cat].conf;
      const ownerId = n(b.owner_id);
      // You may file at any level for yourself (your own ID, your own form); above your level only a manager may file for others.
      if (!p.levels.includes(conf) && !p.manage && ownerId && ownerId !== me(req)) throw httpError(403, 'You can only file "' + conf + '" documents about yourself');
      let links = [];
      try { links = JSON.parse(b.links || '[]'); } catch (_) {}
      if (b.entity_type && b.entity_id) links.push({ type: b.entity_type, id: b.entity_id });
      for (const l of links) if (!ENTITIES[l.type]) throw httpError(400, 'Unknown record type ' + l.type);
      const sha = await sha256File(f.path);
      const { rows: dup } = await query(`SELECT id, number, title FROM documents WHERE sha256 = $1 AND deleted_at IS NULL LIMIT 1`, [sha]);
      if (dup.length && b.allow_duplicate !== '1') { fs.unlinkSync(f.path); tmp = null; return res.status(409).json({ error: 'This exact file is already filed as ' + dup[0].number + ' "' + dup[0].title + '".', duplicate: dup[0] }); }
      const text = await extractText(f.path, ext);
      const storage = file(f.path, ext); tmp = null;
      const doc = await createDoc(req, { title: String(b.title || '').trim() || path.basename(f.originalname, ext), description: b.description, category: cat, folder_id: n(b.folder_id),
        tags: b.tags, confidentiality: conf, file_name: f.originalname, mime: MIME[ext.slice(1)] || f.mimetype, size: f.size, sha256: sha, storage, text_content: text,
        reference: b.reference, issuer: b.issuer, issue_date: b.issue_date, expiry_date: b.expiry_date, remind_days: b.remind_days, keep_until: b.keep_until,
        owner_id: ownerId, source: b.source === 'scan' ? 'scan' : 'upload', links });
      res.json({ ok: true, id: doc.id, number: doc.number, indexed: !!text });
    } catch (e) { if (tmp) try { fs.unlinkSync(tmp); } catch (_) {} fail(res, e); }
  });

  app.post('/api/docs/:id(\\d+)/version', requireCap('docs.upload'), async (req, res) => {
    let tmp = null;
    try {
      const f = await one(req, res); if (!f) throw httpError(400, 'Choose a file'); tmp = f.path;
      const p = await perms(req);
      const d = await loadDoc(req, req.params.id, p);
      if (!(p.manage || d.uploaded_by === me(req))) throw httpError(403, 'Only whoever filed it, or a document manager, can replace it');
      if (d.legal_hold) throw httpError(409, 'This document is on legal hold and cannot be changed');
      const ext = path.extname(f.originalname || '').toLowerCase();
      const sha = await sha256File(f.path); const text = await extractText(f.path, ext);
      const storage = file(f.path, ext); tmp = null;
      const v = d.version + 1;
      await query(`INSERT INTO document_versions (document_id, version, file_name, mime, size, sha256, storage, note, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [d.id, v, f.originalname, MIME[ext.slice(1)] || f.mimetype, f.size, sha, storage, (req.body && req.body.note) || null, me(req)]);
      await query(`UPDATE documents SET version = $2, file_name = $3, mime = $4, size = $5, sha256 = $6, storage = $7, text_content = COALESCE($8, text_content), updated_at = NOW() WHERE id = $1`,
        [d.id, v, f.originalname, MIME[ext.slice(1)] || f.mimetype, f.size, sha, storage, text]);
      await access(d.id, req, 'new_version', 'v' + v + ' ' + f.originalname);
      res.json({ ok: true, version: v });
    } catch (e) { if (tmp) try { fs.unlinkSync(tmp); } catch (_) {} fail(res, e); }
  });

  // ------------------------------------------------------------- edit --
  app.put('/api/docs/:id(\\d+)', requireCap('docs.upload'), async (req, res) => {
    try {
      const p = await perms(req);
      const d = await loadDoc(req, req.params.id, p);
      if (!(p.manage || d.uploaded_by === me(req))) throw httpError(403, 'Only whoever filed it, or a document manager, can change it');
      if (d.legal_hold && !p.manage) throw httpError(409, 'On legal hold');
      const b = req.body || {}; const sets = []; const vals = [d.id];
      const set = (col, v) => { vals.push(v); sets.push(col + ' = $' + vals.length); };
      if ('title' in b) { if (!String(b.title).trim()) throw httpError(400, 'A title is needed'); set('title', String(b.title).trim().slice(0, 200)); }
      if ('description' in b) set('description', b.description || null);
      if ('category' in b) { if (!CATEGORIES[b.category]) throw httpError(400, 'Unknown category'); set('category', b.category); }
      if ('folder_id' in b) set('folder_id', n(b.folder_id));
      if ('tags' in b) set('tags', tagsOf(b.tags));
      if ('confidentiality' in b) {
        if (!CONF.includes(b.confidentiality)) throw httpError(400, 'Unknown level');
        if (!p.levels.includes(b.confidentiality) && !p.manage) throw httpError(403, 'You cannot set a level above your own');
        set('confidentiality', b.confidentiality);
      }
      for (const k of ['reference', 'issuer']) if (k in b) set(k, b[k] || null);
      for (const k of ['issue_date', 'expiry_date', 'keep_until']) if (k in b) set(k, dateOrNull(b[k]));
      if ('remind_days' in b) set('remind_days', Math.max(0, Math.min(365, n(b.remind_days) || 30)));
      if ('owner_id' in b) set('owner_id', n(b.owner_id));
      if ('status' in b) { if (!['active', 'archived', 'draft'].includes(b.status)) throw httpError(400, 'Use Approve / Reject for forms'); set('status', b.status); }
      if (p.manage && 'template_body' in b) { set('template_body', String(b.template_body || '')); set('text_content', plain(b.template_body)); }
      if (p.manage && 'template_fields' in b) set('template_fields', JSON.stringify(Array.isArray(b.template_fields) ? b.template_fields.filter((f) => f && /^[a-z0-9_]{1,40}$/.test(f.key)) : []));
      if (p.manage && 'needs_approval' in b) set('needs_approval', !!b.needs_approval);
      if (!sets.length) return res.json({ ok: true });
      await query(`UPDATE documents SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1`, vals);
      await access(d.id, req, 'edit', Object.keys(b).join(', '));
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/docs/:id(\\d+)/links', requireCap('docs.upload'), async (req, res) => {
    try {
      const p = await perms(req); const d = await loadDoc(req, req.params.id, p);
      const t = String((req.body || {}).entity_type || ''), id = String((req.body || {}).entity_id || '');
      const label = await labelFor(t, id);
      await query(`INSERT INTO document_links (document_id, entity_type, entity_id, label, created_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [d.id, t, id, label, me(req)]);
      await access(d.id, req, 'link', ENTITIES[t].label + ': ' + label);
      res.json({ ok: true, label });
    } catch (e) { fail(res, e); }
  });
  app.delete('/api/docs/:id(\\d+)/links/:link(\\d+)', requireCap('docs.upload'), async (req, res) => {
    try {
      const p = await perms(req); const d = await loadDoc(req, req.params.id, p);
      const { rows } = await query(`DELETE FROM document_links WHERE id = $1 AND document_id = $2 RETURNING entity_type, label`, [n(req.params.link), d.id]);
      if (rows.length) await access(d.id, req, 'unlink', rows[0].entity_type + ': ' + rows[0].label);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/docs/:id(\\d+)/hold', requireCap('docs.manage'), async (req, res) => {
    try {
      const p = await perms(req); const d = await loadDoc(req, req.params.id, p);
      const on = !!(req.body || {}).on;
      await query(`UPDATE documents SET legal_hold = $2, updated_at = NOW() WHERE id = $1`, [d.id, on]);
      await access(d.id, req, 'hold', on ? 'legal hold on' : 'legal hold off');
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // Recycle bin: delete -> restore, or purge (removes the file) once nothing requires keeping it.
  app.delete('/api/docs/:id(\\d+)', requireCap('docs.upload'), async (req, res) => {
    try {
      const p = await perms(req); const d = await loadDoc(req, req.params.id, p);
      if (!(p.manage || (d.uploaded_by === me(req) && !['approved', 'submitted'].includes(d.status)))) throw httpError(403, 'Only a document manager can delete this');
      if (d.legal_hold) throw httpError(409, 'On legal hold: it cannot be deleted');
      await query(`UPDATE documents SET deleted_at = NOW(), deleted_by = $2 WHERE id = $1`, [d.id, me(req)]);
      await access(d.id, req, 'delete');
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/docs/:id(\\d+)/restore', requireCap('docs.manage'), async (req, res) => {
    try {
      const p = await perms(req); const d = await loadDoc(req, req.params.id, p);
      await query(`UPDATE documents SET deleted_at = NULL, deleted_by = NULL WHERE id = $1`, [d.id]);
      await access(d.id, req, 'restore');
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/docs/:id(\\d+)/purge', requireCap('docs.manage'), async (req, res) => {
    try {
      const p = await perms(req); const d = await loadDoc(req, req.params.id, p);
      if (!d.deleted_at) throw httpError(409, 'Put it in the recycle bin first');
      if (d.legal_hold) throw httpError(409, 'On legal hold');
      if (d.keep_until && new Date(d.keep_until) > new Date()) throw httpError(409, 'This must be kept until ' + new Date(d.keep_until).toISOString().slice(0, 10) + ' (records rule)');
      const { rows: vs } = await query(`SELECT storage FROM document_versions WHERE document_id = $1`, [d.id]);
      // Only files the centre itself stored are removed; CVs, inquiry photos and product photos stay where they were.
      for (const v of vs) { try { const abs = resolveStorage(v.storage); if (abs.startsWith(STORE + path.sep)) fs.unlinkSync(abs); } catch (_) {} }
      await query(`INSERT INTO document_access (document_id, user_id, action, detail, ip) VALUES (NULL, $1, 'purge', $2, $3)`, [me(req), d.number + ' ' + d.title, ipOf(req)]);
      await query(`DELETE FROM documents WHERE id = $1`, [d.id]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ---------------------------------------------------------------- folders --
  app.post('/api/docs/folders', requireCap('docs.manage'), async (req, res) => {
    try {
      const b = req.body || {};
      if (!String(b.name || '').trim()) throw httpError(400, 'A folder name is needed');
      const { rows } = await query(`INSERT INTO doc_folders (parent_id, name, category, sort) VALUES ($1, $2, $3, 100) RETURNING id`, [n(b.parent_id), String(b.name).trim().slice(0, 80), CATEGORIES[b.category] ? b.category : null]);
      res.json({ ok: true, id: rows[0].id });
    } catch (e) { fail(res, e.code === '23505' ? httpError(409, 'That folder already exists') : e); }
  });
  app.put('/api/docs/folders/:id(\\d+)', requireCap('docs.manage'), async (req, res) => {
    try {
      const b = req.body || {};
      if (n(b.parent_id) === n(req.params.id)) throw httpError(400, 'A folder cannot be inside itself');
      await query(`UPDATE doc_folders SET name = COALESCE($2, name), parent_id = CASE WHEN $3::boolean THEN $4 ELSE parent_id END WHERE id = $1`,
        [n(req.params.id), b.name ? String(b.name).trim().slice(0, 80) : null, 'parent_id' in b, n(b.parent_id)]);
      res.json({ ok: true });
    } catch (e) { fail(res, e.code === '23505' ? httpError(409, 'That folder already exists') : e); }
  });
  app.delete('/api/docs/folders/:id(\\d+)', requireCap('docs.manage'), async (req, res) => {
    try {
      const { rows } = await query(`SELECT (SELECT COUNT(*)::int FROM documents WHERE folder_id = $1 AND deleted_at IS NULL) AS docs, (SELECT COUNT(*)::int FROM doc_folders WHERE parent_id = $1) AS subs`, [n(req.params.id)]);
      if (rows[0].docs || rows[0].subs) throw httpError(409, 'Empty it first (' + rows[0].docs + ' documents, ' + rows[0].subs + ' folders inside)');
      await query(`DELETE FROM doc_folders WHERE id = $1`, [n(req.params.id)]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------ templates / forms --
  app.get('/api/docs/templates', requireCap('docs.view'), async (req, res) => {
    try {
      await ensureSeed();
      const { rows } = await query(`SELECT d.id, d.number, d.title, d.description, d.template_body, d.template_fields, d.needs_approval, d.storage IS NOT NULL AS has_file, d.file_name, d.updated_at,
        (SELECT COUNT(*)::int FROM documents f WHERE f.template_id = d.id AND f.deleted_at IS NULL) AS used
        FROM documents d WHERE d.category = 'template' AND d.deleted_at IS NULL ORDER BY lower(d.title)`);
      res.json({ templates: rows });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/docs/templates', requireCap('docs.manage'), async (req, res) => {
    try {
      const b = req.body || {};
      if (!String(b.title || '').trim()) throw httpError(400, 'A title is needed');
      if (!String(b.template_body || '').trim()) throw httpError(400, 'Write the template text');
      const fields = Array.isArray(b.template_fields) ? b.template_fields.filter((f) => f && /^[a-z0-9_]{1,40}$/.test(f.key)) : [];
      const doc = await createDoc(req, { title: b.title, description: b.description, category: 'template', template_body: String(b.template_body), template_fields: fields,
        needs_approval: !!b.needs_approval, text_content: plain(b.template_body), source: 'upload' });
      res.json({ ok: true, id: doc.id, number: doc.number });
    } catch (e) { fail(res, e); }
  });

  async function companyInfo() {
    const { rows } = await query(`SELECT key, value FROM warehouse_settings WHERE key IN ('company_name', 'shop_name', 'company_phone', 'company_address')`).catch(() => ({ rows: [] }));
    const s = {}; rows.forEach((r) => { s[r.key] = r.value; });
    return { company: s.company_name || s.shop_name || 'Vision Auto Solutions Ltd', company_phone: s.company_phone || '876-728-4735', company_address: s.company_address || '112C Waltham Park Road, Kingston' };
  }
  const longDate = () => new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  function renderForm(tpl, values, auto) {
    const all = Object.assign({}, auto, values);
    const body = String(tpl.template_body || '').replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (m, k) => {
      const v = all[k]; if (v == null || v === '') return '<span class="blank">&nbsp;</span>';
      return esc(v).replace(/\n/g, '<br>');
    });
    return '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(tpl.title) + ' ' + esc(auto.number || '') + '</title><style>' +
      'body{font-family:Arial,Helvetica,sans-serif;color:#111;max-width:760px;margin:24px auto;padding:0 24px;line-height:1.5}' +
      '.hd{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid #d61f2b;padding-bottom:8px;margin-bottom:18px}' +
      '.hd b{font-size:18px}.hd small{color:#555}h1{font-size:20px;margin:10px 0}h2{font-size:16px}table{border-collapse:collapse;width:100%;margin:10px 0}' +
      'th,td{border:1px solid #ccc;padding:7px 9px;text-align:left;vertical-align:top}th{background:#f4f4f5;width:32%}.sig{margin-top:34px}.blank{display:inline-block;min-width:140px;border-bottom:1px solid #999}' +
      '.ft{margin-top:30px;border-top:1px solid #ddd;padding-top:6px;color:#777;font-size:11px}@media print{body{margin:0}}' +
      '</style></head><body><div class="hd"><div><b>' + esc(auto.company) + '</b><br><small>' + esc(auto.company_address) + ' · ' + esc(auto.company_phone) + '</small></div><small>' +
      esc(auto.number || '') + '<br>' + esc(auto.today) + '</small></div>' + body + '<div class="ft">' + esc(tpl.title) + ' · ' + esc(auto.number || '') + '</div></body></html>';
  }
  app.post('/api/docs/templates/:id(\\d+)/fill', requireCap('docs.upload'), async (req, res) => {
    try {
      const { rows } = await query(`SELECT * FROM documents WHERE id = $1 AND category = 'template' AND deleted_at IS NULL`, [n(req.params.id)]);
      const tpl = rows[0]; if (!tpl) throw httpError(404, 'Template not found');
      const b = req.body || {}; const values = {};
      for (const f of tpl.template_fields || []) {
        const v = b.values ? b.values[f.key] : undefined;
        if (f.required && (v == null || String(v).trim() === '')) throw httpError(400, '"' + f.label + '" is required');
        values[f.key] = v == null ? '' : String(v).slice(0, 5000);
      }
      const p = await perms(req);
      const ownerId = n(b.owner_id) || me(req);
      if (ownerId !== me(req) && !p.manage) throw httpError(403, 'You can fill forms for yourself; a document manager can fill them for others');
      const { rows: ow } = await query(`SELECT name FROM users WHERE id = $1`, [ownerId]);
      const auto = Object.assign({}, await companyInfo(), { today: longDate(), person: (ow[0] && ow[0].name) || '' });
      const links = Array.isArray(b.links) ? b.links.filter((l) => l && ENTITIES[l.type]) : [];
      const status = tpl.needs_approval ? (b.draft ? 'draft' : 'submitted') : 'active';
      const isSop = /\bsop\b|procedure/i.test(tpl.title);
      // Created first (for its number), then the filled page is written and attached as its file.
      const doc = await createDoc(req, { title: tpl.title.replace(/\s*\(.*\)$/, '') + ' - ' + (values.sop_title || auto.person || 'form'), category: isSop ? 'sop' : 'form',
        confidentiality: CONF.includes(b.confidentiality) ? b.confidentiality : (isSop ? 'internal' : 'confidential'), template_id: tpl.id, form_data: values, owner_id: ownerId,
        status, source: 'template', links, tags: b.tags });
      const html = renderForm(tpl, values, Object.assign(auto, { number: doc.number }));
      const tmp = path.join(INCOMING, crypto.randomBytes(16).toString('hex') + '.html');
      fs.writeFileSync(tmp, html);
      const size = fs.statSync(tmp).size; const sha = await sha256File(tmp);
      const storage = file(tmp, '.html');
      const fname = tpl.title.replace(/[^\w ]+/g, '').trim() + ' ' + doc.number + '.html';
      await query(`UPDATE documents SET file_name = $2, mime = 'text/html', size = $3, sha256 = $4, storage = $5, text_content = $6 WHERE id = $1`, [doc.id, fname, size, sha, storage, plain(html)]);
      await query(`INSERT INTO document_versions (document_id, version, file_name, mime, size, sha256, storage, note, uploaded_by) VALUES ($1, 1, $2, 'text/html', $3, $4, $5, 'Filled from template', $6)`, [doc.id, fname, size, sha, storage, me(req)]);
      if (status === 'submitted') {
        await access(doc.id, req, 'submit');
        const { rows: mgr } = await query(`SELECT email FROM users WHERE admin_role IN ('owner', 'manager') AND NOT COALESCE(disabled, false) AND id <> $1 AND email IS NOT NULL AND email NOT ILIKE '%.local'`, [ownerId]);
        if (!devMode && mailer) for (const m of mgr) mailer.sendEmail({ to: m.email, subject: 'For approval: ' + tpl.title + ' (' + (auto.person || '') + ')', text: (auto.person || 'Someone') + ' submitted ' + tpl.title + ' ' + doc.number + '. Open Documents > Approvals to decide.' }).catch(() => {});
      }
      res.json({ ok: true, id: doc.id, number: doc.number, status });
    } catch (e) { fail(res, e); }
  });
  // Printable page of a filled form, or a preview of a template.
  app.get('/api/docs/:id(\\d+)/render', requireCap('docs.view'), async (req, res) => {
    try {
      const p = await perms(req); const d = await loadDoc(req, req.params.id, p);
      let html;
      if (d.category === 'template') html = renderForm(d, {}, Object.assign(await companyInfo(), { today: longDate(), number: 'PREVIEW', person: '' }));
      else if (d.storage && /\.html$/i.test(d.storage)) html = fs.readFileSync(resolveStorage(d.storage), 'utf8');
      else throw httpError(404, 'Nothing to show');
      if (d.status === 'approved' || d.status === 'rejected') html = html.replace('</body>', '<p style="margin-top:20px;padding:8px 10px;border:2px solid ' + (d.status === 'approved' ? '#16a34a' : '#dc2626') + ';display:inline-block;font-weight:bold">' + d.status.toUpperCase() + ' ' + esc(d.decided_at ? new Date(d.decided_at).toISOString().slice(0, 10) : '') + (d.decided_by_name ? ' by ' + esc(d.decided_by_name) : '') + (d.decision_note ? ' - ' + esc(d.decision_note) : '') + '</p></body>');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:");
      res.setHeader('X-Content-Type-Options', 'nosniff');
      await access(d.id, req, 'view_file', 'printable');
      res.send(html);
    } catch (e) { fail(res, e); }
  });

  // ---------------------------------------------------------------- approvals --
  app.get('/api/docs/approvals', requireCap('docs.approve'), async (req, res) => {
    try {
      const { rows } = await query(`SELECT d.id, d.number, d.title, d.status, d.created_at, d.form_data, d.owner_id, o.name AS owner_name, t.title AS template_title, t.template_fields
        FROM documents d LEFT JOIN users o ON o.id = d.owner_id LEFT JOIN documents t ON t.id = d.template_id
        WHERE d.status = 'submitted' AND d.deleted_at IS NULL ORDER BY d.created_at`);
      res.json({ waiting: rows });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/docs/:id(\\d+)/decide', requireCap('docs.approve'), async (req, res) => {
    try {
      const b = req.body || {};
      const { rows: dd } = await query(`SELECT id, number, title, status, owner_id FROM documents WHERE id = $1 AND deleted_at IS NULL`, [n(req.params.id)]);
      const d = dd[0]; if (!d) throw httpError(404, 'Document not found');
      if (d.status !== 'submitted') throw httpError(409, 'Only submitted forms can be decided');
      if (d.owner_id === me(req)) throw httpError(403, 'Someone else must decide your own request');
      if (!['approve', 'reject'].includes(b.decision)) throw httpError(400, 'Approve or reject');
      if (b.decision === 'reject' && !String(b.note || '').trim()) throw httpError(400, 'Say why it is rejected');
      const status = b.decision === 'approve' ? 'approved' : 'rejected';
      await query(`UPDATE documents SET status = $2, decided_by = $3, decided_at = NOW(), decision_note = $4, updated_at = NOW() WHERE id = $1`, [d.id, status, me(req), b.note || null]);
      await access(d.id, req, b.decision, b.note);
      const { rows: o } = await query(`SELECT email FROM users WHERE id = $1`, [d.owner_id]);
      if (!devMode && mailer && o[0] && o[0].email && !/\.local$/i.test(o[0].email)) mailer.sendEmail({ to: o[0].email, subject: d.title + ': ' + status, text: 'Your ' + d.title + ' (' + d.number + ') was ' + status + (b.note ? ': ' + b.note : '.') }).catch(() => {});
      res.json({ ok: true, status });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------- linked records --
  app.get('/api/docs/entities/:type', requireCap('docs.view'), async (req, res) => {
    try {
      const E = ENTITIES[req.params.type]; if (!E) throw httpError(400, 'Unknown record type');
      const { rows } = await query(E.search, ['%' + String(req.query.q || '').trim() + '%']);
      res.json({ results: rows });
    } catch (e) { fail(res, e); }
  });
  // Everything filed for one record (also used by the attach panel other pages can show).
  app.get('/api/docs/for/:type/:id', requireCap('docs.view'), async (req, res) => {
    try {
      if (!ENTITIES[req.params.type]) throw httpError(400, 'Unknown record type');
      const p = await perms(req); const v = visible(p.levels, me(req), 3);
      const { rows } = await query(`SELECT d.id, d.number, d.title, d.category, d.confidentiality, d.status, d.file_name, d.mime, d.size, d.expiry_date, d.created_at
        FROM document_links l JOIN documents d ON d.id = l.document_id WHERE l.entity_type = $1 AND l.entity_id = $2 AND d.deleted_at IS NULL AND ${v.sql} ORDER BY d.created_at DESC`,
        [req.params.type, String(req.params.id)].concat(v.args));
      let label = null; try { label = await labelFor(req.params.type, req.params.id); } catch (_) {}
      res.json({ label, documents: rows });
    } catch (e) { fail(res, e); }
  });

  // Inventory images: every product with a picture (its own photo file or a filed image).
  app.get('/api/docs/product-images', requireCap('docs.view'), async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      const { rows } = await query(`SELECT p.img, p.name, p.make_model, p.sku, p.stock_count,
          (p.img ~* '\\.(png|jpe?g|webp|gif)$') AS own_photo,
          (SELECT json_agg(json_build_object('id', d.id, 'number', d.number, 'title', d.title, 'mime', d.mime) ORDER BY d.created_at DESC) FROM document_links l JOIN documents d ON d.id = l.document_id
             WHERE l.entity_type = 'product' AND l.entity_id = p.img AND d.deleted_at IS NULL) AS docs
        FROM products p
        WHERE (p.img ~* '\\.(png|jpe?g|webp|gif)$' OR EXISTS (SELECT 1 FROM document_links l WHERE l.entity_type = 'product' AND l.entity_id = p.img))
          AND ($1 = '' OR p.name ILIKE '%' || $1 || '%' OR p.sku ILIKE '%' || $1 || '%' OR p.make_model ILIKE '%' || $1 || '%')
        ORDER BY p.name LIMIT 300`, [q]);
      res.json({ products: rows });
    } catch (e) { fail(res, e); }
  });

  // Asset register with its documents: IT equipment plus vehicles, tools, furniture, machinery...
  app.get('/api/docs/assets', requireCap('docs.view'), async (req, res) => {
    try {
      const { rows } = await query(`SELECT a.id, a.tag, a.name, a.kind, a.make, a.model, a.serial, a.location, a.status, a.purchase_date, a.cost, a.supplier, a.warranty_until,
          u.name AS assigned_name,
          (SELECT COUNT(*)::int FROM document_links l JOIN documents d ON d.id = l.document_id WHERE l.entity_type = 'asset' AND l.entity_id = a.id::text AND d.deleted_at IS NULL) AS docs,
          (SELECT MIN(d.expiry_date) FROM document_links l JOIN documents d ON d.id = l.document_id WHERE l.entity_type = 'asset' AND l.entity_id = a.id::text AND d.deleted_at IS NULL AND d.expiry_date >= CURRENT_DATE) AS next_expiry
        FROM sys_assets a LEFT JOIN users u ON u.id = a.assigned_to ORDER BY a.status = 'retired', a.tag NULLS LAST, a.name`);
      const live = rows.filter((r) => r.status !== 'retired');
      res.json({ assets: rows, totals: { count: live.length, cost: live.reduce((s, r) => s + Number(r.cost || 0), 0), undocumented: live.filter((r) => !r.docs).length } });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/docs/assets', requireCap('docs.manage'), async (req, res) => {
    try {
      const b = req.body || {};
      if (!String(b.name || '').trim()) throw httpError(400, 'Name the asset');
      const kind = String(b.kind || 'other').toLowerCase().replace(/[^a-z_]/g, '').slice(0, 30) || 'other';
      const pre = { vehicle: 'VEH', furniture: 'FUR', tool: 'TL', machinery: 'MC', building: 'BLD', equipment: 'EQ' }[kind] || 'AS';
      const { rows: t } = await query(`SELECT $1::text || '-' || lpad((COUNT(*) + 1)::text, 4, '0') AS tag FROM sys_assets WHERE tag LIKE $1::text || '-%'`, [pre]);
      const { rows } = await query(`INSERT INTO sys_assets (tag, name, kind, make, model, serial, location, purchase_date, cost, supplier, warranty_until, notes)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id, tag`,
        [String(b.tag || '').trim() || t[0].tag, String(b.name).trim().slice(0, 120), kind, b.make || null, b.model || null, b.serial || null, b.location || null, dateOrNull(b.purchase_date),
          b.cost === '' || b.cost == null || !Number.isFinite(Number(b.cost)) ? null : Number(b.cost), b.supplier || null, dateOrNull(b.warranty_until), b.notes || null]);
      res.json({ ok: true, id: rows[0].id, tag: rows[0].tag });
    } catch (e) { fail(res, e.code === '23505' ? httpError(409, 'That asset tag is already used') : e); }
  });

  // Bring files the system already holds into the library (CVs, inquiry photos,
  // product photos). Safe to run again: anything already filed is skipped.
  app.post('/api/docs/index-existing', requireCap('docs.manage'), async (req, res) => {
    const out = { resumes: 0, inquiry_photos: 0, product_images: 0, skipped: 0 };
    try {
      const known = new Set((await query(`SELECT storage FROM document_versions WHERE storage IS NOT NULL`)).rows.map((r) => r.storage));
      const reg = async (rel, f) => {
        if (known.has(rel)) { out.skipped++; return false; }
        let abs; try { abs = resolveStorage(rel); } catch (_) { return false; }
        if (!fs.existsSync(abs)) return false;
        const st = fs.statSync(abs); const ext = path.extname(abs).toLowerCase();
        await createDoc(req, Object.assign({ storage: rel, size: st.size, sha256: await sha256File(abs), mime: MIME[ext.slice(1)] || null, source: 'import', text_content: await extractText(abs, ext) }, f));
        known.add(rel); return true;
      };
      const { rows: cv } = await query(`SELECT id, name, cv_file, cv_name, retain_until FROM job_applications WHERE cv_file IS NOT NULL AND anonymised_at IS NULL`).catch(() => ({ rows: [] }));
      for (const a of cv) if (/^[0-9a-f]{32}\.(pdf|docx|doc)$/.test(a.cv_file) && await reg('data/careers-cvs/' + a.cv_file, { title: 'CV - ' + (a.name || 'applicant ' + a.id), category: 'resume', file_name: a.cv_name || a.cv_file, keep_until: a.retain_until ? new Date(a.retain_until).toISOString().slice(0, 10) : null, links: [{ type: 'applicant', id: a.id }] })) out.resumes++;
      const { rows: iq } = await query(`SELECT id, name, photo_path FROM parts_inquiries WHERE photo_path IS NOT NULL AND photo_path <> ''`).catch(() => ({ rows: [] }));
      for (const r of iq) {
        for (const ph of String(r.photo_path).split(/[,;\s]+/).filter(Boolean)) {
          const rel = 'app/uploads/' + path.basename(ph);
          if (/\.(png|jpe?g|webp|gif|heic)$/i.test(rel) && await reg(rel, { title: 'Photo from ' + r.name + ' (inquiry #' + r.id + ')', category: 'customer_upload', file_name: path.basename(ph), links: [{ type: 'inquiry', id: r.id }] })) out.inquiry_photos++;
        }
      }
      const { rows: pr } = await query(`SELECT img, name FROM products WHERE img ~* '^[^/\\\\]+\\.(png|jpe?g|webp|gif)$'`);
      for (const r of pr) if (await reg('app/' + r.img, { title: 'Photo - ' + r.name, category: 'product_image', file_name: r.img, links: [{ type: 'product', id: r.img, label: r.name }] })) out.product_images++;
      res.json(Object.assign({ ok: true }, out));
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------------ access log --
  app.get('/api/docs/access-log', requireCap('docs.manage'), async (req, res) => {
    try {
      const { rows } = await query(`SELECT a.at, a.action, a.detail, a.ip, u.name, d.id AS doc_id, d.number, d.title, d.confidentiality
        FROM document_access a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN documents d ON d.id = a.document_id
        WHERE ($1 = '' OR d.confidentiality = $1) ORDER BY a.at DESC LIMIT 300`, [String(req.query.conf || '')]);
      res.json({ entries: rows });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------- communications --
  // One timeline from every channel: what the system sent (comm_log), portal
  // chat (customer_messages), AI / WhatsApp / phone conversations (ai_messages)
  // and web inquiries (parts_inquiries).
  app.get('/api/comms', requireCap('comms.journal'), async (req, res) => {
    try {
      const q = req.query; const args = []; const add = (v) => { args.push(v); return '$' + args.length; };
      const text = String(q.q || '').trim();
      const lim = Math.min(300, n(q.limit) || 100), off = Math.max(0, n(q.offset) || 0);
      const parts = [
        `SELECT 'log-' || c.id AS key, c.created_at AS at, c.channel, c.direction, c.to_addr AS party, c.subject, c.body, c.status, c.source, c.error, cu.name AS customer, c.customer_id, c.document_id, st.name AS staff
           FROM comm_log c LEFT JOIN users cu ON cu.id = c.customer_id LEFT JOIN users st ON st.id = c.staff_id`,
        `SELECT 'portal-' || m.id, m.created_at, 'portal', CASE WHEN m.sender = 'customer' THEN 'in' ELSE 'out' END, COALESCE(u.email, u.phone), NULL, m.body,
                CASE WHEN m.read_at IS NULL THEN 'unread' ELSE 'read' END, 'customer portal', NULL, u.name, m.user_id, NULL::int, s.name
           FROM customer_messages m JOIN users u ON u.id = m.user_id LEFT JOIN users s ON s.id = m.staff_id`,
        `SELECT 'ai-' || a.id, a.created_at, CASE WHEN c.channel IN ('web', 'kiosk', 'staff') THEN 'chat' ELSE c.channel END, CASE WHEN a.role = 'user' THEN 'in' ELSE 'out' END,
                COALESCE(c.customer_phone, c.customer_name, 'visitor #' || c.id), 'Conversation #' || c.id, a.shown_text, c.status, 'AI assistant', NULL, c.customer_name, c.customer_id, NULL::int, NULL
           FROM ai_messages a JOIN ai_conversations c ON c.id = a.conv_id WHERE COALESCE(a.shown_text, '') <> ''`,
        `SELECT 'inq-' || i.id, i.created_at, 'web form', 'in', i.phone, 'Parts inquiry #' || i.id, i.part_description || COALESCE(' (' || i.vehicle_make || ' ' || COALESCE(i.vehicle_model, '') || ')', ''),
                i.status, 'website', NULL, i.name, i.user_id, NULL::int, NULL
           FROM parts_inquiries i`,
      ];
      const where = [];
      if (q.channel) where.push('channel = ' + add(String(q.channel)));
      if (q.direction) where.push('direction = ' + add(String(q.direction)));
      if (q.status) where.push('status = ' + add(String(q.status)));
      if (q.source) where.push('source = ' + add(String(q.source)));
      if (q.customer) where.push('customer_id = ' + add(n(q.customer)));
      if (q.from) where.push('at >= ' + add(dateOrNull(q.from)) + '::date');
      if (q.to) where.push('at < ' + add(dateOrNull(q.to)) + '::date + 1');
      if (text) { const t = add('%' + text + '%'); where.push(`(party ILIKE ${t} OR subject ILIKE ${t} OR body ILIKE ${t} OR customer ILIKE ${t})`); }
      const { rows } = await query(`SELECT *, COUNT(*) OVER()::int AS total FROM (${parts.join(' UNION ALL ')}) x
        (key, at, channel, direction, party, subject, body, status, source, error, customer, customer_id, document_id, staff)
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY at DESC LIMIT ${lim} OFFSET ${off}`, args);
      const { rows: st } = await query(`SELECT channel, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE status = 'failed')::int AS failed FROM comm_log WHERE created_at > NOW() - INTERVAL '30 days' GROUP BY 1 ORDER BY 2 DESC`);
      const { rows: srcs } = await query(`SELECT DISTINCT source FROM comm_log WHERE source IS NOT NULL ORDER BY 1`);
      res.json({ total: rows.length ? rows[0].total : 0, messages: rows, last30: st, sources: srcs.map((r) => r.source) });
    } catch (e) { fail(res, e); }
  });
  // Calls, letters, visits, messages from a personal phone: logged by hand.
  app.post('/api/comms/log', requireCap('docs.upload'), async (req, res) => {
    try {
      const b = req.body || {};
      if (!['call', 'letter', 'visit', 'whatsapp', 'email', 'sms', 'other'].includes(b.channel)) throw httpError(400, 'Choose how it happened');
      if (!String(b.body || b.subject || '').trim()) throw httpError(400, 'Say what was said');
      if (b.entity_type && !ENTITIES[b.entity_type]) throw httpError(400, 'Unknown record type');
      const id = await logComm({ channel: b.channel, direction: b.direction === 'in' ? 'in' : 'out', to_addr: b.party, subject: b.subject, body: b.body, status: 'logged', source: 'manual',
        entity_type: b.entity_type || null, entity_id: b.entity_id || null, customer_id: n(b.customer_id), staff_id: me(req), document_id: n(b.document_id) });
      if (!id) throw httpError(500, 'Could not save');
      res.json({ ok: true, id });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------- expiry reminders (daily) --
  async function expiryMail() {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const { rows: s } = await query(`SELECT value FROM warehouse_settings WHERE key = 'docs_last_expiry_mail'`);
      if (s[0] && s[0].value === today) return;
      if (new Date().getHours() < 8) return;
      const { rows } = await query(`SELECT number, title, category, expiry_date FROM documents WHERE deleted_at IS NULL AND status <> 'archived' AND expiry_date IS NOT NULL
        AND expiry_date <= CURRENT_DATE + remind_days ORDER BY expiry_date LIMIT 100`);
      await query(`INSERT INTO warehouse_settings (key, value) VALUES ('docs_last_expiry_mail', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [today]);
      if (!rows.length || !mailer) return;
      const { rows: mgr } = await query(`SELECT email FROM users WHERE admin_role IN ('owner', 'manager') AND NOT COALESCE(disabled, false) AND email IS NOT NULL AND email NOT ILIKE '%.local'`);
      const text = 'Documents expired or expiring soon:\n\n' + rows.map((r) => new Date(r.expiry_date).toISOString().slice(0, 10) + '  ' + r.number + '  ' + r.title + ' (' + ((CATEGORIES[r.category] || {}).label || r.category) + ')').join('\n') + '\n\nOpen Documents > Expiring to renew them.';
      for (const m of mgr) await mailer.sendEmail({ to: m.email, subject: rows.length + ' documents expiring', text }).catch(() => {});
    } catch (e) { console.warn('[docs] expiry mail', e.message); }
  }
  if (!devMode) { setTimeout(expiryMail, 60000).unref(); setInterval(expiryMail, 3600000).unref(); }

  // ------------------------------------------- System management posture --
  if (deps.sysops && deps.sysops.addChecks) deps.sysops.addChecks(async () => {
    const { rows } = await query(`SELECT COUNT(*) FILTER (WHERE expiry_date < CURRENT_DATE)::int AS expired,
        COUNT(*) FILTER (WHERE category IN ('id', 'staff', 'security_clearance', 'legal') AND confidentiality NOT IN ('confidential', 'restricted'))::int AS exposed
      FROM documents WHERE deleted_at IS NULL AND status <> 'archived'`);
    return [
      { key: 'docs_expired', label: 'No expired permits, IDs or policies on file', state: rows[0].expired ? 'warn' : 'pass', detail: rows[0].expired + ' expired documents', fix: 'Documents > Expiring: renew them, or archive what is no longer needed.' },
      { key: 'docs_exposed', label: 'Personal documents are confidential', state: rows[0].exposed ? 'fail' : 'pass', detail: rows[0].exposed + ' IDs / staff / clearance / legal documents open to all staff', fix: 'Set them to Confidential or Restricted.' },
    ];
  });

  // File a page the system wrote (a signed invoice, say) as a document: the same
  // steps as a filled-in form above. req may have no session (a customer signing
  // from a link); the document is then filed by nobody and logged without a user.
  async function fileHtml(req, f) {
    const doc = await createDoc(req, Object.assign({ source: 'upload' }, f, { storage: null }));
    const tmp = path.join(INCOMING, crypto.randomBytes(16).toString('hex') + '.html');
    fs.writeFileSync(tmp, f.html);
    const size = fs.statSync(tmp).size; const sha = await sha256File(tmp);
    const storage = file(tmp, '.html');
    const fname = String(f.file_name || f.title || 'document').replace(/[^\w .-]+/g, '').trim() + ' ' + doc.number + '.html';
    await query(`UPDATE documents SET file_name = $2, mime = 'text/html', size = $3, sha256 = $4, storage = $5, text_content = $6 WHERE id = $1`, [doc.id, fname, size, sha, storage, plain(f.html)]);
    await query(`INSERT INTO document_versions (document_id, version, file_name, mime, size, sha256, storage, note, uploaded_by) VALUES ($1, 1, $2, 'text/html', $3, $4, $5, $6, $7)`, [doc.id, fname, size, sha, storage, f.note || 'First version', me(req)]);
    return doc;
  }

  return { logComm, createDoc, fileHtml, CATEGORIES, ENTITIES };
};
