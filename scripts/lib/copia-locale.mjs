// Copia del sito dell'operatore salvata a mano, per quando il sito blocca lo
// scraper con la verifica anti-bot.
//
// La verifica non si aggira. Se scatta, basta che una persona apra
// https://marinobusurbano.it/ nel browser e salvi nella cartella:
//   - la pagina iniziale (Ctrl+S, "Pagina web, solo HTML");
//   - i PDF degli orari cambiati (quelli che lo scraper elenca come mancanti);
//   - facoltativo: la pagina https://marinobusurbano.it/news/.
// I nomi dei file non contano per le pagine; i PDF vanno lasciati col nome
// originale. La cartella e' MUEVT_COPIA_MARINO, di default "orari-marino" sul
// Desktop.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BlockedError, getBuffer, getText } from './http.mjs';

export const COPY_DIR = process.env.MUEVT_COPIA_MARINO ?? path.join(os.homedir(), 'Desktop', 'orari-marino');

/** Da dove sono arrivati i dati di questo giro: 'rete' o 'copia locale'. */
export const usage = { local: new Set(), missing: new Set() };

async function files() {
  try {
    return (await fs.readdir(COPY_DIR)).map((name) => path.join(COPY_DIR, name));
  } catch {
    return [];
  }
}

const fileName = (url) => decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');

/** Una pagina HTML salvata che contiene il marcatore indicato. */
async function localPage(marker) {
  for (const file of await files()) {
    if (!/\.html?$/i.test(file)) continue;
    const html = await fs.readFile(file, 'utf8');
    if (html.includes(marker)) return html;
  }
  return null;
}

/**
 * Scarica una pagina del sito; se il sito chiede la verifica, usa la copia
 * salvata che contiene `marker` (una classe CSS tipica di quella pagina).
 */
export async function marinoText(url, marker) {
  try {
    return await getText(url);
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

/** Come marinoText, per i PDF: la copia deve avere il nome originale del file. */
export async function marinoBuffer(url) {
  try {
    return await getBuffer(url);
  } catch (err) {
    if (!(err instanceof BlockedError)) throw err;
    const wanted = fileName(url).toLowerCase();
    const file = (await files()).find((candidate) => path.basename(candidate).toLowerCase() === wanted);
    if (!file) {
      usage.missing.add(url);
      throw err;
    }
    usage.local.add(url);
    return fs.readFile(file);
  }
}

/**
 * Lascia nella cartella della copia l'elenco di cosa salvare a mano, oppure lo
 * toglie quando non serve piu'. E' il promemoria per chi apre la cartella.
 */
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
    'Poi rilancia l\'aggiornamento (npm run data) o aspetta quello di stanotte.',
  ];
  await fs.mkdir(COPY_DIR, { recursive: true });
  await fs.writeFile(file, `${lines.join('\r\n')}\r\n`);
}
