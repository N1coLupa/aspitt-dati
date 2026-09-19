// I titoli e le didascalie delle testate locali datano gli eventi in italiano
// discorsivo ("il 29 luglio", "dal 3 al 5 ottobre", "Fino al 27 settembre").
// Qui li riduciamo a date ISO utilizzabili per ordinare e filtrare l'agenda.

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
const RANGE_RE = new RegExp(`\\bdal?\\s+(\\d{1,2})\\s+al\\s+(\\d{1,2})\\s+(${MONTH_NAMES})\\b`, 'i');
const CROSS_RE = new RegExp(`\\bdal?\\s+(\\d{1,2})\\s+(${MONTH_NAMES})\\s+al\\s+(\\d{1,2})\\s+(${MONTH_NAMES})\\b`, 'i');
const SINGLE_RE = new RegExp(`\\b(\\d{1,2})\\s+(${MONTH_NAMES})\\b`, 'i');
const UNTIL_RE = new RegExp(`\\bfino\\s+al\\s+(\\d{1,2})\\s+(${MONTH_NAMES})\\b`, 'i');
const TIME_RE = /\b(?:ore\s+)?([01]?\d|2[0-3])[:.](\d{2})\b/;

const iso = (year, month, day) => `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

// Senza anno esplicito, una data gia' passata da oltre due mesi appartiene
// all'edizione dell'anno prossimo, non a quella appena conclusa.
function resolveYear(month, day, reference) {
  const year = reference.getUTCFullYear();
  const candidate = Date.UTC(year, month - 1, day);
  const twoMonthsAgo = reference.getTime() - 62 * 24 * 3600 * 1000;
  return candidate < twoMonthsAgo ? year + 1 : year;
}

export function parseItalianDateRange(text, reference = new Date()) {
  const source = String(text ?? '');
  if (!source) return null;

  const explicitYear = /\b(20\d{2})\b/.exec(source)?.[1];
  const withYear = (month, day) => iso(explicitYear ? Number(explicitYear) : resolveYear(month, day, reference), month, day);

  const time = TIME_RE.exec(source);
  const startTime = time ? `${time[1].padStart(2, '0')}:${time[2]}` : null;

  const cross = CROSS_RE.exec(source);
  if (cross) {
    const fromMonth = MONTHS[cross[2].toLowerCase()];
    const toMonth = MONTHS[cross[4].toLowerCase()];
    return {
      start: withYear(fromMonth, Number(cross[1])),
      end: withYear(toMonth, Number(cross[3])),
      startTime,
    };
  }

  const range = RANGE_RE.exec(source);
  if (range) {
    const month = MONTHS[range[3].toLowerCase()];
    return {
      start: withYear(month, Number(range[1])),
      end: withYear(month, Number(range[2])),
      startTime,
    };
  }

  const until = UNTIL_RE.exec(source);
  if (until) {
    const month = MONTHS[until[2].toLowerCase()];
    const end = withYear(month, Number(until[1]));
    return { start: null, end, startTime };
  }

  const single = SINGLE_RE.exec(source);
  if (single) {
    const month = MONTHS[single[2].toLowerCase()];
    const start = withYear(month, Number(single[1]));
    return { start, end: start, startTime };
  }

  return null;
}
