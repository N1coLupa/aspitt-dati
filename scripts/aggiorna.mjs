// Punto d'ingresso unico, uguale su GitHub e sul PC: imposta le cartelle,
// aggiorna i dati e li firma (oppure fa solo il controllo).
//
//   --solo-controllo  controlla i dati gia' presenti
//   --solo-scarica    scarica e controlla, senza firmare (su GitHub la firma
//                     avviene in un lavoro separato, vedi aggiorna.yml)
import { spawnSync } from 'node:child_process';

const env = { ...process.env, MUEVT_DATA_DIR: 'dati', MUEVT_SNAPSHOT_DIR: 'storico' };
const run = (script) => spawnSync(process.execPath, [script], { stdio: 'inherit', env }).status ?? 1;

if (process.argv.includes('--solo-controllo')) process.exit(run('scripts/check-data.mjs'));

// Lo scaricamento non vede mai la chiave: legge siti esterni e PDF.
const { MUEVT_FIRMA_CHIAVE: _key, MUEVT_FIRMA_FILE: _file, ...scrapeEnv } = env;
const status = spawnSync(process.execPath, ['scripts/scrapers/run-daily.mjs'], { stdio: 'inherit', env: scrapeEnv }).status ?? 1;
if (status !== 0) process.exit(status);
if (process.argv.includes('--solo-scarica')) process.exit(run('scripts/check-data.mjs'));
// Senza firma valida l'app scarterebbe i dati: meglio fallire qui.
process.exit(run('scripts/firma-dati.mjs'));
