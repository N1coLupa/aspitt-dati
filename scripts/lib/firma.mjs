import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const DATA_FILES = ['transport', 'events', 'places', 'alerts'];
export const MANIFEST_SCHEMA = 2;

export async function loadPrivateKey() {
  const inline = process.env.ASPITT_FIRMA_CHIAVE;
  const file = process.env.ASPITT_FIRMA_FILE;
  const pem = inline?.trim() ? inline : file ? await fs.readFile(file, 'utf8') : null;
  if (!pem) return null;
  const key = crypto.createPrivateKey(pem.replace(/\\n/g, '\n'));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('La chiave di firma deve essere Ed25519');
  return key;
}

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

export async function signData(dir, privateKey) {
  const manifestPath = path.join(dir, 'manifest.json');
  const current = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const files = {};
  for (const name of DATA_FILES) files[name] = await fileEntry(dir, name, current.files?.[name]);

  const manifest = {
    ...current,
    schema: MANIFEST_SCHEMA,
    app: 'aspitt',
    signedAt: new Date().toISOString(),
    keyId: rawPublicKey(privateKey).slice(0, 8),
    files,
  };
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  const signature = crypto.sign(null, Buffer.from(text, 'utf8'), privateKey).toString('base64');

  if (!crypto.verify(null, Buffer.from(text, 'utf8'), crypto.createPublicKey(privateKey), Buffer.from(signature, 'base64'))) {
    throw new Error('Firma non verificabile');
  }
  await fs.writeFile(manifestPath, text);
  await fs.writeFile(path.join(dir, 'manifest.sig'), `${signature}\n`);
  return manifest;
}
