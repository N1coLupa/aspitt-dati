// Luoghi di Altamura per la sezione Scopri e per la mappa.
//
// Le coordinate e i nomi arrivano da OpenStreetMap via Overpass: e' l'unica
// fonte aperta con una copertura decente del centro storico e della Murgia.
// I testi descrittivi non sono scaricabili da nessuna parte, quindi vivono in
// scripts/data/places-curated.json e vengono agganciati per nome: OSM fornisce
// il dato geografico, il file curato la voce editoriale.
//
// Uso: node scripts/scrapers/places.mjs

import fs from 'node:fs/promises';
import path from 'node:path';
import { slugify } from '../lib/slug.mjs';
import { distanceMeters } from '../lib/geo.mjs';
import { attachImages } from './images.mjs';

const OVERPASS_ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

// Il territorio comunale di Altamura vale oltre 400 km2 e comprende il Pulo, la
// grotta di Lamalunga e le masserie della Murgia. Interrogare il confine
// amministrativo invece di un riquadro evita di tirare dentro i monumenti di
// Gravina e Santeramo, che cadono nello stesso rettangolo.
const QUERY = `
[out:json][timeout:120];
area["boundary"="administrative"]["admin_level"="8"]["name"="Altamura"]->.altamura;
(
  nwr["tourism"~"^(attraction|museum|artwork|viewpoint|picnic_site)$"](area.altamura);
  nwr["historic"](area.altamura);
  nwr["leisure"~"^(park|garden|nature_reserve)$"](area.altamura);
  nwr["amenity"="place_of_worship"](area.altamura);
  nwr["natural"~"^(cave_entrance|cliff|peak)$"](area.altamura);
  nwr["boundary"="protected_area"](area.altamura);
);
out center tags;
`;

const CATEGORY_RULES = [
  {
    category: 'trekking',
    test: (t) =>
      t.leisure === 'nature_reserve' ||
      t.boundary === 'protected_area' ||
      t.natural === 'cave_entrance' ||
      t.natural === 'peak' ||
      t.natural === 'cliff' ||
      t.tourism === 'viewpoint' ||
      t.tourism === 'picnic_site',
  },
  {
    category: 'parchi',
    test: (t) => t.leisure === 'park' || t.leisure === 'garden',
  },
  {
    category: 'cultura',
    test: (t) =>
      Boolean(t.historic) ||
      t.tourism === 'museum' ||
      t.tourism === 'artwork' ||
      t.amenity === 'place_of_worship' ||
      t.tourism === 'attraction',
  },
];

function categorise(tags) {
  const matched = CATEGORY_RULES.filter((rule) => rule.test(tags)).map((r) => r.category);
  return matched.length ? matched : ['cultura'];
}

// Serve alla mappa: icona nera per i luoghi simbolo, icona leggera per il resto.
function iconFor(tags) {
  if (tags.leisure === 'park' || tags.leisure === 'garden') return 'park';
  if (tags.leisure === 'nature_reserve' || tags.boundary === 'protected_area') return 'nature';
  if (tags.natural === 'cave_entrance') return 'cave';
  if (tags.natural === 'peak') return 'peak';
  if (tags.tourism === 'museum') return 'museum';
  if (tags.tourism === 'viewpoint') return 'viewpoint';
  if (tags.amenity === 'place_of_worship') return 'church';
  if (tags.historic === 'archaeological_site') return 'archaeology';
  if (tags.historic) return 'monument';
  return 'landmark';
}

async function overpass(query) {
  let lastError;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Muevt/1.0 (app di mobilita per Altamura)',
        },
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

async function readCurated() {
  const file = path.join('scripts', 'data', 'places-curated.json');
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    console.warn('  ! nessun file curato: i luoghi resteranno senza descrizione');
    return [];
  }
}

export async function scrapePlaces() {
  console.log('> OpenStreetMap / Overpass');
  const payload = await overpass(QUERY);
  const curated = await readCurated();

  const byId = new Map();
  for (const element of payload.elements ?? []) {
    const tags = element.tags ?? {};
    const name = tags['name:it'] ?? tags.name;
    if (!name) continue;

    const lat = element.lat ?? element.center?.lat;
    const lon = element.lon ?? element.center?.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const id = slugify(name);
    if (byId.has(id)) continue;

    byId.set(id, {
      id,
      name,
      lat,
      lon,
      categories: categorise(tags),
      icon: iconFor(tags),
      osm: `${element.type}/${element.id}`,
      address: [tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(' ') || null,
      website: tags.website ?? tags['contact:website'] ?? null,
      phone: tags.phone ?? tags['contact:phone'] ?? null,
      openingHours: tags.opening_hours ?? null,
      wikidata: tags.wikidata ?? null,
      wikipedia: tags.wikipedia ?? null,
      description: null,
      image: null,
      imageCredit: null,
      imageLicense: null,
      imageSource: null,
      highlight: false,
      duration: null,
      difficulty: null,
      experience: null,
    });
  }

  // Il file curato ha la precedenza: sovrascrive e, se serve, aggiunge luoghi
  // che OSM non mappa (una passeggiata, un itinerario, un'esperienza).
  for (const entry of curated) {
    const id = entry.id ?? slugify(entry.name);
    const existing = byId.get(id);
    byId.set(id, {
      ...(existing ?? { id, icon: 'landmark', categories: ['cultura'], osm: null }),
      ...entry,
      id,
      categories: entry.categories ?? existing?.categories ?? ['cultura'],
      lat: entry.lat ?? existing?.lat ?? null,
      lon: entry.lon ?? existing?.lon ?? null,
    });
  }

  const places = [...byId.values()].filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));

  // Ogni luogo porta con se' le fermate piu' vicine: e' cosi' che la scheda
  // "come arrivarci" funziona anche senza connessione.
  let transport = null;
  try {
    transport = JSON.parse(await fs.readFile(path.join(process.env.MUEVT_DATA_DIR ?? path.join('src', 'dati'), 'transport.json'), 'utf8'));
  } catch {
    console.warn('  ! transport.json assente: salto il calcolo delle fermate vicine');
  }

  if (transport) {
    const stops = transport.stops.filter((s) => Number.isFinite(s.lat));
    for (const place of places) {
      place.nearbyStops = stops
        .map((stop) => ({
          stopId: stop.id,
          name: stop.name,
          lines: stop.lines,
          distance: Math.round(distanceMeters(place, stop)),
        }))
        .filter((s) => s.distance <= 1200)
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 3);
    }
  }

  // Le fotografie arrivano da Wikidata/Commons: si aggiungono alla fine,
  // quando l'elenco dei luoghi e' ormai definitivo.
  try {
    await attachImages(places);
  } catch (err) {
    console.warn(`  ! immagini non recuperate: ${err.message}`);
  }

  const counts = places.reduce((acc, place) => {
    for (const category of place.categories) acc[category] = (acc[category] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`  ${places.length} luoghi`, counts);

  return {
    generatedAt: new Date().toISOString(),
    sources: [
      { name: 'OpenStreetMap', url: 'https://www.openstreetmap.org/copyright' },
      { name: 'Redazione Muevt', url: null },
    ],
    places: places.sort((a, b) => Number(b.highlight) - Number(a.highlight) || a.name.localeCompare(b.name)),
  };
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());

if (invokedDirectly) {
  const data = await scrapePlaces();
  await fs.mkdir('src/dati', { recursive: true });
  await fs.writeFile('src/dati/places.json', JSON.stringify(data, null, 2));
  console.log(`\nScritto src/dati/places.json (${data.places.length} luoghi)`);
}
