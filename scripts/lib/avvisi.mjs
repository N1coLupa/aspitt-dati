const fold = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[’`]/g, "'")
    .toLowerCase();

const STREET_PREFIX =
  /^(via|viale|v\.le|piazza|p\.zza|p\.za|piazzetta|corso|c\.so|largo|l\.go|vico|vicolo|contrada|c\.da|strada|s\.p\.|sp|s\.s\.|ss)\s+/;
const NEGATION = /\bnon\b|soppress|sospes|chius|interdett|vietat|esclus/;
const DETOUR_BEFORE =
  /\b(per|lungo|attraverso)\s+(\S+\s+)?$|\b(percorrendo|transitando|proseguendo|deviando|provvisori\w*|sostitutiv\w*|istituit\w*|sostituzione)\b[^,]*$/;

const hhmm = (hours, minutes) => {
  const h = Number(hours);
  const m = Number(minutes ?? 0);
  if (h > 24 || m > 59 || (h === 24 && m)) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

export function noticeTimes(text) {
  const source = fold(text);
  const from = /\b(?:dalle|a partire dalle)\s+(?:ore\s+)?(\d{1,2})(?:[:.,](\d{2}))?(?![\d./-])/.exec(source);
  if (!from) return { from: null, to: null };
  const rest = source.slice(from.index + from[0].length, from.index + from[0].length + 40);
  const to = /^\s*(?:e\s+)?(?:fino\s+)?alle\s+(?:ore\s+)?(\d{1,2})(?:[:.,](\d{2}))?(?![\d./-])/.exec(rest);
  return { from: hhmm(from[1], from[2]), to: to ? hhmm(to[1], to[2]) : null };
}

export function streetOf(stopName) {
  const base = fold(stopName)
    .replace(/\(.*?\)/g, ' ')
    .replace(/\s+(n\.?\s*)?\d+.*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const core = base.replace(STREET_PREFIX, '').trim();
  return core.length >= 4 ? core : null;
}

export function noticeStops(text, stops) {
  const source = fold(text).replace(/\s+/g, ' ');
  if (!source || !NEGATION.test(source)) return [];
  const skipped = new Set();
  for (const stop of stops) {
    if (!stop.stopId) continue;
    const street = streetOf(stop.name);
    if (!street) continue;
    const pattern = new RegExp(`(?<![\\p{L}])${street.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}])`, 'gu');
    for (const match of source.matchAll(pattern)) {
      const before = source
        .slice(Math.max(0, match.index - 60), match.index)
        .split(/[.:;]\s/)
        .pop();
      if (DETOUR_BEFORE.test(before) && !/\bnon\b/.test(before.slice(-40))) continue;
      skipped.add(stop.stopId);
      break;
    }
  }
  return [...skipped];
}
