import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { slugify } from './slug.mjs';

// Avvisi scritti a mano in scripts/data/avvisi-manuali.json. Ogni giro li unisce a quelli
// generati dallo scraper, saltando quelli che ci sono gia' (stesso avviso del sito o stesso titolo).
export const MANUAL_FILE = fileURLToPath(new URL('../data/avvisi-manuali.json', import.meta.url));

const DAY = /^\d{4}-\d{2}-\d{2}$/;

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
  const urls = new Set(
    [...existing.map((a) => a.url), ...lines.map((line) => line.noticeUrl), ...(transport?.news ?? []).map((n) => n.url)]
      .filter(Boolean)
      .map(sameUrl)
  );
  const siteTexts = lines.map((line) => sameText(line.noticeText)).filter(Boolean);

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
    if (entry.linea) {
      const line = findLine(lines, entry.linea);
      if (line) lineId = line.id;
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
      ...(lineId ? { lineId } : {}),
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
