import { animate, motion, useMotionValue, useTransform } from 'motion/react';
import { AlertTriangle, ArrowRight, Check, Clock, Inbox, MessageSquareReply, Radio, Sparkles, Wallet } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, ws } from '../api';
import { PipelineGraph } from '../components/PipelineGraph';
import { eur, relTime, TASK_KIND_LABEL, usdCents } from '../format';
import { PIPELINE } from '../pipeline';
import { Link, useRouter } from '../router';
import { useApp } from '../state';
import { Badge, Button, Card, cx, DOT_STYLE, Empty, SectionTitle, Skeleton, StatusDot, useAction } from '../ui';

interface TodayTask {
  id: string;
  kind: string;
  title: string;
  reason: string;
  due_at: string;
  overdue: boolean;
  contact_id: string | null;
  contact_name: string | null;
  contact_org: string | null;
}

function greeting() {
  const h = new Date().getHours();
  return h < 11 ? 'Guten Morgen' : h < 18 ? 'Guten Tag' : 'Guten Abend';
}

function CountUp({ value, format }: { value: number; format: (n: number) => string }) {
  const mv = useMotionValue(0);
  const text = useTransform(mv, (v) => format(Math.round(v)));
  useEffect(() => {
    const c = animate(mv, value, { duration: 1.1, ease: [0.16, 1, 0.3, 1] });
    return () => c.stop();
  }, [value, mv]);
  return <motion.span>{text}</motion.span>;
}

function Kpi({ icon, label, value, format, hint, tone, to }: { icon: ReactNode; label: string; value: number; format: (n: number) => string; hint?: ReactNode; tone?: 'warn'; to?: string }) {
  const { navigate } = useRouter();
  return (
    <Card interactive={!!to} onClick={to ? () => navigate(to) : undefined} className="group relative overflow-hidden p-4">
      <div className="pointer-events-none absolute -right-10 -top-10 h-28 w-28 rounded-full bg-[var(--accent)] opacity-[0.07] blur-2xl transition-opacity group-hover:opacity-20" />
      <div className="flex items-center gap-2 text-muted">
        <span className={cx('grid h-7 w-7 place-items-center rounded-lg border border-line bg-white/[0.04]', tone === 'warn' && value > 0 ? 'text-warn' : 'text-accent')}>{icon}</span>
        <span className="text-xs font-medium">{label}</span>
      </div>
      <p className={cx('mt-3 font-display text-2xl font-semibold tabular-nums sm:text-[28px]', tone === 'warn' && value > 0 && 'text-warn')}>
        <CountUp value={value} format={format} />
      </p>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </Card>
  );
}

const AGENT_CARDS = [
  { key: 'research' as const, label: 'Recherche', text: 'Sammelt Belege, bewertet Passung' },
  { key: 'sales' as const, label: 'Vertrieb', text: 'Prüft Kanäle, entwirft Ansprache' },
  { key: 'followup' as const, label: 'Nachfassen', text: 'Plant Wiedervorlagen' },
];

export default function Today() {
  const app = useApp();
  const { navigate } = useRouter();
  const ov = app.overview;
  const [tasks, setTasks] = useState<TodayTask[] | null>(null);
  const { busy, run } = useAction();

  const load = useCallback(async () => {
    const d = await api<{ tasks: TodayTask[] }>(ws(app.workspaceId, '/today'));
    setTasks(d.tasks);
  }, [app.workspaceId]);

  useEffect(() => {
    setTasks(null);
    load().catch(() => setTasks([]));
  }, [load, app.pulse]);

  const offer = ov?.offers.find((o) => o.id === app.offerId);
  const audience = ov?.audiences.find((a) => a.id === app.audienceId);
  const m = ov?.metrics;
  const counts = Object.fromEntries(PIPELINE.map((p) => [p.id, 0]));
  const recent = [...app.events].reverse().slice(0, 8);

  return (
    <div className="space-y-6">
      {/* Kopf */}
      <section className="relative">
        <motion.p initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="text-sm text-muted">
          {greeting()} · {new Date().toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' })}
        </motion.p>
        <motion.h1 initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }} className="mt-1 font-display text-3xl font-semibold sm:text-[42px] sm:leading-[1.1]">
          <span className="text-grad">{ov?.workspace.name ?? '…'}</span>
          <span className="text-fg/90"> · Vertrieb heute</span>
        </motion.h1>
        <p className="mt-2 max-w-2xl text-sm text-muted">
          {offer ? offer.name : 'Alle Angebote'}
          {audience ? ` → ${audience.name}` : ''}. Rückrufe und Antworten stehen vor neuen Erstkontakten; jede Priorität zeigt ihren Grund.
        </p>
      </section>

      {/* Agenten */}
      <section className="grid gap-3 sm:grid-cols-3">
        {AGENT_CARDS.map((a, i) => {
          const state = app.agents[a.key];
          return (
            <motion.div key={a.key} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.08 + i * 0.05 }}>
              <Card interactive onClick={() => navigate('/workflows')} className="flex items-center gap-4 p-4">
                <div className="relative grid h-11 w-11 place-items-center rounded-2xl border border-line bg-white/[0.04]">
                  <Sparkles size={18} className={DOT_STYLE[state]?.color} />
                  <span className="absolute -right-1 -top-1">
                    <StatusDot state={state} />
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 font-medium">
                    {a.label}
                    <span className={cx('text-xs font-normal', DOT_STYLE[state]?.color)}>{DOT_STYLE[state]?.label}</span>
                  </p>
                  <p className="truncate text-xs text-muted">{a.text}</p>
                </div>
                <ArrowRight size={16} className="text-muted" />
              </Card>
            </motion.div>
          );
        })}
      </section>

      {/* Kennzahlen */}
      {m ? (
        <section className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
          <Kpi icon={<Wallet size={15} />} label="Zahlungseingang (Monat)" value={m.paymentsMonthCents} format={eur} hint={`${m.paymentsMonthCount} belegte Zahlungen`} to="/pipeline" />
          <Kpi icon={<Sparkles size={15} />} label="Offen einmalig" value={m.pipelineOneTimeCents} format={eur} hint={m.pipelineEstimates ? `${m.pipelineEstimates} davon geschätzt` : `${m.pipelineCount} Chancen`} to="/pipeline" />
          <Kpi icon={<Radio size={15} />} label="Offen monatlich" value={m.pipelineRecurringCents} format={eur} hint="laufende Gebühren" to="/pipeline" />
          <Kpi icon={<Clock size={15} />} label="Fällige Aufgaben" value={m.tasksDue} format={String} hint="bis morgen" />
          <Kpi icon={<Inbox size={15} />} label="Freigaben" value={m.approvalsPending} format={String} tone="warn" hint="warten auf dich" to="/freigaben" />
          <Kpi
            icon={<MessageSquareReply size={15} />}
            label="Antworten (7 Tage)"
            value={m.repliesWeek}
            format={String}
            hint={`KI heute ${usdCents(m.aiSpendTodayCents)} / ${usdCents(ov!.workspace.daily_ai_budget_cents)}`}
          />
        </section>
      ) : (
        <section className="grid grid-cols-2 gap-3 lg:grid-cols-6">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-[112px]" />
          ))}
        </section>
      )}

      {m && m.demoContacts > 0 && (
        <div className="flex items-start gap-3 rounded-2xl border border-warn/30 bg-warn/[0.07] px-4 py-3 text-sm text-warn">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <p>
            {m.demoContacts} Demo-Kontakte sind geladen (nur lokal). Sie sind erfunden und dürfen nicht kontaktiert werden.
          </p>
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[1.4fr_1fr]">
        {/* Arbeitsliste */}
        <Card className="p-5">
          <SectionTitle title="Heute" subtitle="Rückrufe → Antworten → Prüfen → Nachfassen → Erstkontakte" action={<Link to="/kontakte" className="text-sm text-accent hover:underline">Alle Kontakte</Link>} />
          {!tasks ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className="h-16" />
              ))}
            </div>
          ) : tasks.length === 0 ? (
            <Empty icon={<Check size={20} />} title="Alles erledigt" text="Keine fälligen Aufgaben. Starte einen Agentenlauf oder importiere neue Kontakte." action={<Button size="sm" onClick={() => navigate('/kontakte')}>Kontakte öffnen</Button>} />
          ) : (
            <ul className="divide-y divide-line">
              {tasks.map((t) => (
                <motion.li layout key={t.id} className="flex items-center gap-3 py-3">
                  <Badge tone={t.kind === 'callback' || t.kind === 'reply' ? 'accent' : t.kind === 'review' ? 'warn' : 'neutral'}>{TASK_KIND_LABEL[t.kind] ?? t.kind}</Badge>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {t.title}
                      {t.contact_name && (
                        <>
                          {' · '}
                          <Link to={`/kontakte/${t.contact_id}`} className="text-accent hover:underline">
                            {t.contact_org ?? t.contact_name}
                          </Link>
                        </>
                      )}
                    </p>
                    <p className="truncate text-xs text-muted">
                      {t.reason || 'Ohne Begründung'} · <span className={t.overdue ? 'text-bad' : ''}>{relTime(t.due_at)}</span>
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="Erledigt"
                    loading={busy === t.id}
                    onClick={() =>
                      run(t.id, async () => {
                        await api(ws(app.workspaceId, `/tasks/${t.id}/done`), { method: 'POST', body: {} });
                        setTasks((prev) => prev?.filter((x) => x.id !== t.id) ?? null);
                        app.refresh();
                      })
                    }
                  >
                    <Check size={16} />
                  </Button>
                </motion.li>
              ))}
            </ul>
          )}
        </Card>

        {/* Live */}
        <Card className="p-5">
          <SectionTitle title="Live" subtitle="Was die Agenten gerade tun" action={<Link to="/workflows" className="text-sm text-accent hover:underline">Workflows</Link>} />
          {recent.length === 0 ? (
            <Empty icon={<Radio size={20} />} title="Noch ruhig" text="Sobald ein Agentenlauf startet, siehst du hier und im Hintergrund jeden Schritt." />
          ) : (
            <ol className="relative space-y-3 border-l border-line pl-4">
              {recent.map((e) => (
                <motion.li key={e.id} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} className="relative">
                  <span
                    className={cx(
                      'absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full',
                      e.status === 'done' && 'bg-ok',
                      e.status === 'started' && 'bg-[var(--accent)]',
                      e.status === 'waiting' && 'bg-warn',
                      (e.status === 'blocked' || e.status === 'failed') && 'bg-bad',
                    )}
                  />
                  <p className="text-sm">
                    <span className="font-medium">{PIPELINE.find((p) => p.id === e.step)?.label}</span>
                    {e.contact_name && <span className="text-muted"> · {e.contact_name}</span>}
                  </p>
                  <p className="line-clamp-2 text-xs text-muted">{e.message}</p>
                  <p className="text-[10px] text-muted/70">{relTime(e.created_at)}</p>
                </motion.li>
              ))}
            </ol>
          )}
        </Card>
      </div>

      <Card className="p-5">
        <SectionTitle title="Ablauf" subtitle="Feste Regeln, kein Agent gibt sich selbst frei" />
        <PipelineGraph counts={counts} compact />
      </Card>
    </div>
  );
}
