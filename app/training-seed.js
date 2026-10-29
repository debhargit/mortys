'use strict';
// =============================================================================
//  Starter training content (Phase 10c). Loaded once: a module is only added
//  when its key is missing, so managers' own edits are never overwritten.
//  Lessons are plain text; the staff assistant answers "how do I..." from them.
// =============================================================================
const MODULES = [
  {
    key: 'pos-sale', title: 'Selling at the till', sort: 10, practice: true,
    summary: 'Finding the right part, the customer, taking payment and giving change.',
    body: `Find the part: scan its barcode, or search by part number, name or vehicle. Before you sell, read the "fits" line on the part and check it covers the customer's vehicle (make, model, year, engine). If it does not clearly fit, say so and check with a senior colleague - a wrong part costs the shop a return.

Quantities: add the part once and change the quantity, or scan it again.

The customer: attach the customer to the sale. Search by name, phone or account number. Use the walk-in customer only when the person does not want to be recorded. Account (charge) sales are only for customers with an account and only if your role allows it.

Prices and discounts: sell at the price the till shows. Line and whole-ticket discounts, price changes and switching GCT off are only possible if your role allows them; otherwise a manager approves with their PIN. Never invent a discount to close a sale.

Departments: if a part belongs to another department's range, the till asks for a manager PIN. The override is recorded.

Payment: choose the method. For cash, type what the customer hands you; the till shows the change - count it back to them. A sale can be split, for example part cash and the rest by card. Never write down or repeat a customer's card number.

Cashier stations: in shops with a separate cashier, "Send to cashier" puts the order in the cashier queue; tell the customer the order number and to pay at the cashier.

Being clocked in: when the shop has switched on the rule, only staff clocked in at the shop, inside their shift or approved overtime, can take money.

Every sale prints or emails a receipt. Tell the customer that returns need the receipt.

Hold and recall: Hold (F7) parks the cart so you can serve someone else; Recall (F8) brings it back. New starts a fresh ticket. Checkout is F9.

Quote instead of sale: QUOTE saves the cart as a quote without taking money. It is listed under Sales & POS > Quotes, and can be turned into a sale later.

Part not in stock: press "Lost sale" and record what the customer asked for and how to call them back. Purchasing sees it on the Planning > Lost sales list and the call-back list.

Taking over a till: PIN lets you take over this till with your own PIN, so the sale is recorded under you. Never sell under someone else's name.

Cart tools: the comment button adds a note that prints on the invoice; the eye button (cart preview) can tag, email or print the cart. Payment methods are Cash, Card, Cheque, Bank, Gift card and Account (Account only with that permission and a real customer on the sale).`,
    questions: [
      ['A customer asks for front brake pads for a 2012 Corolla. What do you check before selling?', ['The price only', 'That the "fits" line covers the customer\'s vehicle', 'That the box is red', 'Nothing - pads fit every car'], 1, 'Always check the "fits" line against the make, model and year.'],
      ['The total is J$4,350 and the customer hands you J$5,000 cash. How much change?', ['J$350', 'J$650', 'J$750', 'J$1,350'], 1, '5,000 - 4,350 = 650. Count it back to the customer.'],
      ['Your role does not allow discounts and a customer insists on 10% off. What do you do?', ['Give it anyway', 'Change the price to match', 'Ask a manager, who can approve with their PIN', 'Tell the customer to come back tomorrow'], 2, 'Discounts beyond your role need a manager\'s approval; it is recorded.'],
      ['When should you use the walk-in customer?', ['Always', 'Only when the person does not want to be recorded', 'For account customers', 'For large sales'], 1, 'Attach real customers so returns, warranty and history work.'],
      ['A customer reads their card number to you so you can "type it in". What do you do?', ['Write it down', 'Type it into the notes', 'Stop them: card payments go through the card machine or a secure link only', 'Repeat it back to confirm'], 2, 'Never write down, store or repeat a card number.'],
    ],
  },
  {
    key: 'returns', title: 'Returns, refunds and grading', sort: 20,
    summary: 'Taking a return, the refund, and grading what came back.',
    body: `Returns policy: returns are accepted within 14 days with the original receipt, in original condition. Electrical parts are not returnable. Check the shop's current notice on the receipt.

Taking a return: find the sale from the receipt number and return only the lines and quantities that came back. Refunds need the refund permission; if you do not have it, call a manager. Choose the refund method the policy allows (normally the way they paid, or store credit).

Returned parts go back into stock at the refund. Then the part must be checked and graded in Stock to cash > Returns to grade:
- A: as new, sealed, nothing missing - it stays in normal stock.
- B: opened, box marked or used for a test fit but sound - it moves to an "open box" copy of the part at a lower price.
- C: not sellable - written off, or, if it is faulty from the supplier, claimed from the supplier.

Grade honestly: an A that is really a B gets sold as new and comes back again.

Faulty parts: record why it failed. A supplier claim needs the part kept and labelled until the supplier answers.`,
    questions: [
      ['Within how many days are returns normally accepted (with the receipt)?', ['7', '14', '30', '90'], 1, 'Fourteen days with the original receipt, in original condition.'],
      ['Which parts are not returnable?', ['Filters', 'Electrical parts', 'Brake pads', 'Wipers'], 1, 'Electrical parts are non-returnable.'],
      ['A returned part was opened and the box is torn, but the part is fine. Which grade?', ['A', 'B', 'C', 'No grade needed'], 1, 'B: sound but opened - it is sold as open box at a lower price.'],
      ['A part failed and it is the supplier\'s fault. What happens after grading C?', ['Throw it away', 'Put it back on the shelf', 'Claim it from the supplier and keep the part labelled', 'Give it to the customer'], 2, 'Supplier claims need the part kept until the supplier answers.'],
      ['You do not have the refund permission. A customer wants a refund. What do you do?', ['Refund anyway', 'Call a manager', 'Tell them refunds are impossible', 'Give store credit without recording it'], 1, 'Refunds need the permission; a manager does it.'],
    ],
  },
  {
    key: 'drawer', title: 'Cash drawer and shift', sort: 30,
    summary: 'Opening float, payouts, closing count and over / short.',
    body: `Open your drawer at the start of your shift: count the float with the person handing it over and enter the amount. The drawer is yours - never let someone else use it, and never use someone else's.

Payouts and cash taken out (for example petty expenses or a drop to the safe) are recorded in the till with a reason. No cash leaves the drawer without being recorded.

Close at the end of your shift: count the cash by note and coin and enter it. The till shows the expected amount; the difference is recorded as over or short. Do not "fix" a difference with your own money or by taking from it - report it.

Your drawer must be closed or handed over before you clock out. The time clock will not clock you out automatically while your drawer is still open, and it flags this to the manager.`,
    questions: [
      ['Can a colleague take payment on your open drawer while you are on lunch?', ['Yes, if they are quick', 'No - each person uses only their own drawer', 'Yes, if the manager is out', 'Only for card payments'], 1, 'One drawer, one person: it keeps the count honest.'],
      ['You need J$2,000 from the drawer for an urgent courier. What must happen?', ['Take it and tell someone later', 'Record a payout with the reason in the till', 'Use your own money', 'Take it from the next sale'], 1, 'Every cash movement is recorded with a reason.'],
      ['At closing you are J$500 short. What do you do?', ['Add J$500 of your own', 'Enter the real count; the shortage is recorded and reported', 'Count again until it matches', 'Take J$500 from tomorrow\'s float'], 1, 'Enter the real count. Differences are recorded, never hidden.'],
      ['Can you clock out with your drawer still open?', ['Yes', 'No - close it or hand it over first', 'Only on Fridays', 'Only if it is short'], 1, 'Close or hand over the drawer before you clock out.'],
    ],
  },
  {
    key: 'timeclock', title: 'Time clock and shifts', sort: 40,
    summary: 'Clocking in and out, breaks, overtime and corrections.',
    body: `Clock in at the time clock when you start, with your PIN, badge, fingerprint / face or email and password - whichever your manager set for you. Your badge and PIN are yours alone: clocking in for someone else is not allowed and photos may be taken.

Breaks and lunch: press Break or Lunch when you go and "Back from break" when you return.

Outside your shift: clocking in early or late, or on a day off, counts as overtime. The clock asks you to confirm and give the reason; a manager approves or rejects it. Unapproved overtime is not paid.

End of shift: the till warns you 15 and 5 minutes before your shift ends. If you need more time (for example a customer is still at the counter), press "Ask for more time" and give the reason; a manager is asked by email. At the end of your shift you are clocked out and signed out automatically, unless your drawer is still open.

Forgot to clock in or out? Ask for a correction with the right times and the reason. A manager approves it and the original record is kept.`,
    questions: [
      ['You arrive 2 hours before your shift to help with a delivery. What happens when you clock in?', ['Nothing special', 'You confirm overtime with a reason; a manager approves it', 'You cannot clock in', 'You are marked absent'], 1, 'Outside the shift needs an overtime confirmation and approval.'],
      ['A colleague asks you to clock them in with your badge. What do you do?', ['Do it', 'Refuse - badges and PINs are personal', 'Do it only once', 'Use their PIN instead'], 1, 'Clocking in for someone else is not allowed.'],
      ['Your shift ends in 5 minutes and a customer still needs help. What do you do?', ['Leave', 'Press "Ask for more time" with the reason', 'Clock out and keep working', 'Ignore the warning'], 1, 'Ask for more time; a manager approves it.'],
      ['You forgot to clock out yesterday. What do you do?', ['Nothing', 'Ask for a correction with the right time and the reason', 'Clock out twice today', 'Tell a colleague'], 1, 'Corrections are approved by a manager and the original is kept.'],
    ],
  },
  {
    key: 'customers', title: 'Customer details and consent', sort: 50,
    summary: 'Saving customers, offers consent and keeping data safe.',
    body: `Ask before you save: "May I save your name and phone number so we can find your purchases?" Save only what the customer agrees to.

Offers are a separate question. Ask "Would you like our offers by text?" and "by email?" separately and tick only what they say yes to. Never tick it for them. Everyone who receives offers can unsubscribe with the link in each message, and the system records it.

Customer details are only for serving that customer: do not share them, read them out to other customers, or copy them to personal phones. Jamaica's Data Protection Act applies.

Never write down, store or repeat card numbers - not on paper, in notes, in chat or by phone. Card payments go through the card machine or a secure payment link.

Vehicle: saving the customer's vehicle (make, model, year) helps the next sale and fitment checks.`,
    questions: [
      ['A customer agrees to be saved but says nothing about offers. Do you tick "offers by text"?', ['Yes, everyone wants offers', 'No - ask separately and tick only if they say yes', 'Yes, they can unsubscribe later', 'Only for trade customers'], 1, 'Offers consent is its own yes.'],
      ['Another customer asks for a friend\'s phone number from the system. What do you do?', ['Give it', 'Refuse - customer details are not shared', 'Give only the last digits', 'Ask the manager to give it'], 1, 'Customer data is only for serving that customer.'],
      ['Where may a card number be written down?', ['In the sale notes', 'On the receipt', 'Nowhere', 'In the customer record'], 2, 'Never store card numbers anywhere.'],
      ['Why save the customer\'s vehicle?', ['It is required by law', 'It helps fitment checks and future sales', 'To send offers', 'It is not useful'], 1, 'Vehicle details make the next part search faster and safer.'],
    ],
  },
  {
    key: 'receiving', title: 'Receiving and putaway', sort: 60,
    summary: 'Checking deliveries against the order, damage, labels and putaway.',
    body: `Two ways to receive: in the office, use Purchasing > Receive Stock (the delivery and the supplier's bill together, see the Purchasing lesson). On the warehouse floor, use the Warehouse app's Receive tab or the Mobile app's Receive tile, which scans goods into the RECEIVING bin for putaway.

Receive against the purchase order: open the order and scan each item. Count what actually arrived; never receive what you did not count. Short or extra items are recorded on the receipt.

Damaged on arrival: do not put it on the shelf. Mark the units damaged (sell cheaper) or claim them from the supplier in Stock to cash, and keep the damaged goods and packaging for the claim. Take a photo if you can.

Labels: print item labels for anything without a readable barcode.

Putaway: scan the bin, then the items you put there. Stock must be where the system says it is - pickers rely on it.`,
    questions: [
      ['The delivery note says 10 but you counted 8. What do you receive?', ['10', '8, and record the shortage', 'Nothing', '9'], 1, 'Receive what you counted; the shortage is recorded.'],
      ['Two units arrived broken. What do you do?', ['Shelve them anyway', 'Mark them damaged or claim them from the supplier, and keep them', 'Throw them away', 'Sell them as new'], 1, 'Keep damaged goods for the claim and mark them in Stock to cash.'],
      ['Why scan the bin during putaway?', ['It is optional', 'So the system knows where the stock is for picking', 'To print a label', 'To change the price'], 1, 'Pickers go to the bin the system shows.'],
    ],
  },
  {
    key: 'counts', title: 'Stock counts', sort: 70,
    summary: 'Blind counts, recounts and approvals.',
    body: `Counts are blind: you do not see how many the system expects. Count exactly what is in the bin, including opened boxes, and scan or type it.

Big differences are sent for a recount by another person. A manager approves the final adjustment; nobody adjusts stock without a count.

Count A items (the fast, valuable ones) most often. Do not move stock between bins in the middle of a count.`,
    questions: [
      ['During a blind count, can you see the expected quantity?', ['Yes', 'No', 'Only for A items', 'Only managers'], 1, 'Blind counts keep the count honest.'],
      ['Your count is far from what the system had. What happens?', ['You change it to match', 'A recount by another person, then a manager approves', 'Nothing', 'You delete the part'], 1, 'Recount, then manager approval.'],
      ['Can stock be adjusted without a count?', ['Yes, if you are sure', 'No', 'Only on Mondays', 'Only by cashiers'], 1, 'Adjustments come from counts and are approved.'],
    ],
  },
  {
    key: 'clearance', title: 'Clearance, open box and slow stock', sort: 80, roles: ['owner', 'manager'],
    summary: 'The clearance ladder, open-box copies, lots and offers.',
    body: `Stock to cash shows parts that are not selling: overstock, aged (no sale for 6 to 12 months), dead (a year or more), discontinued, open box and damaged.

Clearance ladder: each step takes a set percentage off the regular price (10%, then 20%, then 30% by default). Prices never go below cost unless a manager confirms it, and ending clearance puts the regular price back.

Open box and damaged units are separate copies of the part with their own lower price, so they sell normally at the till and online.

Dead stock: make a liquidation lot for a buyer (sold through the cashier), list it on a marketplace, or ask the supplier to take it back.

Offer campaigns go only to customers who said yes to offers, and every message has an unsubscribe link.`,
    questions: [
      ['Clearance would take a part below its cost. What happens?', ['It happens automatically', 'It is refused unless a manager confirms', 'The price goes to zero', 'The part is deleted'], 1, 'Below-cost clearance needs confirmation.'],
      ['How is an open-box unit sold?', ['As new at full price', 'As its own copy of the part at a lower price', 'It cannot be sold', 'Only in a lot'], 1, 'Open-box copies have their own price and sell normally.'],
      ['Who receives an offer campaign?', ['Every customer', 'Only customers who said yes to offers on that channel', 'Staff', 'Suppliers'], 1, 'Consent first; every message can unsubscribe.'],
    ],
  },
  {
    key: 'ai-assistant', title: 'Working with the AI assistant', sort: 90, roles: ['owner', 'manager', 'cashier'],
    summary: 'What the website, kiosk and phone assistant does, and taking over from it.',
    body: `The parts assistant answers customers on the website chat, the counter kiosk, WhatsApp and the phone. It finds parts, quotes catalogue prices, saves a customer only when they say yes, puts orders in the cashier queue and records lost sales.

It cannot give discounts, change prices, take payments or accept card numbers, and it says it is automated.

Hand-overs: when a customer asks for a person, is unhappy, the order is large or the assistant is unsure, the conversation waits for a person on the AI assistant page (and managers get an email). Open it, read what happened, and reply - your reply appears in the customer's chat or WhatsApp. Give it back to the assistant or close it when done. For phone calls marked "call back", phone the customer.

Orders from the assistant appear in the cashier queue like any other order; check the part fits before handing it over.`,
    questions: [
      ['A chat says "needs a person". What do you do?', ['Ignore it', 'Open it on the AI assistant page, read it and reply', 'Delete it', 'Wait for the assistant'], 1, 'Read the conversation, then reply to the customer.'],
      ['Can the assistant give a customer a discount?', ['Yes, up to 10%', 'No', 'Only online', 'Only on clearance'], 1, 'It sells at catalogue prices only.'],
      ['A phone call is marked "call back". What do you do?', ['Nothing', 'Phone the customer back', 'Send an email', 'Close it'], 1, 'Call-backs are promised to the caller.'],
    ],
  },

  // ---------------------------------------------------------------------------
  //  The rest of the system, one lesson per area (2026-10). Each paragraph is
  //  written to stand alone: the Help button shows single paragraphs.
  // ---------------------------------------------------------------------------
  {
    key: 'getting-around', title: 'Getting around the system', sort: 5,
    summary: 'Signing in, the menu, pinned screens, your preferences, phones and the Help button.',
    body: `Signing in: open the admin page on the till (or visionautosolutions.com/admin on the website) and sign in with your email and password, or press "Sign in with PIN" at a shared counter. Your password and PIN are yours alone. Sign out when you leave a shared till.

2-step sign-in: if your manager has switched it on, after the password you type the 6-digit code from the authenticator app on your phone. Set it up under All modules > Security and audit log > My sign-in. Keep the recovery codes somewhere safe.

The menu: the left-hand menu has the groups Overview, Parts Department, Purchasing, Sales & POS, POS Add-ons, Customers and Settings. Click a group to open it; only one stays open at a time. What you see depends on your role: a screen you cannot see is one your role does not allow.

All modules: Overview > All modules shows a tile for every other part of the system - Accounting, Budget & forecast, Receivables, Payables, Banking, Loans & Rent, Payroll, Time clock, Attendance, Commission, Training, Hiring, Dispatch, Driver app, Mobile app, Warehouse, Stock to cash, Planning, Documents, Customer messages, Department store, Supplier management, System management and Security.

Pinned screens: press the star beside a menu item to pin it under Favourites at the top of the menu. A manager can set the pinned screens for a role; then you cannot change them.

My preferences: Settings > My Preferences holds your theme (light or dark), whether the menu starts collapsed, the screen you land on after signing in, and the till's product view and text size. They are saved against you, not the computer, so they follow you to any till.

Phones and tablets: the admin works on a phone. Tap the menu button at the top left to open the menu. Long lists show as cards, one per row; swipe the summary tiles sideways. For warehouse work, deliveries and clocking in, the Mobile app (All modules > Mobile app) is easier - add it to your home screen.

Help: the Help button at the bottom left answers "how do I..." questions from these lessons. On the till, "This sale" shows tips for the cart (what usually sells with it, cheaper open-box copies, fit checks). If Help does not know, ask a manager.

The till and the website: the till (the shop server) is the main system. The website admin shows the same screens, but stock, receiving, billing and loans open on the till, because those records live there.

The full manual: Training > Manual shows every lesson for your role on one page, with contents. Press "Print / save as PDF" for a printed or PDF copy. The Help panel links to it too.

Something broken? Raise a help desk ticket under All modules > System management > Help desk, saying what you did and what happened. Do not keep retrying a payment or a save that gave an error - report it.`,
    questions: [
      ['Where do you find Accounting, Payroll and the Document centre?', ['They are hidden', 'Overview > All modules', 'Settings > Company', 'Only on the website'], 1, 'All modules has a tile for every part of the system.'],
      ['You changed your theme to dark on one till. What happens on the next till you sign in at?', ['It is light again', 'It is dark too: preferences are saved against you', 'It asks you again', 'It depends on the computer'], 1, 'My Preferences follow the person, not the machine.'],
      ['How do you keep a screen you use every day at the top of the menu?', ['Bookmark it', 'Press the star beside it to pin it', 'Ask IT', 'You cannot'], 1, 'Pinned screens appear under Favourites.'],
      ['A save gives an error. What should you do?', ['Keep pressing save', 'Raise a help desk ticket saying what you did and what happened', 'Restart the computer', 'Ignore it'], 1, 'Report it; repeated retries can duplicate records.'],
    ],
  },
  {
    key: 'quotes-orders', title: 'Quotes, orders and the cashier queue', sort: 15, roles: ['owner', 'manager', 'cashier'],
    summary: 'Saving quotes, loading them into the till, the cashier queue and the order list.',
    body: `Making a quote: build the cart on the POS terminal and press QUOTE. The quote is saved with its lines (priced or not) and appears under Sales & POS > Quotes. A quote is valid for the number of days set in Company & Print Settings unless another date is given.

Working a quote: open it from Quotes. Lines without a price are called out as needing pricing. Print it as a full quotation, invoice-style or receipt-style. Mark accepted or Mark declined when the customer decides.

Turning a quote into a sale: open the quote and press "Load into POS". The lines go into the cart; check the customer and the prices, then check out as normal (or Complete Sale from the quote).

The cashier queue: in shops with a separate cashier, the counter saves the order and the customer pays at the cashier. Sales & POS > Cashier (or the Cashier page) lists orders due for payment. Open one, check it, and press "Take payment & invoice". Cancel order removes one the customer no longer wants. Paid invoices for the shift are listed on the right.

Recalling an invoice: on the Cashier screen, type an invoice number, name, phone or amount into Recall and press Find.

Orders: Sales & POS > Orders lists every completed sale, from the website (Online) and from the counter. Filter by source, customer type, status, payment, fulfilment (pickup, delivery, shipping) and dates. Open one to see its lines and history.

Online orders: a website order arrives in Orders and, when the warehouse is used, as a job for picking. The customer gets messages as it moves (order received, ready for pickup, out for delivery, delivered).`,
    questions: [
      ['How do you turn a saved quote into a sale?', ['Retype every line', 'Open the quote and press "Load into POS"', 'Email it to the cashier', 'You cannot'], 1, 'Load into POS puts the quote lines in the cart.'],
      ['A quote has a line marked as needing pricing. What does that mean?', ['It is free', 'The line has no price yet and must be priced before checkout', 'It is out of stock', 'It is a service'], 1, 'Unpriced lines need a price before checkout.'],
      ['Where does a cashier find orders saved at the counter?', ['Products', 'The Cashier screen, "Due for payment"', 'Reports', 'Low Stock'], 1, 'Saved orders wait in the cashier queue.'],
    ],
  },
  {
    key: 'after-sale', title: 'After the sale: reprints, returns, voids and credit notes', sort: 25, roles: ['owner', 'manager', 'cashier'],
    summary: 'POS sales and returns: finding a ticket, reprinting, returning items and voiding.',
    body: `Finding a ticket: POS Sales & Returns (Overview > All modules) lists the day's tickets. Set From and To and press Apply; tick "Show voided" to include voided sales. Open a ticket to see it.

Reprinting: open the ticket to print any of its documents again - receipt, invoice, pick slip or gift receipt.

Returning items: open the ticket and press "Return items". Choose only the lines and quantities that came back. The refund needs the refund permission. A credit note is printed for the return; "Credit note (full reversal)" reverses the whole sale. Afterwards grade the returned parts in Stock to cash > Returns to grade (see the Returns lesson).

Voiding: "Void sale" cancels a sale completely, for example one rung up by mistake. It needs the void permission; the stock goes back on the shelf and it cannot be undone. Then print the "Credit note (full reversal)" for the customer. Voids are watched: they appear on the terminal journal's exceptions list and in the security checks.

Payment on a charge sale: an account (charge) sale is paid later in Receivables > Receive payment, which applies the money to that invoice.`,
    questions: [
      ['A customer brings back one of three parts. What do you return?', ['The whole sale', 'Only the line and quantity that came back', 'Nothing', 'Two parts'], 1, 'Return only what came back.'],
      ['When is "Void sale" the right choice?', ['For any return', 'When the sale should never have happened, e.g. rung up by mistake', 'To change the price', 'To reprint'], 1, 'A void cancels the whole sale and is reviewed.'],
      ['Where is an account sale paid later?', ['On the till as a new sale', 'Receivables > Receive payment', 'Petty cash', 'Gift cards'], 1, 'Receive payment applies the money to the invoice.'],
    ],
  },
  {
    key: 'pos-addons', title: 'Gift cards, coupons, warranty and other extras', sort: 35, roles: ['owner', 'manager', 'cashier'],
    summary: 'Gift cards, coupons, loyalty, warranty claims, redeemables, recurring charges and reviews.',
    body: `Gift cards: POS Add-ons > Gift Cards. Issue a card with an amount (the code is made for you if left blank) and who it is for. Open a card to see its balance and history, reload it, or void it if misprinted or damaged. At the till, pay with the "Gift card" payment method.

Coupons: POS Add-ons > Coupons. A coupon has a code, a flat J$ or % discount, an optional minimum subtotal, a maximum number of uses and an expiry. Leave category and part numbers blank for a whole-cart coupon, or set them to discount matching lines only. At the till, type the coupon code at checkout; it shows on the cart and the receipt.

Warranty: a part carries a warranty when its Warranty (days) box is filled in on the part (tick "Serial required" too for parts sold by serial number); every sale of it then records the end date and the serial. POS Add-ons > Warranty lists those sales as active, expiring within 30 days, expired, or with a claim. Open a warranty claim with the serial number (it finds the sale) or the sale line, the customer and the fault reported. Resolve it with a resolution note (for example replaced, with the replacement sale). A refund or a replacement is still done as a return or a sale at the till.

Redeemables: scratch cards and similar vouchers. Tick "This is a redeemable item" on the part, then paste the printed card numbers into "Load instruments" on the part; each one sold takes the next number. With none loaded the till makes up a code, unless that cashier's permission to sell a redeemable with no code loaded is switched off. POS Add-ons > Redeemables lists them with face value and status. Redeem a winning card when it is presented and enter the payout paid from the drawer, or void one that is misprinted or damaged. A voided item can no longer be redeemed. The money for redeemables is held for the operator, not counted as our sales.

Recurring charges: on the till, regular charges such as rent are recurring invoices in Receivables (POS Add-ons > Recurring Charges takes you there): each period's invoice is raised on its date and goes on the customer's account. Bills you pay regularly are under Payables (see the Receivables and Loans & Rent lessons).

Reviews: POS Add-ons > Reviews holds customer reviews from the website. Approve a review to show it on the site, or delete it.`,
    questions: [
      ['How does a customer pay with a gift card at the till?', ['Cash', 'The "Gift card" payment method', 'A coupon code', 'Account'], 1, 'Gift card is its own payment method.'],
      ['A coupon has no category and no part numbers set. What does it discount?', ['Nothing', 'The whole cart', 'Only brakes', 'Only services'], 1, 'Blank limits mean a whole-cart coupon.'],
      ['What do you need to open a warranty claim?', ['Only the customer name', 'The receipt or sale line, the part and serial, and the fault', 'A manager PIN', 'Nothing'], 1, 'The claim ties the fault to the sale and the part.'],
    ],
  },
  {
    key: 'parts-stock', title: 'Parts, stock and suppliers', sort: 55, roles: ['owner', 'manager'],
    summary: 'Products, adding and importing parts, low stock, notify-me, inquiries, pulls, deliveries and suppliers.',
    body: `Finding a part: Parts Department > Products / Stock. Search by part number, name or vehicle, filter by category, and tick "In stock only". Each row shows category, condition, location, bin, price, stock and a level badge (in, low, out). Edit opens the part.

Adding a part: "+ Add new part" (or snap a photo). The form has tabs: General (photo, name, category, fitment, condition, item type, SKU, barcode), Pricing, Stock & bins, Supplier, Accounting and More photos. A star on a tab means it holds something required. Point at the small i beside a box for what goes there. "Copy from an existing part" fills the form from a similar part.

Item types: Inventory is a stocked part; Tracked is a counted non-warehouse item (for example tokens); Service / fee has no stock (delivery, rent).

Importing parts: Import inventory takes a CSV, TSV or Excel file. Download the Template first. Column names are matched for you and you see a preview before anything changes. Create matrix makes a set of variants of one part.

Low stock: Parts Department > Low Stock lists parts at or below their reorder threshold. Set the restock-to quantity, then Create PO to order them from the supplier.

Notify-me: customers on the website can ask to be told when a part is back. Parts Department > Notify-Me lists them; "Send back-in-stock alerts" emails everyone whose part is now in stock.

Parts inquiries: requests from the website for a part. Price / edit one to answer it, and Save quote to send the customer a quote.

Parts requisitions (pulls): a request to take parts from stock for the counter or a job. Add the parts, choose who asked, Submit pull; the store fills it with "Fulfill from stock". Status shows pending, partial, backordered or fulfilled.

Deliveries: Parts Department > Deliveries creates a delivery to a customer (name, phone, address, driver, time). Customer deliveries also appear in Dispatch for the drivers.

Suppliers: Parts Department > Suppliers. Add a supplier with code, contact, phone, email, lead time (days) and address. Deactivate one you no longer use. The supplier's bills, credits and defaults (usual expense account and class) are in Payables.`,
    questions: [
      ['A tab on the Add new part form has a red dot after you press save. What does it mean?', ['The part saved', 'Something on that tab is missing or wrong', 'The part is out of stock', 'Nothing'], 1, 'The tab with the problem is marked and opened.'],
      ['Which item type do you use for a delivery fee?', ['Inventory', 'Tracked', 'Service / fee', 'Matrix'], 2, 'Services and fees carry no stock.'],
      ['How do you bring in 500 new parts from a spreadsheet?', ['Type them one by one', 'Import inventory, after downloading the template', 'Email IT', 'Use Low Stock'], 1, 'Import shows a preview before anything changes.'],
      ['What does "Send back-in-stock alerts" do?', ['Orders stock', 'Emails customers waiting for parts that are now in stock', 'Changes prices', 'Deletes requests'], 1, 'It tells waiting customers their part is back.'],
    ],
  },
  {
    key: 'purchasing', title: 'Purchase orders and Receive Stock', sort: 58, roles: ['owner', 'manager'],
    summary: 'Ordering from suppliers, receiving a delivery with its bill, and settling differences.',
    body: `Purchase orders: Purchasing > Purchase Orders. "+ New purchase order" has the tabs Supplier & dates, Lines (the parts and their costs), Shipping & terms and Notes. Saving creates the order and opens it. Open any order to see its lines, what has been received and the bills against it.

Receive Stock: Purchasing > Receive Stock is one screen for every delivery, with the tabs Source, Items, Supplier bill, and Tally & post. From a PO's own page, "Receive Stock for this PO" opens it ready to go.

Receive Stock step 1, Source: choose "Against a purchase order" and pick it, or "No purchase order" and pick the supplier. Set the date received if it was not today.

Receiving from the supplier's invoice: on the Source tab, "Scan the supplier's invoice" takes a photo or PDF of the invoice and reads it. It picks the supplier, and the open purchase order if there is one, fills the quantities and costs of the lines it can match by part number, and fills the bill number, dates, subtotal, GCT, freight and total. It lists the lines it could not match and any price or quantity that differs from the PO. Always check the goods against what it filled in - count, do not trust the paper. When you post, the scanned invoice is filed in the Document centre against the bill, the supplier and the PO. If reading is not set up, the button says so: type the delivery in as usual.

Receive Stock step 2, Items: with a PO, type how many of each line arrived ("Everything outstanding arrived" fills them all). Without a PO, search the parts and give the quantity and cost. Receive only what you counted.

Receive Stock step 3, Supplier bill: bill number, bill date, due date (blank = from the supplier's terms), subtotal, GCT, freight and the bill total, which must equal subtotal + GCT + freight. If the bill has not come yet, untick "The supplier's bill came with it" and enter it later in Payables > Enter a bill.

Receive Stock step 4, Tally & post: the value received is compared with the bill's subtotal. Within J$1 it posts. Otherwise choose why: Back order (the bill includes goods still to come; without a PO a back-order PO is opened for the rest), Bill adjustment (the supplier's price differs; goes to Purchase Price Variance), Supplier credit due (they overcharged; collect it as a supplier credit), or Other (pick the account and write a note).

After receiving: the stock is added, freight goes to 5060 Freight and Duty In, and the bill waits in Payables to be paid with Pay bills. A PO billed through Receive Stock is not billed a second time. When back-ordered goods arrive, receive them with the bill box unticked - they are already billed.

On the website: Purchase Orders and Receive Stock open on the till, because stock and bills are kept there.`,
    questions: [
      ['The bill says subtotal J$50,000, GCT J$7,500, freight J$2,000. What must the bill total be?', ['J$50,000', 'J$57,500', 'J$59,500', 'J$52,000'], 2, 'Total = subtotal + GCT + freight.'],
      ['The supplier billed for 10 but sent 8; the other 2 are coming next week. Which reason do you choose?', ['Bill adjustment', 'Back order', 'Other', 'Supplier credit due'], 1, 'Back order: the bill includes goods still to come.'],
      ['The back-ordered 2 arrive. How do you receive them?', ['With a new bill', 'With "The supplier\'s bill came with it" unticked - they are already billed', 'Not at all', 'As a return'], 1, 'They were billed on the first delivery.'],
      ['The supplier charged more per unit than the PO price. Where does the difference go?', ['Bill adjustment, to Purchase Price Variance', 'Back order', 'Freight', 'Nowhere'], 0, 'Price differences are a bill adjustment.'],
    ],
  },
  {
    key: 'warehouse-mobile', title: 'Warehouse app and Mobile app', sort: 65, quiz: false,
    summary: 'Scanning, putaway, picking, labels and the phone app.',
    body: `The Warehouse app: All modules > Warehouse. USB or Bluetooth scanners type straight into the scan box; on a phone tap the camera button. The tabs are Scan, Orders, Move / Put away, Receive, Count, Bins, Labels, Activity and Office.

Scan: scan a part or a bin label to see where it is and how many. Labels may start with BIN: or ITEM: so a bin and a part number that read the same are never confused.

Put away: stock received waits in the RECEIVING (or UNASSIGNED) bin. On Move / Put away, scan the part, then the bin you put it in. The total stock does not change, only where it sits.

Picking orders: the Orders tab lists jobs from sales and web orders: new, picking, picked, packed, ready, dispatched or delivered, or collected at the counter (the pickup code is checked). Pick what is listed; if a part is missing or damaged, record it short - it becomes a lost sale purchasing can see. A manager can put an order on hold; held orders cannot be picked or sent.

Labels: the Labels tab prints part and bin labels on a thermal printer (2" x 1") or an A4 / Letter sheet of 30.

The Mobile app: All modules > Mobile app, made for phones. Tiles: Stock count, Pick orders, Put away / move, Receive, Driver, Clock in / out, Cashier, Leave & forms, Dispatch and Find a part. You only see the tiles your role allows. Add it to your home screen: on Android use the menu > Install app; on iPhone use Share > Add to Home Screen.`,
    questions: [],
  },
  {
    key: 'customer-records', title: 'Customer accounts, messages and campaigns', sort: 52, quiz: false, roles: ['owner', 'manager', 'cashier'],
    summary: 'The customer list, accounts and credit, the messages inbox and marketing campaigns.',
    body: `The customer list: Customers > Customers (CRM). Tabs show all customers, online sign-ups, those created at the counter, staff and archived. Search by name, email, phone, company or account number, and filter by category (retail, trade, fleet, dealer).

New customer: "+ New customer" takes name, phone, email (blank = counter customer), company, category, price tier, credit type (cash only, open account, revolving, COD), credit limit and notes. You can also add one at the till with "+ New".

Opening a customer: Open shows their details, orders, lifetime value and loyalty points. Delete archives a customer (Restore brings them back).

Credit and statements: a customer's balance, aging, credit limit, credit hold and statements are in Receivables > Customer centre. A customer on credit hold cannot be charged to account at the till.

Messages inbox: Customers > Messages Inbox holds conversations with customers from the website portal. Reply there; the customer sees it in their account.

Customer messages log: All modules > Customer messages lists every email, SMS and WhatsApp message the system sent (order received, ready for pickup, out for delivery...), with its status. "Logged only" means email or SMS is not set up, so it did not reach the customer. WhatsApp messages are sent by hand. Templates and Settings are on the same page.

Marketing campaigns: the Marketing screen (All modules) builds a campaign for a segment (everyone, retail, trade, fleet, dealer, inactive 60 days, loyalty 500+) by email or SMS, or WhatsApp and social by hand. Only customers who said yes to offers on that channel receive it, and every message can unsubscribe.`,
    questions: [],
  },
  {
    key: 'cash-office', title: 'Cash report and petty cash', sort: 45, quiz: false, roles: ['owner', 'manager'],
    summary: 'Closing the drawer from the office, payouts, the cash report and petty cash funds.',
    body: `Cash report: Sales & POS > Cash Report shows the open drawer session with its opening float. To close from here, enter the closing cash count, who closed it, and notes, then Close till. Below, run the report for a date range: payments by method and POS sales for the same range.

Payouts: record cash taken from the drawer with the amount, the reason and who it was paid to. No cash leaves the drawer without a record. The payouts from the open session are listed under the form, and closing the till takes them off the cash expected in the drawer.

Cashier page: All modules > Cashier has the payment queue, the drawer (float counted by note and coin, drops, payouts, X report while open, blind close), past shifts with their Z reports, and stations. A blind close means the cashier never sees the expected amount; the over or short is worked out and reviewed by a manager.

Petty cash: Sales & POS > Petty Cash. A fund has a name, custodian, location, opening balance and imprest float (the top-up target), and can require a receipt over a set amount. Record each expense with category and receipt reference. Advances to a person are listed until repaid or expensed ("Expense the advance"). Count the fund regularly; the last count is shown, and a short or over count is recorded as such. Top a fund up from the bank or from the open drawer ("to float" fills it back to the imprest amount), and move money between funds with a transfer. A wrong entry is voided, never deleted. Every payout, top-up and count goes to the books by itself.`,
    questions: [],
  },
  {
    key: 'receivables', title: 'Receivables: customer accounts and collections', sort: 110, roles: ['owner', 'manager'],
    summary: 'Customer centre, receiving payments, credit hold, collections, aging and statements.',
    body: `Where: All modules > Receivables. Tabs: Customer centre, Collections, A/R aging and Recurring invoices. The tiles at the top show open invoices, overdue and unapplied credits.

Customer centre: find a customer by name, account number or phone, or show everyone who owes or has credit, overdue, over credit limit, on credit hold, or with unapplied credit. Open one to see their invoices, payments, notes and statement.

Receive payment: open the customer and receive the payment. Choose the invoices it pays and the amount on each; "oldest first" fills them in order. Anything left over stays as a credit on the account and can be applied later. A payment entered wrongly is voided, not edited.

Credit hold: putting a customer on credit hold makes the till refuse to charge to their account. Take them off hold when the account is brought up to date.

Collections: the Collections tab is the worklist of overdue accounts. Log calls and promises to pay in the collections notes. "Email a reminder" sends the reminder email. The procedure: a reminder at 1 day past due, a call at 15 days, credit hold at 45 days.

A/R aging: what each customer owes by age (current, 1-30, 31-60, 61-90, over 90 days). Print it or export it.

Statements: print or email a customer's statement of account for a period from their page, or from Loans & Rent.

Invoices on the books: a New invoice or New recurring invoice on the customer's page bills something that is not a till sale - rent, a service, a late fee. See the Loans, rent and late fees lesson.

Getting an invoice signed: the "✍ Sign" button on a customer's invoice opens its signature page. In person: "Sign here now" - hand the screen to the customer, they sign with a finger, pen or mouse and you are the witness. Away from the shop: "Send for signature" emails a link, or leave the email blank to get a link to send by WhatsApp or text. The link works once, lasts the days you set (14 unless changed) and is shown only that once; cancel a link that is no longer needed. The customer opens it on their phone, types their name, signs and ticks that they received the goods or services and agree to pay.

Signed invoices: every signature is kept with the time, how it was signed and a seal over the invoice's contents, and a signed copy is filed in the Document centre against the invoice and the customer. "Seal intact" means the invoice has not changed since it was signed. If the invoice is edited afterwards, the page warns "The invoice has changed since it was signed" - get it signed again.

Customer documents: the "Invoices & documents" panel on the customer's page keeps signed invoices, signed delivery slips, statements and their other papers, filed under Receivables in the Document centre.`,
    questions: [
      ['A customer pays J$30,000 against invoices of J$20,000 and J$15,000. With "oldest first", what happens?', ['Both are paid', 'The older one is paid and J$10,000 goes on the newer one', 'Nothing is applied', 'J$30,000 is refunded'], 1, 'Oldest first fills invoices in order.'],
      ['What does credit hold do?', ['Deletes the customer', 'The till refuses to charge to their account', 'Sends a statement', 'Adds a late fee'], 1, 'Credit hold blocks account charges at the till.'],
      ['A payment was entered against the wrong customer. What do you do?', ['Edit the amount', 'Void it and enter it again correctly', 'Ignore it', 'Delete the customer'], 1, 'Payments are voided, never edited.'],
      ['A customer signed an invoice, then a line on it was changed. What do you do?', ['Nothing, it is signed', 'Get it signed again', 'Delete the signature', 'Void the customer'], 1, 'The seal shows the invoice changed after signing, so the old signature no longer covers it.'],
    ],
  },
  {
    key: 'payables-banking', title: 'Payables and banking', sort: 115, roles: ['owner', 'manager'],
    summary: 'Supplier bills and credits, paying bills, cheques, deposits, reconciling and statement import.',
    body: `Payables: All modules > Payables. Tabs: Supplier centre, Pay bills, Enter a bill, Enter a supplier credit, A/P aging, Loans and Recurring bills. The tiles show unpaid bills, overdue and supplier credits.

Entering a bill: bills from Receive Stock arrive by themselves. For other bills (light, phone, rent, repairs) use Enter a bill: supplier, bill number and dates, then a line for each cost with its category (account) and class. The supplier's usual category and class fill the first line. Attach the supplier's invoice; it is filed in the Document centre.

Scanning a supplier's invoice: on Enter a bill, "Scan the supplier's invoice" reads a photo or PDF of it and fills in the supplier, bill number, dates, lines, freight, GCT and memo, with a warning for anything it was unsure of. Check every line and the total against the paper before saving. "Attach it without reading" just keeps the file. Either way, when you save the bill the invoice is filed in the Document centre under Payables, linked to the bill and the supplier. If reading is not set up, type the bill in and attach the file.

Supplier documents: the "Supplier invoices & documents" panel on the supplier's page in the Supplier centre keeps their invoices, statements and other papers; you can file more there.

Supplier credit: when a supplier owes us (returned goods, overcharge), Enter a supplier credit. It is used up against their bills in Pay bills.

Paying bills (paying a supplier): Pay bills lists unpaid supplier bills. Tick the ones to pay, choose the bank account and the date, and use any supplier credits. One payment can pay several bills. A cheque payment prints a cheque voucher with a remittance stub.

Banking: All modules > Banking. Tabs: Accounts, Register, Write cheque / spend, Receive money, Transfer, Make deposits, Reconcile and Bank statement. Each real bank account is one ledger account; add one under Accounts.

Write cheque / spend money and Receive money: for money in or out that is not a bill or a customer payment (bank charges, interest, a refund). Each line needs a category and can carry a class.

Make deposits: cash and cheques taken at the till sit in Undeposited Funds (the safe) and Cheques to Deposit. When you take them to the bank, Make deposits moves them into the bank account in one deposit, matching the bank slip.

Reconcile: once a month, enter the statement's ending balance and date, and tick each line that is on the bank statement ("Tick everything matched to the imported statement" does most of it). Add bank charges and interest from the statement. The difference must be zero before you finish; "Adjust the difference" is only for when you cannot find it.

Bank statement: import the bank's statement file. Lines are matched to what is already in the books; the rest you add with a category. Statement rules send lines with given text to one account or split them (fixed J$, a % and the rest), for example a loan debit split between interest and principal.`,
    questions: [
      ['Where do you enter the electricity bill?', ['Receive Stock', 'Payables > Enter a bill', 'Petty cash', 'Products'], 1, 'Expense bills are entered in Payables.'],
      ['Cash from the till is taken to the bank. How is it recorded?', ['Receive money', 'Make deposits, from Undeposited Funds', 'A journal', 'Nothing'], 1, 'Make deposits moves it from the safe into the bank.'],
      ['When can you finish a bank reconciliation?', ['Any time', 'When the difference is zero', 'At month end only', 'When a manager signs'], 1, 'The difference must be zero.'],
      ['A supplier owes us for goods we sent back. What do you enter?', ['A bill', 'A supplier credit', 'A deposit', 'A void'], 1, 'Supplier credits are used up in Pay bills.'],
      ['You scanned a supplier\'s invoice into Enter a bill. What do you do before saving?', ['Save at once', 'Check each line and the total against the paper', 'Print it', 'Email the supplier'], 1, 'Reading can be wrong; the paper is what counts.'],
    ],
  },
  {
    key: 'loans-rent', title: 'Loans, rent and late fees', sort: 120, roles: ['owner', 'manager'],
    summary: 'Loans the business owes, rent from tenants, recurring bills, late fees, reminders and the Loans & Rent page.',
    body: `A loan the business has taken: the lender must be a supplier. Payables > Loans > Register a loan: amount, interest % a year, number of instalments, how often, repayment type (Fixed payment for an ordinary bank loan), the date the money came in and the first due date. Show the schedule to check it against the lender's letter. Choose Standing order if the bank takes it, or Paying it ourselves for an email before each payment.

Loan instalments: on each due date the system raises a bill from the lender - principal to Loans Payable, interest to Interest Expense. Pay it with Pay bills. For a standing order, pay it when the debit is on the bank statement so it ticks off in the reconciliation. On the loan: Pay extra (a lump sum off the principal), Change rate / instalments, Bill now (pay ahead) and Bill again (after voiding a wrong bill).

Rent from a tenant: the tenant is a customer. In Receivables > Customer centre, use New invoice for one charge, or New recurring invoice for every month: a name, the first period date, Due (days after), and a line like "Rent for {period}". Add GCT only if the rent is GCT-able (commercial rent while registered; residential rent is exempt). Change applies from the next period; Pause, Resume (asks whether to bill the missed months) and End.

Late fees: set on the recurring invoice, or for the whole customer under Reminders & late fees. A flat amount or a % of what is open, after the grace days, once per invoice or every month while unpaid. A promise to pay logged in the collections notes holds the fee until the promise date. To waive a fee, click Waive beside it and give the reason. Fees are never charged on till sales or on another fee.

Automatic reminders: customer > Reminders & late fees > Email reminders. They go 3 days before due, on the due date, and 1, 7 and 14 days after - no emails after day 14 (then it is a phone call). A promise to pay stops overdue reminders until its date.

Recurring bills: Payables > Recurring bills for fixed regular bills (internet, rent we pay): supplier, amount, account, GCT, how often and Paid by (standing order or paying it ourselves).

The Loans & Rent page: All modules > Loans & Rent. Register lists every loan, rental agreement and recurring bill with next due, balance, overdue and status; Documents lists everything they produced. Search and filter, then Print / PDF or Excel / CSV. Each row offers Statement, Schedule, Invoice or Receipt, which can be printed or sent by email, SMS or WhatsApp to the address on the customer's or lender's record.`,
    questions: [
      ['The bank takes the loan payment by standing order. When do you pay the bill in Payables?', ['Never', 'When the debit shows on the bank statement', 'Before it is due', 'At year end'], 1, 'Pay it when it is on the statement so it reconciles.'],
      ['A tenant promised to pay by Friday. What happens to the late fee?', ['It is charged anyway', 'It is held until the promise date', 'It doubles', 'It is waived for ever'], 1, 'A promise to pay holds the fee until its date.'],
      ['Is residential rent GCT-able?', ['Yes', 'No, residential rent is exempt', 'Only in December', 'Only for trade customers'], 1, 'Add GCT only for GCT-able rent.'],
      ['After which day do automatic reminder emails stop?', ['Day 1', 'Day 7', 'Day 14', 'They never stop'], 2, 'From day 15 it is a phone call.'],
    ],
  },
  {
    key: 'accounting', title: 'Accounting: the ledger, categories and classes', sort: 125, roles: ['owner', 'manager'],
    summary: 'How sales and bills reach the ledger, posting rules, classes, reports, closing and the QuickBooks export.',
    body: `How it works: the till and the books keep doing their work, and the ledger posts each finished document once as a balanced journal entry - sales, payments, returns, receipts, bills, bank entries, drawer counts, gift cards, commission and invoices. Posting runs every minute; "Post now" runs it at once. Entries are never edited: a correction is a reversal.

Where: All modules > Accounting. Tabs: Overview, Journal, Trial balance, Accounts, Posting rules, Classes, Reports and Close & export.

Overview and tie-out: the overview shows the ledger start date, entries, anything waiting to post and Suspense. The tie-out compares each control account (inventory, receivables, payables...) with the system's own record. A difference means something moved outside the posting rules; open the account from the trial balance to find it. Suspense should be zero.

Categories: a category is an account in the chart. Use sub-accounts for detail (for example Rent: Warehouse). Every bill, invoice, cheque, deposit and journal line has a category.

Posting rules: Accounting > Posting rules decides which income and cost accounts each product category posts to (by default Sales - Parts and Cost of Goods Sold). One product can have its own accounts under "Products with their own accounts", for example a shop-rent product posting to Rental Income.

Classes (adding a class): a class tags a line by store location or activity so profit can be split, as in QuickBooks. Each store location has one automatically; add your own (Rentals, Workshop...) under Accounting > Classes. A class in use can be retired, not deleted. Till sales take their store's class.

Customer and supplier defaults: on a customer's page in Receivables set the category and class new invoice lines start with; on a supplier's page in Payables set the usual expense account and class.

Reports: Accounting > Reports has Profit & loss by category (choose dates and a class, or a column per class; click an amount to see the lines), Expenses by supplier and category, and Sales by customer and income category, each with Print / PDF and Excel / CSV.

Journals: a manual journal is for adjustments the accountant asks for. Debits must equal credits; each line can carry a class.

Close & export: close a month once it is checked so nothing more posts into it (a manager can reopen it). Export to QuickBooks as an IIF file (with classes), or to CSV.`,
    questions: [
      ['A journal entry was posted to the wrong account. How is it corrected?', ['Edit it', 'Reverse it and post the right one', 'Delete it', 'Leave it'], 1, 'Ledger entries are immutable; corrections are reversals.'],
      ['What should the Suspense balance be?', ['Large', 'Zero', 'Negative', 'Equal to sales'], 1, 'Suspense holds what did not add up; it should be cleared.'],
      ['You want rent income separated from parts sales in the profit and loss. What do you use?', ['A class or its own income account', 'A coupon', 'A new till', 'Nothing'], 0, 'Categories and classes split the profit and loss.'],
      ['Can a class that has been used be deleted?', ['Yes', 'No, it can only be retired', 'Only on Sundays', 'Only by a cashier'], 1, 'Used classes are retired to keep history.'],
    ],
  },
  {
    key: 'budget-forecast', title: 'Budget, forecasts, break-even, ROI and the health report', sort: 127, roles: ['owner', 'manager'],
    summary: 'Setting and keeping budgets, the 12-month and 13-week forecasts, break-even sales, the return on investments, the financial health report and showing figures in another currency.',
    body: `Where: All modules > Budget & forecast (also linked from the top of Accounting). Tabs: Budget, 12-month forecast, 13-week cash, Break-even, Investments & ROI and Health report. Everyone who can see Accounting can look; changing budgets, the forecast and investments, and keeping budget versions and health reports, needs the permission "Edit budgets, the cash forecast and investments" (owners and managers have it). The figures come from the ledger, so the ledger must be started.

Currency: "Show in" at the top right shows every figure in J$ or in another currency (US$, CA$, £, €) at the latest exchange rate from Purchasing. The books stay in J$: an amount you type while another currency is shown is turned into J$ at that rate, and boxes you do not change keep their exact J$ figure.

The budget: choose the year and who it is for - the whole business or one class, such as a branch. "Enter the budget" shows every income and cost account with a box for each month. Type each month, or type a yearly figure in the Year column to spread it evenly over the 12 months. "Fill from last year's actuals" copies what the books showed for each month a year earlier, raised or lowered by the % you give. Nothing is kept until you press Save budget. "Year starts in" sets the first month of the financial year.

Saved versions: "Keep as a version" saves the budget and keeps a named copy of it, such as "Original 2027" or "Revised after March". Change the working budget as often as you like; the version stays as it was. Choose a version under Budget to look at it or to compare it with actual. "Put back as the working budget" makes it the working budget again - the working budget as it stood is kept as a version first, so nothing is lost.

Budget against actual: choose "Budget against actual" and the period (year to date, the whole year or one month). Each account shows the budget, the actual, how much better or worse it is, and the % of the budget used. A cost more than 10% over its budget, or income more than 10% under, is red. Click an actual figure to see the entries behind it.

The 12-month forecast: profit for this month and the next 11, account by account, worked out from the books one of five ways - the same month last year grown at the past year's rate, the same month last year, the average of the last 3 or 12 months, or the budget. Try a sales change % and an other-costs change %: cost of sales and expenses ticked as going up with sales follow the sales change. It shows net profit by month (last 12 from the books, next 12 forecast), the money expected at the end of each month (today's money on hand plus profit, with depreciation added back, loan capital repaid and your own one-off lines), and how this financial year should end against the budget and the year before. Nothing is saved.

The 13-week cash forecast: the next 13 weeks, Monday to Sunday. It starts with the money on hand now (the bank accounts, the safe, cheques waiting to deposit and the drawers, from the ledger) and adds, by the week they fall due: what customers owe (overdue amounts in this week, at the % you expect to collect), recurring invoices, and the usual counter and workshop takings. It takes off supplier bills by due date, recurring bills, loan instalments not yet billed, payroll (the average of the last 3 runs on the same schedule) and the usual new supplier bills. The usual takings and supplier bills are the last 8 weeks' averages unless you type your own under Assumptions. Add one-off money in or out (a loan coming in, a new machine, a tax payment) under Your own lines. Set the lowest balance you want to keep: any week below it is red. Click a figure to see what makes it up.

Break-even: choose a past period (the last 3 full months unless changed) and, if you like, one class. Cost of sales, and any expense ticked as going up with sales (card fees, commission), are variable costs; every other cost is fixed. Break-even sales a month = fixed costs a month / the margin left after variable costs. The page shows this, the sales needed a trading day, where this month is heading, the margin of safety (how far sales can fall before a loss) and the sales needed each day for the rest of the month. The What if sliders show the effect of changing prices, cost of goods or fixed costs; they save nothing.

Investments & ROI: record each investment - a branch, a vehicle, a machine, a stock line - with the amount, the start date and the profit it is expected to make a month. The page shows the expected payback time and yearly return. Give it a class in the books and it also shows the actual profit since it started (income less every cost posted to that class), the actual return so far and the payback time at current results. File the papers (quotes, invoices, loan letters) in its Documents panel. Mark it closed when it is sold or ended.

The health report: a check-up of the whole business from the books - the last 12 full months for profit and growth, and today's balances. Each measure (gross and net margin, staff costs, margin of safety, sales growth, overheads against sales, cash cover, current and quick ratios, the 13-week forecast, debtor, stock and creditor days, the cash cycle, debt to equity, interest cover, profit against budget, unsorted Suspense entries and investments) is compared with a guide figure and rated Healthy, Watch or Concern, with what it shows and what to do about it. The ratings make a score out of 100: 80 or more is Strong, 65 to 79 Sound, 50 to 64 Needs attention, under 50 At risk. The report lists the strengths, the concerns and the recommended actions in order of importance. It is worked out by fixed rules, so the same books always give the same report; it is not audited and does not replace your accountant. "Keep this report" saves it so you can compare the score over time.`,
    questions: [
      ['Where do you type a figure for the whole year so it is spread evenly over the months?', ['In January', 'In the Year column of the budget', 'In Accounting', 'In the cash forecast'], 1, 'The Year column spreads a yearly figure over the 12 months.'],
      ['Fixed costs are J$600,000 a month and 30% of every J$ of sales is left after variable costs. What are break-even sales a month?', ['J$180,000', 'J$600,000', 'J$2,000,000', 'J$780,000'], 2, 'J$600,000 / 0.30 = J$2,000,000.'],
      ['The bank will lend J$1,000,000 next month. How do you show it in the cash forecast?', ['It shows by itself', 'Add it under Your own lines as money in', 'Change the takings', 'Enter a supplier bill'], 1, 'One-off money in or out goes under Your own lines.'],
      ['A van cost J$3,000,000 and earns J$100,000 a month. What is the expected payback?', ['3 months', '30 months', '300 months', '12 months'], 1, 'J$3,000,000 / J$100,000 = 30 months.'],
      ['You are about to rework the budget but want to keep the one the owner approved. What do you do first?', ['Print it', 'Keep it as a version', 'Clear all', 'Change the year'], 1, 'A version keeps a named copy that does not change.'],
      ['The page is showing US$ and you type 1,000 in a budget box. What is saved?', ['US$1,000', 'J$1,000', 'The J$ amount at the latest rate', 'Nothing'], 2, 'The books are in J$; typed amounts are turned into J$ at the rate shown.'],
      ['The health report rates Stock days as a Concern. What does it suggest?', ['Buy more stock', 'Clear dead stock and stop reordering slow lines', 'Raise wages', 'Borrow more'], 1, 'Too many days of stock ties up cash; clear slow lines and buy fast movers little and often.'],
    ],
  },
  {
    key: 'reports-planning', title: 'Dashboard, reports and planning', sort: 130, quiz: false, roles: ['owner', 'manager'],
    summary: 'The dashboard, the Reports menu, Planning and lost sales, the balancing report and the terminal journal.',
    body: `Dashboard: Overview > Dashboard shows sales today, the last 7 and 30 days, accounts receivable, what needs attention (orders to process, out of stock, low stock), a 14-day sales chart, payments taken, top sellers and recent sales.

Reports: Overview > Reports. Pick a report from the menu on the left (on a phone the menu is on top and picking one scrolls to it), set From and To or press Today / 7d / 30d, and Run. Every report has CSV and Print, an optional graph, and a Sticky option that pins the headings while you scroll. Click a column heading to sort; drag its edge to resize. Star a group to keep it at the top.

Report groups: Till (Z report, X report), Sales (summary, products and categories, returns, tax collected, online orders, order ledger, cashier orders, by rep, commission, gross margin), Money (payments, A/R aging, payables, daily sales journal), Operations (goods received, reorder, stock valuation, suppliers, purchasing and receiving, inventory position, warehouse activity, serials, core charges, customers and loyalty), Management (management summary, profit and loss, cash flow, period comparison, stock ageing, exceptions, sales detail, customer statement), Ranking, Analysis, Directory and Admin (users, setup, audit log).

Z report and X report: the X report shows the live till without closing it; the Z report is the end-of-day report for a closed drawer.

Planning and lost sales: All modules > Planning and lost sales. Dashboard compares the period with the one before (sales and profit, fill rate, inventory value and days of cover, dead and slow stock, suppliers and payables, cash drawers). Lost sales gathers what customers asked for that we could not supply - recorded at the counter, short picks and cancelled orders. Call-backs lists customers to phone when the part arrives. Targets sets the goals shown against the actuals.

Balancing report: All modules > Balancing report checks that stock, sales and collections tie out for a period: opening stock + receipts - sold + returned + adjustments = closing; sales against stock relieved; billed = paid + still owed. Periods before the stock ledger started are estimated, and the report says so.

Terminal journal: All modules > Terminal journal shows what happened on each till - items, price changes, discounts, sales, voids, refunds, holds and drawer events - with an Exceptions view of what a manager should look at. Departments are managed from here too.

Stock to cash: All modules > Stock to cash shows stock that is not selling (overstock, aged, dead, discontinued, open box, damaged), returns to grade, damaged goods and supplier claims, liquidation lots, offer campaigns and a worklist (see the Clearance lesson).`,
    questions: [],
  },
  {
    key: 'people', title: 'Staff, roles, payroll and attendance', sort: 135, quiz: false, roles: ['owner', 'manager'],
    summary: 'Adding staff, roles and permissions, staff categories, attendance, payroll, commission, hiring and training.',
    body: `Adding staff: Settings > Users & Staff > "+ New staff member": name, email (login), phone, temporary password, employee number, national ID (TRN), till PIN (4 to 8 digits), admin panel role (Owner, Manager, Cashier, Freelance rep) and categories (sales rep, cashier, mechanic, service advisor, driver, parts clerk). Untick "Can sign in to the admin panel" for staff who only need a PIN at the till. Each row has Edit, PIN, Reset password and Disable.

Roles and permissions: Settings > Roles & Permissions. A role is a set of screens and functions, plus whether it has manager rights. Add a role to hand out part of a manager's access without the rest. The Owner role is fixed - it is the way back in if a permission is set wrong. Nobody can create a role more senior than their own.

Staff categories: Settings > Staff Categories lists what people do (sales rep, cashier, driver...). Each category has a permission grid: unticked functions are denied to its members, and a person's own record can re-allow or deny on top.

Sales reps: Company & Print Settings > Sales reps lists reps with their commission %. A staff member who is also a rep is better added under Staff with the Sales rep category ticked.

Time clock and attendance: staff clock in at All modules > Time clock (PIN, badge, fingerprint / face or email). Attendance shows who is in, today, requests (overtime, extensions, corrections) to approve, timesheets, staff and shifts, leave and holidays, sales per hour and settings. Approving the week's timesheets freezes the figures for payroll.

Payroll: All modules > Payroll (switched on in its settings). Set the company TRN and NIS employer number, add employees (staff can be brought in at once), run pay runs, and approve them. It works out NIS, NHT, Education Tax, HEART and PAYE by the TAJ rules and keeps the rates by date. Statutory deductions are paid to TAJ by the 14th of the next month (S01). Contractors, loans and advances, deductions and payslips are handled there too.

Commission: All modules > Commission. Rules set the rate by part, supplier, category or rep (% of the line, % of the margin, or J$ per unit, with tiers). Commission can be earned when the sale is made or only once it is fully paid. Split a sale between reps, add adjustments, make statements, approve and pay them. Every rep sees their own under My commission. Freelance reps and tracked links are managed there.

Hiring: All modules > Hiring and careers. Post jobs (they appear on the public careers page) and move applicants through New, Screen, Interview, Offer, Hired or Rejected. CVs are kept privately; applicants not hired are deleted after the retention period. A hire becomes a staff login, switched off until a manager sets the role and password.

Training: All modules > Training. Each person reads the lessons for their role and takes the quizzes (a pass lasts a year). The practice till lets new staff ring up practice sales safely. Managers see the Team view and edit lessons and questions.`,
    questions: [],
  },
  {
    key: 'delivery-drivers', title: 'Dispatch and the driver app', sort: 140, quiz: false,
    summary: 'The dispatch board, adding jobs, assigning drivers, the driver app, proof of delivery and SOS.',
    body: `Dispatch: All modules > Dispatch. The live board shows the queue, jobs assigned or on the road, drivers on shift, jobs done today and alerts, with a live map. Customer deliveries arrive by themselves; add bank drops, parts pick-ups, documents, cheques, collections and errands with "+ New job".

Assigning: give a job to a driver. Each driver's jobs are put in route order - urgent first, then nearest-next - starting from where the driver is or from the shop. The map numbers each driver's stops; grey pins are not yet assigned.

Drivers: a driver needs the Driver app permission (Roles & Permissions > Deliveries & drivers).

The driver app: All modules > Driver app, or the Driver tile in the Mobile app. Start your shift with the vehicle and odometer. While on shift the shop sees where you are, to plan your route and keep you safe; it stops when you end the shift. Open the route, press navigate for turn-by-turn directions, arrive, then complete the job with the recipient's name, signature and a photo - or say why it could not be done.

SOS: the SOS button alerts the shop at once with your position. Use it in any emergency.

Alerts: dispatch is alerted to SOS, a phone that has gone quiet, a driver stopped too long away from any stop, and speeding.

Security screen: the Security screen (fleet wall) is a full-screen live driver map for the security monitor; it is opened with a screen link and needs no sign-in.`,
    questions: [],
  },
  {
    key: 'documents-forms', title: 'Documents, forms and leave', sort: 145, quiz: false,
    summary: 'Filing documents, finding them, forms such as leave requests, approvals and the communications journal.',
    body: `The Document centre: All modules > Document centre keeps every paper the business holds - templates and forms, policies and manuals, government and tax papers, staff files, supplier bills, customer documents, contracts, insurance, banking, assets and product images - in folders, each with a number (DOC-000123).

Filing a document: "+ File a document": choose the file (PDF, pictures, Word, Excel and the like), the category and folder, and link it to the record it belongs to (supplier, bill, staff member, customer, product, asset). Set the issue and expiry dates where they apply. Supplier invoices scanned or attached in Payables and Receive Stock, and signed customer invoices, are filed here by themselves. Confidential documents are only shown to people allowed to see them, and every open and download is logged.

Finding a document: search the Library (the text inside Word, Excel and PDF files is searched too), browse folders, look By record (everything for one supplier or customer), or see Expiring.

Forms and leave: Forms & templates lets you fill in a leave form, letter or report. It goes to Approvals for a manager, and your own are under My documents. On a phone, use the "Leave & forms" tile in the Mobile app.

Assets: the Assets tab is the register of equipment and other assets, with their documents.

Communications journal: Communications shows every email, SMS, portal chat, AI / WhatsApp / phone conversation and web inquiry in one timeline. Calls, letters and visits can be logged by hand. Only business channels are recorded.`,
    questions: [],
  },
  {
    key: 'stores-suppliers', title: 'Branches, departments and the supplier portal', sort: 150, quiz: false, roles: ['owner', 'manager'],
    summary: 'Store locations, departments, stock transfers and giving suppliers a portal login.',
    body: `Stores and branches: All modules > Department store. Each store holds its own stock and contains departments. One store is the default - existing stock and tills live there. New stores start empty; move stock in with a transfer.

Stock transfers: draft a transfer from one store to another, then post it; the stock moves in one step.

Departments: a department is a set of product categories. When the department rule is on, a counter agent can only sell their department's categories; anything else needs a manager's PIN on the till (it covers that part for 30 minutes and is logged). Departments and staff assignments are set up from the Terminal journal > Departments. Inventory by department and Sales by department are on the Department store page.

Supplier management: All modules > Supplier management. Give a supplier a portal login so they can manage their items and price list, consignment stock, retail orders and their account. The credit limit there is what the supplier extends to us. Publish supplier training notes on the Training tab.

The supplier portal: suppliers sign in separately (they can never reach the admin). They see what we owe them and its aging, load items and price lists (compared with our lost sales and costs), run consignment, see their order queue, and read reports on their items.`,
    questions: [],
  },
  {
    key: 'settings-security', title: 'Settings, security and system management', sort: 160, quiz: false, roles: ['owner', 'manager'],
    summary: 'Company and print settings, till rules, sign-in security, the audit log and system management.',
    body: `Company & Print Settings: Settings > Company & Print Settings holds the company name, address, phone, email, website and logo (printed on invoices and receipts if ticked), the default print template (thermal receipt or A4 invoice, printed automatically at checkout), the quote validity in days, sales reps and the POS terminal rules - for example requiring an operator to unlock the terminal with their PIN, re-locking after every sale.

Sign-in security: All modules > Security and audit log. My sign-in sets up your own 2-step sign-in. Staff shows each person's 2-step status and lets a manager unlock an account or reset 2-step. Sign-in rules set the lockout (wrong passwords in a row lock the account for a time), the idle timeout, and the 2-step policy: off, required for remote sign-in, required for managers, or required for all staff.

Audit log: every change a staff member makes is recorded with who, when and from where (passwords and PINs are never stored). Managers read it under Security > Audit log or System management > Audit trail.

System management: All modules > System management. Overview, Help desk (every staff member can raise a ticket and follow it), Equipment (register, maintenance, receipts and manuals), Change log, System health, Threats (attacks and suspicious sign-ins, with what to do), Security, Incidents, Risks, Network, Audit trail, Audit exceptions and Access reviews. Blocking an address, locking an account or signing someone out is done from a threat.

The AI parts assistant: All modules > AI parts assistant has Conversations (waiting for a person first), Usage and cost, and Settings, where it is switched on. It needs the Claude API key on the shop server. See the AI assistant lesson for handing over.

Backups and the shop server: the till machine holds the shop database. Do not switch it off during opening hours. Terminals connected to it are listed from the till's server button.`,
    questions: [],
  },
];

// The management SOPs from the restructuring plan, as reference for owners and managers (no quiz).
const MANAGEMENT_SOPS = `SOP-04 Pricing and quote approval: every quote is calculated at pocket price after rebates, freight, returns and allowances. Approval: margin at or above target - sales rep; up to 5 points below target - sales director; below that - CFO. No unapproved rebates or allowances. Quarterly review of cost indices; annual list price update.

SOP-06 SKU rationalisation: classify SKUs by gross profit (A/B/C) and demand variability (X/Y/Z); flag SKUs with no sale in 12 months or margin below threshold; decide keep, special order, or discontinue and liquidate. A new SKU needs a business case (vehicles covered, forecast, margin, catalogue data).

SOP-07 Inventory planning: stocking policy by class; review replenishment suggestions weekly; review aged stock monthly - over 180 days triggers a liquidation plan, over 365 days a reserve or write-off. Cycle counts: A monthly, B quarterly, C yearly. Count accuracy at least 98%.

SOP-08 Procurement: three bids above the set amount; no purchase order without an agreed price; quarterly supplier scorecard (cost, quality, delivery).

SOP-09 Credit and collections: every account customer has a credit limit reviewed yearly. Reminder at 1 day past due, call at 15 days, credit hold at 45 days.

SOP-10 Returns and cores: returns need a reason; inspect and grade each return (restock, refurbish or scrap); track cores and core credits; monthly review of return reasons.

SOP-12 Headcount: no hiring outside the approved budget; requisitions approved by the function head and the CFO; monthly headcount, overtime and turnover report.

SOP-13 Distribution: order cut-offs and delivery promises by channel; expedites need a manager's approval with a reason.

Governance: weekly cash meeting (13-week cash forecast), monthly business review (KPI dashboard: gross margin, fill rate, inventory days, overtime, lost sales).`;

// Runs at every start. A missing module is added. A module nobody has edited
// (updated_by is still empty) is brought up to date with the text here, and
// gets any new questions; questions already there are left alone, because
// past quiz attempts point at them. A module a manager has edited is never
// touched again.
async function seed(query) {
  let added = 0;
  const same = (a, b) => JSON.stringify(a == null ? null : a) === JSON.stringify(b == null ? null : b);
  for (const m of MODULES.concat([{ key: 'management-sops', title: 'Management SOPs (reference)', sort: 200, quiz: false, roles: ['owner', 'manager'], summary: 'Pricing approval, stock policy, procurement, credit, returns and governance.', body: MANAGEMENT_SOPS, questions: [] }])) {
    const want = { title: m.title, summary: m.summary, body: m.body, sort: m.sort, quiz: m.quiz !== false, practice: !!m.practice, roles: m.roles || null };
    const { rows: had } = await query(`SELECT id, updated_by, title, summary, body, sort, quiz, practice, roles FROM training_modules WHERE key = $1`, [m.key]);
    let id, touched = false;
    if (!had.length) {
      const { rows } = await query(
        `INSERT INTO training_modules (key, title, summary, body, sort, quiz, practice, roles) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (key) DO NOTHING RETURNING id`,
        [m.key, want.title, want.summary, want.body, want.sort, want.quiz, want.practice, want.roles]);
      if (!rows.length) continue;
      id = rows[0].id; touched = true;
    } else {
      if (had[0].updated_by != null) continue;
      id = had[0].id;
      if (Object.keys(want).some((k) => !same(had[0][k], want[k]))) {
        await query(`UPDATE training_modules SET title = $2, summary = $3, body = $4, sort = $5, quiz = $6, practice = $7, roles = $8, updated_at = NOW() WHERE id = $1`,
          [id, want.title, want.summary, want.body, want.sort, want.quiz, want.practice, want.roles]);
        touched = true;
      }
    }
    const { rows: qs } = await query(`SELECT question, sort FROM training_questions WHERE module_id = $1`, [id]);
    const have = new Set(qs.map((q) => q.question));
    let i = qs.reduce((s, q) => Math.max(s, q.sort || 0), 0);
    for (const [q, choices, answer, explain] of m.questions) {
      if (have.has(q)) continue;
      await query(`INSERT INTO training_questions (module_id, question, choices, answer, explain, sort) VALUES ($1,$2,$3,$4,$5,$6)`, [id, q, JSON.stringify(choices), answer, explain, (i += 10)]);
      touched = true;
    }
    if (touched) added++;
  }
  return added;
}

module.exports = { seed, MODULES };
