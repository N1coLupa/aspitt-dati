import fs from 'node:fs/promises';
import { plausibleDay, publishedOn } from './dates-it.mjs';
import path from 'node:path';
import { applyRoadShapes } from './forme-stradali.mjs';
import { applyStopPositions, computeStopPositions, streetsFromCache } from './posizioni.mjs';

const DATA = path.join('scripts', 'data');
const SPLIT_GAP_MIN = 60;
const TYPO_MIN = 5;

const readJson = async (file, fallback) => {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
};

const toMinutes = (time) => {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
};
const fromMinutes = (total) => `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;

export function validFromUrl(url) {
  const name = decodeURIComponent(
    String(url ?? '')
      .split('/')
      .pop() ?? ''
  );
  const matches = [...name.matchAll(/(\d{2})[-_.](\d{2})[-_.](\d{4})/g)];
  const last = matches[matches.length - 1];
  if (!last) return null;
  const [, day, month, year] = last;
  if (+month < 1 || +month > 12 || +day < 1 || +day > 31) return null;
  return plausibleDay(`${year}-${month}-${day}`, publishedOn(url));
}

export const isSchoolLine = (line) => /\bscuol/i.test(line.name) || line.id.startsWith('linea-scuola');

function fixTypos(trip, notes, lineName) {
  let previous = null;
  for (const stopTime of trip.stopTimes) {
    if (!stopTime.served || !stopTime.time) continue;
    const minutes = toMinutes(stopTime.time);
    if (previous != null && minutes < previous && previous - minutes <= TYPO_MIN) {
      notes.push(`${lineName}, ${trip.code}: fermata ${stopTime.index} alle ${stopTime.time} dopo le ${fromMinutes(previous)}, corretto`);
      stopTime.time = fromMinutes(previous);
      continue;
    }
    previous = minutes;
  }
}

function splitAtGaps(line, trip, notes) {
  const served = trip.stopTimes.map((st, pos) => ({ st, pos })).filter(({ st }) => st.served && st.time);
  for (let k = 1; k < served.length; k += 1) {
    const gap = toMinutes(served[k].st.time) - toMinutes(served[k - 1].st.time);
    if (gap <= SPLIT_GAP_MIN) continue;
    const cut = served[k].pos;
    const first = { ...trip, id: `${trip.id}-a`, stopTimes: trip.stopTimes.slice(0, cut).map((st) => ({ ...st })) };
    const second = {
      ...trip,
      id: `${trip.id}-b`,
      departure: served[k].st.time,
      stopTimes: trip.stopTimes.slice(cut).map((st) => ({ ...st })),
    };
    notes.push(`${line.name}, ${trip.code}: ${gap} minuti fra ${served[k - 1].st.time} e ${served[k].st.time}, divisa in due corse`);
    return [first, ...splitAtGaps(line, second, notes)];
  }
  return [trip];
}

const SPELLING_FIXES = [
  [/\bP\.\s?zza\b/gi, 'Piazza'],
  [/\bPensillina\b/gi, 'Pensilina'],
  [/\bCicorella\b/g, 'Cicoriella'],
  [/\bciv(?:ico|\.)\s*/gi, ''],
  [/\s+-\s+fronte\b/gi, ' fronte'],
  [/\s{2,}/g, ' '],
];

const SAME_STOP_METERS = 40;

const fixSpelling = (name) => SPELLING_FIXES.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), name).trim();

const spellingKey = (name) =>
  fixSpelling(name)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const metersBetween = (a, b) => Math.hypot((a.lat - b.lat) * 111_000, (a.lon - b.lon) * 84_000);

function unifyStopSpellings(transport, notes) {
  for (const stop of transport.stops) stop.name = fixSpelling(stop.name);
  for (const line of transport.lines) for (const stop of line.stops) stop.name = fixSpelling(stop.name);

  const groups = new Map();
  for (const stop of transport.stops) {
    const key = spellingKey(stop.name);
    groups.set(key, [...(groups.get(key) ?? []), stop]);
  }

  const replaced = new Map();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const ranked = [...group].sort((a, b) => b.lines.length - a.lines.length || a.id.localeCompare(b.id));
    const keep = ranked[0];
    for (const other of ranked.slice(1)) {
      if (keep.lat != null && other.lat != null && metersBetween(keep, other) > SAME_STOP_METERS) continue;
      replaced.set(other.id, keep);
      keep.lines = [...new Set([...keep.lines, ...other.lines])];
    }
  }
  if (!replaced.size) return;

  transport.stops = transport.stops.filter((stop) => !replaced.has(stop.id));
  for (const line of transport.lines) {
    for (const stop of line.stops) {
      const keep = replaced.get(stop.stopId);
      if (keep) {
        stop.stopId = keep.id;
        stop.name = keep.name;
      }
    }
    for (const trip of line.trips) {
      for (const stopTime of trip.stopTimes) {
        const keep = replaced.get(stopTime.stopId);
        if (keep) stopTime.stopId = keep.id;
      }
    }
  }
  notes.push(`unificate ${replaced.size} fermate scritte in modo diverso: ${[...replaced.keys()].join(', ')}`);
}

export async function enrichTransport(transport, notes = []) {
  const escluse = new Set(((await readJson(path.join(DATA, 'linee-escluse.json'), null))?.linee ?? []).map((voce) => voce.id));
  if (escluse.size) {
    const prima = transport.lines.length;
    transport.lines = transport.lines.filter((line) => !escluse.has(line.id));
    if (transport.lines.length !== prima) {
      const restano = new Set(transport.lines.flatMap((line) => line.stops.map((stop) => stop.stopId)));
      const fermatePrima = transport.stops.length;
      transport.stops = transport.stops
        .filter((stop) => restano.has(stop.id))
        .map((stop) => ({ ...stop, lines: stop.lines.filter((id) => !escluse.has(id)) }));
      notes.push(
        `escluse ${prima - transport.lines.length} linee e ${fermatePrima - transport.stops.length} fermate (scripts/data/linee-escluse.json)`
      );
    }
  }

  const calendar = await readJson(path.join(DATA, 'calendario.json'), null);
  if (calendar) {
    transport.calendar = { localHolidays: calendar.festiviLocali ?? [], schoolYears: calendar.scuola ?? [] };
  }

  for (const line of transport.lines) {
    line.school = isSchoolLine(line);
    line.validFrom = validFromUrl(line.timetableFile ?? line.timetableUrl);
    for (const trip of line.trips) fixTypos(trip, notes, line.name);
    line.trips = line.trips.flatMap((trip) => splitAtGaps(line, trip, notes));
  }

  unifyStopSpellings(transport, notes);

  const streets = streetsFromCache(await readJson(path.join(DATA, 'vie-altamura.json'), null));
  const manual = (await readJson(path.join(DATA, 'fermate-posizioni.json'), {})).fermate ?? {};
  applyStopPositions(transport, computeStopPositions(transport, { streets, known: manual }));
  const estimated = transport.stops.filter((stop) => stop.position === 'estimated').map((stop) => stop.name);
  if (estimated.length) notes.push(`posizione solo stimata, da verificare sul posto: ${estimated.join(', ')}`);

  await applyRoadShapes(transport, path.join(DATA, 'forme-stradali.json'), notes);

  return transport;
}
