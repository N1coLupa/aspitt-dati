const fold = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[’`]/g, "'")
    .toLowerCase();

const plain = (value) =>
  fold(value)
    .replace(/\bp\.?\s?zza\b/g, 'piazza')
    .replace(/\bv\.?\s?le\b/g, 'viale')
    .replace(/\bc\.?\s?so\b/g, 'corso')
    .replace(/\bfr\.\s/g, 'fronte ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const STREET_PREFIX =
  /^(via|viale|v\.le|piazza|p\.zza|p\.za|piazzetta|corso|c\.so|largo|l\.go|vico|vicolo|contrada|c\.da|strada|s\.p\.|sp|s\.s\.|ss)\s+/;
const NEGATION = /\bnon\b|soppress|sospes|chius|interdett|vietat|esclus/;
const ONLY =
  /\bgarantit\w*\s+(?:solo|soltanto|unicamente)\b|\b(?:solo|soltanto|unicamente)\s+(?:le\s+)?(?:seguenti\s+)?fermate\b|\beffettuer\w*\s+solo\b/;
const DETOUR_BEFORE =
  /\b(per|lungo|attraverso)\s+(\S+\s+)?$|\b(percorrendo|transitando|proseguendo|deviando|provvisori\w*|sostitutiv\w*|istituit\w*|sostituzione)\b[^,]*$/;
const RANGE_START = /\b(?:da|dalla|dal|dalle)\s*$/;
const RANGE_GAP = /^\s*(?:a|al|alla|fino\s+a|fino\s+al|fino\s+alla|sino\s+a|sino\s+al)\s*$/;

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

export function lineSection(text, lineName, lineNames = []) {
  const source = plain(text);
  const known = [...new Set([lineName, ...lineNames].map(plain).filter(Boolean))].flatMap((name) =>
    [...source.matchAll(new RegExp(`\\blinea\\s+${name}(?![a-z0-9])`, 'g'))].map((m) => ({ name, at: m.index }))
  );
  // Anche le linee che Muevt non conosce (es. "linea jesce") chiudono la sezione della linea precedente.
  const others = [...source.matchAll(/\blinea\s+[a-z0-9]+/g)]
    .filter((m) => !known.some((mark) => mark.at === m.index))
    .map((m) => ({ name: m[0], at: m.index }));
  const marks = [...known, ...others].sort((a, b) => a.at - b.at);
  const own = plain(lineName);
  const mine = marks.filter((mark) => mark.name === own);
  if (!mine.length) return source;
  return mine
    .map((mark) => {
      const next = marks.find((other) => other.at > mark.at && other.name !== own);
      return source.slice(mark.at, next ? next.at : undefined);
    })
    .join(' ');
}

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function noticeStops(text, stops, lineName = '', lineNames = []) {
  const section = lineName ? lineSection(text, lineName, lineNames) : plain(text);
  if (!section) return [];
  const ordered = [];
  const seen = new Set();
  for (const stop of [...stops].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))) {
    if (!stop.stopId || seen.has(stop.stopId)) continue;
    seen.add(stop.stopId);
    ordered.push({ stopId: stop.stopId, name: plain(String(stop.name).replace(/\*+$/, '')), raw: stop.name });
  }

  const mentions = [];
  ordered.forEach((stop, position) => {
    if (stop.name.length < 6) return;
    for (const match of section.matchAll(new RegExp(`(?<![a-z0-9])${escape(stop.name)}(?![a-z0-9])`, 'g'))) {
      mentions.push({ position, start: match.index, end: match.index + stop.name.length });
    }
  });
  mentions.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept = mentions.filter(
    (mention, index) => !mentions.slice(0, index).some((other) => other.start <= mention.start && other.end >= mention.end)
  );

  const chosen = new Set();
  for (let i = 0; i < kept.length; i += 1) {
    const mention = kept[i];
    const next = kept[i + 1];
    const before = section.slice(Math.max(0, mention.start - 12), mention.start);
    if (next && RANGE_START.test(before) && RANGE_GAP.test(section.slice(mention.end, next.start))) {
      const [low, high] = mention.position <= next.position ? [mention.position, next.position] : [next.position, mention.position];
      for (let p = low; p <= high; p += 1) chosen.add(p);
      i += 1;
      continue;
    }
    chosen.add(mention.position);
  }

  if (ONLY.test(section)) {
    return chosen.size ? ordered.filter((_, position) => !chosen.has(position)).map((stop) => stop.stopId) : [];
  }
  // "Soppresse" spesso sta nell'intestazione, prima di "LINEA ...": si guarda tutto il testo.
  if (!NEGATION.test(section) && !NEGATION.test(plain(text))) return [];
  const skipped = new Set(ordered.filter((_, position) => chosen.has(position)).map((stop) => stop.stopId));

  const covered = new Set(kept.map((mention) => streetOf(ordered[mention.position].raw)).filter(Boolean));
  for (const stop of stops) {
    if (!stop.stopId || skipped.has(stop.stopId)) continue;
    const street = streetOf(stop.name);
    if (!street || covered.has(street)) continue;
    const pattern = new RegExp(`(?<![a-z0-9])${escape(plain(street))}(?![a-z0-9])`, 'g');
    for (const match of section.matchAll(pattern)) {
      const before = section.slice(Math.max(0, match.index - 60), match.index);
      if (DETOUR_BEFORE.test(before) && !/\bnon\b/.test(before.slice(-40))) continue;
      skipped.add(stop.stopId);
      break;
    }
  }
  return [...skipped];
}
