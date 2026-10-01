const MONTHS = {
  gennaio: 1,
  febbraio: 2,
  marzo: 3,
  aprile: 4,
  maggio: 5,
  giugno: 6,
  luglio: 7,
  agosto: 8,
  settembre: 9,
  ottobre: 10,
  novembre: 11,
  dicembre: 12,
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

const MONTH_NAMES = Object.keys(MONTHS).join('|');
const DAY = String.raw`(\d{1,2})°?`;
const FROM = String.raw`\bdal(?:l['’]\s*|\s+)`;
const TO = String.raw`\s+al(?:l['’]\s*|\s+)`;
const YEAR = String.raw`(?:\s+(20\d{2}))?`;
const CROSS_RE = new RegExp(String.raw`${FROM}${DAY}\s+(${MONTH_NAMES})${YEAR}${TO}${DAY}\s+(${MONTH_NAMES})${YEAR}\b`, 'i');
const RANGE_RE = new RegExp(String.raw`${FROM}${DAY}${TO}${DAY}\s+(${MONTH_NAMES})${YEAR}\b`, 'i');
const UNTIL_RE = new RegExp(String.raw`\bfino\s+al(?:l['’]\s*|\s+)${DAY}\s+(${MONTH_NAMES})${YEAR}\b`, 'i');
const SINGLE_RE = new RegExp(String.raw`(?<![\p{L}\d])${DAY}\s+(${MONTH_NAMES})${YEAR}\b`, 'giu');
const STREET_BEFORE = /\b(via|viale|v\.le|piazza|p\.zza|piazzetta|corso|c\.so|largo|vico|vicolo|contrada|strada)\s+$/i;
const NUM = String.raw`(\d{1,2})[./-](\d{1,2})[./-](\d{4}|\d{2})(?!\d)`;
const NUM_RANGE_RE = new RegExp(String.raw`\bdal?\s+${NUM}\s+al\s+${NUM}`, 'i');
const NUM_RE = new RegExp(String.raw`(?<!\d)${NUM}`);
const TIME_RE = /\b(?:(?:ore|alle|dalle)\s+)?([01]?\d|2[0-3]):([0-5]\d)\b|\b(?:ore|alle|dalle)\s+([01]?\d|2[0-3])[.,]([0-5]\d)\b/i;

const fullYear = (year) => (year.length === 2 ? 2000 + Number(year) : Number(year));
const DAY_MS = 24 * 3600 * 1000;

function iso(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function resolveYear(month, day, reference) {
  const year = reference.getFullYear();
  const candidate = new Date(year, month - 1, day).getTime();
  if (candidate < reference.getTime() - 62 * DAY_MS) return year + 1;
  if (candidate > reference.getTime() + 300 * DAY_MS) return year - 1;
  return year;
}

const monthOf = (name) => MONTHS[name.toLowerCase()];

export function parseItalianDateRange(text, reference = new Date()) {
  const source = String(text ?? '');
  if (!source) return null;

  const time = TIME_RE.exec(source.replace(new RegExp(NUM, 'g'), ' '));
  const hours = time ? (time[1] ?? time[3]) : null;
  const startTime = time ? `${hours.padStart(2, '0')}:${time[2] ?? time[4]}` : null;

  const numRange = NUM_RANGE_RE.exec(source);
  if (numRange) {
    const start = iso(fullYear(numRange[3]), Number(numRange[2]), Number(numRange[1]));
    const end = iso(fullYear(numRange[6]), Number(numRange[5]), Number(numRange[4]));
    if (start && end) return { start, end: end >= start ? end : start, startTime };
  }

  const cross = CROSS_RE.exec(source);
  if (cross) {
    const fromMonth = monthOf(cross[2]);
    const toMonth = monthOf(cross[5]);
    const fromDay = Number(cross[1]);
    const toDay = Number(cross[4]);
    let fromYear = cross[3] ? Number(cross[3]) : null;
    let toYear = cross[6] ? Number(cross[6]) : null;
    if (fromYear == null && toYear != null) fromYear = toMonth < fromMonth ? toYear - 1 : toYear;
    fromYear ??= resolveYear(fromMonth, fromDay, reference);
    toYear ??= toMonth < fromMonth ? fromYear + 1 : fromYear;
    const start = iso(fromYear, fromMonth, fromDay);
    const end = iso(toYear, toMonth, toDay);
    if (start && end) return { start, end: end >= start ? end : start, startTime };
  }

  const range = RANGE_RE.exec(source);
  if (range) {
    const month = monthOf(range[3]);
    const fromDay = Number(range[1]);
    const year = range[4] ? Number(range[4]) : resolveYear(month, fromDay, reference);
    const start = iso(year, month, fromDay);
    const end = iso(year, month, Number(range[2]));
    if (start && end) return { start, end: end >= start ? end : start, startTime };
  }

  const until = UNTIL_RE.exec(source);
  if (until) {
    const month = monthOf(until[2]);
    const day = Number(until[1]);
    const end = iso(until[3] ? Number(until[3]) : resolveYear(month, day, reference), month, day);
    if (end) return { start: null, end, startTime };
  }

  const numeric = NUM_RE.exec(source);
  if (numeric) {
    const start = iso(fullYear(numeric[3]), Number(numeric[2]), Number(numeric[1]));
    if (start) return { start, end: start, startTime };
  }

  for (const single of source.matchAll(SINGLE_RE)) {
    if (STREET_BEFORE.test(source.slice(0, single.index))) continue;
    const month = monthOf(single[2]);
    const day = Number(single[1]);
    const start = iso(single[3] ? Number(single[3]) : resolveYear(month, day, reference), month, day);
    if (start) return { start, end: start, startTime };
  }

  return null;
}

/** La data di caricamento di un file di WordPress (".../wp-content/uploads/2026/10/..."), se c'e'. */
export function publishedOn(url) {
  const match = /\/uploads\/(20\d{2})\/(\d{2})\//.exec(String(url ?? ''));
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, 15) : null;
}

/**
 * Corregge l'anno sbagliato di una data scritta dall'operatore. Un avviso o un orario parla di
 * giorni vicini a quando e' stato pubblicato: se l'anno scritto lo allontana di piu' di otto mesi
 * e lo stesso giorno di un anno vicino cade a ridosso della pubblicazione, vale quell'anno.
 */
export function plausibleDay(isoDay, reference) {
  if (!reference) return isoDay ?? null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDay ?? '');
  if (!match) return isoDay ?? null;
  const [, year, month, day] = match.map(Number);
  const at = (y) => new Date(y, month - 1, day).getTime();
  const distance = (y) => at(y) - reference.getTime();
  if (Math.abs(distance(year)) <= 240 * DAY_MS) return isoDay;
  const candidates = [reference.getFullYear() - 1, reference.getFullYear(), reference.getFullYear() + 1].filter(
    (y) => distance(y) >= -90 * DAY_MS && distance(y) <= 240 * DAY_MS
  );
  if (!candidates.length) return isoDay;
  const best = candidates.sort((a, b) => Math.abs(distance(a)) - Math.abs(distance(b)))[0];
  return `${best}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
