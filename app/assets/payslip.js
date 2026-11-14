// =============================================================================
//  A payslip as HTML, shared by Payroll (printing a run's payslips) and My pay
//  (payslip.html: staff viewing and printing their own).
//
//    Payslip.html(view)   view = GET /api/payroll/slips/:id
//    Payslip.css          the styles the markup needs (print window / page)
// =============================================================================
(function () {
  'use strict';
  var esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var J = function (v) { var n = Number(v || 0); return (n < 0 ? '-' : '') + 'J$' + Math.abs(n).toLocaleString('en-JM', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  var num = function (v) { return Number(v || 0); };
  var FREQ = { weekly: 'weekly', fortnightly: 'fortnightly', monthly: 'monthly' };
  var CSS = '.ps-page{font:13px system-ui,-apple-system,Segoe UI,sans-serif;color:#000;background:#fff;max-width:760px;margin:0 auto 30px;padding:18px 20px;page-break-after:always;border-radius:6px}' +
    '.ps-page:last-child{page-break-after:auto}.ps-page table{border-collapse:collapse;width:100%;margin-top:8px}.ps-page td,.ps-page th{padding:4px 6px;border-bottom:1px solid #ddd;text-align:left;color:#000;background:none}' +
    '.ps-page th{font-size:12px;border-bottom:1px solid #999}.ps-page .n{text-align:right;white-space:nowrap}.ps-page h2{margin:0 0 4px;font-size:18px;color:#000}.ps-page .box{border:1px solid #999;padding:10px;margin:8px 0;border-radius:4px}' +
    '.ps-page small{color:#444}.ps-page .net{display:flex;justify-content:space-between;font-size:16px}.ps-page .cols{display:flex;gap:16px;flex-wrap:wrap}.ps-page .cols>div{flex:1;min-width:220px}' +
    '@media print{.ps-page{margin:0 auto;padding:0;border-radius:0}}';

  function html(v) {
    var s = v.slip, e = v.employer || {}, y = v.ytd || {}, sn = s.snapshot || {}, tax = s.tax || null, prior = v.prior || null;
    var lines = s.lines || [];
    var earn = lines.filter(function (l) { return l.kind === 'earning'; }), ded = lines.filter(function (l) { return l.kind === 'deduction'; }), er = lines.filter(function (l) { return l.kind === 'employer'; });
    var ctr = sn.worker_type === 'contractor';
    var stat = ctr ? [['Contractor levy', s.levy, y.levy], ['Withholding tax', s.wht, y.wht]] : [['NIS', s.nis_ee, y.nis_ee], ['NHT', s.nht_ee, y.nht_ee], ['Education Tax', s.ed_ee, y.ed_ee], ['Income tax (PAYE)', s.paye, y.paye]];
    if (num(s.pension_ee) || num(y.pension_ee)) stat.push(['Pension', s.pension_ee, y.pension_ee]);
    // Cash tips and the like the person already has: in gross pay, taken back out of net.
    var got = earn.filter(function (l) { return l.received; }).reduce(function (t, l) { return t + num(l.amount); }, 0);
    // Paid with the wages but not pay (a loan handed out, savings coming back, expenses repaid): after the deductions.
    var NOT_PAY = ['advance_paid', 'savings_payout', 'reimbursement', 'mileage'];
    var notPay = function (l) { return NOT_PAY.indexOf(l.code) >= 0; };
    var extra = earn.filter(notPay);
    earn = earn.filter(function (l) { return !notPay(l); });
    var totalDed = stat.reduce(function (t, x) { return t + num(x[1]); }, 0) + ded.reduce(function (t, l) { return t + num(l.amount); }, 0) + got;

    var head = '<div style="display:flex;justify-content:space-between;gap:12px"><div><h2>' + esc(e.name) + '</h2><small>' + esc(e.address || '') + (e.trn ? ' · TRN ' + esc(e.trn) : '') + (e.nis ? ' · NIS ' + esc(e.nis) : '') + '</small></div>' +
      '<div style="text-align:right"><b>' + (ctr ? 'PAYMENT ADVICE' : 'PAYSLIP') + '</b><br>' + esc(s.number) + (s.status === 'draft' ? ' (DRAFT)' : s.status === 'void' ? ' (VOID)' : '') + '</div></div>' +
      '<div class="box"><b>' + esc(sn.name) + '</b>' + (sn.employee_no ? ' · #' + esc(sn.employee_no) : '') + (sn.job_title ? ' · ' + esc(sn.job_title) : '') + (sn.department ? ' · ' + esc(sn.department) : '') +
      '<br><small>TRN ' + esc(sn.trn || '—') + ' · NIS ' + esc(sn.nis_no || '—') + ' · Paid ' + esc(FREQ[s.frequency] || '') + ' · Period ' + esc(s.period_start) + ' to ' + esc(s.period_end) + ' · Pay date ' + esc(s.pay_date) + ' by ' + esc(sn.pay_method || '') +
      (sn.bank_masked ? ' ' + esc(sn.bank_name || '') + ' ' + esc(sn.bank_masked) : '') + (s.cheque_number ? ' chq ' + esc(s.cheque_number) : '') +
      (sn.hire_date && sn.hire_date >= s.period_start ? ' · Started ' + esc(sn.hire_date) : '') + (sn.termination_date && sn.termination_date <= s.period_end ? ' · Left ' + esc(sn.termination_date) : '') + '</small></div>';

    var earnings = '<table><thead><tr><th>Earnings</th><th class="n">Hours / qty</th><th class="n">Rate</th><th class="n">Amount</th></tr></thead><tbody>' +
      earn.map(function (l) { return '<tr><td>' + esc(l.label) + (l.received ? ' <small>(already received)</small>' : '') + '</td><td class="n">' + (l.qty != null && l.code !== 'commission' && l.qty !== 1 ? l.qty : '') + '</td><td class="n">' + (l.qty !== 1 && l.rate ? J(l.rate) : '') + '</td><td class="n">' + J(l.amount) + '</td></tr>'; }).join('') +
      '<tr><td colspan="3"><b>Gross pay</b></td><td class="n"><b>' + J(s.gross) + '</b></td></tr></tbody></table>';

    var deductions = '<table><thead><tr><th>Deductions</th><th class="n">This pay</th><th class="n">Year to date</th></tr></thead><tbody>' +
      stat.map(function (x) { return '<tr><td>' + x[0] + '</td><td class="n">' + J(x[1]) + '</td><td class="n">' + J(x[2]) + '</td></tr>'; }).join('') +
      ded.map(function (l) { return '<tr><td>' + esc(l.label) + (l.payee ? ' <small>· ' + esc(l.payee) + '</small>' : '') + '</td><td class="n">' + J(l.amount) + '</td><td></td></tr>'; }).join('') +
      (got ? '<tr><td>Already received (not paid again)</td><td class="n">' + J(got) + '</td><td></td></tr>' : '') +
      '<tr><td><b>Total deductions</b></td><td class="n"><b>' + J(totalDed) + '</b></td><td></td></tr></tbody></table>';

    var others = extra.length ? '<table><thead><tr><th>Also paid with this pay (not pay, not taxed)</th><th class="n">Amount</th></tr></thead><tbody>' +
      extra.map(function (l) { return '<tr><td>' + esc(l.label) + '</td><td class="n">' + J(l.amount) + '</td></tr>'; }).join('') + '</tbody></table>' : '';
    var net = others + '<div class="box net"><b>NET PAY</b><b>' + J(s.net) + '</b></div>';

    // How the income tax was worked out.
    var taxNote = '';
    if (!ctr && tax) {
      var free = [];
      if (num(tax.age_relief)) free.push('age relief ' + J(tax.age_relief) + ' a year');
      if (num(tax.extra)) free.push('extra tax-free amount ' + J(tax.extra) + ' a year');
      if (tax.exempt) taxNote = 'No income tax is deducted (exempt).';
      else if (tax.method === 'cumulative') taxNote = 'Income tax is worked on the year to date (pay ' + tax.period + ' of ' + tax.periods + '): statutory income so far ' + J(tax.statutory_to_date) + ', tax-free pay so far ' + J(tax.free_to_date) +
        ', tax due so far ' + J(tax.tax_to_date) + ', already paid ' + J(tax.paid_before) + '.';
      else taxNote = 'Statutory income this pay ' + J(s.statutory) + '; tax-free pay this pay ' + J(tax.free_period) + ' (threshold ' + J(tax.threshold) + ' a year).';
      if (free.length && !tax.exempt) taxNote += ' Tax-free pay includes ' + free.join(' and ') + '.';
    }

    var ytd = '<table><thead><tr><th colspan="4">Year to date' + (s.pay_date ? ' (' + esc(String(s.pay_date).slice(0, 4)) + ')' : '') + '</th></tr></thead><tbody>' +
      '<tr><td>Gross pay</td><td class="n">' + J(y.gross) + '</td><td>Net pay</td><td class="n">' + J(y.net) + '</td></tr>' +
      (ctr ? '' : '<tr><td>Statutory income</td><td class="n">' + J(y.statutory) + '</td><td>Income tax (PAYE)</td><td class="n">' + J(y.paye) + '</td></tr>') +
      (prior ? '<tr><td colspan="2">Earlier job this year' + (prior.employer ? ' (' + esc(prior.employer) + ')' : '') + ': gross ' + J(prior.gross) + '</td><td>PAYE paid there</td><td class="n">' + J(prior.paye) + '</td></tr>' : '') + '</tbody></table>';

    // Paid by the employer for the person, and benefits taxed but not paid in cash.
    var kind = er.filter(function (l) { return l.notional; }), paidFor = er.filter(function (l) { return !l.notional; });
    var erRows = ctr ? [] : [['NIS (employer)', s.nis_er], ['NHT (employer)', s.nht_er], ['Education Tax (employer)', s.ed_er], ['HEART/NSTA', s.heart_er], ['Pension (employer)', s.pension_er]].filter(function (x) { return num(x[1]); });
    erRows = erRows.concat(paidFor.map(function (l) { return [l.label + (l.payee ? ' · ' + l.payee : ''), l.amount]; }));
    var employer = (erRows.length ? '<table><thead><tr><th>Paid by your employer for you (not in your pay)</th><th class="n">This pay</th></tr></thead><tbody>' + erRows.map(function (x) { return '<tr><td>' + esc(x[0]) + '</td><td class="n">' + J(x[1]) + '</td></tr>'; }).join('') + '</tbody></table>' : '') +
      (kind.length ? '<table><thead><tr><th>Benefits you receive that are taxed (not cash)</th><th class="n">Taxable value this pay</th></tr></thead><tbody>' + kind.map(function (l) { return '<tr><td>' + esc(l.label) + '</td><td class="n">' + J(l.amount) + '</td></tr>'; }).join('') + '</tbody></table>' : '') +
      (num(s.taxable_benefits) ? '<small>Taxable benefits included in your statutory income this pay: ' + J(s.taxable_benefits) + '.</small>' : '');

    // Balances as they stand today.
    var bal = [];
    (v.loans || []).forEach(function (l) { bal.push([(l.kind === 'loan' ? 'Loan' : 'Salary advance') + ' of ' + J(l.amount) + ' (' + esc(l.issue_date) + '), ' + J(l.per_pay) + ' each pay', 'still owed ' + J(l.balance)]); });
    (v.savings || []).forEach(function (x) { bal.push([esc(x.label) + (x.payout_pending > 0 ? ' (' + J(x.payout_pending) + ' to be paid out on your next payslip)' : ''), 'saved ' + J(x.saved)]); });
    var lv = v.leave;
    if (lv) bal.push(['Leave ' + esc(lv.year), 'vacation ' + lv.vacation_left + ' of ' + lv.vacation_entitled + ' days left · sick ' + lv.sick_left + ' of ' + lv.sick_entitled + ' left']);
    var balances = bal.length ? '<table><thead><tr><th colspan="2">Loans, savings and leave (as they stand today)</th></tr></thead><tbody>' + bal.map(function (b) { return '<tr><td>' + b[0] + '</td><td class="n">' + b[1] + '</td></tr>'; }).join('') + '</tbody></table>' : '';

    return '<div class="ps-page">' + head + earnings + deductions + net + (taxNote ? '<small>' + taxNote + '</small>' : '') + ytd + employer + balances + '</div>';
  }

  window.Payslip = { html: html, css: CSS, J: J, esc: esc };
})();
