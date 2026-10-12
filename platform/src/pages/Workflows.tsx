import { motion } from 'motion/react';
import { Ban, CheckCircle2, Play, ShieldAlert, Workflow as WorkflowIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CHANNEL_LABEL, type Channel, type ChannelDecision } from '../../shared/policy';
import { api, ws } from '../api';
import { PipelineGraph } from '../components/PipelineGraph';
import { dateTime, relTime, RUN_STATUS_LABEL, usdCents } from '../format';
import { PIPELINE, type StepId } from '../pipeline';
import { Link } from '../router';
import { useApp } from '../state';
import { Badge, Button, Card, cx, Drawer, Empty, Field, Input, Modal, SectionTitle, Skeleton, useAction } from '../ui';

interface RunRow {
  id: string;
  contact_id: string | null;
  contact_name: string | null;
  contact_org: string | null;
  channel: Channel;
  status: string;
  current_step: StepId | null;
  cost_cents: number;
  started_by: string;
  created_at: string;
  updated_at: string;
}

interface RunEvent {
  id: number;
  step: StepId;
  status: string;
  message: string;
  created_at: string;
}

const STATUS_TONE: Record<string, 'accent' | 'warn' | 'bad' | 'ok' | 'neutral'> = {
  queued: 'neutral',
  running: 'accent',
  waiting_approval: 'warn',
  blocked: 'bad',
  failed: 'bad',
  completed: 'ok',
  cancelled: 'neutral',
};

function StepTrack({ run }: { run: RunRow }) {
  const idx = PIPELINE.findIndex((p) => p.id === run.current_step);
  const done = run.status === 'completed';
  const bad = run.status === 'blocked' || run.status === 'failed';
  return (
    <div className="flex items-center gap-1">
      {PIPELINE.map((p, i) => (
        <span
          key={p.id}
          title={p.label}
          className={cx(
            'h-1.5 w-5 rounded-full transition-colors sm:w-7',
            done || i < idx ? 'bg-[var(--accent)]' : i === idx ? (bad ? 'bg-bad' : run.status === 'waiting_approval' ? 'bg-warn' : 'animate-pulse bg-white') : 'bg-white/10',
          )}
        />
      ))}
    </div>
  );
}

export default function Workflows() {
  const app = useApp();
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [open, setOpen] = useState<RunRow | null>(null);
  const [starting, setStarting] = useState(false);

  const load = useCallback(async () => {
    const d = await api<{ runs: RunRow[] }>(ws(app.workspaceId, '/runs'));
    setRuns(d.runs);
  }, [app.workspaceId]);

  useEffect(() => {
    load().catch(() => setRuns([]));
  }, [load, app.pulse]);

  const counts = useMemo(() => {
    const c: Partial<Record<StepId, number>> = {};
    for (const r of runs ?? []) {
      if (!['running', 'queued', 'waiting_approval'].includes(r.status) || !r.current_step) continue;
      c[r.current_step] = (c[r.current_step] ?? 0) + 1;
    }
    return c;
  }, [runs]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-semibold">Workflows</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Recherche → Prüfung → Entwurf → deine Freigabe → Kontakt → Wiedervorlage. Jeder Schritt erscheint live hier und im Hintergrund.
          </p>
        </div>
        <Button variant="primary" onClick={() => setStarting(true)}>
          <Play size={16} /> Agentenlauf starten
        </Button>
      </div>

      <Card className="relative overflow-hidden p-5 sm:p-6">
        <div className="pointer-events-none absolute inset-x-0 -top-24 h-48 bg-[radial-gradient(closest-side,var(--accent),transparent)] opacity-[0.12]" />
        <PipelineGraph counts={counts} />
      </Card>

      <Card className="p-5">
        <SectionTitle title="Letzte Läufe" subtitle={`Höchstens ${app.overview?.workspace.max_parallel_runs ?? 2} parallel · KI-Tagesbudget ${usdCents(app.overview?.workspace.daily_ai_budget_cents ?? 500)}`} />
        {!runs ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-14" />
            ))}
          </div>
        ) : runs.length === 0 ? (
          <Empty icon={<WorkflowIcon size={20} />} title="Noch keine Läufe" text="Starte einen Lauf für einen Kontakt – du siehst jeden Schritt live." action={<Button onClick={() => setStarting(true)}>Ersten Lauf starten</Button>} />
        ) : (
          <ul className="divide-y divide-line">
            {runs.map((r) => (
              <motion.li layout key={r.id}>
                <button onClick={() => setOpen(r)} className="flex w-full flex-wrap items-center gap-x-4 gap-y-2 py-3 text-left transition hover:bg-white/[0.02]">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{r.contact_org ?? r.contact_name ?? 'Kontakt gelöscht'}</p>
                    <p className="text-xs text-muted">
                      {CHANNEL_LABEL[r.channel]} · {relTime(r.updated_at)}
                      {r.cost_cents > 0 && ` · ${usdCents(r.cost_cents)}`}
                    </p>
                  </div>
                  <StepTrack run={r} />
                  <Badge tone={STATUS_TONE[r.status]}>{RUN_STATUS_LABEL[r.status] ?? r.status}</Badge>
                </button>
              </motion.li>
            ))}
          </ul>
        )}
      </Card>

      <RunDrawer run={open} onClose={() => setOpen(null)} />
      <StartRunModal open={starting} onClose={() => setStarting(false)} onStarted={() => load()} />
    </div>
  );
}

function RunDrawer({ run, onClose }: { run: RunRow | null; onClose: () => void }) {
  const app = useApp();
  const [events, setEvents] = useState<RunEvent[] | null>(null);
  useEffect(() => {
    if (!run) return;
    setEvents(null);
    api<{ events: RunEvent[] }>(ws(app.workspaceId, `/runs/${run.id}`))
      .then((d) => setEvents(d.events))
      .catch(() => setEvents([]));
  }, [run, app.workspaceId, app.pulse]);

  return (
    <Drawer open={!!run} onClose={onClose} title="Agentenlauf">
      {run && (
        <div className="p-6">
          <p className="text-xs uppercase tracking-wider text-muted">Agentenlauf · {CHANNEL_LABEL[run.channel]}</p>
          <h3 className="mt-1 font-display text-2xl font-semibold">{run.contact_org ?? run.contact_name}</h3>
          <div className="mt-3 flex flex-wrap gap-2">
            <Badge tone={STATUS_TONE[run.status]}>{RUN_STATUS_LABEL[run.status]}</Badge>
            <Badge>gestartet von {run.started_by}</Badge>
            {run.contact_id && (
              <Link to={`/kontakte/${run.contact_id}`} className="text-xs text-accent hover:underline">
                Kontakt öffnen
              </Link>
            )}
          </div>
          {run.status === 'waiting_approval' && (
            <Link to="/freigaben" className="mt-4 flex items-center gap-2 rounded-xl border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">
              <ShieldAlert size={16} /> Entwurf wartet auf deine Freigabe
            </Link>
          )}
          <ol className="relative mt-6 space-y-4 border-l border-line pl-5">
            {(events ?? []).map((e) => (
              <li key={e.id} className="relative">
                <span
                  className={cx(
                    'absolute -left-[26px] top-0.5 grid h-3 w-3 place-items-center rounded-full ring-4 ring-ink',
                    e.status === 'done' ? 'bg-ok' : e.status === 'started' ? 'bg-[var(--accent)]' : e.status === 'waiting' ? 'bg-warn' : 'bg-bad',
                  )}
                />
                <p className="text-sm font-medium">
                  {PIPELINE.find((p) => p.id === e.step)?.label}
                  <span className="ml-2 text-xs font-normal text-muted">{dateTime(e.created_at)}</span>
                </p>
                <p className="mt-0.5 whitespace-pre-line text-sm text-muted">{e.message}</p>
              </li>
            ))}
            {events?.length === 0 && <p className="text-sm text-muted">Noch keine Schritte.</p>}
          </ol>
        </div>
      )}
    </Drawer>
  );
}

interface ContactLite {
  id: string;
  display_name: string;
  organization: string | null;
  city: string | null;
  status: string;
}

export function StartRunModal({ open, onClose, onStarted, contactId }: { open: boolean; onClose: () => void; onStarted?: () => void; contactId?: string }) {
  const app = useApp();
  const { busy, run } = useAction();
  const [q, setQ] = useState('');
  const [contacts, setContacts] = useState<ContactLite[]>([]);
  const [selected, setSelected] = useState<string | undefined>(contactId);
  const [channels, setChannels] = useState<Record<Channel, ChannelDecision> | null>(null);
  const [channel, setChannel] = useState<Channel | null>(null);

  useEffect(() => {
    if (open) setSelected(contactId);
  }, [open, contactId]);

  useEffect(() => {
    if (!open || contactId) return;
    const t = setTimeout(() => {
      const params = new URLSearchParams({ q });
      if (app.audienceId) params.set('audience', app.audienceId);
      api<{ contacts: ContactLite[] }>(ws(app.workspaceId, `/contacts?${params}`))
        .then((d) => setContacts(d.contacts.filter((c) => c.status !== 'paused').slice(0, 30)))
        .catch(() => setContacts([]));
    }, 200);
    return () => clearTimeout(t);
  }, [open, q, app.workspaceId, app.audienceId, contactId]);

  useEffect(() => {
    setChannels(null);
    setChannel(null);
    if (!selected) return;
    api<{ channels: Record<Channel, ChannelDecision> }>(ws(app.workspaceId, `/contacts/${selected}`)).then((d) => {
      setChannels(d.channels);
      const firstAllowed = (Object.keys(d.channels) as Channel[]).find((c) => d.channels[c].allowed);
      setChannel(firstAllowed ?? null);
    });
  }, [selected, app.workspaceId]);

  return (
    <Modal open={open} onClose={onClose} title="Agentenlauf starten">
      <div className="space-y-5">
        {!contactId && (
          <Field label="Kontakt">
            <Input placeholder="Name, Firma oder Stadt suchen…" value={q} onChange={(e) => setQ(e.target.value)} />
            <div className="mt-2 max-h-48 space-y-1 overflow-y-auto scrollbar-thin">
              {contacts.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setSelected(c.id)}
                  className={cx('flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition', selected === c.id ? 'bg-white/10 text-fg' : 'text-muted hover:bg-white/5')}
                >
                  <span className="truncate">{c.organization ?? c.display_name}</span>
                  <span className="text-xs">{c.city}</span>
                </button>
              ))}
              {contacts.length === 0 && <p className="px-1 text-sm text-muted">Keine Kontakte gefunden.</p>}
            </div>
          </Field>
        )}
        {selected && (
          <Field label="Kanal" hint="Gesperrte Kanäle zeigen den Grund. Kontaktberechtigungen erfasst du in der Kontaktansicht.">
            <div className="space-y-1.5">
              {!channels && <Skeleton className="h-24" />}
              {channels &&
                (Object.keys(channels) as Channel[]).map((c) => {
                  const d = channels[c];
                  return (
                    <button
                      key={c}
                      disabled={!d.allowed}
                      onClick={() => setChannel(c)}
                      className={cx(
                        'flex w-full items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition',
                        channel === c ? 'ring-accent border-transparent bg-white/[0.06]' : 'border-line',
                        !d.allowed && 'cursor-not-allowed opacity-60',
                      )}
                    >
                      {d.allowed ? <CheckCircle2 size={16} className="mt-0.5 text-ok" /> : <Ban size={16} className="mt-0.5 text-bad" />}
                      <span>
                        <span className="block text-sm font-medium">{CHANNEL_LABEL[c]}</span>
                        <span className="block text-xs text-muted">
                          {d.reason}
                          {d.requiresTemplate && ' · außerhalb 24 h nur mit Vorlage'}
                        </span>
                      </span>
                    </button>
                  );
                })}
            </div>
          </Field>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button
            variant="primary"
            disabled={!selected || !channel}
            loading={busy === 'start'}
            onClick={() =>
              run(
                'start',
                async () => {
                  await api(ws(app.workspaceId, `/contacts/${selected}/runs`), { body: { channel } });
                  onStarted?.();
                  onClose();
                },
                'Agentenlauf gestartet – schau in den Hintergrund',
              )
            }
          >
            <Play size={15} /> Starten
          </Button>
        </div>
      </div>
    </Modal>
  );
}
