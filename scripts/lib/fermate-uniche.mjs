// Una fermata fisica = una fermata nei dati. Le mappe di Marino hanno un segnaposto per linea, con nomi
// scritti in modi diversi ("Stazione Via XXIV Maggio uscita sottopasso Fal", "Via XXIV Maggio (uscita
// sottopasso Fal)"): la stessa pensilina finiva in quattro punti con sei nomi. Qui le fermate della stessa
// via, vicine e percorse nello stesso senso di marcia, diventano una sola; i due lati della strada (andata
// e ritorno) restano due fermate. La posizione e' quella dei segnaposto ufficiali, portata sulla strada
// che il bus percorre, dal lato del senso di marcia: niente fermate dentro le case.
import { slugify, stopKey } from './slug.mjs';

const SAME_STOP_M = 80;
const SAME_DIRECTION_DEG = 70;
const TERMINAL_SAME_M = 30;
const ROAD_SNAP_M = 50;
const SIDE_OFFSET_M = 4;

const NOISE = new Set([
  'stazione',
  'fermata',
  'bus',
  'pensilina',
  'fronte',
  'ang',
  'angolo',
  'presso',
  'civico',
  'alberghiero',
  'tecnico',
  'scientifico',
  'pedagogico',
  'ingresso',
  'istituto',
]);

const rad = Math.PI / 180;
function meters(a, b) {
  const x = (b.lon - a.lon) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
  const y = (b.lat - a.lat) * rad;
  return Math.sqrt(x * x + y * y) * 6371000;
}
function bearing(a, b) {
  const y = Math.sin((b.lon - a.lon) * rad) * Math.cos(b.lat * rad);
  const x = Math.cos(a.lat * rad) * Math.sin(b.lat * rad) - Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lon - a.lon) * rad);
  return (Math.atan2(y, x) / rad + 360) % 360;
}
const angle = (a, b) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

// Le parole che identificano il posto, senza "fronte", "pensilina", "Alberghiero 2" e simili.
export function placeTokens(name) {
  const tokens = stopKey(name).split(' ').filter(Boolean);
  const kept = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (NOISE.has(tokens[i])) {
      if (/^\d+$/.test(tokens[i + 1] ?? '') && ['alberghiero', 'tecnico', 'pedagogico', 'scientifico'].includes(tokens[i])) i += 1;
      continue;
    }
    kept.push(tokens[i]);
  }
  return kept;
}

function compatible(a, b) {
  const numbersA = a.filter((t) => /^\d+$/.test(t));
  const numbersB = b.filter((t) => /^\d+$/.test(t));
  if (numbersA.length && numbersB.length && numbersA.join() !== numbersB.join()) return false;
  const wordsA = a.filter((t) => !/^\d+$/.test(t));
  const wordsB = b.filter((t) => !/^\d+$/.test(t));
  if (!wordsA.length || !wordsB.length) return false;
  const [small, large] = wordsA.length <= wordsB.length ? [wordsA, wordsB] : [wordsB, wordsA];
  return small.every((t) => large.includes(t));
}

// Il senso di marcia del bus alla fermata, dalle fermate prima e dopo nella stessa corsa.
function directions(line) {
  const byIndex = new Map(line.stops.map((stop) => [stop.index, stop]));
  const found = new Map();
  for (const trip of line.trips) {
    const served = trip.stopTimes
      .filter((st) => st.served && st.time)
      .map((st) => byIndex.get(st.index))
      .filter((s) => s?.lat != null);
    served.forEach((stop, k) => {
      if (found.has(stop.index)) return;
      const prev = served[k - 1];
      const next = served[k + 1];
      const from = prev ?? stop;
      const to = next ?? stop;
      found.set(stop.index, { bearing: meters(from, to) > 5 ? bearing(from, to) : null, terminal: !prev || !next });
    });
  }
  return found;
}

function projectOn(path, point) {
  const kx = 111320 * Math.cos(point.lat * rad);
  const ky = 110540;
  let best = null;
  for (let i = 0; i < path.length - 1; i += 1) {
    const ax = (path[i].lon - point.lon) * kx;
    const ay = (path[i].lat - point.lat) * ky;
    const dx = (path[i + 1].lon - path[i].lon) * kx;
    const dy = (path[i + 1].lat - path[i].lat) * ky;
    const length2 = dx * dx + dy * dy;
    const t = length2 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / length2)) : 0;
    const distance = Math.hypot(ax + t * dx, ay + t * dy);
    if (!best || distance < best.distance) {
      best = {
        distance,
        point: { lat: path[i].lat + (path[i + 1].lat - path[i].lat) * t, lon: path[i].lon + (path[i + 1].lon - path[i].lon) * t },
        roadBearing: bearing(path[i], path[i + 1]),
      };
    }
  }
  return best;
}

// Sulla strada piu' vicina fra quelle percorse dalle linee della fermata (o, se nessuna e' vicina, fra le
// vie di OSM), spostata di qualche metro a destra del senso di marcia.
function onRoad(point, travel, paths, streets) {
  let best = null;
  for (const path of paths) {
    const hit = projectOn(path, point);
    if (hit && hit.distance <= ROAD_SNAP_M && (!best || hit.distance < best.distance)) best = hit;
  }
  if (!best) {
    for (const street of streets) {
      const hit = projectOn(street, point);
      if (hit && hit.distance <= ROAD_SNAP_M && (!best || hit.distance < best.distance)) best = hit;
    }
  }
  if (!best) return point;
  const heading = travel ?? best.roadBearing;
  const side = (heading + 90) * rad;
  return {
    lat: best.point.lat + (Math.cos(side) * SIDE_OFFSET_M) / 110540,
    lon: best.point.lon + (Math.sin(side) * SIDE_OFFSET_M) / (111320 * Math.cos(best.point.lat * rad)),
  };
}

const round = (value) => +value.toFixed(6);

export function unifyPhysicalStops(transport, { streets = [] } = {}, notes = []) {
  const members = [];
  for (const line of transport.lines) {
    const dirs = directions(line);
    for (const stop of line.stops) {
      if (stop.lat == null || stop.lon == null) continue;
      const dir = dirs.get(stop.index) ?? { bearing: null, terminal: true };
      members.push({ line, stop, tokens: placeTokens(stop.name), official: stop.position === 'exact', ...dir });
    }
  }

  const parent = members.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < members.length; i += 1) {
    for (let j = i + 1; j < members.length; j += 1) {
      const a = members[i];
      const b = members[j];
      const distance = meters(a.stop, b.stop);
      if (distance > SAME_STOP_M || !compatible(a.tokens, b.tokens)) continue;
      const sameDirection = a.bearing == null || b.bearing == null || angle(a.bearing, b.bearing) <= SAME_DIRECTION_DEG;
      const sameTerminal = (a.terminal || b.terminal) && distance <= TERMINAL_SAME_M;
      if (sameDirection || sameTerminal) parent[find(i)] = find(j);
    }
  }

  const groups = new Map();
  members.forEach((member, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), member]));

  const usedIds = new Set();
  const byMember = new Map();
  const stops = [];
  let merged = 0;
  for (const group of groups.values()) {
    const official = group.filter((m) => m.official);
    const pool = official.length ? official : group;
    // Il segnaposto ufficiale piu' "centrale" del gruppo: quello piu' vicino a tutti gli altri.
    const center = pool.reduce((best, m) => {
      const sum = pool.reduce((total, other) => total + meters(m.stop, other.stop), 0);
      return !best || sum < best.sum ? { m, sum } : best;
    }, null).m.stop;
    const counts = new Map();
    for (const m of pool) counts.set(m.stop.name, (counts.get(m.stop.name) ?? 0) + 1);
    const name = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0][0];
    const travel = group.find((m) => m.bearing != null)?.bearing ?? null;
    const paths = [...new Set(group.map((m) => m.line))]
      .flatMap((line) => [line.shape ?? [], ...(line.extraShapes ?? [])])
      .filter((p) => p.length > 1);
    const at = onRoad({ lat: center.lat, lon: center.lon }, travel, paths, streets);

    let id = `stop-${slugify(name)}`;
    for (let n = 2; usedIds.has(id); n += 1) id = `stop-${slugify(name)}-${n}`;
    usedIds.add(id);

    const entry = {
      id,
      name,
      lat: round(at.lat),
      lon: round(at.lon),
      lines: transport.lines.map((line) => line.id).filter((lineId) => group.some((m) => m.line.id === lineId)),
      position: official.length ? 'exact' : (group[0].stop.position ?? 'estimated'),
    };
    stops.push(entry);
    for (const m of group) byMember.set(m.stop, entry);
    const ids = new Set(group.map((m) => m.stop.stopId));
    if (ids.size > 1) merged += ids.size - 1;
  }

  for (const line of transport.lines) {
    const byIndex = new Map();
    for (const stop of line.stops) {
      const entry = byMember.get(stop);
      if (!entry) continue;
      stop.stopId = entry.id;
      stop.name = entry.name;
      stop.lat = entry.lat;
      stop.lon = entry.lon;
      stop.position = entry.position;
      byIndex.set(stop.index, entry.id);
    }
    for (const trip of line.trips) {
      for (const stopTime of trip.stopTimes) {
        if (byIndex.has(stopTime.index)) stopTime.stopId = byIndex.get(stopTime.index);
      }
    }
  }

  const unlocated = transport.stops.filter((stop) => stop.lat == null && !stops.some((s) => s.id === stop.id));
  transport.stops = [...stops, ...unlocated].sort((a, b) => a.name.localeCompare(b.name, 'it'));
  notes.push(`fermate: ${stops.length} fermate fisiche, ${merged} doppioni uniti, tutte sulla strada del bus`);
  return transport;
}
