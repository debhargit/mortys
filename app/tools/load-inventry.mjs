// Load INVENTRY.csv into products.
//
//   node app/tools/load-inventry.mjs [--append] [path/to/INVENTRY.csv]
//
// CSV columns: SKU, DESCRIPTION, VEHICLE, MODEL, LOCATION, QUANTITY, COST, PRICE, WHOLEPRICE
// Mapping:
//   SKU            -> img (unique key) + sku
//   DESCRIPTION    -> name
//   VEHICLE+MODEL  -> make_model  ("VEHICLE / MODEL", de-duped when MODEL == VEHICLE or blank)
//   LOCATION       -> bin_location
//   QUANTITY       -> stock_count
//   COST / PRICE   -> cost_usd / price_usd   (WHOLEPRICE is ignored)
//   category       -> derived from DESCRIPTION keywords
//   condition      -> 'NEW' (no data in the file)
// Replaces the products table unless --append is passed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const APPEND = process.argv.includes('--append');
const CSV_PATH = process.argv.find((a, i) => i >= 2 && !a.startsWith('--')) || path.join(ROOT, 'INVENTRY.csv');

// ---- tiny CSV parser: quotes, "" escaping, CRLF ----------------------------
function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

// ---- category from description -------------------------------------------
// Ordered; first hit wins. Falls back to 'accessories'.
const RULES = [
  [/\b(SEAT COVER|CAR COVER|STEERING WHEEL COVER|WHEEL COVER|MUD ?FLAP|MUD ?GUARD|FLOOR MAT|CAR MAT|AIR ?FRESHENER|FRAGRANCE|PHONE HOLDER|DASH ?CAM|\bTINT\b|\bANTENNA\b|CAR ALARM|REVERSE CAMERA|TOW ?HOOK|LICENSE FRAME|NUMBER PLATE|KEY ?CHAIN|AIR PUMP|JACK|WHEEL SPANNER|TYRE GAUGE|FIRE EXTINGUISHER|FIRST AID)\b/i, 'accessories'],
  [/\bSEAT ?BELT\b/i, 'body'],
  [/\bTIMING (BELT|CHAIN|KIT)\b/i, 'engine'],
  [/\b(FAN|DRIVE|SERPENTINE|POLY|V[- ]?)BELT\b|\bA\/?C BELT\b/i, 'engine'],
  [/\b(DISC PAD|BRAKE PAD|PAD SET|DISC ROTOR|BRAKE ROTOR|\bROTOR|BRAKE SHOE|BRAKE DISC|CALIPER|BRAKE MASTER|MASTER CYL|WHEEL CYL|BRAKE HOSE|BRAKE CABLE|HAND ?BRAKE|PARK(ING)? BRAKE|BRAKE BOOSTER|BOOSTER KIT|BRAKE WASHER|BRAKE DRUM|BRAKE LINING|ABS SENSOR|BRAKE PUMP)|\bBRAKE\b/i, 'brakes'],
  [/\b(WHEEL BEARING|HUB BEARING|WHEEL NUT|WHEEL STUD|WHEEL BOLT|LUG NUT|WHEEL LOCK|HUB ?CAP|\bRIM\b|\bWHEEL(?! COVER)|\bTYRE|\bTIRE|TUBELESS|INNER TUBE|KUMHO|BRIDGESTONE|MICHELIN|DUNLOP|GOODYEAR|FIRESTONE|YOKOHAMA|HANKOOK|\bTOYO\b|COMMERCIAL KC)\b/i, 'wheels'],
  [/\b(SHOCK|STRUT|STRU MOUNT|BALL JOINT|TIE ?ROD|RACK ?END|STEERING RACK|RACK (&|AND) PINION|DRAG LINK|CENTER LINK|CENTRE LINK|RELAY ROD|CONTROL ARM|LOWER ARM|UPPER ARM|A[- ]?ARM|WISHBONE|STABILI[SZ]ER|SWAY BAR|DROP LINK|LINK ROD|LINK STAY|\bBUSH\b|BUSHING|COIL SPRING|LEAF SPRING|\bSPRING|KING ?PIN|IDLER ARM|PITMAN ARM|RADIUS ROD|TRAILING ARM|SHACKLE|TORSION|CV ?BOOT|STEERING BOOT|SPRING SEAT|SHOCK MOUNT|SPINDLE)\b/i, 'suspension'],
  [/\b(OIL FILTER|AIR FILTER|FUEL FILTER|CABIN FILTER|TRANS(MISSION)? FILTER|\bFILTER|ENGINE OIL|MOTOR OIL|GEAR OIL|\bATF\b|\bCOOLANT|ANTI[- ]?FREEZE|BRAKE FLUID|POWER STEERING FLUID|P\/?S FLUID|\bGREASE|LUBRICANT|ADDITIVE|\bFLUSH|CLEANER|DEGREASER|SILICONE|EPOXY|URETHANE|SEALANT|\bRTV\b|THREAD ?LOCK|LOCTITE|WD[- ]?40|STOP LEAK|DIESEL TREATMENT|OCTANE|DOT ?[34]|GASKET MAKER|\bGLUE\b|GASKET CEMENT|PENETRAT|CARB CLEAN|CONTACT CLEAN)\b/i, 'fluids'],
  [/\b(BULB|SEALED BEAM|HEAD ?LAMP|HEAD ?LIGHT|TAIL ?LAMP|TAIL ?LIGHT|FOG ?LAMP|FOG ?LIGHT|SIDE ?MARKER|SIGNAL LAMP|CORNER LAMP|INDICATOR|\bLAMP|\bLIGHT|\bLED\b|\bHID\b|IGNITION (WIRE|COIL|CABLE|LEAD|MODULE)|SPARK PLUG|GLOW PLUG|PLUG (WIRE|LEAD|CABLE)|IGNITION WIRE|IGNITION COIL|COIL PACK|DISTRIBUTOR|ALTERNATOR|STARTER|BRUSH HOLDER|CARBON BRUSH|ALTERNATOR BRUSH|SOLENOID|\bRELAY|\bFUSE|\bSENSOR|\bSWITCH|\bHORN\b|BATTERY|TERMINAL|WIRE ?HARNESS|\bHARNESS|REGULATOR|RECTIFIER|FLASHER|WIPER MOTOR|WINDOW MOTOR|WASHER MOTOR|BLOWER MOTOR|FAN MOTOR|\bECU\b|\bECM\b|\bTCU\b|SPEEDOMETER|GAUGE CLUSTER)\b/i, 'electrical'],
  [/\b(MIRROR|\bDOOR|FENDER|BUMPER|GRIL+E|BONNET|\bHOOD\b|TRUNK|TAIL ?GATE|QUARTER PANEL|\bPANEL|MOUL?DING|MOLDING|DOOR HANDLE|\bHANDLE|WIND(SCREEN|SHIELD)|\bGLASS\b|\bHINGE|DOOR LOCK|\bLOCK\b|WEATHER ?STRIP|\bEMBLEM|\bBADGE|SPOILER|AIR ?DAM|\bSKIRT|SUN ?VISOR|RAIN ?VISOR|\bVISOR|SUN ?ROOF|WIPER (ARM|LINKAGE|BLADE)|SHOULDER PAD|HEADLINER|\bSEAT\b|\bDASH|\bCONSOLE|\bCARPET|BODY CLIP|FUEL (DOOR|LID)|LICENSE LAMP)\b/i, 'body'],
  [/\b(ENGINE|\bMOTOR\b|PISTON|\bRING\b|MAIN BEARING|CON[- ]?ROD|ROD BEARING|\bBEARING|\bCRANK|\bCAM\b|CAMSHAFT|\bVALVE|HEAD GASKET|\bGASKET|CYL(INDER)?|\bHEAD\b|MANIFOLD|TURBO|CARBURET+OR|CARB KIT|INJECTOR|\bPUMP\b|FUEL PUMP|LIFT PUMP|WATER PUMP|OIL PUMP|POWER ?STEERING PUMP|P\/?S PUMP|OIL SEAL|VALVE SEAL|\bSEAL\b|THERMOSTAT|RADIATOR|\bHOSE|\bMOUNT|CLUTCH|FLYWHEEL|PRESSURE PLATE|RELEASE BEARING|THROW ?OUT|CV ?JOINT|CV ?AXLE|DRIVE ?SHAFT|PROP(ELLER)? SHAFT|\bAXLE|TRANS(MISSION)?|GEAR ?BOX|\bCVT\b|DIFFERENTIAL|TIMING|TENSIONER|\bIDLER|\bPULLEY|\bCHAIN\b|OVERHAUL KIT|LINER KIT|PUSH ?ROD|ROCKER|LIFTER|TAPPET|EXHAUST|MUFFLER|CATALYTIC|FLEX PIPE|DOWN ?PIPE|\bEGR\b|\bPCV\b|\bBELT\b)\b/i, 'engine'],
];
function categorise(desc) {
  const s = ' ' + String(desc || '').toUpperCase() + ' ';
  // Also test a naively de-pluralised copy so "SHOCKS", "PADS", "MOUNTS",
  // "BEARINGS" etc. hit the same singular keyword.
  const sing = s.replace(/(\w{3})S\b/g, '$1');
  for (const [re, cat] of RULES) if (re.test(s) || re.test(sing)) return cat;
  return 'accessories';
}

// ---- helpers ------------------------------------------------------------
const clean = (v) => String(v == null ? '' : v).trim();
function money(v) {
  const n = parseFloat(String(v).replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : null;
}
function intQty(v) {
  const n = Math.round(parseFloat(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}
function makeModel(vehicle, model) {
  const v = clean(vehicle), m = clean(model);
  if (!v && !m) return '';
  if (!v) return m;
  if (!m || m.toUpperCase() === v.toUpperCase()) return v;
  return v + ' / ' + m;
}

// ---- build rows ------------------------------------------------------------
const raw = parseCsv(fs.readFileSync(CSV_PATH, 'utf8').replace(/^﻿/, ''));
const header = raw.shift().map((h) => clean(h).toUpperCase());
const col = (name) => header.indexOf(name);
const iSku = col('SKU'), iDesc = col('DESCRIPTION'), iVeh = col('VEHICLE'), iMod = col('MODEL'),
      iLoc = col('LOCATION'), iQty = col('QUANTITY'), iCost = col('COST'), iPrice = col('PRICE');
if (iSku < 0 || iDesc < 0) { console.error('Unexpected header:', header.slice(0, 9)); process.exit(1); }

const byImg = new Map();       // last row wins on duplicate SKU
let blank = 0, dupes = 0;
for (const r of raw) {
  const sku = clean(r[iSku]);
  if (!sku) { blank++; continue; }
  if (byImg.has(sku)) dupes++;
  const price = money(r[iPrice]);
  byImg.set(sku, {
    img: sku,
    sku,
    name: clean(r[iDesc]) || sku,
    make_model: makeModel(r[iVeh], r[iMod]),
    category: categorise(r[iDesc]),
    condition: 'NEW',
    price_usd: price != null && price > 0 ? price : null,
    cost_usd: money(r[iCost]),
    stock_count: intQty(r[iQty]),
    bin_location: clean(r[iLoc]) || null,
  });
}
const rows = [...byImg.values()];

const dist = {};
for (const x of rows) dist[x.category] = (dist[x.category] || 0) + 1;
console.log(`CSV rows: ${raw.length}  |  loadable: ${rows.length}  |  blank SKU skipped: ${blank}  |  duplicate SKU collapsed: ${dupes}`);
console.log('category distribution:', dist);

// ---- write to DB --------------------------------------------------------
const cfg = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'db-config.json'), 'utf8')).local;
const pool = new pg.Pool({ host: cfg.host, port: cfg.port, database: cfg.database, user: cfg.user, password: cfg.password, max: 4 });
const client = await pool.connect();
try {
  await client.query('BEGIN');
  if (!APPEND) {
    await client.query('TRUNCATE products RESTART IDENTITY CASCADE');
    console.log('products truncated (pass --append to keep existing rows)');
  }
  const COLS = ['img', 'sku', 'name', 'make_model', 'category', 'condition', 'price_usd', 'cost_usd', 'stock_count', 'bin_location'];
  const CHUNK = 500;
  let done = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const vals = [];
    const tuples = slice.map((row, n) => {
      const b = n * COLS.length;
      COLS.forEach((c) => vals.push(row[c]));
      return '(' + COLS.map((_, k) => `$${b + k + 1}`).join(',') + ')';
    });
    await client.query(
      `INSERT INTO products (${COLS.join(',')}) VALUES ${tuples.join(',')}
       ON CONFLICT (img) DO UPDATE SET
         sku=EXCLUDED.sku, name=EXCLUDED.name, make_model=EXCLUDED.make_model,
         category=EXCLUDED.category, condition=EXCLUDED.condition,
         price_usd=EXCLUDED.price_usd, cost_usd=EXCLUDED.cost_usd,
         stock_count=EXCLUDED.stock_count, bin_location=EXCLUDED.bin_location,
         updated_at=now()`,
      vals
    );
    done += slice.length;
  }
  await client.query('COMMIT');
  const { rows: [{ count }] } = await client.query('SELECT count(*)::int AS count FROM products');
  console.log(`inserted/updated ${done} rows  |  products now: ${count}`);
} catch (e) {
  await client.query('ROLLBACK');
  console.error('FAILED, rolled back:', e.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
