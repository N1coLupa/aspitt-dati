const EARTH_RADIUS_M = 6371000;
const toRad = (deg) => (deg * Math.PI) / 180;

export function distanceMeters(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

function nearestVertex(shape, point, fromIndex = 0) {
  let best = fromIndex;
  let bestDistance = Infinity;
  for (let i = fromIndex; i < shape.length; i++) {
    const d = distanceMeters(shape[i], point);
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  }
  return best;
}

// MyMaps esporta senza coordinate i segnaposto geocodificati per indirizzo.
// Poiche' conosciamo l'ordine delle fermate e il tracciato completo, quelle
// mancanti si ricavano interpolando lungo la polilinea fra le due note.
export function fillMissingStopCoordinates(stops, shape) {
  if (!shape.length) return stops;

  const anchors = [];
  let cursor = 0;
  stops.forEach((stop, index) => {
    if (stop.lat == null || stop.lon == null) return;
    cursor = nearestVertex(shape, stop, cursor);
    anchors.push({ index, vertex: cursor });
  });

  if (anchors.length < 2) return stops;

  return stops.map((stop, index) => {
    if (stop.lat != null && stop.lon != null) return stop;

    const before = [...anchors].reverse().find((a) => a.index < index);
    const after = anchors.find((a) => a.index > index);
    if (!before || !after) {
      const fallback = before ?? after;
      const vertex = shape[fallback.vertex];
      return { ...stop, lat: vertex.lat, lon: vertex.lon, interpolated: true };
    }

    const ratio = (index - before.index) / (after.index - before.index);
    const vertex = shape[Math.round(before.vertex + (after.vertex - before.vertex) * ratio)];
    return { ...stop, lat: vertex.lat, lon: vertex.lon, interpolated: true };
  });
}
