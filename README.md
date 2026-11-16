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

**Cosa arriva nell'app.** L'app non legge `alerts.json`: legge gli avvisi dalle linee di `transport.json`.
Per questo un avviso manuale **con una linea** viene scritto anche sulla linea, come quelli dell'operatore:
compare in Home e negli Avvisi, fa partire la notifica e, toccandolo, apre `aspitt.it/avvisi/<id>/` con il
testo intero. Dal testo si ricavano giorno, orari e fermate soppresse, quindi conviene scriverlo così:

> Il 22.11.2026 dalle 11:30 alle 17:00 saranno soppresse le fermate da via IV Novembre a via Bari 150.

- il giorno come `22.11.2026` o `domenica 22 novembre` (senza giorno vale da subito fino a "fino");
- gli orari come `dalle 11:30 alle 17:00`;
- le fermate col nome che hanno nell'app, una per una o `da <fermata> a <fermata>`: l'app le salta in
  orari e percorsi per quel giorno; per "solo presso" scrivi `un'unica fermata presso <posto>`.

Una linea mostra un avviso alla volta: se l'operatore ne ha già uno valido sulla stessa linea, nell'app resta
quello dell'operatore. Gli avvisi **senza linea** restano solo in `alerts.json`: l'app attuale non li mostra.
Il registro di **Aggiorna dati** dice per ogni avviso manuale come è finito nell'app.
