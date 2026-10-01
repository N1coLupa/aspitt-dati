import * as cheerio from 'cheerio';
import { BlockedError, sleep } from '../lib/http.mjs';
import { COPY_DIR, marinoBuffer, marinoText, usage } from '../lib/copia-locale.mjs';
import { fetchKmlGeometry, kmlUrlFromMyMapsLink } from '../lib/kml.mjs';
import { parseTimetablePdf } from '../lib/pdf-timetable.mjs';
import { fillMissingStopCoordinates } from '../lib/geo.mjs';
import { slugify, stopKey } from '../lib/slug.mjs';
import { parseItalianDateRange, plausibleDay, publishedOn } from '../lib/dates-it.mjs';
import { noticeStops, noticeTimes } from '../lib/avvisi.mjs';

const HOME_URL = 'https://marinobusurbano.it/';
const NEWS_URL = 'https://marinobusurbano.it/news/';

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
    const noticeUrl = heading.find('a[href]').attr('href') ?? null;

    const name = clean(heading.clone().find('a').remove().end().text()).replace(/[-\s]+$/, '');
    if (!name || seen.has(name)) return;
    seen.add(name);

    const style = el.find('.line--col').attr('style') ?? '';
    const color = /background-color:\s*(#[0-9a-f]{3,8})/i.exec(style)?.[1] ?? null;

    const links = el
      .find('a.btn')
      .map((__, a) => ({ href: $(a).attr('href') ?? '', label: clean($(a).text()) }))
      .get();

    lines.push({
      id: slugify(name),
      name,
      color: color ? color.toLowerCase() : null,
      route: clean(el.find('.gen--p').first().text()) || null,
      timetableUrl: links.find((l) => /\.pdf$/i.test(l.href) && /orari/i.test(l.href))?.href ?? null,
      mapUrl: links.find((l) => l.href.includes('google.com/maps'))?.href ?? null,
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
    .map((_, a) => ({ label: clean($(a).text()), url: $(a).attr('href') ?? '' }))
    .get()
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
          url: el.find('a[href]').first().attr('href') ?? NEWS_URL,
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

// La legatura "tt" dei PDF a volte arriva staccata: "so tt opasso".
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

async function scrapeLine(line, registry, previousLine) {
  const result = { ...line, stops: [], trips: [], shape: [], warnings: [] };

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

  let tables = [];
  if (line.timetableUrl) {
    try {
      tables = await parseTimetablePdf(await marinoBuffer(line.timetableUrl));
    } catch (err) {
      result.warnings.push(`PDF orari non leggibile: ${err.message}`);
    }
  }

  if (!tables.length && previousLine?.trips?.length && previousLine.timetableUrl === line.timetableUrl) {
    result.warnings.push('PDF non scaricabile: tenute le corse di ieri, stesso quadro orario');
    usage.missing.delete(line.timetableUrl);
    for (const stop of previousLine.stops) register(registry, stop, line.id);
    return {
      ...result,
      stops: previousLine.stops,
      trips: previousLine.trips,
      shape: result.shape.length ? result.shape : previousLine.shape,
    };
  }

  const pdfStops = tables[0]?.stops ?? [];
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
        stopId: byIndex.get(st.stopIndex) ?? null,
        index: st.stopIndex,
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

const NOTICE_KEYS = ['noticeFrom', 'noticeUntil', 'noticeStart', 'noticeEnd', 'noticeStops', 'noticeText'];
const noticeTexts = new Map();

async function noticeText(url) {
  if (!noticeTexts.has(url)) {
    noticeTexts.set(
      url,
      (async () => {
        if (!/\.pdf($|\?)/i.test(url)) {
          const page = cheerio.load(await marinoText(url, null));
          return clean(page('main, article, .entry-content, body').first().text());
        }
        const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
        const doc = await pdfjs.getDocument({ data: new Uint8Array(await marinoBuffer(url)), isEvalSupported: false }).promise;
        const parts = [];
        for (let page = 1; page <= Math.min(doc.numPages, 3); page += 1) {
          const content = await (await doc.getPage(page)).getTextContent();
          parts.push(content.items.map((item) => item.str).join(' '));
        }
        return clean(parts.join(' '));
      })()
    );
  }
  return noticeTexts.get(url);
}

async function readNotice(url, previousLine, stops, lineName, lineNames) {
  const empty = Object.fromEntries(NOTICE_KEYS.map((key) => [key, key === 'noticeStops' ? [] : null]));
  if (!url) return empty;
  try {
    const text = await noticeText(url);
    // L'anno scritto dall'operatore si controlla con la data in cui il PDF e' stato caricato:
    // "13 ottobre 2025" in un avviso pubblicato a ottobre 2026 e' un errore di battitura.
    const published = publishedOn(url);
    const range = parseItalianDateRange(text, published ?? new Date()) ?? parseItalianDateRange(fileName(url), published ?? new Date());
    const times = noticeTimes(text);
    return {
      noticeFrom: plausibleDay(range?.start ?? null, published),
      noticeUntil: plausibleDay(range?.end ?? null, published),
      noticeStart: times.from,
      noticeEnd: times.to,
      noticeStops: noticeStops(text, stops, lineName, lineNames),
      noticeText: text.slice(0, 1200) || null,
    };
  } catch {
    if (previousLine?.noticeUrl !== url) return empty;
    usage.missing.delete(url);
    return Object.fromEntries(NOTICE_KEYS.map((key) => [key, previousLine[key] ?? empty[key]]));
  }
}

export async function scrapeTransport(previous = null) {
  console.log('> homepage MarinoBus Urbano');
  usage.local.clear();
  usage.missing.clear();
  usage.files.clear();
  noticeTexts.clear();

  let html = null;
  try {
    html = await marinoText(HOME_URL, 'home--lines');
  } catch (err) {
    if (!(err instanceof BlockedError) || !previous?.lines?.length) throw err;
    console.log('  homepage non disponibile: elenco linee da quello di ieri');
  }
  const $ = cheerio.load(html ?? '');

  const lines = html
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
    Object.assign(
      result,
      await readNotice(
        line.noticeUrl,
        previousLine,
        result.stops,
        line.name,
        lines.map((item) => item.name)
      )
    );
    result.timetableFile = usage.files.get(line.timetableUrl) ?? null;
    const suppressed = result.trips.reduce((total, trip) => total + trip.stopTimes.filter((st) => !st.served).length, 0);
    console.log(
      `${result.stops.length} fermate, ${result.trips.length} corse, ${suppressed} soppressioni` +
        (result.warnings.length ? ` [${result.warnings.join('; ')}]` : '')
    );
    scraped.push(result);
    await sleep(400);
  }

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
  const fs = await import('node:fs/promises');
  const { enrichTransport } = await import('../lib/arricchisci.mjs');
  const previous = JSON.parse(await fs.readFile('src/dati/transport.json', 'utf8').catch(() => 'null'));
  const data = await enrichTransport(await scrapeTransport(previous));
  await fs.mkdir('src/dati', { recursive: true });
  await fs.writeFile('src/dati/transport.json', JSON.stringify(data, null, 2));
  console.log(`
Scritto src/dati/transport.json (${data.lines.length} linee, ${data.stops.length} fermate uniche)`);
}
