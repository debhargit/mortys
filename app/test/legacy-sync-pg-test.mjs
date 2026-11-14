// The legacy import (tools/legacy-sync.mjs, the import page's engine) against
// a throwaway Postgres: a first export with the October column names, then a
// newer one with the legacy program's own names (DESCR1, CL_NAME, PCOST...)
// that adds a part, changes one, adds an invoice, a payment on an older
// account invoice and a receipt. Only what is new comes across; edits made in
// the new system stay; running the same files again adds nothing.
//
//   LS_TEST_DB=postgresql://postgres@127.0.0.1:5495/legacy LS_TEST_PSQL="psql -h 127.0.0.1 -p 5495 -U postgres -d legacy" node test/legacy-sync-pg-test.mjs
//
// Refuses the live database's port (5435).
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DB = process.env.LS_TEST_DB, PSQL = process.env.LS_TEST_PSQL;
if (!DB || !PSQL || /:5435\b/.test(DB) || /-p\s*5435\b/.test(PSQL)) { console.log('FAIL LS_TEST_DB and LS_TEST_PSQL must point at a throwaway database (never port 5435)'); process.exit(1); }
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fails = 0;
const ok = (c, m) => { if (c) { pass++; console.log('PASS ' + m); } else { fails++; console.log('FAIL ' + m); } };
const sql = (q) => execSync(PSQL + ' -tA', { input: q, encoding: 'utf8' }).trim();
const S = Date.now().toString(36).toUpperCase();          // keeps reruns on one database apart
const csv = (rows) => rows.map((r) => r.map((v) => (/[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : v)).join(',')).join('\r\n') + '\r\n';
function write(dir, name, rows) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name), csv(rows)); }
function sync(dir, apply) {
  const r = spawnSync(process.execPath, [path.join(APP, 'tools', 'legacy-sync.mjs'), '--dir=' + dir].concat(apply ? ['--apply'] : []),
    { env: Object.assign({}, process.env, { VISION_DB_URL: DB }), encoding: 'utf8', maxBuffer: 1 << 26 });
  const lines = (r.stdout || '').split('\n');
  const tagged = (t) => lines.filter((l) => l.startsWith('@@' + t + ' ')).map((l) => JSON.parse(l.slice(t.length + 3)));
  return { code: r.status, out: r.stdout + r.stderr, check: tagged('check')[0], results: tagged('result'), done: tagged('done')[0], warn: tagged('warn') };
}
const A = 'T' + S + '-A', B = 'T' + S + '-B', C = 'T' + S + '-C';
const I1 = 'T' + S + '1', I2 = 'T' + S + '2', I3 = 'T' + S + '3';
const SUP = 'ACME PARTS ' + S, CUST = 'TEST GARAGE ' + S, CLERK = 'TCLERK' + S;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-sync-'));

// ---- the first export: October column names ---------------------------------
const v1 = path.join(tmp, 'v1');
write(v1, 'INVENTRY.csv', [['SKU', 'LOCATION', 'PART NAME', 'DESCR2', 'QUANTITY', 'MIN_LEV', 'TAXCODE', 'COST', 'PRICE', 'MARGIN', 'UNIT', 'BRAND', 'MODEL', 'WHOLEPRICE', 'SUPPLIER'],
  [A, 'A1*C', 'BRAKE PAD SET', '', '10', '2', 'Y', '100.00', '150.00', '50', 'EA', 'TOYOTA', 'COROLLA', '150.00', SUP],
  [B, 'B2*C', 'OIL FILTER', '', '20', '5', 'Y', '40.00', '65.00', '62', 'EA', '', '', '65.00', SUP]]);
write(v1, 'INVOICE.csv', [['INV_NUMBER', 'INV_DATE', 'INV_TIME', 'SALESPERSN', 'CUSTOMER', 'ADDRESS1', 'ADDRESS2', 'PHONE', 'REFERENCE', 'SUB_TOTAL', 'TAX', 'TOTAL', 'TOTAL_PAID', 'STATUS', 'TAXABLE', 'PRICING', 'CRED_TERMS', 'TRANNO', 'USER'],
  [I1, '10/5/2026', '1015', CLERK, 'CASH', '', '', '', '', '150.00', '22.50', '172.50', '172.50', 'A', 'Y', 'R', '', 'X' + S + '1', CLERK],
  [I2, '10/6/2026', '1130', CLERK, CUST, '1 Main St', '', '876-555-0101', '', '260.87', '39.13', '300.00', '0.00', 'A', 'Y', 'R', 'N30', 'X' + S + '2', CLERK]]);
write(v1, 'INVDETAI.csv', [['INV_NUMBER', 'LIN_NUMBER', 'SKU', 'PART NAME', 'QUANTITY', 'UNIT', 'DISC', 'TAX', 'AMOUNT', 'DDATE', 'SALESPERSN', 'TRANNO', 'CUSTOMER', 'USER'],
  [I1, '1', A, 'BRAKE PAD SET', '1', '150.00', '0', 'Y', '150.00', '10/5/2026', CLERK, 'X' + S + '1', 'CASH', CLERK],
  [I2, '1', B, 'OIL FILTER', '4', '65.22', '0', 'Y', '260.87', '10/6/2026', CLERK, 'X' + S + '2', CUST, CLERK]]);
write(v1, 'INVPAY.csv', [['INV_NUMBER', 'CL_NAME', 'PAY_DATE', 'PAY_DESC', 'PAY_DESC2', 'AMOUNT', 'PAY_NUMBER', 'PAY_TIME', 'SALESPERSN', 'ACCOUNT', 'INVNUM21', 'TRANNO', 'CR_NUMBER', 'A', 'USER'],
  [I1, 'CASH', '10/5/2026', 'CASH', '', '172.50', '', '10:16:', CLERK, '', '', 'P' + S + '1', I1, '', CLERK]]);
write(v1, 'INVREC.csv', [['SKU', 'SUPPLIER', 'REC_DATE', 'QTY', 'LCOST', 'LCOSTCURR', 'COST', 'PCOSTCURR', 'PRICE', 'LPRICECURR', 'LWPRICE', 'REFERENCE'],
  [A, SUP, '10/1/2026', '5', '100.00', 'JA', '100.00', 'JA', '150.00', 'JA', '150.00', 'BILL-' + S + '-1']]);

let r = sync(v1, true);
ok(r.code === 0 && r.done && r.done.applied, 'the first export imports' + (r.code ? '\n' + r.out.slice(-1500) : ''));
ok(sql(`SELECT stock_count || '/' || cost_usd::float || '/' || price_usd::float FROM products WHERE img = '${A}'`) === '10/100/150', 'part A: 10 in stock at cost 100, price 150');
ok(sql(`SELECT count(*) FROM pos_sales WHERE invoice_number IN ('${I1}', '${I2}')`) === '2', 'two invoices');
ok(sql(`SELECT count(*) FROM pos_sale_items i JOIN pos_sales s ON s.id = i.sale_id WHERE s.invoice_number IN ('${I1}', '${I2}')`) === '2', 'their two lines');
ok(sql(`SELECT count(*) FROM sale_payments p JOIN pos_sales s ON s.id = p.sale_id WHERE s.invoice_number = '${I1}'`) === '1', 'the cash payment');
ok(sql(`SELECT count(*) FROM purchase_orders WHERE invoice_number = 'BILL-${S}-1'`) === '1', 'the receipt from the supplier');
ok(sql(`SELECT count(*) FROM users WHERE upper(name) = '${CUST}'`) === '1', 'the account customer is added');
const clerk = sql(`SELECT id FROM users WHERE is_staff AND upper(regexp_replace(name, '[^A-Za-z0-9]', '', 'g')) = '${CLERK}'`);
ok(!!clerk && sql(`SELECT count(*) FROM user_category_members m JOIN user_categories c ON c.id = m.category_id WHERE c.code = 'sales_rep' AND m.user_id = ${clerk}`) === '1', 'the new clerk is added, in the Sales rep group');

// ---- changes made in the new system since -----------------------------------
sql(`UPDATE products SET name = 'Brake pads (front)', category = 'brakes' WHERE img = '${A}';
     DELETE FROM user_category_members WHERE user_id = ${clerk}`);

// ---- the newer export: the legacy program's own column names ----------------
const v2 = path.join(tmp, 'v2');
write(v2, 'INVENTRY.csv', [['SKU', 'LOCATION', 'DESCR1', 'DESCR2', 'QUANTITY', 'MIN_LEV', 'TAXCODE', 'COST', 'COSTCURR', 'PRICE', 'PRICECURR', 'MARGIN', 'UNIT', 'CATEGORY', 'MODEL', 'WHOLEPRICE', 'SUPPLIER'],
  [A, 'A1*C', 'BRAKE PAD SET', '', '7', '2', 'Y', '110.00', 'JA', '160.00', 'JA', '45', 'EA', 'TOYOTA', 'COROLLA', '160.00', SUP],
  [B, 'B2*C', 'OIL FILTER', '', '20', '5', 'Y', '40.00', 'JA', '65.00', 'JA', '62', 'EA', '', '', '65.00', SUP],
  [C, 'C3*C', 'SPARK PLUG', '', '30', '6', 'Y', '25.00', 'JA', '45.00', 'JA', '80', 'EA', '', '', '45.00', SUP]]);
write(v2, 'INVOICE.csv', [['INV_NUMBER', 'INV_DATE', 'INV_TIME', 'SALESPERSN', 'CL_NAME', 'CL_ADDR1', 'CL_ADDR2', 'CL_PHONE', 'REFERENCE', 'SUB_TOTAL', 'TAX', 'TOTAL', 'TOTAL_PAID', 'STATUS', 'TAXABLE', 'PRICING', 'CRED_TERMS', 'TRANNO', 'USER'],
  [I1, '10/5/2026', '1015', CLERK, 'CASH', '', '', '', '', '150.00', '22.50', '172.50', '172.50', 'A', 'Y', 'R', '', 'X' + S + '1', CLERK],
  [I2, '10/6/2026', '1130', CLERK, CUST, '1 Main St', '', '876-555-0101', '', '260.87', '39.13', '300.00', '300.00', 'A', 'Y', 'R', 'N30', 'X' + S + '2', CLERK],
  [I3, '10/20/2026', '0905', CLERK, 'CASH', '', '', '', '', '90.00', '13.50', '103.50', '103.50', 'A', 'Y', 'R', '', 'X' + S + '3', CLERK]]);
write(v2, 'INVDETAI.csv', [['INV_NUMBER', 'LIN_NUMBER', 'SKU', 'DESC', 'QUANTITY', 'UNIT', 'DISC', 'TAX', 'AMOUNT', 'DDATE', 'SALESPERSN', 'TRANNO', 'CL_NAME', 'USER'],
  [I1, '1', A, 'BRAKE PAD SET', '1', '150.00', '0', 'Y', '150.00', '10/5/2026', CLERK, 'X' + S + '1', 'CASH', CLERK],
  [I2, '1', B, 'OIL FILTER', '4', '65.22', '0', 'Y', '260.87', '10/6/2026', CLERK, 'X' + S + '2', CUST, CLERK],
  [I3, '1', C, 'SPARK PLUG', '2', '45.00', '0', 'Y', '90.00', '10/20/2026', CLERK, 'X' + S + '3', 'CASH', CLERK]]);
write(v2, 'invpay.csv', [['INV_NUMBER', 'CL_NAME', 'PAY_DATE', 'PAY_DESC', 'PAY_DESC2', 'AMOUNT', 'PAY_NUMBER', 'PAY_TIME', 'SALESPERSN', 'ACCOUNT', 'INVNUM21', 'TRANNO', 'CR_NUMBER', 'A', 'USER'],
  [I1, 'CASH', '10/5/2026', 'CASH', '', '172.50', '', '10:16:', CLERK, '', '', 'P' + S + '1', I1, '', CLERK],
  [I2, CUST, '10/25/2026', 'CHEQUE', 'NCB 10023', '300.00', '', '14:02:', CLERK, '', '', 'P' + S + '2', I2, '', CLERK],
  [I3, 'CASH', '10/20/2026', 'CASH', '', '103.50', '', '09:06:', CLERK, '', '', 'P' + S + '3', I3, '', CLERK]]);
write(v2, 'INVREC.csv', [['SKU', 'SUPPLIER', 'REC_DATE', 'QTY', 'LCOST', 'LCOSTCURR', 'PCOST', 'PCOSTCURR', 'LPRICE', 'LPRICECURR', 'LWPRICE', 'REFERENCE'],
  [A, SUP, '10/1/2026', '5', '100.00', 'JA', '100.00', 'JA', '150.00', 'JA', '150.00', 'BILL-' + S + '-1'],
  [C, SUP, '10/18/2026', '30', '25.00', 'JA', '25.00', 'JA', '45.00', 'JA', '45.00', 'BILL-' + S + '-2']]);

// Check first: it says what will change and changes nothing.
r = sync(v2, false);
ok(r.code === 0 && r.check && r.done && !r.done.applied, 'Check runs on the newer export' + (r.code ? '\n' + r.out.slice(-1500) : ''));
const k = r.check || {};
ok(k.inventory && k.inventory.new_parts === 1 && k.inventory.stock_changed >= 1 && k.inventory.cost_changed >= 1, 'Check: one new part; stock and cost changed on part A');
ok(k.invoices && k.invoices.new_invoices === 1 && k.invoices.new_to === '2026-10-20' && k.invoices.paid_since >= 1, 'Check: one new invoice (20 Oct), one older invoice paid since');
ok(k.receipts && k.receipts.new_receipts === 1, 'Check: one new receipt');
ok(k.payments && k.payments.for_new_invoices === 1 && k.payments.invoices_paid_since >= 1, 'Check: a payment for the new invoice, more payments on an older one');
ok(sql(`SELECT count(*) FROM products WHERE img = '${C}'`) === '0' && sql(`SELECT count(*) FROM pos_sales WHERE invoice_number = '${I3}'`) === '0', 'Check changed nothing');

r = sync(v2, true);
ok(r.code === 0 && r.done && r.done.applied, 'the newer export imports' + (r.code ? '\n' + r.out.slice(-1500) : ''));
ok(sql(`SELECT stock_count || '/' || cost_usd::float || '/' || price_usd::float FROM products WHERE img = '${A}'`) === '7/110/160', 'part A: stock 7, cost 110, price 160 from the legacy program');
ok(sql(`SELECT name || '/' || category FROM products WHERE img = '${A}'`) === 'Brake pads (front)/brakes', '… its name and category edited in the new system are kept');
ok(sql(`SELECT stock_count FROM products WHERE img = '${C}'`) === '30', 'part C is added');
ok(sql(`SELECT count(*) FROM pos_sales WHERE invoice_number IN ('${I1}', '${I2}', '${I3}')`) === '3', 'three invoices: the new one added, none twice');
ok(sql(`SELECT amount_paid_usd::float || '/' || payment_status FROM pos_sales WHERE invoice_number = '${I2}'`) === '300/paid', 'the account invoice shows paid');
ok(sql(`SELECT count(*) FROM pos_sale_items i JOIN pos_sales s ON s.id = i.sale_id WHERE s.invoice_number IN ('${I1}', '${I2}', '${I3}')`) === '3', 'lines: one each, none doubled');
ok(sql(`SELECT string_agg(s.invoice_number || ':' || p.method || ':' || p.amount_usd::float, ',' ORDER BY s.invoice_number) FROM sale_payments p JOIN pos_sales s ON s.id = p.sale_id WHERE s.invoice_number IN ('${I1}', '${I2}', '${I3}')`)
  === `${I1}:cash:172.5,${I2}:cheque:300,${I3}:cash:103.5`, 'payments: the cheque on the older invoice and the new cash payment, none doubled');
ok(sql(`SELECT count(*) FROM purchase_orders WHERE invoice_number IN ('BILL-${S}-1', 'BILL-${S}-2')`) === '2', 'receipts: the new one added, the old one once');
ok(sql(`SELECT count(*) FROM purchase_order_items i JOIN purchase_orders p ON p.id = i.po_id WHERE p.invoice_number = 'BILL-${S}-1'`) === '1', '… the old receipt keeps its one line');
ok(sql(`SELECT count(*) FROM user_category_members m JOIN user_categories c ON c.id = m.category_id WHERE c.code = 'sales_rep' AND m.user_id = ${clerk}`) === '0', 'the clerk taken out of Sales rep in the new system is not put back');
const res = Object.fromEntries((r.results || []).map((x) => [x.step, x]));
ok(res.inventry && res.inventry.added === 1 && res.invoices && res.invoices.added === 1 && res.invrec && res.invrec.added === 1, 'the import reports what it added');

// The same files again: nothing new.
const count = () => sql(`SELECT (SELECT count(*) FROM pos_sales) || '/' || (SELECT count(*) FROM pos_sale_items) || '/' || (SELECT count(*) FROM sale_payments) || '/' || (SELECT count(*) FROM purchase_orders) || '/' || (SELECT count(*) FROM purchase_order_items) || '/' || (SELECT count(*) FROM products) || '/' || (SELECT count(*) FROM users)`);
const before = count();
r = sync(v2, true);
ok(r.code === 0 && count() === before, 'importing the same files again adds nothing');

// A file cut at Excel's row limit is called out.
const v3 = path.join(tmp, 'v3');
fs.mkdirSync(v3);
const head = 'INV_NUMBER,LIN_NUMBER,SKU,DESC,QUANTITY,UNIT,DISC,TAX,AMOUNT,DDATE,SALESPERSN,TRANNO,CL_NAME,USER\r\n';
const row = (i) => 'Z' + S + i + ',1,' + A + ',X,1,1,0,Y,1,1/2/2020,' + CLERK + ',Q' + i + ',CASH,' + CLERK + '\r\n';
const fd = fs.openSync(path.join(v3, 'INVDETAI.csv'), 'w');
fs.writeSync(fd, head);
let buf = '';
for (let i = 0; i < 1048575; i++) { buf += row(i); if (buf.length > 1 << 20) { fs.writeSync(fd, buf); buf = ''; } }
fs.writeSync(fd, buf); fs.closeSync(fd);
r = sync(v3, false);
ok(r.code === 0 && r.warn.some((w) => w.file === 'INVDETAI' && w.reason === 'excel-limit') && r.check.lines.excel_limit === true, 'a file of exactly 1,048,575 rows is flagged as cut short by Excel');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n' + pass + ' passed, ' + fails + ' failed');
process.exit(fails ? 1 : 0);
