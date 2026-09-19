// Fotografie dei luoghi, da Wikidata e Wikimedia Commons.
//
// I dati di OpenStreetMap non contengono immagini, ma spesso contengono il
// riferimento a Wikidata o alla voce di Wikipedia. Da li' si arriva a una
// fotografia libera su Commons.
//
// Due cose da non dimenticare:
//   1. le immagini di Commons sono libere ma quasi sempre chiedono
//      l'attribuzione, quindi insieme all'URL si salvano autore, licenza e
//      pagina del file: la scheda del luogo li mostra;
//   2. l'URL punta a `Special:FilePath` con una larghezza richiesta, cosi' si
//      scarica una versione ridotta e non l'originale da dieci megapixel.

const UA = 'Muevt/1.0 (app di mobilita per Altamura; contatto: ciao@muevt.it)';

const THUMB_WIDTH = 1200;

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const chunk = (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, i * size + size));

/** Nome del file immagine (P18) per una lista di entita' Wikidata. */
async function imagesFromWikidata(ids) {
  const found = new Map();

  for (const batch of chunk(ids, 50)) {
    const url = 'https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=claims' + `&ids=${batch.join('|')}`;
    try {
      const data = await getJson(url);
      for (const [id, entity] of Object.entries(data.entities ?? {})) {
        const file = entity?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
        if (file) found.set(id, file);
      }
    } catch (err) {
      console.warn(`  ! wikidata ${batch[0]}...: ${err.message}`);
    }
  }

  return found;
}

/** Immagine principale di una voce di Wikipedia, quando Wikidata non ne ha. */
async function imageFromWikipedia(reference) {
  // Il tag OSM ha la forma "it:Titolo della voce".
  const [lang, ...rest] = reference.split(':');
  const title = rest.join(':');
  if (!lang || !title) return null;

  const url =
    `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&prop=pageimages` + `&piprop=name&titles=${encodeURIComponent(title)}`;
  try {
    const data = await getJson(url);
    const pages = Object.values(data.query?.pages ?? {});
    return pages[0]?.pageimage ?? null;
  } catch (err) {
    console.warn(`  ! wikipedia ${reference}: ${err.message}`);
    return null;
  }
}

/** Autore e licenza di un file di Commons: senza, l'immagine non si puo' usare. */
async function creditsFor(files) {
  const credits = new Map();

  for (const batch of chunk(files, 25)) {
    const titles = batch.map((file) => `File:${file}`).join('|');
    const url =
      'https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo' +
      `&iiprop=extmetadata&titles=${encodeURIComponent(titles)}`;
    try {
      const data = await getJson(url);
      for (const page of Object.values(data.query?.pages ?? {})) {
        const meta = page?.imageinfo?.[0]?.extmetadata;
        if (!meta) continue;
        const file = String(page.title ?? '').replace(/^File:/, '');
        credits.set(file, {
          author: stripHtml(meta.Artist?.value) || null,
          license: meta.LicenseShortName?.value || null,
        });
      }
    } catch (err) {
      console.warn(`  ! commons ${batch[0]}...: ${err.message}`);
    }
  }

  return credits;
}

function stripHtml(value) {
  if (!value) return '';
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

const fileUrl = (file) => `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}?width=${THUMB_WIDTH}`;

const filePage = (file) => `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(file.replace(/ /g, '_'))}`;

/**
 * Aggiunge `image`, `imageCredit`, `imageLicense` e `imageSource` ai luoghi che
 * hanno una fotografia libera. Gli altri restano senza: l'app ha gia' un
 * trattamento a tinta per quel caso, e inventare un'immagine sarebbe peggio.
 */
export async function attachImages(places) {
  console.log('> Immagini da Wikidata e Commons');

  const withWikidata = places.filter((place) => place.wikidata && !place.image);
  const byEntity = await imagesFromWikidata(withWikidata.map((place) => place.wikidata));

  const fileByPlace = new Map();
  for (const place of withWikidata) {
    const file = byEntity.get(place.wikidata);
    if (file) fileByPlace.set(place.id, file);
  }

  // Ripiego: la voce di Wikipedia, per i luoghi senza P18 su Wikidata.
  const leftovers = places.filter((place) => place.wikipedia && !place.image && !fileByPlace.has(place.id));
  for (const place of leftovers) {
    const file = await imageFromWikipedia(place.wikipedia);
    if (file) fileByPlace.set(place.id, file);
  }

  const credits = await creditsFor([...new Set(fileByPlace.values())]);

  let count = 0;
  for (const place of places) {
    const file = fileByPlace.get(place.id);
    if (!file) {
      place.image = place.image ?? null;
      place.imageCredit = place.imageCredit ?? null;
      place.imageLicense = place.imageLicense ?? null;
      place.imageSource = place.imageSource ?? null;
      continue;
    }

    const credit = credits.get(file) ?? {};
    place.image = fileUrl(file);
    place.imageCredit = credit.author ?? null;
    place.imageLicense = credit.license ?? null;
    place.imageSource = filePage(file);
    count += 1;
  }

  console.log(`  ${count} luoghi con fotografia su ${places.length}`);
  return places;
}
