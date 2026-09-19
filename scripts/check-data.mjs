// Controllo di sanità sui dati generati dagli scraper.
//
// Serve a impedire che una modifica al sito dell'operatore, un PDF illeggibile
// o un feed vuoto finiscano nell'app come "nessuna corsa in programma". Se una
// di queste condizioni non regge, l'aggiornamento va fermato e i dati del
// giorno prima restano validi.
//
// Uso: node scripts/check-data.mjs
// Le funzioni `validate*` sono usate anche da run-daily.mjs per decidere, fonte
// per fonte, se i dati nuovi sono buoni o se tenere quelli del giorno prima.

import fs from 'node:fs/promises';
import path from 'node:path';

const DATA_DIR = process.env.MUEVT_DATA_DIR ?? path.join('src', 'dati');

let problems = [];
let notes = [];

const fail = (message) => problems.push(message);
const note = (message) => notes.push(message);

/** Esegue un controllo e restituisce i problemi trovati, senza toccare lo stato globale. */
function collect(check, data) {
  const savedProblems = problems;
  const savedNotes = notes;
  problems = [];
  notes = [];
  try {
    check(data);
    return { problems, notes };
  } catch (err) {
    return { problems: [`struttura non valida: ${err.message}`], notes: [] };
  } finally {
    problems = savedProblems;
    notes = savedNotes;
  }
}

export const validateTransport = (data) => collect(checkTransport, data);
export const validateEvents = (data) => collect(checkEvents, data);
export const validatePlaces = (data) => collect(checkPlaces, data);

async function readJson(name) {
  return JSON.parse(await fs.readFile(path.join(DATA_DIR, name), 'utf8'));
}

function checkTransport(data) {
  if (data.lines.length < 8) fail(`solo ${data.lines.length} linee: attese almeno 8`);
  if (data.stops.length < 100) fail(`solo ${data.stops.length} fermate: attese almeno 100`);
  if (!data.vendors.length) fail('nessun punto vendita');

  const located = data.stops.filter((stop) => stop.lat != null).length;
  const ratio = located / Math.max(data.stops.length, 1);
  if (ratio < 0.8) fail(`solo il ${Math.round(ratio * 100)}% delle fermate ha coordinate`);

  const withTrips = data.lines.filter((line) => line.trips.length);
  if (withTrips.length < data.lines.length - 2) {
    fail(`${data.lines.length - withTrips.length} linee senza nemmeno una corsa`);
  }

  for (const line of data.lines) {
    if (!line.trips.length) {
      note(`${line.name}: nessuna corsa importata`);
      continue;
    }
    // Ogni corsa deve avere un orario per almeno metà delle fermate: se il
    // parser della griglia va fuori asse, il sintomo è proprio questo.
    const broken = line.trips.filter((trip) => trip.stopTimes.filter((st) => st.served).length < line.stops.length * 0.4);
    if (broken.length > line.trips.length / 2) {
      fail(`${line.name}: ${broken.length}/${line.trips.length} corse quasi vuote`);
    }

    const outOfOrder = line.trips.filter((trip) => {
      const times = trip.stopTimes.filter((st) => st.time).map((st) => st.time);
      return times.some((time, index) => index > 0 && time < times[index - 1] && time > '04:00');
    });
    if (outOfOrder.length) {
      note(`${line.name}: ${outOfOrder.length} corse con orari non crescenti (possibile corsa a cavallo della mezzanotte)`);
    }
    if (line.timetableUrl && !line.validFrom) note(`${line.name}: data di validita' non leggibile dal nome del PDF`);
  }

  // Il calendario scolastico va aggiunto a mano ogni anno: se manca quello
  // dell'anno che sta per cominciare, le linee Scuola resterebbero spente.
  const years = data.calendar?.schoolYears ?? [];
  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 45 * 86400000).toISOString().slice(0, 10);
  if (data.calendar && !years.some((year) => year.fine >= soon) && soon.slice(5) >= '08-01') {
    note(`calendario scolastico da aggiornare: nessun anno dopo il ${years.map((y) => y.fine).sort().pop() ?? today} (scripts/data/calendario.json)`);
  }
  const estimated = data.stops.filter((stop) => stop.position === 'estimated');
  if (estimated.length) note(`${estimated.length} fermate con posizione solo stimata: ${estimated.map((s) => s.name).join(', ')}`);
}

function checkEvents(data) {
  if (!data.events.length) note('nessun evento in agenda: può essere normale fuori stagione');
  const dated = data.events.filter((event) => event.dated).length;
  if (data.events.length > 5 && dated === 0) {
    fail('nessun evento con una data riconosciuta: il parser delle date è rotto');
  }
  for (const event of data.events) {
    if (!event.url?.startsWith('http')) fail(`evento senza link valido: ${event.title}`);
  }
}

function checkPlaces(data) {
  if (data.places.length < 40) fail(`solo ${data.places.length} luoghi: attesi almeno 40`);
  if (!data.places.some((place) => place.highlight)) fail('nessun luogo in evidenza');

  const outside = data.places.filter((place) => place.lat < 40.6 || place.lat > 41.1 || place.lon < 16.2 || place.lon > 16.9);
  if (outside.length) fail(`${outside.length} luoghi fuori dal territorio di Altamura`);
}

async function main() {
  const transport = await readJson('transport.json');
  const events = await readJson('events.json');
  const places = await readJson('places.json');

  checkTransport(transport);
  checkEvents(events);
  checkPlaces(places);

  // Orari vecchi non sono un errore: se il sito dell'operatore blocca lo
  // scaricamento si tengono gli ultimi validi. Lo si segnala e basta.
  const age = (Date.now() - new Date(transport.generatedAt).getTime()) / 3600000;
  if (age > 48) note(`i dati dei trasporti hanno ${Math.round(age)} ore (tenuti gli ultimi validi)`);

  console.log('Controllo dati Muevt');
  console.log(`  linee ${transport.lines.length}, fermate ${transport.stops.length}`);
  console.log(`  eventi ${events.events.length}, luoghi ${places.places.length}`);

  if (notes.length) {
    console.log('\nSegnalazioni:');
    for (const message of notes) console.log(`  - ${message}`);
  }

  if (problems.length) {
    console.error('\nControllo fallito:');
    for (const message of problems) console.error(`  x ${message}`);
    process.exitCode = 1;
    return;
  }

  console.log('\nTutti i controlli superati.');
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());

if (invokedDirectly) {
  main().catch((err) => {
    console.error('Controllo non eseguibile:', err.message);
    process.exitCode = 1;
  });
}
