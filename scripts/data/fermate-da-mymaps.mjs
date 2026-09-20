// Coordinate delle fermate dalle mappe MyMaps dell'operatore.
//
// Nell'esportazione KML alcuni segnaposto hanno solo l'indirizzo scritto: le
// coordinate le calcola Google mentre disegna la mappa, e non finiscono nel
// file. La pagina della mappa pero' le contiene gia' calcolate, ed e' quello
// che l'operatore mostra come posizione ufficiale delle sue fermate.
//
// Questo script le legge una volta sola e le salva in
// scripts/data/fermate-posizioni.json come "fonte": "mymaps". Da li' le usa lo
// scraper a ogni aggiornamento, senza ripassare da Google: va rilanciato solo
// quando l'operatore cambia le mappe.
//
//   node scripts/data/fermate-da-mymaps.mjs
//
// Le voci con "fonte": "manuale" (misurate sul posto) non vengono toccate.

import fs from 'node:fs/promises';
import path from 'node:path';
import { getText, sleep } from '../lib/http.mjs';
import { stopKey } from '../lib/slug.mjs';

const DATA_DIR = process.env.MUEVT_DATA_DIR ?? path.join('src', 'dati');
const OUT = path.join('scripts', 'data', 'fermate-posizioni.json');
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/** Nella pagina ogni segnaposto e' "[lat,lon],[0,-128],\"id\"],[[\"Nome\"]]". */
const PLACEMARK = /\[(-?\d+\.\d+),(-?\d+\.\d+)\],\[0,-128\],\\"[0-9A-F]+\\"\],\[\[\\"((?:[^"\\]|\\.)*?)\\"\]\]/g;

function placemarksOf(html) {
  const found = new Map();
  for (const match of html.matchAll(PLACEMARK)) {
    const name = match[3].replace(/\\\\u([0-9a-f]{4})/gi, (_, code) => String.fromCharCode(parseInt(code, 16))).replace(/\\\\"/g, '"');
    const lat = Number(match[1]);
    const lon = Number(match[2]);
    if (Number.isFinite(lat) && Number.isFinite(lon) && name) found.set(stopKey(name), { name, lat, lon });
  }
  return found;
}

const numbersOf = (name) => (stopKey(name).match(/\d{1,4}/g) ?? []).sort().join(' ');

/**
 * Chiave uguale, altrimenti parole in comune. I civici devono coincidere:
 * senza questo controllo "Via Gravina 155" finiva su "Via Gravina 79", che
 * nella stessa via sta a un chilometro e mezzo.
 */
function matchStop(name, placemarks) {
  const exact = placemarks.get(stopKey(name));
  if (exact) return { ...exact, score: 1 };

  const wanted = new Set(
    stopKey(name)
      .split(' ')
      .filter((word) => word.length > 2)
  );
  let best = null;
  for (const entry of placemarks.values()) {
    const other = new Set(
      stopKey(entry.name)
        .split(' ')
        .filter((word) => word.length > 2)
    );
    if (numbersOf(entry.name) !== numbersOf(name)) continue;
    const shared = [...wanted].filter((word) => other.has(word)).length;
    const score = shared / Math.max(wanted.size, other.size, 1);
    if (!best || score > best.score) best = { ...entry, score };
  }
  return best && best.score >= 0.6 ? best : null;
}

const transport = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'transport.json'), 'utf8'));
const file = JSON.parse(await fs.readFile(OUT, 'utf8'));
const fermate = { ...(file.fermate ?? {}) };

let trovate = 0;
let mancanti = 0;
for (const line of transport.lines) {
  const mid = /[?&]mid=([^&]+)/.exec(line.mapUrl ?? '')?.[1];
  if (!mid) {
    console.log(`> ${line.name}: nessuna mappa`);
    continue;
  }

  const html = await getText(`https://www.google.com/maps/d/viewer?mid=${mid}`, { headers: { 'User-Agent': USER_AGENT } });
  const placemarks = placemarksOf(html);
  process.stdout.write(`> ${line.name}: ${placemarks.size} segnaposto`);

  let nuove = 0;
  for (const stop of line.stops) {
    // Le fermate che il KML posiziona gia' non si toccano: quelle coordinate
    // arrivano dalla stessa mappa, senza passare da un abbinamento per nome.
    if (!stop.interpolated || fermate[stop.stopId]?.fonte === 'manuale') continue;
    const match = matchStop(stop.name, placemarks);
    if (!match) {
      if (!fermate[stop.stopId]) mancanti += 1;
      continue;
    }
    const before = fermate[stop.stopId];
    fermate[stop.stopId] = {
      nome: stop.name,
      lat: +match.lat.toFixed(7),
      lon: +match.lon.toFixed(7),
      fonte: 'mymaps',
      dettaglio: `segnaposto "${match.name}" nella mappa di ${line.name}`,
    };
    if (!before) nuove += 1;
    trovate += 1;
  }
  console.log(`, ${nuove} fermate nuove posizionate`);
  await sleep(700);
}

file.fermate = Object.fromEntries(Object.entries(fermate).sort(([a], [b]) => a.localeCompare(b)));
file.aggiornato = new Date().toISOString().slice(0, 10);
await fs.writeFile(OUT, `${JSON.stringify(file, null, 2)}\n`);
console.log(`\n${trovate} corrispondenze, ${mancanti} fermate senza segnaposto; scritto ${OUT}`);
