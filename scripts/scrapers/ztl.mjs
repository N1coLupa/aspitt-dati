// ZTL di Altamura: regole da scripts/data/ztl.json (scritte dalle ordinanze), perimetro disegnato dalle vie che
// chiudono il centro storico su OpenStreetMap. Scrive src/dati/ztl.json.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { overpass } from '../lib/overpass.mjs';

const RULES = path.join('scripts', 'data', 'ztl.json');
const OUT = process.env.MUEVT_DATA_DIR ? path.join(process.env.MUEVT_DATA_DIR, 'ztl.json') : path.join('src', 'dati', 'ztl.json');

const CENTER_BOX = { south: 40.822, west: 16.548, north: 40.832, east: 16.559 };
// Punti che devono stare dentro: Cattedrale e Piazza Duomo. Se il poligono non li contiene, il disegno e' sbagliato.
const INSIDE = [
  { lat: 40.82745, lon: 16.55282 },
  { lat: 40.8276, lon: 16.5529 },
];
const MAX_GAP_M = 320;
const AREA_RANGE_M2 = [80_000, 600_000];

const rad = (deg) => (deg * Math.PI) / 180;
const meters = (a, b) => Math.hypot((a.lat - b.lat) * 110540, (a.lon - b.lon) * 111320 * Math.cos(rad(a.lat)));

export function chainRing(ways) {
  const pool = ways.map((way) => way.map((p) => ({ lat: p.lat, lon: p.lon })));
  pool.sort((a, b) => b.length - a.length);
  const ring = pool.shift();
  while (pool.length) {
    const end = ring[ring.length - 1];
    let best = null;
    pool.forEach((way, index) => {
      const head = meters(end, way[0]);
      const tail = meters(end, way[way.length - 1]);
      const gap = Math.min(head, tail);
      if (!best || gap < best.gap) best = { index, gap, reversed: tail < head };
    });
    if (best.gap > MAX_GAP_M) break;
    const [way] = pool.splice(best.index, 1);
    ring.push(...(best.reversed ? [...way].reverse() : way));
  }
  if (meters(ring[0], ring[ring.length - 1]) > MAX_GAP_M) throw new Error('il perimetro non si chiude: manca un tratto di strada');
  return [...ring, ring[0]];
}

export function contains(polygon, point) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    if (a.lat > point.lat !== b.lat > point.lat && point.lon < ((b.lon - a.lon) * (point.lat - a.lat)) / (b.lat - a.lat) + a.lon)
      inside = !inside;
  }
  return inside;
}

export function areaM2(polygon) {
  const kx = 111320 * Math.cos(rad(polygon[0].lat));
  let sum = 0;
  for (let i = 0; i < polygon.length - 1; i += 1) {
    sum += polygon[i].lon * kx * polygon[i + 1].lat * 110540 - polygon[i + 1].lon * kx * polygon[i].lat * 110540;
  }
  return Math.abs(sum / 2);
}

async function perimeter(streets) {
  const box = `${CENTER_BOX.south},${CENTER_BOX.west},${CENTER_BOX.north},${CENTER_BOX.east}`;
  const names = streets.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const json = await overpass(`[out:json][timeout:60];way["highway"]["name"~"^(${names})$"](${box});out geom;`);
  const ways = json.elements.filter((way) => way.geometry?.length > 1).map((way) => way.geometry);
  if (!ways.length) throw new Error('nessuna via del perimetro trovata su OpenStreetMap');
  return chainRing(ways);
}

export async function scrapeZtl() {
  const rules = JSON.parse(await fs.readFile(RULES, 'utf8'));
  const zones = [];
  for (const zone of rules.zone) {
    const polygon = await perimeter(zone.perimetro.vie);
    for (const point of INSIDE) if (!contains(polygon, point)) throw new Error(`${zone.nome}: il perimetro non contiene il centro storico`);
    const area = areaM2(polygon);
    if (area < AREA_RANGE_M2[0] || area > AREA_RANGE_M2[1]) throw new Error(`${zone.nome}: area di ${Math.round(area)} m2, fuori misura`);
    zones.push({
      id: zone.id,
      name: zone.nome,
      polygon: polygon.map((p) => [+p.lat.toFixed(6), +p.lon.toFixed(6)]),
      perimeterNote: zone.perimetro.nota,
      always: zone.sempre,
      bands: zone.fasce,
      timedGates: zone.varchiAOrario,
      gatesNote: zone.nomiVarchi ?? null,
      access: zone.accesso,
      enforcement: zone.controllo,
      contact: zone.info,
      status: zone.stato,
      sources: zone.fonti,
    });
  }
  const data = {
    generatedAt: new Date().toISOString(),
    verifiedAt: rules.verificato,
    source: 'Comune di Altamura; perimetro © OpenStreetMap',
    zones,
  };
  await fs.writeFile(OUT, JSON.stringify(data, null, 2) + '\n');
  console.log(`ZTL: ${zones.length} zone in ${OUT}`);
  return data;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  scrapeZtl().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
