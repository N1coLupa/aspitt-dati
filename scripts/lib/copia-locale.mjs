import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BlockedError, MARINO_HOSTS, getBuffer, getText } from './http.mjs';

export const COPY_DIR = process.env.MUEVT_COPIA_MARINO ?? path.join(os.homedir(), 'Desktop', 'orari-marino');

export const usage = { local: new Set(), missing: new Set(), files: new Map() };

async function files() {
  try {
    return (await fs.readdir(COPY_DIR)).map((name) => path.join(COPY_DIR, name));
  } catch {
    return [];
  }
}

const fileName = (url) => decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');

async function localPage(marker) {
  for (const file of await files()) {
    if (!/\.html?$/i.test(file)) continue;
    const html = await fs.readFile(file, 'utf8');
    if (html.includes(marker)) return html;
  }
  return null;
}

export async function marinoText(url, marker) {
  try {
    return await getText(url, { hosts: MARINO_HOSTS });
  } catch (err) {
    if (!(err instanceof BlockedError)) throw err;
    const html = marker ? await localPage(marker) : null;
    if (!html) {
      usage.missing.add(url);
      throw err;
    }
    usage.local.add(url);
    return html;
  }
}

const timetableKey = (name) =>
  name
    .toLowerCase()
    .replace(/\.pdf$/, '')
    .replace(/[-_]?\d{2}[-_.]\d{2}[-_.]\d{4}$/, '')
    .replace(/[-_]?\d{4}$/, '');

export async function marinoBuffer(url) {
  try {
    return await getBuffer(url, { hosts: MARINO_HOSTS });
  } catch (err) {
    if (!(err instanceof BlockedError)) throw err;
    const wanted = fileName(url).toLowerCase();
    const saved = (await files()).filter((candidate) => /\.pdf$/i.test(candidate));
    const file =
      saved.find((candidate) => path.basename(candidate).toLowerCase() === wanted) ??
      saved.find((candidate) => timetableKey(path.basename(candidate)) === timetableKey(wanted));
    if (!file) {
      usage.missing.add(url);
      throw err;
    }
    usage.local.add(url);
    usage.files.set(url, path.basename(file));
    return fs.readFile(file);
  }
}

export async function writeMissingList() {
  const file = path.join(COPY_DIR, 'DA-SALVARE.txt');
  if (!usage.missing.size) {
    await fs.rm(file, { force: true });
    return;
  }
  const lines = [
    `Aggiornamento del ${new Date().toLocaleString('it-IT')}`,
    '',
    'Il sito di Marino ha chiesto la verifica anti-bot allo script. Per aggiornare gli',
    'orari apri questi indirizzi nel browser e salva i file in questa cartella',
    '(le pagine con Ctrl+S, "Pagina web, solo HTML"; i PDF con il nome originale):',
    '',
    ...[...usage.missing].map((url) => `  ${url}`),
    '',
    "Poi rilancia l'aggiornamento (npm run data) o aspetta quello di stanotte.",
  ];
  await fs.mkdir(COPY_DIR, { recursive: true });
  await fs.writeFile(file, `${lines.join('\r\n')}\r\n`);
}
