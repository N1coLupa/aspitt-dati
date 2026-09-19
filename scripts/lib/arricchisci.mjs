// Pulizia e completamento dei dati dei trasporti, dopo lo scrape.
//
// Lo scrape riporta quello che l'operatore pubblica; qui si aggiunge quello che
// serve all'app per non sbagliare e si correggono gli errori noti dei PDF:
//   - calendario del servizio (festivi locali, anno scolastico);
//   - linee scolastiche, che girano solo nei giorni di lezione;
//   - data da cui vale ogni quadro orario, letta dal nome del PDF;
//   - corse che il PDF mette in un'unica colonna ma sono due (andata al mattino,
//     ritorno ore dopo): spezzate, altrimenti il pianificatore propone un
//     "viaggio" di sette ore;
//   - orari che tornano indietro di un minuto per un refuso del quadro;
//   - posizione delle fermate che MyMaps lascia senza coordinate.
//
// E' idempotente: si puo' applicare ai dati appena scaricati o a quelli di ieri.

import fs from 'node:fs/promises';
import path from 'node:path';
import { applyStopPositions, computeStopPositions, streetsFromCache } from './posizioni.mjs';

const DATA = path.join('scripts', 'data');
/** Oltre quest'attesa fra due fermate consecutive, sono due corse diverse. */
const SPLIT_GAP_MIN = 60;
/** Un orario che torna indietro al massimo di tanto e' un refuso, non un'altra corsa. */
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

/** "..._Orari_Ospedale-1-31-03-2026.pdf" -> "2026-03-31". */
export function validFromUrl(url) {
  const name = decodeURIComponent(String(url ?? '').split('/').pop() ?? '');
  const matches = [...name.matchAll(/(\d{2})[-_.](\d{2})[-_.](\d{4})/g)];
  const last = matches[matches.length - 1];
  if (!last) return null;
  const [, day, month, year] = last;
  if (+month < 1 || +month > 12 || +day < 1 || +day > 31) return null;
  return `${year}-${month}-${day}`;
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
    const part = (keep) =>
      trip.stopTimes.map((st, pos) => (keep(pos) ? { ...st } : { ...st, time: null, served: false }));
    const first = { ...trip, id: `${trip.id}-a`, stopTimes: part((pos) => pos < cut) };
    const second = { ...trip, id: `${trip.id}-b`, departure: served[k].st.time, stopTimes: part((pos) => pos >= cut) };
    notes.push(`${line.name}, ${trip.code}: ${gap} minuti fra ${served[k - 1].st.time} e ${served[k].st.time}, divisa in due corse`);
    // La seconda meta' puo' avere a sua volta un buco.
    return [first, ...splitAtGaps(line, second, notes)];
  }
  return [trip];
}

/**
 * Applica calendario, validita', correzioni e posizioni. `notes` raccoglie
 * quello che e' stato corretto, per il resoconto dell'aggiornamento.
 */
export async function enrichTransport(transport, notes = []) {
  const calendar = await readJson(path.join(DATA, 'calendario.json'), null);
  if (calendar) {
    transport.calendar = { localHolidays: calendar.festiviLocali ?? [], schoolYears: calendar.scuola ?? [] };
  }

  for (const line of transport.lines) {
    line.school = isSchoolLine(line);
    line.validFrom = validFromUrl(line.timetableUrl);
    for (const trip of line.trips) fixTypos(trip, notes, line.name);
    // Una corsa gia' divisa ha id che finisce in -a/-b e non ha piu' buchi.
    line.trips = line.trips.flatMap((trip) => splitAtGaps(line, trip, notes));
  }

  const streets = streetsFromCache(await readJson(path.join(DATA, 'vie-altamura.json'), null));
  const manual = (await readJson(path.join(DATA, 'fermate-posizioni.json'), {})).fermate ?? {};
  applyStopPositions(transport, computeStopPositions(transport, { streets, known: manual }));
  const estimated = transport.stops.filter((stop) => stop.position === 'estimated').map((stop) => stop.name);
  if (estimated.length) notes.push(`posizione solo stimata, da verificare sul posto: ${estimated.join(', ')}`);

  return transport;
}
