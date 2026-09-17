# Dati di Muevt

Orari degli autobus urbani di Altamura, avvisi dell'operatore, eventi e luoghi,
nel formato letto dall'app Muevt. Aggiornati ogni giorno da un'azione di GitHub.

- `dati/manifest.json`: data del controllo, impronta e stato di ogni fonte.
- `dati/manifest.sig`: firma Ed25519 del manifest. L'app accetta solo dati
  firmati; la chiave privata sta nel segreto `MUEVT_FIRMA_CHIAVE` e mai qui.
- `dati/transport.json`, `alerts.json`, `events.json`, `places.json`.
- `storico/`: gli orari sostituiti, per confronto.

Fonti: marinobusurbano.it (orari e avvisi), Google My Maps dell'operatore
(fermate e tracciati), AltamuraLive e AltamuraLife (eventi), OpenStreetMap e
Wikimedia Commons (luoghi).

Se una fonte non risponde, restano i dati del giorno prima. Per aggiornare a
mano: `npm ci --ignore-scripts`, poi `npm run aggiorna` con `MUEVT_FIRMA_FILE`
che punta alla chiave privata.
