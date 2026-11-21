import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Soppressioni ricorrenti (scripts/data/soppressioni-ricorrenti.json): fermate che una linea salta
// sempre negli stessi giorni e orari. Finiscono in line.recurringSkips; l'app le tratta come
// fermate soppresse, senza avviso e senza notifica.
export const RECURRING_FILE = fileURLToPath(new URL('../data/soppressioni-ricorrenti.json', import.meta.url));

const WEEKDAYS = ['domenica', 'lunedi', 'martedi', 'mercoledi', 'giovedi', 'venerdi', 'sabato'];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const plain = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();

export async function readRecurring(file = RECURRING_FILE) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    return Array.isArray(parsed.soppressioni) ? parsed.soppressioni : [];
  } catch {
    return [];
  }
}

export function applyRecurringSkips(transport, entries) {
  const messages = [];
  for (const line of transport.lines) delete line.recurringSkips;
  for (const entry of entries) {
    const line = transport.lines.find((item) => item.id === entry.linea);
    if (!line) {
      messages.push(`saltata: linea "${entry.linea}" non trovata`);
      continue;
    }
    const days = [...new Set((entry.giorni ?? []).map((day) => WEEKDAYS.indexOf(plain(day))).filter((day) => day >= 0))].sort();
    if (!days.length || !TIME.test(entry.dalle ?? '') || !TIME.test(entry.alle ?? '')) {
      messages.push(`saltata su ${line.id}: servono giorni, dalle e alle (HH:MM)`);
      continue;
    }
    const known = new Set(line.stops.map((stop) => stop.stopId));
    const stops = (entry.fermate ?? []).filter((id) => known.has(id));
    const unknown = (entry.fermate ?? []).filter((id) => !known.has(id));
    if (unknown.length) messages.push(`su ${line.id} fermate sconosciute: ${unknown.join(', ')}`);
    if (!stops.length) continue;
    (line.recurringSkips ??= []).push({ days, start: entry.dalle, end: entry.alle, stops });
    messages.push(`${line.id}: ${stops.length} fermate soppresse, giorni ${days.join(',')}, ${entry.dalle}-${entry.alle}`);
  }
  return messages;
}
