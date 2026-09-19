// Aggiornamento quotidiano dei dati dell'app.
//
// Va lanciato dopo l'ultima corsa della giornata (indicativamente alle 23:30):
// a quell'ora il sito dell'operatore ha gia' pubblicato eventuali avvisi per il
// giorno dopo, e nessun utente sta consultando orari che cambierebbero sotto i
// suoi occhi.
//
//   node scripts/scrapers/run-daily.mjs
//
// Confronta il risultato con lo snapshot del giorno prima e produce
// src/dati/alerts.json: e' quello che l'app mostra in cima a Trasporti quando
// una fermata viene soppressa o un orario cambia.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validateEvents, validatePlaces, validateTransport } from '../check-data.mjs';
import { scrapeTransport } from './transport.mjs';
import { scrapeEvents } from './events.mjs';
import { scrapePlaces } from './places.mjs';
import { enrichTransport } from '../lib/arricchisci.mjs';
import { COPY_DIR, usage, writeMissingList } from '../lib/copia-locale.mjs';

// Nel repository dei dati la cartella e' diversa: la sceglie la variabile d'ambiente.
const DATA_DIR = process.env.MUEVT_DATA_DIR ?? path.join('src', 'dati');
const SNAPSHOT_DIR = process.env.MUEVT_SNAPSHOT_DIR ?? path.join('data', 'snapshots');

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2));
}

// Per ogni linea, quante corse saltano ciascuna fermata.
function suppressionMap(transport) {
  const map = new Map();
  for (const line of transport.lines) {
    for (const trip of line.trips) {
      for (const stopTime of trip.stopTimes) {
        if (stopTime.served || !stopTime.stopId) continue;
        const key = `${line.id}::${stopTime.stopId}`;
        const entry = map.get(key) ?? {
          lineId: line.id,
          lineName: line.name,
          stopId: stopTime.stopId,
          stopName: line.stops.find((s) => s.stopId === stopTime.stopId)?.name ?? stopTime.stopId,
          trips: [],
        };
        entry.trips.push(trip.code);
        map.set(key, entry);
      }
    }
  }
  return map;
}

function diffTransport(previous, next) {
  const alerts = [];
  const now = new Date().toISOString();

  if (!previous) {
    return [
      {
        id: 'primo-avvio',
        severity: 'info',
        title: 'Dati caricati per la prima volta',
        body: `Sono state importate ${next.lines.length} linee e ${next.stops.length} fermate.`,
        createdAt: now,
      },
    ];
  }

  const previousLines = new Map(previous.lines.map((l) => [l.id, l]));

  for (const line of next.lines) {
    const before = previousLines.get(line.id);

    if (!before) {
      alerts.push({
        id: `linea-nuova-${line.id}`,
        severity: 'info',
        lineId: line.id,
        title: `Nuova linea: ${line.name}`,
        body: line.route ?? 'Percorso disponibile nella scheda della linea.',
        createdAt: now,
      });
      continue;
    }

    if (before.timetableUrl !== line.timetableUrl) {
      alerts.push({
        id: `orari-${line.id}-${now.slice(0, 10)}`,
        severity: 'warning',
        lineId: line.id,
        title: `Orari aggiornati: ${line.name}`,
        body: 'L’operatore ha pubblicato un nuovo quadro orario. Controlla le partenze prima di metterti in strada.',
        url: line.timetableUrl,
        createdAt: now,
      });
    }

    if (line.noticeUrl && before.noticeUrl !== line.noticeUrl) {
      alerts.push({
        id: `avviso-${line.id}-${now.slice(0, 10)}`,
        severity: 'critical',
        lineId: line.id,
        title: `Avviso su ${line.name}`,
        body: 'L’operatore ha pubblicato un avviso di servizio per questa linea.',
        url: line.noticeUrl,
        createdAt: now,
        validUntil: line.noticeUntil ?? null,
      });
    }
  }

  const beforeSuppressions = suppressionMap(previous);
  const afterSuppressions = suppressionMap(next);

  for (const [key, entry] of afterSuppressions) {
    const before = beforeSuppressions.get(key);
    if (before && before.trips.length === entry.trips.length) continue;
    alerts.push({
      id: `soppressione-${key.replace('::', '-')}-${now.slice(0, 10)}`,
      severity: 'warning',
      lineId: entry.lineId,
      stopId: entry.stopId,
      title: `${entry.stopName} non è servita da alcune corse`,
      body: `Sulla linea ${entry.lineName} la fermata resta fuori percorso per ${entry.trips.length} corse su ${
        next.lines.find((l) => l.id === entry.lineId)?.trips.length ?? '?'
      }.`,
      createdAt: now,
    });
  }

  for (const [key, entry] of beforeSuppressions) {
    if (afterSuppressions.has(key)) continue;
    alerts.push({
      id: `ripristino-${key.replace('::', '-')}-${now.slice(0, 10)}`,
      severity: 'info',
      lineId: entry.lineId,
      stopId: entry.stopId,
      title: `${entry.stopName} è di nuovo servita`,
      body: `La fermata torna nel percorso della linea ${entry.lineName}.`,
      createdAt: now,
    });
  }

  return alerts;
}

/**
 * Scarica una fonte e la tiene solo se passa i controlli. Se il sito non
 * risponde, risponde con una pagina di verifica o il risultato e' rotto, resta
 * il file del giorno prima: meglio orari di ieri che nessun orario.
 */
async function refresh(name, scrape, validate, enrich) {
  const file = path.join(DATA_DIR, `${name}.json`);
  const previous = await readJson(file);
  try {
    const next = await scrape(previous);
    if (enrich) {
      const fixes = [];
      await enrich(next, fixes);
      for (const message of fixes) console.log(`  corretto: ${message}`);
    }
    const { problems, notes } = validate(next);
    for (const message of notes) console.log(`  nota: ${message}`);
    if (problems.length) throw new Error(problems.join('; '));
    await writeJson(file, next);
    return { name, status: 'aggiornato', data: next, previous };
  } catch (err) {
    console.error(`  ${name}: tenuti i dati precedenti (${err.message})`);
    if (!previous) throw new Error(`${name}: nessun dato valido disponibile (${err.message})`);
    // Anche senza dati nuovi, calendario e correzioni si applicano a quelli di
    // ieri: un calendario scolastico aggiornato non deve aspettare il sito.
    if (enrich) {
      const kept = structuredClone(previous);
      await enrich(kept, []);
      if (!validate(kept).problems.length) {
        await writeJson(file, kept);
        return { name, status: 'invariato', error: err.message, data: kept, previous };
      }
    }
    return { name, status: 'invariato', error: err.message, data: previous, previous };
  }
}

async function fileInfo(name) {
  const content = await fs.readFile(path.join(DATA_DIR, `${name}.json`));
  const parsed = JSON.parse(content.toString('utf8'));
  return {
    generatedAt: parsed.generatedAt,
    bytes: content.length,
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
  };
}

async function main() {
  const started = Date.now();
  console.log(`Aggiornamento dati Muevt - ${new Date().toLocaleString('it-IT')}\n`);

  console.log('[1/4] Trasporti');
  const transportResult = await refresh('transport', scrapeTransport, validateTransport, enrichTransport);
  await writeMissingList().catch(() => {});
  if (usage.missing.size) console.log(`  cosa salvare a mano: ${path.join(COPY_DIR, 'DA-SALVARE.txt')}`);

  console.log('\n[2/4] Eventi');
  const eventsResult = await refresh('events', scrapeEvents, validateEvents);

  console.log('\n[3/4] Luoghi');
  const placesResult = await refresh('places', scrapePlaces, validatePlaces);

  console.log('\n[4/4] Avvisi');
  const transport = transportResult.data;
  const alerts = transportResult.status === 'aggiornato' ? diffTransport(transportResult.previous, transport) : [];
  const previousAlerts = (await readJson(path.join(DATA_DIR, 'alerts.json')))?.alerts ?? [];

  // Gli avvisi si ripuliscono ogni giorno, anche se gli orari non sono cambiati:
  // uno con una data di fine resta finche' il periodo non e' finito, gli altri
  // decadono dopo una settimana.
  const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const known = new Set(alerts.map((a) => a.id));
  const today = new Date().toISOString().slice(0, 10);
  const merged = [
    ...alerts,
    ...previousAlerts.filter((a) => !known.has(a.id) && (a.validUntil ? a.validUntil >= today : a.createdAt >= cutoff)),
  ];

  await writeJson(path.join(DATA_DIR, 'alerts.json'), {
    generatedAt: new Date().toISOString(),
    alerts: merged,
  });

  if (transportResult.status === 'aggiornato' && transportResult.previous) {
    await writeJson(path.join(SNAPSHOT_DIR, `transport-${new Date().toISOString().slice(0, 10)}.json`), transportResult.previous);
  }

  // Il manifest e' quello che l'app scarica per primo: dice quali file sono
  // cambiati, con impronta e dimensione per verificarli dopo il download.
  const results = [transportResult, eventsResult, placesResult];
  const manifest = {
    schema: 1,
    checkedAt: new Date().toISOString(),
    files: {
      transport: await fileInfo('transport'),
      events: await fileInfo('events'),
      places: await fileInfo('places'),
      alerts: await fileInfo('alerts'),
    },
    sources: Object.fromEntries(results.map((result) => [result.name, { status: result.status, error: result.error ?? null }])),
  };
  await writeJson(path.join(DATA_DIR, 'manifest.json'), manifest);

  console.log(`\nFatto in ${Math.round((Date.now() - started) / 1000)}s`);
  for (const result of results) console.log(`  ${result.name}: ${result.status}`);
  console.log(`  linee ${transport.lines.length}  fermate ${transport.stops.length}`);
  console.log(`  avvisi attivi ${merged.length} (${alerts.length} nuovi oggi)`);
}

main().catch((err) => {
  console.error('\nAggiornamento fallito:', err);
  process.exitCode = 1;
});
