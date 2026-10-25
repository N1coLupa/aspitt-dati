import fs from 'node:fs/promises';
import path from 'node:path';

const OVERPASS_ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const OUT = path.join('src', 'dati', 'strade.json');

const CORE = { south: 40.805, west: 16.515, north: 40.852, east: 16.595 };
const AROUND_METERS = 1000;
const SCALE = 1e5;

const HIGHWAYS =
  'footway|pedestrian|path|steps|living_street|residential|unclassified|service|tertiary|tertiary_link|secondary|secondary_link|primary|primary_link|track|cycleway|road|corridor';
const FILTER = `["highway"~"^(${HIGHWAYS})$"]["foot"!~"^(no|private)$"]["access"!~"^(no|private)$"]["area"!="yes"]`;

async function overpass(query) {
  let lastError;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Aspitt/1.0 (app di mobilita per Altamura)' },
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

const inCore = (p) => p.lat >= CORE.south && p.lat <= CORE.north && p.lon >= CORE.west && p.lon <= CORE.east;

async function outlyingPoints() {
  const transport = JSON.parse(await fs.readFile(path.join('src', 'dati', 'transport.json'), 'utf8'));
  const places = JSON.parse(await fs.readFile(path.join('src', 'dati', 'places.json'), 'utf8'));
  const points = [...(transport.stops ?? []), ...(places.places ?? places)]
    .filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon))
    .filter((p) => !inCore(p));
  const unique = [];
  for (const p of points) {
    if (!unique.some((q) => Math.abs(q.lat - p.lat) < 0.003 && Math.abs(q.lon - p.lon) < 0.004)) unique.push(p);
  }
  return unique;
}

export async function scrapeStreets() {
  const extra = await outlyingPoints();
  const query = `
[out:json][timeout:180];
(
  way${FILTER}(${CORE.south},${CORE.west},${CORE.north},${CORE.east});
${extra.map((p) => `  way${FILTER}(around:${AROUND_METERS},${p.lat.toFixed(6)},${p.lon.toFixed(6)});`).join('\n')}
);
out body geom qt;`;

  console.log(`> OpenStreetMap / Overpass: citta' + ${extra.length} zone esterne`);
  const payload = await overpass(query);
  const ways = (payload.elements ?? []).filter((el) => el.type === 'way' && Array.isArray(el.geometry) && Array.isArray(el.nodes));

  if (ways.length < 500) throw new Error(`solo ${ways.length} vie: tengo il grafo precedente`);

  const index = new Map();
  const coords = [];
  const names = [];
  const nameIndex = new Map();
  const edges = new Set();
  const flat = [];

  const nodeId = (osmId, point) => {
    let id = index.get(osmId);
    if (id === undefined) {
      id = coords.length;
      index.set(osmId, id);
      coords.push([Math.round(point.lat * SCALE), Math.round(point.lon * SCALE)]);
    }
    return id;
  };
  const nameId = (tags) => {
    const name = (tags?.name ?? '').trim().slice(0, 80);
    if (!name) return -1;
    let id = nameIndex.get(name);
    if (id === undefined) {
      id = names.length;
      nameIndex.set(name, id);
      names.push(name);
    }
    return id;
  };

  for (const way of ways) {
    const name = nameId(way.tags);
    for (let i = 1; i < way.nodes.length; i++) {
      const a = nodeId(way.nodes[i - 1], way.geometry[i - 1]);
      const b = nodeId(way.nodes[i], way.geometry[i]);
      if (a === b) continue;
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      if (edges.has(key)) continue;
      edges.add(key);
      flat.push(a, b, name);
    }
  }

  const origin = [Math.min(...coords.map((c) => c[0])), Math.min(...coords.map((c) => c[1]))];
  const graph = {
    fonte: '© OpenStreetMap contributors, ODbL',
    generato: new Date().toISOString(),
    scala: SCALE,
    origine: origin,
    nomi: names,
    nodi: coords.flatMap(([lat, lon]) => [lat - origin[0], lon - origin[1]]),
    archi: flat,
  };
  await fs.writeFile(OUT, JSON.stringify(graph) + '\n');
  const size = (await fs.stat(OUT)).size;
  console.log(
    `  ${ways.length} vie, ${coords.length} nodi, ${flat.length / 3} archi, ${names.length} nomi, ${(size / 1024).toFixed(0)} KB`
  );
  return graph;
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());

if (invokedDirectly) await scrapeStreets();
