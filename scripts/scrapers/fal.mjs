import '../lib/node-compat.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FAL_HOSTS, getBuffer, getText } from '../lib/http.mjs';

const PAGE = 'https://ferrovieappulolucane.it/tratta/orari/';
const OUT = path.join(process.env.MUEVT_DATA_DIR ?? path.join('src', 'dati'), 'fal.json');
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Aspitt, app mobilita Altamura)' };
const TIME = /^([01]?\d|2[0-3])[.:]([0-5]\d)$/;
const TRAIN = /^\d{1,3}(\/\d{1,3})?$/;
const RUN = /^\d{2,4}$/;
const MONTHS = { GEN: 1, FEB: 2, MAR: 3, APR: 4, MAG: 5, GIU: 6, LUG: 7, AGO: 8, SET: 9, OTT: 10, NOV: 11, DIC: 12 };

const ALTAMURA =
  /^(Via Bari (25|14)\b|HUB VIA SANTERAMO|HUB STAZIONE FS|Via V\. Veneto \(S\.Teresa\)|Via Gravina (98|81)|Via Carpentino|Via Putignano|Ospedale della Murgia|Via Matera)/i;
const TOWNS = [
  [/Basento|Grassano|Salandra|Ferrandina/i, 'Potenza'],
  [/Villa Longo|Naz\. ?Unite|Matera|A\. Moro|Stazione C\.?(le)? FAL/i, 'Matera'],
  [/^Corso Vittorio Emanuele$/i, 'Genzano'],
  [/^Corso Umberto$/i, 'Spinazzola'],
  [/^Via V\.Veneto$/i, 'Poggiorsini'],
  [/Amendola 3/i, 'Irsina'],
  [/Padre Pio|Piazzale Stazione FAL|^Stazione FAL$|Via Bari 55/i, 'Gravina'],
  [ALTAMURA, 'Altamura'],
];

const WEEK = [1, 2, 3, 4, 5, 6];
const DAYS = {
  F: { giorni: WEEK, scuola: null },
  A: { giorni: [1, 2, 3, 4, 5], scuola: null },
  S: { giorni: WEEK, scuola: true },
  AS: { giorni: [1, 2, 3, 4, 5], scuola: true },
  Fns: { giorni: WEEK, scuola: false },
  Ans: { giorni: [1, 2, 3, 4, 5], scuola: false },
  St: { giorni: [1, 4, 6], scuola: true },
  Smt: { giorni: [2, 3, 5], scuola: true },
  Sz: { giorni: [1, 3, 4, 6], scuola: true },
  Smmg: { giorni: [2, 3, 4], scuola: true },
  SLvs: { giorni: [1, 5, 6], scuola: true },
  Smv: { giorni: [2, 5], scuola: true },
  Sv: { giorni: [2, 4], scuola: true },
  SL: { giorni: [1], scuola: true },
  '◊': { giorni: [6], scuola: null },
};
const SHORT_DAYS = { L: 1, ma: 2, me: 3, g: 4, v: 5, s: 6 };

async function listPdfs() {
  const html = await getText(PAGE, { headers: HEADERS, attempts: 1, hosts: FAL_HOSTS });
  return [...html.matchAll(/<a[^>]+href="([^"]+\.pdf)"[^>]*>([\s\S]*?)<\/a>/gi)].map((match) => ({
    url: match[1],
    label: match[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' '),
  }));
}

function find(pdfs, test, what) {
  const found = pdfs.find(test);
  if (!found) throw new Error(`${what} non trovato su ${PAGE}`);
  return found.url;
}

function validFrom(url) {
  const match = /(\d{1,2})-([A-Z]{3})-(\d{4})/i.exec(url);
  if (!match) return null;
  const month = MONTHS[match[2].toUpperCase()];
  return month ? `${match[3]}-${String(month).padStart(2, '0')}-${match[1].padStart(2, '0')}` : null;
}

const clock = (value) => {
  const match = TIME.exec(value);
  return match ? `${match[1].padStart(2, '0')}:${match[2]}` : null;
};

async function readPdf(url) {
  const data = await getBuffer(url, { headers: HEADERS, attempts: 1, timeout: 60000, hosts: FAL_HOSTS });
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: new Uint8Array(data),
    useSystemFonts: true,
    verbosity: 0,
    isEvalSupported: false,
  });
  const doc = await task.promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n += 1) {
    const content = await (await doc.getPage(n)).getTextContent();
    pages.push(
      content.items
        .map((item) => ({
          text: item.str.trim(),
          x: item.transform[4] + (item.width ?? 0) / 2,
          left: item.transform[4],
          y: item.transform[5],
        }))
        .filter((item) => item.text)
    );
  }
  await task.destroy();
  return pages;
}

function rows(items) {
  const sorted = [...items].sort((a, b) => b.y - a.y);
  const result = [];
  for (const item of sorted) {
    const row = result.find((candidate) => Math.abs(candidate.y - item.y) < 2.5);
    if (row) row.items.push(item);
    else result.push({ y: item.y, items: [item] });
  }
  return result;
}

const nearest = (columns, x) => {
  let best = 0;
  for (let i = 1; i < columns.length; i += 1) if (Math.abs(columns[i].x - x) < Math.abs(columns[best].x - x)) best = i;
  return best;
};

function trainTables(pages) {
  const tables = [];
  for (const items of pages) {
    const pageRows = rows(items);
    const headers = pageRows.filter((row) => {
      const numbers = row.items.filter((item) => TRAIN.test(item.text));
      return numbers.length >= 5 && numbers.length === row.items.length;
    });
    headers.forEach((header, i) => {
      const until = headers[i + 1]?.y ?? -Infinity;
      const columns = [...header.items].sort((a, b) => a.x - b.x).map((item) => ({ train: item.text, x: item.x, times: [] }));
      const firstColumn = columns[0].x;
      for (const row of pageRows) {
        if (row.y >= header.y || row.y <= until) continue;
        const label = row.items
          .filter((item) => item.left < firstColumn - 12 && !TIME.test(item.text))
          .map((item) => item.text)
          .join(' ')
          .trim();
        if (!label || /Localit/i.test(label)) continue;
        for (const item of row.items) {
          const time = clock(item.text);
          if (time && item.left >= firstColumn - 12) columns[nearest(columns, item.x)].times.push({ station: label, time });
        }
      }
      tables.push(...columns);
    });
  }
  return tables;
}

const clean = (station) => station.replace(/\s*\((arrivo|partenza)[^)]*\)/i, '').trim();

export function departuresFrom(tables) {
  const departures = [];
  for (const column of tables) {
    const index = column.times.findIndex((entry) => /^Altamura \(partenza\)/i.test(entry.station));
    if (index < 0) continue;
    const after = column.times.slice(index + 1);
    if (!after.length) continue;
    const last = after[after.length - 1];
    departures.push({
      treno: column.train,
      ora: column.times[index].time,
      origine: clean(column.times[0].station),
      destinazione: clean(last.station),
      arrivo: last.time,
    });
  }
  return departures.sort((a, b) => a.ora.localeCompare(b.ora));
}

const stopName = (label) =>
  label
    .replace(/\s*-?\s*\(\s*●[^)]*\)?/g, '')
    .replace(/\((di fronte )?civ\.?\s*/i, '(')
    .replace(/\b(HUB|VIA|STAZIONE|SANTERAMO)\b/g, (word) => (word === 'HUB' ? 'Hub' : word[0] + word.slice(1).toLowerCase()))
    .replace(/\s+/g, ' ')
    .trim();

const town = (label) => TOWNS.find(([pattern]) => pattern.test(label))?.[1] ?? null;

function days(tokens, festive) {
  if (festive) return { giorni: [7], scuola: null };
  let rule = null;
  let only = null;
  for (const token of tokens) {
    const code = token.replace(/\s+/g, '');
    if (DAYS[code] && (!rule || code.length > 1)) rule = DAYS[code];
    if (/\//.test(code) && /^(L|ma|me|g|v|s|\/)+$/.test(code)) only = (code.match(/L|ma|me|g|v|s/g) ?? []).map((part) => SHORT_DAYS[part]);
  }
  const base = rule ?? DAYS.F;
  return only?.length ? { giorni: only, scuola: base.scuola } : base;
}

function busTables(pages, festive) {
  const runs = [];
  for (const items of pages) {
    const pageRows = rows(items);
    const title = items.map((item) => item.text).join(' ');
    const toBari = /PER BARI/i.test(title) && !/DA BARI/i.test(title);
    const headers = pageRows.filter((row) => row.items.filter((item) => RUN.test(item.text) && item.left > 330).length >= 5);
    headers.forEach((header, i) => {
      const until = headers[i + 1] ? headers[i + 1].y + 40 : -Infinity;
      const columns = header.items
        .filter((item) => RUN.test(item.text) && item.left > 330)
        .sort((a, b) => a.x - b.x)
        .map((item) => ({ corsa: item.text, x: item.x, codes: [], notes: [], stops: [] }));
      const firstColumn = columns[0].x;
      for (const row of pageRows) {
        if (row.y > header.y && row.y < header.y + 40) {
          for (const item of row.items)
            if (item.left > 330 && !RUN.test(item.text)) columns[nearest(columns, item.x)].codes.push(item.text);
          continue;
        }
        if (row.y > header.y - 20 && row.y < header.y) {
          for (const item of row.items)
            if (/^(BIS|TER|ANTE)$/i.test(item.text)) columns[nearest(columns, item.x)].corsa += ` ${item.text.toUpperCase()}`;
          continue;
        }
        if (row.y >= header.y || row.y <= until) continue;
        const label = row.items
          .filter((item) => item.left >= 140 && item.left < firstColumn - 20 && !TIME.test(item.text))
          .map((item) => item.text)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        for (const item of row.items) {
          if (item.left < firstColumn - 20) continue;
          const time = clock(item.text);
          const column = columns[nearest(columns, item.x)];
          if (time && label) column.stops.push({ label, time });
          else if (!time && item.text.length > 2) column.notes.push(item.text);
        }
      }
      for (const column of columns) runs.push({ ...column, toBari, festive });
    });
  }
  return runs;
}

export function busDepartures(runs) {
  const departures = [];
  const seen = new Set();
  for (const run of runs) {
    const { stops } = run;
    const firstAltamura = stops.findIndex((stop) => ALTAMURA.test(stop.label));
    if (firstAltamura < 0) continue;
    let lastAltamura = firstAltamura;
    while (lastAltamura + 1 < stops.length && ALTAMURA.test(stops[lastAltamura + 1].label)) lastAltamura += 1;
    if (lastAltamura === stops.length - 1) continue;
    const stop = stops[firstAltamura];
    const august = /solo nel|solo.*agosto|agosto.*solo/i.test(run.notes.join(' ')) ? 'solo' : null;
    const key = `${run.corsa}|${stop.time}|${run.festive}|${august}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const rule = days(run.codes, run.festive);
    const last = stops[stops.length - 1];
    departures.push({
      corsa: run.corsa,
      ora: stop.time,
      fermata: stopName(stop.label),
      origine: run.toBari ? (town(stops[0].label) ?? stops[0].label) : 'Bari',
      destinazione: run.toBari ? 'Bari' : (town(last.label) ?? last.label),
      arrivo: last.time,
      giorni: rule.giorni,
      scuola: rule.scuola,
      agosto: august,
    });
  }
  return departures.sort((a, b) => a.ora.localeCompare(b.ora));
}

export async function scrapeFal() {
  const pdfs = await listPdfs();
  const trainUrl = find(
    pdfs,
    (pdf) => /QUADRO ORARI FERROVIARI FERIALI BARI/i.test(pdf.label) && /ALTAMURA/i.test(pdf.label),
    'quadro orario dei treni'
  );
  const busUrl = find(
    pdfs,
    (pdf) => /AUTOMOBILISTICI FERIALI DA BARI/i.test(pdf.label) && /Altamura/i.test(pdf.label),
    'quadro orario dei bus feriali'
  );
  const festiveUrl = find(
    pdfs,
    (pdf) => /AUTOMOBILISTICI FESTIVI/i.test(pdf.label) && /Altamura/i.test(pdf.label),
    'quadro orario dei bus festivi'
  );

  const partenze = departuresFrom(trainTables(await readPdf(trainUrl)));
  const bus = [...busDepartures(busTables(await readPdf(busUrl), false)), ...busDepartures(busTables(await readPdf(festiveUrl), true))];

  if (partenze.length < 10) throw new Error(`solo ${partenze.length} treni letti dal quadro orario, formato cambiato?`);
  if (bus.length < 10) throw new Error(`solo ${bus.length} bus letti dai quadri orario, formato cambiato?`);

  return {
    generato: new Date().toISOString(),
    fonte: trainUrl,
    fonteBus: [busUrl, festiveUrl],
    validoDal: validFrom(trainUrl),
    busValidoDal: validFrom(busUrl),
    giorni: 'feriali',
    partenze,
    bus,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const data = await scrapeFal();
  await fs.writeFile(OUT, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`Scritto ${OUT}: ${data.partenze.length} treni e ${data.bus.length} bus da Altamura`);
}
