import * as cheerio from 'cheerio';
import { XMLParser } from 'fast-xml-parser';
import { getText } from '../lib/http.mjs';
import { parseItalianDateRange } from '../lib/dates-it.mjs';
import { slugify } from '../lib/slug.mjs';

const SOURCES = {
  comune: {
    name: 'Comune di Altamura',
    homepage: 'https://www.comune.altamura.ba.it/it/eventi',
    api: 'https://altamura-api.municipiumapp.it/api/v2/events?tenant=182',
    detail: 'https://www.comune.altamura.ba.it/it/events/',
  },
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
  tacco: {
    name: 'Il Tacco di Bacco',
    homepage: 'https://iltaccodibacco.it/altamura/',
  },
  virgilio: {
    name: 'Virgilio Eventi',
    homepage: 'https://www.virgilio.it/italia/altamura/eventi/',
  },
  vitobarone: {
    name: 'Vito Barone',
    homepage: 'https://www.vitobarone.it/altamura/eventi.htm',
  },
};

const CATEGORY_RULES = [
  { category: 'trekking', re: /trekking|escursion|cammin|murgia|pulo|natura|bici|sentier/i },
  { category: 'cultura', re: /mostra|museo|libro|poesia|teatr|concert|arte|conferenz|present|storia|archeolog|cinema|corteo/i },
  {
    category: 'esperienze',
    re: /degustaz|laboratori|visita guidata|tour|sagra|mercat|gastronom|pane|masseria|festa|fiera|processione|palio/i,
  },
];

const parser = new XMLParser({ ignoreAttributes: false, trimValues: true });

const clean = (value) =>
  String(value ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&agrave;/g, 'à')
    .replace(/&egrave;/g, 'è')
    .replace(/&eacute;/g, 'é')
    .replace(/&igrave;/g, 'ì')
    .replace(/&ograve;/g, 'ò')
    .replace(/&ugrave;/g, 'ù')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#8217;|&rsquo;/g, '’')
    .replace(/\s+/g, ' ')
    .trim();

const asArray = (value) => (value == null ? [] : Array.isArray(value) ? value : [value]);

function isoInstant(value) {
  const date = new Date(String(value ?? '').replace(/([+-]\d{2})$/, '$1:00'));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const isAltamura = (...texts) => /\baltamura\b/i.test(texts.filter(Boolean).join(' '));

function classify(...texts) {
  const haystack = texts.filter(Boolean).join(' ');
  const matched = CATEGORY_RULES.filter((rule) => rule.re.test(haystack)).map((r) => r.category);
  return matched.length ? matched : ['eventi'];
}

function shortSummary(text, limit = 220) {
  const full = clean(text);
  if (!full) return null;
  if (full.length <= limit) return full;
  const cut = full.slice(0, limit);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return `${stop > limit * 0.5 ? cut.slice(0, stop + 1) : `${cut.replace(/[\s,;:]+\S*$/, '')}…`}`;
}

function guessVenue(text) {
  const match =
    /\b(?:presso|nei|nel|nella|negli|a|al|alla|all'|in)\s+((?:Dimora|Palazzo|Teatro|Chiesa|Chiostro|Monastero|Santuario|Museo|Masseria|Piazza|Largo|Claustro|Biblioteca|Parco|Giardini|Cattedrale|Auditorium|Anfiteatro|Villa|Centro)(?:\s+(?:di|del|della|dei|delle|dell'))?(?:\s+(?:SS\.|[A-ZÀ-Ü][\wÀ-ü'.]{1,})){1,4})/.exec(
      String(text ?? '')
    );
  return match ? clean(match[1]).replace(/[.,;]$/, '') : null;
}

function tidyVenue(value) {
  const text = clean(value)
    .replace(/\s*[-–]\s*Altamura\s*\(BA\)\s*$/i, '')
    .replace(/,?\s*(?:centro storico\s*)?Altamura\s*$/i, '')
    .replace(/[.,;]$/, '')
    .trim();
  return text && !/^altamura$/i.test(text) ? text : null;
}

async function scrapeComune() {
  const list = JSON.parse(await getText(SOURCES.comune.api, { headers: { Accept: 'application/json' } }));
  if (!Array.isArray(list)) throw new Error('risposta inattesa dall’agenda del Comune');

  return list
    .filter((event) => event.title && event.start_date)
    .map((event) => {
      const title = clean(event.title);
      const time = /T(\d{2}:\d{2})/.exec(event.start_time ?? '')?.[1] ?? null;
      return {
        id: `comune-${event.id}`,
        title,
        url: event.slug ? `${SOURCES.comune.detail}${event.slug}` : SOURCES.comune.homepage,
        source: SOURCES.comune.name,
        sourceUrl: SOURCES.comune.homepage,
        publishedAt: isoInstant(event.published_at),
        startDate: event.start_date,
        endDate: event.end_date ?? event.start_date,
        startTime: time,
        venue: tidyVenue(event.address) ?? guessVenue(`${title} ${clean(event.excerpt)}`),
        summary: shortSummary(event.excerpt),
        tags: asArray(event.event_categories)
          .map((c) => clean(c?.name ?? c))
          .filter(Boolean)
          .slice(0, 4),
        categories: classify(
          title,
          clean(event.excerpt),
          asArray(event.event_categories)
            .map((c) => c?.name ?? c)
            .join(' ')
        ),
      };
    });
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

      const reference = published ? new Date(published) : new Date();
      const when =
        parseItalianDateRange(title, reference) ??
        parseItalianDateRange(summary, reference) ??
        parseItalianDateRange(clean(body).slice(0, 1500), reference);

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
        summary: shortSummary(summary || body),
        tags: categories.filter((c) => !/^(news|altamura)$/i.test(c)).slice(0, 6),
        categories: classify(title, summary, categories.join(' ')),
      });
    }
  }

  return [...events.values()];
}

async function scrapeAltamuraLife() {
  const html = await getText(SOURCES.altamuralife.agenda);
  const $ = cheerio.load(html);
  const events = [];

  $('.index-wrapper.event-section .index').each((_, node) => {
    const el = $(node);
    const anchor = el.find('.boxed-title .title a').first();
    const title = clean(anchor.text());
    const href = anchor.attr('href');
    if (!title || !href) return;

    const info = clean(el.find('.infotitle').clone().find('.infotitle-sub').remove().end().text());
    const venue = tidyVenue(el.find('.infotitle-sub').text());
    const when = parseItalianDateRange(info) ?? parseItalianDateRange(title);

    events.push({
      id: `life-${slugify(title)}`,
      title,
      url: new URL(href, SOURCES.altamuralife.homepage).toString(),
      source: SOURCES.altamuralife.name,
      sourceUrl: SOURCES.altamuralife.homepage,
      publishedAt: null,
      startDate: when?.start ?? null,
      endDate: when?.end ?? null,
      startTime: when?.startTime ?? null,
      venue: venue ?? guessVenue(title),
      summary: shortSummary(info),
      tags: [],
      categories: classify(title, info),
    });
  });

  return events;
}

async function scrapeTacco() {
  const html = await getText(SOURCES.tacco.homepage);
  const events = [];

  for (const match of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    let data;
    try {
      data = JSON.parse(match[1]);
    } catch {
      continue;
    }
    if (data?.['@type'] !== 'Event' || !data.name || !data.startDate) continue;

    const [city, ...rest] = String(data.name).split('|');
    const title = clean(rest.join('|') || data.name);
    const place = clean(data.location?.name);
    if (!isAltamura(city, place)) continue;

    events.push({
      id: `tacco-${slugify(title)}`,
      title,
      url: data.url ?? SOURCES.tacco.homepage,
      source: SOURCES.tacco.name,
      sourceUrl: SOURCES.tacco.homepage,
      publishedAt: null,
      startDate: String(data.startDate).slice(0, 10),
      endDate: String(data.endDate ?? data.startDate).slice(0, 10),
      startTime: /T(\d{2}:\d{2})/.exec(String(data.startDate))?.[1] ?? null,
      venue: tidyVenue(place),
      summary: shortSummary(data.description),
      tags: [],
      categories: classify(title, clean(data.description)),
    });
  }

  return events;
}

const VIRGILIO_MONTHS = { gen: 1, feb: 2, mar: 3, apr: 4, mag: 5, giu: 6, lug: 7, ago: 8, set: 9, ott: 10, nov: 11, dic: 12 };

function virgilioDate(day, month, today = new Date()) {
  const number = VIRGILIO_MONTHS[String(month).slice(0, 3).toLowerCase()];
  if (!number) return null;
  const year = number < today.getMonth() + 1 - 6 ? today.getFullYear() + 1 : today.getFullYear();
  return `${year}-${String(number).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

async function scrapeVirgilio() {
  const html = await getText(SOURCES.virgilio.homepage);
  const $ = cheerio.load(html);
  const events = [];

  $('.eventBox').each((_, node) => {
    const el = $(node);
    const link = el
      .find('a[href*="/eventi/"]')
      .filter((__, a) => /_\d+_\d+$/.test($(a).attr('href') ?? ''))
      .first();
    const href = link.attr('href');
    const title = clean(link.attr('title') ?? link.text());
    const text = clean(el.text());
    if (!href || !title) return;

    const where = clean(el.find('.eventContent, .eventInfo').last().text());
    if (!isAltamura(where, text.slice(-160))) return;

    const range = /Dal\s+(\d{1,2})\s+([A-Za-z]{3,})\s+Al\s+(\d{1,2})\s+([A-Za-z]{3,})/i.exec(text);
    const single = /(?:^|\s)(\d{1,2})\s+([A-Za-z]{3})(?:\s|$)/.exec(text);
    const start = range ? virgilioDate(range[1], range[2]) : single ? virgilioDate(single[1], single[2]) : null;
    const end = range ? virgilioDate(range[3], range[4]) : start;

    events.push({
      id: `virgilio-${slugify(title)}`,
      title,
      url: new URL(href, 'https://www.virgilio.it').toString(),
      source: SOURCES.virgilio.name,
      sourceUrl: SOURCES.virgilio.homepage,
      publishedAt: null,
      startDate: start,
      endDate: end,
      startTime: null,
      venue: tidyVenue(/^(.*?)\s*-\s*Altamura/i.exec(where)?.[1] ?? null),
      summary: shortSummary(el.find('.eventContent').first().text()),
      tags: el
        .find('.categoria_ev a')
        .map((__, a) => clean($(a).text()))
        .get()
        .slice(0, 3),
      categories: classify(title, text),
    });
  });

  return events;
}

async function scrapeVitoBarone() {
  const html = (await getText(SOURCES.vitobarone.homepage)).replace(/^﻿/, '');
  const $ = cheerio.load(html);
  const events = [];
  const today = new Date();

  $('td').each((_, cell) => {
    const text = clean($(cell).text());
    const split = /^(.{4,70}?[a-zà-ù0-9)])([A-ZÀ-Ù][^]*)$/.exec(text);
    if (!split) return;
    const when = split[1].trim();
    const title = clean(split[2]).replace(/\s*-\s*$/, '');
    if (
      !title ||
      title.length < 4 ||
      !/\d/.test(when) ||
      !/gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre/i.test(when)
    )
      return;

    const range = parseItalianDateRange(when, today);
    if (!range?.start) return;

    const shift = (iso) => {
      if (!iso) return null;
      const date = new Date(`${iso}T12:00:00`);
      if (date >= new Date(today.toDateString())) return iso;
      date.setFullYear(date.getFullYear() + 1);
      return date.toISOString().slice(0, 10);
    };

    events.push({
      id: `ricorrenza-${slugify(title)}`,
      title,
      url: SOURCES.vitobarone.homepage,
      source: SOURCES.vitobarone.name,
      sourceUrl: SOURCES.vitobarone.homepage,
      publishedAt: null,
      startDate: /\d{4}/.test(when) ? range.start : shift(range.start),
      endDate: /\d{4}/.test(when) ? (range.end ?? range.start) : shift(range.end ?? range.start),
      startTime: null,
      venue: guessVenue(title),
      summary: `Appuntamento fisso del calendario altamurano: ${when.toLowerCase()}.`,
      tags: ['Ricorrenza'],
      categories: classify(title),
      annual: true,
    });
  });

  return events;
}

function dedupe(events) {
  const byKey = new Map();
  for (const event of events) {
    const key = `${slugify(event.title).split('-').slice(0, 5).join('-')}|${event.startDate ?? ''}`;
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
      summary: existing.summary ?? event.summary,
      tags: existing.tags?.length ? existing.tags : event.tags,
      alsoOn: [...(existing.alsoOn ?? []), { source: event.source, url: event.url }],
    });
  }

  const merged = [];
  for (const event of byKey.values()) {
    const first = keywords(event.title)[0];
    const twin = first && first.length >= 5 ? merged.find((other) => overlap(other, event) && keywords(other.title)[0] === first) : null;
    if (!twin) {
      merged.push({ ...event });
      continue;
    }
    twin.startDate ??= event.startDate;
    twin.endDate ??= event.endDate;
    twin.startTime ??= event.startTime;
    twin.venue ??= event.venue;
    twin.summary ??= event.summary;
    twin.alsoOn = [...(twin.alsoOn ?? []), { source: event.source, url: event.url }];
  }

  return merged.filter((event) => {
    if (event.startDate || event.endDate) return true;
    const words = new Set(keywords(event.title));
    if (words.size < 2) return true;
    const twin = merged.find(
      (other) => (other.startDate || other.endDate) && keywords(other.title).filter((word) => words.has(word)).length >= words.size
    );
    if (!twin) return true;
    twin.alsoOn = [...(twin.alsoOn ?? []), { source: event.source, url: event.url }];
    return false;
  });
}

const STOPWORDS = new Set([
  'altamura',
  'della',
  'delle',
  'degli',
  'edizione',
  'festival',
  'festa',
  'rassegna',
  'evento',
  'anno',
  'giorni',
  'nella',
  'tradizionali',
]);

const keywords = (title) =>
  slugify(title)
    .split('-')
    .filter((word) => word.length > 3 && !STOPWORDS.has(word) && !/^\d+$/.test(word));

function overlap(a, b) {
  const startA = a.startDate ?? a.endDate;
  const startB = b.startDate ?? b.endDate;
  if (!startA || !startB) return false;
  return (a.endDate ?? startA) >= startB && (b.endDate ?? startB) >= startA;
}

async function collect(label, scrape) {
  process.stdout.write(`> ${label} ... `);
  try {
    const events = await scrape();
    console.log(`${events.length} voci`);
    return events;
  } catch (err) {
    console.log(`non raggiungibile (${err.message})`);
    return [];
  }
}

function isoDay(value) {
  const text = typeof value === 'string' ? value.trim().slice(0, 10) : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const [year, month, day] = text.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? text : null;
}

export async function scrapeEvents() {
  const fromSources = [
    await collect(SOURCES.comune.name, scrapeComune),
    await collect(SOURCES.altamuralive.name, scrapeAltamuraLive),
    await collect(SOURCES.altamuralife.name, scrapeAltamuraLife),
    await collect(SOURCES.tacco.name, scrapeTacco),
    await collect(SOURCES.virgilio.name, scrapeVirgilio),
    await collect(SOURCES.vitobarone.name, scrapeVitoBarone),
  ];

  const today = new Date().toISOString().slice(0, 10);
  const recentThreshold = new Date(Date.now() - 45 * 24 * 3600 * 1000).toISOString();

  const events = dedupe(fromSources.flat())
    .map((event) => ({ ...event, startDate: isoDay(event.startDate), endDate: isoDay(event.endDate) }))
    .map((event) => ({ ...event, dated: Boolean(event.startDate || event.endDate) }))
    .filter((event) => {
      if (event.dated) return !event.endDate || event.endDate >= today;
      return !event.publishedAt || event.publishedAt >= recentThreshold;
    })
    .sort((a, b) => {
      if (a.dated !== b.dated) return a.dated ? -1 : 1;
      if (a.dated) return (a.startDate ?? a.endDate).localeCompare(b.startDate ?? b.endDate);
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
