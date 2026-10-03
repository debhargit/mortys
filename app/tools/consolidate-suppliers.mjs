// Consolidate duplicate supplier / vendor names.
//
//   node app/tools/consolidate-suppliers.mjs                  # dry run (default)
//   node app/tools/consolidate-suppliers.mjs --apply
//   node app/tools/consolidate-suppliers.mjs --include-fuzzy   # also the typo class
//   node app/tools/consolidate-suppliers.mjs --apply --include-fuzzy
//
// `suppliers` was loaded from two legacy exports that disagree about the same
// businesses, so the Suppliers report and the Vendor Directory both list one
// trading name several times:
//
//   INVENTRY truncates the supplier field at 23 characters, INVREC carries it
//   in full. That is why rows pair up as "BEARING & ACCESSORIES L" (95 parts,
//   no POs) alongside "BEARING & ACCESSORIES LTD" (no parts, 102 POs) -- one
//   row holds the catalogue side of a supplier and the other its purchase
//   history, and no screen shows them together.
//
//   On top of that the field was typed by hand for years: AUTO-DON / AUTO DON,
//   AUTOPARTS FACTORY / AUTO PARTS FACTORY, BEARING & SEALS LTD / BEARINGS &
//   SEALS LTD / BEARING & SEALS CO LTD, APACHE AUTO / APACHI AUTO.
//
// Three match classes, in descending confidence:
//
//   identical    the normalised names are equal -- punctuation, '&'/'and',
//                spacing, plural 's' and a trailing LTD / CO / COMPANY / INC /
//                JA / JAMAICA all removed. "AUTOPARTS FACTORY" = "AUTO PARTS
//                FACTORY"; "BEARING & SEALS CO LTD" = "BEARINGS & SEALS LTD".
//   truncation   one normalised name is a strict prefix of another and is at
//                least 18 characters, which is the legacy field width's
//                signature. This is the INVENTRY/INVREC split above.
//   fuzzy        edit distance <= 2 on names of 8+ characters, at most 20% of
//                the length. Catches the typos. NOT applied unless asked:
//                two genuinely different businesses can be one letter apart.
//
// Applied classes are closed transitively, so if `identical` links A-B and
// `truncation` links B-C then A, B and C become one supplier.
//
// The surviving row is the longest original name -- the most complete spelling,
// not the truncated one -- breaking ties on how much references it. Every other
// row has products.supplier_id and purchase_orders.supplier_id repointed at the
// survivor and is then deleted, its name kept in supplier_merges so the old
// spelling is still searchable and the merge can be audited or undone. Only
// `name` and `is_active` carry data on this table, so nothing else is lost.
//
// Placeholders are never merged, in either direction: STOCK TAKING (911 parts,
// 794 POs) and MISCELLANEOUS (296/306) are not businesses, and a name of three
// characters or fewer is too generic to match on safely. They are listed at the
// end so they can be dealt with by hand.

import { pool, fmt } from './lib/db.mjs';

const APPLY = process.argv.includes('--apply');
const FUZZY = process.argv.includes('--include-fuzzy');
// Off by default: names are tidied within each list, and the parts side is not
// stitched onto the purchase-history side. See the comment in union().
const ACROSS = process.argv.includes('--across-lists');

// Not businesses. Compared on the normalised form.
const PLACEHOLDERS = new Set(['STOCKTAKING', 'MISCELLANEOUS', 'MISC', 'AUTOPART', 'BEARING', 'BEAR',
  'BERT', 'NONE', 'NA', 'UNKNOWN', 'CASH', 'SUNDRY']);
const SUFFIXES = ['LTD', 'LIMITED', 'COMPANY', 'CO', 'INC', 'INCORPORATED', 'JA', 'JAMAICA', 'WI'];

// Spellings adjudicated by hand: where a group contains one of these, it is the
// name that survives, whatever the heuristics would have picked. Needed only
// where a misspelling is both longer AND more used than the correct spelling,
// which no rule can see through -- "Antilles" and "Courtney" are words and
// "Antilies" and "Courtnery" are not. Add to this rather than letting a typo
// become the canonical supplier name.
const PREFER = new Set(['ANTILLES TYRE COMPANY L', 'COURTNEY LYN', 'BERTS AUTO PARTS']);

// Spaced normal form: what a human would call the same name.
function normSpaced(raw) {
  let s = String(raw || '').toUpperCase()
    // Apostrophes are DELETED, not turned into a space like the other
    // punctuation. Spacing them splits a possessive into a stray one-letter
    // token -- "STEPHENSON'S" became "STEPHENSON S" while "STEPHENSONS"
    // became "STEPHENSON", so the two spellings of the same shop never
    // matched. Same for DANGEL'S/DANGELS and SHELDON'S/SHELDON.
    .replace(/['‘’ʼ`]/g, '')
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Drop trailing company suffixes, repeatedly: "SEALS CO LTD" -> "SEALS".
  let words = s.split(' ').filter(Boolean);
  // A name the legacy field cut off can end mid-suffix -- "SHELDON'S AUTO
  // PARTS LT", "AUTO DON TRADING COMPAN". Treat a final word that is a proper
  // prefix of a real suffix as that suffix, but ONLY on a name long enough to
  // have actually been truncated (the field is 23 characters) and only from
  // two letters up. Without the length guard this would eat an ordinary word
  // that happens to start a suffix, like a trailing "IN".
  // A single surviving letter counts too -- the cut can land one character in,
  // leaving "DAYTONA SALES COMPANY L" against "DAYTONA SALES COMPANY LTD"
  // (3,506 parts on one row, 973 purchase orders on the other). Only on a name
  // already at the truncation width, so an ordinary trailing initial on a short
  // name is never touched.
  const maybeCut = String(raw || '').trim().length >= 22;
  const isSuffix = (w) => SUFFIXES.includes(w)
    || (maybeCut && w.length >= 1 && SUFFIXES.some((x) => x.length > w.length && x.startsWith(w)));
  while (words.length > 1 && isSuffix(words[words.length - 1])) words.pop();
  // De-pluralise words long enough that a trailing S is not part of the stem,
  // so BEARING/BEARINGS and SEAL/SEALS collapse.
  words = words.map((w) => (w.length >= 4 && w.endsWith('S') && !w.endsWith('SS') ? w.slice(0, -1) : w));
  return words.join(' ');
}
// Spaceless key: also collapses AUTOPARTS vs AUTO PARTS.
const normKey = (raw) => normSpaced(raw).replace(/ /g, '');

function editDistance(a, b) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 2) return 99;   // we only care about <= 2
  const prev = new Array(b.length + 1);
  const cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

const db = pool(2);
const c = await db.connect();
try {
  const { rows: sup } = await c.query(`
    SELECT s.id, s.name,
           coalesce(p.n, 0)::int  AS parts,
           coalesce(o.n, 0)::int  AS pos
      FROM suppliers s
      LEFT JOIN (SELECT supplier_id, count(*) n FROM products        GROUP BY 1) p ON p.supplier_id = s.id
      LEFT JOIN (SELECT supplier_id, count(*) n FROM purchase_orders GROUP BY 1) o ON o.supplier_id = s.id
     ORDER BY s.id`);

  for (const s of sup) {
    s.key = normKey(s.name); s.spaced = normSpaced(s.name); s.refs = s.parts + s.pos;
    // Which list a row shows up on. The Suppliers report and the Vendor
    // Directory read the same table, but a legacy row almost always came from
    // exactly one of the two exports and so carries only one side of the
    // business: INVENTRY rows have a catalogue and no purchase history, INVREC
    // rows the reverse.
    s.list = s.parts > 0 && s.pos > 0 ? 'both'
           : s.parts > 0 ? 'parts'
           : s.pos > 0 ? 'pos' : 'unused';
  }

  const skipped = sup.filter((s) => PLACEHOLDERS.has(s.key) || s.key.length <= 3);
  const live = sup.filter((s) => !skipped.includes(s));

  // ---- union-find over the match classes ----------------------------------
  const parent = new Map(live.map((s) => [s.id, s.id]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const why = [];                       // [{a, b, cls}] for the report
  const byId = new Map(live.map((s) => [s.id, s]));
  const crossed = [];                   // pairs refused for straddling lists
  const union = (a, b, cls) => {
    // Names are consolidated within one list at a time. A parts-side row is
    // never folded into a purchase-history row, even when they are plainly the
    // same trading name, because that is a different operation: it would stitch
    // the two lists together rather than tidy the spellings on each. Pass
    // --across-lists to do that instead.
    const sa = byId.get(a), sb = byId.get(b);
    if (!ACROSS && sa.list !== sb.list) { crossed.push([sa, sb, cls]); return; }
    const ra = find(a), rb = find(b);
    why.push({ a, b, cls });
    if (ra !== rb) parent.set(ra, rb);
  };

  // identical
  const byKey = new Map();
  for (const s of live) {
    if (!byKey.has(s.key)) byKey.set(s.key, []);
    byKey.get(s.key).push(s);
  }
  for (const group of byKey.values()) {
    for (let i = 1; i < group.length; i++) union(group[0].id, group[i].id, 'identical');
  }

  // truncation: a spaced normal form that is a strict prefix of another and is
  // long enough that the prefix cannot be a coincidence.
  const MIN_PREFIX = 18;
  const sorted = [...live].sort((a, b) => a.spaced.length - b.spaced.length);
  for (let i = 0; i < sorted.length; i++) {
    const short = sorted[i];
    if (short.spaced.length < MIN_PREFIX) continue;
    for (let j = i + 1; j < sorted.length; j++) {
      const long = sorted[j];
      if (long.spaced.length === short.spaced.length) continue;
      if (long.spaced.startsWith(short.spaced)) union(short.id, long.id, 'truncation');
    }
  }

  // fuzzy
  const fuzzyPairs = [];
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i], b = live[j];
      if (a.key === b.key) continue;
      const L = Math.max(a.key.length, b.key.length);
      if (Math.min(a.key.length, b.key.length) < 8) continue;
      const d = editDistance(a.key, b.key);
      if (d <= 2 && d / L <= 0.2) fuzzyPairs.push([a, b, d]);
    }
  }
  if (FUZZY) for (const [a, b] of fuzzyPairs) union(a.id, b.id, 'fuzzy');

  // ---- build the groups ----------------------------------------------------
  const groups = new Map();
  for (const s of live) {
    const r = find(s.id);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(s);
  }
  const merges = [...groups.values()].filter((g) => g.length > 1).map((g) => {
    const classes = [...new Set(why
      .filter((w) => g.some((s) => s.id === w.a) && g.some((s) => s.id === w.b))
      .map((w) => w.cls))];

    // Which spelling survives depends on why the rows matched.
    //
    // For identical / truncation the longest name is the right one: the others
    // are the same name with a suffix dropped or the field cut off, so longest
    // == most complete.
    //
    // For a pure fuzzy group that rule is actively wrong, because a typo can be
    // LONGER than the correct spelling. It wanted to keep "1BERTS AUTO PARTS"
    // -- a stray leading digit, zero parts, zero POs -- and fold the real
    // "BERTS AUTO PARTS" and its 19,978 references into it. The spelling that
    // is actually in use is the one the shop typed thousands of times, so these
    // rank on reference count first.
    const byName = (a, b) => b.name.trim().length - a.name.trim().length || b.refs - a.refs || a.id - b.id;
    const byRefs = (a, b) => b.refs - a.refs || b.name.trim().length - a.name.trim().length || a.id - b.id;
    const fuzzyOnly = classes.length === 1 && classes[0] === 'fuzzy';
    // Neither heuristic can settle a typo pair where the misspelling is both
    // longer and more used -- ANTILIES beat ANTILLES on references, COURTNERY
    // beat COURTNEY. Only a reader knows "Antilles" and "Courtney" are words
    // and the others are not, so those calls are recorded in PREFER and win
    // outright.
    const preferred = g.find((s) => PREFER.has(s.name.trim().toUpperCase()));
    const keep = preferred || [...g].sort(fuzzyOnly ? byRefs : byName)[0];
    const drop = g.filter((s) => s.id !== keep.id);
    return { keep, drop, classes };
  }).sort((a, b) => (b.keep.refs + b.drop.reduce((n, d) => n + d.refs, 0))
                  - (a.keep.refs + a.drop.reduce((n, d) => n + d.refs, 0)));

  // ---- report --------------------------------------------------------------
  console.log(`suppliers: ${fmt(sup.length)}  |  considered: ${fmt(live.length)}  |  placeholders left alone: ${fmt(skipped.length)}`);
  console.log(`classes applied: identical, truncation${FUZZY ? ', fuzzy' : ''}`
    + (FUZZY ? '' : `  (${fmt(fuzzyPairs.length)} fuzzy pairs found but not applied -- pass --include-fuzzy)`));
  const byList = live.reduce((m, s) => (m[s.list] = (m[s.list] || 0) + 1, m), {});
  console.log(`scope: ${ACROSS ? 'ACROSS lists -- parts and purchase-history rows may be combined'
    : 'each list on its own -- names tidied within a list, the two never stitched together'}`);
  console.log(`rows by list: parts-only ${fmt(byList.parts || 0)}, purchase-history-only ${fmt(byList.pos || 0)}`
    + `, on both ${fmt(byList.both || 0)}, unused ${fmt(byList.unused || 0)}`);
  console.log(`\ngroups to merge: ${fmt(merges.length)}`
    + `  |  rows removed: ${fmt(merges.reduce((n, m) => n + m.drop.length, 0))}`
    + `  |  suppliers after: ${fmt(sup.length - merges.reduce((n, m) => n + m.drop.length, 0))}\n`);

  for (const m of merges) {
    console.log(`  KEEP  ${m.keep.name}   [${fmt(m.keep.parts)} parts, ${fmt(m.keep.pos)} POs]   (${m.classes.join('+')})`);
    for (const d of m.drop) console.log(`    <-  ${d.name}   [${fmt(d.parts)} parts, ${fmt(d.pos)} POs]`);
  }

  if (crossed.length) {
    // Same trading name on both lists. Left apart on purpose; this is the set
    // --across-lists would additionally fold together.
    const seen = new Set();
    const uniq = crossed.filter(([a, b]) => {
      const k = [a.id, b.id].sort((x, y) => x - y).join(':');
      return seen.has(k) ? false : (seen.add(k), true);
    });
    console.log(`\nsame name on both lists -- left apart (${fmt(uniq.length)} pairs; --across-lists would join these):`);
    for (const [a, b, cls] of uniq.slice(0, 30)) {
      const side = (s) => `${s.list === 'parts' ? 'parts' : s.list === 'pos' ? 'purchases' : s.list}: ${fmt(s.parts)}p/${fmt(s.pos)}po`;
      console.log(`    ${a.name}  [${side(a)}]   <->   ${b.name}  [${side(b)}]   (${cls})`);
    }
    if (uniq.length > 30) console.log(`    ... and ${fmt(uniq.length - 30)} more`);
  }

  if (!FUZZY && fuzzyPairs.length) {
    console.log('\nfuzzy pairs NOT applied (likely typos -- review, then --include-fuzzy):');
    for (const [a, b, d] of fuzzyPairs.slice(0, 40)) {
      console.log(`    ${a.name}  <->  ${b.name}   (distance ${d}; ${fmt(a.refs)} / ${fmt(b.refs)} refs)`);
    }
    if (fuzzyPairs.length > 40) console.log(`    ... and ${fmt(fuzzyPairs.length - 40)} more`);
  }

  if (skipped.length) {
    console.log('\nleft alone (placeholder or too short to match on):');
    for (const s of skipped.sort((a, b) => b.refs - a.refs)) {
      console.log(`    ${s.name.padEnd(20)} [${fmt(s.parts)} parts, ${fmt(s.pos)} POs]`);
    }
  }

  if (!merges.length) { console.log('\nnothing to do.'); }
  else if (!APPLY) {
    console.log('\ndry run -- nothing written. Re-run with --apply to merge.');
  } else {
    await c.query('BEGIN');
    await c.query(`
      CREATE TABLE IF NOT EXISTS supplier_merges (
        id          SERIAL PRIMARY KEY,
        old_name    TEXT NOT NULL,
        old_id      INTEGER,
        kept_id     INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
        kept_name   TEXT NOT NULL,
        match_class TEXT,
        parts_moved INTEGER NOT NULL DEFAULT 0,
        pos_moved   INTEGER NOT NULL DEFAULT 0,
        merged_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await c.query(`CREATE INDEX IF NOT EXISTS idx_supplier_merges_old ON supplier_merges (lower(old_name))`);

    let parts = 0, pos = 0, removed = 0;
    for (const m of merges) {
      const ids = m.drop.map((d) => d.id);
      const p = await c.query('UPDATE products SET supplier_id = $1, updated_at = now() WHERE supplier_id = ANY($2::int[])', [m.keep.id, ids]);
      const o = await c.query('UPDATE purchase_orders SET supplier_id = $1 WHERE supplier_id = ANY($2::int[])', [m.keep.id, ids]);
      parts += p.rowCount; pos += o.rowCount;
      for (const d of m.drop) {
        await c.query(`INSERT INTO supplier_merges (old_name, old_id, kept_id, kept_name, match_class, parts_moved, pos_moved)
                       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [d.name, d.id, m.keep.id, m.keep.name, m.classes.join('+'), d.parts, d.pos]);
      }
      const del = await c.query('DELETE FROM suppliers WHERE id = ANY($1::int[])', [ids]);
      removed += del.rowCount;
    }
    await c.query('COMMIT');

    const { rows: [after] } = await c.query(`
      SELECT count(*)::int AS n,
             (SELECT count(*) FROM products        WHERE supplier_id IS NULL)::int AS parts_orphan,
             (SELECT count(*) FROM purchase_orders WHERE supplier_id IS NULL)::int AS pos_orphan
        FROM suppliers`);
    console.log(`\napplied: ${fmt(removed)} duplicate rows removed`
      + `  |  ${fmt(parts)} parts and ${fmt(pos)} purchase orders repointed`);
    console.log(`suppliers now: ${fmt(after.n)}  |  parts with no supplier: ${fmt(after.parts_orphan)}`
      + `  |  POs with no supplier: ${fmt(after.pos_orphan)}`);
    console.log("old spellings kept in supplier_merges -- SELECT * FROM supplier_merges ORDER BY merged_at DESC");
  }
} catch (e) {
  await c.query('ROLLBACK').catch(() => {});
  console.error('FAILED, rolled back:', e.message);
  process.exitCode = 1;
} finally {
  c.release();
  await db.end();
}
