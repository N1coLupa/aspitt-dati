// Scraper degli eventi di Altamura dalle testate locali.
//
//   - AltamuraLive.it pubblica un feed RSS dedicato alla sezione Eventi: e' la
//     fonte piu' stabile, sopravvive ai restyling del sito.
//   - AltamuraLife.it non ha feed ma tiene una vera agenda in /eventi/, con
//     data e luogo gia' separati nel markup.
//
// Uso: node scripts/scrapers/events.mjs

import * as cheerio from 'cheerio';
import { XMLParser } from 'fast-xml-parser';
import { getText } from '../lib/http.mjs';
import { parseItalianDateRange } from '../lib/dates-it.mjs';
import { slugify } from '../lib/slug.mjs';

const SOURCES = {
  altamuralive: {
    name: 'AltamuraLive',
    homepage: 'https://altamuralive.it/',
    feeds: ['https://altamuralive.it/notizie/eventi/feed/', 'https://altamuralive.it/notizie/news/cultura/feed/'],
  },
  altamuralife: {
    name: 'AltamuraLife',
    homepage: 'https://www.altamuralife.it/',
    agenda: 'https://www.altamuralife.it/eventi/',
  },
};

// Categorie dell'app: la sezione Scopri filtra su queste.
const CATEGORY_RULES = [
  { category: 'trekking', re: /trekking|escursion|cammin|murgia|pulo|natura|bici|sentier/i },
  { category: 'cultura', re: /mostra|museo|libro|poesia|teatr|concert|arte|conferenz|present|storia|archeolog/i },
  { category: 'esperienze', re: /degustaz|laboratori|visita guidata|tour|sagra|mercat|gastronom|pane|masseria/i },
];

const parser = new XMLParser({ ignoreAttributes: false, trimValues: true });
const clean = (value) =>
  String(value ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#8217;|&rsquo;/g, '’')
    .replace(/\s+/g, ' ')
    .trim();

const asArray = (value) => (value == null ? [] : Array.isArray(value) ? value : [value]);

function classify(...texts) {
  const haystack = texts.filter(Boolean).join(' ');
  const matched = CATEGORY_RULES.filter((rule) => rule.re.test(haystack)).map((r) => r.category);
  return matched.length ? matched : ['eventi'];
}

function firstImage(html) {
  return /<img[^>]+src=["']([^"']+)["']/i.exec(String(html ?? ''))?.[1] ?? null;
}

// Molte cronache citano il luogo in chiaro: lo estraiamo per poter poi calcolare
// le fermate piu' vicine.
function guessVenue(text) {
  const match =
    /\b(?:presso|a|al|alla|all'|in)\s+((?:Dimora|Palazzo|Teatro|Chiesa|Museo|Masseria|Piazza|Claustro|Biblioteca|Parco|Cattedrale|Auditorium|Villa)(?:\s+(?:di|del|della|dei|delle))?(?:\s+[A-ZÀ-Ü][\wÀ-ü']{2,}){1,3})/.exec(
      String(text ?? '')
    );
  return match ? clean(match[1]).replace(/[.,;]$/, '') : null;
}

async function scrapeAltamuraLive() {
  const events = new Map();

  for (const feedUrl of SOURCES.altamuralive.feeds) {
    let xml;
    try {
      xml = await getText(feedUrl);
    } catch (err) {
      console.warn(`  ! ${feedUrl}: ${err.message}`);
      continue;
    }

    const items = asArray(parser.parse(xml)?.rss?.channel?.item);
    for (const item of items) {
      const title = clean(item.title);
      const link = String(item.link ?? '').trim();
      if (!title || !link) continue;

      const summary = clean(item.description);
      const body = String(item['content:encoded'] ?? '');
      const categories = asArray(item.category).map(clean);
      const published = item.pubDate ? new Date(item.pubDate).toISOString() : null;

      // La data della notizia non e' la data dell'evento: quella sta nel testo,
      // quasi sempre senza anno. La data di pubblicazione e' il riferimento
      // giusto per scioglierla, altrimenti un articolo di maggio finirebbe
      // nell'anno successivo.
      const reference = published ? new Date(published) : new Date();
      const when =
        parseItalianDateRange(title, reference) ??
        parseItalianDateRange(summary, reference) ??
        parseItalianDateRange(clean(body).slice(0, 600), reference);

      const id = `live-${slugify(title)}`;
      events.set(id, {
        id,
        title,
        url: link,
        source: SOURCES.altamuralive.name,
        sourceUrl: SOURCES.altamuralive.homepage,
        publishedAt: published,
        startDate: when?.start ?? null,
        endDate: when?.end ?? null,
        startTime: when?.startTime ?? null,
        venue: guessVenue(`${title} ${summary}`),
        image: firstImage(body),
        summary: summary.slice(0, 500) || null,
        tags: categories.filter((c) => !/^(news|altamura)$/i.test(c)).slice(0, 6),
        categories: classify(title, summary, categories.join(' ')),
      });
    }
  }

  return [...events.values()];
}

async function scrapeAltamuraLife() {
  let html;
  try {
    html = await getText(SOURCES.altamuralife.agenda);
  } catch (err) {
    console.warn(`  ! ${SOURCES.altamuralife.agenda}: ${err.message}`);
    return [];
  }

  const $ = cheerio.load(html);
  const events = [];

  $('.index-wrapper.event-section .index').each((_, node) => {
    const el = $(node);
    const anchor = el.find('.boxed-title .title a').first();
    const title = clean(anchor.text());
    const href = anchor.attr('href');
    if (!title || !href) return;

    // "Fino al 27 settembre" / "12 ottobre" + il luogo nel sotto-titolo.
    const info = clean(el.find('.infotitle').clone().find('.infotitle-sub').remove().end().text());
    const venue = clean(el.find('.infotitle-sub').text()) || null;
    const when = parseItalianDateRange(info) ?? parseItalianDateRange(title);

    const id = `life-${slugify(title)}`;
    events.push({
      id,
      title,
      url: new URL(href, SOURCES.altamuralife.homepage).toString(),
      source: SOURCES.altamuralife.name,
      sourceUrl: SOURCES.altamuralife.homepage,
      publishedAt: null,
      startDate: when?.start ?? null,
      endDate: when?.end ?? null,
      startTime: when?.startTime ?? null,
      venue: venue && venue.toLowerCase() !== 'altamura' ? venue : guessVenue(title),
      image: el.find('.boxed-img img').attr('src') ?? null,
      summary: info || null,
      tags: [],
      categories: classify(title, info),
    });
  });

  return events;
}

// Le due testate coprono gli stessi appuntamenti: teniamo una voce sola.
function dedupe(events) {
  const byKey = new Map();
  for (const event of events) {
    const key = slugify(event.title).split('-').slice(0, 6).join('-');
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, event);
      continue;
    }
    byKey.set(key, {
      ...existing,
      startDate: existing.startDate ?? event.startDate,
      endDate: existing.endDate ?? event.endDate,
      startTime: existing.startTime ?? event.startTime,
      venue: existing.venue ?? event.venue,
      image: existing.image ?? event.image,
      summary: existing.summary ?? event.summary,
      alsoOn: [...(existing.alsoOn ?? []), { source: event.source, url: event.url }],
    });
  }
  return [...byKey.values()];
}

export async function scrapeEvents() {
  console.log('> AltamuraLive (RSS eventi + cultura)');
  const live = await scrapeAltamuraLive();
  console.log(`  ${live.length} voci`);

  console.log('> AltamuraLife (agenda eventi)');
  const life = await scrapeAltamuraLife();
  console.log(`  ${life.length} voci`);

  const today = new Date().toISOString().slice(0, 10);
  const recentThreshold = new Date(Date.now() - 45 * 24 * 3600 * 1000).toISOString();

  const events = dedupe([...life, ...live])
    .map((event) => ({ ...event, dated: Boolean(event.startDate || event.endDate) }))
    .filter((event) => {
      // Gli appuntamenti conclusi escono dall'agenda. Le segnalazioni senza una
      // data riconoscibile restano solo se ancora fresche: sono spunti per la
      // sezione Scopri, non voci di calendario.
      if (event.dated) return !event.endDate || event.endDate >= today;
      return !event.publishedAt || event.publishedAt >= recentThreshold;
    })
    .sort((a, b) => {
      if (a.dated !== b.dated) return a.dated ? -1 : 1;
      if (a.dated) {
        return (a.startDate ?? a.endDate).localeCompare(b.startDate ?? b.endDate);
      }
      return (b.publishedAt ?? '').localeCompare(a.publishedAt ?? '');
    });

  return {
    generatedAt: new Date().toISOString(),
    sources: Object.values(SOURCES).map((s) => ({ name: s.name, url: s.homepage })),
    events,
  };
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());

if (invokedDirectly) {
  const fs = await import('node:fs/promises');
  const data = await scrapeEvents();
  await fs.mkdir('src/dati', { recursive: true });
  await fs.writeFile('src/dati/events.json', JSON.stringify(data, null, 2));
  console.log(`\nScritto src/dati/events.json (${data.events.length} eventi in agenda)`);
}
