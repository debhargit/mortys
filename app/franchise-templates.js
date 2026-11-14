'use strict';
// =============================================================================
//  Franchise document templates (franchise.js seeds them into the Document
//  centre as editable templates, category "template", tag "franchise").
//
//  Written from common franchise practice: the US FTC Franchise Rule's 23-item
//  disclosure document, the IFA's usual agreement headings, and the sections a
//  franchise operations manual normally has, set to Jamaican law and terms
//  (J$, GCT, TAJ, the Companies Office, the Data Protection Act 2020, the
//  Arbitration Act 2017). Jamaica has no franchise statute, so the disclosure
//  document and the waiting period are good practice here, not a legal duty.
//
//  They are a STARTING POINT. Each one carries a notice saying so, and
//  franchise.js keeps that notice on every copy until a manager records that a
//  Jamaican attorney has reviewed the template.
//
//  {{field}} is filled in. Filled from the records (franchise.js AUTO):
//    company, company_address, company_phone, today, number,
//    recipient, recipient_address, recipient_email, recipient_phone,
//    franchisee, trading_name, principal, franchisee_address, franchisee_trn,
//    territory, territory_desc, effective_date, term_years, term_end,
//    initial_fee, royalty_pct, marketing_pct, tech_fee, min_royalty,
//    renewal_fee, transfer_fee, report_day, royalty_due_day, local_marketing_pct,
//    gct_rate, wait_days, opening_months
//  Everything else is asked for when the document is made.
// =============================================================================

const NOTE = '<div class="draft-note"><b>Starting point only.</b> This template follows common franchise practice. It is not legal advice and has not been checked against your facts. Have a Jamaican attorney review and adapt it before you use it.</div>';

const sig = (left, right) => '<table class="sigs"><tr><td><b>' + left + '</b><br><br><br>Signature: ____________________<br>Name: ____________________<br>Title: ____________________<br>Date: ____________________</td>' +
  '<td><b>' + right + '</b><br><br><br>Signature: ____________________<br>Name: ____________________<br>Title: ____________________<br>Date: ____________________</td></tr></table>';

const TEMPLATES = [
  // ------------------------------------------------------------------ NDA --
  { key: 'nda', title: 'Franchise confidentiality agreement (NDA)', sign: true, fields: [
      { key: 'purpose_note', label: 'What will be shown (optional)', type: 'textarea' },
      { key: 'years', label: 'Years the duty lasts', type: 'number', required: true, default: '3' } ],
    body: NOTE + `<h1>Confidentiality agreement</h1>
<p>This agreement is made on {{today}} between <b>{{company}}</b> of {{company_address}} ("the Franchisor") and <b>{{recipient}}</b> of {{recipient_address}} ("the Prospect").</p>
<h2>1. Purpose</h2>
<p>The Prospect wishes to consider buying a Morty's Auto Parts franchise. To help the Prospect decide, the Franchisor will share information it keeps confidential. {{purpose_note}}</p>
<h2>2. What is confidential</h2>
<p>"Confidential information" means everything the Franchisor shares, in any form, about the franchise system and the business: the franchise disclosure document, the operations manual and procedures, supplier names and terms, prices and margins, sales and financial figures, customer information, site and territory plans, marketing plans, the till and stock system, training material, and any copy, note or summary of these.</p>
<p>It does not include information that (a) is public through no fault of the Prospect, (b) the Prospect already lawfully had without a duty of confidence, (c) the Prospect receives lawfully from someone else free to share it, or (d) a law or court requires the Prospect to disclose, provided the Prospect first tells the Franchisor (where allowed) and discloses only what is required.</p>
<h2>3. The Prospect's promises</h2>
<ul><li>Use the confidential information only to decide whether to buy a franchise.</li>
<li>Not share it with anyone except their own attorney, accountant, banker or business partner who needs it for that decision and who is told it is confidential. The Prospect is responsible if any of them break this agreement.</li>
<li>Keep it safe, make no copies except those needed, and not take photographs of it.</li>
<li>Not use it to set up, help or invest in a competing auto-parts or auto-service business.</li>
<li>For 12 months, not hire or approach any employee of the Franchisor or its franchisees met through this process.</li>
<li>Return or destroy all of it, including notes and electronic copies, within 7 days of being asked, and confirm in writing that this has been done.</li></ul>
<h2>4. Personal information</h2>
<p>Each party will handle any personal information it receives in line with the Data Protection Act, 2020. The Franchisor may keep the Prospect's application details to assess the application and will not sell them.</p>
<h2>5. No franchise yet</h2>
<p>This agreement does not grant a franchise, a licence to use the Morty's Auto Parts name or marks, or any territory. Neither party is obliged to enter a franchise agreement. Any franchise will only exist under a signed franchise agreement.</p>
<h2>6. How long it lasts</h2>
<p>The Prospect's duties last for {{years}} years from today, and for trade secrets (such as supplier terms and the operating methods) for as long as they stay confidential. If the Prospect becomes a franchisee, the franchise agreement takes over.</p>
<h2>7. Remedies</h2>
<p>A breach could cause harm that money cannot fully repair. The Franchisor may ask a court for an injunction as well as damages, and the Prospect will pay the Franchisor's reasonable legal costs if a breach is proved.</p>
<h2>8. General</h2>
<p>This agreement is governed by the laws of Jamaica, and the courts of Jamaica may hear any dispute. It is the whole agreement on confidentiality between the parties and can only be changed in writing signed by both. If a part is found unenforceable, the rest stays in force.</p>
` + sig('For the Franchisor: {{company}}', 'The Prospect: {{recipient}}') },

  // ------------------------------------------------------------------ FDD --
  { key: 'fdd', title: 'Franchise disclosure document (outline)', sign: true, receipt: true, fields: [
      { key: 'issue_date', label: 'Issue date of this disclosure', type: 'date', required: true },
      { key: 'investment_low', label: 'Estimated initial investment: low (J$)', type: 'text', required: true },
      { key: 'investment_high', label: 'Estimated initial investment: high (J$)', type: 'text', required: true },
      { key: 'franchisor_history', label: 'Item 1: the franchisor, its history and business', type: 'textarea', required: true },
      { key: 'management', label: 'Item 2: directors and managers, and their experience', type: 'textarea' },
      { key: 'litigation', label: 'Item 3: court cases (or "None")', type: 'textarea', required: true, default: 'None.' },
      { key: 'insolvency', label: 'Item 4: bankruptcy or insolvency (or "None")', type: 'textarea', required: true, default: 'None.' },
      { key: 'outlets', label: 'Item 20: outlets open, opened, closed and transferred in the last 3 years', type: 'textarea' },
      { key: 'performance', label: 'Item 19: figures on how outlets perform (or "We make no such statement")', type: 'textarea', default: 'The Franchisor makes no statement about the sales, income or profit of its outlets. Do not rely on any figure given to you that is not in this item.' },
      { key: 'financials', label: 'Item 21: financial statements attached', type: 'text', default: 'Audited financial statements for the last financial year are attached.' } ],
    body: NOTE + `<h1>Franchise disclosure document</h1>
<p><b>{{company}}</b> · {{company_address}} · {{company_phone}}<br>Issue date: {{issue_date}} · Given to: <b>{{recipient}}</b></p>
<div class="box"><b>Read this whole document before you sign any agreement or pay any money.</b> It tells you about the franchisor, the costs, your duties, the territory and how the franchise can end. Take it to an attorney and an accountant. You must receive it at least {{wait_days}} days before you sign the franchise agreement or pay anything other than a refundable deposit.</div>
<h2>Item 1. The franchisor</h2><p>{{franchisor_history}}</p>
<p>The franchise is an auto-parts and auto-accessory store operated under the Morty's Auto Parts name, using the Franchisor's till, stock and online ordering system, approved suppliers and operating methods. Stores sell to two kinds of customer: walk-in do-it-yourself drivers, and commercial (do-it-for-me) customers such as garages and fleets, who buy on account and have parts delivered.</p>
<p>The network has three kinds of store: <b>franchised stores</b> (this document); <b>affiliate stores</b>, independently owned parts shops that join the network as dealer-members, trade under their own name with the network banner, and buy through the Franchisor's distribution centre; and <b>company-owned stores</b>. Stores are supplied from a distribution centre, and larger <b>hub stores</b> carry deeper stock and send parts to the smaller <b>spoke stores</b> near them the same day. You are offered: {{store_type_label}}.</p>
<h2>Item 2. Business experience</h2><p>{{management}}</p>
<h2>Item 3. Litigation</h2><p>{{litigation}}</p>
<h2>Item 4. Bankruptcy and insolvency</h2><p>{{insolvency}}</p>
<h2>Item 5. Initial fee</h2><p>Initial franchise fee: <b>{{initial_fee}}</b> plus GCT, payable when the franchise agreement is signed. It is not refundable except as the agreement says.</p>
<h2>Item 6. Other fees</h2>
<table><tr><th>Fee</th><th>Amount</th><th>When due</th></tr>
<tr><td>Royalty</td><td>{{royalty_pct}}% of net sales (at least {{min_royalty}} a month)</td><td>By day {{royalty_due_day}} of the next month</td></tr>
<tr><td>Brand marketing fund</td><td>{{marketing_pct}}% of net sales</td><td>With the royalty</td></tr>
<tr><td>Technology and system fee</td><td>{{tech_fee}} a month</td><td>With the royalty</td></tr>
<tr><td>Local marketing (spent by you)</td><td>At least {{local_marketing_pct}}% of net sales</td><td>Each month</td></tr>
<tr><td>Renewal fee</td><td>{{renewal_fee}}</td><td>When renewing</td></tr>
<tr><td>Transfer fee</td><td>{{transfer_fee}}</td><td>Before a transfer is approved</td></tr>
<tr><td>Affiliate membership fee (affiliate stores only, instead of the royalty)</td><td>{{member_fee}} a month</td><td>With the monthly invoice</td></tr>
<tr><td>Loyalty programme</td><td>{{loyalty_point_value}} for each point your store gives; you are paid back the same for each point a customer redeems at your store</td><td>With the monthly invoice</td></tr>
<tr><td>Stock bought from the distribution centre</td><td>The dealer cost in the network catalogue</td><td>Invoiced when shipped; due in 30 days</td></tr>
<tr><td>Extra training, audits after a failed audit, late payment interest</td><td>As set out in the agreement</td><td>When charged</td></tr></table>
<p>GCT at {{gct_rate}}% is added where it applies.</p>
<h2>Item 7. Estimated initial investment</h2><p>Between <b>J\${{investment_low}}</b> and <b>J\${{investment_high}}</b>, covering the initial fee, rent deposit, fit-out and signs, shelving, the till hardware, opening stock, licences, insurance, training travel, grand-opening marketing and 3 months of working capital. The figures are estimates; your costs depend on the site.</p>
<h2>Item 8. Where you must buy</h2><p>Parts, stock, signs, uniforms and the till system must come from the Franchisor or approved suppliers, so that quality and fitment are consistent. You agree to buy at least <b>{{commit_pct}}%</b> of your stock (by value) through the Franchisor's distribution centre, under the supply and distribution agreement. The Franchisor earns a margin on the stock it sells you (the difference between its own cost and the dealer cost) and may receive rebates and advertising money from suppliers.</p>
<p>The Franchisor pays you back part of what you buy: a <b>quarterly purchasing rebate</b> on your distribution-centre purchases (the current scale is in the supply agreement), and a <b>co-op advertising allowance</b> of {{coop_pct}}% of those purchases, which you claim against approved local advertising (up to {{coop_claim_pct}}% of what you spend).</p>
<h2>Item 9. Your duties</h2><p>A table of your duties under the agreement (site, opening, training, standards, reporting, insurance, marketing, renewal, transfer) with the agreement section for each.</p>
<h2>Item 10. Financing</h2><p>The Franchisor does not offer financing unless set out here.</p>
<h2>Item 11. The Franchisor's help, and the systems you must use</h2><p>Before opening: site and territory assessment, the store format, layout, opening stock list, initial training and certification, the operations manual, till set-up and opening support. After opening: field visits, refresher training, the brand marketing fund, supplier terms, the distribution centre and hub deliveries, the network parts catalogue, the loyalty programme, and the till and online ordering system. You must open within {{opening_months}} months of signing.</p>
<p>Required systems: the Morty's till (point of sale), its stock and replenishment screens, the electronic parts catalogue and lookup, the ordering link to the distribution centre, commercial delivery tracking, an approved card terminal, CCTV and a backup internet line, as listed in the systems schedule. The technology fee ({{tech_fee}} a month) covers the till software, support and updates; hardware is bought by you.</p>
<h2>Item 12. Territory</h2><p>{{territory}}: {{territory_desc}}. The Franchisor will not open or license another Morty's Auto Parts shop inside it during the term while you are not in default. The Franchisor keeps the right to sell online and to serve national fleet accounts, sharing those sales as the agreement says. Your commercial customers may be anywhere your delivery routes reach in time, but a commercial customer inside another store's territory is served by that store unless both agree. Company-owned and affiliate stores that were trading in an area before your territory was granted may keep trading there.</p>
<h2>Item 13. Trade marks</h2><p>The Morty's Auto Parts name and logo, and any registration or application at the Jamaica Intellectual Property Office.</p>
<h2>Item 14. Copyright and confidential information</h2><p>The operations manual, training material and the till system belong to the Franchisor and are confidential.</p>
<h2>Item 15. Taking part in running the business</h2><p>The principal, or an approved trained manager, must run the shop day to day.</p>
<h2>Item 16. What you may sell</h2><p>Only approved goods and services, at the brand's standards.</p>
<h2>Item 17. Renewal, termination, transfer and disputes</h2><p>Term: {{term_years}} years. A summary table of renewal, termination with and without a chance to put things right, transfer, non-compete and dispute resolution (mediation, then arbitration in Kingston).</p>
<h2>Item 18. Public figures</h2><p>None, unless stated.</p>
<h2>Item 19. Financial performance</h2><p>{{performance}}</p>
<h2>Item 20. Outlets</h2><p>{{outlets}}</p>
<h2>Item 21. Financial statements</h2><p>{{financials}}</p>
<h2>Item 22. Contracts</h2><p>Attached: the confidentiality agreement, the franchise agreement (or, for affiliate stores, the affiliate store agreement), the supply and distribution agreement, the required systems schedule, the loyalty programme rules, the hub service agreement (hub stores only), the personal guarantee, and the general release used on renewal and transfer.</p>
<h2>Item 23. Receipt</h2>
<p>I, <b>{{recipient}}</b>, confirm that I received this franchise disclosure document and its attachments on the date I sign below. I understand I should not sign the franchise agreement until at least {{wait_days}} days after this date.</p>
<p class="sig">Signature: ____________________ &nbsp; Date received: ____________________</p>` },

  // ------------------------------------------------------------ agreement --
  { key: 'agreement', title: 'Franchise agreement', sign: true, agreement: true, fields: [
      { key: 'opening_deadline', label: 'Latest opening date', type: 'date' },
      { key: 'guarantor', label: 'Personal guarantor(s)', type: 'text' },
      { key: 'special_terms', label: 'Special terms (or leave blank)', type: 'textarea' } ],
    body: NOTE + `<h1>Franchise agreement</h1>
<p>Made on {{today}} between <b>{{company}}</b> of {{company_address}} ("the Franchisor") and <b>{{franchisee}}</b> (TRN {{franchisee_trn}}) of {{franchisee_address}}, trading as {{trading_name}} ("the Franchisee"), whose principal is {{principal}}.</p>
<h2>Background</h2><p>The Franchisor has developed a system for running auto-parts shops under the Morty's Auto Parts name (the "System"). The Franchisee has received the Franchisor's disclosure document at least {{wait_days}} days before signing, has had the chance to take independent legal and financial advice, and wishes to run one shop using the System.</p>
<h2>1. Grant</h2><p>The Franchisor grants the Franchisee the right to run one Morty's Auto Parts shop at an approved site in the territory, using the marks and the System, on the terms of this agreement. The right is personal to the Franchisee.</p>
<h2>2. Territory</h2><p>Territory: <b>{{territory}}</b> ({{territory_desc}}). While the Franchisee is not in default, the Franchisor will not open or license another Morty's Auto Parts shop in it. The Franchisor keeps the right to sell online, serve national and fleet accounts, and run other brands; online orders delivered into the territory are shared as set out in the operations manual.</p>
<h2>3. Term and renewal</h2><p>The term starts on {{effective_date}} and runs for <b>{{term_years}} years</b>, to {{term_end}}. The Franchisee may renew for a further term if it: gives notice 6 to 12 months before the end; is not in default; has brought the shop up to current standards; signs the then-current agreement and a general release; completes any refresher training; and pays the renewal fee of {{renewal_fee}}.</p>
<h2>4. Fees</h2><ul>
<li><b>Initial fee:</b> {{initial_fee}} plus GCT, on signing.</li>
<li><b>Royalty:</b> {{royalty_pct}}% of net sales each month, with a minimum of {{min_royalty}} a month from the 4th month after opening.</li>
<li><b>Brand marketing fund:</b> {{marketing_pct}}% of net sales each month. The fund is used for brand advertising, the website and promotions. The Franchisor will give an annual statement of how it was spent.</li>
<li><b>Technology fee:</b> {{tech_fee}} a month for the till, stock and online ordering system, support and updates.</li>
<li><b>Local marketing:</b> the Franchisee spends at least {{local_marketing_pct}}% of net sales a month on approved local marketing.</li>
<li>"Net sales" means all sales from the shop, less GCT collected, refunds and approved discounts.</li>
<li>The monthly sales report is due by day {{report_day}} and payment by day {{royalty_due_day}} of the following month. GCT is added where it applies. Late amounts carry interest at 1.5% a month and a late fee as the manual sets out.</li></ul>
<h2>5. Site and opening</h2><p>The Franchisee finds a site meeting the Franchisor's criteria, gets the Franchisor's written approval before signing a lease, includes the Franchisor's lease rider, builds and fits out the shop to the approved layout, obtains all permits and licences, and opens by {{opening_deadline}} (in any case within {{opening_months}} months of signing).</p>
<h2>6. Training and help</h2><p>The principal and the shop manager must complete initial training to the Franchisor's satisfaction before opening. The Franchisor gives opening support, field visits and refresher training as described in the manual.</p>
<h2>7. Operations manual, supply and systems</h2><p>The Franchisee runs the store strictly in line with the operations manual, which the Franchisor may update from time to time. All sales go through the Morty's Auto Parts till system, and the store uses every system in the required systems schedule. Stock comes only from the Franchisor or approved suppliers, and at least {{commit_pct}}% of purchases by value come through the Franchisor's distribution centre under the supply and distribution agreement. The store keeps the number of certified staff the certification programme requires, takes part in the loyalty programme, and offers commercial (garage and fleet) accounts and deliveries at the store format's standard.</p>
<h2>8. Marks</h2><p>The Franchisee uses the marks only as the Franchisor directs, only for the shop, and gains no ownership of them. The Franchisee tells the Franchisor at once of any misuse it sees.</p>
<h2>9. Confidentiality and non-compete</h2><p>The Franchisee keeps the manual and all confidential information secret. During the term, and for 12 months after it ends, within the territory and 10 km around it, the Franchisee and its principals will not run or work for a competing auto-parts business. The parties accept these limits as reasonable to protect the System.</p>
<h2>10. Records, reporting and audits</h2><p>The Franchisee keeps full books and records for at least 7 years, sends the monthly sales report, quarterly management accounts and annual financial statements within 90 days of the year end, and lets the Franchisor inspect the shop and audit the books at reasonable times. If an audit finds net sales under-reported by more than 2%, the Franchisee pays the shortfall, interest and the cost of the audit.</p>
<h2>11. Insurance and indemnity</h2><p>The Franchisee carries public liability, property, business interruption, motor (if vehicles are used) and employer's cover at the levels in the manual, naming the Franchisor as an additional insured, and sends certificates each year. The Franchisee indemnifies the Franchisor against claims arising from running the shop.</p>
<h2>12. Transfer</h2><p>The Franchisee may not sell or transfer the franchise, the shop or control of the franchisee company without the Franchisor's written consent, which will not be unreasonably refused if the buyer qualifies and is trained, all money owed is paid, a general release is signed and the transfer fee of {{transfer_fee}} is paid. The Franchisor has 30 days to match any offer (right of first refusal). The Franchisor may assign this agreement.</p>
<h2>13. Default and termination</h2><p>The Franchisor may end this agreement by written notice if the Franchisee: (a) fails to pay money owed and does not pay within 10 days of a notice; (b) breaks the manual or this agreement and does not put it right within 30 days of a notice; (c) fails two audits in 12 months; or, without a chance to put it right, (d) becomes insolvent, abandons the shop, under-reports sales on purpose, is convicted of a serious offence, or seriously harms the brand. The Franchisee may end it if the Franchisor materially breaks it and does not put it right within 60 days of a notice.</p>
<h2>14. After it ends</h2><p>The Franchisee: stops using the marks and the System at once; pays all money owed; returns the manual and all confidential material; removes signs and changes the look of the shop; transfers the shop phone numbers, website and social media accounts to the Franchisor; keeps the non-compete; and, if the Franchisor asks within 30 days, sells it the stock, fixtures and equipment at the lower of cost and fair value.</p>
<h2>15. Disputes</h2><p>The parties first try to settle a dispute by talking, then by mediation in Kingston. If that fails within 60 days, the dispute goes to arbitration in Kingston under the Arbitration Act, 2017, by one arbitrator. Either party may still ask a court for an urgent injunction.</p>
<h2>16. General</h2><p>The laws of Jamaica govern this agreement. The parties are independent; neither is the agent, partner or employee of the other. This agreement, its schedules and the manual are the whole agreement. Notices are in writing to the addresses above or by email. A change is only valid in writing signed by both. If a part is unenforceable, the rest stays in force. {{guarantor}} guarantees the Franchisee's obligations under the attached personal guarantee.</p>
<h2>Special terms</h2><p>{{special_terms}}</p>
` + sig('For the Franchisor: {{company}}', 'For the Franchisee: {{franchisee}}') },

  // ------------------------------------------------------ operations manual --
  { key: 'manual', title: 'Franchise operations manual', sign: true, manual: true, fields: [
      { key: 'edition', label: 'Edition', type: 'text', required: true, default: '1st edition' } ],
    body: NOTE + `<h1>Franchise operations manual</h1>
<p>{{company}} · {{edition}} · Issued to: <b>{{franchisee}}</b> ({{trading_name}}) · Copy {{number}}</p>
<div class="box">This manual is confidential and belongs to {{company}}. It forms part of the franchise agreement. Do not copy it or show it to anyone outside the shop. Return it when the franchise ends.</div>
<h2>1. Using this manual</h2>
<p>The manual sets the standards every Morty's Auto Parts shop keeps, so a customer gets the same service in every shop. "Must" means required; "should" means best practice. Changes are sent as numbered updates; file each one and sign the update log. Ask the franchise support desk ({{company_phone}}) if anything is unclear.</p>
<h2>2. Brand standards</h2>
<ul><li>Use the name, logo, colours (Morty's navy and gold) and signs only as shown in the brand guide. Never change the logo or use it on anything not approved.</li>
<li>Shop front: clean glass, lit sign during opening hours, no hand-written signs. Inside: aisles clear, shelves faced, price labels from the till only.</li>
<li>Uniform: the approved shirt with name badge; closed shoes; neat appearance.</li>
<li>Opening hours: at least Monday to Saturday 8:00 to 17:00 unless agreed in writing.</li>
<li>All advertising, flyers, social media pages and promotions must be approved by the franchisor before use. The shop's social media pages are created by, and belong to, the franchisor.</li>
<li>Only approved products and services are sold. No grey-market or counterfeit parts, ever.</li></ul>
<h2>3. Daily routine</h2>
<p><b>Opening:</b> disarm the alarm, check for damage or signs of entry, switch on the till and sign in, count the float with a second person, check the delivery and pick list, check messages and online orders, open on time.</p>
<p><b>During the day:</b> serve walk-ins first, answer the phone by the third ring, process online orders within 2 hours, receive deliveries against the purchase order.</p>
<p><b>Closing:</b> finish the cashier shift on the till, count the drawer with a second person, prepare the bank deposit, record any variance with a reason, back up checks, lock stock rooms, arm the alarm.</p>
<h2>4. Point of sale and cash</h2>
<ul><li>Every sale goes through the Morty's Auto Parts till. No off-system sales, no cash sales without a receipt. Off-system selling is a serious breach of the franchise agreement.</li>
<li>Give a receipt for every sale. GCT is charged as the till calculates; only a manager may switch it off for a customer with valid exemption papers, which are filed.</li>
<li>Discounts and price changes need the manager PIN. Never invent a discount.</li>
<li>Each cashier works their own drawer. Count the float in and out; variances over J$500 are reported to the franchisee the same day.</li>
<li>Bank the cash daily. Never keep more than the agreed cash limit in the shop.</li>
<li>Card payments only on the approved terminal. Never write down or repeat a card number.</li>
<li>Returns and refunds follow the brand returns policy: receipt required, parts unused and in their packaging, electrical parts as the policy says. Refunds go back to the original method.</li></ul>
<h2>5. Stock and the warehouse</h2>
<ul><li>Buy only from the franchisor and approved suppliers, through purchase orders raised on the till.</li>
<li>Receive every delivery against its purchase order: count, check part numbers and condition, and record shortages the same day.</li>
<li>Check fitment before selling: make, model, year and engine. If in doubt, ask; a wrong part costs a return and a customer.</li>
<li>Cycle counts every week on the till's count list; a full count every quarter, witnessed. Investigate any loss over 0.5% of stock value.</li>
<li>Warranty and core returns are recorded on the till and sent back within the supplier's time limit.</li>
<li>Batteries, oils, fluids and chemicals are stored as their safety sheets say, away from heat and food, with spill kits nearby.</li></ul>
<h2>6. Customer service</h2>
<ul><li>Greet every customer within 30 seconds, even if you are busy.</li>
<li>Ask for the vehicle details, confirm the part with the customer, and explain the warranty.</li>
<li>Quotes are given from the till and are valid for the time printed on them.</li>
<li>Complaints: listen, apologise, record it on the till the same day, fix it if you can. Anything you cannot settle goes to the franchisee within 24 hours and to the franchisor within 72 hours.</li>
<li>Customer details are collected only for the sale and marketing the customer agreed to, and kept as the Data Protection Act, 2020 requires.</li></ul>
<h2>7. People</h2>
<ul><li>The franchisee is the employer of the shop's staff and is responsible for contracts, pay and statutory deductions (PAYE, NIS, NHT, Education Tax, HEART/NSTA) and filing them with TAJ on time.</li>
<li>Every new staff member completes the brand training lessons for their role before working alone on the till, and signs the staff confidentiality agreement.</li>
<li>Staff conduct follows the franchisee's staff handbook, which must meet at least the brand's code of conduct.</li></ul>
<h2>8. Health and safety</h2>
<ul><li>Keep fire exits clear and marked. Fire extinguishers are serviced every year and checked monthly.</li>
<li>A stocked first-aid kit and a trained first-aider on every shift.</li>
<li>Lift safely: team lift anything over 20 kg (engines, transmissions, batteries in bulk). Use the trolley.</li>
<li>Battery acid or oil spill: use the spill kit, gloves and goggles; never wash it into drains. Used oil and old batteries go to an approved recycler, with a receipt kept.</li>
<li>Report any injury, near miss, robbery or fire to the franchisor within 24 hours, and as the law requires.</li></ul>
<h2>9. Security and data</h2>
<ul><li>Each person uses their own till login and PIN. Never share them.</li>
<li>CCTV covers the till, the door and the stock room, and recordings are kept at least 30 days.</li>
<li>Customer and franchise data stay in the Morty's system; do not export or copy them to personal devices.</li></ul>
<h2>10. Reporting and payment</h2>
<ul><li>Monthly sales report: by day {{report_day}} of the next month, from the till's sales summary, sent through the franchisee link.</li>
<li>Royalty ({{royalty_pct}}%), brand fund ({{marketing_pct}}%) and technology fee: invoiced from the report, due by day {{royalty_due_day}}.</li>
<li>Quarterly management accounts within 30 days of the quarter end; annual financial statements within 90 days of the year end.</li>
<li>Insurance certificates every year; copies of business registration, TRN, GCT registration and trade licence when renewed.</li></ul>
<h2>11. Audits and inspections</h2>
<p>The franchisor visits each shop at least every quarter and may send mystery shoppers. The audit covers brand standards, customer service, the till and cash, stock, health and safety, and records. Each item scores 2 (meets the standard), 1 (partly) or 0 (does not); the result is the percentage of points available.</p>
<ul><li>85% or more: pass.</li><li>70% to 84%: conditional pass; the action plan is checked at a follow-up visit within 30 days.</li><li>Under 70%: fail; a notice of default may be issued and a re-audit is charged. Two fails in 12 months may end the franchise.</li></ul>
<h2>12. Marketing</h2>
<p>The brand fund pays for national advertising, the website and campaigns. Local marketing of at least {{local_marketing_pct}}% of net sales is spent on approved local activity. Online orders delivered into your territory are credited as the franchisor's current policy states. Approved local advertising can be claimed against your co-op allowance with the co-op claim form and proof of the spend.</p>
<h2>13. The store network: DC, hubs and spokes</h2>
<ul><li>Your store is supplied by its distribution centre (DC). Stock orders are placed through the till or your franchisee link before the DC's cut-off time to go on that day's run. Special orders for parts you do not stock go the same way.</li>
<li>A hub store carries deeper stock and sends parts to its spoke stores the same day ("hot shot"). Before telling a customer a part is not available, check availability: your store, then your hub, then the DC. Offer the time the part can be in the customer's hands.</li>
<li>Receive every DC and hub delivery against its order on the day it arrives and record any short, damaged or wrong part at once; the DC credits it.</li>
<li>Keep minimum and maximum stock levels for every line in your format's range. The replenishment list orders back up to the maximum.</li>
<li>Hub stores keep the extra range the hub service agreement sets and answer spoke orders within the promised time.</li></ul>
<h2>14. Parts lookup and the catalogue</h2>
<ul><li>Look up every part by make, model, year and engine in the network catalogue. Use the interchange numbers to find an equal part when the first choice is out.</li>
<li>Explain cores (the old part handed back for a refund of the core charge) and the warranty on every sale where they apply.</li></ul>
<h2>15. Commercial (do-it-for-me) customers</h2>
<ul><li>Garages, fleets and trade customers are opened as commercial accounts with a credit limit, payment terms and a price tier (Pro 1, Pro 2 or Pro 3). Only the franchisee or manager sets the tier.</li>
<li>Deliveries run on set routes and times. Keep the delivery promise for your format and record each delivery; the average order-to-door time is on your scorecard.</li>
<li>Visit your top commercial accounts at least once a month. Aim for the network target share of commercial sales.</li></ul>
<h2>16. Loyalty and pricing</h2>
<ul><li>Sign up every willing retail customer to the loyalty programme. Points are given and redeemed only through the till, by the programme rules.</li>
<li>Prices: list price for walk-in customers, the loyalty price for members, the account's tier price for commercial customers. Never sell below the price floor.</li></ul>
<h2>17. Certification</h2>
<ul><li>Every counter person earns Parts specialist level 1 within 90 days of starting. Each store keeps the certified people the certification programme requires, and renews certificates before they expire.</li></ul>
<h2>18. The scorecard</h2>
<p>Each month your store is measured on: net sales, sales per square foot, commercial share, average sale, gross margin, inventory turns, shrink, DC fill rate, purchases through the DC, delivery time, certified staff and the last audit. Your monthly report must include the figures the scorecard needs (DIY and commercial sales, cost of goods sold, month-end stock, shrink, total purchases, loyalty points and deliveries).</p>
<h2>19. Changes to the manual</h2>
<p>The franchisor may update the manual to keep the System current. Updates take effect on the date given in them, normally 30 days after they are sent.</p>
<h2>Acknowledgement</h2><p>I received this copy of the operations manual, will keep it confidential, and will run the shop by it.</p>
<p class="sig">Franchisee: ____________________ &nbsp; Date: ____________________</p>` },

  // --------------------------------------------------------- training plan --
  { key: 'training', title: 'Franchise initial training plan', sign: false, fields: [
      { key: 'start_date', label: 'Training starts', type: 'date', required: true },
      { key: 'trainees', label: 'Who is being trained', type: 'textarea', required: true },
      { key: 'trainer', label: 'Lead trainer', type: 'text' } ],
    body: NOTE + `<h1>Initial training plan</h1>
<p>Franchisee: <b>{{franchisee}}</b> · Starts: {{start_date}} · Lead trainer: {{trainer}}</p><p>Trainees: {{trainees}}</p>
<table><tr><th>When</th><th>Module</th><th>Where</th><th>Signed off</th></tr>
<tr><td>Week 1, days 1-2</td><td>The brand, the franchise agreement and the operations manual; customer service standards</td><td>Head office</td><td></td></tr>
<tr><td>Week 1, days 3-5</td><td>The Morty's till: sales, returns, quotes, accounts, cashier shifts and drawer counts (practice till lessons and quizzes)</td><td>Head office</td><td></td></tr>
<tr><td>Week 2, days 1-2</td><td>Parts knowledge and fitment checks; catalogues; warranty and core returns</td><td>Training shop</td><td></td></tr>
<tr><td>Week 2, days 3-4</td><td>Stock: ordering, receiving, counts, shrinkage; the warehouse screens</td><td>Training shop</td><td></td></tr>
<tr><td>Week 2, day 5</td><td>Health and safety, security, data protection; reporting and royalty; local marketing</td><td>Head office</td><td></td></tr>
<tr><td>Before opening</td><td>Staff training at the new shop; trial trading day</td><td>Franchisee's shop</td><td></td></tr>
<tr><td>Opening week</td><td>On-site opening support from the franchisor</td><td>Franchisee's shop</td><td></td></tr>
<tr><td>Day 30, 60 and 90</td><td>Follow-up visits and refresher training</td><td>Franchisee's shop</td><td></td></tr></table>
<p>A trainee passes when they complete each module and its quiz. The franchisor may require more training before opening.</p>
<p class="sig">Trainer: ____________________ &nbsp; Franchisee: ____________________</p>` },

  // ------------------------------------------------------ opening checklist --
  { key: 'opening', title: 'Franchise pre-opening checklist', sign: false, fields: [
      { key: 'target_open', label: 'Target opening date', type: 'date' } ],
    body: NOTE + `<h1>Pre-opening checklist</h1><p>Franchisee: <b>{{franchisee}}</b> · Territory: {{territory}} · Target opening: {{target_open}}</p>
<table><tr><th>Stage</th><th>Item</th><th>Done</th></tr>
<tr><td>Business set-up</td><td>Company registered (Companies Office of Jamaica); TRN; GCT registration with TAJ; NIS and NHT employer registration; business bank account; trade licence</td><td></td></tr>
<tr><td>Site</td><td>Site meets the criteria; site approved in writing by the franchisor; lease reviewed by an attorney with the franchisor's rider; lease signed</td><td></td></tr>
<tr><td>Fit-out</td><td>Layout approved; building and signage permits (municipal corporation); contractor appointed; signs, shelving, counter and security fitted; fire safety checked</td><td></td></tr>
<tr><td>Systems</td><td>Till, receipt printer, card terminal, CCTV and internet installed and tested; staff logins and PINs set</td><td></td></tr>
<tr><td>Stock</td><td>Opening stock ordered from the approved list; received and counted; priced from the till</td><td></td></tr>
<tr><td>Insurance</td><td>Certificates on file, naming the franchisor</td><td></td></tr>
<tr><td>People</td><td>Manager and staff hired; contracts signed; training completed and signed off</td><td></td></tr>
<tr><td>Launch</td><td>Grand-opening marketing approved; pre-opening audit passed; soft opening; opening day</td><td></td></tr></table>
<p class="sig">Franchisor: ____________________ &nbsp; Franchisee: ____________________</p>` },

  // ----------------------------------------------------------- audit form --
  { key: 'audit', title: 'Franchise field audit form', sign: false, fields: [
      { key: 'audit_date', label: 'Audit date', type: 'date', required: true },
      { key: 'auditor', label: 'Auditor', type: 'text', required: true },
      { key: 'findings', label: 'Findings and actions', type: 'textarea' } ],
    body: NOTE + `<h1>Field audit</h1><p>Shop: <b>{{trading_name}}</b> ({{franchisee}}) · Date: {{audit_date}} · Auditor: {{auditor}}</p>
<p>Score each item 2 (meets the standard), 1 (partly) or 0 (does not), or N/A. Result = points scored / points available. Pass 85%+, conditional 70-84%, fail under 70%.</p>
<table><tr><th>Section</th><th>Checks</th><th>Score</th></tr>
<tr><td>Brand and image</td><td>Sign lit, shop front clean, approved signs only, uniforms, hours kept</td><td></td></tr>
<tr><td>Customer service</td><td>Greeting in 30 s, fitment checked, warranty explained, complaints recorded</td><td></td></tr>
<tr><td>Till and cash</td><td>Every sale on the till, receipts, discounts approved, drawer counts, daily banking</td><td></td></tr>
<tr><td>Stock</td><td>Approved suppliers only, receiving against POs, cycle counts, no counterfeit parts</td><td></td></tr>
<tr><td>Health and safety</td><td>Exits clear, extinguishers checked, first aid, spill kit, hazardous storage</td><td></td></tr>
<tr><td>Records and reporting</td><td>Sales report and payments on time, insurance current, staff trained</td><td></td></tr></table>
<p><b>Findings and actions:</b> {{findings}}</p>
<p class="sig">Auditor: ____________________ &nbsp; Franchisee: ____________________</p>` },

  // ----------------------------------------------------------- application --
  { key: 'application', title: 'Franchise application form', sign: true, fields: [
      { key: 'capital', label: 'Cash available to invest (J$)', type: 'text', required: true },
      { key: 'net_worth', label: 'Net worth (J$)', type: 'text' },
      { key: 'experience', label: 'Business and motor-trade experience', type: 'textarea', required: true },
      { key: 'area', label: 'Area wanted', type: 'text', required: true },
      { key: 'partners', label: 'Partners / investors and their share', type: 'textarea' },
      { key: 'references', label: 'Two references (name, phone)', type: 'textarea' } ],
    body: NOTE + `<h1>Franchise application</h1>
<table><tr><th>Applicant</th><td>{{recipient}}</td></tr><tr><th>Address</th><td>{{recipient_address}}</td></tr><tr><th>Phone / email</th><td>{{recipient_phone}} · {{recipient_email}}</td></tr>
<tr><th>Area wanted</th><td>{{area}}</td></tr><tr><th>Cash available</th><td>J\${{capital}}</td></tr><tr><th>Net worth</th><td>J\${{net_worth}}</td></tr>
<tr><th>Experience</th><td>{{experience}}</td></tr><tr><th>Partners / investors</th><td>{{partners}}</td></tr><tr><th>References</th><td>{{references}}</td></tr></table>
<p>I confirm the information above is true and complete. I agree that {{company}} may check it, including a credit and police record check, and keep it to assess my application under the Data Protection Act, 2020. I understand that applying does not oblige either side to enter a franchise.</p>
<p class="sig">Applicant: ____________________ &nbsp; Date: {{today}}</p>` },

  // ------------------------------------------------------------- letters --
  { key: 'default_notice', title: 'Franchise notice of default', sign: false, fields: [
      { key: 'breach', label: 'What is wrong (the breach)', type: 'textarea', required: true },
      { key: 'clause', label: 'Agreement section', type: 'text' },
      { key: 'remedy', label: 'What must be done', type: 'textarea', required: true },
      { key: 'cure_by', label: 'Put right by', type: 'date', required: true } ],
    body: NOTE + `<p>{{today}}</p><p>{{franchisee}}<br>{{franchisee_address}}</p><h1>Notice of default</h1>
<p>Franchise agreement for {{trading_name}} ({{territory}}).</p>
<p>We give you notice that you are in breach of the franchise agreement (section {{clause}}): {{breach}}</p>
<p>To put this right you must: {{remedy}}</p>
<p>This must be done by <b>{{cure_by}}</b>. If it is not, we may end the franchise agreement as section 13 allows. This notice does not waive any other right we have.</p>
<p class="sig">For {{company}}: ____________________</p>` },
  { key: 'termination', title: 'Franchise notice of termination', sign: false, fields: [
      { key: 'reason', label: 'Reason', type: 'textarea', required: true },
      { key: 'end_date', label: 'Termination takes effect', type: 'date', required: true } ],
    body: NOTE + `<p>{{today}}</p><p>{{franchisee}}<br>{{franchisee_address}}</p><h1>Notice of termination</h1>
<p>Franchise agreement for {{trading_name}} ({{territory}}).</p><p>{{reason}}</p>
<p>The franchise agreement ends on <b>{{end_date}}</b>. From that date you must, as section 14 requires: stop using the Morty's Auto Parts name, marks and system; pay all money owed (a final statement follows); return the operations manual and all confidential material; remove the signs and change the look of the shop; hand over the shop phone numbers and online accounts; and keep to the non-compete.</p>
<p class="sig">For {{company}}: ____________________</p>` },
  { key: 'renewal', title: 'Franchise renewal letter', sign: true, fields: [
      { key: 'new_term_years', label: 'Renewal term (years)', type: 'number', required: true },
      { key: 'new_end', label: 'New end date', type: 'date', required: true },
      { key: 'conditions', label: 'Conditions (refit, training...)', type: 'textarea' } ],
    body: NOTE + `<p>{{today}}</p><p>{{franchisee}}<br>{{franchisee_address}}</p><h1>Renewal of your franchise</h1>
<p>We are pleased to renew the franchise for {{trading_name}} ({{territory}}) for a further <b>{{new_term_years}} years</b>, to {{new_end}}, on our current franchise agreement, subject to: {{conditions}}</p>
<p>The renewal fee of {{renewal_fee}} plus GCT is invoiced separately. By signing you also release {{company}} from any claim arising before today, as section 3 requires.</p>
` + sig('For the Franchisor: {{company}}', 'For the Franchisee: {{franchisee}}') },
  { key: 'transfer', title: 'Franchise transfer consent', sign: true, fields: [
      { key: 'buyer', label: 'Buyer', type: 'text', required: true },
      { key: 'transfer_date', label: 'Transfer date', type: 'date', required: true },
      { key: 'conditions', label: 'Conditions', type: 'textarea' } ],
    body: NOTE + `<p>{{today}}</p><h1>Consent to transfer</h1>
<p>{{company}} consents to the transfer of the franchise for {{trading_name}} ({{territory}}) from <b>{{franchisee}}</b> to <b>{{buyer}}</b> on {{transfer_date}}, subject to: all money owed being paid; the buyer completing initial training and signing the current franchise agreement; the seller signing a general release; payment of the transfer fee of {{transfer_fee}} plus GCT; and {{conditions}}</p>
<p>The seller remains bound by the confidentiality and non-compete sections after the transfer.</p>
` + sig('For the Franchisor: {{company}}', 'The seller: {{franchisee}}') },

  // ======================================================= store network ==
  // ------------------------------------------------------ affiliate store --
  { key: 'affiliate', title: 'Affiliate store agreement (dealer-member)', sign: true, agreement: true, fields: [
      { key: 'store_name', label: 'The store\'s own trading name', type: 'text', required: true },
      { key: 'banner', label: 'Banner shown with it', type: 'text', required: true, default: 'Member of the Morty\'s Auto Parts parts network' },
      { key: 'guarantor', label: 'Personal guarantor(s)', type: 'text' },
      { key: 'special_terms', label: 'Special terms (or leave blank)', type: 'textarea' } ],
    body: NOTE + `<h1>Affiliate store agreement</h1>
<p>Made on {{today}} between <b>{{company}}</b> of {{company_address}} ("the Network") and <b>{{franchisee}}</b> (TRN {{franchisee_trn}}) of {{franchisee_address}}, whose principal is {{principal}} ("the Affiliate"), for the parts store known as <b>{{store_name}}</b>.</p>
<h2>Background</h2><p>The Affiliate owns and runs an independent auto-parts store. The Network runs a distribution centre, a parts catalogue, a till and ordering system and a marketing programme for parts stores. The Affiliate wishes to join the Network as a dealer-member: to keep its own name and ownership, show the Network banner, and buy through the Network. Because the Affiliate pays fees and uses the Network's banner and methods, this arrangement may count as a franchise; the Affiliate received the Network's disclosure document at least {{wait_days}} days before signing.</p>
<h2>1. Membership</h2><p>The Network admits the Affiliate's store at {{franchisee_address}} as a member store. The Affiliate trades as <b>{{store_name}}</b> with the words "{{banner}}" on its sign, bags and receipts, in the form the Network approves. The Affiliate gains no ownership of the Network's name or marks.</p>
<h2>2. Term</h2><p>From {{effective_date}} for <b>{{term_years}} years</b>, to {{term_end}}, renewable for further terms on the Network's then-current affiliate terms if the Affiliate is not in default.</p>
<h2>3. Fees</h2><ul><li><b>Membership fee:</b> {{member_fee}} a month, invoiced with the monthly statement. No royalty is charged.</li>
<li><b>Network marketing:</b> {{marketing_pct}}% of net sales each month, for network advertising, the website and promotions that name member stores.</li>
<li><b>Technology fee:</b> {{tech_fee}} a month for the till, catalogue and ordering system.</li>
<li><b>Loyalty programme:</b> as the programme rules set out.</li>
<li>GCT is added where it applies. The monthly sales report is due by day {{report_day}} and payment by day {{royalty_due_day}} of the following month.</li></ul>
<h2>4. Supply</h2><p>The Affiliate buys at least <b>{{commit_pct}}%</b> of its stock by value through the Network's distribution centre ({{dc_name}}) under the supply and distribution agreement, and earns the purchasing rebate and co-op advertising allowance that agreement sets out. The Affiliate may buy the rest from any supplier, but sells no counterfeit or grey-market parts.</p>
<h2>5. Systems and standards</h2><p>The Affiliate uses the Network's till and catalogue for every sale and order, keeps the member-store standards in the operations manual (sign, cleanliness, customer service, fitment checks, warranty and returns, safety), takes part in the loyalty programme and lets the Network visit and audit the store. Certified staff: at least the numbers the certification programme requires.</p>
<h2>6. What stays the Affiliate's</h2><p>The store, its own name, its staff, its customers and its prices (within the Network's price floor for promoted lines) remain the Affiliate's. The Affiliate is responsible for its employees, taxes (GCT, PAYE, NIS, NHT, Education Tax, HEART/NSTA), licences and insurance.</p>
<h2>7. Territory</h2><p>Membership gives no exclusive territory. The Network will not admit another member store within 3 km of the Affiliate's store without first offering the Affiliate the chance to object on reasonable grounds.</p>
<h2>8. Confidentiality and data</h2><p>The catalogue, dealer costs, rebate scales, supplier terms and the manual are confidential. Customer data collected through the Network's systems is handled under the Data Protection Act, 2020.</p>
<h2>9. Leaving the network</h2><p>Either side may end this agreement on 90 days' written notice after the first 12 months. The Network may end it sooner on notice if the Affiliate does not pay within 10 days of a reminder, breaks the standards and does not put it right within 30 days, or seriously harms the Network's name. On ending, the Affiliate removes the banner within 14 days, pays all money owed, returns the manual and stops using the Network's systems; the Network may buy back unopened stock it supplied at the dealer cost less 15%.</p>
<h2>10. Disputes and general</h2><p>Talk, then mediation in Kingston, then arbitration in Kingston under the Arbitration Act, 2017. The laws of Jamaica apply. The parties are independent businesses. {{guarantor}} guarantees the Affiliate's obligations.</p>
<h2>Special terms</h2><p>{{special_terms}}</p>
` + sig('For the Network: {{company}}', 'For the Affiliate: {{franchisee}}') },

  // ----------------------------------------------- supply and distribution --
  { key: 'supply', title: 'Supply and distribution agreement', sign: true, fields: [
      { key: 'payment_days', label: 'Days to pay DC invoices', type: 'number', required: true, default: '30' },
      { key: 'credit_limit', label: 'Trade credit limit (J$)', type: 'text', required: true, default: '3,000,000' },
      { key: 'special_terms', label: 'Special terms (or leave blank)', type: 'textarea' } ],
    body: NOTE + `<h1>Supply and distribution agreement</h1>
<p>Made on {{today}} between <b>{{company}}</b> ("the Supplier"), through its distribution centre <b>{{dc_name}}</b>, and <b>{{franchisee}}</b>, trading as {{trading_name}} ("the Store"), a {{store_type_label}}.</p>
<h2>1. What is supplied</h2><p>The Supplier sells the Store the parts, accessories, fluids and supplies in the network catalogue at the dealer cost shown in the catalogue on the day of the order. The Supplier may change dealer costs on 14 days' notice, except for supplier price rises passed on at once.</p>
<h2>2. Purchasing commitment</h2><p>The Store buys at least <b>{{commit_pct}}%</b> of its stock purchases by value through the Supplier, measured each quarter from the Store's monthly reports. If the Store falls short for two quarters in a row, the Supplier may withhold that quarter's rebate and co-op allowance.</p>
<h2>3. Ordering and delivery</h2><ul><li>Stock and special orders go through the till or the franchisee link. Orders in by the DC cut-off time leave on that day's run; the delivery days and runs are set by the DC.</li>
<li>Spoke stores may order urgent parts from their hub store ({{hub_name}}) as a same-day "hot shot", normally within {{hot_shot_minutes}} minutes.</li>
<li>The Store checks each delivery on arrival and reports any short, damaged or wrong item within 24 hours. The Supplier credits proven shortages.</li>
<li>Fill rate: the Supplier aims to ship at least {{target_fill_rate}}% of the lines ordered, and reports the Store's fill rate each month.</li></ul>
<h2>4. Price and payment</h2><p>Each shipment is invoiced on the Store's account when it leaves, with GCT at {{gct_rate}}%. Payment is due within <b>{{payment_days}} days</b>. Trade credit limit: <b>J\${{credit_limit}}</b>. The Supplier may hold orders while the account is over its limit or overdue.</p>
<h2>5. Purchasing rebate</h2><p>After each quarter the Supplier pays back a share of that quarter's DC purchases on this scale:</p><p>{{rebate_scale}}</p><p>Rebates are paid by cheque or bank transfer, or set against the Store's invoices, within 45 days of the quarter end.</p>
<h2>6. Co-op advertising allowance</h2><p>The Store earns {{coop_pct}}% of its DC purchases as a co-op allowance. It claims against it with the co-op claim form for approved local advertising, up to {{coop_claim_pct}}% of each spend, with proof. Unused allowance lapses 12 months after it was earned.</p>
<h2>7. Returns, cores and warranty</h2><p>Unsold stock in its original packaging may be returned within 90 days for credit less a 10% restocking charge (no charge for the Supplier's own errors). Cores and warranty returns follow the catalogue's terms and the manual, and are credited when the Supplier's vendor accepts them.</p>
<h2>8. Title and risk</h2><p>Risk passes on delivery; ownership passes when the invoice is paid in full.</p>
<h2>9. Term</h2><p>This agreement runs alongside the Store's franchise or affiliate agreement and ends with it.</p>
<h2>Special terms</h2><p>{{special_terms}}</p>
` + sig('For the Supplier: {{company}}', 'For the Store: {{franchisee}}') },

  // --------------------------------------------------------- hub service --
  { key: 'hub_service', title: 'Hub store service agreement', sign: true, fields: [
      { key: 'spokes', label: 'Spoke stores served', type: 'textarea', required: true },
      { key: 'extra_range', label: 'Extra range the hub carries', type: 'textarea', required: true, default: 'About three times the standard store range: slower-moving engine, transmission, steering and suspension parts, and the full battery and filter ranges.' },
      { key: 'transfer_price', label: 'Transfer price to spokes', type: 'text', required: true, default: 'Dealer cost plus 5% handling' } ],
    body: NOTE + `<h1>Hub store service agreement</h1>
<p>Made on {{today}} between <b>{{company}}</b> and <b>{{franchisee}}</b>, trading as {{trading_name}} ("the Hub").</p>
<h2>1. The hub's role</h2><p>The Hub keeps deeper stock than a standard store and supplies the spoke stores near it the same day, so that customers of every store can get a part quickly without each store stocking it. Spoke stores served: {{spokes}}</p>
<h2>2. Range</h2><p>{{extra_range}} The range is reviewed each quarter from the parts the spokes asked for and could not get.</p>
<h2>3. Service promise</h2><p>The Hub answers a spoke's hot-shot order at once and gets the part to the spoke within {{hot_shot_minutes}} minutes during opening hours, by its own driver or the network's courier.</p>
<h2>4. Price</h2><p>Parts go to spokes at: {{transfer_price}}. The network may support the extra stock with longer payment terms or a stocking allowance, agreed in writing.</p>
<h2>5. Measuring it</h2><p>The network reports the Hub's fill rate for spoke orders and its delivery times each month.</p>
` + sig('For {{company}}', 'For the Hub: {{franchisee}}') },

  // ------------------------------------------------------ systems schedule --
  { key: 'systems', title: 'Required systems schedule', sign: true, fields: [
      { key: 'install_by', label: 'Installed by', type: 'date' } ],
    body: NOTE + `<h1>Required systems schedule</h1>
<p>For <b>{{trading_name}}</b> ({{franchisee}}), a {{store_type_label}}. To be installed and working by {{install_by}}, and kept working throughout the term.</p>
<table><tr><th>System</th><th>What it is for</th><th>Who provides it</th></tr>
<tr><td>Morty's till (point of sale)</td><td>Every sale, return, quote and account payment; the sales report</td><td>{{company}} (software); the store (hardware)</td></tr>
<tr><td>Stock and replenishment</td><td>On-hand counts, min and max levels, the replenishment list</td><td>{{company}}</td></tr>
<tr><td>Electronic parts catalogue</td><td>Lookup by make, model, year and engine; interchange numbers</td><td>{{company}}</td></tr>
<tr><td>Ordering link to the DC</td><td>Stock, special and hot-shot orders, delivery tracking</td><td>{{company}}</td></tr>
<tr><td>Commercial delivery tracking</td><td>Routes, stops, proof of delivery</td><td>{{company}}</td></tr>
<tr><td>Loyalty sign-up and scanning</td><td>Points given and redeemed</td><td>{{company}}</td></tr>
<tr><td>Card terminal</td><td>Card and contactless payments, from an approved provider</td><td>The store</td></tr>
<tr><td>CCTV</td><td>Till, door and stock room, 30 days kept</td><td>The store</td></tr>
<tr><td>Main and backup internet</td><td>The till keeps working if one line fails</td><td>The store</td></tr></table>
<p>The technology fee ({{tech_fee}} a month) covers the {{company}} software, support and updates. Each person uses their own login. The store may not connect other software to the till without written approval.</p>
<p class="sig">Store: ____________________ &nbsp; Date: ____________________</p>` },

  // ------------------------------------------------------- loyalty rules --
  { key: 'loyalty', title: 'Loyalty programme rules (store participation)', sign: true, fields: [
      { key: 'programme_name', label: 'Programme name', type: 'text', required: true, default: 'Morty\'s Auto Rewards' } ],
    body: NOTE + `<h1>{{programme_name}}: rules for member stores</h1>
<p>For <b>{{trading_name}}</b> ({{franchisee}}).</p>
<h2>1. How customers earn</h2><p>A signed-up retail customer earns <b>{{loyalty_points_per_100}} point(s) for each J$100</b> spent (before GCT) on qualifying goods at any store in the network. Commercial accounts on a pro tier do not earn points.</p>
<h2>2. How customers redeem</h2><p>Each point is worth <b>{{loyalty_point_value}}</b> off a later purchase at any store. Points expire 12 months after they are earned.</p>
<h2>3. Who pays</h2><p>The network runs one loyalty fund. Each month your store pays into it {{loyalty_point_value}} for every point it gave, and is paid back {{loyalty_point_value}} for every point redeemed at your store, from the figures in your monthly report and the till. So a customer can earn in one store and spend in another, and each store pays only for the points it gave.</p>
<h2>4. The store's duties</h2><ul><li>Offer sign-up to every retail customer; record consent as the Data Protection Act, 2020 requires.</li><li>Give and redeem points only through the till.</li><li>Never give points for sales to yourself, staff or commercial accounts.</li></ul>
<h2>5. Changes</h2><p>The network may change the earn rate, value or rules on 30 days' notice to stores and customers. Points already earned keep their value.</p>
<p class="sig">Store: ____________________ &nbsp; Date: ____________________</p>` },

  // ------------------------------------------------- certification programme --
  { key: 'certification', title: 'Training and certification programme', sign: false, fields: [
      { key: 'year', label: 'Programme year', type: 'text', required: true, default: '2027' } ],
    body: NOTE + `<h1>Training and certification programme {{year}}</h1>
<p>For <b>{{trading_name}}</b> ({{franchisee}}). Certificates show that a person has learned and passed a set standard, like the industry's technician and parts-specialist certifications. Each one is earned by completing the lessons on the till's Training screen and passing the quiz at the pass mark, and lasts the time shown; renew it before it runs out.</p>
<table><tr><th>Certificate</th><th>For</th><th>Lasts</th><th>Each store needs</th></tr>
<tr><td>Parts specialist level 1</td><td>Every counter person, within 90 days of starting</td><td>2 years</td><td>2</td></tr>
<tr><td>Parts specialist level 2</td><td>Senior counter staff</td><td>2 years</td><td>1</td></tr>
<tr><td>Commercial sales</td><td>Whoever looks after garage and fleet accounts</td><td>2 years</td><td>1</td></tr>
<tr><td>Battery and electrical</td><td>Counter staff who test and fit batteries</td><td>2 years</td><td>1</td></tr>
<tr><td>Delivery driver safety</td><td>Every delivery driver</td><td>1 year</td><td>Every driver</td></tr>
<tr><td>Hazardous materials</td><td>At least one person on every shift</td><td>2 years</td><td>1</td></tr>
<tr><td>Store manager</td><td>The manager and the franchisee's principal</td><td>3 years</td><td>1</td></tr></table>
<p>The current requirements are those set in the franchise system's certification list, which may change on 30 days' notice. The share of required certificates a store holds is on its monthly scorecard and is checked at each audit.</p>` },

  // ------------------------------------------------ commercial application --
  { key: 'commercial_app', title: 'Commercial account application and credit terms', sign: false, fields: [
      { key: 'business', label: 'Business name (garage, fleet...)', type: 'text', required: true },
      { key: 'contact', label: 'Contact person', type: 'text', required: true },
      { key: 'monthly', label: 'Expected monthly spend (J$)', type: 'text' } ],
    body: NOTE + `<h1>Commercial account application</h1>
<p>Store: <b>{{trading_name}}</b> · {{franchisee_address}}</p>
<table><tr><th>Business</th><td>{{business}}</td></tr><tr><th>Contact</th><td>{{contact}}</td></tr><tr><th>Address</th><td>&nbsp;</td></tr><tr><th>TRN / GCT number</th><td>&nbsp;</td></tr>
<tr><th>Kind</th><td>☐ Garage ☐ Fleet ☐ Body shop ☐ Dealer ☐ Government ☐ Other</td></tr><tr><th>Service bays / vehicles</th><td>&nbsp;</td></tr><tr><th>Expected monthly spend</th><td>J\${{monthly}}</td></tr>
<tr><th>Trade references (2)</th><td>&nbsp;<br>&nbsp;</td></tr><tr><th>Bank</th><td>&nbsp;</td></tr><tr><th>People allowed to order</th><td>&nbsp;</td></tr></table>
<h2>Terms</h2><ul><li>Prices at the price tier the store sets for the account (Pro 1, Pro 2 or Pro 3), reviewed each quarter on the account's spend.</li>
<li>Invoices are due within the terms on the account (normally 30 days from the statement). Overdue accounts are put on hold and may be charged interest at 1.5% a month.</li>
<li>Deliveries run on the store's routes; sign for each delivery. Report short or wrong parts on delivery.</li>
<li>Cores must be returned within 30 days or the core charge stands. Warranty claims follow the manufacturer's terms.</li>
<li>We may check the references and your credit, and keep your details to run the account, as the Data Protection Act, 2020 allows.</li></ul>
<p class="sig">For the business: ____________________ &nbsp; Name and title: ____________________ &nbsp; Date: ________</p>
<p class="sig">Approved for the store: ____________________ &nbsp; Tier: ______ &nbsp; Credit limit: J$__________ &nbsp; Terms: ____ days</p>` },

  // --------------------------------------------------------- co-op claim --
  { key: 'coop', title: 'Co-op advertising claim form', sign: false, fields: [
      { key: 'activity', label: 'The advertising (what, where, when)', type: 'textarea', required: true },
      { key: 'spend', label: 'Amount spent (J$, before GCT)', type: 'text', required: true } ],
    body: NOTE + `<h1>Co-op advertising claim</h1>
<p>Store: <b>{{trading_name}}</b> ({{franchisee}}) · Date: {{today}}</p>
<table><tr><th>Advertising</th><td>{{activity}}</td></tr><tr><th>Amount spent</th><td>J\${{spend}}</td></tr><tr><th>Claimed ({{coop_claim_pct}}% of the spend, up to the allowance)</th><td>&nbsp;</td></tr></table>
<p>Attach: the supplier's invoice and proof the advertising ran (a copy of the advert, a screenshot, the radio station's affidavit, photographs of the event or signage). The advertising must show the network name and logo as the brand guide sets out, and be approved before it runs.</p>
<p class="sig">Store: ____________________ &nbsp; Approved: J$__________ by ____________________</p>` },

  // ------------------------------------------- site and territory assessment --
  { key: 'site_report', title: 'Site and territory assessment', sign: false, fields: [
      { key: 'site_address', label: 'Site address', type: 'text', required: true },
      { key: 'format', label: 'Store format proposed', type: 'text', required: true, default: 'Standard store' },
      { key: 'traffic', label: 'Traffic, visibility, parking, access', type: 'textarea' },
      { key: 'competition', label: 'Competing parts stores nearby', type: 'textarea' },
      { key: 'commercial', label: 'Garages and fleets within delivery reach', type: 'textarea' },
      { key: 'recommendation', label: 'Recommendation', type: 'textarea', required: true } ],
    body: NOTE + `<h1>Site and territory assessment</h1>
<p>For: <b>{{recipient}}</b> · Territory: {{territory}} ({{territory_desc}}) · Date: {{today}}</p>
<table><tr><th>Site</th><td>{{site_address}}</td></tr><tr><th>Format</th><td>{{format}}</td></tr><tr><th>Market</th><td>{{territory_market}}</td></tr>
<tr><th>Supply</th><td>{{territory_supply}}</td></tr><tr><th>Traffic and access</th><td>{{traffic}}</td></tr><tr><th>Competition</th><td>{{competition}}</td></tr><tr><th>Commercial customers</th><td>{{commercial}}</td></tr></table>
<h2>Recommendation</h2><p>{{recommendation}}</p>
<p class="sig">Assessed by: ____________________ &nbsp; Approved: ____________________</p>` },
];

// The opening checklist the module creates for each new franchisee.
// [phase, item, days after signing it is normally due]
const ONBOARDING = [
  ['setup', 'Company registered with the Companies Office of Jamaica (or existing company confirmed)', 14],
  ['setup', 'TRN and GCT registration with TAJ; NIS and NHT employer registration', 30],
  ['setup', 'Business bank account opened; royalty payment method set up', 30],
  ['setup', 'Initial franchise fee paid', 7],
  ['site', 'Site found that meets the site criteria (size, parking, visibility, traffic)', 45],
  ['site', 'Site approved in writing by the franchisor', 60],
  ['site', 'Lease reviewed by an attorney, with the franchisor lease rider; lease signed', 75],
  ['fitout', 'Shop layout and signage approved', 90],
  ['fitout', 'Building, signage and trade licence permits obtained', 105],
  ['fitout', 'Fit-out finished: signs, shelving, counter, security, fire safety', 135],
  ['fitout', 'Till, receipt printer, card terminal, CCTV and internet installed and tested', 140],
  ['fitout', 'Insurance certificates received, naming the franchisor', 140],
  ['fitout', 'Opening stock ordered from the approved list, received, counted and priced', 150],
  ['training', 'Principal and manager complete initial training (2 weeks) and pass the quizzes', 120],
  ['training', 'Operations manual issued and acknowledged', 120],
  ['training', 'Shop staff hired, contracts signed, staff training completed', 150],
  ['fitout', 'Required systems installed and verified (till, catalogue, DC ordering, delivery tracking)', 140],
  ['fitout', 'Distribution centre account set up; hub store assigned (spoke stores)', 120],
  ['training', 'Counter staff certified Parts specialist level 1; manager certified', 150],
  ['launch', 'Commercial accounts and first delivery route set up', 160],
  ['launch', 'Pre-opening audit passed', 155],
  ['launch', 'Grand-opening marketing plan approved', 150],
  ['launch', 'Soft opening / trial trading day', 160],
  ['launch', 'Opening day, with franchisor support on site', 165],
  ['launch', '30-day review visit', 195],
  ['launch', '90-day review visit', 255],
];
const PHASES = { setup: 'Business set-up', site: 'Site selection', fitout: 'Fit-out and systems', training: 'Training', launch: 'Launch' };

// The field audit checklist. [section, item]
const AUDIT_ITEMS = [
  ['Brand and image', 'Sign lit and clean; shop front glass clean'],
  ['Brand and image', 'Only approved signs, posters and price labels'],
  ['Brand and image', 'Staff in uniform with name badges'],
  ['Brand and image', 'Open at the agreed hours'],
  ['Customer service', 'Customer greeted within 30 seconds'],
  ['Customer service', 'Vehicle details asked and fitment checked before the sale'],
  ['Customer service', 'Warranty and returns policy explained'],
  ['Customer service', 'Complaints recorded on the till and answered in time'],
  ['Till and cash', 'Every sale rung through the Morty\'s till, receipt given'],
  ['Till and cash', 'Discounts and GCT changes approved with a manager PIN'],
  ['Till and cash', 'Drawer counted in and out; variances recorded'],
  ['Till and cash', 'Cash banked daily; cash limit kept'],
  ['Stock', 'Stock bought only from the franchisor or approved suppliers'],
  ['Stock', 'Deliveries received against purchase orders'],
  ['Stock', 'Weekly cycle counts done; loss investigated'],
  ['Stock', 'No counterfeit or grey-market parts on the shelf'],
  ['Health and safety', 'Fire exits clear; extinguishers checked this month'],
  ['Health and safety', 'First-aid kit stocked; first-aider on shift'],
  ['Health and safety', 'Batteries, oils and chemicals stored safely; spill kit ready'],
  ['Health and safety', 'Used oil and batteries sent to an approved recycler (receipts kept)'],
  ['Records and reporting', 'Monthly sales reports and payments on time'],
  ['Records and reporting', 'Insurance, trade licence and registrations current'],
  ['Records and reporting', 'All staff trained for their role; logins not shared'],
  ['Records and reporting', 'CCTV working; recordings kept 30 days'],
  ['Commercial and delivery', 'Commercial accounts have a tier, credit limit and terms on file'],
  ['Commercial and delivery', 'Deliveries recorded; delivery promise kept'],
  ['Commercial and delivery', 'Top accounts visited this month'],
  ['Stock and supply', 'Availability checked (store, hub, DC) before turning a customer away'],
  ['Stock and supply', 'DC and hub deliveries received the same day; shortages reported'],
  ['Stock and supply', 'Min and max levels kept; replenishment order placed on schedule'],
  ['People and systems', 'Required certified staff in post; certificates current'],
  ['People and systems', 'Every required system working (till, catalogue, DC ordering, card terminal)'],
  ['People and systems', 'Loyalty sign-ups offered at the till'],
];

// The systems every store must have (franchise-network.js, the systems schedule).
const SYSTEMS = [
  ['pos', 'Morty\'s till (point of sale)', 'Every sale, return, quote and account payment.'],
  ['inventory', 'Stock and replenishment', 'On-hand counts, min and max levels, the replenishment list.'],
  ['catalogue', 'Electronic parts catalogue and lookup', 'Make, model, year and engine lookup, interchange numbers.'],
  ['dc_link', 'Ordering link to the distribution centre', 'Stock, special and hot-shot orders; delivery tracking.'],
  ['delivery', 'Commercial delivery tracking', 'Routes, stops and proof of delivery.'],
  ['loyalty', 'Loyalty sign-up and scanning', 'Points given and redeemed at the till.'],
  ['card', 'Approved card terminal', 'Card and contactless payments.'],
  ['cctv', 'CCTV', 'Till, door and stock room; 30 days kept.'],
  ['internet', 'Main and backup internet', 'The till keeps working if one line fails.'],
];
const STORE_TYPES = { franchise: 'Franchised store', affiliate: 'Affiliate (dealer-member) store', company: 'Company-owned store' };

module.exports = { TEMPLATES, ONBOARDING, PHASES, AUDIT_ITEMS, NOTE, SYSTEMS, STORE_TYPES };
