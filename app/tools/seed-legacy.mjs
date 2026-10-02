// Seed the whole system from the legacy DOS/FoxPro CSV exports, in dependency
// order.
//
//   node app/tools/seed-legacy.mjs                 # stage + load everything
//   node app/tools/seed-legacy.mjs --skip-stage     # reuse what is already staged
//   node app/tools/seed-legacy.mjs --from=invoices  # resume at a step
//   node app/tools/seed-legacy.mjs --dir=D:\exports # CSVs live elsewhere
//   node app/tools/seed-legacy.mjs --dry-run        # just print the plan
//
// Expects INVENTRY.csv, INVOICE.csv, INVDETAI.csv, INVPAY.csv and INVREC.csv in
// the repo root (or --dir), and migration 0062_legacy_import.sql applied.
//
// Order matters: suppliers before products (products.supplier_id), users before
// the rep roster (mechanics mirrors staff users), both before invoices
// (pos_sales FKs cashier/customer/rep), invoices before lines and payments
// (they FK pos_sales.id), and the reconcile pass last.
//
// Every step is idempotent, so the whole thing can be re-run safely.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (n) => argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
const has = (n) => argv.includes(`--${n}`);

const DIR = flag('dir');
const FROM = flag('from');
const DRY = has('dry-run');
const SKIP_STAGE = has('skip-stage');

const STEPS = [
  ['stage',      'stage-legacy.mjs',        DIR ? [`--dir=${DIR}`] : [],  'copy all five CSVs into the legacy_* staging tables'],
  ['suppliers',  'load-suppliers.mjs',      [], 'suppliers from INVENTRY + INVREC'],
  ['inventry',   'load-inventry.mjs',       [], 'products from INVENTRY (the inventory)'],
  ['users',      'load-users.mjs',          [], 'staff + account customers from INVOICE'],
  ['salesreps',  'load-salesreps.mjs',      [], 'sales rep roster (mechanics) from INVDETAI'],
  ['invoices',   'load-invoices.mjs',       [], 'invoice headers from INVOICE -> pos_sales'],
  ['invdetai',   'load-invdetai.mjs',       [], 'items sold from INVDETAI -> pos_sale_items'],
  ['invpay',     'load-invpay.mjs',         [], 'payments received from INVPAY -> sale_payments'],
  ['invrec',     'load-invrec.mjs',         [], 'inventory received from INVREC -> purchase orders'],
  ['reconcile',  'reconcile-invoices.mjs',  ['--apply'], 're-check invoices against INVDETAI and the payment ledger'],
];

let plan = STEPS;
if (SKIP_STAGE) plan = plan.filter((s) => s[0] !== 'stage');
if (FROM) {
  const i = plan.findIndex((s) => s[0] === FROM);
  if (i < 0) {
    console.error(`unknown --from step: ${FROM}\nsteps: ${STEPS.map((s) => s[0]).join(', ')}`);
    process.exit(1);
  }
  plan = plan.slice(i);
}

console.log('seed plan:');
for (const [name, , , why] of plan) console.log(`  ${name.padEnd(11)} ${why}`);
if (DRY) { console.log('\n--dry-run: nothing executed'); process.exit(0); }

function run(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(HERE, script), ...args], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${script} exited ${code}`)));
  });
}

const t0 = Date.now();
for (const [name, script, args] of plan) {
  const started = Date.now();
  console.log(`\n${'='.repeat(72)}\n== ${name}  (${script})\n${'='.repeat(72)}`);
  try {
    await run(script, args);
  } catch (e) {
    console.error(`\nseed FAILED at step "${name}": ${e.message}`);
    console.error(`fix the cause, then resume with:  node app/tools/seed-legacy.mjs --skip-stage --from=${name}`);
    process.exit(1);
  }
  console.log(`-- ${name} done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}
console.log(`\nall steps complete in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
