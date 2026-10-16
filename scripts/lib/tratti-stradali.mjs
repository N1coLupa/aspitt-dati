// I tratti fra due fermate consecutive che il tracciato della linea non copre: succede quando la mappa
// dell'operatore disegna solo l'andata (le linee scuola) o quando l'orario aggiunge fermate nuove.
// Per quei tratti si chiede il percorso stradale a OSRM e lo si salva in `line.hops`, con cache.
import fs from 'node:fs/promises';

import { removeEmptyLoops } from './forme-stradali.mjs';

const OSRM = 'https://routing.openstreetmap.de/routed-car/route/v1/driving/';
const NEAR_SHAPE_M = 60;
const DETOUR_RATIO = 4;
const DETOUR_EXTRA_M = 900;
const MAX_HOP_RATIO = 3;
const MAX_HOP_EXTRA_M = 1500;
const VERSION = 1;

const rad = Math.PI / 180;
function meters(a, b) {
  const x = (b.lon - a.lon) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
  const y = (b.lat - a.lat) * rad;
  return Math.sqrt(x * x + y * y) * 6371000;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (value) => Math.round(value * 1e5) / 1e5;

function measure(shape) {
  const cumulative = [0];
  for (let i = 1; i < shape.length; i += 1) cumulative.push(cumulative[i - 1] + meters(shape[i - 1], shape[i]));
  return cumulative;
}

// I passaggi del tracciato vicino a un punto, come distanze dall'inizio.
function passes(shape, cumulative, point) {
  const kx = 111320 * Math.cos(point.lat * rad);
  const ky = 110540;
  const found = [];
  let run = null;
  for (let i = 0; i < shape.length - 1; i += 1) {
    const ax = (shape[i].lon - point.lon) * kx;
    const ay = (shape[i].lat - point.lat) * ky;
    const dx = (shape[i + 1].lon - shape[i].lon) * kx;
    const dy = (shape[i + 1].lat - shape[i].lat) * ky;
    const length2 = dx * dx + dy * dy;
    const t = length2 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / length2)) : 0;
    const offset = Math.hypot(ax + t * dx, ay + t * dy);
    const along = cumulative[i] + t * (cumulative[i + 1] - cumulative[i]);
    if (offset <= NEAR_SHAPE_M) {
      if (!run || offset < run.offset) run = { along, offset };
    } else if (run) {
      found.push(run.along);
      run = null;
    }
  }
  if (run) found.push(run.along);
  return found;
}

// Il tracciato su cui si cercano i passaggi: come in src/utilita/forme.ts, il disegno di sola andata
// si ripercorre al contrario e il giro chiuso si ripete.
function extended(shape) {
  if (shape.length < 2) return shape;
  const gap = meters(shape[0], shape[shape.length - 1]);
  if (gap > 1500) return [...shape, ...[...shape].reverse().slice(1)];
  if (gap < 300) return [...shape, ...shape.slice(1)];
  return shape;
}

function sliceCovered(path, a, b, straight) {
  const cumulative = measure(path);
  const fromA = passes(path, cumulative, a);
  const fromB = passes(path, cumulative, b);
  let best = null;
  for (const x of fromA)
    for (const y of fromB)
      if (y > x && y - x <= straight * DETOUR_RATIO + DETOUR_EXTRA_M && (!best || y - x < best[1] - best[0])) best = [x, y];
  if (!best) return null;
  const at = (along) => {
    for (let i = 1; i < path.length; i += 1) {
      if (cumulative[i] >= along) {
        const t = (along - cumulative[i - 1]) / (cumulative[i] - cumulative[i - 1] || 1);
        return { lat: path[i - 1].lat + (path[i].lat - path[i - 1].lat) * t, lon: path[i - 1].lon + (path[i].lon - path[i - 1].lon) * t };
      }
    }
    return path[path.length - 1];
  };
  return [at(best[0]), ...path.filter((_, i) => cumulative[i] > best[0] && cumulative[i] < best[1]), at(best[1])];
}

export function uncoveredHops(line) {
  const shape = extended((line.shape ?? []).filter((p) => Number.isFinite(p?.lat)));
  const cumulative = measure(shape);
  const byIndex = new Map(line.stops.map((stop) => [stop.index, stop]));
  const hops = new Map();
  for (const trip of line.trips) {
    const served = trip.stopTimes
      .filter((st) => st.served && st.time && st.stopId)
      .map((st) => byIndex.get(st.index))
      .filter((stop) => stop?.lat != null && stop.lon != null);
    for (let k = 1; k < served.length; k += 1) {
      const a = served[k - 1];
      const b = served[k];
      const key = `${a.index}-${b.index}`;
      if (hops.has(key)) continue;
      const straight = meters(a, b);
      if (straight < 15) continue;
      const fromA = passes(shape, cumulative, a);
      const fromB = passes(shape, cumulative, b);
      const covered = fromA.some((x) => fromB.some((y) => y > x && y - x <= straight * DETOUR_RATIO + DETOUR_EXTRA_M));
      if (covered) continue;
      // Prima i disegni ufficiali in piu' della linea (il ritorno disegnato a parte), poi il calcolo.
      const drawn = (line.extraShapes ?? []).map((extra) => sliceCovered(extra, a, b, straight)).find(Boolean);
      hops.set(key, { key, a, b, straight, drawn: drawn ?? null });
    }
  }
  return [...hops.values()];
}

async function route(a, b) {
  const url = `${OSRM}${a.lon},${a.lat};${b.lon},${b.lat}?overview=full&geometries=geojson`;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Muevt (app mobilita Altamura)' }, signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const found = body.routes?.[0];
      if (body.code !== 'Ok' || !found) throw new Error(body.code ?? 'nessun percorso');
      return { distance: found.distance, points: found.geometry.coordinates.map(([lon, lat]) => ({ lat, lon })) };
    } catch (error) {
      if (attempt >= 3) throw error;
      await sleep(1500 * attempt);
    }
  }
}

const cacheKey = (a, b) => `${VERSION}|${a.lat.toFixed(5)},${a.lon.toFixed(5)};${b.lat.toFixed(5)},${b.lon.toFixed(5)}`;

export async function applyHopRoutes(transport, cacheFile, notes = []) {
  let cache = {};
  try {
    cache = JSON.parse(await fs.readFile(cacheFile, 'utf8')).tratti ?? {};
  } catch {}
  let changed = false;
  for (const line of transport.lines) {
    const missing = uncoveredHops(line);
    const result = {};
    let failed = 0;
    for (const hop of missing) {
      if (hop.drawn) {
        result[hop.key] = removeEmptyLoops(hop.drawn, []).map((p) => [round(p.lat), round(p.lon)]);
        continue;
      }
      const id = cacheKey(hop.a, hop.b);
      if (!cache[id]) {
        try {
          const found = await route(hop.a, hop.b);
          // Un percorso stradale molto piu' lungo della linea d'aria e' un giro sbagliato: meglio niente.
          if (found.distance > hop.straight * MAX_HOP_RATIO + MAX_HOP_EXTRA_M) throw new Error(`${Math.round(found.distance)} m`);
          cache[id] = found.points.map((p) => [round(p.lat), round(p.lon)]);
          changed = true;
          await sleep(250);
        } catch (error) {
          failed += 1;
          notes.push(`${line.name}: tratto ${hop.a.name} -> ${hop.b.name} senza percorso stradale (${error.message})`);
          continue;
        }
      }
      // Il percorso parte e arriva sulle fermate, anche dove la strada che OSRM conosce si ferma prima.
      const routed = cache[id].map(([lat, lon]) => ({ lat, lon }));
      if (meters(routed[0], hop.a) > 10) routed.unshift({ lat: hop.a.lat, lon: hop.a.lon });
      if (meters(routed[routed.length - 1], hop.b) > 10) routed.push({ lat: hop.b.lat, lon: hop.b.lon });
      // Come per i tracciati: niente giri d'isolato per arrivare alla fermata dal lato "giusto".
      result[hop.key] = removeEmptyLoops(routed, []).map((p) => [round(p.lat), round(p.lon)]);
    }
    if (Object.keys(result).length) line.hops = result;
    else delete line.hops;
    if (missing.length) notes.push(`${line.name}: ${missing.length - failed} tratti fuori dal tracciato disegnati sulle strade`);
  }
  if (changed) {
    await fs.writeFile(
      cacheFile,
      `${JSON.stringify({ fonte: '© OpenStreetMap contributors, ODbL (percorsi OSRM fra fermate consecutive)', tratti: cache })}\n`
    );
  }
  return transport;
}
