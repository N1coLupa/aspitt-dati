// Prova se da questa rete il sito dell'operatore risponde o chiede la verifica
// anti-bot. Serve a scegliere da dove far girare l'aggiornamento automatico:
// si lancia uguale sul PC, su un server, dentro un'azione di GitHub o in n8n.
//
//   node scripts/prova-accesso.mjs
//
// Esce con 0 se si passa, 1 se il sito blocca, 2 se non risponde proprio.
// Non tenta in nessun modo di superare la verifica: si limita a dire com'e'
// andata, e con quale indirizzo IP pubblico e' partita la richiesta.

import { BlockedError, getBuffer, getText } from './lib/http.mjs';

const PAGES = [
  ['pagina iniziale', 'https://marinobusurbano.it/'],
  ['pagina avvisi', 'https://marinobusurbano.it/news/'],
];
const PDF = [
  'un PDF degli orari',
  'https://marinobusurbano.it/wp-content/uploads/2026/03/MarinoBus_Urbano_Orari_Ospedale-1-31-03-2026.pdf',
];

async function publicAddress() {
  try {
    return (await getText('https://api.ipify.org', { attempts: 1, timeout: 8000 })).trim();
  } catch {
    return 'sconosciuto';
  }
}

console.log(`Prova di accesso a marinobusurbano.it - ${new Date().toLocaleString('it-IT')}`);
console.log(`Indirizzo IP pubblico di questa macchina: ${await publicAddress()}\n`);

let blocked = 0;
let failed = 0;

for (const [what, url] of PAGES) {
  try {
    const html = await getText(url, { attempts: 1 });
    const lines = (html.match(/class="line"/g) ?? []).length;
    console.log(`  ok        ${what}: ${html.length} byte${lines ? `, ${lines} linee nell'elenco` : ''}`);
  } catch (err) {
    if (err instanceof BlockedError) {
      blocked += 1;
      console.log(`  BLOCCATA  ${what}: il sito ha chiesto la verifica anti-bot`);
    } else {
      failed += 1;
      console.log(`  errore    ${what}: ${err.message}`);
    }
  }
}

try {
  const pdf = await getBuffer(PDF[1], { attempts: 1 });
  const isPdf = pdf.subarray(0, 4).toString() === '%PDF';
  console.log(
    `  ${isPdf ? 'ok       ' : 'sospetto '} ${PDF[0]}: ${Math.round(pdf.length / 1024)} kB${isPdf ? '' : ' (non sembra un PDF)'}`
  );
} catch (err) {
  if (err instanceof BlockedError) {
    blocked += 1;
    console.log(`  BLOCCATO  ${PDF[0]}: il sito ha chiesto la verifica anti-bot`);
  } else {
    failed += 1;
    console.log(`  errore    ${PDF[0]}: ${err.message}`);
  }
}

if (blocked) {
  console.log(`\nDa qui NON si passa: ${blocked} richieste su 3 hanno avuto la verifica anti-bot.`);
  console.log('Questa macchina non va bene per l’aggiornamento automatico.');
  process.exit(1);
}
if (failed) {
  console.log(`\nIl sito non ha risposto (${failed} richieste fallite): riprova, potrebbe essere un problema momentaneo.`);
  process.exit(2);
}
console.log('\nDa qui si passa: questa macchina puo’ fare l’aggiornamento automatico ogni giorno.');
