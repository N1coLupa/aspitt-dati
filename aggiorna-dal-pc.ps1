# Aggiornamento dal PC, come riserva dell'azione di GitHub.
#
# Il sito dell'operatore a volte blocca i server (captcha): da una connessione
# di casa di solito risponde. Questo script aggiorna i dati e li pubblica con
# le credenziali git gia' configurate sul PC. Si puo' pianificare ogni giorno
# con l'Utilita' di pianificazione di Windows.

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

$node = Join-Path $env:APPDATA 'nvm\v25.2.1\node.exe'
if (-not (Test-Path $node)) { $node = 'node' }
if (-not $env:MUEVT_FIRMA_FILE) { $env:MUEVT_FIRMA_FILE = Join-Path $env:USERPROFILE '.muevt\firma-dati.pem' }

git pull --rebase --quiet
if (-not (Test-Path 'node_modules')) { & npm ci --ignore-scripts --no-audit --no-fund }
& $node scripts/aggiorna.mjs
if ($LASTEXITCODE -ne 0) { throw "Aggiornamento non riuscito ($LASTEXITCODE)" }

git add dati storico
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) {
  git commit -m ("Dati del " + (Get-Date -Format 'yyyy-MM-dd') + " (PC)")
  git push
}
