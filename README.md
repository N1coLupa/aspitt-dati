# Dati di Aspitt

Orari degli autobus urbani di Altamura, avvisi dell'operatore, eventi e luoghi,
nel formato letto dall'app Aspitt. Aggiornati ogni giorno da un'azione di GitHub.

- `dati/manifest.json`: data del controllo, impronta e stato di ogni fonte.
- `dati/manifest.sig`: firma Ed25519 del manifest. L'app accetta solo dati
  firmati; la chiave privata sta nel segreto `ASPITT_FIRMA_CHIAVE` e mai qui.
- `dati/transport.json`, `alerts.json`, `events.json`, `places.json`.
- `storico/`: gli orari sostituiti, per confronto.

Fonti: marinobusurbano.it (orari e avvisi), Google My Maps dell'operatore
(fermate e tracciati), AltamuraLive e AltamuraLife (eventi), OpenStreetMap e
Wikimedia Commons (luoghi).

Se una fonte non risponde, restano i dati del giorno prima. Per aggiornare a
mano: `npm ci --ignore-scripts`, poi `npm run aggiorna` con `ASPITT_FIRMA_FILE`
che punta alla chiave privata.

## Avvisi manuali

Oltre a quelli presi dal sito, si possono pubblicare avvisi scritti a mano, anche generici (senza linea).

- Dal telefono: scheda **Actions** → **Aggiungi avviso** → **Run workflow**, compila titolo, testo e,
  se serve, linea e data di fine (vuota = 7 giorni). Per toglierne uno: azione `togli` e lo stesso titolo.
  Il workflow salva l'avviso e lancia subito **Aggiorna dati**.
- A mano: modifica `scripts/data/avvisi-manuali.json`; vale dal giro successivo di **Aggiorna dati**.

Un avviso non viene aggiunto se ce n'e' gia' uno con lo stesso titolo (sulla stessa linea), con lo stesso
link di un avviso del sito, o con lo stesso testo di un avviso del sito. In `dati/alerts.json` gli avvisi
manuali hanno `"source": "manuale"`; quelli senza linea non hanno `lineId`.
