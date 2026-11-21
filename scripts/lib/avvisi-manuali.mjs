import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { slugify } from './slug.mjs';
import { noticeOnlyAt, noticeStops, noticeTimes } from './avvisi.mjs';
import { listedDays, parseItalianDateRange } from './dates-it.mjs';

// Avvisi scritti a mano in scripts/data/avvisi-manuali.json. Ogni giro li unisce a quelli
// generati dallo scraper, saltando quelli che ci sono gia' (stesso avviso del sito o stesso titolo).
export const MANUAL_FILE = fileURLToPath(new URL('../data/avvisi-manuali.json', import.meta.url));

const DAY = /^\d{4}-\d{2}-\d{2}$/;

// Avvisi che si ripetono ogni settimana: "giorni": ["sabato"] nel file, oppure "ogni sabato" nel testo.
const WEEKDAYS = ['domenica', 'lunedi', 'martedi', 'mercoledi', 'giovedi', 'venerdi', 'sabato'];
const weekdayOf = (name) => WEEKDAYS.indexOf(sameText(name).replace(/ /g, ''));

export function weeklyDays(entry) {
  const named = (Array.isArray(entry.giorni) ? entry.giorni : entry.giorni ? [entry.giorni] : []).map(weekdayOf);
  const written = [...sameText(`${entry.titolo} ${entry.testo}`).matchAll(/\bogni (domenica|lunedi|martedi|mercoledi|giovedi|venerdi|sabato)\b/g)].map(
    (match) => weekdayOf(match[1])
  );
  return [...new Set([...named, ...written].filter((day) => day >= 0))].sort();
}

// Il primo giorno da oggi in poi che cade in uno dei giorni della settimana (0 = domenica).
export function nextWeekday(today, days) {
  for (let n = 0; n < 7; n += 1) {
    const day = new Date(`${today}T12:00:00Z`);
    day.setUTCDate(day.getUTCDate() + n);
    if (days.includes(day.getUTCDay())) return day.toISOString().slice(0, 10);
  }
  return null;
}

// Gli avvisi manuali di una linea finiscono anche nei campi "notice" della linea in transport.json,
// con un link a questa pagina del sito (la serve il worker di aspitt.it leggendo alerts.json).
export const MANUAL_URL = 'https://aspitt.it/avvisi/';
export const isManualUrl = (url) => String(url ?? '').startsWith(MANUAL_URL);
const NOTICE_KEYS = ['noticeUrl', 'noticeFrom', 'noticeUntil', 'noticeStart', 'noticeEnd', 'noticeStops', 'noticeOnlyAt', 'noticeText'];

// Testo confrontabile: senza accenti, maiuscole, punteggiatura e spazi doppi.
export const sameText = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const sameUrl = (value) =>
  String(value ?? '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/#.*$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();

export async function readManual(file = MANUAL_FILE) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    return Array.isArray(parsed?.avvisi) ? parsed.avvisi : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw new Error(`avvisi-manuali.json non leggibile: ${err.message}`);
  }
}

// La linea si puo' scrivere come id ("ospedale-2") o come nome ("Ospedale 2"). Vuota = avviso generico.
export function findLine(lines, value) {
  if (!value) return null;
  const key = slugify(value);
  return (
    lines.find((line) => line.id === key) ??
    lines.find((line) => slugify(line.name) === key) ??
    lines.find((line) => slugify(line.name).replace(/^linea-/, '') === key.replace(/^linea-/, '')) ??
    null
  );
}

export function manualId(entry) {
  const hash = crypto
    .createHash('sha1')
    .update(`${sameText(entry.titolo)}|${slugify(entry.linea ?? '')}|${entry.dal ?? ''}`)
    .digest('hex')
    .slice(0, 8);
  return `manuale-${slugify(entry.titolo).slice(0, 40)}-${hash}`;
}

/**
 * @param {object[]} entries     voci di avvisi-manuali.json
 * @param {object[]} existing    avvisi gia' presenti (generati in questo giro + quelli dei giri precedenti)
 * @param {object}   transport   dati dei trasporti, per le linee e gli avvisi pubblicati dal sito
 * @param {object[]} previous    avvisi del giro precedente, per tenere la data di creazione
 * @param {string}   today       YYYY-MM-DD in ora italiana
 */
export function manualAlerts(entries, existing, transport, previous, today, now = new Date().toISOString()) {
  const lines = transport?.lines ?? [];
  const added = [];
  const log = [];

  const titles = new Set(existing.map((a) => `${a.lineId ?? ''}|${sameText(a.title)}`));
  const anyLineTitles = new Set(existing.map((a) => sameText(a.title)));
  const siteLines = lines.filter((line) => !isManualUrl(line.noticeUrl));
  const urls = new Set(
    [...existing.map((a) => a.url), ...siteLines.map((line) => line.noticeUrl), ...(transport?.news ?? []).map((n) => n.url)]
      .filter(Boolean)
      .map(sameUrl)
  );
  const siteTexts = siteLines.map((line) => sameText(line.noticeText)).filter(Boolean);

  for (const [index, entry] of entries.entries()) {
    const where = `avviso manuale ${index + 1}${entry?.titolo ? ` "${entry.titolo}"` : ''}`;
    if (!entry || typeof entry !== 'object' || !String(entry.titolo ?? '').trim() || !String(entry.testo ?? '').trim()) {
      log.push(`${where}: saltato, servono "titolo" e "testo"`);
      continue;
    }
    for (const key of ['dal', 'fino']) {
      if (entry[key] != null && entry[key] !== '' && !DAY.test(entry[key])) {
        log.push(`${where}: "${key}" deve essere nel formato AAAA-MM-GG, ignorato`);
        entry[key] = null;
      }
    }
    if (entry.fino && entry.fino < today) {
      log.push(`${where}: scaduto il ${entry.fino}, non pubblicato (si puo' togliere dal file)`);
      continue;
    }
    if (entry.dal && entry.dal > today) {
      log.push(`${where}: sara' pubblicato dal ${entry.dal}`);
      continue;
    }

    let lineId = null;
    let lineName = null;
    if (entry.linea) {
      const line = findLine(lines, entry.linea);
      if (line) [lineId, lineName] = [line.id, line.name];
      else log.push(`${where}: linea "${entry.linea}" non trovata, pubblicato come avviso generico`);
    }

    const title = String(entry.titolo).trim();
    const body = String(entry.testo).trim();
    const titleKey = sameText(title);
    if (titles.has(`${lineId ?? ''}|${titleKey}`) || (!lineId && anyLineTitles.has(titleKey))) {
      log.push(`${where}: c'e' gia' un avviso con lo stesso titolo, non aggiunto`);
      continue;
    }
    if (entry.link && urls.has(sameUrl(entry.link))) {
      log.push(`${where}: lo stesso avviso e' gia' pubblicato (stesso link), non aggiunto`);
      continue;
    }
    const bodyKey = sameText(body);
    if (bodyKey.length > 40 && siteTexts.some((text) => text.includes(bodyKey) || bodyKey.includes(text))) {
      log.push(`${where}: lo stesso testo e' gia' negli avvisi del sito, non aggiunto`);
      continue;
    }

    const id = manualId(entry);
    const before = previous.find((a) => a.id === id);
    const alert = {
      id,
      severity: entry.gravita === 'warning' || entry.gravita === 'importante' ? 'warning' : 'info',
      ...(lineId ? { lineId, lineName } : {}),
      title,
      body,
      ...(entry.link ? { url: String(entry.link).trim() } : {}),
      createdAt: before?.createdAt ?? now,
      ...(entry.fino ? { validUntil: entry.fino } : {}),
      source: 'manuale',
    };
    added.push(alert);
    titles.add(`${lineId ?? ''}|${titleKey}`);
    anyLineTitles.add(titleKey);
    if (alert.url) urls.add(sameUrl(alert.url));
    log.push(`${where}: pubblicato${lineId ? ` sulla linea ${lineId}` : ' come avviso generico'}`);
  }

  return { added, log };
}

/**
 * Scrive gli avvisi manuali di una linea nei suoi campi "notice" di transport.json: e' li' che l'app
 * legge avvisi, banner in Home e notifiche (alerts.json l'app non lo scarica). Giorno, orari e fermate
 * soppresse si ricavano dal testo come per gli avvisi dell'operatore ("il 22.11.2026 dalle 11:30 alle 17:00
 * saranno soppresse le fermate da via IV Novembre a via Bari 150"). Un avviso settimanale ("ogni sabato") va
 * nell'app come avviso del prossimo sabato. Si puo' rifare a ogni giro: prima
 * toglie quelli del giro precedente. Un avviso dell'operatore ancora valido sulla stessa linea ha la precedenza.
 */
export function applyManualNotices(transport, entries, today) {
  const log = [];
  const lines = transport?.lines ?? [];
  for (const line of lines) {
    if (!isManualUrl(line.noticeUrl)) continue;
    for (const key of NOTICE_KEYS) line[key] = key === 'noticeStops' ? [] : null;
  }
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || !String(entry.titolo ?? '').trim() || !String(entry.testo ?? '').trim()) continue;
    const fino = DAY.test(entry.fino ?? '') ? entry.fino : null;
    const dal = DAY.test(entry.dal ?? '') ? entry.dal : null;
    if ((fino && fino < today) || (dal && dal > today)) continue;
    const where = `"${entry.titolo}"`;
    if (!entry.linea) {
      log.push(`${where}: senza linea resta solo nel sito, l'app mostra gli avvisi di una linea`);
      continue;
    }
    const line = findLine(lines, entry.linea);
    if (!line) continue;
    if (isManualUrl(line.noticeUrl)) {
      log.push(`${where}: la linea ${line.id} ha gia' un altro avviso manuale, nell'app va il primo`);
      continue;
    }
    if (line.noticeUrl && (line.noticeUntil ?? line.noticeFrom ?? today) >= today) {
      log.push(`${where}: la linea ${line.id} ha un avviso dell'operatore ancora valido, nell'app resta quello`);
      continue;
    }
    const text = `${entry.titolo}. ${entry.testo}`;
    let range = parseItalianDateRange(text, new Date(`${today}T12:00:00`));
    const days = listedDays(text);
    const weekly = weeklyDays(entry);
    let occurrence = null;
    if (weekly.length) {
      // Nell'app va la prossima volta (oggi compreso); dopo quel giorno il giro successivo passa a quella dopo.
      occurrence = nextWeekday(today, weekly);
      range = { start: occurrence, end: occurrence };
    } else if (days.length > 1) {
      const next = days.find((day) => day >= today) ?? days[days.length - 1];
      range = { start: next, end: next };
    }
    const times = noticeTimes(text);
    const onlyAt = noticeOnlyAt(text);
    Object.assign(line, {
      // L'app notifica un avviso una volta sola per indirizzo: con il giorno nell'indirizzo un avviso
      // settimanale torna a notificare ogni settimana (la pagina su aspitt.it ignora il "?giorno=").
      noticeUrl: `${MANUAL_URL}${manualId(entry)}/${occurrence ? `?giorno=${occurrence}` : ''}`,
      noticeFrom: range?.start ?? dal ?? today,
      noticeUntil: range?.end ?? fino,
      noticeStart: times.from,
      noticeEnd: times.to,
      noticeStops: noticeStops(text, line.stops, '', []),
      noticeOnlyAt: onlyAt ? { name: onlyAt, address: null, lat: null, lon: null } : null,
      noticeText: String(entry.testo).trim().slice(0, 1200),
    });
    log.push(
      `${where}: nell'app sulla linea ${line.id}, ${line.noticeFrom}${line.noticeUntil && line.noticeUntil !== line.noticeFrom ? ` - ${line.noticeUntil}` : ''}` +
        `${line.noticeStart ? ` dalle ${line.noticeStart}` : ''}${line.noticeEnd ? ` alle ${line.noticeEnd}` : ''}` +
        `${line.noticeStops.length ? `, ${line.noticeStops.length} fermate soppresse` : ''}`
    );
  }
  return log;
}
