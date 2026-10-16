// Firma dei dati pubblicati.
//
// Il manifest elenca ogni file con impronta SHA-256 e dimensione; la firma
// Ed25519 del manifest (manifest.sig, in base64) permette all'app di accettare
// solo dati prodotti da chi possiede la chiave privata. Chi prendesse il
// controllo del repository o del CDN non potrebbe pubblicare orari o link falsi.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const DATA_FILES = ['transport', 'events', 'places', 'alerts'];
export const MANIFEST_SCHEMA = 2;

/** Legge la chiave privata dall'ambiente (GitHub) o da un file (PC). */
export async function loadPrivateKey() {
  const inline = process.env.MUEVT_FIRMA_CHIAVE;
  const file = process.env.MUEVT_FIRMA_FILE;
  const pem = inline?.trim() ? inline : file ? await fs.readFile(file, 'utf8') : null;
  if (!pem) return null;
  const key = crypto.createPrivateKey(pem.replace(/\\n/g, '\n'));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('La chiave di firma deve essere Ed25519');
  return key;
}

/** Chiave pubblica grezza (32 byte, base64): e' quella che va nell'app. */
export function rawPublicKey(key) {
  const der = crypto.createPublicKey(key).export({ format: 'der', type: 'spki' });
  return der.subarray(der.length - 32).toString('base64');
}

async function fileEntry(dir, name, previous) {
  const bytes = await fs.readFile(path.join(dir, `${name}.json`));
  const json = JSON.parse(bytes.toString('utf8'));
  return {
    ...previous,
    generatedAt: json.generatedAt,
    bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
}

/**
 * Ricalcola le impronte dai file veri, marca il manifest con data e schema e
 * scrive manifest.json + manifest.sig. Restituisce il manifest firmato.
 */
export async function signData(dir, privateKey) {
  const manifestPath = path.join(dir, 'manifest.json');
  const current = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const files = {};
  for (const name of DATA_FILES) files[name] = await fileEntry(dir, name, current.files?.[name]);

  const manifest = {
    ...current,
    schema: MANIFEST_SCHEMA,
    app: 'muevt',
    signedAt: new Date().toISOString(),
    keyId: rawPublicKey(privateKey).slice(0, 8),
    files,
  };
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  const signature = crypto.sign(null, Buffer.from(text, 'utf8'), privateKey).toString('base64');

  // Il controllo con la chiave pubblica prima di scrivere: mai pubblicare una firma rotta.
  if (!crypto.verify(null, Buffer.from(text, 'utf8'), crypto.createPublicKey(privateKey), Buffer.from(signature, 'base64'))) {
    throw new Error('Firma non verificabile');
  }
  await fs.writeFile(manifestPath, text);
  await fs.writeFile(path.join(dir, 'manifest.sig'), `${signature}\n`);
  return manifest;
}
