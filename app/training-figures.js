'use strict';
// =============================================================================
//  Vision Auto Solutions -- pictures in the training lessons
//
//  Screenshots of the real screens (taken on a test till, test data only) and
//  drawn examples, in /assets/training. They are kept here rather than in the
//  lesson text so a manager's edits never lose them and the staff assistant
//  still reads plain text.
//
//  Each picture goes after the first paragraph that starts with `after`
//  (ignoring case); if a manager has reworded that paragraph it goes at the
//  end of the lesson instead. `phone`: a phone-shaped screenshot, shown narrow.
// =============================================================================
const P = (src, title, caption, after, more) => Object.assign({ src: '/assets/training/' + src, kind: src.endsWith('.svg') ? 'example' : 'screen', title, caption, after }, more);

const FIGURES = {
  'getting-around': [
    P('admin-home.webp', 'Admin: the dashboard', 'The menu on the left opens every part of the system; the dashboard shows today\'s sales and what needs attention.', 'The menu'),
    P('mobile-home.webp', 'Mobile app home screen', 'On a phone the same work is laid out as big tiles.', 'Phones and tablets', { phone: true }),
    P('training.webp', 'Training: My training', 'Your lessons, which are required for your role, and how far you have got.', 'Your training record'),
  ],
  'pos-sale': [
    P('ex-fits-check.svg', 'Checking the fit', 'Compare the part\'s "fits" line with the customer\'s vehicle, item by item, before you sell.', 'Find the part'),
    P('pos-till.webp', 'The POS terminal with one part rung up', 'Search box across the top of the cart, the running total with GCT at the top right, CHECKOUT (F9), QUOTE and CLEAR along the bottom.', 'Quantities'),
    P('ex-change.svg', 'Taking cash and giving change', 'A J$4,350 sale paid with J$5,000: the till shows J$650 change, and you count it back.', 'Payment'),
  ],
  'returns': [
    P('ex-return-grades.svg', 'Grades A, B and C', 'What each grade looks like and what happens to the part.', 'Returned parts go back'),
    P('returns-grade.webp', 'Stock to cash: Returns to grade', 'Every returned part waits here until someone grades it.', 'Returned parts go back'),
  ],
  'drawer': [
    P('cash-drawer.webp', 'Cash drawer: the open session', 'Opening float, payouts recorded against this session, and the closing count.', 'Payouts and cash taken out'),
    P('ex-drawer-close.svg', 'A closing count that is J$500 short', 'Count by note and coin, enter the real total; the till records the difference against your drawer.', 'Close at the end of your shift'),
  ],
  'timeclock': [
    P('time-clock.webp', 'The time clock', 'Clock in and out, Break, Lunch and Back, with PIN, badge, fingerprint / face or email.', 'Clock in at the time clock'),
    P('ex-shift-day.svg', 'A day on the time clock', 'One shift, every press of the clock in order, and when the till warns you.', 'Breaks and lunch'),
    P('my-time.webp', 'My time', 'Clock in from your phone, log extra time, see your clock-ins and ask for a correction.', 'Worked on after that'),
  ],
  'customers': [
    P('customers.webp', 'The customer list', 'Search by name, phone, company or account number; open a customer to see their details and consent.', 'Ask before you save'),
  ],
  'receiving': [
    P('ex-receiving.svg', 'Receiving against the order', 'Receive what you counted, record shortages, and keep damaged goods for the claim.', 'Receive against the purchase order'),
    P('purchase-orders.webp', 'Purchase orders', 'Orders to suppliers, with what has been received so far.', 'Two ways to receive'),
  ],
  'counts': [
    P('warehouse-count.webp', 'Warehouse app: Count', 'Start a count for the bins due, then scan the bin and every part on that shelf.', 'Counts are blind'),
    P('ex-blind-count.svg', 'A blind count, start to finish', 'Count, recount when the difference is big, then a manager approves.', 'Big differences'),
  ],
  'clearance': [
    P('returns-grade.webp', 'Stock to cash', 'Overview, stock lists, returns to grade, damaged and claims, lots and campaigns.', 'Stock to cash shows parts'),
  ],
  'ai-assistant': [
    P('ai-assistant.webp', 'AI parts assistant', 'Conversations the assistant has had, hand-overs to staff, usage and settings.', 'Hand-overs'),
  ],
  'quotes-orders': [
    P('ex-quote-flow.svg', 'From cart to payment', 'A quote waits for the customer; a counter order waits at the cashier.', 'Making a quote'),
    P('cashier-queue.webp', 'The Cashier page', 'Orders due for payment on the left; open one and take payment.', 'The cashier queue'),
  ],
  'parts-stock': [
    P('products.webp', 'Parts', 'Search parts by number, name or vehicle; stock, bin and price on each line.', 'Finding a part'),
    P('low-stock.webp', 'Low stock', 'Parts at or below their reorder level, with a box to restock.', 'Low stock'),
    P('suppliers.webp', 'Suppliers', 'Contacts, terms and lead time for each supplier.', 'Suppliers'),
  ],
  'purchasing': [
    P('purchase-orders.webp', 'Purchase orders', 'Each order\'s supplier, total and status (partly received here).', 'Purchase orders'),
    P('ex-receiving.svg', 'Tallying a delivery', 'What was ordered, what the paperwork says and what you counted.', 'Receive Stock step 4'),
  ],
  'warehouse-mobile': [
    P('warehouse-count.webp', 'The Warehouse app', 'Scan box at the top; tabs for orders, put away, receive, count, bins and labels.', 'The Warehouse app'),
    P('mobile-home.webp', 'The Mobile app', 'Big tiles for each job: count, pick, put away, receive, driver, clock, cashier.', 'The Mobile app', { phone: true }),
  ],
  'customer-records': [
    P('customers.webp', 'The customer list', 'Filter online sign-ups, counter customers, staff and archived.', 'The customer list'),
  ],
  'cash-office': [
    P('cash-drawer.webp', 'Cash report', 'The open drawer session, payouts and the closing count.', 'Cash report'),
  ],
  'receivables': [
    P('receivables.webp', 'Customers & receivables', 'Open invoices, what is overdue and unapplied credit, customer by customer.', 'Customer centre'),
  ],
  'payables-banking': [
    P('payables.webp', 'Suppliers & payables', 'Unpaid and overdue bills by supplier, with the next due date.', 'Payables'),
    P('banking.webp', 'Banking', 'One card per bank account, with statement lines still to review.', 'Banking'),
  ],
  'loans-rent': [
    P('loans-rent.webp', 'Loans, rent & recurring billing', 'Every agreement with what is due next and what is overdue.', 'The Loans & Rent page'),
  ],
  'accounting': [
    P('accounting.webp', 'Accounting: overview and tie-out', 'The ledger against the system\'s own records; a difference means something moved outside the posting rules.', 'Overview and tie-out'),
  ],
  'budget-forecast': [
    P('budget.webp', 'Budget & forecast', 'The budget by account and month; tabs for the forecasts, break-even, ROI and the health report.', 'The budget'),
  ],
  'reports-planning': [
    P('reports.webp', 'Reports', 'Report groups on the left, each report as a card.', 'Reports'),
    P('planning.webp', 'Planning', 'What needs attention, sales and profit, and whether we had what customers asked for.', 'Planning and lost sales'),
  ],
  'people': [
    P('staff.webp', 'Manage users', 'Everyone who works here, their role, till PIN and status.', 'Manage users'),
    P('roles.webp', 'Roles', 'Each role\'s screens and whether it clears the manager bar.', 'Roles and permissions'),
  ],
  'delivery-drivers': [
    P('dispatch.webp', 'Dispatch: the live board', 'The queue of jobs, drivers on shift and the live map.', 'Dispatch'),
    P('driver-phone.webp', 'The driver app', 'Start a shift with the vehicle and odometer; SOS at the top right.', 'The driver app', { phone: true }),
  ],
  'team-chat': [
    P('team-chat.webp', 'Team chat', 'Chats on the left, with the 🚨 alarm, 📢 announcement and group buttons at the top.', 'The chat button'),
    P('emergency-alarm.webp', 'An emergency alarm on a phone', 'Everyone sees this until they answer: I\'m safe, On my way to help, or I need help.', 'Emergency alarm', { phone: true }),
    P('emergency-bar.webp', 'After you answer', 'A red bar stays at the top with the counts, Roll call and All clear.', 'Emergency alarm'),
  ],
  'documents-forms': [
    P('documents.webp', 'Documents: forms and templates', 'Fill in a form; the ones that need approval go to a manager.', 'Forms and leave'),
  ],
  'stores-suppliers': [
    P('stores.webp', 'Stores and branches', 'Each store with its departments, tills and stock.', 'Stores and branches'),
    P('supplier-portal.webp', 'Supplier management', 'Give a supplier a portal login and set their credit limit.', 'Supplier management'),
  ],
  'settings-security': [
    P('system.webp', 'System management', 'Security score, threats, audit exceptions and the problems to fix.', 'System management'),
  ],
};

// Where each picture goes: the index of the paragraph it follows (-1: the end).
function place(body, figs) {
  const paras = String(body || '').split(/\n\s*\n/).map((t) => t.trim().toLowerCase());
  return (figs || []).map((f) => {
    const i = f.after ? paras.findIndex((t) => t.startsWith(f.after.toLowerCase())) : -1;
    return { src: f.src, kind: f.kind, title: f.title, caption: f.caption, phone: !!f.phone, after: i };
  });
}
const figuresFor = (m) => place(m.body, FIGURES[m.key]);
// The first screenshot, for the lesson's card.
const coverFor = (key) => { const f = (FIGURES[key] || []).find((x) => x.kind === 'screen' && !x.phone) || (FIGURES[key] || [])[0]; return f ? f.src : null; };

module.exports = { FIGURES, figuresFor, coverFor };
