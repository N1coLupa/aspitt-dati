import { getText } from './http.mjs';
import { stopKey } from './slug.mjs';

const USER_AGENT = 'Muevt/1.0 (app di mobilita per Altamura; ciao@muevt.it)';
const ON_STREET_M = 18;
const STEP_M = 8;

const PREFIXES = new Set([
  'via',
  'viale',
  'piazza',
  'largo',
  'corso',
  'vico',
  'vicolo',
  'strada',
  'contrada',
  'piazzale',
  'traversa',
  'fronte',
  'angolo',
  'civico',
]);

function projector(lat) {
  const kx = 111320 * Math.cos((lat * Math.PI) / 180);
  const ky = 110540;
  return {
    to: (p) => ({ x: p.lon * kx, y: p.lat * ky }),
    from: (x, y) => ({ lat: y / ky, lon: x / kx }),
  };
}

function segmentDistance(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function sampleShape(shape, proj) {
  const points = [];
  let s = 0;
  for (let i = 0; i < shape.length - 1; i += 1) {
    const a = proj.to(shape[i]);
    const b = proj.to(shape[i + 1]);
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(length / STEP_M));
    for (let k = 0; k < steps; k += 1) {
      const t = k / steps;
      points.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, s: s + length * t });
    }
    s += length;
  }
  if (shape.length) points.push({ ...proj.to(shape[shape.length - 1]), s });
  return points;
}

function streetTokens(text) {
  return stopKey(text)
    .split(' ')
    .filter((t) => t.length > 2 && !PREFIXES.has(t) && !/^\d+$/.test(t) && !['del', 'dei', 'della', 'delle', 'degli'].includes(t));
}

export function streetOfStop(name) {
  const text = String(name)
    .replace(/\(.*?\)/g, ' ')
    .replace(/\*/g, '')
    .trim();
  const start = /\b(via|viale|v\.le|piazza|p\.zza|largo|corso|vico|piazzale)\b/i.exec(text);
  let street = start ? text.slice(start.index) : /^[A-Z]\.\s*[A-Za-zÀ-ú]+/.test(text) ? text : null;
  if (!street) return null;
  street = street.split(/\s+(?:ang\.?|angolo)\s+|\s+-\s+|,|\s+fronte\b|\s+\d/i)[0];
  return streetTokens(street).length ? street.trim() : null;
}

export async function fetchStreets() {
  const query = '[out:json][timeout:120];area["name"="Altamura"]["admin_level"="8"]->.a;way["highway"]["name"](area.a);out tags geom;';
  const json = JSON.parse(
    await getText(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      timeout: 150000,
    })
  );
  return json.elements
    .filter((way) => way.geometry?.length > 1)
    .map((way) => ({ name: way.tags.name, tokens: streetTokens(way.tags.name), geometry: way.geometry }));
}

const ALIASES = { ii: 'due', iv: 'quattro', xx: 'venti' };
const kind = (text) => stopKey(text).split(' ')[0];

export function waysFor(street, streets) {
  const wanted = streetTokens(street).map((token) => ALIASES[token] ?? token);
  const scored = streets
    .filter((way) => wanted.every((token) => way.tokens.includes(token)))
    .map((way) => {
      const extra = stopKey(way.name)
        .split(' ')
        .filter((token) => !PREFIXES.has(token) && !wanted.includes(token)).length;
      return { way, score: extra + (kind(way.name) === kind(street.replace(/^p\.zza/i, 'piazza').replace(/^v\.le/i, 'viale')) ? 0 : 2) };
    });
  const best = Math.min(...scored.map((entry) => entry.score));
  return scored.filter((entry) => entry.score === best).map((entry) => entry.way);
}

// Distanza fra un punto e la via scritta nel nome della fermata ("Via Gravina 79" -> Via Gravina).
// null quando il nome non contiene una via o quella via non c'e' in OSM: in quel caso non si puo' dire nulla.
export function offStreetMeters(point, name, streets) {
  const street = streetOfStop(name);
  const ways = street ? waysFor(street, streets) : [];
  if (!ways.length || point?.lat == null) return null;
  const proj = projector(point.lat);
  const p = proj.to(point);
  let best = Infinity;
  for (const way of ways) {
    for (let n = 1; n < way.geometry.length; n += 1)
      best = Math.min(best, segmentDistance(p, proj.to(way.geometry[n - 1]), proj.to(way.geometry[n])));
  }
  return { meters: best, street: ways[0].name };
}

// Oltre questa distanza dalla propria via una posizione salvata o copiata da un'altra fermata e' sbagliata:
// il 20/09/2026 tre fermate del ritorno di Pescariello avevano preso le coordinate di Coseco, a 13 km.
export const MAX_OFF_STREET_M = 120;
// Le posizioni salvate a mano (fermate-posizioni.json) possono stare su un tratto che OSM non nomina:
// si scartano solo quando sono palesemente altrove.
const MAX_SAVED_OFF_STREET_M = 500;
const MAX_STREET_DETOUR_M = 1200;
const SAME_PASS_M = 20;
const MAX_CROSSING_FROM_ROUTE_M = 150;

// "Via Gravina ang. Via del Timo": la fermata sta all'incrocio delle due vie, che OSM conosce al metro.
export function crossingOf(name, streets) {
  const text = String(name).replace(/\(([^)]*)\)/g, ' $1 ');
  const first = streetOfStop(text);
  const second = /\b(?:ang\.?|angolo)\s+((?:via|viale|v\.le|piazza|p\.zza|largo|corso|vico|piazzale)?\s*[^,()*]+)/i.exec(text)?.[1];
  if (!first || !second) return null;
  const a = waysFor(first, streets);
  const b = waysFor(
    /^(via|viale|v\.le|piazza|p\.zza|largo|corso|vico|piazzale)\b/i.test(second.trim()) ? second.trim() : `Via ${second.trim()}`,
    streets
  );
  if (!a.length || !b.length) return null;
  const proj = projector(a[0].geometry[0].lat);
  let best = null;
  for (const wa of a) {
    for (const wb of b) {
      for (const pa of wa.geometry) {
        const p = proj.to(pa);
        for (let n = 1; n < wb.geometry.length; n += 1) {
          const d = segmentDistance(p, proj.to(wb.geometry[n - 1]), proj.to(wb.geometry[n]));
          if (!best || d < best.d) best = { d, point: pa, streets: `${wa.name} e ${wb.name}` };
        }
      }
    }
  }
  return best && best.d <= CROSSING_M ? { lat: best.point.lat, lon: best.point.lon, detail: `incrocio fra ${best.streets}` } : null;
}

const CROSSING_M = 25;
const MAX_FROM_CROSSING_M = 120;
// Due fermate con nomi diversi non stanno nello stesso punto: se una posizione salvata o copiata coincide
// con il segnaposto di un'altra fermata, e' un segnaposto duplicato nella mappa dell'operatore.
const SAME_POINT_M = 8;
// "Via Dei Mille 40" e "Via Dei Mille fronte 40", "(ang. Via II Giugno)" e "(fronte Via II Giugno)":
// stesso posto scritto in due modi, i due lati della stessa strada.
const placeKey = (name) =>
  stopKey(String(name).replace(/[()]/g, ' '))
    .split(' ')
    .filter((token) => token && !['fronte', 'ang', 'angolo', 'presso', 'pensilina', 'fermata', 'bus'].includes(token))
    .map((token) => ALIASES[token] ?? token)
    .join(' ');

function twinKey(name) {
  const street = streetOfStop(name);
  const number = /(\d{1,4})\s*[a-z]?\s*$/i.exec(
    String(name)
      .replace(/\(.*?\)/g, '')
      .trim()
  )?.[1];
  if (!street || !number) return null;
  return `${streetTokens(street)
    .map((token) => ALIASES[token] ?? token)
    .join(' ')}#${number}`;
}

export function computeStopPositions(transport, { streets = [], known: allKnown = {}, rejected = [] } = {}) {
  const result = new Map();

  // Un segnaposto dell'operatore con un incrocio nel nome che sta lontano da quell'incrocio e' stato
  // copiato da un'altra fermata (Via Gravina ang. Via del Timo era sull'incrocio con Via della Cicoriella).
  const misplaced = new Set();
  for (const stop of transport.lines.flatMap((line) => line.stops)) {
    if (stop.interpolated || stop.lat == null) continue;
    const crossing = crossingOf(stop.name, streets);
    if (crossing && Math.hypot((crossing.lat - stop.lat) * 110540, (crossing.lon - stop.lon) * 84300) > MAX_FROM_CROSSING_M) {
      if (!misplaced.has(stop)) rejected.push(`${stop.name}: segnaposto lontano da ${crossing.detail}, spostato sull'incrocio`);
      misplaced.add(stop);
      // Da qui in poi conta come fermata da posizionare: applyStopPositions la riscrive.
      stop.interpolated = true;
    }
  }
  const marker = (stop) => !stop.interpolated && stop.lat != null && !misplaced.has(stop);
  const markers = transport.lines.flatMap((line) => line.stops).filter(marker);
  const collision = (point, name) =>
    markers.find(
      (other) =>
        placeKey(other.name) !== placeKey(name) &&
        Math.hypot((other.lat - point.lat) * 110540, (other.lon - point.lon) * 84300) < SAME_POINT_M
    );

  // Un nome senza numero civico che e' l'inizio del nome di un solo segnaposto ("Hub Via Santeramo" e
  // "Hub Via Santeramo ang. Via Rocco Scotellaro") indica lo stesso posto.
  const sameNameMarker = (stop) => {
    const key = placeKey(stop.name);
    if (!key || /\d/.test(key) || key.split(' ').length < 3) return null;
    const found = markers.filter((other) => placeKey(other.name) !== key && placeKey(other.name).startsWith(`${key} `));
    const samePlace = found.every((other) => Math.hypot((other.lat - found[0].lat) * 110540, (other.lon - found[0].lon) * 84300) < 80);
    return found.length && samePlace ? found[0] : null;
  };

  const known = {};
  for (const [id, entry] of Object.entries(allKnown)) {
    const name = transport.lines.flatMap((line) => line.stops).find((stop) => stop.stopId === id)?.name ?? entry.nome ?? id;
    const off = offStreetMeters(entry, name, streets);
    if (off && off.meters > MAX_SAVED_OFF_STREET_M) {
      rejected.push(`${name}: posizione salvata a ${Math.round(off.meters)} m da ${off.street}, scartata e ricalcolata`);
      continue;
    }
    const twin = entry.fonte !== 'manuale' ? collision(entry, name) : null;
    if (twin) {
      rejected.push(`${name}: posizione salvata identica a quella di "${twin.name}", scartata e ricalcolata`);
      continue;
    }
    known[id] = entry;
  }

  const twins = new Map();
  for (const line of transport.lines) {
    for (const stop of line.stops) {
      const key = twinKey(stop.name);
      const exact = known[stop.stopId] ?? (marker(stop) ? stop : null);
      if (key && exact && !twins.has(key)) twins.set(key, { lat: exact.lat, lon: exact.lon, name: stop.name });
    }
  }

  for (const line of transport.lines) {
    if (!line.shape?.length || line.shape.length < 2) continue;
    const proj = projector(line.shape[0].lat);

    // Tracciato di sola andata (Pescariello): se dopo una fermata al capolinea ne vengono altre lontane da li',
    // il ritorno rifa' lo stesso tracciato al contrario. Prima si guardava solo l'ultima fermata nota: se era
    // anch'essa nota (Via Selva 117) il ritorno non veniva ricostruito e tutte le fermate del ritorno senza
    // coordinate finivano al capolinea, a 13 km dalla loro via.
    const isExact = (stop) => known[stop.stopId] || marker(stop);
    const start = proj.to(line.shape[0]);
    const end = proj.to(line.shape[line.shape.length - 1]);
    const fromEnd = (stop) => {
      const p = proj.to(known[stop.stopId] ?? stop);
      return Math.hypot(p.x - end.x, p.y - end.y);
    };
    const oneWay = Math.hypot(start.x - end.x, start.y - end.y) > 1500;
    const turn = line.stops.findIndex(
      (stop, i) => isExact(stop) && fromEnd(stop) < 1500 && line.stops.slice(i + 1).some((next) => isExact(next) && fromEnd(next) > 1500)
    );
    const returnLeg = oneWay && turn >= 0;
    const shape = returnLeg ? [...line.shape, ...[...line.shape].reverse().slice(1)] : line.shape;
    const samples = sampleShape(shape, proj);
    // Il primo passaggio utile, non il piu' vicino in assoluto: quando il tracciato ripassa per la
    // stessa via (andata e ritorno), il punto piu' vicino puo' stare sul ritorno per pochi centimetri
    // e trascinare tutte le fermate seguenti alla fine della linea.
    const nearestS = (point, fromS) => {
      const p = proj.to(point);
      const distances = samples.map((q) => (q.s < fromS ? Infinity : Math.hypot(q.x - p.x, q.y - p.y)));
      const min = Math.min(...distances);
      if (!Number.isFinite(min)) return fromS;
      const first = distances.findIndex((d) => d <= min + SAME_PASS_M);
      let k = first;
      while (k + 1 < samples.length && distances[k + 1] < distances[k]) k += 1;
      return samples[k].s;
    };
    const pointAt = (s) => {
      const q = samples.reduce((best, sample) => (Math.abs(sample.s - s) < Math.abs(best.s - s) ? sample : best), samples[0]);
      return proj.from(q.x, q.y);
    };

    let cursor = 0;
    const stops = line.stops.map((stop) => {
      const manual = known[stop.stopId];
      const exact = manual ?? (marker(stop) ? stop : null);
      if (exact) {
        cursor = nearestS(exact, cursor);
        return { stop, s: cursor, exact: { lat: exact.lat, lon: exact.lon } };
      }
      const prefixTwin = sameNameMarker(stop);
      if (prefixTwin) {
        cursor = nearestS(prefixTwin, cursor);
        return {
          stop,
          s: cursor,
          twin: { lat: prefixTwin.lat, lon: prefixTwin.lon, position: 'street', detail: `come "${prefixTwin.name}"` },
        };
      }
      const twin = twins.get(twinKey(stop.name));
      const twinOff = twin ? offStreetMeters(twin, stop.name, streets) : null;
      if (twin && twin.name !== stop.name && !(twinOff && twinOff.meters > MAX_OFF_STREET_M) && !collision(twin, stop.name)) {
        cursor = nearestS(twin, cursor);
        return { stop, s: cursor, twin: { lat: twin.lat, lon: twin.lon, position: 'street', detail: `di fronte a "${twin.name}"` } };
      }
      return { stop, s: null };
    });

    const total = samples[samples.length - 1].s;
    let i = 0;
    while (i < stops.length) {
      if (stops[i].s != null) {
        i += 1;
        continue;
      }
      let j = i;
      while (j < stops.length && stops[j].s == null) j += 1;
      const fromS = i > 0 ? stops[i - 1].s : 0;
      const toS = j < stops.length ? stops[j].s : total;
      const count = j - i;

      let lastS = fromS;
      for (let k = 0; k < count; k += 1) {
        const entry = stops[i + k];
        const expected = fromS + ((toS - fromS) * (k + 1)) / (count + 1);
        const street = streetOfStop(entry.stop.name);
        const ways = street ? waysFor(street, streets) : [];

        let chosen = null;
        const crossing = crossingOf(entry.stop.name, streets);
        if (crossing) {
          const p = proj.to(crossing);
          let near = null;
          for (const q of samples) {
            if (q.s <= lastS || q.s >= toS) continue;
            const d = Math.hypot(q.x - p.x, q.y - p.y);
            if (!near || d < near.d) near = { d, s: q.s };
          }
          // L'incrocio nominato vale anche lontano dal tracciato: i ritorni delle linee scuola passano per
          // strade che la mappa dell'operatore non disegna, e li' l'incrocio e' l'unico dato certo.
          entry.s = near && near.d <= MAX_CROSSING_FROM_ROUTE_M ? near.s : Math.max(lastS + 1, Math.min(toS - 1, (lastS + toS) / 2));
          entry.point = { lat: crossing.lat, lon: crossing.lon };
          entry.position = 'street';
          entry.detail = crossing.detail;
          lastS = entry.s;
          continue;
        }
        if (ways.length) {
          const segments = ways.flatMap((way) => way.geometry.slice(1).map((b, n) => [proj.to(way.geometry[n]), proj.to(b)]));
          for (const q of samples) {
            if (q.s <= lastS || q.s >= toS) continue;
            if (segments.some(([a, b]) => segmentDistance(q, a, b) <= ON_STREET_M)) {
              if (!chosen || Math.abs(q.s - expected) < Math.abs(chosen - expected)) chosen = q.s;
            }
          }
        }

        // Il tracciato disegnato non passa per la via della fermata (succede nei ritorni ricostruiti al
        // contrario): la fermata va comunque sulla sua via, nel punto piu' vicino al tratto fra le fermate
        // accanto, non a meta' strada lungo un tracciato che li' non passa.
        let onStreet = null;
        if (chosen == null && ways.length) {
          const window = samples.filter((q) => q.s > lastS && q.s < toS);
          for (const way of ways) {
            for (const point of way.geometry) {
              const p = proj.to(point);
              for (const q of window) {
                const d = Math.hypot(q.x - p.x, q.y - p.y);
                if (!onStreet || d < onStreet.d) onStreet = { d, s: q.s, point };
              }
            }
          }
          if (onStreet && onStreet.d > MAX_STREET_DETOUR_M) onStreet = null;
        }

        if (chosen != null) {
          entry.s = chosen;
          entry.position = 'street';
          entry.detail = `su ${ways[0].name}, lungo il percorso ${line.name}`;
        } else if (onStreet) {
          entry.s = Math.max(onStreet.s, lastS + 1);
          entry.point = { lat: onStreet.point.lat, lon: onStreet.point.lon };
          entry.position = 'street';
          entry.detail = `su ${ways[0].name}, dove passa piu' vicino al percorso ${line.name}`;
        } else {
          entry.s = Math.max(expected, lastS + 1);
          entry.position = 'estimated';
          entry.detail = street ? `${street} non trovata sul percorso ${line.name}` : `nessuna via nel nome`;
        }
        lastS = entry.s;
      }
      i = j;
    }

    for (const entry of stops) {
      const previous = result.get(entry.stop.stopId);
      const rank = { exact: 3, street: 2, estimated: 1 };
      const source = known[entry.stop.stopId];
      const next = entry.exact
        ? {
            ...entry.exact,
            position: 'exact',
            detail: source ? (source.dettaglio ?? (source.fonte === 'manuale' ? 'rilevata sul posto' : source.fonte)) : 'KML',
          }
        : (entry.twin ?? { ...(entry.point ?? pointAt(entry.s)), position: entry.position, detail: entry.detail });
      if (!previous || rank[next.position] > rank[previous.position]) result.set(entry.stop.stopId, next);
    }
  }

  return result;
}

export function applyStopPositions(transport, positions) {
  const round = (value) => +value.toFixed(6);
  for (const line of transport.lines) {
    for (const stop of line.stops) {
      const found = positions.get(stop.stopId);
      if (!found) continue;
      if (stop.interpolated || stop.lat == null) {
        stop.lat = round(found.lat);
        stop.lon = round(found.lon);
      }
      stop.position = found.position;
    }
  }
  for (const stop of transport.stops) {
    const found = positions.get(stop.id);
    if (!found) continue;
    stop.lat = round(found.lat);
    stop.lon = round(found.lon);
    stop.position = found.position;
  }
  return transport;
}

export function streetsFromCache(cache) {
  return (cache?.vie ?? []).map((way) => ({
    name: way.n,
    tokens: streetTokens(way.n),
    geometry: way.g.map(([lat, lon]) => ({ lat, lon })),
  }));
}
