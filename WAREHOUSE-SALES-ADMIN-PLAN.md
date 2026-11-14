# Morty's Auto: Warehouse, Sales, Cashier and Admin upgrade plan

Written 2026-10-14 from a read of `app/server.js`, `app/schema.sql`, `app/migrations/` and the existing pages. Nothing has been changed yet.

## 0. Fix first: the critical security issues from the 13 Sep audit are still open

| Audit item | State today |
|---|---|
| **C1:** `POST /api/auth/reset-default-admin` (server.js:2279) | **Still unauthenticated.** Anyone on the internet can reset the admin password to `password123` and sign in. |
| **C2:** `db-config.json.bak-melthahonda` and `portable.json.bak-melthahonda` in `app/` | **Still present.** The deny-list regex doesn't match them, and the server answered HTTP 200 for one of them. |

Everything below adds more data and money flows (AP, costing, purchasing), so these two must be fixed first. Once they are fixed, change the database password and the admin password.

## 1. What already exists (we build on it, not replace it)

| Area | Existing pieces |
|---|---|
| Purchasing | `suppliers` (with `lead_time_days`), `purchase_orders` and items, partial receive, supplier invoice number/date/total, payment terms, due date, `purchase_order_payments` |
| Item master | `barcode`, `bin_location`, `location`, `cost_usd`, `costing_method`, `reorder_point` / `reorder_qty`, alternate part numbers, substitutes, kits, serials, multiple images |
| Receiving | `POST /purchase-orders/:id/receive` adds stock, sets cost, and optionally sets price and bin in the same step |
| Stock control | `stock_counts` + items (full / bin / category scope, variance, post); `GET /bin/:bin`; `warehouse_activity` (qty before/after, bin, who) |
| Outbound | `pickslip.html` (print only); `deliveries` (driver, status, proof photo and signature); shipping and tracking number on sales |
| Cashier | POS sales, holds, returns, quotes, cash drawer sessions, coupons, gift cards, price tiers and breaks |
| Data | Legacy exports with years of history: `INVOICE.csv`, `INVDETAI.csv` (sales lines), `INVREC.csv` (receipts), `INVPAY.csv`, `INVENTRY.csv` |

## 2. Gaps against what you asked for

### Warehousing
- **Receiving batches.** Receiving writes straight onto the PO lines. There is no receipt (GRN) record with a batch number, who received it and when.
- **Labels.** There is a barcode field but no label generation or printing: no item, batch, bin, package or shipping labels.
- **Putaway.** There is no step for "scan batch → scan shelf → confirm", and no record of who shelved each batch.
- **Multiple bins.** A product has one `bin_location` text field. Stock-per-bin needs a `bins` table and a stock-by-bin table.
- **Pick tasks.** There is no picker assignment, scan-to-confirm, progress tracking or pick route sorted by bin.
- **Packing and shipping.** There are no packages, cartons or pallets, no packing label per package, no shipping label and no manifest.
- **Tracking.** There is no event timeline from picked through packed, shipped, out for delivery and delivered. Counter pickup has no scan-out.
- **Counts.** Counts aren't scan-driven. There are no blind counts, no recount on variance and no photos.
- **Phone scanning.** Nothing uses the phone camera to scan.

### Sales
- **Lost sales.** Nothing is recorded when a customer asks for an item that isn't stocked or is out of stock, or when a quote isn't converted.
- **Order queue.** There is no single queue for counter, online, phone and WhatsApp orders.

### Cashier
- The cart is mostly done. It still needs scan-to-cart from a phone, and a "pickup collected" scan tied to the order.

### Administration
- **Reorder suggestions.** Nothing uses sales history, lead time and safety stock to draft POs for each supplier.
- **Costing.** On receive, cost is **overwritten with the latest PO cost**. It isn't averaged, and freight, duty and brokerage aren't added. That makes margins on the reports unreliable.
- **Pricing.** There are no pricing rules (markup by category or tier, rounding, JMD/USD exchange rate) applied when goods are received.
- **Supplier bills.** There is no three-way match of PO, receipt and supplier bill before a bill is confirmed as payable. There is also no backorder tracking for short-shipped lines.

## 3. The item cycle we are building

```
Sales history ──► Reorder suggestion (demand × lead time + safety stock) ──► Draft PO per supplier ──► Send PO
                                                                                           │
Supplier delivers ──► RECEIVE against PO: batch no., qty, who/when, photos ◄───────────────┘
      │               ├─ short lines → BACKORDER (tracked until filled or cancelled)
      │               ├─ Landed cost: freight/duty/customs/brokerage/FX spread over lines → weighted-avg cost
      │               ├─ Pricing rules → new sell price (review screen)
      │               └─ Supplier bill matched to PO + receipt → confirmed PAYABLE (due date from terms)
      ▼
Print item/batch labels ──► PUTAWAY: shelver scans batch → scans bin → confirm (who/when per batch)
      ▼
Stock on shelf (per bin) ◄── CYCLE COUNT: scan bin → count → confirm; recount on variance; photos
      ▼
Order (counter / online / phone) ──► Pick task + pick slip (barcodes), route-sorted by bin
      │                               picker scans bin + item; progress %, who/when
      ▼
PACK: package / carton / pallet → packing label each → shipping label → manifest (per route / carrier)
      ▼
Ship / out for delivery ──► Delivered (photo + signature)    or    Counter pickup: scan out at counter
      ▼
Tracking timeline visible to staff and to the customer (track.html)
Lost sale captured anywhere along the sales path when we can't supply.
```

## 4. Phased build

Each phase can ship on its own and has a test checklist.

| Phase | Delivers | Main pieces |
|---|---|---|
| **0. Security** (≈ 1 day) | Close C1 and C2 | Make the reset endpoint local-only with a key; tighten the deny-list; delete the `.bak` files; you rotate the passwords |
| **1. Foundation** | Scanning and labels everywhere | `bins` and `stock_by_bin` tables (migrated from `bin_location`); a shared phone/USB scanner component (camera via BarcodeDetector / ZXing); Code128 / QR label printing (item, bin, batch); a unified event log |
| **2. Inbound** | PO → receive → cost → price → putaway → payable | Reorder suggestions from history; GRN with batches; backorders; landed-cost allocation and weighted-average cost; pricing rules on receipt; putaway by scan; three-way match and confirming the bill as payable |
| **3. Outbound** | Order → pick → pack → ship → deliver | A single order queue; pick tasks with picker, progress and route-sorted pick list; packages and pallets with packing labels; shipping label; manifest; tracking timeline; counter pickup scan-out |
| **3a. Cashier module** (with Phase 3) | All in-house payments in one place | Standalone cashier stations; order terminals assigned to them; live payment queue; split tenders; drawer sessions, X/Z reports; integrated mode for single-user shops. See section 12 |
| **4. Stock control** | Accurate stock | Scan-based bin counts, blind count, recount rules, photos, variance approval, ABC cycle-count schedule |
| **5. Sales and planning** | Visibility | Lost-sales capture and report; planning dashboard (fill rate, inventory days, dead stock, pick accuracy, supplier lead-time actuals); links to the restructuring KPIs |
| **6. Displays and customer status** | Wall screens and customer visibility | Management pick board; customer "order status" board; notification when an order is ready; pickup verification codes |
| **7. Accounting backbone** | Every transaction coded | Chart of accounts; posting rules; journal for every sale, return, receipt, payment, adjustment and payout; QuickBooks export; month-end tie-out report |
| **8. People, roles and commission** | Control and pay | Permission-based roles; department/terminal item filtering with manager override; terminal transaction journal; full commission module; remote freelance reps; careers and applicant tracking |
| **9. Inventory to marketing** | Turn bad stock into cash | Overstock, aged, dead, damaged and returned stock classification → marketing lists, clearance pricing, campaign links |
| **10. AI sales agents and staff assistant** | Automated selling and training | Counter kiosk agent; phone agent; customer profile capture; lost-sale and upsell logging; in-app trainer/assistant for live staff; send-a-link (video/offer) |

## 5. Decisions (answered 2026-10-14)
1. Security first: **yes**. Code is done; it needs a server restart and password rotation.
2. Start with: **Phase 1 + 2 (Foundation + Inbound)**.
3. Labels: **both** thermal (2"×1", 4"×6") and A4 sheets.
4. Payables: **in this app, with a QuickBooks export**.
5. Still open: base currency (prices are in `*_usd` columns while the shop prices in J$) and the exchange-rate source.

---

## 6. Displays, customer status and notifications (Phase 6)

**Management pick board** (`/board/picking`, TV in kiosk mode, auto-refresh via server-sent events):
- Each open order shows order no., customer first name and initial, source (counter/online/phone), picker, lines picked / total, a % bar, minutes waiting, and status (Queued, Picking, Packing, Ready, Held, Out for delivery).
- Colour alerts when an order passes its SLA (e.g. counter orders over 10 min, online orders over 2 h).
- Picker leaderboard: lines per hour and pick accuracy.

**Customer status board** (`/board/orders`, screen at the counter, like a restaurant pickup board):
- Shows order no. and masked name only (e.g. "#1042 · Damion M."). No phone numbers, addresses or amounts.
- Columns: Preparing → Ready for pickup.

**Customer tracking:** `track.html` is extended to cover parts orders as well as service. Customers see a timeline (Order received → Paid → Picking → Packed → Ready / Out for delivery → Collected / Delivered).

**Notifications** go by SMS (Twilio, already wired in `sms.js` but not configured), email (`mailer.js`) and WhatsApp (via the Twilio WhatsApp API or a click-to-chat link). They are sent on: order confirmed, payment received, ready for pickup, out for delivery, delivered, backorder ETA changed.

**Pickup verification:**
- Each order gets a one-time **6-digit pickup code** and a QR code, sent with the "ready" message.
- At the counter, staff scan or enter the code. The system shows the order, payment status and the name on the order.
- The order is released only if the code matches **and** the order is paid (or on an approved account).
- Optional ID check and signature or photo capture are recorded against the order.
- Third-party collection: the customer can name a collector, who must present the code and ID.
- Wrong codes are rate-limited and logged.

**Management holds:**
- Managers can put a delivery or order on **hold**, with a reason code (credit, fraud check, stock query, customer request) and a release-by person.
- A held order can't be picked, released or dispatched.
- Holds appear on the board and in the reports.

**Delivery department reports:**
- Deliveries per driver and route
- On-time %
- Failed or attempted deliveries
- Average time from ready to delivered
- Proof-of-delivery exceptions
- Delivery fees collected vs cost
- Pickups uncollected after X days

## 7. Accounting backbone (Phase 7)

Today nothing posts to a general ledger, so transactions can't be tied back to the accounts.

- **Chart of accounts** table, mirroring the QuickBooks accounts, with mapping rules by transaction type, payment method, product category and tax.
- **Journal**: every event writes a balanced journal entry. Events include:
  - sale (revenue, tax, COGS, inventory)
  - return
  - receipt against a PO (inventory, GRNI)
  - supplier bill (GRNI, landed-cost accounts, AP)
  - supplier payment
  - customer payment, account payment, gift card, coupon
  - petty cash
  - stock adjustment, damage write-off, count variance
  - commission accrual and payout
  - delivery fee
- **Controls:** entries are immutable. Corrections are reversing entries. Period close locks a month.
- **Export:** a QuickBooks import file (IIF for QuickBooks Desktop 2018) of daily summarized journals, plus a full-detail CSV.
- **Tie-out report:** till cash vs deposits, AR, AP, inventory and GRNI balances vs the ledger.

## 8. People, roles, terminals and commission (Phase 8)

**Roles and security:**
- Move from role names to **permission-based roles** (e.g. `pos.sell`, `pos.discount.10`, `pos.override_department`, `po.approve`, `stock.adjust`, `reports.finance`).
- Per-user overrides; manager PIN approvals for sensitive actions.
- Session timeout, failed-login lockout, 2-step login for admin and remote users.
- Full audit log of who changed what.

**Department and terminal filtering:**
- Users and terminals are assigned **departments** (e.g. Batteries, Tyres, Lubricants, Parts).
- A counter agent who signs in can only search and sell items in their departments.
- A manager can sign in on the same order (PIN or badge) to add items from any department. The override is logged.

**Terminal transaction journal:**
- Every action at a terminal is recorded with user, terminal, time, before and after: item added or removed, price change, discount, void, no-sale drawer open, refund, hold/recall.
- There's a monitoring screen and exception alerts (voids above X, no-sales, refunds without receipt).
- Optional: link CCTV timestamps to transactions if the shop's cameras support it.

**Commission module** (extends `0042_commission`):
- Rules by rep, item, category or brand: % of sale, % of gross margin, or flat amount, with tiers and targets.
- Split commission when two reps share a sale.
- Clawback on returns and on unpaid account sales.
- Paid only on collected sales (option).
- Statements per rep, approval, payout. Everything posts to the ledger (accrual and payout).

**Freelance and remote reps:**
- A rep portal reachable from the internet, with 2-step login.
- Reps can create quotes and orders for their own customers only.
- They can see price and stock but not cost.
- Each rep gets a referral link and code.
- Orders go into the same queue for staff to fulfil.
- Commission is calculated automatically. Reps can see their own pipeline, sales and earnings.

**Send-a-link:**
- Staff or reps send customers a tracked link by SMS, WhatsApp or email: product page, offer, install video, or quote to accept and pay.
- Every link has an expiry date and records opens and conversions.

**Careers:**
- A public `/careers` page with job posts and an application form (CV upload, consent checkbox).
- Applications land in an applicant-tracking list (stages: New → Screen → Interview → Offer → Hired / Rejected).
- Hired applicants convert into staff user records.
- CVs are stored privately and deleted after a retention period.

## 9. Inventory to marketing (Phase 9)

| Class | Rule (defaults, editable) | Action |
|---|---|---|
| Overstock | On hand > 6 months of demand | Bundle offers, rep incentive (higher commission) |
| Aged / slow | No sale in 6–12 months | Clearance price ladder (-10% / -20% / -30%) |
| Dead stock | No sale in 12+ months, or model years no longer common on the island | Liquidation lot, marketplace listing, return to vendor |
| Damaged | Flagged at receiving, count or return inspection | "Open box / damaged" price, insurance or vendor claim |
| Returned | Customer returns graded A/B/C | A goes back to stock; B is sold as open box; C is a vendor claim or scrapped |
| Discontinued / superseded | Has a newer substitute part | Sell-through, then stop reordering |

These lists feed:
- the website's Clearance section
- coupon campaigns
- WhatsApp and SMS broadcasts (opt-in customers only)
- a marketing worklist

## 10. AI sales agents and staff assistant (Phase 10)

The agents are built on the Claude API, with tools that call this app's own endpoints. This needs an API key and has a per-conversation cost.

- **Counter sales agent:** a kiosk or tablet at the counter and a chat widget on the website.
  - Asks for vehicle (make/model/year) and need, finds fitting parts in stock (alternate and substitute numbers included), quotes prices and suggests related items (pads → rotors, brake fluid, install).
  - Collects the customer's name and phone with consent, creates or updates the customer profile and saved vehicle, and creates the order for payment at the till.
  - When it can't supply an item, it logs a **lost sale** (item, reason, customer).
- **Phone sales agent:** the same agent behind a phone number (Twilio Voice or WhatsApp voice notes).
  - Hands off to a live agent on request, or for complex or high-value orders.
  - Every call gets a summary and transcript stored on the customer.
- **Live-staff assistant and trainer:**
  - A side panel in admin/POS that answers "how do I…" from the SOPs, suggests upsells for the current cart, and flags missing customer info.
  - Guided training mode with practice orders on a sandbox till.
  - Quiz and certification per module; the manager sees completion.
- **Guardrails:**
  - Agents can't give discounts beyond the configured limits, can't take card numbers by voice or chat (payment uses a link or the till), and identify themselves as automated.
  - All agent actions go to the terminal journal.

## 11. Further recommendations

1. **Automatic daily off-site backups** of the database, and a tested restore. The live till and its only database are on one PC.
2. **Move the server off the till PC**, or at least add a UPS and a standby machine. One PC failure currently stops sales, the website and records together.
3. **Customer accounts and credit control:** credit limits and an aging-based hold that ties into management holds.
4. **Supplier portal / emailed POs** with confirmation and ETA updates that feed backorders.
5. **Vehicle fitment data** (make/model/year to part) to power both the AI agent and website search. This is the biggest driver of online sales for parts.
6. **Loyalty and mechanic trade accounts:** points or tiered pricing for repeat garages (`points_transactions` already exists).
7. **Google Business, Facebook and Instagram catalog sync** from the clearance and featured lists.
8. **KPI dashboard** that feeds the restructuring model and the CEO agent's weekly briefing (sales, margin, inventory days, lost sales, fill rate).
9. **Data protection:** Jamaica's Data Protection Act applies to customer profiles, call recordings and CVs. Add consent capture, a privacy notice and retention rules.
10. **Payments:** pay-by-link for phone and remote-rep orders (Fygaro is already integrated) so no card numbers are handled by staff or agents.

## 12. Cashier module (Phase 3a)

All in-house payments go through the cashier module. Order terminals build orders; they don't take money (unless the shop runs in integrated mode).

### Two operating modes (shop setting, can differ per terminal)
| Mode | Used when | Behaviour |
|---|---|---|
| **Separate cashier** | Multi-user shop | Order terminals send orders to a cashier station. Only cashier stations take payment. |
| **Integrated** | Single-user shop, or a terminal with no cashier | The same payment screen is attached directly to the order ("Pay" button on the order). The same drawer rules, receipts and accounting apply. |

### Cashier stations and terminal assignment
- **Each terminal gets a type:** Order terminal, Cashier station, or Both (integrated). These are set in the existing `terminals` register.
- **Assignment table:** a cashier station serves a list of order terminals.
  - One cashier can serve many terminals, and one terminal can have a primary and a backup cashier.
  - Unassigned terminals go to a default "any cashier" pool.
- **Failover:** if a cashier station goes offline, its terminals move to the backup. A manager can also switch an order terminal to integrated mode temporarily, and that is logged.
- **Remote and online orders** (website, freelance reps, phone/AI agent) go to the payment queue, or are paid by a Fygaro pay-link.

### Payment queue (live)
- The cashier sees the orders waiting for payment from their assigned terminals: order no., customer, sales rep, item count, total, time waiting.
- The customer gives the order number or the cashier scans the QR on the order slip, then the cashier recalls the order.
- **Cashiers can't change items or prices.** Changes go back to the order terminal, or need a manager override, which is logged.
- **Tenders:**
  - cash (change calculated)
  - card terminal
  - Fygaro pay-link or QR
  - account charge (subject to credit limit and hold)
  - gift card
  - coupon or redemption
  - store credit
  - split payments across any of these
- **Deposits and partial payments** for special orders and backorders. The balance is due at pickup.
- **When payment is complete:**
  - Receipt printed or sent by SMS/email.
  - Order status becomes **Paid**, which releases it to the pick queue. For counter orders already picked, it moves to "Ready for handover".
  - The pickup code is issued.
  - Commission is earned (if the rule is "on payment") and the journal entry is posted.
- **Unpaid orders expire** after a set time (e.g. 4 hours for counter orders), releasing reserved stock and recording a lost sale with reason "abandoned at cashier".

### Refunds and voids
- Refunds are processed at the cashier against the original receipt, back to the original tender where possible.
- Refunds above a limit, and any refund without a receipt, need a manager PIN.
- Voids after payment are refunds, never deletions.

### Drawer and cash control (extends `cash_drawer_sessions`)
- Each session is tied to a **cashier station and a user**. There is one open session per drawer.
- Opening float count by denomination.
- Cash drops to the safe and float top-ups during the day.
- No-sale drawer opens need a reason and are logged.
- **Blind close:** the cashier counts without seeing the expected figure. The variance goes to a manager.
- **X report** (mid-shift) and **Z report** (end of day) show totals by tender, refunds, voids, discounts, drops and variance.
- All of it posts to the ledger (Phase 7) and the terminal journal (Phase 8).

### Customer-facing
- An optional second screen at the cashier shows items, amount due and change. It can show the order status board between transactions.

### Reports
- Payments by cashier and station
- Average wait in the payment queue
- Abandoned and expired orders
- Over/short history per cashier
- Tender mix
- Refunds and voids by user

## 13. Time clock and attendance (Phase 8b, alongside roles and security)

This builds on the existing `time_punches`, `time_entries` and `schedule_blocks` tables. Attendance is tied to sign-in, so being clocked in decides what a user may do.

### Ways to clock in and sign in (any combination, set per user)
| Method | How | Notes |
|---|---|---|
| **Email + password** | Standard sign-in | Lockout after repeated failures; 2-step required for admin and remote users |
| **Barcode / QR badge** | Scan the staff card at any terminal or with a phone camera | Card is revocable and reissued if lost. A badge alone can only clock in; billing also needs a PIN or biometric |
| **PIN** | 4–6 digit PIN on a shared terminal | Fast switch between users at the counter |
| **Biometric (fingerprint / face)** | **WebAuthn / passkeys**: Windows Hello fingerprint readers or cameras, or the phone's fingerprint/face unlock | No special software. **Fingerprints and face data never leave the device**; the system stores only a public key. A USB fingerprint reader that supports Windows Hello can be added to any PC |

**Registration:**
- A manager enrols the staff member's biometric or passkey, prints their badge and sets their PIN on a "Staff enrolment" screen.
- Each enrolment is logged with who enrolled whom and when.

**Buddy-punch protection:**
- Optional photo snapshot at punch time.
- Punches only from approved terminals, or from a phone inside the shop's location/Wi-Fi.
- Biometric is required for clock-in if the shop turns that on.

### Schedules and work hours
- Weekly shift templates per staff member or department, plus holidays and leave.
- **Clock-in outside scheduled hours** (early, late, day off) is accepted, but the user must **confirm it is overtime** and choose a reason. A manager approves or rejects it later.

### "Present" rule for live billing
- A live agent can **sell, take payments or open a drawer only while clocked in on site**:
  - clocked in, at an approved shop terminal or on the shop network, within their shift or approved overtime
- If they're not present, billing screens are locked. They see a "Clock in to start selling" message.
- **Remote assistance:**
  - Users with the `remote.assist` permission may sign in from outside the shop while clocked in as *Remote*.
  - They can look up stock, prepare quotes and orders, and help customers or staff.
  - **They can't take payment or open a drawer.** Remote orders go to the cashier queue or a pay-link.
  - Freelance reps always work in remote mode.

### End of shift
- Warnings 15 minutes and 5 minutes before the shift ends.
- **At shift end the user is automatically signed out of billing and clocked out**, unless an extension is pending or approved.
- An open cashier drawer must be closed or handed over first. The system prompts for that instead of forcing a clock-out mid-transaction.
- **Extending hours:** the agent taps "Request extension", enters how long and a **reason (required)**.
  - An **email goes to the admin/manager and a copy to the agent**: who, the hours requested, the reason, and approve/reject buttons. The links are signed, expire, and are single-use.
  - While waiting, a short grace period (e.g. 15 min) applies. If the request is approved, work continues to the new end time. If it's rejected or expires, the agent is signed out and clocked out.
  - The decision, with who made it and when, is recorded and emailed to the agent.

### Breaks, corrections and payroll
- Break in/out and lunch, with paid or unpaid break rules.
- **Missed punches:** the staff member asks for a correction, a manager approves, and the original stays in the audit log.
- **Timesheets:** regular hours, overtime (daily/weekly thresholds and the rates you set), late arrivals, early leaving and absences.
- Weekly approval, then a **payroll export (CSV)**. Overtime and commission are shown together for payroll.

### Reports and alerts
- Who's in now (also on the management display board)
- Late or absent today
- Overtime pending approval
- Hours vs sales per agent (sales per labour hour)
- Attendance history

## Decisions log (2026-10-14, continued)
- **Exchange rate:** taken from the Bank of Jamaica daily, and editable (manual override, with who and when recorded).
- **Overtime and extension approvals:** emailed to **both** the admin and the department manager.
- **Overtime rules:** configured **per individual** (daily/weekly thresholds and rates for each staff member).
- **Development setup** (approved): database copy `mortysautoparts_dev`; worktree `C:\mhsrc\vision-dev` on branch `wms-foundation-inbound`, port 3099, `VISION_DEV=1` (no email, SMS, payments, LAN discovery or off-site backup).
- **Found and fixed during the restart:** `initDb` reset the admin password to `password123` on every server start. It now creates the admin only if it's missing.
