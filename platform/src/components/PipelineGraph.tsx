import { motion } from 'motion/react';
import { Bot, CheckCircle2, FileText, Search, Send, ShieldCheck, Sparkles, UserCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { flowBus, PIPELINE, type FlowEvent, type StepId } from '../pipeline';
import { cx } from '../ui';

const ICONS: Record<StepId, typeof Search> = {
  research: Search,
  qualify: Sparkles,
  policy: ShieldCheck,
  draft: FileText,
  approval: UserCheck,
  send: Send,
  followup: CheckCircle2,
};

const DESCRIPTIONS: Record<StepId, string> = {
  research: 'Belegbare Angaben mit Quelle sammeln',
  qualify: 'Passung zu Angebot und Zielgruppe bewerten',
  policy: 'Kontaktberechtigung und Sperrliste prüfen',
  draft: 'Ansprache aus freigegebenem Wissen entwerfen',
  approval: 'Du prüfst und gibst frei – sonst passiert nichts',
  send: 'Genau einmal ausführen oder Aufgabe anlegen',
  followup: 'Wiedervorlage planen, Antworten stoppen sie',
};

type Live = { status: FlowEvent['status']; at: number; who?: string | null };

/**
 * Agentenablauf als leuchtende Kette. `counts` = Läufe, die gerade in diesem Schritt stehen.
 * Reagiert live auf Ereignisse aus dem Bus.
 */
export function PipelineGraph({ counts = {}, compact }: { counts?: Partial<Record<StepId, number>>; compact?: boolean }) {
  const [live, setLive] = useState<Partial<Record<StepId, Live>>>({});
  const [flow, setFlow] = useState<{ step: StepId; key: number } | null>(null);

  useEffect(
    () =>
      flowBus.on((e) => {
        setLive((prev) => ({ ...prev, [e.step]: { status: e.status, at: Date.now(), who: e.contact_name } }));
        if (e.status === 'started') setFlow({ step: e.step, key: e.id });
      }),
    [],
  );

  // Leuchten klingt nach einigen Sekunden ab (außer Freigabe wartet)
  useEffect(() => {
    const t = setInterval(() => {
      setLive((prev) => {
        const next = { ...prev };
        let changed = false;
        for (const [k, v] of Object.entries(prev)) {
          if (v && v.status !== 'waiting' && Date.now() - v.at > 6000) {
            delete next[k as StepId];
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className={cx('relative', compact ? 'py-2' : 'py-4')}>
      <div className="scrollbar-thin -mx-1 overflow-x-auto px-1 pb-2">
        <ol className={cx('relative flex min-w-[760px] items-start justify-between', compact ? 'gap-1' : 'gap-2')}>
          {/* Verbindungslinie */}
          <div className="absolute left-[7%] right-[7%] top-[26px] h-px bg-gradient-to-r from-[var(--accent)]/10 via-white/15 to-[var(--accent-2)]/10" />
          <svg className="pointer-events-none absolute left-[7%] right-[7%] top-[22px] h-2 w-[86%] overflow-visible" preserveAspectRatio="none" viewBox="0 0 100 2">
            <line x1="0" y1="1" x2="100" y2="1" stroke="var(--accent)" strokeWidth="0.4" strokeDasharray="0.6 3" className="opacity-70">
              <animate attributeName="stroke-dashoffset" from="0" to="-36" dur="6s" repeatCount="indefinite" />
            </line>
          </svg>
          {flow && <FlowComet key={flow.key} toIndex={PIPELINE.findIndex((p) => p.id === flow.step)} />}

          {PIPELINE.map((p, i) => {
            const Icon = ICONS[p.id];
            const l = live[p.id];
            const count = counts[p.id] ?? 0;
            const tone =
              l?.status === 'blocked' || l?.status === 'failed'
                ? 'bad'
                : l?.status === 'waiting' || (p.id === 'approval' && count > 0)
                  ? 'warn'
                  : l
                    ? 'hot'
                    : count > 0
                      ? 'busy'
                      : 'idle';
            return (
              <li key={p.id} className="relative z-10 flex w-[13%] flex-col items-center text-center">
                <motion.div
                  animate={tone === 'hot' ? { scale: [1, 1.12, 1] } : { scale: 1 }}
                  transition={{ duration: 0.8 }}
                  className={cx(
                    'relative grid h-[52px] w-[52px] place-items-center rounded-2xl border transition-colors duration-500',
                    tone === 'idle' && 'border-line bg-ink/80 text-muted',
                    tone === 'busy' && 'border-[color-mix(in_srgb,var(--accent)_40%,transparent)] bg-ink/80 text-accent',
                    tone === 'hot' && 'ring-accent border-transparent bg-[color-mix(in_srgb,var(--accent)_18%,#05070d)] text-white',
                    tone === 'warn' && 'border-warn/60 bg-warn/10 text-warn shadow-[0_0_30px_-6px_#fbbf24]',
                    tone === 'bad' && 'border-bad/60 bg-bad/10 text-bad shadow-[0_0_30px_-6px_#fb7185]',
                  )}
                >
                  {p.agent === 'human' ? <Icon size={22} /> : <Icon size={20} />}
                  {p.agent !== 'human' && <Bot size={11} className="absolute -right-1 -top-1 rounded-full bg-ink p-[1px] text-muted" />}
                  {(tone === 'hot' || tone === 'warn') && <span className="pulse-ring absolute inset-0 rounded-2xl text-current" />}
                  {count > 0 && (
                    <span className="absolute -bottom-2 -right-2 grid h-5 min-w-5 place-items-center rounded-full bg-accent-grad px-1 text-[10px] font-bold text-ink">{count}</span>
                  )}
                </motion.div>
                <span className={cx('mt-3 text-[12px] font-semibold', tone === 'idle' ? 'text-fg/80' : 'text-fg')}>{p.label}</span>
                {!compact && <span className="mt-1 text-[11px] leading-snug text-muted">{DESCRIPTIONS[p.id]}</span>}
                {l?.who && <span className="mt-1 max-w-full truncate text-[10px] text-accent">{l.who}</span>}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

function FlowComet({ toIndex }: { toIndex: number }) {
  const n = PIPELINE.length - 1;
  const pct = (i: number) => 7 + (86 * i) / n;
  const from = pct(Math.max(0, toIndex - 1));
  const to = pct(toIndex);
  return (
    <motion.span
      initial={{ left: `${from}%`, opacity: 0 }}
      animate={{ left: `${to}%`, opacity: [0, 1, 1, 0] }}
      transition={{ duration: 1.1, ease: 'easeInOut' }}
      className="pointer-events-none absolute top-[20px] z-20 h-3 w-3 -translate-x-1/2 rounded-full bg-white shadow-[0_0_12px_4px_var(--accent),0_0_40px_10px_var(--accent-2)]"
    />
  );
}
