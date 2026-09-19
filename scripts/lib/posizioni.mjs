// Posizione delle fermate che il KML di MyMaps lascia senza coordinate.
//
// MyMaps geocodifica quei segnaposto per indirizzo e l'export non riporta il
// punto. Sappiamo pero' tre cose: l'ordine delle fermate, il percorso della
// linea e la via scritta nel nome della fermata. La fermata sta dove il
// percorso passa su quella via, dopo la fermata precedente e prima della
// successiva. Quando la via non si trova (nomi come "Coseco" o "OSPEDALE"), la
// fermata resta una stima distribuita lungo il percorso fra le due vicine.
//
// Ogni fermata esce con `position`:
//   exact     coordinate del KML o rilevate sul posto (scripts/data/fermate-posizioni.json);
//   street    sulla via giusta, fra le fermate giuste: approssimata di qualche decina di metri;
//   estimated solo stimata lungo il percorso, da verificare.

import { getText } from './http.mjs';
import { stopKey } from './slug.mjs';

const USER_AGENT = 'Muevt/1.0 (app di mobilita per Altamura; ciao@muevt.it)';
/** Distanza massima fra percorso e via perche' il bus "passi" su quella via. */
const ON_STREET_M = 18;
/** Passo di campionamento del percorso. */
const STEP_M = 8;

const PREFIXES = new Set(['via', 'viale', 'piazza', 'largo', 'corso', 'vico', 'vicolo', 'strada', 'contrada', 'piazzale', 'traversa', 'fronte', 'angolo', 'civico']);

/* ------------------------------------------------------------ Geometria */

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

/** Il percorso ricampionato ogni STEP_M metri, con la distanza progressiva. */
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

/* ------------------------------------------------------------------ Vie */

/** Le parole che identificano una via: "Via A. Di Crollalanza" -> ["crollalanza"]. */
function streetTokens(text) {
  return stopKey(text)
    .split(' ')
    .filter((t) => t.length > 2 && !PREFIXES.has(t) && !/^\d+$/.test(t) && !['del', 'dei', 'della', 'delle', 'degli'].includes(t));
}

/** La via scritta nel nome di una fermata, se c'e'. */
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

/** Numeri romani scritti in lettere su OSM ("Via IV Novembre" = "Via Quattro Novembre"). */
const ALIASES = { ii: 'due', iv: 'quattro', xx: 'venti' };
const kind = (text) => stopKey(text).split(' ')[0];

/**
 * I tratti OSM della via di una fermata. Fra i nomi che contengono tutte le
 * parole cercate vince quello con meno parole in piu' e con lo stesso tipo
 * (via, viale, piazza): "Viale Martiri" e' "Viale Martiri 1799", non "Via
 * Martiri 11 Settembre 2001"; "Via Matera" non e' la Statale 99 di Matera.
 */
function waysFor(street, streets) {
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

/** "Via Parisi - fronte civico 66" e "Via Parisi, 66" -> "parisi#66". */
function twinKey(name) {
  const street = streetOfStop(name);
  const number = /(\d{1,4})\s*[a-z]?\s*$/i.exec(String(name).replace(/\(.*?\)/g, '').trim())?.[1];
  if (!street || !number) return null;
  return `${streetTokens(street)
    .map((token) => ALIASES[token] ?? token)
    .join(' ')}#${number}`;
}

/* ------------------------------------------------------------ Calcolo */

/**
 * Posizioni per le fermate di tutte le linee. `known` sono le fermate gia'
 * rilevate a mano (stopId -> {lat, lon}); `streets` le vie di OSM.
 * Restituisce stopId -> { lat, lon, position, detail }.
 */
export function computeStopPositions(transport, { streets = [], known = {} } = {}) {
  const result = new Map();

  // La stessa fermata sui due lati della strada ha nomi diversi ("Via Parisi,
  // 66" all'andata, "Via Parisi - fronte civico 66" al ritorno): stessa via e
  // stesso civico, e' di fronte. Se una delle due ha le coordinate, vale per
  // entrambe.
  const twins = new Map();
  for (const line of transport.lines) {
    for (const stop of line.stops) {
      const key = twinKey(stop.name);
      const exact = known[stop.stopId] ?? (!stop.interpolated && stop.lat != null ? stop : null);
      if (key && exact && !twins.has(key)) twins.set(key, { lat: exact.lat, lon: exact.lon, name: stop.name });
    }
  }

  for (const line of transport.lines) {
    if (!line.shape?.length || line.shape.length < 2) continue;
    const proj = projector(line.shape[0].lat);

    // Alcune mappe MyMaps disegnano solo l'andata (Pescariello: fino alla zona
    // industriale). Se dopo l'ultima fermata nota, gia' al capolinea, ci sono
    // ancora fermate, e' il ritorno: stesso percorso fatto al contrario.
    const isExact = (stop) => known[stop.stopId] || (!stop.interpolated && stop.lat != null);
    const lastExact = line.stops.findLastIndex(isExact);
    const end = proj.to(line.shape[line.shape.length - 1]);
    const lastPoint = lastExact >= 0 ? proj.to(known[line.stops[lastExact].stopId] ?? line.stops[lastExact]) : null;
    const returnLeg = lastPoint && lastExact < line.stops.length - 1 && Math.hypot(lastPoint.x - end.x, lastPoint.y - end.y) < 1500;
    const shape = returnLeg ? [...line.shape, ...[...line.shape].reverse().slice(1)] : line.shape;
    const samples = sampleShape(shape, proj);
    const nearestS = (point, fromS) => {
      const p = proj.to(point);
      let best = null;
      for (const q of samples) {
        if (q.s < fromS) continue;
        const d = Math.hypot(q.x - p.x, q.y - p.y);
        if (!best || d < best.d) best = { s: q.s, d };
      }
      return best?.s ?? fromS;
    };
    const pointAt = (s) => {
      const q = samples.reduce((best, sample) => (Math.abs(sample.s - s) < Math.abs(best.s - s) ? sample : best), samples[0]);
      return proj.from(q.x, q.y);
    };

    // Ancore: fermate con coordinate vere, in ordine lungo il percorso.
    let cursor = 0;
    const stops = line.stops.map((stop) => {
      const manual = known[stop.stopId];
      const exact = manual ?? (!stop.interpolated && stop.lat != null ? stop : null);
      if (exact) {
        cursor = nearestS(exact, cursor);
        return { stop, s: cursor, exact: { lat: exact.lat, lon: exact.lon } };
      }
      const twin = twins.get(twinKey(stop.name));
      if (twin && twin.name !== stop.name) {
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
      // Un tratto di fermate senza posizione fra due ancore (o i capi del percorso).
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
        if (ways.length) {
          const segments = ways.flatMap((way) => way.geometry.slice(1).map((b, n) => [proj.to(way.geometry[n]), proj.to(b)]));
          for (const q of samples) {
            if (q.s <= lastS || q.s >= toS) continue;
            if (segments.some(([a, b]) => segmentDistance(q, a, b) <= ON_STREET_M)) {
              if (!chosen || Math.abs(q.s - expected) < Math.abs(chosen - expected)) chosen = q.s;
            }
          }
        }

        if (chosen != null) {
          entry.s = chosen;
          entry.position = 'street';
          entry.detail = `su ${ways[0].name}, lungo il percorso ${line.name}`;
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
      const next = entry.exact
        ? { ...entry.exact, position: 'exact', detail: known[entry.stop.stopId] ? 'rilevata sul posto' : 'KML' }
        : (entry.twin ?? { ...pointAt(entry.s), position: entry.position, detail: entry.detail });
      // Una fermata servita da piu' linee prende la posizione migliore trovata.
      if (!previous || rank[next.position] > rank[previous.position]) result.set(entry.stop.stopId, next);
    }
  }

  return result;
}

/** Scrive le posizioni nei dati: fermate delle linee e anagrafica fermate. */
export function applyStopPositions(transport, positions) {
  const round = (value) => +value.toFixed(6);
  for (const line of transport.lines) {
    for (const stop of line.stops) {
      const found = positions.get(stop.stopId);
      if (!found) continue;
      // Le coordinate che il KML di questa linea da' davvero restano sue.
      if (stop.interpolated || stop.lat == null) {
        stop.lat = round(found.lat);
        stop.lon = round(found.lon);
      }
      // `interpolated` resta quello dello scrape (coordinate assenti nel KML di
      // questa linea): e' cio' che rende il calcolo ripetibile.
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

/** Le vie salvate in scripts/data/vie-altamura.json, nella forma di fetchStreets. */
export function streetsFromCache(cache) {
  return (cache?.vie ?? []).map((way) => ({ name: way.n, tokens: streetTokens(way.n), geometry: way.g.map(([lat, lon]) => ({ lat, lon })) }));
}
