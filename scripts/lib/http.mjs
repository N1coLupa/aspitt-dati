import dns from 'node:dns/promises';
import net from 'node:net';

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

export const MARINO_HOSTS = ['marinobusurbano.it'];
export const FAL_HOSTS = ['ferrovieappulolucane.it'];

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_REDIRECTS = 5;

const PRIVATE = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3],
]) {
  PRIVATE.addSubnet(address, prefix, 'ipv4');
}
for (const [address, prefix] of [
  ['::', 127],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
]) {
  PRIVATE.addSubnet(address, prefix, 'ipv6');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class BlockedError extends Error {
  constructor(url) {
    super(`il sito ha chiesto la verifica anti-bot (captcha) su ${url}`);
    this.name = 'BlockedError';
    this.url = url;
  }
}

class RefusedError extends Error {
  constructor(url, reason) {
    super(`indirizzo rifiutato (${reason}): ${url}`);
    this.name = 'RefusedError';
  }
}

const isChallenge = (res) =>
  Boolean(res.headers.get('sg-captcha')) || (res.status === 202 && /sgcaptcha/i.test(res.headers.get('refresh') ?? ''));

const bare = (hostname) => hostname.replace(/^\[|\]$/g, '').toLowerCase();

function isPrivate(address) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped) return PRIVATE.check(mapped, 'ipv4');
  const family = net.isIP(address);
  if (!family) return true;
  return PRIVATE.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

export function allowedUrl(value, hosts = null) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  const host = bare(url.hostname);
  if (net.isIP(host) && isPrivate(host)) return false;
  if (hosts && !hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) return false;
  return true;
}

async function checkUrl(value, hosts) {
  if (!allowedUrl(value, hosts)) throw new RefusedError(value, 'schema o host non ammesso');
  const host = bare(new URL(value).hostname);
  const addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivate(address))) {
    throw new RefusedError(value, 'indirizzo privato');
  }
}

async function readCapped(res, url, maxBytes) {
  if (Number(res.headers.get('content-length') ?? 0) > maxBytes) throw new RefusedError(url, 'risposta troppo grande');
  if (!res.body) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new RefusedError(url, 'risposta troppo grande');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function follow(url, { headers, signal, hosts }) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await checkUrl(current, hosts);
    const res = await fetch(current, { headers, signal, redirect: 'manual' });
    const location = res.headers.get('location');
    if (res.status < 300 || res.status > 399 || !location) return res;
    await res.body?.cancel();
    current = new URL(location, current).toString();
  }
  throw new Error(`troppi redirect da ${url}`);
}

async function request(url, { attempts = 3, timeout = 40000, headers = {}, hosts = null, maxBytes = MAX_BYTES } = {}) {
  let lastError;
  for (let i = 1; i <= attempts; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await follow(url, { headers: { ...BROWSER_HEADERS, ...headers }, signal: controller.signal, hosts });
      if (isChallenge(res)) throw new BlockedError(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} su ${url}`);
      const body = await readCapped(res, url, maxBytes);
      const type = res.headers.get('content-type') ?? '';
      if (/text\/html/.test(type) && body.length < 2000 && /sgcaptcha/i.test(body.toString('utf8'))) throw new BlockedError(url);
      return body;
    } catch (err) {
      if (err instanceof BlockedError || err instanceof RefusedError) throw err;
      lastError = err;
      if (i < attempts) await sleep(800 * i);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

export async function getText(url, opts) {
  return (await request(url, opts)).toString('utf8');
}

export async function getBuffer(url, opts) {
  return request(url, opts);
}

export { sleep };
