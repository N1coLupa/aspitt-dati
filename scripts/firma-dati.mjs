// Firma i dati in una cartella (di default `dati`, come nel repository dei dati).
//
//   MUEVT_FIRMA_FILE=~/.muevt/firma-dati.pem node scripts/firma-dati.mjs [cartella]
//
// Senza chiave esce con errore: dati non firmati non vanno mai pubblicati,
// perche' l'app li rifiuterebbe comunque.

import { loadPrivateKey, rawPublicKey, signData } from './lib/firma.mjs';

const dir = process.argv[2] ?? process.env.MUEVT_DATA_DIR ?? 'dati';

const key = await loadPrivateKey().catch((err) => {
  console.error(`Chiave di firma illeggibile: ${err.message}`);
  process.exit(1);
});
if (!key) {
  console.error('Manca la chiave di firma: imposta MUEVT_FIRMA_CHIAVE (GitHub) o MUEVT_FIRMA_FILE (PC).');
  process.exit(1);
}

const manifest = await signData(dir, key);
console.log(`Dati firmati (chiave ${rawPublicKey(key).slice(0, 8)}…, ${manifest.signedAt})`);
