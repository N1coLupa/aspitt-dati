import crypto from 'node:crypto';
import fs from 'node:fs/promises';

const OSRM = 'https://routing.openstreetmap.de/routed-car/route/v1/driving/';
const CHUNK = 25;
const MIN_SPACING = 35;
const DETOUR_RATIO = 1.5;
const DETOUR_SLACK = 60;
const VERSION = 4;

const readJson = async (file, fallback) => {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
};

const round = (value) => Math.round(value * 1e5) / 1e5;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function meters(a, b) {
  const rad = Math.PI / 180;
  const x = (b.lon - a.lon) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
  const y = (b.lat - a.lat) * rad;
  return Math.sqrt(x * x + y * y) * 6371000;
}

function waypoints(shape) {
  const kept = [shape[0]];
  for (let i = 1; i < shape.length - 1; i += 1) {
    if (meters(kept[kept.length - 1], shape[i]) >= MIN_SPACING) kept.push(shape[i]);
  }
  kept.push(shape[shape.length - 1]);
  return kept;
}

async function routeChunk(points) {
  const coords = points.map((point) => `${point.lon},${point.lat}`).join(';');
  const url = `${OSRM}${coords}?overview=false&steps=true&geometries=geojson`;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Muevt (app mobilita Altamura)' }, signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const route = body.routes?.[0];
      if (body.code !== 'Ok' || !route) throw new Error(body.code ?? 'nessun percorso');
      return route.legs.map((leg) => ({
        distance: leg.distance,
        points: leg.steps.flatMap((step, i) => step.geometry.coordinates.slice(i ? 1 : 0).map(([lon, lat]) => ({ lat, lon }))),
      }));
    } catch (error) {
      if (attempt >= 3) throw error;
      await sleep(1500 * attempt);
    }
  }
}

async function snapToRoads(shape) {
  const points = waypoints(shape);
  const result = [];
  let straight = 0;
  for (let start = 0; start < points.length - 1; start += CHUNK - 1) {
    const chunk = points.slice(start, start + CHUNK);
    const legs = await routeChunk(chunk);
    legs.forEach((leg, i) => {
      const a = chunk[i];
      const b = chunk[i + 1];
      const detour = leg.distance > meters(a, b) * DETOUR_RATIO + DETOUR_SLACK;
      if (detour) straight += 1;
      const piece = detour || leg.points.length < 2 ? [a, b] : leg.points;
      result.push(...(result.length ? piece.slice(1) : piece));
    });
    await sleep(300);
  }
  return { points: result, straight, total: points.length - 1 };
}

export async function applyRoadShapes(transport, cacheFile, notes = []) {
  const cache = await readJson(cacheFile, {
    fonte: '© OpenStreetMap contributors, ODbL (tracciati agganciati alle strade con OSRM)',
    linee: {},
  });
  let changed = false;

  for (const line of transport.lines) {
    const drawn = (line.shape ?? []).filter((point) => Number.isFinite(point?.lat) && Number.isFinite(point?.lon));
    if (drawn.length < 2) continue;
    const key = crypto
      .createHash('sha1')
      .update(`${VERSION}|${drawn.map((point) => `${point.lat.toFixed(5)},${point.lon.toFixed(5)}`).join(';')}`)
      .digest('hex');

    let entry = cache.linee[line.id];
    if (entry?.chiave !== key) {
      try {
        const { points, straight, total } = await snapToRoads(drawn);
        if (straight > total * 0.25) {
          notes.push(
            `${line.name}: tracciato non agganciato alle strade (${straight} tratti su ${total} senza strada), resta quello originale`
          );
          continue;
        }
        entry = { chiave: key, forma: points.map((point) => [round(point.lat), round(point.lon)]) };
        cache.linee[line.id] = entry;
        changed = true;
      } catch (error) {
        notes.push(`${line.name}: tracciato non agganciato alle strade (${error.message}), resta quello originale`);
        continue;
      }
    }
    line.shape = entry.forma.map(([lat, lon]) => ({ lat, lon }));
  }

  if (changed) await fs.writeFile(cacheFile, `${JSON.stringify(cache)}\n`);
  return transport;
}
