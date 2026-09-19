// Aggiorna la copia locale delle vie di Altamura (da OpenStreetMap) e mostra
// dove finiscono le fermate che MyMaps lascia senza coordinate.
//
// Lo scraper applica le posizioni a ogni aggiornamento usando la copia locale
// (scripts/data/vie-altamura.json), quindi questo script serve solo quando
// cambiano le vie o si vuole rivedere il resoconto:
//
//   node scripts/data/posiziona-fermate.mjs
//
// Per correggere una fermata dopo un sopralluogo si scrive in
// scripts/data/fermate-posizioni.json, sotto "fermate", l'id della fermata con
// lat e lon misurate: vince su qualunque calcolo.

import fs from 'node:fs/promises';
import path from 'node:path';
import { computeStopPositions, fetchStreets } from '../lib/posizioni.mjs';

const DATA_DIR = process.env.MUEVT_DATA_DIR ?? path.join('src', 'dati');
export const STREETS_FILE = path.join('scripts', 'data', 'vie-altamura.json');
export const MANUAL_FILE = path.join('scripts', 'data', 'fermate-posizioni.json');

const transport = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'transport.json'), 'utf8'));
const manual = JSON.parse(await fs.readFile(MANUAL_FILE, 'utf8')).fermate ?? {};

console.log('> vie di Altamura da OpenStreetMap');
const streets = await fetchStreets();
const compact = streets.map((way) => ({ n: way.name, g: way.geometry.map((p) => [+p.lat.toFixed(6), +p.lon.toFixed(6)]) }));
await fs.writeFile(
  STREETS_FILE,
  `${JSON.stringify({ fonte: '© contributori OpenStreetMap, ODbL', aggiornato: new Date().toISOString().slice(0, 10), vie: compact })}\n`
);
console.log(`  ${streets.length} tratti di strada salvati in ${STREETS_FILE}`);

const positions = computeStopPositions(transport, { streets, known: manual });
const counts = { exact: 0, street: 0, estimated: 0 };
const pending = [];
for (const [stopId, found] of positions) {
  counts[found.position] += 1;
  if (found.position !== 'exact') pending.push({ stopId, ...found });
}
console.log(`\nFermate: ${counts.exact} esatte, ${counts.street} sulla via giusta, ${counts.estimated} solo stimate\n`);
for (const entry of pending.sort((a, b) => a.position.localeCompare(b.position))) {
  const name = transport.stops.find((stop) => stop.id === entry.stopId)?.name ?? entry.stopId;
  console.log(`  ${entry.position === 'street' ? 'via ' : 'STIMA'}  ${name}  (${entry.detail})`);
}
