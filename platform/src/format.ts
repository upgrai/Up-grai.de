export const eur = (cents: number | null | undefined) =>
  new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: (cents ?? 0) % 100 ? 2 : 0 }).format((cents ?? 0) / 100);

export const usdCents = (cents: number) => `${(cents / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;

export function relTime(iso: string | null | undefined): string {
  if (!iso) return '–';
  const diff = Date.parse(iso) - Date.now();
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat('de', { numeric: 'auto' });
  if (abs < 60_000) return rtf.format(Math.round(diff / 1000), 'second');
  if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), 'minute');
  if (abs < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), 'hour');
  return rtf.format(Math.round(diff / 86_400_000), 'day');
}

export const dateTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : '–';

export const PARTY_LABEL: Record<string, string> = { business: 'Geschäftskontakt', consumer: 'Verbraucher', unknown: 'Nicht eingeordnet' };

export const STATUS_LABEL: Record<string, string> = {
  new: 'Neu',
  researching: 'In Recherche',
  qualified: 'Qualifiziert',
  contacted: 'Kontaktiert',
  customer: 'Kunde',
  lost: 'Verloren',
  paused: 'Pausiert',
};

export const STAGE_LABEL: Record<string, string> = {
  new: 'Neu',
  qualified: 'Qualifiziert',
  meeting: 'Gespräch',
  proposal: 'Angebot',
  won: 'Gewonnen',
  lost: 'Verloren',
};

export const RUN_STATUS_LABEL: Record<string, string> = {
  queued: 'Wartet',
  running: 'Läuft',
  waiting_approval: 'Freigabe nötig',
  blocked: 'Blockiert',
  completed: 'Fertig',
  failed: 'Fehler',
  cancelled: 'Abgebrochen',
};

export const TASK_KIND_LABEL: Record<string, string> = {
  callback: 'Rückruf',
  reply: 'Antwort',
  review: 'Prüfen',
  followup: 'Nachfassen',
  call: 'Anruf',
  letter: 'Brief',
  other: 'Aufgabe',
};
