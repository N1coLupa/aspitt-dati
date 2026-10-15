// Parcheggi di Altamura da OpenStreetMap. Solo quello che la mappa dice davvero: tariffe, posti liberi e orari
// che non ci sono restano null e l'app li mostra come "non disponibili". Scrive src/dati/parcheggi.json.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { overpass } from '../lib/overpass.mjs';

const OUT = process.env.MUEVT_DATA_DIR
  ? path.join(process.env.MUEVT_DATA_DIR, 'parcheggi.json')
  : path.join('src', 'dati', 'parcheggi.json');
const STREETS = path.join('scripts', 'data', 'vie-altamura.json');
const BOX = { south: 40.79, west: 16.46, north: 40.87, east: 16.62 };

const PRIVATE = new Set(['private', 'customers', 'permit', 'no', 'delivery', 'residents', 'employees']);
const PUBLIC = new Set(['yes', 'public', 'permissive', 'destination']);
const KINDS = {
  surface: 'surface',
  'multi-storey': 'structure',
  underground: 'underground',
  rooftop: 'structure',
  street_side: 'street',
  lane: 'street',
  on_kerb: 'street',
  half_on_kerb: 'street',
  layby: 'street',
  garage_boxes: 'garage',
  carports: 'garage',
};

const rad = (deg) => (deg * Math.PI) / 180;
const meters = (a, b) => Math.hypot((a.lat - b[0]) * 110540, (a.lon - b[1]) * 111320 * Math.cos(rad(a.lat)));

const yesNo = (value) => (value == null ? null : /^(yes|si|sì|true)$/i.test(value) ? true : /^(no|false)$/i.test(value) ? false : null);
const number = (value) => (value != null && /^\d+$/.test(value.trim()) ? Number(value) : null);

export function classifyAccess(tags) {
  const access = tags['access'] ?? tags['motor_vehicle'] ?? tags['motorcar'];
  if (access && PRIVATE.has(access)) return { access: 'private', declared: true };
  if (access && PUBLIC.has(access)) return { access: 'public', declared: true };
  if (/comune|municipal/i.test(tags.operator ?? '') || tags['operator:type'] === 'public') return { access: 'public', declared: true };
  // OSM considera pubblico un parcheggio senza indicazioni: lo si segue, ma l'app dice che non e' dichiarato.
  return { access: 'public', declared: false };
}

function nearestStreet(point, streets) {
  let best = null;
  for (const street of streets) {
    for (const vertex of street.g) {
      const d = meters(point, vertex);
      if (!best || d < best.d) best = { d, name: street.n };
    }
  }
  return best && best.d < 120 ? best.name : null;
}

export function normalize(element, streets) {
  const tags = element.tags ?? {};
  const lat = element.lat ?? element.center?.lat;
  const lon = element.lon ?? element.center?.lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const point = { lat, lon };
  const street = tags['addr:street'] ?? nearestStreet(point, streets);
  const address = tags['addr:street'] ? [tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(' ') : street;
  const { access, declared } = classifyAccess(tags);
  return {
    id: `osm-${element.type}-${element.id}`,
    name: tags.name ?? null,
    street,
    address,
    lat: +lat.toFixed(6),
    lon: +lon.toFixed(6),
    access,
    accessDeclared: declared,
    kind: KINDS[tags.parking] ?? (tags.parking ? 'other' : null),
    fee: yesNo(tags.fee),
    charge: tags.charge ?? null,
    payment: Object.keys(tags)
      .filter((key) => key.startsWith('payment:') && tags[key] === 'yes')
      .map((key) => key.slice(8)),
    openingHours: tags.opening_hours ?? null,
    maxHeight: tags.maxheight ?? null,
    maxStay: tags.maxstay ?? null,
    capacity: number(tags.capacity),
    capacityDisabled: number(tags['capacity:disabled']) ?? (yesNo(tags['capacity:disabled']) === true ? true : null),
    supervised: yesNo(tags.supervised),
    parkAndRide: yesNo(tags.park_ride),
    operator: tags.operator ?? null,
    osm: `https://www.openstreetmap.org/${element.type}/${element.id}`,
  };
}

export async function scrapeParking() {
  const streets = JSON.parse(await fs.readFile(STREETS, 'utf8')).vie;
  const box = `${BOX.south},${BOX.west},${BOX.north},${BOX.east}`;
  const json = await overpass(`[out:json][timeout:90];nwr["amenity"="parking"](${box});out tags center;`);
  const parking = json.elements.map((element) => normalize(element, streets)).filter(Boolean);
  if (parking.length < 10) throw new Error(`solo ${parking.length} parcheggi: OpenStreetMap ha risposto male, tengo i dati di prima`);
  parking.sort((a, b) => (a.name ?? a.street ?? '').localeCompare(b.name ?? b.street ?? ''));
  const data = { generatedAt: new Date().toISOString(), source: '© contributori OpenStreetMap, ODbL', parking };
  await fs.writeFile(OUT, JSON.stringify(data, null, 2) + '\n');
  console.log(`Parcheggi: ${parking.length} in ${OUT}`);
  return data;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  scrapeParking().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
