// Aggiunge o toglie un avviso in scripts/data/avvisi-manuali.json. Lo usa il workflow "Aggiungi avviso".
// Legge i campi da variabili d'ambiente (mai interpolate nella shell del workflow).
import fs from 'node:fs/promises';
import path from 'node:path';
import { MANUAL_FILE, findLine, manualAlerts, manualId, readManual, sameText } from './lib/avvisi-manuali.mjs';

const DATA_DIR = process.env.ASPITT_DATA_DIR ?? 'dati';
const env = (name) => String(process.env[name] ?? '').trim();
const stop = (message) => {
  console.error(`ERRORE: ${message}`);
  process.exit(1);
};
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8').catch(() => 'null'));

const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
const plusDays = (day, n) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const action = env('AVVISO_AZIONE') || 'aggiungi';
const entry = {
  titolo: env('AVVISO_TITOLO'),
  testo: env('AVVISO_TESTO'),
  linea: env('AVVISO_LINEA') || null,
  dal: env('AVVISO_DAL') || null,
  fino: env('AVVISO_FINO') || null,
  link: env('AVVISO_LINK') || null,
  gravita: env('AVVISO_GRAVITA') === 'warning' ? 'warning' : 'info',
};
if (!entry.titolo) stop('serve il titolo');

const file = JSON.parse(await fs.readFile(MANUAL_FILE, 'utf8').catch(() => '{"avvisi":[]}'));
file.avvisi = Array.isArray(file.avvisi) ? file.avvisi : [];
const sameEntry = (a) => sameText(a.titolo) === sameText(entry.titolo) && sameText(a.linea ?? '') === sameText(entry.linea ?? '');

if (action === 'togli') {
  const before = file.avvisi.length;
  file.avvisi = file.avvisi.filter((a) => !(sameText(a.titolo) === sameText(entry.titolo) && (!entry.linea || sameEntry(a))));
  if (file.avvisi.length === before) stop(`nessun avviso manuale con titolo "${entry.titolo}"`);
  await fs.writeFile(MANUAL_FILE, `${JSON.stringify(file, null, 2)}\n`);
  console.log(`Tolto: "${entry.titolo}" (${before - file.avvisi.length})`);
  process.exit(0);
}

if (!entry.testo) stop('serve il testo');
for (const key of ['dal', 'fino']) {
  if (entry[key] && !/^\d{4}-\d{2}-\d{2}$/.test(entry[key])) stop(`"${key}" deve essere nel formato AAAA-MM-GG (es. ${today})`);
}
if (!entry.fino) entry.fino = plusDays(entry.dal && entry.dal > today ? entry.dal : today, 7);
if (entry.fino < today) stop(`la data "fino" (${entry.fino}) e' gia' passata`);
if (entry.link && !/^https?:\/\//i.test(entry.link)) stop('il link deve iniziare con https://');

const transport = await readJson(path.join(DATA_DIR, 'transport.json'));
if (entry.linea) {
  const line = findLine(transport?.lines ?? [], entry.linea);
  if (!line) stop(`linea "${entry.linea}" non trovata. Linee: ${(transport?.lines ?? []).map((l) => l.name).join(', ')}`);
  entry.linea = line.id;
}

if (file.avvisi.some(sameEntry)) stop(`c'e' gia' un avviso manuale con titolo "${entry.titolo}"`);

const alerts = (await readJson(path.join(DATA_DIR, 'alerts.json')))?.alerts ?? [];
const check = manualAlerts([{ ...entry, dal: null }], alerts.filter((a) => a.source !== 'manuale'), transport, [], today);
if (!check.added.length) stop(check.log.join('; '));

const clean = Object.fromEntries(Object.entries(entry).filter(([, v]) => v != null && v !== ''));
file.avvisi.push(clean);
await fs.writeFile(MANUAL_FILE, `${JSON.stringify(file, null, 2)}\n`);
console.log(`Aggiunto (${manualId(entry)}): ${JSON.stringify(clean)}`);
