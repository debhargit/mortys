// Stage the legacy CSV exports into the legacy_* tables verbatim.
//
//   node app/tools/stage-legacy.mjs [INVENTRY] [INVOICE] [INVDETAI] [INVPAY] [INVREC]
//   node app/tools/stage-legacy.mjs --only=INVOICE,INVPAY
//   node app/tools/stage-legacy.mjs --dir=C:\path\to\exports
//
// Every value is carried across as text with only whitespace trimmed -- no date
// or money coercion happens here. That keeps this step a faithful copy of the
// source (so bad values stay visible and auditable) and leaves all cleaning to
// the load-*.mjs transforms that read these tables.
//
// Each file's staging table is TRUNCATEd first, so re-running is idempotent.

import fs from 'node:fs';
import path from 'node:path';
import { readCsv, clean } from './lib/csv-stream.mjs';
import { copyInto, pool, ROOT, fmt, ensureLegacySchema } from './lib/db.mjs';

const argv = process.argv.slice(2);
const flag = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const DIR = flag('dir') || ROOT;
const ONLY = flag('only')?.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);

// The October 2026 exports had some columns renamed by hand (PART NAME, BRAND,
// CUSTOMER...); a straight export from the legacy program keeps its own field
// names (DESCR1, CATEGORY, CL_NAME...). Each field takes whichever is there.
const either = (...v) => v.find((x) => x !== undefined);

// source file -> { table, cols, pick(record) -> array in cols order }
// `cols` deliberately omits src_line; it is appended by the runner.
const SPECS = {
  INVENTRY: {
    table: 'legacy_inventry',
    cols: ['sku', 'location', 'part_name', 'descr2', 'quantity', 'min_lev', 'max_lev', 'cost', 'price',
      'wholeprice', 'margin', 'unit', 'brand', 'model', 'supplier', 'taxcode', 'txrate', 'active',
      'type', 'receiveqty', 'soldqty', 'ini_date', 'commish', 'discount'],
    pick: (r) => [r.SKU, r.LOCATION, either(r['PART NAME'], r.DESCR1), r.DESCR2, r.QUANTITY, r.MIN_LEV, r.MAX_LEV, r.COST,
      r.PRICE, r.WHOLEPRICE, r.MARGIN, r.UNIT, either(r.BRAND, r.CATEGORY), r.MODEL, r.SUPPLIER, r.TAXCODE, r.TXRATE,
      r.ACTIVE, r.TYPE, r.RECEIVEQTY, r.SOLDQTY, r.INI_DATE, r.COMMISH, r.DISCOUNT],
  },
  INVOICE: {
    table: 'legacy_invoice',
    cols: ['inv_number', 'inv_date', 'inv_time', 'salespersn', 'customer', 'address1', 'address2',
      'phone', 'reference', 'sub_total', 'tax', 'total', 'total_paid', 'status', 'taxable', 'pricing',
      'cred_terms', 'labour', 'tranno', 'cl_number', 'cr_number', 'credit', 'app_user', 'change_due',
      'reason', 'receipt', 'tend'],
    pick: (r) => [r.INV_NUMBER, r.INV_DATE, r.INV_TIME, r.SALESPERSN, either(r.CUSTOMER, r.CL_NAME), either(r.ADDRESS1, r.CL_ADDR1), either(r.ADDRESS2, r.CL_ADDR2),
      either(r.PHONE, r.CL_PHONE), r.REFERENCE, r.SUB_TOTAL, r.TAX, r.TOTAL, r.TOTAL_PAID, r.STATUS, r.TAXABLE, r.PRICING,
      r.CRED_TERMS, r.LABOUR, r.TRANNO, r.CL_NUMBER, r.CR_NUMBER, r.CREDIT, r.USER, r.CHANGE,
      r.REASON, r.RECEIPT, r.TEND],
  },
  INVDETAI: {
    table: 'legacy_invdetai',
    cols: ['inv_number', 'lin_number', 'sku', 'part_name', 'quantity', 'unit_price', 'disc', 'tax',
      'amount', 'ddate', 'salespersn', 'det_time', 'taxamt', 'status', 'cost', 'customer', 'txrate',
      'tranno', 'cr_number', 'sprice', 'app_user'],
    // NB: the column literally named UNIT holds the unit PRICE, not a UOM.
    pick: (r) => [r.INV_NUMBER, r.LIN_NUMBER, r.SKU, either(r['PART NAME'], r.DESC), r.QUANTITY, r.UNIT, r.DISC, r.TAX,
      r.AMOUNT, r.DDATE, r.SALESPERSN, r.DET_TIME, r.TAXAMT, r.STATUS, r.COST, either(r.CUSTOMER, r.CL_NAME), r.TXRATE,
      r.TRANNO, r.CR_NUMBER, r.SPRICE, r.USER],
  },
  INVPAY: {
    table: 'legacy_invpay',
    cols: ['inv_number', 'cl_name', 'pay_date', 'pay_desc', 'pay_desc2', 'amount', 'pay_number',
      'pay_time', 'salespersn', 'tranno', 'cr_number', 'app_user'],
    pick: (r) => [r.INV_NUMBER, r.CL_NAME, r.PAY_DATE, r.PAY_DESC, r.PAY_DESC2, r.AMOUNT, r.PAY_NUMBER,
      r.PAY_TIME, r.SALESPERSN, r.TRANNO, r.CR_NUMBER, r.USER],
  },
  INVREC: {
    table: 'legacy_invrec',
    cols: ['sku', 'supplier', 'rec_date', 'qty', 'cost', 'lcost', 'price', 'reference', 'sub_total',
      'txrate', 'total', 'total_paid', 'pay_date', 'orderby', 'lin_number', 'descr', 'unit', 'disc',
      'tax', 'det_time', 'salespersn', 'app_user'],
    pick: (r) => [r.SKU, r.SUPPLIER, r.REC_DATE, r.QTY, either(r.COST, r.PCOST), r.LCOST, either(r.PRICE, r.LPRICE), r.REFERENCE,
      r.SUB_TOTAL, r.TXRATE, r.TOTAL, r.TOTAL_PAID, r.PAY_DATE, r.ORDERBY, r.LIN_NUMBER, r.DESC,
      r.RATE, r.DISC, r.TAX, r.DET_TIME, r.SALESPERSN, r.USER],
  },
};

// Positional file overrides, in SPECS order, for callers that pass paths.
const NAMES = Object.keys(SPECS);
const positional = argv.filter((a) => !a.startsWith('--'));
// The file name in any case (the legacy program writes invpay.csv as well as INVPAY.csv).
const pathFor = (name) => {
  const i = NAMES.indexOf(name);
  if (positional[i]) return positional[i];
  const hit = fs.existsSync(DIR) && fs.readdirSync(DIR).find((f) => f.toUpperCase() === name + '.CSV');
  return path.join(DIR, hit || `${name}.csv`);
};
// Excel stops a sheet at 1,048,576 rows (header + 1,048,575). A file saved
// through Excel with exactly that many rows has almost certainly lost the rest.
const EXCEL_ROWS = 1048575;

const targets = (ONLY || NAMES).filter((n) => {
  if (!SPECS[n]) { console.error(`unknown source: ${n}`); process.exit(1); }
  return true;
});

const db = pool(2);
try {
  await ensureLegacySchema(db);
  for (const name of targets) {
    const spec = SPECS[name];
    const file = pathFor(name);
    if (!fs.existsSync(file)) { console.error(`! ${name}: not found at ${file} -- skipped`); continue; }

    const bytes = fs.statSync(file).size;
    process.stdout.write(`${name.padEnd(9)} ${(bytes / 1048576).toFixed(0)} MB  -> ${spec.table} ... `);
    await db.query(`TRUNCATE ${spec.table}`);

    const cols = [...spec.cols, 'src_line'];
    let line = 1;                       // header is line 1; first data row is 2
    const t0 = Date.now();

    async function* rows() {
      for await (const rec of readCsv(file)) {
        line++;
        const vals = spec.pick(rec).map((v) => {
          const s = clean(v);
          return s === '' ? null : s;
        });
        yield [...vals, line];
      }
    }

    const n = await copyInto(spec.table, cols, rows());
    const secs = (Date.now() - t0) / 1000;
    console.log(`${fmt(n)} rows in ${secs.toFixed(1)}s`);
    if (n >= EXCEL_ROWS - 10 && n <= EXCEL_ROWS) {
      console.log(`  ! ${name} has ${fmt(n)} rows: Excel's limit. The file was probably cut short when saved through Excel;`
        + ' export it straight from the legacy program (or with tools/dbf2csv.mjs) to get the rest.');
      console.log('@@warn ' + JSON.stringify({ file: name, rows: n, reason: 'excel-limit' }));
    }
    console.log('@@staged ' + JSON.stringify({ file: name, rows: n, path: file }));
  }

  console.log('\nstaged row counts:');
  for (const name of targets) {
    const { rows: [{ c }] } = await db.query(`SELECT count(*)::bigint AS c FROM ${SPECS[name].table}`);
    console.log(`  ${SPECS[name].table.padEnd(18)} ${fmt(c)}`);
  }
} catch (e) {
  console.error('\nFAILED:', e.message);
  process.exitCode = 1;
} finally {
  await db.end();
}
