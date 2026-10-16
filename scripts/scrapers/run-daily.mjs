import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validateEvents, validatePlaces, validateTransport } from '../check-data.mjs';
import { scrapeTransport } from './transport.mjs';
import { scrapeEvents } from './events.mjs';
import { scrapePlaces } from './places.mjs';
import { enrichTransport } from '../lib/arricchisci.mjs';
import { COPY_DIR, usage, writeMissingList } from '../lib/copia-locale.mjs';

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

    if (before.timetableUrl !== line.timetableUrl || (line.validFrom && before.validFrom && before.validFrom !== line.validFrom)) {
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
  }

  return alerts;
}

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
