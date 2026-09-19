// Ogni linea di MarinoBus Urbano ha una mappa Google MyMaps: l'export KML
// contiene i Placemark delle fermate (nome + coordinate) e la LineString del
// tracciato. E' l'unica fonte con le coordinate reali delle fermate.
import { XMLParser } from 'fast-xml-parser';
import { getText } from './http.mjs';

const parser = new XMLParser({ ignoreAttributes: false, trimValues: true });

export function kmlUrlFromMyMapsLink(link) {
  const mid = /[?&]mid=([^&"']+)/.exec(link)?.[1];
  if (!mid) return null;
  return `https://www.google.com/maps/d/kml?mid=${mid}&forcekml=1`;
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function parseCoordinateList(raw) {
  return String(raw)
    .trim()
    .split(/\s+/)
    .map((triple) => {
      const [lon, lat] = triple.split(',').map(Number);
      return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
    })
    .filter(Boolean);
}

export async function fetchKmlGeometry(kmlUrl) {
  const xml = await getText(kmlUrl);
  const doc = parser.parse(xml);

  // MyMaps annida i Placemark in uno o piu' Folder, oppure li mette in linea.
  const root = doc?.kml?.Document ?? {};
  const placemarks = [...asArray(root.Placemark), ...asArray(root.Folder).flatMap((f) => asArray(f.Placemark))];

  const stops = [];
  const paths = [];

  for (const pm of placemarks) {
    const name = typeof pm.name === 'string' ? pm.name.trim() : '';
    const address = typeof pm.address === 'string' ? pm.address.trim() : null;
    const order = Number(asArray(pm.ExtendedData?.Data).find((d) => d?.['@_name'] === '#')?.value);
    const point = pm.Point?.coordinates
      ? parseCoordinateList(pm.Point.coordinates)[0]
      : asArray(pm.MultiGeometry)
          .flatMap((mg) => asArray(mg.Point))
          .map((pt) => parseCoordinateList(pt.coordinates)[0])
          .find(Boolean);
    // Alcuni segnaposto di MyMaps sono geocodificati solo per indirizzo e
    // l'export KML non riporta le coordinate: li teniamo comunque, verranno
    // posizionati per interpolazione lungo il tracciato.
    if (name && (point || address)) {
      stops.push({
        name,
        address,
        order: Number.isFinite(order) ? order : null,
        lat: point?.lat ?? null,
        lon: point?.lon ?? null,
      });
    }
    for (const ls of asArray(pm.LineString)) {
      if (ls?.coordinates) paths.push(parseCoordinateList(ls.coordinates));
    }
    for (const mg of asArray(pm.MultiGeometry)) {
      for (const ls of asArray(mg.LineString)) {
        if (ls?.coordinates) paths.push(parseCoordinateList(ls.coordinates));
      }
    }
  }

  // Il tracciato utile e' il piu' lungo: gli altri sono raccordi o residui.
  const shape = paths.sort((a, b) => b.length - a.length)[0] ?? [];
  return { title: typeof root.name === 'string' ? root.name.trim() : '', stops, shape };
}
