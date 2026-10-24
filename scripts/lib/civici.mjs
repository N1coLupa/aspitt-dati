// Fermate con il numero civico nel nome ("Via Gravina 79", "Via Bari, 150", "Via Gravina (fronte 231)"):
// la posizione del civico ufficiale (ANNCSU) vince su un segnaposto lontano, come quando la mappa
// dell'operatore mette "Via Gravina 79" nello stesso punto di "Via Gravina 7".
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { waysFor } from './posizioni.mjs';

const CANDIDATES = ['../data/indirizzi-altamura.json', '../../src/dati/indirizzi.json'].map((file) =>
  fileURLToPath(new URL(file, import.meta.url))
);
const SCALE = 1e5;
const MOVE_OVER_M = 120;
const SNAP_WITHIN_M = 60;
const NEAR_NUMBERS = 6;

const ALIASES = { iv: 'quattro', xx: 'venti', xxiv: 'ventiquattro', ii: 'due', i: 'primo' };

const words = (text) =>
  String(text ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\bv\.\s?le\b/g, 'viale')
    .replace(/\bp\.\s?zza\b/g, 'piazza')
    .replace(/\bc\.\s?so\b/g, 'corso')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((word) => ALIASES[word] ?? word);

const meters = (a, b) => Math.hypot((a.lat - b.lat) * 110540, (a.lon - b.lon) * 84300);

export async function loadCivics() {
  for (const file of CANDIDATES) {
    try {
      const data = JSON.parse(await fs.readFile(file, 'utf8'));
      const streets = data.vie.map(([name]) => ({ name, words: words(name), numbers: new Map() }));
      for (const [street, number, lat, lon] of data.civici) {
        const digits = parseInt(number, 10);
        if (streets[street] && Number.isFinite(digits) && !streets[street].numbers.has(digits)) {
          streets[street].numbers.set(digits, { lat: lat / SCALE, lon: lon / SCALE });
        }
      }
      return streets;
    } catch {
      // Prova il percorso successivo: nel repository dei dati il file ha un altro posto.
    }
  }
  return [];
}

/** "Via Gravina (fronte 231)" -> { street: "Via Gravina", number: 231 }; null per incroci e nomi senza civico. */
export function streetAndNumber(name) {
  const text = String(name ?? '')
    .replace(/\*+$/, '')
    .trim();
  if (/\bang\b\.?|\bangolo\b|\|/i.test(text)) return null;
  const match =
    /^((?:via|viale|v\.\s?le|piazza|p\.\s?zza|corso|largo|vico)\s[^(,\d]+?)\s*(?:,|\(|\s)\s*(?:fronte\s+|civ\.?\s*|n\.?\s*)?(\d{1,4})(?![\d/])/i.exec(
      text
    );
  if (!match) return null;
  return { street: match[1].trim(), number: Number(match[2]) };
}

function findStreet(street, civics) {
  const wanted = words(street);
  if (!wanted.length) return null;
  const same = civics.filter((item) => item.words.join(' ') === wanted.join(' '));
  if (same.length === 1) return same[0];
  const wider = civics.filter((item) => item.words[0] === wanted[0] && wanted.every((word) => item.words.includes(word)));
  if (!wider.length) return null;
  const fewest = Math.min(...wider.map((item) => item.words.length));
  const best = wider.filter((item) => item.words.length === fewest);
  return best.length === 1 ? best[0] : null;
}

function civicPoint(street, number) {
  const exact = street.numbers.get(number);
  if (exact) return { ...exact, exact: true };
  let lower = null;
  let upper = null;
  for (const [value, point] of street.numbers) {
    if (value % 2 !== number % 2 || Math.abs(value - number) > NEAR_NUMBERS) continue;
    if (value < number && (!lower || value > lower.value)) lower = { value, point };
    if (value > number && (!upper || value < upper.value)) upper = { value, point };
  }
  if (lower && upper) {
    const t = (number - lower.value) / (upper.value - lower.value);
    return {
      lat: lower.point.lat + (upper.point.lat - lower.point.lat) * t,
      lon: lower.point.lon + (upper.point.lon - lower.point.lon) * t,
      exact: false,
    };
  }
  const near = lower ?? upper;
  return near ? { ...near.point, exact: false } : null;
}

function snapToStreet(point, streetName, ways) {
  let best = null;
  for (const way of waysFor(streetName, ways)) {
    for (let n = 1; n < way.geometry.length; n += 1) {
      const a = way.geometry[n - 1];
      const b = way.geometry[n];
      const dx = (b.lon - a.lon) * 84300;
      const dy = (b.lat - a.lat) * 110540;
      const length = dx * dx + dy * dy;
      const t = length ? Math.max(0, Math.min(1, ((point.lon - a.lon) * 84300 * dx + (point.lat - a.lat) * 110540 * dy) / length)) : 0;
      const candidate = { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
      const distance = meters(point, candidate);
      if (!best || distance < best.distance) best = { ...candidate, distance };
    }
  }
  return best && best.distance <= SNAP_WITHIN_M ? { lat: best.lat, lon: best.lon } : point;
}

/**
 * Posizioni dal numero civico per le fermate il cui segnaposto e' lontano dal civico del nome.
 * Le fermate misurate sul posto (fonte "manuale") e quelle fuori Altamura restano come sono.
 */
export function civicPositions(transport, { civics, ways, known = {}, notes = [] }) {
  const moved = new Map();
  if (!civics.length) return moved;
  for (const stop of transport.stops) {
    const entry = known[stop.id];
    if (entry?.fonte === 'manuale' || entry?.fuoriAltamura) continue;
    const parsed = streetAndNumber(stop.name);
    if (!parsed) continue;
    const street = findStreet(parsed.street, civics);
    const civic = street && civicPoint(street, parsed.number);
    if (!civic) continue;
    const target = snapToStreet(civic, street.name, ways);
    const away = stop.lat == null ? Infinity : meters(stop, target);
    if (away <= MOVE_OVER_M) continue;
    moved.set(stop.id, {
      lat: target.lat,
      lon: target.lon,
      position: 'exact',
      detail: `civico ${parsed.number} di ${street.name}${civic.exact ? '' : ' (fra i civici vicini)'}`,
    });
    notes.push(
      `${stop.name}: ${Number.isFinite(away) ? `segnaposto a ${Math.round(away)} m dal civico ${parsed.number}` : 'senza posizione'}, spostata sul civico`
    );
  }
  return moved;
}
