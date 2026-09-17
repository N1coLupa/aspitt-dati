// Punto d'ingresso unico, uguale su GitHub e sul PC: imposta le cartelle,
// aggiorna i dati e li firma (oppure fa solo il controllo).
import { spawnSync } from 'node:child_process';

const env = { ...process.env, MUEVT_DATA_DIR: 'dati', MUEVT_SNAPSHOT_DIR: 'storico' };
const run = (script) => spawnSync(process.execPath, [script], { stdio: 'inherit', env }).status ?? 1;

if (process.argv.includes('--solo-controllo')) process.exit(run('scripts/check-data.mjs'));

const status = run('scripts/scrapers/run-daily.mjs');
if (status !== 0) process.exit(status);
// Senza firma valida l'app scarterebbe i dati: meglio fallire qui.
process.exit(run('scripts/firma-dati.mjs'));
