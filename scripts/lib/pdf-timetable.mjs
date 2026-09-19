import '../lib/node-compat.mjs';

// I PDF orari di MarinoBus sono griglie vettoriali: una colonna con l'elenco
// numerato delle fermate e una colonna per ogni corsa. Le celle "-" indicano
// che quella corsa NON serve quella fermata: sono le soppressioni che l'app
// deve mostrare. L'estrazione va fatta per posizione (x, y), non per testo:
// l'ordine di lettura del PDF non rispecchia la griglia.

const TIME_RE = /^(\d{1,2})[:.](\d{2})$/;
const SKIP_RE = /^[-\u2013\u2014]$/;
const CORSA_RE = /CORSA\s*(\d+|UNICA|BIS)/gi;

const ROW_TOLERANCE = 4; // punti PDF: le righe distano 12
const COLUMN_TOLERANCE = 14; // le colonne distano ~33

function clusterValues(values, tolerance) {
  const sorted = [...values].sort((a, b) => a - b);
  const clusters = [];
  for (const value of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && value - last[last.length - 1] <= tolerance) last.push(value);
    else clusters.push([value]);
  }
  return clusters.map((c) => c.reduce((a, b) => a + b, 0) / c.length);
}

function nearestIndex(centers, value, tolerance) {
  let best = -1;
  let bestDelta = Infinity;
  centers.forEach((center, index) => {
    const delta = Math.abs(center - value);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = index;
    }
  });
  return bestDelta <= tolerance ? best : -1;
}

function normaliseTime(raw) {
  const match = TIME_RE.exec(raw);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 27 || minutes > 59) return null;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

// "Da Lunedi' a Sabato (No Domenica e Festivi)" -> giorni ISO serviti.
export function parseServiceDays(label) {
  const text = (label || '').toLowerCase();
  if (!text) return null;
  const noSunday = /no\s+domenic|escluso.*domenic|feriale/.test(text);
  if (/domenic|festiv/.test(text) && !noSunday) return [7];
  if (/da\s+luned[iì]\s+a\s+sabato/.test(text)) return [1, 2, 3, 4, 5, 6];
  if (/da\s+luned[iì]\s+a\s+venerd[iì]/.test(text)) return [1, 2, 3, 4, 5];
  if (/scolastic/.test(text)) return [1, 2, 3, 4, 5, 6];
  if (/sabato/.test(text)) return [6];
  return null;
}

function expandCorsaLabels(item) {
  // Le intestazioni adiacenti a volte arrivano fuse ("CORSA 13 CORSA 14"):
  // le ridistribuiamo uniformemente sulla larghezza dell'item.
  const labels = [...item.s.matchAll(CORSA_RE)].map((m) => m[1]);
  if (labels.length <= 1) return labels.map((label) => ({ label, x: item.x }));
  const step = item.w / labels.length;
  return labels.map((label, i) => ({ label, x: item.x + step * i }));
}

async function readPageItems(page) {
  const content = await page.getTextContent();
  return content.items
    .filter((item) => item.str && item.str.trim())
    .map((item) => ({
      s: item.str.trim(),
      x: item.transform[4],
      y: item.transform[5],
      w: item.width,
      size: Math.abs(item.transform[0]),
    }));
}

function parsePage(items, pageNumber) {
  const cells = items
    .map((item) => {
      const time = normaliseTime(item.s);
      if (time) return { ...item, time };
      if (SKIP_RE.test(item.s)) return { ...item, time: null, skipped: true };
      return null;
    })
    .filter(Boolean);

  if (cells.length < 4) return null;

  const columns = clusterValues(
    cells.map((c) => c.x),
    COLUMN_TOLERANCE
  );
  const gridLeft = Math.min(...columns) - COLUMN_TOLERANCE;

  // Ancore di riga: il numero progressivo della fermata. Vive nella colonna piu'
  // a sinistra della tabella; i civici dentro il nome ("Via Putignano 25") sono
  // numeri anche loro, per questo il filtro e' sulla colonna, non sul formato.
  const numeric = items.filter((item) => /^\d{1,3}$/.test(item.s) && item.x < gridLeft);
  if (numeric.length < 2) return null;

  const anchorLeft = Math.min(...numeric.map((item) => item.x));
  const anchorColumn = numeric.filter((item) => item.x <= anchorLeft + 12);
  const nameLeft = Math.max(...anchorColumn.map((item) => item.x + item.w)) + 2;

  const byRow = new Map();
  for (const item of anchorColumn) {
    const key = Math.round(item.y / ROW_TOLERANCE);
    if (!byRow.has(key) || byRow.get(key).x > item.x) byRow.set(key, item);
  }

  const anchors = [...byRow.values()].map((item) => ({ index: Number(item.s), y: item.y })).sort((a, b) => b.y - a.y);

  if (anchors.length < 2) return null;

  const stops = anchors.map((anchor, position) => {
    const label = items
      .filter((item) => Math.abs(item.y - anchor.y) <= ROW_TOLERANCE && item.x >= nameLeft && item.x < gridLeft)
      .sort((a, b) => a.x - b.x)
      .map((item) => item.s)
      .join(' ')
      .replace(/\s+/g, ' ')
      .replace(/\s+([),])/g, '$1')
      .trim();
    // Se la numerazione letta non e' progressiva ci fidiamo della posizione.
    const index = anchor.index === position + 1 ? anchor.index : position + 1;
    return { index, y: anchor.y, name: label };
  });

  const headerY = Math.max(...anchors.map((a) => a.y)) + 6;
  const corsaLabels = items.filter((item) => /CORSA/i.test(item.s) && item.y > headerY).flatMap(expandCorsaLabels);
  const corsaCenters = corsaLabels.map((c) => c.x);

  const serviceLabels = items
    .filter((item) => item.y > headerY && parseServiceDays(item.s))
    .map((item) => ({ label: item.s, days: parseServiceDays(item.s), x: item.x, w: item.w }));

  const trips = columns.map((columnX, columnIndex) => {
    const stopTimes = stops.map((stop) => {
      const cell = cells.find((c) => Math.abs(c.y - stop.y) <= ROW_TOLERANCE && Math.abs(c.x - columnX) <= COLUMN_TOLERANCE);
      return {
        stopIndex: stop.index,
        time: cell?.time ?? null,
        served: Boolean(cell?.time),
      };
    });

    const corsa = corsaLabels[nearestIndex(corsaCenters, columnX, 22)];
    const service =
      serviceLabels.find((s) => columnX >= s.x - 12 && columnX <= s.x + s.w + 12) ?? (serviceLabels.length === 1 ? serviceLabels[0] : null);

    return {
      code: corsa ? `Corsa ${corsa.label.toLowerCase()}` : `Corsa ${columnIndex + 1}`,
      order: Number(corsa?.label) || columnIndex + 1,
      page: pageNumber,
      serviceLabel: service?.label ?? null,
      days: service?.days ?? null,
      departure: stopTimes.find((s) => s.time)?.time ?? null,
      stopTimes,
    };
  });

  return {
    page: pageNumber,
    stops: stops.map(({ index, name }) => ({ index, name })),
    trips: trips.filter((t) => t.departure).sort((a, b) => a.departure.localeCompare(b.departure)),
  };
}

export async function parseTimetablePdf(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    verbosity: 0,
  });
  const doc = await task.promise;

  const tables = [];
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
    const page = await doc.getPage(pageNumber);
    const parsed = parsePage(await readPageItems(page), pageNumber);
    if (parsed) tables.push(parsed);
  }
  await task.destroy();
  return tables;
}
