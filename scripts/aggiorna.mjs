import { spawnSync } from 'node:child_process';

const { MUEVT_FIRMA_CHIAVE, MUEVT_FIRMA_FILE, ...base } = process.env;
const env = { ...base, MUEVT_DATA_DIR: 'dati', MUEVT_SNAPSHOT_DIR: 'storico' };
const run = (script, extra = {}) => spawnSync(process.execPath, [script], { stdio: 'inherit', env: { ...env, ...extra } }).status ?? 1;

if (process.argv.includes('--solo-controllo')) process.exit(run('scripts/check-data.mjs'));

const status = run('scripts/scrapers/run-daily.mjs');
if (status !== 0) process.exit(status);
if (process.argv.includes('--solo-scarica')) process.exit(run('scripts/check-data.mjs'));
process.exit(run('scripts/firma-dati.mjs', { MUEVT_FIRMA_CHIAVE, MUEVT_FIRMA_FILE }));
