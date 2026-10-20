// Builds app/assets/vehicles.js: the makes and models the catalogue really has
// parts for (from products.make_model "MAKE / MODELS YEARS"), each with a part
// count, so the home-page finder never offers a car with nothing behind it.
const { Pool } = require('../node_modules/pg');
const fs = require('fs');
const db = new Pool(require('../db-config.json').local);
const CUR = [
  ['Toyota', 'TOYOTA|TOYOYA|TOYO', [
    ['Corolla', 'COROLLA|CORL|ALTIS|AE10[01]|AE11[01]'], ['Corolla Axio', 'AXIO'], ['Corolla Fielder', 'FIELDER'],
    ['Hiace', 'HIACE'], ['Camry', 'CAMRY'], ['Hilux', 'HILUX(?! SURF)|VIGO'], ['Hilux Surf', 'SURF'], ['Townace', 'TOWNACE|TOWN ACE'],
    ['Liteace', 'LITEACE|LITE ACE'], ['RAV4', 'RAV4|RAV 4|RAV-4'], ['Probox / Succeed', 'PROBOX|SUCCEED'], ['Yaris', 'YARIS'], ['Vitz', 'VITZ'],
    ['Wish', 'WISH'], ['Starlet', 'STARLET'], ['Platz', 'PLATZ'], ['Caldina', 'CALDINA'], ['Prado', 'PRADO'],
    ['Land Cruiser', 'LANDCRUISER|LAND CRUISER'], ['Mark II', 'MARK ?2|MARK ?II|MARK11'], ['Mark X', 'MARK ?X'], ['Tercel', 'TERCEL'],
    ['Tacoma', 'TACOMA|PRERUNNER'], ['Ipsum', 'IPSUM'], ['Corona', 'CORONA'], ['Coaster', 'COASTER'], ['Harrier', 'HARRIER'],
    ['Isis', 'ISIS'], ['Picnic', 'PICNIC'], ['Voxy', 'VOXY'], ['Noah', 'NOAH'], ['Belta', 'BELTA'], ['Crown', 'CROWN'],
    ['Tundra', 'TUNDRA'], ['Fortuner', 'FORTUNER'], ['Passo', 'PASSO'], ['Vios', 'VIOS'], ['Premio', 'PREMIO'], ['Allion', 'ALLION'],
    ['Estima / Previa', 'ESTIMA|PREVIA'], ['Auris', 'AURIS'], ['Prius', 'PRIUS'], ['Alphard', 'ALPHARD'], ['Kluger', 'KLUGER'],
    ['Cressida', 'CRESSIDA'], ['Carina', 'CARINA'], ['Celica', 'CELICA'], ['Altezza', 'ALTEZZA'], ['Ist', 'IST'], ['Dyna', 'DYNA'], ['Avensis', 'AVENSIS']]],
  ['Nissan', 'NISSAN', [
    ['Sunny', 'SUNNY|B1[2345]'], ['Bluebird', 'BLUEBIRD'], ['Tiida / Latio', 'TIIDA|LATIO'], ['Caravan / Urvan', 'CARAVAN|URVAN|HOMY'],
    ['AD Wagon / Wingroad', 'AD|ADWAGON|AD WAGON|WINGROAD|EXPERT'], ['Note', 'NOTE'], ['Pick-up / Frontier / Navara', 'PICK ?UP|FRONTIER|NAVARA'],
    ['Serena', 'SERENA'], ['March', 'MARCH'], ['X-Trail', 'XTRAIL|X-TRAIL|X TRAIL'], ['Vanette', 'VANETTE'], ['Cube', 'CUBE'],
    ['Pathfinder', 'PATHFINDER'], ['Lafesta', 'LAFESTA'], ['Sylphy / Sentra', 'SYLPHY|SENTRA'], ['Versa', 'VERSA'], ['Almera', 'ALMERA'],
    ['Pulsar', 'PULSAR'], ['Teana', 'TEANA'], ['Qashqai / Dualis', 'QASHQAI|DUALIS'], ['Skyline', 'SKYLINE'], ['Cefiro / Maxima', 'CEFIRO|MAXIMA'],
    ['Juke', 'JUKE'], ['Presage', 'PRESAGE'], ['Murano', 'MURANO'], ['Patrol', 'PATROL']]],
  ['Honda', 'HONDA', [
    ['Civic', 'CIVIC'], ['Accord', 'ACCORD'], ['CR-V', 'CRV|CR-V|CR V'], ['Fit / Jazz', 'FIT|JAZZ'], ['Integra', 'INTEGRA'], ['Stream', 'STREAM'],
    ['Odyssey', 'ODYSSEY|ODESSEY'], ['Stepwgn', 'STEPWAGON|STEPWGN|STEP WAGON'], ['Partner', 'PARTNER'], ['City', 'CITY'], ['Orthia', 'ORTHIA'],
    ['HR-V / Vezel', 'HRV|HR-V|VEZEL'], ['Prelude', 'PRELUDE'], ['Logo', 'LOGO'], ['Grace', 'GRACE'], ['Insight', 'INSIGHT'], ['Inspire', 'INSPIRE']]],
  ['Mitsubishi', 'MITSUBISHI', [
    ['Lancer / Cedia', 'LANCER|CEDIA'], ['Galant', 'GALANT'], ['Pajero / Montero', 'PAJERO|MONTERO|NATIVA'], ['L200', 'L200'], ['L300', 'L300'],
    ['Space Wagon / Grandis', 'SPACE|GRANDIS'], ['Mirage', 'MIRAGE'], ['RVR', 'RVR'], ['Outlander / Airtrek', 'OUTLANDER|AIRTREK'], ['Challenger', 'CHALLENGER']]],
  ['Suzuki', 'SUZUKI', [
    ['Swift', 'SWIFT'], ['Vitara / Grand Vitara', 'VITARA'], ['Baleno', 'BALENO'], ['Alto', 'ALTO'], ['Liana', 'LIANA'], ['SX4', 'SX4']]],
  ['Mazda', 'MAZDA', [
    ['Demio / Mazda2', 'DEMIO|MAZDA ?2'], ['Premacy / Mazda5', 'PREMACY|MAZDA ?5'], ['Mazda3 / Axela', 'MAZDA ?3|AXELA'], ['Mazda6 / Atenza', 'MAZDA ?6|ATENZA'],
    ['B-Series pick-up', 'B2200|B1800|B2000|B2500|B2600|PICK ?UP|BT-?50'], ['Familia', 'FAMILIA'], ['Bongo', 'BONGO']]],
  ['Subaru', 'SUBARU', [['Impreza', 'IMPREZA|IMPREZZA|WRX'], ['Forester', 'FORESTER'], ['Legacy', 'LEGACY|OUTBACK'], ['XV', 'XV']]],
  ['Isuzu', 'ISUZU', []], ['Daihatsu', 'DAIHATSU', []], ['Hyundai', 'HYUNDAI', []], ['Ford', 'FORD', []],
];
(async () => {
  const { rows } = await db.query(`SELECT make_model m, count(*)::int n FROM products WHERE is_active AND make_model LIKE '% / %' GROUP BY 1`);
  const out = [];
  for (const [label, mk, models] of CUR) {
    const mkRe = new RegExp('(^|[/ ])(' + mk + ')($|[/ ])');
    const mine = rows.filter((r) => mkRe.test(r.m.split(' / ')[0]));
    const total = mine.reduce((s, r) => s + r.n, 0);
    const ms = [];
    for (const [name, re] of models) {
      const rx = new RegExp('(^|[^A-Z0-9])(' + re + ')($|[^A-Z0-9])');
      const n = mine.filter((r) => rx.test(r.m.split(' / ').slice(1).join(' / '))).reduce((s, r) => s + r.n, 0);
      if (n >= 10) ms.push({ name, re, n });
    }
    ms.sort((a, b) => a.name.localeCompare(b.name));
    if (total >= 20) out.push({ make: label, re: mk, n: total, models: ms });
  }
  const { rows: tot } = await db.query(`SELECT count(*)::int a, count(*) FILTER (WHERE stock_count > 0)::int s FROM products WHERE is_active`);
  const { rows: cr } = await db.query(`SELECT category c, count(*)::int n FROM products WHERE is_active AND category <> '' GROUP BY 1`);
  const cats = {}; for (const r of cr) cats[r.c] = r.n;
  const js = '/* Vision Auto vehicle list, generated from the catalogue (products.make_model "MAKE / MODELS YEARS").\n'
    + '   n = parts listed for that make / model; re = how the model is written in make_model. */\n'
    + 'window.VA_VEHICLES = ' + JSON.stringify({ built: new Date().toISOString().slice(0, 10), parts: tot[0].a, in_stock: tot[0].s, cats, makes: out }) + ';\n';
  fs.writeFileSync(require('path').join(__dirname, '..', 'assets', 'vehicles.js'), js);
  for (const m of out) console.log(m.make, m.n, m.models.map((x) => x.name + ':' + x.n).join(', '));
  console.log(tot[0], js.length + ' bytes');
  await db.end();
})();
