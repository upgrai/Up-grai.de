// AES-GCM für gespeicherte Zugangsdaten von Anbietern (ersetzt die bisherige Base64-Speicherung).

function b64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

async function importKey(secret: string): Promise<CryptoKey> {
  if (!secret) throw new Error('ENCRYPTION_KEY ist nicht gesetzt');
  const raw = b64ToBytes(secret);
  if (raw.length !== 32) throw new Error('ENCRYPTION_KEY muss 32 Bytes (Base64) lang sein');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptJson(secret: string, value: unknown): Promise<string> {
  const key = await importKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(value));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data));
  return `v1.${bytesToB64(iv)}.${bytesToB64(ct)}`;
}

export async function decryptJson<T>(secret: string, payload: string): Promise<T> {
  const [version, ivB64, ctB64] = payload.split('.');
  if (version !== 'v1' || !ivB64 || !ctB64) throw new Error('Unbekanntes Verschlüsselungsformat');
  const key = await importKey(secret);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(ivB64) }, key, b64ToBytes(ctB64));
  return JSON.parse(new TextDecoder().decode(pt)) as T;
}
