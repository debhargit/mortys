// Runs the fast, dependency-light offline suite (node:sqlite route tests +
// the static wiring check) and prints a one-line summary per file. Exit 1 if
// any file fails or crashes.
//
// NOT run here: the jsdom scripts (verify-quote-ui.mjs against public/, and
// the verify-*.mjs that hit https://mortysautoparts.com). They need `jsdom` and,
// for the live ones, network + the seed admin login -- run those by hand.
// See README.md.
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const DIR = fileURLToPath(new URL('.', import.meta.url));
const OFFLINE = [
  'verify-functions.mjs',
  'p4test.mjs',
  'p6test.mjs', 'p7test.mjs', 'p8test.mjs',
  'p11test.mjs', 'p12test.mjs', 'p13test.mjs', 'p14test.mjs', 'p15test.mjs', 'p16test.mjs', 'p17test.mjs', 'p18test.mjs',
  'p19test.mjs', 'p20test.mjs', 'p21test.mjs', 'p22test.mjs', 'p23test.mjs', 'p24test.mjs',
  'presence-test.mjs', 'quote-test.mjs',
];
const present = new Set(readdirSync(DIR));
let bad = 0;
for (const f of OFFLINE) {
  if (!present.has(f)) { console.log(`SKIP  ${f} (missing)`); continue; }
  const r = spawnSync(process.execPath, [path.join(DIR, f)], { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  const fails = (out.match(/^FAIL\b/gm) || []).length;
  const passes = (out.match(/^(PASS|ok)\b/gm) || []).length;
  const allClear = /all clear|checks$/m.test(out.trim().split('\n').slice(-3).join('\n'));
  const crashed = r.status !== 0 && !/^\d+ checks$/m.test(out);
  const okLine = fails === 0 && !crashed;
  if (!okLine) bad++;
  console.log(`${okLine ? 'OK  ' : 'FAIL'}  ${f.padEnd(22)} pass=${passes} fail=${fails}${crashed ? ' CRASHED (exit ' + r.status + ')' : ''}`);
  if (!okLine) console.log(out.split('\n').filter((l) => /^FAIL|Error:|TypeError|MIGRATION FAIL/.test(l)).slice(0, 4).map((l) => '        ' + l).join('\n'));
}
console.log(bad ? `\n${bad} file(s) failed` : '\nall offline tests green');
process.exit(bad ? 1 : 0);
