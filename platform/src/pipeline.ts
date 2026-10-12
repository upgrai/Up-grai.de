// Gemeinsame Beschreibung des Agentenablaufs für Hintergrund-Animation und Workflow-Grafik.
export const PIPELINE = [
  { id: 'research', label: 'Recherche', short: 'Recherche', agent: 'research' },
  { id: 'qualify', label: 'Qualifizierung', short: 'Bewertung', agent: 'research' },
  { id: 'policy', label: 'Kanalprüfung', short: 'Berechtigung', agent: 'sales' },
  { id: 'draft', label: 'Entwurf', short: 'Entwurf', agent: 'sales' },
  { id: 'approval', label: 'Deine Freigabe', short: 'Freigabe', agent: 'human' },
  { id: 'send', label: 'Kontakt', short: 'Kontakt', agent: 'sales' },
  { id: 'followup', label: 'Wiedervorlage', short: 'Nachfassen', agent: 'followup' },
] as const;

export type StepId = (typeof PIPELINE)[number]['id'];

export interface FlowEvent {
  id: number;
  run_id: string;
  step: StepId;
  agent: string;
  status: 'started' | 'done' | 'blocked' | 'failed' | 'waiting';
  message: string;
  created_at: string;
  contact_name?: string | null;
}

type Listener = (e: FlowEvent) => void;
const listeners = new Set<Listener>();

/** Ereignis-Bus: der Poller veröffentlicht, Hintergrund und Grafiken reagieren. */
export const flowBus = {
  emit(e: FlowEvent) {
    listeners.forEach((l) => l(e));
  },
  on(l: Listener) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

export const ACCENTS: Record<string, [string, string]> = {
  cyan: ['#22d3ee', '#8b5cf6'],
  amber: ['#f59e0b', '#f43f5e'],
  violet: ['#a78bfa', '#ec4899'],
  emerald: ['#34d399', '#22d3ee'],
  rose: ['#fb7185', '#f59e0b'],
};
