// The program's own message windows (assets/vas-ui.js), for a page that has not loaded them itself.
(function(){ if (window.VasUI || document.querySelector('script[src^="/assets/vas-ui.js"]')) return; var s = document.createElement('script'); s.src = '/assets/vas-ui.js?v=20261110b'; (document.head || document.documentElement).appendChild(s); })();
// Loans, invoices on the books, recurring invoices / bills, reminders and late
// fees (billing.js) -- the screens shared by receivables.html and payables.html.
// Needs books-common.js (window.Books) loaded first.
(function () {
  'use strict';
  var B = window.Books, $ = B.$, all = B.all, esc = B.esc, J = B.J, api = B.api, toast = B.toast, modal = B.modal, close = B.close;
  var FREQ = { weekly: 'Weekly', fortnightly: 'Every two weeks', monthly: 'Monthly', quarterly: 'Quarterly', yearly: 'Yearly' };
  var METHOD = { annuity: 'Fixed payment (annuity)', equal_principal: 'Equal principal', interest_only: 'Interest only, principal at the end' };
  var STATE = { upcoming: '', billed: 'warn', paid: 'ok', 'bill voided': 'bad' };
  var freqOptions = function (v) { return Object.keys(FREQ).map(function (k) { return '<option value="' + k + '"' + (k === (v || 'monthly') ? ' selected' : '') + '>' + FREQ[k] + '</option>'; }).join(''); };
  var sysAccount = function (key) { var a = B.accounts().find(function (x) { return x.system_key === key; }); return a ? a.id : ''; };
  var num = function (v) { return v == null || v === '' ? '' : v; };
  function feeText(p) {
    if (!p.late_fee_type) return 'customer\'s rule';
    if (p.late_fee_type === 'none') return 'no late fee';
    return (p.late_fee_type === 'flat' ? J(p.late_fee_amount) : p.late_fee_amount + '%') + ' after ' + (p.late_fee_grace_days || 0) + ' days' + (p.late_fee_repeat === 'monthly' ? ', monthly while unpaid' : ', once');
  }

  // ---------------------------------------------------------- lines editor --
  // Category (account) / class / description / amount rows, QuickBooks style; returns a getter for
  // [{account_id, class_id, description, amount}]. New lines start from the customer's / supplier's defaults.
  function linesEditor(el, lines, defaultAccount, hint, defaultClass) {
    var dflt = { account_id: defaultAccount, class_id: defaultClass || '' };
    var rows = (lines && lines.length ? lines.map(function (l) { return { account_id: l.account_id, class_id: l.class_id || '', asset_id: l.asset_id || '', description: l.description, amount: l.amount }; }) : [{ account_id: dflt.account_id, class_id: dflt.class_id, asset_id: '', description: '', amount: '' }]);
    function draw() {
      el.innerHTML = '<table><thead><tr><th>Category (account)</th><th>Class</th><th title="A fixed asset this line is for">Asset</th><th>Description' + (hint ? ' <small>' + esc(hint) + '</small>' : '') + '</th><th class="n">Amount (J$)</th><th></th></tr></thead><tbody>' +
        rows.map(function (l, i) { return '<tr><td><select data-la="' + i + '">' + B.accountOptions('line', l.account_id) + '</select></td><td><select data-lc="' + i + '">' + B.classOptions(l.class_id) + '</select></td><td><select data-lfa="' + i + '">' + B.assetOptions(l.asset_id) + '</select></td><td><input data-ld="' + i + '" value="' + esc(l.description || '') + '" style="width:100%"></td><td class="n"><input type="number" step="0.01" data-lm="' + i + '" value="' + num(l.amount) + '" style="width:120px"></td><td>' + (rows.length > 1 ? '<button class="sm" data-lx="' + i + '">✕</button>' : '') + '</td></tr>'; }).join('') +
        '</tbody></table><button class="sm" data-ladd>+ Line</button>';
      all('[data-la]', el).forEach(function (x) { x.onchange = function () { rows[+x.getAttribute('data-la')].account_id = x.value; }; });
      all('[data-lc]', el).forEach(function (x) { x.onchange = function () { rows[+x.getAttribute('data-lc')].class_id = x.value; }; });
      all('[data-lfa]', el).forEach(function (x) { x.onchange = function () { rows[+x.getAttribute('data-lfa')].asset_id = x.value; }; });
      all('[data-ld]', el).forEach(function (x) { x.oninput = function () { rows[+x.getAttribute('data-ld')].description = x.value; }; });
      all('[data-lm]', el).forEach(function (x) { x.oninput = function () { rows[+x.getAttribute('data-lm')].amount = x.value; }; });
      all('[data-lx]', el).forEach(function (x) { x.onclick = function () { rows.splice(+x.getAttribute('data-lx'), 1); draw(); }; });
      $('[data-ladd]', el).onclick = function () { rows.push({ account_id: dflt.account_id, class_id: dflt.class_id, asset_id: '', description: '', amount: '' }); draw(); };
    }
    draw();
    return { get: function () { return rows; }, total: function () { return rows.reduce(function (t, l) { return t + (+l.amount || 0); }, 0); },
      // A supplier chosen after the form opened: its defaults for new lines, and for the first line if still blank.
      setDefaults: function (acct, cls) { dflt = { account_id: acct || dflt.account_id, class_id: cls || dflt.class_id }; if (rows.length === 1 && !rows[0].amount) { if (!rows[0].account_id && acct) rows[0].account_id = acct; if (!rows[0].class_id && cls) rows[0].class_id = cls; } draw(); } };
  }
  function gctHelper(linesEd) {
    $('#g15').onclick = function () { $('#gct').value = (Math.round(linesEd.total() * 15) / 100).toFixed(2); };
  }

  // ------------------------------------------------------- invoice on the books --
  function newInvoice(c, done) {
    modal('<h2>New invoice · ' + esc(c.name) + '</h2><p class="sub">For rent, recharges and anything else not sold at the till. It goes on the customer\'s account like a charge sale.</p>' +
      '<div class="controls"><div><label>Invoice date</label><input id="idt" type="date" value="' + B.today() + '"></div><div><label>Due date</label><input id="idu" type="date"> <small class="sub">blank: the customer\'s terms</small></div></div>' +
      '<div id="ilines"></div><div class="controls"><div><label>GCT (J$)</label><input id="gct" type="number" step="0.01" value="0" style="width:120px"> <button class="sm" id="g15">15%</button></div><div style="flex:1"><label>Memo</label><input id="imemo" style="width:100%"></div></div>' +
      '<div class="controls"><button class="primary" id="igo">Save invoice</button><button id="ix">Cancel</button></div>');
    var ed = linesEditor($('#ilines'), null, c.default_income_account_id || sysAccount('rental_income'), null, c.default_class_id);
    gctHelper(ed);
    $('#ix').onclick = close;
    $('#igo').onclick = function () {
      api('/api/ar/invoices', 'POST', { customer_id: c.id, invoice_date: $('#idt').value, due_date: $('#idu').value, lines: ed.get(), gct_amount: $('#gct').value, memo: $('#imemo').value })
        .then(function (r) { close(); toast('Invoice ' + r.number + ' saved: ' + J(r.total) + ', due ' + r.due_date); if (done) done(); }).catch(function (e) { toast(e.message); });
    };
  }
  async function voidInvoice(id, isFee, done) {
    var r = await vasPrompt(isFee ? 'Why is the late fee waived?' : 'Why is this invoice voided?');
    if (!r) return;
    api('/api/ar/invoices/' + id + '/void', 'POST', { reason: r }).then(function () { toast(isFee ? 'Fee waived' : 'Invoice voided'); if (done) done(); }).catch(function (e) { toast(e.message); });
  }

  // ---------------------------------------------------- reminders and fees --
  function feeFields(p) {
    p = p || {};
    return '<div class="controls"><div><label>Late fee</label><select id="lft"><option value="">' + (p.allowInherit ? 'Use the customer\'s rule' : 'No late fee') + '</option>' + (p.allowInherit ? '<option value="none">No late fee</option>' : '') +
      '<option value="flat">Flat amount</option><option value="percent">% of what is open</option></select></div>' +
      '<div class="lf"><label>Amount (J$ or %)</label><input id="lfa" type="number" step="0.01" value="' + num(p.late_fee_amount) + '" style="width:100px"></div>' +
      '<div class="lf"><label>Grace (days after due)</label><input id="lfg" type="number" value="' + (p.late_fee_grace_days || 0) + '" style="width:80px"></div>' +
      '<div class="lf"><label>How often</label><select id="lfr"><option value="once">Once per invoice</option><option value="monthly">Every month while unpaid</option></select></div>' +
      '<div class="lf"><label>Min / max (J$)</label><input id="lfmin" type="number" value="' + num(p.late_fee_min) + '" style="width:90px"> <input id="lfmax" type="number" value="' + num(p.late_fee_max) + '" style="width:90px"></div></div>' +
      '<p class="sub lf">A promise to pay that has not passed holds the fee. A fee is never charged on a fee or on till sales, and can be waived from the customer\'s open invoices.</p>';
  }
  function wireFee(p) {
    $('#lft').value = (p && p.late_fee_type) || '';
    $('#lfr').value = (p && p.late_fee_repeat) || 'once';
    var upd = function () { var on = ['flat', 'percent'].indexOf($('#lft').value) >= 0; all('.lf').forEach(function (x) { x.style.display = on ? '' : 'none'; }); };
    $('#lft').onchange = upd; upd();
    return function () { return { late_fee_type: $('#lft').value || null, late_fee_amount: $('#lfa').value, late_fee_grace_days: $('#lfg').value, late_fee_repeat: $('#lfr').value, late_fee_min: $('#lfmin').value, late_fee_max: $('#lfmax').value }; };
  }
  function billingSettings(c, done) {
    api('/api/ar/customers/' + c.id + '/billing').then(function (d) {
      var s = d.settings;
      modal('<h2>Reminders and late fees · ' + esc(c.name) + '</h2>' +
        (!d.can_email ? '<div class="note bad">No email address on this account: reminders are logged as "phone them" instead of sent.</div>' : '') +
        '<h3>Automatic reminders</h3><div class="controls"><label><input type="checkbox" id="ron"' + (s.reminders ? ' checked' : '') + '> Email reminders</label>' +
        '<div><label>Days before due</label><input id="rdb" type="number" value="' + num(s.days_before) + '" style="width:70px"></div>' +
        '<label><input type="checkbox" id="rod"' + (s.on_due ? ' checked' : '') + '> On the due date</label>' +
        '<div><label>Days after due (up to 14)</label><input id="rda" value="' + esc((s.days_after || []).join(', ')) + '" style="width:110px"></div></div>' +
        '<p class="sub">Following the credit procedure: emails stop at day 14 (from day 15 it is a phone call). A promise to pay stops the overdue reminders until its date; a credit hold stops the "coming due" ones.</p>' +
        '<h3>Customer-wide late fee</h3><p class="sub">Applies to invoices raised on the books for this customer (not till sales) dated from when it is switched on' + (s.late_fee_from ? ' (' + esc(s.late_fee_from) + ')' : '') + '. A recurring plan can set its own.</p>' + feeFields(s) +
        '<div class="controls"><button class="primary" id="rgo">Save</button><button id="rx">Close</button></div>' +
        (d.log.length ? '<h3>Recent automatic reminders</h3><table><tbody>' + d.log.map(function (l) { return '<tr><td>' + esc(B.dt(l.created_at)) + '</td><td>' + esc(l.number || '') + '</td><td>' + esc(l.stage) + '</td><td><span class="pill ' + (l.status === 'sent' ? 'ok' : l.status === 'failed' ? 'bad' : 'warn') + '">' + esc(l.status) + '</span></td></tr>'; }).join('') + '</tbody></table>' : ''));
      var fee = wireFee(s);
      $('#rx').onclick = close;
      $('#rgo').onclick = function () {
        api('/api/ar/customers/' + c.id + '/billing', 'PUT', Object.assign({ reminders: $('#ron').checked, days_before: $('#rdb').value, on_due: $('#rod').checked, days_after: $('#rda').value }, fee()))
          .then(function () { close(); toast('Saved'); if (done) done(); }).catch(function (e) { toast(e.message); });
      };
    }).catch(function (e) { toast(e.message); });
  }

  // ------------------------------------------------------------- plans --
  // side 'ar' (party = customer) or 'ap' (party = supplier, or a function returning one from the name typed).
  function planEditor(side, p, party, done) {
    var isAr = side === 'ar', edit = !!(p && p.id);
    p = p || { frequency: 'monthly', due_days: isAr ? 7 : 0, start_date: B.today(), pay_mode: 'manual', lines: null, gct_amount: 0 };
    modal('<h2>' + (edit ? 'Change ' : 'New ') + (isAr ? 'recurring invoice' : 'recurring bill') + (party && party.name ? ' · ' + esc(party.name) : '') + '</h2>' +
      (edit ? '<p class="sub">Changes apply from the next period (' + esc(p.next_run || '') + '); invoices or bills already raised are not changed.</p>' : '') +
      '<div class="controls"><div style="flex:1"><label>Name</label><input id="pn" value="' + esc(p.name || '') + '" placeholder="' + (isAr ? 'Unit 2 rent' : 'Internet') + '" style="width:100%"></div>' +
      (!isAr && !edit && typeof party === 'function' ? '<div><label>Supplier</label><input id="psup" list="suppliers" style="width:220px"></div>' : '') + '</div>' +
      '<div class="controls"><div><label>How often</label><select id="pf"' + (edit ? ' disabled' : '') + '>' + freqOptions(p.frequency) + '</select></div>' +
      '<div><label>First period date</label><input id="ps" type="date" value="' + esc(p.start_date || '') + '"' + (edit ? ' disabled' : '') + '></div>' +
      '<div><label>Due (days after)</label><input id="pd" type="number" value="' + (p.due_days || 0) + '" style="width:70px"></div>' +
      '<div><label>Ends (optional)</label><input id="pe" type="date" value="' + esc(p.end_date || '') + '"></div><div><label>or after N runs</label><input id="pm" type="number" value="' + num(p.max_runs) + '" style="width:70px"></div></div>' +
      '<div id="plines"></div><div class="controls"><div><label>GCT (J$)</label><input id="gct" type="number" step="0.01" value="' + (p.gct_amount || 0) + '" style="width:120px"> <button class="sm" id="g15">15%</button></div>' +
      (!isAr ? '<div><label>Paid by</label><select id="ppm"><option value="manual">Paying it ourselves (email a reminder)</option><option value="standing_order">Standing order (the bank takes it)</option></select></div>' : '') + '</div>' +
      (isAr ? '<h3>Late fee for this agreement</h3>' + feeFields(Object.assign({ allowInherit: true }, p)) : '') +
      '<div class="controls"><button class="primary" id="pgo">Save</button><button id="px">Cancel</button></div>');
    var ed = linesEditor($('#plines'), p.lines, isAr ? ((party && party.default_income_account_id) || sysAccount('rental_income')) : ((party && party.default_account_id) || ''), '{period} becomes e.g. "November 2026"', party && party.default_class_id);
    if ($('#psup')) $('#psup').onchange = function () { var sp = party($('#psup').value); if (sp) ed.setDefaults(sp.default_account_id, sp.default_class_id); };
    gctHelper(ed);
    if (!isAr) $('#ppm').value = p.pay_mode || 'manual';
    var fee = isAr ? wireFee(p) : function () { return {}; };
    $('#px').onclick = close;
    $('#pgo').onclick = function () {
      var body = Object.assign({ side: side, name: $('#pn').value, frequency: $('#pf').value, start_date: $('#ps').value, due_days: $('#pd').value, end_date: $('#pe').value, max_runs: $('#pm').value,
        lines: ed.get(), gct_amount: $('#gct').value, pay_mode: isAr ? 'manual' : $('#ppm').value }, fee());
      if (isAr) body.customer_id = party.id;
      else if (!edit) { var s = typeof party === 'function' ? party($('#psup').value) : party; if (!s) return toast('Choose the supplier from the list'); body.supplier_id = s.id; }
      api(edit ? '/api/billing/plans/' + p.id : '/api/billing/plans', edit ? 'PUT' : 'POST', body)
        .then(function () { close(); toast(edit ? 'Saved: applies from the next period' : 'Saved: the first ' + (isAr ? 'invoice' : 'bill') + ' is raised on ' + body.start_date); if (done) done(); }).catch(function (e) { toast(e.message); });
    };
  }
  function planHistory(id) {
    api('/api/billing/plans/' + id).then(function (d) {
      modal('<h2>' + esc(d.plan.name) + ' · history</h2><table><thead><tr><th>Period</th><th>Document</th><th class="n">Amount</th><th>Raised</th></tr></thead><tbody>' +
        (d.runs.length ? d.runs.map(function (r) { return '<tr style="' + (r.voided_at ? 'opacity:.5' : '') + '"><td>' + esc(r.period) + '</td><td>' + esc(r.number || '') + (r.voided_at ? ' <span class="pill bad">void</span>' : '') + '</td><td class="n">' + J(r.total) + '</td><td><small>' + esc(B.dt(r.created_at)) + ' · ' + esc(r.by_name || 'automatic') + '</small></td></tr>'; }).join('') : '<tr><td colspan="4" class="empty">Nothing raised yet.</td></tr>') +
        '</tbody></table><div class="controls"><button id="hx">Close</button></div>');
      $('#hx').onclick = close;
    }).catch(function (e) { toast(e.message); });
  }
  // A list of plans into `el`; opts: { side, customer_id, supplier_id, onChange }.
  function planList(el, opts) {
    var qs = '?side=' + opts.side + (opts.customer_id ? '&customer_id=' + opts.customer_id : '') + (opts.supplier_id ? '&supplier_id=' + opts.supplier_id : '');
    var again = function () { planList(el, opts); if (opts.onChange) opts.onChange(); };
    return api('/api/billing/plans' + qs).then(function (d) {
      var ar = opts.side === 'ar', one = !!(opts.customer_id || opts.supplier_id);
      el.innerHTML = '<div class="scroll"><table><thead><tr><th>Plan</th>' + (one ? '' : '<th>' + (ar ? 'Customer' : 'Supplier') + '</th>') + '<th>How often</th><th class="n">Amount</th><th>Next</th><th>' + (ar ? 'Late fee' : 'Paid by') + '</th><th>Status</th><th></th></tr></thead><tbody>' +
        (d.plans.length ? d.plans.map(function (p) {
          return '<tr><td><b>' + esc(p.name) + '</b><br><small>' + p.runs + ' raised' + (p.last_run ? ', last ' + esc(p.last_run) : '') + '</small></td>' + (one ? '' : '<td>' + esc(p.party) + '</td>') +
            '<td>' + esc(FREQ[p.frequency]) + (p.due_days ? '<br><small>due in ' + p.due_days + ' d</small>' : '') + '</td><td class="n">' + J(p.amount) + '</td><td>' + esc(p.next_run || '') + '</td>' +
            '<td><small>' + esc(ar ? feeText(p) : p.pay_mode === 'standing_order' ? 'standing order' : 'we pay it') + '</small></td>' +
            '<td><span class="pill ' + (p.status === 'active' ? 'ok' : p.status === 'paused' ? 'warn' : '') + '">' + esc(p.status) + '</span>' + (p.status_reason ? '<br><small>' + esc(p.status_reason) + '</small>' : '') + '</td>' +
            '<td style="white-space:nowrap">' + (p.status !== 'ended' ? '<button class="sm" data-pe="' + p.id + '">Change</button> ' : '') +
            (p.status === 'active' ? '<button class="sm" data-pr="' + p.id + '">Run now</button> <button class="sm" data-pp="' + p.id + '">Pause</button> ' : '') +
            (p.status === 'paused' ? '<button class="sm" data-pa="' + p.id + '" data-next="' + esc(p.next_run || '') + '">Resume</button> ' : '') +
            (p.status !== 'ended' ? '<button class="sm" data-pend="' + p.id + '">End</button> ' : '') + '<button class="sm" data-ph="' + p.id + '">History</button></td></tr>';
        }).join('') : '<tr><td colspan="8" class="empty">No recurring ' + (ar ? 'invoices' : 'bills') + '.</td></tr>') + '</tbody></table></div>';
      var byId = function (id) { return d.plans.find(function (p) { return p.id === +id; }); };
      all('[data-pe]', el).forEach(function (b) { b.onclick = function () { var p = byId(b.getAttribute('data-pe')); planEditor(opts.side, p, { id: p.customer_id || p.supplier_id, name: p.party }, again); }; });
      all('[data-ph]', el).forEach(function (b) { b.onclick = function () { planHistory(b.getAttribute('data-ph')); }; });
      all('[data-pr]', el).forEach(function (b) { b.onclick = function () { api('/api/billing/plans/' + b.getAttribute('data-pr') + '/run', 'POST', {}).then(function (r) { toast(r.created ? r.created + ' raised' : 'Nothing is due yet'); again(); }).catch(function (e) { toast(e.message); }); }; });
      all('[data-pp]', el).forEach(function (b) { b.onclick = async function () { var r = await vasPrompt('Why pause it? (optional)', ''); if (r === null) return; api('/api/billing/plans/' + b.getAttribute('data-pp') + '/status', 'POST', { status: 'paused', reason: r }).then(again).catch(function (e) { toast(e.message); }); }; });
      all('[data-pend]', el).forEach(function (b) { b.onclick = async function () { if (!(await vasConfirm('End this plan? Nothing more will be raised from it.'))) return; api('/api/billing/plans/' + b.getAttribute('data-pend') + '/status', 'POST', { status: 'ended', reason: 'Ended by staff' }).then(again).catch(function (e) { toast(e.message); }); }; });
      all('[data-pa]', el).forEach(function (b) {
        b.onclick = async function () {
          var next = b.getAttribute('data-next'), behind = next && next < B.today();
          var skip = behind ? (await vasConfirm('Periods from ' + next + ' were not billed while it was paused.\n\nOK: skip those and start from the period running now.\nCancel: bill every missed period.')) : false;
          api('/api/billing/plans/' + b.getAttribute('data-pa') + '/status', 'POST', { status: 'active', skip_missed: skip }).then(function (r) { toast('Resumed; next ' + r.next_run); again(); }).catch(function (e) { toast(e.message); });
        };
      });
    }).catch(function (e) { el.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  }
  // Coming up in the next 30 days (loan instalments, recurring bills and invoices); kinds: 'loan', 'ap', 'ar'.
  function upcoming(el, kinds) {
    return api('/api/billing/upcoming?days=30').then(function (d) {
      var items = d.items.filter(function (x) { return kinds.indexOf(x.kind) >= 0; });
      el.innerHTML = items.length ? '<table><thead><tr><th>Date</th><th>What</th><th>Who</th><th class="n">Amount</th><th></th></tr></thead><tbody>' + items.map(function (x) {
        return '<tr><td>' + esc(x.due) + '</td><td>' + esc(x.name) + (x.kind === 'loan' ? ' <small>(instalment)</small>' : '') + '</td><td>' + esc(x.party) + '</td><td class="n">' + J(x.amount) + '</td><td>' + (x.kind !== 'ar' ? '<small>' + (x.pay_mode === 'standing_order' ? 'standing order' : 'we pay it') + '</small>' : '') + '</td></tr>';
      }).join('') + '</tbody></table>' : '<p class="sub">Nothing in the next 30 days.</p>';
    }).catch(function (e) { el.innerHTML = '<p class="sub">' + esc(e.message) + '</p>'; });
  }

  // ------------------------------------------------------------- loans --
  function loans(el, supplierByName) {
    return api('/api/loans').then(function (d) {
      el.innerHTML = '<div class="tiles"><div class="tile"><span class="k">Owed on loans</span><b>' + J(d.owed) + '</b></div><div class="tile"><span class="k">Loans Payable in the ledger</span><b>' + J(d.ledger_balance) + '</b></div></div>' +
        '<div class="card"><h2>Loans <button class="sm primary" id="lnew">Register a loan</button></h2><p class="sub">Money the business has borrowed. Each instalment becomes a bill from the lender on its due date (principal to Loans Payable, interest to Interest Expense); pay it with Pay bills.</p>' +
        '<div class="scroll"><table><thead><tr><th>Loan</th><th>Lender</th><th class="n">Borrowed</th><th class="n">Rate</th><th class="n">Balance</th><th>Next due</th><th class="n">Payment</th><th>Paid by</th><th>Status</th></tr></thead><tbody>' +
        (d.loans.length ? d.loans.map(function (l) { return '<tr data-l="' + l.id + '" class="click"><td><b>' + esc(l.name) + '</b>' + (l.reference ? '<br><small>' + esc(l.reference) + '</small>' : '') + (l.asset_number ? '<br><small>for ' + esc(l.asset_number) + '</small>' : '') + '</td><td>' + esc(l.lender) + '</td><td class="n">' + J(l.principal) + '</td><td class="n">' + l.annual_rate + '%</td><td class="n"><b>' + J(l.balance) + '</b></td><td>' + esc(l.next_due || '') + '</td><td class="n">' + (l.next_payment ? J(l.next_payment) : '') + '</td><td><small>' + (l.pay_mode === 'standing_order' ? 'standing order' : 'we pay it') + '</small></td><td><span class="pill ' + (l.status === 'active' ? 'ok' : '') + '">' + esc(l.status === 'paid' ? 'fully billed' : l.status) + '</span></td></tr>'; }).join('') : '<tr><td colspan="9" class="empty">No loans registered.</td></tr>') +
        '</tbody></table></div></div><div class="card"><h2>Coming up (30 days)</h2><div id="lup"></div></div>';
      upcoming($('#lup'), ['loan']);
      $('#lnew').onclick = function () { newLoan(supplierByName, function () { loans(el, supplierByName); }); };
      all('[data-l]', el).forEach(function (r) { r.onclick = function () { loanDetail(el, +r.getAttribute('data-l'), supplierByName); }; });
    });
  }
  function newLoan(supplierByName, done) {
    modal('<h2>Register a loan</h2><p class="sub">The lender is a supplier (add them on the Suppliers screen first). For a loan already running, enter today\'s balance, the instalments left and the next due date, and choose "already in the books".</p>' +
      '<div class="controls"><div style="flex:1"><label>Name</label><input id="ln" placeholder="NCB business loan" style="width:100%"></div><div><label>Lender</label><input id="lsup" list="suppliers" style="width:220px"></div><div><label>Loan / account no.</label><input id="lref" style="width:130px"></div></div>' +
      '<div class="controls"><div><label>Amount (J$)</label><input id="lp" type="number" step="0.01" style="width:140px"></div><div><label>Interest (% a year)</label><input id="lr" type="number" step="0.01" style="width:90px"></div>' +
      '<div><label>Instalments</label><input id="lk" type="number" value="12" style="width:70px"></div><div><label>How often</label><select id="lf">' + freqOptions('monthly') + '</select></div>' +
      '<div><label>Repayment</label><select id="lm">' + Object.keys(METHOD).map(function (k) { return '<option value="' + k + '">' + METHOD[k] + '</option>'; }).join('') + '</select></div></div>' +
      '<div class="controls"><div><label>Money received on</label><input id="lsd" type="date" value="' + B.today() + '"></div><div><label>First instalment due</label><input id="lfd" type="date"></div>' +
      '<div><label>Paid by</label><select id="lpm"><option value="manual">Paying it ourselves (email a reminder)</option><option value="standing_order">Standing order (the bank takes it)</option></select></div></div>' +
      '<div class="controls"><div><label>The money</label><select id="lrc"><option value="deposit">Record it as a deposit into…</option><option value="existing">Already in the books (nothing to record)</option></select></div><div id="ldepw"><label>Bank account</label><select id="ldep">' + B.accountOptions('bankonly') + '</select></div>' +
        '<div><label>For an asset (bought with it / secured on it)</label><select id="lfa" style="max-width:240px" title="The interest then shows as a running cost of the asset, and the net worth report shows what the business has in it after the loan">' + B.assetOptions('') + '</select></div></div>' +
      '<div class="controls"><button id="lpv">Show the schedule</button><button class="primary" id="lgo">Register</button><button id="lx">Cancel</button></div><div id="lsched"></div>');
    $('#lrc').onchange = function () { $('#ldepw').style.display = this.value === 'deposit' ? '' : 'none'; };
    var body = function () { var s = supplierByName($('#lsup').value); return { name: $('#ln').value, supplier_id: s && s.id, reference: $('#lref').value, principal: $('#lp').value, annual_rate: $('#lr').value, instalments: $('#lk').value, frequency: $('#lf').value, method: $('#lm').value, start_date: $('#lsd').value, first_due: $('#lfd').value, pay_mode: $('#lpm').value, received: $('#lrc').value, deposit_account_id: $('#ldep').value, asset_id: $('#lfa').value }; };
    $('#lx').onclick = close;
    $('#lpv').onclick = function () {
      api('/api/loans/preview', 'POST', body()).then(function (d) {
        $('#lsched').innerHTML = '<p class="sub">Total repaid ' + J(d.totals.payments) + ', of which interest ' + J(d.totals.interest) + '.</p><div class="scroll" style="max-height:35vh"><table><thead><tr><th>#</th><th>Due</th><th class="n">Payment</th><th class="n">Principal</th><th class="n">Interest</th><th class="n">Balance after</th></tr></thead><tbody>' +
          d.schedule.map(function (r) { return '<tr><td>' + r.n + '</td><td>' + esc(r.due_date) + '</td><td class="n">' + J(r.payment) + '</td><td class="n">' + J(r.principal) + '</td><td class="n">' + J(r.interest) + '</td><td class="n">' + J(r.closing) + '</td></tr>'; }).join('') + '</tbody></table></div>';
      }).catch(function (e) { toast(e.message); });
    };
    $('#lgo').onclick = function () {
      var b = body(); if (!b.supplier_id) return toast('Choose the lender from the supplier list');
      api('/api/loans', 'POST', b).then(function () { close(); toast('Loan registered'); if (done) done(); }).catch(function (e) { toast(e.message); });
    };
  }
  function loanDetail(el, id, supplierByName) {
    return api('/api/loans/' + id).then(function (d) {
      var l = d.loan, back = function () { loans(el, supplierByName); }, again = function () { loanDetail(el, id, supplierByName); };
      el.innerHTML = '<div class="controls"><button id="lbk">◀ All loans</button></div><div class="card"><h2>' + esc(l.name) + ' <span class="pill">' + esc(l.status === 'paid' ? 'fully billed' : l.status) + '</span></h2>' +
        '<p class="sub">' + esc(l.lender) + (l.reference ? ' · ' + esc(l.reference) : '') + ' · ' + J(l.principal) + ' at ' + l.annual_rate + '% · ' + esc(METHOD[l.method]) + ' · ' + esc(FREQ[l.frequency]) + ' · ' + (l.pay_mode === 'standing_order' ? 'standing order' : 'we pay it') + ' · received ' + esc(l.start_date) + (l.asset ? ' · for <a href="/assets.html" target="_blank" rel="noopener">' + esc(l.asset) + '</a>' : '') + '</p>' +
        '<div class="tiles"><div class="tile"><span class="k">Balance</span><b>' + J(l.balance) + '</b></div><div class="tile"><span class="k">Principal billed</span><b>' + J(l.principal_billed) + '</b></div><div class="tile"><span class="k">Interest billed</span><b>' + J(l.interest_billed) + '</b></div></div>' +
        (l.status === 'active' ? '<div class="controls"><button id="lex">Pay extra off the principal</button><button id="lrs">Change rate / instalments</button><button id="lcn">Cancel loan</button></div>' : '') + '</div>' +
        '<div class="card"><h2>Schedule</h2><div class="scroll"><table><thead><tr><th>#</th><th>Due</th><th class="n">Payment</th><th class="n">Principal</th><th class="n">Interest</th><th class="n">Balance after</th><th>Bill</th><th></th></tr></thead><tbody>' +
        d.instalments.map(function (r) { return '<tr><td>' + (r.kind === 'extra' ? 'extra' : r.n) + '</td><td>' + esc(r.due_date) + '</td><td class="n">' + J(r.payment) + '</td><td class="n">' + J(r.principal) + '</td><td class="n">' + J(r.interest) + '</td><td class="n">' + J(r.closing) + '</td>' +
          '<td>' + esc(r.bill_number || '') + ' <span class="pill ' + (STATE[r.state] || '') + '">' + esc(r.state) + '</span></td><td>' + (r.state === 'upcoming' ? '<button class="sm" data-bn="' + r.id + '">Bill now</button>' : r.state === 'bill voided' ? '<button class="sm" data-rb="' + r.id + '">Bill again</button>' : '') + '</td></tr>'; }).join('') +
        '</tbody></table></div></div>';
      $('#lbk').onclick = back;
      all('[data-bn]').forEach(function (b) { b.onclick = async function () { if (!(await vasConfirm('Raise the bill for this instalment now (before its due date)?'))) return; api('/api/loans/' + id + '/instalments/' + b.getAttribute('data-bn') + '/bill', 'POST', {}).then(again).catch(function (e) { toast(e.message); }); }; });
      all('[data-rb]').forEach(function (b) { b.onclick = function () { api('/api/loans/' + id + '/instalments/' + b.getAttribute('data-rb') + '/rebill', 'POST', {}).then(again).catch(function (e) { toast(e.message); }); }; });
      if (l.status !== 'active') return;
      $('#lex').onclick = async function () { var a = await vasPrompt('How much extra is being paid off the principal? (J$)'); if (!a) return; api('/api/loans/' + id + '/extra', 'POST', { amount: a, date: B.today() }).then(function () { toast('Billed; the instalments left are re-worked'); again(); }).catch(function (e) { toast(e.message); }); };
      $('#lrs').onclick = async function () {
        var r = await vasPrompt('New interest rate (% a year), blank to keep ' + l.annual_rate + '%', ''); if (r === null) return;
        var k = await vasPrompt('Instalments left (blank to keep)', ''); if (k === null) return;
        api('/api/loans/' + id + '/reschedule', 'POST', { annual_rate: r, instalments: k }).then(function (x) { toast(x.instalments + ' instalments re-worked'); again(); }).catch(function (e) { toast(e.message); });
      };
      $('#lcn').onclick = async function () { var r = await vasPrompt('Why is the loan cancelled?'); if (!r) return; api('/api/loans/' + id + '/cancel', 'POST', { reason: r }).then(function (x) { toast(x.note || 'Cancelled'); back(); }).catch(function (e) { toast(e.message); }); };
    });
  }

  window.BillingUI = { newInvoice: newInvoice, voidInvoice: voidInvoice, billingSettings: billingSettings, planEditor: planEditor, planList: planList, upcoming: upcoming, loans: loans };
})();
