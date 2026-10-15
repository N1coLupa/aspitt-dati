const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const USER_AGENT = 'Muevt/1.0 (app di mobilita per Altamura; ciao@muevt.it)';

// Overpass risponde spesso 502/504 per qualche minuto: si prova ogni server due volte prima di arrendersi.
export async function overpass(query, { attempts = 2, pause = 4000 } = {}) {
  let lastError;
  for (let round = 0; round < attempts; round += 1) {
    for (const endpoint of ENDPOINTS) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
          body: new URLSearchParams({ data: query }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      } catch (err) {
        lastError = err;
        console.warn(`  ! ${endpoint}: ${err.message}`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pause));
  }
  throw lastError;
}
