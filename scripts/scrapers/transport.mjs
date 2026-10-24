import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { BlockedError, MARINO_HOSTS, sleep } from '../lib/http.mjs';
import { normalizeLink } from '../lib/link.mjs';
import { COPY_DIR, marinoBuffer, marinoText, usage } from '../lib/copia-locale.mjs';
import { fetchKmlGeometry, kmlUrlFromMyMapsLink } from '../lib/kml.mjs';
import { parseTimetablePdf } from '../lib/pdf-timetable.mjs';
import { fillMissingStopCoordinates } from '../lib/geo.mjs';
import { slugify, stopKey } from '../lib/slug.mjs';
import { listedDays, parseItalianDateRange, plausibleDay, publishedOn } from '../lib/dates-it.mjs';
import { mentionsLine, noticeOnlyAt, noticeStops, noticeTimes, stopsInTown } from '../lib/avvisi.mjs';

const HOME_URL = 'https://marinobusurbano.it/';
const REGIONAL_FILE = fileURLToPath(new URL('../data/linee-regionali.json', import.meta.url));
const NOTICE_PLACES_FILE = fileURLToPath(new URL('../data/luoghi-avvisi.json', import.meta.url));
const NEWS_URL = 'https://marinobusurbano.it/news/';

// Qualunque forma abbia il link nel sito dell'operatore (http, https, relativo, scritto male),
// diventa un https dell'operatore oppure null: un link rovinato non fa scartare gli orari.
const link = (href) => normalizeLink(href, HOME_URL, MARINO_HOSTS);

const clean = (value) =>
  String(value ?? '')
    .replace(/ּמ/g, 'tt')
    .replace(/\s+/g, ' ')
    .trim();

function parseLines($) {
  const lines = [];
  const seen = new Set();

  $('.home--lines .line').each((_, node) => {
    const el = $(node);
    const heading = el.find('.line--info h3').first();
    const noticeUrl = link(heading.find('a[href]').attr('href')) ?? null;

    const name = clean(heading.clone().find('a').remove().end().text()).replace(/[-\s]+$/, '');
    if (!name || seen.has(name)) return;
    seen.add(name);

    const style = el.find('.line--col').attr('style') ?? '';
    const color = /background-color:\s*(#[0-9a-f]{3,8})/i.exec(style)?.[1] ?? null;

    const links = el
      .find('a.btn')
      .map((__, a) => ({ href: normalizeLink($(a).attr('href'), HOME_URL) ?? '', label: clean($(a).text()) }))
      .get();

    lines.push({
      id: slugify(name),
      name,
      color: color ? color.toLowerCase() : null,
      route: clean(el.find('.gen--p').first().text()) || null,
      timetableUrl: link(links.find((l) => /\.pdf$/i.test(l.href) && /orari/i.test(l.href))?.href),
      mapUrl: normalizeLink(links.find((l) => l.href.includes('google.com/maps'))?.href, HOME_URL, ['google.com']),
      noticeUrl,
    });
  });

  return lines;
}

function parseVendors(html) {
  const block = /markers_list\s*=\s*\[([\s\S]*?)\];/.exec(html);
  if (!block) return [];

  const vendors = [];
  for (const match of block[1].matchAll(/"((?:\\.|[^"\\])*)"/g)) {
    try {
      const parsed = JSON.parse(JSON.parse(`"${match[1]}"`));
      const lat = Number(parsed.lat);
      const lon = Number(parsed.lng);
      vendors.push({
        id: slugify(parsed.title),
        name: clean(parsed.title),
        address: clean(parsed.address),
        phone: parsed.phone ? String(parsed.phone).replace(/\D/g, '') : null,
        lat: Number.isFinite(lat) ? lat : null,
        lon: Number.isFinite(lon) ? lon : null,
      });
    } catch {}
  }
  return vendors;
}

function parseFares($) {
  return $('a[href$=".pdf"]')
    .map((_, a) => ({ label: clean($(a).text()), url: link($(a).attr('href')) ?? '' }))
    .get()
    .filter((f) => f.url)
    .filter((f) => /tariffario|carta-della-mobilita|condizioni-di-viaggio/i.test(f.url))
    .map((f) => ({ ...f, label: f.label || 'Documento' }));
}

async function parseNews() {
  const MONTHS = {
    gen: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    mag: 5,
    giu: 6,
    lug: 7,
    ago: 8,
    set: 9,
    ott: 10,
    nov: 11,
    dic: 12,
  };

  try {
    const $ = cheerio.load(await marinoText(NEWS_URL, 'news--list'));
    return $('.news--list .news')
      .map((_, node) => {
        const el = $(node);
        const title = clean(el.find('h3, h4').first().text());
        if (!title) return null;

        const parts = clean(
          el
            .find('.number')
            .first()
            .html()
            ?.replace(/<br\s*\/?>/gi, '|') ?? ''
        )
          .split('|')
          .map(clean);
        const month = MONTHS[(parts[1] ?? '').slice(0, 3).toLowerCase()];
        const date = parts.length >= 3 && month ? `${parts[2]}-${String(month).padStart(2, '0')}-${parts[0].padStart(2, '0')}` : null;

        return {
          id: slugify(title),
          title,
          date,
          summary: clean(el.find('.description p').first().text()).slice(0, 500) || null,
          url: link(el.find('a[href]').first().attr('href')) ?? NEWS_URL,
        };
      })
      .get()
      .filter(Boolean)
      .slice(0, 30);
  } catch (err) {
    console.warn(`  ! news non raggiungibili: ${err.message}`);
    return [];
  }
}

function matchKmlStop(pdfName, kmlStops, used) {
  const key = stopKey(pdfName);
  const exact = kmlStops.findIndex((s, i) => !used.has(i) && stopKey(s.name) === key);
  if (exact !== -1) return exact;

  const tokens = new Set(key.split(' ').filter((t) => t.length > 2));
  let best = -1;
  let bestScore = 0;
  kmlStops.forEach((stop, index) => {
    if (used.has(index)) return;
    const other = new Set(
      stopKey(stop.name)
        .split(' ')
        .filter((t) => t.length > 2)
    );
    const shared = [...tokens].filter((t) => other.has(t)).length;
    const score = shared / Math.max(tokens.size, other.size, 1);
    if (score > bestScore) {
      bestScore = score;
      best = index;
    }
  });
  return bestScore >= 0.6 ? best : -1;
}

const compactName = (name) => stopKey(name).replace(/ /g, '');
const isSpacedOut = (name) =>
  String(name)
    .split(' ')
    .filter((token) => token.length === 1).length >= 6;

const joinLigature = (name) => String(name).replace(/(\p{Ll}) tt (\p{Ll})/gu, '$1tt$2');

function restoreSpacedName(name, known) {
  if (!isSpacedOut(name)) return name;
  const target = compactName(name);
  return known.find((other) => !isSpacedOut(other) && compactName(other) === target) ?? name;
}

function register(registry, stop, lineId) {
  const key = stopKey(stop.name);
  if (!registry.has(key)) {
    registry.set(key, { id: `stop-${slugify(stop.name)}`, name: stop.name, lat: stop.lat, lon: stop.lon, lines: [] });
  }
  const entry = registry.get(key);
  if (entry.lat == null && stop.lat != null) {
    entry.lat = stop.lat;
    entry.lon = stop.lon;
  }
  if (!entry.lines.includes(lineId)) entry.lines.push(lineId);
  return entry;
}

const parsedTables = new Map();

function timetableTables(url) {
  if (!parsedTables.has(url)) parsedTables.set(url, marinoBuffer(url).then(parseTimetablePdf));
  return parsedTables.get(url);
}

const titleKey = (title) =>
  String(title ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

// Un PDF con pagine intitolate a linee diverse (le extraurbane) diventa una linea per titolo.
async function splitByTitle(line, regional) {
  if (!line.timetableUrl) return [line];
  let tables;
  try {
    tables = await timetableTables(line.timetableUrl);
  } catch {
    return [line];
  }
  const titles = [...new Set(tables.map((table) => titleKey(table.title)).filter(Boolean))];
  if (titles.length < 2) return [line];
  return titles.map((key) => {
    const pages = tables.filter((table) => titleKey(table.title) === key).map((table) => table.page);
    const first = tables.find((table) => table.page === pages[0]);
    const label = first.title.replace(/^\p{Ll}/u, (letter) => letter.toUpperCase());
    const known = regional[key];
    const name = known?.name ?? `Linea ${label}`;
    return {
      ...line,
      id: slugify(name),
      name,
      route: known?.route ?? `${first.stops[0]?.name ?? ''} - ${first.stops[first.stops.length - 1]?.name ?? ''}`,
      mapUrl: null,
      pages,
    };
  });
}

async function scrapeLine(line, registry, previousLine) {
  const { pages, ...fields } = line;
  const result = { ...fields, stops: [], trips: [], shape: [], warnings: [] };

  let kml = { stops: [], shape: [] };
  if (line.mapUrl) {
    const kmlUrl = kmlUrlFromMyMapsLink(line.mapUrl);
    if (kmlUrl) {
      try {
        kml = await fetchKmlGeometry(kmlUrl);
      } catch (err) {
        result.warnings.push(`KML non disponibile: ${err.message}`);
      }
    }
  }
  result.shape = kml.shape ?? [];
  result.drawnExtra = kml.extra ?? [];

  let tables = [];
  if (line.timetableUrl) {
    try {
      tables = await timetableTables(line.timetableUrl);
    } catch (err) {
      result.warnings.push(`PDF orari non leggibile: ${err.message}`);
    }
  }
  if (line.pages) tables = tables.filter((table) => line.pages.includes(table.page));

  if (!tables.length && previousLine?.trips?.length && previousLine.timetableUrl === line.timetableUrl) {
    result.warnings.push('PDF non scaricabile: tenute le corse di ieri, stesso quadro orario');
    usage.missing.delete(line.timetableUrl);
    for (const stop of previousLine.stops) register(registry, stop, line.id);
    return {
      ...result,
      stops: previousLine.stops,
      trips: previousLine.trips,
      shape: result.shape.length ? result.shape : previousLine.shape,
      drawnExtra: result.shape.length ? result.drawnExtra : (previousLine.drawnExtra ?? []),
    };
  }

  const sameList = (a, b) => a.length === b.length && a.every((stop, i) => stopKey(stop.name) === stopKey(b[i].name));
  const pdfStops = [];
  const offsets = tables.map((table, tableIndex) => {
    if (tableIndex > 0 && sameList(table.stops, tables[0].stops)) return 0;
    const offset = pdfStops.length;
    pdfStops.push(...table.stops.map((stop) => ({ ...stop, index: stop.index + offset })));
    return offset;
  });
  const knownNames = [...kml.stops, ...(previousLine?.stops ?? []), ...registry.values()].map((stop) => stop.name);
  const baseStops = pdfStops.length
    ? pdfStops.map((s) => ({ index: s.index, name: restoreSpacedName(joinLigature(s.name), knownNames) }))
    : kml.stops.map((s, i) => ({ index: i + 1, name: s.name }));

  const used = new Set();
  let located = baseStops.map((stop) => {
    const matchIndex = matchKmlStop(stop.name, kml.stops, used);
    if (matchIndex === -1) return { ...stop, lat: null, lon: null };
    used.add(matchIndex);
    const kmlStop = kml.stops[matchIndex];
    return { ...stop, lat: kmlStop.lat, lon: kmlStop.lon };
  });

  located = fillMissingStopCoordinates(located, result.shape);

  const missing = located.filter((s) => s.lat == null).length;
  if (missing) result.warnings.push(`${missing} fermate senza coordinate`);

  result.stops = located.map((stop) => {
    const entry = register(registry, stop, line.id);

    return {
      stopId: entry.id,
      index: stop.index,
      name: stop.name,
      lat: stop.lat,
      lon: stop.lon,
      interpolated: Boolean(stop.interpolated),
    };
  });

  const byIndex = new Map(result.stops.map((s) => [s.index, s.stopId]));
  result.trips = tables.flatMap((table, tableIndex) =>
    table.trips.map((trip) => ({
      id: `${line.id}-p${table.page}-${slugify(trip.code)}`,
      code: trip.code,
      variant: tables.length > 1 ? tableIndex + 1 : null,
      serviceLabel: trip.serviceLabel,
      days: trip.days ?? [1, 2, 3, 4, 5, 6],
      departure: trip.departure,
      stopTimes: trip.stopTimes.map((st) => ({
        stopId: byIndex.get(st.stopIndex + offsets[tableIndex]) ?? null,
        index: st.stopIndex + offsets[tableIndex],
        time: st.time,
        served: st.served,
      })),
    }))
  );

  const usedIds = new Map();
  for (const trip of result.trips) {
    const count = (usedIds.get(trip.id) ?? 0) + 1;
    usedIds.set(trip.id, count);
    if (count > 1) trip.id = `${trip.id}-${count}`;
  }

  return result;
}

const fileName = (url) => decodeURIComponent(String(url).split(/[?#]/)[0].split('/').pop() ?? '');

const NOTICE_KEYS = ['noticeUrl', 'noticeFrom', 'noticeUntil', 'noticeStart', 'noticeEnd', 'noticeStops', 'noticeOnlyAt', 'noticeText'];
const EMPTY_NOTICE = Object.fromEntries(NOTICE_KEYS.map((key) => [key, key === 'noticeStops' ? [] : null]));
const noticePages = new Map();

// I volantini mettono le scritte nel PDF in ordine sparso ("BAR CASABLANCA" prima di "unica fermata presso il"):
// si rileggono dall'alto in basso e, sulla stessa riga, da sinistra a destra.
function readingOrder(items) {
  const rows = [];
  for (const item of [...items].filter((item) => item.str?.trim()).sort((a, b) => b.transform[5] - a.transform[5])) {
    const row = rows.find((other) => Math.abs(other.y - item.transform[5]) < Math.max(item.height, 4) / 2);
    if (row) row.items.push(item);
    else rows.push({ y: item.transform[5], items: [item] });
  }
  return rows.flatMap((row) => row.items.sort((a, b) => a.transform[4] - b.transform[4]));
}

// Testo di ogni pagina di un avviso: anche quello scritto nei campi modulo del PDF, che pdfjs
// non restituisce come testo normale. Ogni pagina e' un avviso a se', con le sue date e linee.
function readNoticePages(url) {
  if (!noticePages.has(url)) {
    noticePages.set(
      url,
      (async () => {
        if (!/\.pdf($|\?)/i.test(url)) {
          const page = cheerio.load(await marinoText(url, null));
          return [clean(page('main, article, .entry-content, body').first().text())].filter(Boolean);
        }
        const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
        const doc = await pdfjs.getDocument({ data: new Uint8Array(await marinoBuffer(url)), isEvalSupported: false }).promise;
        const pages = [];
        for (let number = 1; number <= Math.min(doc.numPages, 6); number += 1) {
          const page = await doc.getPage(number);
          const content = await page.getTextContent();
          const fields = (await page.getAnnotations())
            .map((annotation) => annotation.fieldValue ?? annotation.contentsObj?.str ?? '')
            .filter((value) => typeof value === 'string');
          pages.push(clean([...readingOrder(content.items).map((item) => item.str), ...fields].join(' ')));
        }
        return pages;
      })()
    );
  }
  return noticePages.get(url);
}

function noticeFields(url, text, stops, lineName, lineNames, places) {
  const published = publishedOn(url);
  let range = parseItalianDateRange(text, published ?? new Date()) ?? parseItalianDateRange(fileName(url), published ?? new Date());
  // Piu' giorni separati: l'app conosce un solo intervallo, quindi si pubblica il prossimo giorno
  // interessato (o l'ultimo, se sono tutti passati). L'aggiornamento successivo passa al giorno dopo.
  const days = listedDays(text);
  if (days.length > 1) {
    const next = days.find((day) => day >= today()) ?? days[days.length - 1];
    range = { start: next, end: next };
  }
  const times = noticeTimes(text);
  // "Un'unica fermata presso il Bar Casablanca": se il posto e' noto, salta le fermate della linea nel suo comune.
  const onlyAt = noticeOnlyAt(text);
  const place = onlyAt ? places[onlyAt.toLowerCase()] : null;
  const skipped = noticeStops(text, stops, lineName, lineNames);
  return {
    noticeUrl: url,
    noticeFrom: plausibleDay(range?.start ?? null, published),
    noticeUntil: plausibleDay(range?.end ?? null, published),
    noticeStart: times.from,
    noticeEnd: times.to,
    noticeStops: skipped.length || !place?.comune ? skipped : stopsInTown(stops, place.comune),
    noticeOnlyAt: onlyAt
      ? { name: place?.nome ?? onlyAt, address: place?.indirizzo ?? null, lat: place?.lat ?? null, lon: place?.lon ?? null }
      : null,
    noticeText: text.slice(0, 1200) || null,
  };
}

const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });

// Un avviso vale per ogni linea citata nel testo, da qualunque linea del sito sia linkato; se non ne
// cita nessuna, vale per le linee che lo linkano. Fra piu' avvisi di una linea vince quello che arriva prima.
async function assignNotices(scraped, previous) {
  const names = scraped.map((line) => line.name);
  const places = JSON.parse(await fs.readFile(NOTICE_PLACES_FILE, 'utf8').catch(() => '{}')).luoghi ?? {};
  const notices = [];
  for (const url of new Set(scraped.map((line) => line.noticeUrl).filter(Boolean))) {
    const owners = scraped.filter((line) => line.noticeUrl === url);
    let pages;
    try {
      pages = await readNoticePages(url);
    } catch {
      usage.missing.delete(url);
      for (const line of owners) {
        const before = previous?.lines?.find((item) => item.id === line.id);
        line.keptNotice =
          before?.noticeUrl?.split('#')[0] === url
            ? Object.fromEntries(NOTICE_KEYS.map((key) => [key, before[key] ?? EMPTY_NOTICE[key]]))
            : null;
      }
      continue;
    }
    pages.forEach((text, index) => {
      if (!text) return;
      const pageUrl = pages.length > 1 ? `${url}#page=${index + 1}` : url;
      const mentioned = scraped.filter((line) => mentionsLine(text, line.name));
      for (const line of mentioned.length ? mentioned : owners) {
        notices.push({ line, fields: noticeFields(pageUrl, text, line.stops, line.name, names, places) });
      }
    });
  }
  const now = today();
  const rank = (fields) => {
    const until = fields.noticeUntil ?? fields.noticeFrom;
    return until && until < now ? `9${until}` : `0${fields.noticeFrom ?? '0000'}`;
  };
  for (const line of scraped) {
    const own = notices.filter((notice) => notice.line === line).sort((a, b) => rank(a.fields).localeCompare(rank(b.fields)));
    Object.assign(line, own[0]?.fields ?? line.keptNotice ?? EMPTY_NOTICE);
    delete line.keptNotice;
  }
}

export async function scrapeTransport(previous = null) {
  console.log('> homepage MarinoBus Urbano');
  usage.local.clear();
  usage.missing.clear();
  usage.files.clear();
  noticePages.clear();
  parsedTables.clear();

  let html = null;
  try {
    html = await marinoText(HOME_URL, 'home--lines');
  } catch (err) {
    if (!(err instanceof BlockedError) || !previous?.lines?.length) throw err;
    console.log('  homepage non disponibile: elenco linee da quello di ieri');
  }
  const $ = cheerio.load(html ?? '');

  const listed = html
    ? parseLines($)
    : previous.lines.map(({ id, name, color, route, timetableUrl, mapUrl, noticeUrl }) => ({
        id,
        name,
        color,
        route,
        timetableUrl,
        mapUrl,
        noticeUrl,
      }));
  const regional = JSON.parse(await fs.readFile(REGIONAL_FILE, 'utf8').catch(() => '{}')).linee ?? {};
  const lines = (await Promise.all(listed.map((line) => splitByTitle(line, regional)))).flat();
  console.log(`  ${lines.length} linee ${html ? 'trovate' : 'riprese da ieri'}`);
  if (!lines.length) {
    throw new Error('Nessuna linea nella homepage: il sito ha risposto con una pagina di verifica o ha cambiato struttura.');
  }

  const registry = new Map();
  const scraped = [];
  for (const line of lines) {
    process.stdout.write(`> ${line.name} ... `);
    const previousLine = previous?.lines?.find((item) => item.id === line.id) ?? null;
    const result = await scrapeLine(line, registry, previousLine);
    result.timetableFile = usage.files.get(line.timetableUrl) ?? null;
    const suppressed = result.trips.reduce((total, trip) => total + trip.stopTimes.filter((st) => !st.served).length, 0);
    console.log(
      `${result.stops.length} fermate, ${result.trips.length} corse, ${suppressed} soppressioni` +
        (result.warnings.length ? ` [${result.warnings.join('; ')}]` : '')
    );
    scraped.push(result);
    await sleep(400);
  }

  await assignNotices(scraped, previous);

  const news = html ? await parseNews() : [];
  usage.missing.delete(NEWS_URL);
  if (!news.length && previous?.news?.length) news.push(...previous.news);
  const retrieval = { mode: usage.local.size ? 'copia locale' : 'rete', missing: [...usage.missing] };
  if (usage.local.size) console.log(`  usata la copia salvata a mano in ${COPY_DIR} per ${usage.local.size} file`);
  if (usage.missing.size) {
    console.log(`  il sito chiede la verifica anti-bot: per aggiornare salva in ${COPY_DIR}:`);
    for (const url of usage.missing) console.log(`    ${url}`);
  }

  return {
    generatedAt: new Date().toISOString(),
    source: HOME_URL,
    retrieval,
    operator: {
      name: 'Autolinee Marino Michele S.r.l.',
      phone: '+390803112335',
      email: 'info@marinobusurbano.it',
      website: HOME_URL,
      ticketing: {
        singleTicket: 'https://booking.marinobusurbano.it/it/from/Urbano%20Altamura/today/to/Urbano%20Altamura/?adulti=1',
        pass: 'https://booking.marinobusurbano.it/it/u/Urbano%20Altamura',
      },
    },
    lines: scraped,
    stops: [...registry.values()],
    vendors: html ? parseVendors(html) : (previous?.vendors ?? []),
    fares: html ? parseFares($) : (previous?.fares ?? []),
    news,
  };
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());

if (invokedDirectly) {
  const { enrichTransport } = await import('../lib/arricchisci.mjs');
  const previous = JSON.parse(await fs.readFile('src/dati/transport.json', 'utf8').catch(() => 'null'));
  const data = await enrichTransport(await scrapeTransport(previous));
  await fs.mkdir('src/dati', { recursive: true });
  await fs.writeFile('src/dati/transport.json', JSON.stringify(data, null, 2));
  console.log(`
Scritto src/dati/transport.json (${data.lines.length} linee, ${data.stops.length} fermate uniche)`);
}
