import crypto from 'node:crypto';
import fs from 'node:fs/promises';

const MIN_SPACING = 35;
const VERSION = 5;

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

const MATCH = 'https://routing.openstreetmap.de/routed-car/match/v1/driving/';
const MATCH_CHUNK = 10;
const MATCH_RADIUS_M = 35;
const MAX_GAP_M = 250;
const MATCH_DETOUR_RATIO = 1.25;
const MATCH_DETOUR_SLACK = 80;

function densify(points) {
  const out = [points[0]];
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const steps = Math.ceil(meters(a, b) / MAX_GAP_M);
    for (let k = 1; k < steps; k += 1) out.push({ lat: a.lat + ((b.lat - a.lat) * k) / steps, lon: a.lon + ((b.lon - a.lon) * k) / steps });
    out.push(b);
  }
  return out;
}

async function matchChunk(points) {
  const coords = points.map((point) => `${point.lon.toFixed(6)},${point.lat.toFixed(6)}`).join(';');
  const radiuses = points.map(() => MATCH_RADIUS_M).join(';');
  const url = `${MATCH}${coords}?overview=full&geometries=geojson&radiuses=${radiuses}&gaps=ignore`;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Muevt (app mobilita Altamura)' }, signal: AbortSignal.timeout(30000) });
      if (!res.ok && res.status !== 400) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (body.code !== 'Ok' || body.matchings?.length !== 1) return null;
      const matching = body.matchings[0];
      return { distance: matching.distance, points: matching.geometry.coordinates.map(([lon, lat]) => ({ lat, lon })) };
    } catch (error) {
      if (attempt >= 3) throw error;
      await sleep(1500 * attempt);
    }
  }
}

export async function snapToRoads(shape) {
  const points = densify(waypoints(shape));
  const result = [];
  let straight = 0;
  let total = 0;
  for (let start = 0; start < points.length - 1; start += MATCH_CHUNK - 1) {
    const chunk = points.slice(start, start + MATCH_CHUNK);
    let drawnLength = 0;
    for (let i = 1; i < chunk.length; i += 1) drawnLength += meters(chunk[i - 1], chunk[i]);
    const matched = await matchChunk(chunk);
    const good = matched && matched.points.length > 1 && matched.distance <= drawnLength * MATCH_DETOUR_RATIO + MATCH_DETOUR_SLACK;
    total += 1;
    if (!good) straight += 1;
    const piece = good ? matched.points : chunk;
    result.push(...(result.length ? piece.slice(1) : piece));
    await sleep(250);
  }
  return { points: result, straight, total };
}

const ALIGN_M = 60;

function measure(points) {
  const cumulative = [0];
  for (let i = 1; i < points.length; i += 1) cumulative.push(cumulative[i - 1] + meters(points[i - 1], points[i]));
  return cumulative;
}

function projectOn(drawn, cumulative, point, from) {
  const kx = 111320 * Math.cos((point.lat * Math.PI) / 180);
  const ky = 110540;
  let best = null;
  for (let i = 0; i < drawn.length - 1; i += 1) {
    if (cumulative[i + 1] < from - 50 || cumulative[i] > from + 2000) continue;
    const ax = (drawn[i].lon - point.lon) * kx;
    const ay = (drawn[i].lat - point.lat) * ky;
    const dx = (drawn[i + 1].lon - drawn[i].lon) * kx;
    const dy = (drawn[i + 1].lat - drawn[i].lat) * ky;
    const length2 = dx * dx + dy * dy;
    const t = length2 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / length2)) : 0;
    const distance = Math.hypot(ax + t * dx, ay + t * dy);
    if (!best || distance < best.distance) best = { distance, along: cumulative[i] + t * (cumulative[i + 1] - cumulative[i]) };
  }
  return best ?? { distance: Infinity, along: from };
}

function drawnBetween(drawn, cumulative, from, to) {
  const at = (along) => {
    for (let i = 1; i < drawn.length; i += 1) {
      if (cumulative[i] >= along) {
        const t = (along - cumulative[i - 1]) / (cumulative[i] - cumulative[i - 1] || 1);
        return {
          lat: drawn[i - 1].lat + (drawn[i].lat - drawn[i - 1].lat) * t,
          lon: drawn[i - 1].lon + (drawn[i].lon - drawn[i - 1].lon) * t,
        };
      }
    }
    return drawn[drawn.length - 1];
  };
  return [at(from), ...drawn.filter((_, i) => cumulative[i] > from && cumulative[i] < to), at(to)];
}

export function alignToDrawing(snapped, drawn) {
  if (drawn.length < 2 || snapped.length < 2) return snapped;
  const cumulative = measure(drawn);
  const result = [];
  let along = 0;
  let i = 0;
  while (i < snapped.length) {
    const here = projectOn(drawn, cumulative, snapped[i], along);
    if (here.distance <= ALIGN_M) {
      result.push(snapped[i]);
      along = Math.max(along, here.along);
      i += 1;
      continue;
    }
    let j = i + 1;
    let back = null;
    while (j < snapped.length) {
      back = projectOn(drawn, cumulative, snapped[j], along);
      if (back.distance <= ALIGN_M) break;
      j += 1;
    }
    if (j >= snapped.length || !back || back.along <= along) {
      result.push(...snapped.slice(i, j));
      i = j;
      continue;
    }
    result.push(...drawnBetween(drawn, cumulative, along, back.along));
    along = back.along;
    i = j;
  }
  return result;
}

const LOOP_MIN_M = 60;
const LOOP_MAX_M = 900;
const LOOP_CLOSE_M = 20;
const STOP_NEAR_M = 50;
const TURN_PROBE_M = 40;
const TURN_SAME_M = 25;

function probe(points, index, step, distance) {
  let k = index;
  let walked = 0;
  while (k + step >= 0 && k + step < points.length && walked < distance) {
    walked += meters(points[k], points[k + step]);
    k += step;
  }
  return walked >= distance * 0.6 ? points[k] : null;
}

export function removeEmptyLoops(shape, stops = []) {
  const located = stops.filter((stop) => Number.isFinite(stop?.lat) && Number.isFinite(stop?.lon));
  let points = shape.slice();
  let i = 0;
  while (i < points.length) {
    let walked = 0;
    let end = -1;
    for (let j = i + 1; j < points.length; j += 1) {
      walked += meters(points[j - 1], points[j]);
      if (walked > LOOP_MAX_M) break;
      if (walked > LOOP_MIN_M && meters(points[i], points[j]) < LOOP_CLOSE_M) end = j;
    }
    if (end < 0) {
      i += 1;
      continue;
    }
    const inner = points.slice(i + 1, end);
    const servesStop = located.some(
      (stop) => meters(stop, points[i]) > 30 && meters(stop, points[end]) > 30 && inner.some((point) => meters(stop, point) < STOP_NEAR_M)
    );
    const before = probe(points, i, -1, TURN_PROBE_M);
    const after = probe(points, end, 1, TURN_PROBE_M);
    const turnaround = before && after && meters(before, after) < TURN_SAME_M;
    if (servesStop || turnaround) {
      i = end;
      continue;
    }
    points = [...points.slice(0, i + 1), ...points.slice(end + 1)];
  }
  return points;
}

async function snappedFor(cache, cacheKey, drawn, label, notes) {
  const key = crypto
    .createHash('sha1')
    .update(`${VERSION}|${drawn.map((point) => `${point.lat.toFixed(5)},${point.lon.toFixed(5)}`).join(';')}`)
    .digest('hex');
  const entry = cache.linee[cacheKey];
  if (entry?.chiave === key) return { points: entry.forma.map(([lat, lon]) => ({ lat, lon })), changed: false };
  try {
    const { points, straight, total } = await snapToRoads(drawn);
    if (straight > total * 0.25) {
      notes.push(`${label}: tracciato non agganciato alle strade (${straight} pezzi su ${total}), resta quello disegnato`);
      return null;
    }
    cache.linee[cacheKey] = { chiave: key, forma: points.map((point) => [round(point.lat), round(point.lon)]) };
    return { points, changed: true };
  } catch (error) {
    notes.push(`${label}: tracciato non agganciato alle strade (${error.message}), resta quello disegnato`);
    return null;
  }
}

const clean = (path) => (path ?? []).filter((point) => Number.isFinite(point?.lat) && Number.isFinite(point?.lon));

export async function applyRoadShapes(transport, cacheFile, notes = []) {
  const cache = await readJson(cacheFile, {
    fonte: '© OpenStreetMap contributors, ODbL (tracciati agganciati alle strade con OSRM match)',
    linee: {},
  });
  let changed = false;

  for (const line of transport.lines) {
    const drawn = clean(line.shape);
    if (drawn.length >= 2) {
      const snapped = await snappedFor(cache, line.id, drawn, line.name, notes);
      if (snapped) {
        changed ||= snapped.changed;
        const aligned = alignToDrawing(snapped.points, drawn);
        line.shape = removeEmptyLoops(aligned, line.stops);
        if (line.shape.length < aligned.length) notes.push(`${line.name}: tolti dal tracciato giri d'isolato senza fermate`);
      }
    }
    const extras = [];
    for (const [k, path] of (line.drawnExtra ?? []).entries()) {
      const extraDrawn = clean(path);
      if (extraDrawn.length < 2) continue;
      const snapped = await snappedFor(cache, `${line.id}#${k + 1}`, extraDrawn, `${line.name} (disegno ${k + 2})`, notes);
      if (snapped) changed ||= snapped.changed;
      extras.push(snapped ? alignToDrawing(snapped.points, extraDrawn) : extraDrawn);
    }
    line.extraShapes = extras;
    delete line.drawnExtra;
  }

  if (changed)
    await fs.writeFile(
      cacheFile,
      `${JSON.stringify(cache)}
`
    );
  return transport;
}
