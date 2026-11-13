// The asset register beyond equipment, against a REAL server and a throwaway
// Postgres: software amortised on its own accounts; an asset held with others
// (the business's share, the whole asset, a market value); a maintenance
// contract and a loan on an asset landing in its running costs; investments in
// another company (equity method: share of profit, dividends, a part sale) and
// in a bond at fair value; the business's own share register (issue, opening,
// transfer, buy-back) and the cap table; and the net worth report, which must
// balance, tie to the registers and split the business among its shareholders.
// Every money movement must reach the ledger.
//
//   LC_TEST_URL=http://localhost:3394 LC_TEST_PSQL="psql -h 127.0.0.1 -p 5497 -U postgres -d ar" node test/asset-register-pg-test.mjs
import { execSync } from 'node:child_process';

const BASE = process.env.LC_TEST_URL || 'http://localhost:3394';
if (/:(3056|3059)\b/.test(BASE)) { console.log('FAIL refusing to run against the live till port'); process.exit(1); }
const PSQL = process.env.LC_TEST_PSQL;
if (!PSQL || /-p\s*5435\b/.test(PSQL)) { console.log('FAIL LC_TEST_PSQL must point at the throwaway database (never port 5435)'); process.exit(1); }
let pass = 0, fails = 0;
const ok = (c, m) => { if (c) { pass++; console.log('PASS ' + m); } else { fails++; console.log('FAIL ' + m); } };
const sql = (q) => execSync(PSQL + ' -tA -v ON_ERROR_STOP=1', { input: q, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
const jar = {};
async function api(method, url, body) {
  const r = await fetch(BASE + url, { method, headers: Object.assign({ Accept: 'application/json', Cookie: Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ') }, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
  for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
  return Object.assign({ _status: r.status }, await r.json().catch(() => ({})));
}
const n = (v) => Number(v || 0), near = (a, b) => Math.abs(n(a) - n(b)) < 0.02;
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
// Post everything waiting (a run already going after a save answers "busy": wait for it, then run again).
async function post() { for (let i = 0; i < 30; i++) { const r = await api('POST', '/api/gl/post-now'); if (!r.busy) return r; await wait(300); } }
const today = new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10);
const month = today.slice(0, 7);
const stamp = Date.now().toString(36);
const acct = (k) => Number(sql(`SELECT id FROM gl_accounts WHERE system_key = '${k}'`));
// The ledger balance of an account (debit +), all dates.
const bal = (id) => n(sql(`SELECT COALESCE(SUM(amount), 0) FROM gl_lines WHERE account_id = ${id}`));
const entries = (kind, id) => Number(sql(`SELECT COUNT(*) FROM gl_entries WHERE source_kind = '${kind}' AND source_id = ${id}`));
const errMsg = (r) => (r._status === 200 ? '' : ' [' + r.error + ']');

ok((await api('POST', '/api/auth/signin', { email: 'admin@visionautosolutions.com', password: 'password123' }))._status === 200, 'admin signs in');
await api('POST', '/api/gl/setup', {});
ok((await api('GET', '/api/gl/status')).started, 'the ledger is started');
const bank = acct('bank');

// ---- the chart has what the register posts to
for (const k of ['fa_software', 'fa_software_ad', 'amortisation', 'software_maint', 'inv_companies', 'inv_other', 'share_capital', 'share_premium', 'dividend_income', 'inv_gain', 'inv_share_profit'])
  ok(acct(k) > 0, 'the chart has an account for ' + k);
const meta = await api('GET', '/api/assets/meta');
const sw = meta.classes.find((k) => k.name === 'Computer software');
ok(sw && sw.kind === 'intangible' && sw.asset_account_id === acct('fa_software') && sw.expense_account_id === acct('amortisation'), 'software is an intangible class, amortised to Amortisation Expense');

// ---- software: bought from the bank, amortised by the monthly run
let r = await api('POST', '/api/assets', { name: 'Parts catalogue licence ' + stamp, class_id: sw.id, acquired_on: today, in_service_on: today, cost: 72000, life_months: 36, funding: 'account', funding_account_id: bank });
const swId = r.asset && r.asset.id;
ok(swId > 0 && r.asset.class_kind === 'intangible', 'software added as an asset' + errMsg(r));
await post();
ok(entries('fa_acquire', swId) === 1 && near(bal(acct('fa_software')), 72000), 'its cost is in Computer Software (Dr 72,000, Cr bank)');
r = await api('POST', '/api/assets/runs', { month });
ok(r._status === 200 || /Nothing to depreciate/.test(r.error || ''), 'depreciation / amortisation run for ' + month + errMsg(r));
await post();
ok(near(bal(acct('amortisation')), 2000) && near(bal(acct('fa_software_ad')), -2000), `a month of amortisation (72,000 / 36 = 2,000) is in Amortisation Expense and Accumulated Amortisation (${bal(acct('amortisation'))})`);

// ---- an asset held with others: half a delivery van
const vans = meta.classes.find((k) => k.name === 'Motor vehicles');
r = await api('POST', '/api/assets', { name: 'Shared delivery van ' + stamp, class_id: vans.id, acquired_on: today, in_service_on: today, cost: 1500000, life_months: 60, funding: 'opening',
  ownership_pct: 50, co_owners: 'Brother Auto Ltd', market_value: 1600000 });
const van = r.asset && r.asset.id;
ok(van > 0 && r.asset.ownership_pct === 50 && r.asset.co_owners === 'Brother Auto Ltd' && near(r.asset.market_value, 1600000), 'van added as 50% owned, with the co-owner and a market value' + errMsg(r));
ok((await api('POST', '/api/assets', { name: 'Bad share', class_id: vans.id, acquired_on: today, cost: 100, life_months: 60, funding: 'opening', ownership_pct: 120 }))._status === 400, 'an ownership over 100% is refused');
ok((await api('PUT', `/api/assets/${van}`, { ownership_pct: 60 }))._status === 200 && n(sql(`SELECT ownership_pct FROM fa_assets WHERE id = ${van}`)) === 60, 'the share can be changed after posting (it posts nothing)');
await api('PUT', `/api/assets/${van}`, { ownership_pct: 50 });

// ---- a maintenance contract for the software: a recurring bill naming it
const sup = Number(sql(`INSERT INTO suppliers (name) VALUES ('Catalogue Co ${stamp}') RETURNING id`).split('\n')[0]);
r = await api('POST', '/api/billing/plans', { side: 'ap', name: 'Catalogue support ' + stamp, supplier_id: sup, frequency: 'monthly', start_date: today, asset_id: swId,
  lines: [{ account_id: acct('software_maint'), description: 'Support {period}', amount: 3500, asset_id: swId }] });
const contract = r.id;
ok(contract > 0, 'maintenance contract set up for the software' + errMsg(r));
r = await api('POST', `/api/billing/plans/${contract}/run`, {});
ok(r._status === 200 && r.created >= 1, 'it raised its first bill' + errMsg(r));
await post();
let d = await api('GET', `/api/assets/${swId}`);
ok((d.contracts || []).length === 1 && near(d.contracts[0].amount, 3500) && d.contracts[0].bills >= 1, 'the asset lists the contract and its bills');
ok(near(d.ownership.costs, 3500) && near(d.ownership.depreciation, 2000), `the software's costs show the support (3,500) and its amortisation (2,000): ${d.ownership.costs} / ${d.ownership.depreciation}`);

// ---- a loan for the van: the interest is a running cost of the van
const lender = Number(sql(`INSERT INTO suppliers (name) VALUES ('Van Bank ${stamp}') RETURNING id`).split('\n')[0]);
r = await api('POST', '/api/loans', { name: 'Van loan ' + stamp, supplier_id: lender, principal: 600000, annual_rate: 12, instalments: 12, frequency: 'monthly', start_date: today, first_due: today, received: 'deposit', deposit_account_id: bank, asset_id: van });
const loan = r.id;
ok(loan > 0 && Number(sql(`SELECT asset_id FROM loans WHERE id = ${loan}`)) === van, 'loan registered for the van' + errMsg(r));
const inst = Number(sql(`SELECT id FROM loan_instalments WHERE loan_id = ${loan} ORDER BY n LIMIT 1`));
r = await api('POST', `/api/loans/${loan}/instalments/${inst}/bill`, {});
ok(r._status === 200, 'first instalment billed' + errMsg(r));
await post();
d = await api('GET', `/api/assets/${van}`);
ok((d.loans || []).length === 1 && d.loans[0].balance < 600000 && d.loans[0].interest_billed > 0, `the van lists its loan, owed ${d.loans && d.loans[0] && d.loans[0].balance}`);
ok(near(d.ownership.costs, d.loans[0].interest_billed), `the loan's interest (${d.loans[0].interest_billed}) is a running cost of the van`);
const loans = await api('GET', '/api/loans');
ok((loans.loans || []).some((l) => l.id === loan && (l.asset_number || '').startsWith('FA-')), 'the loans list shows which asset each loan is for');
// Linking and unlinking an existing loan from the asset page.
r = await api('POST', `/api/capital/assets/${swId}/loans`, { loan_id: loan });
ok(r._status === 409, 'a loan already on one asset cannot be linked to another');
ok((await api('POST', `/api/capital/assets/${van}/loans`, { loan_id: loan, unlink: true }))._status === 200 && sql(`SELECT asset_id FROM loans WHERE id = ${loan}`) === '', 'it can be unlinked');
ok((await api('POST', `/api/capital/assets/${van}/loans`, { loan_id: loan }))._status === 200 && Number(sql(`SELECT asset_id FROM loans WHERE id = ${loan}`)) === van, 'and linked again');

// ---- an investment in another company, on the equity method
const metaC = await api('GET', '/api/capital/meta');
ok(metaC._status === 200 && metaC.share_classes.some((k) => k.name === 'Ordinary'), 'capital meta loads, with the Ordinary share class');
r = await api('POST', '/api/capital/investments', { name: 'Kingston Tyre Co ' + stamp, kind: 'company_shares', method: 'equity', acquired_on: today, cost: 1000000, shares: 300, shares_outstanding: 1000,
  share_class: 'Ordinary', funding: 'account', funding_account_id: bank });
const inv = r.investment && r.investment.id;
ok(inv > 0 && r.investment.number.startsWith('IV-') && near(r.investment.state.pct, 30), '30% of Kingston Tyre Co bought for 1,000,000' + errMsg(r));
ok(Number(sql(`SELECT account_id FROM cap_investments WHERE id = ${inv}`)) === acct('inv_companies'), 'held on Investments in Other Companies');
await post();
ok(entries('inv_acquire', inv) === 1 && near(bal(acct('inv_companies')), 1000000), 'the purchase is in the ledger (Dr investments 1,000,000, Cr bank)');
const ev = (body) => api('POST', `/api/capital/investments/${inv}/events`, Object.assign({ event_date: today }, body));
r = await ev({ kind: 'share_of_profit', amount: 50000 });
ok(r._status === 200 && near(r.investment.carrying, 1050000), 'its share of the year\'s profit (50,000) adds to the holding' + errMsg(r));
r = await ev({ kind: 'dividend', amount: 20000, account_id: bank });
ok(r._status === 200 && near(r.investment.carrying, 1030000) && near(r.investment.state.income, 20000), 'a dividend of 20,000 comes off the holding (equity method) and counts as income' + errMsg(r));
ok((await ev({ kind: 'revalue', new_value: 2000000 }))._status === 400, 'an equity-method holding cannot be revalued upwards');
ok((await ev({ kind: 'sell', shares: 500, amount: 1, account_id: bank }))._status === 400, 'selling more shares than held is refused');
r = await ev({ kind: 'sell', shares: 100, amount: 400000, account_id: bank });
const sold = r.investment;
ok(r._status === 200 && near(sold.state.shares, 200) && near(sold.state.pct, 20) && near(sold.carrying, 686666.67), `100 of 300 shares sold: 20% left, book value 686,666.67 (${sold && sold.carrying})` + errMsg(r));
ok(near(sold.state.realised, 56666.67), `gain on the part sold: 400,000 - 343,333.33 = 56,666.67 (${sold && sold.state.realised})`);
await post();
ok(near(bal(acct('inv_companies')), 686666.67), `the ledger's investment account equals the holding's book value (${bal(acct('inv_companies'))})`);
ok(near(bal(acct('inv_share_profit')), -50000) && near(bal(acct('inv_gain')), -56666.67), 'the share of profit and the gain on sale are income in the ledger');
// Only the latest event can be voided.
const evs = (await api('GET', `/api/capital/investments/${inv}`)).events;
const first = evs.find((e) => e.kind === 'share_of_profit'), lastSell = evs.find((e) => e.kind === 'sell');
ok((await api('POST', `/api/capital/inv-events/${first.id}/void`, { reason: 'test' }))._status === 409, 'an earlier event cannot be voided while later ones stand');
ok((await api('POST', `/api/capital/inv-events/${lastSell.id}/void`, { reason: 'Sale fell through' }))._status === 200, 'the latest (the sale) can be voided');
await post();
ok(near(bal(acct('inv_companies')), 1030000) && near(bal(acct('inv_gain')), 0), 'the ledger reverses it: holding back to 1,030,000, no gain');
r = await ev({ kind: 'sell', shares: 300, amount: 1100000, account_id: bank });
ok(r._status === 200 && r.investment.status === 'sold' && near(r.investment.carrying, 0), 'selling all of it marks the holding sold' + errMsg(r));
ok((await ev({ kind: 'dividend', amount: 5, account_id: bank }))._status === 409, 'nothing more can be recorded on a sold holding');
await post();
ok(near(bal(acct('inv_companies')), 0) && near(bal(acct('inv_gain')), -70000), 'all of it off the books, gain 70,000');
const lastAll = (await api('GET', `/api/capital/investments/${inv}`)).events.filter((e) => !e.voided_at).pop();
ok((await api('POST', `/api/capital/inv-events/${lastAll.id}/void`, { reason: 'Undo full sale' }))._status === 200 && sql(`SELECT status FROM cap_investments WHERE id = ${inv}`) === 'active', 'voiding the full sale makes it active again');
await post();

// A bond at fair value, revalued; and one held at cost with a market value (report only).
r = await api('POST', '/api/capital/investments', { name: 'GOJ bond ' + stamp, kind: 'bonds', method: 'fair_value', acquired_on: today, cost: 200000, funding: 'opening' });
const bond = r.investment && r.investment.id;
ok(bond > 0 && Number(sql(`SELECT account_id FROM cap_investments WHERE id = ${bond}`)) === acct('inv_other'), 'a bond held before the ledger, on Other Investments' + errMsg(r));
r = await api('POST', `/api/capital/investments/${bond}/events`, { kind: 'revalue', event_date: today, new_value: 210000 });
ok(r._status === 200 && near(r.investment.carrying, 210000), 'revalued to 210,000 (fair value)' + errMsg(r));
r = await api('POST', `/api/capital/investments/${bond}/events`, { kind: 'interest', event_date: today, amount: 7000, account_id: bank });
ok(r._status === 200 && near(r.investment.carrying, 210000) && near(r.investment.state.income, 7000), 'interest received is income, not off the holding');
r = await api('POST', '/api/capital/investments', { name: 'Parts co-op stake ' + stamp, kind: 'partnership', method: 'cost', acquired_on: today, cost: 300000, stake_pct: 15, funding: 'in_ledger', market_value: 350000 });
const coop = r.investment && r.investment.id;
ok(coop > 0 && near(r.investment.state.pct, 15) && near(r.investment.unrealised, 50000), 'a 15% partnership stake at cost, worth 350,000 (50,000 over book, not posted)' + errMsg(r));
// "Already in the books": the cheque that paid for it was coded to the investment account.
await api('POST', '/api/gl/journal', { date: today, memo: 'Cheque for the co-op stake', lines: [{ account_id: acct('inv_other'), debit: 300000 }, { account_id: bank, credit: 300000 }] });
await post();
ok(entries('inv_acquire', coop) === 0, 'one already in the books (in_ledger) posts nothing');
r = await api('POST', `/api/capital/investments/${coop}/events`, { kind: 'sell', event_date: today, stake_pct: 5, amount: 120000, account_id: bank });
ok(r._status === 200 && near(r.investment.state.pct, 10) && near(r.investment.carrying, 200000), 'selling 5 of the 15 points takes a third of the book value off' + errMsg(r));
await post();
const list = await api('GET', '/api/capital/investments');
ok(list.investments.length >= 3 && list.totals.count >= 3, 'the investments register lists them');

// ---- the business's own shares
const ord = metaC.share_classes.find((k) => k.name === 'Ordinary');
ok((await api('PUT', `/api/capital/share-classes/${ord.id}`, { name: 'Ordinary', par_value: 1, votes_per_share: 1, authorised: 10000 }))._status === 200, 'Ordinary shares: par J$1, 10,000 authorised');
const holder = async (name) => (await api('POST', '/api/capital/shareholders', { name: name + ' ' + stamp, kind: 'person' })).id;
const A = await holder('Owner A'), Bh = await holder('Partner B');
ok(A > 0 && Bh > 0, 'two shareholders added');
const stx = (body) => api('POST', '/api/capital/share-txns', Object.assign({ class_id: ord.id, txn_date: today }, body));
r = await stx({ kind: 'issue', shareholder_id: A, shares: 600, price: 100, account_id: bank });
const issue = r.id;
ok(issue > 0, '600 shares issued to A at J$100' + errMsg(r));
await post();
ok(near(bal(acct('share_capital')), -600) && near(bal(acct('share_premium')), -59400), 'the ledger: Cr Share Capital 600 at par, Cr Share Premium 59,400');
r = await stx({ kind: 'opening', shareholder_id: Bh, shares: 400 });
ok(r._status === 200, 'B\'s 400 shares held from before are entered as opening' + errMsg(r));
await post();
ok(entries('share_txn', r.id) === 0, 'an opening holding posts nothing');
ok((await stx({ kind: 'issue', shareholder_id: A, shares: 9001, price: 1, account_id: bank }))._status === 400, 'issuing past the authorised shares is refused');
r = await stx({ kind: 'transfer', from_shareholder_id: A, shareholder_id: Bh, shares: 100, price: 120 });
const xfer = r.id;
ok(xfer > 0, 'A transfers 100 shares to B' + errMsg(r));
ok((await stx({ kind: 'transfer', from_shareholder_id: A, shareholder_id: Bh, shares: 501 }))._status === 400, 'A cannot transfer more than A holds');
let sh = await api('GET', '/api/capital/shares');
const rowA = sh.cap_table.rows.find((x) => x.shareholder_id === A), rowB = sh.cap_table.rows.find((x) => x.shareholder_id === Bh);
ok(rowA && rowB && rowA.shares === 500 && rowB.shares === 500 && near(rowA.pct, 50) && near(rowB.vote_pct, 50) && sh.cap_table.total_shares === 1000, 'the cap table: A 500 (50%), B 500 (50%)');
ok((await api('POST', `/api/capital/share-txns/${issue}/void`, { reason: 'test' }))._status === 409, 'the issue cannot be voided while shares from it have been passed on');
r = await stx({ kind: 'buyback', from_shareholder_id: Bh, shares: 100, price: 150, account_id: bank });
ok(r._status === 200 && near(sql(`SELECT capital FROM cap_share_txns WHERE id = ${r.id}`), 6000), 'the business buys back 100 of B\'s shares at J$150: paid-in capital taken off 6,000 (60,000 / 1,000 shares x 100)' + errMsg(r));
await post();
ok(near(bal(acct('share_capital')) + bal(acct('share_premium')), -54000), 'share capital and premium in the ledger: 60,000 - 6,000 = 54,000');
sh = await api('GET', '/api/capital/shares');
ok(sh.cap_table.total_shares === 900 && near(sh.cap_table.rows.find((x) => x.shareholder_id === A).pct, 55.5556), 'after the buy-back 900 shares: A holds 55.56%');
ok(near(sh.paid_in, sh.ledger_capital), `the register's paid-in capital (${sh.paid_in}) equals the ledger's (${sh.ledger_capital})`);

// ---- net worth
const nw = await api('GET', '/api/capital/networth');
ok(nw._status === 200 && nw.ready, 'the net worth report is ready' + errMsg(nw));
ok(nw.balanced && near(nw.net_worth, nw.assets - nw.liabilities) && near(nw.net_worth, nw.equity), `assets (${nw.assets}) less liabilities (${nw.liabilities}) = net worth (${nw.net_worth}) = equity`);
const grp = (k) => nw.groups.find((g) => g.key === k) || {};
ok(near(grp('intangible').total, 70000) || near(grp('intangible').total, 72000), `software is under intangibles (${grp('intangible').total}), not fixed assets`);
ok(near(grp('investments').total, n(sql(`SELECT COALESCE(SUM(l.amount), 0) FROM gl_lines l JOIN gl_entries e ON e.id = l.entry_id WHERE l.account_id IN (${acct('inv_companies')}, ${acct('inv_other')}) AND e.entry_date <= '${today}'`))), 'investments are their own group');
ok(grp('loans').total > 0 && nw.loans.some((l) => l.id === loan), 'the loan is under Loans');
const chk = (k) => nw.checks.find((c) => c.key === k) || {};
ok(near(chk('investments').difference, 0), `investments register = ledger (${chk('investments').register} / ${chk('investments').ledger})`);
ok(near(chk('intangible').difference, 0), `software register = ledger (${chk('intangible').register} / ${chk('intangible').ledger})`);
ok(near(chk('loans').difference, 0), `loans owed = ledger Loans Payable (${chk('loans').register} / ${chk('loans').ledger})`);
const shared = nw.shared_assets.find((a) => a.asset_id === van);
ok(shared && shared.ownership_pct === 50 && near(shared.whole_book_value, shared.book_value * 2), 'the van shows as 50% owned, with the whole van\'s value');
const eqv = nw.asset_equity.find((a) => a.asset_id === van);
ok(eqv && near(eqv.equity, 1600000 - eqv.owed), `the business's equity in the van: market 1,600,000 less the loan (${eqv && eqv.owed}) = ${eqv && eqv.equity}`);
const adj = nw.adjustments.reduce((t, x) => t + x.amount, 0);
ok(nw.adjustments.some((x) => x.kind === 'investment') && near(nw.adjusted_net_worth, nw.net_worth + adj), 'adjusted net worth = book + market differences (the co-op stake\'s market value among them)');
ok(nw.adjustments.some((x) => x.kind === 'asset' && near(x.amount, 1600000 - shared.book_value)), 'the van\'s appraisal is one of the adjustments');
ok(nw.shares.total_shares === 900 && near(nw.shares.holders.reduce((t, h) => t + h.book, 0), nw.net_worth), 'the shareholders\' parts add up to the net worth');
ok(nw.shares.per_share && near(nw.shares.per_share.book * 900, nw.net_worth), 'net worth per share');
ok(Array.isArray(nw.trend) && nw.trend.length >= 1 && near(nw.trend[nw.trend.length - 1].net_worth, nw.net_worth), 'the trend ends at today\'s net worth');
const past = await api('GET', '/api/capital/networth?as_of=2000-01-01');
ok(past._status === 200 && near(past.net_worth, 0) && past.investments.length === 0, 'as of a date before anything, there is nothing');

// ---- the ledger's tie-out has the registers too
const tie = await api('GET', '/api/gl/tieout');
const tc = (k) => (tie.checks || []).find((c) => c.key === k) || {};
ok(near(tc('investments').difference, 0) && near(tc('share_capital').difference, 0), `tie-out: investments (${tc('investments').difference}) and share capital (${tc('share_capital').difference}) agree with the ledger`);
const cov = await api('GET', '/api/gl/coverage');
const stuck = (cov.sources || []).filter((s) => /^(inv_|share_)/.test(s.kind) && (s.waiting || s.failing.length));
ok(cov.started && !stuck.length, 'coverage: every investment and share entry is posted' + (stuck.length ? ' ' + JSON.stringify(stuck) : ''));

// ---- the page and its tile
const page = await fetch(BASE + '/assets.html', { headers: { Cookie: Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ') } });
const html = await page.text();
ok(page.status === 200 && /Asset register/.test(html) && /data-t="inv"/.test(html) && /data-t="shares"/.test(html) && /data-t="nw"/.test(html), 'the Asset register page has Investments, Shares and Net worth tabs');

console.log(`\n${pass} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
