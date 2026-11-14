// Bring the system up to date from a fresh set of legacy CSV exports.
//
//   node app/tools/legacy-sync.mjs --dir=C:\MHsrc\vision\WORK            # check only
//   node app/tools/legacy-sync.mjs --dir=C:\MHsrc\vision\WORK --apply    # check, then import
//   node app/tools/legacy-sync.mjs --dir=... --only=INVENTRY,INVOICE --apply
//
// The import page (legacy-import.js) runs this. Unlike seed-legacy.mjs, which
// builds the system from scratch, every load step here runs --new-only: it adds
// what the system does not have and brings across what the legacy program still
// owns (stock, cost and price, payments made since), and leaves everything
// else -- names, categories, groups, reps, sales and lines already loaded,
// anything done in the new system -- exactly as it is. So the same files, or a
// newer export, can be imported again and again.
//
// Steps: stage the files found (any of INVENTRY, INVOICE, INVDETAI, INVPAY,
// INVREC), report what would change (legacy-check.mjs), then with --apply run
// each loader whose file was staged, in dependency order. Lines starting '@@'
// are for the import page: @@step, @@staged, @@warn, @@check, @@result, @@done.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (n) => argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
const DIR = flag('dir');
const APPLY = argv.includes('--apply');
// --reuse-stage: the import page just checked these same files (same size and
// date, nothing run since), so the staging tables already hold them; skip
// reading 400 MB again and go straight to the loads.
const REUSE = argv.includes('--reuse-stage') && APPLY;
if (!DIR || !fs.existsSync(DIR)) { console.error('Give --dir=<folder with the CSV exports>'); process.exit(1); }

const ALL = ['INVENTRY', 'INVOICE', 'INVDETAI', 'INVPAY', 'INVREC'];
const inDir = new Set(fs.readdirSync(DIR).map((f) => f.toUpperCase()).filter((f) => f.endsWith('.CSV')).map((f) => f.slice(0, -4)));
const asked = flag('only') ? flag('only').split(',').map((s) => s.trim().toUpperCase()) : ALL;
const files = ALL.filter((f) => asked.includes(f) && inDir.has(f));
if (!files.length) { console.error('None of ' + ALL.join(', ') + ' (.csv) is in ' + DIR); process.exit(1); }

// [step, script, needs any of these files staged]
const LOADS = [
  ['suppliers', 'load-suppliers.mjs', ['INVENTRY', 'INVREC']],
  ['inventry', 'load-inventry.mjs', ['INVENTRY']],
  ['users', 'load-users.mjs', ['INVOICE']],
  ['salesreps', 'load-salesreps.mjs', ['INVDETAI']],
  ['invoices', 'load-invoices.mjs', ['INVOICE']],
  ['invdetai', 'load-invdetai.mjs', ['INVDETAI']],
  ['invpay', 'load-invpay.mjs', ['INVPAY']],
  ['invrec', 'load-invrec.mjs', ['INVREC']],
];

function run(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(HERE, script), ...args], { stdio: 'inherit', env: process.env });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${script} exited ${code}`))));
  });
}
async function step(name, script, args) {
  console.log('@@step ' + JSON.stringify({ step: name }));
  const t0 = Date.now();
  await run(script, args);
  console.log(`-- ${name} done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

const t0 = Date.now();
try {
  if (!REUSE) {
    await step('stage', 'stage-legacy.mjs', [`--dir=${DIR}`, `--only=${files.join(',')}`]);
    await step('check', 'legacy-check.mjs', [`--only=${files.join(',')}`]);
  }
  if (APPLY) {
    for (const [name, script, needs] of LOADS) {
      if (!needs.some((f) => files.includes(f))) continue;
      await step(name, script, name === 'suppliers' ? [] : ['--new-only']);
    }
  }
  console.log('@@done ' + JSON.stringify({ applied: APPLY, files, minutes: +((Date.now() - t0) / 60000).toFixed(1) }));
} catch (e) {
  console.error('\nFAILED: ' + e.message);
  console.log('@@failed ' + JSON.stringify({ error: e.message }));
  process.exit(1);
}
