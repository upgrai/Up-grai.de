import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, ws as wsPath } from './api';
import { ACCENTS, flowBus, type FlowEvent } from './pipeline';

export interface WorkspaceSummary {
  id: string;
  slug: string;
  name: string;
  description: string;
  accent: string;
  role: 'owner' | 'member';
}

export interface Offer {
  id: string;
  name: string;
  description: string;
  services: string;
  pricing: string;
  limits: string;
  goal: string;
  is_active: number;
}

export interface Audience {
  id: string;
  offer_id: string;
  name: string;
  description: string;
  criteria: string;
  default_party_type: string;
}

export type Dot = 'ready' | 'running' | 'approval' | 'paused' | 'error';

export interface Overview {
  workspace: { id: string; name: string; accent: string; daily_ai_budget_cents: number; max_parallel_runs: number; ai_provider: string | null; description: string };
  role: 'owner' | 'member';
  offers: Offer[];
  audiences: Audience[];
  metrics: {
    paymentsMonthCents: number;
    paymentsMonthCount: number;
    pipelineOneTimeCents: number;
    pipelineRecurringCents: number;
    pipelineEstimates: number;
    pipelineCount: number;
    tasksDue: number;
    approvalsPending: number;
    repliesWeek: number;
    runs: Record<string, number>;
    aiSpendTodayCents: number;
    contacts: number;
    demoContacts: number;
  };
  agents: Record<'research' | 'sales' | 'followup', Dot>;
  engine: { id: string; provider: string; label: string } | null;
}

interface AppState {
  email: string;
  environment: string;
  workspaces: WorkspaceSummary[];
  workspaceId: string;
  setWorkspaceId: (id: string) => void;
  offerId: string;
  setOfferId: (id: string) => void;
  audienceId: string;
  setAudienceId: (id: string) => void;
  overview: Overview | null;
  refresh: () => Promise<void>;
  reloadMe: () => Promise<void>;
  events: FlowEvent[];
  agents: Overview['agents'];
  /** Zähler, der bei jedem neuen Ereignis steigt – Seiten laden damit nach */
  pulse: number;
}

const Ctx = createContext<AppState | null>(null);

const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k) ?? '';
    } catch {
      return '';
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* privater Modus */
    }
  },
};

export function AppProvider({ children, fallback }: { children: ReactNode; fallback: (err: string | null) => ReactNode }) {
  const [me, setMe] = useState<{ email: string; workspaces: WorkspaceSummary[]; environment: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [workspaceId, setWorkspaceIdState] = useState(() => store.get('upg.ws'));
  const [offerId, setOfferIdState] = useState('');
  const [audienceId, setAudienceIdState] = useState('');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [events, setEvents] = useState<FlowEvent[]>([]);
  const [agents, setAgents] = useState<Overview['agents']>({ research: 'ready', sales: 'ready', followup: 'ready' });
  const [pulse, setPulse] = useState(0);
  const lastEventId = useRef(0);
  const agentsRef = useRef(agents);
  agentsRef.current = agents;

  const reloadMe = useCallback(async () => {
    try {
      const data = await api<{ email: string; workspaces: WorkspaceSummary[]; environment: string }>('/me');
      setMe(data);
      setError(null);
      setWorkspaceIdState((cur) => (data.workspaces.some((w) => w.id === cur) ? cur : data.workspaces[0]?.id ?? ''));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Fehler');
    }
  }, []);

  useEffect(() => {
    reloadMe();
  }, [reloadMe]);

  const refresh = useCallback(async () => {
    if (!workspaceId) return;
    const data = await api<Overview>(wsPath(workspaceId, '/overview'));
    setOverview(data);
    setAgents(data.agents);
  }, [workspaceId]);

  // Arbeitsbereich wechseln: Ansicht, Angebot und Zielgruppe zurücksetzen
  useEffect(() => {
    if (!workspaceId) return;
    store.set('upg.ws', workspaceId);
    setOverview(null);
    setEvents([]);
    lastEventId.current = 0;
    setOfferIdState(store.get(`upg.offer.${workspaceId}`));
    setAudienceIdState(store.get(`upg.aud.${workspaceId}`));
    refresh().catch((e) => setError(e.message));
  }, [workspaceId, refresh]);

  // Ungültige Auswahl nach dem Laden korrigieren
  useEffect(() => {
    if (!overview) return;
    const active = overview.offers.filter((o) => o.is_active);
    if (!overview.offers.some((o) => o.id === offerId)) setOfferIdState(active[0]?.id ?? overview.offers[0]?.id ?? '');
  }, [overview, offerId]);
  useEffect(() => {
    if (!overview || !audienceId) return;
    if (!overview.audiences.some((a) => a.id === audienceId && a.offer_id === offerId)) setAudienceIdState('');
  }, [overview, offerId, audienceId]);

  // Live-Ereignisse: schneller, solange Agenten arbeiten
  useEffect(() => {
    if (!workspaceId) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    let first = true;
    const tick = async () => {
      try {
        const data = await api<{ events: FlowEvent[]; agents: Overview['agents'] }>(wsPath(workspaceId, `/events?since=${lastEventId.current}`));
        if (stop) return;
        setAgents(data.agents);
        if (data.events.length) {
          lastEventId.current = data.events[data.events.length - 1].id;
          setEvents((prev) => [...prev, ...data.events].slice(-80));
          // Beim ersten Laden keine alte Historie animieren
          if (!first) {
            data.events.forEach((e, i) => setTimeout(() => flowBus.emit(e), i * 450));
            setPulse((p) => p + 1);
          }
        }
        first = false;
      } catch {
        /* nächster Versuch */
      }
      const busy = Object.values(agentsRef.current).some((d) => d === 'running');
      timer = setTimeout(tick, document.hidden ? 15000 : busy ? 1200 : 4000);
    };
    tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [workspaceId]);

  // Nach neuen Ereignissen Kennzahlen nachladen
  useEffect(() => {
    if (pulse) refresh().catch(() => {});
  }, [pulse, refresh]);

  const accent = me?.workspaces.find((w) => w.id === workspaceId)?.accent ?? 'cyan';
  useEffect(() => {
    const [a, b] = ACCENTS[accent] ?? ACCENTS.cyan;
    document.documentElement.style.setProperty('--accent', a);
    document.documentElement.style.setProperty('--accent-2', b);
  }, [accent]);

  const value = useMemo<AppState | null>(
    () =>
      me
        ? {
            email: me.email,
            environment: me.environment,
            workspaces: me.workspaces,
            workspaceId,
            setWorkspaceId: setWorkspaceIdState,
            offerId,
            setOfferId: (id) => {
              setOfferIdState(id);
              setAudienceIdState('');
              store.set(`upg.offer.${workspaceId}`, id);
              store.set(`upg.aud.${workspaceId}`, '');
            },
            audienceId,
            setAudienceId: (id) => {
              setAudienceIdState(id);
              store.set(`upg.aud.${workspaceId}`, id);
            },
            overview,
            refresh,
            reloadMe,
            events,
            agents,
            pulse,
          }
        : null,
    [me, workspaceId, offerId, audienceId, overview, refresh, reloadMe, events, agents, pulse],
  );

  if (!value) return <>{fallback(error)}</>;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('AppProvider fehlt');
  return v;
}

export function accentOf(name: string | undefined) {
  return ACCENTS[name ?? 'cyan'] ?? ACCENTS.cyan;
}
