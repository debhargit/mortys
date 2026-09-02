// One-off (re-runnable) inventory categoriser.
//
// The catalogue was imported with every row's category left as "Other" (the
// import default -- see inventory-import.js). The storefront's category chips
// (shop.html) and the /api/products?category= filter are dead weight until the
// products.category column actually reflects what each part is.
//
// This maps each product onto one of the eight storefront categories by
// keyword-matching its name (with a few make_model hints). It is deliberately
// an ordered rule list: the first pattern that matches wins, and the specific
// guards ("SEAT BELT" -> accessories, "OIL SEAL" -> engine, "TIE ROD" ->
// suspension) are listed before the broad catch words they would otherwise be
// swallowed by ("BELT", "OIL", "TIE").
//
//   node tools/categorize-inventory.mjs           # dry run: report only
//   node tools/categorize-inventory.mjs --apply   # write products.category
//   node tools/categorize-inventory.mjs --apply --reset-other
//        # also re-run rows that are already in a real category but re-derive
//        # to the same/another slug (safe; default only touches 'Other'/'')
//
// Storefront slugs (shop.html chips / VALID_CATS):
//   engine  body  suspension  electrical  brakes  wheels  fluids  accessories

import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const APPLY = process.argv.includes('--apply');
const RECLASSIFY_ALL = process.argv.includes('--reset-other') || process.argv.includes('--all');

// ---------------------------------------------------------------------------
// Connection: same resolution order as server.js -- db-config.json's `local`
// block first, then DATABASE_URL, then the hardcoded local default.
function poolConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'db-config.json'), 'utf8')).local;
    if (c && c.host) return { host: c.host, port: parseInt(c.port, 10) || 5432, database: c.database, user: c.user, password: c.password };
  } catch (_) {}
  if (process.env.DATABASE_URL) return { connectionString: process.env.DATABASE_URL };
  return { connectionString: 'postgresql://postgres:postgres@localhost:5432/visionautosolutions' };
}

// ---------------------------------------------------------------------------
// Ordered rules. `t` is the uppercased name + ' ' + uppercased make_model.
const RULES = [
  // --- guards: leading word points the wrong way ------------------------
  [/\bSEAT ?BELT\b/, 'accessories'],
  [/\b(TIMING|FAN|DRIVE|RIBBED?|SERPENTINE|ALTERNATOR|A\/?C|AC|P\/?S(TEERING)?|POWER STEERING|V)[- ]?BELT\b|\bBELT ?(TENSIONER|PULLEY|KIT|IDLER)\b/, 'engine'],
  [/\b(TIE|RACK|DRAG|TRACK) ?(ROD|END)\b|\bINNER ?TIE\b|\bOUTER ?TIE\b/, 'suspension'],
  [/\b(CABLE|ZIP|WIRE) ?TIE\b|\bTIE ?(STRAP|WRAP)\b/, 'accessories'],
  [/\bCLUTCH\b|\bRELEASE BEARING\b|\bTHROW ?OUT\b|\bPRESSURE PLATE\b|\bPILOT BEARING\b|\bSPIGOT BEARING\b|\bSLAVE ?(CYL(INDER)?\.?|KIT)\b|\bCARBUR/, 'engine'],
  [/\b(M|B\/?M|BRAKE)[ .\/]*C(YL|LY)\.? ?(KIT|CYLINDER)?\b|\bMASTER ?CYL(INDER)?\b/, 'brakes'],
  [/\bWHEEL ?(BEARING|HUB)\b|\bHUB ?(BEARING|ASSEMBLY|UNIT)\b/, 'suspension'],
  [/\bWHEEL ?CYLINDER\b/, 'brakes'],
  [/\bSTEERING ?WHEEL\b/, 'accessories'],
  [/\bWHEEL ?(NUT|BOLT|STUD|LOCK|SPACER|SPANNER|BRACE|ARCH|TRIM|WEIGHT)\b|\bLUG ?NUT\b|\bHUB ?CAP\b|\bWHEEL ?CAP\b/, 'wheels'],
  [/\bHEAD ?(LAMP|LIGHT)\b|\bHEADLAMP\b|\bHEADLIGHT\b/, 'electrical'],
  [/\bHEAD ?(REST|LINER|LINING|BOARD)\b/, 'accessories'],
  [/\b(CYLINDER|ENGINE) ?HEAD\b|\bHEAD ?(GASKET|BOLT|SET|STUD|SKIM)\b|\bDECARB\b/, 'engine'],
  [/\bOIL ?(SEAL|PUMP|PAN|SUMP|COOLER|STRAINER|PICK ?UP|GALLERY|JET|SPRAYER|LEVEL|RING)\b/, 'engine'],
  [/\b(OIL|AIR|FUEL|CABIN|A\/?C|AC|DIESEL|POLLEN|TRANSMISSION|GEAR ?BOX|HYDRAULIC) ?FILTER\b|\bFILTER ?(ELEMENT|KIT|HOUSING)?\b/, 'fluids'],
  [/\bAIR ?(FRESHE?NER|FRESHNER|FRESHENER)\b/, 'accessories'],
  [/\bAIR ?(FLOW|INTAKE|CLEANER|BOX|DUCT|HOSE|MASS|PIPE|FUNNEL)\b|\bMASS AIR\b|\bMAF\b|\bIDLE AIR\b|\bAIR ?CON(D)?\b|\bAIR ?BAG\b/, 'engine'],
  [/\bVALVE ?(CAPS?|STEMS?)\b|\bTYRE ?VALVE\b|\bTIRE ?VALVE\b|\bDUST ?CAPS?\b/, 'wheels'],
  [/\b(PCV|EGR|IDLE|INTAKE|EXHAUST|INLET|CHECK|RELIEF|SOLENOID) ?VALVE\b|\bVALVE ?(SEAL|GUIDE|SPRING|STEM SEAL|LIFTER|SEAT|COVER|TAPPET|SHIM|COLLET|KEEPER)\b/, 'engine'],
  [/\bPARK(ING)? ?(LIGHT|LAMP)\b|\bSIDE ?(LIGHT|LAMP)\b|\bNUMBER ?PLATE ?(LIGHT|LAMP)\b|\bLICEN[CS]E ?(LIGHT|LAMP)\b/, 'electrical'],
  [/\bBOOT ?(LID|LOCK|RELEASE|STRUT|SHOCK|HINGE)\b|\bTRUNK\b|\bTAIL ?GATE\b/, 'body'],
  [/\bWASHER ?(PUMP|MOTOR|BOTTLE|TANK|NOZZLE|JET|HOSE)\b/, 'electrical'],
  [/\bCENT(RE|ER) ?BEARING\b|\bCARRIER ?BEARING\b/, 'engine'],
  [/\bFLUID\b|\bGREASE\b/, 'fluids'],
  [/\bFENDER ?LINER\b|\bSPLASH ?(GUARD|SHIELD|LINER|COVER)\b|\bINNER ?FENDER\b|\b(WHEEL ?)?ARCH ?LINER\b|\bUNDER ?TRAY\b/, 'body'],
  [/\bDE ?A?C(A|O)R(B|D)\b|\bDECARBON|\b(CYL(INDER)?|BORE|WET|DRY) ?LINER\b|\bLINER ?(KIT|SET)\b|\bSLEEVE\b|\bCOMBUSTION\b|\bCHAMBER\b|\bGAS[HK]\b|\bGASKIT\b/, 'engine'],
  [/\bSEALED ?BEAM\b|\bJUMPER ?(CABLE|LEAD)\b|\bBOOSTER ?CABLE\b|\bPOINTS\b|\bCONDENSOR\b|\bCONNECTOR\b|\bPLUG ?CAP\b|\bBALLAST\b|\bCONTACT ?SET\b/, 'electrical'],
  [/\bCRANK ?SHAFT\b|\bBALANCE\w* ?SHAFT\b|\bMAIN ?BEARINGS?\b|\bPLUG ?SEALS?\b|\bKEY ?<?CRANK/, 'engine'],
  [/\b(RUBBING|GRINDING|LAPPING|VALVE) ?COMPOUND\b|\bAD ?BLUE\b|\b2 ?CYCLE\b|\bDEF\b/, 'fluids'],
  [/\bFIRE ?E[SX]TINGUISH\w*\b|\bEXTINGUISHER\b|\bGOGGLES?\b|\bTOW ?(HOOK|ROPE|BAR|EYE|STRAP|CHAIN)\b|\bW[IU]?[IU]PER ?BLADE\b/, 'accessories'],
  [/\bRIMS?\b/, 'wheels'],
  [/\bC[. ]?V[. ]?\s?JOINT\b|\bGEAR ?LINKAGE\b|\bLINKAGE\b|\bBOSS ?KIT\b|\bM\/C KIT\b|\bCARB(URETTOR)? ?KIT\b/, 'engine'],
  [/\bTHREAD ?LOCK\w*\b|\bURETHANE\b|\bPB ?BLASTER\b|\bPURPLE ?BLASTER\b|\bTROPICAL\b/, 'fluids'],
  [/\bCIRCUIT ?TESTER\b|\bTEST(ER|LIGHT| LIGHT)\b|\bBOOST\w* ?CABLE\b/, 'electrical'],
  [/\bWIND(OW)? ?WINDER\b|\bWINDER\b|\bL[. \/]?PLATE\b|\b(LIC\.?|LICEN[CS]E)[. ]?(PLATE|FRAME)\b|\bFRAME ?LIC\b/, 'body'],
  [/\bMOTHERS\b|\bDETAIL(ER|ING)?\b|\bMICROFIB\w*\b|\bUNDER ?COAT\w*\b|\bSMOKE ?(ELIMINAT|REDUC)\w*\b|\bLEAT(HE|E)R ?CARE\b|\bSCRATCH ?REMOV\w*\b|\bPOWER ?POLISH\b|\bSCREW ?LOOSE\b|\bDEEP ?CLEAN\b/, 'fluids'],
  [/\bWASH ?RAG\b|\bRAG\b|\bCONTAINER\b|\bTOWEL\b|\bSPONGE\b|\bBRUSH\b|\bGLOVES?\b|\bBUCKET\b/, 'accessories'],
  [/\bCORE ?PLUG\b|\bWELCH ?PLUG\b|\bFREEZE ?PLUG\b|\bUNIVERSAL ?JOINT\b|\bU[- ]?JOINT\b|\bUNI ?JOINT\b|\bCROSS ?SHAFT\b/, 'suspension'],
  [/\bSPLIT ?PIN\b|\bSPLIT PIN\b|\bR[- ]?PIN\b|\bCOTTER ?PIN\b|\bHOSE ?CLAMP\b|\bHOSE ?CLIP\b|\bCABLE ?TIE\b/, 'accessories'],

  // --- brakes ----------------------------------------------------------
  [/\bBRAKE\b|\bROTOR\b|\bCALIP+ER\b|\bDISC ?PAD\b|\bBRAKE ?PAD\b|\bHAND ?BRAKE\b|\bE[- ]?BRAKE\b|\bABS\b|\bBRAKE ?(SHOE|DRUM|LINE|HOSE|BOOSTER|MASTER)\b/, 'brakes'],
  [/\bDI(SC|CS)S?\b/, 'brakes'],
  [/\bPAD ?SET\b|\bBRAKE PADS\b|\bDISC PADS\b/, 'brakes'],

  // --- engine / drivetrain -------------------------------------------
  [/\bENGINE\b|\bMOTOR ?MOUNT\b|\bCON ?ROD\b|\bCONROD\b|\bPISTON\b|\bRINGS?\b|\bCRANK\b|\bCAM ?SHAFT\b|\bCAMSHAFT\b|\bGASKET\b|\bOVERHAUL\b|\bTIMING\b|\bTENSION(ER)?\b|\bPUL+EY\b|\bCHAIN\b|\bTIMING BELT\b|\bBELT\b|\bCV ?(JOINT|BOOT|AXLE|SHAFT)\b|\bDRIVE ?SHAFT\b|\bPROP(ELLER)? ?SHAFT\b|\bHALF ?SHAFT\b|\bAXLE\b|\bGEAR ?BOX\b|\bTRANSMISSION\b|\bMISSION\b|\bDIF+ERENTIAL\b|\bDIFF\b|\bFLY ?WHEEL\b|\bMOUNT\b|\bTHERMOSTAT\b|\bWATER ?PUMP\b|\bWATER\b|\bFUEL ?(PUMP|INJECT|RAIL|PRESSURE|LINE|TANK|SENDER)\b|\bFUEL\b|\bINJECTOR\b|\bCARBURET|\bCARB\b|\bMANIFOLD\b|\bTURBO\b|\bSUPERCHARGE\b|\bRADIATOR\b|\bINTER ?COOLER\b|\bMAIN ?BEARING\b|\bBIG ?END\b|\bROD ?BEARING\b|\bLIFTER\b|\bROCKER\b|\bTAPPET\b|\bDIP ?STICK\b|\bBREATHER\b|\bSUMP\b|\bHARMONIC\b|\bIDLER\b|\bMUFFLER\b|\bEXHAUST\b|\bCATALYTIC\b|\bRESONATOR\b|\bSILENCER\b|\bDOWN ?PIPE\b|\bHOSE\b|\bFAN\b|\bSEAL\b|\bO[- ]?RING\b|\bCAP\b|\bBOOT\b|\bRUBBER\b|\bGLOW ?PLUG\b|\bSPARK ?PLUG\b|\bVALVE\b|\bINTAKE\b|\bINLET\b|\bFREE ?FLOW\b|\bGOOSE ?NECK\b|\bFLEX ?PLATE\b|\bPLUG ?SEAL\b|\bSHIM\b/, 'engine'],

  // --- electrical / ignition / lighting -----------------------------
  [/\bBULB\b|\bLAMP\b|\bLIGHT\b|\bFOG\b|\bTAIL ?(LIGHT|LAMP)\b|\bINDICATOR\b|\bTURN ?SIGNAL\b|\bSIGNAL\b|\bHALOGEN\b|\bXENON\b|\bH\.?I\.?D\b|\bLED\b|\bFUSE\b|\bRELAY\b|\bSWITCH\b|\bSENSOR\b|\bIGNITION\b|\bCOIL\b|\bPLUG ?LEAD\b|\bLEADS?\b|\bDISTRIBUTOR\b|\bALTERNATOR\b|\bSTARTER\b|\bBATTERY\b|\bTERMINAL\b|\bHORNS?\b|\bWIR(E|ING)\b|\bLOOM\b|\bANTENNA\b|\bAERIAL\b|\bWIPER\b|\bMOTOR\b|\bREGULATOR\b|\bSOLENOID\b|\bECU\b|\bECM\b|\bMODULE\b|\bFLASHER\b|\bSPEEDO\b|\bODOMETER\b|\bGAUGE\b|\bCLUSTER\b|\bCOMPRESSOR\b|\bCONDENSER\b|\bEVAPORATOR\b|\bBLOWER\b|\bA\/?C\b/, 'electrical'],

  // --- suspension / steering ---------------------------------------
  [/\bSHOCKS?\b|\bSTRUTS?\b|\bABSORBER\b|\bCONTROL ?ARM\b|\b(LOWER|UPPER|TRAILING|RADIUS|TENSION) ?ARM\b|\bBALL ?JOINT\b|\bRACK\b|\bSTEERING\b|\bBUSH(ING)?\b|\bSTABIL(IZER|ISER)\b|\bSWAY ?BAR\b|\bANTI[- ]?ROLL\b|\bLINK\b|\bSUB ?FRAME\b|\bCROSS ?MEMBER\b|\bCOIL ?SPRING\b|\bLEAF ?SPRING\b|\bSPRING\b|\bKNUCKLE\b|\bSPINDLE\b|\bREBOUND\b|\bBUMP ?STOP\b|\bIDLER ?ARM\b|\bPITMAN\b|\bDRAG ?LINK\b|\bHUB\b|\bBEARING\b|\bTORSION\b|\bSHACKLE\b|\bU[- ]?BOLT\b|\bCAMBER\b/, 'suspension'],

  // --- wheels / tyres --------------------------------------------
  [/\bTYRE\b|\bTIRE\b|\bWHEEL\b|\bRIM\b|\bALLOY\b|\bLUG\b|\bTPMS\b|\bMAG\b/, 'wheels'],

  // --- body / exterior -----------------------------------------
  [/\bBUMPER\b|\bFENDER\b|\bHOOD\b|\bBONNET\b|\bDOOR\b|\bHANDLE\b|\bMIRROR\b|\bGRIL+E?\b|\bPANEL\b|\bMUD ?(FLAP|GUARD)\b|\bGUARD\b|\bFLARE\b|\bMOU?LDING\b|\bWEATHER ?STRIP\b|\bTRIM\b|\bEMBLEM\b|\bBADGE\b|\bVISOR\b|\bWIND ?(SHIELD|SCREEN)\b|\bGLASS\b|\bROOF\b|\bSPOILER\b|\bLATCH\b|\bHINGE\b|\bPILLAR\b|\bQUARTER\b|\bLICEN[CS]E\b|\bNUMBER ?PLATE\b|\bAPRON\b|\bVALANCE\b|\bSILL\b|\bGARNISH\b|\bCOWL\b|\bDEFLECTOR\b/, 'body'],

  // --- fluids / chemicals ------------------------------------
  [/\bOIL\b|\bCOOLANT\b|\bANTI ?FREEZE\b|\bFLUID\b|\bGREASE\b|\bLUBRICAN\b|\bADDITIVE\b|\bCLEANER\b|\bDE ?GREAS|\bSILICONE\b|\bSEALANT\b|\bSEAM ?SEALER\b|\bSEALER\b|\bRTV\b|\bGASKET ?(MAKER|CEMENT)\b|\bWD ?40\b|\bATF\b|\bDOT ?[345]\b|\bFLUSH\b|\bCONDITIONER\b|\bPOLISH\b|\bWAX\b|\bSHAMPOO\b|\bSPRAY\b|\bPRIMER\b|\bPAINT\b|\bBRAKLEEN\b|\bCARB ?CLEAN\b|\bTREATMENT\b|\bOCTANE\b|\bBOOST(ER)?\b|\bPROTECT(OR|ANT)\b|\bGLUE\b|\bADHESIVE\b|\bEPOXY\b|\bSTOP ?(SMOKE|LEAK|SLIP|SQUEAK)\b|\bBLUE ?DEVIL\b|\bARMOR ?ALL\b|\bAMSOIL\b|\bDIELECTRIC\b|\bANTI ?RUST\b|\bRUST ?(PROOF|CONVERT|REMOV)\b|\bPENETRAT\b|\bLACQUER\b|\bTHINNER\b|\bPUTTY\b|\bBODY ?FILLER\b|\bBONDO\b/, 'fluids'],

  // --- accessories / interior / hardware / tools ----------
  [/\bSEAT\b|\bMATS?\b|\bCOVER\b|\bFRESHE?N\w*\b|\bAIR ?FRESHER\b|\bPERFUME\b|\bVINYL\b|\bTAPE\b|\bCLIPS?\b|\bGROM+ET\b|\bTIE\b|\bWASHER\b|\bBOLT\b|\bNUT\b|\bSCREW\b|\bSPANNER\b|\bSOCKET\b|\bTOOL\b|\bJACK\b|\bWRENCH\b|\bPLIERS?\b|\bSTICKER\b|\bDECAL\b|\bLOGO\b|\bKEY ?(RING|CHAIN|TAG|FOB)\b|\bHOLDER\b|\bORGANI[ZS]ER\b|\bCUSHION\b|\bARM ?REST\b|\bGEAR ?KNOB\b|\bKNOB\b|\bPEDAL\b|\bFLOOR\b|\bCARPET\b|\bSUN ?SHADE\b|\bCURTAIN\b|\bNET\b|\bMUG\b|\bCHARGER\b|\bFUNNEL\b|\bPUMP\b/, 'accessories'],
];

function classify(name, makeModel) {
  const t = (String(name || '') + ' ' + String(makeModel || '')).toUpperCase();
  for (const [re, cat] of RULES) if (re.test(t)) return cat;
  return null; // leave as-is
}

// ---------------------------------------------------------------------------
const { Pool } = pg;
const pool = new Pool(poolConfig());

const before = (await pool.query(
  "SELECT COALESCE(NULLIF(category,''),'(empty)') c, count(*) n FROM products GROUP BY c ORDER BY n DESC"
)).rows;

const targetWhere = RECLASSIFY_ALL ? 'TRUE' : "(category IS NULL OR category = '' OR category = 'Other')";
const rows = (await pool.query(
  `SELECT img, name, make_model, category FROM products WHERE ${targetWhere}`
)).rows;

const plan = new Map();        // img -> new category
const tally = {};              // category -> count
const unmatched = [];
for (const r of rows) {
  const cat = classify(r.name, r.make_model);
  if (!cat) { unmatched.push(r); continue; }
  if (cat === r.category) continue;
  plan.set(r.img, cat);
  tally[cat] = (tally[cat] || 0) + 1;
}

console.log(`\nRows considered:      ${rows.length}${RECLASSIFY_ALL ? ' (all)' : " ('Other'/empty only)"}`);
console.log(`Would change:         ${plan.size}`);
console.log(`No rule matched:      ${unmatched.length}  (left unchanged)\n`);

console.log('New category counts (among changed rows):');
for (const [c, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`  ${c.padEnd(12)} ${n}`);

if (unmatched.length) {
  console.log('\nSample of unmatched names:');
  for (const r of unmatched.slice(0, 25)) console.log('  ', (r.name || '').slice(0, 50).padEnd(52), '| ' + (r.make_model || '').slice(0, 22));
}

if (!APPLY) {
  console.log('\nDry run — nothing written. Re-run with --apply to update products.category.\n');
  await pool.end();
  process.exit(0);
}

// Apply in one statement per category via a VALUES join -- ~8 round trips, not 30k.
const byCat = {};
for (const [img, cat] of plan) (byCat[cat] ||= []).push(img);

let written = 0;
const client = await pool.connect();
try {
  await client.query('BEGIN');
  for (const [cat, imgs] of Object.entries(byCat)) {
    for (let i = 0; i < imgs.length; i += 1000) {
      const chunk = imgs.slice(i, i + 1000);
      const ph = chunk.map((_, k) => `$${k + 2}`).join(',');
      const res = await client.query(
        `UPDATE products SET category = $1 WHERE img IN (${ph})`, [cat, ...chunk]
      );
      written += res.rowCount;
    }
  }
  await client.query('COMMIT');
} catch (e) {
  await client.query('ROLLBACK');
  throw e;
} finally {
  client.release();
}

const after = (await pool.query(
  "SELECT COALESCE(NULLIF(category,''),'(empty)') c, count(*) n FROM products GROUP BY c ORDER BY n DESC"
)).rows;

console.log(`\nApplied: ${written} rows updated.\n`);
console.log('category        before -> after');
const keys = [...new Set([...before, ...after].map(r => r.c))];
for (const k of keys) {
  const b = before.find(r => r.c === k)?.n || 0;
  const a = after.find(r => r.c === k)?.n || 0;
  console.log(`  ${k.padEnd(12)} ${String(b).padStart(7)} -> ${String(a).padStart(7)}`);
}
console.log();

await pool.end();
