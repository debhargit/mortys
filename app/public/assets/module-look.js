// =============================================================================
//  Vision Auto Solutions -- the shared look of the "All modules" pages
//
//  The same banner and section cards as the training manual: a banner in the
//  module's colour with its icon, group, name and what it is for (the words on
//  its All modules tile), a link to its training lesson, and cards with a
//  coloured top edge and heading bar. Loaded with <script defer> by each page;
//  it only adds to the page and changes nothing the page does.
// =============================================================================
(function () {
  'use strict';
  // path (or path#hash) -> [icon, group, name, what it is for, colour, training lesson]
  var M = {
    '/supplier-admin.html': ['🏭', 'Suppliers', 'Supplier management', 'Give suppliers portal logins, set credit, consignment, retail and training.', '#0e7490', 'stores-suppliers'],
    '/my-time.html': ['⏱', 'Team', 'My time', 'Your clock-ins, lateness letters to acknowledge, extra time and corrections.', '#0284c7', 'timeclock'],
    '/documents.html': ['🗂', 'Documents and communications', 'Document centre', 'Every filed document, forms and templates, approvals, expiry, assets and inventory images.', '#57534e', 'documents-forms'],
    '/documents.html#comms': ['📨', 'Documents and communications', 'Communications journal', 'Every email, SMS, chat, WhatsApp and inquiry in one timeline.', '#57534e', 'documents-forms'],
    '/documents.html#forms': ['📝', 'Documents and communications', 'Forms (leave and others)', 'Fill in a leave form, letter or report; managers approve.', '#57534e', 'documents-forms'],
    '/accounting.html': ['📒', 'Money', 'Accounting', 'General ledger, journals, trial balance and the QuickBooks export.', '#334155', 'accounting'],
    '/budget.html': ['💰', 'Money', 'Budget & forecast', 'Budgets and versions, 12-month and 13-week forecasts, break-even, ROI and the health report.', '#059669', 'budget-forecast'],
    '/receivables.html': ['📥', 'Money', 'Receivables', 'Customer accounts, payments, statements and collections.', '#0369a1', 'receivables'],
    '/payables.html': ['📤', 'Money', 'Payables', 'Supplier bills and paying them.', '#1d4ed8', 'payables-banking'],
    '/banking.html': ['🏦', 'Money', 'Banking', 'Registers, deposits and reconciliation.', '#1d4ed8', 'payables-banking'],
    '/loans-rent.html': ['🏠', 'Money', 'Loans & Rent', 'Loans, rent and recurring bills: register, statements and schedules.', '#a16207', 'loans-rent'],
    '/report-balancing.html': ['⚖', 'Money', 'Balancing report', 'Stock ledger and cost at sale: what balances and what to explain.', '#9a3412', 'reports-planning'],
    '/people.html': ['🗂', 'People', 'People & HR', 'Staff files, contacts, job and pay history, probation, warnings, reviews, leave, exits, org chart and HR reports.', '#9d174d', 'hr-files'],
    '/payroll.html': ['🧾', 'People', 'Payroll', 'Jamaican payroll: NIS, NHT, Education Tax, HEART and PAYE, contractors, loans and deductions.', '#047857', 'payroll-attendance'],
    '/attendance.html': ['🕘', 'People', 'Attendance', 'Who is in, hours, lateness, shifts, leave and timesheets.', '#047857', 'payroll-attendance'],
    '/commission.html': ['💰', 'People', 'Commission', 'Sales commission rules, statements and payouts.', '#047857', 'payroll-attendance'],
    '/hiring.html': ['🧑‍💼', 'People', 'Hiring and careers', 'Requisitions, job posts, applicants, interviews and scorecards, references and offers.', '#7e22ce', 'hiring'],
    '/franchise.html': ['🏪', 'Franchise', 'Franchise', 'Enquiries and leads, NDA, disclosure document, agreement and signing, territories, opening, royalties, audits, renewals and exits; the store network.', '#b91c1c', 'franchise'],
    '/stockcash.html': ['🏷️', 'Stock and sales', 'Stock to cash', 'Clearance ladder, returns grading and liquidation lots.', '#e11d48', 'clearance'],
    '/report-planning.html': ['📈', 'Stock and sales', 'Planning and lost sales', 'Reorder planning and the sales we missed.', '#9a3412', 'reports-planning'],
    '/terminal.html': ['🧾', 'Stock and sales', 'Terminal journal', 'Every till event as it happens, exceptions, and departments.', '#9a3412', 'reports-planning'],
    '/deptstore.html': ['🏬', 'Stock and sales', 'Department store', 'Stores and branches, inventory and sales by department, and stock transfers.', '#0e7490', 'stores-suppliers'],
    '/messages.html': ['✉', 'Customers', 'Customer messages', 'Messages, campaigns and consent.', '#4f46e5', 'customer-records'],
    '/ai.html': ['🤖', 'Customers', 'AI parts assistant', 'Counter and phone assistant: conversations, hand-overs and settings.', '#6d28d9', 'ai-assistant'],
    '/system.html': ['🛡', 'Security and system', 'System management', 'Audit, security, threats, the network map, help desk and equipment.', '#1e293b', 'settings-security'],
    '/security.html': ['🔒', 'Security and system', 'Security and audit log', 'Lockouts, 2-step sign-in and the audit trail.', '#1e293b', 'settings-security'],
    '/legacy-import.html': ['📥', 'Security and system', 'Import from the old system', 'Check and bring across the old program’s exports: stock, invoices, payments and stock received.', '#1e293b', 'settings-security'],
  };
  var path = location.pathname.replace(/\/+$/, '') || '/';
  if (!M[path]) return;

  var CSS =
    '.ml-band{--h:#0b1b2b;border-radius:18px;padding:22px 26px;margin:0 0 12px;color:#fff;position:relative;overflow:hidden;' +
      'background:radial-gradient(120% 140% at 100% 0,rgba(255,255,255,.14),transparent 55%),linear-gradient(135deg,var(--h),#0b1b2b 85%)}' +
    '.ml-band .k{font-size:12px;letter-spacing:3px;text-transform:uppercase;opacity:.72}' +
    '.ml-band h2{font-size:28px;margin:4px 0 6px;line-height:1.15;max-width:calc(100% - 90px);color:#fff;border:0;padding:0}' +
    '.ml-band p{opacity:.88;margin:0;max-width:70ch;font-size:15px}' +
    '.ml-band .bk{position:absolute;right:24px;top:12px;font-size:86px;opacity:.22;line-height:1;pointer-events:none}' +
    '.ml-band .ml-links{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}' +
    '.ml-band .ml-links a{color:#fff;text-decoration:none;font-size:13px;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.24);border-radius:999px;padding:4px 12px}' +
    '.ml-band .ml-links a:hover{background:rgba(255,255,255,.22)}' +
    'main .card{border-top:4px solid var(--ml-h)}' +
    'main .card .card,main .modal .card,main .card.ml-plain{border-top-width:1px;border-top-color:var(--line,#e5e7eb)}' +
    'main .card>h2:first-child::before,main .card>h3:first-child::before{content:"";display:inline-block;width:4px;height:17px;border-radius:4px;background:var(--ml-h);margin-right:9px;vertical-align:-3px;flex:none}' +
    '@media (max-width:600px){.ml-band{padding:18px 16px}.ml-band h2{font-size:22px;max-width:calc(100% - 50px)}.ml-band .bk{font-size:46px;right:12px}}' +
    '@media print{.ml-band{-webkit-print-color-adjust:exact;print-color-adjust:exact;break-inside:avoid}.ml-band .ml-links{display:none}}';

  var esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  function info() { return M[path + location.hash.replace(/[=?].*$/, '')] || M[path]; }
  function html(m) {
    return '<span class="bk">' + m[0] + '</span><div class="k">' + esc(m[1]) + ' · Vision Auto Solutions</div><h2>' + esc(m[2]) + '</h2><p>' + esc(m[3]) + '</p>' +
      '<div class="ml-links"><a href="/training.html#lesson=' + esc(m[5]) + '">📖 How to use this page</a><a href="/training.html#manual">📘 Staff manual</a><a href="/admin.html#tab=modules">🧭 All modules</a></div>';
  }
  function start() {
    var main = document.querySelector('main');
    if (!main || document.getElementById('mlBand')) return;
    var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    var m = info(), band = document.createElement('div');
    band.className = 'ml-band'; band.id = 'mlBand'; band.style.setProperty('--h', m[4]); band.innerHTML = html(m);
    document.documentElement.style.setProperty('--ml-h', m[4]);
    // Below the page's tabs when they come first, as on the training page.
    var first = main.firstElementChild;
    if (first && /\btabs\b/.test(first.className)) main.insertBefore(band, first.nextSibling); else main.insertBefore(band, first);
    window.addEventListener('hashchange', function () { var n = info(); band.style.setProperty('--h', n[4]); band.innerHTML = html(n); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
