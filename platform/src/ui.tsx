import { AnimatePresence, motion } from 'motion/react';
import { X } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

type Variant = 'primary' | 'ghost' | 'outline' | 'danger';

export function Button({ variant = 'outline', size = 'md', loading, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; loading?: boolean }) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      className={cx(
        'relative inline-flex items-center justify-center gap-2 rounded-xl font-medium transition-all duration-200 select-none',
        'disabled:cursor-not-allowed disabled:opacity-45 active:scale-[0.98]',
        size === 'sm' ? 'h-8 px-3 text-[13px]' : 'h-10 px-4 text-sm',
        variant === 'primary' && 'bg-accent-grad text-ink shadow-[0_8px_30px_-10px_var(--accent)] hover:brightness-110',
        variant === 'outline' && 'border border-line bg-white/[0.03] text-fg hover:bg-white/[0.07] hover:border-white/25',
        variant === 'ghost' && 'text-muted hover:bg-white/[0.06] hover:text-fg',
        variant === 'danger' && 'border border-bad/40 bg-bad/10 text-bad hover:bg-bad/20',
        className,
      )}
    >
      {loading && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />}
      {children}
    </button>
  );
}

export function Card({ className, children, interactive, onClick }: { className?: string; children: ReactNode; interactive?: boolean; onClick?: () => void }) {
  return (
    <div
      onClick={onClick}
      className={cx('glass rounded-2xl', interactive && 'cursor-pointer transition-all duration-200 hover:-translate-y-0.5 hover:border-white/25', className)}
    >
      {children}
    </div>
  );
}

export function SectionTitle({ title, subtitle, action }: { title: string; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="font-display text-lg font-semibold text-fg">{title}</h2>
        {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

const TONES = {
  neutral: 'bg-white/[0.06] text-muted border-line',
  accent: 'text-accent border-[color-mix(in_srgb,var(--accent)_40%,transparent)] bg-[color-mix(in_srgb,var(--accent)_10%,transparent)]',
  ok: 'text-ok border-ok/30 bg-ok/10',
  warn: 'text-warn border-warn/30 bg-warn/10',
  bad: 'text-bad border-bad/30 bg-bad/10',
} as const;

export function Badge({ tone = 'neutral', children, className }: { tone?: keyof typeof TONES; children: ReactNode; className?: string }) {
  return <span className={cx('inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium', TONES[tone], className)}>{children}</span>;
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

const inputCls =
  'w-full rounded-xl border border-line bg-black/30 px-3 text-sm text-fg placeholder:text-muted/60 outline-none transition focus:border-[color-mix(in_srgb,var(--accent)_60%,transparent)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--accent)_25%,transparent)]';

export const Input = (p: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={cx(inputCls, 'h-10', p.className)} />;
export const Textarea = (p: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...p} className={cx(inputCls, 'py-2.5 leading-relaxed', p.className)} />;
export const Select = (p: SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={cx(inputCls, 'h-10 appearance-none pr-8', p.className)} />;

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-6" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
          <motion.div
            role="dialog"
            aria-label={title}
            initial={{ y: 40, opacity: 0, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 30, opacity: 0, scale: 0.98 }}
            transition={{ type: 'spring', damping: 26, stiffness: 300 }}
            className={cx('glass-strong relative max-h-[92dvh] w-full overflow-y-auto rounded-t-3xl p-5 scrollbar-thin sm:rounded-3xl sm:p-7', wide ? 'sm:max-w-3xl' : 'sm:max-w-lg')}
          >
            <div className="mb-5 flex items-start justify-between gap-4">
              <h3 className="font-display text-xl font-semibold">{title}</h3>
              <button onClick={onClose} className="-m-1 rounded-lg p-1 text-muted hover:bg-white/10 hover:text-fg" aria-label="Schließen">
                <X size={18} />
              </button>
            </div>
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function Drawer({ open, onClose, children, title }: { open: boolean; onClose: () => void; children: ReactNode; title: string }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-40 flex justify-end" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" onClick={onClose} />
          <motion.aside
            aria-label={title}
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 280 }}
            className="glass-strong relative h-full w-full overflow-y-auto scrollbar-thin sm:max-w-xl sm:rounded-l-3xl"
          >
            <button onClick={onClose} className="absolute right-4 top-4 z-10 rounded-lg p-1.5 text-muted hover:bg-white/10 hover:text-fg" aria-label="Schließen">
              <X size={18} />
            </button>
            {children}
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function Empty({ icon, title, text, action }: { icon?: ReactNode; title: string; text?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      {icon && <div className="mb-3 grid h-12 w-12 place-items-center rounded-2xl border border-line bg-white/[0.04] text-accent">{icon}</div>}
      <p className="font-medium text-fg">{title}</p>
      {text && <p className="mt-1 max-w-sm text-sm text-muted">{text}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('shimmer rounded-xl bg-white/[0.04]', className)} />;
}

export const DOT_STYLE: Record<string, { color: string; label: string }> = {
  ready: { color: 'text-ok', label: 'Bereit' },
  running: { color: 'text-accent', label: 'Läuft' },
  approval: { color: 'text-warn', label: 'Freigabe nötig' },
  paused: { color: 'text-muted', label: 'Pausiert' },
  error: { color: 'text-bad', label: 'Fehler' },
};

export function StatusDot({ state, size = 8 }: { state: string; size?: number }) {
  const s = DOT_STYLE[state] ?? DOT_STYLE.ready;
  return (
    <span className={cx('relative inline-block rounded-full bg-current glow-dot', s.color, (state === 'running' || state === 'approval') && 'pulse-ring')} style={{ width: size, height: size }} />
  );
}

// ---------- Hinweise (Toasts) ----------

interface Toast {
  id: number;
  text: string;
  tone: 'ok' | 'bad' | 'neutral';
}
const ToastCtx = createContext<(text: string, tone?: Toast['tone']) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: Toast['tone'] = 'neutral') => {
    const t = { id: Date.now() + Math.random(), text, tone };
    setToasts((prev) => [...prev, t]);
    setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== t.id)), 4200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex flex-col items-center gap-2 px-4 sm:bottom-6 sm:items-end sm:pr-6">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              initial={{ opacity: 0, y: 16, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8 }}
              className={cx(
                'glass-strong pointer-events-auto max-w-sm rounded-2xl px-4 py-3 text-sm shadow-2xl',
                t.tone === 'ok' && 'border-ok/40',
                t.tone === 'bad' && 'border-bad/40 text-bad',
              )}
            >
              {t.text}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

/** Kleiner Helfer: async Aktion mit Ladezustand und Fehlerhinweis. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(
    async <T,>(key: string, fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
      setBusy(key);
      try {
        const r = await fn();
        if (success) toast(success, 'ok');
        return r;
      } catch (e) {
        toast(e instanceof Error ? e.message : 'Fehler', 'bad');
        return undefined;
      } finally {
        setBusy(null);
      }
    },
    [toast],
  );
  return { busy, run };
}
