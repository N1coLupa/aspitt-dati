// HTTP client condiviso dagli scraper.
// marinobusurbano.it sta dietro un WAF che risponde 403 alle richieste prive di
// header di navigazione: vanno inviati tutti, non solo lo User-Agent.

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Il sito ha risposto con la verifica anti-bot di SiteGround invece che con la
 * pagina. Non si aggira: si segnala, si tengono i dati di ieri e, se c'e', si
 * usa la copia salvata a mano (vedi scripts/lib/copia-locale.mjs).
 */
export class BlockedError extends Error {
  constructor(url) {
    super(`il sito ha chiesto la verifica anti-bot (captcha) su ${url}`);
    this.name = 'BlockedError';
    this.url = url;
  }
}

const isChallenge = (res) => Boolean(res.headers.get('sg-captcha')) || (res.status === 202 && /sgcaptcha/i.test(res.headers.get('refresh') ?? ''));

async function request(url, { attempts = 3, timeout = 40000, headers = {} } = {}) {
  let lastError;
  for (let i = 1; i <= attempts; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, {
        headers: { ...BROWSER_HEADERS, ...headers },
        signal: controller.signal,
        redirect: 'follow',
      });
      if (isChallenge(res)) throw new BlockedError(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} su ${url}`);
      const type = res.headers.get('content-type') ?? '';
      // La verifica a volte arriva con 200 e una pagina minuscola che rimanda a /.well-known/sgcaptcha/.
      if (/text\/html/.test(type) && Number(res.headers.get('content-length') ?? 1e9) < 2000) {
        const body = await res.clone().text();
        if (/sgcaptcha/i.test(body)) throw new BlockedError(url);
      }
      return res;
    } catch (err) {
      if (err instanceof BlockedError) throw err;
      lastError = err;
      if (i < attempts) await sleep(800 * i);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

export async function getText(url, opts) {
  const res = await request(url, opts);
  return res.text();
}

export async function getBuffer(url, opts) {
  const res = await request(url, opts);
  return Buffer.from(await res.arrayBuffer());
}

export { sleep };
