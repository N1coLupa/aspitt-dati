// Normalizza i link letti dai siti delle fonti (operatore, eventi), qualunque forma abbiano:
// "https://…", "http://…", "HTTP://…", "httpp://…", "//host/…", "www.host.it/…", "/percorso", "file.pdf",
// spazi, "&amp;" e virgolette attorno. Restituisce sempre un indirizzo https valido oppure null:
// un link rovinato si perde da solo, senza far scartare l'intero aggiornamento.

const ENTITIES = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };

const decode = (value) =>
  value
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (match, name) => ENTITIES[name.toLowerCase()] ?? match);

// Schemi scritti male ma chiaramente web: "httpp", "htp", "hhttps", "https" con maiuscole.
const WEB_SCHEME = /^h+t+p+s*$/i;
const OTHER_SCHEME = /^(mailto|tel|javascript|data|file|ftp|blob|about|sms|whatsapp)$/i;
// "www.sito.it/…" o "sito.it/…" senza protocollo.
const BARE_HOST = /^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?::\d+)?(?:[/?#]|$)/i;
// "Avviso.pdf" sembra un dominio ma e' un nome di file.
const FILE_NAME = /^[^/]+\.(?:pdf|html?|php|aspx?|jpe?g|png|webp|docx?|xlsx?)(?:[?#]|$)/i;
// Un percorso relativo plausibile: con una barra o con un'estensione da pagina o documento.
const RELATIVE = /^(?:\.{0,2}\/|[^\s]+\/|[^\s/]+\.(?:pdf|html?|php|aspx?|jpe?g|png|webp)(?:[?#]|$))/i;

function allowed(host, hosts) {
  if (!hosts) return true;
  return hosts.some((item) => host === item || host.endsWith(`.${item}`));
}

/**
 * @param {unknown} value il link cosi' come scritto nella pagina
 * @param {string} base la pagina da cui viene, per risolvere i link relativi
 * @param {string[] | null} hosts domini ammessi (null: tutti)
 * @returns {string | null}
 */
export function normalizeLink(value, base, hosts = null) {
  if (typeof value !== 'string') return null;
  let text = decode(value)
    .trim()
    .replace(/^[\s"'<(]+|[\s"'>)]+$/g, '');
  if (!text || text === '#') return null;

  const scheme = /^([a-z][a-z0-9+.-]*):\/*/i.exec(text);
  if (scheme) {
    if (OTHER_SCHEME.test(scheme[1])) return null;
    if (!WEB_SCHEME.test(scheme[1]) && !/^https?$/i.test(scheme[1])) return null;
    text = `https://${text.slice(scheme[0].length)}`;
  } else if (text.startsWith('//')) {
    text = `https:${text}`;
  } else if (BARE_HOST.test(text) && !FILE_NAME.test(text)) {
    text = `https://${text}`;
  } else if (!RELATIVE.test(text)) {
    return null;
  }

  let url;
  try {
    url = new URL(
      text.replace(/\s+/g, (space) => (space === ' ' ? '%20' : '')),
      base
    );
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  url.protocol = 'https:';
  url.username = '';
  url.password = '';
  url.hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!url.hostname.includes('.') || !allowed(url.hostname.replace(/^www\./, ''), hosts)) return null;
  return url.href;
}
