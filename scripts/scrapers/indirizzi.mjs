import fs from 'node:fs/promises';
import path from 'node:path';

const OVERPASS_ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const OUT = path.join('src', 'dati', 'indirizzi.json');
const SCALE = 1e5;

const POI_KEYS = ['amenity', 'shop', 'tourism', 'leisure', 'office', 'healthcare', 'craft', 'historic', 'club', 'sport'];
const SKIP_BUILDINGS = 'yes|house|residential|apartments|detached|terrace|garage|garages|roof|shed|construction';

const QUERY = `[out:json][timeout:180];
area["name"="Altamura"]["admin_level"="8"]->.a;
(
  way["highway"]["name"](area.a);
  nwr["addr:housenumber"]["addr:street"](area.a);
  ${POI_KEYS.map((key) => `nwr["name"]["${key}"](area.a);`).join('\n  ')}
  nwr["name"]["building"]["building"!~"^(${SKIP_BUILDINGS})$"](area.a);
  node["name"]["place"](area.a);
);
out tags center;`;

async function overpass(query) {
  let lastError;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Muevt/1.0 (app di mobilita per Altamura)' },
        body: new URLSearchParams({ data: query }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastError = err;
      console.warn(`  ! ${endpoint}: ${err.message}`);
    }
  }
  throw lastError;
}

const at = (element) => {
  const lat = element.lat ?? element.center?.lat;
  const lon = element.lon ?? element.center?.lon;
  return Number.isFinite(lat) && Number.isFinite(lon) ? [Math.round(lat * SCALE), Math.round(lon * SCALE)] : null;
};

const clean = (text) =>
  String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();

const json = await overpass(QUERY);
const elements = json.elements ?? [];

const streetPoints = new Map();
for (const element of elements) {
  const name = clean(element.tags?.name);
  if (!element.tags?.highway || !name) continue;
  const point = at(element);
  if (!point) continue;
  streetPoints.set(name, [...(streetPoints.get(name) ?? []), point]);
}

const streets = [...streetPoints.entries()]
  .map(([name, points]) => {
    const lat = points.reduce((sum, p) => sum + p[0], 0) / points.length;
    const lon = points.reduce((sum, p) => sum + p[1], 0) / points.length;
    const middle = points.reduce((best, p) => (Math.hypot(p[0] - lat, p[1] - lon) < Math.hypot(best[0] - lat, best[1] - lon) ? p : best));
    return [name, middle[0], middle[1]];
  })
  .sort((a, b) => a[0].localeCompare(b[0], 'it'));
const streetIndex = new Map(streets.map((street, index) => [street[0], index]));

const numbers = new Map();
for (const element of elements) {
  const street = clean(element.tags?.['addr:street']);
  const number = clean(element.tags?.['addr:housenumber']).toUpperCase().replace(/\s+/g, '');
  if (!street || !number || !streetIndex.has(street)) continue;
  const point = at(element);
  if (!point) continue;
  numbers.set(`${street}|${number}`, [streetIndex.get(street), number, point[0], point[1]]);
}

const places = new Map();
for (const element of elements) {
  const tags = element.tags ?? {};
  const name = clean(tags.name);
  if (!name || tags.highway) continue;
  const point = at(element);
  if (!point) continue;
  const street = clean(tags['addr:street']);
  const number = clean(tags['addr:housenumber']);
  const address = street ? clean(`${street} ${number}`) : '';
  const key = `${name.toLowerCase()}|${Math.round(point[0] / 50)}|${Math.round(point[1] / 50)}`;
  if (!places.has(key)) places.set(key, [name, point[0], point[1], address]);
}

const ANNCSU = 'https://anncsu.open.agenziaentrate.gov.it/age-inspire/opendata/anncsu/querydata.php';
const COMUNE = 'A225';
const BOX = { south: 40.6, north: 41.05, west: 16.3, east: 16.85 };
const SMALL = new Set([
  'di',
  'del',
  'della',
  'delle',
  'dei',
  'degli',
  'de',
  'da',
  'e',
  'la',
  'le',
  'lo',
  'il',
  'in',
  'al',
  'alla',
  'd',
  'l',
]);
const DUG =
  /^(via|viale|vico|vicolo|piazza|piazzale|largo|corso|contrada|strada|traversa|parco|rione|salita|arco|corte|zona|lungo|localita)\s+/i;

async function anncsu(params) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetch(`${ANNCSU}?${new URLSearchParams(params)}`, {
        headers: { 'User-Agent': 'Muevt/1.0 (app di mobilita per Altamura)' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      return body.success ? (body.result?.records ?? []) : [];
    } catch (err) {
      if (attempt === 2) console.warn(`  ! ANNCSU ${JSON.stringify(params)}: ${err.message}`);
      await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
    }
  }
  return [];
}

async function pool(items, size, work) {
  const results = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await work(items[index]);
      }
    })
  );
  return results;
}

const titleCase = (text) =>
  text
    .toLowerCase()
    .split(/\s+/)
    .map((word, index) => (index > 0 && SMALL.has(word) ? word : word.replace(/^(\p{L})/u, (c) => c.toUpperCase())))
    .join(' ')
    .replace(/\b([dl])' ?(\p{L})/giu, (_, a, b) => `${a.toLowerCase()}'${b.toUpperCase()}`);

const words = new Set(['SAN', 'DEL', 'DEI', 'ANO', 'INO', 'ONE', 'ARI', 'ELL', 'ENT', 'ALE', 'ORO', 'ATO', 'ERA', 'IST']);
for (const [name] of streets) {
  for (const word of name
    .replace(DUG, '')
    .toUpperCase()
    .split(/[^A-ZÀ-Ú]+/))
    if (word.length >= 3) words.add(word);
}

const odonimi = new Map();
await pool([...words], 4, async (word) => {
  for (const record of await anncsu({ resource: 'odonimi', codicecomune: COMUNE, denominazione: word })) {
    odonimi.set(record.Progressivo_nazionale, titleCase(`${record.DUG} ${record.DUF}`));
  }
});
console.log(`ANNCSU: ${odonimi.size} vie`);

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
const coordinate = (value) => Number(String(value ?? '').replace(',', '.'));
const official = await pool([...odonimi.entries()], 6, async ([id, name]) => {
  const civici = [];
  const records = [];
  for (const digit of DIGITS) records.push(...(await anncsu({ resource: 'accessi', progressivoodonimo: id, accesso: digit })));
  for (const record of records) {
    const lat = coordinate(record.CoordY);
    const lon = coordinate(record.CoordX);
    const number = `${clean(record.Civico)}${clean(record.Esponente)}`.toUpperCase().replace(/\s+/g, '');
    if (!number || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat < BOX.south || lat > BOX.north || lon < BOX.west || lon > BOX.east) continue;
    civici.push([number, Math.round(lat * SCALE), Math.round(lon * SCALE)]);
  }
  return { name, civici };
});

const ORDINALS = {
  primo: 'i',
  secondo: 'ii',
  terzo: 'iii',
  quarto: 'iv',
  quinto: 'v',
  sesto: 'vi',
  settimo: 'vii',
  ottavo: 'viii',
  nono: 'ix',
  decimo: 'x',
  undicesimo: 'xi',
  dodicesimo: 'xii',
  tredicesimo: 'xiii',
  ventitreesimo: 'xxiii',
  ventiquattresimo: 'xxiv',
};
const fold = (text) =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((word) => !SMALL.has(word))
    .map((word) => ORDINALS[word] ?? word)
    .join(' ');
const byFold = new Map(streets.map((street, index) => [fold(street[0]), index]));
for (const { name, civici } of official) {
  if (!civici.length) continue;
  let index = byFold.get(fold(name));
  if (index === undefined) {
    const middle = civici[Math.floor(civici.length / 2)];
    streets.push([name, middle[1], middle[2]]);
    index = streets.length - 1;
    byFold.set(fold(name), index);
  }
  for (const [number, lat, lon] of civici) numbers.set(`${streets[index][0]}|${number}`, [index, number, lat, lon]);
}

const output = {
  fonte: '© contributori OpenStreetMap, ODbL; numeri civici ANNCSU (Agenzia delle Entrate, ISTAT), CC BY 4.0',
  aggiornato: new Date().toISOString().slice(0, 10),
  vie: streets,
  civici: [...numbers.values()].sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1], 'it', { numeric: true })),
  posti: [...places.values()].sort((a, b) => a[0].localeCompare(b[0], 'it')),
};

await fs.writeFile(OUT, `${JSON.stringify(output)}\n`);
console.log(`Vie ${output.vie.length}, civici ${output.civici.length}, posti ${output.posti.length}: ${OUT}`);
