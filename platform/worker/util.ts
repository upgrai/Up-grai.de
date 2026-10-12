export function id(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `${prefix}_${Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 20)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function addDays(days: number, from = new Date()): string {
  return new Date(from.getTime() + days * 86_400_000).toISOString();
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Telefonnummer grob nach E.164 normalisieren (Standard: Deutschland). */
export function normalizePhone(raw: string | null | undefined, defaultCountry = '49'): string | null {
  if (!raw) return null;
  let s = raw.trim().replace(/[\s()./-]/g, '');
  if (!s) return null;
  if (s.startsWith('whatsapp:')) s = s.slice(9);
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  else if (s.startsWith('0')) s = `+${defaultCountry}${s.slice(1)}`;
  else if (!s.startsWith('+')) s = `+${defaultCountry}${s}`;
  return /^\+[1-9]\d{6,14}$/.test(s) ? s : null;
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
}
