# Loans, rent and other regular bills: how to

On the till, under **Receivables** and **Payables** (admin screens). Everything
posts to the ledger by itself. New accounts in the chart: **2500 Loans Payable**,
**7100 Rental Income**, **7200 Interest Income**, **7300 Late Fee Income**,
**8100 Interest Expense**.

---

## 1. A loan the business has taken

**Before you start:** the lender (bank, credit union, person) must exist as a
supplier. Add them on the Suppliers screen if they don't.

1. **Payables → Loans → Register a loan.**
2. Fill in the amount, interest % a year, number of instalments, how often,
   repayment type (*Fixed payment* for an ordinary bank loan), the date the
   money came in and the first due date.
3. **Show the schedule** to check the payments against the lender's letter.
4. **Paid by:** choose *Standing order* if the bank takes it automatically,
   or *Paying it ourselves* to get an email a few days before each payment.
5. **The money:** *Record it as a deposit into…* (choose the bank account),
   or *Already in the books* for a loan that was running before. For an
   older loan, enter **today's balance**, the instalments **left** and the
   **next** due date.
6. **Register.**

On each due date the till raises a **bill from the lender**: principal to
Loans Payable, interest to Interest Expense. Pay it with **Pay bills** like any
other bill. For a standing order, pay it when the debit shows on the bank
statement, so it ticks off in the reconciliation.

- **Pay extra off the principal:** open the loan → *Pay extra…*. The lump sum
  is billed now and the instalments left are worked out again, each one smaller.
- **Rate changed / loan restructured:** *Change rate / instalments*.
- **A bill was wrong:** void it in Payables, then *Bill again* on the loan.
- *Bill now* raises a coming instalment early, if you're paying ahead.

## 2. Rent from a tenant (or any regular charge)

The tenant is a customer. Open them in **Receivables → Customer centre**.

- **One invoice:** *New invoice*. The account defaults to Rental Income. Add
  GCT (the *15%* button) only if the rent is GCT-able (commercial rent while the
  business is GCT-registered; residential rent is exempt).
- **Every month:** *New recurring invoice*. Give it a name ("Unit 2 rent"),
  the first period date (e.g. the 1st), and *Due (days after)* (e.g. 7). Write
  the line as `Rent for {period}` and each invoice reads "Rent for November
  2026". You can add an end date or a number of months.
- Each period's invoice is raised on its date and goes on the tenant's account.
  It appears in ageing, collections, statements and Receive payment like a
  charge sale.
- **Receive payment** works as before. The rent invoices are in the list.
- *Change* applies from the next period. *Pause* stops it, and *Resume* asks
  whether to bill the months missed while paused. *End* stops it for good.
  *History* lists every invoice it raised.
- **Receivables → Recurring invoices** lists every tenant's plans and what is
  coming up in the next 30 days.

## 3. Late fees

Set them on the recurring invoice (that agreement), or for the whole customer
under **Reminders & late fees** (covers that customer's invoices raised on the
books from that day on).

- *Flat amount* or *% of what is open*, charged after the *grace* days.
- *Once per invoice* or *Every month while unpaid*. Optional minimum / maximum.
- The fee is its own invoice ("late fee") on the account, posted to Late Fee
  Income, and noted in the collections notes.
- **A promise to pay** logged in the collections notes **holds the fee** until
  the promise date. If it isn't paid by then, the fee is charged.
- **To waive a fee:** click *Waive* next to it in Open invoices and give the
  reason. It's reversed in the ledger and won't be charged again for that
  period. You can't waive a fee that has a payment on it; void the payment first.
- Fees are never charged on till sales, and never on another fee.

## 4. Automatic reminders

Customer → **Reminders & late fees** → tick *Email reminders*. Defaults:
3 days before due, on the due date, and 1, 7 and 14 days after.

- Uses the same reminder email as the *Email a reminder* button, and each one
  is logged in the collections notes.
- **No emails after day 14.** From day 15 the credit procedure is a phone call;
  the customer stays on the Collections worklist.
- A promise to pay stops the overdue reminders until its date. A credit hold
  stops the "coming due" reminders (overdue ones still go).
- No email address on file: nothing is sent, and the note says "phone them".
- Reminders go out between 8 am and 6 pm, and each one only once.

## 5. Standing orders and fixed monthly bills

**Payables → Recurring bills → New recurring bill**: supplier, amount and
account (e.g. 6430 Telephone and Internet), GCT, how often, and *Paid by*.

- *Standing order:* the bill is raised on its date. Pay it when it's on the bank
  statement.
- *Paying it ourselves:* the accounts email (the shop email in Settings) gets
  a list of what's due a few days ahead.

## 6. The Loans & Rent page (register and outputs)

**Admin → Money → Loans & Rent** (it opens on the till, also from the website).

- **Register:** every loan, rental agreement and recurring bill on one list,
  with the amount per period, next due date, balance, overdue and status.
- **Documents:** everything they produced: invoices, late fees, payments
  received, loan instalment bills, recurring bills, and reminders sent.
- **Search and filters:** type in names, numbers, tenants or lenders. Filter by
  type, status, a date range (next due date in the Register, document date in
  Documents) and *Overdue only*. The totals line adds up whatever is shown.
- **Print / PDF** prints what's on screen (choose *Save as PDF* in the print
  window). **Excel / CSV** downloads it as a file Excel opens.
- On each row:
  - *Statement*: the tenant's statement of account. The From / To filter dates
    set the period; with no dates it covers the last three months.
  - *Schedule*: the loan schedule with the principal / interest split, what's
    been billed, the balance, and interest per year (for the accountant).
  - *Invoice*: a rent invoice or late-fee invoice.
  - *Receipt*: a receipt for a payment received.
- Every document can be printed or sent by **Email** (the full document),
  **SMS** or **WhatsApp** (a short summary with the amount due). It goes to the
  email or phone number on the customer's or lender's record. Fix the record
  first if it's wrong; you can't type in a different address here. WhatsApp
  opens with the message ready: press send there. Everything sent is in the
  notifications log, and for customers in the collections notes too.

## 7. Categories and classes (as in QuickBooks)

A **category** is an account in the chart (use sub-accounts for detail, e.g.
6400-1 Rent: Warehouse). A **class** tags a line by store location or activity
so profit can be split. Both go to QuickBooks in the IIF export.

- **Bills, invoices, cheques / spend money, receive money and journals:** every
  line has a *Category (account)* and a *Class*.
- **Defaults:** on a customer's page (Receivables) set *Accounting defaults*:
  the category and class new invoice lines start with (e.g. a tenant: Rental
  Income, class Rentals). On a supplier's page (Payables) set the *usual expense
  account* and *usual class*. You can still change any line.
- **Till sales:** each product category posts to its income and cost accounts
  (**Accounting → Posting rules**; all start at Sales - Parts / Cost of Goods
  Sold). One product can have its own accounts there under *Products with their
  own accounts* (e.g. a "Shop rent" product → Rental Income). Till sales take
  their till's store class automatically.
- **Classes:** **Accounting → Classes.** Each store location has one
  automatically; add your own (Rentals, Workshop…). A class in use can be
  retired, not deleted.
- **Reports:** **Accounting → Reports.**
  - *Profit & loss by category*: choose the dates and a class, or tick *A column
    per class*. Click any amount to see the lines behind it.
  - *Expenses by supplier and category* and *Sales by customer and income
    category*.
  - Each one has *Print / PDF* and *Excel / CSV*. Classes and names start from
    19 Oct 2026; older lines show as Unclassified / "(no name)".
- **Bank statement rules** (Banking → Statement import → Statement rules): a
  rule sends lines containing its text to *one account*, or *splits* them
  (fixed J$, a %, and "the rest"), e.g. a loan debit: J$9,000 to Interest Expense,
  the rest to Loans Payable. *Preview* tries it on an amount. In review, a
  split line shows *Add as split*; to opt out for that line, pick one account
  and press *Add*.

---

**If the till was off for a while:** missed periods are caught up when it
comes back. A plan more than 3 periods behind is *paused* instead of billing
everything at once; open it, press *Resume*, and choose whether to bill the
missed periods.

## 8. The new-part, purchase-order and receiving forms

**Parts department → + Add new part**, **Purchase orders → + New purchase
order** and **📦 Receive stock without a PO** are now split into tabs, like
QuickBooks. Move between tabs by clicking them or with *Back* / *Next*; *Save*
works from any tab.

- A **\*** on a tab means it holds something required (fill that tab first).
- If something is missing or wrong when you save, the tab with the problem gets
  a **red dot**, opens by itself, and the box is outlined in red.
- Every box has a small **ⓘ**: point at it (or tap it on a touch till) for a
  plain explanation of what goes there.
- **Add new part:** General (photo, name, category…) · Pricing · Stock & bins ·
  Supplier · Accounting (the part's own income / cost account, on the till
  only) · More photos.
- **New purchase order:** Supplier & dates · Lines (add the parts and their
  costs now, or later on the order) · Shipping & terms · Notes. Saving creates
  the order with its lines and opens it.
- **Receive without a PO:** Supplier & invoice · Parts received · Review &
  receive (check the count and cost, then *Receive*).

## 9. Purchasing: Purchase Orders and Receive Stock

Both are now under **🛒 Purchasing** in the admin menu (on the website they open
the till, because stock and bills belong in the till's books).

**Receive Stock** is one screen for every delivery:

1. **Source**: *Against a purchase order* (pick it) or *No purchase order*
   (pick the supplier). Set the date received if it was not today. From a PO's
   own page, *📥 Receive Stock for this PO* opens it ready to go.
2. **Items**: with a PO, type how many of each line arrived
   (*Everything outstanding arrived* fills them all). Without a PO, search the
   parts and give quantity and cost.
3. **Supplier bill**: bill number, bill date, due date (blank = from the
   supplier's terms), subtotal, GCT, freight and the bill total (it must equal
   subtotal + GCT + freight). Untick *The supplier's bill came with it* if it
   has not arrived; enter it later in Payables → Enter a bill.
4. **Tally & post**: the value that arrived is compared with the bill's
   subtotal. Within J$1 it just posts. Otherwise choose why:
   - **Back order**: the bill includes goods still to come. With a PO, the rest
     stays on it; without one, a back-order PO is opened for the difference.
     When the rest arrives, receive it with the bill box unticked (it is
     already billed).
   - **Bill adjustment**: the supplier's price differs (goes to Purchase Price
     Variance).
   - **Supplier credit due**: they overcharged and owe a credit (goes to
     Supplier Claims Receivable; collect it as a supplier credit).
   - **Other**: pick the account and write a note.

The bill then sits in **Payables** (pay it with *Pay bills*, also for a
standing order once it is on the statement). A PO billed this way shows its
bills on the PO page and is not billed a second time.
